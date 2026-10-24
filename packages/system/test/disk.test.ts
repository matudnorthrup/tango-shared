import { describe, expect, it } from "vitest";
import { listEvents, listIncidents } from "../src/incidents.js";
import { setJsonCursor } from "../src/ledger.js";
import { runTick } from "../src/tick.js";
import { HEALTH_CURSOR } from "../src/summary.js";
import { fakeCtx, tempLedger } from "./helpers.js";

const tick = (l: ReturnType<typeof tempLedger>, usedPct: number, freeGb: number) => {
  setJsonCursor(l, HEALTH_CURSOR, { checkedAt: new Date().toISOString(), services: [], machine: { load1: 1, load5: 1, cores: 8, memUsedGb: 1, memTotalGb: 8, diskUsedPct: usedPct, diskFreeGb: freeGb } });
  return runTick(l, { ctx: fakeCtx(), runners: [] as never[], noNotify: true, skipSteps: ["ingest", "probe", "late", "unmanaged", "logs", "prune"] as never[] });
};

describe("disk space", () => {
  it("opens a warning at 90%, escalates once at 95%, stays quiet in between, and clears with room again", async () => {
    const l = tempLedger();
    await tick(l, 85, 140);
    expect(listIncidents(l)).toHaveLength(0);
    await tick(l, 91, 80);
    await tick(l, 92, 75);
    expect(listIncidents(l).map((i) => i.severity)).toEqual(["warning"]);
    await tick(l, 96, 35);
    await tick(l, 96, 34);
    expect(listIncidents(l).map((i) => i.severity)).toEqual(["critical"]);
    expect(listEvents(l).filter((e) => e.kind === "disk.low")).toHaveLength(2);
    await tick(l, 89, 90);
    expect(listIncidents(l).map((i) => i.severity)).toEqual(["warning"]);
    await tick(l, 80, 180);
    expect(listIncidents(l)).toHaveLength(0);
  });

  it("goes critical under 30 GB on a large disk, ahead of Loom's 20 GB floor, and steps back once there's room (10/19)", async () => {
    const l = tempLedger();
    await tick(l, 94, 55);
    expect(listIncidents(l).map((i) => i.severity)).toEqual(["warning"]);
    await tick(l, 94.5, 28);
    expect(listIncidents(l).map((i) => i.severity)).toEqual(["critical"]);
    await tick(l, 94.5, 45);
    expect(listIncidents(l).map((i) => i.severity)).toEqual(["critical"]);
    await tick(l, 93.3, 62);
    expect(listIncidents(l).map((i) => i.severity)).toEqual(["warning"]);
  });

  it("resolves a critical incident at once when the disk jumps straight back to healthy (Codex review on #807)", async () => {
    const l = tempLedger();
    await tick(l, 96, 35);
    expect(listIncidents(l).map((i) => i.severity)).toEqual(["critical"]);
    await tick(l, 80, 180);
    expect(listIncidents(l)).toHaveLength(0);
  });
});
