import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ActiveTaskStatus, MemorySource, PinnedFactScope, SessionConfig } from "./types.js";
import type { SubAgentStatus } from "./sub-agent-runner.js";
import { GOVERNANCE_DDL, GOVERNANCE_SEED, GOVERNANCE_EXAMPLE_SEED } from "./governance-schema.js";

/** Discord delivery context retained while Loom owns the hosted turn. */
export interface LoomDelivery {
  runId: string;
  agentId: string;
  conversationKey: string;
  loomThreadId: string;
  channelId: string;
  threadId?: string;
  messageId: string;
  createdAt: string;
  context: {
    transport?: "conversation";
    sessionId: string;
    prompt: string;
    retryText?: string;
    requestMessageId?: number | null;
    occurredAt: string;
    model?: string;
    contextRef?: string;
    contextLabel?: string;
  };
}

export interface ProviderSessionRecord {
  conversationKey: string;
  sessionId: string;
  agentId: string;
  providerName: string;
  providerSessionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionProviderOverrideRecord {
  sessionId: string;
  agentId: string;
  providerName: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionCompactionRecord {
  sessionId: string;
  agentId: string;
  summaryText: string;
  compactedTurns: number;
  createdAt: string;
  updatedAt: string;
}

export type StoredMessageDirection = "inbound" | "outbound" | "system" | "error";
export type StoredMessageSource = "discord" | "imessage" | "tango" | "desk" | "voice";
export type StoredMessageVisibility = "public" | "internal" | "debug";

export interface StoredMessageRecord {
  id: number;
  sessionId: string;
  agentId: string | null;
  providerName: string | null;
  direction: StoredMessageDirection;
  source: StoredMessageSource;
  visibility: StoredMessageVisibility;
  discordMessageId: string | null;
  discordChannelId: string | null;
  discordUserId: string | null;
  discordUsername: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface ConversationAttachment {
  name: string;
  contentType?: string | null;
  size?: number;
  url?: string;
  localPath?: string;
  error?: string;
}

export interface ConversationPostInput extends MessageInsertInput {
  localMessageId?: number;
  /** Home-channel owner; a guest post must not change conversation ownership. */
  conversationAgentId?: string;
  conversationKey: string;
  authorKind: "owner" | "agent" | "system" | "requester";
  discordMessageIds?: string[];
  replyToMessageId?: number | null;
  attachments?: ConversationAttachment[];
  createdAt?: string;
  title?: string;
  origin?: "desk" | "discord" | "voice" | "schedule" | "check-in";
  discordThreadId?: string | null;
  discordParentChannelId?: string | null;
}

export interface MessageInsertInput {
  sessionId: string;
  agentId?: string | null;
  providerName?: string | null;
  direction: StoredMessageDirection;
  source: StoredMessageSource;
  visibility?: StoredMessageVisibility;
  discordMessageId?: string | null;
  discordChannelId?: string | null;
  discordUserId?: string | null;
  discordUsername?: string | null;
  content: string;
  metadata?: Record<string, unknown> | null;
}

export type ChannelReferentKind = "reaction";

export interface ChannelReferentRecord {
  channelId: string;
  discordUserId: string;
  kind: ChannelReferentKind;
  targetMessageId: string;
  targetSessionId: string | null;
  targetAgentId: string | null;
  targetDirection: StoredMessageDirection | null;
  targetSource: StoredMessageSource | null;
  targetContent: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface ChannelReferentUpsertInput {
  channelId: string;
  discordUserId: string;
  kind: ChannelReferentKind;
  targetMessageId: string;
  targetSessionId?: string | null;
  targetAgentId?: string | null;
  targetDirection?: StoredMessageDirection | null;
  targetSource?: StoredMessageSource | null;
  targetContent: string;
  metadata?: Record<string, unknown> | null;
  expiresAt?: string | null;
}

export interface ModelRunRecord {
  id: number;
  sessionId: string;
  agentId: string;
  providerName: string;
  conversationKey: string;
  providerSessionId: string | null;
  model: string | null;
  stopReason: string | null;
  responseMode: string | null;
  latencyMs: number | null;
  providerDurationMs: number | null;
  providerApiDurationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  totalCostUsd: number | null;
  isError: number;
  errorMessage: string | null;
  requestMessageId: number | null;
  responseMessageId: number | null;
  metadata: Record<string, unknown> | null;
  rawResponse: Record<string, unknown> | null;
  createdAt: string;
}

export interface ModelRunInsertInput {
  sessionId: string;
  agentId: string;
  providerName: string;
  conversationKey: string;
  providerSessionId?: string | null;
  model?: string | null;
  stopReason?: string | null;
  responseMode?: string | null;
  latencyMs?: number | null;
  providerDurationMs?: number | null;
  providerApiDurationMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  totalCostUsd?: number | null;
  isError?: boolean;
  errorMessage?: string | null;
  requestMessageId?: number | null;
  responseMessageId?: number | null;
  metadata?: Record<string, unknown> | null;
  rawResponse?: Record<string, unknown> | null;
}

export interface ModelRunStatRow {
  agentId: string;
  model: string | null;
  providerName: string;
  stopReason: string | null;
  latencyMs: number | null;
  outputTokens: number | null;
  isError: boolean;
  createdAt: string;
}

export type DeterministicRouteOutcome = "executed" | "clarification" | "fallback";

export interface DeterministicTurnRecord {
  id: string;
  sessionId: string;
  agentId: string;
  conversationKey: string;
  initiatingPrincipalId: string;
  leadAgentPrincipalId: string;
  projectId: string | null;
  topicId: string | null;
  intentCount: number;
  intentIds: string[];
  intentJson: unknown;
  intentModelRunId: number | null;
  routeOutcome: DeterministicRouteOutcome;
  fallbackReason: string | null;
  executionPlanJson: unknown;
  stepCount: number;
  completedStepCount: number;
  failedStepCount: number;
  hasWriteOperations: boolean;
  workerIds: string[];
  delegationChain: string[];
  receiptsJson: unknown;
  narrationProvider: string | null;
  narrationModel: string | null;
  narrationLatencyMs: number | null;
  narrationRetried: boolean;
  narrationModelRunId: number | null;
  intentLatencyMs: number | null;
  routeLatencyMs: number | null;
  executionLatencyMs: number | null;
  totalLatencyMs: number | null;
  requestMessageId: number | null;
  responseMessageId: number | null;
  createdAt: string;
}

export interface DeterministicTurnInsertInput {
  id?: string;
  sessionId: string;
  agentId: string;
  conversationKey: string;
  initiatingPrincipalId: string;
  leadAgentPrincipalId: string;
  projectId?: string | null;
  topicId?: string | null;
  intentIds?: string[];
  intentJson: unknown;
  intentModelRunId?: number | null;
  routeOutcome: DeterministicRouteOutcome;
  fallbackReason?: string | null;
  executionPlanJson?: unknown;
  completedStepCount?: number;
  failedStepCount?: number;
  hasWriteOperations?: boolean;
  workerIds?: string[];
  delegationChain?: string[];
  receiptsJson?: unknown;
  narrationProvider?: string | null;
  narrationModel?: string | null;
  narrationLatencyMs?: number | null;
  narrationRetried?: boolean;
  narrationModelRunId?: number | null;
  intentLatencyMs?: number | null;
  routeLatencyMs?: number | null;
  executionLatencyMs?: number | null;
  totalLatencyMs?: number | null;
  requestMessageId?: number | null;
  responseMessageId?: number | null;
}

export interface SubAgentRunRecord {
  id: string;
  batchId: string;
  parentSessionId: string | null;
  parentAgentId: string | null;
  conversationKey: string | null;
  coordinatorWorkerId: string;
  roundIndex: number;
  subTaskId: string;
  providerName: string | null;
  model: string | null;
  reasoningEffort: string | null;
  toolIds: string[];
  dependencyIds: string[];
  status: SubAgentStatus;
  durationMs: number;
  costEstimateUsd: number | null;
  error: string | null;
  outputText: string | null;
  toolCallsJson: unknown;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface SubAgentRunInsertInput {
  id?: string;
  batchId: string;
  parentSessionId?: string | null;
  parentAgentId?: string | null;
  conversationKey?: string | null;
  coordinatorWorkerId: string;
  roundIndex: number;
  subTaskId: string;
  providerName?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  toolIds?: string[];
  dependencyIds?: string[];
  status: SubAgentStatus;
  durationMs?: number;
  costEstimateUsd?: number | null;
  error?: string | null;
  outputText?: string | null;
  toolCallsJson?: unknown;
  metadata?: Record<string, unknown> | null;
}

export type AgentCollaborationStatus =
  | "proposed"
  | "running"
  | "waiting_on_user"
  | "completed"
  | "failed"
  | "canceled"
  | "denied"
  | "expired";
export type AgentCollaborationVisibilityMode = "summary" | "digest" | "thread" | "transcript" | "silent";
export type AgentCollaborationInitiatorKind = "user" | "agent" | "schedule" | "system";
export type AgentCollaborationTurnType = "request" | "clarification" | "result" | "status" | "escalation" | "error";
export type AgentCollaborationDeliveryStatus = "delivered" | "failed";

export interface AgentCollaborationSessionRecord {
  id: string;
  parentCollaborationId: string | null;
  requesterAgentId: string;
  targetAgentId: string;
  initiatorKind: AgentCollaborationInitiatorKind;
  initiatorRef: string | null;
  purpose: string;
  objective: string;
  normalizedObjective: string;
  contextSummary: string | null;
  deliverableContract: Record<string, unknown>;
  constraints: string[];
  status: AgentCollaborationStatus;
  visibilityMode: AgentCollaborationVisibilityMode;
  userSurface: Record<string, unknown> | null;
  budget: Record<string, unknown>;
  policyDecision: Record<string, unknown> | null;
  resultSummary: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

export interface AgentCollaborationSessionInsertInput {
  id?: string;
  parentCollaborationId?: string | null;
  requesterAgentId: string;
  targetAgentId: string;
  initiatorKind: AgentCollaborationInitiatorKind;
  initiatorRef?: string | null;
  purpose: string;
  objective: string;
  normalizedObjective: string;
  contextSummary?: string | null;
  deliverableContract?: Record<string, unknown>;
  constraints?: string[];
  status: AgentCollaborationStatus;
  visibilityMode: AgentCollaborationVisibilityMode;
  userSurface?: Record<string, unknown> | null;
  budget?: Record<string, unknown>;
  policyDecision?: Record<string, unknown> | null;
  resultSummary?: string | null;
  error?: string | null;
  expiresAt?: string | null;
}

export interface AgentCollaborationSessionUpdateInput {
  status?: AgentCollaborationStatus;
  policyDecision?: Record<string, unknown> | null;
  resultSummary?: string | null;
  error?: string | null;
  expiresAt?: string | null;
}

export interface AgentCollaborationTurnRecord {
  id: string;
  collaborationId: string;
  turnIndex: number;
  senderAgentId: string;
  recipientAgentId: string;
  turnType: AgentCollaborationTurnType;
  content: string;
  structured: Record<string, unknown> | null;
  modelRunId: number | null;
  visibleMessageRef: string | null;
  createdAt: string;
}

export interface AgentCollaborationTurnInsertInput {
  id?: string;
  collaborationId: string;
  turnIndex: number;
  senderAgentId: string;
  recipientAgentId: string;
  turnType: AgentCollaborationTurnType;
  content: string;
  structured?: Record<string, unknown> | null;
  modelRunId?: number | null;
  visibleMessageRef?: string | null;
}

export interface AgentCollaborationDeliveryRecord {
  id: string;
  collaborationId: string;
  eventKind: string;
  destinationChannelId: string | null;
  destinationThreadId: string | null;
  discordMessageId: string | null;
  status: AgentCollaborationDeliveryStatus;
  error: string | null;
  createdAt: string;
}

export interface AgentCollaborationDeliveryInsertInput {
  id?: string;
  collaborationId: string;
  eventKind: string;
  destinationChannelId?: string | null;
  destinationThreadId?: string | null;
  discordMessageId?: string | null;
  status: AgentCollaborationDeliveryStatus;
  error?: string | null;
}

export interface ActiveTaskRecord {
  id: string;
  sessionId: string;
  agentId: string;
  status: ActiveTaskStatus;
  title: string;
  objective: string;
  ownerWorkerId: string | null;
  intentIds: string[];
  missingSlots: string[];
  clarificationQuestion: string | null;
  suggestedNextAction: string | null;
  structuredContext: Record<string, unknown> | null;
  sourceKind: string;
  createdByMessageId: number | null;
  updatedByMessageId: number | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  expiresAt: string | null;
}

export interface ActiveTaskUpsertInput {
  id?: string;
  sessionId: string;
  agentId: string;
  status: ActiveTaskStatus;
  title: string;
  objective: string;
  ownerWorkerId?: string | null;
  intentIds?: string[];
  missingSlots?: string[];
  clarificationQuestion?: string | null;
  suggestedNextAction?: string | null;
  structuredContext?: Record<string, unknown> | null;
  sourceKind?: string;
  createdByMessageId?: number | null;
  updatedByMessageId?: number | null;
  resolvedAt?: string | null;
  expiresAt?: string | null;
}

export interface ActiveTaskStatusUpdateInput {
  id: string;
  status: ActiveTaskStatus;
  updatedByMessageId?: number | null;
  structuredContext?: Record<string, unknown> | null;
  missingSlots?: string[];
  clarificationQuestion?: string | null;
  suggestedNextAction?: string | null;
  resolvedAt?: string | null;
  expiresAt?: string | null;
}

export interface ListActiveTasksOptions {
  /** Used unless sourceChannelId selects verified tasks across prior sessions. */
  sessionId: string;
  /** Scope by the latest public source message, retaining the agent filter. */
  sourceChannelId?: string;
  agentId: string;
  includeResolved?: boolean;
  limit?: number;
}

export interface ProviderArtifactCandidateRecord {
  providerName: string;
  providerSessionId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  runCount: number;
}

export interface PromptSnapshotRecord {
  id: number;
  modelRunId: number;
  sessionId: string;
  agentId: string;
  providerName: string;
  requestMessageId: number | null;
  responseMessageId: number | null;
  promptText: string;
  systemPrompt: string | null;
  warmStartPrompt: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  expiresAt: string;
}

export interface PromptSnapshotInsertInput {
  modelRunId: number;
  sessionId: string;
  agentId: string;
  providerName: string;
  requestMessageId?: number | null;
  responseMessageId?: number | null;
  promptText: string;
  systemPrompt?: string | null;
  warmStartPrompt?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | null;
  expiresAt?: string | null;
}

export interface ListRecentPromptSnapshotsOptions {
  limit?: number;
  since?: string;
  sessionId?: string;
  agentId?: string;
}

export type DeadLetterStatus = "pending" | "resolved";

export interface DeadLetterRecord {
  id: number;
  sessionId: string;
  agentId: string;
  providerName: string;
  conversationKey: string;
  providerSessionId: string | null;
  requestMessageId: number | null;
  discordChannelId: string | null;
  discordUserId: string | null;
  discordUsername: string | null;
  promptText: string;
  systemPrompt: string | null;
  responseMode: string | null;
  failureCount: number;
  replayCount: number;
  lastErrorMessage: string;
  status: DeadLetterStatus;
  metadata: Record<string, unknown> | null;
  resolvedMessageId: number | null;
  resolvedModelRunId: number | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface DeadLetterInsertInput {
  sessionId: string;
  agentId: string;
  providerName: string;
  conversationKey: string;
  providerSessionId?: string | null;
  requestMessageId?: number | null;
  discordChannelId?: string | null;
  discordUserId?: string | null;
  discordUsername?: string | null;
  promptText: string;
  systemPrompt?: string | null;
  responseMode?: string | null;
  lastErrorMessage: string;
  failureCount?: number;
  metadata?: Record<string, unknown> | null;
}

export interface DeadLetterListOptions {
  status?: DeadLetterStatus | "all";
  sessionId?: string;
  limit?: number;
}

export interface DeadLetterResolveInput {
  id: number;
  resolvedMessageId?: number | null;
  resolvedModelRunId?: number | null;
  metadata?: Record<string, unknown> | null;
  incrementReplayCount?: boolean;
}

export interface DeadLetterReplayFailureInput {
  id: number;
  errorMessage: string;
  metadata?: Record<string, unknown> | null;
}

export interface SessionSummary {
  sessionId: string;
  sessionType: string;
  defaultAgentId: string;
  messageCount: number;
  modelRunCount: number;
  providerSessionCount: number;
  lastMessageAt: string | null;
  lastModelRunAt: string | null;
  updatedAt: string;
}

export interface HealthSnapshot {
  status: "healthy";
  dbUserVersion: number;
  sessions: number;
  messages: number;
  modelRuns: number;
  providerSessions: number;
  deadLettersTotal: number;
  deadLettersPending: number;
  lastMessageAt: string | null;
}

export interface ResetSessionOptions {
  clearHistory?: boolean;
  clearDiagnostics?: boolean;
}

export interface ResetSessionResult {
  deletedProviderSessions: number;
  deletedMessages: number;
  deletedModelRuns: number;
  deletedDeadLetters: number;
  deletedPromptSnapshots: number;
}

export type VoiceTurnReceiptStatus = "processing" | "completed" | "failed";

export interface VoiceTurnReceiptRecord {
  turnId: string;
  sessionId: string;
  agentId: string;
  utteranceId: string;
  status: VoiceTurnReceiptStatus;
  providerName: string | null;
  providerSessionId: string | null;
  responseText: string | null;
  providerUsedFailover: boolean | null;
  warmStartUsed: boolean | null;
  requestMessageId: number | null;
  responseMessageId: number | null;
  modelRunId: number | null;
  errorMessage: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export type TopicStatus = "active" | "archived";

export interface TopicRecord {
  id: string;
  channelKey: string;
  slug: string;
  title: string;
  leadAgentId: string | null;
  projectId: string | null;
  status: TopicStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TopicFocusRecord {
  channelKey: string;
  topicId: string | null;
  updatedAt: string;
}

export interface ProjectFocusRecord {
  channelKey: string;
  projectId: string | null;
  updatedAt: string;
}

export type ActiveContextKind = "note" | "plan" | "task" | "artifact" | "decision" | "entity" | "other";

export interface ActiveContextScope {
  userId?: string | null;
  agentId?: string | null;
  channelId?: string | null;
  topicId?: string | null;
  projectId?: string | null;
}

export interface ActiveContextItemRecord {
  id: number;
  key: string;
  userId: string | null;
  agentId: string | null;
  channelId: string | null;
  topicId: string | null;
  projectId: string | null;
  kind: ActiveContextKind;
  title: string | null;
  summary: string;
  keyFacts: string[];
  sourceRefs: string[];
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  accessCount: number;
  expiresAt: string | null;
  archivedAt: string | null;
  metadata: Record<string, unknown> | null;
}

export interface ActiveContextItemUpsertInput {
  key: string;
  scope?: ActiveContextScope;
  kind: ActiveContextKind;
  title?: string | null;
  summary: string;
  keyFacts?: string[];
  sourceRefs?: string[];
  expiresAt?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ListActiveContextItemsOptions {
  scope?: ActiveContextScope;
  includeExpired?: boolean;
  includeArchived?: boolean;
  now?: string | Date;
  limit?: number;
}

/**
 * project_state — the "head" of a project arc's state file (Unified Memory
 * System, Slice 1). It is the machine-tier source of truth for recall: status,
 * a short Quick Read, and a pointer to the human-collaborative Obsidian body.
 * `projectId` is the durable routing key for the arc (e.g. a `project:{id}` or
 * `topic:{id}` session key).
 */
export interface ProjectStateRecord {
  projectId: string;
  title: string;
  status: string;
  quickRead: string | null;
  obsidianPath: string | null;
  templateId: string | null;
  prevSessionId: string | null;
  leadAgentId: string | null;
  createdAt: string;
  updatedAt: string;
  lastSavedAt: string | null;
}

export interface ProjectStateUpsertInput {
  projectId: string;
  title?: string;
  status?: string;
  quickRead?: string | null;
  obsidianPath?: string | null;
  templateId?: string | null;
  prevSessionId?: string | null;
  leadAgentId?: string | null;
  /** When true, stamps last_saved_at = now (an explicit save checkpoint). */
  markSaved?: boolean;
}

export interface ListProjectStatesOptions {
  status?: string;
  limit?: number;
}

interface ProjectStateRow {
  project_id: string;
  title: string;
  status: string;
  quick_read: string | null;
  obsidian_path: string | null;
  template_id: string | null;
  prev_session_id: string | null;
  lead_agent_id: string | null;
  created_at: string;
  updated_at: string;
  last_saved_at: string | null;
}

export interface StoredMemoryRecord {
  id: number;
  sessionId: string | null;
  agentId: string | null;
  source: MemorySource;
  content: string;
  importance: number;
  sourceRef: string | null;
  embeddingJson: string | null;
  /**
   * Pre-decoded embedding vector. Adapters over stores that hold binary
   * embeddings (Atlas) populate this instead of embeddingJson so ranking
   * skips a JSON round-trip per row; when present it wins over embeddingJson.
   */
  embedding?: number[] | null;
  embeddingModel: string | null;
  createdAt: string;
  lastAccessedAt: string;
  accessCount: number;
  archivedAt: string | null;
  metadata: Record<string, unknown> | null;
}

export interface MemoryInsertInput {
  sessionId?: string | null;
  agentId?: string | null;
  source: MemorySource;
  content: string;
  importance?: number;
  sourceRef?: string | null;
  embeddingJson?: string | null;
  embeddingModel?: string | null;
  createdAt?: string | null;
  lastAccessedAt?: string | null;
  archivedAt?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface MemoryEmbeddingUpdateInput {
  memoryId: number;
  embeddingJson: string;
  embeddingModel: string;
}

export interface ListMemoriesOptions {
  sessionId?: string | null;
  agentId?: string | null;
  agentIds?: string[];
  source?: MemorySource | "all";
  includeArchived?: boolean;
  limit?: number;
}

export interface SessionSummaryRecord {
  id: number;
  sessionId: string;
  agentId: string;
  summaryText: string;
  tokenCount: number;
  coversThroughMessageId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSummaryUpsertInput {
  sessionId: string;
  agentId: string;
  summaryText: string;
  tokenCount: number;
  coversThroughMessageId?: number | null;
}

export interface PinnedFactRecord {
  id: number;
  scope: PinnedFactScope;
  scopeId: string | null;
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

export interface ObsidianIndexRecord {
  id: number;
  filePath: string;
  fileHash: string;
  lastIndexedAt: string;
  chunkCount: number;
}

export interface ObsidianIndexUpsertInput {
  filePath: string;
  fileHash: string;
  chunkCount: number;
  lastIndexedAt?: string | null;
}

export interface PendingSessionSaveRecord {
  conversationKey: string;
  sessionId: string;
  agentId: string;
  requestedByUserId: string;
  trigger: string;
  requestedAt: string;
}

export interface PendingSessionSaveUpsertInput {
  conversationKey: string;
  sessionId: string;
  agentId: string;
  requestedByUserId: string;
  trigger?: string;
}

export interface PinnedFactUpsertInput {
  scope: PinnedFactScope;
  scopeId?: string | null;
  key: string;
  value: string;
}

/** T-I-035: latest persisted context-usage reading for one conversation+agent. */
export interface ContextUsageSnapshotRecord {
  conversationKey: string;
  agentId: string;
  fraction: number;
  usedTokens: number;
  contextWindow: number;
  /** ISO-8601 UTC timestamp (writers pass toISOString(); column default is datetime('now')). */
  recordedAt: string;
}

export interface ContextUsageSnapshotUpsertInput {
  conversationKey: string;
  agentId: string;
  fraction: number;
  usedTokens: number;
  contextWindow: number;
  recordedAt?: string;
}

export interface ContextUsageSnapshotQueryInput {
  agentId: string;
  /** Conversation keys matched exactly (e.g. "thread:123", "channel:456"). */
  exactKeys?: string[];
  /** SQL LIKE patterns (e.g. "%discord:channel:456%" for voice-shaped keys). */
  likePatterns?: string[];
}

interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        session_type TEXT NOT NULL,
        default_agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS provider_sessions (
        conversation_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        provider_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_provider_sessions_session_agent
        ON provider_sessions(session_id, agent_id);

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        agent_id TEXT,
        provider_name TEXT,
        direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound', 'system', 'error')),
        source TEXT NOT NULL CHECK(source IN ('discord', 'tango')),
        discord_message_id TEXT,
        discord_channel_id TEXT,
        discord_user_id TEXT,
        discord_username TEXT,
        content TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session_created
        ON messages(session_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_messages_channel_created
        ON messages(discord_channel_id, created_at);
    `
  },
  {
    version: 2,
    sql: `
      ALTER TABLE messages ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';

      CREATE TABLE IF NOT EXISTS model_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        provider_session_id TEXT,
        model TEXT,
        stop_reason TEXT,
        response_mode TEXT,
        latency_ms INTEGER,
        provider_duration_ms INTEGER,
        provider_api_duration_ms INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_input_tokens INTEGER,
        cache_creation_input_tokens INTEGER,
        total_cost_usd REAL,
        is_error INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        request_message_id INTEGER,
        response_message_id INTEGER,
        metadata_json TEXT,
        raw_response_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (request_message_id) REFERENCES messages(id) ON DELETE SET NULL,
        FOREIGN KEY (response_message_id) REFERENCES messages(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_model_runs_session_created
        ON model_runs(session_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_model_runs_conversation_created
        ON model_runs(conversation_key, created_at);
    `
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS dead_letters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        provider_session_id TEXT,
        request_message_id INTEGER,
        discord_channel_id TEXT,
        discord_user_id TEXT,
        discord_username TEXT,
        prompt_text TEXT NOT NULL,
        system_prompt TEXT,
        response_mode TEXT,
        failure_count INTEGER NOT NULL DEFAULT 1,
        replay_count INTEGER NOT NULL DEFAULT 0,
        last_error_message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'resolved')),
        metadata_json TEXT,
        resolved_message_id INTEGER,
        resolved_model_run_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (request_message_id) REFERENCES messages(id) ON DELETE SET NULL,
        FOREIGN KEY (resolved_message_id) REFERENCES messages(id) ON DELETE SET NULL,
        FOREIGN KEY (resolved_model_run_id) REFERENCES model_runs(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dead_letters_status_created
        ON dead_letters(status, created_at);

      CREATE INDEX IF NOT EXISTS idx_dead_letters_session_created
        ON dead_letters(session_id, created_at);
    `
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS session_provider_overrides (
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, agent_id),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_provider_overrides_session
        ON session_provider_overrides(session_id, updated_at);
    `
  },
  {
    version: 5,
    sql: `
      DROP INDEX IF EXISTS idx_provider_sessions_session_agent;

      ALTER TABLE provider_sessions RENAME TO provider_sessions_legacy;

      CREATE TABLE provider_sessions (
        conversation_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        provider_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (conversation_key, provider_name),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      INSERT INTO provider_sessions (
        conversation_key,
        session_id,
        agent_id,
        provider_name,
        provider_session_id,
        created_at,
        updated_at
      )
      SELECT
        conversation_key,
        session_id,
        agent_id,
        provider_name,
        provider_session_id,
        created_at,
        updated_at
      FROM provider_sessions_legacy;

      DROP TABLE provider_sessions_legacy;

      CREATE INDEX IF NOT EXISTS idx_provider_sessions_session_agent
        ON provider_sessions(session_id, agent_id);

      CREATE INDEX IF NOT EXISTS idx_provider_sessions_conversation
        ON provider_sessions(conversation_key, updated_at);
    `
  },
  {
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS session_compactions (
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        compacted_turns INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, agent_id),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_compactions_updated
        ON session_compactions(session_id, updated_at);
    `
  },
  {
    version: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS voice_turn_receipts (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        utterance_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'processing' CHECK(status IN ('processing', 'completed', 'failed')),
        provider_name TEXT,
        provider_session_id TEXT,
        response_text TEXT,
        provider_used_failover INTEGER,
        warm_start_used INTEGER,
        request_message_id INTEGER,
        response_message_id INTEGER,
        model_run_id INTEGER,
        error_message TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (session_id, utterance_id),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (request_message_id) REFERENCES messages(id) ON DELETE SET NULL,
        FOREIGN KEY (response_message_id) REFERENCES messages(id) ON DELETE SET NULL,
        FOREIGN KEY (model_run_id) REFERENCES model_runs(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_voice_turn_receipts_session_created
        ON voice_turn_receipts(session_id, created_at);
    `
  },
  {
    version: 8,
    sql: `
      CREATE TABLE IF NOT EXISTS topics (
        id TEXT PRIMARY KEY,
        channel_key TEXT NOT NULL,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        lead_agent_id TEXT,
        project_id TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (channel_key, slug)
      );

      CREATE INDEX IF NOT EXISTS idx_topics_channel_updated
        ON topics(channel_key, updated_at);
    `
  },
  {
    version: 9,
    sql: `
      CREATE TABLE IF NOT EXISTS topic_focus (
        channel_key TEXT PRIMARY KEY,
        topic_id TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_topic_focus_updated
        ON topic_focus(updated_at);
    `
  },
  {
    version: 10,
    sql: `
      CREATE TABLE IF NOT EXISTS project_focus (
        channel_key TEXT PRIMARY KEY,
        project_id TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_project_focus_updated
        ON project_focus(updated_at);
    `
  },
  {
    version: 11,
    sql: GOVERNANCE_DDL + GOVERNANCE_SEED,
  },
  {
    version: 12,
    sql: `
      -- Remove narrow tools replaced by universal ones
      DELETE FROM permissions WHERE tool_id IN ('atlas_ingredient_lookup', 'recipe_lookup');
      DELETE FROM governance_tools WHERE id IN ('atlas_ingredient_lookup', 'recipe_lookup');

      -- Grant nutrition-logger access to the universal replacements.
      -- Roster-agnostic (T-I-071): only if the principal exists on this install
      -- (a fresh DB is born ungranted; the example roster is opt-in).
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:nutrition-logger', 'atlas_sql', 'write', 'replaced atlas_ingredient_lookup'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:nutrition-logger');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:nutrition-logger', 'recipe_read', 'read', 'replaced recipe_lookup'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:nutrition-logger');
    `,
  },
  {
    version: 13,
    sql: `
      CREATE TABLE IF NOT EXISTS discord_thread_sessions (
        thread_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 14,
    sql: `
      CREATE TABLE IF NOT EXISTS discord_thread_sessions_new (
        thread_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO discord_thread_sessions_new SELECT * FROM discord_thread_sessions;
      DROP TABLE IF EXISTS discord_thread_sessions;
      ALTER TABLE discord_thread_sessions_new RENAME TO discord_thread_sessions;
    `,
  },
  {
    version: 15,
    sql: `
      -- SCHEDULE_RUNS: execution history for every scheduled job run.
      CREATE TABLE IF NOT EXISTS schedule_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        execution_mode TEXT NOT NULL,
        pre_check_result TEXT,
        duration_ms INTEGER,
        error TEXT,
        summary TEXT,
        model_used TEXT,
        worker_id TEXT,
        delivery_status TEXT,
        delivery_error TEXT,
        metadata TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule_id ON schedule_runs(schedule_id);
      CREATE INDEX IF NOT EXISTS idx_schedule_runs_started_at ON schedule_runs(started_at);
      CREATE INDEX IF NOT EXISTS idx_schedule_runs_status ON schedule_runs(status);

      -- SCHEDULE_STATE: runtime state persisted across restarts.
      CREATE TABLE IF NOT EXISTS schedule_state (
        schedule_id TEXT PRIMARY KEY,
        last_run_at TEXT,
        last_status TEXT,
        last_duration_ms INTEGER,
        last_error TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        backoff_until TEXT,
        total_runs INTEGER NOT NULL DEFAULT 0,
        total_ok INTEGER NOT NULL DEFAULT 0,
        total_errors INTEGER NOT NULL DEFAULT 0,
        total_skipped INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- SCHEDULE_COMPLETIONS: workflow-level idempotency tracking.
      CREATE TABLE IF NOT EXISTS schedule_completions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL,
        completed_date TEXT NOT NULL,
        completed_by TEXT NOT NULL,
        schedule_run_id INTEGER,
        completed_at TEXT NOT NULL DEFAULT (datetime('now')),
        metadata TEXT,
        UNIQUE(workflow_id, completed_date)
      );

      CREATE INDEX IF NOT EXISTS idx_schedule_completions_workflow ON schedule_completions(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_schedule_completions_date ON schedule_completions(completed_date);
    `,
  }
  ,
  {
    version: 16,
    sql: `
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        agent_id TEXT,
        source TEXT NOT NULL CHECK(source IN ('conversation', 'obsidian', 'reflection', 'manual', 'backfill')),
        content TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5,
        source_ref TEXT,
        embedding_json TEXT,
        embedding_model TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
        access_count INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        metadata_json TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source, created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_archived ON memories(archived_at, created_at);

      CREATE TABLE IF NOT EXISTS session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        token_count INTEGER NOT NULL DEFAULT 0,
        covers_through_message_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_session_summaries_scope
        ON session_summaries(session_id, agent_id, covers_through_message_id);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_updated
        ON session_summaries(session_id, agent_id, updated_at);

      CREATE TABLE IF NOT EXISTS pinned_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL CHECK(scope IN ('global', 'agent', 'session')),
        scope_id TEXT,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_pinned_facts_scope_key
        ON pinned_facts(scope, scope_id, key);
      CREATE INDEX IF NOT EXISTS idx_pinned_facts_updated
        ON pinned_facts(updated_at);

      CREATE TABLE IF NOT EXISTS obsidian_index (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL UNIQUE,
        file_hash TEXT NOT NULL,
        last_indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
        chunk_count INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
  {
    version: 17,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('memory_search', 'shared', 'Memory Search', 'read'),
        ('memory_add', 'shared', 'Memory Add', 'write');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'user:owner', 'memory_search', 'read', 'universal memory retrieval'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'user:owner');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'user:owner', 'memory_add', 'write', 'universal memory storage'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'user:owner');
    `,
  },
  {
    version: 18,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('memory_reflect', 'shared', 'Memory Reflect', 'write');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'user:owner', 'memory_reflect', 'write', 'universal memory reflection'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'user:owner');
    `,
  },
  {
    version: 19,
    sql: `
      CREATE TABLE IF NOT EXISTS prompt_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_run_id INTEGER NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        request_message_id INTEGER,
        response_message_id INTEGER,
        prompt_text TEXT NOT NULL,
        system_prompt TEXT,
        warm_start_prompt TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL DEFAULT (datetime('now', '+72 hours')),
        FOREIGN KEY (model_run_id) REFERENCES model_runs(id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (request_message_id) REFERENCES messages(id) ON DELETE SET NULL,
        FOREIGN KEY (response_message_id) REFERENCES messages(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_prompt_snapshots_session_created
        ON prompt_snapshots(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_prompt_snapshots_expires
        ON prompt_snapshots(expires_at);
      CREATE INDEX IF NOT EXISTS idx_prompt_snapshots_request_message
        ON prompt_snapshots(request_message_id);
      CREATE INDEX IF NOT EXISTS idx_prompt_snapshots_response_message
        ON prompt_snapshots(response_message_id);
    `,
  },
  {
    version: 20,
    // voice_read_watermarks is unused since TGO-938 (legacy voice inbox removed); kept so the schema history stays intact.
    sql: `
      CREATE TABLE IF NOT EXISTS voice_read_watermarks (
        channel_id TEXT PRIMARY KEY,
        watermark_message_id TEXT NOT NULL,
        watermark_source TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 21,
    sql: `
      UPDATE permissions
      SET access_level = 'write',
          reason = 'sync fatsecret_api access with recipe-librarian config',
          updated_at = datetime('now')
      WHERE principal_id = 'worker:recipe-librarian'
        AND tool_id = 'fatsecret_api'
        AND access_level != 'write';

      -- Roster-agnostic (T-I-071): only if the principal exists on this install.
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:recipe-librarian', 'fatsecret_api', 'write',
             'sync fatsecret_api access with recipe-librarian config'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:recipe-librarian');
    `,
  },
  {
    version: 22,
    sql: `
      CREATE TABLE IF NOT EXISTS deterministic_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        initiating_principal_id TEXT NOT NULL,
        lead_agent_principal_id TEXT NOT NULL,
        project_id TEXT,
        topic_id TEXT,
        intent_count INTEGER NOT NULL DEFAULT 0,
        intent_ids TEXT,
        intent_json TEXT NOT NULL,
        intent_model_run_id INTEGER,
        route_outcome TEXT NOT NULL
          CHECK(route_outcome IN ('executed', 'clarification', 'fallback')),
        execution_plan_json TEXT,
        step_count INTEGER NOT NULL DEFAULT 0,
        completed_step_count INTEGER NOT NULL DEFAULT 0,
        failed_step_count INTEGER NOT NULL DEFAULT 0,
        has_write_operations INTEGER NOT NULL DEFAULT 0,
        worker_ids TEXT,
        delegation_chain TEXT,
        receipts_json TEXT,
        narration_provider TEXT,
        narration_model TEXT,
        narration_latency_ms INTEGER,
        narration_retried INTEGER NOT NULL DEFAULT 0,
        narration_model_run_id INTEGER,
        intent_latency_ms INTEGER,
        route_latency_ms INTEGER,
        execution_latency_ms INTEGER,
        total_latency_ms INTEGER,
        request_message_id INTEGER,
        response_message_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (intent_model_run_id) REFERENCES model_runs(id) ON DELETE SET NULL,
        FOREIGN KEY (narration_model_run_id) REFERENCES model_runs(id) ON DELETE SET NULL,
        FOREIGN KEY (request_message_id) REFERENCES messages(id) ON DELETE SET NULL,
        FOREIGN KEY (response_message_id) REFERENCES messages(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_deterministic_turns_session
        ON deterministic_turns(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_deterministic_turns_conversation
        ON deterministic_turns(conversation_key, created_at);
      CREATE INDEX IF NOT EXISTS idx_deterministic_turns_outcome
        ON deterministic_turns(route_outcome, created_at);
      CREATE INDEX IF NOT EXISTS idx_deterministic_turns_principal
        ON deterministic_turns(initiating_principal_id, created_at);
    `,
  },
  {
    version: 23,
    sql: `
      ALTER TABLE deterministic_turns ADD COLUMN fallback_reason TEXT;
    `,
  },
  {
    version: 24,
    sql: `
      CREATE TABLE IF NOT EXISTS active_tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK(status IN ('proposed', 'awaiting_user', 'ready', 'running', 'blocked', 'completed', 'canceled', 'superseded', 'expired')),
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        owner_worker_id TEXT,
        intent_ids TEXT,
        missing_slots TEXT,
        clarification_question TEXT,
        suggested_next_action TEXT,
        structured_context_json TEXT,
        source_kind TEXT NOT NULL DEFAULT 'assistant-offer',
        created_by_message_id INTEGER,
        updated_by_message_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT,
        expires_at TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by_message_id) REFERENCES messages(id) ON DELETE SET NULL,
        FOREIGN KEY (updated_by_message_id) REFERENCES messages(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_active_tasks_session_updated
        ON active_tasks(session_id, agent_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_active_tasks_open
        ON active_tasks(session_id, agent_id, status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_active_tasks_expires
        ON active_tasks(expires_at, status);
    `,
  },
  {
    version: 25,
    sql: `
      CREATE TABLE IF NOT EXISTS sub_agent_runs (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        parent_session_id TEXT,
        parent_agent_id TEXT,
        conversation_key TEXT,
        coordinator_worker_id TEXT NOT NULL,
        round_index INTEGER NOT NULL DEFAULT 1,
        sub_task_id TEXT NOT NULL,
        provider_name TEXT,
        model TEXT,
        reasoning_effort TEXT,
        tool_ids TEXT,
        dependency_ids TEXT,
        status TEXT NOT NULL CHECK(status IN ('completed', 'failed', 'timeout')),
        duration_ms INTEGER NOT NULL DEFAULT 0,
        cost_estimate_usd REAL,
        error TEXT,
        output_text TEXT,
        tool_calls_json TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (parent_session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sub_agent_runs_session
        ON sub_agent_runs(parent_session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_sub_agent_runs_conversation
        ON sub_agent_runs(conversation_key, created_at);
      CREATE INDEX IF NOT EXISTS idx_sub_agent_runs_batch
        ON sub_agent_runs(batch_id, created_at);

      INSERT OR IGNORE INTO principals (id, type, parent_id, display_name)
      SELECT 'worker:research-coordinator', 'worker', 'agent:sierra', 'Research Coordinator'
      WHERE EXISTS (
        SELECT 1 FROM principals WHERE id = 'agent:sierra'
      );

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'exa_search', 'read', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'exa_search');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'exa_answer', 'read', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'exa_answer');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'printer_command', 'write', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'printer_command');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'openscad_render', 'write', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'openscad_render');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'prusa_slice', 'write', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'prusa_slice');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'obsidian', 'write', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'obsidian');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'location_read', 'read', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'location_read');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'find_diesel', 'read', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'find_diesel');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'browser', 'write', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'browser');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'file_ops', 'write', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'file_ops');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'youtube_transcript', 'read', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'youtube_transcript');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'youtube_analyze', 'read', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'youtube_analyze');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'onepassword', 'read', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'onepassword');
    `,
  },
  {
    version: 26,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('slack', 'shared', 'Slack Workspace Read', 'read');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:personal-assistant', 'slack', 'read', 'seed from config'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:personal-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'slack');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-assistant', 'slack', 'read', 'seed from config'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'slack');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'slack', 'read', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'slack');
    `,
  },
  {
    version: 27,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('receipt_registry', 'personal', 'Receipt Registry', 'write');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:personal-assistant', 'receipt_registry', 'write', 'seed from config'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:personal-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'receipt_registry');
    `,
  },
  {
    version: 28,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('expense_reimbursement', 'personal', 'ExpenseDesk Reimbursement Automation', 'write');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:personal-assistant', 'expense_reimbursement', 'write', 'seed from config'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:personal-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'expense_reimbursement');
    `,
  },
  {
    version: 29,
    sql: `
      CREATE INDEX IF NOT EXISTS idx_messages_discord_message
        ON messages(discord_message_id, created_at);

      CREATE TABLE IF NOT EXISTS channel_referents (
        channel_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('reaction')),
        target_message_id TEXT NOT NULL,
        target_session_id TEXT,
        target_agent_id TEXT,
        target_direction TEXT CHECK(target_direction IN ('inbound', 'outbound', 'system', 'error')),
        target_source TEXT CHECK(target_source IN ('discord', 'imessage', 'tango')),
        target_content TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, discord_user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_channel_referents_expires
        ON channel_referents(expires_at);
    `,
  },
  {
    version: 30,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('nutrition_log_items', 'wellness', 'Nutrition Item Logger', 'write'),
        ('gog_docs_update_tab', 'personal', 'Google Docs Tab Updater', 'write');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:nutrition-logger', 'nutrition_log_items', 'write', 'seed from config'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:nutrition-logger')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'nutrition_log_items');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:personal-assistant', 'gog_docs_update_tab', 'write', 'seed from config'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:personal-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'gog_docs_update_tab');
    `,
  },
  {
    version: 31,
    sql: `
      CREATE TABLE IF NOT EXISTS active_context_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_key TEXT NOT NULL,
        context_key TEXT NOT NULL,
        user_id TEXT,
        agent_id TEXT,
        channel_id TEXT,
        topic_id TEXT,
        project_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('note', 'plan', 'task', 'artifact', 'decision', 'entity', 'other')),
        title TEXT,
        summary TEXT NOT NULL,
        key_facts_json TEXT,
        source_refs_json TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
        access_count INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT,
        archived_at TEXT,
        UNIQUE(scope_key, context_key)
      );

      CREATE INDEX IF NOT EXISTS idx_active_context_scope
        ON active_context_items(user_id, agent_id, channel_id, topic_id, project_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_active_context_expires
        ON active_context_items(expires_at);
      CREATE INDEX IF NOT EXISTS idx_active_context_archived
        ON active_context_items(archived_at, updated_at);
    `,
  },
  {
    version: 32,
    sql: `
      INSERT OR IGNORE INTO principals (id, type, parent_id, display_name)
        SELECT 'worker:note-librarian', 'worker', NULL, 'Note Librarian'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:watson');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:note-librarian', 'obsidian', 'write', 'shared Obsidian note access'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:note-librarian')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'obsidian');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:note-librarian', 'memory_search', 'read', 'memory lookup while resolving notes'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:note-librarian')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'memory_search');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:note-librarian', 'memory_add', 'write', 'memory capture for durable note context'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:note-librarian')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'memory_add');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:note-librarian', 'memory_reflect', 'write', 'memory reflection for durable note context'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:note-librarian')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'memory_reflect');
    `,
  },
  {
    version: 33,
    sql: `
      INSERT OR IGNORE INTO principals (id, type, parent_id, display_name)
        SELECT 'worker:operations-assistant', 'worker', 'agent:victor', 'Operations Assistant'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:watson');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:operations-assistant', 'linear', 'write', 'operations project tracking'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:operations-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'linear');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:operations-assistant', 'obsidian', 'write', 'operations context and decision logs'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:operations-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'obsidian');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:operations-assistant', 'memory_search', 'read', 'memory lookup for durable operations context'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:operations-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'memory_search');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:operations-assistant', 'memory_add', 'write', 'memory capture for durable operations context'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:operations-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'memory_add');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:operations-assistant', 'memory_reflect', 'write', 'memory reflection for durable operations context'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:operations-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'memory_reflect');
    `,
  },
  {
    version: 34,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type)
      VALUES ('study_library', 'personal', 'Study Library', 'write');

      INSERT OR IGNORE INTO principals (id, type, display_name)
      SELECT 'user:owner', 'user', 'Owner'
      WHERE NOT EXISTS (SELECT 1 FROM principals WHERE type = 'user');

      INSERT OR IGNORE INTO principals (id, type, parent_id, display_name)
      SELECT 'agent:papa', 'agent', id, 'Papa'
      FROM principals
      WHERE type = 'user'
        AND EXISTS (SELECT 1 FROM principals WHERE id = 'agent:watson')
      ORDER BY
        CASE
          WHEN id = 'user:owner' THEN 0
          ELSE 1
        END,
        id
      LIMIT 1;

      INSERT OR IGNORE INTO principals (id, type, parent_id, display_name)
      SELECT 'worker:study-assistant', 'worker', 'agent:papa', 'Study Assistant'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:papa');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:study-assistant', 'study_library', 'write', 'Study Library marking and linking'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:study-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'study_library');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:study-assistant', 'obsidian', 'write', 'library study notes and study outlines'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:study-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'obsidian');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:study-assistant', 'browser', 'write', 'authenticated Study Library marking and linking'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:study-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'browser');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:study-assistant', 'onepassword', 'read', 'credential retrieval for Library login if explicitly configured'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:study-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'onepassword');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:study-assistant', 'gog_email', 'read', 'read-only study context from email'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:study-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'gog_email');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:study-assistant', 'memory_search', 'read', 'memory lookup for durable library context'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:study-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'memory_search');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:study-assistant', 'memory_add', 'write', 'memory capture for durable library context'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:study-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'memory_add');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:study-assistant', 'memory_reflect', 'write', 'memory reflection for durable library context'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:study-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'memory_reflect');
    `,
  },
  {
    version: 35,
    sql: `
      CREATE TABLE IF NOT EXISTS attachment_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL DEFAULT 'source' CHECK(role IN ('source', 'derived')),
        sha256 TEXT NOT NULL,
        bytes INTEGER NOT NULL CHECK(bytes >= 0),
        content_type TEXT,
        original_filename TEXT,
        storage_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'available'
          CHECK(status IN ('available', 'missing', 'failed', 'retired')),
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_attachment_files_source_sha256
        ON attachment_files(sha256)
        WHERE role = 'source';
      CREATE INDEX IF NOT EXISTS idx_attachment_files_sha_role
        ON attachment_files(sha256, role);
      CREATE INDEX IF NOT EXISTS idx_attachment_files_status_updated
        ON attachment_files(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_attachment_files_content_type
        ON attachment_files(content_type, updated_at);

      CREATE TABLE IF NOT EXISTS attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT,
        agent_id TEXT,
        session_id TEXT,
        message_id TEXT,
        channel_id TEXT,
        thread_id TEXT,
        user_id TEXT,
        discord_attachment_id TEXT,
        file_id INTEGER,
        title TEXT,
        original_filename TEXT,
        content_type TEXT,
        bytes INTEGER CHECK(bytes IS NULL OR bytes >= 0),
        status TEXT NOT NULL DEFAULT 'received'
          CHECK(status IN ('received', 'processing', 'partial', 'ready', 'failed', 'retired')),
        retention_policy_id TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (file_id) REFERENCES attachment_files(id) ON DELETE SET NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_discord_attachment_id
        ON attachments(discord_attachment_id)
        WHERE discord_attachment_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_attachments_scope_updated
        ON attachments(project_id, agent_id, session_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_attachments_channel_thread_updated
        ON attachments(channel_id, thread_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_attachments_user_updated
        ON attachments(user_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_attachments_status_updated
        ON attachments(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_attachments_file
        ON attachments(file_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_attachments_message
        ON attachments(message_id, updated_at);

      CREATE TABLE IF NOT EXISTS attachment_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attachment_id INTEGER NOT NULL,
        kind TEXT NOT NULL
          CHECK(kind IN ('classify', 'embedded_text', 'apple_ocr', 'chunk', 'directory', 'llm_fallback', 'retention_review')),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'running', 'succeeded', 'failed', 'canceled')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        max_attempts INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts > 0),
        run_after TEXT NOT NULL DEFAULT (datetime('now')),
        locked_at TEXT,
        locked_by TEXT,
        error_json TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_attachment_jobs_pending
        ON attachment_jobs(status, run_after, created_at);
      CREATE INDEX IF NOT EXISTS idx_attachment_jobs_attachment
        ON attachment_jobs(attachment_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_attachment_jobs_lock
        ON attachment_jobs(status, locked_at);
      CREATE INDEX IF NOT EXISTS idx_attachment_jobs_kind_status
        ON attachment_jobs(kind, status, run_after);

      CREATE TABLE IF NOT EXISTS attachment_extractions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attachment_id INTEGER NOT NULL,
        method TEXT NOT NULL,
        text TEXT NOT NULL,
        confidence REAL,
        quality_json TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_attachment_extractions_attachment
        ON attachment_extractions(attachment_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_attachment_extractions_method
        ON attachment_extractions(method, created_at);

      CREATE TABLE IF NOT EXISTS attachment_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attachment_id INTEGER NOT NULL,
        extraction_id INTEGER NOT NULL,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        text TEXT NOT NULL,
        token_estimate INTEGER CHECK(token_estimate IS NULL OR token_estimate >= 0),
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(extraction_id, ordinal),
        FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE,
        FOREIGN KEY (extraction_id) REFERENCES attachment_extractions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_attachment_chunks_attachment
        ON attachment_chunks(attachment_id, ordinal);
      CREATE INDEX IF NOT EXISTS idx_attachment_chunks_extraction
        ON attachment_chunks(extraction_id, ordinal);

      CREATE TABLE IF NOT EXISTS attachment_directories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attachment_id INTEGER NOT NULL,
        schema_version INTEGER NOT NULL CHECK(schema_version > 0),
        directory_json TEXT NOT NULL,
        project_id TEXT,
        agent_id TEXT,
        session_id TEXT,
        message_id TEXT,
        channel_id TEXT,
        thread_id TEXT,
        user_id TEXT,
        status TEXT NOT NULL DEFAULT 'building'
          CHECK(status IN ('building', 'ready', 'stale', 'failed', 'retired')),
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_attachment_directories_attachment
        ON attachment_directories(attachment_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_attachment_directories_scope
        ON attachment_directories(project_id, agent_id, session_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_attachment_directories_channel_thread
        ON attachment_directories(channel_id, thread_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_attachment_directories_status
        ON attachment_directories(status, updated_at);

      CREATE TABLE IF NOT EXISTS attachment_retention_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attachment_id INTEGER NOT NULL,
        retention_policy_id TEXT,
        decision TEXT NOT NULL CHECK(decision IN ('keep', 'delete', 'review', 'retire')),
        status TEXT NOT NULL DEFAULT 'proposed'
          CHECK(status IN ('proposed', 'approved', 'applied', 'superseded', 'canceled')),
        decided_by TEXT,
        reason TEXT,
        effective_at TEXT,
        review_after TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_attachment_retention_attachment
        ON attachment_retention_decisions(attachment_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_attachment_retention_status
        ON attachment_retention_decisions(status, review_after);
      CREATE INDEX IF NOT EXISTS idx_attachment_retention_policy
        ON attachment_retention_decisions(retention_policy_id, created_at);
    `,
  },
  {
    version: 36,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('attachment_search', 'attachments', 'Attachment Search', 'read'),
        ('attachment_read', 'attachments', 'Attachment Read', 'read'),
        ('attachment_status', 'attachments', 'Attachment Status', 'read'),
        ('attachment_reprocess', 'attachments', 'Attachment Reprocess', 'write');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT p.id, tool_ids.tool_id, 'read', 'attachment read tools available to all workers'
      FROM principals p
      CROSS JOIN (
        SELECT 'attachment_search' AS tool_id
        UNION ALL SELECT 'attachment_read'
        UNION ALL SELECT 'attachment_status'
      ) AS tool_ids
      WHERE p.type = 'worker';
    `,
  },
  {
    version: 37,
    sql: `
      CREATE TABLE IF NOT EXISTS project_state (
        project_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        quick_read TEXT,
        obsidian_path TEXT,
        template_id TEXT,
        prev_session_id TEXT,
        lead_agent_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_saved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_project_state_status
        ON project_state(status, updated_at);
    `,
  },
  {
    version: 38,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type)
      VALUES ('wellness_files', 'wellness', 'Wellness Wellness Files', 'write');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:note-librarian', 'wellness_files', 'write', 'bounded wellness workspace file access'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:note-librarian')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'wellness_files');
    `,
  },
  {
    version: 39,
    sql: `
      INSERT OR IGNORE INTO principals (id, type, display_name)
      VALUES ('user:owner', 'user', 'Owner');

      INSERT OR IGNORE INTO principals (id, type, parent_id, display_name)
        SELECT 'agent:wellness', 'agent', 'user:owner', 'Wellness'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:watson');

      INSERT OR IGNORE INTO principals (id, type, parent_id, display_name)
        SELECT 'worker:nutrition-logger', 'worker', 'agent:wellness', 'Nutrition Logger'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:watson');
      INSERT OR IGNORE INTO principals (id, type, parent_id, display_name)
        SELECT 'worker:health-analyst', 'worker', 'agent:wellness', 'Health Analyst'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:watson');
      INSERT OR IGNORE INTO principals (id, type, parent_id, display_name)
        SELECT 'worker:recipe-librarian', 'worker', 'agent:wellness', 'Recipe Librarian'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:watson');
      INSERT OR IGNORE INTO principals (id, type, parent_id, display_name)
        SELECT 'worker:activity-tracker', 'worker', 'agent:wellness', 'Activity Tracker'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:watson');

      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('wellnessdb_search_product', 'wellness-db', 'Wellness DB Product Search', 'read'),
        ('wellnessdb_search_supplement', 'wellness-db', 'Wellness DB Supplement Search', 'read'),
        ('wellnessdb_search_recipe', 'wellness-db', 'Wellness DB Recipe Search', 'read'),
        ('wellnessdb_get_recipe_detail', 'wellness-db', 'Wellness DB Recipe Detail', 'read'),
        ('wellnessdb_day_summary', 'wellness-db', 'Wellness DB Day Summary', 'read'),
        ('wellnessdb_day_range', 'wellness-db', 'Wellness DB Day Range', 'read'),
        ('wellnessdb_recent_meals', 'wellness-db', 'Wellness DB Recent Meals', 'read'),
        ('wellnessdb_active_supplements', 'wellness-db', 'Wellness DB Active Supplements', 'read'),
        ('wellnessdb_active_products', 'wellness-db', 'Wellness DB Active Products', 'read'),
        ('wellnessdb_log_meal', 'wellness-db', 'Wellness DB Log Meal', 'write'),
        ('wellnessdb_log_supplement', 'wellness-db', 'Wellness DB Log Supplement', 'write'),
        ('wellnessdb_log_weight', 'wellness-db', 'Wellness DB Log Weight', 'write'),
        ('wellnessdb_log_activity', 'wellness-db', 'Wellness DB Log Activity', 'write'),
        ('wellnessdb_log_hydration', 'wellness-db', 'Wellness DB Log Hydration', 'write'),
        ('wellnessdb_log_presence', 'wellness-db', 'Wellness DB Log Presence', 'write'),
        ('wellnessdb_add_product', 'wellness-db', 'Wellness DB Add Product', 'write'),
        ('wellnessdb_add_recipe', 'wellness-db', 'Wellness DB Add Recipe', 'write'),
        ('wellnessdb_update_recipe', 'wellness-db', 'Wellness DB Update Recipe', 'write'),
        ('wellnessdb_add_day_note', 'wellness-db', 'Wellness DB Add Day Note', 'write'),
        ('wellnessdb_delete_meal_entry', 'wellness-db', 'Wellness DB Delete Meal Entry', 'write');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:nutrition-logger', 'wellnessdb_search_product', 'read', 'Wellness wellness.db lookup'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:nutrition-logger');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:nutrition-logger', 'wellnessdb_search_supplement', 'read', 'Wellness wellness.db lookup'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:nutrition-logger');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:nutrition-logger', 'wellnessdb_day_summary', 'read', 'Wellness wellness.db day summary'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:nutrition-logger');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:nutrition-logger', 'wellnessdb_recent_meals', 'read', 'Wellness wellness.db recent meals'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:nutrition-logger');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:nutrition-logger', 'wellnessdb_active_supplements', 'read', 'Wellness wellness.db active supplements'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:nutrition-logger');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:nutrition-logger', 'wellnessdb_active_products', 'read', 'Wellness wellness.db active products'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:nutrition-logger');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:nutrition-logger', 'wellnessdb_log_meal', 'write', 'Wellness wellness.db meal logging'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:nutrition-logger');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:nutrition-logger', 'wellnessdb_log_supplement', 'write', 'Wellness wellness.db supplement logging'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:nutrition-logger');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:nutrition-logger', 'wellnessdb_add_product', 'write', 'Wellness wellness.db product creation'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:nutrition-logger');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:nutrition-logger', 'wellnessdb_add_day_note', 'write', 'Wellness wellness.db day notes'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:nutrition-logger');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:nutrition-logger', 'wellnessdb_delete_meal_entry', 'write', 'Wellness wellness.db meal corrections'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:nutrition-logger');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:recipe-librarian', 'wellnessdb_search_recipe', 'read', 'Wellness wellness.db recipe lookup'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:recipe-librarian');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:recipe-librarian', 'wellnessdb_get_recipe_detail', 'read', 'Wellness wellness.db recipe detail'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:recipe-librarian');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:recipe-librarian', 'wellnessdb_active_products', 'read', 'Wellness wellness.db active products'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:recipe-librarian');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:recipe-librarian', 'wellnessdb_add_recipe', 'write', 'Wellness wellness.db recipe creation'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:recipe-librarian');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:recipe-librarian', 'wellnessdb_update_recipe', 'write', 'Wellness wellness.db recipe updates'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:recipe-librarian');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:health-analyst', 'wellnessdb_day_summary', 'read', 'Wellness wellness.db day summary'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:health-analyst');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:health-analyst', 'wellnessdb_day_range', 'read', 'Wellness wellness.db trend analysis'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:health-analyst');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:activity-tracker', 'wellnessdb_log_weight', 'write', 'Wellness wellness.db weight logging'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:activity-tracker');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:activity-tracker', 'wellnessdb_log_activity', 'write', 'Wellness wellness.db activity logging'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:activity-tracker');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:activity-tracker', 'wellnessdb_log_hydration', 'write', 'Wellness wellness.db hydration logging'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:activity-tracker');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:wellness', 'wellnessdb_log_presence', 'write', 'Wellness direct presence check logging'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:wellness');
    `,
  },
  {
    version: 40,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('email_thread_brief', 'email', 'Email Thread Brief', 'read'),
        ('email_search', 'email', 'Email Search', 'read'),
        ('email_inbox_scan', 'email', 'Email Inbox Scan', 'read'),
        ('email_draft_create', 'email', 'Email Draft Create', 'write'),
        ('email_thread_archive', 'email', 'Email Thread Archive', 'write');
    `,
  },
  {
    version: 41,
    sql: `
      CREATE TABLE IF NOT EXISTS pending_session_saves (
        conversation_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        requested_by_user_id TEXT NOT NULL,
        trigger TEXT NOT NULL DEFAULT 'slash_command',
        requested_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_pending_session_saves_session_id
        ON pending_session_saves(session_id);
    `,
  },
  {
    version: 42,
    sql: `
      UPDATE principals
      SET parent_id = 'agent:wellness'
      WHERE id IN (
        'worker:nutrition-logger',
        'worker:health-analyst',
        'worker:recipe-librarian'
      );

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:nutrition-logger', 'exa_search', 'read', 'Wellness worker macro and restaurant lookup'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:nutrition-logger');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:nutrition-logger', 'exa_answer', 'read', 'Wellness worker macro and restaurant lookup'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:nutrition-logger');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:nutrition-logger', 'browser', 'write', 'Wellness worker macro and restaurant lookup'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:nutrition-logger');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:recipe-librarian', 'exa_search', 'read', 'Wellness worker recipe research'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:recipe-librarian');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:recipe-librarian', 'exa_answer', 'read', 'Wellness worker recipe research'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:recipe-librarian');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:recipe-librarian', 'browser', 'write', 'Wellness worker recipe research'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:recipe-librarian');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:health-analyst', 'exa_search', 'read', 'Wellness worker health research'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:health-analyst');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:health-analyst', 'exa_answer', 'read', 'Wellness worker health research'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:health-analyst');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:health-analyst', 'browser', 'write', 'Wellness worker health research'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:health-analyst');
    `,
  },
  {
    version: 43,
    sql: `
      INSERT OR IGNORE INTO principals (id, type, display_name)
        VALUES ('user:owner', 'user', 'Owner');

      INSERT OR IGNORE INTO principals (id, type, parent_id, display_name)
        SELECT 'agent:foxtrot', 'agent', 'user:owner', 'Foxtrot' WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:watson');
      INSERT OR IGNORE INTO principals (id, type, parent_id, display_name)
        SELECT 'agent:foxtrot-ollama', 'agent', 'user:owner', 'Foxtrot (Ollama)' WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:watson');

      INSERT OR IGNORE INTO principals (id, type, parent_id, display_name)
        SELECT 'worker:foxtrot', 'worker', 'agent:foxtrot', 'Foxtrot Runtime'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:watson');
      INSERT OR IGNORE INTO principals (id, type, parent_id, display_name)
        SELECT 'worker:foxtrot-ollama', 'worker', 'agent:foxtrot-ollama', 'Foxtrot Ollama Runtime'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:watson');

      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('kilo_ledger', 'personal', 'Kilo Ledger', 'write');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot', 'attachment_search', 'read', 'finance attachment lookup'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot', 'attachment_read', 'read', 'finance attachment lookup'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot', 'attachment_status', 'read', 'finance attachment lookup'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot', 'lunch_money', 'write', 'finance account and transaction operations'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot', 'receipt_registry', 'write', 'receipt cataloging and reconciliation'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot', 'expense_reimbursement', 'write', 'ExpenseDesk reimbursement automation'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot', 'browser', 'write', 'finance and shopping web automation'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot', 'obsidian', 'write', 'finance runbooks and notes'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot', 'onepassword', 'read', 'finance credential retrieval'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot', 'gog_email', 'write', 'finance email lookup and drafting'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot', 'agent_docs', 'write', 'agent documentation updates'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot', 'kilo_ledger', 'write', 'Kilo spending ledger operations'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot', 'memory_search', 'read', 'finance context retrieval'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot', 'memory_add', 'write', 'finance memory capture'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot', 'memory_reflect', 'write', 'finance memory reflection'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot-ollama', 'attachment_search', 'read', 'finance attachment lookup'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot-ollama');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot-ollama', 'attachment_read', 'read', 'finance attachment lookup'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot-ollama');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot-ollama', 'attachment_status', 'read', 'finance attachment lookup'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot-ollama');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot-ollama', 'lunch_money', 'write', 'finance account and transaction operations'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot-ollama');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot-ollama', 'receipt_registry', 'write', 'receipt cataloging and reconciliation'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot-ollama');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot-ollama', 'expense_reimbursement', 'write', 'ExpenseDesk reimbursement automation'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot-ollama');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot-ollama', 'browser', 'write', 'finance and shopping web automation'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot-ollama');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot-ollama', 'obsidian', 'write', 'finance runbooks and notes'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot-ollama');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot-ollama', 'onepassword', 'read', 'finance credential retrieval'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot-ollama');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot-ollama', 'gog_email', 'write', 'finance email lookup and drafting'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot-ollama');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot-ollama', 'agent_docs', 'write', 'agent documentation updates'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot-ollama');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot-ollama', 'kilo_ledger', 'write', 'Kilo spending ledger operations'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot-ollama');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot-ollama', 'memory_search', 'read', 'finance context retrieval'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot-ollama');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot-ollama', 'memory_add', 'write', 'finance memory capture'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot-ollama');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot-ollama', 'memory_reflect', 'write', 'finance memory reflection'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot-ollama');
    `,
  },
  {
    version: 44,
    sql: `
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot', 'memory_search', 'read', 'finance context retrieval'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot', 'memory_add', 'write', 'finance memory capture'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot', 'memory_reflect', 'write', 'finance memory reflection'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot-ollama', 'memory_search', 'read', 'finance context retrieval'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot-ollama');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot-ollama', 'memory_add', 'write', 'finance memory capture'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot-ollama');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:foxtrot-ollama', 'memory_reflect', 'write', 'finance memory reflection'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot-ollama');
    `,
  },
  {
    version: 45,
    sql: `
      INSERT OR IGNORE INTO principals (id, type, display_name)
        VALUES ('user:owner', 'user', 'Owner');

      INSERT OR IGNORE INTO principals (id, type, parent_id, display_name)
        SELECT 'agent:kilo', 'agent', 'user:owner', 'Kilo'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:watson');
      INSERT OR IGNORE INTO principals (id, type, parent_id, display_name)
        SELECT 'worker:kilo', 'worker', 'agent:kilo', 'Kilo Runtime'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:watson');

      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('kilo_ledger', 'personal', 'Kilo Ledger', 'write');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:kilo', 'kilo_ledger', 'write', 'Kilo bucket ledger operations'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:kilo');
    `,
  },
  {
    version: 47,
    sql: `
      INSERT OR IGNORE INTO principals (id, type, display_name)
        VALUES ('user:owner', 'user', 'Owner');

      INSERT OR IGNORE INTO principals (id, type, parent_id, display_name)
        SELECT 'agent:sierra-ollama', 'agent', 'user:owner', 'Sierra (Ollama)' WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:watson');
      INSERT OR IGNORE INTO principals (id, type, parent_id, display_name)
        SELECT 'worker:sierra-ollama', 'worker', 'agent:sierra-ollama', 'Sierra Ollama Runtime' WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:watson');

      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('osrm_route', 'research', 'OSRM Route Planner', 'read');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:sierra-ollama', 'exa_search', 'read', 'Sierra Ollama research parity'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:sierra-ollama');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:sierra-ollama', 'exa_answer', 'read', 'Sierra Ollama research parity'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:sierra-ollama');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:sierra-ollama', 'location_read', 'read', 'Sierra Ollama travel navigation'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:sierra-ollama');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:sierra-ollama', 'find_diesel', 'read', 'Sierra Ollama travel navigation'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:sierra-ollama');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:sierra-ollama', 'browser', 'write', 'Sierra Ollama web automation for research and source review'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:sierra-ollama');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:research-assistant', 'osrm_route', 'read', 'travel route planning and drive-time verification'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-assistant');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:sierra-ollama', 'osrm_route', 'read', 'Sierra Ollama travel route planning and drive-time verification'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:sierra-ollama');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'osrm_route', 'read', 'travel route planning and drive-time verification'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'osrm_route');
    `,
  },
  {
    version: 48,
    sql: `
      INSERT OR IGNORE INTO principals (id, type, display_name)
        VALUES ('user:owner', 'user', 'Owner');

      INSERT OR IGNORE INTO principals (id, type, parent_id, display_name)
        SELECT 'agent:watson-ollama', 'agent', 'user:owner', 'Watson (Ollama)' WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:watson');
      INSERT OR IGNORE INTO principals (id, type, parent_id, display_name)
        SELECT 'worker:watson-ollama', 'worker', 'agent:watson-ollama', 'Watson Ollama Runtime' WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:watson');

      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('email_inbox_scan', 'personal', 'Email Inbox Scan (read-only)', 'read'),
        ('email_search', 'personal', 'Email Search (read-only)', 'read'),
        ('email_thread_brief', 'personal', 'Email Thread Brief (read-only)', 'read');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:personal-assistant', 'email_inbox_scan', 'read', 'email triage: read-only inbox scan'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:personal-assistant');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:personal-assistant', 'email_search', 'read', 'email triage: read-only search'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:personal-assistant');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:personal-assistant', 'email_thread_brief', 'read', 'email triage: read-only thread brief'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:personal-assistant');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:watson-ollama', 'email_inbox_scan', 'read', 'Watson Ollama email parity (read-only)'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:watson-ollama');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:watson-ollama', 'email_search', 'read', 'Watson Ollama email parity (read-only)'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:watson-ollama');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:watson-ollama', 'email_thread_brief', 'read', 'Watson Ollama email parity (read-only)'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:watson-ollama');
    `,
  },
  {
    version: 49,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('notion', 'personal', 'Notion (direct API)', 'write');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:research-assistant', 'notion', 'write', 'Sierra research filing: Notion read/create/update with cleanup'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-assistant');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:personal-assistant', 'notion', 'write', 'Watson notes domain: Notion read/create/update'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:personal-assistant');
    `,
  },
  {
    // osrm_route → driving_route: the tool moved to HERE Router v8 with OSRM
    // as fallback only, so the old name misleads agents. Insert-then-repoint
    // ordering keeps the permissions→governance_tools FK valid throughout.
    version: 50,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('driving_route', 'research', 'Driving Route Planner', 'read');

      UPDATE OR IGNORE permissions SET tool_id = 'driving_route', updated_at = datetime('now')
        WHERE tool_id = 'osrm_route';

      DELETE FROM permissions WHERE tool_id = 'osrm_route';
      DELETE FROM governance_tools WHERE id = 'osrm_route';
    `,
  },
  {
    version: 55,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type)
      VALUES ('walmart', 'shopping', 'Walmart Shopping', 'write');

      UPDATE governance_tools
      SET domain = 'shopping',
          display_name = 'Walmart Shopping',
          access_type = 'write'
      WHERE id = 'walmart';

      INSERT OR IGNORE INTO principals (id, type, parent_id, display_name)
      SELECT 'worker:foxtrot', 'worker', 'agent:foxtrot', 'Foxtrot Runtime'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:foxtrot');

      INSERT OR IGNORE INTO principals (id, type, parent_id, display_name)
      SELECT 'worker:foxtrot-ollama', 'worker', 'agent:foxtrot-ollama', 'Foxtrot Ollama Runtime'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:foxtrot-ollama');

      DELETE FROM permissions
      WHERE tool_id = 'walmart'
        AND principal_id IN (
          'worker:research-assistant',
          'worker:research-coordinator',
          'worker:sierra-ollama'
        );

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:foxtrot', 'walmart', 'write', 'Walmart shopping queue, history, and cart support'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'walmart');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:foxtrot-ollama', 'walmart', 'write', 'Walmart shopping queue, history, and cart support'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot-ollama')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'walmart');
    `,
  },
  {
    version: 56,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type)
      VALUES ('paper_print', 'research', 'Paper Printing', 'write');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-assistant', 'paper_print', 'write', 'travel document PDF previews and local paper printing'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'paper_print');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:sierra-ollama', 'paper_print', 'write', 'Sierra Ollama paper document printing'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:sierra-ollama')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'paper_print');
    `,
  },
  {
    version: 57,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type)
      VALUES ('walking_route', 'research', 'Walking Route Planner', 'read');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-assistant', 'walking_route', 'read', 'travel walking route planning and walk-time verification'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'walking_route');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:sierra-ollama', 'walking_route', 'read', 'Sierra Ollama walking route planning and walk-time verification'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:sierra-ollama')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'walking_route');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'walking_route', 'read', 'travel walking route planning and walk-time verification'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'walking_route');
    `,
  },
  {
    version: 58,
    sql: `
      CREATE TABLE IF NOT EXISTS orientation_nudge_state (
        user_id TEXT PRIMARY KEY,
        focus_mode_active INTEGER NOT NULL DEFAULT 0,
        focus_mode_task TEXT,
        focus_mode_expires_at TEXT,
        vacation_mode_active INTEGER NOT NULL DEFAULT 0,
        vacation_mode_expires_at TEXT,
        last_interstitial_log_at TEXT,
        last_task_rotation_change_at TEXT,
        task_rotation_signature TEXT,
        task_rotation_task TEXT,
        last_nudge_at TEXT,
        last_nudge_response_at TEXT,
        active_nudge_id TEXT,
        active_nudge_message_id TEXT,
        active_nudge_channel_id TEXT,
        active_nudge_task TEXT,
        active_nudge_sent_at TEXT,
        unanswered_nudge_count INTEGER NOT NULL DEFAULT 0,
        cooldown_until TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS orientation_nudge_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES orientation_nudge_state(user_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_orientation_nudge_events_user_created
        ON orientation_nudge_events(user_id, created_at);

      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type)
      VALUES ('orientation_nudge', 'personal', 'Orientation Nudge Controls', 'write');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:personal-assistant', 'orientation_nudge', 'write', 'Watson controls orientation focus/vacation modes'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:personal-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'orientation_nudge');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:watson-ollama', 'orientation_nudge', 'write', 'Watson Ollama controls orientation focus/vacation modes'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:watson-ollama')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'orientation_nudge');
    `,
  },
  {
    version: 59,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type)
      VALUES ('local_business_search', 'research', 'Local Business Search', 'read');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-assistant', 'local_business_search', 'read', 'local business, restaurant, venue, class, and event candidate discovery'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'local_business_search');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:sierra-ollama', 'local_business_search', 'read', 'Sierra Ollama local business and activity candidate discovery'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:sierra-ollama')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'local_business_search');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'local_business_search', 'read', 'local business and event candidate discovery for source-grounded research'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'local_business_search');
    `,
  },
  {
    version: 60,
    sql: `
      CREATE TABLE IF NOT EXISTS agent_collaboration_sessions (
        id TEXT PRIMARY KEY,
        parent_collaboration_id TEXT,
        requester_agent_id TEXT NOT NULL,
        target_agent_id TEXT NOT NULL,
        initiator_kind TEXT NOT NULL CHECK(initiator_kind IN ('user', 'agent', 'schedule', 'system')),
        initiator_ref TEXT,
        purpose TEXT NOT NULL,
        objective TEXT NOT NULL,
        normalized_objective TEXT NOT NULL,
        context_summary TEXT,
        deliverable_contract_json TEXT NOT NULL DEFAULT '{}',
        constraints_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK(status IN ('proposed', 'running', 'waiting_on_user', 'completed', 'failed', 'canceled', 'denied', 'expired')),
        visibility_mode TEXT NOT NULL CHECK(visibility_mode IN ('summary', 'digest', 'thread', 'transcript', 'silent')),
        user_surface_json TEXT,
        budget_json TEXT NOT NULL DEFAULT '{}',
        policy_decision_json TEXT,
        result_summary TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT,
        FOREIGN KEY (parent_collaboration_id) REFERENCES agent_collaboration_sessions(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_collab_request_lookup
        ON agent_collaboration_sessions(requester_agent_id, target_agent_id, purpose, normalized_objective, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_collab_status_expires
        ON agent_collaboration_sessions(status, expires_at);

      CREATE TABLE IF NOT EXISTS agent_collaboration_turns (
        id TEXT PRIMARY KEY,
        collaboration_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        sender_agent_id TEXT NOT NULL,
        recipient_agent_id TEXT NOT NULL,
        turn_type TEXT NOT NULL CHECK(turn_type IN ('request', 'clarification', 'result', 'status', 'escalation', 'error')),
        content TEXT NOT NULL,
        structured_json TEXT,
        model_run_id INTEGER,
        visible_message_ref TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (collaboration_id) REFERENCES agent_collaboration_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (model_run_id) REFERENCES model_runs(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_collab_turns_session
        ON agent_collaboration_turns(collaboration_id, turn_index);

      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type)
      VALUES ('collaborate_with_agent', 'tango', 'Agent Collaboration', 'write');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'user:owner', 'collaborate_with_agent', 'write', 'bounded agent-to-agent collaboration'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'user:owner')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'collaborate_with_agent');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'agent:watson', 'collaborate_with_agent', 'write', 'Watson bounded specialist collaboration'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:watson')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'collaborate_with_agent');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'agent:victor', 'collaborate_with_agent', 'write', 'Victor bounded specialist collaboration'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:victor')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'collaborate_with_agent');
    `,
  },
  {
    // route_ahead_search: along-route POI search (rest areas, stops, services
    // ahead of the driver). Added after Sierra confidently recommended rest
    // areas behind the driver by inferring direction from mile-marker lists.
    // 62, not 61: the sub-agent-jobs branch claimed 61 and it already ran
    // against the production DB before merging.
    version: 62,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type)
      VALUES ('route_ahead_search', 'research', 'Along-Route POI Search', 'read');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-assistant', 'route_ahead_search', 'read', 'along-route POI search: rest areas, stops, and services ahead of the driver'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'route_ahead_search');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:sierra-ollama', 'route_ahead_search', 'read', 'Sierra Ollama along-route POI search: rest areas, stops, and services ahead of the driver'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:sierra-ollama')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'route_ahead_search');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'route_ahead_search', 'read', 'along-route POI search for source-grounded travel research'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'route_ahead_search');
    `,
  },
  {
    // Typed, deterministic entity state. State values are profile data and are
    // never seeded here; only generic schemas and lifecycle templates ship in
    // the repository.
    version: 63,
    sql: `
      CREATE TABLE IF NOT EXISTS state_entity_types (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        description TEXT,
        attributes_schema TEXT NOT NULL,
        statuses TEXT,
        staleness_policy TEXT,
        digest_template TEXT,
        body_fields TEXT,
        visibility TEXT NOT NULL DEFAULT 'shared',
        origin TEXT NOT NULL DEFAULT 'seed',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        archived_at TEXT
      );

      CREATE TABLE IF NOT EXISTS state_entities (
        id TEXT PRIMARY KEY,
        type_id TEXT NOT NULL REFERENCES state_entity_types(id),
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        aliases TEXT,
        status TEXT,
        attributes TEXT NOT NULL,
        summary TEXT,
        body_pointer TEXT,
        body_fields_hash TEXT,
        owner_user_id TEXT,
        owner_agent_id TEXT,
        source TEXT NOT NULL,
        last_event_at TEXT,
        stale_after TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        archived_at TEXT,
        UNIQUE (type_id, slug)
      );
      CREATE INDEX IF NOT EXISTS idx_state_entities_type_status
        ON state_entities(type_id, status, archived_at);
      CREATE INDEX IF NOT EXISTS idx_state_entities_stale
        ON state_entities(stale_after) WHERE archived_at IS NULL;

      CREATE TABLE IF NOT EXISTS state_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id TEXT NOT NULL REFERENCES state_entities(id),
        kind TEXT NOT NULL,
        patch TEXT,
        note TEXT,
        actor TEXT NOT NULL,
        session_id TEXT,
        message_id TEXT,
        turn_id TEXT,
        reverts_event_id INTEGER REFERENCES state_events(id),
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_state_events_entity
        ON state_events(entity_id, occurred_at);
      CREATE INDEX IF NOT EXISTS idx_state_events_turn
        ON state_events(turn_id, id);
      CREATE INDEX IF NOT EXISTS idx_state_events_session
        ON state_events(session_id, recorded_at);

      CREATE TABLE IF NOT EXISTS state_focus (
        conversation_key TEXT NOT NULL,
        entity_id TEXT NOT NULL REFERENCES state_entities(id),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        PRIMARY KEY (conversation_key, entity_id)
      );
      CREATE INDEX IF NOT EXISTS idx_state_focus_expires
        ON state_focus(expires_at);

      CREATE TABLE IF NOT EXISTS state_reconciler_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL UNIQUE,
        conversation_key TEXT NOT NULL,
        session_id TEXT,
        agent_id TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'ok', 'error')),
        proposal_count INTEGER NOT NULL DEFAULT 0,
        applied_count INTEGER NOT NULL DEFAULT 0,
        rejected_count INTEGER NOT NULL DEFAULT 0,
        claimed_facts TEXT,
        rejection_reasons TEXT,
        latency_ms INTEGER,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_state_reconciler_runs_created
        ON state_reconciler_runs(created_at);
      CREATE INDEX IF NOT EXISTS idx_state_reconciler_runs_status
        ON state_reconciler_runs(status, created_at);

      CREATE TABLE IF NOT EXISTS state_issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id TEXT REFERENCES state_entities(id),
        kind TEXT NOT NULL,
        detail TEXT NOT NULL,
        metadata TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_state_issues_open
        ON state_issues(status, kind, created_at);

      CREATE TABLE IF NOT EXISTS state_memory_links (
        event_id INTEGER NOT NULL REFERENCES state_events(id),
        memory_id TEXT NOT NULL,
        entity_id TEXT NOT NULL REFERENCES state_entities(id),
        verdict TEXT NOT NULL,
        archived_at TEXT,
        unarchived_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (event_id, memory_id)
      );
      CREATE INDEX IF NOT EXISTS idx_state_memory_links_memory
        ON state_memory_links(memory_id);

      CREATE TABLE IF NOT EXISTS state_adapter_cursors (
        adapter_id TEXT PRIMARY KEY,
        cursor TEXT,
        metadata TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT OR IGNORE INTO state_entity_types (
        id, display_name, description, attributes_schema, statuses,
        staleness_policy, digest_template, body_fields, visibility, origin
      ) VALUES
        (
          'project',
          'Project',
          'A durable project or initiative with an independently tracked lifecycle.',
          '{"type":"object","additionalProperties":false,"properties":{"next_action":{"type":"string"},"target_date":{"type":"string","format":"date"},"collaborating_agent":{"type":"string"},"progress_pct":{"type":"number","minimum":0,"maximum":100},"priority":{"type":"string","enum":["low","normal","high","urgent"]}}}',
          '{"values":["idea","active","blocked","waiting","done","dropped"],"transitions":{"idea":["active","dropped"],"active":["blocked","waiting","done","dropped"],"blocked":["active","waiting","done","dropped"],"waiting":["active","blocked","done","dropped"],"done":["active"],"dropped":["active"]},"initial":"idea"}',
          '{"expected_update_days":7,"on_stale":"nudge"}',
          '{title} — {status}; next: {next_action} ({updated_age})',
          '["status","next_action","target_date","progress_pct"]',
          'shared',
          'seed'
        ),
        (
          'travel',
          'Travel',
          'A time-bound trip with current location and plan freshness.',
          '{"type":"object","additionalProperties":false,"properties":{"start_date":{"type":"string","format":"date"},"end_date":{"type":"string","format":"date"},"current_location":{"type":"string"},"location_updated_at":{"type":"string","format":"date-time"},"next_stop":{"type":"string"},"plan_status":{"type":"string"}}}',
          '{"values":["planning","active","completed","canceled"],"transitions":{"planning":["active","canceled"],"active":["completed","canceled"],"completed":["active"],"canceled":["planning"]},"initial":"planning"}',
          '{"expected_update_days":1,"on_stale":"nudge","archive_after_end_days":1}',
          '{title} — {status}; day_of(start_date,end_date); in {current_location}; location age(location_updated_at)',
          '["status","start_date","end_date","current_location","location_updated_at","next_stop"]',
          'shared',
          'seed'
        ),
        (
          'body-composition',
          'Body Composition',
          'Current body-composition observations and nutrition targets.',
          '{"type":"object","additionalProperties":false,"properties":{"weight_lb":{"type":"number","exclusiveMinimum":0},"body_fat_pct":{"type":"number","minimum":0,"maximum":100},"protein_goal_g":{"type":"number","minimum":0},"calorie_target":{"type":"number","minimum":0}}}',
          NULL,
          '{"expected_update_days":7,"on_stale":"nudge"}',
          '{title}: weight {weight_lb} lb, body fat {body_fat_pct}%, protein {protein_goal_g} g ({updated_age})',
          '["weight_lb","body_fat_pct","protein_goal_g","calorie_target"]',
          'private:wellness',
          'seed'
        ),
        (
          'vehicle',
          'Vehicle',
          'One independently tracked vehicle per entity.',
          '{"type":"object","additionalProperties":false,"properties":{"year":{"type":"integer","minimum":1886},"make":{"type":"string"},"model":{"type":"string"},"kind":{"type":"string"},"primary_use":{"type":"string"},"operational_status":{"type":"string"}}}',
          '{"values":["active","stored","sold","retired"],"transitions":{"active":["stored","sold","retired"],"stored":["active","sold","retired"],"sold":["active"],"retired":["active"]},"initial":"active"}',
          '{"expected_update_days":90,"on_stale":"nudge"}',
          '{title} — {status}; {year} {make} {model}; {primary_use}',
          '["status","year","make","model","kind","primary_use","operational_status"]',
          'shared',
          'seed'
        );

      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('state_query', 'state', 'State Query', 'read'),
        ('state_update', 'state', 'State Update', 'write'),
        ('state_define_type', 'state', 'State Type Definition', 'write');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT id, 'state_query', 'read', 'deterministic current-state access'
      FROM principals
      WHERE type IN ('user', 'agent', 'worker');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT id, 'state_update', 'write', 'revertible current-state updates'
      FROM principals
      WHERE type IN ('user', 'agent', 'worker');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT id, 'state_define_type', 'write', 'confirmed additive state type authoring'
      FROM principals
      WHERE type IN ('user', 'agent', 'worker');
    `,
  },
  {
    // Runtime scheduler/workflow projections. Only generic schemas ship here;
    // profile-specific job and review values are created by adapters at runtime.
    version: 64,
    sql: `
      INSERT OR IGNORE INTO state_entity_types (
        id, display_name, description, attributes_schema, statuses,
        staleness_policy, digest_template, body_fields, visibility, origin
      ) VALUES
        (
          'automation-job',
          'Automation Job',
          'Current verified outcome for a recurring scheduled job, with scheduler-run and log provenance.',
          '{"type":"object","additionalProperties":false,"required":["schedule_id","domain","cadence","period_key","execution_status","verification_status","last_run_id","last_started_at","evidence_ref","needs_attention"],"properties":{"schedule_id":{"type":"string"},"domain":{"type":"string"},"cadence":{"type":"string","enum":["daily","weekly","monthly"]},"period_key":{"type":"string"},"execution_status":{"type":"string","enum":["not_run","running","ok","error","skipped"]},"verification_status":{"type":"string","enum":["overdue","pending","verified_complete","verified_partial","nothing_to_do","unverified","failed"]},"last_run_id":{"type":["integer","null"],"minimum":1},"last_started_at":{"type":["string","null"],"format":"date-time"},"last_finished_at":{"type":["string","null"],"format":"date-time"},"expected_run_at":{"type":["string","null"],"format":"date-time"},"items_found":{"type":["integer","null"],"minimum":0},"items_remaining":{"type":["integer","null"],"minimum":0},"needs_attention":{"type":"boolean"},"evidence_ref":{"type":"string"},"log_pointer":{"type":["string","null"]},"last_error":{"type":["string","null"]}}}',
          '{"values":["overdue","running","healthy","attention","failed","unverified"],"transitions":{"overdue":["running","healthy","attention","failed","unverified"],"running":["overdue","healthy","attention","failed","unverified"],"healthy":["overdue","running","attention","failed","unverified"],"attention":["overdue","running","healthy","failed","unverified"],"failed":["overdue","running","healthy","attention","unverified"],"unverified":["overdue","running","healthy","attention","failed"]},"initial":"running"}',
          '{"expected_update_days":8,"on_stale":"nudge"}',
          '{title} — {verification_status}; run {last_run_id}; remaining {items_remaining}; evidence {evidence_ref}',
          '[]',
          'private:finance',
          'seed'
        ),
        (
          'finance-review',
          'Finance Review',
          'One weekly or close-period finance review with explicit per-step verification and evidence pointers.',
          '{"type":"object","additionalProperties":false,"required":["period_key","review_date","phase","dry_run","review_status","schedule_run_id","last_execution_status","step_context","step_freshness","step_job_health","step_budget","step_sinking_funds","step_reimbursements","step_close","review_note_pointer"],"properties":{"period_key":{"type":"string"},"review_date":{"type":"string","format":"date"},"phase":{"type":"string","enum":["rolling","close_prep","close","post_close"]},"dry_run":{"type":"boolean"},"review_status":{"type":"string","enum":["in_progress","blocked","complete","complete_with_actions"]},"schedule_run_id":{"type":["integer","null"],"minimum":1},"last_execution_status":{"type":"string","enum":["not_run","running","ok","error","skipped"]},"last_run_finished_at":{"type":["string","null"],"format":"date-time"},"last_error":{"type":["string","null"]},"step_context":{"$ref":"#/$defs/stepStatus"},"step_freshness":{"$ref":"#/$defs/stepStatus"},"step_job_health":{"$ref":"#/$defs/stepStatus"},"step_budget":{"$ref":"#/$defs/stepStatus"},"step_sinking_funds":{"$ref":"#/$defs/stepStatus"},"step_reimbursements":{"$ref":"#/$defs/stepStatus"},"step_close":{"$ref":"#/$defs/stepStatus"},"evidence_context":{"type":["string","null"]},"evidence_freshness":{"type":["string","null"]},"evidence_job_health":{"type":["string","null"]},"evidence_budget":{"type":["string","null"]},"evidence_sinking_funds":{"type":["string","null"]},"evidence_reimbursements":{"type":["string","null"]},"evidence_close":{"type":["string","null"]},"review_note_pointer":{"type":"string"},"job_log_pointer":{"type":["string","null"]},"open_actions":{"type":"array","items":{"type":"string"}}},"$defs":{"stepStatus":{"type":"string","enum":["pending","in_progress","verified","flagged","blocked","unverified","not_applicable"]}},"allOf":[{"if":{"properties":{"review_status":{"enum":["complete","complete_with_actions"]}},"required":["review_status"]},"then":{"properties":{"step_context":{"enum":["verified","flagged","not_applicable"]},"step_freshness":{"enum":["verified","flagged","not_applicable"]},"step_job_health":{"enum":["verified","flagged","not_applicable"]},"step_budget":{"enum":["verified","flagged","not_applicable"]},"step_sinking_funds":{"enum":["verified","flagged","not_applicable"]},"step_reimbursements":{"enum":["verified","flagged","not_applicable"]},"step_close":{"enum":["verified","flagged","not_applicable"]}}}}]}',
          '{"values":["in_progress","blocked","complete","complete_with_actions"],"transitions":{"in_progress":["blocked","complete","complete_with_actions"],"blocked":["in_progress","complete","complete_with_actions"],"complete":["in_progress"],"complete_with_actions":["in_progress","complete"]},"initial":"in_progress"}',
          '{"expected_update_days":8,"on_stale":"nudge"}',
          '{title} — {review_status}; freshness {step_freshness}; jobs {step_job_health}; budget {step_budget}; funds {step_sinking_funds}; reimbursements {step_reimbursements}',
          '[]',
          'private:finance',
          'seed'
        );
    `,
  },
  {
    // Generic project scoping, temporal semantics, and append-only links for
    // relationships and provider-neutral evidence/reference pointers. This
    // migration adds substrate only: profile-specific values and use-case
    // type packs remain outside the repository.
    version: 65,
    sql: `
      UPDATE state_entities
      SET last_progress_at = COALESCE(last_event_at, created_at)
      WHERE last_progress_at IS NULL;

      CREATE INDEX IF NOT EXISTS idx_state_entities_project
        ON state_entities(project_entity_id, archived_at);
      CREATE INDEX IF NOT EXISTS idx_state_entities_owner_user
        ON state_entities(owner_user_id, archived_at);
      CREATE INDEX IF NOT EXISTS idx_state_entities_owner_agent
        ON state_entities(owner_agent_id, archived_at);
      CREATE INDEX IF NOT EXISTS idx_state_entities_due
        ON state_entities(due_at, closed_at) WHERE archived_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_state_entities_next_check
        ON state_entities(next_check_at) WHERE archived_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_state_entities_expected_response
        ON state_entities(expected_response_at) WHERE archived_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_state_entities_progress
        ON state_entities(last_progress_at) WHERE archived_at IS NULL;

      CREATE TABLE IF NOT EXISTS state_entity_relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_entity_id TEXT NOT NULL REFERENCES state_entities(id),
        target_entity_id TEXT NOT NULL REFERENCES state_entities(id),
        kind TEXT NOT NULL,
        metadata TEXT,
        created_event_id INTEGER NOT NULL REFERENCES state_events(id),
        archived_event_id INTEGER REFERENCES state_events(id),
        created_at TEXT NOT NULL,
        archived_at TEXT,
        CHECK(source_entity_id != target_entity_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_state_entity_relations_active
        ON state_entity_relations(source_entity_id, target_entity_id, kind)
        WHERE archived_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_state_entity_relations_target
        ON state_entity_relations(target_entity_id, kind, archived_at);

      CREATE TABLE IF NOT EXISTS state_entity_references (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id TEXT NOT NULL REFERENCES state_entities(id),
        role TEXT NOT NULL,
        ref TEXT NOT NULL,
        label TEXT,
        metadata TEXT,
        supports_event_id INTEGER REFERENCES state_events(id),
        created_event_id INTEGER NOT NULL REFERENCES state_events(id),
        archived_event_id INTEGER REFERENCES state_events(id),
        created_at TEXT NOT NULL,
        archived_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_state_entity_references_active
        ON state_entity_references(entity_id, role, ref)
        WHERE archived_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_state_entity_references_role
        ON state_entity_references(role, entity_id, archived_at);
      CREATE INDEX IF NOT EXISTS idx_state_entity_references_supported_event
        ON state_entity_references(supports_event_id);
    `,
  },
  {
    // Lifecycle metadata for seeded statusful types created before terminal
    // statuses became part of the generic type contract. Keep this additive:
    // existing terminal values are retained and only missing values appended.
    version: 66,
    sql: `
      UPDATE state_entity_types
      SET statuses = json_set(
        statuses,
        '$.terminal',
        json(COALESCE(json_extract(statuses, '$.terminal'), '[]'))
      )
      WHERE id IN ('project', 'travel', 'vehicle', 'finance-review')
        AND statuses IS NOT NULL;

      UPDATE state_entity_types
      SET statuses = json_insert(statuses, '$.terminal[#]', 'done'), updated_at = datetime('now')
      WHERE id = 'project'
        AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(statuses, '$.terminal')) WHERE value = 'done');
      UPDATE state_entity_types
      SET statuses = json_insert(statuses, '$.terminal[#]', 'dropped'), updated_at = datetime('now')
      WHERE id = 'project'
        AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(statuses, '$.terminal')) WHERE value = 'dropped');

      UPDATE state_entity_types
      SET statuses = json_insert(statuses, '$.terminal[#]', 'completed'), updated_at = datetime('now')
      WHERE id = 'travel'
        AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(statuses, '$.terminal')) WHERE value = 'completed');
      UPDATE state_entity_types
      SET statuses = json_insert(statuses, '$.terminal[#]', 'canceled'), updated_at = datetime('now')
      WHERE id = 'travel'
        AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(statuses, '$.terminal')) WHERE value = 'canceled');

      UPDATE state_entity_types
      SET statuses = json_insert(statuses, '$.terminal[#]', 'sold'), updated_at = datetime('now')
      WHERE id = 'vehicle'
        AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(statuses, '$.terminal')) WHERE value = 'sold');
      UPDATE state_entity_types
      SET statuses = json_insert(statuses, '$.terminal[#]', 'retired'), updated_at = datetime('now')
      WHERE id = 'vehicle'
        AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(statuses, '$.terminal')) WHERE value = 'retired');

      UPDATE state_entity_types
      SET statuses = json_insert(statuses, '$.terminal[#]', 'complete'), updated_at = datetime('now')
      WHERE id = 'finance-review'
        AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(statuses, '$.terminal')) WHERE value = 'complete');
      UPDATE state_entity_types
      SET statuses = json_insert(statuses, '$.terminal[#]', 'complete_with_actions'), updated_at = datetime('now')
      WHERE id = 'finance-review'
        AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(statuses, '$.terminal')) WHERE value = 'complete_with_actions');

      UPDATE state_entities AS entity
      SET closed_at = COALESCE(entity.last_event_at, entity.updated_at)
      WHERE entity.closed_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM state_entity_types AS type,
               json_each(json_extract(type.statuses, '$.terminal')) AS terminal
          WHERE type.id = entity.type_id
            AND terminal.value = entity.status
        );
    `,
  },
  {
    version: 68,
    sql: `
      -- Rename the study-library tool and its worker principal so the repo
      -- carries no operator-specific naming; the site behind the tool is
      -- described by a profile-layer browser-site descriptor instead. The old
      -- ids appear here only because a rename has to name what it renames.
      --
      -- Deliberately additive: it mirrors the old rows onto the new ids and
      -- leaves the originals in place. Deleting them would mean deleting rows
      -- other grants still reference, and a half-applied delete is how a
      -- principal silently loses every permission it had.
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type, description)
      SELECT 'study_library', domain, 'Study Library', access_type, description
      FROM governance_tools WHERE id = 'reading_library';

      INSERT OR IGNORE INTO principals (id, type, parent_id, display_name)
      SELECT 'worker:study-assistant', type, parent_id, 'Study Assistant'
      FROM principals WHERE id = 'worker:library-assistant';

      -- Same grants on the renamed tool, for whoever held them.
      INSERT OR IGNORE INTO permissions (principal_id, group_id, tool_id, access_level, granted_by, reason)
      SELECT principal_id, group_id, 'study_library', access_level, granted_by, reason
      FROM permissions
      WHERE tool_id = 'reading_library'
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'study_library');

      -- Same grants for the renamed principal, on whatever tools it held.
      INSERT OR IGNORE INTO permissions (principal_id, group_id, tool_id, access_level, granted_by, reason)
      SELECT 'worker:study-assistant', group_id, tool_id, access_level, granted_by, reason
      FROM permissions
      WHERE principal_id = 'worker:library-assistant'
        AND EXISTS (SELECT 1 FROM principals WHERE id = 'worker:study-assistant');

      INSERT OR IGNORE INTO permissions (principal_id, group_id, tool_id, access_level, granted_by, reason)
      SELECT 'worker:study-assistant', group_id, 'study_library', access_level, granted_by, reason
      FROM permissions
      WHERE principal_id = 'worker:library-assistant' AND tool_id = 'reading_library'
        AND EXISTS (SELECT 1 FROM principals WHERE id = 'worker:study-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'study_library');
    `,
  },
  {
    // Newsletter Program tools for Papa (worker:study-assistant → agent:papa): let
    // Papa drive the notices.example.org "apply weekly data → build → deploy" engine
    // (newsletter-program-agent-tools + papa.yaml newsletter-program server). Appended after
    // the v68 library→study rename, so it grants the current principal directly.
    // Idempotent (INSERT OR IGNORE + EXISTS guard) — safe on fresh installs and on
    // any database already past v68. Status is read-only; update commits to staging;
    // promote publishes to production.
    version: 69,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('newsletter_program_status', 'personal', 'Newsletter Program Status', 'read'),
        ('newsletter_program_update', 'personal', 'Newsletter Program Update', 'write'),
        ('newsletter_program_promote', 'personal', 'Newsletter Program Promote', 'write');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:study-assistant', tool_id, access_level, reason
      FROM (
        SELECT 'newsletter_program_status' AS tool_id, 'read' AS access_level, 'newsletter program updates via Papa' AS reason
        UNION ALL SELECT 'newsletter_program_update', 'write', 'newsletter program updates via Papa'
        UNION ALL SELECT 'newsletter_program_promote', 'write', 'newsletter program promote via Papa'
      )
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:study-assistant');
    `,
  },
  {
    // attachment_update (v0 operator write surface: title and project_id
    // only, real columns, no schema migration). CATALOG ONLY: register the
    // tool so fresh databases know it exists, but insert NO permission rows
    // here — who holds a tool is an operator decision, made per install
    // through its own grant mechanism, never seeded by a migration.
    // (Renumbered from the source chain's migration 74 onto this chain's tail.)
    version: 70,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('attachment_update', 'attachments', 'Attachment Update', 'write');
    `,
  },
  {
    // attachment_enumerate (read-only, exhaustive-by-label listing:
    // list_projects, list_tags, by_label). Born UNGRANTED, catalog only —
    // read-vs-write does not change whose word arms a grant: permissions are
    // operator decisions, inserted per install by the operator, never by a
    // migration. (Renumbered from the source chain's migration 75 onto this
    // chain's tail.)
    version: 71,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('attachment_enumerate', 'attachments', 'Attachment Enumerate', 'read');
    `,
  },
  {
    // T-I-035 context visibility. Persist the last context-usage reading per
    // conversation+agent at the lifecycle write point, so /tango context and
    // the voice whisper survive RAM wipes (restarts, rotations, the voice
    // router's separate store). Latest reading per (conversation_key, agent_id)
    // is all the reader needs — upsert semantics, no history. Renumbered from
    // 67 to 72 (67 now collides with a migration already on this chain's tail).
    version: 72,
    sql: `
      CREATE TABLE IF NOT EXISTS context_usage_snapshots (
        conversation_key TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        fraction REAL NOT NULL,
        used_tokens INTEGER NOT NULL,
        context_window INTEGER NOT NULL,
        recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (conversation_key, agent_id)
      );

      CREATE INDEX IF NOT EXISTS idx_context_usage_snapshots_recorded
        ON context_usage_snapshots(recorded_at);
    `,
  },
  {
    // Collaboration visibility is a best-effort projection. Keep an immutable
    // delivery audit separate from the collaboration result so a Discord send
    // failure never changes an otherwise successful agent exchange.
    version: 73,
    sql: `
      CREATE TABLE IF NOT EXISTS agent_collaboration_deliveries (
        id TEXT PRIMARY KEY,
        collaboration_id TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        destination_channel_id TEXT,
        destination_thread_id TEXT,
        discord_message_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('delivered', 'failed')),
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (collaboration_id) REFERENCES agent_collaboration_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_agent_collab_deliveries_session
        ON agent_collaboration_deliveries(collaboration_id, created_at);
    `,
  },
  {
    // Jules debuts as the wellness domain's first-class V2 assistant, taking
    // over the agent:wellness principal's role. Mirrors the v68 library→study
    // pattern: additive INSERT OR IGNORE mirrors onto the new ids, originals
    // left in place — deleting rows other grants still reference is how a
    // principal silently loses every permission it had. The one UPDATE
    // (worker reparenting) only swings inheritance to agent:jules, which by
    // then holds a mirror of every grant agent:wellness had.
    version: 74,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type, description)
      SELECT 'jules_files', domain, 'Jules Wellness Files', access_type, description
      FROM governance_tools WHERE id = 'wellness_files';

      INSERT OR IGNORE INTO principals (id, type, parent_id, display_name)
      SELECT 'agent:jules', type, parent_id, 'Jules'
      FROM principals WHERE id = 'agent:wellness';

      -- Same grants on the renamed tool, for whoever held them.
      INSERT OR IGNORE INTO permissions (principal_id, group_id, tool_id, access_level, granted_by, reason)
      SELECT principal_id, group_id, 'jules_files', access_level, granted_by, reason
      FROM permissions
      WHERE tool_id = 'wellness_files'
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'jules_files');

      -- Same grants for the successor principal, on whatever tools it held.
      INSERT OR IGNORE INTO permissions (principal_id, group_id, tool_id, access_level, granted_by, reason)
      SELECT 'agent:jules', group_id, tool_id, access_level, granted_by, reason
      FROM permissions
      WHERE principal_id = 'agent:wellness'
        AND EXISTS (SELECT 1 FROM principals WHERE id = 'agent:jules');

      INSERT OR IGNORE INTO permissions (principal_id, group_id, tool_id, access_level, granted_by, reason)
      SELECT 'agent:jules', group_id, 'jules_files', access_level, granted_by, reason
      FROM permissions
      WHERE principal_id = 'agent:wellness' AND tool_id = 'wellness_files'
        AND EXISTS (SELECT 1 FROM principals WHERE id = 'agent:jules')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'jules_files');

      -- Reparent the wellness workers under Jules so permission inheritance
      -- flows from the live assistant. Guarded: only once agent:jules exists.
      UPDATE principals SET parent_id = 'agent:jules', updated_at = datetime('now')
      WHERE parent_id = 'agent:wellness'
        AND EXISTS (SELECT 1 FROM principals WHERE id = 'agent:jules');
    `,
  },
  {
    // Victor holds the personal/PM surface and needs Notion, but only in the
    // workspace that surface belongs to. Governance grants the TOOL; which
    // workspace the tool may reach is a separate profile-layer mapping
    // (NOTION_WORKSPACES_VICTOR) — see notion-agent-tools.ts. Both layers must
    // agree before Victor can write anywhere.
    version: 75,
    sql: `
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:victor', 'notion', 'write', 'Victor personal/PM filing: Notion read/write in its assigned workspace'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:victor');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:victor-ollama', 'notion', 'write', 'Victor Ollama parity: Notion read/write in its assigned workspace'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:victor-ollama');
    `,
  },
  {
    // Add the explicit weekly newsletter email send to Papa's newsletter-program
    // surface. This follows v69 rather than modifying it so existing databases
    // receive the new catalog entry and grant when they migrate.
    version: 76,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('newsletter_program_send_email', 'personal', 'Newsletter Program Send Email', 'write');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:study-assistant', 'newsletter_program_send_email', 'write', 'newsletter program email send via Papa'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:study-assistant');
    `,
  },
  {
    // Give Malibu first-class wellness.db visibility and recipe access (TGO-861).
    // Seed missing catalog tools for existing installations as well as fresh DBs.
    version: 77,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('wellnessdb_update_product', 'wellness', 'Wellness DB Update Product', 'write'),
        ('wellnessdb_update_supplement', 'wellness', 'Wellness DB Update Supplement', 'write'),
        ('wellnessdb_delete_product', 'wellness', 'Wellness DB Delete Product', 'write'),
        ('wellnessdb_delete_supplement', 'wellness', 'Wellness DB Delete Supplement', 'write');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu', 'wellnessdb_search_product', 'read', 'Malibu wellness catalog and recipes'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu', 'wellnessdb_search_recipe', 'read', 'Malibu wellness catalog and recipes'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu', 'wellnessdb_get_recipe_detail', 'read', 'Malibu wellness catalog and recipes'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu', 'wellnessdb_day_summary', 'read', 'Malibu wellness catalog and recipes'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu', 'wellnessdb_day_range', 'read', 'Malibu wellness catalog and recipes'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu', 'wellnessdb_recent_meals', 'read', 'Malibu wellness catalog and recipes'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu', 'wellnessdb_active_products', 'read', 'Malibu wellness catalog and recipes'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu', 'wellnessdb_add_recipe', 'write', 'Malibu wellness catalog and recipes'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu', 'wellnessdb_update_recipe', 'write', 'Malibu wellness catalog and recipes'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu-ollama', 'wellnessdb_search_product', 'read', 'Malibu wellness catalog and recipes'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu-ollama');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu-ollama', 'wellnessdb_search_recipe', 'read', 'Malibu wellness catalog and recipes'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu-ollama');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu-ollama', 'wellnessdb_get_recipe_detail', 'read', 'Malibu wellness catalog and recipes'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu-ollama');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu-ollama', 'wellnessdb_day_summary', 'read', 'Malibu wellness catalog and recipes'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu-ollama');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu-ollama', 'wellnessdb_day_range', 'read', 'Malibu wellness catalog and recipes'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu-ollama');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu-ollama', 'wellnessdb_recent_meals', 'read', 'Malibu wellness catalog and recipes'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu-ollama');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu-ollama', 'wellnessdb_active_products', 'read', 'Malibu wellness catalog and recipes'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu-ollama');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu-ollama', 'wellnessdb_add_recipe', 'write', 'Malibu wellness catalog and recipes'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu-ollama');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu-ollama', 'wellnessdb_update_recipe', 'write', 'Malibu wellness catalog and recipes'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu-ollama');
    `,
  },
  {
    // Retire legacy recipe-note and ingredient SQL access (TGO-861 Phase B).
    version: 78,
    sql: `
      DELETE FROM permissions
        WHERE tool_id IN ('atlas_sql', 'recipe_list', 'recipe_read', 'recipe_write');
      DELETE FROM governance_tools
        WHERE id IN ('atlas_sql', 'recipe_list', 'recipe_read', 'recipe_write');
    `,
  },
  {
    // Enable recipe administration for Malibu and the recipe librarian.
    version: 79,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('wellnessdb_add_recipe_ingredient', 'wellness-db', 'Wellness DB Add Recipe Ingredient', 'write'),
        ('wellnessdb_update_recipe_ingredient', 'wellness-db', 'Wellness DB Update Recipe Ingredient', 'write'),
        ('wellnessdb_remove_recipe_ingredient', 'wellness-db', 'Wellness DB Remove Recipe Ingredient', 'write'),
        ('wellnessdb_archive_recipe', 'wellness-db', 'Wellness DB Archive Recipe', 'write'),
        ('wellnessdb_duplicate_recipe', 'wellness-db', 'Wellness DB Duplicate Recipe', 'write');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu', 'wellnessdb_add_recipe_ingredient', 'write', 'Wellness DB recipe administration'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu', 'wellnessdb_update_recipe_ingredient', 'write', 'Wellness DB recipe administration'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu', 'wellnessdb_remove_recipe_ingredient', 'write', 'Wellness DB recipe administration'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu', 'wellnessdb_archive_recipe', 'write', 'Wellness DB recipe administration'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu', 'wellnessdb_duplicate_recipe', 'write', 'Wellness DB recipe administration'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu-ollama', 'wellnessdb_add_recipe_ingredient', 'write', 'Wellness DB recipe administration'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu-ollama');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu-ollama', 'wellnessdb_update_recipe_ingredient', 'write', 'Wellness DB recipe administration'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu-ollama');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu-ollama', 'wellnessdb_remove_recipe_ingredient', 'write', 'Wellness DB recipe administration'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu-ollama');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu-ollama', 'wellnessdb_archive_recipe', 'write', 'Wellness DB recipe administration'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu-ollama');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu-ollama', 'wellnessdb_duplicate_recipe', 'write', 'Wellness DB recipe administration'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu-ollama');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:recipe-librarian', 'wellnessdb_add_recipe_ingredient', 'write', 'Wellness DB recipe administration'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:recipe-librarian');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:recipe-librarian', 'wellnessdb_update_recipe_ingredient', 'write', 'Wellness DB recipe administration'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:recipe-librarian');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:recipe-librarian', 'wellnessdb_remove_recipe_ingredient', 'write', 'Wellness DB recipe administration'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:recipe-librarian');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:recipe-librarian', 'wellnessdb_archive_recipe', 'write', 'Wellness DB recipe administration'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:recipe-librarian');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:recipe-librarian', 'wellnessdb_duplicate_recipe', 'write', 'Wellness DB recipe administration'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:recipe-librarian');
    `,
  },
  {
    // 2026-09-06 — Malibu product admin: the unit step an ingredient comes
    // apart in (½ bag, 1 egg) lives on the product, so recipe administration
    // needs product writes too. Catalog rows already exist; grant only.
    version: 80,
    sql: `
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu', 'wellnessdb_add_product', 'write', 'Wellness DB product administration'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu', 'wellnessdb_update_product', 'write', 'Wellness DB product administration'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu-ollama', 'wellnessdb_add_product', 'write', 'Wellness DB product administration'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu-ollama');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'agent:malibu-ollama', 'wellnessdb_update_product', 'write', 'Wellness DB product administration'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'agent:malibu-ollama');
    `,
  },
  {
    // Wispr Flow remote MCP (profile-configured): catalog row on upgraded
    // databases (GOVERNANCE_SEED only runs in migration 11) plus the read grant
    // for the personal-assistant worker when that principal exists.
    version: 81,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('wispr_flow', 'personal', 'Wispr Flow Remote MCP (meeting notes, transcripts, scratchpad, calendar)', 'read');
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
        SELECT 'worker:personal-assistant', 'wispr_flow', 'read', 'Watson reads Wispr Flow meeting notes, transcripts, and scratchpad notes'
        WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:personal-assistant');
    `,
  },
  {
    // Bank transfers: owner-approved draws between the owner's own accounts.
    // Foxtrot only — the Ollama clone is a test surface and does not move money.
    version: 82,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type)
      VALUES ('bank_transfer', 'personal', 'Bank Transfers (owner-approved)', 'write');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:foxtrot', 'bank_transfer', 'write', 'owner-approved Bank sinking-fund draws'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:foxtrot');
    `,
  },
  {
    // Day One journal tools: catalog rows on upgraded databases (GOVERNANCE_SEED
    // only runs in migration 11). No grants — journals are private, so an
    // operator grants named principals with scripts/grant-dayone.mjs.
    version: 83,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('dayone_read', 'personal', 'Day One journal entries', 'read'),
        ('dayone_write', 'personal', 'Day One journal entry writing', 'write');
    `,
  },
  { version: 84, sql: `
    CREATE TABLE IF NOT EXISTS loom_deliveries (
      run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, conversation_key TEXT NOT NULL,
      loom_thread_id TEXT NOT NULL, channel_id TEXT NOT NULL, thread_id TEXT,
      message_id TEXT NOT NULL, context TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','abandoned')),
      claimed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  ` },
  { version: 85, sql: `
    CREATE TABLE conversations (
      conversation_key TEXT PRIMARY KEY, agent_id TEXT,
      kind TEXT NOT NULL CHECK(kind IN ('thread','home')), title TEXT NOT NULL DEFAULT '',
      origin TEXT NOT NULL CHECK(origin IN ('desk','discord','voice','schedule','check-in')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')), archived_at TEXT,
      discord_channel_id TEXT, discord_thread_id TEXT
    );
    CREATE TEMP TABLE message_sequence_backup AS SELECT seq FROM sqlite_sequence WHERE name = 'messages';
    CREATE TABLE messages_complete (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, agent_id TEXT, provider_name TEXT,
      direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound','system','error')),
      source TEXT NOT NULL CHECK(source IN ('discord','tango','imessage','desk','voice')),
      discord_message_id TEXT, discord_channel_id TEXT, discord_user_id TEXT, discord_username TEXT,
      content TEXT NOT NULL, metadata_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      visibility TEXT NOT NULL DEFAULT 'public', conversation_key TEXT,
      author_kind TEXT CHECK(author_kind IN ('owner','agent','system','requester')),
      reply_to_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      discord_message_ids TEXT NOT NULL DEFAULT '[]', attachments TEXT NOT NULL DEFAULT '[]',
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    INSERT INTO messages_complete (id,session_id,agent_id,provider_name,direction,source,
      discord_message_id,discord_channel_id,discord_user_id,discord_username,content,metadata_json,created_at,visibility,
      discord_message_ids)
    SELECT id,session_id,agent_id,provider_name,direction,source,
      discord_message_id,discord_channel_id,discord_user_id,discord_username,content,metadata_json,created_at,visibility,
      CASE WHEN discord_message_id IS NULL THEN '[]' ELSE json_array(discord_message_id) END FROM messages;
    DROP TABLE messages;
    ALTER TABLE messages_complete RENAME TO messages;
    UPDATE sqlite_sequence SET seq = MAX(seq,COALESCE((SELECT seq FROM message_sequence_backup),0)) WHERE name = 'messages';
    DROP TABLE message_sequence_backup;
    CREATE INDEX idx_messages_session_created ON messages(session_id,created_at);
    CREATE INDEX idx_messages_channel_created ON messages(discord_channel_id,created_at);
    CREATE INDEX idx_messages_discord_message ON messages(discord_message_id);
    CREATE INDEX idx_messages_conversation_id ON messages(conversation_key,id);
    CREATE TABLE conversation_discord_messages (
      discord_message_id TEXT PRIMARY KEY, message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE
    );
  ` },
  { version: 86, sql: `
    -- One latest revision per post; replacing a row allocates a monotonic cursor.
    CREATE TABLE IF NOT EXISTS conversation_changes (
      revision INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL UNIQUE,
      conversation_key TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_changes_key ON conversation_changes(conversation_key, revision);
    INSERT OR IGNORE INTO conversation_changes(message_id, conversation_key)
      SELECT id, conversation_key FROM messages WHERE conversation_key IS NOT NULL AND visibility = 'public' ORDER BY id;
    CREATE TRIGGER IF NOT EXISTS conversation_message_insert AFTER INSERT ON messages
      WHEN NEW.conversation_key IS NOT NULL AND NEW.visibility = 'public' BEGIN
      INSERT OR REPLACE INTO conversation_changes(message_id,conversation_key) VALUES(NEW.id,NEW.conversation_key);
    END;
    CREATE TRIGGER IF NOT EXISTS conversation_message_update AFTER UPDATE ON messages
      WHEN NEW.conversation_key IS NOT NULL AND NEW.visibility = 'public' BEGIN
      INSERT OR REPLACE INTO conversation_changes(message_id,conversation_key) VALUES(NEW.id,NEW.conversation_key);
    END;
  ` },
];

export { resolveDatabasePath } from "./runtime-paths.js";

export interface TangoStorageOptions {
  /**
   * Apply GOVERNANCE_EXAMPLE_SEED immediately after the base governance seed
   * (migration 11). Default false: fresh databases are born ungranted (T-I-071);
   * installs and tests that want the upstream example roster opt in explicitly.
   */
  seedExampleRoster?: boolean;
}

export class TangoStorage {
  private options: TangoStorageOptions;
  private readonly db: DatabaseSync;

  constructor(dbPath: string, options: TangoStorageOptions = {}) {
    this.options = options;
    const resolvedPath = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    this.db = new DatabaseSync(resolvedPath);
    this.configure();
    this.migrate();
    if (this.getUserVersion() >= 19) {
      this.deleteExpiredPromptSnapshots();
    }
    if (this.getUserVersion() >= 24) {
      this.expireStaleActiveTasks();
    }
    if (this.getUserVersion() >= 31) {
      this.expireActiveContextItems();
    }
  }

  close(): void {
    this.db.close();
  }

  /** Expose database for governance and other modules that share this connection. */
  getDatabase(): DatabaseSync {
    return this.db;
  }

  configure(): void {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
  }

  migrate(): void {
    const currentVersion = this.getUserVersion();

    for (const migration of MIGRATIONS) {
      if (migration.version <= currentVersion) continue;

      // Rebuild messages without cascading deletes into model runs and other references.
      if (migration.version === 85) this.db.exec("PRAGMA foreign_keys = OFF;");
      this.db.exec("BEGIN IMMEDIATE;");
      try {
        const previousForeignKeyIssues = migration.version === 85
          ? new Set(this.db.prepare("PRAGMA foreign_key_check").all().map(row => JSON.stringify(row))) : new Set<string>();
        if (migration.version === 65) this.ensureStateManagementV65Columns();
        // Some repair/import workflows replay earlier versions on an already upgraded DB.
        const alreadyComplete = migration.version === 85 && (this.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).some(c => c.name === "conversation_key");
        if (!alreadyComplete) this.db.exec(migration.sql);
        // T-I-071: a fresh DB is born ungranted — the upstream example roster is
        // opt-in. Applied here (inside migration 11's transaction, before any
        // later migration that conditionally extends roster grants) so opted-in
        // installs get the full historical behavior.
        if (migration.version === 11 && this.options.seedExampleRoster) {
          this.db.exec(GOVERNANCE_EXAMPLE_SEED);
        }
        if (migration.version === 85 && this.db.prepare("PRAGMA foreign_key_check").all().some(row => !previousForeignKeyIssues.has(JSON.stringify(row)))) {
          throw new Error("Conversation migration would violate foreign keys");
        }
        this.db.exec(`PRAGMA user_version = ${migration.version};`);
        this.db.exec("COMMIT;");
      } catch (error) {
        this.db.exec("ROLLBACK;");
        throw error;
      } finally {
        if (migration.version === 85) this.db.exec("PRAGMA foreign_keys = ON;");
      }
    }
  }

  private ensureStateManagementV65Columns(): void {
    const columns = new Set((this.db.prepare("PRAGMA table_info(state_entities)").all() as Array<{ name: string }>)
      .map((row) => row.name));
    const additions: Array<[string, string]> = [
      ["project_entity_id", "TEXT REFERENCES state_entities(id)"],
      ["visibility", "TEXT"],
      ["due_at", "TEXT"],
      ["next_check_at", "TEXT"],
      ["expected_response_at", "TEXT"],
      ["last_progress_at", "TEXT"],
      ["closed_at", "TEXT"],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE state_entities ADD COLUMN ${name} ${definition};`);
    }
  }

  bootstrapSessions(sessions: SessionConfig[]): void {
    for (const session of sessions) {
      this.upsertSession(session);
    }
  }

  upsertSession(session: SessionConfig): void {
    this.db
      .prepare(
        `
          INSERT INTO sessions (id, session_type, default_agent_id, updated_at)
          VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(id) DO UPDATE SET
            session_type = excluded.session_type,
            default_agent_id = excluded.default_agent_id,
            updated_at = datetime('now')
        `
      )
      .run(session.id, session.type, session.agent);
  }

  insertLoomDelivery(record: LoomDelivery): void {
    this.db.prepare(`INSERT OR IGNORE INTO loom_deliveries
      (run_id,agent_id,conversation_key,loom_thread_id,channel_id,thread_id,message_id,context,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(record.runId,record.agentId,record.conversationKey,record.loomThreadId,
        record.channelId,record.threadId ?? null,record.messageId,JSON.stringify(record.context),record.createdAt,record.createdAt);
  }

  listPendingLoomDeliveries(): LoomDelivery[] {
    return (this.db.prepare(`SELECT run_id AS runId, agent_id AS agentId, conversation_key AS conversationKey,
      loom_thread_id AS loomThreadId, channel_id AS channelId, thread_id AS threadId, message_id AS messageId,
      context, created_at AS createdAt FROM loom_deliveries WHERE status='pending' AND claimed_at IS NULL`).all() as Array<Omit<LoomDelivery, "context"> & {context: string}>)
      .map(row => ({...row, context: JSON.parse(row.context)}));
  }

  latestLoomDelivery(loomThreadId: string): LoomDelivery | null {
    const row = this.db.prepare(`SELECT run_id AS runId, agent_id AS agentId, conversation_key AS conversationKey,
      loom_thread_id AS loomThreadId, channel_id AS channelId, thread_id AS threadId, message_id AS messageId,
      context, created_at AS createdAt FROM loom_deliveries WHERE loom_thread_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(loomThreadId) as (Omit<LoomDelivery, "context"> & { context: string }) | undefined;
    return row ? { ...row, context: JSON.parse(row.context) } : null;
  }

  hasLoomDeliveryForMessage(messageId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM loom_deliveries WHERE message_id=?").get(messageId));
  }

  claimLoomDelivery(runId: string): boolean {
    return this.db.prepare(`UPDATE loom_deliveries SET claimed_at=?, updated_at=?
      WHERE run_id=? AND status='pending' AND claimed_at IS NULL`).run(new Date().toISOString(),new Date().toISOString(),runId).changes === 1;
  }

  finishLoomDelivery(runId: string, status: "delivered" | "abandoned"): void {
    this.db.prepare(`UPDATE loom_deliveries SET status=?,updated_at=? WHERE run_id=? AND status='pending'`)
      .run(status,new Date().toISOString(),runId);
  }

  upsertProviderSession(record: {
    conversationKey: string;
    sessionId: string;
    agentId: string;
    providerName: string;
    providerSessionId: string;
  }): void {
    this.db
      .prepare(
        `
          INSERT INTO provider_sessions (
            conversation_key,
            session_id,
            agent_id,
            provider_name,
            provider_session_id,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(conversation_key, provider_name) DO UPDATE SET
            session_id = excluded.session_id,
            agent_id = excluded.agent_id,
            provider_name = excluded.provider_name,
            provider_session_id = excluded.provider_session_id,
            updated_at = datetime('now')
        `
      )
      .run(
        record.conversationKey,
        record.sessionId,
        record.agentId,
        record.providerName,
        record.providerSessionId
      );
  }

  getProviderSession(conversationKey: string, providerName?: string): ProviderSessionRecord | null {
    if (providerName && providerName.trim().length > 0) {
      const row = this.db
        .prepare(
          `
            SELECT
              conversation_key AS conversationKey,
              session_id AS sessionId,
              agent_id AS agentId,
              provider_name AS providerName,
              provider_session_id AS providerSessionId,
              created_at AS createdAt,
              updated_at AS updatedAt
            FROM provider_sessions
            WHERE conversation_key = ? AND provider_name = ?
          `
        )
        .get(conversationKey, providerName.trim()) as ProviderSessionRecord | undefined;

      return row ?? null;
    }

    const row = this.db
      .prepare(
        `
          SELECT
            conversation_key AS conversationKey,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            provider_session_id AS providerSessionId,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM provider_sessions
          WHERE conversation_key = ?
          ORDER BY updated_at DESC
          LIMIT 1
        `
      )
      .get(conversationKey) as ProviderSessionRecord | undefined;

    return row ?? null;
  }

  clearProviderSession(conversationKey: string, providerName?: string): boolean {
    const normalizedProviderName = providerName?.trim();
    const result =
      normalizedProviderName && normalizedProviderName.length > 0
        ? this.db
            .prepare(
              `
                DELETE FROM provider_sessions
                WHERE conversation_key = ? AND provider_name = ?
              `
            )
            .run(conversationKey, normalizedProviderName)
        : this.db
            .prepare(
              `
                DELETE FROM provider_sessions
                WHERE conversation_key = ?
              `
            )
            .run(conversationKey);

    return toSafeNumber(result.changes) > 0;
  }

  listProviderSessionsForConversation(conversationKey: string, limit = 50): ProviderSessionRecord[] {
    const resolvedLimit = Number.isFinite(limit) ? Math.max(limit, 1) : 50;
    const rows = this.db
      .prepare(
        `
          SELECT
            conversation_key AS conversationKey,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            provider_session_id AS providerSessionId,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM provider_sessions
          WHERE conversation_key = ?
          ORDER BY updated_at DESC
          LIMIT ?
        `
      )
      .all(conversationKey, resolvedLimit) as Array<{
      conversationKey: string;
      sessionId: string;
      agentId: string;
      providerName: string;
      providerSessionId: string;
      createdAt: string;
      updatedAt: string;
    }>;

    return rows.map((row) => ({
      conversationKey: row.conversationKey,
      sessionId: row.sessionId,
      agentId: row.agentId,
      providerName: row.providerName,
      providerSessionId: row.providerSessionId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }));
  }

  upsertSessionCompaction(input: {
    sessionId: string;
    agentId: string;
    summaryText: string;
    compactedTurns: number;
  }): void {
    this.db
      .prepare(
        `
          INSERT INTO session_compactions (
            session_id,
            agent_id,
            summary_text,
            compacted_turns,
            updated_at
          )
          VALUES (?, ?, ?, ?, datetime('now'))
          ON CONFLICT(session_id, agent_id) DO UPDATE SET
            summary_text = excluded.summary_text,
            compacted_turns = excluded.compacted_turns,
            updated_at = datetime('now')
        `
      )
      .run(input.sessionId, input.agentId, input.summaryText, Math.max(0, input.compactedTurns));
  }

  getSessionCompaction(sessionId: string, agentId: string): SessionCompactionRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            session_id AS sessionId,
            agent_id AS agentId,
            summary_text AS summaryText,
            compacted_turns AS compactedTurns,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM session_compactions
          WHERE session_id = ? AND agent_id = ?
        `
      )
      .get(sessionId, agentId) as SessionCompactionRecord | undefined;

    return row ?? null;
  }

  clearSessionCompaction(sessionId: string, agentId: string): boolean {
    const result = this.db
      .prepare(
        `
          DELETE FROM session_compactions
          WHERE session_id = ? AND agent_id = ?
        `
      )
      .run(sessionId, agentId);

    return toSafeNumber(result.changes) > 0;
  }

  upsertActiveContextItem(input: ActiveContextItemUpsertInput): ActiveContextItemRecord {
    const scope = input.scope ?? {};
    const scopeKey = buildActiveContextScopeKey(scope);
    const normalizedKey = input.key.trim();
    if (normalizedKey.length === 0) {
      throw new Error("Active context key is required");
    }

    const summary = input.summary.trim();
    if (summary.length === 0) {
      throw new Error("Active context summary is required");
    }

    this.db
      .prepare(
        `
          INSERT INTO active_context_items (
            scope_key,
            context_key,
            user_id,
            agent_id,
            channel_id,
            topic_id,
            project_id,
            kind,
            title,
            summary,
            key_facts_json,
            source_refs_json,
            metadata_json,
            expires_at,
            archived_at,
            updated_at,
            last_accessed_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, datetime('now'), datetime('now'))
          ON CONFLICT(scope_key, context_key) DO UPDATE SET
            kind = excluded.kind,
            title = excluded.title,
            summary = excluded.summary,
            key_facts_json = excluded.key_facts_json,
            source_refs_json = excluded.source_refs_json,
            metadata_json = excluded.metadata_json,
            expires_at = excluded.expires_at,
            archived_at = NULL,
            updated_at = datetime('now')
        `
      )
      .run(
        scopeKey,
        normalizedKey,
        scope.userId ?? null,
        scope.agentId ?? null,
        scope.channelId ?? null,
        scope.topicId ?? null,
        scope.projectId ?? null,
        input.kind,
        input.title?.trim() || null,
        summary,
        JSON.stringify(normalizeStringList(input.keyFacts)),
        JSON.stringify(normalizeStringList(input.sourceRefs)),
        toJsonOrNull(input.metadata),
        input.expiresAt ?? null
      );

    const row = this.db
      .prepare(
        `
          SELECT
            id,
            context_key AS key,
            user_id AS userId,
            agent_id AS agentId,
            channel_id AS channelId,
            topic_id AS topicId,
            project_id AS projectId,
            kind,
            title,
            summary,
            key_facts_json AS keyFactsJson,
            source_refs_json AS sourceRefsJson,
            created_at AS createdAt,
            updated_at AS updatedAt,
            last_accessed_at AS lastAccessedAt,
            access_count AS accessCount,
            expires_at AS expiresAt,
            archived_at AS archivedAt,
            metadata_json AS metadataJson
          FROM active_context_items
          WHERE scope_key = ? AND context_key = ?
        `
      )
      .get(scopeKey, normalizedKey) as ActiveContextItemRow | undefined;

    if (!row) {
      throw new Error("Failed to read upserted active context item");
    }
    return toActiveContextItemRecord(row);
  }

  listActiveContextItems(options: ListActiveContextItemsOptions = {}): ActiveContextItemRecord[] {
    const conditions: string[] = [];
    const values: Array<string | number | null> = [];
    const scope = options.scope ?? {};

    addNullableScopeCondition(conditions, values, "user_id", scope.userId);
    addNullableScopeCondition(conditions, values, "agent_id", scope.agentId);
    addNullableScopeCondition(conditions, values, "channel_id", scope.channelId);
    addNullableScopeCondition(conditions, values, "topic_id", scope.topicId);
    addNullableScopeCondition(conditions, values, "project_id", scope.projectId);

    if (options.includeArchived !== true) {
      conditions.push("archived_at IS NULL");
    }

    if (options.includeExpired !== true) {
      const now = normalizeSqliteTimestamp(options.now ?? new Date());
      conditions.push("(expires_at IS NULL OR expires_at > ?)");
      values.push(now);
    }

    const limit = Number.isFinite(options.limit) ? Math.max(options.limit ?? 50, 1) : 50;
    values.push(limit);
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            context_key AS key,
            user_id AS userId,
            agent_id AS agentId,
            channel_id AS channelId,
            topic_id AS topicId,
            project_id AS projectId,
            kind,
            title,
            summary,
            key_facts_json AS keyFactsJson,
            source_refs_json AS sourceRefsJson,
            created_at AS createdAt,
            updated_at AS updatedAt,
            last_accessed_at AS lastAccessedAt,
            access_count AS accessCount,
            expires_at AS expiresAt,
            archived_at AS archivedAt,
            metadata_json AS metadataJson
          FROM active_context_items
          ${whereClause}
          ORDER BY updated_at DESC, id DESC
          LIMIT ?
        `
      )
      .all(...values) as ActiveContextItemRow[];

    return rows.map((row) => toActiveContextItemRecord(row));
  }

  touchActiveContextItems(itemIds: number[]): void {
    const ids = [...new Set(itemIds.filter((value) => Number.isInteger(value) && value > 0))];
    if (ids.length === 0) return;

    const statement = this.db.prepare(
      `
        UPDATE active_context_items
        SET
          last_accessed_at = datetime('now'),
          access_count = access_count + 1
        WHERE id = ?
      `
    );

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      for (const itemId of ids) {
        statement.run(itemId);
      }
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  expireActiveContextItems(now: string | Date = new Date()): number {
    const result = this.db
      .prepare(
        `
          UPDATE active_context_items
          SET archived_at = COALESCE(archived_at, datetime('now'))
          WHERE archived_at IS NULL
            AND expires_at IS NOT NULL
            AND expires_at <= ?
        `
      )
      .run(normalizeSqliteTimestamp(now));

    return toSafeNumber(result.changes);
  }

  private rowToProjectState(row: ProjectStateRow): ProjectStateRecord {
    return {
      projectId: row.project_id,
      title: row.title,
      status: row.status,
      quickRead: row.quick_read,
      obsidianPath: row.obsidian_path,
      templateId: row.template_id,
      prevSessionId: row.prev_session_id,
      leadAgentId: row.lead_agent_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastSavedAt: row.last_saved_at,
    };
  }

  getProjectState(projectId: string): ProjectStateRecord | undefined {
    const key = projectId.trim();
    if (key.length === 0) return undefined;
    const row = this.db
      .prepare(
        `SELECT project_id, title, status, quick_read, obsidian_path, template_id,
                prev_session_id, lead_agent_id, created_at, updated_at, last_saved_at
         FROM project_state WHERE project_id = ?`
      )
      .get(key) as ProjectStateRow | undefined;
    return row ? this.rowToProjectState(row) : undefined;
  }

  /**
   * Insert or partially update a project_state head. On update, only fields that
   * are explicitly provided are overwritten (undefined = leave unchanged; an
   * explicit null clears). `markSaved` stamps last_saved_at = now.
   */
  upsertProjectState(input: ProjectStateUpsertInput): ProjectStateRecord {
    const projectId = input.projectId.trim();
    if (projectId.length === 0) {
      throw new Error("project_state projectId is required");
    }

    const existing = this.getProjectState(projectId);
    if (!existing) {
      const lastSavedSql = input.markSaved ? "datetime('now')" : "NULL";
      this.db
        .prepare(
          `INSERT INTO project_state (
             project_id, title, status, quick_read, obsidian_path, template_id,
             prev_session_id, lead_agent_id, last_saved_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${lastSavedSql})`
        )
        .run(
          projectId,
          (input.title ?? projectId).trim(),
          (input.status ?? "active").trim(),
          input.quickRead ?? null,
          input.obsidianPath ?? null,
          input.templateId ?? null,
          input.prevSessionId ?? null,
          input.leadAgentId ?? null
        );
    } else {
      const sets: string[] = ["updated_at = datetime('now')"];
      const values: Array<string | null> = [];
      const setField = (col: string, value: string | null | undefined) => {
        if (value !== undefined) {
          sets.push(`${col} = ?`);
          values.push(value);
        }
      };
      setField("title", input.title?.trim());
      setField("status", input.status?.trim());
      setField("quick_read", input.quickRead);
      setField("obsidian_path", input.obsidianPath);
      setField("template_id", input.templateId);
      setField("prev_session_id", input.prevSessionId);
      setField("lead_agent_id", input.leadAgentId);
      if (input.markSaved) {
        sets.push("last_saved_at = datetime('now')");
      }
      values.push(projectId);
      this.db
        .prepare(`UPDATE project_state SET ${sets.join(", ")} WHERE project_id = ?`)
        .run(...values);
    }

    const saved = this.getProjectState(projectId);
    if (!saved) {
      throw new Error("Failed to read upserted project_state");
    }
    return saved;
  }

  listProjectStates(options: ListProjectStatesOptions = {}): ProjectStateRecord[] {
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (options.status) {
      conditions.push("status = ?");
      values.push(options.status);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Number.isFinite(options.limit) ? Math.max(options.limit ?? 50, 1) : 50;
    values.push(limit);
    const rows = this.db
      .prepare(
        `SELECT project_id, title, status, quick_read, obsidian_path, template_id,
                prev_session_id, lead_agent_id, created_at, updated_at, last_saved_at
         FROM project_state ${whereClause} ORDER BY updated_at DESC LIMIT ?`
      )
      .all(...values) as unknown as ProjectStateRow[];
    return rows.map((row) => this.rowToProjectState(row));
  }

  insertMemory(input: MemoryInsertInput): number {
    const metadataJson = toJsonOrNull(input.metadata);
    const normalizedImportance = Math.min(Math.max(input.importance ?? 0.5, 0), 1);
    const result = this.db
      .prepare(
        `
          INSERT INTO memories (
            session_id,
            agent_id,
            source,
            content,
            importance,
            source_ref,
            embedding_json,
            embedding_model,
            created_at,
            last_accessed_at,
            archived_at,
            metadata_json
          )
          VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?,
            COALESCE(?, datetime('now')),
            COALESCE(?, COALESCE(?, datetime('now'))),
            ?,
            ?
          )
        `
      )
      .run(
        input.sessionId ?? null,
        input.agentId ?? null,
        input.source,
        input.content,
        normalizedImportance,
        input.sourceRef ?? null,
        input.embeddingJson ?? null,
        input.embeddingModel ?? null,
        input.createdAt ?? null,
        input.lastAccessedAt ?? null,
        input.createdAt ?? null,
        input.archivedAt ?? null,
        metadataJson
      );

    const rowId = result.lastInsertRowid;
    return typeof rowId === "bigint" ? Number(rowId) : rowId;
  }

  getMemory(memoryId: number): StoredMemoryRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            source,
            content,
            importance,
            source_ref AS sourceRef,
            embedding_json AS embeddingJson,
            embedding_model AS embeddingModel,
            created_at AS createdAt,
            last_accessed_at AS lastAccessedAt,
            access_count AS accessCount,
            archived_at AS archivedAt,
            metadata_json AS metadataJson
          FROM memories
          WHERE id = ?
        `
      )
      .get(memoryId) as
      | (Omit<StoredMemoryRecord, "metadata"> & { metadataJson: string | null })
      | undefined;

    if (!row) return null;
    return toStoredMemoryRecord(row);
  }

  findMemoryBySourceRef(sourceRef: string, source?: MemorySource): StoredMemoryRecord | null {
    const row = (source
      ? this.db
          .prepare(
            `
              SELECT
                id,
                session_id AS sessionId,
                agent_id AS agentId,
                source,
                content,
                importance,
                source_ref AS sourceRef,
                embedding_json AS embeddingJson,
                embedding_model AS embeddingModel,
                created_at AS createdAt,
                last_accessed_at AS lastAccessedAt,
                access_count AS accessCount,
                archived_at AS archivedAt,
                metadata_json AS metadataJson
              FROM memories
              WHERE source_ref = ? AND source = ?
              ORDER BY id DESC
              LIMIT 1
            `
          )
          .get(sourceRef, source)
      : this.db
          .prepare(
            `
              SELECT
                id,
                session_id AS sessionId,
                agent_id AS agentId,
                source,
                content,
                importance,
                source_ref AS sourceRef,
                embedding_json AS embeddingJson,
                embedding_model AS embeddingModel,
                created_at AS createdAt,
                last_accessed_at AS lastAccessedAt,
                access_count AS accessCount,
                archived_at AS archivedAt,
                metadata_json AS metadataJson
              FROM memories
              WHERE source_ref = ?
              ORDER BY id DESC
              LIMIT 1
            `
          )
          .get(sourceRef)) as
      | (Omit<StoredMemoryRecord, "metadata"> & { metadataJson: string | null })
      | undefined;

    if (!row) return null;
    return toStoredMemoryRecord(row);
  }

  listMemories(options: ListMemoriesOptions = {}): StoredMemoryRecord[] {
    const conditions: string[] = [];
    const values: Array<string | number | null> = [];

    if (options.sessionId !== undefined) {
      if (options.sessionId === null) {
        conditions.push("session_id IS NULL");
      } else {
        conditions.push("(session_id = ? OR session_id IS NULL)");
        values.push(options.sessionId);
      }
    }

    const agentIds = [...new Set((options.agentIds ?? []).map((agentId) => agentId.trim()).filter(Boolean))];

    if (agentIds.length > 0) {
      const placeholders = agentIds.map(() => "?").join(", ");
      conditions.push(`(agent_id IN (${placeholders}) OR agent_id IS NULL)`);
      values.push(...agentIds);
    } else if (options.agentId !== undefined) {
      if (options.agentId === null) {
        conditions.push("agent_id IS NULL");
      } else {
        conditions.push("(agent_id = ? OR agent_id IS NULL)");
        values.push(options.agentId);
      }
    }

    if (options.source && options.source !== "all") {
      conditions.push("source = ?");
      values.push(options.source);
    }

    if (options.includeArchived !== true) {
      conditions.push("archived_at IS NULL");
    }

    const limit = Number.isFinite(options.limit) ? Math.max(options.limit ?? 100, 1) : 100;
    values.push(limit);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            source,
            content,
            importance,
            source_ref AS sourceRef,
            embedding_json AS embeddingJson,
            embedding_model AS embeddingModel,
            created_at AS createdAt,
            last_accessed_at AS lastAccessedAt,
            access_count AS accessCount,
            archived_at AS archivedAt,
            metadata_json AS metadataJson
          FROM memories
          ${whereClause}
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `
      )
      .all(...values) as Array<Omit<StoredMemoryRecord, "metadata"> & { metadataJson: string | null }>;

    return rows.map((row) => toStoredMemoryRecord(row));
  }

  touchMemories(memoryIds: number[]): void {
    const ids = [...new Set(memoryIds.filter((value) => Number.isInteger(value) && value > 0))];
    if (ids.length === 0) return;

    const statement = this.db.prepare(
      `
        UPDATE memories
        SET
          last_accessed_at = datetime('now'),
          access_count = access_count + 1
        WHERE id = ?
      `
    );

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      for (const memoryId of ids) {
        statement.run(memoryId);
      }
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  archiveMemory(memoryId: number): boolean {
    const result = this.db
      .prepare(
        `
          UPDATE memories
          SET archived_at = COALESCE(archived_at, datetime('now'))
          WHERE id = ?
        `
      )
      .run(memoryId);

    return toSafeNumber(result.changes) > 0;
  }

  /** Drop all obsidian_index hash entries so the next index run re-chunks every file. */
  clearObsidianIndexEntries(): number {
    const result = this.db.prepare(`DELETE FROM obsidian_index`).run();
    return toSafeNumber(result.changes);
  }

  listMemoriesMissingEmbedding(input: { source?: string | null; limit?: number }): Array<{
    id: number;
    content: string;
  }> {
    const limit = Math.max(1, Math.trunc(input.limit ?? 6_000));
    const source = input.source?.trim() || null;
    const rows = source
      ? this.db
          .prepare(
            `
              SELECT id, content
              FROM memories
              WHERE embedding_json IS NULL
                AND archived_at IS NULL
                AND source = ?
              ORDER BY id DESC
              LIMIT ?
            `
          )
          .all(source, limit)
      : this.db
          .prepare(
            `
              SELECT id, content
              FROM memories
              WHERE embedding_json IS NULL
                AND archived_at IS NULL
              ORDER BY id DESC
              LIMIT ?
            `
          )
          .all(limit);

    return rows as Array<{ id: number; content: string }>;
  }

  updateMemoryEmbedding(input: MemoryEmbeddingUpdateInput): boolean {
    const result = this.db
      .prepare(
        `
          UPDATE memories
          SET
            embedding_json = ?,
            embedding_model = ?
          WHERE id = ?
        `
      )
      .run(input.embeddingJson, input.embeddingModel, input.memoryId);

    return toSafeNumber(result.changes) > 0;
  }

  deleteMemoriesBySourceRefPrefix(source: MemorySource, sourceRefPrefix: string): number {
    const result = this.db
      .prepare(
        `
          DELETE FROM memories
          WHERE source = ? AND source_ref LIKE ?
        `
      )
      .run(source, `${sourceRefPrefix}%`);

    return toSafeNumber(result.changes);
  }

  upsertSessionMemorySummary(input: SessionSummaryUpsertInput): void {
    this.db
      .prepare(
        `
          INSERT INTO session_summaries (
            session_id,
            agent_id,
            summary_text,
            token_count,
            covers_through_message_id,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(session_id, agent_id, covers_through_message_id) DO UPDATE SET
            summary_text = excluded.summary_text,
            token_count = excluded.token_count,
            updated_at = datetime('now')
        `
      )
      .run(
        input.sessionId,
        input.agentId,
        input.summaryText,
        Math.max(0, input.tokenCount),
        input.coversThroughMessageId ?? null
      );
  }

  getLatestSessionMemorySummary(sessionId: string, agentId: string): SessionSummaryRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            summary_text AS summaryText,
            token_count AS tokenCount,
            covers_through_message_id AS coversThroughMessageId,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM session_summaries
          WHERE session_id = ? AND agent_id = ?
          ORDER BY COALESCE(covers_through_message_id, 0) DESC, id DESC
          LIMIT 1
        `
      )
      .get(sessionId, agentId) as SessionSummaryRecord | undefined;

    return row ?? null;
  }

  listSessionMemorySummaries(sessionId: string, agentId: string, limit = 20): SessionSummaryRecord[] {
    const resolvedLimit = Number.isFinite(limit) ? Math.max(limit, 1) : 20;
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            summary_text AS summaryText,
            token_count AS tokenCount,
            covers_through_message_id AS coversThroughMessageId,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM session_summaries
          WHERE session_id = ? AND agent_id = ?
          ORDER BY COALESCE(covers_through_message_id, 0) DESC, id DESC
          LIMIT ?
        `
      )
      .all(sessionId, agentId, resolvedLimit) as Array<{
      id: number;
      sessionId: string;
      agentId: string;
      summaryText: string;
      tokenCount: number;
      coversThroughMessageId: number | null;
      createdAt: string;
      updatedAt: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      agentId: row.agentId,
      summaryText: row.summaryText,
      tokenCount: row.tokenCount,
      coversThroughMessageId: row.coversThroughMessageId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  upsertPinnedFact(input: PinnedFactUpsertInput): void {
    this.db
      .prepare(
        `
          INSERT INTO pinned_facts (
            scope,
            scope_id,
            key,
            value,
            updated_at
          )
          VALUES (?, ?, ?, ?, datetime('now'))
          ON CONFLICT(scope, scope_id, key) DO UPDATE SET
            value = excluded.value,
            updated_at = datetime('now')
        `
      )
      .run(input.scope, input.scopeId ?? null, input.key, input.value);
  }

  listPinnedFactsForContext(sessionId: string, agentId: string): PinnedFactRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            scope,
            scope_id AS scopeId,
            key,
            value,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM pinned_facts
          WHERE
            (scope = 'global' AND scope_id IS NULL) OR
            (scope = 'agent' AND scope_id = ?) OR
            (scope = 'session' AND scope_id = ?)
          ORDER BY
            CASE scope
              WHEN 'session' THEN 0
              WHEN 'agent' THEN 1
              ELSE 2
            END,
            key ASC
        `
      )
      .all(agentId, sessionId) as Array<{
      id: number;
      scope: PinnedFactScope;
      scopeId: string | null;
      key: string;
      value: string;
      createdAt: string;
      updatedAt: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      scope: row.scope,
      scopeId: row.scopeId,
      key: row.key,
      value: row.value,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  deletePinnedFact(scope: PinnedFactScope, scopeId: string | null, key: string): boolean {
    const result = this.db
      .prepare(
        `
          DELETE FROM pinned_facts
          WHERE scope = ? AND scope_id IS ? AND key = ?
        `
      )
      .run(scope, scopeId, key);

    return toSafeNumber(result.changes) > 0;
  }

  getObsidianIndexEntry(filePath: string): ObsidianIndexRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            file_path AS filePath,
            file_hash AS fileHash,
            last_indexed_at AS lastIndexedAt,
            chunk_count AS chunkCount
          FROM obsidian_index
          WHERE file_path = ?
        `
      )
      .get(filePath) as ObsidianIndexRecord | undefined;

    return row ?? null;
  }

  listObsidianIndexEntries(limit = 10_000): ObsidianIndexRecord[] {
    const resolvedLimit = Number.isFinite(limit) ? Math.max(limit, 1) : 10_000;
    return this.db
      .prepare(
        `
          SELECT
            id,
            file_path AS filePath,
            file_hash AS fileHash,
            last_indexed_at AS lastIndexedAt,
            chunk_count AS chunkCount
          FROM obsidian_index
          ORDER BY file_path ASC
          LIMIT ?
        `
      )
      .all(resolvedLimit) as unknown as ObsidianIndexRecord[];
  }

  upsertObsidianIndexEntry(input: ObsidianIndexUpsertInput): void {
    this.db
      .prepare(
        `
          INSERT INTO obsidian_index (
            file_path,
            file_hash,
            last_indexed_at,
            chunk_count
          )
          VALUES (?, ?, COALESCE(?, datetime('now')), ?)
          ON CONFLICT(file_path) DO UPDATE SET
            file_hash = excluded.file_hash,
            last_indexed_at = excluded.last_indexed_at,
            chunk_count = excluded.chunk_count
        `
      )
      .run(
        input.filePath,
        input.fileHash,
        input.lastIndexedAt ?? null,
        Math.max(0, Math.floor(input.chunkCount))
      );
  }

  deleteObsidianIndexEntry(filePath: string): boolean {
    const result = this.db
      .prepare(
        `
          DELETE FROM obsidian_index
          WHERE file_path = ?
        `
      )
      .run(filePath);

    return toSafeNumber(result.changes) > 0;
  }

  upsertSessionProviderOverride(input: {
    sessionId: string;
    agentId: string;
    providerName: string;
  }): void {
    this.db
      .prepare(
        `
          INSERT INTO session_provider_overrides (
            session_id,
            agent_id,
            provider_name,
            updated_at
          )
          VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(session_id, agent_id) DO UPDATE SET
            provider_name = excluded.provider_name,
            updated_at = datetime('now')
        `
      )
      .run(input.sessionId, input.agentId, input.providerName);
  }

  getSessionProviderOverride(
    sessionId: string,
    agentId: string
  ): SessionProviderOverrideRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM session_provider_overrides
          WHERE session_id = ? AND agent_id = ?
        `
      )
      .get(sessionId, agentId) as SessionProviderOverrideRecord | undefined;

    return row ?? null;
  }

  clearSessionProviderOverride(sessionId: string, agentId: string): boolean {
    const result = this.db
      .prepare(
        `
          DELETE FROM session_provider_overrides
          WHERE session_id = ? AND agent_id = ?
        `
      )
      .run(sessionId, agentId);

    return toSafeNumber(result.changes) > 0;
  }

  listSessionProviderOverrides(sessionId?: string, limit = 200): SessionProviderOverrideRecord[] {
    const resolvedLimit = Number.isFinite(limit) ? Math.max(limit, 1) : 200;
    if (sessionId) {
      const rows = this.db
        .prepare(
          `
            SELECT
              session_id AS sessionId,
              agent_id AS agentId,
              provider_name AS providerName,
              created_at AS createdAt,
              updated_at AS updatedAt
            FROM session_provider_overrides
            WHERE session_id = ?
            ORDER BY updated_at DESC
            LIMIT ?
          `
        )
        .all(sessionId, resolvedLimit) as Array<{
        sessionId: string;
        agentId: string;
        providerName: string;
        createdAt: string;
        updatedAt: string;
      }>;

      return rows.map((row) => ({
        sessionId: row.sessionId,
        agentId: row.agentId,
        providerName: row.providerName,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      }));
    }

    const rows = this.db
      .prepare(
        `
          SELECT
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM session_provider_overrides
          ORDER BY updated_at DESC
          LIMIT ?
        `
      )
      .all(resolvedLimit) as Array<{
      sessionId: string;
      agentId: string;
      providerName: string;
      createdAt: string;
      updatedAt: string;
    }>;

    return rows.map((row) => ({
      sessionId: row.sessionId,
      agentId: row.agentId,
      providerName: row.providerName,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }));
  }

  /** A Discord id identifies one visible post, even when a later writer adds turn diagnostics. */
  findConversationPostByDiscordId(discordId: string): number | null {
    const row = this.db.prepare(`SELECT message_id AS id FROM conversation_discord_messages WHERE discord_message_id = ?
      UNION ALL SELECT id FROM messages WHERE discord_message_id = ? AND visibility = 'public' LIMIT 1`)
      .get(discordId, discordId) as { id: number } | undefined;
    return row?.id ?? null;
  }

  recordConversationPost(input: ConversationPostInput): number {
    if (!/^(?:(?:thread|channel):[0-9]+|conv:[0-7][0-9A-HJKMNP-TV-Z]{25})$/.test(input.conversationKey)) throw new Error("Invalid conversation key");
    const ids = [...new Set(input.discordMessageIds ?? (input.discordMessageId ? [input.discordMessageId] : []))];
    const existing = input.localMessageId ?? ids.map(id => this.findConversationPostByDiscordId(id)).find(id => id !== null);
    this.db.exec("SAVEPOINT conversation_post");
    try {
      this.db.prepare(`INSERT INTO conversations (conversation_key,agent_id,kind,title,origin,created_at,discord_channel_id,discord_thread_id)
        VALUES (?,?,?,?,?,COALESCE(?,datetime('now')),?,?) ON CONFLICT(conversation_key) DO UPDATE SET
        agent_id = COALESCE(?,conversations.agent_id,excluded.agent_id),
        discord_channel_id = COALESCE(excluded.discord_channel_id,conversations.discord_channel_id)`)
        .run(input.conversationKey,input.conversationAgentId ?? input.agentId ?? null,input.conversationKey.startsWith("channel:") ? "home" : "thread",
          input.title ?? "",input.origin ?? "discord",input.createdAt ?? null,input.discordParentChannelId ?? (input.conversationKey.startsWith("thread:") ? null : input.discordChannelId ?? null),
          input.discordThreadId ?? (input.conversationKey.startsWith("thread:") ? input.conversationKey.slice(7) : null),input.conversationAgentId ?? null);
      const id = existing ?? this.insertMessage(input);
      const old = this.db.prepare("SELECT discord_message_ids,metadata_json FROM messages WHERE id = ?").get(id) as { discord_message_ids: string; metadata_json: string | null };
      const allIds = [...new Set([...parseJsonArray(old.discord_message_ids),...ids])].sort((a, b) =>
        /^\d+$/.test(a) && /^\d+$/.test(b) ? (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0) : a.localeCompare(b));
      this.db.prepare(`UPDATE messages SET conversation_key=?,author_kind=?,reply_to_message_id=COALESCE(?,reply_to_message_id),
        discord_message_ids=?,attachments=COALESCE(?,attachments),created_at=COALESCE(?,created_at),
        session_id=?,agent_id=COALESCE(?,agent_id),provider_name=COALESCE(?,provider_name),direction=?,source=?,content=?,
        metadata_json=?,discord_message_id=COALESCE(?,discord_message_id) WHERE id=?`).run(input.conversationKey,input.authorKind,input.replyToMessageId ?? null,
          JSON.stringify(allIds),input.attachments ? JSON.stringify(input.attachments) : null,input.createdAt ?? null,
          input.sessionId,input.agentId ?? null,input.providerName ?? null,input.direction,input.source,input.content,
          JSON.stringify({...safeJsonParse(old.metadata_json ?? "{}"),...input.metadata}),input.discordMessageId ?? null,id);
      for (const discordId of allIds) this.db.prepare(`INSERT INTO conversation_discord_messages VALUES (?,?)
        ON CONFLICT(discord_message_id) DO NOTHING`).run(discordId,id);
      this.db.exec("RELEASE conversation_post");
      return id;
    } catch (error) {
      this.db.exec("ROLLBACK TO conversation_post; RELEASE conversation_post");
      throw error;
    }
  }

  insertMessage(input: MessageInsertInput): number {
    const metadataJson = toJsonOrNull(input.metadata);

    const result = this.db
      .prepare(
        `
          INSERT INTO messages (
            session_id,
            agent_id,
            provider_name,
            direction,
            source,
            visibility,
            discord_message_id,
            discord_channel_id,
            discord_user_id,
            discord_username,
            content,
            metadata_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        input.sessionId,
        input.agentId ?? null,
        input.providerName ?? null,
        input.direction,
        input.source,
        input.visibility ?? "public",
        input.discordMessageId ?? null,
        input.discordChannelId ?? null,
        input.discordUserId ?? null,
        input.discordUsername ?? null,
        input.content,
        metadataJson
      );

    const rowId = result.lastInsertRowid;
    return typeof rowId === "bigint" ? Number(rowId) : rowId;
  }

  upsertTopic(input: {
    channelKey: string;
    slug: string;
    title: string;
    leadAgentId?: string | null;
    projectId?: string | null;
    preserveProjectId?: boolean;
    status?: TopicStatus;
  }): TopicRecord {
    const existing = this.getTopicByChannelAndSlug(input.channelKey, input.slug);
    if (existing) {
      const nextProjectId =
        input.preserveProjectId === false
          ? (input.projectId ?? null)
          : (input.projectId ?? existing.projectId);
      this.db
        .prepare(
          `
            UPDATE topics
            SET
              title = ?,
              lead_agent_id = ?,
              project_id = ?,
              status = ?,
              updated_at = datetime('now')
            WHERE id = ?
          `
        )
        .run(
          input.title,
          input.leadAgentId ?? existing.leadAgentId,
          nextProjectId,
          input.status ?? existing.status,
          existing.id
        );

      return this.getTopicById(existing.id)!;
    }

    const topicId = randomUUID();
    this.db
      .prepare(
        `
          INSERT INTO topics (
            id,
            channel_key,
            slug,
            title,
            lead_agent_id,
            project_id,
            status
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        topicId,
        input.channelKey,
        input.slug,
        input.title,
        input.leadAgentId ?? null,
        input.projectId ?? null,
        input.status ?? "active"
      );

    return this.getTopicById(topicId)!;
  }

  getTopicById(topicId: string): TopicRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            channel_key AS channelKey,
            slug,
            title,
            lead_agent_id AS leadAgentId,
            project_id AS projectId,
            status,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM topics
          WHERE id = ?
        `
      )
      .get(topicId) as
      | {
          id: string;
          channelKey: string;
          slug: string;
          title: string;
          leadAgentId: string | null;
          projectId: string | null;
          status: TopicStatus;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;

    if (!row) return null;
    return row;
  }

  getTopicByChannelAndSlug(channelKey: string, slug: string): TopicRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            channel_key AS channelKey,
            slug,
            title,
            lead_agent_id AS leadAgentId,
            project_id AS projectId,
            status,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM topics
          WHERE channel_key = ? AND slug = ?
        `
      )
      .get(channelKey, slug) as
      | {
          id: string;
          channelKey: string;
          slug: string;
          title: string;
          leadAgentId: string | null;
          projectId: string | null;
          status: TopicStatus;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;

    if (!row) return null;
    return row;
  }

  listTopicsForChannel(channelKey: string, limit = 50): TopicRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            channel_key AS channelKey,
            slug,
            title,
            lead_agent_id AS leadAgentId,
            project_id AS projectId,
            status,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM topics
          WHERE channel_key = ?
          ORDER BY updated_at DESC
          LIMIT ?
        `
      )
      .all(channelKey, limit) as Array<{
      id: string;
      channelKey: string;
      slug: string;
      title: string;
      leadAgentId: string | null;
      projectId: string | null;
      status: TopicStatus;
      createdAt: string;
      updatedAt: string;
    }>;

    return rows;
  }

  setFocusedTopicForChannel(channelKey: string, topicId: string | null): void {
    this.db
      .prepare(
        `
          INSERT INTO topic_focus (
            channel_key,
            topic_id,
            updated_at
          )
          VALUES (?, ?, datetime('now'))
          ON CONFLICT(channel_key) DO UPDATE SET
            topic_id = excluded.topic_id,
            updated_at = datetime('now')
        `
      )
      .run(channelKey, topicId);
  }

  getFocusedTopicRecordForChannel(channelKey: string): TopicFocusRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            channel_key AS channelKey,
            topic_id AS topicId,
            updated_at AS updatedAt
          FROM topic_focus
          WHERE channel_key = ?
        `
      )
      .get(channelKey) as
      | {
          channelKey: string;
          topicId: string | null;
          updatedAt: string;
        }
      | undefined;

    if (!row) return null;
    return row;
  }

  getFocusedTopicForChannel(channelKey: string): TopicRecord | null {
    const focused = this.getFocusedTopicRecordForChannel(channelKey);
    if (!focused?.topicId) return null;
    return this.getTopicById(focused.topicId);
  }

  setFocusedProjectForChannel(channelKey: string, projectId: string | null): void {
    this.db
      .prepare(
        `
          INSERT INTO project_focus (
            channel_key,
            project_id,
            updated_at
          )
          VALUES (?, ?, datetime('now'))
          ON CONFLICT(channel_key) DO UPDATE SET
            project_id = excluded.project_id,
            updated_at = datetime('now')
        `
      )
      .run(channelKey, projectId);
  }

  getFocusedProjectRecordForChannel(channelKey: string): ProjectFocusRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            channel_key AS channelKey,
            project_id AS projectId,
            updated_at AS updatedAt
          FROM project_focus
          WHERE channel_key = ?
        `
      )
      .get(channelKey) as
      | {
          channelKey: string;
          projectId: string | null;
          updatedAt: string;
        }
      | undefined;

    if (!row) return null;
    return row;
  }

  getFocusedProjectIdForChannel(channelKey: string): string | null {
    return this.getFocusedProjectRecordForChannel(channelKey)?.projectId ?? null;
  }

  setThreadSession(threadId: string, sessionId: string, agentId?: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO discord_thread_sessions (thread_id, session_id, agent_id)
         VALUES (?, ?, ?)`
      )
      .run(threadId, sessionId, agentId ?? null);
  }

  getThreadSession(threadId: string): { sessionId: string; agentId: string | null } | null {
    const row = this.db
      .prepare(`SELECT session_id, agent_id FROM discord_thread_sessions WHERE thread_id = ?`)
      .get(threadId) as { session_id: string; agent_id: string | null } | undefined;
    if (!row) return null;
    return { sessionId: row.session_id, agentId: row.agent_id };
  }

  deleteThreadSession(threadId: string): void {
    this.db
      .prepare(`DELETE FROM discord_thread_sessions WHERE thread_id = ?`)
      .run(threadId);
  }

  listDiscordThreadSessionIds(): string[] {
    const rows = this.db
      .prepare(`SELECT thread_id FROM discord_thread_sessions`)
      .all() as { thread_id: string }[];
    return rows.map((row) => row.thread_id);
  }

  listThreadSessionsWithAgent(): { threadId: string; sessionId: string; agentId: string }[] {
    const rows = this.db
      .prepare(`SELECT thread_id, session_id, agent_id FROM discord_thread_sessions WHERE agent_id IS NOT NULL`)
      .all() as { thread_id: string; session_id: string; agent_id: string }[];
    return rows.map((row) => ({ threadId: row.thread_id, sessionId: row.session_id, agentId: row.agent_id }));
  }

  listThreadSessionsMissingAgent(): { threadId: string; sessionId: string }[] {
    const rows = this.db
      .prepare(`SELECT thread_id, session_id FROM discord_thread_sessions WHERE agent_id IS NULL`)
      .all() as { thread_id: string; session_id: string }[];
    return rows.map((row) => ({ threadId: row.thread_id, sessionId: row.session_id }));
  }

  getSessionDefaultAgentId(sessionId: string): string | null {
    const row = this.db
      .prepare(`SELECT default_agent_id FROM sessions WHERE id = ?`)
      .get(sessionId) as { default_agent_id: string } | undefined;
    return row?.default_agent_id ?? null;
  }

  insertModelRun(input: ModelRunInsertInput): number {
    const metadataJson = toJsonOrNull(input.metadata);
    const rawResponseJson = toJsonOrNull(input.rawResponse);

    const result = this.db
      .prepare(
        `
          INSERT INTO model_runs (
            session_id,
            agent_id,
            provider_name,
            conversation_key,
            provider_session_id,
            model,
            stop_reason,
            response_mode,
            latency_ms,
            provider_duration_ms,
            provider_api_duration_ms,
            input_tokens,
            output_tokens,
            cache_read_input_tokens,
            cache_creation_input_tokens,
            total_cost_usd,
            is_error,
            error_message,
            request_message_id,
            response_message_id,
            metadata_json,
            raw_response_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        input.sessionId,
        input.agentId,
        input.providerName,
        input.conversationKey,
        input.providerSessionId ?? null,
        input.model ?? null,
        input.stopReason ?? null,
        input.responseMode ?? null,
        input.latencyMs ?? null,
        input.providerDurationMs ?? null,
        input.providerApiDurationMs ?? null,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        input.cacheReadInputTokens ?? null,
        input.cacheCreationInputTokens ?? null,
        input.totalCostUsd ?? null,
        input.isError ? 1 : 0,
        input.errorMessage ?? null,
        input.requestMessageId ?? null,
        input.responseMessageId ?? null,
        metadataJson,
        rawResponseJson
      );

    const rowId = result.lastInsertRowid;
    return typeof rowId === "bigint" ? Number(rowId) : rowId;
  }

  /** Lightweight per-run stats since a UTC "YYYY-MM-DD HH:MM:SS" boundary —
   *  feeds the weekly model scorecard (production is the continuous eval). */
  listModelRunStats(sinceUtc: string): ModelRunStatRow[] {
    const rows = this.db
      .prepare(
        `
          SELECT
            agent_id AS agentId,
            model,
            provider_name AS providerName,
            stop_reason AS stopReason,
            latency_ms AS latencyMs,
            output_tokens AS outputTokens,
            is_error AS isError,
            created_at AS createdAt
          FROM model_runs
          WHERE created_at >= ?
          ORDER BY created_at ASC
        `
      )
      .all(sinceUtc) as Array<Omit<ModelRunStatRow, "isError"> & { isError: number }>;
    return rows.map((row) => ({ ...row, isError: row.isError === 1 }));
  }

  getModelRun(id: number): ModelRunRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            conversation_key AS conversationKey,
            provider_session_id AS providerSessionId,
            model,
            stop_reason AS stopReason,
            response_mode AS responseMode,
            latency_ms AS latencyMs,
            provider_duration_ms AS providerDurationMs,
            provider_api_duration_ms AS providerApiDurationMs,
            input_tokens AS inputTokens,
            output_tokens AS outputTokens,
            cache_read_input_tokens AS cacheReadInputTokens,
            cache_creation_input_tokens AS cacheCreationInputTokens,
            total_cost_usd AS totalCostUsd,
            is_error AS isError,
            error_message AS errorMessage,
            request_message_id AS requestMessageId,
            response_message_id AS responseMessageId,
            metadata_json AS metadataJson,
            raw_response_json AS rawResponseJson,
            created_at AS createdAt
          FROM model_runs
          WHERE id = ?
        `
      )
      .get(id) as
      | (Omit<ModelRunRecord, "metadata" | "rawResponse"> & {
          metadataJson: string | null;
          rawResponseJson: string | null;
        })
      | undefined;

    if (!row) return null;

    return {
      id: row.id,
      sessionId: row.sessionId,
      agentId: row.agentId,
      providerName: row.providerName,
      conversationKey: row.conversationKey,
      providerSessionId: row.providerSessionId,
      model: row.model,
      stopReason: row.stopReason,
      responseMode: row.responseMode,
      latencyMs: row.latencyMs,
      providerDurationMs: row.providerDurationMs,
      providerApiDurationMs: row.providerApiDurationMs,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadInputTokens: row.cacheReadInputTokens,
      cacheCreationInputTokens: row.cacheCreationInputTokens,
      totalCostUsd: row.totalCostUsd,
      isError: row.isError,
      errorMessage: row.errorMessage,
      requestMessageId: row.requestMessageId,
      responseMessageId: row.responseMessageId,
      metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
      rawResponse: row.rawResponseJson ? safeJsonParse(row.rawResponseJson) : null,
      createdAt: row.createdAt
    };
  }

  insertDeterministicTurn(input: DeterministicTurnInsertInput): string {
    const id = input.id?.trim() || randomUUID();
    const intentIds = input.intentIds ?? [];
    const workerIds = input.workerIds ?? [];
    const delegationChain = input.delegationChain ?? [];
    const intentJson = JSON.stringify(input.intentJson);
    const executionPlanJson = JSON.stringify(input.executionPlanJson ?? null);
    const receiptsJson = JSON.stringify(input.receiptsJson ?? null);
    const stepCount =
      Array.isArray(input.receiptsJson)
        ? input.receiptsJson.length
        : Array.isArray((input.executionPlanJson as { steps?: unknown } | null | undefined)?.steps)
          ? ((input.executionPlanJson as { steps: unknown[] }).steps.length)
          : 0;

    this.db
      .prepare(
        `
          INSERT INTO deterministic_turns (
            id,
            session_id,
            agent_id,
            conversation_key,
            initiating_principal_id,
            lead_agent_principal_id,
            project_id,
            topic_id,
            intent_count,
            intent_ids,
            intent_json,
            intent_model_run_id,
            route_outcome,
            fallback_reason,
            execution_plan_json,
            step_count,
            completed_step_count,
            failed_step_count,
            has_write_operations,
            worker_ids,
            delegation_chain,
            receipts_json,
            narration_provider,
            narration_model,
            narration_latency_ms,
            narration_retried,
            narration_model_run_id,
            intent_latency_ms,
            route_latency_ms,
            execution_latency_ms,
            total_latency_ms,
            request_message_id,
            response_message_id
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        id,
        input.sessionId,
        input.agentId,
        input.conversationKey,
        input.initiatingPrincipalId,
        input.leadAgentPrincipalId,
        input.projectId ?? null,
        input.topicId ?? null,
        intentIds.length,
        JSON.stringify(intentIds),
        intentJson,
        input.intentModelRunId ?? null,
        input.routeOutcome,
        input.fallbackReason ?? null,
        executionPlanJson,
        stepCount,
        input.completedStepCount ?? 0,
        input.failedStepCount ?? 0,
        input.hasWriteOperations ? 1 : 0,
        JSON.stringify(workerIds),
        JSON.stringify(delegationChain),
        receiptsJson,
        input.narrationProvider ?? null,
        input.narrationModel ?? null,
        input.narrationLatencyMs ?? null,
        input.narrationRetried ? 1 : 0,
        input.narrationModelRunId ?? null,
        input.intentLatencyMs ?? null,
        input.routeLatencyMs ?? null,
        input.executionLatencyMs ?? null,
        input.totalLatencyMs ?? null,
        input.requestMessageId ?? null,
        input.responseMessageId ?? null,
      );

    return id;
  }

  insertSubAgentRun(input: SubAgentRunInsertInput): string {
    const id = input.id?.trim() || randomUUID();
    this.db
      .prepare(
        `
          INSERT INTO sub_agent_runs (
            id,
            batch_id,
            parent_session_id,
            parent_agent_id,
            conversation_key,
            coordinator_worker_id,
            round_index,
            sub_task_id,
            provider_name,
            model,
            reasoning_effort,
            tool_ids,
            dependency_ids,
            status,
            duration_ms,
            cost_estimate_usd,
            error,
            output_text,
            tool_calls_json,
            metadata_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        id,
        input.batchId,
        input.parentSessionId ?? null,
        input.parentAgentId ?? null,
        input.conversationKey ?? null,
        input.coordinatorWorkerId,
        input.roundIndex,
        input.subTaskId,
        input.providerName ?? null,
        input.model ?? null,
        input.reasoningEffort ?? null,
        JSON.stringify(input.toolIds ?? []),
        JSON.stringify(input.dependencyIds ?? []),
        input.status,
        input.durationMs ?? 0,
        input.costEstimateUsd ?? null,
        input.error ?? null,
        input.outputText ?? null,
        JSON.stringify(input.toolCallsJson ?? null),
        toJsonOrNull(input.metadata),
      );

    return id;
  }

  insertAgentCollaborationSession(input: AgentCollaborationSessionInsertInput): string {
    const id = input.id?.trim() || randomUUID();
    this.db
      .prepare(
        `
          INSERT INTO agent_collaboration_sessions (
            id,
            parent_collaboration_id,
            requester_agent_id,
            target_agent_id,
            initiator_kind,
            initiator_ref,
            purpose,
            objective,
            normalized_objective,
            context_summary,
            deliverable_contract_json,
            constraints_json,
            status,
            visibility_mode,
            user_surface_json,
            budget_json,
            policy_decision_json,
            result_summary,
            error,
            expires_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        id,
        input.parentCollaborationId ?? null,
        input.requesterAgentId,
        input.targetAgentId,
        input.initiatorKind,
        input.initiatorRef ?? null,
        input.purpose,
        input.objective,
        input.normalizedObjective,
        input.contextSummary ?? null,
        JSON.stringify(input.deliverableContract ?? {}),
        JSON.stringify(input.constraints ?? []),
        input.status,
        input.visibilityMode,
        toJsonOrNull(input.userSurface),
        JSON.stringify(input.budget ?? {}),
        toJsonOrNull(input.policyDecision),
        input.resultSummary ?? null,
        input.error ?? null,
        input.expiresAt ?? null,
      );

    return id;
  }

  updateAgentCollaborationSession(id: string, input: AgentCollaborationSessionUpdateInput): boolean {
    const existing = this.getAgentCollaborationSession(id);
    if (!existing) {
      return false;
    }

    const policyDecision =
      input.policyDecision === undefined ? existing.policyDecision : input.policyDecision;
    this.db
      .prepare(
        `
          UPDATE agent_collaboration_sessions
          SET
            status = ?,
            policy_decision_json = ?,
            result_summary = ?,
            error = ?,
            expires_at = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `,
      )
      .run(
        input.status ?? existing.status,
        toJsonOrNull(policyDecision),
        input.resultSummary === undefined ? existing.resultSummary : input.resultSummary,
        input.error === undefined ? existing.error : input.error,
        input.expiresAt === undefined ? existing.expiresAt : input.expiresAt,
        id,
      );

    return true;
  }

  getAgentCollaborationSession(id: string): AgentCollaborationSessionRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            parent_collaboration_id AS parentCollaborationId,
            requester_agent_id AS requesterAgentId,
            target_agent_id AS targetAgentId,
            initiator_kind AS initiatorKind,
            initiator_ref AS initiatorRef,
            purpose,
            objective,
            normalized_objective AS normalizedObjective,
            context_summary AS contextSummary,
            deliverable_contract_json AS deliverableContractJson,
            constraints_json AS constraintsJson,
            status,
            visibility_mode AS visibilityMode,
            user_surface_json AS userSurfaceJson,
            budget_json AS budgetJson,
            policy_decision_json AS policyDecisionJson,
            result_summary AS resultSummary,
            error,
            created_at AS createdAt,
            updated_at AS updatedAt,
            expires_at AS expiresAt
          FROM agent_collaboration_sessions
          WHERE id = ?
        `,
      )
      .get(id) as AgentCollaborationSessionRow | undefined;

    return row ? mapAgentCollaborationSessionRow(row) : null;
  }

  findRecentAgentCollaborationSession(input: {
    requesterAgentId: string;
    targetAgentId: string;
    purpose: string;
    normalizedObjective: string;
    sinceUtc: string;
  }): AgentCollaborationSessionRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            parent_collaboration_id AS parentCollaborationId,
            requester_agent_id AS requesterAgentId,
            target_agent_id AS targetAgentId,
            initiator_kind AS initiatorKind,
            initiator_ref AS initiatorRef,
            purpose,
            objective,
            normalized_objective AS normalizedObjective,
            context_summary AS contextSummary,
            deliverable_contract_json AS deliverableContractJson,
            constraints_json AS constraintsJson,
            status,
            visibility_mode AS visibilityMode,
            user_surface_json AS userSurfaceJson,
            budget_json AS budgetJson,
            policy_decision_json AS policyDecisionJson,
            result_summary AS resultSummary,
            error,
            created_at AS createdAt,
            updated_at AS updatedAt,
            expires_at AS expiresAt
          FROM agent_collaboration_sessions
          WHERE requester_agent_id = ?
            AND target_agent_id = ?
            AND purpose = ?
            AND normalized_objective = ?
            AND created_at >= ?
          ORDER BY created_at DESC
          LIMIT 1
        `,
      )
      .get(
        input.requesterAgentId,
        input.targetAgentId,
        input.purpose,
        input.normalizedObjective,
        toSqliteDateTime(new Date(input.sinceUtc)),
      ) as AgentCollaborationSessionRow | undefined;

    return row ? mapAgentCollaborationSessionRow(row) : null;
  }

  findActiveInboundAgentCollaborationSession(input: {
    targetAgentId: string;
    nowUtc: string;
  }): AgentCollaborationSessionRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            parent_collaboration_id AS parentCollaborationId,
            requester_agent_id AS requesterAgentId,
            target_agent_id AS targetAgentId,
            initiator_kind AS initiatorKind,
            initiator_ref AS initiatorRef,
            purpose,
            objective,
            normalized_objective AS normalizedObjective,
            context_summary AS contextSummary,
            deliverable_contract_json AS deliverableContractJson,
            constraints_json AS constraintsJson,
            status,
            visibility_mode AS visibilityMode,
            user_surface_json AS userSurfaceJson,
            budget_json AS budgetJson,
            policy_decision_json AS policyDecisionJson,
            result_summary AS resultSummary,
            error,
            created_at AS createdAt,
            updated_at AS updatedAt,
            expires_at AS expiresAt
          FROM agent_collaboration_sessions
          WHERE target_agent_id = ?
            AND status IN ('running', 'waiting_on_user')
            AND (expires_at IS NULL OR datetime(expires_at) >= datetime(?))
          ORDER BY created_at DESC
          LIMIT 1
        `,
      )
      .get(input.targetAgentId, toSqliteDateTime(new Date(input.nowUtc))) as AgentCollaborationSessionRow | undefined;

    return row ? mapAgentCollaborationSessionRow(row) : null;
  }

  insertAgentCollaborationTurn(input: AgentCollaborationTurnInsertInput): string {
    const id = input.id?.trim() || randomUUID();
    this.db
      .prepare(
        `
          INSERT INTO agent_collaboration_turns (
            id,
            collaboration_id,
            turn_index,
            sender_agent_id,
            recipient_agent_id,
            turn_type,
            content,
            structured_json,
            model_run_id,
            visible_message_ref
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        id,
        input.collaborationId,
        input.turnIndex,
        input.senderAgentId,
        input.recipientAgentId,
        input.turnType,
        input.content,
        toJsonOrNull(input.structured),
        input.modelRunId ?? null,
        input.visibleMessageRef ?? null,
      );

    return id;
  }

  listAgentCollaborationTurns(collaborationId: string): AgentCollaborationTurnRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            collaboration_id AS collaborationId,
            turn_index AS turnIndex,
            sender_agent_id AS senderAgentId,
            recipient_agent_id AS recipientAgentId,
            turn_type AS turnType,
            content,
            structured_json AS structuredJson,
            model_run_id AS modelRunId,
            visible_message_ref AS visibleMessageRef,
            created_at AS createdAt
          FROM agent_collaboration_turns
          WHERE collaboration_id = ?
          ORDER BY turn_index ASC, created_at ASC
        `,
      )
      .all(collaborationId) as AgentCollaborationTurnRow[];

    return rows.map(mapAgentCollaborationTurnRow);
  }

  insertAgentCollaborationDelivery(input: AgentCollaborationDeliveryInsertInput): string {
    const id = input.id?.trim() || randomUUID();
    this.db
      .prepare(
        `
          INSERT INTO agent_collaboration_deliveries (
            id,
            collaboration_id,
            event_kind,
            destination_channel_id,
            destination_thread_id,
            discord_message_id,
            status,
            error
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        id,
        input.collaborationId,
        input.eventKind,
        input.destinationChannelId ?? null,
        input.destinationThreadId ?? null,
        input.discordMessageId ?? null,
        input.status,
        input.error ?? null,
      );
    return id;
  }

  listAgentCollaborationDeliveries(collaborationId: string): AgentCollaborationDeliveryRecord[] {
    return this.db
      .prepare(
        `
          SELECT
            id,
            collaboration_id AS collaborationId,
            event_kind AS eventKind,
            destination_channel_id AS destinationChannelId,
            destination_thread_id AS destinationThreadId,
            discord_message_id AS discordMessageId,
            status,
            error,
            created_at AS createdAt
          FROM agent_collaboration_deliveries
          WHERE collaboration_id = ?
          ORDER BY created_at ASC, id ASC
        `,
      )
      .all(collaborationId) as unknown as AgentCollaborationDeliveryRecord[];
  }

  upsertActiveTask(input: ActiveTaskUpsertInput): string {
    const id = input.id?.trim() || randomUUID();
    this.db
      .prepare(
        `
          INSERT INTO active_tasks (
            id,
            session_id,
            agent_id,
            status,
            title,
            objective,
            owner_worker_id,
            intent_ids,
            missing_slots,
            clarification_question,
            suggested_next_action,
            structured_context_json,
            source_kind,
            created_by_message_id,
            updated_by_message_id,
            resolved_at,
            expires_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            title = excluded.title,
            objective = excluded.objective,
            owner_worker_id = excluded.owner_worker_id,
            intent_ids = excluded.intent_ids,
            missing_slots = excluded.missing_slots,
            clarification_question = excluded.clarification_question,
            suggested_next_action = excluded.suggested_next_action,
            structured_context_json = excluded.structured_context_json,
            source_kind = excluded.source_kind,
            updated_by_message_id = excluded.updated_by_message_id,
            resolved_at = excluded.resolved_at,
            expires_at = excluded.expires_at,
            updated_at = datetime('now')
        `,
      )
      .run(
        id,
        input.sessionId,
        input.agentId,
        input.status,
        input.title,
        input.objective,
        input.ownerWorkerId ?? null,
        JSON.stringify(input.intentIds ?? []),
        JSON.stringify(input.missingSlots ?? []),
        input.clarificationQuestion ?? null,
        input.suggestedNextAction ?? null,
        toJsonOrNull(input.structuredContext),
        input.sourceKind ?? "assistant-offer",
        input.createdByMessageId ?? null,
        input.updatedByMessageId ?? null,
        input.resolvedAt ?? null,
        input.expiresAt ?? null,
      );

    return id;
  }

  updateActiveTaskStatus(input: ActiveTaskStatusUpdateInput): boolean {
    const result = this.db
      .prepare(
        `
          UPDATE active_tasks
          SET
            status = ?,
            updated_by_message_id = COALESCE(?, updated_by_message_id),
            structured_context_json = COALESCE(?, structured_context_json),
            missing_slots = COALESCE(?, missing_slots),
            clarification_question = COALESCE(?, clarification_question),
            suggested_next_action = COALESCE(?, suggested_next_action),
            resolved_at = ?,
            expires_at = COALESCE(?, expires_at),
            updated_at = datetime('now')
          WHERE id = ?
        `,
      )
      .run(
        input.status,
        input.updatedByMessageId ?? null,
        input.structuredContext === undefined ? null : toJsonOrNull(input.structuredContext),
        input.missingSlots === undefined ? null : JSON.stringify(input.missingSlots),
        input.clarificationQuestion === undefined ? null : input.clarificationQuestion,
        input.suggestedNextAction === undefined ? null : input.suggestedNextAction,
        input.resolvedAt ?? (
          input.status === "completed" ||
          input.status === "canceled" ||
          input.status === "superseded" ||
          input.status === "expired"
            ? new Date().toISOString()
            : null
        ),
        input.expiresAt ?? null,
        input.id,
      );

    return toSafeNumber(result.changes) > 0;
  }

  getActiveTask(id: string): ActiveTaskRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            status,
            title,
            objective,
            owner_worker_id AS ownerWorkerId,
            intent_ids AS intentIdsJson,
            missing_slots AS missingSlotsJson,
            clarification_question AS clarificationQuestion,
            suggested_next_action AS suggestedNextAction,
            structured_context_json AS structuredContextJson,
            source_kind AS sourceKind,
            created_by_message_id AS createdByMessageId,
            updated_by_message_id AS updatedByMessageId,
            created_at AS createdAt,
            updated_at AS updatedAt,
            resolved_at AS resolvedAt,
            expires_at AS expiresAt
          FROM active_tasks
          WHERE id = ?
        `,
      )
      .get(id) as
      | (Omit<ActiveTaskRecord, "intentIds" | "missingSlots" | "structuredContext"> & {
          intentIdsJson: string | null;
          missingSlotsJson: string | null;
          structuredContextJson: string | null;
        })
      | undefined;

    return row ? mapActiveTaskRow(row) : null;
  }

  listActiveTasks(options: ListActiveTasksOptions): ActiveTaskRecord[] {
    const resolvedLimit = Number.isFinite(options.limit) ? Math.max(options.limit ?? 20, 1) : 20;
    const sourceChannelId = options.sourceChannelId?.trim() || null;
    const scopeClause = sourceChannelId
      ? `EXISTS (
          SELECT 1 FROM messages AS source
          WHERE source.id = COALESCE(active_tasks.updated_by_message_id, active_tasks.created_by_message_id)
            AND source.discord_channel_id = ?
            AND source.visibility = 'public'
            AND source.agent_id = active_tasks.agent_id
        )`
      : "session_id = ?";
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            status,
            title,
            objective,
            owner_worker_id AS ownerWorkerId,
            intent_ids AS intentIdsJson,
            missing_slots AS missingSlotsJson,
            clarification_question AS clarificationQuestion,
            suggested_next_action AS suggestedNextAction,
            structured_context_json AS structuredContextJson,
            source_kind AS sourceKind,
            created_by_message_id AS createdByMessageId,
            updated_by_message_id AS updatedByMessageId,
            created_at AS createdAt,
            updated_at AS updatedAt,
            resolved_at AS resolvedAt,
            expires_at AS expiresAt
          FROM active_tasks
          WHERE ${scopeClause}
            AND agent_id = ?
            AND (
              ? = 1 OR status IN ('proposed', 'awaiting_user', 'ready', 'running', 'blocked')
            )
            AND (
              ? = 1 OR expires_at IS NULL OR expires_at > datetime('now')
            )
          ORDER BY updated_at DESC, created_at DESC
          LIMIT ?
        `,
      )
      .all(
        sourceChannelId ?? options.sessionId,
        options.agentId,
        options.includeResolved ? 1 : 0,
        options.includeResolved ? 1 : 0,
        resolvedLimit,
      ) as Array<
      Omit<ActiveTaskRecord, "intentIds" | "missingSlots" | "structuredContext"> & {
        intentIdsJson: string | null;
        missingSlotsJson: string | null;
        structuredContextJson: string | null;
      }
    >;

    return rows.map((row) => mapActiveTaskRow(row));
  }

  listSubAgentRunsForConversation(conversationKey: string, limit = 100): SubAgentRunRecord[] {
    const resolvedLimit = Number.isFinite(limit) ? Math.max(Math.trunc(limit), 1) : 100;
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            batch_id AS batchId,
            parent_session_id AS parentSessionId,
            parent_agent_id AS parentAgentId,
            conversation_key AS conversationKey,
            coordinator_worker_id AS coordinatorWorkerId,
            round_index AS roundIndex,
            sub_task_id AS subTaskId,
            provider_name AS providerName,
            model,
            reasoning_effort AS reasoningEffort,
            tool_ids AS toolIdsJson,
            dependency_ids AS dependencyIdsJson,
            status,
            duration_ms AS durationMs,
            cost_estimate_usd AS costEstimateUsd,
            error,
            output_text AS outputText,
            tool_calls_json AS toolCallsJson,
            metadata_json AS metadataJson,
            created_at AS createdAt
          FROM sub_agent_runs
          WHERE conversation_key = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `,
      )
      .all(conversationKey, resolvedLimit) as Array<{
        id: string;
        batchId: string;
        parentSessionId: string | null;
        parentAgentId: string | null;
        conversationKey: string | null;
        coordinatorWorkerId: string;
        roundIndex: number;
        subTaskId: string;
        providerName: string | null;
        model: string | null;
        reasoningEffort: string | null;
        toolIdsJson: string | null;
        dependencyIdsJson: string | null;
        status: SubAgentStatus;
        durationMs: number;
        costEstimateUsd: number | null;
        error: string | null;
        outputText: string | null;
        toolCallsJson: string | null;
        metadataJson: string | null;
        createdAt: string;
      }>;

    return rows.map((row) => ({
      id: row.id,
      batchId: row.batchId,
      parentSessionId: row.parentSessionId,
      parentAgentId: row.parentAgentId,
      conversationKey: row.conversationKey,
      coordinatorWorkerId: row.coordinatorWorkerId,
      roundIndex: row.roundIndex,
      subTaskId: row.subTaskId,
      providerName: row.providerName,
      model: row.model,
      reasoningEffort: row.reasoningEffort,
      toolIds: parseJsonArray(row.toolIdsJson),
      dependencyIds: parseJsonArray(row.dependencyIdsJson),
      status: row.status,
      durationMs: row.durationMs,
      costEstimateUsd: row.costEstimateUsd,
      error: row.error,
      outputText: row.outputText,
      toolCallsJson: parseJsonValue(row.toolCallsJson),
      metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
      createdAt: row.createdAt,
    }));
  }

  expireStaleActiveTasks(): number {
    const result = this.db
      .prepare(
        `
          UPDATE active_tasks
          SET
            status = 'expired',
            resolved_at = COALESCE(resolved_at, datetime('now')),
            updated_at = datetime('now')
          WHERE status IN ('proposed', 'awaiting_user', 'ready', 'running', 'blocked')
            AND expires_at IS NOT NULL
            AND expires_at <= datetime('now')
        `,
      )
      .run();

    return toSafeNumber(result.changes);
  }

  getDeterministicTurn(id: string): DeterministicTurnRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            conversation_key AS conversationKey,
            initiating_principal_id AS initiatingPrincipalId,
            lead_agent_principal_id AS leadAgentPrincipalId,
            project_id AS projectId,
            topic_id AS topicId,
            intent_count AS intentCount,
            intent_ids AS intentIdsJson,
            intent_json AS intentJson,
            intent_model_run_id AS intentModelRunId,
            route_outcome AS routeOutcome,
            fallback_reason AS fallbackReason,
            execution_plan_json AS executionPlanJson,
            step_count AS stepCount,
            completed_step_count AS completedStepCount,
            failed_step_count AS failedStepCount,
            has_write_operations AS hasWriteOperations,
            worker_ids AS workerIdsJson,
            delegation_chain AS delegationChainJson,
            receipts_json AS receiptsJson,
            narration_provider AS narrationProvider,
            narration_model AS narrationModel,
            narration_latency_ms AS narrationLatencyMs,
            narration_retried AS narrationRetried,
            narration_model_run_id AS narrationModelRunId,
            intent_latency_ms AS intentLatencyMs,
            route_latency_ms AS routeLatencyMs,
            execution_latency_ms AS executionLatencyMs,
            total_latency_ms AS totalLatencyMs,
            request_message_id AS requestMessageId,
            response_message_id AS responseMessageId,
            created_at AS createdAt
          FROM deterministic_turns
          WHERE id = ?
        `
      )
      .get(id) as
      | {
          id: string;
          sessionId: string;
          agentId: string;
          conversationKey: string;
          initiatingPrincipalId: string;
          leadAgentPrincipalId: string;
          projectId: string | null;
          topicId: string | null;
          intentCount: number;
          intentIdsJson: string | null;
          intentJson: string;
          intentModelRunId: number | null;
          routeOutcome: DeterministicRouteOutcome;
          fallbackReason: string | null;
          executionPlanJson: string | null;
          stepCount: number;
          completedStepCount: number;
          failedStepCount: number;
          hasWriteOperations: number;
          workerIdsJson: string | null;
          delegationChainJson: string | null;
          receiptsJson: string | null;
          narrationProvider: string | null;
          narrationModel: string | null;
          narrationLatencyMs: number | null;
          narrationRetried: number;
          narrationModelRunId: number | null;
          intentLatencyMs: number | null;
          routeLatencyMs: number | null;
          executionLatencyMs: number | null;
          totalLatencyMs: number | null;
          requestMessageId: number | null;
          responseMessageId: number | null;
          createdAt: string;
        }
      | undefined;

    if (!row) return null;

    return {
      id: row.id,
      sessionId: row.sessionId,
      agentId: row.agentId,
      conversationKey: row.conversationKey,
      initiatingPrincipalId: row.initiatingPrincipalId,
      leadAgentPrincipalId: row.leadAgentPrincipalId,
      projectId: row.projectId,
      topicId: row.topicId,
      intentCount: row.intentCount,
      intentIds: parseJsonArray(row.intentIdsJson),
      intentJson: parseJsonValue(row.intentJson),
      intentModelRunId: row.intentModelRunId,
      routeOutcome: row.routeOutcome,
      fallbackReason: row.fallbackReason,
      executionPlanJson: parseJsonValue(row.executionPlanJson),
      stepCount: row.stepCount,
      completedStepCount: row.completedStepCount,
      failedStepCount: row.failedStepCount,
      hasWriteOperations: row.hasWriteOperations === 1,
      workerIds: parseJsonArray(row.workerIdsJson),
      delegationChain: parseJsonArray(row.delegationChainJson),
      receiptsJson: parseJsonValue(row.receiptsJson),
      narrationProvider: row.narrationProvider,
      narrationModel: row.narrationModel,
      narrationLatencyMs: row.narrationLatencyMs,
      narrationRetried: row.narrationRetried === 1,
      narrationModelRunId: row.narrationModelRunId,
      intentLatencyMs: row.intentLatencyMs,
      routeLatencyMs: row.routeLatencyMs,
      executionLatencyMs: row.executionLatencyMs,
      totalLatencyMs: row.totalLatencyMs,
      requestMessageId: row.requestMessageId,
      responseMessageId: row.responseMessageId,
      createdAt: row.createdAt,
    };
  }

  getLatestDeterministicTurnForConversation(conversationKey: string): DeterministicTurnRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            conversation_key AS conversationKey,
            initiating_principal_id AS initiatingPrincipalId,
            lead_agent_principal_id AS leadAgentPrincipalId,
            project_id AS projectId,
            topic_id AS topicId,
            intent_count AS intentCount,
            intent_ids AS intentIdsJson,
            intent_json AS intentJson,
            intent_model_run_id AS intentModelRunId,
            route_outcome AS routeOutcome,
            fallback_reason AS fallbackReason,
            execution_plan_json AS executionPlanJson,
            step_count AS stepCount,
            completed_step_count AS completedStepCount,
            failed_step_count AS failedStepCount,
            has_write_operations AS hasWriteOperations,
            worker_ids AS workerIdsJson,
            delegation_chain AS delegationChainJson,
            receipts_json AS receiptsJson,
            narration_provider AS narrationProvider,
            narration_model AS narrationModel,
            narration_latency_ms AS narrationLatencyMs,
            narration_retried AS narrationRetried,
            narration_model_run_id AS narrationModelRunId,
            intent_latency_ms AS intentLatencyMs,
            route_latency_ms AS routeLatencyMs,
            execution_latency_ms AS executionLatencyMs,
            total_latency_ms AS totalLatencyMs,
            request_message_id AS requestMessageId,
            response_message_id AS responseMessageId,
            created_at AS createdAt
          FROM deterministic_turns
          WHERE conversation_key = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1
        `,
      )
      .get(conversationKey) as
      | {
          id: string;
          sessionId: string;
          agentId: string;
          conversationKey: string;
          initiatingPrincipalId: string;
          leadAgentPrincipalId: string;
          projectId: string | null;
          topicId: string | null;
          intentCount: number;
          intentIdsJson: string | null;
          intentJson: string;
          intentModelRunId: number | null;
          routeOutcome: DeterministicRouteOutcome;
          fallbackReason: string | null;
          executionPlanJson: string | null;
          stepCount: number;
          completedStepCount: number;
          failedStepCount: number;
          hasWriteOperations: number;
          workerIdsJson: string | null;
          delegationChainJson: string | null;
          receiptsJson: string | null;
          narrationProvider: string | null;
          narrationModel: string | null;
          narrationLatencyMs: number | null;
          narrationRetried: number;
          narrationModelRunId: number | null;
          intentLatencyMs: number | null;
          routeLatencyMs: number | null;
          executionLatencyMs: number | null;
          totalLatencyMs: number | null;
          requestMessageId: number | null;
          responseMessageId: number | null;
          createdAt: string;
        }
      | undefined;

    if (!row) return null;

    return {
      id: row.id,
      sessionId: row.sessionId,
      agentId: row.agentId,
      conversationKey: row.conversationKey,
      initiatingPrincipalId: row.initiatingPrincipalId,
      leadAgentPrincipalId: row.leadAgentPrincipalId,
      projectId: row.projectId,
      topicId: row.topicId,
      intentCount: row.intentCount,
      intentIds: parseJsonArray(row.intentIdsJson),
      intentJson: parseJsonValue(row.intentJson),
      intentModelRunId: row.intentModelRunId,
      routeOutcome: row.routeOutcome,
      fallbackReason: row.fallbackReason,
      executionPlanJson: parseJsonValue(row.executionPlanJson),
      stepCount: row.stepCount,
      completedStepCount: row.completedStepCount,
      failedStepCount: row.failedStepCount,
      hasWriteOperations: row.hasWriteOperations === 1,
      workerIds: parseJsonArray(row.workerIdsJson),
      delegationChain: parseJsonArray(row.delegationChainJson),
      receiptsJson: parseJsonValue(row.receiptsJson),
      narrationProvider: row.narrationProvider,
      narrationModel: row.narrationModel,
      narrationLatencyMs: row.narrationLatencyMs,
      narrationRetried: row.narrationRetried === 1,
      narrationModelRunId: row.narrationModelRunId,
      intentLatencyMs: row.intentLatencyMs,
      routeLatencyMs: row.routeLatencyMs,
      executionLatencyMs: row.executionLatencyMs,
      totalLatencyMs: row.totalLatencyMs,
      requestMessageId: row.requestMessageId,
      responseMessageId: row.responseMessageId,
      createdAt: row.createdAt,
    };
  }

  insertPromptSnapshot(input: PromptSnapshotInsertInput): number {
    this.deleteExpiredPromptSnapshots();

    const metadataJson = toJsonOrNull(input.metadata);
    const result = this.db
      .prepare(
        `
          INSERT INTO prompt_snapshots (
            model_run_id,
            session_id,
            agent_id,
            provider_name,
            request_message_id,
            response_message_id,
            prompt_text,
            system_prompt,
            warm_start_prompt,
            metadata_json,
            created_at,
            expires_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now', '+72 hours')))
          ON CONFLICT(model_run_id) DO UPDATE SET
            session_id = excluded.session_id,
            agent_id = excluded.agent_id,
            provider_name = excluded.provider_name,
            request_message_id = excluded.request_message_id,
            response_message_id = excluded.response_message_id,
            prompt_text = excluded.prompt_text,
            system_prompt = excluded.system_prompt,
            warm_start_prompt = excluded.warm_start_prompt,
            metadata_json = excluded.metadata_json,
            created_at = excluded.created_at,
            expires_at = excluded.expires_at
        `
      )
      .run(
        input.modelRunId,
        input.sessionId,
        input.agentId,
        input.providerName,
        input.requestMessageId ?? null,
        input.responseMessageId ?? null,
        input.promptText,
        input.systemPrompt ?? null,
        input.warmStartPrompt ?? null,
        metadataJson,
        input.createdAt ?? null,
        input.expiresAt ?? null
      );

    const rowId = result.lastInsertRowid;
    return typeof rowId === "bigint" ? Number(rowId) : rowId;
  }

  getPromptSnapshotByModelRunId(modelRunId: number): PromptSnapshotRecord | null {
    this.deleteExpiredPromptSnapshots();

    const row = this.db
      .prepare(
        `
          SELECT
            id,
            model_run_id AS modelRunId,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            request_message_id AS requestMessageId,
            response_message_id AS responseMessageId,
            prompt_text AS promptText,
            system_prompt AS systemPrompt,
            warm_start_prompt AS warmStartPrompt,
            metadata_json AS metadataJson,
            created_at AS createdAt,
            expires_at AS expiresAt
          FROM prompt_snapshots
          WHERE model_run_id = ?
        `
      )
      .get(modelRunId) as
      | (Omit<PromptSnapshotRecord, "metadata"> & { metadataJson: string | null })
      | undefined;

    return row ? toPromptSnapshotRecord(row) : null;
  }

  findPromptSnapshotByRequestMessageId(messageId: number): PromptSnapshotRecord | null {
    this.deleteExpiredPromptSnapshots();

    const row = this.db
      .prepare(
        `
          SELECT
            id,
            model_run_id AS modelRunId,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            request_message_id AS requestMessageId,
            response_message_id AS responseMessageId,
            prompt_text AS promptText,
            system_prompt AS systemPrompt,
            warm_start_prompt AS warmStartPrompt,
            metadata_json AS metadataJson,
            created_at AS createdAt,
            expires_at AS expiresAt
          FROM prompt_snapshots
          WHERE request_message_id = ?
          ORDER BY id DESC
          LIMIT 1
        `
      )
      .get(messageId) as
      | (Omit<PromptSnapshotRecord, "metadata"> & { metadataJson: string | null })
      | undefined;

    return row ? toPromptSnapshotRecord(row) : null;
  }

  findPromptSnapshotByResponseMessageId(messageId: number): PromptSnapshotRecord | null {
    this.deleteExpiredPromptSnapshots();

    const row = this.db
      .prepare(
        `
          SELECT
            id,
            model_run_id AS modelRunId,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            request_message_id AS requestMessageId,
            response_message_id AS responseMessageId,
            prompt_text AS promptText,
            system_prompt AS systemPrompt,
            warm_start_prompt AS warmStartPrompt,
            metadata_json AS metadataJson,
            created_at AS createdAt,
            expires_at AS expiresAt
          FROM prompt_snapshots
          WHERE response_message_id = ?
          ORDER BY id DESC
          LIMIT 1
        `
      )
      .get(messageId) as
      | (Omit<PromptSnapshotRecord, "metadata"> & { metadataJson: string | null })
      | undefined;

    return row ? toPromptSnapshotRecord(row) : null;
  }

  findPromptSnapshotByMessageId(messageId: number): PromptSnapshotRecord | null {
    return (
      this.findPromptSnapshotByRequestMessageId(messageId) ??
      this.findPromptSnapshotByResponseMessageId(messageId)
    );
  }

  listRecentPromptSnapshots(options: ListRecentPromptSnapshotsOptions = {}): PromptSnapshotRecord[] {
    this.deleteExpiredPromptSnapshots();

    const conditions: string[] = [];
    const values: Array<string | number> = [];

    if (options.since && options.since.trim().length > 0) {
      conditions.push("datetime(created_at) >= datetime(?)");
      values.push(options.since);
    }

    if (options.sessionId && options.sessionId.trim().length > 0) {
      conditions.push("session_id = ?");
      values.push(options.sessionId);
    }

    if (options.agentId && options.agentId.trim().length > 0) {
      conditions.push("agent_id = ?");
      values.push(options.agentId);
    }

    const resolvedLimit = Number.isFinite(options.limit) ? Math.max(options.limit ?? 20, 1) : 20;
    values.push(resolvedLimit);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            model_run_id AS modelRunId,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            request_message_id AS requestMessageId,
            response_message_id AS responseMessageId,
            prompt_text AS promptText,
            system_prompt AS systemPrompt,
            warm_start_prompt AS warmStartPrompt,
            metadata_json AS metadataJson,
            created_at AS createdAt,
            expires_at AS expiresAt
          FROM prompt_snapshots
          ${whereClause}
          ORDER BY datetime(created_at) DESC, id DESC
          LIMIT ?
        `
      )
      .all(...values) as Array<
      Omit<PromptSnapshotRecord, "metadata"> & { metadataJson: string | null }
    >;

    return rows.map((row) => toPromptSnapshotRecord(row));
  }

  listPromptSnapshotsForSession(sessionId: string, limit = 20): PromptSnapshotRecord[] {
    this.deleteExpiredPromptSnapshots();

    const resolvedLimit = Number.isFinite(limit) ? Math.max(limit, 1) : 20;
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            model_run_id AS modelRunId,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            request_message_id AS requestMessageId,
            response_message_id AS responseMessageId,
            prompt_text AS promptText,
            system_prompt AS systemPrompt,
            warm_start_prompt AS warmStartPrompt,
            metadata_json AS metadataJson,
            created_at AS createdAt,
            expires_at AS expiresAt
          FROM prompt_snapshots
          WHERE session_id = ?
          ORDER BY id DESC
          LIMIT ?
        `
      )
      .all(sessionId, resolvedLimit) as Array<
      Omit<PromptSnapshotRecord, "metadata"> & { metadataJson: string | null }
    >;

    return rows.map((row) => toPromptSnapshotRecord(row));
  }

  deleteExpiredPromptSnapshots(referenceTime?: string): number {
    const result = referenceTime && referenceTime.trim().length > 0
      ? this.db
          .prepare(
            `
              DELETE FROM prompt_snapshots
              WHERE datetime(expires_at) <= datetime(?)
            `
          )
          .run(referenceTime)
      : this.db
          .prepare(
            `
              DELETE FROM prompt_snapshots
              WHERE datetime(expires_at) <= datetime('now')
            `
          )
          .run();

    return toSafeNumber(result.changes);
  }

  insertDeadLetter(input: DeadLetterInsertInput): number {
    const metadataJson = toJsonOrNull(input.metadata);

    const result = this.db
      .prepare(
        `
          INSERT INTO dead_letters (
            session_id,
            agent_id,
            provider_name,
            conversation_key,
            provider_session_id,
            request_message_id,
            discord_channel_id,
            discord_user_id,
            discord_username,
            prompt_text,
            system_prompt,
            response_mode,
            failure_count,
            last_error_message,
            metadata_json,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `
      )
      .run(
        input.sessionId,
        input.agentId,
        input.providerName,
        input.conversationKey,
        input.providerSessionId ?? null,
        input.requestMessageId ?? null,
        input.discordChannelId ?? null,
        input.discordUserId ?? null,
        input.discordUsername ?? null,
        input.promptText,
        input.systemPrompt ?? null,
        input.responseMode ?? null,
        input.failureCount ?? 1,
        input.lastErrorMessage,
        metadataJson
      );

    const rowId = result.lastInsertRowid;
    return typeof rowId === "bigint" ? Number(rowId) : rowId;
  }

  getDeadLetter(id: number): DeadLetterRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            conversation_key AS conversationKey,
            provider_session_id AS providerSessionId,
            request_message_id AS requestMessageId,
            discord_channel_id AS discordChannelId,
            discord_user_id AS discordUserId,
            discord_username AS discordUsername,
            prompt_text AS promptText,
            system_prompt AS systemPrompt,
            response_mode AS responseMode,
            failure_count AS failureCount,
            replay_count AS replayCount,
            last_error_message AS lastErrorMessage,
            status,
            metadata_json AS metadataJson,
            resolved_message_id AS resolvedMessageId,
            resolved_model_run_id AS resolvedModelRunId,
            created_at AS createdAt,
            updated_at AS updatedAt,
            resolved_at AS resolvedAt
          FROM dead_letters
          WHERE id = ?
        `
      )
      .get(id) as
      | (Omit<DeadLetterRecord, "metadata"> & {
          metadataJson: string | null;
        })
      | undefined;

    if (!row) return null;

    return {
      id: row.id,
      sessionId: row.sessionId,
      agentId: row.agentId,
      providerName: row.providerName,
      conversationKey: row.conversationKey,
      providerSessionId: row.providerSessionId,
      requestMessageId: row.requestMessageId,
      discordChannelId: row.discordChannelId,
      discordUserId: row.discordUserId,
      discordUsername: row.discordUsername,
      promptText: row.promptText,
      systemPrompt: row.systemPrompt,
      responseMode: row.responseMode,
      failureCount: row.failureCount,
      replayCount: row.replayCount,
      lastErrorMessage: row.lastErrorMessage,
      status: row.status,
      metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
      resolvedMessageId: row.resolvedMessageId,
      resolvedModelRunId: row.resolvedModelRunId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      resolvedAt: row.resolvedAt
    };
  }

  listDeadLetters(options: DeadLetterListOptions = {}): DeadLetterRecord[] {
    const status = options.status ?? "pending";
    const limit = Number.isFinite(options.limit) ? Math.max(options.limit ?? 100, 1) : 100;
    const sessionId = options.sessionId;

    const queryByStatusAndSession = `
      SELECT
        id,
        session_id AS sessionId,
        agent_id AS agentId,
        provider_name AS providerName,
        conversation_key AS conversationKey,
        provider_session_id AS providerSessionId,
        request_message_id AS requestMessageId,
        discord_channel_id AS discordChannelId,
        discord_user_id AS discordUserId,
        discord_username AS discordUsername,
        prompt_text AS promptText,
        system_prompt AS systemPrompt,
        response_mode AS responseMode,
        failure_count AS failureCount,
        replay_count AS replayCount,
        last_error_message AS lastErrorMessage,
        status,
        metadata_json AS metadataJson,
        resolved_message_id AS resolvedMessageId,
        resolved_model_run_id AS resolvedModelRunId,
        created_at AS createdAt,
        updated_at AS updatedAt,
        resolved_at AS resolvedAt
      FROM dead_letters
      WHERE status = ? AND session_id = ?
      ORDER BY id DESC
      LIMIT ?
    `;

    const queryByStatus = `
      SELECT
        id,
        session_id AS sessionId,
        agent_id AS agentId,
        provider_name AS providerName,
        conversation_key AS conversationKey,
        provider_session_id AS providerSessionId,
        request_message_id AS requestMessageId,
        discord_channel_id AS discordChannelId,
        discord_user_id AS discordUserId,
        discord_username AS discordUsername,
        prompt_text AS promptText,
        system_prompt AS systemPrompt,
        response_mode AS responseMode,
        failure_count AS failureCount,
        replay_count AS replayCount,
        last_error_message AS lastErrorMessage,
        status,
        metadata_json AS metadataJson,
        resolved_message_id AS resolvedMessageId,
        resolved_model_run_id AS resolvedModelRunId,
        created_at AS createdAt,
        updated_at AS updatedAt,
        resolved_at AS resolvedAt
      FROM dead_letters
      WHERE status = ?
      ORDER BY id DESC
      LIMIT ?
    `;

    const queryBySession = `
      SELECT
        id,
        session_id AS sessionId,
        agent_id AS agentId,
        provider_name AS providerName,
        conversation_key AS conversationKey,
        provider_session_id AS providerSessionId,
        request_message_id AS requestMessageId,
        discord_channel_id AS discordChannelId,
        discord_user_id AS discordUserId,
        discord_username AS discordUsername,
        prompt_text AS promptText,
        system_prompt AS systemPrompt,
        response_mode AS responseMode,
        failure_count AS failureCount,
        replay_count AS replayCount,
        last_error_message AS lastErrorMessage,
        status,
        metadata_json AS metadataJson,
        resolved_message_id AS resolvedMessageId,
        resolved_model_run_id AS resolvedModelRunId,
        created_at AS createdAt,
        updated_at AS updatedAt,
        resolved_at AS resolvedAt
      FROM dead_letters
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT ?
    `;

    const queryAll = `
      SELECT
        id,
        session_id AS sessionId,
        agent_id AS agentId,
        provider_name AS providerName,
        conversation_key AS conversationKey,
        provider_session_id AS providerSessionId,
        request_message_id AS requestMessageId,
        discord_channel_id AS discordChannelId,
        discord_user_id AS discordUserId,
        discord_username AS discordUsername,
        prompt_text AS promptText,
        system_prompt AS systemPrompt,
        response_mode AS responseMode,
        failure_count AS failureCount,
        replay_count AS replayCount,
        last_error_message AS lastErrorMessage,
        status,
        metadata_json AS metadataJson,
        resolved_message_id AS resolvedMessageId,
        resolved_model_run_id AS resolvedModelRunId,
        created_at AS createdAt,
        updated_at AS updatedAt,
        resolved_at AS resolvedAt
      FROM dead_letters
      ORDER BY id DESC
      LIMIT ?
    `;

    const rows =
      status === "all"
        ? sessionId
          ? (this.db.prepare(queryBySession).all(sessionId, limit) as Array<
              Omit<DeadLetterRecord, "metadata"> & { metadataJson: string | null }
            >)
          : (this.db.prepare(queryAll).all(limit) as Array<
              Omit<DeadLetterRecord, "metadata"> & { metadataJson: string | null }
            >)
        : sessionId
          ? (this.db.prepare(queryByStatusAndSession).all(status, sessionId, limit) as Array<
              Omit<DeadLetterRecord, "metadata"> & { metadataJson: string | null }
            >)
          : (this.db.prepare(queryByStatus).all(status, limit) as Array<
              Omit<DeadLetterRecord, "metadata"> & { metadataJson: string | null }
            >);

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      agentId: row.agentId,
      providerName: row.providerName,
      conversationKey: row.conversationKey,
      providerSessionId: row.providerSessionId,
      requestMessageId: row.requestMessageId,
      discordChannelId: row.discordChannelId,
      discordUserId: row.discordUserId,
      discordUsername: row.discordUsername,
      promptText: row.promptText,
      systemPrompt: row.systemPrompt,
      responseMode: row.responseMode,
      failureCount: row.failureCount,
      replayCount: row.replayCount,
      lastErrorMessage: row.lastErrorMessage,
      status: row.status,
      metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
      resolvedMessageId: row.resolvedMessageId,
      resolvedModelRunId: row.resolvedModelRunId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      resolvedAt: row.resolvedAt
    }));
  }

  resolveDeadLetter(input: DeadLetterResolveInput): boolean {
    const metadataJson = toJsonOrNull(input.metadata);
    const result = this.db
      .prepare(
        `
          UPDATE dead_letters
          SET
            status = 'resolved',
            resolved_message_id = COALESCE(?, resolved_message_id),
            resolved_model_run_id = COALESCE(?, resolved_model_run_id),
            replay_count = replay_count + ?,
            metadata_json = COALESCE(?, metadata_json),
            resolved_at = datetime('now'),
            updated_at = datetime('now')
          WHERE id = ?
        `
      )
      .run(
        input.resolvedMessageId ?? null,
        input.resolvedModelRunId ?? null,
        input.incrementReplayCount === true ? 1 : 0,
        metadataJson,
        input.id
      );

    return toSafeNumber(result.changes) > 0;
  }

  recordDeadLetterReplayFailure(input: DeadLetterReplayFailureInput): boolean {
    const metadataJson = toJsonOrNull(input.metadata);
    const result = this.db
      .prepare(
        `
          UPDATE dead_letters
          SET
            replay_count = replay_count + 1,
            failure_count = failure_count + 1,
            last_error_message = ?,
            metadata_json = COALESCE(?, metadata_json),
            updated_at = datetime('now')
          WHERE id = ?
        `
      )
      .run(input.errorMessage, metadataJson, input.id);

    return toSafeNumber(result.changes) > 0;
  }

  claimVoiceTurnReceipt(input: {
    sessionId: string;
    agentId: string;
    utteranceId: string;
    metadata?: Record<string, unknown> | null;
  }): { created: boolean; receipt: VoiceTurnReceiptRecord } {
    const normalizedSessionId = input.sessionId.trim();
    const normalizedAgentId = input.agentId.trim();
    const normalizedUtteranceId = input.utteranceId.trim();
    if (!normalizedSessionId || !normalizedAgentId || !normalizedUtteranceId) {
      throw new Error("sessionId, agentId, and utteranceId are required.");
    }

    const metadataJson = toJsonOrNull(input.metadata);
    const turnId = randomUUID();
    const insertResult = this.db
      .prepare(
        `
          INSERT INTO voice_turn_receipts (
            turn_id,
            session_id,
            agent_id,
            utterance_id,
            status,
            metadata_json,
            updated_at
          )
          VALUES (?, ?, ?, ?, 'processing', ?, datetime('now'))
          ON CONFLICT(session_id, utterance_id) DO NOTHING
        `
      )
      .run(
        turnId,
        normalizedSessionId,
        normalizedAgentId,
        normalizedUtteranceId,
        metadataJson
      );

    const receipt = this.getVoiceTurnReceipt(normalizedSessionId, normalizedUtteranceId);
    if (!receipt) {
      throw new Error("Failed to resolve voice turn receipt.");
    }

    return {
      created: toSafeNumber(insertResult.changes) > 0,
      receipt
    };
  }

  getVoiceTurnReceipt(sessionId: string, utteranceId: string): VoiceTurnReceiptRecord | null {
    const normalizedSessionId = sessionId.trim();
    const normalizedUtteranceId = utteranceId.trim();
    if (!normalizedSessionId || !normalizedUtteranceId) {
      return null;
    }

    const row = this.db
      .prepare(
        `
          SELECT
            turn_id AS turnId,
            session_id AS sessionId,
            agent_id AS agentId,
            utterance_id AS utteranceId,
            status,
            provider_name AS providerName,
            provider_session_id AS providerSessionId,
            response_text AS responseText,
            provider_used_failover AS providerUsedFailover,
            warm_start_used AS warmStartUsed,
            request_message_id AS requestMessageId,
            response_message_id AS responseMessageId,
            model_run_id AS modelRunId,
            error_message AS errorMessage,
            metadata_json AS metadataJson,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM voice_turn_receipts
          WHERE session_id = ? AND utterance_id = ?
        `
      )
      .get(normalizedSessionId, normalizedUtteranceId) as
      | VoiceTurnReceiptRow
      | undefined;

    return row ? toVoiceTurnReceiptRecord(row) : null;
  }

  completeVoiceTurnReceipt(input: {
    turnId: string;
    providerName: string;
    providerSessionId?: string | null;
    responseText: string;
    providerUsedFailover?: boolean;
    warmStartUsed?: boolean;
    requestMessageId?: number | null;
    responseMessageId?: number | null;
    modelRunId?: number | null;
    metadata?: Record<string, unknown> | null;
  }): boolean {
    const metadataJson = toJsonOrNull(input.metadata);
    const result = this.db
      .prepare(
        `
          UPDATE voice_turn_receipts
          SET
            status = 'completed',
            provider_name = ?,
            provider_session_id = ?,
            response_text = ?,
            provider_used_failover = ?,
            warm_start_used = ?,
            request_message_id = COALESCE(?, request_message_id),
            response_message_id = COALESCE(?, response_message_id),
            model_run_id = COALESCE(?, model_run_id),
            error_message = NULL,
            metadata_json = COALESCE(?, metadata_json),
            updated_at = datetime('now')
          WHERE turn_id = ?
        `
      )
      .run(
        input.providerName,
        input.providerSessionId ?? null,
        input.responseText,
        toSqliteBoolean(input.providerUsedFailover),
        toSqliteBoolean(input.warmStartUsed),
        input.requestMessageId ?? null,
        input.responseMessageId ?? null,
        input.modelRunId ?? null,
        metadataJson,
        input.turnId
      );

    return toSafeNumber(result.changes) > 0;
  }

  failVoiceTurnReceipt(input: {
    turnId: string;
    errorMessage: string;
    requestMessageId?: number | null;
    responseMessageId?: number | null;
    modelRunId?: number | null;
    metadata?: Record<string, unknown> | null;
  }): boolean {
    const metadataJson = toJsonOrNull(input.metadata);
    const result = this.db
      .prepare(
        `
          UPDATE voice_turn_receipts
          SET
            status = 'failed',
            error_message = ?,
            request_message_id = COALESCE(?, request_message_id),
            response_message_id = COALESCE(?, response_message_id),
            model_run_id = COALESCE(?, model_run_id),
            metadata_json = COALESCE(?, metadata_json),
            updated_at = datetime('now')
          WHERE turn_id = ?
        `
      )
      .run(
        input.errorMessage,
        input.requestMessageId ?? null,
        input.responseMessageId ?? null,
        input.modelRunId ?? null,
        metadataJson,
        input.turnId
      );

    return toSafeNumber(result.changes) > 0;
  }

  getMessage(messageId: number): StoredMessageRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            direction,
            source,
            visibility,
            discord_message_id AS discordMessageId,
            discord_channel_id AS discordChannelId,
            discord_user_id AS discordUserId,
            discord_username AS discordUsername,
            content,
            metadata_json AS metadataJson,
            created_at AS createdAt
          FROM messages
          WHERE id = ?
        `
      )
      .get(messageId) as
      | (Omit<StoredMessageRecord, "metadata"> & { metadataJson: string | null })
      | undefined;

    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.sessionId,
      agentId: row.agentId,
      providerName: row.providerName,
      direction: row.direction,
      source: row.source,
      visibility: row.visibility,
      discordMessageId: row.discordMessageId,
      discordChannelId: row.discordChannelId,
      discordUserId: row.discordUserId,
      discordUsername: row.discordUsername,
      content: row.content,
      metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
      createdAt: row.createdAt
    };
  }

  getMessageByDiscordMessageId(
    discordMessageId: string,
    options?: { channelId?: string | null }
  ): StoredMessageRecord | null {
    const normalizedMessageId = discordMessageId.trim();
    if (!normalizedMessageId) return null;
    const normalizedChannelId = options?.channelId?.trim() || null;
    const row = (normalizedChannelId
      ? this.db
          .prepare(
            `
              SELECT
                id,
                session_id AS sessionId,
                agent_id AS agentId,
                provider_name AS providerName,
                direction,
                source,
                visibility,
                discord_message_id AS discordMessageId,
                discord_channel_id AS discordChannelId,
                discord_user_id AS discordUserId,
                discord_username AS discordUsername,
                content,
                metadata_json AS metadataJson,
                created_at AS createdAt
              FROM messages
              WHERE discord_message_id = ?
                AND discord_channel_id = ?
              ORDER BY id DESC
              LIMIT 1
            `
          )
          .get(normalizedMessageId, normalizedChannelId)
      : this.db
          .prepare(
            `
              SELECT
                id,
                session_id AS sessionId,
                agent_id AS agentId,
                provider_name AS providerName,
                direction,
                source,
                visibility,
                discord_message_id AS discordMessageId,
                discord_channel_id AS discordChannelId,
                discord_user_id AS discordUserId,
                discord_username AS discordUsername,
                content,
                metadata_json AS metadataJson,
                created_at AS createdAt
              FROM messages
              WHERE discord_message_id = ?
              ORDER BY id DESC
              LIMIT 1
            `
          )
          .get(normalizedMessageId)) as
      | (Omit<StoredMessageRecord, "metadata"> & { metadataJson: string | null })
      | undefined;

    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.sessionId,
      agentId: row.agentId,
      providerName: row.providerName,
      direction: row.direction,
      source: row.source,
      visibility: row.visibility,
      discordMessageId: row.discordMessageId,
      discordChannelId: row.discordChannelId,
      discordUserId: row.discordUserId,
      discordUsername: row.discordUsername,
      content: row.content,
      metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
      createdAt: row.createdAt,
    };
  }

  listRecentMessagesForDiscordChannel(channelId: string, limit = 20): StoredMessageRecord[] {
    const normalizedChannelId = channelId.trim();
    if (!normalizedChannelId) return [];
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            direction,
            source,
            visibility,
            discord_message_id AS discordMessageId,
            discord_channel_id AS discordChannelId,
            discord_user_id AS discordUserId,
            discord_username AS discordUsername,
            content,
            metadata_json AS metadataJson,
            created_at AS createdAt
          FROM messages
          WHERE discord_channel_id = ?
          ORDER BY id DESC
          LIMIT ?
        `
      )
      .all(normalizedChannelId, Math.max(1, Math.trunc(limit))) as Array<
      Omit<StoredMessageRecord, "metadata"> & { metadataJson: string | null }
    >;

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      agentId: row.agentId,
      providerName: row.providerName,
      direction: row.direction,
      source: row.source,
      visibility: row.visibility,
      discordMessageId: row.discordMessageId,
      discordChannelId: row.discordChannelId,
      discordUserId: row.discordUserId,
      discordUsername: row.discordUsername,
      content: row.content,
      metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
      createdAt: row.createdAt,
    }));
  }

  listRecoverableDiscordInboundMessages(options?: {
    minAgeMinutes?: number;
    maxAgeMinutes?: number;
    limit?: number;
  }): StoredMessageRecord[] {
    const minAgeMinutes = Math.max(0, Math.trunc(options?.minAgeMinutes ?? 2));
    const maxAgeMinutes = Math.max(1, Math.trunc(options?.maxAgeMinutes ?? 180));
    const limit = Math.max(1, Math.trunc(options?.limit ?? 50));
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            direction,
            source,
            visibility,
            discord_message_id AS discordMessageId,
            discord_channel_id AS discordChannelId,
            discord_user_id AS discordUserId,
            discord_username AS discordUsername,
            content,
            metadata_json AS metadataJson,
            created_at AS createdAt
          FROM messages
          WHERE source = 'discord'
            AND direction = 'inbound'
            AND visibility = 'public'
            AND discord_message_id IS NOT NULL
            AND discord_channel_id IS NOT NULL
            AND created_at >= datetime('now', ?)
            AND created_at <= datetime('now', ?)
            AND NOT EXISTS (
              SELECT 1
              FROM model_runs
              WHERE request_message_id = messages.id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM deterministic_turns
              WHERE request_message_id = messages.id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM dead_letters
              WHERE request_message_id = messages.id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM messages AS reply
              WHERE reply.direction = 'outbound'
                AND reply.session_id = messages.session_id
                AND COALESCE(reply.agent_id, '') = COALESCE(messages.agent_id, '')
                AND reply.id > messages.id
                AND json_extract(reply.metadata_json, '$.runtimePath') = 'victor-bridge'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM messages AS newer
              WHERE newer.id > messages.id
                AND newer.source = 'discord'
                AND newer.direction = 'inbound'
                AND newer.session_id = messages.session_id
                AND COALESCE(newer.agent_id, '') = COALESCE(messages.agent_id, '')
                AND COALESCE(newer.discord_channel_id, '') = COALESCE(messages.discord_channel_id, '')
                AND COALESCE(newer.discord_user_id, '') = COALESCE(messages.discord_user_id, '')
                AND newer.content = messages.content
                AND (
                  EXISTS (
                    SELECT 1
                    FROM model_runs
                    WHERE request_message_id = newer.id
                  )
                  OR EXISTS (
                    SELECT 1
                    FROM deterministic_turns
                    WHERE request_message_id = newer.id
                  )
                  OR EXISTS (
                    SELECT 1
                    FROM dead_letters
                    WHERE request_message_id = newer.id
                  )
                )
            )
          ORDER BY id ASC
          LIMIT ?
        `
      )
      .all(`-${maxAgeMinutes} minutes`, `-${minAgeMinutes} minutes`, limit) as Array<
      Omit<StoredMessageRecord, "metadata"> & { metadataJson: string | null }
    >;

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      agentId: row.agentId,
      providerName: row.providerName,
      direction: row.direction,
      source: row.source,
      visibility: row.visibility,
      discordMessageId: row.discordMessageId,
      discordChannelId: row.discordChannelId,
      discordUserId: row.discordUserId,
      discordUsername: row.discordUsername,
      content: row.content,
      metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
      createdAt: row.createdAt
    }));
  }

  listMessagesForSession(sessionId: string, limit = 100): StoredMessageRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            direction,
            source,
            visibility,
            discord_message_id AS discordMessageId,
            discord_channel_id AS discordChannelId,
            discord_user_id AS discordUserId,
            discord_username AS discordUsername,
            content,
            metadata_json AS metadataJson,
            created_at AS createdAt
          FROM messages
          WHERE session_id = ?
          ORDER BY id ASC
          LIMIT ?
        `
      )
      .all(sessionId, limit) as Array<
      Omit<StoredMessageRecord, "metadata"> & { metadataJson: string | null }
    >;

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      agentId: row.agentId,
      providerName: row.providerName,
      direction: row.direction,
      source: row.source,
      visibility: row.visibility,
      discordMessageId: row.discordMessageId,
      discordChannelId: row.discordChannelId,
      discordUserId: row.discordUserId,
      discordUsername: row.discordUsername,
      content: row.content,
      metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
      createdAt: row.createdAt
    }));
  }

  listModelRunsForSession(sessionId: string, limit = 100): ModelRunRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            conversation_key AS conversationKey,
            provider_session_id AS providerSessionId,
            model,
            stop_reason AS stopReason,
            response_mode AS responseMode,
            latency_ms AS latencyMs,
            provider_duration_ms AS providerDurationMs,
            provider_api_duration_ms AS providerApiDurationMs,
            input_tokens AS inputTokens,
            output_tokens AS outputTokens,
            cache_read_input_tokens AS cacheReadInputTokens,
            cache_creation_input_tokens AS cacheCreationInputTokens,
            total_cost_usd AS totalCostUsd,
            is_error AS isError,
            error_message AS errorMessage,
            request_message_id AS requestMessageId,
            response_message_id AS responseMessageId,
            metadata_json AS metadataJson,
            raw_response_json AS rawResponseJson,
            created_at AS createdAt
          FROM model_runs
          WHERE session_id = ?
          ORDER BY id ASC
          LIMIT ?
        `
      )
      .all(sessionId, limit) as Array<
      Omit<ModelRunRecord, "metadata" | "rawResponse"> & {
        metadataJson: string | null;
        rawResponseJson: string | null;
      }
    >;

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      agentId: row.agentId,
      providerName: row.providerName,
      conversationKey: row.conversationKey,
      providerSessionId: row.providerSessionId,
      model: row.model,
      stopReason: row.stopReason,
      responseMode: row.responseMode,
      latencyMs: row.latencyMs,
      providerDurationMs: row.providerDurationMs,
      providerApiDurationMs: row.providerApiDurationMs,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadInputTokens: row.cacheReadInputTokens,
      cacheCreationInputTokens: row.cacheCreationInputTokens,
      totalCostUsd: row.totalCostUsd,
      isError: row.isError,
      errorMessage: row.errorMessage,
      requestMessageId: row.requestMessageId,
      responseMessageId: row.responseMessageId,
      metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
      rawResponse: row.rawResponseJson ? safeJsonParse(row.rawResponseJson) : null,
      createdAt: row.createdAt
    }));
  }

  listModelRunsForConversation(conversationKey: string, limit = 100): ModelRunRecord[] {
    const resolvedLimit = Number.isFinite(limit) ? Math.max(limit, 1) : 100;
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            conversation_key AS conversationKey,
            provider_session_id AS providerSessionId,
            model,
            stop_reason AS stopReason,
            response_mode AS responseMode,
            latency_ms AS latencyMs,
            provider_duration_ms AS providerDurationMs,
            provider_api_duration_ms AS providerApiDurationMs,
            input_tokens AS inputTokens,
            output_tokens AS outputTokens,
            cache_read_input_tokens AS cacheReadInputTokens,
            cache_creation_input_tokens AS cacheCreationInputTokens,
            total_cost_usd AS totalCostUsd,
            is_error AS isError,
            error_message AS errorMessage,
            request_message_id AS requestMessageId,
            response_message_id AS responseMessageId,
            metadata_json AS metadataJson,
            raw_response_json AS rawResponseJson,
            created_at AS createdAt
          FROM model_runs
          WHERE conversation_key = ?
          ORDER BY id DESC
          LIMIT ?
        `
      )
      .all(conversationKey, resolvedLimit) as Array<
      Omit<ModelRunRecord, "metadata" | "rawResponse"> & {
        metadataJson: string | null;
        rawResponseJson: string | null;
      }
    >;

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      agentId: row.agentId,
      providerName: row.providerName,
      conversationKey: row.conversationKey,
      providerSessionId: row.providerSessionId,
      model: row.model,
      stopReason: row.stopReason,
      responseMode: row.responseMode,
      latencyMs: row.latencyMs,
      providerDurationMs: row.providerDurationMs,
      providerApiDurationMs: row.providerApiDurationMs,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadInputTokens: row.cacheReadInputTokens,
      cacheCreationInputTokens: row.cacheCreationInputTokens,
      totalCostUsd: row.totalCostUsd,
      isError: row.isError,
      errorMessage: row.errorMessage,
      requestMessageId: row.requestMessageId,
      responseMessageId: row.responseMessageId,
      metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
      rawResponse: row.rawResponseJson ? safeJsonParse(row.rawResponseJson) : null,
      createdAt: row.createdAt
    }));
  }

  listProviderArtifactCleanupCandidates(input: {
    olderThan: string;
    providerNamePrefixes?: string[];
    continuityMode?: string;
    limit?: number;
  }): ProviderArtifactCandidateRecord[] {
    const providerNamePrefixes = (input.providerNamePrefixes ?? [])
      .map((prefix) => prefix.trim())
      .filter((prefix) => prefix.length > 0);
    const continuityMode = input.continuityMode?.trim() || "stateless";
    const resolvedLimit = Number.isFinite(input.limit) ? Math.max(1, Math.trunc(input.limit ?? 500)) : 500;
    const providerClause =
      providerNamePrefixes.length > 0
        ? `AND (${providerNamePrefixes.map(() => "provider_name LIKE ?").join(" OR ")})`
        : "";
    const rows = this.db
      .prepare(
        `
          SELECT
            provider_name AS providerName,
            provider_session_id AS providerSessionId,
            MIN(created_at) AS firstSeenAt,
            MAX(created_at) AS lastSeenAt,
            COUNT(*) AS runCount
          FROM model_runs
          WHERE provider_session_id IS NOT NULL
            AND json_extract(metadata_json, '$.orchestratorContinuityMode') = ?
            ${providerClause}
          GROUP BY provider_name, provider_session_id
          HAVING MAX(created_at) < ?
          ORDER BY MAX(created_at) ASC, provider_session_id ASC
          LIMIT ?
        `
      )
      .all(
        continuityMode,
        ...providerNamePrefixes.map((prefix) => `${prefix}%`),
        input.olderThan,
        resolvedLimit
      ) as Array<{
      providerName: string;
      providerSessionId: string;
      firstSeenAt: string;
      lastSeenAt: string;
      runCount: number | bigint;
    }>;

    return rows.map((row) => ({
      providerName: row.providerName,
      providerSessionId: row.providerSessionId,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      runCount: Number(row.runCount),
    }));
  }

  listStoredSessions(limit = 200): SessionSummary[] {
    const rows = this.db
      .prepare(
        `
          SELECT
            s.id AS sessionId,
            s.session_type AS sessionType,
            s.default_agent_id AS defaultAgentId,
            (
              SELECT COUNT(*)
              FROM messages m
              WHERE m.session_id = s.id
            ) AS messageCount,
            (
              SELECT COUNT(*)
              FROM model_runs mr
              WHERE mr.session_id = s.id
            ) AS modelRunCount,
            (
              SELECT COUNT(*)
              FROM provider_sessions ps
              WHERE ps.session_id = s.id
            ) AS providerSessionCount,
            (
              SELECT MAX(m.created_at)
              FROM messages m
              WHERE m.session_id = s.id
            ) AS lastMessageAt,
            (
              SELECT MAX(mr.created_at)
              FROM model_runs mr
              WHERE mr.session_id = s.id
            ) AS lastModelRunAt,
            s.updated_at AS updatedAt
          FROM sessions s
          ORDER BY s.id
          LIMIT ?
        `
      )
      .all(limit) as Array<{
      sessionId: string;
      sessionType: string;
      defaultAgentId: string;
      messageCount: number | bigint;
      modelRunCount: number | bigint;
      providerSessionCount: number | bigint;
      lastMessageAt: string | null;
      lastModelRunAt: string | null;
      updatedAt: string;
    }>;

    return rows.map((row) => ({
      sessionId: row.sessionId,
      sessionType: row.sessionType,
      defaultAgentId: row.defaultAgentId,
      messageCount: toSafeNumber(row.messageCount),
      modelRunCount: toSafeNumber(row.modelRunCount),
      providerSessionCount: toSafeNumber(row.providerSessionCount),
      lastMessageAt: row.lastMessageAt,
      lastModelRunAt: row.lastModelRunAt,
      updatedAt: row.updatedAt
    }));
  }

  getSessionSummary(sessionId: string): SessionSummary | null {
    const row = this.db
      .prepare(
        `
          SELECT
            s.id AS sessionId,
            s.session_type AS sessionType,
            s.default_agent_id AS defaultAgentId,
            (
              SELECT COUNT(*)
              FROM messages m
              WHERE m.session_id = s.id
            ) AS messageCount,
            (
              SELECT COUNT(*)
              FROM model_runs mr
              WHERE mr.session_id = s.id
            ) AS modelRunCount,
            (
              SELECT COUNT(*)
              FROM provider_sessions ps
              WHERE ps.session_id = s.id
            ) AS providerSessionCount,
            (
              SELECT MAX(m.created_at)
              FROM messages m
              WHERE m.session_id = s.id
            ) AS lastMessageAt,
            (
              SELECT MAX(mr.created_at)
              FROM model_runs mr
              WHERE mr.session_id = s.id
            ) AS lastModelRunAt,
            s.updated_at AS updatedAt
          FROM sessions s
          WHERE s.id = ?
        `
      )
      .get(sessionId) as
      | {
          sessionId: string;
          sessionType: string;
          defaultAgentId: string;
          messageCount: number | bigint;
          modelRunCount: number | bigint;
          providerSessionCount: number | bigint;
          lastMessageAt: string | null;
          lastModelRunAt: string | null;
          updatedAt: string;
        }
      | undefined;

    if (!row) return null;

    return {
      sessionId: row.sessionId,
      sessionType: row.sessionType,
      defaultAgentId: row.defaultAgentId,
      messageCount: toSafeNumber(row.messageCount),
      modelRunCount: toSafeNumber(row.modelRunCount),
      providerSessionCount: toSafeNumber(row.providerSessionCount),
      lastMessageAt: row.lastMessageAt,
      lastModelRunAt: row.lastModelRunAt,
      updatedAt: row.updatedAt
    };
  }

  getHealthSnapshot(): HealthSnapshot {
    const row = this.db
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM sessions) AS sessions,
            (SELECT COUNT(*) FROM messages) AS messages,
            (SELECT COUNT(*) FROM model_runs) AS modelRuns,
            (SELECT COUNT(*) FROM provider_sessions) AS providerSessions,
            (SELECT COUNT(*) FROM dead_letters) AS deadLettersTotal,
            (SELECT COUNT(*) FROM dead_letters WHERE status = 'pending') AS deadLettersPending,
            (SELECT MAX(created_at) FROM messages) AS lastMessageAt
        `
      )
      .get() as {
      sessions: number | bigint;
      messages: number | bigint;
      modelRuns: number | bigint;
      providerSessions: number | bigint;
      deadLettersTotal: number | bigint;
      deadLettersPending: number | bigint;
      lastMessageAt: string | null;
    };

    return {
      status: "healthy",
      dbUserVersion: this.getUserVersion(),
      sessions: toSafeNumber(row.sessions),
      messages: toSafeNumber(row.messages),
      modelRuns: toSafeNumber(row.modelRuns),
      providerSessions: toSafeNumber(row.providerSessions),
      deadLettersTotal: toSafeNumber(row.deadLettersTotal),
      deadLettersPending: toSafeNumber(row.deadLettersPending),
      lastMessageAt: row.lastMessageAt
    };
  }

  resetSession(sessionId: string, options: ResetSessionOptions = {}): ResetSessionResult {
    const clearHistory = options.clearHistory === true;
    const clearDiagnostics = options.clearDiagnostics === true || clearHistory;

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const providerDelete = this.db
        .prepare(
          `
            DELETE FROM provider_sessions
            WHERE session_id = ?
          `
        )
        .run(sessionId);

      const promptSnapshotDelete = clearDiagnostics
        ? this.db
            .prepare(
              `
                DELETE FROM prompt_snapshots
                WHERE session_id = ?
              `
            )
            .run(sessionId)
        : { changes: 0 };

      const modelRunDelete = clearDiagnostics
        ? this.db
            .prepare(
              `
                DELETE FROM model_runs
                WHERE session_id = ?
              `
            )
            .run(sessionId)
        : { changes: 0 };

      const deadLetterDelete = clearDiagnostics
        ? this.db
            .prepare(
              `
                DELETE FROM dead_letters
                WHERE session_id = ?
              `
            )
            .run(sessionId)
        : { changes: 0 };

      if (clearDiagnostics) {
        this.db
          .prepare(
            `
              DELETE FROM voice_turn_receipts
              WHERE session_id = ?
            `
          )
          .run(sessionId);
      }

      const messageDelete = clearHistory
        ? this.db
            .prepare(
              `
                DELETE FROM messages
                WHERE session_id = ?
              `
            )
            .run(sessionId)
        : { changes: 0 };

      if (clearHistory) {
        this.db
          .prepare(
            `
              DELETE FROM session_compactions
              WHERE session_id = ?
            `
          )
          .run(sessionId);

        this.db
          .prepare(
            `
              DELETE FROM session_summaries
              WHERE session_id = ?
            `
          )
          .run(sessionId);

        this.db
          .prepare(
            `
              DELETE FROM memories
              WHERE session_id = ?
            `
          )
          .run(sessionId);

        this.db
          .prepare(
            `
              DELETE FROM pinned_facts
              WHERE scope = 'session' AND scope_id = ?
            `
          )
          .run(sessionId);
      }

      this.db.exec("COMMIT;");
      return {
        deletedProviderSessions: toSafeNumber(providerDelete.changes),
        deletedMessages: toSafeNumber(messageDelete.changes),
        deletedModelRuns: toSafeNumber(modelRunDelete.changes),
        deletedDeadLetters: toSafeNumber(deadLetterDelete.changes),
        deletedPromptSnapshots: toSafeNumber(promptSnapshotDelete.changes)
      };
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  upsertChannelReferent(input: ChannelReferentUpsertInput): void {
    const channelId = input.channelId.trim();
    const discordUserId = input.discordUserId.trim();
    const targetMessageId = input.targetMessageId.trim();
    const targetContent = input.targetContent.trim();
    if (!channelId || !discordUserId || !targetMessageId || !targetContent) {
      throw new Error("channelId, discordUserId, targetMessageId, and targetContent are required.");
    }

    const metadataJson = toJsonOrNull(input.metadata);
    const expiresAt = input.expiresAt?.trim() || toSqliteDateTime(new Date(Date.now() + 2 * 60 * 60 * 1000));
    this.db
      .prepare(
        `
          INSERT INTO channel_referents (
            channel_id,
            discord_user_id,
            kind,
            target_message_id,
            target_session_id,
            target_agent_id,
            target_direction,
            target_source,
            target_content,
            metadata_json,
            created_at,
            updated_at,
            expires_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)
          ON CONFLICT(channel_id, discord_user_id) DO UPDATE SET
            kind = excluded.kind,
            target_message_id = excluded.target_message_id,
            target_session_id = excluded.target_session_id,
            target_agent_id = excluded.target_agent_id,
            target_direction = excluded.target_direction,
            target_source = excluded.target_source,
            target_content = excluded.target_content,
            metadata_json = excluded.metadata_json,
            updated_at = datetime('now'),
            expires_at = excluded.expires_at
        `
      )
      .run(
        channelId,
        discordUserId,
        input.kind,
        targetMessageId,
        input.targetSessionId ?? null,
        input.targetAgentId ?? null,
        input.targetDirection ?? null,
        input.targetSource ?? null,
        targetContent,
        metadataJson,
        expiresAt
      );
  }

  getChannelReferent(channelId: string, discordUserId: string): ChannelReferentRecord | null {
    const normalizedChannelId = channelId.trim();
    const normalizedDiscordUserId = discordUserId.trim();
    if (!normalizedChannelId || !normalizedDiscordUserId) return null;

    this.db
      .prepare(
        `
          DELETE FROM channel_referents
          WHERE channel_id = ?
            AND discord_user_id = ?
            AND expires_at <= datetime('now')
        `
      )
      .run(normalizedChannelId, normalizedDiscordUserId);

    const row = this.db
      .prepare(
        `
          SELECT
            channel_id AS channelId,
            discord_user_id AS discordUserId,
            kind,
            target_message_id AS targetMessageId,
            target_session_id AS targetSessionId,
            target_agent_id AS targetAgentId,
            target_direction AS targetDirection,
            target_source AS targetSource,
            target_content AS targetContent,
            metadata_json AS metadataJson,
            created_at AS createdAt,
            updated_at AS updatedAt,
            expires_at AS expiresAt
          FROM channel_referents
          WHERE channel_id = ?
            AND discord_user_id = ?
          LIMIT 1
        `
      )
      .get(normalizedChannelId, normalizedDiscordUserId) as
      | (Omit<ChannelReferentRecord, "metadata"> & { metadataJson: string | null })
      | undefined;

    if (!row) return null;
    return {
      channelId: row.channelId,
      discordUserId: row.discordUserId,
      kind: row.kind,
      targetMessageId: row.targetMessageId,
      targetSessionId: row.targetSessionId,
      targetAgentId: row.targetAgentId,
      targetDirection: row.targetDirection,
      targetSource: row.targetSource,
      targetContent: row.targetContent,
      metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      expiresAt: row.expiresAt
    };
  }

  clearChannelReferent(channelId: string, discordUserId: string): boolean {
    const result = this.db
      .prepare(
        `
          DELETE FROM channel_referents
          WHERE channel_id = ?
            AND discord_user_id = ?
        `
      )
      .run(channelId.trim(), discordUserId.trim());
    return toSafeNumber(result.changes) > 0;
  }

  upsertPendingSessionSave(input: PendingSessionSaveUpsertInput): PendingSessionSaveRecord {
    const conversationKey = input.conversationKey.trim();
    const sessionId = input.sessionId.trim();
    const agentId = input.agentId.trim();
    const requestedByUserId = input.requestedByUserId.trim();
    const trigger = input.trigger?.trim() || "slash_command";

    if (!conversationKey || !sessionId || !agentId || !requestedByUserId) {
      throw new Error(
        "conversationKey, sessionId, agentId, and requestedByUserId are required for pending session save.",
      );
    }

    this.db
      .prepare(
        `
          INSERT INTO pending_session_saves (
            conversation_key,
            session_id,
            agent_id,
            requested_by_user_id,
            trigger,
            requested_at
          )
          VALUES (?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(conversation_key) DO UPDATE SET
            session_id = excluded.session_id,
            agent_id = excluded.agent_id,
            requested_by_user_id = excluded.requested_by_user_id,
            trigger = excluded.trigger,
            requested_at = datetime('now')
        `,
      )
      .run(conversationKey, sessionId, agentId, requestedByUserId, trigger);

    const record = this.getPendingSessionSave(conversationKey);
    if (!record) {
      throw new Error(`Failed to upsert pending session save for '${conversationKey}'.`);
    }

    return record;
  }

  getPendingSessionSave(conversationKey: string): PendingSessionSaveRecord | null {
    const normalizedKey = conversationKey.trim();
    if (!normalizedKey) {
      return null;
    }

    const row = this.db
      .prepare(
        `
          SELECT
            conversation_key AS conversationKey,
            session_id AS sessionId,
            agent_id AS agentId,
            requested_by_user_id AS requestedByUserId,
            trigger,
            requested_at AS requestedAt
          FROM pending_session_saves
          WHERE conversation_key = ?
          LIMIT 1
        `,
      )
      .get(normalizedKey) as PendingSessionSaveRecord | undefined;

    return row ?? null;
  }

  deletePendingSessionSave(conversationKey: string): boolean {
    const result = this.db
      .prepare(
        `
          DELETE FROM pending_session_saves
          WHERE conversation_key = ?
        `,
      )
      .run(conversationKey.trim());
    return toSafeNumber(result.changes) > 0;
  }

  countPendingSessionSaves(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM pending_session_saves`)
      .get() as { count: number | bigint } | undefined;
    return toSafeNumber(row?.count ?? 0);
  }

  /**
   * T-I-035: persist the latest context-usage reading at the lifecycle write
   * point. One row per (conversation_key, agent_id) — upsert keeps only the
   * freshest reading; the [context] trail log is the per-turn history.
   */
  upsertContextUsageSnapshot(input: ContextUsageSnapshotUpsertInput): void {
    this.db
      .prepare(
        `
          INSERT INTO context_usage_snapshots (
            conversation_key, agent_id, fraction, used_tokens, context_window, recorded_at
          )
          VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
          ON CONFLICT(conversation_key, agent_id) DO UPDATE SET
            fraction = excluded.fraction,
            used_tokens = excluded.used_tokens,
            context_window = excluded.context_window,
            recorded_at = excluded.recorded_at
        `,
      )
      .run(
        input.conversationKey.trim(),
        input.agentId.trim(),
        input.fraction,
        Math.round(input.usedTokens),
        Math.round(input.contextWindow),
        input.recordedAt ?? null,
      );
  }

  /** T-I-035: PK lookup — the voice whisper reads its own conversation key. */
  getContextUsageSnapshot(conversationKey: string, agentId: string): ContextUsageSnapshotRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            conversation_key AS conversationKey,
            agent_id AS agentId,
            fraction,
            used_tokens AS usedTokens,
            context_window AS contextWindow,
            recorded_at AS recordedAt
          FROM context_usage_snapshots
          WHERE conversation_key = ? AND agent_id = ?
          LIMIT 1
        `,
      )
      .get(conversationKey.trim(), agentId.trim()) as ContextUsageSnapshotRecord | undefined;

    return row ?? null;
  }

  /**
   * T-I-035: reader fallback for /tango context. Matches this post's key
   * shapes — exact typed keys plus LIKE patterns for voice-shaped keys that
   * embed the channel id — filtered to the routed agent, freshest first.
   */
  queryContextUsageSnapshots(input: ContextUsageSnapshotQueryInput): ContextUsageSnapshotRecord[] {
    const exactKeys = (input.exactKeys ?? []).map((key) => key.trim()).filter((key) => key.length > 0);
    const likePatterns = (input.likePatterns ?? []).map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0);
    if (exactKeys.length === 0 && likePatterns.length === 0) {
      return [];
    }

    const clauses: string[] = [];
    const params: string[] = [input.agentId.trim()];
    if (exactKeys.length > 0) {
      clauses.push(`conversation_key IN (${exactKeys.map(() => "?").join(", ")})`);
      params.push(...exactKeys);
    }
    for (const pattern of likePatterns) {
      clauses.push("conversation_key LIKE ?");
      params.push(pattern);
    }

    return this.db
      .prepare(
        `
          SELECT
            conversation_key AS conversationKey,
            agent_id AS agentId,
            fraction,
            used_tokens AS usedTokens,
            context_window AS contextWindow,
            recorded_at AS recordedAt
          FROM context_usage_snapshots
          WHERE agent_id = ? AND (${clauses.join(" OR ")})
          ORDER BY recorded_at DESC
        `,
      )
      .all(...params) as unknown as ContextUsageSnapshotRecord[];
  }

  private getUserVersion(): number {
    const row = this.db.prepare("PRAGMA user_version;").get() as { user_version?: number } | undefined;
    return row?.user_version ?? 0;
  }
}

type VoiceTurnReceiptRow = Omit<VoiceTurnReceiptRecord, "metadata" | "providerUsedFailover" | "warmStartUsed"> & {
  metadataJson: string | null;
  providerUsedFailover: number | null;
  warmStartUsed: number | null;
};

type ActiveContextItemRow = Omit<ActiveContextItemRecord, "keyFacts" | "sourceRefs" | "metadata"> & {
  keyFactsJson: string | null;
  sourceRefsJson: string | null;
  metadataJson: string | null;
};

function buildActiveContextScopeKey(scope: ActiveContextScope): string {
  return JSON.stringify({
    userId: scope.userId ?? null,
    agentId: scope.agentId ?? null,
    channelId: scope.channelId ?? null,
    topicId: scope.topicId ?? null,
    projectId: scope.projectId ?? null,
  });
}

function addNullableScopeCondition(
  conditions: string[],
  values: Array<string | number | null>,
  column: string,
  value: string | null | undefined
): void {
  if (value === undefined) return;
  if (value === null) {
    conditions.push(`${column} IS NULL`);
    return;
  }
  conditions.push(`(${column} IS NULL OR ${column} = ?)`);
  values.push(value);
}

function normalizeStringList(values: string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function normalizeSqliteTimestamp(value: string | Date): string {
  if (value instanceof Date) {
    return toSqliteDateTime(value);
  }
  return value;
}

function safeJsonParse(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseJsonValue(input: string | null): unknown {
  if (!input) return null;
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function parseJsonArray(input: string | null): string[] {
  const parsed = parseJsonValue(input);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((value): value is string => typeof value === "string");
}

type AgentCollaborationSessionRow =
  Omit<
    AgentCollaborationSessionRecord,
    "deliverableContract" | "constraints" | "userSurface" | "budget" | "policyDecision"
  > & {
    deliverableContractJson: string | null;
    constraintsJson: string | null;
    userSurfaceJson: string | null;
    budgetJson: string | null;
    policyDecisionJson: string | null;
  };

type AgentCollaborationTurnRow =
  Omit<AgentCollaborationTurnRecord, "structured"> & {
    structuredJson: string | null;
  };

function parseJsonObject(input: string | null): Record<string, unknown> | null {
  const parsed = parseJsonValue(input);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function mapAgentCollaborationSessionRow(
  row: AgentCollaborationSessionRow,
): AgentCollaborationSessionRecord {
  return {
    id: row.id,
    parentCollaborationId: row.parentCollaborationId,
    requesterAgentId: row.requesterAgentId,
    targetAgentId: row.targetAgentId,
    initiatorKind: row.initiatorKind,
    initiatorRef: row.initiatorRef,
    purpose: row.purpose,
    objective: row.objective,
    normalizedObjective: row.normalizedObjective,
    contextSummary: row.contextSummary,
    deliverableContract: parseJsonObject(row.deliverableContractJson) ?? {},
    constraints: parseJsonArray(row.constraintsJson),
    status: row.status,
    visibilityMode: row.visibilityMode,
    userSurface: parseJsonObject(row.userSurfaceJson),
    budget: parseJsonObject(row.budgetJson) ?? {},
    policyDecision: parseJsonObject(row.policyDecisionJson),
    resultSummary: row.resultSummary,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
  };
}

function mapAgentCollaborationTurnRow(row: AgentCollaborationTurnRow): AgentCollaborationTurnRecord {
  return {
    id: row.id,
    collaborationId: row.collaborationId,
    turnIndex: row.turnIndex,
    senderAgentId: row.senderAgentId,
    recipientAgentId: row.recipientAgentId,
    turnType: row.turnType,
    content: row.content,
    structured: parseJsonObject(row.structuredJson),
    modelRunId: row.modelRunId,
    visibleMessageRef: row.visibleMessageRef,
    createdAt: row.createdAt,
  };
}

function toActiveContextItemRecord(row: ActiveContextItemRow): ActiveContextItemRecord {
  return {
    id: row.id,
    key: row.key,
    userId: row.userId,
    agentId: row.agentId,
    channelId: row.channelId,
    topicId: row.topicId,
    projectId: row.projectId,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    keyFacts: parseJsonArray(row.keyFactsJson),
    sourceRefs: parseJsonArray(row.sourceRefsJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastAccessedAt: row.lastAccessedAt,
    accessCount: row.accessCount,
    expiresAt: row.expiresAt,
    archivedAt: row.archivedAt,
    metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
  };
}

function mapActiveTaskRow(
  row: Omit<ActiveTaskRecord, "intentIds" | "missingSlots" | "structuredContext"> & {
    intentIdsJson: string | null;
    missingSlotsJson: string | null;
    structuredContextJson: string | null;
  }
): ActiveTaskRecord {
  const structuredContext = parseJsonValue(row.structuredContextJson);
  return {
    id: row.id,
    sessionId: row.sessionId,
    agentId: row.agentId,
    status: row.status,
    title: row.title,
    objective: row.objective,
    ownerWorkerId: row.ownerWorkerId,
    intentIds: parseJsonArray(row.intentIdsJson),
    missingSlots: parseJsonArray(row.missingSlotsJson),
    clarificationQuestion: row.clarificationQuestion,
    suggestedNextAction: row.suggestedNextAction,
    structuredContext:
      structuredContext && typeof structuredContext === "object" && !Array.isArray(structuredContext)
        ? (structuredContext as Record<string, unknown>)
        : null,
    sourceKind: row.sourceKind,
    createdByMessageId: row.createdByMessageId,
    updatedByMessageId: row.updatedByMessageId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    resolvedAt: row.resolvedAt,
    expiresAt: row.expiresAt,
  };
}

function toJsonOrNull(value: Record<string, unknown> | null | undefined): string | null {
  if (!value || Object.keys(value).length === 0) {
    return null;
  }
  return JSON.stringify(value);
}

function toStoredMemoryRecord(
  row: Omit<StoredMemoryRecord, "metadata"> & { metadataJson: string | null }
): StoredMemoryRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    agentId: row.agentId,
    source: row.source,
    content: row.content,
    importance: row.importance,
    sourceRef: row.sourceRef,
    embeddingJson: row.embeddingJson,
    embeddingModel: row.embeddingModel,
    createdAt: row.createdAt,
    lastAccessedAt: row.lastAccessedAt,
    accessCount: row.accessCount,
    archivedAt: row.archivedAt,
    metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null
  };
}

function toPromptSnapshotRecord(
  row: Omit<PromptSnapshotRecord, "metadata"> & { metadataJson: string | null }
): PromptSnapshotRecord {
  return {
    id: row.id,
    modelRunId: row.modelRunId,
    sessionId: row.sessionId,
    agentId: row.agentId,
    providerName: row.providerName,
    requestMessageId: row.requestMessageId,
    responseMessageId: row.responseMessageId,
    promptText: row.promptText,
    systemPrompt: row.systemPrompt,
    warmStartPrompt: row.warmStartPrompt,
    metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

function toSafeNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function toSqliteBoolean(value: boolean | undefined): number | null {
  if (typeof value !== "boolean") return null;
  return value ? 1 : 0;
}

function toSqliteDateTime(value: Date): string {
  return value.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

function fromSqliteBoolean(value: number | null): boolean | null {
  if (value === null || value === undefined) return null;
  return value === 1;
}

function toVoiceTurnReceiptRecord(row: VoiceTurnReceiptRow): VoiceTurnReceiptRecord {
  return {
    turnId: row.turnId,
    sessionId: row.sessionId,
    agentId: row.agentId,
    utteranceId: row.utteranceId,
    status: row.status,
    providerName: row.providerName,
    providerSessionId: row.providerSessionId,
    responseText: row.responseText,
    providerUsedFailover: fromSqliteBoolean(row.providerUsedFailover),
    warmStartUsed: fromSqliteBoolean(row.warmStartUsed),
    requestMessageId: row.requestMessageId,
    responseMessageId: row.responseMessageId,
    modelRunId: row.modelRunId,
    errorMessage: row.errorMessage,
    metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}
