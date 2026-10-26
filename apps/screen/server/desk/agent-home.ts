import type { Hono } from 'hono';
import type { DeskCore } from './core.js';
import { isAllowedOwnerLogin, isDirectLocalCaller } from '../access.js';
// @ts-expect-error shared browser model
import { agentChat } from '../../public/desk/next/model.js';

/** Resolve exactly the home chat pinned on the agent page; never create a conversation. */
export function registerAgentHome(app: Hono, core: Pick<DeskCore, 'items'>) {
  app.get('/api/desk/agents/:id/home', c => {
    const headers = c.req.raw.headers;
    const proxied = [...headers.keys()].some(k => /^(tailscale-|x-forwarded-|forwarded$)/.test(k));
    const localBrowser = !proxied && headers.get('sec-fetch-site') === 'same-origin';
    const owner = !!headers.get('tailscale-headers-info')?.trim() && isAllowedOwnerLogin(headers.get('tailscale-user-login') ?? undefined, process.env.SCREEN_ALLOWED_LOGINS);
    if (headers.get('x-desk-window') === 'detached' || (!isDirectLocalCaller(headers) && !localBrowser && !owner)) return c.json({ error: 'Owner window required' }, 403);
    c.header('Cache-Control', 'no-store');
    const items = core.items().filter(i => !i.hidden && i.source !== 'system');
    const item = agentChat({ active: { items: items.filter(i => i.disposition !== 'done') }, history: { items: items.filter(i => i.disposition === 'done') } }, c.req.param('id'));
    if (!item || item.replyable === false || item.disposition !== 'active') return c.json({ error: 'No replyable home conversation' }, 404);
    return c.json({ itemId: item.id, agentName: item.agentName });
  });
}
