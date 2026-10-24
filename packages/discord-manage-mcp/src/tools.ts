import path from "node:path";

export interface DiscordManageToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(input: Record<string, unknown>): Promise<unknown>;
}

export interface DiscordManageConfig {
  botToken?: string;
  guildId?: string;
  dbPath?: string;
}

interface DiscordChannelPayload {
  id?: string;
  name?: string;
  type?: number;
  parent_id?: string | null;
  position?: number;
  topic?: string | null;
}

const CHANNEL_TYPES: Record<string, number> = {
  text: 0,
  voice: 2,
  category: 4,
  announce: 5,
  forum: 15,
};

export function resolveDatabasePath(envPath?: string): string {
  return envPath || path.join(process.env.HOME || "~", ".tango", "tango.sqlite");
}

function resolveConfig(overrides?: DiscordManageConfig): Required<DiscordManageConfig> {
  return {
    botToken: overrides?.botToken ?? process.env.DISCORD_TOKEN ?? "",
    guildId:
      overrides?.guildId ??
      process.env.DISCORD_COMMAND_GUILD_ID ??
      process.env.DISCORD_TEST_GUILD_ID ??
      "",
    dbPath: overrides?.dbPath ?? resolveDatabasePath(process.env.TANGO_DB_PATH),
  };
}

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

function simplifyChannels(data: unknown): DiscordChannelPayload[] {
  if (!Array.isArray(data)) {
    return [];
  }

  return data.map((channel) => {
    const candidate = channel as DiscordChannelPayload;
    return {
      id: candidate.id,
      name: candidate.name,
      type: candidate.type,
      parent_id: candidate.parent_id,
      position: candidate.position,
      topic: candidate.topic,
    };
  });
}

async function persistThreadSession(
  threadId: string,
  sessionId: string,
  agentId: string,
  dbPath: string,
): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);

  try {
    db.prepare(
      "INSERT OR REPLACE INTO discord_thread_sessions (thread_id, session_id, agent_id) VALUES (?, ?, ?)",
    ).run(threadId, sessionId, agentId);
  } finally {
    db.close();
  }
}

