import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentJobWorker } from "../src/attachment-worker.js";
import { AttachmentStore } from "../src/attachments-store.js";
import { TangoStorage } from "../src/storage.js";

interface Harness {
  dbPath: string;
  open: () => {
    storage: TangoStorage;
    store: AttachmentStore;
    close: () => void;
  };
}

const cleanups: Array<{ dir: string; storages: Set<TangoStorage> }> = [];

function createHarness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-attachment-worker-"));
  const cleanup = { dir, storages: new Set<TangoStorage>() };
  cleanups.push(cleanup);
  const dbPath = path.join(dir, "tango.sqlite");

  return {
    dbPath,
    open: () => {
      const storage = new TangoStorage(dbPath, { seedExampleRoster: true });
      cleanup.storages.add(storage);
      return {
        storage,
        store: new AttachmentStore(storage.getDatabase()),
        close: () => {
          if (cleanup.storages.delete(storage)) {
            storage.close();
          }
        },
      };
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (!cleanup) continue;
    for (const storage of cleanup.storages) {
      storage.close();
    }
    fs.rmSync(cleanup.dir, { recursive: true, force: true });
  }
});

function createAttachment(store: AttachmentStore) {
  const file = store.upsertFile({
    sha256: "sha256-worker-attachment",
    bytes: 2048,
    contentType: "image/png",
    originalFilename: "receipt.png",
    storagePath: "attachments/source/sha256-worker-attachment.png",
  });

  return store.createAttachment({
    projectId: "project-1",
    agentId: "agent-watson",
    sessionId: "session-1",
    messageId: "message-1",
    channelId: "channel-1",
    threadId: "thread-1",
    userId: "user-1",
    discordAttachmentId: "discord-worker-attachment",
    fileId: file.id,
    title: "Receipt",
    originalFilename: "receipt.png",
    contentType: "image/png",
    bytes: 2048,
  });
}

