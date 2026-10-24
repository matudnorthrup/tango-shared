import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SchedulerStore,
  StateService,
  TangoStorage,
  type PreCheckResult,
  type ScheduleConfig,
  type ScheduleRunRecord,
} from "@tango/core";
import { StateSchedulerAdapter, periodForRun } from "../src/state-scheduler-adapter.js";

const cleanups: Array<{ dir: string; storage: TangoStorage }> = [];

function fixture(postCheck?: (config: ScheduleConfig, run: ScheduleRunRecord) => Promise<PreCheckResult>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-state-scheduler-"));
  const vaultRoot = path.join(dir, "vault");
  fs.mkdirSync(vaultRoot, { recursive: true });
  const storage = new TangoStorage(path.join(dir, "tango.sqlite"));
  const service = new StateService(storage.getDatabase());
  const store = new SchedulerStore(storage.getDatabase());
  const adapter = new StateSchedulerAdapter({ service, db: storage.getDatabase(), vaultRoot, postCheck });
  cleanups.push({ dir, storage });
  return { dir, vaultRoot, storage, service, store, adapter };
}

function schedule(input: Partial<ScheduleConfig> & Pick<ScheduleConfig, "id">): ScheduleConfig {
  return {
    id: input.id,
    displayName: input.displayName ?? input.id,
    description: "fixture",
    enabled: true,
    schedule: { cron: "0 2 * * *", timezone: "America/Los_Angeles" },
    execution: { mode: "conditional-agent", preCheck: { handler: "fixture-pre-check" }, task: "fixture" },
    obsidianLog: { domain: "Finance", jobName: input.displayName ?? input.id },
    stateTracking: {
      enabled: true,
      domain: "finance",
      cadence: "daily",
      verification: "pre_check",
    },
    ...input,
  };
}

function run(input: Partial<ScheduleRunRecord> & Pick<ScheduleRunRecord, "id" | "scheduleId">): ScheduleRunRecord {
  return {
    id: input.id,
    scheduleId: input.scheduleId,
    startedAt: input.startedAt ?? "2026-07-17T09:00:00.000Z",
    finishedAt: input.finishedAt ?? "2026-07-17T09:03:00.000Z",
    status: input.status ?? "ok",
    executionMode: input.executionMode ?? "conditional-agent",
    preCheckResult: input.preCheckResult ?? JSON.stringify({ action: "proceed", context: { unreviewedCount: 3 } }),
    durationMs: input.durationMs ?? 180_000,
    error: input.error ?? null,
    summary: input.summary ?? "fixture summary",
    modelUsed: input.modelUsed ?? "fixture",
    workerId: input.workerId ?? "personal-assistant",
    deliveryStatus: input.deliveryStatus ?? null,
    deliveryError: input.deliveryError ?? null,
    metadata: input.metadata ?? null,
  };
}

afterEach(() => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    cleanup?.storage.close();
    if (cleanup?.dir) fs.rmSync(cleanup.dir, { recursive: true, force: true });
  }
});

