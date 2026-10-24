import {
  SessionManager,
  loadSessionConfigs,
  resolveConfigDir,
  type RouteResult
} from "@tango/core";

export type VoiceTangoSessionManager = Pick<
  SessionManager,
  "route" | "listSessions"
>;

export interface VoiceTangoRoute {
  sessionId: string;
  agentId: string;
  source: "tango-config" | "fallback";
  channelKey: string;
  matchedChannelKey?: string;
  routeAgentId?: string;
}

export function loadTangoSessionManager(
  configDir?: string
): VoiceTangoSessionManager {
  const resolvedConfigDir = resolveConfigDir(configDir);
  const sessionConfigs = loadSessionConfigs(resolvedConfigDir);
  return new SessionManager(sessionConfigs);
}

export function resolveVoiceTangoRoute(input: {
  sessionManager?: VoiceTangoSessionManager | null;
  channelId?: string | null;
  fallbackSessionId: string;
  fallbackAgentId: string;
}): VoiceTangoRoute {
  const requestedChannelKey = input.channelId?.trim()
    ? `discord:${input.channelId.trim()}`
    : "discord:default";
  const routeKeys =
    requestedChannelKey === "discord:default"
      ? [requestedChannelKey]
      : [requestedChannelKey, "discord:default"];

  for (const routeChannelKey of routeKeys) {
    const route = input.sessionManager?.route(routeChannelKey) ?? null;
    if (!route) continue;

    return {
      sessionId: route.sessionId,
      agentId: route.agentId,
      source: "tango-config",
      channelKey: requestedChannelKey,
      matchedChannelKey: routeChannelKey,
      routeAgentId: route.agentId
    };
  }

  return {
    sessionId: input.fallbackSessionId,
    agentId: input.fallbackAgentId,
    source: "fallback",
    channelKey: requestedChannelKey
  };
}
