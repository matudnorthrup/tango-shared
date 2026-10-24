import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulatedAgentBackend, type AgentDescriptor } from '../src/live/agent-backend.js';
import type { DeskCapacity } from '../src/live/desk-client.js';
import type { LiveSessionClient } from '../src/live/gpt-live-client.js';
import { LivePlaybackClock, SpeechActivity } from '../src/live/live-audio.js';
import { capacitySummary, systemSummary, fillRowTarget, fillViewTarget, LiveOperator, repairRouted, matchAllByName } from '../src/live/live-operator.js';
import { buildExtractorPrompt, parseExtractorOutput, type ExtractorInput, type OperatorAction, type TaskExtractor } from '../src/live/task-extractor.js';
import { deskItem, FakeClient, FakeDesk, FakeDeskScreen, LOUD } from './desk-fakes.js';

// New voice coverage on the desk (build order items 7-11, 10/17): single-thread verbs (stop, move to a
// project, reopen, pin, rename, unread, dismiss, undo, where it stands), search, capacity, and a project's
// lifecycle. Each one is an existing desk command or endpoint. Synthetic fixtures only.

const AGENTS: AgentDescriptor[] = [{ id: 'sierra', name: 'Sierra', role: 'research' }];

function setup(actions: OperatorAction[][], options: { desk?: FakeDesk; open?: string } = {}) {
  const client = new FakeClient();
  const seen: ExtractorInput[] = [];
  const extractor: TaskExtractor = async (input) => {
    seen.push(input);
    return actions.shift() ?? [{ type: 'none', reason: 'test' }];
  };
  const desk = options.desk ?? new FakeDesk([]);
  const screen = new FakeDeskScreen();
  if (options.open) screen.presented = { view: 'conversation', itemId: options.open, conversationKey: options.open, sceneId: null };
  const playback = new LivePlaybackClock();
  const userActivity = new SpeechActivity();
  const operator = new LiveOperator({
    client: client as unknown as LiveSessionClient,
    agents: AGENTS,
    backend: new SimulatedAgentBackend({}),
    extractor,
    userActivity,
    playback,
    floor: { settleMs: 1000, speakTimeoutMs: 5000 },
    transcriptSettleMs: 50,
    homeChannelFor: (agentId) => `home-${agentId}`,
    ownerSpeech: { lastAt: Date.now() - 10_000, addressedAt: Date.now() - 10_000 },
    desk,
    screen,
  });
  operator.start();
  const said = () => client.appends.filter((append) => append.kind === 'commentary').map((append) => append.content).join('\n');
  const say = async (id: string, words: string) => {
    client.ask(id, words);
    await vi.advanceTimersByTimeAsync(2500);
  };
  return { client, operator, desk, screen, seen, said, say, playback, userActivity };
}

const sent = (desk: FakeDesk) => desk.commands.map((command) => [command.type, command.itemId, command.args]);

