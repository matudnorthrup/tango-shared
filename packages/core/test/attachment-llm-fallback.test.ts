import { describe, expect, it } from "vitest";
import {
  LLM_VISION_FALLBACK_METHOD,
  buildAttachmentLlmFallbackResultFromProviderOutput,
} from "../src/attachment-llm-fallback.js";

describe("buildAttachmentLlmFallbackResultFromProviderOutput", () => {
  it("normalizes fenced provider JSON into compact extraction text and quality metadata", () => {
    const result = buildAttachmentLlmFallbackResultFromProviderOutput(
      [
        "```json",
        JSON.stringify({
          summary: "Screenshot of a planning board.",
          extracted_text: "Owner: User\nTotal: 3 images",
          key_facts: [
            { text: "Owner: User", source_ref: "attachment:42" },
          ],
          visual_notes: ["Whiteboard-style diagram with columns."],
          confidence: 0.91,
          warnings: ["visual_reasoning_used"],
        }),
        "```",
      ].join("\n"),
      { metadata: { providerName: "test-provider" } },
    );

    expect(result).toMatchObject({
      method: LLM_VISION_FALLBACK_METHOD,
      confidence: 0.91,
      quality: {
        empty: false,
        structured: true,
        keyFactCount: 1,
        visualNoteCount: 1,
        warningCount: 1,
      },
      metadata: {
        providerName: "test-provider",
      },
    });
    expect(result.text).toContain("Summary: Screenshot of a planning board.");
    expect(result.text).toContain("Owner: User");
    expect(result.text).toContain("Whiteboard-style diagram with columns.");
  });

  it("keeps malformed provider output bounded and marks parse failure", () => {
    const result = buildAttachmentLlmFallbackResultFromProviderOutput(
      "I looked at it and it seems like a receipt, but this is not JSON.",
    );

    expect(result.quality.structured).toBe(false);
    expect(result.warnings).toContain("structured_json_parse_failed");
    expect(result.text).toContain("I looked at it and it seems like a receipt");
    expect(result.text).not.toContain("```");
  });
});
