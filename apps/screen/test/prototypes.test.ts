import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain node module, no types
import * as cli from '../bin/tango-screen.mjs';
import { createApp, parsePrototypePage } from '../server/app.js';
import { BundleStore } from '../server/bundles.js';
import { Hub, type Sink } from '../server/hub.js';
import { PROTOTYPE_BRIDGE, withPrototypeBridge } from '../server/prototype-bridge.js';
import { PrototypeStore } from '../server/prototypes.js';
import { SceneStore } from '../server/store.js';

// The Prototype view: prototypes published per conversation, opened only by the
// owner (or the operator for them), driven by voice commands with arguments.
// Synthetic fixtures only.

class RecordingSink implements Sink {
  events: Array<{ event: string; data: any }> = [];
  send(event: string, data: unknown): void {
    this.events.push({ event, data });
  }
  last(event: string) {
    return [...this.events].reverse().find((entry) => entry.event === event)?.data;
  }
  all(event: string) {
    return this.events.filter((entry) => entry.event === event).map((entry) => entry.data);
  }
}

let dir: string;
let store: SceneStore;
let prototypes: PrototypeStore;
let bundles: BundleStore;
let hub: Hub;
let clock: number;

function makeHub() {
  return new Hub(store, async () => 'agent', () => {}, () => clock, undefined, { prototypes });
}

function app() {
  return createApp({ store, hub, bundles, prototypes, publicDir: path.join(dir, 'public') });
}

async function request(method: string, pathname: string, body?: Record<string, unknown>) {
  const response = await app().request(pathname, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json, text, headers: response.headers };
}

const post = (pathname: string, body: Record<string, unknown> = {}) => request('POST', pathname, body);

function bundle(files: Record<string, string>): string {
  const saved = bundles.save(Object.entries(files).map(([file, text]) => ({ path: file, data: Buffer.from(text).toString('base64') })));
  return `bundles/${saved.id}/`;
}

async function publish(body: Record<string, unknown> = {}) {
  const base = bundle({ 'index.html': '<!doctype html><html><head><title>Onboarding</title></head><body><button>Continue</button></body></html>' });
  return post('/api/prototypes', { agentId: 'loom', agentName: expect.stringMatching(/^Loom · /), conversationKey: 'loom:thread-a', title: 'Onboarding v2', url: `${base}index.html`, ...body });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-test-'));
  fs.mkdirSync(path.join(dir, 'public'));
  fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<!doctype html><title>shell</title>');
  clock = 1_000_000;
  store = new SceneStore(path.join(dir, 'data'), () => clock);
  prototypes = new PrototypeStore(store.db, () => clock);
  bundles = new BundleStore(path.join(dir, 'bundles'));
  hub = makeHub();
});

