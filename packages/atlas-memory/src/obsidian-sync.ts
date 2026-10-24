import { v4 as uuidv4 } from "uuid";
import { withMemoryOrigin } from "./origin.js";
import { encodeEmbedding } from "./search.js";
import type { SqliteDatabase } from "./types.js";

/**
 * Programmatic sync surface for mirroring Obsidian vault chunks into the
 * Atlas store (TGO-691). The agent-facing memory_add tool re-embeds every
 * call; these helpers accept embeddings computed upstream by the core
 * indexer so vault content is embedded exactly once per change.
 *
 * Chunk identity lives in metadata.source_ref ("obsidian:<path>#<n>") —
 * the memories table has no source_ref column.
 */
export interface ObsidianChunkUpsert {
  content: string;
  sourceRef: string;
  importance: number;
  tags?: string[];
  metadata?: Record<string, unknown> | null;
  embedding?: number[] | null;
  embeddingModel?: string | null;
  /**
   * Content age (note frontmatter date / file mtime), NOT index time — recency
   * scoring must reflect when the note was written, or a bulk resync makes the
   * whole vault look brand-new and drowns out other sources.
   */
  createdAt?: string | null;
}

export function deleteObsidianMemoriesBySourceRefPrefix(
  db: SqliteDatabase,
  sourceRefPrefix: string,
): number {
  const result = db
    .prepare(
      `
        DELETE FROM memories
        WHERE source = 'obsidian'
          AND json_extract(metadata, '$.source_ref') LIKE ? || '%'
      `,
    )
    .run(sourceRefPrefix);
  return Number(result.changes ?? 0);
}

export function addObsidianMemories(
  db: SqliteDatabase,
  chunks: ObsidianChunkUpsert[],
  now: Date = new Date(),
): string[] {
  if (chunks.length === 0) return [];

  const timestamp = now.toISOString();
  const insert = db.prepare(`
    INSERT INTO memories (
      id,
      content,
      source,
      agent_id,
      importance,
      tags,
      embedding,
      embedding_model,
      created_at,
      last_accessed_at,
      access_count,
      archived_at,
      metadata
    ) VALUES (?, ?, 'obsidian', NULL, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
  `);

  const ids: string[] = [];
  for (const chunk of chunks) {
    if (chunk.content.trim().length === 0) continue;
    const id = uuidv4();
    const createdAt = chunk.createdAt?.trim() || timestamp;
    const title = metadataString(chunk.metadata, "title");
    const heading = metadataString(chunk.metadata, "heading");
    const contextLabel = [title, heading].filter(Boolean).join(" / ") || null;
    const metadata = withMemoryOrigin(
      { ...(chunk.metadata ?? {}), source_ref: chunk.sourceRef },
      {
        source: "obsidian",
        occurredAt: createdAt,
        capturedAt: timestamp,
        contextLabel,
        sourceRef: chunk.sourceRef,
      },
    );
    insert.run(
      id,
      chunk.content,
      Math.min(Math.max(chunk.importance, 0), 1),
      JSON.stringify(chunk.tags ?? []),
      chunk.embedding && chunk.embedding.length > 0 ? encodeEmbedding(chunk.embedding) : null,
      chunk.embedding && chunk.embedding.length > 0 ? chunk.embeddingModel ?? null : null,
      createdAt,
      createdAt,
      JSON.stringify(metadata),
    );
    ids.push(id);
  }

  return ids;
}

function metadataString(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}
