import { wantsOwner } from '../list-model.js';
export const catchupNeedsOwner = wantsOwner;
// The catch-up across spaces (docs/specs/catch-up.md, "Sidebar" and "Inbox summary"): which places get the dot, what
// the Catch me up row counts, and the Inbox's summary card, all from GET /api/desk/chapters. Pure, so the tests read
// it without a page.

import { plainWords } from '../plain-words.js';

/**
 * A space key (`project:<id>`, `agent:<id>`, `system`, `unfiled`) to its route; null for one the desk has no page for.
 * The System page is where its incidents are handled (Ack, Snooze), so the catch-up goes there.
 */
export function spaceRoute(spaceId) {
  if (spaceId === 'system') return { page: 'system', view: 'overview' };
  // Conversations filed nowhere have no page of their own: their row opens the Inbox, where they are.
  if (spaceId === 'unfiled') return { page: 'inbox', view: null };
  const m = /^(project|agent):(.+)$/s.exec(spaceId || '');
  return m ? { page: m[1], id: m[2] } : null;
}

/** Chapters by space key; empty until the desk has read them. */
export function chapterIndex(state) {
  return new Map((state.catchup?.data || []).map((c) => [c.spaceId, c]));
}

/** Something that matters since the owner was there: at least one moment still open. Smaller updates alone don't count. */
export const hasNews = (chapter) => !!chapter && chapter.state === 'news' && chapter.moments > 0;

/**
 * Whether a sidebar place shows the dot. As its counts do: open, a parent speaks for itself (its children show their
 * own dots under it); closed, it shows the dot when it or any child has news.
 */
export function placeDot(place, index, { isOpen = false } = {}) {
  if (hasNews(index.get(place.key))) return true;
  if (isOpen) return false;
  return (place.children || []).some((c) => hasNews(index.get(`project:${c.id}`)));
}

/** The name the owner knows a space by, from the desk's projects and agents; null when it has none (left out). */
export function spaceName(spaceId, { projects = [], agents = [] } = {}) {
  const r = spaceRoute(spaceId);
  if (!r) return null;
  if (r.page === 'system') return 'System';
  if (r.page === 'inbox') return 'Unfiled';
  const list = r.page === 'project' ? projects : agents;
  return list.find((p) => p.id === r.id)?.name || null;
}

/**
 * The spaces with something for the owner, in catch-up order (what needs them first, then moments, then smaller
 * updates), each with its name and route. Spaces the desk can't name or open are left out, and so is a deferred
 * chapter, even with a brief still waiting, until it comes back. Oldest first (this device's sort pick), each group
 * runs from the space whose oldest outstanding line (open, or a brief read and still unanswered) has waited longest,
 * so the places left alone come up first.
 */
const ageOf = (c) => c.oldestAt ?? c.since ?? c.lastAt;
export function catchupSpaces(state, places) {
  const spaces = (state.catchup?.data || [])
    .filter((c) => c.state !== 'deferred' && (c.needs > 0 || c.state === 'news'))
    .map((c) => ({ ...c, name: spaceName(c.spaceId, places), route: spaceRoute(c.spaceId) }))
    .filter((c) => c.name && c.route);
  // catchupMap splits needs, worth a look and smaller, so one sort by age orders each group.
  return state.nextOrder === 'oldest' ? spaces.sort((a, b) => ageOf(a) - ageOf(b)) : spaces;
}

/** The Catch me up row's counts: open moments, and briefs waiting on the owner. */
export function catchupCounts(spaces) {
  return {
    moments: spaces.reduce((n, c) => n + (c.state === 'news' ? c.moments : 0), 0),
    needs: spaces.reduce((n, c) => n + c.needs, 0),
  };
}

/** Where Catch me up goes: its page (docs/specs/catch-up.md, Catch me up), while anything is waiting. */
export const CATCHUP_ROUTE = { page: 'catchup' };
export function nextCatchup(spaces) {
  return spaces.length ? CATCHUP_ROUTE : null;
}

