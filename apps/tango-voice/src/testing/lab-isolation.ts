// What keeps a voice lab session (lab:tts-session, lab:desk-e2e) off the owner's own desk input.
//
// The screen service has one director link and one operator desk stream, and they belong to the owner's
// operator: whoever holds them gets the owner's taps (scene choices, Draft card Send/Cancel, the pause
// pill) and moves the owner's screens. A lab that holds them takes the owner's taps as its own. A lab session
// therefore never connects either one:
//   - LabScreen is its own screen: presentation, the List (on the desk's own browser model) and screen
//     commands all stay in the process. Nothing is posted to the hub.
//   - LabDesk reads the real desk but streams as `?client=lab` (never relayed taps), hears item events
//     for its scratch items only, hides the owner's other conversations from unprompted speech, and
//     keeps its operator captions, Draft card and pause pill to itself.
//   - labFenceVerdict is the backstop on every request to the desk: an allow-list of writes on scratch
//     items, and no director link or operator stream even if some path tries.

import type { DeskItemEvent, DeskItemSummary, HttpDeskClientOptions, OperatorStatusUpdate } from '../live/desk-client.js';
import { HttpDeskClient } from '../live/desk-client.js';
import type { DraftCard, DraftScreenCommand } from '../live/draft-mode.js';
import type { PauseCard, PauseScreenCommand } from '../live/pause-mode.js';
import type { ListPage, PresentationIntent, PresentationState } from '../live/screen-director.js';

export type LabRecord = (kind: string, data: Record<string, unknown>) => void;

/** Why the lab may not make this request to the desk (null: it may). `path` includes the query. */
export function labFenceVerdict(request: { method: string; path: string; body?: any }, scratch: ReadonlySet<string>): string | null {
  const method = request.method.toUpperCase();
  const [path, query = ''] = request.path.split('?');
  const params = new URLSearchParams(query);
  if (method === 'GET') {
    if (path === '/director/stream') return 'the screen director link belongs to the owner’s operator';
    if (path === '/api/desk/stream' && (params.get('client') ?? '') === 'operator') return 'the operator desk stream carries the owner’s taps';
    return null;
  }
  const body = request.body ?? null;
  if (path === '/api/desk/trace' || path === '/api/desk/lab-fence' || path.startsWith('/api/desk/lab-fence/')) return null;
  if (path === '/api/desk/commands') {
    if (!body?.itemId) return `command ${body?.type ?? '?'} with no item (it would touch the whole desk)`;
    return scratch.has(body.itemId) ? null : `command on ${body.itemId}`;
  }
  if (path === '/api/desk/capacity/move') return scratch.has(body?.itemId) ? null : `move of ${body?.itemId}`;
  if (path.startsWith('/api/desk/projects/')) {
    const id = decodeURIComponent(path.split('/')[4] ?? '');
    return scratch.has(`project:${id}`) ? null : `project action on ${id}`;
  }
  if (path.startsWith('/api/desk/start-work') || path.startsWith('/api/desk/agent-threads') || path.startsWith('/api/desk/mail')) return 'starts a new thread or mails one';
  if (/^\/api\/(show|back|command|input\/|director\/|desk\/(presentation|operator|draft|pause))/.test(path)) return 'writes to the owner’s screens';
  return `${method} ${path} is not a lab write`;
}

interface ListRoute {
  page: string;
  id?: string;
  view?: string;
}

/** The state the desk's List model (apps/screen/public/desk/next/model.js nextListReport) reads. */
export interface LabListState {
  nextRoute: ListRoute;
  listTab: string;
  nextPageViews: Record<string, string>;
  [key: string]: unknown;
}

const BOARD: PresentationState = { view: 'active', itemId: null, conversationKey: null, sceneId: null };

/**
 * A screen of the lab's own (a ScreenDirector): what is presented, the List and its commands live here,
 * mirroring apps/screen/public/desk/next/main.js's list commands. It never opens the director link, so
 * no tap of the owner's can reach the lab, and nothing it does moves the owner's screens.
 */
