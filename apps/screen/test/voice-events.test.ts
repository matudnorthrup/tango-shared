import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { afterEach, expect, it } from 'vitest';
import { accessControl, requireJsonPosts } from '../server/access.js';
import { registerVoiceEvents, voiceEvent, VoiceEventLog } from '../server/desk/voice-events.js';
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
const event = () => ({ exchangeId: randomUUID(), clientApp: 'tango-mac', clientRole: 'client', version: '1.0', deviceName: 'Test Laptop', mode: 'dictation', endReason: 'silence', outcome: 'posted', targetId: 'loom:test', captureMs: 3200, speechEndToStopMs: 1500, stopToTranscriptMs: -100, transcriptToPostMs: 3100 });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'voice-events-')); dirs.push(dir);
  const app = new Hono(); app.use('*', accessControl({ allowedLogins: 'owner@example.invalid', log: () => {} })); app.use('*', requireJsonPosts());
  registerVoiceEvents(app, dir);
  return { dir, app, post: (body: unknown, headers = {}) => app.request('/api/desk/voice/events', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }) };
}
const serveHeaders = { 'tailscale-headers-info': 'test', 'tailscale-user-login': 'owner@example.invalid', 'x-forwarded-host': 'desk.example.invalid', 'x-forwarded-proto': 'https' };
it('records host and laptop attempts, derives identity, and restricts reading to direct local callers', async () => {
  const { app, post } = fixture();
  const remote = event(); expect((await post(remote, serveHeaders)).status).toBe(200);
  expect((await post({ ...event(), clientRole: 'host', outcome: 'undone', endReason: 'escape' })).status).toBe(200);
  const response = await app.request('/api/desk/voice/events');
  expect(response.headers.get('cache-control')).toBe('no-store');
  const { events } = await response.json(); expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ connection: 'local', login: null, outcome: 'undone' });
  expect(events[1]).toMatchObject({ ...remote, connection: 'tailnet', login: 'owner@example.invalid' });
  for (const headers of [serveHeaders, { origin: 'http://localhost' }, { 'sec-fetch-site': 'same-origin' }, { forwarded: '' }, { 'x-forwarded-custom': '' }]) {
    expect((await app.request('/api/desk/voice/events', { headers })).status).toBe(403);
  }
  expect((await app.request('/api/desk/voice/events?limit=501')).status).toBe(400);
});
it.each([
  { ...serveHeaders, 'tailscale-user-login': 'guest@example.invalid' },
  { 'tailscale-headers-info': 'test' },
  { 'x-forwarded-for': '100.64.0.1' },
  { ...serveHeaders, 'tailscale-funnel-request': '1' },
  { ...serveHeaders, origin: 'https://evil.example.invalid' },
])('rejects unauthorized event writes through the owner allowlist and origin policy: %j', async headers => {
  const { post, app } = fixture(); expect((await post(event(), headers)).status).toBe(403);
  expect(await (await app.request('/api/desk/voice/events')).json()).toEqual({ events: [] });
});
it('refuses extra content, arbitrary errors, invalid timings, and oversized payloads without persisting them', async () => {
  const { post, app, dir } = fixture();
  for (const extra of [{ transcript: 'private speech' }, { audio: 'secret' }, { login: 'forged' }, { errorCode: 'private speech' }, { captureMs: -1 }, { captureMs: Infinity }, { deviceName: 'bad\nname' }]) {
    expect((await post({ ...event(), ...extra })).status).toBe(400);
  }
  expect((await post({ ...event(), transcript: 'x'.repeat(5000) })).status).toBe(413);
  expect((await app.request('/api/desk/voice/events', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
  expect(readdirSync(dir)).toEqual([]);
});
it('rotates bounded files, restricts file permissions, and deduplicates retried exchanges', () => {
  const { dir } = fixture(); const log = new VoiceEventLog(dir, 1400);
  const stored = { ...voiceEvent(event()), at: new Date().toISOString(), connection: 'local' as const, login: null };
  log.append(stored); log.append(stored); expect(log.read()).toHaveLength(1);
  for (let i = 0; i < 30; i++) log.append({ ...stored, exchangeId: randomUUID() });
  expect(readdirSync(dir).sort()).toEqual(['events.jsonl', 'events.jsonl.1', 'events.jsonl.2']);
  for (const file of readdirSync(dir)) {
    expect(statSync(join(dir, file)).size).toBeLessThanOrEqual(1400);
    expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, file), 'utf8')).not.toContain('transcript"');
  }
  expect(log.read(2)).toHaveLength(2);
});
