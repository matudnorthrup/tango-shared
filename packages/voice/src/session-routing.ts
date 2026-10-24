function normalizeAgentId(agentId: string): string {
  const normalized = agentId.trim();
  if (!normalized) {
    throw new Error("agentId is required.");
  }
  return normalized;
}

export function buildDefaultSessionKey(agentId: string): string {
  return `agent:${normalizeAgentId(agentId)}:main`;
}

export function buildDiscordChannelSessionKey(
  agentId: string,
  channelId: string
): string {
  const normalizedChannelId = channelId.trim();
  if (!normalizedChannelId) {
    throw new Error("channelId is required.");
  }
  return `agent:${normalizeAgentId(agentId)}:discord:channel:${normalizedChannelId}`;
}

export function countOpenAiUserPrefixes(
  agentId: string,
  sessionKey: string
): number {
  const prefix = `agent:${normalizeAgentId(agentId)}:openai-user:`;
  let key = sessionKey.trim();
  let count = 0;

  while (key.startsWith(prefix)) {
    count += 1;
    key = key.slice(prefix.length);
  }

  return count;
}

export function stripOpenAiUserPrefixes(
  agentId: string,
  sessionKey: string
): string {
  const prefix = `agent:${normalizeAgentId(agentId)}:openai-user:`;
  let key = sessionKey.trim();

  while (key.startsWith(prefix)) {
    key = key.slice(prefix.length);
  }

  return key;
}

export function extractChannelIdFromSessionKey(
  sessionKey: string
): string | null {
  const match = sessionKey.trim().match(/channel:(\d+)$/u);
  return match?.[1] ?? null;
}

export function normalizeCompletionSessionKey(
  agentId: string,
  sessionKey: string
): string {
  const stripped = stripOpenAiUserPrefixes(agentId, sessionKey);
  const channelId =
    extractChannelIdFromSessionKey(stripped) ??
    extractChannelIdFromSessionKey(sessionKey);

  if (channelId) {
    return buildDiscordChannelSessionKey(agentId, channelId);
  }

  return stripped;
}
