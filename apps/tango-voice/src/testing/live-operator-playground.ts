/**
 * Browser playground for the live operator: talk to GPT-Live from a phone or
 * laptop, with role-played agents behind it. Tailnet use only.
 *
 *   OPENAI_API_KEY=… node --import tsx apps/tango-voice/src/testing/live-operator-playground.ts \
 *     --port 19480 --logs /path/to/dir
 *
 * Each connection is its own GPT-Live session (~$0.05/min) and is capped at 20 minutes.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { LiveTranscriptDelta } from '../live/gpt-live-client.js';
import { LivePlaybackClock, SpeechActivity } from '../live/live-audio.js';
import { buildOperatorInstructions, LiveOperator } from '../live/live-operator.js';
import { createDraftCompiler, createDraftEndJudge, DraftSession } from '../live/draft-mode.js';
import { parseArgs, resolveOperatorSetup } from './live-operator-setup.js';

// Only needed for --auth api; the subscription route bills the ChatGPT login.
const apiKey = process.env.OPENAI_API_KEY ?? '';
const args = parseArgs(process.argv);
const port = Number(args.get('port') ?? 19480);
const logDir = args.get('logs') ?? join(process.cwd(), 'live-operator-playground-logs');
const setup = resolveOperatorSetup(args, apiKey);
const { route, voice, agents: AGENTS, modeLabel: MODE_LABEL } = setup;
const MAX_SESSION_MS = 20 * 60_000;
mkdirSync(logDir, { recursive: true });

async function runSession(socket: WebSocket): Promise<void> {
  const sessionStarted = Date.now();
  const logFile = join(logDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  const sendJson = (payload: Record<string, unknown>) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
  };
  const log = (kind: string, data: Record<string, unknown> = {}) => {
    const entry = { t: Date.now() - sessionStarted, kind, ...data };
    appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
    sendJson({ type: 'log', ...entry });
  };

  const client = route.create();
  const userActivity = new SpeechActivity();
  const playback = new LivePlaybackClock();
  // The browser already streams continuous real-time audio (silence included),
  // so forward it as it arrives. A pacing pump would add drift on every underrun.
  client.on('audio', (pcm: Buffer) => {
    playback.enqueue(pcm);
    if (socket.readyState === socket.OPEN) socket.send(pcm);
  });
  client.on('inputTranscript', (delta: LiveTranscriptDelta) => {
    sendJson({ type: 'transcript', speaker: 'user', delta: delta.delta, startMs: delta.startMs });
    appendFileSync(logFile, `${JSON.stringify({ t: Date.now() - sessionStarted, kind: 'heard', delta: delta.delta })}\n`);
  });
  client.on('outputTranscript', (delta: LiveTranscriptDelta) => {
    sendJson({ type: 'transcript', speaker: 'operator', delta: delta.delta, startMs: delta.startMs });
    appendFileSync(logFile, `${JSON.stringify({ t: Date.now() - sessionStarted, kind: 'said', delta: delta.delta })}\n`);
  });

  const operator = new LiveOperator({
    client,
    draft: new DraftSession({ compile: createDraftCompiler(setup.models, { people: setup.profile?.people }), judgeEnd: createDraftEndJudge(setup.models), log }),
    agents: AGENTS,
    backend: setup.createBackend(new Date().toISOString().slice(0, 16).replace(/[-:T]/g, ''), log),
    extractor: setup.extractor,
    userActivity,
    playback,
    policy: 'floor',
    ...setup.operatorExtras,
    log,
  });

  let closed = false;
  const shutdown = async (reason: string) => {
    if (closed) return;
    closed = true;
    operator.stop();
    const usage = await client.close().catch(() => null);
    log('session.end', { reason, usage, durationMs: Date.now() - sessionStarted });
    sendJson({ type: 'status', state: 'ended', reason });
    socket.close();
  };

  socket.on('message', (data, isBinary) => {
    if (isBinary && !closed && client.isOpen) {
      const pcm = Buffer.from(data as Buffer);
      userActivity.observe(pcm);
      client.appendAudio(pcm);
    }
    else if (String(data) === 'stop') void shutdown('user stopped');
  });
  socket.on('close', () => void shutdown('browser disconnected'));
  const cap = setTimeout(() => void shutdown('20 minute cap'), MAX_SESSION_MS);
  socket.on('close', () => clearTimeout(cap));

  sendJson({ type: 'status', state: 'connecting', agents: AGENTS });
  try {
    await client.start({ instructions: buildOperatorInstructions(AGENTS), voice });
  } catch (err) {
    log('session.error', { message: (err as Error).message });
    await shutdown('could not start GPT-Live');
    return;
  }
  log('session.start', { sessionId: client.sessionId });
  operator.start();
  sendJson({ type: 'status', state: 'live' });
}

const server = createServer((request, response) => {
  if (request.url === '/' || request.url?.startsWith('/?')) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(
      PAGE.replace('/*AGENTS*/[]', JSON.stringify(AGENTS))
        .replace('<!--MODE-->', MODE_LABEL)
        .replace('<!--ROUTE-->', route.label),
    );
    return;
  }
  response.writeHead(404).end();
});
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (socket) => void runSession(socket));
server.listen(port, '127.0.0.1', () => console.log(`live operator playground on http://127.0.0.1:${port}`));

