import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { EmbeddingProvider } from "./embeddings.js";
import { serializeEmbedding } from "./embeddings.js";
import { extractMemoryKeywords } from "./memory-system.js";
import { resolveTangoProfileDataDir } from "./runtime-paths.js";
import { TangoStorage } from "./storage.js";
import type { MemorySource } from "./types.js";

const DEFAULT_ROOT_PATH_CANDIDATES = [
  "data/imports/ai-archive/AI/Conversations/Migrated",
  path.join(resolveTangoProfileDataDir(), "imports", "ai-archive", "AI", "Conversations", "Migrated"),
];
const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_MIN_CONVERSATION_SCORE = 0.4;
const DEFAULT_MAX_DURABLE_PER_CONVERSATION = 2;
const GENERIC_TITLES = new Set(["new chat", "chatgpt export", "untitled", "conversation"]);
const LOW_SIGNAL_TAGS = new Set(["daily"]);

export interface MigratedChatGptTurn {
  role: "user" | "assistant";
  content: string;
}

export interface MigratedChatGptConversation {
  filePath: string;
  fileTitle: string;
  fileTags: string[];
  title: string;
  sectionTitle: string | null;
  tags: string[];
  createdAt: string | null;
  conversationIndex: number;
  turns: MigratedChatGptTurn[];
}

export interface MigratedChatGptFile {
  filePath: string;
  title: string;
  tags: string[];
  createdAt: string | null;
  conversations: MigratedChatGptConversation[];
}

export interface DurableInsightCandidate {
  content: string;
  score: number;
  sourceExcerpt: string;
  keywords: string[];
}

export interface MigratedChatGptConversationTriage {
  conversationIndex: number;
  title: string;
  sectionTitle: string | null;
  tags: string[];
  score: number;
  predictedMemoryCount: number;
  durableCount: number;
  userTurnCount: number;
  assistantTurnCount: number;
  userChars: number;
  assistantChars: number;
  summaryPreview: string;
  durableInsights: DurableInsightCandidate[];
}

export interface MigratedChatGptFileTriage {
  filePath: string;
  title: string;
  createdAt: string | null;
  score: number;
  conversationCount: number;
  highSignalConversationCount: number;
  predictedMemoryCount: number;
  topTags: string[];
  topConversations: MigratedChatGptConversationTriage[];
}

export interface MigratedChatGptTriageResult {
  rootPaths: string[];
  fileCount: number;
  conversationCount: number;
  predictedMemoryCount: number;
  files: MigratedChatGptFileTriage[];
}

export interface ImportMigratedChatGptOptions {
  storage: TangoStorage;
  paths?: string[];
  sessionId?: string | null;
  agentId?: string | null;
  memorySource?: MemorySource;
  embeddingProvider?: EmbeddingProvider | null;
  limitFiles?: number;
  maxConversationsPerFile?: number;
  minConversationScore?: number;
  maxDurableMemoriesPerConversation?: number;
  dryRun?: boolean;
}

export interface ImportMigratedChatGptResult {
  triage: MigratedChatGptTriageResult;
  selectedFileCount: number;
  selectedConversationCount: number;
  candidateCount: number;
  insertedCount: number;
  skippedCount: number;
  insertedIds: number[];
  insertedSourceRefs: string[];
  skippedSourceRefs: string[];
  selectedFiles: Array<{
    filePath: string;
    score: number;
    selectedConversationTitles: string[];
  }>;
}

interface MarkdownDocument {
  filePath: string;
  title: string;
  body: string;
  tags: string[];
  createdAt: string | null;
}

interface MemoryCandidate {
  sessionId?: string | null;
  agentId?: string | null;
  source: MemorySource;
  sourceRef: string;
  content: string;
  importance: number;
  createdAt?: string | null;
  metadata?: Record<string, unknown> | null;
}

