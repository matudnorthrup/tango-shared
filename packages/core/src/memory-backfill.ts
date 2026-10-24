import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { EmbeddingProvider } from "./embeddings.js";
import { serializeEmbedding } from "./embeddings.js";
import {
  buildDeterministicConversationMemory,
  buildDeterministicConversationSummary,
  estimateConversationImportance,
  extractMemoryKeywords,
  resolveSessionMemoryConfig,
} from "./memory-system.js";
import type { SessionConfig, MemorySource } from "./types.js";
import type { StoredMessageRecord } from "./storage.js";
import { TangoStorage } from "./storage.js";

const DEFAULT_MESSAGE_WINDOW = 6;
const DEFAULT_MARKDOWN_CHARS = 1200;
const DEFAULT_BATCH_SIZE = 32;

export interface MemoryBackfillCandidate {
  sessionId?: string | null;
  agentId?: string | null;
  source: MemorySource;
  sourceRef: string;
  content: string;
  importance: number;
  createdAt?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface MemoryBackfillResult {
  candidateCount: number;
  insertedCount: number;
  skippedCount: number;
  insertedIds: number[];
  insertedSourceRefs: string[];
  skippedSourceRefs: string[];
  /** Inserted memories that received an embedding. */
  embeddedCount: number;
  /** Inserted memories left without an embedding after retries (0 when no provider is configured). */
  embedFailedCount: number;
  /** Unique embedding error messages (capped) for surfacing in job summaries. */
  embedErrors: string[];
}

export interface MessageBackfillOptions {
  storage: TangoStorage;
  sessionConfigs?: SessionConfig[];
  sessionId?: string;
  agentId?: string | null;
  windowSize?: number;
  dryRun?: boolean;
  embeddingProvider?: EmbeddingProvider | null;
  /** Archive existing conversation/backfill memories and re-extract with current logic */
  refresh?: boolean;
}

export interface MarkdownBackfillOptions {
  storage: TangoStorage;
  paths: string[];
  memorySource?: MemorySource;
  sessionId?: string | null;
  agentId?: string | null;
  chunkChars?: number;
  dryRun?: boolean;
  embeddingProvider?: EmbeddingProvider | null;
}

export interface ImportBackfillOptions extends MarkdownBackfillOptions {}

interface MessageGroup {
  sessionId: string;
  agentId: string | null;
  messageCount: number;
}

interface MarkdownDocument {
  filePath: string;
  title: string;
  body: string;
  tags: string[];
  createdAt: string | null;
}

interface MarkdownChunk {
  heading: string | null;
  content: string;
}

export async function backfillMessages(
  input: MessageBackfillOptions
): Promise<MemoryBackfillResult> {
  if (input.refresh && !input.dryRun) {
    archiveExistingConversationMemories(input.storage, input.sessionId, input.agentId);
  }

  const sessionConfigById = new Map((input.sessionConfigs ?? []).map((session) => [session.id, session]));
  const groups = listMessageGroups(input.storage, input.sessionId, input.agentId);
  const candidates: MemoryBackfillCandidate[] = [];

  for (const group of groups) {
    const messages = listMessagesForGroup(input.storage, group.sessionId, group.agentId);
    if (messages.length === 0) continue;

    const sessionConfig = sessionConfigById.get(group.sessionId);
    const resolvedWindowSize = input.windowSize
      ? Math.max(2, Math.floor(input.windowSize))
      : resolveSessionMemoryConfig(sessionConfig?.memory).summarizeWindow ?? DEFAULT_MESSAGE_WINDOW;

    for (const windowMessages of sliceIntoWindows(messages, resolvedWindowSize)) {
      const exchange = windowMessages.filter(
        (message) => message.direction === "inbound" || message.direction === "outbound"
      );
      if (exchange.length === 0) continue;

      const memoryText = buildDeterministicConversationMemory(exchange);
      if (memoryText.trim().length === 0) continue;

      const firstId = exchange[0]?.id;
      const lastId = exchange[exchange.length - 1]?.id;
      const createdAt = exchange[exchange.length - 1]?.createdAt ?? exchange[0]?.createdAt ?? null;
      const sourceRef = `messages:${group.sessionId}:${group.agentId ?? "none"}:${firstId ?? "?"}-${lastId ?? "?"}`;
      const summaryText = buildDeterministicConversationSummary(exchange);

      candidates.push({
        sessionId: group.sessionId,
        agentId: group.agentId,
        source: "backfill",
        sourceRef,
        content: memoryText,
        importance: estimateConversationImportance(exchange),
        createdAt,
        metadata: {
          backfillSource: "messages",
          keywords: extractMemoryKeywords(memoryText),
          summaryText,
          firstMessageId: firstId ?? null,
          lastMessageId: lastId ?? null,
          messageIds: exchange.map((message) => message.id),
          messageCount: exchange.length,
        },
      });
    }
  }

  return await persistBackfillCandidates(input.storage, candidates, {
    dryRun: input.dryRun,
    embeddingProvider: input.embeddingProvider,
  });
}

export async function backfillMarkdownFiles(
  input: MarkdownBackfillOptions
): Promise<MemoryBackfillResult> {
  const memorySource = input.memorySource ?? "obsidian";
  const candidates: MemoryBackfillCandidate[] = [];

  for (const filePath of collectFiles(input.paths, new Set([".md", ".markdown"]))) {
    const document = readMarkdownDocument(filePath);
    if (!document) continue;

    const chunks = chunkMarkdownDocument(document, input.chunkChars ?? DEFAULT_MARKDOWN_CHARS);
    for (const [index, chunk] of chunks.entries()) {
      const content = renderMarkdownChunkContent(document.title, chunk);
      if (content.trim().length < 40) continue;

      const sourceRef = `${memorySource}:${filePath}#${index + 1}`;
      candidates.push({
        sessionId: input.sessionId ?? null,
        agentId: input.agentId ?? null,
        source: memorySource,
        sourceRef,
        content,
        importance: estimateMarkdownImportance(document, chunk),
        createdAt: document.createdAt,
        metadata: {
          backfillSource: "markdown",
          filePath,
          title: document.title,
          heading: chunk.heading,
          tags: document.tags,
          keywords: [
            ...new Set([...document.tags, ...extractMemoryKeywords(content)]),
          ].slice(0, 10),
        },
      });
    }
  }

  return await persistBackfillCandidates(input.storage, candidates, {
    dryRun: input.dryRun,
    embeddingProvider: input.embeddingProvider,
  });
}

export async function backfillImportPaths(
  input: ImportBackfillOptions
): Promise<MemoryBackfillResult> {
  const memorySource = input.memorySource ?? "backfill";
  const candidates: MemoryBackfillCandidate[] = [];
  const files = collectFiles(input.paths, new Set([".md", ".markdown", ".txt", ".json", ".jsonl", ".csv"]));

  for (const filePath of files) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".md" || ext === ".markdown") {
      const document = readMarkdownDocument(filePath);
      if (!document) continue;
      const chunks = chunkMarkdownDocument(document, input.chunkChars ?? DEFAULT_MARKDOWN_CHARS);
      for (const [index, chunk] of chunks.entries()) {
        const content = renderMarkdownChunkContent(document.title, chunk);
        if (content.trim().length < 40) continue;
        candidates.push({
          sessionId: input.sessionId ?? null,
          agentId: input.agentId ?? null,
          source: memorySource,
          sourceRef: `import:${filePath}#${index + 1}`,
          content,
          importance: estimateMarkdownImportance(document, chunk),
          createdAt: document.createdAt,
          metadata: {
            backfillSource: "import",
            filePath,
            title: document.title,
            heading: chunk.heading,
            tags: document.tags,
            keywords: [
              ...new Set([...document.tags, ...extractMemoryKeywords(content)]),
            ].slice(0, 10),
          },
        });
      }
      continue;
    }

