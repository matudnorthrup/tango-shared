import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverLaunchd } from "../src/discovery/launchd.js";
import { loomWaitDueAt } from "../src/discovery/others.js";
import { getJob, upsertJob } from "../src/jobs.js";
import { fail, fakeCtx, fakeExec, ok, tempDir, tempLedger } from "./helpers.js";

function agent(label: string, plist: Record<string, unknown>, print: { runs: number; lastExit: number; pid?: number | null; loaded?: boolean; printFails?: boolean }) {
  // Mutable: a test can change what launchd reports between ticks.
  const l = tempLedger();
  const ctx = fakeCtx();
  const agents = join(ctx.homeDir, "Library", "LaunchAgents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, `${label}.plist`), "<plist/>");
  ctx.exec = fakeExec({
    "launchctl list": () => ok(`PID\tStatus\tLabel\n${print.loaded === false ? "" : `${print.pid ?? "-"}\t${print.lastExit}\t${label}\n`}`),
    [`launchctl print gui/501/${label}`]: () => print.printFails ? fail(124, "timed out") : ok(`gui/501/${label} = {\n\tpath = ${join(agents, `${label}.plist`)}\n\tstate = ${print.pid ? "running" : "not running"}\n${print.pid ? `\tpid = ${print.pid}\n` : ""}\truns = ${print.runs}\n\tlast exit code = ${print.lastExit}\n}`),
    plutil: () => ok(JSON.stringify({ Label: label, ...plist })),
  });
  const run = async () => {
    const r = await discoverLaunchd({ ctx, prev: (id: string) => getJob(l, id) });
    for (const j of r.jobs) upsertJob(l, j);
    return r;
  };
  return { l, run, id: `launchd:${label}` };
}

describe("ledger gaps (stale-waits audit)", () => {
  it("a one-shot that failed before the tick watched it is recorded as a failed run, once", async () => {
    const a = agent("com.example.startup", { RunAtLoad: true }, { runs: 1, lastExit: 1 });
    const first = await a.run();
    expect(first.effects).toMatchObject([{ type: "run", run: { jobId: a.id, status: "failed", exitCode: 1, sourceRef: expect.stringMatching(/^launchd-exit:com\.example\.startup:1:1:/) } }]);
    expect(getJob(a.l, a.id)!.lastStatus).toBe("failed");
    const second = await a.run();
    expect(second.effects).toEqual([]);
  });

  it("a repeat failure after launchd reloads the job is recorded again", async () => {
    const print = { runs: 1, lastExit: 1 };
    const a = agent("com.example.again", { RunAtLoad: true }, print);
    expect((await a.run()).effects).toHaveLength(1);
    print.runs = 2;
    expect((await a.run()).effects).toMatchObject([{ run: { status: "failed", exitCode: 1 } }]);
    expect((await a.run()).effects).toEqual([]);
  });

  it("a clean run its log reveals is recorded as ok, which resolves an earlier failure", async () => {
    const log = join(tempDir("logs-"), "job.log");
    const print = { runs: 1, lastExit: 1 };
    const a = agent("com.example.heal", { StartCalendarInterval: { Hour: 6 }, StandardOutPath: log }, print);
    writeFileSync(log, "failed\n");
    utimesSync(log, new Date("2026-10-17T13:00:00Z"), new Date("2026-10-17T13:00:00Z"));
    expect((await a.run()).effects).toMatchObject([{ run: { status: "failed" } }]);
    // launchd reloaded it (counter back to 0), then it ran clean: only the log shows it.
    print.runs = 0;
    print.lastExit = 0;
    writeFileSync(log, "ok\n");
    utimesSync(log, new Date("2026-10-18T13:15:00Z"), new Date("2026-10-18T13:15:00Z"));
    expect((await a.run()).effects).toMatchObject([{ run: { status: "ok", startedAt: "2026-10-18T13:15:00.000Z" } }]);
    expect(getJob(a.l, a.id)!.lastStatus).toBe("ok");
  });

  it("a stale exit code with an old log raises nothing, even across a tick that couldn't read the job (#178)", async () => {
    const log = join(tempDir("logs-"), "startup.log");
    writeFileSync(log, "Service 'discord' failed to start\n");
    utimesSync(log, new Date("2026-10-17T12:17:19Z"), new Date("2026-10-17T12:17:19Z"));
    const print: { runs: number; lastExit: number; printFails?: boolean } = { runs: 1, lastExit: 1 };
    const a = agent("com.example.startup-live", { RunAtLoad: true, StandardOutPath: log }, print);
    // First sight: the boot failure is recorded once.
    expect((await a.run()).effects).toMatchObject([{ run: { status: "failed", exitCode: 1 } }]);
    // Then nothing new: a tick whose launchctl print timed out, and good ticks after it, raise nothing.
    print.printFails = true;
    expect((await a.run()).effects).toEqual([]);
    print.printFails = false;
    for (let i = 0; i < 3; i += 1) expect((await a.run()).effects).toEqual([]);
    expect(getJob(a.l, a.id)!.facts.runs).toBe(1);
  });

  it("a ledger that lost its exit observation doesn't take an old exit for a new run", async () => {
    const log = join(tempDir("logs-"), "startup.log");
    writeFileSync(log, "failed\n");
    utimesSync(log, new Date("2026-10-17T12:17:19Z"), new Date("2026-10-17T12:17:19Z"));
    const a = agent("com.example.lost", { RunAtLoad: true, StandardOutPath: log }, { runs: 1, lastExit: 1 });
    await a.run();
    upsertJob(a.l, { id: a.id, runner: "launchd", name: "com.example.lost", facts: { exitSeen: null } });
    expect((await a.run()).effects).toEqual([]);
  });

  it("a run its log gave on an unread tick isn't counted again when the counter shows it", async () => {
    const log = join(tempDir("logs-"), "job.log");
    writeFileSync(log, "ok\n");
    utimesSync(log, new Date("2026-10-17T12:00:00Z"), new Date("2026-10-17T12:00:00Z"));
    const print: { runs: number; lastExit: number; printFails?: boolean } = { runs: 1, lastExit: 0 };
    const a = agent("com.example.daily", { StartCalendarInterval: { Hour: 6 }, StandardOutPath: log }, print);
    await a.run();
    // It runs again and writes its log during a tick whose print times out: the log gives the run.
    print.runs = 2;
    print.printFails = true;
    writeFileSync(log, "ok again\n");
    expect((await a.run()).effects).toMatchObject([{ run: { status: "ok" } }]);
    // The next good reading shows runs = 2: the same run, not a second one.
    print.printFails = false;
    expect((await a.run()).effects).toEqual([]);
  });

  it("a new failed run after that raises once", async () => {
    const log = join(tempDir("logs-"), "startup.log");
    writeFileSync(log, "failed\n");
    utimesSync(log, new Date("2026-10-17T12:17:19Z"), new Date("2026-10-17T12:17:19Z"));
    const print = { runs: 1, lastExit: 1 };
    const a = agent("com.example.boot", { RunAtLoad: true, StandardOutPath: log }, print);
    await a.run();
    print.runs = 2;
    expect((await a.run()).effects).toMatchObject([{ run: { status: "failed", exitCode: 1 } }]);
    expect((await a.run()).effects).toEqual([]);
  });

  it("a clean exit, a running service or a KeepAlive one is not a failure", async () => {
    expect((await agent("com.example.ok", { RunAtLoad: true }, { runs: 1, lastExit: 0 }).run()).effects).toEqual([]);
    expect((await agent("com.example.svc", { KeepAlive: true }, { runs: 3, lastExit: 143 }).run()).effects).toEqual([]);
  });

  it("a calendar job the tick never saw run takes its last run from its log's last write", async () => {
    const dir = tempDir("logs-");
    const log = join(dir, "sync.log");
    writeFileSync(log, "synced\n");
    const at = new Date("2026-10-18T15:40:00Z");
    utimesSync(log, at, at);
    const empty = join(dir, "sync.err");
    writeFileSync(empty, "");
    const a = agent("com.example.sync", { StartCalendarInterval: { Hour: 8, Minute: 40 }, StandardOutPath: log, StandardErrorPath: empty }, { runs: 0, lastExit: 0 });
    await a.run();
    const job = getJob(a.l, a.id)!;
    expect(job.lastRunAt).toBe(at.toISOString());
    expect(job.facts.lastRunFrom).toBe("log");
  });

  it("a log written by a run the counter already recorded is not a second run", async () => {
    const log = join(tempDir("logs-"), "job.log");
    writeFileSync(log, "start\n");
    const print = { runs: 1, lastExit: 0 };
    const a = agent("com.example.once", { StartCalendarInterval: { Hour: 6 }, StandardOutPath: log }, print);
    await a.run();
    // It runs (the counter moves) and finishes writing its log a moment after the tick's clock.
    print.runs = 2;
    print.lastExit = 1;
    writeFileSync(log, "failed\n");
    const later = new Date(Date.now() + 60_000);
    utimesSync(log, later, later);
    expect((await a.run()).effects).toMatchObject([{ run: { status: "failed" } }]);
    expect((await a.run()).effects).toEqual([]);
  });

  it("a running job's log write is left for the tick that sees it finish", async () => {
    const log = join(tempDir("logs-"), "job.log");
    const print: { runs: number; lastExit: number; pid: number | null } = { runs: 1, lastExit: 0, pid: null };
    const a = agent("com.example.slow", { StartCalendarInterval: { Hour: 6 }, StandardOutPath: log }, print);
    writeFileSync(log, "old\n");
    utimesSync(log, new Date("2026-10-17T13:00:00Z"), new Date("2026-10-17T13:00:00Z"));
    await a.run();
    // It starts (counter up, still running) and writes its only output now...
    print.runs = 2;
    print.pid = 4242;
    writeFileSync(log, "working\n");
    expect((await a.run()).effects).toEqual([]);
    // ...then exits 1 without writing again: still recorded as a failure.
    print.pid = null;
    print.lastExit = 1;
    expect((await a.run()).effects).toMatchObject([{ run: { status: "failed", exitCode: 1 } }]);
  });

  it("an exit seen before launchd unloaded the job doesn't hide the same exit after it reloads", async () => {
    const print: { runs: number; lastExit: number; loaded?: boolean } = { runs: 1, lastExit: 1 };
    const a = agent("com.example.reload", { RunAtLoad: true }, print);
    expect((await a.run()).effects).toHaveLength(1);
    print.loaded = false;
    await a.run();
    await a.run();
    expect(getJob(a.l, a.id)!.state).toBe("paused");
    print.loaded = true;
    expect((await a.run()).effects).toMatchObject([{ run: { status: "failed", exitCode: 1 } }]);
  });

  it("a job one launchctl list left out wasn't unloaded: its old exit raises nothing", async () => {
    const log = join(tempDir("logs-"), "startup.log");
    writeFileSync(log, "failed\n");
    utimesSync(log, new Date("2026-10-17T12:17:19Z"), new Date("2026-10-17T12:17:19Z"));
    const print: { runs: number; lastExit: number; loaded?: boolean } = { runs: 1, lastExit: 1 };
    const a = agent("com.example.startup-live", { RunAtLoad: true, StandardOutPath: log }, print);
    expect((await a.run()).effects).toHaveLength(1);
    for (let i = 0; i < 2; i += 1) {
      print.loaded = false;
      expect((await a.run()).effects).toEqual([]);
      expect(getJob(a.l, a.id)!.state).toBe("active");
      print.loaded = true;
      expect((await a.run()).effects).toEqual([]);
    }
    expect(getJob(a.l, a.id)!.facts.runs).toBe(1);
    // A real run after that still raises once.
    print.runs = 2;
    expect((await a.run()).effects).toMatchObject([{ run: { status: "failed", exitCode: 1 } }]);
  });

  it("a job paused on purpose stays paused when its bootout takes it out of the listing", async () => {
    const print: { runs: number; lastExit: number; loaded?: boolean } = { runs: 1, lastExit: 0 };
    const a = agent("com.example.paused", { StartInterval: 3600 }, print);
    await a.run();
    upsertJob(a.l, { id: a.id, runner: "launchd", name: "com.example.paused", state: "paused" });
    print.loaded = false;
    await a.run();
    expect(getJob(a.l, a.id)!.state).toBe("paused");
  });

  it("a service's log is not a run", async () => {
    const log = join(tempDir("logs-"), "server.log");
    writeFileSync(log, "serving\n");
    const a = agent("com.example.server", { KeepAlive: true, StandardOutPath: log }, { runs: 1, lastExit: 0 });
    await a.run();
    expect(getJob(a.l, a.id)!.lastRunAt).toBeNull();
  });

  it("a Loom time wait is due at its moment, any other at its expiry", () => {
    const at = Date.parse("2026-10-19T17:45:00Z");
    const expires = Date.parse("2026-10-20T02:36:31Z");
    expect(loomWaitDueAt({ kind: "time", spec: JSON.stringify({ at: new Date(at).toISOString() }), expires_at: expires })).toBe(at);
    expect(loomWaitDueAt({ kind: "pr", spec: "{}", expires_at: expires })).toBe(expires);
    expect(loomWaitDueAt({ kind: "time", spec: "not json", expires_at: expires })).toBe(expires);
  });
});
