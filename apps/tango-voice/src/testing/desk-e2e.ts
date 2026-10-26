// End-to-end voice scenarios against a copy of the live desk: the production LiveOperator with the real
// router (Codex Responses), a real DraftSession with compiler and end judge, pause, destination ask and
// "For me?", wired as live-operator-discord.ts wires them. Nothing speaks (FakeClient keeps what the voice
// model would be told) and nothing is sent: desk commands, draft and pause cards, Start work, agent-thread
// starts and agent turns are recorded, and any non-GET request to the desk throws. The List runs on the
// desk's own browser model (apps/screen/public/desk/next/model.js) over the snapshot, so "the third one"
// resolves against exactly the rows the desk shows.
//
//   npm run lab:desk-e2e -w @tango/tango-voice -- [--scenarios FILE] [--snapshot DIR] [--refresh] [--desk URL]
//                                                [--live-next] [--only ID,ID] [--out FILE] [--concurrency N]
//
// Scenarios name real conversations, so the owner's set lives outside this public repo
// (default ~/.tango/voice-e2e/scenarios.ts); desk-e2e-scenarios.example.ts shows the shape and covers the
// positional, tab, place and turn-taking phrases that need no names. The snapshot (default
// ~/.tango/voice-e2e/snap) is read once with GETs (--refresh re-reads it); item detail is read live, GET
// only, and so are search, capacity, the system brief and the catch-up walk (moves, project actions and catch-up acts are recorded). The queue ("what's waiting on me") is voice's own derivation over the snapshot unless --live-next
// reads the desk's /api/desk/next. Concurrency above 2-4 on the ChatGPT subscription hits 429s.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SimulatedAgentBackend } from '../live/agent-backend.js';
import { AddresseeAsk } from '../live/addressee.js';
import { DestinationAsk } from '../live/destination-ask.js';
import { deriveNextItems, HttpDeskClient, type DeskItemSummary, type ChapterVoicePlan } from '../live/desk-client.js';
import { createDraftCompiler, createDraftEndJudge, DraftSession } from '../live/draft-mode.js';
import { LivePlaybackClock, SpeechActivity } from '../live/live-audio.js';
import { chiefOfStaff, LiveOperator } from '../live/live-operator.js';
import { loadOperatorProfiles, resolveProfileAgents, selectOperatorProfile } from '../live/operator-profile.js';
import { PauseSession } from '../live/pause-mode.js';
import { createCodexResponsesCaller } from '../live/responses-caller.js';
import { createTaskExtractor } from '../live/task-extractor.js';
import { LabScreen } from './lab-isolation.js';
import { helpers, type DeskE2eScenario, type E2eRecord, type E2eRun, type E2eScenarioModule } from './desk-e2e-types.js';

const args = process.argv.slice(2);
const flag = (name: string, fallback = '') => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? (args[at + 1] ?? fallback) : fallback;
};
const has = (name: string) => args.includes(`--${name}`);
const home = (p: string) => p.replace(/^~(?=\/)/, os.homedir());

const profile = selectOperatorProfile(loadOperatorProfiles(), flag('operator') || undefined);
const BASE = (flag('desk') || profile.screenUrl || 'http://127.0.0.1:9410').replace(/\/$/, '');
const SNAP = home(flag('snapshot') || '~/.tango/voice-e2e/snap');
const SCENARIOS = home(flag('scenarios') || '~/.tango/voice-e2e/scenarios.ts');
const OUT = home(flag('out') || path.join(path.dirname(SNAP), 'e2e.json'));
const CONC = Number(flag('concurrency') || 4);

// ── read-only: nothing but GETs reaches the desk ─────────────────────────
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
  if (url.startsWith(BASE) && method !== 'GET') throw new Error(`desk-e2e is read-only: blocked ${method} ${url.slice(BASE.length)}`);
  return realFetch(input, init);
}) as typeof fetch;