export function triageMigratedChatGptExports(input: {
  paths?: string[];
  maxDurableMemoriesPerConversation?: number;
} = {}): MigratedChatGptTriageResult {
  const rootPaths = resolveDefaultRootPaths(input.paths);
  const files = collectFiles(rootPaths, new Set([".md", ".markdown"]))
    .map((filePath) => parseMigratedChatGptFile(filePath))
    .filter((file): file is MigratedChatGptFile => file !== null);

  const fileTriages = files
    .map((file) =>
      triageFile(file, input.maxDurableMemoriesPerConversation ?? DEFAULT_MAX_DURABLE_PER_CONVERSATION)
    )
    .filter((file) => file.conversationCount > 0)
    .sort((left, right) => right.score - left.score || left.filePath.localeCompare(right.filePath));

  return {
    rootPaths: rootPaths.map((value) => path.resolve(expandHome(value))),
    fileCount: fileTriages.length,
    conversationCount: fileTriages.reduce((sum, file) => sum + file.conversationCount, 0),
    predictedMemoryCount: fileTriages.reduce((sum, file) => sum + file.predictedMemoryCount, 0),
    files: fileTriages,
  };
}

function resolveDefaultRootPaths(paths?: string[]): string[] {
  if (paths && paths.length > 0) return paths;

  for (const candidate of DEFAULT_ROOT_PATH_CANDIDATES) {
    if (fs.existsSync(path.resolve(expandHome(candidate)))) {
      return [candidate];
    }
  }

  return [DEFAULT_ROOT_PATH_CANDIDATES[0] ?? "data/imports/ai-archive/AI/Conversations/Migrated"];
}

export async function importMigratedChatGptExports(
  input: ImportMigratedChatGptOptions
): Promise<ImportMigratedChatGptResult> {
  const triage = triageMigratedChatGptExports({
    paths: input.paths,
    maxDurableMemoriesPerConversation:
      input.maxDurableMemoriesPerConversation ?? DEFAULT_MAX_DURABLE_PER_CONVERSATION,
  });
  const limitFiles = input.limitFiles ? Math.max(1, Math.floor(input.limitFiles)) : triage.files.length;
  const maxConversationsPerFile = input.maxConversationsPerFile
    ? Math.max(1, Math.floor(input.maxConversationsPerFile))
    : undefined;
  const minConversationScore = clamp(
    input.minConversationScore ?? DEFAULT_MIN_CONVERSATION_SCORE,
    0,
    1
  );
  const memorySource = input.memorySource ?? "backfill";
  const selectedFiles = triage.files.slice(0, limitFiles);
  const candidates: MemoryCandidate[] = [];
  let selectedConversationCount = 0;

  for (const file of selectedFiles) {
    const selectedConversations = file.topConversations
      .filter((conversation) => conversation.score >= minConversationScore)
      .slice(0, maxConversationsPerFile ?? file.topConversations.length);

    selectedConversationCount += selectedConversations.length;

    for (const conversation of selectedConversations) {
      candidates.push(
        ...buildConversationMemoryCandidates(
          conversation,
          {
            filePath: file.filePath,
            sessionId: input.sessionId ?? null,
            agentId: input.agentId ?? null,
            source: memorySource,
            createdAt: file.createdAt,
          },
          input.maxDurableMemoriesPerConversation ?? DEFAULT_MAX_DURABLE_PER_CONVERSATION
        )
      );
    }
  }

  const persisted = await persistCandidates(input.storage, candidates, {
    dryRun: input.dryRun,
    embeddingProvider: input.embeddingProvider ?? null,
  });

  return {
    triage,
    selectedFileCount: selectedFiles.length,
    selectedConversationCount,
    candidateCount: persisted.candidateCount,
    insertedCount: persisted.insertedCount,
    skippedCount: persisted.skippedCount,
    insertedIds: persisted.insertedIds,
    insertedSourceRefs: persisted.insertedSourceRefs,
    skippedSourceRefs: persisted.skippedSourceRefs,
    selectedFiles: selectedFiles.map((file) => ({
      filePath: file.filePath,
      score: file.score,
      selectedConversationTitles: file.topConversations
        .filter((conversation) => conversation.score >= minConversationScore)
        .slice(0, maxConversationsPerFile ?? file.topConversations.length)
        .map((conversation) => conversation.title),
    })),
  };
}

export function parseMigratedChatGptFile(filePath: string): MigratedChatGptFile | null {
  const document = readMarkdownDocument(filePath);
  if (!document) return null;

  const conversations = parseConversations(document);
  if (conversations.length === 0) return null;

  return {
    filePath: document.filePath,
    title: document.title,
    tags: document.tags,
    createdAt: document.createdAt,
    conversations,
  };
}

