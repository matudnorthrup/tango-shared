/**
 * Scheduler Engine — Tick loop, due-job detection, concurrency management.
 *
 * Ticks every 15 seconds. On each tick:
 * 1. Find all due jobs (enabled + next_run_at <= now + not backed off)
 * 2. Sort by priority (descending)
 * 3. Respect concurrency group constraints
 * 4. Execute each job, tracking runs in SQLite
 */

import { Cron } from "croner";
import type {
  ScheduleConfig,
  RunStatus,
  V2ScheduledTurnExecuteFn,
  DeliveryFn,
  AlertFn,
  SystemLogFn,
  ScheduleRunLifecycleFn,
} from "./types.js";
import { SchedulerStore } from "./store.js";
import { executeSchedule, type ExecutionResult } from "./executor.js";

const TICK_INTERVAL_MS = 15_000;
const DEFAULT_MAX_CONCURRENT = 3;

export interface EngineConfig {
  maxConcurrent?: number;
}

export interface EngineDeps {
  store: SchedulerStore;
  /** Injectable epoch-millisecond clock. */
  now?: () => number;
  executeV2Turn?: V2ScheduledTurnExecuteFn;
  deliver?: DeliveryFn;
  alert?: AlertFn;
  systemLog?: SystemLogFn;
  onRunStarted?: ScheduleRunLifecycleFn;
  onRunFinished?: ScheduleRunLifecycleFn;
  db: import("node:sqlite").DatabaseSync;
}

interface ScheduleRuntimeState {
  config: ScheduleConfig;
  nextRunAt: number | null; // epoch ms, null = won't run (disabled or one-shot expired)
  running: boolean;
  catchUpSlot?: number;
  catchUpExpiresAt?: number;
}

export class SchedulerEngine {
  private readonly schedules = new Map<string, ScheduleRuntimeState>();
  private readonly runningGroups = new Map<string, number>(); // group -> count of running jobs
  private readonly maxConcurrent: number;
  private readonly deps: EngineDeps;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private runningCount = 0;
  private alertedSchedules = new Set<string>(); // track which schedules have been alerted
  // Schedules whose report failed to post; one alert per run of bad deliveries,
  // cleared by the next delivery that lands.
  private deliveryAlertedSchedules = new Set<string>();

  constructor(configs: ScheduleConfig[], deps: EngineDeps, engineConfig?: EngineConfig) {
    this.deps = deps;
    this.maxConcurrent = engineConfig?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;

    // Initialize runtime state for each schedule
    for (const config of configs) {
      const state = this.deps.store.getState(config.id);
      // A schedule already past its failure threshold was alerted before this
      // process started; re-alerting it on every restart is noise. Only one that
      // had its own alert channel could have been alerted, so the rest still get
      // their first alert.
      if (
        config.policy?.alertChannelId &&
        (state?.consecutiveFailures ?? 0) >= (config.policy?.maxConsecutiveFailures ?? 3)
      ) {
        this.alertedSchedules.add(config.id);
      }
      const nextRunAt = config.enabled ? this.computeNextRunAt(config, state?.backoffUntil ?? undefined) : null;

      this.schedules.set(config.id, {
        config,
        nextRunAt,
        running: false,
      });

      if (nextRunAt) {
        console.error(
          `[scheduler] loaded schedule=${config.id} next=${formatScheduleInstant(
            nextRunAt,
            config.schedule.timezone ?? "America/Los_Angeles",
          )}`
        );
      }
    }

    // Check for any stale "running" entries from a previous crash
    this.cleanupStaleRuns();
  }

  start(): void {
    if (this.tickTimer) return;
    this.prepareCatchUps();
    console.error(`[scheduler] starting tick loop (${TICK_INTERVAL_MS / 1000}s interval, max_concurrent=${this.maxConcurrent})`);
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    this.tickTimer.unref(); // Don't prevent process exit
    // Run first tick immediately
    this.tick();
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    console.error("[scheduler] stopped");
  }

  /** Manual trigger for a specific schedule (for API/dashboard use). */
  async trigger(scheduleId: string): Promise<ExecutionResult | null> {
    const runtime = this.schedules.get(scheduleId);
    if (!runtime) return null;
    return await this.executeJob(runtime);
  }

