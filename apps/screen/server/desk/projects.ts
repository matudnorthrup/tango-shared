// The owner's projects: folders of related conversations (a T3 thread in any workspace, a Discord
// thread or chat), kept on the desk. A conversation is in at most one (facts.projectId). Not T3's
// own "project", which is the workspace a T3 thread runs in (facts.project).
//
// Stored whole as the `projects` desk setting, like the owner's views; every screen gets it.

export interface DeskProject {
  id: string;
  name: string;
  /** A Lucide icon name, as for agents; null: the project's first letter. */
  icon: string | null;
  /** One of the T3 icon colors (list-model.js ICON_COLORS); null: slate. */
  color: string | null;
  about?: string;
  /** An optional link to its Linear project; nothing is synced. */
  linearUrl?: string;
  createdAt: number;
  /** Finished (History); its conversations keep their project. */
  finishedAt?: number | null;
  /**
   * Snoozed or parked as a whole (the outer layer): its conversations keep their own state and are only
   * held while this lasts (projectHold). `until`/`trigger` as a conversation's own snooze; parked has neither.
   */
  away?: ProjectAway | null;
  /** The status sections its page hides (PROJECT_SECTIONS); absent: the desk's default (`project_sections_hidden`). */
  hiddenSections?: ProjectSection[];
  /**
   * The space it is inside (docs/specs/spaces.md, Nesting): `project:<id>` or `agent:<id>`; absent, the person's own
   * space. Two levels: a parent project is top-level itself, and a project with children has no parent.
   */
  parent?: ParentKey;
}

export type ParentKey = `project:${string}` | `agent:${string}`;
const PARENT = /^(project|agent):[\w.-]{1,80}$/;

/** The project a project is inside, when its parent is a project (not an agent) that the list has. */
export function parentProject(project: DeskProject | undefined, projects: DeskProject[]): DeskProject | null {
  const parent = project?.parent;
  if (!parent?.startsWith('project:')) return null;
  return projects.find((p) => p.id === parent.slice(8)) ?? null;
}

/** A project's child projects (any state), in the list's order. */
export function childProjects(projectId: string, projects: DeskProject[]): DeskProject[] {
  return projects.filter((p) => p.parent === `project:${projectId}`);
}

/**
 * What holds a project's conversations while it is away: its own snooze or park, else its parent project's
 * (snoozing or parking a parent holds its children; docs/specs/spaces.md, Nesting). Null when neither is away.
 */
export function holderOf(project: DeskProject | undefined, projects: DeskProject[]): DeskProject | null {
  if (!project || project.finishedAt) return null;
  if (project.away) return project;
  const parent = parentProject(project, projects);
  return parent && !parent.finishedAt && parent.away ? parent : null;
}

/** The status sections of a project's page (desk/next/model.js GROUPS), any of which the owner can hide. */
export const PROJECT_SECTIONS = ['failed', 'stuck', 'needs', 'finished', 'sent', 'working', 'waiting', 'idle', 'unknown', 'away', 'done'] as const;
/** Sections saved under the retired states read in the six-pill vocabulary (docs/specs/desk-status.md). */
const LEGACY_SECTIONS: Record<string, ProjectSection> = { ready: 'idle', watching: 'waiting', other: 'idle' };
export type ProjectSection = (typeof PROJECT_SECTIONS)[number];
/** Until the owner picks: finished threads stay in the page's History panel, not its list. */
export const DEFAULT_HIDDEN_SECTIONS: ProjectSection[] = ['done'];

/** A list of section keys, deduplicated in PROJECT_SECTIONS order; null when malformed. */
export function parseHiddenSections(raw: unknown): ProjectSection[] | null {
  if (!Array.isArray(raw)) return null;
  const keys = raw.map((k) => (typeof k === 'string' && LEGACY_SECTIONS[k]) || k);
  if (keys.some((k) => !PROJECT_SECTIONS.includes(k as ProjectSection))) return null;
  return PROJECT_SECTIONS.filter((k) => keys.includes(k));
}

