import type {
  AttachmentRecord,
  AttachmentRetentionDecisionRecord,
  AttachmentStore,
} from "./attachments-store.js";
import {
  evaluateAttachmentRetention,
  loadAttachmentRetentionPolicy,
  retentionDecisionInputFromEvaluation,
  type AttachmentRetentionEvaluation,
  type AttachmentRetentionPolicy,
} from "./attachment-retention-policy.js";

export interface AttachmentRetentionSweepReport {
  policyVersion: string;
  dryRun: boolean;
  evaluated: number;
  keep: number;
  reviewRequired: number;
  destructiveProposals: number;
  decisionsWritten: number;
  duplicateProposalsSkipped: number;
  evaluations: AttachmentRetentionEvaluation[];
  decisionIds: number[];
}

export interface RunAttachmentRetentionSweepOptions {
  policy?: AttachmentRetentionPolicy;
  dryRun?: boolean;
  writeReviewDecisions?: boolean;
  limit?: number;
  now?: Date;
  decidedBy?: string;
}

export interface AttachmentBacklogWatchdogReport {
  recoveredStaleLocks: number;
  staleRunningJobs: number;
  failedJobs: number;
  stuckAttachments: Array<{
    id: number;
    status: AttachmentRecord["status"];
    updatedAt: string;
    reason: string;
  }>;
  reviewDecisionIds: number[];
}

export interface RunAttachmentBacklogWatchdogOptions {
  now?: Date;
  staleLockMs?: number;
  partialStaleMs?: number;
  processingStaleMs?: number;
  limit?: number;
  writeReviewDecisions?: boolean;
  decidedBy?: string;
}

const DEFAULT_SWEEP_LIMIT = 250;
const DEFAULT_STALE_LOCK_MS = 10 * 60 * 1000;
const DEFAULT_PARTIAL_STALE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PROCESSING_STALE_MS = 60 * 60 * 1000;

export function runAttachmentRetentionSweep(
  store: AttachmentStore,
  options: RunAttachmentRetentionSweepOptions = {},
): AttachmentRetentionSweepReport {
  const now = options.now ?? new Date();
  const policy = options.policy ?? loadAttachmentRetentionPolicy();
  const dryRun = options.dryRun ?? true;
  const writeReviewDecisions = options.writeReviewDecisions ?? false;
  const attachments = store.listAttachments({
    status: ["ready", "partial", "failed"],
    limit: options.limit ?? DEFAULT_SWEEP_LIMIT,
  });
  const evaluations: AttachmentRetentionEvaluation[] = [];
  const decisionIds: number[] = [];
  let keep = 0;
  let reviewRequired = 0;
  let destructiveProposals = 0;
  let duplicateProposalsSkipped = 0;

  for (const attachment of attachments) {
    const evaluation = evaluateAttachmentRetention({
      attachment,
      policy,
      now,
    });
    evaluations.push(evaluation);
    if (evaluation.overallDecision === "keep") keep += 1;
    if (evaluation.requiresReview) reviewRequired += 1;
    if (evaluation.destructive) destructiveProposals += 1;

    if (!dryRun && writeReviewDecisions && evaluation.requiresReview) {
      const existing = store.listRetentionDecisionQueue({
        attachmentId: attachment.id,
        retentionPolicyId: evaluation.policyVersion,
        decision: evaluation.overallDecision,
        status: ["proposed", "approved"],
        limit: 1,
      });
      if (existing.length > 0) {
        duplicateProposalsSkipped += 1;
        continue;
      }
      const decision = store.addRetentionDecision({
        attachmentId: attachment.id,
        ...retentionDecisionInputFromEvaluation(evaluation, {
          decidedBy: options.decidedBy ?? "system:attachment-retention-sweep",
        }),
      });
      decisionIds.push(decision.id);
    }
  }

  return {
    policyVersion: policy.version,
    dryRun,
    evaluated: evaluations.length,
    keep,
    reviewRequired,
    destructiveProposals,
    decisionsWritten: decisionIds.length,
    duplicateProposalsSkipped,
    evaluations,
    decisionIds,
  };
}

