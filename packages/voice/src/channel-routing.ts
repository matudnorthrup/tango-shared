import {
  buildDefaultSessionKey,
  buildDiscordChannelSessionKey
} from "./session-routing.js";

export interface VoiceChannelDefinition {
  displayName: string;
  channelId: string;
  topicPrompt: string | null;
  sessionKey?: string;
  inboxExclude?: boolean;
  parentChannelId?: string;
}

export interface VoiceChannelSessionEntry {
  name: string;
  displayName: string;
  sessionKey: string;
}

export function buildChannelSystemPrompt(
  basePrompt: string,
  topicPrompt: string | null | undefined
): string {
  if (!topicPrompt) {
    return basePrompt;
  }

  return `${basePrompt}\n\n---\n\nTopic context for this channel:\n${topicPrompt}`;
}

export function createAdhocChannelDefinition(input: {
  channelId: string;
  displayName: string;
  parentChannelId?: string;
}): VoiceChannelDefinition {
  const displayName = input.displayName.trim().replace(/^#+/u, "");
  return {
    displayName: `#${displayName}`,
    channelId: input.channelId.trim(),
    topicPrompt: `This is the #${displayName} channel. Use recent conversation history for context.`,
    parentChannelId: input.parentChannelId?.trim() || undefined,
  };
}

export function resolveChannelSessionKey(
  agentId: string,
  definition?: Pick<VoiceChannelDefinition, "channelId" | "sessionKey"> | null
): string {
  if (definition?.sessionKey) return definition.sessionKey;
  if (definition?.channelId) {
    return buildDiscordChannelSessionKey(agentId, definition.channelId);
  }
  return buildDefaultSessionKey(agentId);
}

export function listChannelSessionEntries(
  agentId: string,
  channels: Record<string, VoiceChannelDefinition>
): VoiceChannelSessionEntry[] {
  const result: VoiceChannelSessionEntry[] = [];
  let hasDefault = false;

  for (const [name, definition] of Object.entries(channels)) {
    if (!definition.channelId && !definition.sessionKey) continue;
    if (definition.inboxExclude) continue;
    if (name === "default") hasDefault = true;

    result.push({
      name,
      displayName: definition.displayName,
      sessionKey: resolveChannelSessionKey(agentId, definition)
    });
  }

  if (!hasDefault) {
    result.push({
      name: "default",
      displayName: channels.default?.displayName || "General",
      sessionKey: buildDefaultSessionKey(agentId)
    });
  }

  return result;
}

export function channelSearchForms(text: string): string[] {
  const base = text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (!base) return [""];

  const singularish = base
    .split(" ")
    .map((token) => {
      if (token.length <= 3) return token;
      if (token.endsWith("ss")) return token;
      if (token.endsWith("s")) return token.slice(0, -1);
      return token;
    })
    .join(" ");

  const compactBase = base.replace(/\s+/g, "");
  const compactSingularish = singularish.replace(/\s+/g, "");
  const spacedHyphenSplit = base.replace(/-/g, " ");

  return Array.from(
    new Set(
      [
        base,
        singularish,
        compactBase,
        compactSingularish,
        spacedHyphenSplit
      ].filter(Boolean)
    )
  );
}

export function channelSearchScore(
  query: string,
  candidate: string
): number {
  const queryForms = channelSearchForms(query);
  const candidateForms = channelSearchForms(candidate);

  let best = 0;
  for (const queryForm of queryForms) {
    for (const candidateForm of candidateForms) {
      if (!queryForm || !candidateForm) continue;
      if (queryForm === candidateForm) {
        best = Math.max(best, 100);
        continue;
      }
      if (
        queryForm.startsWith(candidateForm) ||
        candidateForm.startsWith(queryForm)
      ) {
        best = Math.max(best, 85);
        continue;
      }
      if (
        queryForm.includes(candidateForm) ||
        candidateForm.includes(queryForm)
      ) {
        best = Math.max(best, 70);
      }
    }
  }

  return best;
}

export function normalizeForumMatchText(input: string): string {
  return input
    .toLowerCase()
    .replace(/\b(?:forum|forums|channel|topic|thread|post|the|my)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "");
}
