import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulatedAgentBackend, type AgentDescriptor } from '../src/live/agent-backend.js';
import type { DeskItemSummary } from '../src/live/desk-client.js';
import { buildDraftCompilePrompt, DraftSession, type DraftCompileInput, type DraftCompileResult } from '../src/live/draft-mode.js';
import type { LiveSessionClient } from '../src/live/gpt-live-client.js';
import { LivePlaybackClock, SpeechActivity } from '../src/live/live-audio.js';
import { LiveOperator } from '../src/live/live-operator.js';
import type { ListPage } from '../src/live/screen-director.js';
import { askWhenOnlySpaceNamed, asksWhere, describeStartPlace, preferNewThread, projectRepo, startPlace, type SpaceItem } from '../src/live/start-place.js';
import { buildExtractorPrompt, type ExtractorInput, type OperatorAction, type TaskExtractor } from '../src/live/task-extractor.js';
import { deskItem, FakeClient, FakeDesk, FakeDeskScreen } from './desk-fakes.js';

// Voice routing decisions (2026-10-17): unclear → ask, never a silent Watson fallback; a new thread
// starts where the screen is, like the desk's + button, and asks when that doesn't settle it; a
// space's name never means its lead. Ids and names are synthetic.

const AGENTS: AgentDescriptor[] = [
  { id: 'watson', name: 'Watson', role: 'chief of staff' },
  { id: 'sierra', name: 'Sierra', role: 'research and trips' },
];

const VOICE = 'voice-p1';
const ROADSTER = 'bike-p2';
// facts.project is the repo's label on the live desk, never the project's name: the names come from the desk's projects.
const inProject = (projectId: string, label: string, role: string | null = null) => ({ facts: { projectId, project: { name: label.toLowerCase() }, ...(role ? { role } : {}) } as DeskItemSummary['facts'] });

/** The desk: two Tango Voice threads (its lead and a sweep), a Bike thread with Sierra, and an Inbox coding thread. */
function items(): DeskItemSummary[] {
  return [
    deskItem('loom:lead', 'loom', { agentName: 'Loom', place: 'tango · Tango Voice lead', area: 'tango', lastActivityAt: 50, ...inProject(VOICE, 'Tango Voice', 'default') }),
    deskItem('loom:sweep', 'loom', { agentName: 'Loom', place: 'tango · Voice regression sweep', area: 'tango', lastActivityAt: 40, ...inProject(VOICE, 'Tango Voice') }),
    deskItem('discord:thread:1550000000000000031', 'sierra', { threadId: '1550000000000000031', place: 'Bike speaker', ...inProject(ROADSTER, 'Bike') }),
    deskItem('loom:loose', 'loom', { place: 'acme · Loose ends', area: 'acme' }),
  ];
}

describe('startPlace: the + button rule', () => {
  const base = { projectNames: new Map([[VOICE, 'Tango Voice'], [ROADSTER, 'Bike']]), agents: AGENTS, items: items(), repos: ['tango', 'acme'] };

  it('a project page: that project, with the repo of its latest coding thread', () => {
    expect(startPlace({ ...base, open: null, page: { page: 'project', id: VOICE, name: 'Tango Voice' } })).toEqual({ from: 'project', projectId: VOICE, projectName: 'Tango Voice', repo: 'tango' });
    expect(projectRepo(items(), VOICE, ['tango'])).toBe('tango');
    // A repo Start work doesn't offer isn't the project's repo.
    expect(projectRepo(items(), VOICE, ['acme'])).toBeNull();
  });

  it("a project with no coding thread has no repo: the project only", () => {
    expect(startPlace({ ...base, open: null, page: { page: 'project', id: ROADSTER, name: 'Bike' } })).toEqual({ from: 'project', projectId: ROADSTER, projectName: 'Bike' });
  });

  it("an agent's page: a thread with that agent", () => {
    expect(startPlace({ ...base, open: null, page: { page: 'agent', id: 'sierra', name: 'Sierra' } })).toEqual({ from: 'agent', agentId: 'sierra', agentName: 'Sierra' });
  });

  it("an open thread: the same place, an agent's thread with its project, a coding thread's repo and project", () => {
    const [lead, , bike, loose] = items();
    expect(startPlace({ ...base, open: bike!, openAgent: { id: 'sierra', name: 'Sierra' } })).toEqual({ from: 'thread', agentId: 'sierra', agentName: 'Sierra', projectId: ROADSTER, projectName: 'Bike' });
    expect(startPlace({ ...base, open: lead! })).toEqual({ from: 'thread', repo: 'tango', projectId: VOICE, projectName: 'Tango Voice' });
    expect(startPlace({ ...base, open: loose! })).toEqual({ from: 'thread', repo: 'acme' });
  });

  it('the Inbox (or the Projects / Agents index) settles nothing', () => {
    expect(startPlace({ ...base, open: null, page: { page: 'inbox', name: 'Inbox' } })).toBeNull();
    expect(startPlace({ ...base, open: null, page: { page: 'projects', name: 'Projects' } })).toBeNull();
    expect(startPlace({ ...base, open: null })).toBeNull();
    expect(describeStartPlace(null)).toContain('nothing settles it');
  });
});