function parseConversations(document: MarkdownDocument): MigratedChatGptConversation[] {
  const conversations: MigratedChatGptConversation[] = [];
  const lines = document.body.split(/\r?\n/u).map((line) => line.trimEnd());
  let currentSection: string | null = null;
  const starts: Array<{ index: number; title: string; sectionTitle: string | null }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (isSectionHeading(lines, index)) {
      const title = lines[index]?.trim().replace(/^##\s+/u, "") ?? "";
      currentSection = title.length > 0 ? title : currentSection;
      continue;
    }

    if (isConversationStart(lines, index)) {
      const title = lines[index]?.trim().replace(/^###\s+/u, "") ?? "";
      starts.push({
        index,
        title,
        sectionTitle: currentSection,
      });
    }
  }

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    if (!start) continue;
    const next = starts[index + 1];
    const blockLines = lines.slice(start.index, next?.index ?? lines.length);
    const tags = readConversationTags(blockLines);
    const turns = extractTurnsFromBlock(blockLines);
    const userTurnCount = turns.filter((turn) => turn.role === "user").length;
    const assistantTurnCount = turns.filter((turn) => turn.role === "assistant").length;
    if (turns.length === 0 || userTurnCount === 0 || assistantTurnCount === 0) continue;

    conversations.push({
      filePath: document.filePath,
      fileTitle: document.title,
      fileTags: document.tags,
      title: start.title,
      sectionTitle: start.sectionTitle,
      tags,
      createdAt: document.createdAt,
      conversationIndex: conversations.length + 1,
      turns,
    });
  }

  return conversations;
}

function extractTurnsFromBlock(lines: string[]): MigratedChatGptTurn[] {
  const turns: MigratedChatGptTurn[] = [];
  let currentRole: MigratedChatGptTurn["role"] | null = null;
  let currentBuffer: string[] = [];

  const flushTurn = () => {
    if (!currentRole) return;
    const content = normalizeWhitespace(currentBuffer.join("\n"));
    if (content.length > 0) {
      turns.push({
        role: currentRole,
        content,
      });
    }
    currentRole = null;
    currentBuffer = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const roleMatch = line.match(/^\*\*(Me|ChatGPT):\*\*\s*(.*)$/u);
    if (roleMatch?.[1]) {
      flushTurn();
      currentRole = roleMatch[1] === "Me" ? "user" : "assistant";
      currentBuffer = roleMatch[2] ? [roleMatch[2]] : [];
      continue;
    }

    if (!currentRole) continue;
    if (trimmed === "---") continue;
    currentBuffer.push(line);
  }

  flushTurn();
  return squashSequentialTurns(turns);
}

function readConversationTags(lines: string[]): string[] {
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\*\*(Me|ChatGPT):\*\*/u.test(trimmed)) break;

    const tagMatch = trimmed.match(/^Tags:\s*(.*)$/iu);
    if (tagMatch) {
      return normalizeInlineTags(tagMatch[1]);
    }
  }

  return [];
}

