import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeterministicEmbeddingProvider } from "../src/embeddings.js";
import {
  extractPrimaryKeyword,
  generateReflectionCandidates,
  runMemoryReflectionCycle,
} from "../src/memory-reflection.js";
import type { StoredMemoryRecord } from "../src/storage.js";
import { TangoStorage } from "../src/storage.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function memory(
  input: Partial<StoredMemoryRecord> & Pick<StoredMemoryRecord, "id" | "source" | "content">
): StoredMemoryRecord {
  return {
    id: input.id,
    sessionId: input.sessionId ?? "default",
    agentId: input.agentId ?? "watson",
    source: input.source,
    content: input.content,
    importance: input.importance ?? 0.5,
    sourceRef: input.sourceRef ?? null,
    embeddingJson: input.embeddingJson ?? null,
    embeddingModel: input.embeddingModel ?? null,
    createdAt: input.createdAt ?? "2026-03-10T10:00:00.000Z",
    lastAccessedAt: input.lastAccessedAt ?? "2026-03-10T10:00:00.000Z",
    accessCount: input.accessCount ?? 0,
    archivedAt: input.archivedAt ?? null,
    metadata: input.metadata ?? null,
  };
}

function createStorage(): TangoStorage {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-memory-reflection-"));
  tempDirs.push(dir);
  const storage = new TangoStorage(path.join(dir, "tango.sqlite"), { seedExampleRoster: true });
  storage.bootstrapSessions([
    {
      id: "default",
      type: "persistent",
      agent: "watson",
      channels: ["discord:default"],
    },
  ]);
  return storage;
}

