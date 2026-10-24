import type { SessionMemoryConfig } from "./types.js";
import { cosineSimilarity, deserializeEmbedding } from "./embeddings.js";
import type { EmbeddingProvider } from "./embeddings.js";
import {
  formatRetrievedMemoryLine,
  resolveMemoryProvenance,
  RETRIEVED_MEMORY_GUIDANCE,
  type ResolvedMemoryProvenance,
} from "./memory-provenance.js";
import { readProfileConfigStringList } from "./profile-config.js";
import { parseStoredTimestampMs } from "./time.js";
import type {
  ActiveContextItemRecord,
  PinnedFactRecord,
  SessionSummaryRecord,
  StoredMemoryRecord,
  StoredMessageRecord,
} from "./storage.js";

const STOP_WORDS = new Set([
  "about",
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "by",
  "did",
  "do",
  "does",
  "done",
  "for",
  "from",
  "had",
  "has",
  "have",
  "happening",
  "how",
  "i",
  "in",
  "is",
  "it",
  "just",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "really",
  "still",
  "that",
  "then",
  "there",
  "the",
  "this",
  "to",
  "wasn",
  "was",
  "we",
  "what",
  "with",
  "you",
  "your",
]);

const DEFAULT_MESSAGE_CONTEXT_CHARS = 360;
const DETAILED_RECENT_MESSAGE_COUNT = 6;
const DETAILED_RECENT_MESSAGE_CHARS = 1400;

export interface NormalizedSessionMemoryConfig {
  maxContextTokens: number;
  zones: {
    pinned: number;
    summary: number;
    memories: number;
    recent: number;
  };
  summarizeWindow: number;
  memoryLimit: number;
  importanceThreshold: number;
  retrievalWeights: {
    recency: number;
    importance: number;
    relevance: number;
    source: number;
  };
}

export interface RetrievedMemoryRecord extends StoredMemoryRecord {
  score: number;
  relevanceScore: number;
  keywordScore: number;
  semanticScore: number;
  recencyScore: number;
  sourceBonus: number;
  qualityPenalty: number;
}

export interface AssembleSessionMemoryPromptInput {
  /** Approved aliases whose conversation turns belong to this agent. */
  messageAgentIds?: string[];
  sessionId: string;
  agentId: string;
  /**
   * Agent id used only for retrieved-memory ranking. Set to null when the
   * memory pool has already been scoped by multiple aliases and should not be
   * narrowed back to the runtime agent id.
   */
  memoryAgentId?: string | null;
  currentUserPrompt?: string;
  queryEmbedding?: number[] | null;
  allowFullHistoryBypass?: boolean;
  memoryConfig?: SessionMemoryConfig;
  messages: StoredMessageRecord[];
  summaries: SessionSummaryRecord[];
  memories: StoredMemoryRecord[];
  pinnedFacts: PinnedFactRecord[];
  activeContextItems?: ActiveContextItemRecord[];
  excludeMessageIds?: number[];
  now?: Date;
}

export interface SessionMemoryPrompt {
  prompt: string;
  estimatedTokens: number;
  accessedMemoryIds: number[];
  usedFullHistory: boolean;
  trace: SessionMemoryPromptTrace;
}

export interface SessionMemoryPromptTrace {
  note?: string;
  pinnedFacts: PromptTracePinnedFact[];
  activeContextItems: PromptTraceActiveContextItem[];
  summaries: PromptTraceSummary[];
  memories: PromptTraceMemory[];
  recentMessages: PromptTraceMessage[];
}

export interface PromptTracePinnedFact {
  id: number;
  scope: PinnedFactRecord["scope"];
  scopeId: string | null;
  key: string;
  value: string;
}

export interface PromptTraceActiveContextItem {
  id: number;
  key: string;
  kind: ActiveContextItemRecord["kind"];
  title: string | null;
  summary: string;
  keyFacts: string[];
  sourceRefs: string[];
}

export interface PromptTraceSummary {
  id: number;
  summaryText: string;
  tokenCount: number;
  coversThroughMessageId: number | null;
}

export interface PromptTraceMemory {
  id: number;
  sessionId: string | null;
  agentId: string | null;
  source: StoredMemoryRecord["source"];
  content: string;
  importance: number;
  sourceRef: string | null;
  createdAt: string;
  provenance: ResolvedMemoryProvenance;
  score: number;
  relevanceScore: number;
  keywordScore: number;
  semanticScore: number;
  recencyScore: number;
  sourceBonus: number;
  qualityPenalty: number;
}

export interface PromptTraceMessage {
  id: number;
  direction: StoredMessageRecord["direction"];
  content: string;
  createdAt: string;
}

export interface SearchMemoriesInput {
  query: string;
  memories: StoredMemoryRecord[];
  embeddingProvider?: EmbeddingProvider | null;
  sessionId?: string;
  agentId?: string;
  source?: StoredMemoryRecord["source"] | "all";
  limit?: number;
  retrievalWeights?: NormalizedSessionMemoryConfig["retrievalWeights"];
  now?: Date;
}

export const DEFAULT_SESSION_MEMORY_CONFIG: NormalizedSessionMemoryConfig = {
  maxContextTokens: 12000,
  zones: {
    pinned: 0.05,
    summary: 0.2,
    memories: 0.2,
    recent: 0.55,
  },
  summarizeWindow: 6,
  memoryLimit: 120,
  importanceThreshold: 0.25,
  retrievalWeights: {
    recency: 1,
    importance: 1,
    relevance: 2,
    source: 0.5,
  },
};

type MemoryDomain =
  | "wellness"
  | "planning"
  | "product"
  | "fabrication"
  | "relationships"
  | "mental-health";

interface QueryProfile {
  normalized: string;
  tokens: string[];
  domains: Set<MemoryDomain>;
  isOperational: boolean;
  skipRetrieval: boolean;
}

const LOW_ENTROPY_QUERY_PATTERNS = [
  /^(?:yes|yeah|yep|no|nope|ok|okay|sure|cool|nice|perfect|great|thanks|thank you|got it|sounds good|exactly|right|correct)\b/iu,
  /^(?:yeah|yep|ok|okay)\s*,?\s*(?:circuits|same|sure|fine)?$/iu,
];

