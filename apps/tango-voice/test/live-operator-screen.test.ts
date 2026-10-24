import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulatedAgentBackend, type AgentDescriptor } from '../src/live/agent-backend.js';
import type { LiveContextKind, LiveSessionClient } from '../src/live/gpt-live-client.js';
import { LivePlaybackClock, SpeechActivity } from '../src/live/live-audio.js';
import { LiveOperator, type LiveOperatorOptions } from '../src/live/live-operator.js';
import { readSse, type ScreenDirector, type ScreenHandlers, type ScreenScene, type ScreenTask } from '../src/live/screen-director.js';
import { buildExtractorPrompt, parseExtractorOutput, resolvePointedChoice, type OperatorAction, type TaskExtractor } from '../src/live/task-extractor.js';

const AGENTS: AgentDescriptor[] = [
  { id: 'sierra', name: 'Sierra', role: 'research' },
  { id: 'malibu', name: 'Malibu', role: 'wellness' },
];

class FakeClient extends EventEmitter {
  appends: Array<{ kind: LiveContextKind; content: string; delegationId: string | null }> = [];
  appendContext(kind: LiveContextKind, content: string, delegationId: string | null) {
    this.appends.push({ kind, content, delegationId });
    return Promise.resolve({ clientEventId: 'x' });
  }
  ask(id: string, words = `request ${id}`) {
    this.emit('inputTranscript', { delta: ` ${words}`, startMs: 0, endMs: 0 });
    this.emit('delegation', { id, offsetMs: 0 });
  }
}

function scene(agentId: string, overrides: Partial<ScreenScene> = {}): ScreenScene {
  return {
    id: `${agentId}-1`,
    agentId,
    agentName: agentId.charAt(0).toUpperCase() + agentId.slice(1),
    slot: 'main',
    kind: 'html',
    title: '',
    summary: `${agentId} scene`,
    choices: [],
    urgent: false,
    version: 1,
    updatedAt: 1,
    ...overrides,
  };
}

