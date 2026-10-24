import { estimateTextTokens, normalizeExtractedText } from "./attachment-text-extractor.js";
import type {
  AttachmentExtractionRecord,
  AttachmentFileRecord,
  AttachmentJobRecord,
  AttachmentRecord,
} from "./attachments-store.js";

export const LLM_VISION_FALLBACK_METHOD = "llm_vision_fallback";
export const LLM_VISION_FALLBACK_PROMPT_VERSION = 1;

export interface AttachmentLlmFallbackRunnerInput {
  attachment: AttachmentRecord;
  file: AttachmentFileRecord;
  filePath: string;
  job: AttachmentJobRecord;
  previousExtraction: AttachmentExtractionRecord | null;
  reason: string;
}

export interface AttachmentLlmFallbackFact {
  text: string;
  source_ref?: string | null;
}

export interface AttachmentLlmFallbackStructuredOutput {
  summary: string;
  extracted_text: string;
  key_facts: AttachmentLlmFallbackFact[];
  visual_notes: string[];
  confidence: number | null;
  warnings: string[];
}

export interface AttachmentLlmFallbackQuality {
  empty: boolean;
  structured: boolean;
  summaryLength: number;
  extractedTextLength: number;
  keyFactCount: number;
  visualNoteCount: number;
  warningCount: number;
  confidence: number | null;
  tokenEstimate: number;
}

export interface AttachmentLlmFallbackResult {
  method: typeof LLM_VISION_FALLBACK_METHOD;
  text: string;
  confidence: number | null;
  quality: AttachmentLlmFallbackQuality;
  structuredOutput: AttachmentLlmFallbackStructuredOutput;
  warnings: string[];
  metadata?: Record<string, unknown> | null;
}

export type AttachmentLlmFallbackRunner = (
  input: AttachmentLlmFallbackRunnerInput,
) => Promise<AttachmentLlmFallbackResult>;

export interface BuildAttachmentLlmFallbackResultOptions {
  metadata?: Record<string, unknown> | null;
}

const MAX_PROMPT_PREVIOUS_TEXT_CHARS = 1_500;
const MAX_FIELD_CHARS = 4_000;
const MAX_FACTS = 12;
const MAX_VISUAL_NOTES = 12;
const MAX_WARNINGS = 12;

export function buildAttachmentLlmFallbackPrompt(
  input: AttachmentLlmFallbackRunnerInput,
): string {
  const previous = input.previousExtraction;
  const previousText = previous?.text.trim()
    ? previous.text.trim().slice(0, MAX_PROMPT_PREVIOUS_TEXT_CHARS)
    : "";
  const previousBlock = previous
    ? [
        `method: ${previous.method}`,
        `confidence: ${previous.confidence ?? "unknown"}`,
        `quality: ${JSON.stringify(previous.quality ?? {})}`,
        `metadata: ${JSON.stringify(compactRecord({
          escalation: previous.metadata?.escalation,
          escalationRecommended: previous.metadata?.escalationRecommended,
          warnings: previous.metadata?.warnings,
          available: previous.metadata?.available,
        }))}`,
        previousText ? `text_excerpt:\n${previousText}` : "text_excerpt: (empty)",
      ].join("\n")
    : "(none)";

  return [
    "You are a fresh-context Tango attachment vision fallback sub-agent.",
    "",
    "Analyze the local source file and return compact structured information for Atlas.",
    "Do not include the local file path in your output. Do not return markdown fences.",
    "If the file cannot be inspected, return valid JSON with an empty extracted_text and warnings explaining why.",
    "",
    "Source file to inspect:",
    input.filePath,
    "",
    "Attachment metadata:",
    JSON.stringify({
      attachment_id: input.attachment.id,
      title: input.attachment.title,
      original_filename: input.attachment.originalFilename,
      content_type: input.attachment.contentType ?? input.file.contentType,
      bytes: input.attachment.bytes ?? input.file.bytes,
      sha256: input.file.sha256,
      reason: input.reason,
      source_ref: `attachment:${input.attachment.id}`,
      message_ref: buildMessageRef(input.attachment),
    }, null, 2),
    "",
    "Previous deterministic extraction:",
    previousBlock,
    "",
    "Return exactly one JSON object with this shape:",
    JSON.stringify({
      summary: "One compact sentence describing what the attachment contains.",
      extracted_text: "Any reliable text visible in the image/document, or empty string.",
      key_facts: [
        {
          text: "Short fact useful to agents.",
          source_ref: `attachment:${input.attachment.id}`,
        },
      ],
      visual_notes: [
        "Short note about layout, object, screenshot state, diagram, table, handwriting, or uncertainty.",
      ],
      confidence: 0.75,
      warnings: ["Optional uncertainty or limitation."],
    }, null, 2),
  ].join("\n");
}

