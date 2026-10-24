import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TangoStorage } from "../src/storage.js";
import { SchedulerStore } from "../src/scheduler/store.js";
import { SchedulerEngine } from "../src/scheduler/engine.js";
import type { ScheduleConfig } from "../src/scheduler/types.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).reverse().forEach((cleanup) => cleanup());
  vi.useRealTimers();
});

function harness(catchUp?: string, everySeconds?: number) {
  vi.useFakeTimers();
  const now = Date.parse("2026-04-09T09:00:00Z");
  vi.setSystemTime(now);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catch-up-"));
  const storage = new TangoStorage(path.join(dir, "test.sqlite"), { seedExampleRoster: true });
  cleanups.push(() => { storage.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const store = new SchedulerStore(storage.getDatabase());
  const execute = vi.fn(async () => ({ text: "done", durationMs: 1, metadata: { fixture: true } }));
  const config: ScheduleConfig = {
    id: "catch-up-fixture", description: "Catch-up test", enabled: true, runtime: "v2", catchUp,
    schedule: everySeconds ? { everySeconds } : { cron: "0 7 * * *", timezone: "UTC" },
    execution: { mode: "agent", workerId: "fixture", deterministicAgentId: "fixture", task: "Test" },
  };
  const onRunStarted = vi.fn();
  const onRunFinished = vi.fn();
  function engine() {
    const engine = new SchedulerEngine([config], {
      store, onRunStarted, onRunFinished, db: storage.getDatabase(), now: () => now, executeV2Turn: execute,
    });
    cleanups.push(() => engine.stop());
    return engine;
  }
  function previous(startedAt: string) {
    const id = store.insertRun({ scheduleId: config.id, executionMode: "agent", startedAt });
    store.updateRunFinished(id, { status: "ok", durationMs: 1 });
  }
  return { store, execute, engine, previous, config, now, onRunStarted, onRunFinished };
}

async function settle() { await vi.advanceTimersByTimeAsync(0); }

describe("startup catch-up", () => {
  it("runs the missed daily slot once, persists its trigger, and schedules tomorrow", async () => {
    const h = harness();
    h.previous("2026-04-08T07:00:00Z");
    const engine = h.engine();
    engine.start();
    await settle();
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.store.getRecentRuns(h.config.id)[0]!.metadata!)).toEqual({
      trigger: "catch-up", scheduledAt: "2026-04-09T07:00:00.000Z", fixture: true,
    });
    expect(engine.getSchedules()[0]!.nextRunAt).toBe(Date.parse("2026-04-10T07:00:00Z"));
    engine.stop();
    h.engine().start();
    await settle();
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it.each(["1h", "none"])("does not catch up with window %s", async (window) => {
    const h = harness(window);
    h.engine().start();
    await settle();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("caps the default window at twelve hours", async () => {
    const h = harness();
    h.config.schedule.cron = "0 20 * * *";
    h.engine().start();
    await settle();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("runs only the latest of three missed daily slots", async () => {
    const h = harness("4d");
    h.previous("2026-04-06T07:00:00Z");
    h.engine().start();
    await settle();
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.store.getRecentRuns(h.config.id)).toHaveLength(2);
  });

  it.each(["2026-04-09T07:00:00Z", "2026-04-09T08:00:00Z"])("does not repeat a slot with a run at %s", async (startedAt) => {
    const h = harness();
    h.previous(startedAt);
    h.engine().start();
    await settle();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("catches up an interval once and resumes its normal interval", async () => {
    const h = harness(undefined, 3600);
    h.previous("2026-04-09T05:30:00Z");
    const engine = h.engine();
    engine.start();
    await settle();
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.store.getRecentRuns(h.config.id)[0]!.metadata!).scheduledAt).toBe("2026-04-09T08:30:00.000Z");
    expect(engine.getSchedules()[0]!.nextRunAt).toBe(h.now + 3600_000);
  });

  it("marks completion for the missed slot's period, not today's", async () => {
    const h = harness("12h");
    h.config.schedule.cron = "0 23 * * *";
    h.config.completion = { workflowId: "fixture", scope: "daily" };
    h.previous("2026-04-07T23:00:00Z");
    h.engine().start();
    await settle();
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.store.checkCompletion("fixture", "daily", new Date("2026-04-08T23:00:00Z"))).not.toBeNull();
    expect(h.store.checkCompletion("fixture", "daily")).toBeNull();
  });

  it("persists a completion skip so it cannot replay on restart", async () => {
    const h = harness();
    h.config.completion = { workflowId: "fixture", scope: "daily" };
    h.store.markCompletion({ workflowId: "fixture", scope: "daily", completedBy: "fixture" });
    h.previous("2026-04-08T07:00:00Z");
    const engine = h.engine();
    engine.start();
    await settle();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.store.getRecentRuns(h.config.id)[0]?.status).toBe("skipped");
    // A completion skip must not start (and then block) a state-tracked review: no lifecycle hooks.
    expect(h.onRunStarted).not.toHaveBeenCalled();
    expect(h.onRunFinished).not.toHaveBeenCalled();
    engine.stop();
    h.engine().start();
    await settle();
    expect(h.store.getRecentRuns(h.config.id)).toHaveLength(2);
  });

  it("does not retry a failed catch-up on restart", async () => {
    const h = harness();
    h.previous("2026-04-08T07:00:00Z");
    h.execute.mockRejectedValue(new Error("fixture failure"));
    const engine = h.engine();
    engine.start();
    await settle();
    expect(h.store.getRecentRuns(h.config.id)[0]?.status).toBe("error");
    engine.stop();
    h.engine().start();
    await settle();
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it.each([[undefined], [3600]])("does not catch up a schedule with no run history (every %s)", async (every) => {
    const h = harness(undefined, every);
    h.engine().start();
    await settle();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("honors paused and disabled schedules", async () => {
    const h = harness();
    h.store.setPaused(h.config.id, true);
    h.engine().start();
    await settle();
    expect(h.execute).not.toHaveBeenCalled();
    h.store.setPaused(h.config.id, false);
    h.config.enabled = false;
    h.engine().start();
    await settle();
    expect(h.execute).not.toHaveBeenCalled();
  });
});
