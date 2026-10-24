import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accessControl, isDirectLocalCaller } from '../server/access.js';
import { createApp } from '../server/app.js';
import { Hub } from '../server/hub.js';
import { SceneStore } from '../server/store.js';

// Headers exactly as `tailscale serve` forwards a tailnet user's request
// (captured from tailscale 1.102.4 proxying to a local echo server).
const TAILNET_HOST = 'mac-studio.example.ts.net';
function viaServe(login: string | null, extra: Record<string, string> = {}): Record<string, string> {
  return {
    host: TAILNET_HOST,
    'tailscale-headers-info': 'https://tailscale.com/s/serve-headers',
    ...(login ? { 'tailscale-user-login': login, 'tailscale-user-name': 'Someone' } : {}),
    'x-forwarded-for': '100.64.0.7',
    'x-forwarded-host': TAILNET_HOST,
    'x-forwarded-proto': 'https',
    ...extra,
  };
}

function testApp(allowedLogins?: string) {
  const logs: Array<{ event: string; data?: Record<string, unknown> }> = [];
  const app = new Hono();
  app.use('*', accessControl({ allowedLogins, log: (event, data) => logs.push({ event, data }) }));
  app.get('/api/scenes', (c) => c.json({ ok: true }));
  app.post('/api/input', (c) => c.json({ ok: true }));
  return { app, logs };
}

