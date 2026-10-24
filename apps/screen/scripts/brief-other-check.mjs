// Sandbox-only check using an already leased browser; never launches one.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const [cdp, dir] = process.argv.slice(2);
if (!cdp || !dir) throw new Error('Usage: brief-other-check.mjs <leased-CDP-url> <artifact-directory>');
const browser = await chromium.connectOverCDP(cdp);
const page = browser.contexts()[0].pages()[0];
const url = new URL(page.url());
if (url.hostname !== '127.0.0.1' || url.port === '9410') throw new Error('Use the sandbox test desk.');
assert(Array.isArray(await fetch(`http://127.0.0.1:${Number(url.port) + 1}/posts`).then(r => r.json())));
mkdirSync(dir, { recursive: true });
try {
  await page.goto(new URL('/brief-fixture.html', url).href);
  await page.waitForFunction(() => window.fixtureReady);
  await page.evaluate(() => {
    window.__otherSockets = []; window.__otherStreams = [];
    window.WebSocket = class {
      static OPEN = 1;
      constructor(url) {
        this.url = String(url); this.readyState = 1; this.sent = [];
        window.__otherSockets.push(this);
        setTimeout(() => this.emit({ type: 'status', state: 'listening' }), 20);
      }
      emit(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
      send(data) { if (typeof data === 'string') this.sent.push(JSON.parse(data)); }
      close() { this.readyState = 3; }
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext(); await ctx.resume();
      const stream = ctx.createMediaStreamDestination().stream;
      window.__otherStreams.push(stream);
      const track = stream.getTracks()[0], stop = track.stop.bind(track);
      track.stop = () => { stop(); void ctx.close(); };
      return stream;
    };
  });
  const emit = data => page.evaluate(d => window.__otherSockets.at(-1).emit(d), data);
  const closed = () => page.evaluate(() => window.__otherStreams.every(s => s.getTracks().every(t => t.readyState === 'ended')));
  for (const surface of ['thread', 'decision', 'plain']) {
    const section = page.locator(`[data-surface=${surface}]`);
    const other = section.getByRole('button', { name: 'Other…', exact: true });
    if (await other.count()) await other.click();
    const input = section.locator('.pq-other input');
    await input.fill('Please:');
    const listen = async () => {
      await section.getByRole('button', { name: 'Dictate your answer', exact: true }).click();
      await section.locator('.rd-mic.listening').waitFor();
    };
    await page.evaluate(() => { window.fixtureAnswer = null; });
    await listen();
    assert.equal(await section.locator('.rd-focus').count(), 0);
    await emit({ type: 'transcript', delta: 'Keep the shared card' });
    await emit({ type: 'status', state: 'sending' });
    await section.locator('.rd-mic.finishing').waitFor();
    assert(await closed());
    await page.waitForTimeout(400);
    await emit({ type: 'transcript', delta: ' and test on a phone.' });
    await section.locator('.rd-mic.idle').waitFor();
    await page.waitForTimeout(3200);
    assert.equal(await input.inputValue(), 'Please: Keep the shared card and test on a phone.');
    assert.equal(await page.evaluate(() => window.fixtureAnswer), null);
    assert(await closed());
    assert(await page.evaluate(() => window.__otherSockets.every(s => s.url.endsWith('?mode=dictation') && s.sent.every(f => ['stop', 'finish'].includes(f.type)))));
    if (surface === 'thread') {
      for (const [name, width, height] of [['desktop', 1440, 1000], ['phone', 390, 844]]) {
        await page.setViewportSize({ width, height }); await page.evaluate(() => scrollTo(0, 0));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: `${dir}/brief-other-${name}.png` });
      }
    }
    await listen(); await input.click();
    await section.locator('.rd-mic.idle').waitFor(); assert(await closed());
    await emit({ type: 'transcript', delta: 'late words' });
    assert.equal(await input.inputValue(), 'Please: Keep the shared card and test on a phone.');
    await listen(); await input.fill('Edited by hand');
    await section.locator('.rd-mic.idle').waitFor(); assert(await closed());
    await listen(); await page.keyboard.press('Escape'); assert(await closed());
    // Escape also closes Other when the field owns keyboard focus.
    if (await other.count()) await other.click();
    await input.fill('Manual answer');
    await section.locator('.pq-other button[type=submit]').click();
    assert.equal((await page.evaluate(() => window.fixtureAnswer))[2], 'Manual answer');
    console.log(`PASS ${surface}: dictation never submits; click, typing and Escape stop capture; manual Send works`);
  }
} finally { await browser.close(); }
