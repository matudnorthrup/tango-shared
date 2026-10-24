import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listEvents, listIncidents } from "../src/incidents.js";
import { getJsonCursor } from "../src/ledger.js";
import { notifyCritical } from "../src/notify.js";
import { RECOVERY_JOB } from "../src/recovery.js";
import { HEALTH_CURSOR } from "../src/summary.js";
import { runTick } from "../src/tick.js";
import type { HealthSnapshot } from "../src/types.js";
import { fakeCtx, fakeFetch, tempDir, tempLedger } from "./helpers.js";

const GIB = 1024 ** 3;
const START = Date.parse("2026-10-23T21:30:00Z");

function fixture() {
  const dir = tempDir("recovery-");
  const loomDbPath = join(dir, "loom.sqlite");
  const db = new DatabaseSync(loomDbPath);
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, admission TEXT, updated_at INTEGER NOT NULL)");
  db.exec("INSERT INTO threads VALUES ('t-sierra', 'Sierra', NULL, 1), ('t-charlie', 'Charlie', NULL, 2), ('t-desk', NULL, NULL, 3)");
  db.close();
  const healthFile = join(dir, "health.json");
  let now = START;
  const l = tempLedger();
  const fetch = fakeFetch(() => ({ status: 200, text: "{}" }));
  const ctx = fakeCtx({ now: () => new Date(now), loomDbPath, recoveryHealthFile: healthFile, fetch });
  return {
    l,
    fetch,
    healthFile,
    hold: (...ids: string[]) => {
      const w = new DatabaseSync(loomDbPath);
      w.exec("UPDATE threads SET admission = NULL");
      for (const id of ids) w.prepare("UPDATE threads SET admission = 'recovery_unhealthy' WHERE id = ?").run(id);
      w.close();
    },
    health: (freeGib: number, alerts: string[]) =>
      writeFileSync(healthFile, JSON.stringify({ at: now / 1000, ok: !alerts.length, alerts, free_bytes: freeGib * GIB, destination_host: "100.0.0.9", destination: "/m/loom-recovery/destinations/20261023T213000Z", warn_free_bytes: 20 * GIB, pause_free_bytes: 5 * GIB })),
    advance: (minutes: number) => { now += minutes * 60_000; },
    tick: () => runTick(l, { ctx, runners: [] as never[], skipSteps: ["ingest", "probe", "late", "unmanaged", "disk", "logs", "prune"] as never[], noNotify: false }),
    posts: () => fetch.calls.map((c) => (JSON.parse(String(c.init?.body)) as { content: string }).content),
  };
}

describe("recovery hold and mini space", () => {
  beforeEach(() => {
    vi.stubEnv("DISCORD_TOKEN", "test-token");
    vi.stubEnv("TANGO_SCHEDULER_ALERTS_CHANNEL_ID", "123");
  });
  afterEach(() => vi.unstubAllEnvs());
  it("warns once below the warning floor without a hold, then clears with room", async () => {
    const f = fixture();
    f.health(30, []);
    await f.tick();
    expect(listIncidents(f.l)).toHaveLength(0);
    f.advance(1); f.health(14, ["destination_space_warn"]);
    await f.tick();
    f.advance(1); f.health(13.9, ["destination_space_warn"]);
    await f.tick();
    expect(listIncidents(f.l).map((i) => [i.title, i.severity, i.jobId])).toEqual([["Recovery mini is low on space", "critical", RECOVERY_JOB]]);
    expect(f.posts()).toHaveLength(1);
    expect(f.posts()[0]).toContain("Mini 100.0.0.9: 14 GB free (pause under 5 GB, warning under 20 GB)");
    expect(f.posts()[0]).toContain("Nothing is held yet");
    // Back over the floor but within the margin: still open, no flapping.
    f.advance(1); f.health(20.5, []);
    await f.tick();
    expect(listIncidents(f.l)).toHaveLength(1);
    f.advance(1); f.health(42, []);
    await f.tick();
    expect(listIncidents(f.l)).toHaveLength(0);
    expect(f.posts()).toHaveLength(2);
    expect(f.posts()[1]).toMatch(/Resolved\*\*: Recovery mini is low on space[\s\S]*42 GB free/);
  });

  it("posts one hold notice with free space, host and the override command, and one clear notice when it lifts", async () => {
    const f = fixture();
    f.health(4.2, ["destination_low_space"]);
    f.hold("t-sierra", "t-desk");
    await f.tick();
    f.advance(1); f.hold("t-sierra", "t-charlie", "t-desk");
    await f.tick();
    const incidents = listIncidents(f.l).map((i) => i.title).sort();
    expect(incidents).toEqual(["Loom paused new turns: the recovery mini is out of space", "Recovery mini is below its pause floor"]);
    const hold = f.posts().find((p) => p.includes("Loom paused new turns"))!;
    expect(hold).toContain("2 conversations are waiting: t-desk, Sierra");
    expect(hold).toContain("Mini 100.0.0.9: 4.2 GB free");
    expect(hold).toContain(`echo allow > ${f.healthFile}.override`);
    expect(hold).toContain(`rm ${f.healthFile}.override`);
    expect(f.posts()).toHaveLength(2);
    // A stale health file is no verdict: the hold still clears from Loom's own state.
    f.advance(30); f.hold();
    await f.tick();
    expect(listIncidents(f.l).map((i) => i.title)).toEqual(["Recovery mini is below its pause floor"]);
    expect(f.posts()[2]).toContain("Resolved**: Loom paused new turns");
    expect(listEvents(f.l).filter((e) => e.kind === "recovery.hold")).toHaveLength(1);
  });

  it("keeps a disk trend for the mini on the health snapshot and the tick report", async () => {
    const f = fixture();
    const report0 = await f.tick();
    expect(report0.recovery).toBe("mini ?: ? GB free; 0 held");
    for (let h = 0; h <= 24; h++) {
      f.health(40 - h * 0.5, []);
      const report = await f.tick();
      if (h === 24) expect(report.recovery).toBe("mini 100.0.0.9: 28 GB free, -12 GB/day, about 1.9 days to the pause floor; 0 held");
      f.advance(60);
    }
  });

  it("stays quiet without a Loom database or health file", async () => {
    const l = tempLedger();
    const report = await runTick(l, { ctx: fakeCtx(), runners: [] as never[], noNotify: true, skipSteps: ["ingest", "probe", "late", "unmanaged", "disk", "logs", "prune"] as never[] });
    expect(report.recovery).toBeUndefined();
    expect(listIncidents(l)).toHaveLength(0);
    expect(getJsonCursor<HealthSnapshot>(l, HEALTH_CURSOR)).toBeNull();
    expect((await notifyCritical(l, fakeCtx(), { dryRun: true })).pending).toBe(0);
  });
});
