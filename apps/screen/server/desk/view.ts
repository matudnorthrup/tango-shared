import { ownerReceipts, type OwnerReceipt } from './owner-receipts.js';
import { sortThreadPrs } from './thread-prs.js';
import { matches, countFor, agentId } from '../../public/desk/query.js';
import { backstageLine, isAnswerCorrection, lastOwnerTurn, lastReportTurn, mailBodyOf, mailLog, mailSince, queuedOf, shortPeer, turnsOf, type MailLine, type Turn } from './backstage.js';
import { deskStatus, needsOwner, reportsUp, waitTarget, type DeskStatus } from './status.js';
import type { DeskMessage, MessageMail } from './types.js';
import { agentColor, publicScene, type PublicScene } from '../hub.js';
import { textSummary } from '../inbox-summarize.js';
import { publicPrototype, type Prototype, type PublicPrototype } from '../prototypes.js';
import type { Scene } from '../store.js';
import { imagesWord, type MessageAttachment } from './attachments.js';
import type { DeskCore } from './core.js';
import { coordinatorItemIds } from './coordinator.js';
import { filterMatches, readFilters, type DeskFilters, type FilterMatch } from './filters.js';
import { isAttentionEvent, NEXT_STEPS, splitByTime, type DeskEvent, type DeskItem, type NextStep, type PendingRequest } from './types.js';

// The read side: views, grouping into sections, the item detail (messages,
// timeline beats, linked scenes), the activity feed and the catch-up briefing.

export type DeskView = 'active' | 'snoozed' | 'everything' | 'history';
export type DeskGroup = 'step' | 'seen' | 'agent' | 'area';
export const DESK_VIEWS: readonly DeskView[] = ['active', 'snoozed', 'everything', 'history'];
export const DESK_GROUPS: readonly DeskGroup[] = ['step', 'seen', 'agent', 'area'];

const STEP_LABELS: Record<NextStep, string> = { your_move: 'Your move', failed: 'Failed', working: 'Working', watching: 'Watching', fyi: 'FYI' };
const SEEN_ORDER = ['new', 'updated', 'seen'] as const;
const SEEN_LABELS = { new: 'New', updated: 'Updated', seen: 'Seen' };

export interface DeskItemView extends DeskItem {
  color: string;
  /** The card's one-liner: the ask when there is one, else the gist. */
  line: string;
  /** The in-app filters this item matches (spec "Filters"); annotated in every view; owner queues exclude muted items. */
  filteredBy?: FilterMatch[];
  /** Whose move it is and whether the agent is busy: the row's pill and dot (status.ts). */
  status: DeskStatus;
}

export interface DeskSection {
  key: string;
  label: string;
  itemIds: string[];
}

export function inView(item: DeskItem, view: DeskView): boolean {
  switch (view) {
    case 'active':
      // A row marked done with an open brief, question or approval stays here until that record closes.
      return !item.hidden && (matches(item, { scope: { kind: 'global' }, audience: 'all', where: { disposition: { in: ['active'] } } }) || stillOpen(item));
    case 'snoozed':
      return matches(item, { scope: { kind: 'global' }, audience: 'all', where: { disposition: { in: ['snoozed', 'parked'] } } });
    case 'history':
      return matches(item, { scope: { kind: 'global' }, audience: 'all', where: { disposition: { in: ['done'] } } }) && !stillOpen(item);
    case 'everything':
      return true;
  }
}

const stillOpen = (item: DeskItem): boolean => item.disposition === 'done' && deskStatus(item).layer === 'needs';

/** On the Active board: active, not hidden by the rules file, and not filtered out by the owner's toggles. */
function onBoard(item: DeskItem, filters: DeskFilters): boolean {
  return inView(item, 'active') && filterMatches(item, filters).length === 0;
}

/** Inside a section: New/Updated first, then the most recent activity. */
export function sectionOrder(a: DeskItem, b: DeskItem): number {
  const fresh = (item: DeskItem) => (item.seen === 'seen' ? 0 : 1);
  return fresh(b) - fresh(a) || b.lastActivityAt - a.lastActivityAt;
}

export function presentItem(item: DeskItem): DeskItemView {
  const status = deskStatus(item);
  const gist = item.summary?.gist ?? '';
  const wait = item.facts.waits?.[0];
  const summary = item.summary ? { ...item.summary,
    step: status.pill === 'needs' ? 'your_move' as const : status.pill === 'waiting' ? 'watching' as const : 'fyi' as const,
    ask: status.pill === 'needs' ? status.detail : null,
    askKind: status.pill === 'needs' ? 'decision' as const : null,
    askDueAt: null,
    options: item.facts.pending?.options ?? [],
    waitingOn: status.pill === 'waiting' && wait ? { who: waitTarget(wait, Date.now()), what: status.detail } : null,
    watchUntil: wait?.dueAt ? new Date(wait.dueAt).toISOString() : null,
  } : null;
  return { ...item, prs: sortThreadPrs(item.prs ?? []), summary, status, color: agentColor(item.agentId), line: status.detail || (gist ? `Summary: ${textSummary(gist, 140)}` : '') };

}

