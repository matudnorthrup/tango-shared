import type { DeskUpdate } from './updates.js';

// Cleaning up Needs you (docs/specs/catch-up.md "The chapter"). What Needs you counts and where a line sits come only
// from recorded facts (docs/specs/desk-status.md "The rule", standing rule R-21): an open brief, the conversation's own
// ask, its close. On top of the facts, deterministically, needs lines sharing a brief, or with the same words, show once,
// in the most specific space Catch me up can show (a project before an agent, both before System; never Unfiled).
//
// The chapter writer's sort (chores, asks, same, answered) only explains: each becomes a labeled summary note on its
// line and moves nothing. A brief or a failed line never gets a note that would say it's noise.

/** The writer's sort, kept in the chapter layout by line id. */
export interface ChapterTriage {
  chores: number[];
  asks: number[];
  same: number[][];
  /** Needs line id → the later line that answered it. */
  answered: Record<string, number>;
}

/** What the writer's sort says of a line, shown as labeled summary text beside it; it changes no count. */
export type TidyNote = { label: 'housekeeping' } | { label: 'answered'; by: { id: number; title: string } } | { label: 'ask' };

/** What the card shows of the cleanup, for one space's lines. */
export interface ChapterTidy {
  /** A kept line → the copies folded under it (from this space or another), with the conversation each came from. */
  also: Record<string, Array<{ id: number; from: string | null; spaceId: string }>>;
  /** This space's copies of an ask kept in another space, with that space's name. */
  elsewhere: Array<{ id: number; keptId: number; where: string | null }>;
  /** The writer's summary of a line, by line id: text only. */
  notes: Record<string, TidyNote>;
}

export const EMPTY_TIDY: ChapterTidy = { also: {}, elsewhere: [], notes: {} };

/** A line the sort may never call noise: an open brief, or a failure. */
export const isProtected = (u: Pick<DeskUpdate, 'source' | 'briefId' | 'kind'>): boolean => u.source === 'auto:brief' || !!u.briefId || u.kind === 'failed';
const isBrief = (u: Pick<DeskUpdate, 'source' | 'briefId'>): boolean => u.source === 'auto:brief' || !!u.briefId;

/**
 * Words that ask the owner something: "need your merge", "waiting for your Confirm", "for you to", a question. A news
 * line the writer notes as an ask must say so in its title; a report of work done or proposed never gets the note.
 */
export const asksOwner = (title: string): boolean => /\b(?:your|you need to|you to|for you|on you|you must|you should)\b|\?\s*$/i.test(title);

/** The ids a tidy takes out of Needs you and the moments: repeats of an ask shown elsewhere (they show folded instead). */
export function tidiedIds(tidy: ChapterTidy | null | undefined): Set<number> {
  if (!tidy) return new Set();
  return new Set([...Object.values(tidy.also).flat().map((a) => a.id), ...tidy.elsewhere.map((e) => e.id)]);
}

/** A title as the cross-space fold compares it: lowercase words only. */
export const sameWords = (title: string): string => title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const SPACE_RANK = (spaceId: string) => (spaceId.startsWith('project:') ? 0 : spaceId.startsWith('agent:') ? 1 : spaceId === 'unfiled' ? 3 : 2);
/**
 * Which copy stays: one Catch me up can show now (Unfiled has no page, and a deferred chapter is off the page until it
 * comes back, so a copy in either never wins over one that shows), then a brief over a status line, then the most
 * specific space, then the newest.
 */
const unfiled = (u: DeskUpdate) => Number(u.spaceId === 'unfiled');
const deferred = (u: DeskUpdate, now: number) => Number(u.backAt !== null && u.backAt > now);
const keeps = (now: number) => (a: DeskUpdate, b: DeskUpdate) => unfiled(a) - unfiled(b) || deferred(a, now) - deferred(b, now) || Number(isBrief(b)) - Number(isBrief(a)) || Number(!!askOf(b)) - Number(!!askOf(a)) || SPACE_RANK(a.spaceId) - SPACE_RANK(b.spaceId) || b.at - a.at || b.id - a.id;

/** The recorded hand-off ask a needs line stands for (updates.ts syncStatuses writes `data.askId`); null for a words-only line. */
const askOf = (u: Pick<DeskUpdate, 'data'>): string | null => (typeof u.data?.askId === 'string' && u.data.askId ? u.data.askId : null);

/**
 * Needs lines waiting across every space that ask the same thing (one brief, one recorded ask, or the same words):
 * each folded copy → the line kept. A brief folds only under the same brief, and a recorded ask only under the same
 * ask id: two briefs, or two asks from different threads, asked in the same words stay two (each has its own
 * record, steps and due, and the card's Did it resolves only its own id). A words-only line folds under either.
 */
