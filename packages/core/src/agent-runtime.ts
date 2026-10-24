import type { ProviderImageInput, ProviderToolCall } from "./provider.js";
import type { RuntimeTurnEventListener } from "./runtime-activity.js";

export class RuntimeAbortedError extends Error {
  readonly aborted = true;

  constructor(message = "Runtime request aborted.") {
    super(message);
    this.name = "RuntimeAbortedError";
  }
}

export function isRuntimeAbortedError(error: unknown): error is RuntimeAbortedError {
  return error instanceof RuntimeAbortedError
    || (typeof error === "object"
      && error !== null
      && "aborted" in error
      && (error as { aborted?: unknown }).aborted === true);
}

export interface AgentRuntime {
  readonly id: string;
  readonly type: "claude-code" | "codex" | "ollama" | "loom";
  readonly active: boolean;

  send(message: string, options?: SendOptions): Promise<RuntimeResponse>;
  initialize(config: AgentRuntimeConfig): Promise<void>;
  teardown(): Promise<void>;
  healthCheck(): Promise<boolean>;
  /** Kill an in-flight request without clearing the provider session. */
  abortActiveRun?(): boolean;
}

export interface AgentRuntimeConfig {
  agentId: string;
  systemPrompt: string;
  /** MCP servers mounted for the current runtime invocation. */
  mcpServers: McpServerConfig[];
  /**
   * MCP servers the agent may use but that are not mounted by default. Callers
   * can promote these into `mcpServers` for a turn before invoking the runtime.
   */
  availableMcpServers?: McpServerConfig[];
  /** Debug/telemetry for the server set selected for this invocation. */
  mcpMountSelection?: McpMountSelection;
  runtimePreferences: {
    model?: string;
    reasoningEffort?: "low" | "medium" | "high" | "max";
    maxTokens?: number;
    timeout?: number;
  };
  coldStartContext?: string;
  /**
   * Which runtime backend should serve this agent's turns. Defaults to
   * "claude-code" (the Claude Code CLI adapter). When "ollama", the
   * RuntimePool constructs an OllamaRuntimeAdapter backed by the shared
   * OllamaProvider instead. Populated from V2AgentConfig.legacyProvider.default.
   */
  backend?: "claude-code" | "ollama" | "loom";
  /**
   * Isolated agents (V2 `isolated: true`) serve someone other than the owner.
   * The Claude Code adapter runs them with no built-in tools, no user/project
   * settings, CLAUDE.md, or auto-memory, only the configured MCP servers, and
   * from an empty working directory.
   */
  isolated?: boolean;
}

export interface McpMountSelection {
  defaultServerNames: string[];
  availableServerNames: string[];
  mountedServerNames: string[];
  activatedServerNames: string[];
  triggerReasons: Record<string, string[]>;
}

export interface McpServerConfig {
  name: string;
  // Local process-based server
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // Remote URL-based server
  url?: string;
  headers?: Record<string, string>;
}

export interface SendOptions {
  /** Delivery owner retains the run until presentation and post-turn bookkeeping finish. */
  onLoomSubmitted?: (runId: string) => void;
  /** Recoverable delivery destination; conversation transport uses local message ids. */
  discordDelivery?: Omit<import("./storage.js").LoomDelivery, "runId" | "agentId" | "conversationKey" | "loomThreadId" | "createdAt">;
  context?: string;
  currentTurnMetadataPrompt?: string;
  /**
   * Per-turn behavioral briefing ("whisper"). Unlike `context`, this is NOT
   * stripped on resumed provider sessions (see omitContextForResumedRuntime),
   * so it reaches the model on every turn — the channel for state-file
   * pointers, search-first reminders, and context-usage signals.
   */
  turnBriefingPrompt?: string;
  timeout?: number;
  onChunk?: (chunk: string) => void;
  /**
   * Inbound images for this turn, as raw bytes. Backends that can act on pixels
   * (the Ollama path folds them through a vision model) populate
   * ProviderRequest.images from this; the Claude path ignores it (it opens
   * on-disk files via its own Read tool). Set by the Discord v2 turn for
   * clone-backed agents so they get same-turn vision instead of OCR-only.
   */
  images?: ProviderImageInput[];
  /**
   * Live turn events while the turn runs (one per tool call, with a short
   * human activity line). Best-effort: anything a listener throws is
   * swallowed. Runtimes that cannot observe tool calls ignore it.
   */
  onEvent?: RuntimeTurnEventListener;
}

export interface RuntimeResponse {
  text: string;
  durationMs: number;
  model?: string;
  toolsUsed?: string[];
  /** Executed tool inputs/results, used by post-turn state reconciliation. */
  toolCalls?: ProviderToolCall[];
  metadata?: Record<string, unknown>;
}

export type RuntimeState = "spawning" | "active" | "idle" | "closed" | "error";
