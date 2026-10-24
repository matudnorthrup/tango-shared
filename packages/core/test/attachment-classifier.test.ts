import { describe, expect, it } from "vitest";
import {
  DEFAULT_ATTACHMENT_CLASSIFIER_MAX_BYTES,
  classifyAttachment,
  extractAttachmentExtension,
  normalizeAttachmentContentType,
} from "../src/attachment-classifier.js";

describe("classifyAttachment", () => {
  it("classifies PDFs from MIME and extension and recommends embedded text first", () => {
    const result = classifyAttachment({
      originalFilename: "Quarterly-Report.PDF",
      contentType: "Application/PDF; charset=utf-8",
      byteSize: 12_345,
    });

    expect(result).toMatchObject({
      classification: "pdf",
      type: "pdf",
      supported: true,
      normalizedContentType: "application/pdf",
      reportedContentType: "application/pdf",
      inferredContentType: "application/pdf",
      extension: "pdf",
      byteSize: 12_345,
      recommendedJobs: ["embedded_text", "chunk", "directory"],
      possibleEscalationJobs: ["apple_ocr", "llm_fallback"],
      unsupportedReason: null,
      unsupportedCode: null,
    });
    expect(result.rationale.join(" ")).toContain("both matched PDF");
    expect(result.jobRecommendations[0]?.reason).toContain("embedded text extraction");
  });

  it("uses extension refinements for generic and plain-text MIME reports", () => {
    const markdown = classifyAttachment({
      filename: "handoff.MD",
      contentType: "application/octet-stream",
      bytes: 120,
    });
    expect(markdown).toMatchObject({
      classification: "markdown",
      type: "text",
      normalizedContentType: "text/markdown",
      reportedContentType: "application/octet-stream",
      extension: "md",
      recommendedJobs: ["embedded_text", "chunk", "directory"],
    });
    expect(markdown.rationale.join(" ")).toContain("generic");

    const csv = classifyAttachment({
      originalFilename: "leads.csv",
      contentType: "text/plain",
      byteSize: 300,
    });
    expect(csv).toMatchObject({
      classification: "csv",
      type: "spreadsheet_text",
      normalizedContentType: "text/csv",
      recommendedJobs: ["embedded_text", "chunk", "directory"],
    });
    expect(csv.rationale.join(" ")).toContain("refined reported content type text/plain");
  });

  it("recognizes TSV and spreadsheet-like document attachments", () => {
    const tsv = classifyAttachment({
      originalFilename: "metrics.tsv",
      contentType: "text/tab-separated-values",
      byteSize: 90,
    });
    expect(tsv).toMatchObject({
      classification: "tsv",
      type: "spreadsheet_text",
      normalizedContentType: "text/tab-separated-values",
      recommendedJobs: ["embedded_text", "chunk", "directory"],
    });

    const spreadsheet = classifyAttachment({
      originalFilename: "budget.xlsx",
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      byteSize: 4096,
    });
    expect(spreadsheet).toMatchObject({
      classification: "spreadsheet_text",
      type: "spreadsheet_text",
      recommendedJobs: ["embedded_text", "chunk", "directory"],
    });
  });

  it("prefers a specific MIME classification when MIME and extension disagree", () => {
    const result = classifyAttachment({
      originalFilename: "receipt.pdf",
      contentType: "image/jpeg",
      byteSize: 2048,
    });

    expect(result).toMatchObject({
      classification: "image",
      type: "image",
      supported: true,
      normalizedContentType: "image/jpeg",
      inferredContentType: "application/pdf",
      extension: "pdf",
      recommendedJobs: ["apple_ocr", "chunk", "directory"],
      possibleEscalationJobs: ["llm_fallback"],
      unsupportedReason: null,
    });
    expect(result.recommendedJobs).not.toContain("llm_fallback");
    expect(result.rationale.join(" ")).toContain("disagree");
  });

  it("lets Office document extensions refine archive-like MIME reports", () => {
    const result = classifyAttachment({
      originalFilename: "proposal.docx",
      contentType: "application/zip",
      byteSize: 50_000,
    });

    expect(result).toMatchObject({
      classification: "document",
      type: "document",
      normalizedContentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      recommendedJobs: ["embedded_text", "chunk", "directory"],
      unsupportedReason: null,
    });
    expect(result.rationale.join(" ")).toContain("refined reported content type application/zip");
  });

  it("records media, archives, and unknowns as unsupported with retention review", () => {
    const media = classifyAttachment({
      originalFilename: "clip.mov",
      contentType: "video/quicktime",
      byteSize: 100,
    });
    expect(media).toMatchObject({
      classification: "unsupported_media",
      type: "unsupported",
      supported: false,
      recommendedJobs: ["retention_review"],
      unsupportedCode: "unsupported_media",
    });
    expect(media.unsupportedReason).toContain("Audio/video media");

    const archive = classifyAttachment({
      originalFilename: "bundle.zip",
      contentType: "application/octet-stream",
      byteSize: 100,
    });
    expect(archive).toMatchObject({
      classification: "unsupported_archive",
      supported: false,
      normalizedContentType: "application/octet-stream",
      recommendedJobs: ["retention_review"],
      unsupportedCode: "unsupported_archive",
    });

    const unknown = classifyAttachment({
      originalFilename: "README",
      contentType: null,
      byteSize: 100,
    });
    expect(unknown).toMatchObject({
      classification: "unsupported_other",
      supported: false,
      recommendedJobs: ["retention_review"],
      unsupportedCode: "unsupported_other",
    });
  });

  it("blocks oversized attachments before extraction jobs but keeps the type explanation", () => {
    const result = classifyAttachment({
      originalFilename: "large.pdf",
      contentType: "application/pdf",
      byteSize: DEFAULT_ATTACHMENT_CLASSIFIER_MAX_BYTES + 1,
    });

    expect(result).toMatchObject({
      classification: "pdf",
      type: "pdf",
      supported: false,
      unsupportedCode: "too_large",
      recommendedJobs: ["retention_review"],
      possibleEscalationJobs: [],
    });
    expect(result.recommendedJobs).not.toContain("embedded_text");
    expect(result.unsupportedReason).toContain("exceeds maxBytes policy");
    expect(result.rationale.join(" ")).toContain("exceeds maxBytes policy");
  });

  it.each([34, 100])("accepts a %i MB PDF for text extraction by default", (megabytes) => {
    const result = classifyAttachment({
      originalFilename: "large.pdf",
      contentType: "application/pdf",
      byteSize: megabytes * 1024 * 1024,
    });
    expect(result.supported).toBe(true);
    expect(result.recommendedJobs).toContain("embedded_text");
    expect(result.unsupportedReason).toBeNull();
  });

  it("honors policy settings for size limits, classify jobs, fallback, and reviews", () => {
    const acceptedLarge = classifyAttachment(
      {
        originalFilename: "large.pdf",
        contentType: "application/pdf",
        byteSize: DEFAULT_ATTACHMENT_CLASSIFIER_MAX_BYTES + 1,
      },
      { maxBytes: null, includeClassifyJob: true, allowLlmFallback: false },
    );
    expect(acceptedLarge).toMatchObject({
      supported: true,
      recommendedJobs: ["classify", "embedded_text", "chunk", "directory"],
      possibleEscalationJobs: ["apple_ocr"],
      unsupportedReason: null,
    });

    const unsupportedWithoutReview = classifyAttachment(
      {
        originalFilename: "clip.mp3",
        contentType: "audio/mpeg",
        byteSize: 100,
      },
      { enqueueRetentionReviewForUnsupported: false },
    );
    expect(unsupportedWithoutReview).toMatchObject({
      classification: "unsupported_media",
      supported: false,
      recommendedJobs: [],
    });
  });
});

describe("attachment classifier normalization helpers", () => {
  it("normalizes content type parameters and filename extensions", () => {
    expect(normalizeAttachmentContentType(" Text/CSV ; charset=utf-8 ")).toBe("text/csv");
    expect(normalizeAttachmentContentType("   ")).toBeNull();
    expect(extractAttachmentExtension("/tmp/uploads/.env")).toBe("env");
    expect(extractAttachmentExtension("https://example.test/file.PDF?token=1")).toBe("pdf");
    expect(extractAttachmentExtension("README")).toBeNull();
  });
});
