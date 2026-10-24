import { defaultStartMode } from '../../public/desk/start-mode.js';
export { defaultStartMode } from '../../public/desk/start-mode.js';
import type { ThreadRole } from './types.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { attachmentProblems, type StartAttachment } from './attachments.js';
import { pickFromPool, readAccountPolicy, usageByAccount, type AccountUsage, type UsageMonitor } from './start-work-accounts.js';
import type { LoomStart } from './source-loom.js';

// New coding threads run exclusively on Loom.
// Plan first is an opening-prompt instruction, not an enforced runtime mode.

export type StartField = 'repo' | 'prompt';
export type StartMode = 'auto' | 'worktree' | 'local';

export interface StartWorkRequest {
  repo?: string;
  prompt?: string;
  title?: string;
  account?: string;
  /** On Loom: the one account (of those the repo may use) the thread stays on. */
  pin?: string;
  mode?: string;
  sameTree?: boolean;
  plan?: boolean;
  /** Images for the first message (pasted or attached on the sheet), as data URLs. */
  attachments?: StartAttachment[];
  /** Client-generated; a retry with the same id returns the first result instead of a second thread. */
  commandId?: string;
  /**
   * Retained to reject callers requesting the retired supervised runtime; Loom cannot enforce it.
   */
  supervised?: boolean;
  /** Server-side only: who the thread works for and its owner (a desk item id), kept by Loom (roles.ts). */
  role?: ThreadRole;
  tier?: string;
  parentItemId?: string;
}

export { ATTACHMENT_TYPES, attachmentProblems, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, type StartAttachment } from './attachments.js';

export interface StartRepo {
  id: string;
  name: string;
  path: string;
  /** The account a new thread in this repo runs on unless another is picked (`loom` when Loom runs here). */
  account: string;
  /** Why that account (the owner's policy, the usage monitor's pick); absent without a policy. */
  accountReason?: string;
  /** The policy's pool for this repo, when it has more than one seat: the account above is the usage monitor's pick. */
  pool?: string[];
  /**
   * For a Loom start: the accounts the policy allows this repo (never `loom` itself) and the one
   * it would start on. Loom keeps the thread inside them, including when a limit moves it.
   */
  loomSeats?: string[];
  loomPick?: string;
  mode: StartMode;
}

export interface StartAccount {
  id: string;
  name: string;
  /** claudeAgent / codex: "Claude" or "ChatGPT" when spoken; loom: the Loom account. */
  driver: string;
  model: string;
  /** Compatibility names from native Loom configuration. */
  aliases?: string[];
  /** Optional account accent color. */
  color?: string;
  /** Its headroom from the usage monitor, when the desk has one. */
  usage?: AccountUsage;
}

export interface StartWorkOptions {
  repos: StartRepo[];
  accounts: StartAccount[];
  fields: { required: StartField[]; defaults: string[] };
}

export interface StartPlan {
  repo: StartRepo;
  prompt: string;
  title: string;
  account: StartAccount;
  mode: StartMode;
  plan: boolean;
  /** Worktree mode: the branch it starts from (origin's default). Local: the checkout's branch. */
  baseBranch: string;
  /** How many images go with the prompt (the images themselves never come back to a client). */
  attachments: number;
  /** On Loom, pinned: the one account it may run on. */
  pin?: string;
}

export interface StartCheck {
  ready: boolean;
  missing: StartField[];
  /** Something given that doesn't resolve ("No repo named 'tangoo'"). */
  problems: string[];
  /** One question that collects what is missing, for voice and the sheet. */
  question: string | null;
  plan: StartPlan | null;
  /** The resolved parts, even when not ready (to prefill the sheet). */
  resolved: { repo: StartRepo | null; account: StartAccount | null; title: string | null; mode: StartMode | null };
}

export type StartResult =
  | { ok: true; threadId: string; itemId: string; plan: StartPlan }
  | { ok: false; check?: StartCheck; error: string };

