import { randomUUID } from 'node:crypto';
import { readSse, type PresentationState } from './screen-director.js';
import type { DraftCard, DraftScreenCommand } from './draft-mode.js';
import type { PauseCard, PauseScreenCommand } from './pause-mode.js';

// The voice operator's handle on the Agent Desk (apps/screen, docs/specs/agent-desk.md).
// The desk discovers every conversation (Discord threads, home-channel chapters, Loom
// threads) and owns owner attention; the operator only reads it and acts through
// commands that carry a client-generated command id, so a retry is never applied twice.

export type DeskStep = 'your_move' | 'failed' | 'working' | 'watching' | 'fyi';

/** One question of a Loom user-input request (the desk's facts.pending.questions). */
export interface DeskPendingQuestion {
  /** Loom's question id: the key of the answer. */
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
  /** False when only the offered labels are accepted. */
  allowCustomAnswer?: boolean;
}

/** A Loom thread blocked on the owner: a user-input request or an approval (the desk's facts.pending). */
export interface DeskPendingRequest {
  kind: 'question' | 'approval';
  /** Null when the desk couldn't find the request: it has to be answered in Loom. */
  requestId: string | null;
  questions: DeskPendingQuestion[];
  approval?: { options: Array<{ decision: string; label: string; warning?: string }>; detail?: string };
  /** Loom lets this one be dismissed unanswered (most requests can't be). */
  dismissible?: boolean;
  /** Compact form: the first question (+N more) and its labels. */
  question: string;
  options: string[];
  at: number;
}

/** A desk item as the operator uses it (the desk's DeskItem, trimmed to what the operator reads). */
export interface DeskItemSummary {
  /** Hidden by the owner's rules file, or filtered off the board: never spoken unprompted. */
  hidden?: boolean;
  filteredBy?: unknown[] | null;
  id: string;
  source: string;
  kind: string;
  conversationKey: string;
  agentId: string;
  agentName: string;
  place: string | null;
  /** A coding thread's repo (the part before "·" in its place). */
  area?: string | null;
  channelId: string | null;
  threadId: string | null;
  nextStep: DeskStep;
  ask: string | null;
  options: string[];
  /** The card's one-liner: the ask, else the gist. */
  line?: string;
  /** `about`: what the conversation is for, in a few plain words (matched when the owner names a topic). */
  summary?: {
    gist: string;
    about?: string | null;
    watchUntil?: string | null;
    due?: string | null;
    context?: string[];
    ownerAsk?: string | null;
    goal?: string | null;
    milestone?: string | null;
    questions?: Array<{ q: string; lean: string | null }>;
  } | null;
  facts?: {
    job?: { label: string; deadlineAt: number | null } | null;
    failed?: { at: number; reason: string; message: string } | null;
    lastOwnerRequest?: { text: string; at: number } | null;
    /** A Loom question or approval waiting on the owner. */
    pending?: DeskPendingRequest | null;
    /** The project (space) the item is filed under. */
    projectId?: string | null;
    /** Kind: thread (interactive), default (a space's lead), worker, job (ops). */
    role?: string | null;
    /** Pinned to the top of the Inbox. */
    pinned?: boolean | null;
    /** The owner's own name for it on the desk (a rename where the source keeps no title). */
    name?: string | null;
    /** A turn is running in it right now (what the desk's stop interrupts). */
    running?: boolean | null;
  };
  watching?: { reason: string; nextCheckAt: number | null; overdue?: { kind: 'check-back' | 'person' | 'agent'; since: number; text: string } | null } | null;
  /** Whose move it is (the row's pill) and whether the agent is busy, as the desk works it out (desk/status.ts). */
  status?: { pill?: 'needs' | 'failed' | 'working' | 'waiting' | 'stuck' | 'finished' | 'idle' | 'unknown'; countsForOwner?: boolean; detail?: string; basis?: string; layer?: 'needs' | 'active' | 'later' | 'done'; move: 'needs' | 'ready' | 'watching' | 'failed' | null; busy: 'working' | 'background' | null; unread?: boolean; live?: 'needs' | 'failed' | 'ready' | 'todo' | 'working' | 'watching' | 'fyi' | 'sent' | 'held' | null; audience?: 'owner' | 'lead' | 'none' } | null;
  disposition: 'active' | 'snoozed' | 'parked' | 'done';
  seen: 'new' | 'seen' | 'updated';
  lastActivityAt: number;
  lastAgentMessageId?: string | null;
  revision: number;
  /** A due time some sources set directly (epoch ms or ISO). */
  due?: number | string | null;
  /** Your move / failed: when the first agent message the owner hasn't answered arrived (epoch ms). */
  waitingSince?: number | null;
  /** Your move / failed: 1-based place in the owner's queue (oldest wait first). */
  queuePos?: number | null;
}

/** One item in the owner's queue (GET /api/desk/next): their move, oldest wait first. */
export interface DeskNextItem {
  id: string;
  agentId: string;
  agentName: string;
  place: string | null;
  title: string | null;
  ask: string | null;
  pill?: NonNullable<DeskItemSummary['status']>['pill'];
  step: 'your_move' | 'failed';
  /** Epoch ms of the first agent message the owner hasn't answered. */
  waitingSince: number;
}

