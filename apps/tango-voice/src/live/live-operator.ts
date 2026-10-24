import { randomUUID } from 'node:crypto';
import { opensRamble } from '../turn/turn-policy.js';
import { getDecisionShadow } from '@tango/core';
import { STILL_RUNNING_TEXT, type AgentBackend, type AgentDescriptor, type AgentUpdate } from './agent-backend.js';
import type { LiveSessionClient, LiveClientError, LiveContextKind, LiveDelegation, LiveTranscriptDelta } from './gpt-live-client.js';
import type { LivePlaybackClock, SpeechActivity } from './live-audio.js';
import { agentAnswerSince, deadlineOf, needsOwner, reportsUp, type DeskCapacity, type DeskProjectAction, type DeskSystemBrief, type CatchupWalk, type CatchupWalkFocus, type ChapterActResult, type DeskClient, type DeskCommandResult, type DeskCommandType, type DeskItemDetail, type DeskItemEvent, type DeskItemSummary, type DeskMessage, type DeskNextItem, type OperatorStatusUpdate } from './desk-client.js';
import { buildAnswers, describeAnswers, isSingleChoice, matchDecision, mergeAnswers, missingScope, pendingOf, quickPick, speakPending } from './desk-pending.js';
import { describeAge, type ThreadDirectory, type ThreadInfo } from './discord-threads.js';
import { DraftSession, addressedToOperator, contentWords, isPlainYes, matchDraftFinish, normalizeSpeech, sameStem, type DraftHost, type DraftItemRef, type ItemBrief, type PickScreen } from './draft-mode.js';
import { matchNextCommand, nextSummary, type NextOp } from './next-up.js';
import { matchCatchupCommand, optionFor, spaceNamed, speakFocus, speakLeft, type CatchupOp } from './catchup-walk.js';
import { AddresseeAsk, addresseeNames, isUnsureMarker, matchAddresseeAnswer, namesSomeone, UNSURE_REASON, type FillerGate } from './addressee.js';
import { DestinationAsk, destinationAnswerKey, destinationDecisionPrompt, destinationQuestion, matchDestinationAnswer, withDestination, type DestinationOption } from './destination-ask.js';
import { MAX_HELD_LATE } from './operator-session.js';
import { askWhenOnlySpaceNamed, describeStartPlace, preferNewThread, startPlace, type StartPlace } from './start-place.js';
import { PauseSession, resumePriority, type PauseHost, type PausedUpdate } from './pause-mode.js';
import { choiceLabel, type ListPage, type PresentationIntent, type PresentationState, type ScreenDirector, type ScreenHandlers, type ScreenScene } from './screen-director.js';
import {
  PROTOTYPE_PAGE_OPS,
  resolvePointedChoice,
  type DeskOp,
  type DeskOpArgs,
  type ExtractorDesk,
  type ExtractorScreen,
  type ExtractorTask,
  type ExtractorThread,
  type OperatorAction,
  type ScreenOp,
  type TaskExtractor,
  keepMainChannel,
  isCodingItemId,
  preferNamedLoom,
  type ScreenPicker,
} from './task-extractor.js';

// The operator sits between GPT-Live (which owns the spoken conversation) and
// Tango agents (which own the work). GPT-Live emits a client delegation when
// it wants help; the operator works out which agent and what task, dispatches
// it, and feeds results back when the conversational floor allows.
//
// It is a client of the Agent Desk (docs/specs/agent-desk.md): the desk discovers
// every conversation and owns what the owner has seen; the operator reads it, acts
// through desk commands (each with its own command id), and asks the desk's
// presentation hub to show the conversation being talked about.

export type DeliveryPolicy =
  /** Append results as commentary the moment they arrive. */
  | 'immediate'
  /** Hand results to GPT-Live as silent context and let it pick the moment. */
  | 'model'
  /** Queue results and release one at a time when the conversation goes quiet. */
  | 'floor';

export interface FloorOptions {
  /** Both parties quiet this long before a queued update is released. */
  settleMs: number;
  /** After releasing an update, give the operator this long to start saying it. */
  speakTimeoutMs: number;
  /** Re-release an update that was cut off at most this many times. */
  maxAttempts: number;
}

export interface LiveOperatorOptions {
  client: LiveSessionClient;
  agents: AgentDescriptor[];
  backend: AgentBackend;
  extractor: TaskExtractor;
  userActivity: SpeechActivity;
  playback: LivePlaybackClock;
  /** Extra "user is about to talk / talking" signal, e.g. Discord speaking events. */
  isUserSpeaking?: () => boolean;
  policy?: DeliveryPolicy;
  floor?: Partial<FloorOptions>;
  /** Wait for transcript deltas to catch up before reading the request. */
  transcriptSettleMs?: number;
  /** Before reading the request, wait for the user to be quiet this long (default 1.5 s, at most 8 s). */
  endOfSpeechMs?: number;
  /** How long a spoken hand-off promise may go without a delegation before the operator acts (default 4 s). */
  promiseTimeoutMs?: number;
  /** Threads the operator can route to and create. */
  threads?: ThreadDirectory;
  /** Condenses long notices for speech. */
  summarize?: (agentId: string, text: string, question?: string) => Promise<string>;
  /** Judges screen vs conversation when a conversation opens (relevance over recency); without it, recency decides. */
  pickScreen?: ScreenPicker;
  /** An agent's home channel: its conversation key is channel:<id>. */
  homeChannelFor?: (agentId: string) => string | undefined;
  /** The screen service; the operator directs what it shows while the session is live. */
  screen?: ScreenDirector;
  /** The Agent Desk: every conversation, the owner's attention, and commands. */
  desk?: DeskClient;
  /**
   * The chief of staff: where unclear requests and judgment calls go ("who should take
   * this", "what should I tackle first", "chase Foxtrot") instead of asking the user.
   */
  defaultAgentId?: string;
  /** Bounds on calls that can hang (router, thread directory, desk, summaries, GPT-Live acks). */
  timeouts?: Partial<OperatorTimeouts>;
  /** With `deadline` in the urgent lane: a your-move item is spoken unprompted when its deadline is this close (default 30 min). */
  deadlineWindowMs?: number;
  /**
   * When the owner's voice session began: they joined the call. It outlives brains (sleep, reconnects)
   * and operator restarts. A session starts clear: only what the owner asked or directed since then is
   * spoken; everything else waits for "what's waiting" / "catch me up" (TGO-1050). Defaults to this operator's start.
   */
  sessionStartedAt?: number;
  /**
   * Owner turns whose answer was spoken this session (one answer per owner message). Owned by the voice
   * session so it outlives brains and restarts (VoiceSessionMemory); one per operator when omitted.
   */
  answeredTurns?: AnsweredTurns;
  /**
   * Was the voice model asleep at this time? What the owner typed then (desk, Discord) was for that thread,
   * not for voice, so its answer isn't spoken on wake (TGO-1050). Nothing counts as asleep when omitted.
   */
  asleepAt?: (at: number) => boolean;
  /** How long after the owner's last word a desk command GPT-Live didn't delegate is routed anyway (default 4 s). */
  unroutedCommandMs?: number;
  /** Optional cap on how old an owner message (in this session) may be for its answer to be relayed. None by default. */
  recentExchangeMs?: number;
  /** How long after the owner last talked with a personal agent (food, health, a workout) work news waits (default 10 min). */
  personalFlowMs?: number;
  /**
   * The urgent lane: the only things spoken without being asked. Empty by default (TGO-1050): `deadline`
   * speaks your-move items about to come due; `scene` speaks another agent's urgent screen.
   */
  urgentLane?: readonly UrgentClass[];
  /** After the call has been idle this long (no speech, nothing pending), the screen goes back to the board (default 2 min). */
  idleBoardMs?: number;
  /** Idle wait before leaving a staged Screen view (default 10 min). */
  idleScreenMs?: number;
  /** How the user is named in screen captions (default "You"). */
  userName?: string;
  /**
   * After stop(), agent results that come back for this session's requests, and updates still
   * queued or being relayed, go here (the session owner hands them to the next session).
   */
  onLateUpdate?: (late: LateUpdate) => void;
  /**
   * Draft mode and the "Is that everything?" safety net (draft-mode.ts). Owned by the voice
   * session so a draft survives a GPT-Live reconnect; one per operator when omitted.
   */
  draft?: DraftSession;
  /**
   * Pause mode (pause-mode.ts): "Yankee, pause" holds every message in silence until "Yankee, I'm
   * back". Owned by the voice session so a pause survives reconnects and sleep; one per operator when omitted.
   */
  pause?: PauseSession;
  /** "Main chat, or the … thread?" (destination-ask.ts). Owned by the voice session so the question survives a reconnect. */
  destination?: DestinationAsk;
  /** "For me?" (addressee.ts): work from speech the router isn't sure was meant for the operator waits for a yes. */
  addressee?: AddresseeAsk;
  /** Ask "For me?" before acting on speech the router isn't sure was meant for the operator (default on). */
  addresseeCheck?: boolean;
  /** The filler gate on the voice model's audio (addressee.ts): opened whenever the backend gives it something to say. */
  fillerGate?: FillerGate;
  /**
   * Kept by the voice session so it survives sleep and reconnects: when the owner last spoke at all
   * (`lastAt`, the quiet the router hears about), and when he last got something done through the
   * operator (`addressedAt`; after two minutes a short command that changes something asks "For me?").
   */
  ownerSpeech?: { lastAt: number | null; addressedAt?: number | null };
  log?: (event: string, data?: Record<string, unknown>) => void;
  /** The voice session these decisions belong to, in the desk's session trace. */
  traceSessionId?: string;
  now?: () => number;
}

export interface OperatorTimeouts {
  /** One router (task extractor) call, thread list included. */
  extractorMs: number;
  /** Listing or creating Discord threads. */
  threadsMs: number;
  /** Desk reads, commands and presentation intents. */
  deskMs: number;
  /** Sending the user's words into a desk item's conversation. */
  replyMs: number;
  summarizeMs: number;
  /** GPT-Live acknowledging an appended context item. */
  appendMs: number;
}

const DEFAULT_TIMEOUTS: OperatorTimeouts = { extractorMs: 30_000, threadsMs: 8000, deskMs: 10_000, replyMs: 25_000, summarizeMs: 20_000, appendMs: 10_000 };

/** A call that did not answer within its bound. */
export class OperatorTimeout extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms} ms`);
    this.name = 'OperatorTimeout';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OperatorTimeout(label, ms)), ms);
  });
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer));
}

/**
 * One message sent to an agent, fixed at send time. A task's turn and delegation move on
 * when the user replies; a result belongs to the request it answers, never to the newest one.
 */
export interface RequestSnapshot {
  readonly id: string;
  readonly taskId: string;
  readonly turn: number;
  readonly delegationId: string | null;
  readonly threadId: string | null;
  readonly sentAt: number;
  /** The words sent to the agent: the question its answer has to cover when spoken. */
  readonly message: string;
}

/** Owner turns whose answer was already spoken this session: `has` / `add` by key. */
export interface AnsweredTurns {
  has(key: string): boolean;
  add(key: string): void;
}

/** What may speak unprompted, in the urgent lane (TGO-1050). */
export type UrgentClass = 'deadline' | 'scene';

/** `TANGO_OPERATOR_URGENT=deadline,scene` → the urgent lane; anything else is ignored. */
export function parseUrgentLane(value: string | undefined): UrgentClass[] {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part): part is UrgentClass => part === 'deadline' || part === 'scene');
}

/** An update an operator could not deliver because its session ended; the next session relays it. */
export interface LateUpdate {
  agent: AgentDescriptor;
  update: AgentUpdate;
  place?: string;
  /** The request it answers, when it is an agent result. */
  request?: RequestSnapshot;
  /** The conversation it belongs to (thread:<id> / channel:<id> / loom:<id>), to mark it heard on the desk. */
  conversationKey?: string;
  deskItemIds?: string[];
  kind: 'result' | 'notice';
  /** A failed turn (played first after a pause). */
  failed?: boolean;
}

/** Whether the desk (or the source behind it) accepted something the operator sent; draft mode keeps an unaccepted draft. */
interface DeliveryOutcome {
  ok: boolean;
  error?: string;
}

/** A thread could not be looked up or opened: the request was not sent anywhere. */
class ThreadUnavailable extends Error {}

export interface OperatorTask {
  id: string;
  agent: AgentDescriptor;
  request: string;
  /** null when the operator raised the request itself (GPT-Live doesn't know about it). */
  delegationId: string | null;
  status: 'running' | 'waiting_user' | 'done';
  turn: number;
  lastUpdate?: string;
  /** Complete text of the last update, when what was spoken was condensed. */
  lastFullText?: string;
  progress?: string;
  createdAt: number;
  /** When the latest message for this task went out (initial request or a reply). */
  lastSentAt?: number;
  thread?: ThreadInfo;
}

type QueuedKind = 'result' | 'notice' | 'readback';

/** A mode holding agent updates back (see holdUpdates). */
export type HoldReason = 'pause' | 'draft';

function normalizePrompt(prompt: string | undefined): string {
  return (prompt ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * GPT-Live rewords a re-fired delegation a little: nearly the same words is the same request.
 * Any differing number or name-like detail ("invoice 100" vs "invoice 101") makes it a new one.
 */
function samePrompt(a: string, b: string): boolean {
  if (a === b) return true;
  const numbers = (text: string) => (text.match(/\d+/g) ?? []).join(' ');
  if (numbers(a) !== numbers(b)) return false;
  // Short words can carry the meaning ("lights on" vs "lights off"): keep them, minus filler.
  const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'is', 'it', 'me', 'my', 'we', 'us', 'user', 'wants', 'asks', 'ask', 'please', 'and', 'for', 'that', 'this', 'with', 'about', 'can', 'you', 'have', 'tell', 'them', 'their', 'his', 'her']);
  const words = (text: string) => new Set(text.split(' ').filter((word) => word.length > 0 && !STOP.has(word)));
  const wordsA = words(a);
  const wordsB = words(b);
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  const shared = [...wordsA].filter((word) => wordsB.has(word)).length;
  // Every content word of the shorter one appears in the longer one.
  return shared === Math.min(wordsA.size, wordsB.size);
}

/**
 * GPT-Live sometimes delegates a leftover fragment of a sentence the user already finished
 * ("um, because I think we've got everything else"): every word of the prompt was already said.
 */
function fragmentOf(prompt: string, said: string): boolean {
  const words = prompt.split(' ').filter((word) => word.length > 1);
  if (words.length === 0) return true;
  const heard = new Set(said.split(' '));
  return words.filter((word) => heard.has(word)).length >= Math.ceil(words.length * 0.8);
}

/** How long after playback stops the owner's transcript may still arrive. */
const TRANSCRIPT_GRACE_MS = 2500;

/** The owner has been quiet this long before a knock (a break, not a beat between sets). */
const KNOCK_QUIET_MS = 20_000;
/** An exchange stays open this long after the last thing sent into it that is still unanswered. */
const OPEN_EXCHANGE_MS = 15 * 60_000;
/** After the owner hears an answer they may reply: no knock for this long. */
const AFTER_ANSWER_MS = 20_000;
/** A knock waiting longer than this is dropped; the catch-up has it. */
const KNOCK_EXPIRES_MS = 3 * 3_600_000;

/** "Malibu has something for you." One knock for however many are waiting. */
export function knockText(labels: string[]): string {
  const names = [...new Set(labels)];
  if (names.length === 1) return `${names[0]} has something for you.`;
  if (names.length === 2) return `${names[0]} and ${names[1]} have something for you.`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more have something for you.`;
}

/** What the voice model is told about work news the owner didn't start: plain words, one sentence. */
/** Catch me up on a System incident: it's acked or snoozed on the System page, never from the walk (as on the page). */
const SYSTEM_ONLY = '[That one is a System incident: it is acked or snoozed on the System page, not from here. Say so, and that next moves on.]';
const PLAIN_NEWS = ' Say what changed in one plain sentence. Never read out ticket or issue ids, PR numbers, decision or rule ids, or CI or check names; if you need to refer to one, say "the ticket" or "the PR".';

const BACKCHANNEL = new Set(['mm', 'mmm', 'hm', 'hmm', 'mhm', 'uh', 'um', 'huh', 'yeah', 'yep', 'yes', 'ok', 'okay', 'right', 'sure', 'nice', 'cool', 'got', 'it', 'uh-huh', 'mm-hmm', 'ah', 'oh']);

/** Words in what the owner said that aren't a backchannel ("mm", "yeah", "okay"). */
function realWords(text: string): number {
  return text.toLowerCase().split(/[^a-z'-]+/).filter((word) => word.length > 0 && !BACKCHANNEL.has(word)).length;
}

/** Hidden by the rules file or filtered off the board: the owner chose not to hear about it unprompted. */
/** The speech names this conversation: every word of its title, or one with "job" / "worker" ("the delivery monitor job"). */
function namesItem(speech: string, item: DeskItemSummary): boolean {
  const place = item.place ?? '';
  const title = contentWords(place.includes('·') ? place.slice(place.lastIndexOf('·') + 1) : place);
  const said = contentWords(speech);
  if (!title.length || !said.length) return false;
  const hits = title.filter((word) => said.some((heard) => sameStem(word, heard))).length;
  return hits === title.length || (hits > 0 && /\b(?:jobs?|workers?)\b/i.test(speech));
}

/**
 * The owner's own latest message in a conversation (at or before `before`): not agent mail, which lands as
 * an owner turn (meta.mail), and not an intake thread's opening form request (discord:intake:<channel>:<its
 * message id>), which whoever filled in the form wrote.
 */
function ownerTurnOf(item: DeskItemDetail, before = Number.POSITIVE_INFINITY): DeskMessage | null {
  const request = item.id.startsWith('discord:intake:') ? item.id.slice(item.id.lastIndexOf(':') + 1) : null;
  return (
    [...(item.messages ?? [])]
      .reverse()
      .find((message) => message.author === 'owner' && message.at <= before && !isMail(message) && !(request && message.messageId === request)) ?? null
  );
}

/**
 * Agent mail: marked (meta.mail), or the turn Loom writes into the thread for it, which may carry no meta
 * (the desk's MAIL_HEADER forms: Mail from, Reply from, Mail to, Started).
 */
const isMail = (message: DeskMessage) => Boolean(message.meta?.mail) || /^✉️ (?:Mail from|Reply from|Mail to|Started) “/u.test(message.text.trimStart());

const answeredKey = (item: DeskItemSummary, owner: DeskMessage) => `${item.id}:${owner.at}`;

function offBoard(item: DeskItemSummary): boolean {
  return item.hidden === true || (Array.isArray(item.filteredBy) && item.filteredBy.length > 0);
}

/** Work conversations (coding threads, Loom threads): news the owner hears in the catch-up unless they asked. */
function isWorkItem(item: DeskItemSummary): boolean {
  return item.source === 'loom' || item.id.startsWith('loom:');
}

/** How long after the owner last talked with a personal agent (food, health, workouts) work news still waits. */
const PERSONAL_FLOW_MS = 10 * 60_000;

/** An owner turn that is a desk decision answer (a tap), not something said to the thread. */
const DECISION_TURN = /^Decision D-\d+\b/;

/**
 * Agent text as it should be heard: no ticket, PR, decision or rule ids (the owner doesn't have them
 * memorized). The voice model also gets the instruction to say what changed in plain words; this is the floor.
 */
export function withoutIds(text: string): string {
  return text
    .replace(/\b(?:PRs?|pull requests?)\s*#?\d+\b/gi, 'the PR')
    .replace(/\bD-\d+\b/g, 'the decision')
    .replace(/\bR-\d+\b/g, 'the rule')
    .replace(/\b[A-Z]{2,6}-\d+\b/g, 'the ticket')
    .replace(/(^|[\s(])#\d{3,}\b/g, '$1the PR')
    .replace(/[ \t]{2,}/g, ' ');
}

/**
 * A thread title as it should be said aloud: without the repo label and type prefix Loom places carry
 * ("acme · watch: Publishing Flow" → "Publishing Flow").
 */
export function spokenThread(place: string | null): string | null {
  if (!place) return null;
  const title = place.includes(' · ') ? place.slice(place.indexOf(' · ') + 3) : place;
  const bare = title.replace(/^[a-z]{2,10}:\s*/i, '').trim();
  return bare || null;
}

/** Handles (i1…, S1…) as one extraction saw them. */
interface ExtractionHandles {
  desk: Map<string, string>;
  scenes: Map<string, string>;
  /** The owner's own words this extraction acted on (checks a model's approval scope against them). */
  speech?: string;
}

/** What may still run when GPT-Live re-delegates with nothing new said: lookups, no sends or marks. */
const SAFE_WITHOUT_SPEECH: ReadonlySet<OperatorAction['type']> = new Set(['status', 'readback', 'screen', 'remind', 'search', 'capacity', 'system', 'none']);

/** Owner silence after which a short command that changes something asks "For me?" first. */
const COLD_QUIET_MS = 120_000;
/** How long after an agent's answer was relayed a response the router let pass still goes back to that agent (10/19: 2.4 min). */
const FOLLOW_UP_WINDOW_MS = 5 * 60_000;
/** Shorter responses ("thanks", "got it", "that's wild") are acknowledgements the operator answers itself. */
const FOLLOW_UP_MIN_WORDS = 8;

/** Sends, replies, drafts and desk changes; not reading, opening, moving the screen or catching up. */
function changesSomething(action: OperatorAction): boolean {
  if (action.type === 'desk') return action.op !== 'read' && action.op !== 'open' && action.op !== 'stands';
  return action.type === 'dispatch' || action.type === 'reply' || action.type === 'draft' || action.type === 'project' || action.type === 'undo';
}

/** Lowercased words only, for matching a message the user sent against how its conversation shows it. */
function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const persona = (id: string) => id.replace(/-ollama$/, '');
/** A coding thread's desk item (Loom): reached through its own conversation, never an agent. */
const isCodingItem = (item: { id: string; source?: string }) => item.source === 'loom' || isCodingItemId(item.id);
/** Who a desk item belongs to, for naming: an agent's persona, or `coding` for every Loom thread alike. */
const ownerKey = (item: { id: string; source?: string; agentId: string }) => (isCodingItem(item) ? 'coding' : persona(item.agentId));
/** A desk source id the router may name for coding threads ("loom"). */
const isCodingSourceId = (id: string) => persona(id) === 'loom';

interface QueuedUpdate {
  kind: QueuedKind;
  agent: AgentDescriptor;
  task?: OperatorTask;
  /** The exact request this result answers (immutable; the task may have moved on). */
  request?: RequestSnapshot;
  update: AgentUpdate;
  /** Where it happened, e.g. a thread title. */
  place?: string;
  delegationId: string | null;
  arrivedAt: number;
  attempts: number;
  /** Release as soon as the user stops talking instead of waiting for the floor to settle. */
  urgent?: boolean;
  /** Read-back position, e.g. "part 2 of 3". */
  part?: string;
  /** A "remind me" summary or a briefing line: read as-is, not as an agent's words. */
  reminder?: boolean;
  /** The answer to a request that outlived the backend's wait, posted later. */
  late?: boolean;
  /** The conversation it belongs to; its desk item is marked heard once it is spoken. */
  conversationKey?: string;
  /** Desk items it speaks for (known up front: briefings, desk notices). */
  deskItemIds?: string[];
  /** The desk command sent once it was heard without interruption (default heard). */
  deskMark?: 'heard' | 'briefed';
  /** Catch-up lines it reads (a walk's focus): marked seen, via heard, once it played through. */
  heardUpdates?: number[];
  heardPlan?: { spaceId: string; plan: NonNullable<CatchupWalkFocus['plan']> };
  /** A catch-up walk's read-back: retired, not retried, once the owner moves the walk on. */
  walkReadback?: boolean;
  /** The read-back of the conversation the owner just opened (its item id): it goes out through that draft's hold, and only while that draft is still open. */
  focusReadback?: string;
  /** Open this item's conversation on the screen when it is released (briefing items). */
  focusItemId?: string;
  /** A turn that failed (played first after a pause). */
  failed?: boolean;
  /** A knock: "<who> has something for you." The content is not said; the owner asks for it or gets it in the catch-up. */
  knock?: boolean;
}

interface PendingDelivery {
  item: QueuedUpdate;
  releasedAt: number;
  keywords: string[];
  spoken: string;
  /** The user talked while the operator was relaying this update. */
  overlapped: boolean;
  /** What the owner said once playback started (voice activity alone is not talking over it). */
  overlapWords: string;
  /** Owner voice activity was detected while the update was playing. */
  overlapActivity: boolean;
  /** A new utterance began after playback: later words are an answer, not part of an interruption. */
  captureClosed: boolean;
}

interface TranscriptLine {
  speaker: 'user' | 'operator';
  text: string;
  startMs: number;
  endMs: number;
  /** Characters of `text` already handed to the extractor. Lines can grow after they're read. */
  consumed: number;
  /** Wall clock of the last delta (captions). */
  updatedAt: number;
  /** Published to the desk as final. */
  final: boolean;
  /** Said while paused (pause mode): never read, captioned or kept; dropped once checked for the resume command. */
  paused?: boolean;
  /** User lines: how long the owner, and anyone, had been silent before it began (null: nothing before). */
  quietBefore?: { ownerMs: number | null; anyMs: number | null };
}

/** A conversation this session expects an answer in, which only the desk will see. */
interface SessionWatch {
  kind: 'late' | 'reply';
  agent: AgentDescriptor;
  sentAt: number;
  until: number;
  task?: OperatorTask;
  request?: RequestSnapshot;
  /** What the user said in a desk reply: the question the answer is spoken against. */
  asked?: string;
  itemId?: string;
  place?: string | null;
}

/** Phrases where the operator tells the user it is handing something off or checking. */
const HANDOFF_PROMISE =
  /\b(on it|checking|send(ing)?|sent|pass(ing)?|relay(ing)?|forward(ing)?|ask(ing)?|check(ing)? (with|on)|let me (check|confirm|ask|find)|i'?ll (check|ask|get|find|send|pass)|(thumbs up|reaction|heart|check ?mark) (added|done)|added|parked|marked|skipped|snoozed|noted)\b/i;

/**
 * The chief of staff among the agents: TANGO_OPERATOR_CHIEF, else Watson (or its
 * -ollama clone in test mode). Undefined when no such agent is on the roster.
 */
export function chiefOfStaff(agents: AgentDescriptor[], preferred = process.env.TANGO_OPERATOR_CHIEF?.trim() || 'watson'): AgentDescriptor | undefined {
  return agents.find((agent) => agent.id === preferred) ?? agents.find((agent) => agent.id === `${preferred}-ollama`);
}

export function buildOperatorInstructions(agents: AgentDescriptor[], defaultAgent: AgentDescriptor | undefined = chiefOfStaff(agents)): string {
  const roster = agents.map((agent) => `- ${agent.name}: ${agent.role}`).join('\n');
  return [
    'You are Yankee, the operator for a small team of AI agents. You talk with the user by voice and route work to the team. The user may call you "Yankee".',
    'Speak casually and briefly, like a sharp executive assistant. One or two sentences unless the user asks for detail.',
    '',
    'Pacing policy: The user talks slowly and thinks out loud, with long pauses in the middle of a thought. A pause is not the end of a turn.',
    '- If what they said so far is unfinished (trails off on "and", "um", "so", a comma, or a half-made point), stay completely silent and keep listening, however long the pause.',
    '- Only respond once they have made a complete request or question, or clearly hand the turn to you.',
    '- When unsure whether they are done, wait. Answering late is fine; cutting in is not.',
    'Backchannel policy: No backchannels. Never fill a pause with "mm", "go on", or "I\'m with you". Do not talk over the user.',
    '- A lone "mm", "uh", "hmm", a sniff, a cough or a click is not a turn: say nothing to it. Never answer it with "go ahead", "I\'m here" or "I didn\'t catch that".',
    '- You are always listening, so you also hear speech not said to you: people nearby, someone thinking aloud, singing, a video. If it was not said to you, say nothing.',
    'Interruption policy: Stop speaking when the user interrupts. Listen to what they say.',
    '',
    'Delegation policy:',
    'Backend tools:',
    `- The agent team, each with a specialty:\n${roster}`,
    '- The desk: every open conversation across the agents and the coding threads (Loom), also on the user\'s screen. The backend reads it, marks items, and moves the screen.',
    'Delegate to the backend when:',
    '- The user asks an agent (by name or role) to do something, check something, or look something up.',
    '- The user answers a question an agent asked, approves or rejects an agent\'s proposal, picks an option, or gives an agent feedback.',
    '- The user responds to what an agent just reported: agrees ("you\'re right"), pushes back, builds on it, or shares a thought it sparked, even with no question in it. That is a conversation with that agent, not with you: delegate it instead of discussing it yourself.',
    '- The user asks what is pending, how an agent is doing, what came back, or whether anything new came in.',
    '- The user asks you to read something back in full or word for word.',
    '- The user wants to be caught up ("catch me up", "what\'s on my desk"). Always delegate, even when you think you know: the backend reads the desk one item at a time.',
    '- The user wants to move on to the next thing waiting on them ("next one", "next up", "on to the next one", "go to the next one", "Yankee, next"), or asks what is waiting ("what\'s next", "what\'s up", "what\'s waiting on me", "what do I have", "what\'s left"), or picks from a list you just read ("the second one", "the speaker one"). Always delegate, and say nothing first: the backend opens the next one or gives you the list to say.',
    '- The user acknowledges something an agent said ("thanks", "got it", "seen"), or says what to do with an item: done, park it, snooze it (until a time, "until I\'m at my desk", "until they post"), pick it back up, retry it, stop it ("stop that" while you are not speaking means the open thread\'s running turn), rename it, pin it, mark it unread, move it to a project or another account, undo that. These are not messages to the agent: never say you will pass it along.',
    '- The user talks about one item ("what\'s this one about", "show me the Foxtrot one", "tell it yes"). Always delegate, even when a briefing you just read seems to answer it: the backend opens the item and needs to know which one "that one" is.',
    '- The user picks a conversation to work on, often by just naming its topic ("okay, news-letter promotion", "let\'s talk about the shed vents", "pull up the speaker thread", "let\'s work on X"). Always delegate it: the backend opens it and starts a draft for it.',
    '- The user wants to change or move what is on their screen: show the board, show the screen, show an agent\'s scene, open the prototype, next step, play or pause, or scroll ("scroll down", "keep going"). Delegate it every time, even a repeated "more", and confirm in a word or two or not at all.',
    '- The user drives the prototype on the screen: click or tap something on it ("click Continue", "hit sign up"), type into it, jump to a section, or go back a page. Delegate it every time and say nothing, or a word: they watch it happen.',
    '- The user talks to or about a coding thread (a Loom thread, listed on the desk by repo and title), or asks for a new one. Delegate it. A coding thread is not an agent and not the chief of staff.',
    ...(defaultAgent
      ? [`${defaultAgent.name} is the chief of staff: delegate to it when the user names it or wants its judgment across agents ("what should I tackle first"). It is not a default: when it is unclear who or which thread should take something, the backend asks the user, and so do you.`]
      : []),
    'Do not delegate to the backend when:',
    '- The user is chatting, thinking out loud, or asks you to repeat something already said. Responding to an agent\'s answer you just relayed is not chatting with you.',
    ...(defaultAgent ? [] : ['- You need a brief clarification of who should handle it.']),
    'Delegate before answering anything that depends on an agent\'s work. Never invent an agent\'s answer.',
    'Never claim a message was sent, delivered, forwarded, or passed on unless a backend instruction or commentary explicitly confirms successful dispatch for that message. Delegating is not sending: routing may instead open or hold a draft, ask a question, or fail. A user saying send it is not proof of delivery. While waiting, never invent a success confirmation.',
    'After delegating, say only a neutral "On it." or "Checking." Never name where it is going: the backend tells you where it went, and then you confirm that in a few words ("Sent to Sierra."). Do not confirm twice. In draft mode, say nothing after delegating.',
    '',
    'Relaying updates:',
    '- Agent updates arrive as commentary. Attribute them: "Sierra says…". When the conversation was on another agent\'s topic, transition first: "Okay, now Juliet said…".',
    '- If an agent asks a question, put it to the user plainly and wait for the answer.',
    '- Updates may name a thread ("in the PR 412 thread"); mention it so the user knows where the work lives.',
    '- New items the user did not ask for arrive as commentary too; introduce them as new ("New from Watson in the Bike thread…").',
    '- When asked to read something back in full, read the commentary word for word; do not summarize it.',
    'Threads: the user may ask to work in a thread ("in the Bike thread", "start a thread with Sierra about the Pinecrest trip"). Delegate those like any other request.',
    '- Background notes about task state are for you only. Do not read them out.',
    'Keep listening while the user pauses to think.',
    'Pause: "Yankee, pause" (or "Yankee, hold my messages", "Yankee, give me a minute") and "Yankee, I\'m back" (or "Yankee, resume", "Yankee, what did I miss") are handled by the backend; older habits say "Tango" instead of "Yankee", which means the same. Do not answer them yourself; wait to be told what to say.',
  ].join('\n');
}

/** How long to keep watching a conversation for the answer to a request the backend stopped waiting on. */
const LATE_ANSWER_WATCH_MS = 20 * 60_000;

/** How long to watch a desk conversation the user replied into (a Loom turn can run a while). */
const REPLY_WATCH_MS = 6 * 3_600_000;

/** Playback quiet this long after an update started playing: it finished, it wasn't cut short. */
const PLAYBACK_DONE_MS = 400;

/** While a delegation is being routed, a ready update waits at most this long for it. */
const EXTRACTION_HOLD_MS = 1500;

/** Partial captions go to the desk at most this often (≤ 4/s). */
const CAPTION_INTERVAL_MS = 250;

/** The longest extractor desk listing (compact lines). */
const DESK_LISTING_CAP = 60;

const STOPWORDS = new Set(
  'the and for that this with from have will your you are was were but not they them then than there their what when where which who would could should about into over also just been being does done some more most very only after before because while until each other such like can may might must here okay yeah they\'re it\'s'.split(' '),
);

/** Content words and numbers used to tell whether the operator actually relayed an update. */
export function deliveryKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  const words = (lower.match(/[a-z][a-z']{2,}/g) ?? []).filter((word) => !STOPWORDS.has(word));
  // "6:00 PM" is usually spoken as "6 PM": keep the leading number, drop ":00".
  const numbers = (lower.match(/\d+(?:\.\d+)?/g) ?? []).filter((number) => number !== '00');
  return [...new Set([...words, ...numbers])];
}

/** The conversation key for a Discord channel id the operator knows is a thread or a home channel. */
function threadKey(threadId: string): string {
  return /^\d+$/.test(threadId) ? `thread:${threadId}` : threadId;
}

// "it", "that one", "the Foxtrot one", "the Pinecrest thread"…
// (Longer forms first, so "that one" is matched whole rather than as "that".)
const TARGET = `(?:that one|this one|it|that|this|the [a-z0-9' -]{1,40}? (?:one|thread|item|conversation))`;
const QUICK_ITEM_COMMANDS: Array<{ op: DeskOp; pattern: RegExp }> = [
  { op: 'done', pattern: new RegExp(`\\b(?:mark ${TARGET} (?:as )?done|${TARGET} is done|that'?s done|done with ${TARGET})\\b`) },
  { op: 'seen', pattern: new RegExp(`\\bmark ${TARGET} (?:as )?(?:seen|read)\\b`) },
  { op: 'park', pattern: new RegExp(`\\bpark ${TARGET}\\b`) },
  { op: 'pickup', pattern: new RegExp(`\\b(?:pick ${TARGET} (?:back )?up|unpark ${TARGET})\\b`) },
  { op: 'retry', pattern: new RegExp(`\\b(?:retry ${TARGET}|try ${TARGET} again)\\b`) },
  { op: 'snooze', pattern: new RegExp(`\\bsnooze ${TARGET}\\b`) },
  { op: 'unseen', pattern: new RegExp(`\\bmark ${TARGET} (?:as )?(?:unread|new)\\b`) },
  { op: 'reopen', pattern: new RegExp(`\\breopen ${TARGET}\\b`) },
  { op: 'unpin', pattern: new RegExp(`\\bunpin ${TARGET}\\b`) },
  { op: 'pin', pattern: new RegExp(`\\bpin ${TARGET}\\b`) },
];
/** "Undo that", "undo", "undo the last one": the last desk change voice made (as the whole utterance). */
const QUICK_UNDO = /^(?:(?:ok(?:ay)?|oops|no|wait|please|actually)\s+)*undo(?: (?:that|it|this|the last (?:one|thing|change)))?(?: please)?$/;
/** "Stop that", "stop this thread, it's going the wrong way": the open thread's running turn (the words after are the why). */
const QUICK_STOP = /^(?:(?:ok(?:ay)?|wait|no|hey|please)\s+)*(?:stop|halt|interrupt) (?:that|this|it)(?: thread| one| turn| conversation)?(?:$|[ ,.;:!])/;
/**
 * Desk commands GPT-Live can answer itself ("stop that" → "Okay.", as if told to stop talking) or let pass
 * in silence ("rename this to …"): heard and not delegated, they are routed anyway (live audio test 10/18).
 */
// Imperatives only, at the start of what was said: "should I pin this?" or "why would I mark it done?" are not commands (Codex review on #750).
const UNROUTED_LEAD = '^(?:(?:ok(?:ay)?|alright|so|and|now|wait|hey|please|actually|yes|yeah|no)\\s+)*(?:(?:can|could|would) you\\s+)?';
// The whole utterance: "mark this done after Sierra replies" or "pin this and mark it done" are the router's (Codex review on #750).
const UNROUTED_TAIL = '(?:\\s+(?:please|now|thanks|thank you|for me))*$';
const UNROUTED_COMMANDS: RegExp[] = [
  QUICK_UNDO,
  new RegExp(`${UNROUTED_LEAD}(?:stop|halt|interrupt) (?:that|this|it)(?: thread| one| turn| conversation)?${UNROUTED_TAIL}`),
  new RegExp(`${UNROUTED_LEAD}(?:mark ${TARGET} (?:as )?(?:done|seen|read|unread|new)|park ${TARGET}|unpark ${TARGET}|pick ${TARGET} (?:back )?up|retry ${TARGET}|try ${TARGET} again|snooze ${TARGET}|reopen ${TARGET}|unpin ${TARGET}|pin ${TARGET})${UNROUTED_TAIL}`),
  // A new name or a place is the rest of it; the router (never the quick matcher) reads these.
  new RegExp(`${UNROUTED_LEAD}(?:rename ${TARGET} (?:to|as)|move ${TARGET} (?:to|into|out of)) (?!.*\\b(?:and (?:then )?(?:pin|mark|park|snooze|stop|move|rename)|after|once|when|until|if)\\b)`),
];
/** A stop anywhere in what was said (QUICK_STOP is the whole utterance's start). */
const ANY_STOP = /\b(?:stop|halt|interrupt) (?:that|this|it)\b/;
/** One owner utterance the unrouted-command net watches: from its first word to where the next began. */
interface UnroutedWindow {
  since: number;
  from: { line: TranscriptLine; offset: number };
  to: { line: TranscriptLine; offset: number } | null;
  overSpeech: boolean;
  /** The operator spoke after it: the owner's next words are a new utterance. */
  answered: boolean;
  timer: NodeJS.Timeout | null;
}
/** "Show me the capacity page", "open capacity": the Capacity page (as the whole utterance). */
const QUICK_CAPACITY_PAGE = /^(?:(?:ok(?:ay)?|so|please)\s+)*(?:show|open|go to|pull up|bring up|take me to)(?: me)? (?:the )?capacity(?: page| view)?(?: please)?$/;
/** "Show me the system page", "open system": the System page (as the whole utterance). */
const QUICK_SYSTEM_PAGE = /^(?:(?:ok(?:ay)?|so|please)\s+)*(?:show|open|go to|pull up|bring up|take me to)(?: me)? (?:the )?system(?: page| view)?(?: please)?$/;
/** How long after a voice change "undo that" still reaches it. */
const UNDO_WINDOW_MS = 10 * 60_000;
/** A catch-up walk's words stop meaning walk commands after this long without one. */
const WALK_IDLE_MS = 30 * 60_000;
/** A failed heard mark for a catch-up line tries once more after this. */
const HEARD_RETRY_MS = 2000;
/** Said once, before a walk's first moment: the words it takes. */
const WALK_HINT = "Catching you up one thing at a time: say next, skip, go with an option, that's fine, accept, or what's left. ";
/** What Accept did on a chapter, in a few words. */
function acceptSaid(result: ChapterActResult): string {
  const took = result.applied?.took.length ?? 0;
  const fine = result.applied?.fine.length ?? 0;
  const filed = result.applied?.filed?.length ?? 0;
  const cleared = result.applied?.cleared?.length ?? 0;
  const seen = result.applied?.seen ?? 0;
  const left = result.left?.length ?? 0;
  const failed = result.failed?.length ?? 0;
  const parts = [filed ? `marked ${filed === 1 ? 'the finished thread' : `${filed} finished threads`} done` : '', cleared ? `cleared ${cleared} finished update${cleared === 1 ? '' : 's'}` : '', seen ? `marked ${seen} update${seen === 1 ? '' : 's'} seen` : '', took ? `answered ${took} decision${took === 1 ? '' : 's'} with the recommendation` : '', fine ? `fine on ${fine}` : '', left ? `left ${left} only you can answer` : '', failed ? `${failed} didn't go through` : ''].filter(Boolean);
  return parts.length ? `Accepted: ${parts.join(', ')}.` : 'Accepted: nothing needed changing.';
}
/** How long after a voice search "the second one" means its second hit. */
const SEARCH_PICK_MS = 3 * 60_000;
/** "Open the second one", "the first one", "read me the third": a position right after a search. */
const QUICK_SEARCH_PICK = /^(?:(?:ok(?:ay)?|so|and|alright|let'?s see|yeah)\s+)*(?:(open|show me|pull up|go to|read|read me|what'?s in|tell me about|reopen)\s+)?(?:the )?(first|second|third|top|last|1st|2nd|3rd|number one|number two|number three)(?: one| result| hit)?(?: please)?$/;
/** Words that don't make two messages different asks (the repeat guard compares the rest). */
// Polarity words (not, no, yes, don't, never, cancel…) are NOT here: "cancel it" and "don't cancel it" differ.
const REPEAT_STOPWORDS = new Set('a an the and or but so to of for in on at with my your our their its it is are was were be been do does did you we i me us they them this that these those please can could would will just also about what whether if as by from into than then there here have has had ok okay'.split(' '));
const QUICK_BOARD = /\b(?:(?:show|go back to|back to|take (?:me|us) (?:back )?to|go to) (?:me )?(?:the )?(?:board|desk))\b/;
/** "Go to the inbox", "back to my inbox", "inbox": the Inbox page itself, from any place (as the whole utterance). */
const QUICK_INBOX = /^(?:(?:ok(?:ay)?|alright|so|and|please)\s+)*(?:(?:go|take me|get me|bring me|switch|head)(?: back)? to |(?:back to |show (?:me )?|open (?:up )?))?(?:the |my )?inbox(?: page)?(?: please)?$/;
/** A bare "back": one step back (a screen to its thread, a page up to its index). */
const QUICK_BACK = /^(?:okay |ok )?(?:go )?back\.?$/;
// "Show the screen" anywhere (as before); "open the screen", "pull up the mockup", "bring that screen up",
// "screen, please" only as the whole utterance, so dictation like "we should open the prototype to everyone" stays dictation.
const QUICK_SCREEN =
  /\bshow (?:me )?the screen\b|^(?:(?:ok(?:ay)?|alright|so|and|please|can you|could you|let'?s|go ahead and)\s+)*(?:show|open|open up|pull up|bring up|put up|go to|switch to|flip to|see)(?: me)? (?:the |that |its |their )?(?:screen|mockup|prototype)(?: up)?(?: (?:please|now|again))*$|^bring (?:the |that )?screen up(?: please)?$|^(?:the )?screen(?: please)?$/;
// "Open the prototype", "let me try the prototype": the Prototype view (when the conversation has one;
// otherwise it means the staged screen, as before). Only as the whole utterance.
const QUICK_PROTOTYPE =
  /^(?:(?:ok(?:ay)?|alright|so|and|please|can you|could you|let'?s|go ahead and)\s+)*(?:show|open|open up|pull up|bring up|put up|go to|switch to|flip to|see|try|let me try|let me see|let me click through)(?: me)? (?:the |that |its |their )?(?:live )?prototype(?: up)?(?: (?:please|now|again))*$/;
// On the Prototype view: "go back", "back a page", "previous page" is the page before, inside the prototype.
const QUICK_PAGE_BACK = /^(?:(?:ok(?:ay)?|alright|please)\s+)?(?:go )?back(?: (?:a|one) page)?(?: please)?$|^(?:go to )?(?:the )?(?:previous|last) page$/;
// On the Prototype view: "click Continue", "tap sign up", "press the save button".
const QUICK_CLICK = /^(?:(?:ok(?:ay)?|alright|now|and|please|then)\s+)*(?:click|tap|press|hit)(?: on)? (?:the )?(.+?)(?: (?:button|link|tab))?(?: please)?$/i;
const POSITIONAL_TARGET = /\b(?:first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|last|middle|top|bottom|left|right|other|next|previous|one|it|that|this|these|those)\b/i;
// "Scroll down", "scroll back up a bit", "go to the top", "page down": only as the whole utterance, so a
// dictated sentence that mentions scrolling stays dictation.
/** Rows of the List the router sees (the screen reports up to 40). */
const LIST_ROWS_CAP = 30;
/** How long a voice tab or project change waits for the screen to report its new List (so "then the second one" reads it). */
const LIST_SETTLE_MS = 1500;
/** After an unconfirmed List change, a row asked for within this long isn't resolved against the old rows. */
const LIST_UNSETTLED_MS = 10_000;

const ORDINAL_WORDS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];
const NUMBER_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/** "3", "third", "number three", "top", "last" → a 0-based row index (null when it isn't a position, or is off the end). */
export function rowIndex(words: string | undefined, count: number): number | null {
  const text = (words ?? '').toLowerCase().trim();
  if (!text) return null;
  let index: number | null = null;
  const digits = /^(?:#|no\.?|number )?(\d{1,3})(?:st|nd|rd|th)?$/.exec(text.replace(/^the /, '').replace(/ one$/, ''));
  if (digits) index = Number(digits[1]) - 1;
  else if (/^(?:the )?(?:top|first)(?: one| row)?$/.test(text)) index = 0;
  else if (/^(?:the )?(?:last|bottom)(?: one| row)?$/.test(text)) index = count - 1;
  else if (/^(?:the )?(?:second to last|next to last|penultimate)(?: one)?$/.test(text)) index = count - 2;
  else {
    const word = text.replace(/^(?:the |number )/, '').replace(/ (?:one|row)$/, '');
    const ordinal = ORDINAL_WORDS.indexOf(word);
    const number = NUMBER_WORDS.indexOf(word);
    index = ordinal >= 0 ? ordinal : number >= 0 ? number : null;
  }
  return index !== null && index >= 0 && index < count ? index : null;
}

/** The candidate a spoken name means: exact, then starts-with, then contains (words like "tab" and "project" ignored). */
export function matchByName<T>(candidates: readonly T[], name: (candidate: T) => string, words: string | undefined): T | undefined {
  const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(?:the|tab|view|project|folder)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const wanted = norm(words ?? '');
  if (!wanted) return undefined;
  const named = candidates.map((candidate) => ({ candidate, key: norm(name(candidate)) }));
  return (
    named.find(({ key }) => key === wanted) ??
    named.find(({ key }) => key.startsWith(wanted) || (key.length > 2 && wanted.startsWith(key))) ??
    named.find(({ key }) => key.includes(wanted) || (key.length > 3 && wanted.includes(key)))
  )?.candidate;
}

const QUICK_SCROLL: Array<{ op: 'scroll_down' | 'scroll_up' | 'scroll_top' | 'scroll_bottom'; pattern: RegExp }> = [
  { op: 'scroll_top', pattern: /^(?:please )?(?:scroll|go|jump|take me|back) (?:back )?(?:up )?to the (?:very )?top(?: please)?$/ },
  { op: 'scroll_bottom', pattern: /^(?:please )?(?:scroll|go|jump|take me) (?:down )?to the (?:very )?(?:bottom|end)(?: please)?$/ },
  { op: 'scroll_up', pattern: /^(?:please )?(?:scroll (?:back )?up|page up|go back up)(?: (?:a bit|a little|some|more|again|one more|please))*$/ },
  { op: 'scroll_down', pattern: /^(?:please )?(?:scroll(?: down)?|page down|keep scrolling|scroll down more)(?: (?:a bit|a little|some|more|again|one more|please))*$/ },
];
// "What's waiting on me" is the short queue now (next-up.ts); "catch me up" stays the full briefing.
const QUICK_CATCH_UP = /\b(?:catch me up|what'?s on my desk|what is on my desk)\b/;
/** Items just sent to stay out of "next one" this long (the desk may not have caught up with the reply). */
const NEXT_SENT_EXCLUDE_MS = 120_000;
const RELAY_WORDS = /\b(?:tell|ask|have|let|say|send|reply|answer|write|post)\b/;
const YES =/^(?:yes|yeah|yep|yup|sure|please do|do it|stop it|stop the job|stop that too)\b/;
/** A short approve / decline of the Loom approval in focus. */
const QUICK_APPROVAL = /^(?:(?:yes|ok|okay|no|nope) )?(?:approve(?: it| that)?|accept(?: it)?|allow it(?: for (?:this|the) session)?|decline(?: it| that)?|deny(?: it| that)?|reject(?: it| that)?)$/;
const NO = /^(?:no|nope|nah|leave it|keep it running|don'?t|let it run|leave it running)\b/;

export class LiveOperator {
  readonly tasks: OperatorTask[] = [];
  private readonly queue: QueuedUpdate[] = [];
  private readonly transcript: TranscriptLine[] = [];
  private lastDelegationAt = 0;
  private lastExtractionAt = 0;
  private promiseTimer: NodeJS.Timeout | null = null;
  /** A desk command heard and not delegated (watchForUnroutedCommand): since when, and the timer that routes it. */
  /** The utterance the unrouted-command net is watching (watchForUnroutedCommand); sealed ones are judged on their own. */
  private unrouted: UnroutedWindow | null = null;
  private syntheticSeq = 0;
  private taskSeq = 0;
  private pumpTimer: NodeJS.Timeout | null = null;
  private extracting = 0;
  private pending: PendingDelivery | null = null;
  private lastDelivered: QueuedUpdate | null = null;
  private lastDeliveredAt = 0;
  /** Unprompted news waiting for a break to knock: item id → who or where it is from. */
  private readonly knocks = new Map<string, { label: string; at: number }>();
  /** Items already knocked about: more turns on the same unseen item don't knock again until the owner has seen it. */
  private readonly knocked = new Set<string>();
  private currentThread: ThreadInfo | null = null;
  private digestGiven = false;
  /** The agent the conversation is about; its staged scenes are the ones on screen. */
  private focusAgentId: string | null = null;
  /** After the user picks what's on screen (a command or a tap), results arriving don't take it over for a while. */
  private screenPin: { agentId: string | null; until: number } | null = null;
  /** Staged-scene handles (S1…) from the last extractor prompt → scene ids. */
  private readonly sceneHandles = new Map<string, string>();
  /** Desk handles (i1…) from the last extractor prompt → item ids. */
  private deskHandles = new Map<string, string>();
  /** Delegation prompts already routed (normalized → when), to tell a re-fire from a new request. */
  private readonly handledPrompts = new Map<string, number>();
  /** What the user said recently (normalized), to spot a delegation that is only a fragment of it. */
  private recentSpeech: Array<{ text: string; at: number }> = [];
  /** The desk item the conversation was last about ("that one"). */
  private lastItemId: string | null = null;
  /** The desk's Start work repos (loomRepos()): last list read, and a lookup in flight. */
  /** `ok`: whether the latest lookup succeeded (a failure keeps the last good list but retries sooner). */
  private loomRepoCache: { at: number; ok: boolean; repos: string[] | null } | null = null;
  private loomRepoFetch: Promise<string[] | null> | null = null;
  /** Conversations this session expects an answer in that only the desk will see (late answers, desk replies). */
  private readonly watches = new Map<string, SessionWatch>();
  /** Desk items already spoken about unprompted in this session (id:last agent message). */
  private readonly spokenItems = new Set<string>();
  /** Answers to a Loom request given so far, while the operator asks for the rest: per request (`<itemId>#<requestId>`), so two interleaved requests keep their own. */
  private readonly partialAnswers = new Map<string, Record<string, string | string[]>>();
  /** Done was refused until the user says whether to stop the job running there. */
  private pendingStopJob: { itemId: string; label: string; askedAt: number } | null = null;
  /** The last desk change voice made, for "undo that": the desk's undo of its event, else the change's opposite. */
  private lastUndoable: { itemId: string; what: string; steps: Array<{ type: DeskCommandType; args: Record<string, unknown> }>; at: number } | null = null;
  /** What the last voice search read out, so "open the second one" right after picks from it. */
  private lastSearch: { at: number; hits: SearchHitRef[] } | null = null;
  /** "Finish the board game project?" was asked: the yes or no that settles it. */
  private pendingFinish: { projectId: string; name: string; askedAt: number } | null = null;
  /** A catch-up walk by voice: the moments passed over this session, and the one being read (catchup-walk.ts). */
  /** `heard`: lines already marked heard when their read-back played through, so "next" doesn't mark them again. */
  private walk: { skipped: number[]; heard: number[]; focus: CatchupWalkFocus | null; at: number; heardPlan?: QueuedUpdate['heardPlan'] } | null = null;
  /** Delegations run one at a time: a second waits for the first, then merges if it adds nothing. */
  private delegationTail: Promise<void> = Promise.resolve();
  /** Bumped on stop(): callbacks from before (router results, agent replies) must not act. */
  private generation = 0;
  private running = false;
  private readonly screenHandlers: ScreenHandlers;
  private readonly deskHandler: (event: DeskItemEvent) => void;
  /** Updates the operator released recently, to tell its own relays apart from hand-off promises. */
  private readonly released: Array<{ text: string; at: number }> = [];
  /** Anything that shows the call is in use: speech, a delegation, a relay. */
  private lastActivityAt = 0;
  private idleBoardSent = false;
  private houseTimer: NodeJS.Timeout | null = null;
  private lastStatus = '';
  private captionTimer: NodeJS.Timeout | null = null;
  private lastCaptionAt = 0;
  private readonly timeouts: OperatorTimeouts;
  private readonly policy: DeliveryPolicy;
  private readonly floor: FloorOptions;
  private readonly now: () => number;
  private readonly log: (event: string, data?: Record<string, unknown>) => void;
  /** Queued updates already in the session trace (each is traced once, when first seen). */
  private readonly tracedQueue = new WeakSet<QueuedUpdate>();
  /** Draft mode (draft-mode.ts): the session's draft, and what this operator lends it. */
  private readonly draft: DraftSession;
  private readonly draftHost: DraftHost;
  /** Owner speech the draft held while a send was in flight, read before fresh transcript. */
  private readonly replaySpeech: string[] = [];
  /** "Main chat, or the … thread?" (destination-ask.ts): a dispatch held until the owner says where. */
  private readonly destination: DestinationAsk;
  private readonly forMe: AddresseeAsk;
  private readonly ownerClock: { lastAt: number | null; addressedAt?: number | null };
  private seenGateClosures = 0;
  /** Pause mode (pause-mode.ts): the session's pause, and what this operator lends it. */
  private readonly pause: PauseSession;
  private readonly pauseHost: PauseHost;
  /**
   * The shared update hold: while any mode holds it (pause, draft), updates queue and none is
   * released. Lifting the last hold orders the queue and lets that mode announce what came in.
   */
  private readonly holdReasons = new Set<HoldReason>();
  /** When the last hold lifted: the queue waits for that announcement to be said. */
  private holdLiftedAt: number | null = null;
  /** Held updates are going out (non-floor policies are pumped from housekeeping until they're done). */
  private drainingHeld = false;
  /** "Holding N updates while the owner drafts" is in the trace for this draft. */
  private draftHoldTraced = false;
  /** The last tapped presentation that armed a draft (item@since), so a re-broadcast arms once. */
  private lastArmedPresentation: string | null = null;
  /** The most recent tapped presentation (view:item@since): an earlier tap's slow lookup never arms over it. */
  private latestPresentation: string | null = null;
  /** The desk's presentation stream (a tapped card arms a draft). */
  private readonly presentationHandler = (presentation: PresentationState) => this.onDeskPresentation(presentation);
  /** Desk items a message just went to, and when: never the "next one" for a couple of minutes. */
  private readonly recentlySent = new Map<string, number>();
  /** When this operator was made: the session start when the voice session gave none. */
  private readonly startedAt: number;
  /** Owner turns already answered aloud this session (shared across brains when the session passes one). */
  private readonly answered: AnsweredTurns;

  constructor(private readonly options: LiveOperatorOptions) {
    this.policy = options.policy ?? 'floor';
    this.floor = { settleMs: 3000, speakTimeoutMs: 8000, maxAttempts: 3, ...options.floor };
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.answered = options.answeredTurns ?? new Set<string>();
    this.log = options.log ?? (() => {});
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.screenHandlers = {
      onStaged: (scene, info) => void this.onSceneStaged(scene, info),
      onInput: (scene, type, data) => {
        // Not handled (left unacknowledged, so it falls back to the bot) once this session is over.
        if (!this.running) return false;
        void this.onScreenInput(scene, type, data);
        return true;
      },
    };
    this.deskHandler = (event) => void this.onDeskItem(event);
    this.draft = options.draft ?? new DraftSession({ log: this.log, now: this.now });
    this.draftHost = this.createDraftHost();
    this.pause = options.pause ?? new PauseSession({ log: this.log, now: this.now });
    this.pauseHost = this.createPauseHost();
    this.destination = options.destination ?? new DestinationAsk({ now: this.now });
    this.forMe = options.addressee ?? new AddresseeAsk({ now: this.now });
    this.ownerClock = options.ownerSpeech ?? { lastAt: null };
    this.seenGateClosures = options.fillerGate?.closures ?? 0;
    const { client } = options;
    client.on('inputTranscript', (delta: LiveTranscriptDelta) => {
      this.dropMutedReply();
      this.addTranscript('user', delta);
      this.watchForUnroutedCommand(delta.delta);
      // Words the owner said once the update started playing. Transcription lags the audio, so words
      // can land after playback stopped; checkDelivery waits briefly for them (Codex review, #387).
      // A new utterance after playback (the owner pausing, then answering) is not part of it.
      if (this.pending && !this.pending.captureClosed && this.options.playback.activity.lastVoiceAt > this.pending.releasedAt) this.pending.overlapWords += delta.delta;
    });
    client.on('outputTranscript', (delta: LiveTranscriptDelta) => {
      // Muted by the filler gate: the owner never heard it, so it is not conversation and promises nothing (Codex review on #481).
      if (this.options.fillerGate?.closed) {
        this.log('said.muted', { delta: delta.delta });
        return;
      }
      this.addTranscript('operator', delta);
      // The voice model answered what was said so far: the owner's next words are a new utterance for the net.
      if (this.unrouted) this.unrouted.answered = true;
      this.pause.noteOutput(delta.delta); // pause mode hook: recognizes the "Paused." confirmation
      if (this.pending) this.pending.spoken += delta.delta.toLowerCase();
      this.watchForUnkeptPromise();
    });
    client.on('delegation', (delegation: LiveDelegation) => void this.onDelegation(delegation));
    client.on('error', (error: LiveClientError) => this.log('live.error', { ...error }));
  }

  /** True while this session is live and `generation` is still the current one. */
  private alive(generation: number): boolean {
    return this.running && generation === this.generation;
  }

  /**
   * One decision for the desk's session trace (next to the log line, never instead of it).
   * Fire and forget: a failure here never changes what the operator does.
   */
  private trace(kind: string, summary: string, data: Record<string, unknown> = {}, at?: number): void {
    try {
      this.options.desk?.trace?.({ kind, summary, data, sessionId: this.options.traceSessionId ?? null, at: at ?? this.now() });
    } catch {
      /* tracing never affects behavior */
    }
  }

  /** Updates that joined the queue since the last look: traced once each, at the time they arrived. */
  private traceQueued(): void {
    for (const item of this.queue) {
      if (this.tracedQueue.has(item)) continue;
      this.tracedQueue.add(item);
      // Update hold: held, not just waiting for the floor.
      if (this.holdReasons.has('pause')) this.trace('pause.queued', `paused: holding ${describeUpdate(item)} · ${this.queue.length} waiting`, { agent: item.agent.id, itemKind: item.kind, failed: item.failed ?? false, question: item.update.kind === 'question', depth: this.queue.length }, item.arrivedAt);
      this.trace('speech.queued', `queued ${describeUpdate(item)}${item.urgent ? ' (urgent)' : ''} · ${this.queue.length} waiting`, {
        agent: item.agent.id,
        itemKind: item.kind,
        taskId: item.task?.id ?? null,
        requestId: item.request?.id ?? null,
        conversationKey: item.conversationKey ?? null,
        deskItemIds: item.deskItemIds ?? null,
        depth: this.queue.length,
      }, item.arrivedAt);
    }
  }

  start(): void {
    this.running = true;
    this.lastActivityAt = this.now();
    this.trace('operator.start', `operator started (${this.policy} delivery${this.options.screen ? ', screen' : ''}${this.options.desk ? ', desk' : ''})`, { policy: this.policy, agents: this.options.agents.map((agent) => agent.id) });
    if (this.policy === 'floor' && !this.pumpTimer) this.pumpTimer = setInterval(() => void this.pump(), 200);
    if (!this.houseTimer) this.houseTimer = setInterval(() => this.housekeeping(), 1000);
    this.options.screen?.connect(this.screenHandlers);
    // The Start work repos, ahead of the first draft (the compile never waits for them).
    void this.loomRepos();
    const desk = this.options.desk;
    if (desk) {
      desk.connect(this.deskHandler);
      // Anything already due on the desk when the call starts.
      const generation = this.generation;
      void this.bounded('desk items', desk.refresh(), this.timeouts.deskMs, [] as DeskItemSummary[]).then((items) => {
        if (!this.alive(generation)) return;
        for (const item of items) if (this.shouldSpeakUnprompted(item)) this.queueDeskNotice(item);
      });
    }
    this.draft.attach(this.draftHost); // draft mode hook
    this.options.desk?.onPresentation?.(this.presentationHandler); // draft mode hook: a tapped card arms a draft
    this.pause.attach(this.pauseHost); // pause mode hook
    // A "main chat, or the … thread?" asked by the previous connection is still waiting for its answer.
    const pending = this.destination.held;
    if (pending) {
      void this.append('instructions', `[Before the reconnect you asked "${destinationQuestion(pending.agentName, pending.options)}" and nothing was sent yet. Their next words answer it: delegate them.]`, null);
    }
    // A "For me?" asked by the previous connection. A reply or readback points at that connection's tasks or last update, gone now: dropped (Codex review on #481).
    const forMe = this.forMe.held;
    if (forMe && forMe.actions.some((action) => action.type === 'reply' || action.type === 'readback')) {
      this.forMe.take();
      this.trace('forme.dropped', `the connection changed while “For me?” waited: ${describeActions(forMe.actions)} not done (its task belonged to the old connection)`, { speech: clipLine(forMe.speech, 200) });
    } else if (forMe) {
      void this.append('instructions', '[Before the reconnect you asked "For me?" and nothing was done yet. Their next words answer it: delegate them.]', null);
    }
    this.publishStatus();
  }

  /**
   * Ends this session: timers, screen handlers, and every callback still in flight. Updates that
   * were queued or being relayed, and agent results that arrive later, go to `onLateUpdate`.
   */
  stop(): void {
    const wasRunning = this.running;
    this.running = false;
    this.generation += 1;
    if (this.promiseTimer) clearTimeout(this.promiseTimer);
    this.promiseTimer = null;
    if (this.unrouted?.timer) clearTimeout(this.unrouted.timer);
    this.unrouted = null;
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    this.pumpTimer = null;
    if (this.houseTimer) clearInterval(this.houseTimer);
    this.houseTimer = null;
    if (this.captionTimer) clearTimeout(this.captionTimer);
    this.captionTimer = null;
    // Only this session's handlers: a newer session may already hold the shared director and desk stream.
    this.options.screen?.disconnect(this.screenHandlers);
    this.options.desk?.disconnect(this.deskHandler);
    this.draft.detach(this.draftHost); // draft mode hook
    this.options.desk?.offPresentation?.(this.presentationHandler);
    this.pause.detach(this.pauseHost); // pause mode hook
    if (!wasRunning) return;
    this.trace('operator.stop', `operator stopped (${this.pendingUpdates} update${this.pendingUpdates === 1 ? '' : 's'} unsaid, handed on)`, { unsaid: this.pendingUpdates, tasks: this.tasks.length });
    const last = this.transcript.at(-1);
    if (last && !last.final) this.publishCaption(last, true);
    this.publishStatus();
    // Hand over what was waiting to be said; read-backs and reminders were for this conversation only.
    const unsaid = [...(this.pending ? [this.pending.item] : []), ...this.queue];
    this.pending = null;
    this.queue.length = 0;
    for (const item of unsaid) {
      if (item.kind === 'readback' || item.reminder || item.agent.id === 'operator') continue;
      this.handOff({
        kind: item.kind === 'notice' ? 'notice' : 'result',
        agent: item.agent,
        update: item.update,
        ...(item.place ? { place: item.place } : {}),
        ...(item.request ? { request: item.request } : {}),
        ...(item.conversationKey ? { conversationKey: item.conversationKey } : {}),
        ...(item.deskItemIds ? { deskItemIds: item.deskItemIds } : {}),
        ...(item.failed ? { failed: true } : {}),
      });
    }
  }

  private handOff(late: LateUpdate): void {
    this.log('handoff', { agent: late.agent.id, kind: late.kind, requestId: late.request?.id, text: late.update.text.slice(0, 160) });
    try {
      this.options.onLateUpdate?.(late);
    } catch (err) {
      this.log('handoff.error', { message: (err as Error).message });
    }
  }

  /** An update from an earlier session (it ended before relaying it): queue it like a fresh one. */
  adoptLateUpdate(late: LateUpdate): void {
    if (!this.running) return;
    this.log('adopt', { agent: late.agent.id, kind: late.kind, requestId: late.request?.id });
    this.queue.push({
      kind: late.kind,
      agent: late.agent,
      update: late.update,
      ...(late.place ? { place: late.place } : {}),
      ...(late.request ? { request: late.request } : {}),
      ...(late.conversationKey ? { conversationKey: late.conversationKey } : {}),
      ...(late.deskItemIds ? { deskItemIds: late.deskItemIds } : {}),
      ...(late.failed ? { failed: true } : {}),
      // The delegation it belonged to went with the old session.
      delegationId: null,
      arrivedAt: this.now(),
      attempts: 0,
    });
    void this.pump();
  }

  get pendingUpdates(): number {
    return this.queue.length + (this.pending ? 1 : 0);
  }

  /** Nothing in flight: no agent working, nothing queued or being relayed, no late answer awaited. */
  isIdle(): boolean {
    this.expireWatches();
    // Pause mode hook: awake while paused (up to an hour); after that held updates don't keep it awake.
    // Never with more than the session owner can hold across the sleep (Codex review on #394).
    const unsaid = this.pause.sleepsWithQueue() && this.pendingUpdates <= MAX_HELD_LATE ? 0 : this.pendingUpdates;
    return this.extracting === 0 && unsaid === 0 && this.watches.size === 0 && !this.tasks.some((task) => task.status === 'running') && !this.draft.holdsSession() && !this.pause.holdsSession() && (this.destination.held === null || this.pause.active) && this.forMe.held === null;
  }

  transcriptLines(): string[] {
    return this.transcript.map((line) => `${line.speaker === 'user' ? 'User' : 'Operator'}: ${line.text.trim()}`);
  }

  private addTranscript(speaker: TranscriptLine['speaker'], delta: LiveTranscriptDelta): void {
    const now = this.now();
    this.noteActivity();
    const last = this.transcript.at(-1);
    const paused = speaker === 'user' && this.pause.active;
    // The shared speech clock follows every word, merged deltas included (Codex review on #481).
    const ownerAtBefore = this.ownerClock.lastAt;
    if (speaker === 'user' && !paused) this.ownerClock.lastAt = now;
    if (last && last.speaker === speaker && delta.startMs - last.endMs < 1500 && !last.final && !!last.paused === paused) {
      last.text += delta.delta;
      last.endMs = Math.max(last.endMs, delta.endMs);
      last.updatedAt = now;
      this.scheduleCaption(last);
      return;
    }
    // A new line: the previous one is final.
    if (last && !last.final) this.publishCaption(last, true);
    const line: TranscriptLine = { speaker, text: delta.delta, startMs: delta.startMs, endMs: delta.endMs, consumed: 0, updatedAt: now, final: false, ...(paused ? { paused: true } : {}) };
    if (speaker === 'user') {
      const owner = [...this.transcript].reverse().find((entry) => entry.speaker === 'user' && !entry.paused);
      const ownerAt = owner?.updatedAt ?? ownerAtBefore;
      line.quietBefore = { ownerMs: ownerAt === null ? null : now - ownerAt, anyMs: last ? now - last.updatedAt : ownerAt === null ? null : now - ownerAt };
    }
    this.transcript.push(line);
    this.scheduleCaption(line);
  }

  /** User speech not yet given to the extractor; marks it consumed. */
  private takeFreshUserSpeech(): string {
    // Draft mode hook: speech held while a draft send was in flight comes first, in order.
    const parts: string[] = this.replaySpeech.splice(0);
    for (const line of this.transcript) {
      if (line.speaker !== 'user' || line.consumed >= line.text.length) continue;
      parts.push(line.text.slice(line.consumed).trim());
      line.consumed = line.text.length;
    }
    return parts.filter(Boolean).join(' ');
  }

  private hasFreshUserSpeech(): boolean {
    return this.replaySpeech.length > 0 || this.transcript.some((line) => line.speaker === 'user' && line.text.slice(line.consumed).trim().length > 0);
  }

  // ── operator status and captions (POST /api/desk/operator) ─────────────

  private statusNow(): OperatorStatusUpdate['status'] {
    if (!this.running) return 'offline';
    const now = this.now();
    if (this.extracting > 0) return 'routing';
    if (this.pending || this.options.playback.isSpeaking(now)) return 'speaking';
    if (this.tasks.some((task) => task.status === 'running')) return 'working';
    return 'listening';
  }

  private publishStatus(): void {
    const desk = this.options.desk;
    if (!desk) return;
    const agentName = this.focusAgentId ? (this.options.agents.find((agent) => agent.id === this.focusAgentId)?.name ?? null) : null;
    const update: OperatorStatusUpdate = { live: this.running, status: this.statusNow(), agentName };
    const key = JSON.stringify(update);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    desk.publishOperator(update);
  }

  /** Partial captions at most every 250 ms (trailing edge kept); final lines always. */
  private scheduleCaption(line: TranscriptLine): void {
    if (!this.options.desk) return;
    const wait = this.lastCaptionAt + CAPTION_INTERVAL_MS - this.now();
    if (wait <= 0) {
      this.publishCaption(line, false);
      return;
    }
    if (this.captionTimer) return;
    this.captionTimer = setTimeout(() => {
      this.captionTimer = null;
      const latest = this.transcript.at(-1);
      if (latest && !latest.final && this.running) this.publishCaption(latest, false);
    }, wait);
  }

  private publishCaption(line: TranscriptLine, final: boolean): void {
    const desk = this.options.desk;
    if (final) line.final = true;
    if (!desk) return;
    const text = line.text.trim();
    if (!text) return;
    // Pause mode hook: room conversation while paused is not captioned or traced.
    if (line.speaker === 'user' && (this.pause.active || line.paused)) return;
    if (!final) this.lastCaptionAt = this.now();
    if (final) this.trace(line.speaker === 'user' ? 'user.said' : 'operator.said', `${line.speaker === 'user' ? 'owner' : 'operator'}: “${clipLine(text, 200)}”`, { text: clipLine(text, 200) });
    const agentName = this.focusAgentId ? (this.options.agents.find((agent) => agent.id === this.focusAgentId)?.name ?? null) : null;
    desk.publishOperator({
      live: this.running,
      status: this.statusNow(),
      agentName,
      transcript: { speaker: line.speaker, name: line.speaker === 'user' ? (this.options.userName ?? 'You') : 'Operator', text, final },
    });
  }

  /** Once a second: status changes, lines that went quiet become final, and the idle return to the board. */
  private housekeeping(): void {
    if (!this.running) return;
    const now = this.now();
    const last = this.transcript.at(-1);
    if (last && !last.final && now - last.updatedAt >= 1500) this.publishCaption(last, true);
    this.publishStatus();
    this.checkIdleBoard(now);
    this.pause.tick(); // pause mode hook: watches the transcript for "Yankee, pause" / "Yankee, I'm back"
    if (!this.pause.active) this.draft.tick(); // draft mode hook (a paused draft collects nothing)
    // A pending "main chat, or the … thread?" doesn't age while paused: two minutes from the resume.
    if (this.pause.active) this.destination.touch();
    const unanswered = this.destination.expire();
    if (unanswered) this.trace('destination.expired', `“where should it go?” went unanswered: the ${unanswered.agentName} request was not sent`, { message: clipLine(unanswered.action.message, 200) });
    this.expireForMe();
    this.maybeKnock();
    // Update hold: only floor delivery has its own pump; held updates go out under every policy once the last hold lifts.
    this.syncDraftHold();
    if (this.policy !== 'floor' && this.drainingHeld) void this.pump();
  }

  private noteActivity(): void {
    this.lastActivityAt = this.now();
    this.idleBoardSent = false;
  }

  /** After the call goes idle (no speech, nothing pending) the screens go back to the board: 2 min from a conversation, 10 from a staged screen or a prototype. */
  private checkIdleBoard(now: number): void {
    const screen = this.options.screen;
    if (!screen?.present || this.idleBoardSent) return;
    const presentation = screen.presentation?.();
    // Something an agent put up is still being read: a staged screen gets 10 minutes, a conversation 2. A prototype
    // too, counted from the last time its page changed (the owner clicking or scrolling through it is activity).
    const wait = presentation?.view === 'screen' || presentation?.view === 'prototype' ? (this.options.idleScreenMs ?? 600_000) : (this.options.idleBoardMs ?? 120_000);
    const since = Math.max(this.lastActivityAt, presentation?.view === 'prototype' ? (screen.prototypeActivityAt?.() ?? 0) : 0);
    if (now - since < wait) return;
    if (!this.isIdle() || this.userBusy(now) || this.options.playback.isSpeaking(now)) return;
    this.idleBoardSent = true;
    // An idle draft for a conversation (armed by a tap, say) is parked with it, as "back to the board" would.
    if (this.draft.leaveForBoard('idle: back to the board')) this.trace('view.decision', 'idle with a draft open for a conversation: parked it', { after: 'idle', to: 'active' });
    if (presentation && presentation.view === 'active') return;
    this.log('screen.idle', {});
    this.trace('view.decision', `idle ${Math.round((now - this.lastActivityAt) / 1000)} s on ${presentation?.view ?? 'unknown'}: back to the board`, { after: 'idle', from: presentation?.view ?? 'unknown', to: 'active', waitMs: wait });
    void this.present({ view: 'active', reason: 'idle' });
  }

  /** A presentation intent as the director; false when it didn't apply (or there is no hub). */
  private async present(intent: PresentationIntent): Promise<boolean> {
    const screen = this.options.screen;
    if (!screen?.present) return false;
    // A conversation opened by item id goes with its key: the hub derives only some sources' keys from the id
    // (a Loom thread's open was refused, live audio test 10/18).
    if (intent.view === 'conversation' && intent.itemId && !intent.conversationKey) {
      const key = this.deskItems().find((item) => item.id === intent.itemId)?.conversationKey;
      if (key) intent = { ...intent, conversationKey: key };
    }
    const applied = await this.bounded('presentation', screen.present(intent), this.timeouts.deskMs, false);
    this.log('presentation', { ...intent, applied });
    this.trace('view.intent', `asked the hub for ${intent.view === 'active' ? 'the board' : intent.view}${intent.reason ? ` (${intent.reason})` : ''}: ${applied ? 'applied' : 'not applied (see the hub entry for why)'}`, { ...intent, applied });
    return applied;
  }

  /** The conversation moved to this item or agent: its Conversation view (automatic focus, never over a manual pick). */
  /**
   * A message just went out: put the board back up so the owner can move on to the next thing
   * (live test 10/06). The agent's answer brings its own scene back when it lands.
   */
  private backToBoardAfterSend(what: string): void {
    const view = this.options.screen?.presentation?.()?.view;
    if (view === 'prototype') {
      // Feedback on a prototype the owner is trying: it stays up, and the agent's update reloads it in place.
      this.trace('view.decision', `after ${what}: prototype stays up (the owner is using it)`, { after: what, from: view, to: 'unchanged', reason: 'prototype' });
      return;
    }
    this.log('view.decision', { after: what, from: view ?? 'unknown', to: view && view !== 'active' ? 'active' : 'unchanged' });
    this.trace(
      'view.decision',
      `after ${what}: ${!view ? 'no presentation known (no hub, or not reported yet): unchanged' : view === 'active' ? 'already on the board: unchanged' : `${view} → board`}`,
      { after: what, from: view ?? 'unknown', to: view && view !== 'active' ? 'active' : 'unchanged', reason: !view ? 'no-presentation' : view === 'active' ? 'already-active' : 'sent' },
    );
    if (view && view !== 'active') void this.present({ view: 'active', reason: what === 'done' ? 'done' : 'sent' });
  }

  /**
   * Opens a conversation on the screens. Only for requests to look at one ("open", "read me",
   * catch-up): sending a message never opens it, because the owner wants the board back for the
   * next thing (live test 10/06). A result's staged scene still takes the screen on its own.
   */
  private focusConversation(target: { itemId?: string; conversationKey?: string }): void {
    if (!target.itemId && !target.conversationKey) return;
    this.trace('view.decision', `open the conversation ${target.itemId ?? target.conversationKey}`, { after: 'focus', to: 'conversation', ...target });
    void this.present({ view: 'conversation', ...target, reason: 'focus' });
  }

  /**
   * GPT-Live sometimes says "sending that to Charlie" without emitting a delegation.
   * If the operator promises a hand-off and none arrives, run the extraction ourselves.
   */
  private watchForUnkeptPromise(): void {
    const line = this.transcript.at(-1);
    if (!line || line.speaker !== 'operator') return;
    const promise = HANDOFF_PROMISE.exec(line.text);
    if (!promise || this.promiseTimer) return;
    // Relaying an agent's words ("Sierra says the mockup is added") is not the operator promising anything.
    if (this.isRelayedWording(line.text, promise[0])) return;
    const promisedAt = this.now();
    this.promiseTimer = setTimeout(() => {
      this.promiseTimer = null;
      if (this.lastDelegationAt >= promisedAt - 1500 || this.extracting > 0 || !this.hasFreshUserSpeech()) return;
      this.syntheticSeq += 1;
      this.log('promise.unkept', { said: line.text.trim().slice(-160) });
      void this.onDelegation({ id: `local-${this.syntheticSeq}`, offsetMs: 0, local: true });
    }, this.options.promiseTimeoutMs ?? 4000);
  }

  /**
   * GPT-Live sometimes takes a desk command for itself ("stop that" → "Okay.") or says nothing to it
   * ("rename this to …"), and the command waits for whatever is said next. When the owner's words since
   * the last delegation are one of those commands and none came after a quiet moment, route them here.
   * A late delegation of the same words then finds them used, and is a re-fire (lookups only).
   */
  private watchForUnroutedCommand(words: string): void {
    const line = this.transcript.at(-1);
    if (!line || line.speaker !== 'user') return;
    const current = this.unrouted;
    // These words began a new transcript line (a pause of 1.5 s or more): a new utterance too.
    const newLine = line.text.length <= words.length;
    if (current && !current.answered && !newLine) {
      // Still the same utterance: wait for its end again.
      this.armUnrouted(current, this.options.unroutedCommandMs ?? 4000);
      return;
    }
    // The one before ended (the operator answered it, or the owner paused): it is sealed where these words
    // begin and judged on its own, so "stop that" / "Okay." / "thanks" still stops, and "pin this" … "stop
    // that" is two commands (Codex review on #750).
    const at = { line, offset: Math.max(0, line.text.length - words.length) };
    if (current) {
      current.to = at;
      this.armUnrouted(current, 0);
    }
    // Said over the operator ("stop that" while it talks) is about its speech, never a thread. Over means
    // the owner's audio began while the operator's was still playing (Codex review on #750).
    const segment = this.options.userActivity.lastSegmentAt;
    const began = segment > 0 && this.now() - segment < 15_000 ? segment : this.now();
    const next: UnroutedWindow = { since: this.now(), from: at, to: null, overSpeech: this.options.playback.activity.lastVoiceAt > began, answered: false, timer: null };
    this.unrouted = next;
    this.armUnrouted(next, this.options.unroutedCommandMs ?? 4000);
  }

  private armUnrouted(window: UnroutedWindow, delayMs: number): void {
    if (window.timer) clearTimeout(window.timer);
    window.timer = setTimeout(() => this.judgeUnrouted(window), delayMs);
  }

  /** One utterance, once it ended: a desk command nobody delegated is routed here. */
  private judgeUnrouted(window: UnroutedWindow): void {
    window.timer = null;
    if (!this.running) return;
    // Something else is being routed: look again once it is done; its words were taken before these (Codex review on #750).
    if (this.extracting > 0) {
      this.armUnrouted(window, 1000);
      return;
    }
    if (this.unrouted === window) this.unrouted = null;
    // Delegated by the voice model means its words were taken (and an in-flight one is waited out, above): only the
    // words still untaken are this utterance's, so a delegation of later words never hides it (Codex review on #750).
    if (window.overSpeech || this.pause.active || this.draft.active) return;
    const start = this.transcript.indexOf(window.from.line);
    if (start < 0) return;
    const end = window.to ? this.transcript.indexOf(window.to.line) : this.transcript.length - 1;
    const lines = this.transcript.slice(start, end + 1).filter((line) => line.speaker === 'user' && !line.paused);
    const slice = (line: TranscriptLine) =>
      line.text.slice(Math.max(line.consumed, line === window.from.line ? window.from.offset : 0), window.to && line === window.to.line ? window.to.offset : undefined);
    const fresh = lines.map(slice).join(' ');
    const ramble = opensRamble(fresh);
    if (fresh.includes('?') && !ramble) return;
    const text = fresh.toLowerCase().replace(/[^a-z0-9' :]+/g, ' ').replace(/\s+/g, ' ').trim();
    // Anchored, so "don't pin this" (which says "pin this" too) is the voice model's to answer (Codex review on #750).
    if (!ramble && (!text || text.split(' ').length > 14 || !UNROUTED_COMMANDS.some((pattern) => pattern.test(text)))) return;
    // Words before it had their own look and the voice model answered them: the router starts at this command
    // (and takes what was said since with it, as a late delegation would).
    for (const line of this.transcript.slice(0, start)) if (line.speaker === 'user') line.consumed = line.text.length;
    window.from.line.consumed = Math.max(window.from.line.consumed, window.from.offset);
    // Its words are taken here and go with the delegation: whatever is said next, even while this one is
    // being routed, is the next utterance's (Codex review on #750).
    for (const line of lines) if (!window.to || line !== window.to.line) line.consumed = line.text.length;
    this.syntheticSeq += 1;
    this.log('command.unrouted', { heard: clipLine(fresh.trim(), 160) });
    this.trace('command.unrouted', `“${clipLine(fresh.trim(), 60)}” was a desk command the voice model didn't hand over: routed anyway`, { heard: clipLine(fresh.trim(), 200) });
    void this.onDelegation({ id: `local-${this.syntheticSeq}`, offsetMs: 0, local: true, speech: fresh.trim(), owned: true });
  }

  /**
   * True when the operator's line is an agent update being relayed: while an update is out for
   * delivery, or when the matched words come from an update it released in the last two minutes.
   */
  private isRelayedWording(line: string, matched: string): boolean {
    if (this.pending) return true;
    const now = this.now();
    while (this.released.length && now - this.released[0].at > 120_000) this.released.shift();
    const words = normalizeForMatch(matched);
    if (this.released.some((item) => normalizeForMatch(item.text).includes(words))) return true;
    // "Watson says … added", "Sierra reported …": the match sits inside an attributed relay.
    const names = this.options.agents.map((agent) => agent.name.toLowerCase().replace(/[^a-z0-9 ]/g, '')).filter(Boolean);
    const lower = line.toLowerCase();
    const at = lower.lastIndexOf(matched.toLowerCase());
    return names.some((name) => {
      const said = new RegExp(`\\b${name}\\b[^.?!]{0,40}\\b(says|said|reports|reported|wrote|replied|asks|asked|confirmed|confirms)\\b`).exec(lower);
      return said !== null && said.index < at;
    });
  }

  private onDelegation(delegation: LiveDelegation & { local?: boolean; speech?: string; owned?: boolean }): Promise<void> {
    this.lastDelegationAt = this.now();
    this.noteActivity();
    this.extracting += 1;
    this.publishStatus();
    const generation = this.generation;
    // One at a time: a second delegation of the same sentence 100 ms later must see what the first routed.
    const run = this.delegationTail.then(() => this.runDelegation(delegation, generation));
    this.delegationTail = run.catch(() => undefined);
    return run.finally(() => {
      this.extracting -= 1;
      this.publishStatus();
    });
  }

  private async runDelegation(delegation: LiveDelegation & { local?: boolean; speech?: string; owned?: boolean }, generation: number): Promise<void> {
    if (!this.alive(generation)) return;
    // Transcript deltas trail the audio; give them a moment, then let the user finish
    // the sentence (GPT-Live sometimes delegates at a mid-sentence pause).
    await sleep(this.options.transcriptSettleMs ?? 700);
    const endOfSpeech = this.options.endOfSpeechMs ?? 1500;
    const waitUntil = this.now() + 8000;
    while (
      this.now() < waitUntil &&
      (this.options.isUserSpeaking?.() === true || this.options.userActivity.quietForMs(this.now()) < endOfSpeech)
    ) {
      await sleep(200);
    }
    const quiet = this.transcript.find((line) => line.speaker === 'user' && !line.paused && line.consumed < line.text.length)?.quietBefore;
    // A local delegation that brings its own words (an utterance from the unrouted-command net) routes only those.
    let latestUserSpeech = delegation.speech ?? this.takeFreshUserSpeech();
    // ── pause mode hook (pause-mode.ts): "Yankee, pause" in any state; while paused only the resume command counts ──
    if (await this.pause.onSpeech(latestUserSpeech, delegation.local ? null : delegation.id)) return;
    if (!this.alive(generation)) return;
    // ── draft mode hook (draft-mode.ts): a draft takes every word; a held send takes its answer ──
    let noHold = false;
    {
      const delegationId = delegation.local ? null : delegation.id;
      const prototypeUp = this.options.screen?.presentation?.()?.view === 'prototype';
      const drafted = await this.draft.onSpeech(latestUserSpeech, {
        delegationId,
        quick: (speech) => this.quickActions(speech),
        ...(prototypeUp ? { screenRoute: (speech: string) => this.routeScreenSpeech(speech, delegation.prompt) } : {}),
      });
      if (!this.alive(generation)) return;
      if (drafted.handled) {
        this.ownerClock.addressedAt = this.now(); // dictating into a draft is talking to the operator
        // A released "Is that everything?" request can still need "main chat, or the … thread?".
        const released = drafted.actions?.length ? await this.holdUnplacedDispatch(drafted.actions, delegationId, (drafted.handles as ExtractionHandles | undefined) ?? { desk: new Map(this.deskHandles), scenes: new Map(this.sceneHandles), speech: latestUserSpeech }) : [];
        for (const action of released) {
          if (!this.alive(generation)) return;
          await this.apply(action, delegationId, drafted.handles as ExtractionHandles | undefined);
        }
        return;
      }
      if (drafted.speech !== undefined) {
        latestUserSpeech = drafted.speech;
        noHold = true;
      }
    }
    // ── end draft mode hook ──
    // ── destination hook (destination-ask.ts): the answer to "main chat, or the … thread?" ──
    const unanswered = this.destination.expire();
    if (unanswered) this.trace('destination.expired', `“where should it go?” went unanswered: the ${unanswered.agentName} request was not sent`, { message: clipLine(unanswered.action.message, 200) });
    if (latestUserSpeech && this.destination.held) {
      const delegationId = delegation.local ? null : delegation.id;
      const { held } = this.destination.take()!;
      const answer = matchDestinationAnswer(latestUserSpeech, held.options);
      getDecisionShadow().run({ site: 'operator.destination', prompt: destinationDecisionPrompt(latestUserSpeech, held.agentName, held.options), incumbent: { answer: destinationAnswerKey(answer) }, excerpt: latestUserSpeech, meta: { agent: held.agentName, session: this.options.traceSessionId ?? null } });
      if (answer.kind === 'cancel') {
        this.trace('destination.cancel', `the owner called off the ${held.agentName} request: nothing sent`, {});
        await this.append('commentary', '[Nothing was sent. Say only: "Okay, dropped it."]', delegationId);
        return;
      } else if (answer.kind === 'main' || answer.kind === 'thread') {
        const threadId = answer.kind === 'thread' ? answer.threadId : null;
        const where = threadId ? `the ${held.options.find((option) => option.threadId === threadId)?.title ?? ''} thread` : 'the main chat';
        this.trace('destination.answer', `“${clipLine(latestUserSpeech, 60)}” → ${held.agentName} · ${where}`, { threadId, speech: clipLine(latestUserSpeech, 200) });
        await this.apply(withDestination(held.action, threadId), delegationId, held.handles as ExtractionHandles | undefined);
        return;
      } else {
        // Not an answer: the request goes to the main channel, and what was said is routed as usual.
        this.trace('destination.unclear', `“${clipLine(latestUserSpeech, 60)}” didn't say where: ${held.agentName} request sent to the main chat, and this is routed as new speech`, { speech: clipLine(latestUserSpeech, 200) });
        await this.apply(withDestination(held.action, null), delegationId, held.handles as ExtractionHandles | undefined);
        if (!this.alive(generation)) return;
      }
    }
    // ── end destination hook ──
    // ── "For me?" hook (addressee.ts): a yes does the held work; a no or silence drops it; anything else is new speech ──
    this.expireForMe();
    if (latestUserSpeech && this.forMe.held) {
      const delegationId = delegation.local ? null : delegation.id;
      const held = this.forMe.take()!;
      const answer = isPlainYes(normalizeSpeech(latestUserSpeech)) ? 'yes' : matchAddresseeAnswer(latestUserSpeech);
      this.log('forme.answer', { answer, speech: latestUserSpeech, heldSpeech: held.speech, actions: held.actions });
      if (answer === 'yes') {
        this.trace('forme.yes', `“${clipLine(latestUserSpeech, 40)}”: it was for the operator → ${describeActions(held.actions)}`, { speech: clipLine(held.speech, 200), actions: held.actions });
        // A send that sounded cut off still gets "Is that everything?" (draft mode).
        if (held.checkUnfinished && (await this.draft.holdIfUnfinished(held.speech, held.actions, delegationId, held.handles as ExtractionHandles))) return;
        await this.applyRouted(this.draft.filterActions(held.actions), held.speech, delegationId, held.handles as ExtractionHandles, generation);
        return;
      }
      if (answer === 'no') {
        this.trace('forme.no', `“${clipLine(latestUserSpeech, 40)}”: not for the operator, nothing done`, { speech: clipLine(held.speech, 200), actions: held.actions });
        await this.append('instructions', '[Nothing was done: it was not meant for you. This needs no reply: say nothing to it and keep listening.]', delegationId, { silent: true });
        return;
      }
      this.trace('forme.other', `“${clipLine(latestUserSpeech, 60)}” didn't answer “For me?”: the held work was dropped, and this is routed as new speech`, { speech: clipLine(held.speech, 200), actions: held.actions });
      if (!this.alive(generation)) return;
    }
    // ── end "For me?" hook ──
    const prompt = normalizePrompt(delegation.prompt);
    // Forget prompts older than the re-fire window before comparing against them.
    for (const [seen, at] of this.handledPrompts) if (this.now() - at > 10 * 60_000) this.handledPrompts.delete(seen);
    if (latestUserSpeech) this.recentSpeech.push({ text: normalizePrompt(latestUserSpeech), at: this.now() });
    this.recentSpeech = this.recentSpeech.filter((entry) => this.now() - entry.at < 90_000);
    const repeatsPrompt =
      !prompt ||
      [...this.handledPrompts.keys()].some((seen) => samePrompt(seen, prompt)) ||
      // No new speech, and the prompt is only words the user already said in the last 90 s.
      (!latestUserSpeech && this.recentSpeech.some((entry) => fragmentOf(prompt, entry.text)));
    // A bare yes that was already heard (in the transcript, and used: no new speech) answered whatever
    // asked it (a draft's "Send that…?"). Routed late, after the draft was sent, it read as a fresh request
    // and started a duplicate. A prompt-only yes never heard in the transcript is fresh and still routed.
    const heardYes =
      !latestUserSpeech &&
      !!delegation.prompt &&
      isPlainYes(delegation.prompt) &&
      // The same yes: the latest thing the owner said, a plain yes, moments ago (the re-hand-off came 7 s later).
      ((last) => !!last && this.now() - last.updatedAt < 15_000 && isPlainYes(last.text))(this.transcript.filter((line) => line.speaker === 'user').at(-1));
    if (heardYes) {
      this.log('delegation.merged', { id: delegation.id, prompt: delegation.prompt });
      this.trace('delegation.merged', `dropped delegation ${delegation.id}: a bare “${clipLine(delegation.prompt ?? "", 40)}” with nothing new said (already answered)`, { id: delegation.id, prompt: delegation.prompt, reason: 'consumed confirmation' });
      return;
    }
    if (!latestUserSpeech && repeatsPrompt && this.now() - this.lastExtractionAt < 15_000) {
      // Same sentence, handed off twice: the earlier extraction already has it.
      this.log('delegation.merged', { id: delegation.id, prompt: delegation.prompt });
      this.trace('delegation.merged', `dropped delegation ${delegation.id}: the same sentence was routed ${Math.round((this.now() - this.lastExtractionAt) / 1000)} s ago and nothing new was said`, {
        id: delegation.id,
        prompt: delegation.prompt,
        reason: 'repeat of a prompt routed in the last 15 s with no new speech',
      });
      return;
    }
    if (!this.alive(generation)) return;
    this.lastExtractionAt = this.now();
    this.log('delegation', { id: delegation.id, local: delegation.local ?? false, latestUserSpeech, prompt: delegation.prompt });
    this.trace('delegation', `delegation ${delegation.id}${delegation.local ? ' (raised by the operator: unkept hand-off promise)' : ''}: “${clipLine(delegation.prompt ?? '', 160)}”${latestUserSpeech ? '' : ' · no new speech'}`, {
      id: delegation.id,
      local: delegation.local ?? false,
      prompt: delegation.prompt,
      latestUserSpeech: clipLine(latestUserSpeech, 200),
      repeatsPrompt,
    });
    // A delegation the operator raised itself is unknown to GPT-Live; reply session-wide.
    const delegationId = delegation.local ? null : delegation.id;

    const started = this.now();
    let actions: OperatorAction[];
    const screen = this.describeScreen(latestUserSpeech);
    const desk = this.describeDesk(latestUserSpeech);
    // This extraction's own handles: an overlapping one must not re-map "i2" under it.
    const handles: ExtractionHandles = { desk: new Map(this.deskHandles), scenes: new Map(this.sceneHandles), speech: latestUserSpeech };
    let failed = false;
    // Deterministic first: a short command whose target is unambiguous never waits on the model.
    const quick = latestUserSpeech ? this.quickActions(latestUserSpeech) : null;
    if (quick) {
      actions = quick;
      this.log('routed.deterministic', { delegationId: delegation.id, actions });
    } else {
      const place = await this.startPlace();
      const input = {
        agents: this.options.agents,
        tasks: this.tasks.map(toExtractorTask),
        transcript: this.transcriptLines().slice(-14),
        latestUserSpeech,
        delegationPrompt: delegation.prompt,
        threads: [] as ExtractorThread[],
        currentThread: this.currentThread ? this.describeThread(this.currentThread) : undefined,
        screen,
        desk,
        now: this.now(),
        defaultAgentId: this.options.defaultAgentId,
        startPlace: describeStartPlace(place),
        draft: this.draft.routerContext(), // draft mode hook
        ...(quiet ? { quiet } : {}),
      };
      // A thread list that can't be read routes without threads; an explicit thread is then
      // re-checked at dispatch, where a failed lookup is reported (never a main-channel fallback).
      const route = async () => {
        const threads = await this.threadList();
        input.threads = threads.map((thread) => this.describeThread(thread));
        return withTimeout(this.options.extractor(input), this.timeouts.extractorMs, 'router');
      };
      try {
        actions = await route();
      } catch (err) {
        this.log('extractor.error', { message: (err as Error).message, attempt: 1 });
        if (err instanceof OperatorTimeout) {
          // A router that hung once is slow, not flaky: don't make every delegation behind it wait twice.
          actions = [{ type: 'none', reason: 'extractor timed out' }];
          failed = true;
        } else {
          // One retry: the model route fails transiently ("returned no text").
          try {
            await sleep(800);
            actions = await route();
          } catch (retryErr) {
            this.log('extractor.error', { message: (retryErr as Error).message, attempt: 2 });
            actions = [{ type: 'none', reason: 'extractor failed' }];
            failed = true;
          }
        }
      }
    }
    // The session ended while the router ran: this brain must not act on it.
    if (!this.alive(generation)) {
      this.log('delegation.stale', { delegationId: delegation.id, actions });
      this.trace('delegation.stale', `dropped routing for ${delegation.id}: the session ended while it ran`, { delegationId: delegation.id, actions });
      return;
    }
    this.lastExtractionAt = this.now();
    // Re-fired with nothing new said (GPT-Live re-delegating while it waits): looking things up is
    // fine, but nothing is sent or marked again (on 10/05 such re-fires resent approvals with side effects).
    // A request that arrived only as the delegation's prompt (no transcript yet) is new input, not a re-fire.
    const refire = !latestUserSpeech && repeatsPrompt;
    // Only a request that was actually routed counts as handled: after "say it again", the repeat must go through.
    if (prompt && !failed) this.handledPrompts.set(prompt, this.now());
    if (refire) {
      // Only lookups survive: a screen command that moves something (next step, scroll, board) doesn't.
      const kept = actions.filter((action) => SAFE_WITHOUT_SPEECH.has(action.type) && (action.type !== 'screen' || action.op === 'show'));
      const dropped = actions.filter((action) => !kept.includes(action));
      if (kept.length !== actions.length) this.log('delegation.nospeech.dropped', { delegationId: delegation.id, dropped });
      this.trace('delegation.refire', `re-fire of ${delegation.id} with nothing new said: kept ${kept.length ? describeActions(kept) : 'nothing'}${dropped.length ? `, dropped ${describeActions(dropped)}` : ''}`, {
        delegationId: delegation.id,
        reason: 'nothing new was said; only lookups survive a re-fire',
        kept,
        dropped,
      });
      actions = kept.length ? kept : [{ type: 'none', reason: 'nothing new was said' }];
    }
    actions = repairRouted(latestUserSpeech || delegation.prompt || '', actions, new Set(this.tasks.map((task) => task.id)), handles.desk);
    actions = fillRowTarget(latestUserSpeech || delegation.prompt || '', actions);
    actions = fillViewTarget(latestUserSpeech || delegation.prompt || '', actions, this.options.screen?.listPage?.() ?? null);
    const loomNamed = preferNamedLoom(
      latestUserSpeech || delegation.prompt || '',
      actions,
      (desk?.items ?? []).map((item) => ({ handle: item.handle, id: handles.desk.get(item.handle), place: item.place })),
      this.options.agents.map((agent) => ({ id: agent.id, names: [agent.name, ...(agent.aliases ?? [])] })),
    );
    if (loomNamed.some((action, index) => action !== actions[index])) {
      this.trace('routed.loom-named', 'the user named a Loom thread: sent there instead of the agent the router picked', { delegationId: delegation.id, before: actions });
      actions = loomNamed;
    }
    const fresh = preferNewThread(
      latestUserSpeech || delegation.prompt || '',
      actions,
      this.options.agents.map((agent) => ({ id: agent.id, names: [agent.name, ...(agent.aliases ?? [])] })),
      this.loomRepoCache?.repos ?? [],
    );
    if (fresh.some((action, index) => action !== actions[index])) {
      this.trace('routed.new-thread', 'the user asked for a new thread: a new-thread draft, not the dispatch the router picked', { delegationId: delegation.id, before: actions });
      actions = fresh;
    }
    const mainChannel = keepMainChannel(latestUserSpeech || delegation.prompt || '', actions);
    if (mainChannel.some((action, index) => action !== actions[index])) {
      this.trace('routed.main-channel', 'the user asked for the main channel: dropped the thread the router picked', { delegationId: delegation.id, before: actions });
      actions = mainChannel;
    }
    const spaceAsk = this.askWhenOnlySpaceNamed(latestUserSpeech || delegation.prompt || '', actions, handles.desk);
    if (spaceAsk.some((action, index) => action !== actions[index])) {
      this.trace('routed.space-only', 'only a space was named, and it has several threads: asking which one instead of guessing', { delegationId: delegation.id, before: actions });
      actions = spaceAsk;
    }
    this.trace('routed', `${quick !== null ? 'deterministic' : 'model'} routing in ${this.now() - started} ms${failed ? ' (failed)' : ''} → ${describeActions(actions)}`, {
      delegationId: delegation.id,
      ms: this.now() - started,
      deterministic: quick !== null,
      failed,
      actions,
    });
    this.log('extracted', {
      delegationId: delegation.id,
      ms: this.now() - started,
      actions,
      deterministic: quick !== null,
      ...(screen ? { screen: { showing: screen.showing?.title || screen.showing?.summary, choices: screen.showing?.choices, pointedAt: screen.pointedAt } } : {}),
      // What the router saw, so real sessions can be replayed as routing tests.
      input: {
        latestUserSpeech,
        tasks: this.tasks.map((task) => ({ id: task.id, agentName: task.agent.name, status: task.status, threadTitle: task.thread?.title })),
        desk: desk?.items.map((item) => ({ handle: item.handle, id: handles.desk.get(item.handle), agentName: item.agentName, place: item.place, step: item.step })),
        focused: desk?.focused,
      },
    });

    // ── "For me?" hook (addressee.ts): the router wasn't sure this was meant for the operator ──
    // Short commands skip the router: after a long quiet, one that changes something is unsure too (Codex review on #481).
    // Cold: nothing done through the operator for two minutes. Room talk it rejected doesn't warm it.
    const addressedAt = this.ownerClock.addressedAt ?? null;
    if (quick !== null && addressedAt !== null && this.now() - addressedAt >= COLD_QUIET_MS && actions.some(changesSomething) && !actions.some(isUnsureMarker)) {
      actions = [...actions, { type: 'none', reason: UNSURE_REASON }];
    }
    // After the same quiet, a change to a conversation that is neither on screen, nor just discussed, nor named in
    // the speech ("mark it done" with nothing open) is unsure too, whatever the router said (voice regression sweep T1).
    if (addressedAt !== null && this.now() - addressedAt >= COLD_QUIET_MS && !actions.some(isUnsureMarker) && actions.some((action) => this.anchorlessChange(action, latestUserSpeech || delegation.prompt || '', handles.desk))) {
      this.trace('forme.anchorless', `after a long quiet, “${clipLine(latestUserSpeech, 60)}” changes a conversation it doesn't name and nobody has open`, { actions });
      actions = [...actions, { type: 'none', reason: UNSURE_REASON }];
    }
    if (actions.some(isUnsureMarker)) {
      actions = actions.filter((action) => !isUnsureMarker(action));
      const work = actions.filter((action) => action.type !== 'none');
      // With no transcript yet, the voice model's own description is the speech (Codex review on #481).
      const heard = latestUserSpeech || delegation.prompt || '';
      const named = namesSomeone(heard, addresseeNames(this.options.agents));
      if (work.length && !named && !refire && heard && this.options.addresseeCheck !== false) {
        // The router's "unfinished" marker rides along, so a yes still gets "Is that everything?".
        this.forMe.hold({ actions: actions.filter((action) => action.type !== 'none'), speech: heard, handles, checkUnfinished: !failed && !noHold && quick === null });
        this.trace('forme.ask', `not sure “${clipLine(heard, 60)}” was for the operator: asking “For me?” before ${describeActions(work)}`, { speech: clipLine(heard, 200), actions: work, quiet });
        await this.append('commentary', '[Nothing was done yet: that may not have been meant for you. Ask only: "For me?" Then delegate their answer.]', delegationId);
        return;
      }
      if (work.length) this.trace('forme.skip', `router unsure, but ${named ? 'the speech names the operator or an agent' : 'no ask here'}: acting on it`, { speech: clipLine(latestUserSpeech, 200) });
    }
    // ── end "For me?" hook ──

    // ── draft mode hook (draft-mode.ts): an unfinished-sounding send waits for "Is that everything?" ──
    if (!refire && !failed && !noHold && quick === null && (await this.draft.holdIfUnfinished(latestUserSpeech, actions, delegationId, handles))) return;
    actions = this.draft.filterActions(actions);
    // ── end draft mode hook ──

    // A deferred draft start survives a failed route: filterActions turned it into the start (draft mode).
    // A command the net recovered is the owner's request like any other: a failed or empty route is said (Codex review on #750).
    const answers = !delegation.local || delegation.owned === true;
    if (failed && answers && !actions.some((action) => action.type === 'draft' && action.op === 'start')) {
      await this.append('instructions', "[That request didn't go through: routing it failed. Tell the user plainly and ask them to say it again. Don't ask who it was for, and don't say you're checking.]", delegationId);
      return;
    }

    // ── follow-up net: the voice model handed off the owner's response to the answer an agent just gave ──
    // The router read it as thinking aloud ("And you're right, it explains foreknowledge differently…") and
    // GPT-Live answered it itself instead of the agent (voice misroute 10/19). It stays that agent's conversation.
    const followUp = answers && !failed && !refire && !this.draft.active ? this.followUpTask(latestUserSpeech, actions) : null;
    if (followUp) {
      this.trace('routed.follow-up', `the router found nothing to send, but “${clipLine(latestUserSpeech, 60)}” answers what ${followUp.agent.name} just said: sent to ${followUp.agent.name}`, {
        delegationId: delegation.id,
        taskId: followUp.id,
        before: actions,
      });
      this.log('routed.follow-up', { delegationId: delegation.id, taskId: followUp.id, agent: followUp.agent.id });
      actions = [{ type: 'reply', taskId: followUp.id, message: latestUserSpeech }];
    }
    // ── end follow-up net ──

    if (answers && actions.every((action) => action.type === 'none')) {
      // GPT-Live is waiting on an answer that won't come; tell it, so it doesn't hang
      // on "let me check" (and later invent "still checking"). Speech that wasn't meant for
      // the operator gets silence, not "who should take it?" (10/10 audit).
      const quiet = actions.length > 0 && actions.every((action) => action.type === 'none' && action.reason.toLowerCase().startsWith('not for the operator'));
      await this.append(
        'instructions',
        quiet
          ? '[Nothing was sent: that speech was not meant for you. This needs no reply: say nothing to it and keep listening.]'
          : '[Nothing was sent to an agent for that. Answer from the conversation if you can; otherwise ask the user who should take it. Do not say you are checking.]',
        delegationId,
        { silent: quiet },
      );
    }
    await this.applyRouted(actions, latestUserSpeech, delegationId, handles, generation, !refire);
  }

  /** Routed work, last steps: the repeat guard, "main chat, or the … thread?", then each action. */
  private async applyRouted(actions: OperatorAction[], speech: string, delegationId: string | null, handles: ExtractionHandles, generation: number, place = true): Promise<void> {
    // ── repeat guard: "I'm done, send that" right after a send, or the same ask again, sends nothing new ──
    actions = await this.dropRepeatSends(actions, speech, delegationId);
    // ── destination hook: a dispatch the router couldn't place waits for "main chat, or the … thread?" ──
    if (place) actions = await this.holdUnplacedDispatch(actions, delegationId, handles);
    for (const action of actions) {
      if (!this.alive(generation)) return;
      await this.apply(action, delegationId, handles);
    }
  }

  /**
   * The filler gate closed on this utterance after the voice model had already started answering it
   * (the reply can begin before the transcript says filler): that reply was muted, so it is not
   * conversation and promises nothing (Codex review on #481).
   */
  private dropMutedReply(): void {
    const gate = this.options.fillerGate;
    if (!gate || gate.closures === this.seenGateClosures) return;
    this.seenGateClosures = gate.closures;
    const last = this.transcript.at(-1);
    if (last?.speaker !== 'operator' || this.now() - last.updatedAt > 3000) return;
    this.transcript.pop();
    if (this.promiseTimer) {
      clearTimeout(this.promiseTimer);
      this.promiseTimer = null;
    }
    this.log('said.muted', { text: last.text.slice(0, 160) });
  }

  /** "For me?" went unanswered: the held work is dropped. */
  private expireForMe(): void {
    const unanswered = this.forMe.expire();
    if (unanswered) this.trace('forme.expired', `“For me?” went unanswered: ${describeActions(unanswered.actions)} not done`, { speech: clipLine(unanswered.speech, 200), actions: unanswered.actions });
  }

  /** Messages just sent to agents (dispatches and replies), for the repeat guard. */
  private recentSends: Array<{ agentId: string; threadId: string | null; message: string; at: number }> = [];
  /** When each conversation (agent|thread) last got an answer: a closer after it is a real reply, never a repeat. */
  private readonly lastAgentReplyAt = new Map<string, number>();

  private sendAgent(action: OperatorAction): string | null {
    if (action.type === 'dispatch') return action.agentId;
    if (action.type === 'reply') return this.tasks.find((task) => task.id === action.taskId)?.agent.id ?? null;
    return null;
  }

  /**
   * A bare closer ("I'm done", "send that", "that's it") said within a minute of a send, before the agent
   * answered, adds nothing: the router rewrites it into the last ask and the agent answers twice (10/09,
   * Sierra read back twice). Only that is dropped: same agent and thread, restating what was just sent.
   * Anything with new words, a send after the agent answered, or another destination goes out as usual.
   */
  private async dropRepeatSends(actions: OperatorAction[], speech: string, delegationId: string | null): Promise<OperatorAction[]> {
    const now = this.now();
    this.recentSends = this.recentSends.filter((sent) => now - sent.at < 60_000);
    if (!this.recentSends.length || !speech) return actions;
    const finish = matchDraftFinish(speech, this.options.agents);
    if (!finish || finish.content.trim() || finish.agent) return actions;
    const words = (text: string) => new Set(normalizeSpeech(text).split(' ').filter((word) => word.length > 1 && !REPEAT_STOPWORDS.has(word)));
    const repeats = (action: OperatorAction) => {
      if (action.type !== 'dispatch' && action.type !== 'reply') return false;
      const agentId = this.sendAgent(action);
      const threadId = action.type === 'dispatch' ? (action.threadId ?? null) : (this.tasks.find((task) => task.id === action.taskId)?.thread?.id ?? null);
      if (action.type === 'dispatch' && action.newThreadTitle) return false;
      const said = words(action.message);
      return this.recentSends.some((sent) => {
        if (sent.agentId !== agentId || (threadId !== null && sent.threadId !== null && sent.threadId !== threadId)) return false;
        // Answered in that conversation (another conversation with the same agent doesn't count).
        if (sent.at <= (this.lastAgentReplyAt.get(`${sent.agentId}|${sent.threadId ?? ''}`) ?? 0)) return false;
        const before = words(sent.message);
        if (!said.size) return true;
        let shared = 0;
        for (const word of said) if (before.has(word)) shared += 1;
        return shared / said.size >= 0.6;
      });
    };
    const dropped = actions.filter(repeats);
    if (!dropped.length) return actions;
    this.trace('routed.repeat', `“${speech.slice(0, 40)}” closes what was just sent: not sent again`, { delegationId, dropped });
    await this.append('commentary', '[That was already sent a moment ago; nothing new went out. Say only "Already sent." and listen.]', delegationId);
    return actions.filter((action) => !dropped.includes(action));
  }

  /**
   * The first dispatch the router left between the main channel and a thread (threadOptions) is held
   * and the owner is asked where it goes; the other actions go ahead. Options that aren't live threads
   * of that agent are dropped, and with none left the dispatch goes to the main channel as usual.
   */
  private async holdUnplacedDispatch(actions: OperatorAction[], delegationId: string | null, handles: ExtractionHandles): Promise<OperatorAction[]> {
    const index = actions.findIndex((action) => action.type === 'dispatch' && action.threadOptions?.length);
    if (index < 0) return actions;
    const action = actions[index] as Extract<OperatorAction, { type: 'dispatch' }>;
    const agent = this.options.agents.find((candidate) => candidate.id === action.agentId);
    const live = agent ? await this.threadList() : [];
    const options: DestinationOption[] = (action.threadOptions ?? [])
      .map((id) => live.find((thread) => thread.id === id && persona(thread.agentId) === persona(agent!.id)))
      .filter((thread): thread is ThreadInfo => thread !== undefined)
      .map((thread) => ({ threadId: thread.id, title: spokenThread(thread.title) ?? thread.title }));
    // One question at a time: any other unplaced dispatch in the same breath goes to its main channel.
    const rest = actions.filter((_, at) => at !== index).map((candidate) => (candidate.type === 'dispatch' && candidate.threadOptions ? withDestination(candidate, null) : candidate));
    if (!agent || options.length === 0 || this.destination.held) {
      return actions.map((candidate, at) => (at === index ? withDestination(action, null) : candidate));
    }
    this.destination.hold({ action, agentName: agent.name, options, handles });
    const question = destinationQuestion(agent.name, options);
    this.trace('destination.ask', `couldn't tell where the ${agent.name} request goes: asking “${question}”`, { options, message: clipLine(action.message, 200) });
    await this.append('commentary', `[Nothing was sent yet. Ask only: "${question}" Then delegate their answer.]`, delegationId);
    return rest;
  }

  // ── deterministic routing ──────────────────────────────────────────────

  /**
   * Short, unambiguous commands resolved without the model: the board and screen views, a
   * catch-up, the answer to "stop the job too?", and item commands whose target is the item in
   * the Conversation view, the one named agent's item, or the item discussed last.
   */
  private quickActions(speech: string): OperatorAction[] | null {
    const text = speech.toLowerCase().replace(/[^a-z0-9' :]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text || text.split(' ').length > 14) return null;
    // A walk's words while it's on (and not left for half an hour): anything else goes on to the usual routes.
    // "Open System" is the System page even mid-walk: it's where an incident in the walk is handled.
    if (this.walk && this.now() - this.walk.at < WALK_IDLE_MS && !QUICK_SYSTEM_PAGE.test(text)) {
      const walk = matchCatchupCommand(text);
      if (walk) return [{ type: 'catchup', walk }];
    }
    // Two commands in one ("pin this, stop that": a missed one merged into the next) are the router's: a quick match does one (Codex review on #750).
    if (QUICK_ITEM_COMMANDS.filter(({ pattern }) => pattern.test(text)).length + (ANY_STOP.test(text) ? 1 : 0) + (/\bundo\b/.test(text) ? 1 : 0) >= 2) return null;
    const stop = this.pendingStopJob;
    if (stop && this.now() - stop.askedAt < 120_000) {
      if (YES.test(text)) return [{ type: 'desk', op: 'done', item: stop.itemId, stopJob: true }];
      if (NO.test(text)) return [{ type: 'desk', op: 'done', item: stop.itemId, stopJob: false }];
    }
    // "Finish X?" binds only the very next thing said: anything else moves on (Codex review on #717).
    const finish = this.pendingFinish;
    this.pendingFinish = null;
    if (finish && this.now() - finish.askedAt < 120_000) {
      // Finishing closes threads: only a yes with nothing after it ("yes, but not yet" goes to the router). Codex review on #717.
      if (isPlainYes(text) || /^(?:yes|yeah|yep|sure|ok(?:ay)?)?(?:,? ?(?:please|do it|finish it|go ahead))*$/.test(text.replace(/[.!]+$/, '').trim()) && text.trim()) return [{ type: 'project', op: 'finish', project: finish.projectId, confirmed: true }];
      if (NO.test(text) || /^(?:cancel|never ?mind|not yet)\b/.test(text)) return [{ type: 'none', reason: 'finish called off' }];
    }
    if (QUICK_CAPACITY_PAGE.test(text) && this.options.screen?.listPage?.()?.place) return [{ type: 'screen', op: 'list_capacity' }];
    if (QUICK_SYSTEM_PAGE.test(text) && this.options.screen?.listPage?.()?.place) return [{ type: 'screen', op: 'list_system' }];
    if (QUICK_STOP.test(text) && this.options.desk) {
      const open = this.focusedItemId();
      const item = open ? this.deskItems().find((candidate) => candidate.id === open) : undefined;
      if (item?.facts?.running) return [{ type: 'desk', op: 'stop', item: item.id }];
    }
    if (QUICK_UNDO.test(text) && this.options.desk && this.lastUndoable && this.now() - this.lastUndoable.at < UNDO_WINDOW_MS) return [{ type: 'undo' }];
    const pick = this.lastSearch && this.now() - this.lastSearch.at < SEARCH_PICK_MS ? QUICK_SEARCH_PICK.exec(text) : null;
    if (pick && this.lastSearch) {
      const hits = this.lastSearch.hits;
      const index = rowIndex(pick[2]!.replace(/^number /, ''), hits.length);
      const hit = index !== null ? hits[index] : undefined;
      if (hit) {
        const verb = pick[1] ?? 'open';
        // An archived hit can only be read, whatever the verb (Codex review on #717).
        const op: DeskOp = hit.archived || /^(?:read|what|tell)/.test(verb) ? 'read' : verb === 'reopen' ? 'reopen' : 'open';
        return [{ type: 'desk', op, item: hit.itemId }];
      }
    }
    const presentation = this.options.screen?.presentation?.();
    if (QUICK_PROTOTYPE.test(text) && presentation?.prototypes?.length) return [{ type: 'screen', op: 'prototype' }];
    if (presentation?.view === 'prototype') {
      if (QUICK_PAGE_BACK.test(text)) return [{ type: 'screen', op: 'page_back' }];
      // The label as spoken (case kept): the page matches it loosely anyway.
      const click = QUICK_CLICK.exec(speech.replace(/[^A-Za-z0-9' :]+/g, ' ').replace(/\s+/g, ' ').trim());
      // "The second button", "that one", "the blue one": positions and pointers need the model, which has the ordered list.
      if (click?.[1] && !POSITIONAL_TARGET.test(click[1])) return [{ type: 'screen', op: 'click', target: click[1] }];
    }
    if (QUICK_SCREEN.test(text) && this.options.screen) return [{ type: 'screen', op: 'screen' }];
    if (this.options.screen) for (const { op, pattern } of QUICK_SCROLL) if (pattern.test(text)) return [{ type: 'screen', op }];
    if (QUICK_BOARD.test(text) && this.options.screen) return [{ type: 'screen', op: 'board' }];
    if (QUICK_INBOX.test(text) && this.options.screen?.listPage?.()?.place) return [{ type: 'screen', op: 'list_inbox' }];
    if (QUICK_BACK.test(text) && this.options.screen) return [{ type: 'screen', op: this.options.screen.listPage?.()?.place ? 'list_up' : 'board' }];
    if (QUICK_CATCH_UP.test(text) && this.options.desk) return [{ type: 'remind' }];
    if (!this.options.desk) return null;
    // "Next one", "on to the next one", "what's next", "what's waiting on me". A bare "next" only when
    // addressed ("Yankee, next"), and not while a staged screen shows (that "next" may be its next step).
    const addressed = addressedToOperator(speech);
    const nextOp = matchNextCommand(addressed ?? speech, { bare: addressed !== null && this.options.screen?.presentation?.()?.view !== 'screen' });
    if (nextOp) return [{ type: 'next', op: nextOp }];
    // "The first one" / "option two" / "the recommended one" while exactly one Loom question is in focus.
    const focus = this.pendingInFocus();
    if (focus) {
      const label = quickPick(text, focus.pending);
      if (label) return [{ type: 'desk', op: 'respond', item: focus.item.id, answers: [{ question: 'q1', answer: label }] }];
      if (focus.pending.kind === 'approval' && QUICK_APPROVAL.test(text)) {
        const decision = matchDecision(focus.pending, text);
        if (decision) return [{ type: 'desk', op: 'approve', item: focus.item.id, approval: decision }];
      }
    }
    // "Tell Sierra that's done" is a message to Sierra, not a mark: leave relayed words to the model.
    if (RELAY_WORDS.test(text.replace(/\buntil\b.*$/, ''))) return null;
    for (const { op, pattern } of QUICK_ITEM_COMMANDS) {
      const match = pattern.exec(text);
      if (!match) continue;
      // "Don't mark it done" says "mark it done" too: a negated command is the model's to read (live audio test 10/18).
      if (/\b(?:don'?t|do not|never|not|no need to|shouldn'?t|won'?t)\b/.test(text.slice(0, match.index))) return null;
      const args: DeskOpArgs = {};
      if (op === 'snooze') {
        const before = text.slice(0, match.index);
        const rest = text.slice(match.index + match[0].length);
        if (/\buntil (?:i'?m|i am) (?:back )?at (?:my|the) desk\b/.test(text)) args.trigger = 'desk';
        else if (/\buntil (?:they|she|he|it|\w+) (?:post|posts|reply|replies|answer|answers|write|writes)\b/.test(text)) args.trigger = 'agent_posts';
        // A bare "snooze it" means until they post, like a plain tap on the desk's Snooze button. Any other
        // words, before ("don't", "after lunch,") or after ("till 3"), go to the model, which knows how to
        // read them and make an ISO time.
        else if (
          /^[\s.,!]*(?:(?:ok|okay|yeah|yes|sure|cool|great|alright|all right|please|just|go ahead and|and)[\s.,!]*)*$/.test(before) &&
          /^[\s.,!]*(?:(?:please|for now|thanks|thank you)[\s.,!]*)*$/.test(rest)
        ) args.trigger = 'agent_posts';
        else return null;
      }
      const target = this.resolveTarget(text);
      if (!target) return null;
      return [{ type: 'desk', op, item: target, ...args }];
    }
    return null;
  }

  /**
   * The Loom request "the first one" can only mean: the item in the Conversation view (else the one
   * discussed last) is waiting on one single-select question or an approval. Not while a staged
   * scene is showing (its choices are what the owner sees).
   */
  private pendingInFocus(): { item: DeskItemSummary; pending: NonNullable<ReturnType<typeof pendingOf>> } | null {
    if (this.options.screen?.presentation?.()?.view === 'screen') return null;
    const id = this.focusedItemId() ?? this.lastItemId;
    const item = id ? this.deskItems().find((candidate) => candidate.id === id) : undefined;
    const pending = pendingOf(item);
    if (!item || !pending?.requestId) return null;
    return isSingleChoice(pending) || pending.kind === 'approval' ? { item, pending } : null;
  }

  /** The item in the Conversation view right now, if the screens are on one. */
  private focusedItemId(): string | null {
    const presentation = this.options.screen?.presentation?.();
    return presentation && presentation.view !== 'active' ? presentation.itemId : null;
  }

  /**
   * The desk item speech is about, deterministically: a named agent's (or Loom's) only item, or the
   * focused / last-discussed one when it belongs to them; with no name, the item in the
   * Conversation view, else the last discussed. Null when that isn't clear-cut.
   */
  resolveTarget(speech: string): string | null {
    const items = this.options.desk?.items() ?? [];
    const lower = ` ${speech.toLowerCase()} `;
    const named = new Set<string>();
    for (const agent of this.options.agents) {
      const names = [agent.name, ...(agent.aliases ?? [])].map((name) => name.toLowerCase());
      if (names.some((name) => new RegExp(`\\b${name.replace(/[^a-z0-9 ]/g, '')}\\b`).test(lower))) named.add(persona(agent.id));
    }
    // "Loom" or "coding thread": any coding thread, whichever runs it (new threads run on Loom).
    if (/\bloom\b|\bcoding thread\b/.test(lower)) named.add('coding');
    const focused = this.focusedItemId();
    if (named.size > 1) return null;
    if (named.size === 1) {
      const who = [...named][0];
      const theirs = items.filter((item) => ownerKey(item) === who);
      for (const id of [focused, this.lastItemId]) if (id && theirs.some((item) => item.id === id)) return id;
      return theirs.length === 1 ? theirs[0].id : null;
    }
    return focused ?? this.lastItemId ?? null;
  }

  /** Project names by id: the desk's projects, else the List's. */
  private projectNames(): Map<string, string> {
    // Not an item's facts.project: that is its repo's label, not the project's name.
    const names = new Map<string, string>();
    for (const project of this.options.desk?.projects?.() ?? []) names.set(project.id, project.name);
    for (const project of this.options.screen?.listPage?.()?.projects ?? []) if (!names.has(project.id)) names.set(project.id, project.name);
    return names;
  }

  /** Where a new thread starts when the owner doesn't say: the screen's place, as the desk's + button reads it (start-place.ts). */
  async startPlace(): Promise<StartPlace | null> {
    const openId = this.focusedItemId();
    // A snoozed, parked or done thread can be open too: it isn't in the active list (Codex review on #712).
    const open = openId ? await this.deskItem(openId) : null;
    const agent = open ? this.isAgentItem(open) : undefined;
    return startPlace({
      open,
      openAgent: agent ? { id: agent.id, name: agent.name } : null,
      page: this.options.screen?.listPage?.()?.place ?? null,
      projectNames: this.projectNames(),
      agents: this.options.agents,
      items: this.deskItems(),
      repos: this.loomRepoCache?.repos ?? null,
    });
  }

  /** Where it goes isn't settled: one short question, nothing sent (never a quiet fallback to the chief of staff). */
  private async askWhere(question: string, delegationId: string | null, reason: string): Promise<void> {
    this.trace('route.ask', `asked where it goes: “${clipLine(question, 120)}” (${reason})`, { question, reason });
    await this.append('commentary', `[Nothing was sent: where it goes isn't clear. Ask the user only this, in a few words: "${question}" Don't send it anywhere until they answer.]`, delegationId);
  }

  /** "Tell Tango Voice to…" with several Tango Voice threads: which one, never its lead by default (start-place.ts). */
  private askWhenOnlySpaceNamed(speech: string, actions: OperatorAction[], handles: Map<string, string>): OperatorAction[] {
    if (!speech) return actions;
    const items = this.deskItems();
    const listed = [...handles].map(([handle, id]) => ({ handle, item: items.find((candidate) => candidate.id === id) })).filter((entry): entry is { handle: string; item: DeskItemSummary } => !!entry.item);
    const spaceItems = listed.map(({ handle, item }) => ({ handle, id: item.id, place: item.place, about: item.summary?.about ?? null, projectId: item.facts?.projectId ?? null, role: item.facts?.role ?? null }));
    return askWhenOnlySpaceNamed(speech, actions, spaceItems, this.projectNames(), (action) => {
      if (action.type === 'desk' && action.op === 'reply') return action.item ? (handles.get(action.item) ?? null) : null;
      if (action.type === 'dispatch' && action.threadId) return items.find((item) => item.threadId === action.threadId || item.id === action.threadId || item.conversationKey === action.threadId)?.id ?? null;
      return null;
    }, (action) => {
      if (action.type !== 'dispatch' || action.threadId || action.newThreadTitle) return false;
      const agent = this.options.agents.find((candidate) => candidate.id === action.agentId);
      return !agent || ![agent.name, ...(agent.aliases ?? [])].some((name) => new RegExp(`\\b${name.toLowerCase().replace(/[^a-z0-9 ]/g, '')}\\b`).test(speech.toLowerCase()));
    });
  }

  /**
   * A new thread with an agent, through the desk (POST /api/desk/agent-threads), as the + button starts
   * one: the bot opens it, posts the words and wakes the agent; the thread joins the screen's project.
   * The answer comes back through the desk. Never straight to Discord.
   */
  private async startAgentThread(agent: AgentDescriptor, message: string, title: string | undefined, delegationId: string | null, options: { brief?: boolean; draftId?: string; projectId?: string | null } = {}): Promise<DeliveryOutcome> {
    const start = this.options.desk?.startAgentThread?.bind(this.options.desk);
    const what = `a new thread with ${agent.name}`;
    if (!start) {
      this.log('thread.error', { agent: agent.id, newThreadTitle: title, message: 'the desk cannot start agent threads' });
      await this.append('commentary', `[That did not go to ${agent.name}: new threads start through the desk, and it isn't connected. Nothing was sent. Tell the user plainly.]`, delegationId);
      return { ok: false, error: "new threads can't be started from here" };
    }
    const place = options.projectId === undefined ? await this.startPlace() : null;
    const projectId = options.projectId === undefined ? (place?.projectId ?? null) : options.projectId;
    const projectName = projectId ? this.projectNames().get(projectId) : undefined;
    const sentAt = this.now();
    const outcome = await this.bounded('agent thread', start({ agentId: agent.id, prompt: message, ...(title ? { title } : {}), ...(projectId ? { projectId } : {}), commandId: `voice-${options.draftId ?? randomUUID()}` }), 60_000, null);
    if (!outcome?.ok) {
      const error = outcome?.ok === false ? outcome.error : 'the desk did not answer';
      this.log('thread.error', { agent: agent.id, newThreadTitle: title, message: error });
      await this.append('commentary', `[That did not go to ${agent.name}: I couldn't start ${what} (${error}). Nothing was sent, not even to ${agent.name}'s main channel. Tell the user plainly, and that they can say it again in a moment.]`, delegationId);
      return { ok: false, error: `couldn't start the thread (${error})` };
    }
    const filed = projectName && !outcome.projectSkipped ? ` under ${projectName}` : '';
    const skipped = projectName && outcome.projectSkipped ? ` It is not under ${projectName}: that project was finished or deleted meanwhile; say so.` : '';
    this.trace('agent-thread', `new thread with ${agent.name}${filed}: “${outcome.title}”`, { agentId: agent.id, threadId: outcome.threadId, itemId: outcome.itemId, projectId: projectId ?? null });
    this.log('thread.created', { agent: agent.id, threadId: outcome.threadId, title: outcome.title, via: 'desk', projectId: projectId ?? null });
    this.currentThread = { id: outcome.threadId, title: outcome.title || title || 'thread', agentId: agent.id, lastActiveAt: sentAt };
    this.lastItemId = outcome.itemId;
    this.noteSent(outcome.itemId, sentAt);
    // The agent answers in the new thread; the desk relays it here.
    this.watches.set(`thread:${outcome.threadId}`, { kind: 'reply', asked: message, agent: { id: agent.id, name: agent.name, role: agent.role }, sentAt, until: sentAt + REPLY_WATCH_MS, itemId: outcome.itemId, place: outcome.title || title || null });
    this.backToBoardAfterSend('dispatch');
    const where = `${agent.name} in a new thread, "${outcome.title || title}"${filed}`;
    await this.append('instructions', options.brief && !skipped ? `[Started ${where}. Say only "Sent."]` : `[Started ${where}.${skipped} Confirm in a few words ("Started a thread with ${agent.name}${filed}."); don't repeat the request.]`, delegationId);
    return { ok: true };
  }

  private async apply(action: OperatorAction, delegationId: string | null, handles?: ExtractionHandles): Promise<void> {
    if (!this.running) return;
    // Something got done through the operator: a short command right after it is part of the exchange.
    if (action.type !== 'none') this.ownerClock.addressedAt = this.now();
    // Moving on to anything but the search or a pick from it ends the search: "the first one" is the screen's again (Codex review on #717).
    const search = this.lastSearch;
    if (search && action.type !== 'search' && action.type !== 'none' && !(action.type === 'desk' && action.item && search.hits.some((hit) => hit.itemId === action.item || hit.handle === action.item))) this.lastSearch = null;
    switch (action.type) {
      case 'dispatch': {
        // A "thread" that is really another source's conversation (loom:…): the work goes there, not to an agent.
        const foreign = action.threadId && !/^\d+$/.test(action.threadId) ? this.deskItems().find((item) => item.conversationKey === action.threadId || item.id === action.threadId) : undefined;
        if (foreign) {
          await this.replyToItem(foreign, action.message, delegationId);
          return;
        }
        const agent = this.options.agents.find((candidate) => candidate.id === action.agentId);
        // A new thread for a coding sentinel or a repo ("loom", "tango"), or for no one: a new-thread draft, which the
        // screen's place settles or the owner is asked about. Any other unknown id (a name not on the roster) is asked
        // about below, never settled by the screen (Codex review on #712).
        const coding = !agent && (isCodingSourceId(action.agentId) || (this.loomRepoCache?.repos ?? []).some((repo) => repo.toLowerCase() === action.agentId.toLowerCase()));
        if (!agent && action.newThreadTitle && (coding || !action.agentId || action.agentId === 'new')) {
          this.log('dispatch.new-thread', { asked: action.agentId, as: coding ? 'loom' : 'new' });
          await this.draft.applyAction({ type: 'draft', op: 'start', agentId: coding ? 'loom' : 'new', message: action.message }, delegationId);
          return;
        }
        if (!agent && action.agentId && (await this.routeToSource(action.agentId, action.message, delegationId))) return;
        if (!agent) {
          // Never a quiet fallback to the chief of staff: where it goes is the owner's call.
          this.log('dispatch.unknown', { asked: action.agentId });
          await this.askWhere(`Who should take that?`, delegationId, `no agent "${action.agentId}"`);
          return;
        }
        if (action.newThreadTitle) {
          await this.startAgentThread(agent, action.message, action.newThreadTitle, delegationId);
          return;
        }
        let thread: ThreadInfo | undefined;
        try {
          thread = await this.resolveThread(agent, action.threadId);
        } catch (err) {
          // Never a quiet fallback to the agent's main channel: "yes, approve that" means something
          // else there. The request was not sent; the user can say it again.
          const message = (err as Error).message;
          this.log('thread.error', { agent: agent.id, threadId: action.threadId, message, retryable: err instanceof ThreadUnavailable });
          const what = 'reach that thread';
          await this.append(
            'commentary',
            `[That did not go to ${agent.name}: I couldn't ${what} (${message}). Nothing was sent, not even to ${agent.name}'s main channel. Tell the user plainly, and that they can say it again in a moment.]`,
            delegationId,
          );
          return;
        }
        if (!this.running) return;
        await this.startTask(agent, action.message, delegationId, thread);
        return;
      }
      case 'reply': {
        const task = this.tasks.find((candidate) => candidate.id === action.taskId);
        if (!task) {
          // An answer to the desk item being discussed (not a task this session sent).
          const target = this.focusedItemId() ?? this.lastItemId;
          const item = target ? await this.deskItem(target) : null;
          if (item) {
            await this.replyOnItem(item, action.message, delegationId);
            return;
          }
          // Nothing to attach it to: the owner says who it's for (never a quiet fallback to the chief of staff).
          await this.askWhere('Who is that for?', delegationId, 'no open task or conversation matches');
          return;
        }
        // A task attached to another source's conversation (a Loom thread): the follow-up goes into that thread.
        if (task.thread && !/^\d+$/.test(task.thread.id)) {
          const foreign = this.deskItems().find((item) => item.conversationKey === task.thread!.id);
          if (foreign) {
            await this.replyToItem(foreign, action.message, delegationId);
            return;
          }
        }
        if (!this.running) return;
        // The user is responding to this task, so they heard its last update.
        if (this.pending?.item.task === task) this.markDelivered('answered');
        task.turn += 1;
        task.status = 'running';
        task.delegationId = delegationId;
        this.send(task, action.message);
        this.backToBoardAfterSend('reply');
        void this.followConversation(task.agent.id, { threadId: task.thread?.id ?? null, since: task.lastSentAt ?? task.createdAt }, 'reply');
        await this.confirmRoute(task.agent, task.thread, delegationId);
        return;
      }
      case 'status': {
        const next = this.queue.shift();
        if (next) {
          await this.release(next, true);
          return;
        }
        const running = this.tasks.filter((task) => task.status !== 'done');
        const lines = running.map((task) =>
          task.status === 'waiting_user'
            ? `${task.agent.name} is waiting on the user about: ${task.request}`
            : `${task.agent.name} is still working on: ${task.request}${task.progress ? ` (latest: ${task.progress})` : ''}`,
        );
        // The desk knows about work beyond this session: asks typed in Discord, Loom threads, earlier sessions.
        const items = this.deskItems();
        const ours = new Set(running.map((task) => this.taskConversationKey(task)).filter(Boolean));
        const working = items.filter((item) => item.nextStep === 'working' && !ours.has(item.conversationKey));
        for (const item of working.slice(0, 4)) lines.push(`${item.agentName} is working on: ${this.itemLine(item)}`);
        const waiting = items.filter((item) => needsOwner(item) && !offBoard(item));
        if (waiting.length) lines.push(`Waiting on the user on the desk: ${waiting.slice(0, 4).map((item) => `${item.agentName}: ${this.itemLine(item)}`).join('; ')}`);
        const summary = lines.length ? lines.join('. ') : 'Nothing is pending: no agent is working on anything and nothing on the desk is waiting on the user.';
        await this.append('commentary', summary, delegationId);
        return;
      }
      case 'readback': {
        const task = action.taskId ? this.tasks.find((candidate) => candidate.id === action.taskId) : undefined;
        const source = task
          ? { agent: task.agent, text: task.lastFullText ?? task.lastUpdate, place: task.thread?.title, delegationId: task.delegationId }
          : this.lastDelivered
            ? {
                agent: this.lastDelivered.agent,
                text: this.lastDelivered.update.fullText ?? this.lastDelivered.update.text,
                place: this.lastDelivered.place,
                delegationId: null,
              }
            : null;
        if (!source?.text) {
          await this.append('commentary', 'There is nothing to read back yet.', delegationId);
          return;
        }
        const chunks = chunkForReadback(source.text);
        this.log('readback', { agent: source.agent.id, chunks: chunks.length, chars: source.text.length });
        // Ahead of anything else waiting, in order, released as soon as the user is quiet.
        this.queue.unshift(
          ...chunks.map((chunk, index) => ({
            kind: 'readback' as const,
            agent: source.agent,
            update: { kind: 'result' as const, text: chunk },
            place: source.place,
            delegationId: index === 0 ? delegationId : null,
            arrivedAt: this.now(),
            attempts: 0,
            urgent: true,
            part: chunks.length > 1 ? `part ${index + 1} of ${chunks.length}` : undefined,
          })),
        );
        void this.pump();
        return;
      }
      case 'remind':
        await this.catchUp(delegationId);
        return;
      case 'catchup':
        await this.catchupStep(action.walk, delegationId);
        return;
      case 'next':
        await this.nextUp(action.op, { exclude: [], delegationId });
        return;
      case 'screen':
        await this.applyScreen(action.op, action.agentId, delegationId, action.scene, handles?.scenes, { target: action.target, text: action.text });
        return;
      case 'desk':
        await this.applyDesk(action, delegationId, handles?.desk, handles?.speech);
        return;
      case 'undo':
        await this.undoLast(delegationId);
        return;
      case 'search':
        await this.searchDesk(action.query, delegationId);
        return;
      case 'capacity':
        await this.speakCapacity(delegationId);
        return;
      case 'system':
        await this.speakSystem(delegationId);
        return;
      case 'project':
        await this.projectLifecycle(action, delegationId);
        return;
      case 'draft': // draft mode hook (draft-mode.ts)
        await this.draft.applyAction(action, delegationId, (handle) => this.draftItemRef(this.resolveDeskHandle(handle, handles?.desk ?? this.deskHandles)));
        return;
      case 'ask':
        await this.askWhere(action.question, delegationId, action.reason ?? 'the router asked');
        return;
      case 'none':
        return;
    }
  }

  // ── draft mode host (draft-mode.ts) ────────────────────────────────────

  /** What this operator lends the session's draft: speech, routing, sending, the desk card. */
  private createDraftHost(): DraftHost {
    return {
      agents: this.options.agents,
      traceSessionId: this.options.traceSessionId ?? null,
      now: () => this.now(),
      alive: () => this.running,
      append: (kind, content, delegationId) => this.append(kind, content, delegationId),
      trace: (kind, summary, data) => this.trace(kind, summary, data),
      log: (event, data) => this.log(event, data),
      publish: (card) => this.options.desk?.publishDraft?.(card),
      desk: this.options.desk,
      context: async () => {
        const desk = this.describeDesk();
        const handles = new Map(this.deskHandles);
        const threads = (await this.threadList()).map((thread) => this.describeThread(thread));
        const loomRepos = await this.loomRepos();
        const startPlace = await this.startPlace();
        return {
          input: { agents: this.options.agents, tasks: this.tasks.map(toExtractorTask), threads, ...(desk ? { desk } : {}), ...(loomRepos?.length ? { loomRepos } : {}), transcript: this.transcriptLines().slice(-14), now: this.now(), startPlace },
          handleOf: (itemId) => [...handles].find(([, id]) => id === itemId)?.[0] ?? null,
          resolveItem: (handle) => {
            const id = this.resolveDeskHandle(handle, handles);
            const item = id ? this.deskItems().find((candidate) => candidate.id === id) : undefined;
            if (!item) return null;
            const agent = this.isAgentItem(item);
            return { id: item.id, agentId: agent?.id ?? item.agentId, agentName: agent?.name ?? item.agentName, place: item.place, threadId: item.threadId, isAgent: !!agent, about: item.summary?.about ?? null, projectId: item.facts?.projectId ?? null };
          },
        };
      },
      // The normal send path, reporting whether it was accepted (the draft is kept when it wasn't).
      send: async (destination, message, delegationId, sendOptions) => {
        if (!this.running) return { ok: false, error: 'the voice session ended' };
        const brief = sendOptions?.brief === true;
        if (destination.kind === 'item' && destination.itemId) {
          const item = await this.deskItem(destination.itemId);
          if (!item) return { ok: false, error: "that conversation isn't on the desk any more" };
          return this.replyToItem(item, message, delegationId, { brief });
        }
        if (destination.kind === 'new_loom') {
          const startWork = this.options.desk?.startWork?.bind(this.options.desk);
          if (!startWork || !destination.repo) return { ok: false, error: "Loom threads can't be started from here" };
          // One id per draft: a retried send can't start a second thread, and a new draft always starts its own.
          // In a project: the thread joins it, as the desk's + button files it.
          const outcome = await startWork({ repo: destination.repo, prompt: message, ...(destination.title ? { title: destination.title } : {}), ...(destination.projectId ? { projectId: destination.projectId } : {}), commandId: `voice-${sendOptions?.draftId ?? randomUUID()}` });
          if (!outcome.ok) return { ok: false, error: `couldn't start the Loom thread (${outcome.error})` };
          // The project was finished or deleted meanwhile: the thread started, on its own (Codex review on #712).
          if (outcome.projectSkipped && destination.projectName) await this.append('commentary', `[The new thread started, but not under ${destination.projectName}: that project was finished or deleted meanwhile. Say so in a few words.]`, delegationId);
          this.trace('start-work', `new thread in ${destination.repo}${destination.projectName ? ` under ${destination.projectName}` : ''}${destination.inferred ? ' (from the screen)' : ''} on ${outcome.account}: “${outcome.title}”`, { repo: destination.repo, threadId: outcome.threadId, projectId: destination.projectId ?? null, inferred: destination.inferred === true });
          this.noteSent(outcome.itemId);
          return { ok: true };
        }
        const agent = this.options.agents.find((candidate) => candidate.id === destination.agentId);
        if (!agent) return { ok: false, error: `unknown agent "${destination.agentId}"` };
        // A new thread with an agent starts through the desk, filed where the draft says.
        if (destination.kind === 'new_thread') return this.startAgentThread(agent, message, destination.title, delegationId, { brief, ...(sendOptions?.draftId ? { draftId: sendOptions.draftId } : {}), projectId: destination.projectId ?? null });
        let thread: ThreadInfo | undefined;
        try {
          thread = await this.resolveThread(agent, destination.kind === 'thread' ? destination.threadId : undefined);
        } catch (err) {
          const error = (err as Error).message;
          this.log('thread.error', { agent: agent.id, threadId: destination.threadId, message: error, draft: true });
          return { ok: false, error: `couldn't reach that thread (${error})` };
        }
        // Never a quiet fallback to the main channel when a thread was meant.
        if (!thread && destination.kind !== 'home') return { ok: false, error: "couldn't find that thread" };
        if (!this.running) return { ok: false, error: 'the voice session ended' };
        if (destination.itemId) this.lastItemId = destination.itemId;
        // The conversation it answers, even when that is an agent's main channel (kind 'home', no itemId).
        this.noteSent(destination.itemId ?? sendOptions?.itemId);
        await this.startTask(agent, message, delegationId, thread, { brief });
        return { ok: true };
      },
      route: async (speech) => {
        const input = {
          agents: this.options.agents,
          tasks: this.tasks.map(toExtractorTask),
          transcript: this.transcriptLines().slice(-14),
          latestUserSpeech: speech,
          now: this.now(),
          draft: this.draft.routerContext(),
          ...(this.options.defaultAgentId ? { defaultAgentId: this.options.defaultAgentId } : {}),
        };
        return this.bounded('router (draft)', this.options.extractor(input), this.timeouts.extractorMs, [] as OperatorAction[]);
      },
      collect: () => {
        if (this.extracting > 0 || !this.hasFreshUserSpeech()) return;
        this.syntheticSeq += 1;
        void this.onDelegation({ id: `draft-${this.syntheticSeq}`, offsetMs: 0, local: true });
      },
      replay: (speech) => {
        if (!this.running || !speech.trim()) return;
        this.replaySpeech.push(speech.trim());
        this.syntheticSeq += 1;
        void this.onDelegation({ id: `draft-replay-${this.syntheticSeq}`, offsetMs: 0, local: true });
      },
      hasFreshSpeech: () => this.hasFreshUserSpeech(),
      userQuietMs: () => (this.options.isUserSpeaking?.() === true ? 0 : this.options.userActivity.quietForMs(this.now())),
      paused: () => this.pause.active,
      screenVisible: () => (this.options.screen?.screensConnected() ?? 0) > 0,
      deskTargets: () => this.deskItems().map((item) => this.draftItemRef(item.id)).filter((ref): ref is NonNullable<typeof ref> => ref !== null),
      pickScreen: () => this.pickScreen(),
      showContext: ({ item, agent }) => void this.showDraftContext(item, agent),
      brief: (itemId) => this.itemBrief(itemId),
      presentBoard: () => this.presentBoard('draft-left', 'left the draft'),
      next: (op, context) => this.nextUp(op, context),
    };
  }

  /** The board (Active) back up for the owner, if a screen shows something else. */
  private presentBoard(after: string, why: string): void {
    const view = this.options.screen?.presentation?.()?.view;
    this.trace('view.decision', `${why}: ${view && view !== 'active' ? `${view} → board` : 'already on the board: unchanged'}`, { after, from: view ?? 'unknown', to: view && view !== 'active' ? 'active' : 'unchanged' });
    if (view && view !== 'active') void this.present({ view: 'active', reason: 'user' });
  }

  // ── next up (next-up.ts) ───────────────────────────────────────────────

  /** A message went to this desk item: it is not the "next one" for a couple of minutes. */
  /**
   * The repos a new Loom thread can start in, for the draft compile. Cached for five minutes (a failed
   * lookup retries after one) and refreshed in the background, so no draft ever waits on Loom.
   */
  private async loomRepos(): Promise<string[] | null> {
    const lookup = this.options.desk?.startWorkRepos;
    if (!lookup) return null;
    // A failed lookup (Loom or the desk down) is remembered for a minute, so drafts don't each wait on it again.
    const ttl = this.loomRepoCache?.ok ? 5 * 60_000 : 60_000;
    const stale = !this.loomRepoCache || this.now() - this.loomRepoCache.at > ttl;
    if (stale && !this.loomRepoFetch) {
      this.loomRepoFetch = lookup
        .call(this.options.desk)
        .catch(() => null)
        .then((repos) => {
          // A failed lookup keeps the last list it had.
          this.loomRepoCache = { at: this.now(), ok: !!repos, repos: repos ?? this.loomRepoCache?.repos ?? null };
          return this.loomRepoCache.repos;
        })
        .finally(() => {
          this.loomRepoFetch = null;
        });
    }
    // Never waits: the operator's start() looks the list up ahead of the first draft.
    return this.loomRepoCache?.repos ?? null;
  }

  private noteSent(itemId: string | null | undefined, sentAt = this.now()): void {
    // A message, answer or new thread went out: it can't be unsent, so undo ends here (Codex review on #717).
    this.lastUndoable = null;
    if (itemId) this.recentlySent.set(itemId, this.now());
    if (itemId) this.inExchange.set(itemId, this.now());
    if (itemId) this.dropSuperseded(itemId, sentAt);
  }

  /**
   * The owner just replied in this conversation: a question from it still waiting in the queue (held while they
   * drafted) is older than that reply, which answers it. Playing one after "Sent." re-asked what the owner had
   * just answered, as if the reply never went out. Only questions for this very item are dropped (results and
   * failures still play; another chapter sharing a channel key is never touched), and nothing is marked heard:
   * they weren't played (Codex review on #448).
   */
  private dropSuperseded(itemId: string, sentAt: number): void {
    const desk = this.deskItems().find((item) => item.id === itemId);
    const key = desk?.conversationKey ?? null;
    const thread = desk?.threadId ?? null;
    const ofIt = (item: QueuedUpdate) =>
      item.deskItemIds?.length ? item.deskItemIds.includes(itemId) : (!!thread && item.task?.thread?.id === thread) || (!!key && !!thread && item.conversationKey === key);
    // By the update's declared kind only: a result with a "?" in it (a quote, an error) still plays (Codex review on #448).
    const stale = this.queue.filter((item) => item.kind !== 'readback' && item.arrivedAt < sentAt && ofIt(item) && item.update.kind === 'question');
    if (!stale.length) return;
    for (const item of stale) this.queue.splice(this.queue.indexOf(item), 1);
    this.trace('speech.superseded', `${stale.length} waiting question${stale.length === 1 ? '' : 's'} from the conversation just replied to: not played (the reply answers ${stale.length === 1 ? 'it' : 'them'})`, { itemId, count: stale.length });
  }

  /** Desk items the owner sent something to lately: a screen their answer brings up arms a draft (quietly). */
  private readonly inExchange = new Map<string, number>();

  /** The desk item a task's messages land in: its thread's item, else the agent's latest main-channel chapter. */
  private itemForTask(task: OperatorTask): string | null {
    const items = this.deskItems();
    if (task.thread?.id) return items.find((item) => item.threadId === task.thread!.id)?.id ?? null;
    return (
      items
        .filter((item) => !item.threadId && persona(this.isAgentItem(item)?.id ?? item.agentId) === persona(task.agent.id))
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0]?.id ?? null
    );
  }

  /** The desk item a screen presentation belongs to. */
  private screenItemId(presentation: PresentationState): string | null {
    if (presentation.itemId) return presentation.itemId;
    const key = presentation.conversationKey;
    return key ? (this.deskItems().find((item) => item.conversationKey === key)?.id ?? null) : null;
  }

  /**
   * A conversation read or opened by voice: the owner is in it now. A draft for it (without one, another
   * agent's answer interrupted the read-back, and the reply that followed was routed as a desk command).
   */
  /** When the latest voice read/open put the owner in a conversation, and the parts its draft held then. */
  private focusStart: { itemId: string; at: number; parts: number } | null = null;
  /** When a voice tab or project change last went unconfirmed by the screen (null: the last one landed). */
  private listUnsettledAt: number | null = null;

  private focusDraft(itemId: string): void {
    if (this.pause.active) return;
    const ref = this.draftItemRef(itemId);
    if (!ref) return;
    this.focusStart = { itemId, at: this.now(), parts: this.draft.focusItemId === itemId ? this.draft.partCount : 0 };
    // A parked draft comes back with its parts: count them once it's armed (start() restores them synchronously).
    queueMicrotask(() => {
      if (this.focusStart?.itemId === itemId && this.draft.focusItemId === itemId) this.focusStart.parts = Math.max(this.focusStart.parts, this.draft.partCount);
    });
    this.trace('draft.arm', `${ref.agentName}${ref.place ? ` · ${ref.place}` : ''} read or opened by voice: a draft for it, other updates wait`, { itemId, focus: true });
    void this.draft.armForItem(ref, { focus: true });
  }

  /** The owner opened a screen by voice ("open the screen"): its conversation gets a draft, with the refresher. */
  private armForOpenedScreen(): void {
    if (this.pause.active || this.draft.active) return;
    const presentation = this.options.screen?.presentation?.();
    const itemId = presentation?.view === 'screen' || presentation?.view === 'prototype' ? this.screenItemId(presentation) : null;
    const ref = itemId ? this.draftItemRef(itemId) : null;
    if (!ref) return;
    this.trace('draft.arm', `${presentation!.view} opened by voice: ${ref.agentName}${ref.place ? ` · ${ref.place}` : ''} is open, arming a draft for it`, { itemId: ref.id });
    this.lastItemId = ref.id;
    // A prototype is for using: the draft waits quietly for feedback, with no spoken refresher first.
    void this.draft.armForItem(ref, presentation!.view === 'prototype' ? { quiet: true } : {});
  }

  /** The last screen presentation a quiet draft was armed for: a re-broadcast of it never re-arms (say, after a discard). */
  private lastAutoArmed: string | null = null;

  /**
   * A screen the operator put up with an agent's answer (not a tap): when the owner is mid-exchange with
   * that conversation (sent it something in the last 10 minutes), a quiet draft is armed for it, so their
   * reply and "I'm done" work as on the conversation view. No refresher: they just heard the answer.
   */
  private armForAnsweredScreen(presentation: PresentationState): void {
    if (presentation.view !== 'screen' || this.pause.active || this.draft.active) return;
    const itemId = this.screenItemId(presentation);
    const at = itemId ? this.inExchange.get(itemId) : undefined;
    if (!itemId || at === undefined || this.now() - at > 10 * 60_000) return;
    const key = `${itemId}@${presentation.sceneId ?? ''}@${presentation.since ?? ''}`;
    if (key === this.lastAutoArmed) return;
    const ref = this.draftItemRef(itemId);
    if (!ref) return;
    this.lastAutoArmed = key;
    this.trace('draft.arm', `${ref.agentName}${ref.place ? ` · ${ref.place}` : ''}: its screen came up with the answer mid-exchange, arming a quiet draft`, { itemId, auto: true });
    this.lastItemId = itemId;
    void this.draft.armForItem(ref, { quiet: true });
  }

  private sentRecently(): Set<string> {
    for (const [id, at] of this.recentlySent) if (this.now() - at > NEXT_SENT_EXCLUDE_MS) this.recentlySent.delete(id);
    return new Set(this.recentlySent.keys());
  }

  /**
   * "Next one": the oldest item waiting on the owner (other than the one open, the ones in `exclude`,
   * and any just sent to) opens with a draft for it, as a pick by voice does. "What's next": the board
   * goes up and the operator says how many wait and the first three with their waits; "the second one"
   * then picks from that list.
   */
  private async nextUp(op: NextOp, context: { exclude: string[]; delegationId: string | null; board?: boolean; note?: string }): Promise<void> {
    const { delegationId } = context;
    const note = context.note ?? '';
    const desk = this.options.desk;
    if (!desk) {
      await this.append('commentary', `[${note}The desk is not connected in this session, so there is no queue to go through. Say so briefly.]`, delegationId);
      return;
    }
    const queue = await this.bounded('desk next', desk.next(), this.timeouts.deskMs, null);
    if (!this.running) return;
    if (!queue) {
      this.trace('next.empty', `couldn't read the queue from the desk (${op})`, { op, unavailable: true });
      await this.append('commentary', `[${note}Say briefly that you couldn't reach the desk just now.]`, delegationId);
      return;
    }
    const excluded = new Set([...context.exclude, ...this.sentRecently()]);
    if (op === 'advance') {
      const focused = this.focusedItemId();
      if (focused) excluded.add(focused);
      const waiting = queue.filter((item) => !excluded.has(item.id));
      if (waiting.length === 0) {
        this.trace('next.empty', `next one: nothing else is waiting (${queue.length} in the queue, ${excluded.size} excluded)`, { op, queue: queue.map((item) => item.id), excluded: [...excluded] });
        this.presentBoard('next-empty', 'nothing else waiting');
        await this.append('commentary', `[${note}Say only: "Nothing else is waiting on you."]`, delegationId);
        return;
      }
      const first = waiting[0]!;
      const ref = await this.nextItemRef(first);
      if (!this.running) return;
      this.trace('next.advance', `next one: ${first.agentName}${first.place ? ` · ${first.place}` : ''}, waiting ${Math.round((this.now() - first.waitingSince) / 60_000)} min (oldest of ${waiting.length})`, { itemId: first.id, queue: queue.map((item) => item.id), excluded: [...excluded] });
      this.lastItemId = ref.id;
      const opened = await this.draft.openForNext(ref, delegationId, note);
      if (!opened) await this.append('commentary', '[A draft is still open, so nothing else was opened. Say only: "Finish or cancel this draft first."]', delegationId);
      return;
    }
    const waiting = queue.filter((item) => !excluded.has(item.id));
    const refs = await Promise.all(waiting.map((item) => this.nextItemRef(item)));
    if (!this.running) return;
    this.draft.offer(refs);
    this.trace(waiting.length ? 'next.list' : 'next.empty', waiting.length ? `what's next: ${waiting.length} waiting, read the first ${Math.min(3, waiting.length)}` : "what's next: nothing is waiting", { op, itemIds: waiting.map((item) => item.id) });
    if (context.board !== false) this.presentBoard('next-list', "what's next");
    await this.append('commentary', `[${note}Tell the user, in these words or very close, then listen: "${nextSummary(waiting, this.now())}"]`, delegationId);
  }

  /** A queue item as draft mode sees it: from the desk listing, else its detail (it may be newer than the listing). */
  private async nextItemRef(item: DeskNextItem): Promise<DraftItemRef> {
    const listed = this.draftItemRef(item.id);
    if (listed) return listed;
    const detail = await this.bounded('desk item', this.options.desk?.item(item.id), this.timeouts.deskMs, null);
    const agent = this.options.agents.find((candidate) => candidate.id === item.agentId) ?? this.options.agents.find((candidate) => persona(candidate.id) === persona(item.agentId));
    return {
      id: item.id,
      agentId: agent?.id ?? item.agentId,
      agentName: agent?.name ?? item.agentName,
      place: detail?.place ?? item.place,
      threadId: detail?.threadId ?? null,
      isAgent: !!agent,
      about: detail?.summary?.about ?? item.title ?? null,
    };
  }

  /**
   * The owner tapped a conversation's card on a screen (the desk's presentation moved to it, by a
   * screen, or for reason 'user' by anyone but this director): with the voice live, a draft for it
   * is armed. Paused, or a presentation this operator made itself, arms nothing.
   */
  private onDeskPresentation(presentation: PresentationState): void {
    if (!this.running) return;
    const tapped = presentation.by === 'screen' || (presentation.reason === 'user' && presentation.by !== 'director');
    if (!tapped) {
      this.armForAnsweredScreen(presentation);
      return;
    }
    // The owner just touched a screen: that is activity (the idle return must not undo the tap at once).
    this.noteActivity();
    // …and it outranks any draft-context lookup still in flight (that one must not change the view now).
    this.draftContextSeq += 1;
    // The latest tap wins: a slower lookup for an earlier one must not arm it after this.
    const seen = `${presentation.view}:${presentation.itemId ?? ''}@${presentation.since ?? this.now()}`;
    this.latestPresentation = seen;
    // The board tapped while drafting for a conversation: parked, as "back to the board" would (paused too).
    if (presentation.view === 'active') {
      if (this.draft.leaveForBoard('board tapped')) this.trace('view.decision', 'the board was tapped while drafting: the draft is parked with its conversation', { after: 'board-tap', to: 'active', paused: this.pause.active });
      return;
    }
    // Paused: a tapped conversation arms nothing.
    if (this.pause.active) return;
    // A conversation, or a screen of one (opened by a tap, or "open the screen"): either arms a draft for it.
    const itemId = presentation.view === 'conversation' ? presentation.itemId : presentation.view === 'screen' ? this.screenItemId(presentation) : null;
    if (!itemId) return;
    // The same presentation re-broadcast (a manual flag changing, a status refresh) arms once.
    const key = `${itemId}@${presentation.since ?? ''}`;
    if (presentation.since !== undefined && key === this.lastArmedPresentation) return;
    const arm = (ref: DraftItemRef): void => {
      // Recorded only once it is armed: an item the listing didn't know yet can still arm on a re-broadcast.
      this.lastArmedPresentation = key;
      this.trace('draft.arm', `${presentation.view === 'screen' ? 'screen opened' : 'card tapped'}: ${ref.agentName}${ref.place ? ` · ${ref.place}` : ''} is open, arming a draft for it`, { itemId: ref.id, by: presentation.by ?? null, reason: presentation.reason ?? null, view: presentation.view });
      this.lastItemId = ref.id;
      void this.draft.armForItem(ref);
    };
    const ref = this.draftItemRef(itemId);
    if (ref) {
      arm(ref);
      return;
    }
    // A new item the desk listing hasn't caught up with: refresh it and try once more.
    const desk = this.options.desk;
    const generation = this.generation;
    if (!desk) return;
    void this.bounded('desk items', desk.refresh(), this.timeouts.deskMs, [] as DeskItemSummary[]).then(async () => {
      // Not in the active listing (the owner can tap any conversation the desk shows: a snoozed or seen
      // chapter, a thread in another view; TGO-1050): read the item itself.
      const fetched = this.draftItemRef(itemId) ? null : await this.bounded('desk item', desk.item(itemId), this.timeouts.deskMs, null);
      if (!this.alive(generation) || this.pause.active) return;
      if (this.latestPresentation !== seen) {
        this.trace('draft.arm.skipped', `tapped ${itemId}, but the screens moved on before the desk listing caught up: no draft`, { itemId });
        return;
      }
      // A re-broadcast of the same tap armed it meanwhile.
      if (presentation.since !== undefined && key === this.lastArmedPresentation) return;
      const retried = this.draftItemRef(itemId) ?? (fetched && !fetched.hidden ? this.draftRefOf(fetched) : null);
      if (retried) arm(retried);
      else this.trace('draft.arm.skipped', `tapped ${itemId}, which the desk doesn't know even after a refresh: no draft`, { itemId });
    });
  }

  /**
   * "Let's work on a response for the shed vents thread": while the owner composes, the screens show
   * what the draft answers (the Draft banner sits over it). The conversation named, else the agent's
   * most recent one; its latest screen instead when that is the newest thing in it.
   */
  /**
   * A desk conversation in words for when it is opened: a refresher from its summary (what it's
   * working toward, where it stands, what waits on the owner) and the latest reply as plain text.
   */
  private async itemBrief(itemId: string): Promise<ItemBrief | null> {
    const desk = this.options.desk;
    if (!desk) return null;
    const detail = await this.bounded('desk item', desk.item(itemId), this.timeouts.deskMs, null);
    if (!detail) return null;
    const summary = detail.summary ?? null;
    const who = detail.agentName;
    const pending = pendingOf(detail);
    const questions = summary?.questions?.length ? summary.questions.map((question) => question.q) : detail.ask ? [detail.ask] : [];
    const parts = [
      summary?.milestone ? `What it's working toward: ${summary.milestone}.` : summary?.goal ? `What it's for: ${summary.goal}.` : '',
      summary?.gist ? `Where it stands: ${summary.gist}` : `Where it stands: ${this.itemLine(detail)}`,
      detail.nextStep === 'working' ? `${who} is still working on it.` : detail.nextStep === 'failed' ? `${who}'s last turn failed.` : '',
      pending
        ? `It's blocked on the user: ${speakPending(who, pending)}`
        : questions.length
          ? `Waiting on the user: ${questions.join(' Also: ')}`
          : '',
    ];
    const last = [...detail.messages].reverse().find((message) => message.author === 'agent');
    const full = detail.reply?.text ?? last?.text ?? null;
    return { brief: parts.filter(Boolean).join(' '), full: full ? plainForSpeech(full) : null };
  }

  /** Bumped by each draft-context request and each owner tap: a slower, older lookup never overrides newer navigation. */
  private draftContextSeq = 0;

  private async showDraftContext(ref: DraftItemRef | null, agent: AgentDescriptor | null): Promise<void> {
    const screen = this.options.screen;
    if (!screen || screen.screensConnected() === 0) {
      this.trace('view.decision', 'draft context: no screen connected: unchanged', { after: 'draft', to: 'unchanged' });
      return;
    }
    const items = this.deskItems().filter((item) => !offBoard(item));
    const item = ref
      ? items.find((candidate) => candidate.id === ref.id)
      : agent
        ? items.filter((candidate) => persona(this.isAgentItem(candidate)?.id ?? candidate.agentId) === persona(agent.id)).sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0]
        : undefined;
    if (!item) {
      this.trace('view.decision', `draft context: nothing of ${agent?.name ?? 'theirs'} on the desk: unchanged`, { after: 'draft', to: 'unchanged' });
      return;
    }
    const agentId = this.isAgentItem(item)?.id ?? item.agentId;
    // The conversation's screens: by its key (Loom threads and home-channel chapters have no thread id), else its thread.
    const inItem = (candidate: ScreenScene) => (!!candidate.conversationKey && candidate.conversationKey === item.conversationKey) || (item.threadId != null && candidate.threadId === item.threadId);
    const newest = (a: ScreenScene, b: ScreenScene) => b.updatedAt - a.updatedAt;
    const own = screen.staged(agentId).filter(inItem).sort(newest);
    const all = screen.staged();
    const seq = ++this.draftContextSeq;
    const generation = this.generation;
    const shownBefore = screen.presentation?.()?.since ?? null;
    const moved = () => !this.running || generation !== this.generation || seq !== this.draftContextSeq || (screen.presentation?.()?.since ?? null) !== shownBefore;
    const detail = own.length || all.length ? (this.options.desk ? await this.bounded('desk item', this.options.desk.item(item.id), this.timeouts.deskMs, null) : null) : null;
    // The owner may have moved on while the desk answered (a tap, another draft): leave the screens alone then.
    if (moved()) {
      this.trace('view.decision', 'draft context: the view changed while looking it up: unchanged', { after: 'draft', to: 'unchanged' });
      return;
    }
    const messages = (detail?.messages ?? []).filter((message) => message.author === 'agent' || message.author === 'owner');
    // A screen from another conversation is a candidate when the latest messages name it (title, slot or id).
    const recent = messages.slice(-4).map((message) => message.text.toLowerCase()).join('\n');
    const named = (candidate: ScreenScene) => {
      const title = (candidate.title || '').trim().toLowerCase();
      const slot = (candidate.slot || '').trim().toLowerCase();
      return (title.length >= 6 && recent.includes(title)) || (slot.length >= 4 && slot !== 'main' && new RegExp(`\\b${slot.replace(/[^a-z0-9-]/g, '')}\\b`).test(recent)) || recent.includes(candidate.id.toLowerCase());
    };
    const others = all.filter((candidate) => !own.some((mine) => mine.id === candidate.id) && named(candidate)).sort(newest);
    const candidates = [...own.slice(0, 4), ...others.slice(0, 2)];
    // Without a judge (or when it fails): the newest own screen if it went up with (or after) the last message.
    const lastAt = (author: 'agent' | 'owner') => [...messages].reverse().find((message) => message.author === author)?.at ?? 0;
    const lastAgent = lastAt('agent') || (messages.length ? 0 : item.lastActivityAt);
    const byRecency = own[0] && own[0].updatedAt >= lastAgent - 30_000 && own[0].updatedAt >= lastAt('owner') ? own[0] : null;
    let chosen: ScreenScene | null = byRecency;
    let how = 'recency';
    // Judged only with the conversation in hand: without its messages, recency decides.
    if (candidates.length && this.options.pickScreen && detail) {
      const verdict = await this.bounded(
        'screen pick',
        this.options.pickScreen({
          place: item.place ?? null,
          agentName: item.agentName,
          now: this.now(),
          messages: messages.map((message) => ({ author: message.author, text: message.text, at: message.at })),
          screens: candidates.map((candidate) => ({ id: candidate.id, title: candidate.title || candidate.summary || 'Screen', summary: candidate.summary || '', updatedAt: candidate.updatedAt, fromThisConversation: own.includes(candidate) })),
        }).catch(() => null),
        3000,
        null,
      );
      if (moved()) {
        this.trace('view.decision', 'draft context: the view changed while judging it: unchanged', { after: 'draft', to: 'unchanged' });
        return;
      }
      if (verdict) {
        chosen = verdict.pick ? (candidates.find((candidate) => candidate.id === verdict.pick) ?? null) : null;
        how = `judged: ${clipLine(verdict.reason || (chosen ? 'the screen is what this is about' : 'the conversation has moved on'), 90)}`;
      }
    } else if (!candidates.length) {
      chosen = null;
    }
    if (chosen) {
      const shown = await this.showScene(chosen, 'user');
      this.trace('view.decision', `draft context: ${shown ? 'showed' : 'asked for'} “${clipLine(chosen.title || chosen.summary, 50)}” (${how})${shown ? '' : ' (not shown)'}`, { after: 'draft', to: 'screen', sceneId: chosen.id, shown: !!shown, how, candidates: candidates.map((candidate) => candidate.id) });
      if (shown) return;
    }
    this.trace('view.decision', `draft context: open the conversation ${item.id}${candidates.length ? ` (${how})` : ''}`, { after: 'draft', to: 'conversation', itemId: item.id, how, candidates: candidates.map((candidate) => candidate.id) });
    await this.present({ view: 'conversation', itemId: item.id, reason: 'user' });
  }

  // ── update hold (shared by pause mode and draft mode) ──────────────────

  /** Holds every queued update for `reason`; the first hold puts back anything mid-relay (it was cut off). */
  private holdUpdates(reason: HoldReason): void {
    const first = this.holdReasons.size === 0;
    this.holdReasons.add(reason);
    this.holdLiftedAt = null;
    if (!first || !this.pending) return;
    this.checkDelivery(this.now());
    if (!this.pending) return;
    const { item } = this.pending;
    this.pending = null;
    // Not an attempt: the hold cut it off.
    this.queue.unshift(item);
    this.trace(`${reason}.queued`, `${reason} began mid-relay: ${describeUpdate(item)} goes back to the front`, { agent: item.agent.id, itemKind: item.kind, requeued: true, depth: this.queue.length });
  }

  /**
   * Lifts `reason`'s hold. When it was the last one: the queue is ordered for playback (your move
   * and failures first, then the rest in arrival order, read-backs last), `announce` gets what is
   * waiting, and the queue plays once that announcement has been said. False while another hold remains.
   */
  private async releaseUpdates(reason: HoldReason, announce: (updates: PausedUpdate[]) => Promise<void>): Promise<boolean> {
    if (!this.holdReasons.delete(reason) || this.holdReasons.size > 0) return false;
    const rank = (item: QueuedUpdate) => (item.kind === 'readback' || item.reminder ? 2 : resumePriority(pausedUpdate(item)));
    const ordered = this.queue.map((item, index) => ({ item, index })).sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index).map(({ item }) => item);
    this.queue.splice(0, this.queue.length, ...ordered);
    const updates = this.queue.filter((item) => item.kind !== 'readback' && !item.reminder).map(pausedUpdate);
    // The queue waits for the announcement only when there is something to announce.
    this.holdLiftedAt = updates.length ? this.now() : null;
    this.drainingHeld = this.queue.length > 0;
    // The announcement says how many: no second "N updates are waiting" digest.
    this.digestGiven = true;
    await announce(updates);
    void this.pump();
    return true;
  }

  /** The read-back of the conversation the owner just opened goes out through its draft's hold (never through a pause). */
  private readbackPasses(item: QueuedUpdate | undefined): boolean {
    // Only the read-back of the conversation just opened: an earlier catch-up still in the queue waits (Codex review on #442).
    // …and only while the owner is still in that conversation (opening another one leaves it held; Codex review on #442).
    // …and only until the owner starts their reply: once they dictate, the rest of it waits too (Codex review on #442).
    const focus = this.focusStart;
    if (!item || item.kind !== 'readback' || !item.focusReadback || item.focusReadback !== this.draft.focusItemId || !focus || focus.itemId !== item.focusReadback) return false;
    // Any word from the owner since the focus began (while the item was fetched, between chunks…) means they've
    // started replying; so does a new part in the draft. Parts it was restored with don't count (Codex review on #442).
    const lastOwnerSpeech = this.now() - this.options.userActivity.quietForMs(this.now());
    if (this.options.isUserSpeaking?.() === true || lastOwnerSpeech > focus.at) return false;
    return this.draft.listening && this.draft.partCount <= focus.parts && this.holdReasons.size === 1 && this.holdReasons.has('draft');
  }

  /** Held, or the release announcement hasn't been said yet (once it starts, until it finishes; at most 8 s). */
  private updatesHeld(now: number): boolean {
    if (this.holdReasons.size > 0) return true;
    if (this.holdLiftedAt === null) return false;
    if (now - this.holdLiftedAt >= 8000) {
      this.holdLiftedAt = null;
      return false;
    }
    const started = this.options.playback.activity.lastVoiceAt > this.holdLiftedAt;
    // Not started within 2.5 s: don't keep waiting on it (the voice model queues what comes next anyway).
    return started ? this.options.playback.quietForMs(now) < 800 : now - this.holdLiftedAt < 2500;
  }

  /**
   * Draft mode's hold (live test 10/06): nothing is said while the owner composes, under every
   * delivery policy. Follows the draft's state; when it closes, "N updates came in while you were drafting".
   */
  private syncDraftHold(): void {
    // A draft only armed by a card tap (nothing said yet) doesn't hold: the owner may just be reading.
    if (this.draft.holdsUpdates) {
      if (!this.holdReasons.has('draft')) this.holdUpdates('draft');
      const waiting = this.queue.filter((item) => item.kind !== 'readback' && !item.reminder).length;
      if (waiting && !this.draftHoldTraced) {
        this.draftHoldTraced = true;
        this.trace('speech.held', `holding ${waiting} update${waiting === 1 ? '' : 's'} while the owner drafts`, { depth: waiting });
      }
      return;
    }
    if (!this.holdReasons.has('draft')) return;
    this.draftHoldTraced = false;
    void this.releaseUpdates('draft', async (updates) => {
      if (!updates.length) return;
      const count = updates.length;
      this.trace('speech.held.released', `draft closed: ${count} held update${count === 1 ? '' : 's'} go out now`, { depth: count });
      await this.append('commentary', `[Tell the user in a few words: "${count} update${count === 1 ? '' : 's'} came in while you were drafting." Then you'll go through them one at a time.]`, null);
    });
  }

  // ── pause mode host (pause-mode.ts) ────────────────────────────────────

  /** What this operator lends the session's pause: the transcript, the queue, GPT-Live past the pause gate. */
  private createPauseHost(): PauseHost {
    const voiceUpdates = () => this.queue.filter((item) => item.kind !== 'readback' && !item.reminder);
    return {
      now: () => this.now(),
      alive: () => this.running,
      append: (kind, content, delegationId) => this.appendNow(kind, content, delegationId),
      trace: (kind, summary, data) => this.trace(kind, summary, data),
      log: (event, data) => this.log(event, data),
      publish: (card) => this.options.desk?.publishPause?.(card),
      desk: this.options.desk,
      waiting: () => voiceUpdates().length,
      hasFreshSpeech: () => this.hasFreshUserSpeech(),
      peekFreshSpeech: () =>
        [...this.replaySpeech, ...this.transcript.filter((line) => line.speaker === 'user').map((line) => line.text.slice(line.consumed).trim())].filter(Boolean).join(' '),
      takeFreshSpeech: () => this.takeFreshUserSpeech(),
      sealTranscript: () => {
        const last = this.transcript.at(-1);
        if (last && !last.final) this.publishCaption(last, true);
      },
      forgetPausedSpeech: () => {
        this.replaySpeech.length = 0;
        for (let i = this.transcript.length - 1; i >= 0; i -= 1) if (this.transcript[i].paused) this.transcript.splice(i, 1);
      },
      userQuietMs: () => (this.options.isUserSpeaking?.() === true ? 0 : this.options.userActivity.quietForMs(this.now())),
      transcriptQuietMs: () => {
        const last = [...this.transcript].reverse().find((line) => line.speaker === 'user');
        return last ? this.now() - last.updatedAt : Number.POSITIVE_INFINITY;
      },
      holdUpdates: () => this.holdUpdates('pause'),
      releaseUpdates: (announce) => this.releaseUpdates('pause', announce),
      resumeDraft: () => this.draft.resumeAfterPause(),
    };
  }

  /** A desk item as draft mode sees it (who it belongs to, its place, whether an agent works there). */
  /** A desk change on a conversation that isn't open on screen, wasn't just discussed, and isn't named in the speech. */
  private anchorlessChange(action: OperatorAction, speech: string, handles: Map<string, string>): boolean {
    if (action.type !== 'desk' || !changesSomething(action)) return false;
    // No item named: "it" is the thread on screen or just discussed; with neither, nothing anchors it.
    if (!action.item) return !this.focusedItemId() && !this.lastItemId;
    const id = handles.get(action.item) ?? action.item;
    if (id === this.focusedItemId() || id === this.lastItemId) return false;
    const item = this.deskItems().find((candidate) => candidate.id === id);
    if (!item) return false;
    const said = contentWords(speech);
    const known = contentWords([item.place ?? '', item.summary?.about ?? '', item.agentName].join(' '));
    return !said.some((word) => known.some((name) => sameStem(word, name)));
  }

  /** The List on screen, for the draft's quick pick (it yields to List commands and breaks ties with it). */
  private pickScreen(): PickScreen | null {
    const list = this.options.screen?.listPage?.() ?? null;
    if (!list) return null;
    return {
      rows: list.rows.filter((row) => row.kind === 'item').map((row) => row.id),
      spaceId: list.place?.page === 'project' ? (list.place.id ?? null) : null,
      names: [...list.tabs.map((tab) => tab.name), ...(list.views ?? []).map((view) => view.name), ...list.projects.map((project) => project.name), ...(list.agents ?? []).map((agent) => agent.name)],
    };
  }

  private draftItemRef(itemId: string | undefined): DraftItemRef | null {
    const item = itemId ? this.deskItems().find((candidate) => candidate.id === itemId) : undefined;
    return item ? this.draftRefOf(item) : null;
  }

  private draftRefOf(item: DeskItemSummary): DraftItemRef {
    const agent = this.isAgentItem(item);
    return { id: item.id, agentId: agent?.id ?? item.agentId, agentName: agent?.name ?? item.agentName, place: item.place, threadId: item.threadId, isAgent: !!agent, about: item.summary?.about ?? null, projectId: item.facts?.projectId ?? null };
  }

  /** A new task for an agent, in a thread when given (already resolved). */
  private async startTask(agent: AgentDescriptor, message: string, delegationId: string | null, thread?: ThreadInfo, options: { brief?: boolean } = {}): Promise<void> {
    // GPT-Live sometimes delegates one long request twice, a few seconds apart.
    const recent = this.tasks.find(
      (candidate) =>
        candidate.agent.id === agent.id &&
        candidate.thread?.id === thread?.id &&
        candidate.status === 'running' &&
        this.now() - candidate.createdAt < 30_000 &&
        similarity(candidate.request, message) >= 0.6,
    );
    if (recent) {
      this.log('dedupe', { taskId: recent.id, agent: agent.id, message });
      return;
    }
    this.taskSeq += 1;
    const task: OperatorTask = {
      id: `t${this.taskSeq}`,
      agent,
      request: message,
      delegationId,
      status: 'running',
      turn: 0,
      createdAt: this.now(),
      ...(thread ? { thread } : {}),
    };
    this.tasks.push(task);
    this.send(task, message);
    this.backToBoardAfterSend('dispatch');
    void this.followConversation(agent.id, { threadId: task.thread?.id ?? null, since: task.createdAt }, 'dispatch');
    await this.confirmRoute(agent, thread, delegationId, options.brief);
  }

  /** GPT-Live said a neutral "on it"; now it confirms where the request actually went. `brief`: a draft sent with no question asked, just "Sent." */
  private async confirmRoute(agent: AgentDescriptor, thread: ThreadInfo | undefined, delegationId: string | null, brief = false): Promise<void> {
    const where = thread ? `${agent.name} in the "${thread.title}" thread` : agent.name;
    if (brief) {
      await this.append('instructions', `[Routed to ${where}. Say only "Sent."; don't repeat the request or where it went.]`, delegationId);
      return;
    }
    await this.append('instructions', `[Routed to ${where}. If you haven't said where it went, confirm in a few words ("Sent to ${agent.name}."); don't repeat the request.]`, delegationId);
  }

  // ── desk ───────────────────────────────────────────────────────────────

  private deskItems(): DeskItemSummary[] {
    return this.options.desk?.items() ?? [];
  }

  /** An item from the active list, else read from the desk (it may be snoozed, parked or done). */
  private async deskItem(id: string): Promise<DeskItemSummary | null> {
    return this.deskItems().find((item) => item.id === id) ?? (await this.bounded('desk item', this.options.desk?.item(id), this.timeouts.deskMs, null));
  }

  private itemLine(item: DeskItemSummary): string {
    return (item.ask ?? item.summary?.gist ?? item.line ?? item.facts?.lastOwnerRequest?.text ?? '').replace(/\s+/g, ' ').trim();
  }

  private isAgentItem(item: DeskItemSummary): AgentDescriptor | undefined {
    return this.options.agents.find((candidate) => candidate.id === item.agentId) ?? this.options.agents.find((candidate) => persona(candidate.id) === persona(item.agentId));
  }

  /** The active desk for the extractor: compact lines with short handles; the focused and last items always included. */
  private describeDesk(speech = ''): ExtractorDesk | undefined {
    const desk = this.options.desk;
    if (!desk) return undefined;
    // Jobs and workers report to a conversation, not the owner: listed only when the owner names one, so an
    // unanchored "mark it done" can't land on a job (voice regression sweep, 10/17).
    const items = desk.items().filter((item) => !reportsUp(item) || namesItem(speech, item));
    const listed = items.slice(0, DESK_LISTING_CAP);
    const focusId = this.focusedItemId();
    // The conversation on screen or just discussed is listed whatever its kind (a job open on screen is "it").
    for (const id of [focusId, this.lastItemId]) {
      const extra = id ? desk.items().find((item) => item.id === id) : undefined;
      if (extra && !listed.includes(extra)) listed.push(extra);
    }
    this.deskHandles = new Map(listed.map((item, index) => [`i${index + 1}`, item.id]));
    const handleOf = (id: string | null) => (id ? [...this.deskHandles].find(([, itemId]) => itemId === id)?.[0] : undefined);
    const focused = handleOf(focusId);
    const lastDiscussed = handleOf(this.lastItemId);
    const projects = this.projectNames();
    // A search just read out: its hits by handle (h1…), done and archived ones included.
    const searchHits = this.lastSearch && this.now() - this.lastSearch.at < SEARCH_PICK_MS ? this.lastSearch.hits : [];
    for (const hit of searchHits) this.deskHandles.set(hit.handle, hit.itemId);
    return {
      items: listed.map((item, index) => {
        // A Loom question / approval waiting on the owner: every question (or the decisions), so speech can answer it.
        const pending = pendingOf(item);
        return {
          handle: `i${index + 1}`,
          agentName: item.agentName,
          // A desk-only rename (a source that keeps no title) is the name the owner calls it now (Codex review on #717).
          place: item.facts?.name || item.place,
          ...(item.summary?.about ? { about: item.summary.about } : {}),
          step: stepLabel(item),
          line: this.itemLine(item).slice(0, 80),
          // Only Discord threads: a Loom thread is reached through its desk item, never as an agent's thread.
          threadId: item.threadId && /^\d+$/.test(item.threadId) ? item.threadId : null,
          ...(item.facts?.projectId && projects.get(item.facts.projectId) ? { space: projects.get(item.facts.projectId)! } : {}),
          ...(item.facts?.role === 'default' ? { lead: true } : {}),
          ...(item.facts?.pinned ? { pinned: true } : {}),
          ...(item.facts?.running ? { running: true } : {}),
          ...(item.options?.length ? { options: item.options.slice(0, 6) } : {}),
          ...(pending?.kind === 'question' && pending.dismissible && pending.requestId ? { dismissible: true } : {}),
          ...(pending?.kind === 'question'
            ? {
                questions: pending.questions.map((question, qi) => ({
                  handle: `q${qi + 1}`,
                  header: question.header,
                  question: question.question.slice(0, 200),
                  options: question.options.map((option) => option.label).slice(0, 8),
                  multiSelect: question.multiSelect,
                })),
              }
            : {}),
          ...(pending?.kind === 'approval'
            ? { approval: { detail: (pending.approval?.detail || pending.question).slice(0, 200), options: (pending.approval?.options ?? []).map(({ decision, label }) => ({ decision, label })) } }
            : {}),
        };
      }),
      ...(focused ? { focused } : {}),
      ...(lastDiscussed ? { lastDiscussed } : {}),
      ...(searchHits.length ? { searchHits } : {}),
      ...(projects.size ? { projects: [...projects.values()] } : {}),
      ...(this.lastUndoable && this.now() - this.lastUndoable.at < UNDO_WINDOW_MS ? { undoable: this.lastUndoable.what } : {}),
    };
  }

  /**
   * Work addressed to a desk source that isn't an agent (the extractor said dispatch to "loom"): it goes to
   * that source's item being discussed, or the only open one; with several, ask which. Never the chief of staff.
   * Returns false when no desk source by that id exists.
   */
  private async routeToSource(sourceId: string, message: string, delegationId: string | null): Promise<boolean> {
    // "loom": every coding thread, since the router can't tell which one runs it.
    const items = this.deskItems().filter((item) => (isCodingSourceId(sourceId) ? isCodingItem(item) : persona(item.agentId) === persona(sourceId)));
    if (items.length === 0) return false;
    const focused = this.focusedItemId();
    const target = items.find((item) => item.id === focused) ?? items.find((item) => item.id === this.lastItemId) ?? (items.length === 1 ? items[0] : undefined);
    if (!target) {
      const names = items.slice(0, 4).map((item) => `"${item.place ?? this.itemLine(item)}"`).join(', ');
      await this.append('commentary', `[Which ${isCodingSourceId(sourceId) ? 'coding' : items[0].agentName} thread is that for? Ask the user: ${names}. Don't send it to an agent.]`, delegationId);
      return true;
    }
    await this.replyToItem(target, message, delegationId);
    return true;
  }

  /** The user's words for a desk item: an agent's item goes to the agent (in its thread); anything else into the item's conversation. */
  private async replyOnItem(item: DeskItemSummary, message: string, delegationId: string | null): Promise<void> {
    const agent = this.isAgentItem(item);
    if (agent) {
      this.log('desk.answer', { itemId: item.id, agent: agent.id });
      this.lastItemId = item.id;
      await this.apply({ type: 'dispatch', agentId: agent.id, message, ...(item.threadId && /^\d+$/.test(item.threadId) ? { threadId: item.threadId } : {}) }, delegationId);
      return;
    }
    await this.replyToItem(item, message, delegationId);
  }

  /** Sends the user's words into a desk item's own conversation (a Loom thread) with a desk reply command, and watches for its answer. */
  private async replyToItem(item: DeskItemSummary, text: string, delegationId: string | null, options: { brief?: boolean } = {}): Promise<DeliveryOutcome> {
    // A thread blocked on a question or an approval waits for that answer, not a new message.
    const pending = pendingOf(item);
    if (pending?.requestId && text.trim()) {
      if (pending.kind === 'question') return this.respondToItem(item, pending.questions.length === 1 ? [{ question: 'q1', answer: text.trim() }] : [], delegationId);
      if (matchDecision(pending, text)) return this.approveOnItem(item, undefined, text, delegationId);
    }
    const where = item.place ? `the ${item.agentName} thread "${item.place}"` : `that ${item.agentName} thread`;
    const sentAt = this.now();
    if (text.trim()) this.backToBoardAfterSend('desk reply');
    const result = text.trim() ? await this.bounded('desk reply', this.command('reply', item.id, { text: text.trim() }), this.timeouts.replyMs, null) : null;
    const sent = result?.status === 'applied';
    if (sent) this.noteSent(item.id, sentAt);
    this.log('desk.reply', { itemId: item.id, sent, error: result?.error });
    if (!sent) {
      await this.append('commentary', `That didn't reach ${where}${result?.error ? ` (${result.error})` : ''}. Say so; don't say it was sent.`, delegationId);
      return { ok: false, error: result?.error ?? (text.trim() ? 'the desk did not answer' : 'nothing to send') };
    }
    this.lastItemId = item.id;
    this.watch(item, sentAt, text.trim());
    const loom = item.source === 'loom' ? ': a coding thread in Loom, not an agent' : '';
    await this.append('commentary', options.brief ? `[Sent to ${where}${loom}. Its answer will come back here. Say only "Sent."]` : `[Sent to ${where}${loom}. Its answer will come back here. Confirm in a few words, naming the thread; never say it went to an agent.]`, delegationId);
    return { ok: true };
  }

  /**
   * Answers a Loom thread's pending questions by voice: spoken words matched to each question's
   * labels (free text where Loom takes it), sent as one desk `respond` once every question has an
   * answer. Answers given so far are kept while the operator asks for the rest.
   */
  private async respondToItem(item: DeskItemSummary, entries: Array<{ question: string; answer: string }>, delegationId: string | null): Promise<DeliveryOutcome> {
    const where = item.place ? `${item.agentName} (${item.place})` : item.agentName;
    const pending = pendingOf(item);
    if (!pending || pending.kind !== 'question') {
      await this.append('commentary', `[${where} isn't waiting on a question any more. Say so.]`, delegationId);
      return { ok: false, error: `${where} isn't waiting on a question any more` };
    }
    if (!pending.requestId) {
      await this.append('commentary', `[That question has to be answered in Loom itself; the desk can't send it. Say so.]`, delegationId);
      return { ok: false, error: 'that question has to be answered in Loom itself' };
    }
    this.lastItemId = item.id;
    const built = buildAnswers(pending, entries);
    const stagedKey = `${item.id}#${pending.requestId}`;
    const kept = this.partialAnswers.get(stagedKey) ?? {};
    const answers = mergeAnswers(pending, kept, built.answers);
    const rejected = built.rejected.filter((entry) => !(entry.question.id in answers));
    if (rejected.length) {
      this.partialAnswers.set(stagedKey, answers);
      const lines = rejected.map((entry) =>
        entry.candidates?.length
          ? `"${entry.said}" could be ${entry.candidates.map((label) => `"${label}"`).join(' or ')} for "${entry.question.question}"`
          : `"${entry.said}" isn't one of the options for "${entry.question.question}" (options: ${entry.question.options.map((option) => option.label).join(', ')})`,
      );
      await this.append('commentary', `[${lines.join('; ')}. Ask the user which they mean; nothing was sent yet.]`, delegationId);
      return { ok: false, error: 'the answer did not match the options' };
    }
    const missing = pending.questions.filter((question) => !(question.id in answers));
    if (missing.length) {
      this.partialAnswers.set(stagedKey, answers);
      const still = missing.map((question) => `${question.question} (options: ${question.options.map((option) => option.label).join(', ')})`).join(' Then: ');
      const got = Object.keys(answers).length ? ` Got so far: ${describeAnswers({ ...pending, questions: pending.questions.filter((question) => question.id in answers) }, answers)}.` : '';
      await this.append('commentary', `[${where} still needs an answer to: ${still}.${got} Ask the user; the answers go to Loom together once all are in.]`, delegationId);
      return { ok: false, error: 'some questions still need an answer' };
    }
    // Staged answers stay until the desk confirms delivery: a failed send keeps them for a retry.
    this.partialAnswers.set(stagedKey, answers);
    const sentAt = this.now();
    this.backToBoardAfterSend('answer');
    const result = await this.command('respond', item.id, { requestId: pending.requestId, answers });
    const what = describeAnswers(pending, answers);
    if (result?.status !== 'applied') {
      const changed = /question changed/i.test(result?.error ?? '');
      // Answers to a question that no longer exists are of no use; anything else keeps them.
      if (changed) this.partialAnswers.delete(stagedKey);
      await this.append(
        'commentary',
        changed
          ? `[The question in ${where} changed before the answer got there, so nothing was sent. Say so; the new question is on the desk.]`
          : `That answer didn't go through for ${where}${result?.error ? ` (${result.error})` : ''}. Say so; don't say it was sent. Their answers (${what}) are kept: when they answer again (even just one question), the rest go with it.`,
        delegationId,
      );
      return { ok: false, error: changed ? 'the question changed before the answer got there' : (result?.error ?? 'the desk did not answer') };
    }
    this.partialAnswers.delete(stagedKey);
    this.noteSent(item.id, sentAt);
    this.watch(item, sentAt);
    await this.append('commentary', `[Answered ${where}: ${what}. It goes on from there; its next message will come back here. Confirm in a few words.]`, delegationId);
    return { ok: true };
  }

  /** Approves or declines a Loom thread's pending approval with one of the decisions it offers. */
  private async approveOnItem(item: DeskItemSummary, wanted: DeskOpArgs['approval'], spoken: string, delegationId: string | null): Promise<DeliveryOutcome> {
    const where = item.place ? `${item.agentName} (${item.place})` : item.agentName;
    const pending = pendingOf(item);
    // A thread that asked for the go-ahead in its own words (no Loom approval prompt): the decision goes back as a reply.
    if (!pending && item.nextStep === 'your_move' && item.ask) return this.replyToItem(item, proseApproval(item.ask, wanted), delegationId);
    if (!pending || pending.kind !== 'approval' || !pending.requestId) {
      await this.append('commentary', `[${where} isn't waiting on an approval the desk can answer. Say so.]`, delegationId);
      return { ok: false, error: `${where} isn't waiting on an approval the desk can answer` };
    }
    this.lastItemId = item.id;
    const decision = matchDecision(pending, spoken, wanted);
    const offered = pending.approval?.options ?? [];
    if (!decision) {
      // Never a broader approval than asked for: a scope Loom doesn't offer here is a question for the user.
      const scope = missingScope(pending, spoken, wanted);
      const why = scope ? `The user asked to allow it ${scope === 'session' ? 'for this session' : 'permanently'}, but Loom doesn't offer that here. ` : '';
      await this.append('commentary', `[${why}Ask the user which: ${offered.map((option) => option.label).join(', ')}. Nothing was sent.]`, delegationId);
      return { ok: false, error: 'it did not match a decision the approval offers' };
    }
    const sentAt = this.now();
    this.backToBoardAfterSend('answer');
    const result = await this.command('approve', item.id, { requestId: pending.requestId, decision });
    const label = offered.find((option) => option.decision === decision)?.label ?? decision;
    if (result?.status !== 'applied') {
      await this.append('commentary', `That didn't go through for ${where}${result?.error ? ` (${result.error})` : ''}. Say so; don't say it was sent.`, delegationId);
      return { ok: false, error: result?.error ?? 'the desk did not answer' };
    }
    this.noteSent(item.id, sentAt);
    this.watch(item, sentAt);
    await this.append('commentary', `[${label}: sent to ${where}. Confirm in a few words.]`, delegationId);
    return { ok: true };
  }

  /** The desk will see the answer in this conversation; relay it when it lands. */
  private watch(item: DeskItemSummary, sentAt: number, asked?: string): void {
    this.watches.set(item.conversationKey, {
      ...(asked ? { asked } : {}),
      kind: 'reply',
      agent: { id: item.agentId, name: item.agentName, role: item.source === 'loom' ? 'Loom coding thread' : '' },
      sentAt,
      until: sentAt + REPLY_WATCH_MS,
      itemId: item.id,
      place: item.place,
    });
  }

  /** A desk command with a fresh command id (the client retries a transport failure with the same id). */
  private async command(type: DeskCommandType, itemId: string, args: Record<string, unknown> = {}): Promise<DeskCommandResult | null> {
    const desk = this.options.desk;
    if (!desk) return null;
    const result = await this.bounded(`desk ${type}`, desk.command(type, itemId, args), this.timeouts.deskMs, null);
    // Any later change ends the last one's undo (a mark that can be undone records its own again after this);
    // only what the operator sends on its own (heard, briefed) doesn't count. Codex review on #717.
    if (result?.status === 'applied' && type !== 'heard' && type !== 'briefed' && type !== 'undo') this.lastUndoable = null;
    this.log('desk.command', { type, itemId, args, status: result?.status, commandId: result?.commandId, error: result?.error });
    this.trace(type === 'heard' ? 'heard.sent' : 'desk.command', `${type} ${itemId} → ${result?.status ?? 'no answer'}${result?.error ? ` (${result.error})` : ''}`, { type, itemId, args, status: result?.status ?? null, commandId: result?.commandId ?? null, error: result?.error ?? null });
    return result;
  }

  private resolveDeskHandle(handle: string | undefined, handles: Map<string, string>): string | undefined {
    if (!handle) return undefined;
    return handles.get(handle) ?? (this.deskItems().some((item) => item.id === handle) ? handle : undefined) ?? (handle.includes(':') ? handle : undefined);
  }

  private async applyDesk(action: Extract<OperatorAction, { type: 'desk' }>, delegationId: string | null, handles: Map<string, string> = this.deskHandles, speech = ''): Promise<void> {
    if (!this.options.desk) {
      await this.append('commentary', "The desk isn't connected, so I can't do that from here. Say so.", delegationId);
      return;
    }
    // No handle: the item in the Conversation view, else the one discussed last.
    const itemId = action.item ? this.resolveDeskHandle(action.item, handles) : (this.focusedItemId() ?? this.lastItemId ?? undefined);
    this.log('desk.op', { op: action.op, handle: action.item, itemId });
    if (!itemId) {
      await this.append('commentary', "I couldn't tell which item that was. Ask the user which one.", delegationId);
      return;
    }
    const item = await this.deskItem(itemId);
    this.lastItemId = itemId;
    const label = item ? `${item.agentName}${item.place ? ` (${item.place})` : ''}: ${this.itemLine(item).slice(0, 120)}` : 'that item';
    switch (action.op) {
      case 'read': {
        // In it from now on: nothing else breaks in while the item is fetched and its read-back prepared (Codex review on #442).
        const before = this.draft.focusItemId;
        this.focusDraft(itemId);
        const detail = await this.bounded('desk item', this.options.desk.item(itemId), this.timeouts.deskMs, null);
        const archived = !detail ? this.lastSearch?.hits.find((hit) => hit.itemId === itemId && hit.archived) : undefined;
        if (!detail && archived) {
          if (before !== itemId && this.draft.focusItemId === itemId) this.draft.leaveForBoard('an archived search hit is only read');
          await this.readArchived(archived, delegationId);
          return;
        }
        if (!detail) {
          // It didn't open: a focus this read started (or moved here) goes too, or the next words would be a reply to it.
          if (before !== itemId && this.draft.focusItemId === itemId) this.draft.leaveForBoard('the item could not be opened');
          await this.append('commentary', "I couldn't open that item.", delegationId);
          return;
        }
        this.focusConversation({ itemId, ...(detail.conversationKey ? { conversationKey: detail.conversationKey } : {}) });
        const agentLast = [...detail.messages].reverse().find((message) => message.author === 'agent');
        const latest = agentLast?.text ?? '';
        const owner = [...detail.messages].reverse().find((message) => message.author === 'owner');
        const ownerLast = owner?.text ?? '';
        // Only a message the reply came after is its question (a newer follow-up may still be running).
        const spoken = await this.condense(detail.agentId, latest, owner && agentLast && owner.at <= agentLast.at ? owner.text : undefined);
        const where = detail.place ? ` (${detail.place})` : '';
        const step = detail.nextStep === 'your_move' ? ' It is waiting on the user.' : detail.nextStep === 'failed' ? ' Its last turn failed.' : detail.nextStep === 'working' ? ` ${detail.agentName} is working on it.` : '';
        this.queueReadback(
          [
            `Tell the user about this desk item from ${detail.agentName}${where}. Where it stands: ${detail.summary?.gist ?? this.itemLine(detail)}.${step}`,
            pendingOf(detail)
              ? `It is blocked on the user. Read each question with its options, in order, then stop: ${speakPending(`${detail.agentName}${where}`, pendingOf(detail)!)}`
              : detail.ask
                ? `The question for the user: ${detail.ask}${detail.options.length ? ` (options: ${detail.options.join('; ')})` : ''}.`
                : '',
            ownerLast ? `The user's own last message there (their words, not ${detail.agentName}'s): "${ownerLast.slice(0, 400)}".` : '',
            spoken ? `${detail.agentName}'s latest message: "${spoken}".` : '',
            `Only attribute that last message to ${detail.agentName}.`,
          ]
            .filter(Boolean)
            .join(' '),
          delegationId,
          { deskItemIds: [itemId], deskMark: 'heard' },
          { all: { focusReadback: itemId } },
        );
        return;
      }
      case 'open': {
        // An archived search hit has no conversation to show: it is read instead.
        const archived = this.lastSearch?.hits.find((hit) => hit.itemId === itemId && hit.archived);
        if (archived && !item) {
          await this.readArchived(archived, delegationId);
          return;
        }
        // The fetched item's key: a done or parked hit isn't in the active list present() looks in (Codex review on #750).
        const shown = await this.present({ view: 'conversation', itemId, ...(item?.conversationKey ? { conversationKey: item.conversationKey } : {}), reason: 'user' });
        if (shown) this.focusDraft(itemId);
        await this.append('commentary', shown ? `[${label} is open on the screen. Confirm in a few words.]` : "That didn't open on the screen. Say so.", delegationId);
        return;
      }
      case 'reply': {
        if (!item) {
          await this.append('commentary', "I couldn't find that item on the desk. Ask the user which one.", delegationId);
          return;
        }
        await this.replyOnItem(item, action.message ?? '', delegationId);
        return;
      }
      case 'respond':
        if (!item) {
          await this.append('commentary', "I couldn't find that item on the desk. Ask the user which one.", delegationId);
          return;
        }
        await this.respondToItem(item, action.answers ?? (action.option || action.message ? [{ question: '', answer: (action.option ?? action.message)! }] : []), delegationId);
        return;
      case 'approve':
        if (!item) {
          await this.append('commentary', "I couldn't find that item on the desk. Ask the user which one.", delegationId);
          return;
        }
        await this.approveOnItem(item, action.approval, [action.option ?? action.message ?? '', speech].filter(Boolean).join(' '), delegationId);
        return;
      case 'answer': {
        // A Loom question or approval: answered as such (labels matched, free text where Loom takes it).
        const pending = pendingOf(item);
        if (item && pending?.kind === 'question') {
          await this.respondToItem(item, [{ question: '', answer: (action.option ?? action.message ?? '').trim() }], delegationId);
          return;
        }
        if (item && pending?.kind === 'approval') {
          await this.approveOnItem(item, undefined, action.option ?? action.message ?? '', delegationId);
          return;
        }
        const options = item?.options ?? [];
        const wanted = (action.option ?? action.message ?? '').trim();
        const option = options.find((candidate) => candidate.toLowerCase() === wanted.toLowerCase()) ?? options.find((candidate) => normalizeForMatch(candidate).includes(normalizeForMatch(wanted)) && wanted.length > 2) ?? (options.length ? undefined : wanted);
        if (!option) {
          await this.append('commentary', `[That doesn't match one of the options (${options.join('; ')}). Ask the user which one.]`, delegationId);
          return;
        }
        const sentAt = this.now();
        this.backToBoardAfterSend('answer');
        const result = await this.command('answer', itemId, { option });
        if (result?.status !== 'applied') {
          await this.append('commentary', `That answer didn't go through for ${label}${result?.error ? ` (${result.error})` : ''}. Say so.`, delegationId);
          return;
        }
        if (item) this.watch(item, sentAt);
        await this.append('commentary', `[Answered "${option}" on ${label}. Confirm in a few words.]`, delegationId);
        return;
      }
      case 'snooze': {
        // No time and no trigger: until the agent posts, the same default as the desk's Snooze button.
        const args = action.until ? { until: action.until } : { trigger: action.trigger ?? 'agent_posts' };
        await this.mark('snooze', itemId, args, label, delegationId, action.until ? `Snoozed until ${action.until}` : args.trigger === 'desk' ? 'Snoozed until the user is at their desk' : 'Snoozed until the agent posts');
        return;
      }
      case 'done': {
        const args = action.stopJob === undefined ? {} : { stopJob: action.stopJob };
        const result = await this.command('done', itemId, args);
        if (result?.status === 'failed' && /stopJob is required/i.test(result.error ?? '')) {
          const job = /"([^"]+)"/.exec(result.error ?? '')?.[1] ?? 'a background job';
          this.pendingStopJob = { itemId, label: job, askedAt: this.now() };
          this.pendingFinish = null;
          await this.append('commentary', `[${job} is still running in that conversation. Ask the user: "Stop the job too?" and delegate their answer.]`, delegationId);
          return;
        }
        if (this.pendingStopJob?.itemId === itemId) this.pendingStopJob = null;
        this.noteUndoable(result, itemId, `Marked done: ${label}`, null);
        await this.reportMark(result, label, delegationId, action.stopJob === true ? 'Marked done and stopped the job' : 'Marked done');
        // Done means the owner is finished with this: put the board back up, whatever is showing (live
        // test 10/06: Sierra's scene had no conversation key, so "only if it's this item" never fired).
        if (result?.status === 'applied' || result?.status === 'accepted') this.backToBoardAfterSend('done');
        return;
      }
      case 'seen':
        await this.mark('seen', itemId, {}, label, delegationId, 'Marked seen; it stays in the rotation');
        return;
      case 'park':
        await this.mark('park', itemId, {}, label, delegationId, 'Parked');
        return;
      case 'pickup':
        await this.mark('pickup', itemId, {}, label, delegationId, 'Picked back up');
        return;
      case 'retry': {
        const sentAt = this.now();
        const result = await this.command('retry', itemId);
        if (result?.status === 'applied' && item) this.watch(item, sentAt);
        await this.reportMark(result, label, delegationId, 'Retrying it');
        return;
      }
      case 'stands':
        await this.speakStands(itemId, item, delegationId);
        return;
      case 'unseen':
        await this.mark('unseen', itemId, {}, label, delegationId, 'Marked unread');
        return;
      case 'reopen':
        // Not "back in the Inbox": a project that's away still holds it (Codex review on #717).
        await this.mark('reopen', itemId, {}, label, delegationId, 'Reopened');
        return;
      case 'pin':
      case 'unpin': {
        const pinned = action.op === 'pin';
        // Already that way: the desk applies it as a no-op, and there is nothing to put back.
        const was = item?.facts?.pinned === true;
        await this.mark('pin', itemId, { pinned }, label, delegationId, pinned ? 'Pinned' : 'Unpinned', was === pinned ? null : { type: 'pin', args: { pinned: !pinned } });
        return;
      }
      case 'stop': {
        const result = await this.command('stop', itemId);
        this.noteUndoable(result, itemId, '', null);
        if (result?.status === 'failed' && /nothing is running/i.test(result.error ?? '')) {
          await this.append('commentary', `[Nothing is running in ${label}, so there was nothing to stop. Say so in a few words.]`, delegationId);
          return;
        }
        await this.reportMark(result, label, delegationId, 'Stopped the turn that was running; the conversation stays open for the next message');
        return;
      }
      case 'rename': {
        const title = (action.message ?? '').replace(/\s+/g, ' ').trim();
        if (!title) {
          await this.append('commentary', '[Ask the user what to call it. Nothing was renamed.]', delegationId);
          return;
        }
        // What undo puts back: a coding thread's title at its source (its place, after the repo), else the desk's own
        // name for it, including none (Codex review on #717).
        const before = item?.place ?? null;
        const inverse = !item
          ? null
          : isCodingItem(item)
            ? before
              ? { type: 'rename' as const, args: { title: before.includes('·') ? before.split('·').slice(1).join('·').trim() || before : before } }
              : null
            : { type: 'rename' as const, args: { title: item.facts?.name ?? null } };
        // The same title again changes nothing: nothing to put back.
        const same = inverse && typeof inverse.args.title === 'string' && inverse.args.title === title;
        await this.mark('rename', itemId, { title }, label, delegationId, `Renamed to "${title}"`, same ? null : inverse);
        return;
      }
      case 'project': {
        const wanted = (action.option ?? '').trim();
        const out = /^(?:none|no project|out(?: of (?:its|the|a) project)?|nothing)$/i.test(wanted);
        const before = item?.facts?.projectId ?? null;
        const projects = [...this.projectNames()].map(([id, name]) => ({ id, name }));
        const matches = out ? [] : matchAllByName(projects, (project) => project.name, wanted);
        if (!out && matches.length !== 1) {
          const names = (matches.length ? matches : projects).slice(0, 4).map((project) => project.name);
          await this.append('commentary', matches.length ? `[Which project: ${names.join(' or ')}? Ask the user; nothing was moved.]` : `[There's no project called "${wanted}"${names.length ? ` (projects: ${names.join(', ')})` : ''}. Say so; voice can't create a project. Nothing was moved.]`, delegationId);
          return;
        }
        const project = out ? null : matches[0]!;
        const to = project?.id ?? null;
        // Already there: a no-op leaves nothing to put back.
        await this.mark('project', itemId, { projectId: to }, label, delegationId, project ? `Moved under ${project.name}` : 'Taken out of its project', before === to ? null : { type: 'project', args: { projectId: before } });
        return;
      }
      case 'dismiss': {
        const pending = pendingOf(item);
        if (!pending || pending.kind !== 'question' || !pending.requestId || !pending.dismissible) {
          await this.append('commentary', `[${label} ${pending?.kind === 'question' ? "has a question that can't be skipped: it needs an answer" : "isn't waiting on a question"}. Say so; nothing was sent.]`, delegationId);
          return;
        }
        // An answer of sorts: it can't be undone, and the turn it resumes is watched like any answer (Codex review on #717).
        const sentAt = this.now();
        const result = await this.command('dismiss', itemId, { requestId: pending.requestId });
        if (result?.status === 'applied' && item) {
          this.noteSent(itemId, sentAt);
          this.watch(item, sentAt);
        }
        await this.reportMark(result, label, delegationId, 'Skipped its question; it goes on from there');
        return;
      }
      case 'account':
        await this.moveAccount(itemId, item, action.option ?? '', label, delegationId, speech);
        return;
      case 'sweep': {
        if (!action.decision) {
          await this.append('commentary', '[Ask the user whether to pick it up or mark it done.]', delegationId);
          return;
        }
        await this.mark('sweep', itemId, { decision: action.decision }, label, delegationId, action.decision === 'keep' ? 'Picked up' : 'Done');
        return;
      }
    }
  }

  private async mark(type: DeskCommandType, itemId: string, args: Record<string, unknown>, label: string, delegationId: string | null, what: string, inverse?: { type: DeskCommandType; args: Record<string, unknown> } | null): Promise<void> {
    const result = await this.command(type, itemId, args);
    if (type === 'project' && result?.outcome && 'previousParentItemId' in result.outcome) {
      inverse = { type: 'project', args: { ...(inverse?.args ?? { projectId: args.projectId }), parentItemId: result.outcome.previousParentItemId } };
    }
    this.noteUndoable(result, itemId, `${what}: ${label}`, inverse ?? null);
    await this.reportMark(result, label, delegationId, what);
  }

  /** A change voice made, kept for "undo that": the desk's event (undone with cmd:undo), else its opposite. */
  private noteUndoable(result: DeskCommandResult | null, itemId: string, what: string, inverse: { type: DeskCommandType; args: Record<string, unknown> } | null): void {
    if (result?.status !== 'applied') return;
    const seq = typeof result.outcome?.seq === 'number' ? result.outcome.seq : null;
    // The opposite change first (a pin comes off), then the desk's undo of the event it recorded (a pin's
    // promotion out of Done, Snoozed or Parked goes back there): Codex review on #717.
    const steps = [...(inverse ? [inverse] : []), ...(seq !== null ? [{ type: 'undo' as const, args: { seq } }] : [])];
    // A change "undo that" can't reverse still ends the last one's turn: undo never reaches past it (Codex review on #717).
    this.lastUndoable = steps.length ? { itemId, what, steps, at: this.now() } : null;
  }

  private async reportMark(result: DeskCommandResult | null, label: string, delegationId: string | null, what: string): Promise<void> {
    if (result?.status !== 'applied' && result?.status !== 'accepted') {
      await this.append('commentary', `That didn't go through for ${label}${result?.error ? ` (${result.error})` : ''}. Say so.`, delegationId);
      return;
    }
    const writeback = result.outcome?.writeback as { outcome?: string } | undefined;
    const note = writeback?.outcome === 'failed' ? ' (done here, but Discord or Loom did not take it; the desk shows a retry)' : '';
    await this.append('commentary', `[${what}: ${label}${note}. Confirm in a few words.]`, delegationId);
  }

  /** "Undo that": the last desk change voice made, put back (the desk's undo of its event, else the opposite change). */
  private async undoLast(delegationId: string | null): Promise<void> {
    const last = this.lastUndoable;
    if (!last || this.now() - last.at >= UNDO_WINDOW_MS) {
      await this.append('commentary', "[There's nothing voice changed recently to undo. Say so in a few words.]", delegationId);
      return;
    }
    for (const [index, step] of last.steps.entries()) {
      const result = await this.command(step.type, last.itemId, step.args);
      if (result?.status !== 'applied') {
        // A partial undo is said as such: the steps before this one went through.
        if (index > 0) this.lastUndoable = { ...last, steps: last.steps.slice(index) };
        await this.append('commentary', `That couldn't be ${index > 0 ? 'fully ' : ''}undone (${result?.error ?? 'the desk did not answer'}). Say so.`, delegationId);
        return;
      }
    }
    this.lastUndoable = null;
    this.lastItemId = last.itemId;
    await this.append('commentary', `[Undone: ${last.what}. Confirm in a few words ("Undone.").]`, delegationId);
  }

  /** "Where does X stand": its card, spoken (the summary's gist, whose move it is, its open ask). */
  private async speakStands(itemId: string, item: DeskItemSummary | null, delegationId: string | null): Promise<void> {
    const card = item ?? (await this.deskItem(itemId));
    if (!card) {
      await this.append('commentary', "I couldn't find that conversation on the desk. Ask the user which one.", delegationId);
      return;
    }
    const where = card.place ? ` (${card.place})` : '';
    const step = standsStep(card);
    const parts = [
      `Where ${card.agentName}${where} stands: ${card.summary?.gist ?? this.itemLine(card)}.`,
      card.summary?.milestone ? `Milestone: ${card.summary.milestone}.` : '',
      step,
      standsAsk(card),
    ].filter(Boolean);
    this.lastItemId = itemId;
    await this.append('commentary', `[${parts.join(' ')} Tell the user in two or three sentences, from this only.]`, delegationId);
  }

  /** "Move this to the acme account": a Loom thread to the named account, at its next safe point (never a guess). */
  private async moveAccount(itemId: string, item: DeskItemSummary | null, wanted: string, label: string, delegationId: string | null, speech = ''): Promise<void> {
    const desk = this.options.desk!;
    if (!wanted.trim()) {
      await this.append('commentary', '[Ask the user which account to move it to. Nothing was moved.]', delegationId);
      return;
    }
    if (item && item.source !== 'loom' && !itemId.startsWith('loom:')) {
      await this.append('commentary', `[Only Loom threads move between accounts, and ${label} isn't one. Say so.]`, delegationId);
      return;
    }
    const capacity = desk.capacity ? await this.bounded('desk capacity', desk.capacity(), this.timeouts.deskMs, null) : null;
    if (!capacity || !desk.moveAccount) {
      await this.append('commentary', "[The desk can't move threads between accounts right now. Say so; nothing was moved.]", delegationId);
      return;
    }
    const claude = capacity.accounts.filter((account) => account.provider === 'claude');
    const byRouter = matchAllByName(claude, (account) => account.name, wanted.replace(/\b(?:account|my|claude)\b/gi, ' '));
    // The router may shorten the name ("acme" for "the acme team account"): every word of one account's name, said, settles it.
    const said = ` ${normalizeForMatch(speech)} `;
    const bySpeech = byRouter.filter((account) => said.includes(` ${normalizeForMatch(account.name)} `));
    const matches = byRouter.length > 1 && bySpeech.length === 1 ? bySpeech : byRouter;
    if (matches.length !== 1) {
      const names = (matches.length ? matches : capacity.accounts.filter((account) => account.provider === 'claude')).slice(0, 4).map((account) => account.name);
      await this.append('commentary', `[${matches.length ? 'Which account' : `No account matches "${wanted}"`}: ${names.join(', ')}? Ask the user; nothing was moved.]`, delegationId);
      return;
    }
    const account = matches[0]!;
    const result = await this.bounded('desk move', desk.moveAccount(itemId, account.id, `voice-${randomUUID()}`), this.timeouts.deskMs, null);
    this.trace('desk.move', `move ${itemId} → ${account.name}: ${result?.ok ? 'accepted' : (result?.error ?? 'no answer')}`, { itemId, account: account.id, ok: result?.ok ?? null });
    if (!result) {
      // Loom may still take it: a silence isn't a failure (Codex review on #717).
      this.lastUndoable = null;
      await this.append('commentary', `[The desk didn't answer in time about moving ${label} to ${account.name}; it may still go through. Say exactly that; don't say it failed.]`, delegationId);
      return;
    }
    if (!result.ok) {
      await this.append('commentary', `That move didn't go through for ${label} (${result.error}). Say so.`, delegationId);
      return;
    }
    this.lastItemId = itemId;
    this.lastUndoable = null;
    await this.append('commentary', `[${label} moves to ${account.name} at its next safe point. Confirm in a few words.]`, delegationId);
  }

  /** "Find the thread about X": the desk's search, the top three read out; "the second one" right after picks from them. */
  private async searchDesk(query: string, delegationId: string | null): Promise<void> {
    const desk = this.options.desk;
    // A new search replaces the last one's hits, even when it fails (Codex review on #717).
    this.lastSearch = null;
    const hits = desk?.search ? await this.bounded('desk search', desk.search(query, 5), this.timeouts.deskMs, null) : null;
    if (!hits) {
      await this.append('commentary', "[The desk's search didn't answer. Say so.]", delegationId);
      return;
    }
    const top = hits.slice(0, 3).map((hit, index): SearchHitRef => ({
      handle: `h${index + 1}`,
      itemId: hit.itemId,
      title: (hit.row?.facts?.name || hit.row?.place || hit.row?.summary?.about || 'untitled').replace(/\s+/g, ' ').trim(),
      agentName: hit.row?.agentName ?? '',
      archived: hit.row?.archived === true,
      done: hit.row?.disposition === 'done',
      snippet: (hit.matches?.[0]?.snippet ?? hit.row?.summary?.gist ?? '').replace(/[\u0002\u0003]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160),
    }));
    this.trace('search', `voice search “${clipLine(query, 60)}”: ${hits.length} hit(s)`, { query, hits: top.map((hit) => hit.itemId) });
    this.log('desk.search', { query, hits: top.map((hit) => hit.itemId) });
    if (!top.length) {
      this.lastSearch = null;
      await this.append('commentary', `[Nothing on the desk matches "${query}". Say so in a few words.]`, delegationId);
      return;
    }
    this.lastSearch = { at: this.now(), hits: top };
    const lines = top.map((hit, index) => `${index + 1}. ${hit.title}${hit.agentName ? ` (${hit.agentName})` : ''}${hit.archived ? ', archived' : hit.done ? ', done' : ''}${hit.snippet ? `: "${hit.snippet}"` : ''}`);
    await this.append('commentary', `[Search for "${query}" found ${hits.length >= 5 ? 'several' : hits.length} conversation${hits.length === 1 ? '' : 's'}. Read the titles in order, numbered, one short line each, then ask which to open: ${lines.join(' ')}]`, delegationId);
  }

  /** An archived search hit: no desk item any more, so its last messages come from search's transcript (Codex review on #717). */
  private async readArchived(hit: SearchHitRef, delegationId: string | null): Promise<void> {
    const desk = this.options.desk;
    const messages = desk?.transcript ? await this.bounded('desk transcript', desk.transcript(hit.itemId, 6), this.timeouts.deskMs, null) : null;
    const last = [...(messages ?? [])].reverse().find((message) => message.author === 'agent');
    if (!last) {
      await this.append('commentary', `[${hit.title} is archived, and its messages couldn't be read. Say so.]`, delegationId);
      return;
    }
    const spoken = await this.condense(hit.agentName || 'agent', last.text);
    await this.append('commentary', `[${hit.title} is archived (it can only be read, not reopened). ${hit.agentName || 'Its'} last message there: "${spoken}" Tell the user in two or three sentences.]`, delegationId);
  }

  /** "What's broken?": the System page's line, then the critical and open incidents by name. */
  private async speakSystem(delegationId: string | null): Promise<void> {
    const desk = this.options.desk;
    const brief = desk?.system ? await this.bounded('desk system', desk.system(), this.timeouts.deskMs, null) : null;
    if (!brief) {
      await this.append('commentary', "[The System page isn't available from the desk right now. Say so.]", delegationId);
      return;
    }
    await this.append('commentary', `[${systemSummary(brief)} Say this in one to three sentences; name the critical ones first.]`, delegationId);
  }

  /** "How's capacity": one or two sentences: the tightest account, the week left, a disk warning. */
  private async speakCapacity(delegationId: string | null): Promise<void> {
    const desk = this.options.desk;
    const capacity = desk?.capacity ? await this.bounded('desk capacity', desk.capacity(), this.timeouts.deskMs, null) : null;
    if (!capacity) {
      await this.append('commentary', "[Capacity isn't available from the desk right now. Say so.]", delegationId);
      return;
    }
    await this.append('commentary', `[${capacitySummary(capacity, this.now())} Say this in one or two sentences.]`, delegationId);
  }

  /** A project by name: snooze, park, wake, or finish (finish asks first: it marks the project's threads done). */
  private async projectLifecycle(action: Extract<OperatorAction, { type: 'project' }>, delegationId: string | null): Promise<void> {
    const desk = this.options.desk;
    if (!desk?.projectAction) {
      await this.append('commentary', "[The desk can't change projects from here. Say so.]", delegationId);
      return;
    }
    const projects = [...this.projectNames()].map(([id, name]) => ({ id, name }));
    const byId = projects.find((project) => project.id === action.project);
    const matches = byId ? [byId] : matchAllByName(projects, (project) => project.name, action.project);
    if (matches.length !== 1) {
      const names = (matches.length ? matches : projects).slice(0, 4).map((project) => project.name);
      await this.append('commentary', matches.length ? `[Which project: ${names.join(' or ')}? Ask the user; nothing changed.]` : `[There's no open project called "${action.project}"${names.length ? ` (projects: ${names.join(', ')})` : ''}. Say so; nothing changed.]`, delegationId);
      return;
    }
    const project = matches[0]!;
    if (action.op === 'finish' && !action.confirmed) {
      // Finish marks every open member done, snoozed and parked ones too, not just the Inbox's (Codex review on #717).
      const members = desk.projectMembers ? await this.bounded('desk project members', desk.projectMembers(project.id), this.timeouts.deskMs, null) : null;
      // A thread mid-turn stays open: the desk's Finish skips it (Codex review on #717).
      const running = members?.filter((member) => member.nextStep === 'working').length ?? 0;
      const open = members ? members.length - running : null;
      const what = (open === null ? 'all its open threads' : open === 1 ? 'its one open thread' : `its ${open} open threads`) + (running ? ` (${running === 1 ? 'one' : running} still running ${running === 1 ? 'stays' : 'stay'} open)` : '');
      this.pendingFinish = { projectId: project.id, name: project.name, askedAt: this.now() };
      this.pendingStopJob = null; // the latest question is the one a yes answers
      await this.append('commentary', `[Nothing changed yet. Ask the user: "Finish ${project.name}? That marks ${what} done, snoozed and parked ones too." Then delegate their answer.]`, delegationId);
      return;
    }
    this.pendingFinish = null;
    const body: DeskProjectAction = action.op === 'snooze' ? (action.until ? { action: 'snooze', until: action.until } : { action: 'snooze', trigger: action.trigger ?? 'agent_posts' }) : { action: action.op };
    // A Finish marks every member done before the desk answers: give it time, and never call a silence a failure.
    const result = await this.bounded('desk project', desk.projectAction(project.id, body), 65_000, null);
    if (!result) {
      this.lastUndoable = null;
      await this.append('commentary', `[The desk didn't answer in time about the ${project.name} project; it may still have gone through. Say exactly that, and that the project page will show it. Don't say it failed.]`, delegationId);
      return;
    }
    if (result?.ok) this.lastUndoable = null; // a project change isn't one "undo that" reverses
    this.trace('desk.project', `${action.op} project ${project.name}: ${result?.ok ? 'applied' : (result?.error ?? 'no answer')}`, { projectId: project.id, action: body, ok: result?.ok ?? null });
    if (!result.ok) {
      await this.append('commentary', `That didn't go through for the ${project.name} project (${result.error}). Say so.`, delegationId);
      return;
    }
    const done =
      action.op === 'finish'
        ? `Finished ${project.name}: ${result.acted ?? 0} thread${result.acted === 1 ? '' : 's'} marked done${result.stayed ? `, ${result.stayed} still running stayed open` : ''}`
        : action.op === 'wake'
          ? `${project.name} is awake: the threads it was holding are back (any snoozed, parked or done on their own stay that way)`
          : action.op === 'park'
            ? `Parked ${project.name}${result.held ? ` with its ${result.held} threads` : ''}`
            : `Snoozed ${project.name} ${action.until ? `until ${action.until}` : body.action === 'snooze' && body.trigger === 'desk' ? 'until the user is at their desk' : 'until one of its threads posts'}`;
    await this.append('commentary', `[${done}. Confirm in a few words.]`, delegationId);
  }

  /**
   * "Catch me up": the walk (docs/specs/catch-up.md "Voice"), one moment at a time from the desk's focus card, the
   * windows following. A desk without the update ledger reads the old briefing instead.
   */
  private async catchUp(delegationId: string | null): Promise<void> {
    const desk = this.options.desk;
    if (!desk) {
      await this.append('commentary', 'The desk is not connected in this session, so there is nothing to catch up on from here.', delegationId);
      return;
    }
    // A walk left for half an hour is over: what it skipped comes up again, and the new one starts from the top.
    if (this.walk && this.now() - this.walk.at >= WALK_IDLE_MS) this.walk = null;
    const walk = desk.catchupWalk ? await this.bounded('catch-up walk', desk.catchupWalk({ skipped: this.walk?.skipped ?? [] }), this.timeouts.deskMs, null) : 'off';
    if (walk === null) {
      await this.append('commentary', "I couldn't reach the desk for a catch-up. Say so.", delegationId);
      return;
    }
    if (walk !== 'off') {
      const first = !this.walk;
      this.walk = { skipped: this.walk?.skipped ?? [], heard: this.walk?.heard ?? [], focus: null, at: this.now() };
      await this.walkTo(walk, delegationId, first ? WALK_HINT : '');
      return;
    }
    await this.briefingCatchUp(desk, delegationId);
  }

  /** The walk lands on a focus card: the windows follow, and the operator reads it. No focus left ends the walk. */
  private async walkTo(walk: CatchupWalk, delegationId: string | null, lead = ''): Promise<void> {
    const state = this.walk;
    if (!state) return;
    state.focus = walk.focus;
    state.at = this.now();
    await this.followWalk(walk.focus?.line.id ?? null, state.skipped);
    if (!walk.focus) {
      this.walk = null;
      this.log('catchup.walk', { focus: null, left: walk.left });
      const rest = speakLeft(walk);
      const said = rest === "Nothing's left." ? "That's everything: you're caught up." : `That's all I'd read out. Still there: ${rest}`;
      this.queueReadback(`${lead}${said} Say it as is, then stop.`, delegationId, { walkReadback: true }, { all: { walkReadback: true } });
      return;
    }
    this.log('catchup.walk', { focus: walk.focus.line.id, space: walk.focus.spaceId, kind: walk.focus.line.kind, left: walk.left });
    this.trace('catchup.focus', `catch-up on ${walk.focus.name}: ${walk.focus.line.kind} “${walk.focus.line.title}”`, { updateId: walk.focus.line.id, spaceId: walk.focus.spaceId });
    // Heard is seen once it plays through (a brief still waiting, or a System incident, only once handled).
    const { line } = walk.focus;
    const hears = !line.waiting && walk.focus.spaceId !== 'system';
    this.queueReadback(`${lead}${speakFocus(walk.focus)} Say it as is, then stop and wait.`, delegationId, { ...(hears ? { heardUpdates: line.ids.length ? line.ids : [line.id] } : {}), ...(walk.focus.plan ? { heardPlan: { spaceId: walk.focus.spaceId, plan: structuredClone(walk.focus.plan) } } : {}) }, { all: { walkReadback: true } });
  }

  private retireWalkReadbacks(): void {
    let queued = 0;
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i]!.walkReadback) (this.queue.splice(i, 1), queued++);
    const cut = !!this.pending?.item.walkReadback;
    if (cut) this.pending = null;
    if (queued || cut) this.log('catchup.retired', { queued, pending: cut });
  }

  /** The desk windows show the walk's focus card (read-only: they follow, voice acts). Fire and forget. */
  private async followWalk(focus: number | null, skipped: number[]): Promise<void> {
    const screen = this.options.screen;
    if (!screen) return;
    try {
      if (focus !== null && screen.presentation?.()?.view !== 'active' && screen.present) await this.present({ view: 'active', reason: 'user' });
      await screen.command('list_place', { page: 'catchup', focus, skipped });
    } catch (err) {
      this.log('catchup.follow', { error: (err as Error).message });
    }
  }

  /** A word in the walk: act on the focus card, then the next one (or the map, or the end). */
  private async catchupStep(op: CatchupOp, delegationId: string | null): Promise<void> {
    const desk = this.options.desk;
    const state = this.walk;
    if (!desk || !state) {
      if (op.op !== 'stop') await this.catchUp(delegationId);
      return;
    }
    state.at = this.now();
    const focus = state.focus;
    const say = (text: string) => this.append('commentary', text, delegationId);
    let slow = '';
    const next = async (ask: { space?: string | null } = {}, said = '') => {
      const lead = `${slow}${said}`;
      const walk = await this.bounded('catch-up walk', desk.catchupWalk?.({ skipped: state.skipped, space: ask.space ?? null }), this.timeouts.deskMs, null);
      if (!walk || walk === 'off') return say("I couldn't reach the desk for the next one. Say so.");
      await this.walkTo(walk, delegationId, lead);
    };
    const pass = (line: CatchupWalkFocus['line']) => {
      for (const id of line.ids.length ? line.ids : [line.id]) if (!state.skipped.includes(id)) state.skipped.push(id);
    };
    const seen = async (line: CatchupWalkFocus['line'], via: 'heard' | 'read', outcome: string | null = null) => {
      const ids = line.ids.length ? line.ids : [line.id];
      // Wait out the client's own 20 s; a silence may still have gone through, so it moves on and says so.
      const done = await this.bounded('updates seen', desk.updatesSeen?.(ids, via, outcome), 25_000, null);
      this.log('catchup.seen', { ids, via, outcome, ok: done?.ok ?? null, error: done && !done.ok ? done.error : null });
      if (done?.ok) return true;
      if (!done || /timeout|timed out|aborted/i.test(done.error)) {
        slow = 'The desk was slow to record that one, so it may come up again. ';
        return true;
      }
      // The error stays in the log: in voice it's jargon the owner can't act on.
      await say(`[Marking that one ${via} didn't go through, so it stays in focus. Say so.]`);
      return false;
    };
    const which = (choices: string[]) => say(`[More than one project fits: ${choices.join(', ')}. Ask which one.]`);
    this.log('catchup.op', { ...op, focus: focus?.line.id ?? null });
    // The owner moved the walk on: what it was reading (cut off, or still to come) is retired, never retried or marked heard.
    if (op.op !== 'left') this.retireWalkReadbacks();
    switch (op.op) {
      case 'stop': {
        this.walk = null;
        await this.followWalk(null, state.skipped);
        return say('[The catch-up stops here. Say so in a few words.]');
      }
      case 'left': {
        const walk = await this.bounded('catch-up walk', desk.catchupWalk?.({ skipped: state.skipped, focus: focus?.line.id ?? null }), this.timeouts.deskMs, null);
        if (!walk || walk === 'off') return say("I couldn't reach the desk. Say so.");
        this.queueReadback(`What's left: ${speakLeft(walk)} Say it as is, then stop and wait.`, delegationId, {}, { all: { walkReadback: true } });
        return;
      }
      case 'goto': {
        const walk = await this.bounded('catch-up walk', desk.catchupWalk?.({ skipped: state.skipped }), this.timeouts.deskMs, null);
        const named = walk && walk !== 'off' ? spaceNamed(walk, op.space) : null;
        if (named && 'choices' in named) return which(named.choices);
        if (!named) return say(`[Nothing left to catch up on in “${op.space}”. Say so and ask where to go.]`);
        return next({ space: named.spaceId });
      }
      case 'accept':
      case 'defer': {
        let spaceId = focus?.spaceId ?? null;
        if (op.op === 'accept' && op.space) {
          const walk = await this.bounded('catch-up walk', desk.catchupWalk?.({ skipped: state.skipped }), this.timeouts.deskMs, null);
          const named = walk && walk !== 'off' ? spaceNamed(walk, op.space) : null;
          if (named && 'choices' in named) return which(named.choices);
          spaceId = named?.spaceId ?? null;
          if (!spaceId) return say(`[There's no “${op.space}” with anything to accept. Say so.]`);
        }
        if (!spaceId || !desk.chapterAct) return say('[There is nothing in focus to act on. Say so.]');
        if (spaceId === 'system') return say(SYSTEM_ONLY);
        // An Accept answers its briefs one by one: wait out the client's own minute, and never call a silence a failure.
        const heardPlan = state.heardPlan?.spaceId === spaceId ? state.heardPlan.plan : null;
        if (!heardPlan) {
          return next({ space: spaceId }, 'First, here is that chapter. Hear it before accepting or deferring it. ');
        }
        const result = await this.bounded(`chapter ${op.op}`, desk.chapterAct(spaceId, op.op, heardPlan), 65_000, null);
        // Logged before it's classified: the owner hears no error, so the log is where it's kept.
        if (result && !result.ok) this.log('catchup.chapter.failed', { spaceId, how: op.op, error: result.error });
        if (!result || (!result.ok && /timeout|timed out|aborted/i.test(result.error))) return say("[The desk didn't answer in time; it may still have gone through. Say exactly that, and that the Catch me up page will show it. Don't say it failed, and don't try again.]");
        if (!result.ok && result.changed && result.plan) {
          const before = heardPlan;
          const added = result.plan.updateIds.filter((id) => !before.updateIds.includes(id)).length;
          const removed = before.updateIds.filter((id) => !result.plan!.updateIds.includes(id)).length;
          this.queueReadback(`[The chapter changed: ${added ? `${added} new update${added === 1 ? '' : 's'}. ` : ''}${removed ? `${removed} update${removed === 1 ? '' : 's'} already handled. ` : ''}Now: ${result.plan.line} Say accept or defer again to use this plan. Nothing was submitted again. Read this as is, then wait.]`, delegationId, { heardPlan: { spaceId, plan: result.plan } }, { all: { walkReadback: true } });
          return;
        }
        if (!result.ok) return say("[That didn't go through. Say so.]");
        this.trace('catchup.chapter', `${op.op} on ${spaceId}`, { spaceId, how: op.op });
        const done = op.op === 'defer' ? 'Deferred that project until tomorrow morning.' : acceptSaid(result);
        return next({}, `${done} `);
      }
      case 'next':
      case 'skip': {
        if (!focus) return next();
        // Heard is seen; a brief still waiting stays until it's answered (it only moves aside for this session).
        // An incident is handled on the System page: hearing it only passes it, as the page's Open System does.
        const heard = (focus.line.ids.length ? focus.line.ids : [focus.line.id]).every((id) => state.heard.includes(id));
        if (op.op === 'next' && !focus.line.waiting && focus.spaceId !== 'system' && !heard && !(await seen(focus.line, 'heard'))) return;
        pass(focus.line);
        return next();
      }
      case 'pick': {
        if (!focus?.brief || !focus.line.briefId || !focus.line.itemId) return say('[There is no decision in focus to pick for. Say so.]');
        const option = optionFor(focus, op.key);
        if (!option) return say(`[${op.key ? `There is no option ${op.key}` : 'That decision has no recommendation'}. Say so and read the options again.]`);
        const result = await this.command('respond', focus.line.itemId, { requestId: `decision:${focus.line.briefId}`, answers: { decision: option.answer }, ...(focus.brief.revision !== null ? { revision: focus.brief.revision } : {}) });
        // this.command traces the error.
        if (result?.status !== 'applied') return say(`[Choosing ${option.key} didn't go through. Say so.]`);
        pass(focus.line);
        return next({}, `Went with ${option.key}, ${option.label.replace(/[.?!]+$/, '')}. `);
      }
      case 'fine':
      case 'gotit': {
        if (!focus) return next();
        if (focus.spaceId === 'system') return say(SYSTEM_ONLY);
        if (focus.line.kind === 'needs' && focus.line.waiting) return say('[That one is a decision waiting on the user: it needs an option, not a got it. Say so and read its options again.]');
        // A rule event is news: Got it, never Fine by me on the decision under it.
        if (op.op === 'fine' && focus.line.kind === 'decided' && !focus.line.rule && focus.line.decisionId && desk.decidedConfirm) {
          // Loom can take a while to confirm: wait out the client's own 20 s, and never call a silence a failure.
          const done = await this.bounded('fine by me', desk.decidedConfirm(focus.line.decisionId), 25_000, null);
          if (done && !done.ok) this.log('catchup.fine.failed', { decisionId: focus.line.decisionId, error: done.error });
          if (!done || (!done.ok && /timeout|timed out|aborted/i.test(done.error))) return say("[The desk didn't answer in time; Fine by me may still have gone through. Say exactly that, and that the Catch me up page will show it. Don't say it failed, and don't try again.]");
          if (!done.ok) return say("[Fine by me didn't go through. Say so.]");
        } else if (!(await seen(focus.line, 'read', 'got-it'))) return;
        pass(focus.line);
        return next({}, op.op === 'fine' && focus.line.kind === 'decided' && !focus.line.rule ? 'Noted. ' : '');
      }
    }
  }

  /** "Catch me up" on a desk without the update ledger: the desk briefing, Your move and Failed one at a time, then FYIs. */
  private async briefingCatchUp(desk: DeskClient, delegationId: string | null): Promise<void> {
    const briefing = await this.bounded('desk briefing', desk.briefing(), this.timeouts.deskMs, null);
    if (!briefing) {
      await this.append('commentary', "I couldn't reach the desk for a catch-up. Say so.", delegationId);
      return;
    }
    this.log('remind', { yourMove: briefing.yourMove.length, fyi: briefing.fyi.length });
    const operator = { id: 'operator', name: 'Operator', role: '' };
    const items: QueuedUpdate[] = [];
    const total = briefing.yourMove.length;
    briefing.yourMove.forEach((entry, index) => {
      const what = entry.step === 'failed' ? `${entry.agentName}'s last turn failed` : `${entry.agentName} needs the user`;
      const where = entry.place ? ` (${entry.place})` : '';
      const options = entry.options.length ? ` Options: ${entry.options.join('; ')}.` : '';
      const context = entry.context.length ? ` Context: ${entry.context.slice(0, 3).join(' ')}` : '';
      // A Loom question / approval: every question with its options, read in turn.
      const pending = entry.step === 'your_move' ? pendingOf({ nextStep: 'your_move', facts: { pending: entry.pending ?? null } }) : null;
      const text = pending
        ? `Catch-up, ${index + 1} of ${total}: ${speakPending(`${entry.agentName}${where}`, pending)}${context} Read each question with its options, then stop.`
        : `Catch-up, ${index + 1} of ${total}: ${what}${where}: ${entry.ask ?? entry.gist ?? ''}.${options}${context} Tell the user in a sentence or two${entry.step === 'failed' ? ' and offer to retry' : ''}, then stop.`;
      items.push({
        kind: 'readback',
        agent: operator,
        update: { kind: 'result', text },
        delegationId: index === 0 ? delegationId : null,
        arrivedAt: this.now(),
        attempts: 0,
        urgent: true,
        reminder: true,
        deskItemIds: [entry.id],
        deskMark: 'briefed',
        focusItemId: entry.id,
      });
    });
    for (const fyi of briefing.fyi) {
      items.push({
        kind: 'readback',
        agent: operator,
        update: { kind: 'result', text: `Also, in one sentence: ${fyi.sentence}` },
        delegationId: items.length === 0 ? delegationId : null,
        arrivedAt: this.now(),
        attempts: 0,
        urgent: true,
        reminder: true,
        deskItemIds: fyi.itemIds,
        deskMark: 'briefed',
      });
    }
    if (items.length === 0) {
      this.queueReadback(`Catch-up for the user from their desk, briefly: ${briefing.text}`, delegationId);
      return;
    }
    this.queue.unshift(...items);
    void this.pump();
    // The voice model tends to answer follow-ups from the briefing it just read; then nobody
    // knows which item "it" is, and the user's answer has nowhere to go.
    await this.append(
      'thinking',
      '[If the user asks about one of these items, or answers one, delegate it. Do not answer from the briefing: the backend opens the item and routes the answer to its agent.]',
      null,
    );
  }

  /** Speaks a long text in order, ahead of anything else waiting (briefings, desk items). */
  private queueReadback(text: string, delegationId: string | null, extra: Partial<QueuedUpdate> = {}, options: { all?: Partial<QueuedUpdate> } = {}): void {
    const chunks = chunkForReadback(text, 1600);
    const agent = { id: 'operator', name: 'Operator', role: '' };
    this.queue.unshift(
      ...chunks.map((chunk, index) => ({
        kind: 'readback' as const,
        agent,
        update: { kind: 'result' as const, text: chunk },
        delegationId: index === 0 ? delegationId : null,
        arrivedAt: this.now(),
        attempts: 0,
        urgent: true,
        reminder: true,
        ...options.all,
        // Heard only once the last piece played through.
        ...(index === chunks.length - 1 ? extra : {}),
      })),
    );
    void this.pump();
  }

  /** A desk item changed: an answer this session waits for, its own request failing, or something due. */
  private async onDeskItem(event: DeskItemEvent): Promise<void> {
    const desk = this.options.desk;
    if (!desk || !this.running) return;
    const generation = this.generation;
    const item = await this.bounded('desk item', desk.item(event.id), this.timeouts.deskMs, null);
    if (!item || !this.alive(generation)) return;
    await this.considerDeskItem(item, generation);
  }

  private async considerDeskItem(item: DeskItemDetail, generation: number): Promise<void> {
    this.expireWatches();
    const watch = this.watches.get(item.conversationKey);
    if (watch) {
      if (item.nextStep === 'working') return;
      const failed = item.nextStep === 'failed' && (item.facts?.failed?.at ?? 0) >= watch.sentAt - 2000 ? item.facts!.failed! : null;
      const answer = failed ? null : agentAnswerSince(item.messages ?? [], watch.sentAt - 2000);
      // Loom can stop on a new question without writing a message: the question is the answer.
      const asked = failed ? null : pendingOf(item);
      const askedNow = asked && asked.at >= watch.sentAt - 2000 ? asked : null;
      if (!failed && !answer && !askedNow) return;
      this.watches.delete(item.conversationKey);
      // Relayed here: the owner turn it answers is answered; the thread's later turns are not answers to it.
      this.spokenItems.add(this.spokenKey(item));
      const turn = ownerTurnOf(item, (answer?.at ?? this.now()) - 1);
      if (turn) this.answered.add(answeredKey(item, turn));
      if (failed) {
        this.queueFailure(item, watch.agent, watch.place ?? item.place);
        return;
      }
      const question = askedNow ? speakPending(item.agentName, askedNow) : '';
      const full = answer ? answer.text : question;
      const condensed = answer ? await this.condense(item.agentId, full, watch.request?.message ?? watch.asked) : question;
      const text = answer && question ? `${condensed} ${question}` : condensed;
      if (!this.alive(generation)) return;
      const update: AgentUpdate = { kind: item.nextStep === 'your_move' ? 'question' : 'result', text, ...(watch.asked ? { asked: watch.asked } : {}), ...(text !== full ? { fullText: full } : {}) };
      this.log('desk.answer.relayed', { itemId: item.id, kind: watch.kind });
      if (watch.kind === 'late' && watch.task && watch.request) {
        await this.onAgentUpdate(watch.task, watch.request, update, generation, { itemId: item.id });
        return;
      }
      this.queue.push({
        kind: 'result',
        agent: watch.agent,
        update,
        ...(item.place ? { place: item.place } : {}),
        conversationKey: item.conversationKey,
        deskItemIds: [item.id],
        delegationId: null,
        arrivedAt: this.now(),
        attempts: 0,
      });
      void this.pump();
      return;
    }
    // This session's own request: its result comes back from the backend; only a failure is news here.
    const own = this.sessionTaskFor(item.conversationKey);
    if (own) {
      const failedAt = item.facts?.failed?.at ?? 0;
      const key = `failed:${item.id}:${failedAt}`;
      if (item.nextStep === 'failed' && failedAt >= (own.lastSentAt ?? own.createdAt) - 2000 && !this.spokenItems.has(key)) {
        this.spokenItems.add(key);
        this.queueFailure(item, own.agent, own.thread?.title ?? item.place);
      }
      return;
    }
    // The owner was just talking with this agent (a request from a session that has since restarted
    // or reconnected, or a reply typed in Discord): its answer is news, so relay it like our own.
    const recent = this.recentExchangeAnswer(item);
    if (recent && isWorkItem(item) && this.openExchange()) {
      // Another exchange is open (food logging, a question just asked): the reply he's waiting for goes first.
      this.addKnock(item);
      return;
    }
    if (recent) {
      this.spokenItems.add(this.spokenKey(item));
      this.answered.add(recent.key);
      const text = withoutIds(await this.condense(item.agentId, recent.text, recent.asked));
      if (!this.alive(generation)) return;
      const agent = this.isAgentItem(item) ?? { id: item.agentId, name: item.agentName, role: '' };
      this.log('desk.answer.recent', { itemId: item.id, ownerAgoMs: recent.ownerAgoMs });
      this.queue.push({
        kind: 'result',
        agent,
        update: { kind: item.nextStep === 'your_move' ? 'question' : 'result', text, asked: recent.asked, ...(text !== recent.text ? { fullText: recent.text } : {}) },
        ...(item.place ? { place: item.place } : {}),
        conversationKey: item.conversationKey,
        deskItemIds: [item.id],
        delegationId: null,
        arrivedAt: this.now(),
        attempts: 0,
      });
      void this.pump();
      return;
    }
    if (this.shouldSpeakUnprompted(item)) this.queueDeskNotice(item);
    else if (this.shouldKnockForNeeds(item)) {
      this.spokenItems.add(this.spokenKey(item));
      this.addKnock(item);
    }
  }

  /**
   * A real needs-you item that turned up this session, in a space that isn't snoozed: worth one knock at a break.
   * Progress, ships and FYIs wait for the catch-up.
   */
  private shouldKnockForNeeds(item: DeskItemSummary): boolean {
    if (item.seen === 'seen') this.knocked.delete(item.id);
    if (this.knocked.has(item.id)) return false;
    if (item.disposition !== 'active' || item.seen === 'seen' || item.nextStep !== 'your_move' || !needsOwner(item)) return false;
    if (offBoard(item) || this.inQuietSpace(item)) return false;
    if (item.lastActivityAt < this.sessionStart) return false;
    if (this.spokenItems.has(this.spokenKey(item))) return false;
    if (this.queue.some((queued) => queued.deskItemIds?.includes(item.id))) return false;
    return !this.sessionTaskFor(item.conversationKey);
  }

  /**
   * An agent answer to the owner's own message from this voice session (typed in Discord or on the desk,
   * or sent by a brain or operator that has since gone), spoken once per owner message: later turns in
   * that thread (progress, mail-woken work) are not answers to it.
   */
  private recentExchangeAnswer(item: DeskItemDetail): { text: string; ownerAgoMs: number; asked: string; key: string } | null {
    if (item.disposition !== 'active' || item.seen === 'seen' || item.nextStep === 'working') return null;
    if (offBoard(item) || this.inQuietSpace(item)) return null;
    // Loom marks agent mail separately, so owner messages count like Discord messages.
    if (this.spokenItems.has(this.spokenKey(item))) return null;
    if (this.queue.some((queued) => queued.deskItemIds?.includes(item.id))) return null;
    const messages = item.messages ?? [];
    const owner = ownerTurnOf(item);
    if (!owner || DECISION_TURN.test(owner.text)) return null;
    // A session starts clear: what the owner wrote before they joined is not theirs to hear now.
    if (owner.at < this.sessionStart) return null;
    // Nor what they typed in a thread while voice slept: they were working there, and read the answer there.
    if (this.options.asleepAt?.(owner.at)) return null;
    const ownerAgoMs = this.now() - owner.at;
    if (this.options.recentExchangeMs !== undefined && ownerAgoMs > this.options.recentExchangeMs) return null;
    const key = answeredKey(item, owner);
    if (this.answered.has(key)) return null;
    const answer = agentAnswerSince(messages, owner.at + 1);
    return answer ? { text: answer.text, ownerAgoMs, asked: owner.text, key } : null;
  }

  /**
   * Unprompted speech for desk-discovered items, only with `deadline` in the urgent lane: what needs the owner
   * (never a job or worker) with a deadline coming up (or just passed), new to the owner, and not already spoken
   * in this session. Everything else waits for "catch me up".
   */
  private shouldSpeakUnprompted(item: DeskItemSummary): boolean {
    if (!this.urgent('deadline')) return false;
    if (item.disposition !== 'active' || item.seen === 'seen' || item.nextStep !== 'your_move' || !needsOwner(item)) return false;
    if (offBoard(item) || this.inQuietSpace(item)) return false;
    const deadline = deadlineOf(item);
    if (deadline === null) return false;
    const now = this.now();
    if (deadline - now > (this.options.deadlineWindowMs ?? 30 * 60_000) || now - deadline > 6 * 3_600_000) return false;
    if (this.spokenItems.has(this.spokenKey(item))) return false;
    if (this.queue.some((queued) => queued.deskItemIds?.includes(item.id))) return false;
    return !this.sessionTaskFor(item.conversationKey);
  }

  /** The item's space is snoozed or parked: nothing in it speaks until the space wakes. */
  private inQuietSpace(item: DeskItemSummary): boolean {
    const projectId = item.facts?.projectId;
    if (!projectId) return false;
    const away = this.options.desk?.projects?.().find((project) => project.id === projectId)?.away;
    if (!away) return false;
    return away.state === 'parked' || away.until == null || away.until > this.now();
  }

  /** The owner is talking with a personal agent (a request in flight, or one sent in the last few minutes). */
  private inPersonalFlow(): boolean {
    const personal = (agent: AgentDescriptor) => agent.id !== 'loom' && agent.id !== 'operator';
    return this.tasks.some((task) => personal(task.agent) && (task.status !== 'done' || this.now() - (task.lastSentAt ?? task.createdAt) < PERSONAL_FLOW_MS));
  }

  private urgent(kind: UrgentClass): boolean {
    return (this.options.urgentLane ?? []).includes(kind);
  }

  /** When this voice session began (the owner joined), across brains and operator restarts. */
  private get sessionStart(): number {
    return this.options.sessionStartedAt ?? this.startedAt;
  }

  private spokenKey(item: DeskItemSummary): string {
    return `${item.id}:${item.lastAgentMessageId ?? item.revision}`;
  }

  /** Something about to come due that needs the owner: a knock, never the content. */
  private queueDeskNotice(item: DeskItemSummary): void {
    this.spokenItems.add(this.spokenKey(item));
    this.log('desk.notice', { itemId: item.id, deadline: deadlineOf(item) });
    this.addKnock(item);
  }

  private knockLabel(item: DeskItemSummary): string {
    const projectId = item.facts?.projectId;
    const space = projectId ? this.options.desk?.projects?.().find((project) => project.id === projectId)?.name : null;
    if (isWorkItem(item)) return space ?? spokenThread(item.place) ?? item.agentName;
    return item.agentName;
  }

  private addKnock(item: DeskItemSummary): void {
    if (this.knocks.has(item.id)) return;
    this.knocks.set(item.id, { label: this.knockLabel(item), at: this.now() });
    this.log('knock.pending', { itemId: item.id, label: this.knocks.get(item.id)!.label });
  }

  /**
   * An exchange is open: something sent is still unanswered, an answer was just heard, a personal agent
   * (food, health, a workout) is mid-conversation, or the voice has things to say. Nothing new cuts in.
   */
  private openExchange(): boolean {
    const now = this.now();
    if (this.pending || this.queue.length > 0) return true;
    if (now - this.lastDeliveredAt < AFTER_ANSWER_MS) return true;
    if (this.inPersonalFlow()) return true;
    return this.tasks.some((task) => task.status === 'running' && now - (task.lastSentAt ?? task.createdAt) < OPEN_EXCHANGE_MS);
  }

  /** Housekeeping: at a real break, one knock for everything waiting. */
  private maybeKnock(): void {
    if (this.knocks.size === 0) return;
    const now = this.now();
    for (const [id, knock] of this.knocks) if (now - knock.at > KNOCK_EXPIRES_MS) this.knocks.delete(id);
    if (this.knocks.size === 0) return;
    if (this.updatesHeld(now) || this.openExchange() || this.userBusy(now)) return;
    if (this.options.userActivity.quietForMs(now) < KNOCK_QUIET_MS || this.options.playback.quietForMs(now) < KNOCK_QUIET_MS) return;
    const current = new Map(this.deskItems().map((item) => [item.id, item]));
    for (const id of this.knocks.keys()) {
      const item = current.get(id);
      if (!item || item.seen === 'seen' || item.status?.countsForOwner === false) this.knocks.delete(id);
    }
    if (!this.knocks.size) return;
    const text = knockText([...this.knocks.values()].map((knock) => knock.label));
    this.log('knock', { count: this.knocks.size, text });
    for (const id of this.knocks.keys()) this.knocked.add(id);
    this.knocks.clear();
    this.queue.push({ kind: 'notice', agent: { id: 'operator', name: 'Operator', role: '' }, update: { kind: 'result', text }, delegationId: null, arrivedAt: now, attempts: 0, knock: true });
    void this.pump();
  }

  private queueFailure(item: DeskItemSummary, agent: AgentDescriptor, place: string | null | undefined): void {
    const failed = item.facts?.failed;
    this.queue.push({
      kind: 'result',
      agent,
      update: { kind: 'result', text: `That didn't finish: the turn failed${failed ? ` (${failed.reason}: ${failed.message})` : ''}. Offer to retry it.` },
      ...(place ? { place } : {}),
      conversationKey: item.conversationKey,
      deskItemIds: [item.id],
      delegationId: null,
      arrivedAt: this.now(),
      attempts: 0,
      urgent: true,
      failed: true,
    });
    this.lastItemId = item.id;
    this.log('desk.failed', { itemId: item.id });
    void this.pump();
  }

  /** The conversation a task works in: its thread, or the agent's home channel. */
  private taskConversationKey(task: OperatorTask): string | null {
    if (task.thread) return threadKey(task.thread.id);
    const home = this.options.homeChannelFor?.(task.agent.id);
    return home ? `channel:${home}` : null;
  }

  /** A task this session sent into that conversation in the last six hours. */
  private sessionTaskFor(conversationKey: string): OperatorTask | undefined {
    return [...this.tasks].reverse().find((task) => this.taskConversationKey(task) === conversationKey && this.now() - (task.lastSentAt ?? task.createdAt) < 6 * 3_600_000);
  }

  private expireWatches(): void {
    for (const [key, watch] of this.watches) {
      if (this.now() > watch.until) {
        this.watches.delete(key);
        this.log('watch.expired', { conversationKey: key, kind: watch.kind, taskId: watch.task?.id });
      }
    }
  }

  /** Once spoken without interruption: tell the desk (heard, or briefed for a catch-up line). */
  private async markHeard(item: QueuedUpdate): Promise<void> {
    const desk = this.options.desk;
    if (item.heardPlan && this.walk) this.walk.heardPlan = item.heardPlan;
    if (desk && item.heardUpdates?.length) {
      const ids = item.heardUpdates;
      const write = () => this.bounded('updates seen', desk.updatesSeen?.(ids, 'heard'), this.timeouts.deskMs, null);
      // The walk that read it, taken before any write: a retry or a late answer belongs to it alone.
      const walk = this.walk;
      let done = await write();
      // A real error gets one more try; still failing, the owner hears it may come up again (a silence may have gone through).
      // Only while the walk is still on that moment: a skip, next or stop meanwhile leaves it unseen.
      const still = () => !!walk && this.walk === walk && !!walk.focus && ids.includes(walk.focus.line.id) && !ids.some((id) => walk.skipped.includes(id));
      if (done && !done.ok && !/timeout|timed out|aborted/i.test(done.error) && still()) {
        await new Promise((resolve) => setTimeout(resolve, HEARD_RETRY_MS));
        if (!still()) return;
        done = await write();
        if (done && !done.ok && !/timeout|timed out|aborted/i.test(done.error) && still()) {
          await this.append('commentary', "[Marking that one heard didn't go through, so it may come up again. Say so in a few words.]", null);
        }
      }
      this.log('catchup.seen', { ids, via: 'heard', outcome: null, ok: done?.ok ?? null, error: done && !done.ok ? done.error : null, playbackComplete: true });
      // Recorded in the walk that read it: a late answer never lands in a new walk.
      if (done?.ok && walk && this.walk === walk) for (const id of ids) if (!walk.heard.includes(id)) walk.heard.push(id);
      // Hearing removes lines from the chapter and changes its revision. Refresh only
      // that bookkeeping change: a new unheard update must still cause a conflict.
      const heard = item.heardPlan;
      if (done?.ok && heard && still() && walk?.heardPlan === heard) {
        const plan = await this.bounded('chapter plan', desk.chapterPlan?.(heard.spaceId), this.timeouts.deskMs, null);
        if (plan && still() && walk?.heardPlan === heard && plan.updateIds.every((id) => heard.plan.updateIds.includes(id))) {
          walk.heardPlan = { spaceId: heard.spaceId, plan };
        }
      }
    }
    if (!desk || (item.agent.id === 'operator' && !item.deskMark)) return;
    let ids = item.deskItemIds ?? [];
    if (ids.length === 0 && item.conversationKey) {
      const find = () => desk.items().filter((candidate) => candidate.conversationKey === item.conversationKey).sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
      const found = find() ?? ((await this.bounded('desk items', desk.refresh(), this.timeouts.deskMs, [])), find());
      if (found) ids = [found.id];
    }
    if (ids.length === 0) return;
    if (ids.length === 1 && (item.kind !== 'readback' || item.focusItemId)) this.lastItemId = ids[0];
    const type = item.deskMark ?? 'heard';
    for (const id of ids) await this.command(type, id, type === 'heard' ? { playbackComplete: true } : {});
  }

  // ── screen ─────────────────────────────────────────────────────────────

  private describeScreen(latestUserSpeech = ''): ExtractorScreen | undefined {
    const screen = this.options.screen;
    if (!screen || screen.screensConnected() === 0) return undefined;
    const describe = (scene: ScreenScene, handle?: string) => ({
      ...(handle ? { handle } : {}),
      agentName: scene.agentName,
      title: scene.title,
      summary: scene.summary,
      choices: scene.choices.map((choice) => choice.label),
    });
    const showing = screen.showing();
    this.sceneHandles.clear();
    const pointedAt = showing ? resolvePointedChoice(latestUserSpeech, showing.choices.map((choice) => choice.label)) : undefined;
    const presentation = screen.presentation?.();
    const proto = presentation?.view === 'prototype' ? presentation.prototype : null;
    const page = proto ? screen.prototypePage?.() : null;
    const available = presentation?.prototypes?.map((candidate) => candidate.title || candidate.name) ?? [];
    const list = screen.listPage?.() ?? null;
    return {
      ...(showing ? { showing: describe(showing) } : {}),
      ...(proto
        ? {
            prototype: {
              title: proto.title || proto.name,
              agentName: proto.agentName,
              drivable: proto.drivable,
              ...(page
                ? { path: page.path, pageTitle: page.title, targets: page.targets, headings: page.headings, fields: page.fields, scrollPercent: page.scroll.percent }
                : {}),
            },
          }
        : {}),
      ...(available.length ? { prototypesAvailable: available } : {}),
      ...(list
        ? {
            list: {
              showing: !presentation || presentation.view === 'active',
              place: list.place,
              agents: list.agents?.map((agent) => agent.name),
              tab: list.tab.name,
              tabs: list.tabs.map(({ name, count }) => ({ name, count })),
              ...(list.place && list.place.page !== 'inbox' && list.views?.length ? { views: list.views.map(({ name, count }) => ({ name, count })), view: list.view?.name ?? '' } : {}),
              project: list.project?.name ?? null,
              projects: list.projects.map((project) => project.name),
              rows: list.rows.slice(0, LIST_ROWS_CAP).map(({ kind, title, where }) => ({ kind, title, where })),
            },
          }
        : {}),
      staged: screen.staged().filter((scene) => scene.id !== showing?.id).slice(0, 8).map((scene, index) => {
        const handle = `S${index + 1}`;
        this.sceneHandles.set(handle, scene.id);
        return describe(scene, handle);
      }),
      ...(pointedAt ? { pointedAt } : {}),
    };
  }

  /**
   * The conversation moved to this agent: show its scene for this work if it has one. Without a
   * presentation hub, if another agent's scene is up and this one has nothing to show, go back
   * to the board instead of leaving a finished conversation on screen (the hub's Conversation
   * view already moved off it).
   */
  private async followConversation(agentId: string, about: { threadId?: string | null; since?: number }, after: 'dispatch' | 'reply'): Promise<void> {
    const screen = this.options.screen;
    // With the presentation hub, a send puts the board up for the next thing (backToBoardAfterSend) and the
    // answer brings its own screen when it lands. Re-showing this thread's older screen now undid that (10/08).
    if (screen?.present) {
      this.focusAgentId = agentId;
      this.screenPin = null;
      this.log('screen.focus.skipped', { agent: agentId, after });
      this.trace('screen.focus', `after the ${after} to ${agentId}: the board stays up; their answer brings its screen`, { agent: agentId, source: 'user', outcome: 'after-send', after });
      return;
    }
    const shown = await this.focusScreen(agentId, 'user', about);
    if (shown || !screen || screen.screensConnected() === 0 || screen.present) return;
    const showing = screen.showing();
    if (showing && showing.agentId !== agentId) {
      await screen.showDashboard();
      this.log('screen.home', { reason: 'conversation moved on', from: showing.agentId, to: agentId });
      this.trace('screen.focus', `conversation moved to ${agentId} with nothing of theirs to show: board (was ${showing.agentId}'s scene)`, { agent: agentId, outcome: 'home', from: showing.agentId });
    }
  }

  /**
   * The conversation turned to this agent: bring up its latest scene, if it has one. `about`
   * keeps the screen honest: only a scene from that conversation (thread) or one staged since
   * the work started counts. `user` focus (a request to the agent) clears a pin; `auto` focus
   * (a result or a staged scene) respects it. Only `show` is the owner's own pick.
   */
  private async focusScreen(agentId: string, source: 'show' | 'user' | 'auto' = 'auto', about?: { threadId?: string | null; since?: number }): Promise<ScreenScene | null> {
    this.focusAgentId = agentId;
    if (source !== 'auto') this.screenPin = null;
    const pin = this.screenPin;
    const focusTrace = (outcome: string, summary: string, extra: Record<string, unknown> = {}) =>
      this.trace('screen.focus', `focus ${agentId} (${source}): ${summary}`, { agent: agentId, source, outcome, about: about ?? null, ...extra });
    if (pin && pin.until > this.now() && pin.agentId !== agentId) {
      this.log('screen.pinned', { agent: agentId, pinnedTo: pin.agentId });
      focusTrace('pinned', `pinned to ${pin.agentId ?? 'what the owner picked'} for ${Math.round((pin.until - this.now()) / 1000)} s more: unchanged`, { pinnedTo: pin.agentId });
      return null;
    }
    const screen = this.options.screen;
    if (!screen || screen.screensConnected() === 0) {
      focusTrace('no-screen', 'no screen connected: unchanged');
      return null;
    }
    const relevant = (scene: ScreenScene) =>
      !about ||
      (about.threadId != null && scene.threadId === about.threadId) ||
      (about.since !== undefined && scene.updatedAt >= about.since);
    const showing = screen.showing();
    // Only an explicit "show" swaps one relevant scene of this agent for another the user is
    // already looking at; a result or a reply doesn't (the order list replacing the mockups).
    if (source !== 'show' && about && showing?.agentId === agentId && relevant(showing)) {
      focusTrace('already-showing', `already showing their relevant “${clipLine(showing.title || showing.summary, 50)}”: unchanged`, { sceneId: showing.id });
      return showing;
    }
    const latest = screen.staged(agentId).find(relevant);
    if (!latest) {
      focusTrace('no-scene', `no ${about ? 'relevant ' : ''}scene staged: unchanged${showing ? ` (still ${showing.agentId}'s “${clipLine(showing.title || showing.summary, 40)}”)` : ''}`);
      return null;
    }
    if (showing?.id === latest.id && showing.version === latest.version) {
      focusTrace('already-showing', `already showing “${clipLine(latest.title || latest.summary, 50)}”: unchanged`, { sceneId: latest.id });
      return showing;
    }
    const reason = source === 'show' ? 'user' : 'focus';
    const shown = latest.id === screen.staged(agentId)[0]?.id ? await screen.showAgent(agentId, reason) : await this.showScene(latest, reason);
    if (shown) this.log('screen.focus', { agent: agentId, sceneId: shown.id, reason, source });
    focusTrace(shown ? 'shown' : 'refused', shown ? `showed “${clipLine(latest.title || latest.summary, 50)}”` : `asked to show “${clipLine(latest.title || latest.summary, 50)}”: not shown (a manual pick, or the scene is gone)`, { sceneId: latest.id, reason });
    return shown;
  }

  /** Shows a specific scene (not just the agent's newest). */
  private async showScene(scene: ScreenScene, reason: 'focus' | 'user' = 'focus'): Promise<ScreenScene | null> {
    return (await this.options.screen?.showScene?.(scene.id, reason)) ?? null;
  }

  private async onSceneStaged(scene: ScreenScene, info: { replaced: boolean; showing: boolean }): Promise<void> {
    this.log('screen.staged', { agent: scene.agentId, sceneId: scene.id, replaced: info.replaced, showing: info.showing, urgent: scene.urgent });
    const stagedTrace = (outcome: string, summary: string) =>
      this.trace('screen.staged', `${scene.agentName} staged “${clipLine(scene.title || scene.summary, 50)}”: ${summary}`, { agent: scene.agentId, sceneId: scene.id, replaced: info.replaced, showing: info.showing, urgent: scene.urgent, focusAgent: this.focusAgentId, outcome });
    if (info.showing) {
      stagedTrace('showing', 'already on screen (refreshed in place, or the hub gave it the screen)');
      return;
    }
    // A scene answering what the owner just asked this agent replaces whatever is up, even a screen
    // they picked earlier (live test 10/06: an older Malibu screen they had asked for held the
    // screen, and Malibu's new answer never showed).
    if (scene.agentId === this.focusAgentId) {
      const asked = [...this.tasks].reverse().find((task) => persona(task.agent.id) === persona(scene.agentId));
      if (asked && scene.updatedAt >= (asked.lastSentAt ?? asked.createdAt) - 1000) {
        const shown = await this.showScene(scene, 'user');
        if (shown) {
          this.log('screen.focus', { agent: scene.agentId, sceneId: scene.id, reason: 'answer' });
          stagedTrace('answer', 'answers what the owner just asked: shown');
          return;
        }
        stagedTrace('answer-refused', 'answers what the owner just asked, but it was not shown');
      }
    }
    // An update to a scene that isn't up doesn't take the screen from this agent's scene that is.
    if (info.replaced && this.options.screen?.showing()?.agentId === scene.agentId) {
      stagedTrace('kept', "an update to a scene that isn't up: their scene on screen stays");
      return;
    }
    if (scene.agentId === this.focusAgentId) {
      // The conversation is about this agent: show it as it arrives.
      stagedTrace('focus', 'the conversation is about them: focusing');
      await this.focusScreen(scene.agentId);
      return;
    }
    if (!scene.urgent || !this.urgent('scene')) {
      stagedTrace('waits', `the conversation is about ${this.focusAgentId ?? 'nobody yet'}: it waits on its stage`);
      return; // waits on its stage until the conversation gets there
    }
    stagedTrace('notice', 'urgent, from another agent: a spoken notice is queued');
    const agent =
      this.options.agents.find((candidate) => candidate.id === scene.agentId) ??
      ({ id: scene.agentId, name: scene.agentName, role: '' } satisfies AgentDescriptor);
    this.queue.push({
      kind: 'notice',
      agent,
      update: { kind: 'result', text: `I put something on the screen: ${scene.summary}` },
      delegationId: null,
      arrivedAt: this.now(),
      attempts: 0,
    });
    void this.pump();
  }

  /** A tap on a scene: the user's answer to that agent, as if they had said it. */
  private async onScreenInput(scene: ScreenScene, type: string, data: Record<string, unknown>): Promise<void> {
    const label = type === 'choice' ? choiceLabel(scene, data) : undefined;
    const what = scene.title || scene.summary;
    const message = label
      ? `On the screen, the user picked "${label}" on "${what}".`
      : `Screen input on "${what}": ${type} ${JSON.stringify(data).slice(0, 400)}`;
    if (!this.running) return;
    this.noteActivity();
    const origin = sceneConversation(scene);
    this.log('screen.input', { agent: scene.agentId, sceneId: scene.id, type, label, origin });
    this.pinScreen(scene.agentId);
    const agent = this.options.agents.find((candidate) => candidate.id === scene.agentId) ?? this.options.agents.find((candidate) => persona(candidate.id) === persona(scene.agentId));
    // The scene's own conversation decides where the tap goes, never "the agent's latest task":
    // a tap on thread A's scene must not answer a newer task in thread B.
    const home = agent ? this.options.homeChannelFor?.(agent.id) : undefined;
    // A channel other than the agent's home is its own conversation, like a thread.
    const threadId = origin ? (origin.threadId ?? (origin.channelId && home && origin.channelId !== home ? origin.channelId : null)) : null;
    const inConversation = (candidate: OperatorTask) => origin === null || (threadId !== null ? candidate.thread?.id === threadId : !candidate.thread);
    const task = [...this.tasks].reverse().find((candidate) => persona(candidate.agent.id) === persona(scene.agentId) && inConversation(candidate));
    if (task) {
      // The tap answers whatever that task was about to ask; don't read it out afterwards.
      for (let i = this.queue.length - 1; i >= 0; i -= 1) if (this.queue[i].task === task) this.queue.splice(i, 1);
      await this.apply({ type: 'reply', taskId: task.id, message }, null);
    } else if (threadId && agent) {
      // No task there yet: start one in the scene's conversation (known from the scene; no lookup to fail).
      await this.startTask(agent, message, null, { id: threadId, title: scene.title || scene.summary || 'thread', agentId: agent.id, lastActiveAt: this.now() });
    } else {
      await this.apply({ type: 'dispatch', agentId: scene.agentId, message }, null);
    }
    await this.append(
      'commentary',
      `The user tapped ${label ? `"${label}"` : 'something'} on ${scene.agentName}'s screen, and it went to ${scene.agentName}. Acknowledge in a few words; don't repeat the details.`,
      null,
    );
  }

  /**
   * The router model on one utterance, for draft mode on the Prototype view: does it drive the page?
   * Null when the router failed or timed out (the words then stay dictation).
   */
  private async routeScreenSpeech(speech: string, delegationPrompt?: string): Promise<OperatorAction[] | null> {
    const started = this.now();
    try {
      const actions = await withTimeout(
        this.options.extractor({
          agents: this.options.agents,
          tasks: this.tasks.map(toExtractorTask),
          transcript: this.transcriptLines().slice(-14),
          latestUserSpeech: speech,
          delegationPrompt,
          threads: [],
          currentThread: this.currentThread ? this.describeThread(this.currentThread) : undefined,
          screen: this.describeScreen(speech),
          desk: this.describeDesk(speech),
          now: this.now(),
          defaultAgentId: this.options.defaultAgentId,
        }),
        this.timeouts.extractorMs,
        'router',
      );
      this.trace('routed', `draft on the prototype: model routing in ${this.now() - started} ms → ${actions.map((action) => (action.type === 'screen' ? `screen ${action.op}` : action.type)).join(', ') || 'nothing'}`, { speech: speech.slice(0, 200), actions });
      return actions;
    } catch (err) {
      this.log('extractor.error', { message: (err as Error).message, during: 'draft-prototype' });
      return null;
    }
  }

  private async applyScreen(
    op: ScreenOp,
    agentId: string | undefined,
    delegationId: string | null,
    sceneHandle?: string,
    sceneHandles: Map<string, string> = this.sceneHandles,
    page: { target?: string; text?: string } = {},
  ): Promise<void> {
    const screen = this.options.screen;
    if (!screen) {
      await this.append('commentary', 'There is no screen connected.', delegationId);
      return;
    }
    this.log('screen.op', { op, agentId, ...(page.target ? { target: page.target } : {}) });
    if (PROTOTYPE_PAGE_OPS.has(op)) {
      await this.drivePrototype(op, page, delegationId);
      return;
    }
    switch (op) {
      case 'conversation': {
        // "Back to the conversation": the Conversation view of the conversation in focus.
        const presentation = screen.presentation?.();
        const opened =
          screen.present && (presentation?.itemId || presentation?.conversationKey)
            ? await this.present({ view: 'conversation', reason: 'user', ...(presentation.itemId ? { itemId: presentation.itemId } : {}), ...(presentation.conversationKey ? { conversationKey: presentation.conversationKey } : {}) })
            : false;
        if (!opened) await this.append('commentary', 'No conversation is open to go back to. Say so briefly.', delegationId);
        return;
      }
      case 'prototype': {
        // "Show me the prototype": the conversation in focus's newest, as the owner's own pick.
        const presentation = screen.presentation?.();
        const opened = screen.present
          ? await this.present({ view: 'prototype', reason: 'user', ...(presentation?.conversationKey ? { conversationKey: presentation.conversationKey } : {}) })
          : false;
        if (!opened) await this.append('commentary', 'There is no prototype for this conversation. Say so; the agent can publish one.', delegationId);
        else this.armForOpenedScreen();
        return;
      }
      case 'show': {
        // A named scene ("put the speaker list back up") shows exactly that one.
        const named = sceneHandle ? screen.staged().find((scene) => scene.id === sceneHandles.get(sceneHandle)) : undefined;
        if (named) {
          const shown = await this.showScene(named, 'user');
          if (shown) {
            this.focusAgentId = shown.agentId;
            this.pinScreen(shown.agentId);
            return;
          }
        }
        const target = agentId ?? named?.agentId ?? this.focusAgentId;
        const agentName = this.options.agents.find((agent) => agent.id === target)?.name ?? 'that agent';
        // Otherwise only a scene from the work in progress with that agent: never an old one
        // about something else (the speaker list when the talk is about stripe mockups).
        const task = target ? [...this.tasks].reverse().find((candidate) => candidate.agent.id === target) : undefined;
        const about = task ? { threadId: task.thread?.id ?? null, since: task.createdAt } : undefined;
        const shown = target ? await this.focusScreen(target, 'show', about) : null;
        if (shown) this.pinScreen(shown.agentId);
        if (!shown) await this.append('commentary', `${agentName} has nothing on the screen ${about ? 'for this ' : ''}yet. Offer to ask ${agentName} to put it up.`, delegationId);
        return;
      }
      case 'board': {
        // "Show the board", "back": the desk's home, the List (the owner's own pick). Already on the List
        // inside a project, "go home" goes up out of it; from a conversation it comes back to the project.
        const shown = screen.presentation?.();
        const onList = shown?.view === 'active';
        // The next layout steps back through its places, but only from the List or an open thread: a scene
        // or prototype comes down to the List first.
        const inPlace = onList || (shown?.view === 'conversation' && !!shown.itemId);
        if (screen.listPage?.()?.place && inPlace) await this.driveList('list_up', undefined, delegationId);
        else if (onList && screen.listPage?.()?.project) await screen.command('list_project', { project: null });
        else if (screen.present) await this.present({ view: 'active', reason: 'user' });
        else await screen.showDashboard();
        this.pinScreen(null);
        return;
      }
      case 'list_projects':
      case 'list_agents':
      case 'list_agent':
      case 'list_capacity':
      case 'list_system':
      case 'list_tab':
      case 'list_view':
      case 'list_inbox':
      case 'open_row':
      case 'list_project':
      case 'list_up':
        await this.driveList(op, page.target, delegationId);
        return;
      case 'screen': {
        const presentation = screen.presentation?.();
        const shown = screen.present
          ? await this.present({ view: 'screen', reason: 'user', ...(presentation?.conversationKey ? { conversationKey: presentation.conversationKey } : {}) })
          : (this.focusAgentId ? await this.focusScreen(this.focusAgentId, 'show') : null) !== null;
        if (!shown) await this.append('commentary', 'Nothing is staged on the screen for this conversation. Say so.', delegationId);
        // "Open the screen" is the owner opening it: a draft for its conversation, as a tap would.
        else this.armForOpenedScreen();
        return;
      }
      default: {
        const sent = await screen.command(op === 'step_back' ? 'back' : op);
        if (!sent) await this.append('commentary', op.startsWith('scroll_') ? "What's on the screen can't be scrolled from here." : 'Nothing is on the screen to do that to.', delegationId);
      }
    }
  }

  /**
   * The List by voice: a tab, a row by number or name (a project row opens the project), a project by
   * name, or back out of a project. Every screen follows; the List comes up first if a conversation covers it.
   */
  private async driveList(op: ScreenOp, target: string | undefined, delegationId: string | null): Promise<void> {
    const screen = this.options.screen!;
    // Moving the List: a position from here on means its rows, not the last search's hits.
    this.lastSearch = null;
    const list = screen.listPage?.() ?? null;
    if (!list) {
      await this.append('commentary', "The screen hasn't reported what's on it yet. Say so briefly.", delegationId);
      return;
    }
    // A tab or project change the screen didn't confirm: the rows on hand are the old ones, so a row
    // asked for right after ("…and open the second one") is not guessed from them.
    const settled = async (moved: Promise<ListPage | null> | undefined, what: string) => {
      const page = moved ? await moved : list;
      this.listUnsettledAt = page ? null : this.now();
      if (!page) {
        this.trace('list.unsettled', `the List didn't confirm ${what} in ${LIST_SETTLE_MS} ms`, { what });
        await this.append('commentary', `The screen didn't switch to ${what}. Say so in a few words.`, delegationId);
      }
      return page !== null;
    };
    // The List is up: a draft for the conversation that was open is parked, as a tap on the board parks it.
    // Left armed, "start a new thread about …" went into that thread as a reply (live audio test 10/18).
    const parkForList = () => {
      if (this.draft.leaveForBoard('the List was asked for')) this.trace('view.decision', 'a List page was asked for while drafting: the draft is parked with its conversation', { after: 'list', to: 'active' });
    };
    const showList = async () => {
      const up = screen.presentation?.()?.view === 'active' || (screen.present ? await this.present({ view: 'active', reason: 'user' }) : false);
      // Only once the List is up: a refused switch leaves the conversation, and its draft, where they were (Codex review on #761).
      if (up) parkForList();
    };
    const openProject = async (project: { id: string; name: string }) => {
      await showList();
      await screen.command('list_project', { project: project.id });
      if (await settled(screen.waitForList?.((page) => page.project?.id === project.id, LIST_SETTLE_MS), `the ${project.name} project`)) {
        this.trace('list.project', `opened the project “${project.name}” on the List`, { projectId: project.id });
      }
    };
    const openPlace = async (page: 'inbox' | 'projects' | 'agents' | 'agent' | 'capacity' | 'system', id?: string) => {
      await showList();
      await screen.command('list_place', { page, ...(id ? { id } : {}) });
      // Capacity is the System page's Capacity tab: the desk lands on the System page.
      const lands = page === 'capacity' ? 'system' : page;
      // Capacity is one System tab: another tab already up is not it (Codex review on #747).
      await settled(screen.waitForList?.((next) => next.place?.page === lands && (!id || next.place.id === id) && (page !== 'capacity' || next.place.view === 'capacity'), LIST_SETTLE_MS), page);
    };
    switch (op) {
      case 'list_projects':
      case 'list_agents':
        await openPlace(op === 'list_projects' ? 'projects' : 'agents');
        return;
      case 'list_agent': {
        const agent = matchByName(list.agents || [], (a) => a.name, target);
        if (agent) await openPlace('agent', agent.id);
        else await this.append('commentary', `No agent page matches “${target || ''}”. Say so briefly.`, delegationId);
        return;
      }
      case 'list_inbox':
        await openPlace('inbox');
        return;
      case 'list_capacity':
        await openPlace('capacity');
        return;
      case 'list_system':
        await openPlace('system');
        return;
      case 'list_view':
      case 'list_tab': {
        // A view of the page on screen ("the Workers view" on a space) is that page's; else an Inbox tab.
        const ownViews = list.place && list.place.page !== 'inbox' ? (list.views ?? []) : [];
        const view = matchByName(ownViews, (candidate) => candidate.name, target);
        if (view && (op === 'list_view' || !matchByName(list.tabs, (candidate) => candidate.name, target))) {
          await showList();
          await screen.command('list_view', { view: view.id });
          if (await settled(screen.waitForList?.((page) => page.view?.id === view.id, LIST_SETTLE_MS), `the ${view.name} view`)) {
            this.trace('list.view', `${list.place!.name} went to its “${view.name}” view`, { view: view.id, page: list.place!.page });
          }
          return;
        }
        if (op === 'list_view' && ownViews.length) {
          await this.append('commentary', `There's no "${target ?? ''}" view here. ${list.place!.name}'s views are ${ownViews.map((candidate) => `"${candidate.name}"`).join(', ')}. Say so in one short sentence and ask which.`, delegationId);
          return;
        }
        const tab = matchByName(list.tabs, (candidate) => candidate.name, target);
        if (!tab) {
          await this.append('commentary', `There's no "${target ?? ''}" tab. The tabs are ${list.tabs.map((candidate) => `"${candidate.name}"`).join(', ')}. Say so in one short sentence and ask which.`, delegationId);
          return;
        }
        await showList();
        await screen.command('list_tab', { tab: tab.id });
        if (await settled(screen.waitForList?.((page) => page.tab.id === tab.id && (!page.place || page.place.page === 'inbox'), LIST_SETTLE_MS), `the ${tab.name} tab`)) {
          this.trace('list.tab', `the List went to the “${tab.name}” tab`, { tab: tab.id });
        }
        return;
      }
      case 'list_project': {
        const project = matchByName(list.projects, (candidate) => candidate.name, target);
        if (!project) {
          await this.append('commentary', `There's no project called "${target ?? ''}".${list.projects.length ? ` The projects are ${list.projects.slice(0, 8).map((candidate) => `"${candidate.name}"`).join(', ')}.` : ' There are no open projects.'} Say so in one short sentence.`, delegationId);
          return;
        }
        await openProject(project);
        return;
      }
      case 'list_up': {
        if (list.place) {
          const shown = screen.presentation?.();
          // A scene or prototype up: back is one crumb, to its thread when it has one, else the List itself
          // (never the place under it).
          if (shown && shown.view !== 'active' && !(shown.view === 'conversation' && shown.itemId)) {
            // One intent to the hub, not a broadcast each window answers its own way (Codex review on #679).
            if (shown.itemId) await this.present({ view: 'conversation', itemId: shown.itemId, ...(shown.conversationKey ? { conversationKey: shown.conversationKey } : {}), reason: 'user' });
            else await showList();
            return;
          }
          const wasThread = shown?.view === 'conversation';
          const parent = wasThread ? list.place.page : list.place.page === 'project' ? 'projects' : list.place.page === 'agent' ? 'agents' : 'inbox';
          const sent = await screen.command('list_back');
          // Back out of a thread to its List: its draft is parked too, once the screens took it (Codex review on #761).
          if ((await settled(screen.waitForList?.((page) => page.place?.page === parent, LIST_SETTLE_MS), parent)) && wasThread && sent) parkForList();
          return;
        }
        await showList();
        if (list.project) {
          await screen.command('list_project', { project: null });
          await settled(screen.waitForList?.((page) => page.project === null, LIST_SETTLE_MS), 'the List');
        }
        return;
      }
      default: {
        // open_row: "the third one", "the last one", or a row's own words.
        if (this.listUnsettledAt !== null && this.now() - this.listUnsettledAt < LIST_UNSETTLED_MS) {
          this.trace('list.row.skipped', `open_row "${target ?? ''}" skipped: the List change before it never confirmed`, { target });
          return;
        }
        const index = rowIndex(target, list.rows.length);
        const row = index !== null ? list.rows[index] : matchByName(list.rows, (candidate) => candidate.title, target);
        if (!row) {
          await this.append(
            'commentary',
            index === null && target && !/\d/.test(target)
              ? `Nothing on the screen matches "${target}". Say so in one short sentence and ask which one.`
              : `The List has ${list.rows.length} row${list.rows.length === 1 ? '' : 's'} on this tab. Say so in one short sentence.`,
            delegationId,
          );
          return;
        }
        if (row.kind === 'agent') {
          await openPlace('agent', row.id);
          return;
        }
        if (row.kind === 'project') {
          await openProject({ id: row.id, name: row.title });
          return;
        }
        const shown = await this.present({ view: 'conversation', itemId: row.id, reason: 'user' });
        if (shown) {
          this.lastItemId = row.id;
          this.focusDraft(row.id);
        }
        await this.append('commentary', shown ? `[${row.title} is open on the screen. Confirm in a few words.]` : "That didn't open on the screen. Say so.", delegationId);
      }
    }
  }

  /**
   * Clicks, types, jumps or goes back on the prototype on screen (its navigation bridge does it).
   * A click that found nothing comes back from the page, and the operator says what is there instead.
   */
  private async drivePrototype(op: ScreenOp, page: { target?: string; text?: string }, delegationId: string | null): Promise<void> {
    const screen = this.options.screen!;
    const presentation = screen.presentation?.();
    const proto = presentation?.view === 'prototype' ? presentation.prototype : null;
    if (!proto) {
      await this.append('commentary', 'No prototype is open on the screen. Say so in a few words; the user can ask to open it.', delegationId);
      return;
    }
    if (!proto.drivable) {
      await this.append('commentary', `"${proto.title || proto.name}" runs on a dev server, so it can only be clicked by hand on the screen. Say so briefly.`, delegationId);
      return;
    }
    const name = op === 'page_back' ? 'back' : op;
    if (name !== 'back' && !page.target) {
      await this.append('commentary', `Ask what to ${op === 'fill' ? 'type into' : op === 'go_to' ? 'go to' : 'click'}, in a few words.`, delegationId);
      return;
    }
    if (op === 'fill' && !page.text?.trim()) {
      await this.append('commentary', `Ask what to type into "${page.target}", in a few words.`, delegationId);
      return;
    }
    const args = name === 'back' ? {} : { target: page.target, ...(op === 'fill' ? { text: page.text } : {}) };
    const commandId = randomUUID();
    const result = screen.prototypeResult?.(commandId, 2500);
    const sent = await screen.command(name, args, commandId);
    if (!sent) {
      await this.append('commentary', 'The prototype is not on a screen right now. Say so briefly.', delegationId);
      return;
    }
    const outcome = await result;
    if (outcome && !outcome.ok && op === 'fill') {
      await this.append('commentary', `That didn't go in: ${outcome.detail}. Say so in one short sentence and ask what to put instead.`, delegationId);
      return;
    }
    if (outcome && !outcome.ok && op === 'page_back') {
      await this.append('commentary', `Couldn't go back: ${outcome.detail}. Say so in a few words.`, delegationId);
      return;
    }
    if (outcome && !outcome.ok) {
      const visible = screen.prototypePage?.()?.targets.filter((target) => target.inView).slice(0, 6).map((target) => `"${target.label}"`) ?? [];
      await this.append(
        'commentary',
        `Nothing on the page matched "${page.target}".${visible.length ? ` What is in view: ${visible.join(', ')}.` : ''} Say that in one short sentence and ask which they meant.`,
        delegationId,
      );
    }
    // Done (or unconfirmed): the user sees it happen on the screen, so nothing needs saying.
  }

  private pinScreen(agentId: string | null): void {
    this.screenPin = { agentId, until: this.now() + 90_000 };
  }

  private pushScreenTasks(): void {
    this.options.screen?.setTasks(
      this.tasks.slice(-12).map((task) => ({
        agentId: task.agent.id,
        agentName: task.agent.name,
        request: task.request,
        status: task.status,
        ...(task.progress ? { progress: task.progress } : {}),
        updatedAt: task.lastSentAt ?? task.createdAt,
      })),
    );
  }

  private describeThread(thread: ThreadInfo): ExtractorThread {
    const agent = this.options.agents.find((candidate) => candidate.id === thread.agentId);
    return { id: thread.id, title: thread.title, agentName: agent?.name ?? thread.agentId, lastActive: describeAge(this.now() - thread.lastActiveAt) };
  }

  private async threadList(): Promise<ThreadInfo[]> {
    if (!this.options.threads) return [];
    try {
      return await withTimeout(this.options.threads.list(), this.timeouts.threadsMs, 'thread list');
    } catch (err) {
      this.log('thread.error', { message: (err as Error).message });
      return [];
    }
  }

  /**
   * The existing thread a request names. Throws when it can't be found or opened; a lookup
   * that failed (Discord down, a timeout) is a ThreadUnavailable: worth saying again shortly.
   */
  private async resolveThread(agent: AgentDescriptor, threadId?: string): Promise<ThreadInfo | undefined> {
    if (!this.options.threads) {
      // No thread directory: a thread the desk knows is still a place to send it.
      const known = threadId ? this.deskItems().find((item) => item.threadId === threadId && persona(item.agentId) === persona(agent.id)) : undefined;
      if (!known || !threadId) return undefined;
      this.currentThread = { id: threadId, title: known.place ?? 'thread', agentId: agent.id, lastActiveAt: known.lastActivityAt };
      return this.currentThread;
    }
    let thread: ThreadInfo | undefined;
    // New threads start through the desk (startAgentThread), never here.
    if (threadId) {
      // Only Discord threads: a desk item from elsewhere (a Loom thread) is not a place an agent can work.
      if (!/^\d+$/.test(threadId)) throw new Error(`"${threadId}" is not a Discord thread`);
      let lookupError: Error | null = null;
      try {
        const listed = await withTimeout(this.options.threads.list(), this.timeouts.threadsMs, 'thread list');
        thread = listed.find((candidate) => candidate.id === threadId);
      } catch (err) {
        lookupError = err as Error;
      }
      if (!thread) {
        // A thread on the desk can be quieter than the thread list's window; it still exists.
        const entry = this.deskItems().find((item) => item.threadId === threadId && persona(item.agentId) === persona(agent.id));
        if (entry) thread = { id: threadId, title: entry.place ?? 'thread', agentId: agent.id, lastActiveAt: entry.lastActivityAt };
      }
      if (!thread && lookupError) throw new ThreadUnavailable(`the thread list didn't load: ${lookupError.message}`);
      if (!thread) throw new Error('that thread is not active');
    }
    if (thread) this.currentThread = thread;
    return thread;
  }

  private send(task: OperatorTask, message: string): void {
    // What went out can't be unsent: "undo that" after it must not reach an older change (Codex review on #717).
    this.lastUndoable = null;
    this.log('dispatch', { taskId: task.id, agent: task.agent.id, turn: task.turn, message, thread: task.thread?.title });
    // What actually went out, for the repeat guard (a send that failed before here isn't one).
    this.recentSends.push({ agentId: task.agent.id, threadId: task.thread?.id ?? null, message, at: this.now() });
    const exchanged = this.itemForTask(task);
    if (exchanged) this.inExchange.set(exchanged, this.now());
    task.lastSentAt = this.now();
    // Fixed now: a later reply moves the task on, but this result still answers this request.
    const request: RequestSnapshot = Object.freeze({
      id: `${task.id}#${task.turn}`,
      taskId: task.id,
      turn: task.turn,
      delegationId: task.delegationId,
      threadId: task.thread?.id ?? null,
      sentAt: task.lastSentAt,
      message,
    });
    const generation = this.generation;
    this.pushScreenTasks();
    this.publishStatus();
    this.options.backend.send(
      { taskId: task.id, agentId: task.agent.id, message, turn: task.turn, ...(task.thread ? { channelId: task.thread.id } : {}) },
      (update) => void this.onAgentUpdate(task, request, update, generation),
    );
  }

  private async onAgentUpdate(task: OperatorTask, sent: RequestSnapshot, update: AgentUpdate, generation: number, late?: { itemId?: string }): Promise<void> {
    // Follow-ups merged behind a busy turn: the agent answered all of them, and a late answer must too.
    const request = update.asked && update.asked !== sent.message ? Object.freeze({ ...sent, message: update.asked }) : sent;
    // Only the newest request may move the task; an earlier one's answer is relayed as that answer.
    const current = request.turn === task.turn;
    this.log('agent.update', { taskId: task.id, requestId: request.id, current, agent: task.agent.id, updateKind: update.kind, text: update.text });
    // An answer (not a progress note) makes a following "go ahead" a real reply.
    if (update.kind !== 'progress') this.lastAgentReplyAt.set(`${task.agent.id}|${task.thread?.id ?? ''}`, this.now());
    const conversationKey = request.threadId ? threadKey(request.threadId) : (this.taskConversationKey(task) ?? undefined);
    if (!this.alive(generation)) {
      // This session is over: the next one relays the answer.
      if (update.kind !== 'progress') {
        this.handOff({ kind: 'result', agent: task.agent, update, request, ...(task.thread ? { place: task.thread.title } : {}), ...(conversationKey ? { conversationKey } : {}) });
      }
      return;
    }
    if (update.kind === 'progress') {
      // Kept for status questions. Appending it, even as thinking, gets it spoken.
      if (current) task.progress = update.text;
      this.pushScreenTasks();
      return;
    }
    const stillRunning = update.text === STILL_RUNNING_TEXT;
    if (current) {
      task.lastUpdate = update.text;
      task.lastFullText = update.fullText ?? update.text;
      task.status = update.kind === 'question' ? 'waiting_user' : 'done';
    }
    this.pushScreenTasks();
    this.publishStatus();
    if (stillRunning && conversationKey) {
      // The backend stopped waiting; the agent didn't. Its answer posts later, and the desk sees it.
      this.watches.set(conversationKey, { kind: 'late', agent: task.agent, task, request, sentAt: request.sentAt, until: this.now() + LATE_ANSWER_WATCH_MS, place: task.thread?.title ?? null });
      this.log('late.watch', { taskId: task.id, requestId: request.id, conversationKey });
    }
    const queued: QueuedUpdate = {
      kind: 'result',
      agent: task.agent,
      task,
      request,
      update,
      place: task.thread?.title,
      // A late answer's delegation is long over; GPT-Live gets it as session-wide context.
      delegationId: late ? null : request.delegationId,
      arrivedAt: this.now(),
      attempts: 0,
      // "Still running" is not the answer: nothing to mark heard yet.
      ...(conversationKey && !stillRunning ? { conversationKey } : {}),
      ...(late?.itemId ? { deskItemIds: [late.itemId] } : {}),
      ...(late ? { late: true } : {}),
    };

    // Update hold (pause, draft): whatever the delivery policy, nothing is said while held; it queues.
    this.syncDraftHold();
    if (this.policy === 'immediate' && this.holdReasons.size === 0) {
      await this.release(queued, false);
    } else if (this.policy === 'model' && this.holdReasons.size === 0) {
      await this.append(
        'thinking',
        `${task.agent.name} ${update.kind === 'question' ? 'has a question for the user' : 'reported back'}: "${update.text}".${askedDirective(update, request.message)} ` +
          `Do not interrupt the current exchange. When it wraps up, tell the user, starting with "${task.agent.name} says" ` +
          `or, if you were discussing something else, "Okay, now ${task.agent.name} said".`,
        queued.delegationId,
      );
    } else {
      this.queue.push(queued);
      this.log('queue', { taskId: task.id, requestId: request.id, depth: this.queue.length });
      void this.pump();
    }
  }

  private userBusy(now: number): boolean {
    return this.options.isUserSpeaking?.() === true || this.options.userActivity.quietForMs(now) < this.floor.settleMs;
  }

  /** Floor policy: confirm the last update was heard, then release the next once nobody is talking. */
  private async pump(): Promise<void> {
    this.syncDraftHold(); // update hold: an open draft holds the queue
    this.traceQueued();
    const now = this.now();
    if (this.pending) {
      this.checkDelivery(now);
      if (this.pending) return;
    }
    if (this.queue.length === 0) {
      this.digestGiven = false;
      this.drainingHeld = false;
      return;
    }
    // Update hold (pause, draft): nothing breaks through (not deadlines, not failures), nor the release announcement,
    // except a read-back the owner asked for while only a draft holds ("what does Foxtrot have" while focused).
    if (this.updatesHeld(now) && !this.readbackPasses(this.queue[0])) return;
    if (this.queue[0].urgent) {
      // Asked for: go as soon as the user stops talking.
      if (this.options.isUserSpeaking?.() === true || this.options.userActivity.quietForMs(now) < 800) return;
    } else {
      // A delegation being routed may change what comes next (a status request, a reply), so a
      // ready update waits briefly; never for the whole router call ("Mm" held an answer 8 s).
      if (this.extracting > 0 && now - this.lastDelegationAt < EXTRACTION_HOLD_MS) return;
      if (this.userBusy(now) || this.options.playback.quietForMs(now) < this.floor.settleMs) return;
      const waiting = this.queue.filter((item) => !item.urgent);
      if (!this.digestGiven && waiting.length >= 3) {
        // Several things piled up: say what's coming before going one at a time.
        this.digestGiven = true;
        const who = waiting.map((item) => `${item.agent.name}${item.place ? ` (${item.place})` : ''}`);
        this.log('digest', { count: waiting.length });
        await this.append('commentary', `Tell the user ${waiting.length} updates are waiting, from ${who.join(', ')}, and that you'll go through them one at a time, starting now.`, null);
        return;
      }
    }
    const next = this.queue.shift();
    if (next) await this.release(next, false);
  }

  private checkDelivery(now: number): void {
    const pending = this.pending!;
    const operatorStarted = this.options.playback.activity.lastVoiceAt > pending.releasedAt;
    const operatorQuiet = this.options.playback.quietForMs(now) >= 1200;
    // Talking over the update cuts it off; replying after it finished does not.
    if (operatorStarted && this.options.playback.isSpeaking(now) && this.options.userActivity.isActive(now)) pending.overlapActivity = true;
    // Words belong to the interruption only until the owner starts a new utterance after playback:
    // speech that began 700 ms or more after the operator's last audio (Codex review, #387) is a
    // normal answer, and must not turn earlier noise into a cut-in.
    if (operatorStarted && !pending.captureClosed && !this.options.playback.isSpeaking(now)) {
      const start = this.options.userActivity.segmentStart();
      if (this.options.userActivity.isActive(now) && start !== null && start - this.options.playback.activity.lastVoiceAt >= 700) pending.captureClosed = true;
    }
    // Live test 10/06: voice activity with no words (echo, room noise) or a backchannel ("mm",
    // "yeah") counted as talking over it, and a fully spoken update was read again. A cut-in now
    // needs real words from the owner; while their transcript may still be on its way, wait.
    const words = realWords(pending.overlapWords);
    // A walk read-back is cut off by one word: the walk's commands are one word ("skip", "next"), and a skipped moment
    // is never marked heard.
    const cutWords = pending.item.walkReadback ? 1 : 2;
    // Keep waiting while the owner is still talking (a long interruption), then for the transcript.
    if (pending.overlapActivity && words < cutWords && (this.options.userActivity.isActive(now) || this.options.userActivity.quietForMs(now) < TRANSCRIPT_GRACE_MS)) return;
    if (pending.overlapActivity && words >= cutWords) pending.overlapped = true;
    const userCutIn = pending.overlapped;
    const said = pending.keywords.filter((word) => pending.spoken.includes(word)).length;
    const needed = Math.max(1, Math.min(3, Math.ceil(pending.keywords.length * 0.4)));
    // The transcript runs ahead of the audio: matching words only show it is being said. Heard
    // means the playback carrying it finished, and nobody talked over it.
    const playbackDone = operatorStarted && this.options.playback.quietForMs(now) >= PLAYBACK_DONE_MS;
    if (said >= needed && playbackDone && !userCutIn) {
      this.markDelivered('spoken');
      return;
    }
    if (operatorStarted && operatorQuiet && !userCutIn && now - pending.releasedAt > 6000) {
      // Spoke it without interruption; the paraphrase just didn't echo our wording.
      this.markDelivered('paraphrased');
      return;
    }
    const cutOff = operatorStarted && operatorQuiet && userCutIn;
    const neverSpoken = !operatorStarted && now - pending.releasedAt >= this.floor.speakTimeoutMs;
    if (!cutOff && !neverSpoken) return;
    this.pending = null;
    const { item } = pending;
    item.attempts += 1;
    if (item.attempts >= this.floor.maxAttempts) {
      this.log('delivery.dropped', { taskId: item.task?.id, agent: item.agent.id, itemKind: item.kind, attempts: item.attempts });
      this.trace('speech.dropped', `gave up on ${describeUpdate(item)} after ${item.attempts} attempts (${neverSpoken ? 'never spoken' : 'cut off'})`, { agent: item.agent.id, itemKind: item.kind, attempts: item.attempts, reason: neverSpoken ? 'never spoken' : 'cut off' });
      return;
    }
    // The owner talked over a focused read-back: they've started their reply, so the rest of it waits like
    // any other update (their words reach the draft only after a pause; Codex review on #442).
    if (cutOff && item.focusReadback) item.focusReadback = undefined;
    this.queue.unshift(item);
    this.trace('speech.requeued', `requeued ${describeUpdate(item)}: ${neverSpoken ? `never spoken within ${this.floor.speakTimeoutMs} ms` : 'the owner talked over it'} (heard ${said}/${pending.keywords.length} keywords; attempt ${item.attempts + 1} next)`, {
      agent: item.agent.id,
      itemKind: item.kind,
      reason: neverSpoken ? 'never spoken' : 'cut off',
      heard: `${said}/${pending.keywords.length}`,
      attempts: item.attempts,
    });
    this.log('delivery.retry', {
      taskId: item.task?.id,
      agent: item.agent.id,
      itemKind: item.kind,
      reason: neverSpoken ? 'never spoken' : 'cut off',
      heard: `${said}/${pending.keywords.length} keywords`,
    });
  }

  /**
   * The task whose answer the owner is responding to, when the router sent nothing: the voice model handed the
   * speech off right after that agent's result was relayed, nothing else was sent since, and it says something
   * (not "thanks"). Speech the router judged not meant for the operator stays unanswered.
   */
  private followUpTask(speech: string, actions: OperatorAction[]): OperatorTask | null {
    if (!actions.length || !actions.every((action) => action.type === 'none' && !action.reason.toLowerCase().startsWith('not for the operator'))) return null;
    const last = this.lastDelivered;
    if (!last || last.kind !== 'result' || !last.task || !this.tasks.includes(last.task) || !isAnswer(last.update.text)) return null;
    if (this.now() - this.lastDeliveredAt > FOLLOW_UP_WINDOW_MS) return null;
    // Something else went out since the answer was heard: the conversation moved on.
    if (this.tasks.some((task) => (task.lastSentAt ?? task.createdAt) > this.lastDeliveredAt)) return null;
    if (speech.split(/\s+/).filter(Boolean).length < FOLLOW_UP_MIN_WORDS) return null;
    return last.task;
  }

  /**
   * `spoken` and `paraphrased` both mean playback finished with nobody talking over it: only then
   * does the desk hear "heard" (with playbackComplete). `answered` (the user replied mid-way) does
   * not; the desk sees the owner's reply itself.
   */
  private markDelivered(how: 'spoken' | 'paraphrased' | 'answered'): void {
    const pending = this.pending!;
    this.pending = null;
    const { item } = pending;
    if (item.kind !== 'readback') {
      this.lastDelivered = item;
      this.lastDeliveredAt = this.now();
    }
    this.log('delivered', { taskId: item.task?.id, agent: item.agent.id, itemKind: item.kind, how, afterMs: this.now() - pending.releasedAt });
    this.trace('speech.delivered', `delivered ${describeUpdate(item)}: ${how}${how === 'answered' ? ' (the owner replied mid-way: not marked heard)' : ''} after ${Math.round((this.now() - pending.releasedAt) / 100) / 10} s`, { agent: item.agent.id, itemKind: item.kind, how, afterMs: this.now() - pending.releasedAt, taskId: item.task?.id ?? null });
    if (how !== 'answered') void this.markHeard(item).catch((err) => this.log('desk.error', { message: (err as Error).message }));
  }

  private async release(item: QueuedUpdate, requested: boolean): Promise<void> {
    const { task, update, agent } = item;
    // Something else is said now: a yes after it answers that, not an earlier "Finish X?".
    this.pendingFinish = null;
    this.noteActivity();
    const where = item.place ? ` in the "${item.place}" thread` : '';
    // Live test 10/06: the voice model paraphrased away which thread an update came from (Loom has many
    // parallel threads), so the user lost the context. Name it first, in a short speakable form.
    const spoken = spokenThread(item.place ?? task?.thread?.title ?? null);
    const nameIt = spoken ? ` Start by naming the thread, e.g. "In the ${spoken} thread, …", so the user knows which one this is about.` : '';
    const asked = item.kind === 'result' && !item.reminder ? askedDirective(update, item.request?.message) : '';
    // News from a conversation this session didn't start: one plain sentence, no ids or CI talk.
    const plain = !task && item.kind !== 'readback' && !item.reminder && !item.failed ? PLAIN_NEWS : '';
    let content: string;
    if (item.reminder) {
      content = update.text;
    } else if (item.kind === 'readback') {
      content = `Read this aloud exactly as written, word for word, without summarizing or adding anything${item.part ? ` (${agent.name}'s message, ${item.part})` : ''}: ${update.text}`;
    } else if (item.knock) {
      content = `Tell the user, in just these words and nothing more: "${update.text}" Don't say what it is about; if they ask for it, read it then.`;
    } else if (item.kind === 'notice') {
      content = `New from ${agent.name}${where}, waiting on the user (not an answer to a request just now): ${update.text}${nameIt}`;
    } else if (item.late) {
      const earlier = task ? ` (the earlier request: "${task.request.slice(0, 120)}")` : '';
      content = `${agent.name}${where} finished what was still running${earlier}${update.kind === 'question' ? ' and has a question' : ''}: ${update.text}${nameIt}${asked}`;
    } else {
      const lead = update.kind === 'question' ? `${agent.name}${where} has a question` : `${agent.name}${where} reported back`;
      const transition = !requested && task && this.conversationWasOnAnotherAgent(task);
      const retry = item.attempts > 0 ? ' (the user did not hear this yet)' : '';
      // One opening: a new-topic transition and the thread name combine instead of competing.
      const opening = transition ? ` (new topic; open with "Okay, now ${agent.name}${spoken ? `, in the ${spoken} thread,` : ''} said")` : '';
      content = `${lead}${opening}${retry}: ${update.text}${transition ? '' : nameIt}${plain}${asked}${task && update.kind !== 'question' && isAnswer(update.text) ? ` ${followUpNote(agent.name)}` : ''}`;
    }
    if (this.policy === 'floor') {
      // Words the user already said (the request itself) don't prove the update was heard.
      const known = new Set([...deliveryKeywords(task?.request ?? ''), agent.name.toLowerCase()]);
      const fresh = deliveryKeywords(update.text).filter((word) => !known.has(word));
      this.pending = { item, releasedAt: this.now(), keywords: fresh.length ? fresh : deliveryKeywords(update.text), spoken: '', overlapped: false, overlapWords: '', overlapActivity: false, captureClosed: false };
    }
    if (task?.thread) this.currentThread = task.thread;
    if (item.focusItemId) this.focusConversation({ itemId: item.focusItemId });
    if (!item.reminder && item.kind !== 'readback' && agent.id !== 'operator') {
      const threadMatch = /^thread:(.+)$/.exec(item.conversationKey ?? '');
      const scene = await this.focusScreen(agent.id, 'auto', {
        threadId: task?.thread?.id ?? threadMatch?.[1] ?? null,
        since: task ? (task.lastSentAt ?? task.createdAt) : item.arrivedAt - 10 * 60_000,
      });
      // Live test 10/07: "give only the gist" cut the parts of an answer the user asked for
      // (a three-part question got one part aloud). An answer covers the question; the screen adds detail.
      if (scene) content += asked ? ` [${agent.name}'s "${scene.title || scene.summary}" is on the screen too; say so in a few words, but still speak what it says about the user's question.]` : ` [${agent.name}'s "${scene.title || scene.summary}" is on the screen now. Say it's on the screen and give only the gist aloud.]`;
      else if (this.options.screen?.screensConnected()) content += ` [Nothing new from ${agent.name} is on the screen for this. Don't say anything is on the screen.]`;
    }
    // Update hold: a pause or a draft began while this waited on the screen. It goes back to the front
    // of the queue (floor delivery already put it there), under every delivery policy (Codex review on #394).
    if (this.holdReasons.size > 0 && !this.readbackPasses(item)) {
      if (this.pending?.item === item) this.pending = null;
      if (!this.queue.includes(item)) this.queue.unshift(item);
      this.trace(`${[...this.holdReasons][0]}.queued`, `${[...this.holdReasons].join(' + ')} began mid-release: ${describeUpdate(item)} goes back to the front`, { agent: agent.id, itemKind: item.kind, requeued: true, depth: this.queue.length });
      return;
    }
    this.log('release', { taskId: task?.id, requestId: item.request?.id, agent: agent.id, itemKind: item.kind, waitedMs: this.now() - item.arrivedAt, requested, attempt: item.attempts + 1, place: item.place });
    this.traceQueued();
    this.trace('speech.released', `released ${describeUpdate(item)} after ${Math.round((this.now() - item.arrivedAt) / 100) / 10} s${item.attempts ? ` (attempt ${item.attempts + 1})` : ''}${requested ? ' (asked for)' : ''}`, {
      agent: agent.id,
      itemKind: item.kind,
      taskId: task?.id ?? null,
      requestId: item.request?.id ?? null,
      waitedMs: this.now() - item.arrivedAt,
      attempt: item.attempts + 1,
      requested,
    });
    if (item.kind !== 'readback' && !item.reminder) this.released.push({ text: update.text, at: this.now() });
    // A delegation that already carried this update (even cut off) ignores repeats on the
    // subscription route, so re-deliveries go out as session-wide context.
    await this.append('commentary', content, item.attempts > 0 ? null : item.delegationId);
    if (task && update.kind === 'question') {
      await this.append('thinking', `[${agent.name} awaits the user's answer; delegate the answer back to ${agent.name}]`, item.request ? item.request.delegationId : task.delegationId);
    }
  }

  private conversationWasOnAnotherAgent(task: OperatorTask): boolean {
    const recent = this.transcript.slice(-4).map((line) => line.text.toLowerCase()).join(' ');
    if (recent.includes(task.agent.name.toLowerCase())) return false;
    return this.options.agents.some((agent) => agent.id !== task.agent.id && recent.includes(agent.name.toLowerCase()));
  }

  /** A call that may hang or fail: bounded, with `fallback` when it doesn't answer in time. */
  private async bounded<T>(label: string, call: Promise<T> | undefined, ms: number, fallback: T): Promise<T> {
    if (call === undefined) return fallback;
    try {
      return await withTimeout(call, ms, label);
    } catch (err) {
      this.log('call.failed', { label, message: (err as Error).message });
      return fallback;
    }
  }

  /** Long agent text condensed for speech; the full text when the summarizer fails or hangs. */
  private async condense(agentId: string, text: string, question?: string): Promise<string> {
    if (!this.options.summarize || text.length <= 600) return withoutIds(text);
    return withoutIds(await this.bounded('summarize', this.options.summarize(agentId, text, question), this.timeouts.summarizeMs, text));
  }

  /** `silent`: a note that only tells the voice model to say nothing; it gives the filler gate no reason to open. */
  private async append(kind: LiveContextKind, content: string, delegationId: string | null, options: { silent?: boolean } = {}): Promise<void> {
    // Pause mode hook: nothing reaches GPT-Live while paused but the pause's own words.
    if (this.running && this.pause.holdsAppends()) {
      this.log('append.paused', { channel: kind, delegationId, content: content.slice(0, 160) });
      this.trace('pause.suppressed', `paused: held back a ${kind} note for the voice model`, { channel: kind, content: clipLine(content, 120) });
      return;
    }
    return this.appendNow(kind, content, delegationId, options);
  }

  private async appendNow(kind: LiveContextKind, content: string, delegationId: string | null, options: { silent?: boolean } = {}): Promise<void> {
    if (!this.running) {
      // The session ended: its GPT-Live connection is gone, and a newer one must not hear this.
      this.log('append.dropped', { channel: kind, delegationId, content: content.slice(0, 160) });
      return;
    }
    const sentAt = this.now();
    // The voice model has something to say now: a filler-only utterance no longer keeps it quiet.
    // A note that tells it to say nothing gives it nothing to say (Codex review on #481).
    if (!options.silent) this.options.fillerGate?.open();
    try {
      const ack = await withTimeout(this.options.client.appendContext(kind, content, delegationId), this.timeouts.appendMs, 'append');
      this.log('append', { channel: kind, delegationId, content, ackMs: this.now() - sentAt, startMs: ack.startMs });
    } catch (err) {
      this.log('append.error', { channel: kind, delegationId, content, message: (err as Error).message });
      // Sent but never acknowledged: resending session-wide could make it speak twice.
      if (err instanceof OperatorTimeout) return;
      if (delegationId !== null) {
        // Unknown or expired delegation: fall back to session-wide context.
        await this.appendNow(kind, content, null);
      }
    }
  }
}

/** A queued update as the pause's resume announcement sees it. */
function pausedUpdate(item: QueuedUpdate): PausedUpdate {
  return { agentName: item.agent.name, kind: item.failed ? 'failed' : item.update.kind === 'question' ? 'question' : 'result' };
}

/** Share of the smaller request's content words that also appear in the other. */
function similarity(a: string, b: string): number {
  const left = new Set(deliveryKeywords(a));
  const right = new Set(deliveryKeywords(b));
  const smaller = left.size <= right.size ? left : right;
  const larger = smaller === left ? right : left;
  if (smaller.size === 0) return 0;
  let shared = 0;
  for (const word of smaller) if (larger.has(word)) shared += 1;
  return shared / smaller.size;
}

/**
 * The conversation a scene was staged from (thread, or channel), from its origin fields or its
 * conversation key ("thread:<id>" / "channel:<id>"). Null when the scene carries no origin.
 */
export function sceneConversation(scene: Pick<ScreenScene, 'threadId' | 'channelId' | 'conversationKey'>): { threadId: string | null; channelId: string | null } | null {
  const key = /^(thread|channel):(.+)$/.exec(scene.conversationKey ?? '');
  const threadId = scene.threadId || (key?.[1] === 'thread' ? key[2] : null) || null;
  const channelId = scene.channelId || (key?.[1] === 'channel' ? key[2] : null) || null;
  return threadId || channelId ? { threadId, channelId } : null;
}

function toExtractorTask(task: OperatorTask): ExtractorTask {
  return {
    id: task.id,
    agentName: task.agent.name,
    request: task.request,
    status: task.status,
    lastUpdate: task.lastUpdate,
    ...(task.thread ? { threadTitle: task.thread.title } : {}),
  };
}

/** Splits long text into sentence-aligned pieces small enough for one append (500-token cap). */
export function chunkForReadback(text: string, maxChars = 1200): string[] {
  const sentences = text.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [text];
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > maxChars) {
      chunks.push(current.trim());
      current = '';
    }
    current += sentence;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The owner's decision on a go-ahead a thread asked for in its own words, as the reply that answers it.
 * Approve or decline only: a reply never grants a standing permission the extractor may have misheard.
 */
function proseApproval(ask: string, decision: DeskOpArgs['approval']): string {
  const asked = `You asked: "${ask.trim()}"`;
  if (decision === 'decline' || decision === 'cancel') return `${asked} No, declined. Don't do it.`;
  return `${asked} Yes, approved. Go ahead.`;
}

/**
 * A long request kept under GPT-Live's 500-token append cap with the reply. Spoken requests put
 * their asks last, so the tail is kept, cut at a word boundary; a clipped one starts with "…".
 */
export function boundQuestion(text: string, max = 700): string {
  if (text.length <= max) return text;
  const tail = text.slice(-max);
  return `…${tail.slice(tail.indexOf(' ') + 1)}`;
}

/** Status notices, not answers: asking for "every part" of the request would invite a made-up answer. */
const NOT_AN_ANSWER = /^(?:I hit an error on that|I couldn't finish that:|Sorry, I'm having trouble)/;

/**
 * The user's question, sent with the agent's reply so the spoken version covers what was asked
 * (live test 10/07: "give only the gist" kept one part of a three-part question). Whole, not
 * clipped: a clause cut off here would read as "not asked" and be left out.
 */
/** A real answer, not "still running" or a failure notice: only an answer has a conversation to follow up (Codex review on #798). */
function isAnswer(text: string): boolean {
  return text !== STILL_RUNNING_TEXT && !NOT_AN_ANSWER.test(text.trim());
}

/** On a relayed answer: the owner's response to it is that agent's conversation (voice misroute 10/19). */
export function followUpNote(agentName: string): string {
  return `[If the user responds to this with more than a thanks (agrees, pushes back, builds on it), delegate their words: they go back to ${agentName}. Don't discuss it yourself.]`;
}

export function askedDirective(update: AgentUpdate, requestMessage?: string): string {
  if (update.text === STILL_RUNNING_TEXT || NOT_AN_ANSWER.test(update.text.trim())) return '';
  const question = boundQuestion((update.asked ?? requestMessage ?? '').replace(/\s+/g, ' ').trim());
  if (!question) return '';
  return update.kind === 'question'
    ? ` The user asked: "${question}". Say whatever the reply answers of that, then ask its question; don't answer for the user.`
    : ` The user asked: "${question}". Answer every part of that aloud, leading with the direct answer${question.startsWith('…') ? '' : "; leave out only what the question didn't touch"}.`;
}

function clipLine(text: string, max: number): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** "Sierra result (Speaker): “The Pioneer is…”" for the session trace. */
function describeUpdate(item: Pick<QueuedUpdate, 'agent' | 'kind' | 'place' | 'update'>): string {
  return `${item.agent.name} ${item.kind}${item.place ? ` (${item.place})` : ''}: “${clipLine(item.update.text, 80)}”`;
}

/** Whose move it is in the words the Inbox shows (Needs you, Ready, Working, Watching, Failed), not the older step names. */
export function stepLabel(item: Pick<DeskItemSummary, 'status' | 'nextStep'>): string {
  // The move first: a thread asking the owner while it works is "needs you" with a working dot, not "working" (desk/status.ts).
  if (item.status?.pill) return item.status.pill === 'needs' ? 'needs you' : item.status.pill;
  const move = item.status?.move;
  if (move) return move === 'needs' ? 'needs you' : move;
  if (item.status?.live === 'todo') return 'to-do';
  if (item.status?.live === 'failed') return 'failed';
  if (item.status?.live === 'watching') return 'watching';
  if (item.status?.busy) return 'working';
  return item.nextStep === 'your_move' ? 'needs you' : item.nextStep === 'fyi' ? 'ready' : item.nextStep;
}

/** A position the speech says ("the first one", "number three", "the last one"), for a row op the router left blank. */
const SPOKEN_POSITION = /\b(?:(?:the )?(second to last|next to last|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|top|bottom)\b|number (one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\b)/i;

/** An open_row with no row: the router dropped the position it was asked for, so it is read from the speech (e2e L19). */
export function fillRowTarget(speech: string, actions: OperatorAction[]): OperatorAction[] {
  const rows = actions.filter((action) => action.type === 'screen' && action.op === 'open_row');
  if (rows.length !== 1 || (rows[0] as { target?: string }).target) return actions;
  const said = SPOKEN_POSITION.exec(speech);
  const position = said?.[1] ?? said?.[2];
  if (!position) return actions;
  return actions.map((action) => (action === rows[0] ? { ...action, target: position.toLowerCase() } : action));
}

/**
 * Two router slips the e2e runs caught (L9, D2): a reply whose task id is a desk handle is that item's desk reply; and
 * "show me Watching and open the second one" that came back with only the tab also opens the row the speech names.
 */
export function repairRouted(speech: string, actions: OperatorAction[], taskIds: ReadonlySet<string>, deskHandles: ReadonlyMap<string, string>): OperatorAction[] {
  let out = actions.map((action) => (action.type === 'reply' && !taskIds.has(action.taskId) && deskHandles.has(action.taskId) ? { type: 'desk' as const, op: 'reply' as const, item: action.taskId, message: action.message } : action));
  const then = /\band (?:then )?(?:open|show me|pull up) (?:the )?(second to last|next to last|first|second|third|fourth|fifth|last|top|bottom)(?: one| row)?\b/i.exec(speech);
  if (then && out.some((action) => action.type === 'screen' && (action.op === 'list_tab' || action.op === 'list_view')) && !out.some((action) => action.type === 'screen' && action.op === 'open_row')) {
    out = [...out, { type: 'screen', op: 'open_row', target: then[1]!.toLowerCase() }];
  }
  return out;
}

/** A list_tab or list_view with no name: the one tab or view of the page on screen the speech names (e2e N2). */
export function fillViewTarget(speech: string, actions: OperatorAction[], list: Pick<ListPage, 'tabs' | 'views'> | null): OperatorAction[] {
  const blank = actions.filter((action) => action.type === 'screen' && (action.op === 'list_tab' || action.op === 'list_view') && !action.target);
  if (blank.length !== 1 || !list) return actions;
  const op = (blank[0] as { op: ScreenOp }).op;
  const names = [...(op === 'list_view' ? (list.views ?? []) : []), ...list.tabs, ...(op === 'list_tab' ? (list.views ?? []) : [])].map((entry) => entry.name);
  const said = ` ${normalizeForMatch(speech)} `;
  const named = [...new Set(names.filter((name) => normalizeForMatch(name) && (said.includes(` ${normalizeForMatch(name)} `) || said.includes(` ${normalizeForMatch(name)}s `))))];
  if (named.length !== 1) return actions;
  return actions.map((action) => (action === blank[0] ? { ...action, target: named[0]! } : action));
}

/** A search hit voice read out, by its handle (h1, h2…). */
interface SearchHitRef {
  handle: string;
  itemId: string;
  title: string;
  agentName: string;
  archived: boolean;
  done: boolean;
  snippet: string;
}

/**
 * Every candidate a spoken name could mean, at the best tier only (exact, then starts-with, then contains):
 * one is a match, several a question for the owner, none a miss. Never a guess between look-alikes.
 */
export function matchAllByName<T>(candidates: readonly T[], name: (candidate: T) => string, words: string | undefined): T[] {
  const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(?:the|tab|view|project|space|folder|one)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const wanted = norm(words ?? '');
  if (!wanted) return [];
  const named = candidates.map((candidate) => ({ candidate, key: norm(name(candidate)) }));
  for (const tier of [
    (key: string) => key === wanted,
    (key: string) => key.startsWith(wanted) || (key.length > 2 && wanted.startsWith(key)),
    (key: string) => key.includes(wanted) || (key.length > 3 && wanted.includes(key)) || key.split(' ').includes(wanted),
  ]) {
    const hits = named.filter(({ key }) => tier(key)).map(({ candidate }) => candidate);
    if (hits.length) return hits;
  }
  return [];
}

/** The System page in a sentence or three: its status line, then the critical and the other open incidents by name. */
export function systemSummary(brief: DeskSystemBrief): string {
  const parts = [brief.line.trim()];
  if (brief.critical.length) parts.push(`Critical: ${brief.critical.join('; ')}.`);
  if (brief.open.length) parts.push(`Also open: ${brief.open.slice(0, 5).join('; ')}${brief.open.length > 5 ? `, and ${brief.open.length - 5} more` : ''}.`);
  if (brief.error) parts.push('The reading may be incomplete.');
  return parts.join(' ');
}

/** Capacity in a sentence or two: the tightest Claude account (five-hour and week left), threads running, and a disk warning. */
export function capacitySummary(capacity: DeskCapacity, now: number): string {
  const claude = capacity.accounts.filter((account) => account.provider === 'claude');
  const read = claude.filter((account) => account.fiveHour || account.weekly);
  const left = (account: (typeof claude)[number]) => Math.min(...[account.fiveHour?.left, account.weekly?.left].filter((value): value is number => typeof value === 'number'));
  const cooling = claude.filter((account) => {
    const until = typeof account.coolingUntil === 'string' ? Date.parse(account.coolingUntil) : account.coolingUntil;
    return typeof until === 'number' && Number.isFinite(until) && until > now;
  });
  const running = capacity.accounts.reduce((sum, account) => sum + account.running, 0);
  const parts: string[] = [];
  if (!read.length) parts.push('No usage readings for the Claude accounts right now.');
  else {
    const tight = [...read].sort((a, b) => left(a) - left(b))[0]!;
    const week = read.map((account) => account.weekly?.left).filter((value): value is number => typeof value === 'number');
    // Only the windows it has readings for: a missing one is unknown, never "100% left" (Codex review on #717).
    const windows = [tight.fiveHour ? `${Math.round(tight.fiveHour.left)}% of its five-hour window` : '', tight.weekly ? `${Math.round(tight.weekly.left)}% of its week` : ''].filter(Boolean);
    parts.push(`Tightest account: ${tight.name}, ${windows.join(' and ')} left.`);
    if (week.length > 1) parts.push(`Across ${week.length} Claude accounts, ${Math.round(week.reduce((sum, value) => sum + value, 0) / week.length)}% of the week is left on average.`);
  }
  if (cooling.length) parts.push(`${cooling.map((account) => account.name).join(' and ')} ${cooling.length === 1 ? 'is' : 'are'} resting after a limit.`);
  parts.push(`${running} thread${running === 1 ? '' : 's'} running now.`);
  const disk = capacity.machine?.disk;
  if (disk && disk.totalBytes > 0) {
    const freeGb = disk.freeBytes / 1024 ** 3;
    if (freeGb < 50 || disk.freeBytes / disk.totalBytes < 0.1) parts.push(`Disk is low: ${Math.round(freeGb)} GB free.`);
  }
  return parts.join(' ');
}

/** Routing actions in one short line ("dispatch sierra, screen board") for the session trace. */
export function describeActions(actions: OperatorAction[]): string {
  if (actions.length === 0) return 'nothing';
  return actions
    .map((action) => {
      const record = action as unknown as Record<string, unknown>;
      const detail = [record.op, record.agentId, record.item, record.taskId, record.reason].filter((value) => typeof value === 'string' && value).join(' ');
      return detail ? `${action.type} ${detail}` : action.type;
    })
    .join(', ');
}

/** Agent markdown as something to read aloud: no links, tables, code or formatting marks; at most ~3500 characters. */
export function plainForSpeech(text: string, max = 3500): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .split('\n')
    .filter((line) => !/^\s*\|?[-:| ]+\|?\s*$/.test(line))
    .map((line) => line.replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*)/, '').replace(/^\s*\|\s*|\s*\|\s*$/g, '').replace(/\s*\|\s*/g, ', ').replace(/[*_`~]+/g, '').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]+/g, ' ');
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n')) + 1).trim() || cut}…`;
}

/** Fixed status words: the desk pill wins over compatibility move/live fields. */
export function standsStep(card: DeskItemSummary): string {
  const status = card.status;
  if (status?.pill) {
    switch (status.pill) {
      case 'stuck': return 'It said it would keep going, but nothing is running.';
      case 'finished': return `It's finished${status.detail ? `: ${status.detail}` : ''}.`;
      case 'waiting': return `${status.detail || 'It is waiting'}.`;
      case 'failed': return 'Its last turn failed.';
      case 'working': return `${card.agentName} is working on it.`;
      case 'needs': return status.audience === 'lead' ? 'Its question is with its lead; nothing for you.' : 'It is waiting on the user.';
      case 'idle': return card.disposition !== 'active' ? `It is ${card.disposition}.` : 'Nothing is running.';
      case 'unknown': return `Its status is unknown${status.detail ? `: ${status.detail}` : ''}.`;
    }
  }
  const move = status?.move;
  const label = stepLabel(card);
  return (move === 'needs' || move === 'ready' || (!status && card.nextStep === 'your_move')) ? 'It is waiting on the user.' : label === 'failed' ? 'Its last turn failed.' : label === 'working' ? `${card.agentName} is working on it.` : label === 'watching' ? `It is being watched${card.watching?.reason ? `: ${card.watching.reason}` : ''}${card.watching?.overdue ? `, and overdue: ${card.watching.overdue.text}` : ''}.` : card.disposition !== 'active' ? `It is ${card.disposition}.` : '';
}
export function standsAsk(card: DeskItemSummary): string {
  if (!card.ask) return '';
  if (card.status?.audience === 'lead') return card.status.pill === 'needs' ? '' : 'Its question is with its lead; nothing for you.';
  if (card.status?.audience !== 'owner' || (card.status.pill && card.status.pill !== 'needs')) return '';
  return `Its question for the user: ${card.ask}${card.options.length ? ` (options: ${card.options.join('; ')})` : ''}.`;
}