describe('tailnet login allowlist', () => {
  it('allows listed logins and refuses others', async () => {
    const { app } = testApp('owner@example.com, partner@example.com');
    expect((await app.request('/api/scenes', { headers: viaServe('owner@example.com') })).status).toBe(200);
    expect((await app.request('/api/scenes', { headers: viaServe('Partner@Example.com') })).status).toBe(200);
    const denied = await app.request('/api/scenes', { headers: viaServe('guest@example.com') });
    expect(denied.status).toBe(403);
  });

  it('refuses a proxied request with no login (a tagged device) when an allowlist is set', async () => {
    const { app } = testApp('owner@example.com');
    expect((await app.request('/api/scenes', { headers: viaServe(null) })).status).toBe(403);
  });

  it.each(['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'forwarded'])(
    'requires an allowed identity for %s alone, including an empty value', async name => {
      const { app } = testApp('owner@example.com');
      for (const value of ['', 'proxy']) {
        for (const method of ['GET', 'POST']) {
          const route = method === 'GET' ? '/api/scenes' : '/api/input';
          expect((await app.request(route, { method, headers: { [name]: value } })).status).toBe(403);
          expect((await app.request(route, { method, headers: { [name]: value, 'tailscale-user-login': 'owner@example.com' } })).status).toBe(200);
        }
      }
    },
  );

  it('lets direct local callers through without a header', async () => {
    const { app } = testApp('owner@example.com');
    expect((await app.request('/api/scenes', { headers: { host: '127.0.0.1:9410' } })).status).toBe(200);
    // The bot and operator post from Node: no Origin header.
    expect((await app.request('/api/input', { method: 'POST', headers: { host: '127.0.0.1:9410' } })).status).toBe(200);
  });

  it('allows every tailnet user when unset, and warns once', async () => {
    const { app, logs } = testApp(undefined);
    expect((await app.request('/api/scenes', { headers: viaServe('anyone@example.com') })).status).toBe(200);
    expect((await app.request('/api/scenes', { headers: viaServe('other@example.com') })).status).toBe(200);
    expect(logs.filter((entry) => entry.event === 'access.open')).toHaveLength(1);
  });

  it('decodes a MIME-encoded login', async () => {
    const { app } = testApp('josé@example.com');
    expect((await app.request('/api/scenes', { headers: viaServe('=?utf-8?q?jos=C3=A9@example.com?=') })).status).toBe(200);
  });

  it('never serves Funnel traffic', async () => {
    const { app } = testApp(undefined);
    expect((await app.request('/api/scenes', { headers: { ...viaServe(null), 'tailscale-funnel-request': '?1' } })).status).toBe(403);
  });
});

describe('same-origin browser writes', () => {
  it('accepts a same-origin POST through tailscale serve', async () => {
    const { app } = testApp('owner@example.com');
    const response = await app.request('/api/input', { method: 'POST', headers: viaServe('owner@example.com', { origin: `https://${TAILNET_HOST}` }) });
    expect(response.status).toBe(200);
  });

  it('accepts a same-origin POST on localhost', async () => {
    const { app } = testApp(undefined);
    const response = await app.request('/api/input', { method: 'POST', headers: { host: '127.0.0.1:9410', origin: 'http://127.0.0.1:9410' } });
    expect(response.status).toBe(200);
  });

  it('refuses a cross-origin or sandboxed-frame POST but allows cross-origin reads', async () => {
    const { app, logs } = testApp('owner@example.com');
    const evil = await app.request('/api/input', { method: 'POST', headers: viaServe('owner@example.com', { origin: 'https://evil.example' }) });
    expect(evil.status).toBe(403);
    const frame = await app.request('/api/input', { method: 'POST', headers: viaServe('owner@example.com', { origin: 'null' }) });
    expect(frame.status).toBe(403);
    const local = await app.request('/api/input', { method: 'POST', headers: { host: '127.0.0.1:9410', origin: 'http://localhost:5173' } });
    expect(local.status).toBe(403);
    expect(logs.some((entry) => entry.event === 'access.cross-origin')).toBe(true);
    const downgraded = await app.request('/api/input', { method: 'POST', headers: viaServe('owner@example.com', { origin: `http://${TAILNET_HOST}` }) });
    expect(downgraded.status).toBe(403);
    const read = await app.request('/api/scenes', { headers: viaServe('owner@example.com', { origin: 'https://evil.example' }) });
    expect(read.status).toBe(200);
  });
});

describe('mounted on the screen app', () => {
  let dir: string;
  const saved = process.env.SCREEN_ALLOWED_LOGINS;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-access-'));
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SCREEN_ALLOWED_LOGINS;
    else process.env.SCREEN_ALLOWED_LOGINS = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads SCREEN_ALLOWED_LOGINS', async () => {
    process.env.SCREEN_ALLOWED_LOGINS = 'owner@example.com';
    const store = new SceneStore(path.join(dir, 'data'));
    const app = createApp({ store, hub: new Hub(store, async () => 'agent', () => {}), publicDir: dir });
    expect((await app.request('/api/status', { headers: viaServe('guest@example.com') })).status).toBe(403);
    expect((await app.request('/api/status', { headers: viaServe('owner@example.com') })).status).toBe(200);
    const stage = await app.request('/api/scenes', {
      method: 'POST',
      headers: viaServe('owner@example.com', { origin: 'https://evil.example', 'content-type': 'application/json' }),
      body: JSON.stringify({ agentId: 'sierra', kind: 'html', body: '<p>x</p>', summary: 's' }),
    });
    expect(stage.status).toBe(403);
  });
});

describe('voice WebSocket origin checks', () => {
  it('applies the mutation origin check to GET upgrades', async () => {
    const { app } = testApp('owner@example.com');
    const headers = viaServe('owner@example.com', { upgrade: 'websocket', origin: 'https://evil.example' });
    expect((await app.request('/api/scenes', { headers })).status).toBe(403);
    headers.origin = `https://${TAILNET_HOST}`;
    expect((await app.request('/api/scenes', { headers })).status).toBe(200);
    headers.origin = 'null';
    expect((await app.request('/api/scenes', { headers })).status).toBe(403);
  });
});

it('does not classify arbitrary forwarding extensions as a direct local caller', () => {
  expect(isDirectLocalCaller(new Headers({ 'x-forwarded-port': '' }))).toBe(false);
  expect(isDirectLocalCaller(new Headers({ forwarded: '' }))).toBe(false);
  expect(isDirectLocalCaller(new Headers())).toBe(true);
});
