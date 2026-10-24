import { randomUUID } from 'node:crypto';
import type { DeskClient } from './desk-client.js';
import type { LiveContextKind } from './gpt-live-client.js';

// Pause mode: the owner is talking to someone in the room. The operator holds every agent
// message and stays completely silent until the owner resumes.
//
//   pause    "Yankee, pause" / "Yankee, hold my messages" / "Yankee, give me a minute"… The wake
//            word (the operator's name, Yankee; the legacy "Tango" still works) must lead the command (after an optional greeting: "hey", "okay"), so room talk
//            ("pause the movie", "I'm back from the store", "I told Yankee to pause") never
//            triggers it. Matched deterministically on the owner's transcript; works in any
//            state, draft mode included (the draft is kept).
//   paused   one very short confirmation ("Paused."), then nothing: GPT-Live is told to stay
//            silent, its audio is dropped after the confirmation window, every delegation is
//            ignored and every append is held back. The router is never consulted; fresh speech
//            is consumed and checked only for the resume command (never sent to an agent, never
//            added to a draft, never captioned). Agent results, relays, notices, failures and
//            desk deadlines all queue (the operator's normal queue, release blocked). The desk
//            shows a "Paused · N waiting" pill; tapping it resumes.
//   resume   "Yankee, I'm back" / "Yankee, resume" / "Yankee, what did I miss"… or the pill. GPT-Live
//            gets its normal instructions back, says "You've got N updates." (a one-sentence
//            catch-up first when more than 4 are waiting), and the queue plays one at a time,
//            your-move and failures first.
//
// State lives in a PauseSession owned at the voice-session level (like DraftSession): it outlives
// a GPT-Live reconnect or an idle sleep, and each LiveOperator attaches as the host while live.

/** What the desk shows (POST /api/desk/pause; `pause` events on /api/desk/stream). */
export interface PauseCard {
  /** This pause's identity (null when never paused); a tap names the pause it saw. */
  id: string | null;
  active: boolean;
  /** When this pause started. */
  since: number | null;
  /** Voice updates waiting to be said. */
  waiting: number;
  /** Paused 30 minutes or more ("Still paused · N waiting"). */
  still: boolean;
  updatedAt: number;
}

/** A tap on the desk's pause pill (POST /api/desk/pause/command, relayed as `pauseCommand`). */
export interface PauseScreenCommand {
  action: 'resume';
  commandId?: string;
  /** The pause the screen was showing; a tap on an older one is ignored. */
  pauseId?: string;
}

/** One queued voice update, as the resume announcement needs it. */
export interface PausedUpdate {
  agentName: string;
  /** question: the agent asks the owner (your move); failed: a turn failed; result: anything else. */
  kind: 'question' | 'failed' | 'result';
}

/** What the current operator lends the pause session. */
export interface PauseHost {
  now(): number;
  alive(): boolean;
  /** Straight to GPT-Live (pause's own words get past the pause gate). */
  append(kind: LiveContextKind, content: string, delegationId: string | null): Promise<void>;
  trace(kind: string, summary: string, data?: Record<string, unknown>): void;
  log(event: string, data?: Record<string, unknown>): void;
  publish(card: PauseCard): void;
  desk?: DeskClient;
  /** Voice updates queued now (read-backs and reminders not counted). */
  waiting(): number;
  hasFreshSpeech(): boolean;
  /** Fresh owner speech without consuming it. */
  peekFreshSpeech(): string;
  /** Fresh owner speech, consumed. */
  takeFreshSpeech(): string;
  /** The pause begins: the owner's current transcript line is finished, so later words start a paused line. */
  sealTranscript(): void;
  /** Drops every owner transcript line said while paused (and anything not yet read): it reaches nothing. */
  forgetPausedSpeech(): void;
  userQuietMs(): number;
  /** Since the last owner transcript delta arrived. */
  transcriptQuietMs(): number;
  /**
   * The operator's shared update hold (live-operator.ts, also used by draft mode): queue every
   * update, release none. Anything being relayed goes back to the front (the pause cut it off).
   */
  holdUpdates(): void;
  /**
   * Lifts the pause's hold. When nothing else holds the queue, it is ordered for playback (your
   * move and failures first), `announce` is given what is waiting, and the queue plays after the
   * announcement. False (no announce) while another hold (an open draft) still keeps it.
   */
  releaseUpdates(announce: (updates: PausedUpdate[]) => Promise<void>): Promise<boolean>;
  /** A draft is open: GPT-Live hears draft mode again, and its silence clock restarts. */
  resumeDraft(): void;
}

