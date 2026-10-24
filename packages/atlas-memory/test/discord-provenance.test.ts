import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mergeDiscordProvenanceIntoMemoryAddArgs,
  readDiscordProvenanceFromEnv,
} from "../src/discord-provenance.js";

describe("discord provenance for memory_add", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads discord location env vars", () => {
    vi.stubEnv("TANGO_CONVERSATION_KEY", "thread:test-thread-1");
    vi.stubEnv("TANGO_DISCORD_CHANNEL_ID", "test-channel-1");
    vi.stubEnv("TANGO_DISCORD_THREAD_ID", "test-thread-1");
    vi.stubEnv("TANGO_TURN_ID", "turn-1");
    vi.stubEnv("TANGO_MESSAGE_ID", "message-1");
    vi.stubEnv("TANGO_OCCURRED_AT", "2026-07-12T09:00:00.000Z");
    vi.stubEnv("TANGO_CONTEXT_REF", "topic:shared-knowledge");
    vi.stubEnv("TANGO_CONTEXT_LABEL", "shared-knowledge review");

    expect(readDiscordProvenanceFromEnv()).toEqual({
      conversation_key: "thread:test-thread-1",
      channel_id: "test-channel-1",
      thread_id: "test-thread-1",
      turn_id: "turn-1",
      message_id: "message-1",
      occurred_at: "2026-07-12T09:00:00.000Z",
      context_ref: "topic:shared-knowledge",
      context_label: "shared-knowledge review",
    });
  });

  it("merges env provenance into memory_add args and session_id", () => {
    vi.stubEnv("TANGO_CONVERSATION_KEY", "thread:thread-9");
    vi.stubEnv("TANGO_DISCORD_CHANNEL_ID", "forum-1");
    vi.stubEnv("TANGO_DISCORD_THREAD_ID", "thread-9");
    vi.stubEnv("TANGO_TURN_ID", "turn-9");
    vi.stubEnv("TANGO_MESSAGE_ID", "message-9");
    vi.stubEnv("TANGO_OCCURRED_AT", "2026-07-12T09:00:00.000Z");
    vi.stubEnv("TANGO_CONTEXT_REF", "topic:shared-knowledge");
    vi.stubEnv("TANGO_CONTEXT_LABEL", "shared-knowledge review");

    const merged = mergeDiscordProvenanceIntoMemoryAddArgs(
      {
        content: "The operator prefers agent saves with context.",
        source: "manual",
        agent_id: "cod-e",
        metadata: {
          captured_by: "agent_save",
        },
      },
      "cod-e",
    );

    expect(merged).toMatchObject({
      session_id: "thread:thread-9",
      metadata: {
        conversation_key: "thread:thread-9",
        channel_id: "forum-1",
        thread_id: "thread-9",
        turn_id: "turn-9",
        message_id: "message-9",
        captured_by: "agent_save",
        origin: {
          version: 1,
          kind: "manual",
          occurred_at: "2026-07-12T09:00:00.000Z",
          context_ref: "topic:shared-knowledge",
          context_label: "shared-knowledge review",
        },
      },
    });
  });

  it("preserves agent metadata over env defaults on key collision", () => {
    vi.stubEnv("TANGO_DISCORD_CHANNEL_ID", "forum-1");

    const merged = mergeDiscordProvenanceIntoMemoryAddArgs({
      content: "Override channel",
      source: "manual",
      metadata: {
        channel_id: "explicit-channel",
      },
    });

    expect(merged.metadata).toMatchObject({
      channel_id: "explicit-channel",
    });
  });

  it("keeps system provenance authoritative inside the reserved origin envelope", () => {
    vi.stubEnv("TANGO_CONTEXT_LABEL", "system context");
    vi.stubEnv("TANGO_OCCURRED_AT", "2026-07-12T09:00:00.000Z");

    const merged = mergeDiscordProvenanceIntoMemoryAddArgs({
      content: "Reserved origin fields cannot be forged by the caller.",
      source: "manual",
      metadata: {
        origin: {
          version: 1,
          kind: "import",
          occurred_at: "2099-01-01T00:00:00.000Z",
          context_label: "caller override",
        },
      },
    });

    expect(merged.metadata).toMatchObject({
      origin: {
        version: 1,
        kind: "manual",
        occurred_at: "2026-07-12T09:00:00.000Z",
        context_label: "system context",
      },
    });
  });
});
