import { feedScopeOf } from '../public/desk/feed-scope.js';
import { randomUUID } from 'node:crypto';
import type { Tracer } from './desk/trace.js';
import { isDrivable, publicPrototype, type Prototype, type PrototypeStore, type PublicPrototype } from './prototypes.js';
import type { InputStatus, Scene, SceneStore } from './store.js';

// The hub is the live side of the service: which browsers are connected
// (screens), whether the operator is directing (a director connection), what
// every screen presents, and where screen input goes. Connections are not
// persisted (a screen is whatever is connected right now); the presentation
// (view, conversation, scene, queue, manual selection) is, so a restart
// restores what was on the desk.

export interface Sink {
  send(event: string, data: unknown): void;
}

/**
 * What a browser window is for, set per window (its `?role=`): `full` shows everything and a scene takes
 * it over (a laptop, a phone); `control` keeps the List and conversations and never gives way to a
 * scene or prototype; `screen` shows only the scenes and prototypes. Every window still follows the one
 * presentation: the role only decides what each draws of it.
 */
export type ScreenRole = 'full' | 'control' | 'screen';
export const SCREEN_ROLES: readonly ScreenRole[] = ['full', 'control', 'screen'];

export function parseScreenRole(value: unknown): ScreenRole | null {
  return SCREEN_ROLES.find((role) => role === value) ?? null;
}

export interface ScreenInfo {
  id: string;
  name: string;
  role: ScreenRole;
  feedScope?: string;
  connectedAt: number;
  audioUnlocked: boolean;
  /**
   * A detached window (`?detached=1`, how agents test on a real desk): it keeps its own presentation, so it
   * gets no presentation broadcasts, isn't listed among the windows and can't move or re-role anyone's.
   */
  detached?: boolean;
}

/** What the operator reports for the dashboard: who is working on what. */
export interface DirectorTask {
  agentId: string;
  agentName: string;
  request: string;
  status: 'running' | 'waiting_user' | 'done';
  progress?: string;
  updatedAt?: number;
}

export interface SceneInput {
  sceneId: string;
  type: string;
  data: Record<string, unknown>;
  /** Client-generated id: a repeat of the same tap returns the first outcome instead of routing again. */
  commandId?: string;
}

/** Input as the bot fallback gets it: always with its command id and the scene's conversation. */
export interface RoutedInput extends SceneInput {
  commandId: string;
  conversationKey: string;
}

/** Delivers screen input to the agent's conversation when no operator takes it (the bot bridge). */
export type FallbackRouter = (scene: Scene, input: RoutedInput) => Promise<string>;

export interface InputResult {
  routed: string;
  commandId: string;
  status: InputStatus;
  /** The command id was already used: this is the first tap's outcome; nothing was routed again. */
  duplicate?: boolean;
}

/** The command id was used before for a different scene. */
export class InputConflict extends Error {}

// ── presentation ─────────────────────────────────────────────────────────

export type PresentationView = 'active' | 'conversation' | 'screen' | 'prototype';
export const PRESENTATION_VIEWS: readonly PresentationView[] = ['active', 'conversation', 'screen', 'prototype'];
/** `system`: the service itself (idle return, a cleared scene, an urgent scene with nobody directing). */
export type PresentationActor = 'screen' | 'director' | 'agent' | 'system';

export interface Presentation {
  view: PresentationView;
  /** The desk item the conversation is about, when known. */
  itemId: string | null;
  /** The current conversation (`thread:…`, `channel:…`, `loom:…`, `agent:…`); null on the board. */
  conversationKey: string | null;
  /** The scene on screen (Screen view only). */
  sceneId: string | null;
  /** The prototype on screen (Prototype view only). */
  prototypeId: string | null;
  /** Scenes from other conversations waiting their turn, oldest first. `queue[0]` is "up next". */
  queue: string[];
  by: PresentationActor;
  since: number;
  /** An explicit choice by the owner (or a director show): automatic focus can't override it until the conversation changes. */
  manual: boolean;
  reason: string | null;
  /**
   * Left alone past the grace period with nobody directing: Screen windows show their feed instead of what is
   * up, and full and control windows stay put. Kept (and persisted) until the next move.
   */
  stageIdle?: boolean;
}

/** A queued scene, as the "Up next" chip shows it. */
export interface QueuedScene {
  sceneId: string;
  agentId: string;
  agentName: string;
  title: string;
  color: string;
  conversationKey: string;
}

export interface PublicPresentation extends Presentation {
  /** The Screen view has something to show for the current conversation. */
  screenAvailable: boolean;
  /** `queue` with what the chip needs; `upNext` = `queueScenes[0]`. */
  queueScenes: QueuedScene[];
  upNext: QueuedScene | null;
  /** The current conversation's live prototypes, newest first (the Prototype view's switcher). */
  prototypes: PublicPrototype[];
  /** The prototype on screen (Prototype view only). */
  prototype: PublicPrototype | null;
}

/** A scene or prototype that just went up, as the desk's news feed posts it. */
export interface Published {
  kind: 'screen' | 'prototype';
  id: string;
  agentName: string;
  title: string;
  text: string;
  conversationKey: string;
}

/** What a prototype page reports about itself through the navigation bridge (see prototype-bridge.ts). */
export interface PrototypePage {
  path: string;
  title: string;
  targets: Array<{ label: string; kind: string; inView: boolean }>;
  headings: string[];
  fields: string[];
  scroll: { percent: number; scrollable: boolean };
}

/**
 * What a screen's List shows (the desk's home), so voice can say "the Watching tab", "open the third one",
 * "open the Voice project": its tabs, the project it is inside, and its rows in the order they render.
 */
export interface ListPage {
  place?: { page: 'inbox' | 'projects' | 'project' | 'agents' | 'agent' | 'system' | 'search' | 'spacesettings'; id?: string; view?: string; name: string };
  agents?: Array<{ id: string; name: string }>;
  /** The views of the page on screen (a space's Overview, Threads, Jobs, Workers, Done; the System page's tabs), and the one it's on. */
  views?: Array<{ id: string; name: string; count: number }>;
  view?: { id: string; name: string };
  /** The view (tab) that is up. */
  tab: { id: string; name: string };
  tabs: Array<{ id: string; name: string; count: number }>;
  /** The project the List is inside (its breadcrumb), or null at the top. */
  project: { id: string; name: string } | null;
  /** Open projects, so one can be opened by name from any tab. */
  projects: Array<{ id: string; name: string }>;
  /** The rows in order: a project folder (opens the project) or a conversation (its desk item id). */
  rows: Array<{ kind: 'project' | 'agent' | 'item'; id: string; title: string; where: string }>;
}

export interface PresentationIntent {
  view: PresentationView;
  itemId?: string;
  conversationKey?: string;
  sceneId?: string;
  prototypeId?: string;
  by: PresentationActor;
  reason?: string;
  /** Overrides whether this counts as a manual selection. */
  manual?: boolean;
  /**
   * The browser window that asked, and its count of moves: one older than its last applied move is refused.
   * Its `name` (`?name=`) and hub `screenId` go into the log and trace, so every move says which window made it.
   */
  window?: { id: string; seq: number; name?: string; screenId?: string };
}

export interface IntentResult {
  applied: boolean;
  /** An agent's scene from another conversation went to the queue instead. */
  queued?: boolean;
  error?: 'no-conversation' | 'no-scene' | 'unknown-scene' | 'no-prototype' | 'unknown-prototype';
  /** Why an intent did not apply, when it was not an error. */
  ignored?: 'manual-selection' | 'already-there' | 'not-current-conversation' | 'stale';
  presentation: PublicPresentation;
}

/** Reasons a director sends for focus it decided on its own (not the owner asking). */
const AUTOMATIC_REASONS = new Set(['focus', 'auto', 'idle', 'routed', 'relay']);
/**
 * A director saying the conversation is over (the call went idle, or it ended): with a director
 * connected and scenes waiting, the next one takes its turn (people at a table take turns).
 */
const CONVERSATION_END_REASONS = new Set(['idle', 'end', 'ended', 'conversation-ended']);

interface Snapshot {
  view: PresentationView;
  itemId: string | null;
  conversationKey: string | null;
  sceneId: string | null;
  prototypeId?: string | null;
}