export function runAttachmentBacklogWatchdog(
  store: AttachmentStore,
  options: RunAttachmentBacklogWatchdogOptions = {},
): AttachmentBacklogWatchdogReport {
  const now = options.now ?? new Date();
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const partialStaleMs = options.partialStaleMs ?? DEFAULT_PARTIAL_STALE_MS;
  const processingStaleMs = options.processingStaleMs ?? DEFAULT_PROCESSING_STALE_MS;
  const limit = options.limit ?? DEFAULT_SWEEP_LIMIT;
  const staleRunningJobs = store.listJobs({ status: "running", limit })
    .filter((job) => job.lockedAt && parseStoredDate(job.lockedAt).getTime() <= now.getTime() - staleLockMs)
    .length;
  const recoveredStaleLocks = store.recoverStaleLocks({
    staleBefore: new Date(now.getTime() - staleLockMs),
    runAfter: now,
  });
  const failedJobs = store.listJobs({ status: "failed", limit }).length;
  const stuckAttachments = store.listAttachments({
    status: ["processing", "partial"],
    limit,
  })
    .filter((attachment) => {
      const ageMs = now.getTime() - parseStoredDate(attachment.updatedAt).getTime();
      return attachment.status === "processing"
        ? ageMs >= processingStaleMs
        : ageMs >= partialStaleMs;
    })
    .map((attachment) => ({
      id: attachment.id,
      status: attachment.status,
      updatedAt: attachment.updatedAt,
      reason: attachment.status === "processing"
        ? "Attachment has been processing longer than the watchdog threshold."
        : "Attachment has been partial longer than the watchdog threshold.",
    }));
  const reviewDecisionIds = options.writeReviewDecisions
    ? writeWatchdogReviewDecisions(store, stuckAttachments, options.decidedBy ?? "system:attachment-backlog-watchdog", now)
    : [];

  return {
    recoveredStaleLocks,
    staleRunningJobs,
    failedJobs,
    stuckAttachments,
    reviewDecisionIds,
  };
}

function parseStoredDate(value: string): Date {
  return /[zZ]|[+-]\d\d:?\d\d/u.test(value)
    ? new Date(value)
    : new Date(`${value.replace(" ", "T")}Z`);
}

export function listAttachmentRetentionReviewQueue(
  store: AttachmentStore,
  options: { limit?: number; now?: Date } = {},
): AttachmentRetentionDecisionRecord[] {
  return store.listRetentionDecisionQueue({
    status: ["proposed", "approved"],
    reviewDueBefore: options.now ?? new Date(),
    limit: options.limit ?? DEFAULT_SWEEP_LIMIT,
  });
}

export function formatAttachmentRetentionSweepSummary(report: AttachmentRetentionSweepReport): string {
  return [
    `Attachment retention sweep ${report.dryRun ? "dry run" : "review proposal run"}`,
    `policy=${report.policyVersion}`,
    `evaluated=${report.evaluated}`,
    `keep=${report.keep}`,
    `review_required=${report.reviewRequired}`,
    `destructive_proposals=${report.destructiveProposals}`,
    `decisions_written=${report.decisionsWritten}`,
    `duplicates_skipped=${report.duplicateProposalsSkipped}`,
  ].join(" ");
}

export function formatAttachmentBacklogWatchdogSummary(report: AttachmentBacklogWatchdogReport): string {
  return [
    "Attachment backlog watchdog",
    `stale_running_jobs=${report.staleRunningJobs}`,
    `recovered_stale_locks=${report.recoveredStaleLocks}`,
    `failed_jobs=${report.failedJobs}`,
    `stuck_attachments=${report.stuckAttachments.length}`,
    `review_decisions_written=${report.reviewDecisionIds.length}`,
  ].join(" ");
}

function writeWatchdogReviewDecisions(
  store: AttachmentStore,
  stuckAttachments: AttachmentBacklogWatchdogReport["stuckAttachments"],
  decidedBy: string,
  now: Date,
): number[] {
  const ids: number[] = [];
  for (const stuck of stuckAttachments) {
    const existing = store.listRetentionDecisionQueue({
      attachmentId: stuck.id,
      retentionPolicyId: "attachment-watchdog:stuck-attachment-v1",
      status: ["proposed", "approved"],
      limit: 1,
    });
    if (existing.length > 0) continue;
    const decision = store.addRetentionDecision({
      attachmentId: stuck.id,
      retentionPolicyId: "attachment-watchdog:stuck-attachment-v1",
      decision: "review",
      status: "proposed",
      decidedBy,
      reason: stuck.reason,
      reviewAfter: now,
      metadata: {
        watchdog: "attachment-backlog",
        stuck,
        destructiveActionsApplied: false,
      },
    });
    ids.push(decision.id);
  }
  return ids;
}
