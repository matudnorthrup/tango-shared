import type { StoredMessageRecord } from "./storage.js";

interface CompactTurn {
  speaker: "user" | "assistant";
  content: string;
}

export interface BuildSessionCompactionInput {
  sessionId: string;
  agentId: string;
  messages: StoredMessageRecord[];
  triggerTurns?: number;
  retainRecentTurns?: number;
  maxSummaryTurns?: number;
  maxTurnChars?: number;
  maxSummaryChars?: number;
}

export interface SessionCompactionPlan {
  shouldCompact: boolean;
  totalTurns: number;
  compactedTurns: number;
  retainedRecentTurns: number;
  summaryText?: string;
}

function truncateText(input: string, maxChars: number): string {
  const normalized = input.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(maxChars - 3, 1))}...`;
}

function truncateBlock(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  const clipped = input.slice(0, Math.max(maxChars - 14, 1)).trimEnd();
  return `${clipped}\n[truncated]`;
}

function toCompactTurns(input: BuildSessionCompactionInput): CompactTurn[] {
  return input.messages
    .filter((message) => message.sessionId === input.sessionId)
    .filter((message) => message.agentId === input.agentId)
    .filter((message) => message.direction === "inbound" || message.direction === "outbound")
    .map((message): CompactTurn => ({
      speaker: message.direction === "inbound" ? "user" : "assistant",
      content: message.content
    }));
}

export function planSessionCompaction(input: BuildSessionCompactionInput): SessionCompactionPlan {
  const triggerTurns = Number.isFinite(input.triggerTurns) ? Math.max(input.triggerTurns ?? 24, 2) : 24;
  const retainRecentTurns = Number.isFinite(input.retainRecentTurns)
    ? Math.max(input.retainRecentTurns ?? 8, 1)
    : 8;
  const maxSummaryTurns = Number.isFinite(input.maxSummaryTurns)
    ? Math.max(input.maxSummaryTurns ?? 16, 1)
    : 16;
  const maxTurnChars = Number.isFinite(input.maxTurnChars) ? Math.max(input.maxTurnChars ?? 180, 40) : 180;
  const maxSummaryChars = Number.isFinite(input.maxSummaryChars)
    ? Math.max(input.maxSummaryChars ?? 1800, 280)
    : 1800;

  const turns = toCompactTurns(input);
  const totalTurns = turns.length;
  if (totalTurns < triggerTurns) {
    return {
      shouldCompact: false,
      totalTurns,
      compactedTurns: 0,
      retainedRecentTurns: Math.min(totalTurns, retainRecentTurns)
    };
  }

  const compactedTurns = Math.max(totalTurns - retainRecentTurns, 0);
  if (compactedTurns <= 0) {
    return {
      shouldCompact: false,
      totalTurns,
      compactedTurns: 0,
      retainedRecentTurns: totalTurns
    };
  }

  const compactedSlice = turns.slice(0, compactedTurns);
  const compactedUserTurns = compactedSlice.filter((turn) => turn.speaker === "user").length;
  const compactedAssistantTurns = compactedSlice.length - compactedUserTurns;
  const selectedTurns = compactedSlice.slice(-maxSummaryTurns);

  const lines = [
    `Compacted history: ${compactedTurns} prior turns (${compactedUserTurns} user / ${compactedAssistantTurns} assistant).`,
    `Session=${input.sessionId} Agent=${input.agentId}`,
    "Key prior turns:"
  ];
  for (const turn of selectedTurns) {
    lines.push(`- [${turn.speaker}] ${truncateText(turn.content, maxTurnChars)}`);
  }

  const omittedTurns = compactedSlice.length - selectedTurns.length;
  if (omittedTurns > 0) {
    lines.push(`- ... ${omittedTurns} earlier compacted turns omitted`);
  }

  const summaryText = truncateBlock(lines.join("\n"), maxSummaryChars);
  return {
    shouldCompact: true,
    totalTurns,
    compactedTurns,
    retainedRecentTurns: Math.min(totalTurns, retainRecentTurns),
    summaryText
  };
}
