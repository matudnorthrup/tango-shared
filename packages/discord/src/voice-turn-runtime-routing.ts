import {
  isV2RuntimeEnabled,
  type RuntimeResponse,
  type SendOptions,
  type V2AgentConfig,
} from "@tango/core";
import type { VoiceTurnResult } from "@tango/voice";
import type { RouteResult, TangoRouter } from "./tango-router.js";
import { classifyDeskTurnFailure } from "./desk-events.js";

export const VOICE_V2_ROUTER_TIMEOUT_MS = 900_000;
export const VOICE_V2_TTS_ERROR_MESSAGE = "Sorry, I'm having trouble. Try again.";
export const VOICE_RESPONSE_FORMATTING_SYSTEM_PROMPT = [
  "The user is speaking to you via voice, and your response will be read aloud by text-to-speech.",
  "Keep your response concise and conversational — use plain spoken language, not written formatting.",
  "Never use markdown formatting: no tables, no bold/italic, no headers, no code blocks, no bullet lists.",
  "If there are many items (transactions, logs, entries), summarize the top 3-5 and offer to continue rather than listing everything.",
  "Break complex information into short, digestible sentences.",
  "Avoid reading out IDs, URLs, or long reference numbers — paraphrase or omit them.",
  "If the user asks to see something visual (a screenshot, photo, map, or page), send it with the discord_send_image tool — it posts into this conversation's synced Discord channel — and only after it succeeds, tell them in speech where you put it (e.g. 'I dropped the screenshot in our channel').",
  "Never claim an image was sent or shown unless discord_send_image returned a message_id this turn.",
].join(" ");

function resolveVoiceProviderName(v2AgentConfig: V2AgentConfig): string {
  // Mirror isOllamaBackedAgent: label Ollama-backed voice turns "ollama" instead of
  // using runtime.provider ("claude-code-v2"), which was recorded for every clone.
  return v2AgentConfig.legacyProvider?.default === "ollama"
    ? "ollama"
    : v2AgentConfig.runtime.provider;
}

function extractProviderSessionId(response: RuntimeResponse): string | undefined {
  const metadata = response.metadata;
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }

  const sessionId = (metadata as Record<string, unknown>).sessionId;
  if (typeof sessionId !== "string") {
    return undefined;
  }

  const normalized = sessionId.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function buildVoiceRouterResult(input: {
  routeResult: RouteResult;
  v2AgentConfig: V2AgentConfig;
  turnId?: string;
}): VoiceTurnResult {
  const result: VoiceTurnResult = {
    deduplicated: false,
    responseText: input.routeResult.response.text,
    providerName: resolveVoiceProviderName(input.v2AgentConfig),
    providerSessionId: extractProviderSessionId(input.routeResult.response),
    providerUsedFailover: false,
  };

  if (input.turnId) {
    result.turnId = input.turnId;
  }

  return result;
}

/**
 * A failed voice turn keeps answering 200 with the spoken fallback in
 * `responseText` (older clients and the live operator key on that text), and
 * now also says so explicitly: `failed: true` plus a `failureReason`.
 */
export function buildVoiceRouterErrorResult(input: {
  v2AgentConfig: V2AgentConfig;
  turnId?: string;
  responseText?: string;
  /** "empty-reply" or a desk failure reason; defaults to "error". */
  failureReason?: string;
}): VoiceTurnResult {
  const fallbackText = input.responseText?.trim() || VOICE_V2_TTS_ERROR_MESSAGE;
  const result: VoiceTurnResult = {
    deduplicated: false,
    responseText: fallbackText,
    providerName: resolveVoiceProviderName(input.v2AgentConfig),
    providerUsedFailover: false,
    failed: true,
    failureReason: input.failureReason?.trim() || "error",
  };

  if (input.turnId) {
    result.turnId = input.turnId;
  }

  return result;
}

/** Failure reason for a thrown voice router error (same categories as desk events). */
export function classifyVoiceRouterFailure(error: unknown): string {
  return classifyDeskTurnFailure(error).reason;
}

/**
 * Receipt metadata for a failed turn. The receipt itself stays `completed`
 * (a replay of the same utterance returns the same fallback instead of an
 * HTTP error), and the flag rides along so the replay is marked failed too.
 */
export function voiceTurnFailureMetadata(result: Pick<VoiceTurnResult, "failed" | "failureReason">): Record<string, unknown> {
  return result.failed ? { failed: true, failureReason: result.failureReason ?? "error" } : {};
}

export async function dispatchVoiceTurnByRuntime<T>(input: {
  transcript: string;
  agentId: string;
  channelId: string;
  threadId?: string;
  conversationKey?: string;
  /** Canonical thread:/channel: key for tool provenance; the session key stays `conversationKey`. */
  provenanceConversationKey?: string;
  /** Canonical channel/thread for tool provenance (see TangoRouter.routeMessage). */
  provenanceChannel?: { channelId: string; threadId?: string };
  v2AgentConfig?: V2AgentConfig | null;
  tangoRouter?: Pick<TangoRouter, "routeMessage"> | null;
  mapRouterResult: (routeResult: RouteResult) => Promise<T> | T;
  onRouterError?: (error: unknown) => Promise<T> | T;
  sendOptions?: SendOptions;
  timeoutMs?: number;
}): Promise<T> {
  if (!input.v2AgentConfig || !isV2RuntimeEnabled(input.v2AgentConfig)) {
    throw new Error(`Agent '${input.agentId}' is not configured for the v2 voice runtime.`);
  }

  if (!input.tangoRouter) {
    throw new Error(
      `V2 voice runtime is enabled for agent '${input.agentId}', but TangoRouter is not configured.`,
    );
  }

  try {
    const routeResult = await input.tangoRouter.routeMessage({
      message: input.transcript,
      channelId: input.channelId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.conversationKey ? { conversationKey: input.conversationKey } : {}),
      ...(input.provenanceConversationKey ? { provenanceConversationKey: input.provenanceConversationKey } : {}),
      ...(input.provenanceChannel ? { provenanceChannel: input.provenanceChannel } : {}),
      agentId: input.agentId,
      sendOptions: {
        timeout: input.timeoutMs ?? VOICE_V2_ROUTER_TIMEOUT_MS,
        ...input.sendOptions,
      },
    });
    return await input.mapRouterResult(routeResult);
  } catch (error) {
    if (input.onRouterError) {
      return await input.onRouterError(error);
    }
    throw error;
  }
}
