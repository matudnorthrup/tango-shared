import type {
  AgentRuntimeConfig,
  AttachmentStore,
  ChatProvider,
  ColdStartContextBuilder,
  RuntimeResponse,
  SendOptions,
  StateService,
  TangoStorage,
  V2AgentConfig,
} from "@tango/core";
import {
  assembleV2SystemPrompt,
  buildAttachmentDirectoryContext,
  formatRetrievedMemoryLine,
  isV2RuntimeEnabled,
  resolveTangoProfileAgentPromptDirs,
  resolveV2MemoryScope,
  RETRIEVED_MEMORY_GUIDANCE,
} from "@tango/core";
import type { MemoryRecord, PinnedFactRecord } from "@tango/atlas-memory";
import type { AtlasMemoryClient } from "./atlas-memory-client.js";
import {
  extractAndStoreMemories,
  type MemoryCaptureConfig,
} from "./memory-capture.js";
import { runActiveTaskPostTurn } from "./active-task-continuation.js";
import { resolveExtractionProvider } from "./extraction-provider.js";
import {
  runStateReconciler,
  type StateReconcilerOutcome,
  type StateReconcilerTurn,
} from "./state-reconciler.js";

export interface FeatureFlaggedRouteRequest {
  conversationKey?: string;
  message: string;
  channelId: string;
  threadId?: string;
  agentId: string;
  messageId?: string;
  occurredAt?: string;
  contextRef?: string;
  contextLabel?: string;
  sendOptions?: SendOptions;
}

export interface FeatureFlaggedRouteResult {
  response: RuntimeResponse;
  agentId: string;
  conversationKey: string;
  turnId: string;
}

export interface FeatureFlaggedRouter {
  routeMessage(params: FeatureFlaggedRouteRequest): Promise<FeatureFlaggedRouteResult>;
  shutdown(): Promise<void>;
}

export type V2RuntimeFailureRecovery = (
  params: FeatureFlaggedRouteRequest,
  error: unknown,
) => Promise<FeatureFlaggedRouteResult | null>;

type ReasoningEffort = NonNullable<AgentRuntimeConfig["runtimePreferences"]["reasoningEffort"]>;

const DEFAULT_V2_RUNTIME_TIMEOUT_MS = 900_000;
const STATE_MCP_SERVER: AgentRuntimeConfig["mcpServers"][number] = {
  name: "state",
  command: "node",
  args: ["packages/core/dist/mcp-proxy.js", "state"],
  env: {
    ALLOWED_TOOL_IDS: "state_query,state_update,state_define_type",
  },
};

export function buildStateMcpServerConfig(): AgentRuntimeConfig["mcpServers"][number] {
  return {
    ...STATE_MCP_SERVER,
    args: [...(STATE_MCP_SERVER.args ?? [])],
    env: { ...(STATE_MCP_SERVER.env ?? {}) },
  };
}

function splitMcpServersForMountPolicy(
  config: V2AgentConfig,
  servers: AgentRuntimeConfig["mcpServers"],
): {
  defaultServers: AgentRuntimeConfig["mcpServers"];
  availableServers?: AgentRuntimeConfig["mcpServers"];
} {
  if (!config.mcp?.defaultServers && !config.mcp?.availableServers) {
    return { defaultServers: servers };
  }

  const serversByName = new Map(servers.map((server) => [server.name, server]));
  const defaultNames = new Set(config.mcp.defaultServers ?? []);
  defaultNames.add("state");
  const availableNames = new Set(
    config.mcp.availableServers
      ?? servers
        .map((server) => server.name)
        .filter((name) => !defaultNames.has(name)),
  );

  const defaultServers = [...defaultNames]
    .map((name) => serversByName.get(name))
    .filter((server): server is AgentRuntimeConfig["mcpServers"][number] => Boolean(server));
  const availableServers = [...availableNames]
    .filter((name) => !defaultNames.has(name))
    .map((name) => serversByName.get(name))
    .filter((server): server is AgentRuntimeConfig["mcpServers"][number] => Boolean(server));

  return {
    defaultServers,
    ...(availableServers.length > 0 ? { availableServers } : {}),
  };
}

/**
 * True when an agent's turns are served by the Ollama runtime adapter rather
 * than the Claude Code CLI, derived from its (legacy) provider intent. This is
 * the single source of truth for the backend decision; both
 * {@link buildV2RuntimeConfigs} and the warm-start continuity resolver in
 * main.ts consult it so the two never drift.
 */
