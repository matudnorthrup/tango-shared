// The owner's active time on Tango, and the level 3 veto clock that runs on it (docs/specs/decisions-and-delegation.md
// "Active time"; D-1: 4 hours of active time, paused while the owner is idle).
import type { LoomStore } from "./store.js";
import { loadBoard, type DecisionBrief, type DecisionRow } from "./decisions.js";

export const PRESENCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS presence (id INTEGER PRIMARY KEY, start INTEGER NOT NULL, last INTEGER NOT NULL, source TEXT);
CREATE INDEX IF NOT EXISTS presence_last ON presence(last);
`;
const MINUTE = 60_000;
const KEEP_MS = 30 * 24 * 60 * MINUTE;

/** "4h active", "90m", "10m": a duration in ms, else the fallback. */
export function durationMs(value: unknown, fallback: number): number {
  const m = typeof value === "string" ? /^(\d+(?:\.\d+)?)\s*(h|m|s)\b/.exec(value.trim()) : null;
  if (!m) return fallback;
  return Number(m[1]) * (m[2] === "h" ? 60 * MINUTE : m[2] === "m" ? MINUTE : 1000);
}

/**
 * Active intervals: a beat within `idleMs` of the last one extends the current interval; a later beat starts a new
 * one. Time between the last beat and now isn't counted until the next beat proves the owner was still there.
 */
export class Presence {
  constructor(private readonly store: LoomStore, private readonly idleMs: () => number) {}

  beat(at: number, source: string | null = null): void {
    const db = this.store.db;
    const last = db.prepare("SELECT id, last FROM presence ORDER BY last DESC LIMIT 1").get() as { id: number; last: number } | undefined;
    if (last && at <= last.last) return;
    if (last && at - last.last <= this.idleMs()) db.prepare("UPDATE presence SET last = ? WHERE id = ?").run(at, last.id);
    else db.prepare("INSERT INTO presence (start, last, source) VALUES (?, ?, ?)").run(at, at, source);
    // Keep history for open veto windows and kept discussions, including across long idle gaps.
    const oldest = (db.prepare("SELECT MIN(created_at) AS at FROM decisions WHERE status = 'open' AND ((level = 3 AND discussing_since IS NULL) OR kept_at IS NOT NULL)").get() as { at: number | null }).at;
    db.prepare("DELETE FROM presence WHERE last < ?").run(Math.min(at - KEEP_MS, oldest ?? Infinity));
  }

  /** Active ms between `since` and `until`. */
  activeSince(since: number, until: number): number {
    const rows = this.store.db.prepare("SELECT start, last FROM presence WHERE last > ? AND start < ?").all(since, until) as { start: number; last: number }[];
    return rows.reduce((sum, r) => sum + Math.max(0, Math.min(r.last, until) - Math.max(r.start, since)), 0);
  }

  /** The newest beat, or null. */
  lastBeat(): number | null {
    const row = this.store.db.prepare("SELECT MAX(last) AS last FROM presence").get() as { last: number | null };
    return row.last;
  }
}

export interface VetoState { window_ms: number; active_ms: number; left_ms: number }

/**
 * Runs level 3 defaults: a brief the owner hasn't answered after the veto window of their active time goes ahead
 * with its default, and the thread wakes to carry it out. Every 15 minutes of active time it tells clients, so the
 * desk's "time left" stays roughly current without a change on every beat.
 */
export class VetoClock {
  private timer: ReturnType<typeof setInterval>;
  private buckets = new Map<string, number>();
  private stopped = false;

  constructor(
    private readonly store: LoomStore,
    readonly presence: Presence,
    private readonly onDefault: (row: DecisionRow, option: string) => void,
    private readonly onProgress: (row: DecisionRow) => void,
    intervalMs = 30_000,
    private readonly onError: (row: DecisionRow, error: string) => void = () => {},
    private readonly beforeTick: () => void = () => {},
  ) {
    this.timer = setInterval(() => { try { this.tick(); } catch (e) { console.warn("Veto clock tick failed", e); } }, intervalMs);
    this.timer.unref?.();
  }

  windowMs(): number {
    try { return durationMs(loadBoard().defaults.veto_window, 4 * 60 * MINUTE); } catch { return 4 * 60 * MINUTE; }
  }

  state(row: Pick<DecisionRow, "level" | "created_at"> & Partial<Pick<DecisionRow, "window_from">>, now = this.store.now()): VetoState | null {
    if (row.level !== 3) return null;
    const window = this.windowMs();
    // A material revision (decision.update) starts the window over; a copy edit doesn't (TGO-1079).
    const active = this.presence.activeSince(row.window_from ?? row.created_at, now);
    return { window_ms: window, active_ms: active, left_ms: Math.max(0, window - active) };
  }

  tick(): void {
    if (this.stopped) return;
    this.beforeTick();
    const now = this.store.now();
    const rows = this.store.db.prepare("SELECT * FROM decisions WHERE status = 'open' AND level = 3 AND discussing_since IS NULL").all() as unknown as DecisionRow[];
    for (const row of rows) {
      try {
        const state = this.state(row, now)!;
        const option = (JSON.parse(row.brief) as DecisionBrief).default;
        if (!option) throw new Error("Level 3 brief has no default");
        if (state.left_ms === 0 && option) { this.buckets.delete(row.id); this.onDefault(row, option); this.checked(row); continue; }
        const bucket = Math.floor(state.active_ms / (15 * MINUTE));
        if (this.buckets.get(row.id) !== bucket) { this.buckets.set(row.id, bucket); if (bucket > 0) this.onProgress(row); }
        this.checked(row);
      } catch (e) {
        console.warn(`Veto clock decision ${row.id} failed`, e);
        const failures = (row.veto_errors ?? 0) + 1;
        this.store.db.prepare("UPDATE decisions SET veto_errors=?,veto_last_error=? WHERE id=?").run(failures, String(e), row.id);
        if (failures === 3) {
          try { this.onError(row, String(e)); } catch (error) { this.store.db.prepare("UPDATE decisions SET veto_errors=2 WHERE id=?").run(row.id); console.warn("Veto error wake failed", error); }
        }
      }
    }
  }

  private checked(row: DecisionRow): void {
    if (row.veto_errors || row.veto_last_error) this.store.db.prepare("UPDATE decisions SET veto_errors=0,veto_last_error=NULL WHERE id=?").run(row.id);
  }

  close(): void { this.stopped = true; clearInterval(this.timer); }
}
