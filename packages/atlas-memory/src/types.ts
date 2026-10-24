import type { DatabaseSync } from "node:sqlite";

export type SqliteDatabase = DatabaseSync;

export type MemorySource =
  | "conversation"
  | "reflection"
  | "manual"
  | "observation"
  | "import"
  | "obsidian";

export type PinnedFactScope = "global" | "agent" | "session";

export type EmbeddingInputType = "query" | "document";

export interface EmbeddingProvider {
  readonly model: string;
  embed(texts: string[], inputType?: EmbeddingInputType): Promise<number[][]>;
}

export interface MemoryRecord {
  id: string;
  content: string;
  source: MemorySource;
  agentId: string | null;
  importance: number;
  tags: string[];
  embedding: number[] | null;
  embeddingModel: string | null;
  createdAt: string;
  lastAccessedAt: string;
  accessCount: number;
  archivedAt: string | null;
  metadata: Record<string, unknown> | null;
}

export interface PinnedFactRecord {
  id: string;
  scope: PinnedFactScope;
  scopeId: string | null;
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSummaryRecord {
  id: string;
  sessionId: string;
  agentId: string;
  summary: string;
  coversThrough: string | null;
  createdAt: string;
}

export interface AtlasMemoryToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface AtlasMemoryToolContext {
  db: SqliteDatabase;
  embeddingProvider?: EmbeddingProvider | null;
  now?: () => Date;
}

export interface MemoryAdminFilter {
  ids?: string[];
  agent_id?: string;
  agent_ids?: string[];
  source?: MemorySource;
  tags?: string[];
  include_archived?: boolean;
  session_id?: string;
  query?: string;
  add_tags?: string[];
  metadata_patch?: Record<string, unknown>;
}
