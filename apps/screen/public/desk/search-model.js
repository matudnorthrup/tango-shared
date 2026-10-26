// Desk search (TGO-958): the state and actions behind the ⌘K palette, the List's search mode and
// the read-only transcript, plus the pure helpers they render with. Kept free of the DOM so it can be tested.
//
// The server ranks (keyword + meaning, GET /api/desk/search) and hands back each hit with its List
// row; saved views and picker choices travel to the server before it ranks and limits.

import { agentId, facetCounts, matches, normalizeRetiredView, viewToQuery } from './query.js';
import { viewsOf } from './list-views.js';
import { liveState, rowTitle } from './list-model.js';

export const SEARCH_LIMIT = 150;
const DEBOUNCE_MS = 180;
const MARK_OPEN = '\u0002';
const MARK_CLOSE = '\u0003';

export const SORTS = [
  ['best', 'Best match'],
  ['recent', 'Newest'],
];

export function blankSearch() {
  return {
    open: false, // the ⌘K palette
    inList: false, // the List shows results instead of its rows
    query: '',
    hits: [],
    searched: '', // the query the hits are for
    loading: false,
    error: null,
    semantic: false, // the server ranked by meaning too
    cursor: 0, // the palette's highlighted hit
    tab: 'all', // the List's results: all, or one of the owner's views
    sort: 'best',
    project: '',
    repo: '',
    scope: 'global',
    space: null,
    total: 0,
    more: false,
    tokens: [],
    agent: '',
    wide: false, // done and archived conversations too (the default is open ones only)
    wider: null, // { total, more }: what widening would add
    focus: false, // the List's field takes focus at the next render ("/" on the List)
  };
}

/** A snippet as runs of text, the matched words marked (the server wraps them in \u0002 … \u0003). */
export function markParts(snippet) {
  const parts = [];
  let mark = false;
  let text = '';
  for (const ch of String(snippet ?? '')) {
    if (ch === MARK_OPEN || ch === MARK_CLOSE) {
      if (text) parts.push({ text, mark });
      text = '';
      mark = ch === MARK_OPEN;
      continue;
    }
    text += ch;
  }
  if (text) parts.push({ text, mark });
  return parts;
}

export const plainSnippet = (snippet) => String(snippet ?? '').replace(/[\u0002\u0003]/g, '');

/** The hits a view keeps, with the project and agent picks on top. */
export function filterHits(hits, { view = null, project = '', agent = '', projects = [] } = {}) {
  // `project` is the workspace picker (Loom's projects); `projects` the owner's, for a view that filters on them.
  const query = view ? viewToQuery(normalizeRetiredView(view), { audience: 'owner' }) : { scope: { kind: 'global' }, audience: 'all', where: {} };
  return hits.filter(({ row }) => matches(row, query, { projects }) && matches(row, { scope: { kind: 'global' }, audience: 'all', where: { ...(project ? { workspace: { in: [project] } } : {}), ...(agent ? { agent: { in: [agent] } } : {}) } }, { projects }));
}

/** Serialize the saved view and picker choices for filtering before ranking. */
export function searchOptions(state) {
  const s = state.search;
  const view = viewsOf(state.listViews, state.listGroup).find((v) => v.id === s.tab);
  const query = view ? viewToQuery(normalizeRetiredView(view), { audience: 'owner' }) : { audience: 'all', where: {} };
  const where = { ...query.where };
  for (const [facet, value] of [['project', s.project], ['workspace', s.repo], ['agent', s.agent]]) {
    if (!value) continue;
    const previous = where[facet];
    where[facet] = { in: [value], ...(previous?.not ? { not: previous.not } : {}) };
    if ((previous?.in?.length || previous?.unset === true) && !previous.in?.includes(value)) where[facet].not = [...(where[facet].not || []), value];
  }
  return { limit: SEARCH_LIMIT, where, scope: s.scope || 'global', audience: query.audience, include: s.wide ? 'all' : 'open' };
}

/** Best match keeps the server's order; Newest goes by last activity. */
export function sortHits(hits, sort) {
  return sort === 'recent' ? [...hits].sort((a, b) => (b.row.lastActivityAt || 0) - (a.row.lastActivityAt || 0)) : hits;
}

