export type MessageReferentKind = "reply" | "reaction";

export interface MessageReferent {
  kind: MessageReferentKind;
  targetMessageId: string;
  targetSessionId: string | null;
  targetAgentId: string | null;
  targetContent: string;
  metadata?: Record<string, unknown> | null;
}

const GENERIC_FOLLOW_UP_PATTERN =
  /\b(this|that|it|those|these|them|same|again|also|too|there|here|update|fix|mark|marked|done|complete|completed|finished|clear|correct|wrong|right|apply|approve|ship|send|post|use that|looks good|sounds good|go ahead|please|we need to)\b/iu;
const ACK_FOLLOW_UP_PATTERN = /^(yes|yeah|yep|ok|okay|sure|sounds good|looks good|go ahead|do it|please|thanks|thank you)[.!]*$/iu;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function truncateReferentContent(text: string, maxChars = 700): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function isLikelyReferentialFollowUp(text: string): boolean {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return false;
  if (normalized.length > 280) return false;
  if (ACK_FOLLOW_UP_PATTERN.test(normalized)) return true;
  return GENERIC_FOLLOW_UP_PATTERN.test(normalized);
}

export function shouldPreferReferentSession(input: {
  promptText: string;
  referent: MessageReferent | null;
  explicitTopicName?: string | null;
  activeSessionId?: string | null;
}): boolean {
  const referent = input.referent;
  if (!referent?.targetSessionId) return false;
  if (input.explicitTopicName?.trim()) return false;
  if (referent.targetSessionId === (input.activeSessionId?.trim() || null)) return false;
  if (referent.kind === "reply") return true;
  return isLikelyReferentialFollowUp(input.promptText);
}

export function buildPromptWithReferent(promptText: string, referent: MessageReferent | null): string {
  const normalizedPrompt = normalizeWhitespace(promptText);
  if (!referent) return normalizedPrompt;

  const excerpt = truncateReferentContent(referent.targetContent);
  const preamble =
    referent.kind === "reply"
      ? "The user is replying to this earlier message in the same Discord channel:"
      : "The user recently reacted to this earlier message in the same Discord channel and is likely referring to it:";

  return [
    preamble,
    excerpt,
    "",
    `User message: ${normalizedPrompt}`,
  ].join("\n");
}

export function buildReferentSystemMessage(referent: MessageReferent): string {
  const excerpt = truncateReferentContent(referent.targetContent, 320);
  if (referent.kind === "reply") {
    return `Reply referent: the user is responding to this earlier channel message: ${excerpt}`;
  }
  return `Reaction referent: before this turn, the user reacted to this earlier channel message and is likely referring to it: ${excerpt}`;
}
