import { resolveProviderCandidates, type AgentConfig } from "@tango/core";

export interface SessionProviderOverrideStore {
  getOverride(sessionId: string, agentId: string): string | undefined;
  setOverride(input: { sessionId: string; agentId: string; providerName: string }): void;
  clearOverride(sessionId: string, agentId: string): boolean;
}

export type SessionProviderCommandStatus = "show" | "set" | "cleared" | "no-override";

export interface SessionProviderCommandResult {
  status: SessionProviderCommandStatus;
  sessionId: string;
  agentId: string;
  configuredProviders: string[];
  overrideProviderName?: string;
  effectiveProviders: string[];
}

export function mergeProviderOrder(
  configuredProviders: string[],
  overrideProviderName?: string
): string[] {
  if (!overrideProviderName || overrideProviderName.trim().length === 0) {
    return [...configuredProviders];
  }

  const normalizedOverride = overrideProviderName.trim();
  return [
    normalizedOverride,
    ...configuredProviders.filter((providerName) => providerName !== normalizedOverride)
  ];
}

export function applySessionProviderCommand(input: {
  sessionId: string;
  agent: Pick<AgentConfig, "id" | "provider">;
  clearOverride: boolean;
  providerOverride?: string;
  isSupportedProvider: (providerName: string) => boolean;
  store: SessionProviderOverrideStore;
}): SessionProviderCommandResult {
  const configuredProviders = resolveProviderCandidates(input.agent);

  if (input.clearOverride) {
    const cleared = input.store.clearOverride(input.sessionId, input.agent.id);
    const overrideProviderName = input.store.getOverride(input.sessionId, input.agent.id);

    return {
      status: cleared ? "cleared" : "no-override",
      sessionId: input.sessionId,
      agentId: input.agent.id,
      configuredProviders,
      overrideProviderName,
      effectiveProviders: mergeProviderOrder(configuredProviders, overrideProviderName)
    };
  }

  const providerOverride = input.providerOverride?.trim();
  if (providerOverride && providerOverride.length > 0) {
    if (!input.isSupportedProvider(providerOverride)) {
      throw new Error(`Unsupported provider '${providerOverride}'`);
    }

    input.store.setOverride({
      sessionId: input.sessionId,
      agentId: input.agent.id,
      providerName: providerOverride
    });

    return {
      status: "set",
      sessionId: input.sessionId,
      agentId: input.agent.id,
      configuredProviders,
      overrideProviderName: providerOverride,
      effectiveProviders: mergeProviderOrder(configuredProviders, providerOverride)
    };
  }

  const overrideProviderName = input.store.getOverride(input.sessionId, input.agent.id);
  return {
    status: "show",
    sessionId: input.sessionId,
    agentId: input.agent.id,
    configuredProviders,
    overrideProviderName,
    effectiveProviders: mergeProviderOrder(configuredProviders, overrideProviderName)
  };
}
