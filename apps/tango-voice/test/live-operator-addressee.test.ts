import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddresseeAsk, FillerGate, isFillerOnly, matchAddresseeAnswer, namesSomeone, UNSURE_REASON } from '../src/live/addressee.js';
import { SimulatedAgentBackend, type AgentDescriptor } from '../src/live/agent-backend.js';
import type { LiveSessionClient } from '../src/live/gpt-live-client.js';
import { LivePlaybackClock, SpeechActivity } from '../src/live/live-audio.js';
import { buildOperatorInstructions, LiveOperator } from '../src/live/live-operator.js';
import { buildExtractorPrompt, parseExtractorOutput, type ExtractorInput, type OperatorAction, type TaskExtractor } from '../src/live/task-extractor.js';
import { FakeClient, LOUD } from './desk-fakes.js';

// Speech that wasn't meant for the operator (addressee.ts): "For me?" and the filler gate.

const AGENTS: AgentDescriptor[] = [
  { id: 'sierra', name: 'Sierra', role: 'research' },
  { id: 'malibu', name: 'Malibu', role: 'fitness', aliases: ['Mal'] },
];

const raw = (addressed: string | undefined, actions: Array<Record<string, unknown>>) => JSON.stringify({ ...(addressed ? { addressed } : {}), actions });
const dispatchRaw = { type: 'dispatch', agent_id: 'sierra', message: 'Look up shed vents.' };

describe('router: addressed', () => {
  it('no drops everything it returned; unsure rides with the work; yes or absent leaves it alone', () => {
    expect(parseExtractorOutput(raw('no', [dispatchRaw]))).toEqual([{ type: 'none', reason: 'not for the operator' }]);
    expect(parseExtractorOutput(raw('unsure', [dispatchRaw]))).toEqual([{ type: 'dispatch', agentId: 'sierra', message: 'Look up shed vents.' }, { type: 'none', reason: UNSURE_REASON }]);
    expect(parseExtractorOutput(raw('unsure', [{ type: 'none', message: 'nothing asked' }]))).toEqual([{ type: 'none', reason: 'nothing asked' }]);
    expect(parseExtractorOutput(raw('yes', [dispatchRaw]))).toEqual([{ type: 'dispatch', agentId: 'sierra', message: 'Look up shed vents.' }]);
    expect(parseExtractorOutput(raw(undefined, [dispatchRaw]))).toEqual([{ type: 'dispatch', agentId: 'sierra', message: 'Look up shed vents.' }]);
  });

  it('a name wins over the router: named speech is never dropped as not for the operator (Codex review on #481)', () => {
    expect(parseExtractorOutput(raw('no', [dispatchRaw]), { named: true })).toEqual([{ type: 'dispatch', agentId: 'sierra', message: 'Look up shed vents.' }]);
    expect(parseExtractorOutput(raw('unsure', [dispatchRaw]), { named: true })).toEqual([{ type: 'dispatch', agentId: 'sierra', message: 'Look up shed vents.' }]);
  });

  it('the prompt says how long the owner was quiet and how to judge who it was for', () => {
    const prompt = buildExtractorPrompt({ agents: [], tasks: [], transcript: [], latestUserSpeech: 'shed vents', now: 0, quiet: { ownerMs: 300_000, anyMs: 40_000 } } as ExtractorInput);
    expect(prompt).toContain('the user had been silent 5 min (anyone: 40 s)');
    expect(prompt).toContain('lean unsure');
    expect(prompt).toContain('"For me?"');
    expect(buildExtractorPrompt({ agents: [], tasks: [], transcript: [], latestUserSpeech: 'x', now: 0 } as ExtractorInput)).not.toContain('had been silent');
  });

  it('the voice model is told not to answer filler or speech meant for others', () => {
    const instructions = buildOperatorInstructions(AGENTS);
    expect(instructions).toContain('is not a turn: say nothing to it');
    expect(instructions).toContain('If it was not said to you, say nothing');
  });
});

