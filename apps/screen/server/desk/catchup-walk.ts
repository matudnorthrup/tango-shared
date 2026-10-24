import { catchupMap, catchupSpaces, focusOf, openLines, rowSummary, tidyLines } from '../../public/desk/next/catchup-model.js';
import { plainWords } from '../../public/desk/plain-words.js';
import type { CardAsk, CardBrief, ChapterPlan } from './catchup-actions.js';
import { isRuleEvent, type ChapterView } from './collapse.js';
import type { Chapter, DeskUpdate } from './updates.js';

// Catch me up by voice (docs/specs/catch-up.md, "Voice"): the same focus card and map the page shows, worked out here
// with the page's own model (catchup-model.js), so the operator reads and acts on what the screens show. The walk's
// skips are the voice session's, as the page's are its visit's: the server keeps none of it.

/** One space's card, as GET /api/desk/chapters/:space reads it. */
export interface WalkCard {
  lines: DeskUpdate[];
  waiting: DeskUpdate[];
  view: ChapterView;
  briefs: CardBrief[];
  asks?: CardAsk[];
  plan?: Pick<ChapterPlan, 'updateIds' | 'revision' | 'line'>;
}

export interface WalkFocus {
  plan?: Pick<ChapterPlan, 'updateIds' | 'revision' | 'line'>;
  spaceId: string;
  name: string;
  headline: string | null;
  line: {
    id: number;
    /** Every line the moment stands for (a PR's folded decisions): what hearing or Got it marks. */
    ids: number[];
    kind: string;
    title: string;
    detail: string | null;
    briefId: string | null;
    itemId: string | null;
    decisionId: string | null;
    /** A brief read but not answered yet: hearing it again marks nothing new. */
    waiting: boolean;
    /** A rule made or changed: news, so Got it only (the page offers no Fine by me on it). */
    rule: boolean;
  };
  /** The brief behind a needs moment: its options, and the one it recommends. */
  ask: CardAsk | null;
  brief: { ask: string; options: Array<{ key: string; label: string; recommended: boolean; answer: string; consequence: string | null }>; defaultOption: string | null; revision: number | null; level: number | null; tripwire: string | null; vetoLeftMs: number | null } | null;
}

export interface WalkRow { spaceId: string; name: string; summary: string }

export interface CatchupWalk {
  focus: WalkFocus | null;
  map: { needs: WalkRow[]; look: WalkRow[]; smaller: WalkRow[] };
  /** Moments still open across every space. */
  left: number;
}

export interface WalkInput {
  chapters: Chapter[];
  card: (spaceId: string) => WalkCard;
  projects: Array<{ id: string; name: string }>;
  agents: Array<{ id: string; name: string }>;
}

/** `skipped`: lines passed this session; `focus`: a line asked for; `space`: "go to <space>", its first moment. */
export function catchupWalk(input: WalkInput, ask: { skipped?: number[]; focus?: number | null; space?: string | null } = {}): CatchupWalk {
  const spaces = catchupSpaces({ catchup: { data: input.chapters } }, { projects: input.projects, agents: input.agents });
  const map = catchupMap(spaces);
  // Only the spaces with moments are read: the smaller ones say their counts.
  const cards = new Map([...map.needs, ...map.look].map((s) => [s.spaceId, input.card(s.spaceId)]));
  const entries = Object.fromEntries([...cards].map(([id, card]) => [id, { data: card }]));
  const skipped = ask.skipped ?? [];
  const wanted = ask.space ? spaces.filter((s) => s.spaceId === ask.space) : [];
  const found = (wanted.length ? focusOf(wanted, entries, { skipped }) : null) ?? focusOf(spaces, entries, { skipped, focusId: ask.focus ?? null });
  let focus: WalkFocus | null = null;
  if (found) {
    const card = cards.get(found.space.spaceId)!;
    const moment = card.view.moments.find((m) => m.line === found.line.id);
    const update = card.lines.find((l) => l.id === found.line.id);
    const brief = found.line.briefId ? card.briefs.find((b) => b.id === found.line.briefId) ?? null : null;
    focus = {
      plan: card.plan,
      spaceId: found.space.spaceId,
      name: found.space.name,
      headline: found.space.headline ? plainWords(found.space.headline) : null,
      line: {
        id: found.line.id,
        ids: moment?.ids ?? [found.line.id],
        kind: found.line.kind,
        title: found.line.title,
        detail: found.line.detail ? plainWords(found.line.detail) : null,
        briefId: found.line.briefId ?? null,
        itemId: found.line.itemId ?? null,
        decisionId: found.line.decisionId ?? null,
        waiting: !!found.line.waiting,
        rule: found.line.kind === 'decided' && !!update && isRuleEvent(update),
      },
      ask: card.asks?.find((a) => a.lineId === found.line.id) ?? null,
      brief: brief ? { ask: plainWords(brief.ask), options: brief.options.map((o) => ({ key: o.key, label: o.label, recommended: o.recommended, answer: o.answer, consequence: o.consequence })), defaultOption: brief.defaultOption, revision: brief.revision, level: brief.level, tripwire: brief.tripwire ?? null, vetoLeftMs: brief.vetoLeftMs } : null,
    };
  }
  const row = (s: (typeof spaces)[number]): WalkRow => ({ spaceId: s.spaceId, name: s.name, summary: rowSummary(s, cards.has(s.spaceId) ? openLines(entries[s.spaceId]) : null, cards.has(s.spaceId) ? tidyLines(entries[s.spaceId]) : null) });
  return {
    focus,
    map: { needs: map.needs.map(row), look: map.look.map(row), smaller: map.smaller.map(row) },
    left: spaces.reduce((n, c) => n + (c.state === 'news' ? c.moments : 0), 0),
  };
}
