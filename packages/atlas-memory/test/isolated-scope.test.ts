import { describe, expect, it } from "vitest";
import { applyProcessMemoryScopeToToolArgs, type ProcessMemoryScope } from "../src/index.js";

const isolated: ProcessMemoryScope = {
  runtimeAgentId: "oscar",
  canonicalAgentId: "oscar",
  aliasAgentIds: ["oscar"],
  isolated: true,
};

describe("isolated memory scope", () => {
  it("pins searches to the agent's own scope even when another agent is requested", () => {
    expect(applyProcessMemoryScopeToToolArgs("memory_search", { query: "dad", agent_ids: ["juliet"] }, isolated))
      .toMatchObject({ query: "dad", agent_id: "oscar", agent_ids: ["oscar"] });
    expect(applyProcessMemoryScopeToToolArgs("memory_search", { query: "dad", agent_id: "sierra" }, isolated))
      .toMatchObject({ agent_id: "oscar", agent_ids: ["oscar"] });
  });

  it("forces writes and reflections into the agent's own scope", () => {
    expect(applyProcessMemoryScopeToToolArgs("memory_add", { content: "x", agent_id: "juliet" }, isolated))
      .toMatchObject({ agent_id: "oscar" });
    expect(applyProcessMemoryScopeToToolArgs("memory_reflect", { agent_id: "juliet" }, isolated))
      .toMatchObject({ agent_id: "oscar" });
  });

  it("blocks admin and pinned-fact tools", () => {
    for (const tool of ["memory_admin", "pinned_fact_get", "pinned_fact_set", "pinned_fact_delete"]) {
      expect(() => applyProcessMemoryScopeToToolArgs(tool, {}, isolated)).toThrow(/not available/u);
    }
  });

  it("keeps cross-agent search for non-isolated owner agents", () => {
    const owner: ProcessMemoryScope = { runtimeAgentId: "watson", canonicalAgentId: "watson", aliasAgentIds: ["watson"] };
    expect(applyProcessMemoryScopeToToolArgs("memory_search", { query: "q", agent_ids: ["sierra"] }, owner))
      .toEqual({ query: "q", agent_ids: ["sierra"] });
  });
});
