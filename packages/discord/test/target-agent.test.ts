import type { AgentConfig } from "@tango/core";
import { describe, expect, it } from "vitest";
import { resolveTargetAgent } from "../src/target-agent.js";

function createAgent(overrides: Partial<AgentConfig> & Pick<AgentConfig, "id" | "type">): AgentConfig {
  return {
    provider: { default: "codex" },
    ...overrides
  };
}

function createLookup(agents: AgentConfig[]) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return {
    get(id: string): AgentConfig | undefined {
      return byId.get(id);
    }
  };
}

describe("resolveTargetAgent", () => {
  it("returns the route agent directly", () => {
    const watson = createAgent({
      id: "watson",
      type: "personal",
      displayName: "Watson"
    });

    const resolved = resolveTargetAgent(createLookup([watson]), "watson", null);
    expect(resolved).toBe(watson);
  });

  it("honors explicit agent overrides", () => {
    const watson = createAgent({
      id: "watson",
      type: "personal",
      displayName: "Watson"
    });
    const malibu = createAgent({
      id: "malibu",
      type: "fitness",
      displayName: "Malibu"
    });

    const resolved = resolveTargetAgent(createLookup([watson, malibu]), "watson", "malibu");
    expect(resolved).toBe(malibu);
  });

  it("returns null when the route agent is not configured", () => {
    expect(resolveTargetAgent(createLookup([]), "watson", null)).toBeNull();
  });
});
