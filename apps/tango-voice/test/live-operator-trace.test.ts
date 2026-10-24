import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulatedAgentBackend, type AgentDescriptor } from '../src/live/agent-backend.js';
import { HttpDeskClient } from '../src/live/desk-client.js';
import type { LiveSessionClient } from '../src/live/gpt-live-client.js';
import { LivePlaybackClock, SpeechActivity } from '../src/live/live-audio.js';
import { describeActions, LiveOperator, type LiveOperatorOptions } from '../src/live/live-operator.js';
import type { OperatorAction, TaskExtractor } from '../src/live/task-extractor.js';
import { deskItem, FakeClient, FakeDesk, FakeDeskScreen } from './desk-fakes.js';

// The operator's decisions in the desk's session trace (POST /api/desk/trace): why the view
// changed or didn't, what routing did with a delegation, and that tracing never changes
// behavior. Synthetic ids only.

const AGENTS: AgentDescriptor[] = [
  { id: 'foxtrot', name: 'Foxtrot', role: 'finance' },
  { id: 'sierra', name: 'Sierra', role: 'research' },
];
const THREAD = '1550000000000000002';

function setup(actions: OperatorAction[][], options: Partial<LiveOperatorOptions> & { desk?: FakeDesk; screen?: FakeDeskScreen } = {}) {
  const client = new FakeClient();
  const extractor: TaskExtractor = async () => actions.shift() ?? [{ type: 'none', reason: 'test' }];
  const desk = options.desk ?? new FakeDesk([deskItem(`discord:thread:${THREAD}`, 'sierra', { threadId: THREAD, place: 'Bike Turn Signal' })]);
  const screen = options.screen ?? new FakeDeskScreen();
  const operator = new LiveOperator({
    client: client as unknown as LiveSessionClient,
    agents: AGENTS,
    backend: new SimulatedAgentBackend({}),
    extractor,
    userActivity: new SpeechActivity(),
    playback: new LivePlaybackClock(),
    floor: { settleMs: 1000, speakTimeoutMs: 5000 },
    transcriptSettleMs: 50,
    homeChannelFor: (agentId) => `home-${agentId}`,
    traceSessionId: 'voice-test-1',
    ...options,
    desk,
    screen,
  });
  operator.start();
  return { client, operator, desk, screen };
}

