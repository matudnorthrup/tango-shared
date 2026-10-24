import type { AccessMode, AgentConfig, SessionConfig } from "@tango/core";

export interface AccessPolicy {
  mode: AccessMode;
  allowlistChannelIds: Set<string>;
  allowlistUserIds: Set<string>;
}

export interface AccessEvaluationInput {
  channelId: string;
  threadChannelId?: string;
  userId: string;
  mentioned: boolean;
}

export interface AccessEvaluationResult {
  allowed: boolean;
  mode: AccessMode;
  mentionRequired: boolean;
  mentioned: boolean;
  channelAllowed: boolean;
  userAllowed: boolean;
  reason: string;
}

export function parseCsvIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function extractConfiguredDiscordChannelIds(sessions: SessionConfig[]): string[] {
  const set = new Set<string>();
  for (const session of sessions) {
    for (const channel of session.channels) {
      if (!channel.startsWith("discord:")) continue;
      const channelId = channel.slice("discord:".length).trim();
      if (!channelId || channelId === "default") continue;
      set.add(channelId);
    }
  }
  return [...set];
}

export function buildDefaultAccessPolicy(input: {
  mode: AccessMode;
  allowlistChannelIds: string[];
  allowlistUserIds: string[];
}): AccessPolicy {
  return {
    mode: input.mode,
    allowlistChannelIds: new Set(input.allowlistChannelIds),
    allowlistUserIds: new Set(input.allowlistUserIds)
  };
}

export function resolveAccessPolicy(agent: AgentConfig, defaults: AccessPolicy): AccessPolicy {
  return {
    mode: agent.access?.mode ?? defaults.mode,
    allowlistChannelIds:
      agent.access?.allowlistChannelIds !== undefined
        ? new Set(agent.access.allowlistChannelIds)
        : defaults.allowlistChannelIds,
    allowlistUserIds:
      agent.access?.allowlistUserIds !== undefined
        ? new Set(agent.access.allowlistUserIds)
        : defaults.allowlistUserIds
  };
}

function evaluateAllowlist(input: AccessEvaluationInput, policy: AccessPolicy): {
  channelAllowed: boolean;
  userAllowed: boolean;
  allowed: boolean;
} {
  const channelAllowed =
    policy.allowlistChannelIds.size === 0
      ? true
      : policy.allowlistChannelIds.has(input.channelId) ||
        (!!input.threadChannelId && policy.allowlistChannelIds.has(input.threadChannelId));
  const userAllowed =
    policy.allowlistUserIds.size === 0 ? true : policy.allowlistUserIds.has(input.userId);
  return {
    channelAllowed,
    userAllowed,
    allowed: channelAllowed && userAllowed
  };
}

export function evaluateAccess(
  input: AccessEvaluationInput,
  policy: AccessPolicy
): AccessEvaluationResult {
  const mentionRequired = policy.mode === "mention" || policy.mode === "both";
  const allowlistRequired = policy.mode === "allowlist" || policy.mode === "both";
  const allowlist = evaluateAllowlist(input, policy);

  if (policy.mode === "off") {
    return {
      allowed: true,
      mode: policy.mode,
      mentionRequired,
      mentioned: input.mentioned,
      channelAllowed: allowlist.channelAllowed,
      userAllowed: allowlist.userAllowed,
      reason: "mode-off"
    };
  }

  const mentionPass = mentionRequired ? input.mentioned : true;
  const allowlistPass = allowlistRequired ? allowlist.allowed : true;
  const allowed = mentionPass && allowlistPass;

  let reason = "ok";
  if (!mentionPass) {
    reason = "missing-mention";
  } else if (!allowlist.channelAllowed && !allowlist.userAllowed) {
    reason = "channel-and-user-not-allowlisted";
  } else if (!allowlist.channelAllowed) {
    reason = "channel-not-allowlisted";
  } else if (!allowlist.userAllowed) {
    reason = "user-not-allowlisted";
  }

  return {
    allowed,
    mode: policy.mode,
    mentionRequired,
    mentioned: input.mentioned,
    channelAllowed: allowlist.channelAllowed,
    userAllowed: allowlist.userAllowed,
    reason
  };
}
