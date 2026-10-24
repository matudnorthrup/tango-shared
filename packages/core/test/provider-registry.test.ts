import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/types.js";
import type { ChatProvider, ProviderRequest, ProviderResponse } from "../src/provider.js";
import {
  createBuiltInProviderRegistry,
  resolveProviderCandidates,
  selectProviderByName,
  selectProviderForAgent
} from "../src/provider-registry.js";

class StaticProvider implements ChatProvider {
  constructor(private readonly text: string) {}

  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    return { text: this.text };
  }
}

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "watson",
    type: "personal",
    provider: {
      default: "claude-oauth"
    },
    ...overrides
  };
}

describe("resolveProviderCandidates", () => {
  it("returns default provider first and appends unique fallbacks", () => {
    const agent = makeAgent({
      provider: {
        default: "claude-oauth",
        fallback: ["echo", "claude-oauth", "  ", "claude-harness", "echo"]
      }
    });

    expect(resolveProviderCandidates(agent)).toEqual(["claude-oauth", "echo", "claude-harness"]);
  });
});

describe("selectProviderForAgent", () => {
  it("selects default provider when available", () => {
    const providers = new Map<string, ChatProvider>();
    providers.set("claude-oauth", new StaticProvider("oauth"));
    providers.set("echo", new StaticProvider("echo"));

    const selection = selectProviderForAgent(
      makeAgent({
        provider: {
          default: "claude-oauth",
          fallback: ["echo"]
        }
      }),
      providers
    );

    expect(selection.providerName).toBe("claude-oauth");
    expect(selection.usedFallback).toBe(false);
  });

  it("falls back when default provider is unavailable", () => {
    const providers = new Map<string, ChatProvider>();
    providers.set("echo", new StaticProvider("echo"));

    const selection = selectProviderForAgent(
      makeAgent({
        provider: {
          default: "claude-oauth",
          fallback: ["echo"]
        }
      }),
      providers
    );

    expect(selection.providerName).toBe("echo");
    expect(selection.usedFallback).toBe(true);
    expect(selection.candidates).toEqual(["claude-oauth", "echo"]);
  });

  it("throws when no configured providers are available", () => {
    const providers = new Map<string, ChatProvider>();
    providers.set("echo", new StaticProvider("echo"));

    expect(() =>
      selectProviderForAgent(
        makeAgent({
          provider: {
            default: "claude-oauth",
            fallback: ["claude-harness"]
          }
        }),
        providers
      )
    ).toThrow(/No supported providers for agent 'watson'/u);
  });
});

describe("built-in provider registry", () => {
  it("includes claude-oauth, claude-harness, codex, echo, and stub", () => {
    const providers = createBuiltInProviderRegistry();
    expect(providers.has("claude-oauth")).toBe(true);
    expect(providers.has("claude-oauth-secondary")).toBe(false);
    expect(providers.has("claude-harness")).toBe(true);
    expect(providers.has("codex")).toBe(true);
    expect(providers.has("echo")).toBe(true);
    expect(providers.has("stub")).toBe(true);
  });

  it("includes claude-oauth-secondary when configured", () => {
    const providers = createBuiltInProviderRegistry({
      claudeOauthSecondary: {
        command: "claude-secondary",
      },
    });
    expect(providers.has("claude-oauth-secondary")).toBe(true);
  });

  it("throws with available provider names when provider is unknown", () => {
    const providers = createBuiltInProviderRegistry();
    expect(() => selectProviderByName("missing-provider", providers)).toThrow(
      /Available providers:/u
    );
  });
});