// Short commands that are pure data entry — no retrieval value.
// Examples: "30x15", "110x12 again", "set 3 65 pounds 10 reps", "Squash it"
const WORKOUT_LOGGING_PATTERN =
  /^(?:\d+\s*[x×]\s*\d+|set\s*\d|rdl|squash|done|again|same|next|skip|log\b)/iu;

const OPERATIONAL_QUERY_PATTERN =
  /\b(plan|planning|review|status|task|tasks|todo|priority|priorities|calendar|schedule|weekly|cadence|workflow|thread|threads|active threads|budget|finance|inbox|email|roadmap)\b/iu;

const PERSONAL_TOPIC_TERMS_CONFIG_PATH = "memory/personal-topic-terms.txt";

const MEMORY_DOMAIN_PATTERNS: Array<{ domain: MemoryDomain; pattern: RegExp }> = [
  {
    domain: "wellness",
    pattern:
      /\b(health|sleep|deep sleep|recovery|workout|exercise|fitness|protein|yogurt|meal|nutrition|recipe|breakfast|lunch|dinner|calorie|calories|fiber|steps|hrv|rhr|burn|run|walk|weight|reps?|lbs?|squat|swing|goblet|rdl|salad|snack|oats)\b/iu,
  },
  {
    domain: "planning",
    pattern:
      /\b(plan|planning|review|weekly|productivity|cadence|schedule|calendar|task|tasks|todo|priority|priorities|budget|finance|inbox|email|morning planning|roadmap|deadline)\b/iu,
  },
  {
    domain: "product",
    pattern:
      /\b(openclaw|watson voice|voice sync|acme|atlas|migration|agent|agents|api|database|tooling|prompt|claude|discord|session sync|architecture|messaging|marketing|app|apps)\b/iu,
  },
  {
    domain: "fabrication",
    pattern:
      /\b(3d printing|printing|printer|printables|cults3d|gridfinity|gcode|stl|mk4|filament|desk mount)\b/iu,
  },
  {
    domain: "relationships",
    pattern:
      /\b(relationship|relationships|boundary|boundaries|therapy|texted|family)\b/iu,
  },
  {
    domain: "mental-health",
    pattern:
      /\b(anxiety|anxious|stress|stressed|overwhelm|depression|depressed|mood|therapy|therapist|coping|trigger|triggered|panic|emotion|emotional|feelings|mental health|self-care|mindfulness|meditation|breathing|grounding|cognitive|pattern|adolescent|behavior|boundaries|communication|conflict|resilience)\b/iu,
  },
];

export function resolveSessionMemoryConfig(
  config?: SessionMemoryConfig
): NormalizedSessionMemoryConfig {
  const merged = {
    maxContextTokens: config?.maxContextTokens ?? DEFAULT_SESSION_MEMORY_CONFIG.maxContextTokens,
    summarizeWindow: config?.summarizeWindow ?? DEFAULT_SESSION_MEMORY_CONFIG.summarizeWindow,
    memoryLimit: config?.memoryLimit ?? DEFAULT_SESSION_MEMORY_CONFIG.memoryLimit,
    importanceThreshold:
      config?.importanceThreshold ?? DEFAULT_SESSION_MEMORY_CONFIG.importanceThreshold,
    retrievalWeights: {
      recency:
        config?.retrievalWeights?.recency ?? DEFAULT_SESSION_MEMORY_CONFIG.retrievalWeights.recency,
      importance:
        config?.retrievalWeights?.importance ??
        DEFAULT_SESSION_MEMORY_CONFIG.retrievalWeights.importance,
      relevance:
        config?.retrievalWeights?.relevance ??
        DEFAULT_SESSION_MEMORY_CONFIG.retrievalWeights.relevance,
      source:
        config?.retrievalWeights?.source ?? DEFAULT_SESSION_MEMORY_CONFIG.retrievalWeights.source,
    },
    zones: {
      pinned: config?.zones?.pinned ?? DEFAULT_SESSION_MEMORY_CONFIG.zones.pinned,
      summary: config?.zones?.summary ?? DEFAULT_SESSION_MEMORY_CONFIG.zones.summary,
      memories: config?.zones?.memories ?? DEFAULT_SESSION_MEMORY_CONFIG.zones.memories,
      recent: config?.zones?.recent ?? DEFAULT_SESSION_MEMORY_CONFIG.zones.recent,
    },
  };

  const total =
    merged.zones.pinned + merged.zones.summary + merged.zones.memories + merged.zones.recent;

  if (total <= 0) {
    return DEFAULT_SESSION_MEMORY_CONFIG;
  }

  return {
    maxContextTokens: Math.max(512, Math.round(merged.maxContextTokens)),
    summarizeWindow: Math.max(2, Math.round(merged.summarizeWindow)),
    memoryLimit: Math.max(1, Math.round(merged.memoryLimit)),
    importanceThreshold: clamp(merged.importanceThreshold, 0, 1),
    retrievalWeights: merged.retrievalWeights,
    zones: {
      pinned: merged.zones.pinned / total,
      summary: merged.zones.summary / total,
      memories: merged.zones.memories / total,
      recent: merged.zones.recent / total,
    },
  };
}

export function estimateTokenCount(text: string): number {
  const normalized = normalizeWhitespace(text);
  if (normalized.length === 0) return 0;
  return Math.max(1, Math.ceil(normalized.length / 4));
}

export function buildDeterministicConversationSummary(messages: StoredMessageRecord[]): string {
  const lines = messages
    .filter((message) => message.direction === "inbound" || message.direction === "outbound")
    .map((message) => {
      const speaker = message.direction === "inbound" ? "user" : "assistant";
      return `- ${speaker}: ${truncateText(message.content, 500)}`;
    });

  if (lines.length === 0) return "";
  return ["Conversation summary:", ...lines].join("\n");
}

