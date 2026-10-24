// Speech that wasn't meant for the operator. An always-listening operator hears plenty that isn't
// said to it: people nearby, someone thinking aloud, music or video, stray sounds. Two guards keep it
// from answering or acting on that:
//
//   "For me?"  the router says whether speech was addressed to the operator: yes, no (nothing is
//              done, nothing said) or unsure. Unsure work is held and the operator asks only "For
//              me?". A yes does the held work; a no, silence, or anything else drops it (new speech
//              is routed on its own). Naming the operator or an agent is always a yes.
//   filler     an utterance that is only filler ("mm", "uh", a sniff or a cough) is never answered:
//              the voice model's audio is dropped until the owner says real words or the backend
//              gives it something to say. Without it the voice model answers a stray "mm" with
//              "Go ahead, I'm listening".

import type { AgentDescriptor } from './agent-backend.js';
import type { OperatorAction } from './task-extractor.js';

/** The router's none for speech it isn't sure was meant for the operator; it rides next to the work it would do. */
export const UNSURE_REASON = 'unsure it was for the operator';

export function isUnsureMarker(action: OperatorAction): boolean {
  return action.type === 'none' && action.reason.toLowerCase().startsWith(UNSURE_REASON);
}

/** Names that make speech meant for the operator: its own (Yankee; the legacy Tango), Loom, each agent's. */
export function addresseeNames(agents: AgentDescriptor[]): string[] {
  return ['yankee', 'tango', 'loom', ...agents.flatMap((agent) => [agent.name, ...(agent.aliases ?? [])])];
}

/** Whether the speech calls the operator or an agent by name: then it was meant for us. */
export function namesSomeone(speech: string, names: string[]): boolean {
  const text = ` ${speech.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ')} `;
  return names.some((name) => {
    const spoken = name.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').trim();
    return spoken.length > 1 && text.includes(` ${spoken} `);
  });
}

export type AddresseeAnswer = 'yes' | 'no' | 'other';

const YES_WORDS = new Set(['yes', 'yeah', 'yep', 'yup', 'ya', 'yah', 'sure', 'correct', 'right', 'affirmative', 'uh-huh', 'mm-hmm', 'mm-hm', 'mhm', 'please', 'ok', 'okay']);
const NO_WORDS = new Set(['no', 'nope', 'nah', 'negative', 'not', "don't", 'dont']);
/** Words that may sit around a yes or no: "yes, for you", "no, not you", "Yankee, yes please". */
const AROUND = new Set(['for', 'you', 'that', 'was', 'it', 'is', 'go', 'ahead', 'do', 'send', 'please', 'thanks', 'thank', 'oh', 'um', 'uh', 'mm', 'hey', 'yankee', 'tango', 'sorry', 'not', 'me', 'to', 'someone', 'else', 'never', 'mind', 'nevermind', 'talking', 'i', 'was', "i'm", 'just', 'the', 'a', 'sir', 'one']);

