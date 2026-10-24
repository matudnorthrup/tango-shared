import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulatedAgentBackend, type AgentDescriptor } from '../src/live/agent-backend.js';
import { deriveNextItems, needsOwner, reportsUp, type DeskItemSummary } from '../src/live/desk-client.js';
import { matchTopicPick, namedRepo, namesListPlace, type DraftItemRef, type PickScreen } from '../src/live/draft-mode.js';
import type { LiveSessionClient } from '../src/live/gpt-live-client.js';
import { LivePlaybackClock, SpeechActivity } from '../src/live/live-audio.js';
import { LiveOperator } from '../src/live/live-operator.js';
import type { ListPage } from '../src/live/screen-director.js';
import type { ExtractorInput, OperatorAction, TaskExtractor } from '../src/live/task-extractor.js';
import { deskItem, FakeClient, FakeDesk, FakeDeskScreen } from './desk-fakes.js';

// Repairs from the voice regression sweep on the new desk + Loom (10/17). Synthetic fixtures only.
//   RC1  the draft's quick pick yields List commands to the router, and breaks name ties with the screen
//   RC2  a page's own views and the Inbox are voice places
//   RC3  "waiting on you" is the desk's Needs you, owner-facing only; jobs stay out of an unanchored command
//   RC4  agent mail is not the owner asking; "a new Loom thread in tango" settles its repo

const AGENTS: AgentDescriptor[] = [{ id: 'sierra', name: 'Sierra', role: 'research' }];

const ref = (id: string, place: string, extra: Partial<DraftItemRef> = {}): DraftItemRef => ({ id, agentId: 'loom', agentName: 'Loom', place, threadId: null, isAgent: false, ...extra });

describe('RC1: the quick pick and the List', () => {
  const items = [
    ref('loom:auth', 'acme · Lasting login sessions'),
    ref('loom:sweep', 'tango · Voice regression sweep', { projectId: 'voice' }),
    ref('loom:inventory', 'tango · Voice coverage inventory', { projectId: 'voice' }),
    ref('loom:desk-lead', 'tango · Tango Desk lead', { projectId: 'desk' }),
    ref('loom:voice-lead', 'tango · Tango Voice lead', { projectId: 'voice' }),
    ref('discord:garden-lead', 'Garden lead', { projectId: 'garden', agentId: 'sierra', agentName: 'Sierra', isAgent: true }),
    ref('loom:playtest', 'Playtest Coordinator', { about: 'first 3D round of playtests' }),
  ];
  const screen: PickScreen = { rows: ['loom:auth', 'loom:sweep'], spaceId: null, names: ['Top', 'Watching', 'Snoozed', 'Tango Voice', 'Garden', 'Sierra'] };

  it('leaves positions, List places and names the List shows to the router', () => {
    for (const phrase of ['open the last one', 'open the first one', 'open the second to last one', 'open number three', 'open the Tango Voice project', 'go to the inbox', 'open the jobs view', 'open Watching', 'open Garden', "open Sierra's page"]) {
      expect(matchTopicPick(phrase, items, { screen }), phrase).toBeNull();
    }
    expect(namesListPlace('the last one', null)).toBe(true);
    expect(namesListPlace('shed vents', screen)).toBe(false);
    // A conversation named by its words is still the quick pick's.
    expect(matchTopicPick('open the voice regression sweep', items, { screen })).toMatchObject({ kind: 'match', item: { id: 'loom:sweep' } });
  });

  it('breaks a tie toward the rows on screen, then the space on screen; asks only when still tied', () => {
    expect(matchTopicPick('open the lead', items, { screen: { ...screen, spaceId: 'desk' } })).toMatchObject({ kind: 'match', item: { id: 'loom:desk-lead' } });
    expect(matchTopicPick('open the voice one', items, { screen: { ...screen, rows: ['loom:inventory'] } })).toMatchObject({ kind: 'match', item: { id: 'loom:inventory' } });
    expect(matchTopicPick('open the lead', items, { screen: { ...screen, spaceId: null } })).toMatchObject({ kind: 'tie' });
    expect(matchTopicPick('open the lead', items)).toMatchObject({ kind: 'tie' });
  });
});

