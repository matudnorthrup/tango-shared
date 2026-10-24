// Sandbox-only UI check. Connects to an already leased browser, never launches one.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const [cdp, dir] = process.argv.slice(2);
if (!cdp || !dir) throw new Error('Usage: focus-check.mjs <leased-CDP-url> <artifact-directory>');
const browser = await chromium.connectOverCDP(cdp);
const page = browser.contexts()[0].pages()[0];
const url = new URL(page.url());
if (url.hostname !== '127.0.0.1' || url.port === '9410') throw new Error('Use the sandbox test desk.');
assert(Array.isArray(await fetch(`http://127.0.0.1:${Number(url.port) + 1}/posts`).then(r => r.json())));
mkdirSync(dir, { recursive: true });
await page.reload();
await page.waitForFunction(() => Object.values(window.__desk?.store.state.byId || {}).some(i => i.id.startsWith('discord:thread:') && i.replyable !== false));
await page.setViewportSize({ width: 1280, height: 900 });
await page.evaluate(() => {
  const NativeSocket = window.WebSocket;
  window.__focusSockets = [];
  window.__focusStreams = [];
  window.WebSocket = class {
    static OPEN = 1;
    constructor(url) {
      if (!String(url).includes('/api/desk/voice')) return new NativeSocket(url);
      this.url = String(url); this.readyState = 1; this.bufferedAmount = 0; this.sent = [];
      window.__focusSockets.push(this);
      setTimeout(() => this.emit({ type: 'status', state: this.url.includes('watch=1') ? 'waiting' : 'listening', voice: 'breeze' }), 50);
    }
    emit(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
    send(data) { if (typeof data === 'string') this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
  };
  navigator.mediaDevices.getUserMedia = async () => {
    const ctx = new AudioContext(); await ctx.resume();
    const dest = ctx.createMediaStreamDestination();
    window.__focusStreams.push(dest.stream);
    const track = dest.stream.getTracks()[0];
    const stop = track.stop.bind(track); track.stop = () => { stop(); void ctx.close(); };
    return dest.stream;
  };
});
const store = fn => page.evaluate(fn);
const emit = data => page.evaluate(d => window.__focusSockets.at(-1).emit(d), data);
const shot = name => page.screenshot({ path: `${dir}/focus-${name}.png` });
const listen = async () => {
  await page.getByRole('button', { name: 'Start voice reply', exact: true }).click();
  await page.locator('.rd-mic.listening').waitFor();
};
const say = async text => { await emit({ type: 'transcript', delta: text }); await emit({ type: 'status', state: 'sending' }); };
const tracksClosed = () => page.evaluate(() => window.__focusStreams.every(s => s.getTracks().every(t => t.readyState === 'ended')));
try {
  await store(() => { const s = window.__desk.store; window.__focusItem = Object.values(s.state.byId).find(i => i.id.startsWith('discord:thread:') && i.replyable !== false).id; s.nextOpen(window.__focusItem); });
  await listen(); await shot('dictation');
  await say('Sandbox dictation check.'); await shot('undo');
  await page.locator('.rd-mic').waitFor({ state: 'detached' });
  assert(await tracksClosed());
  console.log('PASS dictation sends and returns to list, closing capture');
  await store(() => window.__desk.store.nextOpen(window.__focusItem));
  await listen(); await page.getByRole('button', { name: 'Focus', exact: true }).click(); await shot('pill');
  await say('Sandbox Focus check.'); await page.locator('.rd-mic.waiting').waitFor();
  assert(await tracksClosed()); await shot('waiting');
  await emit({ type: 'status', state: 'speaking' }); await page.locator('.rd-mic.speaking').waitFor(); assert(await tracksClosed());
  await shot('reading'); await emit({ type: 'status', state: 'paused' }); await page.locator('.rd-mic.your-turn').waitFor();
  assert.equal(await tracksClosed(), false); await shot('your-turn');
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await page.locator('.rd-mic.idle').waitFor(); assert(await tracksClosed());
  console.log('PASS Focus toggled mid-dictation, capture closed waiting/reading, reopens after reply and toggle off closes it');
  await store(() => window.__desk.store.goBoard());
  await page.getByRole('button', { name: 'New thread', exact: true }).click();
  await page.locator('.swc-prompt:not([disabled])').waitFor();

  await listen(); await say('A sandbox task using ordinary Start.');
  await page.getByRole('dialog', { name: 'Start work', exact: true }).waitFor({ state: 'detached' });
  assert(await tracksClosed());
  assert.equal(await page.evaluate(() => window.__focusSockets.at(-1).url.includes('watch=1')), false);
  console.log('PASS Start work dictation closes the sheet without opening Focus');
  await page.getByRole('button', { name: 'New thread', exact: true }).click();
  await page.locator('.swc-prompt:not([disabled])').waitFor();
  await listen(); await emit({ type: 'transcript', delta: 'A sandbox task for the new thread.' }); await shot('new-thread-dictation');
  await page.getByRole('button', { name: 'Send and go to Focus', exact: true }).click(); await shot('new-thread-pill');
  await emit({ type: 'status', state: 'sending' });
  await page.locator('.rd-mic.waiting').waitFor({ timeout: 20000 });
  assert(await tracksClosed());
  await page.waitForFunction(() => window.__focusSockets.at(-1).url.includes('watch=1'), { timeout: 35000 });
  await shot('new-thread-waiting');
  await emit({ type: 'status', state: 'paused' });
  await page.waitForTimeout(100);
  assert(await tracksClosed());
  await page.locator('.rd-mic.waiting').waitFor();
  await emit({ type: 'status', state: 'speaking' }); await emit({ type: 'status', state: 'paused' });
  await page.locator('.rd-mic.your-turn').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { const s = window.__desk.store; for (const t of [...s.state.toasts]) s.dismissToast(t.id); });
  await shot('phone');
  await page.getByRole('button', { name: 'Stop listening', exact: true }).last().click();
  console.log('PASS Start work Focus uses existing Start, opens the new thread, waits without capture, then reopens');
  await store(() => window.__desk.store.goBoard());
  await page.getByRole('button', { name: 'New thread', exact: true }).click();
  await page.locator('.swc-prompt:not([disabled])').waitFor();
  let authPolls = 0;
  await page.route('**/api/desk/voice?item=*', route => { authPolls++; return route.fulfill({ status: 404, body: '{}' }); });
  await listen(); await page.getByRole('button', { name: 'Send and go to Focus', exact: true }).click();
  const sockets = await page.evaluate(() => window.__focusSockets.length);
  await say('Navigation cancellation regression.');
  await page.waitForFunction(() => window.__desk.store.state.presentation.view === 'conversation');
  await page.waitForTimeout(600); assert(authPolls > 0);
  await store(() => window.__desk.store.goBoard());
  await page.unroute('**/api/desk/voice?item=*');
  await page.waitForTimeout(1000);
  assert.equal(await page.evaluate(() => window.__focusSockets.length), sockets);
  assert(await tracksClosed());
  assert.equal(await page.evaluate(() => window.__desk.store.state.voiceFocusItem), null);
  console.log('PASS navigation before destination ingestion cancels authorization polling and never reopens capture');
} finally { await browser.close(); }
