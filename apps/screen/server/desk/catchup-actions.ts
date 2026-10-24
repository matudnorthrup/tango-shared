import { createHash } from 'node:crypto';
import { plainWords, words } from '../../public/desk/plain-words.js';
import type { DeskItem, PendingRequest, RecordedAsk } from './types.js';
import { isRuleEvent } from './collapse.js';
import { deskStatus } from './status.js';
import { isOpen, type DeskUpdate, type DeskUpdates } from './updates.js';

// Accept and Defer on a chapter (docs/specs/catch-up.md "Accept and Defer"). Accept takes the recommendation on every
// brief it may, says Fine by me to every decided moment, and marks the rest seen; Defer marks the chapter seen and
// brings it back the next morning. Both act only on the lines the owner was shown: a chapter that changed since is
// refused with its new plan, and the card re-renders instead of acting.

/** Board level 1 classes: the owner's call, never taken in bulk (config/decisions/board.yaml). */
const OWNERS_CALL_LEVEL = 1;

export interface PlanTake {
  updateId: number;
  itemId: string;
  briefId: string;
  /** The option as the brief's question lists it (what the answer path takes). */
  answer: string;
  key: string;
  revision: number | null;
  /** A promotion candidate: answered "Ask me next time", so no rule is made. */
  candidate: boolean;
  /** The brief's ask, as the card names it. */
  title: string;
}

export interface PlanLeft {
  updateId: number;
  briefId: string | null;
  title: string;
  why: 'owners-call' | 'tripwire' | 'no-recommendation' | 'not-open' | 'ask';
}

export interface ChapterPlan {
  spaceId: string;
  revision: string;
  /** The lines the plan covers (the card's chapter). */
  updateIds: number[];
  take: PlanTake[];
  fine: Array<{ updateId: number; decisionId: string }>;
  left: PlanLeft[];
  seen: number[];
  /** Rows whose Finished line the chapter shows, still Finished: Accept files ordinary threads Done; standing rows are listed separately in clear. */
  file: string[];
  /** Standing conversations whose Finished lines will be cleared in place. */
  clear: string[];
  /** Of the lines marked seen, the repeats Needs you folds away (triage.ts): so the line names what isn't shown up top. */
  folded?: { repeats: number };
  /** The line under the button: exactly what Accept will do. */
  line: string;
}

export { isRuleEvent } from './collapse.js';

/** The chapter's lines: what is still the owner's to look at (never seen, or deferred and back). */
export function chapterLines(updates: DeskUpdates, spaceId: string, now: number): DeskUpdate[] {
  const all = updates.list({ space: spaceId, limit: 500, awake: true });
  const open = all.filter((u) => isOpen(u, now));
  // A new moment brings a deferred chapter back before its morning (spec "Accept and Defer"): its deferred lines rejoin.
  if (!open.some((u) => u.moment && u.seenAt === null)) return open;
  return all.filter((u) => isOpen(u, now) || (u.supersededBy === null && u.seenVia === 'deferred' && u.backAt !== null && u.backAt > now));
}

const briefOf = (items: Map<string, DeskItem>, line: DeskUpdate): PendingRequest | null => {
  const brief = line.itemId ? items.get(line.itemId)?.facts.openBrief : null;
  return brief?.brief?.id === line.briefId ? brief! : null;
};