describe('a space named alone is not its lead', () => {
  const listed: SpaceItem[] = items().map((item, index) => ({ handle: `i${index + 1}`, id: item.id, place: item.place, projectId: item.facts?.projectId ?? null, role: item.facts?.role ?? null }));
  const projects = new Map([[VOICE, 'Tango Voice'], [ROADSTER, 'Bike']]);
  const byHandle = (action: OperatorAction) => (action.type === 'desk' && action.item ? (listed.find((item) => item.handle === action.item)?.id ?? null) : null);
  const toLead: OperatorAction[] = [{ type: 'desk', op: 'reply', item: 'i1', message: 'Ship it.' }];

  it('"tell Tango Voice …" with two threads in it asks which, naming them', () => {
    const [ask] = askWhenOnlySpaceNamed('tell Tango Voice to ship it', toLead, listed, projects, byHandle);
    expect(ask).toEqual({ type: 'ask', question: 'Which Tango Voice thread: "Tango Voice lead", "Voice regression sweep"?', reason: 'only the Tango Voice space was named' });
  });

  it('a thread named by its own words stands: "the Tango Voice lead", "the regression sweep"', () => {
    expect(askWhenOnlySpaceNamed('tell the Tango Voice lead to ship it', toLead, listed, projects, byHandle)).toBe(toLead);
    const toSweep: OperatorAction[] = [{ type: 'desk', op: 'reply', item: 'i2', message: 'Rerun it.' }];
    expect(askWhenOnlySpaceNamed('tell the Tango Voice regression sweep to rerun it', toSweep, listed, projects, byHandle)).toBe(toSweep);
  });

  it('words for an agent nobody named, with only a space named, ask which of its threads', () => {
    const toWatson: OperatorAction[] = [{ type: 'dispatch', agentId: 'watson', message: 'Hold off.' }];
    const [ask] = askWhenOnlySpaceNamed('tell Tango Voice to hold off', toWatson, listed, projects, () => null, () => true);
    expect(ask).toMatchObject({ type: 'ask', question: expect.stringContaining('Which Tango Voice thread') });
    // An agent the owner did name stands.
    expect(askWhenOnlySpaceNamed('have Watson tell Tango Voice to hold off', toWatson, listed, projects, () => null, () => false)).toBe(toWatson);
  });

  it('a space with one thread, or no space named at all, stands', () => {
    const toBike: OperatorAction[] = [{ type: 'desk', op: 'reply', item: 'i3', message: 'Order it.' }];
    expect(askWhenOnlySpaceNamed('tell Bike to order it', toBike, listed, projects, byHandle)).toBe(toBike);
    expect(askWhenOnlySpaceNamed('ship it', toLead, listed, projects, byHandle)).toBe(toLead);
  });
});

