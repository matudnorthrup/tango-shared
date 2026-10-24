import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TangoStorage } from "../src/storage.js";
import { SchedulerStore } from "../src/scheduler/store.js";

const cleanups: Array<{ dir: string; storage: TangoStorage }> = [];

function createStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-scheduler-store-"));
  const storage = new TangoStorage(path.join(dir, "tango.sqlite"), { seedExampleRoster: true });
  const store = new SchedulerStore(storage.getDatabase());
  cleanups.push({ dir, storage });
  return { dir, storage, store };
}

afterEach(() => {
  vi.useRealTimers();
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    cleanup?.storage.close();
    if (cleanup?.dir) {
      fs.rmSync(cleanup.dir, { recursive: true, force: true });
    }
  }
});

describe("SchedulerStore timestamp persistence", () => {
  it("stores schedule run timestamps as explicit UTC ISO-8601 values", () => {
    const { store, storage } = createStore();

    const runId = store.insertRun({
      scheduleId: "weekly-finance-review",
      executionMode: "agent",
      workerId: "personal-assistant",
    });
    store.updateRunFinished(runId, {
      status: "ok",
      durationMs: 1234,
      summary: "done",
    });

    const row = storage
      .getDatabase()
      .prepare("SELECT started_at, finished_at FROM schedule_runs WHERE id = ?")
      .get(runId) as { started_at: string; finished_at: string };

    expect(row.started_at).toMatch(/T/);
    expect(row.started_at).toMatch(/Z$/);
    expect(row.finished_at).toMatch(/T/);
    expect(row.finished_at).toMatch(/Z$/);
    expect(store.getRun(runId)).toMatchObject({
      id: runId,
      scheduleId: "weekly-finance-review",
      status: "ok",
      summary: "done",
    });
  });

  it("stores schedule completion timestamps as explicit UTC ISO-8601 values", () => {
    const { store, storage } = createStore();

    store.markCompletion({
      workflowId: "weekly-finance-review",
      scope: "daily",
      completedBy: "schedule:weekly-finance-review",
    });

    const row = storage
      .getDatabase()
      .prepare("SELECT completed_at FROM schedule_completions WHERE workflow_id = ?")
      .get("weekly-finance-review") as { completed_at: string };

    expect(row.completed_at).toMatch(/T/);
    expect(row.completed_at).toMatch(/Z$/);
  });

  it("uses the correct ISO week key at a Sunday boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T12:00:00.000Z"));
    const { store } = createStore();

    store.markCompletion({
      workflowId: "weekly-finance-review",
      scope: "weekly",
      completedBy: "schedule:weekly-finance-review",
    });

    expect(store.checkCompletion("weekly-finance-review", "weekly")?.completedDate).toBe("2026-W27");
  });
});

describe("SchedulerStore pauses", () => {
  it("pauses and resumes a schedule, kept across a new store on the same database", () => {
    const { store, storage } = createStore();
    expect(store.isPaused("brief")).toBe(false);
    store.setPaused("brief", true);
    store.setPaused("brief", true);
    expect(new SchedulerStore(storage.getDatabase()).isPaused("brief")).toBe(true);
    store.setPaused("brief", false);
    expect(store.isPaused("brief")).toBe(false);
  });
});

describe("SchedulerEngine pause and run now", () => {
  it("skips a paused schedule's timed runs, reports it paused, and knows only its own schedules", async () => {
    const { SchedulerEngine } = await import("../src/scheduler/engine.js");
    const { store, storage } = createStore();
    const config = {
      id: "scan",
      description: "scan",
      enabled: true,
      schedule: { everySeconds: 60 },
      execution: { mode: "agent", workerId: "research", task: "Scan.", timeoutSeconds: 30 },
    } as never;
    const engine = new SchedulerEngine([config], { store, db: storage.getDatabase() });
    expect(engine.setPaused("scan", true)).toBe(true);
    expect(engine.setPaused("missing", true)).toBe(false);
    expect(engine.getSchedules()[0]?.paused).toBe(true);
    engine.start();
    engine.stop();
    expect(store.getRecentRuns("scan")).toEqual([]);
    expect(engine.runNow("missing")).toBe("missing");
  });
});
