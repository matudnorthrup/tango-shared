function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MESSAGE_LABEL_PREFIX_RE =
  /^(?:\[(?:discord-user|discord-assistant|voice-user|voice-assistant)\]\s*)+/i;

export function stripMessageLabelPrefixes(text: string): string {
  return text.replace(MESSAGE_LABEL_PREFIX_RE, "").trim();
}

export function stripPresentedSpeakerPrefix(
  text: string,
  botName?: string
): string {
  let cleaned = text.trim().replace(/^\*\*You:\*\*\s*/i, "");

  const normalizedBotName = botName?.trim();
  if (normalizedBotName) {
    cleaned = cleaned.replace(
      new RegExp(
        `^\\*\\*${escapeRegExp(normalizedBotName)}(?: Voice)?:\\*\\*\\s*`,
        "i"
      ),
      ""
    );
  }

  return cleaned.trim();
}

export function cleanConversationMessageText(
  text: string,
  botName?: string
): string {
  return stripPresentedSpeakerPrefix(stripMessageLabelPrefixes(text), botName);
}

export function cleanSpeechReadbackText(
  text: string,
  botName?: string
): string {
  return cleanConversationMessageText(text, botName)
    .replace(/\s+/g, " ")
    .trim();
}

export interface SpeechReadbackMessageLike {
  role?: string | null;
  label?: string | null;
  content?: unknown;
}

export function coerceSpokenText(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const flat = value
      .map((entry) => coerceSpokenText(entry, ""))
      .filter((entry) => entry.length > 0)
      .join(" ");
    return flat.length > 0 ? flat : fallback;
  }
  if (value && typeof value === "object") {
    try {
      const content = (value as { content?: unknown }).content;
      const spokenContent = coerceSpokenText(content, "");
      if (spokenContent.length > 0) {
        return spokenContent;
      }

      const text = (value as { text?: unknown }).text;
      const spokenText = coerceSpokenText(text, "");
      if (spokenText.length > 0) {
        return spokenText;
      }

      const serialized = JSON.stringify(value);
      if (serialized && serialized !== "{}" && serialized !== "[]") {
        return serialized.length > 300
          ? `${serialized.slice(0, 300)}...`
          : serialized;
      }
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export function getSpeechReadbackSpeakerLabel(
  role: string | null | undefined,
  label: string | null | undefined
): string {
  const normalizedLabel = label?.trim().toLowerCase();
  if (normalizedLabel === "voice-user") {
    return "You";
  }

  const normalizedRole =
    role?.trim().toLowerCase() ?? mapMessageLabelToRole(label) ?? "user";
  return normalizedRole === "assistant" ? "Assistant" : "User";
}

export function formatSpeechReadbackMessages(
  messages: SpeechReadbackMessageLike[],
  botName?: string
): string {
  const visibleMessages = messages
    .filter((message) => message.role !== "system" && message.content != null)
    .map((message) => ({
      speaker: getSpeechReadbackSpeakerLabel(message.role, message.label),
      text: cleanSpeechReadbackText(coerceSpokenText(message.content, ""), botName)
    }))
    .filter((message) => message.text.length > 0);

  if (visibleMessages.length === 0) return "";

  const render = (message: { speaker: string; text: string }): string =>
    `${message.speaker}: ${message.text}`;

  if (visibleMessages.length <= 5) {
    return visibleMessages.map(render).join(" ... ");
  }

  if (visibleMessages.length <= 15) {
    const first = visibleMessages.slice(0, 2).map(render).join(" ... ");
    const last = visibleMessages.slice(-2).map(render).join(" ... ");
    const skipped = visibleMessages.length - 4;
    return `${first} ... ${skipped} more messages ... ${last}`;
  }

  const lastMessage = visibleMessages[visibleMessages.length - 1]!;
  return `${visibleMessages.length} messages. Most recent, ${render(lastMessage)}`;
}

export function mapMessageLabelToRole(
  label: string | null | undefined
): "user" | "assistant" | null {
  const normalized = label?.trim().toLowerCase();
  if (normalized === "voice-user" || normalized === "discord-user") {
    return "user";
  }
  if (
    normalized === "voice-assistant" ||
    normalized === "discord-assistant"
  ) {
    return "assistant";
  }
  return null;
}

export function normalizeSyncText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function isNativeDiscordGatewayMessage(text: string): boolean {
  const normalized = normalizeSyncText(text);
  if (!normalized) return false;
  if (normalized.includes("conversation info (untrusted metadata):")) {
    return true;
  }
  if (
    normalized.includes('"conversation_label"') &&
    normalized.includes('"group_channel"')
  ) {
    return true;
  }
  return normalized.includes("[current message - respond to this]");
}
