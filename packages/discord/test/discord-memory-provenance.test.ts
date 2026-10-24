import type { AgentRuntimeConfig } from "@tango/core";
import { describe, expect, it } from "vitest";
import {
  augmentRuntimeConfigWithDiscordProvenance,
  buildDiscordMemoryProvenanceEnv,
} from "../src/discord-memory-provenance.js";

function createConfig(): AgentRuntimeConfig {
  return {
    agentId: "cod-e",
    systemPrompt: "test",
    mcpServers: [
      {
        name: "memory",
        command: "node",
        args: ["packages/atlas-memory/dist/index.js"],
        env: {
          WORKER_ID: "cod-e",
        },
      },
      {
        name: "attachments",
        command: "node",
        args: ["packages/core/dist/mcp-proxy.js", "attachments"],
      },
    ],
    runtimePreferences: {
      model: "claude-sonnet-4-6",
      timeout: 30_000,
    },
  };
}

describe("discord memory provenance runtime config", () => {
  it("builds env patch for conversation location", () => {
    expect(
      buildDiscordMemoryProvenanceEnv({
        conversationKey: "thread:test-thread-1",
        channelId: "test-channel-1",
        threadId: "test-thread-1",
        turnId: "turn-1",
        messageId: "message-1",
        occurredAt: "2026-07-12T09:00:00.000Z",
        contextRef: "topic:shared-knowledge",
        contextLabel: "shared-knowledge review",
      }),
    ).toEqual({
      TANGO_CONVERSATION_KEY: "thread:test-thread-1",
      TANGO_DISCORD_CHANNEL_ID: "test-channel-1",
      TANGO_DISCORD_THREAD_ID: "test-thread-1",
      TANGO_TURN_ID: "turn-1",
      TANGO_MESSAGE_ID: "message-1",
      TANGO_OCCURRED_AT: "2026-07-12T09:00:00.000Z",
      TANGO_CONTEXT_REF: "topic:shared-knowledge",
      TANGO_CONTEXT_LABEL: "shared-knowledge review",
    });
  });

  it("augments only the atlas-memory MCP server env", () => {
    const augmented = augmentRuntimeConfigWithDiscordProvenance(createConfig(), {
      conversationKey: "thread:thread-9",
      channelId: "forum-1",
      threadId: "thread-9",
      turnId: "turn-9",
      messageId: "message-9",
      occurredAt: "2026-07-12T09:00:00.000Z",
      contextRef: "topic:shared-knowledge",
      contextLabel: "shared-knowledge review",
    });

    expect(augmented.mcpServers[0]?.env).toMatchObject({
      WORKER_ID: "cod-e",
      TANGO_CONVERSATION_KEY: "thread:thread-9",
      TANGO_DISCORD_CHANNEL_ID: "forum-1",
      TANGO_DISCORD_THREAD_ID: "thread-9",
      TANGO_TURN_ID: "turn-9",
      TANGO_MESSAGE_ID: "message-9",
      TANGO_OCCURRED_AT: "2026-07-12T09:00:00.000Z",
      TANGO_CONTEXT_REF: "topic:shared-knowledge",
      TANGO_CONTEXT_LABEL: "shared-knowledge review",
    });
    expect(augmented.mcpServers[1]?.env).toBeUndefined();
  });

  it("gives the screen proxy turn provenance so scenes carry their conversation", () => {
    const config = createConfig();
    config.mcpServers.push({
      name: "screen",
      command: "node",
      args: ["packages/core/dist/mcp-proxy.js", "screen"],
      env: { ALLOWED_TOOL_IDS: "screen" },
    });
    config.availableMcpServers = [{
      name: "screen",
      command: "node",
      args: ["packages/core/dist/mcp-proxy.js", "screen"],
    }];
    const augmented = augmentRuntimeConfigWithDiscordProvenance(config, {
      conversationKey: "thread:thread-9",
      channelId: "forum-1",
      threadId: "thread-9",
      turnId: "turn-9",
    });

    const screen = augmented.mcpServers.find((server) => server.name === "screen");
    expect(screen?.env).toEqual({
      ALLOWED_TOOL_IDS: "screen",
      TANGO_CONVERSATION_KEY: "thread:thread-9",
      TANGO_DISCORD_CHANNEL_ID: "forum-1",
      TANGO_DISCORD_THREAD_ID: "thread-9",
      TANGO_TURN_ID: "turn-9",
    });
    expect(augmented.availableMcpServers?.[0]?.env).toMatchObject({
      TANGO_CONVERSATION_KEY: "thread:thread-9",
      TANGO_DISCORD_CHANNEL_ID: "forum-1",
    });
    // Unrelated proxies stay untouched.
    expect(augmented.mcpServers.find((server) => server.name === "attachments")?.env).toBeUndefined();
  });
});

describe("per-turn provenance and session resume", () => {
  it("lists every per-turn key in core's PER_TURN_PROVENANCE_ENV_KEYS", async () => {
    const { PER_TURN_PROVENANCE_ENV_KEYS } = await import("@tango/core");
    const a = buildDiscordMemoryProvenanceEnv({
      conversationKey: "k", channelId: "c", threadId: "t", turnId: "1", messageId: "m1",
      occurredAt: "2026-10-03T00:00:00Z", contextRef: "r1", contextLabel: "l1",
    });
    const b = buildDiscordMemoryProvenanceEnv({
      conversationKey: "k", channelId: "c", threadId: "t", turnId: "2", messageId: "m2",
      occurredAt: "2026-10-03T00:01:00Z", contextRef: "r2", contextLabel: "l2",
    });
    // Anything that differs between two turns of one conversation must not break resume.
    const changing = Object.keys(a).filter((key) => a[key] !== b[key]);
    expect(changing.length).toBeGreaterThan(0);
    for (const key of changing) expect(PER_TURN_PROVENANCE_ENV_KEYS.has(key)).toBe(true);
  });
});
