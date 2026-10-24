const ZONE_MARKER = /[zZ]|[+-]\d\d:?\d\d$/u;

/**
 * SQLite `datetime('now')` produces "YYYY-MM-DD HH:MM:SS" in UTC with no zone
 * marker; `new Date()` on that string parses it as LOCAL time, silently
 * shifting every stored timestamp by the host offset. Always go through this
 * helper when comparing stored timestamps against wall-clock time.
 */
export function parseStoredTimestamp(value: string | null | undefined): Date | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  const date = ZONE_MARKER.test(normalized)
    ? new Date(normalized)
    : new Date(`${normalized.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseStoredTimestampMs(value: string | null | undefined): number {
  return parseStoredTimestamp(value)?.getTime() ?? 0;
}
