import * as fs from 'node:fs';
import yaml from 'js-yaml';

// Which account a new Loom thread runs on (Start work, TGO-934).
//
// The owner's policy lives in the profile layer (account names are private), e.g.
//
//   model: claude-opus-5-5          # every Claude thread runs this model
//   default: claude_home            # repos not listed below
//   repos:
//     tango: claude_home            # one account: always that one
//     work-repo: [claude_team, claude_spare]   # a pool: the usage monitor's pick
//     loom-repo: loom               # Loom, when it runs here: it picks the seat from its own pool
//
// For a pool, the usage monitor (apps/usage-ui, GET /api/usage) ranks the accounts the
// way its "New project" recommendation does; accounts with comparable headroom take
// turns (the one that started a thread longest ago goes next). When the monitor can't
// be read, the pool simply takes turns, skipping accounts the monitor last reported
// as unavailable (signed out, rate-limited).

export interface AccountPolicy {
  /** The model every Claude account runs; null keeps each account's last model. */
  model: string | null;
  /** The account for repos the policy doesn't list; null keeps Loom's own default. */
  defaultAccount: string | null;
  /** The same as a pool (`default` may name several); empty when there is no default. */
  defaultPool: string[];
  /** Repo name (lowercase) → its account, or a pool to choose from. */
  repos: Map<string, string[]>;
}

/** Throws on anything but the documented shape: a mistyped policy must not route work silently. */
export function parseAccountPolicy(text: string): AccountPolicy {
  const loaded = yaml.load(text);
  // An empty file, a bare null, a list, a date: none of them is a policy.
  if (!loaded || typeof loaded !== 'object' || Object.getPrototypeOf(loaded) !== Object.prototype) throw new Error('the file must be a mapping (model, default, repos)');
  const raw = loaded as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !['model', 'default', 'repos'].includes(key));
  if (unknown.length) throw new Error(`unknown key${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} (expected model, default, repos)`);
  const text1 = (value: unknown, what: string): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${what} must be an account or model name`);
    return value.trim();
  };
  const repos = new Map<string, string[]>();
  if (raw.repos !== undefined && raw.repos !== null) {
    if (typeof raw.repos !== 'object' || Object.getPrototypeOf(raw.repos) !== Object.prototype) throw new Error('repos must map each repo to an account or a list of accounts');
    for (const [name, value] of Object.entries(raw.repos as Record<string, unknown>)) {
      const pool = Array.isArray(value) ? value : [value];
      if (pool.length === 0 || pool.some((entry) => typeof entry !== 'string' || !entry.trim())) throw new Error(`repos.${name} must be an account or a list of accounts`);
      repos.set(name.toLowerCase(), (pool as string[]).map((entry) => entry.trim()));
    }
  }
  const defaults = Array.isArray(raw.default) ? raw.default : raw.default === undefined || raw.default === null ? [] : [raw.default];
  if ((Array.isArray(raw.default) && !defaults.length) || defaults.some((entry) => typeof entry !== 'string' || !entry.trim())) throw new Error('default must be an account or a list of accounts');
  const defaultPool = (defaults as string[]).map((entry) => entry.trim());
  return { model: text1(raw.model, 'model'), defaultAccount: defaultPool[0] ?? null, defaultPool, repos };
}

/**
 * The policy file; null when there is none (Loom's own per-repo defaults apply). A file that
 * can't be read or parsed is an error: starting on Loom's defaults instead could put work on
 * the wrong account.
 */
export function readAccountPolicy(file: string): AccountPolicy | null | { error: string } {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : { error: `can't read it (${(err as Error).message})` };
  }
  try {
    return parseAccountPolicy(text);
  } catch (err) {
    return { error: (err as Error).message.split('\n')[0]! };
  }
}

// ── the usage monitor's snapshot ──────────────────────────────────────────

export interface UsageWindow {
  kind: string;
  title: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  windowMinutes: number | null;
  resetsAt: string | null;
}

export interface UsageRow {
  provider: string;
  account: string;
  live: boolean;
  updatedAt: string | null;
  staleReason?: string;
  recommendationExcluded?: boolean;
  /** The Loom display name the monitor matched this row to. */
  profileName?: string;
  windows: UsageWindow[];
}

export interface UsageSnapshot {
  accounts: UsageRow[];
  errors: Array<{ provider: string; account: string; message: string }>;
  /** The monitor's collector identity ("Codex:someone@example.com") → Loom account id, where they differ. */
  aliases?: Record<string, string>;
}