describe('"start a new thread", whatever the router made of it', () => {
  const people = AGENTS.map((agent) => ({ id: agent.id, names: [agent.name] }));
  const repos = ['tango', 'acme'];

  it('a dispatch to loom with no title, a repo, or an agent nobody named becomes a new-thread draft', () => {
    expect(preferNewThread('start a new thread to check the reconnect', [{ type: 'dispatch', agentId: 'loom', message: 'check the reconnect' }], people, repos)).toEqual([{ type: 'draft', op: 'start', agentId: 'loom', message: 'check the reconnect' }]);
    expect(preferNewThread('kick off a thread to check the reconnect', [{ type: 'dispatch', agentId: 'tango', message: 'x', newThreadTitle: 'X' }], people, repos)[0]).toMatchObject({ type: 'draft', agentId: 'loom' });
    expect(preferNewThread('start a new thread to look into the backup', [{ type: 'dispatch', agentId: 'watson', message: 'x', newThreadTitle: 'Backup' }], people, repos)[0]).toMatchObject({ type: 'draft', agentId: 'new' });
  });

  it('an agent the owner named, an existing thread, or no new-thread words: the router stands', () => {
    const named: OperatorAction[] = [{ type: 'dispatch', agentId: 'sierra', message: 'x', newThreadTitle: 'X' }];
    expect(preferNewThread('start a new thread with Sierra about campgrounds', named, people, repos)).toBe(named);
    const existing: OperatorAction[] = [{ type: 'dispatch', agentId: 'sierra', message: 'x', threadId: '1550000000000000031' }];
    expect(preferNewThread('start a new thread for the speaker', existing, people, repos)).toBe(existing);
    const plain: OperatorAction[] = [{ type: 'dispatch', agentId: 'watson', message: 'x' }];
    expect(preferNewThread('open the speaker thread', plain, people, repos)).toBe(plain);
    // Existing threads, however "new" is said (Codex review on #714).
    expect(preferNewThread("what's new in the billing thread?", plain, people, repos)).toBe(plain);
    expect(preferNewThread('open the new migration thread', plain, people, repos)).toBe(plain);
    // A command that opens with "new Loom thread" still is one.
    expect(preferNewThread('new Loom thread, fix the export test', [{ type: 'dispatch', agentId: 'loom', message: 'fix it' }], people, repos)[0]).toMatchObject({ type: 'draft', agentId: 'loom' });
  });

  it('where-questions are what the screen\'s place answers; others are not', () => {
    expect(asksWhere('Which repo: acme, tango, side-studio?')).toBe(true);
    expect(asksWhere('In tango, or with Watson?')).toBe(true);
    expect(asksWhere('Where should it start?')).toBe(true);
    expect(asksWhere('What should it work on?')).toBe(false);
    expect(asksWhere('Which backup, the nightly or the weekly one?')).toBe(false);
    // Task questions that name a repo or project are still asked (Codex review on #714).
    expect(asksWhere('Which project requirements should it preserve?')).toBe(false);
    expect(asksWhere('Should it replace the repo cache?')).toBe(false);
    expect(asksWhere('Where should it start: in tango or acme, or with an agent?')).toBe(true);
  });
});

// ── the operator, end to end with fakes ─────────────────────────────────

class PlaceScreen extends FakeDeskScreen {
  page: ListPage | null = null;
  listPage() {
    return this.page;
  }
}

class StartDesk extends FakeDesk {
  started: Array<Record<string, unknown>> = [];
  /** Items off the active list (snoozed, parked, done): item() still reads them. */
  offList: DeskItemSummary[] = [];
  skipProject = false;
  override async item(id: string) {
    const parked = this.offList.find((candidate) => candidate.id === id);
    return parked ? { ...parked, messages: [] } : super.item(id);
  }
  async startWorkRepos() {
    return ['tango', 'acme'];
  }
  async startWork(request: Record<string, unknown>) {
    this.started.push(request);
    return { ok: true as const, threadId: 'n-1', itemId: 'loom:n-1', title: String(request.title ?? 'New'), account: 'Loom', ...(this.skipProject ? { projectSkipped: true } : {}) };
  }
}

