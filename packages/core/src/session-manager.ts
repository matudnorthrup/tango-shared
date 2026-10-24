import type { RouteResult, SessionConfig } from "./types.js";

export class SessionManager {
  private readonly channelToSession = new Map<string, SessionConfig>();

  constructor(private readonly sessions: SessionConfig[]) {
    for (const session of sessions) {
      for (const channel of session.channels) {
        this.channelToSession.set(channel, session);
      }
    }
  }

  route(channelKey: string): RouteResult | null {
    const session = this.channelToSession.get(channelKey);
    if (!session) return null;
    return {
      sessionId: session.id,
      agentId: session.agent
    };
  }

  listSessions(): SessionConfig[] {
    return this.sessions;
  }
}
