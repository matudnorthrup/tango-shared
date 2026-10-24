import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APPLE_VISION_OCR_METHOD } from "../src/apple-vision-ocr.js";
import { ATTACHMENT_DIRECTORY_SCHEMA } from "../src/attachment-directory.js";
import {
  LLM_VISION_FALLBACK_METHOD,
  buildAttachmentLlmFallbackResultFromProviderOutput,
} from "../src/attachment-llm-fallback.js";
import { createAttachmentProcessingHandlers } from "../src/attachment-processing.js";
import { AttachmentJobWorker } from "../src/attachment-worker.js";
import { AttachmentStore, type AttachmentRecord } from "../src/attachments-store.js";
import { TangoStorage } from "../src/storage.js";

interface Harness {
  dir: string;
  storage: TangoStorage;
  store: AttachmentStore;
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-attachment-processing-"));
  const storage = new TangoStorage(path.join(dir, "tango.sqlite"), { seedExampleRoster: true });
  const harness = {
    dir,
    storage,
    store: new AttachmentStore(storage.getDatabase()),
  };
  harnesses.push(harness);
  return harness;
}

function createAttachment(input: {
  harness: Harness;
  filename: string;
  contentType: string;
  bytes: Buffer;
  metadata?: Record<string, unknown>;
}) {
  const filePath = path.join(input.harness.dir, input.filename);
  fs.writeFileSync(filePath, input.bytes);
  const file = input.harness.store.upsertFile({
    sha256: `${input.filename}-sha`,
    bytes: input.bytes.byteLength,
    contentType: input.contentType,
    originalFilename: input.filename,
    storagePath: filePath,
  });

  return input.harness.store.createAttachment({
    sessionId: "session-1",
    agentId: "agent-watson",
    messageId: "message-1",
    channelId: "channel-1",
    discordAttachmentId: `${input.filename}-discord`,
    fileId: file.id,
    title: input.filename,
    originalFilename: input.filename,
    contentType: input.contentType,
    bytes: input.bytes.byteLength,
    metadata: input.metadata,
  });
}

async function drainUntilIdle(worker: AttachmentJobWorker, maxDrains = 20): Promise<void> {
  for (let index = 0; index < maxDrains; index += 1) {
    const result = await worker.drainOnce();
    if (result.status === "idle") return;
  }
  throw new Error(`Attachment worker did not become idle within ${maxDrains} drains`);
}

function latestDirectory(harness: Harness, attachment: AttachmentRecord): Record<string, unknown> {
  const directory = harness.store.listDirectories(attachment.id).at(-1)?.directory;
  expect(directory).toBeTruthy();
  return directory as Record<string, unknown>;
}

