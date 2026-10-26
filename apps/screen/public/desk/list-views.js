// The List view's tabs are views the owner defines (Settings → Views), like a Notion database's views:
// which statuses it holds (in rotation, snoozed, parked, done), filters on facts the desk knows for sure (live state from the
// sources, the owner's own type and projects, repository, agent), whether projects fold into
// one row each, how it groups, and how it sorts. The
// defaults are the tabs the List had before, so nothing changes until the owner edits them.
// Kept free of the DOM so it can be tested.

import { matches, normalizeRetiredView, viewToQuery, dispositionOf } from './query.js';
export { viewToQuery } from './query.js';
import { PROJECT_STATES, knownGrouping, sectionsOf } from './list-model.js';

/** Where an item sits in the owner's attention: in rotation, snoozed, parked, or done. Independent of live state. */
export const STATUSES = [
  ['active', 'Active'],
  ['snoozed', 'Snoozed'],
  ['parked', 'Parked'],
  ['done', 'Done'],
];
/** Views saved before Status was a filter said which one list they showed (`show`). */
const LEGACY_SHOW = { active: ['active'], open: ['active', 'snoozed', 'parked'], snoozed: ['snoozed'], parked: ['parked'], history: ['done'] };
/** Live states as a view filters them. A message nobody picked up counts as Failed (see liveState). */
export const LIVE = [['failed', 'Failed'], ['stuck', 'Stuck'], ['needs', 'Needs you'], ['finished', 'Finished'], ['working', 'Working'], ['waiting', 'Waiting'], ['idle', 'Idle'], ['unknown', 'Unknown']];
export const VIEW_GROUPS = [
  ['project', 'Project'],
  ['workspace', 'Workspace'],
  ['live', 'Live state'],
  ['none', 'None'],
];
/** Whether a view holds conversations in a project, in none, or either. */
export const IN_PROJECT = [
  ['any', 'Either'],
  ['some', 'In a project'],
  ['none', 'Not in one'],
];
export const SORTS = [
  ['asks', 'Requests first'],
  ['recent', 'Newest first'],
  // The thread left longest first: the tab's own Oldest first, whatever this device picks.
  ['oldest', 'Oldest first'],
  // Works in any view: what is not away counts as back now, an event-triggered snooze after every
  // timed one, parked last (list-model.js, wakeOrder).
  ['wake', 'Wakes soonest'],
];
/** The type filter's "nothing set" choice. */
export const UNSET = 'none';

// Projects fold into one row each outside History. The Inbox lists threads directly.
export const DEFAULT_VIEWS = [
  { id: 'needs', name: 'Needs you', status: ['active'], live: ['needs', 'failed', 'stuck'], group: 'live', sort: 'asks', fold: false, rev: 2 },
  { id: 'active', name: 'Active', status: ['active'], group: 'live', sort: 'recent', fold: false, rev: 2 },
  { id: 'later', name: 'Later', status: ['snoozed', 'parked'], group: 'live', sort: 'wake', fold: false, rev: 2 },
  { id: 'done', name: 'Done', status: ['done'], group: 'none', sort: 'recent', fold: false, rev: 2 },
];

export const MAX_VIEWS = 20;
const keys = (pairs) => pairs.map(([key]) => key);
const list = (value, allowed) => (Array.isArray(value) ? [...new Set(value.filter((v) => typeof v === 'string' && (!allowed || allowed.includes(v))))] : []);

/**
 * A filter as saved: the values this page knows. If it knows none of them (a value added by a newer desk, e.g. a
 * page loaded before a deploy), they stay as they are and match nothing: a filter this page can't read must
 * narrow the view, never drop away and show everything. The retired `quiet` is just dropped.
 */
function narrow(value, allowed) {
  const known = list(value, allowed);
  if (known.length || !allowed) return known;
  return list(value).filter((v) => v !== 'quiet');
}

