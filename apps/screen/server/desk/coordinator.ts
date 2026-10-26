import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { legacyCoordinatorItemId } from './migrate.js';
import type { DeskCore } from './core.js';
import type { DeskSearch } from './search.js';
import { parseMailHeader } from './mail.js';
import { mailBodyOf, mailLog, mailOf, turnsOf } from './backstage.js';
import { readProjects, type DeskProject } from './projects.js';
import type { StartWorkRequest, StartResult } from './start-work.js';
import type { DeskItem, Log } from './types.js';

// Retained project-coordinator records and context helpers. The former supervised
// runtime is retired: starts and relays refuse explicitly instead of weakening its guard.

export interface CoordinatorWatch {
  on: boolean;
  /** Write "Where it stands" (the project page and its folder in the List). */
  stands: boolean;
  /** Show stall flags. */
  flags: boolean;
  /** A short digest in the panel each morning. */
  digest: boolean;
}

export type CoordinatorReach = 'approve' | 'idle';

export type DraftState = 'draft' | 'queued' | 'sending' | 'sent' | 'answered' | 'dropped' | 'unanswered';

export interface CoordinatorDraft {
  id: string;
  toItemId: string;
  toTitle: string;
  text: string;
  state: DraftState;
  createdAt: number;
  /** Queued: send as soon as the conversation is idle. */
  queuedAt?: number | null;
  sentAt?: number | null;
  answer?: { text: string; at: number } | null;
  /** Why the last send failed: it is back with the owner, never retried on its own (it may have gone through). */
  error?: string | null;
  /** The answer reached the coordinator's thread (a failed relay is tried again on the next tick). */
  relayedAt?: number | null;
}

export interface CoordinatorStatus {
  /** One paragraph for the project page. */
  text: string;
  /** One line for the folder in the List. */
  line: string;
  at: number;
  /** The members' state it was written from (see `basisOf`). */
  basis: string;
  source: 'model' | 'text';
}

export interface CoordinatorRecord {
  projectId: string;
  threadId: string | null;
  createdAt: number;
  watch: CoordinatorWatch;
  reach: CoordinatorReach;
  drafts: CoordinatorDraft[];
  status: CoordinatorStatus | null;
  digests: Array<{ at: number; text: string }>;
  /** The members' state as last seen, and when it last changed: what a rewrite waits on. */
  seenBasis?: string | null;
  changedAt?: number | null;
  /** The stall flags as screens last got them: one crossing its time threshold is sent on its own. */
  flagsSig?: string | null;
  /** The local date (YYYY-MM-DD) of the last morning digest. */
  digestDay?: string | null;
}

export interface CoordinatorFlag {
  itemId: string;
  title: string;
  kind: 'stalled' | 'failed' | 'review';
  text: string;
}

/** What every screen gets per project: enough for the folder line, the page's status card and the panel header. */
export interface CoordinatorSummary {
  projectId: string;
  exists: boolean;
  watch: CoordinatorWatch;
  reach: CoordinatorReach;
  status: Pick<CoordinatorStatus, 'text' | 'line' | 'at' | 'source'> | null;
  flags: CoordinatorFlag[];
  /** Drafts waiting on the owner. */
  drafts: number;
}

/** One message in the coordinator's thread, as the panel shows it. */
export interface CoordinatorMessage {
  id: string;
  kind: 'question' | 'answer' | 'relay';
  text: string;
  at: number;
  streaming?: boolean;
  /** A question asked from inside one of the project's conversations. */
  fromItemId?: string | null;
}

/** What the coordinator reads about one conversation (`tango-screen coordinator context`). */
export interface MemberBrief {
  itemId: string;
  title: string;
  where: string;
  state: string;
  disposition: string;
  lastActivityAt: string;
  ask: string | null;
  summary: string | null;
  waitingOn: string | null;
  pullRequest: string | null;
  failed: string | null;
  ownerAsked: string | null;
  type: string | null;
  goal: string | null;
  milestone: string | null;
  startedAt: string;
  /** Done: when. Snoozed: until when (or what wakes it). */
  doneAt: string | null;
  snoozedUntil: string | null;
  /** The agent's newest work note (progress its replies may not say yet). */
  latestNote: string | null;
  recent: Array<{ author: string; at: string; text: string }>;
  /** Its agent mail, newest last: what it and other agents' conversations told each other (desk/backstage.ts). */
  mail?: Array<{ at: string; direction: 'in' | 'out'; peer: string; text: string; answer: string | null }>;
}

/** A finished conversation the desk no longer holds (past its 30 days), as search keeps it. */
export interface ArchivedBrief {
  itemId: string;
  title: string;
  where: string;
  disposition: 'done';
  lastActivityAt: string;
  summary: string | null;
  archived: true;
}

export type CoordinatorWriteInput = {
  kind: 'status' | 'digest';
  project: { name: string; about: string | null };
  members: MemberBrief[];
  flags: CoordinatorFlag[];
  previous: string | null;
  /** Digest: what changed since this time. */
  since?: number | null;
  now: number;
};

/** A cheap model call (or the counting fallback): a paragraph and a one-line version. */
export type CoordinatorWriter = (input: CoordinatorWriteInput) => Promise<{ text: string; line: string; source: 'model' | 'text' }>;

export const BRIEF_OPEN = '<coordinator-brief>';
export const BRIEF_CLOSE = '</coordinator-brief>';
export const RELAY_PREFIX = '[Relay]';
const ASKED_FROM = /^\(Asked while looking at “[^”]*” \[([^\]]+)\]\)\s*/;

export const DEFAULT_WATCH: CoordinatorWatch = { on: false, stands: true, flags: true, digest: false };
/** A change waits this long for the project to go quiet before the status is rewritten. */
export const SETTLE_MS = 5 * 60_000;
/** And the status is rewritten at most this often. */
export const MIN_GAP_MS = 30 * 60_000;
/** Opening the project page catches a stale status up, at most this often. */
const CATCH_UP_GAP_MS = 2 * 60_000;
const STALL_MS = 24 * 3_600_000;
const FAILED_MS = 2 * 3_600_000;
const REVIEW_MS = 48 * 3_600_000;
/** A question nobody answered is given up on. */
const ANSWER_WAIT_MS = 3 * 86_400_000;
const MAX_DRAFTS = 30;
const MAX_DIGESTS = 7;

