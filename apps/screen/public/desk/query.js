// One membership contract for saved tabs, local narrowing and server views. Presentation stays with the caller.
import { busyOf, inReview, liveState, projectOf, stageOf, typeOf } from './list-model.js';
import { isFresh } from './util.js';
import { agentId, itemRepo, kindOf, personaId, reachesOwner } from './query-identity.js';
export { agentId, itemRepo, kindOf, personaId, reachesOwner } from './query-identity.js';

/** @typedef {{in?: string[], not?: string[], unset?: boolean}} FacetFilter */
/** @typedef {{scope: {kind: 'global'} | {kind: 'space', id: string, descendants?: boolean}, audience: 'owner'|'all', where: Object<string, FacetFilter>, text?: string}} DeskQuery */
/** @typedef {{projects?: object[], now?: number, filters?: object}} QueryContext */

/**
 * Search's default: open conversations only (running, waiting, needs you, or idle but open), never done or
 * archived ones (archived snapshots can't answer disposition, so any disposition filter leaves them out).
 * Null when the query already says which dispositions it wants: a saved view of done threads stays as it is.
 */
export const OPEN_DISPOSITIONS = Object.freeze(['active', 'snoozed', 'parked']);
export function openOnly(query) {
  if (query.where?.disposition) return null;
  return { ...query, where: { ...query.where, disposition: { in: [...OPEN_DISPOSITIONS] } } };
}

// Marked done with a brief, question or approval still open, a row stays in Needs you (status.layer; Codex review on #928).
export const dispositionOf = (item) => item.disposition === 'done' && item.status?.layer === 'needs' ? 'active'
  : ['active', 'snoozed', 'parked'].includes(item.disposition) ? item.disposition : 'done';
export const spaceOf = (item, ctx = {}) => {
  const project = projectOf(item, ctx.projects || []);
  if (project) return `project:${project.id}`;
  if (['loom'].includes(item.source) && !item.facts?.agentSpace?.id) return null;
  const agent = agentId(item);
  return agent ? `agent:${agent}` : null;
};

/**
 * Where a thread lives, filed as the sidebar files it: its project and that project's parents (so a parent's pick
 * takes in its children), else its named agent, else "loose" and its repo. Loom and T3 are tools a thread runs on,
 * not agents: a coding thread outside a project is loose.
 */
export function whereOf(item, ctx = {}) {
  const projects = ctx.projects || [];
  const project = projectOf(item, projects);
  if (project) {
    const out = [`project:${project.id}`];
    for (let parent = project.parent; parent && !out.includes(parent);) {
      out.push(parent);
      parent = parent.startsWith('project:') ? projects.find((p) => `project:${p.id}` === parent)?.parent : null;
    }
    return out;
  }
  const agent = ['loom', 't3'].includes(item.source) && !item.facts?.agentSpace?.id ? null : agentId(item);
  if (agent) return [`agent:${agent}`];
  const repo = itemRepo(item) || (item.source === 't3' ? item.area?.trim() : null);
  return repo ? ['loose', `repo:${repo.toLowerCase()}`] : ['loose'];
}

/** Advanced facts stay pure: no source reads or status derivation here. */
export function waitOf(item) {
  const wait = item.watching;
  if (!wait) return null;
  if (wait.basis === 'job' || item.facts?.job) return 'job';
  if (wait.basis === 'background' || item.facts?.background === 'monitoring') return 'monitor';
  if (inReview(item)) return 'review';
  if (wait.waitingOn) return wait.waitingOn.kind === 'agent' ? 'agent' : 'person';
  if (wait.basis === 'summary') return 'check-back';
  return null;
}
export const overdueOf = (item) => String(!!item.watching?.overdue);
export function jobHealthOf(item, ctx = {}) {
  if (kindOf(item) !== 'job') return null;
  if (liveState(item, ctx.now) === 'failed') return 'failing';
  if (item.facts?.schedule?.paused) return 'paused';
  if (busyOf(item)) return 'running';
  return item.disposition === 'done' ? null : 'on-schedule';
}
export const sourceOf = (item) => item.source || null;
export const accountOf = (item) => item.source === 'loom' ? item.facts?.account || null : null;
/** Calendar buckets in the window/server timezone, relative to the supplied clock. */
export function ageOf(item, ctx = {}) {
  const at = item.lastActivityAt;
  if (!Number.isFinite(at) || at <= 0) return null;
  const now = ctx.now ?? Date.now();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (at >= start.getTime()) return 'today';
  const days = (now - at) / 86400000;
  return days < 7 ? 'week' : days < 30 ? 'month' : 'older';
}