export function buildDeterministicConversationMemory(messages: StoredMessageRecord[]): string {
  const exchange = messages.filter(
    (message) => message.direction === "inbound" || message.direction === "outbound"
  );
  if (exchange.length === 0) return "";

  if (exchange.length <= 2) {
    // Short conversations: original first-user + last-assistant format
    const firstUser = exchange.find((message) => message.direction === "inbound");
    const lastAssistant = [...exchange].reverse().find((message) => message.direction === "outbound");
    const fragments: string[] = [];

    if (firstUser) {
      fragments.push(`User discussed ${truncateText(firstUser.content, 450)}.`);
    }
    if (lastAssistant) {
      fragments.push(`Assistant responded with ${truncateText(lastAssistant.content, 450)}.`);
    }

    if (fragments.length === 0) {
      return truncateText(exchange.map((message) => message.content).join(" "), 800);
    }

    return fragments.join(" ");
  }

  // 3+ messages: include all messages with adaptive truncation
  const charLimit = 280;
  const fragments = exchange.map((message) => {
    const speaker = message.direction === "inbound" ? "User" : "Assistant";
    return `${speaker}: ${truncateText(message.content, charLimit)}`;
  });

  return fragments.join(" | ");
}

export function estimateConversationImportance(messages: StoredMessageRecord[]): number {
  const text = messages.map((message) => message.content).join(" ");
  if (text.trim().length === 0) return 0.2;

  let score = 0.2;

  if (/\b(prefer|preference|always|never|usually|tend|like|dislike)\b/iu.test(text)) {
    score += 0.2;
  }
  if (/\b(decide|decided|decision|plan|planned|next|follow[- ]?up|ship|launch|deadline)\b/iu.test(text)) {
    score += 0.2;
  }
  if (/\b(project|topic|session|workflow|research|travel|health|recipe|printing)\b/iu.test(text)) {
    score += 0.1;
  }
  if (/\b\d{1,4}\b/u.test(text) || /\b(today|tomorrow|week|month|year)\b/iu.test(text)) {
    score += 0.1;
  }
  if (normalizeWhitespace(text).length > 500) {
    score += 0.1;
  }
  if (messages.some((message) => message.direction === "outbound" && message.content.length > 220)) {
    score += 0.1;
  }

  return clamp(score, 0.1, 0.95);
}

export function extractMemoryKeywords(text: string, maxCount = 8): string[] {
  const counts = new Map<string, number>();

  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxCount)
    .map(([token]) => token);
}

export function selectMemoriesToArchive(
  memories: StoredMemoryRecord[],
  keepLimit: number,
  now: Date = new Date()
): number[] {
  if (keepLimit < 1 || memories.length <= keepLimit) return [];

  const ranked = [...memories].sort((a, b) => {
    const scoreDelta = memoryRetentionScore(b, now) - memoryRetentionScore(a, now);
    if (scoreDelta !== 0) return scoreDelta;
    return b.id - a.id;
  });

  return ranked.slice(keepLimit).map((memory) => memory.id);
}

export async function searchMemories(input: SearchMemoriesInput): Promise<RetrievedMemoryRecord[]> {
  const query = input.query.trim();
  if (query.length === 0) return [];
  if (shouldSkipMemoryRetrieval(query)) return [];

  const scopedMemories = filterMemoriesForScope(input.memories, {
    sessionId: input.sessionId,
    agentId: input.agentId,
    source: input.source,
  });
  if (scopedMemories.length === 0) return [];

  const queryEmbedding =
    input.embeddingProvider && scopedMemories.some(memoryHasEmbedding)
      ? await embedQuerySafely(input.embeddingProvider, query)
      : null;

  return rankMemories({
    currentUserPrompt: query,
    queryEmbedding,
    memories: scopedMemories,
    sessionId: input.sessionId,
    agentId: input.agentId,
    limit: Number.isFinite(input.limit) ? Math.max(input.limit ?? 10, 1) : 10,
    retrievalWeights: input.retrievalWeights ?? DEFAULT_SESSION_MEMORY_CONFIG.retrievalWeights,
    now: input.now ?? new Date(),
  });
}

export function assembleSessionMemoryPrompt(
  input: AssembleSessionMemoryPromptInput
): SessionMemoryPrompt {
  const now = input.now ?? new Date();
  const config = resolveSessionMemoryConfig(input.memoryConfig);
  const allowFullHistoryBypass = input.allowFullHistoryBypass ?? true;
  const excludeIds = new Set(input.excludeMessageIds ?? []);
  const recentMessages = input.messages
    .filter((message) => input.messageAgentIds
      ? input.messageAgentIds.includes(message.agentId ?? "")
      : message.agentId === input.agentId)
    .filter((message) => message.direction === "inbound" || message.direction === "outbound")
    .filter((message) => !excludeIds.has(message.id));

  const pinnedSelection = selectPinnedFacts(input.pinnedFacts);
  const pinnedLines = pinnedSelection.lines;
  const activeContextSelection = selectActiveContextItems(input.activeContextItems ?? [], now);

  const detailedStartIndex = Math.max(0, recentMessages.length - DETAILED_RECENT_MESSAGE_COUNT);
  const fullHistoryLines = recentMessages.map((message, index) =>
    formatMessageLine(
      message,
      index >= detailedStartIndex ? DETAILED_RECENT_MESSAGE_CHARS : DEFAULT_MESSAGE_CONTEXT_CHARS,
    )
  );
  const fullHistoryNote = "Recent history fits in budget. Summary and retrieval zones were skipped.";
  const fullHistoryPrompt = renderMemoryPrompt({
    sessionId: input.sessionId,
    agentId: input.agentId,
    pinnedLines,
    activeContextLines: activeContextSelection.lines,
    summaryBlocks: [],
    memoryLines: [],
    recentLines: fullHistoryLines,
    note: fullHistoryNote,
  });

  if (allowFullHistoryBypass && estimateTokenCount(fullHistoryPrompt) <= config.maxContextTokens) {
    return {
      prompt: fullHistoryPrompt,
      estimatedTokens: estimateTokenCount(fullHistoryPrompt),
      accessedMemoryIds: [],
      usedFullHistory: true,
      trace: {
        note: fullHistoryNote,
        pinnedFacts: pinnedSelection.facts.map(toPromptTracePinnedFact),
        activeContextItems: activeContextSelection.items.map(toPromptTraceActiveContextItem),
        summaries: [],
        memories: [],
        recentMessages: recentMessages.map(toPromptTraceMessage),
      },
    };
  }

  const pinnedBudget = Math.max(0, Math.floor(config.maxContextTokens * config.zones.pinned));
  const summaryBudget = Math.max(0, Math.floor(config.maxContextTokens * config.zones.summary));
  const memoryBudget = Math.max(0, Math.floor(config.maxContextTokens * config.zones.memories));
  const recentBudget = Math.max(0, Math.floor(config.maxContextTokens * config.zones.recent));

  const boundedPinnedSelection = selectPinnedFacts(input.pinnedFacts, pinnedBudget);

  const summarySelection = selectSummaryBlocks(input.summaries, summaryBudget);
  const memoryRankingAgentId =
    input.memoryAgentId === undefined ? input.agentId : input.memoryAgentId ?? undefined;
  const retrievedMemories = rankMemories({
    currentUserPrompt: input.currentUserPrompt,
    queryEmbedding: input.queryEmbedding,
    memories: input.memories,
    sessionId: input.sessionId,
    agentId: memoryRankingAgentId,
    limit: config.memoryLimit,
    retrievalWeights: config.retrievalWeights,
    now,
  });
  const memorySelection = takeMemoriesWithinBudget(retrievedMemories, memoryBudget);
  const recentSelection = selectRecentMessages(recentMessages, recentBudget);

  const prompt = renderMemoryPrompt({
    sessionId: input.sessionId,
    agentId: input.agentId,
    pinnedLines: boundedPinnedSelection.lines,
    activeContextLines: activeContextSelection.lines,
    summaryBlocks: summarySelection.blocks,
    memoryLines: memorySelection.lines,
    recentLines: recentSelection.lines,
  });

  return {
    prompt,
    estimatedTokens: estimateTokenCount(prompt),
    accessedMemoryIds: memorySelection.memories.map((memory) => memory.id),
    usedFullHistory: false,
    trace: {
      pinnedFacts: boundedPinnedSelection.facts.map(toPromptTracePinnedFact),
      activeContextItems: activeContextSelection.items.map(toPromptTraceActiveContextItem),
      summaries: summarySelection.summaries.map(toPromptTraceSummary),
      memories: memorySelection.memories.map(toPromptTraceMemory),
      recentMessages: recentSelection.messages.map(toPromptTraceMessage),
    },
  };
}

