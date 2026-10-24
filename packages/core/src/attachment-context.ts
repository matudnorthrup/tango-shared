import type {
  AttachmentDirectoryContextRecord,
  AttachmentStore,
} from "./attachments-store.js";
import type { StoredMessageRecord } from "./storage.js";

export interface AttachmentDirectoryContextTraceEntry {
  attachmentId: number;
  directoryId: number;
  title: string;
  reasons: string[];
  sourceRefs: string[];
  score: number;
}

export interface AttachmentDirectoryContextTrace {
  selected: AttachmentDirectoryContextTraceEntry[];
  suppressed: AttachmentDirectoryContextTraceEntry[];
  omittedCount: number;
  recentRefCount: number;
  queryTerms: string[];
  maxEntries: number;
  maxChars: number;
}

export interface AttachmentDirectoryContextResult {
  prompt: string;
  trace: AttachmentDirectoryContextTrace;
}

export interface BuildAttachmentDirectoryContextInput {
  store: AttachmentStore;
  conversationKey?: string;
  discordChannelId?: string | null;
  agentId?: string | null;
  currentUserPrompt?: string | null;
  recentMessages?: readonly Pick<StoredMessageRecord, "content" | "metadata" | "discordMessageId">[];
  maxEntries?: number;
  maxChars?: number;
}

interface DirectoryPayload {
  title?: unknown;
  status?: unknown;
  summary?: unknown;
  types?: unknown;
  tags?: unknown;
  source?: unknown;
  source_refs?: unknown;
  extraction?: unknown;
  snippets?: unknown;
  key_facts?: unknown;
  notable_quotes?: unknown;
  tables?: unknown;
  visual_notes?: unknown;
  available_reads?: unknown;
  chunks?: unknown;
  warnings?: unknown;
}

interface ContextScopes {
  threadId?: string;
  channelId?: string;
}

interface Candidate {
  record: AttachmentDirectoryContextRecord;
  directory: DirectoryPayload | null;
  reasons: string[];
  sourceRefs: string[];
  score: number;
}

const DEFAULT_MAX_ENTRIES = 4;
const MAX_ENTRIES = 8;
const DEFAULT_MAX_CHARS = 2_400;
const MAX_CHARS = 4_000;
const SUMMARY_CHARS = 280;
const SNIPPET_CHARS = 160;

export function buildAttachmentDirectoryContext(
  input: BuildAttachmentDirectoryContextInput,
): AttachmentDirectoryContextResult {
  const maxEntries = clamp(input.maxEntries, DEFAULT_MAX_ENTRIES, MAX_ENTRIES);
  const maxChars = clamp(input.maxChars, DEFAULT_MAX_CHARS, MAX_CHARS);
  const queryTerms = tokenize(input.currentUserPrompt ?? "");
  const explicitAttachmentRequest = looksLikeAttachmentRequest(input.currentUserPrompt ?? "");
  const scopes = resolveScopes(input.conversationKey, input.discordChannelId);
  const candidates = collectCandidates(input.store, {
    scopes,
    agentId: normalizeString(input.agentId),
    queryTerms,
    includeRecentFallback: explicitAttachmentRequest,
    limit: Math.max(maxEntries * 6, 24),
  });
  const recentRefs = collectRecentRefs(input.recentMessages ?? []);
  const selected: Candidate[] = [];
  const suppressed: Candidate[] = [];

  for (const candidate of candidates) {
    const alreadyReferenced = candidate.sourceRefs.some((ref) => recentRefs.has(ref.toLowerCase()));
    if (alreadyReferenced && !explicitAttachmentRequest) {
      suppressed.push(candidate);
      continue;
    }
    selected.push(candidate);
    if (selected.length >= maxEntries) break;
  }

  const rendered = renderAttachmentDirectoryPrompt(selected, {
    candidateOmittedCount: Math.max(0, candidates.length - selected.length - suppressed.length),
    maxChars,
  });

  return {
    prompt: rendered.prompt,
    trace: {
      selected: rendered.candidates.map(toTraceEntry),
      suppressed: suppressed.map(toTraceEntry),
      omittedCount: rendered.omittedCount,
      recentRefCount: recentRefs.size,
      queryTerms,
      maxEntries,
      maxChars,
    },
  };
}