// Live can have several memberships: Working includes busy, and review narrows Watching.
export const facets = {
  disposition: dispositionOf,
  wait: waitOf, overdue: overdueOf, health: jobHealthOf,
  source: sourceOf, account: accountOf, age: ageOf,
  muted: (item, ctx = {}) => String(ctx.filters ? hideMatches(item, ctx.filters).length > 0 : !!item.filteredBy?.length),
  live: (item, ctx = {}) => liveState(item, ctx.now),
  busy: (item) => busyOf(item),
  unread: (item) => String(isFresh(item)),
  kind: kindOf,
  stage: stageOf,
  type: typeOf,
  project: (item, ctx = {}) => projectOf(item, ctx.projects || [])?.id || null,
  workspace: itemRepo,
  repo: itemRepo,
  agent: agentId,
  pinned: (item) => String(!!item.facts?.pinned),
  parent: (item) => item.facts?.parentItemId || null,
  space: spaceOf,
  where: whereOf,
};

const normalize = (facet, value) => facet === 'agent' ? personaId(value) : facet === 'repo' || facet === 'workspace' || (facet === 'where' && String(value).startsWith('repo:')) ? String(value).toLowerCase() : value;
const valuesOf = (item, facet, ctx) => {
  const value = facets[facet]?.(item, ctx);
  return (Array.isArray(value) ? value : value == null ? [] : [value]).map((v) => normalize(facet, v));
};

function inScope(item, scope, ctx) {
  if (!scope || scope.kind === 'global') return true;
  let key = spaceOf(item, ctx);
  const seen = new Set();
  while (key && !seen.has(key)) {
    if (key === scope.id) return true;
    if (!scope.descendants) break;
    seen.add(key);
    key = key.startsWith('project:') ? ctx.projects?.find((p) => `project:${p.id}` === key)?.parent : null;
  }
  return false;
}

/** @param {object} item @param {DeskQuery} query @param {QueryContext} ctx */
export function matches(item, query, ctx = {}) {
  if (!inScope(item, query.scope, ctx) || (query.audience === 'owner' && !reachesOwner(item))) return false;
  for (const [facet, filter] of Object.entries(query.where || {})) {
    if (!facets[facet]) return false;
    const values = valuesOf(item, facet, ctx);
    const included = filter.in?.map((v) => normalize(facet, v)) || [];
    const excluded = filter.not?.map((v) => normalize(facet, v)) || [];
    if (values.some((v) => excluded.includes(v))) return false;
    if (filter.unset === false && !values.length) return false;
    if ((included.length || filter.unset === true) && !values.some((v) => included.includes(v)) && !(filter.unset === true && !values.length)) return false;
  }
  if (query.text?.trim()) {
    const text = [item.place, item.facts?.name, item.summary?.title, item.summary?.gist, item.agentName].filter(Boolean).join(' ').toLowerCase();
    if (!text.includes(query.text.trim().toLowerCase())) return false;
  }
  return true;
}

export const countFor = (items, query, ctx = {}) => items.reduce((n, item) => n + Number(matches(item, query, ctx)), 0);