/** Within a space, moments in kind order (needs, failed, decided, shipped, then FYI), newest first within a kind. */
const KIND_ORDER = ['needs', 'failed', 'decided', 'shipped', 'fyi'];
// A correction to a line the owner saw (desk/recheck.ts) goes first: it changes what they think they know.
const orderOf = (l) => (l.data?.changed ? -1 : KIND_ORDER.indexOf(l.kind));
export const momentOrder = (a, b) => orderOf(a) - orderOf(b) || b.at - a.at;

/**
 * A line in the owner's words: the chapter writer's short title when it wrote one (the ledger's title stays as `raw`,
 * the card's detail), else its own title without bare ids (docs/specs/catch-up.md, "Collapsing").
 */
function ownerLine(line, titles) {
  const short = titles[line.id];
  return short ? { ...line, raw: line.title, title: short } : { ...line, title: plainWords(line.title) || line.title };
}

/**
 * A space's open lines from its loaded chapter, less those handled at the tap, in the owner's words; null until the
 * chapter is read. A brief the owner has read but not answered is in `waiting`, not `lines`: it joins them as a moment
 * that needs them, so a space under Needs you always has its brief to show. One the owner deferred stays out until
 * it's back (spec "Accept and Defer": a brief's own Defer leaves today's catch-up), so Defer moves the page on.
 */
export function openLines(chapterEntry, lineLocal = {}, now = Date.now()) {
  const lines = chapterEntry?.data?.lines;
  if (!lines) return null;
  const ids = new Set(lines.map((l) => l.id));
  const titles = chapterEntry.data.view?.titles || {};
  const waiting = (chapterEntry.data.waiting || []).filter((w) => !ids.has(w.id) && !(w.backAt != null && w.backAt > now)).map((w) => ({ ...w, kind: 'needs', moment: true, waiting: true }));
  // Needs you cleaned up (server desk/triage.ts): a repeat shown elsewhere folds under the kept ask (tidyLines), and the
  // writer's sort is a labeled note on its line that changes no count.
  const tidy = chapterEntry.data.view?.tidy;
  const out = tidiedIdsOf(tidy);
  return [...lines, ...waiting].filter((l) => !lineLocal[l.id] && !out.has(l.id)).map((l) => {
    const recorded = l.status ? (catchupNeedsOwner(l) && l.status.pill === l.kind) : true;
    return withTidy(ownerLine(recorded || !['needs', 'failed'].includes(l.kind) ? l : { ...l, kind: 'fyi', moment: false }, titles), tidy, lineLocal, titles);
  });
}

/** The ids Needs you folds away (repeats of an ask kept elsewhere); the server's tidiedIds. */
function tidiedIdsOf(tidy) {
  if (!tidy) return new Set();
  return new Set([...Object.values(tidy.also || {}).flat().map((a) => a.id), ...(tidy.elsewhere || []).map((e) => e.id)]);
}

/** A line with its repeats ("Also asked in “Notifications”") and the writer's note on it, if any. */
export function withTidy(line, tidy, lineLocal = {}, titles = {}) {
  const copies = (tidy?.also?.[line.id] || []).filter((a) => !lineLocal[a.id]);
  const note = summaryNote(tidy?.notes?.[line.id], titles);
  return { ...line, ...(copies.length ? { also: copies } : {}), ...(note ? { note } : {}) };
}

/**
 * The writer's note on a line, as text labeled a summary (docs/specs/desk-status.md: model output explains, never
 * counts): "Summary: reads like the agent's own bookkeeping", "Summary: a later update may have settled this: …",
 * "Summary: this asks you something".
 */
export function summaryNote(note, titles = {}) {
  if (!note) return null;
  if (note.label === 'housekeeping') return 'Summary: reads like the agent’s own bookkeeping';
  if (note.label === 'answered' && note.by) return `Summary: a later update may have settled this: ${titles[note.by.id] || plainWords(note.by.title) || note.by.title}`;
  if (note.label === 'ask') return 'Summary: this asks you something';
  return null;
}

