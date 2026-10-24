import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readAccountPolicy } from './start-work-accounts.js';
import type { StartAccount, StartWork } from './start-work.js';
import type { LoomThreadRow } from './source-loom.js';

// Capacity: what's running, on which account, on which machine (the next layout's Capacity page),
// and the routing rules that say which accounts each repo may use (Settings › Routing).
//
// Loom serves its side (GET /capacity: each Claude account's open threads, cooling, and whether it
// takes moves). The desk reads native account names and usage from Loom's configuration
// and lays Loom's threads over them. An older Loom
// without /capacity: the desk groups Loom's /snapshot itself, and `moves` stays false.

export interface CapacityWindow {
  /** % left. */
  left: number;
  resetsAt: string | null;
}

export interface CapacityThread {
  itemId: string;
  title: string;
  repo: string | null;
  running: boolean;
  lastActiveAt: number;
  /** The accounts it may run on (Loom account ids); null: any. */
  allowed: string[] | null;
  allowedFrom?: "policy" | "pinned" | null;
}

export interface CapacityForecast {
  burnPerDay: number;
  hoursOfHistory: number;
  projectedAtReset: number;
  dryAt: number | null;
  flags: ('expires_unused' | 'runs_dry')[];
}

export interface CapacityAccount {
  forecast?: CapacityForecast | null;
  forecastReason?: "history" | "no_reading" | null;
  score?: number;
  pace?: number;
  load?: number;
  id: string;
  name: string;
  color: string | null;
  provider: 'claude' | 'codex';
  /** fresh, stale, down, or none (no reading), as the usage monitor has it. */
  status: string;
  /** Loom rests the account after a limit until then (epoch ms or ISO); null when it's in rotation. */
  coolingUntil?: number | string | null;
  fiveHour: CapacityWindow | null;
  weekly: CapacityWindow | null;
  running: number;
  idle: number;
  /** Its open Loom threads, running first then the most recent. */
  threads: CapacityThread[];
  /** Loom's floor for threads allowed only this account (percent left), how many are, and whether it's near or under it. */
  floorPercent?: number | null;
  pinned?: number;
  warning?: 'near_floor' | 'below_floor' | null;
}

export interface CapacityMachine {
  /** Measured by the desk (later Loom): when. */
  at: number;
  memory: { totalBytes: number; agents: Array<{ name: string; processes: number; bytes: number }> };
  disk: { totalBytes: number; freeBytes: number } | null;
  worktrees: { count: number } | null;
}

export interface CapacityRules {
  default: string[];
  repos: Array<{ repo: string; accounts: string[] }>;
  error: string | null;
}

export interface CapacitySnapshot {
  updatedAt: number;
  /** Loom reachable: thread counts are real. */
  loom: boolean;
  /** Loom takes a move command (not yet). */
  moves: boolean;
  accounts: CapacityAccount[];
  rules: CapacityRules;
  machine: CapacityMachine | null;
}

/** Loom's GET /capacity, the parts the desk reads (accounts keyed by their Loom ids). */
export interface LoomCapacity {
  moves: boolean;
  accounts: Array<{ forecast?: CapacityForecast | null; forecastReason?: "history" | "no_reading" | null; pace?: number; score?: number; load?: number; id: string; provider?: 'claude' | 'codex'; coolingUntil?: number | string | null; running: number; idle: number; threads: CapacityThread[]; floorPercent?: number | null; pinned?: number; warning?: 'near_floor' | 'below_floor' | null }>;
}

export interface CapacityDeps {
  startWork: StartWork;
  policyFile?: string;
  loom?: {
    threads(): Promise<LoomThreadRow[] | null>;
    capacity?(): Promise<LoomCapacity | null>;
    move?(itemId: string, account: string, commandId: string, allow?: boolean): Promise<{ ok: true } | { ok: false; error: string }>;
    accountHistory?(itemId: string): Promise<Array<{ account: string; at: number; reason: string }> | null>;
  } | null;
  /** Loom's accounts.json: its account names and the Loom ids they answer to. */
  loomAccountsFile?: string;
  /** Loom's worktrees folder (counted for the machine). */
  loomWorktrees?: string;
  /** Override the machine reading (tests). */
  machine?: () => Promise<CapacityMachine | null>;
  now?: () => number;
}

