import { describe, expect, it } from "vitest";
import { resolveAgentToolPolicy, resolveProviderToolsForAgent } from "../src/agent-tools.js";

describe("agent tool policy", () => {
  it("defaults to off when agent does not define tools", () => {
    const policy = resolveAgentToolPolicy(undefined);
    expect(policy).toEqual({
      mode: "off",
      allowlist: []
    });
    expect(resolveProviderToolsForAgent(undefined)).toEqual({
      mode: "off"
    });
  });

  it("supports allowlist for weather/search and url summary flows", () => {
    const agent = {
      tools: {
        mode: "allowlist" as const,
        allowlist: ["WebSearch", "WebFetch", "WebSearch"]
      }
    };

    expect(resolveAgentToolPolicy(agent)).toEqual({
      mode: "allowlist",
      allowlist: ["WebSearch", "WebFetch"]
    });
    expect(resolveProviderToolsForAgent(agent)).toEqual({
      mode: "allowlist",
      allowlist: ["WebSearch", "WebFetch"]
    });
  });

  it("falls back to off when allowlist mode has no usable entries", () => {
    const agent = {
      tools: {
        mode: "allowlist" as const,
        allowlist: ["   "]
      }
    };

    expect(resolveAgentToolPolicy(agent)).toEqual({
      mode: "off",
      allowlist: []
    });
    expect(resolveProviderToolsForAgent(agent)).toEqual({
      mode: "off"
    });
  });
});

