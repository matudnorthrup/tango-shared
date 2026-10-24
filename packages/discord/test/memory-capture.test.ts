import { afterEach, describe, expect, it, vi } from "vitest";

import type { AtlasMemoryClient } from "../src/atlas-memory-client.js";
import {
  extractAndStoreMemories,
  type MemoryCaptureConfig,
  type MemoryCaptureContext,
} from "../src/memory-capture.js";

const generate = vi.fn();
const mockProvider = { generate } as unknown as Parameters<typeof extractAndStoreMemories>[3];

const baseConfig: MemoryCaptureConfig = {
  enabled: true,
  extractionProvider: "claude-oauth",
  extractionModel: "claude-haiku-4-5",
  importanceThreshold: 0.4,
};

const baseContext: MemoryCaptureContext = {
  conversationKey: "thread:thread-1",
  agentId: "malibu",
  userMessage: "I prefer short updates and want weekly reviews on Monday.",
  agentResponse: "Understood. I will keep updates brief and leave the weekly review on Monday.",
  channelId: "channel-1",
  threadId: "thread-1",
};

afterEach(() => {
  generate.mockReset();
  vi.restoreAllMocks();
});

describe("extractAndStoreMemories", () => {
  it("extracts memories from the injected provider response and stores them in Atlas", async () => {
    generate.mockResolvedValue({
      text: [
        "```json",
        JSON.stringify([
          {
            content: "User prefers short updates.",
            importance: 0.8,
            tags: ["Preference", "Tone"],
          },
        ]),
        "```",
      ].join("\n"),
    });

    const memoryAdd = vi.fn().mockResolvedValue({ id: "memory-1" });

    await extractAndStoreMemories(
      {
        ...baseContext,
        turnId: "turn-1",
        requestMessageId: 41,
        responseMessageId: 42,
        discordRequestMessageId: "discord-request-1",
        discordResponseMessageId: "discord-response-1",
        occurredAt: "2026-07-12T09:00:00.000Z",
        contextRef: "topic:shared-knowledge",
        contextLabel: "shared-knowledge review",
      },
      baseConfig,
      { memoryAdd } as unknown as AtlasMemoryClient,
      mockProvider,
    );

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      model: "claude-haiku-4-5",
      reasoningEffort: "low",
    }));
    expect(memoryAdd).toHaveBeenCalledWith({
      content: "User prefers short updates.",
      source: "conversation",
      agent_id: "malibu",
      session_id: "thread:thread-1",
      importance: 0.8,
      tags: ["preference", "tone"],
      metadata: {
        captured_by: "post_turn_extraction",
        conversation_key: "thread:thread-1",
        channel_id: "channel-1",
        thread_id: "thread-1",
        turn_id: "turn-1",
        request_message_id: 41,
        response_message_id: 42,
        message_id: "discord-request-1",
        discord_response_message_id: "discord-response-1",
        occurred_at: "2026-07-12T09:00:00.000Z",
        context_ref: "topic:shared-knowledge",
        context_label: "shared-knowledge review",
        extraction_provider: "claude-oauth",
        extraction_model: "claude-haiku-4-5",
        origin: {
          version: 1,
          kind: "conversation",
          occurred_at: "2026-07-12T09:00:00.000Z",
          context_ref: "topic:shared-knowledge",
          context_label: "shared-knowledge review",
        },
      },
    });
  });

  it("runs extraction through whichever provider/model is configured (e.g. Ollama)", async () => {
    generate.mockResolvedValue({
      text: JSON.stringify([
        { content: "User drives an pickup with a 29-gallon tank.", importance: 0.6, tags: ["vehicle"] },
      ]),
    });
    const memoryAdd = vi.fn().mockResolvedValue({ id: "memory-ollama" });

    await extractAndStoreMemories(
      baseContext,
      { ...baseConfig, extractionProvider: "ollama", extractionModel: "gpt-oss:20b" },
      { memoryAdd } as unknown as AtlasMemoryClient,
      mockProvider,
    );

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-oss:20b" }));
    expect(memoryAdd).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        extraction_provider: "ollama",
        extraction_model: "gpt-oss:20b",
      }),
    }));
  });

  it("filters out memories below the importance threshold", async () => {
    generate.mockResolvedValue({
      text: JSON.stringify([
        { content: "User likes coffee.", importance: 0.2, tags: ["preference"] },
        { content: "Weekly review stays on Monday.", importance: 0.7, tags: ["decision"] },
      ]),
    });

    const memoryAdd = vi.fn().mockResolvedValue({ id: "memory-2" });

    await extractAndStoreMemories(
      baseContext,
      baseConfig,
      { memoryAdd } as unknown as AtlasMemoryClient,
      mockProvider,
    );

    expect(memoryAdd).toHaveBeenCalledTimes(1);
    expect(memoryAdd).toHaveBeenCalledWith(expect.objectContaining({
      content: "Weekly review stays on Monday.",
      importance: 0.7,
    }));
  });

  it("does nothing when the extraction model returns an empty array", async () => {
    generate.mockResolvedValue({ text: "[]" });

    const memoryAdd = vi.fn().mockResolvedValue({ id: "memory-3" });

    await extractAndStoreMemories(
      baseContext,
      baseConfig,
      { memoryAdd } as unknown as AtlasMemoryClient,
      mockProvider,
    );

    expect(memoryAdd).not.toHaveBeenCalled();
  });

  it("retries once, then logs model errors without failing the turn", async () => {
    generate.mockRejectedValue(new Error("model unavailable"));
    const memoryAdd = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(extractAndStoreMemories(
      baseContext,
      baseConfig,
      { memoryAdd } as unknown as AtlasMemoryClient,
      mockProvider,
    )).resolves.toBeUndefined();

    expect(generate).toHaveBeenCalledTimes(2);
    expect(memoryAdd).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[memory-capture] extraction failed for thread:thread-1 after 2 attempts: model unavailable"),
    );
  });

  it("recovers when extraction succeeds on the retry", async () => {
    generate
      .mockRejectedValueOnce(new Error("Ollama returned an empty response"))
      .mockResolvedValueOnce({
        text: JSON.stringify([{ content: "the owner prefers inshore fishing", importance: 0.8, tags: ["travel"] }]),
      });
    const memoryAdd = vi.fn().mockResolvedValue({ id: "memory-retry" });

    await extractAndStoreMemories(
      baseContext,
      baseConfig,
      { memoryAdd } as unknown as AtlasMemoryClient,
      mockProvider,
    );

    expect(generate).toHaveBeenCalledTimes(2);
    expect(memoryAdd).toHaveBeenCalledTimes(1);
  });

  it("skips extraction entirely when memory capture is disabled", async () => {
    const memoryAdd = vi.fn();

    await extractAndStoreMemories(
      baseContext,
      { ...baseConfig, enabled: false },
      { memoryAdd } as unknown as AtlasMemoryClient,
      mockProvider,
    );

    expect(generate).not.toHaveBeenCalled();
    expect(memoryAdd).not.toHaveBeenCalled();
  });
});
