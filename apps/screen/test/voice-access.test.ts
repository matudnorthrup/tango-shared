import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { serve } from '@hono/node-server';
import WebSocket from 'ws';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const model = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@tango/tango-voice/live/operator-profile', () => ({
  loadOperatorProfiles: () => [], selectOperatorProfile: () => ({ auth: 'codex', voice: 'cove' }),
}));
vi.mock('@tango/tango-voice/live/create-live-client', () => ({
  resolveLiveRoute: () => ({ defaultVoice: 'cove', create: model.create }),
}));
import { createApp } from '../server/app.js';
import { attachDeskVoice } from '../server/desk/voice.js';
import { Hub } from '../server/hub.js';
import { SceneStore } from '../server/store.js';

const host = 'desk.example.invalid';
const owner = 'owner@example.invalid';
const cleanup: Array<() => void | Promise<void>> = [];
beforeEach(() => {
  vi.stubEnv('SCREEN_ALLOWED_LOGINS', owner);
  model.create.mockReset();
  model.create.mockImplementation(() => Object.assign(new EventEmitter(), {
    sessionId: 'sandbox', expiresAt: null, isOpen: true,
    start: vi.fn(async () => {}), appendAudio: vi.fn(),
    appendContext: vi.fn(async () => ({ clientEventId: 'sandbox' })), close: vi.fn(async () => {}),
  }));
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});

async function listen(server: Server) {
  // Track upgraded connections too: server.closeAllConnections does not close them.
  const sockets = new Set<Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  if (!server.listening) await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

async function fixture(login: string | null = owner, funnel = false, forwardingOnly = false) {
  const dataDir = mkdtempSync(join(tmpdir(), 'voice-access-'));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const store = new SceneStore(join(dataDir, 'scenes'));
  const voice = { dataDir, item: () => null, snapshot: () => ({ working: false, replyId: '', text: '' }) };
  const app = createApp({ store, hub: new Hub(store, async () => 'sandbox', () => {}), publicDir: dataDir, voice });
  const backend = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }) as Server;
  const backendPort = await listen(backend);
  cleanup.push(attachDeskVoice(backend, app, voice));

  // Contract double of the trusted Serve edge, not a test of Tailscale itself.
  // Identity comes from the proxy's authenticated peer, never request headers.
  const proxy = createServer();
  proxy.on('upgrade', (incoming, downstream, head) => {
    const headers = { ...incoming.headers };
    for (const name of Object.keys(headers)) {
      if (name.startsWith('tailscale-') || name.startsWith('x-forwarded-')) delete headers[name];
    }
    Object.assign(headers, {
      host: `127.0.0.1:${backendPort}`,
      ...(forwardingOnly ? {} : { 'tailscale-headers-info': 'sandbox-serve' }),
      'x-forwarded-host': host, 'x-forwarded-proto': 'https', 'x-forwarded-for': '100.64.0.7',
      ...(forwardingOnly || login === null ? {} : { 'tailscale-user-login': login }),
      ...(funnel ? { 'tailscale-funnel-request': '1' } : {}),
    });
    const upstream = request({ host: '127.0.0.1', port: backendPort, path: incoming.url, headers });
    downstream.on('error', () => upstream.destroy());
    upstream.on('error', () => downstream.destroy());
    upstream.on('response', response => {
      downstream.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      response.resume();
    });
    upstream.on('upgrade', (response, socket, upstreamHead) => {
      socket.on('error', () => downstream.destroy());
      downstream.on('close', () => socket.destroy());
      socket.on('close', () => downstream.destroy());
      downstream.write(`HTTP/1.1 ${response.statusCode} Switching Protocols\r\n${Object.entries(response.headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`);
      if (upstreamHead.length) downstream.write(upstreamHead);
      if (head.length) socket.write(head);
      socket.pipe(downstream); downstream.pipe(socket);
    });
    upstream.end();
  });
  proxy.listen(0, '127.0.0.1');
  const port = await listen(proxy);
  return (origin: string | undefined = `https://${host}`, headers: Record<string, string> = {}) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/desk/voice?mode=dictation&manualFinish=1`, {
      ...(origin === '' ? {} : { origin }), headers, handshakeTimeout: 2000,
    });
    cleanup.push(() => { if (socket.readyState === WebSocket.OPEN) socket.terminate(); });
    return socket;
  };
}

it('upgrades the mounted voice route through forwarded HTTPS identity and starts only the fake model', async () => {
  const connect = await fixture();
  const socket = connect();
  const ready = once(socket, 'message');
  const upgraded = once(socket, 'upgrade');
  await once(socket, 'open');
  const [response] = await upgraded;
  expect(response.statusCode).toBe(101);
  expect(response.httpVersion).toBe('1.1');
  expect(JSON.parse(String((await ready)[0]))).toMatchObject({ type: 'status', state: 'listening' });
  expect(model.create).toHaveBeenCalledOnce();
  expect(model.create.mock.results[0]!.value.start).toHaveBeenCalledOnce();
  socket.close(); await once(socket, 'close');
});

it.each([
  ['no Origin', owner, '', false],
  ['wrong Origin', owner, 'https://foreign.example.invalid', false],
  ['wrong scheme', owner, `http://${host}`, false],
  ['unlisted login', 'guest@example.invalid', `https://${host}`, false],
  ['tagged device', null, `https://${host}`, false],
  ['Funnel', owner, `https://${host}`, true],
] as const)('rejects %s before creating a model', async (_name, login, origin, funnel) => {
  const connect = await fixture(login, funnel);
  const socket = connect(origin);
  await expect(once(socket, 'open')).rejects.toThrow(origin === '' ? /socket hang up/ : /403/);
  expect(model.create).not.toHaveBeenCalled();
});

it.each(['guest@example.invalid', null])('cannot spoof owner identity through the proxy as %s', async login => {
  const connect = await fixture(login);
  const socket = connect(`https://${host}`, {
    'Tailscale-User-Login': owner, 'Tailscale-Headers-Info': 'forged',
    'X-Forwarded-Host': host, 'X-Forwarded-Proto': 'https',
  });
  await expect(once(socket, 'open')).rejects.toThrow(/403/);
  expect(model.create).not.toHaveBeenCalled();
});

// #1067 closes the forwarding-only bypass recorded by #1066.
it('rejects forwarding-only identity-less upgrades before creating a model', async () => {
  const connect = await fixture(null, false, true);
  const socket = connect();
  await expect(once(socket, 'open')).rejects.toThrow(/403/);
  expect(model.create).not.toHaveBeenCalled();
});

it('documents that an unset allowlist admits an otherwise unlisted proxied login', async () => {
  vi.stubEnv('SCREEN_ALLOWED_LOGINS', '');
  const connect = await fixture('guest@example.invalid');
  const socket = connect();
  const ready = once(socket, 'message');
  await once(socket, 'open');
  expect(JSON.parse(String((await ready)[0]))).toMatchObject({ type: 'status', state: 'listening' });
  expect(model.create).toHaveBeenCalledOnce();
  socket.close(); await once(socket, 'close');
});