/**
 * A job (ops) or worker: it reports to a conversation, never to the owner, so it is never theirs to answer. The
 * desk says who a row reaches (status.audience); a desk from before that is read by role.
 */
export function reportsUp(item: Pick<DeskItemSummary, 'facts' | 'status'>): boolean {
  if (item.status?.audience) return item.status.audience !== 'owner';
  return item.facts?.role === 'ops' || item.facts?.role === 'worker';
}

/**
 * Waits on the owner: the desk's Needs you, owner-facing only, as its sidebar badge counts it (owner's
 * decision, 10/17; the desk's view.ts needsOwner). An unread move or open request (status.move needs), or a
 * failure not yet seen; never a job or worker. A desk too old to send status: Your move or Failed.
 */
export function needsOwner(item: Pick<DeskItemSummary, 'facts' | 'status' | 'nextStep' | 'seen'>): boolean {
  if (item.status?.countsForOwner !== undefined) return item.status.countsForOwner;
  if (reportsUp(item)) return false;
  if (!item.status) return item.nextStep === 'your_move' || item.nextStep === 'failed';
  // The desk's own answer (desk/status.ts needsOwner): its move unread, or a failure (a reported one until seen, a
  // dropped message until answered). A desk from before `live` is read from its move.
  if (item.status.live !== undefined) return item.status.live === 'needs' || (item.status.live === 'failed' && (item.status.move === 'failed' ? item.seen !== 'seen' : true));
  return item.status.move === 'needs' || (item.status.move === 'failed' && item.seen !== 'seen');
}

const failedMove = (item: Pick<DeskItemSummary, 'status' | 'nextStep'>) => (item.status ? item.status.move === 'failed' : item.nextStep === 'failed');

/**
 * The queue from the active list, for desks without /api/desk/next: what needs the owner on the
 * board (active, not hidden or filtered off), oldest wait first (waitingSince, else last activity).
 */
export function deriveNextItems(items: DeskItemSummary[]): DeskNextItem[] {
  return items
    .filter((item) => needsOwner(item) && item.disposition === 'active' && item.hidden !== true && !(Array.isArray(item.filteredBy) && item.filteredBy.length > 0))
    .map((item) => ({
      id: item.id,
      agentId: item.agentId,
      agentName: item.agentName,
      place: item.place,
      title: null,
      ask: item.ask,
      pill: item.status?.pill,
      step: failedMove(item) ? ('failed' as const) : ('your_move' as const),
      waitingSince: item.waitingSince ?? item.lastActivityAt,
    }))
    .sort((a, b) => a.waitingSince - b.waitingSince);
}

export interface DeskMessage {
  author: 'agent' | 'owner' | 'other';
  text: string;
  at: number;
  /** The source's message id (a Discord snowflake, a Loom message id), when the desk sends it. */
  messageId?: string;
  /** `mail`: another agent's mail, delivered as the owner's turn: not something the owner said. */
  meta?: { mail?: unknown } | null;
}

export interface DeskItemDetail extends DeskItemSummary {
  messages: DeskMessage[];
  scenes?: string[];
  /** The agent's latest reply in full (its whole last run of messages), from desks that send it. */
  reply?: { at: number; messageIds: string[]; text: string } | null;
}

export interface DeskBriefing {
  text: string;
  yourMove: Array<{ id: string; agentName: string; place: string | null; step: DeskStep; ask: string | null; options: string[]; context: string[]; gist: string | null; pending?: DeskPendingRequest | null }>;
  fyi: Array<{ agentName: string; itemIds: string[]; sentence: string }>;
  counts?: Record<string, number>;
}

export const DESK_COMMANDS = ['seen', 'unseen', 'heard', 'briefed', 'done', 'reopen', 'snooze', 'park', 'pickup', 'reply', 'answer', 'respond', 'approve', 'dismiss', 'retry', 'sweep', 'stop', 'pin', 'rename', 'project', 'undo'] as const;
export type DeskCommandType = (typeof DESK_COMMANDS)[number];

export interface DeskCommandResult {
  commandId: string;
  status: 'accepted' | 'applied' | 'failed';
  error?: string;
  outcome?: Record<string, unknown>;
  /** The desk never answered (after retries with the same command id). */
  transport?: boolean;
}

export interface OperatorTranscriptLine {
  speaker: 'user' | 'operator';
  name: string;
  text: string;
  final: boolean;
}

export interface OperatorStatusUpdate {
  live: boolean;
  status: 'listening' | 'routing' | 'speaking' | 'working' | 'idle' | 'offline';
  agentName: string | null;
  transcript?: OperatorTranscriptLine;
}

/** One operator decision for the desk's session trace (POST /api/desk/trace). */
export interface OperatorTraceEntry {
  kind: string;
  /** One human line. */
  summary: string;
  data?: Record<string, unknown>;
  sessionId?: string | null;
  at?: number;
}

export interface DeskItemEvent {
  id: string;
  revision?: number;
}

