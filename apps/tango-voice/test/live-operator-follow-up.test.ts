import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulatedAgentBackend, STILL_RUNNING_TEXT, type AgentDescriptor } from '../src/live/agent-backend.js';
import type { GptLiveClient, LiveContextKind } from '../src/live/gpt-live-client.js';
import { LivePlaybackClock, SpeechActivity } from '../src/live/live-audio.js';
import { buildOperatorInstructions, LiveOperator } from '../src/live/live-operator.js';
import { buildExtractorPrompt, type OperatorAction, type TaskExtractor } from '../src/live/task-extractor.js';

// Voice misroute 10/19: an agent answered, the owner responded to it ("And you're right, it explains it
// differently…"), the voice model handed that off, the router called it thinking aloud, and the voice model
// answered it itself. A response to the answer an agent just gave goes back to that agent. Synthetic fixtures.

const AGENTS: AgentDescriptor[] = [
  { id: 'sierra', name: 'Sierra', role: 'research' },
  { id: 'watson', name: 'Watson', role: 'assistant' },
];

const LOUD = Buffer.alloc(48_000, 0);
for (let i = 0; i < LOUD.length; i += 2) LOUD.writeInt16LE(i % 4 === 0 ? 4000 : -4000, i);

const ANSWER = 'Sunlight crosses more air at sunset, so the blue scatters away and the reds are left. Want a diagram?';
const FOLLOW_UP = "Okay, that's really interesting, and you're right, it explains why the clouds go pink after the sun is already down";

class FakeLiveClient extends EventEmitter {
  appends: Array<{ kind: LiveContextKind; content: string; delegationId: string | null }> = [];
  appendContext(kind: LiveContextKind, content: string, delegationId: string | null) {
    this.appends.push({ kind, content, delegationId });
    return Promise.resolve({ clientEventId: `e${this.appends.length}` });
  }
  ask(id: string, words: string) {
    this.emit('inputTranscript', { delta: ` ${words}`, startMs: Date.now(), endMs: Date.now() });
    this.emit('delegation', { id, offsetMs: 0 });
  }
}

function setup(router: OperatorAction[][], answer = ANSWER) {
  const client = new FakeLiveClient();
  const playback = new LivePlaybackClock();
  const backend = new SimulatedAgentBackend({ sierra: (request) => (request.turn === 0 ? [{ kind: 'result', text: answer }] : []), watson: () => [] });
  const extractor: TaskExtractor = async () => router.shift() ?? [{ type: 'none', reason: 'thinking out loud' }];
  const operator = new LiveOperator({
    client: client as unknown as GptLiveClient,
    agents: AGENTS,
    backend,
    extractor,
    userActivity: new SpeechActivity(),
    playback,
    policy: 'floor',
    floor: { settleMs: 1000, speakTimeoutMs: 5000 },
    transcriptSettleMs: 50,
    ownerSpeech: { lastAt: Date.now() - 10_000, addressedAt: Date.now() - 10_000 },
  });
  operator.start();
  /** The agent's answer is released, and the voice model speaks it to the end. */
  const hearAnswer = async () => {
    await vi.advanceTimersByTimeAsync(2500);
    const relay = client.appends.find((append) => append.kind === 'commentary' && append.content.includes(answer.slice(0, 20)));
    expect(relay).toBeDefined();
    playback.enqueue(LOUD);
    client.emit('outputTranscript', { delta: ` Sierra says ${answer}`, startMs: 0, endMs: 0 });
    await vi.advanceTimersByTimeAsync(4000);
  };
  const say = async (id: string, words: string) => {
    client.ask(id, words);
    await vi.advanceTimersByTimeAsync(2500);
  };
  const instructions = () => client.appends.filter((append) => append.kind === 'instructions').map((append) => append.content);
  return { client, backend, operator, hearAnswer, say, instructions };
}

