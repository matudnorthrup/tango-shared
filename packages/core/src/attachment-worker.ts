import type {
  AttachmentJobKind,
  AttachmentJobRecord,
  AttachmentStatus,
  AttachmentStore,
} from "./attachments-store.js";

export const ATTACHMENT_JOB_KINDS: readonly AttachmentJobKind[] = [
  "classify",
  "embedded_text",
  "apple_ocr",
  "chunk",
  "directory",
  "llm_fallback",
  "retention_review",
] as const;

export interface AttachmentJobHandlerContext {
  store: AttachmentStore;
  workerId: string;
}

export interface AttachmentJobHandlerResult {
  attachmentStatus?: AttachmentStatus;
  metadata?: Record<string, unknown> | null;
}

export type AttachmentJobHandler = (
  job: AttachmentJobRecord,
  context: AttachmentJobHandlerContext,
) => AttachmentJobHandlerResult | void | Promise<AttachmentJobHandlerResult | void>;

export type AttachmentJobHandlerRegistry = Partial<
  Record<AttachmentJobKind, AttachmentJobHandler>
>;

export interface AttachmentJobWorkerSettings {
  pollIntervalMs?: number;
  idleBackoffMs?: number;
  errorBackoffMs?: number;
  retryBackoffMs?: number;
  maxRetryBackoffMs?: number;
  retryBackoffMultiplier?: number;
  staleLockMs?: number;
  now?: () => Date;
}

export type AttachmentJobDrainStatus = "idle" | "succeeded" | "retrying" | "failed";

export interface AttachmentJobDrainResult {
  status: AttachmentJobDrainStatus;
  job: AttachmentJobRecord | null;
  error?: Record<string, unknown>;
  retryAt?: string;
}

export interface RecoverStaleLocksInput {
  staleBefore?: string | Date;
  lockedBy?: string | null;
  runAfter?: string | Date | null;
}

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_IDLE_BACKOFF_MS = 1_000;
const DEFAULT_ERROR_BACKOFF_MS = 2_500;
const DEFAULT_RETRY_BACKOFF_MS = 1_000;
const DEFAULT_MAX_RETRY_BACKOFF_MS = 60_000;
const DEFAULT_RETRY_BACKOFF_MULTIPLIER = 2;
const DEFAULT_STALE_LOCK_MS = 5 * 60_000;

export class AttachmentJobWorker {
  private readonly pollIntervalMs: number;
  private readonly idleBackoffMs: number;
  private readonly errorBackoffMs: number;
  private readonly retryBackoffMs: number;
  private readonly maxRetryBackoffMs: number;
  private readonly retryBackoffMultiplier: number;
  private readonly staleLockMs: number;
  private readonly now: () => Date;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private activeDrain: Promise<void> | null = null;