/** What Accept would do to a space's chapter now. */
export function planChapter(updates: DeskUpdates, spaceId: string, items: DeskItem[], now: number): ChapterPlan {
  const byId = new Map(items.map((i) => [i.id, i]));
  const latest = new Map<string, DeskItem>();
  for (const row of items) {
    const previous = latest.get(row.conversationKey);
    if (!previous || row.lastActivityAt > previous.lastActivityAt || (row.lastActivityAt === previous.lastActivityAt && row.createdAt > previous.createdAt)) latest.set(row.conversationKey, row);
  }
  const lines = chapterLines(updates, spaceId, now);
  const take: PlanTake[] = [];
  const fine: ChapterPlan['fine'] = [];
  const left: PlanLeft[] = [];
  const seen: number[] = [];
  const file = new Set<string>();
  const clear = new Set<string>();
  const revisionParts: string[] = [];
  for (const line of lines) {
    const row = line.kind === 'shipped' && line.itemId ? byId.get(line.itemId) : undefined;
    const filing = !!row && row.disposition !== 'done' && deskStatus(row, now).pill === 'finished';
    const standing = !!row && (row.facts.standing ?? (row.facts.role === 'default' || (row.kind === 'chapter' && latest.get(row.conversationKey)?.id === row.id)));
    if (filing) (standing ? clear : file).add(row!.id);
    const pending = line.kind === 'needs' && line.briefId ? briefOf(byId, line) : null;
    // Whether a line files its row is part of what the owner was shown: a row that finishes after the card rendered changes the plan.
    revisionParts.push(`${line.id}:${pending?.brief?.revision ?? line.data.askRevision ?? ''}${filing ? standing ? ':clear' : ':file' : ''}`);
    if (line.kind === 'needs' && line.briefId) {
      const brief = pending?.brief;
      const recommended = pending?.questions?.[0]?.options.find((o) => /\(Recommended\)$/.test(o.label));
      const why: PlanLeft['why'] | null = !brief ? 'not-open' : brief.level === OWNERS_CALL_LEVEL ? 'owners-call' : brief.tripwire ? 'tripwire' : !recommended ? 'no-recommendation' : null;
      if (why === 'not-open') seen.push(line.id);
      else if (why) left.push({ updateId: line.id, briefId: line.briefId, title: line.title, why });
      else take.push({ updateId: line.id, itemId: line.itemId!, briefId: line.briefId, answer: recommended!.label, key: recommended!.label.split(' · ')[0]!, revision: brief!.revision ?? null, candidate: brief!.candidate === true, title: line.title });
      continue;
    }
    if (line.kind === 'needs') {
      left.push({ updateId: line.id, briefId: null, title: line.title, why: 'ask' });
      continue;
    }
    // Fine goes to real decisions only: a rule event is news about the loop, not something to confirm.
    if (line.kind === 'decided' && line.moment && line.decisionId && !isRuleEvent(line)) fine.push({ updateId: line.id, decisionId: line.decisionId });
    else seen.push(line.id);
  }
  const revision = createHash('sha1').update(revisionParts.join('|')).digest('hex').slice(0, 12);
  // What Accept marks seen that Needs you folded away: named, so "mark all N seen" adds up with what the card shows.
  const tidy = updates.view(spaceId, lines).tidy;
  const marked = new Set(seen);
  const folded = tidy ? { repeats: [...Object.values(tidy.also).flat().map((a) => a.id), ...tidy.elsewhere.map((e) => e.id)].filter((id) => marked.has(id)).length } : null;
  const counted = folded && folded.repeats > 0 ? folded : null;
  const filed = [...file];
  return { spaceId, revision, updateIds: lines.map((l) => l.id), take, fine, left, seen, file: filed, clear: [...clear], ...(counted ? { folded: counted } : {}), line: planLine({ take, fine, left, seen, file: filed, clear: [...clear], ...(counted ? { folded: counted } : {}) }) };
}

/** A brief named in a plan line: its ask, short, in plain words (the owner doesn't track D-n); an ask that was only an id, unquoted. */
const named = (title: string) => {
  const ask = words(plainWords(title), 8).replace(/[.?!]$/, '');
  return ask ? `“${ask}”` : 'a decision';
};
/** Briefs named in a plan line: each by its ask, or a count when there are more than two. */
const namedAll = (titles: string[], what: string) => (titles.length > 2 ? `${titles.length} ${what}` : titles.map(named).join(' and '));

