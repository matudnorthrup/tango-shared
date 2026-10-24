import type { EmbeddingProvider } from "./embeddings.js";
import { serializeEmbedding } from "./embeddings.js";
import { extractMemoryKeywords, isLowSignalGlobalOperationalObsidianMemory } from "./memory-system.js";
import type { StoredMemoryRecord } from "./storage.js";
import { TangoStorage } from "./storage.js";

const DEFAULT_LOOKBACK_HOURS = 24;
const DEFAULT_MAX_REFLECTIONS = 5;
const DEFAULT_SCAN_LIMIT = 500;
const DEFAULT_MIN_IMPORTANCE = 0.35;
const MAX_THEME_GROUP_RATIO = 0.05;
const MIN_THEME_KEYWORD_LENGTH = 3;

const PREFERENCE_PATTERN =
  /\b(prefer|preference|always|never|usually|tend|like|dislike|concise|brief|short)\b/iu;
const DECISION_PATTERN =
  /\b(decide|decided|decision|plan|planned|next|follow[- ]?up|ship|launch|deadline|cadence|schedule)\b/iu;
const REFLECTION_STOP_KEYWORDS = new Set([
  "---",
  "across",
  "agent",
  "all",
  "about",
  "active",
  "anymore",
  "assistant",
  "but",
  "can",
  "cal",
  "channel",
  "current",
  "daily",
  "day",
  "did",
  "discussed",
  "notes",
  "state",
  "summary",
  "today",
  "what",
]);

const PRIMARY_KEYWORD_PATTERN = /^recurring theme:\s*([^,.]+)/iu;

export function extractPrimaryKeyword(content: string): string | null {
  const match = PRIMARY_KEYWORD_PATTERN.exec(content.trim());
  if (!match?.[1]) return null;
  return match[1].trim().toLowerCase() || null;
}

export type ReflectionKind = "theme" | "preference" | "decision";

export interface ReflectionCandidate {
  kind: ReflectionKind;
  content: string;
  importance: number;
  keywords: string[];
  sourceMemoryIds: number[];
}

export interface GenerateReflectionCandidatesInput {
  memories: StoredMemoryRecord[];
  existingReflections?: StoredMemoryRecord[];
  lookbackHours?: number;
  maxReflections?: number;
  minimumImportance?: number;
  sessionId?: string | null;
  agentId?: string | null;
  now?: Date;
}

export interface MemoryReflectionCycleInput {
  storage: TangoStorage;
  embeddingProvider?: EmbeddingProvider | null;
  lookbackHours?: number;
  maxReflections?: number;
  minimumImportance?: number;
  scanLimit?: number;
  sessionId?: string | null;
  agentId?: string | null;
  now?: Date;
}

export interface MemoryReflectionCycleResult {
  scannedCount: number;
  eligibleCount: number;
  createdCount: number;
  createdMemories: StoredMemoryRecord[];
}

interface ScoredMemory {
  memory: StoredMemoryRecord;
  keywords: string[];
  score: number;
}

interface RankedReflectionCandidate extends ReflectionCandidate {
  rankScore: number;
}