export function isOllamaBackedAgent(v2Config: V2AgentConfig | undefined): boolean {
  return v2Config?.legacyProvider?.default === "ollama";
}

export function buildV2EnabledAgentSet(
  v2Configs: ReadonlyMap<string, V2AgentConfig>,
): Set<string> {
  return new Set(
    [...v2Configs.entries()]
      .filter(([, config]) => isV2RuntimeEnabled(config))
      .map(([agentId]) => agentId),
  );
}

/**
 * The environment every MCP server of an agent gets: who is calling (the MCP
 * server derives the trusted `_requester_agent_id` and governance principal
 * from WORKER_ID) and whose memory it may touch. Text and voice turns must
 * both apply it, or tools on that path run without an identity.
 */
export function agentMcpIdentityEnv(agentId: string, v2Config: V2AgentConfig): Record<string, string> {
  const memoryScope = resolveV2MemoryScope(agentId, v2Config);
  return {
    WORKER_ID: agentId,
    TANGO_MEMORY_CANONICAL_AGENT_ID: memoryScope.canonicalAgentId,
    TANGO_MEMORY_ALIAS_AGENT_IDS: memoryScope.aliasAgentIds.join(","),
    ...(v2Config.isolated === true ? { TANGO_MEMORY_ISOLATED: "1" } : {}),
  };
}

export function buildV2RuntimeConfigs(
  v2Configs: ReadonlyMap<string, V2AgentConfig>,
  options: {
    repoRoot?: string;
  } = {},
): Map<string, AgentRuntimeConfig> {
  const runtimeConfigs = new Map<string, AgentRuntimeConfig>();

  for (const [agentId, v2Config] of v2Configs) {
    if (!isV2RuntimeEnabled(v2Config)) {
      continue;
    }

    const isolated = v2Config.isolated === true;
    // Shared state (projects, vehicles, …) is owner context; isolated agents
    // never get the implicit state server.
    const configuredServers = isolated || v2Config.mcpServers.some((server) => server.name === "state")
      ? v2Config.mcpServers
      : [...v2Config.mcpServers, buildStateMcpServerConfig()];
    const mcpServers = configuredServers.map((server) => ({
      ...server,
      env: {
        ...(server.env ?? {}),
        ...agentMcpIdentityEnv(agentId, v2Config),
      },
    }));
    const mcpMounts = splitMcpServersForMountPolicy(v2Config, mcpServers);
    runtimeConfigs.set(agentId, {
      agentId,
      systemPrompt: assembleV2SystemPrompt(v2Config, {
        repoRoot: options.repoRoot,
        // Parity with the legacy loader: load per-agent profile-owned prompt
        // overlays (~/.tango/profiles/<p>/prompts/agents/<id>/*.md). Ollama
        // clones also inherit their base persona's overlay before any
        // clone-specific overlay, so private/user-specific knowledge can live in
        // one profile location without being copied into repo defaults.
        overlayDirs: resolveTangoProfileAgentPromptDirs(agentId),
      }),
      mcpServers: mcpMounts.defaultServers,
      ...(mcpMounts.availableServers ? { availableMcpServers: mcpMounts.availableServers } : {}),
      runtimePreferences: {
        model: v2Config.runtime.model,
        reasoningEffort: normalizeRuntimeReasoningEffort(v2Config.runtime.reasoningEffort),
        timeout: resolveV2RuntimeTimeoutMs(v2Config, DEFAULT_V2_RUNTIME_TIMEOUT_MS),
      },
      // Route this agent's turns through the Ollama runtime adapter when its
      // (legacy) provider intent is "ollama"; otherwise use the Claude Code CLI.
      backend: isOllamaBackedAgent(v2Config) ? "ollama" : v2Config.runtime.backend ?? "claude-code",
      ...(isolated ? { isolated: true } : {}),
    });
  }

  return runtimeConfigs;
}

export function resolveV2RuntimeTimeoutMs(
  config: V2AgentConfig,
  defaultTimeoutMs: number,
): number {
  if (config.runtime.timeoutSeconds === 0) {
    return 0;
  }

  return config.runtime.timeoutSeconds ? config.runtime.timeoutSeconds * 1000 : defaultTimeoutMs;
}

