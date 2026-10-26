import { PhoneNotes, parsePhoneNote, phoneNoteRuntime, type PhoneNoteRuntime } from './phone-note.js';
import { registerAgentHome } from './agent-home.js';
import { DeskDevices, parseDevice } from './devices.js';
import { postInFeedScope } from '../../public/desk/feed-scope.js';
import { createHash, randomUUID } from 'node:crypto';
import { closedBareState, parseFeedSettings, readFeedSettings, type DeskFeed, type FeedSettings } from './feed.js';
import { DESK_BUILD } from '../build.js';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Prototype } from '../prototypes.js';
import type { Scene } from '../store.js';
import type { AgentTurnEvent, DeskCore } from './core.js';
import { isAllowedOwnerLogin, isDirectLocalCaller } from '../access.js';
import { isImageAttachment, type DiscordRest } from '../discord.js';
import { parseAttachments, t3AttachmentFile } from './attachments.js';
import { DraftBoard, parseDraftPost } from './draft.js';
import { publicCheck, publicOptions, publicResult, redactPaths, type StartWork, type StartWorkRequest } from './start-work.js';
import { routingProblems, writeRouting, type Capacity } from './capacity.js';
import { isSystemCommand, type DeskSystem } from './system.js';
import { isOpen, isWaiting, nextMorning, SEEN_VIAS, type DeskUpdates } from './updates.js';
import { applyAccept, cardAsks, cardBriefs, chapterLines, planChapter, stale } from './catchup-actions.js';
import { catchupWalk } from './catchup-walk.js';
import { tidiedIds } from './triage.js';
import { decisionPage, type DeskDecided } from './decided.js';
import type { Severity } from '@tango/system';
import type { AgentStart } from './agent-start.js';
import { readAccountPolicy } from './start-work-accounts.js';
import { PauseBoard, parsePauseCard } from './pause.js';
import { facetsFor, parseFilters, personaId, readFilters, writeFilters, type DeskFilters } from './filters.js';
import { PROJECT_SECTIONS, parseHiddenSections, parseProjects, readHiddenSections, readProjects, type DeskProject, type ProjectSection } from './projects.js';
import { isThreadRole } from './roles.js';
import { parseSpaceViews, readSpaceViews, type SpaceView } from './space-views.js';
import { parseSpaces, readSpaces, type SpaceRecord } from './spaces.js';
import { COMMAND_TYPES, THREAD_ROLES, ITEM_TYPES, LIST_SECTIONS, type Actor, type CommandType, type ListSection } from './types.js';
import { isTraceSource, parseTraceTime, TRACE_SOURCES, type DeskTrace, type TraceInput, type TraceSource } from './trace.js';
import { activityFeed, briefing, DESK_GROUPS, DESK_VIEWS, itemDetail, listItems, nextUpQueue, presentItem, type DeskGroup, type DeskView } from './view.js';
import type { DeskSearch, SearchDoc } from './search.js';
import { agentId as queryAgentId, openOnly } from './query.js';
import { parseSearchFields, searchQuery, searchMatches } from './search-query.js';
import { coordinatorItemIds, type ProjectCoordinators } from './coordinator.js';
import { readMailOff, type DeskMail } from './mail.js';
import { LAB_FENCE_MAX_ITEMS, LabFences } from './lab-fence.js';
import type { AgentAvatars } from './agents.js';

/** A list is rebuilt at least this often: project holds and source snoozes end on the clock, with no write. */
const LIST_CACHE_MAX_MS = 30_000;

const LUCIDE_DIR = path.join(path.dirname(createRequire(import.meta.url).resolve('lucide-static/package.json')), 'icons');

let lucideTags: Record<string, string[]> | null = null;
/**
 * Lucide icon names for Settings' icon picker, best first: the name itself starts with the query, then
 * contains it, then one of its tags (lucide-static's tags.json) does. An empty query lists from the top.
 */
export function searchIcons(query: string, limit = 48): string[] {
  if (!lucideTags) {
    try {
      lucideTags = JSON.parse(fs.readFileSync(path.join(LUCIDE_DIR, '..', 'tags.json'), 'utf8')) as Record<string, string[]>;
    } catch {
      lucideTags = Object.fromEntries(fs.readdirSync(LUCIDE_DIR).filter((f) => f.endsWith('.svg')).map((f) => [f.slice(0, -4), []]));
    }
  }
  const q = query.trim().toLowerCase().replace(/\s+/g, '-');
  const names = Object.keys(lucideTags).filter((name) => fs.existsSync(path.join(LUCIDE_DIR, `${name}.svg`)) || !q);
  if (!q) return names.slice(0, limit);
  const words = q.replace(/-/g, ' ');
  const rank = (name: string) => (name.startsWith(q) ? 0 : name.includes(q) ? 1 : (lucideTags![name] || []).some((t) => t.toLowerCase().includes(words)) ? 2 : 3);
  return names
    .map((name) => [name, rank(name)] as const)
    .filter(([, r]) => r < 3)
    .sort((a, b) => a[1] - b[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name]) => name);
}

// HTTP surface of the desk (spec "Read API", "Commands", "Agent turn events").
// GET/POST /api/desk/presentation live with the hub (presentation.ts); its
// changes are relayed on /api/desk/stream as `presentation` events, next to
// `item`, `activity`, `settings` (filters, sweep day) and the voice operator's
// `operator` status.

export interface DeskRoutesOptions {
  /** The existing bot reply path for a home channel not yet represented on the desk. */
  phoneAgentReply?: (agentId: string, threadId: string | undefined, text: string, commandId: string) => Promise<{ ok: boolean; notDelivered?: boolean }>;
  /** Injectable compiler/context for the sandbox; production uses the operator profile. */
  phoneNoteRuntime?: () => Promise<PhoneNoteRuntime>;
  conversations?: {
    push: (key: string, messageId: number) => Promise<unknown>;
    report: () => unknown;
    attachment: (id: string, index: string) => Promise<Response>;
  };
  core: DeskCore;
  /** Live scenes, to link items to what their agent staged. */
  scenes: () => Scene[];
  /** Live prototypes, to link items to what their agent published for the Prototype view. */
  prototypes?: () => Prototype[];
  /** TANGO_COLLABORATION_BRIDGE_TOKEN: when set, bot calls must carry it. */
  collaborationToken?: string;
  keepAliveMs?: number;
  /** The session trace (GET/POST /api/desk/trace, `trace` events on the stream with ?trace=1). */
  trace?: DeskTrace;
  /** The hub's presentation, relayed on the desk stream. */
  presentation?: { current(): unknown; subscribe(listener: (presentation: unknown) => void): () => void };
  /** The voice operator's Draft card (draft mode); one is made when omitted. */
  draft?: DraftBoard;
  /** The voice operator's pause pill (pause mode); one is made when omitted. */
  pause?: PauseBoard;
  /** Where messages' images are read from: T3's attachments directory, and Discord (for a fresh CDN link). */
  attachments?: { t3Dir?: string; discord?: Pick<DiscordRest, 'message'>; loom?: (id: string) => Promise<{ mimeType: string; bytes: Uint8Array<ArrayBuffer> } | null> };
  /** Start work: new Loom threads (absent when the desk doesn't follow T3). */
  startWork?: { service: StartWork; afterStart?: () => void };
  /** Start work on a named agent: a new thread in its home channel (agent-start.ts). */
  agentStart?: { service: AgentStart; afterStart?: () => void };
  /** Capacity (accounts, their threads, this Mac) and the routing policy Settings › Routing edits. */
  capacity?: { service: Capacity; policyFile?: string };
  /** The System page (desk/system.ts): jobs, runs, events and incidents from the system ledger. */
  system?: DeskSystem;
  /** Search across every conversation the desk has followed (GET /api/desk/search). */
  search?: DeskSearch;
  /** Projects' coordinators (desk/coordinator.ts): `coordinator` events on the stream. */
  coordinators?: ProjectCoordinators;
  /** Desk mail between agents' conversations (desk/mail.ts): `/api/desk/mail*`, this machine only. */
  mail?: DeskMail;
  /** Voice lab sessions' scratch threads (desk/lab-fence.ts): fenced agents can't start threads or mail out. */
  labFences?: LabFences;
  /** The news feed (desk/feed.ts): `GET /api/desk/feed`, `feed` events on the stream. */
  feed?: DeskFeed;
  /** "Decided for you" (desk/decided.ts): what agents decided and did for the owner, from Loom's ledger. */
  decided?: DeskDecided;
  /** The catch-up ledger (desk/updates.ts): `/api/desk/updates*`, `/api/desk/chapters`. */
  updates?: DeskUpdates;
  /** The agents and their pictures (desk/agents.ts): `/api/desk/agents`. */
  agents?: AgentAvatars;
}

/**
 * A conversation the desk no longer holds, shaped like a List row so the views filter it like any
 * other: done, quiet, with the type and project it last had.
 */
export function archivedRow(doc: SearchDoc) {
  return {
    id: doc.itemId,
    source: doc.source,
    kind: doc.kind,
    conversationKey: doc.itemId,
    agentId: doc.agentId,
    agentName: doc.agentName,
    place: doc.place,
    area: doc.area,
    facts: doc.facts,
    summary: doc.summary,
    createdAt: doc.createdAt,
    lastActivityAt: doc.lastActivityAt,
    doneAt: doc.lastActivityAt,
    disposition: 'done' as const,
    seen: 'seen' as const,
    nextStep: 'fyi' as const,
    labels: [],
    archived: true,
  };
}

/** What the voice operator publishes (POST /api/desk/operator), relayed as `operator` on the stream. */
export interface OperatorStatus {
  live: boolean;
  status: 'idle' | 'listening' | 'thinking' | 'speaking';
  agentName: string | null;
  transcript: { speaker: 'owner' | 'agent' | 'operator'; name: string | null; text: string; final: boolean } | null;
  at: number;
}

/** GET/POST /api/desk/settings, and the stream's `settings` event. */
export interface DeskSettings {
  sweepDay: 'saturday' | 'monday';
  filters: DeskFilters;
  /** The owner's icon and color per agent for the List view (overrides the page's defaults), keyed by agent id. */
  agentIcons: Record<string, AgentIcon>;
  /** The owner's icon and color per repo, keyed by the repo's name in lower case: a coding thread's tile when no project or agent gives it one. */
  repoIcons: Record<string, AgentIcon>;
  /** The owner's order for the List view's label sections (every label, Chats and No label; Pinned stays on top). */
  labelOrder: ListSection[];
  /** The snooze picker's morning (also Monday's) and evening times, "HH:MM" local. */
  snoozeTimes: SnoozeTimes;
  /** The owner's List views (the tabs), or null for the built-in ones. */
  listViews: ListViewSpec[] | null;
  /** Default views for project and agent pages; null uses the built-in set. */
  spaceViews: SpaceView[] | null;
  /** The owner's projects (desk/projects.ts), in their order. */
  projects: DeskProject[];
  /** Bumped on every change to them: a save from an older copy is refused, not merged over another screen's. */
  projectsRev: number;
  /** Conversations (item ids) and projects (`project:<id>`) the owner closed to agent mail and starting threads (desk/mail.ts). */
  mailOff: string[];
  /** Each space's own record (desk/spaces.ts), keyed `project:<id>` or `agent:<id>`. */
  spaces: Record<string, SpaceRecord>;
  /** The status sections a project's page hides unless the project picks its own (desk/projects.ts). */
  projectSectionsHidden: ProjectSection[];
  /** What the Screen window's feed shows (desk/feed.ts). */
  feed: FeedSettings;
}

/** A Lucide icon name and one of T3's color names, the same vocabulary as a T3 project icon. */
export interface AgentIcon {
  icon: string;
  color: string | null;
}

