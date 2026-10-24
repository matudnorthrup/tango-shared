import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { serve } from '@hono/node-server';
import type { Browser, Frame, Page } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { BundleStore } from '../server/bundles.js';
import { Hub } from '../server/hub.js';
import { SceneStore } from '../server/store.js';

// The navigation bridge in a real headless Chromium: a host page frames an
// uploaded prototype the way the desk does (sandboxed, opaque origin) and drives
// it with the messages the desk relays from the operator.

let dir: string;
let port: number;
let close: () => void;
let browser: Browser | null = null;
let base: string;

const INDEX = `<!doctype html><html><head><title>Onboarding</title>
<style>body{font:16px system-ui;margin:0;padding:24px} .tall{height:2400px}</style></head>
<body>
<h1>Welcome aboard</h1>
<p id="status">step 1</p>
<button onclick="document.getElementById('status').textContent='step 2'">Continue</button>
<button disabled>Pay now</button>
<button aria-label="Close dialog"><svg width="10" height="10"></svg></button>
<a href="page2.html">Next page</a>
<label for="email">Email</label><input id="email" name="email">
<input placeholder="Search the docs" name="q">
<label for="seats">Seats</label><input id="seats" type="number" value="3">
<label for="country">Country</label><select id="country"><option value="us">United States</option><option value="ca">Canada</option></select>
<label for="size">Team size</label><select id="size"><option>Just me</option><option>2–10</option><option>11–50</option></select>
<label for="billing">Billing</label><select id="billing"><option>2–10 seats monthly</option><option>2–10 seats yearly</option></select>
<div class="tall"></div>
<h2 id="pricing">Pricing</h2>
<button>Buy the plan</button>
</body></html>`;

const PAGE2 = `<!doctype html><html><head><title>Second</title></head><body><h1>Page two</h1><a href="index.html">Home</a></body></html>`;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
  const store = new SceneStore(path.join(dir, 'data'));
  const bundles = new BundleStore(path.join(dir, 'bundles'));
  const saved = bundles.save([
    { path: 'index.html', data: Buffer.from(INDEX).toString('base64') },
    { path: 'page2.html', data: Buffer.from(PAGE2).toString('base64') },
  ]);
  base = `/bundles/${saved.id}/`;
  fs.writeFileSync(
    path.join(dir, 'host.html'),
    `<!doctype html><body style="margin:0"><iframe id="f" style="width:900px;height:600px;border:0" sandbox="allow-scripts allow-forms allow-popups"></iframe>
<script>window.msgs=[];addEventListener('message',function(e){if(e.source===document.getElementById('f').contentWindow)msgs.push(e.data)});
document.getElementById('f').src=new URLSearchParams(location.search).get('src');
window.send=function(name,args){document.getElementById('f').contentWindow.postMessage({type:'command',name:name,args:args||{}},'*')};</script></body>`,
  );
  const app = createApp({ store, bundles, hub: new Hub(store, async () => 'agent'), publicDir: dir });
  await new Promise<void>((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      port = info.port;
      resolve();
    });
    close = () => server.close();
  });
  const { chromium } = await import('playwright-core');
  // No browser on this machine (the CI runner): these tests skip, like the render check's.
  browser = await chromium.launch({ headless: true }).catch(() => null);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  close?.();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function host(): Promise<{ page: Page; frame: () => Frame }> {
  const page = await browser!.newPage();
  await page.goto(`http://127.0.0.1:${port}/host.html?src=${encodeURIComponent(`${base}index.html`)}`);
  const frame = () => page.frames().find((f) => f !== page.mainFrame())!;
  await page.waitForFunction(() => (window as any).msgs.some((m: any) => m.type === 'proto-page'));
  return { page, frame };
}

const lastPage = (page: Page) => page.evaluate(() => [...(window as any).msgs].reverse().find((m: any) => m.type === 'proto-page')?.page);
const lastResult = (page: Page) => page.evaluate(() => [...(window as any).msgs].reverse().find((m: any) => m.type === 'proto-result'));
const send = (page: Page, name: string, args: Record<string, unknown> = {}) =>
  page.evaluate(([n, a]) => {
    (window as any).msgs.length = 0;
    (window as any).send(n, a);
  }, [name, args] as const);
