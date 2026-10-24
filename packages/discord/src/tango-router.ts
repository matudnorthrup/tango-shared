import {
  RuntimePool,
  SessionLifecycleManager,
  selectMcpServersForTurn,
  type AgentRuntimeConfig,
  type ChatProvider,
  type LoomSessionStore,
  type ColdStartContextBuilder,
  type ContextAutoResetNotice,
  type ConversationSession,
  type RuntimeResponse,
  type SendOptions,
  type SessionLifecycleConfig,
} from "@tango/core";
import { randomUUID } from "node:crypto";
import { augmentRuntimeConfigWithDiscordProvenance } from "./discord-memory-provenance.js";

export interface TangoRouterConfig {
  /** Map of agent IDs to their v2 runtime configs */
  agentConfigs: Map<string, AgentRuntimeConfig>;
  /** Session lifecycle settings */
  lifecycleConfig?: Partial<SessionLifecycleConfig>;
  /** Build cold-start context for a conversation */
  buildColdStartContext?: ColdStartContextBuilder;
  /** Post-turn hook (e.g., memory extraction) */
  onPostTurn?: (context: PostTurnContext) => Promise<void>;
  /**
   * Stateless chat provider used for agents whose runtime config sets
   * backend: "ollama". Passed through to the RuntimePool.
   */
  loomSessionStore?: () => LoomSessionStore;
  ollamaProvider?: ChatProvider;
}

export interface PostTurnContext {
  turnId: string;
  conversationKey: string;
  agentId: string;
  userMessage: string;
  response: RuntimeResponse;
  channelId: string;
  threadId?: string;
  occurredAt?: string;
  contextRef?: string;
  contextLabel?: string;
}

export interface RouteResult {
  response: RuntimeResponse;
  agentId: string;
  conversationKey: string;
  turnId: string;
}

const INTERNAL_WORKER_DISPATCH_FALLBACK =
  "Sorry, I tried to use an internal worker handoff that is not available in this runtime. Please ask again and I will handle it directly.";

export function sanitizeInternalWorkerDispatchResponse(response: RuntimeResponse): RuntimeResponse {
  if (!response.text.includes("<worker-dispatch")) {
    return response;
  }

  return {
    ...response,
    text: INTERNAL_WORKER_DISPATCH_FALLBACK,
    metadata: {
      ...response.metadata,
      sanitizedInternalWorkerDispatch: true,
      originalTextLength: response.text.length,
    },
  };
}

function attachMcpSelectionMetadata(
  response: RuntimeResponse,
  selection: AgentRuntimeConfig["mcpMountSelection"],
): RuntimeResponse {
  if (!selection) {
    return response;
  }

  return {
    ...response,
    metadata: {
      ...(response.metadata ?? {}),
      mcpTooling: selection,
    },
  };
}

export class TangoRouter {
  private readonly lifecycleManager: SessionLifecycleManager;
  private readonly agentConfigs: Map<string, AgentRuntimeConfig>;
  private readonly onPostTurn?: (context: PostTurnContext) => Promise<void>;

  constructor(config: TangoRouterConfig) {
    this.agentConfigs = config.agentConfigs;
    this.onPostTurn = config.onPostTurn;
    this.lifecycleManager = new SessionLifecycleManager(
      new RuntimePool({ ollamaProvider: config.ollamaProvider, loomSessionStore: config.loomSessionStore }),
      config.lifecycleConfig,
      config.buildColdStartContext,
    );
    this.lifecycleManager.startIdleChecker();
  }