describe('operator session trace', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(80_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('traces the view decision after a send, with the reason, and what the owner said', async () => {
    const backend = new SimulatedAgentBackend({ sierra: () => [] });
    const rig = setup([[{ type: 'dispatch', agentId: 'sierra', message: 'Is that plan applied?', threadId: THREAD }]], { backend });
    rig.screen.presented = { view: 'screen', itemId: null, conversationKey: `thread:${THREAD}`, sceneId: 's1' };
    rig.client.ask('d1', 'did sierra apply that plan');
    await vi.advanceTimersByTimeAsync(2500);

    const decision = rig.desk.traced('view.decision').at(-1)!;
    expect(decision.summary).toContain('screen → board');
    expect(decision.data).toMatchObject({ from: 'screen', to: 'active', reason: 'sent' });
    expect(decision.sessionId).toBe('voice-test-1');
    expect(rig.desk.traced('view.intent').at(-1)!.data).toMatchObject({ view: 'active', reason: 'sent', applied: true });
    expect(rig.desk.traced('routed').at(-1)!.summary).toMatch(/^model routing in \d+ ms → dispatch sierra/);
    expect(rig.desk.traced('user.said').map((entry) => entry.summary)).toContainEqual(expect.stringContaining('did sierra apply that plan'));
    expect(rig.desk.traced('operator.start')).toHaveLength(1);
  });

  it('traces a send that leaves the view alone, and why', async () => {
    const backend = new SimulatedAgentBackend({ sierra: () => [] });
    const rig = setup([[{ type: 'dispatch', agentId: 'sierra', message: 'Check the socket', threadId: THREAD }]], { backend });
    rig.client.ask('d1', 'have sierra check the socket');
    await vi.advanceTimersByTimeAsync(2500);
    const decision = rig.desk.traced('view.decision').at(-1)!;
    expect(decision.data).toMatchObject({ from: 'active', to: 'unchanged', reason: 'already-active' });
    expect(rig.screen.intents).toEqual([]);
  });

  it('traces a dropped re-fire with what was dropped and why', async () => {
    const backend = new SimulatedAgentBackend({ foxtrot: () => [{ kind: 'result', text: 'Transfer done.', afterMs: 60_000 }] });
    const send: OperatorAction[] = [{ type: 'dispatch', agentId: 'foxtrot', message: 'Do the transfer.' }];
    const rig = setup([send, send], { backend });
    rig.client.ask('d1', 'do the transfer');
    await vi.advanceTimersByTimeAsync(43_000);
    rig.client.emit('delegation', { id: 'd2', offsetMs: 0 }); // GPT-Live re-fires, no new words
    await vi.advanceTimersByTimeAsync(3000);
    expect(backend.sends).toHaveLength(1);
    const refire = rig.desk.traced('delegation.refire').at(-1)!;
    expect(refire.data).toMatchObject({ delegationId: 'd2', reason: expect.stringContaining('nothing new was said'), dropped: send });
    expect(refire.summary).toContain('dropped dispatch foxtrot');
  });

  it('traces a merged duplicate delegation', async () => {
    const backend = new SimulatedAgentBackend({ foxtrot: () => [] });
    const send: OperatorAction[] = [{ type: 'dispatch', agentId: 'foxtrot', message: 'Do the transfer.' }];
    const rig = setup([send, send], { backend });
    rig.client.ask('d1', 'do the transfer');
    await vi.advanceTimersByTimeAsync(2500);
    rig.client.emit('delegation', { id: 'd2', offsetMs: 0 });
    await vi.advanceTimersByTimeAsync(2500);
    expect(rig.desk.traced('delegation.merged').at(-1)!.data).toMatchObject({ id: 'd2', reason: expect.stringContaining('no new speech') });
  });

  it('a throwing trace never changes what the operator does', async () => {
    const backend = new SimulatedAgentBackend({ sierra: () => [] });
    const desk = new FakeDesk([deskItem(`discord:thread:${THREAD}`, 'sierra', { threadId: THREAD })]);
    desk.trace = () => {
      throw new Error('trace endpoint exploded');
    };
    const rig = setup([[{ type: 'dispatch', agentId: 'sierra', message: 'Check the socket', threadId: THREAD }]], { backend, desk });
    rig.screen.presented = { view: 'conversation', itemId: null, conversationKey: `thread:${THREAD}`, sceneId: null };
    rig.client.ask('d1', 'have sierra check the socket');
    await vi.advanceTimersByTimeAsync(2500);
    expect(backend.sends).toHaveLength(1);
    expect(rig.screen.intents).toContainEqual({ view: 'active', reason: 'sent' });
  });

  it('describes routing actions in one line', () => {
    expect(describeActions([])).toBe('nothing');
    expect(describeActions([{ type: 'screen', op: 'board' }, { type: 'none', reason: 'nothing new was said' }])).toBe('screen board, none nothing new was said');
  });
});

describe('HttpDeskClient.trace', () => {
  it('batches entries into one fire-and-forget POST, and stops after a 404', async () => {
    const posts: unknown[] = [];
    let status = 200;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        if (req.url === '/api/desk/trace') posts.push(JSON.parse(body));
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const client = new HttpDeskClient(url, { traceFlushMs: 50 });
      client.trace({ kind: 'user.said', summary: 'owner: “open it”' });
      client.trace({ kind: 'view.decision', summary: 'after send: screen → board', data: { from: 'screen' }, sessionId: 's1' });
      client.trace({ kind: 'routed', summary: 'deterministic → screen board' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(posts).toHaveLength(1);
      const batch = posts[0] as Array<Record<string, unknown>>;
      expect(batch.map((entry) => entry.kind)).toEqual(['user.said', 'view.decision', 'routed']);
      expect(batch.every((entry) => entry.source === 'operator' && typeof entry.at === 'number')).toBe(true);
      expect(batch[1]!.sessionId).toBe('s1');

      status = 404;
      client.trace({ kind: 'a', summary: 'a' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      client.trace({ kind: 'b', summary: 'b' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(posts).toHaveLength(2); // the 404'd one; nothing after
    } finally {
      server.close();
    }
  });

  it('a desk that is down loses the batch quietly', async () => {
    const client = new HttpDeskClient('http://127.0.0.1:9', { traceFlushMs: 10 });
    expect(() => client.trace({ kind: 'x', summary: 'x' })).not.toThrow();
    await client.flushTrace();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
