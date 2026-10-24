import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { SceneStore } from '../server/store.js';
import { Hub } from '../server/hub.js';
import { DictationHistoryStore } from '../server/desk/dictation-history-store.js';

it('recovers, searches, copies and clears synthetic text through the mounted app; scene and detached paths cannot read it', async (ctx) => {
  const browser = await chromium.launch({ headless: true }).catch(() => null);
  if (!browser) return ctx.skip();
  const dir = mkdtempSync(join(tmpdir(), 'history-browser-'));
  const prior = process.env.SCREEN_ALLOWED_LOGINS;
  const owner = 'owner@example.invalid'; process.env.SCREEN_ALLOWED_LOGINS = owner;
  const history = new DictationHistoryStore(join(dir, 'private'));
  const scenes = new SceneStore(join(dir, 'scenes'));
  const hub = new Hub(scenes, async () => 'sandbox', () => {});
  const app = createApp({ store: scenes, hub, publicDir: resolve('public'), dictationHistory: history });
  const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  // Real HTTPS transport supplies browser Fetch Metadata. This fixture plays the trusted Serve edge.
  const server = serve({ hostname: '127.0.0.1', port: 0, createServer,
    serverOptions: { key: readFileSync(key), cert: readFileSync(cert) },
    fetch: request => {
      const headers = new Headers(request.headers);
      for (const k of [...headers.keys()]) if (/^(tailscale-|x-forwarded-)/.test(k)) headers.delete(k);
      headers.set('tailscale-user-login', owner); headers.set('tailscale-headers-info', 'sandbox-serve');
      headers.set('x-forwarded-for', '100.64.0.1'); headers.set('x-forwarded-host', new URL(request.url).host); headers.set('x-forwarded-proto', 'https');
      return app.fetch(new Request(request, { headers }));
    },
  });
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['clipboard-read', 'clipboard-write'] });
    // Synthetic native upload through the same authenticated mounted API.
    const native = { 'tailscale-user-login': owner, 'tailscale-headers-info': 'sandbox-serve', 'x-forwarded-for': '100.64.0.2', 'x-forwarded-host': 'desk.example.invalid', 'x-forwarded-proto': 'https', 'x-history-client': 'native', 'content-type': 'application/json' };
    const generation = (await (await app.request('/api/desk/dictation-history', { headers: native })).json()).generation;
    const text = 'Synthetic missed dictation <img src=x onerror=alert(1)> recovered';
    const entry = { id: randomUUID(), capturedAt: Date.now(), text, destination: 'Sandbox target', outcome: 'failed', revision: 1 };
    expect((await app.request('/api/desk/dictation-history', { method: 'POST', headers: native, body: JSON.stringify({ action: 'put', generation, entry }) })).status).toBe(200);
    const page = await context.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    expect((await page.goto(`${base}/history`))?.status()).toBe(200);
    await page.getByText(text, { exact: true }).waitFor();
    expect(await page.locator('article img').count()).toBe(0);
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
    await page.getByRole('searchbox').fill('absent');
    expect(await page.locator('article').count()).toBe(0);
    await page.getByRole('searchbox').fill('missed');
    await page.getByText(text, { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Optional private synthetic evidence only; never captures the production history surface.
    if (process.env.HISTORY_QA_SCREENSHOT) await page.screenshot({ path: process.env.HISTORY_QA_SCREENSHOT, fullPage: true });
    await page.getByRole('button', { name: 'Clear all devices…', exact: true }).click();
    await page.getByRole('button', { name: 'Clear all devices', exact: true }).click();
    await page.getByText('No synced dictations yet.', { exact: true }).waitFor();
    expect(history.list(owner).entries).toEqual([]);
    const files = (await import('node:fs')).readdirSync(history.dir);
    expect(files.map(f => readFileSync(join(history.dir, f), 'utf8')).join('')).not.toContain(text);
    expect(errors).toEqual([]);
    // An old queued capture cannot return after clear, even from another device.
    expect((await app.request('/api/desk/dictation-history', { method: 'POST', headers: native, body: JSON.stringify({ action: 'put', generation, entry }) })).status).toBe(409);
    for (const query of ['?role=screen', '?detached=1']) {
      await page.goto(`${base}/history${query}`);
      const status = await page.evaluate(async () => (await fetch('/api/desk/dictation-history', { headers: { 'X-History-Client': 'desk' } })).status);
      expect(status).toBe(403);
    }
    // A scene embedding the private URL cannot load either its page or API.
    await page.goto(`${base}/history.html`);
    await page.evaluate(() => { const frame = document.createElement('iframe'); frame.sandbox.add('allow-scripts'); frame.src = '/history'; document.body.replaceChildren(frame); });
    await page.waitForTimeout(250);
    expect(await page.locator('iframe').contentFrame().getByText('Owner history view required').count()).toBe(0); // DENY prevents rendering even the rejection page
    await context.close();
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    hub.close(); await browser.close(); rmSync(dir, { recursive: true, force: true });
    if (prior === undefined) delete process.env.SCREEN_ALLOWED_LOGINS; else process.env.SCREEN_ALLOWED_LOGINS = prior;
  }
}, 60_000);
