// Where a thread started by voice lives, and which thread a space's name means.
//
// New threads follow the desk's floating + (apps/screen/public/desk/next/app.js Fab): with a
// thread open, the same place as that thread; on a project page, that project and its repo; on an
// agent's page, a thread with that agent. The Inbox with nothing named settles nothing: the operator
// asks. Naming a space (a project) never means its lead: the thread named wins, and a space named
// alone with several threads in it is a question.

import type { DeskItemSummary } from './desk-client.js';
import type { ListPage } from './screen-director.js';
import type { OperatorAction } from './task-extractor.js';

/** Where a new thread starts when the owner didn't say: the screen's place, read like the + button. */
export interface StartPlace {
  /** thread: a conversation is open; project / agent: that page is up. */
  from: 'thread' | 'project' | 'agent';
  projectId?: string;
  projectName?: string;
  /** A thread with this agent. */
  agentId?: string;
  agentName?: string;
  /** A coding thread in this repo (the project's, or the open coding thread's). */
  repo?: string;
}

const isCoding = (item: Pick<DeskItemSummary, 'id' | 'source'>) => item.source === 'loom' || /^loom:/.test(item.id);

/** A coding item's repo: its area, else the part of its place before " · ". */
export function repoOf(item: Pick<DeskItemSummary, 'area' | 'place'>): string | null {
  if (item.area) return item.area;
  const place = item.place ?? '';
  return place.includes(' · ') ? place.slice(0, place.indexOf(' · ')) : null;
}

/**
 * A project's repo, as the desk's Start work sheet settles it (store.js projectRepo): the repo of the
 * project's most recently active coding thread, when Start work offers that repo.
 */
export function projectRepo(items: DeskItemSummary[], projectId: string, repos: string[] | null): string | null {
  const offered = (repo: string | null) => !!repo && (!repos || repos.some((candidate) => candidate.toLowerCase() === repo.toLowerCase()));
  const latest = items
    .filter((item) => item.facts?.projectId === projectId && isCoding(item) && offered(repoOf(item)))
    .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))[0];
  if (!latest) return null;
  const repo = repoOf(latest)!;
  return repos?.find((candidate) => candidate.toLowerCase() === repo.toLowerCase()) ?? repo;
}

export interface StartPlaceInput {
  /** The item open on the screens (Conversation, Screen or Prototype view), if any. */
  open: DeskItemSummary | null;
  /** Whether the open item is an agent's (else a coding thread or another source). */
  openAgent?: { id: string; name: string } | null;
  /** The page the screen's List reports. */
  page?: ListPage['place'] | null;
  /** Project names by id (the List's projects, and the projects items are filed under). */
  projectNames: Map<string, string>;
  agents: Array<{ id: string; name: string }>;
  items: DeskItemSummary[];
  /** The repos Start work offers (null: unknown). */
  repos: string[] | null;
}

/** The place a new thread starts, or null when the screen doesn't settle it (the Inbox, Projects, Agents). */
export function startPlace(input: StartPlaceInput): StartPlace | null {
  const { open, page } = input;
  const project = (id: string | null | undefined) => (id ? { projectId: id, ...(input.projectNames.get(id) ? { projectName: input.projectNames.get(id)! } : {}) } : {});
  if (open) {
    const projectId = open.facts?.projectId ?? null;
    if (input.openAgent) return { from: 'thread', agentId: input.openAgent.id, agentName: input.openAgent.name, ...project(projectId) };
    if (isCoding(open)) {
      const repo = repoOf(open);
      if (repo || projectId) return { from: 'thread', ...(repo ? { repo } : {}), ...project(projectId) };
    }
    if (projectId) return { from: 'thread', ...project(projectId), ...withRepo(input, projectId) };
    return null;
  }
  if (page?.page === 'project' && page.id) return { from: 'project', ...project(page.id), ...(input.projectNames.get(page.id) ? {} : { projectName: page.name }), ...withRepo(input, page.id) };
  if (page?.page === 'agent' && page.id) {
    const agent = input.agents.find((candidate) => candidate.id === page.id);
    return { from: 'agent', agentId: page.id, agentName: agent?.name ?? page.name };
  }
  return null;
}