/** "Accept will choose A on “Approve the phase 3 plan” · fine on 1 decision · mark the rest seen", and what it leaves and why. */
export function planLine(plan: Pick<ChapterPlan, 'take' | 'fine' | 'left' | 'seen' | 'folded'> & { file?: string[]; clear?: string[] }): string {
  const parts: string[] = [];
  if (plan.take.length) parts.push(`choose ${plan.take.map((t) => `${t.key} on ${named(t.title)}`).join(', ')}`);
  if (plan.fine.length) parts.push(`fine on ${plan.fine.length} decision${plan.fine.length === 1 ? '' : 's'}`);
  // What Accept leaves for the owner is marked seen too (applyAccept), so it counts here.
  const asks = plan.left.filter((l) => l.why === 'ask');
  const briefs = plan.left.filter((l) => l.why !== 'ask');
  const rest = plan.seen.length + briefs.length;
  const f = plan.folded;
  const including = f?.repeats ? `, including ${f.repeats} repeat${f.repeats === 1 ? '' : 's'}` : '';
  const filed = plan.file?.length ?? 0;
  if (filed) parts.push(`mark ${filed === 1 ? 'the finished thread' : `${filed} finished threads`} done`);
  const cleared = plan.clear?.length ?? 0;
  if (cleared) parts.push(`clear ${cleared === 1 ? 'the default' : `${cleared} defaults`}`);
  if (rest) parts.push(`${plan.take.length || plan.fine.length ? 'mark the rest seen' : `mark ${rest === 1 ? 'it' : `all ${rest}`} seen`}${including}`);
  let line = parts.length ? `Accept will ${parts.join(' · ')}.` : 'Nothing for Accept to do.';
  if (asks.length) line += ` Accept leaves ${asks.length} ask${asks.length === 1 ? '' : 's'} for you.`;
  if (briefs.length) line += ` Left for you: ${namedAll(briefs.map((l) => l.title), 'briefs only you can answer')}.`;
  return line;
}

/** Why a request on a chapter is refused: it changed since the owner saw it. */
export function stale(plan: ChapterPlan, shown: { updateIds: number[]; revision: string }): boolean {
  if (shown.revision !== plan.revision) return true;
  const a = [...shown.updateIds].sort((x, y) => x - y).join(',');
  const b = [...plan.updateIds].sort((x, y) => x - y).join(',');
  return a !== b;
}

