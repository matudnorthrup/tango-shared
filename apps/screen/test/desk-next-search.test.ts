import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain browser module
import { createNextNav } from '../public/desk/next/nav.js';
// @ts-expect-error plain browser module
import { routeKey, crumbsOf } from '../public/desk/next/model.js';
// @ts-expect-error plain browser module
import { SearchPage } from '../public/desk/next/search.js';
// @ts-expect-error plain browser module
import { blankSearch, searchOptions, searchScope } from '../public/desk/search-model.js';

vi.mock('../public/vendor/preact-htm.js', async original => ({
  ...await original<any>(), useState: (v: any) => [v, () => {}], useRef: (v: any) => ({ current: v }), useEffect: () => {},
}));
// @ts-expect-error plain browser module
import { Switcher } from '../public/desk/next/switcher.js';

afterEach(() => vi.unstubAllGlobals());

function makeStore() {
  const saved = new Map();
  vi.stubGlobal('localStorage', { getItem: (k: string) => saved.get(k), setItem: (k: string, v: string) => saved.set(k, v), removeItem: (k: string) => saved.delete(k) });
  vi.stubGlobal('window', { scrollTo: vi.fn() });
  const store: any = {
    state: { presentation: { view: 'active' }, search: blankSearch(), lists: {}, projects: [], now: Date.now() },
    set(patch: any) { Object.assign(this.state, patch); },
    setSearchQuery(query: string) { this.state.search = { ...this.state.search, query }; },
    setListTab: vi.fn(),
    openItem(id: string) { this.state.presentation = { view: 'conversation', itemId: id }; },
    goBoard() { this.state.presentation = { view: 'active' }; },
    setSearchOption(patch: any) { Object.assign(this.state.search, patch); },
    openHit: vi.fn(),
  };
  Object.assign(store, createNextNav(store));
  return store;
}

// Inspect the page's real event handlers without a browser or a DOM renderer.
function nodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}