function isConversationStart(lines: string[], index: number): boolean {
  const line = lines[index]?.trim();
  if (!line || !/^###\s+.+$/u.test(line)) return false;

  let sawTags = false;
  let sawUserTurn = false;
  let nonEmptySeen = 0;
  for (let cursor = index + 1; cursor < lines.length && nonEmptySeen < 10; cursor += 1) {
    const next = lines[cursor]?.trim();
    if (!next) continue;
    nonEmptySeen += 1;

    if (/^###\s+/u.test(next) || /^##\s+/u.test(next)) return false;
    if (/^Tags:\s*/iu.test(next)) {
      sawTags = true;
      continue;
    }
    if (/^\*\*Me:\*\*/u.test(next)) {
      sawUserTurn = true;
      break;
    }
    if (/^\*\*ChatGPT:\*\*/u.test(next)) return false;
  }

  return sawTags && sawUserTurn;
}

function isSectionHeading(lines: string[], index: number): boolean {
  const line = lines[index]?.trim();
  if (!line || !/^##\s+.+$/u.test(line) || /^###\s+/u.test(line)) return false;

  let nonEmptySeen = 0;
  for (let cursor = index + 1; cursor < lines.length && nonEmptySeen < 12; cursor += 1) {
    const next = lines[cursor]?.trim();
    if (!next) continue;
    nonEmptySeen += 1;

    if (isConversationStart(lines, cursor)) return true;
    if (/^##\s+/u.test(next) || /^\*\*(Me|ChatGPT):\*\*/u.test(next)) return false;
  }

  return false;
}

function triageFile(
  file: MigratedChatGptFile,
  maxDurableMemoriesPerConversation: number
): MigratedChatGptFileTriage {
  const conversations = file.conversations
    .map((conversation) => triageConversation(conversation, maxDurableMemoriesPerConversation))
    .sort((left, right) => right.score - left.score || left.conversationIndex - right.conversationIndex);
  const topConversations = conversations;
  const topScores = conversations.slice(0, 4);
  const averageTopScore =
    topScores.length > 0
      ? topScores.reduce((sum, conversation) => sum + conversation.score, 0) / topScores.length
      : 0;
  const highSignalConversationCount = conversations.filter((conversation) => conversation.score >= 0.6).length;
  const tagCounts = new Map<string, number>();

  for (const conversation of conversations) {
    for (const tag of conversation.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const topTags = [...tagCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 6)
    .map(([tag]) => tag);

  return {
    filePath: file.filePath,
    title: file.title,
    createdAt: file.createdAt,
    score: clamp(
      averageTopScore +
        Math.min(0.15, highSignalConversationCount * 0.02) +
        Math.min(0.1, topTags.length * 0.01),
      0.05,
      0.99
    ),
    conversationCount: conversations.length,
    highSignalConversationCount,
    predictedMemoryCount: conversations.reduce(
      (sum, conversation) => sum + conversation.predictedMemoryCount,
      0
    ),
    topTags,
    topConversations,
  };
}

function triageConversation(
  conversation: MigratedChatGptConversation,
  maxDurableMemoriesPerConversation: number
): MigratedChatGptConversationTriage {
  const userTurns = conversation.turns.filter((turn) => turn.role === "user");
  const assistantTurns = conversation.turns.filter((turn) => turn.role === "assistant");
  const userText = normalizeWhitespace(userTurns.map((turn) => turn.content).join(" "));
  const assistantText = normalizeWhitespace(assistantTurns.map((turn) => turn.content).join(" "));
  const durableInsights = extractDurableInsights(conversation).slice(0, maxDurableMemoriesPerConversation);
  let score = 0.15;

  if (userText.length >= 120) score += 0.08;
  if (userText.length >= 320) score += 0.1;
  if (userTurns.length > 1) score += 0.08;
  if (conversation.tags.length > 0) score += 0.05;
  if (!isGenericTitle(conversation.title)) score += 0.08;
  if (durableInsights.length > 0) score += Math.min(0.28, durableInsights.length * 0.12);
  if (containsPersistentSignal(userText)) score += 0.1;
  if (looksGenericQuestion(userText) && durableInsights.length === 0) score -= 0.2;
  if (assistantText.length > userText.length * 6 && userText.length < 220) score -= 0.1;
  if (userText.length < 60) score -= 0.08;

  const summaryPreview = buildSummaryMemoryContent(conversation);

  return {
    conversationIndex: conversation.conversationIndex,
    title: conversation.title,
    sectionTitle: conversation.sectionTitle,
    tags: conversation.tags,
    score: clamp(score, 0.05, 0.95),
    predictedMemoryCount: summaryPreview ? 1 + durableInsights.length : durableInsights.length,
    durableCount: durableInsights.length,
    userTurnCount: userTurns.length,
    assistantTurnCount: assistantTurns.length,
    userChars: userText.length,
    assistantChars: assistantText.length,
    summaryPreview,
    durableInsights,
  };
}

function buildConversationMemoryCandidates(
  conversation: MigratedChatGptConversationTriage,
  context: {
    filePath: string;
    sessionId: string | null;
    agentId: string | null;
    source: MemorySource;
    createdAt: string | null;
  },
  maxDurableMemoriesPerConversation: number
): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];
  const fileLabel = path.basename(context.filePath);
  const conversationKey = `chatgpt-migrated:${context.filePath}#conversation:${conversation.conversationIndex}`;
  const summaryContent = conversation.summaryPreview;

  if (summaryContent.length > 0) {
    candidates.push({
      sessionId: context.sessionId,
      agentId: context.agentId,
      source: context.source,
      sourceRef: `${conversationKey}:summary`,
      content: summaryContent,
      importance: clamp(0.35 + conversation.score * 0.55, 0.3, 0.95),
      createdAt: context.createdAt,
      metadata: {
        backfillSource: "chatgpt-migrated",
        kind: "conversation-summary",
        origin: "chatgpt-migrated",
        filePath: context.filePath,
        fileLabel,
        conversationTitle: conversation.title,
        sectionTitle: conversation.sectionTitle,
        conversationIndex: conversation.conversationIndex,
        triageScore: conversation.score,
        keywords: [
          ...new Set([
            ...conversation.tags,
            ...extractMemoryKeywords(`${conversation.title} ${summaryContent}`, 8),
          ]),
        ].slice(0, 10),
      },
    });
  }

  for (const [index, durableInsight] of conversation.durableInsights
    .slice(0, maxDurableMemoriesPerConversation)
    .entries()) {
    candidates.push({
      sessionId: context.sessionId,
      agentId: context.agentId,
      source: context.source,
      sourceRef: `${conversationKey}:durable:${index + 1}`,
      content: durableInsight.content,
      importance: clamp(0.4 + durableInsight.score * 0.45, 0.35, 0.95),
      createdAt: context.createdAt,
      metadata: {
        backfillSource: "chatgpt-migrated",
        kind: "durable-context",
        origin: "chatgpt-migrated",
        filePath: context.filePath,
        fileLabel,
        conversationTitle: conversation.title,
        sectionTitle: conversation.sectionTitle,
        conversationIndex: conversation.conversationIndex,
        triageScore: conversation.score,
        sourceExcerpt: durableInsight.sourceExcerpt,
        keywords: durableInsight.keywords,
      },
    });
  }

  return candidates;
}

function extractDurableInsights(
  conversation: MigratedChatGptConversation
): DurableInsightCandidate[] {
  const candidates: DurableInsightCandidate[] = [];
  const seen = new Set<string>();

  for (const turn of conversation.turns) {
    if (turn.role !== "user") continue;

    for (const sentence of splitIntoCandidateSentences(turn.content)) {
      const score = scoreDurableSentence(sentence);
      if (score < 0.45) continue;

      const normalizedFact = rewriteUserSentence(sentence);
      if (!normalizedFact) continue;

      const key = normalizeWhitespace(normalizedFact).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const content = `ChatGPT export "${conversation.title}": ${normalizedFact}`;
      candidates.push({
        content,
        score,
        sourceExcerpt: sentence,
        keywords: [
          ...new Set([...conversation.tags, ...extractMemoryKeywords(`${conversation.title} ${normalizedFact}`, 6)]),
        ].slice(0, 8),
      });
    }
  }

  return candidates.sort((left, right) => right.score - left.score || left.content.localeCompare(right.content));
}

function scoreDurableSentence(sentence: string): number {
  const text = normalizeWhitespace(sentence);
  if (text.length < 30 || text.length > 320) return 0;
  if (looksGenericQuestion(text) && !containsPersistentSignal(text)) return 0;

  let score = 0.1;
  if (/\b(i|i'm|i’ve|i've|i am|my|we|our)\b/iu.test(text)) score += 0.15;
  if (containsPersistentSignal(text)) score += 0.25;
  if (/\b(project|app|workflow|health|diet|fitness|budget|printer|career|wife|work|team)\b/iu.test(text)) {
    score += 0.12;
  }
  if (/\b\d{1,4}\b/u.test(text)) score += 0.06;
  if (!text.endsWith("?")) score += 0.08;
  if (/^can you\b|^could you\b|^would you\b|^what\b|^how\b|^why\b|^is\b|^should\b|^do\b/iu.test(text)) {
    score -= 0.16;
  }

  return clamp(score, 0, 0.95);
}

function buildSummaryMemoryContent(conversation: MigratedChatGptConversation): string {
  const firstUser = conversation.turns.find((turn) => turn.role === "user")?.content ?? "";
  const firstAssistant = conversation.turns.find((turn) => turn.role === "assistant")?.content ?? "";
  const userSummary = summarizeUserContext(firstUser);
  const assistantSummary = summarizeAssistantTakeaway(firstAssistant);
  const title = isGenericTitle(conversation.title)
    ? `conversation ${conversation.conversationIndex}`
    : `"${conversation.title}"`;

  if (!userSummary && !assistantSummary) return "";
  if (userSummary && assistantSummary) {
    return `Migrated ChatGPT conversation ${title}: ${userSummary} ${assistantSummary}`;
  }
  if (userSummary) {
    return `Migrated ChatGPT conversation ${title}: ${userSummary}`;
  }
  return `Migrated ChatGPT conversation ${title}: ${assistantSummary}`;
}

function summarizeUserContext(text: string): string {
  const durable = splitIntoCandidateSentences(text)
    .map((sentence) => rewriteUserSentence(sentence))
    .filter((sentence): sentence is string => Boolean(sentence))
    .slice(0, 2);

  if (durable.length > 0) {
    return durable.map((sentence) => ensureSentence(sentence)).join(" ");
  }

  const trimmed = truncateText(normalizeWhitespace(text), 220);
  if (trimmed.length === 0) return "";
  return ensureSentence(`User discussed ${trimmed}`);
}

function summarizeAssistantTakeaway(text: string): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length === 0) return "";

  let cleaned = normalized
    .replace(/^short answer:\s*/iu, "")
    .replace(/^here(?:’|')?s\s+/iu, "")
    .replace(/^below is\s+/iu, "")
    .replace(/^thanks for the detailed context!?/iu, "")
    .trim();

  if (cleaned.length === 0) cleaned = normalized;
  return ensureSentence(`ChatGPT covered ${truncateText(cleaned, 220)}`);
}

function rewriteUserSentence(sentence: string): string | null {
  let rewritten = normalizeWhitespace(sentence);
  if (rewritten.length === 0) return null;
  if (looksGenericQuestion(rewritten) && !containsPersistentSignal(rewritten)) return null;

  rewritten = rewritten
    .replace(/\bI currently ride\b/giu, "the user currently rides")
    .replace(/\bI currently use\b/giu, "the user currently uses")
    .replace(/\bI work\b/giu, "the user works")
    .replace(/\bI use\b/giu, "the user uses")
    .replace(/\bI have\b/giu, "the user has")
    .replace(/\bI've\b/giu, "the user has")
    .replace(/\bI am\b/giu, "the user is")
    .replace(/\bI'm\b/giu, "the user is")
    .replace(/\bI need to\b/giu, "the user needs to")
    .replace(/\bI need\b/giu, "the user needs")
    .replace(/\bI want to\b/giu, "the user wants to")
    .replace(/\bI want\b/giu, "the user wants")
    .replace(/\bI would like to\b/giu, "the user would like to")
    .replace(/\bI would like\b/giu, "the user would like")
    .replace(/\bI'd like to\b/giu, "the user would like to")
    .replace(/\bI'd like\b/giu, "the user would like")
    .replace(/\bI prefer\b/giu, "the user prefers")
    .replace(/\bI like\b/giu, "the user likes")
    .replace(/\bmy\b/giu, "the user's")
    .replace(/\bour\b/giu, "the user's")
    .replace(/\bwe\b/giu, "the user and their team");

  if (/^can you\b|^could you\b|^would you\b|^what\b|^how\b|^why\b|^is\b|^should\b|^do\b/iu.test(rewritten)) {
    return null;
  }

  rewritten = rewritten.replace(/\s+\?$/u, "").replace(/\s+\.$/u, "");
  rewritten = rewritten.replace(/^the user\b/u, "The user");

  if (rewritten.length < 20) return null;
  return ensureSentence(rewritten);
}

function containsPersistentSignal(text: string): boolean {
  return /\b(?:prefer|preference|goal|trying|need|needs|want|wants|work|works|using|use|uses|building|build|planning|plan|planned|health|fitness|diet|calories|protein|budget|workflow|project|app|wife|career|testflight|xcode|capacitor|motorcycle|printer|printing|sleep|mobility)\b/iu.test(
    text
  );
}

function looksGenericQuestion(text: string): boolean {
  const normalized = normalizeWhitespace(text).toLowerCase();
  return (
    /^(what|how|why|when|where|who|can you|could you|would you|should i|do i|is there)\b/u.test(normalized) &&
    !/\b(i|i'm|i’ve|i've|my|we|our)\b/u.test(normalized)
  );
}

function isGenericTitle(title: string): boolean {
  return GENERIC_TITLES.has(title.trim().toLowerCase());
}

function splitIntoCandidateSentences(text: string): string[] {
  return normalizeWhitespace(text)
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

async function persistCandidates(
  storage: TangoStorage,
  candidates: MemoryCandidate[],
  options: {
    dryRun?: boolean;
    embeddingProvider: EmbeddingProvider | null;
  }
): Promise<{
  candidateCount: number;
  insertedCount: number;
  skippedCount: number;
  insertedIds: number[];
  insertedSourceRefs: string[];
  skippedSourceRefs: string[];
}> {
  const unique = new Map<string, MemoryCandidate>();
  const skippedSourceRefs: string[] = [];

  for (const candidate of candidates) {
    const dedupeKey = `${candidate.source}:${candidate.sourceRef}`;
    if (unique.has(dedupeKey)) continue;
    if (storage.findMemoryBySourceRef(candidate.sourceRef, candidate.source)) {
      skippedSourceRefs.push(candidate.sourceRef);
      continue;
    }
    unique.set(dedupeKey, candidate);
  }

  const pending = [...unique.values()];
  if (options.dryRun) {
    return {
      candidateCount: candidates.length,
      insertedCount: 0,
      skippedCount: skippedSourceRefs.length,
      insertedIds: [],
      insertedSourceRefs: [],
      skippedSourceRefs,
    };
  }

  const embeddings = await embedContents(
    options.embeddingProvider,
    pending.map((candidate) => candidate.content)
  );

  const insertedIds: number[] = [];
  const insertedSourceRefs: string[] = [];

  for (const [index, candidate] of pending.entries()) {
    const embedding = embeddings[index] ?? null;
    const memoryId = storage.insertMemory({
      sessionId: candidate.sessionId ?? null,
      agentId: candidate.agentId ?? null,
      source: candidate.source,
      content: candidate.content,
      importance: candidate.importance,
      sourceRef: candidate.sourceRef,
      embeddingJson: embedding ? serializeEmbedding(embedding) : null,
      embeddingModel: embedding ? options.embeddingProvider?.model ?? null : null,
      createdAt: candidate.createdAt ?? null,
      lastAccessedAt: candidate.createdAt ?? null,
      metadata: candidate.metadata ?? null,
    });
    insertedIds.push(memoryId);
    insertedSourceRefs.push(candidate.sourceRef);
  }

  return {
    candidateCount: candidates.length,
    insertedCount: insertedIds.length,
    skippedCount: skippedSourceRefs.length,
    insertedIds,
    insertedSourceRefs,
    skippedSourceRefs,
  };
}

async function embedContents(
  embeddingProvider: EmbeddingProvider | null,
  contents: string[]
): Promise<Array<number[] | null>> {
  if (!embeddingProvider || contents.length === 0) {
    return contents.map(() => null);
  }

  const results: Array<number[] | null> = [];

  for (let index = 0; index < contents.length; index += DEFAULT_BATCH_SIZE) {
    const batch = contents.slice(index, index + DEFAULT_BATCH_SIZE);
    try {
      const embeddings = await embeddingProvider.embed(batch, "document");
      for (let offset = 0; offset < batch.length; offset += 1) {
        results.push(embeddings[offset] ?? null);
      }
    } catch {
      for (let offset = 0; offset < batch.length; offset += 1) {
        results.push(null);
      }
    }
  }

  return results;
}

function readMarkdownDocument(filePath: string): MarkdownDocument | null {
  const raw = fs.readFileSync(filePath, "utf8");
  if (raw.trim().length === 0) return null;

  const { frontmatter, body } = splitFrontmatter(raw);
  const title = path.basename(filePath, path.extname(filePath));
  const tags = normalizeTags(frontmatter?.tags).filter((tag) => !LOW_SIGNAL_TAGS.has(tag));
  const createdAt =
    readFrontmatterDate(frontmatter, ["created", "date", "last_updated", "updated"]) ??
    detectDateStringFromFileName(path.basename(filePath)) ??
    toIsoString(fs.statSync(filePath).mtime);

  return {
    filePath,
    title,
    body,
    tags,
    createdAt,
  };
}

function splitFrontmatter(raw: string): { frontmatter: Record<string, unknown> | null; body: string } {
  if (!raw.startsWith("---\n")) {
    return { frontmatter: null, body: raw };
  }

  const closingIndex = raw.indexOf("\n---\n", 4);
  if (closingIndex === -1) {
    return { frontmatter: null, body: raw };
  }

  const frontmatterText = raw.slice(4, closingIndex);
  const body = raw.slice(closingIndex + 5);
  try {
    const parsed = yaml.load(frontmatterText);
    return {
      frontmatter: parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null,
      body,
    };
  } catch {
    return { frontmatter: null, body: raw };
  }
}

function readFrontmatterDate(
  frontmatter: Record<string, unknown> | null,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = frontmatter?.[key];
    if (typeof value === "string" && Date.parse(value)) {
      return toIsoString(new Date(value));
    }
  }
  return null;
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().replace(/^#/, "").toLowerCase())
      .filter((item) => item.length > 0);
  }

  if (typeof value === "string") {
    return value
      .split(/[,\s]+/u)
      .map((item) => item.trim().replace(/^#/, "").toLowerCase())
      .filter((item) => item.length > 0);
  }

  return [];
}

function normalizeInlineTags(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/u)
    .map((item) => item.trim().replace(/^#/, "").toLowerCase())
    .filter((item) => item.length > 0 && !LOW_SIGNAL_TAGS.has(item));
}

function squashSequentialTurns(turns: MigratedChatGptTurn[]): MigratedChatGptTurn[] {
  const results: MigratedChatGptTurn[] = [];

  for (const turn of turns) {
    const content = normalizeWhitespace(turn.content);
    if (content.length === 0) continue;

    const previous = results[results.length - 1];
    if (previous && previous.role === turn.role) {
      previous.content = `${previous.content}\n\n${content}`;
      continue;
    }

    results.push({ ...turn, content });
  }

  return results;
}

function collectFiles(paths: string[], allowedExtensions: Set<string>): string[] {
  const results = new Set<string>();

  for (const inputPath of paths) {
    const resolved = path.resolve(expandHome(inputPath));
    if (!fs.existsSync(resolved)) continue;

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      walkDirectory(resolved, (entryPath) => {
        if (allowedExtensions.has(path.extname(entryPath).toLowerCase())) {
          results.add(entryPath);
        }
      });
      continue;
    }

    if (allowedExtensions.has(path.extname(resolved).toLowerCase())) {
      results.add(resolved);
    }
  }

  return [...results].sort((left, right) => left.localeCompare(right));
}

function walkDirectory(dirPath: string, visit: (filePath: string) => void): void {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const resolved = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkDirectory(resolved, visit);
    } else if (entry.isFile()) {
      visit(resolved);
    }
  }
}

function detectDateStringFromFileName(fileName: string): string | null {
  const match = fileName.match(/\b(\d{4}-\d{2}-\d{2})\b/u);
  if (!match?.[1]) return null;
  return toIsoString(new Date(`${match[1]}T12:00:00Z`));
}

function ensureSentence(text: string): string {
  const trimmed = normalizeWhitespace(text).replace(/[.?!]+$/u, "");
  if (trimmed.length === 0) return "";
  return `${trimmed[0]?.toUpperCase() ?? ""}${trimmed.slice(1)}.`;
}

function truncateText(text: string, maxChars: number): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxChars) return normalized;

  const slice = normalized.slice(0, Math.max(24, maxChars - 1));
  const lastSpace = slice.lastIndexOf(" ");
  return `${(lastSpace > 24 ? slice.slice(0, lastSpace) : slice).trim()}…`;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function expandHome(inputPath: string): string {
  if (inputPath === "~") return process.env.HOME ?? inputPath;
  if (inputPath.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", inputPath.slice(2));
  }
  return inputPath;
}

function toIsoString(value: Date): string {
  return value.toISOString();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
