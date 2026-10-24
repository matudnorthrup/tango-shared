import { withMemoryOrigin } from "./origin.js";
import type { MemorySource } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

/** Discord location env vars injected by TangoRouter into the atlas-memory MCP server. */
export function readDiscordProvenanceFromEnv(): Record<string, string> {
  const result: Record<string, string> = {};

  const conversationKey = process.env.TANGO_CONVERSATION_KEY?.trim();
  if (conversationKey) {
    result.conversation_key = conversationKey;
  }

  const channelId = process.env.TANGO_DISCORD_CHANNEL_ID?.trim();
  if (channelId) {
    result.channel_id = channelId;
  }

  const threadId = process.env.TANGO_DISCORD_THREAD_ID?.trim();
  if (threadId) {
    result.thread_id = threadId;
  }

  const turnId = process.env.TANGO_TURN_ID?.trim();
  if (turnId) {
    result.turn_id = turnId;
  }

  const messageId = process.env.TANGO_MESSAGE_ID?.trim();
  if (messageId) {
    result.message_id = messageId;
  }

  const occurredAt = process.env.TANGO_OCCURRED_AT?.trim();
  if (occurredAt) {
    result.occurred_at = occurredAt;
  }

  const contextRef = process.env.TANGO_CONTEXT_REF?.trim();
  if (contextRef) {
    result.context_ref = contextRef;
  }

  const contextLabel = process.env.TANGO_CONTEXT_LABEL?.trim();
  if (contextLabel) {
    result.context_label = contextLabel;
  }

  return result;
}

export function mergeDiscordProvenanceIntoMemoryAddArgs(
  args: Record<string, unknown>,
  runtimeAgentId?: string,
): Record<string, unknown> {
  const provenance = readDiscordProvenanceFromEnv();
  const existingMetadata = isRecord(args.metadata) ? args.metadata : {};
  const legacyMetadata: Record<string, unknown> = {
    ...provenance,
    ...existingMetadata,
  };
  const source = normalizeMemorySource(args.source);
  const mergedMetadata = source
    ? withMemoryOrigin(legacyMetadata, {
        source,
        occurredAt: provenance.occurred_at,
        contextLabel: provenance.context_label,
        contextRef: provenance.context_ref,
      })
    : legacyMetadata;

  const runtimeId = runtimeAgentId?.trim();
  const canonicalAgentId = normalizeOptionalString(args.agent_id);
  if (runtimeId && canonicalAgentId && runtimeId !== canonicalAgentId) {
    mergedMetadata.runtime_agent_id = runtimeId;
  }

  const sessionId =
    normalizeOptionalString(args.session_id)
    ?? provenance.conversation_key;

  return {
    ...args,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(Object.keys(mergedMetadata).length > 0 ? { metadata: mergedMetadata } : {}),
  };
}

function normalizeMemorySource(value: unknown): MemorySource | null {
  switch (value) {
    case "conversation":
    case "reflection":
    case "manual":
    case "observation":
    case "import":
    case "obsidian":
      return value;
    default:
      return null;
  }
}
