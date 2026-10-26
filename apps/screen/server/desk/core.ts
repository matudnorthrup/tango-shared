import { randomUUID } from 'node:crypto';
import type { InboxRules } from '../inbox-rules.js';
import { snowflakeTime } from '../discord.js';
import { asksOwner, textSummary } from '../inbox-summarize.js';
import { extractArtifacts, parsePrUrl } from './artifacts.js';
import { AUTOTAG_EXAMPLES, AUTOTAG_MIN_CONFIDENCE, type AutoTagExample, type AutoTagger } from './autotag.js';
import { attachmentProblems, imagesWord, MAX_DISCORD_UPLOAD_BYTES, parseAttachments, type MessageAttachment, type StartAttachment } from './attachments.js';
import { initialAttention, reduceAttention, replayAttention } from './attention.js';
import { aggregateReviews, closingHandoff, deriveNextStep, localTime, overdueWakeText, type Handoff, type StepInput, type StepResult } from './next-step.js';
import { carryBriefs, namesDecision as names, ownerFacingLead, readAsk, resolveAsks, type AskEntry, type CarryRow } from './asks.js';
import { type Pill, deskStatus, type DeskStatus, reportsUp, stuckWaits, type Wait, waitTarget } from './status.js';
import type { ItemPatch } from './store.js';
import type { AskRecord } from './types.js';
import type { Tracer } from './trace.js';
import { readFeedSettings, type DeskFeed, type NewFeedPost } from './feed.js';
import { DeskStore } from './store.js';
import { fallbackSummary, isAckOnly, type DeskSummarizer } from './summarize.js';
import { readFilters, writeFilters } from './filters.js';
import { coordinatorItemIds } from './coordinator.js';
import { mailBodyOf, mailOf } from './backstage.js';
import { parseMailHeader } from './mail.js';
import { childProjects, holderOf, parentProject, projectHolds, readProjects, viewsWithInboxTabs, viewsWithTodos, viewsWithWorkspaces, type DeskProject, type ProjectAway } from './projects.js';
import { BRIEF_RULE_CHOICES, QUESTION_CHANGED, validateAnswers, type BriefRuleChoice, type PendingResolution } from './pending.js';
import { DeskRoles, isThreadRole, type RoleRecord } from './roles.js';
import { kindOf, spaceOf as querySpaceOf } from './query.js';
import {
  COMMAND_TYPES,
  THREAD_ROLES,
  type CodexWorker,
  type ThreadRole,
  isCodingThread,
  ITEM_TYPES,
  LEGACY_LABELS,
  LIST_LABELS,
  type ItemType,
  isAttentionEvent,
  type Actor,
  type Artifact,
  type Attention,
  type Author,
  type CommandResult,
  type DeskCommand,
  type DeskEvent,
  type DeskEventType,
  type DeskFacts,
  type DeskItem,
  type DeskItemRow,
  type Disposition,
  type Log,
  type MessageMeta,
  type NextStep,
  type PendingRequest,
  type PrWatch,
  type SnoozeTrigger,
  type WritebackRecord,
  splitByTime,
} from './types.js';

/** The longest new words can keep pushing a summary back (each push waits summaryDelayMs again). */
const SUMMARY_MAX_WAIT_MS = 30_000;
/** Bump when the summarizer prompt changes in a way the owner should see on open items. */
export const SUMMARY_VERSION = 14;

/** The rules file's three words for a row (inbox-rules.example.yaml), from the evaluator: the owner's or a failure, busy, or nothing. */
function rulesStatus(status: DeskStatus): 'needs_you' | 'in_progress' | 'done' {
  if (status.move === 'needs' || status.move === 'ready' || status.live === 'failed') return 'needs_you';
  return status.busy ? 'in_progress' : 'done';
}

// The desk core: the one place source facts, owner attention and inference
// meet. Sources write facts through record*/setFacts and report what happened
// through settle(); the core recomputes the next step, appends attention
// events, runs the reducer, and tells listeners which items changed. Timers
// (snooze expiry, chapter settle, watching-went-quiet, the weekly sweep,
// retention) run here on an injectable clock, whether or not a source changed.

/** A source adapter: the write side of one source (Discord, Loom). */
/** Who sent a desk mail turn: another conversation, never the owner. */
export interface MailOrigin { name: string; from: string; mailId: string }

export interface DeskSourceAdapter {
  owns(item: DeskItemRow): boolean;
  /** Cached accounts keyed by desk item id; never performs I/O on a desk read. */
  accounts?(): ReadonlyMap<string, string | null>;
  /** Done write-back: Discord ✅ (+ archive for threads), or source settlement. */
  done(item: DeskItemRow): Promise<Omit<WritebackRecord, 'action' | 'at'>>;
  /** Catch up without settling or archiving the conversation. */
  clear?(item: DeskItemRow): Promise<Omit<WritebackRecord, 'action' | 'at'>>;
  restoreStanding?(item: DeskItemRow): Promise<void>;
  undoDone?(item: DeskItemRow, settledAt: number): Promise<void>;
  undoClear?(item: DeskItemRow, clearedAt: number): Promise<void>;
  seen?(item: DeskItemRow, at: number): Promise<void>;
  /** Mirrors an explicit reaction (👀 seen, 💤 park) where the source supports it. */
  react?(item: DeskItemRow, emoji: string): Promise<void>;
  /** Posts the owner's words (and any images) into the conversation; resolves once the source accepted them. */
  reply(item: DeskItemRow, text: string, context?: { commandId: string; attachments?: StartAttachment[]; origin?: MailOrigin }): Promise<{ ok: true } | { ok: false; error: string; unknown?: boolean }>;
  /** Pins or unpins where the source keeps pins. Absent: the desk keeps it. */
  pin?(item: DeskItemRow, pinned: boolean): Promise<void>;
  /** Records the role and owner where the source keeps them (Loom). Absent: the desk keeps them (roles.ts). */
  setRole?(item: DeskItemRow, role: ThreadRole, parentItemId: string | null | undefined): Promise<void>;
  /** Renames the conversation where the source keeps its title; resolves to its new place. Absent: the desk keeps the name. */
  rename?(item: DeskItemRow, title: string): Promise<string>;
  /** Stops the turn in progress (the conversation stays open); resolves once the source accepted it. Absent: no Stop. */
  interrupt?(item: DeskItemRow): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Keeps the session (no automatic fresh session) or lets the source reset it again (Loom). Absent: no Keep this session. */
  keepSession?(item: DeskItemRow, keep: boolean): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Raise the thread's daily budget by half for today (Loom); a thread held by its budget goes again. */
  raiseBudget?(item: DeskItemRow): Promise<{ ok: true; budget: NonNullable<DeskFacts['budget']> } | { ok: false; error: string }>;
  /** The next turn opens a new session from what the thread carries (Loom). Absent: no Fresh start. */
  freshStart?(item: DeskItemRow): Promise<{ ok: true; message?: string } | { ok: false; error: string }>;
  /** Starts a job's run now, without waiting for it; resolves once the source accepted it. Absent: no Run now. */
  runJob?(item: DeskItemRow): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Pauses or resumes a job's timed runs; resolves once the source accepted it. Absent: no Pause. */
  pauseJob?(item: DeskItemRow, paused: boolean): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Answers / approves / dismisses the source's pending request; resolves once the source accepted it. */
  resolvePending?(item: DeskItemRow, resolution: PendingResolution, context: { commandId: string }): Promise<{ ok: true } | { ok: false; error: string; changed?: boolean; unknown?: boolean }>;
  /** Did it or one step on a recorded ask, as the person (or the voice operator): the source checks its ledger row first, so `changed` says the ask moved on or closed since the card was drawn. */
  resolveAsk?(item: DeskItemRow, askId: string, args: { step?: string; note?: string; by: 'person' | 'desk'; revision?: number }, context: { commandId: string }): Promise<{ ok: true } | { ok: false; error: string; changed?: boolean }>;
  /** An open decision brief on this thread as a question, though the row shows another (a thread with two open briefs shows its newest; TGO-1110). */
  briefPending?(item: DeskItemRow, decisionId: string): Promise<PendingRequest | null>;
  /** An open brief raised by a Loom thread whose records are filed on this (Discord) row, and the thread that raised it. */
  linkedBrief?(itemId: string, decisionId: string): Promise<{ threadId: string; pending: PendingRequest } | null>;
}

export interface RunningJob {
  id: string;
  agentId: string;
  channelId: string;
  threadId: string | null;
  conversationKey: string | null;
  label: string;
  startedAt: number;
  deadlineAt: number | null;
}

export interface AgentTurnEvent {
  type: 'turn.started' | 'turn.activity' | 'turn.finished' | 'turn.failed';
  agentId: string;
  conversationKey: string;
  channelId: string;
  threadId?: string;
  turnId: string;
  at: number;
  activity?: string;
  error?: { reason: string; message: string };
}

/** The bot's GET /status/work (TANGO_BOT_STATUS_URL). */
export interface BotWork {
  channelTurns?: number;
  voiceTurns?: number;
  /** `<agentId>|<channelId>` per voice turn in flight. */
  voiceConversations?: string[];
  /** Channel queue keys, when the bot reports them. */
  channelKeys?: string[];
}

/** A row's pill turning to Needs you or Failed from anything else (the Feed's needs/failed posts run off it). */
export interface StatusEntered { itemId: string; pill: 'needs' | 'failed' | 'stuck'; from: Pill | null; at: number }
export type DeskListener = (event: { type: 'item'; id: string; revision: number } | { type: 'activity'; event: DeskEvent } | { type: 'status.entered'; entered: StatusEntered }) => void;

export interface DeskCoreOptions {
  store: DeskStore;
  summarize: DeskSummarizer;
  /** Guesses a new Loom thread's type (desk/autotag.ts); unset = no guessing. */
  autoTag?: AutoTagger;
  adapters?: DeskSourceAdapter[];
  rules?: InboxRules | null;
  /** Stops a background job through the bot (stopJob: true on Done). */
  cancelJob?: (job: NonNullable<DeskFacts['job']>) => Promise<void>;
  now?: () => number;
  log?: Log;
  /** Debounce before summarizing a changed item (default 8 s). */
  summaryDelayMs?: number;
  /** Chapters split, and settle, at this much quiet (default 30 min). */
  chapterGapMs?: number;
  /** Done items quieter than this are forgotten (default 30 days). */
  keepMs?: number;
  /** The desk screen counts as idle after this long without a screen (default 10 min). */
  deskIdleMs?: number;
  formatTime?: (ms: number) => string;
  /** The bot's in-flight work, for closing orphaned turns. Unset: an orphan closes on its own. */
  botWork?: () => Promise<BotWork | null>;
  /** Refresh a Discord conversation after its terminal event, without delaying event acceptance. */
  refreshConversation?: (channelId: string) => Promise<unknown>;
  /** The session trace: attention events, next-step changes and command outcomes. */
  trace?: Tracer;
  /** The news feed (desk/feed.ts): updates, starts, needs-you, done. Unset: nothing is posted. */
  feed?: DeskFeed;
}

/** The news feed (desk/feed.ts): a thread begun this recently is new; one active this recently has news. */
const FEED_NEW_THREAD_MS = 2 * 3600_000;
const FEED_RECENT_MS = 6 * 3600_000;
/** A state change and an update this close together are one post. */
const FEED_MERGE_MS = 5 * 60_000;
/** A thread at work posts at most this often (the owner asked for every 5 to 10 minutes). */
const FEED_WORKING_EVERY_MS = 7 * 60_000;
/** A thread that wrote its own update (desk_update) this recently posts no Summary unless the owner keeps them. */
const FEED_UPDATER_MS = 24 * 3600_000;

/** Guessed already, or the owner set a label, None included (a tag left unset is undefined; Codex review on #515). */
const labeledYet = (facts: DeskFacts): boolean => !!facts.autoTag || facts.type !== undefined;

/** Actors that mean the owner did something (not an agent, a source or a timer). */
const OWNER_ACTORS = new Set<Actor>(['owner', 'screen', 'voice']);

export const CHAPTER_GAP_MS = 30 * 60_000;
/** A turn with no activity this long is checked against the bot (orphan lease). */
export const ORPHAN_TURN_MS = 20 * 60_000;
/** Past this, a turn is closed even if the bot reports unattributed channel work. */
export const ORPHAN_TURN_HARD_MS = 2 * 3_600_000;
/** Commands still `accepted` this long after a restart were interrupted. */
const INTERRUPTED_COMMAND_MS = 60_000;
const SWEEP_UNTOUCHED_MS = 7 * 86_400_000;
const RELAY_WINDOW_MS = 10 * 60_000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** The most recent sweep time at or before `now`: the sweep day at 07:00 local. */
export function latestSweepTime(now: number, day: 'saturday' | 'monday'): number {
  const target = day === 'monday' ? 1 : 6;
  const date = new Date(now);
  date.setHours(7, 0, 0, 0);
  while (date.getDay() !== target || date.getTime() > now) date.setDate(date.getDate() - 1);
  return date.getTime();
}

/** The next `weekday` at 07:00 local, strictly after `now`'s day. */
export function nextWeekday(now: number, weekday: string): number | null {
  const target = WEEKDAYS.indexOf(weekday.toLowerCase());
  if (target < 0) return null;
  const date = new Date(now);
  date.setHours(7, 0, 0, 0);
  do date.setDate(date.getDate() + 1);
  while (date.getDay() !== target);
  return date.getTime();
}

