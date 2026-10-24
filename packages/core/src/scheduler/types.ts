import type { ProviderReasoningEffort } from "../types.js";

/**
 * Scheduler Types — TypeScript interfaces for the scheduled jobs system.
 *
 * Config files use snake_case (YAML convention). TypeScript uses camelCase.
 * The mapping happens in loadScheduleConfigs() in config.ts.
 */

// ============================================================
// Schedule Configuration (loaded from YAML)
// ============================================================

export type ScheduleExecutionMode = "deterministic" | "conditional-agent" | "agent";
export type ScheduleDeliveryMode = "message" | "webhook" | "none";
export type CompletionScope = "daily" | "weekly" | "monthly";

export interface ScheduleTimingConfig {
  /** Cron expression (croner format, 5 or 6 fields) */
  cron?: string;
  /** Fixed interval in seconds */
  everySeconds?: number;
  /** ISO 8601 timestamp for one-shot execution */
  at?: string;
  /** IANA timezone (default: America/Los_Angeles) */
  timezone?: string;
}

export interface SchedulePreCheckConfig {
  /** Registered pre-check handler name */
  handler: string;
}

export interface ScheduleExecutionConfig {
  mode: ScheduleExecutionMode;
  /** Handler name for deterministic mode */
  handler?: string;
  /** Pre-check config for conditional-agent mode */
  preCheck?: SchedulePreCheckConfig;
  /** Worker ID for agent and conditional-agent modes */
  workerId?: string;
  /**
   * Historical deterministic intent IDs for scheduled agent runs.
   * Retained as metadata for migrated schedules; agent schedules now run
   * through the v2 runtime instead of the legacy deterministic turn runtime.
   */
  intentIds?: string[];
  /**
   * Optional agent identity to use for deterministic schedule execution.
   * Defaults to the worker owner agent when omitted.
   */
  deterministicAgentId?: string;
  /** Task prompt for agent mode */
  task?: string;
  /** Task template with {{interpolation}} for conditional-agent mode */
  taskTemplate?: string;
  /** Job status to include as review evidence; does not gate the whole run. */
  contextDependencies?: string[];
  /** Per-execution timeout in seconds */
  timeoutSeconds?: number;
  /**
   * Conditional-agent only. When true, the executor keeps re-running the
   * pre-check + agent batch until the pre-check reports nothing left to do
   * (drains the backlog in one scheduled run instead of one batch per night).
   * Bounded by drainMaxBatches and a no-progress guard.
   */
  drainBatches?: boolean;
  /** Max batches per drained run (safety cap; default 15). */
  drainMaxBatches?: number;
}

export interface ScheduleProviderConfig {
  /** Provider override (default: inherit from worker) */
  default?: string;
  /** Model override (e.g., claude-haiku-4-5-20251001 for cheap jobs) */
  model?: string;
  /** Reasoning effort override (provider-normalized by the runtime) */
  reasoningEffort?: ProviderReasoningEffort;
  /** Fallback providers */
  fallback?: string[];
}

export interface ScheduleDeliveryConfig {
  /** Discord channel for output */
  channelId?: string;
  /** Agent identity for avatar/display name */
  agentId?: string;
  /** Delivery mechanism */
  mode?: ScheduleDeliveryMode;
}

export interface ScheduleBackoffConfig {
  enabled?: boolean;
  initialSeconds?: number;
  maxSeconds?: number;
}

export interface SchedulePolicyConfig {
  /** Alert after N consecutive failures (default: 3) */
  maxConsecutiveFailures?: number;
  /** Discord channel for failure alerts */
  alertChannelId?: string;
  /** For one-shot jobs: auto-delete after execution */
  deleteAfterRun?: boolean;
  /** Jobs in same group run serially */
  concurrencyGroup?: string;
  /** Higher = runs first when multiple are due (default: 0) */
  priority?: number;
  /** Exponential backoff on failure */
  backoff?: ScheduleBackoffConfig;
}

export interface ScheduleCompletionConfig {
  /** Logical workflow to track (default: same as schedule id) */
  workflowId?: string;
  /** Completion recurrence scope (default: daily) */
  scope?: CompletionScope;
  /** Check completion table before executing (default: true) */
  checkBeforeRun?: boolean;
  /** Write completion row after successful run (default: true) */
  markOnSuccess?: boolean;
}

export interface ObsidianLogConfig {
  /** Domain subdirectory under Records/Jobs/ (e.g., "Finance", "Planning") */
  domain: string;
  /** Job display name for the log entry header (e.g., "Nightly Transaction Categorizer") */
  jobName: string;
}

