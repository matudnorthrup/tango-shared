import type {
  AttachmentChunkRecord,
  AttachmentExtractionRecord,
  AttachmentFileRecord,
  AttachmentRecord,
} from "./attachments-store.js";

export const ATTACHMENT_DIRECTORY_SCHEMA = "attachment_directory_v1";
export const ATTACHMENT_DIRECTORY_SCHEMA_VERSION = 1;
export const ATTACHMENT_DIRECTORY_GENERATOR = "deterministic_attachment_directory";
export const ATTACHMENT_DIRECTORY_GENERATOR_VERSION = 1;

export type AttachmentDirectoryBuildStatus = "ready" | "partial";

export interface BuildAttachmentDirectoryInput {
  attachment: AttachmentRecord;
  file: AttachmentFileRecord | null;
  extraction: AttachmentExtractionRecord | null;
  chunks: AttachmentChunkRecord[];
  status: AttachmentDirectoryBuildStatus;
  /**
   * T-I-125 Phase 1 — optional operator-supplied context (from
   * attachment_reprocess's context_hint), threaded in when the reprocess
   * job re-runs the `directory` strategy. When present it influences both
   * `summary` and `tags` below, and is recorded verbatim in the output
   * payload (`context_hint` + `hint_guided: true`) so human-guided
   * descriptions stay permanently distinguishable from unguided machine
   * output. Absent/null: the payload carries neither field — byte-identical
   * to pre-T-I-125 output (hard bar, see spec Gate 2 PARTIAL GO).
   */
  contextHint?: string | null;
}

interface TextSpan {
  text: string;
  charStart: number;
  charEnd: number;
  lineNumber: number;
}

interface DirectoryEntry {
  text: string;
  kind?: string;
  source_ref: string;
  chunk_ref?: string | null;
  char_start?: number;
  char_end?: number;
  confidence?: number | null;
}

interface TableCandidate {
  title: string;
  row_count: number;
  column_count: number;
  rows_preview: string[][];
  source_ref: string;
  chunk_ref?: string | null;
  char_start: number;
  char_end: number;
}

const MAX_SUMMARY_LENGTH = 700;
const MAX_FACTS = 8;
const MAX_QUOTES = 6;
const MAX_TABLES = 3;
const MAX_SECTIONS = 8;
const MAX_CHUNK_PREVIEWS = 8;
const HIGH_SIGNAL_PATTERN =
  /\b(total|amount|balance|due|deadline|date|decision|status|owner|role|file|purpose|summary|important|required|must|should|risk|blocker|next|action|invoice|receipt|order)\b/iu;
const FACT_VALUE_PATTERN =
  /(?:[$€£]\s?\d|\b\d+(?:[.,]\d+)?\s?%|\b\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\b|\b\d{1,2}:\d{2}\b)/u;
const KEY_VALUE_PATTERN = /^[A-Za-z][A-Za-z0-9 _./()-]{1,60}:\s+\S/u;

