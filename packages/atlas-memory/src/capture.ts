import { withMemoryOrigin } from "./origin.js";
import type { AtlasMemoryClient } from "./memory-client.js";

/**
 * The one model call extraction makes: core's ChatProvider fits it, and so does any OpenAI-compatible client
 * (the desk's Loom capture), without this package depending on core.
 */
export interface ChatProvider {
  generate(request: { prompt: string; model?: string; reasoningEffort?: "low" | "medium" | "high" }): Promise<{ text: string }>;
}

export interface MemoryCaptureConfig {
  enabled: boolean;
  /** Registered provider name used to run extraction (e.g. "claude-oauth", "ollama"). */
  extractionProvider: string;
  extractionModel: string;
  importanceThreshold: number;
}

export interface MemoryCaptureContext {
  conversationKey: string;
  agentId: string;
  runtimeAgentId?: string;
  userMessage: string;
  agentResponse: string;
  channelId: string;
  threadId?: string;
  turnId?: string;
  requestMessageId?: number | null;
  responseMessageId?: number | null;
  discordRequestMessageId?: string | null;
  discordResponseMessageId?: string | null;
  occurredAt?: string;
  contextRef?: string;
  contextLabel?: string;
  /** State-shaped facts already claimed by the first post-turn pass. */
  claimedStateFacts?: string[];
}

interface ExtractedMemory {
  content: string;
  importance: number;
  tags: string[];
}

/**
 * Post-turn memory extraction.
 * Called from TangoRouter's onPostTurn hook.
 * Uses a lightweight model to extract salient facts from the exchange.
 *
 * Example wiring:
 * ```ts
 * const router = new TangoRouter({
 *   agentConfigs,
 *   onPostTurn: async (context) => {
 *     await extractAndStoreMemories(
 *       {
 *         conversationKey: context.conversationKey,
 *         agentId: context.agentId,
 *         userMessage: context.userMessage,
 *         agentResponse: context.response.text,
 *         channelId: context.channelId,
 *         threadId: context.threadId,
 *       },
 *       agentMemoryConfig,
 *       atlasMemoryClient,
 *     );
 *   },
 * });
 * ```
 */
