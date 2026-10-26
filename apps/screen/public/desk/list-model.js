// The List view's logic (list.js), kept free of the DOM so it can be tested.
//
// One column of what needs the owner, grouped by desk labels. Each row keeps
// the conversation’s name and one paragraph. Labels live in the desk facts.

import { personaId, itemRepo } from './query-identity.js';
import { STALL_MS, isFresh, toMs, unansweredSince } from './util.js';

// Types belong to the owner and are kept on the desk.
// The `project` type reads Epic: the bigger pieces of work. Projects are the owner's folders (projectOf).
export const TYPES = [
  ['project', 'Epic', 'Epics'],
  ['feat', 'Feature', 'Features'],
  ['bug', 'Bug', 'Bugs'],
  ['enh', 'Enhancement', 'Enhancements'],
  ['chore', 'Chore', 'Chores'],
  ['ops', 'Ops', 'Ops'],
  ['skill', 'Skill', 'Skills'],
];
const TYPE_KEYS = TYPES.map(([key]) => key);
/** The old Loom title prefixes, stripped from a thread's name wherever a title still has one. */
const OLD_PREFIX_RE = /^(epic|disc|bug|fix|feat|enh|chore|ops|skill|watch|hold):\s*/i;

export const typeName = (key) => TYPES.find(([k]) => k === key)?.[1] ?? key;
export const typeOf = (item) => (TYPE_KEYS.includes(item?.facts?.type) ? item.facts.type : null);
export const MENU_TYPES = TYPE_KEYS;

/** Remaining list sections; pinned always stays on top. */
export const SECTION_KEYS = ['chat', 'none'];

/** A section heading or a type plural. */
export function sectionName(key) {
  if (key === 'pinned') return 'Pinned';
  if (key === 'chat') return 'Chats';
  if (key === 'none') return 'Conversations';
  if (key === 'untyped') return 'No type';
  return TYPES.find(([k]) => k === key)?.[2] ?? key;
}

/** The owner's order, completed: unknown names dropped, a section it doesn't name after it in the default order. */
export function labelOrderOf(order) {
  const known = [...new Set((Array.isArray(order) ? order : []).filter((key) => SECTION_KEYS.includes(key)))];
  return [...known, ...SECTION_KEYS.filter((key) => !known.includes(key))];
}

/** The order with one section moved from one place to another (the Label order dialog's drag and arrows). */
export function moveSection(order, from, to) {
  const next = [...order];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next;
  const [key] = next.splice(from, 1);
  next.splice(to, 0, key);
  return next;
}

/**
 * The tabs across the top. Active is everything in the owner's rotation, newest activity first, with
 * no guessed next-step split (Needs you / Working / Watching / FYI were the summarizer's calls, and
 * not reliable enough to sort by). The owner's filters (Settings) hide what they don't want there.
 */
export const TABS = [['needs', 'Needs you'], ['active', 'Active'], ['later', 'Later'], ['done', 'Done']];

/** A tab saved by an earlier version of the List (Needs you, Working, …) opens Active. */
export function knownTab(tab) {
  return TABS.some(([key]) => key === tab) ? tab : 'active';
}

export const GROUPINGS = [
  ['project', 'Project'],
  ['workspace', 'Workspace'],
  ['live', 'Live state'],
  ['none', 'None'],
];

/** Live-state sections, in the order they matter to the owner. */
const LIVE_NAMES = { failed: 'Failed', stuck: 'Stuck', needs: 'Needs you', finished: 'Finished', working: 'Working', waiting: 'Waiting', idle: 'Idle', unknown: 'Unknown' };

/** Unknown or retired groupings fall back to live state. */
export function knownGrouping(grouping) {
  return GROUPINGS.some(([key]) => key === grouping) ? grouping : 'live';
}

// A coding thread (Loom): titled by its place, grouped by its repo's workspace.
const isLoom = (item) => item?.source === 'loom';
/** The one project section every Tango agent shares when a view groups them together. */
const AGENTS_KEY = 'agents';

/** A Loom thread's own title (the part of `place` after the project). */
function threadTitle(item) {
  const place = String(item?.place || '');
  const at = place.indexOf(' · ');
  return at >= 0 ? place.slice(at + 3) : place;
}

