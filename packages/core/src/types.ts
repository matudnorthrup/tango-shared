export type SessionType = "persistent" | "project" | "ephemeral";
export type AccessMode = "off" | "allowlist" | "mention" | "both";
export type ToolMode = "off" | "default" | "allowlist";
export type WriteConfirmationMode = "always" | "on-ambiguity" | "never";
export type WorkerWriteScope = "none" | "limited" | "full";
export type ToolContractMode = "read" | "write" | "read_write" | "validate";
export type ToolContractStatus = "scaffold" | "implemented";
export type ProjectTopicMode = "topicless" | "optional" | "required";
export type WorkflowMode = "read" | "write" | "hybrid";
export type WorkflowStatus = "scaffold" | "implemented";
export type IntentContractMode = "read" | "write" | "mixed";
export type IntentRouteKind = "workflow" | "worker";
export type ActiveTaskStatus =
  | "proposed"
  | "awaiting_user"
  | "ready"
  | "running"
  | "blocked"
  | "completed"
  | "canceled"
  | "superseded"
  | "expired";
export type MemorySource = "conversation" | "obsidian" | "reflection" | "manual" | "backfill";
export type PinnedFactScope = "global" | "agent" | "session";
export type OrchestratorContinuityMode = "provider" | "stateless";
export type ProviderReasoningEffort = "low" | "medium" | "high" | "max" | "xhigh";
export type StateViewSource = "state" | "atlas";
export type StateViewSortDirection = "asc" | "desc";

export type StateViewScalar = string | number | boolean | null;

export interface StateViewSelectorConfig {
  types?: string[];
  statuses?: string[];
  includeArchived?: boolean;
  where?: Record<string, StateViewScalar>;
  relation?: {
    kind?: string;
    targetEntityId?: StateViewScalar;
  };
  referenceRoles?: string[];
}

export interface StateViewSortConfig {
  field: string;
  direction: StateViewSortDirection;
}

export interface StateViewSectionConfig {
  heading: string;
  source: StateViewSource;
  selector?: StateViewSelectorConfig;
  sort?: StateViewSortConfig[];
  limit?: number;
  itemTemplate: string;
  emptyText?: string;
}

/**
 * A deterministic Markdown projection. Definitions are layered config so the
 * engine remains use-case agnostic and profile-specific views stay private.
 */
export interface StateViewConfig {
  id: string;
  enabled: boolean;
  forEach: StateViewSelectorConfig;
  outputPath: string;
  titleTemplate: string;
  sections: StateViewSectionConfig[];
}

export interface StateTypePackStatusConfig {
  values: string[];
  transitions?: Record<string, string[]>;
  initial?: string;
  terminal?: string[];
}

export interface StateTypePackTypeConfig {
  id: string;
  displayName: string;
  description?: string | null;
  attributesSchema: Record<string, unknown>;
  statuses?: StateTypePackStatusConfig | null;
  stalenessPolicy?: Record<string, unknown> | null;
  digestTemplate?: string | null;
  bodyFields?: string[];
  visibility?: string;
}

/** Config-only reusable schemas; packs never contain entity values. */
export interface StateTypePackConfig {
  id: string;
  enabled: boolean;
  types: StateTypePackTypeConfig[];
}

export interface DeterministicRoutingConfig {
  enabled?: boolean;
  projectScope?: string;
  additionalDomains?: string[];
  confidenceThreshold?: number;
  provider?: {
    default: string;
    model?: string;
    reasoningEffort?: ProviderReasoningEffort;
    fallback?: string[];
  };
}

export interface MemoryZoneConfig {
  pinned?: number;
  summary?: number;
  memories?: number;
  recent?: number;
}

export interface MemoryRetrievalWeights {
  recency?: number;
  importance?: number;
  relevance?: number;
  source?: number;
}

export interface SessionMemoryConfig {
  maxContextTokens?: number;
  zones?: MemoryZoneConfig;
  summarizeWindow?: number;
  memoryLimit?: number;
  importanceThreshold?: number;
  retrievalWeights?: MemoryRetrievalWeights;
}

export interface SessionConfig {
  id: string;
  type: SessionType;
  agent: string;
  channels: string[];
  orchestratorContinuity?: OrchestratorContinuityMode;
  memory?: SessionMemoryConfig;
}

