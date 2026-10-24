import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { deriveNextItems, type DeskCapacity, type DeskSystemBrief, type DeskProjectAction, type DeskSearchHit, type AgentThreadOutcome, type AgentThreadRequest, type CatchupWalk, type CatchupWalkAsk, type ChapterActResult, type ChapterVoicePlan, type DeskBriefing, type DeskClient, type DeskNextItem, type DeskCommandResult, type DeskCommandType, type DeskItemDetail, type DeskItemEvent, type DeskItemSummary, type DeskMessage, type OperatorStatusUpdate, type OperatorTraceEntry } from '../src/live/desk-client.js';
import type { DraftCard, DraftScreenCommand } from '../src/live/draft-mode.js';
import type { PauseCard, PauseScreenCommand } from '../src/live/pause-mode.js';
import type { LiveContextKind } from '../src/live/gpt-live-client.js';
import type { PresentationIntent, PresentationState, ScreenDirector, ScreenHandlers, ScreenScene, ScreenTask } from '../src/live/screen-director.js';

// Synthetic stand-ins for the Agent Desk and the presentation hub, for operator tests.
// Ids are placeholders (runs of zeros), never real Discord snowflakes.

export function deskItem(id: string, agentId: string, extra: Partial<DeskItemSummary> = {}): DeskItemSummary {
  const threadId = extra.threadId ?? null;
  // A coding thread (Loom) is its own conversation, keyed by its item id.
  const coding = agentId === 'loom' || agentId === 'loom';
  return {
    id,
    source: coding ? agentId : 'discord',
    kind: threadId || coding ? 'thread' : 'chapter',
    conversationKey: threadId ? `thread:${threadId}` : coding ? id : `channel:home-${agentId}`,
    agentId,
    agentName: agentId === 'loom' ? 'Loom' : agentId.charAt(0).toUpperCase() + agentId.slice(1),
    place: null,
    channelId: threadId ? null : `home-${agentId}`,
    threadId,
    nextStep: 'fyi',
    ask: null,
    options: [],
    summary: { gist: `${agentId} update` },
    facts: {},
    watching: null,
    disposition: 'active',
    seen: 'new',
    lastActivityAt: 1,
    lastAgentMessageId: `${id}-m1`,
    revision: 1,
    ...extra,
  };
}

export interface RecordedCommand {
  type: DeskCommandType;
  itemId: string | undefined;
  args: Record<string, unknown>;
  commandId: string;
}

export class FakeDesk implements DeskClient {
  list: DeskItemSummary[] = [];
  messages = new Map<string, DeskMessage[]>();
  commands: RecordedCommand[] = [];
  operatorUpdates: OperatorStatusUpdate[] = [];
  /** What the operator posted to the session trace. */
  traces: OperatorTraceEntry[] = [];
  briefingValue: DeskBriefing | null = { text: 'Nothing is waiting on you and there are no new updates.', yourMove: [], fyi: [] };
  handler: ((event: DeskItemEvent) => void) | null = null;
  /** Draft cards the operator published (draft mode). */
  drafts: DraftCard[] = [];
  draftHandler: ((command: DraftScreenCommand) => void) | null = null;
  /** Pause pills the operator published (pause mode). */
  pauses: PauseCard[] = [];
  pauseHandler: ((command: PauseScreenCommand) => void) | null = null;
  /** Decide a command's outcome (default: applied). */
  respond: (command: RecordedCommand) => Partial<DeskCommandResult> | Promise<Partial<DeskCommandResult>> = () => ({ status: 'applied' });

  constructor(items: DeskItemSummary[] = []) {
    this.list = items;
  }

  /** New agent threads asked of the desk (POST /api/desk/agent-threads). */
  agentThreads: AgentThreadRequest[] = [];
  /** Decide an agent-thread start's outcome (default: started, with a placeholder thread id). */
  agentThreadResult: (request: AgentThreadRequest) => AgentThreadOutcome | Promise<AgentThreadOutcome> = (request) => {
    const threadId = `15500000000000000${String(this.agentThreads.length).padStart(2, '0')}`;
    return { ok: true, threadId, itemId: `discord:thread:${threadId}`, title: request.title ?? 'New thread' };
  };
  async startAgentThread(request: AgentThreadRequest): Promise<AgentThreadOutcome> {
    this.agentThreads.push(request);
    return this.agentThreadResult(request);
  }

