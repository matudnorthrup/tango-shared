import type { CapacityWindow } from "./pool.js";
import type { LoomStore } from "./store.js";

const HOUR = 3_600_000;
export const QUOTA_RETENTION_MS = 14 * 24 * HOUR;
export interface QuotaSample {
  at: number;
  weekly_left: number;
  weekly_resets_at: number;
  five_left: number | null;
}
export interface Forecast {
  burnPerDay: number;
  hoursOfHistory: number;
  projectedAtReset: number;
  dryAt: number | null;
  flags: ("expires_unused" | "runs_dry")[];
}
export interface ForecastResult {
  forecast: Forecast | null;
  forecastReason: "history" | "no_reading" | null;
}

/** A linear weekly projection, never spanning resets or extrapolating a missing reading. */
export function forecastSeat({ now, weekly, samples, floor }: {
  now: number; weekly: CapacityWindow | null; samples: readonly QuotaSample[]; floor: number;
}): ForecastResult {
  if (!weekly || !Number.isFinite(weekly.left) || !Number.isFinite(weekly.resetsAt) || weekly.resetsAt === null || weekly.resetsAt <= now) {
    return { forecast: null, forecastReason: "no_reading" };
  }
  const reset = weekly.resetsAt;
  const oldest = samples.filter(s => s.at >= now - 24 * HOUR && s.at <= now && Number.isFinite(s.weekly_left)
    && Math.abs(s.weekly_resets_at - reset) <= 60_000).sort((a, b) => a.at - b.at)[0];
  const hoursOfHistory = oldest ? (now - oldest.at) / HOUR : 0;
  if (!oldest || hoursOfHistory < 2) return { forecast: null, forecastReason: "history" };
  const burnPerHour = Math.max(0, (oldest.weekly_left - weekly.left) / hoursOfHistory);
  const projectedAtReset = Math.max(0, weekly.left - burnPerHour * (reset - now) / HOUR);
  const dryAt = weekly.left <= floor ? now : burnPerHour > 0 ? now + (weekly.left - floor) / burnPerHour * HOUR : null;
  const flags: Forecast["flags"] = [];
  if (projectedAtReset >= 25) flags.push("expires_unused");
  if (dryAt !== null && dryAt < reset) flags.push("runs_dry");
  return { forecast: { burnPerDay: 24 * burnPerHour, hoursOfHistory, projectedAtReset, dryAt, flags }, forecastReason: null };
}

/** Accepted usage-monitor readings only; neither absent rows nor live limit corrections invent samples. */
export class QuotaHistory {
  private inserts = 0;
  constructor(private readonly store: LoomStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS quota_samples (
      provider TEXT NOT NULL, account TEXT NOT NULL, at INTEGER NOT NULL,
      weekly_left REAL NOT NULL, weekly_resets_at INTEGER NOT NULL, five_left REAL
    );
    CREATE INDEX IF NOT EXISTS quota_samples_seat ON quota_samples(provider, account, at);`);
    this.prune();
  }

  record(provider: string, account: string, windows: { weekly: CapacityWindow | null; fiveHour: CapacityWindow | null; fresh: boolean }): void {
    const now = this.store.now();
    const weekly = windows.weekly;
    if (!windows.fresh || !weekly || !Number.isFinite(weekly.left) || weekly.resetsAt === null || !Number.isFinite(weekly.resetsAt) || weekly.resetsAt <= now) return;
    const last = this.store.db.prepare("SELECT * FROM quota_samples WHERE provider = ? AND account = ? ORDER BY at DESC, rowid DESC LIMIT 1").get(provider, account) as QuotaSample | undefined;
    if (last && last.weekly_left === weekly.left && last.weekly_resets_at === weekly.resetsAt && now - last.at < HOUR / 2) return;
    this.store.db.prepare("INSERT INTO quota_samples VALUES (?, ?, ?, ?, ?, ?)").run(provider, account, now, weekly.left, weekly.resetsAt, windows.fiveHour?.left ?? null);
    if (++this.inserts % 1000 === 0) this.prune();
  }

  samples(provider: string, account: string): QuotaSample[] {
    return this.store.db.prepare("SELECT at, weekly_left, weekly_resets_at, five_left FROM quota_samples WHERE provider = ? AND account = ? AND at >= ? ORDER BY at")
      .all(provider, account, this.store.now() - 24 * HOUR) as unknown as QuotaSample[];
  }

  prune(): void {
    this.store.db.prepare("DELETE FROM quota_samples WHERE at < ?").run(this.store.now() - QUOTA_RETENTION_MS);
  }
}