function withRepo(input: StartPlaceInput, projectId: string): { repo?: string } {
  const repo = projectRepo(input.items, projectId, input.repos);
  return repo ? { repo } : {};
}

/** "the Tango Voice project, in tango", "Sierra's page", for the router and draft prompts. */
export function describeStartPlace(place: StartPlace | null): string {
  if (!place) return 'nothing settles it (the Inbox, or a page that is not one project or agent)';
  const project = place.projectName ? ` under the ${place.projectName} project` : '';
  const from = place.from === 'thread' ? 'the open thread' : place.from === 'project' ? 'the project page' : "the agent's page";
  if (place.agentId) return `a thread with ${place.agentName ?? place.agentId}${project} (from ${from})`;
  if (place.repo) return `a coding thread in ${place.repo}${project} (from ${from})`;
  return `${project.trim() || 'somewhere unclear'}, but no repo or agent is settled (from ${from})`;
}

// ── a space named alone ──────────────────────────────────────────────────

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'for', 'to', 'in', 'on', 'with', 'thread', 'project', 'space', 'about', 'it', 'that', 'this', 'is', 'my', 'our']);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word && !STOP.has(word));
}

/** An item's title: its place after " · ", without a "bug:"-style prefix. */
function titleOf(item: Pick<DeskItemSummary, 'place'>): string {
  const place = item.place ?? '';
  return (place.includes(' · ') ? place.slice(place.indexOf(' · ') + 3) : place).replace(/^[a-z]{2,10}:\s*/i, '');
}

export interface SpaceItem {
  handle: string;
  id: string;
  place: string | null;
  about?: string | null;
  projectId: string | null;
  role?: string | null;
}

/**
 * The router sent words to a thread in a project, or to an agent the owner never named, but the owner
 * named only the project ("tell Tango Voice to…"): not its lead, nor any one thread, when the project
 * has several. Then the action becomes an ask naming them; a thread named by its own words ("the Tango
 * Voice lead", "the regression sweep") stands, and so does a project with one thread.
 * `resolve`: the item an action sends to (null for none); `unnamedAgent`: a dispatch to an agent the
 * owner didn't name.
 */
export function askWhenOnlySpaceNamed(
  speech: string,
  actions: OperatorAction[],
  items: SpaceItem[],
  projects: Map<string, string>,
  resolve: (action: OperatorAction) => string | null,
  unnamedAgent: (action: OperatorAction) => boolean = () => false,
): OperatorAction[] {
  const said = new Set(words(speech));
  const lower = ` ${speech.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ')} `;
  // The project named as a phrase.
  const named = (projectId: string) => {
    const nameWords = words(projects.get(projectId) ?? '');
    return nameWords.length > 0 && lower.includes(` ${nameWords.join(' ')} `);
  };
  const ask = (projectId: string): OperatorAction | null => {
    const siblings = items.filter((candidate) => candidate.projectId === projectId);
    if (siblings.length < 2) return null;
    const name = projects.get(projectId)!;
    const options = siblings.slice(0, 3).map((candidate) => `"${titleOf(candidate) || candidate.place}"`);
    return { type: 'ask', question: `Which ${name} thread: ${options.join(', ')}${siblings.length > 3 ? ', or another' : ''}?`, reason: `only the ${name} space was named` };
  };
  const asked = actions.map((action): OperatorAction => {
    const itemId = resolve(action);
    const item = itemId ? items.find((candidate) => candidate.id === itemId) : undefined;
    if (!item) {
      // Words for an agent nobody named, while the owner named a space: which of its threads?
      if (!unnamedAgent(action)) return action;
      const spaces = [...projects.keys()].filter((id) => named(id) && items.some((candidate) => candidate.projectId === id));
      return spaces.length === 1 ? (ask(spaces[0]!) ?? action) : action;
    }
    if (!item.projectId || !projects.get(item.projectId) || !named(item.projectId)) return action;
    // Its own words beyond the project's name ("lead", "regression sweep") name the thread.
    const nameWords = words(projects.get(item.projectId)!);
    const own = new Set(words(titleOf(item)).filter((word) => !nameWords.includes(word)));
    if (item.role === 'default') own.add('lead');
    if ([...own].some((word) => said.has(word))) return action;
    return ask(item.projectId) ?? action;
  });
  return asked.some((action, index) => action !== actions[index]) ? asked : actions;
}

