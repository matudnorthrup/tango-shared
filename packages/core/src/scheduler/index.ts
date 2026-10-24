/**
 * Scheduler Service — Main entry point for the scheduled jobs system.
 *
 * Lifecycle:
 *   const scheduler = new SchedulerService(configs, deps);
 *   scheduler.start();    // Begins tick loop
 *   scheduler.stop();     // Stops tick loop
 *   scheduler.trigger(id); // Manual trigger
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  ScheduleConfig,
  V2ScheduledTurnExecuteFn,
  DeliveryFn,
  AlertFn,
  SystemLogFn,
  ScheduleRunLifecycleFn,
} from "./types.js";
import { SchedulerStore } from "./store.js";
import { SchedulerEngine, type EngineConfig } from "./engine.js";

export interface SchedulerServiceDeps {
  /** SQLite database (shared with TangoStorage) */
  db: DatabaseSync;
  /** Optional function to execute a scheduled turn via the fresh v2 runtime */
  executeV2Turn?: V2ScheduledTurnExecuteFn;
  /** Function to deliver messages to Discord channels */
  deliver?: DeliveryFn;
  /** Function to send alert messages */
  alert?: AlertFn;
  /** Function to post system log entries (every run) */
  systemLog?: SystemLogFn;
  /** Optional state/audit hook after a run row is inserted. */
  onRunStarted?: ScheduleRunLifecycleFn;
  /** Optional state/audit hook after a run row is finalized. */
  onRunFinished?: ScheduleRunLifecycleFn;
  /** Engine configuration overrides */
  engineConfig?: EngineConfig;
}

export class SchedulerService {
  private readonly store: SchedulerStore;
  private readonly engine: SchedulerEngine;

  constructor(configs: ScheduleConfig[], deps: SchedulerServiceDeps) {
    this.store = new SchedulerStore(deps.db);
    this.engine = new SchedulerEngine(configs, {
      store: this.store,
      executeV2Turn: deps.executeV2Turn,
      deliver: deps.deliver,
      alert: deps.alert,
      systemLog: deps.systemLog,
      onRunStarted: deps.onRunStarted,
      onRunFinished: deps.onRunFinished,
      db: deps.db,
    }, deps.engineConfig);

    console.error(`[scheduler] initialized with ${configs.length} schedules`);
  }

  /** Start the scheduler tick loop. */
  start(): void {
    this.engine.start();
  }

  /** Stop the scheduler tick loop. */
  stop(): void {
    this.engine.stop();
  }

  /** Manually trigger a specific schedule. */
  async trigger(scheduleId: string) {
    return this.engine.trigger(scheduleId);
  }

  /** Start a run without waiting for it (the Agent Desk's Run now). */
  runNow(scheduleId: string) {
    return this.engine.runNow(scheduleId);
  }

  /** Pause or resume a schedule's timed runs. */
  setPaused(scheduleId: string, paused: boolean) {
    return this.engine.setPaused(scheduleId, paused);
  }

  /** Get all schedules with runtime state (for dashboard/API). */
  getSchedules() {
    return this.engine.getSchedules();
  }

  /** Get the underlying store for direct queries (dashboard, completions from interactive). */
  getStore(): SchedulerStore {
    return this.store;
  }
}

// Re-export everything consumers need
export { SchedulerStore } from "./store.js";
export { SchedulerEngine } from "./engine.js";
export {
  registerDeterministicHandler,
  registerPreCheckHandler,
  getDeterministicHandler,
  getPreCheckHandler,
  listRegisteredHandlers,
} from "./handlers.js";
export type {
  ScheduleConfig,
  ScheduleExecutionMode,
  ScheduleTimingConfig,
  ScheduleExecutionConfig,
  ScheduleProviderConfig,
  ScheduleDeliveryConfig,
  SchedulePolicyConfig,
  ScheduleCompletionConfig,
  ScheduleBackoffConfig,
  ScheduleDeliveryMode,
  CompletionScope,
  RunStatus,
  ScheduleRunRecord,
  ScheduleStateRecord,
  ScheduleCompletionRecord,
  HandlerContext,
  DeterministicResult,
  DeterministicHandler,
  PreCheckResult,
  PreCheckHandler,
  V2ScheduledTurnExecuteFn,
  DeliveryFn,
  AlertFn,
  SystemLogFn,
  SystemLogEntry,
  ScheduleStateTrackingConfig,
  ScheduleRunLifecycleInput,
  ScheduleRunLifecycleFn,
} from "./types.js";
