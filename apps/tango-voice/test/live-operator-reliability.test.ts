import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulatedAgentBackend, STILL_RUNNING_TEXT, type AgentBackend, type AgentDescriptor, type AgentTaskRequest, type AgentUpdate } from '../src/live/agent-backend.js';
import type { ThreadDirectory, ThreadInfo } from '../src/live/discord-threads.js';
import type { LiveContextKind, LiveSessionClient } from '../src/live/gpt-live-client.js';
import { LivePlaybackClock, SpeechActivity } from '../src/live/live-audio.js';
import { LiveOperator, sceneConversation, type LateUpdate, type LiveOperatorOptions } from '../src/live/live-operator.js';
import { OperatorSessionOwner } from '../src/live/operator-session.js';
import { HttpScreenDirector, type ScreenDirector, type ScreenHandlers, type ScreenScene, type ScreenTask } from '../src/live/screen-director.js';
import type { ExtractorInput, OperatorAction, TaskExtractor } from '../src/live/task-extractor.js';
import { deskItem, FakeDesk } from './desk-fakes.js';

// Regressions for the 10/06 operator review (docs/specs/agent-desk.md, "Voice operator").
// Each test reproduces a failure seen in a real session or a review reproduction.

const AGENTS: AgentDescriptor[] = [
  { id: 'sierra', name: 'Sierra', role: 'research' },
  { id: 'foxtrot', name: 'Foxtrot', role: 'finance' },
  { id: 'juliet', name: 'Juliet', role: 'logistics' },
];

const LOUD = Buffer.alloc(4800);
for (let i = 0; i < LOUD.length; i += 2) LOUD.writeInt16LE(i % 4 === 0 ? 4000 : -4000, i);

class FakeClient extends EventEmitter {
  appends: Array<{ kind: LiveContextKind; content: string; delegationId: string | null }> = [];
  appendContext(kind: LiveContextKind, content: string, delegationId: string | null) {
    this.appends.push({ kind, content, delegationId });
    return Promise.resolve({ clientEventId: 'x' });
  }
  user(text: string) {
    this.emit('inputTranscript', { delta: text, startMs: Date.now(), endMs: Date.now() });
  }
  operator(text: string) {
    this.emit('outputTranscript', { delta: text, startMs: Date.now(), endMs: Date.now() });
  }
  delegate(id: string, prompt?: string) {
    this.emit('delegation', { id, offsetMs: 0, ...(prompt ? { prompt } : {}) });
  }
}

/** The desk with one Loom thread on it (synthetic). */
function loomDesk(): FakeDesk {
  return new FakeDesk([deskItem('loom:notify', 'loom', { place: 'notifications', nextStep: 'your_move', ask: 'Loom notifications thread' })]);
}

class FakeScreen implements ScreenDirector {
  handlers: ScreenHandlers | null = null;
  scenes: ScreenScene[] = [];
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
    return null;
  }
  staged(agentId?: string) {
    return this.scenes.filter((scene) => !agentId || scene.agentId === agentId);
  }
  async showAgent() {
    return null;
  }
  async showScene() {
    return null;
  }
  async showDashboard() {}
  async back() {
    return null;
  }
  async command() {
    return false;
  }
  setTasks(_tasks: ScreenTask[]) {}
}

class FakeThreads implements ThreadDirectory {
  fail: Error | null = null;
  hang = false;
  constructor(public threads: ThreadInfo[] = []) {}
  async list() {
    if (this.hang) return new Promise<ThreadInfo[]>(() => {});
    if (this.fail) throw this.fail;
    return this.threads;
  }
  async create(agentId: string, title: string): Promise<ThreadInfo> {
    return { id: '1500000000000000099', title, agentId, lastActiveAt: Date.now() };
  }
}

/** A backend whose turns finish when the test says so, so results can arrive out of order. */
class ManualBackend implements AgentBackend {
  sends: Array<{ request: AgentTaskRequest; onUpdate: (update: AgentUpdate) => void }> = [];
  send(request: AgentTaskRequest, onUpdate: (update: AgentUpdate) => void) {
    this.sends.push({ request, onUpdate });
  }
  finish(index: number, update: AgentUpdate) {
    this.sends[index].onUpdate(update);
  }
}

function setup(options: Partial<LiveOperatorOptions> & { extractor: TaskExtractor }) {
  const client = new FakeClient();
  const userActivity = new SpeechActivity();
  const playback = new LivePlaybackClock();
  const logs: Array<{ event: string; data?: Record<string, unknown> }> = [];
  const operator = new LiveOperator({
    client: client as unknown as LiveSessionClient,
    agents: AGENTS,
    backend: new SimulatedAgentBackend({}),
    userActivity,
    playback,
    floor: { settleMs: 1000, speakTimeoutMs: 5000 },
    transcriptSettleMs: 50,
    log: (event, data) => logs.push({ event, data }),
    ...options,
  });
  operator.start();
  return { client, operator, userActivity, playback, logs };
}