class FakeScreen implements ScreenDirector {
  handlers: ScreenHandlers | null = null;
  scenes: ScreenScene[] = [];
  current: ScreenScene | null = null;
  shows: string[] = [];
  commands: string[] = [];
  tasks: ScreenTask[] = [];
  connect(handlers: ScreenHandlers) {
    this.handlers = handlers;
  }
  disconnect() {
    this.handlers = null;
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
  async showAgent(agentId: string) {
    const found = this.staged(agentId)[0] ?? null;
    if (found) {
      this.current = found;
      this.shows.push(found.id);
    }
    return found;
  }
  reasons: string[] = [];
  async showScene(sceneId: string, reason?: string) {
    const found = this.scenes.find((candidate) => candidate.id === sceneId) ?? null;
    if (found) {
      this.current = found;
      this.shows.push(found.id);
      if (reason) this.reasons.push(reason);
    }
    return found;
  }
  async showDashboard() {
    this.current = null;
    this.shows.push('dashboard');
  }
  async back() {
    return null;
  }
  async command(name: string) {
    this.commands.push(name);
    return this.current !== null;
  }
  setTasks(tasks: ScreenTask[]) {
    this.tasks = tasks;
  }
  stage(input: ScreenScene) {
    const next = { ...input, updatedAt: Date.now() };
    const replaced = this.scenes.some((candidate) => candidate.id === next.id);
    this.scenes = [next, ...this.scenes.filter((candidate) => candidate.id !== next.id)];
    const showing = this.current?.id === next.id;
    if (showing) this.current = next; // refreshed in place, like the service
    this.handlers?.onStaged(next, { replaced, showing });
  }
}

function setup(actions: OperatorAction[][], backend: SimulatedAgentBackend, screen = new FakeScreen(), extra: Partial<LiveOperatorOptions> = {}) {
  const client = new FakeClient();
  const extractor: TaskExtractor = async () => actions.shift() ?? [{ type: 'none', reason: 'test' }];
  const operator = new LiveOperator({
    client: client as unknown as LiveSessionClient,
    agents: AGENTS,
    backend,
    extractor,
    userActivity: new SpeechActivity(),
    playback: new LivePlaybackClock(),
    floor: { settleMs: 1000, speakTimeoutMs: 5000 },
    transcriptSettleMs: 50,
    screen,
    ...extra,
  });
  operator.start();
  return { client, operator, screen };
}

const commentary = (client: FakeClient) => client.appends.filter((a) => a.kind === 'commentary').map((a) => a.content);

describe('operator as screen director', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(80_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it("shows the agent's staged scene when its result is relayed, and says so", async () => {
    const screen = new FakeScreen();
    const backend = new SimulatedAgentBackend({
      sierra: () => {
        screen.stage(scene('sierra', { title: 'Speaker shortlist', summary: 'Top three speakers' }));
        return [{ kind: 'result', text: 'The Sony is my pick.', afterMs: 500 }];
      },
    });
    const { client } = setup([[{ type: 'dispatch', agentId: 'sierra', message: 'find speakers' }]], backend, screen);
    client.ask('d1');
    await vi.advanceTimersByTimeAsync(3000);
    expect(screen.current?.id).toBe('sierra-1');
    expect(commentary(client).at(-1)).toContain('"Speaker shortlist" is on the screen too; say so in a few words, but still speak what it says about the user\'s question');
  });

  it('holds scenes from agents the conversation is not about', async () => {
    const backend = new SimulatedAgentBackend({ sierra: () => [{ kind: 'result', text: 'Working.', afterMs: 100 }] });
    const { client, screen } = setup([[{ type: 'dispatch', agentId: 'sierra', message: 'find speakers' }]], backend);
    client.ask('d1');
    await vi.advanceTimersByTimeAsync(500);
    screen.stage(scene('malibu'));
    await vi.advanceTimersByTimeAsync(100);
    expect(screen.shows).not.toContain('malibu-1');
  });

  it('shows a scene from the agent in focus as soon as it is staged', async () => {
    const backend = new SimulatedAgentBackend({ malibu: () => [{ kind: 'result', text: 'Logged.', afterMs: 5000 }] });
    const { client, screen } = setup([[{ type: 'dispatch', agentId: 'malibu', message: 'log lunch' }]], backend);
    client.ask('d1');
    await vi.advanceTimersByTimeAsync(500);
    screen.stage(scene('malibu'));
    await vi.advanceTimersByTimeAsync(100);
    expect(screen.shows).toContain('malibu-1');
  });

  it("a new scene answering the owner's request replaces a screen they picked earlier (live test 10/06)", async () => {
    const backend = new SimulatedAgentBackend({ malibu: () => [{ kind: 'result', text: 'Updated.', afterMs: 5000 }] });
    const { client, screen } = setup([[{ type: 'dispatch', agentId: 'malibu', message: 'adjust reps' }]], backend);
    screen.stage(scene('malibu', { id: 'malibu-old' }));
    await screen.showScene('malibu-old'); // the owner asked to see it earlier
    vi.advanceTimersByTime(1000);
    client.ask('d1');
    await vi.advanceTimersByTimeAsync(500);
    screen.stage(scene('malibu', { id: 'malibu-new' }));
    await vi.advanceTimersByTimeAsync(100);
    expect(screen.current?.id).toBe('malibu-new');
    expect(screen.reasons.at(-1)).toBe('user');
  });

  it("leaves another agent's urgent scene on its stage by default: a session starts clear (TGO-1050)", async () => {
    const { screen, client } = setup([], new SimulatedAgentBackend({}));
    screen.stage(scene('sierra', { urgent: true, summary: 'Your order needs approval' }));
    await vi.advanceTimersByTimeAsync(4000);
    expect(commentary(client).join('\n')).not.toContain('Your order needs approval');
  });

  it('announces an urgent scene from another agent with scene in the urgent lane', async () => {
    const { screen, client } = setup([], new SimulatedAgentBackend({}), new FakeScreen(), { urgentLane: ['scene'] });
    screen.stage(scene('sierra', { urgent: true, summary: 'Your order needs approval' }));
    await vi.advanceTimersByTimeAsync(4000);
    expect(commentary(client).join('\n')).toContain('Your order needs approval');
    expect(screen.current?.id).toBe('sierra-1');
  });

  it("sends a tap to the agent's task as the user's reply", async () => {
    const backend = new SimulatedAgentBackend({ sierra: () => [{ kind: 'question', text: 'Which one?', afterMs: 100 }] });
    const { client, screen } = setup([[{ type: 'dispatch', agentId: 'sierra', message: 'find speakers' }]], backend);
    client.ask('d1');
    await vi.advanceTimersByTimeAsync(500);
    const shortlist = scene('sierra', { title: 'Speaker shortlist', choices: [{ id: 'a', label: 'Sony' }, { id: 'b', label: 'Pioneer' }] });
    screen.handlers!.onInput(shortlist, 'choice', { choiceId: 'b' });
    await vi.advanceTimersByTimeAsync(100);
    expect(backend.sends.at(-1)?.request).toMatchObject({ taskId: 't1', turn: 1, message: 'On the screen, the user picked "Pioneer" on "Speaker shortlist".' });
    expect(commentary(client)).toContainEqual(expect.stringContaining('tapped "Pioneer"'));
  });

  it('runs voice screen commands', async () => {
    const screen = new FakeScreen();
    screen.scenes = [scene('malibu')];
    const { client } = setup(
      [[{ type: 'screen', op: 'show', agentId: 'malibu' }], [{ type: 'screen', op: 'next' }], [{ type: 'screen', op: 'board' }]],
      new SimulatedAgentBackend({}),
      screen,
    );
    client.ask('d1', "show me Malibu's macros");
    await vi.advanceTimersByTimeAsync(2500);
    client.ask('d2', 'next step');
    await vi.advanceTimersByTimeAsync(2500);
    client.ask('d3', 'clear the screen');
    await vi.advanceTimersByTimeAsync(2500);
    expect(screen.shows).toEqual(['malibu-1', 'dashboard']);
    expect(screen.commands).toEqual(['next']);
  });

  it('says so when an agent has nothing to show', async () => {
    const { client } = setup([[{ type: 'screen', op: 'show', agentId: 'sierra' }]], new SimulatedAgentBackend({}));
    client.ask('d1', "show me Sierra's list");
    await vi.advanceTimersByTimeAsync(2500);
    expect(commentary(client).at(-1)).toContain('Sierra has nothing on the screen yet');
  });

  it('feeds the dashboard with the task list', async () => {
    const backend = new SimulatedAgentBackend({ sierra: () => [{ kind: 'result', text: 'Done.', afterMs: 100 }] });
    const { client, screen } = setup([[{ type: 'dispatch', agentId: 'sierra', message: 'find speakers' }]], backend);
    client.ask('d1');
    await vi.advanceTimersByTimeAsync(400);
    expect(screen.tasks).toEqual([expect.objectContaining({ agentId: 'sierra', request: 'find speakers' })]);
  });
});

describe('extractor screen context', () => {
  it('lists what is showing and staged, with choices in order', () => {
    const prompt = buildExtractorPrompt({
      agents: AGENTS,
      tasks: [],
      transcript: [],
      latestUserSpeech: 'the middle one',
      screen: {
        showing: { agentName: 'Sierra', title: 'Speaker shortlist', summary: 'Top three', choices: ['Sony', 'Pioneer', 'Brand K'] },
        staged: [{ agentName: 'Malibu', title: '', summary: 'Macros today', choices: [] }],
      },
    });
    expect(prompt).toContain('choices in order: 1. Sony; 2. Pioneer; 3. Brand K');
    expect(prompt).toContain('- Malibu: "Macros today"');
    expect(prompt).toContain('screen_op show');
  });

  it('leaves screen guidance out when no screen is connected', () => {
    const prompt = buildExtractorPrompt({ agents: AGENTS, tasks: [], transcript: [], latestUserSpeech: 'hi' });
    expect(prompt).not.toContain('screen_op');
  });

  it('parses screen actions', () => {
    const raw = JSON.stringify({
      actions: [
        { type: 'screen', screen_op: 'show', agent_id: 'malibu', task_id: '', message: '', thread_id: '', new_thread_title: '', emoji: '' },
        { type: 'screen', screen_op: 'scroll_down', agent_id: '', task_id: '', message: '', thread_id: '', new_thread_title: '', emoji: '' },
        { type: 'screen', screen_op: 'bogus', agent_id: '', task_id: '', message: '', thread_id: '', new_thread_title: '', emoji: '' },
      ],
    });
    expect(parseExtractorOutput(raw)).toEqual([
      { type: 'screen', op: 'show', agentId: 'malibu' },
      { type: 'screen', op: 'scroll_down' },
      { type: 'none', reason: 'unknown screen op "bogus"' },
    ]);
  });
});

describe('readSse', () => {
  it('splits events across chunk boundaries', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: staged\ndata: {"a"'));
        controller.enqueue(encoder.encode(':1}\n\nevent: ping\ndata: {}\n\n'));
        controller.close();
      },
    });
    const events = [];
    for await (const event of readSse(body)) events.push(event);
    expect(events).toEqual([{ event: 'staged', data: '{"a":1}' }, { event: 'ping', data: '{}' }]);
  });
});

