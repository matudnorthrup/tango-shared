import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { DictationHistoryStore, HistoryError } from './dictation-history-store.js';

const BASE = '/api/desk/dictation-history';
/** The loopback listener trusts only the Serve edge. No direct-local or unset-allowlist exception. */
export function historyCaller(headers: Headers): { owner: string; device: string } | null {
  const owner = headers.get('tailscale-user-login')?.trim().toLowerCase();
  const allowed = (process.env.SCREEN_ALLOWED_LOGINS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const ip = headers.get('x-forwarded-for')?.trim();
  if (!owner || !allowed.includes(owner) || !ip || !isIP(ip) || !headers.get('tailscale-headers-info')?.trim()
    || headers.has('tailscale-funnel-request') || headers.get('x-forwarded-proto') !== 'https'
    || !headers.get('x-forwarded-host') || headers.has('x-desk-window')) return null;
  return { owner, device: createHash('sha256').update(`${owner}\0${ip}`).digest('hex') };
}
function ownerBrowser(c: Context, page = false): boolean {
  const h = c.req.raw.headers;
  if (new URL(c.req.url).search) return false;
  if (page) {
    if (h.has('referer')) {
      try {
        const ref = new URL(h.get('referer')!);
        if (ref.origin !== `https://${h.get('x-forwarded-host')}` || ref.searchParams.get('role') === 'screen'
          || ref.searchParams.get('detached') === '1' || /\/(?:frame|bundles|assets)\//.test(ref.pathname)) return false;
      } catch { return false; }
    }
    return h.get('sec-fetch-dest') === 'document' && h.get('sec-fetch-mode') === 'navigate'
      && ['same-origin', 'none'].includes(h.get('sec-fetch-site') ?? '');
  }
  if (h.get('x-history-client') === 'native') return !h.has('origin') && !h.has('sec-fetch-site') && !h.has('referer');
  if (h.get('x-history-client') !== 'desk' || h.get('sec-fetch-site') !== 'same-origin' || h.get('sec-fetch-dest') !== 'empty') return false;
  try {
    const ref = new URL(h.get('referer') ?? '');
    const expected = `https://${h.get('x-forwarded-host')}`;
    return ref.origin === expected && /^\/(?:tango-screen\/)?history$/.test(ref.pathname) && !ref.search
      && (!h.has('origin') || h.get('origin') === expected);
  } catch { return false; }
}
function privateHeaders(c: Context) {
  c.header('Cache-Control', 'no-store, no-transform');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  c.header('Referrer-Policy', 'same-origin');
}
/** Deliberately separate from desk snapshots, scenes, search, events and the shared presentation. */
export function registerDictationHistory(app: Hono, store: DictationHistoryStore, publicDir: string) {
  app.use(BASE, async (c, next) => {
    privateHeaders(c);
    if (!historyCaller(c.req.raw.headers) || !ownerBrowser(c)) return c.json({ error: 'owner_history_only' }, 403);
    await next();
  });
  app.get(BASE, c => {
    try { return c.json(store.list(historyCaller(c.req.raw.headers)!.owner)); }
    catch { return c.json({ error: 'history_unavailable' }, 503); }
  });
  app.post(BASE, bodyLimit({ maxSize: 24_000, onError: c => c.json({ error: 'body_too_large' }, 413) }), async c => {
    try {
      const b = await c.req.json();
      if (!b || typeof b !== 'object' || Array.isArray(b)
        || Object.keys(b).some(k => !['action', 'generation', 'entry', 'id'].includes(k))) throw new HistoryError('invalid_request');
      const who = historyCaller(c.req.raw.headers)!;
      if (b.action === 'put' && b.id === undefined) return c.json(store.put(who.owner, who.device, b.generation, b.entry));
      if (b.action === 'delete' && b.entry === undefined) return c.json(store.delete(who.owner, b.generation, b.id));
      if (b.action === 'clear' && b.entry === undefined && b.id === undefined) return c.json(store.clear(who.owner, b.generation));
      throw new HistoryError('invalid_request');
    } catch (e) {
      if (e instanceof HistoryError) {
        if (e.status === 429) c.header('Retry-After', '60');
        return c.json({ error: e.code }, e.status);
      }
      if (e instanceof SyntaxError) return c.json({ error: 'invalid_request' }, 400);
      return c.json({ error: 'history_unavailable' }, 503);
    }
  });
  app.get('/history', c => {
    privateHeaders(c);
    if (!historyCaller(c.req.raw.headers) || !ownerBrowser(c, true)) return c.text('Owner history view required', 403);
    // No data in the document. API requests reauthenticate; this page never joins the window hub.
    return c.html(readFileSync(join(publicDir, 'history.html'), 'utf8'));
  });
}
