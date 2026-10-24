/**
 * Live end-to-end check of the operator directing the screen: a scripted
 * speaker talks to real GPT-Live, the operator routes to real agents (the
 * -ollama test clones by default), agents stage scenes on the running screen
 * service, and a real browser watches the screen page.
 *
 *   node --env-file=apps/tango-voice/.env --import tsx apps/tango-voice/src/testing/live-operator-screen-smoke.ts \
 *     --auth codex --agents test --screen http://127.0.0.1:9410 \
 *     --page https://<host>/tango-screen/ --out <dir>
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import type { LiveTranscriptDelta } from '../live/gpt-live-client.js';
import { LivePlaybackClock, SpeechActivity } from '../live/live-audio.js';
import { buildOperatorInstructions, LiveOperator } from '../live/live-operator.js';
import { parseArgs, resolveOperatorSetup } from './live-operator-setup.js';

const args = parseArgs(process.argv);
const apiKey = process.env.OPENAI_API_KEY ?? '';
const outDir = args.get('out') ?? join(process.cwd(), 'live-operator-screen-smoke');
mkdirSync(outDir, { recursive: true });
args.set('agents', args.get('agents') ?? 'test');
const screenUrl = args.get('screen') ?? 'http://127.0.0.1:9410';
args.set('screen', screenUrl);
const pageUrl = args.get('page') ?? `${screenUrl}/`;
const setup = resolveOperatorSetup(args, apiKey);
const agentId = (base: string) => setup.agents.find((agent) => agent.id === base || agent.id === `${base}-ollama`)?.id ?? base;
const SIERRA = agentId('sierra');
const MALIBU = agentId('malibu');

const t0 = Date.now();
// Agent sessions are live-operator-<agent>-<runTag>; state written under them is undone at the end.
const runTag = `screen-smoke-${t0}`;
const events: string[] = [];
const log = (kind: string, data: Record<string, unknown> = {}) => {
  const line = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${kind} ${JSON.stringify(data).slice(0, 300)}`;
  events.push(line);
  console.log(line);
};

async function synth(text: string): Promise<Buffer> {
  const path = join(outDir, `${createHash('sha1').update(text).digest('hex').slice(0, 12)}.pcm`);
  if (existsSync(path)) return readFileSync(path);
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'onyx', input: text, response_format: 'pcm' }),
  });
  if (!response.ok) throw new Error(`TTS ${response.status}`);
  const pcm = Buffer.from(await response.arrayBuffer());
  writeFileSync(path, pcm);
  return pcm;
}

interface Status {
  screens: unknown[];
  operatorLive: boolean;
  showing: { id: string; agentId: string; title: string; summary: string; choices: Array<{ id: string; label: string }> } | null;
  stages: Array<{ agentId: string; scenes: Array<{ id: string; summary: string }> }>;
}
const status = async (): Promise<Status> => (await fetch(`${screenUrl}/api/status`)).json() as Promise<Status>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(label: string, timeoutMs: number, probe: () => Promise<T | null | undefined | false>): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(1000);
  }
  log('timeout', { label });
  return null;
}

// The screen, as a person would have it open.
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
await page.goto(`${pageUrl}?name=smoke`);
let shot = 0;
const screenshot = async (name: string) => {
  shot += 1;
  const file = join(outDir, `${String(shot).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  log('screenshot', { file });
};
await sleep(1000);
await screenshot('dashboard-before');

const live = setup.route.create();
const userActivity = new SpeechActivity();
const playback = new LivePlaybackClock();
let said = '';
live.on('audio', (pcm: Buffer) => playback.enqueue(pcm));
live.on('outputTranscript', (delta: LiveTranscriptDelta) => (said += delta.delta));
const operator = new LiveOperator({
  client: live,
  agents: setup.agents,
  backend: setup.createBackend(runTag, log),
  extractor: setup.extractor,
  userActivity,
  playback,
  policy: 'floor',
  ...setup.operatorExtras,
  log,
});
await live.start({ instructions: buildOperatorInstructions(setup.agents), voice: setup.voice });
operator.start();
log('live.started', { route: setup.route.label, agents: setup.agents.map((agent) => agent.id) });

/** Real-time 24 kHz PCM in 20 ms frames, then half a second of silence. */
async function speak(text: string): Promise<void> {
  const pcm = await synth(text);
  log('user.says', { text });
  const frame = 960;
  for (let offset = 0; offset < pcm.length + 24_000; offset += frame) {
    const chunk = Buffer.alloc(frame);
    if (offset < pcm.length) pcm.copy(chunk, 0, offset, Math.min(offset + frame, pcm.length));
    userActivity.observe(chunk);
    live.appendAudio(chunk);
    await sleep(20);
  }
}
const saidSince = (mark: number) => said.slice(mark);
const sierraTasks = () => operator.tasks.filter((task) => task.agent.id === SIERRA);

const checks: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail: string) => {
  checks.push([name, pass, detail]);
  log(pass ? 'PASS' : 'FAIL', { name, detail: detail.slice(0, 200) });
};

await sleep(2000);
check('screen page connected', (await status()).screens.length > 0, JSON.stringify((await status()).screens));

