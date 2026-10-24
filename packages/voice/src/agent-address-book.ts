import {
  loadUnifiedAgentConfigs,
  resolveConfigDir,
  type AgentConfig,
} from "@tango/core";

export interface VoiceAddressAgent {
  id: string;
  type: string;
  displayName: string;
  callSigns: string[];
  defaultTopic?: string;
  defaultProject?: string;
  defaultPromptAgent?: string;
  kokoroVoice?: string;
  defaultChannelId?: string;
}

function toDisplayName(agent: AgentConfig): string {
  const explicit = agent.displayName?.trim();
  if (explicit) return explicit;

  return agent.id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeCallSigns(callSigns: string[] | undefined): string[] {
  if (!callSigns) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const raw of callSigns) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }

  return normalized;
}

export function toVoiceAddressAgent(
  agent: AgentConfig,
): VoiceAddressAgent | null {
  const callSigns = normalizeCallSigns(agent.voice?.callSigns);
  if (callSigns.length === 0) return null;

  return {
    id: agent.id,
    type: agent.type,
    displayName: toDisplayName(agent),
    callSigns,
    defaultTopic: agent.defaultTopic,
    defaultProject: agent.defaultProject,
    defaultPromptAgent: agent.voice?.defaultPromptAgent,
    kokoroVoice: agent.voice?.kokoroVoice,
    defaultChannelId: agent.voice?.defaultChannelId,
  };
}

export function loadVoiceAddressAgents(
  configDir?: string,
): VoiceAddressAgent[] {
  const resolvedConfigDir = resolveConfigDir(configDir);
  return loadUnifiedAgentConfigs(resolvedConfigDir)
    .map((agent) => toVoiceAddressAgent(agent))
    .filter((agent): agent is VoiceAddressAgent => agent !== null);
}
