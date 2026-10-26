import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listIncidents } from "../src/incidents.js";
import { TURNS_JOB } from "../src/owner-wait.js";
import { runTick } from "../src/tick.js";
import { fakeCtx, fakeFetch, tempDir, tempLedger } from "./helpers.js";

const START = Date.parse("2026-10-24T13:03:00Z");

function fixture() {
  const dir = tempDir("owner-wait-");
  const loomDbPath = join(dir, "loom.sqlite");
  const db = new DatabaseSync(loomDbPath);
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, kind TEXT NOT NULL, status TEXT NOT NULL, admission TEXT);
    CREATE TABLE runs (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, run_id TEXT, role TEXT NOT NULL, origin TEXT);
    CREATE TABLE coordinator_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO threads VALUES ('t-sierra', 'Sierra', 'tango-agent', 'idle', NULL), ('t-code', 'Fix memory', 'coding', 'running', NULL),
      ('t-job', 'Nightly', 'tango-job', 'idle', NULL);`);
  db.close();
  let now = START;
  const l = tempLedger();
  const fetch = fakeFetch(() => ({ status: 200, text: "{}" }));
  const ctx = fakeCtx({ now: () => new Date(now), loomDbPath, fetch });
  const write = (sql: string, ...args: (string | number | null)[]) => { const w = new DatabaseSync(loomDbPath); w.prepare(sql).run(...args); w.close(); };
  return {
    l,
    queue: (id: string, thread: string, source: string, origin: string | null, minutesAgo: number) => {
      write("INSERT INTO runs VALUES (?, ?, ?, 'queued', ?)", id, thread, source, now - minutesAgo * 60_000);
      write("INSERT INTO messages VALUES (?, ?, 'user', ?)", `m-${id}`, id, origin);
    },
    set: (sql: string, ...args: (string | number | null)[]) => write(sql, ...args),
    advance: (minutes: number) => { now += minutes * 60_000; },
    tick: () => runTick(l, { ctx, runners: [] as never[], skipSteps: ["ingest", "probe", "late", "unmanaged", "disk", "recovery", "logs", "prune"] as never[], noNotify: false }),
    posts: () => fetch.calls.map((c) => (JSON.parse(String(c.init?.body)) as { content: string }).content),
  };
}

describe("owner messages Loom isn't starting", () => {
  beforeEach(() => {
    vi.stubEnv("DISCORD_TOKEN", "test-token");
    vi.stubEnv("TANGO_SCHEDULER_ALERTS_CHANNEL_ID", "123");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("posts once naming maintenance, ignores mail, jobs and turns behind their own running turn, and resolves", async () => {
    const f = fixture();
    f.set("INSERT INTO coordinator_state VALUES ('maintenance', ?)", JSON.stringify({ on: true, reason: "reclaim drain", since: START - 600_000 }));
    f.queue("mail", "t-sierra", "user", '{"kind":"peer"}', 10);
    f.queue("job", "t-job", "user", null, 10);
    f.queue("fresh", "t-sierra", "user", null, 1);
    // t-code's owner message waits behind its own running turn: that is the queue working, not a hold.
    f.set("INSERT INTO runs VALUES ('busy', 't-code', 'user', 'running', ?)", START - 900_000);
    f.queue("behind", "t-code", "user", null, 9);
    expect((await f.tick()).ownerWaits).toBe(0);
    expect(listIncidents(f.l)).toHaveLength(0);

    f.advance(2);
    expect((await f.tick()).ownerWaits).toBe(1);
    f.advance(1);
    await f.tick();
    expect(listIncidents(f.l).map((i) => [i.title, i.severity, i.jobId])).toEqual([["Your messages aren't starting: Loom maintenance is on (reclaim drain)", "critical", TURNS_JOB]]);
    expect(f.posts()).toHaveLength(1);
    expect(f.posts()[0]).toContain("Sierra (3 min)");
    expect(f.posts()[0]).toContain('POST /maintenance {"on": false}');

    f.set("UPDATE runs SET status = 'running' WHERE id = 'fresh'");
    f.advance(1);
    await f.tick();
    expect(listIncidents(f.l)).toHaveLength(0);
    expect(f.posts()[1]).toMatch(/Resolved\*\*: Your messages aren't starting/);
  });

  it("says when nothing Loom reports holds them", async () => {
    const f = fixture();
    f.queue("stuck", "t-sierra", "user", null, 5);
    await f.tick();
    expect(listIncidents(f.l).map((i) => i.title)).toEqual(["Your messages aren't starting: nothing Loom reports is holding them"]);
  });

  it("leaves things as they are when Loom's database can't be read", async () => {
    const f = fixture();
    f.queue("stuck", "t-sierra", "user", null, 5);
    await f.tick();
    f.set("DROP TABLE messages");
    f.advance(1);
    expect((await f.tick()).ownerWaits).toBeNull();
    expect(listIncidents(f.l)).toHaveLength(1);
  });
});