/**
 * Since when the owner's move has been waiting: the first agent message after the owner last wrote
 * (a failure counts from the failure). Older waits come first in the "next up" queue.
 */
export function waitingSince(core: DeskCore, item: DeskItem): number {
  if (item.nextStep === 'failed' && item.facts.failed) return item.facts.failed.at;
  // Straight from the store: a long run of agent messages since the owner wrote must not hide where the wait began.
  return core.store.firstAgentMessageAfter(item.id, item.lastOwnerMessageAt ?? 0) ?? item.lastActivityAt;
}

/** One entry of the "next up" queue (GET /api/desk/next). */
export interface NextUpItem {
  id: string;
  agentId: string;
  agentName: string;
  place: string | null;
  title: string | null;
  ask: string | null;
  pill: ReturnType<typeof deskStatus>['pill'];
  step: 'your_move' | 'failed';
  waitingSince: number;
}

// What waits on the owner is the evaluator's one answer (desk/status.ts needsOwner), the same for the sidebar's
// count, Next up, the briefing and voice (owner, 10/18).
export { needsOwner } from './status.js';

export function nextUpQueue(core: DeskCore): NextUpItem[] {
  const filters = readFilters(core.store);
  return core
    .items()
    .filter((item) => onBoard(item, filters) && needsOwner(item))
    .map((item) => ({
      id: item.id,
      agentId: item.agentId,
      agentName: item.agentName,
      place: item.facts.name || item.place,
      title: item.summary?.title ?? null,
      ask: item.ask,
      pill: deskStatus(item).pill,
      step: deskStatus(item).live === 'failed' ? ('failed' as const) : ('your_move' as const),
      waitingSince: waitingSince(core, item),
    }))
    .sort((a, b) => a.waitingSince - b.waitingSince || a.id.localeCompare(b.id));
}

export function listItems(core: DeskCore, options: { view?: DeskView; group?: DeskGroup; agentId?: string } = {}) {
  const view = options.view ?? 'active';
  const group = options.group ?? 'step';
  const all = core.items();
  const filters = readFilters(core.store);
  const visible = (item: DeskItem) => inView(item, view);
  const items = all.filter((item) => visible(item) && (!options.agentId || matches(item, { scope: { kind: 'global' }, audience: 'all', where: { agent: { in: [options.agentId] } } }))).sort(sectionOrder);
  const buckets = new Map<string, { label: string; itemIds: string[] }>();
  const order: string[] = [];
  if (group === 'step') for (const step of NEXT_STEPS) order.push(step);
  if (group === 'seen') order.push(...SEEN_ORDER);
  for (const item of items) {
    const key = group === 'step' ? item.nextStep : group === 'seen' ? item.seen : group === 'agent' ? agentId(item) || 'none' : (item.area ?? item.agentName);
    const label = group === 'step' ? STEP_LABELS[item.nextStep] : group === 'seen' ? SEEN_LABELS[item.seen] : group === 'agent' ? item.facts?.agentSpace?.name || item.agentName : (item.area ?? item.agentName);
    if (!buckets.has(key)) buckets.set(key, { label, itemIds: [] });
    buckets.get(key)!.itemIds.push(item.id);
    if (!order.includes(key)) order.push(key);
  }
  const sections: DeskSection[] = order.filter((key) => buckets.has(key)).map((key) => ({ key, ...buckets.get(key)! }));
  // Items in section order, so a client can render without re-sorting.
  const byId = new Map(items.map((item) => [item.id, item]));
  // The owner's place in line on Your move / Failed cards (Active only).
  const queue = view === 'active' ? new Map(nextUpQueue(core).map((entry, index) => [entry.id, { waitingSince: entry.waitingSince, queuePos: index + 1 }])) : new Map();
  const ordered = sections.flatMap((section) =>
    section.itemIds.map((id) => {
      const item = { ...presentItem(byId.get(id)!), ...(queue.get(id) ?? {}) };
      const matches = filterMatches(item, filters);
      return matches.length ? { ...item, filteredBy: matches } : item;
    }),
  );
  const active = all.filter((item) => onBoard(item, filters));
  const counts = {
    active: active.length,
    /** Active items the owner's filters keep off the board. */
    filtered: all.filter((item) => inView(item, 'active') && !onBoard(item, filters)).length,
    new: active.filter((item) => item.seen === 'new').length,
    updated: active.filter((item) => item.seen === 'updated').length,
    yourMove: active.filter((item) => needsOwner(item)).length,
    snoozed: countFor(all, { scope: { kind: 'global' }, audience: 'all', where: { disposition: { in: ['snoozed'] } } }),
    parked: countFor(all, { scope: { kind: 'global' }, audience: 'all', where: { disposition: { in: ['parked'] } } }),
    done: countFor(all, { scope: { kind: 'global' }, audience: 'all', where: { disposition: { in: ['done'] } } }),
    ...Object.fromEntries(NEXT_STEPS.map((step) => [step, active.filter((item) => item.nextStep === step).length])),
  };
  return { view, group, items: ordered, sections, counts, sweep: sweepCard(core) };
}

