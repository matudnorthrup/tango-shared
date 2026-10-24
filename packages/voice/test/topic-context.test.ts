import { describe, expect, it } from "vitest";
import {
  appendProjectContextToSystemPrompt,
  appendTopicContextToSystemPrompt,
} from "../src/topic-context.js";

describe("appendTopicContextToSystemPrompt", () => {
  it("leaves prompts unchanged when no topic title is provided", () => {
    expect(appendTopicContextToSystemPrompt("Base prompt", null)).toBe("Base prompt");
    expect(appendTopicContextToSystemPrompt("Base prompt", "   ")).toBe("Base prompt");
  });

  it("appends explicit topic framing when a topic title is provided", () => {
    expect(appendTopicContextToSystemPrompt("Base prompt", "auth redesign")).toBe(
      [
        "Base prompt",
        'Current topic: auth redesign. Treat references like "this topic", "the topic", or implicit follow-ups as referring to auth redesign unless the user explicitly switches topics.',
      ].join("\n\n"),
    );
  });

  it("appends explicit project framing when a project title is provided", () => {
    expect(appendProjectContextToSystemPrompt("Base prompt", "Tango MVP")).toBe(
      [
        "Base prompt",
        'Current project: Tango MVP. Treat this turn as belonging to Tango MVP unless the user explicitly switches projects.',
      ].join("\n\n"),
    );
  });
});
