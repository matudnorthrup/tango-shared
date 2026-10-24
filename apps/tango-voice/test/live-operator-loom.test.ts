import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SimulatedAgentBackend, type AgentDescriptor } from '../src/live/agent-backend.js';
import { HttpDeskClient, type DeskPendingRequest } from '../src/live/desk-client.js';
import type { LiveSessionClient } from '../src/live/gpt-live-client.js';
import { LivePlaybackClock, SpeechActivity } from '../src/live/live-audio.js';
import { LiveOperator, type LiveOperatorOptions } from '../src/live/live-operator.js';
import { buildExtractorPrompt, isCodingItemId, preferNamedLoom, type ExtractorInput, type OperatorAction, type TaskExtractor } from '../src/live/task-extractor.js';
import { deskItem, FakeClient, FakeDesk, FakeDeskScreen } from './desk-fakes.js';

// Loom threads (`loom:…`, where new desk threads run by default) on every voice path a Loom thread
// (`loom:…`) takes: naming one, the desk ops on it, its questions and approvals, misroute correction,
// and starting a new one. Content is synthetic.

const AGENTS: AgentDescriptor[] = [
  { id: 'foxtrot', name: 'Foxtrot', role: 'finance' },
  { id: 'watson', name: 'Watson', role: 'chief of staff' },
];

const loomItem = (id: string, place: string, extra: Parameters<typeof deskItem>[2] = {}) => deskItem(id, 'loom', { agentName: 'Loom', place, nextStep: 'your_move', ...extra });

interface Rig {
  client: FakeClient;
  operator: LiveOperator;
  desk: FakeDesk;
  screen: FakeDeskScreen;
  seen: ExtractorInput[];
  backend: SimulatedAgentBackend;
}

function setup(actions: OperatorAction[][], desk: FakeDesk, options: Partial<LiveOperatorOptions> = {}): Rig {
  const client = new FakeClient();
  const seen: ExtractorInput[] = [];
  const extractor: TaskExtractor = async (input) => {
    seen.push(input);
    return actions.shift() ?? [{ type: 'none', reason: 'test' }];
  };
  const screen = new FakeDeskScreen();
  const backend = new SimulatedAgentBackend({});
  const operator = new LiveOperator({
    client: client as unknown as LiveSessionClient,
    agents: AGENTS,
    backend,
    extractor,
    userActivity: new SpeechActivity(),
    playback: new LivePlaybackClock(),
    floor: { settleMs: 1000, speakTimeoutMs: 5000 },
    transcriptSettleMs: 50,
    homeChannelFor: (agentId) => `home-${agentId}`,
    defaultAgentId: 'watson',
    ...options,
    desk,
    screen,
  });
  operator.start();
  return { client, operator, desk, screen, seen, backend };
}

const said = (client: FakeClient) => client.appends.filter((append) => append.kind === 'commentary').map((append) => append.content).join('\n');
const say = async (rig: Rig, id: string, words: string) => {
  rig.client.ask(id, words);
  await vi.advanceTimersByTimeAsync(3000);
};

