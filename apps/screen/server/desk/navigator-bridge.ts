import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { isAllowedOwnerLogin, isDirectLocalCaller } from '../access.js';
import { navigatorContext, type NavigatorContext, type NavigatorResolution } from './navigator-resolver.js';

const BASE = '/api/desk/navigator';
export function commandCandidate(text: string): boolean {
  return /^(?:please\s+)?(?:(?:go\s+to|show\s+me|switch\s+to|take\s+me\s+to)\s+\S|(?:go\s+)?back[.!?]?$)/i.test(text.trim());
}
function caller(headers: Headers): string | null {
  if (headers.get('x-desk-window') === 'detached') return null;
  if (isDirectLocalCaller(headers)) return 'local';
  const login = headers.get('tailscale-user-login');
  if (isAllowedOwnerLogin(login ?? undefined, process.env.SCREEN_ALLOWED_LOGINS)) return `login:${login!.trim().toLowerCase()}`;
  // A local browser carries Origin, unlike a native local process.
  if (![...headers.keys()].some(k => /^(tailscale-|x-forwarded-|forwarded$)/.test(k)) && headers.has('origin')) return 'local';
  return null;
}
interface Window {
  id: string; caller: string; name: string; role: string; touched: number; seen: number;
  context: NavigatorContext; socket: WebSocket;
}
interface Ticket { caller: string; exchange: string; window: Window; resolution: NavigatorResolution; context: NavigatorContext; expires: number }