/** Loom account name or alias → the Loom account id it is (accounts.json lists aliases like claudeAgent_personal). */
export function loomAccountIds(file: string | undefined, ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!file) return out;
  let parsed: Partial<Record<'claude' | 'codex', { accounts?: Array<{ name?: string; aliases?: string[] }> }>>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return out;
  }
  for (const provider of ['claude', 'codex'] as const) {
    for (const account of Array.isArray(parsed?.[provider]?.accounts) ? parsed[provider]!.accounts! : []) {
      if (!account || typeof account.name !== 'string' || (account.aliases !== undefined && !Array.isArray(account.aliases))) continue;
      const nativeId = account.aliases?.[0] ?? account.name;
      const qualified = `${provider}:${nativeId}`;
      const id = ids.includes(qualified) ? qualified : [...(account.aliases ?? []), account.name].find(candidate => ids.includes(candidate));
      if (id) for (const name of [account.name, ...(account.aliases ?? [])]) {
        out.set(`${provider}:${name}`, id);
        if (!out.has(name)) out.set(name, id);
      }
    }
  }
  return out;
}

/** The processes worth naming in memory: agent sessions and the browser they drive. */
const AGENT_PROCESSES: Array<[string, RegExp]> = [
  ['Claude sessions', /(^|\/)claude$/],
  ['Codex sessions', /(^|\/)codex$/],
  ['Brave (agent browsing)', /Brave Browser/],
];

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout))));
}

export async function measureMachine(worktrees: string | undefined, now: number): Promise<CapacityMachine> {
  const ps = await run('ps', ['-axo', 'rss=,comm=']);
  const agents = AGENT_PROCESSES.map(([name]) => ({ name, processes: 0, bytes: 0 }));
  for (const line of ps.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const index = AGENT_PROCESSES.findIndex(([, re]) => re.test(match[2]!));
    if (index < 0) continue;
    agents[index]!.processes += 1;
    agents[index]!.bytes += Number(match[1]) * 1024;
  }
  let disk: CapacityMachine['disk'] = null;
  try {
    const stat = fs.statfsSync(os.homedir());
    disk = { totalBytes: stat.blocks * stat.bsize, freeBytes: stat.bavail * stat.bsize };
  } catch {
    // No reading: the page says so.
  }
  let count: number | null = null;
  if (worktrees) {
    try {
      // <worktrees>/<repo>/<thread>
      count = fs.readdirSync(worktrees, { withFileTypes: true }).filter((d) => d.isDirectory()).reduce((n, repo) => n + fs.readdirSync(path.join(worktrees, repo.name), { withFileTypes: true }).filter((d) => d.isDirectory()).length, 0);
    } catch {
      count = null;
    }
  }
  return { at: now, memory: { totalBytes: os.totalmem(), agents: agents.filter((a) => a.processes) }, disk, worktrees: count === null ? null : { count } };
}

export class Capacity {
  private readonly now: () => number;
  private machineCache: { at: number; value: Promise<CapacityMachine | null> } | null = null;

  constructor(private readonly deps: CapacityDeps) {
    this.now = deps.now ?? Date.now;
  }

  private machine(): Promise<CapacityMachine | null> {
    if (this.deps.machine) return this.deps.machine();
    if (!this.machineCache || this.now() - this.machineCache.at > 60_000) {
      this.machineCache = { at: this.now(), value: measureMachine(this.deps.loomWorktrees, this.now()).catch(() => null) };
    }
    return this.machineCache.value;
  }

