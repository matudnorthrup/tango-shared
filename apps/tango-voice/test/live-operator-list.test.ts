import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulatedAgentBackend, type AgentDescriptor } from '../src/live/agent-backend.js';
import type { LiveSessionClient } from '../src/live/gpt-live-client.js';
import { LivePlaybackClock, SpeechActivity } from '../src/live/live-audio.js';
import { LiveOperator, matchByName, rowIndex, stepLabel } from '../src/live/live-operator.js';
import type { ListPage } from '../src/live/screen-director.js';
import { buildExtractorPrompt, parseExtractorOutput, type ExtractorInput, type OperatorAction, type TaskExtractor } from '../src/live/task-extractor.js';
import { deskItem, FakeClient, FakeDesk, FakeDeskScreen } from './desk-fakes.js';

// The List (the desk's home) by voice: tabs, rows by number or name, projects and the breadcrumb
// back out of one. Synthetic fixtures only.

const AGENTS: AgentDescriptor[] = [{ id: 'sierra', name: 'Sierra', role: 'research' }];

const TABS = [
  { id: 'active', name: 'Active', count: 3 },
  { id: 'watching', name: 'Watching', count: 2 },
  { id: 'snoozed', name: 'Snoozed', count: 1 },
];
const ROWS: Record<string, ListPage['rows']> = {
  active: [
    { kind: 'project', id: 'garden-k1', title: 'Garden shed', where: 'project' },
    { kind: 'item', id: 'loom:thread-a', title: 'Onboarding copy', where: 'tango' },
    { kind: 'item', id: 'sierra:t1', title: 'Shed vents', where: 'Sierra' },
  ],
  watching: [
    { kind: 'item', id: 'loom:thread-b', title: 'Release notes', where: 'tango' },
    { kind: 'item', id: 'loom:thread-c', title: 'Fix the flaky test', where: 'tango' },
  ],
  inside: [{ kind: 'item', id: 'loom:thread-d', title: 'Order lumber', where: 'tango' }],
};

/** A screen whose List reports back right away when a command moves it, as the desk does. */
class ListScreen extends FakeDeskScreen {
  sent: Array<{ name: string; args?: Record<string, unknown> }> = [];
  list: ListPage = { tab: { id: 'active', name: 'Active' }, tabs: TABS, project: null, projects: [{ id: 'garden-k1', name: 'Garden shed' }], rows: ROWS.active! };
  override async command(name: string, args?: Record<string, unknown>) {
    this.sent.push({ name, ...(args ? { args } : {}) });
    if (name === 'list_tab') {
      const tab = TABS.find((candidate) => candidate.id === args?.tab)!;
      this.list = { ...this.list, tab: { id: tab.id, name: tab.name }, rows: ROWS[tab.id] ?? [] };
    } else if (name === 'list_project') {
      const project = args?.project ? { id: String(args.project), name: 'Garden shed' } : null;
      this.list = { ...this.list, project, rows: project ? ROWS.inside! : ROWS.active! };
    }
    return true;
  }
  listPage() {
    return this.list;
  }
  async waitForList(test: (page: ListPage) => boolean) {
    return test(this.list) ? this.list : null;
  }
}

function setup(actions: OperatorAction[][], screen = new ListScreen()) {
  const client = new FakeClient();
  const seen: ExtractorInput[] = [];
  const extractor: TaskExtractor = async (input) => {
    seen.push(input);
    return actions.shift() ?? [{ type: 'none', reason: 'test' }];
  };
  const desk = new FakeDesk([
    deskItem('loom:thread-a', 'loom', { place: 'tango · Onboarding copy', nextStep: 'your_move' }),
    deskItem('loom:thread-c', 'loom', { place: 'tango · Fix the flaky test', nextStep: 'your_move' }),
  ]);
  const operator = new LiveOperator({
    client: client as unknown as LiveSessionClient,
    agents: AGENTS,
    backend: new SimulatedAgentBackend({}),
    extractor,
    userActivity: new SpeechActivity(),
    playback: new LivePlaybackClock(),
    floor: { settleMs: 1000, speakTimeoutMs: 5000 },
    transcriptSettleMs: 50,
    desk,
    screen,
  });
  operator.start();
  return { client, operator, screen, seen };
}