/** The conversation behind a desk item id (see the agent-desk spec's item table). */
export function itemConversationKey(itemId: string | undefined | null): string | null {
  if (!itemId) return null;
  const thread = /^discord:thread:(.+)$/.exec(itemId);
  if (thread) return `thread:${thread[1]}`;
  const chapter = /^discord:chapter:([^:]+):/.exec(itemId);
  if (chapter) return `channel:${chapter[1]}`;
  // A Loom thread's conversation is its item id (source-loom.ts): voice opens one by id alone.
  const loom = /^loom:(.+)$/.exec(itemId);
  if (loom) return `loom:${loom[1]}`;
  return null;
}

function initialPresentation(now: number): Presentation {
  return { view: 'active', itemId: null, conversationKey: null, sceneId: null, prototypeId: null, queue: [], by: 'system', since: now, manual: false, reason: null };
}

export interface PublicScene {
  id: string;
  agentId: string;
  agentName: string;
  color: string;
  slot: string;
  kind: Scene['kind'];
  title: string;
  summary: string;
  choices: Scene['choices'];
  state: Scene['state'];
  urgent: boolean;
  version: number;
  updatedAt: number;
  /** The conversation that staged it: a thread, or the agent's channel. */
  threadId: string | null;
  channelId: string | null;
  conversationKey: string;
}