describe("createAttachmentProcessingHandlers", () => {
  it("classifies and processes text attachments into extractions, chunks, and directories", async () => {
    const harness = createHarness();
    const attachment = createAttachment({
      harness,
      filename: "notes.txt",
      contentType: "text/plain",
      metadata: { discordMessageId: "discord-message-1" },
      bytes: Buffer.from(
        [
          "# Project Plan",
          "Owner: User",
          "Total $12.34",
          "",
          "Item,Qty,Price",
          "Pen,2,$3.00",
          "Notebook,1,$9.34",
          "",
          "Next action: approve order",
        ].join("\n"),
        "utf8",
      ),
    });
    harness.store.enqueueJob({ attachmentId: attachment.id, kind: "classify" });

    const worker = new AttachmentJobWorker(
      harness.store,
      "attachment-processing-test",
      createAttachmentProcessingHandlers(),
    );

    await drainUntilIdle(worker);

    expect(harness.store.getAttachment(attachment.id)?.status).toBe("ready");
    expect(harness.store.listJobs({ attachmentId: attachment.id }).map((job) => job.kind).sort()).toEqual([
      "chunk",
      "classify",
      "directory",
      "embedded_text",
    ]);
    expect(harness.store.listExtractions(attachment.id)).toHaveLength(1);
    expect(harness.store.listExtractions(attachment.id)[0]).toMatchObject({
      method: "utf8_text",
      text: expect.stringContaining("Owner: User"),
    });
    expect(harness.store.listChunks(attachment.id).length).toBeGreaterThan(0);

    const directory = latestDirectory(harness, attachment);
    expect(directory).toMatchObject({
      schema: ATTACHMENT_DIRECTORY_SCHEMA,
      schema_version: 1,
      status: "ready",
      title: "notes.txt",
      source: {
        attachment_ref: `attachment:${attachment.id}`,
        file_sha256: "notes.txt-sha",
        message_ref: "discord:channel-1:discord-message-1",
        local_message_id: "message-1",
        discord_message_id: "discord-message-1",
      },
      extraction: {
        method: "utf8_text",
        chunk_count: expect.any(Number),
      },
    });
    expect(directory).not.toHaveProperty("text");
    expect(directory).not.toHaveProperty("storage_path");
    expect(directory.available_reads).toEqual(
      expect.arrayContaining(["summary", "directory", "chunks", "quotes", "tables", "source_file"]),
    );
    expect(directory.key_facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "Owner: User",
          source_ref: expect.stringMatching(/^text:\d+:chars:\d+-\d+$/u),
          chunk_ref: expect.stringMatching(/^chunk:\d+$/u),
        }),
      ]),
    );
    expect(directory.tables).toEqual([
      expect.objectContaining({
        row_count: 3,
        column_count: 3,
        rows_preview: [
          ["Item", "Qty", "Price"],
          ["Pen", "2", "$3.00"],
          ["Notebook", "1", "$9.34"],
        ],
      }),
    ]);
    expect(directory.snippets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "Owner: User",
          source_ref: expect.stringMatching(/^chunk:\d+$/u),
          text_ref: expect.stringMatching(/^text:\d+:chars:\d+-\d+$/u),
        }),
      ]),
    );
  });

  it("routes image attachments through Apple OCR before chunking and directory generation", async () => {
    const harness = createHarness();
    const attachment = createAttachment({
      harness,
      filename: "receipt.png",
      contentType: "image/png",
      bytes: Buffer.from("fake image bytes", "utf8"),
    });
    harness.store.enqueueJob({ attachmentId: attachment.id, kind: "classify" });

    const worker = new AttachmentJobWorker(
      harness.store,
      "attachment-processing-ocr-test",
      createAttachmentProcessingHandlers({
        runOcr: async () => ({
          method: APPLE_VISION_OCR_METHOD,
          text: "Corner Market\nTotal $12.34",
          lines: [],
          confidence: 0.95,
          aggregateConfidence: 0.95,
          warnings: [],
          quality: {
            empty: false,
            lowConfidence: false,
            lineCount: 2,
            textLength: 27,
            aggregateConfidence: 0.95,
            minimumConfidence: 0.6,
            warningCount: 0,
            escalationRecommended: false,
            escalationReason: "none",
          },
          metadata: {
            engine: "apple_vision",
            framework: "Vision",
            request: "VNRecognizeTextRequest",
            helperVersion: 1,
            platform: "darwin",
            swiftCommand: "swift",
            swiftAvailable: true,
            recognitionLevel: "accurate",
            recognitionLanguages: [],
            usesLanguageCorrection: true,
            minimumTextHeight: null,
            durationMs: 1,
            source: { imagePath: "receipt.png" },
          },
          escalation: {
            recommended: false,
            reason: "none",
            targetMethod: null,
          },
          available: true,
        }),
      }),
    );

    await drainUntilIdle(worker);

    expect(harness.store.getAttachment(attachment.id)?.status).toBe("ready");
    expect(harness.store.listExtractions(attachment.id)[0]).toMatchObject({
      method: APPLE_VISION_OCR_METHOD,
      text: "Corner Market\nTotal $12.34",
      confidence: 0.95,
    });
    expect(harness.store.listJobs({ attachmentId: attachment.id }).map((job) => job.kind).sort()).toEqual([
      "apple_ocr",
      "chunk",
      "classify",
      "directory",
    ]);

    const directory = latestDirectory(harness, attachment);
    expect(directory).toMatchObject({
      schema: ATTACHMENT_DIRECTORY_SCHEMA,
      status: "ready",
      title: "receipt.png",
      extraction: {
        method: APPLE_VISION_OCR_METHOD,
        confidence: 0.95,
      },
    });
    expect(directory.types).toEqual(
      expect.arrayContaining(["image/png", "image", "ocr_text"]),
    );
    expect(directory.visual_notes).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("Image processed with apple_vision_ocr"),
        source_ref: expect.stringMatching(/^extraction:\d+$/u),
      }),
    ]);
    expect(directory.snippets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "Total $12.34",
          source_ref: expect.stringMatching(/^chunk:\d+$/u),
        }),
      ]),
    );
  });

  it("keeps long directory payloads bounded and source-linked instead of storing full text", async () => {
    const harness = createHarness();
    const lines = Array.from(
      { length: 160 },
      (_, index) => `Line ${String(index).padStart(3, "0")} status: value ${index}`,
    );
    lines.push("UNIQUE_FINAL_SENTINEL should remain in extracted text only");
    const attachment = createAttachment({
      harness,
      filename: "long-notes.txt",
      contentType: "text/plain",
      bytes: Buffer.from(lines.join("\n"), "utf8"),
    });
    harness.store.enqueueJob({ attachmentId: attachment.id, kind: "classify" });

    const worker = new AttachmentJobWorker(
      harness.store,
      "attachment-processing-long-directory-test",
      createAttachmentProcessingHandlers({
        chunkMaxTokens: 20,
        chunkOverlapTokens: 0,
      }),
    );

    await drainUntilIdle(worker, 80);

    const chunks = harness.store.listChunks(attachment.id);
    const directory = latestDirectory(harness, attachment);
    expect(chunks.length).toBeGreaterThan(8);
    expect((directory.chunks as { items: unknown[] }).items).toHaveLength(8);
    expect(JSON.stringify(directory)).not.toContain("UNIQUE_FINAL_SENTINEL");
    expect(directory.snippets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_ref: expect.stringMatching(/^chunk:\d+$/u),
          text_ref: expect.stringMatching(/^text:\d+:chars:\d+-\d+$/u),
        }),
      ]),
    );
  });

  it("writes a partial directory when OCR returns no usable text", async () => {
    const harness = createHarness();
    const attachment = createAttachment({
      harness,
      filename: "blank.png",
      contentType: "image/png",
      bytes: Buffer.from("fake blank image bytes", "utf8"),
    });
    harness.store.enqueueJob({ attachmentId: attachment.id, kind: "classify" });

    const worker = new AttachmentJobWorker(
      harness.store,
      "attachment-processing-empty-ocr-test",
      createAttachmentProcessingHandlers({
        runOcr: async () => ({
          method: APPLE_VISION_OCR_METHOD,
          text: "",
          lines: [],
          confidence: 0,
          aggregateConfidence: 0,
          warnings: ["no_text_detected"],
          quality: {
            empty: true,
            lowConfidence: true,
            lineCount: 0,
            textLength: 0,
            aggregateConfidence: 0,
            minimumConfidence: 0.6,
            warningCount: 1,
            escalationRecommended: true,
            escalationReason: "no_text",
          },
          metadata: {
            engine: "apple_vision",
            framework: "Vision",
            request: "VNRecognizeTextRequest",
            helperVersion: 1,
            platform: "darwin",
            swiftCommand: "swift",
            swiftAvailable: true,
            recognitionLevel: "accurate",
            recognitionLanguages: [],
            usesLanguageCorrection: true,
            minimumTextHeight: null,
            durationMs: 1,
            source: { imagePath: "blank.png" },
          },
          escalation: {
            recommended: true,
            reason: "no_text",
            targetMethod: "llm_vision",
          },
          available: true,
        }),
      }),
    );

    await drainUntilIdle(worker);

    expect(harness.store.getAttachment(attachment.id)?.status).toBe("partial");
    expect(harness.store.listChunks(attachment.id)).toHaveLength(0);
    const directory = latestDirectory(harness, attachment);
    expect(directory).toMatchObject({
      schema: ATTACHMENT_DIRECTORY_SCHEMA,
      status: "partial",
      summary: "Attachment was stored, but no usable text has been extracted yet.",
      warnings: expect.arrayContaining(["no_text_detected", "no_extracted_text"]),
    });
    expect(directory.available_reads).toEqual(["summary", "directory", "source_file", "ocr_lines"]);
    expect(directory.visual_notes).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("0 text lines detected"),
        source_ref: expect.stringMatching(/^extraction:\d+$/u),
      }),
    ]);
  });

  it("escalates empty OCR to LLM fallback when a fallback runner is configured", async () => {
    const harness = createHarness();
    const attachment = createAttachment({
      harness,
      filename: "hard-screenshot.png",
      contentType: "image/png",
      bytes: Buffer.from("fake difficult image bytes", "utf8"),
    });
    harness.store.enqueueJob({ attachmentId: attachment.id, kind: "classify" });

    const worker = new AttachmentJobWorker(
      harness.store,
      "attachment-processing-llm-fallback-test",
      createAttachmentProcessingHandlers({
        runOcr: async () => ({
          method: APPLE_VISION_OCR_METHOD,
          text: "",
          lines: [],
          confidence: 0,
          aggregateConfidence: 0,
          warnings: ["no_text_detected"],
          quality: {
            empty: true,
            lowConfidence: true,
            lineCount: 0,
            textLength: 0,
            aggregateConfidence: 0,
            minimumConfidence: 0.6,
            warningCount: 1,
            escalationRecommended: true,
            escalationReason: "empty",
          },
          metadata: {
            engine: "apple_vision",
            framework: "Vision",
            request: "VNRecognizeTextRequest",
            helperVersion: 1,
            platform: "darwin",
            swiftCommand: "swift",
            swiftAvailable: true,
            recognitionLevel: "accurate",
            recognitionLanguages: [],
            usesLanguageCorrection: true,
            minimumTextHeight: null,
            durationMs: 1,
            source: { imagePath: "hard-screenshot.png" },
          },
          escalation: {
            recommended: true,
            reason: "empty",
            targetMethod: "llm_fallback",
          },
          available: true,
        }),
        runLlmFallback: async (input) => {
          expect(input.reason).toBe("empty");
          expect(input.previousExtraction?.method).toBe(APPLE_VISION_OCR_METHOD);
          expect(input.filePath).toContain("hard-screenshot.png");
          return buildAttachmentLlmFallbackResultFromProviderOutput(
            JSON.stringify({
              summary: "Screenshot of a whiteboard planning diagram.",
              extracted_text: "Launch plan\nOwner: User\nDecision: use compact directories",
              key_facts: [
                {
                  text: "Owner: User",
                  source_ref: `attachment:${input.attachment.id}`,
                },
                {
                  text: "Decision: use compact directories",
                  source_ref: `attachment:${input.attachment.id}`,
                },
              ],
              visual_notes: [
                "The image is a diagram-like screenshot, not a plain text document.",
              ],
              confidence: 0.82,
              warnings: ["llm_visual_reasoning_used"],
            }),
            {
              metadata: {
                providerName: "test-provider",
                model: "test-vision-model",
                totalCostUsd: 0.01,
              },
            },
          );
        },
      }),
    );

    await drainUntilIdle(worker, 40);

    expect(harness.store.getAttachment(attachment.id)?.status).toBe("ready");
    expect(harness.store.listJobs({ attachmentId: attachment.id }).map((job) => job.kind).sort()).toEqual([
      "apple_ocr",
      "chunk",
      "classify",
      "directory",
      "llm_fallback",
    ]);

    const extractions = harness.store.listExtractions(attachment.id);
    expect(extractions).toHaveLength(2);
    expect(extractions[0]).toMatchObject({
      method: APPLE_VISION_OCR_METHOD,
      text: "",
    });
    expect(extractions[1]).toMatchObject({
      method: LLM_VISION_FALLBACK_METHOD,
      text: expect.stringContaining("Owner: User"),
      confidence: 0.82,
      metadata: expect.objectContaining({
        fallbackReason: "empty",
        previousExtractionId: extractions[0].id,
        providerName: "test-provider",
        model: "test-vision-model",
        structuredOutput: expect.objectContaining({
          summary: "Screenshot of a whiteboard planning diagram.",
        }),
      }),
    });
    expect(harness.store.listChunks(attachment.id).length).toBeGreaterThan(0);

    const directory = latestDirectory(harness, attachment);
    expect(directory).toMatchObject({
      schema: ATTACHMENT_DIRECTORY_SCHEMA,
      status: "ready",
      title: "hard-screenshot.png",
      extraction: {
        method: LLM_VISION_FALLBACK_METHOD,
        confidence: 0.82,
      },
    });
    expect(directory.summary).toContain("Screenshot of a whiteboard planning diagram");
    expect(directory.types).toEqual(
      expect.arrayContaining(["image/png", "image"]),
    );
    expect(directory.key_facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("Owner: User"),
          source_ref: expect.stringMatching(/^text:\d+:chars:\d+-\d+$/u),
        }),
      ]),
    );
  });

  it("records unsupported attachments for retention review without failing the worker", async () => {
    const harness = createHarness();
    const attachment = createAttachment({
      harness,
      filename: "archive.zip",
      contentType: "application/zip",
      bytes: Buffer.from("zip bytes", "utf8"),
    });
    harness.store.enqueueJob({ attachmentId: attachment.id, kind: "classify" });

    const worker = new AttachmentJobWorker(
      harness.store,
      "attachment-processing-review-test",
      createAttachmentProcessingHandlers(),
    );

    await drainUntilIdle(worker);

    expect(harness.store.getAttachment(attachment.id)?.status).toBe("partial");
    expect(harness.store.listJobs({ attachmentId: attachment.id }).map((job) => job.kind).sort()).toEqual([
      "classify",
      "retention_review",
    ]);
    expect(harness.store.listRetentionDecisions(attachment.id)[0]).toMatchObject({
      decision: "review",
      status: "proposed",
    });
  });
});