const said = (client: FakeClient) => client.appends.filter((append) => append.kind === 'commentary').map((append) => append.content).join('\n');

describe('rowIndex', () => {
  it('reads numbers, ordinals and ends of the list', () => {
    expect(rowIndex('3', 5)).toBe(2);
    expect(rowIndex('third', 5)).toBe(2);
    expect(rowIndex('the third one', 5)).toBe(2);
    expect(rowIndex('number two', 5)).toBe(1);
    expect(rowIndex('2nd', 5)).toBe(1);
    expect(rowIndex('top', 5)).toBe(0);
    expect(rowIndex('the last one', 5)).toBe(4);
    expect(rowIndex('second to last', 5)).toBe(3);
  });
  it('is null for words that are not a position, or past the end', () => {
    expect(rowIndex('Shed vents', 5)).toBeNull();
    expect(rowIndex('9', 5)).toBeNull();
    expect(rowIndex('', 5)).toBeNull();
  });
});

describe('matchByName', () => {
  const tabs = [{ name: 'Active' }, { name: 'Watching' }, { name: 'Waiting on review' }];
  it('exact, then starts-with, then contains; "tab" and "the" are ignored', () => {
    expect(matchByName(tabs, (tab) => tab.name, 'the Watching tab')?.name).toBe('Watching');
    expect(matchByName(tabs, (tab) => tab.name, 'waiting')?.name).toBe('Waiting on review');
    expect(matchByName(tabs, (tab) => tab.name, 'review')?.name).toBe('Waiting on review');
    expect(matchByName(tabs, (tab) => tab.name, 'History')).toBeUndefined();
  });
});