export async function extractAndStoreMemories(
  context: MemoryCaptureContext,
  config: MemoryCaptureConfig,
  atlasMemoryEndpoint: AtlasMemoryClient,
  provider: ChatProvider,
): Promise<void> {
  if (!config.enabled) {
    return;
  }

  try {
    const extractedMemories = await extractWithRetry(context, config, provider);

    for (const memory of extractedMemories) {
      if (memory.importance < config.importanceThreshold) {
        continue;
      }

      try {
        await atlasMemoryEndpoint.memoryAdd({
          content: memory.content,
          source: "conversation",
          agent_id: context.agentId,
          session_id: context.conversationKey,
          importance: memory.importance,
          tags: memory.tags,
          metadata: withMemoryOrigin({
            captured_by: "post_turn_extraction",
            conversation_key: context.conversationKey,
            channel_id: context.channelId,
            ...(context.turnId ? { turn_id: context.turnId } : {}),
            ...(context.requestMessageId !== undefined ? { request_message_id: context.requestMessageId } : {}),
            ...(context.responseMessageId !== undefined ? { response_message_id: context.responseMessageId } : {}),
            ...(context.discordRequestMessageId ? { message_id: context.discordRequestMessageId } : {}),
            ...(context.discordResponseMessageId ? { discord_response_message_id: context.discordResponseMessageId } : {}),
            ...(context.occurredAt ? { occurred_at: context.occurredAt } : {}),
            ...(context.contextRef ? { context_ref: context.contextRef } : {}),
            ...(context.contextLabel ? { context_label: context.contextLabel } : {}),
            ...(context.runtimeAgentId && context.runtimeAgentId !== context.agentId
              ? { runtime_agent_id: context.runtimeAgentId }
              : {}),
            ...(context.threadId ? { thread_id: context.threadId } : {}),
            extraction_provider: config.extractionProvider,
            extraction_model: config.extractionModel,
          }, {
            source: "conversation",
            occurredAt: context.occurredAt,
            contextLabel: context.contextLabel,
            contextRef: context.contextRef,
          }),
        });
      } catch (error) {
        console.warn(
          `[memory-capture] failed to store extracted memory for ${context.conversationKey}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  } catch (error) {
    extractionFailureCount += 1;
    console.warn(
      `[memory-capture] extraction failed for ${context.conversationKey} after ${EXTRACTION_MAX_ATTEMPTS} attempts: ${
        error instanceof Error ? error.message : String(error)
      } (since boot: ${extractionFailureCount} failed / ${extractionSuccessCount} ok)`,
    );
  }
}

const EXTRACTION_MAX_ATTEMPTS = 2;
const EXTRACTION_RETRY_DELAY_MS = 2_000;

let extractionSuccessCount = 0;
let extractionFailureCount = 0;

async function extractWithRetry(
  context: MemoryCaptureContext,
  config: MemoryCaptureConfig,
  provider: ChatProvider,
): Promise<ExtractedMemory[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= EXTRACTION_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await provider.generate({
        prompt: buildExtractionPrompt(context),
        model: config.extractionModel,
        reasoningEffort: "low",
      });
      const extracted = parseExtractionResponse(response.text);
      extractionSuccessCount += 1;
      return extracted;
    } catch (error) {
      lastError = error;
      if (attempt < EXTRACTION_MAX_ATTEMPTS) {
        // Empty/garbled extraction responses are usually transient provider
        // hiccups (e.g. "Ollama returned an empty response") — retry once.
        await new Promise((resolve) => setTimeout(resolve, EXTRACTION_RETRY_DELAY_MS));
      }
    }
  }
  throw lastError;
}

function buildExtractionPrompt(context: MemoryCaptureContext): string {
  return [
    "Extract any facts, decisions, preferences, or commitments worth remembering from this exchange.",
    "Do not extract volatile current-state facts claimed by the State Reconciler; state owns those facts.",
    "Return a JSON array of objects: [{content, importance (0-1), tags: string[]}].",
    "If nothing worth remembering, return [].",
    ...(context.claimedStateFacts?.length
      ? ["State-claimed facts to suppress:", ...context.claimedStateFacts.map((fact) => `- ${fact}`), ""]
      : []),
    "",
    `User: ${context.userMessage}`,
    `Agent: ${context.agentResponse}`,
  ].join("\n");
}

function parseExtractionResponse(text: string): ExtractedMemory[] {
  for (const candidate of buildJsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate);
      if (!Array.isArray(parsed)) {
        continue;
      }

      return parsed.flatMap(normalizeExtractedMemory);
    } catch {
      continue;
    }
  }

  throw new Error("Extraction model did not return a valid JSON array");
}

function buildJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const trimmed = text.trim();

  if (trimmed.length > 0) {
    candidates.push(trimmed);
  }

  const fencedJsonPattern = /```(?:json)?\s*([\s\S]*?)```/giu;
  for (const match of text.matchAll(fencedJsonPattern)) {
    const candidate = match[1]?.trim();
    if (candidate) {
      candidates.push(candidate);
    }
  }

  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) {
    candidates.push(text.slice(start, end + 1).trim());
  }

  return [...new Set(candidates.filter((candidate) => candidate.length > 0))];
}

function normalizeExtractedMemory(value: unknown): ExtractedMemory[] {
  if (!isRecord(value)) {
    return [];
  }

  const content = normalizeNonEmptyString(value.content);
  const importance = normalizeImportance(value.importance);
  if (!content || importance === null) {
    return [];
  }

  return [{
    content,
    importance,
    tags: normalizeTags(value.tags),
  }];
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeImportance(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) {
    return null;
  }

  return Math.min(Math.max(numeric, 0), 1);
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const tags: string[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }

    const normalized = item.trim().toLowerCase();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    tags.push(normalized);
  }

  return tags;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
