import { deskStatus } from './status.js';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { coordinatorItemIds, isIdle, withoutNextLine } from './coordinator.js';
import type { DeskCore, OwnerPostUp } from './core.js';
import { LOOM_ACCOUNT, type StartResult, type StartWorkRequest } from './start-work.js';
import { readSpaces } from './spaces.js';
import { kindOf } from './query.js';
import { readProjects } from './projects.js';
import type { DeskItem, Log, ThreadRole } from './types.js';

// Desk mail (TGO-985): one agent's conversation writes to another's: a Tango agent's Discord thread, a
// T3 thread, a Loom thread. The desk already holds every conversation, knows whether each is idle, and can
// put a turn into any of them (`reply`); mail adds who sent it, waits for the target to be idle, finds its
// answer and takes that back to the sender, the way the project coordinator's questions go.
//
// The owner sees all of it in the Conversation view: the mail arrives in the target as a turn headed
// "✉️ Mail from …", the answer arrives in the sender as "✉️ Reply from …", and the sender's own
// conversation keeps a "✉️ Mail to …" note of what it sent (`MAIL_HEADER`, `threadBeats`).
//
// Mail is words only: it never answers or approves what a conversation is waiting on the owner for.
// Guardrails: nothing is delivered into a running turn (unless sent with `now`, only for mail needing no reply), nor into a parked or
// finished conversation (unless sent with `wake`); peer chains past `DEPTH_NOTICE_HOPS` get one
// owner-visible notice, never a depth refusal. Recorded starts/reopens and own-worker mail start
// at zero; no-reply mail and replies to it add no depth. One conversation delivers at most
// `PAIR_LIMIT` to another an hour, holding excess mail until room opens, including `now`; isolated agents (the youth
// agents) neither send nor receive; and the owner can switch mail off for a conversation or a project.

export type MailExpect = 'reply' | 'none';
export type MailState = 'draft' | 'queued' | 'sending' | 'sent' | 'answered' | 'done' | 'failed' | 'unanswered' | 'dropped';

export interface DeskMailRecord {
  id: string;
  fromItemId: string;
  toItemId: string;
  fromTitle: string;
  toTitle: string;
  text: string;
  expect: MailExpect;
  state: MailState;
  /** `start`: the opening turn of a thread the sender started. `report`: a worker's turn nobody asked for by mail, passed up to what it reports to. */
  kind?: 'mail' | 'start' | 'report';
  /** The first mail of the exchange this belongs to, and how many mails deep this one is. */
  chain: string;
  hops: number;
  /** Delivered even into a running turn. */
  urgent: boolean;
  /** Reopen the recipient only after the owner approves a held draft. */
  wake?: boolean;
  /** Delivered into a turn in progress (a Loom thread): answered by explicit reply or back-mail. */
  steered?: boolean;
  /** Queued delivery deadline; zero pauses expiry behind an owner request. */
  deliveryExpiresAt?: number | null;
  createdAt: number;
  sentAt: number | null;
  /** Estimated earliest delivery while held by the hourly pair limit. */
  heldUntil?: number;
  answer: string | null;
  answeredAt: number | null;
  /** The answer reached the sender: relayed as a turn, or read by `tango-screen wait`. */
  relayedAt: number | null;
  relayedVia: 'turn' | 'wait' | 'mail' | null;
  error: string | null;
  /** A notice owed to the sender: its mail is held (still queued after `HELD_NOTICE_MS`), dropped or unanswered. */
  notice?: MailNotice | null;
  /** The notices the sender already got about this mail. */
  noticed?: MailNotice[];
}

export type MailNotice = 'held' | 'dropped' | 'unanswered';

export const DEPTH_NOTICE_HOPS = 8;
export const PAIR_LIMIT = 6;
const PAIR_WINDOW_MS = 3_600_000;
/** An answer nobody gave is given up on. */
const ANSWER_WAIT_MS = 2 * 86_400_000;
/** Mail still waiting for its target this long: the sender is told why, and when it will be dropped. */
export const HELD_NOTICE_MS = 6 * 3_600_000;
const MAX_TEXT = 8_000;
/** How long a started thread may take to show up on the desk. */
const START_GRACE_MS = 10 * 60_000;
/** Threads one conversation may start an hour, and how deep a chain of started threads may go. */
export const START_LIMIT = 5;
export const MAX_START_DEPTH = 3;
const MAX_ANSWER = 6_000;
/** An agent message this long, right before its last one, is part of the answer (a split post), not a progress note. */
const ANSWER_PART = 1_500;
/** Relaying an answer back is tried this many times before the mail is marked failed. */
const RELAY_ATTEMPTS = 5;

/** `✉️ Mail from “Title” [itemId] · m-abc123`: the first line of every mail turn and note. */
export const MAIL_HEADER = /^✉️ (Mail from|Reply from|Mail to|Started) “([^”]*)” \[([^\]]+)\] · (m-[a-z0-9]+)[^\S\n]*\n?/mu;
/** A Discord conversation gets a desk reply as one bot post, cut at this many characters. */
export const DISCORD_TURN_MAX = 1800;