describe('"For me?" answers', () => {
  it('yes, no, or something else', () => {
    for (const yes of ['yes', 'Yeah.', 'yep, for you', 'mm-hmm', 'uh-huh', 'yes please', 'Yankee, yes', 'go ahead', 'okay']) expect(matchAddresseeAnswer(yes), yes).toBe('yes');
    for (const no of ['do not send it', "don't do it", 'do not do it', 'no', 'Nope.', 'no, not you', 'not for you', 'sorry, I was talking to someone else', 'nah', 'never mind']) expect(matchAddresseeAnswer(no), no).toBe('no');
    for (const other of ['', 'can you ask Sierra about the ferry', 'it is really good, does it not', 'the shed vents for the Bike please']) expect(matchAddresseeAnswer(other), other).toBe('other');
  });

  it('a name anywhere makes speech meant for the operator', () => {
    const names = ['yankee', 'Sierra', 'Mal', 'loom'];
    expect(namesSomeone('carbon fiber shed vents, ask Sierra', names)).toBe(true);
    expect(namesSomeone('Yankee, scroll down', names)).toBe(true);
    expect(namesSomeone('send that to Loom', names)).toBe(true);
    expect(namesSomeone('carbon fiber shed vents, 2013 Bike', names)).toBe(false);
    expect(namesSomeone('the mall is closed', names)).toBe(false);
  });
});

describe('filler', () => {
  it('only filler, from real transcripts', () => {
    for (const filler of ['Mm', 'Mm-hmm', ' Uh', '] Mm', 'Mm. [tongue click', '[tongue click] Mm', '. [sniff]', '[cough', '- Mm', 'Hmm?', '[mouth noise']) expect(isFillerOnly(filler), filler).toBe(true);
    for (const words of ['Eight', 'Thanks, John', 'Mm, can you ask Sierra', 'yeah', 'okay', 'a']) expect(isFillerOnly(words), words).toBe(false);
  });

  it('a filler-only utterance closes the gate; real words or a backend append open it', () => {
    let now = 1_000_000;
    const gate = new FillerGate({ now: () => now });
    gate.heard(' Mm');
    expect(gate.admitAudio(true)).toBe(false);
    now += 500;
    gate.heard(' can you ask Sierra');
    expect(gate.admitAudio(true)).toBe(true);
    now += 5000;
    gate.heard(' [sniff]');
    expect(gate.admitAudio(true)).toBe(false);
    gate.open();
    expect(gate.admitAudio(true)).toBe(true);
  });

  it('a cut playback clock is quiet at once (Codex review on #481)', () => {
    const playback = new LivePlaybackClock();
    for (let i = 0; i < 5; i++) playback.enqueue(LOUD);
    expect(playback.isSpeaking()).toBe(true);
    playback.cut();
    expect(playback.isSpeaking()).toBe(false);
  });

  it('closing drops audio already buffered for playback (Codex review on #481)', () => {
    let cleared = 0;
    const gate = new FillerGate({ onClose: () => (cleared += 1) });
    gate.heard(' Mm');
    gate.heard(' Mm');
    expect(cleared).toBe(1);
  });

  it('a murmur over the operator speaking never cuts it off; a closed gate reopens on its own', () => {
    let now = 1_000_000;
    const gate = new FillerGate({ now: () => now, maxClosedMs: 20_000 });
    expect(gate.admitAudio(true)).toBe(true);
    now += 300;
    gate.heard(' mm-hmm');
    expect(gate.admitAudio(true)).toBe(true);
    now += 10_000;
    gate.heard(' Mm');
    expect(gate.admitAudio(true)).toBe(false);
    now += 21_000;
    expect(gate.admitAudio(true)).toBe(true);
  });
});