/** What start-work needs from Loom (DeskLoomSource). */
export interface StartWorkLoom {
  startThread(start: LoomStart): Promise<{ ok: true; threadId: string } | { ok: false; error: string }>;
  /** Optional health probe; an outage never enables a fallback runtime. */
  reachable?(): Promise<boolean>;
}

export interface StartWorkDeps {
  loom?: StartWorkLoom;
  /** Repositories explicitly configured for the desk. */
  repos: Array<{ id: string; name: string; path: string; mode?: StartMode }>;
  /** Loom's native account configuration. */
  accountsFile?: string;
  policyFile?: string;
  usage?: UsageMonitor;
  /** The branch a repo's worktrees start from, and its checked-out branch. */
  git?: (cwd: string, args: string[]) => Promise<string>;
  now?: () => number;
  log?: (event: string, data: Record<string, unknown>) => void;
  trace?: (kind: string, summary: string, data: Record<string, unknown>) => void;
}

const FALLBACK_MODEL: Record<string, string> = { claudeAgent: 'claude-opus-5-5', codex: 'gpt-6-astra' };
/** Loom as an account: it picks the seat (and so the model) itself. */
export const LOOM_ACCOUNT: StartAccount = { id: 'loom', name: 'Loom (best account)', driver: 'loom', model: 'Claude' };
const MAX_TITLE = 60;

function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** The prompt's first sentence, clipped: Loom refines the title once the thread runs. */
export function titleFromPrompt(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  const sentence = flat.split(/(?<=[.?!])\s/)[0] ?? flat;
  return sentence.length > MAX_TITLE ? `${sentence.slice(0, MAX_TITLE - 1).replace(/\s+\S*$/, '')}…` : sentence;
}

/** "acme web" → acme-web: exact name, then a unique prefix, then a unique word match. */
export function matchRepo(said: string, repos: StartRepo[]): StartRepo | null {
  const key = norm(said);
  if (!key) return null;
  const exact = repos.find((repo) => norm(repo.name) === key || repo.id === said);
  if (exact) return exact;
  const prefixed = repos.filter((repo) => norm(repo.name).startsWith(key));
  if (prefixed.length === 1) return prefixed[0]!;
  // "the acme repo": the shortest name whose words are all said wins ("acme" over "acme-web").
  const saidWords = new Set(words(said));
  const covered = repos.filter((repo) => words(repo.name).filter((w) => !/^v\d+$/.test(w)).every((w) => saidWords.has(w)));
  if (covered.length === 0) return null;
  covered.sort((a, b) => words(b.name).length - words(a.name).length);
  const best = covered[0]!;
  return covered.filter((repo) => words(repo.name).length === words(best.name).length).length === 1 ? best : null;
}

/** An account by id, by display name ("Acme (Personal)", "acme personal"), or by kind when only one fits ("claude", "chatgpt"). */
export function matchAccount(said: string, accounts: StartAccount[]): StartAccount | null {
  const key = norm(said);
  if (!key) return null;
  const exact = accounts.find((account) => account.id === said || account.aliases?.includes(said) || norm(account.name) === key || norm(account.id) === key);
  if (exact) return exact;
  const saidWords = words(said).map((w) => (w === 'chatgpt' || w === 'gpt' || w === 'openai' ? 'codex' : w === 'anthropic' ? 'claude' : w));
  const scored = accounts
    .map((account) => {
      // Loom isn't a Claude seat: "claude" alone never lands on it.
      const own = new Set([...words(account.name), account.driver === 'codex' ? 'codex' : account.driver === 'loom' ? 'loom' : 'claude']);
      return { account, hits: saidWords.filter((w) => own.has(w)).length, all: saidWords.every((w) => own.has(w)) };
    })
    .filter((entry) => entry.all && entry.hits > 0);
  return scored.length === 1 ? scored[0]!.account : null;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('git', ['-C', cwd, ...args], { timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim()))),
  );
}