export const ICON_COLORS = ['slate', 'gray', 'zinc', 'neutral', 'stone', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose'] as const;

function readAgentIcons(raw: string | null): Record<string, AgentIcon> {
  try {
    const parsed = JSON.parse(raw ?? '{}') as Record<string, AgentIcon>;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The stored order with any section it doesn't name (a label added since) after it, in the default order. */
function completeLabelOrder(order: readonly string[]): ListSection[] {
  const known = order.filter((key): key is ListSection => (LIST_SECTIONS as readonly string[]).includes(key));
  const unique = [...new Set(known)];
  return [...unique, ...LIST_SECTIONS.filter((key) => !unique.includes(key))];
}

/** One List view, as the owner defines it in Settings → Views (public/desk/list-views.js reads it). */
export interface ListViewSpec {
  id: string;
  name: string;
  /** `project`: the owner's projects; `workspace`: T3's workspaces (a view saved before projects said `project`). */
  group: 'type' | 'project' | 'workspace' | 'live' | 'none';
  sort: 'recent' | 'oldest' | 'asks' | 'wake';
  /** In rotation, snoozed, parked, done; empty means every status. */
  status?: string[];
  /** The old pick-one field, kept beside `status` while a tab from before Status may still be open. */
  show?: string;
  live?: string[];
  busy?: string[];
  unread?: string[];
  kind?: string[];
  pinned?: string[];
  /** A saved device filter keeps an empty result empty instead of substituting today's wins. */
  emptyShelf?: boolean;
  where?: Record<string, { in?: string[]; not?: string[]; unset?: boolean }>;
  /** Grouped by workspace: every Tango agent in one section instead of one each. */
  agentsTogether?: boolean;
  /** 2: saved under the four tabs, so its built-in tabs are the owner's. */
  rev?: number;
  type?: string[];
  /** T3 workspaces by name (`project` before projects; read as this). */
  workspace?: string[];
  /** The owner's projects by id. */
  projects?: string[];
  /** Only conversations in a project (`some`), or only those in none (`none`); absent: either. */
  inProject?: 'some' | 'none';
  /** Each project is one folder row; false lists every conversation. */
  fold?: boolean;
  /** Folded: open projects in these states (active, snoozed, parked) always get a folder, even with nothing in the view. */
  showProjects?: string[];
  agent?: string[];
}
const VIEW_STATUSES = ['active', 'snoozed', 'parked', 'done'] as const;
/** Views saved before Status was a filter said which one list they showed. */
const LEGACY_SHOW: Record<string, string[]> = { active: ['active'], open: ['active', 'snoozed', 'parked'], snoozed: ['snoozed'], parked: ['parked'], history: ['done'] };
const VIEW_GROUPS = ['type', 'project', 'workspace', 'live', 'none'] as const;
const VIEW_SORTS = ['recent', 'oldest', 'asks', 'wake'] as const;
const VIEW_LIVE = ['failed', 'stuck', 'needs', 'finished', 'working', 'waiting', 'idle', 'unknown'] as const;
/** A view saved under the retired live states reads in the six-pill vocabulary (docs/specs/desk-status.md). */
const LEGACY_LIVE: Record<string, string> = { ready: 'idle', todo: 'idle', watching: 'waiting', held: 'waiting', review: 'waiting' };
const migrateLive = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((s) => s !== 'quiet').map((s) => (typeof s === 'string' && LEGACY_LIVE[s]) || s))] : value;

/** Validates the owner's views: `null` goes back to the built-in ones; anything malformed is refused, not trimmed. */
/** A project's own state, as a view's `showProjects` names it (public/desk/list-model.js PROJECT_STATES). */
const PROJECT_STATES = ['active', 'snoozed', 'parked'] as const;

export function parseListViews(raw: unknown): { views: ListViewSpec[] | null } | { error: string } {
  if (raw === null) return { views: null };
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'listViews must be a non-empty list of views, or null' };
  if (raw.length > 20) return { error: 'at most 20 views' };
  const ids = new Set<string>();
  const views: ListViewSpec[] = [];
  const strings = (value: unknown, name: string, allowed?: readonly string[], max = 60): string[] | string => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim() || v.length > max)) return `${name} must be a list of names`;
    const bad = allowed ? (value as string[]).find((v) => !allowed.includes(v)) : undefined;
    return bad !== undefined ? `${name}: ${bad} is not one of ${allowed!.join(', ')}` : [...new Set(value as string[])];
  };
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { error: 'each view must be an object' };
    const v = { ...entry } as Record<string, unknown>;
    if (v.group === 'stage') v.group = 'live';
    if (typeof v.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(v.id)) return { error: `bad view id ${String(v.id)}` };
    if (ids.has(v.id)) return { error: `two views share the id ${v.id}` };
    ids.add(v.id);
    if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 40) return { error: `view ${v.id} needs a name of at most 40 characters` };
    if (v.status === undefined && v.show !== undefined) {
      if (typeof v.show !== 'string' || !LEGACY_SHOW[v.show]) return { error: `view ${v.id}: show must be one of ${Object.keys(LEGACY_SHOW).join(', ')}` };
    }
    if (!(VIEW_GROUPS as readonly unknown[]).includes(v.group)) return { error: `view ${v.id}: group must be one of ${VIEW_GROUPS.join(', ')}` };
    if (v.agentsTogether !== undefined && typeof v.agentsTogether !== 'boolean') return { error: `view ${v.id}: agentsTogether must be true or false` };
    if (v.sort !== undefined && !(VIEW_SORTS as readonly unknown[]).includes(v.sort)) return { error: `view ${v.id}: sort must be one of ${VIEW_SORTS.join(', ')}` };
    // Only a screen loaded before projects leaves out `fold`: its `project` grouping meant T3 workspaces (Codex review on #522).
    const group = v.group === 'project' && v.fold === undefined ? 'workspace' : (v.group as ListViewSpec['group']);
    const view: ListViewSpec = { id: v.id, name: v.name.trim(), group, sort: (v.sort as ListViewSpec['sort']) ?? 'recent', ...(v.rev === 2 ? { rev: 2 } : {}) };
    const filters: Array<[keyof ListViewSpec, readonly string[] | undefined]> = [
      ['status', VIEW_STATUSES],
      ['live', VIEW_LIVE],
      ['busy', ['working', 'background', 'none']],
      ['unread', ['true', 'false']],
      ['kind', ['thread', 'default']],
      ['pinned', ['true', 'false']],
      ['type', [...ITEM_TYPES, 'none']],
      ['workspace', undefined],
      ['projects', undefined],
      ['agent', undefined],
    ];
    for (const [key, allowed] of filters) {
      // Quiet was a live state until a message nobody picked up became Failed: dropped, never refused (or a stored view would be lost).
      // A screen loaded before projects still names workspaces `project`.
      const value = key === 'live' ? migrateLive(v.live) : key === 'workspace' ? (v.workspace ?? v.project) : v[key];
      const parsed = strings(key === 'status' && v.status === undefined && typeof v.show === 'string' ? LEGACY_SHOW[v.show] : value, `view ${v.id}: ${key}`, allowed);
      if (typeof parsed === 'string') return { error: parsed };
      // Status is always written, empty for any status, so the `show` kept beside it is never read back as the truth (Codex review on #504).
      if (parsed.length || key === 'status') (view as unknown as Record<string, unknown>)[key] = parsed;
    }
    if (v.emptyShelf !== undefined && typeof v.emptyShelf !== 'boolean') return { error: 'emptyShelf must be boolean' };
    if (v.emptyShelf === false) view.emptyShelf = false;
    if (v.where !== undefined) {
      if (!v.where || typeof v.where !== 'object' || Array.isArray(v.where)) return { error: 'view where must be an object' };
      const allowed: Record<string, readonly string[] | undefined> = {
        wait: ['person', 'agent', 'review', 'job', 'monitor', 'check-back'], overdue: ['true', 'false'],
        health: ['failing', 'paused', 'running', 'on-schedule'], age: ['today', 'week', 'month', 'older'],
        source: undefined, account: undefined,
        disposition: VIEW_STATUSES, live: VIEW_LIVE, busy: ['working', 'background'],
        unread: ['true', 'false'], kind: ['thread', 'default'], pinned: ['true', 'false'],
        type: [...ITEM_TYPES, 'none'], project: undefined,
        agent: undefined, repo: undefined, workspace: undefined, space: undefined, where: undefined,
      };
      const where: NonNullable<ListViewSpec['where']> = {};
      for (const [facet, rawFilter] of Object.entries(v.where)) {
        if (facet === 'stage') continue;
        if (!Object.hasOwn(allowed, facet) || !rawFilter || typeof rawFilter !== 'object' || Array.isArray(rawFilter)) return { error: 'unknown or invalid Inbox facet' };
        const filter = rawFilter as Record<string, unknown>;
        if (Object.keys(filter).some((key) => !['in', 'not', 'unset'].includes(key)) || (filter.unset !== undefined && typeof filter.unset !== 'boolean')) return { error: 'invalid Inbox facet filter' };
        const next: NonNullable<ListViewSpec['where']>[string] = {};
        for (const op of ['in', 'not'] as const) {
          const parsed = strings(facet === 'live' ? migrateLive(filter[op]) : filter[op], facet, allowed[facet], 120);
          if (typeof parsed === 'string') return { error: parsed };
          if (filter[op] !== undefined) next[op] = parsed;
        }
        if (filter.unset !== undefined) next.unset = filter.unset as boolean;
        where[facet] = next;
      }
      view.where = where;
    }
    if (v.inProject !== undefined && v.inProject !== 'any' && v.inProject !== 'some' && v.inProject !== 'none') return { error: `view ${v.id}: inProject must be any, some or none` };
    if (v.inProject === 'some' || v.inProject === 'none') view.inProject = v.inProject;
    if (v.fold !== undefined && typeof v.fold !== 'boolean') return { error: `view ${v.id}: fold must be true or false` };
    // Folded unless the view says otherwise, or holds only done items (History lists every conversation).
    view.fold = typeof v.fold === 'boolean' ? v.fold : !(view.status?.length && view.status.every((s) => s === 'done'));
    const showProjects = strings(v.showProjects, `view ${v.id}: showProjects`, PROJECT_STATES);
    if (typeof showProjects === 'string') return { error: showProjects };
    if (view.fold && showProjects.length) view.showProjects = showProjects;
    // A Desk tab loaded before Status reads only `show`: give it the matching one, or the nearest (any
    // open status reads as All open, Done alone as History) so it never falls back to Active (Codex review on #504).
    const status = view.status ?? [];
    const exact = Object.entries(LEGACY_SHOW).find(([, set]) => set.length === status.length && set.every((s) => status.includes(s)))?.[0];
    view.show = exact ?? (status.length && status.every((s) => s === 'done') ? 'history' : 'open');
    if (v.agentsTogether === true && view.group === 'workspace') view.agentsTogether = true;
    views.push(view);
  }
  return { views };
}

function readListViews(raw: string | null): ListViewSpec[] | null {
  try {
    const parsed = parseListViews(JSON.parse(raw ?? 'null'));
    return 'error' in parsed ? null : parsed.views;
  } catch {
    return null;
  }
}

export interface SnoozeTimes {
  morning: string;
  evening: string;
}
export const DEFAULT_SNOOZE_TIMES: SnoozeTimes = { morning: '06:00', evening: '18:00' };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function readSnoozeTimes(raw: string | null): SnoozeTimes {
  try {
    const parsed = JSON.parse(raw ?? '{}') as Partial<SnoozeTimes>;
    return {
      morning: typeof parsed.morning === 'string' && HHMM.test(parsed.morning) ? parsed.morning : DEFAULT_SNOOZE_TIMES.morning,
      evening: typeof parsed.evening === 'string' && HHMM.test(parsed.evening) ? parsed.evening : DEFAULT_SNOOZE_TIMES.evening,
    };
  } catch {
    return { ...DEFAULT_SNOOZE_TIMES };
  }
}

/** `{ morning?, evening? }` as "HH:MM": what is given replaces the stored time. */
export function parseSnoozeTimes(raw: unknown, current: SnoozeTimes): { times: SnoozeTimes } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'snoozeTimes must be { morning?, evening? }' };
  const next = { ...current };
  for (const [key, value] of Object.entries(raw)) {
    if (key !== 'morning' && key !== 'evening') return { error: `snoozeTimes: ${key} is not morning or evening` };
    if (typeof value !== 'string' || !HHMM.test(value)) return { error: `snoozeTimes.${key} must be a time like 06:00` };
    next[key] = value;
  }
  return { times: next };
}

function readLabelOrder(raw: string | null): ListSection[] {
  try {
    const parsed = JSON.parse(raw ?? '[]') as unknown;
    return completeLabelOrder(Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : []);
  } catch {
    return [...LIST_SECTIONS];
  }
}

/** `[section, …]`: known sections only, each once; the ones left out keep their default places after it. */
export function parseLabelOrder(raw: unknown): { order: ListSection[] } | { error: string } {
  if (!Array.isArray(raw) || raw.some((key) => typeof key !== 'string')) return { error: 'labelOrder must be a list of section names' };
  const bad = raw.find((key) => !(LIST_SECTIONS as readonly string[]).includes(key));
  if (bad !== undefined) return { error: `labelOrder: ${bad} is not one of ${LIST_SECTIONS.join(', ')}` };
  if (new Set(raw).size !== raw.length) return { error: 'labelOrder names a section twice' };
  return { order: completeLabelOrder(raw as string[]) };
}

/** `{ agentId: { icon, color } | null }`: null drops the owner's choice (back to the default). */
export function parseAgentIcons(raw: unknown, current: Record<string, AgentIcon>): { icons: Record<string, AgentIcon> } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'agentIcons must map agent ids to { icon, color } or null' };
  for (const agent of Object.keys(raw)) if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(agent)) return { error: `bad agent id ${agent}` };
  return parseIcons(raw as Record<string, unknown>, current);
}

/** `{ repoName: { icon, color } | null }`, any case (kept in lower case): null drops the repo's icon (back to the glyph). */
export function parseRepoIcons(raw: unknown, current: Record<string, AgentIcon>): { icons: Record<string, AgentIcon> } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'repoIcons must map repo names to { icon, color } or null' };
  const byKey: Record<string, unknown> = {};
  for (const [repo, value] of Object.entries(raw as Record<string, unknown>)) {
    const key = repo.trim().toLowerCase();
    if (!key || key.length > 80 || key === '__proto__' || /[\u0000-\u001f]/.test(key)) return { error: `bad repo name ${repo}` };
    byKey[key] = value;
  }
  return parseIcons(byKey, current);
}

function parseIcons(raw: Record<string, unknown>, current: Record<string, AgentIcon>): { icons: Record<string, AgentIcon> } | { error: string } {
  const next = { ...current };
  for (const [key, value] of Object.entries(raw)) {
    if (value === null) {
      delete next[key];
      continue;
    }
    const entry = value as Record<string, unknown>;
    const icon = typeof entry?.icon === 'string' ? entry.icon : '';
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(icon) || !fs.existsSync(path.join(LUCIDE_DIR, `${icon}.svg`))) return { error: `no Lucide icon named ${icon || '(empty)'}` };
    const color = entry.color === null || entry.color === undefined ? null : String(entry.color);
    if (color !== null && !(ICON_COLORS as readonly string[]).includes(color)) return { error: `color must be one of ${ICON_COLORS.join(', ')}` };
    next[key] = { icon, color };
  }
  return { icons: next };
}

const OPERATOR_STATUSES: readonly OperatorStatus['status'][] = ['idle', 'listening', 'thinking', 'speaking'];
const SPEAKERS = ['owner', 'agent', 'operator'] as const;

