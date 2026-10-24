import type { AgentConfig } from "@tango/core";

const DEFAULT_REFRESH_INTERVAL_MS = 8_000;
const DISCORD_API_BASE = "https://discord.com/api/v10";

export interface AgentTypingPresenterLogger {
  warn(message: string): void;
}

export interface AgentTypingSession {
  stop(): void;
}

export interface AgentTypingPresenter {
  start(agentId: string, channelId: string): AgentTypingSession;
}

export function resolveTypingTokenFromEnv(
  envVarName: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const normalized = envVarName?.trim();
  if (!normalized) {
    return undefined;
  }

  const token = env[normalized]?.trim();
  return token || undefined;
}

export function resolveAgentTypingToken(
  agent: Pick<AgentConfig, "discord"> | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return resolveTypingTokenFromEnv(agent?.discord?.typingTokenEnv, env);
}

export async function triggerAgentTyping(
  channelId: string,
  botToken: string,
  options?: {
    fetchImpl?: typeof fetch;
    apiBaseUrl?: string;
  }
): Promise<boolean> {
  const normalizedChannelId = channelId.trim();
  const normalizedToken = botToken.trim();
  if (!normalizedChannelId || !normalizedToken) {
    return false;
  }

  const fetchImpl = options?.fetchImpl ?? fetch;
  const apiBaseUrl = options?.apiBaseUrl ?? DISCORD_API_BASE;

  try {
    const response = await fetchImpl(`${apiBaseUrl}/channels/${normalizedChannelId}/typing`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${normalizedToken}`,
      },
    });

    return response.status === 204 || response.status === 200;
  } catch {
    return false;
  }
}

export function createAgentTypingPresenter(options: {
  resolveAgentTypingToken: (agentId: string) => string | undefined;
  defaultToken?: string;
  refreshIntervalMs?: number;
  fetchImpl?: typeof fetch;
  logger?: AgentTypingPresenterLogger;
}): AgentTypingPresenter {
  const refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  const fetchImpl = options.fetchImpl;
  const logger = options.logger ?? {
    warn(message: string): void {
      console.warn(message);
    },
  };

  return {
    start(agentId, channelId) {
      const normalizedAgentId = agentId.trim();
      const normalizedChannelId = channelId.trim();
      if (!normalizedAgentId || !normalizedChannelId) {
        return { stop() {} };
      }

      const perAgentToken = options.resolveAgentTypingToken(normalizedAgentId);
      const botToken = perAgentToken ?? (options.defaultToken?.trim() || undefined);
      if (!botToken) {
        return { stop() {} };
      }

      let stopped = false;
      let interval: ReturnType<typeof setInterval> | undefined;

      const pulse = (): void => {
        void triggerAgentTyping(normalizedChannelId, botToken, { fetchImpl }).then((ok) => {
          if (!ok && !stopped) {
            logger.warn(
              `[tango-discord] agent typing failed agent=${normalizedAgentId} channel=${normalizedChannelId}`
            );
          }
        });
      };

      pulse();
      interval = setInterval(pulse, refreshIntervalMs);

      return {
        stop() {
          if (stopped) {
            return;
          }
          stopped = true;
          if (interval) {
            clearInterval(interval);
            interval = undefined;
          }
        },
      };
    },
  };
}