export function buildAttachmentLlmFallbackResultFromProviderOutput(
  providerOutput: string,
  options: BuildAttachmentLlmFallbackResultOptions = {},
): AttachmentLlmFallbackResult {
  const parsed = parseAttachmentLlmFallbackOutput(providerOutput);
  const text = formatAttachmentLlmFallbackText(parsed.output);
  const warnings = parsed.structured
    ? parsed.output.warnings
    : uniqueStrings(["structured_json_parse_failed", ...parsed.output.warnings]);
  const confidence = parsed.output.confidence;
  const normalizedText = normalizeExtractedText(text);
  const quality: AttachmentLlmFallbackQuality = {
    empty: normalizedText.length === 0,
    structured: parsed.structured,
    summaryLength: parsed.output.summary.length,
    extractedTextLength: parsed.output.extracted_text.length,
    keyFactCount: parsed.output.key_facts.length,
    visualNoteCount: parsed.output.visual_notes.length,
    warningCount: warnings.length,
    confidence,
    tokenEstimate: estimateTextTokens(normalizedText),
  };

  return {
    method: LLM_VISION_FALLBACK_METHOD,
    text: normalizedText,
    confidence,
    quality,
    structuredOutput: {
      ...parsed.output,
      warnings,
    },
    warnings,
    metadata: options.metadata ?? null,
  };
}

export function formatAttachmentLlmFallbackText(
  output: AttachmentLlmFallbackStructuredOutput,
): string {
  const parts: string[] = [];
  if (output.summary.trim().length > 0) {
    parts.push(`Summary: ${output.summary.trim()}`);
  }
  if (output.extracted_text.trim().length > 0) {
    parts.push(["Extracted text:", output.extracted_text.trim()].join("\n"));
  }
  if (output.key_facts.length > 0) {
    parts.push([
      "Key facts:",
      ...output.key_facts.map((fact) => {
        const source = fact.source_ref ? ` (${fact.source_ref})` : "";
        return `- ${fact.text}${source}`;
      }),
    ].join("\n"));
  }
  if (output.visual_notes.length > 0) {
    parts.push([
      "Visual notes:",
      ...output.visual_notes.map((note) => `- ${note}`),
    ].join("\n"));
  }
  return normalizeExtractedText(parts.join("\n\n"));
}

function parseAttachmentLlmFallbackOutput(providerOutput: string): {
  structured: boolean;
  output: AttachmentLlmFallbackStructuredOutput;
} {
  const jsonText = extractJsonObject(providerOutput);
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText) as unknown;
      return {
        structured: true,
        output: normalizeStructuredOutput(parsed),
      };
    } catch {
      // Fall through to compact text fallback below.
    }
  }

  const fallbackSummary = truncate(normalizeExtractedText(providerOutput), 700);
  return {
    structured: false,
    output: normalizeStructuredOutput({
      summary: fallbackSummary || "LLM fallback returned no structured attachment summary.",
      extracted_text: "",
      key_facts: [],
      visual_notes: [],
      confidence: null,
      warnings: ["structured_json_parse_failed"],
    }),
  };
}

function normalizeStructuredOutput(value: unknown): AttachmentLlmFallbackStructuredOutput {
  const record = asRecord(value) ?? {};
  const facts = Array.isArray(record.key_facts)
    ? record.key_facts.slice(0, MAX_FACTS).map(normalizeFact).filter((fact) => fact.text.length > 0)
    : [];
  const visualNotes = normalizeStringList(record.visual_notes, MAX_VISUAL_NOTES);
  const warnings = normalizeStringList(record.warnings, MAX_WARNINGS);
  const confidence = normalizeConfidence(record.confidence);

  return {
    summary: truncate(normalizeString(record.summary), 700),
    extracted_text: truncate(normalizeExtractedText(normalizeString(record.extracted_text)), MAX_FIELD_CHARS),
    key_facts: facts,
    visual_notes: visualNotes,
    confidence,
    warnings,
  };
}

function normalizeFact(value: unknown): AttachmentLlmFallbackFact {
  if (typeof value === "string") {
    return { text: truncate(value.trim(), 500) };
  }
  const record = asRecord(value) ?? {};
  return {
    text: truncate(normalizeString(record.text), 500),
    source_ref: normalizeNullableString(record.source_ref),
  };
}

function extractJsonObject(value: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(value);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return value.slice(start, end + 1).trim();
}

function buildMessageRef(attachment: AttachmentRecord): string | null {
  const discordMessageId = metadataString(attachment.metadata, "discordMessageId");
  if (attachment.channelId && discordMessageId) {
    return `discord:${attachment.channelId}:${discordMessageId}`;
  }
  if (attachment.channelId && attachment.messageId) {
    return `local:${attachment.channelId}:${attachment.messageId}`;
  }
  return null;
}

function metadataString(
  metadata: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNullableString(value: unknown): string | null {
  const normalized = normalizeString(value);
  return normalized.length > 0 ? normalized : null;
}

function normalizeStringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.map(normalizeString).filter(Boolean)).slice(0, limit);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeConfidence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(Math.max(0, Math.min(1, value)) * 10_000) / 10_000;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}
