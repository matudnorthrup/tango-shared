import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeterministicEmbeddingProvider } from "../src/embeddings.js";
import {
  importMigratedChatGptExports,
  parseMigratedChatGptFile,
  triageMigratedChatGptExports,
} from "../src/chatgpt-migrated.js";
import { TangoStorage } from "../src/storage.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-chatgpt-migrated-"));
  tempDirs.push(dir);
  return dir;
}

function createStorage(dir: string): TangoStorage {
  return new TangoStorage(path.join(dir, "tango.sqlite"), { seedExampleRoster: true });
}

function writeSampleExport(dir: string): string {
  const filePath = path.join(dir, "2025-07-13 - ChatGPT Export.md");
  fs.writeFileSync(
    filePath,
    [
      "---",
      "tags:",
      "  - daily",
      "created: 2025-07-13",
      "---",
      "",
      "## Health Conversations",
      "",
      "### Printable Gym Plan",
      "Tags: #health #fitness",
      "",
      "**Me:** I am 39 years old and work full-time. I need a workout plan that helps me lose about 20 pounds. My knees and hips hurt when I try to squat heavy. I want minimal exercises and better mobility.",
      "",
      "**ChatGPT:** Here is a joint-friendly workout plan that uses push, pull, and legs while keeping sessions short.",
      "",
      "### New chat",
      "Tags: #health",
      "",
      "**Me:** What foods help build muscle?",
      "",
      "**ChatGPT:** Focus on protein-rich foods and balanced meals.",
    ].join("\n"),
    "utf8"
  );
  return filePath;
}

describe("chatgpt migrated importer", () => {
  it("parses migrated exports and scores high-signal conversations above generic ones", () => {
    const dir = createTempDir();
    const filePath = writeSampleExport(dir);

    const parsed = parseMigratedChatGptFile(filePath);
    expect(parsed).not.toBeNull();
    expect(parsed?.conversations).toHaveLength(2);
    expect(parsed?.conversations[0]?.title).toBe("Printable Gym Plan");
    expect(parsed?.conversations[0]?.tags).toEqual(["health", "fitness"]);

    const triage = triageMigratedChatGptExports({ paths: [filePath] });
    expect(triage.fileCount).toBe(1);
    expect(triage.conversationCount).toBe(2);

    const topConversation = triage.files[0]?.topConversations[0];
    const secondConversation = triage.files[0]?.topConversations[1];

    expect(topConversation?.title).toBe("Printable Gym Plan");
    expect(topConversation?.score ?? 0).toBeGreaterThan(0.6);
    expect(topConversation?.durableCount ?? 0).toBeGreaterThan(0);
    expect(topConversation?.predictedMemoryCount ?? 0).toBeGreaterThan(
      secondConversation?.predictedMemoryCount ?? 0
    );
    expect(secondConversation?.score ?? 1).toBeLessThan(topConversation?.score ?? 0);
  });

  it("imports high-signal migrated conversations idempotently with embeddings", async () => {
    const dir = createTempDir();
    const filePath = writeSampleExport(dir);
    const storage = createStorage(dir);

    try {
      const result = await importMigratedChatGptExports({
        storage,
        paths: [filePath],
        limitFiles: 1,
        maxConversationsPerFile: 2,
        minConversationScore: 0.5,
        maxDurableMemoriesPerConversation: 2,
        embeddingProvider: createDeterministicEmbeddingProvider(16),
      });

      expect(result.selectedFileCount).toBe(1);
      expect(result.selectedConversationCount).toBe(1);
      expect(result.insertedCount).toBe(3);

      const stored = storage.listMemories({ source: "backfill", limit: 10 });
      expect(stored).toHaveLength(3);
      expect(stored.every((memory) => memory.embeddingJson && memory.embeddingModel === "deterministic-test")).toBe(
        true
      );
      expect(stored.some((memory) => memory.sourceRef?.endsWith(":summary"))).toBe(true);
      expect(stored.some((memory) => memory.sourceRef?.endsWith(":durable:1"))).toBe(true);

      const secondRun = await importMigratedChatGptExports({
        storage,
        paths: [filePath],
        limitFiles: 1,
        maxConversationsPerFile: 2,
        minConversationScore: 0.5,
        maxDurableMemoriesPerConversation: 2,
        embeddingProvider: createDeterministicEmbeddingProvider(16),
      });

      expect(secondRun.insertedCount).toBe(0);
      expect(secondRun.skippedCount).toBe(3);
    } finally {
      storage.close();
    }
  });
});