// ── the snapshot ────────────────────────────────────────────────────────
const MODEL = pathToFileURL(path.resolve(import.meta.dirname, '../../../screen/public/desk/next/model.js')).href;
const listModel = (await import(MODEL)) as { nextListReport: (state: unknown) => any; tallyOf: (items: unknown[], now?: number) => { waiting: number } };
const { nextListReport } = listModel;

async function snapshot(): Promise<void> {
  if (!has('refresh') && fs.existsSync(path.join(SNAP, 'active.json'))) return;
  fs.mkdirSync(SNAP, { recursive: true });
  const reads: Record<string, string> = {
    active: '/api/desk/items?view=active&group=step',
    snoozed: '/api/desk/items?view=snoozed',
    history: '/api/desk/items?view=history',
    settings: '/api/desk/settings',
  };
  for (const [name, route] of Object.entries(reads)) {
    const response = await fetch(`${BASE}${route}`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`GET ${route}: HTTP ${response.status}`);
    fs.writeFileSync(path.join(SNAP, `${name}.json`), await response.text());
  }
}
await snapshot();
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(SNAP, `${name}.json`), 'utf8'));
const settings = read('settings');
const active: DeskItemSummary[] = read('active').items;
const lists = { active: { items: active, loaded: true }, snoozed: { items: read('snoozed').items, loaded: true }, history: { items: read('history').items, loaded: true } };
const listState = (route: any) => ({ now: Date.now(), projects: settings.projects, listViews: settings.listViews, listGroup: 'live', listCollapsed: [], labelOrder: settings.labelOrder, nextRoute: route, listTab: route.view ?? 'ready', nextPageViews: {}, lists });

// ── GPT-Live, silent: what it would be told is kept ─────────────────────
class FakeClient extends EventEmitter {
  appends: Array<{ kind: string; content: string; delegationId: string | null }> = [];
  /** Set by a scenario with role-played agent answers: the voice model speaks each relay. */
  speak: ((content: string) => void) | null = null;
  appendContext(kind: string, content: string, delegationId: string | null) {
    this.appends.push({ kind, content, delegationId });
    if (kind === 'commentary') this.speak?.(content);
    return Promise.resolve({ clientEventId: 'x' });
  }
  ask(id: string, words: string) {
    this.emit('inputTranscript', { delta: ` ${words}`, startMs: Date.now(), endMs: Date.now() });
    this.emit('delegation', { id, offsetMs: 0 });
  }
}

// ── the desk: snapshot reads, recorded writes ───────────────────────────
class SnapshotDesk extends HttpDeskClient {
  constructor(private readonly rec: E2eRecord[]) {
    super(BASE, {});
  }
  override async refresh() {
    (this as any).list = active;
    (this as any).projectList = settings.projects.filter((p: any) => !p.finishedAt).map((p: any) => ({ id: p.id, name: p.name }));
    return active;
  }
  override async next() {
    return has('live-next') ? super.next() : deriveNextItems(active);
  }
  override async command(type: any, itemId: string | undefined, args: Record<string, unknown> = {}) {
    this.rec.push({ kind: 'desk.command', data: { type, itemId, args } });
    return { commandId: 'sim', status: 'applied' as const };
  }
  override publishOperator() {}
  override publishDraft(card: any) {
    this.rec.push({ kind: 'desk.draft', data: { phase: card?.phase, target: card?.to ?? card?.destination ?? null, text: (card?.text ?? '').slice(0, 120) } });
  }
  override publishPause(card: any) {
    this.rec.push({ kind: 'desk.pause', data: card });
  }
  override trace(entry: any) {
    this.rec.push({ kind: 'trace', data: { kind: entry.kind, summary: entry.summary } });
  }
  override onDraftCommand() {}
  override onPauseCommand() {}
  override onPresentation() {}
  override offPresentation() {}
  override connect() {}
  override disconnect() {}
  override async startWork(request: any) {
    this.rec.push({ kind: 'desk.startWork', data: request });
    return { ok: true as const, threadId: 'sim-thread', itemId: 'loom:sim-thread', title: request.title ?? 'sim', account: 'Loom (best account)' };
  }
  override async moveAccount(itemId: string, account: string) {
    this.rec.push({ kind: 'desk.moveAccount', data: { itemId, account } });
    return { ok: true as const };
  }
  override async projectAction(projectId: string, action: any) {
    this.rec.push({ kind: 'desk.projectAction', data: { projectId, ...action } });
    return { ok: true as const, held: 0, acted: 0, stayed: 0 };
  }
  override async updatesSeen(ids: number[], via: 'heard' | 'read' | 'deferred', outcome: string | null = null) {
    this.rec.push({ kind: 'desk.updatesSeen', data: { ids, via, outcome } });
    return { ok: true as const };
  }
  override async chapterAct(spaceId: string, how: 'accept' | 'defer', plan: ChapterVoicePlan) {
    this.rec.push({ kind: 'desk.chapterAct', data: { spaceId, how, plan } });
    return { ok: true as const, applied: { took: [], fine: [], seen: 0 }, left: [], failed: [] };
  }
  override async decidedConfirm(decisionId: string) {
    this.rec.push({ kind: 'desk.decidedConfirm', data: { decisionId } });
    return { ok: true as const };
  }
  override async startAgentThread(request: any) {
    this.rec.push({ kind: 'desk.agentThread', data: request });
    return { ok: true as const, threadId: 'sim-agent-thread', itemId: 'loom:sim-agent-thread', title: request.title ?? 'sim' };
  }
}