export class LabScreen {
  /** What is presented (public: desk-e2e scenarios check it). */
  presented: PresentationState;
  private readonly listeners = new Set<(presentation: PresentationState) => void>();

  constructor(
    private readonly options: {
      state: LabListState;
      /** The desk's nextListReport. */
      report: (state: LabListState) => ListPage;
      presentation?: PresentationState;
      record?: LabRecord;
      /** Reads the desk again before a List command (a live lab); the snapshot lab has none. */
      refresh?: (state: LabListState) => Promise<void>;
      /**
       * Stamps a move as the hub does (by director, since) and tells presentation listeners, as the hub
       * relays it on the desk stream (a live lab). Off, a move is just kept (the snapshot lab's model).
       */
      relay?: { now: () => number };
    },
  ) {
    this.presented = options.presentation ?? { ...BOARD };
  }

  get state(): LabListState {
    return this.options.state;
  }

  private record(kind: string, data: Record<string, unknown>): void {
    this.options.record?.(kind, data);
  }

  connect(): void {}
  disconnect(): void {}
  screensConnected() {
    return 1;
  }
  showing() {
    return null;
  }
  staged() {
    return [];
  }
  async showAgent() {
    return null;
  }
  async showScene() {
    return null;
  }
  async showDashboard() {
    this.presented = { ...BOARD };
    this.record('screen.dashboard', {});
  }
  async back() {
    return null;
  }
  private go(route: ListRoute) {
    this.state.nextRoute = route;
    if (route.page === 'inbox' && route.view) this.state.listTab = route.view;
  }
  private pageKey() {
    const r = this.state.nextRoute;
    return r.page === 'inbox' ? null : r.id ? `${r.page}:${r.id}` : r.page;
  }
  async command(name: string, args: any = {}) {
    this.record('screen.command', { name, args });
    if (name.startsWith('list_')) await this.options.refresh?.(this.state);
    const r = this.state.nextRoute;
    if (name === 'list_tab' && typeof args.tab === 'string') this.go({ page: 'inbox', view: args.tab });
    else if (name === 'list_view' && typeof args.view === 'string') {
      const key = this.pageKey();
      if (key) this.state.nextPageViews = { ...this.state.nextPageViews, [key]: args.view };
      else this.go({ page: 'inbox', view: args.view });
    } else if (name === 'list_back') {
      if (this.presented.view !== 'active') this.presented = { ...BOARD };
      else if (r.page === 'project') this.go({ page: 'projects' });
      else if (r.page === 'agent') this.go({ page: 'agents' });
      else if (r.page !== 'inbox') this.go({ page: 'inbox', view: this.state.listTab });
    } else if (name === 'list_place') this.go(args.page === 'inbox' ? { page: 'inbox', view: this.state.listTab } : args.page === 'capacity' ? { page: 'system', view: 'capacity' } : { page: args.page, ...(args.id ? { id: args.id } : {}) });
    else if (name === 'list_project') this.go(args.project ? { page: 'project', id: args.project } : { page: 'inbox', view: this.state.listTab });
    if (this.presented.view !== 'active' && ['list_tab', 'list_view', 'list_place', 'list_project'].includes(name)) this.presented = { ...BOARD };
    return true;
  }
  setTasks() {}
  listPage() {
    return this.options.report(this.state);
  }
  async waitForList(test: (page: ListPage) => boolean) {
    const page = this.listPage();
    return test(page) ? page : null;
  }
  presentation() {
    return this.presented;
  }
  /** Presents here only, never on the owner's screens. */
  async present(intent: PresentationIntent) {
    this.record('screen.present', intent as unknown as Record<string, unknown>);
    this.presented = { view: intent.view, itemId: intent.itemId ?? null, conversationKey: intent.conversationKey ?? null, sceneId: intent.sceneId ?? null, reason: intent.reason };
    const relay = this.options.relay;
    if (relay) {
      this.presented = { ...this.presented, by: 'director', manual: intent.reason === 'user', since: relay.now() };
      for (const listener of [...this.listeners]) listener(this.presented);
    }
    return true;
  }
  prototypePage() {
    return null;
  }
  onPresentation(handler: (presentation: PresentationState) => void): void {
    this.listeners.add(handler);
  }
  offPresentation(handler: (presentation: PresentationState) => void): void {
    this.listeners.delete(handler);
  }
}