/** The desk's default hidden sections, or the built-in one when the setting is missing or unreadable. */
export function readHiddenSections(raw: string | null): ProjectSection[] {
  try {
    return (raw != null && parseHiddenSections(JSON.parse(raw))) || [...DEFAULT_HIDDEN_SECTIONS];
  } catch {
    return [...DEFAULT_HIDDEN_SECTIONS];
  }
}

export interface ProjectAway {
  state: 'snoozed' | 'parked';
  /** When it went away: what a conversation says after this can bring it back on its own. */
  at: number;
  until?: number | null;
  trigger?: 'desk' | 'agent_posts' | null;
}

export const MAX_PROJECTS = 100;
const COLORS = ['slate', 'gray', 'zinc', 'neutral', 'stone', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose'];

/** Validates the owner's projects (the whole list): anything malformed is refused, not trimmed. */
export function parseProjects(raw: unknown, now = Date.now()): { projects: DeskProject[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'projects must be a list' };
  if (raw.length > MAX_PROJECTS) return { error: `at most ${MAX_PROJECTS} projects` };
  const ids = new Set<string>();
  const projects: DeskProject[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { error: 'each project must be an object' };
    const p = entry as Record<string, unknown>;
    if (typeof p.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(p.id)) return { error: `bad project id ${String(p.id)}` };
    if (ids.has(p.id)) return { error: `two projects share the id ${p.id}` };
    ids.add(p.id);
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 60) return { error: `project ${p.id} needs a name of at most 60 characters` };
    if (p.icon != null && (typeof p.icon !== 'string' || !/^[a-z0-9-]{1,60}$/.test(p.icon))) return { error: `project ${p.id}: icon must be a Lucide icon name` };
    if (p.color != null && !COLORS.includes(String(p.color))) return { error: `project ${p.id}: color must be one of ${COLORS.join(', ')}` };
    if (p.about !== undefined && (typeof p.about !== 'string' || p.about.length > 300)) return { error: `project ${p.id}: about must be at most 300 characters` };
    if (p.linearUrl !== undefined && p.linearUrl !== '' && (typeof p.linearUrl !== 'string' || !/^https:\/\/linear\.app\/\S+$/.test(p.linearUrl))) return { error: `project ${p.id}: linearUrl must be a linear.app link` };
    const finishedAt = p.finishedAt == null ? null : Number(p.finishedAt);
    const away = parseAway(p.away);
    if (away === undefined) return { error: `project ${p.id}: away must be { state: snoozed | parked, at, until?, trigger? }` };
    if (finishedAt !== null && !Number.isFinite(finishedAt)) return { error: `project ${p.id}: finishedAt must be a time` };
    const hiddenSections = p.hiddenSections == null ? null : parseHiddenSections(p.hiddenSections);
    if (p.hiddenSections != null && !hiddenSections) return { error: `project ${p.id}: hiddenSections must list some of ${PROJECT_SECTIONS.join(', ')}` };
    const project: DeskProject = {
      id: p.id,
      name: p.name.trim(),
      icon: (p.icon as string | null | undefined) ?? null,
      color: (p.color as string | null | undefined) ?? null,
      createdAt: Number.isFinite(Number(p.createdAt)) && Number(p.createdAt) > 0 ? Number(p.createdAt) : now,
    };
    if (typeof p.about === 'string' && p.about.trim()) project.about = p.about.trim();
    if (typeof p.linearUrl === 'string' && p.linearUrl) project.linearUrl = p.linearUrl;
    if (finishedAt !== null) project.finishedAt = finishedAt;
    if (away && finishedAt === null) project.away = away;
    if (hiddenSections) project.hiddenSections = hiddenSections;
    if (p.parent != null) {
      if (typeof p.parent !== 'string' || !PARENT.test(p.parent)) return { error: `project ${p.id}: parent must be "project:<id>" or "agent:<id>"` };
      project.parent = p.parent as ParentKey;
    }
    projects.push(project);
  }
  // Nesting: two levels, each parent project in the list and never the project itself (docs/specs/spaces.md, Nesting).
  for (const project of projects) {
    // A finished child keeps where it was; it nests nothing, so its parent may move into another space meanwhile.
    if (!project.parent?.startsWith('project:') || project.finishedAt) continue;
    const parent = parentProject(project, projects);
    if (!parent) return { error: `project ${project.id}: no parent project ${project.parent.slice(8)}` };
    if (parent.id === project.id) return { error: `project ${project.id} can’t be inside itself` };
    if (parent.parent) return { error: `project ${project.id}: ${parent.name} is inside another space already; spaces nest two levels` };
  }
  return { projects };
}