export function generateReflectionCandidates(
  input: GenerateReflectionCandidatesInput
): ReflectionCandidate[] {
  const now = input.now ?? new Date();
  const lookbackHours = normalizePositiveInteger(input.lookbackHours, DEFAULT_LOOKBACK_HOURS);
  const maxReflections = normalizePositiveInteger(input.maxReflections, DEFAULT_MAX_REFLECTIONS);
  const minimumImportance = clamp(input.minimumImportance ?? DEFAULT_MIN_IMPORTANCE, 0, 1);
  const cutoffMs = now.getTime() - lookbackHours * 3_600_000;

  const eligible = input.memories
    .filter((memory) => isScopedMemory(memory, input.sessionId, input.agentId))
    .filter((memory) => memory.archivedAt === null)
    .filter((memory) => memory.source !== "reflection")
    .filter((memory) => !isLowSignalGlobalOperationalObsidianMemory(memory))
    .filter((memory) => clamp(memory.importance, 0, 1) >= minimumImportance)
    .filter((memory) => parseMemoryTimestamp(memory) >= cutoffMs);

  if (eligible.length === 0) return [];

  const existingReflections = (input.existingReflections ?? input.memories)
    .filter((memory) => isScopedMemory(memory, input.sessionId, input.agentId))
    .filter((memory) => memory.archivedAt === null)
    .filter((memory) => memory.source === "reflection");

  const scored = eligible
    .map((memory) => ({
      memory,
      keywords: getMemoryKeywords(memory),
      score: computeSourceScore(memory, now),
    }))
    .sort((a, b) => b.score - a.score || b.memory.id - a.memory.id);

  const rankedCandidates: RankedReflectionCandidate[] = [];

  rankedCandidates.push(...buildThemeCandidates(scored));

  const preferenceCandidate = buildSingleMemoryCandidate(scored, "preference");
  if (preferenceCandidate) rankedCandidates.push(preferenceCandidate);

  const decisionCandidate = buildSingleMemoryCandidate(scored, "decision");
  if (decisionCandidate) rankedCandidates.push(decisionCandidate);

  const selected: ReflectionCandidate[] = [];
  const comparisonTexts = existingReflections.map((memory) => memory.content);

  // Build set of primary keywords already covered by existing reflections
  const existingPrimaryKeywords = new Set<string>();
  for (const memory of existingReflections) {
    const pk = extractPrimaryKeyword(memory.content);
    if (pk) existingPrimaryKeywords.add(pk);
  }

  for (const candidate of rankedCandidates.sort((a, b) => b.rankScore - a.rankScore)) {
    if (selected.length >= maxReflections) break;
    if (
      comparisonTexts.some((content) => isDuplicateReflectionText(content, candidate.content)) ||
      selected.some((existing) => isNearDuplicateCandidate(existing, candidate))
    ) {
      continue;
    }

    // Skip theme candidates whose primary keyword already has a reflection
    if (candidate.kind === "theme") {
      const pk = extractPrimaryKeyword(candidate.content);
      if (pk && existingPrimaryKeywords.has(pk)) continue;
    }

    selected.push({
      kind: candidate.kind,
      content: candidate.content,
      importance: candidate.importance,
      keywords: candidate.keywords,
      sourceMemoryIds: candidate.sourceMemoryIds,
    });
    comparisonTexts.push(candidate.content);

    // Track newly selected primary keywords too
    const pk = extractPrimaryKeyword(candidate.content);
    if (pk) existingPrimaryKeywords.add(pk);
  }

  return selected;
}

export async function runMemoryReflectionCycle(
  input: MemoryReflectionCycleInput
): Promise<MemoryReflectionCycleResult> {
  const now = input.now ?? new Date();
  const lookbackHours = normalizePositiveInteger(input.lookbackHours, DEFAULT_LOOKBACK_HOURS);
  const maxReflections = normalizePositiveInteger(input.maxReflections, DEFAULT_MAX_REFLECTIONS);
  const minimumImportance = clamp(input.minimumImportance ?? DEFAULT_MIN_IMPORTANCE, 0, 1);
  const scanLimit = normalizePositiveInteger(
    input.scanLimit,
    Math.max(DEFAULT_SCAN_LIMIT, maxReflections * 100)
  );

  const memories = input.storage.listMemories({
    sessionId: input.sessionId,
    agentId: input.agentId,
    source: "all",
    limit: scanLimit,
  });
  const candidates = generateReflectionCandidates({
    memories,
    lookbackHours,
    maxReflections,
    minimumImportance,
    sessionId: input.sessionId,
    agentId: input.agentId,
    now,
  });

  if (candidates.length === 0) {
    return {
      scannedCount: memories.length,
      eligibleCount: countEligibleMemories(memories, {
        lookbackHours,
        minimumImportance,
        sessionId: input.sessionId,
        agentId: input.agentId,
        now,
      }),
      createdCount: 0,
      createdMemories: [],
    };
  }

  const embeddings = await embedCandidates(input.embeddingProvider ?? null, candidates);
  const createdMemories: StoredMemoryRecord[] = [];

  for (const [index, candidate] of candidates.entries()) {
    const embedding = embeddings[index] ?? null;
    const memoryId = input.storage.insertMemory({
      sessionId: input.sessionId ?? null,
      agentId: input.agentId ?? null,
      source: "reflection",
      content: candidate.content,
      importance: candidate.importance,
      sourceRef:
        candidate.sourceMemoryIds.length > 0 ? candidate.sourceMemoryIds.join(",") : null,
      embeddingJson: embedding ? serializeEmbedding(embedding) : null,
      embeddingModel: embedding ? input.embeddingProvider?.model ?? null : null,
      metadata: {
        kind: candidate.kind,
        keywords: candidate.keywords,
        sourceMemoryIds: candidate.sourceMemoryIds,
        lookbackHours,
        generatedBy: "memory_reflect",
      },
    });

    const stored = input.storage.getMemory(memoryId);
    if (stored) {
      createdMemories.push(stored);
    }
  }

  return {
    scannedCount: memories.length,
    eligibleCount: countEligibleMemories(memories, {
      lookbackHours,
      minimumImportance,
      sessionId: input.sessionId,
      agentId: input.agentId,
      now,
    }),
    createdCount: createdMemories.length,
    createdMemories,
  };
}

