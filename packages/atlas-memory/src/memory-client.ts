import {
  addObsidianMemories,
  createAtlasMemoryTools,
  deleteObsidianMemoriesBySourceRefPrefix,
  getAtlasConversationSummary,
  listAtlasMemoriesForContext,
  listAtlasMemoriesForStateProjection,
  listAtlasPinnedFactsForContext,
  openAtlasMemoryDatabase,
  touchAtlasMemories,
  type AtlasContextMemoryRow,
  type AtlasContextPinnedFactRow,
  type AtlasContextSummaryRow,
  type AtlasStateProjectionMemoryRow,
  type AtlasMemoryToolDefinition,
  type MemoryRecord,
  type ObsidianChunkUpsert,
  type PinnedFactRecord,
  type PinnedFactScope,
  type MemorySource,
  type SqliteDatabase,
} from "./index.js";

type AtlasMemoryToolHandler = AtlasMemoryToolDefinition["handler"];

export class AtlasMemoryClient {
  private readonly db: SqliteDatabase;
  private readonly tools: Map<string, AtlasMemoryToolHandler>;

  constructor(dbPath?: string) {
    const { db } = openAtlasMemoryDatabase({
      ...(dbPath ? { dbPath } : {}),
    });

    this.db = db;
    this.tools = new Map(
      createAtlasMemoryTools({ db }).map((tool) => [tool.name, tool.handler]),
    );
  }

  async memoryAdd(params: {
    content: string;
    source: MemorySource;
    agent_id?: string;
    session_id?: string;
    importance?: number;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string }> {
    return await this.callTool<{ id: string }>("memory_add", params);
  }

  async memorySearch(params: {
    query: string;
    agent_id?: string;
    agent_ids?: string[];
    tags?: string[];
    limit?: number;
  }): Promise<MemoryRecord[]> {
    return await this.callTool<MemoryRecord[]>("memory_search", params);
  }

  async pinnedFactGet(params: {
    scope: PinnedFactScope;
    scope_id?: string;
  }): Promise<PinnedFactRecord[]> {
    return await this.callTool<PinnedFactRecord[]>("pinned_fact_get", params);
  }

  async memoryReflect(params: {
    session_id: string;
    agent_id: string;
  }): Promise<{ memories_created: number; reflections: string[] }> {
    return await this.callTool<{
      memories_created: number;
      reflections: string[];
    }>("memory_reflect", params);
  }

  async memoryAdmin(params: {
    operation: "archive" | "unarchive" | "tag" | "export" | "stats";
    filter?: Record<string, unknown>;
  }): Promise<unknown> {
    return await this.callTool("memory_admin", params);
  }

  /** Candidate memories for warm-start ranking (agent-scoped + global, newest first). */
  listMemoriesForContext(input: { agentId?: string | null; agentIds?: string[]; limit?: number }): AtlasContextMemoryRow[] {
    return listAtlasMemoriesForContext(this.db, input);
  }

  /** Narrative associated with a state root; intentionally uncapped and embedding-free. */
  listMemoriesForStateProjection(input: {
    projectEntityId: string;
    stateEntityId?: string | null;
  }): AtlasStateProjectionMemoryRow[] {
    return listAtlasMemoriesForStateProjection(this.db, input);
  }

  getConversationSummaryForContext(input: {
    sessionId: string;
    agentId?: string;
    agentIds?: string[];
  }): AtlasContextSummaryRow | null {
    return getAtlasConversationSummary(this.db, input);
  }

  listPinnedFactsForWarmStart(input: {
    sessionId?: string | null;
    agentId?: string | null;
    agentIds?: string[];
  }): AtlasContextPinnedFactRow[] {
    return listAtlasPinnedFactsForContext(this.db, input);
  }

  touchMemoriesForContext(ids: string[]): number {
    return touchAtlasMemories(this.db, ids);
  }

  /** Remove Atlas copies of an Obsidian file's chunks before re-syncing (TGO-691). */
  obsidianPrune(sourceRefPrefix: string): number {
    return deleteObsidianMemoriesBySourceRefPrefix(this.db, sourceRefPrefix);
  }

  /** Mirror freshly indexed Obsidian chunks (with upstream embeddings) into Atlas. */
  obsidianAddChunks(chunks: ObsidianChunkUpsert[]): number {
    return addObsidianMemories(this.db, chunks).length;
  }

  close(): void {
    this.db.close();
  }

  private async callTool<TResult>(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<TResult> {
    const handler = this.tools.get(toolName);
    if (!handler) {
      throw new Error(`Atlas memory tool '${toolName}' is not registered`);
    }

    return await handler(params) as TResult;
  }
}