const onPage = (place: ListPage['place']): ListPage => ({ place, tab: { id: 'active', name: 'Active' }, tabs: [], project: null, projects: [{ id: VOICE, name: 'Tango Voice' }, { id: ROADSTER, name: 'Bike' }], rows: [] });

const compiled = (message: string, extra: Partial<DraftCompileResult> = {}): DraftCompileResult => ({ message, agentId: null, item: null, threadId: null, newThreadTitle: null, questions: [], ...extra });

function setup(actions: OperatorAction[][], compile: (input: DraftCompileInput) => DraftCompileResult = (input) => compiled(input.fragments.join(' '))) {
  const client = new FakeClient();
  const desk = new StartDesk(items());
  desk.projectList = [{ id: VOICE, name: 'Tango Voice' }, { id: ROADSTER, name: 'Bike' }];
  const screen = new PlaceScreen();
  const backend = new SimulatedAgentBackend({});
  const routed: ExtractorInput[] = [];
  const compiles: DraftCompileInput[] = [];
  const extractor: TaskExtractor = async (input) => {
    routed.push(input);
    return actions.shift() ?? [{ type: 'none', reason: 'test' }];
  };
  const draft = new DraftSession({
    compile: async (input) => {
      compiles.push(input);
      return compile(input);
    },
  });
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
    defaultAgentId: 'watson',
    desk,
    screen,
    draft,
  });
  operator.start();
  return { client, desk, screen, backend, routed, compiles, operator };
}

type Rig = ReturnType<typeof setup>;
const say = async (rig: Rig, id: string, words: string) => {
  rig.client.ask(id, words);
  await vi.advanceTimersByTimeAsync(600);
};
const commentary = (rig: Rig) => rig.client.appends.filter((append) => append.kind === 'commentary').map((append) => append.content);
const newThread = (message: string): OperatorAction[][] => [[{ type: 'draft', op: 'start', agentId: 'new', message }]];