function buildThemeCandidates(scored: ScoredMemory[]): RankedReflectionCandidate[] {
  const groups = new Map<string, ScoredMemory[]>();
  const maxGroupSize = Math.max(12, Math.floor(scored.length * MAX_THEME_GROUP_RATIO));

  for (const entry of scored) {
    for (const keyword of entry.keywords.slice(0, 4)) {
      const current = groups.get(keyword) ?? [];
      current.push(entry);
      groups.set(keyword, current);
    }
  }

  const candidates: RankedReflectionCandidate[] = [];

  for (const [keyword, members] of groups.entries()) {
    const uniqueMembers = uniqueMemories(members);
    if (uniqueMembers.length < 2) continue;
    if (uniqueMembers.length > maxGroupSize) continue;

    const companionKeywords = collectCompanionKeywords(uniqueMembers, keyword);
    const contentKeywords = [keyword, ...companionKeywords].slice(0, 3);
    const representative = summarizeRepresentativeMemory(uniqueMembers[0]?.memory);
    const content = representative.length > 0
      ? `Recurring theme: ${formatKeywordList(contentKeywords)}. Example: ${representative}`
      : `Recurring theme: ${formatKeywordList(contentKeywords)} across ${uniqueMembers.length} memories.`;
    const sourceMemoryIds = uniqueMembers.slice(0, 3).map((entry) => entry.memory.id);
    const totalScore = uniqueMembers.reduce((sum, entry) => sum + entry.score, 0);
    const averageImportance =
      uniqueMembers.reduce((sum, entry) => sum + clamp(entry.memory.importance, 0, 1), 0) /
      uniqueMembers.length;

    candidates.push({
      kind: "theme",
      content,
      importance: clamp(averageImportance + Math.min((uniqueMembers.length - 1) * 0.08, 0.2), 0.45, 0.95),
      keywords: contentKeywords,
      sourceMemoryIds,
      rankScore: totalScore + uniqueMembers.length * 0.25,
    });
  }

  return candidates;
}

function buildSingleMemoryCandidate(
  scored: ScoredMemory[],
  kind: "preference" | "decision"
): RankedReflectionCandidate | null {
  const pattern = kind === "preference" ? PREFERENCE_PATTERN : DECISION_PATTERN;
  const match = scored.find((entry) => pattern.test(entry.memory.content));
  if (!match) return null;

  return {
    kind,
    content: `${kind === "preference" ? "Preference insight" : "Decision insight"}: ${ensureSentence(match.memory.content)}`,
    importance: clamp(match.memory.importance + 0.05, 0.5, 0.95),
    keywords: match.keywords.slice(0, 4),
    sourceMemoryIds: [match.memory.id],
    rankScore: match.score + (kind === "preference" ? 0.5 : 0.4),
  };
}

function countEligibleMemories(
  memories: StoredMemoryRecord[],
  input: {
    lookbackHours: number;
    minimumImportance: number;
    sessionId?: string | null;
    agentId?: string | null;
    now: Date;
  }
): number {
  const cutoffMs = input.now.getTime() - input.lookbackHours * 3_600_000;
  return memories
    .filter((memory) => isScopedMemory(memory, input.sessionId, input.agentId))
    .filter((memory) => memory.archivedAt === null)
    .filter((memory) => memory.source !== "reflection")
    .filter((memory) => !isLowSignalGlobalOperationalObsidianMemory(memory))
    .filter((memory) => clamp(memory.importance, 0, 1) >= input.minimumImportance)
    .filter((memory) => parseMemoryTimestamp(memory) >= cutoffMs)
    .length;
}

function isScopedMemory(
  memory: StoredMemoryRecord,
  sessionId?: string | null,
  agentId?: string | null
): boolean {
  const sessionMatch =
    sessionId === undefined || sessionId === null
      ? true
      : memory.sessionId === null || memory.sessionId === sessionId;
  const agentMatch =
    agentId === undefined || agentId === null
      ? true
      : memory.agentId === null || memory.agentId === agentId;
  return sessionMatch && agentMatch;
}

function computeSourceScore(memory: StoredMemoryRecord, now: Date): number {
  const createdAtMs = parseMemoryTimestamp(memory);
  const ageHours = Math.max((now.getTime() - createdAtMs) / 3_600_000, 0);
  const recency = clamp(Math.pow(0.985, ageHours), 0, 1);
  return clamp(memory.importance, 0, 1) * 2 + recency + Math.min(memory.accessCount * 0.05, 0.5);
}

