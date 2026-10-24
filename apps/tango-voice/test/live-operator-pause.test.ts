import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpDeskClient } from '../src/live/desk-client.js';
import { SimulatedAgentBackend, type AgentDescriptor } from '../src/live/agent-backend.js';
import { DRAFT_ON_INSTRUCTIONS, DraftSession } from '../src/live/draft-mode.js';
import type { LiveSessionClient } from '../src/live/gpt-live-client.js';
import { LivePlaybackClock, SpeechActivity } from '../src/live/live-audio.js';
import { buildOperatorInstructions, LiveOperator, type LateUpdate, type LiveOperatorOptions } from '../src/live/live-operator.js';
import {
  type PauseScreenCommand,
  catchUpSentence,
  matchPauseCommand,
  PAUSE_OFF_INSTRUCTIONS,
  PAUSE_ON_INSTRUCTIONS,
  PauseSession,
  resumeAnnouncement,
} from '../src/live/pause-mode.js';
import type { ExtractorInput, OperatorAction, TaskExtractor } from '../src/live/task-extractor.js';
import { deskItem, FakeClient, FakeDesk, FakeDeskScreen, LOUD, scene } from './desk-fakes.js';

// Pause mode (pause-mode.ts): "Yankee, pause" (or the legacy "Tango, pause") holds every agent
// message in silence until "Yankee, I'm back". Synthetic ids and names only.

const AGENTS: AgentDescriptor[] = [
  { id: 'sierra', name: 'Sierra', role: 'research and trips' },
  { id: 'victor', name: 'Victor', role: 'engineering' },
  { id: 'malibu', name: 'Malibu', role: 'nutrition' },
];
const Loom: AgentDescriptor = { id: 'loom', name: 'Loom', role: 'Loom thread' };

interface Rig {
  client: FakeClient;
  operator: LiveOperator;
  desk: FakeDesk;
  backend: SimulatedAgentBackend;
  playback: LivePlaybackClock;
  routed: ExtractorInput[];
  pause: PauseSession;
  draft: DraftSession;
}

function setup(options: { actions?: OperatorAction[][]; pause?: PauseSession; draft?: DraftSession; desk?: FakeDesk; backend?: SimulatedAgentBackend; extra?: Partial<LiveOperatorOptions> } = {}): Rig {
  const client = new FakeClient();
  const routed: ExtractorInput[] = [];
  const actions = options.actions ?? [];
  const extractor: TaskExtractor = async (input) => {
    routed.push(input);
    return actions.shift() ?? [{ type: 'none', reason: 'test' }];
  };
  const desk = options.desk ?? new FakeDesk([deskItem('discord:chapter:sierra', 'sierra', { nextStep: 'watching' })]);
  const backend = options.backend ?? new SimulatedAgentBackend({});
  const playback = new LivePlaybackClock();
  const pause = options.pause ?? new PauseSession();
  const draft = options.draft ?? new DraftSession({ compile: async (input) => ({ message: input.fragments.join(' '), agentId: 'sierra', item: null, threadId: null, newThreadTitle: null, questions: [] }) });
  const operator = new LiveOperator({
    client: client as unknown as LiveSessionClient,
    agents: AGENTS,
    backend,
    extractor,
    userActivity: new SpeechActivity(),
    playback,
    floor: { settleMs: 1000, speakTimeoutMs: 5000 },
    transcriptSettleMs: 50,
    homeChannelFor: (agentId) => `home-${agentId}`,
    desk,
    screen: new FakeDeskScreen(),
    pause,
    draft,
    ...options.extra,
  });
  operator.start();
  return { client, operator, desk, backend, playback, routed, pause, draft };
}

async function say(rig: Rig, id: string, words: string) {
  rig.client.ask(id, words);
  await vi.advanceTimersByTimeAsync(600);
}

/** An agent update arrives for the operator to relay (as from an earlier connection). */
function arrive(rig: Rig, agent: AgentDescriptor, text: string, kind: 'result' | 'question' = 'result') {
  const late: LateUpdate = { kind: 'result', agent, update: { kind, text } };
  rig.operator.adoptLateUpdate(late);
}

