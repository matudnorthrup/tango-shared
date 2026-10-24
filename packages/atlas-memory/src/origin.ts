import type { MemorySource } from "./types.js";

export const MEMORY_ORIGIN_VERSION = 1;

export type MemoryOriginKind =
  | "conversation"
  | "document"
  | "reflection"
  | "manual"
  | "observation"
  | "import";

export interface MemoryOriginMetadata {
  version: typeof MEMORY_ORIGIN_VERSION;
  kind: MemoryOriginKind;
  occurred_at?: string;
  captured_at?: string;
  context_label?: string;
  context_ref?: string;
  source_ref?: string;
}

export interface MemoryOriginDefaults {
  source: MemorySource;
  occurredAt?: string | null;
  capturedAt?: string | null;
  contextLabel?: string | null;
  contextRef?: string | null;
  sourceRef?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function memoryOriginKindForSource(source: MemorySource): MemoryOriginKind {
  switch (source) {
    case "obsidian":
      return "document";
    case "conversation":
    case "reflection":
    case "manual":
    case "observation":
    case "import":
      return source;
  }
}

/**
 * Add the versioned provenance envelope without requiring a schema migration.
 * Explicit defaults are system-derived and therefore override caller-supplied
 * values inside the reserved `origin` object. Legacy top-level metadata stays
 * intact for compatibility while readers transition.
 */
export function withMemoryOrigin(
  metadata: Record<string, unknown> | null | undefined,
  defaults: MemoryOriginDefaults,
): Record<string, unknown> {
  const base = metadata ?? {};
  const existing = isRecord(base.origin) ? base.origin : {};
  const occurredAt = normalizeOptionalString(defaults.occurredAt);
  const capturedAt = normalizeOptionalString(defaults.capturedAt);
  const contextLabel = normalizeOptionalString(defaults.contextLabel);
  const contextRef = normalizeOptionalString(defaults.contextRef);
  const sourceRef = normalizeOptionalString(defaults.sourceRef);

  const origin: MemoryOriginMetadata = {
    ...existing,
    version: MEMORY_ORIGIN_VERSION,
    kind: memoryOriginKindForSource(defaults.source),
    ...(occurredAt ? { occurred_at: occurredAt } : {}),
    ...(capturedAt ? { captured_at: capturedAt } : {}),
    ...(contextLabel ? { context_label: contextLabel } : {}),
    ...(contextRef ? { context_ref: contextRef } : {}),
    ...(sourceRef ? { source_ref: sourceRef } : {}),
  };

  return {
    ...base,
    origin,
  };
}

export function readMemoryOrigin(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  return isRecord(metadata?.origin) ? metadata.origin : null;
}

export function readMemoryOriginString(
  metadata: Record<string, unknown> | null | undefined,
  key: keyof MemoryOriginMetadata,
): string | null {
  const value = readMemoryOrigin(metadata)?.[key];
  return normalizeOptionalString(value) ?? null;
}