function selectSummaryBlocks(
  summaries: SessionSummaryRecord[],
  tokenBudget: number
): { summaries: SessionSummaryRecord[]; blocks: string[] } {
  if (tokenBudget < 1 || summaries.length === 0) {
    return { summaries: [], blocks: [] };
  }

  const selectedSummaries: SessionSummaryRecord[] = [];
  const selectedBlocks: string[] = [];
  let usedTokens = 0;
  const ordered = [...summaries].sort((a, b) => {
    const aCoverage = a.coversThroughMessageId ?? 0;
    const bCoverage = b.coversThroughMessageId ?? 0;
    return bCoverage - aCoverage || b.id - a.id;
  });

  for (const summary of ordered) {
    const block = `[through ${summary.coversThroughMessageId ?? "?"}] ${summary.summaryText}`;
    const blockTokens = estimateTokenCount(block);
    if (selectedBlocks.length > 0 && usedTokens + blockTokens > tokenBudget) {
      continue;
    }
    selectedSummaries.push(summary);
    selectedBlocks.push(block);
    usedTokens += blockTokens;
    if (usedTokens >= tokenBudget) break;
  }

  return {
    summaries: selectedSummaries.reverse(),
    blocks: selectedBlocks.reverse(),
  };
}

function selectActiveContextItems(
  items: ActiveContextItemRecord[],
  now: Date
): { items: ActiveContextItemRecord[]; lines: string[] } {
  const nowMs = now.getTime();
  const activeItems = items
    .filter((item) => item.archivedAt === null)
    .filter((item) => item.expiresAt === null || Date.parse(item.expiresAt) > nowMs)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.id - a.id)
    .slice(0, 12);

  return {
    items: activeItems,
    lines: activeItems.map(formatActiveContextLine),
  };
}

function rankMemories(input: {
  currentUserPrompt?: string;
  queryEmbedding?: number[] | null;
  memories: StoredMemoryRecord[];
  sessionId?: string;
  agentId?: string;
  limit: number;
  retrievalWeights: NormalizedSessionMemoryConfig["retrievalWeights"];
  now: Date;
}): RetrievedMemoryRecord[] {
  const query = input.currentUserPrompt?.trim();
  const queryProfile = analyzeQuery(query);
  if (queryProfile.skipRetrieval) {
    return [];
  }
  const filtered = filterMemoriesForScope(input.memories, {
    sessionId: input.sessionId,
    agentId: input.agentId,
  });
  const ranked = filtered
    .map((memory) => {
      const keywordScore = computeKeywordRelevance(query, memory);
      const semanticScore = computeSemanticRelevance(input.queryEmbedding, memory);
      const relevanceScore = combineRelevanceScores(keywordScore, semanticScore);
      const recencyScore = computeRecencyScore(memory, input.now);
      const sourceBonus = memorySourceBonus(memory.source);
      const scopeBonus = computeScopeBonus({
        memory,
        sessionId: input.sessionId,
        agentId: input.agentId,
      });
      const qualityPenalty = computeQualityPenalty({
        queryProfile,
        memory,
        keywordScore,
        semanticScore,
        sessionId: input.sessionId,
        agentId: input.agentId,
      });
      const score =
        input.retrievalWeights.recency * recencyScore +
        input.retrievalWeights.importance * clamp(memory.importance, 0, 1) +
        input.retrievalWeights.relevance * relevanceScore +
        input.retrievalWeights.source * sourceBonus +
        scopeBonus -
        qualityPenalty;

      return {
        ...memory,
        score,
        relevanceScore,
        keywordScore,
        semanticScore,
        recencyScore,
        sourceBonus,
        qualityPenalty,
      };
    })
    .filter((memory) => memory.score > 1.0)
    .sort((a, b) => b.score - a.score || b.id - a.id);

  return deduplicateAndCapBySource(ranked, Math.max(1, input.limit));
}

