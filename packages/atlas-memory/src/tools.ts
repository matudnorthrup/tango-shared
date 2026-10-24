import type { SQLInputValue } from "node:sqlite";
import { v4 as uuidv4 } from "uuid";
import { readMemoryOriginString, withMemoryOrigin } from "./origin.js";
import { runInTransaction } from "./schema.js";
import { createVoyageEmbeddingProviderFromEnv, decodeEmbedding, encodeEmbedding, rankMemories } from "./search.js";
import type {
  AtlasMemoryToolContext,
  AtlasMemoryToolDefinition,
  MemoryAdminFilter,
  MemoryRecord,
  MemorySource,
  PinnedFactRecord,
  PinnedFactScope,
} from "./types.js";

interface MemoryRow {
  id: string;
  content: string;
  source: MemorySource;
  agent_id: string | null;
  importance: number;
  tags: string | null;
  embedding: Buffer | null;
  embedding_model: string | null;
  created_at: string;
  last_accessed_at: string;
  access_count: number;
  archived_at: string | null;
  metadata: string | null;
}

interface PinnedFactRow {
  id: string;
  scope: PinnedFactScope;
  scope_id: string | null;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

interface StatsGroupRow {
  key: string | null;
  total: number;
}

const MEMORY_SOURCES = new Set<MemorySource>([
  "conversation",
  "reflection",
  "manual",
  "observation",
  "import",
  "obsidian",
]);
const PINNED_FACT_SCOPES = new Set<PinnedFactScope>(["global", "agent", "session"]);
const WELLNESS_AGENT_IDS = new Set(["malibu", "malibu-ollama"]);
const WELLNESS_MEMORY_PATTERN =
  /\b(food intake|fatsecret|nutrition|meal|breakfast|lunch|dinner|snacks?|yogurt|protein powder|protein bowl|calories?|workout|exercise|fitness)\b/iu;

export function createAtlasMemoryTools(
  context: AtlasMemoryToolContext,
): AtlasMemoryToolDefinition[] {
  const embeddingProvider =
    context.embeddingProvider === undefined
      ? createVoyageEmbeddingProviderFromEnv()
      : context.embeddingProvider;
  const now = () => (context.now ? context.now() : new Date());

  return [
    {
      name: "memory_search",
      description: [
        "Search stored memories by tag, text, or semantic similarity.",
        "When stored embeddings and Voyage credentials are available, semantic ranking is used.",
        "Results are prior memory, not evidence from the current source; use createdAt and origin metadata to attribute or verify them.",
      ].join("\n"),
      inputSchema: {
        type: "object",
          properties: {
            query: { type: "string" },
            agent_id: { type: "string" },
            agent_ids: {
              type: "array",
              items: { type: "string" },
            },
            tags: {
              type: "array",
              items: { type: "string" },
          },
          limit: { type: "number" },
          include_archived: { type: "boolean" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const query = readString(input.query, "query", true);
        const limit = readInteger(input.limit, 10, 1, 100);
        const filter = buildMemoryAdminFilter({
          agent_id: readOptionalString(input.agent_id),
          agent_ids: readOptionalStringArray(input.agent_ids),
          tags: readOptionalStringArray(input.tags),
          include_archived: readBoolean(input.include_archived, false),
        });

        const memories = selectMemories(context, filter);
        const results = await rankMemories({
          memories,
          query,
          limit,
          embeddingProvider,
        });

        touchMemories(context, results.map((memory) => memory.id), now().toISOString());
        return results;
      },
    },
    {
      name: "memory_add",
      description: "Store a memory and optionally persist its Voyage embedding.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string" },
          source: {
            type: "string",
            enum: [...MEMORY_SOURCES],
          },
          agent_id: { type: "string" },
          session_id: { type: "string" },
          importance: { type: "number" },
          tags: {
            type: "array",
            items: { type: "string" },
          },
          metadata: {
            type: "object",
            additionalProperties: true,
          },
        },
        required: ["content", "source"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const content = readString(input.content, "content");
        const source = readMemorySource(input.source);
        const agentId = readOptionalString(input.agent_id) ?? null;
        const sessionId = readOptionalString(input.session_id) ?? null;
        const importance = readNumber(input.importance, 0.5, 0, 1);
        const tags = normalizeTags(readOptionalStringArray(input.tags) ?? []);
        const timestamp = now().toISOString();
        const baseMetadata = buildMemoryMetadata(input.metadata, sessionId);
        const metadata = withMemoryOrigin(
          baseMetadata,
          {
            source,
            capturedAt: timestamp,
            occurredAt:
              readMemoryOriginString(baseMetadata, "occurred_at")
              ?? readMetadataString(input.metadata, "occurred_at")
              ?? timestamp,
            contextLabel:
              readMemoryOriginString(baseMetadata, "context_label")
              ?? readMetadataString(input.metadata, "context_label"),
            contextRef:
              readMemoryOriginString(baseMetadata, "context_ref")
              ?? readMetadataString(input.metadata, "context_ref"),
            sourceRef:
              readMemoryOriginString(baseMetadata, "source_ref")
              ?? readMetadataString(input.metadata, "source_ref"),
          },
        );
        const id = uuidv4();
        const embedding =
          embeddingProvider && content.length > 0
            ? (await embeddingProvider.embed([content], "document"))[0] ?? null
            : null;

        context.db.prepare(`
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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
        `).run(
          id,
          content,
          source,
          agentId,
          importance,
          JSON.stringify(tags),
          embedding ? encodeEmbedding(embedding) : null,
          embedding ? embeddingProvider?.model ?? null : null,
          timestamp,
          timestamp,
          metadata ? JSON.stringify(metadata) : JSON.stringify({}),
        );

        return { id };
      },
    },
    {
      name: "memory_reflect",
      description: [
        "Summarize recent memories for a session and agent and store a reflection memory.",
        "Session scope is matched from metadata.session_id when present.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          agent_id: { type: "string" },
        },
        required: ["session_id", "agent_id"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const sessionId = readString(input.session_id, "session_id");
        const agentId = readString(input.agent_id, "agent_id");
        const sourceMemories = selectMemories(context, {
          agent_id: agentId,
          session_id: sessionId,
          include_archived: false,
        })
          .filter((memory) => memory.source !== "reflection")
          .filter((memory) => shouldIncludeInReflection(agentId, memory))
          .sort((left, right) => compareDates(right.createdAt, left.createdAt))
          .slice(0, 10);

        if (sourceMemories.length === 0) {
          return {
            memories_created: 0,
            reflections: [],
          };
        }

        const reflectionText = sourceMemories
          .map((memory, index) => `${index + 1}. ${memory.content}`)
          .join("\n");
        const summary = `Prior conversation reflection:\n${reflectionText}`;
        const timestamp = now().toISOString();
        const reflectionId = uuidv4();
        const embedding =
          embeddingProvider && summary.length > 0
            ? (await embeddingProvider.embed([summary], "document"))[0] ?? null
            : null;
        const contextLabel = commonMemoryContextLabel(sourceMemories);
        const contextRef = commonMemoryOriginString(sourceMemories, "context_ref");
        const sourceDates = sourceMemories
          .map((memory) => readMemoryOriginString(memory.metadata, "occurred_at") ?? memory.createdAt)
          .filter((value) => Number.isFinite(Date.parse(value)))
          .sort(compareDates);
        const metadata = withMemoryOrigin({
          generated_by: "memory_reflect",
          session_id: sessionId,
          source_memory_ids: sourceMemories.map((memory) => memory.id),
          reflection_filter: "v2_non_wellness_excludes_wellness_noise",
          ...(sourceDates[0] ? { source_date_start: sourceDates[0] } : {}),
          ...(sourceDates.at(-1) ? { source_date_end: sourceDates.at(-1) } : {}),
        }, {
          source: "reflection",
          capturedAt: timestamp,
          occurredAt: timestamp,
          contextLabel,
          contextRef,
        });

        context.db.prepare(`
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
          ) VALUES (?, ?, 'reflection', ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
        `).run(
          reflectionId,
          summary,
          agentId,
          0.7,
          JSON.stringify(["reflection", "session-summary"]),
          embedding ? encodeEmbedding(embedding) : null,
          embedding ? embeddingProvider?.model ?? null : null,
          timestamp,
          timestamp,
          JSON.stringify(metadata),
        );

        context.db.prepare(`
          INSERT INTO conversation_summaries (
            id,
            session_id,
            agent_id,
            summary,
            covers_through,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id, agent_id) DO UPDATE SET
            summary = excluded.summary,
            covers_through = excluded.covers_through,
            created_at = excluded.created_at
        `).run(
          uuidv4(),
          sessionId,
          agentId,
          summary,
          sourceMemories[0]?.createdAt ?? timestamp,
          timestamp,
        );

        return {
          memories_created: 1,
          reflections: [summary],
        };
      },
    },
    {
      name: "pinned_fact_get",
      description: "Get pinned facts for a given scope and optional scope ID.",
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: [...PINNED_FACT_SCOPES],
          },
          scope_id: { type: "string" },
        },
        required: ["scope"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const scope = readPinnedFactScope(input.scope);
        const scopeId = readOptionalString(input.scope_id) ?? null;
        return selectPinnedFacts(context, scope, scopeId);
      },
    },
    {
      name: "pinned_fact_set",
      description: "Create or update a pinned fact by scope and key.",
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: [...PINNED_FACT_SCOPES],
          },
          scope_id: { type: "string" },
          key: { type: "string" },
          value: { type: "string" },
        },
        required: ["scope", "key", "value"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const scope = readPinnedFactScope(input.scope);
        const scopeId = readOptionalString(input.scope_id) ?? null;
        const key = readString(input.key, "key");
        const value = readString(input.value, "value");
        const timestamp = now().toISOString();
        const existing = context.db.prepare(`
          SELECT id
          FROM pinned_facts
          WHERE scope = ?
            AND ((scope_id = ?) OR (scope_id IS NULL AND ? IS NULL))
            AND key = ?
        `).get(scope, scopeId, scopeId, key) as { id: string } | undefined;

        const id = existing?.id ?? uuidv4();
        if (existing) {
          context.db.prepare(`
            UPDATE pinned_facts
            SET value = ?, updated_at = ?
            WHERE id = ?
          `).run(value, timestamp, id);
        } else {
          context.db.prepare(`
            INSERT INTO pinned_facts (
              id,
              scope,
              scope_id,
              key,
              value,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(id, scope, scopeId, key, value, timestamp, timestamp);
        }

        return { id };
      },
    },
    {
      name: "pinned_fact_delete",
      description: "Delete a pinned fact by scope and key.",
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: [...PINNED_FACT_SCOPES],
          },
          scope_id: { type: "string" },
          key: { type: "string" },
        },
        required: ["scope", "key"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const scope = readPinnedFactScope(input.scope);
        const scopeId = readOptionalString(input.scope_id) ?? null;
        const key = readString(input.key, "key");
        const result = context.db.prepare(`
          DELETE FROM pinned_facts
          WHERE scope = ?
            AND ((scope_id = ?) OR (scope_id IS NULL AND ? IS NULL))
            AND key = ?
        `).run(scope, scopeId, scopeId, key);

        return { deleted: result.changes > 0 };
      },
    },
    {
      name: "memory_admin",
      description: [
        "Administrative memory operations.",
        "Supported operations: archive, unarchive, tag, export, stats.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["archive", "unarchive", "tag", "export", "stats"],
          },
          filter: {
            type: "object",
            properties: {
              ids: {
                type: "array",
                items: { type: "string" },
              },
              agent_id: { type: "string" },
              agent_ids: {
                type: "array",
                items: { type: "string" },
              },
              source: { type: "string" },
              tags: {
                type: "array",
                items: { type: "string" },
              },
              include_archived: { type: "boolean" },
              session_id: { type: "string" },
              query: { type: "string" },
              add_tags: {
                type: "array",
                items: { type: "string" },
              },
              metadata_patch: {
                type: "object",
                description: "Metadata fields to merge when archiving selected memories.",
              },
            },
            additionalProperties: false,
          },
        },
        required: ["operation"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const operation = readString(input.operation, "operation");
        const filter = buildMemoryAdminFilter(input.filter);

        switch (operation) {
          case "archive": {
            return archiveMatchingMemories(context, filter, now().toISOString());
          }
          case "unarchive": {
            return unarchiveMatchingMemories(context, filter);
          }
          case "tag": {
            return tagMatchingMemories(context, filter);
          }
          case "export": {
            return {
              memories: selectMemories(context, {
                ...filter,
                include_archived: filter.include_archived ?? true,
              }),
            };
          }
          case "stats": {
            return collectMemoryStats(context, filter);
          }
          default:
            throw new Error(`Unsupported memory_admin operation: ${operation}`);
        }
      },
    },
  ];
}

function selectMemories(
  context: AtlasMemoryToolContext,
  filter: MemoryAdminFilter,
): MemoryRecord[] {
  const { whereClause, params } = buildMemoryWhereClause(filter);
  const rows = context.db.prepare(`
    SELECT
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
    FROM memories
    ${whereClause}
    ORDER BY created_at DESC, id DESC
  `).all(...params) as unknown as MemoryRow[];

  return rows.map(mapMemoryRow);
}

function selectPinnedFacts(
  context: AtlasMemoryToolContext,
  scope: PinnedFactScope,
  scopeId: string | null,
): PinnedFactRecord[] {
  const rows = context.db.prepare(`
    SELECT id, scope, scope_id, key, value, created_at, updated_at
    FROM pinned_facts
    WHERE scope = ?
      AND ((scope_id = ?) OR (scope_id IS NULL AND ? IS NULL))
    ORDER BY key ASC
  `).all(scope, scopeId, scopeId) as unknown as PinnedFactRow[];

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

function archiveMatchingMemories(
  context: AtlasMemoryToolContext,
  filter: MemoryAdminFilter,
  archivedAt: string,
): { updated: number } {
  if (filter.metadata_patch && Object.keys(filter.metadata_patch).length > 0) {
    const memories = selectMemories(context, { ...filter, include_archived: true });
    const update = context.db.prepare("UPDATE memories SET archived_at = ?, metadata = ? WHERE id = ?");
    runInTransaction(context.db, () => {
      for (const memory of memories) {
        update.run(archivedAt, JSON.stringify({ ...(memory.metadata ?? {}), ...filter.metadata_patch }), memory.id);
      }
    });
    return { updated: memories.length };
  }
  const { whereClause, params } = buildMemoryWhereClause({
    ...filter,
    include_archived: true,
  });

  const result = context.db.prepare(`
    UPDATE memories
    SET archived_at = ?
    ${whereClause}
  `).run(archivedAt, ...params);

  return { updated: Number(result.changes) };
}

function unarchiveMatchingMemories(
  context: AtlasMemoryToolContext,
  filter: MemoryAdminFilter,
): { updated: number } {
  const { whereClause, params } = buildMemoryWhereClause({
    ...filter,
    include_archived: true,
  });
  const result = context.db.prepare(`
    UPDATE memories
    SET archived_at = NULL
    ${whereClause}
  `).run(...params);

  return { updated: Number(result.changes) };
}

function tagMatchingMemories(
  context: AtlasMemoryToolContext,
  filter: MemoryAdminFilter,
): { updated: number } {
  const addTags = normalizeTags(filter.add_tags ?? []);
  if (addTags.length === 0) {
    throw new Error("memory_admin tag requires filter.add_tags");
  }

  const memories = selectMemories(context, {
    ...filter,
    include_archived: filter.include_archived ?? true,
  });
  const updateStatement = context.db.prepare("UPDATE memories SET tags = ? WHERE id = ?");
  runInTransaction(context.db, () => {
    for (const memory of memories) {
      const mergedTags = normalizeTags([...memory.tags, ...addTags]);
      updateStatement.run(JSON.stringify(mergedTags), memory.id);
    }
  });
  return { updated: memories.length };
}

function collectMemoryStats(
  context: AtlasMemoryToolContext,
  filter: MemoryAdminFilter,
): Record<string, unknown> {
  const statsFilter: MemoryAdminFilter = {
    ...filter,
    include_archived: filter.include_archived ?? true,
  };
  const { whereClause, params } = buildMemoryWhereClause(statsFilter);
  const total = context.db.prepare(`
    SELECT COUNT(*) AS total
    FROM memories
    ${whereClause}
  `).get(...params) as { total: number };
  const bySourceRows = context.db.prepare(`
    SELECT source AS key, COUNT(*) AS total
    FROM memories
    ${whereClause}
    GROUP BY source
    ORDER BY source ASC
  `).all(...params) as unknown as StatsGroupRow[];
  const byAgentRows = context.db.prepare(`
    SELECT COALESCE(agent_id, '__none__') AS key, COUNT(*) AS total
    FROM memories
    ${whereClause}
    GROUP BY COALESCE(agent_id, '__none__')
    ORDER BY COALESCE(agent_id, '__none__') ASC
  `).all(...params) as unknown as StatsGroupRow[];
  const archivedRows = context.db.prepare(`
    SELECT CASE WHEN archived_at IS NULL THEN 'active' ELSE 'archived' END AS key, COUNT(*) AS total
    FROM memories
    ${whereClause}
    GROUP BY CASE WHEN archived_at IS NULL THEN 'active' ELSE 'archived' END
    ORDER BY key ASC
  `).all(...params) as unknown as StatsGroupRow[];

  return {
    total: total.total,
    by_source: Object.fromEntries(bySourceRows.map((row) => [row.key ?? "unknown", row.total])),
    by_agent: Object.fromEntries(byAgentRows.map((row) => [row.key ?? "__none__", row.total])),
    by_archived_status: Object.fromEntries(
      archivedRows.map((row) => [row.key ?? "unknown", row.total]),
    ),
  };
}

function touchMemories(
  context: AtlasMemoryToolContext,
  ids: string[],
  touchedAt: string,
): void {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) {
    return;
  }

  const statement = context.db.prepare(`
    UPDATE memories
    SET last_accessed_at = ?, access_count = access_count + 1
    WHERE id = ?
  `);
  runInTransaction(context.db, () => {
    for (const id of uniqueIds) {
      statement.run(touchedAt, id);
    }
  });
}

function mapMemoryRow(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    content: row.content,
    source: row.source,
    agentId: row.agent_id,
    importance: normalizeImportance(row.importance),
    tags: parseStringArray(row.tags),
    embedding: decodeEmbedding(row.embedding),
    embeddingModel: row.embedding_model,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
    accessCount: Number(row.access_count) || 0,
    archivedAt: row.archived_at,
    metadata: parseJsonObject(row.metadata),
  };
}

function shouldIncludeInReflection(agentId: string, memory: MemoryRecord): boolean {
  if (WELLNESS_AGENT_IDS.has(agentId)) {
    return true;
  }
  return !WELLNESS_MEMORY_PATTERN.test(memory.content);
}

function buildMemoryAdminFilter(input: unknown): MemoryAdminFilter {
  const raw = isRecord(input) ? input : {};
  return {
    ids: readOptionalStringArray(raw.ids),
    agent_id: readOptionalString(raw.agent_id),
    agent_ids: readOptionalStringArray(raw.agent_ids),
    source: raw.source === undefined ? undefined : readMemorySource(raw.source),
    tags: readOptionalStringArray(raw.tags),
    include_archived: raw.include_archived === undefined ? undefined : readBoolean(raw.include_archived, false),
    session_id: readOptionalString(raw.session_id),
    query: readOptionalString(raw.query),
    add_tags: readOptionalStringArray(raw.add_tags),
    metadata_patch: isRecord(raw.metadata_patch) ? raw.metadata_patch : undefined,
  };
}

function buildMemoryWhereClause(filter: MemoryAdminFilter): {
  whereClause: string;
  params: SQLInputValue[];
} {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];

  const ids = uniqueStrings(filter.ids ?? []);
  if (ids.length > 0) {
    clauses.push(`id IN (${ids.map(() => "?").join(", ")})`);
    params.push(...ids);
  }

  const agentIds = uniqueStrings([
    ...(filter.agent_ids ?? []),
    ...(filter.agent_id ? [filter.agent_id] : []),
  ]);
  if (agentIds.length > 0) {
    clauses.push(`agent_id IN (${agentIds.map(() => "?").join(", ")})`);
    params.push(...agentIds);
  }

  if (filter.source) {
    clauses.push("source = ?");
    params.push(filter.source);
  }

  if (!(filter.include_archived ?? false)) {
    clauses.push("archived_at IS NULL");
  }

  for (const tag of normalizeTags(filter.tags ?? [])) {
    clauses.push(`
      EXISTS (
        SELECT 1
        FROM json_each(COALESCE(tags, '[]'))
        WHERE lower(value) = ?
      )
    `);
    params.push(tag);
  }

  if (filter.session_id) {
    clauses.push(`
      (
        json_extract(COALESCE(metadata, '{}'), '$.session_id') = ?
        OR json_extract(COALESCE(metadata, '{}'), '$.sessionId') = ?
      )
    `);
    params.push(filter.session_id, filter.session_id);
  }

  if (filter.query) {
    const pattern = `%${filter.query.trim().toLowerCase()}%`;
    clauses.push(`
      (
        lower(content) LIKE ?
        OR EXISTS (
          SELECT 1
          FROM json_each(COALESCE(tags, '[]'))
          WHERE lower(value) LIKE ?
        )
      )
    `);
    params.push(pattern, pattern);
  }

  return {
    whereClause: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function readString(value: unknown, fieldName: string, allowEmpty = false): string {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  const normalized = value.trim();
  if (!allowEmpty && normalized.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return normalized;
}

function readOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("Expected a string");
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readOptionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("Expected an array of strings");
  }
  return value
    .map((item) => {
      if (typeof item !== "string") {
        throw new Error("Expected an array of strings");
      }
      return item.trim();
    })
    .filter((item) => item.length > 0);
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error("Expected a boolean");
  }
  return value;
}

function readInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Expected a number");
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function readNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Expected a number");
  }
  return Math.min(Math.max(value, min), max);
}

function readMemorySource(value: unknown): MemorySource {
  const source = readString(value, "source");
  if (!MEMORY_SOURCES.has(source as MemorySource)) {
    throw new Error(`Unsupported memory source: ${source}`);
  }
  return source as MemorySource;
}

function readPinnedFactScope(value: unknown): PinnedFactScope {
  const scope = readString(value, "scope");
  if (!PINNED_FACT_SCOPES.has(scope as PinnedFactScope)) {
    throw new Error(`Unsupported pinned fact scope: ${scope}`);
  }
  return scope as PinnedFactScope;
}

function parseStringArray(value: string | null): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return normalizeTags(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return [];
  }
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildMemoryMetadata(
  value: unknown,
  sessionId: string | null,
): Record<string, unknown> | null {
  const base = isRecord(value) ? { ...value } : {};

  if (sessionId) {
    base.session_id = sessionId;
  }

  return Object.keys(base).length > 0 ? base : null;
}

function readMetadataString(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const candidate = value[key];
  if (typeof candidate !== "string") return null;
  const normalized = candidate.trim();
  return normalized.length > 0 ? normalized : null;
}

function memoryContextLabel(memory: MemoryRecord): string | null {
  const originLabel = readMemoryOriginString(memory.metadata, "context_label");
  if (originLabel) return originLabel;

  for (const key of ["context_label", "topic_title", "topicTitle", "project_title", "projectTitle", "title"] as const) {
    const value = readMetadataString(memory.metadata, key);
    if (value) return value;
  }

  return null;
}

function commonMemoryContextLabel(memories: MemoryRecord[]): string | null {
  const labels = memories.map(memoryContextLabel);
  if (labels.some((label) => label === null)) return null;
  const unique = new Set(labels);
  return unique.size === 1 ? labels[0] ?? null : null;
}

function commonMemoryOriginString(
  memories: MemoryRecord[],
  key: "context_ref" | "source_ref",
): string | null {
  const values = memories.map((memory) => readMemoryOriginString(memory.metadata, key));
  if (values.some((value) => value === null)) return null;
  const unique = new Set(values);
  return unique.size === 1 ? values[0] ?? null : null;
}

function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const tag of tags) {
    const value = tag.trim().toLowerCase();
    if (value.length === 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

function normalizeImportance(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.min(Math.max(value, 0), 1);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function compareDates(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