// Mirrors apps/usage-ui/src/recommend.ts (rankAccounts) so the desk picks what the dashboard
// recommends; test/desk-start-work-accounts.test.ts runs both on the same snapshots.
function percentLeft(window: UsageWindow): number | null {
  if (Number.isFinite(window.remainingPercent)) return Math.max(0, Math.min(100, window.remainingPercent as number));
  if (Number.isFinite(window.usedPercent)) return Math.max(0, Math.min(100, 100 - (window.usedPercent as number)));
  return null;
}

function isSpecialWindow(window: UsageWindow): boolean {
  const standardKinds = new Set(['session', 'weekly_all', 'five_hour', 'seven_day', 'primary', 'secondary']);
  return !standardKinds.has(window.kind) || /fable|spark|opus|sonnet|scoped|promotional/i.test(`${window.kind} ${window.title}`);
}

function isMainWeekly(window: UsageWindow): boolean {
  return !isSpecialWindow(window) && (window.windowMinutes === 10_080 || /weekly|seven_day/.test(window.kind));
}

function visibleWindows(account: UsageRow): UsageWindow[] {
  return account.windows.filter((window) => !(account.provider.toLowerCase() === 'codex' && /spark|gpt[-_ ]reserve/i.test(`${window.kind} ${window.title}`)));
}

export interface RankedUsage {
  account: UsageRow;
  remaining: number;
  minimum: number;
  resetsAt: string | null;
  resetIn: number;
  useBeforeReset: boolean;
}

export function rankUsage(accounts: UsageRow[], provider: string, now: number): RankedUsage[] {
  return accounts
    .filter((account) => account.provider === provider && account.live && !account.staleReason && !account.recommendationExcluded && account.updatedAt && now - Date.parse(account.updatedAt) < 15 * 60_000)
    .map((account) => {
      const windows = visibleWindows(account);
      const weekly = windows.find(isMainWeekly);
      const remaining = weekly ? percentLeft(weekly) : null;
      const minimum = Math.min(...windows.map((window) => percentLeft(window) ?? 0));
      const awaitingReset = windows.some((window) => window.resetsAt && Date.parse(window.resetsAt) <= now);
      const resetsAt = weekly?.resetsAt ?? null;
      const resetIn = resetsAt ? Date.parse(resetsAt) - now : NaN;
      const useBeforeReset = remaining !== null && remaining >= 50 && minimum >= 20 && resetIn > 0 && resetIn < 48 * 60 * 60_000;
      return { account, remaining, minimum, awaitingReset, resetsAt, resetIn, useBeforeReset };
    })
    .filter((entry): entry is typeof entry & { remaining: number } => entry.remaining !== null && entry.minimum > 0 && !entry.awaitingReset)
    .sort(
      (a, b) =>
        Number(b.useBeforeReset) - Number(a.useBeforeReset) ||
        (a.useBeforeReset && b.useBeforeReset ? a.resetIn - b.resetIn : 0) ||
        Number(b.minimum >= 20) - Number(a.minimum >= 20) ||
        b.remaining - a.remaining ||
        b.minimum - a.minimum,
    )
    .map(({ awaitingReset: _awaiting, ...entry }) => entry);
}

/**
 * GET the monitor's snapshot, cached a minute (it refreshes every five). When a refresh fails,
 * the last good snapshot stands (its rows age into "stale" on their own), so an outage never
 * puts back seats the monitor had ruled out. Null only before any snapshot was read.
 */
export class UsageMonitor {
  private cached: { at: number; snapshot: UsageSnapshot | null } | null = null;

  constructor(
    private readonly url: string,
    private readonly now: () => number = Date.now,
    private readonly fetcher: typeof fetch = fetch,
    /** The monitor's profile-aliases.json (collector identity → Loom account id), read with each refresh. */
    private readonly aliasesFile?: string,
  ) {}

  private aliases(): Record<string, string> | undefined {
    if (!this.aliasesFile) return undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.aliasesFile, 'utf8')) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : undefined;
    } catch {
      return undefined;
    }
  }

  async snapshot(): Promise<UsageSnapshot | null> {
    if (this.cached && this.now() - this.cached.at < 60_000) return this.cached.snapshot;
    let snapshot: UsageSnapshot | null = this.cached?.snapshot ?? null;
    try {
      const response = await this.fetcher(this.url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const body = (await response.json()) as { usage?: { accounts?: UsageRow[]; errors?: UsageSnapshot['errors'] } | null };
        if (body.usage?.accounts) snapshot = { accounts: body.usage.accounts, errors: body.usage.errors ?? [], aliases: this.aliases() };
      }
    } catch {
      // The monitor is down or restarting: the last good snapshot stands.
    }
    this.cached = { at: this.now(), snapshot };
    return snapshot;
  }
}