describe("AttachmentJobWorker", () => {
  it("drains a durable successful job and marks the attachment ready", async () => {
    const harness = createHarness();
    const first = harness.open();
    const attachment = createAttachment(first.store);
    const job = first.store.enqueueJob({
      attachmentId: attachment.id,
      kind: "classify",
      metadata: { source: "durable-test" },
    });
    first.close();

    const second = harness.open();
    const handled: number[] = [];
    const worker = new AttachmentJobWorker(second.store, "worker-success", {
      classify: (claimedJob) => {
        handled.push(claimedJob.id);
        return { metadata: { classified: true } };
      },
    });

    await expect(worker.drainOnce()).resolves.toMatchObject({
      status: "succeeded",
      job: { id: job.id, status: "succeeded" },
    });
    expect(handled).toEqual([job.id]);
    expect(second.store.getJob(job.id)).toMatchObject({
      status: "succeeded",
      attempts: 1,
      lockedAt: null,
      lockedBy: null,
      error: null,
      metadata: { classified: true },
    });
    expect(second.store.getAttachment(attachment.id)?.status).toBe("ready");
  });

  it("retries a failed job with bounded backoff and then succeeds", async () => {
    let currentTime = new Date("2026-01-01T00:00:00.000Z");
    const { open } = createHarness();
    const { store } = open();
    const attachment = createAttachment(store);
    const job = store.enqueueJob({
      attachmentId: attachment.id,
      kind: "embedded_text",
      maxAttempts: 3,
      runAfter: "2026-01-01 00:00:00",
    });
    let calls = 0;
    const worker = new AttachmentJobWorker(
      store,
      "worker-retry",
      {
        embedded_text: () => {
          calls += 1;
          if (calls === 1) {
            throw new Error("temporary extractor outage");
          }
          return { metadata: { extracted: true } };
        },
      },
      {
        now: () => currentTime,
        retryBackoffMs: 1_000,
        maxRetryBackoffMs: 1_000,
      },
    );

    await expect(worker.drainOnce()).resolves.toMatchObject({
      status: "retrying",
      retryAt: "2026-01-01 00:00:01",
    });
    expect(store.getJob(job.id)).toMatchObject({
      status: "pending",
      attempts: 1,
      runAfter: "2026-01-01 00:00:01",
      lockedAt: null,
      lockedBy: null,
      error: {
        code: "attachment_handler_failed",
        message: "temporary extractor outage",
        retryable: true,
        terminal: false,
      },
    });
    expect(store.getAttachment(attachment.id)?.status).toBe("processing");

    await expect(worker.drainOnce()).resolves.toMatchObject({ status: "idle", job: null });

    currentTime = new Date("2026-01-01T00:00:01.000Z");
    await expect(worker.drainOnce()).resolves.toMatchObject({
      status: "succeeded",
      job: { id: job.id, status: "succeeded" },
    });
    expect(calls).toBe(2);
    expect(store.getJob(job.id)).toMatchObject({
      status: "succeeded",
      attempts: 2,
      error: null,
      metadata: { extracted: true },
    });
    expect(store.getAttachment(attachment.id)?.status).toBe("ready");
  });

  it("leaves a terminal failure on the job and marks the attachment failed", async () => {
    const { open } = createHarness();
    const { store } = open();
    const attachment = createAttachment(store);
    const job = store.enqueueJob({
      attachmentId: attachment.id,
      kind: "apple_ocr",
      maxAttempts: 1,
    });
    const worker = new AttachmentJobWorker(store, "worker-terminal", {
      apple_ocr: () => {
        throw new Error("ocr exhausted");
      },
    });

    await expect(worker.drainOnce()).resolves.toMatchObject({
      status: "failed",
      job: { id: job.id, status: "failed" },
      error: {
        code: "attachment_handler_failed",
        message: "ocr exhausted",
        retryable: false,
        terminal: true,
      },
    });
    expect(store.getJob(job.id)).toMatchObject({
      status: "failed",
      attempts: 1,
      lockedAt: null,
      lockedBy: null,
    });
    expect(store.getAttachment(attachment.id)?.status).toBe("failed");
  });

  it("lets successful handlers set a terminal attachment status", async () => {
    const { open } = createHarness();
    const { store } = open();
    const attachment = createAttachment(store);
    const job = store.enqueueJob({
      attachmentId: attachment.id,
      kind: "classify",
      maxAttempts: 1,
    });
    const worker = new AttachmentJobWorker(store, "worker-status", {
      classify: () => ({
        attachmentStatus: "partial",
        metadata: { unsupported: true },
      }),
    });

    await expect(worker.drainOnce()).resolves.toMatchObject({
      status: "succeeded",
      job: { id: job.id, status: "succeeded" },
    });
    expect(store.getJob(job.id)).toMatchObject({
      status: "succeeded",
      metadata: { unsupported: true },
    });
    expect(store.getAttachment(attachment.id)?.status).toBe("partial");
  });

  it("recovers stale locks and allows the recovered job to drain", async () => {
    const { open } = createHarness();
    const { store } = open();
    const attachment = createAttachment(store);
    const job = store.enqueueJob({ attachmentId: attachment.id, kind: "chunk" });
    expect(store.claimNextJob({ workerId: "worker-stale", kinds: ["chunk"] })).toMatchObject({
      id: job.id,
      status: "running",
      attempts: 1,
      lockedBy: "worker-stale",
    });

    const worker = new AttachmentJobWorker(store, "worker-recovery", {
      chunk: () => ({ metadata: { chunked: true } }),
    });
    expect(
      worker.recoverStaleLocks({
        staleBefore: "9999-01-01 00:00:00",
        lockedBy: "worker-stale",
        runAfter: "2000-01-01 00:00:00",
      }),
    ).toBe(1);
    expect(store.getJob(job.id)).toMatchObject({
      status: "pending",
      attempts: 1,
      lockedAt: null,
      lockedBy: null,
      runAfter: "2000-01-01 00:00:00",
    });

    await expect(worker.drainOnce()).resolves.toMatchObject({
      status: "succeeded",
      job: { id: job.id, status: "succeeded" },
    });
    expect(store.getJob(job.id)).toMatchObject({
      status: "succeeded",
      attempts: 2,
      metadata: { chunked: true },
    });
    expect(store.getAttachment(attachment.id)?.status).toBe("ready");
  });

  it("start and stop poll without continuing after stop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { open } = createHarness();
    const { store } = open();
    const attachment = createAttachment(store);
    const job = store.enqueueJob({
      attachmentId: attachment.id,
      kind: "directory",
      runAfter: "2026-01-01 00:00:00",
    });
    const handled: number[] = [];
    const worker = new AttachmentJobWorker(
      store,
      "worker-poll",
      {
        directory: (claimedJob) => {
          handled.push(claimedJob.id);
        },
      },
      {
        pollIntervalMs: 10,
        idleBackoffMs: 10,
      },
    );

    worker.start();
    await vi.runOnlyPendingTimersAsync();
    await worker.stop();
    await vi.advanceTimersByTimeAsync(100);

    expect(handled).toEqual([job.id]);
    expect(store.getJob(job.id)?.status).toBe("succeeded");
  });

  it("fails jobs with a structured error when a handler is missing", async () => {
    const { open } = createHarness();
    const { store } = open();
    const attachment = createAttachment(store);
    const job = store.enqueueJob({
      attachmentId: attachment.id,
      kind: "retention_review",
    });
    const worker = new AttachmentJobWorker(store, "worker-missing", {});

    await expect(worker.drainOnce()).resolves.toMatchObject({
      status: "failed",
      job: { id: job.id, status: "failed" },
      error: {
        code: "attachment_handler_missing",
        kind: "retention_review",
        workerId: "worker-missing",
        terminal: true,
      },
    });
    expect(store.getJob(job.id)).toMatchObject({
      status: "failed",
      attempts: 1,
      error: {
        code: "attachment_handler_missing",
        message: "No attachment job handler registered for kind retention_review",
        terminal: true,
      },
    });
    expect(store.getAttachment(attachment.id)?.status).toBe("failed");
  });
});
