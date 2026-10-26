const http = require('node:http');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const delayed = process.argv.includes('--delayed');
const turn = process.argv.find(a => a.startsWith('--turn='))?.slice(7);
let pauses = [];
const pause = process.argv.includes('--pause');
let starts = 0, audioFrames = 0, closed = 0, lookups = 0;
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/counts') return res.end(JSON.stringify({ starts, audioFrames, closed, lookups }));
  if (req.url.startsWith('/api/desk/')) lookups++;
  if (req.url === '/api/desk/presentation') return res.end(JSON.stringify({ view: 'conversation', itemId: 'fixture' }));
  if (req.url === '/api/desk/items/fixture') return res.end(JSON.stringify({ item: { id: 'fixture', replyable: true } }));
  res.statusCode = 503; res.end('{}');
});
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  ws.on('close', () => { closed++; });
  const warm = req.url.endsWith('&warm=1');
  assert.equal(req.url, '/api/desk/voice?mode=dictation&manualFinish=1' + (warm ? '&warm=1' : ''));
  let active = !warm;
  assert.equal(req.headers.origin, `http://127.0.0.1:${server.address().port}`);
  assert.equal(req.headers.authorization, undefined);
  setTimeout(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'status', state: warm ? 'armed' : 'listening' })); }, process.argv.includes('--cold-delay') ? 300 : 0);
  const frames = [];
  ws.on('message', (data, binary) => {
    if (binary) {
      assert.equal(active, true, "audio while muted");
      audioFrames++; frames.push(data);
      if (!turn && !pause && frames.length === 2) ws.send(JSON.stringify({ type: 'status', state: 'speech_end' }));
      return;
    }
    if (JSON.parse(String(data)).type === 'start') {
      starts++; assert.equal(warm, true); assert.equal(active, false);
      setTimeout(() => { active = true; if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'status', state: 'listening' })); }, delayed ? 300 : 0); return;
    }
    const event = JSON.parse(String(data));
    if (event.type === 'pause') {
      assert.equal(typeof event.quietMs, 'number'); assert.equal(typeof event.id, 'string'); pauses.push(event.quietMs);
      if (!turn || turn === 'fallback') return;
      if (turn === 'cancel') { ws.send(JSON.stringify({ type: 'cancel' })); return; }
      const state = turn === 'waiting' && pauses.length === 1 ? 'waiting' : turn === 'holding' ? 'holding' : 'speech_end';
      ws.send(JSON.stringify({ type: 'status', state, id: event.id, untilMs: state === 'waiting' ? 4000 : undefined }));
      return;
    }
    assert.deepEqual(event, { type: 'finish' });
    if (turn) {
      ws.send(JSON.stringify({ type: 'transcript_final', text: 'Clean' }));
      ws.send(JSON.stringify({ type: 'status', state: 'sending' }));
      setTimeout(() => {
        if (ws.readyState !== 1) return;
        ws.send(JSON.stringify({ type: 'transcript', delta: ' late' }));
        ws.send(JSON.stringify({ type: 'transcript_final', text: 'Clean late' }));
      }, 40);
      return;
    }
    if (!pause) {
      assert.deepEqual(frames.map(f => f.length), [9600, 4800]);
      assert.equal(frames[0][0], 7); assert.equal(frames[1][0], 8);
    } else {
      assert.ok(frames.length > 10);
      assert.ok(frames.some(f => f.some(b => b !== 0)));
      assert.ok(frames.at(-1).every(b => b === 0));
    }
    ws.send(JSON.stringify({ type: 'transcript', delta: 'fixture transcript' }));
    ws.send(JSON.stringify({ type: 'status', state: 'sending' }));
  });
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
setTimeout(() => process.exit(1), (pause ? 60000 : 15000)).unref();
