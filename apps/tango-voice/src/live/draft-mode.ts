import { TURN, normalizeSpeech, stripAsrNoise, opensLong, opensRamble, RAMBLE_START, isHold as isDraftHold, matchFinish as matchDraftFinish, contentBeforeFinish, isDraftCancel, isUndo, looksUnfinished, namedAgent, OPERATOR_NAME_PATTERN, FINISH_CUE, FUNCTION_WORDS, type UnfinishedSignals } from '../turn/turn-policy.js';
export { normalizeSpeech, stripAsrNoise, opensLong, isHold as isDraftHold, matchFinish as matchDraftFinish, contentBeforeFinish, isDraftCancel, isUndo, looksUnfinished, namedAgent, OPERATOR_NAME_PATTERN, type UnfinishedSignals } from '../turn/turn-policy.js';
import { randomUUID } from 'node:crypto';
import { getDecisionShadow, type DecisionPrompt } from '@tango/core';
import type { AgentDescriptor } from './agent-backend.js';
import type { DeskClient } from './desk-client.js';
import { nameFixer, type KnownPerson } from './known-names.js';
import type { LiveContextKind } from './gpt-live-client.js';
import { matchNextCommand, splitNextCue, type NextOp } from './next-up.js';
import type { ResponsesCaller } from './responses-caller.js';
import { asksWhere, describeStartPlace, type StartPlace } from './start-place.js';
import type { ExtractorDesk, ExtractorTask, ExtractorThread, OperatorAction } from './task-extractor.js';

// Draft mode (a.k.a. confirm mode): the owner thinks out loud, with long pauses, and the
// operator collects the whole thought before anything goes to an agent. GPT-Live decides end
// of turn itself and delegates on a long pause; outside draft mode the operator would route
// whatever it has. While drafting it only collects:
//
//   start   a phrase ("draft mode", "let me think out loud", "I've got a long message for
//           Sierra") or the router's `draft start` action. Optional target from the phrase.
//   collect every bit of fresh owner speech is appended to the draft (overlaps trimmed, in
//           order). GPT-Live is told to backchannel briefly and ask nothing. Meta commands
//           still work: show the board, cancel the draft, "it's for Sierra".
//   check   after ~90 s of silence, one gentle "keep holding this, or send it?".
//   pick    naming a desk conversation to work on ("let's talk about news-letter promotion", "okay,
//           shed vents", "pull up the speaker thread") or tapping its card opens it and starts an
//           empty draft for it (matchTopicPick / armForItem). Leaving ("back to the board") parks
//           the draft by item; reopening that item picks the fragments back up.
//   finish  "okay send it", "that's it", "I'm done" (or the router's `draft finish`): one model
//           call compiles the fragments into one clean message AND a full destination (agent +
//           where: a desk item / existing thread, the home channel, or a new thread). When the
//           owner already named where it goes and the compile agrees and asks nothing, it goes
//           out after a 3 s undo window (status `sending`, `undoUntil`), with no question asked.
//           Otherwise the Draft card shows both and the operator asks only "Send that to Sierra
//           in the shed vents thread?". Ambiguity (who, which thread, a contradiction) becomes a question first.
//   next    "next one" / "what's next" set the draft aside (parked with its conversation, or closed when
//           empty) and open the oldest waiting item / list the queue (next-up.ts). On a closer ("I'm done,
//           next one", "send it, what's next") the draft finishes as usual and the advance or list runs
//           once the send has gone out; an undo calls it off.
//   confirm "yes" sends once through the operator's normal dispatch/reply path. "No, to
//           Victor", "put it in the speaker thread", "also add…" re-compile and re-confirm.
//           "Scratch that / never mind / cancel" discards it.
//
// Outside draft mode the same module is the safety net: a send whose words sound unfinished
// (ends on "and" / "um" / a comma, a one-to-three word fragment, or the router flags it) waits
// for "Is that everything?"; "yes" sends it, more speech is added and then sent.
//
// State lives in a DraftSession owned at the voice-session level (it outlives a GPT-Live
// reconnect); each LiveOperator attaches as the current host while it is live.

export type DraftOp = 'start' | 'finish' | 'cancel' | 'unfinished';
export const DRAFT_OPS: readonly DraftOp[] = ['start', 'finish', 'cancel', 'unfinished'];

/** The router's draft action (task-extractor.ts). `unfinished` rides along a send the router thinks is cut off. */
export interface DraftAction {
  type: 'draft';
  op: DraftOp;
  agentId?: string;
  /** start: message content said after the intent; finish: dictation said before the cue (word for word). */
  message?: string;
  /** start: the desk conversation the draft is for (a handle from the router's desk listing). */
  item?: string;
}

/** Where a compiled draft goes. */
export interface DraftDestination {
  agentId: string;
  name: string;
  /** new_loom: a new Loom thread in `repo` (started through the desk's Start work); agentId is "loom". */
  kind: 'home' | 'thread' | 'new_thread' | 'item' | 'new_loom';
  threadId?: string;
  itemId?: string;
  title?: string;
  repo?: string;
  /** new_loom / new_thread: the project (space) the new thread joins, as the desk's + button files it. */
  projectId?: string;
  projectName?: string;
  /** new_loom / new_thread: the place came from the screen, not the owner's words (said back before it starts). */
  inferred?: boolean;
  /** "Sierra · Shed vents thread" (the card). */
  label: string;
}

/** `sending`: the confirmed draft is on its way and can no longer be cancelled. */
export type DraftStatus = 'listening' | 'compiling' | 'confirm' | 'sending' | 'sent' | 'cancelled';

/** Whether the operator's send path accepted the draft (a thread that can't be found or a desk reply that failed did not). */
export interface DraftSendOutcome {
  ok: boolean;
  error?: string;
}

/** What the desk shows (POST /api/desk/draft; `draft` events on /api/desk/stream). */
export interface DraftCard {
  /** This draft's identity (null when blank), so a late clear from an old session can't wipe a newer draft. */
  id: string | null;
  /** On a clear: the draft it clears; the desk ignores it when another draft has replaced that one. */
  clears?: string;
  active: boolean;
  /** `itemId`: the desk item the draft is for (null when it isn't for one). */
  target: { agentId: string; name: string; where: string | null; label: string; itemId: string | null } | null;
  fragments: string[];
  compiled: string | null;
  /** A clarifying question the operator asked before sending. */
  question: string | null;
  /** A short note (e.g. "Not sent: the voice session ended"). */
  note: string | null;
  status: DraftStatus;
  /** While `sending` without a question asked: the send waits until then (epoch ms) and a Cancel tap undoes it. */
  undoUntil?: number | null;
  updatedAt: number;
}

/** A screen tap on the Draft card (POST /api/desk/draft/command, relayed as `draftCommand`). */
export interface DraftScreenCommand {
  action: 'send' | 'cancel';
  commandId?: string;
  /** The draft the screen was showing; a tap on an older card is ignored. */
  draftId?: string;
}

export interface DraftCompileInput {
  fragments: string[];
  agents: AgentDescriptor[];
  tasks: ExtractorTask[];
  threads: ExtractorThread[];
  desk?: ExtractorDesk;
  transcript: string[];
  now: number;
  defaultAgentId?: string;
  /** The agent the owner named for this draft. */
  target?: { agentId: string; name: string } | null;
  /** The desk conversation the owner named for this draft (its handle in `desk`, and its place). */
  targetItem?: { handle: string | null; agentName: string; place: string | null } | null;
  /** Re-compiling: the last version and where it was going. */
  previous?: { message: string; destination: string | null };
  /** An edit or redirect the owner asked for ("no, to Victor", "also add the address"). */
  instruction?: string;
  /** Questions asked and the owner's answers. */
  clarifications?: Array<{ question: string; answer: string }>;
  /** The repos a new Loom thread can start in (the desk's Start work); absent when it can't. */
  loomRepos?: string[];
  /** The owner asked for a new Loom thread when the draft started. */
  newLoom?: boolean;
  /** The owner asked for a new thread without saying with whom or in which repo. */
  newThread?: boolean;
  /** Where a new thread starts when the owner doesn't say (the screen's place, as the desk's + button reads it). */
  startPlace?: StartPlace | null;
}

export interface DraftCompileResult {
  message: string;
  agentId: string | null;
  /** A desk handle (i1…). */
  item: string | null;
  threadId: string | null;
  newThreadTitle: string | null;
  /** A new Loom thread in this repo (one of `loomRepos`). */
  newLoomRepo?: string | null;
  questions: string[];
}

export type DraftCompiler = (input: DraftCompileInput) => Promise<DraftCompileResult>;

/** A desk item a compile result pointed at. */
export interface DraftItemRef {
  id: string;
  agentId: string;
  agentName: string;
  place: string | null;
  threadId: string | null;
  /** True when it belongs to one of the operator's agents (else it is another source, e.g. Loom). */
  isAgent: boolean;
  /** What the conversation is for, in a few words (the desk summary's `about`), for loose matching. */
  about?: string | null;
  /** The space (project) it is filed under: breaks a tie toward the space on screen. */
  projectId?: string | null;
}

/**
 * What the List on screen shows, for the quick pick: it yields to List commands (a row by position, a tab,
 * view, project, space or agent the List names) and breaks a name tie toward the rows on screen, then the
 * space on screen (decision B, 2026-10-17).
 */
export interface PickScreen {
  /** Row ids on screen, top first. */
  rows: string[];
  /** The space (project) page on screen, if any. */
  spaceId: string | null;
  /** Names the List itself answers to: its tabs and views, projects (spaces) and agents. */
  names: string[];
}

export interface DraftContext {
  input: Omit<DraftCompileInput, 'fragments' | 'target' | 'previous' | 'instruction' | 'clarifications'>;
  resolveItem(handle: string): DraftItemRef | null;
  /** The handle an item id has in this context's desk listing. */
  handleOf?(itemId: string): string | null;
}

/** Explicit routing state, independent of a live operator session. */
export interface DraftDestinationState {
  agents: AgentDescriptor[];
  startSpeech: string;
  fragments: string[];
  clarifications: Array<{ question: string; answer: string }>;
  newLoom: boolean;
  newThread: boolean;
  targetItem: DraftItemRef | null;
  target: AgentDescriptor | null;
}