export class StartWork {
  private readonly git: (cwd: string, args: string[]) => Promise<string>;
  private readonly now: () => number;
  /** commandId → the thread it started (a retried request starts nothing new). */
  private readonly started = new Map<string, StartResult>();
  private readonly inFlight = new Map<string, Promise<StartResult>>();
  /** When each account last started a thread from this process. */
  private readonly startedAt = new Map<string, number>();
  /**
   * Choosing an account and reserving it happen one start at a time: two overlapping starts
   * (Start & another, or voice and the desk at once) would otherwise both read the same
   * turns and land on the same seat. Dispatch itself runs outside it.
   */
  private picking: Promise<unknown> = Promise.resolve();
  /**
   * Starts still dispatching, by command id: each holds its account's turn until it lands (then it
   * joins startedAt) or fails (then it simply drops out). No restore step, so failures finishing in
   * any order can't leave a turn behind or take a later one away (Codex review on #484).
   */
  private readonly reserved = new Map<string, { id: string; at: number }>();
  constructor(private readonly deps: StartWorkDeps) {
    this.git = deps.git ?? runGit;
    this.now = deps.now ?? Date.now;
  }

  /** Repositories and accounts come from desk and Loom configuration, never a retired source. */
  async options(): Promise<StartWorkOptions & { policyModel: string | null; policyError: string | null; noAccount: string[] }> {
    const accounts: StartAccount[] = [];
    const aliases = new Map<string, string>();
    let configError: string | null = null;
    try {
      const file = this.deps.accountsFile ?? path.join(os.homedir(), '.tango', 'loom', 'accounts.json');
      const config = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, { accounts?: Array<{ name: string; usageName?: string; color?: string; accentColor?: string; aliases?: string[] }> }>;
      for (const provider of ['claude', 'codex']) for (const seat of config[provider]?.accounts ?? []) {
        if (!seat || typeof seat.name !== 'string' || !seat.name.trim() || (seat.aliases !== undefined && (!Array.isArray(seat.aliases) || seat.aliases.some(alias => typeof alias !== 'string')))) throw new Error('Invalid Loom account entry');
        // Match Loom's /capacity identity: its first alias, else its provider-local name.
        const nativeId = seat.aliases?.[0] ?? seat.name;
        // Claude pins retain Loom's native identity; Codex seats are display-only here.
        const id = provider === 'codex' && (nativeId === 'loom' || accounts.some(account => account.id === nativeId))
          ? `codex:${nativeId}` : nativeId;
        if (id === 'loom' || accounts.some(account => account.id === id)) throw new Error(`Duplicate Loom account identity: ${id}`);
        const driver = provider === 'claude' ? 'claudeAgent' : 'codex';
        accounts.push({ id, name: seat.usageName ?? seat.name, driver, aliases: [seat.name, ...(seat.aliases ?? [])], model: FALLBACK_MODEL[driver]!, ...(seat.accentColor ?? seat.color ? { color: seat.accentColor ?? seat.color } : {}) });
        for (const alias of [seat.name, ...(seat.aliases ?? []), id]) {
          if (!aliases.has(alias)) aliases.set(alias, id);
          aliases.set(`${provider}:${alias}`, id);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') configError = `Cannot read Loom accounts: ${redactPaths((err as Error).message)}`;
    }
    if (this.deps.loom) accounts.push({ ...LOOM_ACCOUNT });
    aliases.set('loom', 'loom');
    const repos: StartRepo[] = this.deps.repos.map(repo => ({ ...repo, account: 'loom', mode: repo.mode ?? 'worktree' }));
    const read = this.deps.policyFile ? readAccountPolicy(this.deps.policyFile) : null;
    const policy = read && !('error' in read) ? read : null;
    const unknown = policy ? [...policy.defaultPool, ...[...policy.repos.values()].flat()].filter(id => !aliases.has(id)) : [];
    const policyError = configError ?? (read && 'error' in read ? `The Start work policy is broken: ${redactPaths(read.error)}` : unknown.length ? `The Start work policy names unknown Loom accounts: ${[...new Set(unknown)].join(', ')}` : null);
    const usage = await this.deps.usage?.snapshot() ?? null;
    const normalizedUsage = usage ? { ...usage, aliases: Object.fromEntries(Object.entries(usage.aliases ?? {}).filter(([, id]) => aliases.has(id)).map(([key, id]) => [key, aliases.get(`${key.split(':')[0]!.toLowerCase()}:${id}`) ?? aliases.get(id)!])) } : null;
    const readings = usageByAccount(accounts.filter(a => a.driver !== 'loom'), normalizedUsage, this.now());
    for (const account of accounts) account.usage = readings.get(account.id);
    const lastStarted = new Map(this.startedAt);
    for (const { id, at } of this.reserved.values()) if (at > (lastStarted.get(id) ?? 0)) lastStarted.set(id, at);
    const noAccount: string[] = [];
    if (policy) for (const repo of repos) {
      const ids = policy.repos.get(repo.name.toLowerCase()) ?? policy.defaultPool;
      const seatIds = ids.filter(id => id !== 'loom');
      const allowed = (seatIds.length ? seatIds : ids.includes('loom') ? policy.defaultPool.filter(id => id !== 'loom') : []).map(id => aliases.get(id) ?? id);
      if (!allowed.length) continue;
      repo.loomSeats = allowed.filter(id => accounts.some(a => a.id === id && a.driver === 'claudeAgent'));
      const seats = accounts.filter(a => repo.loomSeats!.includes(a.id));
      const pick = pickFromPool(seats, normalizedUsage, lastStarted, this.now());
      if (pick) { repo.loomPick = pick.id; repo.accountReason = pick.reason; }
      else noAccount.push(repo.id);
      if (seats.length > 1) repo.pool = seats.map(a => a.id);
    }
    return { repos, accounts, policyModel: policy?.model ?? null, policyError, noAccount, fields: { required: ['repo', 'prompt'], defaults: ['title', 'account', 'mode', 'plan'] } };
  }

  /** Resolve a request against the repos and accounts; says what is missing and what didn't match. */
  async check(request: StartWorkRequest): Promise<StartCheck> {
    const options = await this.options();
    const missing: StartField[] = [];
    const problems: string[] = [];
    const repoSaid = request.repo?.trim() ?? '';
    const repo = repoSaid ? matchRepo(repoSaid, options.repos) : null;
    if (!repoSaid) missing.push('repo');
    else if (!repo) problems.push(`No repo named “${repoSaid}”. The desk follows ${options.repos.map((r) => r.name).join(', ')}.`);
    const prompt = request.prompt?.trim() ?? '';
    if (!prompt) missing.push('prompt');
    const accountSaid = request.account?.trim() ?? '';
    let account: StartAccount | null = null;
    if (accountSaid) {
      account = matchAccount(accountSaid, options.accounts);
      if (!account) problems.push(`No account matches “${accountSaid}”. The accounts are ${options.accounts.map((a) => a.name).join(', ')}.`);
    } else if (options.policyError) {
      problems.push(options.policyError);
    } else if (repo) {
      account = options.accounts.find((candidate) => candidate.id === repo.account) ?? null;
      if (!account) problems.push(`The ${repo.name} default account “${repo.account}” isn't available here.`);
    }
    if (!this.deps.loom) problems.push('New threads require Loom, which is not configured here.');
    if (repo && account?.driver !== 'loom' && options.noAccount.includes(repo.id)) problems.push(`No account in the ${repo.name} pool has headroom right now.`);
    if (account && account.driver !== 'loom') problems.push('T3 is retired; use Loom; use pin to select a permitted Claude account.');
    if (options.policyError && !problems.includes(options.policyError)) problems.push(options.policyError);
    if (request.sameTree && (request.role !== 'worker' || !request.parentItemId?.startsWith('loom:'))) problems.push('Same tree requires a worker started by a Loom parent.');
    if (request.sameTree && request.mode) problems.push('Choose same-tree or mode, not both.');
    const modeSaid = request.mode?.trim().toLowerCase() ?? '';
    const mode: StartMode | null = modeSaid ? (modeSaid === 'local' || modeSaid === 'checkout' ? 'local' : modeSaid === 'auto' ? 'auto' : modeSaid === 'worktree' ? 'worktree' : null) : defaultStartMode({ ...request, repo });
    if (modeSaid && !mode) problems.push(`Mode is auto, worktree or local, not “${request.mode}”.`);
    const title = request.title?.trim() || (prompt ? titleFromPrompt(prompt) : null);
    const attachments = request.attachments ?? [];
    problems.push(...attachmentProblems(attachments).problems);
    // Pinned: one Claude account, and only one the repo may use.
    const pinSaid = request.pin?.trim() ?? '';
    let pin: StartAccount | null = null;
    if (pinSaid) {
      pin = matchAccount(pinSaid, options.accounts.filter((candidate) => candidate.driver === 'claudeAgent'));
      if (account?.driver !== 'loom') problems.push('Only a Loom thread can be pinned to an account.');
      else if (!pin) problems.push(`No Claude account matches “${pinSaid}”.`);
      else if (repo?.loomSeats && !repo.loomSeats.includes(pin.id)) problems.push(`${repo.name} may only use ${repo.loomSeats.map((id) => options.accounts.find((a) => a.id === id)?.name ?? id).join(', ')}: change its routing to pin ${pin.name}.`);
    }
    if (account?.driver === 'loom' && repo?.loomSeats?.length === 0) {
      problems.push(`The ${repo.name} rules name no Claude account, so Loom has none it may use there: add one to its policy.`);
    }
    // On Loom, say which account it starts on, with that account's headroom: the policy still decides.
    if (account?.driver === 'loom' && (pin || repo?.loomPick)) {
      const seat = pin ?? options.accounts.find((candidate) => candidate.id === repo!.loomPick);
      if (seat) account = { ...account, name: `Loom · ${seat.name}`, ...(seat.usage ? { usage: seat.usage } : {}) };
    }
    // A prompt instruction cannot replace a runtime approval guard.
    if (request.supervised === true) problems.push('Supervised starts are unavailable on Loom; T3 is retired; use Loom.');
    const resolved = { repo, account, title, mode };
    const question = missing.includes('repo') && missing.includes('prompt')
      ? `Which repo, and what should it work on? (${options.repos.map((r) => r.name).join(', ')})`
      : missing.includes('repo')
        ? `Which repo: ${options.repos.map((r) => r.name).join(', ')}?`
        : missing.includes('prompt')
          ? 'What should the new thread work on?'
          : null;
    if (missing.length || problems.length || !repo || !account || !mode || !title) {
      return { ready: false, missing, problems, question, plan: null, resolved };
    }
    const baseBranch = await this.baseBranch(repo.path, mode);
    return {
      ready: true,
      missing,
      problems,
      question: null,
      plan: { repo, prompt, title, account, mode, plan: request.plan === true, baseBranch, attachments: attachments.length, ...(pin ? { pin: pin.id } : {}) },
      resolved,
    };
  }

  private async baseBranch(cwd: string, mode: StartMode): Promise<string> {
    try {
      if (mode === 'local') return await this.git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const head = await this.git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
      return head.replace(/^origin\//, '') || 'main';
    } catch {
      return 'main';
    }
  }

  /** Check, then launch. Never starts a thread with anything missing. */
  async start(request: StartWorkRequest): Promise<StartResult> {
    const commandId = request.commandId?.trim() || randomUUID();
    const done = this.started.get(commandId);
    if (done) return done;
    const running = this.inFlight.get(commandId);
    if (running) return running;
    const attempt = this.launch(request, commandId).catch((error: Error) => ({ ok: false as const, error: redactPaths(error.message) })).finally(() => { this.inFlight.delete(commandId); this.reserved.delete(commandId); });
    this.inFlight.set(commandId, attempt);
    const result = await attempt;
    // Only a success is remembered: a failed start can be retried with the same id.
    if (result.ok) {
      this.started.set(commandId, result);
      if (this.started.size > 200) this.started.delete(this.started.keys().next().value!);
    }
    return result;
  }

  private async launch(request: StartWorkRequest, commandId: string): Promise<StartResult> {
    let check: StartCheck;
    // The seat this start reserves while it dispatches (see `reserved`).
    const pick = async () => {
      const result = await this.check(request);
      if (result.ready && result.plan) this.reserved.set(commandId, { id: result.plan.pin ?? result.plan.repo.loomPick ?? result.plan.account.id, at: this.now() });
      return result;
    };
    const turn = this.picking.then(pick, pick);
    this.picking = turn.catch(() => undefined);
    try {
      check = await turn;
    } catch (err) {
      return { ok: false, error: `Start work isn't answering (${(err as Error).message})` };
    }
    if (!check.ready || !check.plan) {
      return { ok: false, check, error: [check.question, ...check.problems].filter(Boolean).join(' ') || 'Not ready to start' };
    }
    const plan = check.plan;
    if (plan.account.driver === 'loom') return this.launchOnLoom(plan, check, commandId, !request.title?.trim(), request.attachments ?? [], request.role || request.tier ? { role: request.role, ...(request.sameTree ? { sameTree: true } : {}), ...(request.tier ? { tier: request.tier } : {}), ...(request.parentItemId ? { parentItemId: request.parentItemId } : {}) } : null);
    // Defense in depth: even a stale or overridden check cannot create a T3 thread.
    this.reserved.delete(commandId);
    return { ok: false, check, error: 'T3 is retired; use Loom.' };
  }

  /** The same start on Loom: one submit (the desk's command id is Loom's), the thread filed before it answers. */
  private async launchOnLoom(plan: StartPlan, check: StartCheck, commandId: string, autoTitle: boolean, attachments: StartAttachment[], role: { role?: ThreadRole; tier?: string; parentItemId?: string; sameTree?: boolean } | null): Promise<StartResult> {
    const reserved = this.reserved.get(commandId);
    const where = `${plan.repo.name} on Loom${plan.pin ? `, pinned to ${plan.account.name.replace(/^Loom · /, '')}` : ''}${plan.mode === 'local' ? ' (local checkout)' : ''}`;
    const started = this.deps.loom
      ? await this.deps.loom.startThread({
          commandId,
          text: plan.plan ? `Plan first: inspect and propose a plan, then wait for explicit approval before implementing or making changes.\n\n${plan.prompt}` : plan.prompt,
          title: plan.title,
          repoPath: plan.repo.path,
          mode: plan.mode,
          ...(plan.pin ? { account: plan.pin, accounts: [plan.pin] } : {
            ...(plan.repo.loomPick ? { account: plan.repo.loomPick } : {}),
            ...(plan.repo.loomSeats ? { accounts: plan.repo.loomSeats, accountsFrom: "policy" as const } : {}),
          }),
          ...(autoTitle ? { autoTitle: true } : {}),
          ...(attachments.length ? { attachments } : {}),
          ...(role ? { role: role.role, ...(role.sameTree ? { sameTree: true } : {}), ...(role.tier ? { tier: role.tier } : {}), ...(role.parentItemId ? { parentThreadId: role.parentItemId } : {}) } : {}),
        })
      : { ok: false as const, error: "Loom isn't running here" };
    this.reserved.delete(commandId);
    if (!started.ok) {
      this.deps.log?.('desk.start-work.error', { commandId, repo: plan.repo.name, account: 'loom', message: redactPaths(started.error) });
      this.deps.trace?.('start-work.failed', `new Loom thread in ${where} failed: ${redactPaths(started.error)}`, { commandId, repo: plan.repo.name, account: 'loom', error: redactPaths(started.error) });
      return { ok: false, check, error: started.error };
    }
    if (reserved) this.startedAt.set(reserved.id, reserved.at);
    const { threadId } = started;
    this.deps.log?.('desk.start-work', { commandId, threadId, repo: plan.repo.name, account: 'loom', mode: plan.mode, plan: plan.plan });
    this.deps.trace?.('start-work', `new Loom thread in ${where}: “${plan.title}”`, { commandId, threadId, repo: plan.repo.name, account: 'loom', mode: plan.mode, plan: plan.plan });
    return { ok: true, threadId, itemId: `loom:${threadId}`, plan };
  }
}

/** Text for a client: home-directory paths (in git and filesystem errors) become "~". */
export function redactPaths(text: string, home = os.homedir()): string {
  const homeless = home && home !== '/' ? text.split(home).join('~') : text;
  return homeless.replace(/\/(?:Users|home)\/[^/\s'"]+/g, '~');
}

/** A repo as clients see it: no local path (it names the machine's home directory). */
export type PublicRepo = Omit<StartRepo, 'path'>;

function publicRepo(repo: StartRepo): PublicRepo {
  const { path: _path, ...rest } = repo;
  return rest;
}

/** The options as clients see them: no internal selections, no local paths. */
export function publicOptions(options: StartWorkOptions & { selections?: unknown; policyModel?: unknown; policyError?: string | null; noAccount?: unknown }) {
  return { repos: options.repos.map(publicRepo), accounts: options.accounts, fields: options.fields, policyError: options.policyError ?? null, policyModel: typeof options.policyModel === 'string' ? options.policyModel : null };
}

/** A check as clients see it. */
export function publicCheck(check: StartCheck) {
  return {
    ...check,
    plan: check.plan ? { ...check.plan, repo: publicRepo(check.plan.repo) } : null,
    resolved: { ...check.resolved, repo: check.resolved.repo ? publicRepo(check.resolved.repo) : null },
  };
}

/** A start result as clients see it. */
export function publicResult(result: StartResult) {
  if (result.ok) return { ...result, plan: { ...result.plan, repo: publicRepo(result.plan.repo) } };
  const error = redactPaths(result.error);
  return result.check ? { ...result, error, check: publicCheck(result.check) } : { ...result, error };
}

/** The configured checkout a directory sits in: the deepest match, so a nested checkout wins over its parent. */
export function repoForDir<R extends { path: string }>(dir: string, repos: readonly R[]): R | undefined {
  const resolved = path.resolve(dir);
  let best: R | undefined;
  for (const entry of repos) {
    const root = path.resolve(entry.path);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) continue;
    if (!best || root.length > path.resolve(best.path).length) best = entry;
  }
  return best;
}

/** Read explicit repo configuration or discover direct checkouts in the workspace root. */
export function readStartRepos(file?: string, root = path.join(os.homedir(), 'GitHub')): StartWorkDeps['repos'] {
  if (file) {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed) || parsed.some(repo => !repo || typeof repo.name !== 'string' || typeof repo.path !== 'string' || !path.isAbsolute(repo.path) || (repo.mode !== undefined && repo.mode !== 'auto' && repo.mode !== 'local' && repo.mode !== 'worktree'))) throw new Error('Start work repos must be an array of { name, path, id?, mode? } with absolute paths');
    return parsed.map(repo => ({ id: repo.id ?? repo.name, name: repo.name, path: repo.path, ...(repo.mode ? { mode: repo.mode } : {}) }));
  }
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, '.git'))).map(entry => ({ id: entry.name, name: entry.name, path: path.join(root, entry.name) })).sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}