export function createAtlasColdStartContextBuilder(
  atlasMemoryClient: Pick<AtlasMemoryClient, "pinnedFactGet" | "memorySearch">,
  options: {
    /**
     * Project-arc reseed: given the conversationKey, returns the project state
     * block (status / quick read / open items) so a rotated session re-orients
     * on where the project stands. See project-state.ts.
     */
    projectStateProvider?: (conversationKey: string) => string | undefined;
    stateDigestProvider?: (conversationKey: string, agentId: string) => string | undefined;
    attachmentStore?: AttachmentStore;
    v2Configs?: ReadonlyMap<string, V2AgentConfig>;
  } = {},
): ColdStartContextBuilder {
  return async (conversationKey, agentId) => {
    const agentConfig = options.v2Configs?.get(agentId);
    const memoryScope = resolveV2MemoryScope(agentId, agentConfig);
    const isolated = agentConfig?.isolated === true;
    const [pinnedFacts, agentFactGroups, relevantMemories] = await Promise.all([
      // Global pinned facts are owner context.
      isolated ? Promise.resolve([]) : atlasMemoryClient.pinnedFactGet({ scope: "global" }),
      Promise.all(
        memoryScope.aliasAgentIds.map((memoryAgentId) =>
          atlasMemoryClient.pinnedFactGet({ scope: "agent", scope_id: memoryAgentId }),
        ),
      ),
      atlasMemoryClient.memorySearch({
        query: "recent context",
        agent_id: memoryScope.canonicalAgentId,
        agent_ids: memoryScope.aliasAgentIds,
        limit: 5,
      }),
    ]);
    const agentFacts = agentFactGroups.flat();
    const attachmentContext =
      options.attachmentStore
        ? buildAttachmentDirectoryContext({
            store: options.attachmentStore,
            conversationKey,
            agentId,
          })
        : null;

    const projectBlock = isolated ? undefined : options.projectStateProvider?.(conversationKey);
    const stateDigest = isolated ? undefined : options.stateDigestProvider?.(conversationKey, agentId);

    return {
      pinnedFacts: formatPinnedFacts([...pinnedFacts, ...agentFacts]),
      recentMessages: [
        projectBlock ? `Project state:\n${projectBlock}` : "",
        stateDigest ?? "",
      ].filter(Boolean).join("\n\n"),
      relevantMemories: formatMemories(relevantMemories),
      ...(attachmentContext?.prompt ? { attachmentDirectories: attachmentContext.prompt } : {}),
    };
  };
}