export interface PauseSessionOptions {
  /** After this long paused the pill says "Still paused" (default 30 min). No speech. */
  stillAfterMs?: number;
  /** The voice connection stays awake this long while paused (default 60 min); then it may sleep, still paused. */
  holdAwakeMs?: number;
  /** The "Paused." confirmation may start at most this long after the pause began (default 8 s); later, nothing plays. */
  confirmMs?: number;
  /** Owner quiet this long before fresh speech is checked for the pause command (default 1 s). */
  pauseQuietMs?: number;
  /** Owner quiet this long before speech heard while paused is checked for the resume command (default 800 ms). */
  resumeQuietMs?: number;
  /** Stops whatever the operator is saying when the pause starts (the Discord audio buffer). */
  cutAudio?: () => void;
  log?: (event: string, data?: Record<string, unknown>) => void;
  now?: () => number;
}

// ── GPT-Live instructions ────────────────────────────────────────────────

export const PAUSE_ON_INSTRUCTIONS =
  '[Pause is ON. The user is talking with someone in the room. Until you are told the pause is over: say nothing at all, and keep nothing of what you hear for later. ' +
  'No backchannels, no answers, no questions, no greetings, not even to someone talking to you directly. Ignore everything you hear. ' +
  'Do not delegate. The backend is listening for the user to resume and will tell you when to speak again.]';

export const PAUSE_OFF_INSTRUCTIONS =
  '[The pause is over. Everything said while it was on was room talk, not meant for you: do not answer it, mention it, ' +
  'summarize it, apologize about it, or act on it, now or later. Start fresh from the user\'s "I\'m back". ' +
  'Go back to your normal policies: no backchannels, wait for complete requests, delegate as usual.]';

/** Instead of the usual "you just reconnected" note when the connection comes back mid-pause. */
export const PAUSE_RECONNECT_NOTE = '[You just reconnected. The pause is still ON: say nothing at all until you are told the pause is over.]';

// ── phrases ──────────────────────────────────────────────────────────────

