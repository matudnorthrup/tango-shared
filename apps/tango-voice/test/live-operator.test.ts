import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulatedAgentBackend, type AgentDescriptor } from '../src/live/agent-backend.js';
import type { GptLiveClient, LiveContextKind } from '../src/live/gpt-live-client.js';
import { LivePlaybackClock, SpeechActivity } from '../src/live/live-audio.js';
import { LiveOperator, type DeliveryPolicy } from '../src/live/live-operator.js';
import type { OperatorAction, TaskExtractor } from '../src/live/task-extractor.js';

const AGENTS: AgentDescriptor[] = [
  { id: 'watson', name: 'Watson', role: 'assistant' },
  { id: 'juliet', name: 'Juliet', role: 'logistics' },
];

const LOUD = Buffer.alloc(4800, 0);
for (let i = 0; i < LOUD.length; i += 2) LOUD.writeInt16LE(i % 4 === 0 ? 4000 : -4000, i);

class FakeLiveClient extends EventEmitter {
  appends: Array<{ kind: LiveContextKind; content: string; delegationId: string | null }> = [];
  rejectDelegations = new Set<string>();

  appendContext(kind: LiveContextKind, content: string, delegationId: string | null) {
    if (delegationId && this.rejectDelegations.has(delegationId)) {
      return Promise.reject(new Error('unknown_delegation'));
    }
    this.appends.push({ kind, content, delegationId });
    return Promise.resolve({ clientEventId: `e${this.appends.length}` });
  }

  userSaid(text: string, startMs: number, endMs: number) {
    this.emit('inputTranscript', { delta: text, startMs, endMs });
  }

  operatorSaid(text: string) {
    this.emit('outputTranscript', { delta: text, startMs: 0, endMs: 0 });
  }

  /** Each request comes with something the user said, as in a real session. */
  delegate(id: string, offsetMs: number, speech = `request ${id}`) {
    if (speech) this.emit('inputTranscript', { delta: ` ${speech}`, startMs: offsetMs + 100_000, endMs: offsetMs + 100_001 });
    this.emit('delegation', { id, offsetMs });
  }
}

function setup(policy: DeliveryPolicy, actions: OperatorAction[][], backend: SimulatedAgentBackend) {
  const client = new FakeLiveClient();
  const userActivity = new SpeechActivity();
  const playback = new LivePlaybackClock();
  const extractorCalls: string[] = [];
  const extractor: TaskExtractor = async (input) => {
    extractorCalls.push(input.latestUserSpeech);
    return actions.shift() ?? [{ type: 'none', reason: 'test' }];
  };
  const operator = new LiveOperator({
    client: client as unknown as GptLiveClient,
    agents: AGENTS,
    backend,
    extractor,
    userActivity,
    playback,
    policy,
    floor: { settleMs: 2000, speakTimeoutMs: 5000 },
    transcriptSettleMs: 100,
  });
  operator.start();
  return { client, operator, userActivity, playback, extractorCalls };
}

const commentary = (client: FakeLiveClient) => client.appends.filter((append) => append.kind === 'commentary');