describe('single-thread verbs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(80_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('stop interrupts the turn running in the open thread', async () => {
    const desk = new FakeDesk([deskItem('loom:fix', 'loom', { place: 'tango · Voice fix', facts: { running: true } })]);
    const rig = setup([[{ type: 'desk', op: 'stop' }]], { desk, open: 'loom:fix' });
    await rig.say('d1', 'hold on, cancel what the voice fix is doing');
    expect(sent(desk)).toEqual([['stop', 'loom:fix', {}]]);
    expect(rig.seen[0]!.desk!.items[0]).toMatchObject({ running: true });
    expect(rig.said()).toContain('Stopped the turn');
  });

  it('"stop that" with a running thread open is that thread, without the router; the words after are only the why', async () => {
    const desk = new FakeDesk([deskItem('loom:fix', 'loom', { place: 'tango · Voice fix', facts: { running: true } })]);
    const rig = setup([], { desk, open: 'loom:fix' });
    await rig.say('d1', "stop that thread, it's going the wrong way");
    expect(sent(desk)).toEqual([['stop', 'loom:fix', {}]]);
    expect(rig.seen).toHaveLength(0);
  });

  it('stop on a thread with nothing running says so', async () => {
    const desk = new FakeDesk([deskItem('loom:fix', 'loom', { place: 'tango · Voice fix' })]);
    desk.respond = (command) => (command.type === 'stop' ? { status: 'failed', error: 'nothing is running in this thread' } : { status: 'applied' });
    const rig = setup([[{ type: 'desk', op: 'stop' }]], { desk, open: 'loom:fix' });
    await rig.say('d1', 'stop it');
    expect(rig.said()).toContain('there was nothing to stop');
  });

  it('moves a thread into a project by name, never into a look-alike', async () => {
    const desk = new FakeDesk([deskItem('loom:panel', 'loom', { place: 'tango · Headlight panel' })]);
    desk.projectList = [
      { id: 'bike', name: 'Bike' },
      { id: 'voice', name: 'Tango Voice' },
      { id: 'voice-lab', name: 'Tango Voice Lab' },
    ];
    const rig = setup(
      [
        [{ type: 'desk', op: 'project', item: 'i1', option: 'Bike' }],
        [{ type: 'desk', op: 'project', item: 'i1', option: 'Tango' }],
        [{ type: 'desk', op: 'project', item: 'i1', option: 'Board game' }],
      ],
      { desk },
    );
    await rig.say('d1', 'move the headlight panel thread to the Bike project');
    expect(sent(desk)).toEqual([['project', 'loom:panel', { projectId: 'bike' }]]);
    expect(rig.seen[0]!.desk!.projects).toEqual(['Bike', 'Tango Voice', 'Tango Voice Lab']);
    await rig.say('d2', 'actually put the headlight panel thread under tango');
    expect(rig.said()).toContain('Which project: Tango Voice or Tango Voice Lab?');
    await rig.say('d3', 'put the headlight panel thread in the board game project');
    expect(rig.said()).toContain('There\'s no project called "Board game"');
    expect(desk.commands).toHaveLength(1);
  });

  it('rename, reopen, unread and pin reach their desk commands', async () => {
    const desk = new FakeDesk([deskItem('loom:panel', 'loom', { place: 'Headlight panel' })]);
    const rig = setup([[{ type: 'desk', op: 'rename', message: 'Rear light panel' }]], { desk, open: 'loom:panel' });
    await rig.say('d1', 'rename this to rear light panel');
    await rig.say('d2', 'reopen it');
    await rig.say('d3', 'mark it unread');
    await rig.say('d4', 'pin it');
    await rig.say('d5', 'unpin it');
    expect(sent(desk)).toEqual([
      ['rename', 'loom:panel', { title: 'Rear light panel' }],
      ['reopen', 'loom:panel', {}],
      ['unseen', 'loom:panel', {}],
      ['pin', 'loom:panel', { pinned: true }],
      ['pin', 'loom:panel', { pinned: false }],
    ]);
    // The short ones never waited on the model.
    expect(rig.seen).toHaveLength(1);
  });

  it('"undo that" reverses the last voice change: by its event when the desk recorded one, else the opposite change', async () => {
    const desk = new FakeDesk([deskItem('loom:panel', 'loom', { place: 'Headlight panel' })]);
    desk.respond = (command) => (command.type === 'done' ? { status: 'applied', outcome: { seq: 41 } } : { status: 'applied' });
    const rig = setup([], { desk, open: 'loom:panel' });
    await rig.say('d1', 'mark it done');
    await rig.say('d2', 'undo that');
    expect(sent(desk).slice(-1)).toEqual([['undo', 'loom:panel', { seq: 41 }]]);
    await rig.say('d3', 'pin it');
    await rig.say('d4', 'undo');
    expect(sent(desk).slice(-1)).toEqual([['pin', 'loom:panel', { pinned: false }]]);
    // Nothing left to undo: said so, nothing sent.
    const before = desk.commands.length;
    await rig.say('d5', 'undo that');
    expect(desk.commands).toHaveLength(before);
    expect(rig.seen.at(-1)?.desk?.undoable).toBeUndefined();
  });

  it('undoing a pin that brought a done thread back unpins it and puts it back in History', async () => {
    const desk = new FakeDesk([deskItem('loom:panel', 'loom', { place: 'Headlight panel' })]);
    desk.respond = (command) => (command.type === 'pin' && command.args.pinned === true ? { status: 'applied', outcome: { pinned: true, from: 'done', seq: 77 } } : { status: 'applied' });
    const rig = setup([], { desk, open: 'loom:panel' });
    await rig.say('d1', 'pin it');
    await rig.say('d2', 'undo that');
    expect(sent(desk).slice(1)).toEqual([
      ['pin', 'loom:panel', { pinned: false }],
      ['undo', 'loom:panel', { seq: 77 }],
    ]);
  });

  it('undo never reaches past a change it can\'t reverse, and a no-op pin records nothing', async () => {
    const desk = new FakeDesk([deskItem('loom:panel', 'loom', { place: 'Headlight panel', facts: { pinned: true, projectId: 'card' } })]);
    desk.projectList = [{ id: 'card', name: 'Board game' }];
    // With nothing to undo, "undo that" isn't a quick command: the router hands back undo.
    const rig = setup([[{ type: 'undo' }], [{ type: 'project', op: 'park', project: 'board game' }], [{ type: 'undo' }]], { desk, open: 'loom:panel' });
    await rig.say('d1', 'pin it');
    await rig.say('d2', 'undo that');
    expect(sent(desk)).toEqual([['pin', 'loom:panel', { pinned: true }]]);
    await rig.say('d3', 'unpin it');
    await rig.say('d4', 'park the board game project');
    await rig.say('d5', 'undo that');
    expect(sent(desk).slice(1)).toEqual([['pin', 'loom:panel', { pinned: false }]]);
    expect(rig.said()).toContain("nothing voice changed recently to undo");
  });

  it('the router lists a desk-only rename by its new name', async () => {
    const desk = new FakeDesk([deskItem('discord:thread:1', 'sierra', { place: 'Shed vents', threadId: '000000000000000001', facts: { name: 'Carbon vents' } })]);
    const rig = setup([[{ type: 'none', reason: 'test' }]], { desk });
    await rig.say('d1', 'pin carbon vents');
    expect(rig.seen[0]!.desk!.items[0]!.place).toBe('Carbon vents');
  });

  it('undoing a rename puts back the desk name it had, or none', async () => {
    const desk = new FakeDesk([
      deskItem('discord:thread:1', 'sierra', { place: 'Shed vents', threadId: '000000000000000001', facts: { name: 'Vents' } }),
      deskItem('loom:panel', 'loom', { place: 'tango · Headlight panel' }),
    ]);
    const rig = setup([[{ type: 'desk', op: 'rename', item: 'i1', message: 'Carbon vents' }], [{ type: 'desk', op: 'rename', item: 'i2', message: 'Retainers' }]], { desk });
    await rig.say('d1', 'rename the shed vents thread to carbon vents');
    await rig.say('d2', 'undo that');
    await rig.say('d3', 'rename the headlight thread to retainers');
    await rig.say('d4', 'undo that');
    expect(sent(desk)).toEqual([
      ['rename', 'discord:thread:1', { title: 'Carbon vents' }],
      ['rename', 'discord:thread:1', { title: 'Vents' }],
      ['rename', 'loom:panel', { title: 'Retainers' }],
      ['rename', 'loom:panel', { title: 'Headlight panel' }],
    ]);
  });

  it('dismiss skips only a question Loom lets be skipped', async () => {
    const question = (dismissible: boolean) => ({
      kind: 'question' as const,
      requestId: 'req-1',
      questions: [{ id: 'q', header: '', question: 'Which branch?', options: [{ label: 'main', description: '' }], multiSelect: false }],
      question: 'Which branch?',
      options: ['main'],
      at: 1,
      dismissible,
    });
    const desk = new FakeDesk([
      deskItem('loom:skip', 'loom', { place: 'demo · Skippable', nextStep: 'your_move', facts: { pending: question(true) } }),
      deskItem('loom:must', 'loom', { place: 'demo · Must answer', nextStep: 'your_move', facts: { pending: question(false) } }),
    ]);
    desk.respond = () => ({ status: 'applied', outcome: { seq: 9 } });
    const rig = setup([[{ type: 'desk', op: 'dismiss', item: 'i1' }], [{ type: 'desk', op: 'dismiss', item: 'i2' }]], { desk });
    await rig.say('d1', 'skip the skippable question');
    expect(rig.seen[0]!.desk!.items.map((item) => item.dismissible ?? false)).toEqual([true, false]);
    await rig.say('d2', 'skip the must answer question');
    expect(sent(desk)).toEqual([['dismiss', 'loom:skip', { requestId: 'req-1' }]]);
    // Not something "undo that" can reverse.
    expect(rig.seen.at(-1)?.desk?.undoable).toBeUndefined();
    expect(rig.said()).toContain("can't be skipped");
  });

  const standsCases = [
    ['needs', 'It is waiting on the user.'],
    ['failed', 'Its last turn failed.'],
    ['working', 'Loom is working on it.'],
    ['waiting', 'Waiting on the reviewer.'],
    ['stuck', 'It said it would keep going, but nothing is running.'],
    ['finished', "It's finished: The change is verified."],
    ['idle', 'Nothing is running.'],
    ['unknown', 'Its status is unknown: Source unavailable.'],
  ] as const;
  it('has a spoken behavior case for every non-silent contract pill', () => {
    const contract = JSON.parse(readFileSync(new URL('./fixtures/desk-contract.json', import.meta.url), 'utf8'));
    const spoken = Object.entries(contract.policies.pills as Record<string, { policy: string }>)
      .filter(([, policy]) => policy.policy !== 'silent').map(([pill]) => pill).sort();
    expect(standsCases.map(([pill]) => pill).sort(), 'A new spoken desk pill needs a where-it-stands behavior case, not just a copied union.').toEqual(spoken);
  });
  it.each(standsCases)('where it stands reads the %s pill before contradictory compatibility fields', async (pill, words) => {
    const detail = pill === 'waiting' ? 'Waiting on the reviewer' : pill === 'finished' ? 'The change is verified' : pill === 'unknown' ? 'Source unavailable' : '';
    const desk = new FakeDesk([deskItem('loom:lead', 'loom', { ask: detail, status: { pill, move: 'failed', live: 'failed', busy: null, audience: 'owner', detail } })]);
    const rig = setup([[{ type: 'desk', op: 'stands', item: 'i1' }]], { desk });
    await rig.say('d1', 'where does it stand');
    expect(rig.said()).toContain(words);
    if (pill !== 'failed') expect(rig.said()).not.toContain('last turn failed');
    if (pill !== 'needs') expect(rig.said()).not.toContain('question for the user');
    rig.operator.stop();
  });

  it.each(['waiting', 'needs'] as const)('where it stands leaves a %s lead question with the lead exactly once', async (pill) => {
    const desk = new FakeDesk([deskItem('loom:worker', 'loom', { ask: 'Approve this?', status: { pill, move: null, busy: null, audience: 'lead', detail: 'Waiting on its lead' } })]);
    const rig = setup([[{ type: 'desk', op: 'stands', item: 'loom:worker' }]], { desk });
    await rig.say('d1', 'where does it stand');
    expect(rig.said().match(/Its question is with its lead; nothing for you\./g)).toHaveLength(1);
    expect(rig.said()).not.toContain('question for the user');
    rig.operator.stop();
  });

  it('where it stands reads its card', async () => {
    const desk = new FakeDesk([deskItem('loom:lead', 'loom', { place: 'tango · Tango Voice lead', summary: { gist: 'Coverage items 7 to 11 are in review', milestone: 'Voice coverage' }, status: { move: 'needs', busy: null } })]);
    const rig = setup([[{ type: 'desk', op: 'stands', item: 'i1' }]], { desk });
    await rig.say('d1', 'where does tango voice stand');
    expect(rig.said()).toContain('Coverage items 7 to 11 are in review');
    expect(rig.said()).toContain('waiting on the user');
    expect(desk.commands).toEqual([]);
  });

  it('where it stands speaks a read owner ask before its running turn', async () => {
    const desk = new FakeDesk([deskItem('loom:lead', 'loom', { nextStep: 'working', status: { move: 'ready', busy: 'working', live: 'ready' } })]);
    const rig = setup([[{ type: 'desk', op: 'stands', item: 'i1' }]], { desk });
    await rig.say('d1', 'where does it stand');
    expect(rig.said()).toContain('waiting on the user');
    expect(rig.said()).not.toContain('is working on it');
  });

  it('where it stands does not turn an FYI into an owner ask', async () => {
    const desk = new FakeDesk([deskItem('loom:lead', 'loom', { nextStep: 'fyi', status: { move: null, busy: null, live: 'fyi' } })]);
    const rig = setup([[{ type: 'desk', op: 'stands', item: 'i1' }]], { desk });
    await rig.say('d1', 'where does it stand');
    expect(rig.said()).not.toContain('waiting on the user');
  });

  it('moves a Loom thread to a named account only', async () => {
    const desk = new FakeDesk([deskItem('loom:fix', 'loom', { place: 'tango · Voice fix' }), deskItem('discord:thread:old', 'sierra', { place: 'Old' })]);
    desk.capacityValue = capacity();
    const rig = setup(
      [
        [{ type: 'desk', op: 'account', item: 'i1', option: 'acme account' }],
        [{ type: 'desk', op: 'account', item: 'i1', option: 'pers' }],
        [{ type: 'desk', op: 'account', item: 'i2', option: 'acme' }],
      ],
      { desk },
    );
    await rig.say('d1', 'move the voice fix thread to the acme account');
    expect(desk.moves).toEqual([{ itemId: 'loom:fix', account: 'claudeAgent_work' }]);
    await rig.say('d2', 'move the voice fix thread to pers');
    expect(rig.said()).toContain('Which account');
    await rig.say('d3', 'move the old thread to acme');
    expect(rig.said()).toContain('Only Loom threads move');
    expect(desk.moves).toHaveLength(1);
  });

  it('an account the router shortened is settled by the full name the owner said', async () => {
    const desk = new FakeDesk([deskItem('loom:fix', 'loom', { place: 'tango · Voice fix' })]);
    const base = capacity();
    desk.capacityValue = { ...base, accounts: [{ ...base.accounts[0]!, id: 'claudeAgent_personal', name: 'Acme (Personal)' }, { ...base.accounts[0]!, id: 'claudeAgent_team', name: 'Acme (Team)' }] };
    const rig = setup([[{ type: 'desk', op: 'account', item: 'i1', option: 'acme' }], [{ type: 'desk', op: 'account', item: 'i1', option: 'acme' }]], { desk });
    await rig.say('d1', 'move the voice fix thread to the acme account');
    expect(desk.moves).toEqual([]);
    expect(rig.said()).toContain('Which account: Acme (Personal), Acme (Team)?');
    await rig.say('d2', 'move the voice fix thread to the acme team account');
    expect(desk.moves).toEqual([{ itemId: 'loom:fix', account: 'claudeAgent_team' }]);
  });
});

