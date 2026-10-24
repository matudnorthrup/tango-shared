import { randomUUID } from "node:crypto";
import {
  ClaudeCodeTimeoutError,
  classifyClaudeCodeFailureError,
  type AgentRuntimeConfig,
  type ChatProvider,
  type ClaudeCodeFailureReason,
  type V2AgentConfig,
} from "@tango/core";
import {
  isOllamaBackedAgent,
  type FeatureFlaggedRouteRequest,
  type FeatureFlaggedRouteResult,
  type V2RuntimeFailureRecovery,
} from "./v2-runtime.js";

/**
 * Degraded-mode recovery for v2 Claude Code turns (TGO-846).
 *
 * The v2 runtime binds each Claude agent to the Claude Code CLI with no
 * provider chain, so before this module a usage-limit, overload, auth, or
 * timeout failure was terminal ("Something went wrong…" + dead letter). This
 * factory generalizes the old timeout-only Codex hop into a config-driven
 * chain: after the ClaudeCodeAdapter has already exhausted the secondary
 * Claude CLI internally, the turn degrades to the stateless providers named in
 * the agent's `provider.fallback` YAML list — in practice Codex, then Ollama.
 *
 * Degraded hops run without tools; the injected system-prompt note keeps the
 * model honest about that. If every hop fails the recovery declines (returns
 * null) and the caller's existing dead-letter path takes over.
 */

/** Stateless providers a degraded turn may hop to. The secondary Claude CLI is
 * not listed: ClaudeCodeAdapter.send() already retries it in-process. */
const DEGRADED_PROVIDER_NAMES = new Set(["codex", "ollama"]);

export interface V2RuntimeRecoveryDeps {
  v2Configs: ReadonlyMap<string, V2AgentConfig>;
  v2RuntimeConfigs: ReadonlyMap<string, AgentRuntimeConfig>;
  resolveProvider: (name: string) => ChatProvider | undefined;
  buildConversationKey: (channelId: string, threadId?: string) => string;
  log?: (message: string) => void;
}

export function resolveDegradedProviderChain(config: V2AgentConfig | undefined): string[] {
  const configured = (config?.legacyProvider?.fallback ?? []).filter((name) =>
    DEGRADED_PROVIDER_NAMES.has(name),
  );
  if (configured.length > 0) {
    return [...new Set(configured)];
  }
  return config?.runtime.fallback === "codex" ? ["codex"] : [];
}

export function buildV2RecoveryPrompt(params: FeatureFlaggedRouteRequest): string {
  const options = params.sendOptions;
  const sections = [
    options?.context?.trim() ? `Context:\n${options.context.trim()}` : "",
    options?.currentTurnMetadataPrompt?.trim() ?? "",
    options?.turnBriefingPrompt?.trim() ?? "",
    params.message,
  ].filter((section) => section.trim().length > 0);
  return sections.join("\n\n");
}

export function buildDegradedModeNote(reason: ClaudeCodeFailureReason, error?: unknown): string {
  if (error instanceof ClaudeCodeTimeoutError && !error.stalled) {
    const minutes = Math.round(error.timeoutMs / 60_000);
    return (
      `Runtime recovery: the tool-enabled run for this message was still working when it hit its ${minutes}-minute time budget and was stopped. `
      + "Its intermediate findings are not available to you. "
      + "Do not claim to have completed an external read, write, or search that is not in the supplied context. "
      + "Tell the user plainly that the work ran out of time before finishing, share anything useful from the supplied context, "
      + "and offer to continue in smaller steps or as a background job."
    );
  }
  return (
    `Runtime recovery: the primary tool-enabled runtime is unavailable (${reason}). `
    + "Use only the supplied context and user message. "
    + "Do not claim to have completed an external read, write, or search that is not in the supplied context. "
    + "Give the most useful concise answer or next action available from that context."
  );
}

export function createV2RuntimeFailureRecovery(deps: V2RuntimeRecoveryDeps): V2RuntimeFailureRecovery {
  return async (
    params: FeatureFlaggedRouteRequest,
    error: unknown,
  ): Promise<FeatureFlaggedRouteResult | null> => {
    const agentConfig = deps.v2Configs.get(params.agentId);
    const runtimeConfig = deps.v2RuntimeConfigs.get(params.agentId);
    if (!runtimeConfig || isOllamaBackedAgent(agentConfig)) {
      return null;
    }

    const reason = classifyClaudeCodeFailureError(error);
    if (!reason) {
      return null;
    }

    for (const providerName of resolveDegradedProviderChain(agentConfig)) {
      const provider = deps.resolveProvider(providerName);
      if (!provider) {
        deps.log?.(
          `[v2-recovery] agent=${params.agentId} reason=${reason} provider=${providerName} skipped: not registered`,
        );
        continue;
      }

      const startedAt = Date.now();
      try {
        const response = await provider.generate({
          prompt: buildV2RecoveryPrompt(params),
          systemPrompt: [runtimeConfig.systemPrompt, buildDegradedModeNote(reason, error)].join("\n\n"),
          ...(providerName === "codex" ? { reasoningEffort: "medium" as const } : {}),
        });

        deps.log?.(
          `[v2-recovery] agent=${params.agentId} reason=${reason} provider=${providerName} recovered ms=${Date.now() - startedAt}`,
        );

        return {
          agentId: params.agentId,
          conversationKey: params.conversationKey ?? deps.buildConversationKey(params.channelId, params.threadId),
          turnId: randomUUID(),
          response: {
            text: response.text,
            durationMs: Date.now() - startedAt,
            ...(response.metadata?.model ? { model: response.metadata.model } : {}),
            ...(response.toolCalls?.length ? { toolCalls: response.toolCalls } : {}),
            ...(response.toolCalls?.length
              ? { toolsUsed: [...new Set(response.toolCalls.map((toolCall) => toolCall.name))] }
              : {}),
            metadata: {
              backend: `${providerName}-fallback`,
              degradedReason: reason,
              primaryFailure: error instanceof Error ? error.message : String(error),
              ...(response.metadata ? { providerMetadata: response.metadata } : {}),
              ...(response.raw !== undefined ? { raw: response.raw } : {}),
            },
          },
        };
      } catch (recoveryError) {
        deps.log?.(
          `[v2-recovery] agent=${params.agentId} reason=${reason} provider=${providerName} failed: `
          + `${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
        );
      }
    }

    return null;
  };
}