export function createDiscordManageTools(
  overrides?: DiscordManageConfig,
): DiscordManageToolDefinition[] {
  const config = resolveConfig(overrides);

  return [
    {
      name: "discord_manage",
      description: [
        "Manage the Discord server: create/edit/delete channels and threads, send messages, or make raw API calls.",
        "",
        "Operations:",
        "",
        "  list_channels — List all guild channels",
        "  create_channel — Create a text, voice, category, announce, or forum channel",
        "  edit_channel — Edit a channel name or topic",
        "  delete_channel — Delete a channel",
        "  create_thread — Create a public thread with an optional opening message",
        "  send_message — Send a message to a channel or thread",
        "  api — Make a raw Discord API call with optional {guild_id} substitution",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: [
              "list_channels",
              "create_channel",
              "edit_channel",
              "delete_channel",
              "create_thread",
              "send_message",
              "api",
            ],
          },
          channel_id: { type: "string", description: "Channel or thread ID" },
          name: { type: "string", description: "Channel/thread name" },
          topic: { type: "string", description: "Channel topic/description" },
          type: {
            type: "string",
            description: "Channel type: text, voice, category, announce, forum",
          },
          parent_id: { type: "string", description: "Parent category ID" },
          message: {
            type: "string",
            description: "Opening message for thread creation",
          },
          session_id: {
            type: "string",
            description: "Session ID for thread context continuity",
          },
          agent_id: {
            type: "string",
            description: "Agent ID for thread (defaults to victor)",
          },
          content: {
            type: "string",
            description: "Message content for send_message",
          },
          method: { type: "string", description: "HTTP method for raw API calls" },
          endpoint: {
            type: "string",
            description: "API endpoint for raw API calls",
          },
          body: { type: "object", description: "Request body for raw API calls" },
        },
        required: ["operation"],
      },
      handler: async (input) => {
        const operation = String(input.operation);
        const { botToken, guildId, dbPath } = config;

        if (!botToken) {
          return { error: "No Discord bot token configured" };
        }

        if (operation === "list_channels") {
          if (!guildId) {
            return { error: "No Discord guild ID configured" };
          }
          const { status, data } = await discordApi(
            "GET",
            `/guilds/${guildId}/channels`,
            botToken,
          );
          if (status !== 200) {
            return { error: `HTTP ${status}`, data };
          }
          return { channels: simplifyChannels(data) };
        }

        if (operation === "create_channel") {
          if (!guildId) {
            return { error: "No Discord guild ID configured" };
          }
          const type = String(input.type ?? "text");
          const body: Record<string, unknown> = {
            name: String(input.name ?? "new-channel"),
            type: CHANNEL_TYPES[type] ?? CHANNEL_TYPES.text,
          };
          if (input.parent_id) {
            body.parent_id = String(input.parent_id);
          }
          if (input.topic) {
            body.topic = String(input.topic);
          }
          const { status, data } = await discordApi(
            "POST",
            `/guilds/${guildId}/channels`,
            botToken,
            body,
          );
          if (status !== 201) {
            return { error: `HTTP ${status}`, data };
          }
          const channel = data as DiscordChannelPayload;
          return { id: channel.id, name: channel.name, type: channel.type };
        }

        if (operation === "edit_channel") {
          const channelId = String(input.channel_id ?? "");
          if (!channelId) {
            return { error: "channel_id required" };
          }
          const body: Record<string, unknown> = {};
          if (input.name) {
            body.name = String(input.name);
          }
          if (input.topic !== undefined) {
            body.topic = String(input.topic);
          }
          const { status, data } = await discordApi(
            "PATCH",
            `/channels/${channelId}`,
            botToken,
            body,
          );
          if (status !== 200) {
            return { error: `HTTP ${status}`, data };
          }
          const channel = data as DiscordChannelPayload;
          return { id: channel.id, name: channel.name, topic: channel.topic };
        }

        if (operation === "delete_channel") {
          const channelId = String(input.channel_id ?? "");
          if (!channelId) {
            return { error: "channel_id required" };
          }
          const { status, data } = await discordApi(
            "DELETE",
            `/channels/${channelId}`,
            botToken,
          );
          if (status !== 200) {
            return { error: `HTTP ${status}`, data };
          }
          return { deleted: true, id: channelId };
        }

        if (operation === "create_thread") {
          const channelId = String(input.channel_id ?? "");
          if (!channelId) {
            return { error: "channel_id required" };
          }

          const body: Record<string, unknown> = {
            name: String(input.name ?? "New Thread"),
            auto_archive_duration: 10080,
            type: 11,
          };
          if (input.message) {
            body.message = { content: String(input.message) };
          }

          const { status, data } = await discordApi(
            "POST",
            `/channels/${channelId}/threads`,
            botToken,
            body,
          );
          if (status !== 201) {
            return { error: `HTTP ${status}`, data };
          }

          const thread = data as DiscordChannelPayload;
          if (input.session_id && thread.id) {
            try {
              await persistThreadSession(
                String(thread.id),
                String(input.session_id),
                String(input.agent_id ?? "victor"),
                dbPath,
              );
            } catch (error) {
              console.error(
                "[discord_manage] Failed to store thread session mapping:",
                error instanceof Error ? error.message : error,
              );
            }
          }
          return { id: thread.id, name: thread.name };
        }

        if (operation === "send_message") {
          const channelId = String(input.channel_id ?? "");
          if (!channelId) {
            return { error: "channel_id required" };
          }
          const content = String(input.content ?? "");
          if (!content) {
            return { error: "content required" };
          }
          const { status, data } = await discordApi(
            "POST",
            `/channels/${channelId}/messages`,
            botToken,
            { content },
          );
          if (status !== 200 && status !== 201) {
            return { error: `HTTP ${status}`, data };
          }
          const message = data as { id?: string };
          return { id: message.id, channel_id: channelId };
        }

        if (operation === "api") {
          const method = String(input.method ?? "GET").toUpperCase();
          const endpoint = String(input.endpoint ?? "").replace(/\{guild_id\}/g, guildId);
          const body =
            input.body && typeof input.body === "object"
              ? (input.body as Record<string, unknown>)
              : undefined;
          const { status, data } = await discordApi(method, endpoint, botToken, body);
          return { status, data };
        }

        return { error: `Unknown operation: ${operation}` };
      },
    },
  ];
}