const STATE_WORD: Record<string, string> = { your_move: 'needs you', failed: 'failed', working: 'working', watching: 'watching', fyi: 'ready' };

/** The List's word for a conversation (list-model liveState): the owner's turn is "needs you" until they read it, then "ready"; an open request stays "needs you". */
function stateWord(item: DeskItem): string {
  if ((item.nextStep === 'your_move' || item.nextStep === 'fyi') && !item.facts.pending) return item.seen === 'seen' ? 'ready' : 'needs you';
  return STATE_WORD[item.nextStep] ?? item.nextStep;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const iso = (ms: number) => new Date(ms).toISOString();

/** The stored records, or none when the setting is missing or unreadable. */
export function readCoordinators(raw: string | null | undefined): Record<string, CoordinatorRecord> {
  try {
    const parsed = JSON.parse(raw ?? '{}') as Record<string, CoordinatorRecord>;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The coordinators' own threads: kept out of the List, counts, the briefing and every other reader. */
export function coordinatorItemIds(raw: string | null | undefined): Set<string> {
  return new Set(
    Object.values(readCoordinators(raw))
      .map((record) => (record.threadId ? legacyCoordinatorItemId(record.threadId) : null))
      .filter((id): id is string => !!id),
  );
}

/** Idle: no turn in flight, nothing waiting on an answer, no work after the turn, not setting up. */
export function isIdle(item: Pick<DeskItem, 'facts' | 'nextStep' | 'disposition'>): boolean {
  const f = item.facts;
  // A turn the source has queued, or holds for a reason (disk, limits, maintenance), hasn't run yet (10/20): not idle.
  return !f.running && !f.pending && !f.held && f.background !== 'working' && !(f.setup && f.setup.phase === 'running') && item.nextStep !== 'working';
}

export const COORDINATOR_PREFIX = 'Question from the project coordinator for';
const MAIL_FROM = '✉️ Mail from';
/** A coordinator question's id as desk mail: its draft id (8 hex characters). */
export const coordinatorMailId = (draftId: string) => `m-${draftId.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

/** The desk's own `tango-screen`: a coordinator whose PATH lacks it (an app launched from the Dock) calls it by this path. */
export const TANGO_SCREEN_BIN = fileURLToPath(new URL('../../bin/tango-screen.mjs', import.meta.url));

/**
 * The target's answer to a coordinator question sent at `sentAt`: its last reply before the owner's
 * next words there, so a turn the owner queued after it is never mistaken for the answer (Codex review on #545).
 */
export function answerAfter(messages: Array<{ author: string; at: number; text: string }>, sentAt: number, mailId?: string): { text: string; at: number } | null {
  // Anchored on the question itself arriving in the conversation: a reply to a turn that was already
  // running when it was sent ("Send now" to a busy one) comes before it and never counts (Codex review on #545).
  // A question goes as desk mail (its header carries `mailId`); one sent before that, by its old prefix.
  const asked = (m: { text: string }) => (mailId ? parseMailHeader(m.text)?.mailId === mailId : false) || m.text.slice(0, 40).includes(COORDINATOR_PREFIX.slice(0, 30));
  let anchored = false;
  let answer: { text: string; at: number } | null = null;
  for (const m of [...messages].sort((a, b) => a.at - b.at)) {
    if (m.at < sentAt) continue;
    if (m.author === 'owner') {
      if (asked(m) && !anchored) {
        anchored = true;
        continue;
      }
      if (anchored) break;
      continue;
    }
    if (anchored && m.author === 'agent' && m.text.trim()) answer = { text: withoutNextLine(m.text.trim()), at: m.at };
  }
  return answer;
}

/** What a rewrite keys on: each open member's step, latest words (either side's), attention, review and CI. */
export function basisOf(members: DeskItem[]): string {
  return members
    .map((m) => [m.id, m.nextStep, m.lastAgentMessageId ?? '', m.disposition, m.facts.prReview?.state ?? '', m.facts.prChecks?.state ?? '', m.facts.failed?.at ?? '', m.facts.contentKey ?? ''].join(':'))
    .sort()
    .join('|');
}

const days = (ms: number) => Math.max(1, Math.round(ms / 86_400_000));
const hours = (ms: number) => Math.max(1, Math.round(ms / 3_600_000));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Stall flags: plain rules, no model. */
export function flagsFor(members: DeskItem[], title: (item: DeskItem) => string, now: number): CoordinatorFlag[] {
  const flags: CoordinatorFlag[] = [];
  for (const m of members) {
    if (m.disposition !== 'active') continue;
    const name = title(m);
    if (m.nextStep === 'your_move' && now - m.lastActivityAt > STALL_MS) {
      flags.push({ itemId: m.id, title: name, kind: 'stalled', text: `has waited on you ${plural(days(now - m.lastActivityAt), 'day')}` });
    } else if (m.nextStep === 'failed' && now - (m.facts.failed?.at ?? m.lastActivityAt) > FAILED_MS) {
      flags.push({ itemId: m.id, title: name, kind: 'failed', text: `failed ${plural(hours(now - (m.facts.failed?.at ?? m.lastActivityAt)), 'hour')} ago and hasn’t been retried` });
    } else if (m.facts.prReview?.state === 'pending' && now - m.facts.prReview.since > REVIEW_MS) {
      const who = m.facts.prReview.reviewers[0];
      flags.push({ itemId: m.id, title: name, kind: 'review', text: `PR #${m.facts.prReview.number} has waited ${plural(days(now - m.facts.prReview.since), 'day')} for review${who ? ` by ${who}` : ''}` });
    } else if (m.watching?.waitingOn && now - m.watching.waitingOn.since > REVIEW_MS) {
      flags.push({ itemId: m.id, title: name, kind: 'review', text: `has waited on ${m.watching.waitingOn.who} for ${plural(days(now - m.watching.waitingOn.since), 'day')}` });
    }
  }
  const order = { failed: 0, stalled: 1, review: 2 };
  return flags.sort((a, b) => order[a.kind] - order[b.kind]);
}

