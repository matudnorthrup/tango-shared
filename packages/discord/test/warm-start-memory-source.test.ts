import { describe, expect, it, vi } from "vitest";
import type { AtlasContextMemoryRow } from "@tango/atlas-memory";
import type { AtlasMemoryClient } from "../src/atlas-memory-client.js";
import {
  loadAtlasWarmStartMemory,
  mapAtlasContextRows,
  resolveWarmStartMemorySubstrate,
} from "../src/warm-start-memory-source.js";

function makeRow(overrides: Partial<AtlasContextMemoryRow> & Pick<AtlasContextMemoryRow, "id" | "content" | "source">): AtlasContextMemoryRow {
  return {
    agentId: null,
    importance: 0.6,
    embedding: null,
    embeddingModel: null,
    createdAt: "2026-06-09T12:00:00.000Z",
    lastAccessedAt: "2026-06-09T12:00:00.000Z",
    accessCount: 0,
    metadata: null,
    ...overrides,
  };
}

describe("warm-start memory source", () => {
  it("resolves the substrate flag with atlas as default", () => {
    expect(resolveWarmStartMemorySubstrate({})).toBe("atlas");
    expect(resolveWarmStartMemorySubstrate({ TANGO_WARM_START_MEMORY_SOURCE: "core" })).toBe("core");
    expect(resolveWarmStartMemorySubstrate({ TANGO_WARM_START_MEMORY_SOURCE: "Atlas" })).toBe("atlas");
  });

  it("maps atlas rows to core-shaped records with source folding and id translation", () => {
    const { memories, idToAtlasId } = mapAtlasContextRows([
      makeRow({ id: "a-1", content: "extraction", source: "conversation", agentId: "sierra", embedding: [0.1, 0.2] }),
      makeRow({ id: "a-2", content: "watched", source: "observation" }),
      makeRow({ id: "a-3", content: "imported", source: "import" }),
      makeRow({
        id: "a-4",
        content: "vault chunk",
        source: "obsidian",
        metadata: { source_ref: "obsidian:Trips/PE.md#1", filePath: "/vault/Trips/PE.md" },
      }),
    ]);

    expect(memories.map((memory) => memory.source)).toEqual([
      "conversation",
      "manual",
      "backfill",
      "obsidian",
    ]);
    // Pre-decoded embedding flows through; no JSON representation needed.
    expect(memories[0]?.embedding).toEqual([0.1, 0.2]);
    expect(memories[0]?.embeddingJson).toBeNull();
    // Session-null keeps atlas records visible to session-scoped filters.
    expect(memories.every((memory) => memory.sessionId === null)).toBe(true);
    expect(memories[3]?.sourceRef).toBe("obsidian:Trips/PE.md#1");
    expect(memories[1]?.metadata).toMatchObject({ atlas_source: "observation" });
    expect(memories[2]?.metadata).toMatchObject({ atlas_source: "import" });
    expect(memories[3]?.metadata).toMatchObject({
      atlas_source: "obsidian",
      filePath: "/vault/Trips/PE.md",
    });
    expect(idToAtlasId.get(memories[0]!.id)).toBe("a-1");
  });

  it("builds a bundle whose touch() translates synthetic ids back to atlas ids", () => {
    const touched: string[][] = [];
    const listMemoriesForContext = vi.fn().mockReturnValue([
      makeRow({ id: "atlas-x", content: "fact x", source: "conversation", agentId: "sierra" }),
      makeRow({ id: "atlas-y", content: "fact y", source: "reflection", agentId: "sierra-ollama" }),
    ]);
    const getConversationSummaryForContext = vi.fn().mockReturnValue({
      id: "s1",
      sessionId: "thread:123",
      agentId: "sierra",
      summary: "Recap of the trip planning thread.",
      coversThrough: null,
      createdAt: "2026-06-09T12:00:00.000Z",
    });
    const listPinnedFactsForWarmStart = vi.fn().mockReturnValue([
      {
        id: "p1",
        scope: "global" as const,
        scopeId: null,
        key: "vehicle",
        value: "pickup diesel",
        createdAt: "2026-06-09T12:00:00.000Z",
        updatedAt: "2026-06-09T12:00:00.000Z",
      },
    ]);
    const client = {
      listMemoriesForContext,
      getConversationSummaryForContext,
      listPinnedFactsForWarmStart,
      touchMemoriesForContext: (ids: string[]) => {
        touched.push(ids);
        return ids.length;
      },
    } as unknown as AtlasMemoryClient;

    const bundle = loadAtlasWarmStartMemory(client, {
      sessionId: "topic:abc",
      agentId: "sierra-ollama",
      memoryAgentId: "sierra",
      memoryAgentIds: ["sierra", "sierra-ollama"],
      conversationKey: "thread:123",
      memoryPoolLimit: 100,
    });

    expect(listMemoriesForContext).toHaveBeenCalledWith({
      agentId: "sierra",
      agentIds: ["sierra", "sierra-ollama"],
      limit: 100,
    });
    expect(getConversationSummaryForContext).toHaveBeenCalledWith({
      sessionId: "thread:123",
      agentId: "sierra",
      agentIds: ["sierra", "sierra-ollama"],
    });
    expect(listPinnedFactsForWarmStart).toHaveBeenCalledWith({
      sessionId: "thread:123",
      agentId: "sierra",
      agentIds: ["sierra", "sierra-ollama"],
    });
    expect(bundle.substrate).toBe("atlas");
    expect(bundle.memories).toHaveLength(2);
    expect(bundle.summaries[0]?.summaryText).toContain("Recap");
    expect(bundle.summaries[0]?.tokenCount).toBeGreaterThan(0);
    expect(bundle.pinnedFacts[0]?.key).toBe("vehicle");

    const firstSyntheticId = bundle.memories[0]!.id;
    bundle.touch([firstSyntheticId, 9999]);
    expect(touched).toEqual([["atlas-x"]]);
  });

  it("keeps isolated agents to their own memories and drops global pinned facts", () => {
    const client = {
      listMemoriesForContext: vi.fn().mockReturnValue([
        makeRow({ id: "own", content: "likes soccer", source: "conversation", agentId: "oscar" }),
        makeRow({ id: "vault", content: "owner vault chunk", source: "obsidian", agentId: null }),
        makeRow({ id: "other", content: "owner fact", source: "conversation", agentId: "juliet" }),
      ]),
      getConversationSummaryForContext: vi.fn().mockReturnValue(null),
      listPinnedFactsForWarmStart: vi.fn().mockReturnValue([
        { id: "g", scope: "global" as const, scopeId: null, key: "owner", value: "private",
          createdAt: "2026-06-09T12:00:00.000Z", updatedAt: "2026-06-09T12:00:00.000Z" },
        { id: "a", scope: "agent" as const, scopeId: "oscar", key: "name", value: "teen",
          createdAt: "2026-06-09T12:00:00.000Z", updatedAt: "2026-06-09T12:00:00.000Z" },
      ]),
      touchMemoriesForContext: () => 0,
    } as unknown as AtlasMemoryClient;

    const query = {
      sessionId: "oscar",
      agentId: "oscar",
      memoryAgentId: "oscar",
      memoryAgentIds: ["oscar"],
      conversationKey: "channel:1",
      memoryPoolLimit: 100,
    };
    const isolated = loadAtlasWarmStartMemory(client, { ...query, isolated: true });
    expect(isolated.memories.map((memory) => memory.content)).toEqual(["likes soccer"]);
    expect(isolated.pinnedFacts.map((fact) => fact.key)).toEqual(["name"]);

    const shared = loadAtlasWarmStartMemory(client, query);
    expect(shared.memories).toHaveLength(3);
    expect(shared.pinnedFacts).toHaveLength(2);
  });
});
