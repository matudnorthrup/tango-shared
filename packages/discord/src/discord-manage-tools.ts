/**
 * Discord Management Tools — Server management via the Discord API.
 *
 * Tools:
 *   - discord_manage: Create/edit/delete channels, threads, and manage server structure
 */

import { resolveDatabasePath, type AgentTool } from "@tango/core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface DiscordManageConfig {
  botToken?: string;
  guildId?: string;
  storage?: {
    setThreadSession(threadId: string, sessionId: string, agentId?: string): void;
  };
}

function resolveConfig(overrides?: DiscordManageConfig) {
  return {
    botToken: overrides?.botToken ?? process.env.DISCORD_TOKEN ?? "",
    guildId: overrides?.guildId
      ?? process.env.DISCORD_COMMAND_GUILD_ID
      ?? process.env.DISCORD_TEST_GUILD_ID
      ?? "",
    storage: overrides?.storage,
  };
}

// ---------------------------------------------------------------------------
// Discord API helper
// ---------------------------------------------------------------------------

async function discordApi(
  method: string,
  endpoint: string,
  botToken: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: unknown }> {
  const url = `https://discord.com/api/v10${endpoint}`;
  const headers: Record<string, string> = {
    Authorization: `Bot ${botToken}`,
    "Content-Type": "application/json",
  };

  const fetchOptions: RequestInit = { method, headers };
  if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
    fetchOptions.body = JSON.stringify(body);
  }

  const response = await fetch(url, fetchOptions);
  const text = await response.text();

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return { status: response.status, data };
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export function createDiscordManageTools(overrides?: DiscordManageConfig): AgentTool[] {
  const config = resolveConfig(overrides);

  return [
    {
      name: "discord_manage",
      description: [
        "Manage the Discord server: create/edit/delete channels and threads.",
        "",
        "Operations:",
        "",
        "  list_channels — List all channels in the server",
        "    { \"operation\": \"list_channels\" }",
        "",
        "  create_channel — Create a text, forum, voice, or category channel",
        "    { \"operation\": \"create_channel\", \"name\": \"my-channel\", \"type\": \"text\", \"parent_id\": \"category_id\", \"topic\": \"Description\" }",
        "    Types: text (0), voice (2), category (4), announce (5), forum (15)",
        "",
        "  edit_channel — Edit a channel's name, topic, or position",
        "    { \"operation\": \"edit_channel\", \"channel_id\": \"...\", \"name\": \"new-name\", \"topic\": \"new topic\" }",
        "",
        "  delete_channel — Delete a channel",
        "    { \"operation\": \"delete_channel\", \"channel_id\": \"...\" }",
        "",
        "  create_thread — Create a thread in a channel",
        "    { \"operation\": \"create_thread\", \"channel_id\": \"...\", \"name\": \"Thread Title\", \"message\": \"Opening message\", \"session_id\": \"victor\", \"agent_id\": \"victor\" }",
        "    session_id + agent_id (optional): if provided, replies to this thread resume that session for context continuity",
        "",
        "  send_message — Send a message to a channel or thread",
        "    { \"operation\": \"send_message\", \"channel_id\": \"...\", \"content\": \"Message text\" }",
        "",
        "  api — Raw Discord API call (for anything not covered above)",
        "    { \"operation\": \"api\", \"method\": \"GET\", \"endpoint\": \"/guilds/{guild_id}/members?limit=10\" }",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["list_channels", "create_channel", "edit_channel", "delete_channel", "create_thread", "send_message", "api"],
            description: "Operation to perform",
          },
          channel_id: { type: "string", description: "Channel or thread ID" },
          name: { type: "string", description: "Channel/thread name" },
          topic: { type: "string", description: "Channel topic/description" },
          type: { type: "string", description: "Channel type: text, voice, category, announce, forum" },
          parent_id: { type: "string", description: "Parent category ID for channel creation" },
          message: { type: "string", description: "Opening message for thread creation" },
          session_id: { type: "string", description: "Session ID to associate with this thread for context continuity (create_thread only)" },
          agent_id: { type: "string", description: "Agent ID to associate with this thread (create_thread only, defaults to 'victor')" },
          content: { type: "string", description: "Message content for send_message" },
          method: { type: "string", description: "HTTP method for raw API calls" },
          endpoint: { type: "string", description: "API endpoint for raw API calls" },
          body: { type: "object", description: "Request body for raw API calls" },
        },
        required: ["operation"],
      },
      handler: async (input) => {
        const op = String(input.operation);
        const { botToken, guildId, storage } = config;

        if (!botToken) return { error: "No Discord bot token configured" };

        const channelTypes: Record<string, number> = {
          text: 0, voice: 2, category: 4, announce: 5, forum: 15,
        };

        if (op === "list_channels") {
          const { status, data } = await discordApi("GET", `/guilds/${guildId}/channels`, botToken);
          if (status !== 200) return { error: `HTTP ${status}`, data };
          // Simplify the output
          const channels = (data as Array<Record<string, unknown>>).map((c) => ({
            id: c.id,
            name: c.name,
            type: c.type,
            parent_id: c.parent_id,
            position: c.position,
            topic: c.topic,
          }));
          return { channels };
        }

        if (op === "create_channel") {
          const typeStr = String(input.type ?? "text");
          const typeNum = channelTypes[typeStr] ?? 0;
          const body: Record<string, unknown> = {
            name: String(input.name ?? "new-channel"),
            type: typeNum,
          };
          if (input.parent_id) body.parent_id = String(input.parent_id);
          if (input.topic) body.topic = String(input.topic);
          const { status, data } = await discordApi("POST", `/guilds/${guildId}/channels`, botToken, body);
          if (status !== 201) return { error: `HTTP ${status}`, data };
          const ch = data as Record<string, unknown>;
          return { id: ch.id, name: ch.name, type: ch.type };
        }

        if (op === "edit_channel") {
          const channelId = String(input.channel_id ?? "");
          if (!channelId) return { error: "channel_id required" };
          const body: Record<string, unknown> = {};
          if (input.name) body.name = String(input.name);
          if (input.topic !== undefined) body.topic = String(input.topic);
          const { status, data } = await discordApi("PATCH", `/channels/${channelId}`, botToken, body);
          if (status !== 200) return { error: `HTTP ${status}`, data };
          const ch = data as Record<string, unknown>;
          return { id: ch.id, name: ch.name, topic: ch.topic };
        }

        if (op === "delete_channel") {
          const channelId = String(input.channel_id ?? "");
          if (!channelId) return { error: "channel_id required" };
          const { status, data } = await discordApi("DELETE", `/channels/${channelId}`, botToken);
          if (status !== 200) return { error: `HTTP ${status}`, data };
          return { deleted: true, id: channelId };
        }

        if (op === "create_thread") {
          const channelId = String(input.channel_id ?? "");
          if (!channelId) return { error: "channel_id required" };
          const threadName = String(input.name ?? "New Thread");
          // Create thread with an initial message
          const body: Record<string, unknown> = {
            name: threadName,
            auto_archive_duration: 10080,
            type: 11, // public thread
          };
          if (input.message) {
            body.message = { content: String(input.message) };
          }
          const { status, data } = await discordApi("POST", `/channels/${channelId}/threads`, botToken, body);
          if (status !== 201) return { error: `HTTP ${status}`, data };
          const thread = data as Record<string, unknown>;
          // Store thread → session mapping so replies resume the originating session
          if (input.session_id && thread.id) {
            try {
              const { DatabaseSync } = await import("node:sqlite");
              const dbPath = resolveDatabasePath(process.env.TANGO_DB_PATH);
              const db = new DatabaseSync(dbPath);
              db.prepare(
                `INSERT OR REPLACE INTO discord_thread_sessions (thread_id, session_id, agent_id) VALUES (?, ?, ?)`
              ).run(
                String(thread.id),
                String(input.session_id),
                input.agent_id ? String(input.agent_id) : null
              );
              db.close();
            } catch (e: unknown) {
              console.error("[discord_manage] Failed to store thread session mapping:", e instanceof Error ? e.message : e);
            }
          }
          return { id: thread.id, name: thread.name };
        }

        if (op === "send_message") {
          const channelId = String(input.channel_id ?? "");
          if (!channelId) return { error: "channel_id required" };
          const content = String(input.content ?? "");
          if (!content) return { error: "content required" };
          const { status, data } = await discordApi("POST", `/channels/${channelId}/messages`, botToken, { content });
          if (status !== 200 && status !== 201) return { error: `HTTP ${status}`, data };
          const msg = data as Record<string, unknown>;
          return { id: msg.id, channel_id: channelId };
        }

        if (op === "api") {
          const method = String(input.method ?? "GET").toUpperCase();
          let endpoint = String(input.endpoint ?? "");
          // Replace {guild_id} placeholder
          endpoint = endpoint.replace(/\{guild_id\}/g, guildId);
          const body = input.body as Record<string, unknown> | undefined;
          const { status, data } = await discordApi(method, endpoint, botToken, body);
          return { status, data };
        }

        return { error: `Unknown operation: ${op}` };
      },
    },
  ];
}