const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Operator Playground</title>
<style>
:root{--bg:#f7f6f2;--fg:#1c1b19;--muted:#6d695f;--card:#fff;--line:#e4e0d6;--accent:#2f6f5e;--accent-fg:#fff;--user:#e9f0fb;--op:#e8f5ee;--warn:#9a5b13;--stop:#a23b2c}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#151412;--fg:#ece9e2;--muted:#a19c92;--card:#201e1b;--line:#33302b;--accent:#7cc4ad;--accent-fg:#10201a;--user:#1c2532;--op:#1a2922;--warn:#e0a85c;--stop:#e58a7b}}
:root[data-theme="dark"]{--bg:#151412;--fg:#ece9e2;--muted:#a19c92;--card:#201e1b;--line:#33302b;--accent:#7cc4ad;--accent-fg:#10201a;--user:#1c2532;--op:#1a2922;--warn:#e0a85c;--stop:#e58a7b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:1.4rem;margin:0}.sub{color:var(--muted);margin:4px 0 16px;font-size:.92rem}
.bar{display:flex;align-items:center;gap:14px;margin-bottom:16px}
button#go{width:76px;height:76px;border-radius:50%;border:0;background:var(--accent);color:var(--accent-fg);font-weight:700;font-size:1rem;cursor:pointer;flex:none}
button#go.live{background:var(--stop)}
#state{font-weight:600}#meta{color:var(--muted);font-size:.88rem}
.agents{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;margin-bottom:16px}
.agent{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 10px;min-height:74px}
.agent b{display:block}.chip{font-size:.75rem;padding:1px 7px;border-radius:999px;background:var(--line);color:var(--muted)}
.chip.running{background:var(--accent);color:var(--accent-fg)}.chip.waiting{background:var(--warn);color:#fff}.chip.queued{background:var(--warn);color:#fff}
.agent .last{font-size:.82rem;color:var(--muted);margin-top:4px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}
#captions{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px;min-height:200px;max-height:46vh;overflow-y:auto}
.line{padding:6px 10px;border-radius:8px;margin:4px 0}.line.user{background:var(--user)}.line.operator{background:var(--op)}
.line small{color:var(--muted);display:block;font-size:.72rem;text-transform:uppercase;letter-spacing:.04em}
details{margin-top:14px}summary{cursor:pointer;color:var(--muted)}#log{font:12px/1.4 ui-monospace,Menlo,monospace;white-space:pre-wrap;color:var(--muted);max-height:40vh;overflow:auto}
.tips{font-size:.86rem;color:var(--muted)}
</style></head><body><main>
<h1>Operator playground</h1>
<p class="sub">GPT-Live as your operator, with <!--MODE--> Headphones are best.</p>
<div class="bar"><button id="go">Start</button><div><div id="state">Ready</div><div id="meta">Voice: <!--ROUTE-->. Sessions are capped at 20 minutes.</div></div></div>
<div class="agents" id="agents"></div>
<div id="captions"></div>
<p class="tips">Try: "Ask Sierra to find a campsite near Pinecrest for Saturday, and have Watson check my calendar." Then keep talking. Results come back when there's a pause.</p>
<details><summary>Operator log</summary><div id="log"></div></details>
</main>
<script>
const $ = (id) => document.getElementById(id);
const agents = new Map();
/*AGENTS*/[].forEach((a) => agents.set(a.id, { ...a, state: '', label: 'idle' }));
let ws, ctx, stream, node, playHead = 0, startedAt = 0, timer;
let lastLine = null;

function renderAgents() {
  $('agents').innerHTML = [...agents.values()].map((a) =>
    '<div class="agent"><b>' + a.name + '</b><span class="chip ' + a.state + '">' + a.label + '</span><div class="last">' + (a.last || a.role) + '</div></div>').join('');
}
function setAgent(id, state, label, last) {
  const a = agents.get(id); if (!a) return;
  a.state = state; a.label = label; if (last !== undefined) a.last = last; renderAgents();
}
function caption(speaker, delta) {
  if (!lastLine || lastLine.speaker !== speaker || Date.now() - lastLine.at > 2500) {
    const el = document.createElement('div'); el.className = 'line ' + speaker;
    el.innerHTML = '<small>' + (speaker === 'user' ? 'You' : 'Operator') + '</small><span></span>';
    $('captions').appendChild(el); lastLine = { speaker, el: el.querySelector('span'), at: Date.now() };
  }
  lastLine.el.textContent += delta; lastLine.at = Date.now();
  $('captions').scrollTop = $('captions').scrollHeight;
}
function onLog(e) {
  const brief = JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !['type','t','kind'].includes(k))));
  $('log').textContent = (e.t / 1000).toFixed(1) + 's ' + e.kind + ' ' + brief.slice(0, 300) + '\n' + $('log').textContent;
  if (e.kind === 'dispatch') setAgent(e.agent, 'running', 'working', e.message);
  if (e.kind === 'agent.update' && e.updateKind !== 'progress') setAgent(e.agent, 'queued', e.updateKind === 'question' ? 'has a question' : 'reported back', e.text);
  if (e.kind === 'delivered') setAgent(e.agent, e.how === 'answered' ? 'running' : '', e.how === 'answered' ? 'working' : 'relayed');
}
function play(buf) {
  const pcm = new Int16Array(buf); const f = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
  const ab = ctx.createBuffer(1, f.length, 24000); ab.copyToChannel(f, 0);
  const src = ctx.createBufferSource(); src.buffer = ab; src.connect(ctx.destination);
  const at = Math.max(playHead, ctx.currentTime + 0.08); src.start(at); playHead = at + ab.duration;
}
const WORKLET = 'class C extends AudioWorkletProcessor{constructor(){super();this.b=new Int16Array(2400);this.n=0}process(i){const c=i[0]&&i[0][0];if(c){for(let k=0;k<c.length;k++){const s=Math.max(-1,Math.min(1,c[k]));this.b[this.n++]=s<0?s*32768:s*32767;if(this.n===2400){this.port.postMessage(this.b.buffer.slice(0));this.n=0}}}return true}}registerProcessor("pcm-capture",C)';

