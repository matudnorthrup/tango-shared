import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
import { registerAgentHome } from '../server/desk/agent-home.js';
const row = (id: string, extra = {}) => ({ id, agentId: 'coach', agentName: 'Coach', kind: 'thread', source: 'loom', disposition: 'active', replyable: true, lastActivityAt: 1, facts: { role: 'default' }, ...extra });
const fixture = (items = [row('default')]) => { const app = new Hono(); registerAgentHome(app, { items: () => items } as any); return app; };
afterEach(() => vi.unstubAllEnvs());
it('uses the latest chapter before a default, excluding hidden and foreign conversations', async () => {
 const app = fixture([row('default', { lastActivityAt: 10 }), row('old', { kind: 'chapter' }), row('latest', { kind: 'chapter', lastActivityAt: 3 }), row('hidden', { hidden: true, kind: 'chapter', lastActivityAt: 20 }), row('foreign', { agentId: 'other', kind: 'chapter', lastActivityAt: 30 })]);
 expect(await (await app.request('/api/desk/agents/coach/home')).json()).toMatchObject({ itemId: 'latest' });
});
it.each([{ replyable: false }, { disposition: 'done' }, { facts: { role: 'worker' } }, { hidden: true }])('refuses unavailable home %j', async extra => {
 expect((await fixture([row('default', extra)]).request('/api/desk/agents/coach/home')).status).toBe(404);
});
it('accepts the owner and same-origin local browser, rejects detached, foreign and tagged proxy callers', async () => {
 vi.stubEnv('SCREEN_ALLOWED_LOGINS', 'owner@example.invalid'); const app = fixture();
 for (const headers of [{ 'tailscale-headers-info': '1', 'tailscale-user-login': 'owner@example.invalid' }, { 'sec-fetch-site': 'same-origin' }]) expect((await app.request('/api/desk/agents/coach/home', { headers })).status).toBe(200);
 for (const headers of [{ 'x-desk-window': 'detached' }, { 'tailscale-headers-info': '1' }, { 'tailscale-user-login': 'other@example.invalid' }, { origin: 'https://other.invalid', 'sec-fetch-site': 'cross-site' }]) expect((await app.request('/api/desk/agents/coach/home', { headers })).status).toBe(403);
});