describe('screen pin', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(80_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it("keeps what the user asked for on screen when another agent's result arrives", async () => {
    const screen = new FakeScreen();
    // Both staged just now (an old scene about something else wouldn't be put up at all).
    screen.scenes = [scene('sierra', { updatedAt: 80_000_000 }), scene('malibu', { updatedAt: 80_005_000 })]; // Malibu's is staged while it works
    const backend = new SimulatedAgentBackend({ malibu: () => [{ kind: 'result', text: 'Logged lunch.', afterMs: 6000 }] });
    const { client } = setup(
      [[{ type: 'dispatch', agentId: 'malibu', message: 'log lunch' }], [{ type: 'screen', op: 'show', agentId: 'sierra' }]],
      backend,
      screen,
    );
    client.ask('d1', 'Malibu, log lunch');
    await vi.advanceTimersByTimeAsync(2500);
    expect(screen.current?.id).toBe('malibu-1');
    client.ask('d2', "put Sierra's list back up");
    await vi.advanceTimersByTimeAsync(2500);
    expect(screen.current?.id).toBe('sierra-1');
    await vi.advanceTimersByTimeAsync(8000); // Malibu's result is relayed
    expect(commentary(client).join('\n')).toContain('Logged lunch.');
    expect(screen.current?.id).toBe('sierra-1');
  });
});

