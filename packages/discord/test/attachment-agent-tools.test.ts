import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentStore, TangoStorage, type AgentTool } from "@tango/core";
import { createAttachmentTools } from "../src/attachment-agent-tools.js";

interface Harness {
  dir: string;
  storage: TangoStorage;
  store: AttachmentStore;
}

interface SeededAttachment {
  attachmentId: number;
  extractionId: number;
  chunkId: number;
}

const harnesses: Harness[] = [];

afterEach(() => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    if (!harness) continue;
    harness.storage.close();
    fs.rmSync(harness.dir, { recursive: true, force: true });
  }
});

function createHarness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-attachment-agent-tools-"));
  const storage = new TangoStorage(path.join(dir, "tango.sqlite"), { seedExampleRoster: true });
  const harness = {
    dir,
    storage,
    store: new AttachmentStore(storage.getDatabase()),
  };
  harnesses.push(harness);
  return harness;
}

function toolByName(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

function seedReadyAttachment(store: AttachmentStore): SeededAttachment {
  const file = store.upsertFile({
    sha256: "sha256-receipt",
    bytes: 2048,
    contentType: "image/png",
    originalFilename: "receipt.png",
    storagePath: "/tmp/private/tango/attachments/source/sha256-receipt.png",
    metadata: { source: "test" },
  });
  const attachment = store.createAttachment({
    projectId: "project-1",
    agentId: "agent-watson",
    sessionId: "session-1",
    messageId: "local-message-1",
    channelId: "channel-1",
    threadId: "thread-1",
    userId: "user-1",
    discordAttachmentId: "discord-attachment-1",
    fileId: file.id,
    title: "Receipt image",
    originalFilename: "receipt.png",
    contentType: "image/png",
    bytes: 2048,
    metadata: {
      discordMessageId: "discord-message-1",
      storagePath: file.storagePath,
    },
  });
  const text = "Corner Market\nTotal $12.34\nSerial BANANA-77";
  const extraction = store.addExtraction({
    attachmentId: attachment.id,
    method: "apple_vision_ocr",
    text,
    confidence: 0.96,
    quality: { lineCount: 3 },
    metadata: { engine: "apple-vision" },
  });
  const chunk = store.addChunk({
    attachmentId: attachment.id,
    extractionId: extraction.id,
    ordinal: 0,
    text,
    tokenEstimate: 10,
    metadata: { charStart: 0, charEnd: text.length },
  });

  store.addDirectory({
    attachmentId: attachment.id,
    schemaVersion: 1,
    projectId: "project-1",
    agentId: "agent-watson",
    sessionId: "session-1",
    messageId: "local-message-1",
    channelId: "channel-1",
    threadId: "thread-1",
    userId: "user-1",
    status: "ready",
    directory: {
      schema: "attachment_directory_v1",
      schema_version: 1,
      title: "receipt.png",
      status: "ready",
      summary: "Corner Market receipt. Total $12.34.",
      types: ["image/png", "image", "ocr_text"],
      tags: ["receipt", "corner-market", "apple_vision_ocr"],
      source: {
        attachment_id: attachment.id,
        attachment_ref: `attachment:${attachment.id}`,
        file_id: file.id,
        file_ref: `attachment_file:${file.id}`,
        file_sha256: file.sha256,
        discord_message_id: "discord-message-1",
        discord_attachment_id: "discord-attachment-1",
        message_ref: "discord:channel-1:thread-1:discord-message-1",
        refs: [
          `attachment:${attachment.id}`,
          `attachment_file:${file.id}`,
          "discord:channel-1:thread-1:discord-message-1",
        ],
      },
      extraction: {
        extraction_id: extraction.id,
        method: "apple_vision_ocr",
        confidence: 0.96,
        chunk_count: 1,
        source_ref: `extraction:${extraction.id}`,
      },
      content_profile: {
        text_density: "medium",
        visual_density: "low",
      },
      snippets: [
        {
          text: "Total $12.34",
          source_ref: `chunk:${chunk.id}`,
          text_ref: `text:${extraction.id}:chars:14-26`,
          chunk_ref: `chunk:${chunk.id}`,
        },
      ],
      key_facts: [
        {
          label: "total",
          value: "$12.34",
          source_ref: `chunk:${chunk.id}`,
        },
      ],
      notable_quotes: [
        {
          text: "Serial BANANA-77",
          source_ref: `chunk:${chunk.id}`,
        },
      ],
      tables: [],
      visual_notes: [
        {
          text: "Small receipt screenshot with clear text.",
          source_ref: `attachment:${attachment.id}`,
        },
      ],
      chunks: {
        count: 1,
        items: [
          {
            chunk_id: chunk.id,
            ordinal: 0,
            text_preview: "Corner Market Total $12.34",
            source_ref: `text:${extraction.id}:chars:0-${text.length}`,
          },
        ],
      },
      available_reads: ["summary", "directory", "source_file", "extracted_text", "chunks", "quotes"],
      warnings: [],
    },
    metadata: { generatedBy: "test" },
  });
  store.updateAttachmentStatus(attachment.id, "ready");

  return {
    attachmentId: attachment.id,
    extractionId: extraction.id,
    chunkId: chunk.id,
  };
}

function seedFailedAttachment(store: AttachmentStore) {
  const file = store.upsertFile({
    sha256: "sha256-failed",
    bytes: 64,
    contentType: "application/pdf",
    originalFilename: "failed.pdf",
    storagePath: "/tmp/private/tango/attachments/source/sha256-failed.pdf",
  });
  return store.createAttachment({
    projectId: "project-1",
    agentId: "agent-watson",
    sessionId: "session-1",
    channelId: "channel-1",
    userId: "user-1",
    discordAttachmentId: "discord-attachment-failed",
    fileId: file.id,
    originalFilename: "failed.pdf",
    contentType: "application/pdf",
    bytes: 64,
    status: "failed",
  });
}

// T-I-125 Phase 1 — minimal fixture for the enumeration/update/batch tests
// below: an attachment with just enough shape (file, attachment row, one
// directory row carrying `tags`) for attachment_enumerate/attachment_update
// to have something real to read and write. Deliberately skips
// extraction/chunks — those tools never touch them.
function seedTaggedAttachment(
  store: AttachmentStore,
  options: {
    suffix: string;
    projectId?: string | null;
    tags?: string[];
    title?: string;
    contentType?: string;
  },
): number {
  const file = store.upsertFile({
    sha256: `sha256-${options.suffix}`,
    bytes: 100,
    contentType: options.contentType ?? "image/png",
    originalFilename: `${options.suffix}.png`,
    storagePath: `/tmp/private/tango/attachments/source/sha256-${options.suffix}.png`,
  });
  const attachment = store.createAttachment({
    projectId: options.projectId ?? null,
    agentId: "agent-watson",
    discordAttachmentId: `discord-${options.suffix}`,
    fileId: file.id,
    title: options.title ?? `${options.suffix}.png`,
    originalFilename: `${options.suffix}.png`,
    contentType: options.contentType ?? "image/png",
    bytes: 100,
  });
  store.addDirectory({
    attachmentId: attachment.id,
    schemaVersion: 1,
    status: "ready",
    directory: {
      schema: "attachment_directory_v1",
      schema_version: 1,
      title: options.title ?? `${options.suffix}.png`,
      status: "ready",
      summary: "test fixture",
      tags: options.tags ?? [],
    },
  });
  store.updateAttachmentStatus(attachment.id, "ready");
  return attachment.id;
}

describe("attachment agent tools", () => {
  it("uses Claude-compatible top-level JSON schemas", () => {
    const harness = createHarness();
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });

    for (const tool of tools) {
      expect(tool.inputSchema).not.toHaveProperty("anyOf");
      expect(tool.inputSchema).not.toHaveProperty("oneOf");
      expect(tool.inputSchema).not.toHaveProperty("allOf");
    }
  });

  it("searches directory summaries and chunk text without exposing local source paths", async () => {
    const harness = createHarness();
    const seeded = seedReadyAttachment(harness.store);
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const search = toolByName(tools, "attachment_search");

    const totalResult = await search.handler({
      query: "total",
      project_id: "project-1",
      limit: 5,
    }) as {
      result_count: number;
      results: Array<{
        attachment_id: number;
        summary: string;
        source: { attachment_ref: string; message_ref: string };
      }>;
    };

    expect(totalResult.result_count).toBe(1);
    expect(totalResult.results[0]).toMatchObject({
      attachment_id: seeded.attachmentId,
      summary: "Corner Market receipt. Total $12.34.",
      source: {
        attachment_ref: `attachment:${seeded.attachmentId}`,
        message_ref: "discord:channel-1:thread-1:discord-message-1",
      },
    });
    expect(JSON.stringify(totalResult)).not.toContain("/tmp/private");
    expect(JSON.stringify(totalResult)).not.toContain("storagePath");

    const chunkResult = await search.handler({
      query: "BANANA-77",
      project_id: "project-1",
    }) as {
      result_count: number;
      results: Array<{
        matching_chunks: Array<{ chunk_id: number; snippet: string; source_ref: string }>;
      }>;
    };

    expect(chunkResult.result_count).toBe(1);
    expect(chunkResult.results[0]?.matching_chunks[0]).toMatchObject({
      chunk_id: seeded.chunkId,
      snippet: expect.stringContaining("BANANA-77"),
      source_ref: `text:${seeded.extractionId}:chars:0-43`,
    });
  });

  it("reads bounded summaries, chunks, and extracted text with source refs", async () => {
    const harness = createHarness();
    const seeded = seedReadyAttachment(harness.store);
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const read = toolByName(tools, "attachment_read");

    const summary = await read.handler({
      id: `attachment:${seeded.attachmentId}`,
      mode: "summary",
    }) as {
      summary: string;
      source: { attachment_ref: string };
      snippets: Array<{ text: string; text_ref: string }>;
    };
    expect(summary).toMatchObject({
      summary: "Corner Market receipt. Total $12.34.",
      source: { attachment_ref: `attachment:${seeded.attachmentId}` },
    });
    expect(summary.snippets[0]).toMatchObject({
      text: "Total $12.34",
      text_ref: `text:${seeded.extractionId}:chars:14-26`,
    });

    const chunks = await read.handler({
      attachment_id: seeded.attachmentId,
      mode: "chunks",
      query: "serial",
      max_chars: 200,
    }) as {
      result_count: number;
      chunks: Array<{ text: string; source_ref: string; chunk_ref: string }>;
    };
    expect(chunks.result_count).toBe(1);
    expect(chunks.chunks[0]).toMatchObject({
      text: expect.stringContaining("Serial BANANA-77"),
      source_ref: `text:${seeded.extractionId}:chars:0-43`,
      chunk_ref: `chunk:${seeded.chunkId}`,
    });

    const exactText = await read.handler({
      attachment_id: seeded.attachmentId,
      mode: "extracted_text",
      offset: 14,
      max_chars: 5,
    }) as {
      text: string;
      source_ref: string;
      truncated: boolean;
      total_chars: number;
    };
    expect(exactText).toMatchObject({
      text: "Total",
      source_ref: `text:${seeded.extractionId}:chars:14-19`,
      truncated: true,
      total_chars: 43,
    });
  });

  it("reports scoped status counts and recent job summaries", async () => {
    const harness = createHarness();
    const seeded = seedReadyAttachment(harness.store);
    seedFailedAttachment(harness.store);
    harness.store.enqueueJob({ attachmentId: seeded.attachmentId, kind: "directory" });
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const status = toolByName(tools, "attachment_status");

    const result = await status.handler({
      project_id: "project-1",
      limit: 10,
    }) as {
      counts: { total: number; ready: number; failed: number };
      recent: Array<{ attachment_id: number; job_summary: { pending: number } }>;
    };

    expect(result.counts).toMatchObject({
      total: 2,
      ready: 1,
      failed: 1,
    });
    expect(result.recent.find((entry) => entry.attachment_id === seeded.attachmentId)).toMatchObject({
      job_summary: { pending: 1 },
    });
  });

  it("queues reprocessing idempotently for an attachment", async () => {
    const harness = createHarness();
    const seeded = seedReadyAttachment(harness.store);
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const reprocess = toolByName(tools, "attachment_reprocess");

    const queued = await reprocess.handler({
      id: `attachment:${seeded.attachmentId}`,
      strategy: "apple_ocr",
      reason: "test retry",
    }) as {
      queued: boolean;
      job: { job_id: number; kind: string; status: string };
    };
    expect(queued).toMatchObject({
      queued: true,
      job: {
        kind: "apple_ocr",
        status: "pending",
      },
    });
    expect(harness.store.getAttachment(seeded.attachmentId)?.status).toBe("processing");

    const second = await reprocess.handler({
      attachment_id: seeded.attachmentId,
      strategy: "apple_ocr",
    }) as {
      queued: boolean;
      existing_job: { job_id: number; kind: string; status: string };
    };
    expect(second).toMatchObject({
      queued: false,
      existing_job: {
        job_id: queued.job.job_id,
        kind: "apple_ocr",
        status: "pending",
      },
    });
  });

  // T-I-125 Phase 1 — context_hint + batch ids on attachment_reprocess.
  it("threads context_hint into the queued directory job's metadata", async () => {
    const harness = createHarness();
    const seeded = seedReadyAttachment(harness.store);
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const reprocess = toolByName(tools, "attachment_reprocess");

    const queued = await reprocess.handler({
      id: `attachment:${seeded.attachmentId}`,
      strategy: "directory",
      context_hint: "  Westin SFO banquet room  ",
    }) as { queued: boolean; job: { job_id: number } };
    expect(queued.queued).toBe(true);

    const job = harness.store.getJob(queued.job.job_id);
    expect(job?.metadata).toMatchObject({ contextHint: "Westin SFO banquet room" });
  });

  it("refuses a context_hint over the 500-char cap with a clear in-band error naming the cap", async () => {
    const harness = createHarness();
    const seeded = seedReadyAttachment(harness.store);
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const reprocess = toolByName(tools, "attachment_reprocess");

    const overCap = await reprocess.handler({
      id: `attachment:${seeded.attachmentId}`,
      strategy: "apple_ocr",
      context_hint: "x".repeat(501),
    }) as { error?: string };
    expect(overCap.error).toBe(
      "attachment_reprocess context_hint must be 500 characters or fewer (received 501)",
    );
    // Refused before any job was queued or attachment status touched.
    expect(harness.store.listJobs({ attachmentId: seeded.attachmentId, kind: "apple_ocr" })).toEqual([]);
  });

  it("does not touch the job metadata shape when no context_hint is given (single-id path unchanged)", async () => {
    const harness = createHarness();
    const seeded = seedReadyAttachment(harness.store);
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const reprocess = toolByName(tools, "attachment_reprocess");

    const queued = await reprocess.handler({
      id: `attachment:${seeded.attachmentId}`,
      strategy: "apple_ocr",
      reason: "test retry",
    }) as { queued: boolean; job: { job_id: number } };

    const job = harness.store.getJob(queued.job.job_id);
    expect(job?.metadata).toEqual({ queuedBy: "attachment_reprocess_tool", reason: "test retry" });
    expect(job?.metadata).not.toHaveProperty("contextHint");
  });

  it("applies one context_hint to every id in a reprocess batch and enforces the batch id cap", async () => {
    const harness = createHarness();
    const idA = seedTaggedAttachment(harness.store, { suffix: "batch-a" });
    const idB = seedTaggedAttachment(harness.store, { suffix: "batch-b" });
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const reprocess = toolByName(tools, "attachment_reprocess");

    const batch = await reprocess.handler({
      ids: [idA, idB],
      strategy: "directory",
      context_hint: "Traverse Mountain Lodge",
    }) as {
      batch: boolean;
      count: number;
      results: Array<{ attachment_id: number; queued: boolean; job: { job_id: number } }>;
    };

    expect(batch.batch).toBe(true);
    expect(batch.count).toBe(2);
    expect(batch.results.map((r) => r.attachment_id).sort()).toEqual([idA, idB].sort());
    for (const result of batch.results) {
      expect(result.queued).toBe(true);
      const job = harness.store.getJob(result.job.job_id);
      expect(job?.metadata).toMatchObject({ contextHint: "Traverse Mountain Lodge" });
    }

    const distinctOverCapIds = Array.from({ length: 26 }, (_, index) => 9_000 + index);
    const overCap = await reprocess.handler({ ids: distinctOverCapIds, strategy: "directory" }) as {
      error?: string;
    };
    expect(overCap.error).toBe(
      "attachment_reprocess accepts at most 25 ids per call (received 26)",
    );

    // Codex round-1 MEDIUM pin: the cap applies to the RAW submitted array,
    // BEFORE normalization dedupes/discards — a 40-entry array of one
    // repeated valid id (normalizes to length 1) must still refuse, naming
    // the raw length. Closes the unbounded-normalization bypass.
    const seededForDup = seedReadyAttachment(harness.store);
    const duplicateHeavy = Array.from({ length: 40 }, () => seededForDup.attachmentId);
    const rawCap = await reprocess.handler({ ids: duplicateHeavy, strategy: "directory" }) as {
      error?: string;
    };
    expect(rawCap.error).toBe(
      "attachment_reprocess accepts at most 25 ids per call (received 40)",
    );
  });

  // Fleet review consistency fix (T-I-125) — context_hint used to be
  // silently accepted-and-dropped on non-directory strategies, unlike
  // attachment_update's "never silently dropped" stance on fields it can't
  // honor. It now refuses instead.
  it("refuses a context_hint on an explicit non-directory strategy", async () => {
    const harness = createHarness();
    const seeded = seedReadyAttachment(harness.store);
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const reprocess = toolByName(tools, "attachment_reprocess");

    const refused = await reprocess.handler({
      id: `attachment:${seeded.attachmentId}`,
      strategy: "apple_ocr",
      context_hint: "Westin SFO banquet room",
    }) as { error?: string };
    expect(refused.error).toBe(
      "attachment_reprocess context_hint applies only to strategy=directory (received strategy: apple_ocr)",
    );
    // Refused before any job was queued or attachment status touched.
    expect(harness.store.listJobs({ attachmentId: seeded.attachmentId, kind: "apple_ocr" })).toEqual([]);
  });

  it("still accepts a context_hint on an explicit directory strategy", async () => {
    const harness = createHarness();
    const seeded = seedReadyAttachment(harness.store);
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const reprocess = toolByName(tools, "attachment_reprocess");

    const queued = await reprocess.handler({
      id: `attachment:${seeded.attachmentId}`,
      strategy: "directory",
      context_hint: "Westin SFO banquet room",
    }) as { queued: boolean; job: { job_id: number } };
    expect(queued.queued).toBe(true);
    const job = harness.store.getJob(queued.job.job_id);
    expect(job?.metadata).toMatchObject({ contextHint: "Westin SFO banquet room" });
  });

  it("refuses a context_hint with strategy omitted — the default resolves to classify, not directory", async () => {
    const harness = createHarness();
    const seeded = seedReadyAttachment(harness.store);
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const reprocess = toolByName(tools, "attachment_reprocess");

    const refused = await reprocess.handler({
      id: `attachment:${seeded.attachmentId}`,
      context_hint: "Westin SFO banquet room",
    }) as { error?: string };
    expect(refused.error).toBe(
      "attachment_reprocess context_hint applies only to strategy=directory (received strategy: classify)",
    );
    expect(harness.store.listJobs({ attachmentId: seeded.attachmentId, kind: "classify" })).toEqual([]);
  });

  it("does not refuse a blank/whitespace-only context_hint on a non-directory strategy (blank = absent)", async () => {
    const harness = createHarness();
    const seeded = seedReadyAttachment(harness.store);
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const reprocess = toolByName(tools, "attachment_reprocess");

    const queued = await reprocess.handler({
      id: `attachment:${seeded.attachmentId}`,
      strategy: "apple_ocr",
      context_hint: "   ",
    }) as { queued: boolean; job: { job_id: number } };
    expect(queued.queued).toBe(true);
    const job = harness.store.getJob(queued.job.job_id);
    expect(job?.metadata).not.toHaveProperty("contextHint");
  });
});