/** The weekly sweep card: `{ day, at, items }` with the candidates still on the desk, or null. Filtered items stay out (an Active surface). */
export function sweepCard(core: DeskCore): { day: 'saturday' | 'monday'; at: number; items: DeskItemView[] } | null {
  const pending = core.pendingSweep();
  if (!pending) return null;
  const filters = readFilters(core.store);
  const items = core
    .itemsByIds(pending.itemIds)
    .filter((item) => filterMatches(item, filters).length === 0)
    .map(presentItem);
  return items.length ? { day: core.sweepDay(), at: pending.at, items } : null;
}

/** The scenes an agent staged in this item's conversation. A home channel's scenes belong to its latest chapter. */
export function scenesFor(core: DeskCore, item: DeskItem, scenes: Scene[]): string[] {
  const latest = splitByTime(item) ? core.store.latestInConversation(item.conversationKey)?.id : item.id;
  return scenes
    .filter((scene) => {
      const origin = scene.origin;
      if (origin.conversationKey) return origin.conversationKey === item.conversationKey && latest === item.id;
      if (item.threadId) return origin.threadId === item.threadId;
      if (splitByTime(item)) return !origin.threadId && origin.channelId === item.channelId && latest === item.id;
      return false;
    })
    .map((scene) => scene.id);
}

const BEAT_LABELS: Partial<Record<DeskEvent['type'], string>> = {
  done: 'Done',
  reopen: 'Reopened',
  snooze: 'Snoozed',
  park: 'Parked',
  pickup: 'Picked up',
  'snooze.expired': 'Back from snooze',
  'chapter.settled': 'Settled',
  'sweep.keep': 'Picked up in the sweep',
  'sweep.drop': 'Done in the sweep',
  'source.done': 'Settled at the source',
};

/** One line of "How we got here". owner = the owner's words; ok = a step that went right; fail; now = where it stands. */
export interface TimelineBeat {
  at: number;
  kind: 'owner' | 'agent' | 'ok' | 'now' | 'fail';
  text: string;
  seq?: number;
}

/** A scene staged in an item's conversation, as the detail lists it. */
/** `from`: staged by a conversation that reports to this one (its worker or job), which a tap answers. */
type ReportedFrom = { itemId: string; title: string; conversationKey: string };
export type DetailScene = PublicScene & { itemId: string; from?: ReportedFrom };
type DetailPrototype = PublicPrototype & { from?: ReportedFrom };

/** The open jobs and workers that report to this conversation, and theirs: what it speaks for to the owner. */
export function reportingTo(core: DeskCore, item: DeskItem): DeskItem[] {
  const all = core.items();
  const found: DeskItem[] = [];
  let level = new Set([item.id]);
  for (let depth = 0; depth < 3 && level.size; depth++) {
    const next = all.filter((other) => !!other.facts.parentItemId && level.has(other.facts.parentItemId) && (other.facts.role === 'worker' || other.facts.role === 'ops') && other.disposition !== 'done' && !found.includes(other));
    found.push(...next);
    level = new Set(next.map((other) => other.id));
  }
  return found;
}

/** The timeline from the owner's request to now, ending with where it stands. */
export function timelineFor(core: DeskCore, item: DeskItem, messages: ReturnType<DeskCore['store']['messages']>): TimelineBeat[] {
  const askedAt = item.facts.lastOwnerRequest?.at ?? messages[0]?.at ?? item.createdAt;
  const beats: TimelineBeat[] = [];
  for (const message of messages) {
    if (message.at < askedAt || message.author === 'other') continue;
    beats.push(message.author === 'owner' ? { at: message.at, kind: 'owner', text: `You: “${textSummary(message.text, 140)}”` } : { at: message.at, kind: 'agent', text: textSummary(message.text, 160) });
  }
  for (const event of core.store.eventsFor(item.id)) {
    if (event.at < askedAt || core.store.isUndone(event.seq)) continue;
    // An answer to a T3 question/approval sent from the desk (no message of its own in the thread).
    if (event.type === 'source.owner_posted' && typeof event.payload.said === 'string') {
      beats.push({ at: event.at, kind: 'owner', text: `You answered: ${textSummary(event.payload.said, 160)}`, seq: event.seq });
      continue;
    }
    if (event.type === 'writeback') {
      if (event.payload.outcome === 'failed') beats.push({ at: event.at, kind: 'fail', text: `Write-back failed: ${String(event.payload.error ?? 'unknown error')}`, seq: event.seq });
      continue;
    }
    const label = BEAT_LABELS[event.type];
    if (label) beats.push({ at: event.at, kind: 'ok', text: label, seq: event.seq });
  }
  const failed = item.facts.failed;
  if (failed && failed.at >= askedAt) beats.push({ at: failed.at, kind: 'fail', text: failed.message || `Turn failed (${failed.reason})` });
  // An answer T3 took and then reported failed: the question is back.
  const answerFailed = item.facts.pending?.failed;
  if (answerFailed) beats.push({ at: answerFailed.at, kind: 'fail', text: `The source didn’t take that answer: ${textSummary(answerFailed.message, 140)}` });
  beats.sort((a, b) => a.at - b.at);
  const now = nowBeat(item);
  if (now) beats.push(now);
  return beats;
}