export function buildAttachmentDirectory(
  input: BuildAttachmentDirectoryInput,
): Record<string, unknown> {
  const { attachment, file, extraction, chunks, status } = input;
  const contextHint = normalizeContextHintInput(input.contextHint);
  const text = extraction?.text.trim() ?? "";
  const spans = buildTextSpans(text);
  const textLength = text.length;
  const lineCount = spans.length;
  const types = buildDirectoryTypes(attachment, extraction);
  const tags = buildDirectoryTags(attachment, extraction, contextHint);
  const chunkSummaries = chunks.slice(0, MAX_CHUNK_PREVIEWS).map((chunk) =>
    buildChunkSummary(chunk, extraction),
  );
  const directoryStatus = textLength > 0 ? status : "partial";
  const source = buildSourceBlock(attachment, file, extraction, chunks);
  const keyFacts = buildKeyFacts(spans, chunks, extraction);
  const notableQuotes = buildNotableQuotes(spans, chunks, extraction, keyFacts);
  const tables = buildTableCandidates(spans, chunks, extraction);
  const sections = buildSectionEntries(spans, chunks, extraction);

  return {
    schema: ATTACHMENT_DIRECTORY_SCHEMA,
    schema_version: ATTACHMENT_DIRECTORY_SCHEMA_VERSION,
    generator: {
      name: ATTACHMENT_DIRECTORY_GENERATOR,
      version: ATTACHMENT_DIRECTORY_GENERATOR_VERSION,
      strategy: "deterministic_extraction",
    },
    attachment_id: attachment.id,
    title: attachment.title ?? attachment.originalFilename ?? `Attachment ${attachment.id}`,
    status: directoryStatus,
    summary: buildSummary(text, attachment, extraction, contextHint),
    types,
    content_type: attachment.contentType,
    bytes: attachment.bytes,
    tags,
    content_profile: {
      types,
      tags,
      original_filename: attachment.originalFilename,
      content_type: attachment.contentType,
      byte_size: attachment.bytes,
      text_length: textLength,
      line_count: lineCount,
      chunk_count: chunks.length,
      confidence: extraction?.confidence ?? null,
      extraction_method: extraction?.method ?? null,
    },
    source,
    source_refs: source.refs,
    extraction: extraction
      ? {
          extraction_id: extraction.id,
          method: extraction.method,
          confidence: extraction.confidence,
          chunk_count: chunks.length,
          quality: extraction.quality,
          warnings: getExtractionWarnings(extraction),
          source_ref: buildExtractionRef(extraction),
        }
      : null,
    sections,
    key_facts: keyFacts,
    notable_quotes: notableQuotes,
    snippets: buildSnippets(keyFacts, notableQuotes, chunkSummaries),
    tables,
    visual_notes: buildVisualNotes(attachment, extraction, spans),
    chunks: {
      count: chunks.length,
      items: chunkSummaries,
    },
    warnings: buildDirectoryWarnings(extraction, textLength, chunks.length),
    available_reads: buildAvailableReads({
      hasText: textLength > 0,
      hasChunks: chunks.length > 0,
      hasQuotes: notableQuotes.length > 0,
      hasTables: tables.length > 0,
      hasOcrLines: Boolean(extraction?.metadata?.lines),
    }),
    open_questions: [],
    // T-I-125 Phase 1 provenance (non-negotiable): only present when a
    // context_hint guided this build. Appended LAST so the no-hint payload
    // shape is byte-identical to pre-T-I-125 output — no new keys at all,
    // not even null-valued ones.
    ...(contextHint ? { context_hint: contextHint, hint_guided: true } : {}),
  };
}

function normalizeContextHintInput(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildTextSourceRef(
  extraction: AttachmentExtractionRecord | null,
  charStart: number,
  charEnd: number,
): string {
  return extraction
    ? `text:${extraction.id}:chars:${charStart}-${charEnd}`
    : `text:unknown:chars:${charStart}-${charEnd}`;
}

export function buildExtractionRef(extraction: AttachmentExtractionRecord): string {
  return `extraction:${extraction.id}`;
}

export function buildChunkRef(chunk: AttachmentChunkRecord): string {
  return `chunk:${chunk.id}`;
}

function buildSourceBlock(
  attachment: AttachmentRecord,
  file: AttachmentFileRecord | null,
  extraction: AttachmentExtractionRecord | null,
  chunks: AttachmentChunkRecord[],
) {
  const messageRef = buildMessageRef(attachment);
  const refs = [
    `attachment:${attachment.id}`,
    file ? `file:${file.id}:sha256:${file.sha256}` : null,
    extraction ? buildExtractionRef(extraction) : null,
    ...chunks.slice(0, MAX_CHUNK_PREVIEWS).map(buildChunkRef),
    messageRef,
  ].filter((value): value is string => Boolean(value));

  return {
    attachment_id: attachment.id,
    attachment_ref: `attachment:${attachment.id}`,
    file_id: attachment.fileId,
    file_ref: file ? `file:${file.id}` : null,
    file_sha256: file?.sha256 ?? null,
    local_message_id: attachment.messageId,
    discord_message_id: metadataString(attachment.metadata, "discordMessageId") ?? null,
    discord_attachment_id: attachment.discordAttachmentId,
    message_ref: messageRef,
    received_at: attachment.createdAt,
    refs,
  };
}

function buildSummary(
  text: string,
  attachment: AttachmentRecord,
  extraction: AttachmentExtractionRecord | null,
  contextHint: string | null,
): string {
  if (text.length === 0) {
    const base = "Attachment was stored, but no usable text has been extracted yet.";
    return contextHint ? truncate(`${contextHint}. ${base}`, MAX_SUMMARY_LENGTH) : base;
  }

  const firstParagraph = text
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.replace(/\s+/gu, " ").trim())
    .find((paragraph) => paragraph.length > 0);
  const linePreview = buildTextSpans(text)
    .slice(0, 4)
    .map((span) => span.text)
    .join(" / ");
  const base = firstParagraph && firstParagraph.length >= 80 ? firstParagraph : linePreview;
  const prefix = isImageLike(attachment, extraction) ? "OCR text: " : "";
  const composed = `${prefix}${base}`;
  return contextHint
    ? truncate(`${contextHint}. ${composed}`, MAX_SUMMARY_LENGTH)
    : truncate(composed, MAX_SUMMARY_LENGTH);
}