const ACTORS: readonly Actor[] = ['owner', 'voice', 'screen', 'agent', 'system'];
/** What a browser may write to the trace: what it rendered, and the owner's marks. Everything else is local only. */
const BROWSER_TRACE_SOURCES: readonly TraceSource[] = ['screen', 'owner'];
const MAX_TRACE_BATCH = 100;
/** The kinds that open a voice session, for `?session=latest`, in order of preference. */
const SESSION_START_KINDS = ['session.start', 'operator.start'];
const TURN_TYPES = ['turn.started', 'turn.activity', 'turn.finished', 'turn.failed'];

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** At most `max` characters, keeping the end ("…" in front). */
function clipStart(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-(max - 1)).trimStart()}` : text;
}

/** A local process (not proxied, not a browser). */
function isLocal(c: Context): boolean {
  return isDirectLocalCaller(c.req.raw.headers);
}

/** Bot calls: local, and carrying the collaboration token whenever one is configured. */
function isBotCaller(c: Context, token: string | undefined): boolean {
  return isLocal(c) && (!token || c.req.header('x-tango-collaboration-token') === token);
}

export function registerDeskRoutes(app: Hono, options: DeskRoutesOptions): void {
  const { core } = options;
  registerAgentHome(app, core);
  const devices = new DeskDevices(core.store.db);
  app.post('/api/desk/devices', async (c) => {
    const device = parseDevice(await c.req.json().catch(() => null));
    if (!device) return c.json({ error: 'valid iOS device registration required' }, 400);
    devices.register(device);
    return c.json({ ok: true, deskId: devices.id });
  });
  const keepAliveMs = options.keepAliveMs ?? 20_000;
  let operator: OperatorStatus = { live: false, status: 'idle', agentName: null, transcript: null, at: Date.now() };
  const operatorListeners = new Set<(status: OperatorStatus) => void>();
  const draft = options.draft ?? new DraftBoard();
  const phoneNotes = new PhoneNotes({ core, canStartAgent: !!options.agentStart, canStartRepo: !!options.startWork,
    runtime: options.phoneNoteRuntime ?? (async () => phoneNoteRuntime(core, (await options.startWork?.service.options().catch(() => ({ repos: [] })))?.repos.map(repo => repo.name) ?? [])),
    deliver: async (destination, message, commandId) => {
      if (destination.kind === 'new_loom' && options.startWork) {
        const result = await options.startWork.service.start({ repo: destination.repo, prompt: message, title: destination.title, commandId });
        if (result.ok) options.startWork.afterStart?.();
        return result.ok ? { ok: true, itemId: result.itemId } : { ok: false, notDelivered: !!result.check && (!result.check.ready || !result.check.plan) };
      }
      if (destination.kind === 'new_thread' && options.agentStart) {
        const result = await options.agentStart.service.start({ agentId: destination.agentId, prompt: message, title: destination.title, commandId });
        if (result.ok) options.agentStart.afterStart?.();
        return result.ok ? { ok: true, itemId: result.itemId } : { ok: false };
      }
      const itemId = destination.itemId ?? core.items().filter(item => item.agentId === destination.agentId && item.replyable && item.disposition === 'active'
        && (destination.kind === 'thread' ? item.threadId === destination.threadId : destination.kind === 'home' && item.kind === 'chapter'))
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0]?.id;
      if (!itemId) return (destination.kind === 'home' || destination.kind === 'thread') && options.phoneAgentReply
        ? options.phoneAgentReply(destination.agentId, destination.threadId, message, commandId) : { ok: false, notDelivered: true };
      const result = await core.command({ type: 'reply', commandId, itemId, actor: 'owner', args: { text: message } });
      return { ok: result.status === 'applied', itemId };
    },
  });
  app.post('/api/desk/voice-note', async c => {
    const request = parsePhoneNote(await c.req.json().catch(() => null));
    if (!request) return c.json({ error: 'text and a valid noteId are required' }, 400);
    return c.json(await phoneNotes.submit(request));
  });
  app.get('/api/desk/voice-note/destinations', async c => {
    try { return c.json({ choices: await phoneNotes.choices() }); }
    catch { return c.json({ error: 'Destinations are unavailable. Your note is saved.' }, 503); }
  });
  app.post('/api/desk/voice-note/:id/send', async c => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.key !== 'string') return c.json({ error: 'Choose a destination' }, 400);
    const result = await phoneNotes.sendHeld(c.req.param('id'), body.key);
    return result ? c.json(result) : c.json({ error: 'Note is already sent, delivery is unconfirmed, or destination is unavailable' }, 409);
  });

  const pause = options.pause ?? new PauseBoard();
  const settingsListeners = new Set<(settings: DeskSettings) => void>();
  const settings = (): DeskSettings => ({ sweepDay: core.sweepDay(), filters: readFilters(core.store), agentIcons: readAgentIcons(core.store.setting('agent_icons')), repoIcons: readAgentIcons(core.store.setting('repo_icons')), labelOrder: readLabelOrder(core.store.setting('label_order')), snoozeTimes: readSnoozeTimes(core.store.setting('snooze_times')), spaceViews: readSpaceViews(core.store.setting('space_views')), listViews: readListViews(core.store.setting('list_views')), projects: readProjects(core.store.setting('projects')), projectsRev: Number(core.store.setting('projects_rev') ?? 0), mailOff: readMailOff(core.store.setting('mail_off')), projectSectionsHidden: readHiddenSections(core.store.setting('project_sections_hidden')), feed: readFeedSettings(core.store.setting('feed')), spaces: readSpaces(core.store.setting('spaces')) });
  // A project changed on the desk's side (woke, went away, finished): every screen gets the newest.
  core.onProjectsChanged(() => {
    const next = settings();
    for (const listener of settingsListeners) listener(next);
  });

  /**
   * One Lucide icon, the set T3 picks project icons from (same version), for the List view's
   * project and agent tiles. The page tints it with a CSS mask, so it is served as is.
   */
  app.get('/api/desk/icon/:file', (c) => {
    const name = c.req.param('file').replace(/\.svg$/, '');
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return c.json({ error: 'no such icon' }, 404);
    const file = path.join(LUCIDE_DIR, `${name}.svg`);
    if (!fs.existsSync(file)) return c.json({ error: 'no such icon' }, 404);
    return c.body(fs.readFileSync(file), 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
  });

  /** The owner's agents and their pictures' URLs (the next layout's Agents and tiles). */
  app.get('/api/desk/agents', (c) => c.json({ agents: options.agents?.list() ?? [] }));

  /** An agent's picture, as Discord shows it; kept on disk so an expired CDN link still shows the last one. */
  app.get('/api/desk/agents/:id/avatar', async (c) => {
    const image = options.agents ? await options.agents.image(c.req.param('id')) : null;
    if (!image) return c.json({ error: 'no picture' }, 404);
    return c.body(new Uint8Array(image.body), 200, { 'Content-Type': image.type, 'Cache-Control': 'public, max-age=3600' });
  });

  /** Icon names matching `q` (name or tag), for Settings' icon picker. */
  app.get('/api/desk/icons', (c) => {
    const limit = Math.min(96, Math.max(1, Number(c.req.query('limit')) || 48));
    return c.json({ icons: searchIcons(String(c.req.query('q') ?? '').slice(0, 40), limit) });
  });

  // ── images on messages (attachments.ts) ─────────────────────────────────
  // Served from where each source keeps them, so the desk holds no copies. Private: they are the owner's screenshots.
  const imageHeaders = (mimeType: string) => ({ 'Content-Type': mimeType, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
  // Retained T3 messages' images, read-only: 404 once the retired T3 files are gone.
  app.get('/api/desk/attachments/t3/:id', (c) => {
    const dir = options.attachments?.t3Dir;
    const found = dir ? t3AttachmentFile(dir, c.req.param('id')) : null;
    if (!found) return c.json({ error: 'no such image' }, 404);
    return c.body(fs.readFileSync(found.file), 200, imageHeaders(found.mimeType));
  });
  app.get('/api/desk/attachments/loom/:id', async (c) => {
    const loom = options.attachments?.loom;
    if (!loom) return c.json({ error: 'no such image' }, 404);
    try {
      const found = await loom(c.req.param('id'));
      if (!found) return c.json({ error: 'no such image' }, 404);
      return c.body(new Uint8Array(found.bytes), 200, imageHeaders(found.mimeType));
    } catch (err) {
      return c.json({ error: `Loom isn't answering (${(err as Error).message})` }, 502);
    }
  });
  app.get('/api/desk/attachments/discord/:channelId/:messageId/:index', async (c) => {
    const discord = options.attachments?.discord;
    const { channelId, messageId } = c.req.param();
    const index = Number(c.req.param('index'));
    if (!discord || !/^\d{1,25}$/.test(channelId) || !/^\d{1,25}$/.test(messageId) || !Number.isInteger(index) || index < 0) return c.json({ error: 'no such image' }, 404);
    try {
      // Discord's CDN links expire; the message hands out a fresh one.
      const attachment = (await discord.message(channelId, messageId)).attachments?.[index];
      if (!attachment || !isImageAttachment(attachment)) return c.json({ error: 'no such image' }, 404);
      const response = await fetch(attachment.url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) return c.json({ error: `Discord CDN HTTP ${response.status}` }, 502);
      return c.body(new Uint8Array(await response.arrayBuffer()), 200, imageHeaders(attachment.content_type ?? 'image/png'));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  const listCache = new Map<string, { stamp: string; body: string; etag: string }>();
  app.get('/api/desk/items', (c) => {
    const view = (c.req.query('view') ?? 'active') as DeskView;
    const group = (c.req.query('group') ?? 'step') as DeskGroup;
    if (!DESK_VIEWS.includes(view)) return c.json({ error: `view must be one of ${DESK_VIEWS.join(', ')}` }, 400);
    if (!DESK_GROUPS.includes(group)) return c.json({ error: `group must be one of ${DESK_GROUPS.join(', ')}` }, 400);
    const agentId = c.req.query('agent') || undefined;
    // Every window asks for four lists on each change: each is built once per change and shared, and a window
    // that already has it gets a 304 (its ETag is the content's hash, so it survives a restart).
    const key = `${view}|${group}|${agentId ?? ''}`;
    const stamp = `${core.store.listStamp()}:${Math.floor(Date.now() / LIST_CACHE_MAX_MS)}`;
    let cached = listCache.get(key);
    if (!cached || cached.stamp !== stamp) {
      const body = JSON.stringify(listItems(core, { view, group, agentId }));
      cached = { stamp, body, etag: `"${createHash('sha1').update(body).digest('base64url')}"` };
      listCache.delete(key);
      listCache.set(key, cached);
      if (listCache.size > 64) listCache.delete(listCache.keys().next().value!);
    }
    const headers = { ETag: cached.etag, 'Cache-Control': 'no-cache' };
    if (c.req.header('if-none-match') === cached.etag) return c.body(null, 304, headers);
    return c.body(cached.body, 200, { ...headers, 'Content-Type': 'application/json; charset=UTF-8' });
  });

  /** `?q=` (words, "phrases", -exclusions) `&limit=` (≤ 300): conversations ranked by keyword and meaning, each with its List row. */
  app.get('/api/desk/search', async (c) => {
    const search = options.search;
    if (!search) return c.json({ error: 'search is not set up' }, 404);
    const q = (c.req.query('q') ?? '').slice(0, 500);
    let query;
    try { query = searchQuery(c.req.query('where'), c.req.query('scope'), c.req.query('audience')); }
    catch { return c.json({ error: 'invalid search filters' }, 400); }
    if (!q.trim()) return c.json({ query: q, semantic: false, hits: [], total: 0, more: false, tokens: [] });
    const projects = readProjects(core.store.setting('projects'));
    const items = core.items();
    const rows = new Map<string, ReturnType<typeof presentItem> | ReturnType<typeof archivedRow>>(items.map((item) => [item.id, presentItem(item)]));
    for (const doc of search.docs()) if (!rows.has(doc.itemId)) rows.set(doc.itemId, archivedRow(doc));
    // Names from every row search can return, archived ones too, so agent: and in: resolve for them (Codex review on #799).
    const agents = [...new Map([...rows.values()].map((row) => {
      const own = (row.facts as { agentSpace?: { id: string; name: string } | null } | undefined)?.agentSpace;
      const id = queryAgentId(row) || row.agentId;
      return [id, { id, name: own?.name || row.agentName }];
    })).values()].filter((a) => a.id);
    const fields = parseSearchFields(q, [...projects.map((p) => ({ id: `project:${p.id}`, name: p.name })), ...agents.map((a) => ({ ...a, id: `agent:${a.id}` }))], agents);
    const hidden = coordinatorItemIds(core.store.setting('coordinators'));
    const eligibleFor = (q: typeof query) => new Set([...rows].filter(([id, row]) => !hidden.has(id) && searchMatches(row, [q], fields, { projects })).map(([id]) => id));
    // include=open (the desk's search box and ⌘K): open conversations only, with a count of what done and
    // archived ones would add (`wider`). include=all (the link that widens): everything, keeping every open result
    // the open search showed. Absent: everything, as before (voice asks this way).
    const include = c.req.query('include');
    const open = include === 'open' || include === 'all' ? openOnly(query) : null;
    const limit = Number(c.req.query('limit') ?? 100) || 100;
    // Both runs, and the widened search the link then shows (include=all), reach equally far down: the open run's
    // matches are among the wide run's, and open + wider is what the widened search counts.
    const narrowed = c.req.query('include') !== undefined || Object.keys(query.where).length > 0 || query.scope.kind !== 'global' || query.audience === 'owner' || fields.queries.length > 0 || fields.before !== undefined || fields.after !== undefined;
    const wideSet = eligibleFor(query);
    // The open run decides its candidates as the wide run does (basis): its matches are exactly the wide run's open ones.
    const run = (eligible: Set<string>, keep?: Set<string>) => search.search(fields.text, { limit, semantic: c.req.query('semantic') !== '0', eligible: (id) => eligible.has(id), basis: (id) => wideSet.has(id), ...(keep ? { keep: (id: string) => keep.has(id) } : {}), narrowed });
    // One after the other: the second finds the query's embedding cached.
    const openRun = open ? await run(eligibleFor(open)) : null;
    // Widened, each open result stays on the page even below the limit: widening only adds (Codex review on #865).
    const result = openRun && include === 'open' ? openRun : await run(wideSet, openRun ? new Set(openRun.hits.map((hit) => hit.itemId)) : undefined);
    const wide = openRun && include === 'open' ? await run(wideSet) : null;
    const hits = result.hits.map((hit) => ({ ...hit, row: rows.get(hit.itemId)! }));
    return c.json({ ...result, query: q, tokens: fields.tokens, hits, ...(wide ? { wider: { total: Math.max(0, wide.total - result.total), more: wide.more } } : {}) });
  });

  /** A conversation's full transcript as search keeps it: `?around=<messageId>` (a match), `before=`, `after=`, `limit=`. */
  app.get('/api/desk/search/transcript/:id', (c) => {
    const search = options.search;
    if (!search) return c.json({ error: 'search is not set up' }, 404);
    const id = c.req.param('id');
    if (coordinatorItemIds(core.store.setting('coordinators')).has(id)) return c.json({ error: 'not found' }, 404);
    const item = core.item(id);
    const doc = item ? null : search.doc(id);
    if (!item && !doc) return c.json({ error: 'not found' }, 404);
    const page = search.transcript(id, {
      around: c.req.query('around') || undefined,
      before: c.req.query('before') || undefined,
      after: c.req.query('after') || undefined,
      limit: Number(c.req.query('limit') ?? 80) || 80,
    });
    return c.json({ row: item ? presentItem(item) : archivedRow(doc!), ...page });
  });

  app.get('/api/desk/items/:id', (c) => {
    if (coordinatorItemIds(core.store.setting('coordinators')).has(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
    const detail = itemDetail(core, c.req.param('id'), options.scenes(), options.prototypes?.() ?? []);
    return detail ? c.json({ ...detail, ...(options.mail ? { mailDrafts: options.mail.drafts(c.req.param('id')) } : {}) }) : c.json({ error: 'not found' }, 404);
  });

  app.get('/api/desk/activity', (c) => c.json({ events: activityFeed(core, Number(c.req.query('limit') ?? 50) || 50) }));

  app.get('/api/desk/briefing', (c) => c.json(briefing(core)));

  /** The owner's move items, oldest wait first: what "next one" / "what's next" work through. */
  app.get('/api/desk/next', (c) => c.json({ items: nextUpQueue(core) }));

  app.get('/api/desk/settings', (c) => c.json(settings()));

  /** The news feed as the owner's feed settings show it, newest first. */
  app.get('/api/desk/feed', (c) => {
    if (!options.feed) return c.json({ posts: [] });
    const limit = Number(c.req.query('limit') ?? 60) || 60;
    const coordinatorThreads = coordinatorItemIds(core.store.setting('coordinators'));
    const hidden = (itemId: string) => coordinatorThreads.has(itemId) || !!core.store.item(itemId)?.hidden;
    const scope = c.req.query('scope') || 'everything';
    if (!/^(everything|tab:.+|space:(project|agent):.+)$/.test(scope)) return c.json({ error: 'invalid feed scope' }, 400);
    const items = new Map(core.items().map((item) => [item.id, item]));
    const ctx = { listViews: readListViews(core.store.setting('list_views')), projects: readProjects(core.store.setting('projects')), now: Date.now() };
    const settings = readFeedSettings(core.store.setting('feed'));
    const posts = options.feed.recent({ limit, settings, hidden, projectOf: (itemId) => items.get(itemId)?.facts.projectId ?? null, matches: (post) => postInFeedScope(post, items.get(post.itemId || ''), scope, ctx) && (settings.needsYou || !closedBareState(post, items.get(post.itemId || ''), ctx.now)) });
    return c.json({ posts });
  });


  /** `{ sweepDay?, filters?, agentIcons?, repoIcons?, labelOrder?, snoozeTimes?, listViews?, projects?, projectSectionsHidden? }`: what is given changes (filters replace the stored ones whole); every screen gets a `settings` event. */
  app.post('/api/desk/settings', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'JSON object body required' }, 400);
    if (body.sweepDay !== undefined && body.sweepDay !== 'saturday' && body.sweepDay !== 'monday') return c.json({ error: 'sweepDay must be saturday or monday' }, 400);
    let filters: DeskFilters | undefined;
    if (body.filters !== undefined) {
      const parsed = parseFilters(body.filters);
      if ('error' in parsed) return c.json({ error: parsed.error }, 400);
      filters = parsed.filters;
    }
    let agentIcons: Record<string, AgentIcon> | undefined;
    if (body.agentIcons !== undefined) {
      const parsed = parseAgentIcons(body.agentIcons, readAgentIcons(core.store.setting('agent_icons')));
      if ('error' in parsed) return c.json({ error: parsed.error }, 400);
      agentIcons = parsed.icons;
    }
    let repoIcons: Record<string, AgentIcon> | undefined;
    if (body.repoIcons !== undefined) {
      const parsed = parseRepoIcons(body.repoIcons, readAgentIcons(core.store.setting('repo_icons')));
      if ('error' in parsed) return c.json({ error: parsed.error }, 400);
      repoIcons = parsed.icons;
    }
    let spaceViews: SpaceView[] | null | undefined;
    if (body.spaceViews !== undefined) {
      const parsed = parseSpaceViews(body.spaceViews);
      if ('error' in parsed) return c.json({ error: parsed.error }, 400);
      spaceViews = parsed.views;
    }
    let listViews: ListViewSpec[] | null | undefined;
    if (body.listViews !== undefined) {
      const parsed = parseListViews(body.listViews);
      if ('error' in parsed) return c.json({ error: parsed.error }, 400);
      listViews = parsed.views;
    }
    let projects: DeskProject[] | undefined;
    if (body.projects !== undefined) {
      const parsed = parseProjects(body.projects);
      if ('error' in parsed) return c.json({ error: parsed.error }, 400);
      projects = parsed.projects;
      // The whole list replaces the stored one: only from a screen that saw the latest (Codex review on #522).
      if (body.projectsRev !== undefined && Number(body.projectsRev) !== Number(core.store.setting('projects_rev') ?? 0)) {
        return c.json({ error: 'Projects changed on another screen; look again, then save', ...settings() }, 409);
      }
    }
    let feedSettings: FeedSettings | undefined;
    if (body.feed !== undefined) {
      const parsed = parseFeedSettings(body.feed, readFeedSettings(core.store.setting('feed')));
      if ('error' in parsed) return c.json({ error: parsed.error }, 400);
      feedSettings = parsed.settings;
    }
    let labelOrder: ListSection[] | undefined;
    if (body.labelOrder !== undefined) {
      const parsed = parseLabelOrder(body.labelOrder);
      if ('error' in parsed) return c.json({ error: parsed.error }, 400);
      labelOrder = parsed.order;
    }
    let snoozeTimes: SnoozeTimes | undefined;
    if (body.snoozeTimes !== undefined) {
      const parsed = parseSnoozeTimes(body.snoozeTimes, readSnoozeTimes(core.store.setting('snooze_times')));
      if ('error' in parsed) return c.json({ error: parsed.error }, 400);
      snoozeTimes = parsed.times;
    }
    let spaces: Record<string, SpaceRecord> | undefined;
    if (body.spaces !== undefined) {
      const parsed = parseSpaces(body.spaces, readSpaces(core.store.setting('spaces')));
      if ('error' in parsed) return c.json({ error: parsed.error }, 400);
      spaces = parsed.spaces;
    }
    let projectSectionsHidden: ProjectSection[] | undefined;
    if (body.projectSectionsHidden !== undefined) {
      const parsed = parseHiddenSections(body.projectSectionsHidden);
      if (!parsed) return c.json({ error: `projectSectionsHidden must list some of ${PROJECT_SECTIONS.join(', ')}` }, 400);
      projectSectionsHidden = parsed;
    }
    if (body.sweepDay !== undefined) core.store.setSetting('sweep_day', body.sweepDay as string);
    if (snoozeTimes) core.store.setSetting('snooze_times', JSON.stringify(snoozeTimes));
    if (feedSettings) core.store.setSetting('feed', JSON.stringify(feedSettings));
    if (filters) writeFilters(core.store, filters);
    if (agentIcons) core.store.setSetting('agent_icons', JSON.stringify(agentIcons));
    if (spaces) core.store.setSetting('spaces', JSON.stringify(spaces));
    if (repoIcons) core.store.setSetting('repo_icons', JSON.stringify(repoIcons));
    if (labelOrder) core.store.setSetting('label_order', JSON.stringify(labelOrder));
    if (spaceViews !== undefined) core.store.setSetting('space_views', JSON.stringify(spaceViews));
    if (listViews !== undefined) core.store.setSetting('list_views', JSON.stringify(listViews));
    if (projects) {
      const before = new Map(readProjects(core.store.setting('projects')).map((p) => [p.id, p.parent ?? null]));
      core.store.setSetting('projects', JSON.stringify(projects));
      core.store.setSetting('projects_rev', String(Number(core.store.setting('projects_rev') ?? 0) + 1));
      // A project moved under a parent (or out of one) may be held by a different project now: its conversations are re-read.
      const moved = new Set(projects.filter((p) => before.has(p.id) && before.get(p.id) !== (p.parent ?? null)).map((p) => p.id));
      if (moved.size) {
        for (const item of core.store.items()) if (moved.has(item.facts.projectId ?? '')) core.touch(item.id);
        core.flush();
      }
    }
    if (projectSectionsHidden) core.store.setSetting('project_sections_hidden', JSON.stringify(projectSectionsHidden));
    const next = settings();
    if (body.sweepDay !== undefined || filters || agentIcons || repoIcons || labelOrder || snoozeTimes || spaceViews !== undefined || listViews !== undefined || projects || projectSectionsHidden || feedSettings || spaces) for (const listener of settingsListeners) listener(next);
    return c.json(next);
  });

  /**
   * A project as a whole (core.projectAction): `{ action: snooze, until? | trigger? }`, `{ action: park }`,
   * `{ action: wake }` or `{ action: finish, how: done | out, children?: finish | keep }`. Every screen gets a `settings` event.
   */
  app.post('/api/desk/projects/:id/action', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return c.json({ error: 'JSON object body required' }, 400);
    const action = body.action;
    if (action !== 'snooze' && action !== 'park' && action !== 'wake' && action !== 'finish') return c.json({ error: 'action must be snooze, park, wake or finish' }, 400);
    const until = typeof body.until === 'string' ? Date.parse(body.until) : typeof body.until === 'number' ? body.until : null;
    const trigger = body.trigger === 'desk' || body.trigger === 'agent_posts' ? body.trigger : null;
    const how = body.how === 'out' ? 'out' : 'done';
    // Finishing a parent: its open child projects finish with it, or stay open and move up (docs/specs/spaces.md, Nesting).
    const children = body.children === 'finish' ? 'finish' : 'keep';
    try {
      // The desk tells every screen itself (onProjectsChanged, below).
      return c.json(await core.projectAction(c.req.param('id'), { action, until, trigger, how, children }));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // ── project coordinators (desk/coordinator.ts) ──
  const coordinators = options.coordinators;
  const noCoordinators = (c: Context) => c.json({ error: 'project coordinators are not set up' }, 404);

  /** Every project that has a coordinator: the folder line, the status card and the panel header. */
  app.get('/api/desk/coordinators', (c) => (coordinators ? c.json({ coordinators: coordinators.summaries() }) : c.json({ coordinators: [] })));

  /** The panel: questions and answers, drafts, digests. `?catchUp=1` (the project page opened) rewrites a stale status. */
  app.get('/api/desk/projects/:id/coordinator', async (c) => {
    if (!coordinators) return noCoordinators(c);
    const view = await coordinators.view(c.req.param('id'), { catchUp: c.req.query('catchUp') === '1' });
    return view ? c.json(view) : c.json({ error: 'no such project' }, 404);
  });

  /** `{ text, fromItemId? }`: the owner's question (the first one starts the coordinator). */
  app.post('/api/desk/projects/:id/coordinator/ask', async (c) => {
    if (!coordinators) return noCoordinators(c);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const text = str(body?.text);
    if (!text) return c.json({ error: 'text is required' }, 400);
    const result = await coordinators.ask(c.req.param('id'), text.slice(0, 4000), str(body?.fromItemId) ?? null, str(body?.commandId)?.slice(0, 80));
    return result.ok ? c.json(result) : c.json(result, 400);
  });

  /** `{ on?, stands?, flags?, digest?, reach? }`: Keep watch and how questions reach conversations. */
  app.post('/api/desk/projects/:id/coordinator/watch', async (c) => {
    if (!coordinators) return noCoordinators(c);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return c.json({ error: 'JSON object body required' }, 400);
    const patch: Parameters<ProjectCoordinators['setWatch']>[1] = {};
    for (const key of ['on', 'stands', 'flags', 'digest'] as const) if (typeof body[key] === 'boolean') patch[key] = body[key] as boolean;
    if (body.reach !== undefined) {
      if (body.reach !== 'approve' && body.reach !== 'idle') return c.json({ error: 'reach must be approve or idle' }, 400);
      patch.reach = body.reach;
    }
    const summary = coordinators.setWatch(c.req.param('id'), patch);
    return summary ? c.json(summary) : c.json({ error: 'no such project' }, 404);
  });

  /** `{ action: send | now | drop, text? }`: the owner's call on a drafted question. */
  app.post('/api/desk/projects/:id/coordinator/drafts/:draftId', async (c) => {
    if (!coordinators) return noCoordinators(c);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const action = body?.action;
    if (action !== 'send' && action !== 'now' && action !== 'drop') return c.json({ error: 'action must be send, now or drop' }, 400);
    const text = typeof body?.text === 'string' ? body.text : undefined;
    const result = await coordinators.draftAction(c.req.param('id'), c.req.param('draftId'), action, text);
    return result.ok ? c.json(result) : c.json(result, 400);
  });

  /** The coordinator's own reads and drafts (`tango-screen coordinator …`): this machine only. */
  app.get('/api/desk/projects/:id/coordinator/context', (c) => {
    if (!coordinators) return noCoordinators(c);
    if (!isLocal(c)) return c.json({ error: 'local callers only' }, 403);
    const context = coordinators.context(c.req.param('id'));
    return context ? c.json(context) : c.json({ error: 'no such project' }, 404);
  });
  /** One of the project's conversations, for its coordinator: only a conversation in that project. */
  app.get('/api/desk/projects/:id/coordinator/transcript/:itemId', (c) => {
    if (!coordinators) return noCoordinators(c);
    if (!isLocal(c)) return c.json({ error: 'local callers only' }, 403);
    const itemId = c.req.param('itemId');
    if (coordinatorItemIds(core.store.setting('coordinators')).has(itemId)) return c.json({ error: 'not a conversation in this project' }, 404);
    // Open or done; one the desk has let go of (done over 30 days ago) by search's copy.
    const item = core.item(itemId);
    const projectOf = item ? item.facts.projectId : options.search?.doc(itemId)?.facts.projectId;
    if (projectOf !== c.req.param('id')) return c.json({ error: 'not a conversation in this project' }, 404);
    if (!options.search) return c.json({ messages: core.store.messages(itemId, 40) });
    return c.json(options.search.transcript(itemId, { limit: Math.min(200, Number(c.req.query('limit') ?? 40) || 40) }));
  });
  app.post('/api/desk/projects/:id/coordinator/drafts', async (c) => {
    if (!coordinators) return noCoordinators(c);
    if (!isLocal(c)) return c.json({ error: 'local callers only' }, 403);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const to = str(body?.to);
    const text = str(body?.text);
    if (!to || !text) return c.json({ error: 'to and text are required' }, 400);
    const result = coordinators.draft(c.req.param('id'), to, text);
    return result.ok ? c.json(result) : c.json(result, 400);
  });

  // ── desk mail (desk/mail.ts): agents' conversations writing to each other, this machine only ──

  const labFences = options.labFences ?? new LabFences();
  const fenced = (c: Context, reason: string) => c.json({ ok: false, error: `blocked by the lab fence: ${reason}` }, 403);
  /** `{ sessionId, scratch: [itemId…], ttlMs? }`: a voice lab session fences its scratch threads in (renewed while it runs). */
  app.post('/api/desk/lab-fence', async (c) => {
    if (!isLocal(c)) return c.json({ error: 'local callers only' }, 403);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const sessionId = str(body?.sessionId);
    const scratch = Array.isArray(body?.scratch) ? body.scratch.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
    if (!sessionId || scratch.length === 0) return c.json({ error: 'sessionId and scratch (item ids) are required' }, 400);
    // Refused, never truncated: a fence that silently left an item out would leave that agent free (Codex review on #768).
    if (scratch.length > LAB_FENCE_MAX_ITEMS) return c.json({ error: `at most ${LAB_FENCE_MAX_ITEMS} scratch items per fence` }, 400);
    // Scratch threads never reach the owner's catch-up, even after the fence lapses.
    options.updates?.markScratch(scratch);
    return c.json({ ok: true, fence: labFences.set(sessionId, scratch, typeof body?.ttlMs === 'number' ? body.ttlMs : undefined) });
  });
  app.delete('/api/desk/lab-fence/:sessionId', (c) => {
    if (!isLocal(c)) return c.json({ error: 'local callers only' }, 403);
    return c.json({ ok: true, cleared: labFences.clear(c.req.param('sessionId')) });
  });
  app.get('/api/desk/lab-fence', (c) => c.json({ fences: labFences.active() }));

  const noMail = (c: Context) => c.json({ error: 'desk mail is not set up' }, 503);
  /** A Tango agent's conversation the desk doesn't follow (a -test or other side channel): nowhere to send from or bring an answer back to. */
  const unfollowed = 'this conversation isn’t on the owner’s desk (the desk follows agents’ home channels and their threads), so it can’t send mail or start threads; reading threads and peeking still work';
  /** The calling conversation: an item id, or a conversation key (a Tango agent's `thread:<id>` / `channel:<id>`). */
  const sender = (body: Record<string, unknown> | null | undefined, query?: (name: string) => string | undefined): string | undefined => {
    const id = str(body?.from) ?? str(query?.('item'));
    if (id) return id;
    const key = str(body?.fromConversationKey) ?? str(query?.('conversationKey'));
    return key ? core.itemForConversation(key)?.id : undefined;
  };
  /** Every conversation an agent may write to: `?project=&status=&agent=&all=1&limit=`. */
  app.get('/api/desk/mail/threads', (c) => {
    if (!options.mail) return noMail(c);
    if (!isLocal(c)) return c.json({ error: 'local callers only' }, 403);
    const limit = Number(c.req.query('limit') ?? '') || undefined;
    const you = str(c.req.query('conversationKey')) ? sender(null, (name) => (name === 'conversationKey' ? c.req.query(name) : undefined)) : undefined;
    return c.json({ threads: options.mail.threads({ project: str(c.req.query('project')), status: str(c.req.query('status')), agent: str(c.req.query('agent')), all: c.req.query('all') === '1', limit }), ...(you ? { you } : {}) });
  });
  app.get('/api/desk/mail/peek/:itemId', (c) => {
    if (!options.mail) return noMail(c);
    if (!isLocal(c)) return c.json({ error: 'local callers only' }, 403);
    const peek = options.mail.peek(c.req.param('itemId'), Number(c.req.query('limit') ?? 12) || 12);
    return peek ? c.json(peek) : c.json({ error: 'no such conversation' }, 404);
  });
  /** `{ from, to, text, expect?: reply|none, now?, wake? }`: `from` is the sending conversation's item id. */
  app.post('/api/desk/mail', async (c) => {
    if (!options.mail) return noMail(c);
    if (!isLocal(c)) return c.json({ error: 'local callers only' }, 403);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!sender(body) && str(body?.fromConversationKey)) return c.json({ error: unfollowed }, 400);
    const from = sender(body);
    const to = str(body?.to);
    const text = str(body?.text);
    if (!from || !to || !text) return c.json({ error: 'from (or fromConversationKey), to and text are required' }, 400);
    const blockedSend = labFences.checkWrite(from, to);
    if (blockedSend) return fenced(c, blockedSend);
    const expect = body?.expect === 'none' ? 'none' : 'reply';
    const result = options.mail.send({ from, to, text, expect, now: body?.now === true, wake: body?.wake === true });
    return result.ok ? c.json({ ok: true, mail: options.mail.view(result.mail) }) : c.json(result, 400);
  });
  app.post('/api/desk/mail/:id/draft', async (c) => {
    if (isLocal(c) || c.req.header('x-desk-window') === 'detached' || !c.req.header('tailscale-headers-info')?.trim() || !isAllowedOwnerLogin(c.req.header('tailscale-user-login'), process.env.SCREEN_ALLOWED_LOGINS)) {
      return c.json({ error: 'only the owner’s authenticated window may approve or discard mail' }, 403);
    }
    if (!options.mail) return noMail(c);
    const body = await c.req.json().catch(() => null);
    if (!body || !['send', 'drop'].includes(body.action) || (body.text !== undefined && typeof body.text !== 'string')) return c.json({ error: 'action must be send or drop; text must be a string' }, 400);
    const result = options.mail.draftAction(c.req.param('id'), body.action, body.text);
    return result.ok ? c.json(result) : c.json(result, 400);
  });
  /**
   * A conversation starts a new thread: `{ from | fromConversationKey, prompt, title?, repo?, projectId?
   * (null: none), account?, mode?, report? }`. Its first answer comes back to the starter as mail.
   */
  app.post('/api/desk/mail/start', async (c) => {
    if (!options.mail) return noMail(c);
    if (!isLocal(c)) return c.json({ error: 'local callers only' }, 403);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!sender(body) && str(body?.fromConversationKey)) return c.json({ error: unfollowed }, 400);
    const from = sender(body);
    const prompt = str(body?.prompt);
    if (!from || !prompt) return c.json({ error: 'from (or fromConversationKey) and prompt are required' }, 400);
    const blockedStart = labFences.checkStart(from);
    if (blockedStart) return fenced(c, blockedStart);
    if (body?.tier !== undefined && (typeof body.tier !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(body.tier))) return c.json({ error: 'invalid tier' }, 400);
    if (body?.role !== undefined && !isThreadRole(body.role)) return c.json({ error: `role must be one of ${THREAD_ROLES.join(', ')}` }, 400);
    if (body?.sameTree !== undefined && typeof body.sameTree !== 'boolean') return c.json({ error: 'sameTree must be a boolean' }, 400);
    const result = await options.mail.start({
      from,
      prompt,
      title: str(body?.title),
      repo: str(body?.repo),
      projectId: body?.projectId === null ? null : str(body?.projectId),
      account: str(body?.account),
      mode: str(body?.mode),
      ...(body?.sameTree === true ? { sameTree: true } : {}),
      report: body?.report !== false,
      commandId: str(body?.commandId),
      ...(isThreadRole(body?.role) ? { role: body.role } : {}),
      ...(typeof body?.tier === 'string' ? { tier: body.tier } : {}),
    });
    return result.ok ? c.json({ ok: true, itemId: result.itemId, mail: options.mail.view(result.mail), ...(result.projectSkipped ? { projectSkipped: true } : {}) }) : c.json(result, 400);
  });
  /** A conversation's mail, sent and received: `?item=<itemId>`. */
  app.get('/api/desk/mail', (c) => {
    if (!options.mail) return noMail(c);
    if (!isLocal(c)) return c.json({ error: 'local callers only' }, 403);
    const item = sender(null, (name) => c.req.query(name));
    if (!item) return c.json({ error: 'item (or conversationKey) is required' }, 400);
    return c.json({ mail: options.mail.forItem(item, Number(c.req.query('limit') ?? 20) || 20).map((m) => options.mail!.view(m)) });
  });
  /** One mail; `?claim=1` takes its answer (the sender read it with `wait`, so it isn't also relayed as a turn). */
  app.get('/api/desk/mail/:id', (c) => {
    if (!options.mail) return noMail(c);
    if (!isLocal(c)) return c.json({ error: 'local callers only' }, 403);
    const mail = c.req.query('claim') === '1' ? options.mail.claim(c.req.param('id')) : options.mail.get(c.req.param('id'));
    return mail ? c.json(options.mail.view(mail)) : c.json({ error: 'no such mail' }, 404);
  });
  /** The recipient answers mail directly (`tango-screen reply`): `{ from | fromConversationKey, text }`. */
  app.post('/api/desk/mail/:id/answer', async (c) => {
    if (!options.mail) return noMail(c);
    if (!isLocal(c)) return c.json({ error: 'local callers only' }, 403);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!sender(body) && str(body?.fromConversationKey)) return c.json({ error: unfollowed }, 400);
    const from = sender(body);
    const text = str(body?.text);
    if (!from || !text) return c.json({ error: 'from (or fromConversationKey) and text are required' }, 400);
    const answering = options.mail.get(c.req.param('id'));
    const blockedAnswer = answering ? labFences.checkWrite(from, answering.fromItemId) : null;
    if (blockedAnswer) return fenced(c, blockedAnswer);
    const result = options.mail.answer(c.req.param('id'), from, text);
    return result.ok ? c.json({ ok: true, mail: options.mail.view(result.mail) }) : c.json(result, 400);
  });
  /** The owner's switch: `{ itemId | projectId, off: boolean }`. */
  app.post('/api/desk/mail-off', async (c) => {
    if (!options.mail) return noMail(c);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const key = str(body?.itemId) ?? (str(body?.projectId) ? `project:${str(body?.projectId)}` : undefined);
    if (!key || typeof body?.off !== 'boolean') return c.json({ error: 'itemId or projectId, and off, are required' }, 400);
    const off = options.mail.setOff(key, body.off);
    const next = settings();
    for (const listener of settingsListeners) listener(next);
    return c.json({ off });
  });

  /** What can be filtered, from every item (the Everything view), with counts; hidden values stay listed. */
  app.get('/api/desk/facets', (c) => c.json(facetsFor(core.items(), readFilters(core.store))));

  app.post('/api/desk/asks/:askId/resolve', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.commandId !== 'string' || !body.commandId) return c.json({ error: 'commandId is required' }, 400);
    const askId = c.req.param('askId');
    const item = core.items().find(i => (i.facts.askLedger ?? i.facts.openAsk)?.id === askId);
    if (!item) return c.json({ error: 'Ask not found' }, 404);
    const actor: Actor = isLocal(c) && body.by === 'desk' ? 'voice' : 'screen';
    const result = await core.command({ commandId: body.commandId, type: 'ask.resolve', itemId: item.id,
      actor, args: { askId, ...(body.step !== undefined ? { step: body.step } : {}), ...(body.note !== undefined ? { note: body.note } : {}), ...(body.revision !== undefined ? { revision: body.revision } : {}) } });
    return c.json(result);
  });

  app.post('/api/desk/commands', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: 'JSON body required' }, 400);
    const commandId = str(body.commandId);
    const type = str(body.type) as CommandType | undefined;
    if (!commandId) return c.json({ error: 'commandId is required (a client-generated UUID)' }, 400);
    // The System page's commands (incident.*, job.*, process.stop): the ledger's, not an item's.
    if (isSystemCommand(type)) {
      if (!options.system) return c.json({ commandId, status: 'failed', error: 'the desk has no system ledger' });
      const sysArgs = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? (body.args as Record<string, unknown>) : {};
      const done = await options.system.command(type, sysArgs);
      return c.json(done.ok ? { commandId, status: 'applied', outcome: { ...done.outcome, message: done.message } } : { commandId, status: 'failed', error: done.error, ...(done.needsForce ? { outcome: { needsForce: true } } : {}) });
    }
    if (!type || !(COMMAND_TYPES as readonly string[]).includes(type)) return c.json({ error: `type must be one of ${COMMAND_TYPES.join(', ')}` }, 400);
    // Only a local process (the operator, the bot) may say who acted; a browser is always the screen.
    const actor: Actor = isLocal(c) ? (ACTORS.includes(body.actor as Actor) ? (body.actor as Actor) : 'owner') : 'screen';
    const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? (body.args as Record<string, unknown>) : {};
    const result = await core.command({ commandId, type, itemId: str(body.itemId), args, actor });
    // Always 200: the outcome is in `status` (a failed reply is a result, not a transport error).
    return c.json(result);
  });

  /**
   * Watch a PR for its review from inside a conversation (tango-screen watch-pr, the screen tool's
   * watch_pr): the conversation key names the item, so the caller needs no desk item id.
   * Body: { conversationKey | itemId, url, onApprove?: 'continue' | 'notify', off?: boolean }.
   */
  app.post('/api/desk/pr-watch', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: 'JSON body required' }, 400);
    const conversationKey = str(body.conversationKey);
    const itemId = str(body.itemId) ?? (conversationKey ? core.itemForConversation(conversationKey)?.id : undefined);
    if (!itemId) return c.json({ error: conversationKey ? `no desk item for ${conversationKey} yet (it appears once the conversation has a message)` : 'conversationKey or itemId is required' }, 404);
    const actor: Actor = isLocal(c) && ACTORS.includes(body.actor as Actor) ? (body.actor as Actor) : isLocal(c) ? 'agent' : 'screen';
    const result = await core.command({ commandId: str(body.commandId) ?? randomUUID(), type: 'watch', itemId, args: { url: body.url, onApprove: body.onApprove, off: body.off === true }, actor });
    if (result.status === 'failed') return c.json({ error: result.error, itemId }, 400);
    return c.json({ itemId, ...result.outcome });
  });

  /** A screen saw the owner (visible + interaction, ≤ 1/min): after ≥ 10 min idle, "until I'm at my desk" snoozes fire. */
  app.post('/api/desk/presence', (c) => c.json({ ok: true, fired: core.noteScreenActivity() }));

  app.get('/api/desk/operator', (c) => c.json(operator));

  /** The voice operator publishes its status and captions (local only); screens get them as `operator` events. */
  app.post('/api/desk/operator', async (c) => {
    if (!isBotCaller(c, options.collaborationToken)) return c.json({ error: 'forbidden' }, 403);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: 'JSON body required' }, 400);
    const raw = body.transcript as Record<string, unknown> | null | undefined;
    const transcript =
      raw && typeof raw === 'object' && typeof raw.text === 'string' && raw.text.trim()
        ? {
            // The voice operator says `user` for the owner.
            speaker: raw.speaker === 'user' ? 'owner' : SPEAKERS.includes(raw.speaker as (typeof SPEAKERS)[number]) ? (raw.speaker as (typeof SPEAKERS)[number]) : 'agent',
            name: str(raw.name) ?? null,
            // A long line keeps its end: the newest words are the ones being said.
            text: clipStart(raw.text.trim(), 500),
            final: raw.final !== false,
          }
        : null;
    const live = body.live === true;
    operator = {
      live,
      status: live ? (OPERATOR_STATUSES.includes(body.status as OperatorStatus['status']) ? (body.status as OperatorStatus['status']) : 'listening') : 'idle',
      agentName: str(body.agentName) ?? null,
      transcript,
      at: Date.now(),
    };
    for (const listener of operatorListeners) listener(operator);
    return c.json(operator);
  });

  // ── draft mode: the operator's Draft card (draft.ts) ───────────────────
  app.get('/api/desk/draft', (c) => c.json(draft.current()));

  /** The voice operator publishes its Draft card (local only); screens get it as `draft` events. */
  app.post('/api/desk/draft', async (c) => {
    if (!isBotCaller(c, options.collaborationToken)) return c.json({ error: 'forbidden' }, 403);
    const posted = parseDraftPost(await c.req.json().catch(() => null));
    if (!posted) return c.json({ error: 'a draft card object is required' }, 400);
    return c.json(draft.set(posted.card, posted.clears));
  });

  /** Send / Cancel / Dismiss from the card: send and cancel are relayed to the operator as `draftCommand`. */
  app.post('/api/desk/draft/command', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const result = draft.command(body?.action, body?.draftId);
    return c.json(result.body, result.status as 200);
  });

  // ── start work: a new Loom thread (start-work.ts) ─────────────────────────
  /**
   * Started as a worker or a job (the sheet's Kind): who it reports to, a conversation on the desk (docs/specs/spaces.md,
   * Two relations). Null for a thread; an error when a worker or job names no owner, or one the desk doesn't hold.
   */
  const reportsFrom = (body: Record<string, unknown> | null, space: string | null): { role: 'worker' | 'ops'; parentItemId: string } | { error: string } | null => {
    const role = body?.role;
    if (role === undefined || role === null || role === 'interactive') return null;
    if (role !== 'worker' && role !== 'ops') return { error: 'role must be interactive, worker or ops' };
    const parentItemId = str(body?.parentItemId);
    if (!parentItemId) return { error: `a ${role === 'ops' ? 'job' : 'worker'} needs a conversation it reports to` };
    const wrong = core.reportTargetError(parentItemId, space);
    if (wrong) return { error: wrong };
    return { role, parentItemId };
  };
  /** The new conversation's kind, kept on the desk as the ⋯ menu's Kind keeps it (roles.ts); Loom already has it from the start. */
  const keepRole = async (itemId: string, reports: { role: 'worker' | 'ops'; parentItemId: string } | null, space: string | null) => {
    if (!reports) return;
    // Checked again after the start: its owner may have finished or moved, or its project finished, meanwhile. Then
    // it reports to where it landed's lead, else no one, and Loom is told too (Codex review on #854).
    if (!core.reportTargetError(reports.parentItemId, space)) {
      core.roles.set(itemId, reports, 'owner', Date.now());
      core.roles.invalidate();
      return;
    }
    const fixed = { role: reports.role, parentItemId: core.spaceLead(space) };
    if (core.item(itemId)) {
      await core.command({ commandId: randomUUID(), type: 'role', itemId, args: fixed, actor: 'system' }).catch(() => {});
    } else {
      core.roles.set(itemId, fixed, 'system', Date.now());
      core.roles.invalidate();
    }
  };
  const startRequest = (body: Record<string, unknown> | null): StartWorkRequest => ({
    repo: str(body?.repo),
    prompt: str(body?.prompt),
    title: str(body?.title),
    account: str(body?.account),
    pin: str(body?.pin),
    mode: str(body?.mode),
    plan: body?.plan === true,
    commandId: str(body?.commandId),
    ...(Array.isArray(body?.attachments) ? { attachments: parseAttachments(body.attachments) } : {}),
  });

  /** The repos, accounts, and which fields are required. */
  app.get('/api/desk/start-work', async (c) => {
    const agents = options.agentStart?.service.agents() ?? [];
    // Agent starts use the bot independently of the coding-thread backend.
    const agentsOnly = (repoError: string) => c.json({ repos: [], accounts: [], fields: { required: ['prompt'], defaults: ['title'] }, policyError: null, policyModel: null, agents, repoError });
    if (!options.startWork) return agents.length ? agentsOnly('Start work needs Loom for repos') : c.json({ error: 'Start work needs Loom' }, 503);
    try {
      return c.json({ ...publicOptions(await options.startWork.service.options()), agents });
    } catch (err) {
      const message = `Loom isn't answering (${redactPaths((err as Error).message)})`;
      return agents.length ? agentsOnly(message) : c.json({ error: message }, 502);
    }
  });

  /** `{ repo?, prompt?, title?, account?, mode?, plan? }` → what it resolves to and what is missing; starts nothing. */
  app.post('/api/desk/start-work/check', async (c) => {
    if (!options.startWork) return c.json({ error: 'Start work needs Loom' }, 503);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    try {
      return c.json(publicCheck(await options.startWork.service.check(startRequest(body))));
    } catch (err) {
      return c.json({ error: `Loom isn't answering (${redactPaths((err as Error).message)})` }, 502);
    }
  });

  /** Starts the thread when nothing required is missing; 422 with the check when something is, 502 when T3 refused. */
  app.post('/api/desk/start-work', async (c) => {
    if (!options.startWork) return c.json({ error: 'Start work needs Loom' }, 503);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: 'JSON body required' }, 400);
    // Started from inside a project: refused before T3 makes the thread if that project is gone or finished
    // since the sheet opened, so it never lands outside the project it promised (Codex review on #522).
    const projectId = typeof body.projectId === 'string' && body.projectId ? body.projectId : null;
    if (projectId) {
      const project = readProjects(core.store.setting('projects')).find((p) => p.id === projectId);
      if (!project || project.finishedAt) return c.json({ error: project ? `${project.name} is finished; reopen it or start this on its own` : 'that project was deleted; start this on its own' }, 409);
    }
    const reports = reportsFrom(body, projectId ? `project:${projectId}` : null);
    if (reports && 'error' in reports) return c.json({ error: reports.error }, 422);
    // On Loom the parent goes in with the start, as `tango-screen start` sends it (start-work.ts launchOnLoom).
    const result = await options.startWork.service.start({ ...startRequest(body), ...(reports ?? {}) });
    if (result.ok) {
      // Started from inside a project: the new thread joins it when T3 first reports it.
      // Finished or deleted while T3 made the thread: it started, on its own, and the answer says so (Codex review on #522).
      const joined = projectId ? core.assignProject(result.itemId, projectId) : null;
      await keepRole(result.itemId, reports, projectId && joined !== false ? `project:${projectId}` : null);
      options.startWork.afterStart?.();
      return c.json({ ...publicResult(result), ...(joined === false ? { projectSkipped: true } : {}) });
    }
    return c.json(publicResult(result), result.check && !result.check.ready ? 422 : 502);
  });

  /** `{ agentId, prompt, title?, attachments?, projectId?, commandId }`: a new thread with that agent. */
  app.post('/api/desk/agent-threads', async (c) => {
    if (!options.agentStart) return c.json({ error: 'Starting agent threads needs the bot' }, 503);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: 'JSON body required' }, 400);
    const projectId = typeof body.projectId === 'string' && body.projectId ? body.projectId : null;
    if (projectId) {
      const project = readProjects(core.store.setting('projects')).find((p) => p.id === projectId);
      if (!project || project.finishedAt) return c.json({ error: project ? `${project.name} is finished; reopen it or start this on its own` : 'that project was deleted; start this on its own' }, 409);
    }
    const agentSpace = personaId(str(body.agentId) ?? '');
    const reports = reportsFrom(body, projectId ? `project:${projectId}` : agentSpace ? `agent:${agentSpace}` : null);
    if (reports && 'error' in reports) return c.json({ error: reports.error }, 422);
    const result = await options.agentStart.service.start({
      agentId: str(body.agentId),
      prompt: str(body.prompt),
      title: str(body.title),
      commandId: str(body.commandId),
      ...(Array.isArray(body.attachments) ? { attachments: parseAttachments(body.attachments) } : {}),
    });
    if (!result.ok) return c.json({ error: result.error }, result.status as 422);
    const joined = projectId ? core.assignProject(result.itemId, projectId) : null;
    await keepRole(result.itemId, reports, projectId && joined !== false ? `project:${projectId}` : agentSpace ? `agent:${agentSpace}` : null);
    options.agentStart.afterStart?.();
    return c.json({ ...result, ...(joined === false ? { projectSkipped: true } : {}) });
  });

  // ── the System page (system.ts) ────────────────────────────────────────
  /** Summary, health, incidents, jobs with their last runs, recent events and the capacity snapshot. `?retired=1` adds retired jobs. */
  let systemCache: { body: string; etag: string; value: unknown } | null = null;
  app.get('/api/desk/system', async (c) => {
    if (!options.system) return c.json({ error: 'the desk has no system ledger' }, 404);
    const snapshot = await options.system.snapshot({ retired: c.req.query('retired') === '1' });
    if (!systemCache || systemCache.value !== snapshot) {
      const body = JSON.stringify(snapshot);
      systemCache = { body, etag: `"${createHash('sha1').update(body).digest('base64url')}"`, value: snapshot };
    }
    const headers = { ETag: systemCache.etag, 'Cache-Control': 'no-cache' };
    if (c.req.header('if-none-match') === systemCache.etag) return c.body(null, 304, headers);
    return c.body(systemCache.body, 200, { ...headers, 'Content-Type': 'application/json; charset=UTF-8' });
  });

  /** One job: its runs (50), incidents, and the tail of its log (redacted). */
  app.get('/api/desk/system/jobs/:id', (c) => {
    if (!options.system) return c.json({ error: 'the desk has no system ledger' }, 404);
    const detail = options.system.jobDetail(c.req.param('id'));
    return detail ? c.json(detail) : c.json({ error: 'no such job' }, 404);
  });

  /** The raw event stream, newest first: `?beforeId=&severity=error,critical&source=&job=&limit=`. */
  app.get('/api/desk/system/events', (c) => {
    if (!options.system) return c.json({ error: 'the desk has no system ledger' }, 404);
    const beforeId = Number(c.req.query('beforeId'));
    const severity = (c.req.query('severity') ?? '').split(',').map((x) => x.trim()).filter((x): x is Severity => ['critical', 'error', 'warning', 'info', 'recovery'].includes(x));
    const source = str(c.req.query('source'));
    const jobId = str(c.req.query('job'));
    const events = options.system.events({
      ...(Number.isInteger(beforeId) && beforeId > 0 ? { beforeId } : {}),
      ...(severity.length ? { severity } : {}),
      ...(source ? { source } : {}),
      ...(jobId ? { jobId } : {}),
      limit: Math.min(Number(c.req.query('limit') ?? 100) || 100, 500),
    });
    return c.json({ events });
  });

  /** "What's broken?" for the voice operator: the status line and the open incidents' titles. */
  app.get('/api/desk/system/brief', async (c) => {
    if (!options.system) return c.json({ error: 'the desk has no system ledger' }, 404);
    return c.json(await options.system.brief());
  });

  // ── catch-up ledger (updates.ts) ────────────────────────────────────────
  /** `?space=&since=&unseen=1`: current lines, newest first, for one space or all. */
  app.get('/api/desk/updates', (c) => {
    if (!options.updates) return c.json({ error: 'the desk has no update ledger' }, 404);
    const since = Number(c.req.query('since'));
    const updates = options.updates.list({
      ...(c.req.query('space') ? { space: c.req.query('space') } : {}),
      ...(Number.isFinite(since) && since > 0 ? { since } : {}),
      unseen: c.req.query('unseen') === '1',
    });
    return c.json({ updates });
  });

  /** `?itemId=&since=`: the turn preamble for a lead (what the owner has seen in its space since then); Loom reads it. */
  app.get('/api/desk/catchup/seen', (c) => {
    if (!options.updates) return c.json({ error: 'the desk has no update ledger' }, 404);
    const itemId = c.req.query('itemId');
    const since = Number(c.req.query('since'));
    if (!itemId || !Number.isFinite(since)) return c.json({ error: 'itemId and since (ms) are required' }, 400);
    return c.json({ text: options.updates.seenBrief(itemId, since) });
  });

  /** Per space: headline, status, counts of moments, briefs waiting and smaller lines, and its state. */
  app.get('/api/desk/chapters', (c) => {
    if (!options.updates) return c.json({ error: 'the desk has no update ledger' }, 404);
    return c.json({ chapters: options.updates.chapters() });
  });

  /**
   * One space's card (docs/specs/catch-up.md "Project page"): the chapter, its open lines, briefs still waiting on a
   * pick, what was handled lately ("What changed since…") and what Accept would do, with the revision to send back.
   */
  app.get('/api/desk/chapters/:space', (c) => {
    if (!options.updates) return c.json({ error: 'the desk has no update ledger' }, 404);
    const spaceId = c.req.param('space');
    const now = Date.now();
    const plan = planChapter(options.updates, spaceId, core.items(), now);
    const chapter = options.updates.chapters().find((ch) => ch.spaceId === spaceId) ?? null;
    return c.json({ chapter, ...chapterCard(options.updates, spaceId, now), plan });
  });
  /** A space's lines, waiting briefs, what was handled lately, how the card collapses them, and its briefs. */
  const chapterCard = (updates: DeskUpdates, spaceId: string, now: number) => {
    const lines = chapterLines(updates, spaceId, now);
    const all = updates.list({ space: spaceId, limit: 500, awake: true });
    // By id: chapterLines reads its own rows, so the same line is a different object here.
    const open = new Set(lines.map((u) => u.id));
    const waitingAll = all.filter((u) => isWaiting(u) && !open.has(u.id));
    const recent = all.filter((u) => u.seenAt !== null && !isOpen(u, now) && !waitingAll.includes(u)).sort((a, b) => b.seenAt! - a.seenAt!).slice(0, 20);
    // How the card collapses the lines (collapse.ts): moments in order, folded decisions, groups, owner-language titles,
    // and Needs you cleaned up (triage.ts). A waiting line the cleanup folds away leaves `waiting` for `tidied`.
    const view = updates.view(spaceId, lines, waitingAll);
    const out = tidiedIds(view.tidy);
    const waiting = waitingAll.filter((u) => !out.has(u.id));
    const tidied = waitingAll.filter((u) => out.has(u.id));
    return { lines, waiting, recent, view, ...(tidied.length ? { tidied } : {}), briefs: cardBriefs([...lines, ...waiting], core.items()), asks: cardAsks([...lines, ...waiting], core.items()) };
  };

  /**
   * Catch me up by voice (catchup-walk.ts): the focus card and the map, as the page works them out. `?skipped=1,2`
   * (lines passed this session), `focus=` (a line asked for), `space=` ("go to <space>").
   */
  app.get('/api/desk/catchup/walk', (c) => {
    if (!options.updates) return c.json({ error: 'the desk has no update ledger' }, 404);
    const updates = options.updates;
    const ids = (raw: string | undefined) => (raw ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const focus = ids(c.req.query('focus'))[0] ?? null;
    const now = Date.now();
    const walk = catchupWalk(
      { chapters: updates.chapters(), card: (spaceId) => { const plan = planChapter(updates, spaceId, core.items(), now); return { ...chapterCard(updates, spaceId, now), plan: { updateIds: plan.updateIds, revision: plan.revision, line: plan.line } }; }, projects: readProjects(core.store.setting('projects')), agents: options.agents?.list() ?? [] },
      { skipped: ids(c.req.query('skipped')), focus, space: c.req.query('space') || null },
    );
    return c.json(walk);
  });

  // A chapter command's answer, kept by command id: a retry after a lost response gets the first answer back instead
  // of meeting the stale guard (its lines are already handled). In memory, for the last few hundred commands.
  const chapterReceipts = new Map<string, Promise<{ body: Record<string, unknown>; status: 200 | 400 | 409 }>>();
  const chapterReceipt = (key: string, run: () => Promise<{ body: Record<string, unknown>; status: 200 | 400 | 409 }>) => {
    const kept = chapterReceipts.get(key);
    if (kept) return kept;
    const pending = run();
    chapterReceipts.set(key, pending);
    pending.catch(() => chapterReceipts.delete(key));
    while (chapterReceipts.size > 300) chapterReceipts.delete(chapterReceipts.keys().next().value!);
    return pending;
  };

  /** `{ updateIds, revision, commandId? }`: Accept the chapter the owner saw; refused with the new plan when it changed. */
  app.post('/api/desk/chapters/:space/accept', async (c) => {
    if (!options.updates) return c.json({ error: 'the desk has no update ledger' }, 404);
    const updates = options.updates;
    const shown = await chapterRequest(c);
    if ('error' in shown) return c.json({ error: shown.error }, 400);
    const spaceId = c.req.param('space');
    const answer = await chapterReceipt(`accept:${spaceId}:${shown.commandId}`, async () => {
      const plan = planChapter(updates, spaceId, core.items(), Date.now());
      if (stale(plan, shown)) return { body: { error: 'The chapter changed since you saw it', changed: true, plan }, status: 409 };
      const result = await applyAccept({
        updates,
        answer: async (take, commandId) => {
          // The normal answer path, as a tap on the brief would; a candidate is answered "Ask me next time" (no rule).
          const done = await core.command({ commandId, type: 'respond', itemId: take.itemId, actor: 'screen', args: { requestId: `decision:${take.briefId}`, answers: { decision: take.answer }, ...(take.candidate ? { rule: 'next-time' } : {}), ...(take.revision !== null ? { revision: take.revision } : {}) } });
          return done.status === 'failed' ? { ok: false, error: redactPaths(done.error ?? 'not answered') } : { ok: true };
        },
        confirm: (decisionId, commandId) => (options.decided ? options.decided.confirm(decisionId, commandId) : Promise.resolve({ ok: false as const, error: 'Fine by me needs Loom' })),
        done: async (itemId, commandId) => {
          const done = await core.command({ commandId, type: 'done', itemId, actor: 'screen' });
          return done.status === 'failed' ? { ok: false, error: redactPaths(done.error ?? 'not done') } : { ok: true, cleared: (done.outcome as { cleared?: boolean } | undefined)?.cleared === true };
        },
        items: () => core.items(),
      }, plan, shown.commandId);
      return { body: { ok: true, ...result }, status: 200 };
    });
    return c.json(answer.body, answer.status);
  });

  /** `{ updateIds, revision, commandId?, backAt? }`: Snooze the chapter; absent a time, keep next morning. */
  app.post('/api/desk/chapters/:space/defer', async (c) => {
    if (!options.updates) return c.json({ error: 'the desk has no update ledger' }, 404);
    const updates = options.updates;
    const body = await c.req.json().catch(() => null);
    const given = body?.backAt;
    const shown = await chapterRequest({ req: { json: async () => body } });
    if ('error' in shown) return c.json({ error: shown.error }, 400);
    const spaceId = c.req.param('space');
    const answer = await chapterReceipt(`defer:${spaceId}:${shown.commandId}`, async () => {
      const now = Date.now();
      if (given !== undefined && (typeof given !== 'number' || !Number.isFinite(given) || given <= now)) return { body: { error: 'backAt must be a future time (ms)' }, status: 400 };
      const plan = planChapter(updates, spaceId, core.items(), now);
      if (stale(plan, shown)) return { body: { error: 'The chapter changed since you saw it', changed: true, plan }, status: 409 };
      const backAt = given ?? nextMorning(now, readSnoozeTimes(options.core.store.setting('snooze_times')).morning);
      const marked = plan.updateIds.length ? updates.seen(plan.updateIds, 'deferred', 'later', { backAt }) : [];
      return { body: { ok: true, backAt, deferred: marked.length }, status: 200 };
    });
    return c.json(answer.body, answer.status);
  });

  /** `{ decisionId, commandId? }`: Fine by me on something decided for the owner (Loom decision.confirm); its line is handled. */
  app.post('/api/desk/decided/confirm', async (c) => {
    if (!options.decided) return c.json({ error: 'Decided for you needs Loom' }, 404);
    const body = (await c.req.json().catch(() => null)) as { decisionId?: unknown; commandId?: unknown } | null;
    const decisionId = str(body?.decisionId);
    if (!decisionId) return c.json({ error: 'decisionId is required' }, 400);
    const result = await options.decided.confirm(decisionId, str(body?.commandId) || randomUUID());
    const line = result.ok ? options.updates?.latest(`decision:${decisionId}`) : null;
    if (line) options.updates!.seen([line.id], 'acted', 'fine');
    return result.ok ? c.json({ ok: true }) : c.json({ error: redactPaths(result.error), ...(result.unknown ? { unknown: true } : {}) }, result.unknown ? 502 : 409);
  });

  /** `{ ids, via, outcome?, backAt? }`: the owner saw these lines (a deferral comes back at backAt, or next morning). */
  app.post('/api/desk/updates/seen', async (c) => {
    if (!options.updates) return c.json({ error: 'the desk has no update ledger' }, 404);
    const body = (await c.req.json().catch(() => null)) as { ids?: unknown; via?: unknown; outcome?: unknown } | null;
    const ids = Array.isArray(body?.ids) ? body.ids.filter((id): id is number => Number.isInteger(id) && (id as number) > 0) : [];
    const via = SEEN_VIAS.find((v) => v === body?.via);
    if (!ids.length || ids.length !== (body?.ids as unknown[]).length || !via) return c.json({ error: `ids (line ids) and via (${SEEN_VIAS.join(', ')}) are required` }, 400);
    if (body?.outcome !== undefined && body.outcome !== null && (typeof body.outcome !== 'string' || body.outcome.length > 80)) return c.json({ error: 'outcome must be short text' }, 400);
    // A deferral comes back at the given time, or the owner's next morning (Settings' snooze times).
    const now = Date.now();
    const given = (body as { backAt?: unknown }).backAt;
    if (given !== undefined && (typeof given !== 'number' || !Number.isFinite(given) || given <= now)) return c.json({ error: 'backAt must be a future time (ms)' }, 400);
    const backAt = via === 'deferred' ? ((given as number | undefined) ?? nextMorning(now, readSnoozeTimes(options.core.store.setting('snooze_times')).morning)) : null;
    return c.json({ ok: true, updates: options.updates.seen(ids, via, (body?.outcome as string | null | undefined) ?? null, { backAt }) });
  });

  /** Restore only the matching mark left by a catch-up card snooze. */
  app.post('/api/desk/updates/restore-snooze', async (c) => {
    if (!options.updates) return c.json({ error: 'the desk has no update ledger' }, 404);
    const body = await c.req.json().catch(() => null);
    if (!Array.isArray(body?.ids) || !body.ids.length || body.ids.some((id: unknown) => !Number.isInteger(id) || Number(id) <= 0)
      || !(body.backAt === null || (typeof body.backAt === 'number' && Number.isFinite(body.backAt) && body.backAt > 0))
      || !(body.seenAt === null || (typeof body.seenAt === 'number' && Number.isFinite(body.seenAt) && body.seenAt > 0))
      || (body.backAt === null && body.seenAt === null)) return c.json({ error: 'ids and a snooze mark (backAt, seenAt) are required' }, 400);
    return c.json({ ok: true, updates: options.updates.restoreSnooze(body.ids, body.backAt, body.seenAt) });
  });

  // ── decided for you (decided.ts) ────────────────────────────────────────
  /** `{ decisionId, undo, note?, commandId? }`: Undo (wakes the thread that did it) or "I wouldn't have". */
  app.post('/api/desk/decided/reverse', async (c) => {
    if (!options.decided) return c.json({ error: 'Decided for you needs Loom' }, 404);
    const body = (await c.req.json().catch(() => null)) as { decisionId?: unknown; undo?: unknown; note?: unknown; commandId?: unknown } | null;
    const decisionId = str(body?.decisionId);
    if (!decisionId || typeof body?.undo !== 'boolean') return c.json({ error: 'decisionId and undo (boolean) are required' }, 400);
    const result = await options.decided.reverse(decisionId, body.undo, str(body.note) ?? null, str(body.commandId) || randomUUID());
    // The catch-up line for it is handled, with what the owner said (the learning loop counts reversals there too).
    const line = result.ok ? options.updates?.latest(`decision:${decisionId}`) : null;
    if (line) options.updates!.seen([line.id], 'acted', body.undo ? 'undo' : 'disagree');
    // Unknown: Loom may have applied it, so the client retries with the same command id (502, not a refusal).
    return result.ok ? c.json({ ok: true }) : c.json({ error: redactPaths(result.error), ...(result.unknown ? { unknown: true } : {}) }, result.unknown ? 502 : 409);
  });

  /** `{ decisionId, rule, reason?, commandId? }`: how an answered brief counts (Always / Ask me next time / Just this once). */
  app.post('/api/desk/decided/rule', async (c) => {
    if (!options.decided) return c.json({ error: 'Decided for you needs Loom' }, 404);
    const body = (await c.req.json().catch(() => null)) as { decisionId?: unknown; rule?: unknown; reason?: unknown; commandId?: unknown } | null;
    const decisionId = str(body?.decisionId);
    const rule = body?.rule === 'always' || body?.rule === 'next-time' || body?.rule === 'once' ? body.rule : null;
    if (!decisionId || !rule) return c.json({ error: 'decisionId and rule (always, next-time or once) are required' }, 400);
    const result = await options.decided.rule(decisionId, rule, str(body?.reason) ?? null, str(body?.commandId) || randomUUID(), str((body as { proposal?: unknown } | null)?.proposal) ?? null);
    // Its new-rule moment in the catch-up carries the choice and is handled.
    if (result.ok) options.updates?.ruleChosen(decisionId, rule);
    return result.ok ? c.json({ ok: true, rule: ('rule' in result ? result.rule : null) ?? null, ruleState: ('ruleState' in result ? result.ruleState : null) ?? null }) : c.json({ error: redactPaths(result.error), ...('unknown' in result && result.unknown ? { unknown: true } : {}) }, 'unknown' in result && result.unknown ? 502 : 409);
  });

  /** The ids of the decisions Loom has: `{ ids }`, which `D-n` the desk turns into links. */
  app.get('/api/desk/decisions', async (c) => {
    if (!options.decided) return c.json({ ids: [] });
    const ids = await options.decided.decisionIds();
    return ids ? c.json({ ids }) : c.json({ error: "Loom isn't answering" }, 502);
  });

  /** One decision's brief page (TGO-1110): the brief, revisions, who raised and carries it, and its outcome once closed. */
  app.get('/api/desk/decisions/:id', async (c) => {
    if (!options.decided) return c.json({ error: 'Decisions need Loom' }, 404);
    const id = c.req.param('id');
    if (!/^D-\d+$/.test(id)) return c.json({ error: 'not a decision id' }, 400);
    const decision = await options.decided.decision(id);
    if (decision === undefined) return c.json({ error: `No decision ${id}` }, 404);
    if (decision === null) return c.json({ error: "Loom isn't answering" }, 502);
    // A Tango agent's Loom thread has no row of its own: its decisions live on the Discord row it is linked to.
    const rowOf = (itemId: string) => {
      if (!itemId.startsWith('loom:') || core.item(itemId)) return itemId;
      // The live link, else the row its records were last filed on (kept for closed briefs' pages).
      for (const key of [`loom-link:${itemId.slice(5)}`, `loom-row:${itemId.slice(5)}`]) {
        try { const row = (JSON.parse(core.store.marker(key) ?? 'null') as { itemId?: string } | null)?.itemId; if (row) return row; } catch { /* next */ }
      }
      return itemId;
    };
    const place = (id: string, fallback: string | null) => {
      const itemId = rowOf(id);
      const item = core.item(itemId);
      const title = item ? item.place?.split(' · ').slice(1).join(' · ') || item.place || fallback || itemId : fallback;
      return title ? { itemId, title } : null;
    };
    const raised = decision.thread_id ? rowOf(`loom:${decision.thread_id}`) : null;
    return c.json(decisionPage(decision, place, raised && decision.status === 'open' ? core.carriedBy(raised) : []));
  });

  /** The weekly Delegation review: `{ due, seenAt, review }`. */
  app.get('/api/desk/decided/review', async (c) => {
    if (!options.decided) return c.json({ error: 'Decided for you needs Loom' }, 404);
    const review = await options.decided.review();
    return review ? c.json(review) : c.json({ error: "Loom isn't answering" }, 502);
  });

  /** `{ until? }`: the owner read the review that ran up to `until`; it comes back in a week. */
  app.post('/api/desk/decided/review/seen', async (c) => {
    if (!options.decided) return c.json({ error: 'Decided for you needs Loom' }, 404);
    const body = (await c.req.json().catch(() => null)) as { until?: unknown; rules?: unknown; commandId?: unknown } | null;
    const rules = Array.isArray(body?.rules) ? body.rules.filter((id): id is string => typeof id === 'string') : [];
    const result = await options.decided.reviewSeen(typeof body?.until === 'number' ? body.until : undefined, rules, str(body?.commandId) || randomUUID());
    return result.ok ? c.json(result) : c.json({ error: redactPaths(result.error), ...(result.unknown ? { unknown: true } : {}) }, result.unknown ? 502 : 409);
  });

  // ── capacity and routing (capacity.ts) ─────────────────────────────────
  /** Accounts with their windows and open threads, the routing rules, and this Mac. */
  app.get('/api/desk/capacity', async (c) => {
    if (!options.capacity) return c.json({ error: 'Capacity needs Start work (Loom)' }, 503);
    try {
      return c.json(await options.capacity.service.snapshot());
    } catch (err) {
      return c.json({ error: redactPaths((err as Error).message) }, 502);
    }
  });

  /**
   * `{ itemId, account, commandId?, allow? }`: Loom moves the thread to that account at its next safe point. `allow: true`
   * (the owner's one-tap "Run on" on a thread held on account limits, D-42) also adds the account to its allowed set.
   */
  app.post('/api/desk/capacity/move', async (c) => {
    if (!options.capacity) return c.json({ error: 'Capacity needs Start work (Loom)' }, 503);
    const body = (await c.req.json().catch(() => null)) as { itemId?: unknown; account?: unknown; commandId?: unknown; allow?: unknown } | null;
    const itemId = str(body?.itemId);
    const account = str(body?.account);
    if (!itemId || !account) return c.json({ error: 'itemId and account are required' }, 400);
    const result = await options.capacity.service.move(itemId, account, str(body?.commandId) || undefined, body?.allow === true);
    return result.ok ? c.json({ ok: true }) : c.json({ error: redactPaths(result.error) }, 409);
  });

  /** A Loom thread's accounts over time (start, limit, sign-in, move). */
  app.get('/api/desk/capacity/history/:itemId', async (c) => {
    if (!options.capacity) return c.json({ error: 'Capacity needs Start work (Loom)' }, 503);
    const history = await options.capacity.service.history(c.req.param('itemId'));
    return history ? c.json({ history }) : c.json({ error: 'Loom has no account history for that thread' }, 404);
  });

  /** The routing rules with the Claude accounts and repos to edit them with. */
  app.get('/api/desk/routing', async (c) => {
    if (!options.capacity || !options.startWork) return c.json({ error: 'Routing needs Start work (Loom)' }, 503);
    try {
      const start = await options.startWork.service.options();
      const accounts = start.accounts.filter((a) => a.driver === 'claudeAgent');
      return c.json({ rules: options.capacity.service.rules(accounts), accounts, repos: start.repos.map((r) => r.name), editable: !!options.capacity.policyFile });
    } catch (err) {
      return c.json({ error: redactPaths((err as Error).message) }, 502);
    }
  });

  /** `{ default: [ids], repos: { name: [ids] } }`: saved as the policy file (the model stays as it was). */
  app.put('/api/desk/routing', async (c) => {
    const file = options.capacity?.policyFile;
    if (!options.capacity || !options.startWork || !file) return c.json({ error: 'Routing needs Start work (Loom) and a policy file' }, 503);
    const body = (await c.req.json().catch(() => null)) as { default?: unknown; repos?: unknown } | null;
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : null);
    const repos = body?.repos && typeof body.repos === 'object' && !Array.isArray(body.repos) ? Object.entries(body.repos as Record<string, unknown>).map(([k, v]) => [k, list(v)] as const) : null;
    const pool = list(body?.default);
    if (!pool || !repos || repos.some(([, v]) => !v)) return c.json({ error: 'default must be a list of accounts, and repos a map of repo to accounts' }, 400);
    const update = { default: pool, repos: Object.fromEntries(repos) as Record<string, string[]> };
    const start = await options.startWork.service.options();
    const problems = routingProblems(update, start.accounts.filter((a) => a.driver === 'claudeAgent').map((a) => a.id));
    if (problems.length) return c.json({ error: problems.join('; ') }, 422);
    const current = readAccountPolicy(file);
    writeRouting(file, update, current && !('error' in current) ? current.model : null);
    return c.json({ ok: true, rules: options.capacity.service.rules(start.accounts) });
  });

  // ── pause mode: the operator's pause pill (pause.ts) ───────────────────
  app.get('/api/desk/pause', (c) => c.json(pause.current()));

  /** The voice operator publishes its pause pill (local only); screens get it as `pause` events. */
  app.post('/api/desk/pause', async (c) => {
    if (!isBotCaller(c, options.collaborationToken)) return c.json({ error: 'forbidden' }, 403);
    const card = parsePauseCard(await c.req.json().catch(() => null));
    if (!card) return c.json({ error: 'a pause card object is required' }, 400);
    return c.json(pause.set(card));
  });

  /** A tap on the pill (browsers too): resume, relayed to the operator as `pauseCommand`. */
  app.post('/api/desk/pause/command', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const result = pause.command(body?.action, body?.pauseId);
    return c.json(result.body, result.status as 200);
  });

  // ── session trace ──────────────────────────────────────────────────────
  const trace = options.trace;
  if (trace) {
    /**
     * `?since=15m|<ms>|<ISO>&until=&limit=&kinds=a,b&sources=hub,operator&session=latest`
     * → `{ entries (oldest first), since, until, now, sessionStart }`.
     */
    app.get('/api/desk/trace', (c) => {
      const now = Date.now();
      const list = (name: string) => (c.req.query(name) ?? '').split(',').map((value) => value.trim()).filter(Boolean);
      let since = parseTraceTime(c.req.query('since'), now) ?? undefined;
      const until = parseTraceTime(c.req.query('until'), now) ?? undefined;
      let sessionStart: number | null = null;
      if (c.req.query('session') === 'latest') {
        // A voice session's start; failing that (an operator run without the session runner), the newest operator start.
        const start = SESSION_START_KINDS.map((kind) => trace.query({ kinds: [kind], limit: 1, ...(until !== undefined ? { until } : {}) })[0]).find(Boolean);
        sessionStart = start?.at ?? null;
        if (sessionStart !== null && (since === undefined || sessionStart > since)) since = sessionStart;
      }
      const sources = list('sources').filter(isTraceSource);
      const entries = trace.query({
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
        limit: Number(c.req.query('limit') ?? 500) || 500,
        kinds: list('kinds'),
        sources,
        ...(c.req.query('after') ? { afterSeq: Number(c.req.query('after')) || 0 } : {}),
      });
      return c.json({ entries, since: since ?? null, until: until ?? null, now, sessionStart, sources: TRACE_SOURCES });
    });

    /**
     * One entry or a batch (an array, or `{ entries: [...] }`), fire-and-forget. Local processes
     * (the operator, with the collaboration token when one is set) may write any source; a browser
     * only `screen` (what it rendered) and `owner` (a mark).
     */
    app.post('/api/desk/trace', async (c) => {
      const body = (await c.req.json().catch(() => null)) as unknown;
      const raw = Array.isArray(body) ? body : body && typeof body === 'object' && Array.isArray((body as { entries?: unknown }).entries) ? (body as { entries: unknown[] }).entries : body ? [body] : [];
      if (raw.length === 0) return c.json({ error: 'one entry, an array, or { entries } is required' }, 400);
      if (raw.length > MAX_TRACE_BATCH) return c.json({ error: `at most ${MAX_TRACE_BATCH} entries per post` }, 400);
      const local = isBotCaller(c, options.collaborationToken);
      const entries: TraceInput[] = [];
      for (const value of raw) {
        const entry = value as Record<string, unknown>;
        if (!entry || typeof entry !== 'object' || !isTraceSource(entry.source) || !str(entry.kind)) return c.json({ error: `each entry needs source (${TRACE_SOURCES.join('|')}) and kind` }, 400);
        if (!local && !BROWSER_TRACE_SOURCES.includes(entry.source)) return c.json({ error: `forbidden: a browser may only write ${BROWSER_TRACE_SOURCES.join(' or ')} entries` }, 403);
        const data = entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data) ? (entry.data as Record<string, unknown>) : {};
        entries.push({
          source: entry.source,
          kind: str(entry.kind)!,
          summary: typeof entry.summary === 'string' ? entry.summary : str(entry.kind)!,
          data,
          sessionId: str(entry.sessionId) ?? null,
          // A browser's clock may be off: its entries are stamped on arrival (its own time stays in data).
          ...(local && typeof entry.at === 'number' ? { at: entry.at } : {}),
          ...(!local && typeof entry.at === 'number' ? { data: { ...data, clientAt: entry.at } } : {}),
        });
      }
      let recorded = 0;
      for (const entry of entries) if (trace.record(entry)) recorded += 1;
      return c.json({ recorded });
    });
  }

  app.get('/api/desk/conversation-shadow', c => c.json(options.conversations?.report() ?? []));
  app.get('/api/desk/tango-attachments/:id/:index', async c => {
    const { id, index } = c.req.param();
    if (!/^\d+$/.test(id) || !/^\d+$/.test(index) || !options.conversations) return c.json({ error: 'not found' }, 404);
    const response = await options.conversations.attachment(id, index);
    if (!response.ok) return c.json({ error: 'attachment unavailable' }, 404);
    return new Response(response.body, { headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': response.headers.get('content-disposition') ?? 'attachment' } });
  });

  app.post('/api/desk/agent-events', async (c) => {
    // The bot only: never through the tailnet proxy or from a browser, and with the token when one is set.
    if (!isBotCaller(c, options.collaborationToken)) return c.json({ error: 'forbidden' }, 403);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const type = str(body?.type);
    const agentId = str(body?.agentId);
    const conversationKey = str(body?.conversationKey);
    if (body && (type === 'message.created' || type === 'conversation.updated')) {
      if (!agentId || !conversationKey || !/^(?:(?:thread|channel):\d+|conv:[0-7][0-9A-HJKMNP-TV-Z]{25})$/.test(conversationKey) || !Number.isSafeInteger(body.messageId) || Number(body.messageId) < 1) return c.json({ error: 'invalid conversation event' }, 400);
      // Acknowledge immediately; the source coalesces bursts and retries through its poll.
      void options.conversations?.push(conversationKey, Number(body.messageId));
      return c.json({ ok: true });
    }
    const turnId = str(body?.turnId);
    if (!body || !type || !TURN_TYPES.includes(type) || !agentId || !conversationKey || !turnId) {
      return c.json({ error: 'type (turn.started|turn.activity|turn.finished|turn.failed), agentId, conversationKey and turnId are required' }, 400);
    }
    if (!/^(?:(?:thread|channel):\d+|conv:[0-7][0-9A-HJKMNP-TV-Z]{25})$/.test(conversationKey)) return c.json({ error: 'conversationKey must be thread:<id> or channel:<id>' }, 400);
    const error = body.error as Record<string, unknown> | undefined;
    const event: AgentTurnEvent = {
      type: type as AgentTurnEvent['type'],
      agentId,
      conversationKey,
      channelId: str(body.channelId) ?? conversationKey.split(':')[1]!,
      ...(str(body.threadId) ? { threadId: str(body.threadId) } : {}),
      turnId,
      at: typeof body.at === 'number' ? body.at : Date.now(),
      ...(str(body.activity) ? { activity: str(body.activity) } : {}),
      ...(error ? { error: { reason: str(error.reason) ?? 'error', message: str(error.message) ?? 'The turn failed' } } : {}),
    };
    return c.json(core.agentEvent(event));
  });

  app.get('/api/desk/stream', (c) =>
    streamSSE(c, async (stream) => {
      let open = true;
      if (c.req.query('client') === 'screen') core.noteScreenActivity();
      const send = (event: string, data: unknown) => {
        if (open) void stream.writeSSE({ event, data: JSON.stringify(data), id: randomUUID() }).catch(() => undefined);
      };
      const stops = [
        core.subscribe((event) => send(event.type, event.type === 'item' ? { id: event.id, revision: event.revision } : event.type === 'activity' ? event.event : event.entered)),
        options.presentation?.subscribe((presentation) => send('presentation', presentation)) ?? (() => {}),
        // Trace entries only for a viewer that asked (the /trace page): screens and the operator don't pay for them.
        c.req.query('trace') === '1' && options.trace ? options.trace.subscribe((entry) => send('trace', entry)) : () => {},
        (() => {
          const listener = (next: DeskSettings) => send('settings', next);
          settingsListeners.add(listener);
          return () => settingsListeners.delete(listener);
        })(),
        (() => {
          const listener = (status: OperatorStatus) => send('operator', status);
          operatorListeners.add(listener);
          return () => operatorListeners.delete(listener);
        })(),
        draft.subscribe((card) => send('draft', card)),
        // Only the voice operator hears taps on the Draft card: a direct local caller with the
        // collaboration token when one is set (anyone else asking for ?client=operator gets a plain stream).
        c.req.query('client') === 'operator' && isBotCaller(c, options.collaborationToken) ? draft.subscribeCommands((command) => send('draftCommand', command)) : () => {},
        pause.subscribe((card) => send('pause', card)),
        options.coordinators?.subscribe((summary) => send('coordinator', summary)) ?? (() => {}),
        // A feed post written or updated: the screens read the feed again (the owner's settings decide what shows).
        options.feed?.subscribe((post) => send('feed', { seq: post.seq, kind: post.kind })) ?? (() => {}),
        // The system ledger changed (a tick or a command): an open System page reads again.
        options.system?.subscribe((snapshot) => send('system', { at: snapshot.updatedAt, critical: snapshot.summary?.critical ?? 0 })) ?? (() => {}),
        // Catch-up lines written or marked (updates.ts): the sidebar's dots and the Inbox summary read the chapters again.
        options.updates?.subscribe((ids) => send('updates', { n: ids.length })) ?? (() => {}),
        // Same rule for taps on the pause pill.
        c.req.query('client') === 'operator' && isBotCaller(c, options.collaborationToken) ? pause.subscribeCommands((command) => send('pauseCommand', command)) : () => {},
      ];
      const unsubscribe = () => stops.forEach((stop) => stop());
      stream.onAbort(() => {
        open = false;
        unsubscribe();
      });
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ at: Date.now(), build: DESK_BUILD, operator, draft: draft.current(), pause: pause.current(), presentation: options.presentation?.current() ?? null }) });
      while (open) {
        await stream.sleep(keepAliveMs);
        if (open) await stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => (open = false));
      }
      unsubscribe();
    }),
  );
}

/** A chapter request's body: the lines and revision the owner was shown. */
async function chapterRequest(c: { req: { json(): Promise<unknown> } }): Promise<{ updateIds: number[]; revision: string; commandId: string } | { error: string }> {
  const body = (await c.req.json().catch(() => null)) as { updateIds?: unknown; revision?: unknown; commandId?: unknown } | null;
  const ids = Array.isArray(body?.updateIds) ? body.updateIds.filter((id): id is number => Number.isInteger(id) && (id as number) > 0) : null;
  if (!ids || ids.length !== (body?.updateIds as unknown[]).length || typeof body?.revision !== 'string') return { error: 'updateIds (the lines you saw) and revision are required' };
  return { updateIds: ids, revision: body.revision, commandId: typeof body.commandId === 'string' && body.commandId ? body.commandId : randomUUID() };
}