  /**
   * Route a message to the appropriate agent runtime.
   * This is the main entry point — replaces executeTurn().
   */
  async routeMessage(params: {
    message: string;
    channelId: string;
    threadId?: string;
    messageId?: string;
    occurredAt?: string;
    contextRef?: string;
    contextLabel?: string;
    conversationKey?: string;
    /**
     * Conversation identity exposed to tools as TANGO_CONVERSATION_KEY when it
     * differs from the session key (voice sessions key by `session:agent[:thread]`
     * but tools, memory and the desk need the canonical thread:/channel: key).
     * Defaults to the session key.
     */
    provenanceConversationKey?: string;
    /**
     * The canonical channel/thread for tool provenance when routing uses a different (heuristic)
     * channel/thread, as voice does for non-default channels. Defaults to channelId/threadId.
     */
    provenanceChannel?: { channelId: string; threadId?: string };
    agentId: string;
    sendOptions?: SendOptions;
  }): Promise<RouteResult> {
    const turnId = randomUUID();
    const conversationKey =
      params.conversationKey?.trim()
      || this.getConversationKey(params.channelId, params.threadId);
    const baseAgentConfig = augmentRuntimeConfigWithDiscordProvenance(
      this.resolveAgentConfig(params.agentId),
      {
        conversationKey: params.provenanceConversationKey?.trim() || conversationKey,
        channelId: params.provenanceChannel?.channelId ?? params.channelId,
        ...((params.provenanceChannel ? params.provenanceChannel.threadId : params.threadId)
          ? { threadId: (params.provenanceChannel ? params.provenanceChannel.threadId : params.threadId)! }
          : {}),
        turnId,
        ...(params.messageId ? { messageId: params.messageId } : {}),
        ...(params.occurredAt ? { occurredAt: params.occurredAt } : {}),
        ...(params.contextRef ? { contextRef: params.contextRef } : {}),
        ...(params.contextLabel ? { contextLabel: params.contextLabel } : {}),
      },
    );
    const { config: agentConfig, selection: mcpSelection } = selectMcpServersForTurn(
      baseAgentConfig,
      {
        message: params.message,
        sendOptions: params.sendOptions,
      },
    );
    const runtimeResponse = await this.lifecycleManager.sendMessage(
      conversationKey,
      agentConfig,
      params.message,
      params.sendOptions,
    );
    const sanitizedResponse = sanitizeInternalWorkerDispatchResponse(runtimeResponse);
    const response = attachMcpSelectionMetadata(sanitizedResponse, mcpSelection);
    if (sanitizedResponse !== runtimeResponse) {
      console.warn(
        `[tango-router] suppressed internal worker-dispatch markup for ${conversationKey} agent=${params.agentId}`,
      );
    }

    this.schedulePostTurn({
      conversationKey,
      turnId,
      agentId: params.agentId,
      userMessage: params.message,
      response,
      channelId: params.channelId,
      ...(params.threadId ? { threadId: params.threadId } : {}),
      ...(params.occurredAt ? { occurredAt: params.occurredAt } : {}),
      ...(params.contextRef ? { contextRef: params.contextRef } : {}),
      ...(params.contextLabel ? { contextLabel: params.contextLabel } : {}),
    });

    return {
      response,
      agentId: params.agentId,
      conversationKey,
      turnId,
    };
  }

  /** Get the conversation key for a channel/thread */
  getConversationKey(channelId: string, threadId?: string): string {
    return threadId ? `thread:${threadId}` : `channel:${channelId}`;
  }

  /** Force reset a conversation (new provider session on next message). */
  async resetConversation(channelId: string, threadId?: string): Promise<void> {
    const conversationKey = this.getConversationKey(channelId, threadId);
    const session = this.lifecycleManager.getSession(conversationKey);

    if (!session) {
      return;
    }

    const agentConfig = this.resolveAgentConfig(session.agentId);
    await this.lifecycleManager.resetSession(conversationKey, agentConfig);
  }

  /** Abort an in-flight generation without rotating the provider session. */
  async abortConversation(channelId: string, threadId?: string): Promise<boolean> {
    const conversationKey = this.getConversationKey(channelId, threadId);
    return await this.lifecycleManager.abortActiveRun(conversationKey);
  }

  /** Get lifecycle session metadata for a channel/thread conversation. */
  getSession(channelId: string, threadId?: string): ConversationSession | undefined {
    return this.lifecycleManager.getSession(this.getConversationKey(channelId, threadId));
  }

  /**
   * T-I-035: lookup by raw conversation key, for sessions routed with an
   * explicit key (voice `agent:…` keys, schedule/collaboration keys) that
   * channel/thread derivation can never reach.
   */
  getSessionByKey(conversationKey: string): ConversationSession | undefined {
    return this.lifecycleManager.getSession(conversationKey);
  }

  markContextPressureAlertSent(channelId: string, threadId?: string): void {
    this.lifecycleManager.markContextPressureAlertSent(this.getConversationKey(channelId, threadId));
  }

  /** T-I-035: mark-sent by raw conversation key (voice/schedule/collab sessions). */
  markContextPressureAlertSentByKey(conversationKey: string): void {
    this.lifecycleManager.markContextPressureAlertSent(conversationKey);
  }

  consumeContextAutoResetNotice(
    channelId: string,
    threadId?: string,
  ): ContextAutoResetNotice | undefined {
    return this.lifecycleManager.consumeContextAutoResetNotice(
      this.getConversationKey(channelId, threadId),
    );
  }

  restoreContextAutoResetNotice(
    channelId: string,
    threadId: string | undefined,
    notice: ContextAutoResetNotice,
  ): void {
    this.lifecycleManager.restoreContextAutoResetNotice(
      this.getConversationKey(channelId, threadId),
      notice,
    );
  }

  /** Shut down all runtimes */
  async shutdown(): Promise<void> {
    await this.lifecycleManager.shutdown();
  }

  private resolveAgentConfig(agentId: string): AgentRuntimeConfig {
    const agentConfig = this.agentConfigs.get(agentId);
    if (!agentConfig) {
      throw new Error(`Unknown agentId '${agentId}'. No runtime config is registered.`);
    }

    return agentConfig;
  }

  private schedulePostTurn(context: PostTurnContext): void {
    if (!this.onPostTurn) {
      return;
    }

    setImmediate(() => {
      void this.onPostTurn?.(context).catch((error) => {
        console.warn(
          `[tango-router] post-turn hook failed for ${context.conversationKey}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });
  }
}
