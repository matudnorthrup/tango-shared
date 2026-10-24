import { describe, expect, it } from "vitest";
import { applyMemoryScopeToToolArgs } from "../src/memory-tool-scope.js";

const SIERRA_SCOPE = {
  canonicalAgentId: "sierra",
  aliasAgentIds: ["sierra", "sierra-ollama"],
};

describe("memory tool scope", () => {
  it("expands current-worker memory_search calls to the configured alias set", () => {
    expect(
      applyMemoryScopeToToolArgs(
        "memory_search",
        {
          query: "Fujifilm X100VI",
          agent_id: "sierra-ollama",
        },
        "sierra-ollama",
        SIERRA_SCOPE,
      ),
    ).toEqual({
      query: "Fujifilm X100VI",
      agent_id: "sierra",
      agent_ids: ["sierra", "sierra-ollama"],
    });
  });

  it("stores current-worker memory writes under the canonical agent id", () => {
    expect(
      applyMemoryScopeToToolArgs(
        "memory_add",
        {
          content: "Camera choice was Fujifilm X100VI.",
          agent_id: "sierra-ollama",
        },
        "sierra-ollama",
        SIERRA_SCOPE,
      ),
    ).toEqual({
      content: "Camera choice was Fujifilm X100VI.",
      agent_id: "sierra",
    });
  });

  it("leaves explicit out-of-scope agent ids untouched", () => {
    expect(
      applyMemoryScopeToToolArgs(
        "memory_search",
        {
          query: "transactions",
          agent_id: "watson",
        },
        "sierra-ollama",
        SIERRA_SCOPE,
      ),
    ).toEqual({
      query: "transactions",
      agent_id: "watson",
    });
  });
});