// ── "start a new thread", whatever the router made of it ─────────────────

/**
 * "Start a (new) thread", "kick off another thread", or a command that opens with "new Loom thread": the
 * owner asked to create one. Not "what's new in the billing thread" or "open the new migration thread"
 * (Codex review on #714).
 */
const NEW_THREAD_CUE = /\b(?:start|kick off|spin up|create|begin|open|make)\s+(?:up\s+)?(?:a|an|another)\s+(?:new\s+)?(?:\w+\s+){0,2}?thread\b|^\W*(?:(?:okay|ok|so|please|yankee|hey|can you|could you)\W+)*(?:a\s+)?new\s+(?:loom|coding)\s+thread\b/i;
const CODING_CUE = /\b(?:loom|coding thread)\b/i;

/**
 * "Start a new thread to …" that the router sent as a dispatch to something that isn't an agent the
 * owner named ("loom" with no title, a repo, the chief of staff): a new-thread draft instead, which the
 * screen's place settles or the owner is asked about (a coding draft when they said Loom or a
 * repo). An agent the owner named keeps the router's dispatch, and so does a name not on the roster
 * (the operator asks who that is).
 */
export function preferNewThread(speech: string, actions: OperatorAction[], agents: Array<{ id: string; names: string[] }>, repos: string[]): OperatorAction[] {
  if (!NEW_THREAD_CUE.test(speech)) return actions;
  if (actions.filter((action) => action.type === 'dispatch').length !== 1) return actions;
  const lower = ` ${speech.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ')} `;
  const said = (name: string) => lower.includes(` ${name.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim()} `);
  const isRepo = (id: string) => repos.some((repo) => repo.toLowerCase() === id.toLowerCase());
  let changed = false;
  const next = actions.map((action): OperatorAction => {
    if (action.type !== 'dispatch' || action.threadId) return action;
    const agent = agents.find((candidate) => candidate.id === action.agentId);
    if (agent && agent.names.some(said)) return action;
    const sentinel = /^(?:loom)(?:-|$)/.test(action.agentId) || isRepo(action.agentId) || !action.agentId || action.agentId === 'new';
    // A name not on the roster ("with Alice") is asked about, never settled by the screen.
    if (!agent && !sentinel) return action;
    changed = true;
    const coding = /^(?:loom)(?:-|$)/.test(action.agentId) || isRepo(action.agentId) || CODING_CUE.test(speech) || repos.some(said);
    return { type: 'draft', op: 'start', agentId: coding ? 'loom' : 'new', ...(action.message ? { message: action.message } : {}) };
  });
  return changed ? next : actions;
}

/**
 * A compile question about where a new thread goes, which the screen's place already answered ("Which
 * repo?", "In tango, or with Watson?", "Where should it start?"). Only those forms: a question about the
 * task that names a repo or project ("Which project requirements should it keep?") still gets asked
 * (Codex review on #714).
 */
export function asksWhere(question: string): boolean {
  const q = question.trim();
  return (
    /^(?:which|what) repo\b/i.test(q) ||
    /\b(?:in|into) which repo\b/i.test(q) ||
    /^(?:which|what) (?:agent|project) should (?:it|this|i|we) (?:go|start|be|live|run)\b/i.test(q) ||
    /^where should (?:it|this|the (?:new )?thread) (?:start|go|live|run)\b/i.test(q) ||
    /^in [\w.-]+,? or with [\w-]+\??$/i.test(q) ||
    /^(?:with )?(?:which agent|whom)\b/i.test(q)
  );
}
