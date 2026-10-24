export function parseAllowedChannels(raw: string | undefined): Set<string> | null {
  const normalized = raw?.trim();
  if (!normalized) {
    return null;
  }

  const channelIds = normalized
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  return new Set(channelIds);
}

export function isChannelAllowed(
  channelId: string,
  allowlist: Set<string> | null,
): boolean {
  if (allowlist === null) {
    return true;
  }

  return allowlist.has(channelId);
}
