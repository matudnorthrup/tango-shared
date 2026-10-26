/**
 * A spoken session through the live audio path, without a person: phrases are synthesized
 * (TTS), Opus-encoded the way Discord delivers a speaker (48 kHz speaker, 20 ms packets), and
 * played in real time into the production operator wiring (live-operator-discord.ts: GPT-Live,
 * the router, draft, pause, destination ask, "For me?", the real desk and screens). The
 * operator's Opus output is decoded and recorded. Agents are role-played (nothing reaches a real
 * agent), and desk writes are fenced: a command, move or project action that names anything
 * outside --scratch is refused before it leaves, and nothing new is started.
 *
 * The session never takes the owner's desk input (lab-isolation.ts): it has a screen of its own (it never
 * holds the director link, so the owner's taps stay with the owner, and it never moves the owner's
 * screens), streams the desk as `?client=lab` (no Draft card or pause pill taps), hears only its scratch
 * items' events, and keeps its captions, Draft card and pause pill to itself. The desk fences the scratch
 * threads' agents in for the session too (POST /api/desk/lab-fence): they can't start threads or mail out.
 *
 *   node --env-file=.env --import tsx apps/tango-voice/src/testing/live-operator-tts.ts \
 *     --operator <id> --script steps.json --scratch loom:a,loom:b,project:p --out <dir>
 *
 * steps.json: [{ "id": "stop", "say": "stop that", "before": { "present": "loom:a" }, "waitMs": 20000 }]
 *   before.present  an item to put on the screens first (as if the owner opened it)
 *   before.list     a List place to show first ({ "page": "inbox", "view": "ready" })
 *   waitMs          the most to wait for the operator after the phrase (default 25 s)
 * Writes <out>/steps.json (per step: heard, said, router actions, desk calls, item changes,
 * latency) and <out>/operator.wav. Uses the profile's voice route; speaker TTS defaults to macOS say (no key). --tts openai explicitly opts into API TTS.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSpeakerTts } from './speaker-tts.js';
import { FillerGate, AddresseeAsk } from '../live/addressee.js';
import { DestinationAsk } from '../live/destination-ask.js';
import { DiscordAudioBridge, mono24ToSpeaker48, speaker48ToMono24 } from '../live/discord-audio-bridge.js';
import { createDraftCompiler, createDraftEndJudge, DraftSession } from '../live/draft-mode.js';
import type { LiveTranscriptDelta } from '../live/gpt-live-client.js';
import { LivePlaybackClock, pcmRms, SpeechActivity } from '../live/live-audio.js';
import { buildOperatorInstructions, LiveOperator, parseUrgentLane } from '../live/live-operator.js';
import { PauseSession } from '../live/pause-mode.js';
import { VoiceSessionMemory } from '../live/session-anchor.js';
import { parseArgs, resolveOperatorSetup, resolveProfileArg } from './live-operator-setup.js';
import { SimulatedLlmAgentBackend } from './simulated-llm-agents.js';
import { LabDesk, LabScreen, labFenceVerdict, type LabListState } from './lab-isolation.js';
import type { ListPage } from '../live/screen-director.js';

interface Step {
  id: string;
  /** Empty: say nothing and listen for the whole waitMs (what the operator volunteers at a break). */
  say: string;
  before?: { present?: string; list?: Record<string, string> };
  waitMs?: number;
}

