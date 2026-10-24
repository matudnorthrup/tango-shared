import { spokenWait } from './next-up.js';
import type { CatchupWalk, CatchupWalkFocus } from './desk-client.js';

// Catch me up by voice (docs/specs/catch-up.md, "Voice"): the words that drive the walk while it's on, and what the
// operator says for the focus card and the map. Pure, so the tests read them without a session.

export type CatchupOp =
  /** Heard: on to the next moment (the one heard is marked seen). */
  | { op: 'next' }
  /** On to the next one, this one left unseen. */
  | { op: 'skip' }
  /** A brief's option by its key ("go with A"), or the one it recommends (key null). */
  | { op: 'pick'; key: string | null }
  /** "That's fine": Fine by me on a decision; on anything else, Got it. */
  | { op: 'fine' }
  | { op: 'gotit' }
  /** Accept a space's chapter: the one named, else the focus card's. */
  | { op: 'accept'; space: string | null }
  /** "Skip this project": Defer the focus card's space. */
  | { op: 'defer' }
  /** "What's left?": the map, per space. */
  | { op: 'left' }
  /** "Go to <space>": its first moment. */
  | { op: 'goto'; space: string }
  | { op: 'stop' };

const POLITE = /^(?:(?:ok|okay|alright|all right|yes|yeah|sure|cool|great|good|and|then|so|um|uh|please)[\s,.!]+)*/;
const TAIL = /(?:[\s,.!]+(?:please|thanks|thank you|then))*[\s.!?]*$/;

/**
 * A walk command from what the owner said (lowercased), or null for anything else: that goes on to the usual routes.
 * Only while a walk is on; the words are the spec's, kept tight so a sentence that only mentions them isn't one.
 */
export function matchCatchupCommand(text: string): CatchupOp | null {
  const t = text.toLowerCase().replace(POLITE, '').replace(TAIL, '').trim();
  if (/^(?:skip|pass on|defer) (?:this|the|that) (?:project|space|place|one's project)$/.test(t)) return { op: 'defer' };
  if (/^(?:skip|skip (?:it|this|that|this one|that one)|not now|later)$/.test(t)) return { op: 'skip' };
  if (/^(?:next|next one|the next one|on to the next(?: one)?|go on|keep going|carry on|moving on)$/.test(t)) return { op: 'next' };
  const pick = /^(?:(?:let'?s |i'?ll )?(?:go with|pick|choose|take|do)|option) (?:option )?([a-f])$/.exec(t);
  if (pick) return { op: 'pick', key: pick[1]!.toUpperCase() };
  if (/^(?:go with|pick|choose|take|do) (?:your pick|the recommended one|the recommendation|what you(?:'d| would) pick|your recommendation)$/.test(t)) return { op: 'pick', key: null };
  if (/^(?:that'?s fine|that is fine|fine by me|fine|sounds good|that'?s ok(?:ay)?)$/.test(t)) return { op: 'fine' };
  if (/^(?:got it|gotcha|understood|noted)$/.test(t)) return { op: 'gotit' };
  const accept = /^accept(?: (?:the )?(.+?))?$/.exec(t);
  if (accept) return { op: 'accept', space: accept[1] && !/^(?:it|this|that|this one|that one|all|everything|this project|that project)$/.test(accept[1]) ? accept[1].replace(/ (?:project|space)$/, '') : null };
  if (/^(?:what'?s|what is) (?:left|still left|remaining|still waiting)$/.test(t)) return { op: 'left' };
  const go = /^(?:go to|jump to|take me to|open) (?:the )?(.+?)(?: project| space)?$/.exec(t);
  if (go) return { op: 'goto', space: go[1]! };
  if (/^(?:stop|that'?s enough|enough|done for now|i'?m done|we'?re done|stop the catch ?up)$/.test(t)) return { op: 'stop' };
  return null;
}

const KIND: Record<CatchupWalkFocus['line']['kind'], string> = { needs: 'needs you', failed: 'failed', decided: 'decided for you', shipped: 'finished', fyi: 'for your information' };
const clean = (text: string) => text.replace(/\s+/g, ' ').trim().replace(/[.?!]+$/, '');

/** What the operator says for the focus card: the space, the kind, the title, a brief's options with its pick. */
export function speakFocus(focus: CatchupWalkFocus): string {
  const words = focusWords(focus);
  return focus.plan?.line ? `${words} Accept: ${focus.plan.line}` : words;
}
function focusWords(focus: CatchupWalkFocus): string {
  const { line, brief } = focus;
  const head = `${focus.name}, ${KIND[line.kind] ?? line.kind}: ${clean(brief?.ask ?? line.title)}.`;
  if (line.kind === 'needs' && brief?.options.length) {
    const options = brief.options.map((o) => `${o.key}, ${clean(o.label)}`).join('; ');
    const pick = brief.options.find((o) => o.recommended) ?? brief.options.find((o) => o.key === brief.defaultOption);
    return `${head} Options: ${options}.${pick ? ` I'd go with ${pick.key}${pick.consequence ? `: ${clean(pick.consequence)}` : ''}.` : ''}${brief.vetoLeftMs != null && brief.defaultOption ? ` If you leave it, it goes with ${brief.defaultOption} after ${spokenWait(brief.vetoLeftMs)} of your active time.` : ''}`;
  }
  if (focus.spaceId === 'system') return `${head} It's acked or snoozed on the System page.`;
  if (line.kind === 'decided') return line.rule ? `${head} Say got it, or next.` : `${head} Say that's fine, or next.`;
  return head;
}

/** "What's left?": per space, what needs the owner and what's open; the smaller updates in one breath. */
export function speakLeft(walk: CatchupWalk): string {
  const rows = [...walk.map.needs, ...walk.map.look];
  const parts = rows.map((r) => `${r.name}: ${r.summary.replace(/ · /g, ', ')}`);
  const small = walk.map.smaller;
  if (small.length) parts.push(`Smaller updates in ${small.length === 1 ? small[0]!.name : `${small.length} places`}`);
  return parts.length ? `${parts.join('. ')}.` : "Nothing's left.";
}

/** A space the owner named, from the walk's map ("accept Desk", "go to Sierra"): its id, the names it could mean when more than one fits, or null when none does. */
export function spaceNamed(walk: CatchupWalk, name: string): { spaceId: string } | { choices: string[] } | null {
  const norm = (n: string) => n.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const want = norm(name) === 'inbox' ? 'unfiled' : norm(name);
  const rows = [...walk.map.needs, ...walk.map.look, ...walk.map.smaller];
  const exact = rows.find((r) => norm(r.name) === want);
  if (exact) return { spaceId: exact.spaceId };
  const fits = rows.filter((r, i) => (norm(r.name).startsWith(want) || want.startsWith(norm(r.name))) && rows.findIndex((x) => x.spaceId === r.spaceId) === i);
  if (fits.length === 1) return { spaceId: fits[0]!.spaceId };
  return fits.length ? { choices: fits.map((r) => r.name) } : null;
}

/** The brief option a pick means: its key, or the one the brief recommends (else its default); null when none. */
export function optionFor(focus: CatchupWalkFocus, key: string | null): { key: string; label: string; answer: string } | null {
  const options = focus.brief?.options ?? [];
  const o = key ? options.find((x) => x.key.toUpperCase() === key) : (options.find((x) => x.recommended) ?? options.find((x) => x.key === focus.brief?.defaultOption));
  return o ? { key: o.key, label: o.label, answer: o.answer } : null;
}
