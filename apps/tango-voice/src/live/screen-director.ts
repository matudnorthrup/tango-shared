// The operator's handle on the screen service (apps/screen). Agents stage
// scenes there; the operator, as director, decides what is showing. While a
// session is live the operator holds a director connection, which is also how
// the service knows to send taps here instead of to the agent's channel.

export interface ScreenChoice {
  id: string;
  label: string;
}

export interface ScreenScene {
  id: string;
  agentId: string;
  agentName: string;
  slot: string;
  kind: string;
  title: string;
  summary: string;
  choices: ScreenChoice[];
  urgent: boolean;
  version: number;
  updatedAt: number;
  /** The conversation that staged it (thread, or the agent's channel), when the service reports it. */
  threadId?: string | null;
  channelId?: string | null;
  /** "thread:<id>" / "channel:<id>", when the staging turn reported one. */
  conversationKey?: string | null;
}

export interface ScreenTask {
  agentId: string;
  agentName: string;
  request: string;
  status: 'running' | 'waiting_user' | 'done';
  progress?: string;
  updatedAt?: number;
}

/** A prototype (the desk's Prototype view): a page the owner uses, which uploaded ones let the operator drive. */
export interface ScreenPrototype {
  id: string;
  agentId: string;
  agentName: string;
  conversationKey: string;
  name: string;
  title: string;
  drivable: boolean;
  version: number;
  updatedAt: number;
}

/** What a prototype page reports through its navigation bridge (apps/screen prototype-bridge.ts). */
/** What the List on screen shows (the screen touched last): its tabs, the project it's in, its rows in order. */
export interface ListPage {
  place?: { page: 'inbox' | 'projects' | 'project' | 'agents' | 'agent' | 'system' | 'search' | 'spacesettings'; id?: string; view?: string; name: string };
  agents?: Array<{ id: string; name: string }>;
  tab: { id: string; name: string };
  tabs: Array<{ id: string; name: string; count: number }>;
  /** The views of the page on screen (a space's Overview, Threads, Jobs, Workers, Done; the Inbox's are its tabs), and the one it's on. */
  views?: Array<{ id: string; name: string; count: number }>;
  view?: { id: string; name: string };
  project: { id: string; name: string } | null;
  projects: Array<{ id: string; name: string }>;
  rows: Array<{ kind: 'project' | 'agent' | 'item'; id: string; title: string; where: string }>;
}

export interface PrototypePage {
  path: string;
  title: string;
  targets: Array<{ label: string; kind: string; inView: boolean }>;
  headings: string[];
  fields: string[];
  scroll: { percent: number; scrollable: boolean };
}

/** How a command on the prototype went: `ok: false` when, say, nothing on the page matched a click. */
export interface PrototypeResult {
  name: string;
  /** The command it answers, when the command carried one. */
  commandId?: string | null;
  ok: boolean;
  detail: string;
}

/** What every screen presents (the hub's presentation state, agent-desk spec "Screen model"). */
export interface PresentationState {
  view: 'active' | 'conversation' | 'screen' | 'prototype';
  itemId: string | null;
  conversationKey: string | null;
  sceneId: string | null;
  /** The Prototype view's prototype, and the current conversation's prototypes. */
  prototypeId?: string | null;
  prototype?: ScreenPrototype | null;
  prototypes?: ScreenPrototype[];
  by?: string;
  manual?: boolean;
  reason?: string | null;
  /** When the screens moved to this view (epoch ms). */
  since?: number;
}

export interface PresentationIntent {
  view: PresentationState['view'];
  itemId?: string;
  conversationKey?: string;
  sceneId?: string;
  prototypeId?: string;
  /** focus: automatic (follows the conversation, never beats a manual pick); user: the owner asked; idle: the call went quiet; done: the conversation on screen was finished; sent: a message just went out. */
  reason: 'focus' | 'user' | 'idle' | 'done' | 'sent';
}

/** Why the operator moves the screen: an automatic focus never counts as the owner's manual pick. */
export type ShowReason = 'focus' | 'user';

export interface ScreenHandlers {
  /** An agent staged or re-staged a scene. `showing` when it is already on screen. */
  onStaged(scene: ScreenScene, info: { replaced: boolean; showing: boolean }): void;
  /**
   * The user tapped a choice (or sent other input) on a scene. Return false when it was not
   * handled (the session is over): the input is then left unacknowledged and falls back to the bot.
   */
  onInput(scene: ScreenScene, type: string, data: Record<string, unknown>, meta?: { commandId?: string }): boolean | void;
}