/**
 * The row's name, which stays put while the summary changes: a Loom thread's title (without an old
 * prefix), a Discord thread's name, or for a chat, what the conversation is about. A name the owner
 * gave it on the desk comes first (Loom threads are renamed in Loom, so theirs is the title).
 */
export function rowTitle(item) {
  if (item?.facts?.name && !isLoom(item)) return item.facts.name;
  if (isLoom(item)) return threadTitle(item).replace(OLD_PREFIX_RE, '') || item.summary?.title || 'Loom thread';
  if (item?.kind === 'chapter') return item.summary?.about || item.summary?.title || `Chat with ${item.agentName}`;
  return item?.place || item?.summary?.about || item?.summary?.title || item?.agentName || '';
}

/** Where it lives, said quietly next to the age: the repo for Loom, the agent otherwise. */
export function rowWhere(item) {
  return isLoom(item) ? itemRepo(item) || '' : item?.agentName || '';
}

/** Active items the owner's filters hide (the Everything list marks them), for "show hidden". */
export function hiddenActive(lists) {
  // Only what the owner's filters hide: an item the inbox rules hide stays hidden (Codex review on #488).
  return (lists.everything?.items || []).filter((item) => item.disposition === 'active' && !item.hidden && item.filteredBy?.length);
}

/** The tab's items, from the lists the desk already loads. Active can add back what the filters hide. */
/**
 * What an item is doing right now. Needs, working
 * and failed come from what the source reports; watching also takes the desk's own derived waits:
 * - `needs`: a request waiting on the owner (a Loom question or approval);
 * - `working`: a turn or session running, or active background tasks;
 * - `failed`: the source reports a failed turn;
 * - `watching`: background work left that reports back (a running background job), or a wait
 *   the desk derived (a PR review, a teammate or another agent the agent named, a promised check-back);
 * - `needs` too when the desk read an ask in the agent's words (a "Next — you" line, a recorded ask, a summary's
 *   question) and the owner hasn't read it yet (new or updated); `ready`: the same once they have (opened it, heard
 *   it): their turn, nothing happening, no rush;
 * - `todo`: the agent handed the owner an action in the world (buy, call, install), or an ask past the date it
 *   named: theirs, on the To-dos list, never the pill (owner, 10/18);
 * - `fyi`: the agent spoke last, asked nothing, and nothing is happening: a finished update. Unread it is bold on
 *   the row; it is never the owner's move (owner, 10/18);
 * - `failed` too when the owner spoke last and no run started within STALL_MS: a message nobody picked up;
 * - `held` instead when the source says why it is holding that message (Loom: disk low, limits, maintenance);
 * - null only in that grace (just sent) or before the desk has read the thread at all.
 */
export { STALL_MS };
/**
 * Waiting on a PR review: the desk has it Watching because of one (its basis), which already reads each PR on its
 * own (a decision the agent answered no longer counts). A stalled wait turns back to the owner and reads Ready.
 */
export function inReview(item) {
  return item?.nextStep === 'watching' && item.nextStepBasis === 'source:pr-review';
}

/** What a Watching row says it waits on: "in review", "waiting on Desk", or plain "watching". */
export function watchingLabel(item) {
  if (inReview(item)) return 'in review';
  const wait = item?.facts?.inFlight?.find((entry) => entry.kind === 'wait');
  if (wait?.text) return `watching ${wait.text.length > 40 ? `${wait.text.slice(0, 39)}…` : wait.text}`;
  const who = item?.watching?.waitingOn?.who;
  return who ? `waiting on ${who.length > 24 ? `${who.slice(0, 23)}…` : who}` : 'watching';
}

/**
 * Whether the agent is busy, the row's dot: `working` (a turn runs now), `background` (only background work or a
 * background job left), or null. The server's word (item.status, desk/status.ts); older payloads read the facts.
 */
export function busyOf(item) {
  if (item?.status) return item.status.busy ?? null;
  const f = item?.facts || {};
  return f.running ? 'working' : f.background === 'working' || f.job ? 'background' : null;
}

/** A to-do the agent handed the owner, or an ask past the date it named (desk/asks.ts): the To-dos list's. */
export function isTodo(item) {
  const ask = item?.askRecord;
  return !!ask && ((ask.kind === 'todo' && ask.state === 'open') || ask.state === 'expired');
}