describe('the List by voice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(80_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('opens the System page, and Capacity on its Capacity tab', async () => {
    const screen = new ListScreen();
    screen.list = { ...screen.list, place: { page: 'inbox', view: 'top', name: 'Top' } };
    screen.command = async (name, args) => {
      screen.sent.push({ name, args });
      // The desk lands Capacity on the System page (nav.js placeRoute).
      if (name === 'list_place') screen.list = { ...screen.list, place: { page: 'system' as 'inbox', view: args?.page === 'capacity' ? 'capacity' : 'overview', name: 'System' } };
      return true;
    };
    const rig = setup([[{ type: 'screen', op: 'list_system' }], [{ type: 'screen', op: 'list_capacity' }]], screen);
    for (const [i, words] of ['show the system page', 'open capacity'].entries()) {
      rig.client.ask(`sys-${i}`, words);
      await vi.advanceTimersByTimeAsync(2500);
    }
    expect(screen.sent).toEqual([
      { name: 'list_place', args: { page: 'system' } },
      { name: 'list_place', args: { page: 'capacity' } },
    ]);
    expect(screen.list.place).toMatchObject({ page: 'system', view: 'capacity' });
  });

  it('Capacity is its tab: another System tab already up is not it (Codex review on #747)', async () => {
    const screen = new ListScreen();
    screen.list = { ...screen.list, place: { page: 'system', view: 'jobs', name: 'System' } };
    // The screens never take the command: the List stays on System › Jobs.
    screen.command = async (name, args) => {
      screen.sent.push({ name, args });
      return true;
    };
    const rig = setup([[{ type: 'screen', op: 'list_capacity' }]], screen);
    rig.client.ask('cap', 'open capacity');
    await vi.advanceTimersByTimeAsync(2500);
    expect(rig.client.appends.map((append) => append.content).join('\n')).toContain("didn't switch to capacity");
  });

  it('opens next indexes and agent rows, then goes back to the same place from a thread', async () => {
    const screen = new ListScreen();
    screen.list = { ...screen.list, place: { page: 'agents', name: 'Agents' }, agents: [{ id: 'sierra', name: 'Sierra' }], rows: [{ kind: 'agent', id: 'sierra', title: 'Sierra', where: 'agent' }] };
    screen.command = async (name, args) => {
      screen.sent.push({ name, args });
      if (name === 'list_place') screen.list = { ...screen.list, place: { page: args?.page as 'agent', id: args?.id as string, name: 'Sierra' } };
      if (name === 'list_back') screen.presented = { view: 'active', itemId: null, conversationKey: null, sceneId: null };
      return true;
    };
    const rig = setup([[{ type: 'screen', op: 'open_row', target: '1' }], [{ type: 'screen', op: 'list_projects' }], [{ type: 'screen', op: 'list_agents' }], [{ type: 'screen', op: 'list_agent', target: 'Sierra' }], [{ type: 'screen', op: 'list_up' }]], screen);
    for (const [i, words] of ['open the first one', 'projects', 'agents', 'open Sierra', 'back to the list'].entries()) {
      if (i === 4) screen.presented = { view: 'conversation', itemId: 'sierra:t1', conversationKey: 'sierra:t1', sceneId: null };
      rig.client.ask(`next-${i}`, words);
      await vi.advanceTimersByTimeAsync(2500);
    }
    expect(screen.sent).toEqual([
      { name: 'list_place', args: { page: 'agent', id: 'sierra' } },
      { name: 'list_place', args: { page: 'projects' } },
      { name: 'list_place', args: { page: 'agents' } },
      { name: 'list_place', args: { page: 'agent', id: 'sierra' } },
      { name: 'list_back', args: undefined },
    ]);
    expect(screen.list.place?.id).toBe('sierra');
    expect(screen.presented.view).toBe('active');
  });

  it('a scene over the next layout comes down to the List before any place moves (Codex review on #626)', async () => {
    const screen = new ListScreen();
    screen.list = { ...screen.list, place: { page: 'project', name: 'Ferry' } };
    screen.presented = { view: 'scene', itemId: null, conversationKey: null, sceneId: 's1' };
    const rig = setup([[{ type: 'screen', op: 'board' }], [{ type: 'screen', op: 'list_up' }]], screen);
    for (const [i, words] of ['show the list', 'back'].entries()) {
      if (i === 1) screen.presented = { view: 'scene', itemId: null, conversationKey: null, sceneId: 's1' };
      rig.client.ask(`scene-${i}`, words);
      await vi.advanceTimersByTimeAsync(2500);
    }
    expect(screen.sent.filter((c) => c.name === 'list_back')).toEqual([]);
    expect(screen.presented.view).toBe('active');
  });

  it('"go back" from a thread\'s screen returns to that thread', async () => {
    const screen = new ListScreen();
    screen.list = { ...screen.list, place: { page: 'inbox', name: 'Needs you' } };
    screen.presented = { view: 'scene', itemId: 'sierra:t1', conversationKey: 'sierra:t1', sceneId: 's1' };
    const rig = setup([[{ type: 'screen', op: 'list_up' }]], screen);
    rig.client.ask('stage-back', 'go back');
    await vi.advanceTimersByTimeAsync(2500);
    expect(screen.sent).toEqual([]);
    expect(screen.presented).toMatchObject({ view: 'conversation', itemId: 'sierra:t1' });
  });

  it('the router sees the tabs, the projects and the rows numbered, and the List ops', async () => {
    const rig = setup([[{ type: 'none', reason: 'x' }]]);
    rig.client.ask('d1', 'what is on the list');
    await vi.advanceTimersByTimeAsync(2500);
    const input = rig.seen[0]!;
    expect(input.screen?.list).toMatchObject({ showing: true, tab: 'Active', project: null, projects: ['Garden shed'] });
    const prompt = buildExtractorPrompt(input);
    expect(prompt).toContain('The desk\'s page is on screen: Inbox tab "Active".');
    expect(prompt).toContain('Inbox tabs: "Active" (3), "Watching" (2), "Snoozed" (1)');
    expect(prompt).toContain('  1. project "Garden shed"');
    expect(prompt).toContain('  3. "Shed vents" (Sierra)');
    expect(prompt).toContain('screen_op list_tab');
    expect(prompt).toContain('screen_op open_row');
    expect(prompt).toContain('screen_op list_up');
  });

  it('the router\'s List ops carry their target', () => {
    const parsed = parseExtractorOutput(
      JSON.stringify({
        addressed: 'yes',
        actions: [
          { type: 'screen', screen_op: 'list_tab', option: 'Watching' },
          { type: 'screen', screen_op: 'open_row', option: '2' },
          { type: 'screen', screen_op: 'list_project', option: 'Garden shed' },
          { type: 'screen', screen_op: 'list_up' },
          { type: 'screen', screen_op: 'list_projects' },
          { type: 'screen', screen_op: 'list_agents' },
          { type: 'screen', screen_op: 'list_agent', option: 'Sierra' },
        ],
      }),
    );
    expect(parsed).toEqual([
      { type: 'screen', op: 'list_tab', target: 'Watching' },
      { type: 'screen', op: 'open_row', target: '2' },
      { type: 'screen', op: 'list_project', target: 'Garden shed' },
      { type: 'screen', op: 'list_up' },
      { type: 'screen', op: 'list_projects' },
      { type: 'screen', op: 'list_agents' },
      { type: 'screen', op: 'list_agent', target: 'Sierra' },
    ]);
  });

  it('"show me Watching, open the second one": the tab changes, then the second row there opens', async () => {
    const rig = setup([
      [
        { type: 'screen', op: 'list_tab', target: 'watching' },
        { type: 'screen', op: 'open_row', target: '2' },
      ],
    ]);
    rig.client.ask('d1', 'show me Watching and open the second one');
    await vi.advanceTimersByTimeAsync(2500);
    expect(rig.screen.sent[0]).toEqual({ name: 'list_tab', args: { tab: 'watching' } });
    expect(rig.screen.intents.at(-1)).toMatchObject({ view: 'conversation', itemId: 'loom:thread-c', reason: 'user' });
    expect(said(rig.client)).toContain('Fix the flaky test is open on the screen');
  });

  it('a tab switch from a conversation brings the List back up first', async () => {
    const screen = new ListScreen();
    screen.presented = { view: 'conversation', itemId: 'loom:thread-a', conversationKey: 'loom:thread-a', sceneId: null };
    const rig = setup([[{ type: 'screen', op: 'list_tab', target: 'Snoozed' }]], screen);
    rig.client.ask('d1', 'go to the snoozed tab');
    await vi.advanceTimersByTimeAsync(2500);
    expect(screen.intents.at(-1)).toMatchObject({ view: 'active', reason: 'user' });
    expect(screen.sent.at(-1)).toEqual({ name: 'list_tab', args: { tab: 'snoozed' } });
  });

  it('an unknown tab is said, with the tabs there are', async () => {
    const rig = setup([[{ type: 'screen', op: 'list_tab', target: 'History' }]]);
    rig.client.ask('d1', 'show me history');
    await vi.advanceTimersByTimeAsync(2500);
    expect(rig.screen.sent).toEqual([]);
    expect(said(rig.client)).toContain('There\'s no "History" tab. The tabs are "Active", "Watching", "Snoozed".');
  });

  it('a row by its words; a project row opens the project; "back to the list" leaves it', async () => {
    const rig = setup([
      [{ type: 'screen', op: 'open_row', target: 'shed vents' }],
      [{ type: 'screen', op: 'open_row', target: '1' }],
      [{ type: 'screen', op: 'list_up' }],
    ]);
    rig.client.ask('d1', 'open shed vents');
    await vi.advanceTimersByTimeAsync(2500);
    expect(rig.screen.intents.at(-1)).toMatchObject({ view: 'conversation', itemId: 'sierra:t1' });

    rig.client.ask('d2', 'open the first one');
    await vi.advanceTimersByTimeAsync(2500);
    expect(rig.screen.intents.at(-1)).toMatchObject({ view: 'active' });
    expect(rig.screen.sent.at(-1)).toEqual({ name: 'list_project', args: { project: 'garden-k1' } });
    expect(rig.screen.list.project?.name).toBe('Garden shed');

    rig.client.ask('d3', 'back to the list');
    await vi.advanceTimersByTimeAsync(2500);
    expect(rig.screen.sent.at(-1)).toEqual({ name: 'list_project', args: { project: null } });
    expect(rig.screen.list.project).toBeNull();
  });

  it('a project by name, and "go home" inside it goes up out of the project', async () => {
    const rig = setup([[{ type: 'screen', op: 'list_project', target: 'the garden shed project' }], [{ type: 'screen', op: 'board' }]]);
    rig.client.ask('d1', 'open the garden shed project');
    await vi.advanceTimersByTimeAsync(2500);
    expect(rig.screen.sent.at(-1)).toEqual({ name: 'list_project', args: { project: 'garden-k1' } });
    rig.client.ask('d2', 'go home');
    await vi.advanceTimersByTimeAsync(2500);
    expect(rig.screen.sent.at(-1)).toEqual({ name: 'list_project', args: { project: null } });
  });

  it('a number past the end says how many rows there are', async () => {
    const rig = setup([[{ type: 'screen', op: 'open_row', target: '7' }]]);
    rig.client.ask('d1', 'open the seventh one');
    await vi.advanceTimersByTimeAsync(2500);
    expect(rig.screen.intents).toEqual([]);
    expect(said(rig.client)).toContain('The List has 3 rows on this tab.');
  });
});