/** "Also asked in “Notifications” and “Unfiled”", or "Also asked 3 more times" when the copies aren't named. */
export function alsoAsked(also) {
  if (!also?.length) return null;
  const names = [...new Set(also.map((a) => a.from).filter(Boolean))];
  if (names.length === also.length && names.length <= 2) return `Also asked in ${names.map((n) => `“${n}”`).join(' and ')}`;
  return `Also asked ${also.length} more time${also.length === 1 ? '' : 's'}`;
}

/**
 * What Needs you folded away in a space, on its own row, folded until opened: Asked elsewhere (a repeat kept in another
 * space). Its open lines and those seen but still waiting (`tidied`), in the owner's words; null until read.
 */
export function tidyLines(chapterEntry, lineLocal = {}) {
  const data = chapterEntry?.data;
  if (!data?.lines) return null;
  const tidy = data.view?.tidy;
  const titles = data.view?.titles || {};
  const byId = new Map([...(data.tidied || []), ...data.lines].map((l) => [l.id, l]));
  const pick = (id) => (lineLocal[id] || !byId.has(id) ? null : ownerLine(byId.get(id), titles));
  return {
    elsewhere: (tidy?.elsewhere || []).map((e) => {
      const l = pick(e.id);
      return l && { ...l, where: e.where };
    }).filter(Boolean),
  };
}

/** How many lines a space's tidy rows hold. */
export const tidyCount = (t) => (t ? t.elsewhere.length : 0);

/**
 * After Accept or Defer, the space is done here once its refreshed chapter has no open moment line left (one that
 * failed stays). A brief Accept leaves for the owner on purpose, or one Defer left unanswered, is a pick in Done here.
 */
export function settledAfterAct(chapterEntry, lineLocal = {}) {
  const lines = chapterEntry?.data?.lines;
  return !!lines && !lines.some((l) => l.moment && !lineLocal[l.id]);
}

/**
 * Whether the page can say what's waiting: 'loading' until the chapter list is read, 'error' when it couldn't be (with
 * nothing read before), 'off' on a desk with no ledger, else 'ready'. Never "caught up" on a failed read.
 */
export function catchupStatus(catchup) {
  if (!catchup) return 'loading';
  if (catchup.error === 'off') return 'off';
  if (catchup.data == null) return catchup.error ? 'error' : 'loading';
  return 'ready';
}

/**
 * What the shared Smaller row's Got it reads: only smaller lines. A moment that came in after the summary put the
 * space under Smaller keeps its own controls, so its space leaves the Got it until the summary catches up.
 */
export function smallerReads(per) {
  // A space's folded-away lines (tidyLines) are shown under it too, so its Got it reads them with the rest.
  const tucked = (t) => (t ? t.elsewhere.map((l) => l.id) : []);
  return per.filter((p) => p.lines && !p.lines.some((l) => l.moment)).map((p) => ({ spaceId: p.space.spaceId, ids: [...p.lines.map((l) => l.id), ...tucked(p.tidy)] }));
}

/**
 * Everything left, the map: one row per space in three groups (what needs the owner, moments but none asking, only
 * smaller updates), less the spaces done here this visit, unless a new moment came in after.
 */
export function catchupMap(spaces, done = {}) {
  const left = spaces.filter((c) => !done[c.spaceId] || (hasNews(c) && c.lastAt > done[c.spaceId].at));
  return {
    needs: left.filter((c) => c.needs > 0),
    look: left.filter((c) => c.needs === 0 && hasNews(c)),
    smaller: left.filter((c) => c.needs === 0 && !hasNews(c)),
  };
}

/**
 * A row's summary: "1 needs you · 2 to see · 4 small", from its open lines once read, else its counts; then what Needs
 * you folded away, once read ("1 asked elsewhere").
 */
