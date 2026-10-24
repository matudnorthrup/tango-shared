import {
  cleanConversationMessageText,
  mapMessageLabelToRole
} from "./message-format.js";

export interface SessionChatMessageLike {
  role: string;
  content: unknown;
  label?: string;
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (
          block &&
          typeof block === "object" &&
          "text" in block &&
          typeof (block as { text?: unknown }).text === "string"
        ) {
          return (block as { text: string }).text;
        }
        return "";
      })
      .filter((part) => part.length > 0)
      .join("\n");
  }

  if (content == null) return "";
  return String(content);
}

function extractMessageLabel(
  message: Pick<SessionChatMessageLike, "label">,
  rawText: string
): string | null {
  const explicit = message.label?.trim().toLowerCase();
  if (
    explicit === "voice-user" ||
    explicit === "voice-assistant" ||
    explicit === "discord-user" ||
    explicit === "discord-assistant"
  ) {
    return explicit;
  }

  const prefix = rawText.match(/^\[([a-z][\w-]*)\]\s*/i)?.[1]?.toLowerCase();
  if (
    prefix === "voice-user" ||
    prefix === "voice-assistant" ||
    prefix === "discord-user" ||
    prefix === "discord-assistant"
  ) {
    return prefix;
  }

  return null;
}

export interface ConversationHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GatewayHistoryMessageLike extends SessionChatMessageLike {}

export interface DiscordHistoryMessageLike {
  content: string;
  author?: {
    bot?: boolean | null;
  } | null;
}

export interface GatewayHistoryFormatOptions {
  botName?: string;
  isSkippableText?: (text: string) => boolean;
  sanitizeAssistantText?: (text: string) => string;
}

const DISCORD_USER_TRANSCRIPT_RE = /^\*\*You:\*\*/i;

export function normalizeGatewayHistoryMessage(
  message: GatewayHistoryMessageLike,
  options: GatewayHistoryFormatOptions = {}
): ConversationHistoryMessage | null {
  if (message.role === "system") return null;

  const rawContent = extractMessageText(message.content);
  if (!rawContent) return null;
  if (options.isSkippableText?.(rawContent)) return null;

  const label = extractMessageLabel(message, rawContent);
  const mappedRole = mapMessageLabelToRole(label);
  const role =
    mappedRole ??
    (message.role === "user" || message.role === "assistant"
      ? message.role
      : null);
  if (!role) return null;

  let content = cleanConversationMessageText(rawContent, options.botName);
  if (!content) return null;

  if (role === "assistant") {
    content = options.sanitizeAssistantText?.(content) ?? content;
    if (!content) return null;
  }

  return { role, content };
}

export function convertGatewayHistoryMessages(
  messages: GatewayHistoryMessageLike[],
  options: GatewayHistoryFormatOptions = {}
): ConversationHistoryMessage[] {
  return messages
    .map((message) => normalizeGatewayHistoryMessage(message, options))
    .filter((message): message is ConversationHistoryMessage => message !== null);
}

export function normalizeDiscordHistoryMessage(
  message: DiscordHistoryMessageLike,
  botName?: string
): ConversationHistoryMessage | null {
  const content = cleanConversationMessageText(message.content, botName);
  if (!content.trim()) return null;

  const isUserTranscript =
    !!message.author?.bot && DISCORD_USER_TRANSCRIPT_RE.test(message.content);
  const isHumanUser = !message.author?.bot;
  return {
    role: isUserTranscript || isHumanUser ? "user" : "assistant",
    content
  };
}

export function convertDiscordHistoryMessages(
  messages: DiscordHistoryMessageLike[],
  botName?: string
): ConversationHistoryMessage[] {
  return messages
    .map((message) => normalizeDiscordHistoryMessage(message, botName))
    .filter((message): message is ConversationHistoryMessage => message !== null);
}

export function collapseLatestDiscordHistoryMessages(
  messages: DiscordHistoryMessageLike[],
  botName?: string
): ConversationHistoryMessage | null {
  let firstRole: ConversationHistoryMessage["role"] | null = null;
  const parts: string[] = [];

  for (const message of messages) {
    const normalized = normalizeDiscordHistoryMessage(message, botName);
    if (!normalized) continue;

    if (firstRole === null) {
      firstRole = normalized.role;
      parts.push(normalized.content);
      continue;
    }

    if (normalized.role !== firstRole) {
      break;
    }

    parts.unshift(normalized.content);
  }

  if (!firstRole || parts.length === 0) return null;
  return {
    role: firstRole,
    content: parts.join("\n\n")
  };
}
