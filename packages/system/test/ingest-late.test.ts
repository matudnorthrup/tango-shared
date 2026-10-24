import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { listEvents, listIncidents } from "../src/incidents.js";
import { ingestScheduleRuns, SCHEDULE_CURSOR } from "../src/ingest.js";
import { getJob, listRuns, upsertJob } from "../src/jobs.js";
import { getCursor } from "../src/ledger.js";
import { runTick } from "../src/tick.js";
import { annotations, fakeCtx, fakeExec, fakeFetch, minutesAgo, tempDir, tempLedger } from "./helpers.js";
import { recordEvent } from "../src/incidents.js";

function botDb(): { path: string; db: DatabaseSync; add: (r: Partial<Record<string, unknown>>) => number } {
  const path = join(tempDir("bot-"), "tango.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE schedule_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running', execution_mode TEXT NOT NULL DEFAULT 'agent', pre_check_result TEXT, duration_ms INTEGER,
    error TEXT, summary TEXT, model_used TEXT, worker_id TEXT, delivery_status TEXT, delivery_error TEXT, metadata TEXT)`);
  const add = (r: Partial<Record<string, unknown>>) =>
    Number(
      db
        .prepare("INSERT INTO schedule_runs(schedule_id, started_at, finished_at, status, error, summary, delivery_status, delivery_error) VALUES(?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          String(r.schedule_id ?? "brief"),
          String(r.started_at ?? minutesAgo(10)),
          (r.finished_at as string | null) ?? minutesAgo(9),
          String(r.status ?? "ok"),
          (r.error as string | null) ?? null,
          (r.summary as string | null) ?? null,
          (r.delivery_status as string | null) ?? null,
          (r.delivery_error as string | null) ?? null,
        ).lastInsertRowid,
    );
  return { path, db, add };
}

describe("schedule_runs ingestion", () => {
  it("maps statuses, uses a cursor and never duplicates", () => {
    const l = tempLedger();
    const bot = botDb();
    upsertJob(l, { id: "schedule:brief", runner: "schedule", name: "Brief", criticality: "critical" });
    bot.add({ status: "ok", started_at: minutesAgo(30) });
    bot.add({ status: "skipped", started_at: minutesAgo(20) });
    bot.add({ status: "error", error: "boom", started_at: minutesAgo(10) });
    const first = ingestScheduleRuns(l, bot.path);
    expect(first.ingested).toBe(3);
    expect(listRuns(l, "schedule:brief").map((r) => r.status)).toEqual(["failed", "quiet", "ok"]);
    expect(listEvents(l)[0]).toMatchObject({ kind: "run.failed", source: "scheduler", severity: "critical" });
    expect(Number(getCursor(l, SCHEDULE_CURSOR))).toBe(3);
    expect(ingestScheduleRuns(l, bot.path).ingested).toBe(0);
    bot.add({ status: "ok", started_at: minutesAgo(1) });
    expect(ingestScheduleRuns(l, bot.path).ingested).toBe(1);
    // The success resolved the failure.
    expect(listIncidents(l)).toHaveLength(0);
    expect(getJob(l, "schedule:brief")!.lastStatus).toBe("ok");
  });

  it("stops at a row still running and picks it up once it finishes", () => {
    const l = tempLedger();
    const bot = botDb();
    bot.add({ status: "ok" });
    const running = bot.add({ status: "running", finished_at: null, started_at: minutesAgo(1) });
    bot.add({ status: "ok", schedule_id: "other" });
    expect(ingestScheduleRuns(l, bot.path).ingested).toBe(1);
    expect(Number(getCursor(l, SCHEDULE_CURSOR))).toBe(1);
    bot.db.prepare("UPDATE schedule_runs SET status = 'ok', finished_at = ? WHERE id = ?").run(minutesAgo(0), running);
    expect(ingestScheduleRuns(l, bot.path).ingested).toBe(2);
  });

  it("turns a failed delivery into delivery.failed and a later delivery into its recovery", () => {
    const l = tempLedger();
    const bot = botDb();
    bot.add({ status: "ok", delivery_status: "failed", delivery_error: "403 Missing Access" });
    ingestScheduleRuns(l, bot.path);
    expect(listIncidents(l)[0]!.title).toBe("brief delivery failed");
    bot.add({ status: "ok", delivery_status: "delivered" });
    ingestScheduleRuns(l, bot.path);
    expect(listIncidents(l)).toHaveLength(0);
  });

  it("a first ingestion starts two days back, not at the beginning of history", () => {
    const l = tempLedger();
    const bot = botDb();
    bot.add({ status: "error", started_at: minutesAgo(5 * 1440) });
    bot.add({ status: "ok", started_at: minutesAgo(60) });
    expect(ingestScheduleRuns(l, bot.path).ingested).toBe(1);
  });
});

describe("late check", () => {
  const late = async (criticality: "critical" | "normal" | "quiet", minutes: number) => {
    const l = tempLedger();
    upsertJob(l, { id: "launchd:com.example.job", runner: "launchd", name: "Job", criticality, cadence: "Every 10 min", cadenceSeconds: 600, lastRunAt: minutesAgo(minutes) });
    await runTick(l, { ctx: fakeCtx({ annotations: annotations() }), runners: [], skipSteps: ["ingest", "probe", "unmanaged", "logs", "notify", "prune"] });
    return listEvents(l).filter((e) => e.kind === "job.late");
  };

  it("uses 1.5× / 2× / 3× the cadence by criticality", async () => {
    expect(await late("critical", 14)).toHaveLength(0);
    expect(await late("critical", 16)).toHaveLength(1);
    expect(await late("normal", 19)).toHaveLength(0);
    expect(await late("normal", 21)).toHaveLength(1);
    expect(await late("quiet", 29)).toHaveLength(0);
    expect(await late("quiet", 31)).toHaveLength(1);
  });

  it("does not repeat while the late incident is open, and a run resolves it", async () => {
    const l = tempLedger();
    upsertJob(l, { id: "launchd:com.example.job", runner: "launchd", name: "Job", cadenceSeconds: 600, lastRunAt: minutesAgo(60) });
    const opts = { ctx: fakeCtx(), runners: [] as never[], skipSteps: ["ingest", "probe", "unmanaged", "logs", "notify", "prune"] as never[] };
    await runTick(l, opts);
    await runTick(l, opts);
    expect(listEvents(l).filter((e) => e.kind === "job.late")).toHaveLength(1);
    const { startRun, finishRun } = await import("../src/runs.js");
    finishRun(l, startRun(l, "launchd:com.example.job"), { status: "ok", exitCode: 0 });
    expect(listIncidents(l)).toHaveLength(0);
  });

  it("resolves the late incident once the job's last run is on time again, with no run record", async () => {
    const l = tempLedger();
    const id = "launchd:com.example.job";
    upsertJob(l, { id, runner: "launchd", name: "Job", cadenceSeconds: 600, lastRunAt: minutesAgo(60) });
    const opts = { ctx: fakeCtx(), runners: [] as never[], skipSteps: ["ingest", "probe", "unmanaged", "logs", "notify", "prune"] as never[] };
    await runTick(l, opts);
    expect(listIncidents(l)).toHaveLength(1);
    upsertJob(l, { id, runner: "launchd", name: "Job", cadenceSeconds: 600, lastRunAt: minutesAgo(1), lastStatus: "running" });
    await runTick(l, opts);
    expect(listIncidents(l)).toHaveLength(0);
  });

  it("leaves the late incident open while the job's last run failed", async () => {
    const l = tempLedger();
    const id = "launchd:com.example.job";
    upsertJob(l, { id, runner: "launchd", name: "Job", cadenceSeconds: 600, lastRunAt: minutesAgo(60) });
    const opts = { ctx: fakeCtx(), runners: [] as never[], skipSteps: ["ingest", "probe", "unmanaged", "logs", "notify", "prune"] as never[] };
    await runTick(l, opts);
    upsertJob(l, { id, runner: "launchd", name: "Job", cadenceSeconds: 600, lastRunAt: minutesAgo(1), lastStatus: "failed" });
    await runTick(l, opts);
    expect(listIncidents(l)).toHaveLength(1);
  });

  it("gives no late verdict for a runner whose discovery came back incomplete", async () => {
    const l = tempLedger();
    upsertJob(l, { id: "launchd:com.example.job", runner: "launchd", name: "Job", cadenceSeconds: 600, lastRunAt: minutesAgo(60) });
    const ctx = fakeCtx();
    ctx.exec = fakeExec({ "launchctl list": () => ({ code: null, stdout: "", stderr: "", timedOut: true }) });
    await runTick(l, { ctx, runners: ["launchd"], skipSteps: ["ingest", "probe", "unmanaged", "logs", "notify", "prune"] });
    expect(listEvents(l).filter((e) => e.kind === "job.late")).toHaveLength(0);
  });

  it("skips paused jobs and jobs without a cadence", async () => {
    const l = tempLedger();
    upsertJob(l, { id: "launchd:com.example.a", runner: "launchd", name: "A", cadenceSeconds: 600, lastRunAt: minutesAgo(600), state: "paused" });
    upsertJob(l, { id: "launchd:com.example.b", runner: "launchd", name: "B", lastRunAt: minutesAgo(600) });
    await runTick(l, { ctx: fakeCtx(), runners: [], skipSteps: ["ingest", "probe", "unmanaged", "logs", "notify", "prune"] });
    expect(listEvents(l)).toHaveLength(0);
  });
});

describe("service probe", () => {
  it("resolves a service.down another source raised once its probe answers", async () => {
    const l = tempLedger();
    recordEvent(l, { source: "bot", kind: "service.down", severity: "critical", title: "MCP server was stopped by another process; restarting it", jobId: "service:mcp" });
    const ctx = fakeCtx({ annotations: annotations({ services: [{ id: "mcp", name: "MCP", url: "http://127.0.0.1:9100/health" }] }), fetch: fakeFetch(() => ({ status: 200, text: "ok" })) });
    await runTick(l, { ctx, runners: [], skipSteps: ["ingest", "late", "unmanaged", "disk", "logs", "notify", "prune"] });
    expect(listIncidents(l)).toHaveLength(0);
    expect(listEvents(l).map((e) => e.kind)).toContain("service.up");
  });
});