export function rowSummary(chapter, lines = null, tidy = null) {
  const needs = lines ? lines.filter((l) => l.kind === 'needs').length : chapter.needs;
  const see = lines ? lines.filter((l) => l.moment && l.kind !== 'needs').length : Math.max(0, chapter.moments - chapter.needs);
  const small = lines ? lines.filter((l) => !l.moment).length : Math.max(0, chapter.smaller - tidyCount(tidy));
  const repeats = tidy?.elsewhere.length || 0;
  return [needs ? `${needs} need${needs === 1 ? 's' : ''} you` : null, see ? `${see} to see` : null, small ? `${small} small` : null,
    repeats ? `${repeats} asked elsewhere` : null].filter(Boolean).join(' · ');
}

/**
 * The focus card: the line the owner tapped while it's still open, else the first open moment of the first space in
 * catch-up order that isn't skipped. Returns `{ space, line }` or null when every moment is handled or skipped.
 */
export function focusOf(spaces, chapters, { lineLocal = {}, skipped = [], focusId = null, done = {} } = {}) {
  const skip = new Set(skipped);
  const map = catchupMap(spaces, done);
  const order = [...map.needs, ...map.look];
  const open = order.map((space) => ({ space, lines: (openLines(chapters[space.spaceId], lineLocal) || []).filter((l) => l.moment).sort(momentOrder) }));
  if (focusId !== null) {
    for (const { space, lines } of open) {
      const line = lines.find((l) => l.id === focusId);
      if (line) return { space, line };
    }
  }
  for (const { space, lines } of open) {
    const line = lines.find((l) => !skip.has(l.id));
    if (line) return { space, line };
  }
  return null;
}

/** One dot per moment the page has shown for a space: filled while open, hollow once handled. */
export function rowDots(shownIds, lines) {
  const open = new Map((lines || []).filter((l) => l.moment).map((l) => [l.id, l]));
  const ids = [...new Set([...(shownIds || []), ...open.keys()])];
  return ids.map((id) => ({ id, kind: open.get(id)?.kind ?? null, hollow: !open.has(id) }));
}

/** The header's "Since Sun 9:00 pm · 11 left": the earliest chapter start and the moments still open. */
export function catchupHeader(spaces) {
  const starts = spaces.map((c) => c.since).filter((t) => typeof t === 'number');
  return { since: starts.length ? Math.min(...starts) : null, left: spaces.reduce((n, c) => n + (c.state === 'news' ? c.moments : 0), 0) };
}

const names = (list, max = 3) => (list.length > max ? `${list.slice(0, max).map((c) => c.name).join(', ')}, …` : list.map((c) => c.name).join(', '));

/**
 * The Inbox summary card: since when, how much, then three lines (needs you, worth a look, smaller updates); null
 * when nothing is waiting.
 */
export function inboxSummary(spaces) {
  if (!spaces.length) return null;
  const need = spaces.filter((c) => c.needs > 0);
  const look = spaces.filter((c) => c.needs === 0 && hasNews(c));
  const small = spaces.filter((c) => c.needs === 0 && !hasNews(c));
  const starts = spaces.map((c) => c.since).filter((t) => typeof t === 'number');
  const updates = spaces.reduce((n, c) => n + (c.state === 'news' ? c.moments + c.smaller : 0), 0);
  const needs = need.reduce((n, c) => n + c.needs, 0);
  return {
    since: starts.length ? Math.min(...starts) : null,
    tally: `${updates} update${updates === 1 ? '' : 's'} across ${spaces.length} place${spaces.length === 1 ? '' : 's'}`,
    lines: [
      need.length ? { kind: 'needs', lead: `${needs} need${needs === 1 ? 's' : ''} you`, where: `in ${names(need)}` } : null,
      look.length ? { kind: 'look', lead: 'Worth a look', where: `in ${names(look)}` } : null,
      small.length ? { kind: 'small', lead: null, where: `Smaller updates in ${small.length === 1 ? small[0].name : `${small.length} ${need.length || look.length ? 'more' : 'places'}`}` } : null,
    ].filter(Boolean),
  };
}

/** A chapter whose read failed and isn't being read again: the page offers Try again rather than Reading… for good. */
export function chapterUnread(entry) {
  return !!entry && !entry.loading && !entry.data && !!entry.error && entry.error !== 'off';
}
