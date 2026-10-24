import { decodeEmbedding } from "./search.js";
import { runInTransaction } from "./schema.js";
import type { PinnedFactScope, SqliteDatabase } from "./types.js";

/**
 * Read surface for warm-start context assembly (store consolidation: Atlas is
 * the single substrate for distilled memory; core keeps operational state).
 * These are plain row readers — ranking/zoning stays in @tango/core.
 */
export interface AtlasContextMemoryRow {
  id: string;
  content: string;
  source: string;
  agentId: string | null;
  importance: number;
  /** Decoded embedding vector (Float64 BLOB → number[]). */
  embedding: number[] | null;
  embeddingModel: string | null;
  createdAt: string;
  lastAccessedAt: string;
  accessCount: number;
  metadata: Record<string, unknown> | null;
}

/**
 * Lightweight narrative row used by generated state projections. Unlike the
 * warm-start read surface, this intentionally omits embeddings and access
 * tracking because projections only need deterministic narrative content.
 */
export interface AtlasStateProjectionMemoryRow {
  id: string;
  content: string;
  source: string;
  agentId: string | null;
  importance: number;
  tags: string[];
  createdAt: string;
  metadata: Record<string, unknown> | null;
}

export interface AtlasContextSummaryRow {
  id: string;
  sessionId: string;
  agentId: string;
  summary: string;
  coversThrough: string | null;
  createdAt: string;
}

export interface AtlasContextPinnedFactRow {
  id: string;
  scope: PinnedFactScope;
  scopeId: string | null;
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseJsonStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function uniqueAgentIds(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const agentIds: string[] = [];

  for (const value of values) {
    const agentId = value?.trim();
    if (!agentId || seen.has(agentId)) {
      continue;
    }
    seen.add(agentId);
    agentIds.push(agentId);
  }

  return agentIds;
}

/** Unarchived memories visible to an agent (its own + global), newest first. */
export function listAtlasMemoriesForContext(
  db: SqliteDatabase,
  input: { agentId?: string | null; agentIds?: string[]; limit?: number },
): AtlasContextMemoryRow[] {
  const limit = Math.max(1, Math.trunc(input.limit ?? 5000));
  const agentIds = uniqueAgentIds(input.agentIds?.length ? input.agentIds : [input.agentId]);
  const rows = (
    agentIds.length > 0
      ? db
          .prepare(
            `
              SELECT id, content, source, agent_id, importance, embedding,
                     embedding_model, created_at, last_accessed_at, access_count, metadata
              FROM memories
              WHERE archived_at IS NULL AND (agent_id IS NULL OR agent_id IN (${agentIds.map(() => "?").join(", ")}))
              ORDER BY created_at DESC
              LIMIT ?
            `,
          )
          .all(...agentIds, limit)
      : db
          .prepare(
            `
              SELECT id, content, source, agent_id, importance, embedding,
                     embedding_model, created_at, last_accessed_at, access_count, metadata
              FROM memories
              WHERE archived_at IS NULL
              ORDER BY created_at DESC
              LIMIT ?
            `,
          )
          .all(limit)
  ) as Array<{
    id: string;
    content: string;
    source: string;
    agent_id: string | null;
    importance: number;
    embedding: Buffer | null;
    embedding_model: string | null;
    created_at: string;
    last_accessed_at: string;
    access_count: number;
    metadata: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    source: row.source,
    agentId: row.agent_id,
    importance: Number.isFinite(row.importance) ? Math.min(Math.max(row.importance, 0), 1) : 0.5,
    embedding: decodeEmbedding(row.embedding),
    embeddingModel: row.embedding_model,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
    accessCount: Number(row.access_count) || 0,
    metadata: parseJsonObject(row.metadata),
  }));
}

/**
 * Unarchived narrative explicitly associated with one operational root.
 *
 * Association is read from the shared metadata contract. There is no global
 * recency cap, so unrelated recent memories cannot crowd an older project
 * entry out of its generated view.
 */
