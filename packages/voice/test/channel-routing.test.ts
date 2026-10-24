import { describe, expect, it } from "vitest";
import {
  buildChannelSystemPrompt,
  channelSearchForms,
  channelSearchScore,
  createAdhocChannelDefinition,
  listChannelSessionEntries,
  normalizeForumMatchText,
  resolveChannelSessionKey
} from "../src/index.js";

describe("channel routing helpers", () => {
  it("builds a channel-scoped system prompt only when a topic prompt exists", () => {
    expect(buildChannelSystemPrompt("base", null)).toBe("base");
    expect(buildChannelSystemPrompt("base", "topic")).toContain("topic");
  });

  it("creates ad-hoc channel definitions with normalized display names", () => {
    expect(
      createAdhocChannelDefinition({
        channelId: "12345",
        displayName: "#general-chat"
      })
    ).toEqual({
      displayName: "#general-chat",
      channelId: "12345",
      topicPrompt:
        "This is the #general-chat channel. Use recent conversation history for context."
    });
  });

  it("resolves channel session keys and lists default entries", () => {
    expect(
      resolveChannelSessionKey("main", {
        channelId: "12345"
      })
    ).toBe("agent:main:discord:channel:12345");

    expect(
      listChannelSessionEntries("main", {
        default: {
          displayName: "General",
          channelId: "",
          topicPrompt: null
        },
        inbox: {
          displayName: "Inbox",
          channelId: "999",
          topicPrompt: null,
          inboxExclude: true
        },
        project: {
          displayName: "Project",
          channelId: "12345",
          topicPrompt: "Project channel"
        }
      })
    ).toEqual([
      {
        name: "project",
        displayName: "Project",
        sessionKey: "agent:main:discord:channel:12345"
      },
      {
        name: "default",
        displayName: "General",
        sessionKey: "agent:main:main"
      }
    ]);
  });

  it("normalizes channel search forms and scoring", () => {
    expect(channelSearchForms("Project Notes")).toContain("project note");
    expect(channelSearchScore("project note", "project-notes")).toBeGreaterThan(0);
    expect(channelSearchScore("fitness", "project-notes")).toBe(0);
  });

  it("normalizes forum match text by removing filler words", () => {
    expect(normalizeForumMatchText("The Project Forum")).toBe("project");
  });
});
