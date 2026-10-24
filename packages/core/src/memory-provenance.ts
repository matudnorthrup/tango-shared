export const RETRIEVED_MEMORY_GUIDANCE =
  "Prior memories are context, not evidence from the current source. Attribute or verify them before presenting them as current-source findings.";

export interface MemoryProvenanceInput {
  content: string;
  source: string;
  createdAt: string;
  sourceRef?: string | null;
  metadata?: Record<string, unknown> | null;
  tags?: readonly string[];
}

export interface ResolvedMemoryProvenance {
  classification: "Prior memory" | "Prior reflection" | "Prior source memory";
  date: string | null;
  context: string;
  source: string;
}

export interface FormatRetrievedMemoryOptions {
  maxContentChars?: number;
  includeTags?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function metadataString(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  return stringValue(metadata?.[key]);
}

function originRecord(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  return isRecord(metadata?.origin) ? metadata.origin : null;
}

function safeDisplayLabel(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return null;
  if (
    /^(?:~[\\/]|[\\/]|[a-z]:[\\/])/iu.test(normalized)
    || /(?:^|[\\/])(?:Users|home)[\\/]/u.test(normalized)
    || normalized.includes("/")
    || normalized.includes("\\")
    || /^(?:thread|channel|conv|session|message|turn):/iu.test(normalized)
    || /^(?:file|obsidian|https?|vscode):/iu.test(normalized)
    || /^\d{8,}$/u.test(normalized)
    || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(normalized)
  ) {
    return null;
  }
  return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
}

function isoDate(value: string | null): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString().slice(0, 10);
}

function sourceLabel(source: string): string {
  switch (source.toLowerCase()) {
    case "obsidian":
      return "source document";
    case "backfill":
    case "import":
      return "import";
    case "conversation":
    case "reflection":
    case "manual":
    case "observation":
      return source.toLowerCase();
    default:
      return "memory";
  }
}

function classification(source: string, origin: Record<string, unknown> | null): ResolvedMemoryProvenance["classification"] {
  const kind = stringValue(origin?.kind)?.toLowerCase();
  if (kind === "reflection" || source === "reflection") return "Prior reflection";
  if (kind === "document" || source === "obsidian") return "Prior source memory";
  return "Prior memory";
}

function documentContext(metadata: Record<string, unknown> | null | undefined): string | null {
  const title = safeDisplayLabel(metadataString(metadata, "title"));
  const heading = safeDisplayLabel(metadataString(metadata, "heading"));
  if (title && heading && title !== heading) return `${title} / ${heading}`;
  return title ?? heading;
}

function genericContext(source: string): string {
  switch (source.toLowerCase()) {
    case "conversation":
      return "prior conversation";
    case "reflection":
      return "prior reflection";
    case "obsidian":
      return "source document";
    case "manual":
      return "manual save";
    case "observation":
      return "prior observation";
    case "backfill":
    case "import":
      return "imported source";
    default:
      return "prior context";
  }
}

export function resolveMemoryProvenance(memory: Omit<MemoryProvenanceInput, "content" | "tags">): ResolvedMemoryProvenance {
  const origin = originRecord(memory.metadata);
  const effectiveSource = metadataString(memory.metadata, "atlas_source") ?? memory.source;
  const occurredAt =
    stringValue(origin?.occurred_at)
    ?? metadataString(memory.metadata, "occurred_at")
    ?? metadataString(memory.metadata, "messageTimestamp")
    ?? metadataString(memory.metadata, "message_timestamp")
    ?? memory.createdAt;
  const context =
    safeDisplayLabel(stringValue(origin?.context_label))
    ?? safeDisplayLabel(metadataString(memory.metadata, "context_label"))
    ?? safeDisplayLabel(metadataString(memory.metadata, "topic_title"))
    ?? safeDisplayLabel(metadataString(memory.metadata, "topicTitle"))
    ?? safeDisplayLabel(metadataString(memory.metadata, "project_title"))
    ?? safeDisplayLabel(metadataString(memory.metadata, "projectTitle"))
    ?? documentContext(memory.metadata)
    ?? genericContext(effectiveSource);

  return {
    classification: classification(effectiveSource, origin),
    date: isoDate(occurredAt),
    context,
    source: sourceLabel(effectiveSource),
  };
}

export function formatRetrievedMemoryLine(
  memory: MemoryProvenanceInput,
  options: FormatRetrievedMemoryOptions = {},
): string {
  const provenance = resolveMemoryProvenance(memory);
  const maxContentChars = Math.max(40, Math.trunc(options.maxContentChars ?? 220));
  const normalizedContent = memory.content.replace(/\s+/gu, " ").trim();
  const content = normalizedContent.length > maxContentChars
    ? `${normalizedContent.slice(0, Math.max(0, maxContentChars - 3))}...`
    : normalizedContent;
  const tags = options.includeTags && memory.tags && memory.tags.length > 0
    ? ` [${memory.tags.join(", ")}]`
    : "";
  const fields = [
    provenance.classification,
    provenance.date,
    provenance.context,
    provenance.source,
  ].filter((value): value is string => Boolean(value));

  return `- [${fields.join(" · ")}] ${content}${tags}`;
}