class CommandError extends Error {
  constructor(
    message: string,
    readonly outcome: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

/** What the owner sent back to a source request, in words (the timeline's "You answered…" beat). */
/** A decision brief's answer can say how it counts (Always / Ask me next time / Just this once) and why (phase 3). */
function briefRule(pending: PendingRequest, args: Record<string, unknown>): { rule?: BriefRuleChoice; reason?: string } {
  if (!pending.brief) return {};
  // A rule that isn't one of the three is refused, never dropped: dropped, Loom's default (Always) would make a rule.
  if (args.rule != null && !BRIEF_RULE_CHOICES.includes(args.rule as BriefRuleChoice)) throw new CommandError(`rule must be one of: ${BRIEF_RULE_CHOICES.join(', ')}`);
  return {
    ...(BRIEF_RULE_CHOICES.includes(args.rule as BriefRuleChoice) ? { rule: args.rule as BriefRuleChoice } : {}),
    ...(typeof args.reason === 'string' && args.reason.trim() ? { reason: args.reason.trim().slice(0, 200) } : {}),
  };
}

export function resolutionText(resolution: PendingResolution, pending: PendingRequest | null): string {
  if (resolution.kind === 'dismiss') return 'Dismissed the question';
  if (resolution.kind === 'approve') return `${pending?.approval?.options.find((option) => option.decision === resolution.decision)?.label ?? resolution.decision}`;
  const questions = pending?.questions ?? [];
  const text = (value: string | string[] | undefined) => (Array.isArray(value) ? value.join(', ') : (value ?? ''));
  if (questions.length <= 1) return text(Object.values(resolution.answers)[0]);
  return questions.map((question, index) => `${question.header || `Q${index + 1}`}: ${text(resolution.answers[question.id])}`).join(' · ');
}

/** A reply whose delivery can't be confirmed (the bot timed out): it may or may not have gone out. */
export const DELIVERY_UNKNOWN = 'unknown — may have been delivered';

/** A row's open decision brief: kept apart from the pending question where the source does that (Loom), else the pending one. */
function briefOf(item: Pick<DeskItemRow, 'facts'>): PendingRequest | null {
  return item.facts.openBrief ?? (item.facts.pending?.brief ? item.facts.pending : null);
}

/**
 * The revision of a decision brief the owner answered (TGO-1079): the one the client sent, else the one the desk shows
 * (a voice answer or an older client), which is what the owner was read or shown. Loom refuses a revised brief's
 * answer that names none (Codex review on #811).
 */
function seenRevision(args: Record<string, unknown>, pending: PendingRequest): { revision?: number } {
  if (typeof args.revision === 'number' && Number.isInteger(args.revision)) return { revision: args.revision };
  return typeof pending.brief?.revision === 'number' ? { revision: pending.brief.revision } : {};
}

/** How fresh an owner message must be to go up to the lead: older ones are a backfill, not the owner speaking now. */
const OWNER_POST_UP_MS = 10 * 60_000;

/** The owner's words in a conversation that reports up, for what it reports to (DeskCore.onOwnerPostedUp). */
export interface OwnerPostUp {
  itemId: string;
  title: string;
  parentItemId: string;
  text: string;
  at: number;
  /** The decision the words name (D-n), when they name one. */
  decisionId: string | null;
  /** The source's id for the message: one post, one delivery. */
  messageId: string;
}

/** A Discord row showing its agent's Loom records (source-loom.ts linkDiscord), as the Loom item answers go through. */
function loomBacking(item: DeskItemRow, threadId = item.facts.loomThreadId): DeskItemRow | null {
  // No conversation key: the Tango conversation source owns rows by that key and would claim the Loom thread's answer
  // (live 10/25: D-831 on Juliet's chapter row failed "no source to answer through").
  return item.source !== 'loom' && threadId ? { ...item, id: `loom:${threadId}`, source: 'loom' as const, conversationKey: '' } : null;
}

export class DeskCore {
  readonly store: DeskStore;
  private readonly now: () => number;
  private readonly log: Log;
  private readonly listeners = new Set<DeskListener>();
  /** The item whose summary is being written: its turn to the owner is posted with that summary (feedFor). */
  private summarizingFeed: string | null = null;
  /** Each row's pill when last flushed, so flush can tell a row entering Needs you or Failed (status.entered). */
  private readonly lastPill = new Map<string, Pill>();
  /** Each row's waits whose checks keep failing, when last flushed: a wait newly so is a Stuck post. */
  private readonly lastStuck = new Map<string, Set<string>>();
  private readonly changed = new Set<string>();
  /** The rules file version last applied to every item (undefined until the first tick). */
  private rulesVersion: number | undefined = undefined;
  private readonly pendingSummaries = new Map<string, NodeJS.Timeout>();
  /** When each pending summary was first due: new words push it back, but not past SUMMARY_MAX_WAIT_MS. */
  private readonly summaryDueSince = new Map<string, number>();
  private readonly summaryRuns = new Map<string, Promise<void>>();
  private summaryRunning = 0;
  private readonly autoTagging = new Set<string>();
  private readonly summaryWaiters: Array<() => void> = [];
  /**
   * A finished or parked item got a short agent message the ack check couldn't call: the summary decides.
   * Persisted (desk_markers deferred:<itemId>), so a restart before the summary lands still decides.
   * `decidedAt` is the attention the message found: a newer decision (Done, a sweep drop) voids it.
   */
  private readonly deferred = {
    get: (itemId: string): { contentKey: string; step: NextStep; decidedAt?: number; at?: number } | undefined => {
      const raw = this.store.marker(`deferred:${itemId}`);
      if (!raw) return undefined;
      try {
        return JSON.parse(raw) as { contentKey: string; step: NextStep; decidedAt?: number; at?: number };
      } catch {
        return undefined;
      }
    },
    set: (itemId: string, value: { contentKey: string; step: NextStep; decidedAt: number; at: number }) => this.store.setMarker(`deferred:${itemId}`, JSON.stringify(value)),
    delete: (itemId: string) => this.store.deleteMarker(`deferred:${itemId}`),
    itemIds: (): string[] => this.store.markerKeys('deferred:').map((key) => key.slice('deferred:'.length)),
  };
  /** A reply sent from the desk: the bot's echo (and the answer) belong to the item replied to. */
  private readonly relayTargets = new Map<string, { itemId: string; until: number }>();
  private timers: NodeJS.Timeout[] = [];
  private readonly inFlight = new Map<string, Promise<CommandResult>>();
  /** commandId -> the attention time its own event set (read once when the command finishes). */
  private readonly attentionByCommand = new Map<string, number>();
  private readonly wordsCache = new Map<string, { key: string; lastAgent: { text: string; at: number } | undefined; artifacts: Artifact[]; standing: { handoff: Handoff; at: number } | null }>();
  private projectsListeners = new Set<() => void>();
  private lastScreenAt = 0;
  private readonly prWatchListeners = new Set<(itemId: string) => void>();
  /** The owner is active on the desk or by voice: Loom counts it toward level 3 veto windows (decisions spec "Active time"). */
  private readonly activityListeners = new Set<(at: number, source: string) => void>();
  /** Who each conversation works for and what started it (roles.ts). */
  readonly roles: DeskRoles;
  /** Codex workers by the conversation that dispatched them (source-agentctl.ts). */
  private codexWorkers = new Map<string, CodexWorker[]>();
  /** The lead each worker reported to when it was last sent, so a reparented worker's former lead is re-sent too. */
  private workerParents = new Map<string, string>();

  constructor(private readonly options: DeskCoreOptions) {
    this.store = options.store;
    this.roles = new DeskRoles(options.store.db);
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    // A restart doesn't mean the desk was idle: the first screen after it doesn't fire desk snoozes.
    this.lastScreenAt = this.now();
    // Each stored row's pill as the desk last left it, so a row's first real transition after a restart still
    // enters (status.entered), even when its first poll changed nothing (Codex review on #928).
    try {
      for (const item of this.items()) {
        this.lastPill.set(item.id, deskStatus(item, this.now()).pill);
        this.lastStuck.set(item.id, new Set(stuckWaits(item).map((w) => w.id)));
      }
    } catch (e) { this.log('desk.status.seed_failed', { message: (e as Error).message }); }
  }

  /** Best-effort acknowledgement, including records carried on another source’s row. */
  private async acknowledgeSeen(item: DeskItemRow, at: number): Promise<void> {
    try {
      const backing = loomBacking(item) ?? item;
      await this.adapterFor(backing)?.seen?.(backing, at);
    }
    catch (error) {
      this.trace('loom.seen.failed', 'Reply acknowledgement failed', { itemId: item.id, error: String(error) });
    }
  }

  /** Records to the session trace; never throws into the core. */
  private trace(kind: string, summary: string, data: Record<string, unknown> = {}): void {
    const tracer = this.options.trace;
    if (!tracer) return;
    try {
      tracer({ source: 'desk', kind, summary, data, at: this.now() });
    } catch {
      /* tracing never changes behavior */
    }
  }

  private traceName(itemId: string): string {
    try {
      const item = this.store.item(itemId);
      return item ? `${item.agentName} · ${this.title(item)}` : itemId;
    } catch {
      return itemId;
    }
  }

  get chapterGapMs(): number {
    return this.options.chapterGapMs ?? CHAPTER_GAP_MS;
  }

  subscribe(listener: DeskListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── items and facts (the sources' side) ────────────────────────────────

  /** Creates the item if it is new (emitting source.created); returns it. */
  ensureItem(
    identity: Pick<DeskItemRow, 'id' | 'source' | 'kind' | 'conversationKey' | 'agentId' | 'agentName'> & ItemPatch & { createdAt: number },
    by: Author,
  ): DeskItemRow {
    const existing = this.store.item(identity.id);
    if (existing) {
      const { id, source: _s, kind: _k, conversationKey: _c, agentId: _a, createdAt: _t, ...patch } = identity;
      if (this.store.patchItem(id, patch)) this.changed.add(id);
      return this.store.item(id)!;
    }
    // A new chapter takes over the conversation's live turn (only a running one: a failure stays with
    // the chapter it happened in, and is never copied into a later chapter).
    const turn = this.turnState(identity.conversationKey);
    if (splitByTime(identity)) {
      const previous = this.store.latestInConversation(identity.conversationKey);
      if (previous && previous.createdAt <= identity.createdAt && previous.kind === 'chapter' && this.attention(previous.id).disposition !== 'done') {
        this.apply(previous.id, 'chapter.superseded', 'system', {});
      }
      if (previous && previous.facts.running) {
        this.store.patchItem(previous.id, { facts: { ...previous.facts, running: null } });
        this.refresh(previous.id);
      }
      if (turn.failed) this.saveTurnState(identity.conversationKey, { ...turn, failed: null });
    }
    const created = this.store.createItem(identity);
    if (turn.running) this.store.patchItem(created.id, { facts: { ...created.facts, running: turn.running } }, { bump: false });
    this.apply(created.id, 'source.created', 'source', { by });
    this.seedTags(created.id);
    return this.store.item(created.id)!;
  }

  /**
   * Type, seeded once from what the owner wrote before the desk owned them: a thread title's
   * old prefix ("epic: …") or a Discord item's old desk label. `hold` parks it (an open item only).
   * Seeded items are never re-read: from then on the desk is the only place these live.
   */
  seedTags(itemId: string): void {
    const item = this.store.item(itemId);
    if (!item || item.facts.tagsSeeded) return;
    // A coding thread's title is the place after its repo; a Discord thread's name is its place.
    const title = isCodingThread(item) ? (item.place ?? '').split(' · ').slice(1).join(' · ') : (item.place ?? '');
    const prefix = item.facts.listLabel ?? /^\s*([a-z]+):(?!\/\/)/i.exec(title)?.[1]?.toLowerCase() ?? null;
    const legacy = prefix ? LEGACY_LABELS[prefix] : undefined;
    this.store.patchItem(itemId, { facts: { ...item.facts, tagsSeeded: true, ...(legacy?.type ? { type: legacy.type } : {}) } }, { bump: false });
    this.changed.add(itemId);
    const disposition = this.store.attention(itemId)?.disposition;
    if (legacy?.park && (disposition === 'active' || disposition === 'snoozed')) this.apply(itemId, 'park', 'system', { via: 'hold-label' });
  }

  /**
   * Seeds every item not seeded yet, once (type moved off thread titles onto the desk). Run after
   * the first source poll, so a thread renamed while the desk was down seeds from its current name
   * (Codex review on #498). Returns how many it seeded.
   */
  seedAll(): number {
    let seeded = 0;
    for (const item of this.store.items({ sinceMs: 0 })) {
      if (item.facts.tagsSeeded) continue;
      this.seedTags(item.id);
      seeded += 1;
    }
    if (seeded) this.log('desk.tags.seeded', { seeded });
    // Screens already open get the moved items now, not at the next tick (Codex review on #498).
    this.flush();
    return seeded;
  }

  /** Stores one message and the facts that follow from it. False if it was already known. No events. */
  recordMessage(itemId: string, message: { messageId: string; author: Author; at: number; text: string; attachments?: MessageAttachment[]; meta?: MessageMeta }): boolean {
    // "Newest" is decided by the words alone: a source's own clock (updatedAt) can run ahead of them.
    const latestAt = this.store.latestMessageAt(itemId);
    if (!this.store.addMessage({ ...message, itemId })) {
      // Known: what the source says about it may have moved on (a queued message was started).
      if (message.meta !== undefined && this.store.setMessageMeta(message.messageId, message.meta)) {
        this.store.bumpRevision(itemId);
        this.changed.add(itemId);
      }
      return false;
    }
    const item = this.store.item(itemId)!;
    const facts: DeskFacts = { ...item.facts };
    const patch: ItemPatch = { lastActivityAt: Math.max(item.lastActivityAt, message.at) };
    const newest = latestAt === null || message.at >= latestAt;
    // Another agent's mail isn't the owner asking: it never becomes "You asked" (desk/backstage.ts).
    const mail = message.author === 'owner' ? mailOf(message) : null;
    if (message.author === 'owner' && mail) {
      if (newest) {
        facts.lastAuthor = 'owner';
        // Mail isn't the owner's words: never a message of theirs waiting to be picked up (desk/status.ts).
        facts.lastAuthorMail = true;
      }
      facts.lastMailInAt = Math.max(item.facts.lastMailInAt ?? 0, message.at);
    } else if (message.author === 'owner') {
      patch.lastOwnerMessageAt = Math.max(item.lastOwnerMessageAt ?? 0, message.at);
      if (newest) {
        facts.lastAuthor = 'owner';
        facts.lastAuthorMail = false;
        // `filedAt`: when the desk got it (a late poll files older words), what a summary is compared with. The source's
        // copy of a desk reply keeps the reply's time, so a later poll doesn't move it past a chip (Codex review on #1032).
        const prev = item.facts.lastOwnerRequest;
        const filedAt = prev && prev.filedAt == null && !prev.answers && prev.text === message.text ? prev.at : this.now();
        if (message.text) facts.lastOwnerRequest = { text: message.text, at: message.at, filedAt, ...(message.meta?.answers ? { answers: message.meta.answers } : {}) };
      }
    } else if (message.author === 'agent' && newest) {
      facts.lastAuthor = 'agent';
      facts.lastAuthorMail = false;
      patch.lastAgentMessageId = message.messageId;
      const words = message.text.trim() || (message.attachments?.length ? `(${imagesWord(message.attachments.length)})` : '');
      // A trailing "you're welcome" doesn't hide news the summary hasn't covered yet (settle's ackAfter does the same).
      const held = item.facts.lastAgentWords;
      const pendingNews = !!held && held.filedAt > (item.summary?.at ?? 0) && !isAckOnly(held.text);
      if (words && !(pendingNews && isAckOnly(words))) facts.lastAgentWords = { text: words.length > 600 ? `${words.slice(0, 599).trimEnd()}…` : words, at: message.at, filedAt: this.now() };
    }
    facts.contentKey = `${newest ? message.messageId : (item.facts.contentKey ?? '').split(':')[0]}:${item.messageCount}`;
    patch.facts = facts;
    this.store.patchItem(itemId, patch);
    this.changed.add(itemId);
    // Every new owner message, however a poll files it (Codex review on #781); after this filing, not inside it. The
    // first message of a conversation is the task it was started with, not the owner speaking in it.
    if (message.author === 'owner' && !mail && latestAt !== null && message.text.trim()) queueMicrotask(() => this.passOwnerPostUp(itemId, message.text, message.at, message.messageId));
    return true;
  }

  /**
   * Puts a conversation in one of the owner's projects: now when the desk has it, else as soon as a
   * source first reports it (a thread from Start work inside a project). Kept a day, across restarts.
   */
  assignProject(itemId: string, projectId: string): boolean {
    const project = readProjects(this.store.setting('projects')).find((p) => p.id === projectId);
    if (!project || project.finishedAt) return false;
    if (this.store.item(itemId)) {
      this.setFacts(itemId, { projectId });
      this.refresh(itemId);
      return true;
    }
    const pending = this.pendingProjects();
    pending[itemId] = { projectId, at: this.now() };
    this.store.setSetting('project_pending', JSON.stringify(pending));
    return true;
  }

  private pendingProjects(): Record<string, { projectId: string; at: number }> {
    try {
      const raw = JSON.parse(this.store.setting('project_pending') ?? '{}') as Record<string, { projectId: string; at: number }>;
      return Object.fromEntries(Object.entries(raw).filter(([, entry]) => entry && typeof entry.projectId === 'string' && this.now() - Number(entry.at) < 86_400_000));
    } catch {
      return {};
    }
  }

  /** A conversation a project was waiting for (assignProject) joins it when a source first reports it. */
  private joinPendingProject(itemId: string): void {
    if (!this.store.setting('project_pending')) return;
    const pending = this.pendingProjects();
    const entry = pending[itemId];
    if (!entry) return;
    delete pending[itemId];
    if (Object.keys(pending).length) this.store.setSetting('project_pending', JSON.stringify(pending));
    else this.store.deleteSetting('project_pending');
    // Still there and open: it may have been finished or deleted while the thread was on its way (Codex review on #522).
    const project = readProjects(this.store.setting('projects')).find((p) => p.id === entry.projectId);
    if (!project || project.finishedAt) return this.log('desk.project.pending_dropped', { itemId, projectId: entry.projectId });
    if (!this.store.item(itemId)?.facts.projectId) this.setFacts(itemId, { projectId: entry.projectId });
  }

  /**
   * A project as a whole (the outer layer over its conversations). Snooze and Park set the project's own
   * state and never touch its conversations: each keeps its own (done stays done, a snooze keeps its
   * time), and the ones in rotation are held while the project is away (withProjectHold). Wake ends
   * that. Finish is the one that acts on its conversations, in one pass from the desk's own state: every
   * open one is marked done (`done`) or taken out of the project (`out`), never a running turn, and the
   * project goes to History.
   */
  async projectAction(
    projectId: string,
    input: { action: 'snooze' | 'park' | 'wake' | 'finish'; until?: number | null; trigger?: SnoozeTrigger | null; how?: 'done' | 'out'; children?: 'finish' | 'keep' },
    actor: Actor = 'owner',
  ): Promise<{ held?: number; acted?: number; stayed?: number; finished?: number; keptOpen?: number }> {
    const projects = readProjects(this.store.setting('projects'));
    const project = projects.find((p) => p.id === projectId);
    if (!project) throw new CommandError(`no project ${projectId}`);
    if (project.finishedAt) throw new CommandError(`${project.name} is already finished`);
    const put = (patch: Partial<DeskProject>) => this.saveProjects(projects.map((p) => (p.id === projectId ? { ...p, ...patch } : p)), projectId);
    if (input.action === 'snooze' || input.action === 'park' || input.action === 'wake') {
      let away: ProjectAway | null = null;
      if (input.action === 'snooze') {
        if (input.until != null && !(Number.isFinite(input.until) && input.until > this.now())) throw new CommandError('until must be a future time');
        if (input.until == null && !input.trigger) throw new CommandError('snooze needs until or trigger');
        away = { state: 'snoozed', at: this.now(), ...(input.until != null ? { until: input.until } : {}), ...(input.trigger ? { trigger: input.trigger } : {}) };
      } else if (input.action === 'park') away = { state: 'parked', at: this.now() };
      put({ away });
      this.log('desk.project.away', { projectId, actor, away });
      // A parent holds its children's conversations too (holderOf): they count as what it holds.
      return { held: this.items().filter((item) => item.heldBy === projectId).length };
    }
    // Finishing a parent asks once about its open child projects (docs/specs/spaces.md, Nesting): they finish with it,
    // or stay open and move up to the space it is in (the personal space, at the top).
    const open = childProjects(projectId, projects).filter((p) => !p.finishedAt);
    const finishing = [project, ...(input.children === 'finish' ? open : [])];
    const kept = input.children === 'finish' ? [] : open;
    const ending = new Set(finishing.map((p) => p.id));
    // Where a finished project's open conversations go with `out`: up to the enclosing project when that stays open
    // (a child finished alone goes to its parent), else out of every project.
    const upFrom = (p: DeskProject): string | null => {
      const parent = parentProject(p, projects);
      return parent && !parent.finishedAt && !ending.has(parent.id) ? parent.id : null;
    };
    const members = this.store.items().filter((item) => ending.has(item.facts.projectId ?? '') && (['active', 'snoozed', 'parked'] as Disposition[]).includes(this.attention(item.id).disposition));
    // Owners move before the workers and jobs that report to them, so an owner leaving in this same finish is
    // already in its new space when its worker's owner is checked (Codex review on #913).
    const reporting = (item: DeskItemRow) => ['worker', 'ops'].includes(this.item(item.id)!.facts.role ?? '');
    members.sort((a, b) => Number(reporting(a)) - Number(reporting(b)));
    // One command id per conversation: each event keeps its own (desk_events.command_id is unique).
    const batch = `project:${projectId}:finish:${this.now()}:${Math.random().toString(36).slice(2, 8)}`;
    let acted = 0;
    let stayed = 0;
    const writeBacks: Array<Promise<unknown>> = [];
    for (const item of members) {
      // A running turn: Done would settle it mid-turn.
      if (item.nextStep === 'working') {
        stayed += 1;
        continue;
      }
      acted += 1;
      if (input.how === 'out') {
        const from = projects.find((p) => p.id === item.facts.projectId);
        const to = from ? upFrom(from) : null;
        // A failed owner write-back mustn't stop the finish: that one moves as before, keeping its owner.
        await this.moveProject(item, to, actor).catch((err) => {
          this.log('desk.project.reports_to_failed', { itemId: item.id, message: (err as Error).message });
          this.setFacts(item.id, { projectId: to });
          this.refresh(item.id);
        });
      } else {
        // Every Done is recorded now, in this pass; only the write-backs to the sources follow.
        writeBacks.push(this.done(item, actor, { stopJob: false }, { commandId: `${batch}:${item.id}` }, true).catch((err) => this.log('desk.project.done_failed', { itemId: item.id, message: (err as Error).message })));
      }
    }
    const at = this.now();
    const enclosing = project.parent;
    this.saveProjects(
      projects.map((p) => {
        if (ending.has(p.id)) return { ...p, finishedAt: at, away: null };
        // A kept-open child moves up: into the space its parent was in (a parent is top-level, so the personal space).
        if (kept.some((k) => k.id === p.id)) {
          const { parent: _parent, ...rest } = p;
          return enclosing?.startsWith('agent:') ? { ...rest, parent: enclosing } : rest;
        }
        return p;
      }),
      [...ending, ...kept.map((k) => k.id)],
    );
    if (finishing.length > 1 || kept.length) this.log('desk.project.finished', { projectId, actor, children: finishing.slice(1).map((p) => p.id), keptOpen: kept.map((p) => p.id) });
    await Promise.all(writeBacks);
    return { acted, stayed, ...(open.length ? { finished: finishing.length - 1, keptOpen: kept.length } : {}) };
  }

  /** Move both space and reporting relation, writing the source before local state. */
  private async moveProject(item: DeskItemRow, projectId: string | null, actor: Actor, pickedParent?: unknown) {
    const role = this.item(item.id)!.facts.role;
    const reports = role === 'worker' || role === 'ops';
    const explicit = pickedParent !== undefined;
    if (explicit && pickedParent !== null && !reports) throw new CommandError('only a worker or job reports to a conversation');
    const previousParentItemId = this.roles.get(item.id).parentItemId ?? item.facts.parentItemId ?? null;
    let parentItemId = previousParentItemId;
    if (reports) {
      const newSpace = querySpaceOf({ ...item, facts: { ...item.facts, projectId } }, { projects: readProjects(this.store.setting('projects')) });
      if (explicit && pickedParent === null) {
        parentItemId = null;
      } else if (explicit) {
        parentItemId = String(pickedParent);
        if (parentItemId === item.id) throw new CommandError('a thread can’t be its own parent');
        const wrong = this.reportTargetError(parentItemId, newSpace);
        if (wrong) throw new CommandError(wrong);
      } else if (!parentItemId || this.reportTargetError(parentItemId, newSpace)) {
        parentItemId = this.spaceLead(newSpace);
      }
      if (parentItemId !== previousParentItemId) {
        const adapter = this.adapterFor(item);
        await adapter?.setRole?.(item, role, parentItemId);
      }
    }
    // A pickup from one project's hold says nothing about another's (Codex review on #537).
    this.setFacts(item.id, { projectId, ...(projectId !== (item.facts.projectId ?? null) ? { projectPickedUpAt: null } : {}) });
    if (reports && parentItemId !== previousParentItemId) {
      this.roles.set(item.id, { role, parentItemId }, actor, this.now());
      this.touch(item.id);
      for (const id of new Set([previousParentItemId, parentItemId])) if (id) this.touch(id);
    }
    this.refresh(item.id);
    return { projectId, ...(reports && parentItemId !== previousParentItemId ? { parentItemId, previousParentItemId } : {}) };
  }

  /** Merges source facts (no events). */
  setFacts(itemId: string, facts: Partial<DeskFacts>, patch: ItemPatch = {}): void {
    const item = this.store.item(itemId);
    if (!item) return;
    // Keep timestamp suppression for older Looms and pending Done write-back.
    // A recorded Undo reopening closed-by-done is authoritative.
    const reopenedAsk = facts.openAsk?.status === 'open' && facts.openAsk.id === item.facts.askLedger?.id && item.facts.askLedger?.status === 'closed-by-done';
    if (facts.openAsk && !reopenedAsk && facts.openAsk.at <= (item.facts.askClosedByDoneAt ?? 0)) facts = { ...facts, openAsk: null };
    // The source closing its ask while Done holds it: Undo must not bring that ask back (Codex review on #928).
    else if (facts.openAsk === null && item.facts.askClosedByDoneAt && !('askClosedByDoneAt' in facts)) facts = { ...facts, askClosedBySource: true };
    if (this.store.patchItem(itemId, { ...patch, facts: { ...item.facts, ...facts } })) this.changed.add(itemId);
  }

  /**
   * After a source recorded what happened: recompute the step, then report the
   * activity to the reducer. `activity` is new agent activity (a message, a
   * failed turn, a pending question); `ownerPostedAt` is the owner writing in
   * the conversation; `done` is a source-side settle.
   */
  settle(
    itemId: string,
    happened: { activity?: { what: string; at: number; text?: string; attachments?: number; ackAfter?: boolean }; ownerPostedAt?: number; done?: boolean; summarize?: boolean } = {},
  ): void {
    const item = this.store.item(itemId);
    if (!item) return;
    this.joinPendingProject(itemId);
    const result = this.refresh(itemId, { emitStep: !happened.activity });
    const attention = this.attention(itemId);
    // A poll that runs behind (Discord's copy arrives after Done): words from before the decision never undo it.
    const stale = (at: number) => attention.disposition !== 'active' && at <= attention.updatedAt;
    if (happened.ownerPostedAt !== undefined && !stale(happened.ownerPostedAt)) {
      this.apply(itemId, 'source.owner_posted', 'owner', { at: happened.ownerPostedAt });
      // The owner writing in Discord is the owner at work (Loom counts its own threads' messages). Only fresh
      // words count: a backfill or a late poll of old messages says nothing about now.
      if (item.source !== 'loom' && this.now() - happened.ownerPostedAt < 10 * 60_000) this.noteOwnerActivity('message', happened.ownerPostedAt);
    }
    if (happened.activity && !stale(happened.activity.at)) {
      this.deferred.delete(itemId);
      this.apply(itemId, 'source.activity', 'agent', { what: happened.activity.what, step: result.step, at: happened.activity.at });
      this.applyQuietRule(itemId);
    }
    if (happened.done && !this.isStanding(item) && attention.disposition !== 'done') this.apply(itemId, 'source.done', 'source', {});
    if (happened.summarize !== false && (happened.activity || happened.ownerPostedAt !== undefined)) this.scheduleSummary(itemId);
    else if (!(happened.done && happened.summarize === false) && this.summaryStale(itemId)) this.scheduleSummary(itemId, { keepPending: true });
    this.flush();
  }

  /** The latest home-channel chapter, or a default in a space that is still open. */
  isStanding(item: DeskItemRow): boolean {
    if (item.source !== 'loom' && item.source !== 'discord') return false;
    if (item.facts.projectId && readProjects(this.store.setting('projects')).some(p => p.id === item.facts.projectId && p.finishedAt)) return false;
    return (this.roles.all().get(item.id)?.role ?? item.facts.role) === 'default' || (item.kind === 'chapter' && this.store.latestInConversation(item.conversationKey)?.id === item.id);
  }

  /** Repair old filed defaults once; failed source repairs remain retryable on the next poll. */
  async migrateStanding(itemId: string): Promise<void> {
    const item = this.store.item(itemId);
    if (!item || !this.isStanding(item) || item.kind === 'chapter') return;
    const marker = `standing-clear:${itemId}`;
    if (this.store.marker(marker)) return;
    await this.adapterFor(item)?.restoreStanding?.(item);
    if (!this.isStanding(this.store.item(itemId)!)) return;
    if (this.attention(itemId).disposition === 'done') this.apply(itemId, 'reopen', 'system', { migration: 'standing-clear' });
    this.store.setMarker(marker, '1');
    this.flush();
  }

  /** The rules-file kind for an item ("report"), matched on agent and thread title. */
  private kindOf(item: DeskItemRow): 'report' | null {
    return this.options.rules?.kindFor(item.agentId, item.place) ?? null;
  }

  /** The words changed since the summary was made (by input key, never by revision), and none is on the way. */
  private summaryStale(itemId: string): boolean {
    const item = this.store.item(itemId);
    if (!item || item.messageCount === 0) return false;
    return (item.summary?.contentKey ?? null) !== (item.facts.contentKey ?? '');
  }

  /** Recomputes everything derived: step, ask, watching, artifacts, rule labels. Returns the step. */
  refresh(itemId: string, options: { emitStep?: boolean } = {}): StepResult & { from: NextStep } {
    const item = this.store.item(itemId)!;
    const now = this.now();
    const { lastAgent, artifacts, standing } = this.wordsOf(item);
    const input: StepInput = {
      facts: item.facts,
      prs: item.prs,
      summary: item.summary,
      fallbackStep: lastAgent && asksOwner(lastAgent.text) ? 'your_move' : 'fyi',
      lastActivityAt: item.lastActivityAt,
      lastOwnerMessageAt: item.lastOwnerMessageAt,
      lastAgentAt: lastAgent?.at ?? null,
      standing,
      now,
      waitingNudgeMs: this.waitingNudgeMs(),
      formatTime: this.options.formatTime ?? localTime,
    };
    const result = deriveNextStep(input);
    const summaryNeeds = item.summary?.step === 'your_move' || /\b(needs? you|waiting on you|your (approval|answer|decision))\b/i.test(item.summary?.gist ?? '');
    const missedKey = `${item.summary?.at ?? 0}:${item.summary?.contentKey ?? ''}`;
    if (summaryNeeds && !item.facts.openAsk && !item.facts.pending && !item.facts.openBrief && result.step !== 'your_move' && this.store.marker(`missed-ask:${itemId}`) !== missedKey) {
      this.log('desk.missed_ask', { itemId, basis: result.basis });
      this.store.setMarker(`missed-ask:${itemId}`, missedKey);
    }
    // The ask with its lifecycle: read here, then resolved against every other row (an older chapter's ask asked
    // again, the same ask on two rows); rows whose state that changes are refreshed in turn (desk/asks.ts).
    // The closing message is evidence only when it is the one that made the ask: a recorded ask kept across a later
    // mail or wake turn must not read that turn's "then I'll merge" (Codex review on #783).
    const askMessage = lastAgent && (!item.facts.openAsk || lastAgent.at === item.facts.openAsk.at) ? lastAgent.text : '';
    const askRecord = this.resolveAsk(item, readAsk(result, { ...input, closingText: askMessage }, item));
    const effects = this.options.rules?.effects({
      agentId: item.agentId,
      summary: item.summary?.gist ?? '',
      lastText: lastAgent?.text ?? '',
      place: item.place,
      status: rulesStatus(deskStatus({ ...item, nextStep: result.step, nextStepBasis: result.basis, askRecord, seen: this.store.attention(itemId)?.seen ?? 'new', disposition: this.store.attention(itemId)?.disposition ?? 'active' }, now)),
    });
    const changed = this.store.patchItem(itemId, {
      nextStep: result.step,
      nextStepBasis: result.basis,
      ask: result.ask,
      options: result.options,
      watching: result.watching,
      askRecord,
      artifacts,
      ...(effects ? { labels: effects.labels, hidden: effects.hidden } : {}),
    });
    if (changed) this.changed.add(itemId);
    if (result.step !== item.nextStep) {
      this.trace('step.changed', `${this.traceName(itemId)}: ${item.nextStep} → ${result.step} (${result.basis})`, { itemId, from: item.nextStep, to: result.step, basis: result.basis, fromBasis: item.nextStepBasis });
    }
    // A wait running past its time, and coming back within it: traced so overdue can be followed over time (owner, 10/18).
    const wasOverdue = item.watching?.overdue ?? null;
    const nowOverdue = result.watching?.overdue ?? null;
    if ((nowOverdue?.since ?? null) !== (wasOverdue?.since ?? null) || nowOverdue?.kind !== wasOverdue?.kind) {
      if (nowOverdue) this.trace('wait.overdue', `${this.traceName(itemId)}: ${nowOverdue.kind} overdue — ${nowOverdue.text}`, { itemId, kind: nowOverdue.kind, basis: result.basis, since: nowOverdue.since, text: nowOverdue.text });
      else if (wasOverdue) this.trace('wait.overdue.cleared', `${this.traceName(itemId)}: no longer overdue (${wasOverdue.kind}) — now ${result.step}`, { itemId, kind: wasOverdue.kind, since: wasOverdue.since, step: result.step, basis: result.basis });
    }
    // Only a turn to urgent moves attention (seen → new); other step changes are just facts on the item.
    const urgent = (step: NextStep) => step === 'your_move' || step === 'failed';
    if (options.emitStep && result.step !== item.nextStep && urgent(result.step) && !urgent(item.nextStep)) this.apply(itemId, 'source.step', 'system', { from: item.nextStep, to: result.step, basis: result.basis });
    return { ...result, from: item.nextStep };
  }

  /**
   * The last agent message and the artifacts, read from the words. Cached per item by its message
   * set (count + latest agent message + PR): the 30 s tick re-reads nothing when nobody spoke.
   */
  private wordsOf(item: DeskItemRow): { lastAgent: { text: string; at: number } | undefined; artifacts: Artifact[]; standing: { handoff: Handoff; at: number } | null } {
    const key = `${item.messageCount}|${item.lastAgentMessageId ?? ''}|${item.facts.pullRequest?.url ?? ''}`;
    const cached = this.wordsCache.get(item.id);
    if (cached && cached.key === key) return cached;
    const messages = this.store.messages(item.id, 100);
    const lastAgent = [...messages].reverse().find((message) => message.author === 'agent');
    const artifacts = extractArtifacts(messages.filter((message) => message.author === 'agent').map((message) => message.text), { pullRequest: item.facts.pullRequest });
    // The latest message that closed a turn with a hand-off (progress lines in between carry none).
    let standing: { handoff: Handoff; at: number } | null = null;
    for (const message of [...messages].reverse()) {
      if (message.author !== 'agent') continue;
      const handoff = closingHandoff(message.text);
      if (handoff) {
        standing = { handoff, at: message.at };
        break;
      }
    }
    const entry = { key, lastAgent: lastAgent ? { text: lastAgent.text, at: lastAgent.at } : undefined, artifacts, standing };
    this.wordsCache.set(item.id, entry);
    return entry;
  }

  /** quiet_until in the rules file: an automatic snooze until that weekday. */
  private applyQuietRule(itemId: string): void {
    const rules = this.options.rules;
    const item = this.store.item(itemId);
    if (!rules || !item) return;
    const attention = this.attention(itemId);
    if (attention.disposition !== 'active' || attention.seen === 'seen') return;
    const lastAgent = [...this.store.messages(itemId, 10)].reverse().find((message) => message.author === 'agent');
    const effects = rules.effects({ agentId: item.agentId, summary: item.summary?.gist ?? '', lastText: lastAgent?.text ?? '', place: item.place, status: 'done' });
    const today = WEEKDAYS[new Date(this.now()).getDay()];
    const rule = rules.list().find((candidate) => effects.rules.includes(candidate.name) && candidate.quiet_until && candidate.quiet_until.toLowerCase() !== today);
    const until = rule?.quiet_until ? nextWeekday(this.now(), rule.quiet_until) : null;
    if (until) this.apply(itemId, 'snooze', 'system', { until, reason: `rule: ${rule!.name}` });
  }

  // ── bot turn events ────────────────────────────────────────────────────

  private turnState(conversationKey: string): Pick<DeskFacts, 'running' | 'failed'> {
    const raw = this.store.marker(`turn:${conversationKey}`);
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Pick<DeskFacts, 'running' | 'failed'>;
    } catch {
      return {};
    }
  }

  /** The item a conversation's turn belongs to: the thread, or the home channel's latest chapter. */
  itemForConversation(conversationKey: string): DeskItemRow | null {
    if (conversationKey.startsWith('thread:')) return this.store.item(`discord:${conversationKey}`);
    return this.store.latestInConversation(conversationKey);
  }

  private saveTurnState(conversationKey: string, state: Pick<DeskFacts, 'running' | 'failed'>): void {
    if (!state.running && !state.failed) this.store.deleteMarker(`turn:${conversationKey}`);
    else this.store.setMarker(`turn:${conversationKey}`, JSON.stringify(state));
  }

  /** POST /api/desk/agent-events: Working, Failed and the activity line, exact for Tango agents. */
  agentEvent(event: AgentTurnEvent): { itemId: string | null } {
    const key = event.conversationKey;
    const state = this.turnState(key);
    const at = event.at || this.now();
    let failedNow = false;
    switch (event.type) {
      case 'turn.started':
        // A new turn replaces any open lease, and a new turn clears the last failure.
        state.running = { since: at, turnId: event.turnId, lastAt: at };
        state.failed = null;
        break;
      case 'turn.activity':
        state.running = { since: state.running?.since ?? at, turnId: event.turnId, lastAt: at };
        break;
      case 'turn.finished':
        if (!state.running?.turnId || state.running.turnId === event.turnId) state.running = null;
        break;
      case 'turn.failed':
        if (!state.running?.turnId || state.running.turnId === event.turnId) state.running = null;
        state.failed = { at, reason: event.error?.reason ?? 'error', message: event.error?.message ?? 'The turn failed', turnId: event.turnId };
        failedNow = true;
        break;
    }
    this.saveTurnState(key, state);
    if ((event.type === 'turn.finished' || event.type === 'turn.failed') && /^(?:(?:thread|channel):\d+|conv:[0-7][0-9A-HJKMNP-TV-Z]{25})$/.test(key) && this.options.refreshConversation) {
      // Defer the read until the event's state is committed. A source failure must never reject the event.
      void Promise.resolve().then(() => this.options.refreshConversation!(key.split(':')[1]!)).catch((err) => {
        this.log('desk.discord.refresh.error', { conversationKey: key, message: (err as Error).message });
      });
    }
    const item = this.itemForConversation(key);
    if (!item) {
      this.flush();
      return { itemId: null };
    }
    // Only a start (clears) or a failure (sets) touches the item's failure: activity and finish
    // events carry no news about it, so a stale failure is never copied onto another item.
    const facts: Partial<DeskFacts> = { running: state.running ?? null };
    if (event.type === 'turn.started') Object.assign(facts, { failed: null, lastGoodStep: null });
    if (failedNow) Object.assign(facts, { failed: state.failed, lastGoodStep: item.activity && item.activity.at >= (item.facts.running?.since ?? Infinity) ? item.activity.text : null });
    this.setFacts(item.id, facts, event.type === 'turn.activity' && event.activity ? { activity: { text: event.activity.slice(0, 200), at } } : {});
    if (failedNow) this.settle(item.id, { activity: { what: 'failed', at }, summarize: false });
    else {
      this.refresh(item.id, { emitStep: true });
      this.flush();
    }
    return { itemId: item.id };
  }

  /**
   * Orphaned turns: a turn.started with no terminal event holds a lease. With no turn.activity for
   * 20 min, and the bot's /status/work showing nothing in flight for the conversation (or not
   * answering), the turn is closed as finished-unknown and the step recomputed. A bot that reports
   * channel work without saying which channels keeps the lease, up to 2 h.
   */
  async checkOrphanTurns(): Promise<string[]> {
    const now = this.now();
    const stale = this.store
      .markerKeys('turn:')
      .map((key) => ({ key: key.slice('turn:'.length), state: this.turnState(key.slice('turn:'.length)) }))
      .filter(({ state }) => state.running && now - Math.max(state.running.since, state.running.lastAt ?? 0) >= ORPHAN_TURN_MS);
    if (stale.length === 0) return [];
    let work: BotWork | null = null;
    try {
      work = this.options.botWork ? await this.options.botWork() : null;
    } catch {
      work = null; // unreachable: nothing can be in flight that we could wait for
    }
    const closed: string[] = [];
    for (const { key, state } of stale) {
      const id = key.split(':')[1] ?? '';
      const idle = now - Math.max(state.running!.since, state.running!.lastAt ?? 0);
      const voice = (work?.voiceConversations ?? []).some((entry) => entry.split('|')[1] === id);
      const channel = work?.channelKeys ? work.channelKeys.some((entry) => entry === id || entry.endsWith(`:${id}`)) : (work?.channelTurns ?? 0) > 0;
      if ((voice || channel) && idle < ORPHAN_TURN_HARD_MS) continue;
      this.saveTurnState(key, { ...state, running: null });
      const item = this.itemForConversation(key);
      if (item && item.facts.running) {
        this.setFacts(item.id, { running: null }, { activity: { text: 'The turn ended without a report (finished-unknown)', at: now } });
        this.refresh(item.id, { emitStep: true });
      }
      this.log('desk.turn.orphaned', { conversationKey: key, idleMs: idle });
      closed.push(key);
    }
    this.flush();
    return closed;
  }

  // ── background jobs ────────────────────────────────────────────────────

  /**
   * The owner wrote in a conversation that reports up (a worker, or a job with an owner): what it reports to hears
   * the words at once, so it never asks the owner again (TGO-1075; docs/specs/spaces.md). Each message goes as the
   * source's record of it is first filed, so a desk reply, a brief answered on the row and words typed in Loom
   * are told once each, however a poll groups them.
   */
  onOwnerPostedUp(listener: (post: OwnerPostUp) => void): () => void {
    this.ownerPostListeners.add(listener);
    return () => this.ownerPostListeners.delete(listener);
  }
  private readonly ownerPostListeners = new Set<(post: OwnerPostUp) => void>();
  /** Which rows carry each raising row's brief, as the last read worked out (withCarriedBriefs); flush re-sends them. */
  private carriersBySource = new Map<string, Set<string>>();
  /** Some row has an open brief: a change anywhere may move who carries it (flush). */
  private briefsOpen = false;
  /**
   * The rows that last carried each brief (`<itemId>|<D-n>`), kept after the brief closes so its source can tell a
   * carrier outside it how it went (source-loom.ts tellCarrier), whenever carrying last changed (Codex review on #781).
   */
  private readonly carriersLastSeen = new Map<string, Set<string>>();

  /** Kept in the store too (a marker per brief), so a restart between carrying and settling loses no carrier. */
  private rememberCarriers(key: string, carriers: Set<string>): void {
    const known = this.carriersLastSeen.get(key);
    if (known && known.size === carriers.size && [...known].every((id) => carriers.has(id))) return;
    this.carriersLastSeen.set(key, carriers);
    if (carriers.size) this.store.setMarker(`carriers:${key}`, JSON.stringify([...carriers]));
    else this.store.deleteMarker(`carriers:${key}`);
  }

  /** The rows that last carried this brief, consumed: each is told once. */
  takeCarriers(itemId: string, decisionId: string): string[] {
    const carriers = this.carriersOf(itemId, decisionId);
    const key = `${itemId}|${decisionId}`;
    this.carriersLastSeen.delete(key);
    this.store.deleteMarker(`carriers:${key}`);
    return carriers;
  }

  /** The rows that carry this open brief now, left in place (a revision's FYI; TGO-1079). */
  carriersOf(itemId: string, decisionId: string): string[] {
    this.readItems();
    const key = `${itemId}|${decisionId}`;
    const known = this.carriersLastSeen.get(key);
    if (known) return [...known];
    try {
      return JSON.parse(this.store.marker(`carriers:${key}`) ?? '[]') as string[];
    } catch {
      return [];
    }
  }
  /** Briefs the desk answered, `<itemId>|<D-n>` → when: Loom's answer turn for them is not the owner's own words. */
  private readonly answeredBriefs = new Map<string, number>();
  /** `itemId|requestId` → Loom thread id: a brief a linked Discord row doesn't show, answered through the thread that raised it. */
  private readonly backedHidden = new Map<string, string>();

  private passOwnerPostUp(itemId: string, raw: string, at: number, messageId: string): void {
    // Fresh words only: a first poll of an old conversation (a backfill) is history, not the owner speaking now.
    if (!this.ownerPostListeners.size || this.now() - at > OWNER_POST_UP_MS) return;
    const item = this.item(itemId);
    const f = item?.facts;
    if (!item || !f?.parentItemId || !(f.role === 'ops' || (f.role === 'worker' && !f.ownerGone))) return;
    const text = raw.trim();
    if (!text || parseMailHeader(text)) return;
    // A brief the desk just answered on a Loom worker comes back as Loom's turn ("Decision D-n: …"), and its lead is
    // told already: by Loom when it is a Loom thread (passOnResolved), by the desk otherwise (source-loom.ts
    // tellCarrier). No second note. Known from the answer the desk sent, never from the words alone, which the owner
    // could type (Codex review on #781).
    const answered = /^Decision (D-\d+): /.exec(text)?.[1];
    const sentAt = answered ? this.answeredBriefs.get(`${itemId}|${answered}`) : undefined;
    if (sentAt !== undefined && this.now() - sentAt <= OWNER_POST_UP_MS && item.source === 'loom') {
      this.answeredBriefs.delete(`${itemId}|${answered}`);
      return;
    }
    const decisionId = /(?<![\w-])D-\d+(?![\w-])/.exec(text)?.[0] ?? null;
    // To the conversation the owner sees, past any worker or job in between (as briefs go up; Codex review on #781).
    const to = this.ownerFacingLeadOf(item) ?? f.parentItemId;
    for (const listener of this.ownerPostListeners) listener({ itemId, title: this.title(item), parentItemId: to, text, at, decisionId, messageId });
  }

  /** The first conversation up a worker's or job's chain that speaks to the owner (desk/asks.ts ownerFacingLead). */
  ownerFacingLeadOf(item: DeskItem): string | null {
    const seen = new Set([item.id]);
    let at = item.facts.parentItemId ? this.item(item.facts.parentItemId) : null;
    while (at && !seen.has(at.id)) {
      const role = at.facts.role;
      if (role !== 'ops' && !(role === 'worker' && !at.facts.ownerGone)) return at.id;
      seen.add(at.id);
      at = at.facts.parentItemId ? this.item(at.facts.parentItemId) : null;
    }
    return null;
  }

  /** Called when a PR watch is added, so its review is read now rather than at the next poll. */
  onPrWatch(listener: (itemId: string) => void): () => void {
    this.prWatchListeners.add(listener);
    return () => this.prWatchListeners.delete(listener);
  }

  /** The running jobs right now: each one marks its conversation Watching; jobs that ended clear. */
  setJobs(jobs: RunningJob[]): void {
    const wanted = new Map<string, RunningJob>();
    for (const job of jobs) {
      const key = job.threadId ? `thread:${job.threadId}` : (job.conversationKey ?? `channel:${job.channelId}`);
      const item = this.itemForConversation(key);
      if (item && !wanted.has(item.id)) wanted.set(item.id, job);
    }
    const withJob = this.store.items().filter((item) => item.facts.job);
    for (const item of withJob) {
      if (wanted.has(item.id)) continue;
      this.setFacts(item.id, { job: null });
      this.refresh(item.id, { emitStep: true });
    }
    for (const [itemId, job] of wanted) {
      const item = this.store.item(itemId)!;
      if (item.facts.job?.id === job.id) continue;
      this.setFacts(itemId, { job: { id: job.id, agentId: job.agentId, label: job.label, startedAt: job.startedAt, deadlineAt: job.deadlineAt } });
      this.refresh(itemId, { emitStep: true });
    }
    this.flush();
  }

  // ── attention ──────────────────────────────────────────────────────────

  /** The seq of the snooze event in effect (the latest one not undone), or null. */
  private currentSnoozeSeq(itemId: string): number | null {
    const events = this.store.eventsFor(itemId);
    const undone = new Set(events.filter((event) => event.type === 'undo' && event.undoesSeq !== null).map((event) => event.undoesSeq!));
    let seq: number | null = null;
    for (const event of events) if (event.type === 'snooze' && !undone.has(event.seq) && (seq === null || event.seq > seq)) seq = event.seq;
    return seq;
  }

  attention(itemId: string): Attention {
    return this.store.attention(itemId) ?? replayAttention(itemId, this.store.eventsFor(itemId));
  }

  /** Appends an event and folds it into the projection. */
  private apply(itemId: string, type: DeskEventType, actor: Actor, payload: Record<string, unknown>, extra: { commandId?: string; undoesSeq?: number } = {}): DeskEvent {
    if (type === 'done' || type === 'source.done' || type === 'clear') {
      // What Done clears, kept on the event so Undo can put it back (Codex review on #928).
      const f = this.store.item(itemId)?.facts;
      payload = { ...payload, askClosed: { reason: 'closed by done', at: this.now() }, ...(f ? { cleared: { openAsk: f.openAsk ?? null, handoff: f.handoff ?? null, askClosedByDoneAt: f.askClosedByDoneAt ?? 0, clearedAt: f.clearedAt ?? 0 } } : {}) };
    }
    const event = this.store.appendEvent({ at: this.now(), itemId, type, actor, payload, commandId: extra.commandId ?? null, undoesSeq: extra.undoesSeq ?? null });
    const before = this.store.attention(itemId) ?? initialAttention(itemId, event.at);
    const after = type === 'undo' ? replayAttention(itemId, this.store.eventsFor(itemId)) : reduceAttention(before, event);
    this.store.saveAttention(after);
    // The command's own token, taken as it records its event: work it awaits afterwards (a write-back) can't let a
    // later agent post pass as this command's (CommandResult outcome.attentionAt).
    if (extra.commandId && this.attentionByCommand.has(extra.commandId)) this.attentionByCommand.set(extra.commandId, after.updatedAt);
    const moved = before.disposition !== after.disposition || before.seen !== after.seen;
    // Source bookkeeping (activity, owner posted) is traced only when it moves attention; owner and system decisions always.
    if (type !== 'source.created' && (moved || !type.startsWith('source.') || type === 'source.step')) {
      const state = (a: Attention) => (a.disposition === 'active' ? `active/${a.seen}` : a.disposition);
      this.trace(
        `attention.${type}`,
        `${this.traceName(itemId)}: ${type} by ${actor}${moved ? ` · ${state(before)} → ${state(after)}` : ' · no change'}`,
        { itemId, type, actor, seq: event.seq, commandId: event.commandId, payload, from: { disposition: before.disposition, seen: before.seen }, to: { disposition: after.disposition, seen: after.seen } },
      );
    }
    this.feedFor(itemId, type, payload, before.disposition, after.disposition, event.seq);
    this.store.bumpRevision(itemId);
    this.changed.add(itemId);
    if (after.disposition === 'done' && before.disposition !== 'done') {
      this.clearConversationFailure(itemId);
      this.setFacts(itemId, { openAsk: null, handoff: null, askClosedByDoneAt: event.at, askClosedBySource: false });
    }
    if (type === 'clear') this.setFacts(itemId, { openAsk: null, askClosedByDoneAt: event.at, askClosedBySource: false, clearedAt: event.at });
    // Undoing that Done restores the ask it closed, unless the source has written a newer one since.
    if (type === 'undo' && (payload.type === 'clear' || (before.disposition === 'done' && after.disposition !== 'done'))) this.restoreClearedAsk(itemId, payload.seq);
    // Undoing an automatic transition sticks: the timer that made it must not simply make it again.
    if (type === 'undo') this.rememberUndo(itemId, String(payload.type ?? ''), event.at);
    if (type !== 'source.activity' && type !== 'source.owner_posted' && type !== 'source.created') {
      for (const listener of this.listeners) listener({ type: 'activity', event });
    }
    return event;
  }

  private restoreClearedAsk(itemId: string, seq: unknown): void {
    const done = typeof seq === 'number' ? this.store.eventsFor(itemId).find((event) => event.seq === seq) : undefined;
    const cleared = done?.payload.cleared as { openAsk: DeskFacts['openAsk']; handoff: DeskFacts['handoff']; askClosedByDoneAt: number; clearedAt?: number } | undefined;
    const f = this.store.item(itemId)?.facts;
    if (!done || !cleared || !f || f.askClosedByDoneAt !== done.at) return;
    const closed = done.type !== 'clear' && f.askClosedBySource === true;
    if (this.store.patchItem(itemId, { facts: { ...f, clearedAt: cleared.clearedAt ?? 0, askClosedByDoneAt: cleared.askClosedByDoneAt, askClosedBySource: false, openAsk: f.openAsk ?? (closed ? null : cleared.openAsk), handoff: f.handoff ?? (closed ? null : cleared.handoff) } })) this.changed.add(itemId);
  }

  /** What an event posts to the news feed: a thread turning to the owner (or failing), or done. */
  private feedFor(itemId: string, type: DeskEventType, payload: Record<string, unknown>, from: string, to: string, eventSeq: number): void {
    if (!this.options.feed) return;
    // Done, undone: the post goes too (Codex review on #595).
    if (type === 'undo') {
      // Under the thread's key, or the older `done:` one (the seed's and earlier posts'; Codex review on #631).
      if (payload.type === 'done' && typeof payload.seq === 'number') for (const key of [`thread:${itemId}`, `done:${itemId}`]) this.options.feed.retract(key, payload.seq);
      return;
    }
    const item = this.store.item(itemId);
    if (!item || item.hidden) return;
    // In the summary's words: its headline when it has one, the thread's name otherwise.
    const headline = item.summary?.headline || null;
    const base = { itemId, projectId: item.facts.projectId ?? null, agentName: item.agentName, title: headline || this.title(item), text: item.summary?.paragraph || item.summary?.gist || '', data: { ...(headline ? { headline: true } : {}), ...(item.summary?.contentKey ? { contentKey: item.summary.contentKey } : {}) } };
    // A conversation that just began is a new thread; its first summary folds into this post. One the desk
    // only now discovers (a backfill when a source is first read, a rebuilt desk) began long ago: not news
    // (Codex review on #621).
    if (type === 'source.created') {
      // A Discord thread's id says when it began; its first fetched message may be much later (Codex review on #621).
      const began = item.source === 'discord' && item.threadId ? Math.min(item.createdAt, snowflakeTime(item.threadId)) : item.createdAt;
      if (this.now() - began <= FEED_NEW_THREAD_MS) this.postFeed({ ...base, kind: 'started', text: '', key: `thread:${itemId}`, mergeMs: FEED_MERGE_MS });
      return;
    }
    // Inside a summary, its own post says the thread turned (with the words that turned it): no bare post first.
    // Snoozed or parked, itself or with its project: out of rotation by the owner's choice, no news until it's
    // back (Codex review on #648).
    // A to-do, or an ask carried by another row, turned the step without being the owner's move: no "needs" post.
    // A turn to Needs you or Failed posts from status.entered (flush), off the evaluator, not the step.
    if (to === 'done' && from !== 'done') {
      // Each Done remembers its event: undoing that one takes back this post, not a later one.
      this.postFeed({ ...base, kind: 'done', data: { ...base.data, eventSeq }, key: `thread:${itemId}`, mergeMs: FEED_MERGE_MS });
    }
  }

  /** Posts to the news feed (desk/feed.ts), when there is one: the PR watch and the coordinators post too. */
  postFeed(post: NewFeedPost): void {
    this.options.feed?.post(post);
  }

  /** A chapter that settled or was done takes its failure with it: the conversation's marker forgets it. */
  private clearConversationFailure(itemId: string): void {
    const item = this.store.item(itemId);
    if (!item || !splitByTime(item)) return;
    const turn = this.turnState(item.conversationKey);
    if (turn.failed && this.store.latestInConversation(item.conversationKey)?.id === itemId) this.saveTurnState(item.conversationKey, { ...turn, failed: null });
  }

  /**
   * chapter.settled undone: no automatic settle again until there is new activity.
   * snooze.expired undone: the reducer keeps the item active with the snooze cleared (see replay).
   */
  private rememberUndo(itemId: string, type: string, at: number): void {
    if (type === 'chapter.settled') this.store.setMarker(`nosettle:${itemId}`, String(at));
  }

  /** Records a decision made elsewhere (the one-time import from the old inbox). */
  importDecision(itemId: string, type: 'park' | 'done' | 'seen', payload: Record<string, unknown>): void {
    this.apply(itemId, type, 'system', payload);
    this.flush();
  }

  /** The owner saw a catch-up line from this thread (desk/updates.ts): it is covered up to that line's time. */
  coverThread(itemId: string, until: number): void {
    if (!this.store.item(itemId)) return;
    const state = this.attention(itemId);
    const newest = this.store.latestAgentMessageAt(itemId) ?? 0;
    if ((state.coveredUntil ?? 0) >= until && (state.seen === 'seen' || newest > until)) return;
    this.apply(itemId, 'seen', 'system', { via: 'update', until, newest });
    this.flush();
  }

  /** Rebuilds an item's projection from its log (repair; tests). */
  rebuildAttention(itemId: string): Attention {
    const state = replayAttention(itemId, this.store.eventsFor(itemId));
    this.store.saveAttention(state);
    return state;
  }

  // ── commands ───────────────────────────────────────────────────────────

  async command(command: DeskCommand): Promise<CommandResult> {
    const { commandId } = command;
    if (!commandId || typeof commandId !== 'string') return { commandId: String(commandId ?? ''), status: 'failed', error: 'commandId is required' };
    // The same id arriving while the first is still running waits for the first's outcome.
    const running = this.inFlight.get(commandId);
    if (running) return running;
    const stored = this.store.command(commandId);
    if (stored) return this.resultOf(stored.commandId);
    if (!(COMMAND_TYPES as readonly string[]).includes(command.type)) return { commandId, status: 'failed', error: `unknown command type ${command.type}` };
    const work = this.execute(command).finally(() => this.inFlight.delete(commandId));
    this.inFlight.set(commandId, work);
    return work;
  }

  private async execute(command: DeskCommand): Promise<CommandResult> {
    const { commandId } = command;
    if (!this.store.insertCommand({ commandId, type: command.type, itemId: command.itemId ?? null, args: command.args ?? {} })) return this.resultOf(commandId);
    const started = this.now();
    const what = `${command.type}${command.itemId ? ` on ${this.traceName(command.itemId)}` : ''} by ${command.actor ?? 'owner'}`;
    try {
      // The item's attention time as of this command: a screen's next guarded action on it (ifStateAt) sends this, so
      // a follow-up tapped before its lists are read again is still checked against what happened since. Its own
      // event's time when it records one; else the time before it ran (it changed nothing there).
      const before = command.itemId && this.store.item(command.itemId) ? this.attention(command.itemId).updatedAt : null;
      // Tracked for this top-level command only: internal calls (a project's Finish marking members done) record none.
      this.attentionByCommand.set(commandId, Number.NaN);
      const ran = await this.run(command);
      // Successful owner actions acknowledge a completed reply too. Passive views
      // and explicit seen marks use their own validation below.
      if (command.itemId && ['owner', 'screen', 'voice'].includes(command.actor ?? 'owner') &&
          ['done', 'pickup', 'reopen', 'park', 'snooze', 'reply', 'respond', 'approve', 'heard', 'briefed'].includes(command.type)) {
        const item = this.store.item(command.itemId);
        if (item) await this.acknowledgeSeen(item, started);
      }
      const own = this.attentionByCommand.get(commandId);
      this.attentionByCommand.delete(commandId);
      const attentionAt = own !== undefined && !Number.isNaN(own) ? own : before;
      const outcome = attentionAt !== null && attentionAt !== undefined ? { ...ran, attentionAt } : ran;
      this.store.finishCommand(commandId, 'applied', outcome);
      this.trace('command.applied', `${what}: applied`, { commandId, type: command.type, itemId: command.itemId ?? null, actor: command.actor ?? 'owner', args: command.args ?? {}, outcome, ms: this.now() - started });
    } catch (err) {
      this.attentionByCommand.delete(commandId);
      const message = (err as Error).message;
      const outcome = err instanceof CommandError ? err.outcome : { error: message };
      this.store.finishCommand(commandId, 'failed', outcome, message);
      this.trace('command.failed', `${what}: failed (${message})`, { commandId, type: command.type, itemId: command.itemId ?? null, actor: command.actor ?? 'owner', args: command.args ?? {}, error: message, outcome, ms: this.now() - started });
      if (!(err instanceof CommandError)) this.log('desk.command.error', { commandId, type: command.type, message });
    } finally {
      this.flush();
    }
    return this.resultOf(commandId);
  }

  /** On start: commands left `accepted` by a restart (older than 60 s) failed as interrupted. */
  recoverCommands(): number {
    const count = this.store.failStaleCommands(this.now() - INTERRUPTED_COMMAND_MS, 'interrupted');
    if (count) this.log('desk.commands.interrupted', { count });
    return count;
  }

  private resultOf(commandId: string): CommandResult {
    const stored = this.store.command(commandId)!;
    return {
      commandId,
      status: stored.status,
      ...(stored.error ? { error: stored.error } : {}),
      ...(stored.outcome ? { outcome: stored.outcome } : {}),
    };
  }

  private requireItem(command: DeskCommand): DeskItemRow {
    const item = command.itemId ? this.store.item(command.itemId) : null;
    if (!item) throw new CommandError(command.itemId ? `no desk item ${command.itemId}` : 'itemId is required');
    return item;
  }

  /**
   * The item, when it is still as the owner saw it. A row on the List's Snoozed or Parked tab (and the
   * picker changing its snooze) sends `ifStateAt`, the attention time it showed: if the agent posted,
   * another screen changed the snooze, or the item was done since, the action is refused rather than
   * hiding a new reply, overwriting a newer snooze, or reopening a finished item (Codex review on #492).
   */
  private unchangedItem(command: DeskCommand): DeskItemRow {
    const item = this.requireItem(command);
    const seenAt = command.args?.ifStateAt;
    if (typeof seenAt !== 'number') return item;
    const now = this.attention(item.id);
    if (now.updatedAt === seenAt) return item;
    const why = now.disposition === 'active' ? 'it’s back in Active with something new' : now.disposition === 'done' ? 'it’s already done' : 'it was changed on another screen';
    throw new CommandError(why, { changed: true, disposition: now.disposition });
  }

  private async linkedBrief(itemId: string, decisionId: string): Promise<{ threadId: string; pending: PendingRequest } | null> {
    for (const adapter of this.options.adapters ?? []) {
      const found = await adapter.linkedBrief?.(itemId, decisionId);
      if (found) return found;
    }
    return null;
  }

  private adapterFor(item: DeskItemRow): DeskSourceAdapter | null {
    return this.options.adapters?.find((adapter) => adapter.owns(item)) ?? null;
  }

  private async run(command: DeskCommand): Promise<Record<string, unknown>> {
    const args = command.args ?? {};
    const actor: Actor = command.actor ?? 'owner';
    const cid = { commandId: command.commandId };
    if (actor === 'screen') this.noteScreenActivity();
    else if (actor === 'voice') this.noteOwnerActivity('voice');
    switch (command.type) {
      case 'ask.resolve': {
        const item = this.requireItem(command);
        const askId = typeof args.askId === 'string' ? args.askId : '';
        const record = item.facts.askLedger ?? item.facts.openAsk;
        if (!askId || record?.id !== askId) throw new CommandError('This ask is no longer on this thread');
        if (record.kind !== 'do' || record.legacy || record.to) throw new CommandError('This ask takes a reply');
        if (args.step !== undefined && typeof args.step !== 'string') throw new CommandError('step must be a number as text or step text');
        if (args.note !== undefined && typeof args.note !== 'string') throw new CommandError('note must be text');
        if (args.revision !== undefined && (typeof args.revision !== 'number' || !Number.isInteger(args.revision))) throw new CommandError('revision must be a whole number');
        // The completion names the revision the card showed, as a brief's answer does (TGO-1079): a re-record since
        // (other steps, another kind) would mark a different step done. Refused here against the desk's copy, and
        // again by the source against its ledger; once revised, a completion has to say which revision it saw.
        if (typeof record.revision === 'number') {
          const seen = typeof args.revision === 'number' ? args.revision : record.revision === 1 ? 1 : null;
          if (seen !== record.revision) throw new CommandError(`${QUESTION_CHANGED}: this ask was updated since you looked (revision ${record.revision}); read it again`, { changed: true });
        }
        const backing = loomBacking(item) ?? item;
        const adapter = this.adapterFor(backing);
        if (!adapter?.resolveAsk) throw new CommandError('This source cannot resolve an ask');
        const result = await adapter.resolveAsk(backing, askId, { by: actor === 'voice' ? 'desk' : 'person',
          ...(typeof args.step === 'string' ? { step: args.step } : {}), ...(typeof args.note === 'string' ? { note: args.note } : {}),
          ...(typeof args.revision === 'number' ? { revision: args.revision } : {}) }, cid);
        if (!result.ok) throw new CommandError(result.error, result.changed ? { changed: true } : null);
        return { askId };
      }
      case 'seen': {
        // With ifStateAt (Mark read on a snoozed or parked row): only while it is as the owner saw it (Codex review on #684).
        const item = this.unchangedItem(command);
        // via 'read' (the desk's Mark read on a selection): read, as opening it is; it stays where it is and nothing goes to the source.
        const via = args.fromSource === true ? 'reaction' : args.via === 'read' ? 'read' : 'explicit';
        const event = this.apply(item.id, 'seen', actor, { via }, cid);
        if (['owner', 'screen', 'voice'].includes(actor)) await this.acknowledgeSeen(item, this.now());
        if (via === 'explicit') void this.mirror(item, '👀');
        return { seq: event.seq };
      }
      case 'unseen': {
        const item = this.unchangedItem(command);
        return { seq: this.apply(item.id, 'unseen', actor, {}, cid).seq };
      }
      case 'viewed': {
        const item = this.requireItem(command);
        const ms = Number(args.ms ?? 0);
        // Scrolling past doesn't count; an open detail for 3 s does.
        if (!(ms >= 3000)) return { counted: false };
        if (['owner', 'screen', 'voice'].includes(actor)) await this.acknowledgeSeen(item, this.now());
        // The catch-up lines the thread showed inline (desk/updates.ts): only those are read, never the rest.
        const updates = Array.isArray(args.updates) ? [...new Set(args.updates.filter((id): id is number => Number.isInteger(id) && (id as number) > 0))].slice(0, 200) : [];
        return { counted: true, seq: this.apply(item.id, 'seen', actor, { via: 'viewed', ms, ...(updates.length ? { updates } : {}) }, cid).seq };
      }
      case 'heard': {
        const item = this.requireItem(command);
        if (args.playbackComplete !== true) throw new CommandError('heard requires playbackComplete: true (interrupted speech is not heard)');
        return { seq: this.apply(item.id, 'seen', actor, { via: 'heard' }, cid).seq };
      }
      case 'briefed': {
        const item = this.requireItem(command);
        return { seq: this.apply(item.id, 'seen', actor, { via: 'briefed' }, cid).seq };
      }
      case 'done': {
        const item = this.unchangedItem(command);
        // Done or picked up by its own command (voice "mark it done", a row's Done): the sweep is answered too.
        this.removeFromSweep(item.id);
        return this.done(item, actor, args, cid);
      }
      case 'reopen':
      case 'pickup': {
        const item = this.unchangedItem(command);
        if (command.type === 'pickup') this.removeFromSweep(item.id);
        // Held by a project that is away: this one comes back on its own; the project stays away.
        // The event says so, so undoing it puts the conversation back under the project (Codex review on #537).
        const held = command.type === 'pickup' && !!this.item(item.id)?.heldBy;
        if (held) this.setFacts(item.id, { projectPickedUpAt: this.now() });
        return { seq: this.apply(item.id, command.type, actor, held ? { fromProjectHold: true } : {}, cid).seq };
      }
      case 'park': {
        const item = this.unchangedItem(command);
        const event = this.apply(item.id, 'park', actor, {}, cid);
        if (args.fromSource !== true) void this.mirror(item, '💤');
        return { seq: event.seq };
      }
      case 'snooze': {
        const item = this.unchangedItem(command);
        const until = typeof args.until === 'string' ? Date.parse(args.until) : typeof args.until === 'number' ? args.until : null;
        const trigger = args.trigger === 'desk' || args.trigger === 'agent_posts' ? args.trigger : null;
        if (until !== null && !(Number.isFinite(until) && until > this.now())) throw new CommandError('until must be a future ISO time');
        if (until === null && trigger === null) throw new CommandError('snooze needs until (ISO) or trigger (desk | agent_posts); use park for an indefinite snooze');
        // A re-time (the desk toast): only while the item is still snoozed. If the agent posted in
        // between, it is back in Active with news, and snoozing again would hide that reply.
        // With snoozeSeq, it must also still be that snooze: a toast left over from an earlier snooze
        // must not re-time a newer one.
        // A one-tap snooze: only from Active, so two screens tapping the same card record one snooze.
        if (args.onlyIfActive === true && this.attention(item.id).disposition !== 'active') throw new CommandError('already out of the rotation', { active: false });
        if (args.onlyIfSnoozed === true) {
          if (this.attention(item.id).disposition !== 'snoozed') throw new CommandError('no longer snoozed', { snoozed: false });
          if (typeof args.snoozeSeq === 'number' && this.currentSnoozeSeq(item.id) !== args.snoozeSeq) throw new CommandError('a newer snooze is in effect', { snoozed: true, replaced: true });
        }
        return { seq: this.apply(item.id, 'snooze', actor, { ...(until !== null ? { until } : {}), ...(trigger ? { trigger } : {}) }, cid).seq };
      }
      case 'tag': {
        // The owner's type, kept on the desk only (never written to the source). A key not given is left as is.
        const item = this.requireItem(command);
        const pick = <T extends string>(value: unknown, allowed: readonly T[], name: string): T | null | undefined => {
          if (value === undefined) return undefined;
          if (value === null || value === '') return null;
          if (!(allowed as readonly string[]).includes(String(value))) throw new CommandError(`${name} must be one of ${allowed.join(', ')}, or null`);
          return String(value) as T;
        };
        const type = pick<ItemType>(args.type, ITEM_TYPES, 'type');
        if (type === undefined) throw new CommandError('tag needs type');
        this.confirmAutoTag(item.id);
        this.setFacts(item.id, { tagsSeeded: true, type });
        this.refresh(item.id);
        return { type };
      }
      case 'project': {
        // The owner's project for this conversation, kept on the desk only. null takes it out of its project.
        const item = this.requireItem(command);
        const projectId = args.projectId === null || args.projectId === '' ? null : typeof args.projectId === 'string' ? args.projectId : undefined;
        if (projectId === undefined) throw new CommandError('project needs projectId (a project id, or null)');
        const project = projectId ? readProjects(this.store.setting('projects')).find((p) => p.id === projectId) : null;
        if (projectId && !project) throw new CommandError(`no project ${projectId}`);
        if (project?.finishedAt) throw new CommandError(`${project.name} is finished`);
        return this.moveProject(item, projectId, actor, args.parentItemId);
      }
      case 'label': {
        // The old label chips (one word for both): mapped onto type; hold parks it. Kept for old clients.
        const item = this.requireItem(command);
        const raw = args.label === null || args.label === '' || args.label === undefined ? null : String(args.label);
        if (raw !== null && !(LIST_LABELS as readonly string[]).includes(raw)) throw new CommandError(`label must be one of ${LIST_LABELS.join(', ')}, or null`);
        const legacy = raw ? LEGACY_LABELS[raw] : null;
        if (legacy?.park) return { seq: this.apply(item.id, 'park', actor, {}, cid).seq };
        this.confirmAutoTag(item.id);
        this.setFacts(item.id, { tagsSeeded: true, ...(legacy?.type ? { type: legacy.type } : {}), ...(raw === null ? { type: null } : {}) });
        this.refresh(item.id);
        return { type: this.store.item(item.id)!.facts.type ?? null };
      }
      case 'pin': {
        const item = this.requireItem(command);
        if (typeof args.pinned !== 'boolean') throw new CommandError('pinned must be true or false');
        const adapter = this.adapterFor(item);
        // The source keeps it (the source pin), and the next poll follows it; the desk shows it now.
        if (adapter?.pin) await adapter.pin(item, args.pinned);
        this.setFacts(item.id, { pinned: args.pinned });
        // A pin is a promotion: a done, snoozed or
        // parked item comes back to Active, rather than sitting pinned in History (Codex review on #490).
        const before = this.attention(item.id).disposition;
        const back = args.pinned && before !== 'active' ? this.apply(item.id, 'pickup', actor, { via: 'pin' }, cid) : null;
        if (!back) this.refresh(item.id);
        // `seq`: the promotion's event, so an undo (voice's "undo that") can put it back where it was.
        return { pinned: args.pinned, at: adapter?.pin ? 'source' : 'desk', ...(back ? { from: before, seq: back.seq } : {}) };
      }
      case 'space': {
        // Into an agent's space (or out of it, with null): the agent owns it, as a Discord agent owns its threads.
        const item = this.requireItem(command);
        const raw = args.agent as { id?: unknown; name?: unknown } | null | undefined;
        if (raw === null) {
          this.setFacts(item.id, { agentSpace: null });
          this.refresh(item.id);
          return { agentSpace: null };
        }
        const id = typeof raw?.id === 'string' ? raw.id.trim().toLowerCase() : '';
        const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
        if (!/^[a-z][\w-]{0,40}$/.test(id) || !name || name.length > 60) throw new CommandError('agent must be { id: "compass", name: "Compass" } or null');
        this.setFacts(item.id, { agentSpace: { id, name } });
        this.refresh(item.id);
        return { agentSpace: { id, name } };
      }
      case 'role': {
        // Who it works for (roles.ts): the owner's ⋯ menu, or an agent setting up a thread it started.
        const item = this.requireItem(command);
        if (!isThreadRole(args.role)) throw new CommandError(`role must be one of ${THREAD_ROLES.join(', ')}`);
        const parent = args.parentItemId === undefined ? undefined : args.parentItemId === null ? null : String(args.parentItemId);
        if (parent === item.id) throw new CommandError('a thread can’t be its own parent');
        const shown = this.item(item.id)!;
        let move: ReturnType<typeof this.spaceFactsOf> | undefined;
        let movedTo: string | null | undefined;
        if (parent && (OWNER_ACTORS.has(actor) || args.follow === true)) {
          const wrong = this.reportTargetError(parent, this.spaceOfItem(shown));
          if (wrong) {
            if (args.follow !== true) throw new CommandError(wrong);
            move = this.spaceFactsOf(parent);
            if (item.source === 'discord' && move.agentSpace && move.agentSpace.id !== querySpaceOf({ ...shown, facts: { ...shown.facts, projectId: null } })?.slice(6)) {
              throw new CommandError('a Discord conversation can’t leave its agent');
            }
            const destination = querySpaceOf({ ...shown, facts: { ...shown.facts, ...move } }, { projects: readProjects(this.store.setting('projects')) });
            const refused = this.reportTargetError(parent, destination);
            if (refused) throw new CommandError(refused);
            movedTo = destination;
          }
        }
        const adapter = this.adapterFor(item);
        if (adapter?.setRole) await adapter.setRole(item, args.role, parent);
        if (move) this.setFacts(item.id, { ...move, projectPickedUpAt: null });
        const previousParent = this.roles.get(item.id).parentItemId ?? item.facts.parentItemId;
        const set = this.roles.set(item.id, { role: args.role, ...(parent !== undefined ? { parentItemId: parent } : {}) }, actor, this.now());
        this.touch(item.id);
        // Its parent's row counts its workers: that changes too.
        for (const id of new Set([set.parentItemId, previousParent].filter((v): v is string => !!v))) this.touch(id);
        return { role: set.role, parentItemId: set.parentItemId, ...(move ? { movedTo } : {}) };
      }
      case 'keep': {
        // "Keep this session" (docs/specs/loom-context-management.md): the source never resets it on its own.
        const item = this.requireItem(command);
        const adapter = this.adapterFor(item);
        if (!adapter?.keepSession) throw new CommandError('this thread’s session can’t be kept from the desk');
        const keep = args.keep !== false;
        const kept = await adapter.keepSession(item, keep);
        if (!kept.ok) throw new CommandError(kept.error);
        this.setFacts(item.id, { keepSession: keep });
        this.refresh(item.id);
        return { keepSession: keep };
      }
      case 'raise': {
        // The budget's Raise: +50% for today; a thread held by its budget goes again.
        const item = this.requireItem(command);
        const adapter = this.adapterFor(item);
        if (!adapter?.raiseBudget) throw new CommandError('this thread has no budget to raise');
        const raised = await adapter.raiseBudget(item);
        if (!raised.ok) throw new CommandError(raised.error);
        this.setFacts(item.id, { budget: raised.budget });
        this.refresh(item.id);
        this.trace('budget', `${this.traceName(item.id)}: budget raised by ${actor}`, { itemId: item.id, actor });
        return { budget: raised.budget };
      }
      case 'fresh': {
        // The owner's one-off Fresh start: the next turn opens a new session.
        const item = this.requireItem(command);
        const adapter = this.adapterFor(item);
        if (!adapter?.freshStart) throw new CommandError('this thread can’t start a fresh session from the desk');
        const started = await adapter.freshStart(item);
        if (!started.ok) throw new CommandError(started.error);
        this.trace('fresh', `${this.traceName(item.id)}: fresh start asked by ${actor}`, { itemId: item.id, actor });
        return { fresh: true, ...(started.message ? { message: started.message } : {}) };
      }
      case 'stop': {
        // Stops the turn in progress, as Esc does in a terminal: the thread stays open for the next message.
        const item = this.requireItem(command);
        const adapter = this.adapterFor(item);
        if (!adapter?.interrupt) throw new CommandError('this thread can’t be stopped from the desk');
        if (!item.facts.running) throw new CommandError('nothing is running in this thread');
        const stopped = await adapter.interrupt(item);
        if (!stopped.ok) throw new CommandError(stopped.error);
        this.trace('stop', `${this.traceName(item.id)}: stopped by ${actor}`, { itemId: item.id, actor });
        return { stopped: true };
      }
      case 'run': {
        // A job's Run now: the source starts it and the desk hears the run as it lands, like any other.
        const item = this.requireItem(command);
        const adapter = this.adapterFor(item);
        if (!adapter?.runJob) throw new CommandError('only a job can be run from the desk');
        const ran = await adapter.runJob(item);
        if (!ran.ok) throw new CommandError(ran.error);
        this.trace('run', `${this.traceName(item.id)}: run started by ${actor}`, { itemId: item.id, actor });
        return { started: true };
      }
      case 'pause': {
        // A job's Pause and Resume: its timed runs stop until resumed. Shown at once; the next poll agrees.
        const item = this.requireItem(command);
        const adapter = this.adapterFor(item);
        if (!adapter?.pauseJob) throw new CommandError('only a job can be paused from the desk');
        const paused = args.paused !== false;
        const done = await adapter.pauseJob(item, paused);
        if (!done.ok) throw new CommandError(done.error);
        const schedule = item.facts.schedule;
        if (schedule) this.setFacts(item.id, { schedule: { ...schedule, paused } });
        this.refresh(item.id);
        this.trace('pause', `${this.traceName(item.id)}: ${paused ? 'paused' : 'resumed'} by ${actor}`, { itemId: item.id, actor });
        return { paused };
      }
      case 'rename': {
        const item = this.requireItem(command);
        const adapter = this.adapterFor(item);
        const raw = args.title === null || args.title === undefined ? '' : typeof args.title === 'string' ? args.title.replace(/\s+/g, ' ').trim() : null;
        if (raw === null || raw.length > 200) throw new CommandError('title must be text, up to 200 characters');
        // The source keeps it (its title); the desk shows it now, and the next poll agrees.
        if (adapter?.rename) {
          if (!raw) throw new CommandError('a thread needs a title');
          this.setFacts(item.id, {}, { place: await adapter.rename(item, raw) });
        } else this.setFacts(item.id, { name: raw || null });
        this.refresh(item.id);
        return { title: raw || null, at: adapter?.rename ? 'source' : 'desk' };
      }
      case 'watch': {
        // A PR the desk watches for its review (source-github), on any item, until it merges or closes.
        const item = this.requireItem(command);
        const pr = parsePrUrl(String(args.url ?? ''));
        if (!pr) throw new CommandError('url must be a GitHub pull request link (https://github.com/<owner>/<repo>/pull/<n>)');
        if (args.onApprove !== undefined && args.onApprove !== 'continue' && args.onApprove !== 'notify') throw new CommandError('onApprove must be continue or notify');
        const current = item.facts.prWatches ?? [];
        const same = (watch: PrWatch) => watch.url.toLowerCase() === pr.url.toLowerCase();
        const others = current.filter((watch) => !same(watch));
        if (args.off === true) {
          if (others.length === current.length) return { watching: false, url: pr.url, unchanged: true };
          // Its review drops off the card now; the next poll would drop it too.
          const reviews = (item.facts.prReviews ?? []).filter((review) => review.url.toLowerCase() !== pr.url.toLowerCase() || review.url.toLowerCase() === item.facts.pullRequest?.url.toLowerCase());
          this.setFacts(item.id, { prWatches: others.length ? others : null, prReviews: reviews.length ? reviews : null, prReview: aggregateReviews(reviews) });
          this.refresh(item.id);
          return { watching: false, url: pr.url };
        }
        const onApprove = args.onApprove === 'notify' ? 'notify' : 'continue';
        const before = current.find(same);
        this.setFacts(item.id, { prWatches: [...others, { url: pr.url, number: pr.number, onApprove, at: this.now(), by: actor, wokeFor: before?.wokeFor ?? null, ...(before?.wokeState ? { wokeState: before.wokeState } : {}) }] });
        this.refresh(item.id);
        for (const listener of this.prWatchListeners) listener(item.id);
        return { watching: true, url: pr.url, number: pr.number, onApprove, ...(before ? { updated: true } : {}) };
      }
      case 'reply':
      case 'answer': {
        const item = this.requireItem(command);
        const text = String((command.type === 'answer' ? args.option : args.text) ?? '').trim();
        // A reply may be only pictures (a screenshot says it); an answer is always words.
        const attachments = command.type === 'reply' ? parseAttachments(args.attachments) : [];
        if (!text && !attachments.length) throw new CommandError(command.type === 'answer' ? 'option is required' : 'text is required');
        if (attachments.length) {
          const { sizes, problems } = attachmentProblems(attachments);
          const total = sizes.reduce((sum, size) => sum + size, 0);
          if (item.source === 'discord' && total > MAX_DISCORD_UPLOAD_BYTES) problems.push(`Discord takes about ${Math.floor(MAX_DISCORD_UPLOAD_BYTES / 1024 / 1024)} MB of images on one message; these come to ${(total / 1024 / 1024).toFixed(1)} MB.`);
          if (problems.length) throw new CommandError(problems.join(' '));
          return this.reply(item, text, actor, cid, attachments);
        }
        // An answer chip on a Loom item blocked on a single question (or an approval) answers that request,
        // not a new turn. Items with nothing pending still get the option as a reply.
        const target = command.type === 'answer' ? this.answerTarget(item, args.requestId) : null;
        const pending = target && isCodingThread(target.item) ? target.pending : null;
        if (pending?.requestId && pending.kind === 'question' && pending.questions.length === 1) {
          const question = pending.questions[0]!;
          const checked = validateAnswers(pending, { [question.id]: question.multiSelect ? [text] : text });
          if ('error' in checked) throw new CommandError(checked.error);
          return this.resolvePending(target!.item, { kind: 'respond', requestId: pending.requestId, answers: checked.answers, ...briefRule(pending, args), ...seenRevision(args, pending) }, actor, cid, args.requestId);
        }
        if (pending?.requestId && pending.kind === 'approval') {
          const option = pending.approval?.options.find((candidate) => candidate.label.toLowerCase() === text.toLowerCase());
          if (option) return this.resolvePending(item, { kind: 'approve', requestId: pending.requestId, decision: option.decision }, actor, cid, args.requestId);
        }
        return this.reply(item, text, actor, cid);
      }
      case 'respond':
      case 'approve':
      case 'dismiss': {
        const carrier = this.requireItem(command);
        let target = this.answerTarget(carrier, args.requestId);
        // A brief the row doesn't show (the thread has two open and shows its newest) is still answerable by its page.
        if (typeof args.requestId === 'string' && args.requestId.startsWith('decision:') && target?.pending.requestId !== args.requestId && command.type === 'respond') {
          const decisionId = args.requestId.slice('decision:'.length);
          const hidden = await this.adapterFor(carrier)?.briefPending?.(carrier, decisionId);
          // A Discord row showing its agent's Loom records: the brief is on the Loom thread that raised it, which may
          // not be the one the row links now (source-loom.ts linkDiscord); the answer goes there.
          const linked = hidden || carrier.source === 'loom' ? null : await this.linkedBrief(carrier.id, decisionId);
          if (hidden) target = { item: carrier, pending: hidden };
          else if (linked) { target = { item: carrier, pending: linked.pending }; this.backedHidden.set(`${carrier.id}|${linked.pending.requestId}`, linked.threadId); }
        }
        const item = target?.item ?? carrier;
        const pending = target?.pending ?? null;
        if (!pending) throw new CommandError(`${QUESTION_CHANGED}: nothing is pending on this item any more`);
        if (!pending.requestId) throw new CommandError('this request has no id the desk can answer; open it in its source');
        if (command.type === 'approve') {
          if (pending.kind !== 'approval') throw new CommandError(`${QUESTION_CHANGED}: this item is waiting on a question, not an approval`);
          const decision = pending.approval?.options.find((option) => option.decision === args.decision)?.decision;
          if (!decision) throw new CommandError(`decision must be one of: ${(pending.approval?.options ?? []).map((option) => option.decision).join(', ')}`);
          return this.resolvePending(item, { kind: 'approve', requestId: pending.requestId, decision }, actor, cid, args.requestId);
        }
        if (pending.kind !== 'question') throw new CommandError(`${QUESTION_CHANGED}: this item is waiting on an approval, not a question`);
        // A source request can be dismissed only when it permits dismissal.
        if (command.type === 'dismiss' && !pending.dismissible) throw new CommandError('this question cannot be dismissed; answer it');
        if (command.type === 'dismiss') return this.resolvePending(item, { kind: 'dismiss', requestId: pending.requestId }, actor, cid, args.requestId);
        // The client saw another request: refuse before checking answers against this one.
        if (typeof args.requestId === 'string' && args.requestId !== pending.requestId) throw new CommandError(`${QUESTION_CHANGED} since you saw it`, { changed: true });
        const checked = validateAnswers(pending, args.answers);
        if ('error' in checked) throw new CommandError(checked.error);
        return this.resolvePending(item, { kind: 'respond', requestId: pending.requestId, answers: checked.answers, ...briefRule(pending, args), ...seenRevision(args, pending) }, actor, cid, args.requestId);
      }
      case 'retry': {
        const item = this.requireItem(command);
        const attention = this.attention(item.id);
        if (attention.writeback?.outcome === 'failed' && attention.disposition === 'done') {
          return { writeback: await this.writeBack(item, attention.writeback.action === 'done' ? 'done' : attention.writeback.action) };
        }
        const request = item.facts.lastOwnerRequest?.text;
        if (item.nextStep !== 'failed') throw new CommandError('nothing to retry: the item has not failed');
        if (!request) throw new CommandError('no earlier request to re-send');
        // Images aren't kept after they're sent, so a pictures-only request can't be re-sent from here.
        if (item.facts.lastOwnerRequest?.images && !item.facts.lastOwnerRequest.words) throw new CommandError('the last request was only images; send them again from the reply box');
        return this.reply(item, request, actor, cid);
      }
      case 'undo': {
        const seq = Number(args.seq);
        const target = Number.isInteger(seq) ? this.store.event(seq) : null;
        if (!target) throw new CommandError(`no event ${args.seq}`);
        if (!isAttentionEvent(target.type)) throw new CommandError(`${target.type} events cannot be undone`);
        if (command.itemId && command.itemId !== target.itemId) throw new CommandError('that event belongs to another item');
        if (this.store.isUndone(seq)) throw new CommandError('already undone');
        if (target.type === 'clear') {
          const row = this.store.item(target.itemId);
          if (row) await this.adapterFor(row)?.undoClear?.(row, target.at);
        }
        if (target.type === 'done' && this.attention(target.itemId).disposition === 'done') {
          const row = this.store.item(target.itemId);
          if (row && row.facts.askClosedByDoneAt === target.at) await this.adapterFor(row)?.undoDone?.(row, target.at);
        }
        const event = this.apply(target.itemId, 'undo', actor, { seq, type: target.type }, { commandId: command.commandId, undoesSeq: seq });
        // Undoing "Back to Active on its own": held by its project again, if the project is still away.
        // Only when it was this pickup's: a newer one keeps its own (Codex review on #537).
        const pickedAt = this.store.item(target.itemId)?.facts.projectPickedUpAt ?? null;
        if (target.type === 'pickup' && target.payload?.fromProjectHold === true && pickedAt !== null && pickedAt <= target.at) {
          this.setFacts(target.itemId, { projectPickedUpAt: null });
          this.refresh(target.itemId);
        }
        return { seq: event.seq, undid: seq, attention: this.attention(target.itemId) };
      }
      case 'sweep': {
        const item = this.requireItem(command);
        const decision = args.decision;
        if (decision !== 'keep' && decision !== 'drop') throw new CommandError('decision must be keep or drop');
        this.removeFromSweep(item.id);
        if (decision === 'drop' && this.isStanding(item)) return { skipped: true };
        if (decision === 'keep') return { seq: this.apply(item.id, 'sweep.keep', actor, {}, cid).seq };
        const event = this.apply(item.id, 'sweep.drop', actor, { note: 'parked, not pursuing' }, cid);
        return { seq: event.seq, writeback: await this.writeBack(item, 'done') };
      }
    }
    throw new CommandError(`unhandled command ${command.type}`);
  }

  private async done(item: DeskItemRow, actor: Actor, args: Record<string, unknown>, cid: { commandId: string }, finishProject = false): Promise<Record<string, unknown>> {
    if (args.retryClearSeq !== undefined) {
      const events = this.store.eventsFor(item.id);
      const event = events.filter(e => e.type === 'clear').at(-1);
      if (!event || event.seq !== args.retryClearSeq || item.facts.clearedAt !== event.at || events.some(e => e.type === 'undo' && e.payload.seq === event.seq)) throw new CommandError('That Clear has changed or been undone');
      // Retry only the original source effect: newer words and asks remain untouched.
      return { seq: event.seq, cleared: true, retried: true, writeback: await this.writeBack(item, 'done', true) };
    }
    if (this.isStanding(item) && !finishProject) {
      const event = this.apply(item.id, 'clear', actor, {}, cid);
      const writeback = args.fromSource === true ? { outcome: 'n/a', steps: ['from source'] } : await this.writeBack(item, 'done', true);
      return { seq: event.seq, cleared: true, writeback };
    }
    const attention = this.attention(item.id);
    // Done again on an item whose write-back failed: retry the write-back only.
    if (attention.disposition === 'done' && attention.writeback?.outcome === 'failed') return { retried: true, writeback: await this.writeBack(item, 'done') };
    // Done twice (a voice re-fire, a double tap): it is already done and written back; nothing to do.
    if (attention.disposition === 'done') return { unchanged: true, ...(attention.writeback ? { writeback: attention.writeback } : {}) };
    // ✅ left in Discord itself: already written there; nothing to write back.
    if (args.fromSource === true) {
      const event = this.apply(item.id, 'done', actor, { fromSource: true }, cid);
      return { seq: event.seq, writeback: { action: 'done', outcome: 'n/a', at: this.now(), steps: ['from source'] } };
    }
    const job = item.facts.job;
    if (job && typeof args.stopJob !== 'boolean') throw new CommandError(`stopJob is required: "${job.label}" is still running in this conversation`);
    const event = this.apply(item.id, 'done', actor, { ...(job ? { stopJob: args.stopJob } : {}) }, cid);
    const outcome: Record<string, unknown> = { seq: event.seq };
    if (job && args.stopJob === true) {
      try {
        if (!this.options.cancelJob) throw new Error('no job bridge configured');
        await this.options.cancelJob(job);
        this.setFacts(item.id, { job: null });
        this.refresh(item.id);
        outcome.job = { id: job.id, stopped: true };
      } catch (err) {
        outcome.job = { id: job.id, stopped: false, error: (err as Error).message };
      }
    }
    outcome.writeback = await this.writeBack(item, 'done');
    return outcome;
  }

  /** Writes a decision back to its source and records the outcome apart from the decision. */
  private async writeBack(item: DeskItemRow, action: WritebackRecord['action'], clear = false): Promise<WritebackRecord> {
    const adapter = this.adapterFor(item);
    let record: WritebackRecord;
    if (!adapter) {
      record = { action, outcome: 'n/a', at: this.now() };
    } else {
      try {
        const fresh = this.store.item(item.id) ?? item;
        const result = clear ? await adapter.clear?.(fresh) ?? { outcome: 'n/a' as const } : await adapter.done(fresh);
        record = { ...result, action, at: this.now() };
      } catch (err) {
        record = { action, outcome: 'failed', error: (err as Error).message, at: this.now() };
      }
    }
    if (record.outcome === 'failed') this.log('desk.writeback.failed', { itemId: item.id, error: record.error });
    this.apply(item.id, 'writeback', 'system', record as unknown as Record<string, unknown>);
    return record;
  }

  /** Best-effort mirror of an explicit reaction to the source (👀, 💤). */
  private async mirror(item: DeskItemRow, emoji: string): Promise<void> {
    try {
      await this.adapterFor(item)?.react?.(item, emoji);
    } catch (err) {
      this.log('desk.mirror.error', { itemId: item.id, emoji, message: (err as Error).message });
    }
  }

  private async reply(item: DeskItemRow, text: string, actor: Actor, cid: { commandId: string }, attachments: StartAttachment[] = []): Promise<Record<string, unknown>> {
    const adapter = this.adapterFor(item);
    if (!adapter) throw new CommandError('this item has no source to reply through');
    // Desk mail is another agent speaking, never the owner: the source is told so (Loom keeps the owner's open ask,
    // their active time and the ask lint's corrections for the owner's own words; TGO-1032 shadow, 10/20).
    const mail = actor === 'agent' ? parseMailHeader(text) : null;
    const origin = mail && (mail.kind === 'from' || mail.kind === 'reply') ? { name: mail.title, from: mail.itemId, mailId: mail.mailId } : null;
    const startedAt = this.now();
    const result = await adapter.reply(item, text, { commandId: cid.commandId, ...(attachments.length ? { attachments } : {}), ...(origin ? { origin } : {}) });
    // Applied only once the source accepted it; a failure leaves the item untouched (the client keeps the draft).
    // A timeout is neither: the words may be out, so the client warns instead of inviting a resend.
    if (!result.ok && result.unknown) throw new CommandError(DELIVERY_UNKNOWN, { delivery: 'unknown', detail: result.error });
    if (!result.ok) throw new CommandError(`reply not delivered: ${result.error}`);
    const at = this.now();
    if (splitByTime(item)) this.relayTargets.set(item.conversationKey, { itemId: item.id, until: at + RELAY_WINDOW_MS });
    // A pictures-only reply still reads as a request ("2 images") wherever the owner's last words are shown.
    const request = attachments.length ? { text: text || `(${imagesWord(attachments.length)})`, at, images: attachments.length, words: Boolean(text) } : { text, at };
    // Desk mail from another agent's conversation: the agent will answer, but it isn't the owner's request,
    // and it never counts as the owner engaging (seen, picked up; Codex review on #575).
    if (mail) {
      this.setFacts(item.id, { lastAuthor: 'owner', lastAuthorMail: true, failed: null }, { lastActivityAt: Math.max(item.lastActivityAt, at) });
      this.refresh(item.id);
      return { delivered: true };
    }
    this.setFacts(item.id, { lastAuthor: 'owner', lastAuthorMail: false, lastOwnerRequest: request, failed: null }, { lastOwnerMessageAt: at, lastActivityAt: Math.max(item.lastActivityAt, at) });
    this.refresh(item.id);
    const event = this.apply(item.id, 'source.owner_posted', actor, { via: 'desk', at, text: request.text, startedAt }, cid);
    return { seq: event.seq, delivered: true };
  }

  /**
   * Sends the owner's answer / approval / dismissal of a pending source request. Applied only once the source
   * accepted it; a request that changed since the client saw it (or since the desk read it) fails
   * with "the question changed" and nothing is sent.
   */
  /**
   * The request an answer on this row goes to: its own pending one, or a brief it carries from another row
   * (withCarriedBriefs), which is answered on the row that raised it. A requestId names which; without one, the
   * row's own question, else the brief it counts.
   */
  private answerTarget(item: DeskItemRow, requestId: unknown): { item: DeskItemRow; pending: PendingRequest } | null {
    const own = item.facts.pending ?? null;
    if (own && (typeof requestId !== 'string' || requestId === own.requestId)) return { item, pending: own };
    const carried = this.item(item.id)?.facts.carried ?? [];
    const entry = typeof requestId === 'string' ? carried.find((c) => c.pending.requestId === requestId) : carried.find((c) => c.counts);
    const source = entry ? this.store.item(entry.from.itemId) : null;
    const sourceBrief = source ? briefOf(source) : null;
    if (source && sourceBrief?.requestId === entry!.pending.requestId) return { item: source, pending: sourceBrief };
    return own ? { item, pending: own } : null;
  }

  private async resolvePending(item: DeskItemRow, resolution: PendingResolution, actor: Actor, cid: { commandId: string }, seenRequestId: unknown): Promise<Record<string, unknown>> {
    if (typeof seenRequestId === 'string' && seenRequestId !== resolution.requestId) throw new CommandError(`${QUESTION_CHANGED} since you saw it`, { changed: true });
    // A brief revised since the owner saw it (TGO-1079): the card shows the new revision; nothing is sent.
    const shownRevision = resolution.kind === 'respond' ? resolution.revision : undefined;
    const own = briefOf(item);
    const current = own?.requestId === resolution.requestId ? own.brief : undefined;
    if (shownRevision !== undefined && current?.revision !== undefined && current.revision !== shownRevision) {
      throw new CommandError(`${QUESTION_CHANGED}: it was updated since you looked${current.updated ? ` (${current.updated.what})` : ''}`, { changed: true });
    }
    // A Discord row showing its agent's Loom records (source-loom.ts linkDiscord): the answer goes to that Loom thread.
    const hiddenKey = `${item.id}|${resolution.requestId}`;
    const raisedBy = this.backedHidden.get(hiddenKey);
    this.backedHidden.delete(hiddenKey);
    const backing = raisedBy ? loomBacking(item, raisedBy)
      : [item.facts.pending, item.facts.openBrief].some((entry) => entry?.requestId === resolution.requestId) ? loomBacking(item) : null;
    const adapter = this.adapterFor(backing ?? item);
    if (!adapter?.resolvePending) throw new CommandError('this item has no source to answer through');
    // Recorded before Loom is asked: its answer turn can reach the desk before the command returns (Codex review on #781).
    const briefKey = resolution.requestId.startsWith('decision:') ? `${item.id}|${resolution.requestId.slice('decision:'.length)}` : null;
    if (briefKey) {
      for (const [key, sent] of this.answeredBriefs) if (this.now() - sent > OWNER_POST_UP_MS) this.answeredBriefs.delete(key);
      this.answeredBriefs.set(briefKey, this.now());
    }
    const result = await adapter.resolvePending(backing ?? item, resolution, { commandId: cid.commandId });
    // Only a definite refusal clears it: on a timeout (unknown) Loom may have taken the answer (Codex review on #781).
    if (!result.ok && briefKey && !result.changed && !result.unknown) this.answeredBriefs.delete(briefKey);
    const what = resolution.kind === 'respond' ? 'answer' : resolution.kind === 'approve' ? 'approval' : 'dismissal';
    if (!result.ok) throw new CommandError(result.changed ? result.error : `${what} not delivered: ${result.error}`, result.changed ? { changed: true } : null);
    const at = this.now();
    // The source resumes the turn: the owner spoke last (Working until the next poll reads the thread).
    // The answered request leaves the row; a live question that took the pending slot while a brief was answered stays.
    const answered = item.facts.pending?.requestId === resolution.requestId || !item.facts.pending;
    this.setFacts(item.id, { ...(answered ? { pending: null } : {}), ...(item.facts.openBrief?.requestId === resolution.requestId ? { openBrief: null } : {}), lastAuthor: 'owner', lastAuthorMail: false, chipAt: at, failed: null }, { lastOwnerMessageAt: at, lastActivityAt: Math.max(item.lastActivityAt, at) });
    this.refresh(item.id);
    const said = resolutionText(resolution, item.facts.pending ?? null);
    const event = this.apply(item.id, 'source.owner_posted', actor, { via: 'desk', at, resolved: resolution.kind, said }, cid);
    return {
      seq: event.seq,
      delivered: true,
      requestId: resolution.requestId,
      ...(resolution.kind === 'respond' ? { answers: resolution.answers } : resolution.kind === 'approve' ? { decision: resolution.decision } : { dismissed: true }),
    };
  }

  /** Where the bot's echo of a desk reply in a home channel belongs (within 10 min of sending). */
  relayTarget(conversationKey: string): string | null {
    const target = this.relayTargets.get(conversationKey);
    if (!target || target.until < this.now() || !this.store.item(target.itemId)) return null;
    this.relayTargets.delete(conversationKey);
    return target.itemId;
  }

  // ── auto-tagging ───────────────────────────────────────────────────────

  /**
   * Guesses a new coding thread's type (Loom) once its opening message is in (desk/autotag.ts).
   * Only threads that start after the desk began guessing, only once, and never
   * over a label the owner set: their labels, confirmed or untouched, are the examples.
   */
  async maybeAutoTag(itemId: string): Promise<void> {
    const tagger = this.options.autoTag;
    const item = this.store.item(itemId);
    if (!tagger || !item || !isCodingThread(item) || this.autoTagging.has(itemId)) return;
    if (labeledYet(item.facts)) return;
    // Set at start; a desk that never started (tests) begins with this thread (Codex review on #515).
    if (this.store.setting('autotag_since') === null) this.store.setSetting('autotag_since', String(item.createdAt));
    if (item.createdAt < Number(this.store.setting('autotag_since'))) return;
    const opening = this.store.firstOwnerText(itemId);
    if (!opening) return;
    this.autoTagging.add(itemId);
    try {
      const guess = await tagger({ repo: item.facts.project?.name ?? item.area ?? null, title: this.threadName(item), opening, examples: this.autoTagExamples(itemId) });
      if (!guess) return;
      // The owner labeled it while the model was thinking: theirs stands.
      const fresh = this.store.item(itemId);
      if (!fresh || labeledYet(fresh.facts)) return;
      const applied = guess.confidence >= AUTOTAG_MIN_CONFIDENCE;
      this.setFacts(itemId, {
        autoTag: { at: this.now(), type: guess.type, confidence: guess.confidence, applied, unconfirmed: applied },
        ...(applied ? { type: guess.type } : {}),
      });
      this.trace('autotag', `${this.traceName(itemId)}: ${guess.type} (${guess.confidence.toFixed(2)})${applied ? '' : ', not applied'}`, { itemId, ...guess, applied });
      this.flush();
    } catch (error) {
      this.log('desk.autotag.error', { itemId, message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.autoTagging.delete(itemId);
    }
  }

  /**
   * Guesses held back under an older, higher bar that clear today's, on threads the owner still hasn't
   * labeled: applied now, with the dot (a new label for them to check). Returns how many.
   */
  applyHeldGuesses(): number {
    let applied = 0;
    for (const item of this.store.items({ sinceMs: 0 })) {
      const guess = item.facts.autoTag;
      if (!isCodingThread(item) || !guess || guess.applied || guess.confidence < AUTOTAG_MIN_CONFIDENCE) continue;
      if (item.facts.type !== undefined) continue;
      this.setFacts(item.id, { autoTag: { ...guess, applied: true, unconfirmed: true }, type: guess.type });
      applied += 1;
    }
    if (applied) {
      this.log('desk.autotag.held-applied', { applied });
      this.flush();
    }
    return applied;
  }

  /** The owner's labeled coding threads, newest first: guesses they haven't looked at yet don't count. */
  private autoTagExamples(exceptId: string): AutoTagExample[] {
    const examples: AutoTagExample[] = [];
    for (const item of this.store.items({ sinceMs: 0 })) {
      if (examples.length >= AUTOTAG_EXAMPLES) break;
      if (item.id === exceptId || !isCodingThread(item) || !item.facts.type || item.facts.autoTag?.unconfirmed) continue;
      const opening = this.store.firstOwnerText(item.id);
      if (opening) examples.push({ title: this.threadName(item), opening, type: item.facts.type });
    }
    return examples;
  }

  /** A coding thread's own title: the place after its repo, without an old label prefix. */
  private threadName(item: DeskItemRow): string {
    const name = (item.place ?? '').split(' · ').slice(1).join(' · ').replace(/^\s*[a-z]+:(?!\/\/)\s*/i, '');
    return name || this.title(item);
  }

  /** Only an explicit label choice confirms the model's type guess (owner, 10/20). */
  private confirmAutoTag(itemId: string): void {
    const autoTag = this.store.item(itemId)?.facts.autoTag;
    if (autoTag?.unconfirmed) this.setFacts(itemId, { autoTag: { ...autoTag, unconfirmed: false } });
  }

  // ── summaries ──────────────────────────────────────────────────────────

  scheduleSummary(itemId: string, options: { keepPending?: boolean } = {}): void {
    const existing = this.pendingSummaries.get(itemId);
    // A summary already on the way (or running) for this item covers it.
    if (options.keepPending && (existing || this.summaryRuns.has(itemId))) return;
    if (existing) clearTimeout(existing);
    // An agent posting every few seconds through a turn kept pushing its summary back until the turn ended,
    // so "You asked" and the gist stayed on the request before for as long as it worked.
    const now = this.now();
    const since = existing ? (this.summaryDueSince.get(itemId) ?? now) : now;
    this.summaryDueSince.set(itemId, since);
    const delay = this.options.summaryDelayMs ?? 8000;
    const timer = setTimeout(
      () => {
        this.pendingSummaries.delete(itemId);
        this.summaryDueSince.delete(itemId);
        void this.summarizeNow(itemId);
      },
      Math.max(0, Math.min(delay, since + Math.max(delay, SUMMARY_MAX_WAIT_MS) - now)),
    );
    timer.unref?.();
    this.pendingSummaries.set(itemId, timer);
  }

  /** Summarizes now (two at a time). Resolves once the result is written or dropped. */
  summarizeNow(itemId: string): Promise<void> {
    const pending = this.pendingSummaries.get(itemId);
    if (pending) {
      clearTimeout(pending);
      this.pendingSummaries.delete(itemId);
      this.summaryDueSince.delete(itemId);
    }
    const run = this.withSlot(() => this.summarize(itemId)).finally(() => this.summaryRuns.delete(itemId));
    this.summaryRuns.set(itemId, run);
    return run;
  }

  /** Waits for every scheduled and running summary (tests). */
  async drainSummaries(): Promise<void> {
    for (const itemId of [...this.pendingSummaries.keys()]) void this.summarizeNow(itemId);
    while (this.summaryRuns.size) await Promise.all([...this.summaryRuns.values()]);
  }

  private async withSlot<T>(work: () => Promise<T>): Promise<T> {
    while (this.summaryRunning >= 2) await new Promise<void>((resolve) => this.summaryWaiters.push(resolve));
    this.summaryRunning += 1;
    try {
      return await work();
    } finally {
      this.summaryRunning -= 1;
      this.summaryWaiters.shift()?.();
    }
  }

  /**
   * What the threads working under this one (its workers, and theirs) posted to the feed since it last posted, or in
   * the last few hours when it never has: newest first, a few (Codex review on #910). Empty for a thread with no workers.
   */
  private workersPosted(itemId: string): Array<{ title: string; text: string }> {
    const feed = this.options.feed;
    if (!feed) return [];
    const roles = this.roles.all();
    const under = new Set<string>();
    let level = [itemId];
    for (let depth = 0; depth < 3 && level.length; depth += 1) {
      const next = [...roles].filter(([id, role]) => role.parentItemId && level.includes(role.parentItemId) && id !== itemId && !under.has(id)).map(([id]) => id);
      for (const id of next) under.add(id);
      level = next;
    }
    if (!under.size) return [];
    // Since the lead's own last post, however old (a lead back after a day retells what its workers said meanwhile).
    const mark = feed.lastPostMark(`thread:${itemId}`);
    return feed.postedSince([...under].map((id) => `thread:${id}`), mark?.at ?? this.now() - FEED_RECENT_MS, 8, mark?.rev, [...under]).map(({ title, text }) => ({ title, text }));
  }

  private async summarize(itemId: string): Promise<void> {
    const item = this.store.item(itemId);
    if (!item) return;
    // The last six, or everything since the previous summary (up to 20): with earlier state carried in,
    // the words that settled it must not fall out of the window.
    // Counted by the content key's message count, not timestamps: a poll can file older words after the summary.
    const covered = Number((item.summary?.contentKey ?? '').split(':').at(-1));
    const since = item.summary && Number.isFinite(covered) ? item.messageCount - covered : 0;
    // A post that is only images is the agent speaking too: the summary sees that it sent them (Codex review on #526).
    const messages = this.store
      .messages(itemId, Math.min(20, Math.max(6, since)))
      .map((message) => (message.text || !message.attachments?.length ? message : { ...message, text: message.attachments.map((a) => `[image: ${a.name}]`).join(' ') }))
      .filter((message) => message.text);
    if (messages.length === 0) return;
    void this.maybeAutoTag(itemId);
    const contentKey = item.facts.contentKey ?? '';
    // Open questions carry forward only while the owner hasn't written since they were asked: once they reply
    // (or move on to something else), only what the agent asks now counts (live 10/09: a question the owner
    // had moved past stayed on the card for hours).
    // Counted like `since`: the messages filed after that summary, by ingestion order (a late poll can file
    // an owner reply with an older timestamp; Codex review on #443).
    const ownerSince = !!item.summary && this.store.ownerInLastFiled(itemId, since);
    // What the owner last heard: the words of the last summary that posted to the feed (its paragraph when it posted
    // one). Null when nothing has posted yet (a text fallback while the model was down, a hidden item). A summary from
    // before v14 kept no record: the thread's last feed post stands in, whatever that summary was (its own words may
    // never have posted: a text fallback after a post that did). Once the feed has let that post go (it keeps two
    // weeks; the start-time re-summary reaches back 30 days), a model summary's own feed text, which posted under the
    // old rule; nothing for a text fallback (Codex reviews on #886 and #905).
    const lastPosted = item.summary
      ? item.summary.postedGist !== undefined
        ? item.summary.postedGist
        : (this.options.feed?.lastWords(`thread:${itemId}`) ?? (item.summary.source === 'model' ? item.summary.paragraph || item.summary.gist : null))
      : null;
    // The earlier state keeps the previous summary's own words (progress a text fallback caught between posts stays in
    // view) and says what the owner last heard, so a run of small restatements is judged against the last post, never
    // against each other (Codex review on #886).
    const previous = item.summary
      ? ownerSince
        ? // The owner has replied since: the earlier ask and its questions are no longer open (Codex review on #443).
          { step: item.summary.step, gist: item.summary.gist, ask: null, goal: item.summary.goal ?? null, milestone: item.summary.milestone ?? null, questions: [], ownerReplied: true, heard: lastPosted }
        : { step: item.summary.step, gist: item.summary.gist, ask: item.summary.ask, goal: item.summary.goal ?? null, milestone: item.summary.milestone ?? null, questions: item.summary.questions ?? [], heard: lastPosted }
      : null;
    const kind = this.kindOf(item);
    // Work notes since the owner last wrote: the agent's freshest word on where things stand.
    const workNotes = (item.facts.workNotes ?? []).filter((note) => note.at > (item.lastOwnerMessageAt ?? 0));
    // Which notes this summary covers: the newest the desk knew when it asked, not when the answer came back.
    const notesCovered = item.facts.workNotes?.at(-1)?.at ?? null;
    // A lead's workers post their own news; the lead's next turn often retells it (live 10/20: a lead posting every
    // seven minutes, each a roll-up of what its workers had just posted). What they posted since the lead last did is
    // what the owner already heard from them, so the summary judges the lead's news against it too.
    const workersPosted = this.workersPosted(itemId);
    const input = { itemId, agentName: item.agentName, place: item.place, messages: messages.map((message) => (mailOf(message) ? { author: 'other' as const, text: `(Mail from another agent's conversation, not the owner) ${mailBodyOf(message)}` } : { author: message.author, text: message.text })), previous, kind, ...(workNotes.length ? { workNotes } : {}), ...(workersPosted.length ? { workersPosted } : {}) };
    let output;
    try {
      output = await this.options.summarize(input);
    } catch {
      output = fallbackSummary(input);
    }
    // Words arrived while the model was thinking: this summary is stale. Dropped, and rescheduled
    // for the new words (writing a summary never schedules one: the key only moves with new words).
    const fresh = this.store.item(itemId);
    if (!fresh) return;
    // Likewise a rules edit that changed the item's kind while the model was thinking, or a worker posting meanwhile
    // (two summaries run at once), or one retitled: the lead would tell that news again unseen (Codex review on #910).
    const workersNow = this.workersPosted(itemId);
    const workersMoved = workersNow.length !== workersPosted.length || workersNow.some((post, i) => post.text !== workersPosted[i]!.text || post.title !== workersPosted[i]!.title);
    if ((fresh.facts.contentKey ?? '') !== contentKey || this.kindOf(fresh) !== kind || workersMoved) {
      if (!this.pendingSummaries.has(itemId)) this.scheduleSummary(itemId);
      return;
    }
    // The news feed keeps what this summary says happened, in its own words (the summary is overwritten next time).
    // A thread's first summary is its start; updates close together on one thread are one post.
    // Only new words are news: a re-summary of the same words (a prompt-version bump at start) isn't.
    // ...and only on a thread active lately: summarizing a backfill of old threads isn't news either.
    const newWords = (!item.summary?.version || item.summary.contentKey !== contentKey) && this.now() - (fresh.lastActivityAt ?? 0) <= FEED_RECENT_MS;
    // Posted below, once the refresh says whether the thread is still at work.
    // ...and only when the summary says something happened: a thread saying where it stands again in other words (a
    // reply to another agent's mail, a wake that found nothing) isn't news either (live 10/20: one thread posted
    // "built, awaiting review" three times in 21 minutes). Judged against the earlier state, so a first summary is news.
    // Only words the owner has heard can be restated: with nothing posted yet, the first real summary posts.
    const restated = !!previous && lastPosted !== null && output.whatsNew === null;
    // ...and only once the agent has answered: the owner's own words, retold before any reply, aren't news to them
    // (live 10/21: the owner's own note, retold as "…the agent hasn't answered yet", posted as an update). The reply's summary posts.
    const news = output.source === 'model' && output.gist && output.gist !== item.summary?.gist && newWords && !restated && !fresh.hidden && !this.store.ownerHasLastWord(itemId);
    // ...and not a recurring run that only started, came back as before, or woke to find nothing to do: having run isn't
    // news (live 10/23: one delivery monitor posted 86 times in a day, "check running", "check done, gaps remain").
    // ...and not a worker's own progress while its lead reports for it: the lead tells that work once (live 10/23: a
    // third of the day's updates were workers', then retold by their leads). Its Needs you, Failed and Shipped still post.
    const held = !news ? null : output.routine ? 'routine' : this.reportsToLead(itemId) ? 'lead' : null;
    if (held) this.trace('feed.held', `${this.traceName(itemId)}: ${held === 'routine' ? 'a routine run' : 'its lead reports it'}`, { itemId, reason: held, headline: output.headline ?? null });
    // A Summary the thread's own ledger words stand in for isn't heard: what the owner last heard stays (Codex review on #943).
    const posts = !!news && !held && this.summaryPosts(itemId);
    // A text fallback (model down) isn't stamped current: the next start asks the model again.
    this.store.patchItem(itemId, { summary: { ...output, title: output.title || fallbackSummary(input).title, kind, contentKey, at: this.now(), version: output.source === 'model' ? SUMMARY_VERSION : 0, notesAt: notesCovered, postedGist: posts ? output.paragraph || output.gist : lastPosted } });
    // A work note arrived while the model was thinking: this summary doesn't cover it, so another follows (Codex review on #447).
    if ((fresh.facts.workNotes?.at(-1)?.at ?? null) !== notesCovered && !this.pendingSummaries.has(itemId)) this.scheduleSummary(itemId);
    this.changed.add(itemId);
    const deferred = this.deferred.get(itemId);
    this.summarizingFeed = posts ? itemId : null;
    let result;
    try {
      result = this.refresh(itemId, { emitStep: !deferred });
    } finally {
      this.summarizingFeed = null;
    }
    if (posts) {
      // The summary's headline heads the post (never an ask: the summarizer writes it as news), else the
      // thread's name; the paragraph (the List's preview) says what happened. A thread still at work posts
      // at most every few minutes, its newest words held till then; finished or waiting on the owner, at once.
      // A new thread, a turn to the owner or Done just posted for it takes these words as one post.
      // Always an update: a summary never carries a status pill. A row entering Needs you or Failed posts from
      // status.entered (flush), and that post takes these words by their content key (feed.ts merge).
      this.postFeed({
        kind: 'update',
        itemId,
        projectId: item.facts.projectId ?? null,
        agentName: item.agentName,
        title: output.headline || this.title(fresh),
        text: output.paragraph || output.gist,
        data: { update: true, summary: true, contentKey, ...(output.headline ? { headline: true } : {}) },
        key: `thread:${itemId}`,
        mergeMs: FEED_MERGE_MS,
        // Every summary is throttled; the feed lets a change of state through at once.
        throttleMs: FEED_WORKING_EVERY_MS,
      });
    }
    if (deferred && deferred.contentKey === contentKey) {
      this.deferred.delete(itemId);
      // Decided again while the model thought (marked Done, dropped in the sweep): that decision stands (Codex review on #526).
      // With the message's own time, so words the owner already heard stay heard; then the quiet rule, as for any activity.
      if (this.attention(itemId).updatedAt === deferred.decidedAt) {
        this.apply(itemId, 'source.activity', 'agent', { what: 'message', step: result.step, deferred: true, ...(deferred.at !== undefined ? { at: deferred.at } : {}) });
        this.applyQuietRule(itemId);
      }
    }
    this.flush();
  }

  // ── timers ─────────────────────────────────────────────────────────────

  /** The desk screen showed up: after ≥ 10 min with no screen, snoozes "until I'm at my desk" fire. */
  /** Calls `listener` whenever the owner shows activity (a desk ping or command, or a voice command). */
  onOwnerActivity(listener: (at: number, source: string) => void): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  private noteOwnerActivity(source: string, at = this.now()): void {
    for (const listener of this.activityListeners) listener(at, source);
  }

  noteScreenActivity(): string[] {
    this.noteOwnerActivity('desk');
    const now = this.now();
    const idle = now - this.lastScreenAt >= (this.options.deskIdleMs ?? 10 * 60_000);
    this.lastScreenAt = now;
    return idle ? this.deskBecameActive() : [];
  }

  deskBecameActive(): string[] {
    const fired: string[] = [];
    this.wakeProjects('desk');
    for (const item of this.store.items()) {
      const attention = this.store.attention(item.id);
      if (attention?.disposition === 'snoozed' && attention.snoozeTrigger === 'desk') {
        this.apply(item.id, 'snooze.expired', 'system', { reason: 'desk' });
        fired.push(item.id);
      }
    }
    this.flush();
    return fired;
  }

  /** One pass of every timer. Safe to call any time; start() runs it every 30 s. */
  tick(): { expired: string[]; settled: string[]; sweep: string[] | null } {
    const now = this.now();
    const expired: string[] = [];
    const settled: string[] = [];
    // An edited rules file applies to everything already on the desk, not only to items that change.
    const rulesVersion = this.options.rules?.version() ?? null;
    // The first tick also applies them: the file may have been edited while the service was down.
    if (rulesVersion !== null && rulesVersion !== this.rulesVersion) {
      this.rulesVersion = rulesVersion;
      for (const item of this.store.items()) {
        this.refresh(item.id);
        // A thread newly marked (or unmarked) as a report is read again under its rule; finished ones wait for new words.
        if (item.summary && (item.summary.kind ?? null) !== this.kindOf(item) && this.store.attention(item.id)?.disposition !== 'done') this.scheduleSummary(item.id);
      }
      this.log('desk.rules.reapplied', {});
    }
    // A project's own snooze running out: its conversations are no longer held.
    this.wakeProjects('time');
    for (const item of this.store.items()) {
      const attention = this.attention(item.id);
      // Local snooze (time).
      if (attention.disposition === 'snoozed' && attention.snoozeUntil !== null && attention.snoozeUntil <= now) {
        this.apply(item.id, 'snooze.expired', 'system', { reason: 'time' });
        expired.push(item.id);
        continue;
      }
      // The source's own snooze, kept apart: it returns the item once, when it runs out.
      const sourceUntil = item.facts.sourceSnoozedUntil;
      if (sourceUntil && sourceUntil <= now && this.store.marker(`srcsnooze:${item.id}`) !== String(sourceUntil)) {
        this.store.setMarker(`srcsnooze:${item.id}`, String(sourceUntil));
        if (attention.disposition === 'active') {
          this.apply(item.id, 'snooze.expired', 'system', { reason: 'source' });
          expired.push(item.id);
        }
        this.store.bumpRevision(item.id);
        this.changed.add(item.id);
      }
      if (attention.disposition === 'done') continue;
      // Overdue waits, stale turns, the owner's last word ageing out.
      const result = this.refresh(item.id, { emitStep: true });
      this.maybeWakeOverdue(item.id, result);
      if (splitByTime(item) && !this.isStanding(item) && attention.disposition === 'active' && this.maySettle(item, result, now)) {
        this.apply(item.id, 'chapter.settled', 'system', { idleMs: now - this.lastBusyAt(item) });
        settled.push(item.id);
      }
    }
    const sweep = this.maybeSweep();
    this.flush();
    return { expired, settled, sweep };
  }

  /** The latest sign of life: words, turn activity, a running turn, a background job. */
  private lastBusyAt(item: DeskItemRow): number {
    const fresh = this.store.item(item.id) ?? item;
    return Math.max(fresh.lastActivityAt, fresh.activity?.at ?? 0, fresh.facts.running?.lastAt ?? 0, fresh.facts.running?.since ?? 0, fresh.facts.job?.startedAt ?? 0);
  }

  /**
   * Chapter auto-settle: only a chapter with nothing going on. FYI settles; recorded waits stay open.
   * Never while a turn runs, a job runs or a wait is armed; never your move or
   * failed; never again after the owner undid a settle, until something new happens.
   */
  private maySettle(item: DeskItemRow, result: StepResult, now: number): boolean {
    const fresh = this.store.item(item.id) ?? item;
    // Legacy wording-based ask resolution cannot close a recorded ask.
    if (result.step === 'your_move' || result.step === 'failed' || result.step === 'working' || result.step === 'watching') return false;
    if (fresh.facts.running || fresh.facts.job || result.watching?.waitingOn) return false;
    const busyAt = this.lastBusyAt(fresh);
    if (now - busyAt < this.chapterGapMs) return false;
    const undoneAt = Number(this.store.marker(`nosettle:${item.id}`) ?? 0);
    if (undoneAt && busyAt <= undoneAt) return false;
    return true;
  }

  /** Every row's ask as the cross-row pass last saw it (desk/asks.ts), keyed by item id; active rows only count. */
  private readonly askIndex = new Map<string, AskEntry & { stored: AskRecord | null }>();
  /** Rows being refreshed because another row's ask changed theirs: never cascade from a cascade. */
  private cascadingAsks = false;

  /**
   * Places one row's ask among every other's: superseded by a newer chapter of its conversation, or a
   * duplicate of the newest row with the same words (desk/asks.ts resolveAsks). Other rows whose state
   * that changes (the old representative, an older chapter) are refreshed once, right away.
   */
  private resolveAsk(item: DeskItemRow, record: AskRecord | null): AskRecord | null {
    const attention = this.store.attention(item.id);
    const active = (attention?.disposition ?? 'active') === 'active' && !item.hidden;
    if (record || item.kind === 'chapter') this.askIndex.set(item.id, { itemId: item.id, conversationKey: item.conversationKey, kind: item.kind, createdAt: item.createdAt, active, ask: record, stored: record });
    else this.askIndex.delete(item.id);
    const resolved = resolveAsks([...this.askIndex.values()]);
    const own = record ? { ...record, ...(resolved.get(item.id) ?? {}) } : null;
    const entry = this.askIndex.get(item.id);
    if (entry) entry.stored = own;
    if (!this.cascadingAsks) {
      const stale: string[] = [];
      for (const other of this.askIndex.values()) {
        if (other.itemId === item.id || !other.stored) continue;
        const want = resolved.get(other.itemId);
        if (want && (want.state !== other.stored.state || (want.of ?? null) !== (other.stored.of ?? null))) stale.push(other.itemId);
      }
      if (stale.length) {
        this.cascadingAsks = true;
        try {
          for (const id of stale) if (this.store.item(id)) this.refresh(id);
        } finally {
          this.cascadingAsks = false;
        }
      }
    }
    return own;
  }

  /** Overdue check-backs being woken right now, so two ticks never send two messages. */
  private readonly wakingOverdue = new Set<string>();

  /**
   * The agent's own check-back is late (it promised an update and went quiet): the desk wakes it with what it
   * said, once per episode, so the owner never has to (owner, 10/18). A slow person or agent is not woken: that
   * wait is theirs, and the row offers the owner a Nudge. A job (ops) runs on its schedule and is left alone.
   */
  private maybeWakeOverdue(itemId: string, result: StepResult): void {
    const overdue = result.watching?.overdue;
    if (!overdue || overdue.kind !== 'check-back' || this.wakingOverdue.has(itemId)) return;
    const item = this.store.item(itemId);
    if (!item || item.facts.role === 'ops' || item.facts.overdueWoke?.since === overdue.since) return;
    if (this.store.attention(itemId)?.disposition !== 'active') return;
    this.wakingOverdue.add(itemId);
    void this.command({ commandId: randomUUID(), type: 'reply', itemId, actor: 'system', args: { text: overdueWakeText(overdue) } })
      .then((outcome) => {
        this.log('desk.overdue.wake', { itemId, kind: overdue.kind, since: overdue.since, status: outcome.status, ...(outcome.error ? { error: outcome.error } : {}) });
        this.trace('wait.woke', `${this.traceName(itemId)}: woke the agent for a late check-back (${outcome.status})`, { itemId, since: overdue.since, status: outcome.status, ...(outcome.error ? { error: outcome.error } : {}) });
        // One attempt per episode, delivered or not: a failed wake is in the log, and the row still says overdue.
        this.setFacts(itemId, { overdueWoke: { since: overdue.since, at: this.now(), status: outcome.status } });
        this.flush();
      })
      .catch((err) => this.log('desk.overdue.wake.error', { itemId, message: (err as Error).message }))
      .finally(() => this.wakingOverdue.delete(itemId));
  }

  /** desk_settings waiting_nudge_hours (default 48): when a wait on a person is overdue. */
  waitingNudgeMs(): number {
    const hours = Number(this.store.setting('waiting_nudge_hours'));
    return (Number.isFinite(hours) && hours > 0 ? hours : 48) * 3_600_000;
  }

  sweepDay(): 'saturday' | 'monday' {
    return this.store.setting('sweep_day') === 'monday' ? 'monday' : 'saturday';
  }

  /** The weekly sweep: once per sweep time, collect parked items and active ones untouched for a week. */
  private maybeSweep(): string[] | null {
    const now = this.now();
    const due = latestSweepTime(now, this.sweepDay());
    const last = Number(this.store.setting('sweep_last') ?? 0);
    if (last >= due) return null;
    // First start: don't sweep for a time that passed before the desk existed.
    if (!this.store.setting('sweep_last')) {
      this.store.setSetting('sweep_last', String(due));
      return null;
    }
    const candidates = this.store
      .deskItems()
      .filter((item) => !this.isStanding(item))
      .filter((item) => item.disposition === 'parked' || (item.disposition === 'active' && now - Math.max(item.attentionUpdatedAt, item.lastActivityAt) >= SWEEP_UNTOUCHED_MS))
      .map((item) => item.id);
    this.store.setSetting('sweep_last', String(due));
    this.store.setSetting('sweep_pending', JSON.stringify({ at: due, itemIds: candidates }));
    this.log('desk.sweep', { candidates: candidates.length });
    return candidates;
  }

  pendingSweep(): { at: number; itemIds: string[] } | null {
    const raw = this.store.setting('sweep_pending');
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { at: number; itemIds: string[] };
      // From the store's reused item list, not a read per id: every list request asks (desk/stalls.ts).
      const known = new Set(this.store.deskItems().map((item) => item.id));
      const itemIds = parsed.itemIds.filter((id) => known.has(id));
      return itemIds.length ? { at: parsed.at, itemIds } : null;
    } catch {
      return null;
    }
  }

  private removeFromSweep(itemId: string): void {
    const pending = this.pendingSweep();
    if (!pending) return;
    this.store.setSetting('sweep_pending', JSON.stringify({ at: pending.at, itemIds: pending.itemIds.filter((id) => id !== itemId) }));
  }

  prune(): string[] {
    const removed = this.store.prune(this.options.keepMs ?? 30 * 86_400_000);
    for (const id of removed) this.wordsCache.delete(id);
    if (removed.length) this.log('desk.prune', { removed: removed.length });
    return removed;
  }

  start(): void {
    this.recoverCommands();
    // Auto-tagging guesses only for threads started from now on (the first start with it turned on);
    // a start with it off forgets the cutoff, so turning it back on starts fresh (Codex review on #515).
    if (!this.options.autoTag) this.store.deleteSetting('autotag_since');
    else if (this.store.setting('autotag_since') === null) this.store.setSetting('autotag_since', String(this.now()));
    if (this.options.autoTag) this.applyHeldGuesses();
    // Done, Park and Snooze from the owner read the thread since 10/17: replayed once so the ones already put away
    // read Ready too (a rule's or the system's stay as they were).
    if (!this.store.setting('away_read_v1')) {
      const ids = this.store.awayUnread();
      const read = ids.filter((id) => this.rebuildAttention(id).seen === 'seen').length;
      this.store.setSetting('away_read_v1', String(this.now()));
      this.log('desk.away_read.migrated', { checked: ids.length, read });
    }
    // When mail last came in, and the owner's last word without mail, for workers on older desks (#710). Status no
    // longer reads them (a worker never needs the owner since 10/18), but they're kept true. Worked out once.
    if (!this.store.setting('worker_mail_in_v1')) {
      let filed = 0;
      for (const [itemId, role] of this.roles.all()) {
        if (role.role !== 'worker' || !this.store.item(itemId)) continue;
        const owner = this.store.messages(itemId, 100_000).filter((message) => message.author === 'owner');
        const mailAt = Math.max(0, ...owner.filter((message) => mailOf(message)).map((message) => message.at));
        const directAt = Math.max(0, ...owner.filter((message) => !mailOf(message)).map((message) => message.at));
        this.setFacts(itemId, { lastMailInAt: mailAt || null }, { lastOwnerMessageAt: directAt || null });
        filed++;
      }
      this.store.setSetting('worker_mail_in_v1', String(this.now()));
      this.log('desk.worker_mail_in.migrated', { workers: filed });
    }
    // Views saved before projects filtered and grouped T3 workspaces as `project`: renamed once to `workspace`.
    if (!this.store.setting('list_views_workspace_v1')) {
      try {
        const views = viewsWithWorkspaces(JSON.parse(this.store.setting('list_views') ?? 'null'));
        if (views) {
          this.store.setSetting('list_views', JSON.stringify(views));
          this.log('desk.list_views.migrated', { to: 'workspace' });
        }
      } catch {
        /* unreadable: readListViews already falls back to the built-in views */
      }
      this.store.setSetting('list_views_workspace_v1', '1');
    }
    // Views saved before the To-dos built-in never show it (saved views replace the built-ins): added once, after
    // the owner's-move view (owner, 10/18: the list exists, so it has to be where they look).
    if (!this.store.setting('list_views_todos_v1')) {
      try {
        const views = viewsWithTodos(JSON.parse(this.store.setting('list_views') ?? 'null'));
        if (views) {
          this.store.setSetting('list_views', JSON.stringify(views));
          this.log('desk.list_views.migrated', { to: 'todos' });
        }
      } catch {
        /* unreadable: readListViews already falls back to the built-in views */
      }
      this.store.setSetting('list_views_todos_v1', '1');
    }
    if (!this.store.setting('list_views_inbox_v1')) {
      try {
        const views = viewsWithInboxTabs(JSON.parse(this.store.setting('list_views') ?? 'null'));
        if (views) this.store.setSetting('list_views', JSON.stringify(views));
      } catch { /* unreadable views fall back to built-ins */ }
      this.store.setSetting('list_views_inbox_v1', '1');
    }
    // Type filters named old prefixes: keep what maps to a type (epic → project), drop prefixes without a type.
    const filters = readFilters(this.store);
    const types = [...new Set(filters.hideTypes.map((t) => ((ITEM_TYPES as readonly string[]).includes(t) ? t : (LEGACY_LABELS[t]?.type ?? null))).filter((t): t is string => !!t))];
    if (types.length !== filters.hideTypes.length || types.some((t, i) => t !== filters.hideTypes[i])) {
      writeFilters(this.store, { ...filters, hideTypes: types });
      this.log('desk.filters.migrated', { from: filters.hideTypes, to: types });
    }
    // Deferred reopen decisions survive a restart: their summaries run again and decide. One from
    // before `decidedAt` can't tell whether the owner decided since, so it goes (Codex review on #526).
    for (const itemId of this.deferred.itemIds()) {
      if (this.store.item(itemId) && this.deferred.get(itemId)?.decidedAt !== undefined) this.scheduleSummary(itemId);
      else this.deferred.delete(itemId);
    }
    // A changed summary prompt rewrites what the owner is looking at now, and what a snoozed or parked
    // item brings back with it (coming back to Active without new words never re-summarizes).
    for (const item of this.store.items({ sinceMs: this.now() - 30 * 86_400_000 })) {
      if (!item.summary || (item.summary.version ?? 0) >= SUMMARY_VERSION) continue;
      const disposition = this.store.attention(item.id)?.disposition;
      if (disposition && disposition !== 'done') this.scheduleSummary(item.id);
    }
    this.timers.push(setInterval(() => void this.checkOrphanTurns().catch((err) => this.log('desk.orphans.error', { message: (err as Error).message })), 60_000));
    this.timers.push(setInterval(() => this.safely('tick', () => this.tick()), 30_000));
    this.timers.push(setInterval(() => this.safely('prune', () => this.prune()), 3_600_000));
    for (const timer of this.timers) timer.unref?.();
    this.safely('tick', () => this.tick());
  }

  private safely(name: string, work: () => unknown): void {
    try {
      work();
    } catch (err) {
      this.log(`desk.${name}.error`, { message: (err as Error).message });
    }
  }

  close(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const timer of this.pendingSummaries.values()) clearTimeout(timer);
    this.pendingSummaries.clear();
    this.summaryDueSince.clear();
  }

  // ── reading ────────────────────────────────────────────────────────────

  item(id: string): DeskItem | null {
    return this.readItems().find((item) => item.id === id) ?? null;
  }

  /** The space a conversation lives in (`project:<id>`, `agent:<id>`); null for the owner's own. */
  spaceOfItem(item: DeskItem): string | null {
    return querySpaceOf(item, { projects: readProjects(this.store.setting('projects')) });
  }

  /**
   * Why `parentId` can't be who a worker or job in `space` reports to, or null when it can: an open conversation in
   * that space, a project or agent around it, or the owner's own (docs/specs/spaces.md, Two relations).
   */
  reportTargetError(parentId: string, space: string | null): string | null {
    const parent = this.item(parentId);
    if (!parent || parent.disposition === 'done') return 'the conversation it reports to isn’t open on the desk';
    const projects = readProjects(this.store.setting('projects'));
    const around = new Set<string | null>([space, null]);
    for (let at = space, hops = 0; at?.startsWith('project:') && hops < 4; hops += 1) {
      const up = projects.find((p) => p.id === at!.slice(8))?.parent ?? null;
      around.add(up);
      at = up;
    }
    return around.has(querySpaceOf(parent, { projects })) ? null : 'it can only report to a conversation in its own space, or one around it';
  }

  /** Facts that place a conversation in its picked owner's space. */
  spaceFactsOf(ownerId: string) {
    const owner = this.item(ownerId);
    if (!owner || owner.disposition === 'done') throw new CommandError('the conversation it reports to isn’t open on the desk');
    const space = this.spaceOfItem(owner);
    if (space?.startsWith('project:')) return { projectId: space.slice(8) };
    return { projectId: null, agentSpace: space?.startsWith('agent:')
      ? { id: space.slice(6), name: owner.facts.agentSpace?.name || owner.agentName }
      : null };
  }

  /** A space's open default (an agent's chat for an agent's space): where a worker goes when its owner can't take it. */
  spaceLead(space: string | null): string | null {
    if (!space) return null;
    const open = this.items().filter((i) => i.disposition !== 'done' && kindOf(i) === 'default' && this.spaceOfItem(i) === space);
    return open.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0]?.id ?? null;
  }

  /** The rows that carry the open brief the row `sourceId` raised (desk/asks.ts carryBriefs): the brief page's "carried by". */
  carriedBy(sourceId: string): string[] {
    this.readItems();
    return [...(this.carriersBySource.get(sourceId) ?? [])];
  }

  /** `item(id)` for several ids at once, in their order; unknown ids are left out. */
  itemsByIds(ids: string[]): DeskItem[] {
    const byId = new Map(this.readItems().map((item) => [item.id, item]));
    return ids.flatMap((id) => { const item = byId.get(id); return item ? [item] : []; });
  }

  items(): DeskItem[] {
    // A project's coordinator thread is its resource: no row, no count.
    const coordinators = coordinatorItemIds(this.store.setting('coordinators'));
    return this.readItems().filter((item) => !coordinators.has(item.id));
  }

  /** The last readItems(), reused until an item, its attention, a setting or a role changes, or 5s pass. */
  private readCache: { key: string; items: DeskItem[] } | null = null;

  /** All read paths share the role overlay and live worker decisions (owner, 10/18). */
  private readItems(): DeskItem[] {
    // Roles live in their own tables (a set role or a started worker), so they're part of the key.
    const roles = this.roles.all();
    const rolesKey = [...roles].map(([id, r]) => `${id}:${r.role}:${r.parentItemId ?? ''}`).join(',');
    const key = `${this.store.listStamp()}|${Math.floor(this.now() / 5000)}|${rolesKey}`;
    if (this.readCache?.key !== key) this.readCache = { key, items: this.buildItems(roles) };
    return this.readCache.items;
  }

  private buildItems(roles: ReturnType<DeskRoles['all']>): DeskItem[] {
    const projects = readProjects(this.store.setting('projects'));
    const accounts = new Map((this.options.adapters ?? []).flatMap((adapter) => [...(adapter.accounts?.() ?? [])]));
    const items = this.store.deskItems().map((item) => item.source === 'loom'
      ? { ...item, facts: { ...item.facts, account: accounts.get(item.id) ?? null } }
      : item);
    const held = projects.some((p) => p.away) ? items.map((item) => this.withProjectHold(item, projects)) : items;
    const live = new Set(held.filter((item) => item.disposition !== 'done').map((item) => item.id));
    const heldById = new Map(held.map((item) => [item.id, item]));
    // A job reports through any jobs above it to the first conversation that isn't one (as carryBriefs does).
    const jobLead = (item: DeskItem): DeskItem | undefined => {
      let at = item.facts.parentItemId ? heldById.get(item.facts.parentItemId) : undefined;
      for (let hops = 0; at && hops < 8; hops += 1) {
        if (roles.get(at.id)?.role !== 'ops') return at;
        at = roles.get(at.id)?.parentItemId ? heldById.get(roles.get(at.id)!.parentItemId!) : undefined;
      }
      return undefined;
    };
    const leadOf = new Map<string, string>();
    const overlaid = held.map((item) => {
      const row = this.withRole(item, roles, (id) => live.has(id));
      row.facts = { ...row.facts, standing: this.isStanding(row) };
      if (!['worker', 'ops'].includes(row.facts.role ?? '') || !row.facts.parentItemId) return row;
      const lead = jobLead(row);
      // A job's ordinary ask needs the same escape as its brief when its lead is away (owner, 10/20).
      if (!lead || lead.disposition !== 'active' || lead.hidden || lead.facts.stoppedAtSource || ['failed', 'unknown'].includes(deskStatus(lead, this.now()).pill)) {
        return { ...row, facts: { ...row.facts, leadAway: { itemId: lead?.id ?? row.facts.parentItemId, title: lead?.place || 'its lead' } } };
      }
      leadOf.set(row.id, lead.id);
      return row;
    });
    const parents = new Set(overlaid.filter((item) => live.has(item.id) && item.facts.role !== 'ops').map((item) => item.id));
    const asks = new Map<string, { count: number; latestAt: number; ids: string[] }>();
    const byId = new Map(overlaid.map((item) => [item.id, item]));
    for (const worker of overlaid) {
      const parent = worker.facts.role === 'ops' ? leadOf.get(worker.id) : worker.facts.parentItemId;
      if (!['worker', 'ops'].includes(worker.facts.role ?? '') || !parent || !parents.has(parent) || worker.disposition !== 'active' || worker.hidden) continue;
      // A decision brief travels up whole (the lead carries it; withCarriedBriefs): not an ask for the lead to relay.
      if (worker.facts.pending?.brief) continue;
      // The worker's own ask, read as if it spoke to the owner (no role, no starter): what its lead must relay.
      const status = deskStatus({ ...worker, facts: { ...worker.facts, role: 'interactive', parentItemId: null } }, this.now());
      if (status.move !== 'needs' && status.move !== 'ready') continue;
      const at = worker.askRecord?.at ?? this.wordsOf(worker).lastAgent?.at ?? 0;
      // The lead replied after it: handled (answered, absorbed or passed up in those words). Only newer ones wait on it;
      // a tie doesn't prove the reply came second, so it still counts.
      const lead = byId.get(parent);
      if (lead && at < (this.wordsOf(lead).lastAgent?.at ?? 0)) continue;
      const fact = asks.get(parent) ?? { count: 0, latestAt: 0, ids: [] };
      fact.count += 1;
      fact.latestAt = Math.max(fact.latestAt, at);
      fact.ids.push(worker.id);
      asks.set(parent, fact);
    }
    const withAsks = overlaid.map((item) => asks.has(item.id) ? { ...item, facts: { ...item.facts, workerAsks: asks.get(item.id)!, lastAgentAt: this.wordsOf(item).lastAgent?.at ?? null } } : item);
    // Count running descendants once each, including declared external workers.
    const children = new Map<string, DeskItem[]>();
    const ownWork = new Map<string, number>();
    for (const item of withAsks) {
      if (item.facts.parentItemId) {
        const siblings = children.get(item.facts.parentItemId) ?? [];
        siblings.push(item);
        children.set(item.facts.parentItemId, siblings);
      }
      const external = item.facts.codexWorkers?.filter(w => w.state === 'working').length ?? 0;
      const status = deskStatus({ ...item, facts: { ...item.facts, runningWorkers: 0, codexWorkers: [] } }, this.now());
      ownWork.set(item.id, (status.stillWorking ? 1 : 0) + external);
    }
    const tree = withAsks.map(item => {
      const seen = new Set([item.id]);
      const pending = [...(children.get(item.id) ?? [])];
      let runningWorkers = item.facts.codexWorkers?.filter(w => w.state === 'working').length ?? 0;
      while (pending.length) {
        const child = pending.pop()!;
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        runningWorkers += ownWork.get(child.id) ?? 0;
        pending.push(...(children.get(child.id) ?? []));
      }
      return { ...item, facts: { ...item.facts, runningWorkers } };
    });
    return this.withCarriedBriefs(tree, live).map(row => {
      const replyable = !!this.adapterFor(row);
      const continuation = !replyable && row.place?.trim() ? tree
        .filter(candidate => candidate.source === 'loom' && candidate.place === row.place && !candidate.hidden && !candidate.facts.stoppedAtSource && this.adapterFor(candidate))
        .sort((a, b) => Number(a.disposition === 'done') - Number(b.disposition === 'done') || b.lastActivityAt - a.lastActivityAt)[0] : null;
      const item = { ...row, replyable, continuation: continuation ? { id: continuation.id, place: continuation.place! } : null };
      const status = deskStatus(item, this.now());
      const nextStep: NextStep = status.pill === 'needs' ? 'your_move' : status.pill === 'failed' || status.pill === 'stuck' ? 'failed' : status.pill === 'working' ? 'working' : status.pill === 'waiting' ? 'watching' : 'fyi';
      return { ...item, status, nextStep, nextStepBasis: status.basis };
    });
  }

  /**
   * Briefs passed up intact (desk/asks.ts carryBriefs; TGO-1075): a row that names another row's open decision,
   * or the lead its worker reports to, carries the full brief. The row it counts on gets it as its pending
   * question (so the card, the chips and voice work unchanged, and an answer goes to the original: answerTarget);
   * the raising row's ask is a duplicate, "carried by" that row.
   */
  private withCarriedBriefs(items: DeskItem[], live: Set<string>): DeskItem[] {
    this.carriersBySource = new Map();
    this.briefsOpen = items.some((item) => briefOf(item) && live.has(item.id));
    if (!this.briefsOpen) return items;
    const leads = new Set(items.filter((item) => (item.facts.role === 'worker' || item.facts.role === 'ops') && live.has(item.id) && item.facts.parentItemId).map((item) => item.facts.parentItemId!));
    const rows: CarryRow[] = items.map((item) => {
      // A stopped thread can't carry a brief or hear how it went, and a failed one shows its failure, not the brief: their
      // workers show their briefs themselves (Codex review on #781).
      const active = item.disposition === 'active' && !item.hidden && !item.facts.stoppedAtSource && item.nextStep !== 'failed';
      return {
        itemId: item.id,
        role: item.facts.role,
        parentItemId: item.facts.parentItemId ?? null,
        ownerGone: !!item.facts.ownerGone,
        active,
        live: live.has(item.id),
        briefId: briefOf(item)?.brief?.id ?? null,
        // Only an active row carries, so only its words are read. An ask for another agent (`to`) carries nothing to the
        // owner, but the row's newest words still do: a decision they name is the owner's (Codex review on #931).
        words: active ? (item.facts.openAsk?.to ? [this.wordsOf(item).lastAgent?.text] : [item.facts.openAsk?.text, item.askRecord?.text, this.wordsOf(item).lastAgent?.text]).filter(Boolean).join('\n') : '',
        lead: leads.has(item.id),
        loom: item.source === 'loom',
      };
    });
    const carries = carryBriefs(rows);
    const byId = new Map(items.map((item) => [item.id, item]));
    // The carriers the desk tells when a brief settles: Loom tells its own threads that name it and the first
    // non-worker lead up the chain, so the desk takes the rest, a row outside Loom, or a worker whose own lead is
    // gone carrying its child's brief (Codex review on #781).
    const deskTells = new Map<string, Set<string>>();
    for (const carry of carries) {
      this.carriersBySource.set(carry.source, new Set(carry.carriers.map((c) => c.itemId)));
      const tell = carry.carriers.filter((c) => { const row = byId.get(c.itemId)!; return row.source !== 'loom' || (c.why === 'worker' && row.facts.role === 'worker'); });
      deskTells.set(`${carry.source}|${carry.decisionId}`, new Set(tell.map((c) => c.itemId)));
    }
    // A worker's lead outside Loom hears how its brief went even if it never carried it on screen (parked or snoozed
    // the whole time): Loom can't reach it (Codex review on #781). A worker whose lead is put away, with no row
    // carrying its brief, shows the brief itself (leadAway; desk/status.ts).
    const title = (item: DeskItem) => item.place?.split(' · ').slice(1).join(' · ') || item.place || item.id;
    const patch = new Map<string, DeskItem>();
    const get = (id: string) => patch.get(id) ?? byId.get(id)!;
    const rowsById = new Map(rows.map((row) => [row.itemId, row]));
    // Whether another row holds the count, not whether any row shows it: a row that only names the brief doesn't
    // count it (Codex review on #781).
    const carried = new Set(carries.filter((carry) => carry.counter !== carry.source).map((carry) => carry.source));
    for (const row of rows) {
      if (!row.briefId || !row.live || !['worker', 'ops'].includes(row.role ?? '') || row.ownerGone) continue;
      const lead = ownerFacingLead(row, rowsById);
      if (!lead) {
        // No conversation up the chain speaks to the owner: the worker shows its brief itself.
        if (!carried.has(row.itemId)) {
          const worker = get(row.itemId);
          const parent = row.parentItemId ? byId.get(row.parentItemId) : undefined;
          patch.set(row.itemId, { ...worker, facts: { ...worker.facts, leadAway: { itemId: row.parentItemId ?? row.itemId, title: parent ? title(parent) : 'its lead' } } });
        }
        continue;
      }
      if (byId.get(lead)?.source !== 'loom') {
        const key = `${row.itemId}|${row.briefId}`;
        deskTells.set(key, new Set([...(deskTells.get(key) ?? []), lead]));
      }
      if (!carried.has(row.itemId) && !rowsById.get(lead)!.active) {
        const worker = get(row.itemId);
        patch.set(row.itemId, { ...worker, facts: { ...worker.facts, leadAway: { itemId: lead, title: title(byId.get(lead)!) } } });
      }
    }
    // Every open brief is written, an empty set too: a carrier that no longer has it is never told later (Codex review on #781).
    for (const row of rows) if (row.briefId && row.live && !deskTells.has(`${row.itemId}|${row.briefId}`)) deskTells.set(`${row.itemId}|${row.briefId}`, new Set());
    for (const [key, carriers] of deskTells) this.rememberCarriers(key, carriers);
    // A row's own open brief, when a live question has the pending slot and no other row holds it: shown and counted
    // here beside the question, so it is never out of sight (Codex review on #781).
    for (const item of items) {
      const own = item.facts.openBrief;
      if (!own || item.facts.pending?.requestId === own.requestId || !live.has(item.id) || carried.has(item.id)) continue;
      const row = get(item.id);
      patch.set(item.id, { ...row, facts: { ...row.facts, carried: [...(row.facts.carried ?? []), { from: { itemId: item.id, title: title(item) }, pending: own, why: 'own', counts: true }] } });
    }
    if (!carries.length) return items.map((item) => patch.get(item.id) ?? item);
    for (const carry of carries) {
      const source = byId.get(carry.source)!;
      // A failed row shows its failure, not the brief, even with a pending flag its errored turn left behind (Codex
      // review on #781): the raising row keeps the count.
      if (carry.counter !== source.id && byId.get(carry.counter)!.nextStep === 'failed') carry.counter = source.id;
      const from = { itemId: source.id, title: title(source) };
      const raised = briefOf(source)!;
      const pending = { ...raised, brief: { ...raised.brief!, from } };
      for (const carrier of carry.carriers) {
        const row = get(carrier.itemId);
        const counts = carry.counter === carrier.itemId;
        const facts = { ...row.facts, carried: [...(row.facts.carried ?? []), { from, pending, why: carrier.why, counts }] };
        let next: DeskItem = { ...row, facts };
        // The row the owner answers on: the brief is its question, unless it is already asking its own.
        if (counts && !row.facts.pending) next = { ...next, nextStep: 'your_move', facts: { ...facts, pending } };
        // A row that only shows it: its own "answer D-n" is the same ask as the raising row's, which counts.
        else if (!counts && row.askRecord?.state === 'open' && names(row.askRecord.text, carry.decisionId)) next = { ...next, askRecord: { ...row.askRecord, state: 'duplicate', of: source.id } };
        patch.set(row.id, next);
      }
      if (carry.counter !== source.id) {
        const counter = get(carry.counter);
        const raised = get(source.id);
        patch.set(source.id, {
          ...raised,
          facts: { ...raised.facts, carriedBy: { itemId: counter.id, title: title(counter) } },
          ...(raised.askRecord ? { askRecord: { ...raised.askRecord, state: 'duplicate' as const, of: counter.id } } : {}),
        });
      }
    }
    return items.map((item) => patch.get(item.id) ?? item);
  }

  /** Its role, parent and Codex workers, read at the time (roles.ts, source-agentctl.ts): never stored in its facts. */
  private withRole(item: DeskItem, roles: Map<string, RoleRecord>, live: (itemId: string) => boolean): DeskItem {
    const role = roles.get(item.id);
    const workers = this.codexWorkers.get(item.id);
    if (!role && !workers) return item;
    return {
      ...item,
      facts: {
        ...item.facts,
        ...(role ? { role: role.role, parentItemId: role.parentItemId } : {}),
        ...(role?.role === 'worker' && (!role.parentItemId || !live(role.parentItemId)) ? { ownerGone: true } : {}),
        // A thread another conversation started speaks to it while it lives; once it's gone, to the owner (status.ts).
        ...(role && role.role !== 'worker' && role.parentItemId && !live(role.parentItemId) ? { ownerGone: true } : {}),
        ...(workers ? { codexWorkers: workers } : {}),
      },
    };
  }

  /** The Codex workers agentctl runs, by the conversation that dispatched them: a changed list re-sends that conversation. */
  setCodexWorkers(workers: Map<string, CodexWorker[]>): void {
    const key = (list: CodexWorker[] | undefined) => JSON.stringify(list ?? []);
    for (const id of new Set([...this.codexWorkers.keys(), ...workers.keys()])) {
      if (key(this.codexWorkers.get(id)) !== key(workers.get(id)) && this.store.item(id)) this.touch(id);
    }
    this.codexWorkers = workers;
    this.flush();
  }

  /** Re-sends a conversation to every reader without changing what's stored (a read-time fact changed). */
  touch(itemId: string): void {
    if (!this.store.item(itemId)) return;
    this.store.bumpRevision(itemId);
    this.changed.add(itemId);
  }

  /**
   * A conversation as every reader sees it (the List, counts, the catch-up, next up): held by its
   * project while the project is snoozed or parked (projects.ts projectHolds), with the project's
   * state in place of its own. Its own attention is never written; a snoozed, parked or done one shows as itself.
   */
  private withProjectHold(item: DeskItem, projects: DeskProject[]): DeskItem {
    const projectId = item.facts.projectId;
    if (!projectId || item.disposition !== 'active') return item;
    // Its own project's snooze or park, else the parent project's: a parent holds its children (projects.ts holderOf).
    const project = holderOf(projects.find((p) => p.id === projectId), projects);
    const away = project?.away;
    if (!project || !away) return item;
    const wakesOnWords = away.state === 'parked' || away.trigger === 'agent_posts';
    const held = projectHolds(away, this.now(), {
      ownerWroteSince: (item.lastOwnerMessageAt ?? 0) > away.at,
      pickedUpSince: (item.facts.projectPickedUpAt ?? -1) >= away.at,
      agentPostedSince: wakesOnWords && this.store.firstAgentMessageAfter(item.id, away.at) !== null,
    });
    return held ? { ...item, disposition: away.state, snoozeUntil: away.until ?? null, snoozeTrigger: away.trigger ?? null, heldBy: project.id } : item;
  }

  /** Screens hear when the projects change from the desk's side (a project waking, one finished). */
  onProjectsChanged(listener: () => void): () => void {
    this.projectsListeners.add(listener);
    return () => this.projectsListeners.delete(listener);
  }

  /** Stores the projects, bumps their revision, and tells every screen; the project's conversations are re-read. */
  private saveProjects(projects: DeskProject[], projectIds: string | string[]): void {
    this.store.setSetting('projects', JSON.stringify(projects));
    this.store.setSetting('projects_rev', String(Number(this.store.setting('projects_rev') ?? 0) + 1));
    // A parent's state reaches its children's conversations too (holderOf): theirs are re-read with its own.
    const ids = new Set(Array.isArray(projectIds) ? projectIds : [projectIds]);
    for (const p of projects) if (p.parent && ids.has(p.parent.slice(8)) && p.parent.startsWith('project:')) ids.add(p.id);
    for (const item of this.store.items()) if (ids.has(item.facts.projectId ?? '')) this.changed.add(item.id);
    this.flush();
    for (const listener of this.projectsListeners) listener();
  }

  /** Projects whose snooze ran out (`time`) or that wait for the owner at the desk (`desk`) come back. */
  private wakeProjects(reason: 'time' | 'desk'): string[] {
    const projects = readProjects(this.store.setting('projects'));
    const due = projects.filter((p) => p.away?.state === 'snoozed' && (reason === 'time' ? p.away.until != null && p.away.until <= this.now() : p.away.trigger === 'desk'));
    for (const project of due) {
      this.saveProjects(readProjects(this.store.setting('projects')).map((p) => (p.id === project.id ? { ...p, away: null } : p)), project.id);
      this.log('desk.project.woke', { projectId: project.id, reason });
    }
    return due.map((p) => p.id);
  }

  /** A short line for logs, briefings and the activity feed. */
  title(item: Pick<DeskItemRow, 'agentName' | 'place' | 'summary' | 'facts'>): string {
    return item.facts.name || item.place || item.summary?.title || textSummary(item.summary?.gist || item.facts.lastOwnerRequest?.text || '', 60) || item.agentName;
  }

  flush(): void {
    if (this.changed.size === 0) return;
    // A brief's carriers show it (withCarriedBriefs): when the row that raised it changes, every row that carried it
    // before or carries it now is re-sent, however far up the chain or by name (Codex review on #781).
    // A carrier changing (a lead parked or picked up) changes the raising row too ("carried by", its count): any brief
    // whose carriers differ re-sends its raising row and every carrier on either side (Codex review on #781).
    const carriedBefore = this.carriersBySource;
    if (carriedBefore.size || this.briefsOpen || [...this.changed].some((id) => { const row = this.store.item(id); return !!row && !!briefOf(row); })) {
      this.readItems();
      const carriedNow = this.carriersBySource;
      const send = (id: string) => { if (!this.changed.has(id)) this.touch(id); };
      for (const id of [...this.changed]) for (const carrier of new Set([...(carriedBefore.get(id) ?? []), ...(carriedNow.get(id) ?? [])])) send(carrier);
      for (const source of new Set([...carriedBefore.keys(), ...carriedNow.keys()])) {
        const was = carriedBefore.get(source) ?? new Set<string>();
        const now = carriedNow.get(source) ?? new Set<string>();
        if (was.size === now.size && [...was].every((id) => now.has(id))) continue;
        send(source);
        for (const id of [...was, ...now]) send(id);
      }
    }
    const roles = this.roles.all();
    for (const id of [...this.changed]) {
      const item = this.store.item(id);
      const role = roles.get(id) ?? item?.facts;
      const parent = role?.role === 'worker' ? role.parentItemId ?? null : null;
      // A worker's lead counts its asks: re-send the lead it reports to now, and the one it reported to before
      // (a source that promotes or reparents a worker updates only the worker; Codex review on #758).
      const before = this.workerParents.get(id) ?? null;
      for (const lead of new Set([parent, before])) if (lead && !this.changed.has(lead)) this.touch(lead);
      if (parent) this.workerParents.set(id, parent);
      else this.workerParents.delete(id);
    }
    const ids = [...this.changed];
    this.changed.clear();
    const entered: StatusEntered[] = [];
    const stuck: Array<{ itemId: string; waits: Wait[] }> = [];
    for (const id of ids) {
      const item = this.store.item(id) ? this.item(id) : null;
      const pill = item ? deskStatus(item, this.now()).pill : null;
      // A row new to the desk (first sight, or a backfill) sets its pill without entering it.
      const known = this.lastPill.has(id);
      const from = this.lastPill.get(id) ?? null;
      if (pill) this.lastPill.set(id, pill); else this.lastPill.delete(id);
      if (known && (pill === 'needs' || pill === 'failed' || pill === 'stuck') && from !== pill) entered.push({ itemId: id, pill, from, at: this.now() });
      // A wait whose checks just reached the count at which Loom wakes the thread with the error: Stuck, whatever
      // the row's pill (a Working or Needs you row hides its Unknown). One that recovers and breaks again is news again.
      const broken = item ? stuckWaits(item) : [];
      const was = this.lastStuck.get(id);
      if (item) this.lastStuck.set(id, new Set(broken.map((w) => w.id))); else this.lastStuck.delete(id);
      const fresh = was ? broken.filter((w) => !was.has(w.id)) : [];
      if (fresh.length) stuck.push({ itemId: id, waits: fresh });
    }
    for (const id of ids) {
      const revision = this.store.item(id)?.revision ?? 0;
      for (const listener of this.listeners) listener({ type: 'item', id, revision });
    }
    for (const event of entered) this.statusEntered(event);
    for (const event of stuck) this.waitStuck(event.itemId, event.waits);
  }

  /**
   * Whether a thread's new summary posts as a Summary (feed-status.md "What posts"): not when it posted its own Update
   * or Shipped within the throttle window, and, unless the owner keeps them ("Summaries from threads that post
   * updates"), not from a thread that wrote its own update in the last day. A check on the records, not the words.
   */
  private summaryPosts(itemId: string): boolean {
    const feed = this.options.feed;
    if (!feed) return true;
    if (feed.ledgerPosted(itemId, this.now() - FEED_WORKING_EVERY_MS)) return false;
    return readFeedSettings(this.store.setting('feed')).summaries || !feed.ledgerPosted(itemId, this.now() - FEED_UPDATER_MS, { lead: true });
  }

  /** A worker or ops thread whose lead is there to hear it: its updates go to the lead, not the Feed (status.ts audience). */
  private reportsToLead(itemId: string): boolean {
    const item = this.item(itemId);
    return !!item && reportsUp(item, this.now());
  }

  /** A row's Feed post: active and shown, for the owner (a worker's request or failure goes to its lead, not the Feed). */
  private feedRow(itemId: string): DeskItem | null {
    const item = this.item(itemId);
    if (!this.options.feed || !item || item.hidden || item.disposition !== 'active' || deskStatus(item, this.now()).audience !== 'owner') return null;
    return item;
  }

  /** A state post's base: the summary's headline and words, so a summary just posted folds in by its content key. */
  private statePost(item: DeskItem): Omit<NewFeedPost, 'kind'> {
    const headline = item.summary?.headline || null;
    return { itemId: item.id, projectId: item.facts.projectId ?? null, agentName: item.agentName, title: headline || this.title(item), text: item.summary?.paragraph || item.summary?.gist || '', data: { ...(headline ? { headline: true } : {}), ...(item.summary?.contentKey ? { contentKey: item.summary.contentKey } : {}) }, key: `thread:${item.id}`, mergeMs: FEED_MERGE_MS };
  }

  /** A row entered Needs you or Failed: traced, told to listeners, and one Feed post (spec feed-status.md "What posts"). */
  private statusEntered(event: StatusEntered): void {
    this.trace('status.entered', `${this.traceName(event.itemId)}: ${event.from ?? 'new'} → ${event.pill}`, { ...event });
    for (const listener of this.listeners) listener({ type: 'status.entered', entered: event });
    const item = this.feedRow(event.itemId);
    const status = item && deskStatus(item, this.now());
    if (!item || !status || !status.countsForOwner) return;
    // Needs you while the owner had the last word: its words would be the owner's own, told back to them. An explicit
    // request (a question, a brief) is the agent's own and posts (Codex review on #1021).
    if (event.pill === 'needs' && status.basis === 'source:ask' && this.store.ownerHasLastWord(item.id)) return;
    const base = this.statePost(item);
    this.postFeed({ ...base, kind: event.pill, data: { ...base.data, source: 'status.entered', from: event.from } });
  }

  /** A wait's checks failed three times in a row: Loom woke the thread with the error. Stuck, said with that error. */
  private waitStuck(itemId: string, waits: Wait[]): void {
    this.trace('wait.stuck', `${this.traceName(itemId)}: ${waits.map((w) => waitTarget(w, this.now())).join(', ')}`, { itemId, waits: waits.map((w) => w.id) });
    const item = this.feedRow(itemId);
    if (!item) return;
    // Its own words (the check's error), not the summary's, under the wait's own key: it never folds into the
    // thread's Needs you or Failed, and a summary never folds into it. Each wait that broke posts: one recovering
    // never closes another's (Codex review on #938).
    const { key: _thread, mergeMs: _merge, data: { contentKey: _summary, ...data } = {}, ...base } = this.statePost(item);
    for (const wait of waits) {
      this.postFeed({ ...base, kind: 'stuck', text: `${waitTarget(wait, this.now())} check failing: ${wait.checkError}`, data: { ...data, source: 'wait', waitId: wait.id, since: wait.errorSince ?? null }, key: `wait:${item.id}:${wait.id}` });
    }
  }
}
