import type { LoomMemoryCapture } from './loom-memory.js';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MessageAttachment, StartAttachment } from './attachments.js';
import type { DeskCore, DeskSourceAdapter, MailOrigin } from './core.js';
import { recordJobHold } from './job-holds.js';
import { isAckOnly } from './summarize.js';
import { parseQuestions, QUESTION_CHANGED, type PendingResolution } from './pending.js';
import type { DeskFacts, DeskItemRow, InFlight, Log, MessageMeta, PendingQuestion, PendingRequest, ThreadRole, DeskRuleSaved } from './types.js';
import { isThreadRole, type RoleRecord } from './roles.js';
import type { LoomCapacity } from './capacity.js';
import type { DiscordLoomLinkReader } from './discord-loom-links.js';
import { mailTurn, parseMailHeader } from './mail.js';

// Loom (packages/loom) as a desk source: one item per Loom thread (loom:<threadId>).
// Loom pushes its change log over server-sent events; a change names a thread,
// and the thread is read whole and filed the way T3 threads are:
//
//   running   thread status running            → working
//   background tasks a finished turn left running (shells, subagents) → working;
//             only monitors left → watching (the harness wakes the thread when they end)
//   failed    the latest run failed (a usage limit says so) → failed
//   pending   status waiting + an open request → your_move; a question as asked,
//             a plan exit as "Approve this plan?"; answered back via resolvePending
//   settled   settled in Loom                  → source.done (once, on the transition)
//   deleted   the thread's tombstone (data null) → source.done
//
// The stream resumes from the last sequence seen. Loom down, restarting or
// without a token never throws into the desk: the source retries with backoff,
// or stays inert when there is no token to read.

export const LOOM_AGENT_ID = 'loom';
const PREFIX = 'loom:';
/**
 * Keep and Fresh start wait in the thread's Loom mailbox behind a turn that is starting. Past this the desk hangs up
 * and Loom drops the request when its turn comes, so the failure the owner sees is true: nothing changed.
 */
const MAILBOX_WAIT_MS = 120_000;
export const LOOM_URL = 'http://127.0.0.1:9420';

/** Where the desk finds Loom: LOOM_URL (or LOOM_PORT), or the token Loom writes on first start (LOOM_HOME). Null: no Loom here. */
export function loomFromEnv(env: NodeJS.ProcessEnv = process.env): { url: string; tokenFile: string; accountsFile: string } | null {
  const tokenFile = path.join(env.LOOM_HOME || path.join(os.homedir(), '.tango', 'loom'), 'token');
  if (!env.LOOM_URL && !fs.existsSync(tokenFile)) return null;
  return { url: env.LOOM_URL || (env.LOOM_PORT ? `http://127.0.0.1:${env.LOOM_PORT}` : LOOM_URL), tokenFile, accountsFile: env.LOOM_ACCOUNTS || path.join(path.dirname(tokenFile), 'accounts.json') };
}

export interface DeskLoomOptions {
  core: DeskCore;
  url: string;
  /** Loom's bearer token (~/.tango/loom/token), read on every connect. Missing: the source stays inert. */
  tokenFile: string;
  log?: Log;
  /** The workspace a checkout belongs to (T3's project for that folder: its name, icon and color), when one does. */
  projectFor?: (dir: string) => DeskFacts['project'] | null;
  /** Captures each completed run into Tango's memory (loom-memory.ts); absent: no capture. */
  memory?: Pick<LoomMemoryCapture, 'capture'>;
  /** Which Discord conversation a Tango agent's Loom thread talks in (the bot's records): its briefs and asks show there. */
  discordLinks?: DiscordLoomLinkReader;
  /** First reconnect wait; doubles per failure up to maxRetryMs (defaults 1 s and 30 s). */
  retryMs?: number;
  maxRetryMs?: number;
}

// Loom's rows, only the fields read here (packages/loom/src/store.ts).
/** A thread as /snapshot lists it, with its account: what Capacity reads. */
export interface LoomThreadRow {
  id: string;
  kind?: string;
  title: string | null;
  repo?: string | null;
  cwd: string;
  status: 'idle' | 'running' | 'waiting' | 'stopped';
  /** The provider it runs on ('claude' | 'codex'); account names are only unique within one. */
  provider?: string;
  /** The account it runs on now (a Loom account name); null before its first turn. */
  account: string | null;
  /** The accounts it may ever run on (JSON array of names), or null for any. */
  accounts: string | null;
  updated_at: number;
  settled_at: number | null;
}
interface LoomThread {
  discussing?: Array<{ id: string; ask: string; since: number; runId?: string | null }>;
  worktree_branch?: string | null;
  closingHandoff?: DeskFacts['handoff'];
  heartbeatAt?: number | null;
  sourceHealth?: DeskFacts['sourceHealth'];
  account?: string | null;
  /** Why Loom is holding this thread's next turn ("waiting_for_room", or a specific reason); null: not held. */
  admission?: string | null;
  /** When an account-limit hold clears, when Loom knows it. */
  admission_until?: number | null;
  /** Loom's maintenance switch: no new turns start while it is on. */
  maintenance?: boolean;
  id: string;
  kind?: string;
  title: string | null;
  cwd: string;
  /** The checkout the thread works on (its worktree's repo); older Loom threads have none. */
  repo?: string | null;
  status: 'idle' | 'running' | 'waiting' | 'stopped';
  /** JSON array of the background tasks still running in the session; null or absent (older Loom): none. */
  background?: string | null;
  /** JSON open ask (the agent closed a turn with "Next — you", unanswered); null: none. Absent: an older Loom. */
  ask?: string | null;
  ask_record?: (NonNullable<DeskFacts['askLedger']> & { created_at: number; audience: string; who: string; message_id?: string; run_id?: string }) | null;
  /** The newest open decision brief (decision_request); null: none. Absent: an older Loom. */
  decision?: LoomDecision | null;
  /** The last model call's context and today's input tokens (loom-context-management); null: no calls yet. Absent: an older Loom. */
  context?: { tokens: number; at: number; today: number; callsToday: number; day?: number } | null;
  /** 1: the owner kept this session ("Keep this session"). Absent: an older Loom. */
  fresh_opt_out?: number | null;
  /** Today's daily budget (budget.ts). Absent: an older Loom. */
  budget?: { limit: number; base: number; today: number; raised: number; share: number; resetsAt: number } | null;
  /** Its role and owner (older Loom: absent). */
  role?: string;
  parent_thread_id?: string | null;
  created_at: number;
  updated_at: number;
  settled_at: number | null;
}
interface LoomRun {
  answers_run_id?: string;
  wake_cause?: 'trigger' | 'corrective' | null;
  id: string;
  status: 'queued' | 'running' | 'completed' | 'interrupted' | 'failed' | 'canceled';
  source?: string;
  text?: string;
  failure: string | null;
  started_at: number | null;
  ended_at: number | null;
}
interface LoomBriefOption { key: string; label: string; consequence: string; recommended?: boolean }
export interface LoomDecision {
  window_from?: number | null;
  discussing_since?: number | null; unaddressed_at?: number | null; discussed?: number;
  run_id?: string | null;
  id: string;
  class: string;
  level: number;
  candidate: number;
  status: string;
  ask: string;
  created_at: number;
  /** The option the owner or a default chose, and the owner's own words, once resolved. */
  answer_option?: string | null;
  decided_by?: string | null;
  resolved_at?: number | null;
  /** Phase 3: how the owner's answer counts (always / next-time / once) and the rule it made, if any. */
  rule_choice?: string | null;
  rule_id?: string | null;
  rule?: { id: string; state: string; scope: string; do: string } | null;
  /** D-61: the answer counts as a precedent; a rule two similar approvals propose (JSON); the precedent a brief matched. */
  precedent?: number;
  proposal?: string | null;
  precedent_of?: string | null;
  answer_text?: string | null;
  /** Level 3: the veto window and how much of it the owner's active time has used (Loom presence). */
  veto?: { window_ms: number; active_ms: number; left_ms: number } | null;
  /** Revised in place (decision.update, TGO-1079): 1 as raised, and each change since. Absent: an older Loom. */
  revision?: number;
  changes?: Array<{ revision: number; at: number; by: string; by_title: string | null; what: string; why: string; material: boolean; told?: string[] }>;
  /** The brief page (GET /decisions/:id): where it was raised, and how it closed. */
  thread_id?: string;
  decided_in?: string | null;
  answer_reason?: string | null;
  raised_on?: { id: string; title: string | null } | null;
  decided_on?: { id: string; title: string | null } | null;
  brief: {
    about?: string;
    door: 'one-way' | 'two-way';
    blast: 'private' | 'team' | 'public';
    standing: string;
    background: string;
    options: LoomBriefOption[];
    assets?: Array<{ kind: string; title: string; url: string }>;
    deadline?: string;
    default?: string;
    proposedRule?: string;
    tripwire?: string;
    confidence?: string;
    changeMyMind?: string;
  };
}

interface LoomRequest {
  id: string;
  kind: 'question' | 'plan';
  payload: string;
  status: 'open' | 'answered' | 'expired';
  created_at: number;
}
/** A tool call Loom recorded (input capped, so it may be cut-off JSON). */
interface LoomItem {
  id: string;
  run_id?: string | null;
  name: string;
  input: string | null;
  status: 'running' | 'completed' | 'failed';
  created_at: number;
  updated_at: number;
}
interface LoomDetail {
  openedPrUrls?: string[];
  legacyPrCreates?: Array<{ id: string; at: number }>;
  lastPrMergeAt?: number | null;
  thread: LoomThread;
  decisions?: LoomDecision[];
  runs: LoomRun[];
  items?: LoomItem[];
  messages: Array<{
    id: string;
    run_id?: string | null;
    role: 'user' | 'assistant';
    command_id?: string | null;
    text: string;
    created_at: number;
    origin?: string | null;
    attachments?: Array<{ id: string; name: string; mime_type: string; size_bytes: number }>;
  }>;
  requests: LoomRequest[];
  /** Durable waits still open (Loom wait_for); absent from an older Loom. */
  waits?: Array<{ id: string; kind: string; note: string; target?: string; prUrl?: string; due_at?: number | null; text?: string; created_at?: number; expires_at?: number; last_checked_at?: number | null; last_error?: string | null; consecutive_errors?: number; error_since?: number | null }>;
  /** The session's background tasks with their start times; absent from an older Loom (then `thread.background`). */
  tasks?: Array<{ url?: string; id: string; kind: string; description: string; ambient?: boolean; started_at: number | null }>;
  /** The latest handoff the thread saved for its next session (loom.save_handoff); absent from an older Loom. */
  handoff?: { body: string; created_at: number } | null;
}

/** A plan exit, asked as one question: the Approve chip, or changes (free text is the feedback). */
const PLAN_ID = 'plan';
const APPROVE = 'Approve';
const REQUEST_CHANGES = 'Request changes';
const PLAN_QUESTION: PendingQuestion = {
  id: PLAN_ID,
  header: 'Plan',
  question: 'Approve this plan?',
  options: [
    { label: APPROVE, description: 'Start on it as written' },
    { label: REQUEST_CHANGES, description: 'Say what to change under Other…' },
  ],
  multiSelect: false,
};

/** Loom's refusal codes, as the owner reads them. */
const REFUSALS: Record<string, string> = {
  not_found: 'Loom no longer has this thread',
  stopped: 'this thread was stopped in Loom',
  not_open: 'Loom is no longer waiting on that question',
  not_resumable: 'the Loom session that asked is gone',
  changed: 'that turn already finished, so nothing was stopped',
  unauthorized: "Loom refused the desk's token",
};

const TASK_KINDS: Record<string, InFlight['kind']> = { local_bash: 'shell', local_agent: 'agent', monitor: 'monitor', workflow: 'workflow', fan_out: 'agent' };

/**
 * What is in flight behind a thread, for the row and the thread page: the background tasks (oldest first),
 * then the waits. A wait's text is the agent's note, else Loom's own description of it.
 */
export function inFlightOf(thread: Pick<LoomThread, 'background'>, detail: Pick<LoomDetail, 'tasks' | 'waits'>): InFlight[] {
  const tasks = detail.tasks ?? (parse<Array<{ id: string; kind?: string; description?: string; ambient?: boolean }>>(thread.background ?? null) ?? []).map((t) => ({ ...t, started_at: null }));
  const out: InFlight[] = tasks.map((t) => ({
    kind: TASK_KINDS[t.kind ?? ''] ?? 'task',
    text: line(t.description || t.kind || 'background task'),
    since: t.started_at ?? null,
    ...("url" in t && typeof t.url === "string" && /^(?:\/artifacts\/|https?:\/\/)/.test(t.url) ? { url: t.url } : {}),
    ...(t.ambient ? { watcher: true } : {}),
  }));
  for (const w of detail.waits ?? []) {
    if (w.kind === "fan_out" && tasks.some(t => t.kind === "fan_out")) continue;
    out.push({ kind: 'wait', waitKind: w.kind, text: line(w.note?.trim() || w.text || `waiting (${w.kind})`), since: w.created_at ?? null, until: w.expires_at ?? null, ...(w.last_error ? { error: line(w.last_error) } : {}) });
  }
  return out;
}