/** The counting fallback when no model answers: what needs the owner, then the rest. */
export function countingStatus(members: MemberBrief[], flags: CoordinatorFlag[]): { text: string; line: string } {
  const by = (state: string) => members.filter((m) => m.disposition === 'active' && m.state === state);
  const parts = [
    [by('needs you').length, 'need you'],
    [by('failed').length, 'failed'],
    [by('working').length, 'working'],
    [by('watching').length, 'watching'],
    [by('ready').length, 'ready'],
  ].filter(([n]) => Number(n) > 0).map(([n, word]) => `${n} ${word}`);
  const line = parts.length ? `${parts.join(', ')}.` : 'Nothing open.';
  const needs = by('needs you').map((m) => m.title);
  const text = [line, needs.length ? `On you: ${needs.join('; ')}.` : '', flags.length ? `Stalled: ${flags.map((f) => `${f.title} ${f.text}`).join('; ')}.` : ''].filter(Boolean).join(' ');
  return { text, line };
}

/** YYYY-MM-DD and the morning time today, in local time. */
function morningOf(now: number, hhmm: string): { day: string; at: number } {
  const date = new Date(now);
  const [h, m] = hhmm.split(':').map(Number);
  const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), h || 0, m || 0).getTime();
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return { day, at };
}

/** The brief that opens a coordinator's thread; the panel shows only the question after it. */
export function coordinatorBrief(project: DeskProject): string {
  const id = project.id;
  return [
    BRIEF_OPEN,
    `You are the coordinator for the owner's desk project “${project.name}” (project id ${id}).${project.about ? ` About it: ${project.about}` : ''}`,
    'You answer the owner’s questions about this project’s conversations: where things stand, what is blocking, what changed, what is waiting on them. You are a resource they consult, not a worker.',
    '',
    'Rules:',
    '- Read only. Never edit files, run builds or tests, commit, push, comment on PRs or issues, or post anywhere. Never message the project’s conversations yourself. This thread is supervised: the desk approves only reads and these commands, one per call, piped at most into cat/head/tail/grep/jq/sort/wc: `tango-screen coordinator …`, `gh pr view|diff|list|checks`, `git log|show|diff|status`, `cat`, `grep`, `ls`. No redirects, chaining, `$` or command substitution. Anything else is declined. Never ask the owner questions with a tool; ask in your answer.',
    `- Before every answer, run \`tango-screen coordinator context ${id}\`: the project changes between questions, so never answer from memory. Its \`conversations\` are the open ones; \`finished\` lists the done ones (older ones only as search keeps them), and you can read any of them. For more on one conversation, open or done, \`tango-screen coordinator transcript ${id} <itemId> --limit 40\`. You may read PRs with \`gh pr view\` and \`gh pr diff\`. If \`tango-screen\` isn’t found, call it by its full path, \`${TANGO_SCREEN_BIN}\`.`,
    '- Each conversation in the context carries its agent mail (`mail`): what it and other agents’ conversations told each other. Use it for questions about how the conversations are coordinating; it is never the owner talking.',
    '- Cite every conversation you mention as a link to its item id: [its title](desk:<itemId>). Cite PRs by their GitHub URL. The desk turns these into chips the owner can tap.',
    '- Lead with the answer. Keep it short: a few sentences or a short list. No preamble, no sign-off, no offers, and no closing “Next —” line: your answers show in a side panel, not a report.',
    `- When only a conversation’s own agent can answer something, draft one question for it: \`tango-screen coordinator draft ${id} --to <itemId> "<question>"\`, and say in your answer that you drafted it. The owner decides whether it is sent (unless they let you ask idle conversations directly). Its answer comes back to you as a message starting with ${RELAY_PREFIX}.`,
    `- On a ${RELAY_PREFIX} message, tell the owner in two or three sentences what the answer changes.`,
    BRIEF_CLOSE,
    '',
  ].join('\n');
}

/** A closing "**Next — …**" line some agents add to every turn: noise in a panel and in a relayed answer. */
export function withoutNextLine(text: string): string {
  return text.replace(/\n+\s*\**Next\s+[—–-][^\n]*\s*$/u, '').trimEnd();
}

/** The panel's view of a thread message: the brief hidden, relays and questions told apart. */
export function panelMessage(message: { id: string; role: string; text: string; createdAt: string; streaming?: boolean }): CoordinatorMessage | null {
  const at = Date.parse(message.createdAt) || 0;
  if (message.role === 'assistant') return message.text.trim() || message.streaming ? { id: message.id, kind: 'answer', text: message.streaming ? message.text : withoutNextLine(message.text), at, ...(message.streaming ? { streaming: true } : {}) } : null;
  if (message.role !== 'user') return null;
  let text = message.text;
  const close = text.indexOf(BRIEF_CLOSE);
  if (text.startsWith(BRIEF_OPEN) && close >= 0) text = text.slice(close + BRIEF_CLOSE.length);
  text = text.trim();
  if (text.startsWith(RELAY_PREFIX)) return { id: message.id, kind: 'relay', text: text.slice(RELAY_PREFIX.length).trim(), at };
  const from = ASKED_FROM.exec(text);
  return { id: message.id, kind: 'question', text: from ? text.slice(from[0].length) : text, at, fromItemId: from?.[1] ?? null };
}

export interface CoordinatorDeps {
  /**
   * Keep watch runs only when asked (tests). It is retired with the coordinator (TGO-1041): the space's default
   * writes "Where it stands", so a watch left on from before writes nothing and makes no model calls.
   */
  keepWatch?: boolean;
  core: DeskCore;
  /** Start work: the coordinator's thread is a new thread (retired). */
  start: ((request: StartWorkRequest) => Promise<StartResult>) | null;
  /** Read the new thread right away (a source refresh). */
  afterStart?: () => void;
  write: CoordinatorWriter;
  /** Search's copy of conversations the desk has let go of (finished ones past 30 days). */
  search?: Pick<DeskSearch, 'docsInProject'> | null;
  /** The former coordinator workspace. */
  repo?: string;
  morning?: () => string;
  now?: () => number;
  log?: Log;
}