export interface AgentConfig {
  id: string;
  type: string;
  displayName?: string;
  avatarURL?: string;
  avatarPath?: string;
  provider: {
    default: string;
    model?: string;
    reasoningEffort?: ProviderReasoningEffort;
    fallback?: string[];
  };
  prompt?: string;
  promptFile?: string;
  defaultTopic?: string;
  defaultProject?: string;
  voice?: {
    callSigns?: string[];
    defaultPromptAgent?: string;
    kokoroVoice?: string;
    defaultChannelId?: string;
    smokeTestChannelId?: string;
  };
  discord?: {
    typingTokenEnv?: string;
  };
  responseMode?: "concise" | "explain";
  access?: {
    mode?: AccessMode;
    allowlistChannelIds?: string[];
    allowlistUserIds?: string[];
  };
  tools?: {
    mode?: ToolMode;
    allowlist?: string[];
    permissionMode?: "bypass";
  };
  orchestration?: {
    workerIds?: string[];
    writeConfirmation?: WriteConfirmationMode;
  };
  deterministicRouting?: DeterministicRoutingConfig;
}

export interface ProjectConfig {
  id: string;
  displayName?: string;
  aliases?: string[];
  defaultAgentId?: string;
  provider?: {
    default: string;
    model?: string;
    reasoningEffort?: ProviderReasoningEffort;
    fallback?: string[];
  };
  workerIds?: string[];
  toolContractIds?: string[];
  policies?: {
    topicMode?: ProjectTopicMode;
    writeConfirmation?: WriteConfirmationMode;
  };
}

export type WorkerExecutionMode = "procedural" | "agent";

export interface WorkerConfig {
  id: string;
  type: string;
  displayName?: string;
  ownerAgentId?: string;
  description?: string;
  provider: {
    default: string;
    model?: string;
    reasoningEffort?: ProviderReasoningEffort;
    fallback?: string[];
  };
  /** How this worker executes: procedural (deterministic) or agent (LLM with MCP tools) */
  execution?: WorkerExecutionMode;
  prompt?: string;
  promptFile?: string;
  toolContractIds?: string[];
  skillDocIds?: string[];
  /** Max seconds of inactivity (no tool calls) before the worker is killed. */
  inactivityTimeoutSeconds?: number;
  policy?: {
    writeScope?: WorkerWriteScope;
    confirmBeforeWrite?: boolean;
  };
}

export interface ToolContractConfig {
  id: string;
  family: string;
  description: string;
  ownerWorkerId?: string;
  mode: ToolContractMode;
  status?: ToolContractStatus;
  confirmationRequired?: boolean;
  liveExecution?: {
    enabled?: boolean;
    writeEnabled?: boolean;
  };
  integration: {
    system: string;
    target: string;
  };
  inputFields?: string[];
  outputFields?: string[];
  legacy?: {
    commands?: string[];
    readPaths?: string[];
    writePaths?: string[];
    notes?: string[];
  };
}

export interface WorkflowConfig {
  id: string;
  displayName?: string;
  description: string;
  /**
   * Workflow ownership is deterministic, but execution is still worker-led.
   * A workflow here is a reusable task contract or objective template that
   * scopes the request before handing it to the owning worker. It should not
   * imply a hardcoded query plan that bypasses worker reasoning.
   */
  ownerWorkerId: string;
  mode: WorkflowMode;
  status?: WorkflowStatus;
  confirmationRequired?: boolean;
  handler: string;
  toolContractIds?: string[];
  inputFields?: string[];
  examples?: string[];
  planning?: {
    summary?: string;
    whenToUse?: string[];
    askForClarificationWhen?: string[];
  };
}

export interface IntentContractSlotConfig {
  name: string;
  required?: boolean;
  inferable?: boolean;
  description?: string;
}

export interface IntentContractEvaluationConfig {
  taskClass?: string;
  successCriteria?: string[];
  mustAnswer?: string[];
  comparisonAxes?: string[];
  requiredFields?: string[];
  qualityGateRequired?: boolean;
  safeNoopAllowed?: boolean;
}

export interface IntentContractConfig {
  id: string;
  domain: string;
  displayName?: string;
  description: string;
  mode: IntentContractMode;
  /**
   * Intent routing should be deterministic about ownership only:
   * which worker or reusable workflow contract owns the request.
   * The downstream worker still decides the exact tools, queries,
   * comparisons, and reasoning steps needed to satisfy the intent.
   */
  route: {
    kind: IntentRouteKind;
    targetId: string;
  };
  slots?: IntentContractSlotConfig[];
  examples?: string[];
  canRunInParallel?: boolean;
  classifierHints?: string[];
  evaluation?: IntentContractEvaluationConfig;
}

export interface RouteResult {
  sessionId: string;
  agentId: string;
}