describe('filler gate, from the log replay', () => {
  it('a murmur after the backend queued something to say does not silence it', () => {
    let now = 1_000_000;
    const gate = new FillerGate({ now: () => now });
    gate.open(); // an update was handed to the voice model
    now += 1500;
    gate.heard(' Mm-hmm'); // said before the update starts playing
    expect(gate.admitAudio(true)).toBe(true);
    now += 8000; // the update played; quiet again
    gate.heard(' Mm');
    expect(gate.admitAudio(true)).toBe(false);
  });

  it('the tail of an earlier reply does not count as a queued update playing (Codex review on #481)', () => {
    let now = 1_000_000;
    const gate = new FillerGate({ now: () => now });
    gate.admitAudio(true); // an earlier reply is playing
    now += 100;
    gate.open(); // an update is queued behind it
    now += 100;
    gate.admitAudio(true); // the earlier reply's tail, no gap
    now += 5000;
    gate.heard(' Mm');
    expect(gate.admitAudio(true)).toBe(true);
  });

  it('a gap between the sentences of a long update is still the update', () => {
    let now = 1_000_000;
    const gate = new FillerGate({ now: () => now });
    gate.admitAudio(true);
    now += 2700;
    gate.heard(' [mouth noise');
    expect(gate.admitAudio(true)).toBe(true);
  });

  it('closes again after a closed spell ran out with nothing said', () => {
    let now = 1_000_000;
    const gate = new FillerGate({ now: () => now, maxClosedMs: 20_000 });
    gate.heard(' Mm');
    now += 25_000;
    gate.heard(' Mm');
    expect(gate.admitAudio(true)).toBe(false);
  });
});