/** Lowercased words, accents and punctuation gone, apostrophes kept. */
export function normalizePauseSpeech(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The wake word: the operator's name, "Yankee", with the ASR spellings it actually gets ("Yankee's",
// "Yankees", "Yanky"), and the legacy "Tango" / "Tangó" (accents are stripped) / "Tango's". No looser
// variants ("yank he", "tangle"): a missed resume is fixed by saying it again or tapping the pill; a
// false pause in the middle of a conversation is worse.
const GREETING = "(?:(?:hey|hi|hello|okay|ok|oh|alright|all right|um|uh|so|yo)\\s+)*";
const WAKE = `${GREETING}(?:yankee(?:'s|s)?|yanky|tango(?:'s)?)`;
const UNIT = '(?:sec|second|minute|moment|bit)';
const PAUSE_CORE = [
  `pause(?: (?:messages|my messages|the messages|updates|my updates|everything|it|for (?:a|one) ${UNIT}))?`,
  'hold (?:my |all |all my |the )?(?:messages|updates|calls)',
  'hold everything',
  'hold on',
  `hold on (?:a|one) ${UNIT}`,
  `give me (?:a|one|just a) ${UNIT}`,
  `(?:just )?(?:a|one) ${UNIT}`,
  'go quiet',
  'be quiet',
  'quiet',
  'mute(?: yourself| it| messages| updates)?',
  'stand by',
].join('|');
const RESUME_CORE = [
  'resume(?: (?:messages|my messages|updates|my updates))?',
  "(?:i'?m|i am|we'?re|we are) back",
  'un ?pause',
  "what (?:did|'d) i miss",
  'what did we miss',
  'play (?:my |the )?(?:messages|updates)',
  'continue',
  "you can (?:talk|speak) (?:again|now)",
  'unmute',
].join('|');
const TAIL = "(?:\\s+(?:please|thanks|thank you|for now|now|then|again|for (?:a|one) (?:sec|second|minute|moment|bit)))*";

function commandPattern(core: string): RegExp {
  // The wake word leads; then one or more commands ("I'm back, what did I miss").
  return new RegExp(`^${WAKE}\\s+(?:${core})(?:\\s+(?:and\\s+|so\\s+)?(?:${core}))*${TAIL}$`);
}
const PAUSE_PATTERN = commandPattern(PAUSE_CORE);
/** Leading "mm", "um", "hmm", and bracketed noise tags ([sniff], [breath], [cough]) the ASR emits. */
const LEADING_FILLER = /^(?:(?:m+|mm+|hm+|hmm+|um+|uh+|ah+|er+|sniff|cough|breath|laugh|laughter|noise|inaudible|silence|music)\s+)+/;
const RESUME_PATTERN = commandPattern(RESUME_CORE);

/**
 * "pause" or "resume" when one of the owner's sentences is exactly a pause / resume command led
 * by the wake word; else null. Each sentence is checked on its own, so "Yankee, pause. Anyway, as I
 * was saying…" pauses, while "Yankee, pause the movie" and "I told Yankee to pause" do not.
 */
export function matchPauseCommand(speech: string): 'pause' | 'resume' | null {
  return findPauseCommand(speech)?.command ?? null;
}

/** The command and the one sentence that said it (normalized): only that sentence is ever traced. */
export function findPauseCommand(speech: string): { command: 'pause' | 'resume'; sentence: string } | null {
  // Filler and noise the transcript runs in ahead of the command ("Mm Mm [sniff] Yankee, pause") don't count.
  const sentences = speech
    .split(/[.!?;…]+/)
    // Whole bracketed tags first ([SOUND], [BLANK_AUDIO], [background noise]), and an unclosed one ("[sniff").
    .map((sentence) => normalizePauseSpeech(sentence.replace(/\[[^\]]*\]/g, ' ').replace(/\[\S*/g, ' ')).replace(LEADING_FILLER, ''))
    .filter(Boolean);
  let found: { command: 'pause' | 'resume'; sentence: string } | null = null;
  for (const sentence of sentences) {
    // The last command said wins ("Yankee pause… Yankee, I'm back" in one breath is a resume).
    if (RESUME_PATTERN.test(sentence)) found = { command: 'resume', sentence };
    else if (PAUSE_PATTERN.test(sentence)) found = { command: 'pause', sentence };
  }
  return found;
}

// ── resume announcement ──────────────────────────────────────────────────

/** Playback order on resume: what is waiting on the owner (your move, failures) first, then the rest. */
export function resumePriority(update: PausedUpdate): number {
  return update.kind === 'question' || update.kind === 'failed' ? 0 : 1;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function distinct(names: string[]): string[] {
  return [...new Set(names)];
}

/** One sentence for more than four updates: "Sierra and Malibu got back to you, and Loom has a question". */
export function catchUpSentence(updates: PausedUpdate[]): string {
  const reported = distinct(updates.filter((update) => update.kind === 'result').map((update) => update.agentName));
  const asking = distinct(updates.filter((update) => update.kind === 'question').map((update) => update.agentName));
  const failed = distinct(updates.filter((update) => update.kind === 'failed').map((update) => update.agentName));
  const parts: string[] = [];
  if (reported.length) parts.push(`${joinNames(reported)} got back to you`);
  if (asking.length) parts.push(`${joinNames(asking)} ${asking.length === 1 ? 'has a question' : 'have questions'}`);
  if (failed.length) parts.push(`${joinNames(failed)} had a turn fail`);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;
}

/** What the operator says on resume. */
export function resumeAnnouncement(updates: PausedUpdate[]): string {
  const count = updates.length;
  if (count === 0) return 'Nothing came in.';
  const lead = `You've got ${count} update${count === 1 ? '' : 's'}.`;
  if (count <= 4) return lead;
  const sentence = catchUpSentence(updates);
  return sentence ? `${lead} ${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.` : lead;
}

function clip(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function words(text: string): number {
  return normalizePauseSpeech(text).split(' ').filter(Boolean).length;
}

function minutes(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min < 1 ? `${Math.round(ms / 1000)} s` : `${min} min`;
}

/**
 * One voice session's pause. Survives GPT-Live reconnects and idle sleep: each operator attaches as
 * the host while live. end() closes it with the session.
 */
export class PauseSession {
  private host: PauseHost | null = null;
  /** The last host, kept after it detaches: an ended session (or a sleeping one) still clears the pill and traces. */
  private lastHost: PauseHost | null = null;
  private id: string | null = null;
  private since: number | null = null;
  private still = false;
  private lastPublished = '';
  /**
   * The audio gate (Codex review on #394): speech already under way when the pause began is
   * dropped; only the confirmation plays. drain → confirm (the voice model's own transcript says
   * "paused", after a gap in its audio) → closed (the confirmation finished, or the window ran out).
   */
  private audioPhase: 'drain' | 'confirm' | 'closed' = 'drain';
  private lastVoicedAt = 0;
  private confirmSaid = false;
  /** The voice model's words since the pause began (the last 200 characters): "Paused." can arrive split over deltas. */
  private outputSincePause = '';
  private screenHandler: ((command: PauseScreenCommand) => void) | null = null;
  private readonly now: () => number;
  private readonly log: (event: string, data?: Record<string, unknown>) => void;

  constructor(private readonly options: PauseSessionOptions = {}) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  /** Paused now. */
  get active(): boolean {
    return this.since !== null;
  }

  /** The card as it would be published now. */
  get state(): PauseCard {
    return this.card();
  }

  /** A new operator (first, after a reconnect, or after waking) takes over: GPT-Live hears the pause again. */
  attach(host: PauseHost): void {
    this.host = host;
    this.lastHost = host;
    this.screenHandler = (command) => void this.onScreenCommand(command);
    host.desk?.onPauseCommand?.(this.screenHandler);
    if (!this.active) {
      // A fresh session (the voice process restarted): clear a pill an earlier process left behind (Codex review on #394).
      if (this.lastPublished === '') this.publish(true);
      return;
    }
    // Holds belong to an operator: the new one holds the queue again.
    host.holdUpdates();
    host.trace('pause.carried', `still paused on a new voice connection (${minutes(this.now() - this.since!)} so far, ${host.waiting()} waiting)`, { pauseId: this.id, pausedMs: this.now() - this.since! });
    void host.append('instructions', PAUSE_ON_INSTRUCTIONS, null);
    this.lastPublished = '';
    this.publish();
  }

  detach(host: PauseHost): void {
    if (this.host !== host) return;
    host.desk?.onPauseCommand?.(null);
    this.host = null;
  }

  /**
   * Whether this chunk of the voice model's audio may play. Always outside a pause. While paused,
   * only the "Paused." confirmation: it must follow a gap of at least 400 ms in voiced audio (so
   * the rest of a reply that was under way when the pause began never plays), and only once the
   * model's own transcript since the pause says "paused" (the transcript runs ahead of the audio).
   * When the two can't be told apart the confirmation is dropped too: silence wins.
   */
  admitAudio(voiced: boolean): boolean {
    if (!this.active) return true;
    const now = this.now();
    if (this.audioPhase === 'drain' && now - this.since! > (this.options.confirmMs ?? 8000)) this.audioPhase = 'closed';
    if (this.audioPhase === 'closed') return false;
    if (voiced) {
      const gap = now - this.lastVoicedAt;
      this.lastVoicedAt = now;
      if (this.audioPhase === 'drain' && this.confirmSaid && gap >= 400) this.audioPhase = 'confirm';
      return this.audioPhase === 'confirm';
    }
    if (this.audioPhase === 'confirm' && now - this.lastVoicedAt >= 800) {
      this.audioPhase = 'closed';
      return false;
    }
    return this.audioPhase === 'confirm';
  }

  /** The voice model's own words (its output transcript): the confirmation is recognized here. */
  noteOutput(text: string): void {
    if (!this.active || this.audioPhase !== 'drain') return;
    this.outputSincePause = (this.outputSincePause + text).slice(-200);
    if (/\b(?:paused|holding)\b/i.test(this.outputSincePause)) this.confirmSaid = true;
  }

  /** Context for GPT-Live other than pause's own is held back while paused. */
  holdsAppends(): boolean {
    return this.active;
  }

  /** Keeps an idle voice connection awake while paused, up to an hour. */
  holdsSession(): boolean {
    return this.active && this.now() - this.since! < (this.options.holdAwakeMs ?? 60 * 60_000);
  }

  /** Paused past the hold: queued updates no longer keep the connection awake (they stay queued, and paused). */
  sleepsWithQueue(): boolean {
    return this.active && !this.holdsSession();
  }

  /**
   * Fresh owner speech from a delegation. While paused it is all taken (true): only a resume command
   * does anything. Outside a pause, true only when it is the pause command.
   */
  async onSpeech(speech: string, delegationId: string | null, origin: 'delegation' | 'transcript' = 'delegation'): Promise<boolean> {
    const host = this.host;
    if (!host) return false;
    const found = speech ? findPauseCommand(speech) : null;
    const command = found?.command ?? null;
    if (!this.active) {
      if (command !== 'pause') return false;
      await this.start(found!.sentence, delegationId, origin);
      return true;
    }
    // Nothing said while paused stays in the operator's transcript (the router, captions, drafts never see it).
    host.forgetPausedSpeech();
    if (command === 'resume') {
      // Only the command sentence is traced; the room talk around it is a word count.
      await this.resume('voice', found!.sentence, Math.max(0, words(speech) - words(found!.sentence)));
      return true;
    }
    // Room talk, or GPT-Live delegating anyway: nothing goes anywhere. Only the size is traced.
    host.trace(
      'pause.ignored',
      speech ? `paused: ${words(speech)} word${words(speech) === 1 ? '' : 's'} heard, not sent anywhere${command === 'pause' ? ' (already paused)' : ''}` : `paused: ${origin === 'delegation' ? 'delegation' : 'speech'} ignored`,
      { origin, words: speech ? words(speech) : 0, delegationId, alreadyPaused: command === 'pause' },
    );
    return true;
  }

  /** Once a second from the operator's housekeeping: watch the transcript, and the pill. */
  tick(): void {
    const host = this.host;
    if (!host || !host.alive()) return;
    const now = this.now();
    // The operator watches the transcript itself: GPT-Live is told not to delegate while paused,
    // and need not delegate a pause either.
    if (host.hasFreshSpeech() && host.transcriptQuietMs() >= 600) {
      if (this.active && host.userQuietMs() >= (this.options.resumeQuietMs ?? 800)) {
        void this.onSpeech(host.takeFreshSpeech(), null, 'transcript');
      } else if (!this.active && host.userQuietMs() >= (this.options.pauseQuietMs ?? 1000) && matchPauseCommand(host.peekFreshSpeech()) === 'pause') {
        void this.onSpeech(host.takeFreshSpeech(), null, 'transcript');
      }
    }
    if (this.active && !this.still && now - this.since! >= (this.options.stillAfterMs ?? 30 * 60_000)) {
      this.still = true;
      host.trace('pause.still', `paused ${minutes(now - this.since!)}: the desk now says "Still paused" (no speech)`, { pauseId: this.id, waiting: host.waiting() });
    }
    if (this.active) this.publish();
  }

  /** A tap on the desk's pause pill. */
  async onScreenCommand(command: PauseScreenCommand): Promise<void> {
    const host = this.host;
    if (!host) return;
    if (!this.active || !command.pauseId || command.pauseId !== this.id) {
      host.trace('pause.screen.stale', `screen tapped resume on a pause that is ${this.active ? 'no longer current' : 'already over'}: ignored`, { pauseId: command.pauseId ?? null, current: this.id });
      return;
    }
    await this.resume('screen');
  }

  /**
   * The voice session is over. Queued updates are not lost: they are desk items already and stay
   * New there. The pill clears.
   */
  end(): void {
    const host = this.host ?? this.lastHost;
    if (this.active) {
      const waiting = host?.waiting() ?? 0;
      host?.trace('pause.ended', `voice session ended while paused (${minutes(this.now() - this.since!)}): ${waiting} unsaid update${waiting === 1 ? '' : 's'} stay on the desk as New`, { pauseId: this.id, waiting, pausedMs: this.now() - this.since! });
      this.log('pause.ended', { pauseId: this.id, waiting });
      this.since = null;
      this.still = false;
      this.publish(true);
    }
    if (this.host) this.detach(this.host);
  }

  // ── transitions ────────────────────────────────────────────────────────

  private async start(speech: string, delegationId: string | null, origin: 'delegation' | 'transcript'): Promise<void> {
    const host = this.host!;
    // Words from here on start new transcript lines, kept apart (and dropped) as paused speech.
    host.sealTranscript();
    this.id = randomUUID();
    this.since = this.now();
    this.still = false;
    this.audioPhase = 'drain';
    this.confirmSaid = false;
    this.outputSincePause = '';
    // Whatever was playing a moment ago counts as voiced: the confirmation must come after a gap.
    this.lastVoicedAt = this.now();
    try {
      this.options.cutAudio?.();
    } catch {
      /* best effort */
    }
    host.holdUpdates();
    const waiting = host.waiting();
    host.trace('pause.start', `paused on “${clip(speech, 60)}” (${origin}): holding every message, ${waiting} already waiting`, { pauseId: this.id, origin, speech: clip(speech, 120), waiting });
    host.log('pause.start', { pauseId: this.id, origin, waiting });
    this.publish(true);
    await host.append('instructions', PAUSE_ON_INSTRUCTIONS, null);
    await host.append('commentary', '[Say only "Paused." and then nothing at all.]', delegationId);
  }

  private async resume(how: 'voice' | 'screen', speech = '', otherWords = 0): Promise<void> {
    const host = this.host!;
    host.forgetPausedSpeech();
    const pausedMs = this.now() - this.since!;
    const pauseId = this.id;
    this.since = null;
    this.still = false;
    const by = how === 'screen' ? 'a tap on the desk' : `“${clip(speech, 60)}”`;
    this.publish(true);
    await host.append('instructions', PAUSE_OFF_INSTRUCTIONS, null);
    const released = await host.releaseUpdates(async (updates) => {
      const announcement = resumeAnnouncement(updates);
      host.trace('pause.resume', `resumed by ${by} after ${minutes(pausedMs)}: ${updates.length} update${updates.length === 1 ? '' : 's'} to play`, { pauseId, how, pausedMs, waiting: updates.length, announcement, otherWords });
      if (updates.length > 4) host.trace('pause.digest', `catch-up first: “${announcement}”`, { pauseId, sentence: catchUpSentence(updates), count: updates.length });
      host.log('pause.resume', { pauseId, how, pausedMs, waiting: updates.length });
      await host.append('commentary', `[Say only: "${announcement}" Then stop.${updates.length ? ' The updates follow one at a time.' : ''}]`, null);
    });
    if (!released) {
      // Another hold (an open draft) still keeps the queue: it announces what came in when it lifts.
      host.trace('pause.resume', `resumed by ${by} after ${minutes(pausedMs)}: updates stay held by another hold (an open draft)`, { pauseId, how, pausedMs, stillHeld: true, otherWords });
      await host.append('commentary', '[Say only: "Back." Then stop. Nothing about what was said during the pause.]', null);
    }
    host.resumeDraft();
  }

  private card(): PauseCard {
    return { id: this.id, active: this.active, since: this.since, waiting: this.active ? (this.host?.waiting() ?? 0) : 0, still: this.still, updatedAt: this.now() };
  }

  /** The pill, when what it shows changed (or forced: start, resume, end). */
  private publish(force = false): void {
    const card = this.card();
    const key = `${card.id}|${card.active}|${card.waiting}|${card.still}`;
    if (!force && key === this.lastPublished) return;
    this.lastPublished = key;
    (this.host ?? this.lastHost)?.publish(card);
  }
}