/**
 * The operator says what it was last given (the announcement, or the update being relayed),
 * through to the end; then wait for the next relay to be released.
 */
async function speakThrough(rig: Rig) {
  const before = relays(rig).length;
  for (let i = 0; i < 5; i++) rig.playback.enqueue(LOUD);
  rig.client.operator(` ${commentary(rig).at(-1) ?? ''}`);
  for (let i = 0; i < 60 && relays(rig).length === before; i++) await vi.advanceTimersByTimeAsync(200);
}

const commentary = (rig: Rig) => rig.client.appends.filter((append) => append.kind === 'commentary').map((append) => append.content);
const instructions = (rig: Rig) => rig.client.appends.filter((append) => append.kind === 'instructions').map((append) => append.content);
const relays = (rig: Rig) => commentary(rig).filter((text) => !text.startsWith('[Say only') && /reported back|has a question|New from|didn't finish/.test(text));

describe('pause and resume phrases', () => {
  const PAUSES = [
    'Yankee, pause.',
    'Yankee pause',
    'Hey Yankee, hold my messages',
    'Yankee, give me a minute',
    'Yanky, pause',
    'Yankees, pause.',
    "Yankee's pause",
    'Okay Yankee, go quiet',
    'Tango pause',
    'Tango, pause.',
    'Tango, pause messages',
    'Tango hold my messages',
    'Tango, hold on.',
    'Tango, give me a minute',
    'Tango, one sec',
    'Tango go quiet',
    'Tango, mute.',
    'Hey Tango, pause.',
    'Okay Tango, hold my messages please',
    'Tangó, pause',
    'TANGO PAUSE!',
    'Tango, pause. Anyway, as I was saying, the kitchen needs paint.',
  ];
  const RESUMES = [
    "Yankee, I'm back",
    'Yankee, resume.',
    'Yankee, what did I miss?',
    "Hey Yanky, I'm back",
    'Yankees resume',
    'Tango resume',
    "Tango, I'm back",
    'Tango, I’m back.',
    'Tango unpause',
    'Tango, what did I miss?',
    'Tango play my messages',
    'Tango, continue',
    'Tango, you can talk again',
    "Hey Tango, I'm back, what did I miss?",
    "Tango's back... no wait. Tango, I'm back.",
  ];
  const NEITHER = [
    'I told Yankee to pause',
    'Yankee, pause the movie',
    "Yankee, what's on my calendar tomorrow?",
    'the Yankees game is paused',
    'yank it, pause',
    'pause the movie',
    "I'm back from the store",
    'hold on a second',
    'give me a minute',
    'I told Tango to pause',
    "so then Tango said I'm back",
    'we should ask Tango to resume the build',
    'Tango, pause the movie',
    "Tango, what's on my calendar tomorrow?",
    'tangle pause',
    'can you pause it for a minute Tango',
    'resume',
    "I'm back",
  ];

  it.each(PAUSES)('pauses: %s', (text) => expect(matchPauseCommand(text)).toBe('pause'));
  it.each(RESUMES)('resumes: %s', (text) => expect(matchPauseCommand(text)).toBe('resume'));
  it.each(NEITHER)('room talk, not a command: %s', (text) => expect(matchPauseCommand(text)).toBeNull());

  it('announcement: a count, nothing, or a one-sentence catch-up past four', () => {
    expect(resumeAnnouncement([])).toBe('Nothing came in.');
    expect(resumeAnnouncement([{ agentName: 'Sierra', kind: 'result' }])).toBe("You've got 1 update.");
    expect(resumeAnnouncement(Array.from({ length: 4 }, () => ({ agentName: 'Sierra', kind: 'result' as const })))).toBe("You've got 4 updates.");
    const five = [
      { agentName: 'Sierra', kind: 'result' as const },
      { agentName: 'Malibu', kind: 'result' as const },
      { agentName: 'Loom', kind: 'question' as const },
      { agentName: 'Sierra', kind: 'result' as const },
      { agentName: 'Victor', kind: 'failed' as const },
    ];
    expect(catchUpSentence(five)).toBe('Sierra and Malibu got back to you, Loom has a question, and Victor had a turn fail');
    expect(resumeAnnouncement(five)).toBe("You've got 5 updates. Sierra and Malibu got back to you, Loom has a question, and Victor had a turn fail.");
  });
});

describe('pause mode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(90_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('"Tango, pause": one short confirmation, GPT-Live told to stay silent, the pill up, no router call', async () => {
    const rig = setup();
    await say(rig, 'd1', 'Tango, pause.');
    expect(rig.pause.active).toBe(true);
    expect(instructions(rig)).toContain(PAUSE_ON_INSTRUCTIONS);
    expect(PAUSE_ON_INSTRUCTIONS).toMatch(/say nothing at all/);
    expect(commentary(rig)).toEqual(['[Say only "Paused." and then nothing at all.]']);
    expect(rig.routed).toHaveLength(0);
    expect(rig.desk.pause).toMatchObject({ active: true, waiting: 0, still: false, id: expect.any(String) });
    expect(rig.desk.traced('pause.start')).toHaveLength(1);
  });

  it('"Yankee, pause" / "Yankee, I\'m back" (the operator\'s name), and the legacy "Tango" still works', async () => {
    const rig = setup();
    await say(rig, 'd1', 'Yankee, pause.');
    expect(rig.pause.active).toBe(true);
    expect(rig.routed).toHaveLength(0);
    await say(rig, 'd2', "Yankee, I'm back.");
    expect(rig.pause.active).toBe(false);
    await say(rig, 'd3', 'Tango, pause.');
    expect(rig.pause.active).toBe(true);
    await say(rig, 'd4', 'Tango, resume.');
    expect(rig.pause.active).toBe(false);
    expect(rig.routed).toHaveLength(0);
    expect(rig.desk.traced('pause.start')).toHaveLength(2);
  });

  it('the operator instructions name Yankee and its pause phrases', () => {
    const text = buildOperatorInstructions([{ id: 'sierra', name: 'Sierra', role: 'research' }]);
    expect(text).toContain('You are Yankee');
    expect(text).toContain('"Yankee, pause"');
    expect(text).toContain('"Yankee, I\'m back"');
    expect(text).toMatch(/"Tango" instead of "Yankee"/);
    expect(text).toMatch(/picks a conversation to work on/);
  });

  it('pauses from the transcript alone, when GPT-Live never delegates', async () => {
    const rig = setup();
    rig.client.user(' Tango, hold my messages.');
    await vi.advanceTimersByTimeAsync(2500);
    expect(rig.pause.active).toBe(true);
    expect(rig.routed).toHaveLength(0);
  });

  it('room talk without the wake word never pauses', async () => {
    const rig = setup();
    await say(rig, 'd1', 'pause the movie for a minute');
    await say(rig, 'd2', "I'm back from the store");
    expect(rig.pause.active).toBe(false);
    expect(rig.routed).toHaveLength(2); // normal routing
  });

  it('while paused: delegations are ignored, nothing is sent or routed, no captions, nothing said', async () => {
    const rig = setup({ actions: [[{ type: 'dispatch', agentId: 'sierra', message: 'Check the ferry.' }]] });
    await say(rig, 'd1', 'Tango pause');
    const before = rig.client.appends.length;
    const captions = rig.desk.operatorUpdates.filter((update) => update.transcript?.speaker === 'user').length;
    await say(rig, 'd2', 'ask Sierra to check the ferry times');
    rig.client.user(' so anyway the contractor said Tuesday');
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.routed).toHaveLength(0);
    expect(rig.backend.sends).toHaveLength(0);
    expect(rig.client.appends.length).toBe(before);
    expect(rig.desk.operatorUpdates.filter((update) => update.transcript?.speaker === 'user').length).toBe(captions);
    const ignored = rig.desk.traced('pause.ignored');
    expect(ignored.length).toBeGreaterThanOrEqual(2);
    // Only how much was heard, never the words.
    expect(JSON.stringify(ignored)).not.toContain('contractor');
  });

  it('results queue while paused and play after resume, with the count first', async () => {
    const rig = setup();
    await say(rig, 'd1', 'Tango, pause.');
    arrive(rig, AGENTS[0], 'The ferry leaves at seven.');
    arrive(rig, AGENTS[2], 'Lunch was logged.');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(relays(rig)).toEqual([]);
    expect(rig.desk.pause).toMatchObject({ active: true, waiting: 2 });
    expect(rig.desk.traced('pause.queued')).toHaveLength(2);

    await say(rig, 'r1', "Tango, I'm back.");
    expect(rig.pause.active).toBe(false);
    expect(instructions(rig)).toContain(PAUSE_OFF_INSTRUCTIONS);
    expect(commentary(rig).at(-1)).toBe('[Say only: "You\'ve got 2 updates." Then stop. The updates follow one at a time.]');
    expect(rig.desk.pause).toMatchObject({ active: false, waiting: 0 });
    expect(rig.routed).toHaveLength(0);
    // The announcement is said, then the updates one at a time.
    await speakThrough(rig);
    expect(relays(rig)).toHaveLength(1);
    expect(relays(rig)[0]).toContain('The ferry leaves at seven.');
    await speakThrough(rig);
    expect(relays(rig)).toHaveLength(2);
    // No second "N updates are waiting" digest.
    expect(commentary(rig).some((text) => text.includes('updates are waiting'))).toBe(false);
    expect(rig.desk.traced('pause.resume')).toHaveLength(1);
  });

  it('nothing came in: "Nothing came in."', async () => {
    const rig = setup();
    await say(rig, 'd1', 'Tango pause');
    await say(rig, 'r1', 'Tango, what did I miss?');
    expect(commentary(rig).at(-1)).toBe('[Say only: "Nothing came in." Then stop.]');
  });

  it('more than four: a one-sentence catch-up first, then your-move items first', async () => {
    const rig = setup();
    await say(rig, 'd1', 'Tango pause');
    arrive(rig, AGENTS[0], 'The tent is packed.');
    arrive(rig, AGENTS[2], 'Dinner was logged.');
    arrive(rig, Loom, 'Which branch should I use?', 'question');
    arrive(rig, AGENTS[1], 'The build is green.');
    arrive(rig, AGENTS[0], 'The ferry is on time.');
    await vi.advanceTimersByTimeAsync(5000);
    await say(rig, 'r1', 'Tango resume');
    expect(commentary(rig).at(-1)).toContain("You've got 5 updates. Sierra, Malibu and Victor got back to you, and Loom has a question.");
    expect(rig.desk.traced('pause.digest')).toHaveLength(1);
    await speakThrough(rig);
    expect(relays(rig)[0]).toContain('Which branch should I use?');
    await speakThrough(rig);
    expect(relays(rig)[1]).toContain('The tent is packed.');
  });

  it('failures and deadlines (with deadline in the urgent lane) do not break through; they play first after resume', async () => {
    const backend = new SimulatedAgentBackend({ sierra: () => [{ kind: 'result', text: 'never', releaseTag: 'never' }] });
    const desk = new FakeDesk([
      deskItem('discord:chapter:sierra', 'sierra', { nextStep: 'working' }),
      deskItem('discord:chapter:victor', 'victor', { nextStep: 'fyi', seen: 'new' }),
    ]);
    const rig = setup({ backend, desk, actions: [[{ type: 'dispatch', agentId: 'sierra', message: 'Book the campsite.' }]], extra: { urgentLane: ['deadline'] } });
    await say(rig, 'd1', 'ask Sierra to book the campsite');
    await vi.advanceTimersByTimeAsync(2000);
    expect(backend.sends).toHaveLength(1);
    await say(rig, 'd2', 'Tango, pause.');
    arrive(rig, AGENTS[2], 'Lunch was logged.');
    // Sierra's turn fails, and Victor's item comes due in five minutes.
    desk.update('discord:chapter:sierra', { nextStep: 'failed', facts: { failed: { at: Date.now(), reason: 'error', message: 'site closed' } } });
    desk.update('discord:chapter:victor', { nextStep: 'your_move', ask: 'Approve the release?', summary: { gist: 'release', due: Date.now() + 5 * 60_000 } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(relays(rig)).toEqual([]);
    // The deadline is a knock, not a queued update: it waits for a break after the pause.
    expect(rig.desk.pause?.waiting).toBe(2);

    await say(rig, 'r1', 'Tango, I am back');
    expect(commentary(rig).at(-1)).toContain("You've got 2 updates.");
    await speakThrough(rig);
    expect(relays(rig)[0]).toContain("didn't finish");
    await speakThrough(rig);
    expect(relays(rig)[1]).toContain('Lunch was logged.');
    expect(relays(rig).join('\n')).not.toContain('Approve the release?');
  });

  it('an update being relayed when the pause starts goes back to the front, and is not lost', async () => {
    const rig = setup();
    arrive(rig, AGENTS[0], 'The ferry leaves at seven.');
    await vi.advanceTimersByTimeAsync(2000);
    expect(relays(rig)).toHaveLength(1);
    await say(rig, 'd1', 'Tango, one sec');
    expect(rig.desk.pause?.waiting).toBe(1);
    await say(rig, 'r1', 'Tango continue');
    expect(commentary(rig).at(-1)).toContain("You've got 1 update.");
    await speakThrough(rig);
    expect(relays(rig)).toHaveLength(2);
  });

  it('a reconnect keeps the pause: the new connection is told, holds, and resumes', async () => {
    const pause = new PauseSession();
    const desk = new FakeDesk();
    const first = setup({ pause, desk });
    await say(first, 'd1', 'Tango pause');
    first.operator.stop();
    const second = setup({ pause, desk });
    expect(pause.active).toBe(true);
    expect(instructions(second)).toContain(PAUSE_ON_INSTRUCTIONS);
    expect(desk.traced('pause.carried')).toHaveLength(1);
    arrive(second, AGENTS[0], 'The ferry leaves at seven.');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(relays(second)).toEqual([]);
    await say(second, 'e1', "Tango, I'm back");
    expect(commentary(second).at(-1)).toContain("You've got 1 update.");
    expect(first.client.appends.filter((append) => append.content.includes('update'))).toHaveLength(0);
  });

  it('the desk pill: a tap resumes; a tap on an old pause is ignored', async () => {
    const rig = setup();
    await say(rig, 'd1', 'Tango pause');
    arrive(rig, AGENTS[0], 'The ferry leaves at seven.');
    await vi.advanceTimersByTimeAsync(2000);
    rig.desk.pauseHandler?.({ action: 'resume', pauseId: 'not-this-one' });
    await vi.advanceTimersByTimeAsync(100);
    expect(rig.pause.active).toBe(true);
    expect(rig.desk.traced('pause.screen.stale')).toHaveLength(1);
    rig.desk.pauseHandler?.({ action: 'resume', pauseId: rig.desk.pause!.id! });
    await vi.advanceTimersByTimeAsync(100);
    expect(rig.pause.active).toBe(false);
    expect(commentary(rig).at(-1)).toContain("You've got 1 update.");
    expect(rig.desk.traced('pause.resume')[0].data).toMatchObject({ how: 'screen' });
  });

  it('after 30 minutes the pill says still paused, and nothing is said', async () => {
    const rig = setup();
    await say(rig, 'd1', 'Tango pause');
    const appends = rig.client.appends.length;
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(rig.desk.pause).toMatchObject({ active: true, still: true });
    expect(rig.client.appends.length).toBe(appends);
    expect(rig.desk.traced('pause.still')).toHaveLength(1);
  });

  it('keeps the connection awake for an hour, then it may sleep (still paused)', async () => {
    const rig = setup();
    await say(rig, 'd1', 'Tango pause');
    arrive(rig, AGENTS[0], 'The ferry leaves at seven.');
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.operator.isIdle()).toBe(false);
    await vi.advanceTimersByTimeAsync(61 * 60_000);
    expect(rig.operator.isIdle()).toBe(true);
    expect(rig.pause.active).toBe(true);
  });

  it('audio gate: the rest of a reply under way is dropped; only the confirmation plays, then nothing (Codex review on #394)', async () => {
    const rig = setup();
    await say(rig, 'd1', 'Tango pause');
    const step = async (voiced: boolean, ms = 100) => {
      await vi.advanceTimersByTimeAsync(ms);
      return rig.pause.admitAudio(voiced);
    };
    // The old reply keeps streaming: dropped, even once the transcript says "paused".
    expect(await step(true)).toBe(false);
    rig.client.operator(' Paused.');
    expect(await step(true)).toBe(false);
    expect(await step(true)).toBe(false);
    // A gap, then the confirmation: it plays, through its own short pauses.
    expect(await step(false, 300)).toBe(false);
    expect(await step(true, 200)).toBe(true);
    expect(await step(false)).toBe(true);
    expect(await step(true)).toBe(true);
    // It finished: nothing more plays while paused.
    expect(await step(false, 900)).toBe(false);
    expect(await step(true, 2000)).toBe(false);
    await say(rig, 'r1', 'Tango resume');
    expect(rig.pause.admitAudio(true)).toBe(true);
  });

  it('audio gate: without the confirmation in the transcript nothing plays, and the window closes', async () => {
    const rig = setup();
    await say(rig, 'd1', 'Tango pause');
    await vi.advanceTimersByTimeAsync(1000);
    expect(rig.pause.admitAudio(true)).toBe(false); // something else, not "Paused."
    await vi.advanceTimersByTimeAsync(9000);
    rig.client.operator(' Paused.');
    await vi.advanceTimersByTimeAsync(1000);
    expect(rig.pause.admitAudio(true)).toBe(false); // too late
  });

  it('a fresh session clears a pill a crashed one left behind (Codex review on #394)', async () => {
    const rig = setup();
    expect(rig.desk.pause).toMatchObject({ id: null, active: false });
  });

  it('a failure keeps its priority across a reconnect while paused (Codex review on #394)', async () => {
    const pause = new PauseSession();
    const desk = new FakeDesk([deskItem('discord:chapter:sierra', 'sierra', { nextStep: 'working' })]);
    const handed: LateUpdate[] = [];
    const backend = new SimulatedAgentBackend({ sierra: () => [{ kind: 'result', text: 'never', releaseTag: 'never' }] });
    const first = setup({ pause, desk, backend, actions: [[{ type: 'dispatch', agentId: 'sierra', message: 'Book the campsite.' }]], extra: { onLateUpdate: (late) => handed.push(late) } });
    await say(first, 'd1', 'ask Sierra to book the campsite');
    await vi.advanceTimersByTimeAsync(2000);
    await say(first, 'd2', 'Tango pause');
    arrive(first, AGENTS[2], 'Lunch was logged.');
    desk.update('discord:chapter:sierra', { nextStep: 'failed', facts: { failed: { at: Date.now(), reason: 'error', message: 'site closed' } } });
    await vi.advanceTimersByTimeAsync(2000);
    first.operator.stop();
    expect(handed.find((late) => late.update.text.includes("didn't finish"))).toMatchObject({ failed: true });
    const second = setup({ pause, desk });
    for (const late of handed) second.operator.adoptLateUpdate(late);
    await say(second, 'r1', "Tango, I'm back");
    await speakThrough(second);
    expect(relays(second)[0]).toContain("didn't finish");
  });

  it('never sleeps holding more updates than a sleep can carry (Codex review on #394)', async () => {
    const rig = setup();
    await say(rig, 'd1', 'Tango pause');
    for (let i = 0; i < 201; i++) arrive(rig, AGENTS[0], `Update number ${i}.`);
    await vi.advanceTimersByTimeAsync(61 * 60_000);
    expect(rig.operator.isIdle()).toBe(false);
  });

  it('room talk while paused is dropped from the transcript: the router never sees it after resume (Codex review on #394)', async () => {
    const rig = setup({ actions: [[{ type: 'dispatch', agentId: 'sierra', message: 'Check the ferry.' }]] });
    await say(rig, 'd1', 'Tango, pause.');
    await say(rig, 'd2', 'so the contractor said Tuesday for the deck');
    rig.client.user(' and the neighbor wants the ladder back');
    await vi.advanceTimersByTimeAsync(3000);
    await say(rig, 'r1', "Tango, I'm back.");
    expect(rig.operator.transcriptLines().join(' ')).not.toMatch(/contractor|ladder/);
    await vi.advanceTimersByTimeAsync(2000);
    await say(rig, 'd3', 'ask Sierra to check the ferry');
    expect(rig.routed).toHaveLength(1);
    expect(JSON.stringify(rig.routed[0])).not.toMatch(/contractor|ladder/);
    expect(rig.routed[0].latestUserSpeech).toBe('ask Sierra to check the ferry');
    expect(JSON.stringify(rig.desk.traces)).not.toMatch(/contractor|ladder/);
    expect(JSON.stringify(rig.desk.operatorUpdates)).not.toMatch(/contractor|ladder/);
  });

  it('room talk in the same breath as the resume command: only the command is traced (Codex review on #394)', async () => {
    const rig = setup();
    await say(rig, 'd1', 'Tango pause');
    await say(rig, 'r1', "so anyway the contractor said Tuesday. Tango, I'm back.");
    expect(rig.pause.active).toBe(false);
    const resumed = rig.desk.traced('pause.resume');
    expect(resumed).toHaveLength(1);
    expect(JSON.stringify(rig.desk.traces)).not.toContain('contractor');
    expect(resumed[0].summary).toContain("tango i'm back");
    expect(resumed[0].data).toMatchObject({ otherWords: 6 });
  });

  it('the confirmation is recognized when "Paused." arrives split over transcript deltas (Codex review on #394)', async () => {
    const rig = setup();
    await say(rig, 'd1', 'Tango pause');
    rig.client.operator(' Pau');
    rig.client.operator('sed.');
    await vi.advanceTimersByTimeAsync(600);
    expect(rig.pause.admitAudio(true)).toBe(true);
  });

  it('immediate delivery: a pause while a release waits on the screen keeps the update (Codex review on #394)', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    class SlowScreen extends FakeDeskScreen {
      override async showAgent(agentId: string, reason?: string) {
        await gate;
        return super.showAgent(agentId, reason);
      }
    }
    const screen = new SlowScreen();
    screen.scenes = [scene('loop', 'sierra', { updatedAt: Date.now() })];
    const rig = setup({ extra: { policy: 'immediate', screen } });
    arrive(rig, AGENTS[0], 'The ferry leaves at seven.');
    await vi.advanceTimersByTimeAsync(100);
    await say(rig, 'd1', 'Tango pause');
    open();
    await vi.advanceTimersByTimeAsync(2000);
    expect(relays(rig)).toEqual([]);
    expect(rig.desk.traced('pause.queued').some((entry) => entry.data?.requeued)).toBe(true);
    expect(rig.desk.pause?.waiting).toBe(1);
    await say(rig, 'r1', 'Tango resume');
    expect(commentary(rig).some((text) => text.includes("You've got 1 update."))).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(relays(rig)).toHaveLength(1);
    expect(relays(rig)[0]).toContain('The ferry leaves at seven.');
  });

  it('session end while paused: traced, the pill clears, held updates stay on the desk', async () => {
    const rig = setup();
    await say(rig, 'd1', 'Tango pause');
    arrive(rig, AGENTS[0], 'The ferry leaves at seven.');
    await vi.advanceTimersByTimeAsync(2000);
    rig.pause.end();
    expect(rig.desk.traced('pause.ended')[0].data).toMatchObject({ waiting: 1 });
    expect(rig.desk.pause).toMatchObject({ active: false });
  });

  it('pausing a draft keeps it; paused speech is not added; resume returns to it', async () => {
    const rig = setup();
    await say(rig, 'd1', 'draft mode for Sierra');
    await say(rig, 'd2', 'the ferry leaves at seven');
    await say(rig, 'd3', 'Tango, hold on.');
    expect(rig.pause.active).toBe(true);
    expect(rig.draft.active).toBe(true);
    await say(rig, 'd4', 'no I said the blue one, the blue one');
    rig.client.user(' we should repaint the fence');
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.desk.draft?.fragments).toEqual(['the ferry leaves at seven']);
    await say(rig, 'r1', "Tango, I'm back");
    expect(rig.draft.active).toBe(true);
    expect(instructions(rig).at(-1)).toBe(DRAFT_ON_INSTRUCTIONS);
    await say(rig, 'd5', 'so we need to be there by six thirty');
    expect(rig.desk.draft?.fragments).toEqual(['the ferry leaves at seven', 'so we need to be there by six thirty']);
    expect(rig.backend.sends).toHaveLength(0);
  });
});