describe("memory reflection", () => {
  it("builds deterministic reflection candidates from recent memories", () => {
    const candidates = generateReflectionCandidates({
      memories: [
        memory({
          id: 1,
          source: "manual",
          content: "the owner prefers concise weekly reviews with action items.",
          importance: 0.9,
          metadata: { tags: ["weekly-review", "preferences", "concise"] },
        }),
        memory({
          id: 2,
          source: "conversation",
          content: "We decided the weekly review should stay concise and action-focused.",
          importance: 0.8,
          metadata: { tags: ["weekly-review", "concise", "decision"] },
        }),
        memory({
          id: 3,
          source: "conversation",
          content: "Follow-up: keep Monday weekly reviews short and decision-oriented.",
          importance: 0.75,
          metadata: { tags: ["weekly-review", "concise", "monday"] },
        }),
      ],
      maxReflections: 3,
      now: new Date("2026-03-10T12:00:00.000Z"),
    });

    expect(candidates).toHaveLength(3);
    expect(candidates[0]?.content).toContain("Recurring theme:");
    expect(candidates.some((candidate) => candidate.kind === "preference")).toBe(true);
    expect(candidates.some((candidate) => candidate.kind === "decision")).toBe(true);
  });

  it("filters low-signal keywords from broad theme reflections", () => {
    const candidates = generateReflectionCandidates({
      memories: [
        memory({
          id: 1,
          source: "manual",
          content: "Assistant discussed the OpenClaw voice migration and Watson voice design.",
          importance: 0.8,
          metadata: { keywords: ["assistant", "discussed", "openclaw", "voice"] },
        }),
        memory({
          id: 2,
          source: "obsidian",
          content: "OpenClaw voice migration notes for Watson voice architecture.",
          importance: 0.82,
          metadata: { keywords: ["openclaw", "voice", "architecture"] },
        }),
        memory({
          id: 3,
          source: "obsidian",
          content: "Watson voice session sync plan continues the OpenClaw replacement work.",
          importance: 0.81,
          metadata: { keywords: ["watson-voice", "openclaw", "voice"] },
        }),
      ],
      maxReflections: 2,
      now: new Date("2026-03-10T12:00:00.000Z"),
    });

    expect(candidates[0]?.content).toContain("openclaw");
    expect(candidates[0]?.content).toContain("voice");
    expect(candidates[0]?.content).not.toContain("assistant");
    expect(candidates[0]?.content).not.toContain("discussed");
  });

  it("ignores low-signal daily planning obsidian notes when generating reflections", () => {
    const candidates = generateReflectionCandidates({
      memories: [
        memory({
          id: 1,
          sessionId: null,
          agentId: null,
          source: "obsidian",
          content: "In Progress / In Progress: - [ ] 🤖 #acme › Messaging Principles — last active 7:58 PM - [ ] 🤖 #3d-printing › Desk Prints — last active 8:39 PM",
          importance: 0.95,
          metadata: {
            filePath: "/Users/tester/Documents/main/Planning/Daily/2026-03-05.md",
            title: "In Progress",
            heading: "In Progress",
            keywords: ["acme", "planning"],
          },
        }),
        memory({
          id: 2,
          source: "conversation",
          content: "the owner prefers concise weekly reviews with action items.",
          importance: 0.8,
          metadata: { tags: ["weekly-review", "preferences", "concise"] },
        }),
        memory({
          id: 3,
          source: "conversation",
          content: "We decided the weekly review should stay concise and action-focused.",
          importance: 0.82,
          metadata: { tags: ["weekly-review", "concise", "decision"] },
        }),
      ],
      maxReflections: 2,
      now: new Date("2026-03-10T12:00:00.000Z"),
    });

    expect(candidates.some((candidate) => candidate.content.includes("acme"))).toBe(false);
  });

  it("stores new reflection memories with embeddings and source metadata", async () => {
    const storage = createStorage();
    storage.insertMemory({
      sessionId: "default",
      agentId: "watson",
      source: "manual",
      content: "the owner prefers concise weekly reviews with action items.",
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

    const result = await runMemoryReflectionCycle({
      storage,
      embeddingProvider: createDeterministicEmbeddingProvider(16),
      sessionId: "default",
      agentId: "watson",
      maxReflections: 3,
      now: new Date("2026-03-10T12:00:00.000Z"),
    });

    expect(result.eligibleCount).toBe(3);
    expect(result.createdCount).toBeGreaterThan(0);
    expect(result.createdMemories.every((entry) => entry.source === "reflection")).toBe(true);
    expect(result.createdMemories[0]?.embeddingJson).toBeTruthy();
    expect(result.createdMemories[0]?.metadata).toMatchObject({
      generatedBy: "memory_reflect",
      sourceMemoryIds: expect.any(Array),
    });

    const secondRun = await runMemoryReflectionCycle({
      storage,
      embeddingProvider: createDeterministicEmbeddingProvider(16),
      sessionId: "default",
      agentId: "watson",
      maxReflections: 3,
      now: new Date("2026-03-10T12:30:00.000Z"),
    });

    expect(secondRun.createdCount).toBe(0);

    storage.close();
  });

  it("extracts primary keyword from recurring theme reflections", () => {
    expect(extractPrimaryKeyword("Recurring theme: health, exercise, and fitness. Example: ...")).toBe("health");
    expect(extractPrimaryKeyword("Recurring theme: sleep. Example: deep sleep trends.")).toBe("sleep");
    expect(extractPrimaryKeyword("Preference insight: user likes concise reports.")).toBeNull();
    expect(extractPrimaryKeyword("")).toBeNull();
  });

  it("skips theme candidates whose primary keyword already has a reflection (Fix 4)", () => {
    const candidates = generateReflectionCandidates({
      memories: [
        memory({
          id: 1,
          source: "conversation",
          content: "We discussed health metrics and recovery.",
          importance: 0.8,
          metadata: { tags: ["health", "recovery", "metrics"] },
        }),
        memory({
          id: 2,
          source: "conversation",
          content: "Health trends show improving HRV and deep sleep.",
          importance: 0.8,
          metadata: { tags: ["health", "hrv", "sleep"] },
        }),
        memory({
          id: 3,
          source: "conversation",
          content: "More health data: resting heart rate is down.",
          importance: 0.75,
          metadata: { tags: ["health", "heart-rate", "trends"] },
        }),
      ],
      existingReflections: [
        memory({
          id: 100,
          source: "reflection",
          content: "Recurring theme: health, recovery, and metrics. Example: discussed health metrics.",
          importance: 0.7,
        }),
      ],
      maxReflections: 5,
      now: new Date("2026-03-10T12:00:00.000Z"),
    });

    // No new theme candidate should have "health" as primary keyword
    const healthThemes = candidates.filter(
      (c) => c.kind === "theme" && extractPrimaryKeyword(c.content) === "health"
    );
    expect(healthThemes).toHaveLength(0);
  });
});