    const raw = fs.readFileSync(filePath, "utf8");
    const title = detectTitleFromRaw(raw, filePath);
    const createdAt = detectDateStringFromFileName(path.basename(filePath)) ?? toIsoString(fs.statSync(filePath).mtime);
    const chunks = chunkPlainText(raw, input.chunkChars ?? DEFAULT_MARKDOWN_CHARS);
    for (const [index, chunk] of chunks.entries()) {
      const content = `${title}: ${chunk}`;
      if (content.trim().length < 40) continue;
      candidates.push({
        sessionId: input.sessionId ?? null,
        agentId: input.agentId ?? null,
        source: memorySource,
        sourceRef: `import:${filePath}#${index + 1}`,
        content,
        importance: estimatePlainTextImportance(title, chunk),
        createdAt,
        metadata: {
          backfillSource: "import",
          filePath,
          title,
          keywords: extractMemoryKeywords(content),
        },
      });
    }
  }

  return await persistBackfillCandidates(input.storage, candidates, {
    dryRun: input.dryRun,
    embeddingProvider: input.embeddingProvider,
  });
}

async function persistBackfillCandidates(
  storage: TangoStorage,
  candidates: MemoryBackfillCandidate[],
  options: {
    dryRun?: boolean;
    embeddingProvider?: EmbeddingProvider | null;
  }
): Promise<MemoryBackfillResult> {
  const unique = new Map<string, MemoryBackfillCandidate>();
  const skippedSourceRefs: string[] = [];

  for (const candidate of candidates) {
    if (candidate.content.trim().length === 0) continue;

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
      embeddedCount: 0,
      embedFailedCount: 0,
      embedErrors: [],
    };
  }

  const { embeddings, embedErrors } = await embedContents(
    options.embeddingProvider ?? null,
    pending.map((candidate) => candidate.content)
  );

  const insertedIds: number[] = [];
  const insertedSourceRefs: string[] = [];
  let embeddedCount = 0;

  for (const [index, candidate] of pending.entries()) {
    const embedding = embeddings[index] ?? null;
    if (embedding) embeddedCount += 1;
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

  const embedFailedCount = options.embeddingProvider ? insertedIds.length - embeddedCount : 0;
  if (embedFailedCount > 0) {
    console.warn(
      `[tango-memory] backfill embeddings incomplete: ${embedFailedCount}/${insertedIds.length} memories stored without embeddings (${embedErrors.join("; ") || "unknown error"})`
    );
  }

  return {
    candidateCount: candidates.length,
    insertedCount: insertedIds.length,
    skippedCount: skippedSourceRefs.length,
    insertedIds,
    insertedSourceRefs,
    skippedSourceRefs,
    embeddedCount,
    embedFailedCount,
    embedErrors,
  };
}