describe('HttpDeskClient: the pause pill and its taps', () => {
  let server: Server;
  let base = '';
  const posts: Array<{ url: string; token: string | undefined; body: string }> = [];
  beforeEach(async () => {
    posts.length = 0;
    server = createServer((req, res) => {
      if (req.url?.startsWith('/api/desk/stream')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`event: pauseCommand\ndata: ${JSON.stringify({ commandId: 'c1', action: 'resume', pauseId: 'p1', at: 1 })}\n\n`);
        res.write(`event: pauseCommand\ndata: ${JSON.stringify({ commandId: 'c2', action: 'bogus', pauseId: 'p1', at: 1 })}\n\n`);
        return;
      }
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        posts.push({ url: req.url ?? '', token: req.headers['x-tango-collaboration-token'] as string | undefined, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  }));

  it('posts the pill with the token, and hands resume taps (only) to the handler', async () => {
    const client = new HttpDeskClient(base, { collaborationToken: 'test-token' });
    client.publishPause({ id: 'p1', active: true, since: 1, waiting: 2, still: false, updatedAt: 1 });
    const taps: PauseScreenCommand[] = [];
    client.onPauseCommand((command) => taps.push(command));
    client.connect(() => {});
    const pill = () => posts.find((post) => post.url === '/api/desk/pause');
    for (let i = 0; i < 50 && (taps.length === 0 || !pill()); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    client.disconnect();
    expect(pill()).toMatchObject({ token: 'test-token' });
    expect(JSON.parse(pill()!.body)).toMatchObject({ id: 'p1', active: true, waiting: 2 });
    expect(taps).toEqual([{ commandId: 'c1', action: 'resume', pauseId: 'p1', at: 1 }]);
  });
});

describe('pause command after filler and noise (live 10/09)', () => {
  it('"Mm Mm [sniff Yankee, pause" pauses; filler alone never does; mid-sentence mentions still do not', async () => {
    const { matchPauseCommand } = await import('../src/live/pause-mode.js');
    expect(matchPauseCommand('Mm Mm Mm Mm Mm Mm [sniff Yankee, pause')).toBe('pause');
    expect(matchPauseCommand('um uh Yankee, I\'m back')).toBe('resume');
    expect(matchPauseCommand('[breath] Yankee pause')).toBe('pause');
    expect(matchPauseCommand('[BLANK_AUDIO] [background noise] Yankee, pause')).toBe('pause');
    expect(matchPauseCommand('[SOUND] Yankee, I\'m back')).toBe('resume');
    expect(matchPauseCommand('Mm Mm Mm')).toBeNull();
    expect(matchPauseCommand('mm I told Yankee to pause')).toBeNull();
  });
});

describe('room talk during a pause is dropped on resume (live 10/09)', () => {
  it('the resume instructions tell the voice model to ignore everything said while paused', () => {
    expect(PAUSE_OFF_INSTRUCTIONS).toMatch(/room talk, not meant for you/);
    expect(PAUSE_OFF_INSTRUCTIONS).toMatch(/do not answer it, mention it/);
    expect(PAUSE_ON_INSTRUCTIONS).toMatch(/keep nothing of what you hear/);
  });
});
