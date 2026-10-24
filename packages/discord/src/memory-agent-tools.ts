import type { AgentTool, EmbeddingProvider, SessionConfig } from "@tango/core";
import {
  createVoyageEmbeddingProviderFromEnv,
  extractMemoryKeywords,
  loadSessionConfigs,
  runMemoryReflectionCycle,
  resolveConfigDir,
  resolveDatabasePath,
  resolveSessionMemoryConfig,
  searchMemories,
  serializeEmbedding,
  TangoStorage,
} from "@tango/core";

const MEMORY_SOURCES = new Set(["conversation", "obsidian", "reflection", "manual", "backfill"]);
const ADDABLE_MEMORY_SOURCES = new Set(["manual", "reflection"]);

export interface MemoryToolOptions {
  storage?: TangoStorage;
  dbPath?: string;
  configDir?: string;
  embeddingProvider?: EmbeddingProvider | null;
}

export function createMemoryTools(overrides?: MemoryToolOptions): AgentTool[] {
  const storage = overrides?.storage ?? new TangoStorage(resolveDatabasePath(overrides?.dbPath));
  const embeddingProvider =
    overrides?.embeddingProvider === undefined
      ? createVoyageEmbeddingProviderFromEnv()
      : overrides.embeddingProvider;
  const sessionConfigById = loadSessionConfigMap(overrides?.configDir);

  return [
    {
      name: "memory_search",
      description: [
        "Search stored memories across conversation summaries, manual notes, and other memory sources.",
        "Supports optional session and agent scoping, and returns ranked results with score breakdowns.",
        "Results are prior memory, not evidence from the current source; use created_at and origin metadata to attribute or verify them.",
        "",
        "Fields:",
        "  query (required) — natural-language query",
        "  source — one of conversation, obsidian, reflection, manual, backfill, all",
        "  limit — max results to return (default 10, hard max 25)",
        "  session_id — optional Tango session scope",
        "  agent_id — optional Tango agent scope",
        "  agent_ids — optional list of Tango agent scopes to search together",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural-language memory search query",
          },
          source: {
            type: "string",
            enum: ["conversation", "obsidian", "reflection", "manual", "backfill", "all"],
            description: "Optional memory source filter",
          },
          limit: {
            type: "number",
            description: "Maximum results to return (default 10, max 25)",
          },
          session_id: {
            type: "string",
            description: "Optional Tango session ID scope",
          },
          agent_id: {
            type: "string",
            description: "Optional Tango agent ID scope",
          },
          agent_ids: {
            type: "array",
            items: { type: "string" },
            description: "Optional Tango agent IDs to search together",
          },
        },
        required: ["query"],
      },
      handler: async (input) => {
        const query = String(input.query ?? "").trim();
        if (query.length === 0) {
          return { error: "memory_search requires a non-empty query" };
        }

        const source = normalizeMemorySource(input.source);
        const sessionId = normalizeOptionalString(input.session_id);
        const agentId = normalizeOptionalString(input.agent_id);
        const agentIds = normalizeOptionalStringArray(input.agent_ids);
        const memoryAgentIds = agentIds.length > 0 ? agentIds : agentId ? [agentId] : [];
        const limit = clampLimit(input.limit, 10, 25);
        // Brute-force ranking is still cheap at current corpus sizes, so favor recall.
        const candidateLimit = 20_000;
        const memories = storage.listMemories({
          sessionId,
          agentId,
          agentIds: memoryAgentIds,
          source,
          limit: candidateLimit,
        });
        const sessionMemoryConfig =
          sessionId && sessionConfigById.has(sessionId) ? sessionConfigById.get(sessionId)?.memory : undefined;
        const rankingAgentId = memoryAgentIds.length === 1 ? memoryAgentIds[0] : undefined;
        const results = await searchMemories({
          query,
          memories,
          embeddingProvider,
          sessionId: sessionId ?? undefined,
          agentId: rankingAgentId,
          source,
          limit,
          retrievalWeights: resolveSessionMemoryConfig(sessionMemoryConfig).retrievalWeights,
        });

        if (results.length > 0) {
          storage.touchMemories(results.map((memory) => memory.id));
        }

        return {
          query,
          result_count: results.length,
          results: results.map((memory) => ({
            id: memory.id,
            session_id: memory.sessionId,
            agent_id: memory.agentId,
            source: memory.source,
            content: memory.content,
            importance: memory.importance,
            source_ref: memory.sourceRef,
            created_at: memory.createdAt,
            score: round(memory.score),
            relevance_score: round(memory.relevanceScore),
            keyword_score: round(memory.keywordScore),
            semantic_score: round(memory.semanticScore),
            recency_score: round(memory.recencyScore),
            source_bonus: round(memory.sourceBonus),
            quality_penalty: round(memory.qualityPenalty),
            metadata: memory.metadata,
          })),
        };
      },
    },
    {
      name: "memory_add",
      description: [
        "Store an explicit memory for later retrieval.",
        "Use this for facts, preferences, or decisions that should survive across sessions.",
        "",
        "Fields:",
        "  content (required) — the memory text",
        "  importance — 0.0 to 1.0 (default 0.7)",
        "  source — manual or reflection (default manual)",
        "  tags — optional keyword tags",
        "  session_id — optional Tango session scope",
        "  agent_id — optional Tango agent scope",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "Memory text to store",
          },
          importance: {
            type: "number",
            description: "Importance score between 0.0 and 1.0",
          },
          source: {
            type: "string",
            enum: ["manual", "reflection"],
            description: "Memory source label",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional keyword tags",
          },
          session_id: {
            type: "string",
            description: "Optional Tango session ID scope",
          },
          agent_id: {
            type: "string",
            description: "Optional Tango agent ID scope",
          },
        },
        required: ["content"],
      },
      handler: async (input) => {
        const content = String(input.content ?? "").trim();
        if (content.length === 0) {
          return { error: "memory_add requires non-empty content" };
        }

        const source = normalizeMemoryAddSource(input.source);
        const importance = clampImportance(input.importance, 0.7);
        const tags = normalizeTags(input.tags);
        const sessionId = normalizeOptionalString(input.session_id);
        const agentId = normalizeOptionalString(input.agent_id);
        const embedding =
          embeddingProvider && content.length > 0
            ? await embedDocumentSafely(embeddingProvider, content)
            : null;

        const memoryId = storage.insertMemory({
          sessionId,
          agentId,
          source,
          content,
          importance,
          embeddingJson: embedding ? serializeEmbedding(embedding) : null,
          embeddingModel: embedding ? embeddingProvider?.model ?? null : null,
          metadata: {
            tags,
            keywords: tags.length > 0 ? tags : extractMemoryKeywords(content),
          },
        });

        const memory = storage.getMemory(memoryId);
        return {
          memory: memory
            ? {
                id: memory.id,
                session_id: memory.sessionId,
                agent_id: memory.agentId,
                source: memory.source,
                content: memory.content,
                importance: memory.importance,
                embedding_model: memory.embeddingModel,
                metadata: memory.metadata,
                created_at: memory.createdAt,
              }
            : { id: memoryId },
        };
      },
    },
    {
      name: "memory_reflect",
      description: [
        "Generate high-level reflection memories from recent stored memories.",
        "Use this to synthesize recurring themes, preferences, and active decisions.",
        "",
        "Fields:",
        "  lookback_hours — how far back to scan (default 24, max 720)",
        "  max_reflections — max reflections to create (default 5, max 10)",
        "  session_id — optional Tango session scope",
        "  agent_id — optional Tango agent scope",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          lookback_hours: {
            type: "number",
            description: "How far back to scan for source memories (default 24, max 720)",
          },
          max_reflections: {
            type: "number",
            description: "Maximum reflections to create (default 5, max 10)",
          },
          session_id: {
            type: "string",
            description: "Optional Tango session ID scope",
          },
          agent_id: {
            type: "string",
            description: "Optional Tango agent ID scope",
          },
        },
      },
      handler: async (input) => {
        const lookbackHours = clampLimit(input.lookback_hours, 24, 720);
        const maxReflections = clampLimit(input.max_reflections, 5, 10);
        const sessionId = normalizeOptionalString(input.session_id);
        const agentId = normalizeOptionalString(input.agent_id);
        const result = await runMemoryReflectionCycle({
          storage,
          embeddingProvider,
          lookbackHours,
          maxReflections,
          sessionId,
          agentId,
        });

        return {
          lookback_hours: lookbackHours,
          max_reflections: maxReflections,
          scanned_count: result.scannedCount,
          eligible_count: result.eligibleCount,
          created_count: result.createdCount,
          created: result.createdMemories.map((memory) => ({
            id: memory.id,
            session_id: memory.sessionId,
            agent_id: memory.agentId,
            source: memory.source,
            content: memory.content,
            importance: memory.importance,
            source_ref: memory.sourceRef,
            embedding_model: memory.embeddingModel,
            metadata: memory.metadata,
            created_at: memory.createdAt,
          })),
        };
      },
    },
  ];
}

function loadSessionConfigMap(configDir?: string): Map<string, SessionConfig> {
  try {
    const sessions = loadSessionConfigs(resolveConfigDir(configDir));
    return new Map(sessions.map((session) => [session.id, session]));
  } catch {
    return new Map();
  }
}

function normalizeMemorySource(value: unknown): "conversation" | "obsidian" | "reflection" | "manual" | "backfill" | "all" {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized || normalized === "all") return "all";
  return MEMORY_SOURCES.has(normalized)
    ? (normalized as "conversation" | "obsidian" | "reflection" | "manual" | "backfill")
    : "all";
}

function normalizeMemoryAddSource(value: unknown): "manual" | "reflection" {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) return "manual";
  return ADDABLE_MEMORY_SOURCES.has(normalized)
    ? (normalized as "manual" | "reflection")
    : "manual";
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeOptionalStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  )];
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(Math.floor(parsed), max));
}

function clampImportance(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 0), 1);
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0)
  )];
}

async function embedDocumentSafely(
  embeddingProvider: EmbeddingProvider,
  content: string
): Promise<number[] | null> {
  try {
    const [embedding] = await embeddingProvider.embed([content], "document");
    return embedding && embedding.length > 0 ? embedding : null;
  } catch {
    return null;
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