/** One line of at most 160 characters. */
const line = (text: string) => clip(text.replace(/\s+/g, ' ').trim(), 160);

/**
 * What a finished turn left running, as T3 says it (backgroundLiveness): work that will wake the thread
 * (`working`), or only monitors left (`monitoring`). Null: nothing, or a Loom that doesn't say.
 */
export function backgroundOf(thread: Pick<LoomThread, 'background'>): DeskFacts['background'] {
  const tasks = parse<Array<{ kind?: string; ambient?: boolean }>>(thread.background ?? null);
  if (!Array.isArray(tasks) || tasks.length === 0) return null;
  // Watchers (the harness's ambient tasks, monitors) wake the agent but aren't work: the turn isn't done, it's watching.
  return tasks.every((task) => task.ambient || task.kind === 'monitor') ? 'monitoring' : 'working';
}

/** Every brief the thread holds open: Loom shows one as `thread.decision`, the rest are in its decisions. */
export function openBriefCount(thread: Pick<LoomThread, 'decision'>, detail: Pick<LoomDetail, 'decisions'>): number {
  return Math.max(thread.decision ? 1 : 0, (detail.decisions ?? []).filter((entry) => entry.status === 'open' && entry.discussing_since == null).length);
}

/** Loom's open ask, as the desk keeps it: the words, when the agent asked, and who it is for when not the owner. */
export function askOf(raw: string | null, record?: LoomThread['ask_record']): DeskFacts['openAsk'] {
  if (record) {
    if (record.kind === 'pointer' || record.status !== 'open') return null;
    const fact = ledgerAskOf(record)!;
    const pointer = parse<{ to?: string }>(raw);
    return record.audience === 'agent' && pointer?.to ? { ...fact, to: pointer.to } : fact;
  }
  const ask = parse<NonNullable<DeskFacts['openAsk']>>(raw);
  return ask && typeof ask.at === 'number' ? { text: typeof ask.text === 'string' ? ask.text : '', at: ask.at, ...(ask.to ? { to: ask.to } : {}), ...(ask.messageId ? { messageId: PREFIX + ask.messageId } : {}), ...(ask.runId ? { runId: ask.runId } : {}), ...(ask.id ? { id: ask.id, kind: ask.kind, status: ask.status, steps: ask.steps, due: ask.due, class: ask.class, revision: ask.revision, points_to: ask.points_to, legacy: ask.legacy } : {}) } : null;
}

export function ledgerAskOf(record: LoomThread['ask_record']): DeskFacts['askLedger'] {
  if (!record) return null;
  return { id: record.id, text: record.text, at: record.created_at, kind: record.kind, status: record.status,
    steps: record.steps, due: record.due, class: record.class, points_to: record.points_to,
    revision: record.revision, legacy: record.legacy, resolved_at: record.resolved_at,
    ...(record.audience === 'agent' ? { to: record.who } : {}),
    ...(record.message_id ? { messageId: PREFIX + record.message_id } : {}), ...(record.run_id ? { runId: record.run_id } : {}) };
}

const parse = <T>(raw: string | null): T | null => {
  try {
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};

/** A failed run's reason: a usage limit reads as one, with its reset when Loom knows it. */
/**
 * Why Loom is holding the next turn, when it is: its admission (no room: disk, memory, sessions; or a named reason),
 * its maintenance switch, or a run put back in the queue on an account limit (with its reset). A message waiting on
 * a known hold is held, not failed (10/19: Loom held every new turn on low disk and the desk said Failed).
 */
export function heldOf(thread: Pick<LoomThread, 'admission' | 'admission_until' | 'maintenance'> & { status?: LoomThread['status'] }, runs: Array<Pick<LoomRun, 'status' | 'failure'>>): DeskFacts['held'] {
  if (thread.admission) return { reason: thread.admission, until: thread.admission_until ?? null };
  const limited = runs.find((run) => run.status === 'queued' && parse<{ kind?: string }>(run.failure)?.kind === 'usage_limit');
  if (limited) return { reason: 'account_limit', until: parse<{ resetAt?: number }>(limited.failure)?.resetAt ?? null };
  if (thread.maintenance && runs.some((run) => run.status === 'queued')) return { reason: 'maintenance', until: null };
  // A run Loom has queued while the thread is idle: it starts it shortly (a mail hold, a moment's wait for room).
  // It waits; it hasn't failed (10/19).
  if (thread.status === 'idle' && runs.some((run) => run.status === 'queued')) return { reason: 'queued', until: null };
  return null;
}

function failureOf(run: LoomRun): NonNullable<DeskFacts['failed']> {
  const failure = parse<{ kind?: string; message?: string; resetAt?: number }>(run.failure) ?? {};
  const message = failure.message?.trim() || 'The turn failed';
  const text =
    failure.kind === 'usage_limit'
      ? `Usage limit reached${failure.resetAt ? ` (resets ${new Date(failure.resetAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })})` : ''}: ${message}`
      : message;
  return { at: run.ended_at ?? run.started_at ?? 0, reason: failure.kind ?? 'error', message: text, turnId: run.id };
}

/** An open Loom request as the desk's question card takes it. */
export function loomPending(request: LoomRequest): PendingRequest {
  const payload = parse<{ questions?: unknown }>(request.payload) ?? {};
  const questions = request.kind === 'plan' ? [PLAN_QUESTION] : parseQuestions(payload.questions);
  const first = questions[0];
  return {
    kind: 'question',
    requestId: request.id,
    questions,
    question: !first ? 'Input needed' : questions.length > 1 ? `${first.question} (+${questions.length - 1} more)` : first.question,
    options: (first?.options ?? []).map((option) => option.label).slice(0, 8),
    at: request.created_at,
  };
}

/** The one question a brief asks: its options as chips, the recommended one marked; free text is the owner's own answer. */
const BRIEF_QUESTION = 'decision';
const briefLabel = (option: LoomBriefOption) => `${option.key} · ${option.label}${option.recommended ? ' (Recommended)' : ''}`;

/**
 * How the owner's recent answers on this thread count as rules (decisions phase 3): shown on each answered brief
 * ("Saved as R-12 · Undo"), where the choice can still change. Empty when no answer of theirs proposed a rule.
 */
export function savedRules(decisions: LoomDecision[]): DeskRuleSaved[] {
  // The owner's latest answers that proposed a rule, newest first: each keeps its own controls (the page shows a week's).
  return decisions
    .filter((d) => d.status === 'answered' && (d.decided_by === 'person' || d.decided_by === 'person-chat') && d.rule_choice && d.brief.proposedRule && !d.brief.tripwire)
    .sort((a, b) => (b.resolved_at ?? 0) - (a.resolved_at ?? 0))
    .slice(0, 5)
    .map(savedRuleOf);
}

function savedRuleOf(answered: LoomDecision): DeskRuleSaved {
  const rule = answered.rule ?? null;
  return {
    decisionId: answered.id,
    ask: answered.ask,
    choice: answered.rule_choice as DeskRuleSaved['choice'],
    ruleId: rule?.id ?? null,
    ruleState: rule?.state ?? null,
    text: rule ? `for ${rule.scope}, ${rule.do}` : answered.brief.proposedRule!,
    at: answered.resolved_at ?? answered.created_at,
    precedent: answered.precedent === 1,
    proposal: (() => {
      const p = answered.proposal ? (JSON.parse(answered.proposal) as { text: string; from: string[]; state: string }) : null;
      return p ? { text: p.text, from: p.from, state: p.state as 'proposed' | 'made' | 'dismissed' } : null;
    })(),
  };
}

/** An open decision brief as the desk's question card takes it: answered with decision.answer, not a live-turn answer. */
export function loomBriefPending(decision: LoomDecision): PendingRequest {
  const b = decision.brief;
  const options = b.options.map((option) => ({ label: briefLabel(option), description: option.consequence }));
  return {
    kind: 'question',
    requestId: `${BRIEF_PREFIX}${decision.id}`,
    runId: decision.run_id,
    questions: [{ id: BRIEF_QUESTION, header: 'Your options', question: decision.ask, options, multiSelect: false, allowCustomAnswer: true }],
    question: decision.ask,
    options: options.map((option) => option.label),
    at: Math.max(decision.created_at, decision.window_from ?? 0, decision.unaddressed_at ?? 0),
    brief: {
      id: decision.id,
      unaddressedAt: decision.unaddressed_at ?? null,
      discussingSince: decision.discussing_since ?? null,
      class: decision.class,
      level: decision.level,
      candidate: decision.candidate === 1,
      door: b.door,
      blast: b.blast,
      about: b.about,
      standing: b.standing,
      background: b.background,
      assets: b.assets ?? [],
      deadline: b.deadline ?? null,
      defaultOption: decision.level === 3 ? b.default ?? null : null,
      vetoLeftMs: decision.veto ? decision.veto.left_ms : null,
      vetoWindowMs: decision.veto ? decision.veto.window_ms : null,
      optionKeys: b.options.map((option) => option.key),
      proposedRule: b.proposedRule ?? null,
      // D-61: an earlier approval of the same kind; approving this one the same way proposes a rule.
      precedentOf: decision.precedent_of ?? null,
      // A tripwire never becomes a rule, so the card offers no rule chips for it.
      tripwire: b.tripwire ?? null,
      confidence: b.confidence ?? null,
      changeMyMind: b.changeMyMind ?? null,
      ...(decision.revision !== undefined ? { revision: decision.revision, updated: briefUpdated(decision) } : {}),
    },
  };
}
/** A brief's latest revision, as the card's "Updated · when · what changed" (TGO-1079); null: as raised. */
function briefUpdated(decision: LoomDecision): { at: number; what: string; why: string } | null {
  const last = decision.changes?.at(-1);
  return last ? { at: last.at, what: last.what, why: last.why } : null;
}
/** Refused because the brief was revised since the owner saw it: the card shows the new one, and nothing was sent. */
const updatedSince = (decision: Pick<LoomDecision, 'changes'> | null | undefined) => {
  const what = decision?.changes?.at(-1)?.what;
  return `${QUESTION_CHANGED}: it was updated since you looked${what ? ` (${what})` : ''}`;
};
export const BRIEF_PREFIX = 'decision:';

/** Latest persisted formal answer; chat discussions are never inferred to be answers. */
export function answeredBrief(decisions: LoomDecision[]): DeskFacts['answeredBrief'] {
  const latest = decisions.filter(d => d.status === 'answered' && d.decided_by === 'person' && d.resolved_at != null)
    .sort((a, b) => b.resolved_at! - a.resolved_at!)[0];
  return latest ? { id: latest.id, choice: settledChoice(latest), at: latest.resolved_at! } : null;
}

/** What a settled brief came to, as a line: the option with its label, and the owner's own words (Codex review on #781). */
export function settledChoice(row: Pick<LoomDecision, 'answer_option' | 'answer_text' | 'brief'>): string {
  const option = row.answer_option ? row.brief.options.find((entry) => entry.key === row.answer_option) : undefined;
  const chose = row.answer_option ? (option ? `${option.key} · ${option.label}` : row.answer_option) : '';
  const words = row.answer_text?.trim() ? `“${row.answer_text.trim()}”` : '';
  return chose && words ? `${chose} (${words})` : chose || words;
}

/** The owner's answer to a brief: a chip is its option; anything else is their own words. */
export function briefAnswer(decision: LoomDecision, answers: Record<string, string | string[]>): { option: string | null; text: string | null } {
  const said = [answers[BRIEF_QUESTION] ?? ''].flat()[0]?.trim() ?? '';
  const option = decision.brief.options.find((entry) => briefLabel(entry) === said || entry.key === said);
  return option ? { option: option.key, text: null } : { option: null, text: said || null };
}

/** The answer Loom hands the harness: AskUserQuestion's `answers` by question text, or a plan decision. */
function loomAnswer(request: LoomRequest, answers: Record<string, string | string[]>): unknown {
  if (request.kind === 'plan') {
    const said = [answers[PLAN_ID] ?? ''].flat()[0] ?? '';
    if (said === APPROVE) return { approve: true };
    return said && said !== REQUEST_CHANGES ? { approve: false, feedback: said } : { approve: false };
  }
  return { answers: Object.fromEntries(Object.entries(answers).map(([question, answer]) => [question, Array.isArray(answer) ? answer.join(', ') : answer])) };
}