export interface DeskClient {
  /** The active view, as last read (refreshed on desk events). */
  items(): DeskItemSummary[];
  /** The desk's open projects (spaces), as of the last refresh; items name theirs by `facts.projectId`. */
  projects?(): DeskProject[];
  refresh(): Promise<DeskItemSummary[]>;
  item(id: string): Promise<DeskItemDetail | null>;
  briefing(): Promise<DeskBriefing | null>;
  /**
   * The owner's queue, oldest wait first (GET /api/desk/next; derived from the active list on a desk
   * without it). Null when the desk can't be read.
   */
  next(): Promise<DeskNextItem[] | null>;
  /**
   * Sends a command. `commandId` defaults to a fresh UUID; a transport failure is retried with
   * the same id (the desk replays its stored outcome), so a command is never applied twice.
   */
  command(type: DeskCommandType, itemId: string | undefined, args?: Record<string, unknown>, commandId?: string): Promise<DeskCommandResult>;
  /** Operator status and captions for the screens (fire and forget; ignored if the desk lacks the endpoint). */
  publishOperator(update: OperatorStatusUpdate): void;
  /**
   * Records an operator decision in the desk's session trace. Fire and forget: batched and
   * flushed at most every 500 ms; a failure (or an older desk without the endpoint) is dropped.
   */
  trace?(entry: OperatorTraceEntry): void;
  /** Draft mode (draft-mode.ts): the Draft card for the screens (POST /api/desk/draft; fire and forget). */
  publishDraft?(card: DraftCard): void;
  /** Draft mode: Send / Cancel taps on the Draft card (`draftCommand` on the desk stream); null stops. */
  onDraftCommand?(handler: ((command: DraftScreenCommand) => void) | null): void;
  /** Pause mode (pause-mode.ts): the "Paused · N waiting" pill (POST /api/desk/pause; fire and forget). */
  publishPause?(card: PauseCard): void;
  /** Pause mode: a tap on the pill to resume (`pauseCommand` on the desk stream); null stops. */
  onPauseCommand?(handler: ((command: PauseScreenCommand) => void) | null): void;
  /**
   * Draft mode: presentation changes (`presentation` on the desk stream; the stream's opening
   * snapshot is not one). A later call replaces the handler.
   */
  onPresentation?(handler: (presentation: PresentationState) => void): void;
  /** Stops `handler` (only when it is still the one listening: a newer session may own the stream). */
  offPresentation?(handler: (presentation: PresentationState) => void): void;
  /** Start work: the repos a new Loom thread can start in (GET /api/desk/start-work); null when the desk can't start threads. */
  startWorkRepos?(): Promise<string[] | null>;
  /** Start work: a new Loom thread (POST /api/desk/start-work); the desk refuses until repo and prompt are both there. */
  startWork?(request: StartWorkRequest): Promise<StartWorkOutcome>;
  /** A new thread with a named agent (POST /api/desk/agent-threads): the bot opens it and wakes the agent there. */
  startAgentThread?(request: AgentThreadRequest): Promise<AgentThreadOutcome>;
  /** Search (GET /api/desk/search): conversations ranked by keyword and meaning; null when the desk can't search. */
  search?(query: string, limit?: number): Promise<DeskSearchHit[] | null>;
  /** A project's open conversations, snoozed and parked ones too: what its Finish marks done (GET /api/desk/items?view=everything). */
  projectMembers?(projectId: string): Promise<DeskItemSummary[] | null>;
  /** An archived conversation's latest messages, as search keeps them (GET /api/desk/search/transcript/:id). */
  transcript?(itemId: string, limit?: number): Promise<DeskMessage[] | null>;
  /** Capacity (GET /api/desk/capacity): accounts with their windows and threads, and this Mac; null when unavailable. */
  capacity?(): Promise<DeskCapacity | null>;
  /** The System page in a few words (GET /api/desk/system/brief): its status line and open incidents; null when unavailable. */
  system?(): Promise<DeskSystemBrief | null>;
  /** Moves a Loom thread to another account at its next safe point (POST /api/desk/capacity/move). */
  moveAccount?(itemId: string, account: string, commandId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** A project's snooze, park, wake or finish (POST /api/desk/projects/:id/action). */
  projectAction?(projectId: string, action: DeskProjectAction): Promise<{ ok: true; held?: number; acted?: number; stayed?: number } | { ok: false; error: string }>;
  /**
   * Catch me up's focus card and map (GET /api/desk/catchup/walk). 'off' on a desk with no update ledger (the old
   * briefing reads instead); null when it can't be read.
   */
  catchupWalk?(ask?: CatchupWalkAsk): Promise<CatchupWalk | 'off' | null>;
  /** Lines the owner saw (POST /api/desk/updates/seen): heard aloud, Got it (read), a brief deferred. */
  updatesSeen?(ids: number[], via: 'heard' | 'read' | 'deferred', outcome?: string | null): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Current chapter plan, including an empty chapter after its last line was heard. */
  chapterPlan?(spaceId: string): Promise<ChapterVoicePlan | null>;
  /** Accept or Defer only the plan already heard; a changed chapter is returned for another confirmation. */
  chapterAct?(spaceId: string, how: 'accept' | 'defer', plan: ChapterVoicePlan, commandId?: string): Promise<({ ok: true } & ChapterActResult) | { ok: false; error: string; changed?: boolean; plan?: ChapterVoicePlan }>;
  /** Fine by me on something decided for the owner (POST /api/desk/decided/confirm). */
  decidedConfirm?(decisionId: string, commandId?: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Desk item events (`/api/desk/stream`); a second connect replaces the first's handler. */
  connect(onItem: (event: DeskItemEvent) => void): void;
  disconnect(onItem?: (event: DeskItemEvent) => void): void;
}

export interface DeskProject {
  id: string;
  name: string;
  /** Snoozed or parked by the owner (until: epoch ms, none when parked or waiting on a trigger): nothing in it speaks until it wakes. */
  away?: { state: 'snoozed' | 'parked'; until?: number | null };
}

/** One search hit with its row (`row.id` is the item; an archived conversation's row has `archived`). */
export interface DeskSearchHit {
  itemId: string;
  score?: number;
  /** The best matching messages; `snippet` wraps keyword hits in \u0002 … \u0003. */
  matches?: Array<{ snippet?: string; how?: string }>;
  row?: { id?: string; place?: string | null; agentName?: string; archived?: boolean; disposition?: string; summary?: { gist?: string; about?: string | null } | null; facts?: { name?: string | null } | null } | null;
}

/** The parts of GET /api/desk/capacity voice speaks. */
export interface DeskCapacity {
  loom: boolean;
  moves: boolean;
  accounts: Array<{ id: string; name: string; provider: string; status: string; coolingUntil?: number | string | null; fiveHour: { left: number; resetsAt: string | null } | null; weekly: { left: number; resetsAt: string | null } | null; running: number; idle: number; threads: Array<{ itemId: string; title: string }> }>;
  machine: { disk: { totalBytes: number; freeBytes: number } | null } | null;
}

/** GET /api/desk/system/brief: what voice says to "what's broken?". */
export interface DeskSystemBrief {
  line: string;
  critical: string[];
  open: string[];
  error: string | null;
}

export type DeskProjectAction = { action: 'snooze'; until?: string; trigger?: 'desk' | 'agent_posts' } | { action: 'park' | 'wake' | 'finish' };

export interface StartWorkRequest {
  repo: string;
  prompt: string;
  title?: string;
  account?: string;
  mode?: 'worktree' | 'local';
  plan?: boolean;
  /** The project (space) the new thread joins, as the desk's + button sends it. */
  projectId?: string;
  /** Same id on a retry: the desk returns the first thread instead of starting another. */
  commandId: string;
}

export interface AgentThreadRequest {
  agentId: string;
  prompt: string;
  title?: string;
  /** The project (space) the new thread joins. */
  projectId?: string;
  /** Same id on a retry: the desk returns the first thread instead of starting another. */
  commandId: string;
}

export type AgentThreadOutcome = { ok: true; threadId: string; itemId: string; title: string; projectSkipped?: boolean } | { ok: false; error: string };

/** `projectSkipped`: it started, but on its own: the project was finished or deleted meanwhile. */
export type StartWorkOutcome = { ok: true; threadId: string; itemId: string; title: string; account: string; projectSkipped?: boolean } | { ok: false; error: string };

/** Catch me up by voice (GET /api/desk/catchup/walk): the page's focus card and map, as the screens show them. */
export interface ChapterVoicePlan { updateIds: number[]; revision: string; line: string }
export type CatchupKind = 'needs' | 'failed' | 'decided' | 'shipped' | 'fyi';
export interface CatchupWalkFocus {
  plan?: ChapterVoicePlan;
  spaceId: string;
  name: string;
  headline: string | null;
  line: { id: number; ids: number[]; kind: CatchupKind; title: string; detail: string | null; briefId: string | null; itemId: string | null; decisionId: string | null; waiting: boolean; rule?: boolean };
  /** `answer`: the option as the brief's question lists it (what `respond` takes); `revision`: sent with the answer. */
  brief: { ask: string; options: Array<{ key: string; label: string; recommended: boolean; answer: string; consequence?: string | null }>; defaultOption: string | null; revision: number | null; level?: number | null; tripwire?: string | null; vetoLeftMs?: number | null } | null;
}
export interface CatchupWalkRow {
  spaceId: string;
  name: string;
  summary: string;
}
export interface CatchupWalk {
  focus: CatchupWalkFocus | null;
  map: { needs: CatchupWalkRow[]; look: CatchupWalkRow[]; smaller: CatchupWalkRow[] };
  left: number;
}
export interface CatchupWalkAsk {
  skipped?: number[];
  focus?: number | null;
  space?: string | null;
}
/** What Accept did on a space (POST /api/desk/chapters/:space/accept): briefs answered, decisions fine, lines seen, and what it left. */
export interface ChapterActResult {
  plan?: { line?: string };
  applied?: { took: string[]; fine: string[]; seen: number; filed?: string[]; cleared?: string[] };
  left?: Array<{ updateId: number; why?: string }>;
  failed?: Array<{ updateId: number; error: string }>;
  backAt?: number;
}

export interface HttpDeskClientOptions {
  log?: (event: string, data?: Record<string, unknown>) => void;
  /** Delays between retries of one command on transport failure (default 300 ms, 1 s). */
  retryDelaysMs?: number[];
  timeoutMs?: number;
  /** Trace batches go out at most this often (default 500 ms). */
  traceFlushMs?: number;
  /**
   * TANGO_COLLABORATION_BRIDGE_TOKEN (the default): when the desk has one set, its local-only posts
   * (operator status, the Draft card, the pause pill, the session trace) must carry it or are refused.
   */
  collaborationToken?: string;
  /**
   * Who the desk stream is for (default `operator`: the desk relays Draft card and pause pill taps to it).
   * A lab session passes something else, so the owner's taps never reach it.
   */
  streamClient?: string;
}

/** Trace entries held while the desk is slow or down; the oldest are dropped past this. */
const TRACE_BUFFER_MAX = 200;
const TRACE_BATCH_MAX = 100;

/** The desk's HTTP API on the screen service (direct local caller: no tailnet login header). */
export class HttpDeskClient implements DeskClient {
  private list: DeskItemSummary[] = [];
  private projectList: DeskProject[] = [];
  private projectsAt = 0;
  private handler: ((event: DeskItemEvent) => void) | null = null;
  private abort: AbortController | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private operatorEndpoint = true;
  /** Operator updates waiting while one is in flight: posted one at a time, so a screen never gets them out of order. */
  private operatorQueue: OperatorStatusUpdate[] = [];
  private operatorSending = false;
  private draftEndpoint = true;
  private draftHandler: ((command: DraftScreenCommand) => void) | null = null;
  private pauseEndpoint = true;
  private pauseHandler: ((command: PauseScreenCommand) => void) | null = null;
  private presentationHandler: ((presentation: PresentationState) => void) | null = null;
  private traceEndpoint = true;
  private nextEndpoint = true;
  private traceBuffer: Array<OperatorTraceEntry & { source: 'operator'; at: number }> = [];
  private traceTimer: NodeJS.Timeout | null = null;
  private traceInFlight = false;
  private readonly log: (event: string, data?: Record<string, unknown>) => void;

  constructor(
    private readonly baseUrl: string,
    private readonly options: HttpDeskClientOptions = {},
  ) {
    this.log = options.log ?? (() => {});
  }

  items(): DeskItemSummary[] {
    return this.list;
  }

  /** JSON, plus the collaboration token when one is configured. */
  private postHeaders(): Record<string, string> {
    const token = this.options.collaborationToken ?? process.env.TANGO_COLLABORATION_BRIDGE_TOKEN?.trim();
    return { 'Content-Type': 'application/json', ...(token ? { 'X-Tango-Collaboration-Token': token } : {}) };
  }

  async refresh(): Promise<DeskItemSummary[]> {
    const body = await this.get<{ items: DeskItemSummary[] }>('/api/desk/items?view=active&group=step');
    if (body?.items) this.list = body.items;
    // Project names change rarely: read at most once a minute, alongside the items.
    if (Date.now() - this.projectsAt > 60_000) {
      this.projectsAt = Date.now();
      const settings = await this.get<{ projects?: Array<{ id?: unknown; name?: unknown; finishedAt?: unknown; away?: { state?: unknown; until?: unknown } | null }> }>('/api/desk/settings');
      if (Array.isArray(settings?.projects)) {
        this.projectList = settings.projects.filter((project) => typeof project.id === 'string' && typeof project.name === 'string' && !project.finishedAt).map((project) => {
          const state = project.away?.state;
          const until = typeof project.away?.until === 'number' ? project.away.until : null;
          return { id: project.id as string, name: project.name as string, ...(state === 'snoozed' || state === 'parked' ? { away: { state, until } } : {}) };
        });
      }
    }
    return this.list;
  }

  projects(): DeskProject[] {
    return this.projectList;
  }

  async item(id: string): Promise<DeskItemDetail | null> {
    // The desk answers { item, messages, timeline, scenes }; older builds answered the item flat.
    const raw = await this.get<DeskItemDetail & { item?: DeskItemSummary }>(`/api/desk/items/${encodeURIComponent(id)}`);
    if (!raw) return null;
    if (!raw.item) return raw;
    const { item, ...rest } = raw;
    return { ...item, ...rest } as DeskItemDetail;
  }

  async briefing(): Promise<DeskBriefing | null> {
    return this.get<DeskBriefing>('/api/desk/briefing');
  }

  async next(): Promise<DeskNextItem[] | null> {
    if (this.nextEndpoint) {
      try {
        const response = await fetch(`${this.baseUrl}/api/desk/next`, { signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000) });
        if (response.ok) {
          const body = (await response.json()) as { items?: DeskNextItem[] };
          if (Array.isArray(body?.items)) return body.items;
        } else if (response.status === 404) {
          // An older desk without the queue: derive it from the active list from now on.
          this.nextEndpoint = false;
          this.log('desk.next.unsupported', {});
        } else return null;
      } catch (err) {
        this.log('desk.error', { path: '/api/desk/next', message: (err as Error).message });
        return null;
      }
    }
    const body = await this.get<{ items: DeskItemSummary[] }>('/api/desk/items?view=active&group=step');
    if (!body?.items) return null;
    this.list = body.items;
    return deriveNextItems(this.list);
  }

  async command(type: DeskCommandType, itemId: string | undefined, args: Record<string, unknown> = {}, commandId: string = randomUUID()): Promise<DeskCommandResult> {
    const delays = this.options.retryDelaysMs ?? [300, 1000];
    const body = JSON.stringify({ commandId, type, ...(itemId ? { itemId } : {}), args, actor: 'voice' });
    let lastError = '';
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delays[attempt - 1]));
      try {
        const response = await fetch(`${this.baseUrl}/api/desk/commands`, {
          method: 'POST',
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
          headers: this.postHeaders(),
          body,
        });
        if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
        const result = (await response.json().catch(() => ({}))) as Partial<DeskCommandResult> & { error?: string };
        if (!response.ok) return { commandId, status: 'failed', error: result.error ?? `HTTP ${response.status}` };
        void this.scheduleRefresh();
        return { commandId, status: result.status ?? 'failed', ...(result.error ? { error: result.error } : {}), ...(result.outcome ? { outcome: result.outcome } : {}) };
      } catch (err) {
        lastError = (err as Error).message;
        this.log('desk.command.retry', { commandId, type, attempt, message: lastError });
      }
    }
    return { commandId, status: 'failed', error: `the desk did not answer: ${lastError}`, transport: true };
  }

  publishOperator(update: OperatorStatusUpdate): void {
    if (!this.operatorEndpoint) return;
    // Concurrent posts can land out of order, and a screen shows the last one it got: a line just
    // finalized arriving after the next line's start put the previous line back on the dock.
    // A waiting update the new one covers (status only, or the same speaker's partial line) is replaced.
    const waiting = this.operatorQueue.at(-1);
    const covered = waiting && (!waiting.transcript || (!waiting.transcript.final && update.transcript?.speaker === waiting.transcript.speaker));
    if (covered) this.operatorQueue[this.operatorQueue.length - 1] = update;
    else this.operatorQueue.push(update);
    if (this.operatorQueue.length > 20) this.operatorQueue.shift(); // a desk that stopped answering: newest kept
    void this.drainOperator();
  }

  private async drainOperator(): Promise<void> {
    if (this.operatorSending) return;
    this.operatorSending = true;
    try {
      for (let update = this.operatorQueue.shift(); update && this.operatorEndpoint; update = this.operatorQueue.shift()) {
        try {
          const response = await fetch(`${this.baseUrl}/api/desk/operator`, {
            method: 'POST',
            signal: AbortSignal.timeout(3000),
            headers: this.postHeaders(),
            body: JSON.stringify(update),
          });
          // An older desk without the endpoint: stop trying for this process.
          if (response.status === 404) {
            this.operatorEndpoint = false;
            this.operatorQueue.length = 0;
            this.log('desk.operator.unsupported', {});
          }
        } catch {
          // Fire and forget: the next update says how things are now.
        }
      }
    } finally {
      this.operatorSending = false;
    }
  }

  publishDraft(card: DraftCard): void {
    if (!this.draftEndpoint) return;
    void fetch(`${this.baseUrl}/api/desk/draft`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
      headers: this.postHeaders(),
      body: JSON.stringify(card),
    })
      .then((response) => {
        if (response.status === 404) {
          this.draftEndpoint = false;
          this.log('desk.draft.unsupported', {});
        }
      })
      .catch(() => undefined);
  }

  onDraftCommand(handler: ((command: DraftScreenCommand) => void) | null): void {
    this.draftHandler = handler;
  }

  publishPause(card: PauseCard): void {
    if (!this.pauseEndpoint) return;
    void fetch(`${this.baseUrl}/api/desk/pause`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
      headers: this.postHeaders(),
      body: JSON.stringify(card),
    })
      .then((response) => {
        if (response.status === 404) {
          this.pauseEndpoint = false;
          this.log('desk.pause.unsupported', {});
        }
      })
      .catch(() => undefined);
  }

  onPauseCommand(handler: ((command: PauseScreenCommand) => void) | null): void {
    this.pauseHandler = handler;
  }

  onPresentation(handler: (presentation: PresentationState) => void): void {
    this.presentationHandler = handler;
  }

  offPresentation(handler: (presentation: PresentationState) => void): void {
    if (this.presentationHandler === handler) this.presentationHandler = null;
  }

  trace(entry: OperatorTraceEntry): void {
    try {
      if (!this.traceEndpoint) return;
      this.traceBuffer.push({ ...entry, source: 'operator', at: entry.at ?? Date.now() });
      if (this.traceBuffer.length > TRACE_BUFFER_MAX) this.traceBuffer.splice(0, this.traceBuffer.length - TRACE_BUFFER_MAX);
      this.scheduleTraceFlush();
    } catch {
      /* tracing never affects the operator */
    }
  }

  private scheduleTraceFlush(): void {
    if (this.traceTimer || this.traceInFlight) return;
    this.traceTimer = setTimeout(() => {
      this.traceTimer = null;
      void this.flushTrace();
    }, this.options.traceFlushMs ?? 500);
    this.traceTimer.unref?.();
  }

  /** Sends what is buffered (also usable at shutdown). Never throws. */
  async flushTrace(): Promise<void> {
    if (this.traceInFlight || this.traceBuffer.length === 0 || !this.traceEndpoint) return;
    const batch = this.traceBuffer.splice(0, TRACE_BATCH_MAX);
    this.traceInFlight = true;
    try {
      const response = await fetch(`${this.baseUrl}/api/desk/trace`, {
        method: 'POST',
        signal: AbortSignal.timeout(3000),
        headers: this.postHeaders(),
        body: JSON.stringify(batch),
      });
      if (response.status === 404) {
        // An older desk without the trace: stop trying for this process.
        this.traceEndpoint = false;
        this.traceBuffer = [];
        this.log('desk.trace.unsupported', {});
      }
    } catch {
      /* the desk is down or slow: this batch is lost, the operator carries on */
    } finally {
      this.traceInFlight = false;
      if (this.traceBuffer.length) this.scheduleTraceFlush();
    }
  }

  connect(onItem: (event: DeskItemEvent) => void): void {
    this.handler = onItem;
    if (this.abort) return;
    const abort = new AbortController();
    this.abort = abort;
    void this.refresh();
    void this.listen(abort);
  }

  disconnect(onItem?: (event: DeskItemEvent) => void): void {
    if (onItem && onItem !== this.handler) return;
    this.handler = null;
    this.abort?.abort();
    this.abort = null;
  }

  private async listen(abort: AbortController): Promise<void> {
    while (!abort.signal.aborted) {
      try {
        // The token: the desk relays Draft card taps only to an authenticated local operator stream.
        const { 'Content-Type': _json, ...auth } = this.postHeaders();
        const response = await fetch(`${this.baseUrl}/api/desk/stream?client=${encodeURIComponent(this.options.streamClient ?? 'operator')}`, { signal: abort.signal, headers: { Accept: 'text/event-stream', ...auth } });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        this.log('desk.stream.connected', {});
        for await (const { event, data } of readSse(response.body)) {
          if (event === 'draftCommand') {
            // Draft mode: a Send / Cancel tap on the Draft card.
            const command = JSON.parse(data) as DraftScreenCommand;
            if (command.action === 'send' || command.action === 'cancel') this.draftHandler?.(command);
            continue;
          }
          if (event === 'pauseCommand') {
            // Pause mode: a tap on the pause pill.
            const command = JSON.parse(data) as PauseScreenCommand;
            if (command.action === 'resume') this.pauseHandler?.(command);
            continue;
          }
          if (event === 'presentation') {
            // A screen moved (a tapped card arms a draft). The `hello` snapshot is not a change.
            const presentation = JSON.parse(data) as PresentationState;
            if (presentation && typeof presentation.view === 'string') this.presentationHandler?.(presentation);
            continue;
          }
          if (event !== 'item') continue;
          const payload = JSON.parse(data) as DeskItemEvent;
          if (typeof payload.id !== 'string') continue;
          this.scheduleRefresh();
          this.handler?.(payload);
        }
      } catch (err) {
        if (abort.signal.aborted) return;
        this.log('desk.stream.error', { message: (err as Error).message });
      }
      if (!abort.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  async startWorkRepos(): Promise<string[] | null> {
    const body = await this.get<{ repos?: Array<{ name: string }> }>('/api/desk/start-work');
    return body?.repos ? body.repos.map((repo) => repo.name) : null;
  }

  async startWork(request: StartWorkRequest): Promise<StartWorkOutcome> {
    try {
      // A worktree checkout of a large repo takes a while; Loom answers once the thread exists.
      const response = await fetch(`${this.baseUrl}/api/desk/start-work`, { method: 'POST', signal: AbortSignal.timeout(150_000), headers: this.postHeaders(), body: JSON.stringify(request) });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; threadId?: string; itemId?: string; error?: string; projectSkipped?: boolean; plan?: { title?: string; account?: { name?: string; driver?: string } } };
      if (response.ok && body.ok && body.threadId) {
        void this.scheduleRefresh();
        // The desk names the item; older responses may only include its Loom thread id.
        const itemId = body.itemId ?? `loom:${body.threadId}`;
        return { ok: true, threadId: body.threadId, itemId, title: body.plan?.title ?? '', account: body.plan?.account?.name ?? '', ...(body.projectSkipped ? { projectSkipped: true } : {}) };
      }
      return { ok: false, error: body.error ?? `HTTP ${response.status}` };
    } catch (err) {
      this.log('desk.error', { path: '/api/desk/start-work', message: (err as Error).message });
      return { ok: false, error: (err as Error).message };
    }
  }

  async startAgentThread(request: AgentThreadRequest): Promise<AgentThreadOutcome> {
    try {
      const response = await fetch(`${this.baseUrl}/api/desk/agent-threads`, { method: 'POST', signal: AbortSignal.timeout(60_000), headers: this.postHeaders(), body: JSON.stringify(request) });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; threadId?: string; itemId?: string; title?: string; error?: string; projectSkipped?: boolean };
      if (response.ok && body.ok && body.threadId) {
        void this.scheduleRefresh();
        return { ok: true, threadId: body.threadId, itemId: body.itemId ?? `discord:thread:${body.threadId}`, title: body.title ?? request.title ?? '', ...(body.projectSkipped ? { projectSkipped: true } : {}) };
      }
      return { ok: false, error: body.error ?? `HTTP ${response.status}` };
    } catch (err) {
      this.log('desk.error', { path: '/api/desk/agent-threads', message: (err as Error).message });
      return { ok: false, error: (err as Error).message };
    }
  }

  async search(query: string, limit = 5): Promise<DeskSearchHit[] | null> {
    const body = await this.get<{ hits?: DeskSearchHit[] }>(`/api/desk/search?q=${encodeURIComponent(query)}&limit=${limit}`);
    return Array.isArray(body?.hits) ? body.hits : null;
  }

  async projectMembers(projectId: string): Promise<DeskItemSummary[] | null> {
    const body = await this.get<{ items?: DeskItemSummary[] }>('/api/desk/items?view=everything');
    if (!Array.isArray(body?.items)) return null;
    return body.items.filter((item) => item.facts?.projectId === projectId && item.disposition !== 'done');
  }

  async transcript(itemId: string, limit = 6): Promise<DeskMessage[] | null> {
    const body = await this.get<{ messages?: Array<{ author: string; at: number; text: string }> }>(`/api/desk/search/transcript/${encodeURIComponent(itemId)}?limit=${limit}`);
    if (!Array.isArray(body?.messages)) return null;
    return body.messages.map((message) => ({ author: message.author === 'owner' ? 'owner' : message.author === 'agent' ? 'agent' : 'other', at: message.at, text: message.text }));
  }

  async capacity(): Promise<DeskCapacity | null> {
    return this.get<DeskCapacity>('/api/desk/capacity');
  }

  async system(): Promise<DeskSystemBrief | null> {
    return this.get<DeskSystemBrief>('/api/desk/system/brief');
  }

  async moveAccount(itemId: string, account: string, commandId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.post('/api/desk/capacity/move', { itemId, account, commandId });
  }

  async projectAction(projectId: string, action: DeskProjectAction): Promise<{ ok: true; held?: number; acted?: number; stayed?: number } | { ok: false; error: string }> {
    const result = await this.post<{ held?: number; acted?: number; stayed?: number }>(`/api/desk/projects/${encodeURIComponent(projectId)}/action`, action, 60_000);
    if (result.ok) this.projectsAt = 0; // a finished project leaves the list on the next refresh
    return result;
  }

  async catchupWalk(ask: CatchupWalkAsk = {}): Promise<CatchupWalk | 'off' | null> {
    const query = new URLSearchParams();
    if (ask.skipped?.length) query.set('skipped', ask.skipped.join(','));
    if (ask.focus) query.set('focus', String(ask.focus));
    if (ask.space) query.set('space', ask.space);
    const path = `/api/desk/catchup/walk${query.size ? `?${query}` : ''}`;
    try {
      const response = await fetch(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000) });
      // An older desk without the walk, or one with no ledger: the briefing reads instead.
      if (response.status === 404) return 'off';
      return response.ok ? ((await response.json()) as CatchupWalk) : null;
    } catch (err) {
      this.log('desk.error', { path, message: (err as Error).message });
      return null;
    }
  }

  async updatesSeen(ids: number[], via: 'heard' | 'read' | 'deferred', outcome: string | null = null): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.post('/api/desk/updates/seen', { ids, via, ...(outcome ? { outcome } : {}) });
  }

  async chapterPlan(spaceId: string): Promise<ChapterVoicePlan | null> {
    const chapter = await this.get<{ plan?: ChapterVoicePlan }>(`/api/desk/chapters/${encodeURIComponent(spaceId)}`);
    return chapter?.plan ?? null;
  }

  async chapterAct(spaceId: string, how: 'accept' | 'defer', plan: ChapterVoicePlan, commandId: string = randomUUID()): Promise<({ ok: true } & ChapterActResult) | { ok: false; error: string; changed?: boolean; plan?: ChapterVoicePlan }> {
    return this.post<ChapterActResult>(`/api/desk/chapters/${encodeURIComponent(spaceId)}/${how}`, { updateIds: plan.updateIds, revision: plan.revision, commandId }, 60_000);
  }

  async decidedConfirm(decisionId: string, commandId: string = randomUUID()): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.post('/api/desk/decided/confirm', { decisionId, commandId });
  }

  private async post<T extends object>(path: string, payload: unknown, timeoutMs = this.options.timeoutMs ?? 20_000): Promise<({ ok: true } & T) | { ok: false; error: string; changed?: boolean; plan?: ChapterVoicePlan }> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, { method: 'POST', signal: AbortSignal.timeout(timeoutMs), headers: this.postHeaders(), body: JSON.stringify(payload) });
      const body = (await response.json().catch(() => ({}))) as T & { error?: string; changed?: boolean; plan?: ChapterVoicePlan };
      if (!response.ok) return { ok: false, error: body.error ?? `HTTP ${response.status}`, ...(response.status === 409 && body.changed ? { changed: true, plan: body.plan } : {}) };
      void this.scheduleRefresh();
      return { ...body, ok: true };
    } catch (err) {
      this.log('desk.error', { path, message: (err as Error).message });
      return { ok: false, error: (err as Error).message };
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 400);
  }

  private async get<T>(path: string): Promise<T | null> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000) });
      return response.ok ? ((await response.json()) as T) : null;
    } catch (err) {
      this.log('desk.error', { path, message: (err as Error).message });
      return null;
    }
  }
}

/** When an item is due: the summary's due/watchUntil, a due field, or a running job's deadline. Null without one. */
export function deadlineOf(item: Pick<DeskItemSummary, 'summary' | 'due' | 'facts'>): number | null {
  const parse = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const at = Date.parse(value);
      return Number.isFinite(at) ? at : null;
    }
    return null;
  };
  return parse(item.summary?.due) ?? parse(item.summary?.watchUntil) ?? parse(item.due) ?? parse(item.facts?.job?.deadlineAt ?? null);
}

/** Desk messages are agent turns; the latest agent message at or after a time, if any. */
export function agentAnswerSince(messages: DeskMessage[], sinceMs: number): DeskMessage | null {
  return [...messages].reverse().find((message) => message.author === 'agent' && message.at >= sinceMs) ?? null;
}