/** Resolve only against offered destinations and the owner's words/place, without side effects. */
export function resolveDraftDestination(
  result: DraftCompileResult,
  context: DraftContext,
  state: DraftDestinationState,
): { destination: DraftDestination | null; usedNamed?: boolean } {
  // Early new-thread branches do not change the operator's previous named-item tracking.
  let usedNamed: boolean | undefined;
  const resolve = (): DraftDestination | null => {
    const make = (destination: Omit<DraftDestination, 'label'>): DraftDestination => ({ ...destination, label: destinationLabel(destination) });
    // A new Loom thread: only in a repo the desk offers (the model's spelling, any case).
    const repos = context.input.loomRepos ?? [];
    // Only a repo the owner said out loud: the model guesses one from the topic otherwise.
    const said = ` ${[state.startSpeech, ...state.fragments, ...context.input.transcript, ...state.clarifications.map((entry) => entry.answer)].join(' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
    const repo = result.newLoomRepo
      ? repos.find((candidate) => candidate.toLowerCase() === result.newLoomRepo!.toLowerCase() && said.includes(` ${candidate.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `))
      : // The compile left it empty, but the request that started the thread named one ("a new Loom thread in tango").
        (state.newLoom || state.newThread) && (!result.agentId || result.agentId === 'loom') && !result.item && !result.threadId
        ? namedRepo(state.startSpeech, repos)
        : undefined;
    // A new thread joins the screen's project, as the desk's + button files it.
    const place = context.input.startPlace ?? null;
    const project = place?.projectId ? { projectId: place.projectId, ...(place.projectName ? { projectName: place.projectName } : {}) } : {};
    const title = result.newThreadTitle ? { title: result.newThreadTitle } : {};
    if (repo) return make({ agentId: 'loom', name: 'Loom', kind: 'new_loom', repo, ...title, ...project });
    // Nothing named: the screen's place settles it (an agent's page or thread, a project's repo), else null and the owner is asked.
    const placed = (): DraftDestination | null => {
      if (state.newThread && place?.agentId) {
        const agent = state.agents.find((candidate) => persona(candidate.id) === persona(place.agentId!));
        if (agent) return make({ agentId: agent.id, name: agent.name, kind: 'new_thread', ...title, ...project, inferred: true });
      }
      if (place?.repo) {
        const offered = repos.find((candidate) => candidate.toLowerCase() === place.repo!.toLowerCase());
        if (offered) return make({ agentId: 'loom', name: 'Loom', kind: 'new_loom', repo: offered, ...title, ...project, inferred: true });
      }
      return null;
    };
    // Still the new thread unless the compile picked another place (a redirect to an agent or a conversation).
    if (state.newLoom && !result.agentId && !result.item && !result.threadId) return placed();
    if (state.newThread && !result.item && !result.threadId) {
      // An agent the owner named (now or in an answer): a new thread with that agent, never its main channel.
      const named = result.agentId ? state.agents.find((candidate) => candidate.id === result.agentId) : undefined;
      if (named) return make({ agentId: named.id, name: named.name, kind: 'new_thread', ...title, ...project });
      return placed();
    }
    // The conversation the owner named stands unless the compile picked another place (a redirect does).
    const named = state.targetItem;
    const pickedElsewhere = !!(result.item || result.threadId || result.newThreadTitle) || (!!result.agentId && named !== null && persona(result.agentId) !== persona(named.agentId));
    const ref = result.item ? context.resolveItem(result.item) : !pickedElsewhere ? named : null;
    usedNamed = !!ref && !!named && ref.id === named.id;
    {
      if (ref) {
        if (ref.isAgent && ref.threadId && /^\d+$/.test(ref.threadId)) return make({ agentId: ref.agentId, name: ref.agentName, kind: 'thread', threadId: ref.threadId, itemId: ref.id, ...(ref.place ? { title: ref.place } : {}) });
        if (ref.isAgent) return make({ agentId: ref.agentId, name: ref.agentName, kind: 'home' });
        return make({ agentId: ref.agentId, name: ref.agentName, kind: 'item', itemId: ref.id, ...(ref.place ? { title: ref.place } : {}) });
      }
    }
    const agent = state.agents.find((candidate) => candidate.id === result.agentId) ?? (result.agentId ? undefined : (state.target ?? undefined));
    if (!agent) return null;
    if (result.newThreadTitle) return make({ agentId: agent.id, name: agent.name, kind: 'new_thread', title: result.newThreadTitle, ...project });
    if (result.threadId) {
      const thread = context.input.threads.find((candidate) => candidate.id === result.threadId);
      const item = context.input.desk?.items.find((candidate) => candidate.threadId === result.threadId);
      if (thread || item) return make({ agentId: agent.id, name: agent.name, kind: 'thread', threadId: result.threadId, title: thread?.title ?? item?.place ?? 'thread' });
    }
    return make({ agentId: agent.id, name: agent.name, kind: 'home' });
  };
  const destination = resolve();
  return { destination, ...(usedNamed === undefined ? {} : { usedNamed }) };
}

/** What the current operator lends the draft session. */
export interface DraftHost {
  agents: AgentDescriptor[];
  /** The operator's trace session, so a judge reading the shadow log scopes hindsight to it. */
  traceSessionId?: string | null;
  now(): number;
  alive(): boolean;
  append(kind: LiveContextKind, content: string, delegationId: string | null): Promise<void>;
  trace(kind: string, summary: string, data?: Record<string, unknown>): void;
  log(event: string, data?: Record<string, unknown>): void;
  publish(card: DraftCard): void;
  context(): Promise<DraftContext>;
  /**
   * Sends through the operator's normal dispatch / reply path. `brief`: the confirmation is only "Sent."
   * `itemId`: the desk conversation it answers (also when the destination is the agent's main channel).
   */
  /** `draftId`: this draft's identity, so a retried send can't act twice (a new Loom thread). */
  send(destination: DraftDestination, message: string, delegationId: string | null, options?: { brief?: boolean; itemId?: string; draftId?: string }): Promise<DraftSendOutcome>;
  /** The router with draft context; only draft actions are honored. */
  route(speech: string): Promise<OperatorAction[]>;
  /** Raise a local delegation to read fresh speech (no-op if one is running). */
  collect(): void;
  /** Speech held while a send was in flight: handle it as if just said (next delegation, normal path). */
  replay(speech: string): void;
  hasFreshSpeech(): boolean;
  userQuietMs(): number;
  /** Pause mode is on: nothing is sent on a judged end meanwhile. */
  paused?(): boolean;
  /** A screen is connected (the card is visible), so no read-back is needed. */
  screenVisible(): boolean;
  /** The desk conversations a draft can be for (to match "for the X thread"). */
  deskTargets?(): DraftItemRef[];
  /** What the List on screen shows: a quick pick yields to List commands and breaks ties with it. */
  pickScreen?(): PickScreen | null;
  /**
   * Puts what the draft answers on the screens (the conversation, or its latest screen) so the owner
   * sees where things stand while composing: for a named conversation, or an agent when replying.
   */
  showContext?(target: { item: DraftItemRef | null; agent: AgentDescriptor | null; reply: boolean }): void;
  /**
   * A desk conversation in words, for when it is opened: `brief` is a short refresher (milestone, where it
   * stands, what waits on the owner), `full` the agent's latest reply as plain text. Null when it can't be read.
   */
  brief?(itemId: string): Promise<ItemBrief | null>;
  /** Puts the board (Active) back up: the owner left the draft (parked or discarded). */
  presentBoard?(): void;
  /**
   * Next up (next-up.ts): opens the oldest item waiting on the owner (advance) or speaks the queue
   * (list). `exclude`: items not to open (the one just left or sent to). `board: false` leaves the
   * screens as they are. `note`: what to say first (e.g. that the draft was saved).
   */
  next?(op: NextOp, context: { exclude: string[]; delegationId: string | null; board?: boolean; note?: string }): Promise<void>;
  desk?: DeskClient;
}

export interface DraftSpeechContext {
  delegationId: string | null;
  /** The operator's deterministic short commands (board, screen…). */
  quick?: (speech: string) => OperatorAction[] | null;
  /**
   * The router model, offered while something on the screen takes commands (the Prototype view):
   * it judges whether speech is a screen command ("can you click Skip for me") or dictation. Null
   * when it couldn't say (then it's dictation, as usual).
   */
  screenRoute?: (speech: string) => Promise<OperatorAction[] | null>;
}

export interface DraftSpeechOutcome {
  /** True: the draft session took this speech; apply `actions` (if any) and stop. */
  handled: boolean;
  actions?: OperatorAction[];
  /** The extraction handles held with released actions (the operator's own type). */
  handles?: unknown;
  /** Not handled, but route this speech instead (a held send plus what was added). */
  speech?: string;
  /** GPT-Live was already told what to say for this speech (no "still drafting" note on top). */
  answered?: boolean;
}

export interface DraftSessionOptions {
  compile?: DraftCompiler;
  /** Silence while drafting before the one gentle check (default 90 s). */
  checkAfterMs?: number;
  /** How long sent / cancelled shows on the card (default 4 s). */
  clearAfterMs?: number;
  /** How long an unsent draft stays on the card after the session ends (default 10 min). */
  unsentKeepMs?: number;
  /** A held "Is that everything?" send expires after this (default 2 min). */
  holdMs?: number;
  /** One compile call (default 30 s). */
  compileTimeoutMs?: number;
  /** A send that needs no question goes out this long after the owner finished speaking (default 3 s), counting compile time. */
  undoMs?: number;
  /** However fast that is, the compiled text stays up with Undo at least this long (default 3 s). */
  undoMinMs?: number;
  /** Owner speech at the end of the undo window is read before sending, for at most this much longer (default 10 s). */
  undoDeferMaxMs?: number;
  /** A parked draft is kept this long (default 12 h). */
  parkedKeepMs?: number;
  /** Fresh speech is collected once the owner is quiet this long (default 2 s). */
  collectQuietMs?: number;
  /**
   * Ends a draft without a closer: after a pause, the model judges whether the owner finished a thought.
   * Absent: drafts wait for "I'm done" / "go ahead" as before.
   */
  judgeEnd?: DraftEndJudge;
  /** Quiet this long after the last fragment before the end judge is asked (default 1.2 s). */
  endQuietMs?: number;
  /** Still quiet this long after a "not done": the judge takes a second look, told how long it's been (default 6 s). */
  endRelookMs?: number;
  log?: (event: string, data?: Record<string, unknown>) => void;
  now?: () => number;
}

// ── GPT-Live instructions ────────────────────────────────────────────────

export const DRAFT_ON_INSTRUCTIONS =
  '[Draft mode is ON. The user is composing a longer message out loud and will pause often, sometimes for a long time. Until you are told draft mode is over: ' +
  'everything they say is dictation for the message unless it is clearly addressed to you (usually by name: "Yankee, …"). ' +
  'A closer like "I\'m done", "okay, send it" or "that\'s it, send it" said after a pause finishes the draft; the same words in the middle of a sentence are dictation. ' +
  'A closer can carry what comes next ("I\'m done, next one", "send it, what\'s next"); "next one" or "what\'s next" on its own moves on. The backend handles all of these. ' +
  'A question put to you directly ("Yankee, what did Sierra say?") is not part of the message: answer it briefly, then go back to listening. ' +
  'Otherwise never answer, summarize, suggest, or ask questions; never say you are sending, checking, or passing anything on. ' +
  'On a pause, stay silent. Never say "keep going", "go ahead", "let me check", "checking", "on it", "looking into it" or "I\'ll find out", not even after delegating: you do nothing with what they dictate, and when they finish a thought the backend sends it by itself. ' +
  // Live 10/14: "Checking. Keep going." right after a finished reply, while it was already being sent: the owner said "Send it".
  'An invitation to keep talking sounds like you are waiting for them to say "send it", so give none. ' +
  'The backend hears every word, so you do not need to delegate what they say; you may delegate when they say to send it, cancel it, or who it is for. If you do delegate, do not say "on it" or anything about sending. ' +
  // Live 10/09: answered on its own with "Go ahead, I'm listening.", then the refresher followed it.
  'This note needs no reply: say nothing to it. What to say, if anything, comes in the next note.]';

/** After each delegation while drafting (live test 10/06: GPT-Live said "On it." / "Passed along." mid-draft). */
export const DRAFT_STILL_INSTRUCTIONS =
  "[Still drafting: nothing has been sent yet. Say nothing. Never say you sent, passed along, checked, or did anything, and never say \"keep going\", \"go ahead\", \"checking\" or \"on it\": when they finish a thought it goes by itself.]";

export const DRAFT_OFF_INSTRUCTIONS =
  '[Draft mode is over. Go back to your normal policies: no backchannels, wait for complete requests, delegate as usual.]';

// ── phrases ──────────────────────────────────────────────────────────────

function wordCount(text: string): number { return text ? text.split(' ').length : 0; }
function escapeName(name: string): string { return name.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim(); }

const START_PATTERNS: RegExp[] = [
  RAMBLE_START,
  /\b(?:start |enter |turn on |go into |let'?s do |use )?(?:draft|confirm) mode\b/,
  /\blet me (?:think|talk|work) (?:this |it |that |something )?(?:out loud|aloud|through|out)\b/,
  /\b(?:i'?m going to|i'?m gonna|i want to|i need to) (?:think|talk) (?:this |it )?(?:out loud|aloud|through)\b/,
  /\bi'?ve got a (?:long |longer |big |longish )?message for\b/,
  /\bi (?:have|got) a (?:long |longer |big |longish )?message for\b/,
  /\b(?:i want to|let me|i'?d like to|i need to) (?:draft|dictate|compose) (?:a |an )?(?:long |longer )?(?:message|note)\b/,
  /\btake (?:down )?a (?:long )?message for\b/,
  /\bhang on,? i'?m (?:working|figuring|thinking) (?:this|it) (?:out|through)\b/,
  /\bbear with me,? i'?m (?:working|figuring|thinking)\b/,
  // "Could you draft a longer message for the Lantern Row Loom thread", "help me draft a reply to Victor",
  // "draft something for Sierra" (live test 10/06: "could you draft a longer message for …" was missed).
  // A request, at the start of what was said: "read me the draft message" or "is the draft note ready" is not one.
  /^(?:(?:ok|okay|so|hey|hi|um|uh|alright|all right|right|actually|oh|yeah|and)\s+)*(?:(?:can|could|would|will) you (?:please )?(?:help me )?|please |help me |i want to |i'?d like to |i need to |let me |let'?s |i wanna )?(?:please )?draft (?:me )?(?:up )?(?:a |an )?(?:longer |long |quick |short |little |longish )?(?:message|note|reply|response|something)(?: (?:for|to))?\b/,
  // "Hey, let's work on a response for Sierra", "can we put together a reply to the shed vents thread",
  // "help me respond to Victor": a reply, so the screens pull up what it answers. Requests only, at the start.
  /^(?:(?:ok|okay|so|hey|hi|um|uh|alright|all right|right|actually|oh|yeah|and)\s+)*(?:(?:can|could|would|will) (?:you|we) (?:please )?(?:help me )?|please |help me |i want to |i'?d like to |i need to |let me |let'?s |let us |we need to |i wanna )?(?:work on|put together|write|craft|come up with|figure out|think through) (?:a |an |my |our |the )?(?:response|reply|answer)(?: (?:for|to))?\b/,
  /^(?:(?:ok|okay|so|hey|hi|um|uh|alright|all right|right|actually|oh|yeah|and)\s+)*(?:(?:can|could|would|will) you (?:please )?help me |help me |let'?s |let me |i want to |i need to |i'?d like to |can we |could we )(?:respond|reply) to\b/,
];
/** A start phrase about answering something (vs. a new message): the screens show what it answers. */
const REPLY_START = /\b(?:response|reply|respond|answer)\b/;
/** The words in a piece that carry something: no fillers, function words or ASR noise ("Mm", "[tongue click]", "okay so"). */
function meaningfulWords(text: string): string[] {
  return normalizeSpeech(stripAsrNoise(text)).split(' ').filter((word) => word && !FUNCTION_WORDS.has(word) && !/^(?:m+|mm+|hm+|mhm|um+|uh+)$/.test(word));
}

/** Nothing but hesitation sounds and transcription noise ("Hmm", "Mm-hmm", "[tongue click]", "Oh"): never "Okay" or "Right", which can be a reply. */
function isFillerOnly(text: string): boolean {
  const words = normalizeSpeech(stripAsrNoise(text).replace(/-/g, ' ')).split(' ').filter(Boolean);
  return words.every((word) => /^(?:h*m+h*m*|mhm+|mm+hm+|uh+(?:huh)?|um+|ah+|oh+|er+|erm+|hmm+)$/.test(word));
}

/** A start that says it will be long ("a long message for", "let me think out loud", "bear with me"): only a closer ends it. */
const LONG_START = /\b(?:long|longer|longish|big|lengthy) (?:message|note|reply|response)\b|\b(?:think|talk|work) (?:this |it |that |something )?(?:out loud|aloud|through)\b|\bbear with me\b|\bhang on,? i'?m\b|\bramble\b/;
const NOT_START = /\b(?:exit|end|leave|stop|cancel|turn off|out of) (?:the )?(?:draft|confirm) mode\b/;

// ── desk item matching ───────────────────────────────────────────────────

/** Words that never pick a conversation on their own. */
const MATCH_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'to', 'and', 'or', 'on', 'in', 'at', 'by', 'about', 'with', 'from', 'my', 'our', 'your', 'that', 'this', 'these', 'those', 'it', 'its',
  'is', 'are', 'be', 'one', 'ones', 'thread', 'threads', 'conversation', 'chat', 'item', 'loom', 'please', 'now', 'again', 'back', 'up', 'some', 'stuff', 'thing', 'things',
  'um', 'uh', 'so', 'ok', 'okay', 'yeah', 'yes', 'sure', 'thanks', 'thank', 'you', 'cool', 'great', 'good', 'just', 'like', 'there', 'what', 'about',
]);

/** One word, lightly stemmed: "Strategies" → "strategy", "vents" → "vent", "Sierra's" → "sierra". */
function stemWord(word: string): string {
  let w = word.toLowerCase().replace(/'s$/, '').replace(/'/g, '');
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && /(?:ches|shes|xes|sses|zes)$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return w;
}

/** Two stemmed words are the same word, or the same long stem ("promote" / "promotion"). */
export function sameStem(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  if (shorter < 5) return false;
  let common = 0;
  while (common < shorter && a[common] === b[common]) common += 1;
  return common >= 5 && common >= 0.8 * shorter;
}

/** Spoken and written words compared loosely: case, punctuation, hyphens, plurals. */
export function sameWord(a: string, b: string): boolean {
  return sameStem(stemWord(a), stemWord(b));
}

/** The words of a phrase that can pick a conversation (case, punctuation and hyphens gone, stemmed). */
export function contentWords(text: string): string[] {
  return normalizeSpeech(text)
    .split(' ')
    .filter((word) => word && !MATCH_STOPWORDS.has(word))
    .map(stemWord)
    .filter(Boolean);
}

function itemTitle(item: DraftItemRef): string {
  const place = item.place ?? '';
  return place.includes('·') ? place.slice(place.lastIndexOf('·') + 1).trim() : place;
}

export interface ItemBrief {
  brief: string;
  full: string | null;
}

// "Read it all", "read me the whole thing", "read it again": the conversation's latest reply, aloud, in full.
const READ_ALL = /^(?:(?:ok(?:ay)?|so|um|uh|please|can you|could you|would you)\s+)*(?:read (?:it|that|this) (?:all|again)|read (?:me )?(?:it|that|all of it|the whole (?:thing|reply|message)|the full (?:reply|message)|the (?:latest |last )?(?:reply|message))(?: (?:to me|out loud|aloud|again|please))*|read (?:it )?(?:out )?(?:to me )?again)(?: please)?$/;

export function isReadAll(speech: string): boolean {
  return READ_ALL.test(normalizeSpeech(speech));
}

export type DeskItemMatch = { kind: 'match'; item: DraftItemRef; score: number } | { kind: 'tie'; items: [DraftItemRef, DraftItemRef] } | { kind: 'none' };

/**
 * THE matcher for picking a desk conversation from spoken words (the single seam a model-based
 * matcher can replace): token overlap, ignoring case, punctuation, hyphens and plurals, across each
 * item's title / place and what it is about. Score = share of the spoken content words the item
 * has (the agent's name counts half, and never alone). The best item wins when it clearly beats the
 * next; two within 0.1 of each other is a tie (the caller asks "The X one or the Y one?").
 */
export function matchDeskItem(phrase: string, items: DraftItemRef[], options: { minScore?: number } = {}): DeskItemMatch {
  const scored = scoreDeskItems(phrase, items, options.minScore ?? 0.6);
  const best = scored[0];
  if (!best) return { kind: 'none' };
  const second = scored.find((entry) => entry.item.id !== best.item.id);
  if (second && best.score - second.score < 0.1) return { kind: 'tie', items: [best.item, second.item] };
  return { kind: 'match', item: best.item, score: best.score };
}

/** Every item the phrase names at or above `minScore`, best first. */
function scoreDeskItems(phrase: string, items: DraftItemRef[], minScore: number): Array<{ item: DraftItemRef; score: number }> {
  const said = [...new Set(contentWords(phrase))];
  if (said.length === 0 || items.length === 0) return [];
  return items
    .map((item) => {
      const vocab = contentWords([item.place ?? '', item.about ?? ''].join(' '));
      const names = contentWords(item.agentName);
      const topical = said.filter((word) => vocab.some((known) => sameStem(word, known)));
      const named = said.filter((word) => !topical.includes(word) && names.some((known) => sameStem(word, known)));
      const score = topical.length === 0 ? 0 : (topical.length + 0.5 * named.length) / said.length;
      return { item, score };
    })
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => b.score - a.score);
}

const LIST_POSITION = new RegExp(
  `^(?:the )?(?:(?:very )?(?:top|bottom|first|last)|(?:second|next) to last|penultimate|${['second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'].join('|')}|\\d{1,3}(?:st|nd|rd|th)?|(?:#|number )\\w+)(?: (?:one|row|item|thread))?$`,
);
/** Words that name the List's own places, never a conversation: "the Tango Voice project", "the jobs view", "the inbox". */
const LIST_PLACE_WORD = /\b(?:project|projects|space|spaces|tab|tabs|view|views|inbox|page|index|list|folder)\b/;

/**
 * Speech the List answers, not a conversation: a row by position ("the last one"), a word for a List place
 * ("the Tango Voice project", "the inbox"), or a name the List itself shows (a tab or view, a project or
 * space, an agent). `rest` is what follows the pick verb. These go to the router, which knows the List.
 */
export function namesListPlace(rest: string, screen: PickScreen | null | undefined): boolean {
  const text = normalizeSpeech(rest).replace(/^(?:the|my) /, '');
  if (!text) return false;
  if (LIST_POSITION.test(text) || LIST_PLACE_WORD.test(text)) return true;
  const bare = text.replace(/'s$/, '');
  return (screen?.names ?? []).some((name) => normalizeSpeech(name).replace(/^the /, '') === bare);
}

/**
 * A name several conversations answer to, narrowed by the screen (decision B): the rows on screen first,
 * then the space on screen. Still several: the first two, to ask which.
 */
function breakTie(tied: DraftItemRef[], screen: PickScreen | null | undefined): DeskItemMatch {
  let pool = tied;
  if (screen) {
    const onRows = pool.filter((item) => screen.rows.includes(item.id));
    if (onRows.length > 0) pool = onRows;
    const inSpace = screen.spaceId ? pool.filter((item) => item.projectId === screen.spaceId) : [];
    if (inSpace.length > 0) pool = inSpace;
  }
  if (pool.length === 1) return { kind: 'match', item: pool[0]!, score: 1 };
  return { kind: 'tie', items: [pool[0]!, pool[1]!] };
}

/** How to tell two tied conversations apart out loud: their titles, else whose they are. */
export function pickLabels(a: DraftItemRef, b: DraftItemRef): [string, string] {
  const titleA = itemTitle(a) || a.about || '';
  const titleB = itemTitle(b) || b.about || '';
  if (titleA && titleB && normalizeSpeech(titleA) !== normalizeSpeech(titleB)) return [titleA, titleB];
  if (a.agentName !== b.agentName) return [a.agentName, b.agentName];
  return [a.about || titleA || a.agentName, b.about || titleB || b.agentName];
}

/** The answer to "The X one or the Y one?": an ordinal, or words that name one of the two. */
export function choosePick(speech: string, items: [DraftItemRef, DraftItemRef]): DraftItemRef | null {
  const text = normalizeSpeech(speech);
  if (!text || wordCount(text) > 10) return null;
  if (/\b(?:first|former|1st)\b/.test(text)) return items[0];
  if (/\b(?:second|latter|last|2nd|other)\b/.test(text)) return items[1];
  const [a, b] = pickLabels(items[0], items[1]);
  // The labels the question used (titles, or whose they are) decide first; then the items' own words.
  const byLabel = matchDeskItem(text, [
    { ...items[0], place: a, about: null, agentName: '' },
    { ...items[1], place: b, about: null, agentName: '' },
  ], { minScore: 0.5 });
  if (byLabel.kind === 'match') return items.find((item) => item.id === byLabel.item.id) ?? null;
  const named = matchDeskItem(text, items, { minScore: 0.5 });
  return named.kind === 'match' ? named.item : null;
}

const LIST_PICK_VERB = "(?:(?:ok|okay|alright|all right|so|um|uh|yeah|and)\\s+)*(?:(?:let'?s (?:do|take|go with|start with|open|pull up)|go with|take|start with|open|pull up|i'?ll take)\\s+)?";
const LIST_ORDINALS: Array<[RegExp, (count: number) => number]> = [
  [/^(?:first|1st|number one|top)$/, () => 0],
  [/^(?:second|2nd|number two)$/, () => 1],
  [/^(?:third|3rd|number three)$/, () => 2],
  [/^(?:fourth|4th|number four)$/, () => 3],
  [/^(?:fifth|5th|number five)$/, () => 4],
  [/^(?:last|bottom)$/, (count) => count - 1],
];

/**
 * A pick from a list the operator just read ("what's next"): "the second one", "number three", "the
 * speaker one", "the Sierra one". Short, whole utterances only; null when it doesn't name one of them.
 */
export function chooseFromList(speech: string, items: DraftItemRef[]): DraftItemRef | null {
  const text = normalizeSpeech(speech);
  if (!text || wordCount(text) > 8 || items.length === 0) return null;
  const match = new RegExp(`^${LIST_PICK_VERB}(?:the )?(.+?)(?: (?:one|thread|conversation|item))?(?: please)?$`).exec(text);
  const rest = match?.[1]?.trim() ?? '';
  if (!rest) return null;
  for (const [pattern, index] of LIST_ORDINALS) {
    if (!pattern.test(rest)) continue;
    return items[index(items.length)] ?? null;
  }
  // "The Sierra one": whose it is, when only one listed item is theirs.
  const owner = rest.replace(/'s$/, '');
  const theirs = items.filter((item) => normalizeSpeech(item.agentName) === owner);
  if (theirs.length === 1) return theirs[0]!;
  // Only a reference that ends on "one" / "thread" names a topic ("the speaker one"): bare words could be anything.
  if (!/ (?:one|thread|conversation|item)(?: please)?$/.test(text)) return null;
  const named = matchDeskItem(rest, items);
  return named.kind === 'match' ? named.item : null;
}

// "Let's talk about X", "pull up X", "open X", "let's work on X", "let's do X", "switch to X".
const PICK_LEAD = "^(?:(?:ok|okay|alright|all right|so|um|uh|hey|right|yeah|and|now)\\s+)*";
const PICK_VERB =
  "(?:let'?s (?:talk|chat) about|let'?s (?:work on|do|look at|open|pull up|switch to|go to|go back to)|i want to (?:talk about|work on)|(?:can|could) (?:you|we) (?:please )?(?:pull up|bring up|open|switch to|go to)|(?:please )?(?:pull up|bring up|open up|open|switch to|go to|go back to))";
const PICK_VERB_PATTERN = new RegExp(`${PICK_LEAD}${PICK_VERB}\\s+(.+)$`);
/** "Okay, news-letter promotion": a bare topic after okay / alright (only when the whole rest names one item). */
const PICK_OKAY_PATTERN = /^(?:ok|okay|alright|all right)\s+(.+)$/;
/** "…thread", "…one please": the rest of the name, not content. */
const PICK_TAIL = /(?:\s+(?:loom|coding))?(?:\s+(?:thread|conversation|one|item|chat))?(?:\s+(?:please|now|again))*$/;

/**
 * A desk conversation picked to work on: "let's talk about the shed vents", "pull up news letter
 * promotion", "okay, news-letter promotion". Outside a draft a bare "okay X" counts when every content
 * word of X names the item; while drafting (`drafting`) only the explicit verbs do, so dictation that
 * opens with "okay" stays dictation. Null when it isn't a pick or names nothing on the desk.
 */
/** The repo a new-thread request names: "in tango", "for the acme repo", "on side-studio" (one the desk offers). */
export function namedRepo(speech: string, repos: string[]): string | undefined {
  const said = ` ${speech.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  return repos.find((repo) => new RegExp(` (?:in|for|on|at|under) (?:the )?${repo.toLowerCase().replace(/[^a-z0-9]+/g, ' ')}(?: repo| repository| codebase)? `).test(said));
}

export function matchTopicPick(speech: string, items: DraftItemRef[], options: { drafting?: boolean; screen?: PickScreen | null } = {}): DeskItemMatch | null {
  const text = normalizeSpeech(speech);
  if (!text || wordCount(text) > 12 || items.length === 0) return null;
  const verb = PICK_VERB_PATTERN.exec(text);
  const okay = !verb && !options.drafting ? PICK_OKAY_PATTERN.exec(text) : null;
  const rest = (verb?.[1] ?? okay?.[1] ?? '').replace(PICK_TAIL, '').trim();
  // "Go back to the board", "open the screen": the views, not a conversation.
  if (!rest || /^(?:the |my )?(?:board|home|screen|dashboard|desk|active|draft|draft mode)$/.test(rest)) return null;
  // "Okay send it", "okay, sounds good", "okay cancel that": an answer or a command, not a topic.
  if (okay && (FINISH_CUE.test(rest) || isPlainYes(rest) || wordCount(rest) > 6)) return null;
  // "Open the last one", "open the Tango Voice project", "go to the inbox": the List's, so the router's.
  if (namesListPlace(rest, options.screen)) return null;
  const scored = scoreDeskItems(rest, items, okay ? 1 : 0.6);
  const best = scored[0];
  if (!best) return null;
  const tied = scored.filter((entry) => best.score - entry.score < 0.1).map((entry) => entry.item);
  if (tied.length === 1) return { kind: 'match', item: best.item, score: best.score };
  const broken = breakTie(tied, options.screen);
  return broken.kind === 'match' ? { kind: 'match', item: broken.item, score: best.score } : broken;
}

/**
 * A desk conversation named right after a trigger: "the Lantern Row Loom thread", "the shed vents
 * thread", "Billing webhook retries". Matched word by word (loosely: case, hyphens, plurals) against
 * each item's title (the part of its place after "·") and its whole place; the longest match wins,
 * and two different items matching equally is no match.
 */
function matchDeskTarget(words: Array<{ word: string }>, at: number, items: DraftItemRef[]): { item: DraftItemRef; end: number } | null {
  let start = at;
  while (words[start] && ['the', 'my', 'that', 'this', 'our'].includes(words[start]!.word)) start += 1;
  let best: { item: DraftItemRef; end: number; length: number } | null = null;
  let tie = false;
  for (const item of items) {
    const place = item.place ?? '';
    const titles = [place.includes('·') ? place.slice(place.lastIndexOf('·') + 1) : place, place]
      .map((title) => normalizeSpeech(title).replace(/^the /, '').split(' ').filter(Boolean))
      .filter((title) => title.length > 0);
    for (const title of titles) {
      if (!title.every((word, offset) => words[start + offset] !== undefined && sameWord(words[start + offset]!.word, word))) continue;
      if (best && best.item.id !== item.id && best.length === title.length) tie = true;
      if (!best || title.length > best.length) {
        best = { item, end: start + title.length, length: title.length };
        tie = false;
      }
    }
  }
  if (!best || tie) return null;
  // "…Loom thread", "…thread", "…conversation" after the title belong to the name.
  let end = best.end;
  if (words[end]?.word === 'loom') end += 1;
  if (words[end] && ['thread', 'conversation', 'item', 'chat', 'one'].includes(words[end]!.word)) end += 1;
  return { item: best.item, end };
}

/**
 * A phrase that starts draft mode, the agent it names, and any content said after it, including
 * in the same sentence ("I've got a long message for Sierra: the patio needs another coat").
 */
export function matchDraftStart(speech: string, agents: AgentDescriptor[], items: DraftItemRef[] = []): { agent?: AgentDescriptor; item?: DraftItemRef; rest: string; reply: boolean; aimed?: true } | null {
  const text = normalizeSpeech(speech);
  if (!text || NOT_START.test(text)) return null;
  // Each spoken token and the normalized words it carries, so a match in the normalized text maps back.
  const tokens = speech.split(/\s+/).filter(Boolean).map((raw) => ({ raw, words: normalizeSpeech(raw).split(' ').filter(Boolean) }));
  const words = tokens.flatMap((token, index) => token.words.map((word) => ({ word, token: index })));
  for (const pattern of START_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const before = text.slice(0, match.index).trim();
    let end = (before ? before.split(' ').length : 0) + match[0].trim().split(' ').length;
    // The target right after the trigger: "…message for Sierra", "draft mode for Victor", "draft mode, Victor".
    let agent: AgentDescriptor | undefined;
    const tryName = (at: number): number => {
      for (const candidate of agents) {
        for (const name of [candidate.name, ...(candidate.aliases ?? [])].map(escapeName).filter(Boolean)) {
          const nameWords = name.split(' ');
          // "…respond to Victor's message": the possessive names the agent, and what of theirs belongs to the target.
          const last = nameWords.length - 1;
          if (nameWords.every((word, offset) => words[at + offset]?.word === word || (offset === last && words[at + offset]?.word === `${word}'s`))) {
            agent = candidate;
            let after = at + nameWords.length;
            if (words[after - 1]!.word.endsWith("'s")) {
              if (words[after] && ['last', 'latest', 'new', 'newest', 'recent'].includes(words[after]!.word)) after += 1;
              if (words[after] && ['message', 'note', 'question', 'reply', 'response', 'update', 'answer', 'idea', 'point', 'plan', 'email', 'thread'].includes(words[after]!.word)) after += 1;
            }
            return after;
          }
        }
      }
      return at;
    };
    // A bare name only when it closes the clause ("draft mode, Victor."), not "…, Victor said the build…".
    const afterName = tryName(end);
    // A trigger ending on "for" / "to" ("…message for Sierra the patio…") takes the name after it as the target.
    const triggerEndsOnFor = /\b(?:for|to)$/.test(match[0].trim());
    const closesClause = afterName > end && (triggerEndsOnFor || afterName >= words.length || /[.,:;!?—–-]$/.test(tokens[words[afterName - 1]!.token]!.raw));
    if (afterName > end && !closesClause) agent = undefined;
    let item: DraftItemRef | undefined;
    // "…for / to <something>" that names no agent or desk conversation we recognize ("the uh Loom thread").
    // Only when what follows reads like a place ("the …", "that … thread"), not content ("a reply to say the deploy failed").
    const at = triggerEndsOnFor ? end : end + 1;
    const ahead = words.slice(at, at + 8).map((entry) => entry.word);
    const placeLike = ['the', 'my', 'that', 'this', 'our'].includes(ahead[0] ?? '') || ahead.some((word) => ['thread', 'conversation', 'chat'].includes(word));
    const aimed = !closesClause && (triggerEndsOnFor || words[end]?.word === 'for' || words[end]?.word === 'to') && placeLike;
    if (closesClause) end = afterName;
    else if (words[end] && (words[end]!.word === 'for' || words[end]!.word === 'to')) {
      const named = tryName(end + 1);
      if (named > end + 1) end = named;
      else {
        const desk = matchDeskTarget(words, end + 1, items);
        if (desk) ({ item, end } = desk);
      }
    } else if (triggerEndsOnFor) {
      // "…message for the Lantern Row Loom thread": a desk conversation as the target.
      const desk = matchDeskTarget(words, end, items);
      if (desk) ({ item, end } = desk);
    }
    // "…a response for Sierra in the shed vents thread": one of that agent's conversations narrows the target.
    if (agent && !item && words[end] && ['in', 'on', 'about'].includes(words[end]!.word)) {
      const theirs = items.filter((candidate) => candidate.agentId.replace(/-ollama$/, '') === agent!.id.replace(/-ollama$/, ''));
      const desk = matchDeskTarget(words, end + 1, theirs);
      if (desk) ({ item, end } = desk);
    }
    // Words spoken after the trigger (and target) are the first fragment.
    let rest = '';
    if (end < words.length) {
      const first = words[end]!;
      const consumedInToken = words.filter((entry, index) => entry.token === first.token && index < end).length;
      const head = consumedInToken > 0 ? tokens[first.token]!.words.slice(consumedInToken).join(' ') : tokens[first.token]!.raw;
      rest = [head, ...tokens.slice(first.token + 1).map((token) => token.raw)].join(' ').replace(/^[\s,.;:!?\u2014\u2013-]+/, '').trim();
    }
    // An unread target: where its words end is unknown, so none of them are dictation (the message comes next).
    if (aimed && !agent && !item) return { rest: '', reply: REPLY_START.test(match[0]), aimed: true };
    return { ...(agent ? { agent } : {}), ...(item ? { item } : {}), rest: wordCount(normalizeSpeech(rest)) >= 2 ? rest : '', reply: REPLY_START.test(match[0]) };
  }
  return null;
}

const UNDO_PREFIX = new RegExp(
  "^\\s*(?:(?:oh|um|uh|ok|okay|so)[\\s,.!]+)*(?:no[\\s,.!]+wait|wait|hold on|hang on|undo|actually|not yet|stop|one more thing)\\b[\\s,.!:;\\u2014\\u2013-]*",
  'i',
);
const MORE_LEAD = /^(?:(?:one more thing|there'?s more|i (?:want|need) to add|let me add|and)\b[\s,.!:;—–-]*)+/i;

/**
 * During the undo window: speech that opens with "wait", "hold on", "no wait", "actually", "undo",
 * "one more thing"… stops the send. Returns what follows the opener (the addition, possibly empty),
 * else null.
 */
export function undoPrefix(speech: string): string | null {
  const text = speech.replace(/[’‘]/g, "'");
  const match = UNDO_PREFIX.exec(text);
  if (!match) return null;
  return text.slice(match[0].length).replace(MORE_LEAD, '').trim();
}

const ADDRESSED = new RegExp(`^\\s*(?:(?:hey|hi|ok|okay|oh|um|uh|so|yo)[\\s,.!]+)*${OPERATOR_NAME_PATTERN}\\b[\\s,.!:;—–-]*`, 'i');

/** "Yankee, what did Sierra say?": speech addressed to the operator by name. What follows the name, else null. */
export function addressedToOperator(speech: string): string | null {
  const match = ADDRESSED.exec(speech.replace(/[’‘]/g, "'"));
  return match ? speech.replace(/[’‘]/g, "'").slice(match[0].length).trim() : null;
}

const MORE = /^(?:(?:no|wait|actually|oh|ok(?:ay)?)\s+)*(?:hold on|hang on|wait|not yet|i'?m not (?:done|finished)|keep (?:going|listening)|let me (?:add|keep going|finish)|one more (?:thing|point)|there'?s more)\b/;

/** Complete affirmative utterances only: anything with more in it ("yes to Sierra", "yes after lunch") is an edit. */
const YES_LEAD = "(?:(?:um|uh|oh|ok|okay|yeah|yes|yep|sure|alright|all right|great|perfect)\\s+)*";
const YES_CORE =
  "(?:yes|yeah|yep|yup|yes please|sure|please|please do|do it|send it|send that|send it off|go ahead|go for it|correct|perfect|that'?s right|that'?s it|that'?s everything|that'?s all|that'?s good|that'?s perfect|sounds good|looks good|ok|okay|alright|all right|ship it|good|great|absolutely|definitely|yes send it|yep send it|do that)";
const YES_TAIL = "(?:\\s+(?:please|thanks|thank you|now|then))*";
const YES = new RegExp(`^${YES_LEAD}${YES_CORE}${YES_TAIL}$`);

/** A plain yes ("yes", "yep, send it", "that's everything"); never "yes but change…" or "yes to Sierra". */
export function isPlainYes(speech: string): boolean {
  // Backchannel noise around the yes ("Yes – mm", "mm, yeah") is not more to the answer.
  const text = normalizeSpeech(speech).replace(FILLERS_AROUND, '').trim();
  return !!text && YES.test(text);
}

/** "mm", "mhm", "hmm", "um", "uh" at either end of an utterance. */
const FILLERS_AROUND = /^(?:(?:m+|mm+hm+|m+hm+|h+m+|um+|uh+)\s+)+|(?:\s+(?:m+|mm+hm+|m+hm+|h+m+|um+|uh+))+$/g;



/** Short speech that might be a finish or cancel the phrases missed: worth asking the router. */
export function mightEndDraft(speech: string): boolean {
  const text = normalizeSpeech(speech);
  if (!text) return false;
  // Short speech with a cue anywhere, or longer dictation that ends on one.
  return wordCount(text) <= 12 ? FINISH_CUE.test(text) : FINISH_CUE.test(text.split(' ').slice(-6).join(' '));
}

/** "It's for Sierra", "this is for Victor", "who is it for… Sierra", "for Sierra": the target, short speech only. */
export function matchDraftTarget(speech: string, agents: AgentDescriptor[]): AgentDescriptor | undefined {
  const text = normalizeSpeech(speech);
  if (!text || wordCount(text) > 8) return undefined;
  const agent = namedAgent(text, agents);
  if (!agent) return undefined;
  const names = [agent.name, ...(agent.aliases ?? [])].map(escapeName).filter(Boolean).join('|');
  const pattern = new RegExp(`^(?:(?:ok(?:ay)?|oh|and|so|um|uh|yeah|actually)\\s+)*(?:(?:it'?s|this is|that'?s|this one'?s|it is|make it|the message is|this message is|it should go|send it)\\s+)?(?:(?:going )?(?:for|to)\\s+)?(?:${names})(?:\\s+(?:please|by the way))?$`);
  return pattern.test(text) ? agent : undefined;
}

/**
 * Appends a fragment, trimming words it repeats from the end of the draft so far (GPT-Live
 * transcripts can overlap when a line grows after it was read). Returns null when nothing is new.
 */
export function trimOverlap(previous: string, next: string): string | null {
  const nextWords = next.trim().split(/\s+/).filter(Boolean);
  if (nextWords.length === 0) return null;
  const prevNorm = normalizeSpeech(previous).split(' ').filter(Boolean);
  const nextNorm = nextWords.map((word) => normalizeSpeech(word));
  if (prevNorm.length === 0) return next.trim();
  // Entirely repeated at the end of what we have.
  const tail = prevNorm.slice(-nextNorm.length).join(' ');
  if (nextNorm.length >= 2 && tail === nextNorm.join(' ')) return null;
  for (let k = Math.min(prevNorm.length, nextNorm.length - 1); k >= 3; k--) {
    if (prevNorm.slice(-k).join(' ') === nextNorm.slice(0, k).join(' ')) return nextWords.slice(k).join(' ');
  }
  return next.trim();
}

// ── safety net ───────────────────────────────────────────────────────────

/** The unfinished-speech check as one yes/no for the shadow decision model (it never holds anything). */
export function unfinishedDecisionPrompt(speech: string): DecisionPrompt {
  return {
    state: { dictation: speech.slice(0, 2000) },
    questions: {
      unfinished: {
        type: 'binary',
        instructions: 'This is speech the owner just said out loud to send to an AI agent. Was the speaker cut off mid-thought, leaving the message unfinished?',
      },
    },
  };
}

// ── the model call ───────────────────────────────────────────────────────

const COMPILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['message', 'agent_id', 'item', 'thread_id', 'new_thread_title', 'new_loom_repo', 'questions'],
  properties: {
    message: { type: 'string', description: 'The clean message, in the user\'s own voice.' },
    agent_id: { type: 'string', description: 'One listed agent id, or empty when it goes to a non-agent desk item or is unclear.' },
    item: { type: 'string', description: 'A desk item handle (i1…) when the message continues that conversation, else empty.' },
    thread_id: { type: 'string', description: 'An existing thread id from Active threads, else empty.' },
    new_thread_title: { type: 'string', description: 'A short title when it should start a new thread, else empty.' },
    new_loom_repo: { type: 'string', description: 'When it should start a new Loom thread: one listed Loom repo, exactly as listed. Else empty.' },
    questions: { type: 'array', items: { type: 'string' }, description: 'Short spoken clarifying questions, only when genuinely needed; else empty.' },
  },
} as const;

export function buildDraftCompilePrompt(input: DraftCompileInput): string {
  const agents = input.agents.map((agent) => `- ${agent.id}: ${agent.name}${agent.aliases?.length ? ` (also "${agent.aliases.join('", "')}")` : ''} — ${agent.role}`).join('\n');
  const desk = input.desk?.items.length
    ? input.desk.items
        .map((item) => `- ${item.handle}: ${item.agentName}${item.place ? ` · "${item.place}"` : ''} [${item.step}]${item.threadId ? ` thread=${item.threadId}` : ''}: ${item.line}`)
        .join('\n')
    : '(empty)';
  const threads = input.threads.length ? input.threads.map((thread) => `- ${thread.id}: "${thread.title}" (${thread.agentName}, active ${thread.lastActive})`).join('\n') : '(none)';
  const tasks = input.tasks.length ? input.tasks.map((task) => `- ${task.agentName}${task.threadTitle ? ` in "${task.threadTitle}"` : ''}: "${task.request}"`).join('\n') : '(none)';
  return [
    'The user dictated a message out loud, in fragments with long pauses, to send to one of their AI agents. Turn it into one clean message and decide exactly where it goes.',
    `Now: ${new Date(input.now).toString()}`,
    '',
    `Agents:\n${agents}`,
    '',
    `Desk (open conversations${input.desk?.focused ? `; ${input.desk.focused} is open on screen` : ''}${input.desk?.lastDiscussed ? `; ${input.desk.lastDiscussed} was discussed last` : ''}):\n${desk}`,
    '',
    `Active threads:\n${threads}`,
    '',
    `Requests sent this session:\n${tasks}`,
    '',
    `Recent conversation:\n${input.transcript.join('\n') || '(empty)'}`,
    '',
    ...(input.loomRepos?.length ? [`Loom repos (a new Loom thread can start in one): ${input.loomRepos.join(', ')}`, ''] : []),
    ...(input.newLoom ? ['The user said this draft starts a NEW Loom thread: set new_loom_repo, never an agent, item, or existing thread.'] : []),
    ...(input.newThread
      ? [
          'The user said this draft starts a NEW thread, without saying (yet) with whom or where. Never an item or an existing thread.',
          `- Where it starts when they don't say (the screen's place, as the desk's + button reads it): ${describeStartPlace(input.startPlace ?? null)}.`,
          '- An agent they name (in the fragments or a clarification) → agent_id and new_thread_title. A repo they name → new_loom_repo and new_thread_title. Otherwise leave agent_id and new_loom_repo empty: the place above settles it.',
          '- When neither their words nor the place settle it, ask one short question with your best guess from the topic first, like "In tango, or with Watson?". Never pick an agent or repo they didn\'t name; never default to the chief of staff.',
        ]
      : []),
    ...(input.target ? [`The user said this draft is for: ${input.target.name} (${input.target.agentId}).`] : []),
    ...(input.targetItem ? [`The user said this draft is for the desk conversation ${input.targetItem.handle ?? ''} (${input.targetItem.agentName}${input.targetItem.place ? ` · "${input.targetItem.place}"` : ''}): send it there unless they change it, and never ask where it goes.`] : []),
    `Fragments, in order:\n${input.fragments.map((fragment, index) => `${index + 1}. ${fragment}`).join('\n') || '(none)'}`,
    ...(input.previous ? ['', `Previous version:\n"${input.previous.message}"`, `Previous destination: ${input.previous.destination ?? '(none)'}`] : []),
    ...(input.clarifications?.length ? ['', 'Clarifications:', ...input.clarifications.map((entry) => `- Asked "${entry.question}" → the user said "${entry.answer}"`)] : []),
    ...(input.instruction ? ['', `Change the user asked for now: "${input.instruction}"`] : []),
    '',
    'Message rules:',
    '- Keep every point, detail, number, name, and nuance, in the user\'s voice (first person).',
    '- Remove fillers (um, like, you know), false starts, repetition, and self-corrections: keep only the corrected version ("Tuesday, no, Wednesday" → Wednesday; "scratch that" drops what it retracts).',
    '- Leave out fragments that are not part of the message: words to someone in the room ("Riley, grab your shoes"), a device, video or TV talking, or reps counted out loud.',
    '- Add nothing: no greeting, sign-off, or anything the user did not say. Do not address the agent by name unless the user did.',
    '- When a change is asked for, apply exactly that change to the previous version and keep the rest as it was. A change may be only about where it goes.',
    'Destination rules (one place):',
    '- agent_id: the agent the user named, else the one the content clearly belongs to by role or by an open conversation.',
    '- item: the desk handle when the message continues that conversation (match agent and topic); a Loom item (a coding thread, not an agent) is reached only this way, with agent_id empty.',
    '- thread_id: an existing thread from Active threads when the message continues it and no desk item fits.',
    '- new_thread_title: only when the user asks for a new thread (or redirects to one); a short specific title.',
    ...(input.loomRepos?.length
      ? [
          '- new_loom_repo: only when the user asks to start a new Loom thread (a coding thread): the repo they named, exactly as listed, with agent_id, item and thread_id empty. new_thread_title is then a short title for it. The message is the first message to the coding agent: the task itself, in their words, without the request to start a thread or the repo name.',
          `- A new Loom thread needs a repo and a task. Never guess the repo from the topic: only a repo the user named (in the fragments, the clarifications, or the recent conversation)${input.startPlace?.repo ? `, else ${input.startPlace.repo}, the screen's place (leave new_loom_repo empty and don't ask)` : ''}. When none was named${input.startPlace?.repo ? '' : ' and the screen\'s place gives none'}, leave new_loom_repo empty and ask "Which repo: <the listed repos>?". When there is no task yet, ask "What should it work on?".`,
        ]
      : []),
    '- Otherwise only agent_id: the agent\'s main channel.',
    'Questions: ask (short, natural, spoken) only when genuinely needed: who it is for is unclear; several threads or agents plausibly fit and nothing settles it ("Sierra\'s shed vents thread, or a new one?"); the fragments contradict each other; or a detail the agent needs is plainly missing. Otherwise []. When asking, still give your best message and destination.',
  ].join('\n');
}

export function parseDraftCompileOutput(raw: string): DraftCompileResult {
  const parsed = JSON.parse(raw) as { message?: string; agent_id?: string; item?: string; thread_id?: string; new_thread_title?: string; new_loom_repo?: string; questions?: string[] };
  const text = (value: string | undefined) => (value && value.trim() ? value.trim() : null);
  return {
    message: (parsed.message ?? '').trim(),
    agentId: text(parsed.agent_id),
    item: text(parsed.item),
    threadId: text(parsed.thread_id),
    newThreadTitle: text(parsed.new_thread_title),
    ...(text(parsed.new_loom_repo) ? { newLoomRepo: text(parsed.new_loom_repo) } : {}),
    questions: (parsed.questions ?? []).map((question) => question.trim()).filter(Boolean).slice(0, 2),
  };
}

/** The compile / edit / redirect model call (the router's ResponsesCaller). */
export function createDraftCompiler(call: ResponsesCaller, options: { people?: KnownPerson[] } = {}): DraftCompiler {
  // Known names are fixed here too: a drafted message never passes through the router's fix.
  const fix = nameFixer(options.people);
  return async (input) => {
    const result = parseDraftCompileOutput(
      await call({
        instructions: 'Compile the dictated draft. Reply with JSON only.',
        input: [{ role: 'user', text: buildDraftCompilePrompt(input) }],
        schema: { name: 'draft_message', schema: COMPILE_SCHEMA as unknown as Record<string, unknown> },
      }),
    );
    return { ...result, message: fix(result.message), newThreadTitle: result.newThreadTitle && fix(result.newThreadTitle) };
  };
}

// ── ending without a closer ──────────────────────────────────────────────

export interface DraftEndInput {
  fragments: string[];
  /** Who it is for, in words ("Sierra · Bike Fenders"). */
  destination: string;
  /** Recent conversation, oldest first (what the owner may be answering). */
  transcript: string[];
  /** A second look: the owner has been silent this long since the last piece. */
  silentMs?: number;
}

export type DraftEndJudge = (input: DraftEndInput) => Promise<{ done: boolean; reason: string }>;

const END_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['done', 'reason'],
  properties: {
    done: { type: 'boolean', description: 'True only when the owner has finished what they wanted to say and paused at a natural end.' },
    reason: { type: 'string', description: 'A few words why.' },
  },
} as const;

