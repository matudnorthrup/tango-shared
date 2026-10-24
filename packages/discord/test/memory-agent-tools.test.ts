import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeterministicEmbeddingProvider, GovernanceChecker, TangoStorage } from "@tango/core";
import { createMemoryTools } from "../src/memory-agent-tools.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createStorage(): { storage: TangoStorage; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-memory-tools-"));
  tempDirs.push(dir);
  const storage = new TangoStorage(path.join(dir, "tango.sqlite"), { seedExampleRoster: true });
  storage.bootstrapSessions([
    {
      id: "default",
      type: "persistent",
      agent: "watson",
      channels: ["discord:default"],
      memory: {
        retrievalWeights: {
          recency: 0.5,
          importance: 0.5,
          relevance: 2,
          source: 0.25,
        },
      },
    },
  ]);
  return { storage, dir };
}

describe("memory agent tools", () => {
  it("stores explicit memories with normalized tags and embeddings", async () => {
    const { storage } = createStorage();
    const tools = createMemoryTools({
      storage,
      embeddingProvider: createDeterministicEmbeddingProvider(16),
    });

    const memoryAdd = tools.find((tool) => tool.name === "memory_add");
    const result = await memoryAdd?.handler({
      content: "The user prefers concise weekly reviews with action items.",
      importance: 0.8,
      source: "manual",
      tags: ["Preferences", "weekly-review", "preferences"],
      session_id: "default",
      agent_id: "watson",
    });

    expect(result).toMatchObject({
      memory: {
        session_id: "default",
        agent_id: "watson",
        source: "manual",
        importance: 0.8,
        embedding_model: "deterministic-test",
        metadata: {
          tags: ["preferences", "weekly-review"],
        },
      },
    });

    const memories = storage.listMemories({ sessionId: "default", agentId: "watson", source: "manual" });
    expect(memories).toHaveLength(1);
    expect(memories[0]?.embeddingJson).toBeTruthy();
    expect(memories[0]?.metadata).toMatchObject({
      tags: ["preferences", "weekly-review"],
    });

    storage.close();
  });

  it("searches memories with semantic ranking and touches accessed rows", async () => {
    const { storage, dir } = createStorage();
    const tools = createMemoryTools({
      storage,
      configDir: path.join(dir, "missing-config-dir"),
      embeddingProvider: createDeterministicEmbeddingProvider(16),
    });

    storage.insertMemory({
      sessionId: "default",
      agentId: "watson",
      source: "manual",
      content: "Weekly reviews should stay concise and action-focused.",
      importance: 0.9,
      embeddingJson: JSON.stringify((await createDeterministicEmbeddingProvider(16).embed([
        "Weekly reviews should stay concise and action-focused.",
      ], "document"))[0]),
      embeddingModel: "deterministic-test",
      metadata: {
        tags: ["weekly-review"],
      },
    });
    storage.insertMemory({
      sessionId: "default",
      agentId: "watson",
      source: "manual",
      content: "The printer enclosure needs a fresh temperature test.",
      importance: 0.6,
      embeddingJson: JSON.stringify((await createDeterministicEmbeddingProvider(16).embed([
        "The printer enclosure needs a fresh temperature test.",
      ], "document"))[0]),
      embeddingModel: "deterministic-test",
      metadata: {
        tags: ["printing"],
      },
    });

    const memorySearch = tools.find((tool) => tool.name === "memory_search");
    const result = await memorySearch?.handler({
      query: "What did we decide about weekly review cadence and format?",
      session_id: "default",
      agent_id: "watson",
      limit: 2,
    });

    expect(result).toMatchObject({
      query: "What did we decide about weekly review cadence and format?",
      result_count: 1,
    });
    expect(Array.isArray((result as { results?: unknown[] }).results)).toBe(true);

    const typedResult = result as {
      results: Array<{
        id: number;
        content: string;
        score: number;
      }>;
    };
    expect(typedResult.results[0]?.content).toContain("Weekly reviews should stay concise");

    const touched = storage.getMemory(typedResult.results[0]!.id);
    expect(touched?.accessCount).toBe(1);

    const governance = new GovernanceChecker(storage.getDatabase());
    const permitted = new Set(governance.getPermittedTools("worker:personal-assistant"));
    expect(permitted.has("memory_search")).toBe(true);
    expect(permitted.has("memory_add")).toBe(true);
    expect(permitted.has("memory_reflect")).toBe(true);

    storage.close();
  });

  it("searches across aliased agent ids when agent_ids is provided", async () => {
    const { storage, dir } = createStorage();
    const tools = createMemoryTools({
      storage,
      configDir: path.join(dir, "missing-config-dir"),
      embeddingProvider: null,
    });

    storage.insertMemory({
      sessionId: "default",
      agentId: "sierra",
      source: "manual",
      content: "User is researching the Fujifilm X100VI camera.",
      importance: 0.9,
    });
    storage.insertMemory({
      sessionId: "default",
      agentId: "sierra-ollama",
      source: "manual",
      content: "Fujifilm X100VI adapter ring notes.",
      importance: 0.8,
    });
    storage.insertMemory({
      sessionId: "default",
      agentId: "watson",
      source: "manual",
      content: "Watson finance note that should not appear.",
      importance: 1,
    });

    const memorySearch = tools.find((tool) => tool.name === "memory_search");
    const result = await memorySearch?.handler({
      query: "Fujifilm X100VI camera adapter",
      session_id: "default",
      agent_id: "sierra",
      agent_ids: ["sierra", "sierra-ollama"],
      limit: 10,
    });

    const typedResult = result as {
      results: Array<{
        agent_id: string | null;
        content: string;
      }>;
    };
    expect(typedResult.results.map((memory) => memory.content).sort()).toEqual([
      "Fujifilm X100VI adapter ring notes.",
      "User is researching the Fujifilm X100VI camera.",
    ]);
    expect(new Set(typedResult.results.map((memory) => memory.agent_id))).toEqual(new Set(["sierra", "sierra-ollama"]));

    storage.close();
  });

  it("creates reflection memories from recent stored context", async () => {
    const { storage } = createStorage();
    const embeddingProvider = createDeterministicEmbeddingProvider(16);
    const tools = createMemoryTools({
      storage,
      embeddingProvider,
    });

    storage.insertMemory({
      sessionId: "default",
      agentId: "watson",
      source: "manual",
      content: "The user prefers concise weekly reviews with action items.",
      importance: 0.9,
      metadata: { tags: ["weekly-review", "preferences", "concise"] },
    });
    storage.insertMemory({
      sessionId: "default",
      agentId: "watson",
      source: "conversation",
      content: "We decided the weekly review should stay concise and action-focused.",
      importance: 0.8,
      metadata: { tags: ["weekly-review", "concise", "decision"] },
    });
    storage.insertMemory({
      sessionId: "default",
      agentId: "watson",
      source: "conversation",
      content: "Follow-up: keep Monday weekly reviews short and decision-oriented.",
      importance: 0.75,
      metadata: { tags: ["weekly-review", "concise", "monday"] },
    });

    const memoryReflect = tools.find((tool) => tool.name === "memory_reflect");
    const result = await memoryReflect?.handler({
      lookback_hours: 24,
      max_reflections: 3,
      session_id: "default",
      agent_id: "watson",
    });

    expect(result).toMatchObject({
      lookback_hours: 24,
      max_reflections: 3,
    });

    const typedResult = result as {
      created_count: number;
      created: Array<{
        source: string;
        content: string;
        metadata: Record<string, unknown> | null;
      }>;
    };
    expect(typedResult.created_count).toBeGreaterThan(0);
    expect(typedResult.created[0]?.source).toBe("reflection");
    expect(typedResult.created[0]?.content).toMatch(/(Recurring theme:|insight:)/i);
    expect(typedResult.created[0]?.metadata).toMatchObject({
      generatedBy: "memory_reflect",
    });

    storage.close();
  });
});