function nowBeat(item: DeskItem): TimelineBeat | null {
  const at = Math.max(item.lastActivityAt, item.activity?.at ?? 0);
  switch (item.nextStep) {
    case 'your_move':
      return { at, kind: 'now', text: item.ask ? `Waiting on you: ${textSummary(item.ask, 120)}` : 'Waiting on you' };
    case 'working':
      return { at, kind: 'now', text: item.activity?.text ? `Working: ${item.activity.text}` : 'Working on it' };
    case 'watching': {
      const waiting = item.watching?.waitingOn;
      return { at, kind: 'now', text: waiting ? `Waiting on ${waiting.who}: ${waiting.what}` : `Watching${item.watching?.reason ? `: ${textSummary(item.watching.reason, 100)}` : ''}` };
    }
    default:
      return null;
  }
}

/**
 * One beat of the Conversation view's "How we got here": a headline for a message (the full
 * text is in `messages` under the same id, opened in a modal), or a desk event (no message).
 */
export interface ThreadBeat {
  at: number;
  kind: 'owner' | 'agent' | 'ok' | 'fail' | 'mail' | 'backstage' | 'wake';
  headline: string;
  messageId: string | null;
  /** A mail marker (read mid-turn, or sent): who, and which mail. */
  mail?: { kind: MessageMail['kind']; title: string; itemId: string | null; mailId: string | null };
  /** A backstage line, or a marker: the mail it is, oldest first. */
  lines?: CompactMailLine[];
  /** The owner's words the agent hasn't started on yet. */
  queued?: boolean;
}

/** One mail as the Conversation view lists it: who, its headline, and the headline of what came back. */
export interface CompactMailLine {
  at: number;
  kind: MessageMail['kind'];
  peer: string;
  peerId: string | null;
  headline: string;
  text: string;
  answer: string | null;
  inline: boolean;
}

export function compactLine(line: MailLine): CompactMailLine {
  return { at: line.at, kind: line.kind, peer: shortPeer(line.peer), peerId: line.peerId, headline: headline(line.text), text: line.text.length > 1200 ? `${line.text.slice(0, 1199).trimEnd()}…` : line.text, answer: line.answer ? headline(line.answer) : null, inline: line.inline };
}

/** The agent's latest reply in full: the message ids it is made of and their text. */
export interface LatestReply {
  notes?: LatestReply[];
  at: number;
  messageIds: string[];
  text: string;
  /** The images in the run, in order (absent with none). */
  attachments?: MessageAttachment[];
}

/** A message's words, or what it showed when it was only images ("(2 images)"). */
function wordsOf(message: { text: string; attachments?: MessageAttachment[] }): string {
  return message.text.trim() ? message.text : message.attachments?.length ? `(${imagesWord(message.attachments.length)})` : '';
}

const LONG_MESSAGE = 600;
/** Shorter agent messages in the middle of a run are progress notes. */
const PROGRESS_NOTE = 200;
const MAX_REPLY_PARTS = 8;