/** The answer to "For me?". Only a short reply counts; anything longer is new speech. */
export function matchAddresseeAnswer(text: string): AddresseeAnswer {
  const words = text
    .toLowerCase()
    .replace(/[^a-z' -]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0 || words.length > 8) return 'other';
  if (!words.every((word) => YES_WORDS.has(word) || NO_WORDS.has(word) || AROUND.has(word))) return 'other';
  const joined = ` ${words.join(' ')} `;
  // Any negation is a no: "do not send it", "don't do it", "not for you" (Codex review on #481).
  if (words.some((word) => NO_WORDS.has(word)) || / never ?mind | someone else | talking to /.test(joined)) return 'no';
  if (words.some((word) => YES_WORDS.has(word)) || / for you | go ahead | do it | send it /.test(joined)) return 'yes';
  return 'other';
}

export interface HeldForMe {
  actions: OperatorAction[];
  speech: string;
  /** Whatever the caller needs to apply the actions later (extraction handles). */
  handles: unknown;
  /** After a yes, a send that sounds cut off still waits for "Is that everything?" (draft mode). */
  checkUnfinished: boolean;
  at: number;
}

/** The work held while "For me?" waits for an answer. One at a time; it expires unanswered. */
export class AddresseeAsk {
  private current: HeldForMe | null = null;

  constructor(private readonly options: { now: () => number; holdMs?: number }) {}

  get held(): HeldForMe | null {
    return this.current && !this.isExpired(this.current) ? this.current : null;
  }

  hold(entry: Omit<HeldForMe, 'at'>): void {
    this.current = { ...entry, at: this.options.now() };
  }

  /** Takes the held work (answered or not); null when none is waiting or it went unanswered too long. */
  take(): HeldForMe | null {
    const held = this.held;
    this.current = null;
    return held;
  }

  /** Drops work that went unanswered, returning it (once) so the caller can trace it. */
  expire(): HeldForMe | null {
    if (!this.current || !this.isExpired(this.current)) return null;
    const expired = this.current;
    this.current = null;
    return expired;
  }

  private isExpired(held: HeldForMe): boolean {
    return this.options.now() - held.at > (this.options.holdMs ?? 20_000);
  }
}

const FILLER = new Set(['mm', 'mmm', 'mmmm', 'hm', 'hmm', 'hmmm', 'mhm', 'mm-hmm', 'mm-hm', 'mmhmm', 'uh', 'um', 'uhm', 'umm', 'uh-huh', 'ah', 'oh', 'er', 'erm', 'huh', 'eh']);

/** Only filler: "Mm", "uh", "[sniff]", "Mm. [tongue click]", or nothing but bracketed sounds. */
export function isFillerOnly(text: string): boolean {
  const words = text
    .replace(/\[[^\]]*\]?/g, ' ')
    .replace(/^[^[]*\]/, ' ')
    .toLowerCase()
    .replace(/[^a-z' -]+/g, ' ')
    .split(/[\s]+/)
    .map((word) => word.replace(/^[-']+|[-']+$/g, ''))
    .filter(Boolean);
  return words.every((word) => FILLER.has(word));
}

/**
 * Keeps the voice model from answering filler. A filler-only utterance that starts while the
 * operator is quiet closes the gate; real words from the owner, or anything the backend gives the
 * voice model to say, open it again. A murmur over the operator's own speech ("mm-hmm" while an
 * update plays, or in the gap between its sentences) never cuts it off. Closed at most `maxClosedMs`.
 */
export class FillerGate {
  private closedAt: number | null = null;
  private utterance = '';
  private lastHeardAt = -Infinity;
  private lastVoicedAt = -Infinity;
  private utteranceOverSpeech = false;
  private openedAt = -Infinity;
  /** A stretch of the voice model's speech began after the last open(): what the backend gave it has started playing. */
  private openedSpoken = true;
  /** How many times the gate has closed: a listener sees a new close by comparing. */
  closures = 0;

  /** `onClose`: drop audio already buffered for playback (the reply may have started before the transcript said filler). */
  constructor(private readonly options: { now?: () => number; log?: (event: string, data?: Record<string, unknown>) => void; onClose?: () => void; maxClosedMs?: number; splitMs?: number } = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** A delta of the owner's transcript. */
  heard(delta: string): void {
    const now = this.now();
    const fresh = now - this.lastHeardAt > (this.options.splitMs ?? 1500) || this.lastVoicedAt > this.lastHeardAt;
    if (fresh) {
      this.utterance = '';
      this.utteranceOverSpeech = now - this.lastVoicedAt < 3000;
    }
    this.lastHeardAt = now;
    this.utterance += delta;
    if (!this.utterance.trim()) return;
    // Something the backend gave the voice model is still to be said: a murmur before it plays doesn't silence it.
    // The tail of an earlier reply doesn't count as it playing (Codex review on #481).
    const backendPending = !this.openedSpoken && now - this.openedAt < (this.options.maxClosedMs ?? 20_000);
    if (!isFillerOnly(this.utterance)) {
      this.reopen();
    } else if (!this.utteranceOverSpeech && !backendPending && !this.closed) {
      this.closedAt = now;
      this.options.log?.('filler.gate', { closed: true, heard: this.utterance.trim().slice(0, 40) });
      this.closures += 1;
      this.options.onClose?.();
    }
  }

  /** The backend gave the voice model something to say (an update, a confirmation, an instruction). */
  open(): void {
    this.openedAt = this.now();
    this.openedSpoken = false;
    this.reopen();
  }

  private reopen(): void {
    if (this.closedAt === null) return;
    this.closedAt = null;
    this.options.log?.('filler.gate', { closed: false });
  }

  get closed(): boolean {
    if (this.closedAt !== null && this.now() - this.closedAt > (this.options.maxClosedMs ?? 20_000)) this.closedAt = null;
    return this.closedAt !== null;
  }

  /** Whether this chunk of the voice model's audio may play. */
  admitAudio(voiced: boolean): boolean {
    if (this.closed) return false;
    if (voiced) {
      const now = this.now();
      // A new stretch of speech (after a 400 ms gap) that starts after open(): the backend's words are playing.
      if (now - this.lastVoicedAt >= 400 && now >= this.openedAt) this.openedSpoken = true;
      this.lastVoicedAt = now;
    }
    return true;
  }
}
