import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// OS backup exclusion is exercised once by the browser integration; avoid a tmutil process per fixture.
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), execFileSync: vi.fn() }));
import { accessControl, requireJsonPosts } from '../server/access.js';
import { DictationHistoryStore, HISTORY_TTL } from '../server/desk/dictation-history-store.js';
import { registerDictationHistory } from '../server/desk/dictation-history.js';
import { createApp } from '../server/app.js';
import { SceneStore } from '../server/store.js';
import { Hub } from '../server/hub.js';

let dir: string, now: number, store: DictationHistoryStore;
const owner = 'owner@example.invalid', other = 'other@example.invalid';
const headers = { 'tailscale-headers-info': 'serve', 'tailscale-user-login': owner, 'x-forwarded-for': '100.64.0.1', 'x-forwarded-host': 'desk.example.invalid', 'x-forwarded-proto': 'https', 'x-history-client': 'native', 'content-type': 'application/json' };
const entry = (extra = {}) => ({ id: randomUUID(), capturedAt: now, text: 'Synthetic failed-send recovery', destination: 'Test thread', outcome: 'failed', revision: 1, ...extra });
const generation = () => store.list(owner).generation;
const disk = () => readdirSync(dir).filter(n => n.endsWith('.json')).map(n => readFileSync(join(dir, n), 'utf8')).join('');
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dictation-history-'));
  now = Date.now(); store = new DictationHistoryStore(dir, () => now);
  vi.stubEnv('SCREEN_ALLOWED_LOGINS', `${owner},${other}`);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
function app() {
  const app = new Hono();
  app.use('*', accessControl({ allowedLogins: process.env.SCREEN_ALLOWED_LOGINS, log: () => {} }));
  app.use('*', requireJsonPosts());
  registerDictationHistory(app, store, resolve('public'));
  return app;
}
function post(a: Hono, body: unknown, h = headers) { return a.request('/api/desk/dictation-history', { method: 'POST', headers: h, body: JSON.stringify(body) }); }

describe('private persistence and deletion', () => {
  it('partitions owners, dedupes retries and refuses stale revisions or a spoofed source', () => {
    const e = entry(); store.put(owner, 'device-a', generation(), e);
    store.put(owner, 'device-a', generation(), { ...e, outcome: 'sent', revision: 2 });
    store.put(owner, 'device-a', generation(), e);
    expect(store.list(owner).entries).toEqual([{ ...e, device: 'device-a', outcome: 'sent', revision: 2 }]);
    expect(store.list(other).entries).toEqual([]);
    expect(() => store.put(owner, 'device-b', generation(), { ...e, revision: 3 })).toThrow('entry_conflict');
    expect(() => store.put(owner, 'device-a', generation(), { ...e, text: 'changed', revision: 3 })).toThrow('entry_conflict');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const file of readdirSync(dir)) expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
  });
  it('rewrites deleted text away and keeps only an ID/expiry tombstone through restart', () => {
    const e = entry(); store.put(owner, 'a', generation(), e); store.delete(owner, generation(), e.id);
    expect(disk()).not.toContain(e.text); expect(disk()).not.toContain(e.destination);
    store = new DictationHistoryStore(dir, () => now);
    expect(store.list(owner).deleted).toEqual([e.id]);
    expect(() => store.put(owner, 'a', generation(), e)).toThrow('entry_deleted');
  });
  it('clear rotates a durable generation, rejects every old queue regardless of client clocks', () => {
    const before = generation(), e = entry(); store.put(owner, 'a', before, e);
    store.clear(owner, before);
    expect(disk()).not.toContain(e.text); expect(disk()).not.toContain(e.destination);
    store = new DictationHistoryStore(dir, () => now);
    expect(generation()).not.toBe(before);
    expect(() => store.put(owner, 'a', before, e)).toThrow('generation_changed');
    expect(() => store.put(owner, 'b', before, entry({ capturedAt: now + 30_000 }))).toThrow('generation_changed');
    expect(() => store.clear(owner, before)).toThrow('generation_changed');
    expect(() => store.delete(owner, before, e.id)).toThrow('generation_changed');
    expect(store.list(owner).entries).toEqual([]);
  });
  it('expires on startup and idle sweep and cleans interrupted snapshots even after clear', () => {
    const e = entry(); store.put(owner, 'a', generation(), e);
    writeFileSync(join(dir, `.history-${randomUUID()}.tmp`), 'Synthetic interrupted text', { mode: 0o600 });
    now += HISTORY_TTL;
    store = new DictationHistoryStore(dir, () => now);
    expect(disk()).not.toContain(e.text);
    expect(readdirSync(dir).some(n => n.endsWith('.tmp'))).toBe(false);
    store.put(owner, 'a', generation(), entry()); now += HISTORY_TTL; store.sweep();
    expect(store.list(owner).entries).toEqual([]);
    expect(() => store.put(owner, 'a', generation(), e)).toThrow('invalid_entry');
  });
  it('bounds retention at 200 without letting evicted retry records resurrect', () => {
    const first = entry(); store.put(owner, 'a', generation(), first);
    for (let i = 0; i < 200; i++) { now += 61_000; store.put(owner, 'a', generation(), entry()); }
    expect(store.list(owner).entries).toHaveLength(200);
    expect(store.list(owner).deleted).toContain(first.id);
    expect(() => store.put(owner, 'a', generation(), first)).toThrow('entry_deleted');
  });
  it('limits device writes across retries, restart and clear without blocking another device', () => {
    for (let i = 0; i < 12; i++) store.put(owner, 'a', generation(), entry());
    expect(() => store.put(owner, 'a', generation(), entry())).toThrow('rate_limited');
    store.clear(owner, generation()); store = new DictationHistoryStore(dir, () => now);
    expect(() => store.put(owner, 'a', generation(), entry())).toThrow('rate_limited');
    store.put(owner, 'b', generation(), entry());
    now += 60_000; store.put(owner, 'a', generation(), entry());
  });
  it('rejects symlink snapshots rather than reading or overwriting outside the store', () => {
    generation(); const file = join(dir, readdirSync(dir)[0]!); rmSync(file); symlinkSync('/not-a-history-file', file);
    expect(() => store.list(owner)).toThrow();
  });
});