function deduplicateAndCapBySource(
  memories: RetrievedMemoryRecord[],
  limit: number
): RetrievedMemoryRecord[] {
  const MAX_PER_DOC = 1;
  const MAX_SOURCE_RATIO = 0.4;
  const MAX_SOURCE_ABSOLUTE = 8;
  const maxPerSource = Math.max(1, Math.min(Math.ceil(limit * MAX_SOURCE_RATIO), MAX_SOURCE_ABSOLUTE));

  const seenDocs = new Map<string, number>();
  const sourceCounts = new Map<string, number>();

  const selected = memories.filter((memory) => {
    // Per-doc dedup (existing behavior)
    const filePath = getMetadataString(memory.metadata, "filePath");
    if (filePath) {
      const count = seenDocs.get(filePath) ?? 0;
      if (count >= MAX_PER_DOC) return false;
      seenDocs.set(filePath, count + 1);
    }

    // Per-source-type cap
    const sourceCount = sourceCounts.get(memory.source) ?? 0;
    if (sourceCount >= maxPerSource) return false;
    sourceCounts.set(memory.source, sourceCount + 1);

    return true;
  });

  return selected.slice(0, limit);
}

function takeMemoriesWithinBudget(
  memories: RetrievedMemoryRecord[],
  tokenBudget: number
): { memories: RetrievedMemoryRecord[]; lines: string[] } {
  if (tokenBudget < 1 || memories.length === 0) {
    return { memories: [], lines: [] };
  }

  const selected: RetrievedMemoryRecord[] = [];
  const lines: string[] = [];
  let usedTokens = estimateTokenCount(RETRIEVED_MEMORY_GUIDANCE);
  if (usedTokens >= tokenBudget) {
    return { memories: [], lines: [] };
  }

  for (const memory of memories) {
    const line = formatRetrievedMemoryLine(memory, { maxContentChars: 220 });
    const lineTokens = estimateTokenCount(line);
    if (usedTokens + lineTokens > tokenBudget) {
      continue;
    }
    selected.push(memory);
    lines.push(line);
    usedTokens += lineTokens;
    if (usedTokens >= tokenBudget) break;
  }

  return { memories: selected, lines };
}

function filterMemoriesForScope(
  memories: StoredMemoryRecord[],
  options: {
    sessionId?: string;
    agentId?: string;
    source?: StoredMemoryRecord["source"] | "all";
  }
): StoredMemoryRecord[] {
  return memories
    .filter((memory) => memory.archivedAt === null)
    .filter((memory) =>
      options.sessionId ? memory.sessionId === null || memory.sessionId === options.sessionId : true
    )
    .filter((memory) =>
      options.agentId ? memory.agentId === null || memory.agentId === options.agentId : true
    )
    .filter((memory) =>
      options.source && options.source !== "all" ? memory.source === options.source : true
    );
}

function selectPinnedFacts(
  facts: PinnedFactRecord[],
  tokenBudget = Number.POSITIVE_INFINITY
): { facts: PinnedFactRecord[]; lines: string[] } {
  if (facts.length === 0 || tokenBudget < 1) {
    return { facts: [], lines: [] };
  }

  const selectedFacts: PinnedFactRecord[] = [];
  const selectedLines: string[] = [];
  let usedTokens = 0;

  for (const fact of facts) {
    const line = `- ${fact.key}: ${truncateText(fact.value, 220)}`;
    const lineTokens = estimateTokenCount(line);
    if (selectedLines.length > 0 && usedTokens + lineTokens > tokenBudget) {
      continue;
    }
    selectedFacts.push(fact);
    selectedLines.push(line);
    usedTokens += lineTokens;
    if (usedTokens >= tokenBudget) break;
  }

  return { facts: selectedFacts, lines: selectedLines };
}

function selectRecentMessages(
  messages: StoredMessageRecord[],
  tokenBudget: number
): { messages: StoredMessageRecord[]; lines: string[] } {
  if (tokenBudget < 1) {
    return { messages: [], lines: [] };
  }

  const selectedMessages: StoredMessageRecord[] = [];
  const selectedLines: string[] = [];
  let usedTokens = 0;

  for (const message of [...messages].reverse()) {
    const maxChars =
      selectedMessages.length < DETAILED_RECENT_MESSAGE_COUNT
        ? DETAILED_RECENT_MESSAGE_CHARS
        : DEFAULT_MESSAGE_CONTEXT_CHARS;
    const line = formatMessageLine(message, maxChars);
    const lineTokens = estimateTokenCount(line);
    if (selectedLines.length > 0 && usedTokens + lineTokens > tokenBudget) {
      continue;
    }

    if (selectedLines.length === 0 && lineTokens > tokenBudget) {
      const truncatedCharLimit = Math.max(tokenBudget * 4, 80);
      selectedMessages.push({
        ...message,
        content: truncateText(message.content, truncatedCharLimit),
      });
      selectedLines.push(formatMessageLine(selectedMessages[0]!, truncatedCharLimit));
      break;
    }

    selectedMessages.push(message);
    selectedLines.push(line);
    usedTokens += lineTokens;
    if (usedTokens >= tokenBudget) break;
  }

  return {
    messages: selectedMessages.reverse(),
    lines: selectedLines.reverse(),
  };
}

function renderMemoryPrompt(input: {
  sessionId: string;
  agentId: string;
  pinnedLines: string[];
  activeContextLines: string[];
  summaryBlocks: string[];
  memoryLines: string[];
  recentLines: string[];
  note?: string;
}): string {
  const lines = [
    "Session memory context:",
    `session=${input.sessionId} agent=${input.agentId}`,
  ];

  if (input.note) {
    lines.push(`note=${input.note}`);
  }

  if (input.pinnedLines.length > 0) {
    lines.push("pinned_state:");
    lines.push(...input.pinnedLines);
  }

  lines.push("active_context:");
  lines.push(...(input.activeContextLines.length > 0 ? input.activeContextLines : ["- none"]));

  if (input.summaryBlocks.length > 0) {
    lines.push("rolling_summary:");
    lines.push(...input.summaryBlocks);
  }

  if (input.memoryLines.length > 0) {
    lines.push("retrieved_memories:");
    lines.push(`note=${RETRIEVED_MEMORY_GUIDANCE}`);
    lines.push(...input.memoryLines);
  }

  if (input.recentLines.length > 0) {
    lines.push("recent_messages:");
    lines.push(...input.recentLines);
  }

  lines.push("End session memory context.");
  return lines.join("\n");
}

