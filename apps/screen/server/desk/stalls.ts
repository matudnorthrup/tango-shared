import type { MiddlewareHandler } from 'hono';

// The screen service answers one thing at a time: a slow read holds up every screen's clicks behind it.
// These make that visible in the session trace ("server.stall", "server.slow-request").

/** A timer that should fire every `everyMs`; when it fires `thresholdMs` late, the event loop was busy that long. */
export function watchStalls(options: { onStall: (ms: number) => void; thresholdMs?: number; everyMs?: number; now?: () => number }): () => void {
  const { onStall, thresholdMs = 250, everyMs = 100, now = Date.now } = options;
  let last = now();
  const timer = setInterval(() => {
    const at = now();
    const late = at - last - everyMs;
    last = at;
    if (late >= thresholdMs) onStall(late);
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export interface TimedRequest {
  method: string;
  path: string;
  /** How long the handler took. */
  ms: number;
  /** From the browser's send (its X-Desk-Sent-At) to the handler starting: queued behind a busy server. Null without the header. */
  waitedMs: number | null;
}

/** Which list was slow is worth keeping; what the owner typed (a search) is not: other values are dropped (Codex review on #662). */
const SAFE_PARAMS = new Set(['view', 'group', 'agent']);
function safeQuery(params: URLSearchParams): string {
  const parts = [...params].map(([key, value]) => (SAFE_PARAMS.has(key) ? `${key}=${encodeURIComponent(value)}` : `${key}=…`));
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Reports a request that took `slowMs` or more to handle, or waited `lateMs` or more before it started. */
export function timeRequests(onSlow: (request: TimedRequest) => void, options: { slowMs?: number; lateMs?: number; now?: () => number } = {}): MiddlewareHandler {
  const { slowMs = 250, lateMs = 2000, now = Date.now } = options;
  return async (c, next) => {
    // History has its own private store; no request-derived content enters desk traces.
    if (c.req.path.startsWith('/api/desk/dictation-history')) { await next(); return; }
    const start = now();
    const sentAt = Number(c.req.header('x-desk-sent-at'));
    await next();
    const ms = now() - start;
    // A browser's clock may be off: a negative wait is skew, not news.
    const waitedMs = Number.isFinite(sentAt) && sentAt > 0 ? Math.max(0, start - sentAt) : null;
    if (ms < slowMs && (waitedMs === null || waitedMs < lateMs)) return;
    try {
      onSlow({ method: c.req.method, path: `${c.req.path}${safeQuery(new URL(c.req.url).searchParams)}`, ms, waitedMs });
    } catch {
      /* reporting never fails a request */
    }
  };
}