export function agentColor(agentId: string): string {
  const base = agentId.replace(/-ollama$/, '');
  let hash = 0;
  for (const char of base) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 70% 58%)`;
}

export function publicScene(scene: Scene): PublicScene {
  return {
    id: scene.id,
    agentId: scene.agentId,
    agentName: scene.agentName,
    color: agentColor(scene.agentId),
    slot: scene.slot,
    kind: scene.kind,
    title: scene.title,
    summary: scene.summary,
    choices: scene.choices,
    state: scene.state,
    urgent: scene.urgent,
    version: scene.version,
    updatedAt: scene.updatedAt,
    threadId: scene.origin.threadId ?? null,
    channelId: scene.origin.channelId ?? null,
    conversationKey: scene.conversationKey,
  };
}

const HISTORY_LIMIT = 30;
/** Commands the screen shell handles itself when the inbox is up (no scene showing). */
const SCROLL_COMMANDS = new Set(['scroll_down', 'scroll_up', 'scroll_top', 'scroll_bottom']);
/** Commands for the List itself (its tab, the project it is in): every screen takes them, whatever is up. */
export const LIST_COMMANDS = new Set(['list_tab', 'list_view', 'list_project', 'list_place', 'list_back']);
/** What the navigation bridge in an uploaded prototype page does (prototype-bridge.ts). */
export const PROTOTYPE_COMMANDS = new Set([...SCROLL_COMMANDS, 'click', 'go_to', 'fill', 'back', 'forward', 'reload']);
/** What the owner (or voice for him) asks the windows to do: a detached (test) window takes none of it (Codex review on #777). */
const OWNER_EVENTS = new Set(['command', 'inbox-home', 'inbox-open', 'ack']);
/** With no operator session, a conversation or scene left alone this long sends Screen windows back to their feed. */
export const DIRECTOR_GRACE_MS = 10 * 60_000;
/** An operator that doesn't acknowledge a tap in this long loses it to the bot route. */
export const INPUT_ACK_TIMEOUT_MS = 10_000;

export interface HubOptions {
  ackTimeoutMs?: number;
  /**
   * Scenes whose input always takes the fallback route, even while an operator
   * is directing: their conversation is somewhere the operator can't post
   * (a T3 Code thread), so the tap goes straight there.
   */
  direct?: (scene: Scene) => boolean;
  /** Prototypes (the Prototype view); without it that view has nothing to show. */
  prototypes?: PrototypeStore;
}

/** Inputs still `routing` (the bot call in progress) this long after a restart are failed, never replayed. */
export const ROUTING_STALE_MS = 5 * 60_000;

export class Hub {
  private readonly screens = new Map<string, { info: ScreenInfo; sink: Sink }>();
  private readonly directors = new Map<string, { sink: Sink; acks: boolean }>();
  private presentation: Presentation;
  private history: Snapshot[] = [];
  /** Version of the scene the screens last got, so a re-stage refreshes them in place. */
  private shownVersion: number | null = null;
  private tasks: DirectorTask[] = [];
  private seq = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly ackTimers = new Map<string, NodeJS.Timeout>();
  private readonly ackTimeoutMs: number;
  private readonly direct: (scene: Scene) => boolean;
  private readonly prototypes: PrototypeStore | null;
  /** What each prototype page last reported through its bridge (in memory: a reload re-reports it). */
  private readonly prototypePages = new Map<string, PrototypePage>();
  /** Each screen's List, with when the owner last touched that screen: the most recently touched one is "the" List. */
  private readonly listPages = new Map<string, { page: ListPage; touchedAt: number; at: number }>();
  /** The inbox item open in a screen's detail view: what "this one" means by voice. */
  private inboxFocus: string | null = null;
  private readonly presentationListeners = new Set<(presentation: PublicPresentation) => void>();
  /** A new scene or prototype went up (not a re-stage): the desk's news feed posts it. */
  private readonly publishedListeners = new Set<(published: Published) => void>();
  /** The desk item a conversation belongs to (set when the desk runs), so a queued scene's turn opens its item. */
  private itemResolver: ((conversationKey: string) => string | null) | null = null;
  /** The desk's session trace (set when the desk runs): every transition, refusal, scene and tap. */
  private tracer: Tracer | null = null;
  /** Each browser window's newest presentation move (its id → seq). */
  private readonly windowSeqs = new Map<string, number>();
  /** The window whose intent is being applied (set around applyIntent): commit() records it with the move. */
  private mover: PresentationIntent['window'] | null = null;

  constructor(
    private readonly store: SceneStore,
    private readonly fallback: FallbackRouter,
    private readonly log: (event: string, data?: Record<string, unknown>) => void = () => {},
    private readonly now: () => number = Date.now,
    private readonly directorGraceMs = DIRECTOR_GRACE_MS,
    options: HubOptions = {},
  ) {
    this.ackTimeoutMs = options.ackTimeoutMs ?? INPUT_ACK_TIMEOUT_MS;
    this.direct = options.direct ?? (() => false);
    this.prototypes = options.prototypes ?? null;
    this.presentation = initialPresentation(this.now());
    this.restore();
    this.recoverInputs();
    this.armIdle();
  }

  // ── connections ────────────────────────────────────────────────────────

  addScreen(name: string, sink: Sink, role: ScreenRole = 'full', options: { detached?: boolean; feedScope?: string } = {}): string {
    this.seq += 1;
    const id = `s${this.seq}`;
    const detached = options.detached === true;
    this.screens.set(id, { info: { id, name: name || `screen ${this.seq}`, role, feedScope: feedScopeOf(options.feedScope), connectedAt: this.now(), audioUnlocked: false, ...(detached ? { detached } : {}) }, sink });
    this.log('screen.connected', { id, name, role, ...(detached ? { detached } : {}), screens: this.screens.size });
    const showing = this.showingScene();
    // Everything a (re)connecting screen needs to draw the current desk, so nothing it missed while away is stale.
    sink.send('hello', { screenId: id, role, showing, dashboard: this.dashboard(), ...(detached ? { detached } : { presentation: this.publicPresentation() }) });
    // A frame already loaded at this version keeps its old data on reconnect; push the live state into it.
    if (showing && Object.keys(showing.state).length) sink.send('state', { sceneId: showing.id, state: showing.state });
    this.broadcastDashboard();
    return id;
  }

  removeScreen(id: string): void {
    if (!this.screens.delete(id)) return;
    this.dropListPage(id);
    this.log('screen.disconnected', { id, screens: this.screens.size });
    this.broadcastDashboard();
  }

  /** The operator's List falls back to the next screen's (or to none) right away, not at its next status poll. */
  private dropListPage(id: string): void {
    if (!this.listPages.has(id)) return;
    const before = this.listPage();
    this.listPages.delete(id);
    const after = this.listPage();
    if (JSON.stringify(before) !== JSON.stringify(after)) this.notifyDirectors('list-page', { page: after });
  }

  /** Changes what a window is for (from its own Settings, or another window's): it follows at once. */
  setScreenRole(id: string, role: ScreenRole): boolean {
    const screen = this.screens.get(id);
    if (!screen || screen.info.detached) return false;
    if (screen.info.role === role) return true;
    const from = screen.info.role;
    screen.info.role = role;
    // A Screen window has no List: voice stops resolving "the third one" against it (Codex review on #571).
    if (role === 'screen') this.dropListPage(id);
    this.log('screen.role', { id, from, role });
    this.trace('screen.role', `${screen.info.name} (${id}) is now ${role} (was ${from})`, { screenId: id, from, role });
    screen.sink.send('role', { role });
    this.broadcastDashboard();
    return true;
  }

  setScreenFeedScope(id: string, value: string): boolean {
    const screen = this.screens.get(id);
    if (!screen || screen.info.detached) return false;
    screen.info.feedScope = feedScopeOf(value);
    screen.sink.send('role', { feedScope: screen.info.feedScope });
    this.broadcastDashboard();
    return true;
  }

  setAudioUnlocked(id: string): void {
    const screen = this.screens.get(id);
    if (screen) screen.info.audioUnlocked = true;
  }

  /** `acks`: this director acknowledges each input (POST /api/input/:commandId/ack); unacknowledged ones fall back to the bot. */
  addDirector(sink: Sink, options: { acks?: boolean } = {}): string {
    this.seq += 1;
    const id = `d${this.seq}`;
    this.directors.set(id, { sink, acks: options.acks === true });
    this.armIdle();
    this.log('director.connected', { id, acks: options.acks === true });
    sink.send('hello', { ...this.status(), presentation: this.publicPresentation() });
    this.broadcastDashboard();
    return id;
  }

  removeDirector(id: string): void {
    if (!this.directors.delete(id)) return;
    this.log('director.disconnected', { id });
    if (this.directors.size === 0) this.tasks = [];
    this.armIdle();
    this.broadcastDashboard();
  }

  get operatorLive(): boolean {
    return this.directors.size > 0;
  }

  /** The owner's windows: detached (test) windows aren't among them. */
  screenList(): ScreenInfo[] {
    return [...this.screens.values()].filter((screen) => !screen.info.detached).map((screen) => ({ ...screen.info }));
  }

  // ── presentation ───────────────────────────────────────────────────────

  publicPresentation(): PublicPresentation {
    const p = this.presentation;
    const screenAvailable = p.conversationKey ? this.store.liveForConversation(p.conversationKey).length > 0 : false;
    const queueScenes = p.queue
      .map((id) => this.store.get(id))
      .filter((scene): scene is Scene => scene !== null && scene.status === 'live')
      .map((scene) => ({ sceneId: scene.id, agentId: scene.agentId, agentName: scene.agentName, title: scene.title || scene.summary, color: agentColor(scene.agentId), conversationKey: scene.conversationKey }));
    const prototypes = p.conversationKey && this.prototypes ? this.prototypes.liveForConversation(p.conversationKey).map(publicPrototype) : [];
    const current = p.view === 'prototype' && p.prototypeId ? this.prototypes?.get(p.prototypeId) : null;
    return {
      ...p,
      queue: [...p.queue],
      screenAvailable,
      queueScenes,
      upNext: queueScenes[0] ?? null,
      prototypes,
      prototype: current && current.status === 'live' ? publicPrototype(current) : null,
    };
  }

  /** Presentation changes, for the desk stream. */
  subscribePresentation(listener: (presentation: PublicPresentation) => void): () => void {
    this.presentationListeners.add(listener);
    return () => this.presentationListeners.delete(listener);
  }

  subscribePublished(listener: (published: Published) => void): () => void {
    this.publishedListeners.add(listener);
    return () => this.publishedListeners.delete(listener);
  }

  private published(published: Published): void {
    for (const listener of this.publishedListeners) {
      try {
        listener(published);
      } catch {
        /* the feed never changes what the screens show */
      }
    }
  }

  setItemResolver(resolver: (conversationKey: string) => string | null): void {
    this.itemResolver = resolver;
  }

  setTracer(tracer: Tracer | null): void {
    this.tracer = tracer;
  }

  /** Records to the session trace; never throws into the hub. */
  private trace(kind: string, summary: string, data: Record<string, unknown> = {}): void {
    if (!this.tracer) return;
    try {
      this.tracer({ source: 'hub', kind, summary, data, at: this.now() });
    } catch {
      /* tracing never changes behavior */
    }
  }

  /** "board", "conversation thread:1 (item)", "screen <title> (scene id)". */
  private describe(snapshot: { view: PresentationView; conversationKey: string | null; sceneId: string | null; prototypeId?: string | null; itemId?: string | null }): string {
    if (snapshot.view === 'active') return 'board';
    if (snapshot.view === 'prototype') {
      const prototype = snapshot.prototypeId ? this.prototypes?.get(snapshot.prototypeId) : null;
      return `prototype ${prototype ? `“${clipText(prototype.title || prototype.name, 40)}” (${prototype.agentName})` : (snapshot.prototypeId ?? '?')}`;
    }
    if (snapshot.view === 'screen') {
      const scene = snapshot.sceneId ? this.store.get(snapshot.sceneId) : null;
      return `screen ${scene ? `“${clipText(scene.title || scene.summary, 40)}” (${scene.agentName})` : (snapshot.sceneId ?? '?')}`;
    }
    return `conversation ${snapshot.conversationKey ?? '?'}`;
  }

  /**
   * Applies a presentation intent (see applyIntent) and records the outcome in the trace,
   * refusals included: what was asked, by whom, and why it did not apply.
   */
  intent(intent: PresentationIntent): IntentResult {
    let result: IntentResult;
    this.mover = intent.window ?? null;
    try {
      result = this.staleMove(intent) ? { applied: false, ignored: 'stale' as const, presentation: this.publicPresentation() } : this.applyIntent(intent);
    } finally {
      this.mover = null;
    }
    // A move that failed (a scene or prototype just gone) didn't happen: an older one landing after it still may (Codex review on #649).
    if (intent.window && !result.error && result.ignored !== 'stale') this.noteWindowMove(intent.window);
    if (!result.applied) {
      const why = result.error ?? result.ignored ?? 'not applied';
      const kind = result.queued ? 'presentation.queued' : result.error ? 'presentation.error' : 'presentation.ignored';
      const asked = intent.view === 'active' ? 'board' : intent.view;
      this.trace(kind, `${asked} by ${intent.by}${intent.reason ? ` (${intent.reason})` : ''} ${result.queued ? 'queued' : 'refused'}: ${why}; stays on ${this.describe(this.presentation)}`, {
        intent,
        why,
        current: { view: this.presentation.view, conversationKey: this.presentation.conversationKey, sceneId: this.presentation.sceneId, manual: this.presentation.manual, by: this.presentation.by },
      });
    }
    return result;
  }

  /**
   * A window's move that reached the hub after a newer one from the same window: a busy server or proxy let
   * Send's "back to the board" land after the owner had opened the next thread, and it won (#642).
   */
  private staleMove(intent: PresentationIntent): boolean {
    const w = intent.window;
    const last = w ? this.windowSeqs.get(w.id) : undefined;
    return !!w && last !== undefined && w.seq <= last;
  }

  private noteWindowMove(w: { id: string; seq: number }): void {
    this.windowSeqs.delete(w.id);
    this.windowSeqs.set(w.id, w.seq);
    // Newest windows last: keep a few hundred.
    if (this.windowSeqs.size > 500) this.windowSeqs.delete(this.windowSeqs.keys().next().value!);
  }

  /**
   * Applies a presentation intent per the agent-desk transition rules:
   * - `active` (⎋, "back to the board", idle) always applies and ends the conversation; the queue stays.
   * - `conversation` opens an item's conversation; within the current conversation it is the
   *   "show the overview" switch (a manual selection).
   * - `screen` shows a scene (the given one, else the conversation's newest); none → `no-scene`.
   * - An agent only takes the screen for the current conversation, and not over a manual
   *   selection; another conversation's scene queues.
   * - Automatic intents (an agent, or a director reason like `focus`) never override a manual
   *   selection in the same conversation. A different conversation always resets it.
   */
  private applyIntent(intent: PresentationIntent): IntentResult {
    const p = this.presentation;
    const automatic =
      intent.manual === false || intent.by === 'agent' || intent.by === 'system' || (intent.manual === undefined && AUTOMATIC_REASONS.has(intent.reason ?? ''));
    const reason = intent.reason ?? null;
    const result = (applied: boolean, extra: Partial<IntentResult> = {}): IntentResult => ({ applied, ...extra, presentation: this.publicPresentation() });
    const inConversation = (key: string | null) => p.view !== 'active' && key !== null && key === p.conversationKey;

    if (intent.view === 'active') {
      if (intent.by === 'agent') return result(false, { ignored: 'not-current-conversation' });
      if (intent.by === 'director' && CONVERSATION_END_REASONS.has(reason ?? '') && this.takeNextTurn(reason)) return result(true);
      this.goActive(intent.by, reason);
      return result(true);
    }

    if (intent.view === 'conversation') {
      if (intent.by === 'agent') return result(false, { ignored: 'not-current-conversation' });
      const fromItem = itemConversationKey(intent.itemId);
      const key = intent.conversationKey ?? fromItem ?? (intent.itemId ? null : p.conversationKey);
      if (!key) return result(false, { error: 'no-conversation' });
      const same = inConversation(key);
      if (same && automatic) {
        // Already talking about it: automatic focus never flips Screen back to Conversation.
        if (intent.itemId && intent.itemId !== p.itemId) this.commit({ ...this.snapshot(), itemId: intent.itemId, by: p.by, manual: p.manual, reason: p.reason });
        return result(false, { ignored: p.manual ? 'manual-selection' : 'already-there' });
      }
      this.commit({
        view: 'conversation',
        itemId: intent.itemId ?? (same ? p.itemId : (this.itemResolver?.(key) ?? null)),
        conversationKey: key,
        sceneId: null,
        by: intent.by,
        // Choosing the overview within a conversation is a selection; starting one is not.
        manual: intent.manual ?? (!automatic && same),
        reason,
      });
      return result(true);
    }

    if (intent.view === 'prototype') {
      // A prototype is something the owner uses: only the owner (or the operator for them) opens it.
      if (intent.by === 'agent') return result(false, { ignored: 'not-current-conversation' });
      let prototype: Prototype | null = null;
      if (intent.prototypeId) {
        prototype = this.prototypes?.get(intent.prototypeId) ?? null;
        if (!prototype || !this.prototypes?.isLive(prototype.id)) return result(false, { error: 'unknown-prototype' });
      } else {
        const key = intent.conversationKey ?? itemConversationKey(intent.itemId) ?? (p.view !== 'active' ? p.conversationKey : null);
        if (!key) return result(false, { error: 'no-conversation' });
        prototype = this.prototypes?.liveForConversation(key)[0] ?? null;
        if (!prototype) return result(false, { error: 'no-prototype' });
      }
      const same = inConversation(prototype.conversationKey);
      if (same && automatic && p.manual) return result(false, { ignored: 'manual-selection' });
      this.commit({
        view: 'prototype',
        itemId: intent.itemId ?? (same ? p.itemId : (this.itemResolver?.(prototype.conversationKey) ?? null)),
        conversationKey: prototype.conversationKey,
        sceneId: null,
        prototypeId: prototype.id,
        by: intent.by,
        manual: intent.manual ?? !automatic,
        reason,
      });
      return result(true);
    }

    // view === 'screen'
    let scene: Scene | null;
    if (intent.sceneId) {
      scene = this.store.get(intent.sceneId);
      if (!scene || scene.status !== 'live') return result(false, { error: 'unknown-scene' });
    } else {
      const key = intent.conversationKey ?? itemConversationKey(intent.itemId) ?? (p.view !== 'active' ? p.conversationKey : null);
      if (!key) return result(false, { error: 'no-conversation' });
      scene = this.store.liveForConversation(key)[0] ?? null;
      if (!scene) return result(false, { error: 'no-scene' });
    }
    const same = inConversation(scene.conversationKey);
    if (intent.by === 'agent') {
      if (!same) {
        this.enqueue(scene.id);
        return result(false, { queued: true, ignored: 'not-current-conversation' });
      }
      if (p.manual) return result(false, { ignored: 'manual-selection' });
    } else if (same && automatic && p.manual) {
      return result(false, { ignored: 'manual-selection' });
    }
    this.commit({
      view: 'screen',
      itemId: intent.itemId ?? (same ? p.itemId : (this.itemResolver?.(scene.conversationKey) ?? null)),
      conversationKey: scene.conversationKey,
      sceneId: scene.id,
      by: intent.by,
      manual: intent.manual ?? !automatic,
      reason,
    });
    return result(true);
  }

  /**
   * The conversation ended with a director connected: the oldest queued scene takes the Screen
   * view and its conversation becomes current. False with nobody directing or nothing queued (then
   * the board shows, offering queue[0] as "Up next").
   */
  private takeNextTurn(reason: string | null): boolean {
    if (!this.operatorLive) return false;
    const next = this.presentation.queue.map((id) => this.store.get(id)).find((scene): scene is Scene => scene !== null && scene.status === 'live');
    if (!next) return false;
    this.commit({ view: 'screen', itemId: this.itemResolver?.(next.conversationKey) ?? null, conversationKey: next.conversationKey, sceneId: next.id, by: 'director', manual: false, reason: reason ? `next-turn:${reason}` : 'next-turn' });
    this.setInboxFocus(null);
    return true;
  }

  /** Back to the board: the conversation ends, queued scenes wait (offered as `queue[0]`, never auto-shown). */
  private goActive(by: PresentationActor, reason: string | null): void {
    this.commit({ view: 'active', itemId: null, conversationKey: null, sceneId: null, by, manual: false, reason });
    this.setInboxFocus(null);
    this.broadcast('inbox-home', {});
  }

  private snapshot(): Snapshot {
    const { view, itemId, conversationKey, sceneId, prototypeId } = this.presentation;
    return { view, itemId, conversationKey, sceneId, prototypeId };
  }

  /** The one place presentation changes: history, queue upkeep, persistence, and every broadcast. */
  private commit(next: Snapshot & { by: PresentationActor; manual: boolean; reason: string | null }, options: { history?: boolean } = {}): void {
    const prev = this.presentation;
    const prevShowing = prev.view === 'screen' ? prev.sceneId : null;
    const prevVersion = this.shownVersion;
    const nextPrototype = next.view === 'prototype' ? (next.prototypeId ?? null) : null;
    const moved = prev.view !== next.view || prev.sceneId !== next.sceneId || prev.prototypeId !== nextPrototype || prev.conversationKey !== next.conversationKey;
    if (moved && options.history !== false && prev.view !== 'active') this.pushHistory(this.snapshot());
    const nextScene = next.view === 'screen' && next.sceneId ? this.store.get(next.sceneId) : null;
    const queue = prev.queue.filter((id) => {
      if (id === next.sceneId) return false;
      const scene = this.store.get(id);
      if (!scene || scene.status !== 'live') return false;
      // The current conversation's own scenes aren't waiting their turn: they're in the Screen switcher.
      return next.view === 'active' || scene.conversationKey !== next.conversationKey;
    });
    this.presentation = {
      view: next.view,
      itemId: next.itemId,
      conversationKey: next.conversationKey,
      sceneId: next.view === 'screen' ? next.sceneId : null,
      prototypeId: nextPrototype,
      queue,
      by: next.by,
      since: moved ? this.now() : prev.since,
      manual: next.manual,
      reason: next.reason,
      // A move ends the idle; anything else (a queue or selection update) keeps it.
      ...(!moved && prev.stageIdle ? { stageIdle: true } : {}),
    };
    this.shownVersion = nextScene?.version ?? null;
    this.persist();
    const mover = this.mover ? { id: this.mover.id, ...(this.mover.name ? { name: this.mover.name } : {}), ...(this.mover.screenId ? { screenId: this.mover.screenId } : {}) } : null;
    this.log('presentation', { view: next.view, conversationKey: next.conversationKey, sceneId: this.presentation.sceneId, by: next.by, manual: next.manual, reason: next.reason, ...(mover ? { window: mover } : {}) });
    this.trace(
      moved ? 'presentation.changed' : 'presentation.updated',
      `${moved ? `${this.describe(prev)} → ${this.describe(this.presentation)}` : `${this.describe(this.presentation)} (${prev.manual !== next.manual ? (next.manual ? 'now manual' : 'no longer manual') : 'same view'})`} · by ${next.by}${next.reason ? ` (${next.reason})` : ''}${next.manual ? ' · manual' : ''}${mover ? ` · window ${mover.name ?? mover.screenId ?? mover.id}` : ''}`,
      {
        from: { view: prev.view, conversationKey: prev.conversationKey, sceneId: prev.sceneId, itemId: prev.itemId, manual: prev.manual },
        to: { view: next.view, conversationKey: next.conversationKey, sceneId: this.presentation.sceneId, prototypeId: nextPrototype, itemId: next.itemId },
        by: next.by,
        reason: next.reason,
        manual: next.manual,
        queue: queue.length,
        ...(mover ? { window: mover } : {}),
      },
    );
    this.broadcastPresentation();
    // The shell and the operator still follow `show` / `showing`: what scene (if any) is up.
    const nextShowing = this.presentation.sceneId;
    if (prevShowing !== nextShowing || (nextShowing && prevVersion !== this.shownVersion)) {
      const scene = nextScene ? publicScene(nextScene) : null;
      this.broadcast('show', { scene });
      this.notifyDirectors('showing', scene ? { scene, by: next.by } : { scene: null });
      this.broadcastDashboard();
    }
    this.armIdle();
  }

  private enqueue(sceneId: string): void {
    if (this.presentation.queue.includes(sceneId)) return;
    this.presentation = { ...this.presentation, queue: [...this.presentation.queue, sceneId] };
    this.persist();
    this.broadcastPresentation();
  }

  private pushHistory(snapshot: Snapshot): void {
    const last = this.history.at(-1);
    if (last && last.view === snapshot.view && last.sceneId === snapshot.sceneId && (last.prototypeId ?? null) === (snapshot.prototypeId ?? null) && last.conversationKey === snapshot.conversationKey) return;
    this.history.push(snapshot);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
  }

  private persist(): void {
    try {
      this.store.savePresentation({ presentation: this.presentation, history: this.history });
    } catch (err) {
      this.log('presentation.persist.error', { message: (err as Error).message });
    }
  }

  /** Loads the saved presentation, dropping scenes that expired or were cleared while the service was down. */
  private restore(): void {
    const saved = this.store.loadPresentation() as { presentation?: Partial<Presentation>; history?: Snapshot[] } | null;
    const p = saved?.presentation;
    if (!p || !PRESENTATION_VIEWS.includes(p.view as PresentationView)) return;
    const live = (id: unknown) => typeof id === 'string' && this.store.get(id)?.status === 'live';
    const str = (value: unknown) => (typeof value === 'string' ? value : null);
    let view = p.view as PresentationView;
    let sceneId = str(p.sceneId);
    if (view === 'screen' && !live(sceneId)) {
      view = str(p.conversationKey) ? 'conversation' : 'active';
      sceneId = null;
    }
    let prototypeId = str(p.prototypeId);
    if (view === 'prototype' && !this.prototypes?.isLive(prototypeId)) {
      view = str(p.conversationKey) ? 'conversation' : 'active';
      prototypeId = null;
    }
    this.presentation = {
      view,
      itemId: view === 'active' ? null : str(p.itemId),
      conversationKey: view === 'active' ? null : str(p.conversationKey),
      sceneId: view === 'screen' ? sceneId : null,
      prototypeId: view === 'prototype' ? prototypeId : null,
      queue: Array.isArray(p.queue) ? p.queue.filter(live) : [],
      by: (['screen', 'director', 'agent', 'system'] as const).find((by) => by === p.by) ?? 'system',
      since: typeof p.since === 'number' ? p.since : this.now(),
      manual: p.manual === true,
      reason: str(p.reason),
      // Still idle after a restart: a Screen window opened now starts on its feed (Codex review on #778).
      ...(p.stageIdle === true && view !== 'active' ? { stageIdle: true } : {}),
    };
    this.shownVersion = sceneId ? this.store.get(sceneId)!.version : null;
    this.history = Array.isArray(saved?.history) ? saved!.history.filter((entry) => entry && PRESENTATION_VIEWS.includes(entry.view)).slice(-HISTORY_LIMIT) : [];
  }

  /**
   * The server-side idle return: with no director connected, a conversation or
   * scene left alone for the grace period sends Screen windows back to their feed
   * (idleScreens); full and control windows stay where the owner left them. Any
   * interaction (a presentation change, a tap, a command) restarts the clock; a
   * director connecting stops it (the operator owns the 2-minute idle return).
   */
  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.directors.size > 0 || this.presentation.view === 'active') return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.directors.size === 0 && this.presentation.view !== 'active') this.idleScreens();
    }, this.directorGraceMs);
    this.idleTimer.unref?.();
  }

  /**
   * The idle return is for display screens only: Screen windows (`?role=screen`) go back to their feed, and
   * the presentation stays where the owner left it, so his full and control windows don't move.
   */
  private idleScreens(): void {
    // Part of the presentation, so it reaches every window with it (a Screen window joining later included) and
    // survives a restart; only Screen windows act on it (main.js holdFor).
    this.presentation = { ...this.presentation, stageIdle: true };
    this.persist();
    this.broadcastPresentation();
    const screens = [...this.screens.values()].filter(({ info }) => info.role === 'screen' && !info.detached);
    this.log('presentation.idle', { screens: screens.length });
    this.trace('presentation.idle', `left alone ${Math.round(this.directorGraceMs / 60_000)} min: ${screens.length} Screen window${screens.length === 1 ? '' : 's'} back to the feed; ${this.describe(this.presentation)} stays`, {
      screens: screens.map(({ info }) => info.id),
      current: { view: this.presentation.view, conversationKey: this.presentation.conversationKey, sceneId: this.presentation.sceneId },
    });
  }

  // ── what is showing (the scene-centric API the operator and shell use) ──

  showingScene(): PublicScene | null {
    const p = this.presentation;
    if (p.view !== 'screen' || !p.sceneId) return null;
    const scene = this.store.get(p.sceneId);
    return scene && scene.status === 'live' ? publicScene(scene) : null;
  }

  /**
   * Puts a scene up on every screen (the Screen view of its conversation).
   * A director or screen show is a manual selection. Returns false if it is not live.
   */
  show(sceneId: string, by: 'director' | 'screen' | 'urgent' | 'agent', options: { reason?: string } = {}): boolean {
    const scene = this.store.get(sceneId);
    if (!scene || scene.status !== 'live') {
      this.trace('presentation.error', `show ${sceneId} by ${by} refused: no live scene`, { sceneId, by, reason: options.reason ?? null });
      return false;
    }
    const p = this.presentation;
    // A screen tap is the owner choosing. A director show is a manual selection only when it says the
    // owner asked (a reason that isn't automatic focus); with no reason it is the operator's own focus.
    const manual = by === 'screen' || (by === 'director' && options.reason !== undefined && !AUTOMATIC_REASONS.has(options.reason));
    const reason = by === 'urgent' ? 'urgent' : (options.reason ?? null);
    const actor: PresentationActor = by === 'urgent' ? 'system' : by;
    if (p.view === 'screen' && p.sceneId === sceneId && this.shownVersion === scene.version) {
      if (manual && (!p.manual || p.by !== actor)) this.commit({ ...this.snapshot(), by: actor, manual: true, reason });
      return true;
    }
    const same = p.view !== 'active' && p.conversationKey === scene.conversationKey;
    // Automatic focus never overrides the owner's own pick in the same conversation.
    if (!manual && same && p.manual && by !== 'urgent') {
      this.trace('presentation.ignored', `show “${clipText(scene.title || scene.summary, 40)}” by ${by}${options.reason ? ` (${options.reason})` : ''} refused: manual-selection; stays on ${this.describe(p)}`, {
        sceneId,
        by,
        reason: options.reason ?? null,
        why: 'manual-selection',
      });
      return false;
    }
    this.commit({
      view: 'screen',
      itemId: same ? p.itemId : (this.itemResolver?.(scene.conversationKey) ?? null),
      conversationKey: scene.conversationKey,
      sceneId,
      by: actor,
      manual,
      reason,
    });
    return true;
  }

  /** An agent's scene: its newest in the current conversation, else its newest anywhere. Null if it has none. */
  showAgent(agentId: string, by: 'director' | 'screen', options: { reason?: string } = {}): PublicScene | null {
    const scenes = this.store.live(agentId);
    const latest = scenes.find((scene) => scene.conversationKey === this.presentation.conversationKey) ?? scenes[0];
    if (!latest || !this.show(latest.id, by, options)) return null;
    return publicScene(latest);
  }

  /** Back to the board. `home` (someone asked for it) also closes an open inbox item. */
  showDashboard(options: { home?: boolean; by?: PresentationActor; reason?: string } = {}): void {
    this.commit({ view: 'active', itemId: null, conversationKey: null, sceneId: null, by: options.by ?? 'director', manual: false, reason: options.reason ?? null });
    if (options.home) {
      this.setInboxFocus(null);
      this.broadcast('inbox-home', {});
    }
  }

  /** The previous view that still makes sense (a scene that is still live); the board if none. */
  back(): PublicScene | null {
    while (this.history.length) {
      const entry = this.history.pop()!;
      if (entry.view === 'screen') {
        const scene = entry.sceneId ? this.store.get(entry.sceneId) : null;
        if (scene?.status !== 'live' || entry.sceneId === this.presentation.sceneId) continue;
      } else if (entry.view === 'prototype') {
        if (!this.prototypes?.isLive(entry.prototypeId) || entry.prototypeId === this.presentation.prototypeId) continue;
      } else if (entry.view === 'conversation' && !entry.conversationKey) {
        continue;
      }
      const same = entry.conversationKey === this.presentation.conversationKey;
      this.commit({ ...entry, by: 'director', manual: same, reason: 'back' }, { history: false });
      return this.showingScene();
    }
    this.commit({ view: 'active', itemId: null, conversationKey: null, sceneId: null, by: 'director', manual: false, reason: 'back' }, { history: false });
    return null;
  }

  /**
   * Sends a command (play, pause, scroll_down, …) to the scene that is showing;
   * scrolls also work on the board. False when no screen is connected to receive it.
   */
  /** `commandId` (prototype commands): echoed in each screen's result, so the operator matches results to the command. */
  command(name: string, args: Record<string, unknown> = {}, commandId?: string): boolean {
    if (this.screenList().length === 0) return false;
    this.armIdle();
    if (LIST_COMMANDS.has(name)) {
      // Every screen's List moves together (each keeps its own tab otherwise), so "the third one" means the same row on all of them.
      this.trace('list.command', `${name} ${JSON.stringify(args)}`, { name, args });
      this.broadcast('command', { sceneId: null, name, args });
      return true;
    }
    // A scene or prototype command needs a window that draws it: a control window keeps its stage empty (Codex review on #571).
    const stageUp = this.screenList().some((screen) => screen.role !== 'control');
    if (this.presentation.view === 'prototype') {
      if (!stageUp) return false;
      // Only an uploaded prototype carries the navigation bridge; a dev server URL can't be driven.
      const prototype = this.presentation.prototypeId ? this.prototypes?.get(this.presentation.prototypeId) : null;
      if (!prototype || !isDrivable(prototype) || !PROTOTYPE_COMMANDS.has(name)) return false;
      // What `fill` types (an email, a password) never goes in the trace: only the field it went into.
      const traced = typeof args.target === 'string' ? { target: args.target } : {};
      this.trace('prototype.command', `${name}${typeof args.target === 'string' ? ` “${clipText(args.target, 40)}”` : ''} on prototype “${clipText(prototype.title || prototype.name, 40)}”`, { prototypeId: prototype.id, name, args: traced });
      this.broadcast('command', { sceneId: null, prototypeId: prototype.id, name, args, ...(commandId ? { commandId } : {}) });
      return true;
    }
    const showing = this.showingScene();
    if (!showing) {
      if (!SCROLL_COMMANDS.has(name)) return false;
      this.broadcast('command', { sceneId: null, name });
      return true;
    }
    // A url scene is another site in a nested frame: it can't be scrolled from here.
    // A Google file or Linear item read by the server (origin.googleRead/linearRead) is the frame's own page, so it can.
    if (!stageUp) return false;
    const origin = this.store.get(showing.id)?.origin;
    if (SCROLL_COMMANDS.has(name) && showing.kind === 'url' && !origin?.googleRead && !origin?.linearRead) return false;
    this.broadcast('command', { sceneId: showing.id, name });
    return true;
  }

  // ── scene lifecycle ────────────────────────────────────────────────────

  /**
   * A scene was staged or re-staged. If it is the one showing, screens refresh it
   * in place. The current conversation's agent takes the Screen view (unless the
   * owner made a manual selection); other conversations' scenes queue. With
   * nobody directing and nothing in focus, an urgent scene goes straight up.
   */
  staged(scene: Scene, replaced: boolean): { showing: boolean } {
    const p = this.presentation;
    if (p.view === 'screen' && p.sceneId === scene.id) {
      this.shownVersion = scene.version;
      this.broadcast('show', { scene: publicScene(scene), updated: true });
    } else {
      // A Screen window may still hold it after the desk moved on: it refreshes there (Codex review on #571).
      if (replaced) this.broadcast('scene', { scene: publicScene(scene), updated: true });
      if (p.view !== 'active' && p.conversationKey === scene.conversationKey) {
        // The owner picked what is up, or is using a prototype: it stays put and the Screen switcher lights up.
        if (p.manual || p.view === 'prototype') this.broadcastPresentation();
        else this.commit({ view: 'screen', itemId: p.itemId, conversationKey: scene.conversationKey, sceneId: scene.id, by: 'agent', manual: false, reason: 'staged' });
      } else if (scene.urgent && !this.operatorLive && p.view === 'active') {
        this.show(scene.id, 'urgent');
      } else {
        this.enqueue(scene.id);
      }
    }
    const showing = this.presentation.view === 'screen' && this.presentation.sceneId === scene.id;
    const outcome =
      p.view === 'screen' && p.sceneId === scene.id
        ? 'refreshed in place'
        : showing
          ? 'took the screen'
          : p.view !== 'active' && p.conversationKey === scene.conversationKey
            ? 'held: the owner picked what is up (Screen switcher lit)'
            : this.presentation.queue.includes(scene.id)
              ? `queued (current: ${this.describe(this.presentation)})`
              : 'not shown';
    this.trace(replaced ? 'scene.replaced' : 'scene.staged', `${scene.agentName} ${replaced ? 're-staged' : 'staged'} “${clipText(scene.title || scene.summary, 50)}” v${scene.version} in ${scene.conversationKey}: ${outcome}`, {
      sceneId: scene.id,
      agentId: scene.agentId,
      conversationKey: scene.conversationKey,
      version: scene.version,
      urgent: scene.urgent,
      replaced,
      showing,
      outcome,
    });
    this.notifyDirectors('staged', { scene: publicScene(scene), replaced, showing });
    if (!replaced) this.published({ kind: 'screen', id: scene.id, agentName: scene.agentName, title: scene.title || scene.summary, text: scene.title ? scene.summary : '', conversationKey: scene.conversationKey });
    this.broadcastDashboard();
    return { showing };
  }

  stateChanged(scene: Scene): void {
    // Every screen gets it: a Screen window may hold this scene after the desk moved on, and a window
    // posts state only into the frame it is showing (Codex review on #571).
    this.broadcast('state', { sceneId: scene.id, state: scene.state });
    this.broadcastDashboard();
  }

  // ── prototypes ─────────────────────────────────────────────────────────

  /**
   * A prototype was published. It never takes the screen on its own (the owner opens it): the one
   * showing reloads in place at its new version, and the current conversation's switcher lights up.
   */
  prototypePublished(prototype: Prototype, replaced: boolean): { showing: boolean } {
    const p = this.presentation;
    const showing = p.view === 'prototype' && p.prototypeId === prototype.id;
    if (showing) this.prototypePages.delete(prototype.id);
    if (showing || (p.view !== 'active' && p.conversationKey === prototype.conversationKey)) this.broadcastPresentation();
    this.trace(replaced ? 'prototype.replaced' : 'prototype.published', `${prototype.agentName} ${replaced ? 'updated' : 'published'} prototype “${clipText(prototype.title || prototype.name, 50)}” v${prototype.version} in ${prototype.conversationKey}${showing ? ': reloaded in place' : ''}`, {
      prototypeId: prototype.id,
      agentId: prototype.agentId,
      conversationKey: prototype.conversationKey,
      version: prototype.version,
      replaced,
      showing,
    });
    this.notifyDirectors('prototype', { prototype: publicPrototype(prototype), replaced, showing });
    if (!replaced) this.published({ kind: 'prototype', id: prototype.id, agentName: prototype.agentName, title: prototype.title || prototype.name, text: '', conversationKey: prototype.conversationKey });
    // A Screen window holding it reloads at the new version; a new one is live now.
    this.broadcastDashboard();
    return { showing };
  }

  /** Prototypes cleared or expired: one on screen gives way to its conversation (or the board). */
  prototypesRemoved(ids: string[], reason: 'expired' | 'cleared' = 'cleared'): void {
    if (ids.length === 0) return;
    for (const id of ids) this.prototypePages.delete(id);
    const p = this.presentation;
    const onScreen = p.view === 'prototype' && p.prototypeId !== null && ids.includes(p.prototypeId);
    this.trace(`prototype.${reason}`, `${ids.length} prototype${ids.length === 1 ? '' : 's'} ${reason}${onScreen ? ' (including the one on screen)' : ''}`, { ids, reason, onScreen });
    if (onScreen) {
      if (p.conversationKey) this.commit({ view: 'conversation', itemId: p.itemId, conversationKey: p.conversationKey, sceneId: null, by: 'system', manual: p.manual, reason: 'prototype-cleared' }, { history: false });
      else this.commit({ view: 'active', itemId: null, conversationKey: null, sceneId: null, by: 'system', manual: false, reason: 'prototype-cleared' }, { history: false });
    } else if (p.conversationKey) {
      this.broadcastPresentation(); // the switcher may have changed
    }
    this.broadcastDashboard(); // a screen window still holding one lets it go
  }

  /** What a prototype page says is on it (from a screen's bridge): kept for the operator, which gets it too. */
  setPrototypePage(prototypeId: string, page: PrototypePage): boolean {
    if (!this.prototypes?.isLive(prototypeId)) return false;
    const previous = this.prototypePages.get(prototypeId);
    this.prototypePages.set(prototypeId, page);
    if (previous && JSON.stringify(previous) === JSON.stringify(page)) return true;
    this.armIdle(); // the owner clicking or scrolling through it is activity
    if (!previous || previous.path !== page.path) this.trace('prototype.page', `prototype page ${page.path || '/'}${page.title ? ` “${clipText(page.title, 40)}”` : ''}: ${page.targets.length} clickable, ${page.headings.length} headings`, { prototypeId, path: page.path, title: page.title });
    this.notifyDirectors('prototype-page', { prototypeId, page });
    return true;
  }

  /** The owner is using the prototype (a click or keystroke the page reported). */
  prototypeActivity(prototypeId: string): boolean {
    if (!this.prototypes?.isLive(prototypeId)) return false;
    this.armIdle();
    this.notifyDirectors('prototype-activity', { prototypeId });
    return true;
  }

  /**
   * What a screen's List shows. `touchedAt`: when the owner last tapped or typed on that screen; the
   * operator gets the List of the screen touched most recently (they're looking at that one).
   */
  setListPage(screenId: string, page: ListPage, touchedAt: number): boolean {
    const screen = this.screens.get(screenId);
    // A Screen window's report (one in flight as it changed) is not a List anyone is looking at.
    // A detached (test) window's List isn't one the owner is looking at either.
    if (!screen || screen.info.role === 'screen' || screen.info.detached) return false;
    const before = this.listPage();
    this.listPages.set(screenId, { page, touchedAt, at: this.now() });
    const after = this.listPage();
    if (after && JSON.stringify(before) !== JSON.stringify(after)) this.notifyDirectors('list-page', { page: after });
    return true;
  }

  listPage(): ListPage | null {
    let best: { page: ListPage; touchedAt: number; at: number } | null = null;
    for (const entry of this.listPages.values()) {
      if (!best || entry.touchedAt > best.touchedAt || (entry.touchedAt === best.touchedAt && entry.at > best.at)) best = entry;
    }
    return best?.page ?? null;
  }

  prototypePage(prototypeId: string | null): PrototypePage | null {
    return prototypeId ? (this.prototypePages.get(prototypeId) ?? null) : null;
  }

  /** How a command on a prototype went (the bridge's report): the operator says when a click found nothing. */
  prototypeResult(prototypeId: string, result: { name: string; ok: boolean; detail: string; commandId?: string }): void {
    if (!result.ok) this.trace('prototype.command.failed', `${result.name} on the prototype found nothing: ${clipText(result.detail, 80)}`, { prototypeId, ...result });
    this.notifyDirectors('prototype-result', { prototypeId, ...result });
  }

  removed(sceneIds: string[], reason: 'expired' | 'cleared' = 'cleared'): void {
    if (sceneIds.length === 0) return;
    const p = this.presentation;
    this.trace(`scene.${reason}`, `${sceneIds.length} scene${sceneIds.length === 1 ? '' : 's'} ${reason}${p.sceneId && sceneIds.includes(p.sceneId) ? ' (including the one on screen)' : ''}`, { sceneIds, reason, onScreen: p.sceneId !== null && sceneIds.includes(p.sceneId) });
    if (p.view === 'screen' && p.sceneId && sceneIds.includes(p.sceneId)) {
      // The conversation goes on without its scene; a scene shown on its own returns to the board.
      if (p.itemId) this.commit({ view: 'conversation', itemId: p.itemId, conversationKey: p.conversationKey, sceneId: null, by: 'system', manual: p.manual, reason: 'scene-cleared' }, { history: false });
      else this.commit({ view: 'active', itemId: null, conversationKey: null, sceneId: null, by: 'system', manual: false, reason: 'scene-cleared' }, { history: false });
    } else if (p.queue.some((id) => sceneIds.includes(id))) {
      this.presentation = { ...p, queue: p.queue.filter((id) => !sceneIds.includes(id)) };
      this.persist();
      this.broadcastPresentation();
    } else if (p.conversationKey) {
      this.broadcastPresentation(); // screenAvailable may have changed
    }
    this.notifyDirectors('cleared', { sceneIds });
    this.broadcastDashboard();
  }

  // ── input ──────────────────────────────────────────────────────────────

  /**
   * A choice or other input on a scene, routed to the scene's own conversation:
   * to the operator while one is directing (with the conversation identity),
   * otherwise to the bot. A repeated command id returns the first outcome. An
   * operator that acknowledges inputs must do so within the ack timeout, or the
   * input falls back to the bot route; it is never silently dropped.
   */
  async input(input: SceneInput): Promise<InputResult> {
    const scene = this.store.get(input.sceneId);
    if (!scene) throw new Error('unknown scene');
    const commandId = input.commandId ?? randomUUID();
    const claim = this.store.claimInput({ sceneId: scene.id, agentId: scene.agentId, type: input.type, data: input.data, conversationKey: scene.conversationKey, commandId });
    if (!claim.created) {
      if (claim.event.sceneId !== scene.id) throw new InputConflict(`commandId ${commandId} was already used for another scene`);
      return { routed: claim.event.routed || 'pending', commandId, status: claim.event.status, duplicate: true };
    }
    this.armIdle();
    let routed: string;
    let status: InputStatus;
    if (this.operatorLive && !this.direct(scene)) {
      const acks = [...this.directors.values()].some((director) => director.acks);
      status = acks ? 'pending' : 'delivered';
      routed = 'operator';
      this.store.updateInput(commandId, { status, routed });
      this.notifyDirectors('input', {
        scene: publicScene(scene),
        type: input.type,
        data: input.data,
        commandId,
        conversationKey: scene.conversationKey,
        channelId: scene.origin.channelId ?? null,
        threadId: scene.origin.threadId ?? null,
        ...(acks ? { ackWithinMs: this.ackTimeoutMs } : {}),
      });
      if (acks) this.armAck(commandId, this.ackTimeoutMs);
    } else {
      routed = await this.fallback(scene, { ...input, commandId, conversationKey: scene.conversationKey });
      status = routed === 'agent' ? 'delivered' : 'failed';
      this.store.updateInput(commandId, { status, routed });
    }
    this.log('input', { sceneId: scene.id, agent: scene.agentId, conversationKey: scene.conversationKey, type: input.type, routed, status, commandId });
    const label = input.type === 'choice' ? choiceLabel(scene, input.data) : undefined;
    this.trace('input.tap', `tap ${label ? `“${label}”` : input.type} on ${scene.agentName}'s “${clipText(scene.title || scene.summary, 40)}” → ${routed} (${status})`, {
      sceneId: scene.id,
      agentId: scene.agentId,
      conversationKey: scene.conversationKey,
      type: input.type,
      label: label ?? null,
      routed,
      status,
      commandId,
    });
    this.broadcast('ack', { sceneId: scene.id, agentName: scene.agentName, type: input.type, ...(label ? { label } : {}), routed, commandId, status });
    return { routed, commandId, status };
  }

  /** The operator took the input. Null for an unknown command id. */
  ackInput(commandId: string): { commandId: string; status: InputStatus; routed: string; late?: boolean } | null {
    const event = this.store.inputByCommand(commandId);
    if (!event) return null;
    if (event.status === 'pending' || event.status === 'routing') {
      const timer = this.ackTimers.get(commandId);
      if (timer) clearTimeout(timer);
      this.ackTimers.delete(commandId);
      const updated = this.store.updateInput(commandId, { status: 'acknowledged' })!;
      this.log('input.acknowledged', { commandId });
      this.trace('input.ack', `operator acknowledged tap ${commandId.slice(0, 8)}`, { commandId });
      return { commandId, status: updated.status, routed: updated.routed };
    }
    // Already settled: acknowledged before (idempotent), or it fell back to the bot first.
    if (event.status !== 'acknowledged') this.trace('input.ack.late', `late ack for tap ${commandId.slice(0, 8)}: already ${event.status}`, { commandId, status: event.status });
    return { commandId, status: event.status, routed: event.routed, ...(event.status === 'acknowledged' ? {} : { late: true }) };
  }

  private armAck(commandId: string, ms: number): void {
    const existing = this.ackTimers.get(commandId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.ackTimers.delete(commandId);
      void this.ackTimedOut(commandId);
    }, ms);
    timer.unref?.();
    this.ackTimers.set(commandId, timer);
  }

  /** No ack in time: the input goes to the scene's conversation through the bot instead. */
  private async ackTimedOut(commandId: string): Promise<void> {
    const event = this.store.inputByCommand(commandId);
    if (!event || (event.status !== 'pending' && event.status !== 'routing')) return;
    const scene = this.store.get(event.sceneId);
    if (!scene) {
      this.store.updateInput(commandId, { status: 'failed', routed: 'failed:scene-gone' });
      return;
    }
    // Claim the fallback before awaiting it, so a late ack can't also count as delivery.
    this.store.updateInput(commandId, { status: 'fallback', routed: 'fallback' });
    let routed: string;
    try {
      routed = await this.fallback(scene, { sceneId: scene.id, type: event.type, data: event.data, commandId, conversationKey: scene.conversationKey });
    } catch (err) {
      routed = `failed:${(err as Error).message}`;
    }
    const status: InputStatus = routed === 'agent' ? 'fallback' : 'failed';
    this.store.updateInput(commandId, { status, routed });
    this.log('input.fallback', { commandId, sceneId: scene.id, routed, status });
    this.trace('input.fallback', `no operator ack in ${this.ackTimeoutMs} ms: tap ${commandId.slice(0, 8)} went to the bot → ${routed} (${status})`, { commandId, sceneId: scene.id, routed, status });
    this.notifyDirectors('input-fallback', { commandId, sceneId: scene.id, routed, status });
    const label = event.type === 'choice' ? choiceLabel(scene, event.data) : undefined;
    this.broadcast('ack', { sceneId: scene.id, agentName: scene.agentName, type: event.type, ...(label ? { label } : {}), routed: routed === 'agent' ? 'agent' : routed, commandId, status, fallback: true });
  }

  /** After a restart: inputs that were waiting on an ack get the rest of their wait, then fall back. */
  private recoverInputs(): void {
    for (const event of this.store.unsettledInputs()) {
      if (!event.commandId) continue;
      // Stuck mid-route (the bot call never returned before the restart): replaying it could post
      // twice minutes later, so it fails instead.
      if (event.status === 'routing' && this.now() - event.updatedAt >= ROUTING_STALE_MS) {
        this.store.updateInput(event.commandId, { status: 'failed', routed: 'failed:interrupted' });
        this.log('input.interrupted', { commandId: event.commandId });
        this.trace('input.interrupted', `tap ${event.commandId.slice(0, 8)} failed: interrupted by a restart`, { commandId: event.commandId });
        continue;
      }
      this.armAck(event.commandId, Math.max(0, this.ackTimeoutMs - (this.now() - event.updatedAt)));
    }
  }

  // ── dashboard ──────────────────────────────────────────────────────────

  setTasks(tasks: DirectorTask[]): void {
    this.tasks = tasks;
    this.broadcastDashboard();
  }

  dashboard() {
    const scenes = this.store.live();
    const agents = new Map<string, { id: string; name: string; color: string; tasks: DirectorTask[]; scenes: PublicScene[] }>();
    const entry = (id: string, name: string) => {
      let agent = agents.get(id);
      if (!agent) {
        agent = { id, name, color: agentColor(id), tasks: [], scenes: [] };
        agents.set(id, agent);
      }
      return agent;
    };
    for (const task of this.tasks) entry(task.agentId, task.agentName).tasks.push(task);
    for (const scene of scenes) entry(scene.agentId, scene.agentName).scenes.push(publicScene(scene));
    const busy = (agent: { tasks: DirectorTask[] }) => (agent.tasks.some((task) => task.status !== 'done') ? 1 : 0);
    return {
      operatorLive: this.operatorLive,
      showingId: this.showingScene()?.id ?? null,
      screens: this.screenList().length,
      /** Every connected window and what it is for (Settings › Windows; a control window looks for a screen one). */
      windows: this.screenList().map(({ id, name, role, feedScope }) => ({ id, name, role, feedScope })),
      /** What a screen window may keep showing after the desk moves on: only what is still live. */
      liveSceneIds: scenes.map((scene) => scene.id),
      livePrototypes: (this.prototypes?.live() ?? []).map(publicPrototype),
      agents: [...agents.values()].sort(
        (a, b) => busy(b) - busy(a) || (b.scenes[0]?.updatedAt ?? 0) - (a.scenes[0]?.updatedAt ?? 0),
      ),
    };
  }

  status() {
    return {
      screens: this.screenList(),
      operatorLive: this.operatorLive,
      showing: this.showingScene(),
      inboxFocus: this.inboxFocus,
      presentation: this.publicPresentation(),
      prototypePage: this.presentation.view === 'prototype' ? this.prototypePage(this.presentation.prototypeId) : null,
      listPage: this.listPage(),
      stages:this.dashboard().agents.map((agent) => ({ agentId: agent.id, agentName: agent.name, scenes: agent.scenes })),
    };
  }

  setInboxFocus(itemId: string | null): void {
    if (this.inboxFocus === itemId) return;
    this.inboxFocus = itemId;
    this.notifyDirectors('inbox-focus', { itemId });
  }

  /** Asks the screens to open an item's detail view (voice: "show me the Foxtrot one"). */
  openInboxItem(itemId: string): void {
    this.setInboxFocus(itemId);
    this.broadcast('inbox-open', { itemId });
  }

  /** Inbox items changed: screens and the operator re-read what they show. */
  inboxChanged(ids: string[]): void {
    this.broadcast('inbox', { changed: ids });
    this.notifyDirectors('inbox', { changed: ids });
  }

  /** Live scenes, for linking inbox items to what their agent staged. */
  liveScenes(): Scene[] {
    return this.store.live();
  }

  /** Stops timers (tests, shutdown). */
  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    for (const timer of this.ackTimers.values()) clearTimeout(timer);
    this.ackTimers.clear();
  }

  private broadcastPresentation(): void {
    const presentation = this.publicPresentation();
    // A detached window keeps its own presentation: the owner's moves don't reach it.
    for (const { info, sink } of this.screens.values()) if (!info.detached) sink.send('presentation', presentation);
    this.notifyDirectors('presentation', presentation);
    for (const listener of this.presentationListeners) listener(presentation);
  }

  private broadcastDashboard(): void {
    const dashboard = this.dashboard();
    for (const { sink } of this.screens.values()) sink.send('dashboard', dashboard);
  }

  private broadcast(event: string, data: unknown): void {
    const forOwner = OWNER_EVENTS.has(event);
    for (const { info, sink } of this.screens.values()) if (!(forOwner && info.detached)) sink.send(event, data);
  }

  private notifyDirectors(event: string, data: unknown): void {
    for (const { sink } of this.directors.values()) sink.send(event, data);
  }
}

export function choiceLabel(scene: Pick<Scene, 'choices'>, data: Record<string, unknown>): string | undefined {
  const id = typeof data.choiceId === 'string' ? data.choiceId : undefined;
  const fromScene = id ? scene.choices.find((choice) => choice.id === id)?.label : undefined;
  return fromScene ?? (typeof data.label === 'string' ? data.label : id);
}

function clipText(text: string, max: number): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