export function extractRecentMessagesContext(
  prompt: string | null | undefined,
  options?: {
    maxLines?: number;
    maxChars?: number;
  },
): string | null {
  if (!prompt) {
    return null;
  }

  const maxLines = Math.max(1, options?.maxLines ?? 6);
  const maxChars = Math.max(1, options?.maxChars ?? 800);
  const lines = prompt.split(/\r?\n/u);
  const startIndex = lines.findIndex((line) => line.trim() === "recent_messages:");
  if (startIndex < 0) {
    return null;
  }

  let endIndex = lines.findIndex((line, index) => (
    index > startIndex &&
    (
      line.trim() === "pinned_state:" ||
      line.trim() === "active_context:" ||
      line.trim() === "rolling_summary:" ||
      line.trim() === "retrieved_memories:" ||
      line.trim() === "recent_messages:" ||
      line.trim() === "End session memory context."
    )
  ));
  if (endIndex < 0) {
    endIndex = lines.length;
  }

  const recentLines = lines
    .slice(startIndex + 1, endIndex)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .filter((line) => !/\[assistant\]\s+\[Deterministic turn summary\]/iu.test(line));
  if (recentLines.length === 0) {
    return null;
  }

  const boundedLines = recentLines.slice(-maxLines);
  const selectedLines: string[] = [];
  let usedChars = 0;

  for (let index = boundedLines.length - 1; index >= 0; index -= 1) {
    const line = boundedLines[index]!;
    const projectedChars = usedChars + line.length + (selectedLines.length > 0 ? 1 : 0);
    if (projectedChars <= maxChars) {
      selectedLines.unshift(line);
      usedChars = projectedChars;
      continue;
    }

    if (selectedLines.length === 0) {
      const tailBudget = Math.max(0, maxChars - 3);
      const tail = tailBudget > 0 ? line.slice(-tailBudget) : "";
      selectedLines.unshift(tail.length > 0 ? `...${tail}` : line.slice(-maxChars));
    }
    break;
  }

  if (
    selectedLines.length > 0
    && !selectedLines.some((line) => /https?:\/\/\S+/iu.test(line))
  ) {
    const referenceLine = [...boundedLines]
      .reverse()
      .find((line) => /https?:\/\/\S+/iu.test(line) && !selectedLines.includes(line));
    if (referenceLine) {
      const candidateLines = [referenceLine, ...selectedLines];
      while (
        candidateLines.join("\n").length > maxChars
        && candidateLines.length > 1
      ) {
        candidateLines.splice(1, 1);
      }
      if (candidateLines[0] && candidateLines.join("\n").length > maxChars) {
        const tailBudget = Math.max(0, maxChars - 3);
        candidateLines[0] =
          tailBudget > 0
            ? `...${candidateLines[0].slice(-tailBudget)}`
            : candidateLines[0].slice(-maxChars);
      }
      return candidateLines.join("\n");
    }
  }

  return selectedLines.length > 0 ? selectedLines.join("\n") : null;
}

function toPromptTracePinnedFact(fact: PinnedFactRecord): PromptTracePinnedFact {
  return {
    id: fact.id,
    scope: fact.scope,
    scopeId: fact.scopeId,
    key: fact.key,
    value: fact.value,
  };
}

function toPromptTraceActiveContextItem(item: ActiveContextItemRecord): PromptTraceActiveContextItem {
  return {
    id: item.id,
    key: item.key,
    kind: item.kind,
    title: item.title,
    summary: item.summary,
    keyFacts: item.keyFacts,
    sourceRefs: item.sourceRefs,
  };
}

function toPromptTraceSummary(summary: SessionSummaryRecord): PromptTraceSummary {
  return {
    id: summary.id,
    summaryText: summary.summaryText,
    tokenCount: summary.tokenCount,
    coversThroughMessageId: summary.coversThroughMessageId,
  };
}

function toPromptTraceMemory(memory: RetrievedMemoryRecord): PromptTraceMemory {
  return {
    id: memory.id,
    sessionId: memory.sessionId,
    agentId: memory.agentId,
    source: memory.source,
    content: memory.content,
    importance: memory.importance,
    sourceRef: memory.sourceRef,
    createdAt: memory.createdAt,
    provenance: resolveMemoryProvenance(memory),
    score: memory.score,
    relevanceScore: memory.relevanceScore,
    keywordScore: memory.keywordScore,
    semanticScore: memory.semanticScore,
    recencyScore: memory.recencyScore,
    sourceBonus: memory.sourceBonus,
    qualityPenalty: memory.qualityPenalty,
  };
}

function toPromptTraceMessage(message: StoredMessageRecord): PromptTraceMessage {
  return {
    id: message.id,
    direction: message.direction,
    content: message.content,
    createdAt: message.createdAt,
  };
}

function computeKeywordRelevance(query: string | undefined, memory: StoredMemoryRecord): number {
  if (!query || query.trim().length === 0) return 0;

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;

  const analysisText = buildMemoryAnalysisText(memory);
  const contentTokens = new Set(tokenize(analysisText));
  let overlap = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) overlap += 1;
  }

  const metadataKeywords = Array.isArray(memory.metadata?.keywords)
    ? memory.metadata?.keywords.filter((item): item is string => typeof item === "string")
    : [];
  const metadataKeywordTokens = new Set(
    metadataKeywords.flatMap((keyword) => tokenize(keyword))
  );
  for (const token of queryTokens) {
    if (metadataKeywordTokens.has(token)) {
      overlap += 0.25;
    }
  }

  const overlapScore = overlap / Math.max(queryTokens.length, 1);
  const phraseBoost = analysisText.toLowerCase().includes(query.toLowerCase()) ? 0.25 : 0;
  return clamp(overlapScore + phraseBoost, 0, 1);
}

function computeSemanticRelevance(
  queryEmbedding: number[] | null | undefined,
  memory: StoredMemoryRecord
): number {
  if (!queryEmbedding || queryEmbedding.length === 0) return 0;

  const memoryEmbedding =
    memory.embedding && memory.embedding.length > 0
      ? memory.embedding
      : deserializeEmbedding(memory.embeddingJson);
  if (!memoryEmbedding || memoryEmbedding.length === 0) return 0;

  const similarity = cosineSimilarity(queryEmbedding, memoryEmbedding);
  if (similarity === null) return 0;
  return clamp((similarity + 1) / 2, 0, 1);
}

/** True when a memory carries an embedding in either representation. */
export function memoryHasEmbedding(memory: StoredMemoryRecord): boolean {
  return (
    (typeof memory.embeddingJson === "string" && memory.embeddingJson.length > 0) ||
    (Array.isArray(memory.embedding) && memory.embedding.length > 0)
  );
}

