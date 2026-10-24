import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Cron } from "croner";
import {
  getPreCheckHandler,
  type CompletionScope,
  type PreCheckResult,
  type ScheduleConfig,
  type ScheduleRunRecord,
  type SchedulerStore,
  type StateEntity,
  type StateService,
} from "@tango/core";

const AUTOMATION_TYPE = "automation-job";
const FINANCE_REVIEW_TYPE = "finance-review";
const STATE_ACTOR = "sync:scheduler";
const FINANCE_DEPENDENCY_SCHEDULES = [
  "receipt-cataloger",
  "nightly-transaction-categorizer",
] as const;
const REVIEW_STEP_FIELDS = [
  "step_context",
  "step_freshness",
  "step_job_health",
  "step_budget",
  "step_sinking_funds",
  "step_reimbursements",
  "step_close",
] as const;
const TERMINAL_REVIEW_STEPS = new Set(["verified", "flagged", "not_applicable"]);

export interface StateSchedulerAdapterReport {
  tracked: boolean;
  automationApplied: boolean;
  reviewApplied: boolean;
  verificationStatus?: string;
  error?: string;
}

export class StateSchedulerAdapter {
  private readonly vaultRoot: string;
  private readonly postCheck: (config: ScheduleConfig, run: ScheduleRunRecord) => Promise<PreCheckResult>;

  constructor(private readonly options: {
    service: StateService;
    db: import("node:sqlite").DatabaseSync;
    vaultRoot?: string;
    postCheck?: (config: ScheduleConfig, run: ScheduleRunRecord) => Promise<PreCheckResult>;
  }) {
    this.vaultRoot = path.resolve(
      options.vaultRoot
        ?? process.env.TANGO_OBSIDIAN_VAULT
        ?? path.join(os.homedir(), "Documents", "main"),
    );
    this.postCheck = options.postCheck ?? ((config, run) => this.runConfiguredPostCheck(config, run));
  }

  async recordStarted(config: ScheduleConfig, run: ScheduleRunRecord): Promise<StateSchedulerAdapterReport> {
    if (!isTracked(config)) return { tracked: false, automationApplied: false, reviewApplied: false };
    const period = periodForRun(run.startedAt, config.schedule.timezone, config.stateTracking!.cadence);
    const logPointer = buildJobLogPointer(config, period.localDate);
    const automation = this.options.service.mutate({
      ...automationIdentity(this.options.service, config),
      title: config.displayName ?? config.id,
      aliases: [config.id],
      status: "running",
      attributes: {
        schedule_id: config.id,
        domain: config.stateTracking!.domain,
        cadence: config.stateTracking!.cadence,
        period_key: period.key,
        execution_status: "running",
        verification_status: "pending",
        last_run_id: run.id,
        last_started_at: run.startedAt,
        last_finished_at: null,
        expected_run_at: null,
        items_found: readFoundCount(run.preCheckResult),
        items_remaining: null,
        needs_attention: false,
        evidence_ref: `schedule-run:${run.id}`,
        log_pointer: logPointer,
        last_error: null,
      },
      summary: `${config.displayName ?? config.id} run ${run.id} is running.`,
      bodyPointer: logPointer,
      kind: "sync",
      note: `Scheduler run ${run.id} started.`,
    }, stateContext(run.startedAt));

    let reviewApplied = false;
    if (config.stateTracking?.reviewChecklist === "finance") {
      const review = this.createFinanceReview(config, run, period, logPointer);
      reviewApplied = review.applied;
    }
    return {
      tracked: true,
      automationApplied: automation.applied,
      reviewApplied,
      verificationStatus: "pending",
    };
  }