afterEach(() => {
  hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('prototype store', () => {
  it('one live prototype per conversation + agent + name: publishing again replaces it in place', () => {
    const first = prototypes.publish({ agentId: 'loom', conversationKey: 'loom:a', url: 'https://example.test/a' });
    clock += 1000;
    const again = prototypes.publish({ agentId: 'loom', conversationKey: 'loom:a', url: 'https://example.test/b', title: 'B' });
    expect(again.replaced).toBe(true);
    expect(again.prototype).toMatchObject({ id: first.prototype.id, version: 2, url: 'https://example.test/b', title: 'B', name: 'main' });
    const other = prototypes.publish({ agentId: 'loom', conversationKey: 'loom:a', name: 'alt', url: 'https://example.test/c' });
    expect(other.replaced).toBe(false);
    expect(prototypes.liveForConversation('loom:a').map((p) => p.id)).toEqual([other.prototype.id, first.prototype.id]);
    expect(prototypes.liveForConversation('loom:b')).toEqual([]);
  });

  it('expires after its TTL (three days by default) and keeps its bundle until purged', () => {
    const { prototype } = prototypes.publish({ agentId: 'loom', conversationKey: 'loom:a', url: 'bundles/0123456789abcdef01234567/index.html' });
    expect(prototypes.bundleIds()).toEqual(new Set(['0123456789abcdef01234567']));
    clock += 3 * 86_400_000 - 1;
    expect(prototypes.sweep()).toEqual([]);
    clock += 1;
    expect(prototypes.isLive(prototype.id)).toBe(false);
    expect(prototypes.sweep()).toEqual([prototype.id]);
    expect(prototypes.get(prototype.id)!.status).toBe('expired');
    expect(prototypes.bundleIds().size).toBe(1); // kept while the row is
  });
});

describe('POST /api/prototypes', () => {
  it('publishes an uploaded bundle page; it is drivable', async () => {
    const result = await publish();
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ agentId: 'loom', conversationKey: 'loom:thread-a', title: 'Onboarding v2', drivable: true, version: 1, replaced: false, showing: false });
    expect(result.json.prototypeId).toMatch(/^p[0-9a-f]{11}$/);
  });

  it('a URL (a dev server) is shown but not drivable; anything else is refused', async () => {
    const url = await post('/api/prototypes', { agentId: 'loom', conversationKey: 'loom:a', url: 'https://box.example.ts.net:5173/' });
    expect(url.json).toMatchObject({ drivable: false });
    expect((await post('/api/prototypes', { agentId: 'loom', conversationKey: 'loom:a', url: 'file:///etc/passwd' })).status).toBe(400);
    expect((await post('/api/prototypes', { agentId: 'loom', conversationKey: 'loom:a', url: 'bundles/0123456789abcdef01234567/index.html' })).json.error).toContain('no such bundle file');
    expect((await post('/api/prototypes', { conversationKey: 'loom:a', url: 'https://x.test' })).status).toBe(400);
  });

  it('a Discord thread or channel is its conversation', async () => {
    expect((await post('/api/prototypes', { agentId: 'sierra', threadId: '7001', url: 'https://x.test' })).json.conversationKey).toBe('thread:7001');
    expect((await post('/api/prototypes', { agentId: 'sierra', channelId: '5000', url: 'https://x.test' })).json.conversationKey).toBe('channel:5000');
  });

  it('lists and clears', async () => {
    const { json } = await publish();
    expect((await request('GET', '/api/prototypes?conversationKey=loom:thread-a')).json.prototypes.map((p: any) => p.id)).toEqual([json.id]);
    expect((await request('DELETE', `/api/prototypes/${json.id}`)).json).toEqual({ cleared: [json.id] });
    expect((await request('GET', '/api/prototypes?conversationKey=loom:thread-a')).json.prototypes).toEqual([]);
  });
});

describe('the Prototype view', () => {
  it('opens the conversation’s newest prototype; the presentation carries it and the switcher list', async () => {
    const { json } = await publish();
    const screen = new RecordingSink();
    hub.addScreen('desk', screen);
    const opened = await post('/api/desk/presentation', { view: 'prototype', conversationKey: 'loom:thread-a', by: 'screen' });
    expect(opened.status).toBe(200);
    expect(opened.json.presentation).toMatchObject({ view: 'prototype', prototypeId: json.id, sceneId: null, conversationKey: 'loom:thread-a', manual: true });
    expect(opened.json.presentation.prototype).toMatchObject({ id: json.id, version: 1, drivable: true });
    expect(opened.json.presentation.prototypes.map((p: any) => p.id)).toEqual([json.id]);
    expect(screen.last('presentation').view).toBe('prototype');
  });

  it('a conversation without one: 409; an unknown id: 404; an agent never opens it', async () => {
    expect((await post('/api/desk/presentation', { view: 'prototype', conversationKey: 'loom:none', by: 'screen' })).status).toBe(409);
    expect((await post('/api/desk/presentation', { view: 'prototype', prototypeId: 'pnope', by: 'screen' })).status).toBe(404);
    await publish();
    const agent = await post('/api/desk/presentation', { view: 'prototype', conversationKey: 'loom:thread-a', by: 'agent' });
    expect(agent.json.applied).toBe(false);
    expect(agent.json.presentation.view).toBe('active');
  });

  it('publishing never takes the screen; the one showing reloads at its new version', async () => {
    const { json } = await publish();
    await post('/api/desk/presentation', { view: 'conversation', conversationKey: 'loom:thread-a', by: 'screen' });
    const screen = new RecordingSink();
    hub.addScreen('desk', screen);
    await publish({ title: 'Onboarding v3' });
    expect(hub.publicPresentation().view).toBe('conversation');
    expect(screen.last('presentation').prototypes[0]).toMatchObject({ id: json.id, version: 2 });
    await post('/api/desk/presentation', { view: 'prototype', prototypeId: json.id, by: 'screen' });
    await publish({ title: 'Onboarding v4' });
    expect(screen.last('presentation').prototype).toMatchObject({ id: json.id, version: 3, title: 'Onboarding v4' });
  });

  it('an agent staging a scene in the same conversation leaves the prototype up', async () => {
    await publish();
    await post('/api/desk/presentation', { view: 'prototype', conversationKey: 'loom:thread-a', by: 'director', reason: 'focus' });
    expect(hub.publicPresentation()).toMatchObject({ view: 'prototype', manual: false });
    const scene = await post('/api/scenes', { agentId: 'loom', conversationKey: 'loom:thread-a', kind: 'html', body: '<p>hi</p>', summary: 'a poster', check: false });
    expect(scene.status).toBe(200);
    expect(hub.publicPresentation()).toMatchObject({ view: 'prototype', screenAvailable: true });
  });

  it('cleared while showing: back to its conversation', async () => {
    const { json } = await publish();
    await post('/api/desk/presentation', { view: 'prototype', conversationKey: 'loom:thread-a', by: 'screen' });
    await request('DELETE', `/api/prototypes/${json.id}`);
    expect(hub.publicPresentation()).toMatchObject({ view: 'conversation', conversationKey: 'loom:thread-a', prototypeId: null, prototype: null, prototypes: [] });
  });

  it('survives a restart while live; an expired one falls back to its conversation', async () => {
    const { json } = await publish();
    await post('/api/desk/presentation', { view: 'prototype', conversationKey: 'loom:thread-a', by: 'screen' });
    hub.close();
    hub = makeHub();
    expect(hub.publicPresentation()).toMatchObject({ view: 'prototype', prototypeId: json.id });
    clock += 4 * 86_400_000;
    hub.close();
    hub = makeHub();
    expect(hub.publicPresentation()).toMatchObject({ view: 'conversation', prototypeId: null });
  });

  it('"back" returns to the prototype from the board', async () => {
    const { json } = await publish();
    await post('/api/desk/presentation', { view: 'prototype', conversationKey: 'loom:thread-a', by: 'screen' });
    await post('/api/desk/presentation', { view: 'active', by: 'screen' });
    await post('/api/back');
    expect(hub.publicPresentation()).toMatchObject({ view: 'prototype', prototypeId: json.id });
  });
});