export interface ScreenDirector {
  /** Taps and staging events go to these handlers; a second connect replaces the first's. */
  connect(handlers: ScreenHandlers): void;
  /** With handlers, only when they are still the connected ones (a newer session may own it now). */
  disconnect(handlers?: ScreenHandlers): void;
  /** Browsers showing the screen right now (from the last status refresh). */
  screensConnected(): number;
  showing(): ScreenScene | null;
  /** Live scenes, most recent first; one agent's when given. */
  staged(agentId?: string): ScreenScene[];
  showAgent(agentId: string, reason?: ShowReason): Promise<ScreenScene | null>;
  /** A specific scene, when the agent's newest isn't the relevant one. */
  showScene?(sceneId: string, reason?: ShowReason): Promise<ScreenScene | null>;
  showDashboard(): Promise<void>;
  back(): Promise<ScreenScene | null>;
  /** `args` for prototype commands: `{ target }` for click / go_to, `{ target, text }` for fill. */
  command(name: string, args?: Record<string, unknown>, commandId?: string): Promise<boolean>;
  /** What the prototype on screen last reported about its page (null off the Prototype view, or before it reports). */
  prototypePage?(): PrototypePage | null;
  /** What the List on screen last reported (null before any screen reports). */
  listPage?(): ListPage | null;
  /** Resolves with the List once it reports one that passes `test` (after a voice tab switch), or null after `timeoutMs`. */
  waitForList?(test: (page: ListPage) => boolean, timeoutMs: number): Promise<ListPage | null>;
  /**
   * How the command with this id went, or null if no screen reports in time. With several screens
   * the first success wins; a miss counts only when no screen succeeds within a short grace.
   */
  prototypeResult?(commandId: string, timeoutMs: number): Promise<PrototypeResult | null>;
  /** When the prototype on screen last reported a change (the owner clicking or scrolling it), epoch ms. */
  prototypeActivityAt?(): number;
  setTasks(tasks: ScreenTask[]): void;
  /** The presentation as last reported (director stream or status), if the service has one. */
  presentation?(): PresentationState | null;
  /** A presentation intent as the director; false when the service refused it or lacks the endpoint. */
  present?(intent: PresentationIntent): Promise<boolean>;
}

interface StatusResponse {
  screens: unknown[];
  operatorLive: boolean;
  showing: ScreenScene | null;
  presentation?: PresentationState | null;
  prototypePage?: PrototypePage | null;
  listPage?: ListPage | null;
  stages: Array<{ agentId: string; agentName: string; scenes: ScreenScene[] }>;
}

export function choiceLabel(scene: Pick<ScreenScene, 'choices'>, data: Record<string, unknown>): string | undefined {
  const id = typeof data.choiceId === 'string' ? data.choiceId : undefined;
  return (id ? scene.choices.find((choice) => choice.id === id)?.label : undefined) ?? (typeof data.label === 'string' ? data.label : id);
}

export const SCREEN_HINT =
  '[A screen is live where the user can see it. When you compare options, give a plan or checklist, or show numbers, stage it with the screen tool (in its own slot) and keep your reply to the gist. Only say something is on the screen if you staged it in this turn.]';

