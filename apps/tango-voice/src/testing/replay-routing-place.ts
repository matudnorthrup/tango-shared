// Scripted proof for voice routing (decisions of 2026-10-17): new threads start where the screen is
// (like the desk's + button) or the operator asks; unclear requests ask instead of going to the chief
// of staff; a space's name never means its lead. The real router and draft compiler run against a
// copy of the live desk, read once (GET only). Nothing is sent anywhere: desk commands, Start work,
// agent-thread starts, Discord thread creates and agent turns are all recorded, never performed.
//
//   npx tsx src/testing/replay-routing-place.ts [--operator ID] [--desk URL] [--snapshot FILE] [--out FILE] [--only name,name]
//
// Scenarios name real ids from the snapshot (projects, agents, Loom threads); one whose ids are gone
// from the desk is skipped. Runs against whatever source tree it sits in, so the same file proves
// before (main) and after (the branch).

import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import type { AgentBackend, AgentDescriptor, AgentUpdate } from '../live/agent-backend.js';
import type { AgentThreadRequest, DeskBriefing, DeskClient, DeskCommandResult, DeskCommandType, DeskItemDetail, DeskItemSummary, StartWorkRequest } from '../live/desk-client.js';
import type { ThreadDirectory } from '../live/discord-threads.js';
import { createDraftCompiler, DraftSession } from '../live/draft-mode.js';
import type { LiveSessionClient } from '../live/gpt-live-client.js';
import { LivePlaybackClock, SpeechActivity } from '../live/live-audio.js';
import { chiefOfStaff, LiveOperator } from '../live/live-operator.js';
import { loadOperatorProfiles, resolveProfileAgents, selectOperatorProfile } from '../live/operator-profile.js';
import { createCodexResponsesCaller } from '../live/responses-caller.js';
import type { ListPage, PresentationIntent, PresentationState, ScreenDirector, ScreenHandlers } from '../live/screen-director.js';
import { createTaskExtractor, type OperatorAction } from '../live/task-extractor.js';

const args = process.argv.slice(2);
const flag = (name: string, fallback = '') => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? (args[at + 1] ?? fallback) : fallback;
};

const profile = selectOperatorProfile(loadOperatorProfiles(), flag('operator') || undefined);
const deskUrl = (flag('desk') || profile.screenUrl || 'http://127.0.0.1:9410').replace(/\/$/, '');
const { agents } = resolveProfileAgents(profile);
const models = createCodexResponsesCaller();

// ── the copy of the live desk ────────────────────────────────────────────

interface Snapshot {
  at: string;
  items: DeskItemSummary[];
  projects: Array<{ id: string; name: string }>;
  repos: string[];
}