function collectCandidates(
  store: AttachmentStore,
  input: {
    scopes: ContextScopes;
    agentId?: string;
    queryTerms: string[];
    includeRecentFallback: boolean;
    limit: number;
  },
): Candidate[] {
  const byId = new Map<number, Candidate>();
  const addRecords = (records: AttachmentDirectoryContextRecord[], reason: string, baseScore: number) => {
    for (const record of records) {
      const current = byId.get(record.attachment.id);
      const directory = asDirectoryPayload(record.directory.directory);
      const sourceRefs = collectSourceRefs(record, directory);
      const queryScore = scoreQuery(record, directory, input.queryTerms);
      const score = baseScore + queryScore + (record.attachment.status === "ready" ? 5 : 0);
      const reasons = [reason];
      if (queryScore > 0) reasons.push("query_match");

      if (!current || score > current.score) {
        byId.set(record.attachment.id, {
          record,
          directory,
          sourceRefs,
          score,
          reasons,
        });
      } else if (!current.reasons.includes(reason)) {
        current.reasons.push(reason);
        current.score += Math.max(1, Math.floor(baseScore / 10));
      }
    }
  };

  if (input.scopes.threadId) {
    addRecords(
      store.listDirectoriesForContext({
        threadId: input.scopes.threadId,
        limit: input.limit,
        directoryStatus: ["ready", "failed"],
      }),
      "thread_scope",
      80,
    );
  }

  if (input.scopes.channelId) {
    addRecords(
      store.listDirectoriesForContext({
        channelId: input.scopes.channelId,
        limit: input.limit,
        directoryStatus: ["ready", "failed"],
      }),
      "channel_scope",
      60,
    );
  }

  if (input.agentId) {
    addRecords(
      store.listDirectoriesForContext({
        agentId: input.agentId,
        limit: input.limit,
        directoryStatus: ["ready", "failed"],
      }),
      "agent_scope",
      35,
    );
  }

  if (input.includeRecentFallback) {
    addRecords(
      store.listDirectoriesForContext({
        limit: input.limit,
        directoryStatus: ["ready", "failed"],
      }),
      "explicit_request_recent",
      20,
    );
  }

  return [...byId.values()]
    .filter((candidate) => input.queryTerms.length === 0 || candidate.score > 20)
    .sort((left, right) => right.score - left.score || right.record.attachment.id - left.record.attachment.id);
}

function renderAttachmentDirectoryPrompt(
  candidates: Candidate[],
  options: { candidateOmittedCount: number; maxChars: number },
): { prompt: string; candidates: Candidate[]; omittedCount: number } {
  if (candidates.length === 0) {
    return {
      prompt: "",
      candidates: [],
      omittedCount: options.candidateOmittedCount,
    };
  }

  const lines = [
    "Relevant attachment directories:",
    "These are compact directory records, not full extracted text. Use attachment_search/attachment_read for exact quotes, chunks, tables, or larger text.",
  ];
  const renderedCandidates: Candidate[] = [];

  for (const candidate of candidates) {
    const rendered = renderCandidate(candidate);
    const next = [...lines, ...rendered];
    const nextText = next.join("\n");
    if (nextText.length > options.maxChars) break;
    lines.push(...rendered);
    renderedCandidates.push(candidate);
  }

  const omittedCount = options.candidateOmittedCount + candidates.length - renderedCandidates.length;
  if (renderedCandidates.length === 0) {
    return {
      prompt: "",
      candidates: [],
      omittedCount,
    };
  }

  if (omittedCount > 0) {
    lines.push(`- ${omittedCount} additional attachment directory records omitted by context budget.`);
  }

  return {
    prompt: lines.join("\n"),
    candidates: renderedCandidates,
    omittedCount,
  };
}

function renderCandidate(candidate: Candidate): string[] {
  const { attachment } = candidate.record;
  const directory = candidate.directory;
  const source = asRecord(directory?.source);
  const title = titleForCandidate(candidate);
  const reads = asStringArray(directory?.available_reads).slice(0, 8);
  const summary = truncate(stringValue(directory?.summary) ?? "", SUMMARY_CHARS);
  const sourceRef = stringValue(source?.message_ref)
    ?? candidate.sourceRefs.find((ref) => ref.startsWith("discord:"))
    ?? `attachment:${attachment.id}`;
  const snippets = asArray(directory?.snippets)
    .map((snippet) => {
      const record = asRecord(snippet);
      const text = truncate(stringValue(record?.text) ?? "", SNIPPET_CHARS);
      const ref = stringValue(record?.text_ref) ?? stringValue(record?.source_ref);
      return text ? `${JSON.stringify(text)}${ref ? ` (${ref})` : ""}` : "";
    })
    .filter((value) => value.length > 0)
    .slice(0, 2);

  const lines = [
    `- attachment:${attachment.id} ${JSON.stringify(title)} status=${attachment.status} type=${attachment.contentType ?? "unknown"}`,
  ];
  if (summary) lines.push(`  summary: ${summary}`);
  if (snippets.length > 0) lines.push(`  snippets: ${snippets.join("; ")}`);
  lines.push(`  source_ref: ${sourceRef}`);
  if (reads.length > 0) lines.push(`  available_reads: ${reads.join(", ")}`);
  lines.push(`  prompt_trace: selected_by=${candidate.reasons.join("+")} refs=${candidate.sourceRefs.slice(0, 5).join(", ")}`);
  return lines;
}