describe('driving a prototype', () => {
  it('commands go to the prototype on screen, with their arguments', async () => {
    const { json } = await publish();
    const screen = new RecordingSink();
    hub.addScreen('desk', screen);
    await post('/api/desk/presentation', { view: 'prototype', conversationKey: 'loom:thread-a', by: 'screen' });
    expect((await post('/api/command', { name: 'click', args: { target: 'Continue' } })).json.sent).toBe(true);
    expect(screen.last('command')).toEqual({ sceneId: null, prototypeId: json.id, name: 'click', args: { target: 'Continue' } });
    expect((await post('/api/command', { name: 'scroll_down' })).json.sent).toBe(true);
    expect((await post('/api/command', { name: 'play' })).json.sent).toBe(false); // not a prototype command
    // What fill types reaches the page, never the trace.
    const traced: Array<{ kind: string; data: Record<string, unknown> }> = [];
    hub.setTracer((entry) => traced.push(entry));
    await post('/api/command', { name: 'fill', args: { target: 'Password', text: 'hunter2' } });
    expect(screen.last('command').args).toEqual({ target: 'Password', text: 'hunter2' });
    expect(traced.find((entry) => entry.kind === 'prototype.command')!.data.args).toEqual({ target: 'Password' });
    expect(JSON.stringify(traced)).not.toContain('hunter2');
  });

  it('a dev-server prototype can’t be driven', async () => {
    await post('/api/prototypes', { agentId: 'loom', conversationKey: 'loom:a', url: 'https://box.example.ts.net:5173/' });
    hub.addScreen('desk', new RecordingSink());
    await post('/api/desk/presentation', { view: 'prototype', conversationKey: 'loom:a', by: 'screen' });
    expect((await post('/api/command', { name: 'scroll_down' })).json.sent).toBe(false);
  });

  it('what the page reports reaches the operator, bounded; results too', async () => {
    const { json } = await publish();
    const director = new RecordingSink();
    hub.addDirector(director);
    const page = { path: 'index.html', title: 'Onboarding', targets: [{ label: 'Continue', kind: 'button', inView: true }], headings: ['Welcome'], fields: [], scroll: { percent: 0, scrollable: true } };
    expect((await post(`/api/prototypes/${json.id}/page`, { page })).status).toBe(200);
    expect(director.last('prototype-page')).toEqual({ prototypeId: json.id, page });
    expect((await post(`/api/prototypes/${json.id}/page`, { page: 'nope' })).status).toBe(400);
    expect((await post('/api/prototypes/pgone/page', { page })).status).toBe(404);
    await post(`/api/prototypes/${json.id}/result`, { name: 'click', ok: false, detail: 'nothing called "Pay" on the page' });
    expect(director.last('prototype-result')).toEqual({ prototypeId: json.id, name: 'click', ok: false, detail: 'nothing called "Pay" on the page' });
    await post('/api/desk/presentation', { view: 'prototype', conversationKey: 'loom:thread-a', by: 'screen' });
    expect(hub.status().prototypePage).toEqual(page);
  });

  it('clicks and keystrokes in the prototype are activity: the operator hears it', async () => {
    const { json } = await publish();
    const director = new RecordingSink();
    hub.addDirector(director);
    expect((await post(`/api/prototypes/${json.id}/activity`)).status).toBe(200);
    expect(director.last('prototype-activity')).toEqual({ prototypeId: json.id });
    expect((await post('/api/prototypes/pgone/activity')).status).toBe(404);
  });

  it('parsePrototypePage clips what a page can put in front of the operator', () => {
    const long = 'x'.repeat(500);
    const parsed = parsePrototypePage({
      path: 'a.html',
      title: long,
      targets: Array.from({ length: 90 }, (_, i) => ({ label: `B${i}`, kind: 'button', inView: i < 3 })),
      headings: [long, 3, ''],
      fields: ['Email'],
      scroll: { percent: 340 },
    })!;
    expect(parsed.title.length).toBe(80);
    expect(parsed.targets).toHaveLength(40);
    expect(parsed.headings).toEqual([expect.stringMatching(/^x+…$/)]);
    expect(parsed.scroll).toEqual({ percent: 100, scrollable: false });
  });
});

