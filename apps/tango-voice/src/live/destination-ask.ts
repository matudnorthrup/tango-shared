// "Main chat, or the Bluetooth Speaker thread?": when the router can't tell whether new work belongs
// in an agent's main channel or one of its threads, the operator holds the request and asks. The
// answer is matched here without a model call; anything else releases the request to the main
// channel and is routed as new speech.

import type { DecisionPrompt } from '@tango/core';
import type { OperatorAction } from './task-extractor.js';

type Dispatch = Extract<OperatorAction, { type: 'dispatch' }>;

export interface DestinationOption {
  threadId: string;
  title: string;
}

export interface HeldDestination {
  action: Dispatch;
  agentName: string;
  options: DestinationOption[];
  /** Whatever the caller needs to apply the action later (extraction handles). */
  handles: unknown;
  at: number;
}

export type DestinationAnswer = { kind: 'main' } | { kind: 'thread'; threadId: string } | { kind: 'cancel' } | { kind: 'unclear' };

const STOP = new Set(['the', 'a', 'an', 'one', 'thread', 'that', 'this', 'in', 'to', 'for', 'and', 'of', 'my', 'our', 'his', 'her', 'their', 'please', 'it', 'put', 'send']);

/** The words of a cancel, besides answer vocabulary. */
const CANCEL_WORDS = new Set(['never', 'mind', 'nevermind', 'cancel', 'forget', "don't", 'dont', 'do', 'drop', 'request', 'message', 'actually', 'anything']);