  /** GET /api/desk/search: these hits for any query (null: the desk can't search). */
  searchHits: DeskSearchHit[] | null = [];
  searches: string[] = [];
  async search(query: string) {
    this.searches.push(query);
    return this.searchHits;
  }
  /** GET /api/desk/search/transcript/:id, by item. */
  transcripts = new Map<string, DeskMessage[]>();
  async transcript(itemId: string) {
    return this.transcripts.get(itemId) ?? null;
  }
  /** GET /api/desk/items?view=everything, a project's open members (default: the active list's). */
  members: DeskItemSummary[] | null = null;
  async projectMembers(projectId: string) {
    return (this.members ?? this.list).filter((item) => item.facts?.projectId === projectId && item.disposition !== 'done');
  }
  /** GET /api/desk/capacity. */
  capacityValue: DeskCapacity | null = null;
  async capacity() {
    return this.capacityValue;
  }
  /** GET /api/desk/system/brief. */
  systemValue: DeskSystemBrief | null = null;
  async system() {
    return this.systemValue;
  }
  /** POST /api/desk/capacity/move and /api/desk/projects/:id/action, as asked. */
  moves: Array<{ itemId: string; account: string }> = [];
  async moveAccount(itemId: string, account: string) {
    this.moves.push({ itemId, account });
    return { ok: true as const };
  }
  projectActions: Array<{ projectId: string; action: DeskProjectAction }> = [];
  async projectAction(projectId: string, action: DeskProjectAction) {
    this.projectActions.push({ projectId, action });
    return { ok: true as const, held: 2, acted: 3, stayed: 0 };
  }