const EMBED_BATCH_MAX_ATTEMPTS = 3;
const EMBED_RETRY_BASE_DELAY_MS = 1_000;
const EMBED_ERROR_SAMPLE_LIMIT = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function embedContents(
  embeddingProvider: EmbeddingProvider | null,
  contents: string[]
): Promise<{ embeddings: Array<number[] | null>; embedErrors: string[] }> {
  if (!embeddingProvider || contents.length === 0) {
    return { embeddings: contents.map(() => null), embedErrors: [] };
  }

  const embeddings: Array<number[] | null> = [];
  const embedErrors = new Set<string>();

  for (let index = 0; index < contents.length; index += DEFAULT_BATCH_SIZE) {
    const batch = contents.slice(index, index + DEFAULT_BATCH_SIZE);
    let batchEmbeddings: Array<number[] | null> | null = null;

    for (let attempt = 1; attempt <= EMBED_BATCH_MAX_ATTEMPTS; attempt += 1) {
      try {
        const result = await embeddingProvider.embed(batch, "document");
        batchEmbeddings = batch.map((_, offset) => result[offset] ?? null);
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (embedErrors.size < EMBED_ERROR_SAMPLE_LIMIT) {
          embedErrors.add(message);
        }
        if (attempt < EMBED_BATCH_MAX_ATTEMPTS) {
          // Burst batches trip provider rate limits; back off before retrying.
          await sleep(EMBED_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        }
      }
    }

    if (batchEmbeddings) {
      embeddings.push(...batchEmbeddings);
    } else {
      for (let offset = 0; offset < batch.length; offset += 1) {
        embeddings.push(null);
      }
    }
  }

  return { embeddings, embedErrors: [...embedErrors] };
}

export interface MissingEmbeddingBackfillResult {
  scannedCount: number;
  embeddedCount: number;
  failedCount: number;
  embedErrors: string[];
}

/**
 * Re-embed stored memories whose embedding is missing (e.g. after provider
 * outages or historical silent batch failures). Processes up to `limit` rows.
 */
export async function backfillMissingMemoryEmbeddings(input: {
  storage: TangoStorage;
  embeddingProvider?: EmbeddingProvider | null;
  source?: string;
  limit?: number;
}): Promise<MissingEmbeddingBackfillResult> {
  const provider = input.embeddingProvider ?? null;
  if (!provider) {
    return { scannedCount: 0, embeddedCount: 0, failedCount: 0, embedErrors: [] };
  }

  const rows = input.storage.listMemoriesMissingEmbedding({
    source: input.source ?? null,
    limit: input.limit ?? 6_000,
  });
  if (rows.length === 0) {
    return { scannedCount: 0, embeddedCount: 0, failedCount: 0, embedErrors: [] };
  }

  const { embeddings, embedErrors } = await embedContents(
    provider,
    rows.map((row) => row.content)
  );

  let embeddedCount = 0;
  for (const [index, row] of rows.entries()) {
    const embedding = embeddings[index] ?? null;
    if (!embedding) continue;
    const updated = input.storage.updateMemoryEmbedding({
      memoryId: row.id,
      embeddingJson: serializeEmbedding(embedding),
      embeddingModel: provider.model ?? null,
    });
    if (updated) embeddedCount += 1;
  }

  return {
    scannedCount: rows.length,
    embeddedCount,
    failedCount: rows.length - embeddedCount,
    embedErrors,
  };
}

function listMessageGroups(
  storage: TangoStorage,
  sessionId?: string,
  agentId?: string | null
): MessageGroup[] {
  const clauses: string[] = [];
  const values: Array<string | null> = [];

  if (sessionId) {
    clauses.push("session_id = ?");
    values.push(sessionId);
  }

  if (agentId !== undefined) {
    if (agentId === null) {
      clauses.push("agent_id IS NULL");
    } else {
      clauses.push("agent_id = ?");
      values.push(agentId);
    }
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return storage.getDatabase().prepare(
    `
      SELECT
        session_id AS sessionId,
        agent_id AS agentId,
        COUNT(*) AS messageCount
      FROM messages
      ${where}
      GROUP BY session_id, agent_id
      ORDER BY session_id ASC, agent_id ASC
    `
  ).all(...values) as unknown as MessageGroup[];
}

function listMessagesForGroup(
  storage: TangoStorage,
  sessionId: string,
  agentId: string | null
): StoredMessageRecord[] {
  const rows = (agentId === null
    ? storage.getDatabase().prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            direction,
            source,
            visibility,
            discord_message_id AS discordMessageId,
            discord_channel_id AS discordChannelId,
            discord_user_id AS discordUserId,
            discord_username AS discordUsername,
            content,
            metadata_json AS metadataJson,
            created_at AS createdAt
          FROM messages
          WHERE session_id = ? AND agent_id IS NULL
          ORDER BY id ASC
        `
      ).all(sessionId)
    : storage.getDatabase().prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            direction,
            source,
            visibility,
            discord_message_id AS discordMessageId,
            discord_channel_id AS discordChannelId,
            discord_user_id AS discordUserId,
            discord_username AS discordUsername,
            content,
            metadata_json AS metadataJson,
            created_at AS createdAt
          FROM messages
          WHERE session_id = ? AND agent_id = ?
          ORDER BY id ASC
        `
      ).all(sessionId, agentId)) as Array<
    Omit<StoredMessageRecord, "metadata"> & { metadataJson: string | null }
  >;

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.sessionId,
    agentId: row.agentId,
    providerName: row.providerName,
    direction: row.direction,
    source: row.source,
    visibility: row.visibility,
    discordMessageId: row.discordMessageId,
    discordChannelId: row.discordChannelId,
    discordUserId: row.discordUserId,
    discordUsername: row.discordUsername,
    content: row.content,
    metadata: safeJsonParse(row.metadataJson),
    createdAt: row.createdAt,
  }));
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

  return [...results].sort((a, b) => a.localeCompare(b));
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

