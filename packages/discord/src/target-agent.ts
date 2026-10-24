import type { AgentConfig } from "@tango/core";

export interface AgentLookup {
  get(id: string): AgentConfig | undefined;
}

export function resolveTargetAgent(
  agentLookup: AgentLookup,
  routeAgentId: string,
  agentOverride: string | null
): AgentConfig | null {
  if (agentOverride) {
    const selected = agentLookup.get(agentOverride);
    if (selected) return selected;
  }

  return agentLookup.get(routeAgentId) ?? null;
}