const HELD = { recovery_unhealthy: 'recovery backup unhealthy', disk_low: 'disk low', memory: 'memory low', host_cap: 'too many sessions open', waiting_for_room: 'Loom is out of room', account_limit: 'account limits', budget: 'daily budget, resumes at midnight', maintenance: 'maintenance', queued: 'Loom will start it shortly' };

/** Why a held message waits, as the pill says it ("disk low", "account limits until 2:00 PM"). */
export function heldLabel(item) {
  const held = item?.facts?.held;
  if (!held) return null;
  const why = HELD[held.reason] || 'Loom is holding new turns';
  if (held.reason === 'budget') return why;
  return held.until && held.until > Date.now() ? `${why} until ${new Date(held.until).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : why;
}

export function liveState(item, now = Date.now()) {
  return item?.status?.pill ?? 'unknown';
}

/** The same recorded predicate used by server counts, voice and catch-up. */
export function wantsOwner(item, now = Date.now()) {
  return item?.status?.countsForOwner === true;
}

export function tabItems(lists, tab, { showHidden = false } = {}) {
  const active = lists.active?.items || [];
  const snoozed = lists.snoozed?.items || [];
  switch (tab) {
    case 'active':
      return showHidden ? [...active, ...hiddenActive(lists).map((item) => ({ ...item, hiddenByFilter: true }))] : active;
    case 'needs':
      return active.filter(wantsOwner);
    case 'later':
      return snoozed;
    case 'done':
      return lists.history?.items || [];
    case 'ready':
      // Back with the owner: an explicit request first, or the agent done and waiting.
      return active.filter((item) => ['needs', 'finished', 'stuck', 'idle', 'failed'].includes(liveState(item)));
    case 'working':
      // The busy dot: a thread that asked the owner something while it works is here too.
      return active.filter((item) => busyOf(item) !== null);
    case 'watching':
      return active.filter((item) => liveState(item) === 'waiting');
    case 'snoozed':
      return snoozed.filter((item) => item.disposition !== 'parked');
    case 'parked':
      return snoozed.filter((item) => item.disposition === 'parked');
    case 'history':
      return lists.history?.items || [];
    default:
      return [];
  }
}


/**
 * When an item is back in front of the owner, as [tier, time] to sort by: anything not away is back
 * already, then snoozes with a time (soonest first; a time beside a trigger is the latest it wakes),
 * then snoozes that wait on an event (the desk, the agent posting), then parked, which waits on the agent's news with no other way back.
 */
export function wakeOrder(item) {
  if (item.disposition === 'parked') return [3, 0];
  if (item.disposition !== 'snoozed') return [0, 0];
  const at = toMs(item.snoozeUntil);
  return Number.isFinite(at) ? [1, at] : [2, 0];
}

/**
 * When the owner last wrote in a conversation (or when it started, if they never have): the List's
 * order. Agent activity moves nothing, so rows hold still while the owner reads and taps.
 */
export function ownerOrderAt(item) {
  return item.lastOwnerMessageAt || item.createdAt || item.lastActivityAt || 0;
}

/**
 * Inside a section: the owner's latest message first. History: most recently done first. `oldest` (this device's
 * sort pick) turns the time order around so the threads left longest come up first; requests first and
 * soonest back still lead.
 */
export function sortRows(items, tab, { oldest = false } = {}) {
  // `tab` is a sort mode now: 'history', 'asks' (requests first; the old Ready tab), 'wake' (soonest back first), or newest first.
  const asks = (item) => ((tab === 'asks' || tab === 'ready') && ['needs', 'failed', 'stuck'].includes(liveState(item)) ? 1 : 0);
  const wake = (a, b) => {
    if (tab !== 'wake') return 0;
    const [ta, wa] = wakeOrder(a);
    const [tb, wb] = wakeOrder(b);
    return ta - tb || wa - wb;
  };
  const dir = oldest ? -1 : 1;
  return [...items].sort((a, b) =>
    tab === 'history'
      ? dir * ((b.doneAt || b.lastActivityAt || 0) - (a.doneAt || a.lastActivityAt || 0))
      : wake(a, b) || asks(b) - asks(a) || dir * (ownerOrderAt(b) - ownerOrderAt(a)),
  );
}

/** Sections under Pinned, grouped by repository, project, live state or type. */
export function sectionsOf(items, grouping, tab, labelOrder, { agentsTogether = false, projects = [], oldest = false } = {}) {
  const g = tab === 'active' ? 'live' : knownGrouping(grouping);
  const pinned = g === 'live' ? [] : items.filter(isPinned);
  const top = pinned.length ? [{ key: `${g}:pinned`, label: sectionName('pinned'), pinned: true, items: sortRows(pinned, tab, { oldest }) }] : [];
  const rest = pinned.length ? items.filter((item) => !isPinned(item)) : items;
  if (g === 'none') return [...top, ...(rest.length ? [{ key: 'all', label: top.length ? 'Everything else' : null, items: sortRows(rest, tab, { oldest }) }] : [])];
  const keyOf = {
    // Every Tango agent in one section after the workspaces, when the view asks for it.
    workspace: (item) => (agentsTogether && !isLoom(item) ? AGENTS_KEY : `w:${rowWhere(item) || 'other'}`),
    project: (item) => projectOf(item, projects)?.id ?? NO_PROJECT,
    // No live state is only a message the owner just sent, waiting for a run to start.
    live: (item) => liveState(item) ?? 'sent',
    type: (item) => typeOf(item) || 'untyped',
  }[g];
  const nameOf = (key) => (g === 'workspace' ? (key === AGENTS_KEY ? 'Tango agents' : key.slice(2)) : g === 'project' ? (projects.find((p) => p.id === key)?.name ?? 'No project') : g === 'live' ? LIVE_NAMES[key] : sectionName(key));
  const order = g === 'workspace' ? null : g === 'project' ? [...projects.map((p) => p.id), NO_PROJECT] : g === 'live' ? Object.keys(LIVE_NAMES) : g === 'type' ? [...TYPE_KEYS, 'untyped'] : labelOrderOf(labelOrder);
  const groups = new Map();
  for (const item of rest) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const keys = order ? order.filter((key) => groups.has(key)) : [...groups.keys()].sort((a, b) => (a === AGENTS_KEY) - (b === AGENTS_KEY) || a.localeCompare(b));
  return [...top, ...keys.map((key) => ({ key: `${g}:${key}`, label: nameOf(key), items: sortRows(groups.get(key), tab, { oldest }) }))];
}

/** Pinned (in Loom's sidebar, or on the desk): the List shows it first, above project folders and every section. */
export const isPinned = (item) => !!item?.facts?.pinned;

// ── projects: the owner's folders of related conversations ──

const NO_PROJECT = '~none';

/** The owner's project an item is in (facts.projectId), or null; a deleted project's id is no project. */
export function projectOf(item, projects = []) {
  const id = item?.facts?.projectId;
  return id ? projects.find((p) => p.id === id) || null : null;
}

/** A project's own state, apart from its conversations': in rotation, snoozed, or parked (Snooze and Park set `away`). */
export const PROJECT_STATES = [
  ['active', 'Active'],
  ['snoozed', 'Snoozed'],
  ['parked', 'Parked'],
];
/** Where an open project is: parked, snoozed (until a time that hasn't come, or until something happens), else active. */
export function projectState(project, now = Date.now()) {
  const away = project?.away;
  if (!away) return 'active';
  if (away.state === 'parked') return 'parked';
  return away.until != null && away.until <= now ? 'active' : 'snoozed';
}

/** A project's tile: its icon (or first letter) in its color. */
export function projectTile(project) {
  return { icon: project?.icon || null, color: ICON_COLORS[project?.color] || ICON_COLORS.slate, letter: (project?.name || '?')[0].toUpperCase(), title: project?.name || '' };
}

// ── icons: Loom's project icons, and the owner's (or a default) icon per agent ──

/** Tailwind's 400 shades, the colors Loom offers for a project icon (readable on the dark desk). */
export const ICON_COLORS = {
  slate: '#94a3b8',
  gray: '#9ca3af',
  zinc: '#a1a1aa',
  neutral: '#a3a3a3',
  stone: '#a8a29e',
  red: '#f87171',
  orange: '#fb923c',
  amber: '#fbbf24',
  yellow: '#facc15',
  lime: '#a3e635',
  green: '#4ade80',
  emerald: '#34d399',
  teal: '#2dd4bf',
  cyan: '#22d3ee',
  sky: '#38bdf8',
  blue: '#60a5fa',
  indigo: '#818cf8',
  violet: '#a78bfa',
  purple: '#c084fc',
  fuchsia: '#e879f9',
  pink: '#f472b6',
  rose: '#fb7185',
};

/** A starting icon per agent, picked from its role; the owner changes any of them in Settings. */
export const AGENT_ICON_DEFAULTS = {
  watson: { icon: 'briefcase', color: 'blue' },
  sierra: { icon: 'compass', color: 'amber' },
  victor: { icon: 'clipboard-list', color: 'violet' },
  malibu: { icon: 'dumbbell', color: 'emerald' },
  papa: { icon: 'feather', color: 'indigo' },
  foxtrot: { icon: 'wallet', color: 'orange' },
  juliet: { icon: 'heart-handshake', color: 'pink' },
  charlie: { icon: 'map-pin', color: 'cyan' },
  piper: { icon: 'lightbulb', color: 'yellow' },
  'cod-e': { icon: 'code-xml', color: 'sky' },
  kilo: { icon: 'piggy-bank', color: 'lime' },
  jules: { icon: 'leaf', color: 'green' },
  delta: { icon: 'rocket', color: 'teal' },
  echo: { icon: 'music', color: 'teal' },
  mike: { icon: 'mic', color: 'teal' },
  oscar: { icon: 'film', color: 'teal' },
};

/** An agent's id without its runtime suffix (sierra-ollama is Sierra). */
export function baseAgent(agentId) {
  return personaId(agentId);
}

/** A coding thread (Loom): it belongs to a project or a repo, never to an "agent". */
export const isCoding = (item) => item?.source === 'loom';

/** The repo a coding thread runs in: Loom's workspace, else the thread's area. */
export function repoOf(item) {
  return itemRepo(item);
}

/** The owner's icon and color for a repo (Settings › Repos), kept by its name in lower case; null: none set. */
export function repoIconOf(repo, repoIcons = {}) {
  return (repo && repoIcons?.[repo.toLowerCase()]) || null;
}

/**
 * The row's tile: `{ icon, color, letter }`. A coding thread shows its repository's icon, else the
 * owner's icon for its repo; another item shows its agent's icon (the owner's choice, else the
 * default). No icon: a letter.
 */
export function tileFor(item, agentIcons = {}, repoIcons = {}) {
  if (isCoding(item)) {
    const p = item.facts?.project;
    const name = repoOf(item) || 'Loom';
    const look = p?.icon ? p : repoIconOf(name, repoIcons) || p;
    return { icon: look?.icon || null, color: ICON_COLORS[look?.color] || ICON_COLORS.slate, letter: name[0]?.toUpperCase() || 'T', title: name };
  }
  const agent = baseAgent(item?.agentId);
  const chosen = agentIcons[agent] || AGENT_ICON_DEFAULTS[agent] || null;
  return {
    icon: chosen?.icon || null,
    color: (chosen?.color && ICON_COLORS[chosen.color]) || null, // null: the agent's desk color
    letter: (item?.agentName || agent || '?')[0].toUpperCase(),
    title: item?.agentName || agent,
  };
}

/**
 * Whether a row takes Done and Snooze: anything still open (Active, Snoozed or Parked), so every tab
 * acts the same; a snoozed row's Snooze changes when it comes back. Not History (already done), and
 * not a running turn (Done mid-turn would settle a running Loom thread; Codex review on #485).
 */
export function canActOnRow(item, now = Date.now()) {
  // A message nobody picked up reads Failed while the server still calls it working: Done and Snooze apply (Codex review on #507).
  return !!item && ['active', 'snoozed', 'parked'].includes(item.disposition ?? 'active') && (item.nextStep !== 'working' || liveState(item, now) === 'failed');
}

// ── phone swipes: right is Done; left reveals More and Snooze ──

export const ROW_SWIPE = { reveal: 40, doneOpen: 84, leftOpen: 156, oneButton: 78, commitRight: 0.5, commitLeft: 0.6 };

/** What letting go does: commit an action, hold a side open, or snap back. */
export function releaseRow(dx, width) {
  if (dx > width * ROW_SWIPE.commitRight) return { action: 'done' };
  if (dx < -width * ROW_SWIPE.commitLeft) return { action: 'snooze' };
  if (dx > ROW_SWIPE.reveal) return { open: ROW_SWIPE.doneOpen };
  if (dx < -ROW_SWIPE.reveal) return { open: -ROW_SWIPE.leftOpen };
  return { open: 0 };
}