export interface AcceptDeps {
  updates: DeskUpdates;
  /** Answers a brief through the desk's normal answer path (the `respond` command). */
  answer(take: PlanTake, commandId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Loom's decision.confirm (Fine by me). */
  confirm(decisionId: string, commandId: string): Promise<{ ok: true } | { ok: false; error: string; unknown?: boolean }>;
  /** Marks a Finished row done (the `done` command). */
  done?(itemId: string, commandId: string): Promise<{ ok: true; cleared?: boolean } | { ok: false; error: string }>;
  /** The desk's rows now: a row that took new work while Accept answered its briefs is left active, not filed. */
  items?(): DeskItem[];
}

export interface AcceptResult {
  plan: ChapterPlan;
  applied: { took: string[]; fine: string[]; seen: number; filed: string[]; cleared: string[] };
  left: PlanLeft[];
  failed: Array<{ updateId: number; error: string }>;
}

/** Carries out a plan. Each piece stands alone: one that fails stays on the card, with why, and the rest still apply. */
export async function applyAccept(deps: AcceptDeps, plan: ChapterPlan, commandId: string): Promise<AcceptResult> {
  const failed: AcceptResult['failed'] = [];
  const took: string[] = [];
  const fined: string[] = [];
  for (const take of plan.take) {
    const done = await deps.answer(take, `${commandId}:${take.briefId}`);
    if (!done.ok) {
      failed.push({ updateId: take.updateId, error: done.error });
      continue;
    }
    took.push(take.briefId);
    deps.updates.seen([take.updateId], 'accepted', take.key);
  }
  for (const f of plan.fine) {
    const done = await deps.confirm(f.decisionId, `${commandId}:${f.decisionId}`);
    if (!done.ok) {
      failed.push({ updateId: f.updateId, error: done.error });
      continue;
    }
    fined.push(f.decisionId);
    deps.updates.seen([f.updateId], 'accepted', 'fine');
  }
  // What's left for the owner is seen too: the chapter counts as caught up, and those briefs stay in Needs you.
  const rest = [...plan.seen, ...plan.left.filter((l) => l.why !== 'ask').map((l) => l.updateId)];
  if (rest.length) deps.updates.seen(rest, 'accepted', null);
  // A failure here leaves the row Finished; its line is already seen, so it only needs a Done by hand.
  const filed: string[] = [];
  const cleared: string[] = [];
  const now = deps.items ? new Map(deps.items().map((i) => [i.id, i])) : null;
  for (const itemId of deps.done ? [...(plan.file ?? []), ...(plan.clear ?? [])] : []) {
    const row = now?.get(itemId);
    if (now && (!row || row.disposition === 'done' || deskStatus(row, Date.now()).pill !== 'finished')) continue;
    const done = await deps.done!(itemId, `${commandId}:done:${itemId}`).catch((err: Error) => ({ ok: false as const, error: err.message }));
    if (done.ok) (done.cleared ? cleared : filed).push(itemId);
  }
  return { plan, applied: { took, fine: fined, seen: rest.length, filed, cleared }, left: plan.left, failed };
}

/** The compact BriefCard data on a chapter, including tripwire and rule controls. */
export interface CardBrief {
  about?: string;
  tripwire?: string | null;
  proposedRule?: string | null;
  candidate?: boolean;
  precedentOf?: string | null;
  id: string;
  itemId: string;
  ask: string;
  standing: string | null;
  /** `answer`: the option as the brief's question lists it, what the answer path takes. */
  options: Array<{ key: string; label: string; consequence: string | null; recommended: boolean; answer: string }>;
  defaultOption: string | null;
  vetoLeftMs: number | null;
  level: number | null;
  /** The brief's revision, sent with an answer so one that changed since is refused. */
  revision: number | null;
}

/** The open briefs behind a chapter's needs lines, as its card shows them. */
export function cardBriefs(lines: DeskUpdate[], items: DeskItem[]): CardBrief[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out: CardBrief[] = [];
  for (const line of lines) {
    if (line.kind !== 'needs' || !line.briefId) continue;
    const pending = briefOf(byId, line);
    if (!pending?.brief) continue;
    const options = (pending.questions?.[0]?.options ?? []).map((o) => {
      const recommended = /\(Recommended\)$/.test(o.label);
      const bare = o.label.replace(/\s*\(Recommended\)$/, '');
      const [key, ...rest] = bare.split(' · ');
      return { key: key!, label: rest.join(' · ') || bare, consequence: o.description ?? null, recommended, answer: o.label };
    });
    const b = pending.brief as { about?: string; standing?: string; defaultOption?: string | null; vetoLeftMs?: number | null; level?: number; revision?: number | null };
    out.push({ ...pending.brief, about: b.about, id: pending.brief.id, itemId: line.itemId!, ask: pending.question ?? line.title, standing: b.standing ?? null, options, defaultOption: b.defaultOption ?? null, vetoLeftMs: b.vetoLeftMs ?? null, level: b.level ?? null, revision: b.revision ?? null });
  }
  return out;
}

/** A chapter ask is the source record, with its owning row and line. */
export type CardAsk = RecordedAsk & { id: string; itemId: string; lineId: number };

export function cardAsks(lines: DeskUpdate[], items: DeskItem[]): CardAsk[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return lines.flatMap((line) => {
    if (line.kind !== 'needs' || line.briefId || !line.itemId || line.resolvedAt !== null) return [];
    const ask = byId.get(line.itemId)?.facts.openAsk;
    if (!ask?.id || ask.id !== line.data.askId || ask.status !== 'open' || ask.kind === 'pointer' || ask.to) return [];
    return [{ ...ask, itemId: line.itemId, lineId: line.id } as CardAsk];
  });
}
