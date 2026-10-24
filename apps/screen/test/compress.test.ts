import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { describe, expect, it } from 'vitest';
import { compressResponses, pickEncoding } from '../server/compress.js';

// Lists and modules go to phones over the tailnet: compressed when the browser takes it; event streams never.

const big = JSON.stringify({ items: Array.from({ length: 400 }, (_, i) => ({ id: `loom:${i}`, title: 'A thread about the desk', i })) });

function app() {
  const a = new Hono();
  a.use('*', compressResponses());
  a.get('/list', (c) => c.body(big, 200, { 'Content-Type': 'application/json; charset=UTF-8', ETag: '"v1"' }));
  a.get('/small', (c) => c.json({ ok: true }));
  a.get('/image', (c) => c.body(new Uint8Array(4096), 200, { 'Content-Type': 'image/png' }));
  a.get('/not-modified', (c) => c.body(null, 304, { ETag: '"v1"' }));
  a.get('/stream', (c) => streamSSE(c, async (stream) => stream.writeSSE({ event: 'hello', data: 'x'.repeat(4096) })));
  return a;
}

describe('compressed responses', () => {
  it('brotli when the browser takes it, else gzip, else as is', async () => {
    const a = app();
    const br = await a.request('/list', { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
    expect(br.headers.get('content-encoding')).toBe('br');
    expect(br.headers.get('vary')).toContain('Accept-Encoding');
    expect(br.headers.get('etag')).toBe('"v1"');
    const packed = Buffer.from(await br.arrayBuffer());
    expect(packed.length).toBeLessThan(big.length / 4);
    expect(brotliDecompressSync(packed).toString()).toBe(big);

    const gz = await a.request('/list', { headers: { 'Accept-Encoding': 'gzip' } });
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    expect(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString()).toBe(big);

    const plain = await a.request('/list');
    expect(plain.headers.get('content-encoding')).toBeNull();
    // Still varies: a cache must not hand this to a browser that takes brotli (Codex review on #667).
    expect(plain.headers.get('vary')).toContain('Accept-Encoding');
    expect(await plain.text()).toBe(big);
    expect((await a.request('/list', { headers: { 'Accept-Encoding': 'br;q=0, gzip' } })).headers.get('content-encoding')).toBe('gzip');
  });

  it('a second request for the same ETag gets the same compressed body', async () => {
    const a = app();
    const one = Buffer.from(await (await a.request('/list', { headers: { 'Accept-Encoding': 'br' } })).arrayBuffer());
    const two = Buffer.from(await (await a.request('/list', { headers: { 'Accept-Encoding': 'br' } })).arrayBuffer());
    expect(two.equals(one)).toBe(true);
  });

  it('leaves small bodies, images, 304s and event streams alone', async () => {
    const a = app();
    const headers = { 'Accept-Encoding': 'br, gzip' };
    expect((await a.request('/small', { headers })).headers.get('content-encoding')).toBeNull();
    expect(await (await a.request('/small', { headers })).json()).toEqual({ ok: true });
    expect((await a.request('/image', { headers })).headers.get('content-encoding')).toBeNull();
    expect((await a.request('/not-modified', { headers })).status).toBe(304);
    const stream = await a.request('/stream', { headers });
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    expect(stream.headers.get('content-encoding')).toBeNull();
  });
});

describe('Accept-Encoding', () => {
  it('honours q=0 and *, case aside', () => {
    expect(pickEncoding('gzip, deflate, br')).toBe('br');
    expect(pickEncoding('BR;q=0, GZIP')).toBe('gzip');
    expect(pickEncoding('br;q=0, gzip;q=0')).toBeNull();
    expect(pickEncoding('*')).toBe('br');
    expect(pickEncoding('*;q=0, gzip')).toBe('gzip');
    expect(pickEncoding('identity')).toBeNull();
    expect(pickEncoding('')).toBeNull();
  });
});