describe('a named Loom thread wins, as a Loom one does', () => {
  const items = [
    { handle: 'i1', id: 'loom:aaa', place: 'tango · Voice coverage for Loom' },
    { handle: 'i2', id: 'loom:bbb', place: 'harbor · Make Tide Tables Searchable' },
    { handle: 'i3', id: 'discord:chapter:x', place: null },
  ];
  const people = AGENTS.map((agent) => ({ id: agent.id, names: [agent.name] }));
  const toWatson = (message: string): OperatorAction[] => [{ type: 'dispatch', agentId: 'watson', message }];

  it('coding ids are loom: and loom:, nothing else', () => {
    expect(isCodingItemId('loom:aaa')).toBe(true);
    expect(isCodingItemId('loom:bbb')).toBe(true);
    expect(isCodingItemId('discord:thread:1')).toBe(false);
    expect(isCodingItemId(undefined)).toBe(false);
  });

  it('"Loom" plus its name, or the name said outright, sends it to the Loom item', () => {
    expect(preferNamedLoom('ask the Loom voice coverage thread for status', toWatson('x'), items, people)[0]).toMatchObject({ type: 'desk', op: 'reply', item: 'i1', message: 'x' });
    expect(preferNamedLoom('tell voice coverage for Loom the PR merged', toWatson('x'), items, people)[0]).toMatchObject({ type: 'desk', item: 'i1' });
    // "Loom" said out of habit still finds a Loom thread: both are coding threads.
    expect(preferNamedLoom('ask the Loom voice coverage thread for status', toWatson('x'), items, people)[0]).toMatchObject({ type: 'desk', item: 'i1' });
  });

  it('a one-word Loom title addressed as a thread is a name too', () => {
    const one = [...items, { handle: 'i4', id: 'loom:ccc', place: 'tango · Compass' }];
    expect(preferNamedLoom('ask the Loom Compass thread for status', toWatson('x'), one, people)[0]).toMatchObject({ type: 'desk', item: 'i4' });
  });

  it('already going to a Loom item, ruled out, or a named agent: the router stands', () => {
    const toLoom: OperatorAction[] = [{ type: 'desk', op: 'reply', item: 'i1', message: 'x' }, { type: 'dispatch', agentId: 'foxtrot', message: 'y' }];
    expect(preferNamedLoom('ask the Loom voice coverage thread, and foxtrot too', toLoom, items, people)).toBe(toLoom);
    expect(preferNamedLoom("don't send this to Loom, voice coverage is for Watson", toWatson('x'), items, people)).toEqual(toWatson('x'));
    expect(preferNamedLoom('Watson, ask about the Loom voice coverage thread', toWatson('x'), items, people)).toEqual(toWatson('x'));
    // Codex review on #703: "coding thread" is ruled out as Loom are.
    expect(preferNamedLoom("don't send this to the coding thread; get a status on voice coverage for Loom", toWatson('x'), items, people)).toEqual(toWatson('x'));
  });

  it('the router prompt treats Loom items as coding threads and knows "new Loom thread"', () => {
    const prompt = buildExtractorPrompt({ agents: [], tasks: [], transcript: [], now: 0, desk: { items: [] } } as never);
    expect(prompt).toContain('Always for Loom items');
    expect(prompt).toContain('"new Loom thread in tango"');
    expect(prompt).toContain('"Loom" plus a thread\'s name');
  });
});