describe('operator: new threads start where the screen is', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(80_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it("on a project page: a coding thread in the project's repo, filed under it, said back before it starts", async () => {
    const rig = setup(newThread('check the reconnect timing'), (input) => compiled('Check the reconnect timing.', { newThreadTitle: 'Reconnect timing' }));
    rig.screen.page = onPage({ page: 'project', id: VOICE, name: 'Tango Voice' });
    await say(rig, 'd1', 'start a new thread to check the reconnect timing');
    expect(rig.routed[0]!.startPlace).toBe('a coding thread in tango under the Tango Voice project (from the project page)');
    await say(rig, 'd2', "that's it");
    expect(rig.compiles[0]).toMatchObject({ newThread: true, startPlace: { from: 'project', projectId: VOICE, repo: 'tango' } });
    expect(commentary(rig).at(-1)).toContain('Send that to a new thread in tango, under Tango Voice?');
    await say(rig, 'd3', 'yes');
    expect(rig.desk.started).toEqual([expect.objectContaining({ repo: 'tango', projectId: VOICE, prompt: 'Check the reconnect timing.', title: 'Reconnect timing' })]);
    expect(rig.desk.agentThreads).toEqual([]);
    expect(rig.backend.sends).toEqual([]);
  });

  it("on an agent's page: a thread with that agent, through the desk", async () => {
    const rig = setup(newThread('find three campgrounds'), () => compiled('Find three campgrounds near Pinecrest.', { newThreadTitle: 'Pinecrest campgrounds' }));
    rig.screen.page = onPage({ page: 'agent', id: 'sierra', name: 'Sierra' });
    await say(rig, 'd1', 'start a new thread to find three campgrounds');
    await say(rig, 'd2', "that's it");
    expect(commentary(rig).at(-1)).toContain('Send that to Sierra in a new thread, "Pinecrest campgrounds"?');
    await say(rig, 'd3', 'yes');
    expect(rig.desk.agentThreads).toEqual([expect.objectContaining({ agentId: 'sierra', prompt: 'Find three campgrounds near Pinecrest.', title: 'Pinecrest campgrounds' })]);
    expect(rig.desk.agentThreads[0]).not.toHaveProperty('projectId');
    expect(rig.desk.started).toEqual([]);
  });

  it("with a thread open: the same agent and project as that thread", async () => {
    const rig = setup(newThread('price a backup camera'), () => compiled('Price a backup camera.', { newThreadTitle: 'Backup camera' }));
    rig.screen.presented = { view: 'conversation', itemId: 'discord:thread:1550000000000000031', conversationKey: 'thread:1550000000000000031', sceneId: null };
    await say(rig, 'd1', 'start a new thread to price a backup camera');
    await say(rig, 'd2', "that's it");
    await say(rig, 'd3', 'yes');
    expect(rig.desk.agentThreads).toEqual([expect.objectContaining({ agentId: 'sierra', projectId: ROADSTER, title: 'Backup camera' })]);
  });

  it('in the Inbox with nothing named: asks with a guess, never Watson on its own; the answer settles it', async () => {
    const rig = setup(newThread('look into the flaky deploy'), (input) =>
      input.clarifications?.length ? compiled('Look into the flaky deploy.', { agentId: 'watson', newThreadTitle: 'Flaky deploy' }) : compiled('Look into the flaky deploy.', { questions: ['In tango, or with Watson?'] }),
    );
    rig.screen.page = onPage({ page: 'inbox', name: 'Inbox' });
    await say(rig, 'd1', 'start a new thread to look into the flaky deploy');
    expect(rig.routed[0]!.startPlace).toContain('nothing settles it');
    await say(rig, 'd2', "that's it");
    expect(commentary(rig).at(-1)).toContain('"In tango, or with Watson?"');
    expect(rig.desk.agentThreads).toEqual([]);
    expect(rig.desk.started).toEqual([]);
    await say(rig, 'd3', 'with Watson');
    expect(rig.compiles.at(-1)?.clarifications).toEqual([{ question: 'In tango, or with Watson?', answer: 'with Watson' }]);
    expect(commentary(rig).at(-1)).toContain('Send that to Watson in a new thread, "Flaky deploy"?');
    await say(rig, 'd4', 'yes');
    expect(rig.desk.agentThreads).toEqual([expect.objectContaining({ agentId: 'watson', title: 'Flaky deploy' })]);
  });

  it('in the Inbox, a compile that asks nothing still asks: the place settles nothing', async () => {
    const rig = setup(newThread('look into the flaky deploy'));
    await say(rig, 'd1', 'start a new thread to look into the flaky deploy');
    await say(rig, 'd2', "that's it");
    expect(commentary(rig).at(-1)).toContain('"Where should it start: in tango or acme, or with an agent?"');
    expect(rig.desk.agentThreads).toEqual([]);
    expect(rig.desk.started).toEqual([]);
  });

  it('"new Loom thread" on a project page needs no repo question: the project settles it', async () => {
    const rig = setup([[{ type: 'draft', op: 'start', agentId: 'loom', message: 'fix the export test' }]], () => compiled('Fix the export test.'));
    rig.screen.page = onPage({ page: 'project', id: VOICE, name: 'Tango Voice' });
    await say(rig, 'd1', 'new Loom thread, fix the export test');
    await say(rig, 'd2', "that's it");
    expect(commentary(rig).at(-1)).toContain('Send that to a new thread in tango, under Tango Voice?');
    await say(rig, 'd3', 'yes');
    expect(rig.desk.started).toEqual([expect.objectContaining({ repo: 'tango', projectId: VOICE })]);
  });

  it('a named agent on a project page: a thread with that agent, through the desk, filed under the project', async () => {
    const rig = setup([[{ type: 'dispatch', agentId: 'sierra', message: 'Research voice latency papers.', newThreadTitle: 'Latency papers' }]]);
    rig.screen.page = onPage({ page: 'project', id: VOICE, name: 'Tango Voice' });
    await say(rig, 'd1', 'start a new thread with Sierra to research voice latency papers');
    expect(rig.desk.agentThreads).toEqual([expect.objectContaining({ agentId: 'sierra', title: 'Latency papers', projectId: VOICE })]);
    expect(rig.backend.sends).toEqual([]);
    expect(rig.client.appends.at(-1)?.content).toContain('under Tango Voice');
  });

  it('a new-thread dispatch to a repo (not an agent) becomes a placed draft, never "who should take that?"', async () => {
    const rig = setup([[{ type: 'dispatch', agentId: 'tango', message: 'Check the reconnect timing.', newThreadTitle: 'Reconnect timing' }]], () => compiled('Check the reconnect timing.', { newThreadTitle: 'Reconnect timing' }));
    rig.screen.page = onPage({ page: 'project', id: VOICE, name: 'Tango Voice' });
    await say(rig, 'd1', 'start a new thread to check the reconnect timing');
    await say(rig, 'd2', "that's it");
    expect(commentary(rig).at(-1)).toContain('Send that to a new thread in tango, under Tango Voice?');
    await say(rig, 'd3', 'yes');
    expect(rig.desk.started).toEqual([expect.objectContaining({ repo: 'tango', projectId: VOICE })]);
  });

  it('a parked thread open on the screen (off the active list) still sets the place (Codex review on #712)', async () => {
    const rig = setup(newThread('price a backup camera'), () => compiled('Price a backup camera.', { newThreadTitle: 'Backup camera' }));
    rig.desk.offList.push(deskItem('discord:thread:1550000000000000032', 'sierra', { threadId: '1550000000000000032', place: 'Bike wheels', disposition: 'parked', ...inProject(ROADSTER, 'Bike') }));
    rig.screen.presented = { view: 'conversation', itemId: 'discord:thread:1550000000000000032', conversationKey: 'thread:1550000000000000032', sceneId: null };
    await say(rig, 'd1', 'start a new thread to price a backup camera');
    await say(rig, 'd2', "that's it");
    await say(rig, 'd3', 'yes');
    expect(rig.desk.agentThreads).toEqual([expect.objectContaining({ agentId: 'sierra', projectId: ROADSTER })]);
  });

  it('a new thread for a name not on the roster asks who, never settles on the screen\'s place (Codex review on #712)', async () => {
    const rig = setup([[{ type: 'dispatch', agentId: 'alice', message: 'Plan the offsite.', newThreadTitle: 'Offsite' }]]);
    rig.screen.page = onPage({ page: 'agent', id: 'sierra', name: 'Sierra' });
    await say(rig, 'd1', 'start a new thread with Alice to plan the offsite');
    expect(commentary(rig).join('\n')).toContain('"Who should take that?"');
    expect(rig.desk.agentThreads).toEqual([]);
    expect(rig.desk.started).toEqual([]);
  });

  it('a project finished while Start work ran: the thread started on its own, and the owner hears so (Codex review on #712)', async () => {
    const rig = setup(newThread('check the reconnect timing'), () => compiled('Check the reconnect timing.'));
    rig.desk.skipProject = true;
    rig.screen.page = onPage({ page: 'project', id: VOICE, name: 'Tango Voice' });
    await say(rig, 'd1', 'start a new thread to check the reconnect timing');
    await say(rig, 'd2', "that's it");
    await say(rig, 'd3', 'yes');
    expect(rig.desk.started).toHaveLength(1);
    expect(commentary(rig).join('\n')).toContain('not under Tango Voice: that project was finished or deleted meanwhile');
  });

  it('a "new thread" dispatch to loom with no title (seen live) starts a placed draft, not "which coding thread?"', async () => {
    const rig = setup([[{ type: 'dispatch', agentId: 'loom', message: 'check how long the reconnect takes' }]], () => compiled('Check how long the reconnect takes.'));
    rig.screen.page = onPage({ page: 'project', id: VOICE, name: 'Tango Voice' });
    await say(rig, 'd1', 'start a new thread to check how long the reconnect takes');
    expect(commentary(rig).join('\n')).not.toContain('Which coding thread');
    await say(rig, 'd2', "that's it");
    expect(commentary(rig).at(-1)).toContain('Send that to a new thread in tango, under Tango Voice?');
    expect(rig.desk.traced('routed.new-thread')).toHaveLength(1);
  });

  it('a compile that asks "which repo?" when the screen settled it (seen live) is not asked', async () => {
    const rig = setup([[{ type: 'draft', op: 'start', agentId: 'new', message: 'measure host restarts' }]], () => compiled('Measure host restarts.', { questions: ['Which repo: acme, tango, side-studio?'] }));
    rig.screen.page = onPage({ page: 'project', id: VOICE, name: 'Tango Voice' });
    await say(rig, 'd1', 'start a new thread to measure host restarts');
    await say(rig, 'd2', "that's it");
    expect(commentary(rig).at(-1)).toContain('Send that to a new thread in tango, under Tango Voice?');
    expect(rig.desk.traced('draft.place')).toHaveLength(1);
  });

  it('the prompts teach agent_id "new" and the place', () => {
    const prompt = buildExtractorPrompt({ agents: AGENTS, tasks: [], transcript: [], latestUserSpeech: 'x', startPlace: 'a thread with Sierra (from the agent\'s page)', desk: { items: [] } });
    expect(prompt).toContain('draft start with agent_id "new"');
    expect(prompt).toContain("the desk's + button reads it): a thread with Sierra (from the agent's page)");
    const draft = buildDraftCompilePrompt({ fragments: ['x'], agents: AGENTS, tasks: [], threads: [], transcript: [], now: 0, newThread: true, startPlace: null });
    expect(draft).toContain('"In tango, or with Watson?"');
    expect(draft).not.toContain('Chief of staff (for judgment calls');
  });
});

