import type { AgentRuntimeConfig, McpServerConfig } from "@tango/core";

export interface DiscordMemoryProvenance {
  conversationKey: string;
  channelId: string;
  threadId?: string;
  turnId?: string;
  messageId?: string;
  occurredAt?: string;
  contextRef?: string;
  contextLabel?: string;
}

export function buildDiscordMemoryProvenanceEnv(
  provenance: DiscordMemoryProvenance,
): Record<string, string> {
  return {
    TANGO_CONVERSATION_KEY: provenance.conversationKey,
    ...(provenance.channelId ? { TANGO_DISCORD_CHANNEL_ID: provenance.channelId } : {}),
    ...(provenance.threadId ? { TANGO_DISCORD_THREAD_ID: provenance.threadId } : {}),
    ...(provenance.turnId ? { TANGO_TURN_ID: provenance.turnId } : {}),
    ...(provenance.messageId ? { TANGO_MESSAGE_ID: provenance.messageId } : {}),
    ...(provenance.occurredAt ? { TANGO_OCCURRED_AT: provenance.occurredAt } : {}),
    ...(provenance.contextRef ? { TANGO_CONTEXT_REF: provenance.contextRef } : {}),
    ...(provenance.contextLabel ? { TANGO_CONTEXT_LABEL: provenance.contextLabel } : {}),
  };
}

function isAtlasMemoryMcpServer(server: McpServerConfig): boolean {
  if (server.name === "memory") {
    return true;
  }

  return (server.args ?? []).some((arg) => arg.includes("atlas-memory"));
}

/**
 * MCP servers whose tools act on "this conversation". `screen` needs it so a
 * staged scene carries the channel, thread and conversation key it came from
 * (taps and the desk route back to that conversation, not the agent's latest).
 * `bank-transfer` needs the triggering message id to verify owner approval.
 */
const TURN_PROVENANCE_SERVER_NAMES: ReadonlySet<string> = new Set([
  "state",
  "background-job",
  "screen",
  "bank-transfer",
]);

function acceptsTurnProvenance(server: McpServerConfig): boolean {
  return isAtlasMemoryMcpServer(server) || TURN_PROVENANCE_SERVER_NAMES.has(server.name);
}

export function augmentRuntimeConfigWithDiscordProvenance(
  config: AgentRuntimeConfig,
  provenance: DiscordMemoryProvenance,
): AgentRuntimeConfig {
  const envPatch = buildDiscordMemoryProvenanceEnv(provenance);

  return {
    ...config,
    mcpServers: config.mcpServers.map((server) => {
      if (!acceptsTurnProvenance(server)) {
        return server;
      }

      return {
        ...server,
        env: {
          ...Object.fromEntries(Object.entries(server.env ?? {}).filter(([key]) => !["TANGO_DISCORD_CHANNEL_ID", "TANGO_DISCORD_THREAD_ID"].includes(key))),
          ...envPatch,
        },
      };
    }),
    ...(config.availableMcpServers
      ? {
          availableMcpServers: config.availableMcpServers.map((server) => {
            if (!acceptsTurnProvenance(server)) {
              return server;
            }

            return {
              ...server,
              env: {
                ...Object.fromEntries(Object.entries(server.env ?? {}).filter(([key]) => !["TANGO_DISCORD_CHANNEL_ID", "TANGO_DISCORD_THREAD_ID"].includes(key))),
                ...envPatch,
              },
            };
          }),
        }
      : {}),
  };
}
