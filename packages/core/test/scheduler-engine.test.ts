import { describe, expect, it, vi, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SchedulerEngine } from "../src/scheduler/engine.js";
import { registerDeterministicHandler } from "../src/scheduler/handlers.js";
import type { ScheduleConfig } from "../src/scheduler/types.js";

function createSchedule(overrides?: Partial<ScheduleConfig>): ScheduleConfig {
  return {
    id: "weekly-finance-review",
    description: "Run the weekly finance review.",
    enabled: true,
    schedule: {
      cron: "0 7 * * 0",
      timezone: "America/Los_Angeles",
    },
    execution: {
      mode: "agent",
      workerId: "personal-assistant",
      deterministicAgentId: "foxtrot",
      task: "Review finances.",
      timeoutSeconds: 30,
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SchedulerEngine timezone handling", () => {
  it("computes the next Sunday 7am run in the configured timezone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-05T11:48:23.000Z"));

    const engine = new SchedulerEngine(
      [createSchedule()],
      {
        store: {
          getState: () => null,
          isPaused: () => false,
          getRunningRuns: () => [],
          updateRunFinished: () => undefined,
        } as never,
        db: new DatabaseSync(":memory:"),
      },
    );

    expect(engine.getSchedules()[0]?.nextRunAt).toBe(Date.parse("2026-04-05T14:00:00.000Z"));
  });

  it("emits persisted run-started and run-finished lifecycle hooks", async () => {
    const started = vi.fn(async () => undefined);
    const finished = vi.fn(async () => undefined);
    const run = {
      id: 77,
      scheduleId: "weekly-finance-review",
      startedAt: "2026-07-12T14:00:00.000Z",
      finishedAt: null as string | null,
      status: "running" as const,
      executionMode: "agent" as const,
      preCheckResult: null,
      durationMs: null as number | null,
      error: null as string | null,
      summary: null as string | null,
      modelUsed: null as string | null,
      workerId: "personal-assistant",
      deliveryStatus: null,
      deliveryError: null,
      metadata: null,
    };
    let scheduleState: Record<string, unknown> | null = null;
    const store = {
      getState: () => scheduleState,
      getRunningRuns: () => [],
      insertRun: () => run.id,
      getRun: () => ({ ...run }),
      updateRunFinished: (_id: number, update: Record<string, unknown>) => {
        Object.assign(run, update, { finishedAt: "2026-07-12T14:01:00.000Z" });
      },
      upsertState: (_id: string, update: Record<string, unknown>) => {
        scheduleState = { ...update };
      },
      markCompletion: () => undefined,
    };
    const engine = new SchedulerEngine(
      [createSchedule({ runtime: "v2" })],
      {
        store: store as never,
        db: new DatabaseSync(":memory:"),
        executeV2Turn: async () => ({ text: "done", durationMs: 25, model: "fixture" }),
        onRunStarted: started,
        onRunFinished: finished,
      },
    );

    const result = await engine.trigger("weekly-finance-review");

    expect(result?.status).toBe("ok");
    expect(started).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ id: "weekly-finance-review" }),
      run: expect.objectContaining({ id: 77, status: "running", finishedAt: null }),
    }));
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({
      run: expect.objectContaining({ id: 77, status: "ok", finishedAt: "2026-07-12T14:01:00.000Z" }),
    }));
  });

  describe("delivery", () => {
    function createHarness(deliveryOverrides: Partial<NonNullable<ScheduleConfig["delivery"]>>) {
      const run: Record<string, unknown> = { id: 1, scheduleId: "weekly-finance-review" };
      const store = {
        getState: () => null,
        getRunningRuns: () => [],
        insertRun: () => 1,
        getRun: () => ({ ...run }),
        updateRunFinished: (_id: number, update: Record<string, unknown>) => {
          Object.assign(run, update);
        },
        upsertState: () => undefined,
        markCompletion: () => undefined,
      };
      const alert = vi.fn(async () => undefined);
      const deliver = vi.fn(async () => {
        throw new Error("channel 123 could not be fetched");
      });
      const engine = new SchedulerEngine(
        [createSchedule({
          runtime: "v2",
          delivery: { channelId: "123", ...deliveryOverrides },
          policy: { alertChannelId: "999" },
        })],
        {
          store: store as never,
          db: new DatabaseSync(":memory:"),
          executeV2Turn: async () => ({ text: "report", durationMs: 5, model: "fixture" }),
          deliver,
          alert,
        },
      );
      return { engine, run, alert, deliver };
    }

    it("records a failed delivery and alerts instead of marking it delivered", async () => {
      const { engine, run, alert } = createHarness({ agentId: "foxtrot" });

      await engine.trigger("weekly-finance-review");

      expect(run.deliveryStatus).toBe("failed");
      expect(run.deliveryError).toContain("could not be fetched");
      expect(alert).toHaveBeenCalledWith("999", expect.stringContaining("Schedule Delivery Failed"));
    });

    it("fails the delivery when the schedule names no delivery agent", async () => {
      const { engine, run, alert, deliver } = createHarness({});

      await engine.trigger("weekly-finance-review");

      expect(deliver).not.toHaveBeenCalled();
      expect(run.deliveryStatus).toBe("failed");
      expect(run.deliveryError).toContain("delivery.agent_id");
      expect(alert).toHaveBeenCalledTimes(1);
    });

    it("alerts once for repeated delivery failures and re-arms after a delivery lands", async () => {
      const { engine, alert, deliver } = createHarness({ agentId: "foxtrot" });

      await engine.trigger("weekly-finance-review");
      await engine.trigger("weekly-finance-review");
      expect(alert).toHaveBeenCalledTimes(1);

      deliver.mockImplementationOnce(async () => undefined);
      await engine.trigger("weekly-finance-review");
      await engine.trigger("weekly-finance-review");
      expect(alert).toHaveBeenCalledTimes(2);
    });

    it("keeps trying to alert about a delivery failure until the alert is sent", async () => {
      const { engine, alert } = createHarness({ agentId: "foxtrot" });
      alert.mockImplementationOnce(async () => {
        throw new Error("alerts channel unavailable");
      });

      await engine.trigger("weekly-finance-review");
      await engine.trigger("weekly-finance-review");
      await engine.trigger("weekly-finance-review");

      expect(alert).toHaveBeenCalledTimes(2);
    });
  });

  describe("failure alerts and the system log", () => {
    function createHarness(options: {
      policy?: ScheduleConfig["policy"];
      priorFailures?: number;
      turn?: () => Promise<{ text: string; durationMs: number; model: string }>;
    }) {
      let failures = options.priorFailures ?? 0;
      const store = {
        getState: () => (failures ? { consecutiveFailures: failures } : null),
        getRunningRuns: () => [],
        insertRun: () => 1,
        getRun: () => ({ id: 1 }),
        updateRunFinished: () => undefined,
        upsertState: (_id: string, update: { consecutiveFailures: number }) => {
          failures = update.consecutiveFailures;
        },
        markCompletion: () => undefined,
      };
      const alert = vi.fn(async () => undefined);
      const systemLog = vi.fn(async () => undefined);
      const engine = new SchedulerEngine(
        [createSchedule({ runtime: "v2", policy: options.policy })],
        {
          store: store as never,
          db: new DatabaseSync(":memory:"),
          executeV2Turn: options.turn ?? (async () => {
            throw new Error("upstream 503");
          }),
          alert,
          systemLog,
        },
      );
      return { engine, alert, systemLog };
    }

    it("sends threshold alerts to the default channel when the schedule names none", async () => {
      const { engine, alert } = createHarness({ policy: { maxConsecutiveFailures: 2 } });

      await engine.trigger("weekly-finance-review");
      await engine.trigger("weekly-finance-review");
      await engine.trigger("weekly-finance-review");

      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert).toHaveBeenCalledWith("", expect.stringContaining("2 consecutive failures"));
    });

    it("does not re-alert a schedule that was already past its threshold before a restart", async () => {
      const { engine, alert } = createHarness({
        policy: { maxConsecutiveFailures: 2, alertChannelId: "999" },
        priorFailures: 5,
      });

      await engine.trigger("weekly-finance-review");

      expect(alert).not.toHaveBeenCalled();
    });

    it("still gives a first alert to a past-threshold schedule that had no channel to alert on", async () => {
      const { engine, alert } = createHarness({ policy: { maxConsecutiveFailures: 2 }, priorFailures: 5 });

      await engine.trigger("weekly-finance-review");

      expect(alert).toHaveBeenCalledTimes(1);
    });

    it("retries a threshold alert that failed to send", async () => {
      const { engine, alert } = createHarness({ policy: { maxConsecutiveFailures: 1 } });
      alert.mockImplementationOnce(async () => {
        throw new Error("alerts channel unavailable");
      });

      await engine.trigger("weekly-finance-review");
      await engine.trigger("weekly-finance-review");

      expect(alert).toHaveBeenCalledTimes(2);
    });

    it("keeps skipped runs out of the system log", async () => {
      registerDeterministicHandler("engine-test-skip", async () => ({ status: "skipped", summary: "nothing to do" }));
      const systemLog = vi.fn(async () => undefined);
      const engine = new SchedulerEngine(
        [createSchedule({ execution: { mode: "deterministic", handler: "engine-test-skip", timeoutSeconds: 5 } })],
        {
          store: {
            getState: () => null,
            getRunningRuns: () => [],
            insertRun: () => 1,
            getRun: () => ({ id: 1 }),
            updateRunFinished: () => undefined,
            upsertState: () => undefined,
            markCompletion: () => undefined,
          } as never,
          db: new DatabaseSync(":memory:"),
          systemLog,
        },
      );

      const result = await engine.trigger("weekly-finance-review");

      expect(result?.status).toBe("skipped");
      expect(systemLog).not.toHaveBeenCalled();
    });
  });
});