/** Loom said no (a 4xx with its code), or never answered (unknown: the command may have landed). */
/** What leads wrote for the owner's catch-up (GET /catchup): desk_update lines and chapter notes, paged by seq. */
export interface LeadCatchup {
  updates: Array<{ id: string; seq: number; thread_id: string; kind: 'needs' | 'failed' | 'decided' | 'shipped' | 'fyi'; title: string; detail: string | null; moment: number | null; refs: Array<{ label: string; url: string }>; shot: string | null; supersedes: string | null; covers_from: number | null; covers_to: number | null; created_at: number }>;
  notes: Array<{ id: string; seq: number; thread_id: string; headline: string | null; status: string | null; created_at: number }>;
  last: number;
  more: boolean;
}

/** A decision Loom made for the owner, or let run by default (GET /decisions). */
export interface LoomDecided {
  id: string;
  thread_id: string;
  thread_title: string | null;
  class: string;
  level: number;
  status: 'acted' | 'defaulted';
  decided_by: string | null;
  summary: string;
  undo: string | null;
  ref: string | null;
  at: number;
  reversed_at: number | null;
  reversal: 'undo' | 'disagree' | null;
  reversal_note: string | null;
}

/** What the learning loop changed (GET /decisions `rules`): a new rule, a suspension, a class demoted or restored. */
export interface LoomRuleEvent {
  id: string;
  kind: 'rule-created' | 'rule-suspended' | 'rule-retired' | 'rule-withdrawn' | 'rule-superseded' | 'rule-restored' | 'rule-reaffirmed' | 'class-demoted' | 'class-restored';
  at: number;
  rule: string | null;
  class: string;
  decision: string | null;
  thread_id: string | null;
  from_level: number | null;
  to_level: number | null;
  text: string;
  /** rule-created: how the owner's answer counts now (they can change it from the card). */
  rule_choice: 'always' | 'next-time' | 'once' | null;
  state: string | null;
}

/** The weekly Delegation review (GET /decisions/review). */
export interface LoomReview {
  since: number;
  until: number;
  created: Array<{ at: number; rule: string | null; class: string; decision: string | null; text: string }>;
  suspended: Array<{ at: number; kind: string; rule: string | null; class: string; text: string }>;
  demoted: Array<{ at: number; kind: string; class: string; from_level: number | null; to_level: number | null; text: string }>;
  due: Array<{ id: string; class: string; scope: string; do: string; review_at: number | null }>;
  dissent: Array<{ class: string; rule: string | null; count: number; notes: Array<{ decision: string; text: string; at: number }> }>;
}

type Sent = { ok: true; result?: { threadId?: string; runId?: string; rule?: string | null; ruleState?: string | null } } | { ok: false; error: string; code?: string; unknown?: boolean };

/** A new thread from Start work: in a fresh worktree off origin's default branch, or in the checkout itself. */
export interface LoomStart {
  commandId: string;
  text: string;
  title?: string;
  repoPath: string;
  mode: 'auto' | 'worktree' | 'local';
  sameTree?: boolean;
  /** The account to start on (a T3 instance id; Loom knows them as aliases). */
  account?: string;
  /** The only accounts this thread may run on, as the owner's policy allows the repo. */
  accounts?: string[];
  accountsFrom?: "policy";
  /** The title is only the prompt's first sentence: Loom names the thread itself, as T3 does. */
  autoTitle?: boolean;
  /** Images for the first message, as the sheet sends them (data URLs). */
  attachments?: StartAttachment[];
  /** Who it works for, and its owner as a desk item id (roles.ts). */
  role?: ThreadRole;
  tier?: string;
  parentThreadId?: string;
}

export class DeskLoomSource implements DeskSourceAdapter {
  private readonly log: Log;
  /** The last change sequence filed; null until the first snapshot. */
  private seq: number | null = null;
  private readonly dirty = new Set<string>();
  /** The newest Loom thread each scheduled job ran in, by its title: only that one says whether the job is held. */
  private readonly jobThreads = new Map<string, { threadId: string; createdAt: number }>();
  private readonly threadAccounts = new Map<string, string | null>();
  /** Tango agent threads with an open record whose Discord row isn't filed yet: read again on the health tick. */
  private readonly unlinked = new Set<string>();

  /** Read-only cache from the change stream’s existing reads; no requests per desk row. */
  accounts(): ReadonlyMap<string, string | null> {
    return this.threadAccounts;
  }
  private draining: Promise<void> | null = null;
  private running = false;
  private abort: AbortController | null = null;
  private wake: (() => void) | null = null;

  constructor(private readonly options: DeskLoomOptions) {
    this.log = options.log ?? (() => {});
  }

  private get core(): DeskCore {
    return this.options.core;
  }

  owns(item: DeskItemRow): boolean {
    return item.source === 'loom';
  }

  private healthTimer?: ReturnType<typeof setInterval>;
  /** A read that failed marks the row's source unhealthy; never after stop() (the store may be closed). */
  private markUnhealthy(threadId: string, err: unknown): void {
    const item = this.core.item(PREFIX + threadId);
    // Already unhealthy: keep the first failure's `at` (it reads "since").
    if (!this.running || !item || item.facts.sourceHealth?.ok === false) return;
    try { this.core.setFacts(PREFIX + threadId, { sourceHealth: { ok: false, at: Date.now(), detail: (err as Error).message } }); this.core.flush(); }
    catch (e) { this.log('desk.loom.health.error', { threadId, message: (e as Error).message }); }
  }
  /** An authenticated read: /health answers without the token, so a missing or refused token would read healthy. */
  private async readable(): Promise<{ ok: boolean; detail: string | null }> {
    try {
      const { status } = await this.call('/capacity', { signal: AbortSignal.timeout(1500) });
      if (status === 401 || status === 403) return { ok: false, detail: REFUSALS.unauthorized ?? 'Loom refused the token' };
      return status < 500 ? { ok: true, detail: null } : { ok: false, detail: `Loom answered ${status}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message === 'Loom has no token' ? 'Loom has no token' : 'Loom host unreachable' };
    }
  }
  private async refreshHealth(): Promise<void> {
    const { ok, detail } = await this.readable();
    if (!this.running) return;
    const at = Date.now();
    try {
      // Written only when readability changes, so `at` reads "since" and a steady Loom costs no writes.
      let changed = false;
      for (const item of this.core.items()) if (item.source === 'loom' && item.facts.sourceHealth?.ok !== ok) {
        this.core.setFacts(item.id, { sourceHealth: { ok, at, detail } });
        changed = true;
      }
      if (changed) this.core.flush();
    } catch (e) { this.log('desk.loom.health.error', { message: (e as Error).message }); }
  }

  /** Follows Loom's change stream until stop(). Until Loom has written its token, it waits for one. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.follow();
    this.healthTimer = setInterval(() => { void this.refreshHealth(); this.relink(); }, 30_000);
    this.healthTimer.unref?.();
  }

  stop(): void {
    this.running = false;
    clearInterval(this.healthTimer);
    this.abort?.abort();
    this.wake?.();
  }

  /** Files every Loom item again: the workspaces they belong to changed (T3's projects loaded or moved). */
  refile(): void {
    for (const item of this.core.items()) {
      if (item.source === 'loom' && item.disposition !== 'done') this.dirty.add(item.id.slice(PREFIX.length));
    }
    if (this.dirty.size) this.drain();
  }

  /** Resolves once every thread named so far has been filed (tests, and a clean stop). */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private token(): string | null {
    try {
      return fs.readFileSync(this.options.tokenFile, 'utf8').trim() || null;
    } catch {
      return null;
    }
  }

  private async call(pathname: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<{ status: number; body: any }> {
    const token = this.token();
    if (!token) throw new Error('Loom has no token');
    const response = await fetch(new URL(pathname, this.options.url), {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: init.signal ?? AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  private health: { at: number; ok: Promise<boolean> } | null = null;
  /** Loom answers /health (cached 15 s): Start work makes it the default only then. */
  reachable(): Promise<boolean> {
    if (!this.health || Date.now() - this.health.at > 15_000) {
      const ok = fetch(new URL('/health', this.options.url), { signal: AbortSignal.timeout(1500) })
        .then((response) => response.ok)
        .catch(() => false);
      this.health = { at: Date.now(), ok };
    }
    return this.health.ok;
  }

  /** Loom's GET /capacity; null when Loom can't be read or predates it. */
  async capacity(): Promise<LoomCapacity | null> {
    try {
      const { status, body } = await this.call('/capacity');
      return status === 200 && Array.isArray(body?.accounts) ? (body as LoomCapacity) : null;
    } catch {
      return null;
    }
  }

  /** Moves a thread to another account at its next safe point (Loom refuses one outside its allowed set). */
  async move(itemId: string, account: string, commandId: string, allow = false): Promise<{ ok: true } | { ok: false; error: string }> {
    const threadId = itemId.slice(PREFIX.length);
    try {
      const { status, body } = await this.call(`/threads/${encodeURIComponent(threadId)}/move`, { method: 'POST', body: { account, commandId, ...(allow ? { allow: true } : {}) } });
      if (status === 200 && body?.ok !== false) return { ok: true };
      return { ok: false, error: body?.code === 'invalid' ? `this thread may not run on that account${body?.message ? ` (${body.message})` : ''}` : REFUSALS[body?.code] ?? body?.message ?? `Loom answered ${status}` };
    } catch (err) {
      return { ok: false, error: `Loom isn't answering (${(err as Error).message})` };
    }
  }

  /** A thread's accounts over time: where it started, and each move (a limit, a sign-in, the owner). */
  async accountHistory(itemId: string): Promise<Array<{ account: string; at: number; reason: string }> | null> {
    try {
      const { status, body } = await this.call(`/threads/${encodeURIComponent(itemId.slice(PREFIX.length))}/accounts`);
      return status === 200 && Array.isArray(body) ? body : null;
    } catch {
      return null;
    }
  }

  /** Acted and defaulted decisions since `since` ("Decided for you", GET /decisions); null when Loom can't be read. */
  async decided(since: number): Promise<{ decisions: LoomDecided[]; more: boolean; rules: LoomRuleEvent[] } | null> {
    try {
      const { status, body } = await this.call(`/decisions?since=${Math.max(1, Math.floor(since))}`);
      // An older Loom has no rules yet: none.
      return status === 200 && Array.isArray(body?.decisions) ? { decisions: body.decisions as LoomDecided[], more: body.more === true, rules: Array.isArray(body.rules) ? (body.rules as LoomRuleEvent[]) : [] } : null;
    } catch {
      return null;
    }
  }

  /** What leads wrote for the owner's catch-up after a seq (GET /catchup); null when Loom can't be read (or is older). */
  async catchup(after: number): Promise<LeadCatchup | null> {
    try {
      const { status, body } = await this.call(`/catchup?after=${Math.max(0, Math.floor(after))}`);
      return status === 200 && Array.isArray(body?.updates) && Array.isArray(body?.notes) ? (body as LeadCatchup) : null;
    } catch {
      return null;
    }
  }

  /** The numbers of the decisions Loom has (the ids that become links); null when it can't be read. */
  async decisionIds(): Promise<number[] | null> {
    try {
      const { status, body } = await this.call('/decisions/ids');
      return status === 200 && Array.isArray(body?.ids) ? (body.ids as number[]) : null;
    } catch {
      return null;
    }
  }

  /** One decision with its brief, revisions and outcome (the brief page); undefined when Loom has no such decision, null when it can't be read. */
  async decision(id: string): Promise<LoomDecision | undefined | null> {
    try {
      const { status, body } = await this.call(`/decisions/${encodeURIComponent(id)}`);
      if (status === 404) return undefined;
      return status === 200 && body?.id === id ? (body as LoomDecision) : null;
    } catch {
      return null;
    }
  }

  /** The owner reverses a decision made for them: "I wouldn't have", or Undo, which wakes its thread. */
  async reverseDecision(decisionId: string, undo: boolean, note: string | null, commandId: string): Promise<{ ok: true } | { ok: false; error: string; unknown?: boolean }> {
    const sent = await this.send({ type: 'decision.reverse', commandId, decisionId, undo, ...(note ? { note } : {}) });
    // Unknown: Loom may have applied it; a retry with the same command id replays its receipt.
    return sent.ok ? { ok: true } : { ok: false, error: sent.error, ...(sent.unknown ? { unknown: true } : {}) };
  }

  /** Fine by me on something decided for the owner (catch-up): recorded for the learning loop. */
  async confirmDecision(decisionId: string, commandId: string): Promise<{ ok: true } | { ok: false; error: string; unknown?: boolean }> {
    const sent = await this.send({ type: 'decision.confirm', commandId, decisionId });
    return sent.ok ? { ok: true } : { ok: false, error: sent.error, ...(sent.unknown ? { unknown: true } : {}) };
  }

  /** The owner changes how an answered brief counts: Always (makes its rule), Ask me next time, or Just this once. */
  async ruleDecision(decisionId: string, rule: 'always' | 'next-time' | 'once', reason: string | null, commandId: string, proposal: string | null = null): Promise<{ ok: true; rule: string | null; ruleState: string | null } | { ok: false; error: string; unknown?: boolean }> {
    const sent = await this.send({ type: 'decision.rule', commandId, decisionId, rule, ...(reason ? { reason } : {}), ...(proposal ? { proposal } : {}) });
    return sent.ok ? { ok: true, rule: sent.result?.rule ?? null, ruleState: sent.result?.ruleState ?? null } : { ok: false, error: sent.error, ...(sent.unknown ? { unknown: true } : {}) };
  }

  /** The owner read the review: the rules it showed as due move to their next review. */
  async reviewedRules(ruleIds: string[], commandId: string): Promise<{ ok: true } | { ok: false; error: string; unknown?: boolean }> {
    const sent = await this.send({ type: 'rules.reviewed', commandId, ruleIds });
    return sent.ok ? { ok: true } : { ok: false, error: sent.error, ...(sent.unknown ? { unknown: true } : {}) };
  }

  /** The weekly Delegation review since `since`; null when Loom can't be read (or is older than phase 3). */
  async review(since: number): Promise<LoomReview | null> {
    try {
      const { status, body } = await this.call(`/decisions/review?since=${Math.max(1, Math.floor(since))}`);
      return status === 200 && Array.isArray(body?.created) ? (body as LoomReview) : null;
    } catch {
      return null;
    }
  }

  /** Every Loom thread with the account it runs on (the Capacity page); null when Loom can't be read. */
  async threads(): Promise<LoomThreadRow[] | null> {
    try {
      const { status, body } = await this.call('/snapshot');
      return status === 200 && Array.isArray(body?.threads) ? (body.threads as LoomThreadRow[]).filter((thread) => thread.kind !== "tango-agent" && thread.kind !== "tango-job" && thread.kind !== "probe") : null;
    } catch {
      return null;
    }
  }

  // ── the change stream ──────────────────────────────────────────────────

  private async follow(): Promise<void> {
    let failures = 0;
    let waitingForToken = false;
    while (this.running) {
      // No token yet (Loom hasn't started here): nothing is sent; look again at the longest wait.
      if (!this.token()) {
        if (!waitingForToken) this.log('desk.loom.inert', { tokenFile: this.options.tokenFile });
        waitingForToken = true;
        await this.sleep(this.options.maxRetryMs ?? 30_000);
        continue;
      }
      waitingForToken = false;
      let connected = false;
      try {
        // A Loom whose log is behind ours started over (a new state dir): read it fresh.
        if (this.seq !== null) {
          const health = await fetch(new URL('/health', this.options.url), { signal: AbortSignal.timeout(5_000) }).then((response) => response.json() as Promise<{ seq?: number }>);
          if (typeof health.seq === 'number' && health.seq < this.seq) this.seq = null;
        }
        await this.stream(() => {
          connected = true;
          if (failures) this.log('desk.loom.connected', { after: this.seq });
          failures = 0;
        });
      } catch (err) {
        if (!this.running) break;
        failures += 1;
        // Once per outage, then every so often: a Loom that is simply off isn't news each retry.
        if (failures === 1 || failures % 20 === 0) this.log('desk.loom.stream.error', { message: (err as Error).message, failures });
      }
      // A stream that ended cleanly (Loom asked us to resume, or restarted) reconnects at once.
      if (this.running && !connected) await this.sleep(Math.min(this.options.maxRetryMs ?? 30_000, (this.options.retryMs ?? 1_000) * 2 ** Math.min(failures - 1, 10)));
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private async stream(onOpen: () => void): Promise<void> {
    this.abort = new AbortController();
    const query = this.seq === null ? '' : `?after=${this.seq}`;
    const token = this.token();
    if (!token) throw new Error('Loom has no token');
    const response = await fetch(new URL(`/events${query}`, this.options.url), { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal: this.abort.signal });
    if (!response.ok || !response.body) throw new Error(`Loom events: HTTP ${response.status}`);
    onOpen();
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length) this.onEvent(event, data.join('\n'));
      }
    }
  }