// ── choosing ──────────────────────────────────────────────────────────────

/** A row's seat: through the monitor's alias (collector identity → Loom id), else by display name. */
function seatOf<T extends PoolAccount>(seats: T[], usage: UsageSnapshot | null): (row: UsageRow) => T | undefined {
  return (row) => {
    const alias = usage?.aliases?.[`${row.provider}:${row.account}`];
    return seats.find((account) => (account.driver === 'codex' ? 'Codex' : 'Claude') === row.provider && (alias ? account.id === alias : account.name === (row.profileName ?? row.account)));
  };
}

/** What the Start work sheet shows for one account: its headroom, and where it ranks. */
export interface AccountUsage {
  /** % of the main weekly window left; null when the monitor has no reading. */
  weekly: number | null;
  /** % of the 5-hour window left; null for accounts without one (Codex). */
  session: number | null;
  /** When the weekly window resets. */
  resetsAt: string | null;
  /** When the 5-hour window resets; null without one. */
  sessionResetsAt?: string | null;
  /** Plenty left and it resets within two days: the dashboard puts it first. */
  useBeforeReset: boolean;
  /** The monitor keeps it out of automatic picks (a seat kept for personal work). */
  excluded: boolean;
  /** fresh: read in the last 15 minutes; stale: an older reading; down: no reading and the monitor reports an error; none: no row. */
  status: 'fresh' | 'stale' | 'down' | 'none';
  /** Its place in the monitor's ranking for its provider (0 is the dashboard's pick); null when it doesn't rank. */
  rank: number | null;
}

/** Every account's headroom from one snapshot, for the sheet's account picker. */
export function usageByAccount(seats: PoolAccount[], usage: UsageSnapshot | null, now: number): Map<string, AccountUsage> {
  const out = new Map<string, AccountUsage>();
  const byRow = seatOf(seats, usage);
  const ranks = new Map<string, number>();
  if (usage) {
    for (const provider of ['Claude', 'Codex']) {
      rankUsage(usage.accounts, provider, now).forEach((entry, index) => {
        const seat = byRow(entry.account);
        if (seat && !ranks.has(seat.id)) ranks.set(seat.id, index);
      });
    }
  }
  const down = new Set((usage?.errors ?? []).map((error) => usage?.aliases?.[`${error.provider}:${error.account}`] ?? `${error.provider}:${error.account}`));
  // A provider-wide error ("All accounts") takes every seat of that provider down, as pickFromPool reads it.
  const providerDown = new Set((usage?.errors ?? []).filter((error) => /^all accounts$/i.test(error.account.trim())).map((error) => error.provider));
  for (const seat of seats) {
    const provider = seat.driver === 'codex' ? 'Codex' : 'Claude';
    const own = usage?.accounts.find((row) => byRow(row) === seat);
    const isDown = providerDown.has(provider) || down.has(seat.id) || down.has(`${provider}:${seat.name}`);
    if (!own) {
      out.set(seat.id, { weekly: null, session: null, resetsAt: null, useBeforeReset: false, excluded: false, status: isDown ? 'down' : 'none', rank: null });
      continue;
    }
    const windows = visibleWindows(own);
    const weekly = windows.find(isMainWeekly);
    const session = windows.find((window) => !isSpecialWindow(window) && (window.windowMinutes === 300 || /session|five_hour/.test(window.kind)));
    const fresh = own.live && !own.staleReason && !!own.updatedAt && now - Date.parse(own.updatedAt) < 15 * 60_000;
    const left = weekly ? percentLeft(weekly) : null;
    const resetIn = weekly?.resetsAt ? Date.parse(weekly.resetsAt) - now : NaN;
    const sessionLeft = session ? percentLeft(session) : null;
    // The same test rankUsage applies: every window, scoped ones included, has a fifth left.
    const minimum = Math.min(...windows.map((window) => percentLeft(window) ?? 0));
    out.set(seat.id, {
      weekly: left,
      session: sessionLeft,
      resetsAt: weekly?.resetsAt ?? null,
      sessionResetsAt: session?.resetsAt ?? null,
      useBeforeReset: fresh && left !== null && left >= 50 && minimum >= 20 && resetIn > 0 && resetIn < 48 * 60 * 60_000,
      excluded: !!own.recommendationExcluded,
      // A seat with a reading is fresh or stale by that reading; its own collector error alongside it (rate-limited,
      // showing the last live reading) is why it's stale, not an outage. A provider-wide outage is: the monitor
      // keeps the old rows, but no seat of that provider can be picked (review on #484).
      status: providerDown.has(provider) ? 'down' : fresh ? 'fresh' : 'stale',
      rank: ranks.get(seat.id) ?? null,
    });
  }
  return out;
}