export class ProjectCoordinators {
  private readonly listeners = new Set<(summary: CoordinatorSummary) => void>();
  private readonly writing = new Set<string>();
  /** Questions being sent right now: a tick and a click never send one twice. */
  private readonly sending = new Set<string>();
  private readonly starting = new Map<string, Promise<CoordinatorRecord>>();

  constructor(private readonly deps: CoordinatorDeps) {}

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

  private all(): Record<string, CoordinatorRecord> {
    return readCoordinators(this.core.store.setting('coordinators'));
  }
  record(projectId: string): CoordinatorRecord | null {
    return this.all()[projectId] ?? null;
  }
  private fresh(projectId: string): CoordinatorRecord {
    return { projectId, threadId: null, createdAt: this.now(), watch: { ...DEFAULT_WATCH }, reach: 'approve', drafts: [], status: null, digests: [] };
  }
  /** Read, change and store one record (synchronously: no interleaving), then tell every screen. */
  private update(projectId: string, change: (record: CoordinatorRecord) => void): CoordinatorRecord {
    const all = this.all();
    const record = all[projectId] ?? this.fresh(projectId);
    change(record);
    record.drafts = record.drafts.slice(-MAX_DRAFTS);
    record.digests = record.digests.slice(-MAX_DIGESTS);
    all[projectId] = record;
    this.core.store.setSetting('coordinators', JSON.stringify(all));
    this.emit(projectId);
    return record;
  }

