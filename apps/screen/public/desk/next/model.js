export { prChip, prGroups } from './pr-model.js';
// The next layout's model (docs/specs/agent-desk-next.md): what a thread row says, where a thread
// lives, the pages and their breadcrumb. No DOM here, so it runs under the tests.

import { agentId, facets, matches, countFor, facetCounts, picksToQuery, viewForFlags, viewToQuery, intersectPicks, kindOf } from '../query.js';
export { kindOf, reachesOwner } from '../query.js';
import { sectionsOf, sortRows, busyOf, heldLabel, liveState, ownerOrderAt, wantsOwner, projectOf, projectState, watchingLabel, stageOf, typeOf, typeName, stageName, isCoding, repoOf, rowTitle } from '../list-model.js';
import { age, askOf, failureText, inFlightFact, inFlightOf, wakeLabel, waitAge, dayLabel } from '../util.js';
import { draftView } from '../draft-model.js';
import { viewItems, viewsOf, currentView, trophyShelf, viewSections, newViewId } from '../list-views.js';

export { isCoding, repoOf };

/**
 * The thread's own title, always: a Loom thread's title without its "repo · " lead, a Discord
 * thread's name, the owner's rename. Never a summary. An agent's home chat reads "Chat with Sierra".
 */
export function threadTitle(item) {
  if (!item) return '';
  if (item.facts?.name) return item.facts.name;
  if (item.kind === 'chapter') return `Chat with ${item.agentName}`;
  const place = String(item.place || '');
  if (isCoding(item)) {
    const at = place.indexOf(' · ');
    const title = (at >= 0 ? place.slice(at + 3) : place).replace(/^(epic|disc|bug|fix|feat|enh|chore|ops|skill|watch|hold):\s*/i, '').trim();
    return title || 'New thread';
  }
  // A request started by a follow-up rather than its form post has no place of its own: the summary names it.
  return place || item.summary?.title || `Chat with ${item.agentName}`;
}

/** An agent's id for the next layout's Agents: its persona (sierra-ollama is Sierra). Coding threads have none. */
export function agentOf(item) {
  return isCoding(item) && !item.facts?.agentSpace?.id ? null : agentId(item);
}

/** The agent's name as its space says it: an agent space's own name, else the source's agent name. */
export const agentNameOf = (item) => item?.facts?.agentSpace?.name || item?.agentName || '';

/** Where a thread lives, said once: its project, else its named agent, else its repo. */
export function homeOf(item, projects = []) {
  const project = projectOf(item, projects);
  if (project) return { kind: 'project', id: project.id, name: project.name, project };
  const agent = agentOf(item);
  if (agent) return { kind: 'agent', id: agent, name: agentNameOf(item) || agent };
  return repoTile(item);
}

/** A coding thread's repo, with its repository's icon when Loom gave it one. */
function repoTile(item) {
  const repo = repoOf(item);
  if (!repo) return null;
  const p = item.facts?.project;
  return { kind: 'repo', id: repo, name: repo, ...(p?.icon ? { look: { icon: p.icon, color: p.color } } : {}) };
}

/**
 * The row's tile: the project's, else the agent's avatar, else the repo's icon (else a repo glyph).
 * The same on a project's own page: its tile on every row says you're in the right place.
 */
export function tileOf(item, projects = []) {
  return homeOf(item, projects);
}

/** The one colored fact on a row or header: what the thread is doing. */
export const STATUS = {
  needs: { label: 'Needs you', cls: 'move' },
  failed: { label: 'Failed', cls: 'failed' },
  working: { label: 'Working', cls: 'working' },
  waiting: { label: 'Waiting', cls: 'watching' },
  stuck: { label: 'Stuck', cls: 'failed' },
  finished: { label: 'Finished', cls: 'finished' },
  idle: { label: 'Idle', cls: 'idle' },
  unknown: { label: 'Unknown', cls: 'unknown' },
};
/** Words the owner sent that nothing has taken up yet (desk/status.ts "sent"): the agent's move, so in with Working. */
export const isSent = (item) => item?.status?.pill === 'working' && item.status.detail === 'sent';
export function statusOf(item, now = Date.now()) {
  const key = liveState(item, now);
  if (item?.status?.basis === 'source:discussion') return { key, label: item.status.detail, cls: 'working' };
  if (isSent(item)) return { key, label: 'Sent', cls: 'working' };
  return { key, ...(STATUS[key] || STATUS.unknown) };
}

/** A job that isn't failing and has nothing running (a turn or background work): it waits for its next run (the server gives it no move; desk/status.ts). */
/** A job waiting for its next run; not one that failed, is running, or that Loom is holding (it says Waiting). */
export function onSchedule(item, now = Date.now()) {
  // A recorded hold (capacity, budget, maintenance) reads Waiting now; it still isn't on schedule (Codex review on #928).
  return !item.facts?.held && matches(item, { scope: { kind: 'global' }, audience: 'all', where: { kind: { in: ['job'] }, disposition: { not: ['done'] }, live: { not: ['failed', 'unknown'] }, busy: { unset: true } } }, { now });
}

/**
 * A conversation's kind (docs/specs/spaces.md): who it works for. A thread talks with you and completes; a
 * default is its space's standing chat; a job runs again and again; a worker does one job for what it reports to.
 */
export const KINDS = { thread: 'Thread', default: 'Default', job: 'Job', worker: 'Worker' };
/** Any conversation the desk holds, open or done. */
export function findItem(lists, id) {
  if (!id) return null;
  // `everything` holds what a rule hides from `active` (a worker's hidden owner; Codex review on #772).
  for (const key of ['active', 'snoozed', 'everything', 'history']) {
    const hit = (lists?.[key]?.items || []).find((i) => i.id === id);
    if (hit) return hit;
  }
  return null;
}

