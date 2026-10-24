import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AttachmentStatus } from "../src/attachments-store.js";
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-attachments-store-"));
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
    suffix?: string;
    status?: AttachmentStatus;
    channelId?: string;
    threadId?: string;
  } = {},
) {
  const suffix = options.suffix ?? "attachment";
  const file = store.upsertFile({
    sha256: `sha256-${suffix}`,
    bytes: 1200,
    contentType: "image/png",
    originalFilename: "receipt.png",
    storagePath: `attachments/source/sha256-${suffix}.png`,
    metadata: { source: "test" },
  });
  const discordAttachmentId = options.suffix
    ? `discord-attachment-${suffix}`
    : "discord-attachment-1";

  return store.createAttachment({
    projectId: "project-1",
    agentId: "agent-papa",
    sessionId: "session-1",
    messageId: "message-1",
    channelId: options.channelId ?? "channel-1",
    threadId: options.threadId ?? "thread-1",
    userId: "user-1",
    discordAttachmentId,
    fileId: file.id,
    title: "Receipt",
    originalFilename: "receipt.png",
    contentType: "image/png",
    bytes: 1200,
    status: options.status,
    metadata: {
      nested: { vendor: "Corner Market" },
      tags: ["receipt", "image"],
    },
  });
}

describe("AttachmentStore", () => {
  it("migration creates usable attachment tables", () => {
    const { open } = createHarness();
    const { storage } = open();

    const rows = storage
      .getDatabase()
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND name IN (
             'attachment_files',
             'attachments',
             'attachment_jobs',
             'attachment_extractions',
             'attachment_chunks',
             'attachment_directories',
             'attachment_retention_decisions'
           )
         ORDER BY name`
      )
      .all() as Array<{ name: string }>;

    expect(rows.map((row) => row.name)).toEqual([
      "attachment_chunks",
      "attachment_directories",
      "attachment_extractions",
      "attachment_files",
      "attachment_jobs",
      "attachment_retention_decisions",
      "attachments",
    ]);

    const version = storage.getUserVersion();
    expect(version).toBeGreaterThanOrEqual(36);

    const attachmentTools = storage
      .getDatabase()
      .prepare(
        `SELECT id, domain, access_type AS accessType
         FROM governance_tools
         WHERE id LIKE 'attachment_%'
         ORDER BY id`
      )
      .all();
    expect(attachmentTools).toEqual([
      // registered by migration 71, born ungranted (grants are operator decisions, applied per install)
      { id: "attachment_enumerate", domain: "attachments", accessType: "read" },
      { id: "attachment_read", domain: "attachments", accessType: "read" },
      { id: "attachment_reprocess", domain: "attachments", accessType: "write" },
      { id: "attachment_search", domain: "attachments", accessType: "read" },
      { id: "attachment_status", domain: "attachments", accessType: "read" },
      // registered by migration 70, born ungranted (grants are operator decisions, applied per install)
      { id: "attachment_update", domain: "attachments", accessType: "write" },
    ]);

    const readPermission = storage
      .getDatabase()
      .prepare(
        `SELECT COUNT(*) AS count
         FROM permissions
         WHERE principal_id = 'worker:personal-assistant'
           AND tool_id IN ('attachment_search', 'attachment_read', 'attachment_status')
           AND access_level = 'read'`
      )
      .get() as { count: number };
    expect(readPermission.count).toBe(3);

    const reprocessPermission = storage
      .getDatabase()
      .prepare(
        `SELECT COUNT(*) AS count
         FROM permissions
         WHERE principal_id = 'worker:personal-assistant'
           AND tool_id = 'attachment_reprocess'`
      )
      .get() as { count: number };
    expect(reprocessPermission.count).toBe(0);
  });

  it("dedupes source files by sha256 while allowing derived rows with the same hash", () => {
    const { open } = createHarness();
    const { store } = open();

    const first = store.upsertFile({
      role: "source",
      sha256: "same-sha",
      bytes: 10,
      contentType: "image/jpeg",
      originalFilename: "before.jpg",
      storagePath: "attachments/source/same-sha.jpg",
      metadata: { pass: 1 },
    });
    const second = store.upsertFile({
      role: "source",
      sha256: "same-sha",
      bytes: 12,
      contentType: "image/png",
      originalFilename: "after.png",
      storagePath: "attachments/source/same-sha.png",
      metadata: { pass: 2 },
    });
    const derived = store.upsertFile({
      role: "derived",
      sha256: "same-sha",
      bytes: 12,
      contentType: "text/plain",
      originalFilename: "after.txt",
      storagePath: "attachments/derived/same-sha.txt",
      metadata: { derived: true },
    });

    expect(second.id).toBe(first.id);
    expect(derived.id).not.toBe(first.id);
    expect(derived).toMatchObject({
      role: "derived",
      sha256: "same-sha",
      contentType: "text/plain",
      metadata: { derived: true },
    });
    expect(store.findFileBySha256("same-sha")).toMatchObject({
      id: first.id,
      role: "source",
      bytes: 12,
      contentType: "image/png",
      originalFilename: "after.png",
      storagePath: "attachments/source/same-sha.png",
      metadata: { pass: 2 },
    });
  });

  it("creates, lists, updates, and reopens attachments with metadata intact", () => {
    const harness = createHarness();
    const first = harness.open();

    const attachment = createAttachment(first.store);
    expect(first.store.findAttachmentByDiscordAttachmentId("discord-attachment-1")?.id).toBe(
      attachment.id,
    );
    expect(first.store.listAttachments({ projectId: "project-1", status: "received" })).toHaveLength(1);

    first.close();

    const second = harness.open();
    expect(second.store.getAttachment(attachment.id)).toMatchObject({
      id: attachment.id,
      status: "received",
      metadata: {
        nested: { vendor: "Corner Market" },
        tags: ["receipt", "image"],
      },
    });

    expect(second.store.updateAttachmentStatus(attachment.id, "ready")?.status).toBe("ready");
    second.close();

    const third = harness.open();
    expect(third.store.getAttachment(attachment.id)?.status).toBe("ready");
  });

  it("runs attachment jobs through claim, success, failure, and stale lock recovery", () => {
    const { open } = createHarness();
    const { store } = open();
    const attachment = createAttachment(store);

    const job = store.enqueueJob({
      attachmentId: attachment.id,
      kind: "embedded_text",
      metadata: { source: "queue-test" },
    });
    const claimed = store.claimNextJob({ workerId: "worker-a", kinds: ["embedded_text"] });
    expect(claimed).toMatchObject({
      id: job.id,
      kind: "embedded_text",
      status: "running",
      attempts: 1,
      lockedBy: "worker-a",
      metadata: { source: "queue-test" },
    });

    expect(store.completeJob(job.id, { metadata: { completed: true } })).toMatchObject({
      id: job.id,
      status: "succeeded",
      lockedAt: null,
      lockedBy: null,
      error: null,
      metadata: { completed: true },
    });

    const failing = store.enqueueJob({ attachmentId: attachment.id, kind: "apple_ocr" });
    const failingClaim = store.claimNextJob({ workerId: "worker-b", kinds: ["apple_ocr"] });
    expect(failingClaim?.id).toBe(failing.id);
    expect(store.failJob(failing.id, "OCR failed")).toMatchObject({
      id: failing.id,
      kind: "apple_ocr",
      status: "failed",
      lockedAt: null,
      lockedBy: null,
      error: { message: "OCR failed" },
    });

    const stale = store.enqueueJob({ attachmentId: attachment.id, kind: "chunk" });
    const staleClaim = store.claimNextJob({ workerId: "worker-stale", kinds: ["chunk"] });
    expect(staleClaim).toMatchObject({
      id: stale.id,
      kind: "chunk",
      status: "running",
      attempts: 1,
      lockedBy: "worker-stale",
    });

    expect(
      store.recoverStaleLocks({
        staleBefore: "9999-01-01 00:00:00",
        lockedBy: "worker-stale",
        runAfter: "2000-01-01 00:00:00",
      }),
    ).toBe(1);
    expect(store.getJob(stale.id)).toMatchObject({
      status: "pending",
      attempts: 1,
      lockedAt: null,
      lockedBy: null,
    });

    expect(store.claimNextJob({ workerId: "worker-c", kinds: ["chunk"] })).toMatchObject({
      id: stale.id,
      kind: "chunk",
      status: "running",
      attempts: 2,
      lockedBy: "worker-c",
    });

    const completedOrFailed = store.listJobs({ status: ["succeeded", "failed"], limit: 10 });
    expect(completedOrFailed.map((row) => row.id).sort((a, b) => a - b)).toEqual([
      job.id,
      failing.id,
    ]);
  });

  it("rejects job kinds outside the approved attachment cascade", () => {
    const { open } = createHarness();
    const { storage, store } = open();
    const attachment = createAttachment(store);

    expect(() =>
      storage
        .getDatabase()
        .prepare("INSERT INTO attachment_jobs (attachment_id, kind) VALUES (?, ?)")
        .run(attachment.id, "extract_text"),
    ).toThrow();
  });

  it("inserts extractions, chunks, directories, and retention decisions", () => {
    const { open } = createHarness();
    const { store } = open();
    const attachment = createAttachment(store);

    const extraction = store.addExtraction({
      attachmentId: attachment.id,
      method: "ocr",
      text: "Corner Market total $12.34",
      confidence: 0.93,
      quality: { pages: 1, readable: true },
      metadata: { engine: "test-ocr" },
    });
    expect(extraction).toMatchObject({
      attachmentId: attachment.id,
      method: "ocr",
      quality: { pages: 1, readable: true },
      metadata: { engine: "test-ocr" },
    });
    expect(store.listExtractions(attachment.id)).toEqual([extraction]);

    const chunk = store.addChunk({
      attachmentId: attachment.id,
      extractionId: extraction.id,
      ordinal: 0,
      text: "Corner Market total $12.34",
      tokenEstimate: 5,
      metadata: { section: "body" },
    });
    expect(chunk).toMatchObject({
      attachmentId: attachment.id,
      extractionId: extraction.id,
      ordinal: 0,
      tokenEstimate: 5,
      metadata: { section: "body" },
    });
    expect(store.listChunks(attachment.id)).toEqual([chunk]);

    const directory = store.addDirectory({
      attachmentId: attachment.id,
      schemaVersion: 1,
      projectId: "project-1",
      channelId: "channel-1",
      status: "ready",
      directory: {
        attachments: [{ id: attachment.id, title: "Receipt" }],
      },
      metadata: { compact: true },
    });
    expect(directory).toMatchObject({
      attachmentId: attachment.id,
      schemaVersion: 1,
      status: "ready",
      directory: {
        attachments: [{ id: attachment.id, title: "Receipt" }],
      },
      metadata: { compact: true },
    });
    expect(store.listDirectories(attachment.id)).toEqual([directory]);

    expect(store.listDirectoriesForContext({ channelId: "channel-1", directoryStatus: "ready" })).toEqual([]);

    const decision = store.addRetentionDecision({
      attachmentId: attachment.id,
      retentionPolicyId: "policy-default",
      decision: "review",
      status: "approved",
      decidedBy: "worker:operations-assistant",
      reason: "Needs future retention review",
      metadata: { source: "test" },
    });
    expect(store.listRetentionDecisions(attachment.id)[0]).toMatchObject({
      id: decision.id,
      attachmentId: attachment.id,
      retentionPolicyId: "policy-default",
      decision: "review",
      status: "approved",
      metadata: { source: "test" },
    });
  });

  it("lists latest ready directories for scoped context", () => {
    const { open } = createHarness();
    const { store } = open();

    const receipt = createAttachment(store, {
      suffix: "context-receipt",
      status: "ready",
      channelId: "channel-context",
      threadId: "thread-context",
    });
    store.addDirectory({
      attachmentId: receipt.id,
      schemaVersion: 1,
      channelId: "channel-context",
      threadId: "thread-context",
      status: "building",
      directory: { title: "Old building directory" },
    });
    const readyDirectory = store.addDirectory({
      attachmentId: receipt.id,
      schemaVersion: 1,
      channelId: "channel-context",
      threadId: "thread-context",
      status: "ready",
      directory: { title: "Receipt directory", summary: "Total and merchant extracted." },
    });

    const failedAttachment = createAttachment(store, {
      suffix: "context-failed",
      status: "failed",
      channelId: "channel-context",
      threadId: "thread-context",
    });
    store.addDirectory({
      attachmentId: failedAttachment.id,
      schemaVersion: 1,
      channelId: "channel-context",
      threadId: "thread-context",
      status: "ready",
      directory: { title: "Failed attachment directory" },
    });

    const records = store.listDirectoriesForContext({
      channelId: "channel-context",
      directoryStatus: "ready",
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.attachment.id).toBe(receipt.id);
    expect(records[0]?.directory.id).toBe(readyDirectory.id);
    expect(records[0]?.directory.directory).toMatchObject({
      title: "Receipt directory",
    });
  });
});

// T-I-125 Phase 1 — enumeration support. listAttachments() caps at 500
// (normalizeLimit); listAllAttachments() must not, since attachment_enumerate
// promises an EXACT total ("every PDF, every image") across the whole
// library, not a capped sample.
describe("AttachmentStore.listAllAttachments", () => {
  it("returns every matching row, unbounded by the 500-row cap listAttachments() applies", () => {
    const { open } = createHarness();
    const { store } = open();

    const rowCount = 505;
    for (let index = 0; index < rowCount; index += 1) {
      createAttachment(store, { suffix: `unbounded-${index}`, channelId: "channel-x", threadId: "thread-x" });
    }

    const capped = store.listAttachments({ channelId: "channel-x", limit: 10_000 });
    expect(capped.length).toBe(500);

    const all = store.listAllAttachments({ channelId: "channel-x" });
    expect(all.length).toBe(rowCount);
  });
});

// T-I-125 Phase 1 (v0) — the operator write surface's store method: real
// columns only, no schema migration.
describe("AttachmentStore.updateAttachmentOperatorFields", () => {
  it("writes only title/project_id (+ updated_at); an empty fields object is a no-op read-back", () => {
    const { open } = createHarness();
    const { store } = open();
    const attachment = createAttachment(store, { suffix: "operator-fields" });
    const before = store.getAttachment(attachment.id)!;

    const noop = store.updateAttachmentOperatorFields(attachment.id, {});
    expect(noop).toEqual(before);

    const titled = store.updateAttachmentOperatorFields(attachment.id, { title: "Westin Banquet Room" });
    expect(titled?.title).toBe("Westin Banquet Room");
    expect(titled?.projectId).toBe(before.projectId);
    expect(titled?.contentType).toBe(before.contentType);
    expect(titled?.bytes).toBe(before.bytes);
    expect(titled?.status).toBe(before.status);
    expect(titled?.metadata).toEqual(before.metadata);
    expect(titled?.createdAt).toBe(before.createdAt);

    const both = store.updateAttachmentOperatorFields(attachment.id, {
      title: "Final Title",
      projectId: "creator-conference",
    });
    expect(both?.title).toBe("Final Title");
    expect(both?.projectId).toBe("creator-conference");

    // Explicit null clears a field rather than leaving it untouched.
    const cleared = store.updateAttachmentOperatorFields(attachment.id, { projectId: null });
    expect(cleared?.projectId).toBeNull();
    expect(cleared?.title).toBe("Final Title");
  });
});