describe('operator: Loom threads on the desk', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(80_000_000);
  });
  afterEach(() => vi.useRealTimers());

  const desk = () =>
    new FakeDesk([
      deskItem('discord:chapter:fox', 'foxtrot', { nextStep: 'fyi' }),
      loomItem('loom:voice', 'tango · Voice coverage', { ask: 'Merge it?', options: ['Merge', 'Wait'] }),
    ]);

  it('misroute correction: a dispatch for an agent the user never named goes into the named Loom thread', async () => {
    const rig = setup([[{ type: 'dispatch', agentId: 'watson', message: 'What is the status?' }]], desk());
    await say(rig, 'd1', 'ask the Loom voice coverage thread what the status is');
    expect(rig.desk.sent('reply')).toEqual([expect.objectContaining({ itemId: 'loom:voice', args: { text: 'What is the status?' } })]);
    expect(rig.backend.sends).toEqual([]);
    expect(said(rig.client)).toContain('Sent to the Loom thread "tango · Voice coverage": a coding thread in Loom, not an agent');
  });

  it('the router naming "loom" (or "loom") as the agent reaches the Loom thread, never the chief of staff', async () => {
    const rig = setup(
      [[{ type: 'dispatch', agentId: 'loom', message: 'Ship it.' }], [{ type: 'dispatch', agentId: 'loom', message: 'And tag it.' }]],
      desk(),
    );
    await say(rig, 'd1', 'tell it to ship it');
    await say(rig, 'd2', 'and tag it');
    expect(rig.desk.sent('reply').map((command) => [command.itemId, command.args.text])).toEqual([
      ['loom:voice', 'Ship it.'],
      ['loom:voice', 'And tag it.'],
    ]);
    expect(rig.backend.sends).toEqual([]);
  });

  it('with several coding threads and none in focus, "loom" asks which coding thread', async () => {
    const two = desk();
    two.list.push(deskItem('loom:other', 'loom', { place: 'harbor · Tide tables' }));
    const rig = setup([[{ type: 'dispatch', agentId: 'loom', message: 'Ship it.' }]], two);
    await say(rig, 'd1', 'tell it to ship it');
    expect(rig.desk.sent('reply')).toEqual([]);
    expect(rig.backend.sends).toEqual([]);
    expect(said(rig.client)).toContain('Which coding thread is that for? Ask the user: "tango · Voice coverage", "harbor · Tide tables"');
  });

  it('a dispatch whose thread is the Loom thread goes into it', async () => {
    const rig = setup([[{ type: 'dispatch', agentId: 'watson', message: 'Rebase it.', threadId: 'loom:voice' }]], desk());
    await say(rig, 'd1', 'rebase it');
    expect(rig.desk.sent('reply')).toEqual([expect.objectContaining({ itemId: 'loom:voice', args: { text: 'Rebase it.' } })]);
  });

  it('open and read show the Loom conversation', async () => {
    for (const op of ['open', 'read'] as const) {
      const rig = setup([[{ type: 'desk', op, item: 'i2' }]], desk());
      await say(rig, 'd1', 'show me the voice coverage one');
      expect(rig.screen.intents).toContainEqual(expect.objectContaining({ view: 'conversation', itemId: 'loom:voice' }));
      rig.operator.stop();
    }
  });

  it('answer, snooze, park, pick up and done act on the Loom item', async () => {
    const cases: Array<[OperatorAction, string, Record<string, unknown>]> = [
      [{ type: 'desk', op: 'answer', item: 'i2', option: 'merge' }, 'answer', { option: 'Merge' }],
      [{ type: 'desk', op: 'snooze', item: 'i2', until: '2026-10-18T15:00:00-07:00' }, 'snooze', { until: '2026-10-18T15:00:00-07:00' }],
      [{ type: 'desk', op: 'park', item: 'i2' }, 'park', {}],
      [{ type: 'desk', op: 'pickup', item: 'i2' }, 'pickup', {}],
      [{ type: 'desk', op: 'done', item: 'i2' }, 'done', {}],
    ];
    for (const [action, type, args] of cases) {
      const rig = setup([[action]], desk());
      await say(rig, 'd1', `do ${type} on the voice coverage one`);
      expect(rig.desk.commands.map((command) => ({ type: command.type, itemId: command.itemId, args: command.args }))).toEqual([{ type, itemId: 'loom:voice', args }]);
      rig.operator.stop();
    }
  });

  it('"mark the Loom one done" resolves to the Loom item, as "Loom" would', () => {
    const rig = setup([], desk());
    expect(rig.operator.resolveTarget('mark the loom one done')).toBe('loom:voice');
    expect(rig.operator.resolveTarget('mark the Loom one done')).toBe('loom:voice');
    expect(rig.operator.resolveTarget('mark the foxtrot one done')).toBe('discord:chapter:fox');
  });

  it("a Loom thread's questions and approvals are answered as a Loom thread's are", async () => {
    const asking: DeskPendingRequest = {
      kind: 'question',
      requestId: 'req-1',
      questions: [{ id: 'Reviewer?', header: 'Reviewer', question: 'Who reviews?', multiSelect: false, options: [{ label: 'Codex', description: '' }, { label: 'Nobody', description: '' }] }],
      question: 'Who reviews?',
      options: ['Codex', 'Nobody'],
      at: Date.now(),
    };
    const approving: DeskPendingRequest = {
      kind: 'approval',
      requestId: 'ap-1',
      questions: [],
      question: 'Run the deploy',
      options: ['Approve', 'Decline'],
      approval: { detail: 'Run the deploy', options: [{ decision: 'accept', label: 'Approve' }, { decision: 'decline', label: 'Decline' }] },
      at: Date.now(),
    };
    const rig = setup(
      [[{ type: 'desk', op: 'respond', item: 'i1', answers: [{ question: 'q1', answer: 'codex' }] }], [{ type: 'desk', op: 'approve', item: 'i2', approval: 'accept' }]],
      new FakeDesk([
        loomItem('loom:ask', 'tango · Review', { ask: asking.question, facts: { pending: asking } }),
        loomItem('loom:deploy', 'tango · Deploy', { ask: approving.question, facts: { pending: approving } }),
      ]),
    );
    await say(rig, 'd1', 'codex reviews');
    expect(rig.seen[0]!.desk!.items[0]).toMatchObject({ questions: [expect.objectContaining({ handle: 'q1' })] });
    await say(rig, 'd2', 'yes, approve the deploy');
    expect(rig.desk.sent('respond')).toEqual([expect.objectContaining({ itemId: 'loom:ask', args: { requestId: 'req-1', answers: { 'Reviewer?': 'Codex' } } })]);
    expect(rig.desk.sent('approve')).toEqual([expect.objectContaining({ itemId: 'loom:deploy', args: { requestId: 'ap-1', decision: 'accept' } })]);
  });
});

describe('HttpDeskClient: Start work on Loom', () => {
  it("an older desk that doesn't name the item: a Loom start is a loom: item, else loom:", async () => {
    let driver = 'loom';
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, threadId: 'th-1', plan: { title: 'Fix it', account: { name: 'Loom (best account)', driver } } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const client = new HttpDeskClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      expect(await client.startWork({ repo: 'tango', prompt: 'Fix it.' } as never)).toMatchObject({ ok: true, itemId: 'loom:th-1' });
      driver = 'claudeAgent';
      expect(await client.startWork({ repo: 'tango', prompt: 'Fix it.' } as never)).toMatchObject({ ok: true, itemId: 'loom:th-1' });
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
