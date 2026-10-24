import { describe, expect, it } from "vitest";
import {
  buildPromptWithReferent,
  buildReferentSystemMessage,
  isLikelyReferentialFollowUp,
  shouldPreferReferentSession,
} from "../src/message-referents.js";

describe("message referents", () => {
  it("recognizes ambiguous follow-up language that depends on prior context", () => {
    expect(
      isLikelyReferentialFollowUp("i just marked a few as complete, so we need to update please")
    ).toBe(true);
    expect(isLikelyReferentialFollowUp("what unread emails need attention today?")).toBe(false);
  });

  it("prefers the referenced session for reply follow-ups", () => {
    expect(
      shouldPreferReferentSession({
        promptText: "can you update that?",
        referent: {
          kind: "reply",
          targetMessageId: "msg-1",
          targetSessionId: "tango-default",
          targetAgentId: "watson",
          targetContent: "Thursday's a clean slate.",
        },
        activeSessionId: "topic:lunch-money",
      })
    ).toBe(true);
  });

  it("uses reaction referents for ambiguous follow-ups but not explicit topic switches", () => {
    const reactionReferent = {
      kind: "reaction" as const,
      targetMessageId: "msg-1",
      targetSessionId: "tango-default",
      targetAgentId: "watson",
      targetContent: "Thursday's a clean slate.",
    };

    expect(
      shouldPreferReferentSession({
        promptText: "i just marked a few as complete, so we need to update please",
        referent: reactionReferent,
        activeSessionId: "topic:lunch-money",
      })
    ).toBe(true);

    expect(
      shouldPreferReferentSession({
        promptText: "in lunch money, categorize the remaining money market entries",
        referent: reactionReferent,
        explicitTopicName: "lunch money",
        activeSessionId: "topic:lunch-money",
      })
    ).toBe(false);
  });

  it("injects referent context into the prompt and memory trail", () => {
    const referent = {
      kind: "reaction" as const,
      targetMessageId: "msg-1",
      targetSessionId: "tango-default",
      targetAgentId: "watson",
      targetContent:
        "Thursday's a clean slate — all three primary tasks carry over to tomorrow, none confirmed complete.",
    };

    const prompt = buildPromptWithReferent(
      "i just marked a few as complete, so we need to update please",
      referent
    );

    expect(prompt).toContain("The user recently reacted");
    expect(prompt).toContain("Thursday's a clean slate");
    expect(prompt).toContain("User message: i just marked a few as complete");
    expect(buildReferentSystemMessage(referent)).toContain("Reaction referent");
  });
});