/** Parses a text/event-stream body into (event, data) pairs. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary: number;
    while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) yield { event, data: data.join('\n') };
    }
  }
}

export class HttpScreenDirector implements ScreenDirector {
  private status: StatusResponse = { screens: [], operatorLive: false, showing: null, stages: [] };
  private abort: AbortController | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private tasksTimer: NodeJS.Timeout | null = null;
  private pendingTasks: ScreenTask[] | null = null;
  private presented: PresentationState | null = null;
  private handlers: ScreenHandlers | null = null;
  private page: { prototypeId: string; page: PrototypePage } | null = null;
  private list: ListPage | null = null;
  private readonly listWaiters = new Set<(page: ListPage) => void>();
  private pageAt = 0;
  private readonly resultWaiters = new Set<(result: PrototypeResult) => boolean>();

  constructor(
    private readonly baseUrl: string,
    private readonly log: (event: string, data?: Record<string, unknown>) => void = () => {},
  ) {}

  connect(handlers: ScreenHandlers): void {
    // One director connection, shared across voice sessions: the newest session's handlers get the events.
    this.handlers = handlers;
    if (this.abort) return;
    const abort = new AbortController();
    this.abort = abort;
    void this.listen(abort);
    void this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), 15_000);
  }

  disconnect(handlers?: ScreenHandlers): void {
    if (handlers && handlers !== this.handlers) return;
    this.handlers = null;
    this.abort?.abort();
    this.abort = null;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  private async listen(abort: AbortController): Promise<void> {
    while (!abort.signal.aborted) {
      try {
        // ?ack=1: this director acknowledges every input it handles; one it doesn't falls back to the bot.
        const response = await fetch(`${this.baseUrl}/director/stream?ack=1`, { signal: abort.signal, headers: { Accept: 'text/event-stream' } });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        this.log('screen.director.connected', {});
        for await (const { event, data } of readSse(response.body)) {
          const payload = JSON.parse(data) as Record<string, unknown>;
          if (event === 'hello') {
            this.status = payload as unknown as StatusResponse;
            this.presented = (payload.presentation as PresentationState | undefined) ?? this.presented;
            this.notePage(this.status.prototypePage ?? null);
            this.list = this.status.listPage ?? null;
            this.noteList(this.list);
          } else if (event === 'list-page') {
            // null: the screen that reported it left and no other screen has a List.
            this.list = (payload.page as ListPage | null | undefined) ?? null;
            if (this.list) this.noteList(this.list);
          } else if (event === 'presentation') {
            this.presented = payload as unknown as PresentationState;
          } else if (event === 'prototype-page') {
            if (typeof payload.prototypeId === 'string' && payload.page) {
              this.page = { prototypeId: payload.prototypeId, page: payload.page as PrototypePage };
              this.pageAt = Date.now();
            }
          } else if (event === 'prototype-activity') {
            this.pageAt = Date.now();
          } else if (event === 'prototype-result') {
            const result = { name: String(payload.name ?? ''), commandId: typeof payload.commandId === 'string' ? payload.commandId : null, ok: payload.ok === true, detail: String(payload.detail ?? '') };
            for (const waiter of [...this.resultWaiters]) waiter(result);
          } else if (event === 'staged') {
            await this.refresh();
            this.handlers?.onStaged(payload.scene as ScreenScene, { replaced: payload.replaced === true, showing: payload.showing === true });
          } else if (event === 'input') {
            const commandId = typeof payload.commandId === 'string' ? payload.commandId : undefined;
            const handled = this.handlers
              ? this.handlers.onInput(payload.scene as ScreenScene, String(payload.type), (payload.data ?? {}) as Record<string, unknown>, { commandId }) !== false
              : false;
            if (handled && commandId) void this.ackInput(commandId);
          } else if (event === 'showing' || event === 'cleared') {
            await this.refresh();
          }
        }
      } catch (err) {
        if (abort.signal.aborted) return;
        this.log('screen.director.error', { message: (err as Error).message });
      }
      if (!abort.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  /** Tells the hub this operator took the input (POST /api/input/:commandId/ack). */
  async ackInput(commandId: string): Promise<boolean> {
    const result = await this.post<{ status?: string }>(`/api/input/${encodeURIComponent(commandId)}/ack`, {});
    if (!result) this.log('screen.ack.failed', { commandId });
    return result !== null;
  }

  private async refresh(): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/api/status`, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        this.status = (await response.json()) as StatusResponse;
        if (this.status.presentation) this.presented = this.status.presentation;
        this.notePage(this.status.prototypePage ?? null);
        this.list = this.status.listPage ?? null;
        this.noteList(this.list);
      }
    } catch {
      // Keep the last known status; the screen service may be restarting.
    }
  }

  presentation(): PresentationState | null {
    return this.presented;
  }

  /** The status carries the page of the prototype on screen (it reports again after a reload anyway). */
  private notePage(page: PrototypePage | null): void {
    const id = this.presented?.view === 'prototype' ? this.presented.prototypeId : null;
    if (page && id) this.page = { prototypeId: id, page };
  }

  private noteList(page: ListPage | null): void {
    if (!page) return;
    this.list = page;
    for (const waiter of [...this.listWaiters]) waiter(page);
  }

  listPage(): ListPage | null {
    return this.list;
  }

  waitForList(test: (page: ListPage) => boolean, timeoutMs: number): Promise<ListPage | null> {
    if (this.list && test(this.list)) return Promise.resolve(this.list);
    return new Promise((resolve) => {
      const waiter = (page: ListPage) => {
        if (!test(page)) return;
        clearTimeout(timer);
        this.listWaiters.delete(waiter);
        resolve(page);
      };
      const timer = setTimeout(() => {
        this.listWaiters.delete(waiter);
        resolve(null);
      }, timeoutMs);
      this.listWaiters.add(waiter);
    });
  }

  prototypePage(): PrototypePage | null {
    const p = this.presented;
    if (p?.view !== 'prototype' || !p.prototypeId || this.page?.prototypeId !== p.prototypeId) return null;
    return this.page.page;
  }

  prototypeActivityAt(): number {
    return this.pageAt;
  }

  prototypeResult(commandId: string, timeoutMs: number): Promise<PrototypeResult | null> {
    return new Promise((resolve) => {
      let miss: PrototypeResult | null = null;
      let graceTimer: NodeJS.Timeout | null = null;
      const finish = (result: PrototypeResult | null) => {
        clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        this.resultWaiters.delete(waiter);
        resolve(result);
      };
      const waiter = (result: PrototypeResult) => {
        if (result.commandId !== commandId) return false;
        if (result.ok) finish(result);
        else if (!miss) {
          // Another screen may have done it: a miss stands only if no success follows shortly.
          miss = result;
          graceTimer = setTimeout(() => finish(miss), 700);
          graceTimer.unref?.();
        }
        return false;
      };
      const timer = setTimeout(() => finish(miss), timeoutMs);
      timer.unref?.();
      this.resultWaiters.add(waiter);
    });
  }

  async present(intent: PresentationIntent): Promise<boolean> {
    const result = await this.post<{ applied?: boolean; presentation?: PresentationState }>('/api/desk/presentation', { ...intent, by: 'director' });
    if (result?.presentation) this.presented = result.presentation;
    return result !== null && result.applied !== false;
  }

  screensConnected(): number {
    return this.status.screens.length;
  }

  showing(): ScreenScene | null {
    return this.status.showing;
  }

  staged(agentId?: string): ScreenScene[] {
    const scenes = this.status.stages.flatMap((stage) => stage.scenes);
    return (agentId ? scenes.filter((scene) => scene.agentId === agentId) : scenes).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as T;
    } catch (err) {
      this.log('screen.error', { path, message: (err as Error).message });
      return null;
    }
  }

  async showAgent(agentId: string, reason: ShowReason = 'focus'): Promise<ScreenScene | null> {
    const result = await this.post<{ showing: ScreenScene | null }>('/api/show', { agentId, reason });
    if (result) this.status = { ...this.status, showing: result.showing ?? this.status.showing };
    return result?.showing ?? null;
  }

  async showScene(sceneId: string, reason: ShowReason = 'focus'): Promise<ScreenScene | null> {
    const result = await this.post<{ showing: ScreenScene | null }>('/api/show', { sceneId, reason });
    if (result) this.status = { ...this.status, showing: result.showing ?? this.status.showing };
    return result?.showing ?? null;
  }

  async showDashboard(): Promise<void> {
    await this.post('/api/show', { dashboard: true });
    this.status = { ...this.status, showing: null };
  }

  async back(): Promise<ScreenScene | null> {
    const result = await this.post<{ showing: ScreenScene | null }>('/api/back', {});
    this.status = { ...this.status, showing: result?.showing ?? null };
    return result?.showing ?? null;
  }

  async command(name: string, args?: Record<string, unknown>, commandId?: string): Promise<boolean> {
    return (await this.post<{ sent: boolean }>('/api/command', { name, ...(args ? { args } : {}), ...(commandId ? { commandId } : {}) }))?.sent === true;
  }

  /** Debounced: task changes come in bursts. */
  setTasks(tasks: ScreenTask[]): void {
    this.pendingTasks = tasks;
    if (this.tasksTimer) return;
    this.tasksTimer = setTimeout(() => {
      this.tasksTimer = null;
      const next = this.pendingTasks;
      this.pendingTasks = null;
      if (next) void this.post('/api/director/tasks', { tasks: next });
    }, 300);
  }
}