  async recordFinished(config: ScheduleConfig, run: ScheduleRunRecord): Promise<StateSchedulerAdapterReport> {
    if (!isTracked(config)) return { tracked: false, automationApplied: false, reviewApplied: false };
    const period = periodForRun(run.startedAt, config.schedule.timezone, config.stateTracking!.cadence);
    const logPointer = buildJobLogPointer(config, period.localDate);
    let reviewApplied = false;
    let reviewStatus: string | undefined;
    if (config.stateTracking?.reviewChecklist === "finance") {
      const review = this.finishFinanceReview(config, run, period, logPointer);
      reviewApplied = review.applied;
      reviewStatus = String(review.entity.attributes.review_status ?? "blocked");
    }

    const verification = reviewStatus
      ? verificationFromReview(run, reviewStatus)
      : await this.verifyRun(config, run);
    const automationStatus = automationEntityStatus(verification.status, verification.needsAttention);
    const automation = this.options.service.mutate({
      ...automationIdentity(this.options.service, config),
      title: config.displayName ?? config.id,
      aliases: [config.id],
      status: automationStatus,
      attributes: {
        schedule_id: config.id,
        domain: config.stateTracking!.domain,
        cadence: config.stateTracking!.cadence,
        period_key: period.key,
        execution_status: run.status,
        verification_status: verification.status,
        last_run_id: run.id,
        last_started_at: run.startedAt,
        last_finished_at: run.finishedAt,
        expected_run_at: null,
        items_found: verification.itemsFound,
        items_remaining: verification.itemsRemaining,
        needs_attention: verification.needsAttention,
        evidence_ref: `schedule-run:${run.id}`,
        log_pointer: logPointer,
        last_error: run.error,
      },
      summary: automationSummary(config, run, verification),
      bodyPointer: logPointer,
      kind: "sync",
      note: verification.note,
    }, stateContext(run.finishedAt ?? run.startedAt));

    return {
      tracked: true,
      automationApplied: automation.applied,
      reviewApplied,
      verificationStatus: verification.status,
    };
  }

  async backfillLatest(configs: readonly ScheduleConfig[], store: SchedulerStore): Promise<{
    considered: number;
    applied: number;
    skipped: number;
    failed: number;
  }> {
    let considered = 0;
    let applied = 0;
    let skipped = 0;
    let failed = 0;
    for (const config of configs) {
      if (!isTracked(config) || !config.enabled) continue;
      considered += 1;
      const run = store.getRecentRuns(config.id, 1)[0];
      if (!run || run.status === "running") {
        skipped += 1;
        continue;
      }
      const current = findAutomationEntity(this.options.service, config.id);
      const reviewMissing = config.stateTracking?.reviewChecklist === "finance"
        && !findFinanceReviewEntity(
          this.options.service,
          reviewTitle(config, periodForRun(run.startedAt, config.schedule.timezone, config.stateTracking!.cadence).key),
        );
      const review = config.stateTracking?.reviewChecklist === "finance"
        ? findFinanceReviewEntity(
            this.options.service,
            reviewTitle(config, periodForRun(run.startedAt, config.schedule.timezone, config.stateTracking!.cadence).key),
          )
        : undefined;
      const runAlreadyProjected = Number(current?.attributes.last_run_id) === run.id
        && current?.attributes.execution_status === run.status
        && (!review || review.attributes.last_execution_status === run.status);
      if (runAlreadyProjected && !reviewMissing) {
        skipped += 1;
        continue;
      }
      try {
        await this.recordStarted(config, run);
        const report = await this.recordFinished(config, run);
        if (report.automationApplied || report.reviewApplied) applied += 1;
        else skipped += 1;
      } catch (error) {
        failed += 1;
        this.options.service.openIssue(
          current?.id ?? null,
          "scheduler_state_backfill_failed",
          `Could not project schedule '${config.id}' run ${run.id}: ${errorMessage(error)}`,
          { scheduleId: config.id, scheduleRunId: run.id },
        );
      }
    }
    return { considered, applied, skipped, failed };
  }