/** Volatile capabilities: never persist transcripts, catalogs, or reusable navigation authority. */
export class NavigatorBridge {
  private windows = new Map<string, Window>();
  private tickets = new Map<string, Ticket>();
  private rates = new Map<string, { at: number; count: number }>();
  private pending = new Map<string, { window: Window; finish: (ok: boolean) => void }>();
  constructor(private resolve: (text: string, context: NavigatorContext) => Promise<NavigatorResolution>, private now = Date.now) {}
  register(app: Hono) {
    app.use(`${BASE}/*`, async (c, next) => {
      if (!caller(c.req.raw.headers) || c.req.query('detached') === '1') return c.json({ error: 'Owner window required' }, 403);
      c.header('Cache-Control', 'no-store');
      await next();
    });
    app.get(`${BASE}/bridge`, c => c.req.header('origin') ? c.json({ ok: true }) : c.json({ error: 'Origin required' }, 403));
    app.post(`${BASE}/resolve`, bodyLimit({ maxSize: 12_000 }), async c => {
      const who = caller(c.req.raw.headers)!;
      const time = this.now();
      for (const [key, value] of this.rates) if (time - value.at >= 60_000) this.rates.delete(key);
      const rate = this.rates.get(who) ?? { at: time, count: 0 };
      this.rates.set(who, rate);
      if (++rate.count > 12) return c.json({ error: 'Too many commands' }, 429);
      let body;
      try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid request' }, 400); }
      if (!body || typeof body.transcript !== 'string' || body.transcript.length > 8000 || !uuid(body.exchangeId)) return c.json({ error: 'Invalid request' }, 400);
      if (!commandCandidate(body.transcript)) return c.json({ status: 'dictation' });
      this.prune();
      const window = [...this.windows.values()].filter(w => (who === 'local' || w.caller === who) && w.role !== 'screen' && w.socket.readyState === 1 && time - w.seen < 30_000)
        .sort((a, b) => b.touched - a.touched)[0];
      if (!window) return c.json({ status: 'missing', confirmation: 'Open an owner desk window, or send as text.' });
      try {
        const context = window.context;
        const resolution = await this.resolve(body.transcript, context);
        if (!resolution.action) return c.json({ status: resolution.status === 'refused' ? 'dictation' : resolution.candidates.length ? 'ambiguous' : 'missing', confirmation: resolution.confirmation });
        if (this.windows.get(window.id) !== window || window.socket.readyState !== 1 || window.role === 'screen' || !context.choices.some(c => JSON.stringify(c.action) === JSON.stringify(resolution.action))) return c.json({ status: 'missing' });
        const ticket = randomUUID();
        this.tickets.set(ticket, { caller: who, exchange: body.exchangeId, window, resolution, context, expires: this.now() + 13_000 });
        const choice = window.context.choices.find(c => JSON.stringify(c.action) === JSON.stringify(resolution.action));
        return c.json({ status: 'action', ticket, label: (choice?.label ?? resolution.confirmation).split(' · ')[0]!.slice(0, 160), window: window.name, targetId: resolution.action.target || undefined, confirmation: resolution.confirmation });
      } catch { return c.json({ status: 'missing', confirmation: 'Could not resolve command. Send as text instead.' }); }
    });
    app.post(`${BASE}/commit`, bodyLimit({ maxSize: 1024 }), async c => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid request' }, 400); }
      if (!body || !uuid(body.ticket) || !uuid(body.exchangeId)) return c.json({ error: 'Invalid request' }, 400);
      this.prune();
      const ticket = this.tickets.get(body.ticket);
      if (!ticket || ticket.caller !== caller(c.req.raw.headers) || ticket.exchange !== body.exchangeId) return c.json({ error: 'Expired or invalid command' }, 409);
      this.tickets.delete(body.ticket); // consume before dispatch, including failed dispatches
      const window = ticket.window;
      if (this.windows.get(window.id) !== window || window.socket.readyState !== 1 || window.role === 'screen' || JSON.stringify(window.context) !== JSON.stringify(ticket.context) || this.now() - window.seen >= 30_000) return c.json({ error: 'Window unavailable' }, 409);
      const ok = await new Promise<boolean>(resolve => {
        const timeout = setTimeout(() => finish(false), 3000);
        const finish = (ok: boolean) => { clearTimeout(timeout); this.pending.delete(body.ticket); resolve(ok); };
        this.pending.set(body.ticket, { window, finish });
        try { window.socket.send(JSON.stringify({ type: 'execute', ticket: body.ticket, resolution: ticket.resolution, context: ticket.context })); } catch { finish(false); }
      });
      return c.json({ ok, window: window.name }, ok ? 200 : 409);
    });
  }
  private prune() { for (const [key, t] of this.tickets) if (t.expires <= this.now()) this.tickets.delete(key); }
  attach(server: Server, app: Hono) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });
    const upgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== `${BASE}/bridge`) return;
      try {
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (v) headers.set(k, Array.isArray(v) ? v.join(',') : String(v));
        const response = await app.fetch(new Request(`http://${req.headers.host}${req.url}`, { headers }));
        if (!response.ok) { socket.end(`HTTP/1.1 ${response.status} Forbidden\r\nConnection: close\r\n\r\n`); return; }
        const who = caller(headers)!;
        if (wss.clients.size >= 64) { socket.destroy(); return; }
        wss.handleUpgrade(req, socket, head, ws => {
          const id = randomUUID();
          ws.on('message', data => {
            try {
              const event = JSON.parse(String(data));
              if (event.type === 'executed') { const p = this.pending.get(event.ticket); if (p?.window.id === id) p.finish(event.ok === true); return; }
              if (event.type !== 'context' || !['full', 'control', 'screen'].includes(event.role) || typeof event.name !== 'string' || event.name.length > 100) throw new Error('Invalid window');
              const context = navigatorContext(event.context), old = this.windows.get(id), time = this.now();
              this.windows.set(id, Object.assign(old ?? { id, caller: who, socket: ws }, { context, role: event.role, name: event.name || 'Desk window', seen: time, touched: event.activity === true ? time : old?.touched ?? 0 }) as Window);
            } catch { ws.close(1008, 'Invalid context'); }
          });
          ws.on('close', () => { this.windows.delete(id); for (const p of this.pending.values()) if (p.window.id === id) p.finish(false); });
          ws.on('error', () => ws.close());
        });
      } catch { socket.destroy(); }
    };
    server.on('upgrade', upgrade);
    return () => { server.off('upgrade', upgrade); for (const ws of wss.clients) ws.terminate(); wss.close(); };
  }
}
function uuid(value: unknown): value is string { return typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value); }
