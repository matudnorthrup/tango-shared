import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { chromium } from 'playwright-core';
import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@tango/tango-voice/live/operator-profile', () => ({ loadOperatorProfiles: () => [], selectOperatorProfile: () => ({ auth: 'codex', voice: 'cove' }) }));
vi.mock('@tango/tango-voice/live/create-live-client', () => ({ resolveLiveRoute: () => ({ defaultVoice: 'cove', create: mocks.create }) }));
vi.mock('@tango/core', () => ({ loadLayeredV2AgentConfigs: () => new Map() }));
// Backup exclusion is already covered by the existing history browser integration.
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === '/usr/bin/tmutil' ? undefined : (actual.execFileSync as Function)(...args) };
});
import { DictationHistoryStore } from '../server/desk/dictation-history-store.js';
import { registerVoiceRoute, attachDeskVoice } from '../server/desk/voice.js';
import { accessControl } from '../server/access.js';

it('real browser handshake captures final server words, default on, and honors device off', async (ctx) => {
  const browser = await chromium.launch({ headless: true }).catch(() => null);
  if (!browser) return ctx.skip();
  const dir = mkdtempSync(join(tmpdir(), 'voice-browser-'));
  const owner = 'owner@example.invalid'; vi.stubEnv('SCREEN_ALLOWED_LOGINS', owner);
  const history = new DictationHistoryStore(join(dir, 'private'));
  const clients: EventEmitter[] = [];
  mocks.create.mockImplementation(() => {
    const client = Object.assign(new EventEmitter(), { start: async () => {}, close: async () => {}, appendAudio: () => {} });
    clients.push(client); return client;
  });
  const options = { dataDir: dir, dictationHistory: history, item: () => ({ agentId: 'fixture', place: 'Synthetic conversation' }), snapshot: () => ({ working: false, replyId: '', text: '' }) };
  const app = new Hono(); app.use('*', accessControl({ allowedLogins: owner })); registerVoiceRoute(app, options);
  app.get('/', c => c.html('<!doctype html><title>Private voice fixture</title><script type="module">import * as prefs from "/desk/voice-history.js"; window.prefs = prefs;</script>'));
  app.get('/desk/voice-history.js', c => c.body(readFileSync(resolve('public/desk/voice-history.js')), 200, { 'Content-Type': 'text/javascript' }));
  const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const server = serve({ hostname: '127.0.0.1', port: 0, createServer, serverOptions: { key: readFileSync(key), cert: readFileSync(cert) }, fetch: app.fetch });
  // Simulated trusted Serve edge on the actual upgrade. No browser-provided owner/device fields.
  server.on('upgrade', req => Object.assign(req.headers, { 'tailscale-user-login': owner, 'tailscale-headers-info': 'fixture', 'x-forwarded-for': '100.64.0.1', 'x-forwarded-host': req.headers.host, 'x-forwarded-proto': 'https' }));
  const closeVoice = attachDeskVoice(server, app, options);
  if (!server.listening) await new Promise<void>(r => server.once('listening', r));
  const base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true }); const page = await context.newPage(); await page.goto(base); await page.waitForFunction(() => !!(window as any).prefs);
    async function connect(query = 'mode=dictation') {
      await page.evaluate(async (query) => {
        const prefs = (window as any).prefs;
        const url = new URL('/api/desk/voice?' + query, location.href); url.protocol = 'wss:'; prefs.applyHistoryPreference(url, 'full');
        await new Promise<void>((resolve, reject) => {
          const socket = new WebSocket(url); (window as any).socket = socket;
          socket.onerror = () => reject(new Error('socket failed'));
          socket.onmessage = e => { if (JSON.parse(e.data).state === 'listening') resolve(); };
        });
      }, query);
    }
    async function dictate() {
      await connect(); clients.at(-1)!.emit('inputTranscript', { delta: 'Synthetic browser words ' });
      await page.evaluate(() => new Promise<void>(resolve => {
        const socket = (window as any).socket; socket.onmessage = (e: MessageEvent) => { if (JSON.parse(e.data).type === 'transcript_final') resolve(); }; socket.send(JSON.stringify({ type: 'finish' }));
      }));
      clients.at(-1)!.emit('inputTranscript', { delta: 'with late words' });
      await page.evaluate(() => new Promise<void>(resolve => { const socket = (window as any).socket; socket.onclose = () => resolve(); socket.close(); }));
    }
    await dictate();
    await vi.waitFor(() => expect(history.list(owner).entries).toHaveLength(1));
    expect(history.list(owner).entries[0]!.text).toBe('Synthetic browser words with late words');
    await page.evaluate(async () => ((window as any).prefs).setHistoryEnabled(false));
    await page.reload(); await page.waitForFunction(() => !!(window as any).prefs); await dictate(); expect(history.list(owner).entries).toHaveLength(1);
    for (const query of ['?detached=1', '?role=screen']) {
      await page.goto(base + '/' + query); await page.waitForFunction(() => !!(window as any).prefs); await page.evaluate(async () => ((window as any).prefs).setHistoryEnabled(true));
      await dictate(); expect(history.list(owner).entries).toHaveLength(1);
    }
    await page.goto(base); await page.waitForFunction(() => !!(window as any).prefs);
    await connect('item=fixture-thread');
    clients.at(-1)!.emit('inputTranscript', { delta: 'Synthetic conversation reply' });
    await page.evaluate(() => new Promise<void>(resolve => {
      const socket = (window as any).socket;
      socket.onmessage = (e: MessageEvent) => {
        if (JSON.parse(e.data).state === 'sending') {
          socket.send(JSON.stringify({ type: 'delivered', ok: true })); resolve();
        }
      };
      socket.send(JSON.stringify({ type: 'finish' }));
    }));
    await vi.waitFor(() => expect(history.list(owner).entries).toHaveLength(2));
    expect(history.list(owner).entries.find(e => e.text === 'Synthetic conversation reply')).toMatchObject({ destination: 'Synthetic conversation', outcome: 'sent' });
    await page.evaluate(() => new Promise<void>(resolve => { const socket = (window as any).socket; socket.onclose = () => resolve(); socket.close(); }));
    expect(history.list(owner).entries).toHaveLength(2);
    const logs = readdirSync(join(dir, 'voice')).map(f => readFileSync(join(dir, 'voice', f), 'utf8')).join('');
    expect(logs).not.toContain('Synthetic conversation reply'); expect(logs).not.toContain('Synthetic browser words'); expect(logs).not.toContain('with late words');
    await context.close();
  } finally {
    closeVoice(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    await browser.close(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