  async reconcileExpectedRuns(
    configs: readonly ScheduleConfig[],
    store: SchedulerStore,
    now = new Date(),
  ): Promise<{ considered: number; overdue: number; applied: number; failed: number }> {
    let considered = 0;
    let overdue = 0;
    let applied = 0;
    let failed = 0;
    for (const config of configs) {
      if (!isTracked(config) || !config.enabled || !config.schedule.cron) continue;
      considered += 1;
      try {
        const expected = new Cron(config.schedule.cron, {
          timezone: config.schedule.timezone ?? "America/Los_Angeles",
        }).previousRuns(1, now)[0];
        if (!expected || now.getTime() < expected.getTime() + 30 * 60_000) continue;
        const latest = store.getRecentRuns(config.id, 1)[0];
        if (latest && new Date(latest.startedAt).getTime() >= expected.getTime() - 1_000) continue;
        overdue += 1;
        const period = periodForRun(
          expected.toISOString(),
          config.schedule.timezone,
          config.stateTracking!.cadence,
        );
        const logPointer = buildJobLogPointer(config, period.localDate);
        const evidenceRef = `schedule-due:${expected.toISOString()}`;
        const current = findAutomationEntity(this.options.service, config.id);
        if (current?.status !== "overdue" || current.attributes.evidence_ref !== evidenceRef) {
          const result = this.options.service.mutate({
            ...(current
              ? { entityId: current.id }
              : { typeId: AUTOMATION_TYPE, matchStrategy: "none" as const }),
            title: config.displayName ?? config.id,
            aliases: [config.id],
            status: "overdue",
            attributes: {
              schedule_id: config.id,
              domain: config.stateTracking!.domain,
              cadence: config.stateTracking!.cadence,
              period_key: period.key,
              execution_status: "not_run",
              verification_status: "overdue",
              last_run_id: latest?.id ?? null,
              last_started_at: latest?.startedAt ?? null,
              last_finished_at: latest?.finishedAt ?? null,
              expected_run_at: expected.toISOString(),
              items_found: null,
              items_remaining: null,
              needs_attention: true,
              evidence_ref: evidenceRef,
              log_pointer: logPointer,
              last_error: `No run recorded within 30 minutes of ${expected.toISOString()}.`,
            },
            summary: `${config.displayName ?? config.id}: overdue; expected ${expected.toISOString()}.`,
            bodyPointer: logPointer,
            kind: "sync",
            note: `Scheduled run was overdue at the state sweep (${evidenceRef}).`,
          }, stateContext(now.toISOString()));
          if (result.applied) applied += 1;
        }
        if (config.stateTracking?.reviewChecklist === "finance") {
          const review = this.markOverdueFinanceReview(config, period, logPointer, evidenceRef, now);
          if (review.applied) applied += 1;
        }
      } catch (error) {
        failed += 1;
        this.options.service.openIssue(
          findAutomationEntity(this.options.service, config.id)?.id ?? null,
          "scheduler_state_overdue_check_failed",
          `Could not evaluate expected run for '${config.id}': ${errorMessage(error)}`,
          { scheduleId: config.id },
        );
      }
    }
    return { considered, overdue, applied, failed };
  }

  private createFinanceReview(
    config: ScheduleConfig,
    run: ScheduleRunRecord,
    period: PeriodInfo,
    jobLogPointer: string | null,
  ) {
    const dryRun = config.id.startsWith("manual-test-");
    const notePointer = buildFinanceReviewPointer(period.localDate, dryRun);
    const title = reviewTitle(config, period.key);
    const existing = findFinanceReviewEntity(this.options.service, title);
    const attributes = existing
      ? {
          ...existing.attributes,
          period_key: period.key,
          review_date: period.localDate,
          phase: config.stateTracking?.reviewPhase ?? "rolling",
          dry_run: dryRun,
          review_status: "in_progress",
          schedule_run_id: run.id,
          last_execution_status: "running",
          last_run_finished_at: null,
          last_error: null,
          review_note_pointer: notePointer,
          job_log_pointer: jobLogPointer,
        }
      : {
          period_key: period.key,
          review_date: period.localDate,
          phase: config.stateTracking?.reviewPhase ?? "rolling",
          dry_run: dryRun,
          review_status: "in_progress",
          schedule_run_id: run.id,
          last_execution_status: "running",
          last_run_finished_at: null,
          last_error: null,
          step_context: "pending",
          step_freshness: "pending",
          step_job_health: "pending",
          step_budget: "pending",
          step_sinking_funds: "pending",
          step_reimbursements: "pending",
          step_close: "pending",
          evidence_context: null,
          evidence_freshness: null,
          evidence_job_health: null,
          evidence_budget: null,
          evidence_sinking_funds: null,
          evidence_reimbursements: null,
          evidence_close: null,
          review_note_pointer: notePointer,
          job_log_pointer: jobLogPointer,
          open_actions: [],
        };
    return this.options.service.mutate({
      ...(existing
        ? { entityId: existing.id }
        : {
            typeId: FINANCE_REVIEW_TYPE,
            title,
            aliases: [config.id, period.key],
            matchStrategy: "none" as const,
          }),
      status: "in_progress",
      attributes,
      summary: `Finance review ${period.key} is in progress.`,
      bodyPointer: notePointer,
      kind: "sync",
      note: existing
        ? `Finance review retry initialized for scheduler run ${run.id}; prior checkpoints were preserved.`
        : `Finance review checkpoint initialized for scheduler run ${run.id}.`,
    }, stateContext(run.startedAt));
  }

