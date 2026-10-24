/** Shared speech rules. No clocks, IO, or model dependencies. */
export const TURN = { pauseMs: 1500, unfinishedPauseMs: 4000, undoMs: 3000,
  rambleNudgeMs: 90_000, rambleCapMs: 600_000 } as const;

/** Structural agent identity keeps phrase matching independent of the operator. */
interface PhraseAgent { id: string; name: string; aliases?: string[] }

export const FINISH_CUE = /\b(?:send|sent|done|finish|finished|that'?s (?:it|all|everything)|go ahead|ship|ready|wrap|over to you|cancel|discard|scrap|never ?mind|submit|post it|fire it off)\b/;

/** Lowercased words, apostrophes kept, punctuation gone. */
export function normalizeSpeech(text: string): string {
  return text.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function wordCount(text: string): number {
  return text ? text.split(' ').length : 0;
}

function escapeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
}

/** The agent named in these words, if exactly one is. */
export function namedAgent<T extends PhraseAgent>(text: string, agents: T[]): T | undefined {
  const lower = ` ${normalizeSpeech(text)} `;
  const hits = agents.filter((agent) =>
    [agent.name, ...(agent.aliases ?? [])].map(escapeName).filter(Boolean).some((name) => new RegExp(`\\b${name}\\b`).test(lower)),
  );
  // "sierra" and "sierra-ollama" are one persona: the first listed wins.
  const personas = new Map<string, T>();
  for (const hit of hits) if (!personas.has(hit.id.replace(/-ollama$/, ''))) personas.set(hit.id.replace(/-ollama$/, ''), hit);
  return personas.size === 1 ? [...personas.values()][0] : undefined;
}


/** The operator's name, "Yankee" (ASR: "Yanky", "Yankees", "Yankee's"), and the legacy "Tango". */
export const OPERATOR_NAME_PATTERN = "(?:yankee(?:'s|s)?|yanky|tango(?:'s)?)";
/** "Yankee, over" / "Yankee out" / "Yankee, done": the radio-style sign-off. */
const OPERATOR_SIGNOFF = `(?:(?:hey|hi|ok|okay) )?${OPERATOR_NAME_PATTERN} (?:over(?: and out)?|out|done|i'?m done)`;
const FINISH_CORE =
  `(?:send it|send that|send this|send the (?:draft|message|note)|send it off|send it over|that'?s it|that'?s all|that'?s everything|that'?s the message|go ahead|go for it|ship it|(?:i'?m |i am |okay |ok )?(?:all )?done|(?:i'?m |i am )?finished|finish (?:the )?draft|end (?:the )?draft|wrap it up|over to you|${OPERATOR_SIGNOFF})`;
const FINISH_LEAD = "(?:(?:ok(?:ay)?|alright|all right|right|so|yeah|yep|great|good|cool|and|um|uh)\\s+)*";
const FINISH_TAIL = "(?:\\s+(?:and\\s+)?(?:send (?:it|that|this)(?: off| over)?|go ahead|thanks|thank you|please|now))*";

/**
 * "Okay, send it", "that's it, go ahead", "done, send that to Sierra": the whole utterance (or its
 * last sentence) is a finish. Returns the content before it and an agent named in it.
 */
/** Bracketed ASR tags ("[sniff]", "[BLANK_AUDIO]", an unclosed "[sniff") and leading "mm" / "um" the transcript runs in. */
const ASR_TAGS = /\[[^\]]*\]|\[\S*/g;
const LEADING_FILLER = /^(?:\s*(?:m+|mm+|mhm+|mm-?hm+|hm+|hmm+|um+|uh+|ah+|er+)[\s,.!?]+)+/i;
export function stripAsrNoise(speech: string): string {
  return speech.replace(ASR_TAGS, ' ').replace(/\s+/g, ' ').trim().replace(LEADING_FILLER, '').trim();
}

const SIGNOFF_NAME = new RegExp(`\\b${OPERATOR_NAME_PATTERN}\\b`);

/** `signoff`: the closer was the operator sign-off ("Yankee, over"), not an ordinary one. */
export function matchFinish<T extends PhraseAgent = PhraseAgent>(speech: string, agents: T[] = []): { content: string; agent?: T; signoff?: true } | null {
  // "Mm go ahead", "[sniff] I'm done": the noise ahead of the closer isn't content.
  speech = stripAsrNoise(speech);
  const pattern = new RegExp(`^${FINISH_LEAD}${FINISH_CORE}${FINISH_TAIL}(?:\\s+(?:to|for)\\s+([a-z0-9' -]{1,30}))?${FINISH_TAIL}$`);
  const sentences = speech.split(/(?<=[.!?,])\s+/).filter((sentence) => normalizeSpeech(sentence));
  // Try the longest tail of sentences that is a finish phrase on its own.
  for (let start = 0; start < sentences.length; start++) {
    // Filler ahead of the closer within the turn ("add the red one. Mm go ahead") isn't content either (Codex review on #445).
    const tail = normalizeSpeech(stripAsrNoise(sentences.slice(start).join(' ')));
    if (wordCount(tail) > 9) continue;
    const match = pattern.exec(tail);
    if (!match) continue;
    let agent: T | undefined;
    if (match[1]) {
      agent = namedAgent(match[1], agents);
      if (!agent) continue; // "send it to the printer": not a name, so not a finish phrase
    }
    return { content: sentences.slice(0, start).join(' ').trim(), ...(agent ? { agent } : {}), ...(SIGNOFF_NAME.test(tail) ? { signoff: true as const } : {}) };
  }
  // Run together with the last words and no punctuation ("…bring the drill okay send it"): a tail of
  // words, only one opened by okay / alright, so dictation like "…they should send it" never ends a draft.
  const tokens = speech.trim().split(/\s+/);
  for (let start = 1; start < tokens.length; start++) {
    const tail = normalizeSpeech(tokens.slice(start).join(' '));
    if (!tail || wordCount(tail) > 9 || !/^(?:ok|okay|alright|all right)\b/.test(tail)) continue;
    const match = pattern.exec(tail);
    if (!match) continue;
    let agent: T | undefined;
    if (match[1]) {
      agent = namedAgent(match[1], agents);
      if (!agent) continue;
    }
    return { content: tokens.slice(0, start).join(' ').replace(/[\s,;:]+$/, '').trim(), ...(agent ? { agent } : {}), ...(SIGNOFF_NAME.test(tail) ? { signoff: true as const } : {}) };
  }
  return null;
}

/**
 * The dictation before a finish cue the router recognized but didn't hand back ("and bring the drill
 * I think that's ready to fire off" → "and bring the drill"): what precedes a cue in the last six words.
 */
export function contentBeforeFinish(speech: string): string {
  const tokens = speech.trim().split(/\s+/);
  for (let start = Math.max(1, tokens.length - 6); start < tokens.length; start++) {
    if (!FINISH_CUE.test(normalizeSpeech(tokens.slice(start).join(' ')))) break;
    if (FINISH_CUE.test(normalizeSpeech(tokens.slice(start + 1).join(' ')))) continue;
    // tokens[start] begins the last cue: back up over lead-ins ("okay", "I think that's ready to").
    let cut = start;
    while (cut > 0 && /^(?:ok|okay|alright|right|so|and|i|think|reckon|guess|it|it'?s|that|that'?s|this|is|ready|to|now|um|uh)$/.test(normalizeSpeech(tokens[cut - 1]!))) cut -= 1;
    const content = tokens.slice(0, cut).join(' ').replace(/[\s,;:]+$/, '').trim();
    return wordCount(normalizeSpeech(content)) >= 2 ? content : '';
  }
  return '';
}

// Destructive commands match the whole utterance, with only filler around them: dictation that merely
// contains "never mind" or "cancel the meeting" is content (or a self-correction), never a discard.
const CANCEL_FILLER = "(?:(?:ok|okay|actually|wait|no|nah|nope|um|uh|oh|so|hmm|right|just|please|you know what)\\s+)*";
const CANCEL_END = "(?:\\s+(?:then|thanks|thank you|please|now|for now))*";
const CANCEL_ANYTIME = new RegExp(
  `^${CANCEL_FILLER}(?:(?:cancel|discard|scrap|forget|drop|delete|ditch|kill|throw away|bin) (?:the |this |that |my )?(?:whole )?(?:draft|message|note)|(?:exit|leave|stop|end|get out of|turn off|cancel) (?:the )?(?:draft|confirm) mode|stop drafting)${CANCEL_END}$`,
);
const CANCEL_LISTENING = new RegExp(`^${CANCEL_FILLER}(?:cancel|never ?mind|forget it)${CANCEL_END}$`);
const CANCEL_PHRASE = "(?:cancel|cancel (?:it|that)|never ?mind|forget it|forget (?:about )?(?:it|that)|scratch (?:it|that)|scrap (?:it|that)|don'?t (?:send|start) (?:it|that|anything|one)|don'?t bother|nothing|leave it)";
// One or several ("actually, never mind, don't start it": live audio test 10/18, answering "In tango, or with an agent?").
const CANCEL_SHORT = new RegExp(`^${CANCEL_FILLER}${CANCEL_PHRASE}(?:\\s+${CANCEL_FILLER}${CANCEL_PHRASE})*${CANCEL_END}$`);

/** A cancel. While listening only an explicit one ("cancel the draft"); "scratch that" there is a self-correction. */
export function isDraftCancel(speech: string, phase: 'listening' | 'confirm'): boolean {
  const text = normalizeSpeech(speech);
  if (!text) return false;
  if (CANCEL_ANYTIME.test(text)) return true;
  return phase === 'listening' ? CANCEL_LISTENING.test(text) : CANCEL_SHORT.test(text);
}

const HOLD = /^(?:(?:no|nope|not yet|wait|hold on|hang on|ok(?:ay)?|so)\s*)*(?:keep (?:holding|going|listening)(?: (?:it|on to it|onto it))?|hold (?:it|on|that|onto it)|hang on|not yet|i'?m not (?:done|finished)(?: yet)?|still going|one sec(?:ond)?|give me a (?:sec(?:ond)?|minute|moment)|wait|(?:this|it)(?:'s| is| will be|'ll be) a (?:long|longer|big) one|long one|let me think(?: (?:out loud|this through|about it))?|i'?m (?:going|gonna) (?:to )?(?:ramble|think out loud)(?: for a (?:bit|minute|sec))?)$/;

/** Dictation that opens by saying it'll take a while ("I'm going to think out loud here, so…"): it joins the draft, and only a closer sends it. */
const LONG_LEAD = /^(?:(?:ok(?:ay)?|so|alright|all right|um|uh|well|mm)\s+)*(?:(?:i'?m (?:going|gonna) (?:to )?|let me |i want to |i'?d like to |i need to )(?:think (?:this |it |that )?(?:out loud|aloud|through)|ramble|talk (?:this |it |that )?through)|(?:this|it)(?:'s| is| will be|'ll be) (?:going to be |gonna be )?a (?:long|longer|big) one|bear with me)\b/;

export function opensLong(speech: string): boolean {
  return LONG_LEAD.test(normalizeSpeech(stripAsrNoise(speech)));
}

/** "Keep holding", "not yet", "I'm not done": stay in draft mode, nothing added. */
export function isHold(speech: string): boolean {
  const text = normalizeSpeech(speech);
  return !!text && wordCount(text) <= 7 && HOLD.test(text);
}

const UNDO = new RegExp(
  `^${CANCEL_FILLER}(?:undo|undo (?:it|that)|wait|hold on|hang on|stop|cancel|cancel (?:it|that)|don'?t send (?:it|that)|not yet|scratch that)(?:\\s+(?:wait|stop|undo|please|don'?t send (?:it|that)))*${CANCEL_END}$`,
);

/** "Undo", "wait", "cancel", "don't send it": stop a send that is waiting out its undo window. */
export function isUndo(speech: string): boolean {
  const text = normalizeSpeech(speech);
  return !!text && wordCount(text) <= 8 && UNDO.test(text);
}


/** A last word that leaves the sentence hanging. Kept small on purpose: a complete short command is never held. */
const DANGLING = new Set(['and', 'but', 'or', 'because', 'cause', 'um', 'uh', 'er', 'erm', 'hmm', 'umm', 'uhh', 'the', 'a', 'an', 'of', 'if', 'whether', 'my', 'your', 'our', 'plus', 'so']);
const SO_COMPLETE = new Set(['think', 'hope', 'guess', 'believe', 'say', 'said', 'do', 'not', 'suppose', 'told', 'thought', 'hoped']);
/** Words that carry no request on their own: a fragment made only of these (and names) is not a command. */
export const FUNCTION_WORDS = new Set([
  'and', 'but', 'or', 'so', 'because', 'um', 'uh', 'er', 'erm', 'hmm', 'like', 'the', 'a', 'an', 'of', 'to', 'for', 'with', 'about', 'if', 'then', 'also', 'okay', 'ok',
  'well', 'actually', 'basically', 'i', 'i\'m', 'we', 'it', 'that', 'this', 'just', 'maybe', 'mean', 'you', 'know', 'hey', 'oh', 'yeah', 'right', 'now', 'plus', 'my', 'your', 'our',
]);

export interface UnfinishedSignals {
  /** The router flagged the speech as cut off (draft unfinished). */
  flagged?: boolean;
  /** The action is new work (dispatch), not an answer to something asked. */
  dispatch?: boolean;
  /** Any of the sends is new work (a reply may ride along): the router's flag counts. */
  newWork?: boolean;
  /** Agent names (lowercase), which alone don't make a request. */
  names?: string[];
}

/**
 * Speech that sounds unfinished: it ends on a comma / dash / ellipsis or a dangling word ("and",
 * "um", "the"); or the router flagged new work with no closing punctuation; or it is a new-work
 * fragment of three words or fewer made only of filler and names ("so, for Sierra"). "Tell Malibu I
 * had eggs" and "lights on" are never held.
 */
export function looksUnfinished(speech: string, signals: UnfinishedSignals = {}): boolean {
  const raw = speech.trim();
  if (!raw) return false;
  if (/(?:,|…|\.\.\.|\s-|-|—|–)\s*$/.test(raw)) return true;
  const endsTerminal = /[.?!]["')\]]*$/.test(raw) && !/\.\.\.$/.test(raw);
  const words = normalizeSpeech(raw).split(' ').filter(Boolean);
  const last = words.at(-1) ?? '';
  if (DANGLING.has(last) && !(last === 'so' && SO_COMPLETE.has(words.at(-2) ?? ''))) return true;
  // The router's flag alone holds only new work. Replies and answers to an agent's question run
  // long and ramble, and the flag misfired on complete ones, so they are held only for a hard cue: trailing punctuation or a dangling word.
  if (signals.flagged && (signals.newWork ?? signals.dispatch) && !endsTerminal) return true;
  const names = new Set((signals.names ?? []).flatMap((name) => normalizeSpeech(name).split(' ')));
  if (signals.dispatch && words.length <= 3 && !endsTerminal && words.every((word) => FUNCTION_WORDS.has(word) || names.has(word))) return true;
  return false;
}


/** Anchored at the start: quoted or later mentions are ordinary dictation. */
export const RAMBLE_START = /^(?:(?:hey|hi|ok(?:ay)?|so|alright|all right|um|uh|well|mm)\s+)*(?:(?:i'?m (?:going to|gonna)|i am going to|let me|i want to|i'?d like to|i need to) (?:ramble(?: for a (?:minute|bit|while|sec(?:ond)?))?|talk for a (?:while|minute|bit)|think (?:this |it |that )?(?:out loud|aloud|through)|talk (?:this |it |that )?through)|(?:this|it)(?:'s| is| will be|'ll be) (?:going to be |gonna be )?a (?:long|longer|big) one|bear with me|let me get (?:this|it) all out)\b/;

export function opensRamble(firstSentence: string): boolean {
  return opensLong(firstSentence) || RAMBLE_START.test(normalizeSpeech(stripAsrNoise(firstSentence)));
}

export function announcesMore(text: string): boolean {
  return /(?:\b(?:a few|a couple of|several|some|two|three) things|\b(?:first|second|third|next)(?: of all)?|\bhere(?:'s| is) what i (?:noticed|think|found)|\bone more thing)\s*[:,.!?…-]*$/i.test(normalizeSpeech(text));
}

export type TurnMode = 'quick' | 'ramble';
export type TurnDecision =
  | { kind: 'finish'; text: string }
  | { kind: 'cancel' }
  | { kind: 'wait'; untilMs?: number; mode: TurnMode; nudge?: true };

/** One instance per turn. The caller supplies elapsed quiet time, never wall time. */
export class TurnPolicy {
  private currentMode: TurnMode = 'quick';
  private segments: string[] = [];
  private paused = false;
  private nudged = false;

  constructor(private readonly opts: { ramble?: boolean } = {}) {}

  /** Append deltas verbatim (including their spaces), or a whole segment per pause.
   * This accepts incremental text, not cumulative transcript snapshots.
   * `continues` keeps a late delta in the segment a previous late delta of the same pause started.
   */
  words(text: string, continues = false): void {
    if (!text) return;
    if ((this.paused && !continues) || !this.segments.length) this.segments.push(text);
    else this.segments[this.segments.length - 1] += text;
    this.paused = false;
  }

  mode(): TurnMode { return this.currentMode; }

  pause(quietMs: number, by: 'local' | 'model'): TurnDecision {
    this.paused = true;
    const last = this.segments.at(-1) ?? '';
    if (isDraftCancel(last, 'listening')) return { kind: 'cancel' };
    if (this.currentMode === 'ramble') {
      const finish = matchFinish(last);
      if (finish) {
        this.segments[this.segments.length - 1] = finish.content;
        return this.explicitFinish();
      }
      return this.holding(quietMs);
    }
    if (this.opts.ramble !== false && (isHold(last) || opensRamble(this.segments[0] ?? ''))) {
      this.currentMode = 'ramble';
      return this.holding(quietMs);
    }
    const text = this.text();
    if ((looksUnfinished(text) || announcesMore(text)) && quietMs < TURN.unfinishedPauseMs) {
      return { kind: 'wait', untilMs: TURN.unfinishedPauseMs, mode: this.currentMode };
    }
    // Local checks can arrive before the threshold; a model end is sufficient in quick mode.
    if (!normalizeSpeech(text) || (by === 'local' && quietMs < TURN.pauseMs)) {
      return { kind: 'wait', untilMs: TURN.pauseMs, mode: this.currentMode };
    }
    return this.explicitFinish();
  }

  explicitFinish(): { kind: 'finish'; text: string } {
    return { kind: 'finish', text: this.text() };
  }

  private holding(quietMs: number): TurnDecision {
    if (!this.nudged && quietMs >= TURN.rambleNudgeMs) {
      this.nudged = true;
      return { kind: 'wait', mode: 'ramble', nudge: true };
    }
    return { kind: 'wait', mode: 'ramble' };
  }

  private text(): string {
    const text = this.segments.map((segment) => segment.trim()).filter(Boolean).join(' ');
    if (this.opts.ramble === false) return text;
    // Strip only a complete first-sentence preamble, never its same-sentence dictation.
    const first = (this.segments[0] ?? '').trim().match(/^.*?(?:[.!?](?:\s|$)|$)/)?.[0].trim() ?? '';
    const normalized = normalizeSpeech(stripAsrNoise(first));
    const preamble = RAMBLE_START.exec(normalized);
    return preamble && preamble[0] === normalized ? text.slice(first.length).trim() : text;
  }
}