describe('a response to the answer an agent just gave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(90_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('goes back to that agent when the router finds nothing to send (voice misroute 10/19)', async () => {
    const rig = setup([[{ type: 'dispatch', agentId: 'sierra', message: 'Why is the sunset red?' }], [{ type: 'none', reason: 'The user is thinking aloud; no request was made.' }]]);
    await rig.say('d1', 'ask Sierra why the sunset is red');
    await rig.hearAnswer();
    await rig.say('d2', FOLLOW_UP);
    expect(rig.backend.sends.map((send) => [send.request.agentId, send.request.turn, send.request.message])).toEqual([
      ['sierra', 0, 'Why is the sunset red?'],
      ['sierra', 1, FOLLOW_UP],
    ]);
    expect(rig.instructions().join('\n')).not.toContain('Nothing was sent to an agent');
    expect(rig.instructions().at(-1)).toContain('Sierra');
  });

  it('a short acknowledgement stays with the operator', async () => {
    const rig = setup([[{ type: 'dispatch', agentId: 'sierra', message: 'Why is the sunset red?' }], [{ type: 'none', reason: 'chit-chat' }]]);
    await rig.say('d1', 'ask Sierra why the sunset is red');
    await rig.hearAnswer();
    await rig.say('d2', "thanks, that's wild");
    expect(rig.backend.sends).toHaveLength(1);
    expect(rig.instructions().at(-1)).toContain('Nothing was sent to an agent');
  });

  it('speech the router judged not meant for the operator is not sent', async () => {
    const rig = setup([[{ type: 'dispatch', agentId: 'sierra', message: 'Why is the sunset red?' }], [{ type: 'none', reason: 'not for the operator' }]]);
    await rig.say('d1', 'ask Sierra why the sunset is red');
    await rig.hearAnswer();
    await rig.say('d2', 'Riley, can you grab the blue jacket from the car before we head out tonight');
    expect(rig.backend.sends).toHaveLength(1);
  });

  it('a "still running" notice is not an answer: a long acknowledgement of it is not sent (Codex review on #798)', async () => {
    const rig = setup([[{ type: 'dispatch', agentId: 'sierra', message: 'Why is the sunset red?' }], [{ type: 'none', reason: 'acknowledgement' }]], STILL_RUNNING_TEXT);
    await rig.say('d1', 'ask Sierra why the sunset is red');
    await rig.hearAnswer();
    expect(rig.client.appends.some((append) => append.content.includes('they go back to Sierra'))).toBe(false);
    await rig.say('d2', 'Okay, no rush at all, I can wait until tomorrow morning for that one');
    expect(rig.backend.sends).toHaveLength(1);
  });

  it('not once something else was sent since the answer, nor long after it', async () => {
    const rig = setup([
      [{ type: 'dispatch', agentId: 'sierra', message: 'Why is the sunset red?' }],
      [{ type: 'dispatch', agentId: 'watson', message: 'Add milk to the list' }],
      [{ type: 'none', reason: 'thinking out loud' }],
    ]);
    await rig.say('d1', 'ask Sierra why the sunset is red');
    await rig.hearAnswer();
    await rig.say('d2', 'have Watson add milk to the list');
    await rig.say('d3', FOLLOW_UP);
    expect(rig.backend.sends.map((send) => send.request.agentId)).toEqual(['sierra', 'watson']);

    const late = setup([[{ type: 'dispatch', agentId: 'sierra', message: 'Why is the sunset red?' }], [{ type: 'none', reason: 'thinking out loud' }]]);
    await late.say('d1', 'ask Sierra why the sunset is red');
    await late.hearAnswer();
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    await late.say('d2', FOLLOW_UP);
    expect(late.backend.sends).toHaveLength(1);
  });

  it('the voice model is told to delegate it: in its instructions and on the relayed answer (live TTS 10/19)', async () => {
    expect(buildOperatorInstructions(AGENTS)).toContain('The user responds to what an agent just reported');
    const rig = setup([[{ type: 'dispatch', agentId: 'sierra', message: 'Why is the sunset red?' }]]);
    await rig.say('d1', 'ask Sierra why the sunset is red');
    await vi.advanceTimersByTimeAsync(2500);
    const relay = rig.client.appends.find((append) => append.kind === 'commentary' && append.content.includes('Sunlight crosses'));
    expect(relay?.content).toContain("they go back to Sierra. Don't discuss it yourself.");
  });

  it('the router is told such a response is a reply, not thinking out loud', () => {
    const prompt = buildExtractorPrompt({ agents: AGENTS, tasks: [], transcript: [], latestUserSpeech: FOLLOW_UP });
    expect(prompt).toContain("Right after an agent's answer was relayed, the user responding to it");
    expect(prompt).toContain('A response to the answer an agent just gave is yes');
  });
});
