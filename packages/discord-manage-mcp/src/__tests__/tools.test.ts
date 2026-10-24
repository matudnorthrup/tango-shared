import { afterEach, describe, expect, it, vi } from "vitest";

interface DiscordManageTool {
  name: string;
  handler(input: Record<string, unknown>): Promise<unknown>;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.unmock("node:sqlite");
});

function mockDiscordResponse(status: number, data: unknown): Response {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return {
    status,
    text: vi.fn(async () => text),
  } as unknown as Response;
}

async function loadDiscordManageTool(overrides?: {
  botToken?: string;
  guildId?: string;
  dbPath?: string;
}): Promise<DiscordManageTool> {
  const { createDiscordManageTools } = await import("../tools.js");
  const tool = createDiscordManageTools(overrides).find(
    (candidate) => candidate.name === "discord_manage",
  );
  expect(tool).toBeDefined();
  return tool as DiscordManageTool;
}

describe("discord_manage", () => {
  it("lists channels with simplified output", async () => {
    vi.stubEnv("DISCORD_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_COMMAND_GUILD_ID", "guild-123");
    const fetchMock = vi.fn(async () =>
      mockDiscordResponse(200, [
        {
          id: "chan-1",
          name: "general",
          type: 0,
          parent_id: null,
          position: 1,
          topic: "Team chat",
          ignored: "extra",
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const tool = await loadDiscordManageTool();
    const result = await tool.handler({ operation: "list_channels" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/guilds/guild-123/channels",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bot bot-token",
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(result).toEqual({
      channels: [
        {
          id: "chan-1",
          name: "general",
          type: 0,
          parent_id: null,
          position: 1,
          topic: "Team chat",
        },
      ],
    });
  });

  it("creates a channel with the mapped Discord type", async () => {
    vi.stubEnv("DISCORD_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_COMMAND_GUILD_ID", "guild-123");
    const fetchMock = vi.fn(async () =>
      mockDiscordResponse(201, { id: "chan-2", name: "announcements", type: 15 }),
    );
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const tool = await loadDiscordManageTool();
    const result = await tool.handler({
      operation: "create_channel",
      name: "announcements",
      type: "forum",
      parent_id: "cat-9",
      topic: "Release notes",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/guilds/guild-123/channels",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "announcements",
          type: 15,
          parent_id: "cat-9",
          topic: "Release notes",
        }),
      }),
    );
    expect(result).toEqual({ id: "chan-2", name: "announcements", type: 15 });
  });

  it("edits a channel with a PATCH body", async () => {
    vi.stubEnv("DISCORD_TOKEN", "bot-token");
    const fetchMock = vi.fn(async () =>
      mockDiscordResponse(200, {
        id: "chan-3",
        name: "eng-updates",
        topic: "Updated topic",
      }),
    );
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const tool = await loadDiscordManageTool();
    const result = await tool.handler({
      operation: "edit_channel",
      channel_id: "chan-3",
      name: "eng-updates",
      topic: "Updated topic",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/chan-3",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          name: "eng-updates",
          topic: "Updated topic",
        }),
      }),
    );
    expect(result).toEqual({
      id: "chan-3",
      name: "eng-updates",
      topic: "Updated topic",
    });
  });

  it("deletes a channel", async () => {
    vi.stubEnv("DISCORD_TOKEN", "bot-token");
    const fetchMock = vi.fn(async () => mockDiscordResponse(200, { id: "chan-4" }));
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const tool = await loadDiscordManageTool();
    const result = await tool.handler({
      operation: "delete_channel",
      channel_id: "chan-4",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/chan-4",
      expect.objectContaining({
        method: "DELETE",
      }),
    );
    expect(result).toEqual({ deleted: true, id: "chan-4" });
  });

  it("sends a message", async () => {
    vi.stubEnv("DISCORD_TOKEN", "bot-token");
    const fetchMock = vi.fn(async () => mockDiscordResponse(201, { id: "msg-1" }));
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const tool = await loadDiscordManageTool();
    const result = await tool.handler({
      operation: "send_message",
      channel_id: "chan-5",
      content: "Deploy complete",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/chan-5/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ content: "Deploy complete" }),
      }),
    );
    expect(result).toEqual({ id: "msg-1", channel_id: "chan-5" });
  });

  it("substitutes {guild_id} in raw API calls", async () => {
    vi.stubEnv("DISCORD_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_COMMAND_GUILD_ID", "guild-123");
    const fetchMock = vi.fn(async () => mockDiscordResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const tool = await loadDiscordManageTool();
    const result = await tool.handler({
      operation: "api",
      method: "GET",
      endpoint: "/guilds/{guild_id}/members?limit=10",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/guilds/guild-123/members?limit=10",
      expect.objectContaining({
        method: "GET",
      }),
    );
    expect(result).toEqual({ status: 200, data: { ok: true } });
  });

  it("returns an error when the token is missing", async () => {
    vi.stubEnv("DISCORD_TOKEN", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const tool = await loadDiscordManageTool();
    const result = await tool.handler({ operation: "list_channels" });

    expect(result).toEqual({ error: "No Discord bot token configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a thread and stores the session mapping in SQLite", async () => {
    vi.stubEnv("DISCORD_TOKEN", "bot-token");
    vi.stubEnv("TANGO_DB_PATH", "/tmp/tango.sqlite");
    const fetchMock = vi.fn(async () =>
      mockDiscordResponse(201, { id: "thread-1", name: "Sprint Planning" }),
    );
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const runMock = vi.fn();
    const prepareMock = vi.fn(() => ({ run: runMock }));
    const closeMock = vi.fn();
    const DatabaseSync = vi.fn(() => ({
      prepare: prepareMock,
      close: closeMock,
    }));
    vi.doMock("node:sqlite", () => ({ DatabaseSync }));

    const tool = await loadDiscordManageTool();
    const result = await tool.handler({
      operation: "create_thread",
      channel_id: "chan-6",
      name: "Sprint Planning",
      message: "Kickoff notes",
      session_id: "session-42",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/chan-6/threads",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "Sprint Planning",
          auto_archive_duration: 10080,
          type: 11,
          message: { content: "Kickoff notes" },
        }),
      }),
    );
    expect(DatabaseSync).toHaveBeenCalledWith("/tmp/tango.sqlite");
    expect(prepareMock).toHaveBeenCalledWith(
      "INSERT OR REPLACE INTO discord_thread_sessions (thread_id, session_id, agent_id) VALUES (?, ?, ?)",
    );
    expect(runMock).toHaveBeenCalledWith("thread-1", "session-42", "victor");
    expect(closeMock).toHaveBeenCalled();
    expect(result).toEqual({ id: "thread-1", name: "Sprint Planning" });
  });
});
