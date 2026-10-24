/**
 * Live operator lab: drives a real GPT-Live session with a scripted, synthesized
 * user and simulated Tango agents, then writes recordings, event timelines, and
 * an HTML report.
 *
 *   node --import tsx apps/tango-voice/src/testing/live-operator-lab.ts \
 *     --out /path/to/dir [--only s1,s5] [--voice compass]
 *
 * Defaults to the ChatGPT login and local macOS say. --operator <id> uses profile auth.
 * --auth api and --tts openai explicitly opt into paid API calls (OPENAI_API_KEY).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createSpeakerTts } from './speaker-tts.js';
import { resolveProfileArg } from './live-operator-setup.js';
import { join } from 'node:path';
import {
  SerializedAgentBackend,
  SimulatedAgentBackend,
  TangoVoiceTurnBackend,
  type AgentBackend,
  type AgentDescriptor,
  type AgentTaskRequest,
  type AgentUpdate,
  type SimulatedHandler,
  type SimulatedSendRecord,
} from '../live/agent-backend.js';
import { READ_ONLY_GUARD, resolveRealTestAgents } from './real-test-agents.js';
import { DiscordThreadDirectory } from '../live/discord-threads.js';
import { LIVE_BYTES_PER_MS, LIVE_SAMPLE_RATE } from '../live/gpt-live-client.js';
import { resolveLiveRoute } from '../live/create-live-client.js';
import { LiveInputPump, LivePlaybackClock, SpeechActivity } from '../live/live-audio.js';
import { buildOperatorInstructions, LiveOperator, type DeliveryPolicy } from '../live/live-operator.js';
import { createTaskExtractor, createVoiceSummarizer } from '../live/task-extractor.js';
import { resolveResponsesCaller } from '../live/responses-caller.js';

const apiKey = process.env.OPENAI_API_KEY ?? '';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1] ?? '');
const outDir = args.get('out') ?? join(process.cwd(), 'live-operator-lab-out');
const only = args.get('only')?.split(',').filter(Boolean);
const auth = args.get('auth') ?? resolveProfileArg(args)?.auth ?? 'codex';
const route = resolveLiveRoute(auth, apiKey);
// Routing, summaries, and simulated agents bill the same account as the voice.
const models = resolveResponsesCaller(auth, apiKey);
const voice = args.get('voice') ?? route.defaultVoice;
const ttsCacheDir = join(outDir, '.tts-cache');
mkdirSync(ttsCacheDir, { recursive: true });

const AGENTS: AgentDescriptor[] = [
  { id: 'watson', name: 'Watson', role: 'personal assistant: email, calendar, finances, code reviews and PRs' },
  { id: 'sierra', name: 'Sierra', role: 'research and travel: routes, fuel, places, product comparisons' },
  { id: 'juliet', name: 'Juliet', role: 'home and family logistics: appointments, errands, scheduling' },
];

// ---------------------------------------------------------------------------
// Synthesized user speech (local by default, cached on disk)

const synth = createSpeakerTts({ provider: args.get('tts'), apiKey, cacheDir: ttsCacheDir });

// ---------------------------------------------------------------------------
// Scenario plumbing

interface TimelineEvent {
  t: number;
  kind: string;
  [key: string]: unknown;
}

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

interface ScenarioContext {
  say(text: string): Promise<void>;
  /** Start speaking without waiting; resolves when the audio has been sent. */
  sayAsync(text: string): Promise<{ done: Promise<void> }>;
  waitForOperator(options?: { quietMs?: number; timeoutMs?: number }): Promise<boolean>;
  waitFor(label: string, predicate: () => boolean, timeoutMs: number): Promise<boolean>;
  waitForEvent(kind: string, timeoutMs: number, predicate?: (event: TimelineEvent) => boolean): Promise<TimelineEvent | undefined>;
  sleep(ms: number): Promise<void>;
  note(text: string): void;
  check(name: string, pass: boolean, detail?: string): void;
  backend: LabBackend;
  operator: LiveOperator;
  events: TimelineEvent[];
  operatorSaid(sinceT?: number): string;
  /** Operator lines (with start times) including the one still being spoken. */
  operatorLines(sinceT?: number): Array<{ t: number; text: string }>;
  t(): number;
}

interface LabBackend extends AgentBackend {
  sends: SimulatedSendRecord[];
  release(tag: string): void;
}

/** Real Tango agents behind a recorder, so checks can see what was sent. */
class RecordingRealBackend implements LabBackend {
  readonly sends: SimulatedSendRecord[] = [];
  constructor(private readonly inner: AgentBackend) {}
  send(request: AgentTaskRequest, onUpdate: (update: AgentUpdate) => void): void {
    this.sends.push({ request, at: Date.now() });
    this.inner.send(request, onUpdate);
  }
  release(): void {}
}

const runId = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
let realAgents: ReturnType<typeof resolveRealTestAgents> | null = null;

/** Threads under the test clones' -test channels. (New replies are the desk's job; the lab has no desk.) */
function realOperatorExtras() {
  realAgents ??= resolveRealTestAgents();
  const token = process.env.DISCORD_TOKEN ?? '';
  const guildId = process.env.DISCORD_GUILD_ID ?? '';
  return {
    ...(token && guildId
      ? {
          threads: new DiscordThreadDirectory({ token, guildId, homeChannels: realAgents.homeChannels }),
        }
      : {}),
    summarize: createVoiceSummarizer(models),
    homeChannelFor: (agentId: string) => realAgents!.homeChannels.get(agentId),
  };
}