describe('next search', () => {
  it('retains query and picks through a live thread and Back, and restores saved search', () => {
    const store = makeStore();
    const route = { page: 'search', query: 'router' };
    store.nextGo(route);
    store.setSearchOption({ tab: 'working', sort: 'recent', agent: 'sierra' });
    store.nextOpen('live');
    expect(store.threadOpen()).toBe(true);
    store.nextBack();
    expect(store.state.nextRoute).toEqual(route);
    expect(store.state.search).toMatchObject({ query: 'router', tab: 'working', sort: 'recent', agent: 'sierra' });
    store.nextGo({ page: 'search' });
    expect(store.state.nextRoute).toEqual(route);
    store.setSearchQuery('');
    createNextNav(store);
    expect(store.state.search.query).toBe('router');
    expect(routeKey(route)).not.toBe(routeKey({ page: 'search', query: 'different' }));
  });

  it('Back from a worker or job goes to what it reports to, one crumb (swipe, Esc, voice and the crumb agree)', () => {
    const store = makeStore();
    const owner = { id: 'dd', source: 'loom', place: 'tango · Decision Delegation', facts: {} };
    const worker = { id: 'w', source: 'loom', place: 'tango · Phase 3', facts: { role: 'worker', parentItemId: 'dd' } };
    const chat = { id: 'chat', kind: 'chapter', agentId: 'sierra', agentName: 'Sierra', source: 'discord', facts: {} };
    const job = { id: 'j', agentId: 'sierra', agentName: 'Sierra', source: 'discord', facts: { name: 'Fuel watch', role: 'ops', parentItemId: 'chat' } };
    store.state.lists = { active: { items: [owner, worker, chat, job] } };
    store.nextGo({ page: 'inbox', view: null });
    store.nextOpen('w');
    store.nextBack();
    expect(store.state.presentation).toEqual({ view: 'conversation', itemId: 'dd' });
    store.nextBack();
    expect(store.threadOpen()).toBe(false);
    // On the agent's own page its chat is the place: Back leaves the job for the page.
    store.nextGo({ page: 'agent', id: 'sierra' });
    store.nextOpen('j');
    store.nextBack();
    expect(store.threadOpen()).toBe(false);
    // From the Inbox the chat is a crumb of its own, so Back opens it.
    store.nextGo({ page: 'inbox', view: null });
    store.nextOpen('j');
    store.nextBack();
    expect(store.state.presentation.itemId).toBe('chat');
  });

  it('Forward re-applies the last Back, and a move of the owner\'s own clears it', () => {
    const store = makeStore();
    const owner = { id: 'dd', source: 'loom', facts: {} };
    const worker = { id: 'w', source: 'loom', facts: { role: 'worker', parentItemId: 'dd' } };
    store.state.lists = { active: { items: [owner, worker] } };
    store.nextGo({ page: 'project', id: 'tango' });
    store.nextOpen('w');
    store.nextBack(); // to the owner
    store.nextBack(); // to the project
    store.nextBack(); // up to Projects
    expect(store.state.nextRoute).toEqual({ page: 'projects' });
    expect(store.canForward()).toBe(true);
    expect(store.nextForward()).toBe(true);
    expect(store.state.nextRoute).toEqual({ page: 'project', id: 'tango' });
    expect(store.threadOpen()).toBe(false);
    store.nextForward();
    expect(store.state.presentation).toEqual({ view: 'conversation', itemId: 'dd' });
    store.nextForward();
    expect(store.state.presentation).toEqual({ view: 'conversation', itemId: 'w' });
    expect(store.state.nextRoute).toEqual({ page: 'project', id: 'tango' });
    expect(store.nextForward()).toBe(false);
    // Back at the root moves nothing, so there is nothing to go forward to.
    store.nextGo({ page: 'inbox', view: null });
    store.nextBack();
    expect(store.canForward()).toBe(false);
    // Going somewhere else after a Back clears Forward, as in a browser.
    store.nextOpen('dd');
    store.nextBack();
    store.nextGo({ page: 'agents' });
    expect(store.nextForward()).toBe(false);
    // So does the thread changing under it (another window, a project move).
    store.nextOpen('dd');
    store.nextBack();
    store.state.presentation = { view: 'conversation', itemId: 'w' };
    expect(store.nextForward()).toBe(false);
    expect(store.state.presentation).toEqual({ view: 'conversation', itemId: 'w' });
  });

  it('a move from another window clears Forward, even one that comes back (Codex review on #790)', () => {
    const store = makeStore();
    const listeners: Array<() => void> = [];
    store.subscribe = (fn: () => void) => listeners.push(fn);
    Object.assign(store, createNextNav(store));
    const notify = () => listeners.forEach((fn) => fn());
    store.nextGo({ page: 'inbox', view: null });
    store.nextOpen('dd');
    store.nextBack();
    notify();
    expect(store.canForward()).toBe(true);
    // Another window opens a thread, then goes back to the Inbox: this window passes through both.
    store.state.presentation = { view: 'conversation', itemId: 'w' };
    notify();
    store.state.presentation = { view: 'active' };
    notify();
    expect(store.nextForward()).toBe(false);
    expect(store.threadOpen()).toBe(false);
  });

  it('leaving a thread for its place lands at the top of the place, however it closed', () => {
    const store = makeStore();
    const listeners: Array<() => void> = [];
    store.subscribe = (fn: () => void) => listeners.push(fn);
    Object.assign(store, createNextNav(store));
    const notify = () => listeners.forEach((fn) => fn());
    const scrollTo = (window as any).scrollTo;
    store.nextGo({ page: 'catchup' });
    store.state.presentation = { view: 'conversation', itemId: 'dd' };
    notify();
    scrollTo.mockClear();
    // Done or Snooze in the thread (or another window) closes it: the store goes back to the board.
    store.state.presentation = { view: 'active' };
    notify();
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    // Updates while the place is up don't move it.
    scrollTo.mockClear();
    notify();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('Forward puts a stage back over its thread', () => {
    const store = makeStore();
    store.showConversation = function () { this.openItem(this.state.presentation.itemId); };
    store.showScreen = vi.fn(function (this: any, sceneId: string, owner: any) { this.state.presentation = { view: 'screen', sceneId, itemId: owner.itemId }; });
    store.state.presentation = { view: 'screen', sceneId: 's1', itemId: 'dd', conversationKey: 'k' };
    store.nextBack();
    expect(store.state.presentation).toEqual({ view: 'conversation', itemId: 'dd' });
    store.nextForward();
    expect(store.showScreen).toHaveBeenCalledWith('s1', { itemId: 'dd', conversationKey: 'k' });
    expect(store.state.presentation.view).toBe('screen');
  });

  it('edits the query and exposes the view, sort and facet controls', () => {
    const store = makeStore();
    store.nextGo({ page: 'search', query: 'router' });
    const tree = nodes(SearchPage({ store }));
    tree.find((n) => n.type === 'input').props.onInput({ target: { value: 'repair' } });
    expect(store.state.nextRoute).toEqual({ page: 'search', query: 'repair' });
    const selects = tree.filter((n) => n.type === 'select');
    expect(selects.map((n) => n.props['aria-label'])).toEqual(['Sort', 'Project', 'Repo', 'Agent']);
    selects[0].props.onChange({ target: { value: 'recent' } });
    selects[1].props.onChange({ target: { value: 'sample' } });
    selects[2].props.onChange({ target: { value: 'tango' } });
    selects[3].props.onChange({ target: { value: 'sierra' } });
    expect(store.state.search).toMatchObject({ sort: 'recent', project: 'sample', repo: 'tango', agent: 'sierra' });
    const tabs = tree.filter((n) => n.props?.role === 'tab');
    expect(tabs.length).toBeGreaterThan(1);
    tabs[1].props.onClick();
    expect(store.state.search.tab).not.toBe('all');
  });

  it('starts scoped from project and agent pages, offers opting out and shows the space crumb', () => {
    const store = makeStore();
    store.state.projects = [{ id: 'desk', name: 'Desk' }];
    store.nextGo({ page: 'project', id: 'desk' });
    store.nextGo({ page: 'search', query: 'router' });
    expect(store.state.search.scope).toBe('space:project:desk');
    expect(crumbsOf(store.state.nextRoute, { projects: store.state.projects }).map((c: any) => c.label)).toContain('Desk');
    const checkbox = nodes(SearchPage({ store })).find((n) => n.type === 'input' && n.props.type === 'checkbox');
    expect(checkbox.props.checked).toBe(true);
    checkbox.props.onChange({ target: { checked: false } });
    expect(store.state.search.scope).toBe('global');
    store.nextGo({ page: 'agent', id: 'sierra' });
    store.nextGo({ page: 'search', query: 'router' });
    expect(store.state.search.scope).toBe('space:agent:sierra');
  });

  it.each(['project', 'agent', 'search', 'inbox'])('opens the switcher everywhere from %s, clearing hidden picks', (page) => {
    const store = makeStore();
    store.nextGo({ page, id: 'sample' });
    store.setSearchOption({ scope: 'space:project:other', space: { id: 'project:other', name: 'Other' }, tab: 'working', project: 'other', repo: 'repo', agent: 'agent', wide: true });
    store.nextSwitch();
    expect(store.state.nextSwitcher).toBe(true);
    expect(store.state.search).toMatchObject({ scope: 'global', space: null, tab: 'all', project: '', repo: '', agent: '', wide: true });
    expect(searchOptions(store.state)).toMatchObject({ scope: 'global', audience: 'all', where: {}, include: 'all' });
    store.setSearchOption({ wide: false });
    store.nextSwitch(false);
    expect(store.state.nextSwitcher).toBe(false);
    expect(store.state.search.wide).toBe(false);
  });

  it.each(['project', 'agent', 'search'])('All results from %s keeps the switcher query and global scope', (page) => {
    const store = makeStore();
    store.nextGo({ page, id: 'sample' });
    store.nextSwitch();
    store.setSearchQuery('ios');
    const before = searchOptions(store.state);
    const tree = nodes(Switcher({ store }));
    tree.find((n) => n.type === 'button' && n.props.children === 'All 0 results').props.onClick();
    expect(store.state.nextSwitcher).toBe(false);
    expect(store.state.nextRoute).toMatchObject({ page: 'search', query: 'ios', scope: 'global' });
    expect(searchOptions(store.state)).toEqual(before);
    // A reload must retain the same scope, too.
    createNextNav(store);
    expect(searchOptions(store.state)).toEqual(before);
  });

  it('renders server totals and grammar chips without narrowing returned rows locally', () => {
    const store = makeStore();
    store.nextGo({ page: 'search', query: 'is:failed router' });
    Object.assign(store.state.search, { searched: 'is:failed router', total: 301, more: true, tokens: [{ field: 'is', value: 'failed' }], project: 'not-on-row', hits: [{ itemId: 'one', row: { id: 'one', facts: {} } }] });
    const tree = nodes(SearchPage({ store }));
    expect(tree.some((n) => n.props?.['aria-label'] === 'Search fields')).toBe(true);
    expect(tree.find((n) => n.props?.role === 'status').props.children.join('')).toContain('301+ open results');
    expect(tree.filter((n) => n.props?.hit)).toHaveLength(1);
  });

  it('renders beyond the switcher limit and sends archived hits to the transcript action', () => {
    const store = makeStore();
    store.nextGo({ page: 'search', query: 'router' });
    store.state.search.searched = 'router';
    store.state.search.hits = Array.from({ length: 12 }, (_, i) => ({ itemId: `hit-${i}`, matches: [{ how: 'keyword', snippet: 'A \u0002router\u0003 match' }], row: { id: `hit-${i}`, source: 'discord', agentId: 'sierra', agentName: 'Sierra', place: `Router ${i}`, disposition: 'active', facts: {}, archived: i === 11 } }));
    const rows = nodes(SearchPage({ store })).filter((n) => typeof n.type === 'function' && n.props.hit);
    expect(rows).toHaveLength(12);
    const live = rows[0].type(rows[0].props);
    live.props.onClick();
    expect(store.state.presentation.itemId).toBe('hit-0');
    store.nextBack();
    const archived = rows[11].type(rows[11].props);
    archived.props.onClick();
    expect(store.openHit).toHaveBeenCalledWith(store.state.search.hits[11]);
    expect(store.threadOpen()).toBe(false);
    expect(nodes(archived).some((n) => n.type === 'mark' && n.props.children === 'router')).toBe(true);
  });
});

describe('open conversations by default', () => {
  it('the Search page offers done and archived ones with how many they add, and back', () => {
    const store = makeStore();
    store.nextGo({ page: 'search', query: 'router' });
    Object.assign(store.state.search, { searched: 'router', total: 2, hits: [{ itemId: 'one', row: { id: 'one', facts: {} } }], wider: { total: 7, more: false } });
    store.setSearchOption = vi.fn();
    const link = () => nodes(SearchPage({ store })).find((n) => n.type === 'button' && /done and archived|Only open/.test(String(n.props.children)));
    expect(nodes(SearchPage({ store })).find((n) => n.props?.role === 'status').props.children.join('')).toContain('2 open results');
    expect(link().props.children).toBe('Also search done and archived (7)');
    link().props.onClick();
    expect(store.setSearchOption).toHaveBeenCalledWith({ wide: true });
    Object.assign(store.state.search, { wide: true, wider: null, total: 9 });
    expect(link().props.children).toBe('Only open conversations');
    // Nothing more to add: no link.
    Object.assign(store.state.search, { wide: false, wider: { total: 0, more: false } });
    expect(link()).toBeUndefined();
  });

  it('searchScope says N+ for a lower bound, and leaves a view that picks statuses alone', () => {
    expect(searchScope({ search: { ...blankSearch(), wider: { total: 300, more: true } } })).toEqual({ open: true, link: { label: 'Also search done and archived (300+)', wide: true } });
    expect(searchScope({ search: { ...blankSearch(), wide: true, wider: null } })).toEqual({ open: false, link: { label: 'Only open conversations', wide: false } });
    // History owns the disposition filter: widened or not, no open-only wording and no link (Codex review on #865).
    for (const wide of [false, true]) expect(searchScope({ search: { ...blankSearch(), tab: 'done', wide } })).toEqual({ open: false, link: null });
  });
});
