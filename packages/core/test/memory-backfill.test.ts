import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  backfillImportPaths,
  backfillMarkdownFiles,
  backfillMessages,
  backfillMissingMemoryEmbeddings,
} from "../src/memory-backfill.js";
import { TangoStorage } from "../src/storage.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createStorage(): { storage: TangoStorage; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-memory-backfill-"));
  tempDirs.push(dir);
  const storage = new TangoStorage(path.join(dir, "tango.sqlite"), { seedExampleRoster: true });
  storage.bootstrapSessions([
    {
      id: "default",
      type: "persistent",
      agent: "watson",
      channels: ["discord:default"],
      memory: {
        summarizeWindow: 4,
      },
    },
  ]);
  return { storage, dir };
}

describe("memory backfill", () => {
  it("backfills message history into idempotent backfill memories", async () => {
    const { storage } = createStorage();

    for (let index = 0; index < 8; index += 1) {
      storage.insertMessage({
        sessionId: "default",
        agentId: "watson",
        direction: index % 2 === 0 ? "inbound" : "outbound",
        source: "discord",
        content:
          index % 2 === 0
            ? `User turn ${index + 1}: keep the weekly review concise and action-focused.`
            : `Assistant turn ${index + 1}: understood, I will keep the weekly review short and actionable.`,
      });
    }

    const result = await backfillMessages({
      storage,
      sessionConfigs: [
        {
          id: "default",
          type: "persistent",
          agent: "watson",
          channels: ["discord:default"],
          memory: {
            summarizeWindow: 4,
          },
        },
      ],
    });

    expect(result.insertedCount).toBe(2);
    expect(storage.listMemories({ source: "backfill", sessionId: "default", agentId: "watson" })).toHaveLength(2);

    const secondRun = await backfillMessages({
      storage,
      sessionConfigs: [
        {
          id: "default",
          type: "persistent",
          agent: "watson",
          channels: ["discord:default"],
          memory: {
            summarizeWindow: 4,
          },
        },
      ],
    });
    expect(secondRun.insertedCount).toBe(0);
    expect(secondRun.skippedCount).toBe(2);

    storage.close();
  });

  it("backfills markdown and import files with source refs", async () => {
    const { storage, dir } = createStorage();
    const markdownPath = path.join(dir, "thread.md");
    fs.writeFileSync(
      markdownPath,
      [
        "---",
        "title: Weekly Review Thread",
        "tags:",
        "  - planning",
        "  - review",
        "created: 2026-02-15",
        "---",
        "",
        "# Weekly Review Thread",
        "",
        "## Current State",
        "Weekly reviews should stay concise and action-focused.",
        "",
        "## Decisions",
        "Use Mondays for weekly reviews and keep them under ten minutes.",
      ].join("\n"),
      "utf8"
    );

    const transcriptPath = path.join(dir, "rescued.txt");
    fs.writeFileSync(
      transcriptPath,
      "Rescued voice transcript\nI need to send feedback to the project lead about the trailer concept tomorrow morning.",
      "utf8"
    );

    const markdownResult = await backfillMarkdownFiles({
      storage,
      paths: [markdownPath],
      memorySource: "backfill",
    });
    expect(markdownResult.insertedCount).toBeGreaterThan(0);

    const importResult = await backfillImportPaths({
      storage,
      paths: [transcriptPath],
      memorySource: "backfill",
    });
    expect(importResult.insertedCount).toBe(1);

    const stored = storage.listMemories({ source: "backfill", limit: 10 });
    expect(stored.some((memory) => memory.sourceRef?.includes("thread.md#1"))).toBe(true);
    expect(stored.some((memory) => memory.sourceRef?.includes("rescued.txt#1"))).toBe(true);

    storage.close();
  });

  it("retries failed embedding batches and reports embed stats", async () => {
    const { storage, dir } = createStorage();
    const markdownPath = path.join(dir, "note.md");
    fs.writeFileSync(markdownPath, "# Note\n\nSome content worth embedding.\n");

    let calls = 0;
    const flakyProvider = {
      model: "test-embed",
      async embed(inputs: string[]): Promise<number[][]> {
        calls += 1;
        if (calls < 3) {
          throw new Error("rate limited");
        }
        return inputs.map(() => [0.1, 0.2, 0.3]);
      },
    };

    const result = await backfillMarkdownFiles({
      storage,
      paths: [markdownPath],
      memorySource: "obsidian",
      embeddingProvider: flakyProvider,
    });

    expect(calls).toBe(3);
    expect(result.insertedCount).toBeGreaterThan(0);
    expect(result.embeddedCount).toBe(result.insertedCount);
    expect(result.embedFailedCount).toBe(0);

    storage.close();
  });

  it("reports embed failures without dropping inserts when all retries fail", async () => {
    const { storage, dir } = createStorage();
    const markdownPath = path.join(dir, "note.md");
    fs.writeFileSync(markdownPath, "# Note\n\nContent that will not embed.\n");

    const downProvider = {
      model: "test-embed",
      async embed(): Promise<number[][]> {
        throw new Error("provider down");
      },
    };

    const result = await backfillMarkdownFiles({
      storage,
      paths: [markdownPath],
      memorySource: "obsidian",
      embeddingProvider: downProvider,
    });

    expect(result.insertedCount).toBeGreaterThan(0);
    expect(result.embeddedCount).toBe(0);
    expect(result.embedFailedCount).toBe(result.insertedCount);
    expect(result.embedErrors).toContain("provider down");

    storage.close();
  });

  it("backfills missing embeddings for stored memories", async () => {
    const { storage, dir } = createStorage();
    const markdownPath = path.join(dir, "note.md");
    fs.writeFileSync(markdownPath, "# Note\n\nOrphaned chunk without embedding.\n");

    // Insert without a provider → no embeddings.
    await backfillMarkdownFiles({
      storage,
      paths: [markdownPath],
      memorySource: "obsidian",
    });
    expect(storage.listMemoriesMissingEmbedding({ source: "obsidian", limit: 100 }).length).toBeGreaterThan(0);

    const result = await backfillMissingMemoryEmbeddings({
      storage,
      embeddingProvider: {
        model: "test-embed",
        async embed(inputs: string[]): Promise<number[][]> {
          return inputs.map(() => [0.4, 0.5, 0.6]);
        },
      },
      source: "obsidian",
    });

    expect(result.scannedCount).toBeGreaterThan(0);
    expect(result.embeddedCount).toBe(result.scannedCount);
    expect(result.failedCount).toBe(0);
    expect(storage.listMemoriesMissingEmbedding({ source: "obsidian", limit: 100 })).toHaveLength(0);

    storage.close();
  });
});
