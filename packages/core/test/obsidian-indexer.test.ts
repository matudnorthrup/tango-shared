import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexObsidianVault } from "../src/obsidian-indexer.js";
import { TangoStorage } from "../src/storage.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createFixture(): { storage: TangoStorage; dir: string; vaultDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-obsidian-index-"));
  tempDirs.push(dir);
  const vaultDir = path.join(dir, "vault");
  fs.mkdirSync(vaultDir, { recursive: true });
  const storage = new TangoStorage(path.join(dir, "tango.sqlite"), { seedExampleRoster: true });
  return { storage, dir, vaultDir };
}

describe("obsidian indexer", () => {
  it("indexes curated notes while skipping transcript-heavy defaults", async () => {
    const { storage, vaultDir } = createFixture();
    const planningDir = path.join(vaultDir, "Planning");
    const aiConversationDir = path.join(vaultDir, "AI", "Conversations");
    const clippingsDir = path.join(vaultDir, "Clippings");

    fs.mkdirSync(planningDir, { recursive: true });
    fs.mkdirSync(aiConversationDir, { recursive: true });
    fs.mkdirSync(clippingsDir, { recursive: true });

    fs.writeFileSync(
      path.join(planningDir, "Weekly Plan.md"),
      "# Weekly Plan\n\n## Current State\nKeep the weekly review concise and action-focused.",
      "utf8"
    );
    fs.writeFileSync(
      path.join(aiConversationDir, "Transcript.md"),
      "# Transcript\n\nThis is a long AI transcript that should stay out of the curated index.",
      "utf8"
    );
    fs.writeFileSync(
      path.join(clippingsDir, "External Article.md"),
      "# External Article\n\nThis clipping should be skipped by default.",
      "utf8"
    );

    const result = await indexObsidianVault({
      storage,
      paths: [vaultDir],
    });

    expect(result.scannedFileCount).toBe(1);
    expect(result.indexedFileCount).toBe(1);
    expect(storage.listMemories({ source: "obsidian", limit: 10 })).toHaveLength(1);
    expect(storage.listMemories({ source: "obsidian", limit: 10 })[0]?.sourceRef).toContain("Weekly Plan.md#1");
    expect(storage.getObsidianIndexEntry(path.join(planningDir, "Weekly Plan.md"))).not.toBeNull();
    expect(storage.getObsidianIndexEntry(path.join(aiConversationDir, "Transcript.md"))).toBeNull();

    storage.close();
  });

  it("replaces changed files and removes deleted files from the index", async () => {
    const { storage, vaultDir } = createFixture();
    const planningDir = path.join(vaultDir, "Planning");
    fs.mkdirSync(planningDir, { recursive: true });

    const notePath = path.join(planningDir, "Project Plan.md");
    fs.writeFileSync(
      notePath,
      "# Project Plan\n\n## Current State\nShip the memory indexer next.\n\n## Next\nRun full verification.",
      "utf8"
    );

    const firstRun = await indexObsidianVault({
      storage,
      paths: [vaultDir],
    });
    expect(firstRun.indexedFileCount).toBe(1);
    expect(storage.listMemories({ source: "obsidian", limit: 10 })).toHaveLength(2);

    fs.writeFileSync(
      notePath,
      "# Project Plan\n\n## Current State\nShip the memory indexer tonight.\n\n## Decisions\nRun full verification before sleep.",
      "utf8"
    );

    const secondRun = await indexObsidianVault({
      storage,
      paths: [vaultDir],
    });
    expect(secondRun.indexedFileCount).toBe(1);
    expect(secondRun.deletedMemoryCount).toBeGreaterThan(0);
    expect(storage.listMemories({ source: "obsidian", limit: 10 })).toHaveLength(2);

    fs.rmSync(notePath);

    const thirdRun = await indexObsidianVault({
      storage,
      paths: [vaultDir],
    });
    expect(thirdRun.removedFileCount).toBe(1);
    expect(storage.listMemories({ source: "obsidian", limit: 10 })).toHaveLength(0);
    expect(storage.getObsidianIndexEntry(notePath)).toBeNull();

    storage.close();
  });

  it("does not prune unrelated index entries when refreshing one file", async () => {
    const { storage, vaultDir } = createFixture();
    const planningDir = path.join(vaultDir, "Planning");
    fs.mkdirSync(planningDir, { recursive: true });

    const firstNotePath = path.join(planningDir, "First.md");
    const secondNotePath = path.join(planningDir, "Second.md");
    fs.writeFileSync(firstNotePath, "# First\n\nOriginal first note with enough body text to become one indexed memory.", "utf8");
    fs.writeFileSync(secondNotePath, "# Second\n\nSecond note should stay indexed with enough body text to become one indexed memory.", "utf8");

    const firstRun = await indexObsidianVault({
      storage,
      paths: [vaultDir],
    });
    expect(firstRun.indexedFileCount).toBe(2);

    fs.writeFileSync(firstNotePath, "# First\n\nUpdated first note with enough body text to become one indexed memory.", "utf8");

    const secondRun = await indexObsidianVault({
      storage,
      paths: [firstNotePath],
    });
    expect(secondRun.indexedFileCount).toBe(1);
    expect(secondRun.removedFileCount).toBe(0);
    expect(storage.getObsidianIndexEntry(secondNotePath)).not.toBeNull();
    expect(storage.listMemories({ source: "obsidian", limit: 10 })).toHaveLength(2);

    storage.close();
  });

  it("mirrors indexed chunks (embeddings included) into the secondary sink", async () => {
    const { storage, vaultDir } = createFixture();
    const notePath = path.join(vaultDir, "Trip Plan.md");
    fs.writeFileSync(
      notePath,
      "# Trip Plan\n\nPlaya Azul fishing charters: inshore and offshore options.",
      "utf8"
    );

    const pruned: string[] = [];
    const added: Array<{ sourceRef: string; embedding: number[] | null }> = [];
    const sink = {
      prune: (prefix: string) => pruned.push(prefix),
      addChunks: (chunks: Array<{ sourceRef: string; embedding: number[] | null }>) => {
        added.push(...chunks.map((chunk) => ({ sourceRef: chunk.sourceRef, embedding: chunk.embedding })));
      },
    };
    const embeddingProvider = {
      model: "test-embed",
      async embed(inputs: string[]): Promise<number[][]> {
        return inputs.map(() => [0.25, 0.5, 0.75]);
      },
    };

    const firstRun = await indexObsidianVault({
      storage,
      paths: [vaultDir],
      embeddingProvider,
      secondarySink: sink,
    });
    expect(firstRun.sinkSyncedCount).toBeGreaterThan(0);
    expect(firstRun.sinkErrorCount).toBe(0);
    expect(pruned.length).toBeGreaterThan(0);
    expect(added.length).toBe(firstRun.sinkSyncedCount);
    expect(added.every((chunk) => chunk.sourceRef.startsWith("obsidian:"))).toBe(true);
    expect(added.every((chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length === 3)).toBe(true);

    // Unchanged files do not re-sync.
    pruned.length = 0;
    added.length = 0;
    const secondRun = await indexObsidianVault({
      storage,
      paths: [vaultDir],
      embeddingProvider,
      secondarySink: sink,
    });
    expect(secondRun.sinkSyncedCount).toBe(0);
    expect(pruned).toHaveLength(0);

    // Removed files prune the sink copy too.
    fs.rmSync(notePath);
    const thirdRun = await indexObsidianVault({
      storage,
      paths: [vaultDir],
      embeddingProvider,
      secondarySink: sink,
    });
    expect(thirdRun.removedFileCount).toBe(1);
    expect(pruned.length).toBeGreaterThan(0);

    storage.close();
  });

  it("treats secondary sink failures as warnings, not index failures", async () => {
    const { storage, vaultDir } = createFixture();
    fs.writeFileSync(
      path.join(vaultDir, "Note.md"),
      "# Note\n\nEnough body text in this note for the chunker to produce one indexed memory entry.",
      "utf8"
    );

    const result = await indexObsidianVault({
      storage,
      paths: [vaultDir],
      secondarySink: {
        prune: () => {
          throw new Error("atlas unavailable");
        },
        addChunks: () => undefined,
      },
    });

    expect(result.indexedFileCount).toBe(1);
    expect(result.insertedMemoryCount).toBeGreaterThan(0);
    expect(result.sinkErrorCount).toBeGreaterThan(0);
    expect(result.sinkSyncedCount).toBe(0);

    storage.close();
  });

  it("excludes generated read-only projections and prunes an older indexed copy", async () => {
    const { storage, vaultDir } = createFixture();
    const notePath = path.join(vaultDir, "Views", "Synthetic Overview.md");
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.writeFileSync(
      notePath,
      "# Synthetic Overview\n\nThis ordinary note is initially indexable narrative.\n",
      "utf8",
    );

    const first = await indexObsidianVault({ storage, paths: [vaultDir] });
    expect(first.indexedFileCount).toBe(1);
    expect(storage.listMemories({ source: "obsidian", limit: 10 }).length).toBeGreaterThan(0);

    fs.writeFileSync(
      notePath,
      [
        "---",
        "tango_view: generic-overview",
        "tango_root_entity_id: synthetic-root",
        "read_only_projection: true",
        "source_kind: generated",
        "---",
        "# Synthetic Overview",
        "",
        "Derived operational state must not become Atlas narrative.",
        "",
      ].join("\n"),
      "utf8",
    );

    const second = await indexObsidianVault({ storage, paths: [vaultDir] });
    expect(second.scannedFileCount).toBe(0);
    expect(second.removedFileCount).toBe(1);
    expect(storage.listMemories({ source: "obsidian", limit: 10 })).toHaveLength(0);
    expect(storage.getObsidianIndexEntry(notePath)).toBeNull();
    storage.close();
  });
});