function buildDirectoryTypes(
  attachment: AttachmentRecord,
  extraction: AttachmentExtractionRecord | null,
): string[] {
  const types = new Set<string>();
  const contentType = attachment.contentType?.toLowerCase() ?? "";
  if (contentType) types.add(contentType);
  if (contentType.startsWith("image/")) types.add("image");
  if (contentType.includes("pdf")) types.add("pdf");
  if (contentType.startsWith("text/")) types.add("text");
  if (contentType.includes("wordprocessingml") || contentType.includes("rtf")) {
    types.add("document");
  }
  if (extraction?.method.includes("ocr")) types.add("ocr_text");
  if (extraction?.method === "utf8_text") types.add("embedded_text");
  return [...types];
}

function buildDirectoryTags(
  attachment: AttachmentRecord,
  extraction: AttachmentExtractionRecord | null,
  contextHint: string | null,
): string[] {
  const tags = new Set<string>();
  if (attachment.contentType) tags.add(attachment.contentType);
  if (attachment.originalFilename) {
    const extension = attachment.originalFilename.split(".").pop()?.toLowerCase();
    if (extension && extension !== attachment.originalFilename.toLowerCase()) tags.add(extension);
  }
  if (attachment.agentId) tags.add(`agent:${attachment.agentId}`);
  if (attachment.projectId) tags.add(`project:${attachment.projectId}`);
  if (extraction?.method) tags.add(extraction.method);
  if (contextHint) {
    // The FULL hint as one combined tag — this is the one that matters for
    // the acceptance test ("we're going with the Cedar Ridge Lodge" pulls
    // every item under ONE venue tag, selection at the tag level, not
    // word-fragment matching). Individual word tokens ride
    // alongside it so a shorter/partial phrase still finds the item via
    // attachment_search's ranked matching.
    tags.add(normalizeComparable(contextHint));
    for (const token of tokenizeContextHint(contextHint)) {
      tags.add(token);
    }
  }
  return [...tags];
}

// Mirrors the tokenizer in packages/discord/src/attachment-agent-tools.ts
// (tokenizeQuery) closely enough to keep hint-derived tags matchable by the
// same case-insensitive convention the enumeration read tools use, without
// importing across the core/discord package boundary.
function tokenizeContextHint(hint: string): string[] {
  return [
    ...new Set(
      hint
        .toLowerCase()
        .split(/[^a-z0-9]+/u)
        .map((part) => part.trim())
        .filter((part) => part.length >= 2),
    ),
  ];
}

function buildKeyFacts(
  spans: TextSpan[],
  chunks: AttachmentChunkRecord[],
  extraction: AttachmentExtractionRecord | null,
): DirectoryEntry[] {
  const candidates = spans
    .filter((span) => isUsefulFactLine(span.text))
    .map((span): DirectoryEntry => ({
      text: truncate(span.text, 220),
      kind: factKind(span.text),
      source_ref: buildTextSourceRef(extraction, span.charStart, span.charEnd),
      chunk_ref: findChunkRefForSpan(chunks, span),
      char_start: span.charStart,
      char_end: span.charEnd,
      confidence: extraction?.confidence ?? null,
    }));

  return dedupeDirectoryEntries(candidates).slice(0, MAX_FACTS);
}

