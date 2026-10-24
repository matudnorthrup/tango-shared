import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- plain ESM script with no type declarations
import * as cli from '../bin/tango-screen.mjs';
import { createApp } from '../server/app.js';
import { BundleStore, parseBundleRef, safeBundlePath, STORAGE_SHIM, withStorageShim } from '../server/bundles.js';
import { renderFrame } from '../server/frame.js';
import { Hub, type Sink } from '../server/hub.js';
import { SceneStore } from '../server/store.js';
import { loomSceneItemId, routeLoomInput, sceneTapMessage } from '../server/loom-scenes.js';

class RecordingSink implements Sink {
  events: Array<{ event: string; data: any }> = [];
  send(event: string, data: unknown): void {
    this.events.push({ event, data });
  }
}

let dir: string;
let store: SceneStore;
let bundles: BundleStore;
let hub: Hub;
let fallbackCalls: Array<{ sceneId: string; conversationKey: string }>;
let clock: number;

function app() {
  return createApp({ store, hub, bundles, publicDir: path.join(dir, 'public') });
}

async function post(pathname: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await app().request(pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: response.status, json: (await response.json()) as any };
}

const b64 = (text: string) => Buffer.from(text).toString('base64');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-screens-'));
  fs.mkdirSync(path.join(dir, 'public'));
  clock = 1_000_000;
  store = new SceneStore(path.join(dir, 'data'), () => clock);
  bundles = new BundleStore(path.join(dir, 'data', 'bundles'), () => clock);
  fallbackCalls = [];
  hub = new Hub(
    store,
    async (scene, input) => {
      fallbackCalls.push({ sceneId: scene.id, conversationKey: input.conversationKey });
      return 'agent';
    },
    () => {},
    () => clock,
    undefined,
    { direct: (scene) => loomSceneItemId(scene) !== null },
  );
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('bundles', () => {
  it('accepts only safe relative paths', () => {
    expect(safeBundlePath('index.html')).toBe('index.html');
    expect(safeBundlePath('./css/app.css')).toBe('css/app.css');
    for (const bad of ['', '/etc/passwd', '../x', 'a/../../x', 'a//b', 'a/./b', 42]) expect(safeBundlePath(bad)).toBeNull();
    expect(parseBundleRef('bundles/0123456789abcdef01234567/index.html')).toEqual({ id: '0123456789abcdef01234567', file: 'index.html' });
    expect(parseBundleRef('bundles/nope/index.html')).toBeNull();
  });

  it('uploads from local callers only, and serves files sandboxed with the storage shim', async () => {
    const files = [
      { path: 'index.html', data: b64('<!doctype html><html><head><title>p</title></head><body><script src="app.js"></script></body></html>') },
      { path: 'app.js', data: b64('localStorage.setItem("a", "1")') },
    ];
    const proxied = await post('/api/bundles', { files }, { 'Tailscale-User-Login': 'someone@example.com' });
    expect(proxied.status).toBe(403);
    const browser = await post('/api/bundles', { files }, { Origin: 'https://example.com' });
    expect(browser.status).toBe(403);

    const { status, json } = await post('/api/bundles', { files });
    expect(status).toBe(200);
    expect(json.base).toBe(`bundles/${json.id}/`);

    const page = await app().request(`/bundles/${json.id}/index.html`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts/);
    expect(page.headers.get('content-security-policy')).not.toMatch(/allow-same-origin/);
    const html = await page.text();
    expect(html.indexOf(STORAGE_SHIM)).toBeGreaterThan(html.indexOf('<head>'));
    expect(html.indexOf(STORAGE_SHIM)).toBeLessThan(html.indexOf('app.js'));

    const folder = await app().request(`/bundles/${json.id}/`);
    expect(folder.status).toBe(200);
    expect((await app().request(`/bundles/${json.id}/app.js`)).headers.get('content-type')).toMatch(/javascript/);
    expect((await app().request(`/bundles/${json.id}/missing.js`)).status).toBe(404);
    expect((await app().request(`/bundles/${json.id}/..%2F..%2Fscreen.db`)).status).toBe(404);
    expect((await app().request(`/bundles/${json.id}`)).status).toBe(301);
  });

  it('rejects unsafe or oversized uploads', async () => {
    expect((await post('/api/bundles', { files: [{ path: '../escape.html', data: b64('x') }] })).status).toBe(400);
    expect((await post('/api/bundles', { files: [] })).status).toBe(400);
    expect((await post('/api/bundles', { files: [{ path: 'a', data: b64('1') }, { path: 'a', data: b64('2') }] })).status).toBe(400);
  });

  it('puts the shim after a doctype, never before it', () => {
    expect(withStorageShim('<!DOCTYPE html><p>x</p>').startsWith('<!DOCTYPE html><script>')).toBe(true);
    expect(withStorageShim('<p>x</p>').startsWith('<script>')).toBe(true);
  });

  it('sweeps bundles no scene shows once they are an hour old', async () => {
    // Bundle age is file mtime, so this store's clock runs from the real time.
    let shift = 0;
    bundles = new BundleStore(path.join(dir, 'data', 'bundles'), () => Date.now() + shift);
    const kept = bundles.save([{ path: 'index.html', data: b64('<p>kept</p>') }]);
    const orphan = bundles.save([{ path: 'index.html', data: b64('<p>orphan</p>') }]);
    await post('/api/scenes', { agentId: 'loom', kind: 'url', body: `bundles/${kept.id}/index.html`, summary: 'kept', conversationKey: 'loom:thread-1' });
    expect(bundles.sweep(store.bundleIds())).toEqual([]);
    shift = 2 * 3_600_000;
    expect(bundles.sweep(store.bundleIds())).toEqual([orphan.id]);
    expect(bundles.has(kept.id, 'index.html')).toBe(true);
  });
});

