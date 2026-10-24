import type { DeskNextItem } from './desk-client.js';

// Next up: the owner works through what is waiting on them, oldest first.
//
//   advance  "next one", "next up", "on to the next one", "go to the next one", "next item" open the
//            oldest item in the queue (GET /api/desk/next) other than the one open now or just sent
//            to, and start a draft for it (the pick path: it opens, a refresher plays, dictation targets it).
//   list     "what's next", "what's up", "what's waiting", "what do I have", "what's left" put the board
//            up and speak a short summary: how many, then up to three in queue order with how long each
//            has waited. "The second one" or "the speaker one" then picks from that list.
//   closers  "I'm done, next one", "send it and go to the next one", "send it, what's next": the draft
//            finishes as usual, and the advance (or list) runs once the send has actually gone out.
//
// Matching is deterministic and whole-utterance (or a trailing cue on a finish phrase), so dictation
// that merely contains "next" ("the next one should be red") stays dictation.

export type NextOp = 'advance' | 'list';
export const NEXT_OPS: readonly NextOp[] = ['advance', 'list'];

/** Lowercased words, apostrophes kept, punctuation gone (as draft-mode's normalizeSpeech). */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const LEAD = "(?:(?:ok|okay|alright|all right|so|right|great|cool|good|perfect|yeah|yep|and|then|now|um|uh|oh)\\s+)*";
const ADVANCE =
  "(?:next (?:one|up|item|thing|conversation)|(?:let'?s |let us |can we |could we )?(?:go |move |head |skip |jump )?(?:on to|onto|to) the next(?: (?:one|item|thing|conversation))?|(?:let'?s )?move on to the next(?: one)?)";
/** "Next" alone: only when it can't be dictation (addressed to the operator, or nothing drafted yet). */
const BARE = '(?:next(?: please)?)';
const LIST =
  "(?:what(?:'?s| is) (?:next|up|available|left|waiting(?: (?:on|for) me)?)|what do i (?:have|got)(?: (?:left|waiting|next))?|what have i got(?: left)?)";
const TAIL = '(?:\\s+(?:please|thanks|thank you|then|now|for me))*';

const ADVANCE_WHOLE = new RegExp(`^${LEAD}${ADVANCE}${TAIL}$`);
const BARE_WHOLE = new RegExp(`^${LEAD}${BARE}$`);
const LIST_WHOLE = new RegExp(`^${LEAD}${LIST}${TAIL}$`);
// A cue at the end of something else: "I'm done, next one", "send it and go to the next one", "send it, what's next".
const TRAILING = new RegExp(`^(.+?)\\s+(?:(?:and|then|so|okay|ok|now)\\s+)*(${ADVANCE}|${BARE}|${LIST})${TAIL}$`);

/**
 * A whole utterance that is a next-up command: "next one", "on to the next one" (advance), "what's
 * next", "what's waiting on me" (list). A bare "next" counts only with `bare` (the caller knows it was
 * addressed to the operator, or nothing has been drafted).
 */
export function matchNextCommand(speech: string, options: { bare?: boolean } = {}): NextOp | null {
  const text = normalize(speech);
  if (!text || text.split(' ').length > 10) return null;
  if (ADVANCE_WHOLE.test(text) || (options.bare && BARE_WHOLE.test(text))) return 'advance';
  if (LIST_WHOLE.test(text)) return 'list';
  return null;
}

/**
 * A next-up cue at the end of other words ("I'm done, next one" → rest "I'm done,", advance). `rest`
 * keeps the original wording (punctuation and all) so a finish matcher can read it. Null when the
 * utterance doesn't end on a cue, or is only the cue.
 */
export function splitNextCue(speech: string): { rest: string; op: NextOp } | null {
  const text = normalize(speech);
  const match = TRAILING.exec(text);
  if (!match) return null;
  const restWords = match[1]!.split(' ').length;
  const cue = match[2]!;
  const op: NextOp = new RegExp(`^${LIST}$`).test(cue) ? 'list' : 'advance';
  // Back over the original tokens until the cue's words (and its connectors) are gone.
  const tokens = speech.trim().split(/\s+/);
  let words = 0;
  let cut = 0;
  for (const [index, token] of tokens.entries()) {
    if (words >= restWords) break;
    words += normalize(token).split(' ').filter(Boolean).length;
    cut = index + 1;
  }
  const rest = tokens.slice(0, cut).join(' ').trim();
  return rest ? { rest, op } : null;
}