  items() {
    return this.list;
  }
  /** The desk's open projects (GET /api/desk/settings). */
  projectList: Array<{ id: string; name: string; away?: { state: 'snoozed' | 'parked'; until?: number | null } }> = [];
  projects() {
    return this.projectList;
  }
  async refresh() {
    return this.list;
  }
  /** A slow desk: item() answers after this many ms. */
  itemDelayMs = 0;
  async item(id: string): Promise<DeskItemDetail | null> {
    if (this.itemDelayMs) await new Promise((resolve) => setTimeout(resolve, this.itemDelayMs));
    const item = this.list.find((candidate) => candidate.id === id);
    return item ? { ...item, messages: this.messages.get(id) ?? [] } : null;
  }
  async briefing() {
    return this.briefingValue;
  }
  /** Catch me up's walk (GET /api/desk/catchup/walk): unset is a desk without the ledger ('off', the briefing reads). */
  walkValue: ((ask: CatchupWalkAsk) => CatchupWalk | 'off' | null) | undefined = undefined;
  walkAsks: CatchupWalkAsk[] = [];
  async catchupWalk(ask: CatchupWalkAsk = {}): Promise<CatchupWalk | 'off' | null> {
    this.walkAsks.push(ask);
    return this.walkValue ? this.walkValue(ask) : 'off';
  }
  /** Lines marked seen, Accept / Defer and Fine by me, as asked. */
  seenCalls: Array<{ ids: number[]; via: string; outcome: string | null }> = [];
  seenResult: { ok: true } | { ok: false; error: string } = { ok: true };
  async updatesSeen(ids: number[], via: 'heard' | 'read' | 'deferred', outcome: string | null = null): Promise<{ ok: true } | { ok: false; error: string }> {
    this.seenCalls.push({ ids, via, outcome });
    return this.seenResult;
  }
  chapterPlanValue: ChapterVoicePlan | null = null;
  async chapterPlan(_spaceId: string): Promise<ChapterVoicePlan | null> { return this.chapterPlanValue; }
  chapterActs: Array<{ spaceId: string; how: 'accept' | 'defer' }> = [];
  chapterActResult: ({ ok: true } & ChapterActResult) | { ok: false; error: string; changed?: boolean; plan?: ChapterVoicePlan } = { ok: true, applied: { took: [], fine: [], seen: 0 }, left: [], failed: [] };
  /** An Accept the desk never answers (it may still be answering briefs). */
  chapterActHangs = false;
  chapterPlans: ChapterVoicePlan[] = [];
  async chapterAct(spaceId: string, how: 'accept' | 'defer', plan: ChapterVoicePlan) {
    this.chapterPlans.push(structuredClone(plan));
    this.chapterActs.push({ spaceId, how });
    if (this.chapterActHangs) return new Promise<never>(() => {});
    return this.chapterActResult;
  }
  confirmed: string[] = [];
  async decidedConfirm(decisionId: string): Promise<{ ok: true }> {
    this.confirmed.push(decisionId);
    return { ok: true };
  }
  /** GET /api/desk/next: this queue when set (null = the desk can't be read), else derived from the list. */
  nextValue: DeskNextItem[] | null | undefined = undefined;
  nextCalls = 0;
  async next(): Promise<DeskNextItem[] | null> {
    this.nextCalls += 1;
    return this.nextValue !== undefined ? this.nextValue : deriveNextItems(this.list);
  }
  async command(type: DeskCommandType, itemId: string | undefined, args: Record<string, unknown> = {}, commandId = randomUUID()): Promise<DeskCommandResult> {
    const command = { type, itemId, args, commandId };
    this.commands.push(command);
    const result = await this.respond(command);
    if ((result.status ?? 'applied') === 'applied' && (type === 'reply' || type === 'answer') && itemId) {
      const text = String(type === 'answer' ? args.option : args.text);
      this.messages.set(itemId, [...(this.messages.get(itemId) ?? []), { author: 'owner', text, at: Date.now() }]);
    }
    return { commandId, status: 'applied', ...result };
  }
  publishOperator(update: OperatorStatusUpdate) {
    this.operatorUpdates.push(update);
  }
  trace(entry: OperatorTraceEntry) {
    this.traces.push(entry);
  }
  publishDraft(card: DraftCard) {
    this.drafts.push(card);
  }
  onDraftCommand(handler: ((command: DraftScreenCommand) => void) | null) {
    this.draftHandler = handler;
  }
  publishPause(card: PauseCard) {
    this.pauses.push(card);
  }
  onPauseCommand(handler: ((command: PauseScreenCommand) => void) | null) {
    this.pauseHandler = handler;
  }
  /** The operator's presentation listener (desk stream `presentation` events). */
  presentationHandler: ((presentation: PresentationState) => void) | null = null;
  onPresentation(handler: (presentation: PresentationState) => void) {
    this.presentationHandler = handler;
  }
  offPresentation(handler: (presentation: PresentationState) => void) {
    if (this.presentationHandler === handler) this.presentationHandler = null;
  }
  /** The owner taps an item's card on a screen: the desk moves to its conversation, by: 'screen'. */
  tap(itemId: string, extra: Partial<PresentationState> = {}) {
    const item = this.list.find((candidate) => candidate.id === itemId);
    this.presentationHandler?.({ view: 'conversation', itemId, conversationKey: item?.conversationKey ?? null, sceneId: null, by: 'screen', manual: true, reason: null, since: Date.now(), ...extra });
  }
  /** The latest pause pill. */
  get pause(): PauseCard | undefined {
    return this.pauses.at(-1);
  }
  /** The latest Draft card. */
  get draft(): DraftCard | undefined {
    return this.drafts.at(-1);
  }
  traced(kind: string) {
    return this.traces.filter((entry) => entry.kind === kind);
  }
  connect(onItem: (event: DeskItemEvent) => void) {
    this.handler = onItem;
  }
  disconnect(onItem?: (event: DeskItemEvent) => void) {
    if (!onItem || onItem === this.handler) this.handler = null;
  }
  /** The desk saw a change: an agent message (optional), then the item event. */
  agentPosts(id: string, text: string, change: Partial<DeskItemSummary> = {}) {
    this.messages.set(id, [...(this.messages.get(id) ?? []), { author: 'agent', text, at: Date.now() }]);
    this.update(id, change);
  }
  update(id: string, change: Partial<DeskItemSummary>) {
    const item = this.list.find((candidate) => candidate.id === id);
    if (item) Object.assign(item, change, { revision: item.revision + 1, lastActivityAt: Date.now() });
    this.handler?.({ id, revision: item?.revision });
  }
  sent(type: DeskCommandType) {
    return this.commands.filter((command) => command.type === type);
  }
}

