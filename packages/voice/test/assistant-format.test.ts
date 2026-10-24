import { describe, expect, it } from "vitest";
import {
  isLegacyMetadataWrapper,
  sanitizeAssistantResponse
} from "../src/index.js";

describe("assistant format helpers", () => {
  it("detects legacy metadata wrappers", () => {
    expect(
      isLegacyMetadataWrapper(
        'conversation info (untrusted metadata): {"conversation_label":"group_channel"}'
      )
    ).toBe(true);
    expect(isLegacyMetadataWrapper("plain assistant reply")).toBe(false);
  });

  it("removes assistant label prefixes", () => {
    expect(
      sanitizeAssistantResponse(
        "[voice-assistant]\n\n[discord-assistant]\n\nHello there"
      )
    ).toBe("Hello there");
  });

  it("drops trailing transcript/context artifacts from assistant output", () => {
    expect(
      sanitizeAssistantResponse(
        "Final answer.\n[voice-user] ignored transcript\n[voice-assistant] more"
      )
    ).toBe("Final answer.");
  });

  it("returns empty when payload is only metadata or transcript wrappers", () => {
    expect(
      sanitizeAssistantResponse("[voice-user] transcript only")
    ).toBe("");
    expect(
      sanitizeAssistantResponse("[Chat messages since your last reply] anything")
    ).toBe("");
  });
});
