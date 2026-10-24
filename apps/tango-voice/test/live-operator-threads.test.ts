import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulatedAgentBackend, type AgentDescriptor } from '../src/live/agent-backend.js';
import type { ThreadDirectory, ThreadInfo } from '../src/live/discord-threads.js';
import type { LiveContextKind, LiveSessionClient } from '../src/live/gpt-live-client.js';
import { LivePlaybackClock, SpeechActivity } from '../src/live/live-audio.js';
import { chunkForReadback, LiveOperator } from '../src/live/live-operator.js';
import type { ExtractorInput, OperatorAction, TaskExtractor } from '../src/live/task-extractor.js';
import { deskItem, FakeDesk } from './desk-fakes.js';

const AGENTS: AgentDescriptor[] = [
  { id: 'watson', name: 'Watson', role: 'assistant' },
  { id: 'sierra', name: 'Sierra', role: 'research' },
];

class FakeClient extends EventEmitter {
  appends: Array<{ kind: LiveContextKind; content: string; delegationId: string | null }> = [];
  appendContext(kind: LiveContextKind, content: string, delegationId: string | null) {
    this.appends.push({ kind, content, delegationId });
    return Promise.resolve({ clientEventId: 'x' });
  }
  delegate(id: string) {
    this.emit('inputTranscript', { delta: ` request ${id}`, startMs: 0, endMs: 0 });
    this.emit('delegation', { id, offsetMs: 0 });
  }
  said(text: string) {
    this.emit('outputTranscript', { delta: text, startMs: 0, endMs: 0 });
  }
}

class FakeThreads implements ThreadDirectory {
  created: Array<{ agentId: string; title: string }> = [];
  constructor(public threads: ThreadInfo[]) {}
  async list() {
    return this.threads;
  }
  async create(agentId: string, title: string) {
    this.created.push({ agentId, title });
    const thread = { id: `156000000000000000${this.created.length}`, title, agentId, lastActiveAt: Date.now() };
    this.threads.unshift(thread);
    return thread;
  }
}

function setup(options: { actions: OperatorAction[][]; backend: SimulatedAgentBackend; threads?: FakeThreads; desk?: FakeDesk }) {
  const client = new FakeClient();
  const playback = new LivePlaybackClock();
  const extractorInputs: ExtractorInput[] = [];
  const extractor: TaskExtractor = async (input) => {
    extractorInputs.push(input);
    return options.actions.shift() ?? [{ type: 'none', reason: 'test' }];
  };
  const operator = new LiveOperator({
    client: client as unknown as LiveSessionClient,
    agents: AGENTS,
    backend: options.backend,
    extractor,
    userActivity: new SpeechActivity(),
    playback,
    floor: { settleMs: 1000, speakTimeoutMs: 5000 },
    transcriptSettleMs: 50,
    threads: options.threads,
    ...(options.desk ? { desk: options.desk } : {}),
  });
  operator.start();
  return { client, operator, playback, extractorInputs };
}

const commentary = (client: FakeClient) => client.appends.filter((append) => append.kind === 'commentary').map((append) => append.content);
const LOUD = Buffer.alloc(4800);
for (let i = 0; i < LOUD.length; i += 2) LOUD.writeInt16LE(i % 4 === 0 ? 4000 : -4000, i);

