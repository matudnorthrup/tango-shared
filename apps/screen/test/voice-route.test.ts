import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { accessControl } from '../server/access.js';
const mocks = vi.hoisted(() => ({ auth: 'codex', create: vi.fn() }));
vi.mock('@tango/tango-voice/live/operator-profile', () => ({ loadOperatorProfiles: () => [], selectOperatorProfile: () => ({ auth: mocks.auth, voice: 'cove' }) }));
vi.mock('@tango/tango-voice/live/create-live-client', () => ({ resolveLiveRoute: () => ({ defaultVoice: 'cove', create: mocks.create }) }));
vi.mock('@tango/core', () => ({ loadLayeredV2AgentConfigs: () => new Map() }));
import { registerVoiceRoute, attachDeskVoice } from '../server/desk/voice.js';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); mocks.auth = 'codex'; });
function fixture() {
 const dataDir = mkdtempSync(join(tmpdir(), 'voice-route-')); cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
 const options = { dataDir, item: (id: string) => id === 'thread' ? { agentId: 'helper', replyable: true } : null, snapshot: () => ({ working: false, replyId: 'old', text: 'previous' }) };
 const app = new Hono(); app.use('*', accessControl()); registerVoiceRoute(app, options); return { app, options };
}
it('refuses missing threads and API billing instead of falling back', async () => {
 const { app } = fixture(); expect((await app.request('/api/desk/voice?item=missing')).status).toBe(503);
 mocks.auth = 'api'; expect((await app.request('/api/desk/voice?item=thread')).status).toBe(503); expect(mocks.create).not.toHaveBeenCalled();
});
it('upgrades through access checks and runs a fake live client', async () => {
 const { app, options } = fixture(); const client = Object.assign(new EventEmitter(), { sessionId: 'test', expiresAt: null, isOpen: true, start: vi.fn(async () => {}), appendAudio: vi.fn(), appendContext: vi.fn(async () => ({ clientEventId: 'ok' })), close: vi.fn(async () => {}) });
 mocks.create.mockReturnValue(client);
 const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
 const close = attachDeskVoice(server as import('node:http').Server, app, options);
 cleanup.push(() => { close(); server.close(); });
 if (!server.listening) await once(server, 'listening');
 const port = (server.address() as import('node:net').AddressInfo).port;
 const url = `ws://127.0.0.1:${port}/api/desk/voice?item=thread`;
 const denied = new WebSocket(url, { origin: 'https://evil.example' });
 await expect(once(denied, 'open')).rejects.toThrow('403');
 const socket = new WebSocket(url, { origin: `http://127.0.0.1:${port}` });
 const status = once(socket, 'message'); await once(socket, 'open');
 expect(JSON.parse(String((await status)[0])).state).toBe('listening');
 expect(client.start).toHaveBeenCalledOnce();
 const input = Buffer.alloc(4800); socket.send(input);
 await new Promise(r => setTimeout(r, 20)); expect(client.appendAudio).toHaveBeenCalledWith(input);
 const received = once(socket, 'message'); client.emit('inputTranscript', { delta: 'Hello' });
 expect(JSON.parse(String((await received)[0]))).toEqual({ type: 'transcript', delta: 'Hello' });
 socket.close(); await once(socket, 'close'); await new Promise(r => setTimeout(r, 20)); expect(client.close).toHaveBeenCalled();
});
it('navigator metadata uses the operator voice and refuses API billing', async () => {
 const { app } = fixture();
 expect(await (await app.request('/api/desk/voice?mode=navigator')).json()).toEqual({ voice: 'cove' });
 mocks.auth = 'api'; expect((await app.request('/api/desk/voice?mode=navigator')).status).toBe(503);
});
it('navigator upgrade has the same foreign-origin rejection', async () => {
 const { app, options } = fixture(); const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
 const close = attachDeskVoice(server as import('node:http').Server, app, options); cleanup.push(() => { close(); server.close(); });
 if (!server.listening) await once(server, 'listening');
 const port = (server.address() as import('node:net').AddressInfo).port;
 const socket = new WebSocket(`ws://127.0.0.1:${port}/api/desk/voice?mode=navigator`, { origin: 'https://evil.example' });
 await expect(once(socket, 'open')).rejects.toThrow('403');
});

it('Start work dictation needs no existing thread and still refuses API billing', async () => {
 const { app } = fixture();
 expect((await app.request('/api/desk/voice?mode=dictation')).status).toBe(200);
 mocks.auth = 'api'; expect((await app.request('/api/desk/voice?mode=dictation')).status).toBe(503);
});