// T-I-125 Phase 1 — end-to-end context_hint threading: attachment_reprocess
// (packages/discord) writes contextHint onto the `directory` job's own
// metadata; createDirectoryHandler here must read it back and pass it to
// buildAttachmentDirectory. This proves the JOB-METADATA leg of that path
// (the tool-layer leg — cap enforcement, batch ids — is covered in
// packages/discord/test/attachment-agent-tools.test.ts; the pure-builder
// leg is covered in attachment-directory.test.ts).
describe("createDirectoryHandler — T-I-125 Phase 1 context_hint threading", () => {
  it("a directory job with no contextHint in metadata produces a payload byte-identical to before (no hint fields)", async () => {
    const harness = createHarness();
    const attachment = createAttachment({
      harness,
      filename: "notes.txt",
      contentType: "text/plain",
      bytes: Buffer.from("Owner: User\nTotal $12.34", "utf8"),
    });
    harness.store.addExtraction({
      attachmentId: attachment.id,
      method: "utf8_text",
      text: "Owner: User\nTotal $12.34",
      confidence: 0.9,
    });
    harness.store.enqueueJob({
      attachmentId: attachment.id,
      kind: "directory",
      metadata: { queuedByJobId: 0, reason: "extraction_text_available" },
    });

    const worker = new AttachmentJobWorker(
      harness.store,
      "attachment-processing-hint-test",
      createAttachmentProcessingHandlers(),
    );
    await drainUntilIdle(worker);

    const directory = latestDirectory(harness, attachment);
    expect(directory).not.toHaveProperty("context_hint");
    expect(directory).not.toHaveProperty("hint_guided");
    expect(JSON.stringify(directory)).not.toContain("hint_guided");
  });

  it("a directory job carrying job.metadata.contextHint threads it into summary, tags, and provenance", async () => {
    const harness = createHarness();
    const attachment = createAttachment({
      harness,
      filename: "IMG_0002.png",
      contentType: "image/png",
      bytes: Buffer.from("fake-image-bytes", "utf8"),
    });
    // Signage-less photo: no extraction at all (the founding use case —
    // Piper's Westin banquet room, generic-description-only).
    harness.store.enqueueJob({
      attachmentId: attachment.id,
      kind: "directory",
      metadata: { queuedByJobId: 0, contextHint: "Westin SFO banquet room" },
    });

    const worker = new AttachmentJobWorker(
      harness.store,
      "attachment-processing-hint-test-2",
      createAttachmentProcessingHandlers(),
    );
    await drainUntilIdle(worker);

    const directory = latestDirectory(harness, attachment);
    expect(directory.context_hint).toBe("Westin SFO banquet room");
    expect(directory.hint_guided).toBe(true);
    expect(String(directory.summary)).toContain("Westin SFO banquet room");
    expect(directory.tags).toEqual(
      expect.arrayContaining(["westin", "sfo", "banquet", "room"]),
    );
  });
});