/** A project's `away`: null when there is none, undefined when it is malformed. */
function parseAway(raw: unknown): ProjectAway | null | undefined {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const a = raw as Record<string, unknown>;
  if (a.state !== 'snoozed' && a.state !== 'parked') return undefined;
  if (!Number.isFinite(Number(a.at))) return undefined;
  const until = a.until == null ? null : Number(a.until);
  if (until !== null && !Number.isFinite(until)) return undefined;
  const trigger = a.trigger === 'desk' || a.trigger === 'agent_posts' ? a.trigger : null;
  if (a.trigger != null && trigger === null) return undefined;
  if (a.state === 'snoozed' && until === null && trigger === null) return undefined;
  return a.state === 'parked' ? { state: 'parked', at: Number(a.at) } : { state: 'snoozed', at: Number(a.at), ...(until !== null ? { until } : {}), ...(trigger ? { trigger } : {}) };
}

/** The stored projects, or none when the setting is missing or unreadable. */
export function readProjects(raw: string | null): DeskProject[] {
  try {
    const list = JSON.parse(raw ?? '[]') as unknown;
    const parsed = parseProjects(list);
    if (!('error' in parsed)) return parsed.projects;
    // A nesting that no longer holds (a parent deleted under its children) never costs the owner their projects:
    // read once more with every parent dropped, so each lists at the top.
    if (!Array.isArray(list)) return [];
    const flat = parseProjects(list.map((p) => (p && typeof p === 'object' && !Array.isArray(p) ? { ...(p as Record<string, unknown>), parent: null } : p)));
    return 'error' in flat ? [] : flat.projects;
  } catch {
    return [];
  }
}

/**
 * Views saved before projects: their `project` filter and grouping meant T3's workspaces. Renamed
 * once to `workspace`, so `project` can mean the owner's projects. Null when nothing changes.
 */
export function viewsWithWorkspaces(saved: unknown): unknown[] | null {
  if (!Array.isArray(saved)) return null;
  let changed = false;
  const views = saved.map((view) => {
    if (!view || typeof view !== 'object' || Array.isArray(view)) return view;
    const { project, ...rest } = view as Record<string, unknown>;
    const next: Record<string, unknown> = { ...rest };
    if (project !== undefined) next.workspace = project;
    if (next.group === 'project') next.group = 'workspace';
    if (project !== undefined || (view as Record<string, unknown>).group === 'project') changed = true;
    return next;
  });
  return changed ? views : null;
}

/** The To-dos built-in view (list-views.js DEFAULT_VIEWS), as it is added to saved views that predate it. */
export const TODOS_VIEW = { id: 'todos', name: 'To-dos', status: ['active'], live: ['todo'], group: 'stage', sort: 'asks', fold: true } as const;

/**
 * Views saved before the To-dos built-in (owner, 10/18: a to-do has its own list) never show it, since saved
 * views replace the built-ins. Added once, right after the first view of the owner's move (Needs you, Ready,
 * a "Top"), unless a view already lists to-dos. Null when nothing changes.
 */