describe('RC3: what waits on the owner', () => {
  const status = (move: NonNullable<DeskItemSummary['status']>['move']) => ({ status: { move, busy: null } });
  const items = [
    deskItem('loom:asks', 'loom', { nextStep: 'your_move', ...status('needs') }),
    deskItem('loom:read', 'loom', { nextStep: 'your_move', seen: 'seen', ...status('ready') }),
    deskItem('loom:done', 'loom', { nextStep: 'fyi', ...status(null) }), // an unread finished update: not a move (owner, 10/18)
    deskItem('loom:job', 'loom', { nextStep: 'your_move', facts: { role: 'ops' }, ...status('needs') }),
    deskItem('loom:worker', 'loom', { nextStep: 'your_move', facts: { role: 'worker' }, ...status('needs') }),
    deskItem('loom:failed', 'loom', { nextStep: 'failed', ...status('failed') }),
    deskItem('loom:failed-seen', 'loom', { nextStep: 'failed', seen: 'seen', ...status('failed') }),
  ];

  it("is the desk's Needs you, owner-facing only, as the sidebar badge counts it", () => {
    expect(items.filter(needsOwner).map((item) => item.id)).toEqual(['loom:asks', 'loom:failed']);
    expect(deriveNextItems(items).map((item) => [item.id, item.step])).toEqual(
      expect.arrayContaining([
        ['loom:asks', 'your_move'],
        ['loom:failed', 'failed'],
      ]),
    );
    expect(deriveNextItems(items)).toHaveLength(2);
  });

  it("takes the desk's own answer when it sends live and audience: a worker whose owner is gone reaches the owner, a dropped message counts, a to-do does not", () => {
    const live = (over: Record<string, unknown>) => deskItem('x', 'loom', { nextStep: 'your_move', ...over });
    expect(needsOwner(live({ facts: { role: 'worker' }, status: { move: 'needs', busy: null, live: 'needs', audience: 'owner' } }))).toBe(true);
    expect(needsOwner(live({ status: { move: null, busy: null, live: 'todo', audience: 'owner' } }))).toBe(false);
    expect(needsOwner(live({ nextStep: 'working', seen: 'seen', status: { move: null, busy: null, live: 'failed', audience: 'owner' } }))).toBe(true);
    expect(needsOwner(live({ status: { move: 'needs', busy: null, live: 'needs', audience: 'lead' } }))).toBe(false);
    expect(reportsUp(live({ status: { move: null, busy: null, live: null, audience: 'lead' } }))).toBe(true);
    expect(reportsUp(live({ facts: { role: 'worker' }, status: { move: 'needs', busy: null, live: 'needs', audience: 'owner' } }))).toBe(false);
  });

  it('falls back to Your move and Failed on a desk without status, still never a job', () => {
    expect(needsOwner(deskItem('a', 'loom', { nextStep: 'your_move' }))).toBe(true);
    expect(needsOwner(deskItem('b', 'loom', { nextStep: 'fyi' }))).toBe(false);
    expect(needsOwner(deskItem('c', 'loom', { nextStep: 'your_move', facts: { role: 'ops' } }))).toBe(false);
  });
});

describe('RC4: a new coding thread names its repo', () => {
  it('reads "in tango", "for the acme repo"; never a repo the desk does not offer', () => {
    const repos = ['acme', 'tango', 'side-studio'];
    expect(namedRepo('start a new Loom thread in tango to make the pill count', repos)).toBe('tango');
    expect(namedRepo('a coding thread for the acme repo', repos)).toBe('acme');
    expect(namedRepo('new thread on side studio', repos)).toBe('side-studio');
    expect(namedRepo('a new thread to fix the tango dance video', repos)).toBeUndefined();
    expect(namedRepo('new thread in other-repo', repos)).toBeUndefined();
  });
});

// ── the operator ─────────────────────────────────────────────────────────

class PageScreen extends FakeDeskScreen {
  sent: Array<{ name: string; args?: Record<string, unknown> }> = [];
  list: ListPage = {
    place: { page: 'project', id: 'desk', name: 'Tango Desk' },
    tab: { id: 'top', name: 'Top' },
    tabs: [{ id: 'top', name: 'Top', count: 1 }, { id: 'watching', name: 'Watching', count: 0 }],
    views: [{ id: 'overview', name: 'Overview', count: 2 }, { id: 'jobs', name: 'Jobs', count: 1 }, { id: 'workers', name: 'Workers', count: 1 }],
    view: { id: 'overview', name: 'Overview' },
    project: { id: 'desk', name: 'Tango Desk' },
    projects: [{ id: 'desk', name: 'Tango Desk' }],
    rows: [],
  };
  override async command(name: string, args?: Record<string, unknown>) {
    this.sent.push({ name, ...(args ? { args } : {}) });
    if (name === 'list_view') this.list = { ...this.list, view: { id: String(args?.view), name: String(args?.view) } };
    if (name === 'list_place' && args?.page === 'inbox') this.list = { ...this.list, place: { page: 'inbox', view: 'top', name: 'Top' }, project: null };
    return true;
  }
  listPage() {
    return this.list;
  }
  async waitForList(test: (page: ListPage) => boolean) {
    return test(this.list) ? this.list : null;
  }
}

function setup(actions: OperatorAction[][], options: { desk?: FakeDesk; screen?: FakeDeskScreen; quietMs?: number } = {}) {
  const client = new FakeClient();
  const seen: ExtractorInput[] = [];
  const extractor: TaskExtractor = async (input) => {
    seen.push(input);
    return actions.shift() ?? [{ type: 'none', reason: 'test' }];
  };
  const desk = options.desk ?? new FakeDesk([]);
  const screen = options.screen ?? new PageScreen();
  const quiet = options.quietMs ?? 10_000;
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
    ownerSpeech: { lastAt: Date.now() - quiet, addressedAt: Date.now() - quiet },
    desk,
    screen,
  });
  operator.start();
  const said = () => client.appends.filter((append) => append.kind === 'commentary').map((append) => append.content).join('\n');
  return { client, operator, desk, screen, seen, said };
}

