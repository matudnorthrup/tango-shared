import {
  ClaudeCliProvider,
  CodexExecProvider,
  EchoProvider,
  OllamaProvider,
  type ChatProvider,
  type ClaudeCliProviderOptions,
  type CodexExecProviderOptions,
  type OllamaProviderOptions
} from "./provider.js";
import type { AgentConfig } from "./types.js";

export interface BuiltInProviderRegistryOptions {
  claudeOauth?: ClaudeCliProviderOptions;
  claudeOauthSecondary?: ClaudeCliProviderOptions;
  claudeHarness?: ClaudeCliProviderOptions;
  codex?: CodexExecProviderOptions;
  ollama?: OllamaProviderOptions;
}

export interface SelectedProvider {
  providerName: string;
  provider: ChatProvider;
  usedFallback: boolean;
  candidates: string[];
}

function normalizeProviderName(value: string): string {
  return value.trim();
}

export function resolveProviderCandidates(
  agent: {
    provider?: {
      default: string;
      fallback?: string[];
    };
  }
): string[] {
  const deduped = new Set<string>();
  if (!agent.provider) return [];

  const ordered = [agent.provider.default, ...(agent.provider.fallback ?? [])];

  for (const value of ordered) {
    const normalized = normalizeProviderName(value);
    if (normalized.length === 0) continue;
    deduped.add(normalized);
  }

  return [...deduped];
}

export function createBuiltInProviderRegistry(
  options: BuiltInProviderRegistryOptions = {}
): Map<string, ChatProvider> {
  const providers = new Map<string, ChatProvider>();

  providers.set("claude-oauth", new ClaudeCliProvider(options.claudeOauth));
  if (options.claudeOauthSecondary) {
    providers.set(
      "claude-oauth-secondary",
      new ClaudeCliProvider(options.claudeOauthSecondary)
    );
  }
  providers.set(
    "claude-harness",
    new ClaudeCliProvider(options.claudeHarness ?? options.claudeOauth)
  );
  providers.set("codex", new CodexExecProvider(options.codex));
  if (options.ollama) {
    providers.set("ollama", new OllamaProvider(options.ollama));
  }

  const echo = new EchoProvider();
  providers.set("echo", echo);
  providers.set("stub", echo);

  return providers;
}

export function selectProviderByName(
  providerName: string,
  providers: ReadonlyMap<string, ChatProvider>
): ChatProvider {
  const normalized = normalizeProviderName(providerName);
  if (normalized.length === 0) {
    throw new Error("Provider name must not be empty");
  }

  const provider = providers.get(normalized);
  if (!provider) {
    const available = [...providers.keys()].sort();
    throw new Error(
      `Unsupported provider '${providerName}'. Available providers: ${available.join(", ")}`
    );
  }

  return provider;
}

export function selectProviderForAgent(
  agent: Pick<AgentConfig, "id" | "provider">,
  providers: ReadonlyMap<string, ChatProvider>
): SelectedProvider {
  const candidates = resolveProviderCandidates(agent);
  if (candidates.length === 0) {
    throw new Error(`Agent '${agent.id}' has no configured providers`);
  }

  for (const [index, candidate] of candidates.entries()) {
    const provider = providers.get(candidate);
    if (!provider) continue;

    return {
      providerName: candidate,
      provider,
      usedFallback: index > 0,
      candidates
    };
  }

  const available = [...providers.keys()].sort();
  throw new Error(
    `No supported providers for agent '${agent.id}'. configured=${candidates.join(
      ","
    )} available=${available.join(",")}`
  );
}