/** Everything an answer to "main chat, or the … thread?" may say, besides a thread's title words. */
const ANSWER_WORDS = new Set([
  'main', 'chat', 'channel', 'top', 'level', 'general', 'dm', 'neither', 'no', 'not', 'thread', 'one', 'first', 'second', 'third', 'last', 'other',
  'can', 'could', 'would', 'will', 'you', 'i', "i'd", 'like', 'want', 'meant', 'mean', 'should', 'be', 'goes', 'belongs', 'use', 'for', 'me',
  'the', 'a', 'an', 'that', 'this', 'it', 'in', 'into', 'to', 'there', 'just', 'um', 'uh', 'ok', 'okay', 'yeah', 'yes', 'so', 'please', 'go', 'with', 'put', 'send', "it's", 'its', 'oh', 'hmm', 'mm',
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The answer to "<Agent>'s main chat, or the <title> thread?". Main: "main", "chat", "channel",
 * "top level", "neither", "the first". A thread: words of its title, "the thread", "that one" (when
 * there is one thread), "the second". "Never mind" cancels. Anything else is unclear.
 */
export function matchDestinationAnswer(text: string, options: DestinationOption[]): DestinationAnswer {
  const said = words(text);
  const joined = ` ${said.join(' ')} `;
  if (said.length === 0) return { kind: 'unclear' };
  // A cancel only when nothing else is asked for: "cancel that and tell Victor…" is a new request.
  const CANCEL = / (?:never ?mind|cancel(?: it| that)?|forget (?:it|that)|don'?t send(?: it| that)?|drop (?:it|that)) /;
  if (said.length <= 10 && CANCEL.test(joined) && said.every((word) => ANSWER_WORDS.has(word) || CANCEL_WORDS.has(word))) return { kind: 'cancel' };
  // Only a standalone answer counts: every word is answer vocabulary or a word of a thread's title.
  // A new request ("open the trailer doc", "tell Victor to check the chat logs") is not an answer.
  const titleWords = new Set(options.flatMap((option) => words(option.title)));
  if (said.length > 8 || !said.every((word) => ANSWER_WORDS.has(word) || titleWords.has(word))) return { kind: 'unclear' };
  // "the first thread" / "the second thread" count among the threads offered; a bare "first" is the main chat (said first).
  const ordinal = joined.match(/ (first|second|third|last) thread /);
  if (ordinal) {
    const at = ordinal[1] === 'last' ? options.length - 1 : ['first', 'second', 'third'].indexOf(ordinal[1]!);
    return options[at] ? { kind: 'thread', threadId: options[at]!.threadId } : { kind: 'unclear' };
  }
  const main = / (?:main|chat|channel|top level|top|neither|no thread|not (?:in )?(?:a |the |that )?thread|first(?: one)?|dm) /.test(joined);
  // Title words, scored per option; a tie between two threads is no match.
  // A title word that is also answer vocabulary ("Chat logs", "Main dashboard") doesn't name the thread
  // on its own; the title's other words do, and then the thread wins over "main"/"chat".
  // "not the Dock lines thread": a title said after "not" rules that thread out.
  const negated = new Set(
    options.filter((option) => new RegExp(` not (?:in |into )?(?:the |that )?${words(option.title).join(' ')} `).test(joined)).map((option) => option.threadId),
  );
  const scored = options
    .filter((option) => !negated.has(option.threadId))
    .map((option) => ({ option, hits: words(option.title).filter((word) => !STOP.has(word) && !ANSWER_WORDS.has(word) && said.includes(word)).length }))
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  let titled = scored.length > 0 && (scored.length === 1 || scored[0]!.hits > scored[1]!.hits) ? scored[0]!.option : undefined;
  // A title made only of answer words ("Chat") is named by the whole title plus "thread": "the chat thread".
  if (!titled) {
    const whole = options.filter((option) => !negated.has(option.threadId) && joined.includes(` ${words(option.title).join(' ')} thread `));
    if (whole.length === 1) titled = whole[0];
  }
  if (titled) return { kind: 'thread', threadId: titled.threadId };
  if (main && !titled) return { kind: 'main' };
  if (!main && !titled && options.length === 1 && / (?:thread|that one|the other(?: one)?|second(?: one)?|last one|there) /.test(joined)) {
    return { kind: 'thread', threadId: options[0]!.threadId };
  }
  if (!main && !titled && options.length === 2) {
    if (/ second(?: one)? /.test(joined)) return { kind: 'thread', threadId: options[0]!.threadId };
    if (/ (?:third|last)(?: one)? /.test(joined)) return { kind: 'thread', threadId: options[1]!.threadId };
  }
  return { kind: 'unclear' };
}

/** The spoken question: "Sierra's main chat, or the Bluetooth Speaker thread?" */
/** The answer as one key for the shadow decision model: main, cancel, unclear or thread:<id>. */
export function destinationAnswerKey(answer: DestinationAnswer): string {
  return answer.kind === 'thread' ? `thread:${answer.threadId}` : answer.kind;
}

/** "Main chat, or the … thread?" as one choice for the shadow decision model (it never routes anything). */
export function destinationDecisionPrompt(speech: string, agentName: string, options: DestinationOption[]): DecisionPrompt {
  const criteria: Record<string, string> = { main: `Send it to ${agentName}'s main chat` };
  for (const option of options.slice(0, 250)) criteria[`thread:${option.threadId}`] = `Send it to the "${option.title}" thread`;
  criteria.cancel = 'Drop the request: send nothing';
  criteria.unclear = 'Not an answer to the question: a new request or something else';
  return {
    state: { question: destinationQuestion(agentName, options), owner_reply: speech.slice(0, 1000) },
    questions: { answer: { type: 'choice', instructions: 'The assistant asked the owner where a request should go. Which destination does the owner\'s spoken reply choose?', criteria } },
  };
}

export function destinationQuestion(agentName: string, options: DestinationOption[]): string {
  const threads = options.map((option) => `the ${option.title} thread`);
  return `${agentName}'s main chat, or ${threads.join(', or ')}?`;
}

export class DestinationAsk {
  private heldSend: HeldDestination | null = null;

  constructor(private readonly options: { now: () => number; holdMs?: number }) {}

  /** The held request, while it is still waiting for an answer. */
  get held(): HeldDestination | null {
    return this.heldSend && !this.isExpired(this.heldSend) ? this.heldSend : null;
  }

  /** Keeps a pending question alive (while paused): the clock restarts from now. */
  touch(): void {
    if (this.heldSend) this.heldSend = { ...this.heldSend, at: this.options.now() };
  }

  /** Drops a request that went unanswered too long, returning it (once) so the caller can trace it. */
  expire(): HeldDestination | null {
    if (!this.heldSend || !this.isExpired(this.heldSend)) return null;
    const expired = this.heldSend;
    this.heldSend = null;
    return expired;
  }

  private isExpired(held: HeldDestination): boolean {
    return this.options.now() - held.at > (this.options.holdMs ?? 120_000);
  }

  hold(entry: Omit<HeldDestination, 'at'>): void {
    this.heldSend = { ...entry, at: this.options.now() };
  }

  /** The held request, or null when there is none or it went unanswered too long (it is dropped). */
  take(): { held: HeldDestination; expired: boolean } | null {
    const held = this.heldSend;
    if (!held) return null;
    this.heldSend = null;
    return { held, expired: this.isExpired(held) };
  }

  clear(): void {
    this.heldSend = null;
  }
}

/** The held dispatch, sent where the answer says. */
export function withDestination(action: Dispatch, threadId: string | null): Dispatch {
  const { threadOptions: _options, threadId: _thread, newThreadTitle: _title, ...rest } = action;
  return threadId ? { ...rest, threadId } : rest;
}