async function start() {
  $('go').disabled = true; $('state').textContent = 'Starting…';
  ctx = new AudioContext({ sampleRate: 24000 });
  await ctx.resume();
  stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
  node = new AudioWorkletNode(ctx, 'pcm-capture');
  ctx.createMediaStreamSource(stream).connect(node);
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.binaryType = 'arraybuffer';
  node.port.onmessage = (e) => { if (ws.readyState === 1) ws.send(e.data); };
  ws.onmessage = (m) => {
    if (typeof m.data !== 'string') return play(m.data);
    const e = JSON.parse(m.data);
    if (e.type === 'transcript') caption(e.speaker, e.delta);
    else if (e.type === 'log') onLog(e);
    else if (e.type === 'status') {
      if (e.agents) { e.agents.forEach((a) => agents.set(a.id, { ...a, state: '', label: 'idle' })); renderAgents(); }
      if (e.state === 'live') { $('state').textContent = 'Live — just talk'; startedAt = Date.now(); $('go').textContent = 'Stop'; $('go').classList.add('live'); $('go').disabled = false;
        timer = setInterval(() => { const m = (Date.now() - startedAt) / 60000; $('meta').textContent = m.toFixed(1) + ' min'; }, 1000); }
      if (e.state === 'ended') stop(e.reason);
    }
  };
  ws.onclose = () => stop('disconnected');
}
function stop(reason) {
  if (ws && ws.readyState === 1) ws.send('stop');
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (ctx) ctx.close(); ctx = null; stream = null; clearInterval(timer);
  $('go').textContent = 'Start'; $('go').classList.remove('live'); $('go').disabled = false;
  $('state').textContent = 'Ended' + (reason ? ' (' + reason + ')' : '');
}
renderAgents();
$('go').onclick = () => ($('go').classList.contains('live') ? stop('stopped') : start().catch((err) => { $('state').textContent = 'Error: ' + err.message; $('go').disabled = false; }));
</script></body></html>`;