export function createV2PostTurnHook(input: {
  v2Configs: ReadonlyMap<string, V2AgentConfig>;
  atlasMemoryClient: AtlasMemoryClient;
  /** Resolves a registered ChatProvider by name (e.g. "ollama", "claude-oauth"). */
  resolveProvider: (name: string) => ChatProvider | undefined;
  /**
   * Channels whose turns must never write Atlas memories (the -test smoke
   * channels: their context is deliberately isolated from the agents' real
   * memory scope). MEMORY extraction only — ACTIVE-TASK extraction is
   * scheduled separately via scheduleActiveTaskPostTurn and must keep running
   * in these channels (the live continuation smokes assert on it, TGO-743).
   */
  extractionSuppressedChannelIds?: ReadonlySet<string>;
  extractAndStoreMemoriesImpl?: typeof extractAndStoreMemories;
  stateService?: StateService;
  storage?: TangoStorage;
  runStateReconcilerImpl?: typeof runStateReconciler;
  publishStateReceipt?: (context: V2PostTurnContext, receipt: string) => Promise<void>;
}): (context: V2PostTurnContext) => Promise<void> {
  return async (context) => {
    const agentV2Config = input.v2Configs.get(context.agentId);
    let reconcilerOutcome: StateReconcilerOutcome | null = null;

    // Pass 1: typed canonical state. This always runs first. A failure is
    // fail-open: claimedStateFacts remains empty and memory extraction proceeds.
    // Isolated agents never read or write shared state.
    if (input.stateService && agentV2Config?.isolated !== true) {
      const runReconciler = input.runStateReconcilerImpl ?? runStateReconciler;
      reconcilerOutcome = await runReconciler({
        service: input.stateService,
        v2Config: agentV2Config,
        resolveProvider: input.resolveProvider,
        turn: {
          turnId: context.turnId,
          conversationKey: context.conversationKey,
          sessionId: context.sessionId,
          agentId: context.agentId,
          userMessage: context.userMessage,
          agentResponse: context.response.text,
          toolCalls: context.response.toolCalls,
          requestMessageId: context.requestMessageId ?? context.discordRequestMessageId,
          responseMessageId: context.responseMessageId ?? context.discordResponseMessageId,
          occurredAt: context.occurredAt,
        },
        onPersistentFailure: ({ providerName, model, prompt, error }) => {
          if (!input.storage) return;
          input.storage.insertDeadLetter({
            sessionId: context.sessionId,
            agentId: context.agentId,
            providerName,
            conversationKey: context.conversationKey,
            requestMessageId: context.requestMessageId ?? null,
            discordChannelId: context.channelId,
            promptText: prompt,
            systemPrompt: "State Reconciler",
            responseMode: "state-reconciler",
            lastErrorMessage: error,
            metadata: { kind: "state_reconciler", turnId: context.turnId, model },
          });
        },
        unarchiveMemories: async (eventIds) => {
          if (!input.stateService) return;
          const memoryIds = input.stateService.getArchivedMemoryIdsForEvents(eventIds);
          if (memoryIds.length === 0) return;
          await input.atlasMemoryClient.memoryAdmin({
            operation: "unarchive",
            filter: { ids: memoryIds, include_archived: true },
          });
          input.stateService.markMemoriesUnarchived(memoryIds);
        },
      });

      if (input.storage && reconcilerOutcome.providerName && reconcilerOutcome.model) {
        input.storage.insertModelRun({
          sessionId: context.sessionId,
          agentId: context.agentId,
          providerName: reconcilerOutcome.providerName,
          conversationKey: context.conversationKey,
          model: reconcilerOutcome.model,
          stopReason: reconcilerOutcome.status,
          responseMode: "state-reconciler",
          latencyMs: reconcilerOutcome.latencyMs,
          isError: reconcilerOutcome.status === "error",
          errorMessage: reconcilerOutcome.error ?? null,
          requestMessageId: context.requestMessageId ?? null,
          responseMessageId: context.responseMessageId ?? null,
          metadata: {
            kind: "state_reconciler",
            turnId: context.turnId,
            proposals: reconcilerOutcome.proposals,
            appliedEventIds: reconcilerOutcome.appliedEventIds,
            rejected: reconcilerOutcome.rejected,
          },
        });
      }
    }

    // State visibility is part of the state pass, not a tail action. Publish
    // before memory/task work so a downstream extractor failure cannot hide a
    // successfully committed mutation from the user.
    const receipt = input.stateService?.renderTurnReceipt(context.turnId);
    if (receipt && input.publishStateReceipt) {
      try {
        await input.publishStateReceipt(context, receipt);
      } catch (error) {
        console.warn(
          `[tango-state] failed to publish receipt turn=${context.turnId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Pass 2: Atlas memory, suppressing only facts successfully claimed by
    // state. Test channels remain memory-inert but still run reconciliation.
    const memorySuppressed = input.extractionSuppressedChannelIds?.has(context.channelId) ?? false;
    if (!memorySuppressed && agentV2Config?.memory.postTurnExtraction === "enabled") {
      const memoryScope = resolveV2MemoryScope(context.agentId, agentV2Config);
      const extractionProvider = resolveExtractionProvider(
        agentV2Config,
        agentV2Config.memory.extractionProvider,
        agentV2Config.memory.extractionModel,
      );
      const provider = input.resolveProvider(extractionProvider);
      if (!provider) {
        console.warn(
          `[memory-capture] no provider '${extractionProvider}' registered for agent ${context.agentId}; skipping post-turn extraction`,
        );
      } else {
        const captureConfig: MemoryCaptureConfig = {
          enabled: true,
          extractionProvider,
          extractionModel: agentV2Config.memory.extractionModel,
          importanceThreshold: agentV2Config.memory.importanceThreshold,
        };
        const extractAndStore = input.extractAndStoreMemoriesImpl ?? extractAndStoreMemories;
        await extractAndStore(
          {
            conversationKey: context.conversationKey,
            agentId: memoryScope.canonicalAgentId,
            runtimeAgentId: context.agentId,
            userMessage: context.userMessage,
            agentResponse: context.response.text,
            channelId: context.channelId,
            ...(context.threadId ? { threadId: context.threadId } : {}),
            turnId: context.turnId,
            ...(context.requestMessageId !== undefined ? { requestMessageId: context.requestMessageId } : {}),
            ...(context.responseMessageId !== undefined ? { responseMessageId: context.responseMessageId } : {}),
            ...(context.discordRequestMessageId !== undefined ? { discordRequestMessageId: context.discordRequestMessageId } : {}),
            ...(context.discordResponseMessageId !== undefined ? { discordResponseMessageId: context.discordResponseMessageId } : {}),
            ...(context.occurredAt ? { occurredAt: context.occurredAt } : {}),
            ...(context.contextRef ? { contextRef: context.contextRef } : {}),
            ...(context.contextLabel ? { contextLabel: context.contextLabel } : {}),
            claimedStateFacts: reconcilerOutcome?.status === "ok" ? reconcilerOutcome.claimedFacts : [],
          },
          captureConfig,
          input.atlasMemoryClient,
          provider,
        );
      }
    }

    // Pass 3: active-task continuation. This is sequenced after state/memory,
    // rather than racing as a second fire-and-forget hook.
    if (input.storage) {
      await runActiveTaskPostTurn({
        storage: input.storage,
        v2Config: agentV2Config,
        resolveProvider: input.resolveProvider,
        context: {
          sessionId: context.sessionId,
          agentId: context.agentId,
          userMessage: context.userMessage,
          agentResponse: context.response.text,
          toolsUsed: context.response.toolsUsed,
          requestMessageId: context.requestMessageId,
          responseMessageId: context.responseMessageId,
        },
      });
    }

  };
}

export interface V2PostTurnContext {
  turnId: string;
  conversationKey: string;
  sessionId: string;
  agentId: string;
  userMessage: string;
  response: RuntimeResponse;
  channelId: string;
  threadId?: string;
  requestMessageId?: number | null;
  responseMessageId?: number | null;
  discordRequestMessageId?: string | null;
  discordResponseMessageId?: string | null;
  occurredAt?: string;
  contextRef?: string;
  contextLabel?: string;
}

export async function routeV2MessageIfEnabled(
  params: FeatureFlaggedRouteRequest,
  input: {
    v2EnabledAgents: ReadonlySet<string>;
    tangoRouter: Pick<FeatureFlaggedRouter, "routeMessage">;
    recoverFromRuntimeFailure?: V2RuntimeFailureRecovery;
  },
): Promise<FeatureFlaggedRouteResult | null> {
  if (!input.v2EnabledAgents.has(params.agentId)) {
    return null;
  }

  try {
    return await input.tangoRouter.routeMessage({
      message: params.message,
      ...(params.conversationKey ? { conversationKey: params.conversationKey } : {}),
      channelId: params.channelId,
      ...(params.threadId ? { threadId: params.threadId } : {}),
      ...(params.messageId ? { messageId: params.messageId } : {}),
      ...(params.occurredAt ? { occurredAt: params.occurredAt } : {}),
      ...(params.contextRef ? { contextRef: params.contextRef } : {}),
      ...(params.contextLabel ? { contextLabel: params.contextLabel } : {}),
      agentId: params.agentId,
      sendOptions: params.sendOptions,
    });
  } catch (error) {
    const recovered = await input.recoverFromRuntimeFailure?.(params, error);
    if (recovered) {
      return recovered;
    }
    throw error;
  }
}

export async function shutdownV2Runtime(input: {
  tangoRouter: Pick<FeatureFlaggedRouter, "shutdown">;
  atlasMemoryClient: Pick<AtlasMemoryClient, "close">;
}): Promise<void> {
  try {
    await input.tangoRouter.shutdown();
  } finally {
    input.atlasMemoryClient.close();
  }
}

export function formatPinnedFacts(facts: readonly PinnedFactRecord[]): string {
  if (facts.length === 0) {
    return "";
  }

  return facts.map((fact) => `- ${fact.key}: ${fact.value}`).join("\n");
}

export function formatMemories(memories: readonly MemoryRecord[]): string {
  if (memories.length === 0) {
    return "";
  }

  return [
    `Guidance: ${RETRIEVED_MEMORY_GUIDANCE}`,
    ...memories.map((memory) => formatRetrievedMemoryLine(memory, {
      includeTags: true,
      maxContentChars: 220,
    })),
  ].join("\n");
}

function normalizeRuntimeReasoningEffort(
  value: V2AgentConfig["runtime"]["reasoningEffort"],
): ReasoningEffort {
  return value === "xhigh" ? "max" : value;
}