describe('bundle pages carry the navigation bridge', () => {
  it('appended at the end of the document, after the storage shim', async () => {
    const base = bundle({ 'index.html': '<!doctype html><html><head><title>t</title></head><body><p>hi</p></body></html>', 'app.js': 'console.log(1)' });
    const page = await request('GET', `/${base}index.html`);
    expect(page.text).toContain(PROTOTYPE_BRIDGE);
    expect(page.text.indexOf(PROTOTYPE_BRIDGE)).toBeGreaterThan(page.text.indexOf('<p>hi</p>'));
    expect(page.text.indexOf('localStorage')).toBeLessThan(page.text.indexOf('<p>hi</p>'));
    expect((await request('GET', `/${base}app.js`)).text).toBe('console.log(1)');
    expect(withPrototypeBridge('<p>no body tag</p>')).toBe(`<p>no body tag</p>${PROTOTYPE_BRIDGE}`);
    // A "</body>" inside a script or comment is never where it goes: always the very end.
    const tricky = '<body><p>x</p></body><!-- template: </body> --><script>var t = "</body>";</script>';
    expect(withPrototypeBridge(tricky)).toBe(`${tricky}${PROTOTYPE_BRIDGE}`);
  });
});

describe('tango-screen prototype', () => {
  it('uploads a folder, publishes it to the thread, updates it in place, lists and clears it', async () => {
    const worktree = path.join(dir, 'wt');
    const proto = path.join(worktree, 'proto');
    fs.mkdirSync(proto, { recursive: true });
    fs.writeFileSync(path.join(proto, 'index.html'), '<!doctype html><title>t</title><body><button>Go</button><script src="app.js"></script></body>');
    fs.writeFileSync(path.join(proto, 'app.js'), 'console.log(1)');
    fs.writeFileSync(path.join(dir, 'token'), 'secret-token');
    const shell = { projects: [{ id: 'p1', title: 'tango', workspaceRoot: path.join(dir, 'root') }], threads: [{ id: 'thread-9', projectId: 'p1', title: 'Onboarding', worktreePath: worktree, archivedAt: null }] };
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin === 'http://t3.test') return new Response(JSON.stringify(shell), { headers: { 'content-type': 'application/json' } });
      return app().request(url.pathname + url.search, init);
    }) as typeof fetch;
    const lines: string[] = [];
    const out = (line: string) => lines.push(line);
    const env = { TANGO_DESK_ITEM: 'loom:thread-9', TANGO_SCREEN_URL: 'http://screen.test' };
    try {
      await cli.run(['prototype', 'proto', '--title', 'Onboarding v2'], { env, cwd: worktree, out });
      expect(lines[0]).toMatch(/^published prototype “Onboarding v2” \(v1\) on thread-9/);
      const [live] = prototypes.live('loom');
      expect(live).toMatchObject({ conversationKey: 'loom:thread-9', agentName: expect.stringMatching(/^Loom · /), name: 'main', title: 'Onboarding v2', version: 1 });
      expect(live!.url).toMatch(/^bundles\/[a-f0-9]{24}\/index\.html$/);

      lines.length = 0;
      await cli.run(['prototype', 'proto', '--title', 'Onboarding v3'], { env, cwd: worktree, out });
      expect(lines[0]).toMatch(/^updated prototype “Onboarding v3” \(v2\)/);
      expect(prototypes.live('loom')).toHaveLength(1);

      lines.length = 0;
      await cli.run(['list'], { env, cwd: worktree, out });
      expect(lines).toEqual([expect.stringMatching(/^prototype main\tv2\tOnboarding v3/)]);

      await cli.run(['clear', '--prototype'], { env, cwd: worktree, out });
      expect(prototypes.live('loom')).toHaveLength(0);

      await expect(cli.run(['prototype', path.join(proto, 'app.js')], { env, cwd: worktree, out })).rejects.toThrow(/know how to show app.js/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('the desk frame for a prototype', () => {
  it('a dev server on another origin keeps its origin; the desk’s own origin and bundles stay opaque', async () => {
    // @ts-expect-error plain browser module, no types
    const { sandboxFor } = await import('../public/desk/prototype.js');
    const desk = 'https://box.example.ts.net';
    expect(sandboxFor({ url: 'https://box.example.ts.net:15173/' }, desk)).toBe('allow-same-origin');
    expect(sandboxFor({ url: 'https://box.example.ts.net/artifacts/x/index.html' }, desk)).toBe('');
    expect(sandboxFor({ url: 'bundles/0123456789abcdef01234567/index.html' }, desk)).toBe('');
  });
});

describe('the desk store', () => {
  it('an empty prototype list from the hub wins over a stale cached one', async () => {
    // @ts-expect-error plain browser module, no types
    const { createStore } = await import('../public/desk/store.js');
    const intents: unknown[] = [];
    const store = createStore({ mode: 'fixtures', present: async (intent: unknown) => (intents.push(intent), { view: 'conversation' }), presentation: async () => ({ view: 'conversation' }) });
    const stale = { id: 'pold', conversationKey: 'loom:a', version: 1 };
    store.set({ presentation: { view: 'conversation', itemId: 'loom:a', conversationKey: 'loom:a', prototypes: [] }, detail: { id: 'loom:a', prototypes: [stale] } });
    store.showPrototype();
    expect(intents).toEqual([]);
    store.set({ presentation: { view: 'conversation', itemId: 'loom:a', conversationKey: 'loom:a' } }); // an older hub: no list
    store.showPrototype();
    expect(intents).toEqual([expect.objectContaining({ view: 'prototype', prototypeId: 'pold' })]);
  });
});

describe('prototype frame URLs', () => {
  it('the version goes in the query, before a hash route', async () => {
    // @ts-expect-error plain browser module, no types
    const { prototypeUrl } = await import('../public/desk/api.js');
    expect(prototypeUrl({ url: 'bundles/abc/index.html', version: 2 }, '/desk/')).toBe('/desk/bundles/abc/index.html?v=2');
    expect(prototypeUrl({ url: 'bundles/abc/index.html#/checkout', version: 2 }, '/desk/')).toBe('/desk/bundles/abc/index.html?v=2#/checkout');
    expect(prototypeUrl({ url: 'bundles/abc/index.html?a=1#x', version: 3 }, '/desk/')).toBe('/desk/bundles/abc/index.html?a=1&v=3#x');
    expect(prototypeUrl({ url: 'https://dev.example.test:5173/#/a', version: 3 }, '/desk/')).toBe('https://dev.example.test:5173/#/a');
  });
});

describe('going back inside a prototype', () => {
  it('only to a page the prototype came from, never past its first page', async () => {
    // @ts-expect-error plain browser module, no types
    const { createProtoNav } = await import('../public/desk/proto-nav.js');
    const nav = createProtoNav();
    nav.page('p1', 'index.html');
    expect(nav.canGoBack('p1')).toBe(false);
    nav.page('p1', 'index.html'); // a re-report of the same page
    nav.page('p1', 'plans.html');
    nav.page('p1', 'done.html');
    expect(nav.canGoBack('p1')).toBe(true);
    nav.goingBack();
    nav.page('p1', 'plans.html');
    nav.goingBack();
    nav.page('p1', 'index.html');
    expect(nav.canGoBack('p1')).toBe(false);
    nav.page('p1', 'plans.html');
    expect(nav.canGoBack('p1')).toBe(true);
    expect(nav.canGoBack('p2')).toBe(false);
    nav.page('p2', 'index.html'); // another prototype starts over
    expect(nav.canGoBack('p2')).toBe(false);
  });
});