/** A view as saved, completed and cleaned: unknown keys dropped, defaults filled in. Null when unusable. */
export function normalizeView(raw, typeKeys = []) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(raw.id) ? raw.id : null;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 40) : '';
  if (!id || !name) return null;
  const view = {
    id,
    name,
    group: keys(VIEW_GROUPS).includes(raw.group) ? raw.group : 'live',
    sort: keys(SORTS).includes(raw.sort) ? raw.sort : 'recent',
    // Saved under the four tabs: a list without it predates them (viewsOf).
    rev: 2,
  };
  // No status at all is every status; a view from before reads its old `show`.
  const status = Array.isArray(raw.status) ? list(raw.status, keys(STATUSES)) : raw.show ? LEGACY_SHOW[raw.show] || ['active'] : [];
  const live = narrow(raw.live, keys(LIVE));
  const type = narrow(raw.type, typeKeys.length ? [...typeKeys, UNSET] : null);
  // A view from before projects named repositorys `project`.
  const workspace = list(raw.workspace ?? raw.project).map((p) => p.slice(0, 60));
  const projects = list(raw.projects).map((p) => p.slice(0, 40));
  const agent = list(raw.agent).map((a) => a.slice(0, 60));
  if (raw.emptyShelf === false) view.emptyShelf = false;
  if (raw.where && typeof raw.where === 'object' && !Array.isArray(raw.where)) view.where = structuredClone(normalizeRetiredView(raw).where);
  for (const key of ['busy', 'unread', 'kind', 'pinned']) {
    const values = list(raw[key]);
    if (values.length) view[key] = values;
  }
  if (status.length) view.status = status;
  if (live.length) view.live = live;
  if (type.length) view.type = type;
  if (workspace.length) view.workspace = workspace;
  if (projects.length) view.projects = projects;
  if (raw.inProject === 'some' || raw.inProject === 'none') view.inProject = raw.inProject;
  if (agent.length) view.agent = agent;
  // Grouped by workspace, Tango agents share one section instead of one each.
  if (view.group === 'workspace' && raw.agentsTogether === true) view.agentsTogether = true;
  // Folded unless it says otherwise, or holds only done items.
  view.fold = typeof raw.fold === 'boolean' ? raw.fold : !(status.length && status.every((s) => s === 'done'));
  // Folded, it can always show projects in some states, whether or not anything in them is in the view.
  const showProjects = view.fold ? list(raw.showProjects, keys(PROJECT_STATES)) : [];
  if (showProjects.length) view.showProjects = showProjects;
  return view;
}

/**
 * The owner's views, or the built-in ones when there are none (or none usable). Ids stay unique.
 * The built-in views group the way this device grouped the List before views (`listGroup`), so
 * nothing moves on upgrade (Codex review on #502).
 */
export function viewsOf(saved, deviceGroup) {
  const views = [];
  const seen = new Set();
  const rows = Array.isArray(saved) ? saved.slice(0, MAX_VIEWS) : [];
  // A list saved under the four tabs is the owner's, built-in tabs edited, reordered or deleted included
  // (Codex review on #928). One saved before them keeps only its own views, after the four.
  const current = rows.some((raw) => raw?.rev === 2);
  const retired = new Set(['needs', 'active', 'later', 'done', 'ready', 'todos', 'working', 'watching', 'snoozed', 'parked', 'history']);
  for (const raw of rows) {
    if (!current && retired.has(raw?.id)) continue;
    const view = normalizeView(raw);
    if (!view || seen.has(view.id)) continue;
    // A built-in Needs you saved before Stuck counted for the owner gains it; one the owner narrowed stays theirs.
    if (view.id === 'needs' && view.live?.length === 2 && view.live.includes('needs') && view.live.includes('failed')) view.live = [...view.live, 'stuck'];
    seen.add(view.id);
    views.push(view);
  }
  if (current && views.length) return views;
  return [...DEFAULT_VIEWS, ...views];
}

/** The view this device is on: its saved id, or the first view (an id from before views opens the same tab). */
export function currentView(views, id) {
  return views.find((view) => view.id === id) || views[0];
}

/** A fresh id for a new view, unique among the ones there are. */
export function newViewId(views, name = 'view') {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'view';
  let id = base;
  for (let n = 2; views.some((view) => view.id === id); n += 1) id = `${base}-${n}`;
  return id;
}

/**
 * The items a view shows, from the lists the desk loads, with its filters applied. Inside a project
 * (`within`), the view's own project filters are set aside: the project is the filter.
 */
export function viewItems(lists, view, projects = [], within = null) {
  const query = viewToQuery(view, { ignoreProjects: !!within });
  if (within) query.scope = { kind: 'space', id: `project:${within}` };
  return viewLists(view)
    .flatMap((key) => lists[key]?.items || [])
    .filter((item) => (view.id !== 'needs' || item.status?.countsForOwner) && matches(item, query, { projects }));
}

/** Whether a view's filters keep an item (a List row, or a search result's row). */
export function matchesView(item, view, projects = [], { ignoreProjects = false } = {}) {
  return matches(item, viewToQuery(view, { ignoreProjects }), { projects });
}

/** An item's status: the snoozed list holds parked items too, and the history list holds done ones. */
export function statusOf(item) {
  return dispositionOf(item);
}

/** Which of the desk's loaded lists (active, snoozed, history) a view draws from. */
export function viewLists(view) {
  const wants = (status) => !view.status?.length || view.status.includes(status);
  return [wants('active') && 'active', (wants('snoozed') || wants('parked')) && 'snoozed', wants('done') && 'history'].filter(Boolean);
}

/** The view's sections, from the items it shows. `order` is this device's Newest first / Oldest first. */
export function viewSections(items, view, labelOrder, projects = [], order = 'newest') {
  // A done-only tab keeps its by-when-done order; the tab's own Oldest first still turns it around.
  const sort = viewSort(view);
  return sectionsOf(items, view.group, sort === 'oldest' ? 'recent' : sort, labelOrder, { agentsTogether: view.group === 'workspace' && !!view.agentsTogether, projects, oldest: order === 'oldest' || view.sort === 'oldest' });
}