/** A message's first sentence as plain text: markdown dropped, at most 120 characters. */
export function headline(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*(#{1,6}\s+|[-+]\s+|\d+[.)]\s+|>\s*)/, '').trim())
    .filter((line) => line && !/^\|?[-:| ]+\|?$/.test(line));
  const first = plain[0] ?? '';
  const sentence = first.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? first;
  return textSummary(sentence.replace(/[:;,]\s*$/, ''), 120);
}

type DeskMessages = ReturnType<DeskCore['store']['messages']>;

/**
 * "How we got here" across the whole window: every owner message, and for each run of agent
 * messages its last one plus any long one (progress chatter in between is left out), merged
 * with desk events (answers, done, snoozed, write-back failures).
 */
export function threadBeats(core: DeskCore, item: DeskItem, messages: DeskMessages): ThreadBeat[] {
  const beats: ThreadBeat[] = [];
  const queued = new Set(queuedOf(messages, item.facts.running ?? null).map((q) => q.messageId));
  // Mail turns between the owner's turns fold into one backstage line each (desk/backstage.ts).
  let backstage: MailLine[] = [];
  const flush = () => {
    if (!backstage.length) return;
    beats.push({ at: backstage.at(-1)!.at, kind: 'backstage', headline: backstageLine(backstage), messageId: null, lines: backstage.map(compactLine) });
    backstage = [];
  };
  for (const turn of turnsOf(messages)) {
    if (turn.opener === 'mail' || turn.wake?.cause === 'corrective') {
      backstage.push(...mailLog([turn]));
      continue;
    }
    flush();
    if (turn.opener === 'you' && turn.open) {
      const words = wordsOf(turn.open);
      if (words) beats.push({ at: turn.open.at, kind: 'owner', headline: headline(words), messageId: turn.open.messageId, ...(queued.has(turn.open.messageId) ? { queued: true } : {}) });
    }
    // Loom woke it: no message opens the turn, so a beat just ahead of its first words stands in.
    if (turn.opener === 'wake' && turn.replies.length) beats.push({ at: turn.replies[0]!.at - 1, kind: 'wake', headline: turn.wake?.note ? `A wait came due: ${turn.wake.note}` : 'Loom woke it up', messageId: null });
    // Each run of what the agent said: its last message, and any long one (progress chatter in between left out).
    turn.replies.forEach((message, index) => {
      const words = wordsOf(message);
      if (!words) return;
      const last = index === turn.replies.length - 1;
      if (last || message.text.length >= LONG_MESSAGE || message.attachments?.length) beats.push({ at: message.at, kind: 'agent', headline: headline(words), messageId: message.messageId });
    });
    // Mail read mid-turn, and mail this one sent: a marker where it happened.
    // All of the turn's markers at once, so an explicit answer joins the mail it answers (Codex review on #579).
    const markerLines = mailLog([{ ...turn, opener: 'none', open: null, mail: null, replies: [] }]);
    for (const { message, mail } of turn.markers) {
      const body = headline(mailBodyOf(message));
      const label = mail.kind === 'out' ? `✉️ To ${shortPeer(mail.peer)}` : mail.kind === 'started' ? `🧵 Started ${shortPeer(mail.peer)}` : `✉️ From ${shortPeer(mail.peer)}`;
      beats.push({ at: message.at, kind: 'mail', headline: `${label}: ${body}`, messageId: message.messageId, mail: { kind: mail.kind, title: mail.peer, itemId: mail.peerId ?? null, mailId: mail.mailId ?? null }, lines: markerLines.filter((line) => line.messageId === message.messageId).map(compactLine) });
    }
  }
  flush();
  const since = messages[0]?.at ?? item.createdAt;
  for (const event of core.store.eventsFor(item.id)) {
    if (event.at < since || core.store.isUndone(event.seq)) continue;
    if (event.type === 'source.owner_posted' && typeof event.payload.said === 'string') {
      beats.push({ at: event.at, kind: 'owner', headline: `You answered: ${textSummary(event.payload.said, 110)}`, messageId: null });
      continue;
    }
    if (event.type === 'writeback') {
      if (event.payload.outcome === 'failed') beats.push({ at: event.at, kind: 'fail', headline: `Write-back failed: ${String(event.payload.error ?? 'unknown error')}`, messageId: null });
      continue;
    }
    const label = BEAT_LABELS[event.type];
    if (label) beats.push({ at: event.at, kind: 'ok', headline: label, messageId: null });
  }
  if (item.facts.failed && item.facts.failed.at >= since) beats.push({ at: item.facts.failed.at, kind: 'fail', headline: item.facts.failed.message || `Turn failed (${item.facts.failed.reason})`, messageId: null });
  return beats.sort((a, b) => a.at - b.at);
}

/**
 * The agent's latest reply, in full: every message of its last run (everything it said since the
 * owner last wrote; a Discord agent splits a long answer across messages), minus short progress
 * notes ahead of a long answer ("I'll check the logs.").
 */
export function latestReply(messages: DeskMessages): LatestReply | null {
  let end = messages.length - 1;
  while (end >= 0 && messages[end]!.author !== 'agent') end -= 1;
  if (end < 0) return null;
  let start = end;
  while (start > 0 && messages[start - 1]!.author === 'agent') start -= 1;
  // A short message is a progress note only when a long message follows it in the run (the
  // answer it was working toward); a reply made only of short messages is kept whole.
  const all = messages.slice(start, end + 1);
  if (all.some(message => message.meta?.phase)) {
    // Pending/unlabelled text and images must stay visible, including interrupted turns.
    const answers = all.filter(message => message.meta?.phase !== 'note' || message.attachments?.length);
    if (!answers.length) answers.push(all.at(-1)!);
    const notes = all.filter(message => !answers.includes(message)).map(message => ({
      at: message.at, messageIds: [message.messageId], text: message.text,
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    }));
    const attachments = answers.flatMap(message => message.attachments ?? []);
    return { at: answers.at(-1)?.at ?? all.at(-1)!.at, messageIds: answers.map(message => message.messageId),
      text: answers.map(message => message.text).filter(text => text.trim()).join('\n\n'), notes,
      ...(attachments.length ? { attachments } : {}) };
  }
  // A message with an image is never a progress note: the picture is part of the answer.
  const candidates = all.filter((message, index) => message.text.length >= PROGRESS_NOTE || message.attachments?.length || !all.slice(index + 1).some((later) => later.text.length >= LONG_MESSAGE));
  // Cap after filtering, preserving the opening answer and the final report.
  const run = candidates.length <= MAX_REPLY_PARTS ? candidates
    : [candidates[0]!, ...candidates.slice(1, -1).sort((a, b) =>
      Number(b.text.length >= LONG_MESSAGE) - Number(a.text.length >= LONG_MESSAGE) || b.at - a.at
    ).slice(0, MAX_REPLY_PARTS - 2), candidates.at(-1)!].sort((a, b) => a.at - b.at);
  const attachments = run.flatMap((message) => message.attachments ?? []);
  return {
    at: messages[end]!.at,
    messageIds: run.map((message) => message.messageId),
    text: run.map((message) => message.text).filter((text) => text.trim()).join('\n\n'),
    ...(attachments.length ? { attachments } : {}),
  };
}

export interface SinceOwner {
  owner: { messageId: string; at: number; text: string };
  first: (LatestReply & { headline: string }) | null;
  updates: Array<LatestReply & { headline: string }>;
  latest: LatestReply | null;
  acks: LatestReply[];
}

/** The answer to the owner's words survives subsequent worker reports and wake acknowledgements. */
export function sinceOwner(turns: Turn[]): SinceOwner | null {
  const start = turns.indexOf([...turns].reverse().find(turn => turn.opener === 'you')!);
  if (start < 0) return null;
  const ownerTurn = turns[start]!;
  const owner = ownerTurn.open!;
  const first = latestReply(ownerTurn.replies);
  const reports = turns.slice(start + 1).flatMap(turn => {
    if (lastReportTurn([turn]) !== turn && !isAnswerCorrection(turn, turns)) return [];
    const reply = latestReply(turn.replies);
    return reply ? [reply] : [];
  });
  // Only trailing short reports after a substantive answer are folded. Keep their full text accessible.
  const lastSubstantive = reports.indexOf([...reports].reverse().find(report => report.text.length >= LONG_MESSAGE || report.attachments?.length)!);
  const acks = lastSubstantive >= 0 || (first && (first.text.length >= LONG_MESSAGE || first.attachments?.length))
    ? reports.splice(lastSubstantive + 1) : [];
  const last = reports.pop() ?? null;
  return {
    owner: { messageId: owner.messageId, at: owner.at, text: owner.text }, first: first ? { ...first, headline: headline(first.text) } : null,
    updates: reports.map(report => ({ ...report, headline: headline(report.text) })),
    latest: last, acks,
  };
}

/** The item with its last 40 messages, the timeline, the thread's beats, the latest reply in full, and the scenes of its conversation. */
export function itemDetail(
  core: DeskCore,
  id: string,
  scenes: Scene[],
  prototypes: Prototype[] = [],
): {
  item: DeskItemView;
  messages: DeskMessages;
  timeline: TimelineBeat[];
  beats: ThreadBeat[];
  reply: LatestReply | null;
  sinceOwner: SinceOwner | null;
  laterNotes: { count: number; notes: LatestReply[] } | null;
  /** Mail since the latest reply to the owner: one line, and what it folds. */
  backstage: { line: string; lines: CompactMailLine[] } | null;
  /** Every mail in the window, for the Mail tab. */
  mail: CompactMailLine[];
  /** The owner's words waiting for the agent. */
  queued: Array<{ messageId: string; at: number; text: string }>;
  ownerReceipts: OwnerReceipt[];
  receiptCommandIds: string[];
  scenes: DetailScene[];
  prototypes: DetailPrototype[];
} | null {
  const item = core.item(id);
  if (!item) return null;
  // A wider window than the reply needs: busy mail can push the owner's own exchanges out of a short one.
  let messages = core.store.messages(id, 120);
  const ask = item.facts.openAsk;
  const brief = item.facts.openBrief;
  const anchor = brief?.runId ? { at: brief.at, runId: brief.runId, messageId: undefined } : ask && !ask.to && (ask.messageId || ask.runId) ? ask : null;
  const pin = anchor && (item.lastOwnerMessageAt === null || item.lastOwnerMessageAt <= anchor.at) ? anchor : null;
  const matchesAnchor = (m: DeskMessage) => !!pin && (pin.messageId ? m.messageId === pin.messageId : m.meta?.runId === pin.runId);
  if (pin && (!messages.some(matchesAnchor) || (pin.runId && messages[0]?.meta?.runId === pin.runId))) messages = core.store.messages(id, Math.max(120, item.messageCount));
  // Busy worker traffic must not evict the owner turn (or its opening answer) from this view.
  if (item.lastOwnerMessageAt !== null && messages[0] && messages[0].at >= item.lastOwnerMessageAt)
    messages = core.store.messages(id, Math.max(120, item.messageCount));
  const turns = turnsOf(messages);
  // The run's last matching turn: an owner steer splits one run into turns, and the report comes after it.
  const pinned = pin ? [...turns].reverse().find(turn => turn.replies.some(matchesAnchor)) : null;
  const ownerSpoke = turns.some(turn => turn.opener === 'you') || item.lastOwnerMessageAt !== null;
  const latestReport = (among: Turn[]) => ownerSpoke ? lastReportTurn(among)
    : [...among].reverse().find(turn => turn.wake?.cause !== 'corrective' && turn.replies.length) ?? null;
  // Even a brief raised during a corrective does not promote that wake (or mail before it) into a report.
  const pinnedReport = pinned?.wake?.cause === 'corrective' && !isAnswerCorrection(pinned, turns) ? latestReport(turns.slice(0, turns.indexOf(pinned))) : pinned;
  // An anchor this conversation can't match (a linked Discord item carries Loom ids) keeps the usual report.
  const correction = [...turns].reverse().find(turn => turn.replies.length && isAnswerCorrection(turn, turns) &&
    pinnedReport?.replies.some(message => message.meta?.runId === turn.wake?.answersRun));
  const report = correction ?? pinnedReport ?? latestReport(turns);
  const later = report ? turns.slice(turns.indexOf(report) + 1).flatMap(turn => {
    const reply = latestReply(turn.replies);
    return reply ? [reply] : [];
  }) : [];
  const reply = report ? latestReply(report.replies) : null;
  const since = mailSince(turns);
  const ids = new Set(scenesFor(core, item, scenes));
  const linked = scenes.filter((scene) => ids.has(scene.id)).sort((a, b) => b.updatedAt - a.updatedAt);
  const reported = { scenes: [] as DetailScene[], prototypes: [] as DetailPrototype[] };
  for (const other of reportingTo(core, item)) {
    const from = { itemId: other.id, title: core.title(other), conversationKey: other.conversationKey };
    const theirs = new Set(scenesFor(core, other, scenes));
    reported.scenes.push(...scenes.filter((scene) => theirs.has(scene.id)).sort((a, b) => b.updatedAt - a.updatedAt).map((scene) => ({ ...publicScene(scene), itemId: other.id, from })));
    reported.prototypes.push(...prototypes.filter((prototype) => prototype.conversationKey === other.conversationKey).sort((a, b) => b.updatedAt - a.updatedAt).map((prototype) => ({ ...publicPrototype(prototype), from })));
  }
  // Clients (the voice operator) need to know an item is filtered off the board, not only list views.
  const presented = presentItem(item);
  const matches = filterMatches(presented, readFilters(core.store));
  return {
    item: matches.length ? { ...presented, filteredBy: matches } : presented,
    messages,
    timeline: timelineFor(core, item, messages),
    beats: threadBeats(core, item, messages),
    // The latest reply to the owner: answers to mail written to it never take its place (desk/backstage.ts).
    // A conversation the owner never spoke in (one an agent started): its own replies are the conversation.
    // "The owner spoke" from the item too: busy mail can push every owner message out of the window (Codex review on #575).
    reply,
    sinceOwner: sinceOwner(turns),
    laterNotes: later.length ? { count: later.length, notes: later } : null,
    backstage: since ? { line: since.line, lines: since.lines.map(compactLine) } : null,
    mail: mailLog(turns).map(compactLine),
    queued: queuedOf(messages, item.facts.running ?? null),
    ...ownerReceipts(messages, core.store.eventsFor(id), reply?.at ?? null),
    // Its workers' and jobs' screens too: the owner works with them here, never over there (owner, 10/18).
    scenes: [...linked.map((scene) => ({ ...publicScene(scene), itemId: item.id })), ...reported.scenes],
    // A chapter's prototypes belong to its latest chapter, like its scenes.
    prototypes:
      splitByTime(item) && core.store.latestInConversation(item.conversationKey)?.id !== item.id
        ? []
        : [...prototypes.filter((prototype) => prototype.conversationKey === item.conversationKey).sort((a, b) => b.updatedAt - a.updatedAt).map(publicPrototype), ...reported.prototypes],
  };
}

/** Recent events worth showing, newest first, with whether each can still be undone. */
export function activityFeed(core: DeskCore, limit = 50) {
  const types = ['seen', 'unseen', 'done', 'reopen', 'snooze', 'park', 'pickup', 'snooze.expired', 'chapter.settled', 'sweep.keep', 'sweep.drop', 'source.done', 'source.step', 'writeback', 'undo'];
  // Not a project coordinator's own thread (desk/coordinator.ts): it is no conversation.
  const hidden = coordinatorItemIds(core.store.setting('coordinators'));
  return core.store.recentEvents(Math.min(Math.max(limit, 1), 200), types).filter((event) => !hidden.has(event.itemId)).map((event) => {
    const item = core.store.item(event.itemId);
    return {
      ...event,
      agentName: item?.agentName ?? null,
      title: item ? core.title(item) : null,
      undoable: isAttentionEvent(event.type) && !core.store.isUndone(event.seq),
      undone: core.store.isUndone(event.seq),
    };
  });
}

/** A pending T3 request in words: each question with its options, or the approval with its decisions. */
export function pendingText(pending: PendingRequest): string {
  if (pending.kind === 'approval') return `asks for approval: ${pending.question} — options: ${pending.options.join(', ')}`;
  if (!pending.questions.length) return pending.question;
  return pending.questions
    .map((question) => `${question.header ? `${question.header}: ` : ''}${question.question}${question.options.length ? ` — options: ${question.options.map((option) => option.label).join(', ')}` : ''}${question.multiSelect ? ' (pick any)' : ''}`)
    .join(' | ');
}

/** The catch-up: what needs the owner one by one (needsOwner, failures first), then one sentence per agent for FYIs. */
export function briefing(core: DeskCore) {
  const filters = readFilters(core.store);
  const active = core.items().filter((item) => onBoard(item, filters)).sort(sectionOrder);
  const failed = (item: DeskItem) => deskStatus(item).live === 'failed';
  // Never point-free: filter's index would land in `now` and the stall clock would never fire (Next up and this disagreed by one row, 10/18).
  const urgent = active.filter((item) => needsOwner(item));
  urgent.sort((a, b) => (failed(a) ? 0 : 1) - (failed(b) ? 0 : 1) || sectionOrder(a, b));
  const fyiItems = active.filter((item) => item.nextStep === 'fyi' && item.seen !== 'seen' && !needsOwner(item) && !reportsUp(item));
  const byAgent = new Map<string, DeskItem[]>();
  for (const item of fyiItems) byAgent.set(item.agentName, [...(byAgent.get(item.agentName) ?? []), item]);
  const gist = (item: DeskItem) => textSummary(item.summary?.gist ?? item.ask ?? '', 120);
  const fyi = [...byAgent.entries()].map(([agentName, items]) => ({
    agentName,
    itemIds: items.map((item) => item.id),
    sentence: items.length === 1 ? `${agentName}: ${gist(items[0]!)}` : `${agentName} has ${items.length} updates, latest: ${gist(items[0]!)}`,
  }));
  const one = urgent.map((item) => ({
    id: item.id,
    agentName: item.agentName,
    place: item.facts.name || item.place,
    step: failed(item) ? ('failed' as const) : ('your_move' as const),
    seen: item.seen,
    ask: item.ask,
    options: item.options,
    context: item.summary?.context ?? [],
    gist: item.summary?.gist ?? null,
    pending: failed(item) ? null : (item.facts.pending ?? null),
    // Other threads' briefs counted on this row beyond its own question (desk/asks.ts carryBriefs; Codex review on #781).
    carried: failed(item) ? [] : (item.facts.carried ?? []).filter((c) => c.counts && c.pending.requestId !== item.facts.pending?.requestId).map((c) => ({ from: c.from, pending: c.pending })),
  }));
  const working = active.filter((item) => deskStatus(item).live === 'working').length;
  const watching = active.filter((item) => deskStatus(item).live === 'watching').length;
  // Waits past their time (a late check-back, a slow person or agent): a number to follow over time (owner, 10/18).
  const overdue = active.filter((item) => item.watching?.overdue).length;
  // To-dos the agents handed the owner (desk/asks.ts): their own list, never the yellow count.
  const todo = active.filter((item) => item.askRecord?.kind === 'todo' && item.askRecord.state === 'open' && !reportsUp(item)).length;
  const parts: string[] = [];
  for (const item of one) {
    parts.push(`${item.step === 'failed' ? 'Failed' : 'Your move'}: ${item.agentName}${item.place ? ` (${item.place})` : ''}: ${(item.pending && pendingText(item.pending)) || item.ask || item.gist || ''}`.trim());
    for (const c of item.carried) parts.push(`  Also decision ${c.pending.brief?.id ?? '?'} from ${c.from.title}: ${pendingText(c.pending)}`);
  }
  if (fyi.length) parts.push(...fyi.map((entry) => entry.sentence));
  if (working || watching) parts.push(`${working} working, ${watching} watching.`);
  return {
    text: parts.length ? parts.join('\n') : 'Nothing is waiting on you and there are no new updates.',
    yourMove: one,
    fyi,
    counts: { active: active.length, yourMove: urgent.length, fyi: fyiItems.length, working, watching, overdue, todo },
    sweep: briefingSweep(core, filters),
  };
}

/** The pending sweep for the briefing, without filtered candidates (null when none are left). */
function briefingSweep(core: DeskCore, filters: DeskFilters): { at: number; itemIds: string[] } | null {
  const pending = core.pendingSweep();
  if (!pending) return null;
  const byId = new Map(core.itemsByIds(pending.itemIds).map((item) => [item.id, item]));
  const itemIds = pending.itemIds.filter((id) => {
    const item = byId.get(id);
    return !item || filterMatches(item, filters).length === 0;
  });
  return itemIds.length ? { ...pending, itemIds } : null;
}
