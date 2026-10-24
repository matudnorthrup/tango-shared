// What each model call cost a thread (docs/specs/loom-context-management.md): the context it carried and today's
// total, for the Desk's context readout and, later, the per-thread budget. One row per main-chain model call.
import type { LoomStore } from "./store.js";

export const USAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS usage (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, run_id TEXT, at INTEGER NOT NULL,
  context INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, output INTEGER NOT NULL, model TEXT
);
CREATE INDEX IF NOT EXISTS usage_thread ON usage(thread_id, at);
`;

/** Rows older than this are dropped: the readout needs today, the budget a day, trends a few weeks. */
export const USAGE_RETENTION_MS = 30 * 86_400_000;

export interface UsageSample {
  /** Everything the call sent: uncached input, cache reads and cache writes. */
  context: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  model?: string;
}

export interface ContextSummary {
  /** The last call's context, and when. */
  tokens: number;
  at: number;
  /** Input tokens sent since local midnight, cache reads included. */
  today: number;
  /** The local midnight `today` counts from: a reader on a later day shows nothing for today (the thread was idle). */
  day: number;
  callsToday: number;
}

/** Local midnight before `now`: the budget's day, as the owner lives it. */
export function dayStart(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

export class UsageLedger {
  private inserts = 0;
  constructor(private readonly store: LoomStore) {
    store.db.exec(USAGE_SCHEMA);
    const columns = store.db.prepare("PRAGMA table_info(usage)").all() as { name: string }[];
    for (const name of ["fan_out_id", "parent_thread_id"]) if (!columns.some(c => c.name === name)) store.db.exec(`ALTER TABLE usage ADD COLUMN ${name} TEXT`);
    // On every start as well as every thousand calls, so a coordinator that restarts often still prunes.
    this.prune();
  }

  /** Old history goes; each thread's newest sample stays, so a long-idle thread still says how large its session is. */
  prune(): void {
    this.store.db.prepare("DELETE FROM usage WHERE at < ? AND rowid NOT IN (SELECT MAX(rowid) FROM usage GROUP BY thread_id)").run(this.store.now() - USAGE_RETENTION_MS);
  }

  record(threadId: string, runId: string | null, sample: UsageSample): void {
    const now = this.store.now();
    this.store.db.prepare("INSERT INTO usage (thread_id,run_id,at,context,cache_read,cache_write,output,model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(threadId, runId, now, sample.context, sample.cacheRead, sample.cacheWrite, sample.output, sample.model ?? null);
    if (this.store.thread(threadId)?.kind === "probe") {
      this.store.db.prepare(`UPDATE usage SET fan_out_id=(SELECT fan_out_id FROM fan_out_probes WHERE thread_id=?),
        parent_thread_id=(SELECT parent_thread_id FROM threads WHERE id=?) WHERE rowid=last_insert_rowid()`).run(threadId, threadId);
    }
    if (++this.inserts % 1000 === 0) this.prune();
  }

  summary(threadId: string): ContextSummary | null {
    const last = this.store.db.prepare("SELECT context, at FROM usage WHERE thread_id = ? ORDER BY at DESC, rowid DESC LIMIT 1").get(threadId) as { context: number; at: number } | undefined;
    if (!last) return null;
    const start = dayStart(this.store.now());
    const day = this.store.db.prepare("SELECT COALESCE(SUM(context), 0) AS today, COUNT(*) AS calls FROM usage WHERE thread_id = ? AND at >= ?").get(threadId, start) as { today: number; calls: number };
    return { tokens: last.context, at: last.at, today: Number(day.today), callsToday: Number(day.calls), day: start };
  }
}