export type FinanceReviewPhase = "rolling" | "close_prep" | "close" | "post_close";

export interface ScheduleStateTrackingConfig {
  /** Opt this schedule into the canonical state projection. */
  enabled: boolean;
  /** Domain label stored on the automation entity (for example, finance). */
  domain: string;
  /** Period used for deterministic entity keys and freshness checks. */
  cadence: CompletionScope;
  /** Re-run the configured read-only pre-check after success to verify remaining work. */
  verification?: "none" | "pre_check";
  /** Optional structured checklist maintained alongside the automation entity. */
  reviewChecklist?: "finance";
  /** Finance review phase recorded on the checklist entity (defaults to rolling). */
  reviewPhase?: FinanceReviewPhase;
}

export interface ScheduleConfig {
  id: string;
  displayName?: string;
  description: string;
  enabled: boolean;
  /** Runtime to use for agent execution. Agent schedules must use 'v2'. */
  runtime?: "legacy" | "v2";
  /** Startup catch-up window: none or a positive duration (s, m, h, d). */
  catchUp?: string;
  schedule: ScheduleTimingConfig;
  execution: ScheduleExecutionConfig;
  provider?: ScheduleProviderConfig;
  delivery?: ScheduleDeliveryConfig;
  policy?: SchedulePolicyConfig;
  completion?: ScheduleCompletionConfig;
  tags?: string[];
  obsidianLog?: ObsidianLogConfig;
  stateTracking?: ScheduleStateTrackingConfig;
}

// ============================================================
// Runtime State
// ============================================================

export type RunStatus = "running" | "ok" | "error" | "skipped";

export interface ScheduleRunRecord {
  id: number;
  scheduleId: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  executionMode: ScheduleExecutionMode;
  preCheckResult: string | null;
  durationMs: number | null;
  error: string | null;
  summary: string | null;
  modelUsed: string | null;
  workerId: string | null;
  deliveryStatus: string | null;
  deliveryError: string | null;
  metadata: string | null;
}

export interface ScheduleStateRecord {
  scheduleId: string;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  backoffUntil: string | null;
  totalRuns: number;
  totalOk: number;
  totalErrors: number;
  totalSkipped: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleCompletionRecord {
  id: number;
  workflowId: string;
  completedDate: string;
  completedBy: string;
  scheduleRunId: number | null;
  completedAt: string;
  metadata: string | null;
}

// ============================================================
// Handler Types
// ============================================================

export interface HandlerContext {
  scheduleId: string;
  db: import("node:sqlite").DatabaseSync;
  lastRunAt?: Date;
}

export type DeterministicResult = {
  status: "ok" | "error" | "skipped";
  summary?: string;
  data?: Record<string, unknown>;
};

export type DeterministicHandler = (ctx: HandlerContext) => Promise<DeterministicResult>;

export type PreCheckResult =
  | { action: "skip"; reason: string }
  | { action: "proceed"; context: Record<string, unknown> };

export type PreCheckHandler = (ctx: HandlerContext) => Promise<PreCheckResult>;

/** Function signature for executing a scheduled turn via the v2 Claude Code runtime. */
export type V2ScheduledTurnExecuteFn = (input: {
  config: ScheduleConfig;
  task: string;
  agentId: string;
}) => Promise<{
  text: string;
  durationMs: number;
  model?: string;
  metadata?: Record<string, unknown>;
}>;

/** Function signature for delivering messages to Discord. Injected by main.ts. */
export type DeliveryFn = (
  channelId: string,
  agentId: string,
  content: string,
) => Promise<void>;

/** Function signature for sending alert messages. */
export type AlertFn = (
  channelId: string,
  content: string,
) => Promise<void>;

/** System log entry for every job run (ok, skip, error). */
export interface SystemLogEntry {
  scheduleId: string;
  displayName?: string;
  status: RunStatus;
  durationMs: number;
  executionMode: ScheduleExecutionMode;
  summary?: string;
  error?: string;
  modelUsed?: string;
  workerId?: string;
}

/** Function signature for posting system log entries. */
export type SystemLogFn = (entry: SystemLogEntry) => Promise<void>;

export interface ScheduleRunLifecycleInput {
  config: ScheduleConfig;
  run: ScheduleRunRecord;
}

export type ScheduleRunLifecycleFn = (input: ScheduleRunLifecycleInput) => Promise<void>;
