import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulatedAgentBackend, type AgentDescriptor } from '../src/live/agent-backend.js';
import type { LiveContextKind, LiveSessionClient } from '../src/live/gpt-live-client.js';
import { LivePlaybackClock, SpeechActivity } from '../src/live/live-audio.js';
import { LiveOperator } from '../src/live/live-operator.js';
import type { ExtractorInput, OperatorAction, TaskExtractor } from '../src/live/task-extractor.js';

// Regressions from the owner's 10/03 Discord sessions.

const AGENTS: AgentDescriptor[] = [{ id: 'charlie', name: 'Charlie', role: 'quick answers' }];
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
  delegate(id: string) {
    this.emit('delegation', { id, offsetMs: 0 });
  }
}

function setup(actions: OperatorAction[][], backend = new SimulatedAgentBackend({ charlie: () => [] })) {
  const client = new FakeClient();
  const userActivity = new SpeechActivity();
  const inputs: ExtractorInput[] = [];
  const extractor: TaskExtractor = async (input) => {
    inputs.push(input);
    return actions.shift() ?? [{ type: 'none', reason: 'test' }];
  };
  const operator = new LiveOperator({
    client: client as unknown as LiveSessionClient,
    agents: AGENTS,
    backend,
    extractor,
    userActivity,
    playback: new LivePlaybackClock(),
    floor: { settleMs: 1000, speakTimeoutMs: 5000 },
    transcriptSettleMs: 50,
  });
  operator.start();
  return { client, userActivity, inputs, backend, operator };
}

describe('operator fixes from the 10/03 sessions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('dispatches itself when the operator promises a hand-off but GPT-Live never delegates', async () => {
    const backend = new SimulatedAgentBackend({ charlie: () => [] });
    const { client, inputs } = setup([[{ type: 'reply', taskId: 't1', message: 'The 2013 Bike' }]], backend);
    client.user('The 2013 Bike.');
    client.operator('Got it, the 2013 Bike. Sending that to Charlie.');
    await vi.advanceTimersByTimeAsync(3000);
    expect(inputs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1500);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].latestUserSpeech).toBe('The 2013 Bike.');
  });

  it('does nothing extra when the promised delegation does arrive', async () => {
    const { client, inputs } = setup([[{ type: 'none', reason: 'x' }]]);
    client.user('Ask Charlie where the gas cap is.');
    client.operator('Checking with Charlie.');
    client.delegate('d1');
    await vi.advanceTimersByTimeAsync(6000);
    expect(inputs).toHaveLength(1);
  });

  it('tells GPT-Live when nothing was sent, so it does not hang on "let me check"', async () => {
    const { client } = setup([[{ type: 'none', reason: 'already answered' }]]);
    client.user('So is it most likely the rear one?');
    client.delegate('d1');
    await vi.advanceTimersByTimeAsync(500);
    expect(client.appends).toEqual([expect.objectContaining({ kind: 'instructions', delegationId: 'd1', content: expect.stringContaining('Nothing was sent') })]);
  });

  it('waits for the end of the sentence and merges a second hand-off of the same sentence', async () => {
    const { client, userActivity, inputs } = setup([[{ type: 'dispatch', agentId: 'charlie', message: 'MagSafe socket mounts' }]]);
    client.user('Could you ask Foxtrot if there are MagSafe holders, because I have');
    userActivity.observe(LOUD, Date.now());
    client.delegate('d1');
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(100);
      userActivity.observe(LOUD, Date.now());
    }
    client.user(' a cigarette lighter in the dash.');
    client.delegate('d2');
    await vi.advanceTimersByTimeAsync(3000);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].latestUserSpeech).toContain('cigarette lighter in the dash');
  });

  it('gives the router only words it has not seen, even when a line keeps growing', async () => {
    const { client, inputs } = setup([[{ type: 'none', reason: 'a' }], [{ type: 'none', reason: 'b' }]]);
    client.user('Yeah, send me the links');
    client.delegate('d1');
    await vi.advanceTimersByTimeAsync(500);
    client.user(' and a ballpark price.');
    client.delegate('d2');
    await vi.advanceTimersByTimeAsync(500);
    expect(inputs.map((input) => input.latestUserSpeech)).toEqual(['Yeah, send me the links', 'and a ballpark price.']);
  });
});