describe('a List change the screen never confirms', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(80_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('says so, and the row asked for right after is not taken from the old tab', async () => {
    const screen = new ListScreen();
    // The tab command goes out but the screen never reports the new List.
    screen.command = async (name, args) => {
      screen.sent.push({ name, ...(args ? { args } : {}) });
      return true;
    };
    screen.waitForList = async () => null;
    const rig = setup(
      [
        [
          { type: 'screen', op: 'list_tab', target: 'Watching' },
          { type: 'screen', op: 'open_row', target: '2' },
        ],
      ],
      screen,
    );
    rig.client.ask('d1', 'show me Watching and open the second one');
    await vi.advanceTimersByTimeAsync(2500);
    expect(screen.sent).toEqual([{ name: 'list_tab', args: { tab: 'watching' } }]);
    expect(screen.intents).toEqual([]);
    expect(said(rig.client)).toContain("The screen didn't switch to the Watching tab.");
  });
});

it('speaks recorded waits and owner moves before background activity', () => {
  expect(stepLabel({ nextStep: 'watching', status: { move: 'watching', busy: null, live: 'watching' } })).toBe('watching');
  expect(stepLabel({ nextStep: 'your_move', status: { move: 'needs', busy: 'background', live: 'needs' } })).toBe('needs you');
  expect(stepLabel({ nextStep: 'working', status: { move: 'ready', busy: 'working', live: 'ready' } })).toBe('ready');
  expect(stepLabel({ nextStep: 'watching', status: { move: null, busy: 'background', live: 'working' } })).toBe('working');
});

it('speaks the six evaluator pills, regardless of legacy step and busy fields', () => {
  for (const pill of ['needs', 'failed', 'working', 'waiting', 'idle', 'unknown'] as const) {
    expect(stepLabel({ nextStep: 'your_move', status: { pill, move: null, busy: 'working' } })).toBe(pill === 'needs' ? 'needs you' : pill);
  }
});