  /**
   * Starts a run now without waiting for it (the Agent Desk's Run now). "running" when one is already in
   * progress, so a second tap never doubles it.
   */
  runNow(scheduleId: string): "started" | "running" | "missing" {
    const runtime = this.schedules.get(scheduleId);
    if (!runtime) return "missing";
    if (runtime.running) return "running";
    this.executeJob(runtime).catch((err) => {
      console.error(`[scheduler] unexpected error schedule=${scheduleId}`, err);
    });
    return "started";
  }

  /** Pauses or resumes a schedule's timed runs; persisted, so a restart keeps it. False when unknown. */
  setPaused(scheduleId: string, paused: boolean): boolean {
    if (!this.schedules.has(scheduleId)) return false;
    this.deps.store.setPaused(scheduleId, paused);
    console.error(`[scheduler] ${paused ? "paused" : "resumed"} schedule=${scheduleId}`);
    return true;
  }

  getSchedules(): Array<{ config: ScheduleConfig; nextRunAt: number | null; running: boolean; paused: boolean }> {
    return [...this.schedules.values()].map((s) => ({
      config: s.config,
      nextRunAt: s.nextRunAt,
      running: s.running,
      paused: this.deps.store.isPaused(s.config.id),
    }));
  }

  // -------------------------------------------------------------------
  // Tick loop
  // -------------------------------------------------------------------

  private tick(): void {
    const now = this.now();
    const due: ScheduleRuntimeState[] = [];

    for (const runtime of this.schedules.values()) {
      if (!runtime.config.enabled) continue;
      if (runtime.running) continue;
      if (runtime.nextRunAt === null) continue;
      if (runtime.catchUpExpiresAt !== undefined && now > runtime.catchUpExpiresAt) {
        runtime.catchUpSlot = undefined;
        runtime.catchUpExpiresAt = undefined;
        runtime.nextRunAt = this.computeNextRunAt(runtime.config);
      }
      if (runtime.nextRunAt === null || runtime.nextRunAt > now) continue;
      if (this.deps.store.isPaused(runtime.config.id)) continue;

      // Check backoff
      const state = this.deps.store.getState(runtime.config.id);
      if (state?.backoffUntil) {
        const backoffUntilMs = new Date(state.backoffUntil).getTime();
        if (now < backoffUntilMs) continue;
      }

      due.push(runtime);
    }

    if (due.length === 0) return;

    // Sort by priority (higher first)
    due.sort((a, b) => {
      const pa = a.config.policy?.priority ?? 0;
      const pb = b.config.policy?.priority ?? 0;
      return pb - pa;
    });

    // Execute due jobs respecting concurrency limits
    for (const runtime of due) {
      if (this.runningCount >= this.maxConcurrent) break;

      // Check concurrency group
      const group = runtime.config.policy?.concurrencyGroup;
      if (group && (this.runningGroups.get(group) ?? 0) > 0) continue;

      // Fire and forget (tracked via promise)
      this.executeJob(runtime).catch((err) => {
        console.error(`[scheduler] unexpected error schedule=${runtime.config.id}`, err);
      });
    }
  }

  // -------------------------------------------------------------------
  // Job execution
  // -------------------------------------------------------------------

