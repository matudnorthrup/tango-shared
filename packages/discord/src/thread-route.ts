export interface DiscordRoute {
  sessionId: string;
  agentId: string;
}

export interface RegisteredThreadSession {
  sessionId: string;
  agentId: string | null;
}

export function applyThreadSessionRoute(
  route: DiscordRoute,
  threadSession: RegisteredThreadSession,
): DiscordRoute {
  const threadAgentId = threadSession.agentId?.trim();
  return {
    ...route,
    sessionId: threadSession.sessionId,
    agentId: threadAgentId && threadAgentId.length > 0 ? threadAgentId : route.agentId,
  };
}