  private markOverdueFinanceReview(
    config: ScheduleConfig,
    period: PeriodInfo,
    jobLogPointer: string | null,
    evidenceRef: string,
    now: Date,
  ) {
    const title = reviewTitle(config, period.key);
    const existing = findFinanceReviewEntity(this.options.service, title);
    if (existing && ["complete", "complete_with_actions"].includes(String(existing.attributes.review_status))) {
      return { applied: false, entity: existing, event: null, created: false, reason: "already_complete" } as const;
    }
    if (
      existing?.status === "blocked"
      && existing.attributes.last_execution_status === "not_run"
      && String(existing.attributes.last_error ?? "").includes(evidenceRef)
    ) {
      return { applied: false, entity: existing, event: null, created: false, reason: "already_overdue" } as const;
    }
    const notePointer = buildFinanceReviewPointer(period.localDate, config.id.startsWith("manual-test-"));
    const attributes = existing
      ? {
          ...existing.attributes,
          review_status: "blocked",
          schedule_run_id: null,
          last_execution_status: "not_run",
          last_error: `No scheduled review run was recorded (${evidenceRef}).`,
          job_log_pointer: jobLogPointer,
        }
      : {
          period_key: period.key,
          review_date: period.localDate,
          phase: config.stateTracking?.reviewPhase ?? "rolling",
          dry_run: config.id.startsWith("manual-test-"),
          review_status: "blocked",
          schedule_run_id: null,
          last_execution_status: "not_run",
          last_run_finished_at: null,
          last_error: `No scheduled review run was recorded (${evidenceRef}).`,
          step_context: "pending",
          step_freshness: "pending",
          step_job_health: "pending",
          step_budget: "pending",
          step_sinking_funds: "pending",
          step_reimbursements: "pending",
          step_close: "pending",
          evidence_context: null,
          evidence_freshness: null,
          evidence_job_health: null,
          evidence_budget: null,
          evidence_sinking_funds: null,
          evidence_reimbursements: null,
          evidence_close: null,
          review_note_pointer: notePointer,
          job_log_pointer: jobLogPointer,
          open_actions: [],
        };
    return this.options.service.mutate({
      ...(existing
        ? { entityId: existing.id }
        : {
            typeId: FINANCE_REVIEW_TYPE,
            title,
            aliases: [config.id, period.key],
            matchStrategy: "none" as const,
          }),
      status: "blocked",
      attributes,
      summary: `Finance review ${period.key}: blocked because the scheduled run is overdue.`,
      bodyPointer: notePointer,
      kind: "sync",
      note: `Finance review expected run is overdue (${evidenceRef}).`,
    }, stateContext(now.toISOString()));
  }