function getMemoryKeywords(memory: StoredMemoryRecord): string[] {
  const metadataKeywords = readStringArray(memory.metadata?.keywords);
  const metadataTags = readStringArray(memory.metadata?.tags);

  return [...new Set([
    ...metadataTags,
    ...metadataKeywords,
    ...extractMemoryKeywords(memory.content, 6),
  ])]
    .filter((keyword) => isUsefulReflectionKeyword(keyword))
    .slice(0, 6);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

function isUsefulReflectionKeyword(keyword: string): boolean {
  const normalized = keyword.trim().toLowerCase();
  if (normalized.length < MIN_THEME_KEYWORD_LENGTH) return false;
  if (REFLECTION_STOP_KEYWORDS.has(normalized)) return false;
  if (/^[-_]+$/u.test(normalized)) return false;
  return /[a-z0-9]/u.test(normalized);
}

function collectCompanionKeywords(entries: ScoredMemory[], primaryKeyword: string): string[] {
  const counts = new Map<string, number>();

  for (const entry of entries) {
    for (const keyword of entry.keywords) {
      if (keyword === primaryKeyword) continue;
      counts.set(keyword, (counts.get(keyword) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 2)
    .map(([keyword]) => keyword);
}

function uniqueMemories(entries: ScoredMemory[]): ScoredMemory[] {
  const unique = new Map<number, ScoredMemory>();
  for (const entry of entries) {
    if (!unique.has(entry.memory.id)) {
      unique.set(entry.memory.id, entry);
    }
  }
  return [...unique.values()].sort((a, b) => b.score - a.score || b.memory.id - a.memory.id);
}

function formatKeywordList(keywords: string[]): string {
  const labels = keywords
    .map((keyword) => keyword.replace(/[-_]+/gu, " ").trim())
    .filter((keyword) => keyword.length > 0);
  if (labels.length === 0) return "shared topics";
  if (labels.length === 1) return labels[0] ?? "shared topics";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels[0]}, ${labels[1]}, and ${labels[2]}`;
}

function summarizeRepresentativeMemory(memory: StoredMemoryRecord | undefined): string {
  if (!memory) return "";

  const normalized = memory.content.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return "";

  const afterFirstColon = normalized.includes(":")
    ? normalized.slice(normalized.indexOf(":") + 1).trim()
    : normalized;
  const firstSentence = afterFirstColon.split(/(?<=[.!?])\s+/u)[0] ?? afterFirstColon;
  return truncateReflectionText(firstSentence, 180);
}

function truncateReflectionText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(maxChars - 3, 1))}...`;
}

function ensureSentence(text: string): string {
  const normalized = text.trim().replace(/\s+/gu, " ");
  if (normalized.length === 0) return "";
  return /[.!?]$/u.test(normalized) ? normalized : `${normalized}.`;
}

function isNearDuplicateCandidate(
  existing: ReflectionCandidate,
  candidate: ReflectionCandidate
): boolean {
  if (isDuplicateReflectionText(existing.content, candidate.content)) return true;

  const overlap = candidate.sourceMemoryIds.filter((id) => existing.sourceMemoryIds.includes(id)).length;
  const maxSize = Math.max(existing.sourceMemoryIds.length, candidate.sourceMemoryIds.length, 1);
  return overlap / maxSize >= 0.67;
}

function isDuplicateReflectionText(left: string, right: string): boolean {
  const normalizedLeft = normalizeComparableText(left);
  const normalizedRight = normalizeComparableText(right);
  if (normalizedLeft === normalizedRight) return true;

  const leftTokens = new Set(tokenizeComparableText(normalizedLeft));
  const rightTokens = new Set(tokenizeComparableText(normalizedRight));
  if (leftTokens.size === 0 || rightTokens.size === 0) return false;

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }

  const union = leftTokens.size + rightTokens.size - overlap;
  return union > 0 ? overlap / union >= 0.7 : false;
}

function normalizeComparableText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function tokenizeComparableText(text: string): string[] {
  return text
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 2);
}

function parseMemoryTimestamp(memory: StoredMemoryRecord): number {
  const parsed = Date.parse(memory.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function embedCandidates(
  embeddingProvider: EmbeddingProvider | null,
  candidates: ReflectionCandidate[]
): Promise<Array<number[] | null>> {
  if (!embeddingProvider || candidates.length === 0) {
    return candidates.map(() => null);
  }

  try {
    const embeddings = await embeddingProvider.embed(
      candidates.map((candidate) => candidate.content),
      "document"
    );
    return candidates.map((_, index) => embeddings[index] ?? null);
  } catch {
    return candidates.map(() => null);
  }
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