function capacity(): DeskCapacity {
  return {
    loom: true,
    moves: true,
    accounts: [
      { id: 'claudeAgent_work', name: 'Acme', provider: 'claude', status: 'fresh', fiveHour: { left: 80, resetsAt: null }, weekly: { left: 60, resetsAt: null }, running: 2, idle: 1, threads: [] },
      { id: 'claudeAgent_personal', name: 'Personal', provider: 'claude', status: 'fresh', fiveHour: { left: 15, resetsAt: null }, weekly: { left: 40, resetsAt: null }, running: 1, idle: 0, threads: [] },
      { id: 'claudeAgent_personal2', name: 'Personal 2', provider: 'claude', status: 'fresh', coolingUntil: 90_000_000, fiveHour: { left: 0, resetsAt: null }, weekly: { left: 70, resetsAt: null }, running: 0, idle: 0, threads: [] },
      { id: 'codex', name: 'Codex', provider: 'codex', status: 'none', fiveHour: null, weekly: null, running: 0, idle: 0, threads: [] },
    ],
    machine: { disk: { totalBytes: 1000 * 1024 ** 3, freeBytes: 30 * 1024 ** 3 } },
  };
}

describe('a desk command the voice model did not hand over (live audio test 10/18)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(80_000_000);
  });
  afterEach(() => vi.useRealTimers());

  const running = () => new FakeDesk([deskItem('loom:fix', 'loom', { place: 'tango · Voice fix', facts: { running: true } })]);

  it('"stop that" answered with "Okay." and no delegation still stops the open thread', async () => {
    const desk = running();
    const rig = setup([], { desk, open: 'loom:fix' });
    rig.client.user('Stop that.');
    rig.client.operator('Okay.');
    await vi.advanceTimersByTimeAsync(3000);
    expect(sent(desk)).toEqual([]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(sent(desk)).toEqual([['stop', 'loom:fix', {}]]);
    expect(rig.said()).toContain('Stopped the turn');
  });

  it('"rename this to …" met with silence goes to the router', async () => {
    const desk = new FakeDesk([deskItem('loom:fix', 'loom', { place: 'tango · Voice fix' })]);
    const rig = setup([[{ type: 'desk', op: 'rename', message: 'Kumquat ledger' }]], { desk, open: 'loom:fix' });
    rig.client.user('Rename this to Kumquat ledger.');
    await vi.advanceTimersByTimeAsync(6000);
    expect(rig.seen).toHaveLength(1);
    expect(sent(desk)).toEqual([['rename', 'loom:fix', { title: 'Kumquat ledger' }]]);
  });

  it('a command the voice model delegated, even late, runs once', async () => {
    const desk = running();
    const rig = setup([], { desk, open: 'loom:fix' });
    await rig.say('d1', 'stop that');
    await vi.advanceTimersByTimeAsync(6000);
    expect(sent(desk)).toEqual([['stop', 'loom:fix', {}]]);
    // Routed here first, then delegated by the model: the words are used, so nothing runs again.
    const late = setup([[{ type: 'desk', op: 'pin' }], [{ type: 'desk', op: 'pin' }]], { desk: new FakeDesk([deskItem('loom:fix', 'loom', { place: 'tango · Voice fix' })]), open: 'loom:fix' });
    late.client.user('pin this');
    await vi.advanceTimersByTimeAsync(6000);
    late.client.emit('delegation', { id: 'late', offsetMs: 0, prompt: 'pin this' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(sent(late.desk)).toEqual([['pin', 'loom:fix', { pinned: true }]]);
  });

  it('"stop that" said over the operator is about its speech: no thread is stopped', async () => {
    const desk = running();
    const rig = setup([], { desk, open: 'loom:fix' });
    for (let i = 0; i < 5; i++) rig.playback.enqueue(LOUD);
    rig.client.user('stop that');
    await vi.advanceTimersByTimeAsync(6000);
    expect(sent(desk)).toEqual([]);
  });

  it('a negated command is not one: "don\'t pin this" pins nothing (Codex review on #750)', async () => {
    const desk = new FakeDesk([deskItem('loom:fix', 'loom', { place: 'tango · Voice fix' })]);
    const rig = setup([], { desk, open: 'loom:fix' });
    rig.client.user("Don't pin this.");
    await vi.advanceTimersByTimeAsync(6000);
    expect(sent(desk)).toEqual([]);
  });

  it('a second command soon after a delegated one is still caught (Codex review on #750)', async () => {
    const desk = new FakeDesk([deskItem('loom:fix', 'loom', { place: 'tango · Voice fix', facts: { running: true } })]);
    const rig = setup([[{ type: 'desk', op: 'pin' }]], { desk, open: 'loom:fix' });
    rig.client.user('pin this');
    rig.client.emit('delegation', { id: 'd1', offsetMs: 0, prompt: 'pin this' });
    await vi.advanceTimersByTimeAsync(1500);
    rig.client.user('stop that');
    await vi.advanceTimersByTimeAsync(6000);
    expect(sent(desk)).toEqual([['pin', 'loom:fix', { pinned: true }], ['stop', 'loom:fix', {}]]);
  });

  it('only this utterance counts: an earlier line the voice model answered itself doesn\'t hide a command, and a title may say "not" (Codex review on #750)', async () => {
    const desk = new FakeDesk([deskItem('loom:fix', 'loom', { place: 'tango · Voice fix', facts: { running: true } })]);
    const rig = setup([[{ type: 'desk', op: 'rename', message: 'Do Not Merge' }]], { desk, open: 'loom:fix' });
    rig.client.user('How are you?');
    rig.client.operator('Good, thanks.');
    await vi.advanceTimersByTimeAsync(6000);
    rig.client.user('stop that');
    await vi.advanceTimersByTimeAsync(6000);
    rig.client.user('rename this to Do Not Merge');
    await vi.advanceTimersByTimeAsync(6000);
    expect(sent(desk)).toEqual([['stop', 'loom:fix', {}], ['rename', 'loom:fix', { title: 'Do Not Merge' }]]);
  });

  it('a command right after the operator answered something else is its own utterance (Codex review on #750)', async () => {
    const desk = new FakeDesk([deskItem('loom:fix', 'loom', { place: 'tango · Voice fix' })]);
    const rig = setup([], { desk, open: 'loom:fix' });
    rig.client.user('How are you?');
    await vi.advanceTimersByTimeAsync(800);
    rig.client.operator('Good.');
    await vi.advanceTimersByTimeAsync(800);
    rig.client.user('pin this');
    await vi.advanceTimersByTimeAsync(6000);
    expect(sent(desk)).toEqual([['pin', 'loom:fix', { pinned: true }]]);
  });

  it('a command begun after the operator stopped talking is not over its speech, however soon (Codex review on #750)', async () => {
    const desk = running();
    const rig = setup([], { desk, open: 'loom:fix' });
    rig.playback.enqueue(LOUD); // 100 ms of the operator
    await vi.advanceTimersByTimeAsync(600);
    rig.userActivity.observe(LOUD); // the owner starts half a second after it ended
    rig.client.user('stop that');
    await vi.advanceTimersByTimeAsync(6000);
    expect(sent(desk)).toEqual([['stop', 'loom:fix', {}]]);
  });

  it('"stop that" / "Okay." / "thanks" said quickly still stops: the command is judged on its own (Codex review on #750)', async () => {
    const desk = running();
    const rig = setup([], { desk, open: 'loom:fix' });
    rig.client.user('stop that');
    await vi.advanceTimersByTimeAsync(800);
    rig.client.operator('Okay.');
    await vi.advanceTimersByTimeAsync(1000);
    rig.client.user('thanks');
    await vi.advanceTimersByTimeAsync(6000);
    expect(sent(desk)).toEqual([['stop', 'loom:fix', {}]]);
  });

  it('a conditional or compound request is the router\'s, never acted on by the net (Codex review on #750)', async () => {
    const desk = new FakeDesk([deskItem('loom:fix', 'loom', { place: 'tango · Voice fix' })]);
    const rig = setup([], { desk, open: 'loom:fix' });
    for (const words of ['mark this done after Sierra replies', 'pin this and mark it done', 'move this to Voice once the tests pass']) {
      rig.client.user(words);
      await vi.advanceTimersByTimeAsync(6000);
    }
    expect(sent(desk)).toEqual([]);
    expect(rig.seen).toHaveLength(0);
  });

  it('"don\'t mark it done", delegated, is read by the router: the quick matcher never marks it (live audio test 10/18)', async () => {
    const desk = new FakeDesk([deskItem('loom:fix', 'loom', { place: 'tango · Voice fix' })]);
    const rig = setup([[{ type: 'none', reason: 'the owner said not to' }]], { desk, open: 'loom:fix' });
    await rig.say('d1', "Don't mark it done");
    expect(sent(desk)).toEqual([]);
    expect(rig.seen).toHaveLength(1);
  });

  it('two commands a pause apart, neither delegated, are both caught (Codex review on #750)', async () => {
    const desk = running();
    const rig = setup([], { desk, open: 'loom:fix' });
    rig.client.user('pin this');
    await vi.advanceTimersByTimeAsync(2000);
    rig.client.user('stop that');
    await vi.advanceTimersByTimeAsync(8000);
    expect(sent(desk)).toEqual([['pin', 'loom:fix', { pinned: true }], ['stop', 'loom:fix', {}]]);
  });

  it('a command said while the one before is being routed by the net stays its own (Codex review on #750)', async () => {
    const desk = running();
    const rig = setup([], { desk, open: 'loom:fix' });
    rig.client.user('pin this');
    // The net routes "pin this" at 4 s; "stop that" starts while that routing still settles.
    await vi.advanceTimersByTimeAsync(4100);
    rig.client.user('stop that');
    await vi.advanceTimersByTimeAsync(8000);
    expect(sent(desk)).toEqual([['pin', 'loom:fix', { pinned: true }], ['stop', 'loom:fix', {}]]);
  });

  it('a missed command is not hidden by the voice model delegating the next one (Codex review on #750)', async () => {
    const desk = running();
    // The weather, then the merged "pin this stop that": the router reads both.
    const rig = setup([[{ type: 'none', reason: 'weather' }], [{ type: 'desk', op: 'pin' }, { type: 'desk', op: 'stop' }]], { desk, open: 'loom:fix' });
    // Something slow is being routed, so the missed "pin this" waits; then the model delegates "stop that".
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => (release = resolve));
    const fast = (rig.operator as unknown as { options: { extractor: TaskExtractor } }).options.extractor;
    let first = true;
    (rig.operator as unknown as { options: { extractor: TaskExtractor } }).options.extractor = async (input) => {
      if (first) {
        first = false;
        await slow;
      }
      return fast(input);
    };
    rig.client.ask('d0', 'what is the weather on the coast');
    await vi.advanceTimersByTimeAsync(2000);
    rig.client.user('pin this');
    await vi.advanceTimersByTimeAsync(2000);
    rig.client.ask('d1', 'stop that');
    await vi.advanceTimersByTimeAsync(2000);
    release();
    await vi.advanceTimersByTimeAsync(8000);
    expect(sent(desk).map(([type]) => type).sort()).toEqual(['pin', 'stop']);
  });

  it('a recovered command the router can\'t place is said, not dropped (Codex review on #750)', async () => {
    const desk = new FakeDesk([deskItem('loom:fix', 'loom', { place: 'tango · Voice fix' })]);
    const rig = setup([[{ type: 'none', reason: 'unclear' }]], { desk, open: 'loom:fix' });
    rig.client.user('rename this to Kumquat ledger');
    await vi.advanceTimersByTimeAsync(7000);
    expect(rig.client.appends.map((append) => append.content).join('\n')).toContain('Nothing was sent');
  });

  it('a question about a command is not one: "should I pin this?" pins nothing (Codex review on #750)', async () => {
    const desk = new FakeDesk([deskItem('loom:fix', 'loom', { place: 'tango · Voice fix' })]);
    const rig = setup([], { desk, open: 'loom:fix' });
    for (const words of ['Should I pin this?', 'why would I mark this done', 'I was going to rename this to Kumquat']) {
      rig.client.user(words);
      await vi.advanceTimersByTimeAsync(6000);
    }
    expect(sent(desk)).toEqual([]);
  });

  it('a command heard while another is still being routed is caught once that one is done (Codex review on #750)', async () => {
    const desk = new FakeDesk([deskItem('loom:fix', 'loom', { place: 'tango · Voice fix', facts: { running: true } })]);
    const rig = setup([], { desk, open: 'loom:fix' });
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => (release = resolve));
    // The first request takes the router 10 s; "stop that" is said meanwhile and never delegated.
    (rig.operator as unknown as { options: { extractor: TaskExtractor } }).options.extractor = async () => {
      await slow;
      return [{ type: 'none', reason: 'test' }];
    };
    rig.client.ask('d1', 'what is the weather on the coast');
    await vi.advanceTimersByTimeAsync(2000);
    rig.client.user('stop that');
    await vi.advanceTimersByTimeAsync(8000);
    expect(sent(desk)).toEqual([]);
    release();
    await vi.advanceTimersByTimeAsync(3000);
    expect(sent(desk)).toEqual([['stop', 'loom:fix', {}]]);
  });

  it('talk that is not a desk command is left to the voice model', async () => {
    const desk = running();
    const rig = setup([], { desk, open: 'loom:fix' });
    rig.client.user('I wonder if the kumquats are ripe yet.');
    await vi.advanceTimersByTimeAsync(6000);
    expect(rig.seen).toHaveLength(0);
    expect(sent(desk)).toEqual([]);
  });

  it('opening a Loom thread hands the screens its conversation key', async () => {
    const desk = new FakeDesk([deskItem('loom:fix', 'loom', { place: 'tango · Voice fix' })]);
    const rig = setup([[{ type: 'desk', op: 'open', item: 'i1' }]], { desk });
    await rig.say('d1', 'open the voice fix thread');
    expect(rig.screen.intents.at(-1)).toMatchObject({ view: 'conversation', itemId: 'loom:fix', conversationKey: 'loom:fix' });
  });
});