function buildNotableQuotes(
  spans: TextSpan[],
  chunks: AttachmentChunkRecord[],
  extraction: AttachmentExtractionRecord | null,
  keyFacts: DirectoryEntry[],
): DirectoryEntry[] {
  const factTexts = new Set(keyFacts.map((entry) => normalizeComparable(entry.text)));
  const highSignal = spans.filter(
    (span) =>
      span.text.length >= 24 &&
      span.text.length <= 260 &&
      (HIGH_SIGNAL_PATTERN.test(span.text) || FACT_VALUE_PATTERN.test(span.text)),
  );
  const fallback = spans.filter((span) => span.text.length >= 32 && span.text.length <= 260);
  const selected = [...highSignal, ...fallback].filter(
    (span) => !factTexts.has(normalizeComparable(span.text)),
  );

  return dedupeDirectoryEntries(
    selected.map((span): DirectoryEntry => ({
      text: truncate(span.text, 260),
      source_ref: buildTextSourceRef(extraction, span.charStart, span.charEnd),
      chunk_ref: findChunkRefForSpan(chunks, span),
      char_start: span.charStart,
      char_end: span.charEnd,
      confidence: extraction?.confidence ?? null,
    })),
  ).slice(0, MAX_QUOTES);
}

function buildTableCandidates(
  spans: TextSpan[],
  chunks: AttachmentChunkRecord[],
  extraction: AttachmentExtractionRecord | null,
): TableCandidate[] {
  const tables: TableCandidate[] = [];
  let index = 0;
  while (index < spans.length && tables.length < MAX_TABLES) {
    const delimiter = detectTableDelimiter(spans[index]?.text ?? "");
    if (!delimiter) {
      index += 1;
      continue;
    }

    const startIndex = index;
    const rows: string[][] = [];
    while (index < spans.length) {
      const rowText = spans[index]?.text ?? "";
      if (detectTableDelimiter(rowText) !== delimiter) break;
      const row = splitTableRow(rowText, delimiter);
      if (row.length < 2) break;
      rows.push(row);
      index += 1;
    }

    if (rows.length >= 2) {
      const start = spans[startIndex];
      const end = spans[index - 1];
      if (start && end) {
        const columnCount = Math.max(...rows.map((row) => row.length));
        tables.push({
          title: `Table ${tables.length + 1}`,
          row_count: rows.length,
          column_count: columnCount,
          rows_preview: rows.slice(0, 5),
          source_ref: buildTextSourceRef(extraction, start.charStart, end.charEnd),
          chunk_ref: findChunkRefForSpan(chunks, {
            ...start,
            charEnd: end.charEnd,
          }),
          char_start: start.charStart,
          char_end: end.charEnd,
        });
      }
    } else {
      index = startIndex + 1;
    }
  }

  return tables;
}

function buildSectionEntries(
  spans: TextSpan[],
  chunks: AttachmentChunkRecord[],
  extraction: AttachmentExtractionRecord | null,
): DirectoryEntry[] {
  const headings = spans.filter((span) => isHeadingLine(span.text));
  const source = headings.length > 0 ? headings : spans.filter((span) => span.text.length >= 16);

  return source.slice(0, MAX_SECTIONS).map((span) => ({
    text: truncate(cleanHeading(span.text), 160),
    source_ref: buildTextSourceRef(extraction, span.charStart, span.charEnd),
    chunk_ref: findChunkRefForSpan(chunks, span),
    char_start: span.charStart,
    char_end: span.charEnd,
  }));
}

