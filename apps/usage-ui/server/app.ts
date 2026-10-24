import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import type { UsageMonitor } from './monitor.js';
import type { DashboardState } from './types.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

// Header the dashboard sends with state-changing requests. A cross-origin page
// cannot attach a custom header without a CORS preflight, which this server
// never approves, so it cannot trigger provider collection or credential renewal.
export const REFRESH_HEADER = 'x-tango-usage-refresh';

function isSameOriginRequest(request: Request): boolean {
  if (request.headers.get(REFRESH_HEADER) !== '1') return false;
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    // Accept the direct Host or the one a reverse proxy (tailscale serve) forwards.
    const originHost = new URL(origin).host;
    return [new URL(request.url).host, request.headers.get('host'), request.headers.get('x-forwarded-host')]
      .includes(originHost);
  } catch {
    return false;
  }
}

function eventMessage(state: DashboardState): Uint8Array {
  return new TextEncoder().encode(`event: usage\ndata: ${JSON.stringify(state)}\n\n`);
}

export function createUsageApp(monitor: UsageMonitor, clientDir: string): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    await next();
    c.header('x-content-type-options', 'nosniff');
    c.header('x-frame-options', 'DENY');
    c.header('referrer-policy', 'no-referrer');
  });

  app.use('/api/*', async (c, next) => {
    await next();
    c.header('cache-control', 'no-store');
  });

  app.get('/api/health', (c) => c.json({ ok: true }));
  app.get('/api/usage', (c) => c.json(monitor.snapshot()));
  app.post('/api/refresh', async (c) => {
    if (!isSameOriginRequest(c.req.raw)) return c.json({ error: 'forbidden' }, 403);
    return c.json(await monitor.refreshNow());
  });
  app.get('/api/events', () => {
    let unsubscribe = () => {};
    let keepAlive: NodeJS.Timeout | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(eventMessage(monitor.snapshot()));
        unsubscribe = monitor.subscribe((state) => controller.enqueue(eventMessage(state)));
        keepAlive = setInterval(() => {
          controller.enqueue(new TextEncoder().encode(': keepalive\n\n'));
        }, 15_000);
        keepAlive.unref();
      },
      cancel() {
        unsubscribe();
        if (keepAlive) clearInterval(keepAlive);
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      },
    });
  });

  app.get('*', async (c) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.text('bad request', 400);
    }
    const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = path.resolve(clientDir, requested);
    if (filePath !== clientDir && !filePath.startsWith(`${clientDir}${path.sep}`)) {
      return c.text('forbidden', 403);
    }

    try {
      const data = await fs.readFile(filePath);
      const ext = path.extname(filePath);
      return c.body(new Uint8Array(data), 200, {
        'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
        'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
      });
    } catch {
      try {
        const index = await fs.readFile(path.join(clientDir, 'index.html'));
        return c.body(new Uint8Array(index), 200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
        });
      } catch {
        return c.text('client build not found — run: npm run build -w @tango/usage-ui', 404);
      }
    }
  });

  return app;
}

export function withBasePath(app: Hono, basePath: string) {
  return (request: Request): Response | Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === basePath || url.pathname.startsWith(`${basePath}/`)) {
      url.pathname = url.pathname.slice(basePath.length) || '/';
      return app.fetch(new Request(url, request));
    }
    // Tailscale strips the mount path before proxying. Direct localhost visits
    // are redirected so asset and API paths match the public route exactly.
    if (url.pathname === '/' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) {
      return Response.redirect(new URL(`${basePath}/`, url).toString(), 302);
    }
    return app.fetch(request);
  };
}
