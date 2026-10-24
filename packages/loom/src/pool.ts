/**
 * The account pool: which account a thread should run on.
 *
 * Remaining room comes from Tango's usage monitor (apps/usage-ui, GET
 * /api/usage), which reads every account's live quota. A harness's own
 * rate-limit events correct it between polls, and a turn that hits a limit
 * cools its account down until the reset.
 */

export interface PoolAccount {
  provider: string;
  name: string;
  /** The usage monitor's profileName or account for this account. Unset: room unknown. */
  usageName?: string;
  /** Other names callers may use for it (e.g. the Desk's T3 instance ids). */
  aliases?: string[];
}

/** The usage monitor's row shape (the parts Loom reads). */
export interface UsageRow {
  provider: string;
  account: string;
  profileName?: string;
  live?: boolean;
  updatedAt?: string;
  windows: { kind?: string; title?: string; remainingPercent?: number | null; windowMinutes?: number; resetsAt?: string | null }[];
}

export interface AccountRoom {
  /** Percent left in the tightest main window (5 hour or 7 day), or null when unknown. */
  remaining: number | null;
  /** When the tightest window resets. Epoch ms. */
  resetsAt: number | null;
  /** Set after a limit was hit: not usable until then. Epoch ms. */
  coolingUntil: number | null;
}

/** New work never starts on an account with less than this much room. */
export const MIN_START_PERCENT = 10;
/** Usage rows older than this are ignored. */
export const USAGE_FRESH_MS = 15 * 60_000;
/** A limit hit without a reset time cools the account for this long. */
export const DEFAULT_COOLDOWN_MS = 60 * 60_000;

/** Model-only windows (e.g. "Fable only") don't stop other models, so they don't count. */
function isMainWindow(w: UsageRow["windows"][number]): boolean {
  const label = `${w.kind ?? ""} ${w.title ?? ""}`;
  if (/only|opus|sonnet|fable|spark|reserve/i.test(label)) return false;
  return w.windowMinutes === 300 || w.windowMinutes === 10_080 || /5 hour|7 day|five_hour|seven_day|weekly/i.test(label);
}

export interface CapacityWindow { left: number; resetsAt: number | null }

export const FIVE_HOUR_GUARD = 25;
export const LOAD_WEIGHT = 0.3;
export const PLACEMENT_WINDOW_MS = 10 * 60_000;
export const CACHE_COLD_MS = 60 * 60_000;
export const REBALANCE_RATIO = 2;
export interface BalanceOptions { fiveHourGuard?: number; loadWeight?: number; rebalanceRatio?: number; cacheColdMs?: number; greedy?: boolean }

export class AccountPool {
  private readonly windows = new Map<string, { fiveHour: CapacityWindow | null; weekly: CapacityWindow | null; at: number }>();

  /** The account's last usage windows, and whether that reading is still fresh. */
  capacityWindows(provider: string, name: string) {
    const entry = this.windows.get(this.key(provider, name));
    if (!entry) return { fiveHour: null, weekly: null, fresh: false };
    return { fiveHour: entry.fiveHour, weekly: entry.weekly, fresh: this.now() - entry.at <= USAGE_FRESH_MS };
  }

  /** Called only when applyUsage accepts a monitor row for this seat. */
  onReading?: (provider: string, name: string) => void;

  private readonly rooms = new Map<string, AccountRoom>();
  now: () => number = Date.now;

  private readonly placements = new Map<string, number[]>();
  readonly balance: Required<BalanceOptions>;
  constructor(readonly accounts: PoolAccount[], balance: BalanceOptions = {}) {
    this.balance = { fiveHourGuard: FIVE_HOUR_GUARD, loadWeight: LOAD_WEIGHT, rebalanceRatio: REBALANCE_RATIO, cacheColdMs: CACHE_COLD_MS, greedy: false };
    for (const key of ["fiveHourGuard", "loadWeight", "rebalanceRatio", "cacheColdMs"] as const) {
      const value = balance[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) this.balance[key] = value;
    }
    this.balance.greedy = balance.greedy === true;
  }