function buildVisualNotes(
  attachment: AttachmentRecord,
  extraction: AttachmentExtractionRecord | null,
  spans: TextSpan[],
): DirectoryEntry[] {
  if (!isImageLike(attachment, extraction)) return [];
  const notes: DirectoryEntry[] = [];
  const confidenceText =
    typeof extraction?.confidence === "number" ? ` at ${Math.round(extraction.confidence * 100)}% confidence` : "";
  if (extraction) {
    notes.push({
      text: `Image processed with ${extraction.method}; ${spans.length} text lines detected${confidenceText}.`,
      source_ref: buildExtractionRef(extraction),
      confidence: extraction.confidence,
    });
  } else {
    notes.push({
      text: "Image was stored, but OCR has not produced usable text yet.",
      source_ref: `attachment:${attachment.id}`,
      confidence: null,
    });
  }
  return notes;
}

function buildChunkSummary(
  chunk: AttachmentChunkRecord,
  extraction: AttachmentExtractionRecord | null,
) {
  const charStart = metadataNumber(chunk.metadata, "charStart");
  const charEnd = metadataNumber(chunk.metadata, "charEnd");
  return {
    chunk_id: chunk.id,
    ordinal: chunk.ordinal,
    token_estimate: chunk.tokenEstimate,
    source_ref:
      typeof charStart === "number" && typeof charEnd === "number"
        ? buildTextSourceRef(extraction, charStart, charEnd)
        : buildChunkRef(chunk),
    chunk_ref: buildChunkRef(chunk),
    char_start: charStart,
    char_end: charEnd,
    preview: truncate(chunk.text.replace(/\s+/gu, " ").trim(), 220),
  };
}

function buildDirectoryWarnings(
  extraction: AttachmentExtractionRecord | null,
  textLength: number,
  chunkCount: number,
): string[] {
  const warnings = new Set<string>(getExtractionWarnings(extraction));
  if (!extraction) warnings.add("no_extraction");
  if (textLength === 0) warnings.add("no_extracted_text");
  if (textLength > 0 && chunkCount === 0) warnings.add("no_chunks");
  return [...warnings];
}

function buildAvailableReads(input: {
  hasText: boolean;
  hasChunks: boolean;
  hasQuotes: boolean;
  hasTables: boolean;
  hasOcrLines: boolean;
}): string[] {
  const reads = new Set<string>(["summary", "directory", "source_file"]);
  if (input.hasText) reads.add("extracted_text");
  if (input.hasChunks) {
    reads.add("chunks");
    reads.add("quotes");
  } else if (input.hasQuotes) {
    reads.add("quotes");
  }
  if (input.hasTables) reads.add("tables");
  if (input.hasOcrLines) reads.add("ocr_lines");
  return [...reads];
}

function buildSnippets(
  keyFacts: DirectoryEntry[],
  notableQuotes: DirectoryEntry[],
  chunkSummaries: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const entries = dedupeDirectoryEntries([...keyFacts, ...notableQuotes]).slice(0, 6);
  if (entries.length > 0) {
    return entries.map((entry) => ({
      text: entry.text,
      source_ref: entry.chunk_ref ?? entry.source_ref,
      text_ref: entry.source_ref,
      chunk_ref: entry.chunk_ref ?? null,
      char_start: entry.char_start,
      char_end: entry.char_end,
      confidence: entry.confidence ?? null,
    }));
  }

  return chunkSummaries.slice(0, 3).map((chunk) => ({
    text: chunk.preview,
    source_ref: chunk.chunk_ref,
    text_ref: chunk.source_ref,
    chunk_ref: chunk.chunk_ref,
    char_start: chunk.char_start,
    char_end: chunk.char_end,
  }));
}

function buildTextSpans(text: string): TextSpan[] {
  const spans: TextSpan[] = [];
  const matcher = /[^\n]+/gu;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    const rawText = match[0];
    const leadingTrim = rawText.length - rawText.trimStart().length;
    const trailingTrim = rawText.length - rawText.trimEnd().length;
    const cleaned = rawText.trim();
    if (cleaned.length === 0) continue;
    const charStart = match.index + leadingTrim;
    const charEnd = match.index + rawText.length - trailingTrim;
    spans.push({
      text: cleaned,
      charStart,
      charEnd,
      lineNumber: spans.length + 1,
    });
  }
  return spans;
}

