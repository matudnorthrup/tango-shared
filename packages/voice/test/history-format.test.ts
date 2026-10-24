import { describe, expect, it } from "vitest";
import {
  collapseLatestDiscordHistoryMessages,
  convertDiscordHistoryMessages,
  convertGatewayHistoryMessages,
  normalizeGatewayHistoryMessage
} from "../src/index.js";

describe("history format helpers", () => {
  it("normalizes gateway history messages with label-aware roles", () => {
    expect(
      normalizeGatewayHistoryMessage(
        {
          role: "assistant",
          label: "voice-assistant",
          content: "[voice-assistant]\n\n**Watson:** hello there"
        },
        {
          botName: "Watson"
        }
      )
    ).toEqual({
      role: "assistant",
      content: "hello there"
    });
  });

  it("filters skipped gateway wrapper text and sanitizes assistant output", () => {
    expect(
      convertGatewayHistoryMessages(
        [
          {
            role: "system",
            content: "ignore me"
          },
          {
            role: "assistant",
            content: "keep this [voice-user] drop that"
          },
          {
            role: "user",
            content: "conversation info (untrusted metadata): {}"
          }
        ],
        {
          isSkippableText: (text) =>
            text.includes("conversation info (untrusted metadata):"),
          sanitizeAssistantText: (text) => text.replace(/\s*\[voice-user\].*$/, "")
        }
      )
    ).toEqual([
      {
        role: "assistant",
        content: "keep this"
      }
    ]);
  });

  it("converts Discord history into conversation roles", () => {
    expect(
      convertDiscordHistoryMessages(
        [
          {
            content: "Human message",
            author: { bot: false }
          },
          {
            content: "**Watson:** bot reply",
            author: { bot: true }
          },
          {
            content: "**You:** transcript",
            author: { bot: true }
          }
        ],
        "Watson"
      )
    ).toEqual([
      {
        role: "user",
        content: "Human message"
      },
      {
        role: "assistant",
        content: "bot reply"
      },
      {
        role: "user",
        content: "transcript"
      }
    ]);
  });

  it("collapses the latest same-role Discord run into one message", () => {
    expect(
      collapseLatestDiscordHistoryMessages(
        [
          {
            content: "**Watson:** line 2",
            author: { bot: true }
          },
          {
            content: "**Watson:** line 1",
            author: { bot: true }
          },
          {
            content: "Human reply",
            author: { bot: false }
          }
        ],
        "Watson"
      )
    ).toEqual({
      role: "assistant",
      content: "line 1\n\nline 2"
    });
  });
});