/** Counts under every other facet; null is the unset bucket. */
export function facetCounts(items, query, facet, ctx = {}) {
  const where = { ...query.where };
  delete where[facet];
  const conditioned = { ...query, where };
  const counts = new Map();
  const keys = new Map();
  for (const item of items) {
    if (!matches(item, conditioned, ctx)) continue;
    const value = facets[facet]?.(item, ctx);
    const values = Array.isArray(value) ? value.length ? value : [null] : [value ?? null];
    for (const v of new Set(values)) {
      const normalized = v == null ? null : normalize(facet, v);
      if (!keys.has(normalized)) keys.set(normalized, v);
      const key = keys.get(normalized);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

/** Runtime view only: keep saved stage settings intact so enabling labels restores them. */
export function viewForFlags(view, flags, statusGroup = 'live') {
  if (flags?.stageLabels) return view;
  const { stage, ...shown } = view;
  if (view.where) {
    shown.where = { ...view.where };
    delete shown.where.stage;
  }
  if (view.group === 'stage') shown.group = statusGroup;
  return shown;
}

/** Pure adapter for existing saved JSON. Retired presentation fields are deliberately ignored. */
export function viewToQuery(view, { audience = 'all', ignoreProjects = false } = {}) {
  const where = {};
  const legacy = { active: ['active'], open: ['active', 'snoozed', 'parked'], snoozed: ['snoozed'], parked: ['parked'], history: ['done'] };
  for (const [key, facet] of [['status', 'disposition'], ['live', 'live'], ['stage', 'stage'], ['type', 'type'], ['workspace', 'workspace'], ['agent', 'agent'], ['busy', 'busy'], ['unread', 'unread'], ['kind', 'kind'], ['pinned', 'pinned']]) {
    const picks = view[key] || (key === 'workspace' ? view.project : key === 'status' ? legacy[view.show] : null) || [];
    if (picks.length) where[facet] = { in: picks.filter((v) => !(['stage', 'type', 'busy'].includes(facet) && v === 'none')), ...(['stage', 'type', 'busy'].includes(facet) && picks.includes('none') ? { unset: true } : {}) };
  }
  if (!ignoreProjects) {
    if (view.inProject === 'none') where.project = view.projects?.length ? { in: [...view.projects], not: [...view.projects] } : { unset: true };
    else if (view.projects?.length) where.project = { in: [...view.projects] };
    else if (view.inProject === 'some') where.project = { unset: false };
  }
  Object.assign(where, view.where || {});
  if (ignoreProjects) delete where.project;
  return { scope: { kind: 'global' }, audience, where };
}

/** Local picks use an impossible id as their None option. */
export function picksToQuery(picks = {}, none = '\u0000none') {
  const where = {};
  for (const [facet, values] of Object.entries(picks)) if (values?.length) where[facet] = { in: values.filter((v) => v !== none), ...(values.includes(none) ? { unset: true } : {}) };
  return { scope: { kind: 'global' }, audience: 'all', where };
}

export function hideMatches(item, filters) {
  const out = [];
  for (const [facet, key] of [['agent', 'hideAgents'], ['repo', 'hideRepos'], ['type', 'hideTypes']]) {
    for (const value of filters[key] || []) {
      if (matches(item, { scope: { kind: 'global' }, audience: 'all', where: { [facet]: { in: [value] } } })) {
        out.push({ facet, value });
        break;
      }
    }
  }
  return out;
}

/** The legacy hide menu's inventory. Counts use the same accessors as hide matching. */
export function hideFacets(items, filters = {}) {
  const query = { scope: { kind: 'global' }, audience: 'all', where: {} };
  const agents = new Map();
  const repos = new Map();
  const types = new Map();
  const agentCounts = facetCounts(items, query, 'agent');
  const repoCounts = facetCounts(items, query, 'repo');
  const typeCounts = facetCounts(items, query, 'type');
  for (const item of items) {
    const id = agentId(item);
    if (id) {
      const own = item.facts?.agentSpace;
      const previous = agents.get(id);
      const name = own?.name || (personaId(item.agentId) === String(item.agentId).toLowerCase() ? item.agentName : previous?.name) || previous?.name || item.agentName || id;
      agents.set(id, { id, name, count: agentCounts.get(id) || 0 });
    }
    const repo = itemRepo(item);
    if (repo) {
      const key = repo.toLowerCase();
      const entry = repos.get(key) || { name: repo, count: 0 };
      repos.set(key, { ...entry, count: [...repoCounts].find(([name]) => name?.toLowerCase() === key)?.[1] || 0 });
    }
    const type = facets.type(item);
    if (type) types.set(type, { name: type, count: typeCounts.get(type) || 0 });
  }
  for (const id of filters.hideAgents || []) if (!agents.has(id)) agents.set(id, { id, name: id, count: 0 });
  for (const name of filters.hideRepos || []) if (!repos.has(name.toLowerCase())) repos.set(name.toLowerCase(), { name, count: 0 });
  for (const name of filters.hideTypes || []) if (!types.has(name)) types.set(name, { name, count: 0 });
  const sort = (a, b) => b.count - a.count || a.name.localeCompare(b.name);
  return { agents: [...agents.values()].sort(sort), repos: [...repos.values()].sort(sort), types: [...types.values()].sort(sort) };
}

/** The places above a Where value: a project's parents, "loose" above a repo. */
function placesAbove(value, ctx = {}) {
  if (value.startsWith('repo:')) return ['loose'];
  const out = [];
  for (let at = ctx.projects?.find((p) => `project:${p.id}` === value)?.parent; at && !out.includes(at);) {
    out.push(at);
    at = at.startsWith('project:') ? ctx.projects.find((p) => `project:${p.id}` === at)?.parent : null;
  }
  return out;
}

/**
 * Intersect local picks with a tab, retaining exclusions and unset semantics. Where is a chain (a thread is in its
 * project and every place above it), so a pick and a tab's value on one chain intersect to the narrower one.
 */
export function intersectPicks(query, picks, ctx = {}) {
  const where = structuredClone(query.where);
  for (const [facet, pick] of Object.entries(picksToQuery(picks).where)) {
    const base = where[facet];
    if (!base) { where[facet] = pick; continue; }
    const norm = (v) => normalize(facet, v);
    const chain = (v) => facet === 'where' ? [norm(v), ...placesAbove(norm(v), ctx)] : [norm(v)];
    const narrower = facet === 'where' && !base.not?.length ? (base.in || []).filter((b) => pick.in.some((p) => chain(b).includes(norm(p)) && norm(b) !== norm(p))) : [];
    const included = [...new Set([...pick.in.filter((v) => !chain(v).some((c) => base.not?.map(norm).includes(c)) &&
      (!(base.in?.length || base.unset === true) || chain(v).some((c) => base.in?.map(norm).includes(c)))), ...narrower])];
    const unset = pick.unset === true && base.unset !== false && (!base.in?.length || base.unset === true);
    if (included.length || unset) where[facet] = { in: included, unset };
    else {
      // A contradiction must stay empty after JSON round trips, never become an absent filter.
      const value = pick.in[0] || base.in?.[0] || ({ busy: 'working', stage: 'none', type: 'none' }[facet] || 'unmatched');
      where[facet] = { in: [value], not: [value], unset: false };
    }
  }
  return { ...query, where };
}
