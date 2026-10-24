import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatAttachmentBacklogWatchdogSummary,
  formatAttachmentRetentionSweepSummary,
  listAttachmentRetentionReviewQueue,
  runAttachmentBacklogWatchdog,
  runAttachmentRetentionSweep,
} from "../src/attachment-lifecycle-maintenance.js";
import { createAttachmentRetentionPolicy } from "../src/attachment-retention-policy.js";
import { AttachmentStore } from "../src/attachments-store.js";
import { TangoStorage } from "../src/storage.js";

const cleanups: Array<{ dir: string; storages: Set<TangoStorage> }> = [];

function createHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-attachment-maintenance-"));
  const cleanup = { dir, storages: new Set<TangoStorage>() };
  cleanups.push(cleanup);
  const dbPath = path.join(dir, "tango.sqlite");

  const storage = new TangoStorage(dbPath, { seedExampleRoster: true });
  cleanup.storages.add(storage);
  return {
    storage,
    store: new AttachmentStore(storage.getDatabase()),
    db: storage.getDatabase(),
  };
}

afterEach(() => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (!cleanup) continue;
    for (const storage of cleanup.storages) {
      storage.close();
    }
    fs.rmSync(cleanup.dir, { recursive: true, force: true });
  }
});

function createAttachment(
  store: AttachmentStore,
  options: {
    suffix: string;
    status?: "ready" | "partial" | "processing" | "failed";
    metadata?: Record<string, unknown>;
  },
) {
  const file = store.upsertFile({
    sha256: `sha-${options.suffix}`,
    bytes: 1000,
    contentType: "image/png",
    originalFilename: `${options.suffix}.png`,
    storagePath: `attachments/source/${options.suffix}.png`,
  });
  return store.createAttachment({
    projectId: "tango",
    agentId: "watson",
    sessionId: "session-1",
    messageId: `message-${options.suffix}`,
    channelId: "channel-1",
    threadId: "thread-1",
    userId: "user-1",
    discordAttachmentId: `discord-${options.suffix}`,
    fileId: file.id,
    title: `${options.suffix}.png`,
    originalFilename: `${options.suffix}.png`,
    contentType: "image/png",
    bytes: 1000,
    status: options.status ?? "ready",
    metadata: options.metadata ?? null,
  });
}

function createReviewPolicy() {
  return createAttachmentRetentionPolicy([
    {
      id: "global-keep",
      schemaVersion: 1,
      enabled: true,
      priority: 0,
      scope: { type: "global" },
      actions: { all: { decision: "keep" } },
    },
    {
      id: "requested-delete-review",
      schemaVersion: 1,
      enabled: true,
      priority: 10,
      scope: { type: "global" },
      match: {
        metadata: {
          user_retention_request: "delete",
        },
      },
      actions: {
        all: {
          decision: "review",
          reason: "User requested deletion; review before action.",
          reviewAfterDays: 0,
        },
      },
    },
  ]);
}

describe("attachment lifecycle maintenance", () => {
  it("supports retention dry runs, proposed review writes, and duplicate prevention", () => {
    const { store } = createHarness();
    const attachment = createAttachment(store, {
      suffix: "delete-request",
      metadata: { user_retention_request: "delete" },
    });
    const policy = createReviewPolicy();
    const now = new Date("2026-06-02T13:30:00.000Z");

    const dryRun = runAttachmentRetentionSweep(store, {
      policy,
      dryRun: true,
      writeReviewDecisions: true,
      now,
    });

    expect(dryRun).toMatchObject({
      dryRun: true,
      evaluated: 1,
      reviewRequired: 1,
      decisionsWritten: 0,
    });
    expect(formatAttachmentRetentionSweepSummary(dryRun)).toContain("review_required=1");
    expect(store.listRetentionDecisions(attachment.id)).toEqual([]);

    const writeRun = runAttachmentRetentionSweep(store, {
      policy,
      dryRun: false,
      writeReviewDecisions: true,
      now,
      decidedBy: "test:sweep",
    });

    expect(writeRun).toMatchObject({
      dryRun: false,
      evaluated: 1,
      reviewRequired: 1,
      decisionsWritten: 1,
      duplicateProposalsSkipped: 0,
    });
    const queue = listAttachmentRetentionReviewQueue(store, { now });
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      id: writeRun.decisionIds[0],
      attachmentId: attachment.id,
      decision: "review",
      status: "proposed",
      decidedBy: "test:sweep",
    });
    expect(queue[0]?.metadata).toMatchObject({
      destructiveActionsApplied: false,
    });

    const duplicateRun = runAttachmentRetentionSweep(store, {
      policy,
      dryRun: false,
      writeReviewDecisions: true,
      now,
    });
    expect(duplicateRun.decisionsWritten).toBe(0);
    expect(duplicateRun.duplicateProposalsSkipped).toBe(1);
  });

  it("recovers stale job locks and surfaces stuck partial attachments for review", () => {
    const { store, db } = createHarness();
    const attachment = createAttachment(store, {
      suffix: "stuck-partial",
      status: "partial",
    });
    db
      .prepare("UPDATE attachments SET updated_at = ? WHERE id = ?")
      .run("2026-05-01 00:00:00", attachment.id);
    const job = store.enqueueJob({ attachmentId: attachment.id, kind: "chunk" });
    const claimed = store.claimNextJob({ workerId: "worker-stale", kinds: ["chunk"] });
    expect(claimed?.id).toBe(job.id);
    db
      .prepare("UPDATE attachment_jobs SET locked_at = ?, updated_at = ? WHERE id = ?")
      .run("2026-05-01 00:00:00", "2026-05-01 00:00:00", job.id);

    const report = runAttachmentBacklogWatchdog(store, {
      now: new Date("2026-06-02T13:30:00.000Z"),
      staleLockMs: 0,
      partialStaleMs: 1,
      writeReviewDecisions: true,
      decidedBy: "test:watchdog",
    });

    expect(report.recoveredStaleLocks).toBe(1);
    expect(report.staleRunningJobs).toBe(1);
    expect(report.stuckAttachments).toEqual([
      {
        id: attachment.id,
        status: "partial",
        updatedAt: "2026-05-01 00:00:00",
        reason: "Attachment has been partial longer than the watchdog threshold.",
      },
    ]);
    expect(report.reviewDecisionIds).toHaveLength(1);
    expect(formatAttachmentBacklogWatchdogSummary(report)).toContain("recovered_stale_locks=1");
    expect(store.getJob(job.id)).toMatchObject({
      status: "pending",
      lockedAt: null,
      lockedBy: null,
    });
    expect(store.listRetentionDecisionQueue({ attachmentId: attachment.id })).toHaveLength(1);
  });
});