  /** Moves a Loom thread to another account (a Loom id; Loom knows them as aliases) at its next safe point. */
  /** `allow`: also add the account to the thread's allowed set (the owner's one-tap "Run on", D-42); else a disallowed one is refused. */
  async move(itemId: string, account: string, commandId: string = randomUUID(), allow = false): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!itemId.startsWith('loom:')) return { ok: false, error: 'only Loom threads move between accounts' };
    if (!this.deps.loom?.move) return { ok: false, error: "Loom isn't running here" };
    return this.deps.loom.move(itemId, account, commandId, allow);
  }

  /** A Loom thread's accounts over time, with the names the owner knows them by; null when Loom can't say. */
  async history(itemId: string): Promise<Array<{ account: string | null; name: string; at: number; reason: string }> | null> {
    const rows = itemId.startsWith('loom:') ? ((await this.deps.loom?.accountHistory?.(itemId)) ?? null) : null;
    if (!rows) return null;
    const accounts = (await this.deps.startWork.options()).accounts.filter((a) => a.driver !== 'loom');
    const byLoomName = loomAccountIds(this.deps.loomAccountsFile, accounts.map((a) => a.id));
    // History rows carry bare Loom names ("main"), which both providers can use: read them as the thread's own
    // provider, as the snapshot does, so a Codex thread's history doesn't land on the Claude seat.
    const threadId = itemId.slice('loom:'.length);
    const provider = ((await this.deps.loom?.threads().catch(() => null)) ?? []).find((t) => t.id === threadId)?.provider;
    return rows.map((row) => {
      const id = (provider ? byLoomName.get(`${provider}:${row.account}`) : undefined) ?? byLoomName.get(row.account) ?? (accounts.some((a) => a.id === row.account) ? row.account : null);
      return { account: id, name: accounts.find((a) => a.id === id)?.name ?? row.account, at: row.at, reason: row.reason };
    });
  }

  rules(accounts: StartAccount[]): CapacityRules {
    const read = this.deps.policyFile ? readAccountPolicy(this.deps.policyFile) : null;
    if (!read) return { default: [], repos: [], error: null };
    if ('error' in read) return { default: [], repos: [], error: read.error };
    const aliases = loomAccountIds(this.deps.loomAccountsFile, accounts.map(a => a.id));
    const known = (ids: string[]) => [...new Set(ids.map(id => aliases.get(id) ?? id).filter(id => accounts.some(a => a.id === id)))];
    return { default: known(read.defaultPool), repos: [...read.repos].map(([repo, ids]) => ({ repo, accounts: known(ids) })), error: null };
  }

  async snapshot(): Promise<CapacitySnapshot> {
    const fromLoom = (await this.deps.loom?.capacity?.()) ?? null;
    const [options, rows, machine] = await Promise.all([this.deps.startWork.options(), fromLoom ? Promise.resolve(null) : (this.deps.loom?.threads() ?? Promise.resolve(null)), this.machine()]);
    const accounts = options.accounts.filter((a) => a.driver === 'claudeAgent' || a.driver === 'codex');
    const ids = accounts.map((a) => a.id);
    const byLoomName = loomAccountIds(this.deps.loomAccountsFile, ids);
    const toId = (name: string | null, provider?: string) => (name ? ((provider ? byLoomName.get(`${provider}:${name}`) : undefined) ?? byLoomName.get(name) ?? (ids.includes(name) ? name : null)) : null);
    const threads = new Map<string, CapacityThread[]>();
    for (const row of rows ?? []) {
      // Open threads only: stopped and settled ones hold no seat.
      if (row.status === 'stopped' || row.settled_at) continue;
      const provider = (row as LoomThreadRow & { provider?: string }).provider;
      const id = toId(row.account, provider);
      if (!id) continue;
      const allowed = (() => {
        try {
          const names = row.accounts ? (JSON.parse(row.accounts) as string[]) : null;
          return names ? [...new Set(names.map(name => toId(name, provider)).filter((x): x is string => !!x))] : null;
        } catch {
          return null;
        }
      })();
      const list = threads.get(id) ?? [];
      list.push({ itemId: `loom:${row.id}`, title: row.title || 'Untitled thread', repo: row.repo ? path.basename(row.repo) : null, running: row.status === 'running', lastActiveAt: row.updated_at, allowed });
      threads.set(id, list);
    }
    // Loom's own reading of its threads, where it has one.
    if (fromLoom) {
      for (const account of fromLoom.accounts) threads.set(toId(account.id, account.provider) ?? account.id, account.threads.map(thread => ({ ...thread, allowed: thread.allowed?.map(id => toId(id, account.provider) ?? id) ?? null })));
    }
    const cooling = new Map((fromLoom?.accounts ?? []).map((a) => [toId(a.id, a.provider) ?? a.id, a.coolingUntil ?? null]));
    const forecasts = new Map((fromLoom?.accounts ?? []).map(a => [toId(a.id, a.provider) ?? a.id, { forecast: a.forecast ?? null, forecastReason: a.forecastReason ?? null, pace: a.pace, score: a.score, load: a.load }]));
    const floors = new Map((fromLoom?.accounts ?? []).map((a) => [toId(a.id, a.provider) ?? a.id, { floorPercent: a.floorPercent ?? null, pinned: a.pinned ?? 0, warning: a.warning ?? null }]));
    return {
      updatedAt: this.now(),
      loom: !!fromLoom || rows !== null,
      moves: !!fromLoom?.moves,
      accounts: accounts.map((account) => {
        const list = (threads.get(account.id) ?? []).sort((a, b) => Number(b.running) - Number(a.running) || b.lastActiveAt - a.lastActiveAt);
        const u = account.usage;
        const running = list.filter((t) => t.running).length;
        return {
          id: account.id,
          name: account.name,
          color: account.color ?? null,
          provider: account.driver === 'codex' ? 'codex' : 'claude',
          status: u?.status ?? 'none',
          coolingUntil: cooling.get(account.id) ?? null,
          fiveHour: u?.session != null ? { left: u.session, resetsAt: u.sessionResetsAt ?? null } : null,
          weekly: u?.weekly != null ? { left: u.weekly, resetsAt: u.resetsAt } : null,
          running,
          idle: list.length - running,
          threads: list,
          // Loom's floor reading, passed through (Codex review on #807).
          ...(floors.get(account.id) ?? {}),
          ...(forecasts.get(account.id) ?? {}),
        };
      }),
      rules: this.rules(accounts),
      machine,
    };
  }
}

