import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { Hub } from '../server/hub.js';
import { moduleGraph, withModulePreloads } from '../server/static-assets.js';
import { SceneStore } from '../server/store.js';

// The desk page reloads after every deploy: its modules are preloaded side by side and revalidate to a 304.

let dir: string;
let hub: Hub;
let app: ReturnType<typeof createApp>;

function write(rel: string, body: string) {
  fs.mkdirSync(path.dirname(path.join(dir, 'public', rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'public', rel), body);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-static-'));
  write('index.html', '<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="desk/main.js"></script></body></html>');
  write('desk/main.js', "import { a } from './a.js'\nimport {\n  b,\n} from './next/b.js';\nimport '../vendor/v.js'\nconst fx = () => import('./fixtures.js')\n// import { nope } from './commented.js'\n");
  write('desk/a.js', "export { b } from './next/b.js'\nexport const a = 1\n");
  write('desk/next/b.js', "import { a } from '../a.js'\nexport const b = 2\n");
  write('vendor/v.js', 'export {}\n');
  write('desk/fixtures.js', 'export {}\n');
  const scenes = new SceneStore(path.join(dir, 'data'));
  hub = new Hub(scenes, async () => 'agent');
  app = createApp({ store: scenes, hub, publicDir: path.join(dir, 'public') });
});

afterEach(() => {
  hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('module graph', () => {
  it('follows static imports and re-exports, not dynamic import()', () => {
    const graph = moduleGraph(path.join(dir, 'public'), 'desk/main.js');
    expect(graph).toEqual(['desk/main.js', 'desk/a.js', 'desk/next/b.js', 'vendor/v.js']);
    expect(withModulePreloads('<head></head>', ['desk/main.js'])).toBe('<head><link rel="modulepreload" href="desk/main.js">\n</head>');
  });
});

describe('the shell', () => {
  it('lists every module up front and revalidates to a 304', async () => {
    const page = await app.request('/');
    const html = await page.text();
    expect(html).toContain('<link rel="modulepreload" href="desk/next/b.js">');
    expect(html).toContain('<meta name="desk-build"');
    const etag = page.headers.get('etag')!;
    expect((await app.request('/', { headers: { 'If-None-Match': etag } })).status).toBe(304);
  });

  it('a static file has an ETag; unchanged it is a 304, changed a new 200', async () => {
    const first = await app.request('/desk/a.js');
    const etag = first.headers.get('etag')!;
    expect(first.headers.get('cache-control')).toBe('no-cache');
    expect((await app.request('/desk/a.js', { headers: { 'If-None-Match': etag } })).status).toBe(304);
    write('desk/a.js', 'export const a = 3\n');
    const changed = await app.request('/desk/a.js', { headers: { 'If-None-Match': etag } });
    expect(changed.status).toBe(200);
    expect(await changed.text()).toBe('export const a = 3\n');
  });
});
