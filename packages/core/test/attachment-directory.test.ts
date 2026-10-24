import { describe, expect, it } from "vitest";
import { buildAttachmentDirectory } from "../src/attachment-directory.js";
import type {
  AttachmentExtractionRecord,
  AttachmentRecord,
} from "../src/attachments-store.js";

// T-I-125 Phase 1 — direct unit coverage of buildAttachmentDirectory's
// context_hint threading, independent of the job-worker plumbing (see
// attachment-processing.test.ts for the end-to-end job-metadata path). Kept
// deterministic: no DB, no worker, just the pure builder function.

function makeAttachment(overrides: Partial<AttachmentRecord> = {}): AttachmentRecord {
  return {
    id: 174,
    projectId: "creator-conference",
    agentId: "agent-piper",
    sessionId: "session-1",
    messageId: "message-1",
    channelId: "channel-1",
    threadId: null,
    userId: "user-1",
    discordAttachmentId: "discord-attachment-174",
    fileId: 1,
    title: "IMG_0001.png",
    originalFilename: "IMG_0001.png",
    contentType: "image/png",
    bytes: 2048,
    status: "processing",
    retentionPolicyId: null,
    metadata: null,
    createdAt: "2026-07-27 00:00:00",
    updatedAt: "2026-07-27 00:00:00",
    ...overrides,
  };
}

function makeExtraction(overrides: Partial<AttachmentExtractionRecord> = {}): AttachmentExtractionRecord {
  return {
    id: 501,
    attachmentId: 174,
    method: "apple_vision_ocr",
    text: "",
    confidence: 0.4,
    quality: null,
    metadata: null,
    createdAt: "2026-07-27 00:00:00",
    updatedAt: "2026-07-27 00:00:00",
    ...overrides,
  };
}

describe("buildAttachmentDirectory — T-I-125 Phase 1 context_hint", () => {
  it("no-hint payload carries neither context_hint nor hint_guided (byte-shape unchanged)", () => {
    const directory = buildAttachmentDirectory({
      attachment: makeAttachment(),
      file: null,
      extraction: makeExtraction(),
      chunks: [],
      status: "partial",
    });

    expect(directory).not.toHaveProperty("context_hint");
    expect(directory).not.toHaveProperty("hint_guided");
    expect(directory.summary).toBe("Attachment was stored, but no usable text has been extracted yet.");
  });

  it("omitting contextHint entirely and passing contextHint: null produce identical payloads", () => {
    const base = {
      attachment: makeAttachment(),
      file: null,
      extraction: makeExtraction(),
      chunks: [],
      status: "partial" as const,
    };
    const omitted = buildAttachmentDirectory(base);
    const explicitNull = buildAttachmentDirectory({ ...base, contextHint: null });
    expect(explicitNull).toEqual(omitted);
  });

  it("a hint on a no-text attachment (the signage-less-photo case) is folded into the summary", () => {
    const directory = buildAttachmentDirectory({
      attachment: makeAttachment(),
      file: null,
      extraction: makeExtraction({ text: "" }),
      chunks: [],
      status: "partial",
      contextHint: "Westin SFO banquet room",
    });

    expect(directory.summary).toBe(
      "Westin SFO banquet room. Attachment was stored, but no usable text has been extracted yet.",
    );
    expect(directory.context_hint).toBe("Westin SFO banquet room");
    expect(directory.hint_guided).toBe(true);
  });

  it("a hint on a text-bearing attachment prefixes the summary and adds tag tokens", () => {
    const directory = buildAttachmentDirectory({
      attachment: makeAttachment({ contentType: "text/plain", originalFilename: "notes.txt" }),
      file: null,
      extraction: makeExtraction({ method: "utf8_text", text: "Owner: User\nTotal $12.34" }),
      chunks: [],
      status: "ready",
      contextHint: "Westin SFO banquet room",
    });

    expect(String(directory.summary)).toContain("Westin SFO banquet room. ");
    expect(directory.context_hint).toBe("Westin SFO banquet room");
    expect(directory.hint_guided).toBe(true);
    // The whole hint lands as ONE combined tag (the acceptance test:
    // "we're going with the Cedar Ridge Lodge" pulls everything under
    // one venue tag, not word-fragment matching) — plus individual word
    // tokens for partial/ranked-search matching.
    expect(directory.tags).toEqual(
      expect.arrayContaining(["westin sfo banquet room", "westin", "sfo", "banquet", "room"]),
    );
  });

  it("trims whitespace and drops a blank-after-trim hint back to the no-hint path", () => {
    const withBlank = buildAttachmentDirectory({
      attachment: makeAttachment(),
      file: null,
      extraction: makeExtraction(),
      chunks: [],
      status: "partial",
      contextHint: "   ",
    });
    expect(withBlank).not.toHaveProperty("context_hint");
    expect(withBlank).not.toHaveProperty("hint_guided");

    const trimmed = buildAttachmentDirectory({
      attachment: makeAttachment(),
      file: null,
      extraction: makeExtraction(),
      chunks: [],
      status: "partial",
      contextHint: "  Westin SFO  ",
    });
    expect(trimmed.context_hint).toBe("Westin SFO");
  });
});