// ── the spoken summary ───────────────────────────────────────────────────

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 0–99 in words ("twenty-five"); digits beyond. */
export function numberWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 99) return String(n);
  if (n < 20) return ONES[n]!;
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ''}`;
}

/** How long something has waited, in plain spoken words: "a minute", "twenty minutes", "about an hour", "three days". */
export function spokenWait(ms: number): string {
  const minutes = Math.max(0, ms) / 60_000;
  if (minutes < 1.5) return 'about a minute';
  if (minutes < 10) return `${numberWords(Math.round(minutes))} minutes`;
  if (minutes < 55) return `${numberWords(Math.round(minutes / 5) * 5)} minutes`;
  const hours = minutes / 60;
  if (hours < 1.5) return 'about an hour';
  if (hours < 22) return `about ${numberWords(Math.round(hours))} hours`;
  const days = hours / 24;
  if (days < 1.5) return 'about a day';
  return `${numberWords(Math.round(days))} days`;
}

/** A place as said aloud: without a Loom repo label or a type prefix ("demo · watch: Lantern Row" → "Lantern Row"). */
function spokenPlace(place: string | null): string | null {
  if (!place) return null;
  const title = place.includes('·') ? place.slice(place.lastIndexOf('·') + 1) : place;
  return title.replace(/^\s*[a-z]{2,10}:\s*/i, '').trim() || null;
}

function clipWords(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max).replace(/\s+\S*$/, '')}…` : flat;
}

/** "Sierra on Bike speaker": who, and what it is about (title, else place, else the ask). */
export function spokenItem(item: Pick<DeskNextItem, 'agentName' | 'title' | 'place' | 'ask' | 'step' | 'pill'>): string {
  const topic = item.title?.trim() || spokenPlace(item.place) || (item.ask ? clipWords(item.ask, 60) : null);
  const who = item.pill === 'stuck' ? `${item.agentName} is stuck: it said it would keep going, but nothing is running` : item.step === 'failed' ? `${item.agentName}'s failed turn` : item.agentName;
  return topic ? `${who} on ${topic}` : who;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The list said aloud: the count, then up to three in queue order with their waits, and how to go on.
 * "Three are waiting on you. Longest: Sierra on Bike speaker, about an hour. Then Loom on memory fixes,
 * twenty minutes, and Victor on the deploy, five minutes. Say "next one" to start, or name one."
 */
export function nextSummary(items: Array<Pick<DeskNextItem, 'agentName' | 'title' | 'place' | 'ask' | 'step' | 'pill' | 'waitingSince'>>, now: number): string {
  if (items.length === 0) return 'Nothing is waiting on you.';
  const said = items.slice(0, 3).map((item) => `${spokenItem(item)}, ${spokenWait(now - item.waitingSince)}`);
  if (items.length === 1) return `One is waiting on you: ${said[0]}. Say "next one" to start it.`;
  const head = `${capitalize(numberWords(items.length))} are waiting on you. Longest: ${said[0]}.`;
  const then = said.length === 2 ? ` Then ${said[1]}.` : ` Then ${said[1]}, and ${said[2]}.`;
  const more = items.length > 3 ? ` Plus ${numberWords(items.length - 3)} more.` : '';
  return `${head}${then}${more} Say "next one" to start, or name one.`;
}

// ── router hooks (task-extractor.ts) ─────────────────────────────────────

/** Lines for the router prompt (outside draft mode, with a desk). */
export function nextRouterLines(): string[] {
  return [
    '- next with next_op advance: the user wants to move on to the next thing waiting on them ("next one", "next up", "on to the next one", "go to the next one", "next item", "Yankee, next"): the operator opens the oldest item waiting on them. "Next step" / "next slide" on a step guide or slideshow that is showing is screen next, not this.',
    '- next with next_op list: the user asks what is waiting or what is next without naming anything ("what\'s next", "what\'s up", "what\'s available", "what\'s waiting on me", "what do I have", "what\'s left"): the operator reads a short list of what waits on them. "Catch me up" and "what\'s on my desk" (a fuller rundown) stay remind.',
  ];
}

export function parseNextOp(op: string | undefined): NextOp | null {
  return NEXT_OPS.find((candidate) => candidate === op) ?? null;
}