// ── the screen: the desk's browser model over the snapshot (lab-isolation.ts LabScreen) ──
const simScreen = (rec: E2eRecord[], route: any, presentation?: any) => new LabScreen({ state: listState(route), report: nextListReport, presentation, record: (kind, data) => rec.push({ kind, data }) });

// ── one scenario ─────────────────────────────────────────────────────────
const { agents } = resolveProfileAgents(profile);
const models = createCodexResponsesCaller();
const baseExtractor = createTaskExtractor(models, { people: profile.people });

async function run(s: DeskE2eScenario): Promise<E2eRun> {
  const rec: E2eRecord[] = [];
  const actions: any[][] = [];
  let inflight = 0;
  let lastEvent = Date.now();
  const extractor = async (input: any) => {
    inflight++;
    try {
      const out = await baseExtractor(input);
      actions.push(out);
      return out;
    } finally {
      inflight--;
      lastEvent = Date.now();
    }
  };
  const client = new FakeClient();
  const screen = simScreen(rec, s.route ?? { page: 'inbox', view: 'ready' }, s.presentation);
  const startList = screen.listPage();
  const desk = new SnapshotDesk(rec);
  await desk.refresh();
  const answers = Object.fromEntries(Object.entries(s.agentAnswers ?? {}).map(([agent, texts]) => [agent, (request: { turn: number }) => [{ kind: 'result' as const, text: texts[Math.min(request.turn, texts.length - 1)]!, afterMs: 500 }]]));
  const backend = new SimulatedAgentBackend(answers);
  const playback = new LivePlaybackClock();
  if (s.agentAnswers) {
    // A relay is played (a second of audio) and its words transcribed, so the operator marks it heard.
    const LOUD = Buffer.alloc(48_000, 0);
    for (let i = 0; i < LOUD.length; i += 2) LOUD.writeInt16LE(i % 4 === 0 ? 4000 : -4000, i);
    client.speak = (content) => {
      if (!/ (reported back|said)\b/.test(content)) return;
      playback.enqueue(LOUD);
      client.emit('outputTranscript', { delta: ` ${content}`, startMs: 0, endMs: 0 });
    };
  }
  const quiet = s.quietMs ?? 10_000;
  const operator = new LiveOperator({
    client,
    agents,
    backend,
    extractor,
    userActivity: new SpeechActivity(),
    playback,
    policy: 'floor',
    floor: { settleMs: 300, speakTimeoutMs: 3000 },
    transcriptSettleMs: 50,
    desk,
    screen,
    defaultAgentId: chiefOfStaff(agents)?.id,
    draft: new DraftSession({ compile: createDraftCompiler(models, { people: profile.people }), judgeEnd: createDraftEndJudge(models) }),
    pause: new PauseSession({}),
    destination: new DestinationAsk({ now: () => Date.now() }),
    addressee: new AddresseeAsk({ now: () => Date.now() }),
    addresseeCheck: true,
    ownerSpeech: { lastAt: Date.now() - quiet, addressedAt: Date.now() - quiet },
    log: (event: string, data?: any) => {
      if (/^(dispatch|task|desk\.|draft|pause|thread|addressee|next|screen|list|delivered|routed\.)/.test(event)) rec.push({ kind: `log.${event}`, data });
      lastEvent = Date.now();
    },
  } as any);
  operator.start();
  for (const [i, phrase] of s.phrases.entries()) {
    if (i === s.phrases.length - 1 && i > 0 && s.waitSaid) {
      const t0 = Date.now();
      while (Date.now() - t0 < 60_000 && !client.appends.some((a) => s.waitSaid!.test(a.content))) await new Promise((r) => setTimeout(r, 300));
    }
    // A follow-up waits until the agent's answer was heard.
    if (i > 0 && s.agentAnswers) {
      const t0 = Date.now();
      while (Date.now() - t0 < 60_000 && !rec.some((x) => x.kind === 'log.delivered')) await new Promise((r) => setTimeout(r, 300));
    }
    client.ask(`${s.id}-${i}`, phrase);
    const started = Date.now();
    await new Promise((r) => setTimeout(r, 400));
    while (Date.now() - started < 45_000 && (inflight > 0 || Date.now() - lastEvent < 2500)) await new Promise((r) => setTimeout(r, 200));
  }
  // Let a draft's undo window (5 s) or a judge settle.
  await new Promise((r) => setTimeout(r, 6500));
  if (backend.sends.length) rec.push({ kind: 'agent.dispatch', data: backend.sends.map((x) => ({ agent: x.request.agentId, text: x.request.message.slice(0, 120) })) });
  operator.stop();
  const said = client.appends.filter((a) => a.kind === 'commentary').map((a) => a.content);
  return { rec, actions, said, screen, list: screen.listPage(), startList };
}