// T-I-125 Phase 1 — attachment_update (v0, real columns only: title and
// project_id).
describe("attachment_update", () => {
  it("updates title only, project only, and both, leaving every other column untouched", async () => {
    const harness = createHarness();
    const seeded = seedReadyAttachment(harness.store);
    const before = harness.store.getAttachment(seeded.attachmentId)!;
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const update = toolByName(tools, "attachment_update");

    const titleOnly = await update.handler({
      id: `attachment:${seeded.attachmentId}`,
      title: "Westin Banquet Room",
    }) as { attachment_id: number; updated: boolean; title: string | null; project_id: string | null };
    expect(titleOnly).toMatchObject({
      attachment_id: seeded.attachmentId,
      updated: true,
      title: "Westin Banquet Room",
    });
    const afterTitle = harness.store.getAttachment(seeded.attachmentId)!;
    expect(afterTitle.title).toBe("Westin Banquet Room");
    expect(afterTitle.projectId).toBe(before.projectId);

    const projectOnly = await update.handler({
      attachment_id: seeded.attachmentId,
      project: "creator-conference",
    }) as { project_id: string | null };
    expect(projectOnly.project_id).toBe("creator-conference");
    const afterProject = harness.store.getAttachment(seeded.attachmentId)!;
    expect(afterProject.title).toBe("Westin Banquet Room");
    expect(afterProject.projectId).toBe("creator-conference");

    const both = await update.handler({
      id: `attachment:${seeded.attachmentId}`,
      title: "Final Title",
      project: "final-project",
    }) as { title: string | null; project_id: string | null };
    expect(both).toMatchObject({ title: "Final Title", project_id: "final-project" });

    const afterBoth = harness.store.getAttachment(seeded.attachmentId)!;
    expect(afterBoth.title).toBe("Final Title");
    expect(afterBoth.projectId).toBe("final-project");
    expect(afterBoth.contentType).toBe(before.contentType);
    expect(afterBoth.bytes).toBe(before.bytes);
    expect(afterBoth.status).toBe(before.status);
    expect(afterBoth.originalFilename).toBe(before.originalFilename);
    expect(afterBoth.discordAttachmentId).toBe(before.discordAttachmentId);
    expect(afterBoth.createdAt).toBe(before.createdAt);
    expect(afterBoth.metadata).toEqual(before.metadata);
  });

  it("applies the same title/project to a batch of ids", async () => {
    const harness = createHarness();
    const idA = seedTaggedAttachment(harness.store, { suffix: "up-a" });
    const idB = seedTaggedAttachment(harness.store, { suffix: "up-b" });
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const update = toolByName(tools, "attachment_update");

    const batch = await update.handler({ ids: [idA, idB], project: "creator-conference" }) as {
      batch: boolean;
      count: number;
      results: Array<{ attachment_id: number; updated: boolean; project_id: string }>;
    };
    expect(batch.batch).toBe(true);
    expect(batch.count).toBe(2);
    expect(harness.store.getAttachment(idA)?.projectId).toBe("creator-conference");
    expect(harness.store.getAttachment(idB)?.projectId).toBe("creator-conference");

    const distinctOverCapIds = Array.from({ length: 26 }, (_, index) => 9_100 + index);
    const overCap = await update.handler({ ids: distinctOverCapIds, title: "x" }) as { error?: string };

    // Codex round-1 MEDIUM pin, update-side twin: raw-array cap before
    // normalization (see the reprocess test for the class rationale).
    const dupSeed = seedReadyAttachment(harness.store);
    const duplicateHeavy = Array.from({ length: 40 }, () => dupSeed.attachmentId);
    const rawCap = await update.handler({ ids: duplicateHeavy, title: "x" }) as { error?: string };
    expect(rawCap.error).toBe(
      "attachment_update accepts at most 25 ids per call (received 40)",
    );
    expect(overCap.error).toBe("attachment_update accepts at most 25 ids per call (received 26)");
  });

  it("refuses an unknown field with the exact v0 gating message, never silently dropping it", async () => {
    const harness = createHarness();
    const seeded = seedReadyAttachment(harness.store);
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const update = toolByName(tools, "attachment_update");

    const result = await update.handler({
      id: `attachment:${seeded.attachmentId}`,
      description: "a new description",
    }) as { error?: string };
    expect(result.error).toBe(
      "attachment_update v0 edits title and project only; description/tags/roles are gated on the upstream design conversation (T-I-125)",
    );
    // Confirm the field genuinely did not land anywhere.
    expect(JSON.stringify(harness.store.getAttachment(seeded.attachmentId))).not.toContain(
      "a new description",
    );
  });

  it("refuses a malformed id and a well-formed but unregistered id", async () => {
    const harness = createHarness();
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const update = toolByName(tools, "attachment_update");

    const malformed = await update.handler({ id: "not-an-id", title: "x" }) as { error?: string };
    expect(malformed.error).toBe("attachment_update requires id, attachment_id, or ids");

    const unregistered = await update.handler({ attachment_id: 999_999, title: "x" }) as { error?: string };
    expect(unregistered.error).toBe("Attachment 999999 not found");
  });

  it("requires at least title or project", async () => {
    const harness = createHarness();
    const seeded = seedReadyAttachment(harness.store);
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const update = toolByName(tools, "attachment_update");

    const result = await update.handler({ id: `attachment:${seeded.attachmentId}` }) as { error?: string };
    expect(result.error).toBe("attachment_update requires title and/or project");
  });
});

