import {
  estimateTokenCount,
  type MemorySource,
  type PinnedFactRecord,
  type SessionSummaryRecord,
  type StoredMemoryRecord,
  type TangoStorage,
} from "@tango/core";
import type { AtlasContextMemoryRow } from "@tango/atlas-memory";
import type { AtlasMemoryClient } from "./atlas-memory-client.js";

/**
 * Store consolidation: warm-start's distilled-memory zones (memories, pinned
 * facts, summaries) can read either the legacy core tables or the Atlas store
 * — Atlas is where every fresh writer points (post-turn extraction, daily
 * reflections, the obsidian mirror). The substrate is flag-selected with
 * per-call fallback to core, so rollback is an env flip, not a deploy.
 */
export type WarmStartMemorySubstrate = "atlas" | "core";

export interface WarmStartMemoryQuery {
  sessionId: string;
  agentId: string;
  memoryAgentId?: string;
  memoryAgentIds?: string[];
  /** thread:{id} / channel:{id} — Atlas conversation artifacts key on this. */
  conversationKey: string | null;
  memoryPoolLimit: number;
  /**
   * Isolated agents see only rows owned by their own memory scope: no shared
   * (agent_id null) memories such as the Obsidian mirror, and no global pinned
   * facts.
   */
  isolated?: boolean;
}

function restrictToOwnScope(
  bundle: WarmStartMemoryBundle,
  memoryAgentIds: readonly string[],
): WarmStartMemoryBundle {
  const ownIds = new Set(memoryAgentIds);
  return {
    ...bundle,
    memories: bundle.memories.filter((memory) => memory.agentId !== null && ownIds.has(memory.agentId)),
    pinnedFacts: bundle.pinnedFacts.filter((fact) => fact.scope !== "global"),
  };
}

export interface WarmStartMemoryBundle {
  substrate: WarmStartMemorySubstrate;
  memories: StoredMemoryRecord[];
  summaries: SessionSummaryRecord[];
  pinnedFacts: PinnedFactRecord[];
  /** Record access for the memories that reached the prompt. */
  touch(accessedMemoryIds: number[]): void;
}

export function resolveWarmStartMemorySubstrate(
  env: NodeJS.ProcessEnv = process.env,
): WarmStartMemorySubstrate {
  return env.TANGO_WARM_START_MEMORY_SOURCE?.trim().toLowerCase() === "core" ? "core" : "atlas";
}

export function loadCoreWarmStartMemory(
  storage: TangoStorage,
  query: WarmStartMemoryQuery,
): WarmStartMemoryBundle {
  const memoryAgentId = query.memoryAgentId ?? query.agentId;
  const memoryAgentIds = query.memoryAgentIds?.length ? query.memoryAgentIds : [memoryAgentId];

  const bundle: WarmStartMemoryBundle = {
    substrate: "core",
    memories: storage.listMemories({
      sessionId: query.sessionId,
      agentId: memoryAgentId,
      agentIds: memoryAgentIds,
      limit: query.memoryPoolLimit,
    }),
    summaries: storage.listSessionMemorySummaries(query.sessionId, memoryAgentId, 24),
    pinnedFacts: storage.listPinnedFactsForContext(query.sessionId, memoryAgentId),
    touch: (accessedMemoryIds) => {
      if (accessedMemoryIds.length > 0) storage.touchMemories(accessedMemoryIds);
    },
  };
  return query.isolated ? restrictToOwnScope(bundle, memoryAgentIds) : bundle;
}

const ATLAS_SOURCE_MAP: Record<string, MemorySource> = {
  conversation: "conversation",
  reflection: "reflection",
  manual: "manual",
  obsidian: "obsidian",
  // Core's MemorySource union has no observation/import; fold them into the
  // nearest semantics so ranking bonuses behave sensibly.
  observation: "manual",
  import: "backfill",
};

/**
 * Map raw Atlas rows into core-shaped memory records for ranking. Synthetic
 * numeric ids are positional; the returned map translates them back to Atlas
 * ids for access-touch bookkeeping.
 */
export function mapAtlasContextRows(rows: AtlasContextMemoryRow[]): {
  memories: StoredMemoryRecord[];
  idToAtlasId: Map<number, string>;
} {
  const idToAtlasId = new Map<number, string>();
  const memories: StoredMemoryRecord[] = rows.map((row, index) => {
    const syntheticId = index + 1;
    idToAtlasId.set(syntheticId, row.id);
    const sourceRef = typeof row.metadata?.source_ref === "string" ? row.metadata.source_ref : null;
    return {
      id: syntheticId,
      // Atlas scopes by agent; session affinity lives in metadata. Null keeps
      // these visible to every session-scoped filter (global semantics).
      sessionId: null,
      agentId: row.agentId,
      source: ATLAS_SOURCE_MAP[row.source] ?? "manual",
      content: row.content,
      importance: row.importance,
      sourceRef,
      embeddingJson: null,
      embedding: row.embedding,
      embeddingModel: row.embeddingModel,
      createdAt: row.createdAt,
      lastAccessedAt: row.lastAccessedAt,
      accessCount: row.accessCount,
      archivedAt: null,
      metadata: {
        ...(row.metadata ?? {}),
        atlas_source: row.source,
      },
    };
  });
  return { memories, idToAtlasId };
}

export function loadAtlasWarmStartMemory(
  client: AtlasMemoryClient,
  query: WarmStartMemoryQuery,
): WarmStartMemoryBundle {
  const memoryAgentId = query.memoryAgentId ?? query.agentId;
  const memoryAgentIds = query.memoryAgentIds?.length ? query.memoryAgentIds : [memoryAgentId];
  const { memories, idToAtlasId } = mapAtlasContextRows(
    client.listMemoriesForContext({
      agentId: memoryAgentId,
      agentIds: memoryAgentIds,
      limit: query.memoryPoolLimit,
    }),
  );

  const summaries: SessionSummaryRecord[] = [];
  if (query.conversationKey) {
    const summary = client.getConversationSummaryForContext({
      sessionId: query.conversationKey,
      agentId: memoryAgentId,
      agentIds: memoryAgentIds,
    });
    if (summary) {
      summaries.push({
        id: 1,
        sessionId: query.sessionId,
        agentId: memoryAgentId,
        summaryText: summary.summary,
        tokenCount: estimateTokenCount(summary.summary),
        coversThroughMessageId: null,
        createdAt: summary.createdAt,
        updatedAt: summary.createdAt,
      });
    }
  }

  const pinnedFacts: PinnedFactRecord[] = client
    .listPinnedFactsForWarmStart({
      sessionId: query.conversationKey ?? query.sessionId,
      agentId: memoryAgentId,
      agentIds: memoryAgentIds,
    })
    .map((fact, index) => ({
      id: index + 1,
      scope: fact.scope,
      scopeId: fact.scopeId,
      key: fact.key,
      value: fact.value,
      createdAt: fact.createdAt,
      updatedAt: fact.updatedAt,
    }));

  const bundle: WarmStartMemoryBundle = {
    substrate: "atlas",
    memories,
    summaries,
    pinnedFacts,
    touch: (accessedMemoryIds) => {
      const atlasIds = accessedMemoryIds
        .map((id) => idToAtlasId.get(id))
        .filter((id): id is string => typeof id === "string");
      if (atlasIds.length > 0) client.touchMemoriesForContext(atlasIds);
    },
  };
  return query.isolated ? restrictToOwnScope(bundle, memoryAgentIds) : bundle;
}
