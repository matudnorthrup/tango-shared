import type { AgentConfig } from "@tango/core";
import { describe, expect, it } from "vitest";
import {
  applySessionProviderCommand,
  mergeProviderOrder,
  type SessionProviderOverrideStore
} from "../src/session-provider-command.js";

class InMemoryOverrideStore implements SessionProviderOverrideStore {
  private readonly overrides = new Map<string, string>();

  getOverride(sessionId: string, agentId: string): string | undefined {
    return this.overrides.get(`${sessionId}:${agentId}`);
  }

  setOverride(input: { sessionId: string; agentId: string; providerName: string }): void {
    this.overrides.set(`${input.sessionId}:${input.agentId}`, input.providerName);
  }

  clearOverride(sessionId: string, agentId: string): boolean {
    return this.overrides.delete(`${sessionId}:${agentId}`);
  }
}

function buildAgent(): Pick<AgentConfig, "id" | "provider"> {
  return {
    id: "watson",
    provider: {
      default: "codex",
      fallback: ["claude-oauth"]
    }
  };
}

describe("mergeProviderOrder", () => {
  it("prioritizes override while keeping configured provider order", () => {
    expect(mergeProviderOrder(["codex", "claude-oauth"], "claude-oauth")).toEqual([
      "claude-oauth",
      "codex"
    ]);
  });
});

describe("applySessionProviderCommand", () => {
  it("shows configured providers when no override exists", () => {
    const store = new InMemoryOverrideStore();
    const result = applySessionProviderCommand({
      sessionId: "tango-default",
      agent: buildAgent(),
      clearOverride: false,
      isSupportedProvider: () => true,
      store
    });

    expect(result.status).toBe("show");
    expect(result.overrideProviderName).toBeUndefined();
    expect(result.effectiveProviders).toEqual(["codex", "claude-oauth"]);
  });

  it("sets override without clearing provider continuity", () => {
    const store = new InMemoryOverrideStore();
    const result = applySessionProviderCommand({
      sessionId: "tango-default",
      agent: buildAgent(),
      clearOverride: false,
      providerOverride: "claude-oauth",
      isSupportedProvider: (providerName) => providerName === "claude-oauth",
      store
    });

    expect(result.status).toBe("set");
    expect(result.overrideProviderName).toBe("claude-oauth");
    expect(result.effectiveProviders).toEqual(["claude-oauth", "codex"]);
    expect(store.getOverride("tango-default", "watson")).toBe("claude-oauth");
  });

  it("clears override and reports no-override when nothing is set", () => {
    const store = new InMemoryOverrideStore();
    const first = applySessionProviderCommand({
      sessionId: "tango-default",
      agent: buildAgent(),
      clearOverride: true,
      isSupportedProvider: () => true,
      store
    });
    expect(first.status).toBe("no-override");

    store.setOverride({
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth"
    });
    const second = applySessionProviderCommand({
      sessionId: "tango-default",
      agent: buildAgent(),
      clearOverride: true,
      isSupportedProvider: () => true,
      store
    });
    expect(second.status).toBe("cleared");
    expect(store.getOverride("tango-default", "watson")).toBeUndefined();
  });

  it("throws when provider is unsupported", () => {
    const store = new InMemoryOverrideStore();
    expect(() =>
      applySessionProviderCommand({
        sessionId: "tango-default",
        agent: buildAgent(),
        clearOverride: false,
        providerOverride: "unsupported-provider",
        isSupportedProvider: () => false,
        store
      })
    ).toThrow(/Unsupported provider/u);
  });
});