function readMarkdownDocument(filePath: string): MarkdownDocument | null {
  const raw = fs.readFileSync(filePath, "utf8");
  if (raw.trim().length === 0) return null;

  const { frontmatter, body } = splitFrontmatter(raw);
  const title = readTitle(frontmatter, body, filePath);
  const tags = normalizeTags(frontmatter?.tags);
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

function chunkMarkdownDocument(document: MarkdownDocument, maxChars: number): MarkdownChunk[] {
  const chunks: MarkdownChunk[] = [];
  let currentHeading: string | null = null;
  let current = "";

  const flush = () => {
    const normalized = normalizeWhitespace(current);
    if (normalized.length === 0) return;
    chunks.push({ heading: currentHeading, content: normalized });
    current = "";
  };

  for (const rawLine of document.body.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const headingMatch = line.match(/^#{1,6}\s+(.*)$/u);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[1]?.trim() || null;
      continue;
    }

    const next = current.length > 0 ? `${current}\n${line}` : line;
    if (normalizeWhitespace(next).length > maxChars && current.trim().length > 0) {
      flush();
      current = line;
      continue;
    }

    current = next;
  }

  flush();

  if (chunks.length === 0) {
    const fallback = chunkPlainText(document.body, maxChars).map((content) => ({
      heading: null,
      content,
    }));
    return fallback;
  }

  return chunks;
}

function renderMarkdownChunkContent(title: string, chunk: MarkdownChunk): string {
  const heading = chunk.heading ? ` / ${chunk.heading}` : "";
  return `${title}${heading}: ${chunk.content}`;
}

function chunkPlainText(raw: string, maxChars: number): string[] {
  const paragraphs = raw
    .split(/\n{2,}/u)
    .map((paragraph) => normalizeWhitespace(paragraph))
    .filter((paragraph) => paragraph.length > 0);

  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs.length > 0 ? paragraphs : [normalizeWhitespace(raw)]) {
    if (!paragraph) continue;
    const next = current.length > 0 ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length > maxChars && current.length > 0) {
      chunks.push(current);
      current = paragraph;
      continue;
    }
    current = next;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

function readTitle(
  frontmatter: Record<string, unknown> | null,
  body: string,
  filePath: string
): string {
  const fmTitle = typeof frontmatter?.title === "string" ? frontmatter.title.trim() : "";
  if (fmTitle) return fmTitle;

  const headingMatch = body.match(/^#\s+(.+)$/mu);
  if (headingMatch?.[1]) return headingMatch[1].trim();

  return path.basename(filePath, path.extname(filePath));
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

function estimateMarkdownImportance(document: MarkdownDocument, chunk: MarkdownChunk): number {
  const text = `${document.title} ${chunk.heading ?? ""} ${chunk.content}`.toLowerCase();
  const normalizedPath = document.filePath.replace(/\\/gu, "/").toLowerCase();
  let score = 0.45;

  if (document.tags.length > 0) score += 0.05;
  if (/\b(current state|key context|decision|status|goal|next|progress|recommendation)\b/u.test(text)) {
    score += 0.2;
  }
  if (/\b(active|in-progress|planning|critical|urgent)\b/u.test(text)) {
    score += 0.1;
  }
  if (chunk.heading && /\b(log|history|current state|project|progress)\b/u.test(chunk.heading.toLowerCase())) {
    score += 0.1;
  }
  if (chunk.content.length > 500) score += 0.05;

  const checkboxCount = (chunk.content.match(/\[[ x]\]/gu) ?? []).length;
  const isDailyPlanningChunk =
    normalizedPath.includes("/planning/daily/") &&
    (document.title.toLowerCase() === "in progress" ||
      (chunk.heading?.toLowerCase() ?? "") === "in progress" ||
      (chunk.heading?.toLowerCase() ?? "") === "primary tasks" ||
      (chunk.heading?.toLowerCase() ?? "") === "stretch tasks" ||
      (chunk.heading?.toLowerCase() ?? "") === "other work" ||
      (chunk.heading?.toLowerCase() ?? "") === "unscheduled work i did today");
  if (isDailyPlanningChunk) {
    score -= 0.3;
  }
  if (checkboxCount >= 3 && /\blast active\b/u.test(chunk.content.toLowerCase())) {
    score -= 0.25;
  }

  return clamp(score, 0.25, 0.95);
}

function estimatePlainTextImportance(title: string, chunk: string): number {
  const text = `${title} ${chunk}`.toLowerCase();
  let score = 0.4;
  if (/\b(transcript|voice|captured|interrupted|notes|feedback)\b/u.test(text)) score += 0.15;
  if (/\b(decide|decision|plan|goal|next|need to)\b/u.test(text)) score += 0.15;
  if (chunk.length > 400) score += 0.05;
  return clamp(score, 0.2, 0.85);
}

function detectDateStringFromFileName(fileName: string): string | null {
  const match = fileName.match(/\b(\d{4}-\d{2}-\d{2})\b/u);
  if (!match?.[1]) return null;
  return toIsoString(new Date(`${match[1]}T12:00:00Z`));
}

function detectTitleFromRaw(raw: string, filePath: string): string {
  const firstLine = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ? firstLine.replace(/^#+\s*/u, "").slice(0, 120) : path.basename(filePath);
}

function sliceIntoWindows<T>(items: T[], size: number): T[][] {
  const windows: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    windows.push(items.slice(index, index + size));
  }
  return windows;
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

function safeJsonParse(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function archiveExistingConversationMemories(
  storage: TangoStorage,
  sessionId?: string,
  agentId?: string | null
): void {
  const sources: MemorySource[] = ["conversation", "backfill"];
  for (const source of sources) {
    const memories = storage.listMemories({
      sessionId,
      agentId: agentId ?? undefined,
      source,
      limit: 10_000,
    });
    for (const memory of memories) {
      if (memory.archivedAt !== null) continue;
      storage.archiveMemory(memory.id);
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
