import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { LabFences, LAB_FENCE_MAX_TTL_MS } from '../server/desk/lab-fence.js';
import type { DeskMail } from '../server/desk/mail.js';
import { registerDeskRoutes } from '../server/desk/routes.js';
import { makeHarness } from './desk-harness.js';

describe('LabFences', () => {
  it('fences a session’s scratch items until it is cleared or lapses', () => {
    let now = 1000;
    const fences = new LabFences(() => now);
    fences.set('lab-1', ['loom:a', 'loom:b'], 60_000);
    expect(fences.checkStart('loom:a')).toMatch(/lab-1/);
    expect(fences.checkStart('loom:real')).toBeNull();
    // Inside the fence is fine; out of it is not; an unfenced sender is never touched.
    expect(fences.checkWrite('loom:a', 'loom:b')).toBeNull();
    expect(fences.checkWrite('loom:a', 'loom:real')).toMatch(/not loom:real/);
    expect(fences.checkWrite('loom:real', 'loom:a')).toBeNull();
    now += 60_001;
    expect(fences.checkStart('loom:a')).toBeNull();
    expect(fences.active()).toEqual([]);
    fences.set('lab-2', ['loom:a']);
    expect(fences.clear('lab-2')).toBe(true);
    expect(fences.checkStart('loom:a')).toBeNull();
  });

  it('caps the TTL', () => {
    const fences = new LabFences(() => 0);
    expect(fences.set('lab', ['x'], 10 * LAB_FENCE_MAX_TTL_MS).expiresAt).toBe(LAB_FENCE_MAX_TTL_MS);
  });
});

describe('lab fence routes', () => {
  let app: Hono;
  let calls: string[];
  const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  beforeEach(() => {
    const h = makeHarness();
    calls = [];
    const record = { id: 'm-1', fromItemId: 'loom:real', toItemId: 'loom:a' };
    const mail = {
      send: (request: { from: string; to: string }) => (calls.push(`send ${request.from}→${request.to}`), { ok: true, mail: record }),
      start: async (request: { from: string }) => (calls.push(`start ${request.from}`), { ok: true, itemId: 'loom:new', mail: record }),
      answer: (id: string, from: string) => (calls.push(`answer ${id} ${from}`), { ok: true, mail: record }),
      get: (id: string) => (id === 'm-1' ? record : null),
      view: (m: unknown) => m,
    } as unknown as DeskMail;
    app = new Hono();
    registerDeskRoutes(app, { core: h.core, scenes: () => [], mail });
  });

  it('blocks a fenced scratch thread from starting threads or writing out, and lets the rest through', async () => {
    expect((await app.request('/api/desk/lab-fence', json({ sessionId: 'lab-1', scratch: ['loom:a', 'loom:b'] }))).status).toBe(200);
    expect((await (await app.request('/api/desk/lab-fence')).json()).fences).toHaveLength(1);

    const start = await app.request('/api/desk/mail/start', json({ from: 'loom:a', prompt: 'spin up a helper' }));
    expect(start.status).toBe(403);
    expect((await start.json()).error).toMatch(/blocked by the lab fence/);
    expect((await app.request('/api/desk/mail', json({ from: 'loom:a', to: 'loom:real', text: 'hi' }))).status).toBe(403);
    // Answering mail from a real thread is writing to it.
    expect((await app.request('/api/desk/mail/m-1/answer', json({ from: 'loom:a', text: 'done' }))).status).toBe(403);
    expect(calls).toEqual([]);

    // Inside the fence, and anyone outside it, are untouched.
    expect((await app.request('/api/desk/mail', json({ from: 'loom:a', to: 'loom:b', text: 'hi' }))).status).toBe(200);
    expect((await app.request('/api/desk/mail/start', json({ from: 'loom:real', prompt: 'real work' }))).status).toBe(200);
    expect(calls).toEqual(['send loom:a→loom:b', 'start loom:real']);

    // Cleared: the scratch thread is an ordinary thread again.
    expect((await app.request('/api/desk/lab-fence/lab-1', { method: 'DELETE', headers: { 'Content-Type': 'application/json' } })).status).toBe(200);
    expect((await app.request('/api/desk/mail/start', json({ from: 'loom:a', prompt: 'now fine' }))).status).toBe(200);
  });

  it('takes fences from local callers only', async () => {
    const browser = await app.request('/api/desk/lab-fence', { ...json({ sessionId: 'x', scratch: ['loom:a'] }), headers: { 'Content-Type': 'application/json', Origin: 'https://example.test' } });
    expect(browser.status).toBe(403);
    expect((await app.request('/api/desk/lab-fence', json({ sessionId: 'x', scratch: [] }))).status).toBe(400);
    const many = Array.from({ length: 51 }, (_, i) => `loom:s${i}`);
    expect((await app.request('/api/desk/lab-fence', json({ sessionId: 'x', scratch: many }))).status).toBe(400);
    expect((await (await app.request('/api/desk/lab-fence')).json()).fences).toEqual([]);
  });
});