  subscribe(listener: (summary: CoordinatorSummary) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(projectId: string): void {
    const summary = this.summary(projectId);
    if (summary) for (const listener of this.listeners) listener(summary);
  }

  // ── reading ──

  private project(projectId: string): DeskProject | null {
    return readProjects(this.core.store.setting('projects')).find((p) => p.id === projectId) ?? null;
  }
  /** The project's conversations as every reader sees them (held ones included), done ones left out. */
  members(projectId: string): DeskItem[] {
    return this.core.items().filter((item) => item.facts.projectId === projectId && item.disposition !== 'done');
  }
  /**
   * The project's finished conversations, newest first: the ones the desk still holds (done in the last
   * 30 days), then older ones as search keeps them. Read by the coordinator, never part of a status or a flag.
   */
  finished(projectId: string): Array<MemberBrief | ArchivedBrief> {
    const held = this.core
      .items()
      .filter((item) => item.facts.projectId === projectId && item.disposition === 'done')
      .sort((a, b) => (b.doneAt ?? b.lastActivityAt) - (a.doneAt ?? a.lastActivityAt))
      .slice(0, 40)
      .map((item) => this.brief(item, 2));
    const seen = new Set([...held.map((b) => b.itemId), ...this.members(projectId).map((m) => m.id)]);
    const hidden = coordinatorItemIds(this.core.store.setting('coordinators'));
    const archived = (this.deps.search?.docsInProject(projectId, 60) ?? [])
      .filter((doc) => !seen.has(doc.itemId) && !hidden.has(doc.itemId) && !this.core.store.item(doc.itemId))
      .slice(0, 40)
      .map((doc): ArchivedBrief => ({
        itemId: doc.itemId,
        title: doc.title || doc.place || doc.agentName,
        where: doc.source === 'loom' ? `Loom · ${doc.area ?? 'thread'}` : `${doc.agentName}${doc.place ? ` · ${doc.place}` : ''}`,
        disposition: 'done',
        lastActivityAt: iso(doc.lastActivityAt),
        summary: typeof doc.summary?.paragraph === 'string' ? doc.summary.paragraph : typeof doc.summary?.gist === 'string' ? doc.summary.gist : null,
        archived: true,
      }));
    return [...held, ...archived];
  }

  /** The conversation's own name: a thread’s title without its workspace in front. */
  private title = (item: DeskItem): string => {
    const workspace = item.source === 'loom' ? (item.facts.project?.name ?? item.area) : null;
    if (workspace && item.place?.startsWith(`${workspace} · `)) return item.place.slice(workspace.length + 3);
    return this.core.title(item);
  };

  summary(projectId: string): CoordinatorSummary | null {
    const project = this.project(projectId);
    if (!project) return null;
    const record = this.record(projectId);
    const watch = record?.watch ?? DEFAULT_WATCH;
    return {
      projectId,
      exists: !!record?.threadId,
      watch,
      reach: record?.reach ?? 'approve',
      status: watch.on && watch.stands && record?.status ? { text: record.status.text, line: record.status.line, at: record.status.at, source: record.status.source } : null,
      flags: watch.on && watch.flags ? flagsFor(this.members(projectId), this.title, this.now()) : [],
      drafts: record?.drafts.filter((d) => d.state === 'draft').length ?? 0,
    };
  }

  summaries(): CoordinatorSummary[] {
    const records = this.all();
    return readProjects(this.core.store.setting('projects'))
      .filter((p) => records[p.id])
      .map((p) => this.summary(p.id)!)
      .filter(Boolean);
  }

  /** One conversation as the coordinator reads it. */
  brief(item: DeskItem, recent = 4): MemberBrief {
    const f = item.facts;
    const pr = f.pullRequest ?? f.linkedPullRequests?.[0] ?? null;
    const review = f.prReview ? `${f.prReview.state.replace('_', ' ')}${f.prReview.reviewers.length ? ` (${f.prReview.reviewers.join(', ')})` : ''}` : null;
    const checks = f.prChecks ? `CI ${f.prChecks.state}` : null;
    return {
      itemId: item.id,
      title: this.title(item),
      where: item.source === 'loom' ? `Loom · ${f.project?.name ?? item.area ?? 'thread'}` : `${item.agentName}${item.place ? ` · ${item.place}` : ''}`,
      state: stateWord(item),
      disposition: item.disposition,
      lastActivityAt: iso(item.lastActivityAt),
      ask: item.ask ? clip(item.ask, 400) : null,
      summary: item.summary?.paragraph || item.summary?.gist || null,
      waitingOn: item.watching?.waitingOn ? `${item.watching.waitingOn.who}: ${item.watching.waitingOn.what}` : null,
      pullRequest: pr ? [pr.url, review, checks].filter(Boolean).join(' · ') : null,
      failed: f.failed ? clip(f.failed.message, 300) : null,
      ownerAsked: f.lastOwnerRequest?.text ? clip(f.lastOwnerRequest.text, 400) : null,
      type: f.type ?? null,
      goal: item.summary?.goal ?? null,
      milestone: item.summary?.milestone ?? null,
      startedAt: iso(item.createdAt),
      doneAt: item.disposition === 'done' && item.doneAt ? iso(item.doneAt) : null,
      snoozedUntil: item.disposition === 'snoozed' ? (item.snoozeUntil ? iso(item.snoozeUntil) : (item.snoozeTrigger ?? 'until something wakes it')) : null,
      latestNote: f.workNotes?.length ? clip(f.workNotes.at(-1)!.text, 300) : null,
      // Mail is labelled as such: it is never the owner talking (desk/backstage.ts).
      recent: this.core.store
        .messages(item.id, recent)
        .map((m) => ({ author: m.author === 'agent' ? item.agentName : mailOf(m) ? 'mail' : m.author === 'owner' ? 'owner' : 'other', at: iso(m.at), text: clip(mailOf(m) ? mailBodyOf(m) : m.text.trim(), 700) })),
      mail: mailLog(turnsOf(this.core.store.messages(item.id, 80)))
        .slice(-6)
        .map((l) => ({ at: iso(l.at), direction: l.kind === 'in' || l.kind === 'reply' ? ('in' as const) : ('out' as const), peer: l.peer, text: clip(l.text, 400), answer: l.answer ? clip(l.answer, 300) : null })),
    };
  }

  /** Everything the coordinator reads before an answer. */
  context(projectId: string) {
    const project = this.project(projectId);
    if (!project) return null;
    const members = this.members(projectId);
    const record = this.record(projectId);
    return {
      project: { id: project.id, name: project.name, about: project.about ?? null, away: project.away?.state ?? null, finished: !!project.finishedAt },
      now: iso(this.now()),
      conversations: members.map((m) => this.brief(m)),
      // Done ones too, apart: so "every thread in the project" means every one (owner report 10/16).
      finished: this.finished(projectId),
      flags: flagsFor(members, this.title, this.now()),
      questions: (record?.drafts ?? []).filter((d) => d.state !== 'dropped').slice(-10).map((d) => ({ to: d.toTitle, toItemId: d.toItemId, question: d.text, state: d.state, answer: d.answer?.text ?? null })),
      status: record?.status ? { text: record.status.text, at: iso(record.status.at) } : null,
    };
  }

  /** The panel: the thread's questions and answers, drafts, digests, and whether a turn is running. */
  async view(projectId: string, options: { catchUp?: boolean } = {}) {
    if (!this.project(projectId)) return null;
    if (options.catchUp) void this.catchUp(projectId).catch(() => undefined);
    const record = this.record(projectId);
    let messages: CoordinatorMessage[] = [];
    let running = false;
    let error: string | null = null;
    if (record?.threadId) error = 'This coordinator is retired; use the project’s Loom conversation.';
    return {
      summary: this.summary(projectId),
      threadId: record?.threadId ?? null,
      itemId: record?.threadId ? legacyCoordinatorItemId(record.threadId) : null,
      messages,
      running: running || this.starting.has(projectId),
      drafts: record?.drafts.filter((d) => d.state !== 'dropped' || d.error) ?? [],
      digests: record?.digests ?? [],
      error,
    };
  }

  // ── asking ──

  /** Retired entry point: refuse explicitly so old clients cannot launch a coordinator. */
  async ask(projectId: string, text: string, fromItemId?: string | null, commandId: string = randomUUID()): Promise<{ ok: true; threadId: string } | { ok: false; error: string }> {
    return { ok: false, error: 'The supervised coordinator is retired; use the project’s Loom conversation.' };
  }

  private async sendToThread(threadId: string, text: string, commandId: string = randomUUID()): Promise<{ ok: true } | { ok: false; error: string }> {
    return { ok: false, error: 'The supervised coordinator is retired; use the project’s Loom conversation.' };
  }

  // ── questions for the project's conversations ──

  /** The coordinator drafts a question; with reach `idle` it is queued for the next idle moment instead. */
  draft(projectId: string, toItemId: string, text: string): { ok: true; draft: CoordinatorDraft } | { ok: false; error: string } {
    const target = this.core.item(toItemId);
    if (!this.project(projectId)) return { ok: false, error: 'no such project' };
    if (!target || target.facts.projectId !== projectId) return { ok: false, error: `${toItemId} is not a conversation in this project` };
    const question = text.trim();
    if (!question) return { ok: false, error: 'the question is empty' };
    const at = this.now();
    let draft: CoordinatorDraft | null = null;
    this.update(projectId, (r) => {
      draft = { id: randomUUID().slice(0, 8), toItemId, toTitle: this.title(target), text: clip(question, 2000), state: r.reach === 'idle' ? 'queued' : 'draft', createdAt: at, ...(r.reach === 'idle' ? { queuedAt: at } : {}) };
      r.drafts.push(draft);
    });
    this.log('desk.coordinator.draft', { projectId, toItemId, queued: draft!.state === 'queued' });
    if (draft!.state === 'queued') void this.deliver(projectId).catch((err) => this.log('desk.coordinator.deliver.error', { projectId, message: (err as Error).message }));
    return { ok: true, draft: draft! };
  }

  /** The owner's call on a draft: send when idle, send now, or don't send (optionally with edited words). */
  async draftAction(projectId: string, draftId: string, action: 'send' | 'now' | 'drop', text?: string): Promise<{ ok: true; draft: CoordinatorDraft } | { ok: false; error: string }> {
    const found = this.record(projectId)?.drafts.find((d) => d.id === draftId);
    if (!found) return { ok: false, error: 'no such question' };
    if (found.state !== 'draft' && !(action === 'drop' && found.state === 'queued') && !(action === 'now' && found.state === 'queued')) return { ok: false, error: `that question is already ${found.state}` };
    const words = text?.trim();
    if (text !== undefined && !words && action !== 'drop') return { ok: false, error: 'the question is empty' };
    const updated = this.update(projectId, (r) => {
      const d = r.drafts.find((x) => x.id === draftId)!;
      if (words) d.text = clip(words, 2000);
      if (action === 'drop') d.state = 'dropped';
      else {
        d.state = 'queued';
        d.queuedAt = this.now();
      }
    }).drafts.find((d) => d.id === draftId)!;
    if (action === 'now') {
      const sent = await this.sendDraft(projectId, draftId, 'screen');
      if (!sent.ok) return sent;
    } else if (action === 'send') void this.deliver(projectId).catch((err) => this.log('desk.coordinator.deliver.error', { projectId, message: (err as Error).message }));
    return { ok: true, draft: this.record(projectId)?.drafts.find((d) => d.id === draftId) ?? updated };
  }

  private async sendDraft(projectId: string, draftId: string, actor: 'screen' | 'agent'): Promise<{ ok: true } | { ok: false; error: string }> {
    const record = this.record(projectId);
    const d = record?.drafts.find((x) => x.id === draftId);
    const project = this.project(projectId);
    if (!d || !project) return { ok: false, error: 'no such question' };
    if (this.sending.has(d.id) || d.state === 'sent' || d.state === 'answered') return { ok: true };
    this.sending.add(d.id);
    try {
      return await this.sendDraftNow(projectId, d, project, actor);
    } finally {
      this.sending.delete(d.id);
    }
  }

  private async sendDraftNow(projectId: string, d: CoordinatorDraft, project: DeskProject, actor: 'screen' | 'agent'): Promise<{ ok: true } | { ok: false; error: string }> {
    const draftId = d.id;
    // Still one of this project's open conversations: it may have moved or finished since the draft (Codex review on #545).
    const target = this.core.item(d.toItemId);
    if (!target || target.facts.projectId !== projectId || target.disposition === 'done') {
      const error = !target ? 'that conversation is gone' : target.disposition === 'done' ? 'that conversation is done' : 'that conversation left the project';
      this.update(projectId, (r) => {
        const x = r.drafts.find((y) => y.id === draftId);
        if (x) Object.assign(x, { state: 'dropped', error });
      });
      return { ok: false, error };
    }
    // Desk mail from the retained coordinator (desk/mail.ts): the conversation view shows it as mail,
    // and its answer is anchored on the mail id. The coordinator keeps the owner's say over sending it.
    const coordinatorItem = `coordinator:${projectId}`;
    const text = `${MAIL_FROM} “Coordinator · ${project.name.replace(/[“”[\]\n]/g, '')}” [${coordinatorItem}] · ${coordinatorMailId(d.id)}\n\n${d.text}\n\n— Sent through the desk by the project coordinator, asking on the owner’s behalf. Answer it in your reply, briefly: the desk takes your reply back. Don’t start new work just to answer, and leave off any closing “Next —” line.`;
    // The answer is looked for from when the send started: a reply can land while a slow send is still out (Codex review on #545).
    const attemptAt = this.now();
    // Out of the owner's hands while it goes: a Cancel now can't be overwritten by the send's result (Codex review on #545).
    this.update(projectId, (r) => {
      const x = r.drafts.find((y) => y.id === draftId);
      if (x) x.state = 'sending';
    });
    const result = await this.core.command({ commandId: `coord-${d.id}-${randomUUID().slice(0, 8)}`, type: 'reply', itemId: d.toItemId, args: { text }, actor });
    // A timeout after the source took it may have delivered it: counted as sent (its answer is looked for
    // as usual), never sent again, which could post the same question twice (Codex review on #545).
    const unknown = result.status === 'failed' && result.outcome?.delivery === 'unknown';
    if (result.status !== 'applied' && !unknown) {
      // Back to the owner, never retried on its own: a source can fail after the words went out (a source
      // dispatch timeout), and a second send would post the question twice (Codex review on #545).
      const error = result.error ?? 'not delivered';
      this.log('desk.coordinator.send_failed', { projectId, draftId, error });
      this.update(projectId, (r) => {
        const x = r.drafts.find((y) => y.id === draftId);
        if (x) Object.assign(x, { state: 'draft', queuedAt: null, error });
      });
      return { ok: false, error };
    }
    if (unknown) this.log('desk.coordinator.send_unknown', { projectId, draftId });
    this.update(projectId, (r) => {
      const x = r.drafts.find((y) => y.id === draftId);
      if (x) {
        x.state = 'sent';
        x.sentAt = attemptAt;
        x.error = null;
      }
    });
    this.log('desk.coordinator.sent', { projectId, draftId, toItemId: d.toItemId });
    return { ok: true };
  }

  /** Queued questions go to conversations that are idle now. */
  async deliver(projectId: string): Promise<number> {
    let sent = 0;
    for (const d of this.record(projectId)?.drafts ?? []) {
      if (d.state !== 'queued') continue;
      const target = this.core.item(d.toItemId);
      if (!target || target.disposition === 'done') {
        this.update(projectId, (r) => {
          const x = r.drafts.find((y) => y.id === d.id);
          if (x) x.state = 'dropped';
        });
        continue;
      }
      if (!isIdle(target)) continue;
      if ((await this.sendDraft(projectId, d.id, 'agent')).ok) sent += 1;
    }
    return sent;
  }

  /** Answers to sent questions, once their conversation is idle again, go back to the coordinator. */
  async collect(projectId: string): Promise<number> {
    let relayed = 0;
    const record = this.record(projectId);
    for (const d of record?.drafts ?? []) {
      if (d.state === 'answered' && d.answer && !d.relayedAt) {
        if (await this.relay(projectId, d)) relayed += 1;
        continue;
      }
      if (d.state !== 'sent' || !d.sentAt) continue;
      const target = this.core.item(d.toItemId);
      const found = target ? answerAfter(this.core.store.messages(d.toItemId, 30), d.sentAt, coordinatorMailId(d.id)) : null;
      if (!target || (!found && this.now() - d.sentAt > ANSWER_WAIT_MS)) {
        this.update(projectId, (r) => {
          const x = r.drafts.find((y) => y.id === d.id);
          if (x) x.state = 'unanswered';
        });
        continue;
      }
      if (!found || !isIdle(target)) continue;
      const answer = found;
      this.update(projectId, (r) => {
        const x = r.drafts.find((y) => y.id === d.id);
        if (x) {
          x.state = 'answered';
          x.answer = { text: clip(answer.text.trim(), 4000), at: answer.at };
        }
      });
      if (await this.relay(projectId, { ...d, answer: { text: clip(answer.text.trim(), 4000), at: answer.at } })) relayed += 1;
    }
    return relayed;
  }

  /** An answer into the coordinator's thread; marked relayed only once the source accepted it (Codex review on #545). */
  private async relay(projectId: string, d: CoordinatorDraft): Promise<boolean> {
    const threadId = this.record(projectId)?.threadId;
    if (!threadId || !d.answer) return false;
    const relay = `${RELAY_PREFIX} “${d.toTitle}” (${d.toItemId}) answered your question.\n\nQuestion: ${d.text}\n\nAnswer: ${clip(d.answer.text, 3000)}`;
    const sent = await this.sendToThread(threadId, relay, `coord-relay-${d.id}`);
    if (!sent.ok) {
      this.log('desk.coordinator.relay_failed', { projectId, draftId: d.id, error: sent.error });
      return false;
    }
    this.update(projectId, (r) => {
      const x = r.drafts.find((y) => y.id === d.id);
      if (x) x.relayedAt = this.now();
    });
    return true;
  }

  // ── keep watch ──

  setWatch(projectId: string, patch: Partial<CoordinatorWatch> & { reach?: CoordinatorReach }): CoordinatorSummary | null {
    if (!this.project(projectId)) return null;
    const turnedOn = patch.on === true && !this.record(projectId)?.watch.on;
    this.update(projectId, (r) => {
      for (const key of ['on', 'stands', 'flags', 'digest'] as const) if (typeof patch[key] === 'boolean') r.watch[key] = patch[key]!;
      if (patch.reach === 'approve' || patch.reach === 'idle') r.reach = patch.reach;
    });
    // Not for a project that is away or finished: watching waits for it (Codex review on #545).
    if (turnedOn && this.deps.keepWatch && !this.watchPaused(projectId)) void this.writeStatus(projectId, 'on').catch(() => undefined);
    if (patch.reach === 'idle') void this.deliver(projectId).catch((err) => this.log('desk.coordinator.deliver.error', { projectId, message: (err as Error).message }));
    return this.summary(projectId);
  }

  /** Opening the project page: a status behind the conversations is caught up now. */
  async catchUp(projectId: string): Promise<boolean> {
    const record = this.record(projectId);
    if (!this.deps.keepWatch || !record?.watch.on || !record.watch.stands || this.watchPaused(projectId)) return false;
    const basis = basisOf(this.members(projectId));
    if (record.status?.basis === basis || this.now() - (record.status?.at ?? 0) < CATCH_UP_GAP_MS) return false;
    return this.writeStatus(projectId, 'catch-up');
  }

  private watchPaused(projectId: string): boolean {
    const project = this.project(projectId);
    return !project || !!project.finishedAt || !!project.away;
  }

  /** Rewrites "Where it stands" (one model call). */
  async writeStatus(projectId: string, why: string): Promise<boolean> {
    if (this.writing.has(projectId)) return false;
    const project = this.project(projectId);
    if (!project) return false;
    this.writing.add(projectId);
    try {
      const members = this.members(projectId);
      const basis = basisOf(members);
      const flags = flagsFor(members, this.title, this.now());
      const previous = this.record(projectId)?.status?.text ?? null;
      const written = await this.deps.write({ kind: 'status', project: { name: project.name, about: project.about ?? null }, members: members.map((m) => this.brief(m, 2)), flags, previous, now: this.now() });
      this.update(projectId, (r) => {
        r.status = { text: written.text, line: written.line, at: this.now(), basis, source: written.source };
        r.seenBasis = basis;
      });
      // A new "where it stands" is project news (desk/feed.ts); rewrites close together are one post.
      if (written.source === 'model' && written.text && written.text !== previous) {
        this.core.postFeed({ kind: 'project', projectId, title: project.name, text: written.text, data: { line: written.line }, key: `project:${projectId}`, throttleMs: 30 * 60_000 });
      }
      this.log('desk.coordinator.status', { projectId, why, source: written.source });
      return true;
    } catch (err) {
      this.log('desk.coordinator.status.error', { projectId, message: (err as Error).message });
      return false;
    } finally {
      this.writing.delete(projectId);
    }
  }

  private async writeDigest(projectId: string, day: string): Promise<void> {
    const project = this.project(projectId);
    const record = this.record(projectId);
    if (!project || !record) return;
    const since = record.digests.at(-1)?.at ?? this.now() - 86_400_000;
    const members = this.members(projectId);
    // Claimed before the call: a slow model never writes two digests for one morning.
    this.update(projectId, (r) => {
      r.digestDay = day;
    });
    try {
      const written = await this.deps.write({ kind: 'digest', project: { name: project.name, about: project.about ?? null }, members: members.map((m) => this.brief(m, 3)), flags: flagsFor(members, this.title, this.now()), previous: record.status?.text ?? null, since, now: this.now() });
      this.update(projectId, (r) => {
        r.digests.push({ at: this.now(), text: written.text });
      });
      this.core.postFeed({ kind: 'project', projectId, title: project.name, text: written.text, data: { digest: true } });
      this.log('desk.coordinator.digest', { projectId, source: written.source });
    } catch (err) {
      this.log('desk.coordinator.digest.error', { projectId, message: (err as Error).message });
    }
  }

  /** Every 30 s: deliver queued questions, relay answers, and keep watching projects current. */
  async tick(): Promise<void> {
    const records = this.all();
    const now = this.now();
    for (const record of Object.values(records)) {
      const projectId = record.projectId;
      if (!this.project(projectId)) continue;
      // A send cut off by a restart: back to the owner (it may have gone through), never resent on its own.
      if (record.drafts.some((d) => d.state === 'sending' && !this.sending.has(d.id))) {
        this.update(projectId, (r) => {
          for (const d of r.drafts) if (d.state === 'sending' && !this.sending.has(d.id)) Object.assign(d, { state: 'draft', queuedAt: null, error: 'the desk restarted while sending it' });
        });
      }
      if (record.drafts.some((d) => d.state === 'queued')) await this.deliver(projectId);
      if (record.drafts.some((d) => d.state === 'sent' || (d.state === 'answered' && !d.relayedAt))) await this.collect(projectId);
      // Retired (docs/specs/spaces.md): a space's default says where it stands now, so a watch left on from
      // before (any install, restored data) writes nothing and makes no model calls.
      if (!this.deps.keepWatch || !record.watch.on || this.watchPaused(projectId)) continue;
      const members = this.members(projectId);
      // Time alone can raise a flag (a wait passing a day): screens get it without anything else changing.
      if (record.watch.flags) {
        const sig = flagsFor(members, this.title, now).map((f) => `${f.itemId}:${f.kind}:${f.text}`).join('|');
        if (sig !== (record.flagsSig ?? '')) this.update(projectId, (r) => void (r.flagsSig = sig));
      }
      const basis = basisOf(members);
      if (basis !== record.seenBasis) {
        this.update(projectId, (r) => {
          r.seenBasis = basis;
          r.changedAt = now;
        });
        continue;
      }
      const stale = record.watch.stands && record.status?.basis !== basis;
      if (stale && now - (record.changedAt ?? 0) >= SETTLE_MS && now - (record.status?.at ?? 0) >= MIN_GAP_MS) await this.writeStatus(projectId, 'changed');
      if (record.watch.digest) {
        const morning = morningOf(now, this.deps.morning?.() ?? '06:00');
        if (now >= morning.at && now - morning.at < 6 * 3_600_000 && record.digestDay !== morning.day) await this.writeDigest(projectId, morning.day);
      }
    }
  }
}

/** The status writer on a small model (Ollama's OpenAI-compatible API), with the counting fallback. */
export function createCoordinatorWriter(options: { apiKey: string; model: string; baseUrl?: string; timeoutMs?: number }): CoordinatorWriter {
  const url = `${(options.baseUrl ?? 'https://ollama.com/v1').replace(/\/$/, '')}/chat/completions`;
  return async (input) => {
    const fallback = () => {
      const counted = countingStatus(input.members, input.flags);
      return { ...counted, source: 'text' as const };
    };
    if (!options.apiKey) return fallback();
    const members = input.members
      .map((m) =>
        [
          `- ${m.title} [${m.state}${m.disposition !== 'active' ? `, ${m.disposition}` : ''}] (last activity ${m.lastActivityAt})`,
          m.summary ? `  Where it is: ${clip(m.summary, 500)}` : '',
          m.ask ? `  Asks the owner: ${m.ask}` : '',
          m.waitingOn ? `  Waiting on: ${m.waitingOn}` : '',
          m.pullRequest ? `  PR: ${m.pullRequest}` : '',
          m.failed ? `  Failed: ${m.failed}` : '',
          ...m.recent.map((r) => `  ${r.author} (${r.at}): ${clip(r.text, 300)}`),
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n');
    const flags = input.flags.length ? `\nStalls the desk flagged:\n${input.flags.map((f) => `- ${f.title} ${f.text}`).join('\n')}` : '';
    const ask =
      input.kind === 'status'
        ? [
            `Write where the owner's project “${input.project.name}” stands now, from its conversations below.`,
            'text: one paragraph, at most 70 words. Lead with what needs the owner (decisions, approvals, failures), then what is moving. Name conversations by their titles. Plain text, no lists, no markdown.',
            'line: the same in one line of at most 22 words, for the project folder in a list.',
            'Reply with JSON only: {"text": string, "line": string}.',
          ]
        : [
            `Write the owner's morning digest for the project “${input.project.name}”: what changed since ${iso(input.since ?? input.now - 86_400_000)} and what is on them today.`,
            'text: at most 5 short markdown bullets ("- …"), changes first, then "Still on you: …" if anything waits on the owner. Name conversations by their titles. If nothing changed, one bullet saying so.',
            'line: one line of at most 22 words.',
            'Reply with JSON only: {"text": string, "line": string}.',
          ];
    const prompt = [...ask, '', input.project.about ? `About the project: ${input.project.about}` : '', input.previous ? `The previous status: ${input.previous}` : '', `Now: ${iso(input.now)}`, '', 'Conversations:', members || '(none open)', flags].filter((l) => l !== '').join('\n');
    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.model,
          messages: [
            { role: 'system', content: 'You write terse, factual project status for a busy owner. Never invent anything the conversations do not say. Reply with JSON only.' },
            { role: 'user', content: prompt },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1,
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const raw = body.choices?.[0]?.message?.content ?? '';
      const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { text?: string; line?: string };
      const text = String(parsed.text ?? '').trim();
      const line = String(parsed.line ?? '').replace(/\s+/g, ' ').trim();
      if (!text) throw new Error('empty status');
      return { text: clip(text, 1200), line: clip(line || text.replace(/\s+/g, ' '), 200), source: 'model' };
    } catch {
      return fallback();
    }
  };
}
