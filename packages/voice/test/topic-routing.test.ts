import { describe, expect, it } from "vitest";
import {
  buildTopicSessionId,
  extractInlineTopicReference,
  formatCurrentTopicMessage,
  formatOpenedTopicMessage,
  normalizeTopicSlug,
  parseSharedTopicSystemCommand
} from "../src/topic-routing.js";

describe("topic routing helpers", () => {
  it("parses topic system commands", () => {
    expect(parseSharedTopicSystemCommand("open topic auth redesign")).toEqual({
      type: "open-topic",
      topicName: "auth redesign",
      projectName: null,
      standalone: true
    });
    expect(parseSharedTopicSystemCommand("open standalone topic auth redesign")).toEqual({
      type: "open-topic",
      topicName: "auth redesign",
      projectName: null,
      standalone: true
    });
    expect(parseSharedTopicSystemCommand("open topic auth redesign in project tango")).toEqual({
      type: "open-topic",
      topicName: "auth redesign",
      projectName: "tango",
      standalone: false
    });
    expect(parseSharedTopicSystemCommand("move topic auth redesign to project tango")).toEqual({
      type: "move-topic-to-project",
      topicName: "auth redesign",
      projectName: "tango"
    });
    expect(parseSharedTopicSystemCommand("attach this topic to project tango")).toEqual({
      type: "move-topic-to-project",
      topicName: null,
      projectName: "tango"
    });
    expect(parseSharedTopicSystemCommand("detach topic auth redesign from project")).toEqual({
      type: "detach-topic-from-project",
      topicName: "auth redesign"
    });
    expect(parseSharedTopicSystemCommand("detach this topic from project")).toEqual({
      type: "detach-topic-from-project",
      topicName: null
    });
    expect(parseSharedTopicSystemCommand("make this topic standalone")).toEqual({
      type: "detach-topic-from-project",
      topicName: null
    });
    expect(parseSharedTopicSystemCommand("current topic")).toEqual({
      type: "current-topic"
    });
    expect(parseSharedTopicSystemCommand("what project is this topic in")).toEqual({
      type: "current-topic"
    });
    expect(parseSharedTopicSystemCommand("leave topic")).toEqual({
      type: "clear-topic"
    });
  });

  it("extracts inline topic references from prompts", () => {
    expect(extractInlineTopicReference("in auth redesign, draft acceptance criteria")).toEqual({
      topicName: "auth redesign",
      promptText: "draft acceptance criteria",
      usedTopicKeyword: false
    });
    expect(extractInlineTopicReference("on topic workout log: log bench 135 for 8")).toEqual({
      topicName: "workout log",
      promptText: "log bench 135 for 8",
      usedTopicKeyword: true
    });
    expect(
      extractInlineTopicReference(
        "On the return there are a couple of ways to think about this: 1. Coming home June 30th."
      )
    ).toEqual({
      topicName: "the return there are a couple of ways to think about this",
      promptText: "1. Coming home June 30th.",
      usedTopicKeyword: false
    });
  });

  it("normalizes topic slugs and builds topic sessions", () => {
    expect(normalizeTopicSlug(" Auth Redesign v2 ")).toBe("auth-redesign-v2");
    expect(buildTopicSessionId("topic-123")).toBe("topic:topic-123");
  });

  it("formats topic status messages with explicit standalone/project context", () => {
    expect(formatOpenedTopicMessage("auth redesign", "Tango MVP")).toBe(
      "Opened topic auth redesign in project Tango MVP. You can keep talking."
    );
    expect(formatCurrentTopicMessage("grocery planning")).toBe(
      "You are in standalone topic grocery planning."
    );
  });
});