  private finishFinanceReview(
    config: ScheduleConfig,
    run: ScheduleRunRecord,
    period: PeriodInfo,
    jobLogPointer: string | null,
  ) {
    const title = reviewTitle(config, period.key);
    const entity = findFinanceReviewEntity(this.options.service, title);
    if (!entity) throw new Error(`Finance review state '${title}' was not initialized.`);
    const attributes = { ...entity.attributes };
    const notePointer = String(attributes.review_note_pointer ?? buildFinanceReviewPointer(period.localDate, config.id.startsWith("manual-test-")));
    attributes.schedule_run_id = run.id;
    attributes.last_execution_status = run.status;
    attributes.last_run_finished_at = run.finishedAt;
    attributes.last_error = run.error;
    attributes.job_log_pointer = jobLogPointer;

    if (run.status === "error") {
      attributes.review_status = "blocked";
    } else {
      const noteEvidence = this.verifyReviewNote(notePointer, run.startedAt);
      attributes.step_context = noteEvidence.verified ? "verified" : "blocked";
      attributes.evidence_context = noteEvidence.detail;
      const jobHealth = this.verifyFinanceJobHealth();
      attributes.step_job_health = jobHealth.status;
      attributes.evidence_job_health = jobHealth.evidence;
      const allTerminal = REVIEW_STEP_FIELDS.every((field) => TERMINAL_REVIEW_STEPS.has(String(attributes[field] ?? "pending")));
      if (allTerminal) {
        const hasActions = REVIEW_STEP_FIELDS.some((field) => attributes[field] === "flagged")
          || (Array.isArray(attributes.open_actions) && attributes.open_actions.length > 0);
        attributes.review_status = hasActions ? "complete_with_actions" : "complete";
      } else {
        attributes.review_status = "blocked";
      }
    }

    const reviewStatus = String(attributes.review_status);
    return this.options.service.mutate({
      entityId: entity.id,
      status: reviewStatus,
      attributes,
      summary: `Finance review ${period.key}: ${reviewStatus}; scheduler run ${run.id} ${run.status}.`,
      bodyPointer: notePointer,
      kind: "sync",
      note: run.status === "error"
        ? `Scheduler run ${run.id} failed; completed checkpoints were preserved.`
        : `Scheduler run ${run.id} finished; completion gate evaluated all review checkpoints.`,
    }, stateContext(run.finishedAt ?? run.startedAt));
  }

  private verifyReviewNote(pointer: string, runStartedAt: string): { verified: boolean; detail: string } {
    const relative = pointer.replace(/^obsidian:/u, "");
    const absolute = path.resolve(this.vaultRoot, relative);
    if (!isWithin(this.vaultRoot, absolute)) return { verified: false, detail: "review note pointer escaped the vault root" };
    try {
      const stat = fs.statSync(absolute);
      const freshEnough = stat.isFile() && stat.mtimeMs >= new Date(runStartedAt).getTime() - 1_000;
      return freshEnough
        ? { verified: true, detail: pointer }
        : { verified: false, detail: `${pointer} was not written by this run` };
    } catch {
      return { verified: false, detail: `${pointer} does not exist` };
    }
  }

  private verifyFinanceJobHealth(): { status: "verified" | "flagged" | "blocked"; evidence: string } {
    const entities = FINANCE_DEPENDENCY_SCHEDULES.map((scheduleId) => findAutomationEntity(this.options.service, scheduleId));
    if (entities.some((entity) => !entity)) {
      return { status: "blocked", evidence: "automation state missing for one or more required finance jobs" };
    }
    const refs = entities.map((entity) => String(entity!.attributes.evidence_ref ?? entity!.id));
    const unhealthy = entities.some((entity) => ["failed", "unverified"].includes(entity!.status ?? ""));
    const attention = entities.some((entity) => entity!.status === "attention");
    return {
      status: unhealthy ? "blocked" : attention ? "flagged" : "verified",
      evidence: refs.join(", "),
    };
  }