function toTraceEntry(candidate: Candidate): AttachmentDirectoryContextTraceEntry {
  return {
    attachmentId: candidate.record.attachment.id,
    directoryId: candidate.record.directory.id,
    title: titleForCandidate(candidate),
    reasons: candidate.reasons,
    sourceRefs: candidate.sourceRefs,
    score: candidate.score,
  };
}

function collectSourceRefs(
  record: AttachmentDirectoryContextRecord,
  directory: DirectoryPayload | null,
): string[] {
  const refs = new Set<string>([`attachment:${record.attachment.id}`]);
  const source = asRecord(directory?.source);
  for (const value of [
    source?.attachment_ref,
    source?.file_ref,
    source?.message_ref,
    source?.discord_message_id,
    record.attachment.discordAttachmentId,
    record.attachment.messageId,
  ]) {
    if (typeof value === "string" && value.trim().length > 0) refs.add(value.trim());
  }
  for (const value of asStringArray(source?.refs)) refs.add(value);
  for (const value of asStringArray(directory?.source_refs)) refs.add(value);
  return [...refs];
}

function collectRecentRefs(
  messages: readonly Pick<StoredMessageRecord, "content" | "metadata" | "discordMessageId">[],
): Set<string> {
  const refs = new Set<string>();
  for (const message of messages) {
    const text = [
      message.content,
      message.discordMessageId,
      JSON.stringify(message.metadata ?? {}),
    ].join("\n").toLowerCase();
    const matches = text.match(/\b(?:attachment|chunk|extraction|text):[a-z0-9:_-]+|\bdiscord:[a-z0-9:_-]+/giu) ?? [];
    for (const match of matches) refs.add(match.toLowerCase());
  }
  return refs;
}

function scoreQuery(
  record: AttachmentDirectoryContextRecord,
  directory: DirectoryPayload | null,
  queryTerms: string[],
): number {
  if (queryTerms.length === 0) return 0;
  const haystack = [
    record.attachment.title,
    record.attachment.originalFilename,
    record.attachment.contentType,
    directory?.title,
    directory?.summary,
    JSON.stringify(directory?.types ?? []),
    JSON.stringify(directory?.tags ?? []),
    JSON.stringify(directory?.snippets ?? []),
    JSON.stringify(directory?.key_facts ?? []),
    JSON.stringify(directory?.visual_notes ?? []),
  ].join("\n").toLowerCase();

  return queryTerms.reduce((score, term) => score + (haystack.includes(term) ? 8 : 0), 0);
}

function resolveScopes(
  conversationKey: string | undefined,
  discordChannelId: string | null | undefined,
): ContextScopes {
  const scopes: ContextScopes = {};
  const normalizedConversation = normalizeString(conversationKey);
  if (normalizedConversation?.startsWith("thread:")) {
    scopes.threadId = normalizedConversation.slice("thread:".length);
  } else if (normalizedConversation?.startsWith("channel:")) {
    scopes.channelId = normalizedConversation.slice("channel:".length);
  }
  const channel = normalizeString(discordChannelId);
  if (channel && !scopes.channelId) {
    scopes.channelId = channel;
  }
  return scopes;
}

function titleForCandidate(candidate: Candidate): string {
  return stringValue(candidate.record.attachment.title)
    ?? stringValue(candidate.directory?.title)
    ?? candidate.record.attachment.originalFilename
    ?? `Attachment ${candidate.record.attachment.id}`;
}

function looksLikeAttachmentRequest(value: string | null | undefined): boolean {
  return /\b(attachment|attachments|image|images|document|documents|screenshot|screenshots|file|files|uploaded|upload|ocr|pdf|receipt|quote|table)\b/iu.test(value ?? "");
}

function tokenize(value: string): string[] {
  return [...new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9$%.:-]+/u)
      .map((part) => part.trim())
      .filter((part) => part.length >= 3 && !STOP_WORDS.has(part)),
  )].slice(0, 10);
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "please",
  "about",
  "what",
  "when",
  "where",
  "from",
]);

function asDirectoryPayload(value: unknown): DirectoryPayload | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as DirectoryPayload
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function truncate(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, Math.max(0, maxChars - 3)).trim()}...` : normalized;
}

function clamp(value: unknown, defaultValue: number, maxValue: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.trunc(value), maxValue)
    : defaultValue;
}