// 1. Sierra stages a shortlist; the operator shows it when the result comes back.
let mark = said.length;
await speak('Can you ask Sierra to put a shortlist of three good portable speakers with Bluetooth on the screen, so I can pick one?');
const sierraUp = await waitFor('sierra scene showing', 420_000, async () => {
  const current = await status();
  return current.showing?.agentId === SIERRA ? current.showing : null;
});
check('Sierra staged a scene and the operator put it on screen', !!sierraUp, JSON.stringify(sierraUp ?? (await status()).stages));
check('Sierra scene has choices', (sierraUp?.choices.length ?? 0) >= 2, JSON.stringify(sierraUp?.choices ?? []));
await waitFor('operator relayed Sierra', 90_000, async () => /screen/i.test(saidSince(mark)));
await sleep(6000);
await screenshot('sierra-shortlist');
check('operator mentioned the screen', /screen/i.test(saidSince(mark)), saidSince(mark));

// 2. Picking by voice: "the second one" becomes a reply to Sierra's task naming the choice.
const second = sierraUp?.choices[1]?.label ?? '';
mark = said.length;
const turnsBefore = sierraTasks().reduce((sum, task) => sum + task.turn, 0);
await speak("Let's go with the second one.");
const voicePick = await waitFor('voice pick reached Sierra', 60_000, async () =>
  sierraTasks().reduce((sum, task) => sum + task.turn, 0) > turnsBefore ? sierraTasks().at(-1) : null,
);
const pickDispatch = events.filter((line) => line.includes(' dispatch ') && line.includes('"turn":1')).at(-1) ?? '';
const firstLabel = sierraUp?.choices[0]?.label ?? '\u0000';
check(
  '"the second one" sent to Sierra as the second choice',
  !!voicePick && !!second && pickDispatch.includes(second) && !pickDispatch.includes(firstLabel),
  `${second} :: ${pickDispatch}`,
);
await waitFor('Sierra answered the pick', 300_000, async () => sierraTasks().at(-1)?.status !== 'running');
await sleep(4000);

// 3. Tapping: a choice on the screen arrives as the user's reply.
const turnsBeforeTap = sierraTasks().reduce((sum, task) => sum + task.turn, 0);
const frame = page.frames().find((candidate) => candidate.url().includes('/frame/'));
let tapped = false;
if (frame) {
  const target = await frame.$('[data-choice]');
  if (target) {
    await target.click();
    tapped = true;
  }
}
// Agents sometimes swap the list for a "confirmed" view after a pick; then there is nothing to tap.
const replaced = frame && !tapped;
check('scene has tappable choices (or the agent replaced the list)', tapped || !!replaced, frame ? frame.url() : 'no scene frame');
if (tapped) {
  await sleep(1500);
  await screenshot('tap-ack');
  const tapReply = await waitFor('tap reached Sierra', 30_000, async () =>
    sierraTasks().reduce((sum, task) => sum + task.turn, 0) > turnsBeforeTap ? true : null,
  );
  check('tap arrived as a reply on Sierra\'s task', !!tapReply, events.filter((line) => line.includes('screen.input')).join(' | '));
  await waitFor('Sierra answered the tap', 300_000, async () => sierraTasks().at(-1)?.status !== 'running');
  await sleep(4000);
}

// 4. Focus moves to Malibu: its scene replaces Sierra's (banner transition).
mark = said.length;
await speak('Now ask Malibu to show my calories and protein so far today on the screen.');
const malibuUp = await waitFor('malibu scene showing', 420_000, async () => {
  const current = await status();
  return current.showing?.agentId === MALIBU ? current.showing : null;
});
check('focus moved to Malibu and its scene is up', !!malibuUp, JSON.stringify(malibuUp ?? (await status()).showing));
await sleep(5000);
await screenshot('malibu-macros');

// 5. Voice screen command: bring Sierra's list back.
await speak("Put Sierra's speaker list back up.");
const sierraBack = await waitFor('sierra back on screen', 60_000, async () => {
  const current = await status();
  return current.showing?.agentId === SIERRA ? current.showing : null;
});
check('voice command brought Sierra back', !!sierraBack, JSON.stringify((await status()).showing));
await sleep(2500);
await screenshot('sierra-again');

operator.stop();
await live.close().catch(() => null);
await page.goto(`${pageUrl}?name=smoke`);
await sleep(1000);
await browser.close();

// The test clones' turns still run the post-turn state reconciler, which writes to the
// shared state store (projects, next actions). Undo whatever this run wrote.
try {
  const { StateService } = await import('@tango/core');
  const db = new DatabaseSync(join(homedir(), '.tango', 'profiles', process.env.TANGO_PROFILE || 'default', 'data', 'tango.sqlite'));
  db.exec('PRAGMA busy_timeout = 5000');
  const state = new StateService(db);
  const context = { actor: 'screen-smoke', source: 'screen-smoke-cleanup' };
  const written = db
    .prepare("SELECT id, kind, entity_id AS entityId FROM state_events WHERE session_id LIKE ? AND kind != 'revert' ORDER BY id DESC")
    .all(`%${runTag}%`) as Array<{ id: number; kind: string; entityId: string }>;
  for (const event of written) {
    if (event.kind === 'create') state.archiveEntity(event.entityId, context);
    else state.revertEvent(event.id, context);
  }
  log('state.cleanup', { undone: written.length });
} catch (err) {
  log('state.cleanup.error', { message: (err as Error).message });
}

writeFileSync(join(outDir, 'events.log'), events.join('\n'));
writeFileSync(join(outDir, 'operator-said.txt'), said);
for (const [name, pass, detail] of checks) console.log(`${pass ? 'PASS' : 'FAIL'} ${name} — ${detail.slice(0, 220)}`);
process.exit(checks.every(([, pass]) => pass) ? 0 : 1);
