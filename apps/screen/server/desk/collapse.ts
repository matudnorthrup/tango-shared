import { plainWords, words } from '../../public/desk/plain-words.js';
import type { DeskUpdate, UpdateKind } from './updates.js';
import { tidiedIds, type ChapterTidy, type ChapterTriage } from './triage.js';

// How a chapter's open lines read on the card (docs/specs/catch-up.md "Collapsing"): one fact, one line, then group.
// The ledger keeps every line; this decides what the owner is shown as moments and how the rest groups.
//
// - A routine decision about a PR (merged once green, merged at the Codex cap under a rule) folds into that PR's
//   Shipped line; a lead's update naming a PR takes that PR's Shipped line under it (the lead's words stand).
// - The chapter's rule changes are one moment, with each rule's controls inside it.
// - Smaller Shipped lines group by theme: the chapter writer's groups, else the PR's scope. The writer can promote one
//   group to a milestone moment.
// - Moments run in a fixed order (needs, broken, rules, milestone, decided); the card shows the first three.
// - Titles read in the owner's language: no commit prefixes, release hashes or PIDs (the raw title stays the detail).
//
// Collapsing applies only to things that need nothing from the owner: a brief or a failure is always its own moment.

/** The chapter writer's grouping, kept with the chapter's prose. */
export interface ChapterLayout {
  groups: Array<{ title: string; ids: number[] }>;
  /** The group (by index) the owner will notice: shown as a moment. */
  milestone: number | null;
  /** Owner-language titles for automatic lines, by line id. */
  titles: Record<string, string>;
  /** The writer's sort of Needs you (triage.ts): chores, asks filed as news, repeats, and asks already answered; notes only. */
  triage?: ChapterTriage;
}

export interface ViewMoment {
  key: string;
  kind: UpdateKind;
  /** Rule changes batched into one moment, or a milestone group: its own title; otherwise the line's. */
  title: string;
  /** Every line this moment stands for, including those folded into it: what seeing it marks. */
  ids: number[];
  /** The line whose card it opens to; null for a batch or a group. */
  line: number | null;
  /** A batch of rule changes, or a milestone group: the lines inside it. */
  lines?: number[];
  batch?: 'rules' | 'milestone';
}

export interface ViewGroup {
  key: string;
  kind: UpdateKind;
  title: string;
  /** The lines listed in the group (each folds its routine decisions in `folded`). */
  lines: number[];
  /** Every line the group stands for. */
  ids: number[];
}

export interface ChapterView {
  moments: ViewMoment[];
  groups: ViewGroup[];
  /** A Shipped line's routine decisions, folded into it (line id → decided line ids). */
  folded: Record<string, number[]>;
  /** Owner-language titles by line id (only where they differ from the line's own). */
  titles: Record<string, string>;
  /** Needs you cleaned up (triage.ts): repeats folded under the kept ask, and the writer's notes. */
  tidy?: ChapterTidy;
}

/** A delegation-rule event's line (a new rule, a suspension, a demotion, with or without a rule id): news, never a decision. */
export const isRuleEvent = (line: Pick<DeskUpdate, 'data'>): boolean => typeof line.data?.ruleEvent === 'string' || typeof line.data?.rule === 'string';

/** The moments the card shows before "+N more moments". */
export const MOMENT_CAP = 3;

const COMMIT_PREFIX = /^(feat|fix|docs|chore|refactor|perf|test|build|ci|style|revert)(\(([^)]*)\))?!?:\s*/i;

/** A title in the owner's language: an automatic line's commit prefix, issue tag, release hash and PID taken out. */
/** A title that named only an id ("TGO-123."): nothing is left to say, and the bare id isn't shown. */
export const BARE_TITLE = 'An update';

export function ownerTitle(raw: string): string {
  const title = raw
    .replace(/^Merged PR #\d+:\s*/i, '')
    .replace(COMMIT_PREFIX, '')
    .replace(/\s*\((?:[A-Z]{2,5}-\d+(?:,\s*)?)+\)/g, '')
    .replace(/\s+on release \S+?(?=[\s,;:.)]|$)/gi, '')
    .replace(/\s+at [0-9a-f]{7,40}\b/gi, '')
    .replace(/\s*\(PID \d+\)/gi, '')
    .replace(/\s+—\s+/g, ': ')
    .replace(/\s+/g, ' ')
    .trim();
  const plain = plainWords(title || raw);
  return plain ? plain[0]!.toUpperCase() + plain.slice(1) : BARE_TITLE;
}