  score(provider: string, name: string) {
    const now = this.now();
    const key = this.key(provider, name);
    const windows = this.windows.get(key);
    const weekly = windows?.weekly;
    const fraction = weekly?.resetsAt == null ? 1 : Math.max(0.05, Math.min(1, (weekly.resetsAt - now) / (7 * 24 * 60 * 60_000)));
    const pace = Math.min(5, (weekly ? weekly.left / 100 : 1) / fraction);
    const guarded = (windows?.fiveHour?.left ?? 100) < this.balance.fiveHourGuard;
    const five = (windows?.fiveHour?.left ?? 100) / 100 * (guarded ? 0.1 : 1);
    const load = (this.placements.get(key) ?? []).reduce((sum, at) => sum + Math.max(0, 1 - Math.max(0, now - at) / PLACEMENT_WINDOW_MS), 0);
    // D-104: spend expiring weekly capacity without draining one 5-hour window during a burst.
    return { score: pace * five / (1 + this.balance.loadWeight * load), pace, load, guarded };
  }

  placed(provider: string, name: string): void {
    const key = this.key(provider, name);
    const now = this.now();
    this.placements.set(key, [...(this.placements.get(key) ?? []).filter((at) => now - at < PLACEMENT_WINDOW_MS), now]);
  }

  /** Takes back the latest placement on an account (a thread routed elsewhere before it opened there). */
  unplaced(provider: string, name: string): void {
    const key = this.key(provider, name);
    this.placements.set(key, (this.placements.get(key) ?? []).slice(0, -1));
  }

  private key(provider: string, name: string): string {
    return `${provider}:${name}`;
  }

  room(provider: string, name: string): AccountRoom {
    const room = this.rooms.get(this.key(provider, name));
    if (!room) return { remaining: null, resetsAt: null, coolingUntil: null };
    // A cooldown that has run out leaves the room unknown until the next reading.
    if (room.coolingUntil && room.coolingUntil <= this.now()) {
      const cleared = { remaining: null, resetsAt: null, coolingUntil: null };
      this.rooms.set(this.key(provider, name), cleared);
      return cleared;
    }
    return room;
  }

  private set(provider: string, name: string, patch: Partial<AccountRoom>): void {
    this.rooms.set(this.key(provider, name), { ...this.room(provider, name), ...patch });
  }

  /** Take a usage-monitor snapshot. Accounts the snapshot doesn't cover keep what they had. */
  applyUsage(rows: UsageRow[]): void {
    const now = this.now();
    for (const account of this.accounts) {
      if (!account.usageName) continue;
      const row = rows.find(
        (r) =>
          r.provider.toLowerCase() === account.provider.toLowerCase() &&
          (r.profileName === account.usageName || r.account === account.usageName),
      );
      if (!row || row.live === false || (row.updatedAt && now - Date.parse(row.updatedAt) > USAGE_FRESH_MS)) continue;
      const windows = row.windows.filter(isMainWindow).filter((w) => typeof w.remainingPercent === "number");
      const window = (minutes: number, label: RegExp): CapacityWindow | null => {
        const w = windows.find((w) => w.windowMinutes === minutes || label.test(`${w.kind ?? ""} ${w.title ?? ""}`));
        return w && Number.isFinite(w.remainingPercent) ? { left: Math.max(0, Math.min(100, w.remainingPercent!)), resetsAt: w.resetsAt ? Date.parse(w.resetsAt) || null : null } : null;
      };
      this.windows.set(this.key(account.provider, account.name), {
        fiveHour: window(300, /5 hour|five_hour|session/i), weekly: window(10_080, /7 day|seven_day|weekly/i), at: now,
      });
      this.onReading?.(account.provider, account.name);
      if (windows.length === 0) continue;
      const tightest = windows.reduce((a, b) => ((b.remainingPercent ?? 100) < (a.remainingPercent ?? 100) ? b : a));
      this.set(account.provider, account.name, {
        remaining: tightest.remainingPercent ?? null,
        resetsAt: tightest.resetsAt ? Date.parse(tightest.resetsAt) || null : null,
      });
    }
  }

