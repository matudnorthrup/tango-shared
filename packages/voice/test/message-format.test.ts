import { describe, expect, it } from "vitest";
import {
  cleanConversationMessageText,
  cleanSpeechReadbackText,
  coerceSpokenText,
  formatSpeechReadbackMessages,
  getSpeechReadbackSpeakerLabel,
  isNativeDiscordGatewayMessage,
  mapMessageLabelToRole,
  normalizeSyncText,
  stripMessageLabelPrefixes
} from "../src/index.js";

describe("message format helpers", () => {
  it("strips gateway label prefixes", () => {
    expect(
      stripMessageLabelPrefixes(
        "[discord-user]\n\n[voice-user]\n\nhello there"
      )
    ).toBe("hello there");
  });

  it("strips presentation prefixes for stored conversation history", () => {
    expect(
      cleanConversationMessageText("**You:** hello there", "Watson")
    ).toBe("hello there");
    expect(
      cleanConversationMessageText("**Watson:** hello back", "Watson")
    ).toBe("hello back");
    expect(
      cleanConversationMessageText("**Watson Voice:** hello back", "Watson")
    ).toBe("hello back");
  });

  it("normalizes speech readback text into a single line", () => {
    expect(
      cleanSpeechReadbackText("[voice-assistant]\n\n**Watson:** hi\nthere", "Watson")
    ).toBe("hi there");
  });

  it("coerces structured values into stable spoken text", () => {
    expect(coerceSpokenText(["alpha", { content: "beta" }], "")).toBe(
      "alpha beta"
    );
    expect(coerceSpokenText({ ok: true }, "")).toBe('{"ok":true}');
  });

  it("formats speech readback speaker labels", () => {
    expect(getSpeechReadbackSpeakerLabel("user", "voice-user")).toBe("You");
    expect(getSpeechReadbackSpeakerLabel(undefined, "discord-assistant")).toBe(
      "Assistant"
    );
  });

  it("formats short readback batches with cleaned speaker text", () => {
    expect(
      formatSpeechReadbackMessages(
        [
          { role: "user", label: "voice-user", content: "**You:** hello" },
          {
            role: "assistant",
            label: "discord-assistant",
            content: "[discord-assistant]\n\n**Watson:** hi there"
          }
        ],
        "Watson"
      )
    ).toBe("You: hello ... Assistant: hi there");
  });

  it("maps known labels to conversation roles", () => {
    expect(mapMessageLabelToRole("voice-user")).toBe("user");
    expect(mapMessageLabelToRole("discord-assistant")).toBe("assistant");
    expect(mapMessageLabelToRole("unknown")).toBeNull();
  });

  it("detects native Discord gateway metadata wrappers", () => {
    expect(
      isNativeDiscordGatewayMessage(
        'conversation info (untrusted metadata): {"conversation_label":"group_channel"}'
      )
    ).toBe(true);
    expect(isNativeDiscordGatewayMessage("plain user text")).toBe(false);
  });

  it("normalizes sync text for duplicate detection", () => {
    expect(normalizeSyncText(" Hello   There ")).toBe("hello there");
  });
});