const args = parseArgs(process.argv);
const apiKey = process.env.OPENAI_API_KEY ?? '';
const outDir = args.get('out') ?? join(process.cwd(), 'live-operator-tts');
mkdirSync(outDir, { recursive: true });
const steps = JSON.parse(readFileSync(args.get('script') ?? '', 'utf8')) as Step[];
const scratch = new Set((args.get('scratch') ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const profile = resolveProfileArg(args);
if (!profile) throw new Error('--operator is required: the session runs against that profile’s desk');
const setup = resolveOperatorSetup(args, apiKey, profile);
// The desk the client talks to (--screen, else the profile's screenUrl): the fence guards that one.
const deskUrl = args.get('screen') ?? setup.profile?.screenUrl;
if (!setup.operatorExtras.desk || !deskUrl || deskUrl === 'off') throw new Error('no desk: give the profile a screenUrl, or pass --screen <url>');
const BASE = deskUrl.replace(/\/$/, '');
const sessionId = `voice-tts-${new Date().toISOString()}`;

const t0 = Date.now();
type Event = { t: number; kind: string; data: Record<string, unknown> };
const events: Event[] = [];
const log = (kind: string, data: Record<string, unknown> = {}) => {
  events.push({ t: Date.now() - t0, kind, data });
  if (!['heard', 'said', 'append'].includes(kind)) console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${kind} ${JSON.stringify(data).slice(0, 200)}`);
};

// ── the fence: desk writes only touch scratch items and projects; nothing new starts; no owner input ──
const realFetch = globalThis.fetch;
const deskCalls: Array<{ t: number; method: string; path: string; body: unknown; blocked: string | null; status?: number }> = [];
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  if (!url.startsWith(BASE)) return realFetch(input, init);
  const path = url.slice(BASE.length);
  let body: any = null;
  try {
    body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
  } catch {
    body = null;
  }
  const blocked = labFenceVerdict({ method, path, body }, scratch);
  if (method === 'GET' && !blocked) return realFetch(input, init);
  const quiet = /^\/api\/desk\/(trace|lab-fence)/.test(path);
  const call = { t: Date.now() - t0, method, path, body: quiet ? undefined : body, blocked };
  if (!quiet || blocked) deskCalls.push(call);
  if (blocked) {
    log('fence.blocked', { method, path, reason: blocked });
    return new Response(JSON.stringify({ error: `blocked by the live test fence: ${blocked}` }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }
  const response = await realFetch(input, init);
  (call as { status?: number }).status = response.status;
  return response;
}) as typeof fetch;

// ── the lab's own screen and desk (lab-isolation.ts): the owner's taps can't reach this session ──
const getJson = async (route: string) => {
  const response = await realFetch(`${BASE}${route}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`GET ${route}: HTTP ${response.status}`);
  return response.json() as Promise<any>;
};
const listModel = (await import(pathToFileURL(resolve(import.meta.dirname, '../../../screen/public/desk/next/model.js')).href)) as { nextListReport: (state: unknown) => ListPage };
/** The List's data as the desk's browser holds it, read again before every List command. */
async function readLists(state: LabListState): Promise<void> {
  const [active, snoozed, history, settings] = await Promise.all(['/api/desk/items?view=active&group=step', '/api/desk/items?view=snoozed', '/api/desk/items?view=history', '/api/desk/settings'].map(getJson));
  Object.assign(state, { now: Date.now(), projects: settings.projects, listViews: settings.listViews, labelOrder: settings.labelOrder, lists: { active: { items: active.items, loaded: true }, snoozed: { items: snoozed.items, loaded: true }, history: { items: history.items, loaded: true } } });
}
const listState: LabListState = { nextRoute: { page: 'inbox', view: 'ready' }, listTab: 'ready', nextPageViews: {}, listGroup: 'live', listCollapsed: [] };
await readLists(listState);
const screen = new LabScreen({ state: listState, report: listModel.nextListReport, refresh: readLists, relay: { now: Date.now }, record: (kind, data) => log(kind, data) });
const desk = new LabDesk(BASE, { scratch, screen, record: (kind, data) => log(kind, data) }, { log: (event, data) => console.log(`[desk] ${event} ${JSON.stringify(data ?? {})}`) });

// The desk fences the scratch threads' agents in while this runs (renewed; it lapses on its own if this dies).
const fenceItems = [...scratch].filter((id) => !id.startsWith('project:'));
const setFence = async (): Promise<boolean> => {
  if (!fenceItems.length) return true;
  const response = await fetch(`${BASE}/api/desk/lab-fence`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, scratch: fenceItems, ttlMs: 180_000 }) }).catch(() => null);
  if (!response?.ok) log('lab-fence.unavailable', { status: response?.status ?? null });
  return response?.ok === true;
};
// Fail closed: without the desk's fence the scratch threads' agents could start threads or mail real ones.
if (!(await setFence())) throw new Error(`the desk at ${BASE} did not take the lab fence (POST /api/desk/lab-fence): it needs a build with lab fences; nothing was started`);
const fenceTimer = setInterval(() => void setFence(), 60_000);
// JSON content type: the desk refuses any mutating /api/desk request without it (requireJsonPosts).
const clearFence = async () => {
  if (!fenceItems.length) return;
  const response = await fetch(`${BASE}/api/desk/lab-fence/${encodeURIComponent(sessionId)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } }).catch(() => null);
  if (!response?.ok) console.warn(`[lab] the desk didn't clear the lab fence (${response?.status ?? 'unreachable'}); it lapses on its own within 3 minutes`);
};
process.once('SIGINT', () => void clearFence().finally(() => process.exit(130)));

const synth = createSpeakerTts({ provider: args.get('tts'), apiKey, cacheDir: join(tmpdir(), 'tango-voice-tts'), fetch: realFetch });

async function snapshotItem(id: string): Promise<Record<string, unknown> | null> {
  if (id.startsWith('project:')) {
    const settings = (await (await realFetch(`${BASE}/api/desk/settings`)).json()) as { projects: Array<Record<string, unknown>> };
    return settings.projects.find((p) => p.id === id.slice('project:'.length)) ?? { deleted: true };
  }
  const response = await realFetch(`${BASE}/api/desk/items/${encodeURIComponent(id)}`);
  if (!response.ok) return null;
  const { item } = (await response.json()) as { item: Record<string, any> };
  const capacity = (await (await realFetch(`${BASE}/api/desk/capacity`)).json().catch(() => null)) as { accounts?: Array<{ id: string; threads: Array<{ itemId: string }> }> } | null;
  const seat = capacity?.accounts?.find((account) => account.threads.some((thread) => thread.itemId === id))?.id ?? null;
  return {
    seat,
    place: item.place,
    labels: item.labels,
    seen: item.seen,
    disposition: item.disposition,
    snoozeUntil: item.snoozeUntil,
    busy: item.status?.busy ?? null,
    unread: item.status?.unread ?? null,
    pinned: item.facts?.pinned ?? item.pinned ?? null,
    title: item.facts?.name ?? null,
    projectId: item.facts?.projectId ?? null,
    account: item.facts?.loom?.account ?? item.facts?.account ?? null,
  };
}
const diff = (a: Record<string, unknown> | null, b: Record<string, unknown> | null) => {
  const out: Record<string, [unknown, unknown]> = {};
  for (const key of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
    if (['createdAt'].includes(key)) continue;
    if (JSON.stringify(a?.[key]) !== JSON.stringify(b?.[key])) out[key] = [a?.[key], b?.[key]];
  }
  return out;
};

// ── the production wiring, minus Discord (live-operator-discord.ts startSession/startBrain) ──
const libopus = await import('libopus-wasm');
const speakerEncoder = await libopus.createEncoder({ application: libopus.Application.Voip, channels: 2, sampleRate: 48_000, frameSize: 960 });
const listenerDecoder = await libopus.createDecoder({ channels: 2, sampleRate: 48_000 });
const bridge = new DiscordAudioBridge();
await bridge.init();
const memory = new VoiceSessionMemory(join(outDir, 'session-anchor.json'), { fresh: true, now: Date.now() });
const draft = new DraftSession({ compile: createDraftCompiler(setup.models, { people: setup.profile?.people }), judgeEnd: createDraftEndJudge(setup.models), log });
const pause = new PauseSession({ log, cutAudio: () => bridge.clearOutput() });
const destination = new DestinationAsk({ now: () => Date.now() });
const live = setup.route.create();
const userActivity = new SpeechActivity();
const playback = new LivePlaybackClock();
const fillerGate = new FillerGate({ log, onClose: () => { bridge.clearOutput(); playback.cut(); } });
const addressee = new AddresseeAsk({ now: () => Date.now() });
const ownerSpeech = { lastAt: Date.now(), addressedAt: Date.now() };
const backend = new SimulatedLlmAgentBackend({ call: setup.models, agents: setup.agents, minDelayMs: 3000, maxDelayMs: 6000 });
const dispatches: Array<{ t: number; agent: string; message: string }> = [];
const sim = backend.send.bind(backend);
backend.send = (request, onUpdate) => {
  dispatches.push({ t: Date.now() - t0, agent: request.agentId, message: request.message.slice(0, 200) });
  sim(request, onUpdate);
};

const said: Array<{ t: number; delta: string }> = [];
const heard: Array<{ t: number; delta: string }> = [];
live.on('audio', (pcm: Buffer) => {
  const voiced = pcmRms(pcm) >= 350;
  if (!pause.admitAudio(voiced)) return;
  if (!fillerGate.admitAudio(voiced)) return;
  playback.enqueue(pcm);
  bridge.pushOutput(pcm);
});
live.on('inputTranscript', (delta: LiveTranscriptDelta) => {
  if (pause.active) return;
  heard.push({ t: Date.now() - t0, delta: delta.delta });
  fillerGate.heard(delta.delta);
});
live.on('outputTranscript', (delta: LiveTranscriptDelta) => said.push({ t: Date.now() - t0, delta: delta.delta }));
bridge.on('frame', (pcm: Buffer) => {
  userActivity.observe(pcm);
  live.appendAudio(pcm);
});
const received: Buffer[] = [];
let firstVoicedAt: number | null = null;
const drain = setInterval(() => {
  // One packet per tick, at Discord's pace: the stream makes a packet whenever it is read.
  const packet = bridge.output.read() as Buffer | null;
  if (!packet) return;
  const pcm = speaker48ToMono24(listenerDecoder.decode(packet, { maxFrameSize: 5760 }));
  if (firstVoicedAt === null && pcmRms(pcm) > 300) firstVoicedAt = Date.now() - t0;
  received.push(pcm);
}, 20);

const operator = new LiveOperator({
  client: live,
  agents: setup.agents,
  backend,
  extractor: setup.extractor,
  userActivity,
  playback,
  policy: 'floor',
  ...setup.operatorExtras,
  // Never the setup's HttpScreenDirector / HttpDeskClient: those hold the owner's director link and operator stream.
  screen,
  desk,
  sessionStartedAt: memory.startedAt,
  answeredTurns: memory,
  urgentLane: parseUrgentLane(process.env.TANGO_OPERATOR_URGENT),
  // Lab only: a shorter personal-flow window, so a knock after a role-played exchange fits a short script.
  ...(Number(process.env.TANGO_LAB_PERSONAL_FLOW_MS) > 0 ? { personalFlowMs: Number(process.env.TANGO_LAB_PERSONAL_FLOW_MS) } : {}),
  draft,
  pause,
  destination,
  addressee,
  ownerSpeech,
  fillerGate,
  addresseeCheck: process.env.TANGO_OPERATOR_FOR_ME !== 'off',
  log,
  traceSessionId: sessionId,
});
await live.start({ instructions: buildOperatorInstructions(setup.agents), voice: setup.voice });
operator.start();
bridge.start();
log('session.start', { route: setup.route.label, scratch: [...scratch] });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Plays speech as a Discord speaker would: 20 ms Opus packets in real time, then no packets. */
async function speak(text: string): Promise<{ start: number; end: number }> {
  const pcm = await synth(text);
  const start = Date.now() - t0;
  ownerSpeech.lastAt = Date.now();
  let next = Date.now();
  for (let offset = 0; offset < pcm.length; offset += 960) {
    const frame = Buffer.alloc(960);
    pcm.copy(frame, 0, offset, Math.min(offset + 960, pcm.length));
    const { speaker } = mono24ToSpeaker48(frame);
    void bridge.pushOpus('speaker-1', Buffer.from(speakerEncoder.encode(speaker, { frameSize: 960 })));
    next += 20;
    await sleep(Math.max(0, next - Date.now()));
  }
  ownerSpeech.lastAt = Date.now();
  return { start, end: Date.now() - t0 };
}

const text = (deltas: Array<{ t: number; delta: string }>, from: number, to: number) =>
  deltas.filter((d) => d.t >= from && d.t < to).map((d) => d.delta).join('').replace(/\s+/g, ' ').trim();

await sleep(4000); // the greeting-free start settles
const results: unknown[] = [];
for (const step of steps) {
  if (step.before?.present) {
    // The item's own conversation key, as production presents it (a Discord thread's is thread:<id>).
    const prepared = await desk.item(step.before.present);
    await screen.present({ view: 'conversation', itemId: step.before.present, ...(prepared?.conversationKey ? { conversationKey: prepared.conversationKey } : {}), reason: 'user' });
    await sleep(1500);
  }
  if (step.before?.list) {
    await screen.present({ view: 'active', reason: 'user' });
    await screen.command('list_place', step.before.list);
    await sleep(1500);
  }
  const before = new Map(await Promise.all([...scratch].map(async (id) => [id, await snapshotItem(id)] as const)));
  const mark = { events: events.length, calls: deskCalls.length, dispatches: dispatches.length };
  firstVoicedAt = null;
  const listenOnly = !step.say;
  const spoken = listenOnly ? { start: Date.now() - t0, end: Date.now() - t0 } : await speak(step.say);
  const waitMs = step.waitMs ?? 25_000;
  // Done when the operator has spoken and gone quiet for 6 s ("Checking." comes well before the answer), or nothing happens for the whole wait.
  for (const until = Date.now() + waitMs; Date.now() < until; ) {
    await sleep(500);
    const lastSaid = said.at(-1)?.t ?? 0;
    const now = Date.now() - t0;
    if (!listenOnly && lastSaid > spoken.end && now - lastSaid > 6000 && !playback.isSpeaking(Date.now()) && operator.isIdle()) break;
  }
  await sleep(1500);
  const end = Date.now() - t0;
  const after = new Map(await Promise.all([...scratch].map(async (id) => [id, await snapshotItem(id)] as const)));
  const changes = Object.fromEntries([...scratch].map((id) => [id, diff(before.get(id) ?? null, after.get(id) ?? null)]).filter(([, d]) => Object.keys(d as object).length));
  const stepEvents = events.slice(mark.events).filter((e) => !['heard', 'said', 'append'].includes(e.kind));
  const firstDesk = deskCalls.slice(mark.calls).find((c) => !c.path.startsWith('/api/desk/presentation') && !c.path.startsWith('/api/command'));
  const firstSaid = said.find((d) => d.t > spoken.end);
  const result = {
    id: step.id,
    say: step.say,
    heard: text(heard, spoken.start, end),
    said: text(said, spoken.end - 500, end),
    actions: stepEvents.filter((e) => e.kind === 'extracted').map((e) => e.data),
    events: stepEvents.map((e) => ({ t: e.t - spoken.end, kind: e.kind, data: JSON.stringify(e.data).slice(0, 400) })),
    deskCalls: deskCalls.slice(mark.calls).map((c) => ({ ...c, t: c.t - spoken.end })),
    dispatches: dispatches.slice(mark.dispatches),
    changes,
    presentation: { view: screen.presentation().view, itemId: screen.presentation().itemId },
    latency: {
      speechMs: spoken.end - spoken.start,
      firstWordsMs: firstSaid ? firstSaid.t - spoken.end : null,
      firstAudioMs: firstVoicedAt !== null ? firstVoicedAt - spoken.end : null,
      firstDeskWriteMs: firstDesk ? firstDesk.t - spoken.end : null,
    },
  };
  results.push(result);
  console.log(`STEP ${step.id}: heard "${result.heard}" → said "${result.said.slice(0, 160)}" · changes ${JSON.stringify(changes).slice(0, 200)}`);
  writeFileSync(join(outDir, 'steps.json'), JSON.stringify(results, null, 1));
  await sleep(1500);
}

clearInterval(drain);
clearInterval(fenceTimer);
await clearFence();
operator.stop();
draft.end();
pause.end();
await live.close().catch(() => null);
bridge.stop();
await (desk as { flushTrace?: () => Promise<void> }).flushTrace?.();
const pcm = Buffer.concat(received);
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVEfmt ', 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(24_000, 24);
header.writeUInt32LE(48_000, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);
writeFileSync(join(outDir, 'operator.wav'), Buffer.concat([header, pcm]));
// What stayed in the lab instead of reaching the owner (or coming from them).
const isolation = { ignoredItemEvents: Object.fromEntries(desk.ignored), operatorUpdatesKept: desk.operatorUpdates, draftCardsKept: desk.drafts.length, pauseCardsKept: desk.pauses.length, blocked: deskCalls.filter((c) => c.blocked).length };
console.log(`isolation ${JSON.stringify(isolation)}`);
writeFileSync(join(outDir, 'events.json'), JSON.stringify({ events, deskCalls, dispatches, heard, said, isolation }, null, 1));
console.log(`done: ${results.length} steps → ${join(outDir, 'steps.json')}`);
process.exit(0);