describe('operator: existing threads by name, anywhere in a space', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(80_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('the router sees each thread\'s space and which one is its lead', async () => {
    const rig = setup([[{ type: 'none', reason: 'test' }]]);
    await say(rig, 'd1', 'hmm, about the voice work, let me think');
    const listed = rig.routed[0]!.desk!.items;
    expect(listed.find((item) => item.place === 'tango · Tango Voice lead')).toMatchObject({ space: 'Tango Voice', lead: true });
    expect(listed.find((item) => item.place === 'tango · Voice regression sweep')).toMatchObject({ space: 'Tango Voice' });
    expect(listed.find((item) => item.place === 'tango · Voice regression sweep')).not.toHaveProperty('lead');
    expect(buildExtractorPrompt({ agents: AGENTS, tasks: [], transcript: [], latestUserSpeech: 'x', desk: { items: listed } })).toContain('[space: Tango Voice, its lead]');
  });

  it('a non-lead thread named by its title gets the words', async () => {
    const rig = setup([[{ type: 'desk', op: 'reply', item: 'i2', message: 'Rerun the sweep.' }]]);
    await say(rig, 'd1', 'tell the voice regression sweep to rerun');
    expect(rig.desk.sent('reply')).toEqual([expect.objectContaining({ itemId: 'loom:sweep', args: { text: 'Rerun the sweep.' } })]);
  });

  it('only the space named, with several threads: asks which, sends nothing (even when the router picked the lead)', async () => {
    const rig = setup([[{ type: 'desk', op: 'reply', item: 'i1', message: 'Ship it.' }]]);
    await say(rig, 'd1', 'tell Tango Voice to ship it');
    expect(rig.desk.sent('reply')).toEqual([]);
    expect(commentary(rig).join('\n')).toContain('"Which Tango Voice thread: "Tango Voice lead", "Voice regression sweep"?"');
    expect(rig.desk.traced('routed.space-only')).toHaveLength(1);
  });

  it('"the Tango Voice lead" reaches the lead', async () => {
    const rig = setup([[{ type: 'desk', op: 'reply', item: 'i1', message: 'Ship it.' }]]);
    await say(rig, 'd1', 'tell the Tango Voice lead to ship it');
    expect(rig.desk.sent('reply')).toEqual([expect.objectContaining({ itemId: 'loom:lead' })]);
  });
});