  private async verifyRun(config: ScheduleConfig, run: ScheduleRunRecord): Promise<RunVerification> {
    const itemsFound = readFoundCount(run.preCheckResult);
    if (run.status === "error") {
      return {
        status: "failed",
        itemsFound,
        itemsRemaining: null,
        needsAttention: true,
        note: `Scheduler run ${run.id} failed: ${run.error ?? "unknown error"}`,
      };
    }
    if (run.status === "skipped") {
      return {
        status: "nothing_to_do",
        itemsFound: 0,
        itemsRemaining: 0,
        needsAttention: false,
        note: `Scheduler run ${run.id} verified that no work was due.`,
      };
    }
    const evidenceGap = requiredEvidenceGap(config, run.summary);
    if (evidenceGap) {
      return {
        status: "unverified",
        itemsFound,
        itemsRemaining: null,
        needsAttention: true,
        note: `Scheduler run ${run.id} returned successfully but reported missing required evidence: ${evidenceGap}`,
      };
    }
    if (config.stateTracking?.verification !== "pre_check") {
      return {
        status: "unverified",
        itemsFound,
        itemsRemaining: null,
        needsAttention: true,
        note: `Scheduler run ${run.id} returned successfully but has no deterministic post-check.`,
      };
    }
    try {
      const result = await withTimeout(
        this.postCheck(config, run),
        30_000,
        `Post-check for '${config.id}' timed out`,
      );
      if (result.action === "skip") {
        const needsAttention = summaryNeedsAttention(run.summary);
        return {
          status: "verified_complete",
          itemsFound,
          itemsRemaining: 0,
          needsAttention,
          note: needsAttention
            ? `Scheduler run ${run.id} passed its deterministic post-check with flagged follow-up.`
            : `Scheduler run ${run.id} passed its deterministic post-check.`,
        };
      }
      const remaining = readContextCount(result.context);
      return {
        status: "verified_partial",
        itemsFound,
        itemsRemaining: remaining,
        needsAttention: true,
        note: `Scheduler run ${run.id} finished, but the deterministic post-check found ${remaining ?? "remaining"} item(s).`,
      };
    } catch (error) {
      return {
        status: "unverified",
        itemsFound,
        itemsRemaining: null,
        needsAttention: true,
        note: `Scheduler run ${run.id} returned successfully, but post-check verification failed: ${errorMessage(error)}`,
      };
    }
  }

  private async runConfiguredPostCheck(config: ScheduleConfig, run: ScheduleRunRecord): Promise<PreCheckResult> {
    const handlerName = config.execution.preCheck?.handler;
    if (!handlerName) throw new Error(`Schedule '${config.id}' has no pre-check configured.`);
    const handler = getPreCheckHandler(handlerName);
    if (!handler) throw new Error(`Pre-check '${handlerName}' is not registered.`);
    return handler({ scheduleId: config.id, db: this.options.db, lastRunAt: new Date(run.startedAt) });
  }
}

interface PeriodInfo {
  key: string;
  localDate: string;
}

interface RunVerification {
  status: "verified_complete" | "verified_partial" | "nothing_to_do" | "unverified" | "failed";
  itemsFound: number | null;
  itemsRemaining: number | null;
  needsAttention: boolean;
  note: string;
}