/**
 * The real desk for a lab session: reads and (fenced) commands go to it, but the stream is `?client=lab`
 * (the desk relays no taps to it), only scratch items' events are heard, and the operator captions, Draft
 * card and pause pill stay here instead of showing on the owner's screens. Presentation comes from the
 * lab's own screen.
 */
export class LabDesk extends HttpDeskClient {
  /** Item events for conversations outside the scratch set, dropped (their ids, with counts). */
  readonly ignored = new Map<string, number>();
  readonly drafts: DraftCard[] = [];
  readonly pauses: PauseCard[] = [];
  operatorUpdates = 0;
  private readonly wrapped = new Map<(event: DeskItemEvent) => void, (event: DeskItemEvent) => void>();
  private draftCommands: ((command: DraftScreenCommand) => void) | null = null;
  private pauseCommands: ((command: PauseScreenCommand) => void) | null = null;

  constructor(
    baseUrl: string,
    private readonly lab: { scratch: ReadonlySet<string>; screen: LabScreen; record?: LabRecord },
    options: HttpDeskClientOptions = {},
  ) {
    super(baseUrl, { ...options, streamClient: 'lab' });
  }

  /**
   * The owner's conversations stay readable (asked about, searched), but hidden: the operator never speaks
   * them unprompted, so the start-of-call notices are about scratch items only (Codex review on #768).
   */
  private readonly offScratch = (item: DeskItemSummary): DeskItemSummary => (this.lab.scratch.has(item.id) ? item : { ...item, hidden: true });

  override items(): DeskItemSummary[] {
    return super.items().map(this.offScratch);
  }

  override async refresh(): Promise<DeskItemSummary[]> {
    return (await super.refresh()).map(this.offScratch);
  }

  override connect(onItem: (event: DeskItemEvent) => void): void {
    const filtered = (event: DeskItemEvent) => {
      if (this.lab.scratch.has(event.id)) onItem(event);
      else this.ignored.set(event.id, (this.ignored.get(event.id) ?? 0) + 1);
    };
    this.wrapped.set(onItem, filtered);
    super.connect(filtered);
  }

  override disconnect(onItem?: (event: DeskItemEvent) => void): void {
    if (!onItem) return super.disconnect();
    const filtered = this.wrapped.get(onItem);
    if (!filtered) return;
    this.wrapped.delete(onItem);
    super.disconnect(filtered);
  }

  override publishOperator(_update: OperatorStatusUpdate): void {
    this.operatorUpdates += 1;
  }

  override publishDraft(card: DraftCard): void {
    this.drafts.push(card);
    this.lab.record?.('desk.draft', { phase: (card as { phase?: unknown })?.phase ?? null });
  }

  override publishPause(card: PauseCard): void {
    this.pauses.push(card);
    this.lab.record?.('desk.pause', { card: card as unknown as Record<string, unknown> });
  }

  override onDraftCommand(handler: ((command: DraftScreenCommand) => void) | null): void {
    this.draftCommands = handler;
  }

  override onPauseCommand(handler: ((command: PauseScreenCommand) => void) | null): void {
    this.pauseCommands = handler;
  }

  /** A Send / Cancel on the lab's own Draft card (a script step can tap it; the owner's card never can). */
  tapDraft(command: DraftScreenCommand): void {
    this.draftCommands?.(command);
  }

  tapPause(command: PauseScreenCommand): void {
    this.pauseCommands?.(command);
  }

  override onPresentation(handler: (presentation: PresentationState) => void): void {
    this.lab.screen.onPresentation(handler);
  }

  override offPresentation(handler: (presentation: PresentationState) => void): void {
    this.lab.screen.offPresentation(handler);
  }
}