describe('resolvePointedChoice', () => {
  const picks = ['Sony', 'Brand K', 'Pioneer'];
  it.each([
    ["Let's go with the second one.", 'Brand K'],
    ['the middle one', 'Brand K'],
    ['number three please', 'Pioneer'],
    ['the last one', 'Pioneer'],
    ['first', 'Sony'],
  ])('%s → %s', (speech, label) => {
    expect(resolvePointedChoice(speech, picks)?.label).toBe(label);
  });
  it('stays out of it when no single position is named', () => {
    expect(resolvePointedChoice('go with the Sony', picks)).toBeUndefined();
    expect(resolvePointedChoice('not the first, the second', picks)).toBeUndefined();
    expect(resolvePointedChoice('the middle one', ['a', 'b'])).toBeUndefined();
  });
});

describe('honest screen claims', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(80_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it("doesn't put up or mention an old scene about something else", async () => {
    const screen = new FakeScreen();
    // An old speaker board from another conversation.
    screen.scenes = [scene('sierra', { title: 'Speaker board', updatedAt: 1, threadId: 'speaker-thread' })];
    const backend = new SimulatedAgentBackend({ sierra: () => [{ kind: 'result', text: 'Three phone mounts are in the thread.', afterMs: 500 }] });
    const { client } = setup([[{ type: 'dispatch', agentId: 'sierra', message: 'find a phone mount' }]], backend, screen);
    client.ask('d1');
    await vi.advanceTimersByTimeAsync(3000);
    expect(screen.shows).toEqual([]);
    const said = commentary(client).join('\n');
    expect(said).not.toMatch(/is on the screen (now|too)/);
    expect(said).toContain("Don't say anything is on the screen");
  });

  it("won't show an old unrelated scene when asked to see the agent's work in progress", async () => {
    const screen = new FakeScreen();
    screen.scenes = [scene('sierra', { title: 'Speaker board', updatedAt: 1, threadId: 'speaker-thread' })];
    const backend = new SimulatedAgentBackend({ sierra: () => [{ kind: 'result', text: 'Seven mockups are in the thread.', afterMs: 500 }] });
    const { client } = setup(
      [[{ type: 'dispatch', agentId: 'sierra', message: 'make stripe mockups' }], [{ type: 'screen', op: 'show', agentId: 'sierra' }]],
      backend,
      screen,
    );
    client.ask('d1');
    await vi.advanceTimersByTimeAsync(3000);
    client.ask('d2', 'put them on the screen');
    await vi.advanceTimersByTimeAsync(2500);
    expect(screen.shows).toEqual([]);
    expect(commentary(client).at(-1)).toContain('Sierra has nothing on the screen for this yet');
  });

  it('shows the exact staged scene the user names', async () => {
    const screen = new FakeScreen();
    screen.scenes = [
      scene('sierra', { id: 'mockups', title: 'Stripe mockups', updatedAt: 2 }),
      scene('sierra', { id: 'speaker', title: 'Speaker board', updatedAt: 1 }),
    ];
    const { client } = setup([[{ type: 'screen', op: 'show', agentId: 'sierra', scene: 'S2' }]], new SimulatedAgentBackend({}), screen);
    client.ask('d1', 'put the speaker board back up');
    await vi.advanceTimersByTimeAsync(2500);
    expect(screen.shows).toEqual(['speaker']);
  });

  it("keeps the agent's scene up when the agent updates another of its scenes", async () => {
    const screen = new FakeScreen();
    const mockups = scene('sierra', { id: 'mockups', title: 'Stripe mockups', updatedAt: 1 });
    const orders = scene('sierra', { id: 'orders', title: 'Order list', updatedAt: 1 });
    screen.scenes = [mockups, orders];
    const backend = new SimulatedAgentBackend({
      sierra: () => {
        // Same turn: refreshes the mockups the user is looking at, then the order list.
        screen.stage(mockups);
        screen.stage(orders);
        return [{ kind: 'result', text: 'Mockups and order list updated.', afterMs: 300 }];
      },
    });
    const { client } = setup([[{ type: 'dispatch', agentId: 'sierra', message: 'update the order list' }]], backend, screen);
    screen.current = mockups;
    client.ask('d1');
    await vi.advanceTimersByTimeAsync(3000);
    expect(screen.current?.id).toBe('mockups');
  });

  it("moving on to another agent takes a finished agent's scene off the screen", async () => {
    const screen = new FakeScreen();
    const old = scene('foxtrot', { id: 'receipts', title: 'Receipts', updatedAt: 1 });
    screen.scenes = [old];
    screen.current = old;
    const backend = new SimulatedAgentBackend({ sierra: () => [{ kind: 'result', text: 'Looking.', afterMs: 500 }] });
    const { client } = setup([[{ type: 'dispatch', agentId: 'sierra', message: 'find a phone mount' }]], backend, screen);
    client.ask('d1', 'ask Sierra to find a phone mount');
    await vi.advanceTimersByTimeAsync(3000);
    expect(screen.current).toBeNull();
    expect(screen.shows).toContain('dashboard');
  });

  it("a request to the same agent keeps its scene up", async () => {
    const screen = new FakeScreen();
    const receipts = scene('foxtrot', { id: 'receipts', title: 'Receipts', updatedAt: 1 });
    screen.scenes = [receipts];
    screen.current = receipts;
    const backend = new SimulatedAgentBackend({ foxtrot: () => [{ kind: 'result', text: 'Saved.', afterMs: 500 }] });
    const { client } = setup([[{ type: 'dispatch', agentId: 'foxtrot', message: 'categorize the toy car as a gift' }]], backend, screen);
    client.ask('d1', 'tell Foxtrot the toy car goes in gifts');
    await vi.advanceTimersByTimeAsync(3000);
    expect(screen.current?.id).toBe('receipts');
  });

    it('still shows a scene from the same thread', async () => {
    const screen = new FakeScreen();
    screen.scenes = [scene('sierra', { title: 'Speaker board', updatedAt: 1, threadId: '1550000000000000001' })];
    const backend = new SimulatedAgentBackend({ sierra: () => [{ kind: 'result', text: 'Board updated.', afterMs: 500 }] });
    const threads = { list: async () => [{ id: '1550000000000000001', title: 'Speaker', agentId: 'sierra', lastActiveAt: 80_000_000 }], create: async () => { throw new Error('no'); } };
    const client = new FakeClient();
    const operator = new LiveOperator({
      client: client as unknown as LiveSessionClient,
      agents: AGENTS,
      backend,
      extractor: async () => [{ type: 'dispatch', agentId: 'sierra', message: 'add a sub column', threadId: '1550000000000000001' }],
      userActivity: new SpeechActivity(),
      playback: new LivePlaybackClock(),
      transcriptSettleMs: 50,
      screen,
      threads,
    });
    operator.start();
    client.ask('d1');
    await vi.advanceTimersByTimeAsync(3000);
    expect(screen.shows).toContain('sierra-1');
    expect(commentary(client).join('\n')).toContain('"Speaker board" is on the screen too');
  });
});