  private onEvent(event: string, data: string): void {
    const body = parse<Record<string, any>>(data);
    if (!body) return;
    if (event === 'snapshot') {
      // Too far behind for a replay (or the first connect): every thread is read again, and loom
      // items Loom no longer has were deleted while the desk wasn't listening.
      this.seq = Number(body.seq) || 0;
      const threads = new Set<string>((body.threads ?? []).map((thread: LoomThread) => thread.id));
      for (const id of threads) this.dirty.add(id);
      for (const item of this.core.items()) {
        if (item.source === 'loom' && item.disposition !== 'done' && !threads.has(item.id.slice(PREFIX.length))) this.dirty.add(item.id.slice(PREFIX.length));
      }
    } else if (event === 'change') {
      if (typeof body.seq === 'number') this.seq = Math.max(this.seq ?? 0, body.seq);
      if (typeof body.threadId === 'string') this.dirty.add(body.threadId);
    } else {
      // resume: Loom closes the stream next, and the reconnect replays from our sequence.
      // delta: streaming text, live only, never filed.
      return;
    }
    this.drain();
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = (async () => {
      while (this.dirty.size) {
        const threadId = this.dirty.values().next().value!;
        this.dirty.delete(threadId);
        try {
          await this.read(threadId);
        } catch (err) {
          this.log('desk.loom.thread.error', { threadId, message: (err as Error).message });
          this.markUnhealthy(threadId, err);
          // Read again shortly: a change already seen won't be sent twice.
          const timer = setTimeout(() => {
            this.dirty.add(threadId);
            this.drain();
          }, 5_000);
          timer.unref?.();
        }
      }
    })().finally(() => (this.draining = null));
  }

  /** Reads one thread and files it; gone from Loom (deleted) is done here. */
  /**
   * A scheduled job runs in Loom threads the desk doesn't list: its row is the schedule's. When the newest of them is
   * held (account limits, disk), the schedule row says so, rather than the scheduler's "timed out" reading as a
   * failure (10/19: a daily job pinned to an account under its floor waited days, shown as Failed).
   */
  private holdJob(thread: LoomThread, runs: LoomRun[]): void {
    const title = thread.title!;
    const known = this.jobThreads.get(title);
    if (known && known.threadId !== thread.id && known.createdAt > thread.created_at) return;
    this.jobThreads.set(title, { threadId: thread.id, createdAt: thread.created_at });
    recordJobHold(this.core, title, heldOf(thread, runs));
  }

  private async read(threadId: string): Promise<void> {
    const { status, body } = await this.call(`/threads/${encodeURIComponent(threadId)}`);
    if (status === 404) {
      const itemId = PREFIX + threadId;
      // Deleted with an open brief: a lead outside Loom still hears it went, before the record of it does (Codex review on #781).
      const previous = parse<{ pending: string | null; brief?: string | null }>(this.core.store.marker(`loom:${threadId}`));
      const decisionId = previous?.brief ?? (previous?.pending?.startsWith(BRIEF_PREFIX) ? previous.pending.slice(BRIEF_PREFIX.length) : null);
      if (decisionId) {
        const place = this.core.store.item(itemId)?.place ?? '';
        for (const carrier of this.core.takeCarriers(itemId, decisionId)) this.tellCarrier(carrier, itemId, decisionId, place.split(' · ').slice(1).join(' · ') || place || 'a Loom thread', null, 'the thread that raised it was deleted, so it is withdrawn');
      }
      this.threadAccounts.delete(itemId);
      this.core.store.deleteMarker(`loom:${threadId}`);
      this.unlinkDiscord(threadId);
      if (this.core.store.item(itemId)) this.core.settle(itemId, { done: true, summarize: false });
      return;
    }
    if (status !== 200) throw new Error(`Loom thread: HTTP ${status}`);
    const detail = body as LoomDetail;
    // Thread payloads hold only the open pointer. Read the known ledger row after
    // closure instead of inferring done from the disappearance of that pointer.
    if (detail.thread.ask_record === null) {
      const previous = this.core.store.item(PREFIX + threadId)?.facts.askLedger
        ?? this.core.items().find(i => i.facts.loomThreadId === threadId)?.facts.askLedger;
      if (previous?.id) {
        const ledger = await this.call(`/asks/${encodeURIComponent(previous.id)}`);
        if (ledger.status !== 200 && ledger.status !== 404) throw new Error(`Loom ask: HTTP ${ledger.status}`);
        if (ledger.status === 200) detail.thread.ask_record = ledger.body as LoomThread['ask_record'];
      }
    }
    this.ingest(detail);
  }

  /**
   * A Tango agent's Loom thread is never a desk row of its own (its Discord conversation is), so its records (an open
   * brief, a live question, a `Next — you` ask) are filed on the Discord row the owner reads: a Discord thread's row,
   * or in a home channel the chapter where the newest record was raised. They count once, there. `loomThreadId` says
   * whose records they are, so an answer on that row goes to Loom (core.ts resolvePending).
   */
  /** A Discord row filed after its agent's Loom thread was read: the open record finds it now (the health tick). */
  relink(): void {
    for (const threadId of this.unlinked) this.dirty.add(threadId);
    this.unlinked.clear();
    if (this.dirty.size) this.drain();
  }

  /** Only a row this thread still owns is cleared: a conversation moved to a newer Loom thread keeps that thread's records. */
  private clearLinked(itemId: string, threadId: string): boolean {
    if (this.core.store.item(itemId)?.facts.loomThreadId !== threadId) return false;
    this.core.setFacts(itemId, { pending: null, openBrief: null, openBriefCount: 0, discussing: [], openAsk: null, askLedger: null, loomThreadId: null });
    this.core.settle(itemId, { summarize: false });
    // Another thread filed here before (the conversation moved threads) may still have open records: read it again.
    const others = (parse<string[]>(this.core.store.marker(`loom-threads:${itemId}`)) ?? []).filter((id) => id !== threadId);
    if (others.length) {
      for (const id of others) this.dirty.add(id);
      queueMicrotask(() => this.drain());
    }
    return true;
  }

  /** A deleted Tango agent thread: its records leave the Discord row they were filed on. */
  private unlinkDiscord(threadId: string): void {
    const markerKey = `loom-link:${threadId}`;
    const previous = parse<{ itemId: string }>(this.core.store.marker(markerKey))?.itemId ?? null;
    this.unlinked.delete(threadId);
    this.core.store.deleteMarker(`loom-row:${threadId}`);
    if (!previous) return;
    this.core.store.deleteMarker(markerKey);
    if (this.clearLinked(previous, threadId)) this.core.flush();
  }