  /** A live rate-limit reading from a running session. */
  observe(provider: string, name: string, reading: { status?: string; utilization?: number; resetsAt?: number; window?: string }): void {
    if (reading.status === "rejected") {
      this.coolDown(provider, name, reading.resetsAt);
      return;
    }
    if (typeof reading.utilization === "number") {
      const remaining = Math.max(0, Math.round((1 - reading.utilization) * 100));
      const current = this.room(provider, name).remaining;
      // A reading covers one window; keep the tighter of it and what the monitor said.
      this.set(provider, name, { remaining: current === null ? remaining : Math.min(current, remaining), ...(reading.resetsAt ? { resetsAt: reading.resetsAt } : {}) });
      // The score reads the windows too, so a live drop steers new work before the next poll.
      // An unnamed reading lowers both: conservative until the monitor reports again.
      const key = this.key(provider, name);
      const entry = this.windows.get(key) ?? { fiveHour: null, weekly: null, at: this.now() };
      const lower = (w: CapacityWindow | null): CapacityWindow => ({ left: Math.min(w?.left ?? 100, remaining), resetsAt: reading.resetsAt ?? w?.resetsAt ?? null });
      const label = reading.window ?? "";
      const five = !/seven|week|7 day/i.test(label);
      const week = !/five|session|5 hour/i.test(label);
      this.windows.set(key, { ...entry, ...(five ? { fiveHour: lower(entry.fiveHour) } : {}), ...(week ? { weekly: lower(entry.weekly) } : {}) });
    }
  }

  coolDown(provider: string, name: string, until?: number): void {
    const end = until && until > this.now() ? until : this.now() + DEFAULT_COOLDOWN_MS;
    this.set(provider, name, { coolingUntil: end, remaining: 0, resetsAt: end });
  }

  usable(provider: string, name: string): boolean {
    const room = this.room(provider, name);
    if (room.coolingUntil && room.coolingUntil > this.now()) return false;
    return room.remaining === null || room.remaining >= MIN_START_PERCENT;
  }

  /** The account a name or alias refers to, or null. */
  resolve(provider: string, name: string): PoolAccount | null {
    return this.accounts.find((a) => a.provider === provider && (a.name === name || a.aliases?.includes(name))) ?? null;
  }

  /** Inspect the best usable account without recording a placement; known room wins. */
  best(provider: string, options: { exclude?: string[]; only?: string[] | null } = {}): PoolAccount | null {
    const candidates = this.accounts
      .filter((a) => a.provider === provider && !options.exclude?.includes(a.name))
      .filter((a) => !options.only || options.only.includes(a.name))
      .filter((a) => this.usable(a.provider, a.name))
      .map((a) => ({ a, remaining: this.room(a.provider, a.name).remaining, ...this.score(a.provider, a.name) }))
      .sort((x, y) => this.balance.greedy ? (y.remaining ?? -1) - (x.remaining ?? -1)
        : Number(y.remaining !== null) - Number(x.remaining !== null) || Number(x.guarded) - Number(y.guarded) || y.score - x.score);
    return candidates[0]?.a ?? null;
  }

  pick(provider: string, options: { exclude?: string[]; only?: string[] | null } = {}): PoolAccount | null {
    const account = this.best(provider, options);
    if (account) this.placed(provider, account.name);
    return account;
  }

  /** When the soonest unusable account frees up, or null if none is waiting on a reset. */
  nextAvailableAt(provider: string, only?: string[] | null): number | null {
    const times = this.accounts
      .filter((a) => a.provider === provider && (!only || only.includes(a.name)))
      .map((a) => {
        const room = this.room(a.provider, a.name);
        return room.coolingUntil ?? (room.remaining !== null && room.remaining < MIN_START_PERCENT ? room.resetsAt : null);
      })
      .filter((t): t is number => t !== null);
    return times.length ? Math.min(...times) : null;
  }
}

/**
 * Polls the usage monitor into the pool. Failures leave the pool as it was.
 * `ready` settles after the first poll, so startup can place work with real numbers.
 */
export function startUsageFeed(
  pool: AccountPool,
  url: string,
  everyMs = 60_000,
  log: (msg: string) => void = () => {},
): { stop: () => void; ready: Promise<void> } {
  let stopped = false;
  const tick = async () => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const body = (await response.json()) as { usage?: { accounts?: UsageRow[] } | null };
      if (body.usage?.accounts) pool.applyUsage(body.usage.accounts);
    } catch (error) {
      log(`usage feed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const ready = tick();
  const timer = setInterval(() => !stopped && void tick(), everyMs);
  timer.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    ready,
  };
}