// ── routing: the policy file, edited from Settings › Routing ──────────────

export interface RoutingUpdate {
  default: string[];
  repos: Record<string, string[]>;
}

const NAME = /^[A-Za-z0-9._-]+$/;
const yamlName = (text: string) => (NAME.test(text) ? text : JSON.stringify(text));
const yamlList = (ids: string[]) => (ids.length === 1 ? yamlName(ids[0]!) : `[${ids.map(yamlName).join(', ')}]`);

/** Problems with an update (unknown accounts, a repo with none); empty when it can be saved. */
export function routingProblems(update: RoutingUpdate, accountIds: string[]): string[] {
  const problems: string[] = [];
  const unknown = [...new Set([...update.default, ...Object.values(update.repos).flat()])].filter((id) => !accountIds.includes(id));
  if (unknown.length) problems.push(`No account named ${unknown.join(', ')}`);
  for (const [repo, ids] of Object.entries(update.repos)) {
    if (!repo.trim() || !NAME.test(repo)) problems.push(`“${repo}” isn't a repo name`);
    if (!ids.length) problems.push(`${repo} needs at least one account`);
  }
  return problems;
}

/** Writes the policy: the model kept as it was, then the default pool and each repo's accounts. */
export function writeRouting(file: string, update: RoutingUpdate, model: string | null): void {
  const repos = Object.entries(update.repos).sort(([a], [b]) => a.localeCompare(b));
  const lines = [
    '# Start work routing: which accounts each repo’s new threads may run on.',
    '# Edited from the desk (Settings › Routing); Loom picks the account with the most room among them.',
    '',
    ...(model ? [`model: ${yamlName(model)}`] : []),
    ...(update.default.length ? [`default: ${yamlList(update.default)}`] : []),
    ...(repos.length ? ['', 'repos:', ...repos.map(([repo, ids]) => `  ${yamlName(repo.toLowerCase())}: ${yamlList(ids)}`)] : []),
    '',
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, lines.join('\n'));
  fs.renameSync(tmp, file);
}