describe("StateSchedulerAdapter", () => {
  it("seeds generic automation and finance-review types", () => {
    const { service } = fixture();
    expect(service.getType("automation-job", { includePrivate: true })?.origin).toBe("seed");
    expect(service.getType("finance-review", { includePrivate: true })?.origin).toBe("seed");
  });

  it("uses correct timezone-aware ISO period keys", () => {
    expect(periodForRun("2026-07-12T14:00:00.000Z", "America/Los_Angeles", "weekly")).toEqual({
      key: "2026-W28",
      localDate: "2026-07-12",
    });
    expect(periodForRun("2026-01-01T07:30:00.000Z", "America/Los_Angeles", "daily")).toEqual({
      key: "2025-12-31",
      localDate: "2025-12-31",
    });
  });

  it("projects a verified completed run with scheduler and Obsidian evidence", async () => {
    const { service, adapter } = fixture(async () => ({ action: "skip", reason: "clear" }));
    const config = schedule({ id: "nightly-transaction-categorizer", displayName: "Nightly Transaction Categorizer" });
    const record = run({ id: 41, scheduleId: config.id });

    await adapter.recordStarted(config, { ...record, status: "running", finishedAt: null });
    const result = await adapter.recordFinished(config, record);

    expect(result.verificationStatus).toBe("verified_complete");
    const entity = service.query({ type: "automation-job", includePrivate: true }).entities[0]!;
    expect(entity.status).toBe("healthy");
    expect(entity.attributes).toMatchObject({
      schedule_id: config.id,
      execution_status: "ok",
      verification_status: "verified_complete",
      last_run_id: 41,
      items_found: 3,
      items_remaining: 0,
      evidence_ref: "schedule-run:41",
      log_pointer: "obsidian:Records/Jobs/Finance/2026-07.md",
    });
    expect(entity.bodyPointer).toBe("obsidian:Records/Jobs/Finance/2026-07.md");
    expect(service.query({ entityId: entity.id, includePrivate: true, recentEvents: 10 }).entities[0]?.events).toHaveLength(2);
  });

  it("distinguishes a successful partial batch from verified completion", async () => {
    const { service, adapter } = fixture(async () => ({
      action: "proceed",
      context: { totalRetailerCandidateCount: 2, reimbursementGapCandidateCount: 1 },
    }));
    const config = schedule({ id: "receipt-cataloger", displayName: "Receipt Cataloger" });
    const record = run({
      id: 42,
      scheduleId: config.id,
      preCheckResult: JSON.stringify({
        action: "proceed",
        context: { totalRetailerCandidateCount: 5, reimbursementGapCandidateCount: 2 },
      }),
    });

    await adapter.recordStarted(config, { ...record, status: "running", finishedAt: null });
    await adapter.recordFinished(config, record);

    const entity = service.query({ type: "automation-job", includePrivate: true }).entities[0]!;
    expect(entity.status).toBe("attention");
    expect(entity.attributes).toMatchObject({
      verification_status: "verified_partial",
      items_found: 7,
      items_remaining: 3,
      needs_attention: true,
    });
  });

  it("projects a drained run whose recorded pre-check result has no context", async () => {
    const { service, adapter } = fixture(async () => ({ action: "skip", reason: "drained" }));
    const config = schedule({ id: "receipt-cataloger", displayName: "Receipt Cataloger" });
    const record = run({
      id: 13,
      scheduleId: config.id,
      preCheckResult: JSON.stringify({ action: "proceed", batchesRun: 2 }),
    });

    await adapter.recordStarted(config, { ...record, status: "running", finishedAt: null });
    const report = await adapter.recordFinished(config, record);

    expect(report.verificationStatus).toBe("verified_complete");
    const job = service.query({ type: "automation-job", includePrivate: true }).entities[0]!;
    expect(job.attributes).toMatchObject({ last_run_id: 13, items_found: null, items_remaining: 0 });
  });

  it("records failed runs without falsely post-checking them", async () => {
    let postChecks = 0;
    const { service, adapter } = fixture(async () => {
      postChecks += 1;
      return { action: "skip", reason: "clear" };
    });
    const config = schedule({ id: "receipt-cataloger" });
    const record = run({ id: 43, scheduleId: config.id, status: "error", error: "timed out", summary: null });

    await adapter.recordStarted(config, { ...record, status: "running", finishedAt: null });
    await adapter.recordFinished(config, record);

    const entity = service.query({ type: "automation-job", includePrivate: true }).entities[0]!;
    expect(entity.status).toBe("failed");
    expect(entity.attributes.verification_status).toBe("failed");
    expect(entity.attributes.last_error).toBe("timed out");
    expect(postChecks).toBe(0);
  });

  it("does not call a categorization run verified when it reports missing required rules", async () => {
    const { service, adapter } = fixture(async () => ({ action: "skip", reason: "clear" }));
    const config = schedule({ id: "nightly-transaction-categorizer" });
    const record = run({
      id: 44,
      scheduleId: config.id,
      summary: "Infrastructure: Lunch Money Rules.md still doesn't exist — 16th consecutive night.",
    });

    await adapter.recordStarted(config, { ...record, status: "running", finishedAt: null });
    await adapter.recordFinished(config, record);

    const entity = service.query({ type: "automation-job", includePrivate: true }).entities[0]!;
    expect(entity.status).toBe("unverified");
    expect(entity.attributes.verification_status).toBe("unverified");
    expect(entity.summary).toContain("unverified");
  });

  it("gates finance-review completion on all seven evidence-backed checkpoints", async () => {
    const { vaultRoot, service, adapter } = fixture(async () => ({ action: "skip", reason: "clear" }));
    for (const [index, id] of ["receipt-cataloger", "nightly-transaction-categorizer"].entries()) {
      const config = schedule({ id, displayName: id });
      const record = run({ id: 50 + index, scheduleId: id });
      await adapter.recordStarted(config, { ...record, status: "running", finishedAt: null });
      await adapter.recordFinished(config, record);
    }

    const reviewConfig = schedule({
      id: "weekly-finance-review",
      displayName: "Finance Review (Rolling)",
      execution: { mode: "agent", task: "review" },
      stateTracking: {
        enabled: true,
        domain: "finance",
        cadence: "weekly",
        verification: "none",
        reviewChecklist: "finance",
      },
    });
    const reviewRun = run({
      id: 60,
      scheduleId: reviewConfig.id,
      executionMode: "agent",
      startedAt: "2026-07-12T14:00:00.000Z",
      finishedAt: "2026-07-12T14:08:00.000Z",
      preCheckResult: null,
    });
    await adapter.recordStarted(reviewConfig, { ...reviewRun, status: "running", finishedAt: null });
    const review = service.query({ type: "finance-review", includePrivate: true }).entities[0]!;
    const relativeNote = String(review.attributes.review_note_pointer).replace(/^obsidian:/u, "");
    const notePath = path.join(vaultRoot, relativeNote);
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.writeFileSync(notePath, "---\nrecord_kind: finance_review\n---\n# Fixture\n");
    service.mutate({
      entityId: review.id,
      attributes: {
        step_freshness: "verified",
        evidence_freshness: "structured account freshness result",
        step_budget: "flagged",
        evidence_budget: "current targets plus period query",
        step_sinking_funds: "verified",
        evidence_sinking_funds: "current ledger result",
        step_reimbursements: "verified",
        evidence_reimbursements: "registry reconciliation result",
        step_close: "verified",
        evidence_close: String(review.attributes.review_note_pointer),
        open_actions: ["owner follow-up recorded"],
      },
    }, { actor: "fixture", source: "fixture", includePrivate: true });

    const finish = await adapter.recordFinished(reviewConfig, reviewRun);

    expect(finish.verificationStatus).toBe("verified_complete");
    const finishedReview = service.query({ entityId: review.id, includePrivate: true }).entities[0]!;
    expect(finishedReview.status).toBe("complete_with_actions");
    expect(finishedReview.attributes).toMatchObject({
      review_status: "complete_with_actions",
      step_context: "verified",
      step_job_health: "verified",
    });
    expect(finishedReview.bodyPointer).toBe(String(finishedReview.attributes.review_note_pointer));
    const reviewJob = service.query({ type: "automation-job", includePrivate: true }).entities
      .find((entity) => entity.attributes.schedule_id === reviewConfig.id)!;
    expect(reviewJob.status).toBe("attention");
    expect(reviewJob.attributes.verification_status).toBe("verified_complete");
  });

  it("keeps an apparently successful review blocked when checkpoints are missing", async () => {
    const { service, adapter } = fixture();
    const config = schedule({
      id: "weekly-finance-review",
      execution: { mode: "agent", task: "review" },
      stateTracking: { enabled: true, domain: "finance", cadence: "weekly", verification: "none", reviewChecklist: "finance" },
    });
    const record = run({ id: 61, scheduleId: config.id, executionMode: "agent", preCheckResult: null });

    await adapter.recordStarted(config, { ...record, status: "running", finishedAt: null });
    await adapter.recordFinished(config, record);

    const review = service.query({ type: "finance-review", includePrivate: true }).entities[0]!;
    expect(review.status).toBe("blocked");
    expect(review.attributes.review_status).toBe("blocked");
    const job = service.query({ type: "automation-job", includePrivate: true }).entities[0]!;
    expect(job.status).toBe("unverified");
  });

  it("initializes a monthly close-prep review with the configured phase", async () => {
    const { service, adapter } = fixture();
    const config = schedule({
      id: "sinking-fund-reconciliation-month-end",
      displayName: "Finance Review Close Prep",
      execution: { mode: "agent", task: "review" },
      stateTracking: {
        enabled: true,
        domain: "finance",
        cadence: "monthly",
        verification: "none",
        reviewChecklist: "finance",
        reviewPhase: "close_prep",
      },
    });
    const record = run({
      id: 62,
      scheduleId: config.id,
      executionMode: "agent",
      startedAt: "2026-09-28T14:00:00.000Z",
      preCheckResult: null,
    });

    await adapter.recordStarted(config, { ...record, status: "running", finishedAt: null });

    const review = service.query({ type: "finance-review", includePrivate: true }).entities[0]!;
    expect(review.title).toBe("Finance Review 2026-09");
    expect(review.attributes).toMatchObject({
      period_key: "2026-09",
      review_date: "2026-09-28",
      phase: "close_prep",
      last_execution_status: "running",
      schedule_run_id: 62,
    });
  });

  it("keeps production and dry-run review projections distinct", async () => {
    const { service, adapter } = fixture();
    const reviewTracking = {
      enabled: true,
      domain: "finance",
      cadence: "weekly" as const,
      verification: "none" as const,
      reviewChecklist: "finance" as const,
    };
    const production = schedule({
      id: "weekly-finance-review",
      displayName: "Finance Review (Rolling)",
      execution: { mode: "agent", task: "review" },
      stateTracking: reviewTracking,
    });
    const dryRun = schedule({
      id: "manual-test-weekly-finance-review",
      displayName: "Manual Test Finance Review Dry Run",
      execution: { mode: "agent", task: "review" },
      stateTracking: reviewTracking,
    });

    await adapter.recordStarted(production, run({
      id: 64,
      scheduleId: production.id,
      executionMode: "agent",
      startedAt: "2026-07-12T14:00:00.000Z",
      finishedAt: null,
      status: "running",
      preCheckResult: null,
    }));
    const productionJob = service.query({ type: "automation-job", includePrivate: true }).entities[0]!;
    const productionReview = service.query({ type: "finance-review", includePrivate: true }).entities[0]!;
    service.mutate({
      entityId: productionJob.id,
      aliases: ["manual-test-weekly-finance-review"],
    }, { actor: "fixture", source: "fixture", includePrivate: true });
    service.mutate({
      entityId: productionReview.id,
      aliases: ["manual-test-weekly-finance-review", "2026-W29"],
    }, { actor: "fixture", source: "fixture", includePrivate: true });
    await adapter.recordStarted(dryRun, run({
      id: 65,
      scheduleId: dryRun.id,
      executionMode: "agent",
      startedAt: "2026-07-17T20:00:00.000Z",
      finishedAt: null,
      status: "running",
      preCheckResult: null,
    }));

    const jobs = service.query({ type: "automation-job", includePrivate: true }).entities;
    expect(jobs).toHaveLength(2);
    expect(jobs.map((entity) => entity.attributes.schedule_id).sort()).toEqual([
      "manual-test-weekly-finance-review",
      "weekly-finance-review",
    ]);
    const reviews = service.query({ type: "finance-review", includePrivate: true }).entities;
    expect(reviews).toHaveLength(2);
    expect(reviews.map((entity) => entity.attributes.dry_run).sort()).toEqual([false, true]);
  });

  it("preserves completed checkpoints when a review is retried in the same period", async () => {
    const { service, adapter } = fixture();
    const config = schedule({
      id: "weekly-finance-review",
      execution: { mode: "agent", task: "review" },
      stateTracking: { enabled: true, domain: "finance", cadence: "weekly", reviewChecklist: "finance" },
    });
    const first = run({
      id: 70,
      scheduleId: config.id,
      executionMode: "agent",
      startedAt: "2026-07-14T14:00:00.000Z",
      preCheckResult: null,
    });
    await adapter.recordStarted(config, { ...first, status: "running", finishedAt: null });
    const review = service.query({ type: "finance-review", includePrivate: true }).entities[0]!;
    service.mutate({
      entityId: review.id,
      attributes: {
        step_freshness: "verified",
        evidence_freshness: "structured freshness query",
        step_budget: "flagged",
        evidence_budget: "current targets and totals",
        open_actions: ["review flagged budget item"],
      },
    }, { actor: "fixture", source: "fixture", includePrivate: true });
    await adapter.recordFinished(config, { ...first, status: "error", error: "timed out" });

    const retry = run({
      id: 71,
      scheduleId: config.id,
      executionMode: "agent",
      startedAt: "2026-07-15T14:00:00.000Z",
      preCheckResult: null,
    });
    await adapter.recordStarted(config, { ...retry, status: "running", finishedAt: null });

    const retried = service.query({ entityId: review.id, includePrivate: true }).entities[0]!;
    expect(retried.status).toBe("in_progress");
    expect(retried.attributes).toMatchObject({
      schedule_run_id: 71,
      step_freshness: "verified",
      evidence_freshness: "structured freshness query",
      step_budget: "flagged",
      evidence_budget: "current targets and totals",
      open_actions: ["review flagged budget item"],
    });
  });

  it("rejects an attempted complete review while any checkpoint is non-terminal", async () => {
    const { service, adapter } = fixture();
    const config = schedule({
      id: "weekly-finance-review",
      execution: { mode: "agent", task: "review" },
      stateTracking: { enabled: true, domain: "finance", cadence: "weekly", reviewChecklist: "finance" },
    });
    const record = run({ id: 62, scheduleId: config.id, executionMode: "agent", preCheckResult: null });
    await adapter.recordStarted(config, { ...record, status: "running", finishedAt: null });
    const review = service.query({ type: "finance-review", includePrivate: true }).entities[0]!;

    expect(() => service.mutate({
      entityId: review.id,
      attributes: { review_status: "complete" },
    }, { actor: "fixture", source: "fixture", includePrivate: true })).toThrow(/Invalid Finance Review attributes/u);
  });

  it("backfills only unseen latest runs", async () => {
    const { service, store, adapter } = fixture(async () => ({ action: "skip", reason: "clear" }));
    const config = schedule({ id: "nightly-transaction-categorizer" });
    const runId = store.insertRun({ scheduleId: config.id, executionMode: "conditional-agent" });
    store.updateRunFinished(runId, {
      status: "ok",
      durationMs: 100,
      summary: "done",
      preCheckResult: JSON.stringify({ action: "proceed", context: { unreviewedCount: 2 } }),
    });

    expect(await adapter.backfillLatest([config], store)).toMatchObject({ applied: 1, failed: 0 });
    expect(await adapter.backfillLatest([config], store)).toMatchObject({ applied: 0, skipped: 1, failed: 0 });
    expect(service.query({ type: "automation-job", includePrivate: true }).entities).toHaveLength(1);
  });

  it("repairs a run whose finish projection was interrupted", async () => {
    const { service, store, adapter } = fixture(async () => ({ action: "skip", reason: "clear" }));
    const config = schedule({ id: "receipt-cataloger" });
    const runId = store.insertRun({ scheduleId: config.id, executionMode: "conditional-agent" });
    const running = store.getRun(runId)!;
    await adapter.recordStarted(config, running);
    store.updateRunFinished(runId, {
      status: "ok",
      durationMs: 100,
      summary: "done",
      preCheckResult: JSON.stringify({ action: "proceed", context: { totalRetailerCandidateCount: 1 } }),
    });

    expect(service.query({ type: "automation-job", includePrivate: true }).entities[0]?.status).toBe("running");
    expect(await adapter.backfillLatest([config], store)).toMatchObject({ applied: 1, failed: 0 });
    expect(service.query({ type: "automation-job", includePrivate: true }).entities[0]).toMatchObject({
      status: "healthy",
      attributes: { execution_status: "ok", verification_status: "verified_complete" },
    });
  });

  it("marks a missing scheduled run overdue and creates a blocked review checkpoint", async () => {
    const { service, store, adapter } = fixture();
    const config = schedule({
      id: "weekly-finance-review",
      displayName: "Finance Review (Rolling)",
      schedule: { cron: "0 7 * * 0", timezone: "America/Los_Angeles" },
      execution: { mode: "agent", task: "review" },
      stateTracking: { enabled: true, domain: "finance", cadence: "weekly", reviewChecklist: "finance" },
    });

    const report = await adapter.reconcileExpectedRuns(
      [config],
      store,
      new Date("2026-07-12T16:00:00.000Z"),
    );

    expect(report).toMatchObject({ considered: 1, overdue: 1, applied: 2, failed: 0 });
    const job = service.query({ type: "automation-job", includePrivate: true }).entities[0]!;
    expect(job.status).toBe("overdue");
    expect(job.attributes).toMatchObject({
      execution_status: "not_run",
      verification_status: "overdue",
      last_run_id: null,
      expected_run_at: "2026-07-12T14:00:00.000Z",
    });
    const review = service.query({ type: "finance-review", includePrivate: true }).entities[0]!;
    expect(review.status).toBe("blocked");
    expect(review.attributes).toMatchObject({
      period_key: "2026-W28",
      review_status: "blocked",
      schedule_run_id: null,
      last_execution_status: "not_run",
    });
    expect(await adapter.reconcileExpectedRuns(
      [config],
      store,
      new Date("2026-07-12T16:10:00.000Z"),
    )).toMatchObject({ considered: 1, overdue: 1, applied: 0, failed: 0 });
  });
});