describe('Loom scenes', () => {
  it('routes taps on a Loom thread\'s scene to that thread as a new turn', async () => {
    const director = new RecordingSink();
    hub.addDirector(director);
    const { json } = await post('/api/scenes', { agentId: 'loom', kind: 'html', body: '<p>x</p>', title: 'Pick a layout', summary: 's', choices: ['A', 'B'], conversationKey: 'loom:abc-1' });
    const tap = await post('/api/input', { sceneId: json.sceneId, type: 'choice', data: { choiceId: 'b' } });
    expect(tap.json).toMatchObject({ routed: 'agent', status: 'delivered' });
    expect(fallbackCalls).toEqual([{ sceneId: json.sceneId, conversationKey: 'loom:abc-1' }]);

    const scene = store.get(json.sceneId)!;
    expect(loomSceneItemId(scene)).toBe('loom:abc-1');
    expect(loomSceneItemId({ conversationKey: 'loom:' })).toBeNull();
    const sent: Array<[string, string, string | undefined]> = [];
    const reply = async (itemId: string, text: string, commandId?: string) => (sent.push([itemId, text, commandId]), { ok: true as const });
    const input = { sceneId: scene.id, type: 'choice', data: { choiceId: 'b' }, commandId: 'cmd-1', conversationKey: scene.conversationKey };
    expect(await routeLoomInput(reply, scene, input)).toBe('agent');
    expect(sent).toEqual([['loom:abc-1', '[Screen] I tapped “B” on your screen “Pick a layout” (slot `main`).', 'cmd-1']]);
    expect(await routeLoomInput(null, scene, input)).toMatch(/^failed:/);
    expect(await routeLoomInput(async () => ({ ok: false, error: 'timed out', unknown: true }), scene, input)).toBe('unknown:timed out');
    expect(await routeLoomInput(async () => ({ ok: false, error: 'gone' }), scene, input)).toBe('failed:gone');
  });

  it('stages from a Loom thread without asking T3', async () => {
    const realFetch = globalThis.fetch;
    const origins: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      origins.push(url.origin);
      return app().request(url.pathname + url.search, init);
    }) as typeof fetch;
    const lines: string[] = [];
    try {
      const env = { SCREEN_T3_URL: 'http://t3.test', SCREEN_T3_TOKEN_FILE: path.join(dir, 'no-token'), TANGO_SCREEN_URL: 'http://screen.test', TANGO_DESK_ITEM: 'loom:abc-1' };
      await cli.run(['show', '-', '--title', 'Pick a layout', '--choice', 'A'], { env, cwd: dir, out: (line: string) => lines.push(line), readStdin: async () => '<p>pick</p>' });
      expect(origins).not.toContain('http://t3.test');
      const [scene] = store.live('loom');
      expect(scene).toMatchObject({ conversationKey: 'loom:abc-1', title: 'Pick a layout' });
      expect(scene!.agentName).toMatch(/^Loom · /);
      await expect(cli.run(['list', '--thread', 't3:old'], { env, cwd: dir, out: () => {} })).rejects.toThrow(/T3 is retired; use Loom/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('tango-screen CLI', () => {
  it('plans each kind of target', () => {
    const proto = path.join(dir, 'proto');
    fs.mkdirSync(path.join(proto, 'node_modules', 'x'), { recursive: true });
    fs.mkdirSync(path.join(proto, 'css'));
    fs.writeFileSync(path.join(proto, 'index.html'), '<link href="css/app.css" rel="stylesheet"><h1>hi</h1>');
    fs.writeFileSync(path.join(proto, 'css', 'app.css'), 'h1{color:red}');
    fs.writeFileSync(path.join(proto, '.env'), 'SECRET=1');
    fs.writeFileSync(path.join(proto, 'node_modules', 'x', 'index.js'), '');
    fs.writeFileSync(path.join(dir, 'solo.html'), '<!doctype html><h1>solo</h1><a href="https://example.com">x</a>');
    fs.writeFileSync(path.join(dir, 'notes.md'), '# Notes');
    fs.writeFileSync(path.join(dir, 'shot.png'), 'png');

    const folder = cli.planTarget(proto);
    expect(folder.kind).toBe('url');
    expect(folder.upload.entry).toBe('index.html');
    expect(folder.upload.files.map((file: { path: string }) => file.path)).toEqual(['css/app.css', 'index.html']);

    expect(cli.planTarget(path.join(proto, 'index.html')).upload.files.map((file: { path: string }) => file.path)).toEqual(['css/app.css', 'index.html']);
    expect(cli.planTarget(path.join(dir, 'solo.html')).upload.files.map((file: { path: string }) => file.path)).toEqual(['solo.html']);
    expect(cli.planTarget(path.join(dir, 'solo.html'), { kind: 'html' })).toMatchObject({ kind: 'html', body: expect.stringContaining('solo') });
    expect(cli.planTarget(path.join(dir, 'notes.md'))).toEqual({ kind: 'markdown', body: '# Notes' });
    expect(cli.planTarget(path.join(dir, 'shot.png'))).toMatchObject({ kind: 'image', upload: { entry: 'shot.png' } });
    expect(cli.planTarget('https://example.com/a')).toEqual({ kind: 'url', body: 'https://example.com/a' });
    expect(cli.planTarget('http://localhost:5173/app')).toMatchObject({ kind: 'url', localPort: 5173 });
    expect(cli.planTarget('-', { stdin: '<p>x</p>' })).toEqual({ kind: 'html', body: '<p>x</p>' });
    expect(() => cli.planTarget(path.join(dir, 'missing'))).toThrow(/no such file/);
  });

  it('reads tailscale serve mappings', () => {
    const status = { Web: { 'host.ts.net:443': { Handlers: { '/tango-screen': { Proxy: 'http://127.0.0.1:9410' }, '/artifacts': { Proxy: 'http://127.0.0.1:9350' } } }, 'host.ts.net:15173': { Handlers: { '/': { Proxy: 'http://127.0.0.1:5173' } } } } };
    expect(cli.tailnetUrlFor(status, 9410, '/tango-screen')).toBe('https://host.ts.net/tango-screen');
    expect(cli.tailnetUrlFor(status, 5173)).toBe('https://host.ts.net:15173');
    expect(cli.tailnetUrlFor(status, 1234)).toBeNull();
    expect(cli.tailnetUrlFor(null, 9410)).toBeNull();
  });

  it('shows, updates, lists, and clears a prototype folder through the screen API', async () => {
    const worktree = path.join(dir, 'wt');
    const proto = path.join(worktree, 'proto');
    fs.mkdirSync(proto, { recursive: true });
    fs.writeFileSync(path.join(proto, 'index.html'), '<script src="app.js"></script>');
    fs.writeFileSync(path.join(proto, 'app.js'), 'console.log(1)');
    const tokenFile = path.join(dir, 'token');
    fs.writeFileSync(tokenFile, 'secret-token');
    const thread = (id: string, extra: Record<string, unknown>) => ({ id, ...extra });
    const shell = { projects: [{ id: 'p1', title: 'acme', workspaceRoot: path.join(dir, 'root') }], threads: [thread('t3thread-1', { worktreePath: worktree })] };

    const realFetch = globalThis.fetch;
    const t3Auth: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin === 'http://t3.test') {
        t3Auth.push(new Headers(init?.headers).get('authorization') ?? '');
        return new Response(JSON.stringify(shell), { headers: { 'content-type': 'application/json' } });
      }
      return app().request(url.pathname + url.search, init);
    }) as typeof fetch;
    const lines: string[] = [];
    try {
      const env = { TANGO_DESK_ITEM: 'loom:thread-1', TANGO_SCREEN_URL: 'http://screen.test' };
      await cli.run(['show', 'proto', '--title', 'Onboarding v2', '--choice', 'Keep A', '--choice', 'Go with B', '--slot', 'proto'], { env, cwd: worktree, out: (line: string) => lines.push(line) });
      expect(t3Auth).toEqual([]);
      expect(lines[0]).toMatch(/^staged “Onboarding v2” in slot proto \(v1\) on thread-1/);
      expect(lines.at(-1)).toMatch(/private/);

      const [scene] = store.live('loom');
      expect(scene).toMatchObject({ agentName: expect.stringMatching(/^Loom · /), conversationKey: 'loom:thread-1', kind: 'url', slot: 'proto', title: 'Onboarding v2' });
      expect(scene!.body).toMatch(/^bundles\/[a-f0-9]{24}\/index\.html$/);
      expect(scene!.choices.map((choice) => choice.label)).toEqual(['Keep A', 'Go with B']);

      await cli.run(['update', '--slot', 'proto', '--state', '{"step":2}'], { env, cwd: worktree, out: (line: string) => lines.push(line) });
      expect(store.get(scene!.id)!.state).toEqual({ step: 2 });

      lines.length = 0;
      await cli.run(['list'], { env, cwd: worktree, out: (line: string) => lines.push(line) });
      expect(lines).toEqual([expect.stringMatching(/^proto\turl\tv1\tOnboarding v2/)]);

      await cli.run(['clear', '--all'], { env, cwd: worktree, out: (line: string) => lines.push(line) });
      expect(store.live('loom')).toHaveLength(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('screen leak guard', () => {
  it('blocks screen links in commits, PRs, and issues outside the screen repo', async () => {
    // @ts-expect-error -- plain ESM script with no type declarations
    const { verdict } = await import('../scripts/screen-leak-guard.mjs');
    const elsewhere = { isScreenRepo: () => false, readFile: () => 'See https://host.ts.net/tango-screen/frame/abc' };
    expect(verdict('git commit -m "feat: onboarding (preview https://host.ts.net/tango-screen/bundles/0123456789abcdef01234567/)"', '/r', elsewhere)).toMatch(/^Blocked/);
    expect(verdict('gh pr create --title x --body-file body.md', '/r', elsewhere)).toMatch(/^Blocked/);
    expect(verdict('gh pr edit 12 --body "made with tango-screen"', '/r', elsewhere)).toMatch(/^Blocked/);
    // Ordinary work, tailnet prototype links, and non-publishing commands pass.
    expect(verdict('git commit -m "Prototype: https://host.ts.net/artifacts/p/index.html"', '/r', { ...elsewhere, readFile: () => '' })).toBeNull();
    expect(verdict('tango-screen show ./proto --title x', '/r', elsewhere)).toBeNull();
    expect(verdict('git commit -m "feat: tango-screen CLI"', '/r', { ...elsewhere, isScreenRepo: () => true })).toBeNull();
  });
});