// ── run them ─────────────────────────────────────────────────────────────
const mod = (await import(pathToFileURL(SCENARIOS).href)) as E2eScenarioModule;
const scenarios = mod.scenarios({ listReport: (route) => nextListReport(listState(route)), active, settings, h: helpers, model: listModel });
const only = flag('only') ? flag('only').split(',') : null;
const todo = scenarios.filter((s) => !only || only.includes(s.id));
const out: any[] = [];
const queue = [...todo];
await Promise.all(
  Array.from({ length: CONC }, async () => {
    while (queue.length) {
      const s = queue.shift()!;
      try {
        const r = await run(s);
        const c = s.check(r);
        out.push({ id: s.id, group: s.group, phrases: s.phrases, expects: s.expects, ...c, actions: r.actions, recs: r.rec.filter((x) => x.kind !== 'trace').slice(0, 40), traces: r.rec.filter((x) => x.kind === 'trace').map((x) => `${x.data.kind}: ${x.data.summary}`).slice(0, 12), said: r.said.slice(-3) });
        console.log(`${c.result.toUpperCase()}  ${s.id}  ${s.phrases.join(' / ')}  — ${c.detail.slice(0, 220)}`);
      } catch (err) {
        out.push({ id: s.id, group: s.group, phrases: s.phrases, expects: s.expects, result: 'error', detail: String((err as Error).stack).slice(0, 400) });
        console.log(`ERROR ${s.id} ${(err as Error).message}`);
      }
    }
  }),
);
const passed = out.filter((r) => r.result === 'pass').length;
console.log(`\n${passed} / ${out.length} pass`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
// Any failure or error fails the run (Codex review on #715).
process.exit(passed === out.length ? 0 : 1);