/** The owner's mail-off list (the `mail_off` setting): item ids and `project:<id>` keys. */
export function readMailOff(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export interface MailHeader {
  kind: 'from' | 'reply' | 'to' | 'started';
  title: string;
  itemId: string;
  mailId: string;
  body: string;
}

export function parseMailHeader(text: string): MailHeader | null {
  // The header opens the turn; a relay may put one line of its own ahead of it (an older bot's
  // "The owner replied from the screen" wrapper on Discord), never more.
  const m = MAIL_HEADER.exec(text.trimStart());
  if (!m || text.trimStart().slice(0, m.index).split('\n').length > 2) return null;
  const kind = m[1] === 'Mail from' ? 'from' : m[1] === 'Reply from' ? 'reply' : m[1] === 'Started' ? 'started' : 'to';
  // The footer the desk adds for the agent ("— Sent by …") is not part of what was said.
  const body = text.trimStart().slice(m.index + m[0].length).replace(/\n+— (Sent through the desk|This answers your mail|Started through the desk|If it still matters)[\s\S]*$/u, '').trim();
  return { kind, title: m[2]!, itemId: m[3]!, mailId: m[4]!, body };
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const quoteTitle = (title: string) => title.replace(/[“”[\]\n]/g, '').slice(0, 120) || 'a conversation';

/** The turn the target gets. */
/** Mail is backstage: the owner sees it on the desk, and hears about it from the agent only if it changes their plan. */
const BACKSTAGE = 'Don’t tell the owner about this exchange separately; if it changes their plan, say so in one line (“Meanwhile: …”) the next time you reply to them.';

export function mailTurn(mail: Pick<DeskMailRecord, 'id' | 'fromItemId' | 'fromTitle' | 'text' | 'expect'>, options: { midTurn?: boolean } = {}): string {
  const how =
    mail.expect !== 'reply'
      ? 'No reply needed.'
      : options.midTurn
        ? `You may be in the middle of other work: answer it with one command, \`tango-screen reply ${mail.id} "<your answer>"\`, then carry on. Keep it brief and don’t start new work just to answer.`
        : 'Answer it in your reply: the desk takes your reply back to them. Keep it brief, don’t start new work just to answer, and leave off any closing “Next —” line.';
  return `✉️ Mail from “${quoteTitle(mail.fromTitle)}” [${mail.fromItemId}] · ${mail.id}\n\n${mail.text}\n\n— Sent through the desk by another agent’s conversation. ${how} ${BACKSTAGE} To write to them yourself later, send mail to ${mail.fromItemId}.`;
}

/**
 * A worker's word to what it reports to is not backstage: the owner never sees the worker (it reports up,
 * docs/specs/spaces.md), so this conversation speaks for it, in place (owner, 10/18).
 */
/** In the turn text of a worker's answer, and nowhere in an ordinary peer's: how the desk tells them apart afterwards. */
export const SPEAK_FOR_MARK = 'you speak for it';
const SPEAK_FOR = 'It reports to you, and the owner doesn’t see it: you speak for it. If it raised a decision brief (D-n), name its id with its link (`tango-screen decision D-n` prints it: the desk’s address plus /decision/D-n) in your next reply and stop: don’t restate the options. The owner opens the full brief from that link, the desk shows it on your conversation too, an answer either place resolves it and wakes it, and you hear how it went, so don’t pass that answer on. If it needs the owner’s decision on anything else or has something for them to look at, bring it to them in your next reply here, with the question, the options and your lean, and its links. Its screens and prototypes show on your conversation too, and a tap there answers it. Pass the owner’s answer to a question that isn’t a brief on to it yourself (`tango-screen send`); never send the owner to it. If it needs nothing from them, carry on.';

/** The turn the sender gets with the answer; `reportsUp` when it came from a worker this conversation owns. */
export function replyTurn(mail: Pick<DeskMailRecord, 'id' | 'toItemId' | 'toTitle' | 'text' | 'answer'> & { kind?: DeskMailRecord['kind'] }, options: { reportsUp?: boolean } = {}): string {
  const head = `✉️ Reply from “${quoteTitle(mail.toTitle)}” [${mail.toItemId}] · ${mail.id}\n\n${mail.answer ?? ''}\n\n`;
  if (mail.kind === 'report') return `${head}— Where it got to: the latest turn of a conversation working for you. ${SPEAK_FOR}`;
  return `${head}— This answers your mail (“${clip(mail.text.replace(/\s+/g, ' '), 100)}”). Carry on with what you were doing. ${options.reportsUp ? SPEAK_FOR : BACKSTAGE}`;
}

/** The opening turn of a thread another agent's conversation started: its task, and that its first answer goes back. */
export function startTurn(mail: Pick<DeskMailRecord, 'id' | 'fromItemId' | 'fromTitle' | 'text' | 'expect'>): string {
  const how =
    mail.expect === 'reply'
      ? 'When you finish this turn, your final reply goes back to them automatically: end with a short summary of what you did and anything they need to know, and leave off any closing “Next —” line.'
      : 'They don’t need a report back.';
  return `✉️ Mail from “${quoteTitle(mail.fromTitle)}” [${mail.fromItemId}] · ${mail.id}\n\n${mail.text}\n\n— Started through the desk by another agent’s conversation, which handed you this task. ${how} To ask them something, send mail to ${mail.fromItemId}.`;
}

/** The note the starting conversation keeps of the thread it started. */
export function startedNote(mail: Pick<DeskMailRecord, 'id' | 'toItemId' | 'toTitle' | 'text'>): string {
  return `✉️ Started “${quoteTitle(mail.toTitle)}” [${mail.toItemId}] · ${mail.id}\n\n${mail.text}`;
}

/** The note the sender's own conversation keeps of what it sent. */
export function sentNote(mail: Pick<DeskMailRecord, 'id' | 'toItemId' | 'toTitle' | 'text'>): string {
  return `✉️ Mail to “${quoteTitle(mail.toTitle)}” [${mail.toItemId}] · ${mail.id}\n\n${mail.text}`;
}

/**
 * The target's answer to mail `mailId`: anchored on the mail itself arriving in the conversation, its
 * last reply before the next thing anyone else said there (the owner, or other mail). `since`: nothing
 * before it can be the mail (when it landed).
 * Mail delivered together, before any reply, shares the reply that follows it (one turn answers them all).
 */
export function mailAnswer(messages: Array<{ author: string; at: number; text: string }>, mailId: string, since: number): { text: string; at: number } | null {
  let anchored = false;
  const run: Array<{ text: string; at: number }> = [];
  for (const m of [...messages].sort((a, b) => a.at - b.at)) {
    if (m.at < since - 60_000) continue;
    if (m.author === 'owner') {
      if (!anchored && parseMailHeader(m.text)?.mailId === mailId) {
        anchored = true;
        continue;
      }
      if (anchored && !run.length && parseMailHeader(m.text)?.kind === 'from') continue;
      // The desk's own notice to this conversation isn't anyone speaking (Codex review on #773).
      if (isDeskNotice(m.text)) continue;
      if (anchored) break;
      continue;
    }
    if (anchored && m.author === 'agent' && m.text.trim()) run.push({ text: m.text.trim(), at: m.at });
  }
  const last = run.at(-1);
  if (!last) return null;
  // The last message, with the long parts right before it: a Discord agent posts a long answer in
  // ~1900-character pieces (Codex review on #569). Short progress notes ("Checking.") stay out.
  let start = run.length - 1;
  while (start > 0 && run[start - 1]!.text.length >= ANSWER_PART) start -= 1;
  return { text: withoutNextLine(run.slice(start).map((m) => m.text).join('\n\n')), at: last.at };
}

const NOTICE_MARK = '(The desk, not “';
/** A turn the desk wrote about mail (noticeTurn), not a conversation's answer. */
export function isDeskNotice(text: string): boolean {
  const header = parseMailHeader(text);
  return header?.kind === 'reply' && header.body.startsWith(NOTICE_MARK);
}

/** Why a conversation isn't taking mail: what a held or dropped mail's sender is told. */
export function holdReason(item: Pick<DeskItem, 'facts' | 'disposition' | 'nextStep'>): string {
  const f = item.facts;
  const when = (at: number) => new Date(at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  if (item.disposition === 'done' || item.disposition === 'parked') return `it is ${item.disposition === 'done' ? 'finished' : 'parked'}`;
  if (f.pending) return `it has ${f.pending.kind === 'approval' ? 'an approval' : 'a question'} waiting since ${when(f.pending.at)} (“${clip((f.pending.question || f.pending.approval?.detail || '').replace(/\s+/g, ' '), 160)}”), and isn’t free until that is answered`;
  if (f.running) return `it has been working since ${when(f.running.since)}`;
  return 'it hasn’t been free since';
}

/** The turn a sender gets about mail the desk is holding or gave up on (headed as a reply, so it stays backstage). */
export function noticeTurn(mails: DeskMailRecord[], kind: MailNotice, reason: string, toTitle: string, max?: number): string {
  const first = mails[0]!;
  const when = (at: number) => new Date(at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  // Given up on for different reasons: each mail says its own (Codex review on #773).
  const reasons = new Set(mails.map((m) => m.error).filter(Boolean));
  const each = kind !== 'held' && reasons.size > 1;
  if (each) reason = 'each for the reason given below';
  const lines = mails.map((m) => `- ${m.id} (${when(m.createdAt)}): “${clip(m.text.replace(/\s+/g, ' '), 120)}”${each && m.error ? ` — ${clip(m.error, 160)}` : ''}`);
  const n = mails.length === 1 ? 'Your mail' : `Your ${mails.length} mails`;
  const ownerWait = kind === 'held' && mails.some((m) => m.deliveryExpiresAt === 0);
  const expiry = Math.min(...mails.map((m) => m.deliveryExpiresAt ?? m.createdAt + ANSWER_WAIT_MS));
  const body =
    kind === 'held'
      ? `${n} to “${quoteTitle(toTitle)}” ${mails.length === 1 ? 'hasn’t' : 'haven’t'} been delivered: ${reason}. ${ownerWait ? 'The desk keeps this mail until the owner answers, then delivers it when the conversation is free. Mail cannot answer or approve that request.' : `The desk drops queued mail if it is still blocked at ${when(expiry)}.`}`
      : kind === 'dropped'
        ? `${n} to “${quoteTitle(toTitle)}” ${mails.length === 1 ? 'was' : 'were'} dropped without being delivered: ${reason}.`
        : `${n} to “${quoteTitle(toTitle)}” got no answer and the desk stopped waiting: ${reason}.`;
  const next =
    kind === 'held'
      ? ownerWait ? 'No resend is needed. The owner wait has no time limit; after it clears, other blockers have two days before delivery expires.' : 'If it still matters, get what holds it cleared, or send it again later; if it no longer applies, carry on.'
      : 'If it still matters, send it again or find another way; otherwise carry on.';
  const turn = (listed: string) => `✉️ Reply from “${quoteTitle(toTitle)}” [${first.toItemId}] · ${first.id}\n\n${NOTICE_MARK}${quoteTitle(toTitle)}”:) ${clip(body, 600)}\n${listed}\n\n— ${next} ${BACKSTAGE}`;
  // One post on Discord: list what fits, and count the rest (Codex review on #773).
  let shown = lines.length;
  const listed = () => [...lines.slice(0, shown), ...(shown < lines.length ? [`- and ${lines.length - shown} more`] : [])].join('\n');
  while (max && shown > 0 && turn(listed()).length > max) shown -= 1;
  return turn(listed());
}

const COLUMNS = `
  id TEXT PRIMARY KEY,
  from_item TEXT NOT NULL,
  to_item TEXT NOT NULL,
  from_title TEXT NOT NULL,
  to_title TEXT NOT NULL,
  text TEXT NOT NULL,
  expect TEXT NOT NULL,
  state TEXT NOT NULL,
  chain TEXT NOT NULL,
  hops INTEGER NOT NULL,
  urgent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  answer TEXT,
  answered_at INTEGER,
  relayed_at INTEGER,
  relayed_via TEXT,
  error TEXT`;

type Row = Record<string, string | number | null>;

function toRecord(row: Row): DeskMailRecord {
  return {
    id: row.id as string,
    fromItemId: row.from_item as string,
    toItemId: row.to_item as string,
    fromTitle: row.from_title as string,
    toTitle: row.to_title as string,
    text: row.text as string,
    expect: row.expect as MailExpect,
    kind: (row.kind as 'mail' | 'start' | 'report' | null) ?? 'mail',
    state: row.state as MailState,
    chain: row.chain as string,
    hops: row.hops as number,
    urgent: row.urgent === 1,
    wake: row.wake === 1,
    steered: row.steered === 1,
    deliveryExpiresAt: (row.delivery_expires_at as number | null) ?? null,
    createdAt: row.created_at as number,
    sentAt: (row.sent_at as number | null) ?? null,
    answer: (row.answer as string | null) ?? null,
    answeredAt: (row.answered_at as number | null) ?? null,
    relayedAt: (row.relayed_at as number | null) ?? null,
    relayedVia: (row.relayed_via as DeskMailRecord['relayedVia']) ?? null,
    error: (row.error as string | null) ?? null,
    notice: (row.notice as MailNotice | null) ?? null,
    noticed: row.noticed ? (String(row.noticed).split(',') as MailNotice[]) : [],
  };
}

/** One conversation as another agent sees it in `threads`. */
export interface MailThread {
  id: string;
  title: string;
  agent: string;
  source: string;
  project: string | null;
  status: string;
  disposition: string;
  idle: boolean;
  lastActivityAt: string;
  gist: string | null;
  ask: string | null;
  mail: 'on' | 'off';
}

export type SendResult = { ok: true; mail: DeskMailRecord } | { ok: false; error: string };

export interface DeskMailDeps {
  core: DeskCore;
  db: DatabaseSync;
  /** Agents that neither send nor receive mail (isolated agents). */
  blockedAgents?: Iterable<string>;
  /**
   * Into a Loom thread's turn in progress (read as soon as its current step finishes), else a turn of its
   * own: Loom delivers mail at once instead of the desk waiting for the thread to go idle.
   */
  steer?: (item: DeskItem, text: string, origin: { name: string; from: string; mailId: string }, commandId: string) => Promise<{ ok: true; steered: boolean } | { ok: false; error: string; unknown?: boolean }>;
  /** Start work (start-work.ts): how a conversation starts a new thread. Absent: `start` is refused. */
  startWork?: { start(request: StartWorkRequest): Promise<StartResult>; afterStart?: () => void };
  now?: () => number;
  log?: Log;
}

/** The word another agent gets for a row (the threads command's status filter), from the evaluator (desk/status.ts). */
export function statusWord(item: Parameters<typeof deskStatus>[0]): string {
  const { pill } = deskStatus(item);
  return pill === 'needs' ? 'needs you' : pill;
}

export class DeskMail {
  private readonly blocked: Set<string>;
  /** Starts still launching, per starting conversation (they count against its hourly limit). */
  private readonly launching = new Map<string, number>();
  /** Mails being sent or relayed right now: a tick and a send never do one twice. */
  private readonly busy = new Set<string>();

  constructor(private readonly deps: DeskMailDeps) {
    this.blocked = new Set(deps.blockedAgents ?? []);
    deps.db.exec(`CREATE TABLE IF NOT EXISTS desk_mail (${COLUMNS});
      CREATE INDEX IF NOT EXISTS desk_mail_state ON desk_mail(state);
      CREATE INDEX IF NOT EXISTS desk_mail_from ON desk_mail(from_item, created_at);
      CREATE INDEX IF NOT EXISTS desk_mail_to ON desk_mail(to_item, created_at);`);
    // `start`: the row of a thread one conversation started (its opening turn is the mail), added 10/16.
    const columns = new Set((deps.db.prepare('PRAGMA table_info(desk_mail)').all() as Array<{ name: string }>).map((c) => c.name));
    if (!columns.has('wake')) deps.db.exec('ALTER TABLE desk_mail ADD COLUMN wake INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('kind')) deps.db.exec("ALTER TABLE desk_mail ADD COLUMN kind TEXT NOT NULL DEFAULT 'mail'");
    // Delivered into a turn in progress (a Loom thread): answered by an explicit reply, added 10/16.
    if (!columns.has('steered')) deps.db.exec('ALTER TABLE desk_mail ADD COLUMN steered INTEGER NOT NULL DEFAULT 0');
    // Notices to the sender when its mail is held, dropped or unanswered (10/19): mail that ended before this says nothing.
    if (!columns.has('notice')) deps.db.exec('ALTER TABLE desk_mail ADD COLUMN notice TEXT');
    if (!columns.has('noticed')) deps.db.exec('ALTER TABLE desk_mail ADD COLUMN noticed TEXT');
    if (!columns.has('delivery_expires_at')) deps.db.exec('ALTER TABLE desk_mail ADD COLUMN delivery_expires_at INTEGER');
    if (!columns.has('notice_at')) deps.db.exec('ALTER TABLE desk_mail ADD COLUMN notice_at INTEGER');
    // Workers' turns pass up from the first start with it (10/18): older turns aren't news to their owners.
    if (deps.core.store.setting('report_up_since') === null) deps.core.store.setSetting('report_up_since', String(this.now()));
  }

  private get core(): DeskCore {
    return this.deps.core;
  }
  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
  private log(event: string, data: Record<string, unknown> = {}): void {
    this.deps.log?.(event, data);
  }

  // ── storage ──

  get(id: string): DeskMailRecord | null {
    const row = this.deps.db.prepare('SELECT * FROM desk_mail WHERE id = ?').get(id) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  /** Mail to or from a conversation, newest first. */
  forItem(itemId: string, limit = 20): DeskMailRecord[] {
    return (this.deps.db.prepare('SELECT * FROM desk_mail WHERE from_item = ? OR to_item = ? ORDER BY created_at DESC LIMIT ?').all(itemId, itemId, limit) as Row[]).map(toRecord);
  }

  private open(): DeskMailRecord[] {
    return (this.deps.db.prepare("SELECT * FROM desk_mail WHERE state IN ('queued', 'sending', 'sent') OR (state = 'answered' AND relayed_at IS NULL) ORDER BY created_at, rowid").all() as Row[]).map(toRecord);
  }

  private set(id: string, patch: Partial<Pick<DeskMailRecord, 'state' | 'sentAt' | 'answer' | 'answeredAt' | 'relayedAt' | 'relayedVia' | 'error' | 'notice' | 'noticed'>>): void {
    const columns: Record<string, string> = { state: 'state', sentAt: 'sent_at', answer: 'answer', answeredAt: 'answered_at', relayedAt: 'relayed_at', relayedVia: 'relayed_via', error: 'error', notice: 'notice', noticed: 'noticed' };
    const entries = Object.entries(patch)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, Array.isArray(v) ? v.join(',') || null : v] as const);
    if (!entries.length) return;
    this.deps.db.prepare(`UPDATE desk_mail SET ${entries.map(([k]) => `${columns[k]} = ?`).join(', ')} WHERE id = ?`).run(...entries.map(([, v]) => v as string | number | null), id);
  }

  // ── who may write to whom ──

  private offList(): Set<string> {
    return new Set(readMailOff(this.core.store.setting('mail_off')));
  }

  /** The owner's switch: mail off (or back on) for one conversation (`itemId`) or a whole project (`project:<id>`). */
  setOff(key: string, off: boolean): string[] {
    const list = this.offList();
    if (off) list.add(key);
    else list.delete(key);
    this.core.store.setSetting('mail_off', JSON.stringify([...list]));
    return [...list];
  }

  mailOff(item: DeskItem): boolean {
    const list = this.offList();
    return list.has(item.id) || (!!item.facts.projectId && list.has(`project:${item.facts.projectId}`));
  }

  /** Isolated agents, hidden items and projects' coordinator threads (kept out of every reader) are out of mail's reach. */
  private reachable(item: DeskItem): boolean {
    return !this.blocked.has(item.agentId) && !item.hidden && !coordinatorItemIds(this.core.store.setting('coordinators')).has(item.id);
  }

  // ── reading ──

  thread(item: DeskItem): MailThread {
    return {
      id: item.id,
      title: this.core.title(item),
      agent: item.agentName,
      source: item.source,
      project: item.facts.projectId ?? null,
      status: statusWord(item),
      disposition: item.disposition,
      idle: isIdle(item),
      lastActivityAt: new Date(item.lastActivityAt).toISOString(),
      gist: item.summary?.gist ?? null,
      ask: item.ask ? clip(item.ask, 300) : null,
      mail: this.mailOff(item) ? 'off' : 'on',
    };
  }

  /** Every conversation an agent may see: open ones by default, newest first. */
  threads(filter: { project?: string; status?: string; agent?: string; all?: boolean; limit?: number } = {}): MailThread[] {
    const requested = filter.status?.toLowerCase();
    const status = requested === 'needs owner' || requested === 'needs' ? 'needs you' : requested === 'watching' ? 'waiting' : requested;
    return this.core
      .items()
      .filter((item) => this.reachable(item) && (filter.all || item.disposition !== 'done'))
      .filter((item) => !filter.project || item.facts.projectId === filter.project)
      .filter((item) => !filter.agent || item.agentId === filter.agent || item.agentName.toLowerCase() === filter.agent.toLowerCase())
      .map((item) => this.thread(item))
      .filter((t) => !status || t.status === status || t.disposition === status)
      .slice(0, Math.max(1, Math.min(200, filter.limit ?? 60)));
  }

  /** One conversation read-only: where it stands and its last messages. */
  peek(itemId: string, limit = 12) {
    const item = this.core.item(itemId);
    if (!item || !this.reachable(item)) return null;
    return {
      ...this.thread(item),
      summary: item.summary?.paragraph ?? null,
      messages: this.core.store.messages(item.id, Math.max(1, Math.min(60, limit))).map((m) => ({ author: m.author === 'agent' ? item.agentName : m.author, at: new Date(m.at).toISOString(), text: clip(m.text, 2_000) })),
      recentMail: this.forItem(item.id, 5).map((m) => this.view(m)),
    };
  }

  view(mail: DeskMailRecord) {
    const heldUntil = this.pairAvailableAt(mail);
    return { ...(heldUntil > this.now() ? { heldUntil: new Date(heldUntil).toISOString(), heldReason: 'hourly pair limit' } : {}), id: mail.id, kind: mail.kind, from: mail.fromItemId, fromTitle: mail.fromTitle, to: mail.toItemId, toTitle: mail.toTitle, text: mail.text, expect: mail.expect, state: mail.state, hops: mail.hops, createdAt: new Date(mail.createdAt).toISOString(), answer: mail.answer, error: mail.error };
  }

  // ── sending ──

  /** The mail the sender is answering right now, if its latest turn came by mail: what a new mail chains onto. */
  private chainOf(fromItemId: string): { chain: string; hops: number; expect: MailExpect } | null {
    // Its latest turn however much it has said since (a long run of replies mustn't reset the chain; Codex review on #569).
    const owner = this.deps.db.prepare("SELECT text FROM desk_messages WHERE item_id = ? AND author = 'owner' ORDER BY at DESC, message_id DESC LIMIT 1").get(fromItemId) as { text: string } | undefined;
    const header = owner ? parseMailHeader(owner.text) : null;
    // A desk notice isn't a peer's reply: mail sent after one starts afresh (Codex review on #773).
    if (!header || header.kind === 'to' || isDeskNotice(owner!.text)) return null;
    const prior = this.get(header.mailId);
    return prior ? { chain: prior.chain, hops: prior.hops, expect: prior.expect } : null;
  }

  /** Only recorded starts and successfully applied reopens establish this relationship. */
  private coordinatedPair(from: string, to: string): boolean {
    const records = this.deps.db.prepare(`SELECT id, kind FROM desk_mail
      WHERE ((from_item = ? AND to_item = ?) OR (from_item = ? AND to_item = ?))
      AND (kind = 'start' OR wake = 1)`).all(from, to, to, from) as Array<{ id: string; kind: string }>;
    return records.some((record) => record.kind === 'start'
      || this.core.store.command(`mail-wake-${record.id}`)?.status === 'applied');
  }

  send(request: { from: string; to: string; text: string; expect?: MailExpect; now?: boolean; wake?: boolean }): SendResult {
    const from = this.core.item(request.from);
    const to = this.core.item(request.to);
    const text = request.text?.trim();
    if (!from) return { ok: false, error: `the desk doesn’t know the sending conversation ${request.from}` };
    if (!to) return { ok: false, error: `no conversation ${request.to} on the desk (list them with threads)` };
    if (from.id === to.id) return { ok: false, error: 'a conversation can’t mail itself' };
    if (!text) return { ok: false, error: 'the mail is empty' };
    // A question waits for idle: sent into a running turn, that turn's own last words would read as its answer (Codex review on #569).
    if (request.now && request.expect !== 'none') return { ok: false, error: 'now is only for mail that needs no reply; a question is delivered when the conversation is next idle' };
    if (!this.reachable(from)) return { ok: false, error: 'this conversation can’t send mail' };
    if (!this.reachable(to)) return { ok: false, error: `${to.id} can’t receive mail` };
    if (this.mailOff(from)) return { ok: false, error: 'the owner switched mail off for this conversation' };
    if (this.mailOff(to)) return { ok: false, error: `the owner switched mail off for “${this.core.title(to)}”` };
    if ((to.disposition === 'done' || to.disposition === 'parked') && !request.wake) {
      return { ok: false, error: `“${this.core.title(to)}” is ${to.disposition}; send with wake to reopen it for this` };
    }
    // A Discord conversation takes the mail as one post: the whole turn has to fit, or the end (and the
    // instructions to answer) would be cut off while the mail counted as sent (Codex review on #569).
    if (to.source === 'discord') {
      const room = DISCORD_TURN_MAX - mailTurn({ id: 'm-00000000', fromItemId: from.id, fromTitle: this.core.title(from), text: '', expect: request.expect === 'none' ? 'none' : 'reply' }).length;
      if (text.length > room) return { ok: false, error: `“${this.core.title(to)}” is a Discord conversation: mail to it fits in ${room} characters (this is ${text.length}); shorten it` };
    }
    const at = this.now();
    const ownWorker = (from.facts.role === 'worker' && from.facts.parentItemId === to.id)
      || (to.facts.role === 'worker' && to.facts.parentItemId === from.id)
      || this.coordinatedPair(from.id, to.id)
      || (!!request.wake && (to.disposition === 'done' || to.disposition === 'parked'));
    // Coordination starts afresh at zero: it neither hits nor spends a later peer's hop budget.
    const prior = ownWorker ? null : this.chainOf(from.id);
    const hops = ownWorker ? 0 : (prior?.hops ?? 0) + (request.expect === 'none' || prior?.expect === 'none' ? 0 : 1);
    const id = `m-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const mail: DeskMailRecord = {
      id,
      fromItemId: from.id,
      toItemId: to.id,
      fromTitle: this.core.title(from),
      toTitle: this.core.title(to),
      text: clip(text, MAX_TEXT),
      expect: request.expect === 'none' ? 'none' : 'reply',
      state: this.needsApproval(from, to) ? 'draft' : 'queued',
      wake: !!request.wake,
      chain: prior?.chain ?? id,
      hops,
      urgent: !!request.now,
      createdAt: at,
      sentAt: null,
      answer: null,
      answeredAt: null,
      relayedAt: null,
      relayedVia: null,
      error: null,
    };
    this.deps.db
      .prepare('INSERT INTO desk_mail (id, from_item, to_item, from_title, to_title, text, expect, state, chain, hops, urgent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(mail.id, mail.fromItemId, mail.toItemId, mail.fromTitle, mail.toTitle, mail.text, mail.expect, mail.state, mail.chain, mail.hops, mail.urgent ? 1 : 0, mail.createdAt);
    this.deps.db.prepare('UPDATE desk_mail SET wake = ? WHERE id = ?').run(mail.wake ? 1 : 0, id);
    if (mail.state !== 'draft') this.activate(mail);
    else {
      this.core.touch(from.id);
      this.core.flush();
    }
    const heldUntil = this.pairAvailableAt(mail);
    return { ok: true, mail: { ...mail, ...(heldUntil > at ? { heldUntil } : {}) } };
  }

  /** Rolling delivery window, with earlier queued mail reserving the next available slots.
   * rowid breaks equal creation timestamps in insertion order. Recomputed after every delivery,
   * so old queued mail counts in the hour it actually goes out, not the hour it was written.
   */
  private pairAvailableAt(mail: DeskMailRecord): number {
    const at = this.now();
    if (mail.state !== 'queued') return at;
    const slots = (this.deps.db.prepare(`SELECT sent_at AS at FROM desk_mail
      WHERE from_item = ? AND to_item = ? AND sent_at > ? ORDER BY sent_at`)
      .all(mail.fromItemId, mail.toItemId, at - PAIR_WINDOW_MS) as Array<{ at: number }>).map((r) => r.at);
    const queued = this.deps.db.prepare(`SELECT id, state FROM desk_mail
      WHERE from_item = ? AND to_item = ? AND state IN ('queued', 'sending')
      AND sent_at IS NULL ORDER BY created_at, rowid`)
      .all(mail.fromItemId, mail.toItemId) as Array<{ id: string; state: string }>;
    // An in-flight send reserves a slot before its asynchronous transport returns.
    for (const row of queued) if (row.state === 'sending') slots.push(at);
    slots.sort((a, b) => a - b);
    let available = at;
    for (const row of queued) {
      if (row.state !== 'queued') continue;
      if (slots.length >= PAIR_LIMIT) available = Math.max(available, slots[slots.length - PAIR_LIMIT]! + PAIR_WINDOW_MS);
      if (row.id === mail.id) return available;
      slots.push(available);
    }
    return at;
  }

  private needsApproval(from: DeskItem, to: DeskItem): boolean {
    const space = this.core.spaceOfItem(from);
    return kindOf(from) === 'default' && !!space && space === this.core.spaceOfItem(to)
      && readSpaces(this.core.store.setting('spaces'))[space]?.permissions?.messageConversations === false;
  }

  /** Pending owner approvals, kept out of the delivery queue even across restarts. */
  drafts(itemId: string): DeskMailRecord[] {
    return (this.deps.db.prepare("SELECT * FROM desk_mail WHERE from_item = ? AND state = 'draft' ORDER BY created_at").all(itemId) as Row[]).map(toRecord);
  }

  /** Owner approval uses the same mail id, delivery and reply collection as a direct send. */
  draftAction(id: string, action: 'send' | 'drop', text?: string): SendResult {
    const mail = this.get(id);
    if (!mail || mail.state !== 'draft') return { ok: false, error: 'that mail is no longer a draft' };
    if (action === 'drop') {
      this.set(id, { state: 'dropped' });
      this.core.touch(mail.fromItemId);
      this.core.flush();
      return { ok: true, mail: this.get(id)! };
    }
    const from = this.core.item(mail.fromItemId);
    const to = this.core.item(mail.toItemId);
    if (!from || !to || !this.reachable(from) || !this.reachable(to) || this.mailOff(from) || this.mailOff(to)) return { ok: false, error: 'mail between these conversations is no longer allowed' };
    const words = (text ?? mail.text).trim();
    if (!words || words.length > MAX_TEXT) return { ok: false, error: `mail must contain 1–${MAX_TEXT} characters` };
    if (to.source === 'discord' && mailTurn({ ...mail, text: words }).length > DISCORD_TURN_MAX) return { ok: false, error: 'mail is too long for this Discord conversation' };
    if ((to.disposition === 'done' || to.disposition === 'parked') && !mail.wake) return { ok: false, error: 'the recipient is no longer open; discard this draft or reopen the conversation first' };
    this.deps.db.prepare("UPDATE desk_mail SET text = ?, state = 'queued', created_at = ? WHERE id = ? AND state = 'draft'").run(words, this.now(), id);
    const approved = this.get(id)!;
    this.activate(approved);
    return { ok: true, mail: approved };
  }

  private activate(mail: DeskMailRecord): void {
    const from = this.core.item(mail.fromItemId)!;
    const to = this.core.item(mail.toItemId)!;
    const { id, createdAt: at } = mail;
    // Persist deduplication independently of feed retention and DeskMail restarts.
    const noticeKey = `mail-depth-notice:${mail.chain}`;
    if (mail.hops > DEPTH_NOTICE_HOPS && !this.core.store.marker(noticeKey)) {
      this.core.postFeed({ kind: 'update', itemId: from.id,
        projectId: from.facts.projectId ?? to.facts.projectId ?? null,
        title: 'Long mail exchange',
        text: `${mail.fromTitle} and ${mail.toTitle} have passed ${DEPTH_NOTICE_HOPS} reply-requesting mails without an owner post. Mail continues to be delivered.`,
        data: { chain: mail.chain, from: from.id, to: to.id }, key: noticeKey });
      this.core.store.setMarker(noticeKey, String(at));
    }
    // Agents talking is feed news only when the owner asks for it (feed settings: chatter); kept either way.
    // One line per pair of threads at most every few minutes: a burst of mail is one post, counted.
    this.core.postFeed({ kind: 'mail', projectId: from.facts.projectId ?? to.facts.projectId ?? null, agentName: from.agentName, title: `${mail.fromTitle} → ${mail.toTitle}`, text: mail.text, data: { pair: [from.id, to.id].sort().join('|'), from: from.id, to: to.id }, key: `mail:${[from.id, to.id].sort().join('|')}`, throttleMs: 7 * 60_000 });
    // The sender's conversation keeps what it sent, where the owner reads it.
    this.core.recordMessage(from.id, { messageId: `mail:${id}:out`, author: 'other', at, text: sentNote(mail) });
    this.core.flush();
    this.log('desk.mail.queued', { id, from: from.id, to: to.id, hops: mail.hops, expect: mail.expect, urgent: mail.urgent });
    // Woken first (a parked one picked up, a finished one reopened), then delivered.
    const wake =
      mail.wake && to.disposition !== 'active'
        ? this.core.command({ commandId: `mail-wake-${id}`, type: to.disposition === 'done' ? 'reopen' : 'pickup', itemId: to.id, actor: 'agent' }).catch(() => undefined)
        : Promise.resolve();
    void wake.then(() => this.tick()).catch((err) => this.log('desk.mail.tick.error', { message: (err as Error).message }));
  }

  /**
   * The owner wrote in a conversation that reports up (DeskCore.onOwnerPostedUp): what it reports to hears the words
   * at once, with the decision they answer, so it never asks the owner again (TGO-1075; docs/specs/spaces.md).
   */
  ownerPostUp(post: OwnerPostUp): SendResult {
    const quoted = clip(post.text, 1200).replace(/\n/g, '\n> ');
    const text = `The owner's words went straight to “${post.title}” [${post.itemId}], which reports to you:\n\n> ${quoted}\n\n${post.decisionId ? `They concern decision ${post.decisionId}. ` : ''}Their words there count everywhere: take them as said to you too, and don't ask the owner again about what they settle.`;
    const sent = this.send({ from: post.itemId, to: post.parentItemId, text, expect: 'none', now: true });
    if (sent.ok) return sent;
    // The owner's own words aren't optional chatter: what mail refuses (switched off, parked or done, the hourly
    // limit) still reaches the conversation, straight into it (Codex review on #781).
    this.log('desk.mail.owner_post_up.direct', { itemId: post.itemId, to: post.parentItemId, refused: sent.error });
    const to = this.core.item(post.parentItemId);
    if (!to) return sent;
    // One id per message (the source's own): two posts, even the same words in the same millisecond, are two deliveries (Codex review on #781).
    const id = `m-up-${createHash('sha256').update(`${post.itemId}|${post.messageId}`).digest('hex').slice(0, 12)}`;
    const turn = mailTurn({ id, fromItemId: post.itemId, fromTitle: post.title, text, expect: 'none' });
    const delivered = to.source === 'loom' && this.deps.steer
      ? this.deps.steer(to, turn, { name: post.title, from: post.itemId, mailId: id }, `owner-up-${id}`)
      : this.core.command({ commandId: `owner-up-${id}`, type: 'reply', itemId: to.id, args: { text: turn }, actor: 'agent' }).then((result) => (result.status === 'applied' ? { ok: true as const, steered: false } : { ok: false as const, error: String(result.error ?? result.status) }));
    void delivered
      .then((result) => { if (!result.ok) this.log('desk.mail.owner_post_up.error', { itemId: post.itemId, to: to.id, error: result.error }); })
      .catch((err) => this.log('desk.mail.owner_post_up.error', { itemId: post.itemId, to: to.id, error: (err as Error).message }));
    return sent;
  }

  /** How many threads deep `itemId` is: started by a conversation that was itself started, and so on. */
  private startDepth(itemId: string): number {
    let depth = 0;
    let at = itemId;
    const up = this.deps.db.prepare("SELECT from_item FROM desk_mail WHERE to_item = ? AND kind = 'start' LIMIT 1");
    while (depth <= MAX_START_DEPTH) {
      const row = up.get(at) as { from_item: string } | undefined;
      if (!row) break;
      depth += 1;
      at = row.from_item;
    }
    return depth;
  }

  /**
   * A conversation starts a new thread (Start work, on Loom's best account unless it asks for another):
   * in its own repo and project unless told otherwise. The task is the opening turn, headed as mail from
   * the starter, and the new thread's first answer goes back to the starter like any mail's answer.
   */
  async start(request: { from: string; prompt: string; title?: string; repo?: string; projectId?: string | null; account?: string; mode?: string; sameTree?: boolean; report?: boolean; commandId?: string; role?: ThreadRole; tier?: string }): Promise<SendResult & { itemId?: string; projectSkipped?: boolean }> {
    const startWork = this.deps.startWork;
    if (!startWork) return { ok: false, error: 'this desk can’t start threads (Start work isn’t set up)' };
    const from = this.core.item(request.from);
    const prompt = request.prompt?.trim();
    if (!from) return { ok: false, error: `the desk doesn’t know the starting conversation ${request.from}` };
    if (!prompt) return { ok: false, error: 'say what the new thread should do' };
    if (!this.reachable(from)) return { ok: false, error: 'this conversation can’t start threads' };
    if (this.mailOff(from)) return { ok: false, error: 'the owner switched agent mail (and starting threads) off for this conversation' };
    // A retry of the same start (its commandId) is the same thread and the same record, never a second one (Codex review on #572).
    const id = request.commandId ? `m-${createHash('sha1').update(`start:${from.id}:${request.commandId}`).digest('hex').slice(0, 8)}` : `m-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const earlier = request.commandId ? this.get(id) : null;
    if (earlier) return { ok: true, mail: earlier, itemId: earlier.toItemId };
    const at = this.now();
    // Starts still launching count too: parallel calls can't all slip under the limit (Codex review on #572).
    const recent = (this.deps.db.prepare("SELECT COUNT(*) AS n FROM desk_mail WHERE from_item = ? AND kind = 'start' AND created_at > ?").get(from.id, at - PAIR_WINDOW_MS) as { n: number }).n + (this.launching.get(from.id) ?? 0);
    if (recent >= START_LIMIT) return { ok: false, error: `this conversation already started ${recent} threads this hour; ask the owner instead` };
    const depth = this.startDepth(from.id);
    if (depth >= MAX_START_DEPTH) return { ok: false, error: `this thread is ${depth} starts deep; tell the owner instead of starting another` };
    // In the starter's repo and project unless told otherwise.
    const repo = request.repo?.trim() || from.facts.project?.name || undefined;
    if (!repo) return { ok: false, error: 'which repo? (this conversation isn’t in one: pass repo)' };
    const projectId = request.projectId === null ? null : request.projectId?.trim() || from.facts.projectId || null;
    if (projectId) {
      const project = readProjects(this.core.store.setting('projects')).find((p) => p.id === projectId);
      if (!project || project.finishedAt) return { ok: false, error: project ? `${project.name} is finished` : `no desk project ${projectId}` };
    }
    const expect: MailExpect = request.report === false ? 'none' : 'reply';
    const fromTitle = this.core.title(from);
    const title = clip((request.title?.trim() || prompt.split('\n')[0]!.replace(/^[#>*\-\s]+/, '')).replace(/\s+/g, ' '), 80);
    const text = clip(prompt, MAX_TEXT);
    this.launching.set(from.id, (this.launching.get(from.id) ?? 0) + 1);
    let started: StartResult;
    try {
      started = await startWork.start({
        repo,
        prompt: startTurn({ id, fromItemId: from.id, fromTitle, text, expect }),
        title,
        ...(request.account ? { account: request.account } : { account: LOOM_ACCOUNT.id }),
        ...(request.mode ? { mode: request.mode } : {}),
        ...(request.sameTree ? { sameTree: true } : {}),
        commandId: request.commandId ?? `start-${id}`,
        role: request.role ?? 'worker',
        ...(request.tier ? { tier: request.tier } : {}),
        parentItemId: from.id,
      });
    } finally {
      const left = (this.launching.get(from.id) ?? 1) - 1;
      if (left > 0) this.launching.set(from.id, left);
      else this.launching.delete(from.id);
    }
    if (!started.ok) return { ok: false, error: started.error };
    // The project finished or went while the thread launched: it started on its own, and says so (Codex review on #572).
    const projectSkipped = projectId ? !this.core.assignProject(started.itemId, projectId) : false;
    startWork.afterStart?.();
    const mail: DeskMailRecord = {
      id, fromItemId: from.id, toItemId: started.itemId, fromTitle, toTitle: title, text, expect,
      state: expect === 'reply' ? 'sent' : 'done', chain: id, hops: 1, urgent: false, createdAt: at, sentAt: at,
      answer: null, answeredAt: null, relayedAt: null, relayedVia: null, error: null,
    };
    this.deps.db
      // OR IGNORE: a retry racing the first (Start work hands both the same thread) files it once.
      .prepare("INSERT OR IGNORE INTO desk_mail (id, from_item, to_item, from_title, to_title, text, expect, state, chain, hops, urgent, created_at, sent_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'start')")
      .run(mail.id, mail.fromItemId, mail.toItemId, mail.fromTitle, mail.toTitle, mail.text, mail.expect, mail.state, mail.chain, mail.hops, mail.createdAt, at);
    // A started thread is a worker under its starter unless it was started as something else (roles.ts).
    if (request.role && request.role !== 'worker') this.core.roles.set(started.itemId, { role: request.role, parentItemId: from.id }, 'agent', at);
    this.core.roles.invalidate();
    this.core.recordMessage(from.id, { messageId: `mail:${id}:started`, author: 'other', at, text: startedNote(mail) });
    this.core.flush();
    this.log('desk.mail.started', { id, from: from.id, itemId: started.itemId, repo, projectId, report: expect === 'reply' });
    return { ok: true, mail, itemId: started.itemId, ...(projectSkipped ? { projectSkipped: true } : {}) };
  }

  /**
   * The recipient's explicit answer (`tango-screen reply`): for mail read mid-turn, and any mail its
   * recipient prefers to answer directly. Only the conversation the mail went to may answer it.
   */
  answer(id: string, fromItemId: string, text: string): { ok: true; mail: DeskMailRecord } | { ok: false; error: string } {
    const mail = this.get(id);
    if (!mail) return { ok: false, error: `no mail ${id}` };
    if (mail.toItemId !== fromItemId) return { ok: false, error: `${id} wasn’t sent to this conversation` };
    if (mail.expect !== 'reply') return { ok: false, error: `${id} needs no reply` };
    if (mail.state === 'answered' || mail.relayedAt) return { ok: false, error: `${id} is already answered` };
    // `sending` too: a recipient can answer before the desk hears back that delivery went (Codex review on #575).
    if (mail.state !== 'sent' && mail.state !== 'sending') return { ok: false, error: `${id} is ${mail.state}` };
    const answer = text.trim();
    if (!answer) return { ok: false, error: 'the answer is empty' };
    const at = this.now();
    this.set(id, { state: 'answered', answer: clip(answer, MAX_ANSWER), answeredAt: at });
    // The recipient's own record of what it answered: its Mail tab shows the answer with the question.
    this.core.recordMessage(fromItemId, { messageId: `mail:${id}:answer`, author: 'other', at, text: clip(answer, MAX_ANSWER), meta: { mail: { kind: 'out', peer: mail.fromTitle, peerId: mail.fromItemId, mailId: id, inline: true, answers: true } } });
    this.core.flush();
    this.log('desk.mail.answered', { id, explicit: true });
    void this.tick().catch((err) => this.log('desk.mail.tick.error', { message: (err as Error).message }));
    return { ok: true, mail: this.get(id)! };
  }

  /** `tango-screen wait`: the answer, read by the sender itself (it isn't also relayed as a turn). */
  claim(id: string): DeskMailRecord | null {
    const mail = this.get(id);
    if (!mail) return null;
    if (mail.state === 'answered' && !mail.relayedAt && !this.busy.has(mail.id)) {
      this.set(id, { relayedAt: this.now(), relayedVia: 'wait' });
      // Read once: mail that shares this answer isn't relayed again as a turn (Codex review on #771).
      this.markSiblingsRelayed(mail, 'wait');
      this.log('desk.mail.claimed', { id });
      return this.get(id);
    }
    return mail;
  }

  // ── the tick: deliver, collect answers, relay them ──

  private ready(item: DeskItem, urgent: boolean): boolean {
    if (item.disposition === 'done' || item.disposition === 'parked') return false;
    // A generic reply could answer a source's live question. Only Loom's peer steer may bypass it.
    if (item.facts.pending) return false;
    return urgent || (item.disposition === 'active' && isIdle(item));
  }

  private async deliver(mail: DeskMailRecord): Promise<void> {
    const to = this.core.item(mail.toItemId);
    if (!to) {
      this.giveUp(mail, 'dropped', 'that conversation is gone');
      return;
    }
    // Allowed still: the owner may have switched mail off, or an agent become isolated, while it waited (Codex review on #569).
    const from = this.core.item(mail.fromItemId);
    if (!from || !this.reachable(from) || !this.reachable(to) || this.mailOff(from) || this.mailOff(to)) {
      this.giveUp(mail, 'dropped', 'mail between these conversations is no longer allowed');
      this.log('desk.mail.dropped', { id: mail.id });
      return;
    }
    // A wake was spent at send; owner waits do not override a later park or finish.
    if (to.disposition === 'done' || to.disposition === 'parked') {
      this.giveUp(mail, 'dropped', `that conversation was ${to.disposition === 'done' ? 'finished' : 'parked'} before it was free`);
      this.log('desk.mail.dropped', { id: mail.id });
      return;
    }
    // Loom submits peer-origin words, never an answer to an owner request. Other sources must
    // keep their pending prompt intact, including urgent mail. Persist the pause across restarts.
    const steer = to.source === 'loom' && this.deps.steer ? this.deps.steer : null;
    if (!steer && to.facts.pending) {
      this.deps.db.prepare('UPDATE desk_mail SET delivery_expires_at = 0 WHERE id = ?').run(mail.id);
      return;
    }
    let expiresAt = mail.deliveryExpiresAt ?? mail.createdAt + ANSWER_WAIT_MS;
    if (expiresAt === 0) {
      // The owner's answer may resume a long turn. Give it a fresh delivery window to settle.
      expiresAt = this.now() + ANSWER_WAIT_MS;
      this.deps.db.prepare('UPDATE desk_mail SET delivery_expires_at = ? WHERE id = ?').run(expiresAt, mail.id);
    }
    // Try safe delivery before expiry: an owner may answer while the desk is offline.
    if (!steer && !this.ready(to, mail.urgent)) {
      if (this.now() > expiresAt) {
        this.giveUp(mail, 'dropped', `that conversation was never free for it: ${holdReason(to)}`);
        this.log('desk.mail.dropped', { id: mail.id });
      }
      return;
    }
    // Urgency bypasses idle, never the pair delivery budget. Owner waits and expiry run first.
    if (this.pairAvailableAt(mail) > this.now()) return;
    this.busy.add(mail.id);
    const attemptAt = this.now();
    this.set(mail.id, { state: 'sending' });
    try {
      if (steer) {
        // The instructions hold either way it lands (a turn can start between the desk's look and Loom's):
        // answer with `tango-screen reply` (Codex review on #575).
        const sent = await steer(to, mailTurn(mail, { midTurn: true }), { name: mail.fromTitle, from: mail.fromItemId, mailId: mail.id }, `mail-${mail.id}`);
        if (!sent.ok && !sent.unknown) {
          this.set(mail.id, { state: 'failed', error: sent.error });
          this.log('desk.mail.failed', { id: mail.id, error: sent.error });
          return;
        }
        // Read mid-turn: its answer is the agent's explicit reply (`tango-screen reply`), not the end of the turn it lands in.
        // Unknown (a timeout after Loom took it): it may be mid-turn, so its answer is the explicit reply the
        // instructions ask for in every case, never a guess from the turn's words (Codex review on #575).
        const steered = sent.ok ? sent.steered : true;
        this.deps.db.prepare('UPDATE desk_mail SET steered = ?, sent_at = COALESCE(sent_at, ?) WHERE id = ?').run(steered ? 1 : 0, attemptAt, mail.id);
        // Answered while the delivery was still coming back: that answer stands.
        if (this.get(mail.id)?.state === 'sending') this.set(mail.id, { state: mail.expect === 'reply' ? 'sent' : 'done', sentAt: attemptAt, error: null });
        this.log('desk.mail.sent', { id: mail.id, to: mail.toItemId, steered, unknown: !sent.ok });
        return;
      }
      const result = await this.core.command({ commandId: `mail-${mail.id}`, type: 'reply', itemId: mail.toItemId, args: { text: mailTurn(mail) }, actor: 'agent' });
      // A timeout after the source took it may have delivered it: counted as sent, never sent twice.
      const unknown = result.status === 'failed' && result.outcome?.delivery === 'unknown';
      if (result.status !== 'applied' && !unknown) {
        this.set(mail.id, { state: 'failed', error: result.error ?? 'not delivered' });
        this.log('desk.mail.failed', { id: mail.id, error: result.error });
        return;
      }
      this.set(mail.id, { state: mail.expect === 'reply' ? 'sent' : 'done', sentAt: attemptAt, error: null });
      this.log('desk.mail.sent', { id: mail.id, to: mail.toItemId, unknown });
    } finally {
      this.busy.delete(mail.id);
    }
  }

  private collect(mail: DeskMailRecord): void {
    const to = this.core.item(mail.toItemId);
    // Read mid-turn: otherwise requires the agent's explicit reply (`answer`), or is given up on.
    if (mail.steered) {
      if (to && isIdle(to) && this.collectBackMail(mail)) return;
      if (!to || this.now() - (mail.sentAt ?? mail.createdAt) > ANSWER_WAIT_MS) this.giveUp(mail, 'unanswered', to ? 'no answer in two days' : 'that conversation is gone');
      return;
    }
    // Everything since it was written, however long the answer ran (a fixed window could lose the mail itself; Codex review on #569).
    // From the mail landing, wherever its record's clock says: a start retried after a timeout files its record
    // minutes after the thread's opening turn (the mail itself) was filed.
    const landed = this.deps.db.prepare("SELECT MIN(at) AS at FROM desk_messages WHERE item_id = ? AND author = 'owner' AND instr(text, ?) > 0").get(mail.toItemId, `· ${mail.id}`) as { at: number | null } | undefined;
    // Where it landed when found (mail queued for long would otherwise scan everything said meanwhile), else its creation.
    const floor = landed?.at ?? mail.createdAt;
    const since = mail.sentAt ? (this.deps.db.prepare('SELECT author, at, text FROM desk_messages WHERE item_id = ? AND at >= ? ORDER BY at, message_id LIMIT 2000').all(mail.toItemId, floor - 60_000) as Array<{ author: string; at: number; text: string }>) : [];
    const found = to && mail.sentAt ? mailAnswer(since, mail.id, floor) : null;
    if (!found && to && isIdle(to) && this.collectBackMail(mail)) return;
    // A thread just started: its source reports it within a poll or two.
    if (!to && this.now() - (mail.sentAt ?? mail.createdAt) < START_GRACE_MS) return;
    if (!to || (!found && this.now() - (mail.sentAt ?? mail.createdAt) > ANSWER_WAIT_MS)) {
      this.giveUp(mail, 'unanswered', to ? 'no answer in two days' : 'that conversation is gone');
      return;
    }
    // The whole answer: the reply isn't done until the target is idle again.
    if (!found || !isIdle(to)) return;
    this.set(mail.id, { state: 'answered', answer: clip(found.text, MAX_ANSWER), answeredAt: found.at });
    this.log('desk.mail.answered', { id: mail.id });
  }

  /** Called only once the recipient is idle and no transcript answer was found. */
  private collectBackMail(mail: DeskMailRecord): boolean {
    // A separately sent answer already travels back as mail; do not relay it a second time.
    const back = this.deps.db.prepare(`SELECT text, created_at FROM desk_mail
      WHERE from_item = ? AND to_item = ? AND created_at > ? AND created_at <= ?
        AND state NOT IN ('draft', 'dropped', 'failed') AND kind != 'report'
      ORDER BY created_at DESC, id DESC LIMIT 1`).get(mail.toItemId, mail.fromItemId, mail.sentAt ?? mail.createdAt, this.now()) as { text: string; created_at: number } | undefined;
    if (back) {
      this.set(mail.id, { state: 'answered', answer: clip(back.text, MAX_ANSWER), answeredAt: back.created_at, relayedAt: this.now(), relayedVia: 'mail' });
      this.log('desk.mail.answered', { id: mail.id, via: 'mail' });
      return true;
    }
    return false;
  }

  /** Mail delivered together shares one answer (mailAnswer): the one turn that relays it answers all of it. */
  private markSiblingsRelayed(mail: DeskMailRecord, via: 'turn' | 'wait' = 'turn'): number {
    const res = this.deps.db
      .prepare("UPDATE desk_mail SET relayed_at = ?, relayed_via = ? WHERE from_item = ? AND to_item = ? AND state = 'answered' AND relayed_at IS NULL AND answered_at = ? AND answer = ? AND id != ?")
      .run(this.now(), via, mail.fromItemId, mail.toItemId, mail.answeredAt, mail.answer, mail.id);
    return Number(res.changes);
  }

  /** Mail the desk gives up on: dropped before delivery, or delivered and never answered. Its sender is told. */
  private giveUp(mail: DeskMailRecord, state: 'dropped' | 'unanswered', error: string): void {
    // A worker's report isn't the sender's mail; mail needing no answer is only worth telling about if it never went.
    const owed = mail.kind !== 'report' && (state === 'dropped' || mail.expect === 'reply');
    this.set(mail.id, { state, error, ...(owed ? { notice: state } : {}) });
    if (owed) this.deps.db.prepare('UPDATE desk_mail SET notice_at = ? WHERE id = ?').run(this.now(), mail.id);
  }

  /**
   * Tells the sender about its mail the desk is holding or gave up on, one turn for everything of that kind
   * it sent the same conversation, then carries on. A sender that finished, can't be reached or switched mail
   * off isn't told.
   */
  private async notify(mail: DeskMailRecord): Promise<void> {
    const kind = mail.notice;
    if (!kind) return;
    const from = this.core.item(mail.fromItemId);
    const to = this.core.item(mail.toItemId);
    // Held mail that went out (or ended) since it was marked isn't held any more (Codex review on #773).
    this.deps.db.prepare("UPDATE desk_mail SET notice = NULL WHERE from_item = ? AND to_item = ? AND notice = 'held' AND state != 'queued'").run(mail.fromItemId, mail.toItemId);
    const group = (this.deps.db.prepare('SELECT * FROM desk_mail WHERE from_item = ? AND to_item = ? AND notice = ? ORDER BY created_at').all(mail.fromItemId, mail.toItemId, kind) as Row[]).map(toRecord);
    if (!group.length) return;
    // `upTo`: only what a recovered command covered (owed before it was sent; Codex review on #773).
    const settle = (upTo = Infinity) => {
      for (const m of group) {
        const at = (this.deps.db.prepare('SELECT notice_at FROM desk_mail WHERE id = ?').get(m.id) as { notice_at: number | null } | undefined)?.notice_at ?? 0;
        if (at <= upTo) this.set(m.id, { notice: null, noticed: [...new Set([...(m.noticed ?? []), kind])] });
      }
    };
    if (!from || from.disposition === 'done' || from.disposition === 'parked' || !this.reachable(from) || this.mailOff(from)) {
      settle();
      return;
    }
    if (!this.ready(from, false)) return;
    const ids = group.map((m) => m.id);
    for (const id of ids) this.busy.add(id);
    try {
      // Each retry after a definite failure is a new command; one cut off by a restart or of unknown outcome
      // may have reached the sender: counted as sent, never sent twice (as relay does; Codex review on #773).
      let attempt = 0;
      for (;;) {
        const prior = this.core.store.command(`mail-notice-${mail.id}-${kind}-${attempt}`);
        if (!prior) break;
        if (prior.status === 'accepted' || prior.status === 'applied' || prior.outcome?.delivery === 'unknown' || prior.error === 'interrupted') {
          settle(prior.createdAt);
          return;
        }
        attempt += 1;
      }
      if (attempt >= RELAY_ATTEMPTS) {
        settle();
        this.log('desk.mail.notice_gave_up', { id: mail.id, kind });
        return;
      }
      // Held: why it isn't free now. Given up on: the reason recorded when it was.
      const reason = kind === 'held' ? (this.pairAvailableAt(mail) > this.now() ? `the hourly pair limit holds it until approximately ${new Date(this.pairAvailableAt(mail)).toISOString()}` : to ? holdReason(to) : 'that conversation is gone') : (mail.error ?? 'the desk gave up on it');
      const text = noticeTurn(group, kind, reason, mail.toTitle, from.source === 'discord' ? DISCORD_TURN_MAX : undefined);
      const result = await this.core.command({ commandId: `mail-notice-${mail.id}-${kind}-${attempt}`, type: 'reply', itemId: mail.fromItemId, args: { text }, actor: 'agent' });
      if (result.status !== 'applied' && result.outcome?.delivery !== 'unknown') {
        this.log('desk.mail.notice_failed', { id: mail.id, kind, error: result.error });
        return;
      }
      settle();
      this.log('desk.mail.notice', { id: mail.id, kind, mails: ids.length, to: mail.fromItemId });
    } finally {
      for (const id of ids) this.busy.delete(id);
    }
  }

  private async relay(mail: DeskMailRecord): Promise<void> {
    const from = this.core.item(mail.fromItemId);
    // A sender that finished keeps the answer in its mail; it isn't woken for it.
    if (!from || from.disposition === 'done' || from.disposition === 'parked') return;
    if (!this.ready(from, false)) return;
    this.busy.add(mail.id);
    try {
      const worker = this.core.item(mail.toItemId);
      const reportsUp = worker?.facts.role === 'worker' && worker.facts.parentItemId === from.id;
      // A Discord sender gets it as one post: the answer is cut to fit, never the header.
      const room = DISCORD_TURN_MAX - replyTurn({ ...mail, answer: '' }, { reportsUp }).length;
      const answer = from.source === 'discord' && (mail.answer ?? '').length > room ? clip(mail.answer ?? '', Math.max(200, room)) : mail.answer;
      // Each retry after a definite failure is a new command (a reused id replays the failure; Codex review on #569).
      let attempt = 0;
      for (;;) {
        const prior = this.core.store.command(`mail-reply-${mail.id}-${attempt}`);
        if (!prior) break;
        // One cut off by a restart (still accepted, or recovered as interrupted) or of unknown outcome may
        // have reached the sender: counted as relayed, never sent twice (Codex review on #569).
        if (prior.status === 'accepted' || prior.status === 'applied' || prior.outcome?.delivery === 'unknown' || prior.error === 'interrupted') {
          this.set(mail.id, { relayedAt: this.now(), relayedVia: 'turn' });
          this.markSiblingsRelayed(mail);
          this.log('desk.mail.relayed', { id: mail.id, to: mail.fromItemId, recovered: true });
          return;
        }
        attempt += 1;
      }
      if (attempt >= RELAY_ATTEMPTS) {
        this.set(mail.id, { state: 'failed', error: 'its answer could not be passed back' });
        this.log('desk.mail.relay_gave_up', { id: mail.id });
        return;
      }
      const result = await this.core.command({ commandId: `mail-reply-${mail.id}-${attempt}`, type: 'reply', itemId: mail.fromItemId, args: { text: replyTurn({ ...mail, answer }, { reportsUp }) }, actor: 'agent' });
      const unknown = result.status === 'failed' && result.outcome?.delivery === 'unknown';
      if (result.status !== 'applied' && !unknown) {
        this.log('desk.mail.relay_failed', { id: mail.id, error: result.error });
        return;
      }
      this.set(mail.id, { relayedAt: this.now(), relayedVia: 'turn' });
      const siblings = this.markSiblingsRelayed(mail);
      this.log('desk.mail.relayed', { id: mail.id, to: mail.fromItemId, ...(siblings ? { alsoAnswered: siblings } : {}) });
    } finally {
      this.busy.delete(mail.id);
    }
  }

  /** Loom wakes Loom leads itself; the mail adapter delivers recorded failures to leads on other sources. */
  private reportFailures(): void {
    for (const item of this.core.items()) {
      const f = item.facts;
      if (!f.failed || !['worker', 'ops'].includes(f.role ?? '') || !f.parentItemId || f.ownerGone || this.loomReports(item)) continue;
      const lead = this.core.item(this.core.ownerFacingLeadOf(item) ?? f.parentItemId);
      if (!lead || lead.disposition === 'done' || lead.facts.stoppedAtSource) continue;
      const key = `failure_report:${item.id}`;
      const failure = f.failed.turnId ?? String(f.failed.at);
      // `failure|mail|attempts`: counted reported once its mail is delivered; a mail that failed is sent again, up to
      // three times in all (Codex review on #926).
      const [seen, mailId, tries] = (this.core.store.marker(key) ?? '').split('|');
      const attempts = seen === failure ? Number(tries) || 1 : 0;
      if (seen === failure) {
        const state = mailId ? this.get(mailId)?.state : 'done';
        if (!state || !['failed', 'dropped'].includes(state) || attempts >= 3) continue;
      }
      const result = this.send({ from: item.id, to: lead.id, text: `Worker failed: ${this.core.title(item)}. ${f.failed.message}. Resolve this failure and report the outcome.`, expect: 'none', now: true });
      if (result.ok) this.core.store.setMarker(key, `${failure}|${result.mail.id}|${attempts + 1}`);
    }
  }

  /** Loom wakes the lead itself only when the chain up to it never leaves Loom (packages/loom host.ts ownerFacingLead). */
  private loomReports(item: DeskItem): boolean {
    if (item.source !== 'loom') return false;
    const seen = new Set([item.id]);
    let parent = item.facts.parentItemId;
    while (parent?.startsWith('loom:')) {
      const at = this.core.item(parent);
      if (!at || seen.has(at.id)) return false;
      if (at.facts.role !== 'worker' && at.facts.role !== 'ops') return true;
      seen.add(at.id);
      parent = at.facts.parentItemId;
    }
    return false;
  }

  /**
   * A worker reports to the conversation that started it (docs/specs/spaces.md), and the owner doesn't see it
   * (desk/status.ts). An answer to its owner's mail already goes back; any other turn it finishes (woken by a
   * wait, a job or the owner's tap) is passed up the same way, as a reply turn, once per turn (owner, 10/18).
   */
  private reportUp(): void {
    const since = Number(this.core.store.setting('report_up_since') ?? 0);
    const pending = this.deps.db.prepare("SELECT COUNT(*) AS n FROM desk_mail WHERE to_item = ? AND kind != 'report' AND state IN ('queued', 'sending', 'sent')");
    const covered = this.deps.db.prepare("SELECT COUNT(*) AS n FROM desk_mail WHERE to_item = ? AND answered_at >= ?");
    for (const item of this.core.items()) {
      const f = item.facts;
      if (f.failed || f.role !== 'worker' || !f.parentItemId || f.ownerGone || !item.lastAgentMessageId) continue;
      if (f.reportedUpId === item.lastAgentMessageId || !isIdle(item)) continue;
      // Idle results, asks and failures can report up; an armed wait is still unfinished. A worker's ask reads
      // Waiting on its lead (source:lead-request): that is exactly what reports up.
      // Settled at its source right after its last word (done) is finished too: a summary may never come (Codex review on #724).
      if (item.disposition !== 'done') {
        const status = deskStatus(item);
        const settled = status.pill === 'idle' || status.pill === 'finished' || status.pill === 'stuck' || status.pill === 'needs' || status.pill === 'failed' || status.basis === 'source:lead-request';
        if (!settled) continue;
      }
      const last = this.deps.db.prepare('SELECT at, text FROM desk_messages WHERE message_id = ?').get(item.lastAgentMessageId) as { at: number; text: string } | undefined;
      if (!last || last.at < since) continue;
      // An answer to mail still being collected goes back as that answer.
      if ((pending.get(item.id) as { n: number }).n > 0) continue;
      const parent = this.core.item(f.parentItemId);
      const mark = () => this.core.setFacts(item.id, { reportedUpId: item.lastAgentMessageId });
      // Already gone back as the answer to a mail.
      if ((covered.get(item.id, last.at) as { n: number }).n > 0 || !parent) {
        mark();
        continue;
      }
      if (!this.reachable(parent) || !this.reachable(item) || this.mailOff(parent) || this.mailOff(item)) continue;
      const at = this.now();
      const id = `m-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
      this.deps.db
        .prepare("INSERT INTO desk_mail (id, from_item, to_item, from_title, to_title, text, expect, state, chain, hops, urgent, created_at, sent_at, answer, answered_at, kind) VALUES (?, ?, ?, ?, ?, ?, 'none', 'answered', ?, 0, 0, ?, ?, ?, ?, 'report')")
        .run(id, parent.id, item.id, this.core.title(parent), this.core.title(item), `Report: ${this.core.title(item)}`, id, at, at, clip(this.turnText(item.id, last), MAX_ANSWER), last.at);
      mark();
      this.log('desk.mail.report', { id, from: item.id, to: parent.id });
    }
  }

  /** Its last message with the long parts right before it (a Discord answer comes in ~1900-character pieces), like `mailAnswer`. */
  private turnText(itemId: string, last: { at: number; text: string }): string {
    const before = this.deps.db.prepare('SELECT author, text FROM desk_messages WHERE item_id = ? AND at < ? ORDER BY at DESC, message_id DESC LIMIT 20').all(itemId, last.at) as Array<{ author: string; text: string }>;
    const parts = [last.text.trim()];
    for (const m of before) {
      if (m.author !== 'agent' || m.text.trim().length < ANSWER_PART) break;
      parts.unshift(m.text.trim());
    }
    return withoutNextLine(parts.join('\n\n'));
  }

  private ticking = false;

  /** Every few seconds, and right after a send. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.reportFailures();
      this.reportUp();
      for (const mail of this.open()) {
        if (this.busy.has(mail.id)) continue;
        // A send cut off by a restart: never reached the desk's command layer, it goes back in the queue;
        // reached it, it may have gone through: counted as sent, its answer looked for (Codex review on #569).
        if (mail.state === 'sending') {
          const command = this.core.store.command(`mail-${mail.id}`);
          if (!command) this.set(mail.id, { state: 'queued' });
          // A command a restart interrupted (`interrupted`) may have reached the source, like an unknown delivery.
          else if (command.status === 'failed' && command.outcome?.delivery !== 'unknown' && command.error !== 'interrupted') this.set(mail.id, { state: 'failed', error: command.error ?? 'not delivered' });
          else this.set(mail.id, { state: mail.expect === 'reply' ? 'sent' : 'done', sentAt: mail.sentAt ?? command.createdAt });
        }
        else if (mail.state === 'queued') await this.deliver(mail);
        else if (mail.state === 'sent') this.collect(mail);
        const now = this.get(mail.id);
        if (now?.state === 'answered' && !now.relayedAt) await this.relay(now);
      }
      // Still waiting for its target after hours (after this tick's deliveries): the sender hears why, once,
      // before it is dropped. Marked all at once, so one notice covers all of it to the same conversation.
      this.deps.db
        .prepare("UPDATE desk_mail SET notice = 'held', notice_at = ? WHERE state = 'queued' AND notice IS NULL AND (noticed IS NULL OR instr(noticed, 'held') = 0) AND created_at <= ?")
        .run(this.now(), this.now() - HELD_NOTICE_MS);
      // After everything this tick decided, so mail held or given up on together goes in one notice.
      // One try per sender, target and kind a tick: a failing adapter isn't hit once per mail (Codex review on #773).
      const tried = new Set<string>();
      for (const owed of (this.deps.db.prepare('SELECT * FROM desk_mail WHERE notice IS NOT NULL ORDER BY created_at').all() as Row[]).map(toRecord)) {
        const current = this.get(owed.id);
        const group = `${owed.fromItemId}\n${owed.toItemId}\n${current?.notice}`;
        if (!current?.notice || this.busy.has(owed.id) || tried.has(group)) continue;
        tried.add(group);
        await this.notify(current);
      }
    } finally {
      this.ticking = false;
    }
  }
}
