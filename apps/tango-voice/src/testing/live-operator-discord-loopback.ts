/**
 * Exercises DiscordAudioBridge end to end against real GPT-Live without Discord:
 * a scripted speaker is Opus-encoded exactly as Discord delivers it (48 kHz
 * speaker, 20 ms packets), and the operator's Opus output is decoded and recorded.
 *
 *   OPENAI_API_KEY=… node --import tsx apps/tango-voice/src/testing/live-operator-discord-loopback.ts --auth codex --out <dir>
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DiscordAudioBridge, mono24ToSpeaker48, speaker48ToMono24 } from '../live/discord-audio-bridge.js';
import type { LiveTranscriptDelta } from '../live/gpt-live-client.js';
import { LivePlaybackClock, pcmRms, SpeechActivity } from '../live/live-audio.js';
import { buildOperatorInstructions, LiveOperator } from '../live/live-operator.js';
import { parseArgs, resolveOperatorSetup } from './live-operator-setup.js';

const args = parseArgs(process.argv);
const apiKey = process.env.OPENAI_API_KEY ?? '';
const outDir = args.get('out') ?? join(process.cwd(), 'live-operator-loopback');
mkdirSync(outDir, { recursive: true });
args.set('agents', args.get('agents') ?? 'sim');
const setup = resolveOperatorSetup(args, apiKey);
const t0 = Date.now();
const log = (kind: string, data: Record<string, unknown> = {}) =>
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${kind} ${JSON.stringify(data).slice(0, 240)}`);

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

const libopus = await import('libopus-wasm');
// The "Discord client": encodes the speaker's audio as 20 ms 48 kHz speaker Opus.
const speakerEncoder = await libopus.createEncoder({ application: libopus.Application.Voip, channels: 2, sampleRate: 48_000, frameSize: 960 });
// The "listener": decodes what the bot would send to Discord.
const listenerDecoder = await libopus.createDecoder({ channels: 2, sampleRate: 48_000 });

const bridge = new DiscordAudioBridge();
await bridge.init();
const live = setup.route.create();
const userActivity = new SpeechActivity();
const playback = new LivePlaybackClock();
let said = '';
let heard = '';
const received: Buffer[] = [];
live.on('audio', (pcm: Buffer) => {
  playback.enqueue(pcm);
  bridge.pushOutput(pcm);
});
live.on('outputTranscript', (delta: LiveTranscriptDelta) => (said += delta.delta));
live.on('inputTranscript', (delta: LiveTranscriptDelta) => (heard += delta.delta));
bridge.on('frame', (pcm: Buffer) => {
  userActivity.observe(pcm);
  live.appendAudio(pcm);
});
// Drain the bot's Opus output at Discord's pace and decode it.
let outPackets = 0;
let voicedPackets = 0;
const drain = setInterval(() => {
  const packet = bridge.output.read() as Buffer | null;
  if (!packet) return;
  outPackets += 1;
  const pcm = speaker48ToMono24(listenerDecoder.decode(packet, { maxFrameSize: 5760 }));
  if (pcmRms(pcm) > 300) voicedPackets += 1;
  received.push(pcm);
}, 20);

const operator = new LiveOperator({
  client: live,
  agents: setup.agents,
  backend: setup.createBackend('loopback'),
  extractor: setup.extractor,
  userActivity,
  playback,
  policy: 'floor',
  log,
});

await live.start({ instructions: buildOperatorInstructions(setup.agents), voice: setup.voice });
bridge.start();
operator.start();
log('live.started', { route: setup.route.label });

/** Plays speech as a Discord speaker would: 20 ms Opus packets, in real time, then silence (no packets). */
async function speak(text: string): Promise<void> {
  const pcm = await synth(text);
  log('user.says', { text });
  for (let offset = 0; offset < pcm.length; offset += 960) {
    const frame = Buffer.alloc(960);
    pcm.copy(frame, 0, offset, Math.min(offset + 960, pcm.length));
    const { speaker } = mono24ToSpeaker48(frame);
    void bridge.pushOpus('speaker-1', Buffer.from(speakerEncoder.encode(speaker, { frameSize: 960 })));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
await sleep(1500);
await speak('Hey, can you ask Sierra to find a good campsite near Pinecrest for this Saturday?');
const deadline = Date.now() + 60_000;
while (Date.now() < deadline && !/sierra (says|reported|found)/i.test(said)) await sleep(500);
await sleep(6000);

clearInterval(drain);
operator.stop();
await live.close().catch(() => null);
bridge.stop();

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
writeFileSync(join(outDir, 'operator-as-heard-in-discord.wav'), Buffer.concat([header, pcm]));

const checks = [
  ['GPT-Live heard the Opus-encoded speaker', /campsite|pinecrest/i.test(heard), heard],
  ['request dispatched to Sierra', /dispatch/.test(JSON.stringify(operator.tasks.map((t) => t.agent.id))) || operator.tasks.some((t) => t.agent.id.startsWith('sierra')), operator.tasks.map((t) => `${t.agent.id}: ${t.request}`).join('; ')],
  ['result spoken with attribution', /sierra/i.test(said), said],
  ['bot produced voiced Opus for Discord', voicedPackets > 50, `${voicedPackets} voiced of ${outPackets} packets (${(outPackets * 0.02).toFixed(0)}s)`],
] as const;
for (const [name, pass, detail] of checks) console.log(`${pass ? 'PASS' : 'FAIL'} ${name} — ${String(detail).slice(0, 220)}`);
process.exit(checks.every(([, pass]) => pass) ? 0 : 1);
