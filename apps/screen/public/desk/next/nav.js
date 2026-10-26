// The next layout's navigation: the place this device is on (Inbox view, a project, an agent), kept
// per device, and the thread over it, which is the shared presentation (a conversation open on every screen).

import { storageGet, storageSet } from '../util.js';
import { HOME_ROUTE, agentsOf, findItem, ownerCrumb, routeKey } from './model.js';
import { createSelect } from './select.js';

const PAGES = new Set(['inbox', 'catchup', 'projects', 'project', 'agents', 'agent', 'search', 'capacity', 'system', 'spacesettings']);
/**
 * Capacity is the System page's Capacity tab (docs/specs/system-visibility.md): an old saved route, the switcher's
 * Capacity and voice's list_place capacity land there. A job's page is the System page with its id.
 */
export function placeRoute(route) {
  if (route?.page === 'capacity') return { page: 'system', view: 'capacity' };
  return route;
}
/** A route saved on this device (JSON in localStorage). */
function savedRoute() {
  try {
    return JSON.parse(storageGet('nextRoute', 'null'));
  } catch {
    return null;
  }
}
/** The parents open in the sidebar on this device (space keys: `project:<id>`, `agent:<id>`). */
function savedOpen() {
  try {
    const list = JSON.parse(storageGet('nextSideOpen', '[]'));
    return Array.isArray(list) ? list.filter((k) => typeof k === 'string') : [];
  } catch {
    return [];
  }
}
function savedFilter() {
  try {
    return Object.fromEntries(Object.entries(JSON.parse(storageGet('nextFilter', '{}')) || {}).filter(([key]) => key !== 'stage'));
  } catch {
    return {};
  }
}
/** Newest first (the default) or Oldest first, for the Inbox and Catch me up on this device. */
function savedOrder() {
  return storageGet('nextOrder', null) === 'oldest' ? 'oldest' : 'newest';
}
const valid = (route) => !!route && PAGES.has(route.page) && (!['project', 'agent', 'spacesettings'].includes(route.page) || !!route.id);

/** The layout choice is gone with the classic layout: forget a saved one and drop an old ?ui= from the address. */
export function dropLayoutChoice() {
  storageSet('ui', null);
  storageSet('nextTabBar', null); // the tab bar is no longer optional
  const url = new URL(location.href);
  if (!url.searchParams.has('ui')) return;
  url.searchParams.delete('ui');
  history.replaceState(history.state, '', url.toString());
}