export function scene(id: string, agentId: string, extra: Partial<ScreenScene> = {}): ScreenScene {
  return { id, agentId, agentName: agentId, slot: id, kind: 'board', title: id, summary: '', choices: [], urgent: false, version: 1, updatedAt: 1, ...extra } as ScreenScene;
}

/** A screen service with a presentation hub. */
export class FakeDeskScreen implements ScreenDirector {
  handlers: ScreenHandlers | null = null;
  scenes: ScreenScene[] = [];
  current: ScreenScene | null = null;
  presented: PresentationState = { view: 'active', itemId: null, conversationKey: null, sceneId: null };
  intents: PresentationIntent[] = [];
  /** Screen commands ("scroll_down", …) sent to the desk. */
  commands: string[] = [];
  shows: Array<{ id: string; reason?: string }> = [];
  refuse = false;
  connect(handlers: ScreenHandlers) {
    this.handlers = handlers;
  }
  disconnect(handlers?: ScreenHandlers) {
    if (!handlers || handlers === this.handlers) this.handlers = null;
  }
  screensConnected() {
    return 1;
  }
  showing() {
    return this.current;
  }
  staged(agentId?: string) {
    return this.scenes.filter((candidate) => !agentId || candidate.agentId === agentId);
  }
  async showAgent(agentId: string, reason?: string) {
    const found = this.staged(agentId)[0] ?? null;
    if (found) {
      this.current = found;
      this.shows.push({ id: found.id, reason });
    }
    return found;
  }
  async showScene(sceneId: string, reason?: string) {
    const found = this.scenes.find((candidate) => candidate.id === sceneId) ?? null;
    if (found) {
      this.current = found;
      this.shows.push({ id: found.id, reason });
    }
    return found;
  }
  async showDashboard() {
    this.current = null;
    this.shows.push({ id: 'dashboard' });
  }
  async back() {
    return null;
  }
  /** The same commands with their args. */
  commandArgs: Array<{ name: string; args?: Record<string, unknown> }> = [];
  async command(name: string, args?: Record<string, unknown>) {
    this.commands.push(name);
    this.commandArgs.push({ name, args });
    return true;
  }
  setTasks(_tasks: ScreenTask[]) {}
  presentation() {
    return this.presented;
  }
  async present(intent: PresentationIntent) {
    this.intents.push(intent);
    if (this.refuse) return false;
    this.presented = { view: intent.view, itemId: intent.itemId ?? null, conversationKey: intent.conversationKey ?? null, sceneId: intent.sceneId ?? null, reason: intent.reason };
    return true;
  }
}

export class FakeClient extends EventEmitter {
  appends: Array<{ kind: LiveContextKind; content: string; delegationId: string | null }> = [];
  appendContext(kind: LiveContextKind, content: string, delegationId: string | null) {
    this.appends.push({ kind, content, delegationId });
    return Promise.resolve({ clientEventId: 'x' });
  }
  ask(id: string, words: string) {
    this.emit('inputTranscript', { delta: ` ${words}`, startMs: Date.now(), endMs: Date.now() });
    this.emit('delegation', { id, offsetMs: 0 });
  }
  user(text: string) {
    this.emit('inputTranscript', { delta: text, startMs: Date.now(), endMs: Date.now() });
  }
  operator(text: string) {
    this.emit('outputTranscript', { delta: text, startMs: Date.now(), endMs: Date.now() });
  }
}

export const LOUD = Buffer.alloc(4800);
for (let i = 0; i < LOUD.length; i += 2) LOUD.writeInt16LE(i % 4 === 0 ? 4000 : -4000, i);
