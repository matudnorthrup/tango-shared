import { namesDecision } from '../../public/desk/ask-match.js';
export { askKey, namesDecision } from '../../public/desk/ask-match.js';
import type { StepInput, StepResult } from './next-step.js';
import type { AskKind, AskRecord, AskState, DeskItemRow } from './types.js';

// The ask lifecycle (docs/specs/agent-desk.md "Asks"; owner, 10/18). What the agent handed the owner is read
// once from the step's winner into one record with a kind, a due date, a key for finding the same ask twice,
// and a state. Only an open decision is the owner's move (the pill, desk/status.ts); a to-do has its own list;
// an expired, superseded or duplicated ask is a fact on the row, never yellow.

/** An ask the owner must answer before the agent can go on: a choice, an approval, a review, a yes or no. */
const DECISION = /\b(approve|approval|accept|reject|decide|decision|choose|choice|pick (?:one|a|the|between)|confirm|answer|reply|say (?:go|yes|no|which|whether|the word|if)|tell me (?:which|whether|if|what)|which (?:one|of|do)|whose|do you want|should (?:i|we)|ok(?:ay)? to|go ahead|sign[- ]?off|merge\?|review (?:and|the|this|it)|sign in)\b/i;
/** An action in the world the agent cannot do itself, at the front of the ask. */
const TODO = /^\W*(?:(?:please|then|now|today|this week|tonight|tomorrow|after [^,]{1,40},)\s+)*(?:go )?(buy|order|purchase|call|text|phone|email|mail|ship|install|mount|remove|take (?:the |a |an )?\S+ (?:off|out|down)|put|swap|measure|test[- ]fit|test the|try the|do the|drive|ride|print|charge|clean|wash|inspect|check (?:the|whether|if|that)|look at the|pick up|drop off|bring|carry|move the|run (?:your|the)|create (?:a|an|the|your) (?:\S+ ){0,3}(?:token|account|key|login|password)|sign up|set up|have (?:the|a|that)|book|schedule the|pay|file|submit the)\b/i;
const SOFT = /\b(if you want|optional(?:ly)?|no rush|whenever you like|when you get a chance|feel free|nice to have)\b/i;
/** The agent goes on once the owner has done it: "after that I…", "once you've…, I…", "so I can…". */
const CONTINUES = /\b(?:after (?:that|this|it'?s done|you(?:'ve| have)? done (?:that|it)),? I|once (?:you(?:'ve| have| do| did)?|that(?:'s| is)|it(?:'s| is)) [^.;]{0,80}?,? I(?:'ll| will| can)?\b|when (?:you(?:'ve| have)|that(?:'s| is)|it(?:'s| is)) (?:done|finished|in place)[^.;]{0,40}?,? I|then I(?:'ll| will| can)?\b|(?:tell me|let me know|say (?:so|when)|ping me|when you (?:do|join|have|finish|run|try|plug|move|restart|reply)\b[^.;]{0,40}?)[^.;]{0,20}?,? and I(?:'ll| will) (?:run|check|verify|test|finish|continue|move|deploy|merge|start|rerun|try|confirm|take it from there)\b|so (?:that )?I can\b|for me to (?:continue|go on|finish|verify|check|move|deploy|test))/i;
/** Setup only the owner can do on their own machine or accounts: the agent's next step needs it. */
const SETUP = /\b(?:sign(?:ed)? in|log ?in|grant|allow|approve|enable|disable|turn (?:\S+ ){0,6}?(?:on|off)|install (?:tango|\S+\.app|the (?:\S+ )?app\b)|full disk access|login items?|privacy & security|system settings|settings ?→|→|create (?:a|an|the|your) (?:\S+ ){0,3}(?:token|api key|key|account|login|password))\b/i;

/**
 * An owner action the thread's own progress waits on is a blocking ask (a decision), however it is phrased
 * ("do X"): the agent says it goes on after it, or it is setup only the owner can do (a sign-in, a permission,
 * an app setting). A to-do is an errand the agent's work doesn't wait on (owner, 10/19).
 */
export function blocksAgent(text: string, closing = ''): boolean {
  // Agents write curly apostrophes ("you’ve"); the patterns read straight ones.
  const straight = (value: string) => value.replace(/[‘’]/g, "'");
  const t = straight(`${text}\n${closing.split('\n').slice(-6).join('\n')}`);
  return CONTINUES.test(t) || SETUP.test(straight(text));
}

/**
 * What kind of ask the words make, when the summary hasn't said: a to-do leads with a verb of an action in the
 * world; a decision asks for a choice, an approval or an answer; anything unclear is a decision (a hidden
 * blocker costs more than a yellow to-do). The summary's own call, when it has one, beats this.
 */
export function guessAskKind(text: string): AskKind {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return 'decision';
  if (SOFT.test(t) && !DECISION.test(t)) return 'soft';
  if (TODO.test(t)) return 'todo';
  return 'decision';
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DUE = /\b(?:by|before|until|no later than|expires?(?: on)?|due(?: on)?|deadline(?: is)?)\s+(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i;

/** A deadline the ask names in plain words ("before Oct 15"): the end of that day, in the server's local time. */
export function dueDateIn(text: string, now: number): number | null {
  const m = DUE.exec(text);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!.toLowerCase().slice(0, 3));
  const day = Number(m[2]);
  if (month < 0 || day < 1 || day > 31) return null;
  const year = new Date(now).getFullYear();
  let due = new Date(year, month, day, 23, 59, 59, 999).getTime();
  // A date more than half a year gone was meant for next year.
  if (due < now - 182 * 86_400_000) due = new Date(year + 1, month, day, 23, 59, 59, 999).getTime();
  return due;
}

function parseIso(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The ask on an item, read from the step's winner: null unless the step is the owner's move. The kind comes
 * from the source when it is exact (a T3 request, a PR decision), else from the current summary, else from the
 * words. Expiry is the summary's due time or a date the words name; superseded and duplicate are set later
 * across rows (resolveAsks).
 */
export function readAsk(result: StepResult, input: Pick<StepInput, 'facts' | 'summary' | 'lastAgentAt' | 'now'> & { closingText?: string }, row: Pick<DeskItemRow, 'conversationKey'>): AskRecord | null {
  const recorded = input.facts.askLedger ?? input.facts.openAsk;
  if (recorded?.id && !input.facts.pending && !input.facts.openBrief) {
    if (recorded.kind === 'pointer' || recorded.to) return null;
    const state = recorded.status === 'open' ? 'open' : recorded.status === 'expired' ? 'expired' : recorded.status === 'superseded' ? 'superseded' : null;
    if (!state) return null;
    return { source: 'recorded', text: recorded.text, kind: recorded.kind === 'do' ? 'todo' : 'decision',
      kindBy: 'source', at: recorded.at, dueAt: recorded.due ? Date.parse(recorded.due) : null,
      key: recorded.id, state, of: null };
  }
  if (result.step !== 'your_move' || !result.basis.startsWith('source:')) return null;
  const f = input.facts;
  const source = f.pending || f.openBrief ? 'pending' : 'recorded';
  const at = f.pending?.at ?? f.openAsk?.at ?? f.handoff?.at ?? input.lastAgentAt ?? input.now;
  return { source, text: result.ask ?? '', kind: 'decision', kindBy: 'source', at, dueAt: null,
    key: row.conversationKey, state: 'open', of: null };

}

/** One row as the cross-row pass sees it. */
export interface AskEntry {
  itemId: string;
  conversationKey: string;
  kind: DeskItemRow['kind'];
  createdAt: number;
  /** In the owner's rotation (active, not hidden): only these supersede or duplicate one another. */
  active: boolean;
  ask: AskRecord | null;
}

export interface AskResolution {
  state: AskState;
  of: string | null;
}

/**
 * The same ask on several rows, resolved to one. A channel split by time hands its live turn to the newest
 * chapter (types.ts splitByTime), so an older chapter's ask is superseded by any newer active chapter, ask or
 * not: a nightly job that asks again each night is one question, on the newest night. Across rows, the same
 * words (askKey) are one ask, carried by the newest; the others are duplicates of it. An expired ask stays
 * expired unless a newer row took it over.
 */
export function resolveAsks(entries: AskEntry[]): Map<string, AskResolution> {
  const out = new Map<string, AskResolution>();
  const active = entries.filter((entry) => entry.active);
  const newestChapter = new Map<string, AskEntry>();
  for (const entry of active) {
    if (entry.kind !== 'chapter') continue;
    const current = newestChapter.get(entry.conversationKey);
    if (!current || entry.createdAt > current.createdAt || (entry.createdAt === current.createdAt && entry.itemId > current.itemId)) newestChapter.set(entry.conversationKey, entry);
  }
  const byKey = new Map<string, AskEntry[]>();
  for (const entry of active) {
    if (!entry.ask) continue;
    const newest = entry.kind === 'chapter' ? newestChapter.get(entry.conversationKey) : undefined;
    if (newest && newest.itemId !== entry.itemId) {
      out.set(entry.itemId, { state: 'superseded', of: newest.itemId });
      continue;
    }
    byKey.set(entry.ask.key, [...(byKey.get(entry.ask.key) ?? []), entry]);
  }
  for (const group of byKey.values()) {
    const representative = group.reduce((best, entry) => (entry.ask!.at > best.ask!.at || (entry.ask!.at === best.ask!.at && entry.itemId > best.itemId) ? entry : best));
    for (const entry of group) {
      if (entry.itemId === representative.itemId) out.set(entry.itemId, { state: entry.ask!.state, of: null });
      else out.set(entry.itemId, { state: 'duplicate', of: representative.itemId });
    }
  }
  for (const entry of entries) if (entry.ask && !out.has(entry.itemId)) out.set(entry.itemId, { state: entry.ask.state, of: null });
  return out;
}

/** One row as the carry pass sees it (carryBriefs). */
export interface CarryRow {
  itemId: string;
  role: DeskItemRow['facts']['role'];
  parentItemId: string | null;
  ownerGone: boolean;
  /** In the owner's rotation (active, not hidden): only these carry another row's brief. */
  active: boolean;
  /** Not done: only these raise a brief others carry. */
  live: boolean;
  /** The row's own open brief id (D-n), when its pending question is one. */
  briefId: string | null;
  /** Its open ask and its newest agent words: where a mention of D-n is read. */
  words: string;
  /** Other live rows report to it as workers. */
  lead: boolean;
  /** A Loom thread: the only kind whose ask Loom clears, and which Loom tells, when the decision settles. */
  loom: boolean;
}

/** One open brief and the rows that carry it; `counter` is the one row it counts on as the owner's Needs you. */
export interface Carry {
  decisionId: string;
  source: string;
  carriers: Array<{ itemId: string; why: 'named' | 'worker' }>;
  counter: string;
}

const speaksToOwner = (row: CarryRow) => row.role !== 'ops' && !(row.role === 'worker' && !row.ownerGone);

/**
 * The conversation a worker's brief goes up to: its lead, or, when a worker or a job it reports to sits between, the
 * first conversation up the chain that speaks to the owner (Codex review on #781). Null when the chain ends before
 * one (a lead the desk doesn't list, a loop); the worker then shows the brief itself (desk/core.ts leadAway).
 */
export function ownerFacingLead(worker: CarryRow, byId: Map<string, CarryRow>): string | null {
  const seen = new Set([worker.itemId]);
  let at = worker.parentItemId ? byId.get(worker.parentItemId) : undefined;
  while (at && !seen.has(at.itemId)) {
    if (speaksToOwner(at)) return at.itemId;
    seen.add(at.itemId);
    at = at.parentItemId ? byId.get(at.parentItemId) : undefined;
  }
  return null;
}

/**
 * Briefs passed up intact (TGO-1075). A conversation can't hand on another thread's brief, only summarize it, so
 * the desk does: a row whose open ask or newest words name an open decision (D-n) carries that brief, and a lead
 * carries its own workers' open briefs without naming them. One decision is one Needs you, counted where the owner
 * should look: the raising worker's lead, else a default or a lead that carries it, else the row that raised it.
 * The other rows show it as carried (desk/types.ts CarriedBrief); answering on any of them answers the original.
 */
export function carryBriefs(rows: CarryRow[]): Carry[] {
  const sources = rows.filter((row) => row.briefId && row.live);
  if (!sources.length) return [];
  const byId = new Map(rows.map((row) => [row.itemId, row]));
  const out: Carry[] = [];
  for (const source of sources) {
    const decisionId = source.briefId!;
    const carriers: Carry['carriers'] = [];
    const lead = (source.role === 'worker' || source.role === 'ops') && !source.ownerGone ? ownerFacingLead(source, byId) : null;
    for (const row of rows) {
      if (row.itemId === source.itemId || !row.active || !speaksToOwner(row)) continue;
      if (row.itemId === lead) carriers.push({ itemId: row.itemId, why: 'worker' });
      // Only a Loom thread carries by naming it: when the decision settles, Loom clears that ask and tells the thread
      // (passOnResolved); a T3 or Discord row's ask would be left pointing at nothing (Codex review on #781).
      else if (row.loom && row.words && namesDecision(row.words, decisionId)) carriers.push({ itemId: row.itemId, why: 'named' });
    }
    if (!carriers.length) continue;
    const rank = (carrier: Carry['carriers'][number]) => {
      const row = byId.get(carrier.itemId)!;
      return carrier.why === 'worker' ? 0 : row.role === 'default' ? 1 : row.lead ? 2 : 3;
    };
    const best = carriers.reduce((a, b) => (rank(b) < rank(a) ? b : a));
    out.push({ decisionId, source: source.itemId, carriers, counter: rank(best) < 3 ? best.itemId : source.itemId });
  }
  return out;
}