it.each([
 ['mode=dictation', false],
 ['mode=dictation&manualFinish=1', true],
 ['item=thread&manualFinish=1', false],
])('manual finishing is opt-in and dictation-only: %s', async (query, held) => {
 const { app, options } = fixture();
 const client = Object.assign(new EventEmitter(), { sessionId: 'test', expiresAt: null, isOpen: true, start: vi.fn(async () => {}), appendAudio: vi.fn(), appendContext: vi.fn(async () => ({ clientEventId: 'ok' })), close: vi.fn(async () => {}) });
 mocks.create.mockReturnValue(client);
 const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
 const close = attachDeskVoice(server as import('node:http').Server, app, options);
 cleanup.push(() => { close(); server.close(); });
 if (!server.listening) await once(server, 'listening');
 const port = (server.address() as import('node:net').AddressInfo).port;
 const socket = new WebSocket(`ws://127.0.0.1:${port}/api/desk/voice?${query}`, { origin: `http://127.0.0.1:${port}` });
 const ready = once(socket, 'message'); await once(socket, 'open'); await ready;
 const states: string[] = []; socket.on('message', data => { const e = JSON.parse(String(data)); if (e.type === 'status') states.push(e.state); });
 client.emit('inputTranscript', { delta: 'Use blue.' });
 client.emit('delegation', { id: 'pause' });
 socket.send(Buffer.alloc(4800));
 await vi.waitFor(() => { expect(client.appendAudio).toHaveBeenCalledTimes(held ? 1 : 0); expect(states).toEqual(held ? ['speech_end'] : ['sending']); });
 if (held) { socket.send(JSON.stringify({ type: 'finish' })); await vi.waitFor(() => expect(states).toEqual(['speech_end', 'sending'])); }
 socket.close(); await once(socket, 'close');
});

it('warms only an authorized manual dictation socket; drops audio until start', async () => {
 const { app, options } = fixture();
 const client = Object.assign(new EventEmitter(), { sessionId: 'test', expiresAt: null, isOpen: true, start: vi.fn(async () => {}), appendAudio: vi.fn(), appendContext: vi.fn(async () => ({ clientEventId: 'ok' })), close: vi.fn(async () => {}) });
 mocks.create.mockClear().mockReturnValue(client);
 const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
 const close = attachDeskVoice(server as import('node:http').Server, app, options);
 cleanup.push(() => { close(); server.close(); });
 if (!server.listening) await once(server, 'listening');
 const port = (server.address() as import('node:net').AddressInfo).port;
 const url = `ws://127.0.0.1:${port}/api/desk/voice?mode=dictation&manualFinish=1&warm=1`;
 const denied = new WebSocket(url, { origin: 'https://evil.example' });
 await expect(once(denied, 'open')).rejects.toThrow('403');
 const socket = new WebSocket(url, { origin: `http://127.0.0.1:${port}` });
 const armed = once(socket, 'message'); await once(socket, 'open');
 expect(JSON.parse(String((await armed)[0])).state).toBe('armed');
 socket.send(Buffer.alloc(4800)); socket.ping(); await once(socket, 'pong');
 expect(mocks.create).not.toHaveBeenCalled(); expect(client.appendAudio).not.toHaveBeenCalled();
 const listening = once(socket, 'message'); socket.send(JSON.stringify({ type: 'start' }));
 expect(JSON.parse(String((await listening)[0])).state).toBe('listening');
 expect(mocks.create).toHaveBeenCalledOnce();
 socket.send(Buffer.alloc(4800)); socket.ping(); await once(socket, 'pong');
 expect(client.appendAudio).toHaveBeenCalledOnce();
 socket.close(); await once(socket, 'close');
 // The peer's close event can precede the server's close handler.
 await vi.waitFor(() => expect(client.close).toHaveBeenCalledOnce());
});

it.each([
 ['Use blue.', 'speech_end', undefined],
 ['Use blue and', 'waiting', 4000],
 ["I'm gonna ramble for a minute.", 'holding', undefined],
])('answers a native pause frame for %s', async (text, state, untilMs) => {
 const { app, options } = fixture();
 const client = Object.assign(new EventEmitter(), { start: vi.fn(async () => {}), appendAudio: vi.fn(), close: vi.fn(async () => {}) });
 mocks.create.mockReturnValue(client);
 const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
 const close = attachDeskVoice(server as import('node:http').Server, app, options);
 cleanup.push(() => { close(); server.close(); });
 if (!server.listening) await once(server, 'listening');
 const port = (server.address() as import('node:net').AddressInfo).port;
 const socket = new WebSocket(`ws://127.0.0.1:${port}/api/desk/voice?mode=dictation&manualFinish=1`, { origin: `http://127.0.0.1:${port}` });
 const ready = once(socket, 'message'); await once(socket, 'open'); await ready;
 const transcript = once(socket, 'message'); client.emit('inputTranscript', { delta: text }); await transcript;
 const response = once(socket, 'message'); socket.send(JSON.stringify({ type: 'pause', quietMs: 1500 }));
 expect(JSON.parse(String((await response)[0]))).toMatchObject({ type: 'status', state, ...(untilMs ? { untilMs } : {}) });
 socket.close(); await once(socket, 'close');
});