/** The operator's own acknowledgements ("Checking.", "Go ahead.", "Mm-hm"): not the conversation, and never a reason to wait. */
const OPERATOR_ACK = /^operator:\s*(?:(?:ok(?:ay)?|sure|got it|mm-?hm+|uh-?huh|go ahead|checking|let me check(?: on that)?|one (?:sec(?:ond)?|moment)|still (?:drafting|listening)|i'?m listening)[\s.,!…-]*)+$/i;

export function buildDraftEndPrompt(input: DraftEndInput): string {
  const transcript = input.transcript.filter((line) => !OPERATOR_ACK.test(line.trim())).slice(-6);
  return [
    `The owner is dictating a message out loud to ${input.destination} and just paused. Speech-to-text gives it in pieces, one per pause.`,
    'Decide whether they are done (the message should go now) or will keep talking after this pause.',
    '',
    `Recent conversation (what they may be answering):\n${transcript.join('\n') || '(empty)'}`,
    '',
    `Dictated so far (${input.fragments.length} piece${input.fragments.length === 1 ? '' : 's'}):\n${input.fragments.map((fragment, index) => `${index + 1}. ${fragment}`).join('\n')}`,
    ...(input.silentMs
      ? ['', `They have now been silent for ${Math.round(input.silentMs / 1000)} seconds since the last piece. Silence this long after a complete statement means they are done. It does even when the last piece trails off ("…or will this be… uh") once the question, answer or request in it is already clear; not done only when the point itself is missing ("there is a version from a brand that,").`]
      : []),
    '',
    'Most messages are short: a question, an answer, a request, a choice or a reaction, often a few sentences with a reason attached ("Do you think the Kraft Geek is better than the Spigen? Spigen is a brand I recognize, but that doesn\'t mean anything."). When the last piece is a complete sentence, they are done.',
    'Not done only when there is a clear sign of more: it stops mid-sentence or mid-word ("…from a brand called", "instead of"); the latest piece announces more ("a few things", "I have some feedback", "a couple of thoughts", "first,", "also", "one more", "here\'s what I noticed:"); or they said they have more to say or want to take their time.',
    'A sentence that ends on a thought or opinion ("but that doesn\'t mean anything", "part of me wants to keep it") is complete, not trailing off. Lines from the operator are not the owner and never mean the owner will continue.',
    'When unsure, done: if they keep talking within a few seconds, the new words join this message before it goes, so a wrong "done" costs little; a wrong "not done" leaves them waiting in silence. Owners who want to take their time say so ("this is a long one").',
  ].join('\n');
}

export function createDraftEndJudge(call: ResponsesCaller): DraftEndJudge {
  return async (input) => {
    const parsed = JSON.parse(
      await call({
        instructions: 'Judge whether the dictation is finished. Reply with JSON only.',
        input: [{ role: 'user', text: buildDraftEndPrompt(input) }],
        schema: { name: 'draft_end', schema: END_SCHEMA as unknown as Record<string, unknown> },
      }),
    ) as { done?: boolean; reason?: string };
    return { done: parsed.done === true, reason: (parsed.reason ?? '').trim() };
  };
}

// ── router hooks (task-extractor.ts) ─────────────────────────────────────

export interface DraftRouterContext {
  active: boolean;
  target?: string | null;
}

/** Lines for the router prompt: the draft action, or (while drafting) "only draft actions". */
export function draftRouterLines(draft: DraftRouterContext | undefined): string[] {
  if (draft?.active) {
    return [
      `Draft mode is ON${draft.target ? ` (for ${draft.target})` : ''}: the user is composing a message out loud and nothing is sent until they finish. Everything they say is dictation unless it is clearly addressed to the system. Return exactly one action:`,
      '- draft with draft_op finish when they say they are done or to send it ("I\'m done", "okay send it", "that\'s it, send it"), usually after a pause; the same words inside a sentence of dictation are not a finish (set agent_id if they name who it is for; message = any dictation said before the cue in this same speech, word for word, else empty);',
      '- draft with draft_op cancel when they want to throw it away;',
      '- otherwise none (it is more of the message). Never dispatch, reply, or act on the desk now.',
    ];
  }
  return [
    '- draft: the user wants to compose a longer message or think out loud before anything is sent ("let me think this through before you send it", "I want to dictate a note for Sierra", "hold everything, I\'m going to ramble"): draft_op start, agent_id when they name an agent it is for, item = the desk handle when they name a conversation or thread it is for ("the Lantern Row Loom thread", "the shed vents thread"; match the item\'s place), and message = whatever they already said for the message itself after that intent, word for word (empty if nothing). Never dispatch such speech.',
    '- Asking for help writing a reply or message to a conversation ("can you help me draft a response to the feature announcement thread", "let\'s work on a reply for Sierra") is always draft start with that item, never desk open or reply: the message comes next.',
    '- Picking a conversation to work on is draft start with item = its handle, never desk open or read: "let\'s talk about X", "okay, X", "pull up X", "open X", "let\'s work on X", "let\'s do X", or just naming its topic. Match loosely: case, hyphens and plurals don\'t matter, and the topic can match the item\'s place or what it is about ("news letter" = "News-Letter Promotion Strategies"). Asking what an item says ("what\'s the Foxtrot one about?") is still desk read.',
    '- When the latest speech asks for something to be sent (dispatch or reply) but sounds cut off mid-thought, add a draft action with draft_op unfinished next to it.',
    '- Starting a NEW Loom thread (a coding thread, in a repo: "new Loom thread in tango", "start a coding thread for the acme repo", "start a thread in Loom for the acme repo", "kick off a Loom thread to fix …") is always draft start with agent_id "loom" and message = the task already said, word for word (empty if none). Never dispatch it to an agent, not even the chief of staff: agents can\'t open Loom threads. Talking to an EXISTING Loom thread is still desk reply.',
  ];
}

/** The router's raw draft fields → an action (unknown op → none). */
export function parseDraftAction(op: string | undefined, agentId: string | undefined, message?: string, item?: string): OperatorAction {
  const found = DRAFT_OPS.find((candidate) => candidate === op);
  if (!found) return { type: 'none', reason: `unclear draft action "${op ?? ''}"` };
  return {
    type: 'draft',
    op: found,
    ...(agentId ? { agentId } : {}),
    ...((found === 'start' || found === 'finish') && message?.trim() ? { message: message.trim() } : {}),
    ...(found === 'start' && item?.trim() ? { item: item.trim() } : {}),
  };
}

/**
 * The message content in speech the router read as "start a draft" when it didn't say what it was:
 * what a start phrase leaves, else whatever follows a dash or colon ("hold everything — the deploy…").
 */
export function contentAfterIntent(speech: string, agents: AgentDescriptor[]): string {
  const phrased = matchDraftStart(speech, agents);
  if (phrased?.rest) return phrased.rest;
  const split = /\s(?:—|–|--|-)\s|:\s/.exec(speech);
  if (!split) return '';
  const rest = speech.slice(split.index + split[0].length).trim();
  return wordCount(normalizeSpeech(rest)) >= 3 ? rest : '';
}

// ── the session ──────────────────────────────────────────────────────────

/** `holding`: compiled with nothing to ask, waiting out the undo window before it sends. */
type Phase = 'idle' | 'listening' | 'compiling' | 'clarifying' | 'confirm' | 'holding' | 'sending';

/** A draft left for the board ("back to the board"), kept by the desk item it was for. */
interface ParkedDraft {
  item: DraftItemRef;
  target: AgentDescriptor | null;
  fragments: string[];
  at: number;
  /** The owner said it's a long one: only a closer sends it, after reopening too. */
  longForm?: boolean;
}

/** The owner counts as speaking until this quiet (the undo window waits for them). */
const UNDO_SPEECH_QUIET_MS = 800;
/** How often a deferred undo-window send looks again. */
const UNDO_DEFER_STEP_MS = 250;

/** "sierra-ollama" and "sierra" are one persona. */
function persona(agentId: string): string {
  return agentId.replace(/-ollama$/, '');
}


interface HeldSend {
  actions: OperatorAction[];
  handles: unknown;
  speech: string;
  at: number;
}

function blankCard(at: number): DraftCard {
  return { id: null, active: false, target: null, fragments: [], compiled: null, question: null, note: null, status: 'listening', updatedAt: at };
}

function clip(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** How the destination is said aloud: "Sierra in the shed vents thread". */
export function spokenDestination(destination: DraftDestination): string {
  switch (destination.kind) {
    case 'thread':
      return `${destination.name} in the ${destination.title ? `"${destination.title}"` : ''} thread`.replace('  ', ' ');
    case 'new_thread':
      return `${destination.name} in a new thread${destination.title ? `, "${destination.title}"` : ''}${destination.projectName ? `, under ${destination.projectName}` : ''}`;
    case 'item':
      return `the ${destination.name} thread${destination.title ? ` "${destination.title}"` : ''}`;
    case 'new_loom':
      return `a new thread in ${destination.repo}${destination.projectName ? `, under ${destination.projectName}` : ''}`;
    default:
      return destination.name;
  }
}

export function destinationLabel(destination: Omit<DraftDestination, 'label'>): string {
  switch (destination.kind) {
    case 'thread':
      return `${destination.name} · ${destination.title ?? 'thread'} thread`;
    case 'new_thread':
      return `${destination.name} · new thread${destination.title ? ` “${destination.title}”` : ''}${destination.projectName ? ` · ${destination.projectName}` : ''}`;
    case 'item':
      return `${destination.name} · ${destination.title ?? 'thread'}`;
    case 'new_loom':
      return `Loom · new thread in ${destination.repo}${destination.title ? ` “${destination.title}”` : ''}${destination.projectName ? ` · ${destination.projectName}` : ''}`;
    default:
      return `${destination.name} · main channel`;
  }
}

/**
 * One voice session's draft (and safety-net hold). Survives GPT-Live reconnects: each operator
 * attaches as the host while live. Cleared by end().
 */
export class DraftSession {
  private host: DraftHost | null = null;
  private phase: Phase = 'idle';
  private target: AgentDescriptor | null = null;
  /** A desk conversation the owner named for this draft ("for the Lantern Row Loom thread"). */
  private targetItem: DraftItemRef | null = null;
  private fragments: string[] = [];
  private compiled: string | null = null;
  private destination: DraftDestination | null = null;
  private question: string | null = null;
  /** Shown on the card until the next compile (e.g. why the last send failed). */
  private note: string | null = null;
  private clarifications: Array<{ question: string; answer: string }> = [];
  private destinationClarified = false;
  private card: DraftCard;
  private lastSpeechAt = 0;
  private checked = false;
  /** The owner asked for a new Loom thread when this draft started ("new Loom thread in tango …"). */
  private newLoom = false;
  /** A new thread with nothing named yet (router agent_id "new"): the place, or the owner's answer, settles it. */
  private newThread = false;
  private clearTimer: NodeJS.Timeout | null = null;
  private held: HeldSend | null = null;
  /** The current draft's identity (see DraftCard.id). */
  private draftId: string | null = null;
  /** Bumped by end(): work that resolves after the session ended (a send, a compile) changes nothing. */
  private epoch = 0;
  /** The last owner speech seen outside a draft (for a router-detected start's content). */
  private lastSpeech = '';
  /** What started a new coding thread ("new Loom thread in tango to …"): the repo it names settles where it goes. */
  private startSpeech = '';
  /** The router-detected start's speech, handed to start() (lastSpeech is cleared before it runs). */
  private startingSpeech = '';
  /**
   * A start phrase whose target we couldn't read ("…a response to the uh Loom thread"): the router,
   * which sees the desk, names it. If the router doesn't start a draft, this phrase starts one anyway,
   * so the dictation that follows is never sent as a reply (live test 10/07).
   */
  private deferredStart: { reply: boolean; at: number } | null = null;
  /** Speech said while a send was in flight; replayed once it resolves. */
  private queued: string[] = [];
  /** Drafts parked by desk item id ("back to the board"); reopening the item resumes one. */
  private readonly parked = new Map<string, ParkedDraft>();
  /** "The X one or the Y one?" asked after a tied pick: the next words choose. */
  private pendingPick: { items: [DraftItemRef, DraftItemRef]; at: number } | null = null;
  /** The owner named where this draft goes before finishing it: a compile that agrees sends with no question. */
  private autoSend = false;
  /** The owner asked to take their time ("hold on", "this is a long one"): only a closer ends this draft. */
  private longForm = false;
  /** The last fragment waits for the end judge (its fragment count), once the owner has been quiet a beat. */
  private endPending: number | null = null;
  /** An end-judge call is out. */
  private judging = false;
  /** The operator's command hooks from the last speech (quick commands, screen routing), for replays. */
  private speechHooks: Omit<DraftSpeechContext, 'delegationId'> = {};
  /** The speech starting the next draft said it will be long (read by start() after its reset). */
  private startsLong = false;
  /** Counts owner speech reaching the draft: a verdict asked before newer speech is stale. */
  private speechSeen = 0;
  /** What the end judge last looked at (words and destination): a change gets judged again. */
  private judgedKey: string | null = null;
  /** The judge said "not done" to this key: if the owner stays quiet, it takes a second look. */
  private relookKey: string | null = null;
  /** This send was started by the end judge, not a closer: speech in its undo window adds to the draft. */
  private endedByJudge = false;
  /** The compile's destination is the conversation the owner named (resolveDestination). */
  private usedNamed = false;
  /** This draft was armed by a card tap (see armedOnly). */
  private armedByTap = false;
  /** "I'm done, next one": what runs once this draft's send has gone out (an undo or a cancel calls it off). */
  private afterSend: NextOp | null = null;
  /** The list the operator last read ("what's next"), so "the second one" picks from it (kept 2 min). */
  private offered: { items: DraftItemRef[]; at: number } | null = null;
  /** The undo window of a send that needs no question. */
  private undoTimer: NodeJS.Timeout | null = null;
  private undoUntil: number | null = null;
  /** When the owner's latest utterance arrived: the undo window is counted from the end of "I'm done". */
  private heardAt = 0;
  /** Things to tell GPT-Live that resolved while no operator was attached (between connections). */
  private unsaid: Array<{ kind: LiveContextKind; content: string }> = [];
  private publisher: ((card: DraftCard) => void) | null = null;
  private screenHandler: ((command: DraftScreenCommand) => void) | null = null;
  private readonly now: () => number;
  private readonly log: (event: string, data?: Record<string, unknown>) => void;

  constructor(private readonly options: DraftSessionOptions = {}) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.card = blankCard(this.now());
  }

  /** Drafting (collecting, compiling, clarifying or confirming). */
  get active(): boolean {
    return this.phase !== 'idle';
  }

  /** The card as last published. */
  get state(): DraftCard {
    return this.card;
  }

  /** A send held on "Is that everything?". */
  get holding(): boolean {
    return this.held !== null;
  }

  /** A new operator (first, or after a reconnect) takes over: GPT-Live hears draft mode again. */
  attach(host: DraftHost): void {
    this.host = host;
    this.publisher = (card) => host.publish(card);
    this.screenHandler = (command) => void this.onScreenCommand(command);
    host.desk?.onDraftCommand?.(this.screenHandler);
    if (this.active) {
      host.trace('draft.resume', `draft carried over to a new voice connection (${this.fragments.length} fragment${this.fragments.length === 1 ? '' : 's'}, ${this.phase})`, { phase: this.phase, fragments: this.fragments.length });
      void host.append('instructions', DRAFT_ON_INSTRUCTIONS, null);
      const unsaid = this.unsaid.splice(0);
      for (const entry of unsaid) void host.append(entry.kind, entry.content, null);
      if (!unsaid.length && this.phase === 'confirm' && this.destination) void host.append('instructions', `[A compiled draft for ${spokenDestination(this.destination)} is waiting for the user's yes. If they ask, it's on the screen.]`, null);
      this.publish({});
      // A send waiting out its undo window when the connection dropped: due now goes now; else the rest of the window.
      if (this.phase === 'holding') {
        const left = (this.undoUntil ?? 0) - this.now();
        host.trace('draft.hold.resume', left > 0 ? `the undo window carried over a reconnect: ${Math.ceil(left / 1000)} s left` : 'the undo window ran out during a reconnect: sending now', { leftMs: Math.max(0, left) });
        if (left <= 0 && !host.paused?.()) {
          if (this.undoTimer) clearTimeout(this.undoTimer);
          this.undoTimer = null;
          void this.send(null, 'auto');
        } else if (left <= 0) this.scheduleHeldSend(UNDO_DEFER_STEP_MS); // paused: waits for the pause to end
        else if (!this.undoTimer) this.scheduleHeldSend(left);
      }
    }
  }

  detach(host: DraftHost): void {
    if (this.host !== host) return;
    host.desk?.onDraftCommand?.(null);
    this.host = null;
  }

  /**
   * An empty draft armed by a card tap: nothing has been said for it yet. It neither holds agent
   * updates nor keeps the connection awake (the owner may only be reading), until the first words.
   */
  get armedOnly(): boolean {
    return this.active && this.armedByTap && this.fragments.length === 0;
  }

  /** An open draft still listening with nothing said yet. */
  get focusIsEmpty(): boolean {
    return this.active && this.phase === 'listening' && this.fragments.length === 0;
  }

  /** How many parts the open draft holds (0 when none is open). */
  get partCount(): number {
    return this.active ? this.fragments.length : 0;
  }

  /** The open draft is listening (not compiling, holding or sending). */
  get listening(): boolean {
    return this.active && this.phase === 'listening';
  }

  /** The desk item the open draft is for, or null. */
  get focusItemId(): string | null {
    return this.active ? (this.targetItem?.id ?? null) : null;
  }

  /** Agent updates wait while the owner composes (an open draft, but not one that is only armed). */
  get holdsUpdates(): boolean {
    return this.active && !this.armedOnly;
  }

  /** Keeps a sleeping-on-idle voice connection awake while a draft is being said (up to 10 min of silence). */
  holdsSession(): boolean {
    return (this.holdsUpdates && this.now() - this.lastSpeechAt < 10 * 60_000) || this.held !== null;
  }

  /**
   * The screens went back to the board without a word about the draft (a tap on the board, the idle
   * return): a draft for a conversation is parked under it, as "back to the board" would. False when
   * there was none to leave (no draft, no conversation, or one being compiled or sent).
   */
  leaveForBoard(why: string): boolean {
    if (!this.host || !this.targetItem || this.phase !== 'listening') return false;
    const left = this.park(why, { quiet: true });
    if (left) void this.host.append('instructions', DRAFT_OFF_INSTRUCTIONS, null);
    return left;
  }

  /**
   * Pause mode (pause-mode.ts) ended with this draft open: GPT-Live hears draft mode again (the
   * pause instructions replaced it), and the silence clock restarts so the pause doesn't count as
   * a long silence in the draft.
   */
  resumeAfterPause(): void {
    const host = this.host;
    if (!host || !this.active) return;
    this.lastSpeechAt = this.now();
    this.checked = false;
    // A verdict dropped because of the pause: the draft is judged again now.
    this.judgedKey = null;
    host.trace('draft.resume', `back from a pause with the draft still open (${this.fragments.length} fragment${this.fragments.length === 1 ? '' : 's'}, ${this.phase})`, { phase: this.phase, fragments: this.fragments.length, after: 'pause' });
    void host.append('instructions', DRAFT_ON_INSTRUCTIONS, null);
  }

  /** The router's view of the draft (ExtractorInput.draft). */
  routerContext(): DraftRouterContext {
    return { active: this.active, target: this.target?.name ?? null };
  }

  /** Once a second from the operator's housekeeping: collect fresh speech, and the one gentle check. */
  tick(): void {
    const host = this.host;
    if (!host || !host.alive()) return;
    if (this.held && this.now() - this.held.at > (this.options.holdMs ?? 120_000)) {
      host.trace('safety.expired', `held send expired unanswered: “${clip(this.held.speech, 80)}” was not sent`, { speech: clip(this.held.speech, 200) });
      this.held = null;
    }
    const collecting = this.phase === 'listening' || this.phase === 'confirm' || this.phase === 'clarifying' || this.phase === 'holding' || this.held !== null;
    if (collecting && host.hasFreshSpeech() && host.userQuietMs() >= (this.options.collectQuietMs ?? 2000)) host.collect();
    // Words or destination changed since the last look (a conversation picked or tapped after dictating): judge again.
    if (this.endPending === null && this.phase === 'listening' && this.fragments.length > 0 && this.options.judgeEnd && this.endKey() !== this.judgedKey) this.endPending = this.fragments.length;
    if (this.endPending !== null && !this.judging && this.phase === 'listening' && !host.hasFreshSpeech() && host.userQuietMs() >= (this.options.endQuietMs ?? 1200)) void this.judgeEnd();
    // "Not done", and they've stayed quiet since: one second look, told how long the silence has been.
    else if (this.relookKey !== null && this.endPending === null && !this.judging && this.phase === 'listening' && !host.hasFreshSpeech()) {
      const silent = Math.min(host.userQuietMs(), this.now() - this.lastSpeechAt);
      if (silent >= (this.options.endRelookMs ?? 6000)) {
        const again = this.relookKey === this.endKey();
        this.relookKey = null;
        if (again) void this.judgeEnd(silent);
      }
    }
    // A draft for a conversation the owner picked never asks: the card shows it, and leaving parks it.
    if (this.phase === 'listening' && !this.targetItem && !this.checked && this.now() - this.lastSpeechAt >= (this.options.checkAfterMs ?? 90_000) && host.userQuietMs() >= 5000) {
      this.checked = true;
      host.trace('draft.check', `drafting, ${Math.round((this.now() - this.lastSpeechAt) / 1000)} s of silence: asked whether to keep holding or send`, { fragments: this.fragments.length });
      void host.append('commentary', '[The user has been quiet a while in draft mode. Ask once, gently, in these few words: "Want me to keep holding this, or send it?" Then listen.]', null);
    }
  }

  /** The router said draft (start / finish / cancel). */
  async applyAction(action: DraftAction, delegationId: string | null, resolveItem?: (handle: string) => DraftItemRef | null): Promise<void> {
    const host = this.host;
    if (!host) return;
    const agent = action.agentId ? host.agents.find((candidate) => candidate.id === action.agentId) : undefined;
    if (action.op === 'start') {
      if (this.active) {
        // Another conversation named mid-draft: this draft is parked (or retargeted) and that one starts.
        const named = action.item ? (resolveItem?.(action.item) ?? null) : null;
        if (named && named.id !== this.targetItem?.id && this.phase === 'listening') {
          await this.switchTo(named, delegationId, 'pick');
          return;
        }
        if (agent) this.setTarget(agent, delegationId);
        return;
      }
      // What was said for the message in the same breath is its first fragment, as on the phrase path.
      const rest = action.message?.trim() || contentAfterIntent(this.lastSpeech, host.agents);
      // The conversation named: the router's handle, else the phrase matcher's reading of the same words.
      const phrased = matchDraftStart(this.lastSpeech, host.agents, host.deskTargets?.() ?? []);
      const item = (action.item ? (resolveItem?.(action.item) ?? null) : null) ?? phrased?.item ?? null;
      const said = this.lastSpeech;
      this.lastSpeech = '';
      // start() reads it for the repo a new coding thread names (Codex review on #715).
      this.startingSpeech = said;
      // agent_id "loom": a new coding thread (it is not an agent; the compile picks the repo or asks for it).
      // The desk's Start work runs it on Loom.
      this.markLongStart(said, rest);
      // agent_id "new": a new thread with nothing named; the screen's place (or the owner's answer) settles where.
      await this.start(agent, rest, delegationId, 'model', item, phrased?.reply ?? false, '', action.agentId === 'loom' && !item, action.agentId === 'new' && !item);
      return;
    }
    if (!this.active) {
      host.trace('draft.ignored', `router said draft ${action.op} with no draft open: ignored`, { op: action.op });
      return;
    }
    if (action.op === 'finish') {
      if (agent) this.target = agent;
      await this.finish(delegationId);
    } else if (action.op === 'cancel') {
      await this.cancel(delegationId, 'model');
    }
  }

  /**
   * Fresh owner speech from a delegation (GPT-Live's or a local collect). Draft mode takes all of
   * it while active; a held safety-net send takes the answer to "Is that everything?".
   */
  async onSpeech(speech: string, context: DraftSpeechContext): Promise<DraftSpeechOutcome> {
    const host = this.host;
    if (!host) return { handled: false };
    const { delegationId } = context;
    const text = speech.trim();

    if (this.held && !this.active && text) {
      const held = this.held;
      this.held = null;
      if (this.now() - held.at <= (this.options.holdMs ?? 120_000)) {
        if (isPlainYes(text)) {
          host.trace('safety.release', `“Is that everything?” → yes: sending the held request`, { speech: clip(held.speech, 200) });
          return { handled: true, actions: held.actions, handles: held.handles };
        }
        if (isDraftCancel(text, 'confirm')) {
          host.trace('safety.dropped', 'the owner called off the held request: nothing sent', { speech: clip(held.speech, 200) });
          await host.append('commentary', '[Nothing was sent. Confirm in a few words.]', delegationId);
          return { handled: true };
        }
        const combined = `${held.speech} ${text}`;
        host.trace('safety.extend', `more after “Is that everything?”: routing the whole request`, { speech: clip(combined, 200) });
        return { handled: false, speech: combined };
      }
    }

    if (!this.active) {
      if (!text) return { handled: false };
      this.lastSpeech = text;
      const targets = host.deskTargets?.() ?? [];
      // The answer to "The X one or the Y one?".
      const asked = this.pendingPick;
      this.pendingPick = null;
      if (asked && this.now() - asked.at < 60_000) {
        const chosen = choosePick(text, asked.items);
        if (chosen) {
          host.trace('draft.pick', `“${clip(text, 60)}” → ${chosen.agentName}${chosen.place ? ` · ${chosen.place}` : ''}`, { itemId: chosen.id, after: 'tie' });
          await this.start(undefined, '', delegationId, 'pick', chosen, false);
          return { handled: true };
        }
      }
      // "The second one", "the speaker one" right after the operator read the queue.
      const offered = this.offeredItems();
      const fromList = offered ? chooseFromList(addressedToOperator(text) ?? text, offered) : null;
      if (fromList) {
        host.trace('draft.pick', `“${clip(text, 60)}” picks ${fromList.agentName}${fromList.place ? ` · ${fromList.place}` : ''} from the list just read`, { itemId: fromList.id, after: 'list' });
        await this.start(undefined, '', delegationId, 'pick', fromList, false);
        return { handled: true };
      }
      // "Next one", "what's next": the operator's (never a topic pick of an item that happens to say "next").
      if (matchNextCommand(addressedToOperator(text) ?? text, { bare: addressedToOperator(text) !== null })) return { handled: false };
      const start = matchDraftStart(text, host.agents, targets);
      this.deferredStart = null;
      if (!start && opensRamble(text)) {
        const first = text.match(/^.*?(?:[.!?](?:\s|$)|$)/)?.[0].trim() ?? text;
        const normalized = normalizeSpeech(stripAsrNoise(first));
        const preamble = RAMBLE_START.exec(normalized);
        const rest = preamble?.[0] === normalized ? text.slice(first.length).trim() : text;
        this.markLongStart(first);
        await this.start(undefined, '', delegationId, 'phrase', null, false);
        if (rest) await this.onListeningSpeech(rest, context);
        return { handled: true };
      }
      if (!start) {
        // "Let's talk about news-letter promotion", "okay, shed vents": open it and start a draft for it.
        const pick = matchTopicPick(addressedToOperator(text) ?? text, targets, { screen: host.pickScreen?.() ?? null });
        if (pick?.kind === 'match') {
          host.trace('draft.pick', `“${clip(text, 60)}” picks ${pick.item.agentName}${pick.item.place ? ` · ${pick.item.place}` : ''} (score ${pick.score.toFixed(2)})`, { itemId: pick.item.id, score: pick.score });
          await this.start(undefined, '', delegationId, 'pick', pick.item, false);
          return { handled: true };
        }
        if (pick?.kind === 'tie') {
          await this.askWhich(pick.items, text, delegationId);
          return { handled: true };
        }
        return { handled: false };
      }
      if (start.aimed) {
        this.deferredStart = { reply: start.reply, at: this.now() };
        host.trace('draft.start.deferred', `draft start heard; asking the router which conversation “${clip(text, 80)}” means`, {});
        return { handled: false };
      }
      this.markLongStart(text, start.rest);
      await this.start(start.agent, start.rest, delegationId, 'phrase', start.item ?? null, start.reply);
      return { handled: true };
    }

    // Drafting: nothing new said (GPT-Live re-delegating) never routes anywhere.
    if (!text) {
      await this.stillDrafting(delegationId);
      return { handled: true };
    }
    this.lastSpeechAt = this.now();
    this.checked = false;
    this.speechSeen += 1;
    this.speechHooks = { quick: context.quick, screenRoute: context.screenRoute };

    if (this.phase === 'compiling' || this.phase === 'sending') {
      // Mid-compile or mid-send (a screen tap's slow thread lookup): held, then handled once it resolves.
      this.queued.push(text);
      host.trace('draft.queued', `“${clip(text, 80)}” said while ${this.phase}: held until it resolves`, { text: clip(text, 200), phase: this.phase });
      if (this.phase === 'compiling') await this.stillDrafting(delegationId);
      return { handled: true };
    }

    if (this.phase === 'holding') {
      // The undo window: "undo" / "wait" / "cancel" stops the send and goes back to listening.
      const said = addressedToOperator(text) ?? text;
      if (this.endedByJudge && isDraftHold(said)) {
        // A judged send and "(Yankee,) hold on" / "this is a long one": not sent, and from here only a closer sends it.
        await this.undo(delegationId, 'voice');
        this.longForm = true;
        this.endPending = null;
        return { handled: true };
      }
      if (isUndo(said)) {
        await this.undo(delegationId, 'voice');
        return { handled: true };
      }
      // "Wait, one more thing: …", "hold on, add the gate code", "actually, also…": stop the send and keep the rest.
      const more = undoPrefix(said);
      if (more !== null) {
        await this.undo(delegationId, 'voice', more);
        return { handled: true };
      }
      if (isDraftCancel(said, 'confirm')) {
        await this.cancel(delegationId, 'phrase');
        return { handled: true };
      }
      // Sent on a judged pause, not a closer: talking again means they weren't done, so it joins the draft.
      // A real closer: bare ("go ahead") lets it go; with words ("and the tent, send it") adds them and sends.
      if (this.endedByJudge && addressedToOperator(text) === null) {
        const closer = matchDraftFinish(text, host.agents);
        if (closer && !closer.content) {
          host.trace('draft.hold.confirmed', `“${clip(text, 60)}” during a judged send's undo window: it goes as is`, {});
          return { handled: true };
        }
        await this.undo(delegationId, 'voice', closer?.content ?? text);
        if (closer) await this.finish(delegationId);
        return { handled: true };
      }
      this.queued.push(text);
      host.trace('draft.queued', `“${clip(text, 80)}” said while the send waits out its undo window: handled once it goes`, { text: clip(text, 200), phase: this.phase });
      return { handled: true };
    }

    if (this.phase === 'confirm') return this.onConfirmSpeech(text, context);
    if (this.phase === 'clarifying') {
      if (isDraftCancel(text, 'confirm')) {
        await this.cancel(delegationId, 'phrase');
        return { handled: true };
      }
      const question = this.question ?? '';
      if (!this.destination) {
        // The answer may name a conversation only the compiler can resolve.
        this.destinationClarified = true;
        const target = matchDraftTarget(text, host.agents);
        if (target) {
          this.target = target;
          this.autoSend = true;
        }
      }
      this.clarifications.push({ question, answer: text });
      host.trace('draft.clarified', `answered “${clip(question, 80)}” → “${clip(text, 80)}”`, { question, answer: text });
      await this.compile(delegationId, { instruction: undefined });
      return { handled: true };
    }

    // listening: every GPT-Live delegation is answered with "still drafting" while the draft stays open.
    const draftId = this.draftId;
    const parts = this.fragments.length;
    const named = this.target;
    const outcome = await this.onListeningSpeech(text, context);
    // New dictation, or who it's for named after it ("that's for Sierra"): once they've been quiet a beat,
    // the end judge says whether that was the end (tick()).
    const renamed = this.target !== named && this.fragments.length > 0;
    if (this.phase === 'listening' && this.draftId === draftId && (this.fragments.length > parts || renamed)) this.endPending = this.fragments.length;
    if (this.phase === 'listening' && this.draftId === draftId && !outcome.answered) await this.stillDrafting(delegationId);
    return outcome;
  }

  /** "The Shed vents one or the Speaker one?": a pick that matched two conversations equally. */
  private async askWhich(items: [DraftItemRef, DraftItemRef], text: string, delegationId: string | null): Promise<void> {
    const host = this.host!;
    const [a, b] = pickLabels(items[0], items[1]);
    this.pendingPick = { items, at: this.now() };
    host.trace('draft.pick.tie', `“${clip(text, 60)}” matches two conversations: asking “The ${a} one or the ${b} one?”`, { items: items.map((item) => item.id) });
    await host.append('commentary', `[Ask only: "The ${a} one or the ${b} one?" Then delegate their answer.]`, delegationId);
  }

  /**
   * The owner tapped a conversation's card while voice is live: a draft for it is armed (empty,
   * listening; nothing is said). Its parked draft, if any, comes back. A draft for another
   * conversation is parked first; one being compiled or sent is left alone.
   */
  /**
   * A desk item is open on the screens: its conversation or its screen. `quiet` (a screen an agent's answer
   * brought up, mid-exchange) arms without the spoken refresher, and never takes over an open draft.
   */
  async armForItem(item: DraftItemRef, options: { quiet?: boolean; focus?: boolean } = {}): Promise<void> {
    const host = this.host;
    if (!host || !host.alive()) return;
    // Read or opened by voice ("what does Foxtrot have"): the owner is now in that conversation. A draft for
    // it, holding other updates like a pick, with no refresher (the read-back is the refresher). An open
    // draft with words is never taken over; an empty one moves here.
    if (options.focus) {
      // Already armed (quietly) for this item by a tap: it becomes a focus, holding updates (Codex review on #442).
      if (this.active && this.targetItem?.id === item.id) {
        if (this.armedByTap) {
          this.armedByTap = false;
          host.trace('draft.focus', `${item.agentName}${item.place ? ` · ${item.place}` : ''}: the armed draft is now a focus`, { itemId: item.id });
          this.publish({});
        }
        return;
      }
      if (this.active && (this.fragments.length > 0 || this.phase !== 'listening')) return;
      if (this.active) this.park('another conversation opened', { quiet: true });
      this.pendingPick = null;
      await this.start(undefined, '', null, 'read', item, false);
      return;
    }
    if (options.quiet && this.active) return;
    if (options.quiet) {
      this.pendingPick = null;
      await this.start(undefined, '', null, 'auto', item, false);
      return;
    }
    if (this.active) {
      if (this.targetItem?.id === item.id) return;
      if (this.phase !== 'listening') {
        host.trace('draft.arm.skipped', `tapped ${item.agentName}${item.place ? ` · ${item.place}` : ''} while the draft is ${this.phase}: left alone`, { itemId: item.id, phase: this.phase });
        return;
      }
      await this.switchTo(item, null, 'tap');
      return;
    }
    // A tap answers a pending "which one?" too.
    this.pendingPick = null;
    await this.start(undefined, '', null, 'tap', item, false);
  }

  /**
   * Next up: open this item and start a draft for it, as a pick by voice does (it opens, the refresher
   * plays, dictation targets it). An open draft is set aside first (parked with its conversation, or
   * closed when empty). False when it couldn't be: one being compiled or sent, or words for no conversation.
   */
  async openForNext(item: DraftItemRef, delegationId: string | null, note = ''): Promise<boolean> {
    const host = this.host;
    if (!host || !host.alive()) return false;
    if (this.active) {
      if (this.targetItem?.id === item.id && this.phase === 'listening') return true;
      if (this.phase !== 'listening' || !this.setAside('next one')) {
        host.trace('draft.arm.skipped', `next up: ${item.agentName}${item.place ? ` · ${item.place}` : ''} not opened, the draft is ${this.phase}${this.phase === 'listening' ? ' with words for no conversation' : ''}`, { itemId: item.id, phase: this.phase });
        return false;
      }
      await host.append('instructions', DRAFT_OFF_INSTRUCTIONS, null);
    }
    this.pendingPick = null;
    await this.start(undefined, '', delegationId, 'pick', item, false, note);
    return true;
  }

  /** The operator read the queue aloud ("what's next"): for the next two minutes "the second one" picks from it. */
  offer(items: DraftItemRef[]): void {
    this.offered = items.length ? { items, at: this.now() } : null;
  }

  /** The list offered in the last two minutes, if any. */
  private offeredItems(): DraftItemRef[] | null {
    const offered = this.offered;
    if (!offered) return null;
    if (this.now() - offered.at > 120_000) {
      this.offered = null;
      return null;
    }
    return offered.items;
  }

  /**
   * "Next one" / "what's next" while listening: the draft is set aside (parked with its conversation,
   * closed when empty) and the operator advances or lists. Words for no conversation can't be parked:
   * a list is spoken over the open draft, and an advance asks them to send or cancel it first.
   */
  private async leaveFor(op: NextOp, text: string, delegationId: string | null): Promise<DraftSpeechOutcome> {
    const host = this.host!;
    const current = this.targetItem;
    const words = this.fragments.length;
    host.trace('draft.next', `“${clip(text, 60)}” while drafting${current ? ` for ${current.agentName}${current.place ? ` · ${current.place}` : ''}` : ''} (${words} fragment${words === 1 ? '' : 's'}): ${op === 'advance' ? 'next one' : 'the list'}`, { op, itemId: current?.id ?? null, fragments: words });
    if (words > 0 && !current) {
      if (op === 'list' && host.next) {
        await host.next('list', { exclude: [], delegationId, board: false, note: 'The draft is still open (nothing was sent or added). ' });
        return { handled: true, answered: true };
      }
      await host.append('commentary', '[Nothing was added to the draft. It isn\'t for a conversation, so it can\'t be set aside: say only "Say \'I\'m done, next one\' to send it first, or \'cancel the draft\'." and keep listening.]', delegationId);
      return { handled: true, answered: true };
    }
    this.setAside(op === 'advance' ? 'next one' : "what's next");
    await host.append('instructions', DRAFT_OFF_INSTRUCTIONS, null);
    const note = words > 0 ? 'Their draft is saved with its conversation; say so in a few words first ("Saved your draft."). ' : '';
    if (host.next) await host.next(op, { exclude: op === 'advance' && current ? [current.id] : [], delegationId, ...(note ? { note } : {}) });
    else await host.append('commentary', '[Say nothing, or only "Okay."]', delegationId);
    return { handled: true, answered: true };
  }

  /** Parks the draft with its conversation, or closes it when it has no words. False when neither applies. */
  private setAside(why: string): boolean {
    if (this.park(why, { quiet: true })) return true;
    if (this.phase !== 'listening' || this.fragments.length > 0) return false;
    const host = this.host!;
    host.trace('draft.park', `empty draft closed (${why})`, { itemId: null, fragments: 0, why });
    const clears = this.card.id;
    this.reset();
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = null;
    this.card = blankCard(this.now());
    this.publisher?.(clears ? { ...this.card, clears } : this.card);
    return true;
  }

  /**
   * Another conversation picked mid-draft. This one is parked under its item; a draft with words but
   * no conversation yet is aimed at the one picked instead (its words belong there).
   */
  private async switchTo(item: DraftItemRef, delegationId: string | null, how: 'pick' | 'tap'): Promise<void> {
    const host = this.host!;
    const where = `${item.agentName}${item.place ? ` · ${item.place}` : ''}`;
    if (!this.targetItem && this.fragments.length > 0) {
      this.targetItem = item;
      if (item.isAgent) this.target = host.agents.find((candidate) => candidate.id === item.agentId) ?? this.target;
      host.trace('draft.target', `draft is for ${where} (${how})`, { targetItem: item.id, how });
      this.publish({});
      if (how === 'tap') return;
      host.showContext?.({ item, agent: this.target, reply: false });
      await host.append('commentary', `[Noted: the draft is for ${where}. Say only "Got it." and keep listening.]`, delegationId);
      return;
    }
    this.park(how === 'tap' ? 'tapped another conversation' : 'picked another conversation', { quiet: true });
    await this.start(undefined, '', delegationId, how, item, false);
  }

  /**
   * Leaves the draft for the board: kept under its desk item (when it has words) until that item is
   * reopened. Only a draft for a desk conversation, while listening. False when there was nothing to park.
   */
  private park(why: string, options: { quiet?: boolean } = {}): boolean {
    const host = this.host!;
    const item = this.targetItem;
    if (!item || this.phase !== 'listening') return false;
    const fragments = [...this.fragments];
    if (fragments.length) this.parked.set(item.id, { item, target: this.target, fragments, at: this.now(), ...(this.longForm ? { longForm: true } : {}) });
    else this.parked.delete(item.id);
    const where = `${item.agentName}${item.place ? ` · ${item.place}` : ''}`;
    host.trace('draft.park', fragments.length ? `draft for ${where} parked (${fragments.length} fragment${fragments.length === 1 ? '' : 's'}; ${why}): reopening it picks it back up` : `empty draft for ${where} closed (${why})`, { itemId: item.id, fragments: fragments.length, why });
    host.log('draft.park', { itemId: item.id, fragments: fragments.length, why });
    const clears = this.card.id;
    this.reset();
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = null;
    this.card = blankCard(this.now());
    this.publisher?.(clears ? { ...this.card, clears } : this.card);
    if (!options.quiet) void host.append('instructions', DRAFT_OFF_INSTRUCTIONS, null);
    return true;
  }

  /** The undo window: the send is called off and the draft is back to listening, every word kept. */
  private async undo(delegationId: string | null, how: 'voice' | 'screen', addition = ''): Promise<void> {
    const host = this.host!;
    if (this.phase !== 'holding') return;
    if (this.undoTimer) clearTimeout(this.undoTimer);
    this.undoTimer = null;
    this.undoUntil = null;
    this.phase = 'listening';
    this.compiled = null;
    this.destination = null;
    this.lastSpeechAt = this.now();
    // The advance (or list) said with the closer goes with the send it was waiting on.
    const calledOff = this.afterSend;
    this.afterSend = null;
    if (calledOff) host.trace('next.cancelled', `send undone: the ${calledOff === 'advance' ? 'advance to the next one' : 'list'} is called off too`, { op: calledOff });
    host.trace('draft.undo', `send undone (${how}) before it went: back to listening with ${this.fragments.length} fragment${this.fragments.length === 1 ? '' : 's'}${addition ? `, adding “${clip(addition, 80)}”` : ''}`, { how, fragments: this.fragments.length, addition: addition ? clip(addition, 200) : null });
    host.log('draft.undo', { how, added: !!addition });
    const judged = this.endedByJudge;
    this.endedByJudge = false;
    // What came after "wait, …" is more of the message.
    if (addition && wordCount(normalizeSpeech(addition)) >= 1) {
      this.addFragment(addition);
      // Kept talking after a judged end: judged again at their next pause.
      if (judged) this.endPending = this.fragments.length;
    } else this.publish({});
    await this.tell(
      host,
      'commentary',
      addition ? '[Not sent: the draft is still open, and what they just said was added. Say nothing, or only "Sure." and keep listening.]' : '[Not sent: the draft is still open with everything they said. Say only "Okay, not sent." and keep listening.]',
      delegationId,
    );
    this.replayQueued();
  }

  private async onListeningSpeech(text: string, context: DraftSpeechContext): Promise<DraftSpeechOutcome> {
    const host = this.host!;
    this.heardAt = this.now();
    const { delegationId } = context;
    // "Yankee, …": said to the operator. Its commands work as usual; anything else is a question, never dictation.
    // Noise ahead of the name ("[sniff] Yankee, …", "Mm Yankee, …") doesn't hide who it was said to.
    const addressed = addressedToOperator(stripAsrNoise(text));
    const said = addressed ?? text;
    if (isDraftCancel(said, 'listening')) {
      await this.cancel(delegationId, 'phrase');
      return { handled: true };
    }
    if (isDraftHold(said)) {
      // They want to take their time: from here only a closer sends it.
      this.longForm = true;
      this.endPending = null;
      host.trace('draft.hold', `“${clip(text, 60)}”: still holding the draft; only a closer sends it now`, {});
      return { handled: true };
    }
    if (!this.longForm && addressed === null && opensLong(said)) {
      // "I'm going to think out loud here, so…": dictation, but they've said it'll take a while (an aside to the operator isn't).
      this.longForm = true;
      this.endPending = null;
      host.trace('draft.hold', `“${clip(text, 60)}” opens long: only a closer sends it now`, {});
    }
    // A destination sentence can precede dictation in the same utterance.
    const first = said.match(/^.*?[.!?](?:\s|$)/)?.[0].trim();
    // Explicit send-to-agent phrases are closers, not destination-only updates.
    const destinationOnly = (speech: string) => matchDraftFinish(speech, host.agents)
      ? undefined : matchDraftTarget(speech, host.agents);
    const target = destinationOnly(said) ?? (first ? destinationOnly(first) : undefined);
    if (target) {
      this.setTarget(target, delegationId);
      const rest = first ? said.slice(first.length).trim() : '';
      if (rest) return this.onListeningSpeech(rest, context);
      return { handled: true };
    }
    // "Next one" / "what's next" on their own. Bare "next" only when addressed or nothing is drafted yet;
    // "what's next" with words drafted and not addressed is dictation (a fair question to put to an agent).
    const nextOp = matchNextCommand(said, { bare: addressed !== null || this.fragments.length === 0 });
    if (nextOp && (nextOp === 'advance' || addressed !== null || this.fragments.length === 0)) return this.leaveFor(nextOp, text, delegationId);
    // "I'm done, next one", "send it and go to the next one", "send it, what's next": a finish, then that once it's sent.
    // "Yankee, over": the name is part of the sign-off, so addressed speech is checked whole too. Said to the
    // operator, the sign-off only closes: "Yankee, what did Sierra say? Yankee, over" is an aside, not dictation
    // (an ordinary closer still carries its content: "Yankee, tell Sierra that Yankee is ready. Send it.").
    const finishOf = (speech: string) => {
      const found = matchDraftFinish(speech, host.agents);
      return found && !(addressed !== null && found.content && found.signoff) ? found : null;
    };
    let cue = splitNextCue(said);
    let closer = cue ? finishOf(cue.rest) : null;
    if (cue && !closer && addressed !== null) {
      // "Yankee, over, next one": the bare "over" left after the name isn't a closer; the whole utterance is.
      const whole = splitNextCue(text);
      const wholeCloser = whole ? finishOf(whole.rest) : null;
      if (whole && wholeCloser) [cue, closer] = [whole, wholeCloser];
    }
    if (cue && closer) {
      if (closer.content) this.addFragment(closer.content);
      if (closer.agent) this.target = closer.agent;
      if (this.fragments.length === 0) return this.leaveFor(cue.op, text, delegationId);
      this.afterSend = cue.op;
      host.trace('draft.after', `“${clip(text, 60)}”: finishing, then ${cue.op === 'advance' ? 'the next one' : 'the list'} once it's sent`, { op: cue.op });
      await this.finish(delegationId);
      return { handled: true };
    }
    const finish = finishOf(said) ?? (addressed !== null ? finishOf(text) : null);
    if (finish) {
      if (finish.content) this.addFragment(finish.content);
      if (finish.agent) this.target = finish.agent;
      if (this.fragments.length === 0 && this.targetItem && !finish.agent) {
        // A conversation picked (or tapped) and nothing dictated: "I'm done" is about the conversation, not a message.
        this.park('finished with nothing said', { quiet: true });
        await host.append('instructions', DRAFT_OFF_INSTRUCTIONS, null);
        return { handled: false };
      }
      await this.finish(delegationId);
      return { handled: true };
    }
    const screenCommand = async (actions: OperatorAction[], how: string, answered: boolean): Promise<DraftSpeechOutcome> => {
      host.trace('draft.meta', `screen command while drafting (${how}): ${actions.map((action) => (action.type === 'screen' ? action.op : action.type)).join(', ')}`, {});
      // "Back to the board": a draft for a conversation is parked under it and the board comes up.
      if (actions.some((action) => action.type === 'screen' && action.op === 'board') && this.targetItem) {
        const words = this.fragments.length;
        this.park('back to the board', { quiet: true });
        await host.append('instructions', DRAFT_OFF_INSTRUCTIONS, null);
        await host.append('commentary', words ? '[The draft is saved with its conversation; reopening it picks it back up. Say only "Saved it." or nothing.]' : '[Say nothing, or only "Okay."]', delegationId);
        return { handled: true, actions, answered: true };
      }
      return { handled: true, actions, ...(answered ? { answered: true } : {}) };
    };
    const quick = context.quick?.(said);
    // The screen shows it happen: no "still drafting" murmur after a scroll or a click.
    if (quick && quick.length && quick.every((action) => action.type === 'screen')) return screenCommand(quick, 'quick', true);
    // The Prototype view takes commands in any words ("cool, can you click the skip button for me"): the
    // router model, which sees the page, says whether this is one. The screen shows it happen: nothing to say.
    if (context.screenRoute) {
      const routed = await context.screenRoute(said);
      if (routed && routed.length && routed.every((action) => action.type === 'screen')) return screenCommand(routed, 'router', true);
    }
    // Nothing said yet for a conversation just picked: a desk command ("mark it done", "snooze it") is that, not dictation.
    if (quick && quick.length && this.fragments.length === 0 && this.targetItem && quick.every((action) => action.type === 'desk' || action.type === 'remind')) {
      host.trace('draft.meta', `desk command on a draft with nothing in it: ${quick.map((action) => (action.type === 'desk' ? action.op : action.type)).join(', ')}; the draft closes`, {});
      this.park('desk command', { quiet: true });
      await host.append('instructions', DRAFT_OFF_INSTRUCTIONS, null);
      return { handled: true, actions: quick };
    }
    // "Read it all": the conversation's latest reply, aloud and in full; nothing is added to the draft.
    if (this.targetItem && host.brief && isReadAll(said)) {
      const item = this.targetItem;
      const draftId = this.draftId;
      const brief = await host.brief(item.id).catch(() => null);
      // The owner may have left or switched conversations while the desk answered: read nothing then.
      if (this.draftId !== draftId || this.targetItem?.id !== item.id) return { handled: true, answered: true };
      host.trace('draft.read', `reading ${item.agentName}'s latest reply in full`, { itemId: item.id, found: !!brief?.full });
      await host.append(
        'commentary',
        brief?.full
          ? `[Read the latest reply in this conversation aloud, close to word for word (skip links and formatting marks), then listen; nothing is added to the draft: "${brief.full}"]`
          : "[There's no reply to read in this conversation yet. Say so in a few words and keep listening.]",
        delegationId,
      );
      return { handled: true, answered: true };
    }
    // "The third one" from the list just read, before anything is dictated (or said to the operator).
    const offered = this.fragments.length === 0 || addressed !== null ? this.offeredItems() : null;
    const fromList = offered ? chooseFromList(said, offered) : null;
    if (fromList && fromList.id !== this.targetItem?.id) {
      host.trace('draft.pick', `“${clip(text, 60)}” picks ${fromList.agentName}${fromList.place ? ` · ${fromList.place}` : ''} from the list just read`, { itemId: fromList.id, after: 'list' });
      await this.switchTo(fromList, delegationId, 'pick');
      return { handled: true, answered: true };
    }
    // "Let's talk about the speaker thread" mid-draft: this one is parked (or aimed there) and that one opens.
    const pick = matchTopicPick(said, host.deskTargets?.() ?? [], { drafting: addressed === null, screen: host.pickScreen?.() ?? null });
    if (pick?.kind === 'match' && pick.item.id !== this.targetItem?.id) {
      host.trace('draft.pick', `“${clip(text, 60)}” picks ${pick.item.agentName}${pick.item.place ? ` · ${pick.item.place}` : ''} mid-draft (score ${pick.score.toFixed(2)})`, { itemId: pick.item.id, score: pick.score });
      await this.switchTo(pick.item, delegationId, 'pick');
      return { handled: true, answered: true };
    }
    if (addressed !== null) {
      // A question to the operator mid-draft: answered aloud, never added to the message.
      host.trace('draft.aside', `“${clip(text, 80)}” was said to the operator: answered, not added to the draft`, { text: clip(text, 200) });
      await host.append('commentary', `[That was said to you, not part of the draft (nothing was added): "${clip(said, 200)}". Answer it briefly from what you know, then keep listening. Don't send anything.]`, delegationId);
      return { handled: true, answered: true };
    }
    if (mightEndDraft(text)) {
      const routed = await host.route(text).catch(() => [] as OperatorAction[]);
      const draft = routed.find((action): action is DraftAction => action.type === 'draft');
      if (draft?.op === 'finish') {
        host.trace('draft.finish.model', `router read “${clip(text, 60)}” as finish`, { speech: text });
        // Dictation run together with the cue is the last fragment; a next-up cue after it runs once it's sent.
        const cue = splitNextCue(text);
        const content = draft.message?.trim() || contentBeforeFinish(cue?.rest ?? text);
        if (content) this.addFragment(content);
        if (cue && this.fragments.length > 0) this.afterSend = cue.op;
        if (draft.agentId) {
          const agent = host.agents.find((candidate) => candidate.id === draft.agentId);
          if (agent) this.target = agent;
        }
        await this.finish(delegationId);
        return { handled: true };
      }
      if (draft?.op === 'cancel') {
        await this.cancel(delegationId, 'model');
        return { handled: true };
      }
    }
    // Only filler before anything is dictated ("Hmm", "Mm-hmm", often said before the draft even opened):
    // not the start of a message. Kept, it made a quiet draft a real one, holding the agent's answer.
    if (this.fragments.length === 0 && isFillerOnly(text)) {
      host.trace('draft.filler', `“${clip(text, 60)}”: filler only, nothing added`, {});
      return { handled: true, answered: true };
    }
    this.addFragment(text);
    return { handled: true };
  }

  /**
   * No closer said: the model judges whether the owner finished a thought at this pause. Done, and still
   * quiet with nothing new said: the draft finishes as if they'd said "I'm done" (undo window as usual).
   */
  private async judgeEnd(silentMs?: number): Promise<void> {
    const host = this.host;
    const parts = silentMs ? this.fragments.length : this.endPending;
    this.endPending = null;
    // Nothing that counts changed since the last verdict (only filler was added): that verdict stands, second look and all.
    if (!silentMs && this.endKey() === this.judgedKey) return;
    this.relookKey = null;
    this.judgedKey = this.endKey();
    const judge = this.options.judgeEnd;
    if (!host || !judge || parts === null || parts !== this.fragments.length || this.longForm) return;
    // Only where it would send without asking (the owner named who it's for); a sentence left hanging waits for a long quiet.
    if (!this.target && !this.targetItem) return;
    // Filler pieces ("Mm" after a pause) say nothing: the last piece with words in it is what's judged.
    const last = [...this.fragments].reverse().find((fragment) => meaningfulWords(fragment).length > 0);
    if (!last) return;
    // Trailing off ("…will this be… uh") waits, but not forever: if the quiet goes on, the judge takes the second look.
    if (!silentMs && looksUnfinished(last)) {
      host.trace('draft.end.wait', `“${clip(last, 60)}” trails off: still listening`, {});
      this.relookKey = this.endKey();
      return;
    }
    const draftId = this.draftId;
    const key = this.endKey();
    const seen = this.speechSeen;
    const destination = this.targetItem ? `${this.targetItem.agentName}${this.targetItem.place ? ` · ${this.targetItem.place}` : ''}` : this.target!.name;
    this.judging = true;
    const started = this.now();
    let verdict: { done: boolean; reason: string } | null = null;
    try {
      const context = await withTimeout(host.context(), 5000).catch(() => null);
      verdict = await withTimeout(judge({ fragments: [...this.fragments], destination, transcript: context?.input.transcript ?? [], ...(silentMs ? { silentMs } : {}) }), 8000);
    } catch (error) {
      host.log('draft.end.error', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.judging = false;
    }
    if (!verdict) return;
    const ms = this.now() - started;
    // Anything said meanwhile (or the draft moved on) outranks the verdict: that speech is judged on its own pause.
    const still = this.host === host && this.draftId === draftId && this.phase === 'listening' && this.endKey() === key && this.speechSeen === seen && !this.longForm && !host.paused?.();
    const quiet = !host.hasFreshSpeech() && host.userQuietMs() >= (this.options.endQuietMs ?? 1200);
    // Only the voice connection changed (a reconnect mid-call): judged again on the new one.
    if (this.host !== host && this.draftId === draftId && this.phase === 'listening' && this.endKey() === key) this.judgedKey = null;
    const look = silentMs ? `second look after ${Math.round(silentMs / 1000)} s quiet, ` : '';
    if (!verdict.done || !still || !quiet) {
      host.trace('draft.end.wait', `end judge (${look}${ms} ms): ${verdict.done ? (still && !quiet ? 'done, but they kept talking' : 'done, but the draft moved on') : 'not done'}${verdict.reason ? ` (${clip(verdict.reason, 80)})` : ''}: still listening`, { done: verdict.done, reason: verdict.reason, ms, ...(silentMs ? { silentMs } : {}) });
      // A first "not done" that still stands: if the quiet goes on, one second look.
      if (!verdict.done && still && !silentMs) this.relookKey = key;
      return;
    }
    host.trace('draft.end.model', `end judge (${look}${ms} ms): done${verdict.reason ? ` (${clip(verdict.reason, 80)})` : ''}: finishing without a closer`, { reason: verdict.reason, ms, fragments: parts, ...(silentMs ? { silentMs } : {}) });
    this.endedByJudge = true;
    await this.finish(null);
  }

  /** The start says it will be long ("a long message for", "let me think out loud"): only a closer ends that draft. */
  private markLongStart(speech: string, rest = ''): void {
    // Only the start itself counts, not the message said with it ("…: the endpoint has a long response time").
    const said = normalizeSpeech(speech);
    const content = normalizeSpeech(rest);
    const at = content ? said.lastIndexOf(content) : -1;
    const intent = at > 0 ? said.slice(0, at) : said;
    this.startsLong = !!intent && (LONG_START.test(intent) || opensRamble(intent));
    if (this.startsLong) this.host?.trace('draft.long', `“${clip(speech, 60)}” says it's a long one: only a closer sends it`, {});
  }

  /** The pieces with words in them, and where it goes: what a verdict depends on. */
  private endKey(): string {
    return `${this.fragments.filter((fragment) => meaningfulWords(fragment).length > 0).length}|${this.target?.id ?? ''}|${this.targetItem?.id ?? ''}`;
  }

  /** A GPT-Live delegation while drafting gets an answer that keeps it in draft behavior. */
  private async stillDrafting(delegationId: string | null): Promise<void> {
    if (delegationId === null || !this.host) return;
    await this.host.append('instructions', DRAFT_STILL_INSTRUCTIONS, delegationId);
  }

  private async onConfirmSpeech(text: string, context: DraftSpeechContext): Promise<DraftSpeechOutcome> {
    const host = this.host!;
    const { delegationId } = context;
    if (isDraftCancel(text, 'confirm')) {
      await this.cancel(delegationId, 'phrase');
      return { handled: true };
    }
    if (isPlainYes(text)) {
      await this.send(delegationId, 'voice');
      return { handled: true };
    }
    // "Yes, next one", "send it, what's next".
    const cue = splitNextCue(text);
    if (cue && isPlainYes(cue.rest)) {
      this.afterSend = cue.op;
      host.trace('draft.after', `“${clip(text, 60)}”: sending, then ${cue.op === 'advance' ? 'the next one' : 'the list'}`, { op: cue.op });
      await this.send(delegationId, 'voice');
      return { handled: true };
    }
    const normalized = normalizeSpeech(text);
    if (/^(?:no|nope|nah|not quite|hmm)$/.test(normalized)) {
      await host.append('commentary', '[Ask only: "What should I change?"]', delegationId);
      return { handled: true };
    }
    if (MORE.test(normalized)) {
      // Back to collecting; the next finish compiles again from every fragment.
      this.phase = 'listening';
      this.compiled = null;
      this.destination = null;
      host.trace('draft.reopen', `“${clip(text, 60)}”: back to listening`, {});
      const rest = text.replace(/^[^,.;]*(?:hold on|hang on|wait|not yet|one more (?:thing|point)|there'?s more|let me add)[,.;:]?\s*/i, '').trim();
      if (rest && wordCount(normalizeSpeech(rest)) >= 2 && !MORE.test(normalizeSpeech(rest))) this.addFragment(rest);
      else this.publish({});
      await host.append('instructions', '[The user is adding more to the draft. Say only "Sure, go ahead." and listen.]', delegationId);
      return { handled: true };
    }
    const quick = context.quick?.(text);
    if (quick && quick.length && quick.every((action) => action.type === 'screen')) return { handled: true, actions: quick };
    // An edit or a redirect: compile again with the change.
    await this.compile(delegationId, { instruction: text });
    return { handled: true };
  }

  /** A tap on the Draft card's Send / Cancel. */
  async onScreenCommand(command: DraftScreenCommand): Promise<void> {
    const host = this.host;
    if (!host) return;
    if (!command.draftId || command.draftId !== this.draftId) {
      host.trace('draft.screen.stale', `screen tapped ${command.action} on a draft card that is no longer current: ignored`, { action: command.action, draftId: command.draftId ?? null, current: this.draftId });
      return;
    }
    host.trace('draft.screen', `screen tapped ${command.action} on the draft card (${this.phase})`, { action: command.action, commandId: command.commandId ?? null, phase: this.phase });
    // Cancel during the undo window undoes the send (the draft stays, listening); a draft on its way can't be called back.
    if (command.action === 'cancel' && this.phase === 'holding') await this.undo(null, 'screen');
    else if (command.action === 'cancel' && this.active && this.phase !== 'sending') await this.cancel(null, 'screen');
    else if (command.action === 'send' && (this.phase === 'confirm' || this.phase === 'holding')) await this.send(null, 'screen');
  }

  /**
   * Safety net, outside draft mode: a send (dispatch / reply) whose words sound unfinished is held
   * and the operator asks "Is that everything?". True when held (the caller sends nothing now).
   */
  async holdIfUnfinished(speech: string, actions: OperatorAction[], delegationId: string | null, handles: unknown): Promise<boolean> {
    const host = this.host;
    if (!host || this.active) return false;
    const sends = actions.filter((action) => action.type === 'dispatch' || action.type === 'reply' || (action.type === 'desk' && (action.op === 'reply' || action.op === 'answer' || action.op === 'respond' || action.op === 'approve')));
    if (sends.length === 0) return false;
    const flagged = actions.some((action) => action.type === 'draft' && action.op === 'unfinished');
    const dispatch = sends.every((action) => action.type === 'dispatch');
    const newWork = sends.some((action) => action.type === 'dispatch');
    const names = host.agents.flatMap((agent) => [agent.name, ...(agent.aliases ?? [])]);
    const unfinished = looksUnfinished(speech, { flagged, dispatch, newWork, names });
    getDecisionShadow().run({ site: 'operator.unfinished', prompt: unfinishedDecisionPrompt(speech), incumbent: { unfinished }, excerpt: speech, meta: { session: host.traceSessionId ?? null } });
    if (!unfinished) return false;
    const kept = actions.filter((action) => action.type !== 'draft');
    this.held = { actions: kept, handles, speech, at: this.now() };
    host.trace('safety.hold', `held ${kept.map((action) => action.type).join(', ')}: “${clip(speech, 100)}” sounds unfinished${flagged ? ' (router flagged it)' : ''}; asking “Is that everything?”`, { speech: clip(speech, 200), flagged, actions: kept });
    host.log('safety.hold', { speech, flagged });
    await host.append('commentary', '[Nothing was sent yet: that sounded unfinished. Ask only: "Is that everything?" Then delegate their answer.]', delegationId);
    return true;
  }

  /** Before applying routed actions: a draft start wins over sends in the same breath; `unfinished` is only a flag. */
  filterActions(actions: OperatorAction[]): OperatorAction[] {
    const deferred = this.deferredStart;
    this.deferredStart = null;
    if (deferred && !this.active && this.now() - deferred.at < 60_000 && !actions.some((action) => action.type === 'draft' && action.op === 'start')) {
      // The router read it as something else (an open, a reply): the phrase said draft, so it is one, without a target.
      this.host?.trace('draft.start.fallback', `router returned ${actions.map((action) => action.type).join(', ') || 'nothing'}: starting the draft from the phrase`, {});
      return [{ type: 'draft', op: 'start', message: '' }];
    }
    const starts = actions.some((action) => action.type === 'draft' && action.op === 'start');
    const kept = actions.filter((action) => !(action.type === 'draft' && action.op === 'unfinished') && (!starts || action.type === 'draft' || action.type === 'screen'));
    return kept.length ? kept : [{ type: 'none', reason: 'nothing to do' }];
  }

  /**
   * The voice session is over. An unsent draft is kept on the card (and in the trace) for a
   * while so its words aren't lost, and the operator says so if it still can; then it clears.
   */
  end(): void {
    const host = this.host;
    const unsent = this.active && (this.fragments.length > 0 || this.compiled);
    const wasSending = this.phase === 'sending';
    this.epoch += 1;
    if (this.undoTimer) clearTimeout(this.undoTimer);
    this.undoTimer = null;
    this.undoUntil = null;
    this.pendingPick = null;
    this.offered = null;
    if (this.parked.size) {
      for (const parked of this.parked.values()) host?.trace('draft.unsent', `voice session ended with a parked draft for ${parked.item.agentName}${parked.item.place ? ` · ${parked.item.place}` : ''}: “${clip(parked.fragments.join(' '), 160)}”`, { text: parked.fragments.join(' '), targetItem: parked.item.id, parked: true });
      this.parked.clear();
    }
    this.held = null;
    this.queued = [];
    this.unsaid = [];
    if (unsent) {
      const text = this.compiled ?? this.fragments.join(' ');
      host?.trace('draft.unsent', `voice session ended with an unsent draft${this.target ? ` for ${this.target.name}` : ''}: “${clip(text, 160)}”`, { text, target: this.target?.id ?? null, fragments: this.fragments.length });
      this.log('draft.unsent', { text, target: this.target?.id ?? null });
      if (host?.alive()) void host.append('commentary', `[Tell the user briefly: they had an unsent draft${this.target ? ` for ${this.target.name}` : ''}; it was not sent, and it stays on the screen for a few minutes.]`, null);
      this.phase = 'idle';
      this.publish({ active: false, status: 'cancelled', note: wasSending ? 'The voice session ended while this was sending: check the conversation before resending' : 'Not sent: the voice session ended' });
      this.scheduleClear(this.options.unsentKeepMs ?? 10 * 60_000);
    } else if (this.active) {
      this.reset();
      this.publish({});
    }
    if (host) this.detach(host);
  }

  // ── transitions ────────────────────────────────────────────────────────

  /**
   * how: phrase / model (a start phrase or the router), pick (a conversation named to work on), tap
   * (its card tapped: the screen already shows it, and nothing is said).
   */
  private async start(agent: AgentDescriptor | undefined, rest: string, delegationId: string | null, how: 'phrase' | 'model' | 'pick' | 'tap' | 'auto' | 'read', item: DraftItemRef | null = null, reply = false, note = '', newLoom = false, newThread = false): Promise<void> {
    const long = this.startsLong;
    this.startsLong = false;
    const host = this.host;
    if (!host) return;
    this.reset();
    // Set before anything awaits, so the first fragment is never judged ("a long message for Sierra: first, …").
    this.longForm = long;
    this.newLoom = newLoom && !agent && !item;
    this.newThread = newThread && !agent && !item;
    this.startSpeech = this.newLoom || this.newThread ? this.startingSpeech || this.lastSpeech : '';
    this.startingSpeech = '';
    this.pendingPick = null;
    this.phase = 'listening';
    this.armedByTap = how === 'tap' || how === 'auto';
    this.draftId = randomUUID();
    this.targetItem = item;
    this.target = agent ?? (item?.isAgent ? (host.agents.find((candidate) => candidate.id === item.agentId) ?? null) : null);
    this.lastSpeechAt = this.now();
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = null;
    const forWhat = item ? `${item.agentName}${item.place ? ` · ${item.place}` : ''}` : (agent?.name ?? (this.newLoom ? 'a new coding thread' : this.newThread ? 'a new thread' : undefined));
    // A draft parked for this conversation comes back with every word.
    const parked = item ? this.takeParked(item.id) : null;
    if (parked) {
      this.fragments = [...parked.fragments];
      if (!agent && parked.target) this.target = parked.target;
      if (parked.longForm) this.longForm = true;
      // Reopening isn't finishing: the saved words wait for new speech (or a new destination) before any judgment.
      this.judgedKey = this.endKey();
    }
    const source = { phrase: 'phrase', model: 'router', pick: 'picked by voice', tap: 'card tapped', auto: 'its screen came up with the answer', read: 'read or opened by voice' }[how];
    host.trace('draft.start', `draft mode on${forWhat ? ` for ${forWhat}` : ''} (${source})${parked ? `, resuming ${parked.fragments.length} parked fragment${parked.fragments.length === 1 ? '' : 's'}` : ''}`, { how, target: agent?.id ?? item?.agentId ?? null, targetItem: item?.id ?? null, resumed: parked?.fragments.length ?? 0 });
    host.log('draft.start', { how, target: agent?.id ?? null, targetItem: item?.id ?? null, resumed: parked?.fragments.length ?? 0 });
    if (rest) {
      this.addFragment(rest);
      // Judged once startup is done (below), not while it is still being announced.
      this.judgedKey = this.endKey();
    }
    else this.publish({});
    // What it answers goes up behind the Draft banner: a named conversation, or the agent's latest when replying.
    // A tapped card is already on the screens.
    if (how !== 'tap' && how !== 'auto' && how !== 'read' && (item || (reply && this.target))) host.showContext?.({ item, agent: this.target, reply });
    await host.append('instructions', DRAFT_ON_INSTRUCTIONS, null);
    // Opening a conversation (by voice or a tap) is a moment to catch up: a short spoken refresher first.
    // Also a named conversation opened by a draft phrase or the router, unless the owner already started dictating.
    const startedId = this.draftId;
    const wordsBefore = this.fragments.length;
    // Not for a screen an answer just brought up: the owner just heard that answer.
    const brief = item && how !== 'auto' && how !== 'read' && (how === 'pick' || how === 'tap' || !rest) && host.brief ? await host.brief(item.id).catch(() => null) : null;
    // Only for the same draft, still on that conversation, and before the owner has started talking.
    if (brief && this.draftId === startedId && this.targetItem?.id === item!.id && this.fragments.length === wordsBefore && !host.hasFreshSpeech?.()) {
      host.trace('draft.brief', `refresher for ${forWhat}: “${clip(brief.brief, 100)}”`, { itemId: item!.id });
      const lead = parked ? ` The user's draft for it is back on the screen (${parked.fragments.length} part${parked.fragments.length === 1 ? '' : 's'} so far).` : '';
      await host.append(
        'commentary',
        `[${note}${forWhat} is open and the user is drafting a reply to it.${lead} Start straight with a quick spoken refresher (no "go ahead" or "I'm listening" before it), in your own words and in two or three short sentences: ${brief.brief} Then say only "${parked ? 'Picking up where you left off.' : 'Go ahead.'}" and listen. Anything they say next is their reply, unless they ask you something. If they want the whole message, they'll say "read it all".]`,
        delegationId,
      );
      return;
    }
    // "A message for Sierra: the patio needs another coat": the whole message may be in the start.
    const armStart = () => {
      if (rest && !this.longForm && this.draftId === startedId && this.phase === 'listening') {
        this.judgedKey = null;
        this.endPending = this.fragments.length;
      }
    };
    if (how === 'tap' || how === 'auto' || how === 'read') return armStart();
    const say = parked
      ? `Picked the draft for ${forWhat} back up (${parked.fragments.length} part${parked.fragments.length === 1 ? '' : 's'} so far, on the screen). Say only "Picking up where you left off." Then just listen.`
      : this.newLoom || this.newThread
        ? this.fragments.length
          ? `Draft mode is on for ${forWhat}, and the task is in. Say only: "Got it. Anything else for it?" Then just listen.`
          : `Draft mode is on for ${forWhat}. Say only: "${this.newLoom ? 'New Loom thread' : 'New thread'}. What should it work on?" Then just listen.`
        : how === 'pick'
        ? `Draft mode is on for ${forWhat}, and it is on the screen. Say only a few words, like "Okay, go ahead." Then just listen.`
        : `Draft mode is on${forWhat ? ` for ${forWhat}` : ''}. Say only a few words, like "Go ahead, I'm listening. Take your time." Then just listen.`;
    await host.append('commentary', `[${note}${say}]`, delegationId);
    armStart();
  }

  /** A parked draft for this item, removed from the shelf (null once it is older than parkedKeepMs). */
  private takeParked(itemId: string): ParkedDraft | null {
    const parked = this.parked.get(itemId) ?? null;
    this.parked.delete(itemId);
    if (!parked || this.now() - parked.at > (this.options.parkedKeepMs ?? 12 * 3_600_000)) return null;
    return parked;
  }

  private setTarget(agent: AgentDescriptor, delegationId: string | null): void {
    const host = this.host!;
    this.target = agent;
    if (this.targetItem && this.targetItem.agentId !== agent.id) this.targetItem = null;
    host.trace('draft.target', `draft is for ${agent.name}`, { target: agent.id });
    this.publish({});
    void host.append('commentary', `[Noted: the draft is for ${agent.name}. Say only "Got it." and keep listening.]`, delegationId);
  }

  private addFragment(text: string): void {
    const host = this.host;
    const fresh = trimOverlap(this.fragments.join(' '), text);
    if (!fresh) {
      host?.trace('draft.append', 'repeated words only: nothing new added', { text: clip(text, 120) });
      return;
    }
    this.fragments.push(fresh);
    host?.trace('draft.append', `+ “${clip(fresh, 120)}” (${this.fragments.length} fragment${this.fragments.length === 1 ? '' : 's'})`, { text: clip(fresh, 300), fragments: this.fragments.length });
    this.publish({});
  }

  private async finish(delegationId: string | null): Promise<void> {
    const host = this.host!;
    if (this.fragments.length === 0) {
      host.trace('draft.empty', 'finish with nothing said: still listening', {});
      await host.append('commentary', '[The draft is empty so far. Say only "I haven\'t got anything yet. Go ahead." and listen.]', delegationId);
      return;
    }
    this.endPending = null;
    // Named before finishing (an agent, or a conversation picked / tapped): no question unless the compile needs one.
    this.autoSend = !!(this.target || this.targetItem);
    await this.compile(delegationId, {});
  }

  /** The compile's destination is where the owner already said this goes (so it needs no confirmation). */
  private destinationAgrees(destination: DraftDestination): boolean {
    const item = this.targetItem;
    if (item) return this.usedNamed || destination.itemId === item.id || (!!item.threadId && destination.threadId === item.threadId);
    return !!this.target && destination.kind === 'home' && persona(destination.agentId) === persona(this.target.id);
  }

  /**
   * Nothing to ask: the send goes out after the undo window (status `sending` with `undoUntil`), unless
   * "undo" / "wait" / a Cancel tap arrives first, which puts the draft back to listening.
   */
  private async holdToSend(origin: DraftHost, delegationId: string | null, ms: number): Promise<void> {
    this.phase = 'holding';
    this.question = null;
    this.undoUntil = this.now() + ms;
    this.publish({});
    this.scheduleHeldSend(ms);
    await this.tell(origin, 'instructions', '[The draft is compiled and on the screen; it goes out in a few seconds unless the user says "undo" or "wait". Say nothing now: don\'t read it out and don\'t ask anything.]', delegationId);
  }

  /**
   * The undo window's timer. When it runs out with no operator attached (the voice connection
   * dropped mid-window), the send is left due and goes out as soon as the next operator attaches.
   */
  private scheduleHeldSend(ms: number, deferredSince: number | null = null): void {
    const draftId = this.draftId;
    const epoch = this.epoch;
    if (this.undoTimer) clearTimeout(this.undoTimer);
    this.undoTimer = setTimeout(() => {
      this.undoTimer = null;
      if (this.phase !== 'holding' || this.draftId !== draftId || this.epoch !== epoch) return;
      const host = this.host;
      if (!host) {
        this.log('draft.send.due', { draftId, reason: 'no voice connection when the undo window ran out' });
        return; // attach() sends it
      }
      // Paused ("Yankee, pause"): the send waits for the pause to end, however long.
      if (host.paused?.()) {
        this.scheduleHeldSend(UNDO_DEFER_STEP_MS, deferredSince);
        return;
      }
      // The owner is talking, or said something not read yet: that may be a late "wait…". It is read
      // first (an undo returns to listening; anything else is held and the send goes), for at most 10 s more.
      const since = deferredSince ?? this.now();
      const speaking = host.userQuietMs() < UNDO_SPEECH_QUIET_MS;
      const unread = host.hasFreshSpeech();
      if ((speaking || unread) && this.now() - since < (this.options.undoDeferMaxMs ?? 10_000)) {
        if (deferredSince === null) host.trace('draft.hold.deferred', `undo window over but the owner is ${speaking ? 'speaking' : 'not yet heard out'}: reading that first`, { speaking, unread });
        if (unread && !speaking) host.collect();
        this.scheduleHeldSend(UNDO_DEFER_STEP_MS, since);
        return;
      }
      void this.send(null, 'auto');
    }, Math.max(0, ms));
    this.undoTimer.unref?.();
  }

  /** One model call: the clean message and its destination (or a question). */
  private async compile(delegationId: string | null, change: { instruction?: string }): Promise<void> {
    const host = this.host!;
    const previous = this.compiled ? { message: this.compiled, destination: this.destination ? spokenDestination(this.destination) : null } : undefined;
    const before = this.destination;
    this.phase = 'compiling';
    this.note = null;
    this.publish({});
    const started = this.now();
    host.trace(change.instruction ? 'draft.edit' : 'draft.compile', change.instruction ? `changing the draft: “${clip(change.instruction, 100)}”` : `compiling ${this.fragments.length} fragment${this.fragments.length === 1 ? '' : 's'}`, {
      fragments: this.fragments.length,
      instruction: change.instruction ?? null,
    });
    const epoch = this.epoch;
    const context = await host.context();
    let result: DraftCompileResult | null = null;
    if (this.options.compile) {
      try {
        result = await withTimeout(
          this.options.compile({
            ...context.input,
            fragments: this.fragments,
            target: this.target ? { agentId: this.target.id, name: this.target.name } : null,
            ...(this.newLoom ? { newLoom: true } : {}),
            ...(this.newThread ? { newThread: true } : {}),
            ...(this.targetItem ? { targetItem: { handle: context.handleOf?.(this.targetItem.id) ?? null, agentName: this.targetItem.agentName, place: this.targetItem.place } } : {}),
            ...(previous ? { previous } : {}),
            ...(change.instruction ? { instruction: change.instruction } : {}),
            ...(this.clarifications.length ? { clarifications: this.clarifications } : {}),
          }),
          this.options.compileTimeoutMs ?? 30_000,
        );
      } catch (err) {
        host.log('draft.compile.error', { message: (err as Error).message });
        host.trace('draft.compile.failed', `compile failed (${(err as Error).message}): using the words as said`, { message: (err as Error).message });
      }
    }
    if (epoch !== this.epoch) return; // the session ended meanwhile
    if (!this.active) {
      // Cancelled meanwhile.
      this.replayQueued();
      return;
    }
    // A fallback (no model, or it failed) is the words as said: always confirmed, never sent on its own.
    const compiledOk = result !== null;
    if (!result) {
      // No model (or it failed): the words as said, to the named agent; an edit can't be applied.
      result = {
        message: previous && change.instruction ? previous.message : this.fragments.join(' '),
        agentId: this.destination?.agentId ?? this.target?.id ?? null,
        item: null,
        threadId: this.destination?.kind === 'thread' ? (this.destination.threadId ?? null) : null,
        newThreadTitle: null,
        questions: change.instruction && previous ? ["I couldn't apply that change. Send it as it is, or cancel?"] : [],
      };
    }
    // A targetless ramble must ask who it is for, not accept the compiler's guess.
    const destination = this.longForm && !this.destinationClarified && !this.target && !this.targetItem && !this.newLoom && !this.newThread
      ? null : this.resolveDestination(result, context);
    this.compiled = result.message || this.fragments.join(' ');
    this.destination = destination;
    // The screen's place settled where a new thread starts: a question about where is moot.
    // So did a repo the owner named when they asked for the thread.
    const settled = destination?.inferred || (destination?.kind === 'new_loom' && !result.newLoomRepo);
    const questions = settled ? result.questions.filter((question) => !asksWhere(question)) : [...result.questions];
    if (questions.length < result.questions.length) (this.host ?? host).trace('draft.place', `the screen's place settled it (${destination!.label}): not asking “${clip(result.questions.join(' '), 100)}”`, { dropped: result.questions.filter((question) => !questions.includes(question)) });
    if (!destination && questions.length === 0) {
      const repos = context.input.loomRepos ?? [];
      questions.push(
        this.newLoom
          ? repos.length
            ? `Which repo: ${repos.join(', ')}?`
            : "I can't start Loom threads right now: the desk isn't answering."
          : this.newThread
            ? `Where should it start: ${repos.length ? `in ${repos.slice(0, 2).join(' or ')}, or ` : ''}with an agent?`
            : this.longForm ? "Who's it for?" : 'Who should this go to?',
      );
    }
    const redirected = !!before && !!destination && before.label !== destination.label;
    if (redirected) (this.host ?? host).trace('draft.redirect', `destination ${before!.label} → ${destination!.label}`, { from: before, to: destination });
    if (this.endedByJudge && this.queued.length) {
      // A judged end, but they kept talking while it compiled: they weren't done, whatever the compile says
      // (a send, a question, a fallback). That speech is more of the message, judged again at the next pause.
      this.endedByJudge = false;
      this.phase = 'listening';
      this.compiled = null;
      this.destination = null;
      (this.host ?? host).trace('draft.end.resumed', 'kept talking while a judged end compiled: back to listening, nothing asked', {});
      // One at a time, in order, with the operator's command hooks: a command said meanwhile ("cancel it",
      // "this is a long one", "back to the board") acts as one and keeps its boundaries.
      const pending = this.queued.splice(0);
      while (pending.length && this.active && this.phase === 'listening') await this.onSpeech(pending.shift()!, { ...this.speechHooks, delegationId: null });
      // A command ended or moved the draft ("cancel it"): what followed it goes the normal way.
      if (pending.length) {
        this.queued.push(...pending);
        this.replayQueued();
      }
      return;
    }
    if (questions.length) {
      this.endedByJudge = false;
      this.phase = 'clarifying';
      this.question = questions.join(' ');
      this.publish({});
      (this.host ?? host).trace('draft.clarify', `asking before sending: “${clip(this.question, 120)}”`, { question: this.question, destination, ms: this.now() - started });
      await this.tell(host, 'commentary', `[Before sending the draft, ask the user only this, in a few words: "${this.question}" Don't send anything.]`, delegationId);
      this.replayQueued();
      return;
    }
    if (this.autoSend && compiledOk && !change.instruction && !redirected && this.destinationAgrees(destination!)) {
      // Three seconds from the owner's "I'm done", compile time included, but never less than a beat to read and undo.
      // A judged end always keeps the full undo floor, even with a shorter test override.
      const floor = this.options.undoMinMs ?? TURN.undoMs;
      const ms = Math.max(this.endedByJudge ? Math.max(TURN.undoMs, floor) : floor, (this.heardAt || started) + (this.options.undoMs ?? TURN.undoMs) - this.now());
      (this.host ?? host).trace('draft.ready', `compiled in ${this.now() - started} ms → ${destination!.label} (where the owner said): sending in ${Math.round(ms / 1000)} s unless undone: “${clip(this.compiled, 160)}”`, { destination, message: this.compiled, ms: this.now() - started, undoMs: ms });
      await this.holdToSend(host, delegationId, ms);
      return;
    }
    this.autoSend = false;
    this.endedByJudge = false;
    this.phase = 'confirm';
    this.question = null;
    this.publish({});
    (this.host ?? host).trace('draft.confirm', `compiled in ${this.now() - started} ms → ${destination!.label}: “${clip(this.compiled, 160)}”`, { destination, message: this.compiled, ms: this.now() - started, redirected });
    const where = spokenDestination(destination!);
    const onScreen = (this.host ?? host).screenVisible();
    await this.tell(
      host,
      'commentary',
      onScreen
        ? `[The draft is ready and on the screen. Ask only: "Send that to ${where}?" Don't read the message out.]`
        : `[The draft is ready. Read it back briefly, then ask: "Send that to ${where}?" The message: ${this.compiled}]`,
      delegationId,
    );
    this.replayQueued();
  }

  /**
   * Tells GPT-Live something that resolved after an await: through whichever operator is attached
   * now (a reconnect may have replaced the one that started), or the next one to attach.
   */
  private async tell(origin: DraftHost, kind: LiveContextKind, content: string, delegationId: string | null): Promise<void> {
    const current = this.host;
    if (!current) {
      this.unsaid.push({ kind, content });
      return;
    }
    // A delegation id belongs to the connection that raised it.
    await current.append(kind, content, current === origin ? delegationId : null);
  }

  /** Speech held while compiling or sending: handled now, through the normal path. */
  private replayQueued(): void {
    if (this.queued.length === 0) return;
    const text = this.queued.splice(0).join(' ');
    const host = this.host;
    if (!host) return;
    host.trace('draft.replay', `handling what was said meanwhile: “${clip(text, 80)}”`, { text: clip(text, 200) });
    host.replay(text);
  }

  private resolveDestination(result: DraftCompileResult, context: DraftContext): DraftDestination | null {
    const resolution = resolveDraftDestination(result, context, {
      agents: this.host!.agents,
      startSpeech: this.startSpeech,
      fragments: this.fragments,
      clarifications: this.clarifications,
      newLoom: this.newLoom,
      newThread: this.newThread,
      targetItem: this.targetItem,
      target: this.target,
    });
    if (resolution.usedNamed !== undefined) this.usedNamed = resolution.usedNamed;
    return resolution.destination;
  }

  /** how: voice (a yes), screen (a Send tap), auto (the undo window ran out with no undo). */
  private async send(delegationId: string | null, how: 'voice' | 'screen' | 'auto'): Promise<void> {
    const host = this.host;
    if (!host || (this.phase !== 'confirm' && this.phase !== 'holding') || !this.destination || !this.compiled) return;
    // Nothing was asked (an undo window): the confirmation is just "Sent."
    const brief = this.phase === 'holding';
    if (this.undoTimer) clearTimeout(this.undoTimer);
    this.undoTimer = null;
    this.undoUntil = null;
    // Exactly once: a second yes (or a tap racing a yes) finds the phase moved on.
    this.phase = 'sending';
    const destination = this.destination;
    const message = this.compiled;
    host.trace('draft.send', `sending to ${destination.label} (${how}): “${clip(message, 160)}”`, { destination, message, how });
    host.log('draft.send', { destination, how });
    this.note = null;
    // Not cancellable from here on, and not "sent" until the send path says so.
    this.publish({});
    const epoch = this.epoch;
    // The desk conversation this answers, whatever shape the destination took (an agent's main-channel
    // item resolves to kind 'home' with no itemId): it is never the "next one" right after.
    const sentItem = destination.itemId ?? (this.usedNamed && this.targetItem ? this.targetItem.id : null);
    let outcome: DraftSendOutcome;
    try {
      outcome = await host.send(destination, message, delegationId, { ...(brief ? { brief: true } : {}), ...(sentItem ? { itemId: sentItem } : {}), ...(this.draftId ? { draftId: this.draftId } : {}) });
    } catch (err) {
      outcome = { ok: false, error: (err as Error).message };
    }
    if (epoch !== this.epoch) {
      // The session ended meanwhile: its card is closed; this changes nothing, it is only recorded.
      this.log('draft.send.after-end', { destination, ok: outcome.ok, error: outcome.error });
      return;
    }
    if (!outcome.ok) {
      // Nothing went out: the draft stays, ready to confirm again or redirect.
      this.phase = 'confirm';
      this.note = `Not sent${outcome.error ? `: ${outcome.error}` : ''}`;
      (this.host ?? host).trace('draft.send.failed', `send to ${destination.label} was not accepted${outcome.error ? ` (${outcome.error})` : ''}: the draft is kept`, { destination, error: outcome.error ?? null });
      (this.host ?? host).log('draft.send.failed', { destination, error: outcome.error });
      this.publish({});
      await this.tell(host, 'instructions', '[The draft was NOT sent and is still held. Ask the user whether to try again or send it somewhere else.]', delegationId);
      this.replayQueued();
      return;
    }
    await this.tell(host, 'instructions', DRAFT_OFF_INSTRUCTIONS, null);
    const after = this.afterSend;
    this.reset();
    this.card = { ...this.card, active: false, status: 'sent', updatedAt: this.now() };
    this.publisher?.(this.card);
    this.scheduleClear(this.options.clearAfterMs ?? 4000);
    const current = this.host;
    if (after && current?.next) {
      current.trace('draft.after.run', `sent: now ${after === 'advance' ? 'the next one' : 'the list'}`, { op: after, sentItem });
      await current.next(after, { exclude: sentItem ? [sentItem] : [], delegationId: null });
    }
    this.replayQueued();
  }

  private async cancel(delegationId: string | null, how: 'phrase' | 'model' | 'screen'): Promise<void> {
    const host = this.host!;
    host.trace('draft.cancel', `draft discarded (${how}); nothing was sent`, { how, fragments: this.fragments.length });
    host.log('draft.cancel', { how });
    // Discarded means gone: no parked copy of it comes back either.
    if (this.targetItem) this.parked.delete(this.targetItem.id);
    this.phase = 'idle';
    this.publish({ active: false, status: 'cancelled' });
    this.reset();
    this.scheduleClear(this.options.clearAfterMs ?? 4000);
    // "Never mind" by voice: back to the board for the next thing (a Cancel tap leaves the screen where the owner put it).
    if (how !== 'screen') host.presentBoard?.();
    await host.append('instructions', DRAFT_OFF_INSTRUCTIONS, null);
    await host.append('commentary', '[The draft was discarded; nothing was sent. Confirm in a few words.]', delegationId);
  }

  private reset(): void {
    if (this.undoTimer) clearTimeout(this.undoTimer);
    this.undoTimer = null;
    this.undoUntil = null;
    this.autoSend = false;
    this.afterSend = null;
    this.usedNamed = false;
    this.armedByTap = false;
    this.phase = 'idle';
    this.target = null;
    this.targetItem = null;
    this.fragments = [];
    this.compiled = null;
    this.destination = null;
    this.question = null;
    this.note = null;
    this.clarifications = [];
    this.destinationClarified = false;
    this.unsaid = [];
    this.checked = false;
    this.newLoom = false;
    this.newThread = false;
    this.startSpeech = '';
    this.longForm = false;
    this.endPending = null;
    this.judgedKey = null;
    this.relookKey = null;
    this.endedByJudge = false;
  }

  private scheduleClear(ms: number): void {
    if (this.clearTimer) clearTimeout(this.clearTimer);
    // Clears only the draft it was set for: the desk ignores it once another draft has replaced it.
    const clears = this.card.id;
    this.clearTimer = setTimeout(() => {
      this.clearTimer = null;
      if (this.active || this.card.id !== clears) return;
      this.card = blankCard(this.now());
      this.publisher?.(clears ? { ...this.card, clears } : this.card);
    }, ms);
    this.clearTimer.unref?.();
  }

  private publish(patch: Partial<DraftCard>): void {
    const status: DraftStatus = this.phase === 'compiling' ? 'compiling' : this.phase === 'sending' || this.phase === 'holding' ? 'sending' : this.phase === 'confirm' || this.phase === 'clarifying' ? 'confirm' : 'listening';
    const destination = this.destination;
    const item = this.targetItem;
    // The desk item it is for: the destination's, else the conversation the owner named when the destination is still its agent.
    const itemId = destination ? (destination.itemId ?? (item && persona(item.agentId) === persona(destination.agentId) && destination.kind === 'home' && this.usedNamed ? item.id : null)) : (item?.id ?? null);
    const target = destination
      ? { agentId: destination.agentId, name: destination.name, where: destination.kind === 'home' ? 'main channel' : destination.kind === 'new_thread' ? `new thread${destination.title ? ` “${destination.title}”` : ''}` : destination.kind === 'new_loom' ? `new thread in ${destination.repo}${destination.title ? ` “${destination.title}”` : ''}` : (destination.title ?? null), label: destination.label, itemId }
      : this.target
        ? { agentId: this.target.id, name: this.target.name, where: null, label: this.target.name, itemId: null }
        : null;
    this.card = {
      id: this.draftId,
      active: this.active,
      // Before the compile: the conversation the owner named, else the agent.
      target: target && (destination || !item) ? target : item ? { agentId: item.agentId, name: item.agentName, where: item.place, label: `${item.agentName}${item.place ? ` · ${item.place}` : ''}`, itemId: item.id } : target,
      fragments: [...this.fragments],
      compiled: this.compiled,
      question: this.phase === 'clarifying' ? this.question : null,
      note: this.note,
      status,
      undoUntil: this.phase === 'holding' ? this.undoUntil : null,
      updatedAt: this.now(),
      ...patch,
    };
    this.publisher?.(this.card);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