export function crossFolds(waiting: DeskUpdate[], now = Date.now()): Map<number, DeskUpdate> {
  const needs = waiting.filter((u) => u.kind === 'needs');
  const parent = new Map<number, number>(needs.map((u) => [u.id, u.id]));
  const root = (id: number): number => (parent.get(id) === id ? id : root(parent.get(id)!));
  const join = (key: Map<string, number>, k: string, id: number) => {
    const first = key.get(k);
    if (first === undefined) key.set(k, id);
    else parent.set(root(id), root(first));
  };
  const byBrief = new Map<string, number>();
  const byAsk = new Map<string, number>();
  const byWords = new Map<string, number>();
  for (const u of needs) {
    if (u.briefId) join(byBrief, u.briefId, u.id);
    const ask = askOf(u);
    if (ask) join(byAsk, ask, u.id);
    const w = sameWords(u.title);
    if (w) join(byWords, w, u.id);
  }
  const groups = new Map<number, DeskUpdate[]>();
  for (const u of needs) groups.set(root(u.id), [...(groups.get(root(u.id)) ?? []), u]);
  const folds = (u: DeskUpdate, kept: DeskUpdate): boolean => (isBrief(u) ? !!u.briefId && u.briefId === kept.briefId : askOf(u) ? askOf(u) === askOf(kept) : true);
  const out = new Map<number, DeskUpdate>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const kept = [...group].sort(keeps(now))[0]!;
    for (const u of group) if (u !== kept && folds(u, kept)) out.set(u.id, kept);
  }
  return out;
}

/**
 * The cleanup of a space's lines as they are now (open and still waiting): the repeats folded across spaces
 * (crossFolds), and the writer's sort as notes under the safety rules (a brief or failure is never housekeeping or
 * answered; an answer is a newer line; an ask note goes only on news its writer filed that addresses the owner).
 */
export function tidyChapter(
  lines: DeskUpdate[],
  triage: ChapterTriage | null | undefined,
  context: {
    /** A line by id, any state (the line that answered one may be handled already). */
    lookup: (id: number) => Pick<DeskUpdate, 'id' | 'title' | 'at'> | null;
    /** Copies folded across spaces (crossFolds). */
    cross?: Map<number, DeskUpdate>;
    /** The conversation a line came from, in words. */
    from?: (line: DeskUpdate) => string | null;
    /** A space's name. */
    spaceName?: (spaceId: string) => string | null;
    /** Every line still waiting, any space (for a copy kept elsewhere that folds this space's lines). */
    all?: DeskUpdate[];
  },
): ChapterTidy {
  const byId = new Map(lines.map((u) => [u.id, u]));
  const taken = new Set<number>();
  const from = context.from ?? (() => null);
  const also: ChapterTidy['also'] = {};
  // Across spaces: a copy here kept in this space folds under it; a copy here kept in another space is named there;
  // a copy elsewhere kept here is named on the kept line.
  const elsewhere: ChapterTidy['elsewhere'] = [];
  for (const u of lines) {
    const kept = context.cross?.get(u.id);
    if (!kept || taken.has(u.id) || u.kind !== 'needs') continue;
    if (kept.spaceId === u.spaceId && byId.has(kept.id) && !taken.has(kept.id)) {
      (also[String(kept.id)] ??= []).push({ id: u.id, from: from(u), spaceId: u.spaceId });
      taken.add(u.id);
    } else if (kept.spaceId !== u.spaceId) {
      elsewhere.push({ id: u.id, keptId: kept.id, where: context.spaceName?.(kept.spaceId) ?? null });
      taken.add(u.id);
    }
  }
  for (const [copy, kept] of context.cross ?? []) {
    if (!byId.has(kept.id) || taken.has(kept.id) || byId.has(copy)) continue;
    const u = context.all?.find((l) => l.id === copy);
    if (u) (also[String(kept.id)] ??= []).push({ id: u.id, from: from(u) ?? context.spaceName?.(u.spaceId) ?? null, spaceId: u.spaceId });
  }
  // The writer's sort, as notes only.
  const notes: ChapterTidy['notes'] = {};
  const needs = (id: number) => {
    const u = byId.get(id);
    return u && u.kind === 'needs' && !isProtected(u) && !taken.has(id) && !notes[String(id)] ? u : null;
  };
  for (const id of triage?.chores ?? []) if (needs(id)) notes[String(id)] = { label: 'housekeeping' };
  for (const [key, byLine] of Object.entries(triage?.answered ?? {})) {
    const u = needs(Number(key));
    const by = u && byLine !== u.id ? context.lookup(byLine) : null;
    if (u && by && by.at > u.at) notes[key] = { label: 'answered', by: { id: by.id, title: by.title } };
  }
  for (const id of triage?.asks ?? []) {
    const u = byId.get(id);
    // Filed as news by its writer: a needs line the desk shows as news (its conversation no longer asks) carries a
    // status, or, from a lead, the kind it was filed as.
    if (u && ['fyi', 'shipped', 'decided'].includes(u.kind) && u.status === undefined && u.data?.filedAs === undefined && u.supersededBy === null && asksOwner(u.title)) notes[String(id)] = { label: 'ask' };
  }
  return { also, elsewhere, notes };
}