export function viewsWithTodos(saved: unknown): unknown[] | null {
  if (!Array.isArray(saved) || saved.length === 0) return null;
  const record = (view: unknown): Record<string, unknown> | null => (view && typeof view === 'object' && !Array.isArray(view) ? (view as Record<string, unknown>) : null);
  const lives = (view: unknown): unknown[] => (Array.isArray(record(view)?.live) ? (record(view)!.live as unknown[]) : []);
  if (saved.some((view) => record(view)?.id === 'todos' || lives(view).includes('todo'))) return null;
  const after = saved.findIndex((view) => lives(view).some((live) => live === 'needs' || live === 'ready'));
  const index = after >= 0 ? after + 1 : Math.min(1, saved.length);
  return [...saved.slice(0, index), { ...TODOS_VIEW, status: [...TODOS_VIEW.status], live: [...TODOS_VIEW.live] }, ...saved.slice(index)];
}

/** What lets a held conversation come back on its own, from the conversation's side of things. */
export interface HoldSignals {
  /** The owner wrote in it after the project went away. */
  ownerWroteSince: boolean;
  /** The agent posted in it after the project went away (ack-only replies included: a cheap, rare case). */
  agentPostedSince: boolean;
  /** The owner brought this one conversation back (Back to Active on its row) after the project went away. */
  pickedUpSince: boolean;
}

/**
 * Whether a project that is away holds one of its conversations, the same rules as a conversation's own
 * snooze (attention.ts): the owner writing or picking it up brings it back anywhere; new words from the
 * agent bring it back from a parked project or one snoozed until they post; a time snooze holds until then.
 * Only a conversation in rotation is held: a snoozed, parked or done one keeps its own state.
 */
export function projectHolds(away: ProjectAway | null | undefined, now: number, signals: HoldSignals): boolean {
  if (!away) return false;
  if (away.state === 'snoozed' && away.until != null && away.until <= now) return false;
  if (signals.ownerWroteSince || signals.pickedUpSince) return false;
  if ((away.state === 'parked' || away.trigger === 'agent_posts') && signals.agentPostedSince) return false;
  return true;
}

/** Split only untouched built-ins; saved owner edits remain their own views. */
export function viewsWithInboxTabs(saved: unknown, split = true): unknown[] | null {
  if (!Array.isArray(saved) || !saved.length) return null;
  const old = (id: string, name: string, live?: string[]) => ({ id, name, status: ['active'], ...(live ? { live } : {}), group: 'stage', sort: id === 'ready' ? 'asks' : 'recent', fold: true, showProjects: ['active'] });
  const same = (a: unknown, b: Record<string, unknown>) => {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
    const value = a as Record<string, unknown>;
    return Object.keys(value).length === Object.keys(b).length && Object.entries(b).every(([k, v]) => JSON.stringify(value[k]) === JSON.stringify(v));
  };
  let changed = false;
  const views = saved.flatMap((view) => {
    if (same(view, old('active', 'Active'))) { changed = true; return []; }
    if (split && same(view, old('ready', 'Ready', ['needs', 'ready', 'failed']))) {
      changed = true;
      // A tab of the owner's may already hold the id `needs`: keep it, and give Needs you a free id (Codex review on #763).
      const ids = new Set(saved.map((v) => (v && typeof v === 'object' ? (v as { id?: unknown }).id : null)));
      let id = 'needs';
      for (let n = 2; ids.has(id); n++) id = `needs-${n}`;
      return [{ ...old('ready', 'Ready'), id, name: 'Needs you', live: ['needs', 'failed'] }, { ...old('ready', 'Ready'), live: ['ready'] }];
    }
    return [view];
  });
  // Splitting adds a tab: past the 20-tab limit, leave Ready as it was rather than make the views unreadable.
  if (split && views.length > 20) return viewsWithInboxTabs(saved, false);
  return changed ? views : null;
}