export function periodForRun(
  timestamp: string,
  timeZone = "America/Los_Angeles",
  cadence: CompletionScope,
): PeriodInfo {
  const date = new Date(timestamp);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  const localDate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (cadence === "daily") return { key: localDate, localDate };
  if (cadence === "monthly") return { key: localDate.slice(0, 7), localDate };
  const local = new Date(Date.UTC(year, month - 1, day));
  const isoDay = local.getUTCDay() || 7;
  local.setUTCDate(local.getUTCDate() + 4 - isoDay);
  const isoYear = local.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((((local.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return { key: `${isoYear}-W${String(week).padStart(2, "0")}`, localDate };
}

function isTracked(config: ScheduleConfig): boolean {
  return config.stateTracking?.enabled === true;
}

function buildJobLogPointer(config: ScheduleConfig, localDate: string): string | null {
  if (!config.obsidianLog) return null;
  return `obsidian:Records/Jobs/${config.obsidianLog.domain}/${localDate.slice(0, 7)}.md`;
}

function buildFinanceReviewPointer(localDate: string, dryRun: boolean): string {
  return `obsidian:Records/Finance/Reviews/${localDate} Finance Review${dryRun ? " Dry Run" : ""}.md`;
}

function reviewTitle(config: ScheduleConfig, periodKey: string): string {
  return `Finance Review${config.id.startsWith("manual-test-") ? " Dry Run" : ""} ${periodKey}`;
}

function automationIdentity(service: StateService, config: ScheduleConfig) {
  const existing = findAutomationEntity(service, config.id);
  return existing
    ? { entityId: existing.id }
    : { typeId: AUTOMATION_TYPE, matchStrategy: "none" as const };
}

function findAutomationEntity(service: StateService, scheduleId: string): StateEntity | undefined {
  return service.query({ type: AUTOMATION_TYPE, includePrivate: true, includeArchived: true, limit: 500 })
    .entities.find((entity) => entity.attributes.schedule_id === scheduleId);
}

function findFinanceReviewEntity(service: StateService, title: string): StateEntity | undefined {
  return service.query({ type: FINANCE_REVIEW_TYPE, includePrivate: true, includeArchived: true, limit: 500 })
    .entities.find((entity) => entity.title === title);
}

function stateContext(occurredAt: string) {
  return {
    actor: STATE_ACTOR,
    source: STATE_ACTOR,
    agentId: "foxtrot",
    agentType: "finance",
    includePrivate: true,
    occurredAt,
  } as const;
}

function parsePreCheck(value: string | null): PreCheckResult | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as PreCheckResult;
    return parsed && (parsed.action === "skip" || parsed.action === "proceed") ? parsed : null;
  } catch {
    return null;
  }
}

function readFoundCount(preCheckResult: string | null): number | null {
  const parsed = parsePreCheck(preCheckResult);
  if (!parsed || parsed.action === "skip") return parsed?.action === "skip" ? 0 : null;
  return readContextCount(parsed.context);
}

function readContextCount(context: Record<string, unknown> | undefined): number | null {
  // Drain-mode runs record `{ action: "proceed", batchesRun }` with no context.
  if (!context) return null;
  const transactionCount = finiteInteger(context.unreviewedCount);
  if (transactionCount !== null) return transactionCount;
  const receiptCount = finiteInteger(context.totalRetailerCandidateCount);
  const gapCount = finiteInteger(context.reimbursementGapCandidateCount);
  if (receiptCount === null && gapCount === null) return null;
  return (receiptCount ?? 0) + (gapCount ?? 0);
}

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function automationEntityStatus(
  status: RunVerification["status"],
  needsAttention: boolean,
): "healthy" | "attention" | "failed" | "unverified" {
  if (status === "verified_complete" || status === "nothing_to_do") return needsAttention ? "attention" : "healthy";
  if (status === "verified_partial") return "attention";
  if (status === "failed") return "failed";
  return "unverified";
}

function automationSummary(config: ScheduleConfig, run: ScheduleRunRecord, verification: RunVerification): string {
  const remaining = verification.itemsRemaining === null ? "unknown" : String(verification.itemsRemaining);
  return `${config.displayName ?? config.id}: ${verification.status}; run ${run.id}; remaining ${remaining}.`;
}

function verificationFromReview(run: ScheduleRunRecord, reviewStatus: string): RunVerification {
  if (run.status === "error") {
    return { status: "failed", itemsFound: null, itemsRemaining: null, needsAttention: true, note: `Finance review run ${run.id} failed.` };
  }
  if (reviewStatus === "complete") {
    return { status: "verified_complete", itemsFound: null, itemsRemaining: 0, needsAttention: false, note: `Finance review run ${run.id} passed every checkpoint.` };
  }
  if (reviewStatus === "complete_with_actions") {
    return { status: "verified_complete", itemsFound: null, itemsRemaining: 0, needsAttention: true, note: `Finance review run ${run.id} passed every checkpoint with follow-up actions.` };
  }
  return { status: "unverified", itemsFound: null, itemsRemaining: null, needsAttention: true, note: `Finance review run ${run.id} ended without passing every checkpoint.` };
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiredEvidenceGap(config: ScheduleConfig, summary: string | null): string | null {
  if (config.id !== "nightly-transaction-categorizer" || !summary) return null;
  if (/Lunch Money Rules\.md[^\n]*(?:ENOENT|does(?:n['’]t| not) exist|missing|unavailable)/iu.test(summary)) {
    return "categorization rules were not read";
  }
  return null;
}

function summaryNeedsAttention(summary: string | null): boolean {
  return Boolean(summary && /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?(?:flagged|flags?|needs (?:review|input|attention))\b/imu.test(summary));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