/** A router that answers from a script, after `ms`. */
function slowRouter(ms: number, script: OperatorAction[][], calls: ExtractorInput[] = []): TaskExtractor {
  return async (input) => {
    calls.push(input);
    await new Promise((resolve) => setTimeout(resolve, ms));
    return script.shift() ?? [{ type: 'none', reason: 'test' }];
  };
}

const commentary = (client: FakeClient) => client.appends.filter((append) => append.kind === 'commentary');

describe('operator reliability (10/06 review)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(90_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('1. serialized delegations', () => {
    it('one sentence delegated twice 100 ms apart runs the router once and posts once', async () => {
      const desk = loomDesk();
      const calls: ExtractorInput[] = [];
      const route: OperatorAction[] = [{ type: 'desk', op: 'reply', item: 'i1', message: 'Does the notification fire on mobile?' }];
      const { client } = setup({ extractor: slowRouter(3500, [route, route], calls), desk });
      client.user('Ask the Loom notifications thread whether it fires on mobile.');
      client.delegate('d1', 'Ask the Loom notifications thread whether it fires on mobile');
      await vi.advanceTimersByTimeAsync(100);
      client.delegate('d2', 'The user asks the Loom notifications thread whether it fires on mobile');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(calls).toHaveLength(1);
      expect(desk.sent('reply').map((command) => ({ id: command.itemId, text: command.args.text }))).toEqual([{ id: 'loom:notify', text: 'Does the notification fire on mobile?' }]);
    });

    it('a second delegation with new words still runs, once the first is done', async () => {
      const started: Array<{ speech: string; at: number }> = [];
      const extractor: TaskExtractor = async (input) => {
        started.push({ speech: input.latestUserSpeech, at: Date.now() });
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return [{ type: 'none', reason: 'test' }];
      };
      const { client } = setup({ extractor });
      client.user('Ask Sierra about the trip.');
      client.delegate('d1');
      await vi.advanceTimersByTimeAsync(100);
      client.user(' And tell Foxtrot to pay the bill.');
      client.delegate('d2');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(started.map((call) => call.speech)).toEqual(['Ask Sierra about the trip.', 'And tell Foxtrot to pay the bill.']);
      expect(started[1].at - started[0].at).toBeGreaterThanOrEqual(2000);
    });
  });

  describe('2. hand-off promises', () => {
    it("the operator's own relay of an agent result is not a promise", async () => {
      const backend = new SimulatedAgentBackend({ sierra: () => [{ kind: 'result', text: 'The mockup is added to the PR.', afterMs: 200 }] });
      const calls: ExtractorInput[] = [];
      const { client, playback } = setup({ backend, extractor: slowRouter(10, [[{ type: 'dispatch', agentId: 'sierra', message: 'Add the mockup' }]], calls), promiseTimeoutMs: 4000 });
      client.user('Have Sierra add the mockup.');
      client.delegate('d1');
      await vi.advanceTimersByTimeAsync(3000);
      expect(commentary(client).at(-1)?.content).toContain('mockup is added');
      // GPT-Live relays it, then the user backchannels: no synthetic delegation for "Mm".
      for (let i = 0; i < 10; i++) playback.enqueue(LOUD);
      client.operator('Sierra says the mockup is added to the PR.');
      await vi.advanceTimersByTimeAsync(2000);
      client.user('Mm.');
      await vi.advanceTimersByTimeAsync(8000);
      expect(calls).toHaveLength(1);
    });

    it('still acts on a real unkept promise', async () => {
      const calls: ExtractorInput[] = [];
      const { client } = setup({ extractor: slowRouter(10, [], calls), promiseTimeoutMs: 4000 });
      client.user('Ask Foxtrot about the transfer.');
      client.operator('Sending that to Foxtrot.');
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls).toHaveLength(1);
    });
  });

  describe('3. delivery is not held hostage by routing', () => {
    it('a ready answer goes out while a slow "Mm" is still being routed', async () => {
      const backend = new SimulatedAgentBackend({ foxtrot: () => [{ kind: 'result', text: 'Vehicle transfer is done.', afterMs: 3000 }] });
      let call = 0;
      // The first request routes quickly; "Mm" takes 6 s to come back as `none` (the 10/06 14:28 session).
      const extractor: TaskExtractor = async () => {
        call += 1;
        if (call === 1) return [{ type: 'dispatch', agentId: 'foxtrot', message: 'Do the transfer' }];
        await new Promise((resolve) => setTimeout(resolve, 6000));
        return [{ type: 'none', reason: 'backchannel' }];
      };
      const { client } = setup({ backend, extractor });
      client.user('Have Foxtrot do the transfer.');
      client.delegate('d1');
      await vi.advanceTimersByTimeAsync(2000);
      client.user(' Mm.');
      client.delegate('d2');
      await vi.advanceTimersByTimeAsync(3500);
      expect(call).toBe(2); // still routing "Mm"
      expect(commentary(client).some((append) => append.content.includes('Vehicle transfer is done'))).toBe(true);
    });
  });

  describe('4. session ownership', () => {
    it('a delegation in flight when the session stops takes no action afterwards', async () => {
      const backend = new SimulatedAgentBackend({ sierra: () => [] });
      const { client, operator } = setup({ backend, extractor: slowRouter(3000, [[{ type: 'dispatch', agentId: 'sierra', message: 'Pick the second one' }]]) });
      client.user('Tell Sierra the second one.');
      client.delegate('d1');
      await vi.advanceTimersByTimeAsync(500);
      operator.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(backend.sends).toEqual([]);
      expect(client.appends).toEqual([]);
    });

    it("an agent result that lands after stop() goes to the next session, not the old one's connection", async () => {
      const backend = new ManualBackend();
      const owner = new OperatorSessionOwner<{ operator: LiveOperator; live: { close(): Promise<unknown> }; closing: boolean }>();
      const first = setup({ backend, extractor: slowRouter(10, [[{ type: 'dispatch', agentId: 'sierra', message: 'Compare speakers' }]]), onLateUpdate: (late) => owner.deliverLate(late) });
      owner.install({ operator: first.operator, live: { close: async () => null }, closing: false });
      first.client.user('Ask Sierra to compare speakers.');
      first.client.delegate('d1');
      await vi.advanceTimersByTimeAsync(500);
      expect(backend.sends).toHaveLength(1);

      // The connection drops: the owner retires the brain, then a new one comes up.
      await owner.retire(owner.current);
      const second = setup({ backend, extractor: slowRouter(10, []), onLateUpdate: (late) => owner.deliverLate(late) });
      owner.install({ operator: second.operator, live: { close: async () => null }, closing: false });

      const beforeRetire = first.client.appends.length; // the routing confirmation, while it was live
      backend.finish(0, { kind: 'result', text: 'The Sony is the pick.' });
      await vi.advanceTimersByTimeAsync(3000);
      expect(first.client.appends).toHaveLength(beforeRetire);
      expect(commentary(first.client)).toEqual([]);
      expect(commentary(second.client).map((append) => append.content)).toEqual([expect.stringContaining('The Sony is the pick.')]);
      expect(commentary(second.client)[0].delegationId).toBeNull();
    });

    it('updates still queued when a session ends are relayed by the next one', async () => {
      const backend = new SimulatedAgentBackend({ juliet: () => [{ kind: 'result', text: 'Plumber is booked for Thursday.', afterMs: 100 }] });
      const handed: LateUpdate[] = [];
      const { client, operator, userActivity } = setup({ backend, extractor: slowRouter(10, [[{ type: 'dispatch', agentId: 'juliet', message: 'Book the plumber' }]]), onLateUpdate: (late) => handed.push(late) });
      client.user('Book the plumber.');
      client.delegate('d1');
      await vi.advanceTimersByTimeAsync(200);
      userActivity.observe(LOUD, Date.now()); // the user keeps talking, so it stays queued
      await vi.advanceTimersByTimeAsync(300);
      expect(operator.pendingUpdates).toBe(1);
      operator.stop();
      expect(handed.map((late) => late.update.text)).toEqual(['Plumber is booked for Thursday.']);
      const next = setup({ extractor: slowRouter(10, []) });
      next.operator.adoptLateUpdate(handed[0]);
      await vi.advanceTimersByTimeAsync(2500);
      expect(commentary(next.client).at(-1)?.content).toContain('Plumber is booked');
    });

    it('the owner refuses a second live brain and ends cleanly', async () => {
      const closed: string[] = [];
      const brain = (name: string) => ({ operator: { stop: vi.fn(), adoptLateUpdate: vi.fn() }, live: { close: async () => closed.push(name) }, closing: false });
      const owner = new OperatorSessionOwner<ReturnType<typeof brain>>();
      const a = brain('a');
      const b = brain('b');
      expect(owner.install(a)).toBe(true);
      expect(owner.install(b)).toBe(false);
      await Promise.resolve();
      expect(b.operator.stop).toHaveBeenCalled();
      expect(closed).toEqual(['b']);
      const late: LateUpdate = { kind: 'result', agent: AGENTS[0], update: { kind: 'result', text: 'x' } };
      owner.deliverLate(late);
      expect(a.operator.adoptLateUpdate).toHaveBeenCalledWith(late);
      await owner.end();
      expect(a.operator.stop).toHaveBeenCalled();
      expect(closed).toEqual(['b', 'a']);
      expect(owner.install(brain('c'))).toBe(false);
    });

    it("the shared screen director routes taps to the newest session, and an old session's stop doesn't cut it off", async () => {
      vi.useRealTimers();
      let push: ((chunk: string) => void) | null = null;
      const encoder = new TextEncoder();
      const aborts: AbortSignal[] = [];
      vi.stubGlobal('fetch', async (url: string, init?: { signal?: AbortSignal }) => {
        if (String(url).includes('/director/stream')) {
          if (init?.signal) aborts.push(init.signal);
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              push = (chunk) => controller.enqueue(encoder.encode(chunk));
              init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
            },
          });
          return new Response(body, { status: 200 });
        }
        return new Response(JSON.stringify({ screens: [], operatorLive: true, showing: null, stages: [], items: [] }), { status: 200 });
      });
      const director = new HttpScreenDirector('http://screen.test');
      const taps: string[] = [];
      const handlers = (name: string): ScreenHandlers => ({
        onStaged: () => {},
        onInput: () => {
          taps.push(name);
        },
      });
      const oldSession = handlers('old');
      const newSession = handlers('new');
      director.connect(oldSession);
      director.connect(newSession);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const tap = `event: input\ndata: ${JSON.stringify({ scene: { id: 's1', agentId: 'sierra', choices: [] }, type: 'choice', data: {} })}\n\n`;
      push!(tap);
      await new Promise((resolve) => setTimeout(resolve, 20));
      director.disconnect(oldSession); // the old brain retiring late
      push!(tap);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(taps).toEqual(['new', 'new']);
      expect(aborts.every((signal) => !signal.aborted)).toBe(true);
      director.disconnect(newSession);
      expect(aborts.some((signal) => signal.aborted)).toBe(true);
    });
  });

  describe('5. a result belongs to its own request', () => {
    it('an earlier turn finishing after a reply does not complete the newer request', async () => {
      const backend = new ManualBackend();
      const { client, operator } = setup({
        backend,
        policy: 'immediate',
        extractor: slowRouter(10, [[{ type: 'dispatch', agentId: 'juliet', message: 'Book the dentist' }], [{ type: 'reply', taskId: 't1', message: 'Actually make it Wednesday' }]]),
      });
      client.user('Book the dentist.');
      client.delegate('d1');
      await vi.advanceTimersByTimeAsync(500);
      client.user(' Actually make it Wednesday.');
      client.delegate('d2');
      await vi.advanceTimersByTimeAsync(500);
      expect(backend.sends.map((send) => send.request.turn)).toEqual([0, 1]);

      backend.finish(0, { kind: 'result', text: 'Booked Tuesday at 9.' });
      await vi.advanceTimersByTimeAsync(100);
      expect(operator.tasks[0].status).toBe('running');
      expect(commentary(client).at(-1)).toMatchObject({ delegationId: 'd1', content: expect.stringContaining('Booked Tuesday') });

      backend.finish(1, { kind: 'result', text: 'Moved it to Wednesday at 9.' });
      await vi.advanceTimersByTimeAsync(100);
      expect(operator.tasks[0].status).toBe('done');
      expect(operator.tasks[0].lastUpdate).toBe('Moved it to Wednesday at 9.');
      expect(commentary(client).at(-1)).toMatchObject({ delegationId: 'd2', content: expect.stringContaining('Wednesday at 9') });
    });
  });

  describe("6. taps follow the scene's conversation", () => {
    function tapSetup() {
      const screen = new FakeScreen();
      const backend = new ManualBackend();
      const threads = new FakeThreads([
        { id: '1110000000000000000', title: 'Speakers', agentId: 'sierra', lastActiveAt: Date.now() },
        { id: '2220000000000000000', title: 'Pinecrest trip', agentId: 'sierra', lastActiveAt: Date.now() },
      ]);
      const { client } = setup({
        backend,
        screen,
        threads,
        extractor: slowRouter(10, [
          [{ type: 'dispatch', agentId: 'sierra', message: 'Compare speakers', threadId: '1110000000000000000' }],
          [{ type: 'dispatch', agentId: 'sierra', message: 'Plan Pinecrest', threadId: '2220000000000000000' }],
        ]),
      });
      return { screen, backend, client };
    }
    const sceneIn = (threadId: string | null, extra: Partial<ScreenScene> = {}): ScreenScene => ({
      id: 'sc1', agentId: 'sierra', agentName: 'Sierra', slot: 'main', kind: 'html', title: 'Speaker picks', summary: 'Three speakers',
      choices: [{ id: 'b', label: 'Pioneer' }], urgent: false, version: 1, updatedAt: Date.now(), threadId, channelId: null, ...extra,
    });

    it("a tap on thread A's scene answers thread A's task, not the agent's newer task in thread B", async () => {
      const { screen, backend, client } = tapSetup();
      client.user('Compare speakers.');
      client.delegate('d1');
      await vi.advanceTimersByTimeAsync(300);
      client.user(' Plan Pinecrest.');
      client.delegate('d2');
      await vi.advanceTimersByTimeAsync(300);
      screen.handlers!.onInput(sceneIn('1110000000000000000'), 'choice', { choiceId: 'b' });
      await vi.advanceTimersByTimeAsync(300);
      expect(backend.sends.at(-1)!.request).toMatchObject({ taskId: 't1', turn: 1, channelId: '1110000000000000000' });
      expect(backend.sends.at(-1)!.request.message).toContain('Pioneer');
    });

    it("with no task in the scene's thread, the tap starts one there", async () => {
      const { screen, backend } = tapSetup();
      screen.handlers!.onInput(sceneIn(null, { conversationKey: 'thread:3330000000000000000' }), 'choice', { choiceId: 'b' });
      await vi.advanceTimersByTimeAsync(300);
      expect(backend.sends.at(-1)!.request).toMatchObject({ agentId: 'sierra', channelId: '3330000000000000000' });
    });

    it('a scene with no origin keeps the old behavior (the agent\'s latest task)', async () => {
      const { screen, backend, client } = tapSetup();
      client.user('Compare speakers.');
      client.delegate('d1');
      await vi.advanceTimersByTimeAsync(300);
      client.user(' Plan Pinecrest.');
      client.delegate('d2');
      await vi.advanceTimersByTimeAsync(300);
      screen.handlers!.onInput(sceneIn(null), 'choice', { choiceId: 'b' });
      await vi.advanceTimersByTimeAsync(300);
      expect(backend.sends.at(-1)!.request).toMatchObject({ taskId: 't2', channelId: '2220000000000000000' });
    });

    it('reads the conversation from origin fields or the key', () => {
      expect(sceneConversation({ threadId: '1', channelId: '9' })).toEqual({ threadId: '1', channelId: '9' });
      expect(sceneConversation({ conversationKey: 'channel:9' })).toEqual({ threadId: null, channelId: '9' });
      expect(sceneConversation({})).toBeNull();
    });
  });

  describe('7. bounded calls', () => {
    it('a hung router fails that request and frees the next one', async () => {
      let call = 0;
      const extractor: TaskExtractor = async () => {
        call += 1;
        if (call === 1) return new Promise<OperatorAction[]>(() => {});
        return [{ type: 'status' }];
      };
      const { client } = setup({ extractor, timeouts: { extractorMs: 5000 } });
      client.user('Ask Sierra something.');
      client.delegate('d1');
      await vi.advanceTimersByTimeAsync(300);
      client.user(' What is pending?');
      client.delegate('d2');
      await vi.advanceTimersByTimeAsync(7000);
      expect(client.appends.some((append) => append.content.includes("routing it failed"))).toBe(true);
      expect(call).toBe(2);
      expect(commentary(client).at(-1)?.content).toContain('Nothing is pending');
    });

    it('a hung thread list does not stall routing', async () => {
      const threads = new FakeThreads();
      threads.hang = true;
      const calls: ExtractorInput[] = [];
      const { client } = setup({ extractor: slowRouter(10, [], calls), threads, timeouts: { threadsMs: 2000 } });
      client.user('Hello.');
      client.delegate('d1');
      await vi.advanceTimersByTimeAsync(3000);
      expect(calls).toHaveLength(1);
      expect(calls[0].threads).toEqual([]);
    });

    it('a hung desk reply is reported as not sent', async () => {
      const desk = loomDesk();
      desk.respond = () => new Promise(() => {});
      const { client } = setup({ desk, extractor: slowRouter(10, [[{ type: 'desk', op: 'reply', item: 'i1', message: 'Ship it.' }]]), timeouts: { replyMs: 3000 } });
      client.user('Tell the Loom thread to ship it.');
      client.delegate('d1');
      await vi.advanceTimersByTimeAsync(5000);
      expect(commentary(client).at(-1)?.content).toContain("didn't reach");
    });
  });

  describe('8. thread lookup failure', () => {
    it('a failed lookup of an explicit thread is reported, never sent to the main channel', async () => {
      const threads = new FakeThreads();
      threads.fail = new Error('Discord threads HTTP 503');
      const backend = new ManualBackend();
      const { client } = setup({ backend, threads, extractor: slowRouter(10, [[{ type: 'dispatch', agentId: 'foxtrot', message: 'Yes, approve that', threadId: '1550000000000000009' }]]) });
      client.user('Yes, approve that.');
      client.delegate('d1');
      await vi.advanceTimersByTimeAsync(1000);
      expect(backend.sends).toEqual([]);
      const said = commentary(client).at(-1)!.content;
      expect(said).toContain('Nothing was sent');
      expect(said).toContain('503');
    });

    it('a thread the desk knows still works when the list is down', async () => {
      const threads = new FakeThreads();
      threads.fail = new Error('Discord threads HTTP 503');
      const desk = new FakeDesk([deskItem('discord:thread:1550000000000000009', 'foxtrot', { threadId: '1550000000000000009', place: 'Transfers' })]);
      const backend = new ManualBackend();
      const { client } = setup({ backend, threads, desk, extractor: slowRouter(10, [[{ type: 'dispatch', agentId: 'foxtrot', message: 'Approve it', threadId: '1550000000000000009' }]]) });
      client.user('Approve it.');
      client.delegate('d1');
      await vi.advanceTimersByTimeAsync(1000);
      expect(backend.sends[0].request.channelId).toBe('1550000000000000009');
    });
  });

  describe('9. delivered means heard', () => {
    it('matching words are not delivery while the audio is still playing', async () => {
      const backend = new SimulatedAgentBackend({ sierra: () => [{ kind: 'result', text: 'The Pioneer has wireless Bluetooth and fits the dash.' }] });
      const { client, operator, playback } = setup({ backend, extractor: slowRouter(10, [[{ type: 'dispatch', agentId: 'sierra', message: 'speaker' }]]) });
      client.user('Which speaker?');
      client.delegate('d1');
      await vi.advanceTimersByTimeAsync(2500);
      expect(commentary(client)).toHaveLength(1);
      for (let i = 0; i < 40; i++) playback.enqueue(LOUD); // four seconds of speech queued
      client.operator('Sierra says the Pioneer has wireless Bluetooth and fits the dash.');
      await vi.advanceTimersByTimeAsync(1000);
      expect(operator.pendingUpdates).toBe(1);
      await vi.advanceTimersByTimeAsync(3600);
      expect(operator.pendingUpdates).toBe(0);
    });

    it('an update interrupted halfway is not heard and is re-queued', async () => {
      const backend = new SimulatedAgentBackend({ sierra: () => [{ kind: 'result', text: 'The Pioneer has wireless Bluetooth and fits the dash.' }] });
      const { client, playback, userActivity, logs } = setup({ backend, extractor: slowRouter(10, [[{ type: 'dispatch', agentId: 'sierra', message: 'speaker' }]]) });
      client.user('Which speaker?');
      client.delegate('d1');
      await vi.advanceTimersByTimeAsync(2500);
      for (let i = 0; i < 20; i++) playback.enqueue(LOUD);
      client.operator('Sierra says the Pioneer has wireless Bluetooth and fits the dash.');
      for (let i = 0; i < 8; i++) {
        userActivity.observe(LOUD, Date.now()); // the user talks over it
        if (i === 1) client.user('hold on, which dash kit');
        await vi.advanceTimersByTimeAsync(100);
      }
      await vi.advanceTimersByTimeAsync(4000);
      expect(logs.some((entry) => entry.event === 'delivered')).toBe(false);
      expect(logs.some((entry) => entry.event === 'delivery.retry')).toBe(true);
    });

    it('an interruption whose transcript lands after playback stopped still counts as cut off (Codex review, #387)', async () => {
      const backend = new SimulatedAgentBackend({ sierra: () => [{ kind: 'result', text: 'The Pioneer has wireless Bluetooth and fits the dash.' }] });
      const { client, playback, userActivity, logs } = setup({ backend, extractor: slowRouter(10, [[{ type: 'dispatch', agentId: 'sierra', message: 'speaker' }]]) });
      client.user('Which speaker?');
      client.delegate('d1');
      await vi.advanceTimersByTimeAsync(2500);
      for (let i = 0; i < 20; i++) playback.enqueue(LOUD);
      client.operator('Sierra says the Pioneer has wireless Bluetooth and fits the dash.');
      for (let i = 0; i < 8; i++) {
        userActivity.observe(LOUD, Date.now()); // the owner talks over it; the words come later
        await vi.advanceTimersByTimeAsync(100);
      }
      await vi.advanceTimersByTimeAsync(1500); // playback has stopped
      client.user('hold on, which dash kit is that');
      await vi.advanceTimersByTimeAsync(4000);
      expect(logs.some((entry) => entry.event === 'delivered')).toBe(false);
      expect(logs.some((entry) => entry.event === 'delivery.retry')).toBe(true);
    });

    it('a long interruption that continues past playback still counts once its words arrive (Codex review, #387)', async () => {
      const backend = new SimulatedAgentBackend({ sierra: () => [{ kind: 'result', text: 'The Pioneer has wireless Bluetooth and fits the dash.' }] });
      const { client, playback, userActivity, logs } = setup({ backend, extractor: slowRouter(10, [[{ type: 'dispatch', agentId: 'sierra', message: 'speaker' }]]) });
      client.user('Which speaker?');
      client.delegate('d1');
      await vi.advanceTimersByTimeAsync(2500);
      for (let i = 0; i < 20; i++) playback.enqueue(LOUD);
      client.operator('Sierra says the Pioneer has wireless Bluetooth and fits the dash.');
      for (let i = 0; i < 60; i++) {
        userActivity.observe(LOUD, Date.now()); // talks over it and keeps going ~4 s past playback
        await vi.advanceTimersByTimeAsync(100);
      }
      client.user('no wait, I meant the one for the truck, not the car');
      await vi.advanceTimersByTimeAsync(4000);
      expect(logs.some((entry) => entry.event === 'delivered')).toBe(false);
      expect(logs.some((entry) => entry.event === 'delivery.retry')).toBe(true);
    });

    it('a normal answer after a pause does not turn earlier noise into a cut-in (Codex review, #387)', async () => {
      const backend = new SimulatedAgentBackend({ sierra: () => [{ kind: 'result', text: 'The Pioneer has wireless Bluetooth and fits the dash.' }] });
      const { client, playback, userActivity, logs } = setup({ backend, extractor: slowRouter(10, [[{ type: 'dispatch', agentId: 'sierra', message: 'speaker' }], [{ type: 'none', reason: 'thanks' }]]) });
      client.user('Which speaker?');
      client.delegate('d1');
      await vi.advanceTimersByTimeAsync(2500);
      for (let i = 0; i < 20; i++) playback.enqueue(LOUD);
      client.operator('Sierra says the Pioneer has wireless Bluetooth and fits the dash.');
      for (let i = 0; i < 4; i++) {
        userActivity.observe(LOUD, Date.now()); // room noise during playback, no words
        await vi.advanceTimersByTimeAsync(100);
      }
      // Playback (2 s from the start) ends ~1.6 s from here; the answer starts ~800 ms after the
      // operator's last audio — inside the 400 ms 'still speaking' hold plus grace (Codex review, #387).
      await vi.advanceTimersByTimeAsync(2400);
      for (let i = 0; i < 6; i++) {
        userActivity.observe(LOUD, Date.now()); // a new utterance
        await vi.advanceTimersByTimeAsync(100);
      }
      client.user('sounds good, thanks so much');
      await vi.advanceTimersByTimeAsync(4000);
      expect(logs.some((entry) => entry.event === 'delivery.retry')).toBe(false);
    });

    for (const [name, said] of [['voice activity with no words (echo, room noise)', null], ['a backchannel ("mm, yeah")', 'mm yeah']] as const) {
      it(`${name} during playback is not talking over it: no repeat (live test 10/06)`, async () => {
        const backend = new SimulatedAgentBackend({ sierra: () => [{ kind: 'result', text: 'The Pioneer has wireless Bluetooth and fits the dash.' }] });
        const { client, playback, userActivity, logs } = setup({ backend, extractor: slowRouter(10, [[{ type: 'dispatch', agentId: 'sierra', message: 'speaker' }]]) });
        client.user('Which speaker?');
        client.delegate('d1');
        await vi.advanceTimersByTimeAsync(2500);
        for (let i = 0; i < 20; i++) playback.enqueue(LOUD);
        client.operator('Sierra says the Pioneer has wireless Bluetooth and fits the dash.');
        for (let i = 0; i < 8; i++) {
          userActivity.observe(LOUD, Date.now());
          if (i === 1 && said) client.user(said);
          await vi.advanceTimersByTimeAsync(100);
        }
        await vi.advanceTimersByTimeAsync(8000);
        expect(logs.some((entry) => entry.event === 'delivery.retry')).toBe(false);
        expect(logs.some((entry) => entry.event === 'delivered')).toBe(true);
      });
    }
  });

  describe('10. late answers', () => {
    it('an answer posted after the backend stopped waiting is relayed (from the desk), not marked heard and dropped', async () => {
      const desk = new FakeDesk([deskItem('discord:thread:1560000000000000002', 'foxtrot', { threadId: '1560000000000000002', place: 'Walmart cart', nextStep: 'working' })]);
      const threads = new FakeThreads([{ id: '1560000000000000002', title: 'Walmart cart', agentId: 'foxtrot', lastActiveAt: Date.now() }]);
      const backend = new ManualBackend();
      const { client } = setup({
        backend,
        desk,
        threads,
        extractor: slowRouter(10, [[{ type: 'dispatch', agentId: 'foxtrot', message: 'Add pork butt to the cart', threadId: '1560000000000000002' }]]),
      });
      client.user('Add a pork butt roast to my Walmart cart.');
      client.delegate('d1');
      await vi.advanceTimersByTimeAsync(500);
      backend.finish(0, { kind: 'result', text: STILL_RUNNING_TEXT });
      await vi.advanceTimersByTimeAsync(3000);
      // 40 s later the agent's answer posts; the desk sees it.
      await vi.advanceTimersByTimeAsync(40_000);
      desk.agentPosts('discord:thread:1560000000000000002', 'Added a 7 lb bone-in pork butt to the cart.', { nextStep: 'fyi' });
      await vi.advanceTimersByTimeAsync(20_000);
      const late = commentary(client).find((append) => append.content.includes('7 lb bone-in pork butt'));
      expect(late?.content).toContain('finished what was still running');
      expect(desk.sent('heard')).toEqual([]); // heard only once it is actually spoken
    });

    it('condenses a long late answer against the question that was asked', async () => {
      const desk = new FakeDesk([deskItem('discord:thread:1560000000000000002', 'foxtrot', { threadId: '1560000000000000002', place: 'Walmart cart', nextStep: 'working' })]);
      const threads = new FakeThreads([{ id: '1560000000000000002', title: 'Walmart cart', agentId: 'foxtrot', lastActiveAt: Date.now() }]);
      const backend = new ManualBackend();
      const questions: Array<string | undefined> = [];
      const { client } = setup({
        backend,
        desk,
        threads,
        summarize: async (_agentId, _text, question) => {
          questions.push(question);
          return 'Added the roast; the cart total is $84.';
        },
        extractor: slowRouter(10, [[{ type: 'dispatch', agentId: 'foxtrot', message: 'Add pork butt to the cart. What is the total now?', threadId: '1560000000000000002' }]]),
      });
      client.user('Add a pork butt roast to my Walmart cart and tell me the total.');
      client.delegate('d1');
      await vi.advanceTimersByTimeAsync(500);
      backend.finish(0, { kind: 'result', text: STILL_RUNNING_TEXT });
      await vi.advanceTimersByTimeAsync(43_000);
      desk.agentPosts('discord:thread:1560000000000000002', `Added a 7 lb bone-in pork butt. ${'Details. '.repeat(80)}Total is $84.`, { nextStep: 'fyi' });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(questions).toEqual(['Add pork butt to the cart. What is the total now?']);
      // The interim "still running" notice is not treated as the answer.
      const interim = commentary(client).find((append) => append.content.includes(STILL_RUNNING_TEXT));
      expect(interim?.content).not.toContain('The user asked');
      const late = commentary(client).find((append) => append.content.includes('the cart total is $84'));
      expect(late?.content).toContain('The user asked: "Add pork butt to the cart. What is the total now?"');
    });

    it("watches the agent's home channel when the request had no thread", async () => {
      const desk = new FakeDesk([deskItem('discord:chapter:home-foxtrot:1', 'foxtrot', { nextStep: 'working' })]);
      const backend = new ManualBackend();
      const { client, operator } = setup({
        backend,
        desk,
        homeChannelFor: (agentId) => (agentId === 'foxtrot' ? 'home-foxtrot' : undefined),
        extractor: slowRouter(10, [[{ type: 'dispatch', agentId: 'foxtrot', message: 'Reconcile the card' }]]),
      });
      client.user('Have Foxtrot reconcile the card.');
      client.delegate('d1');
      await vi.advanceTimersByTimeAsync(500);
      backend.finish(0, { kind: 'result', text: STILL_RUNNING_TEXT });
      await vi.advanceTimersByTimeAsync(3000);
      expect(operator.isIdle()).toBe(false); // an answer is still expected
      desk.agentPosts('discord:chapter:home-foxtrot:1', 'Card reconciled: two charges need review.', { nextStep: 'your_move' });
      // Behind the unspoken "still running" notice, which waits out its delivery retries first.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(commentary(client).some((append) => append.content.includes('two charges need review'))).toBe(true);
    });
  });
});