/** A highlight's title: short, the way the card reads at a glance. */
export const TITLE_WORDS = 10;

/** The theme a Shipped line falls under without the writer: its PR's scope ("desk", "loom"), docs, or the rest. */
export function themeOf(line: Pick<DeskUpdate, 'title' | 'source'>): string {
  const m = line.title.replace(/^Merged PR #\d+:\s*/i, '').match(COMMIT_PREFIX);
  if (!m) return 'other';
  if (/^docs$/i.test(m[1]!)) return 'docs';
  const scope = m[3]?.split(/[,/]/)[0]?.trim().toLowerCase();
  return scope || 'other';
}

const THEME_TITLE: Record<string, string> = { other: 'Other changes', docs: 'Docs' };
const themeTitle = (theme: string) => THEME_TITLE[theme] ?? `${theme[0]!.toUpperCase()}${theme.slice(1)}`;

/** The PRs a line names: its PR links as "owner/repo#N", then bare "#N" in its words (any repo). */
export function prRefs(line: Pick<DeskUpdate, 'title' | 'detail' | 'refs'>): { full: string[]; bare: number[] } {
  const full: string[] = [];
  for (const r of line.refs ?? []) {
    const m = r.url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (m) full.push(`${m[1]!.toLowerCase()}#${m[2]}`);
  }
  const bare: number[] = [];
  for (const m of `${line.title} ${line.detail ?? ''}`.matchAll(/(?:^|[\s(])#(\d+)\b/g)) bare.push(Number(m[1]));
  return { full: [...new Set(full)], bare: [...new Set(bare)] };
}

/** A Shipped line's PR, from its subject "pr:owner/repo#N". */
export const prOf = (line: Pick<DeskUpdate, 'subject'>): { key: string; n: number } | null => {
  const m = line.subject?.match(/^pr:(.+)#(\d+)$/);
  return m ? { key: `${m[1]!.toLowerCase()}#${m[2]}`, n: Number(m[2]) } : null;
};

/** Board classes whose decisions are about a PR itself (merging it, its housekeeping, its reviewer). */
export const PR_CLASSES: ReadonlySet<string> = new Set(['merge-when-green', 'pr-housekeeping', 'reviewer-choice']);

// A correction to a line the owner saw (recheck.ts) goes first: it changes what they think they know.
const RANK: Record<string, number> = { changed: -1, needs: 0, failed: 1, rules: 2, shipped: 3, milestone: 3, decided: 4, fyi: 5 };

/** The card's view of a chapter's open lines (newest first, as the ledger lists them). */
export function collapse(all: DeskUpdate[], layout: ChapterLayout | null = null, tidy: ChapterTidy | null = null): ChapterView {
  const titles: Record<string, string> = {};
  const lines = tidied(all, tidy);
  for (const line of all) {
    // The writer's short title first; else the line's own, in plain words (a lead writes its own, so only ids go).
    const written = layout?.titles[String(line.id)];
    const title = (written && words(plainWords(written), TITLE_WORDS)) || (line.source === 'lead' ? plainWords(line.title) || BARE_TITLE : ownerTitle(line.title));
    if (title && title !== line.title) titles[String(line.id)] = title;
  }
  const titleOf = (line: DeskUpdate) => titles[String(line.id)] ?? line.title;

  // One event, one line: a routine decision about a PR in this chapter folds into the PR's Shipped line.
  const prLines = new Map<string, DeskUpdate>();
  const byNumber = new Map<number, DeskUpdate[]>();
  for (const line of lines) {
    const pr = line.kind === 'shipped' ? prOf(line) : null;
    if (!pr || prLines.has(pr.key)) continue;
    prLines.set(pr.key, line);
    byNumber.set(pr.n, [...(byNumber.get(pr.n) ?? []), line]);
  }
  // A PR link names its repo; a bare "#N" folds only when one Shipped line in the chapter has that number. A decision
  // that only links a PR for context ("stopped a sandbox test", linking the PR it found) is its own event: a link folds
  // only for a PR-workflow decision or one whose words name that PR.
  const about = (line: DeskUpdate, key: string) => PR_CLASSES.has(line.class ?? '') || prRefs(line).bare.includes(Number(key.split('#')[1]));
  const shippedFor = (line: DeskUpdate): DeskUpdate | undefined => {
    const { full, bare } = prRefs(line);
    for (const key of full) if (prLines.has(key) && about(line, key)) return prLines.get(key);
    if (full.length) return undefined;
    for (const n of bare) if (byNumber.get(n)?.length === 1) return byNumber.get(n)![0];
    return undefined;
  };
  const folded: Record<string, number[]> = {};
  const into = new Set<number>();
  for (const line of lines) {
    // A lead's own words about a PR take the PR line instead (below).
    if (line.kind !== 'decided' || line.moment || line.source === 'lead' || isRuleEvent(line)) continue;
    const pr = shippedFor(line);
    if (!pr) continue;
    (folded[String(pr.id)] ??= []).push(line.id);
    into.add(line.id);
  }
  // A lead's update about a PR and that PR's own Shipped line are one event: the lead's words stand, and the PR line
  // (with what folded into it) folds under them.
  for (const line of lines) {
    if (line.source !== 'lead' || line.kind === 'needs' || line.kind === 'failed' || into.has(line.id)) continue;
    const { full, bare } = prRefs(line);
    // A lead's decision, like any decision, folds a PR it only links for context into nothing.
    const named = full.length ? full.filter((key) => line.kind !== 'decided' || about(line, key)).map((key) => prLines.get(key)) : bare.map((n) => (byNumber.get(n)?.length === 1 ? byNumber.get(n)![0] : undefined));
    for (const pr of named) {
      if (!pr || pr.id === line.id || into.has(pr.id)) continue;
      (folded[String(line.id)] ??= []).push(pr.id, ...(folded[String(pr.id)] ?? []));
      delete folded[String(pr.id)];
      into.add(pr.id);
    }
  }
  const withFolded = (ids: number[]) => ids.flatMap((id) => [id, ...(folded[String(id)] ?? [])]);

  const moments: Array<ViewMoment & { rank: number; at: number }> = [];
  const rules = lines.filter((l) => l.moment && l.kind === 'decided' && isRuleEvent(l));
  if (rules.length > 1) {
    moments.push({ key: 'rules', kind: 'decided', title: `${rules.length} rule changes`, ids: rules.map((l) => l.id), line: null, lines: rules.map((l) => l.id), batch: 'rules', rank: RANK.rules!, at: rules[0]!.at });
  }
  for (const line of lines) {
    if (!line.moment || into.has(line.id) || (rules.length > 1 && rules.includes(line))) continue;
    const rank = line.data?.changed ? RANK.changed! : line.kind === 'decided' && isRuleEvent(line) ? RANK.rules! : RANK[line.kind]!;
    moments.push({ key: `line:${line.id}`, kind: line.kind, title: titleOf(line), ids: withFolded([line.id]), line: line.id, rank, at: line.at });
  }

  // The smaller lines: Shipped by theme (the writer's groups first), then routine decisions, failures and FYIs.
  const smaller = lines.filter((l) => !l.moment && !into.has(l.id));
  const shipped = smaller.filter((l) => l.kind === 'shipped');
  const placed = new Set<number>();
  const shippedGroups: Array<{ title: string; lines: number[]; writer: number | null }> = [];
  for (const [i, g] of (layout?.groups ?? []).entries()) {
    const ids = g.ids.filter((id) => !placed.has(id) && shipped.some((l) => l.id === id));
    // A group title that was only an id says nothing: its lines go to their themes instead.
    const title = words(plainWords(g.title), TITLE_WORDS);
    if (!ids.length || !title) continue;
    ids.forEach((id) => placed.add(id));
    shippedGroups.push({ title, lines: ids, writer: i });
  }
  const byTheme = new Map<string, number[]>();
  for (const line of shipped) {
    if (placed.has(line.id)) continue;
    const theme = themeOf(line);
    byTheme.set(theme, [...(byTheme.get(theme) ?? []), line.id]);
  }
  // Themes with the most first; "Other changes" last.
  for (const [theme, ids] of [...byTheme].sort((a, b) => (a[0] === 'other' ? 1 : 0) - (b[0] === 'other' ? 1 : 0) || b[1].length - a[1].length || a[0].localeCompare(b[0]))) shippedGroups.push({ title: themeTitle(theme), lines: ids, writer: null });

  const groups: ViewGroup[] = [];
  for (const [i, g] of shippedGroups.entries()) {
    const ids = withFolded(g.lines);
    // The milestone: the group the owner will notice, shown as a moment of its own.
    if (g.writer !== null && g.writer === layout?.milestone) {
      const newest = Math.max(...g.lines.map((id) => lines.find((l) => l.id === id)!.at));
      moments.push({ key: `milestone:${i}`, kind: 'shipped', title: g.title, ids, line: null, lines: g.lines, batch: 'milestone', rank: RANK.milestone!, at: newest });
      continue;
    }
    groups.push({ key: `shipped:${i}`, kind: 'shipped', title: g.title, lines: g.lines, ids });
  }
  for (const [kind, title] of [['decided', 'Routine'], ['failed', 'Failed'], ['fyi', 'FYI'], ['needs', 'Needs you']] as const) {
    const ids = smaller.filter((l) => l.kind === kind).map((l) => l.id);
    if (ids.length) groups.push({ key: kind, kind, title, lines: ids, ids: withFolded(ids) });
  }

  moments.sort((a, b) => a.rank - b.rank || b.at - a.at);
  return { moments: moments.map(({ rank: _rank, at: _at, ...m }) => m), groups, folded, titles, ...(tidy ? { tidy } : {}) };
}

/** The lines as Needs you reads them once cleaned up: repeats shown elsewhere out (they fold under the kept ask). */
export function tidied(lines: DeskUpdate[], tidy: ChapterTidy | null | undefined): DeskUpdate[] {
  if (!tidy) return lines;
  const out = tidiedIds(tidy);
  return lines.filter((l) => !out.has(l.id));
}

/** Reads a stored layout, dropping anything malformed. */
export function readLayout(text: unknown): ChapterLayout | null {
  if (typeof text !== 'string' || !text) return null;
  try {
    const raw = JSON.parse(text) as Partial<ChapterLayout>;
    const groups = Array.isArray(raw.groups)
      ? raw.groups.filter((g) => g && typeof g.title === 'string' && Array.isArray(g.ids)).map((g) => ({ title: g.title, ids: g.ids.filter((id) => Number.isInteger(id)) }))
      : [];
    const titles = raw.titles && typeof raw.titles === 'object' ? Object.fromEntries(Object.entries(raw.titles).filter(([, v]) => typeof v === 'string')) : {};
    const milestone = Number.isInteger(raw.milestone) && (raw.milestone as number) >= 0 && (raw.milestone as number) < groups.length ? (raw.milestone as number) : null;
    const triage = readTriage(raw.triage);
    return { groups, milestone, titles, ...(triage ? { triage } : {}) };
  } catch {
    return null;
  }
}

const intIds = (v: unknown): number[] => (Array.isArray(v) ? [...new Set(v.filter((id): id is number => Number.isInteger(id)))] : []);
/** A stored or written sort, its shape checked (which ids may go where is the writer's and triage.ts's to check). */
export function readTriage(raw: unknown): ChapterTriage | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const same = Array.isArray(t.same) ? t.same.map(intIds).filter((g) => g.length > 1) : [];
  const answered = t.answered && typeof t.answered === 'object' && !Array.isArray(t.answered)
    ? Object.fromEntries(Object.entries(t.answered as Record<string, unknown>).filter(([k, v]) => /^\d+$/.test(k) && Number.isInteger(v)).map(([k, v]) => [k, v as number]))
    : {};
  const triage = { chores: intIds(t.chores), asks: intIds(t.asks), same, answered };
  return triage.chores.length || triage.asks.length || triage.same.length || Object.keys(triage.answered).length ? triage : null;
}