export interface PoolAccount {
  id: string;
  name: string;
  driver: string;
}

export interface AccountPick {
  id: string;
  /** Why, in a few words ("most headroom: 73% weekly left"). */
  reason: string;
}

/** Comparable headroom: within this many points of the best weekly share, both with ≥ 20% everywhere. */
const COMPARABLE_POINTS = 15;

/**
 * One account from a pool. `lastStarted`: when each account last started a thread
 * in this process, so comparable accounts take turns.
 */
export function pickFromPool(pool: PoolAccount[], usage: UsageSnapshot | null, lastStarted: Map<string, number>, now: number): AccountPick | null {
  if (pool.length === 0) return null;
  if (pool.length === 1) return { id: pool[0]!.id, reason: 'the repo’s account' };
  const byRow = seatOf(pool, usage);
  const turns = (ids: string[]) => [...ids].sort((a, b) => (lastStarted.get(a) ?? 0) - (lastStarted.get(b) ?? 0))[0]!;
  if (usage) {
    // The dashboard's order as is (use before reset, soonest reset first); a mixed pool lists Claude first.
    const ranked = ['Claude', 'Codex'].flatMap((provider) => rankUsage(usage.accounts, provider, now)).filter((entry) => byRow(entry.account));
    const best = ranked[0];
    if (best) {
      const left = (entry: RankedUsage) => `${Math.round(entry.remaining)}% weekly left`;
      if (best.useBeforeReset) return { id: byRow(best.account)!.id, reason: `use before reset: ${left(best)}` };
      const comparable = ranked.filter((entry) => entry.minimum >= 20 && best.minimum >= 20 && entry.remaining >= best.remaining - COMPARABLE_POINTS);
      if (comparable.length > 1) {
        const id = turns(comparable.map((entry) => byRow(entry.account)!.id));
        const entry = comparable.find((candidate) => byRow(candidate.account)!.id === id)!;
        return { id, reason: `taking turns: ${left(entry)}` };
      }
      return { id: byRow(best.account)!.id, reason: `most headroom: ${left(best)}` };
    }
    // Nothing in the pool ranks. Only accounts whose quota is merely unknown take turns: not ones the
    // monitor can't read (signed out), excluded ones, or fresh rows that ranked out (no headroom left).
    // Errors name the collector's identity: through the monitor's aliases to a Loom account id, else by display name.
    const down = new Set(usage.errors.map((error) => usage.aliases?.[`${error.provider}:${error.account}`] ?? `${error.provider}:${error.account}`));
    // A provider-wide error ("All accounts") takes every seat of that provider down.
    const providerDown = new Set(usage.errors.filter((error) => /^all accounts$/i.test(error.account.trim())).map((error) => error.provider));
    const unknown = pool.filter((account) => {
      const provider = account.driver === 'codex' ? 'Codex' : 'Claude';
      const key = `${provider}:${account.name}`;
      if (providerDown.has(provider) || down.has(key) || down.has(account.id)) return false;
      const own = usage.accounts.find((candidate) => byRow(candidate) === account);
      if (!own) return true;
      const fresh = own.live && !own.staleReason && !!own.updatedAt && now - Date.parse(own.updatedAt) < 15 * 60_000;
      // An old row that showed a window used up still rules the seat out until that window resets.
      const usedUp = own.windows.some((window) => percentLeft(window) === 0 && !!window.resetsAt && Date.parse(window.resetsAt) > now);
      return !own.recommendationExcluded && !fresh && !usedUp;
    });
    if (unknown.length) return { id: turns(unknown.map((account) => account.id)), reason: 'quota unknown: taking turns' };
    return null;
  }
  return { id: turns(pool.map((account) => account.id)), reason: 'usage monitor unavailable: taking turns' };
}