describe('LiveOperator threads and read-back', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('gives the extractor the active threads and sends work into the chosen thread', async () => {
    const threads = new FakeThreads([{ id: '1560000000000000002', title: 'Bike purchase', agentId: 'watson', lastActiveAt: Date.now() - 20 * 60_000 }]);
    const backend = new SimulatedAgentBackend({ watson: () => [{ kind: 'result', text: 'Added the dealer address.' }] });
    const { client, extractorInputs } = setup({
      actions: [[{ type: 'dispatch', agentId: 'watson', message: 'Add the dealer address', threadId: '1560000000000000002' }]],
      backend,
      threads,
    });
    client.delegate('d1');
    await vi.advanceTimersByTimeAsync(100);
    expect(extractorInputs[0].threads).toEqual([{ id: '1560000000000000002', title: 'Bike purchase', agentName: 'Watson', lastActive: '20 minutes ago' }]);
    expect(backend.sends[0].request).toMatchObject({ agentId: 'watson', channelId: '1560000000000000002' });
    await vi.advanceTimersByTimeAsync(1500);
    expect(commentary(client)[0]).toContain('Watson in the "Bike purchase" thread reported back');
    // The question travels with the answer, so the spoken version covers what was asked.
    expect(commentary(client)[0]).toContain('The user asked: "Add the dealer address". Answer every part of that aloud');
  });

  it('starts a new thread through the desk, never straight in Discord, makes it current, and relays its answer', async () => {
    const threads = new FakeThreads([]);
    const desk = new FakeDesk();
    const backend = new SimulatedAgentBackend({ sierra: () => [] });
    const { client, extractorInputs } = setup({
      actions: [[{ type: 'dispatch', agentId: 'sierra', message: 'Plan the Pinecrest trip', newThreadTitle: 'Pinecrest trip' }], [{ type: 'none', reason: 'chat' }]],
      backend,
      threads,
      desk,
    });
    client.delegate('d1');
    await vi.advanceTimersByTimeAsync(100);
    expect(threads.created).toEqual([]);
    expect(desk.agentThreads).toEqual([expect.objectContaining({ agentId: 'sierra', prompt: 'Plan the Pinecrest trip', title: 'Pinecrest trip', commandId: expect.stringMatching(/^voice-/) })]);
    expect(desk.agentThreads[0]).not.toHaveProperty('projectId');
    // The bot posts the words and wakes the agent: the operator doesn't send them a second time.
    expect(backend.sends).toEqual([]);
    expect(client.appends.at(-1)?.content).toContain('Started Sierra in a new thread, "Pinecrest trip"');
    client.delegate('d2');
    await vi.advanceTimersByTimeAsync(100);
    expect(extractorInputs[1].currentThread).toMatchObject({ id: '1550000000000000001', title: 'Pinecrest trip' });
    // Its answer comes back through the desk.
    desk.list.push(deskItem('discord:thread:1550000000000000001', 'sierra', { threadId: '1550000000000000001', place: 'Pinecrest trip' }));
    desk.agentPosts('discord:thread:1550000000000000001', 'Three campgrounds near Pinecrest have sites open.', { nextStep: 'fyi' });
    await vi.advanceTimersByTimeAsync(1500);
    expect(commentary(client).join('\n')).toContain('Three campgrounds near Pinecrest');
  });

  it('without the desk, a new thread is refused out loud: nothing goes to Discord or the main channel', async () => {
    const threads = new FakeThreads([]);
    const backend = new SimulatedAgentBackend({ sierra: () => [] });
    const { client } = setup({ actions: [[{ type: 'dispatch', agentId: 'sierra', message: 'Plan the Pinecrest trip', newThreadTitle: 'Pinecrest trip' }]], backend, threads });
    client.delegate('d1');
    await vi.advanceTimersByTimeAsync(100);
    expect(threads.created).toEqual([]);
    expect(backend.sends).toEqual([]);
    expect(commentary(client).join('\n')).toContain("new threads start through the desk, and it isn't connected");
  });

  it('reads the full text back on request, in order, without waiting for the floor', async () => {
    const long = Array.from({ length: 24 }, (_, i) => `Sentence number ${i + 1} of the approved email draft goes here with some detail.`).join(' ');
    const backend = new SimulatedAgentBackend({ watson: () => [{ kind: 'result', text: 'Watson drafted the email.', fullText: long }] });
    const { client, playback } = setup({
      actions: [[{ type: 'dispatch', agentId: 'watson', message: 'Draft the email' }], [{ type: 'readback' }]],
      backend,
    });
    client.delegate('d1');
    await vi.advanceTimersByTimeAsync(1500);
    for (let i = 0; i < 5; i++) playback.enqueue(LOUD);
    client.said('Watson drafted the email.');
    await vi.advanceTimersByTimeAsync(1000); // its audio finished playing

    client.delegate('d2');
    await vi.advanceTimersByTimeAsync(200);
    const readback = commentary(client).filter((text) => text.startsWith('Read this aloud exactly'));
    expect(readback).toHaveLength(1);
    expect(readback[0]).toContain('Sentence number 1 ');
    expect(readback[0]).toContain('part 1 of');
  });

  it('chunks long text on sentence boundaries under the append limit', () => {
    const text = Array.from({ length: 40 }, (_, i) => `This is sentence ${i}.`).join(' ');
    const chunks = chunkForReadback(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 200 && /\.$/.test(chunk))).toBe(true);
    expect(chunks.join(' ')).toBe(text);
  });
});