/** "in 12m", "in 3h", "in 2d": how long until a moment. */
function until(at, now) {
  const ms = Math.max(0, at - now);
  if (ms < 60 * 60_000) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < 24 * 60 * 60_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/** A job's schedule in a few words: "Every 15 min · last 6m ago · next in 9m". */
export function scheduleLine(item, now = Date.now()) {
  const s = item?.facts?.schedule;
  if (!s) return null;
  return [s.every, s.lastRunAt ? `last ${age(s.lastRunAt, now)} ago` : null, s.paused ? 'paused' : s.nextRunAt ? `next in ${until(s.nextRunAt, now)}` : null].filter(Boolean).join(' · ');
}

/**
 * Where a worker or job reports from, as a mini breadcrumb: its space (when the page isn't already it), then the
 * conversation it reports to. A thread or default has none.
 */
export function trailOf(item, lists, home) {
  if (!['worker', 'job'].includes(kindOf(item))) return null;
  const owner = findItem(lists, item.facts?.parentItemId);
  const ownerTitle = owner ? (kindOf(owner) === 'default' && owner.kind === 'chapter' ? owner.agentName : threadTitle(owner)) : null;
  const out = [home?.name, ownerTitle].filter(Boolean);
  // A job of an agent reports to its chat: "Watson › Watson" says it twice.
  return out.filter((label, i) => i === 0 || label !== out[i - 1]);
}

/**
 * What the thread needs from the owner, in a line: the agent's own ask (its closing "Next — you:", a Loom
 * question, a PR waiting to merge) or the failure. Only while it waits on the owner; never a guess.
 */
export function nextAction(item, now = Date.now()) {
  return wantsOwner(item, now) ? item.status?.detail || null : null;

}

/**
 * The summary's short action, only when it speaks for what's blocking now: the summary decided it's the
 * owner's move, or it read the agent's own "Next — you" line after that line came in. A Loom question or a
 * PR decision that arrived since is the source's ask, and wins (Codex review on #584).
 */
function generatedNext(item) {
  const s = item.summary;
  if (!s?.next) return null;
  if (item.nextStepBasis === 'summary') return null;
  if ((item.nextStepBasis === 'source:next-line' || item.nextStepBasis === 'source:ask') && (s.at || 0) >= (item.lastActivityAt || 0)) return s.next;
  return null;
}

/** Words as one plain line: code blocks, link targets, emphasis marks and list or heading leads dropped. */
function plainLine(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*(#{1,6}\s+|[-+]\s+|\d+[.)]\s+|>\s*)/, '').trim())
    .filter((line) => line && !/^\|?[-:| ]+\|?$/.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The latest message, two or three lines of it. The summary is written by a model seconds after new words,
 * so until it covers them the row says the words themselves: the owner's just-sent message ("You: …") while
 * the agent works, then the agent's own reply, then the summary once it lands.
 */
export function previewOf(item) {
  const s = item?.summary || {};
  const f = item?.facts || {};
  const summaryAt = s.at || 0;
  const request = f.lastOwnerRequest;
  if (f.lastAuthor === 'owner' && request?.text && (request.filedAt ?? request.at) > summaryAt) return `You: ${plainLine(request.text)}`;
  const words = f.lastAgentWords;
  if (f.lastAuthor === 'agent' && words?.text && (f.discussing?.length || words.filedAt > summaryAt)) return plainLine(words.text);
  const text = s.paragraph || s.gist || item?.line || '';
  return text ? `Summary: ${String(text).replace(/\s+/g, ' ').trim()}` : '';
}

/**
 * The status detail, where it says something the pill doesn't (owner, 10/21): `why` sits in gray beside the pill
 * (what it waits on, what failed or stalled, what is unknown); `ask` is a Needs you row's question, on its own line.
 * Working, Finished and Idle show none: "Turn running", "1 worker" and a closing "done." only repeated the pill.
 */
export function statusWords(item) {
  const pill = item?.status?.pill;
  const detail = item?.status?.detail || null;
  return {
    why: ['waiting', 'failed', 'stuck', 'unknown'].includes(pill) &&
      !inFlightOf(item).some(entry => entry.url && entry.text === detail) ? detail : null,
    ask: pill === 'needs' ? detail : null,
  };
}

/** The quiet facts after the status pill: away, what it waits on, screens. */
/** Past this a conversation's context shows on its row: the point where Loom starts a fresh session (the spec's soft threshold). */
export const LARGE_CONTEXT = 150_000;
/** The share of the daily budget past which the row says so (the thread starts fresh at its next turn there). */
export const BUDGET_WARN = 0.8;

/** The thread's budget as of today: one read on an earlier day (resetsAt passed) counts nothing. Null: no budget. */
export function budgetToday(item, now = Date.now()) {
  const budget = item?.facts?.budget;
  if (!budget?.limit) return null;
  return budget.resetsAt && now >= budget.resetsAt ? { ...budget, today: 0, raised: 0, limit: budget.base, share: 0 } : budget;
}

/** 312k, 1.4M: token counts as the desk says them. */
export function tokensLabel(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  return `${Math.round(n / 1000)}k`;
}

export function factsOf(item, now = Date.now()) {
  const out = [];
  if (item.disposition === 'snoozed' || item.disposition === 'parked') out.push(wakeLabel(item, now));
  if (item.disposition === 'done') out.push('done');
  if (liveState(item, now) === 'watching') {
    const label = watchingLabel(item);
    if (label !== 'watching') out.push(label);
  }
  // Past its time (desk/next-step.ts Overdue): the agent's late check-back (the desk woke it) or someone slow
  // (Nudge). Said on every row it applies to, busy or not (a job past its deadline too), never as the pill.
  const overdue = item.watching?.overdue;
  if (overdue) out.push(`overdue ${waitAge(overdue.since, now)}`);
  // The ask's lifecycle (desk/asks.ts): a to-do, a date it is past, or that another row carries the same ask.
  const ask = item.askRecord;
  if (ask?.state === 'expired') out.push(`expired ${dayLabel(ask.dueAt, now)}`);
  else if (ask?.kind === 'todo' && ask.state === 'open') out.push('to-do');
  else if (ask?.kind === 'soft' && ask.state === 'open') out.push('optional');
  else if (ask?.state === 'superseded') out.push('asked again in a newer chapter');
  else if (item.facts?.carriedBy) out.push(`carried by ${item.facts.carriedBy.title}`);
  else if (item.facts?.leadAway) out.push(`${item.facts.leadAway.title} is put away`);
  else if (ask?.state === 'duplicate') out.push('same ask as another thread');
  // A brief passed up from another thread (desk/asks.ts carryBriefs): where it came from.
  for (const c of item.facts?.carried || []) if (c.pending?.brief) out.push(c.from.itemId === item.id ? `${c.pending.brief.id} open` : `${c.pending.brief.id} from ${c.from.title}`);
  if (item.facts?.prChecks?.state === 'failing') out.push('CI failing');
  // What it is on behind the scenes (a background task, a wait), so a busy row says what it waits for.
  if (item.disposition !== 'done') {
    const flight = inFlightFact(item);
    // Not when the reason beside the pill already says it word for word (statusWords).
    const said = statusWords(item).why;
    const first = inFlightOf(item)[0]?.text;
    if (flight && !(said && first && said.startsWith(first))) out.push(flight);
    if (inFlightOf(item).some((e) => e.error)) out.push('wait check failing');
  }
  if (item.facts?.workerAsks?.count) out.push(`${item.facts.workerAsks.count} asks from workers`);
  // A conversation carrying a large context (loom-context-management): every call re-sends it, so it says so.
  if (item.disposition !== 'done' && (item.facts?.context?.tokens || 0) >= LARGE_CONTEXT) out.push(`context ${tokensLabel(item.facts.context.tokens)}`);
  // Past 80% of its daily budget it starts fresh at the next turn, and at 100% Loom holds its automatic turns.
  const budget = budgetToday(item, now);
  if (item.disposition !== 'done' && budget && budget.share >= BUDGET_WARN) out.push(`budget ${Math.round(budget.share * 100)}%`);
  const screens = (item.artifacts || []).filter((a) => a.kind === 'scene' || a.kind === 'prototype').length;
  if (screens) out.push(`${screens} screen${screens === 1 ? '' : 's'}`);
  return out;
}

/** Everything a thread row shows (spec: "Thread row"). */
export function rowOf(item, { projects = [], context = null, now = Date.now(), lists = null, filters = null } = {}) {
  const home = homeOf(item, projects);
  const facts = kindOf(item) === 'job' ? [onSchedule(item, now) ? 'On schedule' : null, scheduleLine(item, now), ...factsOf(item, now)].filter(Boolean) : factsOf(item, now);
  if (context && matches(item, { scope: { kind: 'global' }, audience: 'all', where: { muted: { in: ['true'] } } }, { filters })) facts.push('Muted');
  // The home beside the title, unless the page already is that home.
  // An agent's chat already names the agent ("Chat with Malibu"): no "· Malibu" after it.
  const showHome = home && !(context && context.kind === home.kind && context.id === home.id) && !(item.kind === 'chapter' && home.kind === 'agent');
  return {
    id: item.id,
    title: threadTitle(item),
    home: showHome ? home : null,
    tile: tileOf(item, projects),
    // The pill says whose move; busy is the dot beside the time, so Working is never a pill on a row.
    status: statusOf(item, now),
    busy: null,
    next: nextAction(item, now),
    preview: previewOf(item),
    facts,
    time: age(item.lastActivityAt, now),
    pinned: !!item.facts?.pinned,
    kind: kindOf(item),
    // The space shows in the trail instead of beside the title: "Desk reliability › Inbox empty state".
    trail: lists ? trailOf(item, lists, showHome ? home : null) : null,
  };
}

/** A header's grey metadata: home, agent (when the home isn't it), time, type. */
export function headerMeta(item, projects = [], now = Date.now()) {
  const home = homeOf(item, projects);
  const out = [];
  if (home) out.push({ kind: home.kind, id: home.id, text: home.name });
  const agent = agentOf(item);
  if (agent && home?.kind !== 'agent') out.push({ kind: 'agent', id: agent, text: agentNameOf(item) || agent });
  if (home?.kind !== 'repo' && repoOf(item)) out.push({ kind: 'repo', id: repoOf(item), text: repoOf(item) });
  out.push({ kind: 'time', text: age(item.lastActivityAt, now) });

  return out;
}

export { stageOf, stageName };

// ── pages and the breadcrumb ────────────────────────────────────────

/**
 * A page of the next layout. The thread page itself is the shared presentation (a conversation open on
 * every screen); these are the places around it, kept per device:
 *   { page: 'inbox', view }  { page: 'projects' }  { page: 'project', id }  { page: 'agents' }  { page: 'agent', id }  { page: 'capacity' }
 */
export const HOME_ROUTE = Object.freeze({ page: 'inbox', view: null });

export function routeKey(route) {
  return [route?.page, route?.id || route?.view || route?.query || ''].join(':');
}

/**
 * The place under an open thread. Opened from a project it follows the thread's project: moved to another,
 * that project; moved out of any, the Inbox. Elsewhere (the Inbox, an agent) it stays where it was opened.
 */
export function threadRoute(route, item, projects = [], projectsLoaded = true) {
  if (!item || route?.page !== 'project') return route;
  const id = item.facts?.projectId;
  // Before the projects load, an id that isn't there yet is no news: keep the place (Codex review on #617).
  if (!projectsLoaded) return id && id !== route.id ? { page: 'project', id } : route;
  // A deleted project's threads keep its id: with no such project they're on their own, so the Inbox.
  if (id && projects.some((p) => p.id === id)) return id === route.id ? route : { page: 'project', id };
  return HOME_ROUTE;
}

/** A conversation as an owner is named: an agent's chat by the agent, else its title. */
export function ownerName(item) {
  return item?.kind === 'chapter' ? item.agentName : threadTitle(item);
}

/** Shared reporting picker label, with the default conversation first. */
export function ownerLabel(item, lead) {
  return `${ownerName(item)}${item.id === lead?.id ? ' · lead' : ''}`;
}

/** The space a conversation lives in, as ownerChoices takes it: a project or an agent, else none (its repo). */
export function spaceOf(item, projects = []) {
  const home = homeOf(item, projects);
  return home && (home.kind === 'project' || home.kind === 'agent') ? { kind: home.kind, id: home.id } : null;
}

/**
 * Who a worker or job can report to (docs/specs/spaces.md, Two relations): the space's lead (its default) first,
 * then the space's other open threads, newest first. Never `self` or a conversation that reports to it. With no
 * space, the open threads outside any project or agent. `lead` is null when the space has no default.
 */
export function ownerChoices(lists, space, projects = [], { self = null, limit = 20 } = {}) {
  const match = space ? ownMatch(space.kind, space.id, projects) : (i) => !projectOf(i, projects) && !agentOf(i);
  const open = openItems(lists).filter((i) => i.id !== self && ['thread', 'default'].includes(kindOf(i)) && i.disposition !== 'done' && !(self && i.facts?.parentItemId === self) && match(i));
  const chat = space?.kind === 'agent' ? agentChat(lists, space.id) : null;
  // An agent with no open chat has no lead: its last finished one would take reports nobody reads (Codex review on #854).
  const lead = (chat && chat.id !== self && chat.disposition !== 'done' ? chat : null) || (space ? open.find((i) => kindOf(i) === 'default') || null : null);
  const rest = open.filter((i) => i.id !== lead?.id).sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
  return { lead, choices: [...(lead ? [lead] : []), ...rest].slice(0, limit) };
}

/**
 * The crumb for the conversation a worker or job reports to (docs/specs/spaces.md, Two relations): its title, or
 * the agent's name for an agent's chat. It opens the owner. A thread, a default, or an owner that's gone has none.
 */
export function ownerCrumb(item, lists) {
  if (!['worker', 'job'].includes(kindOf(item))) return null;
  const owner = findItem(lists, item.facts?.parentItemId);
  if (!owner) return null;
  // An agent's default (a Discord chat, or a Loom default in an agent space) is its chat: the agent's own crumb
  // can stand for it. A project's default has no agent (Codex review on #772).
  const chatOf = kindOf(owner) === 'default' ? agentOf(owner) : null;
  return { label: owner.kind === 'chapter' ? owner.agentName : threadTitle(owner), owner: owner.id, ...(chatOf ? { chatOf } : {}) };
}

/**
 * The breadcrumb for a place, then the thread when one is open: [{ label, route? }]. A worker or job's thread
 * comes after the conversation it reports to ({ label, owner }, from ownerCrumb).
 */
export function crumbsOf(route, { views = [], projects = [], agents = [], thread = null, owner = null, systemJob = null } = {}) {
  const out = [];
  if (route.page === 'search') {
    // Search hangs off the home: its crumb before the query leaves the page (Codex review on #625).
    out.push({ label: 'Inbox', route: HOME_ROUTE });
    if (route.scope?.startsWith('space:')) {
      const [kind, id] = route.scope.slice(6).split(/:(.*)/s);
      const name = (kind === 'project' ? projects : agents).find((p) => p.id === id)?.name || id;
      out.push({ label: name, route: { page: kind, id } });
    }
    out.push({ label: `Search “${route.query || ''}”`, route });
  } else if (route.page === 'catchup') {
    out.push({ label: 'Inbox', route: { page: 'inbox', view: null } }, { label: 'Catch me up', route });
  } else if (route.page === 'inbox') {
    out.push({ label: 'Inbox', route: { page: 'inbox', view: null } });
    const view = views.find((v) => v.id === route.view) || views[0];
    if (view && thread) out.push({ label: view.name, route: { page: 'inbox', view: view.id } });
  } else if (route.page === 'projects' || route.page === 'project') {
    const project = projects.find((p) => p.id === route.id);
    if (route.page === 'project') out.push(...projectTrail(project, route.id, { projects, agents }));
    else out.push({ label: 'Projects', route: { page: 'projects' } });
  } else if (route.page === 'capacity') {
    out.push({ label: 'Capacity', route });
  } else if (route.page === 'system') {
    // System, then a job when its page is open (System › job).
    out.push({ label: 'System', route: { page: 'system', view: route.view || 'overview' } });
    if (route.id) out.push({ label: systemJob || route.id, route });
  } else if (route.page === 'spacesettings') {
    const [kind, id] = String(route.id || '').split(/:(.*)/s);
    if (kind === 'project') {
      out.push(...projectTrail(projects.find((p) => p.id === id), id, { projects, agents }));
    } else {
      const agent = agents.find((a) => a.id === id);
      out.push({ label: 'Agents', route: { page: 'agents' } }, { label: agent?.name || id, route: { page: 'agent', id }, agent: id });
    }
    out.push({ label: 'Settings', route });
  } else if (route.page === 'agents' || route.page === 'agent') {
    out.push({ label: 'Agents', route: { page: 'agents' } });
    const agent = agents.find((a) => a.id === route.id);
    if (route.page === 'agent') out.push({ label: agent?.name || route.id, route, agent: route.id });
  }
  // A worker or job nests under what it reports to; an agent's chat under that agent's own crumb says it twice.
  // By identity, not by name: a thread named like its project is still its own conversation (Codex review on #772).
  if (thread && owner && !(owner.chatOf && owner.chatOf === out[out.length - 1]?.agent)) out.push({ label: owner.label, owner: owner.owner });
  if (thread) out.push({ label: thread });
  return out;
}

/**
 * A project's crumbs from its index: `Projects › Tango › Desk`, or `Agents › Sierra › Bike` for an agent's project
 * (docs/specs/spaces.md, Nesting). The last one is the project itself.
 */
function projectTrail(project, id, { projects = [], agents = [] } = {}) {
  const self = { label: project?.name || 'Project', route: { page: 'project', id }, color: project?.color || null, tile: project ? { kind: 'project', id, project } : null };
  const parent = parentOf(project);
  if (parent?.kind === 'agent') {
    const name = agents.find((a) => a.id === parent.id)?.name || agentLabel(parent.id);
    return [{ label: 'Agents', route: { page: 'agents' } }, { label: name, route: { page: 'agent', id: parent.id }, agent: parent.id }, self];
  }
  const up = parent ? projects.find((p) => p.id === parent.id) : null;
  return [{ label: 'Projects', route: { page: 'projects' } }, ...(up ? [{ label: up.name, route: { page: 'project', id: up.id }, color: up.color || null, tile: { kind: 'project', id: up.id, project: up } }] : []), self];
}

/** The Inbox's views (the owner's List views), each with what it holds. Only open threads, no projects folded in. */
/** Apply stage visibility only to runtime views, never the saved definitions. */
const unstaged = (state, view, status) => viewForFlags(view, state.flags, status);

export function inboxViews(state) {
  const projects = state.projects || [];
  // Every view, whatever it groups by: the Inbox groups threads by status itself.
  const views = viewsOf(state.listViews, state.listGroup).map((view) => unstaged(state, view, 'live'));
  // The server's audience admits owner-facing workers too, when their lead is gone.
  return views.map((view) => ({ view, items: viewItems(state.lists, view, projects, null).filter((item) => matches(item, { scope: { kind: 'global' }, audience: 'owner', where: { muted: { in: ['false'] } } }, { projects, filters: state.filters })) }));
}

/** The Inbox view this device is on: the one it went to, else the List's tab, else the first. */
export function currentInboxView(state) {
  const views = viewsOf(state.listViews, state.listGroup);
  return currentView(views, state.nextRoute?.view || state.listTab);
}

/** The one view whose count gets color: the first that holds what needs the owner. */
export function needsViewId(views) {
  // From what the view holds, not its id: the owner can rename and refilter the built-in Ready (Codex review on #589).
  const needs = (v) => { const live = viewToQuery(v).where.live?.in || []; return live.includes('needs') && !live.includes('working'); };
  return views.find(needs)?.id || null;
}

/** Every open thread the desk holds (Active, Snoozed and Parked), once each. */
export function openItems(lists) {
  const seen = new Map();
  for (const key of ['active', 'snoozed']) for (const item of lists?.[key]?.items || []) if (!seen.has(item.id)) seen.set(item.id, item);
  return [...seen.values()];
}

/** A project's or an agent's threads, open first by what they need, then the done ones (newest first). */
export function threadsIn(lists, match) {
  const open = openItems(lists).filter(match);
  const done = (lists?.history?.items || []).filter(match);
  return { open, done };
}

/** Snoozed or parked: put away, so it never counts as needing you (the sidebar's tally, a project's counts, agents). */
const isAway = (item) => matches(item, { scope: { kind: 'global' }, audience: 'all', where: { disposition: { in: ['snoozed', 'parked'] } } });

/** The named agents (never coding threads), from what the desk holds: id, name, open count, needs-you count. */
export function agentsOf(lists, now = Date.now()) {
  const map = new Map();
  const all = [...openItems(lists), ...(lists?.history?.items || [])];
  for (const item of all) {
    const id = agentOf(item);
    if (!id) continue;
    const entry = map.get(id) || { id, name: agentNameOf(item) || id, open: 0, needs: 0 };
    if (item.facts?.agentSpace?.name) entry.name = item.facts.agentSpace.name;
    else if (String(item.agentId || '').toLowerCase() === id) entry.name = item.agentName || entry.name;
    if (matches(item, { scope: { kind: 'global' }, audience: 'all', where: { disposition: { not: ['done'] } } })) {
      entry.open += 1;
      if (!isAway(item) && wantsOwner(item, now)) entry.needs += 1;
    }
    map.set(id, entry);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Group threads by status, in the order the owner deals with them; away and done at the end. */
export const GROUPS = [['failed', 'Failed'], ['stuck', 'Stuck'], ['needs', 'Needs you'], ['finished', 'Finished'], ['sent', 'Sent'], ['working', 'Working'], ['waiting', 'Waiting'], ['idle', 'Idle'], ['unknown', 'Unknown'], ['away', 'Later'], ['done', 'Done']];

/** The status sections a project's page hides: its own pick, else the desk's default. */
export function hiddenSectionsOf(project, state) {
  return project?.hiddenSections || state.projectSectionsHidden || ['done'];
}

/** A page's status sections, under Pinned (rows by the owner's last message): a pin in rotation heads the page (an away or done one stays with its kind). Pinned can't be hidden. */
export function groupByStatus(items, now = Date.now()) {
  const buckets = new Map([['pinned', []], ...GROUPS.map(([key]) => [key, []])]);
  for (const item of items) {
    const key = item.disposition === 'done' ? 'done' : item.disposition === 'snoozed' || item.disposition === 'parked' ? 'away' : isSent(item) ? 'sent' : liveState(item, now) || 'other';
    buckets.get(buckets.has(key) ? key : 'other').push(item);
  }
  // Your latest message first, so agent activity never moves a row; Done by when it was done.
  for (const [key, list] of buckets) list.sort(key === 'done' ? (a, b) => (b.doneAt || b.lastActivityAt || 0) - (a.doneAt || a.lastActivityAt || 0) : (a, b) => ownerOrderAt(b) - ownerOrderAt(a));
  return [['pinned', 'Pinned'], ...GROUPS].map(([key, label]) => ({ key, label, items: buckets.get(key) })).filter((g) => g.items.length);
}

/** Where a project sits on the Projects page: finished is Done, else Parked, Snoozed or Active (a snooze past its time is Active). */
export function projectGroup(project, now = Date.now()) {
  return project.finishedAt ? 'done' : projectState(project, now);
}

export const PROJECT_GROUPS = [
  ['active', 'Active'],
  ['snoozed', 'Snoozed'],
  ['parked', 'Parked'],
  ['done', 'Done'],
];

/** The Projects page's groups, in order, the empty ones left out. */
export function groupProjects(projects, now = Date.now()) {
  return PROJECT_GROUPS.map(([key, label]) => ({ key, label, items: (projects || []).filter((p) => projectGroup(p, now) === key) })).filter((g) => g.items.length);
}

/**
 * A sidebar row's tally, from its open threads (snoozed and parked included): `waiting` is what needs the owner
 * (unread or an open request, and failures they haven't seen; wantsOwner), not Ready, which they read and left,
 * `active` is every thread in rotation, and `by` counts each status for the hover breakdown. Snoozed and parked
 * show only there.
 */
export function tallyOf(items, now = Date.now()) {
  const by = Object.fromEntries(TALLY.map(([key]) => [key, 0]));
  let active = 0;
  let waiting = 0;
  for (const item of items) {
    if (!matches(item, { scope: { kind: 'global' }, audience: 'all', where: { disposition: { not: ['done'] } } })) continue;
    if (isAway(item)) {
      by[item.disposition] += 1;
      continue;
    }
    // A job on schedule isn't work in rotation: it counts only while it runs or after it failed.
    if (onSchedule(item, now)) continue;
    active += 1;
    by[liveState(item, now) || 'sent'] += 1;
    if (wantsOwner(item, now) && matches(item, { scope: { kind: 'global' }, audience: 'owner', where: {} })) waiting += 1;
  }
  return { waiting, active, by };
}

/** The breakdown's statuses in the order the owner deals with them, with their color. */
export const TALLY = [['failed', 'failed', 'danger'], ['stuck', 'stuck', 'danger'], ['needs', 'needs you', 'move'], ['finished', 'finished', 'working'], ['working', 'working', 'working'], ['waiting', 'waiting', 'watching'], ['idle', 'idle', 'dim'], ['unknown', 'unknown', 'dim'], ['snoozed', 'later', 'dim'], ['parked', 'later', 'dim']];

/** A tally's breakdown lines: [count, label, color], the empty ones left out. */
export function breakdownOf(tally) {
  return tally.waiting ? [[tally.waiting, 'needs you', 'move']] : [];
}

/** Where a view's threads are, for its hover: [count, place name], most first. */
export function placesOf(items, projects = []) {
  const counts = new Map();
  for (const item of items) {
    const name = homeOf(item, projects)?.name || threadTitle(item);
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()].map(([name, n]) => [n, name]).sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
}

/** A project's or agent's counts, said with one colored number: needs you. */
export function countsOf(items, now = Date.now()) {
  const c = { needs: 0, working: 0, watching: 0, ready: 0, open: countFor(items, { scope: { kind: 'global' }, audience: 'all', where: { disposition: { not: ['done'] } } }) };
  for (const item of items) {
    if (!matches(item, { scope: { kind: 'global' }, audience: 'all', where: { disposition: { not: ['done'] } } })) continue;
    if (isAway(item)) continue;
    const live = liveState(item, now);
    if (wantsOwner(item, now)) c.needs += 1;
    else if (live === 'failed') c.ready += 1;
    else if (live && c[live] !== undefined) c[live] += 1;
  }
  return c;
}

/**
 * An agent's home chat: its home channel, which the desk splits into chapters (one per burst). The agent
 * page pins the latest one as "Chat with Sierra"; the other chapters stay out of its thread list.
 */
export function agentChat(lists, agentId) {
  const mine = [...openItems(lists), ...(lists?.history?.items || [])].filter((i) => matches(i, { scope: { kind: 'global' }, audience: 'all', where: { agent: { in: [agentId] } } }));
  const newest = (list) => list.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))[0] || null;
  // A Discord agent's home channel; else the default conversation of an agent space (Compass's own thread).
  return newest(mine.filter((i) => i.kind === 'chapter')) || newest(mine.filter((i) => i.facts?.role === 'default' && i.disposition !== 'done'));
}

/**
 * A view's icon in the sidebar and the switcher, read from what it holds: History (done), Snoozed, Parked,
 * Working, Watching, a needs-you view, else the Inbox tray (Active and the owner's own views).
 */
export function viewIcon(view) {
  const status = view?.status || [];
  const live = view ? viewToQuery(view).where.live?.in || [] : [];
  if (status.length === 1 && status[0] === 'done') return 'history';
  if (status.length === 1 && status[0] === 'snoozed') return 'snoozed';
  if (status.length === 1 && status[0] === 'parked') return 'parked';
  if (live.length === 1 && live[0] === 'working') return 'working';
  if (live.length === 1 && (live[0] === 'watching' || live[0] === 'review')) return 'watching';
  if (live.includes('needs') && !live.includes('working')) return 'needs';
  return 'inbox';
}

// ── the Inbox's own filter (on top of the view) ─────────────────────

/** The value for "has none": a sentinel no repo, agent or project id can be (Codex review on #600). */
export const NONE = '\u0000none';

// Third field: where a facet is picked. None, the Filter menu; 'old', no longer in the menu (Where took them) but
// still honored and shown as a chip so a saved pick can be removed; 'advanced', the tab editor's Advanced only;
// 'spaces', the space views' editor only.
export const FILTER_FACETS = [
  ['stage', 'Stage'],
  ['where', 'Where'],
  ['project', 'Project', 'old'],
  ['agent', 'Agent', 'old'],
  ['repo', 'Repo', 'old'],
  ['busy', 'Busy'],
  ['unread', 'Unread'],
  ['kind', 'Kind', 'old'],
  ['pinned', 'Pinned'],
  ['space', 'Space', 'old'],
  ['wait', 'Waiting on'],
  ['overdue', 'Overdue'],
  ['age', 'Last active'],
  // Jobs only: the Inbox never lists jobs, so Health lives in the space views' editor, not the Inbox menu.
  ['health', 'Health', 'spaces'],
  ['source', 'Source', 'advanced'],
  ['account', 'Account', 'advanced'],
];

/** The Filter menu's one-tap toggles: each is one value of a facet ("Show only" these). */
export const SHOW_ONLY = [['unread', 'true', 'Unread'], ['pinned', 'true', 'Pinned'], ['busy', 'working', 'Working now'], ['overdue', 'true', 'Overdue']];

/**
 * The Where picker's rows in the sidebar's shape: projects with their children, then agents with theirs, then
 * "Not in a project" with its repos. Only places with something in them, or a pick to undo.
 */
export function whereTree(options = [], projects = [], agents = [], picked = []) {
  const by = new Map(options.map((o) => [o.value, o]));
  const keep = (value) => (by.get(value)?.n || 0) > 0 || picked.includes(value);
  const placed = new Set();
  const out = [];
  let section = 'projects';
  const row = (value, depth) => {
    placed.add(value);
    out.push({ value, depth, section, n: by.get(value)?.n || 0, label: by.get(value)?.label || value });
  };
  const known = new Set(projects.map((p) => `project:${p.id}`));
  const kids = (key) => projects.filter((p) => p.parent === key && keep(`project:${p.id}`));
  const project = (p, depth) => {
    row(`project:${p.id}`, depth);
    for (const c of kids(`project:${p.id}`)) project(c, depth + 1);
  };
  for (const p of projects.filter((q) => (!q.parent || (q.parent.startsWith('project:') && !known.has(q.parent))) && keep(`project:${q.id}`))) project(p, 0);
  const agentIds = [...new Set([...agents.map((a) => `agent:${a.id}`), ...options.filter((o) => o.value.startsWith('agent:')).map((o) => o.value)])];
  const agentRows = agentIds.filter((key) => keep(key) || kids(key).length).map((key) => ({ key, label: by.get(key)?.label || agents.find((a) => `agent:${a.id}` === key)?.name || key.slice(6) }));
  section = 'agents';
  for (const a of agentRows.sort((x, y) => x.label.localeCompare(y.label))) {
    row(a.key, 0);
    out[out.length - 1].label = a.label;
    for (const c of kids(a.key)) project(c, 1);
  }
  section = 'loose';
  if (keep('loose')) {
    row('loose', 0);
    for (const o of options.filter((q) => q.value.startsWith('repo:') && keep(q.value))) row(o.value, 1);
  }
  // A place the tree doesn't know (a finished project's pick) still lists, so it can be unpicked.
  section = 'other';
  for (const o of options) if (!placed.has(o.value) && keep(o.value)) row(o.value, 0);
  return out;
}

/** One facet's value on an item ('none' when it has none), as the filter compares it. */
export function facetOf(item, facet, projects = []) {
  return facets[facet]?.(item, { projects }) ?? NONE;
}

/** The values each facet takes across these items, with counts, for the Filter menu. */
export function filterOptions(items, projects = [], filter = {}, now = Date.now()) {
  const out = {};
  for (const [facet] of FILTER_FACETS) {
    const counts = new Map([...facetCounts(items, picksToQuery(filter), facet, { projects, now })].map(([value, n]) => [value ?? NONE, n]));
    const fixed = { busy: ['working', 'background', NONE], unread: ['true', 'false'], kind: ['thread', 'default'], pinned: ['true', 'false'], wait: ['person', 'agent', 'review', 'job', 'monitor', 'check-back', NONE], overdue: ['true', 'false'], age: ['today', 'week', 'month', 'older', NONE], health: ['failing', 'paused', 'running', 'on-schedule', NONE] }[facet];
    if (fixed) {
      for (const value of [...counts.keys()]) if (!fixed.includes(value)) counts.delete(value);
      for (const value of fixed) if (!counts.has(value)) counts.set(value, 0);
    }
    for (const value of filter[facet] || []) if (!counts.has(value)) counts.set(value, 0);
    out[facet] = [...counts.entries()].map(([value, n]) => ({ value, n, label: facetLabel(facet, value, projects, items) })).sort((a, b) => (a.value === NONE) - (b.value === NONE) || a.label.localeCompare(b.label));
  }
  return out;
}

export function facetLabel(facet, value, projects = [], items = []) {
  if (value === NONE) return { type: 'No type', stage: 'No stage', project: 'No project', agent: 'No agent', repo: 'No repo', busy: 'Idle', space: 'No space', wait: 'No wait', health: 'No health', source: 'No source', account: 'No account', age: 'No activity' }[facet] || 'None';
  if (facet === 'wait') return { person: 'Person', agent: 'Agent', review: 'PR review', job: 'Job', monitor: 'Monitor', 'check-back': 'Check back' }[value] || value;
  if (facet === 'overdue') return value === 'true' ? 'Overdue' : 'Not overdue';
  if (facet === 'age') return { today: 'Today', week: 'This week', month: 'This month', older: 'Older' }[value] || value;
  if (facet === 'health') return { failing: 'Failing', paused: 'Paused', running: 'Running', 'on-schedule': 'On schedule' }[value] || value;
  if (facet === 'busy') return { working: 'Working', background: 'Background' }[value] || value;
  if (facet === 'unread') return value === 'true' ? 'Unread' : 'Read';
  if (facet === 'pinned') return value === 'true' ? 'Pinned' : 'Unpinned';
  if (facet === 'kind') return KINDS[value] || value;
  if (facet === 'space') {
    const [kind, ...id] = value.split(':');
    return facetLabel(kind, id.join(':'), projects, items);
  }
  if (facet === 'where') {
    if (value === 'loose') return 'Not in a project';
    const [kind, ...rest] = value.split(':');
    const id = rest.join(':');
    if (kind === 'repo') return itemRepoNamed(items, id) || id;
    return facetLabel(kind, id, projects, items);
  }
  if (facet === 'type') return typeName(value);
  if (facet === 'stage') return stageName(value);
  if (facet === 'project') return projects.find((p) => p.id === value)?.name || value;
  if (facet === 'agent') return agentNameOf(items.find((i) => facets.agent(i) === value)) || value.charAt(0).toUpperCase() + value.slice(1);
  return value;
}

/** The tab editor's Where choices, in the picker's order, each named with its path ("Tango › Desk"). */
export function whereChoices(items, state, picked = []) {
  const projects = state.projects || [];
  const tree = whereTree(filterOptions(items, projects, { where: picked }, state.now).where, projects, sidebarPlaces(state).agents, picked);
  const path = [];
  return tree.map((o) => {
    path[o.depth] = o.label;
    return [o.value, path.slice(0, o.depth + 1).join(' › ')];
  });
}

/** A repo's name as its threads spell it ("Tango", not "tango"). */
function itemRepoNamed(items, lower) {
  for (const item of items) {
    const repo = facets.where(item).find((v) => v.startsWith('repo:'));
    if (repo === `repo:${lower}`) return repoOf(item) || item.area?.trim() || null;
  }
  return null;
}

/** Items the filter keeps: every facet with picks must match one of its picks. */
export function applyFilter(items, filter = {}, projects = []) {
  const query = picksToQuery(filter);
  return items.filter((item) => matches(item, query, { projects }));
}

export function filterCount(filter = {}) {
  return FILTER_FACETS.reduce((n, [facet]) => n + (filter[facet]?.length || 0), 0);
}

/** A saved tab captures the current definition AND every device pick. */
export function filteredView(view, filter, views, name, projects = []) {
  const query = intersectPicks(viewToQuery(view), filter, { projects });
  // Keep Status in the field used to load lists, unless the definition explicitly refines it.
  if (!view.where?.disposition) delete query.where.disposition;
  return { ...view, id: newViewId(views, name), name, where: query.where, ...(filterCount(filter) ? { emptyShelf: false } : {}) };
}

export function filterName(filter, projects = [], items = []) {
  return FILTER_FACETS.flatMap(([facet]) => (filter[facet] || []).map((value) => facetLabel(facet, value, projects, items))).join(' · ').slice(0, 40) || 'New tab';
}

/** What voice reads: the same places, groups and row titles as the next layout. */
export function nextListReport(state) {
  const route = state.nextRoute || HOME_ROUTE;
  const projects = state.projects || [];
  const agents = agentsOf(state.lists, state.now);
  const views = inboxViews(state);
  const current = views.find((v) => v.view.id === currentInboxView(state)?.id) || views[0];
  const project = route.page === 'project' ? projects.find((p) => p.id === route.id) : null;
  // The rows as the list draws them: workers under their lead, and none while that lead is folded.
  const visible = (groups, scope) => shownRows(groups, state).filter((g) => !(state.listCollapsed || []).includes(`${scope}|${g.key}`)).flatMap((g) => g.rows);
  const thread = (item) => {
    const title = threadTitle(item);
    const next = nextAction(item, state.now);
    return { kind: 'item', id: item.id, title: next ? `${next} · ${title}` : title, where: homeOf(item, projects)?.name || '' };
  };
  let rows = [];
  // The page's own views and the one it's on (an Inbox's are its tabs), so voice can switch them ("the Workers view").
  // A page without view pills (Search, Capacity, settings) has none (Codex review on #715).
  const inbox = route.page === 'inbox';
  let pageViews = inbox ? views.map(({ view, items }) => ({ id: view.id, name: view.name, count: items.length })) : [];
  let pageViewId = inbox ? current?.view.id || '' : '';
  const own = (list, id) => {
    pageViews = list.map((v) => ({ id: v.id, name: v.name, count: v.items.length }));
    pageViewId = id;
  };
  // The pages' own views (pages.js): the rows the owner sees in the view they're on.
  if (route.page === 'projects') {
    const views = projectViews(projects, state.now);
    const view = pageView(state, 'projects', views);
    own(views, view);
    rows = (views.find((v) => v.id === view)?.items || []).map((p) => ({ kind: 'project', id: p.id, title: p.name, where: 'project' }));
  } else if (route.page === 'system' && !route.id) {
    // The System page's tabs are its views ("the Jobs view", "show me events").
    const tabs = SYSTEM_TABS.map(([id, name]) => ({ id, name, items: [] }));
    own(tabs, route.view || 'overview');
  } else if (route.page === 'agents') {
    const views = agentViews(state);
    const view = pageView(state, 'agents', views);
    own(views, view);
    rows = (views.find((v) => v.id === view)?.items || []).map((a) => ({ kind: 'agent', id: a.id, title: a.name, where: 'agent' }));
  }
  else if (route.page === 'inbox' && current) {
    const kept = applyFilter(current.items, state.nextFilter || {}, projects);
    const groups = viewSections(kept, current.view, state.labelOrder, projects, state.nextOrder);
    rows = visible(groups, `inbox:${current.view.id}`).map(thread);
    const shelf = !groups.length && !filterCount(state.nextFilter) && state.lists.history?.loaded && !draftView(state.draft, state.now) && trophyShelf(state.lists, current.view, state.now);
    if (shelf) rows = shelf.items.map((i) => ({ kind: 'item', id: i.id, title: rowTitle(i), where: '' }));
  } else if (route.page === 'project' && project) {
    const { open, done } = threadsIn(state.lists, ownMatch('project', route.id, projects));
    const shown = state.nextShowHidden === route.id;
    const hidden = shown ? [] : hiddenSectionsOf(project, state);
    const views = spaceViews(open, done, shownSpaceViews(state), { now: state.now, projects });
    const view = pageView(state, `project:${route.id}`, views);
    own(views, view);
    const items = views.find((v) => v.id === view)?.items || [];
    rows = visible(spaceGroups(views.find((v) => v.id === view), items, state.now, view === views[0]?.id ? hidden : []), `project:${route.id}:${view}`).map(thread);
  } else if (route.page === 'agent') {
    const chat = agentChat(state.lists, route.id);
    const mine = ownMatch('agent', route.id, projects);
    const { open, done } = threadsIn(state.lists, (i) => mine(i) && i.kind !== 'chapter' && i.id !== chat?.id);
    const views = spaceViews(chat ? [chat, ...open] : open, done, shownSpaceViews(state), { now: state.now, projects });
    const view = pageView(state, `agent:${route.id}`, views);
    own(views, view);
    const items = (views.find((v) => v.id === view)?.items || []).filter((i) => i.id !== chat?.id);
    const withChat = chat && views.find((v) => v.id === view)?.items.some((i) => i.id === chat.id);
    rows = visible([...(withChat ? [{ key: 'default', label: null, items: [chat] }] : []), ...spaceGroups(views.find((v) => v.id === view), items, state.now)], `agent:${view}`).map(thread);
  }
  const name = placeName(route, { inbox: current?.view.name, projects, agents });
  return {
    place: { ...route, ...(route.page === 'inbox' ? { view: current?.view.id } : {}), name },
    tab: { id: current?.view.id || '', name: current?.view.name || 'Inbox' },
    tabs: views.map(({ view, items }) => ({ id: view.id, name: view.name, count: items.length })),
    views: pageViews,
    view: { id: pageViewId, name: pageViews.find((v) => v.id === pageViewId)?.name || '' },
    project: project ? { id: project.id, name: project.name } : null,
    projects: projects.map(({ id, name }) => ({ id, name })),
    agents: agents.map(({ id, name }) => ({ id, name })),
    rows,
  };
}

/** The System page's tabs (next/system.js), in order: [id, name]. */
export const SYSTEM_TABS = [
  ['overview', 'Overview'],
  ['jobs', 'Jobs'],
  ['events', 'Events'],
  ['capacity', 'Capacity'],
];

/** A place's name as voice says it: each page by its own name, never another's. */
export function placeName(route, { inbox = null, projects = [], agents = [] } = {}) {
  const agentName = (id) => agents.find((a) => a.id === id)?.name || id;
  switch (route.page) {
    case 'inbox':
      return inbox || 'Inbox';
    case 'project':
      return projects.find((p) => p.id === route.id)?.name || 'Project';
    case 'agent':
      return agentName(route.id);
    case 'projects':
      return 'Projects';
    case 'agents':
      return 'Agents';
    case 'capacity':
      return 'Capacity';
    case 'system':
      return 'System';
    case 'search':
      return 'Search';
    case 'spacesettings': {
      const [kind, id] = String(route.id || '').split(/:(.*)/s);
      const space = kind === 'project' ? projects.find((p) => p.id === id)?.name || 'Project' : agentName(id);
      return `${space} settings`;
    }
    default:
      return route.page || 'Inbox';
  }
}

/** Visible rows in rendered group order; collapsed groups never contribute a keyboard target. */
export function visibleRowOrder(groups) {
  return groups.flatMap((g) => g.shut ? [] : g.items);
}

/** One step through the visible rows, clamped at either end; stale focus starts at the first row. */
export function stepRowFocus(rows, focusId, direction) {
  const at = rows.findIndex((r) => r.id === focusId);
  return rows[at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + direction))]?.id || null;
}

// ── spaces (docs/specs/spaces.md): a project's or an agent's page and the index rows ──

/**
 * A space page's views: Overview, then one per conversation kind it holds, then Done. Each view is a filter over
 * the same conversations, as the Inbox's tabs are over the owner's; the count is what it holds.
 */
/**
 * A space page's views, as queries on its own conversations (open, or done for Done). Overview is what the owner
 * works on: workers stay on their own tab and reach the owner through their lead (owner, 10/19).
 */
export const SPACE_VIEWS = [
  { id: 'overview', name: 'Overview', where: { kind: { not: ['worker'] } } },
  { id: 'threads', name: 'Threads', where: { kind: { in: ['thread', 'default'] } } },
  { id: 'jobs', name: 'Jobs', where: { kind: { in: ['job'] } } },
  { id: 'workers', name: 'Workers', where: { kind: { in: ['worker'] } } },
  { id: 'done', name: 'Done', done: true, where: {} },
];

/** The space views every project and agent page shows: one set for all of them (owner, 10/19), else the built-ins. */
export function spaceViewDefs(state) {
  const saved = state.spaceViews;
  // Preserve unknown filters: the shared evaluator refuses unknown facets and unknown inclusions match nothing.
  return Array.isArray(saved) && saved.length ? saved : SPACE_VIEWS;
}

/** The space views as a page shows them (the editor reads spaceViewDefs, so a view keeps what it saved). */
export function shownSpaceViews(state) {
  return spaceViewDefs(state).map((view) => unstaged(state, view, 'status'));
}

export function spaceViews(open, done, defs = SPACE_VIEWS, ctx = {}) {
  return defs
    .map((def) => ({ ...def, items: (def.done ? done : open).filter((i) => matches(i, { scope: { kind: 'global' }, audience: 'all', where: def.where || {} }, ctx)) }))
    .filter((v, index) => index === 0 || v.items.length);
}

/** A view's sections: by status, except jobs on schedule, which wait together at the bottom ("On schedule"). */
export function spaceGroups(view, items, now = Date.now(), hidden = []) {
  const def = typeof view === 'string' ? SPACE_VIEWS.find((v) => v.id === view) || {} : view || {};
  // Items already passed the view's query, so a matching default is admitted by all its filters.
  const lead = !def.done ? items.filter((i) => kindOf(i) === 'default') : [];

  if (def.group === 'health') {
    const groups = new Map();
    for (const item of items) {
      const key = facets.health(item, { now }) ?? NONE;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    return ['failing', 'paused', 'running', 'on-schedule', NONE].filter((key) => groups.has(key) && !hidden.includes(key)).map((key) => ({ key, label: facetLabel('health', key), items: sortRows(groups.get(key), def.sort || 'recent') }));
  }
  const scheduled = items.filter((i) => onSchedule(i, now));
  const rest = items.filter((i) => !scheduled.includes(i) && !lead.includes(i));
  const shown = groupByStatus(rest, now).filter((g) => !hidden.includes(g.key)).flatMap((g) => g.items);
  const sort = def.sort || (def.done ? 'history' : 'recent');
  const body = def.group && def.group !== 'status'
    ? sectionsOf(shown, def.group, sort)
    : groupByStatus(shown, now).map((g) => ({ ...g, items: sortRows(g.items, sort) }));
  const groups = [...(lead.length ? [{ key: 'default', label: null, items: lead }] : []), ...body];
  return scheduled.length ? [...groups, { key: 'scheduled', label: 'On schedule', items: scheduled.sort((a, b) => (a.facts?.schedule?.nextRunAt || 0) - (b.facts?.schedule?.nextRunAt || 0)) }] : groups;
}

/** A space's health for its index row: what runs in it, and what failed below the owner's own conversations. */
export function healthOf(open, now = Date.now()) {
  const jobs = open.filter((i) => kindOf(i) === 'job');
  const workers = open.filter((i) => kindOf(i) === 'worker');
  const failing = [...jobs, ...workers].filter((i) => liveState(i, now) === 'failed');
  const running = workers.filter((i) => liveState(i, now) === 'working');
  return [
    failing.length ? { text: `${failing.length} ${failing.length === 1 ? (kindOf(failing[0]) === 'job' ? 'job' : 'worker') : 'jobs and workers'} failing`, bad: true } : null,
    jobs.length ? { text: `${jobs.length} job${jobs.length === 1 ? '' : 's'}` } : null,
    running.length ? { text: `${running.length} worker${running.length === 1 ? '' : 's'} running` } : null,
  ].filter(Boolean);
}

/** The view a page is on: the device's pick when that view still exists, else the first. */
export function pageView(state, key, views) {
  const picked = state.nextPageViews?.[key];
  return views.some((v) => v.id === picked) ? picked : views[0]?.id;
}

/** The Projects page's views: Active always, then Snoozed, Parked and Done when they hold any. */
export function projectViews(projects, now = Date.now()) {
  const groups = groupProjects(indexProjects(projects, now), now);
  return PROJECT_GROUPS.map(([id, name]) => ({ id, name, items: groups.find((g) => g.key === id)?.items || [] })).filter((v) => v.id === 'active' || v.items.length);
}

/** The Agents page's views, each agent with its open conversations, health and home chat. */
export function agentViews(state) {
  const projects = state.projects || [];
  const agents = agentsOf(state.lists, state.now).map((a) => {
    // Its pills roll up its projects' conversations (they aren't on the page); its health is its own.
    const own = threadsIn(state.lists, ownMatch('agent', a.id, projects)).open;
    const { open } = threadsIn(state.lists, rollupMatch('agent', a.id, childProjects(`agent:${a.id}`, projects), projects));
    return { ...a, open, health: healthOf(own, state.now), chat: agentChat(state.lists, a.id) };
  });
  const needs = (a) => a.open.some((i) => statusOf(i, state.now)?.key === 'needs');
  const failing = (a) => a.health.some((h) => h.bad);
  return [
    { id: 'all', name: 'All', items: agents },
    { id: 'needs', name: 'Needs you', items: agents.filter(needs) },
    { id: 'failing', name: 'Something failing', items: agents.filter(failing) },
  ];
}

// ── nested spaces (docs/specs/spaces.md, Nesting): a project inside a project or an agent, two levels ──

/** A project's parent space, `{ kind: 'project' | 'agent', id }`, or null at the top (the person's own space). */
export function parentOf(project) {
  const m = /^(project|agent):(.+)$/s.exec(project?.parent || '');
  return m ? { kind: m[1], id: m[2] } : null;
}

/** An agent's id said as a name, for an agent the desk has no conversations of yet. */
const agentLabel = (id) => String(id).charAt(0).toUpperCase() + String(id).slice(1);

/** The projects inside a space (`project:<id>` or `agent:<id>`): open ones, or with `all` the finished ones too. */
export function childProjects(key, projects = [], { all = false } = {}) {
  return (projects || []).filter((p) => p.parent === key && (all || !p.finishedAt));
}

/**
 * Which conversations are a space's own. A project's are the ones in it. An agent's are its conversations, less the
 * ones in its own projects (those count under the project), so a parent's and its children's numbers add up.
 */
export function ownMatch(kind, id, projects = []) {
  if (kind === 'project') return (i) => matches(i, { scope: { kind: 'space', id: `project:${id}` }, audience: 'all', where: {} }, { projects });
  const mine = new Set(childProjects(`agent:${id}`, projects, { all: true }).map((p) => p.id));
  return (i) => matches(i, { scope: { kind: 'global' }, audience: 'all', where: { agent: { in: [id] } } }, { projects }) && !mine.has(i.facts?.projectId);
}

/** A space's own conversations and its given children's: the roll-up a closed parent counts. */
export function rollupMatch(kind, id, children, projects = []) {
  const own = ownMatch(kind, id, projects);
  const ids = new Set(children.map((p) => p.id));
  return (i) => own(i) || (ids.size > 0 && matches(i, { scope: { kind: 'global' }, audience: 'all', where: { project: { in: [...ids] } } }, { projects }));
}

/**
 * The Projects page lists top-level spaces only (docs/specs/spaces.md, Nesting): a child shows under its parent's
 * page, unless it sits in another group than its parent (a snoozed, parked or done child of an active one), or its
 * parent is an agent, which the page doesn't list. Those list under their own name with the parent as a crumb.
 */
export function indexProjects(projects = [], now = Date.now()) {
  return (projects || []).filter((p) => {
    const parent = parentOf(p);
    if (!parent || parent.kind === 'agent') return true;
    const up = projects.find((q) => q.id === parent.id);
    return !up || projectGroup(up, now) !== projectGroup(p, now);
  });
}

/** The children a project's index row rolls up: the ones the index doesn't list on their own (same group as it). */
/** A project's state as one word for a dimmed child row or a tip line ("snoozed", "parked"), or null while it is active. */
export function awayWord(project, now = Date.now()) {
  const group = projectGroup(project, now);
  return group === 'snoozed' || group === 'parked' ? group : null;
}

export function foldedChildren(project, projects = [], now = Date.now()) {
  const group = projectGroup(project, now);
  return childProjects(`project:${project.id}`, projects, { all: group === 'done' }).filter((c) => projectGroup(c, now) === group);
}

/** A child's crumb on the Projects page: its parent's name ("Tango ›", "Sierra ›"), or null at the top. */
export function parentCrumb(project, projects = [], agents = []) {
  const parent = parentOf(project);
  if (!parent) return null;
  if (parent.kind === 'agent') return agents.find((a) => a.id === parent.id)?.name || agentLabel(parent.id);
  return projects.find((p) => p.id === parent.id)?.name || null;
}

/**
 * The sidebar's places (docs/specs/agent-desk-next.md, Sidebar): PROJECTS are active top-level projects, AGENTS the
 * named agents; each with the active projects inside it as `children`. An agent's projects nest under it and are not
 * repeated under PROJECTS.
 */
export function sidebarPlaces(state) {
  const all = state.projects || [];
  const active = all.filter((p) => projectGroup(p, state.now) === 'active');
  // A parent lists every child it still has, snoozed or parked ones included (shown dimmed with their state), so the
  // nesting stays visible while a child is away. Only finished children drop out.
  const kids = (key) => all.filter((p) => p.parent === key && !p.finishedAt);
  const projects = active.filter((p) => !p.parent).map((p) => ({ kind: 'project', id: p.id, key: `project:${p.id}`, name: p.name, project: p, children: kids(`project:${p.id}`) }));
  const agents = agentsOf(state.lists, state.now);
  // An agent that owns a project lists even before it has a conversation on the desk.
  for (const p of all.filter((q) => !q.finishedAt)) {
    const parent = parentOf(p);
    if (parent?.kind === 'agent' && !agents.some((a) => a.id === parent.id)) agents.push({ id: parent.id, name: agentLabel(parent.id), open: 0, needs: 0 });
  }
  agents.sort((a, b) => a.name.localeCompare(b.name));
  return { projects, agents: agents.map((a) => ({ kind: 'agent', id: a.id, key: `agent:${a.id}`, name: a.name, children: kids(`agent:${a.id}`) })) };
}

/** Reporting destinations in sidebar order, with conversations attached to each place. */
export function ownerPlaces(state, { self = null } = {}) {
  const projects = state.projects || [];
  const agents = sidebarPlaces(state).agents;
  const nested = nestedProjectList(projects, agents);
  const place = (section, space, label, extra = {}) => ({ section, space, label, ...extra,
    owners: ownerChoices(state.lists, space, projects, { self }) });
  const project = (p, section) => place(section, { kind: 'project', id: p.project.id }, p.label, { project: p.project });
  return [
    ...nested.filter((p) => !p.project.parent?.startsWith('agent:')).map((p) => project(p, 'Projects')),
    ...agents.flatMap((a) => [place('Agents', { kind: 'agent', id: a.id }, a.name, { agent: a }),
      ...nested.filter((p) => p.project.parent === `agent:${a.id}`).map((p) => project(p, 'Agents'))]),
    place(null, null, 'No project'),
  ];
}

/**
 * A sidebar place's count and hover breakdown. Open, its own conversations; closed, the roll-up of its own and its
 * children's, and the breakdown lists "here" then each child with its numbers (`nest`). Counts follow what you can see.
 */
export function placeTally(place, open, { projects = [], isOpen = false, now = Date.now() } = {}) {
  const own = tallyOf(open.filter(ownMatch(place.kind, place.id, projects)), now);
  if (!place.children.length || isOpen) return { tally: own, lines: breakdownOf(own), nest: null };
  const children = place.children.map((c) => ({ project: c, tally: tallyOf(open.filter(ownMatch('project', c.id, projects)), now) }));
  const sum = (key) => own[key] + children.reduce((n, c) => n + c.tally[key], 0);
  const by = Object.fromEntries(TALLY.map(([key]) => [key, own.by[key] + children.reduce((n, c) => n + c.tally.by[key], 0)]));
  const tally = { waiting: sum('waiting'), active: sum('active'), by };
  return { tally, lines: breakdownOf(tally), nest: [{ label: 'here', waiting: own.waiting, active: own.active, here: true }, ...children.map((c) => ({ label: c.project.name, waiting: c.tally.waiting, active: c.tally.active, ...(awayWord(c.project, now) ? { away: awayWord(c.project, now) } : {}) }))] };
}

/**
 * Where a project can go (Space settings' Inside, the project dialog, ⋯ → Move into): the person's own space, an open
 * top-level project, or an agent. Two levels: a project that holds open projects stays at the top.
 */
export function parentChoices(project, projects = [], agents = []) {
  const holds = project ? childProjects(`project:${project.id}`, projects).length > 0 : false;
  const top = { value: null, label: 'Your space' };
  if (holds) return [top];
  const out = [
    top,
    ...projects.filter((p) => p.id !== project?.id && !p.parent && !p.finishedAt).map((p) => ({ value: `project:${p.id}`, label: p.name, kind: 'project', project: p })),
    ...agents.map((a) => ({ value: `agent:${a.id}`, label: a.name, kind: 'agent', agent: a })),
  ];
  // Where it is now is always a choice, even an agent with nothing on the desk yet.
  const parent = parentOf(project);
  if (parent && !out.some((c) => c.value === project.parent)) out.push(parent.kind === 'agent' ? { value: project.parent, label: agentLabel(parent.id), kind: 'agent', agent: { id: parent.id, name: agentLabel(parent.id) } } : { value: project.parent, label: projects.find((p) => p.id === parent.id)?.name || parent.id, kind: 'project' });
  return out;
}

/**
 * The open projects in the order a "Move to project" menu lists them: each top-level one, then the ones inside it,
 * named with their parent ("Tango › Desk", "Sierra › Bike"), so a parent and its children are both choices.
 */
export function nestedProjectList(projects = [], agents = []) {
  const open = (projects || []).filter((p) => !p.finishedAt);
  const named = (p) => {
    const crumb = parentCrumb(p, projects, agents);
    return { project: p, label: crumb ? `${crumb} › ${p.name}` : p.name };
  };
  const out = [];
  for (const p of open.filter((q) => !q.parent || !open.some((r) => `project:${r.id}` === q.parent))) {
    if (p.parent?.startsWith('agent:')) continue;
    out.push(named(p), ...open.filter((c) => c.parent === `project:${p.id}`).map(named));
  }
  // An agent's projects at the end, under their agent's name.
  return [...out, ...open.filter((p) => p.parent?.startsWith('agent:')).map(named)];
}

/** A selection never carries hidden rows into the next bulk action. Uses the same rows voice reads. */
export function reconcileSelection(state) {
  const selection = state.nextSelect;
  if (!selection || !state.nextRoute) return selection;
  const visible = new Set(nextListReport(state).rows.map((row) => row.id));
  const ids = selection.ids.filter((id) => visible.has(id));
  const anchor = visible.has(selection.anchor) ? selection.anchor : null;
  return ids.length === selection.ids.length && anchor === selection.anchor ? selection : { ...selection, ids, anchor };
}

/**
 * Each group's rows in drawn order (`rows`): its top-level rows, each followed by what reports to it while the owner
 * has that lead open (`workersOpen`). A row nested under another group's lead isn't in its own group's rows.
 */
export function shownRows(groups, state) {
  const candidates = ['active', 'snoozed', 'history'].flatMap((key) => state.lists?.[key]?.items || []);
  const trees = new Map(nestedRows(groups.flatMap((g) => g.items), candidates).map((tree) => [tree.item.id, tree]));
  const open = state.workersOpen || [];
  const walk = (tree) => [tree.item, ...(open.includes(tree.item.id) ? tree.children.flatMap(walk) : [])];
  return groups.map((g) => ({ ...g, trees: g.items.filter((i) => trees.has(i.id)).map((i) => trees.get(i.id)), rows: g.items.filter((i) => trees.has(i.id)).flatMap((i) => walk(trees.get(i.id))) }));
}

/** Worker placement comes only from the role graph. Cycles and absent parents stay as roots. */
export function nestedRows(roots, candidates) {
  const byId = new Map([...candidates, ...roots].map(item => [item.id, item]));
  const layer = item => item.disposition === 'done' ? 'done' : ['snoozed', 'parked'].includes(item.disposition) ? 'later' : 'active';
  const children = item => [...byId.values()].filter(child => child.facts?.parentItemId === item.id && ['worker', 'ops'].includes(child.facts?.role) && child.status?.audience === 'lead' && layer(child) === layer(item));
  const covered = new Set();
  const walk = (item, path) => {
    const next = new Set([...path, item.id]);
    return { item, children: children(item).filter(child => !next.has(child.id)).map(child => { covered.add(child.id); return walk(child, next); }) };
  };
  const trees = roots.map(item => walk(item, new Set()));
  const top = trees.filter(tree => !covered.has(tree.item.id));
  return top.length ? top : roots.map(item => ({ item, children: [] }));
}
