import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addObsidianMemories,
  createAtlasMemoryTools,
  deleteObsidianMemoriesBySourceRefPrefix,
  openAtlasMemoryDatabase,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-obsidian-sync-"));
  tempDirs.push(dir);
  return openAtlasMemoryDatabase({ dbPath: path.join(dir, "memory.db") });
}

describe("obsidian sync", () => {
  it("adds obsidian chunks with upstream embeddings and prunes by source_ref prefix", () => {
    const { db } = createDb();

    const ids = addObsidianMemories(db, [
      {
        content: "Playa Azul fishing: inshore panga, roosterfish, ~$450 half day.",
        sourceRef: "obsidian:Trips/Playa Azul.md#1",
        importance: 0.6,
        metadata: { title: "Playa Azul" },
        embedding: [0.1, 0.2, 0.3],
        embeddingModel: "voyage-4-lite",
        createdAt: "2026-05-15T08:00:00.000Z",
      },
      {
        content: "Offshore sportfisher, dorado and sailfish, ~$950 full day.",
        sourceRef: "obsidian:Trips/Playa Azul.md#2",
        importance: 0.6,
        embedding: null,
      },
      {
        content: "Unrelated note chunk.",
        sourceRef: "obsidian:Other.md#1",
        importance: 0.4,
      },
    ]);
    expect(ids).toHaveLength(3);

    const rows = db
      .prepare(
        `SELECT source, embedding, embedding_model, created_at,
                json_extract(metadata, '$.source_ref') AS source_ref,
                json_extract(metadata, '$.origin.kind') AS origin_kind,
                json_extract(metadata, '$.origin.occurred_at') AS origin_occurred_at,
                json_extract(metadata, '$.origin.context_label') AS origin_context_label
         FROM memories ORDER BY source_ref`,
      )
      .all() as Array<{
      source: string;
      embedding: Buffer | null;
      embedding_model: string | null;
      created_at: string;
      source_ref: string;
      origin_kind: string;
      origin_occurred_at: string;
      origin_context_label: string | null;
    }>;

    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.source === "obsidian")).toBe(true);
    const embedded = rows.find((row) => row.source_ref.endsWith("Playa Azul.md#1"));
    expect(embedded?.embedding).not.toBeNull();
    expect(embedded?.embedding_model).toBe("voyage-4-lite");
    // Content age is preserved — a bulk resync must not make the vault look brand-new.
    expect(embedded?.created_at).toBe("2026-05-15T08:00:00.000Z");
    expect(embedded?.origin_kind).toBe("document");
    expect(embedded?.origin_occurred_at).toBe("2026-05-15T08:00:00.000Z");
    expect(embedded?.origin_context_label).toBe("Playa Azul");
    const unembedded = rows.find((row) => row.source_ref.endsWith("Playa Azul.md#2"));
    expect(unembedded?.embedding).toBeNull();

    const deleted = deleteObsidianMemoriesBySourceRefPrefix(db, "obsidian:Trips/Playa Azul.md#");
    expect(deleted).toBe(2);
    const remaining = db.prepare(`SELECT COUNT(*) AS total FROM memories`).get() as { total: number };
    expect(remaining.total).toBe(1);

    db.close();
  });

  it("makes synced obsidian chunks searchable via memory_search (text ranking)", async () => {
    const { db } = createDb();
    addObsidianMemories(db, [
      {
        content: "Playa Azul fishing charters: inshore roosterfish and offshore dorado.",
        sourceRef: "obsidian:Trips/PE.md#1",
        importance: 0.7,
      },
    ]);

    const tools = createAtlasMemoryTools({ db, embeddingProvider: null });
    const search = tools.find((tool) => tool.name === "memory_search");
    const results = (await search?.handler({ query: "fishing charters" })) as Array<{
      source: string;
      content: string;
    }>;

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.source).toBe("obsidian");
    expect(results[0]?.content).toContain("fishing charters");

    db.close();
  });
});