describe('operator: "For me?"', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(80_000_000);
  });
  afterEach(() => vi.useRealTimers());

  const unsure = (agentId = 'sierra', message = 'Look up carbon fiber shed vents for a 2013 Bike.'): OperatorAction[] => [
    { type: 'dispatch', agentId, message },
    { type: 'none', reason: UNSURE_REASON },
  ];

  function setup(actions: OperatorAction[][], options: { addresseeCheck?: boolean; fillerGate?: FillerGate; addressee?: AddresseeAsk; ownerSpeech?: { lastAt: number | null } } = {}) {
    const client = new FakeClient();
    const seen: ExtractorInput[] = [];
    const extractor: TaskExtractor = async (input) => {
      seen.push(input);
      return actions.shift() ?? [{ type: 'none', reason: 'test' }];
    };
    const backend = new SimulatedAgentBackend({ sierra: () => [{ kind: 'result', text: 'Found three.', afterMs: 60_000 }], malibu: () => [{ kind: 'result', text: 'Logged.', afterMs: 60_000 }] });
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
      ...options,
    });
    operator.start();
    const commentary = () => client.appends.filter((append) => append.kind === 'commentary').map((append) => append.content).join('\n');
    const instructions = () => client.appends.filter((append) => append.kind === 'instructions').map((append) => append.content).join('\n');
    return { client, backend, seen, commentary, instructions };
  }

  it('asks "For me?" and sends nothing; a yes sends it', async () => {
    const rig = setup([unsure()]);
    rig.client.ask('d1', 'carbon fiber shed vents, 2013 Bike');
    await vi.advanceTimersByTimeAsync(3000);
    expect(rig.commentary()).toContain('Ask only: "For me?"');
    expect(rig.backend.sends).toHaveLength(0);
    rig.client.ask('d2', 'yeah');
    await vi.advanceTimersByTimeAsync(3000);
    expect(rig.backend.sends).toHaveLength(1);
    expect(rig.seen).toHaveLength(1); // the yes isn't routed as a request of its own
  });

  it('a no sends nothing and says nothing', async () => {
    const rig = setup([unsure()]);
    rig.client.ask('d1', 'it is really good, does it not');
    await vi.advanceTimersByTimeAsync(3000);
    rig.client.ask('d2', 'no, not you');
    await vi.advanceTimersByTimeAsync(3000);
    expect(rig.backend.sends).toHaveLength(0);
    expect(rig.instructions()).toContain('say nothing to it');
  });

  it('no answer drops it', async () => {
    const rig = setup([unsure()]);
    rig.client.ask('d1', 'carbon fiber shed vents');
    await vi.advanceTimersByTimeAsync(25_000);
    rig.client.ask('d2', 'yes');
    await vi.advanceTimersByTimeAsync(3000);
    expect(rig.backend.sends).toHaveLength(0);
  });

  it('something else drops the held work and is routed as new speech', async () => {
    const rig = setup([unsure(), [{ type: 'dispatch', agentId: 'malibu', message: 'Log a 25-second farmer carry at 70 pounds.' }]]);
    rig.client.ask('d1', 'carbon fiber shed vents');
    await vi.advanceTimersByTimeAsync(3000);
    rig.client.ask('d2', 'farmer carry for twenty five seconds at seventy pounds');
    await vi.advanceTimersByTimeAsync(3000);
    expect(rig.backend.sends.map((send) => send.request.agentId)).toEqual(['malibu']);
  });

  it('with no transcript, the voice model\'s description is held and asked about (Codex review on #481)', async () => {
    const rig = setup([unsure()]);
    rig.client.emit('delegation', { id: 'd1', offsetMs: 0, prompt: 'Look up carbon fiber shed vents' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(rig.commentary()).toContain('For me?');
    expect(rig.backend.sends).toHaveLength(0);
  });

  it('naming an agent or the operator never asks', async () => {
    const rig = setup([unsure()]);
    rig.client.ask('d1', 'ask Sierra about carbon fiber shed vents');
    await vi.advanceTimersByTimeAsync(3000);
    expect(rig.commentary()).not.toContain('For me?');
    expect(rig.backend.sends).toHaveLength(1);
  });

  it('switched off, unsure work goes through', async () => {
    const rig = setup([unsure()], { addresseeCheck: false });
    rig.client.ask('d1', 'carbon fiber shed vents');
    await vi.advanceTimersByTimeAsync(3000);
    expect(rig.backend.sends).toHaveLength(1);
  });

  it('the router hears how long the owner had been quiet', async () => {
    const rig = setup([[{ type: 'none', reason: 'x' }], [{ type: 'none', reason: 'x' }]]);
    rig.client.ask('d1', 'first thing');
    await vi.advanceTimersByTimeAsync(3000);
    expect(rig.seen[0]!.quiet).toEqual({ ownerMs: null, anyMs: null });
    await vi.advanceTimersByTimeAsync(180_000);
    rig.client.ask('d2', 'second thing');
    await vi.advanceTimersByTimeAsync(3000);
    expect(rig.seen[1]!.quiet!.ownerMs).toBeGreaterThanOrEqual(180_000);
  });

  it('a yes still gets "Is that everything?" when the send sounded cut off (Codex review on #481)', async () => {
    const rig = setup([[{ type: 'dispatch', agentId: 'sierra', message: 'Look up shed vents and' }, { type: 'draft', op: 'unfinished' }, { type: 'none', reason: UNSURE_REASON }]]);
    rig.client.ask('d1', 'look up shed vents and');
    await vi.advanceTimersByTimeAsync(3000);
    expect(rig.commentary()).toContain('For me?');
    rig.client.ask('d2', 'yes');
    await vi.advanceTimersByTimeAsync(3000);
    expect(rig.backend.sends).toHaveLength(0);
    expect(rig.commentary()).toContain('Is that everything');
  });

  it('a "For me?" asked before a reconnect is answered after it (Codex review on #481)', async () => {
    const addressee = new AddresseeAsk({ now: () => Date.now() });
    const first = setup([unsure()], { addressee });
    first.client.ask('d1', 'carbon fiber shed vents');
    await vi.advanceTimersByTimeAsync(3000);
    expect(first.commentary()).toContain('For me?');
    const second = setup([], { addressee });
    expect(second.instructions()).toContain('Before the reconnect you asked "For me?"');
    second.client.ask('d2', 'yeah');
    await vi.advanceTimersByTimeAsync(3000);
    expect(second.backend.sends).toHaveLength(1);
  });

  it('a held reply is dropped on a reconnect: its task belonged to the old connection (Codex review on #481)', async () => {
    const addressee = new AddresseeAsk({ now: () => Date.now() });
    addressee.hold({ actions: [{ type: 'reply', taskId: 't1', message: 'yes' }], speech: 'yes do that', handles: { desk: new Map(), scenes: new Map(), speech: '' }, checkUnfinished: false });
    const rig = setup([], { addressee });
    expect(addressee.held).toBeNull();
    expect(rig.instructions()).not.toContain('For me?');
  });

  it('a held readback is dropped on a reconnect too, with or without a task (Codex review on #481)', async () => {
    const addressee = new AddresseeAsk({ now: () => Date.now() });
    addressee.hold({ actions: [{ type: 'readback', taskId: 't1' }], speech: 'read me that', handles: { desk: new Map(), scenes: new Map(), speech: '' }, checkUnfinished: false });
    setup([], { addressee });
    expect(addressee.held).toBeNull();
    addressee.hold({ actions: [{ type: 'readback' }], speech: 'read me the last one', handles: { desk: new Map(), scenes: new Map(), speech: '' }, checkUnfinished: false });
    setup([], { addressee });
    expect(addressee.held).toBeNull();
  });

  it('the quiet before speech survives a reconnect or a sleep', async () => {
    const ownerSpeech = { lastAt: null as number | null };
    const first = setup([[{ type: 'none', reason: 'x' }]], { ownerSpeech });
    first.client.ask('d1', 'first thing');
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(600_000);
    const second = setup([[{ type: 'none', reason: 'x' }]], { ownerSpeech });
    second.client.ask('d2', 'after the sleep');
    await vi.advanceTimersByTimeAsync(3000);
    expect(second.seen[0]!.quiet!.ownerMs).toBeGreaterThanOrEqual(600_000);
  });

  it('what the voice model says while the filler gate mutes it is not conversation (Codex review on #481)', async () => {
    const fillerGate = new FillerGate();
    const rig = setup([[{ type: 'none', reason: 'x' }]], { fillerGate });
    fillerGate.heard(' Mm');
    rig.client.operator('Go ahead, I am listening.');
    rig.client.ask('d1', 'it is really good');
    await vi.advanceTimersByTimeAsync(3000);
    expect(rig.seen[0]!.transcript.join('\n')).not.toContain('Go ahead');
  });

  it('a note that only says "say nothing" keeps the filler gate shut (Codex review on #481)', async () => {
    const fillerGate = new FillerGate();
    const rig = setup([[{ type: 'none', reason: 'not for the operator' }]], { fillerGate });
    rig.client.ask('d1', 'Mm');
    fillerGate.heard(' Mm');
    await vi.advanceTimersByTimeAsync(3000);
    expect(rig.instructions()).toContain('say nothing');
    expect(fillerGate.closed).toBe(true);
  });

  it('the shared speech clock follows the last word of a long utterance (Codex review on #481)', async () => {
    const ownerSpeech = { lastAt: null as number | null };
    const rig = setup([[{ type: 'none', reason: 'x' }]], { ownerSpeech });
    rig.client.user(' so the thing is');
    await vi.advanceTimersByTimeAsync(1000);
    rig.client.user(' that we need more'); // within 1.5 s: merges into the same line
    expect(ownerSpeech.lastAt).toBe(Date.now());
  });

  it('a reply that started before the transcript said filler is dropped with it (Codex review on #481)', async () => {
    const fillerGate = new FillerGate();
    const rig = setup([[{ type: 'none', reason: 'x' }]], { fillerGate });
    rig.client.operator('Go ahead, I am listening.'); // the reply began on voice activity alone
    fillerGate.heard(' Mm'); // the session's own listener runs first
    rig.client.user(' Mm');
    rig.client.ask('d1', 'it is really good');
    await vi.advanceTimersByTimeAsync(3000);
    expect(rig.seen[0]!.transcript.join('\n')).not.toContain('Go ahead');
  });

  it('anything the backend gives the voice model to say opens the filler gate', async () => {
    const fillerGate = new FillerGate();
    const rig = setup([unsure()], { fillerGate });
    fillerGate.heard(' Mm');
    expect(fillerGate.closed).toBe(true);
    rig.client.ask('d1', 'carbon fiber shed vents');
    await vi.advanceTimersByTimeAsync(3000);
    expect(fillerGate.closed).toBe(false);
  });
});