function combineRelevanceScores(keywordScore: number, semanticScore: number): number {
  if (semanticScore <= 0) return keywordScore;
  if (keywordScore <= 0) return semanticScore;
  return clamp(Math.max(keywordScore, semanticScore * 0.9 + keywordScore * 0.25), 0, 1);
}

async function embedQuerySafely(
  embeddingProvider: EmbeddingProvider,
  query: string
): Promise<number[] | null> {
  try {
    const [embedding] = await embeddingProvider.embed([query], "query");
    return embedding && embedding.length > 0 ? embedding : null;
  } catch {
    return null;
  }
}

function computeRecencyScore(memory: StoredMemoryRecord, now: Date): number {
  // Use createdAt for obsidian memories to avoid popularity-reinforcement loops
  // where stale vault content keeps its recency high just by being retrieved.
  // For conversation/reflection memories, lastAccessedAt reflects genuine recency.
  const useCreatedAt = memory.source === "obsidian";
  const timestamp = useCreatedAt
    ? memory.createdAt
    : memory.lastAccessedAt || memory.createdAt;
  // UTC-safe: SQLite "YYYY-MM-DD HH:MM:SS" strings carry no zone marker and
  // Date.parse reads them as local time (TGO-689 bug class).
  const parsed = parseStoredTimestampMs(timestamp);
  if (parsed === 0) return 0.25;

  const hours = Math.max((now.getTime() - parsed) / 3_600_000, 0);
  return clamp(Math.pow(0.995, hours), 0, 1);
}

function memoryRetentionScore(memory: StoredMemoryRecord, now: Date): number {
  const recency = computeRecencyScore(memory, now);
  return clamp(memory.importance, 0, 1) * 2 + recency + Math.min(memory.accessCount * 0.1, 1);
}

function memorySourceBonus(source: StoredMemoryRecord["source"]): number {
  switch (source) {
    case "obsidian":
      return 0.1;
    case "reflection":
      return 0.3;
    case "manual":
      return 0.6;
    case "backfill":
      return 0.2;
    default:
      return 0.1;
  }
}

function formatActiveContextLine(item: ActiveContextItemRecord): string {
  const title = item.title ? ` ${truncateText(item.title, 80)}:` : "";
  const facts = item.keyFacts.length > 0
    ? ` facts=${item.keyFacts.slice(0, 6).map((fact) => truncateText(fact, 120)).join("; ")}`
    : "";
  const refs = item.sourceRefs.length > 0
    ? ` refs=${item.sourceRefs.slice(0, 4).map((ref) => truncateText(ref, 80)).join(", ")}`
    : "";
  return `- [${item.kind}]${title} ${truncateText(item.summary, 260)}${facts}${refs}`.trimEnd();
}

function formatMessageLine(
  message: Pick<StoredMessageRecord, "direction" | "content" | "createdAt">,
  maxChars = DEFAULT_MESSAGE_CONTEXT_CHARS,
): string {
  const speaker = message.direction === "inbound" ? "user" : "assistant";
  return `- [${speaker} at ${message.createdAt}] ${truncateText(message.content, maxChars)}`;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function truncateText(text: string, maxChars: number): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxChars) return normalized;

  // For long messages, keep beginning + end to preserve both context and conclusions.
  // Voice-transcribed monologues often build to an insight at the end.
  if (maxChars >= 200 && normalized.length > maxChars * 1.5) {
    const headChars = Math.floor(maxChars * 0.55);
    const tailChars = maxChars - headChars - 5; // 5 for " ... "
    if (tailChars > 40) {
      const head = normalized.slice(0, headChars).trimEnd();
      const tail = normalized.slice(-tailChars).trimStart();
      return `${head} ... ${tail}`;
    }
  }

  return `${normalized.slice(0, Math.max(maxChars - 3, 1))}...`;
}

function tokenize(text: string): string[] {
  return normalizeWhitespace(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/gu, " ")
    .split(/\s+/u)
    .map((token) => normalizeToken(token.trim()))
    .filter((token) => token.length > 2)
    .filter((token) => !STOP_WORDS.has(token));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeToken(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith("ies") && token.length > 4) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 4) {
    return token.slice(0, -1);
  }
  return token;
}

function analyzeQuery(query: string | undefined): QueryProfile {
  const normalized = normalizeWhitespace(query ?? "");
  const tokens = tokenize(normalized);
  return {
    normalized,
    tokens,
    domains: inferDomains(normalized),
    isOperational: OPERATIONAL_QUERY_PATTERN.test(normalized),
    skipRetrieval: shouldSkipMemoryRetrieval(normalized),
  };
}

function shouldSkipMemoryRetrieval(query: string | undefined): boolean {
  const normalized = normalizeWhitespace(query ?? "");
  if (normalized.length === 0) return true;

  const tokens = tokenize(normalized);

  // Short data-entry commands (workout sets, food logging) — skip retrieval
  // even when they contain digits.
  if (tokens.length <= 4 && normalized.length <= 48 && WORKOUT_LOGGING_PATTERN.test(normalized)) {
    return true;
  }

  if (/[0-9]/u.test(normalized)) return false;

  if (tokens.length > 3 || normalized.length > 48) return false;
  if (normalized.includes("?") && tokens.length > 2) return false;

  return LOW_ENTROPY_QUERY_PATTERNS.some((pattern) => pattern.test(normalized));
}