describe('LiveOperator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('turns a delegation into an agent task using the fresh user transcript', async () => {
    const backend = new SimulatedAgentBackend({ watson: () => [] });
    const { client, extractorCalls } = setup('floor', [[{ type: 'dispatch', agentId: 'watson', message: 'Review PR 412' }]], backend);

    client.userSaid('Ask Watson to review', 0, 900);
    client.userSaid(' PR 412.', 900, 1500);
    client.delegate('d1', 1600, '');
    await vi.advanceTimersByTimeAsync(200);

    expect(extractorCalls).toEqual(['Ask Watson to review PR 412.']);
    expect(backend.sends.map((send) => send.request)).toEqual([{ taskId: 't1', agentId: 'watson', message: 'Review PR 412', turn: 0 }]);
    // GPT-Live said a neutral "on it"; the destination is confirmed once routing knows it (never as commentary).
    expect(client.appends).toEqual([{ kind: 'instructions', delegationId: 'd1', content: expect.stringContaining('Routed to Watson') }]);

    client.userSaid('Thanks.', 5000, 5400);
    client.delegate('d2', 5500, '');
    await vi.advanceTimersByTimeAsync(200);
    expect(extractorCalls[1]).toBe('Thanks.');
  });

  it('holds a result while the user is talking and releases it after the floor settles', async () => {
    const backend = new SimulatedAgentBackend({ juliet: () => [{ kind: 'result', text: 'Plumber Thursday 10 to noon.', releaseTag: 'j' }] });
    const { client, userActivity } = setup('floor', [[{ type: 'dispatch', agentId: 'juliet', message: 'Find a plumber' }]], backend);
    client.delegate('d1', 0);
    await vi.advanceTimersByTimeAsync(200);

    backend.release('j');
    client.userSaid('What did Watson say about the settings page?', 4000, 6000);
    for (let i = 0; i < 30; i++) {
      userActivity.observe(LOUD, Date.now());
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(commentary(client)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(2500);
    expect(commentary(client)).toHaveLength(1);
    expect(commentary(client)[0]).toMatchObject({ delegationId: 'd1' });
    expect(commentary(client)[0].content).toContain('Okay, now Juliet said');
    expect(commentary(client)[0].content).toContain('Plumber Thursday');
  });

  it('releases queued results one at a time, after the previous one was actually spoken', async () => {
    const backend = new SimulatedAgentBackend({
      watson: () => [{ kind: 'result', text: 'Saturday is free until three' }],
      juliet: () => [{ kind: 'result', text: 'Vet appointment Monday morning' }],
    });
    const { client, playback } = setup(
      'floor',
      [[{ type: 'dispatch', agentId: 'watson', message: 'a' }, { type: 'dispatch', agentId: 'juliet', message: 'b' }]],
      backend,
    );
    client.delegate('d1', 0);
    await vi.advanceTimersByTimeAsync(2500);
    expect(commentary(client).map((append) => append.content)).toEqual([expect.stringContaining('Saturday is free')]);

    // Operator is still talking and hasn't relayed it yet: the next update waits.
    for (let i = 0; i < 40; i++) playback.enqueue(LOUD);
    client.operatorSaid('Okay so');
    await vi.advanceTimersByTimeAsync(3000);
    expect(commentary(client)).toHaveLength(1);

    client.operatorSaid(' Watson says Saturday is free until three.');
    await vi.advanceTimersByTimeAsync(3500);
    expect(commentary(client)).toHaveLength(2);
    expect(commentary(client)[1].content).toContain('Vet appointment');
  });

  it('re-releases an update the user cut off before it was relayed', async () => {
    const backend = new SimulatedAgentBackend({ watson: () => [{ kind: 'result', text: 'Farmers market Sundays at the Commons' }] });
    const { client, playback, userActivity } = setup('floor', [[{ type: 'dispatch', agentId: 'watson', message: 'market' }]], backend);
    client.delegate('d1', 0);
    await vi.advanceTimersByTimeAsync(2500);
    expect(commentary(client)).toHaveLength(1);

    // Operator starts ("Oh, and") and the user talks over it.
    for (let i = 0; i < 15; i++) playback.enqueue(LOUD);
    client.operatorSaid('Oh, and');
    await vi.advanceTimersByTimeAsync(300);
    for (let i = 0; i < 20; i++) {
      userActivity.observe(LOUD, Date.now());
      if (i === 2) client.userSaid('wait, which market do you mean', Date.now(), Date.now() + 1);
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(3000);
    expect(commentary(client)).toHaveLength(2);
    expect(commentary(client)[1]).toMatchObject({ delegationId: null });
    expect(commentary(client)[1].content).toContain('did not hear this yet');
  });

  it('accepts a paraphrased relay when nobody interrupted', async () => {
    const backend = new SimulatedAgentBackend({ watson: () => [{ kind: 'result', text: 'The aquarium closes at 6:00 PM; open daily from 10:00 AM.' }] });
    const { client, playback, userActivity, operator } = setup('floor', [[{ type: 'dispatch', agentId: 'watson', message: 'aquarium hours' }]], backend);
    client.delegate('d1', 0);
    await vi.advanceTimersByTimeAsync(2500);
    for (let i = 0; i < 20; i++) playback.enqueue(LOUD);
    client.operatorSaid('Watson says it shuts at six tonight.');
    await vi.advanceTimersByTimeAsync(4000);
    // The user answers after the relay finished: that's a reply, not a cut-off.
    for (let i = 0; i < 10; i++) {
      userActivity.observe(LOUD, Date.now());
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(5000);
    expect(commentary(client)).toHaveLength(1);
    expect(operator.pendingUpdates).toBe(0);
  });

  it('keeps progress out of the conversation until the user asks', async () => {
    const backend = new SimulatedAgentBackend({ watson: () => [{ kind: 'progress', text: 'Found 14 emails' }] });
    const { client } = setup('floor', [[{ type: 'dispatch', agentId: 'watson', message: 'bank email' }], [{ type: 'status' }]], backend);
    client.delegate('d1', 0);
    await vi.advanceTimersByTimeAsync(500);
    expect(client.appends.some((append) => append.content.includes('14 emails'))).toBe(false);

    client.delegate('d2', 5000);
    await vi.advanceTimersByTimeAsync(200);
    expect(commentary(client).at(-1)?.content).toContain('Found 14 emails');
  });

  it('drops a near-duplicate dispatch for an agent that is already on it', async () => {
    const backend = new SimulatedAgentBackend({ watson: () => [] });
    const { client } = setup(
      'floor',
      [
        [{ type: 'dispatch', agentId: 'watson', message: 'Plan the Lakeport car trip with drive times, Costco, and lunch' }],
        [{ type: 'dispatch', agentId: 'watson', message: 'Research the Lakeport car trip: drive times, Costco, lunch, in a document' }],
      ],
      backend,
    );
    client.delegate('d1', 0);
    await vi.advanceTimersByTimeAsync(200);
    client.delegate('d2', 4000);
    await vi.advanceTimersByTimeAsync(200);
    expect(backend.sends).toHaveLength(1);
  });

  it('routes a reply back to the task that asked the question', async () => {
    const backend = new SimulatedAgentBackend({
      juliet: (request) =>
        request.turn === 0 ? [{ kind: 'question', text: 'Tuesday or Wednesday?' }] : [{ kind: 'result', text: 'Booked.' }],
    });
    const { client, operator } = setup(
      'immediate',
      [[{ type: 'dispatch', agentId: 'juliet', message: 'Book the dentist' }], [{ type: 'reply', taskId: 't1', message: 'Wednesday' }]],
      backend,
    );
    client.delegate('d1', 0);
    await vi.advanceTimersByTimeAsync(200);
    expect(operator.tasks[0].status).toBe('waiting_user');
    expect(client.appends.some((append) => append.kind === 'thinking' && append.content.includes('awaits the user'))).toBe(true);

    client.delegate('d2', 3000);
    await vi.advanceTimersByTimeAsync(200);
    expect(backend.sends.map((send) => send.request)).toEqual([
      { taskId: 't1', agentId: 'juliet', message: 'Book the dentist', turn: 0 },
      { taskId: 't1', agentId: 'juliet', message: 'Wednesday', turn: 1 },
    ]);
    expect(commentary(client).at(-1)).toMatchObject({ delegationId: 'd2' });
  });

  it('releases the next queued update on a status request without waiting for the floor', async () => {
    const backend = new SimulatedAgentBackend({ watson: () => [{ kind: 'result', text: 'Watson result', afterMs: 500 }] });
    const { client, userActivity } = setup(
      'floor',
      [[{ type: 'dispatch', agentId: 'watson', message: 'a' }], [{ type: 'status' }]],
      backend,
    );
    client.delegate('d1', 0);
    await vi.advanceTimersByTimeAsync(300); // dispatched; the user starts talking before the result lands
    userActivity.observe(LOUD, Date.now());
    await vi.advanceTimersByTimeAsync(500);
    expect(commentary(client)).toHaveLength(0);

    // "Anything back?" goes out once the user finishes (1.5 s), not after the 2 s floor.
    userActivity.observe(LOUD, Date.now());
    client.delegate('d2', 1000);
    await vi.advanceTimersByTimeAsync(1800);
    expect(commentary(client)).toHaveLength(1);
    expect(commentary(client)[0].content).toContain('Watson result');
  });

  it('falls back to session-wide context when the delegation is no longer accepted', async () => {
    const backend = new SimulatedAgentBackend({ watson: () => [{ kind: 'result', text: 'late result', afterMs: 1000 }] });
    const { client } = setup('immediate', [[{ type: 'dispatch', agentId: 'watson', message: 'a' }]], backend);
    client.delegate('d1', 0);
    await vi.advanceTimersByTimeAsync(200);
    client.rejectDelegations.add('d1');
    await vi.advanceTimersByTimeAsync(1200);
    expect(commentary(client)).toEqual([expect.objectContaining({ delegationId: null, content: expect.stringContaining('late result') })]);
  });
});