  private linkDiscord(detail: LoomDetail): void {
    const links = this.options.discordLinks;
    if (!links) return;
    const { core } = this;
    const { thread } = detail;
    const open = thread.status === 'waiting' ? detail.requests.filter((request) => request.status === 'open').at(-1) : undefined;
    const pending = open ? loomPending(open) : thread.decision ? loomBriefPending(thread.decision) : null;
    const openBrief = thread.decision ? loomBriefPending(thread.decision) : null;
    const openAsk = thread.ask === undefined ? null : askOf(thread.ask, thread.ask_record);
    const newest = Math.max(pending?.at ?? 0, openBrief?.at ?? 0, openAsk?.at ?? 0, ...(thread.discussing ?? []).map(brief => brief.since));
    const markerKey = `loom-link:${thread.id}`;
    const previous = parse<{ itemId: string }>(core.store.marker(markerKey))?.itemId ?? null;
    const chapterAt = (conversation: string, at: number): string | null => {
      const rows = core.store.items({ conversationKey: conversation }).filter(row => row.source === 'discord');
      const spoken = rows.map(row => ({ row, at: core.store.latestMessageBefore(row.id, at) })).filter(entry => entry.at !== null).sort((a, b) => b.at! - a.at!)[0]?.row;
      const echoed = spoken ? undefined : rows.map(row => ({ row, at: core.store.firstAgentMessageAfter(row.id, at) })).filter(entry => entry.at !== null && entry.at <= at + 60_000).sort((a, b) => a.at! - b.at!)[0]?.row;
      return (spoken ?? echoed ?? rows.filter(row => row.createdAt <= at).sort((a, b) => b.createdAt - a.createdAt)[0] ?? rows[0])?.id ?? null;
    };
    let target: string | null = null;
    if (newest) {
      const link = links.linkOf(thread.id);
      if (link?.conversation.startsWith('thread:')) {
        const id = `discord:${link.conversation}`;
        target = core.store.item(id) ? id : null;
      } else if (link) {
        // The chapter talking at the record's time, not whichever chapter is newest today.
        target = chapterAt(link.conversation, newest);
      }
      if (link && !target) this.unlinked.add(thread.id);
      // Read again on the health tick when the bot's database couldn't be read, or when it maps this thread nowhere yet
      // and the thread was never filed (its provider session may not be committed yet; Codex review on #932).
      if (link === undefined || (link === null && !core.store.marker(`loom-row:${thread.id}`))) this.unlinked.add(thread.id);
      // A conversation that moved to a newer Loom thread maps only that one: an older thread's still-open records go
      // back on the row they were on once the newer thread holds nothing there (clearLinked rereads it).
      if (!link) {
        const last = parse<{ itemId: string }>(core.store.marker(`loom-row:${thread.id}`))?.itemId ?? null;
        const owner = last ? core.store.item(last)?.facts.loomThreadId ?? null : null;
        if (last && core.store.item(last) && (!owner || owner === thread.id)) target = last;
      }
    }
    // A resolved brief no longer owns an active ask on the Discord row. Keep its receipt on the
    // row where it was raised, without keeping that Loom thread in charge of future asks.
    const receipt = answeredBrief(detail.decisions ?? []);
    const receiptRow = receipt ? detail.decisions?.find(decision => decision.id === receipt.id) : null;
    const receiptLink = receipt ? links.linkOf(thread.id) : null;
    const receiptMarker = receipt ? core.store.marker(`loom-brief-row:${receipt.id}`) : null;
    const receiptTarget = receiptMarker ?? (receiptLink?.conversation.startsWith('thread:') ? `discord:${receiptLink.conversation}`
      : receiptLink && receiptRow ? chapterAt(receiptLink.conversation, receiptRow.created_at) : null);
    if (receipt && receiptTarget) core.store.setMarker(`loom-brief-row:${receipt.id}`, receiptTarget);
    if (receipt && receiptTarget) {
      const row = core.store.item(receiptTarget);
      if (row && receipt.at >= (row.facts.answeredBrief?.at ?? 0)) core.setFacts(receiptTarget, { answeredBrief: receipt });
    }
    if (previous && previous !== target) this.clearLinked(previous, thread.id);
    if (target) {
      core.setFacts(target, { pending, openBrief, discussing: thread.discussing ?? [], openBriefCount: openBriefCount(thread, detail), openAsk, askLedger: ledgerAskOf(thread.ask_record), loomThreadId: thread.id });
      core.settle(target, { summarize: false });
      this.completedDiscussionReply(target, detail);
      core.store.setMarker(markerKey, JSON.stringify({ itemId: target }));
      if (thread.decision && !core.store.marker(`loom-brief-row:${thread.decision.id}`)) {
        const link = links.linkOf(thread.id);
        const raised = link?.conversation.startsWith('thread:') ? target : link ? chapterAt(link.conversation, thread.decision.created_at) : target;
        if (raised) core.store.setMarker(`loom-brief-row:${thread.decision.id}`, raised);
      }
      // Kept after the records close, so a closed brief's page still names the row it was on (routes.ts rowOf).
      core.store.setMarker(`loom-row:${thread.id}`, JSON.stringify({ itemId: target }));
      const threads = parse<string[]>(core.store.marker(`loom-threads:${target}`)) ?? [];
      if (!threads.includes(thread.id)) core.store.setMarker(`loom-threads:${target}`, JSON.stringify([...threads, thread.id].slice(-20)));
    } else if (previous) core.store.deleteMarker(markerKey);
    if (target || previous) core.flush();
  }

  /** Reading a streamed reply cannot acknowledge its brief until the responsible turn finishes. */
  private completedDiscussionReply(itemId: string, detail: LoomDetail): void {
    // A steer can start discussion after its responsible run has already started.
    // Older Loom releases lack runId; completion time is the compatible fallback.
    const run = detail.runs.find(run => run.ended_at != null && (detail.thread.discussing ?? []).some(brief =>
      brief.runId ? brief.runId === run.id : run.ended_at! >= brief.since));
    if (!run || !detail.messages.some(message => message.run_id === run.id && message.role === 'assistant' && message.text.trim())) return;
    const marker = `loom:discussion-reply:${detail.thread.id}:${itemId}`;
    if (this.core.store.marker(marker) === run.id) return;
    this.core.store.setMarker(marker, run.id);
    // Completion is fresh activity even when the final words were already ingested mid-turn.
    this.core.settle(itemId, { summarize: false, activity: { what: 'message', at: run.ended_at! } });
  }

  /** Files one thread's state. */
  private ingest(detail: LoomDetail): void {
    const { core } = this;
    const { store } = core;
    const { thread } = detail;
    if (thread.kind === "probe") {
      // Desks running the core-only release may already have filed this probe.
      const filed = PREFIX + thread.id;
      this.threadAccounts.delete(filed);
      store.deleteMarker(`loom:${thread.id}`);
      if (store.item(filed)) core.settle(filed, { done: true, summarize: false });
      return;
    }
    this.threadAccounts.set(PREFIX + thread.id, thread.account?.trim() || null);
    // Tango agents and jobs are shown through their own sources. One an older desk already filed is
    // retired the way a deleted thread is. A scheduled job that is asking the owner something (a question,
    // a plan, a decision brief) is the exception: the schedule source can't take an answer, so the thread
    // is filed here until the ask is answered, then retired.
    const jobAsking = thread.kind === 'tango-job'
      && ((thread.status === 'waiting' && detail.requests.some((request) => request.status === 'open')) || Boolean(thread.decision));
    if (thread.kind === 'tango-job' && thread.title) this.holdJob(thread, detail.runs);
    if (thread.kind === 'tango-agent') this.linkDiscord(detail);
    if ((thread.kind === 'tango-agent' || thread.kind === 'tango-job') && !jobAsking) {
      const filed = PREFIX + thread.id;
      store.deleteMarker(`loom:${thread.id}`);
      if (store.item(filed)) {
        // A job's answered brief keeps its rule line (Saved as R-n · Undo) on the item it files as done.
        core.setFacts(filed, { rulesSaved: savedRules(detail.decisions ?? []) });
        core.settle(filed, { done: true, summarize: false });
      }
      return;
    }
    try { this.options.memory?.capture(detail); } catch (error) { this.log(`[loom-memory] ${error instanceof Error ? error.message : String(error)}`); }
    const itemId = PREFIX + thread.id;
    const previous = parse<{ failed: string | null; pending: string | null; settled: boolean; brief?: string | null; rev?: number }>(store.marker(`loom:${thread.id}`));
    const open = thread.status === 'waiting' ? detail.requests.filter((request) => request.status === 'open').at(-1) : undefined;
    // A user message whose run hasn't started yet is queued: the agent will read it after its current turn.
    const queuedRuns = new Set(detail.runs.filter((run) => run.status === 'queued').map((run) => run.id));
    const wakeRuns = ownWakes(detail);
    const messages: Array<{ id: string; author: 'agent' | 'owner' | 'other'; text: string; at: number; meta?: MessageMeta; attachments?: MessageAttachment[] }> = detail.messages
      // A message that is only a screenshot is words too.
      .filter((message) => message.text.trim() || message.attachments?.length)
      .map((message) => {
        const meta = loomMessageMeta(message, queuedRuns, wakeRuns);
        const startedAt = detail.runs.find(run => run.id === message.run_id)?.started_at;
        if (meta && message.role === 'user' && !meta.mail && startedAt != null) meta.runStartedAt = startedAt;
        const author = message.role === 'assistant' ? ('agent' as const) : meta?.mail?.kind === 'out' ? ('other' as const) : ('owner' as const);
        const attachments = loomImages(message.attachments);
        return { id: message.id, author, text: message.text, at: message.created_at, ...(meta !== undefined ? { meta } : {}), ...(attachments.length ? { attachments } : {}) };
      });
    // A plan is a tool input, not a message: it joins the conversation so the owner reads what they approve.
    for (const request of detail.requests.filter((entry) => entry.kind === 'plan')) {
      const plan = parse<{ plan?: unknown }>(request.payload)?.plan;
      if (typeof plan === 'string' && plan.trim()) messages.push({ id: `plan:${request.id}`, author: 'agent', text: plan, at: request.created_at });
    }
    messages.sort((a, b) => a.at - b.at);
    // The repo, not the worktree folder (loom-<id>), names where the thread lives.
    const checkout = thread.repo || thread.cwd;
    const project = this.options.projectFor?.(checkout) ?? null;
    const area = project?.name || path.basename(checkout) || checkout;
    const opening = messages.find((message) => message.author === 'owner' && !message.meta?.mail)?.text.trim().split('\n')[0]?.slice(0, 80);
    core.ensureItem(
      {
        id: itemId,
        source: 'loom',
        kind: 'thread',
        conversationKey: itemId,
        agentId: LOOM_AGENT_ID,
        agentName: 'Loom',
        place: `${area} · ${thread.title?.trim() || opening || 'New thread'}`,
        area,
        createdAt: thread.created_at,
      },
      messages[0]?.author ?? 'owner',
    );
    if (isThreadRole(thread.role)) this.followRole(itemId, { role: thread.role, parentItemId: thread.parent_thread_id ?? null });
    let newAgent: { at: number; text: string; ackAfter?: boolean } | null = null;
    let newOwnerAt: number | null = null;
    // Older messages are known already, but a queued one may have started since (Codex review on #575).
    let metaMoved = false;
    for (const message of messages.slice(0, -20)) {
      if ((message.author === 'owner' && message.meta && !message.meta.mail) || message.meta?.runId) metaMoved = store.setMessageMeta(PREFIX + message.id, message.meta) || metaMoved;
    }
    if (metaMoved) store.bumpRevision(itemId);
    // On first read the ask may be older than the usual ingestion window. Retain its whole run and
    // everything since it, so itemDetail can widen its read without silently losing the pinned report.
    const anchorAsk = thread.ask ? askOf(thread.ask, thread.ask_record) : null;
    const anchorRun = thread.decision?.run_id ?? anchorAsk?.runId;
    const anchorStart = anchorRun ? detail.messages.find(message => message.run_id === anchorRun)?.id : undefined;
    const anchorIndex = messages.findIndex(message => (anchorStart && message.id === anchorStart) || (anchorRun && message.meta?.runId === anchorRun) || (anchorAsk?.messageId && PREFIX + message.id === anchorAsk.messageId));
    const ingestFrom = anchorIndex >= 0 ? Math.min(anchorIndex, Math.max(0, messages.length - 20)) : Math.max(0, messages.length - 20);
    for (const message of messages.slice(ingestFrom)) {
      if (!core.recordMessage(itemId, { messageId: PREFIX + message.id, author: message.author, at: message.at, text: message.text, ...(message.meta !== undefined ? { meta: message.meta } : {}), ...(message.attachments ? { attachments: message.attachments } : {}) })) continue;
      if (message.author === 'other') continue;
      // Another agent's mail isn't the owner engaging: it never marks the conversation seen.
      if (message.author === 'owner' && !message.meta?.mail) newOwnerAt = message.at;
      // An ack after the news never hides the news (as T3 does).
      else if (!isAckOnly(message.text) || !newAgent || isAckOnly(newAgent.text)) newAgent = { at: message.at, text: message.text };
      else newAgent.ackAfter = true;
    }
    const run = detail.runs.find((entry) => entry.status === 'running');
    // A turn's last sign of life is its newest tool call or message: the thread row only moves when its status does,
    // so a turn busy for half an hour read as gone (RUNNING_STALE_MS) while the agent was still talking.
    // Only the running turn's own: a reply queued behind it is no sign the turn is alive (Codex review on #646).
    let lastAt = thread.updated_at;
    if (run) {
      for (const entry of detail.items ?? []) if (entry.run_id === run.id && entry.updated_at > lastAt) lastAt = entry.updated_at;
      for (const message of detail.messages) if (message.run_id === run.id && message.role === 'assistant' && message.created_at > lastAt) lastAt = message.created_at;
    }
    const running: DeskFacts['running'] = thread.status === 'running' ? { since: run?.started_at ?? thread.updated_at, ...(run ? { turnId: run.id } : {}), lastAt } : null;
    // An open wait (wait_for) is Loom watching on the agent's behalf: background activity, like a monitor, so the
    // thread is not done while it waits on CI or a deploy (10/18: "Thread roles" read Ready waiting on #724).
    const background = backgroundOf(thread) ?? (detail.waits?.length ? 'monitoring' : null);
    // Loom records the ask; an older Loom without the field leaves it to the words (undefined).
    const openAsk = thread.ask === undefined ? undefined : askOf(thread.ask, thread.ask_record);
    // The latest run that ran: a queued one held behind a usage limit leaves the failure showing.
    const latest = [...detail.runs].reverse().find((entry) => entry.status !== 'queued' && entry.status !== 'canceled');
    const held = heldOf(thread, detail.runs);
    // A turn that failed on a usage limit, with Loom now holding queued work for it: the hold explains it and the
    // work will run, so it reads Waiting, not Failed (Codex review on #807).
    const limitHeld = !!held && parse<{ kind?: string }>(latest?.failure ?? null)?.kind === 'usage_limit' && detail.runs.some((run) => run.status === 'queued');
    const failed = latest?.status === 'failed' && !limitHeld ? failureOf(latest) : null;
    // A live question blocks the turn, so it comes first; an open brief waits on the owner between turns.
    const pending = open ? loomPending(open) : thread.decision ? loomBriefPending(thread.decision) : null;
    const settled = thread.settled_at !== null;
    const item = store.item(itemId)!;
    // The live line under the thread: its latest tool call, as T3 shows its latest activity.
    const activity = latestToolLine(detail.items ?? []);
    const inFlight = inFlightOf(thread, detail);
    // This thread's brief closed: the rows that last carried it (desk/asks.ts carryBriefs) hear how, below. Read from
    // the decision itself, not the pending question, which a live request takes over while the brief stays open (Codex
    // review on #781). An older marker has only the pending question.
    const openBrief = thread.decision?.id ?? null;
    const lastBrief = previous ? (previous.brief !== undefined ? previous.brief : previous.pending?.startsWith(BRIEF_PREFIX) ? previous.pending.slice(BRIEF_PREFIX.length) : null) : null;
    const lastRow = lastBrief ? detail.decisions?.find((entry) => entry.id === lastBrief) : undefined;
    const closedBrief = lastBrief && lastBrief !== openBrief && (!lastRow || lastRow.status !== 'open') ? lastBrief : null;
    core.setFacts(itemId, { running, failed, pending, held, background, discussing: thread.discussing ?? [],
      answeredBrief: answeredBrief(detail.decisions ?? []),
      openedPrUrls: detail.openedPrUrls ?? [],
      legacyPrCreates: detail.legacyPrCreates ?? [],
      // A turn just ended or a merge just ran: re-read this thread's open PRs now, not on the next five-minute pass.
      prRefreshAt: Math.max(0, detail.lastPrMergeAt ?? 0, ...detail.runs.map((entry) => entry.ended_at ?? 0)) || null,
      prBranch: thread.worktree_branch ? { branch: thread.worktree_branch, cwd: thread.repo ?? thread.cwd } : null,
      handoff: thread.closingHandoff ?? null, heartbeatAt: thread.heartbeatAt ?? null, sourceHealth: item.facts.sourceHealth?.ok ? item.facts.sourceHealth : { ok: true, at: Date.now() },
      waits: (detail.waits ?? []).filter(w => ['time', 'pr', 'thread', 'command', 'url', 'file', 'worker'].includes(w.kind)).map(w => ({
        id: w.id, kind: w.kind as NonNullable<DeskFacts['waits']>[number]['kind'], target: w.target ?? w.text ?? '', note: w.note,
        ...(w.prUrl ? { prUrl: w.prUrl } : {}), armedAt: w.created_at ?? 0, dueAt: w.due_at ?? null, timeoutAt: w.expires_at ?? null, lastCheckedAt: w.last_checked_at ?? null, checkError: w.last_error ?? null,
        ...(w.consecutive_errors !== undefined ? { consecutiveErrors: w.consecutive_errors, errorSince: w.error_since ?? null } : {}),
      })), rulesSaved: savedRules(detail.decisions ?? []), inFlight: inFlight.length ? inFlight : null, ...(openAsk !== undefined ? { openAsk } : {}), ...(thread.ask_record !== undefined ? { askLedger: ledgerAskOf(thread.ask_record) } : {}), settledAtSource: settled, stoppedAtSource: thread.status === 'stopped', openBrief: thread.decision ? loomBriefPending(thread.decision) : null, openBriefCount: openBriefCount(thread, detail), project, ...(thread.context !== undefined ? { context: thread.context } : {}), ...(thread.fresh_opt_out !== undefined ? { keepSession: !!thread.fresh_opt_out } : {}), ...(thread.budget !== undefined ? { budget: thread.budget } : {}) }, { activity, lastActivityAt: Math.max(item.lastActivityAt, thread.updated_at, activity?.at ?? 0) });
    // The same brief, revised since the last read: carriers outside Loom hear each material change once (TGO-1079).
    const revision = thread.decision?.revision;
    const revised = openBrief && previous?.brief === openBrief && previous.rev !== undefined && revision !== undefined && revision > previous.rev
      ? (thread.decision!.changes ?? []).filter((change) => change.revision > previous.rev! && change.material)
      : [];
    store.setMarker(`loom:${thread.id}`, JSON.stringify({ failed: failed?.turnId ?? null, pending: pending?.requestId ?? null, settled, brief: openBrief, ...(revision !== undefined ? { rev: revision } : {}) }));

    // Report what happened, once per transition.
    const settledNow = settled && previous?.settled === false;
    if (!previous && settled) {
      core.settle(itemId, { done: true, summarize: true, ...(newAgent ? { activity: { what: 'message', ...newAgent } } : {}) });
    } else if (failed && previous?.failed !== failed.turnId) {
      core.settle(itemId, { activity: { what: 'failed', at: failed.at } });
    } else if (pending && previous?.pending !== pending.requestId) {
      core.settle(itemId, { activity: { what: pending.kind, at: pending.at } });
    } else if (newAgent && (newOwnerAt === null || newAgent.at >= newOwnerAt)) {
      core.settle(itemId, { activity: { what: 'message', ...newAgent } });
    } else if (newOwnerAt !== null) {
      core.settle(itemId, { ownerPostedAt: newOwnerAt });
    } else {
      core.settle(itemId, { summarize: false });
    }
    if (settledNow) core.settle(itemId, { done: true, summarize: false });
    this.completedDiscussionReply(itemId, detail);
    void (async () => {
      await core.migrateStanding(itemId);
      // The one-time migration also covers local filed rows. Later source-side settles must be repaired too.
      if (settled && core.isStanding(store.item(itemId)!)) await this.restoreStanding(store.item(itemId)!);
    })().catch((err) => this.log('desk.loom.standing.error', { itemId, message: (err as Error).message }));
    core.flush();
    if (closedBrief) {
      for (const carrier of core.takeCarriers(itemId, closedBrief)) this.tellCarrier(carrier, itemId, closedBrief, detail.thread.title?.trim() || 'a Loom thread', detail.decisions?.find((entry) => entry.id === closedBrief) ?? null);
    }
    if (revised.length) {
      // Every material revision since the last read, each once: two can land between reads (Codex review on #811).
      for (const carrier of core.carriersOf(itemId, openBrief!)) {
        for (const change of revised) this.tellRevised(carrier, itemId, thread.decision!, change, detail.thread.title?.trim() || 'a Loom thread');
      }
    }
  }