  constructor(
    private readonly store: AttachmentStore,
    public readonly workerId: string,
    private readonly handlers: AttachmentJobHandlerRegistry,
    settings: AttachmentJobWorkerSettings = {},
  ) {
    this.pollIntervalMs = normalizeDuration(settings.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    this.idleBackoffMs = normalizeDuration(settings.idleBackoffMs, DEFAULT_IDLE_BACKOFF_MS);
    this.errorBackoffMs = normalizeDuration(settings.errorBackoffMs, DEFAULT_ERROR_BACKOFF_MS);
    this.retryBackoffMs = normalizeDuration(settings.retryBackoffMs, DEFAULT_RETRY_BACKOFF_MS);
    this.maxRetryBackoffMs = normalizeDuration(
      settings.maxRetryBackoffMs,
      DEFAULT_MAX_RETRY_BACKOFF_MS,
    );
    this.retryBackoffMultiplier = normalizeMultiplier(
      settings.retryBackoffMultiplier,
      DEFAULT_RETRY_BACKOFF_MULTIPLIER,
    );
    this.staleLockMs = normalizeDuration(settings.staleLockMs, DEFAULT_STALE_LOCK_MS);
    this.now = settings.now ?? (() => new Date());
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNextDrain(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.activeDrain) {
      await this.activeDrain;
    }
  }

  async drainOnce(): Promise<AttachmentJobDrainResult> {
    const job = this.store.claimNextJob({
      workerId: this.workerId,
      kinds: [...ATTACHMENT_JOB_KINDS],
      now: this.now(),
    });
    if (!job) {
      return { status: "idle", job: null };
    }

    this.markAttachmentProcessing(job.attachmentId);
    const handler = this.handlers[job.kind];
    if (!handler) {
      const error = this.createMissingHandlerError(job);
      const failed = this.store.failJob(job.id, error) ?? job;
      this.store.updateAttachmentStatus(job.attachmentId, "failed");
      return { status: "failed", job: failed, error };
    }

    try {
      const result = await handler(job, {
        store: this.store,
        workerId: this.workerId,
      });
      const completeOptions =
        result && "metadata" in result ? { metadata: result.metadata ?? null } : {};
      const completed = this.store.completeJob(job.id, completeOptions) ?? job;
      if (result?.attachmentStatus) {
        this.store.updateAttachmentStatus(job.attachmentId, result.attachmentStatus);
      } else {
        this.reconcileAttachmentStatus(job.attachmentId);
      }
      return { status: "succeeded", job: completed };
    } catch (error) {
      return this.recordHandlerFailure(job, error);
    }
  }

  recoverStaleLocks(input: RecoverStaleLocksInput = {}): number {
    const now = this.now();
    const staleBefore = input.staleBefore ?? new Date(now.getTime() - this.staleLockMs);
    return this.store.recoverStaleLocks({
      staleBefore,
      lockedBy: input.lockedBy,
      runAfter: input.runAfter ?? now,
    });
  }

  private async tick(): Promise<void> {
    let delayMs = this.idleBackoffMs;
    try {
      const result = await this.drainOnce();
      delayMs = result.status === "idle" ? this.idleBackoffMs : this.pollIntervalMs;
    } catch {
      delayMs = this.errorBackoffMs;
    } finally {
      this.activeDrain = null;
      this.scheduleNextDrain(delayMs);
    }
  }

  private scheduleNextDrain(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.activeDrain = this.tick();
    }, delayMs);
    this.timer.unref?.();
  }

  private recordHandlerFailure(
    job: AttachmentJobRecord,
    caughtError: unknown,
  ): AttachmentJobDrainResult {
    const retryable = job.attempts < job.maxAttempts;
    const retryAt = retryable ? this.nextRetryAt(job) : null;
    const error = this.createHandlerError(job, caughtError, retryable, retryAt);

    if (retryable && retryAt) {
      const retrying = this.store.failJob(job.id, error, { retryAt }) ?? job;
      this.markAttachmentProcessing(job.attachmentId);
      return {
        status: "retrying",
        job: retrying,
        error,
        retryAt: toSqliteDateTime(retryAt),
      };
    }

    const failed = this.store.failJob(job.id, error) ?? job;
    this.store.updateAttachmentStatus(job.attachmentId, "failed");
    return { status: "failed", job: failed, error };
  }

  private reconcileAttachmentStatus(attachmentId: number): void {
    const summary = this.store.getJobStatusSummary(attachmentId);
    if (summary.failed > 0) {
      this.store.updateAttachmentStatus(attachmentId, "failed");
      return;
    }
    if (summary.total > 0 && summary.succeeded === summary.total) {
      this.store.updateAttachmentStatus(attachmentId, "ready");
    }
  }

  private markAttachmentProcessing(attachmentId: number): void {
    const attachment = this.store.getAttachment(attachmentId);
    if (!attachment || attachment.status === "failed" || attachment.status === "retired") {
      return;
    }
    this.store.updateAttachmentStatus(attachmentId, "processing");
  }

  private nextRetryAt(job: AttachmentJobRecord): Date {
    const attemptIndex = Math.max(0, job.attempts - 1);
    const delayMs = Math.min(
      this.retryBackoffMs * this.retryBackoffMultiplier ** attemptIndex,
      this.maxRetryBackoffMs,
    );
    return new Date(this.now().getTime() + delayMs);
  }

  private createMissingHandlerError(job: AttachmentJobRecord): Record<string, unknown> {
    return {
      code: "attachment_handler_missing",
      message: `No attachment job handler registered for kind ${job.kind}`,
      kind: job.kind,
      workerId: this.workerId,
      attempt: job.attempts,
      maxAttempts: job.maxAttempts,
      terminal: true,
    };
  }

  private createHandlerError(
    job: AttachmentJobRecord,
    caughtError: unknown,
    retryable: boolean,
    retryAt: Date | null,
  ): Record<string, unknown> {
    const normalized = normalizeError(caughtError);
    return {
      code: "attachment_handler_failed",
      message: normalized.message,
      name: normalized.name,
      kind: job.kind,
      workerId: this.workerId,
      attempt: job.attempts,
      maxAttempts: job.maxAttempts,
      retryable,
      terminal: !retryable,
      retryAt: retryAt ? toSqliteDateTime(retryAt) : null,
    };
  }
}

function normalizeDuration(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value ?? Number.NaN)) return fallback;
  return Math.max(0, Math.trunc(value ?? fallback));
}

function normalizeMultiplier(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value ?? Number.NaN)) return fallback;
  return Math.max(1, value ?? fallback);
}

function normalizeError(error: unknown): { message: string; name: string } {
  if (error instanceof Error) {
    return {
      message: error.message || "Attachment job handler failed",
      name: error.name || "Error",
    };
  }
  if (typeof error === "string") {
    return { message: error, name: "Error" };
  }
  return { message: "Attachment job handler failed", name: "Error" };
}

function toSqliteDateTime(value: Date): string {
  return value.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}
