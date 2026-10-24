import { describe, expect, it } from "vitest";
import { applyThreadSessionRoute } from "../src/thread-route.js";

describe("applyThreadSessionRoute", () => {
  it("overrides both session and agent when the thread mapping is agent-aware", () => {
    expect(
      applyThreadSessionRoute(
        { sessionId: "dispatch-root", agentId: "dispatch" },
        { sessionId: "slot-test-1-malibu", agentId: "malibu" },
      ),
    ).toEqual({
      sessionId: "slot-test-1-malibu",
      agentId: "malibu",
    });
  });

  it("preserves the route agent when the thread mapping lacks an agent id", () => {
    expect(
      applyThreadSessionRoute(
        { sessionId: "dispatch-root", agentId: "dispatch" },
        { sessionId: "topic-123", agentId: null },
      ),
    ).toEqual({
      sessionId: "topic-123",
      agentId: "dispatch",
    });
  });
});
