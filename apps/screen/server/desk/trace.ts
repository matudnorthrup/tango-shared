import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

// The desk's session trace: one timeline of what every part of a live voice session
// decided and showed — the operator (what was said, routing, view decisions, speech),
// the desk core (attention, next steps, commands), the presentation hub (view
// transitions and refusals, scenes, taps), each browser screen (what it rendered),
// and the owner's own marks ("this was wrong"). Read at /trace, GET /api/desk/trace,
// or the desk-trace CLI. Diagnostic only: recording never throws into the caller.

export const TRACE_SOURCES = ['operator', 'desk', 'hub', 'screen', 'owner'] as const;
export type TraceSource = (typeof TRACE_SOURCES)[number];

export interface TraceInput {
  source: TraceSource;
  kind: string;
  /** One human line. */
  summary: string;
  data?: Record<string, unknown>;
  sessionId?: string | null;
  /** When it happened (epoch ms); defaults to now. */
  at?: number;
}

export interface TraceEntry {
  seq: number;
  at: number;
  source: TraceSource;
  kind: string;
  summary: string;
  data: Record<string, unknown>;
  sessionId: string | null;
}

export interface TraceQuery {
  since?: number;
  until?: number;
  /** Newest `limit` entries in the window, returned oldest first. Default 500, max 5000. */
  limit?: number;
  kinds?: string[];
  sources?: TraceSource[];
  /** Entries after this seq (live tails). */
  afterSeq?: number;
}

/** What hub and core call: never throws. */
export type Tracer = (entry: TraceInput) => void;

/** Three days: long enough to look at yesterday's session, short enough to stay small. */
export const TRACE_KEEP_MS = 3 * 86_400_000;
const MAX_SUMMARY = 300;
const MAX_KIND = 64;
const MAX_DATA_CHARS = 8000;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function serialize(data: Record<string, unknown> | undefined): string {
  if (!data) return '{}';
  try {
    const text = JSON.stringify(data);
    if (text.length <= MAX_DATA_CHARS) return text;
    return JSON.stringify({ truncated: true, preview: text.slice(0, MAX_DATA_CHARS) });
  } catch {
    return '{"unserializable":true}';
  }
}

export function isTraceSource(value: unknown): value is TraceSource {
  return typeof value === 'string' && (TRACE_SOURCES as readonly string[]).includes(value);
}

/** `15m`, `2h`, `3d`, `90s`, a clock time (`14:05`), epoch ms, or an ISO time → epoch ms (relative to `now`). Null if unreadable. */
export function parseTraceTime(value: string | null | undefined, now = Date.now()): number | null {
  if (value === null || value === undefined) return null;
  const text = value.trim();
  if (!text) return null;
  const relative = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i.exec(text);
  if (relative) {
    const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2]!.toLowerCase() as 's' | 'm' | 'h' | 'd'];
    return now - Number(relative[1]) * unit;
  }
  if (/^\d{10,}$/.test(text)) return Number(text);
  // A clock time ("14:05", "14:05:30"): today, local time; yesterday if that is still ahead.
  const time = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (time) {
    const date = new Date(now);
    date.setHours(Number(time[1]), Number(time[2]), Number(time[3] ?? 0), 0);
    if (date.getTime() > now) date.setDate(date.getDate() - 1);
    return date.getTime();
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export class DeskTrace {
  private readonly listeners = new Set<(entry: TraceEntry) => void>();
  private readonly limited = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
    private readonly log: (event: string, data?: Record<string, unknown>) => void = () => {},
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS desk_trace (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        session_id TEXT
      );
      CREATE INDEX IF NOT EXISTS desk_trace_at ON desk_trace(at);
    `);
  }

  /** Records one entry; null (and nothing thrown) if it could not be stored. */
  record(input: TraceInput): TraceEntry | null {
    try {
      if (!isTraceSource(input.source)) return null;
      const at = typeof input.at === 'number' && Number.isFinite(input.at) ? input.at : this.now();
      const kind = clip(String(input.kind || 'note'), MAX_KIND);
      const summary = clip(String(input.summary ?? ''), MAX_SUMMARY) || kind;
      const data = serialize(input.data);
      const sessionId = typeof input.sessionId === 'string' && input.sessionId.trim() ? input.sessionId.trim().slice(0, 80) : null;
      const result = this.db
        .prepare('INSERT INTO desk_trace (at, source, kind, summary, data, session_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(at, input.source, kind, summary, data, sessionId);
      const entry: TraceEntry = { seq: Number(result.lastInsertRowid), at, source: input.source, kind, summary, data: JSON.parse(data) as Record<string, unknown>, sessionId };
      for (const listener of this.listeners) {
        try {
          listener(entry);
        } catch {
          /* a broken listener never stops recording */
        }
      }
      return entry;
    } catch (err) {
      this.log('trace.error', { message: (err as Error).message });
      return null;
    }
  }

  /** At most one entry per `key` every `everyMs` (poll errors, noisy failures). */
  recordLimited(key: string, everyMs: number, input: TraceInput): TraceEntry | null {
    const now = this.now();
    const last = this.limited.get(key) ?? -Infinity;
    if (now - last < everyMs) return null;
    this.limited.set(key, now);
    return this.record(input);
  }

  /** The tracer hub and core hold: records and swallows everything. */
  get tracer(): Tracer {
    return (entry) => void this.record(entry);
  }

  query(query: TraceQuery = {}): TraceEntry[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (query.since !== undefined) {
      where.push('at >= ?');
      params.push(query.since);
    }
    if (query.until !== undefined) {
      where.push('at <= ?');
      params.push(query.until);
    }
    if (query.afterSeq !== undefined) {
      where.push('seq > ?');
      params.push(query.afterSeq);
    }
    if (query.kinds?.length) {
      // A kind ending in "." matches its family ("presentation." → presentation.applied, presentation.ignored).
      where.push(`(${query.kinds.map(() => '(kind = ? OR kind LIKE ?)').join(' OR ')})`);
      for (const kind of query.kinds) params.push(kind, kind.endsWith('.') ? `${kind}%` : `${kind}.%`);
    }
    if (query.sources?.length) {
      where.push(`source IN (${query.sources.map(() => '?').join(', ')})`);
      params.push(...query.sources);
    }
    const limit = Math.max(1, Math.min(5000, Math.floor(query.limit ?? 500)));
    const rows = this.db
      .prepare(`SELECT * FROM desk_trace ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, seq DESC LIMIT ${limit}`)
      .all(...params) as Array<Record<string, string | number | null>>;
    return rows.reverse().map((row) => ({
      seq: row.seq as number,
      at: row.at as number,
      source: row.source as TraceSource,
      kind: row.kind as string,
      summary: row.summary as string,
      data: (() => {
        try {
          return JSON.parse((row.data as string) || '{}') as Record<string, unknown>;
        } catch {
          return {};
        }
      })(),
      sessionId: (row.session_id as string | null) ?? null,
    }));
  }

  /** Drops entries older than `keepMs`; returns how many. */
  prune(keepMs = TRACE_KEEP_MS): number {
    try {
      const result = this.db.prepare('DELETE FROM desk_trace WHERE at < ?').run(this.now() - keepMs);
      return Number(result.changes);
    } catch (err) {
      this.log('trace.prune.error', { message: (err as Error).message });
      return 0;
    }
  }

  subscribe(listener: (entry: TraceEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Hourly prune (unref'd). */
  start(): void {
    if (this.timer) return;
    this.prune();
    this.timer = setInterval(() => this.prune(), 3_600_000);
    this.timer.unref?.();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