describe('HTTP authorization and schema', () => {
  it('accepts authenticated native sync, derives device, returns no-store, rechecks revocation', async () => {
    const a = app(); const e = entry();
    expect((await post(a, { action: 'put', generation: generation(), entry: e })).status).toBe(200);
    const response = await a.request('/api/desk/dictation-history', { headers });
    expect(response.headers.get('cache-control')).toBe('no-store, no-transform');
    expect((await response.json()).entries[0]).toMatchObject({ text: e.text, device: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const separated = await a.request('/api/desk/dictation-history', { headers: { ...headers, 'tailscale-user-login': other } });
    expect((await separated.json()).entries).toEqual([]);
    vi.stubEnv('SCREEN_ALLOWED_LOGINS', other);
    expect((await a.request('/api/desk/dictation-history', { headers })).status).toBe(403);
    expect((await post(a, { action: 'clear', generation: generation() })).status).toBe(403);
  });
  it.each([
    ['local', {}], ['missing identity', { ...headers, 'tailscale-user-login': '' }],
    ['wrong login', { ...headers, 'tailscale-user-login': 'guest@example.invalid' }],
    ['missing proxy marker', { ...headers, 'tailscale-headers-info': '' }],
    ['missing device', { ...headers, 'x-forwarded-for': '' }],
    ['multiple addresses', { ...headers, 'x-forwarded-for': '100.64.0.1, 100.64.0.2' }],
    ['Funnel', { ...headers, 'tailscale-funnel-request': '1' }],
    ['detached', { ...headers, 'x-desk-window': 'detached' }],
    ['house screen', { ...headers, 'x-desk-window': 'screen' }],
    ['scene frame', { ...headers, origin: 'null', 'sec-fetch-site': 'cross-site' }],
    ['browser spoofing native', { ...headers, 'sec-fetch-site': 'same-origin' }],
  ])('refuses %s reads and writes', async (_label, h) => {
    const a = app();
    expect((await a.request('/api/desk/dictation-history', { headers: h })).status).toBe(403);
    expect((await post(a, { action: 'clear', generation: generation() }, { ...h, 'content-type': 'application/json' } as typeof headers)).status).toBe(403);
  });
  it('fails closed with an unset explicit allowlist', async () => {
    vi.stubEnv('SCREEN_ALLOWED_LOGINS', '');
    expect((await app().request('/api/desk/dictation-history', { headers })).status).toBe(403);
  });
  it('serves only a private top-level page and its same-origin API requests', async () => {
    const a = app();
    const browser = { ...headers, 'x-history-client': 'desk', 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty', referer: 'https://desk.example.invalid/tango-screen/history' };
    expect((await a.request('/api/desk/dictation-history', { headers: browser })).status).toBe(200);
    for (const ref of ['https://desk.example.invalid/tango-screen/?role=screen', 'https://desk.example.invalid/tango-screen/?detached=1', 'https://desk.example.invalid/tango-screen/frame/scene', 'https://desk.example.invalid/tango-screen/history?detached=1', 'https://elsewhere.invalid/history']) {
      expect((await a.request('/api/desk/dictation-history', { headers: { ...browser, referer: ref } })).status).toBe(403);
    }
    const page = { ...headers, 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' };
    const r = await a.request('/history', { headers: page });
    expect(r.status).toBe(200); expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect((await a.request('/history', { headers: { ...page, 'sec-fetch-dest': 'iframe' } })).status).toBe(403);
    expect((await a.request('/history?role=screen', { headers: page })).status).toBe(403);
    expect((await a.request('/history?detached=1', { headers: page })).status).toBe(403);
  });
  it('rejects audio, spoofed identities, oversize text/body, invalid times and revisions without echoing text', async () => {
    const a = app();
    for (const change of [{ text: 'x'.repeat(16_385) }, { text: '😀'.repeat(4097) }, { audio: 'secret' }, { owner: other }, { device: 'spoof' }, { capturedAt: now - HISTORY_TTL }, { capturedAt: now + 61_000 }, { revision: -1 }]) {
      const r = await post(a, { action: 'put', generation: generation(), entry: entry(change) });
      expect(r.status).toBe(400); expect(await r.json()).toEqual({ error: 'invalid_entry' });
    }
    expect((await post(a, { action: 'put', generation: generation(), entry: entry({ text: 'x'.repeat(25_000) }) })).status).toBe(413);
    expect((await post(a, { action: 'clear', generation: generation(), owner: other })).status).toBe(400);
  });
  it('does not place history in scene status, stages, assets or the shared hub', async () => {
    const scenes = new SceneStore(join(dir, 'scenes'));
    const hub = new Hub(scenes, async () => 'sandbox', () => {});
    const a = createApp({ store: scenes, hub, publicDir: resolve('public'), dictationHistory: store });
    const e = entry(); store.put(owner, 'a', generation(), e);
    for (const url of ['/api/status', '/api/stages/test', '/api/scenes/dictation-history', '/assets/dictation-history', '/frame/dictation-history']) {
      const r = await a.request(url, { headers }); expect(await r.text()).not.toContain(e.text);
    }
    expect(JSON.stringify(hub.status())).not.toContain(e.text);
    expect((await a.request('/api/desk/dictation-history', { headers: { ...headers, origin: 'null' } })).status).toBe(403);
    hub.close();
  });
});