describe('a List page by voice parks the open thread\'s draft (live audio test 10/18)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(80_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('open a thread, then "show me the capacity page": what is said next is not dictation for that thread', async () => {
    const desk = new FakeDesk([deskItem('loom:b', 'loom', { place: 'tango · Kumquat ledger B' })]);
    const rig = setup([[{ type: 'desk', op: 'open', item: 'i1' }]], { desk });
    // The List reports where it is, so "show me the capacity page" takes the quick route, as live.
    let place: { page: string; view?: string; name: string } = { page: 'inbox', view: 'ready', name: 'Ready' };
    const screen = rig.screen as unknown as { listPage: () => unknown; command: (name: string, args?: Record<string, unknown>) => Promise<boolean>; commands: string[] };
    screen.listPage = () => ({ place, tab: { id: 'ready', name: 'Ready' }, tabs: [], project: null, projects: [], rows: [] });
    screen.command = async (name, args) => {
      screen.commands.push(name);
      if (name === 'list_place' && args?.page === 'capacity') place = { page: 'system', view: 'capacity', name: 'System' };
      return true;
    };
    await rig.say('d1', 'open the kumquat ledger thread');
    const draft = (rig.operator as unknown as { draft: { active: boolean } }).draft;
    expect(draft.active).toBe(true);
    await rig.say('d2', 'show me the capacity page');
    expect(draft.active).toBe(false);
    expect(rig.screen.commands).toContain('list_place');
  });

  it('"back to the list" out of a thread parks its draft too (Codex review on #761)', async () => {
    const desk = new FakeDesk([deskItem('loom:b', 'loom', { place: 'tango · Kumquat ledger B' })]);
    const rig = setup([[{ type: 'desk', op: 'open', item: 'i1' }], [{ type: 'screen', op: 'list_up' }]], { desk });
    const screen = rig.screen as unknown as { listPage: () => unknown };
    screen.listPage = () => ({ place: { page: 'inbox', view: 'ready', name: 'Ready' }, tab: { id: 'ready', name: 'Ready' }, tabs: [], project: null, projects: [], rows: [] });
    await rig.say('d1', 'open the kumquat ledger thread');
    const draft = (rig.operator as unknown as { draft: { active: boolean } }).draft;
    expect(draft.active).toBe(true);
    await rig.say('d2', 'go back');
    expect(rig.screen.commands).toContain('list_back');
    expect(draft.active).toBe(false);
  });

  it('a List move the hub refuses leaves the thread and its draft where they were (Codex review on #761)', async () => {
    const desk = new FakeDesk([deskItem('loom:b', 'loom', { place: 'tango · Kumquat ledger B' })]);
    const rig = setup([[{ type: 'desk', op: 'open', item: 'i1' }], [{ type: 'screen', op: 'list_capacity' }]], { desk });
    const screen = rig.screen as unknown as { listPage: () => unknown; refuse: boolean };
    screen.listPage = () => ({ place: { page: 'inbox', view: 'ready', name: 'Ready' }, tab: { id: 'ready', name: 'Ready' }, tabs: [], project: null, projects: [], rows: [] });
    await rig.say('d1', 'open the kumquat ledger thread');
    const draft = (rig.operator as unknown as { draft: { active: boolean } }).draft;
    expect(draft.active).toBe(true);
    screen.refuse = true;
    await rig.say('d2', 'show me the capacity page');
    expect(draft.active).toBe(true);
  });
});