// T-I-125 Phase 1 — the store method attachment_update calls: real columns
// only.
describe("AttachmentStore.updateAttachmentOperatorFields", () => {
  it("touches only title, project_id, and updated_at", () => {
    const harness = createHarness();
    const seeded = seedReadyAttachment(harness.store);
    const before = harness.store.getAttachment(seeded.attachmentId)!;

    const after = harness.store.updateAttachmentOperatorFields(seeded.attachmentId, {
      title: "New Title",
    });

    expect(after?.title).toBe("New Title");
    expect(after?.projectId).toBe(before.projectId);
    expect(after?.contentType).toBe(before.contentType);
    expect(after?.bytes).toBe(before.bytes);
    expect(after?.status).toBe(before.status);
    expect(after?.originalFilename).toBe(before.originalFilename);
    expect(after?.discordAttachmentId).toBe(before.discordAttachmentId);
    expect(after?.metadata).toEqual(before.metadata);
    expect(after?.createdAt).toBe(before.createdAt);
  });
});

// T-I-125 Phase 1 — attachment_enumerate: exhaustive-by-label enumeration,
// never ranked/similarity search.
describe("attachment_enumerate", () => {
  it("list_projects returns distinct project ids with counts, and empty results are honest", async () => {
    const harness = createHarness();
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const enumerate = toolByName(tools, "attachment_enumerate");

    const empty = await enumerate.handler({ mode: "list_projects" });
    expect(empty).toEqual({ mode: "list_projects", total: 0, projects: [] });

    seedTaggedAttachment(harness.store, { suffix: "p1-a", projectId: "creator-conference" });
    seedTaggedAttachment(harness.store, { suffix: "p1-b", projectId: "creator-conference" });
    seedTaggedAttachment(harness.store, { suffix: "p2-a", projectId: "payroll-401k" });
    seedTaggedAttachment(harness.store, { suffix: "no-project" });

    const result = await enumerate.handler({ mode: "list_projects" }) as {
      total: number;
      projects: Array<{ project_id: string; count: number }>;
    };
    expect(result.total).toBe(2);
    expect(result.projects).toEqual([
      { project_id: "creator-conference", count: 2 },
      { project_id: "payroll-401k", count: 1 },
    ]);
  });

  it("list_tags is case-insensitive, counts correctly, and can be scoped to a project", async () => {
    const harness = createHarness();
    seedTaggedAttachment(harness.store, {
      suffix: "t1",
      projectId: "creator-conference",
      tags: ["Westin", "banquet"],
    });
    seedTaggedAttachment(harness.store, {
      suffix: "t2",
      projectId: "creator-conference",
      tags: ["westin", "lobby"],
    });
    seedTaggedAttachment(harness.store, { suffix: "t3", projectId: "other-project", tags: ["westin"] });
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const enumerate = toolByName(tools, "attachment_enumerate");

    const all = await enumerate.handler({ mode: "list_tags" }) as {
      total: number;
      tags: Array<{ tag: string; count: number }>;
    };
    const westinAll = all.tags.find((entry) => entry.tag.toLowerCase() === "westin");
    expect(westinAll?.count).toBe(3);

    const scoped = await enumerate.handler({ mode: "list_tags", project_id: "creator-conference" }) as {
      total: number;
      tags: Array<{ tag: string; count: number }>;
    };
    expect(scoped.total).toBe(3);
    const westinScoped = scoped.tags.find((entry) => entry.tag.toLowerCase() === "westin");
    expect(westinScoped?.count).toBe(2);
  });

  it("by_label enumerates ALL matches with an exact total that holds across a page boundary", async () => {
    const harness = createHarness();
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const enumerate = toolByName(tools, "attachment_enumerate");

    const total = 62;
    for (let index = 0; index < total; index += 1) {
      seedTaggedAttachment(harness.store, {
        suffix: `lodge-${index}`,
        projectId: "creator-conference",
        tags: ["traverse-mountain-lodge"],
      });
    }
    // Distractor fixture — must never leak into the count.
    seedTaggedAttachment(harness.store, {
      suffix: "not-lodge",
      projectId: "creator-conference",
      tags: ["hyatt"],
    });

    const firstPage = await enumerate.handler({
      mode: "by_label",
      tag: "TRAVERSE-MOUNTAIN-LODGE",
      project_id: "creator-conference",
    }) as { total: number; result_count: number; limit: number; offset: number; items: unknown[] };
    expect(firstPage.total).toBe(total);
    expect(firstPage.limit).toBe(50);
    expect(firstPage.offset).toBe(0);
    expect(firstPage.result_count).toBe(50);

    const secondPage = await enumerate.handler({
      mode: "by_label",
      tag: "traverse-mountain-lodge",
      project_id: "creator-conference",
      offset: 50,
    }) as { total: number; result_count: number };
    expect(secondPage.total).toBe(total);
    expect(secondPage.result_count).toBe(total - 50);

    const noMatch = await enumerate.handler({ mode: "by_label", tag: "no-such-tag" }) as {
      total: number;
      items: unknown[];
    };
    expect(noMatch).toMatchObject({ total: 0, items: [] });
  });

  // Review-round fix: a hint-derived tag is whitespace-collapsed
  // (normalizeComparable) when it's stored, but by_label's query was only
  // ever lowercased — a query with doubled internal spaces could never
  // match its own stored tag. Align the query-side normalization.
  it("by_label matches a stored tag when the query has doubled internal whitespace", async () => {
    const harness = createHarness();
    const attachmentId = seedTaggedAttachment(harness.store, {
      suffix: "lodge-normalize",
      projectId: "creator-conference",
      tags: ["traverse mountain lodge"],
    });
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const enumerate = toolByName(tools, "attachment_enumerate");

    const result = await enumerate.handler({
      mode: "by_label",
      tag: "Traverse  Mountain   Lodge",
    }) as { total: number; items: Array<{ attachment_id: number }> };

    expect(result.total).toBe(1);
    expect(result.items[0]?.attachment_id).toBe(attachmentId);
  });

  it("by_label requires tag and/or project_id", async () => {
    const harness = createHarness();
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const enumerate = toolByName(tools, "attachment_enumerate");

    const result = await enumerate.handler({ mode: "by_label" }) as { error?: string };
    expect(result.error).toBe("attachment_enumerate mode=by_label requires tag and/or project_id");
  });

  it("refuses an unknown/missing mode", async () => {
    const harness = createHarness();
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const enumerate = toolByName(tools, "attachment_enumerate");

    const result = await enumerate.handler({}) as { error?: string };
    expect(result.error).toBe("attachment_enumerate requires mode: list_projects, list_tags, or by_label");
  });
});