describe('the operator after the sweep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(80_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('RC2: switches the view of the page on screen, and the router sees those views', async () => {
    const screen = new PageScreen();
    const rig = setup([[{ type: 'screen', op: 'list_view', target: 'Workers' }]], { screen });
    rig.client.ask('d1', 'show me the workers');
    await vi.advanceTimersByTimeAsync(2500);
    expect(screen.sent).toEqual([{ name: 'list_view', args: { view: 'workers' } }]);
    expect(rig.seen[0]!.screen!.list).toMatchObject({ views: [{ name: 'Overview' }, { name: 'Jobs' }, { name: 'Workers' }], view: 'Overview' });
  });

  it('RC2: a list_tab that names one of the page’s views (not an Inbox tab) switches the view', async () => {
    const screen = new PageScreen();
    const rig = setup([[{ type: 'screen', op: 'list_tab', target: 'jobs' }]], { screen });
    rig.client.ask('d1', 'show me the jobs');
    await vi.advanceTimersByTimeAsync(2500);
    expect(screen.sent).toEqual([{ name: 'list_view', args: { view: 'jobs' } }]);
  });

  it('RC2: "go to the inbox" goes to the Inbox, not up to Projects', async () => {
    const screen = new PageScreen();
    const rig = setup([], { screen });
    rig.client.ask('d1', 'go to the inbox');
    await vi.advanceTimersByTimeAsync(2500);
    expect(screen.sent).toEqual([{ name: 'list_place', args: { page: 'inbox' } }]);
    expect(rig.seen).toHaveLength(0);
  });

  it('RC1: from the List, "open the last one" reaches the router, never a thread whose title sounds like it', async () => {
    const desk = new FakeDesk([deskItem('loom:auth', 'loom', { place: 'acme · Lasting login sessions' })]);
    const rig = setup([[{ type: 'screen', op: 'open_row', target: 'last' }]], { desk });
    rig.client.ask('d1', 'open the last one');
    await vi.advanceTimersByTimeAsync(2500);
    expect(rig.seen).toHaveLength(1);
    expect(rig.screen.intents.filter((intent) => intent.itemId === 'loom:auth')).toEqual([]);
  });

  it('RC3: jobs and workers stay out of the router’s desk listing unless named', async () => {
    const desk = new FakeDesk([
      deskItem('loom:job', 'loom', { place: 'tango · Delivery Monitor', facts: { role: 'ops' } }),
      deskItem('loom:worker', 'loom', { place: 'tango · Sweep worker', facts: { role: 'worker' } }),
      deskItem('loom:thread', 'loom', { place: 'tango · Headlight panel' }),
    ]);
    const rig = setup([[{ type: 'none', reason: 'test' }], [{ type: 'none', reason: 'test' }]], { desk });
    rig.client.ask('d1', 'mark it done');
    await vi.advanceTimersByTimeAsync(2500);
    expect(rig.seen[0]!.desk!.items.map((item) => item.place)).toEqual(['tango · Headlight panel']);
    rig.client.ask('d2', 'pause the delivery monitor job');
    await vi.advanceTimersByTimeAsync(2500);
    expect(rig.seen[1]!.desk!.items.map((item) => item.place)).toContain('tango · Delivery Monitor');
  });

  it('RC3: after a long quiet, a change to a conversation nobody has open or named asks "For me?" first', async () => {
    const desk = new FakeDesk([deskItem('loom:thread', 'loom', { place: 'tango · Headlight panel' })]);
    const rig = setup([[{ type: 'desk', op: 'done', item: 'i1' }]], { desk, quietMs: 5 * 60_000 });
    rig.client.ask('d1', 'mark it done');
    await vi.advanceTimersByTimeAsync(2500);
    expect(rig.said()).toContain('Ask only: "For me?"');
    expect(desk.commands).toEqual([]);
  });

  it('RC3: naming the conversation after the same quiet acts on it', async () => {
    const desk = new FakeDesk([deskItem('loom:thread', 'loom', { place: 'tango · Headlight panel' })]);
    const rig = setup([[{ type: 'desk', op: 'done', item: 'i1' }]], { desk, quietMs: 5 * 60_000 });
    rig.client.ask('d1', 'mark the headlight panel thread done');
    await vi.advanceTimersByTimeAsync(2500);
    expect(desk.commands.map((command) => [command.type, command.itemId])).toEqual([['done', 'loom:thread']]);
  });

  it('RC4: agent mail delivered as an owner turn is not the owner asking: its answer is not relayed', async () => {
    const desk = new FakeDesk([deskItem('discord:thread:mail', 'sierra', { nextStep: 'working', place: 'Trip planning' })]);
    const rig = setup([], { desk });
    desk.messages.set('discord:thread:mail', [{ author: 'owner', text: '✉️ Mail from “tango · Lead” · m-1\n\nCheck the campsites.', at: Date.now() - 60_000, meta: { mail: { from: 'loom:lead' } } }]);
    desk.agentPosts('discord:thread:mail', 'Three campsites are open near Pinecrest.', { nextStep: 'fyi', lastAgentMessageId: 'mail-2' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rig.said()).not.toContain('Three campsites');
  });
});