  /**
   * A brief a carrier outside Loom carries was revised in a way that matters (the options, the recommendation or the
   * default): it hears what changed, once per revision, so it points the owner at the same id rather than raising a
   * new one (TGO-1079). Loom tells its own carriers itself.
   */
  private tellRevised(carrierId: string, itemId: string, decision: LoomDecision, change: NonNullable<LoomDecision['changes']>[number], title: string): void {
    const to = this.core.store.item(carrierId);
    if (!to) return;
    // Loom already told this thread itself, or it made the change (Codex review on #811).
    const threadId = carrierId.slice(PREFIX.length);
    if (to.source === 'loom' && (change.told?.includes(threadId) || change.by === threadId)) return;
    const id = `m-dec-${decision.id.toLowerCase()}-r${change.revision}`;
    const text = mailTurn({ id, fromItemId: itemId, fromTitle: title, text: `Decision ${decision.id}, which you carry for “${title}”, was updated (revision ${change.revision}): ${change.what}. Why: ${change.why} It is still open as ${decision.id}, now asking: ${decision.ask} Point the owner at ${decision.id} as before; don't raise a new brief or restate it.`, expect: 'none' });
    const sent = to.source === 'loom'
      ? this.steer(to, text, { name: title, from: itemId, mailId: id }, `${id}-${carrierId}`).then((result) => (result.ok ? 'applied' : result.error))
      : this.core.command({ commandId: `${id}-${carrierId}`, type: 'reply', itemId: carrierId, args: { text }, actor: 'agent' }).then((result) => result.status);
    void sent
      .then((status) => { if (status !== 'applied') this.log('desk.loom.carrier_fyi.error', { carrierId, decisionId: decision.id, status }); })
      .catch((err) => this.log('desk.loom.carrier_fyi.error', { carrierId, decisionId: decision.id, message: (err as Error).message }));
  }

  /**
   * A brief settled on a carrier Loom doesn't tell (a T3 or Discord lead of a Loom worker, or a worker whose own lead
   * is gone carrying its child's brief): the desk tells it how it went, as another agent's words, so it doesn't ask
   * again (Codex review on #781). Once per transition (the marker), best effort.
   */
  private tellCarrier(carrierId: string, itemId: string, decisionId: string, title: string, row: LoomDecision | null, said?: string): void {
    const to = this.core.store.item(carrierId);
    if (!to) return;
    let how: string;
    if (said) how = said;
    else if (!row) how = 'it is no longer open';
    else if (row.status === 'answered') how = `the owner answered it: ${settledChoice(row) || 'see that thread'}`;
    else if (row.status === 'defaulted') how = `no veto, so its default went ahead: ${settledChoice(row) || row.brief.default || 'see that thread'}`;
    else if (row.status === 'superseded') how = 'it was replaced by a newer brief from the same thread';
    else if (row.status === 'moot') how = `it is moot${row.answer_text?.trim() ? `: ${row.answer_text.trim()}` : ''}`;
    else how = `it was ${row.status}`;
    const goesOn = row?.status === 'answered' || row?.status === 'defaulted' ? "That thread carries it out; don't" : "Don't";
    const id = `m-dec-${decisionId.toLowerCase()}`;
    const text = mailTurn({ id, fromItemId: itemId, fromTitle: title, text: `Decision ${decisionId}${row ? ` (${row.ask})` : ''}, which you carried for “${title}”, is settled: ${how}. ${goesOn} ask the owner about ${decisionId} again.`, expect: 'none' });
    // A Loom carrier (a worker whose lead is gone) takes it as another agent's words; elsewhere it is a desk reply.
    const sent = to.source === 'loom'
      ? this.steer(to, text, { name: title, from: itemId, mailId: id }, `${id}-${carrierId}`).then((result) => (result.ok ? 'applied' : result.error))
      : this.core.command({ commandId: `${id}-${carrierId}`, type: 'reply', itemId: carrierId, args: { text }, actor: 'agent' }).then((result) => result.status);
    void sent
      .then((status) => { if (status !== 'applied') this.log('desk.loom.carrier_fyi.error', { carrierId, decisionId, status }); })
      .catch((err) => this.log('desk.loom.carrier_fyi.error', { carrierId, decisionId, message: (err as Error).message }));
  }

  // ── write side ─────────────────────────────────────────────────────────

  private lastBeat = 0;
  /**
   * Tells Loom the owner is active (at most once a minute): their active time runs level 3 veto windows.
   * Best effort: a missed beat only means a minute that doesn't count.
   */
  beat(at: number, source: string): void {
    if (at - this.lastBeat < 60_000) return;
    this.lastBeat = at;
    this.call('/presence', { method: 'POST', body: { at, source }, signal: AbortSignal.timeout(5_000) }).catch(() => {});
  }