describe('search, capacity and projects', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(80_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('search reads the top three, and "open the second one" right after opens that one without the router', async () => {
    const desk = new FakeDesk([deskItem('loom:a', 'loom', { place: 'tango · Reconnect bug' })]);
    desk.searchHits = [
      { itemId: 'loom:a', matches: [{ snippet: 'the \u0002reconnect\u0003 loop' }], row: { place: 'tango · Reconnect bug', agentName: 'Loom' } },
      { itemId: 'loom:b', row: { place: 'tango · Voice reconnects', agentName: 'Loom', disposition: 'done' } },
      { itemId: 'discord:gone', row: { place: 'Old reconnect notes', agentName: 'Sierra', archived: true } },
      { itemId: 'loom:d', row: { place: 'Fourth', agentName: 'Loom' } },
    ];
    const rig = setup([[{ type: 'search', query: 'reconnect bug' }]], { desk });
    await rig.say('d1', 'find the thread about the reconnect bug');
    expect(desk.searches).toEqual(['reconnect bug']);
    expect(rig.said()).toContain('1. tango · Reconnect bug (Loom): "the reconnect loop"');
    expect(rig.said()).toContain('2. tango · Voice reconnects (Loom), done');
    expect(rig.said()).toContain('3. Old reconnect notes (Sierra), archived');
    expect(rig.said()).not.toContain('Fourth');
    await rig.say('d2', 'open the second one');
    expect(rig.screen.intents.at(-1)).toMatchObject({ view: 'conversation', itemId: 'loom:b' });
    expect(rig.seen).toHaveLength(1);
    // An archived hit is read from search's transcript: it has no conversation to open (Codex review on #717).
    desk.transcripts.set('discord:gone', [{ author: 'agent', text: 'The reconnect loop came from a stale token.', at: 1 }]);
    await rig.say('d2b', 'reopen the third one');
    expect(rig.said()).toContain('Old reconnect notes is archived');
    expect(rig.screen.intents.filter((intent) => intent.itemId === 'discord:gone')).toEqual([]);
    expect(desk.commands.filter((command) => command.itemId === 'discord:gone')).toEqual([]);
    // The router sees the hits by handle, so a desk op can name one.
    await rig.say('d3', 'reopen the second one');
    expect(sent(desk).slice(-1)).toEqual([['reopen', 'loom:b', {}]]);
  });

  it.each(['old', 'card'])('undoing a project move from %s restores the previous reporting conversation', async (before) => {
    const desk = new FakeDesk([deskItem('loom:a', 'loom', { place: 'tango · A', facts: { projectId: before } })]);
    desk.projectList = [{ id: 'card', name: 'Board game' }];
    desk.respond = () => ({ status: 'applied', outcome: { parentItemId: 'loom:new', previousParentItemId: 'loom:owner' } });
    const rig = setup([[{ type: 'desk', op: 'project', item: 'i1', option: 'Board game' }], [{ type: 'undo' }]], { desk });
    await rig.say('d1', 'move the a thread to the board game project');
    await rig.say('d2', 'undo that');
    expect(sent(desk)).toEqual([
      ['project', 'loom:a', { projectId: 'card' }],
      ['project', 'loom:a', { projectId: before, parentItemId: 'loom:owner' }],
    ]);
  });

  it('a failed search drops the last one\'s hits; a move into the project it is already in records no undo', async () => {
    const desk = new FakeDesk([deskItem('loom:a', 'loom', { place: 'tango · A', facts: { projectId: 'card' } })]);
    desk.projectList = [{ id: 'card', name: 'Board game' }];
    desk.searchHits = [{ itemId: 'loom:hit1', row: { place: 'Hit one', agentName: 'Loom' } }, { itemId: 'loom:hit2', row: { place: 'Hit two', agentName: 'Loom' } }];
    const rig = setup([[{ type: 'search', query: 'x' }], [{ type: 'search', query: 'y' }], [{ type: 'screen', op: 'open_row', target: '1' }], [{ type: 'desk', op: 'project', item: 'i1', option: 'Board game' }], [{ type: 'undo' }]], { desk });
    await rig.say('d1', 'search for x');
    desk.searchHits = null;
    await rig.say('d2', 'search for y');
    await rig.say('d3', 'open the first one');
    expect(rig.screen.intents.filter((intent) => intent.itemId === 'loom:hit1')).toEqual([]);
    await rig.say('d4', 'move the a thread to the board game project');
    await rig.say('d5', 'undo that');
    expect(sent(desk)).toEqual([['project', 'loom:a', { projectId: 'card' }]]);
  });

  it('a search ends when the owner moves on: "the first one" is the screen\'s again', async () => {
    const desk = new FakeDesk([deskItem('loom:a', 'loom', { place: 'tango · A' })]);
    desk.searchHits = [{ itemId: 'loom:hit1', row: { place: 'Hit one', agentName: 'Loom' } }, { itemId: 'loom:hit2', row: { place: 'Hit two', agentName: 'Loom' } }];
    const rig = setup([[{ type: 'search', query: 'x' }], [{ type: 'screen', op: 'open_row', target: '1' }]], { desk });
    await rig.say('d1', 'search for x');
    await rig.say('d2', 'show the board');
    await rig.say('d3', 'open the first one');
    expect(rig.screen.intents.filter((intent) => intent.itemId === 'loom:hit1')).toEqual([]);
    expect(rig.seen).toHaveLength(2);
  });

  it('capacity is one or two spoken sentences: the tightest account, the week, a low disk', async () => {
    const text = capacitySummary(capacity(), 80_000_000);
    expect(text).toContain('Tightest account: Personal 2, 0% of its five-hour window and 70% of its week left.');
    expect(text).toContain('57% of the week is left on average');
    expect(text).toContain('Personal 2 is resting after a limit.');
    expect(text).toContain('3 threads running now.');
    expect(text).toContain('Disk is low: 30 GB free.');
    // The average counts only the accounts with a weekly reading.
    const mixed = capacity();
    mixed.accounts = [...mixed.accounts.slice(0, 2), { ...mixed.accounts[2]!, coolingUntil: null, weekly: null }];
    expect(capacitySummary(mixed, 80_000_000)).toContain('Across 2 Claude accounts, 50% of the week');
    // A window without a reading is left out, never spoken as full.
    const partial = capacity();
    partial.accounts = [{ ...partial.accounts[1]!, weekly: null }];
    expect(capacitySummary(partial, 80_000_000)).toContain('Tightest account: Personal, 15% of its five-hour window left.');
    const desk = new FakeDesk([]);
    desk.capacityValue = capacity();
    const rig = setup([[{ type: 'capacity' }]], { desk });
    await rig.say('d1', "how's capacity");
    expect(rig.said()).toContain('Tightest account: Personal 2');
  });

  it('"what\'s broken?" says the System page\'s line and its open incidents, critical first', async () => {
    const brief = { line: '1 critical problem needs you, and 7 more are open. The other 81 jobs ran as expected.', critical: ['Health pull failing'], open: ['A', 'B', 'C', 'D', 'E', 'F', 'G'], error: null };
    expect(systemSummary(brief)).toBe('1 critical problem needs you, and 7 more are open. The other 81 jobs ran as expected. Critical: Health pull failing. Also open: A; B; C; D; E, and 2 more.');
    expect(systemSummary({ line: 'All clear. 90 jobs ran as expected.', critical: [], open: [], error: null })).toBe('All clear. 90 jobs ran as expected.');
    const desk = new FakeDesk([]);
    desk.systemValue = brief;
    const rig = setup([[{ type: 'system' }]], { desk });
    await rig.say('d1', "what's broken?");
    expect(rig.said()).toContain('Critical: Health pull failing.');
    const none = setup([[{ type: 'system' }]], { desk: new FakeDesk([]) });
    await none.say('d2', "what's broken?");
    expect(none.said()).toContain("The System page isn't available");
  });

  it('a project snoozes, parks and wakes by name; finish asks first and goes on a yes', async () => {
    const desk = new FakeDesk([deskItem('loom:a', 'loom', { facts: { projectId: 'card' } }), deskItem('loom:b', 'loom', { facts: { projectId: 'card' } })]);
    // Finish closes the parked one too, though the Inbox doesn't list it (Codex review on #717).
    desk.members = [...desk.list, deskItem('loom:parked', 'loom', { disposition: 'parked', facts: { projectId: 'card' } }), deskItem('loom:done', 'loom', { disposition: 'done', facts: { projectId: 'card' } }), deskItem('loom:busy', 'loom', { nextStep: 'working', facts: { projectId: 'card' } })];
    desk.projectList = [
      { id: 'card', name: 'Board game' },
      { id: 'bike', name: 'Bike' },
    ];
    const rig = setup(
      [
        [{ type: 'project', op: 'snooze', project: 'board game', until: '2026-10-19T09:00:00-07:00' }],
        [{ type: 'project', op: 'park', project: 'Bike' }],
        [{ type: 'project', op: 'wake', project: 'Bike' }],
        [{ type: 'project', op: 'finish', project: 'the board game' }],
      ],
      { desk },
    );
    await rig.say('d1', 'snooze the board game project until monday morning');
    await rig.say('d2', 'park the bike project');
    await rig.say('d3', 'wake up bike');
    expect(desk.projectActions).toEqual([
      { projectId: 'card', action: { action: 'snooze', until: '2026-10-19T09:00:00-07:00' } },
      { projectId: 'bike', action: { action: 'park' } },
      { projectId: 'bike', action: { action: 'wake' } },
    ]);
    await rig.say('d4', 'finish the board game project');
    expect(rig.said()).toContain('Finish Board game? That marks its 3 open threads (one still running stays open) done, snoozed and parked ones too.');
    expect(desk.projectActions).toHaveLength(3);
    await rig.say('d5', 'yes');
    expect(desk.projectActions.at(-1)).toEqual({ projectId: 'card', action: { action: 'finish' } });
    expect(rig.said()).toContain('Finished Board game: 3 threads marked done');
  });

  it('a qualified yes never finishes a project: it goes to the router', async () => {
    const desk = new FakeDesk([]);
    desk.projectList = [{ id: 'card', name: 'Board game' }];
    const rig = setup([[{ type: 'project', op: 'finish', project: 'board game' }]], { desk });
    await rig.say('d1', 'finish the board game');
    await rig.say('d2', 'yes, but not yet');
    expect(desk.projectActions).toEqual([]);
    expect(rig.seen).toHaveLength(2);
    // The confirm bound only that answer: a later yes doesn't reach back to it.
    await rig.say('d3', 'yes, go ahead');
    expect(desk.projectActions).toEqual([]);
  });

  it('a project action the desk is slow to answer is never called a failure', async () => {
    const desk = new FakeDesk([]);
    desk.projectList = [{ id: 'card', name: 'Board game' }];
    desk.projectAction = () => new Promise(() => {});
    const rig = setup([[{ type: 'project', op: 'park', project: 'board game' }]], { desk });
    rig.client.ask('d1', 'park the board game project');
    await vi.advanceTimersByTimeAsync(70_000);
    expect(rig.said()).toContain('it may still have gone through');
    expect(rig.said()).not.toContain("didn't go through");
  });

  it('search reads a desk-only rename as the title', async () => {
    const desk = new FakeDesk([]);
    desk.searchHits = [{ itemId: 'discord:thread:1', row: { place: 'Shed vents', agentName: 'Sierra', facts: { name: 'Carbon vents' } } }];
    const rig = setup([[{ type: 'search', query: 'carbon vents' }]], { desk });
    await rig.say('d1', 'find carbon vents');
    expect(rig.said()).toContain('1. Carbon vents (Sierra)');
  });

  it('a finish the owner calls off changes nothing', async () => {
    const desk = new FakeDesk([]);
    desk.projectList = [{ id: 'card', name: 'Board game' }];
    const rig = setup([[{ type: 'project', op: 'finish', project: 'board game' }]], { desk });
    await rig.say('d1', 'finish the board game');
    await rig.say('d2', 'no');
    await rig.say('d3', 'yes');
    expect(desk.projectActions).toEqual([]);
  });
});