function computeQualityPenalty(input: {
  queryProfile: QueryProfile;
  memory: StoredMemoryRecord;
  keywordScore: number;
  semanticScore: number;
  sessionId?: string;
  agentId?: string;
}): number {
  let penalty = 0;

  if (isLowSignalGlobalOperationalObsidianMemory(input.memory)) {
    penalty += input.queryProfile.isOperational ? 0.35 : 1.35;
  }

  if (isGenericThemeReflection(input.memory)) {
    penalty += input.keywordScore > 0 ? 0.2 : 0.8;
  }

  if (input.queryProfile.domains.size > 0) {
    const memoryDomains = inferMemoryDomains(input.memory);
    const isGlobalMemory = input.memory.sessionId === null && input.memory.agentId === null;
    const isScopedRetrieval = Boolean(input.sessionId || input.agentId);

    if (isScopedRetrieval && isGlobalMemory && memoryDomains.size === 0) {
      penalty += input.memory.source === "obsidian" ? 1.0 : 0.8;
    }

    if (memoryDomains.size > 0 && !setsIntersect(input.queryProfile.domains, memoryDomains)) {
      penalty += 2.0;
      if (
        input.queryProfile.domains.has("wellness") &&
        (input.agentId === "malibu" || isWellnessProjectSession(input.sessionId))
      ) {
        penalty += 0.5;
      }
      if (input.queryProfile.domains.has("planning") && input.agentId === "watson") {
        penalty += 0.3;
      }
    }

    if (input.queryProfile.domains.size === 1 && memoryDomains.size > 1) {
      const [primaryDomain] = input.queryProfile.domains;
      if (
        primaryDomain === "wellness" &&
        (memoryDomains.has("product") || memoryDomains.has("fabrication") || memoryDomains.has("relationships"))
      ) {
        penalty += 0.8;
      }
      if (
        primaryDomain === "planning" &&
        (memoryDomains.has("wellness") || memoryDomains.has("fabrication") || memoryDomains.has("relationships"))
      ) {
        penalty += 0.5;
      }
    }

    // Multi-domain obsidian notes in scoped retrieval that match query domain incidentally
    // (e.g., a migration audit note mentioning "health" in passing)
    if (
      isScopedRetrieval &&
      isGlobalMemory &&
      input.memory.source === "obsidian" &&
      memoryDomains.size > 1 &&
      input.queryProfile.domains.size === 1
    ) {
      penalty += 0.5;
    }
  }

  if (input.keywordScore === 0 && input.semanticScore < 0.58) {
    penalty += 0.3;
  }
  if (input.keywordScore === 0 && input.semanticScore < 0.45 && memoryHasEmbedding(input.memory)) {
    penalty += 0.4;
  }

  // Obsidian memories with weak relevance signals get an additional penalty
  // to prevent generic vault notes from saturating retrieval on incidental keyword overlap.
  if (input.memory.source === "obsidian") {
    const relevance = combineRelevanceScores(input.keywordScore, input.semanticScore);
    if (relevance < 0.3) {
      penalty += 0.6;
    } else if (relevance < 0.5) {
      penalty += 0.3;
    }
  }

  return penalty;
}

function computeScopeBonus(input: {
  memory: StoredMemoryRecord;
  sessionId?: string;
  agentId?: string;
}): number {
  let bonus = 0;

  if (input.sessionId && input.memory.sessionId === input.sessionId) {
    bonus += 0.6;
  }

  if (input.agentId && input.memory.agentId === input.agentId) {
    bonus += 0.35;
  }

  return bonus;
}

function isWellnessProjectSession(sessionId: string | null | undefined): boolean {
  const normalized = sessionId?.trim().toLowerCase();
  return normalized === "project:wellness" || normalized?.startsWith("project:wellness#") === true;
}

function inferMemoryDomains(memory: StoredMemoryRecord): Set<MemoryDomain> {
  return inferDomains(buildMemoryAnalysisText(memory));
}

function inferDomains(text: string): Set<MemoryDomain> {
  const domains = new Set<MemoryDomain>();
  for (const entry of MEMORY_DOMAIN_PATTERNS) {
    if (entry.pattern.test(text)) {
      domains.add(entry.domain);
    }
  }
  if (containsProfilePersonalTopicTerm(text)) {
    domains.add("relationships");
  }
  return domains;
}

function containsProfilePersonalTopicTerm(text: string): boolean {
  const normalized = text.toLowerCase();
  if (!normalized) {
    return false;
  }

  return readProfileConfigStringList({
    relativePath: PERSONAL_TOPIC_TERMS_CONFIG_PATH,
    envPathVar: "TANGO_MEMORY_PERSONAL_TOPIC_TERMS_FILE",
    envValueVar: "TANGO_MEMORY_PERSONAL_TOPIC_TERMS",
    lowercase: true,
  }).some((term) => term.length > 1 && normalized.includes(term));
}

function buildMemoryAnalysisText(memory: StoredMemoryRecord): string {
  const metadata = memory.metadata;
  const filePath = getMetadataString(metadata, "filePath");
  const title = getMetadataString(metadata, "title");
  const heading = getMetadataString(metadata, "heading");
  const summaryText = getMetadataString(metadata, "summaryText");
  const tags = getMetadataStringArray(metadata, "tags").join(" ");
  const keywords = getMetadataStringArray(metadata, "keywords").join(" ");

  return [
    filePath,
    title,
    heading,
    summaryText,
    tags,
    keywords,
    memory.sourceRef ?? "",
    memory.content,
  ]
    .filter((value) => value.length > 0)
    .join(" ");
}

export function isLowSignalGlobalOperationalObsidianMemory(memory: StoredMemoryRecord): boolean {
  if (memory.source !== "obsidian") return false;
  if (memory.sessionId !== null || memory.agentId !== null) return false;

  const metadata = memory.metadata;
  const filePath = getMetadataString(metadata, "filePath").toLowerCase();
  const title = getMetadataString(metadata, "title").toLowerCase();
  const heading = getMetadataString(metadata, "heading").toLowerCase();
  const content = memory.content.toLowerCase();
  const checkboxCount = (content.match(/\[[ x]\]/gu) ?? []).length;

  if (filePath.includes("/planning/daily/")) {
    if (title === "in progress") return true;
    if (heading === "in progress") return true;
    if (
      heading === "primary tasks" ||
      heading === "stretch tasks" ||
      heading === "other work" ||
      heading === "unscheduled work i did today"
    ) {
      return true;
    }
  }

  if (title === "in progress" && checkboxCount >= 2) return true;
  if (checkboxCount >= 3 && /\blast active\b/u.test(content)) return true;
  return false;
}

function isGenericThemeReflection(memory: StoredMemoryRecord): boolean {
  return memory.source === "reflection" && /^recurring theme:/iu.test(memory.content.trim());
}

function setsIntersect<T>(left: Set<T>, right: Set<T>): boolean {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function getMetadataString(
  metadata: StoredMemoryRecord["metadata"] | null,
  key: string
): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function getMetadataStringArray(
  metadata: StoredMemoryRecord["metadata"] | null,
  key: string
): string[] {
  const value = metadata?.[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