function isUsefulFactLine(text: string): boolean {
  const cleaned = text.trim();
  if (cleaned.length < 4 || cleaned.length > 220) return false;
  if (KEY_VALUE_PATTERN.test(cleaned)) return true;
  if (FACT_VALUE_PATTERN.test(cleaned) && HIGH_SIGNAL_PATTERN.test(cleaned)) return true;
  if (/^\s*(total|subtotal|tax|balance|amount due|due date|invoice|receipt|date|owner|status)\b/iu.test(cleaned)) {
    return true;
  }
  return false;
}

function factKind(text: string): string {
  if (KEY_VALUE_PATTERN.test(text)) return "key_value";
  if (/[$€£]/u.test(text)) return "amount";
  if (/\b\d+(?:[.,]\d+)?\s?%/u.test(text)) return "percentage";
  if (/\b\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\b/u.test(text)) return "date";
  return "fact";
}

function detectTableDelimiter(text: string): "," | "\t" | "|" | null {
  const cleaned = text.trim();
  if (cleaned.includes("|") && splitTableRow(cleaned, "|").length >= 2) return "|";
  if (cleaned.includes("\t") && splitTableRow(cleaned, "\t").length >= 2) return "\t";
  if (cleaned.includes(",") && splitTableRow(cleaned, ",").length >= 3) return ",";
  return null;
}

function splitTableRow(text: string, delimiter: "," | "\t" | "|"): string[] {
  const cleaned = delimiter === "|" ? text.replace(/^\|/u, "").replace(/\|$/u, "") : text;
  return cleaned
    .split(delimiter)
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0 && !/^[-: ]+$/u.test(cell));
}

function isHeadingLine(text: string): boolean {
  const cleaned = text.trim();
  if (/^#{1,6}\s+\S/u.test(cleaned)) return true;
  if (/^[A-Z][A-Z0-9 /&()-]{5,80}$/u.test(cleaned) && /[A-Z]/u.test(cleaned)) return true;
  return false;
}

function cleanHeading(text: string): string {
  return text.replace(/^#{1,6}\s+/u, "").trim();
}

function findChunkRefForSpan(chunks: AttachmentChunkRecord[], span: Pick<TextSpan, "charStart" | "charEnd">): string | null {
  const chunk = chunks.find((candidate) => {
    const charStart = metadataNumber(candidate.metadata, "charStart");
    const charEnd = metadataNumber(candidate.metadata, "charEnd");
    return (
      typeof charStart === "number" &&
      typeof charEnd === "number" &&
      span.charStart >= charStart &&
      span.charEnd <= charEnd
    );
  });
  return chunk ? buildChunkRef(chunk) : null;
}

function metadataNumber(metadata: Record<string, unknown> | null, key: string): number | null {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getExtractionWarnings(extraction: AttachmentExtractionRecord | null): string[] {
  const warnings = extraction?.metadata?.warnings;
  return Array.isArray(warnings)
    ? warnings.filter((warning): warning is string => typeof warning === "string")
    : [];
}

function isImageLike(
  attachment: AttachmentRecord,
  extraction: AttachmentExtractionRecord | null,
): boolean {
  return Boolean(
    attachment.contentType?.toLowerCase().startsWith("image/") ||
      extraction?.method.toLowerCase().includes("ocr"),
  );
}

function buildMessageRef(attachment: AttachmentRecord): string | null {
  const messageId = metadataString(attachment.metadata, "discordMessageId") ?? attachment.messageId;
  if (!attachment.channelId && !messageId) return null;
  return [
    "discord",
    attachment.channelId ?? "unknown-channel",
    attachment.threadId ?? null,
    messageId ?? null,
  ]
    .filter((value): value is string => Boolean(value))
    .join(":");
}

function metadataString(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function dedupeDirectoryEntries(entries: DirectoryEntry[]): DirectoryEntry[] {
  const seen = new Set<string>();
  const output: DirectoryEntry[] = [];
  for (const entry of entries) {
    const key = normalizeComparable(entry.text);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(entry);
  }
  return output;
}

// Exported so read tools outside this module (attachment_enumerate's
// by_label lookup, in particular) can normalize a query the same way a
// hint-derived tag was normalized when it was stored — see
// attachment-agent-tools.ts's attachmentEnumerateByLabel.
export function normalizeComparable(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}