  private async notifyRunLifecycle(config: ScheduleConfig, runId: number, phase: "started" | "finished"): Promise<void> {
    const hook = phase === "started" ? this.deps.onRunStarted : this.deps.onRunFinished;
    if (!hook) return;
    const run = this.deps.store.getRun(runId);
    if (!run) return;
    try {
      await hook({ config, run });
    } catch (error) {
      console.error(`[scheduler] run-${phase === "started" ? "start" : "finished"} hook failed schedule=${config.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async executeJob(runtime: ScheduleRuntimeState): Promise<ExecutionResult> {
    const { config } = runtime;
    const { store } = this.deps;

    // Mark as running
    runtime.running = true;
    this.runningCount++;
    const group = config.policy?.concurrencyGroup;
    if (group) {
      this.runningGroups.set(group, (this.runningGroups.get(group) ?? 0) + 1);
    }

    // Check completion before running
    if (config.completion?.checkBeforeRun !== false && config.completion) {
      const workflowId = config.completion.workflowId ?? config.id;
      const scope = config.completion.scope ?? "daily";
      const existing = store.checkCompletion(workflowId, scope, runtime.catchUpSlot !== undefined ? new Date(runtime.catchUpSlot) : undefined);
      if (existing) {
        const result: ExecutionResult = {
          status: "skipped",
          durationMs: 0,
          summary: `Already completed by ${existing.completedBy} at ${existing.completedAt}`,
        };
        console.error(
          `[scheduler] run:skip schedule=${config.id} reason="workflow already completed"`
        );
        // Persist a catch-up skip too: completion checks must not replay the slot on reboot.
        if (runtime.catchUpSlot !== undefined) {
          const scheduledAt = new Date(runtime.catchUpSlot).toISOString();
          console.error(`[scheduler] catch-up schedule=${config.id} slot=${scheduledAt}`);
          const runId = store.insertRun({
            scheduleId: config.id,
            executionMode: config.execution.mode,
            workerId: config.execution.workerId,
            startedAt: new Date(this.now()).toISOString(),
            metadata: { trigger: "catch-up", scheduledAt },
          });
          // No lifecycle hooks here: they would start (and then block) a state-tracked review such as a
          // finance checklist for a run that only confirmed the period was already done (TGO-1071).
          store.updateRunFinished(runId, result);
        }
        // Record the skip in state so dashboard can see it
        store.upsertState(config.id, {
          lastRunAt: new Date(this.now()).toISOString(),
          lastStatus: "skipped",
          lastDurationMs: 0,
          consecutiveFailures: 0,
        });
        this.finishJob(runtime, result);
        return result;
      }
    }

    const slot = runtime.catchUpSlot;
    runtime.catchUpSlot = undefined;
    runtime.catchUpExpiresAt = undefined;
    if (slot !== undefined) {
      console.error(`[scheduler] catch-up schedule=${config.id} slot=${new Date(slot).toISOString()}`);
    }

    // Insert run record
    const runId = store.insertRun({
      scheduleId: config.id,
      executionMode: config.execution.mode,
      workerId: config.execution.workerId,
      startedAt: new Date(this.now()).toISOString(),
      metadata: slot === undefined ? undefined : { trigger: "catch-up", scheduledAt: new Date(slot).toISOString() },
    });

    await this.notifyRunLifecycle(config, runId, "started");

    console.error(
      `[scheduler] run:start schedule=${config.id} mode=${config.execution.mode}` +
        (config.execution.workerId ? ` worker=${config.execution.workerId}` : "")
    );

    // Execute
    const result = await executeSchedule(config, {
      store,
      executeV2Turn: this.deps.executeV2Turn,
      db: this.deps.db,
    });

    // Update run record
    store.updateRunFinished(runId, {
      status: result.status,
      durationMs: result.durationMs,
      error: result.error,
      summary: result.summary,
      modelUsed: result.modelUsed,
      preCheckResult: result.preCheckResult,
      metadata: result.metadata,
    });

    // Log result
    if (result.status === "ok") {
      console.error(
        `[scheduler] run:ok schedule=${config.id} duration=${result.durationMs}ms` +
          (result.modelUsed ? ` model=${result.modelUsed}` : "")
      );
    } else if (result.status === "error") {
      console.error(
        `[scheduler] run:error schedule=${config.id} error="${result.error}" duration=${result.durationMs}ms`
      );
    } else if (result.status === "skipped") {
      console.error(
        `[scheduler] run:skip schedule=${config.id} reason="${result.summary}"`
      );
    }

    // Update state
    const prevState = store.getState(config.id);
    const prevFailures = prevState?.consecutiveFailures ?? 0;
    const newFailures = result.status === "error" ? prevFailures + 1 : 0;
    const backoffUntil = this.computeBackoff(config, newFailures);

    store.upsertState(config.id, {
      lastRunAt: new Date(this.now()).toISOString(),
      lastStatus: result.status,
      lastDurationMs: result.durationMs,
      lastError: result.error,
      consecutiveFailures: newFailures,
      backoffUntil,
    });

    // Mark completion on success
    if (
      result.status === "ok" &&
      config.completion?.markOnSuccess !== false &&
      config.completion
    ) {
      const workflowId = config.completion.workflowId ?? config.id;
      const scope = config.completion.scope ?? "daily";
      store.markCompletion({
        workflowId,
        scope,
        completedBy: `schedule:${config.id}`,
        scheduleRunId: runId,
        ...(slot !== undefined ? { at: new Date(slot) } : {}),
      });
    }

    // Deliver results
    if (
      result.status === "ok" &&
      result.summary &&
      config.delivery?.channelId &&
      config.delivery?.mode !== "none" &&
      this.deps.deliver
    ) {
      try {
        const agentId = config.delivery.agentId?.trim();
        if (!agentId) {
          throw new Error("delivery.agent_id is not set; the schedule must name the agent that posts it");
        }
        await this.deps.deliver(config.delivery.channelId, agentId, result.summary);
        store.updateRunFinished(runId, {
          ...result,
          deliveryStatus: "delivered",
        });
        this.deliveryAlertedSchedules.delete(config.id);
      } catch (deliveryErr) {
        const errMsg = deliveryErr instanceof Error ? deliveryErr.message : String(deliveryErr);
        console.error(`[scheduler] delivery failed schedule=${config.id}: ${errMsg}`);
        store.updateRunFinished(runId, {
          ...result,
          deliveryStatus: "failed",
          deliveryError: errMsg,
        });
        if (this.deps.alert && !this.deliveryAlertedSchedules.has(config.id)) {
          const alertMsg =
            `**Schedule Delivery Failed: ${config.displayName ?? config.id}**\n` +
            `The run finished but its report was not posted to channel ${config.delivery.channelId}: ${errMsg}\n` +
            `Further delivery failures for this schedule stay quiet until a report posts again.`;
          try {
            await this.deps.alert(config.policy?.alertChannelId ?? "", alertMsg);
            // Quiet only once someone was actually told.
            this.deliveryAlertedSchedules.add(config.id);
          } catch (alertErr) {
            console.error(`[scheduler] delivery alert failed schedule=${config.id}`, alertErr);
          }
        }
      }
    }

    // Check failure threshold and alert
    const maxFailures = config.policy?.maxConsecutiveFailures ?? 3;
    if (
      newFailures >= maxFailures &&
      !this.alertedSchedules.has(config.id) &&
      this.deps.alert
    ) {
      const alertMsg =
        `**Schedule Alert: ${config.displayName ?? config.id}**\n` +
        `${newFailures} consecutive failures. Last error: "${result.error}"\n` +
        `Last successful run: ${prevState?.lastRunAt ?? "never"}`;
      try {
        // An unset channel goes to the default alerts channel, so no failing
        // schedule is silent.
        await this.deps.alert(config.policy?.alertChannelId ?? "", alertMsg);
        this.alertedSchedules.add(config.id);
      } catch (alertErr) {
        console.error(`[scheduler] alert failed schedule=${config.id}`, alertErr);
      }
    }

    // Clear alert flag on success
    if (result.status === "ok") {
      this.alertedSchedules.delete(config.id);
    }

    await this.notifyRunLifecycle(config, runId, "finished");

    // Post to the system log channel. Skips ("nothing to do") stay in run
    // history only; they were most of the channel's traffic.
    if (this.deps.systemLog && result.status !== "skipped") {
      this.deps.systemLog({
        scheduleId: config.id,
        displayName: config.displayName,
        status: result.status,
        durationMs: result.durationMs,
        executionMode: config.execution.mode,
        summary: result.summary,
        error: result.error,
        modelUsed: result.modelUsed,
        workerId: config.execution.workerId,
      }).catch((err) => {
        console.error(`[scheduler] system log failed schedule=${config.id}`, err);
      });
    }

    this.finishJob(runtime, result);
    return result;
  }

  private finishJob(runtime: ScheduleRuntimeState, result: ExecutionResult): void {
    const { config } = runtime;

    runtime.catchUpSlot = undefined;
    runtime.catchUpExpiresAt = undefined;
    runtime.running = false;
    this.runningCount--;
    const group = config.policy?.concurrencyGroup;
    if (group) {
      const current = this.runningGroups.get(group) ?? 1;
      if (current <= 1) this.runningGroups.delete(group);
      else this.runningGroups.set(group, current - 1);
    }

    // Handle one-shot schedules
    if (config.schedule.at && config.policy?.deleteAfterRun) {
      runtime.nextRunAt = null;
      return;
    }

    // Compute next run
    const backoff = result.status === "error"
      ? this.computeBackoff(config, (this.deps.store.getState(config.id)?.consecutiveFailures ?? 0))
      : undefined;
    runtime.nextRunAt = this.computeNextRunAt(config, backoff ?? undefined);
  }

  // -------------------------------------------------------------------
  // Scheduling helpers
  // -------------------------------------------------------------------

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private prepareCatchUps(): void {
    const now = this.now();
    for (const runtime of this.schedules.values()) {
      const config = runtime.config;
      if (!config.enabled || config.catchUp === "none" || this.deps.store.isPaused(config.id)) continue;
      const latest = this.deps.store.getRecentRuns(config.id, 1)[0];
      // No history means a new (or freshly reset) schedule, not a missed one: it starts on its next slot.
      if (!latest) continue;
      const lastStarted = new Date(latest.startedAt).getTime();
      let slot: number;
      let interval: number;
      if (config.schedule.cron) {
        try {
          const cron = new Cron(config.schedule.cron, {
            timezone: config.schedule.timezone ?? "America/Los_Angeles",
          });
          const [previous, beforePrevious] = cron.previousRuns(2, new Date(now));
          if (!previous || !beforePrevious) continue;
          slot = previous.getTime();
          interval = slot - beforePrevious.getTime();
        } catch {
          continue;
        }
      } else if (config.schedule.everySeconds) {
        interval = config.schedule.everySeconds * 1000;
        const anchor = lastStarted;
        slot = anchor + Math.floor((now - anchor - 1) / interval) * interval;
      } else {
        continue;
      }
      const duration = config.catchUp?.match(/^([1-9]\d*)(s|m|h|d)$/);
      const units: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
      const window = duration ? Number(duration[1]) * units[duration[2]!]! : Math.min(interval, 43_200_000);
      if (slot >= now || now - slot > window || lastStarted >= slot) continue;
      runtime.catchUpSlot = slot;
      runtime.catchUpExpiresAt = slot + window;
      runtime.nextRunAt = now;
    }
  }

  computeNextRunAt(config: ScheduleConfig, backoffUntil?: string): number | null {
    const now = this.now();

    if (config.schedule.cron) {
      try {
        const cron = new Cron(config.schedule.cron, {
          timezone: config.schedule.timezone ?? "America/Los_Angeles",
        });
        const next = cron.nextRun(new Date(now));
        if (!next) return null;
        let nextMs = next.getTime();
        if (backoffUntil) {
          const backoffMs = new Date(backoffUntil).getTime();
          if (nextMs < backoffMs) nextMs = backoffMs;
        }
        return nextMs;
      } catch {
        console.error(`[scheduler] invalid cron expression for schedule=${config.id}: ${config.schedule.cron}`);
        return null;
      }
    }

    if (config.schedule.everySeconds) {
      let nextMs = now + config.schedule.everySeconds * 1000;
      if (backoffUntil) {
        const backoffMs = new Date(backoffUntil).getTime();
        if (nextMs < backoffMs) nextMs = backoffMs;
      }
      return nextMs;
    }

    if (config.schedule.at) {
      const atMs = new Date(config.schedule.at).getTime();
      return atMs > now ? atMs : null;
    }

    return null;
  }

  private computeBackoff(config: ScheduleConfig, consecutiveFailures: number): string | undefined {
    const backoffConfig = config.policy?.backoff;
    if (backoffConfig?.enabled === false) return undefined;
    if (consecutiveFailures === 0) return undefined;

    const initialMs = (backoffConfig?.initialSeconds ?? 60) * 1000;
    const maxMs = (backoffConfig?.maxSeconds ?? 3600) * 1000;
    const delayMs = Math.min(initialMs * Math.pow(2, consecutiveFailures - 1), maxMs);
    return new Date(this.now() + delayMs).toISOString();
  }

  private cleanupStaleRuns(): void {
    const staleRuns = this.deps.store.getRunningRuns();
    for (const run of staleRuns) {
      console.error(`[scheduler] cleaning up stale run id=${run.id} schedule=${run.scheduleId}`);
      this.deps.store.updateRunFinished(run.id, {
        status: "error",
        durationMs: 0,
        error: "Stale run from previous process (cleaned up on boot)",
      });
    }
  }
}

function formatScheduleInstant(timestampMs: number, timezone: string): string {
  const date = new Date(timestampMs);
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "long",
  }).format(date);
  return `${date.toISOString()} (${timezone} ${local})`;
}