// Review-round fix: attachment_update writes attachments.title, but every
// read surface renders titles through titleForAttachment, which used to
// prefer the directory record's title — baked at directory-build time —
// over the live attachment title. A rename would land in the database and
// simply never show up anywhere. These tests pin the fixed precedence
// (live attachment.title first, directory title only as fallback) across
// two independent read tools, and the whitespace-only-title edge that a
// naive fix would still get wrong.
describe("attachment_update title visibility across read surfaces", () => {
  it("a title change is immediately visible via attachment_search and attachment_enumerate by_label, even though the directory record still carries the old title", async () => {
    const harness = createHarness();
    const attachmentId = seedTaggedAttachment(harness.store, {
      suffix: "cross-tool",
      projectId: "creator-conference",
      tags: ["cross-tool-check"],
      title: "Original Title",
    });
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const update = toolByName(tools, "attachment_update");
    const search = toolByName(tools, "attachment_search");
    const enumerate = toolByName(tools, "attachment_enumerate");

    const updateResult = await update.handler({
      id: `attachment:${attachmentId}`,
      title: "Renamed Title",
    }) as { title: string | null };
    expect(updateResult.title).toBe("Renamed Title");

    // The trap: the directory record is never rewritten by attachment_update
    // and must still carry the stale title.
    const directoryRecord = harness.store.listDirectories(attachmentId).at(-1);
    expect((directoryRecord?.directory as { title?: string })?.title).toBe("Original Title");

    const searchResult = await search.handler({
      query: "Renamed",
      project_id: "creator-conference",
    }) as { result_count: number; results: Array<{ attachment_id: number; title: string }> };
    expect(searchResult.result_count).toBe(1);
    expect(searchResult.results[0]).toMatchObject({
      attachment_id: attachmentId,
      title: "Renamed Title",
    });

    const enumerateResult = await enumerate.handler({
      mode: "by_label",
      tag: "cross-tool-check",
    }) as { items: Array<{ attachment_id: number; title: string }> };
    expect(enumerateResult.items).toHaveLength(1);
    expect(enumerateResult.items[0]).toMatchObject({
      attachment_id: attachmentId,
      title: "Renamed Title",
    });
  });

  it("coerces a whitespace-only title/project update to null, never an empty string, and reads fall back to the directory title", async () => {
    const harness = createHarness();
    const attachmentId = seedTaggedAttachment(harness.store, {
      suffix: "blank-title",
      projectId: "creator-conference",
      tags: ["blank-title-check"],
      title: "Original Title",
    });
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const update = toolByName(tools, "attachment_update");
    const search = toolByName(tools, "attachment_search");

    const updateResult = await update.handler({
      id: `attachment:${attachmentId}`,
      title: "   ",
      project: "   ",
    }) as { title: string | null; project_id: string | null };
    expect(updateResult.title).toBeNull();
    expect(updateResult.project_id).toBeNull();

    const stored = harness.store.getAttachment(attachmentId)!;
    expect(stored.title).toBeNull();
    expect(stored.projectId).toBeNull();

    // titleForAttachment must skip the now-null attachment.title and fall
    // back to the (still non-empty) directory title, not render a blank.
    const searchResult = await search.handler({ query: "Original" }) as {
      result_count: number;
      results: Array<{ attachment_id: number; title: string }>;
    };
    expect(searchResult.result_count).toBe(1);
    expect(searchResult.results[0]).toMatchObject({
      attachment_id: attachmentId,
      title: "Original Title",
    });
  });
});