async function snapshot(): Promise<Snapshot> {
  const file = flag('snapshot');
  if (file && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as Snapshot;
  const get = async <T>(path: string): Promise<T> => {
    const response = await fetch(`${deskUrl}${path}`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
    return (await response.json()) as T;
  };
  const items = (await get<{ items: DeskItemSummary[] }>('/api/desk/items?view=active')).items;
  const repos = ((await get<{ repos?: Array<{ name: string }> }>('/api/desk/start-work')).repos ?? []).map((repo) => repo.name);
  const projects = ((await get<{ projects?: Array<{ id: string; name: string; finishedAt?: unknown }> }>('/api/desk/settings')).projects ?? []).filter((project) => !project.finishedAt).map(({ id, name }) => ({ id, name }));
  const copy: Snapshot = { at: new Date().toISOString(), items, projects, repos };
  if (file) fs.writeFileSync(file, JSON.stringify(copy, null, 2));
  return copy;
}

type Recorded = { kind: string; detail: Record<string, unknown> };

/** The desk, as a copy: reads from the snapshot, records every write. */
class SnapshotDesk implements DeskClient {
  recorded: Recorded[] = [];
  constructor(
    private list: DeskItemSummary[],
    private repos: string[],
    private projectList: Array<{ id: string; name: string }>,
  ) {}
  items() {
    return this.list;
  }
  projects() {
    return this.projectList;
  }
  async refresh() {
    return this.list;
  }
  async item(id: string): Promise<DeskItemDetail | null> {
    const item = this.list.find((candidate) => candidate.id === id);
    return item ? { ...item, messages: [] } : null;
  }
  async briefing(): Promise<DeskBriefing | null> {
    return { text: 'Nothing is waiting on you.', yourMove: [], fyi: [] };
  }
  async next() {
    return [];
  }
  async command(type: DeskCommandType, itemId: string | undefined, args: Record<string, unknown> = {}): Promise<DeskCommandResult> {
    if (type !== 'heard' && type !== 'seen') this.recorded.push({ kind: `desk ${type}`, detail: { itemId, ...args } });
    return { commandId: 'replay', status: 'applied' } as DeskCommandResult;
  }
  publishOperator() {}
  publishDraft() {}
  onDraftCommand() {}
  connect() {}
  disconnect() {}
  async startWorkRepos() {
    return this.repos;
  }
  async startWork(request: StartWorkRequest) {
    this.recorded.push({ kind: 'start-work', detail: { ...request, commandId: undefined } });
    return { ok: true as const, threadId: 'replay-1', itemId: 'loom:replay-1', title: String(request.title ?? ''), account: 'replay' };
  }
  async startAgentThread(request: AgentThreadRequest) {
    this.recorded.push({ kind: 'agent-thread (desk)', detail: { ...request, commandId: undefined } });
    return { ok: true as const, threadId: '1', itemId: 'discord:thread:1', title: String(request.title ?? '') };
  }
}

/** Discord threads: none listed; a create (the old path) is recorded, never made. */
class RecordingThreads implements ThreadDirectory {
  constructor(private desk: SnapshotDesk) {}
  async list() {
    return [];
  }
  async create(agentId: string, title: string) {
    this.desk.recorded.push({ kind: 'discord thread create', detail: { agentId, title } });
    return { id: '1', title, agentId, lastActiveAt: Date.now() };
  }
}

/** Agent turns: recorded, never sent. */
class RecordingBackend implements AgentBackend {
  constructor(private desk: SnapshotDesk) {}
  send(request: { agentId: string; message: string; channelId?: string }, _onUpdate: (update: AgentUpdate) => void) {
    this.desk.recorded.push({ kind: `agent turn → ${request.agentId}${request.channelId ? ` (thread ${request.channelId})` : ' (main channel)'}`, detail: { message: request.message } });
  }
}

/** A screen on a given page (or with a thread open). */
class PlaceScreen implements ScreenDirector {
  constructor(
    public page: ListPage | null,
    public presented: PresentationState,
  ) {}
  connect(_handlers: ScreenHandlers) {}
  disconnect() {}
  screensConnected() {
    return 1;
  }
  showing() {
    return null;
  }
  staged() {
    return [];
  }
  async showAgent() {
    return null;
  }
  async showScene() {
    return null;
  }
  async showDashboard() {}
  async back() {
    return null;
  }
  async command() {
    return true;
  }
  setTasks() {}
  listPage() {
    return this.page;
  }
  presentation() {
    return this.presented;
  }
  async present(intent: PresentationIntent) {
    this.presented = { view: intent.view, itemId: intent.itemId ?? null, conversationKey: intent.conversationKey ?? null, sceneId: intent.sceneId ?? null };
    return true;
  }
}

class Client extends EventEmitter {
  appends: Array<{ kind: string; content: string }> = [];
  appendContext(kind: string, content: string) {
    this.appends.push({ kind, content });
    return Promise.resolve({ clientEventId: 'x' });
  }
  ask(id: string, words: string) {
    this.emit('inputTranscript', { delta: ` ${words}`, startMs: Date.now(), endMs: Date.now() });
    this.emit('delegation', { id, offsetMs: 0 });
  }
}

// ── scenarios ─────────────────────────────────────────────────────────────

interface Scenario {
  name: string;
  where: string;
  /** Ids that must be on the desk for the scenario to mean anything. */
  needs: string[];
  page?: ListPage['place'];
  open?: string;
  turns: string[];
  expect: string;
}

let projectNames = new Map<string, string>();
const projectName = (_items: DeskItemSummary[], id: string) => projectNames.get(id) ?? id;

function scenarios(snap: Snapshot): Scenario[] {
  const items = snap.items;
  const find = (pred: (item: DeskItemSummary) => boolean) => items.find(pred);
  const voiceLead = find((item) => item.facts?.role === 'default' && /Tango Voice lead/i.test(item.place ?? ''));
  const voiceProject = voiceLead?.facts?.projectId ?? '';
  const voiceSweep = find((item) => item.facts?.projectId === voiceProject && item.id !== voiceLead?.id && /regression sweep/i.test(item.place ?? ''));
  const bike = find((item) => item.agentId === 'sierra' && item.facts?.role === 'default' && !!item.facts?.projectId);
  const loomLead = find((item) => item.facts?.role === 'default' && /^tango · Loom lead/i.test(item.place ?? ''));
  const vName = voiceProject ? projectName(items, voiceProject) : 'Tango Voice';
  return [
    { name: 'project-page', where: `${vName} project page (${voiceProject})`, needs: [voiceProject], page: { page: 'project', id: voiceProject, name: vName }, turns: ['start a new thread to check how long the reconnect takes', "that's it", 'yes'], expect: `coding thread in tango, filed under ${vName}` },
    { name: 'agent-page', where: "Sierra's agent page (sierra)", needs: [], page: { page: 'agent', id: 'sierra', name: 'Sierra' }, turns: ['start a new thread to find three campgrounds near Pinecrest for next weekend', "that's it", 'yes'], expect: 'thread with Sierra, through the desk' },
    { name: 'thread-open', where: `open thread ${bike?.id ?? '(none)'} (${bike?.place ?? ''})`, needs: [bike?.id ?? ''], open: bike?.id, turns: ['start a new thread to price a backup camera', "that's it", 'yes'], expect: `thread with Sierra, filed under ${bike ? projectName(items, bike.facts!.projectId!) : '?'}` },
    { name: 'loom-thread-open', where: `open Loom thread ${loomLead?.id ?? '(none)'}`, needs: [loomLead?.id ?? ''], open: loomLead?.id, turns: ['start a new thread to measure session host restarts', "that's it", 'yes'], expect: `coding thread in tango, filed under ${loomLead ? projectName(items, loomLead.facts!.projectId!) : '?'}` },
    { name: 'inbox-new', where: 'Inbox, nothing named', needs: [], page: { page: 'inbox', name: 'Inbox' }, turns: ['start a new thread to look into why the nightly backup was slow', "that's it"], expect: 'asks where (a guess offered); nothing starts' },
    { name: 'inbox-unclear', where: 'Inbox, nothing named', needs: [], page: { page: 'inbox', name: 'Inbox' }, turns: ['can you deal with the thing from this morning'], expect: 'asks who or where; nothing goes to Watson' },
    { name: 'space-only', where: 'Inbox', needs: [voiceLead?.id ?? '', voiceSweep?.id ?? ''], page: { page: 'inbox', name: 'Inbox' }, turns: [`tell ${vName} to hold off on new tests until tomorrow`], expect: `asks which ${vName} thread; nothing sent` },
    { name: 'space-lead-named', where: 'Inbox', needs: [voiceLead?.id ?? ''], page: { page: 'inbox', name: 'Inbox' }, turns: [`tell the ${vName} lead to hold off on new tests until tomorrow`], expect: `reply to ${voiceLead?.id}` },
    { name: 'space-thread-named', where: 'Inbox', needs: [voiceSweep?.id ?? ''], page: { page: 'inbox', name: 'Inbox' }, turns: ['tell the voice regression sweep thread to rerun the failing cases'], expect: `reply to ${voiceSweep?.id} (not the lead)` },
    { name: 'named-agent-in-project', where: `${vName} project page`, needs: [voiceProject], page: { page: 'project', id: voiceProject, name: vName }, turns: ['start a new thread with Sierra to find research on voice latency'], expect: `thread with Sierra via the desk, filed under ${vName}` },
  ];
}

const listPage = (place: ListPage['place'] | undefined, snap: Snapshot): ListPage | null => (place ? { place, tab: { id: 'active', name: 'Active' }, tabs: [], project: null, projects: snap.projects, rows: [] } : null);

/** Until the operator answers what was just said (a new append), then has been quiet for `ms`. */
async function quiet(client: Client, from: number, ms = 3000, max = 120_000): Promise<void> {
  const started = Date.now();
  let count = client.appends.length;
  let since = Date.now();
  while (Date.now() - started < max) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (client.appends.length !== count) {
      count = client.appends.length;
      since = Date.now();
    } else if (count > from && Date.now() - since >= ms) return;
  }
}

async function run(scenario: Scenario, snap: Snapshot) {
  const desk = new SnapshotDesk(JSON.parse(JSON.stringify(snap.items)) as DeskItemSummary[], snap.repos, snap.projects);
  const open = scenario.open ? snap.items.find((item) => item.id === scenario.open) : undefined;
  const screen = new PlaceScreen(listPage(scenario.page, snap), open ? { view: 'conversation', itemId: open.id, conversationKey: open.conversationKey, sceneId: null } : { view: 'active', itemId: null, conversationKey: null, sceneId: null });
  const client = new Client();
  const routed: OperatorAction[][] = [];
  const extractor = createTaskExtractor(models, { people: profile.people });
  const operator = new LiveOperator({
    client: client as unknown as LiveSessionClient,
    agents,
    backend: new RecordingBackend(desk),
    extractor: async (input) => {
      const actions = await extractor(input);
      routed.push(actions);
      return actions;
    },
    userActivity: new SpeechActivity(),
    playback: new LivePlaybackClock(),
    floor: { settleMs: 300, speakTimeoutMs: 2000 },
    transcriptSettleMs: 50,
    homeChannelFor: () => undefined,
    defaultAgentId: chiefOfStaff(agents)?.id,
    threads: new RecordingThreads(desk),
    desk,
    screen,
    draft: new DraftSession({ compile: createDraftCompiler(models, { people: profile.people }) }),
    addresseeCheck: false,
  } as ConstructorParameters<typeof LiveOperator>[0]);
  operator.start();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const said: string[] = [];
  for (const [index, words] of scenario.turns.entries()) {
    const before = client.appends.length;
    client.ask(`${scenario.name}-${index}`, words);
    await quiet(client, before);
    said.push(
      ...client.appends
        .slice(before)
        .filter((append) => append.kind !== 'thinking')
        .map((append) => append.content.replace(/\s+/g, ' ').slice(0, 220)),
    );
  }
  operator.stop();
  return { routed, recorded: desk.recorded, said };
}

const snap = await snapshot();
projectNames = new Map(snap.projects.map((project) => [project.id, project.name]));
const only = new Set(flag('only').split(',').filter(Boolean));
const results: Array<{ scenario: Scenario; skipped?: string; routed?: OperatorAction[][]; recorded?: Recorded[]; said?: string[] }> = [];
for (const scenario of scenarios(snap)) {
  if (only.size && !only.has(scenario.name)) continue;
  const missing = scenario.needs.filter((id) => !id || !snap.items.some((item) => item.id === id || item.facts?.projectId === id));
  if (missing.length) {
    results.push({ scenario, skipped: 'its ids are not on the desk' });
    continue;
  }
  console.error(`… ${scenario.name}`);
  results.push({ scenario, ...(await run(scenario, snap)) });
}
const out = { at: new Date().toISOString(), snapshotAt: snap.at, desk: deskUrl, items: snap.items.length, results };
const file = flag('out');
if (file) fs.writeFileSync(file, JSON.stringify(out, null, 2));
for (const result of results) {
  console.log(`\n## ${result.scenario.name}: ${result.scenario.where}`);
  console.log(`said: ${result.scenario.turns.map((turn) => `“${turn}”`).join(' → ')}`);
  console.log(`expect: ${result.scenario.expect}`);
  if (result.skipped) {
    console.log(`SKIPPED: ${result.skipped}`);
    continue;
  }
  console.log(`router: ${JSON.stringify(result.routed)}`);
  console.log(`would do: ${result.recorded!.length ? result.recorded!.map((entry) => `${entry.kind} ${JSON.stringify(entry.detail)}`).join(' | ') : 'nothing'}`);
  for (const line of result.said!) console.log(`  operator ← ${line}`);
}
process.exit(0);
