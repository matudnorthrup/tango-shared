import { promisify } from 'node:util';
import * as zlib from 'node:zlib';
import type { MiddlewareHandler } from 'hono';

// Responses compressed for the browser: the desk's lists are ~3.4 MB of JSON and its page ~1 MB of modules,
// read over the tailnet (often a phone) on every deploy's reload. Brotli when the browser takes it, else gzip.
// Compression runs on libuv's thread pool, not the event loop; a body with an ETag (a cached list, a static file)
// is compressed once and reused. Event streams are never touched: compressing them would hold their events back.

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
const COMPRESSIBLE = /^(?:application\/(?:json|javascript)|text\/(?:html|css|javascript|plain)|image\/svg\+xml)/i;
const MIN_BYTES = 1024;

/** br, else gzip, else none, as the browser's Accept-Encoding allows (`q=0` refuses one; `*` stands for the rest). */
export function pickEncoding(header: string): 'br' | 'gzip' | null {
  const q = new Map<string, number>();
  for (const part of header.toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    if (!name) continue;
    const weight = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find(Boolean);
    q.set(name.trim(), weight === undefined ? 1 : Number(weight));
  }
  const allowed = (coding: string) => (q.get(coding) ?? q.get('*') ?? 0) > 0;
  return allowed('br') ? 'br' : allowed('gzip') ? 'gzip' : null;
}

export function compressResponses(options: { cacheEntries?: number } = {}): MiddlewareHandler {
  const cacheEntries = options.cacheEntries ?? 200;
  const cache = new Map<string, Uint8Array<ArrayBuffer>>();
  return async (c, next) => {
    await next();
    const res = c.res;
    const type = res.headers.get('content-type') ?? '';
    if (!res.body || res.status !== 200 || res.headers.has('content-encoding') || !COMPRESSIBLE.test(type)) return;
    if (/no-transform/i.test(res.headers.get('cache-control') ?? '')) return;
    // Compressible: what a cache holds depends on Accept-Encoding, compressed or not (Codex review on #667).
    res.headers.append('vary', 'Accept-Encoding');
    const encoding = pickEncoding(c.req.header('accept-encoding') ?? '');
    if (!encoding) return;
    const etag = res.headers.get('etag');
    const key = etag ? `${encoding}:${etag}` : null;
    let body: Uint8Array<ArrayBuffer> | undefined = key ? cache.get(key) : undefined;
    if (!body) {
      const raw = new Uint8Array(await res.arrayBuffer());
      if (raw.byteLength < MIN_BYTES) {
        c.res = new Response(raw, res);
        return;
      }
      const packed =
        encoding === 'br'
          ? await brotli(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength } })
          : await gzip(raw, { level: 6 });
      body = packed as Uint8Array<ArrayBuffer>;
      if (key) {
        cache.set(key, body);
        if (cache.size > cacheEntries) cache.delete(cache.keys().next().value!);
      }
    }
    // Hono merges the old response's headers into a new one: fix them up after the swap (as hono/compress does).
    c.res = new Response(body as Uint8Array<ArrayBuffer>, res);
    c.res.headers.set('content-encoding', encoding);
    c.res.headers.delete('content-length');
  };
}
