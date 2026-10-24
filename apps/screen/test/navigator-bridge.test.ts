import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { accessControl, requireJsonPosts } from '../server/access.js';
import { NavigatorBridge, commandCandidate } from '../server/desk/navigator-bridge.js';

const owner = 'owner@example.invalid';
const exchangeId = '11111111-1111-4111-8111-111111111111';
const context = { place: 'Inbox', choices: [{ action: { op: 'open', target: 'loom:test' }, label: 'Test', confirmation: 'Opened Test.' }] };
const clean: Array<() => void> = [];
afterEach(() => { clean.splice(0).reverse().forEach(fn => fn()); vi.unstubAllEnvs(); });
async function fixture(allowedLogins = owner) {
  vi.stubEnv('SCREEN_ALLOWED_LOGINS', allowedLogins);
  let time = 100_000;
  const resolve = vi.fn(async () => ({ action: context.choices[0]!.action, confirmation: 'Opened Test.', candidates: [] }));
  const bridge = new NavigatorBridge(resolve, () => time);
  const app = new Hono(); app.use('*', accessControl({ allowedLogins }), requireJsonPosts()); bridge.register(app);
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }) as Server;
  await once(server, 'listening');
  clean.push(() => { server.closeAllConnections(); server.close(); }); clean.push(bridge.attach(server, app));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { 'content-type': 'application/json', host, origin: `http://${host}`, 'tailscale-user-login': owner, 'tailscale-headers-info': 'test' };
  async function post(path: string, body: unknown, extra = {}) {
    return fetch(`http://${host}/api/desk/navigator/${path}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  }
  async function window(name = 'Owner window', role = 'full', extra = {}) {
    const ws = new WebSocket(`ws://${host}/api/desk/navigator/bridge`, { headers: { ...headers, ...extra } });
    clean.push(() => ws.terminate());
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'context', context, name, role, activity: true }));
    // A ping/pong fences the registration frame without depending on a sleep.
    const pong = once(ws, 'pong'); ws.ping(); await pong;
    return ws;
  }
  const resolveCommand = () => post('resolve', { exchangeId, transcript: 'go to Test' });
  return { app, host, headers, post, window, resolve, resolveCommand, advance: (ms: number) => { time += ms; } };
}
it('binds a ticket to caller and exchange, dispatches once to its original window, and requires an acknowledgement', async () => {
  const f = await fixture(); const first = await f.window();
  const ticket = await (await f.resolveCommand()).json();
  expect(ticket).toMatchObject({ status: 'action', window: 'Owner window' });
  const other = await f.window('Other window');
  expect((await f.post('commit', { ticket: ticket.ticket, exchangeId: '22222222-2222-4222-8222-222222222222' })).status).toBe(409);
  // Local and authenticated owner are distinct callers even on the same machine.
  expect((await f.app.request(`http://${f.host}/api/desk/navigator/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: ticket.ticket, exchangeId }) })).status).toBe(409);
  const wrongWindow = vi.fn(); other.on('message', wrongWindow);
  const incoming = once(first, 'message');
  const committed = f.post('commit', { ticket: ticket.ticket, exchangeId });
  const event = JSON.parse(String((await incoming)[0]));
  expect(event).toMatchObject({ type: 'execute', context });
  first.send(JSON.stringify({ type: 'executed', ticket: event.ticket, ok: true }));
  expect((await committed).status).toBe(200); expect(wrongWindow).not.toHaveBeenCalled();
  expect((await f.post('commit', { ticket: ticket.ticket, exchangeId })).status).toBe(409);
});
it('ignores house screens, selects the most recent owner window, and expires tickets after undo', async () => {
  const f = await fixture(); await f.window('Older'); f.advance(100); await f.window('Recent'); f.advance(100); await f.window('House', 'screen');
  const result = await (await f.resolveCommand()).json(); expect(result.window).toBe('Recent');
  f.advance(13_001); expect((await f.post('commit', { ticket: result.ticket, exchangeId })).status).toBe(409);
});
it('fails closed when a window disconnects or its catalog changes', async () => {
  const f = await fixture(); const ws = await f.window(); const result = await (await f.resolveCommand()).json();
  ws.send(JSON.stringify({ type: 'context', name: 'Changed', role: 'full', context: { place: 'Elsewhere', choices: [] } }));
  const pong = once(ws, 'pong'); ws.ping(); await pong;
  expect((await f.post('commit', { ticket: result.ticket, exchangeId })).status).toBe(409);
  ws.close(); await once(ws, 'close'); expect(await (await f.resolveCommand()).json()).toMatchObject({ status: 'missing' });
});
it.each(['go to Test', 'show me Test', 'switch to Test', 'take me to Test', 'back', 'go back', 'Please go back.', 'please show me Test'])('gates %s as a possible command', text => expect(commandCandidate(text)).toBe(true));
it.each(['open question about that', 'done with the refactor, tests pass', 'Here is my reply', 'Open the PR and fix it', 'Mark it as low priority', 'Done, ship it', 'Pin the version', 'Back when we talked about it', 'go today', 'show mercy'])('keeps ordinary dictation out of navigation: %s', async transcript => {
  const f = await fixture(); await f.window(); expect(await (await f.post('resolve', { exchangeId, transcript })).json()).toEqual({ status: 'dictation' }); expect(f.resolve).not.toHaveBeenCalled();
});
it('rate limits resolution per caller before model calls', async () => {
  const f = await fixture(); for (let i = 0; i < 12; i++) expect((await f.resolveCommand()).status).toBe(200);
  expect((await f.resolveCommand()).status).toBe(429); f.advance(60_000); expect((await f.resolveCommand()).status).toBe(200);
});
it.each([
  ['non-owner', { 'tailscale-user-login': 'guest@example.invalid' }],
  ['tagged', { 'tailscale-user-login': '' }],
  ['forwarding-only', { 'tailscale-user-login': '', 'tailscale-headers-info': '', 'x-forwarded-for': '100.64.0.1' }],
  ['Funnel', { 'tailscale-funnel-request': '1' }],
  ['detached', { 'x-desk-window': 'detached' }],
  ['cross-origin', { origin: 'http://foreign.example.invalid' }],
] as const)('denies %s on resolve, commit and real bridge upgrade', async (_name, headers) => {
  const f = await fixture();
  expect((await f.post('resolve', { exchangeId, transcript: 'go to Test' }, headers)).status).toBe(403);
  expect((await f.post('commit', { exchangeId, ticket: exchangeId }, headers)).status).toBe(403);
  await expect(f.window('Denied', 'full', headers)).rejects.toThrow(/403/);
  expect(f.resolve).not.toHaveBeenCalled();
});
it('rejects detached query and absent Origin on bridge, even without an allowlist', async () => {
  const f = await fixture(); vi.stubEnv('SCREEN_ALLOWED_LOGINS', '');
  expect((await f.app.request(`http://${f.host}/api/desk/navigator/bridge?detached=1`, { headers: f.headers })).status).toBe(403);
  expect((await f.app.request(`http://${f.host}/api/desk/navigator/bridge`)).status).toBe(403);
  expect((await f.post('resolve', { exchangeId, transcript: 'back' }, { 'tailscale-user-login': '' })).status).toBe(403);
});
it('distinguishes model refusal from ambiguous or missing commands without issuing tickets', async () => {
  const f = await fixture(); await f.window();
  for (const [status, candidates, expected] of [
    ['refused', [], 'dictation'], ['ambiguous', context.choices, 'ambiguous'], ['missing', [], 'missing'],
  ] as const) {
    f.resolve.mockResolvedValueOnce({ action: null, status, candidates, confirmation: '' } as never);
    expect(await (await f.resolveCommand()).json()).toEqual({ status: expected, confirmation: '' });
  }
  f.resolve.mockRejectedValueOnce(new Error('provider failed'));
  expect(await (await f.resolveCommand()).json()).toMatchObject({ status: 'missing' });
});

it('rejects another allowed login committing the owner ticket without consuming it', async () => {
  const other = 'other@example.invalid';
  const f = await fixture(`${owner},${other}`); const ws = await f.window();
  const result = await (await f.resolveCommand()).json();
  expect(result.status).toBe('action');
  expect((await f.post('commit', { ticket: result.ticket, exchangeId }, { 'tailscale-user-login': other })).status).toBe(409);
  const incoming = once(ws, 'message');
  const committed = f.post('commit', { ticket: result.ticket, exchangeId });
  const event = JSON.parse(String((await incoming)[0]));
  ws.send(JSON.stringify({ type: 'executed', ticket: event.ticket, ok: true }));
  expect((await committed).status).toBe(200);
});

it('heartbeats and catalog updates keep windows alive without stealing selection from actual activity', async () => {
  const f = await fixture(); const idle = await f.window('Idle device');
  f.advance(100); const recent = await f.window('Recent device');
  async function update(ws: WebSocket, name: string, activity = false) {
    ws.send(JSON.stringify({ type: 'context', context, name, role: 'full', active: true, activity }));
    const pong = once(ws, 'pong'); ws.ping(); await pong;
  }
  // Both devices remain focused; the idle device sends its heartbeat last.
  for (let i = 0; i < 4; i++) {
    f.advance(10_000); await update(recent, 'Recent device');
    f.advance(100); await update(idle, 'Idle device');
    expect(await (await f.resolveCommand()).json()).toMatchObject({ window: 'Recent device' });
  }
  // Actual input on the other device changes the preferred window.
  f.advance(100); await update(idle, 'Idle device', true);
  f.advance(100); await update(recent, 'Recent device');
  expect(await (await f.resolveCommand()).json()).toMatchObject({ window: 'Idle device' });
});