/** Adds the next layout's moves to the store. */
export function createNextNav(store) {
  const saved = placeRoute(savedRoute());
  const start = valid(saved) ? saved : HOME_ROUTE;
  if (start.page === 'search') {
    const scope = start.scope || 'global';
    const [kind, id] = scope.startsWith('space:') ? scope.slice(6).split(/:(.*)/s) : [];
    const name = (kind === 'project' ? store.state.projects : agentsOf(store.state.lists, store.state.now))?.find((p) => p.id === id)?.name || id;
    store.setSearchOption({ scope, space: id ? { id: `${kind}:${id}`, name } : null });
    store.setSearchQuery(start.query || '');
  }
  store.set({ nextRoute: start, nextSidebar: storageGet('nextSidebar', null), nextSwitcher: false, nextFilter: savedFilter(), nextOrder: savedOrder(), nextSideOpen: savedOpen() });
  // What the voice operator reads back (listReport) starts where the restored place is (Codex review on #618).
  store.set({ listProject: start.page === 'project' ? start.id : null, ...(start.page === 'inbox' && start.view ? { listTab: start.view } : {}) });

  const threadOpen = () => store.state.presentation.view !== 'active' && !!store.state.presentation.itemId;
  // A scene or prototype up on this window's stage (stage.js), one crumb past its thread when it has one. A control
  // window stays on the thread while one is up elsewhere (role.js): there Back goes on from the thread.
  const stageUp = () => store.state.role !== 'control' && (store.state.presentation.view === 'screen' || store.state.presentation.view === 'prototype');

  /**
   * Where this window is: its place, and the thread or stage over it. Forward (⌘]) puts back what Back (⌘[, Esc,
   * the crumb, voice) left. The history lives in this window's memory only, so a detached window keeps its own.
   */
  function here() {
    const p = store.state.presentation;
    const view = stageUp() ? p.view : threadOpen() ? 'conversation' : 'active';
    return { route: store.state.nextRoute, view, itemId: view === 'active' ? null : p.itemId || null, conversationKey: p.conversationKey || null, sceneId: view === 'screen' ? p.sceneId : null, prototypeId: view === 'prototype' ? p.prototypeId : null };
  }
  const hereKey = (h) => [routeKey(h.route), h.view, h.itemId || '', h.sceneId || h.prototypeId || ''].join('|');
  /** Each Back's { from, to }, newest last. A move of the owner's own (not Back or Forward) clears it, as in a browser. */
  let forward = [];
  let stepping = false;
  const moved = () => { if (!stepping) forward = []; };
  // A move from anywhere else (another window, the hub, the stage) clears it too, even one that later comes back
  // to where Back left this window (Codex review on #790): every place the store passes through is checked.
  let seen = null;
  const settle = () => { seen = hereKey(here()); };
  // Leaving a thread or stage for the place under it (Back, Done, Snooze, another window) lands at the top of the
  // place: its list is read top down, and the thread's own scroll (at its latest reply) means nothing there.
  let wasOver = here().view !== 'active';
  store.subscribe?.(() => {
    const now = here();
    const key = hereKey(now);
    if (key !== seen) forward = [];
    seen = key;
    const over = now.view !== 'active';
    if (wasOver && !over) window.scrollTo?.(0, 0);
    wasOver = over;
  });

  /**
   * Go to a place: leaves an open thread (every screen goes back with it), and keeps the place on this device.
   * `keepThread` moves only the place under an open thread (a Search query edited over it).
   */
  function nextGo(route, { keepThread = false } = {}) {
    route = placeRoute(route);
    if (!valid(route)) return;
    moved();
    if (route.page === 'search') {
      const from = store.state.nextRoute;
      const space = ['project', 'agent'].includes(from?.page) ? { id: `${from.page}:${from.id}`, name: (from.page === 'project' ? store.state.projects : agentsOf(store.state.lists, store.state.now))?.find((p) => p.id === from.id)?.name || from.id } : from?.page === 'search' ? store.state.search.space : null;
      const scope = route.scope ?? (from?.page === 'search' ? store.state.search.scope : space ? `space:${space.id}` : 'global');
      if (scope !== store.state.search.scope || space !== store.state.search.space) store.setSearchOption({ scope, space });
      route = { ...route, query: route.query ?? store.state.search.query, ...(scope !== 'global' ? { scope } : {}) };
    }
    const changed = routeKey(route) !== routeKey(store.state.nextRoute);
    // Selecting is for one list: going anywhere else ends it.
    store.set({ nextRoute: route, nextThreadFrom: null, ...(changed ? { nextShowHidden: null, nextSelect: null } : {}) });
    storageSet('nextRoute', JSON.stringify(route));
    if (route.page === 'search' && route.query !== undefined && route.query !== store.state.search.query) store.setSearchQuery(route.query);
    if (route.page === 'inbox' && route.view) store.setListTab(route.view);
    // What the voice operator reads back (listReport) follows the place: the project open, else none.
    store.set({ listProject: route.page === 'project' ? route.id : null });
    if (keepThread && threadOpen()) return;
    if (threadOpen() || stageUp()) store.goBoard();
    if (changed) window.scrollTo?.(0, 0);
  }

  /**
   * The place under the open thread moves (its project changed): the thread stays open, Back goes there.
   * `from` ({ itemId, route }) is where that thread was opened, kept while it stays open.
   */
  function nextFollow(route, from) {
    if (!valid(route) || routeKey(route) === routeKey(store.state.nextRoute)) return;
    const keep = store.state.nextThreadFrom?.itemId === from.itemId ? store.state.nextThreadFrom : from;
    store.set({ nextRoute: route, nextThreadFrom: keep });
    storageSet('nextRoute', JSON.stringify(route));
  }

  /** Open a thread from the place this device is on (the breadcrumb's middle crumb). */
  function nextOpen(itemId) {
    moved();
    store.set({ nextSelect: null });
    store.openItem(itemId);
    window.scrollTo?.(0, 0);
  }

  /**
   * Back: off the stage to its thread (or its place), out of a worker's or job's thread to what it reports to (its
   * breadcrumb's owner crumb), out of a thread to its place, else up from a project or agent to its index.
   * Forward can put back what it left.
   */
  function nextBack() {
    const from = here();
    stepping = true;
    try {
      back();
    } finally {
      stepping = false;
    }
    const to = here();
    if (hereKey(to) !== hereKey(from)) forward = [...forward.slice(-49), { from, to }];
    settle();
  }
  function back() {
    if (stageUp()) return store.state.presentation.itemId ? store.showConversation() : store.goBoard();
    if (threadOpen()) {
      const owner = ownerCrumb(findItem(store.state.lists, store.state.presentation.itemId), store.state.lists);
      // An agent's chat on that agent's own page is the place itself (crumbsOf leaves it out).
      const r = store.state.nextRoute;
      if (owner && !(owner.chatOf && r.page === 'agent' && r.id === owner.chatOf)) return nextOpen(owner.owner);
      return store.goBoard();
    }
    const r = store.state.nextRoute;
    if (r.page === 'project') {
      // Up from a child to the space it is inside (docs/specs/spaces.md, Nesting), else to the index.
      const parent = /^(project|agent):(.+)$/s.exec((store.state.projects || []).find((p) => p.id === r.id)?.parent || '');
      return nextGo(parent ? { page: parent[1], id: parent[2] } : { page: 'projects' });
    }
    if (r.page === 'agent') return nextGo({ page: 'agents' });
    // Up from a job's page to the System tab it was opened from.
    if (r.page === 'system' && r.id) return nextGo({ page: 'system', view: r.view || 'jobs' });
    if (r.page !== 'inbox') return nextGo(HOME_ROUTE);
  }

  /**
   * Forward: re-applies the last Back, while this window is still where that Back left it (else there is nothing
   * to go forward to). Returns whether it moved.
   */
  function nextForward() {
    const last = forward[forward.length - 1];
    if (!last || hereKey(here()) !== hereKey(last.to)) {
      forward = [];
      return false;
    }
    forward = forward.slice(0, -1);
    const { route, view, itemId, conversationKey, sceneId, prototypeId } = last.from;
    stepping = true;
    try {
      if (view === 'active') nextGo(route);
      else {
        nextGo(route, { keepThread: true });
        const owner = itemId ? { itemId, conversationKey } : null;
        if (view === 'screen') store.showScreen(sceneId, owner);
        else if (view === 'prototype') store.showPrototype(prototypeId, owner);
        else nextOpen(itemId);
      }
    } finally {
      stepping = false;
    }
    settle();
    return true;
  }
  const canForward = () => forward.length > 0 && hereKey(here()) === hereKey(forward[forward.length - 1].to);

  /** The sidebar, shown or hidden on this device (null: its default for the window's width). */
  function nextToggleSidebar(open) {
    const value = open ?? !store.state.nextSidebarShown;
    storageSet('nextSidebar', value ? 'open' : 'closed');
    store.set({ nextSidebar: value ? 'open' : 'closed' });
  }

  /** A parent in the sidebar opened or closed (its children shown under it), kept on this device. */
  function nextToggleSpace(key, open) {
    const now = store.state.nextSideOpen || [];
    const value = open ?? !now.includes(key);
    const next = value ? [...new Set([...now, key])] : now.filter((k) => k !== key);
    storageSet('nextSideOpen', next.length ? JSON.stringify(next) : null);
    store.set({ nextSideOpen: next });
  }

  /** The quick switcher (switcher.js). Search everywhere opens it in the next layout: ⌘K, "/", the nav's search. */
  function nextSwitch(open = true) {
    if (open) store.setSearchOption({ space: null, scope: 'global', tab: 'all', project: '', repo: '', agent: '' });
    store.set({ nextSwitcher: !!open, ...(open ? { nextContext: null } : {}) });
  }

  /** The Inbox's own filter on this device: { type: [...], project, agent, repo }. */
  function nextSetFilter(filter) {
    const clean = Object.fromEntries(Object.entries(filter || {}).filter(([key, v]) => key !== 'stage' && v?.length));
    storageSet('nextFilter', Object.keys(clean).length ? JSON.stringify(clean) : '');
    store.set({ nextFilter: clean });
  }

  /** The sort pick on this device: 'newest' or 'oldest'. */
  function nextSetOrder(order) {
    const value = order === 'oldest' ? 'oldest' : 'newest';
    storageSet('nextOrder', value === 'oldest' ? value : null);
    store.set({ nextOrder: value });
  }

  return { ...createSelect(store), stageUp, nextSetFilter, nextSetOrder, nextToggleSpace, nextGo, nextFollow, nextOpen, nextBack, nextForward, canForward, nextToggleSidebar, nextSwitch, threadOpen, openSearch: () => nextSwitch(true), openSearchFrom: () => nextSwitch(true) };
}