  private async send(command: Record<string, unknown>, timeoutMs = 10_000): Promise<Sent> {
    let result: { status: number; body: any };
    try {
      result = await this.call('/commands', { method: 'POST', body: command, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const message = (err as Error).message;
      if (!this.token()) return { ok: false, error: message };
      // Loom may have applied it before going quiet; the command id makes a retry safe.
      return { ok: false, error: `Loom didn't answer: ${message}`, unknown: true };
    }
    if (result.body?.ok) return { ok: true, result: result.body.result };
    const code = typeof result.body?.code === 'string' ? result.body.code : `http_${result.status}`;
    return { ok: false, code, error: REFUSALS[code] ?? (result.body?.message || `Loom refused it (${code})`) };
  }

  /**
   * A new thread (Start work). Loom makes the worktree first (a fetch: up to a couple of minutes)
   * and picks the Claude account from its pool; a refused worktree comes back as git's own message.
   * The thread is read and filed before this returns, so its item exists when the sheet opens it
   * (the change stream files it again a moment later, as nothing new).
   */
  async startThread(start: LoomStart): Promise<{ ok: true; threadId: string } | { ok: false; error: string; unknown?: boolean }> {
    const where = start.sameTree ? { sameTree: true } : start.mode === 'auto' ? { cwd: start.repoPath, worktree: 'auto' as const } : start.mode === 'local' ? { cwd: start.repoPath } : { worktree: { repoPath: start.repoPath } };
    const seats = { ...(start.accountsFrom ? { accountsFrom: start.accountsFrom } : {}), ...(start.account ? { account: start.account } : {}), ...(start.accounts?.length ? { accounts: start.accounts } : {}), ...(start.autoTitle ? { autoTitle: true } : {}) };
    const images = start.attachments?.length ? { attachments: start.attachments } : {};
    const role = start.role ? { role: start.role, ...(start.parentThreadId ? { parentThreadId: start.parentThreadId } : {}) } : {};
    const sent = await this.send({ type: 'submit', commandId: start.commandId, text: start.text, provider: 'claude', ...(start.title ? { title: start.title } : {}), kind: 'coding', ...where, ...seats, ...images, ...role, ...(start.tier ? { tier: start.tier } : {}) }, 150_000);
    if (!sent.ok) return { ok: false, error: sent.error, ...(sent.unknown ? { unknown: true } : {}) };
    const threadId = sent.result?.threadId;
    if (!threadId) return { ok: false, error: "Loom started the thread but didn't say which" };
    try {
      await this.read(threadId);
    } catch (err) {
      this.log('desk.loom.thread.error', { threadId, message: (err as Error).message });
      this.markUnhealthy(threadId, err);
    }
    return { ok: true, threadId };
  }

  /** An image on a Loom message, for the desk's attachment route; null when Loom has no such image. */
  async image(id: string): Promise<{ mimeType: string; bytes: Uint8Array<ArrayBuffer> } | null> {
    const token = this.token();
    if (!token || !/^[A-Za-z0-9-]+$/.test(id)) return null;
    const response = await fetch(new URL(`/attachments/${id}`, this.options.url), { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return null;
    return { mimeType: response.headers.get('content-type') ?? 'image/png', bytes: new Uint8Array(await response.arrayBuffer()) };
  }

  /** Renames the thread in Loom (it then keeps that name, and stops naming the thread itself); returns the desk's place for it. */
  /**
   * Loom keeps the role, so the desk follows whatever it reports (Codex review on #650). The one
   * exception: a thread from before roles (Loom's default, no owner) that the desk knows was started
   * by another conversation (desk_mail) is a worker under it; that is written to Loom once instead.
   */
  private followRole(itemId: string, reported: RoleRecord): void {
    const { core } = this.options;
    const inferred = !core.roles.isSet(itemId) ? core.roles.all().get(itemId) : undefined;
    if (inferred && reported.role === 'interactive' && !reported.parentItemId) {
      if (this.backfilled.has(itemId)) return;
      this.backfilled.add(itemId);
      const item = core.store.item(itemId);
      if (item) void this.setRole(item, inferred.role, inferred.parentItemId).then(
        () => { core.roles.follow(itemId, inferred); core.touch(itemId); core.flush(); },
        (err) => this.options.log?.('desk.loom.role_backfill.error', { itemId, message: (err as Error).message }),
      );
      return;
    }
    if (!core.roles.follow(itemId, reported)) return;
    core.touch(itemId);
    core.flush();
  }
  private readonly backfilled = new Set<string>();

  /** Loom keeps a thread's role and owner (its session's instructions follow the role). */
  async setRole(item: DeskItemRow, role: ThreadRole, parentItemId: string | null | undefined): Promise<void> {
    const sent = await this.send({ type: 'role', commandId: randomUUID(), threadId: item.id.slice(PREFIX.length), role, ...(parentItemId !== undefined ? { parentThreadId: parentItemId } : {}) });
    if (!sent.ok) throw new Error(sent.error);
  }

  async rename(item: DeskItemRow, title: string): Promise<string> {
    const sent = await this.send({ type: 'rename', commandId: randomUUID(), threadId: item.id.slice(PREFIX.length), title });
    if (!sent.ok) throw new Error(sent.error);
    return `${item.area ?? (item.place ?? '').split(' · ')[0]} · ${title}`;
  }

  /** Stops the turn in progress (Loom interrupts its harness); the thread stays open for the next message. */
  async interrupt(item: DeskItemRow): Promise<{ ok: true } | { ok: false; error: string }> {
    // The turn the owner saw: if it already finished, Loom refuses rather than stopping the next one.
    const runId = item.facts.running?.turnId;
    const sent = await this.send({ type: 'interrupt', commandId: randomUUID(), threadId: item.id.slice(PREFIX.length), ...(runId ? { runId } : {}) });
    return sent.ok ? { ok: true } : { ok: false, error: sent.error };
  }

  /** "Keep this session": Loom never resets it on its own (compaction still applies). */
  async keepSession(item: DeskItemRow, keep: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const { status, body } = await this.call(`/threads/${encodeURIComponent(item.id.slice(PREFIX.length))}/keep-session`, { method: 'POST', body: { keep }, signal: AbortSignal.timeout(MAILBOX_WAIT_MS) });
      return status === 200 && body?.ok !== false ? { ok: true } : { ok: false, error: status === 404 ? 'Loom doesn’t know this thread' : body?.message ?? `Loom answered ${status}` };
    } catch (err) {
      return { ok: false, error: `Loom isn't answering (${(err as Error).message})` };
    }
  }

  /** The budget's Raise: +50% for today. */
  async raiseBudget(item: DeskItemRow): Promise<{ ok: true; budget: NonNullable<DeskFacts['budget']> } | { ok: false; error: string }> {
    try {
      const { status, body } = await this.call(`/threads/${encodeURIComponent(item.id.slice(PREFIX.length))}/budget`, { method: 'POST', body: { raise: true } });
      return status === 200 && body?.ok !== false && body?.budget ? { ok: true, budget: body.budget } : { ok: false, error: status === 404 ? 'Loom doesn’t know this thread' : body?.code === 'no_budget' ? 'This thread has no budget' : body?.message ?? `Loom answered ${status}` };
    } catch (err) {
      return { ok: false, error: `Loom isn't answering (${(err as Error).message})` };
    }
  }

  /** Fresh start: the thread's next turn opens a new session from its handoff and Loom's record. */
  async freshStart(item: DeskItemRow): Promise<{ ok: true; message?: string } | { ok: false; error: string }> {
    try {
      const { status, body } = await this.call(`/threads/${encodeURIComponent(item.id.slice(PREFIX.length))}/fresh-start`, { method: 'POST', body: {}, signal: AbortSignal.timeout(MAILBOX_WAIT_MS) });
      return status === 200 && body?.ok !== false ? { ok: true, ...(body?.message ? { message: String(body.message) } : {}) } : { ok: false, error: status === 404 ? 'Loom doesn’t know this thread' : body?.message ?? `Loom answered ${status}` };
    } catch (err) {
      return { ok: false, error: `Loom isn't answering (${(err as Error).message})` };
    }
  }

  /** A worker's task ended where the desk saw it (its PR merged): Loom starts its next turn in a fresh session. */
  async taskEnded(itemId: string, why: string): Promise<{ ok: true; marked: boolean } | { ok: false; error: string }> {
    if (!itemId.startsWith(PREFIX)) return { ok: true, marked: false };
    try {
      const { status, body } = await this.call(`/threads/${encodeURIComponent(itemId.slice(PREFIX.length))}/task-ended`, { method: 'POST', body: { why }, signal: AbortSignal.timeout(MAILBOX_WAIT_MS) });
      // A thread Loom doesn't know has no session to end: nothing to retry.
      if (status === 404) return { ok: true, marked: false };
      return status === 200 && body?.ok !== false ? { ok: true, marked: body?.marked === true } : { ok: false, error: body?.message ?? `Loom answered ${status}` };
    } catch (err) {
      return { ok: false, error: `Loom isn't answering (${(err as Error).message})` };
    }
  }

  async clear(item: DeskItemRow): Promise<{ outcome: 'ok' | 'failed'; error?: string; steps?: string[] }> {
    const sent = await this.send({ type: 'clear', commandId: randomUUID(), threadId: item.id.slice(PREFIX.length), clearedAt: item.facts.clearedAt });
    return sent.ok ? { outcome: 'ok', steps: ['cleared'] } : { outcome: 'failed', error: sent.error };
  }

  async undoClear(item: DeskItemRow, clearedAt: number): Promise<void> {
    const sent = await this.send({ type: 'clear.undo', commandId: randomUUID(), threadId: item.id.slice(PREFIX.length), clearedAt });
    if (!sent.ok) throw new Error(sent.error);
  }

  async undoDone(item: DeskItemRow, settledAt: number): Promise<void> {
    const sent = await this.send({ type: 'settle.undo', commandId: randomUUID(), threadId: item.id.slice(PREFIX.length), settledAt });
    if (!sent.ok) throw new Error(sent.error);
    this.dirty.add(item.id.slice(PREFIX.length));
    this.drain();
  }

  async restoreStanding(item: DeskItemRow): Promise<void> {
    const sent = await this.send({ type: 'unsettle', commandId: randomUUID(), threadId: item.id.slice(PREFIX.length) });
    if (!sent.ok) throw new Error(sent.error);
  }

  async done(item: DeskItemRow): Promise<{ outcome: 'ok' | 'failed'; error?: string; steps?: string[] }> {
    const sent = await this.send({ type: 'settle', commandId: randomUUID(), threadId: item.id.slice(PREFIX.length), settledAt: item.facts.askClosedByDoneAt });
    return sent.ok ? { outcome: 'ok', steps: ['settled'] } : { outcome: 'failed', error: sent.error };
  }

  /**
   * Desk mail into a Loom thread: into the turn in progress when it is busy (read as soon as its current
   * step finishes), else a turn of its own. Marked as another agent's words, never the owner's.
   */
  async steer(item: DeskItemRow, text: string, origin: { name: string; from: string; mailId: string }, commandId: string): Promise<{ ok: true; steered: boolean } | { ok: false; error: string; unknown?: boolean }> {
    const sent = await this.send({ type: 'submit', commandId, threadId: item.id.slice(PREFIX.length), text, steer: true, origin: { kind: 'peer', ...origin } });
    if (!sent.ok) return { ok: false, error: sent.error, ...(sent.unknown ? { unknown: true } : {}) };
    return { ok: true, steered: (sent as { result?: { steered?: boolean } }).result?.steered === true };
  }

  /** A new user turn in the thread (Loom queues it in the thread's mailbox when it is busy). */
  async seen(item: DeskItemRow, at: number): Promise<void> {
    if (!item.facts.discussing?.length) return;
    const sent = await this.send({ type: 'thread.seen', commandId: randomUUID(), threadId: item.id.slice(PREFIX.length), at });
    if (!sent.ok) throw new Error(sent.error);
  }

  async reply(item: DeskItemRow, text: string, context: { commandId?: string; attachments?: StartAttachment[]; origin?: MailOrigin } = {}): Promise<{ ok: true } | { ok: false; error: string; unknown?: boolean }> {
    const images = context.attachments?.length ? { attachments: context.attachments } : {};
    // Mail as a new turn carries its sender, as a steered one does: Loom never reads it as the owner's words.
    const origin = context.origin ? { origin: { kind: 'peer', ...context.origin } } : {};
    // Images make the request big (up to eight 10 MB pictures): give it longer than a word reply.
    const sent = await this.send({ type: 'submit', commandId: context.commandId ?? randomUUID(), threadId: item.id.slice(PREFIX.length), text, ...images, ...origin }, context.attachments?.length ? 60_000 : 10_000);
    return sent.ok ? sent : { ok: false, error: sent.error, ...(sent.unknown ? { unknown: true } : {}) };
  }

  /**
   * Answers the thread's open question or plan. Reads the thread first: a request Loom no longer
   * holds open fails as "the question changed" and nothing is sent. The desk's command id is Loom's.
   */
  async resolvePending(item: DeskItemRow, resolution: PendingResolution, context: { commandId: string }): Promise<{ ok: true } | { ok: false; error: string; changed?: boolean; unknown?: boolean }> {
    const threadId = item.id.slice(PREFIX.length);
    if (resolution.requestId.startsWith(BRIEF_PREFIX)) return this.resolveBrief(threadId, resolution, context);
    let request: LoomRequest | undefined;
    try {
      const { status, body } = await this.call(`/threads/${encodeURIComponent(threadId)}`);
      if (status !== 200 && status !== 404) throw new Error(`HTTP ${status}`);
      request = (body as LoomDetail | null)?.requests?.find((entry) => entry.id === resolution.requestId && entry.status === 'open');
    } catch (err) {
      return { ok: false, error: `Loom couldn't be read: ${(err as Error).message}` };
    }
    const changed = { ok: false as const, changed: true, error: `${QUESTION_CHANGED}: ${REFUSALS.not_open}` };
    if (!request) return changed;
    if (resolution.kind !== 'respond') return { ok: false, error: 'Loom questions take an answer, not a dismissal' };
    const sent = await this.send({ type: 'answer', commandId: context.commandId, requestId: request.id, answer: loomAnswer(request, resolution.answers) });
    if (sent.ok) return sent;
    return sent.code === 'not_open' || sent.code === 'not_found' ? changed : { ok: false, error: sent.error };
  }

  /** An open brief of this thread as the question card takes it, whether or not the row shows it (the brief page answers any). */
  async linkedBrief(itemId: string, decisionId: string): Promise<{ threadId: string; pending: PendingRequest } | null> {
    const decision = await this.decision(decisionId);
    if (!decision || decision.status !== 'open' || !decision.thread_id) return null;
    const row = parse<{ itemId: string }>(this.core.store.marker(`loom-row:${decision.thread_id}`))?.itemId;
    return row === itemId ? { threadId: decision.thread_id, pending: loomBriefPending(decision) } : null;
  }

  async briefPending(item: DeskItemRow, decisionId: string): Promise<PendingRequest | null> {
    try {
      const { status, body } = await this.call(`/threads/${encodeURIComponent(item.id.slice(PREFIX.length))}`);
      const decision = status === 200 ? (body as LoomDetail | null)?.decisions?.find((entry) => entry.id === decisionId && entry.status === 'open') : undefined;
      return decision ? loomBriefPending(decision) : null;
    } catch {
      return null;
    }
  }

  /**
   * Did it or one step on a recorded ask. Loom now enforces revision and open status atomically.
   * Keep the ledger pre-check for older Loom releases, and refresh after either side refuses a stale completion.
   */
  async resolveAsk(item: DeskItemRow, askId: string, args: { step?: string; note?: string; by: 'person' | 'desk'; revision?: number }, context: { commandId: string }): Promise<{ ok: true } | { ok: false; error: string; changed?: boolean }> {
    const { revision, ...resolution } = args;
    const threadId = item.id.slice(PREFIX.length);
    const reread = () => { this.dirty.add(threadId); this.drain(); };
    let row: { status?: string; revision?: number } | null;
    try {
      const { status, body } = await this.call(`/asks/${encodeURIComponent(askId)}`);
      if (status !== 200 && status !== 404) throw new Error(`HTTP ${status}`);
      row = status === 200 ? (body as { status?: string; revision?: number }) : null;
    } catch (err) {
      return { ok: false, error: `Loom couldn't be read: ${(err as Error).message}` };
    }
    if (!row || row.status !== 'open') {
      reread();
      return { ok: false, changed: true, error: `${QUESTION_CHANGED}: this ask is ${row ? `already ${row.status}` : 'no longer in the ledger'}` };
    }
    if (typeof revision === 'number' && typeof row.revision === 'number' && row.revision !== revision) {
      reread();
      return { ok: false, changed: true, error: `${QUESTION_CHANGED}: this ask was updated since you looked (revision ${row.revision}); read it again` };
    }
    const sent = await this.send({ type: 'ask.resolve', commandId: context.commandId, askId, outcome: 'done', ...resolution, ...(revision !== undefined ? { revision } : {}) });
    if (!sent.ok) {
      if (sent.code === 'stale' || sent.code === 'not_open') {
        reread();
        return { ok: false, changed: true, error: `${QUESTION_CHANGED}: ${sent.error}` };
      }
      return sent;
    }
    reread();
    return { ok: true };
  }

  /** Answers an open decision brief: Loom records it in the ledger and wakes the thread with the owner's choice. */
  private async resolveBrief(threadId: string, resolution: PendingResolution, context: { commandId: string }): Promise<{ ok: true } | { ok: false; error: string; changed?: boolean; unknown?: boolean }> {
    const decisionId = resolution.requestId.slice(BRIEF_PREFIX.length);
    const changed = { ok: false as const, changed: true, error: `${QUESTION_CHANGED}: ${REFUSALS.not_open}` };
    let decision: LoomDecision | undefined;
    try {
      const { status, body } = await this.call(`/threads/${encodeURIComponent(threadId)}`);
      if (status !== 200 && status !== 404) throw new Error(`HTTP ${status}`);
      decision = (body as LoomDetail | null)?.decisions?.find((entry) => entry.id === decisionId && entry.status === 'open');
    } catch (err) {
      return { ok: false, error: `Loom couldn't be read: ${(err as Error).message}` };
    }
    if (!decision) return changed;
    if (resolution.kind !== 'respond') return { ok: false, error: 'A decision takes an answer, not a dismissal' };
    // The owner answers the revision they saw (TGO-1079): a brief revised since is refused here, and by Loom if it moves on in between.
    const revision = resolution.revision;
    if (revision !== undefined && decision.revision !== undefined && revision !== decision.revision) return { ok: false, changed: true, error: updatedSince(decision) };
    const answer = briefAnswer(decision, resolution.answers);
    if (!answer.option && !answer.text) return { ok: false, error: 'Pick an option or say what you want instead' };
    const choice = resolution.rule ? { rule: resolution.rule } : {};
    const reason = resolution.reason ? { reason: resolution.reason } : {};
    const sent = await this.send({ type: 'decision.answer', commandId: context.commandId, decisionId, ...answer, ...choice, ...reason, ...(revision !== undefined ? { revision } : {}) });
    if (sent.ok) return sent;
    if (sent.code === 'stale') return { ok: false, changed: true, error: updatedSince(null) };
    // Unknown: Loom may have taken it (a timeout); the desk keeps treating its answer turn as the desk's own.
    return sent.code === 'not_open' || sent.code === 'not_found' ? changed : { ok: false, error: sent.error, ...(sent.unknown ? { unknown: true } : {}) };
  }
}

/**
 * What the desk knows about a Loom message beyond its words: another agent's (desk mail or a native
 * message, by its origin, or by a desk mail header) and, for the owner's words, whether its run is
 * still queued (false once it started). For an assistant message, the wake it answers (its run was
 * Loom waking the thread), plus its run id for brief/report anchoring.
 */
export function loomMessageMeta(message: { role: string; text: string; run_id?: string | null; origin?: string | null; command_id?: string | null }, queuedRuns: Set<string>, wakeRuns: Map<string, { note: string | null; cause?: 'trigger' | 'corrective'; answersRun?: string }> = new Map()): MessageMeta | undefined {
  if (message.role === 'assistant') return message.run_id ? { runId: message.run_id, ...(wakeRuns.has(message.run_id) ? { wake: { run: message.run_id, ...wakeRuns.get(message.run_id)! } } : {}) } : undefined;
  const origin = parse<{ kind?: string; name?: string; from?: string; to?: string; mailId?: string; inline?: boolean }>(message.origin ?? null);
  const header = parseMailHeader(message.text);
  if (origin?.kind === 'peer-out') {
    return { mail: { kind: 'out', peer: origin.name || origin.to || 'another session', ...(origin.to ? { peerId: origin.to } : {}), ...(origin.mailId ? { mailId: origin.mailId } : {}), inline: true } };
  }
  if (origin?.kind === 'peer' || header) {
    const kind = header ? (header.kind === 'from' ? 'in' : header.kind === 'to' ? 'out' : header.kind) : 'in';
    return {
      mail: {
        kind,
        peer: header?.title || origin?.name || 'another session',
        ...(header?.itemId || origin?.from ? { peerId: header?.itemId || origin?.from } : {}),
        ...(header?.mailId || origin?.mailId ? { mailId: header?.mailId || origin?.mailId } : {}),
        ...(origin?.inline ? { inline: true } : {}),
      },
    };
  }
  // A brief's answer Loom files as the owner's turn (packages/loom decisions.ts answerText): not words typed past
  // the thread's other requests (desk/status.ts wroteSince; Codex review on #1032).
  const answers = /^Decision (D-\d+): /.exec(message.text)?.[1];
  // Said either way: the desk then never guesses for a Loom thread.
  return { ...(message.command_id ? { commandId: message.command_id } : {}), ...(message.run_id ? { runId: message.run_id } : {}), queued: !!message.run_id && queuedRuns.has(message.run_id), ...(answers ? { answers } : {}) };
}

/** Loom's text for a wake that is another session's message (packages/loom runtime PEER_WAKE_TEXT). */
const PEER_WAKE_TEXT = 'A message from another session.';

/**
 * The runs Loom woke the thread for on its own (a wait came due, a veto clock ran out), with the note left
 * with the wait. A peer's message also wakes an idle thread, and a worker's failure report is a run made for
 * its mail: those stay mail turns. Mail arriving inline during an own wake didn't start it, so it doesn't count
 * (as packages/loom host startingMail reads it; Codex review on #969).
 */
export function ownWakes(detail: Pick<LoomDetail, 'runs' | 'messages'>): Map<string, { note: string | null; cause?: 'trigger' | 'corrective'; answersRun?: string }> {
  const opening = new Map<string, string>();
  for (const message of detail.messages) if (message.role === 'user' && message.run_id && !opening.has(message.run_id)) opening.set(message.run_id, message.text);
  // Loom folds automatic runs queued together into the first (packages/loom host dispatch): the first part is what opened it.
  const opener = (run: LoomDetail['runs'][number]) => (run.text ?? '').split(FOLD_SEPARATOR)[0]!;
  return new Map(
    detail.runs
      .filter((run) => run.source === 'wake' && opener(run).trim() !== PEER_WAKE_TEXT && opening.get(run.id) !== opener(run))
      .map((run) => [run.id, { note: wakeNote(opener(run)), cause: run.wake_cause ?? 'trigger', ...(run.answers_run_id ? { answersRun: run.answers_run_id } : {}) }]),
  );
}

/** How Loom joins the words of runs it folds into one. */
const FOLD_SEPARATOR = '\n\n---\n\n';

/** The note an agent left with the wait that woke it ("Your note: …"), first line only. */
export function wakeNote(text: string | undefined): string | null {
  const note = /Your note:\s*([^\n]+)/.exec(text ?? '')?.[1]?.trim();
  return note ? note.split(/(?<=[.!?])\s/)[0]!.slice(0, 160) : null;
}

/** A Loom message's images, as the desk serves them (proxied from Loom, by id). */
export function loomImages(attachments: LoomDetail['messages'][number]['attachments']): MessageAttachment[] {
  return (attachments ?? []).map((attachment) => ({
    name: attachment.name,
    mimeType: attachment.mime_type,
    url: `api/desk/attachments/loom/${attachment.id}`,
    sizeBytes: attachment.size_bytes,
  }));
}

/** Present and past tense per tool: "Running `npm test`", then "Ran `npm test`". */
const TOOL_VERBS: Record<string, [string, string]> = {
  Bash: ['Running', 'Ran'],
  Read: ['Reading', 'Read'],
  Edit: ['Editing', 'Edited'],
  MultiEdit: ['Editing', 'Edited'],
  Write: ['Writing', 'Wrote'],
  NotebookEdit: ['Editing', 'Edited'],
  Grep: ['Searching for', 'Searched for'],
  Glob: ['Listing', 'Listed'],
  WebFetch: ['Fetching', 'Fetched'],
  WebSearch: ['Searching the web for', 'Searched the web for'],
  Agent: ['Delegating', 'Delegated'],
  Task: ['Delegating', 'Delegated'],
  TodoWrite: ['Updating the plan', 'Updated the plan'],
};

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** One tool call as a line for the owner: what it did and to what, never a machine path. */
export function toolLine(name: string, rawInput: string | null, status: LoomItem['status']): string {
  const input = parse<Record<string, unknown>>(rawInput) ?? {};
  const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string).trim() : '');
  const verbs = TOOL_VERBS[name];
  const verb = verbs ? verbs[status === 'running' ? 0 : 1] : null;
  const file = str('file_path') || str('notebook_path') || str('path');
  let line: string;
  if (name === 'Bash' && str('command')) line = `${verb} \`${clip(str('command').split('\n')[0]!, 90)}\``;
  else if (file && verb) line = `${verb} ${path.basename(file)}`;
  else if ((name === 'Grep' || name === 'Glob') && str('pattern')) line = `${verb} “${clip(str('pattern'), 60)}”`;
  else if (name === 'WebSearch' && str('query')) line = `${verb} “${clip(str('query'), 60)}”`;
  else if (name === 'WebFetch' && str('url')) line = `${verb} ${(() => { try { return new URL(str('url')).host; } catch { return clip(str('url'), 60); } })()}`;
  else if ((name === 'Agent' || name === 'Task') && str('description')) line = `${verb}: ${clip(str('description'), 80)}`;
  else if (verb) line = verb;
  else if (name.startsWith('mcp__')) line = name.slice(5).split('__').join(': ');
  else line = name || 'Working';
  return status === 'failed' ? `${line} (failed)` : line;
}

/** The newest tool call as the item's activity line, or null when there has been none. */
export function latestToolLine(items: LoomItem[]): { text: string; at: number } | null {
  const latest = items.filter((item) => item.name).reduce<LoomItem | null>((best, item) => (!best || item.updated_at >= best.updated_at ? item : best), null);
  return latest ? { text: toolLine(latest.name, latest.input, latest.status).slice(0, 200), at: latest.updated_at } : null;
}