async function archiveThread(threadId: string): Promise<void> {
  await fetch(`https://discord.com/api/v10/channels/${threadId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ archived: true }),
  });
}
function createRealBackend(log: (event: string, data?: Record<string, unknown>) => void): LabBackend {
  realAgents ??= resolveRealTestAgents();
  const agents = realAgents;
  return new RecordingRealBackend(
    new SerializedAgentBackend(new TangoVoiceTurnBackend({
      endpoint: agents.bridgeUrl,
      apiKey: agents.bridgeApiKey,
      sessionIdFor: (agentId) => `live-operator-lab-${agentId}-${runId}`,
      channelIdFor: (agentId) => agents.channelIdFor(agentId),
      preface: READ_ONLY_GUARD,
      summarize: createVoiceSummarizer(models),
    }), log),
  );
}

interface Scenario {
  /** Use real Tango test agents through the voice bridge instead of simulated ones. */
  real?: boolean;
  id: string;
  title: string;
  question: string;
  policy: DeliveryPolicy;
  handlers: Record<string, SimulatedHandler>;
  run(ctx: ScenarioContext): Promise<void>;
}

interface ScenarioResult {
  scenario: Scenario;
  events: TimelineEvent[];
  checks: Check[];
  durationMs: number;
  usage: unknown;
  wavFile: string;
  error?: string;
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const t0 = Date.now();
  const t = () => Date.now() - t0;
  const events: TimelineEvent[] = [];
  const checks: Check[] = [];
  const record = (kind: string, data: Record<string, unknown> = {}) => {
    events.push({ t: t(), kind, ...data });
    const brief = JSON.stringify(data);
    console.log(`[${scenario.id} ${(t() / 1000).toFixed(1)}s] ${kind} ${brief.length > 220 ? `${brief.slice(0, 220)}…` : brief}`);
  };

  const client = route.create();
  const userActivity = new SpeechActivity();
  const playback = new LivePlaybackClock();
  const userFrames: Array<{ at: number; pcm: Buffer }> = [];
  const operatorChunks: Array<{ at: number; pcm: Buffer }> = [];
  const pump = new LiveInputPump((pcm) => client.appendAudio(pcm));
  pump.on('frame', (pcm: Buffer, at: number) => {
    userActivity.observe(pcm, at);
    userFrames.push({ at, pcm });
  });
  client.on('audio', (pcm: Buffer) => operatorChunks.push({ at: playback.enqueue(pcm), pcm }));

  let outputLine = '';
  let outputLineT = 0;
  const flushOutput = () => {
    if (outputLine.trim()) events.push({ t: outputLineT, kind: 'operator.said', text: outputLine.trim() });
    outputLine = '';
  };
  let lastOutputAt = 0;
  client.on('outputTranscript', (delta: { delta: string }) => {
    if (Date.now() - lastOutputAt > 1500) {
      flushOutput();
      outputLineT = t();
    }
    lastOutputAt = Date.now();
    outputLine += delta.delta;
  });
  let inputLine = '';
  let inputLineT = 0;
  let lastInputAt = 0;
  client.on('inputTranscript', (delta: { delta: string }) => {
    if (Date.now() - lastInputAt > 1500 && inputLine.trim()) {
      events.push({ t: inputLineT, kind: 'live.heard', text: inputLine.trim() });
      inputLine = '';
    }
    if (!inputLine) inputLineT = t();
    lastInputAt = Date.now();
    inputLine += delta.delta;
  });
  client.on('closed', ({ reason }: { reason: string }) => record('live.closed', { reason }));

  const backend: LabBackend = scenario.real ? createRealBackend(record) : new SimulatedAgentBackend(scenario.handlers);
  const agents = scenario.real ? (realAgents ??= resolveRealTestAgents()).agents : AGENTS;
  const operator = new LiveOperator({
    client,
    agents,
    backend,
    extractor: createTaskExtractor(models),
    userActivity,
    playback,
    policy: scenario.policy,
    isUserSpeaking: () => pump.pendingMs > 0,
    ...(scenario.real ? realOperatorExtras() : {}),
    log: record,
  });

  const ctx: ScenarioContext = {
    async say(text) {
      const { done } = await ctx.sayAsync(text);
      await done;
    },
    async sayAsync(text) {
      const pcm = await synth(text);
      const startsIn = pump.pendingMs;
      pump.push(pcm);
      record('user.says', { text, ms: Math.round(pcm.length / LIVE_BYTES_PER_MS) });
      const done = sleep(startsIn + pcm.length / LIVE_BYTES_PER_MS + 150);
      return { done };
    },
    async waitForOperator({ quietMs = 1600, timeoutMs = 30_000 } = {}) {
      const since = Date.now();
      return ctx.waitFor(
        'operator reply',
        () => playback.activity.lastVoiceAt > since && playback.quietForMs() >= quietMs,
        timeoutMs,
      );
    },
    async waitFor(label, predicate, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(100);
      }
      record('wait.timeout', { label, timeoutMs });
      return false;
    },
    sleep,
    note: (text) => record('note', { text }),
    check(name, pass, detail = '') {
      checks.push({ name, pass, detail });
      record('check', { name, pass, detail });
    },
    backend,
    operator,
    events,
    operatorSaid(sinceT = 0) {
      const done = events
        .filter((event) => event.kind === 'operator.said' && event.t >= sinceT)
        .map((event) => String(event.text));
      if (outputLine.trim() && outputLineT >= sinceT) done.push(outputLine.trim());
      return done.join(' ');
    },
    operatorLines(sinceT = 0) {
      const lines = events
        .filter((event) => event.kind === 'operator.said' && event.t >= sinceT)
        .map((event) => ({ t: event.t, text: String(event.text) }));
      if (outputLine.trim() && outputLineT >= sinceT) lines.push({ t: outputLineT, text: outputLine.trim() });
      return lines;
    },
    async waitForEvent(kind, timeoutMs, predicate = () => true) {
      const from = events.length;
      let found: TimelineEvent | undefined;
      await ctx.waitFor(kind, () => (found = events.slice(from).find((event) => event.kind === kind && predicate(event))) !== undefined, timeoutMs);
      return found;
    },
    t,
  };

  let usage: unknown = null;
  let error: string | undefined;
  try {
    await client.start({ instructions: buildOperatorInstructions(agents), voice });
    record('live.started', { sessionId: client.sessionId, route: route.label, policy: scenario.policy });
    pump.start();
    operator.start();
    await sleep(800);
    await scenario.run(ctx);
    await sleep(1500);
  } catch (err) {
    error = (err as Error).stack ?? String(err);
    record('scenario.error', { message: (err as Error).message });
  } finally {
    operator.stop();
    pump.stop();
    usage = await client.close().catch(() => null);
    flushOutput();
    if (inputLine.trim()) events.push({ t: inputLineT, kind: 'live.heard', text: inputLine.trim() });
    events.sort((a, b) => a.t - b.t);
  }

  const wavFile = `${scenario.id}.wav`;
  writeFileSync(join(outDir, wavFile), mixSpeaker(userFrames, operatorChunks, t0));
  writeFileSync(join(outDir, `${scenario.id}.events.json`), JSON.stringify({ events, checks, usage }, null, 2));
  return { scenario, events, checks, durationMs: t(), usage, wavFile, error };
}

/** Speaker WAV: user on the left, operator on the right. */
function mixSpeaker(user: Array<{ at: number; pcm: Buffer }>, operator: Array<{ at: number; pcm: Buffer }>, t0: number): Buffer {
  const endMs = Math.max(
    ...user.map((frame) => frame.at + frame.pcm.length / LIVE_BYTES_PER_MS),
    ...operator.map((chunk) => chunk.at + chunk.pcm.length / LIVE_BYTES_PER_MS),
    t0,
  );
  const samples = Math.ceil(((endMs - t0) * LIVE_SAMPLE_RATE) / 1000);
  const data = Buffer.alloc(samples * 4);
  const place = (chunks: Array<{ at: number; pcm: Buffer }>, channel: 0 | 1) => {
    for (const chunk of chunks) {
      const startSample = Math.round(((chunk.at - t0) * LIVE_SAMPLE_RATE) / 1000);
      for (let i = 0; i < chunk.pcm.length / 2; i++) {
        const index = startSample + i;
        if (index < 0 || index >= samples) continue;
        data.writeInt16LE(chunk.pcm.readInt16LE(i * 2), index * 4 + channel * 2);
      }
    }
  };
  place(user, 0);
  place(operator, 1);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(LIVE_SAMPLE_RATE, 24);
  header.writeUInt32LE(LIVE_SAMPLE_RATE * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const dispatchesTo = (ctx: ScenarioContext, agentId: string) =>
  ctx.backend.sends.filter((send) => send.request.agentId === agentId);
const mentions = (text: string, word: string) => text.toLowerCase().includes(word.toLowerCase());

// ---------------------------------------------------------------------------
// Scenarios

const SCENARIOS: Scenario[] = [
  {
    id: 's1-basic',
    title: 'Basic dispatch and report-back',
    question: 'Does "ask Sierra to…" trigger a delegation we can route, and is the result spoken back with attribution?',
    policy: 'floor',
    handlers: {
      sierra: () => [{ kind: 'result', afterMs: 12_000, text: 'Cheapest diesel on the way is the Pilot in Cedar Flat at $4.19 a gallon, about 80 miles in. Fill up there; prices climb after Ashford.' }],
    },
    async run(ctx) {
      await ctx.say('Hey, can you ask Sierra to find the cheapest diesel between Midway and Ashford?');
      const dispatched = await ctx.waitForEvent('dispatch', 15_000);
      await ctx.waitForOperator();
      const ackText = ctx.operatorSaid();
      ctx.check('dispatched to Sierra', dispatchesTo(ctx, 'sierra').length === 1, JSON.stringify(dispatchesTo(ctx, 'sierra').map((s) => s.request.message)));
      ctx.check('operator acknowledged hand-off', mentions(ackText, 'sierra'), ackText);
      // The hand-off and the result can come out in one breath, so look from dispatch on.
      const sinceT = dispatched?.t ?? 0;
      await ctx.waitFor('Sierra result spoken', () => mentions(ctx.operatorSaid(sinceT), 'pleasant hill') || mentions(ctx.operatorSaid(sinceT), '4.19'), 40_000);
      await ctx.waitForOperator({ timeoutMs: 10_000 });
      const said = ctx.operatorSaid(sinceT);
      ctx.check('result spoken', mentions(said, 'pleasant hill') || mentions(said, '4.19'), said);
      ctx.check('result attributed to Sierra', mentions(said, 'sierra'), said);
    },
  },
  {
    id: 's2-long-task',
    title: 'Long-running delegation (2.5 minutes)',
    question: 'Can a client delegation stay open for minutes and still accept progress and a final spoken result?',
    policy: 'floor',
    handlers: {
      watson: () => [
        { kind: 'progress', afterMs: 60_000, text: 'Found 14 bank emails so far, still reading.' },
        { kind: 'result', afterMs: 90_000, text: 'Two things from the bank: your autopay to the credit card failed on the 28th, and there is a new fraud alert on the Visa ending 4417 that needs a yes or no.' },
      ],
    },
    async run(ctx) {
      await ctx.say('Ask Watson to go through my email from the last week and summarize anything from the bank.');
      await ctx.waitForOperator();
      await ctx.sleep(4000);
      await ctx.say('While he does that, what is a good quick lunch I can make with eggs and tortillas?');
      await ctx.waitForOperator({ timeoutMs: 40_000 });
      await ctx.waitForEvent('agent.update', 90_000, (event) => event.updateKind === 'progress');
      await ctx.sleep(8000);
      const statusT = ctx.t();
      await ctx.say('How is Watson coming along with the bank stuff?');
      await ctx.waitForEvent('append', 20_000, (event) => event.channel === 'commentary');
      await ctx.waitForOperator({ timeoutMs: 20_000 });
      const statusSaid = ctx.operatorSaid(statusT);
      ctx.check('status question answered from progress', mentions(statusSaid, '14') || mentions(statusSaid, 'fourteen') || mentions(statusSaid, 'still'), statusSaid);
      ctx.note('user goes quiet');
      const sinceT = ctx.t();
      const ok = await ctx.waitFor('Watson result spoken', () => mentions(ctx.operatorSaid(sinceT), 'autopay') || mentions(ctx.operatorSaid(sinceT), 'fraud'), 200_000);
      await ctx.waitForOperator({ timeoutMs: 15_000 });
      const said = ctx.operatorSaid(sinceT);
      const appendErrors = ctx.events.filter((event) => event.kind === 'append.error');
      ctx.check('final result spoken after ~150s', ok, said);
      ctx.check('no append errors on the old delegation', appendErrors.length === 0, JSON.stringify(appendErrors));
      const beforeStatus = ctx.events.filter((event) => event.kind === 'operator.said' && event.t < statusT).map((event) => String(event.text)).join(' ');
      ctx.check('progress not volunteered before the user asked', !mentions(beforeStatus, '14') && !mentions(beforeStatus, 'fourteen'), beforeStatus);
    },
  },
  {
    id: 's3-concurrent',
    title: 'Three agents at once',
    question: 'Can several delegations be open at once, and do results that land close together queue cleanly?',
    policy: 'floor',
    handlers: {
      sierra: () => [{ kind: 'result', afterMs: 14_000, text: 'The Granite Hills are open; the overlook trail is about half a mile and the road is paved the whole way.' }],
      watson: () => [{ kind: 'result', afterMs: 16_000, text: 'You are free Saturday until 3, then the soccer game at 4.' }],
      juliet: () => [{ kind: 'result', afterMs: 18_000, text: 'The vet can take the dog Monday at 9:30 or Tuesday at 1.' }],
    },
    async run(ctx) {
      await ctx.say('Okay, three things. Sierra, check if the Granite Hills are open this weekend.');
      await ctx.sleep(1200);
      await ctx.say('Watson, what does my Saturday look like?');
      await ctx.sleep(1200);
      await ctx.say('And Juliet, find me a vet appointment for the dog early next week.');
      await ctx.waitForOperator();
      const sinceT = ctx.t();
      await ctx.waitFor('all three spoken', () => {
        const said = ctx.operatorSaid(sinceT);
        return (mentions(said, 'painted') || mentions(said, 'overlook')) && (mentions(said, 'saturday') || mentions(said, 'soccer')) && (mentions(said, 'vet') || mentions(said, 'monday'));
      }, 90_000);
      await ctx.waitForOperator({ timeoutMs: 15_000 });
      const delegations = ctx.events.filter((event) => event.kind === 'delegation').length;
      ctx.check('one task per agent', ['sierra', 'watson', 'juliet'].every((id) => dispatchesTo(ctx, id).length === 1), `delegation events: ${delegations}`);
      const releases = ctx.events.filter((event) => event.kind === 'release');
      ctx.check('all three released one at a time', releases.length === 3, releases.map((r) => `${r.agent}@${(r.t / 1000).toFixed(1)}s waited ${r.waitedMs}ms`).join(', '));
      const said = ctx.operatorSaid(sinceT);
      ctx.check('all three spoken', (mentions(said, 'painted') || mentions(said, 'overlook')) && (mentions(said, 'saturday') || mentions(said, 'soccer')) && (mentions(said, 'vet') || mentions(said, 'monday')), said);
    },
  },
  {
    id: 's4-mid-sentence',
    title: 'Result arrives while the user is mid-sentence (no queue)',
    question: 'With no queueing, what does GPT-Live do when a result lands while the user is talking?',
    policy: 'immediate',
    handlers: {
      sierra: () => [{ kind: 'result', releaseTag: 'sierra', text: 'The city aquarium is open until 6 today and tickets are $29.95 for adults.' }],
    },
    async run(ctx) {
      await ctx.say('Ask Sierra when the aquarium in Riverton closes today.');
      await ctx.waitForOperator();
      const { done } = await ctx.sayAsync(
        'Also, I have been thinking about the trip next month. I want to go down the coast, maybe stop in Lakeview for a night, then cut inland toward Fernwood and come back inland, but I am not sure whether that is too much driving for one weekend, so I want to think that through.',
      );
      await ctx.sleep(3000);
      const releasedAt = ctx.t();
      ctx.note('releasing Sierra result while user is still talking');
      ctx.backend.release('sierra');
      await done;
      const userDoneAt = ctx.t();
      await ctx.waitForOperator({ timeoutMs: 30_000 });
      // Backchannels ("mm-hmm") are expected; relaying the result is not.
      const during = ctx.operatorLines(releasedAt).filter((line) => line.t < userDoneAt - 300 && line.text.split(/\s+/).length > 3);
      ctx.check('operator did not relay over the user', during.length === 0, during.map((line) => `${(line.t / 1000).toFixed(1)}s ${line.text}`).join(' | ') || 'only backchannels until user finished');
      const said = ctx.operatorSaid(releasedAt);
      ctx.check('aquarium result eventually spoken', mentions(said, '6') || mentions(said, 'six') || mentions(said, '29'), said);
    },
  },
  {
    id: 's5-queue-floor',
    title: 'Hold Juliet until the Watson discussion wraps (bridge-managed queue)',
    question: 'Can we hold a result that lands mid-discussion and deliver it after, as "Okay, now Juliet said…"?',
    policy: 'floor',
    handlers: {
      watson: (request) =>
        !/comment|approve/i.test(request.message)
          ? [{ kind: 'result', afterMs: 6000, text: 'PR 412 review: two issues. The retry loop in the uploader has no backoff, and the new settings page is missing a loading state. Otherwise it looks good to merge.' }]
          : [{ kind: 'result', afterMs: 5000, text: 'Got it, I will leave the comment about the backoff and approve once it is fixed.' }],
      juliet: (request) =>
        request.turn === 0
          ? [{ kind: 'question', releaseTag: 'juliet', text: 'The plumber can come Thursday between 10 and noon. Want me to book it?' }]
          : [{ kind: 'result', afterMs: 4000, text: 'Booked the plumber for Thursday, 10 to noon.' }],
    },
    async run(ctx) {
      await ctx.say('Ask Watson to review PR 412, and have Juliet find a plumber for the kitchen sink.');
      await ctx.waitForOperator();
      const watsonT = ctx.t();
      await ctx.waitFor('Watson review spoken', () => mentions(ctx.operatorSaid(watsonT), 'backoff') || mentions(ctx.operatorSaid(watsonT), 'retry'), 40_000);
      await ctx.waitForOperator({ timeoutMs: 20_000 });
      await ctx.say('Hmm, the backoff one matters. What did he say about the settings page?');
      ctx.note('Juliet result lands mid-discussion');
      const julietArrivedT = ctx.t();
      ctx.backend.release('juliet');
      await ctx.waitForOperator({ timeoutMs: 20_000 });
      await ctx.say('Okay. Tell Watson to leave a comment about the backoff and approve once that is fixed.');
      await ctx.waitForOperator({ timeoutMs: 20_000 });
      const discussionEndT = ctx.t();
      await ctx.waitFor('Juliet spoken', () => mentions(ctx.operatorSaid(julietArrivedT), 'plumber') || mentions(ctx.operatorSaid(julietArrivedT), 'thursday'), 60_000);
      await ctx.waitForOperator({ timeoutMs: 20_000 });
      const julietLine = ctx.operatorLines(julietArrivedT).find((line) => mentions(line.text, 'plumber') || mentions(line.text, 'thursday'));
      ctx.check('Juliet held until discussion ended', !!julietLine && julietLine.t >= discussionEndT - 2000, julietLine ? `spoken at ${(julietLine.t / 1000).toFixed(1)}s; discussion ended ${(discussionEndT / 1000).toFixed(1)}s` : 'never spoken');
      ctx.check('Juliet attributed with a transition', !!julietLine && mentions(String(julietLine.text), 'juliet'), String(julietLine?.text ?? ''));
      await ctx.waitFor('Watson ack spoken', () => mentions(ctx.operatorSaid(discussionEndT), 'comment') || mentions(ctx.operatorSaid(discussionEndT), 'approve'), 30_000);
      ctx.check('follow-up routed back to Watson', dispatchesTo(ctx, 'watson').length === 2, JSON.stringify(dispatchesTo(ctx, 'watson').map((s) => s.request.message)));
      await ctx.say('Yes, book Thursday.');
      await ctx.waitForOperator({ timeoutMs: 20_000 });
      ctx.check('booking answer routed to Juliet', dispatchesTo(ctx, 'juliet').length === 2, JSON.stringify(dispatchesTo(ctx, 'juliet').map((s) => s.request.message)));
    },
  },
  {
    id: 's5b-queue-model',
    title: 'Same as s5, but GPT-Live decides when (model-managed)',
    question: 'If we just tell GPT-Live "hold this until the topic wraps", does it?',
    policy: 'model',
    handlers: {} as Record<string, SimulatedHandler>,
    async run(ctx) {
      await SCENARIOS.find((s) => s.id === 's5-queue-floor')!.run(ctx);
    },
  },
  {
    id: 's6-question-back',
    title: 'Agent asks the user a question',
    question: 'When an agent needs input, does the question get asked and the answer routed back to the same agent?',
    policy: 'floor',
    handlers: {
      juliet: (request) =>
        request.turn === 0
          ? [{ kind: 'question', afterMs: 8000, text: 'the dentist has Tuesday at 10 or Wednesday at 3:30. Which works?' }]
          : [{ kind: 'result', afterMs: 5000, text: `Booked. ${request.message.toLowerCase().includes('wed') ? 'Wednesday at 3:30' : 'Tuesday at 10'} with the dentist, and it is on your calendar.` }],
    },
    async run(ctx) {
      await ctx.say('Have Juliet get me a dentist appointment next week.');
      await ctx.waitForOperator();
      const sinceT = ctx.t();
      await ctx.waitFor('question asked', () => mentions(ctx.operatorSaid(sinceT), 'tuesday') || mentions(ctx.operatorSaid(sinceT), 'wednesday'), 40_000);
      await ctx.waitForOperator({ timeoutMs: 20_000 });
      ctx.check('question put to the user', mentions(ctx.operatorSaid(sinceT), 'tuesday') && mentions(ctx.operatorSaid(sinceT), 'wednesday'), ctx.operatorSaid(sinceT));
      await ctx.say('Wednesday works.');
      const answerT = ctx.t();
      await ctx.waitFor('confirmation spoken', () => mentions(ctx.operatorSaid(answerT), 'booked') || mentions(ctx.operatorSaid(answerT), '3:30') || mentions(ctx.operatorSaid(answerT), 'calendar'), 40_000);
      await ctx.waitForOperator({ timeoutMs: 15_000 });
      const sends = dispatchesTo(ctx, 'juliet');
      ctx.check('answer routed to Juliet as a reply', sends.length === 2 && sends[1].request.turn === 1, JSON.stringify(sends.map((s) => s.request)));
      ctx.check('confirmation spoken', mentions(ctx.operatorSaid(answerT), 'wednesday') || mentions(ctx.operatorSaid(answerT), '3:30'), ctx.operatorSaid(answerT));
    },
  },
  {
    id: 's7-cut-off',
    title: 'User cuts off an update; it comes back later',
    question: 'If the user talks over an update before it is relayed, does the operator notice and deliver it again?',
    policy: 'floor',
    handlers: {
      sierra: () => [{ kind: 'result', afterMs: 6000, text: 'The Fairview farmers market runs Sundays from 10 to 2 at Central Park, through the end of October.' }],
      watson: () => [{ kind: 'result', afterMs: 5000, text: 'Your next Costco run would be cheapest on Wednesday; the gas there is 30 cents under town.' }],
    },
    async run(ctx) {
      await ctx.say('Ask Sierra when the Fairview farmers market is on.');
      await ctx.waitForOperator();
      const release = await ctx.waitForEvent('release', 30_000, (event) => event.agent === 'sierra');
      await ctx.sleep(500);
      ctx.note('user cuts in over the Sierra update');
      await ctx.say('Oh wait, before that, have Watson figure out the best day for a Costco run.');
      await ctx.waitForOperator({ timeoutMs: 20_000 });
      const sinceT = release?.t ?? 0;
      await ctx.waitFor('market spoken', () => mentions(ctx.operatorSaid(sinceT), 'sunday') || mentions(ctx.operatorSaid(sinceT), 'central park'), 60_000);
      await ctx.waitFor('costco spoken', () => mentions(ctx.operatorSaid(sinceT), 'wednesday'), 60_000);
      await ctx.waitForOperator({ timeoutMs: 15_000 });
      const said = ctx.operatorSaid(sinceT);
      const retries = ctx.events.filter((event) => event.kind === 'delivery.retry' || event.kind === 'delivered');
      ctx.check('Watson dispatched from the interruption', dispatchesTo(ctx, 'watson').length === 1, JSON.stringify(dispatchesTo(ctx, 'watson').map((s) => s.request.message)));
      ctx.check('market update eventually heard', mentions(said, 'sunday') || mentions(said, 'central park'), said);
      ctx.check('Costco update heard', mentions(said, 'wednesday'), said);
      ctx.check('delivery tracking recorded', retries.length > 0, retries.map((event) => `${event.kind} ${event.agent} ${event.reason ?? event.how ?? ''}`).join(', '));
    },
  },
  {
    id: 'r1-real-research',
    real: true,
    title: 'Real agent: Sierra research',
    question: 'Does a real Tango agent (sierra-ollama via /voice/turn) get the task and is its actual answer relayed?',
    policy: 'floor',
    handlers: {},
    async run(ctx) {
      await ctx.say('Ask Sierra what time the city aquarium in Riverton closes today.');
      await ctx.waitForOperator();
      const sends = dispatchesTo(ctx, 'sierra-ollama');
      ctx.check('dispatched to sierra-ollama', sends.length === 1, JSON.stringify(sends.map((s) => s.request.message)));
      const update = await ctx.waitForEvent('agent.update', 300_000, (event) => event.agent === 'sierra-ollama');
      ctx.check('real agent replied', !!update && !String(update.text).startsWith("I couldn't finish"), String(update?.text ?? 'no reply in 300s'));
      const delivered = await ctx.waitForEvent('delivered', 60_000, (event) => event.agent === 'sierra-ollama');
      await ctx.waitForOperator({ timeoutMs: 20_000 });
      ctx.check('reply relayed and confirmed heard', !!delivered, ctx.operatorSaid(update?.t ?? 0));
      const dispatched = ctx.events.find((event) => event.kind === 'dispatch' && event.agent === 'sierra-ollama');
      if (dispatched && update) ctx.note(`real agent turn took ${((update.t - dispatched.t) / 1000).toFixed(1)}s`);
    },
  },
  {
    id: 'r2-real-parallel',
    real: true,
    title: 'Real agents: Watson and Sierra in parallel, chat while waiting',
    question: 'Do two real agents run concurrently, does small talk stay with the operator, and do both answers come back one at a time?',
    policy: 'floor',
    handlers: {},
    async run(ctx) {
      await ctx.say('Have Watson tell me what is on my calendar tomorrow, and ask Sierra for the weather forecast in Ashford this weekend.');
      await ctx.waitForOperator();
      await ctx.sleep(3000);
      await ctx.say('While they work, quick question. How many ounces are in a cup?');
      await ctx.waitForOperator({ timeoutMs: 20_000 });
      const chatAnswer = ctx.operatorSaid(ctx.t() - 15_000);
      ctx.check('operator answered small talk itself', mentions(chatAnswer, 'eight') || mentions(chatAnswer, '8'), chatAnswer);
      ctx.check('one task each, nothing extra', dispatchesTo(ctx, 'watson-ollama').length === 1 && dispatchesTo(ctx, 'sierra-ollama').length === 1 && ctx.backend.sends.length === 2,
        JSON.stringify(ctx.backend.sends.map((s) => `${s.request.agentId}: ${s.request.message}`)));
      const both = await ctx.waitFor('both delivered', () => ctx.events.filter((event) => event.kind === 'delivered').length >= 2, 300_000);
      await ctx.waitForOperator({ timeoutMs: 20_000 });
      const releases = ctx.events.filter((event) => event.kind === 'release');
      ctx.check('both real answers relayed', both, releases.map((r) => `${r.agent} waited ${(Number(r.waitedMs) / 1000).toFixed(1)}s`).join(', '));
      ctx.check('released one at a time', releases.length >= 2 && releases[1].t - releases[0].t > 2000, releases.map((r) => `${(r.t / 1000).toFixed(1)}s`).join(' → '));
    },
  },
  {
    id: 'r3-real-followup',
    real: true,
    title: 'Real agent: question and follow-up in the same session',
    question: 'When a real agent asks something, does the answer go back to it with its context intact?',
    policy: 'floor',
    handlers: {},
    async run(ctx) {
      await ctx.say('Ask Malibu to suggest a workout for me today. Tell him to ask me how much time I have before he picks one.');
      await ctx.waitForOperator();
      const first = await ctx.waitForEvent('agent.update', 300_000, (event) => event.agent === 'malibu-ollama');
      await ctx.waitForEvent('delivered', 60_000, (event) => event.agent === 'malibu-ollama');
      await ctx.waitForOperator({ timeoutMs: 20_000 });
      ctx.check('Malibu asked a question', first?.updateKind === 'question', String(first?.text ?? ''));
      await ctx.say('About thirty minutes, and I would like to keep it low impact.');
      await ctx.waitForOperator({ timeoutMs: 20_000 });
      const sends = dispatchesTo(ctx, 'malibu-ollama');
      ctx.check('answer sent back to the same Malibu task', sends.length === 2 && sends[1].request.turn === 1 && sends[1].request.taskId === sends[0].request.taskId,
        JSON.stringify(sends.map((s) => s.request)));
      const second = await ctx.waitForEvent('agent.update', 300_000, (event) => event.agent === 'malibu-ollama');
      await ctx.waitForEvent('delivered', 60_000, (event) => event.agent === 'malibu-ollama');
      await ctx.waitForOperator({ timeoutMs: 20_000 });
      ctx.check('follow-up used the context (30 min / low impact)', !!second && (mentions(String(second.text), '30') || mentions(String(second.text), 'thirty') || mentions(String(second.text), 'low')), String(second?.text ?? ''));
    },
  },
  {
    id: 'r4-real-busy-agent',
    real: true,
    title: 'Real agent: second request while the first is still running',
    question: 'Does a follow-up to a busy agent wait its turn instead of crashing into the running turn?',
    policy: 'floor',
    handlers: {},
    async run(ctx) {
      await ctx.say('Ask Sierra to plan a day trip to Lakeport tomorrow, with drive times from the coast.');
      // Follow up as soon as she's on it, so the second request lands while the first turn runs.
      await ctx.waitForEvent('dispatch', 20_000);
      await ctx.say('Oh, and tell her to add a Costco stop and a couple of lunch options to that plan.');
      await ctx.waitForOperator({ timeoutMs: 20_000 });
      const done = await ctx.waitFor('both answered', () => ctx.events.filter((event) => event.kind === 'agent.update' && event.agent === 'sierra-ollama').length >= 2 || ctx.events.filter((event) => event.kind === 'delivered').length >= 2, 400_000);
      await ctx.waitForOperator({ timeoutMs: 30_000 });
      const updates = ctx.events.filter((event) => event.kind === 'agent.update').map((event) => String(event.text));
      ctx.check('no canned error relayed', !ctx.operatorSaid(0).toLowerCase().includes('having trouble') && !updates.some((text) => text.includes("having trouble")), updates.map((text) => text.slice(0, 80)).join(' | '));
      const firstReply = ctx.events.find((event) => event.kind === 'agent.update')?.t ?? Infinity;
      const overlapped = ctx.events.filter((event) => event.kind === 'dispatch').some((event, index) => index > 0 && event.t < firstReply);
      ctx.check('follow-up waited for the first turn', !overlapped || ctx.events.some((event) => ['agent.waiting', 'dedupe'].includes(event.kind)), ctx.events.filter((event) => ['agent.waiting', 'dedupe', 'agent.retry'].includes(event.kind)).map((event) => event.kind).join(', ') || 'no overlap happened');
      ctx.check('Sierra answered', done, `${updates.length} updates`);
    },
  },
  {
    id: 'r5-real-threads',
    real: true,
    title: 'Real agent: start a thread, follow up in it, read back',
    question: 'Can the operator create and use threads and read text back verbatim?',
    policy: 'floor',
    handlers: {},
    async run(ctx) {
      if (!process.env.DISCORD_TOKEN) throw new Error('run with --env-file pointing at the tango-voice .env (DISCORD_TOKEN, DISCORD_GUILD_ID)');
      await ctx.say('Start a thread with Sierra about a weekend camping trip near Ashford, and ask her for two campground options.');
      const created = await ctx.waitForEvent('thread.created', 30_000);
      await ctx.waitFor('first dispatch', () => ctx.events.some((event) => event.kind === 'dispatch'), 30_000);
      const dispatch1 = ctx.events.find((event) => event.kind === 'dispatch');
      ctx.check('thread created for Sierra', !!created && created.agent === 'sierra-ollama', JSON.stringify(created ?? {}));
      ctx.check('first request went into the new thread', !!dispatch1 && dispatch1.thread === created?.title, JSON.stringify(dispatch1 ?? {}));
      await ctx.waitForEvent('delivered', 300_000, (event) => event.agent === 'sierra-ollama');
      await ctx.waitForOperator({ timeoutMs: 20_000 });
      const firstAnswer = ctx.operatorSaid(dispatch1?.t ?? 0);
      ctx.check('answer attributed to the thread', /thread/i.test(firstAnswer) || /camp|pinecrest/i.test(firstAnswer), firstAnswer.slice(0, 300));

      await ctx.say('In that thread, also ask her how long the drive is from the coast.');
      const dispatch2 = await ctx.waitForEvent('dispatch', 30_000, (event) => event.t > (dispatch1?.t ?? 0));
      ctx.check('follow-up stayed in the same thread', !!dispatch2 && dispatch2.thread === created?.title, JSON.stringify(dispatch2 ?? {}));
      await ctx.waitForEvent('delivered', 300_000, (event) => event.agent === 'sierra-ollama' && event.t > (dispatch2?.t ?? 0));
      await ctx.waitForOperator({ timeoutMs: 20_000 });

      const threadId = String(created?.threadId ?? '');
      const before = ctx.t();
      await ctx.say('Can you read me Sierra\'s full answer about the drive, word for word?');
      const readback = await ctx.waitForEvent('readback', 30_000);
      await ctx.waitForEvent('delivered', 60_000, (event) => event.itemKind === 'readback');
      await ctx.waitForOperator({ timeoutMs: 30_000 });
      ctx.check('read back on request', !!readback, `${JSON.stringify(readback ?? {})} :: ${ctx.operatorSaid(before).slice(0, 300)}`);
      if (threadId) await archiveThread(threadId);
    },
  },
  {
    id: 's8-slow-talker',
    title: 'Slow talker: long pauses mid-thought',
    question: 'Does the operator wait through 2.5–3.5 s thinking pauses instead of answering a half-finished thought?',
    policy: 'floor',
    handlers: {
      watson: () => [{ kind: 'result', afterMs: 8000, text: 'It is the amplifier: the wiring tests fine, but the unit drops its Bluetooth profile on ignition.' }],
    },
    async run(ctx) {
      const start = ctx.t();
      await ctx.say("So I've been thinking about the Bike speaker, and, um,");
      await ctx.sleep(2500);
      await ctx.say("I'm not sure if it's the wiring or if it's the amplifier itself,");
      await ctx.sleep(3500);
      const lastStart = ctx.t();
      await ctx.say('so can you ask Watson to figure out which one it is?');
      await ctx.waitForEvent('dispatch', 20_000);
      await ctx.waitForOperator({ timeoutMs: 20_000 });
      const interjections = ctx.operatorLines(start).filter((line) => line.t < lastStart);
      ctx.check('silent through the thinking pauses', interjections.length === 0, JSON.stringify(interjections));
      ctx.check('dispatched once to Watson', dispatchesTo(ctx, 'watson').length === 1, JSON.stringify(dispatchesTo(ctx, 'watson').map((s) => s.request.message)));
    },
  },
  {
    id: 's9-pause-room-talk',
    title: 'Pause, room talk, resume',
    question: 'After "Yankee, pause", room talk, and "Yankee, I\'m back": is nothing said or sent during the pause, and does the operator leave the room talk alone after resuming?',
    policy: 'floor',
    handlers: {},
    async run(ctx) {
      await ctx.say('Yankee, pause.');
      await ctx.waitForEvent('pause.start', 15_000);
      await ctx.waitForOperator({ timeoutMs: 10_000 });
      const pausedT = ctx.t();
      await ctx.sleep(2000);
      await ctx.say('Did the package come today? We should call them tonight about the weekend.');
      await ctx.sleep(4000);
      await ctx.say('Also, can you take out the trash before dinner?');
      await ctx.sleep(4000);
      // Talk that sounds aimed at the operator (the live 10/09 miss: "I wasn't ignoring you…").
      await ctx.say("Hey, are you ignoring me? Why aren't you answering me?");
      await ctx.sleep(6000);
      const duringPause = ctx.operatorSaid(pausedT);
      const resumeT = ctx.t();
      await ctx.say("Yankee, I'm back.");
      await ctx.waitForEvent('pause.resume', 15_000);
      await ctx.waitForOperator({ timeoutMs: 15_000 });
      await ctx.sleep(5000);
      const afterResume = ctx.operatorSaid(resumeT);
      const roomTalk = ['package', 'mom', 'mother', 'trash', 'dinner', 'weekend', 'ignor', 'answer'];
      ctx.check('silent during the pause', duringPause.trim().length === 0, duringPause);
      ctx.check('nothing sent to an agent', ctx.backend.sends.length === 0, ctx.backend.sends.map((send) => send.request.message).join(' | '));
      ctx.check('room talk left alone after resuming', !roomTalk.some((word) => mentions(afterResume, word)), afterResume);
      ctx.check('short resume ("Back.")', afterResume.split(/\s+/).filter(Boolean).length <= 12, afterResume);
    },
  },
];
SCENARIOS.find((s) => s.id === 's5b-queue-model')!.handlers = SCENARIOS.find((s) => s.id === 's5-queue-floor')!.handlers;

// ---------------------------------------------------------------------------

const selected = SCENARIOS.filter((scenario) =>
  only ? only.includes(scenario.id) || only.some((prefix) => scenario.id.startsWith(prefix)) : !scenario.real,
);
const results: ScenarioResult[] = [];
for (const scenario of selected) {
  console.log(`\n=== ${scenario.id}: ${scenario.title}`);
  results.push(await runScenario(scenario));
}
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(results.map((result) => ({
  id: result.scenario.id,
  title: result.scenario.title,
  policy: result.scenario.policy,
  durationMs: result.durationMs,
  checks: result.checks,
  usage: result.usage,
  error: result.error,
})), null, 2));
for (const result of results) {
  const passed = result.checks.filter((check) => check.pass).length;
  console.log(`${result.scenario.id}: ${passed}/${result.checks.length} checks, ${(result.durationMs / 1000).toFixed(0)}s${result.error ? ' ERROR' : ''}`);
}
process.exit(0);