describe('the router for the new coverage', () => {
  it('parses search, capacity, project and undo', () => {
    const fields = { agent_id: '', task_id: '', thread_id: '', new_thread_title: '', thread_options: [], screen_op: '', desk_op: '', item: '', message: '', option: '', until: '', trigger: '', stop_job: '', decision: '', answers: [], approval: '', draft_op: '', next_op: '', project_op: '' };
    const raw = JSON.stringify({
      addressed: 'yes',
      actions: [
        { ...fields, type: 'search', message: ' reconnect bug ' },
        { ...fields, type: 'capacity' },
        { ...fields, type: 'project', project_op: 'snooze', option: 'Board game', trigger: 'desk' },
        { ...fields, type: 'project', project_op: 'finish', option: '' },
        { ...fields, type: 'undo' },
        { ...fields, type: 'desk', desk_op: 'rename', item: 'i1', message: 'Shed vents' },
        { ...fields, type: 'screen', screen_op: 'list_capacity' },
        { ...fields, type: 'system' },
        { ...fields, type: 'screen', screen_op: 'list_system' },
      ],
    });
    expect(parseExtractorOutput(raw)).toEqual([
      { type: 'search', query: 'reconnect bug' },
      { type: 'capacity' },
      { type: 'project', op: 'snooze', project: 'Board game', trigger: 'desk' },
      { type: 'none', reason: 'unclear project action "finish" on ""' },
      { type: 'undo' },
      { type: 'desk', op: 'rename', item: 'i1', message: 'Shed vents' },
      { type: 'screen', op: 'list_capacity' },
      { type: 'system' },
      { type: 'screen', op: 'list_system' },
    ]);
  });

  it('lists what the new verbs need: pins, running turns, projects, search hits, the last change', () => {
    const prompt = buildExtractorPrompt({
      agents: AGENTS,
      tasks: [],
      transcript: [],
      latestUserSpeech: 'x',
      desk: {
        items: [{ handle: 'i1', agentName: 'Loom', place: 'tango · Voice fix', step: 'working', line: 'fixing', threadId: null, pinned: true, running: true }],
        searchHits: [{ handle: 'h1', title: 'Old notes', agentName: 'Sierra', archived: true, done: true }],
        projects: ['Board game'],
        undoable: 'Pinned: Loom (tango · Voice fix)',
      },
    });
    expect(prompt).toContain('- i1: Loom · "tango · Voice fix" [working] [pinned] [running]: fixing');
    expect(prompt).toContain('- h1: Sierra · "Old notes" (archived: it can only be read)');
    expect(prompt).toContain('Projects (spaces): "Board game"');
    expect(prompt).toContain('what "undo that" reverses): Pinned');
    for (const op of ['desk_op stop', 'desk_op project', 'desk_op reopen', 'desk_op pin', 'desk_op rename', 'desk_op unseen', 'desk_op stands', 'desk_op account', 'undo (type undo)', 'search with message', 'capacity:', 'project with project_op']) expect(prompt).toContain(op);
  });

  it('an open_row the router left blank takes its position from the speech', () => {
    expect(fillRowTarget('open the first one', [{ type: 'screen', op: 'open_row' }])).toEqual([{ type: 'screen', op: 'open_row', target: 'first' }]);
    expect(fillRowTarget('open number three', [{ type: 'screen', op: 'open_row' }])).toEqual([{ type: 'screen', op: 'open_row', target: 'three' }]);
    expect(fillRowTarget('open the second one', [{ type: 'screen', op: 'open_row', target: '4' }])).toEqual([{ type: 'screen', op: 'open_row', target: '4' }]);
    expect(fillRowTarget('open the speaker one', [{ type: 'screen', op: 'open_row' }])).toEqual([{ type: 'screen', op: 'open_row' }]);
  });

  it('repairs two router slips: a reply on a desk handle, and a compound open that lost its row', () => {
    const handles = new Map([['i3', 'loom:a']]);
    expect(repairRouted('tell the a thread hi', [{ type: 'reply', taskId: 'i3', message: 'hi' }], new Set(), handles)).toEqual([{ type: 'desk', op: 'reply', item: 'i3', message: 'hi' }]);
    expect(repairRouted('yes', [{ type: 'reply', taskId: 't1', message: 'yes' }], new Set(['t1']), handles)).toEqual([{ type: 'reply', taskId: 't1', message: 'yes' }]);
    expect(repairRouted('show me Watching and open the second one', [{ type: 'screen', op: 'list_tab', target: 'Watching' }], new Set(), handles)).toEqual([
      { type: 'screen', op: 'list_tab', target: 'Watching' },
      { type: 'screen', op: 'open_row', target: 'second' },
    ]);
  });

  it('a list_tab or list_view the router left blank takes the one name the speech says', () => {
    const list = { tabs: [{ name: 'Top', count: 1 }, { name: 'Watching', count: 2 }], views: [{ name: 'Overview', count: 3 }, { name: 'Jobs', count: 1 }] };
    expect(fillViewTarget('show me the jobs', [{ type: 'screen', op: 'list_view' }], list as never)).toEqual([{ type: 'screen', op: 'list_view', target: 'Jobs' }]);
    expect(fillViewTarget('go to watching', [{ type: 'screen', op: 'list_tab' }], list as never)).toEqual([{ type: 'screen', op: 'list_tab', target: 'Watching' }]);
    expect(fillViewTarget('show me that', [{ type: 'screen', op: 'list_view' }], list as never)).toEqual([{ type: 'screen', op: 'list_view' }]);
  });

  it('after a long quiet, "mark it done" with nothing on screen or discussed asks "For me?" even when the router names no item', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(80_000_000);
    const desk = new FakeDesk([deskItem('loom:a', 'loom', { place: 'tango · A' })]);
    const client = new FakeClient();
    const operator = new LiveOperator({
      client: client as unknown as LiveSessionClient,
      agents: AGENTS,
      backend: new SimulatedAgentBackend({}),
      extractor: async () => [{ type: 'desk', op: 'done' }],
      userActivity: new SpeechActivity(),
      playback: new LivePlaybackClock(),
      floor: { settleMs: 1000, speakTimeoutMs: 5000 },
      transcriptSettleMs: 50,
      homeChannelFor: (agentId) => `home-${agentId}`,
      ownerSpeech: { lastAt: Date.now() - 5 * 60_000, addressedAt: Date.now() - 5 * 60_000 },
      desk,
      screen: new FakeDeskScreen(),
    });
    operator.start();
    client.ask('d1', 'mark it done');
    await vi.advanceTimersByTimeAsync(2500);
    expect(client.appends.map((append) => append.content).join('\n')).toContain('Ask only: "For me?"');
    expect(desk.commands).toEqual([]);
    vi.useRealTimers();
  });

  it('matches a spoken name at the best tier only, so look-alikes ask', () => {
    const names = ['Tango Voice', 'Tango Voice Lab', 'Bike'];
    expect(matchAllByName(names, (name) => name, 'tango voice')).toEqual(['Tango Voice']);
    expect(matchAllByName(names, (name) => name, 'the tango project')).toEqual(['Tango Voice', 'Tango Voice Lab']);
    expect(matchAllByName(names, (name) => name, 'board game')).toEqual([]);
    expect(matchAllByName(names, (name) => name, '')).toEqual([]);
  });
});
