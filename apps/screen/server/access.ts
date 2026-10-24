import type { MiddlewareHandler } from 'hono';

// Who may use the screen service.
//
// Tailnet access is `tailscale serve`, which proxies to 127.0.0.1 and (verified
// against tailscale 1.102.4) strips any client-sent Tailscale-User-* headers,
// then sets Tailscale-User-Login / -Name / -Profile-Pic for a tailnet user,
// sets nothing for a tagged device, marks Funnel traffic with
// Tailscale-Funnel-Request, and always adds Tailscale-Headers-Info,
// X-Forwarded-For, X-Forwarded-Host and X-Forwarded-Proto. Direct local callers
// (the bot, the voice operator) send none of these and need no identity.

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface AccessOptions {
  /** Comma-separated tailnet logins allowed through `tailscale serve`; unset or empty allows every tailnet user. */
  allowedLogins?: string;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

function parseLogins(value: string | undefined): Set<string> | null {
  const logins = (value ?? '').split(',').map((login) => login.trim().toLowerCase()).filter(Boolean);
  return logins.length ? new Set(logins) : null;
}

/** Tailscale MIME-encodes non-ASCII values (`=?utf-8?q?...?=`); logins are normally plain ASCII. */
function decodeHeader(value: string): string {
  const encoded = /^=\?utf-8\?q\?(.*)\?=$/i.exec(value.trim());
  if (!encoded) return value.trim();
  const bytes = encoded[1]!.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(bytes, 'latin1').toString('utf8');
}

/** Approval actions require a user login; an unset allowlist follows the tailnet policy. */
export function isAllowedOwnerLogin(login: string | undefined, allowedLogins: string | undefined): boolean {
  const decoded = login ? decodeHeader(login).toLowerCase() : '';
  const allowed = parseLogins(allowedLogins);
  return !!decoded && (!allowed || allowed.has(decoded));
}

function sameOrigin(origin: string, host: string | undefined, protocol: string): boolean {
  if (!host) return false;
  try {
    const url = new URL(origin);
    // Scheme is part of an origin: an http page must not post to the https screen.
    return url.protocol === `${protocol}:` && url.host.toLowerCase() === host.trim().toLowerCase();
  } catch {
    return false; // includes the literal "null" a sandboxed scene frame would send
  }
}

function hasProxyHeaders(headers: Headers): boolean {
  return [...headers.keys()].some(name => name === 'forwarded' || name.startsWith('x-forwarded-')
    || ['tailscale-user-login', 'tailscale-headers-info', 'tailscale-funnel-request'].includes(name));
}

/**
 * A direct local process (the bot, the voice operator): nothing came through `tailscale serve`
 * (no Tailscale or forwarding headers) and it isn't a browser (no Origin, no Sec-Fetch-*). Only
 * these may speak for someone else (a body `actor`) or report agent turns.
 */
export function isDirectLocalCaller(headers: Headers): boolean {
  const header = (name: string) => headers.get(name) ?? undefined;
  const proxied = hasProxyHeaders(headers);
  // Browsers send Origin on every POST and Sec-Fetch-Site on every request. (Not Sec-Fetch-Mode:
  // Node's own fetch sends that one too, and the bot and the operator are Node.)
  const browser = header('origin') !== undefined || header('sec-fetch-site') !== undefined;
  return !proxied && !browser;
}

/**
 * Desk writes are JSON only: a form post or a `text/plain` beacon (both sendable cross-site
 * without a preflight) never reaches a desk command.
 */
export function requireJsonPosts(): MiddlewareHandler {
  return async (c, next) => {
    if (MUTATING.has(c.req.method)) {
      const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (type !== 'application/json') return c.json({ error: 'Content-Type must be application/json' }, 415);
    }
    await next();
  };
}

/** What a detached window (`?detached=1`) marks every request with (public/desk/api.js). */
export const DETACHED_WINDOW_HEADER = 'x-desk-window';
/** Writes that drive the owner's windows: moving every window, re-roling one, standing in for his List or presence. */
const DRIVING_PATHS = [/^\/api\/desk\/presentation$/, /^\/api\/desk\/presence$/, /^\/api\/screens\//];
/** Commands a window sends by itself when the owner looks at something: a detached window's look isn't his. */
const PASSIVE_COMMANDS = new Set(['viewed', 'heard', 'briefed']);

/**
 * A detached window is how an agent tests on the real desk: it may read, and send the commands its test is
 * about, but never what would move or speak for the owner's windows. The page doesn't send these at all;
 * this refuses them if a code path forgets.
 */
export function refuseDetachedDriving(): MiddlewareHandler {
  return async (c, next) => {
    if (MUTATING.has(c.req.method) && c.req.header(DETACHED_WINDOW_HEADER) === 'detached') {
      if (DRIVING_PATHS.some((re) => re.test(c.req.path))) return c.json({ error: 'a detached window does not drive the desk’s windows' }, 403);
      if (c.req.path === '/api/desk/commands') {
        const body = (await c.req.json().catch(() => null)) as { type?: unknown } | null;
        if (body && PASSIVE_COMMANDS.has(String(body.type))) return c.json({ error: 'a detached window’s look does not count as the owner’s' }, 403);
      }
    }
    await next();
  };
}

export function accessControl(options: AccessOptions = {}): MiddlewareHandler {
  const allowed = parseLogins(options.allowedLogins);
  const log = options.log ?? ((event, data) => console.log(`[screen] ${event} ${JSON.stringify(data ?? {})}`));
  let warned = false;
  return async (c, next) => {
    const header = (name: string) => c.req.header(name) ?? undefined;
    if (header('tailscale-funnel-request')) {
      // Screens are tailnet-only; never serve the public internet.
      return c.json({ error: 'not available over Funnel' }, 403);
    }
    const loginHeader = header('tailscale-user-login');
    // Forwarding metadata is never evidence of a direct local caller, even if
    // a proxy omitted the identity marker. Presence (including empty values)
    // matters; extensions in the X-Forwarded-* family count too.
    const proxied = hasProxyHeaders(c.req.raw.headers);
    if (proxied) {
      if (!allowed) {
        if (!warned) {
          warned = true;
          log('access.open', { reason: 'SCREEN_ALLOWED_LOGINS is not set: every tailnet user may use the screen' });
        }
      } else {
        const login = loginHeader ? decodeHeader(loginHeader).toLowerCase() : '';
        if (!login || !allowed.has(login)) {
          log('access.denied', { login: login || '(tagged device)', path: c.req.path });
          return c.json({ error: 'this tailnet login may not use the screen' }, 403);
        }
      }
    }
    const origin = header('origin');
    if (origin !== undefined && (MUTATING.has(c.req.method) || c.req.header('upgrade')?.toLowerCase() === 'websocket')) {
      const host = header('x-forwarded-host') ?? header('host');
      const protocol = (header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(/:$/, '')).split(',')[0]!.trim().toLowerCase();
      if (!sameOrigin(origin, host, protocol)) {
        log('access.cross-origin', { origin, host, path: c.req.path });
        return c.json({ error: 'cross-origin request refused' }, 403);
      }
    }
    await next();
  };
}