/** The projects and agents among the hits, most hits first: the List's pickers. */
export function hitFacets(hits) {
  const rows = hits.map(({ row }) => row);
  const query = { scope: { kind: 'global' }, audience: 'all', where: {} };
  const projects = [...facetCounts(rows, query, 'workspace')].filter(([name]) => name != null).map(([name, count]) => ({ name, count }));
  // The picker lists named agents; raw coding-source ids remain readable in saved tabs and hide settings.
  const named = rows.filter((row) => !['loom'].includes(row.source) || row.facts?.agentSpace?.id);
  const agents = [...facetCounts(named, query, 'agent')].filter(([id]) => id != null).map(([id, count]) => {
    const row = named.find((row) => agentId(row) === id);
    return { id, name: row?.facts?.agentSpace?.name || row?.agentName || id, count };
  });
  return {
    projects: projects.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    agents: agents.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}

/** Where a result stands, said as briefly as the List says it. */
export function hitStatus(row) {
  if (row.archived) return 'archived';
  if (row.disposition === 'done') return 'done';
  if (row.disposition === 'snoozed' || row.disposition === 'parked') return row.disposition;
  return { failed: 'failed', needs: 'needs you', working: 'working', waiting: row.facts?.held ? 'held by Loom' : 'waiting', stuck: 'stuck', finished: 'finished', idle: 'idle', unknown: 'unknown' }[liveState(row)] ?? '';
}

/**
 * Whether the results are open conversations only (`open`), and the link that changes that: "Also search done
 * and archived (N)", N being what widening adds (N+ for a lower bound), or back to "Only open conversations".
 * A view that picks statuses itself (History) is neither: the open-only default doesn't apply to it (Codex review on #865).
 */
export function searchScope(state) {
  const s = state.search;
  if (searchOptions(state).where.disposition) return { open: false, link: null };
  if (s.wide) return { open: false, link: { label: 'Only open conversations', wide: false } };
  return { open: true, link: s.wider?.total ? { label: `Also search done and archived (${s.wider.total}${s.wider.more ? '+' : ''})`, wide: true } : null };
}

/** The message lines a result shows under its name (the title line is the name itself). */
export const messageMatches = (hit) => (hit.matches || []).filter((m) => m.how !== 'title' && m.snippet);

/** The first message that matched: where its transcript opens. */
export const firstMessage = (hit) => messageMatches(hit).find((m) => m.messageId)?.messageId || null;

export { rowTitle };

/**
 * The search actions, bound to the store: `get` reads its state, `set` patches it. Typing searches
 * after a short pause; an answer for words since replaced is dropped.
 */
export function createSearchActions({ client, get, set, openItem, goHome }) {
  let timer = null;
  let seq = 0;
  const patch = (fields) => set({ search: { ...get().search, ...fields } });

  async function run(query) {
    const mine = ++seq;
    if (!query.trim()) return patch({ hits: [], searched: '', total: 0, more: false, tokens: [], wider: null, wide: false, loading: false, error: null });
    patch({ loading: true, error: null });
    try {
      const result = await client.search(query, searchOptions(get()));
      if (mine !== seq) return;
      patch({ hits: result.hits || [], searched: query, semantic: !!result.semantic, total: result.total ?? result.hits?.length ?? 0, more: !!result.more, tokens: result.tokens || [], wider: result.wider || null, loading: false, cursor: 0 });
    } catch (err) {
      if (mine === seq) patch({ loading: false, error: err.message });
    }
  }

  function setQuery(query) {
    // An answer still on its way is for the old words: drop it now, not when the new search starts (Codex review on #509).
    seq += 1;
    patch({ query });
    clearTimeout(timer);
    timer = setTimeout(() => run(query), query.trim() ? DEBOUNCE_MS : 0);
  }

  function openPalette() {
    patch({ open: true, cursor: 0 });
  }
  function closePalette() {
    patch({ open: false });
  }
  /** The palette's words, as a List of results the views filter. */
  function showInList() {
    if (get().presentation.view !== 'active') goHome();
    patch({ open: false, inList: true, tab: 'all' });
  }
  function startListSearch({ focus = false } = {}) {
    patch({ inList: true, focus });
  }
  function clearSearch() {
    clearTimeout(timer);
    seq += 1;
    set({ search: { ...blankSearch(), sort: get().search.sort } });
  }
  function setSearchOption(fields) {
    patch(fields);
    if (Object.keys(fields).some((key) => ['tab', 'project', 'repo', 'agent', 'scope', 'wide'].includes(key))) {
      clearTimeout(timer);
      return run(get().search.query);
    }
  }

  // ── the transcript ──
  async function loadTranscript(itemId, params, merge) {
    try {
      const page = await client.transcript(itemId, params);
      const t = get().transcript;
      if (!t || t.itemId !== itemId) return;
      const messages = merge === 'earlier' ? [...page.messages, ...t.messages] : merge === 'later' ? [...t.messages, ...page.messages] : page.messages;
      set({
        transcript: {
          ...t,
          row: page.row || t.row,
          messages,
          hasEarlier: merge === 'later' ? t.hasEarlier : page.hasEarlier,
          hasLater: merge === 'earlier' ? t.hasLater : page.hasLater,
          loading: false,
          error: null,
        },
      });
    } catch (err) {
      const t = get().transcript;
      if (t?.itemId === itemId) set({ transcript: { ...t, loading: false, error: err.message } });
    }
  }
  function openTranscript(itemId, around = null, row = null) {
    set({ transcript: { itemId, around, row, messages: [], hasEarlier: false, hasLater: false, loading: true, error: null } });
    return loadTranscript(itemId, around ? { around } : {});
  }
  function moreTranscript(direction) {
    const t = get().transcript;
    if (!t || t.loading || !t.messages.length) return;
    set({ transcript: { ...t, loading: true } });
    const edge = direction === 'earlier' ? { before: t.messages[0].messageId } : { after: t.messages.at(-1).messageId };
    return loadTranscript(t.itemId, edge, direction);
  }
  function closeTranscript() {
    set({ transcript: null });
  }

  /** A result's name: the conversation on the desk, or its transcript when the desk let it go. */
  function openHit(hit) {
    patch({ open: false });
    if (hit.row.archived) return openTranscript(hit.itemId, firstMessage(hit), hit.row);
    openItem(hit.itemId);
  }

  /** The nav's Search: the palette on a desk; on a phone (no keyboard to type over the List), the List's field. */
  function openFrom(phone) {
    if (!phone) return openPalette();
    if (get().presentation.view !== 'active') goHome();
    startListSearch({ focus: true });
  }

  return { openSearchFrom: openFrom, setSearchQuery: setQuery, openSearch: openPalette, closeSearch: closePalette, showSearchInList: showInList, startListSearch, clearSearch, setSearchOption, openTranscript, moreTranscript, closeTranscript, openHit };
}
