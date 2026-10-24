import type { ContextUsageSnapshotRecord, LastContextUsageSnapshot } from "@tango/core";

/**
 * T-I-035: persisted-snapshot fallback for the /tango context reader and the
 * voice whisper. One Discord forum post can carry TWO parallel sessions —
 * the typed session (keys `thread:<id>` / `channel:<id>`) and the voice
 * session (keys `agent:<name>:discord:channel:<id>[:<suffix>]`) — living in
 * SEPARATE router RAM maps that restarts wipe. These helpers read the
 * durable snapshots written at the core lifecycle write point and classify
 * them per session type, so the reader can show both, with age, instead of
 * "unknown".
 */

/** Readings older than this get the "(old reading)" flag. */
export const STALE_CONTEXT_READING_MS = 30 * 60 * 1_000;

export type ContextSnapshotSource = "typed" | "voice";

export interface PersistedContextReading {
  conversationKey: string;
  fraction: number;
  usedTokens: number;
  contextWindow: number;
  recordedAt: Date;
  source: ContextSnapshotSource;
}

export interface PersistedContextReadings {
  typed?: PersistedContextReading;
  voice?: PersistedContextReading;
  /** True when the snapshot store itself failed (table missing, corrupt DB). */
  unavailable: boolean;
}

/**
 * SQLite's datetime('now') default yields "YYYY-MM-DD HH:MM:SS" (UTC, no
 * zone marker); our writers pass full ISO strings. Parse both as UTC.
 */
export function parseSnapshotTimestamp(value: string): Date {
  const trimmed = value.trim();
  const isoLike = trimmed.includes("T")
    ? trimmed
    : `${trimmed.replace(" ", "T")}Z`;
  const parsed = new Date(isoLike);
  return Number.isNaN(parsed.getTime()) ? new Date(trimmed) : parsed;
}

export function classifyContextSnapshotSource(
  conversationKey: string,
): ContextSnapshotSource | undefined {
  const key = conversationKey.trim();
  if (key.startsWith("thread:") || key.startsWith("channel:")) {
    return "typed";
  }

  // Voice conversation keys are built from the voice session key plus agent
  // (and optional thread-channel suffix): agent:<name>:discord:channel:<id>…
  if (key.startsWith("agent:") && key.includes(":discord:channel:")) {
    return "voice";
  }

  return undefined;
}

export function buildContextSnapshotQueryPatterns(input: {
  routingChannelId: string;
  threadId?: string;
}): { exactKeys: string[]; likePatterns: string[] } {
  const exactKeys = [
    input.threadId ? `thread:${input.threadId}` : `channel:${input.routingChannelId}`,
  ];
  const likePatterns = [
    // Anchored pair per id (review 2026-07-12 finding 2): end-of-key OR followed by
    // the :suffix separator — never a bare substring, so a longer snowflake that
    // merely CONTAINS this id can't false-match.
    ...(input.threadId
      ? [`%discord:channel:${input.threadId}`, `%discord:channel:${input.threadId}:%`]
      : []),
    `%discord:channel:${input.routingChannelId}`,
    `%discord:channel:${input.routingChannelId}:%`,
  ];
  return { exactKeys, likePatterns };
}

function toPersistedReading(
  row: ContextUsageSnapshotRecord,
  source: ContextSnapshotSource,
): PersistedContextReading {
  return {
    conversationKey: row.conversationKey,
    fraction: row.fraction,
    usedTokens: row.usedTokens,
    contextWindow: row.contextWindow,
    recordedAt: parseSnapshotTimestamp(row.recordedAt),
    source,
  };
}

/** Freshest reading per session type; rows must be pre-filtered to this post+agent. */
export function selectFreshestContextReadings(
  rows: ContextUsageSnapshotRecord[],
): { typed?: PersistedContextReading; voice?: PersistedContextReading } {
  let typed: PersistedContextReading | undefined;
  let voice: PersistedContextReading | undefined;

  for (const row of rows) {
    const source = classifyContextSnapshotSource(row.conversationKey);
    if (!source) {
      continue;
    }

    const reading = toPersistedReading(row, source);
    if (source === "typed") {
      if (!typed || reading.recordedAt.getTime() > typed.recordedAt.getTime()) {
        typed = reading;
      }
    } else if (!voice || reading.recordedAt.getTime() > voice.recordedAt.getTime()) {
      voice = reading;
    }
  }

  return {
    ...(typed ? { typed } : {}),
    ...(voice ? { voice } : {}),
  };
}

/**
 * Query + classify, degrading honestly: a storage failure (table missing,
 * corrupt DB) returns no readings with `unavailable: true` — never a crash,
 * never a fake number.
 */
export function resolvePersistedContextReadings(input: {
  query: (queryInput: {
    agentId: string;
    exactKeys: string[];
    likePatterns: string[];
  }) => ContextUsageSnapshotRecord[];
  agentId: string;
  routingChannelId: string;
  threadId?: string;
}): PersistedContextReadings {
  const { exactKeys, likePatterns } = buildContextSnapshotQueryPatterns({
    routingChannelId: input.routingChannelId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
  });

  try {
    const rows = input.query({ agentId: input.agentId, exactKeys, likePatterns });
    return { ...selectFreshestContextReadings(rows), unavailable: false };
  } catch (error) {
    console.warn(
      `[context] persisted snapshot query failed (agent=${input.agentId}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { unavailable: true };
  }
}

/** Convert a persisted reading to the RAM snapshot shape (whisper fallback). */
export function toLastContextUsageSnapshot(
  reading: Pick<PersistedContextReading, "fraction" | "usedTokens" | "contextWindow" | "recordedAt">,
): LastContextUsageSnapshot {
  return {
    fraction: reading.fraction,
    totalTokens: reading.usedTokens,
    contextWindow: reading.contextWindow,
    recordedAt: reading.recordedAt,
  };
}