/** How a view's rows sort: a view of only done items by when each was done, else the view's own choice. */
export function viewSort(view) {
  return view.status?.length === 1 && view.status[0] === 'done' ? 'history' : view.sort;
}

/** One line on what a view holds, for the Views list in Settings. */
export function describeView(view, names = {}) {
  view = normalizeRetiredView(view);
  const label = (pairs, key) => pairs.find(([k]) => k === key)?.[1] ?? names[key] ?? key;
  if (view.where) {
    const query = viewToQuery(view);
    const labels = { disposition: 'Status', live: 'Live state', where: 'Where', workspace: 'Repo', project: 'Project', busy: 'Busy', unread: 'Unread', pinned: 'Pinned', type: 'Type', agent: 'Agent', kind: 'Kind', repo: 'Repo', space: 'Space', wait: 'Waiting on', age: 'Last active', overdue: 'Overdue', source: 'Source', account: 'Account' };
    const parts = Object.entries(query.where).flatMap(([facet, filter]) => {
      const valueName = (v) => names[`${facet}:${v}`] || names[v] || [...STATUSES, ...LIVE].find(([key]) => key === v)?.[1] || ({ true: facet === 'unread' ? 'Unread' : 'Pinned', false: facet === 'unread' ? 'Read' : 'Unpinned', background: 'Background' }[v]) || v;
      const title = labels[facet] || facet;
      // Show only reads as the toggle's own word: "Unread", not "Unread: Unread".
      if (['unread', 'pinned', 'overdue'].includes(facet) && filter.in?.length === 1 && filter.in[0] === 'true' && !filter.not?.length && filter.unset === undefined) return [{ unread: 'Unread', pinned: 'Pinned', overdue: 'Overdue' }[facet]];
      return [filter.in?.length ? `${title}: ${filter.in.map(valueName).join(' or ')}` : null,
        filter.not?.length ? `Exclude ${title.toLowerCase()}: ${filter.not.map(valueName).join(' or ')}` : null,
        filter.unset === true ? (facet === 'busy' ? 'Include idle' : `Include unset ${title.toLowerCase()}`) : filter.unset === false ? (facet === 'busy' ? 'Exclude idle' : `Exclude unset ${title.toLowerCase()}`) : null].filter(Boolean);
    });
    return [...parts, `by ${label(VIEW_GROUPS, view.group).toLowerCase()}`].join(' · ');
  }
  const parts = [view.status?.length ? view.status.map((k) => label(STATUSES, k)).join(' or ') : 'Any status'];
  if (view.live?.length) parts.push(view.live.map((k) => label(LIVE, k)).join(' or '));
  if (view.type?.length) parts.push(view.type.map((k) => (k === UNSET ? 'no type' : names[k] || k)).join(' or '));
  if (view.inProject === 'some') parts.push(view.projects?.length ? `in ${view.projects.map((id) => names[`project:${id}`] || id).join(' or ')}` : 'in a project');
  if (view.inProject === 'none') parts.push('not in a project');
  if (view.workspace?.length) parts.push(view.workspace.join(' or '));
  if (view.agent?.length) parts.push(view.agent.join(' or '));
  if (view.fold) parts.push(view.showProjects?.length ? `projects folded, ${view.showProjects.map((k) => label(PROJECT_STATES, k).toLowerCase()).join(' and ')} always shown` : 'projects folded');
  parts.push(`by ${label(VIEW_GROUPS, view.group).toLowerCase()}${view.group === 'workspace' && view.agentsTogether ? ', agents together' : ''}`);
  return parts.join(' · ');
}

/**
 * What an empty view shows in place of rows: on a view of what needs the owner (in rotation, no live
 * filter or only Needs you / Ready / Failed), today's finished work under the view's other filters, so
 * an empty project view shows that project's wins. Null on every other view (Working, Watching,
 * Snoozed, History…): those keep their plain line. `count` is everything done today; `items` the
 * newest few.
 */
export function trophyShelf(lists, view, now = Date.now(), max = 3) {
  if (view.emptyShelf === false) return null;
  const wantsYou = (view.status || []).includes('active') && (view.live || []).every((k) => ['needs', 'ready', 'failed', 'stuck'].includes(k));
  if (!wantsYou) return null;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const doneAt = (item) => item.doneAt || item.lastActivityAt || 0;
  const done = (lists.history?.items || [])
    .filter((item) => doneAt(item) >= today.getTime() && matchesView(item, { ...view, status: ['done'], live: [] }))
    .sort((a, b) => doneAt(b) - doneAt(a));
  return { count: done.length, items: done.slice(0, max), doneAt };
}
