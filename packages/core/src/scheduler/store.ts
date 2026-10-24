/**
 * Scheduler Store — SQLite persistence for schedule runs, state, and completions.
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  ScheduleRunRecord,
  ScheduleStateRecord,
  ScheduleCompletionRecord,
  RunStatus,
  ScheduleExecutionMode,
  CompletionScope,
} from "./types.js";

export class SchedulerStore {
  constructor(private readonly db: DatabaseSync) {
    // Pauses from the Agent Desk: a paused schedule skips its timed runs until resumed (a manual run still runs).
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS schedule_pauses (schedule_id TEXT PRIMARY KEY, paused_at TEXT NOT NULL DEFAULT (datetime('now')))"
    );
  }

  // -------------------------------------------------------------------
  // Pauses
  // -------------------------------------------------------------------

  isPaused(scheduleId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM schedule_pauses WHERE schedule_id = ?").get(scheduleId);
  }

  setPaused(scheduleId: string, paused: boolean): void {
    if (paused) this.db.prepare("INSERT OR IGNORE INTO schedule_pauses (schedule_id) VALUES (?)").run(scheduleId);
    else this.db.prepare("DELETE FROM schedule_pauses WHERE schedule_id = ?").run(scheduleId);
  }

  // -------------------------------------------------------------------
  // Schedule Runs
  // -------------------------------------------------------------------

  insertRun(input: {
    scheduleId: string;
    executionMode: ScheduleExecutionMode;
    workerId?: string;
    startedAt?: string;
    metadata?: Record<string, unknown>;
  }): number {
    const startedAt = input.startedAt ?? nowUtcIso();
    const result = this.db
      .prepare(
        `INSERT INTO schedule_runs (schedule_id, started_at, execution_mode, worker_id, metadata)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(input.scheduleId, startedAt, input.executionMode, input.workerId ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null);
    return Number(result.lastInsertRowid);
  }

  updateRunFinished(
    runId: number,
    update: {
      status: RunStatus;
      durationMs: number;
      error?: string;
      summary?: string;
      modelUsed?: string;
      preCheckResult?: string;
      deliveryStatus?: string;
      deliveryError?: string;
      metadata?: Record<string, unknown>;
    },
  ): void {
    const finishedAt = nowUtcIso();
    const existingMetadata = this.getRun(runId)?.metadata;
    const metadata = { ...(existingMetadata ? JSON.parse(existingMetadata) : {}), ...update.metadata };
    this.db
      .prepare(
        `UPDATE schedule_runs SET
           finished_at = ?,
           status = ?,
           duration_ms = ?,
           error = ?,
           summary = ?,
           model_used = ?,
           pre_check_result = ?,
           delivery_status = ?,
           delivery_error = ?,
           metadata = ?
         WHERE id = ?`
      )
      .run(
        finishedAt,
        update.status,
        update.durationMs,
        update.error ?? null,
        update.summary ?? null,
        update.modelUsed ?? null,
        update.preCheckResult ?? null,
        update.deliveryStatus ?? null,
        update.deliveryError ?? null,
        Object.keys(metadata).length ? JSON.stringify(metadata) : null,
        runId,
      );
  }

  getRun(runId: number): ScheduleRunRecord | null {
    const row = this.db
      .prepare(
        `SELECT
           id, schedule_id AS scheduleId, started_at AS startedAt,
           finished_at AS finishedAt, status, execution_mode AS executionMode,
           pre_check_result AS preCheckResult, duration_ms AS durationMs,
           error, summary, model_used AS modelUsed, worker_id AS workerId,
           delivery_status AS deliveryStatus, delivery_error AS deliveryError,
           metadata
         FROM schedule_runs
         WHERE id = ?`
      )
      .get(runId) as ScheduleRunRecord | undefined;
    return row ?? null;
  }

  getRecentRuns(scheduleId: string, limit = 20): ScheduleRunRecord[] {
    return this.db
      .prepare(
        `SELECT
           id, schedule_id AS scheduleId, started_at AS startedAt,
           finished_at AS finishedAt, status, execution_mode AS executionMode,
           pre_check_result AS preCheckResult, duration_ms AS durationMs,
           error, summary, model_used AS modelUsed, worker_id AS workerId,
           delivery_status AS deliveryStatus, delivery_error AS deliveryError,
           metadata
         FROM schedule_runs
         WHERE schedule_id = ?
         ORDER BY started_at DESC
         LIMIT ?`
      )
      .all(scheduleId, limit) as unknown as ScheduleRunRecord[];
  }

  getRunningRuns(): ScheduleRunRecord[] {
    return this.db
      .prepare(
        `SELECT
           id, schedule_id AS scheduleId, started_at AS startedAt,
           finished_at AS finishedAt, status, execution_mode AS executionMode,
           pre_check_result AS preCheckResult, duration_ms AS durationMs,
           error, summary, model_used AS modelUsed, worker_id AS workerId,
           delivery_status AS deliveryStatus, delivery_error AS deliveryError,
           metadata
         FROM schedule_runs
         WHERE status = 'running'`
      )
      .all() as unknown as ScheduleRunRecord[];
  }

  // -------------------------------------------------------------------
  // Schedule State
  // -------------------------------------------------------------------

  getState(scheduleId: string): ScheduleStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT
           schedule_id AS scheduleId, last_run_at AS lastRunAt,
           last_status AS lastStatus, last_duration_ms AS lastDurationMs,
           last_error AS lastError, consecutive_failures AS consecutiveFailures,
           backoff_until AS backoffUntil, total_runs AS totalRuns,
           total_ok AS totalOk, total_errors AS totalErrors,
           total_skipped AS totalSkipped,
           created_at AS createdAt, updated_at AS updatedAt
         FROM schedule_state
         WHERE schedule_id = ?`
      )
      .get(scheduleId) as ScheduleStateRecord | undefined;
    return row ?? null;
  }

  getAllStates(): ScheduleStateRecord[] {
    return this.db
      .prepare(
        `SELECT
           schedule_id AS scheduleId, last_run_at AS lastRunAt,
           last_status AS lastStatus, last_duration_ms AS lastDurationMs,
           last_error AS lastError, consecutive_failures AS consecutiveFailures,
           backoff_until AS backoffUntil, total_runs AS totalRuns,
           total_ok AS totalOk, total_errors AS totalErrors,
           total_skipped AS totalSkipped,
           created_at AS createdAt, updated_at AS updatedAt
         FROM schedule_state`
      )
      .all() as unknown as ScheduleStateRecord[];
  }

  upsertState(
    scheduleId: string,
    update: {
      lastRunAt: string;
      lastStatus: RunStatus;
      lastDurationMs?: number;
      lastError?: string;
      consecutiveFailures: number;
      backoffUntil?: string;
    },
  ): void {
    // Determine increment columns based on status
    const okInc = update.lastStatus === "ok" ? 1 : 0;
    const errInc = update.lastStatus === "error" ? 1 : 0;
    const skipInc = update.lastStatus === "skipped" ? 1 : 0;

    this.db
      .prepare(
        `INSERT INTO schedule_state (
           schedule_id, last_run_at, last_status, last_duration_ms, last_error,
           consecutive_failures, backoff_until, total_runs, total_ok, total_errors, total_skipped, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT(schedule_id) DO UPDATE SET
           last_run_at = excluded.last_run_at,
           last_status = excluded.last_status,
           last_duration_ms = excluded.last_duration_ms,
           last_error = excluded.last_error,
           consecutive_failures = excluded.consecutive_failures,
           backoff_until = excluded.backoff_until,
           total_runs = schedule_state.total_runs + 1,
           total_ok = schedule_state.total_ok + ?,
           total_errors = schedule_state.total_errors + ?,
           total_skipped = schedule_state.total_skipped + ?,
           updated_at = excluded.updated_at`
      )
      .run(
        scheduleId,
        update.lastRunAt,
        update.lastStatus,
        update.lastDurationMs ?? null,
        update.lastError ?? null,
        update.consecutiveFailures,
        update.backoffUntil ?? null,
        okInc,
        errInc,
        skipInc,
        nowUtcIso(),
        okInc,
        errInc,
        skipInc,
      );
  }

  // -------------------------------------------------------------------
  // Completions
  // -------------------------------------------------------------------

  /** `at` is the slot being run: a catch-up checks the period it belongs to, not the current one. */
  checkCompletion(workflowId: string, scope: CompletionScope, at?: Date): ScheduleCompletionRecord | null {
    const completedDate = formatCompletionDate(scope, at);
    const row = this.db
      .prepare(
        `SELECT
           id, workflow_id AS workflowId, completed_date AS completedDate,
           completed_by AS completedBy, schedule_run_id AS scheduleRunId,
           completed_at AS completedAt, metadata
         FROM schedule_completions
         WHERE workflow_id = ? AND completed_date = ?`
      )
      .get(workflowId, completedDate) as ScheduleCompletionRecord | undefined;
    return row ?? null;
  }

  markCompletion(input: {
    workflowId: string;
    scope: CompletionScope;
    completedBy: string;
    scheduleRunId?: number;
    metadata?: Record<string, unknown>;
    /** The slot's time, for a catch-up: it completes the slot's period. */
    at?: Date;
  }): void {
    const completedDate = formatCompletionDate(input.scope, input.at);
    const completedAt = nowUtcIso();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO schedule_completions
           (workflow_id, completed_date, completed_by, schedule_run_id, metadata, completed_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.workflowId,
        completedDate,
        input.completedBy,
        input.scheduleRunId ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        completedAt,
      );
  }
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function formatCompletionDate(scope: CompletionScope, at?: Date): string {
  const now = at ?? new Date();
  switch (scope) {
    case "daily":
      return now.toISOString().slice(0, 10); // YYYY-MM-DD
    case "weekly": {
      // ISO-8601 week using the host-local calendar date. Moving to Thursday
      // identifies the ISO week-year and avoids the old one-week drift.
      const local = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
      const isoDay = local.getUTCDay() || 7;
      local.setUTCDate(local.getUTCDate() + 4 - isoDay);
      const isoYear = local.getUTCFullYear();
      const yearStart = new Date(Date.UTC(isoYear, 0, 1));
      const week = Math.ceil((((local.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
      return `${isoYear}-W${String(week).padStart(2, "0")}`;
    }
    case "monthly":
      return now.toISOString().slice(0, 7); // YYYY-MM
  }
}

function nowUtcIso(): string {
  return new Date().toISOString();
}