const result = async (page: Page) => {
  await page.waitForFunction(() => (window as any).msgs.some((m: any) => m.type === 'proto-result'));
  return lastResult(page);
};

describe('prototype navigation bridge', () => {
  beforeEach((context) => {
    if (!browser) context.skip();
  });

  it('reports what is on the page: clickables in view first, headings, fields', async () => {
    const { page } = await host();
    const snapshot = await lastPage(page);
    expect(snapshot.path).toBe('index.html');
    expect(snapshot.title).toBe('Onboarding');
    const labels = snapshot.targets.map((t: any) => t.label);
    expect(labels.slice(0, 3)).toEqual(['Continue', 'Close dialog', 'Next page']);
    expect(labels).not.toContain('Pay now'); // disabled
    expect(snapshot.targets.find((t: any) => t.label === 'Buy the plan')).toMatchObject({ inView: false });
    expect(snapshot.targets.find((t: any) => t.label === 'Next page')).toMatchObject({ kind: 'link' });
    expect(snapshot.headings).toEqual(['Welcome aboard', 'Pricing']);
    expect(snapshot.fields).toEqual(['Email', 'Search the docs', 'Seats', 'Country', 'Team size', 'Billing']);
    expect(snapshot.scroll).toEqual({ percent: 0, scrollable: true });
    await page.close();
  });

  it('click by label (exact, loose, case-insensitive); an unknown label reports nothing found', async () => {
    const { page, frame } = await host();
    await send(page, 'click', { target: 'continue' });
    expect(await result(page)).toMatchObject({ name: 'click', ok: true, detail: 'Continue' });
    expect(await frame().textContent('#status')).toBe('step 2');
    await send(page, 'click', { target: 'the Pay button' });
    expect(await result(page)).toMatchObject({ ok: false });
    await send(page, 'click', { target: 'Checkout' });
    expect(await result(page)).toMatchObject({ ok: false, detail: 'nothing called "Checkout" on the page' });
    await page.close();
  });

  it('hands Escape the page leaves alone to the desk', async () => {
    const { page, frame } = await host();
    await frame().click('#email');
    await page.evaluate(() => ((window as any).msgs.length = 0));
    await frame().press('#email', 'Escape');
    await page.waitForFunction(() => (window as any).msgs.some((m: any) => m.type === 'proto-key' && m.key === 'Escape'));
    // One the page handles itself (preventDefault) stays with it.
    // (A window listener added after the bridge's, as a deferred or module script's would be.)
    await frame().evaluate(() => window.addEventListener('keydown', (e) => e.key === 'Escape' && e.preventDefault()));
    await page.evaluate(() => ((window as any).msgs.length = 0));
    await frame().press('#email', 'Escape');
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => (window as any).msgs.filter((m: any) => m.type === 'proto-key').length)).toBe(0);
  });

  it('leaves Escape with an open dialog the browser closes itself', async () => {
    const { page, frame } = await host();
    await frame().evaluate(() => {
      const dialog = document.createElement('dialog');
      dialog.innerHTML = '<button id="in-dialog">OK</button>';
      document.body.append(dialog);
      dialog.showModal();
    });
    await page.evaluate(() => ((window as any).msgs.length = 0));
    await frame().press('#in-dialog', 'Escape');
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => (window as any).msgs.filter((m: any) => m.type === 'proto-key').length)).toBe(0);
    // A non-modal dialog takes no Escape: the desk still gets it.
    await frame().evaluate(() => { const d = document.querySelector('dialog')!; d.close(); d.show(); });
    await frame().click('#email');
    await frame().press('#email', 'Escape');
    await page.waitForFunction(() => (window as any).msgs.some((m: any) => m.type === 'proto-key'));
    await frame().evaluate(() => document.querySelector('dialog')!.close());
    await page.evaluate(() => ((window as any).msgs.length = 0));
    // Closed, the next Escape is the desk's again.
    await frame().click('#email');
    await frame().press('#email', 'Escape');
    await page.waitForFunction(() => (window as any).msgs.some((m: any) => m.type === 'proto-key'));
  });

  it('fills a field by label or placeholder, the way a framework sees typing', async () => {
    const { page, frame } = await host();
    await send(page, 'fill', { target: 'email', text: 'owner@example.test' });
    expect(await result(page)).toMatchObject({ ok: true });
    expect(await frame().inputValue('#email')).toBe('owner@example.test');
    // Typing by hand is activity, even though the page reports nothing new.
    await page.evaluate(() => ((window as any).msgs.length = 0));
    await frame().click('#email');
    await page.waitForFunction(() => (window as any).msgs.some((m: any) => m.type === 'proto-activity'));
    await send(page, 'fill', { target: 'search', text: 'pricing' });
    expect(await result(page)).toMatchObject({ ok: true });
    expect(await frame().inputValue('input[name=q]')).toBe('pricing');
    // What was typed never becomes a label in what the page reports (it goes into the operator's prompt).
    await page.waitForFunction(() => (window as any).msgs.some((m: any) => m.type === 'proto-page'));
    const snapshot = await lastPage(page);
    expect(snapshot.fields).toEqual(['Email', 'Search the docs', 'Seats', 'Country', 'Team size', 'Billing']);
    expect(JSON.stringify(snapshot)).not.toContain('owner@example.test');
    // A select takes an option by its label; one it doesn't have is a miss, not a silent success.
    await send(page, 'fill', { target: 'country', text: 'canada' });
    expect(await result(page)).toMatchObject({ ok: true });
    expect(await frame().inputValue('#country')).toBe('ca');
    await send(page, 'fill', { target: 'country', text: 'Mexico' });
    const miss = await result(page);
    expect(miss).toMatchObject({ ok: false, detail: expect.stringContaining('options: United States, Canada') });
    expect(miss.detail).not.toContain('Mexico'); // what was asked for never comes back (results are traced)
    expect(await frame().inputValue('#country')).toBe('ca');
    // A number field that can't take the text keeps its value and says so.
    await send(page, 'fill', { target: 'seats', text: 'a thousand' });
    expect(await result(page)).toMatchObject({ ok: false, detail: 'Seats (a number field) did not take that' });
    expect(await frame().inputValue('#seats')).toBe('3');
    // "two to ten", as dictation writes it, is the 2–10 option.
    await send(page, 'fill', { target: 'team size', text: '2 to 10' });
    expect(await result(page)).toMatchObject({ ok: true });
    expect(await frame().inputValue('#size')).toBe('2–10');
    // Digits that fit two options are not enough.
    await send(page, 'fill', { target: 'billing', text: '2 to 10' });
    expect(await result(page)).toMatchObject({ ok: false });
    await page.close();
  });

  it('scrolls, and goes to a section by its heading', { timeout: 15_000 }, async () => {
    const { page, frame } = await host();
    await send(page, 'scroll_down');
    await result(page);
    await frame().waitForFunction(() => scrollY > 100);
    await send(page, 'go_to', { target: 'pricing' });
    expect(await result(page)).toMatchObject({ ok: true, detail: 'Pricing' });
    // Near the end of the page it can't reach the top: in view is what counts.
    await frame().waitForFunction(() => { const r = document.getElementById('pricing')!.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
    await page.waitForFunction(() => [...(window as any).msgs].reverse().find((m: any) => m.type === 'proto-page')?.page.scroll.percent > 80);
    await send(page, 'scroll_top');
    await frame().waitForFunction(() => scrollY === 0);
    await page.close();
  });

  it('follows links inside the prototype and goes back', async () => {
    const { page } = await host();
    await send(page, 'click', { target: 'Next page' });
    await page.waitForFunction(() => (window as any).msgs.some((m: any) => m.type === 'proto-page' && m.page.path === 'page2.html'));
    expect((await lastPage(page)).headings).toEqual(['Page two']);
    await send(page, 'back');
    await page.waitForFunction(() => (window as any).msgs.some((m: any) => m.type === 'proto-page' && m.page.path === 'index.html'));
    await page.close();
  });

  it('ignores messages from anything but its parent, and does nothing in its own tab', async () => {
    const page = await browser!.newPage();
    await page.goto(`http://127.0.0.1:${port}${base}index.html`);
    expect(await page.evaluate(() => (window as any).__tangoProto ?? null)).toBeNull();
    await page.close();
  });
});