export function listAtlasMemoriesForStateProjection(
  db: SqliteDatabase,
  input: { projectEntityId: string; stateEntityId?: string | null },
): AtlasStateProjectionMemoryRow[] {
  const projectEntityId = input.projectEntityId.trim();
  if (!projectEntityId) throw new Error("projectEntityId is required for a state projection read");
  const stateEntityId = input.stateEntityId?.trim() || null;
  const rows = db
    .prepare(
      `
        SELECT id, content, source, agent_id, importance, tags, created_at, metadata
        FROM memories
        WHERE archived_at IS NULL
          AND (
            CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.project_entity_id') END = ?
            OR (
              ? IS NOT NULL
              AND CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.state_entity_id') END = ?
            )
          )
        ORDER BY created_at DESC, id ASC
      `,
    )
    .all(projectEntityId, stateEntityId, stateEntityId) as Array<{
      id: string;
      content: string;
      source: string;
      agent_id: string | null;
      importance: number;
      tags: string | null;
      created_at: string;
      metadata: string | null;
    }>;

  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    source: row.source,
    agentId: row.agent_id,
    importance: Number.isFinite(row.importance) ? Math.min(Math.max(row.importance, 0), 1) : 0.5,
    tags: parseJsonStringArray(row.tags),
    createdAt: row.created_at,
    metadata: parseJsonObject(row.metadata),
  }));
}

/** The conversation summary for a (conversationKey, agent) pair, if any. */
export function getAtlasConversationSummary(
  db: SqliteDatabase,
  input: { sessionId: string; agentId?: string; agentIds?: string[] },
): AtlasContextSummaryRow | null {
  const agentIds = uniqueAgentIds(input.agentIds?.length ? input.agentIds : [input.agentId]);
  if (agentIds.length === 0) return null;

  const orderCase = agentIds.map(() => "WHEN ? THEN ?").join(" ");
  const row = db
    .prepare(
      `
        SELECT id, session_id, agent_id, summary, covers_through, created_at
        FROM conversation_summaries
        WHERE session_id = ? AND agent_id IN (${agentIds.map(() => "?").join(", ")})
        ORDER BY CASE agent_id ${orderCase} ELSE ? END, created_at DESC
        LIMIT 1
      `,
    )
    .get(
      input.sessionId,
      ...agentIds,
      ...agentIds.flatMap((agentId, index) => [agentId, index]),
      agentIds.length,
    ) as
    | {
        id: string;
        session_id: string;
        agent_id: string;
        summary: string;
        covers_through: string | null;
        created_at: string;
      }
    | undefined;

  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    summary: row.summary,
    coversThrough: row.covers_through,
    createdAt: row.created_at,
  };
}

/** Pinned facts in context priority order: session → agent → global. */
export function listAtlasPinnedFactsForContext(
  db: SqliteDatabase,
  input: { sessionId?: string | null; agentId?: string | null; agentIds?: string[] },
): AtlasContextPinnedFactRow[] {
  const sessionId = input.sessionId?.trim() || null;
  const agentIds = uniqueAgentIds(input.agentIds?.length ? input.agentIds : [input.agentId]);
  const agentClause = agentIds.length > 0
    ? `OR (scope = 'agent' AND scope_id IN (${agentIds.map(() => "?").join(", ")}))`
    : "";
  const rows = db
    .prepare(
      `
        SELECT id, scope, scope_id, key, value, created_at, updated_at
        FROM pinned_facts
        WHERE (scope = 'global' AND scope_id IS NULL)
           OR (scope = 'session' AND scope_id = ?)
           ${agentClause}
        ORDER BY CASE scope WHEN 'session' THEN 0 WHEN 'agent' THEN 1 ELSE 2 END, key ASC
      `,
    )
    .all(sessionId, ...agentIds) as Array<{
    id: string;
    scope: PinnedFactScope;
    scope_id: string | null;
    key: string;
    value: string;
    created_at: string;
    updated_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    scopeId: row.scope_id,
    key: row.key,
    value: row.value,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/** Bump access tracking for memories that reached the prompt. */
export function touchAtlasMemories(
  db: SqliteDatabase,
  ids: string[],
  touchedAt: Date = new Date(),
): number {
  const uniqueIds = [...new Set(ids.filter((id) => id.trim().length > 0))];
  if (uniqueIds.length === 0) return 0;

  const statement = db.prepare(`
    UPDATE memories
    SET last_accessed_at = ?, access_count = access_count + 1
    WHERE id = ?
  `);
  const timestamp = touchedAt.toISOString();
  return runInTransaction(db, () => {
    let touched = 0;
    for (const id of uniqueIds) {
      touched += Number(statement.run(timestamp, id).changes ?? 0);
    }
    return touched;
  });
}
