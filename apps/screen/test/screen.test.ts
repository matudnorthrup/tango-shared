import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app.js';
import { renderFrame } from '../server/frame.js';
import { parseGoogleUrl } from '../server/google.js';
import { Hub, type Sink } from '../server/hub.js';
import { defaultAssetRoots, SceneStore } from '../server/store.js';

class RecordingSink implements Sink {
  events: Array<{ event: string; data: any }> = [];
  send(event: string, data: unknown): void {
    this.events.push({ event, data });
  }
  last(event: string) {
    return [...this.events].reverse().find((entry) => entry.event === event)?.data;
  }
}

let dir: string;
let store: SceneStore;
let hub: Hub;
let fallbackCalls: Array<{ sceneId: string; type: string }>;
let clock: number;

function app() {
  return createApp({ store, hub, publicDir: path.join(dir, 'public') });
}

async function stage(body: Record<string, unknown>) {
  const response = await app().request('/api/scenes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as any };
}

async function post(pathname: string, body: Record<string, unknown> = {}) {
  const response = await app().request(pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return (await response.json()) as any;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-test-'));
  fs.mkdirSync(path.join(dir, 'public'));
  fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<!doctype html><title>shell</title>');
  clock = 1_000_000;
  store = new SceneStore(path.join(dir, 'data'), () => clock);
  fallbackCalls = [];
  hub = new Hub(store, async (scene, input) => {
    fallbackCalls.push({ sceneId: scene.id, type: input.type });
    return 'agent';
  }, () => {}, () => clock);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('staging', () => {
  it('replaces the scene in the same slot in place', async () => {
    const first = await stage({ agentId: 'sierra', slot: 'speakers', kind: 'html', body: '<h1>3 picks</h1>', summary: 'Three speaker picks' });
    const second = await stage({ agentId: 'sierra', slot: 'speakers', kind: 'html', body: '<h1>2 picks</h1>', summary: 'Two speaker picks' });
    expect(second.json.sceneId).toBe(first.json.sceneId);
    expect(second.json.version).toBe(2);
    expect(second.json.replaced).toBe(true);
    expect(store.live('sierra')).toHaveLength(1);
    expect(store.live('sierra')[0]!.agentName).toBe('Sierra');
  });

  it('requires a summary and a valid kind', async () => {
    expect((await stage({ agentId: 'sierra', kind: 'html', body: '<p>x</p>' })).status).toBe(400);
    expect((await stage({ agentId: 'sierra', kind: 'gif', body: 'x', summary: 's' })).status).toBe(400);
    expect((await stage({ agentId: 'sierra', kind: 'image', body: 'relative.png', summary: 's' })).status).toBe(400);
  });

  it('copies local images into the asset store', async () => {
    const image = path.join(dir, 'shot.png');
    fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { json } = await stage({ agentId: 'watson', kind: 'image', body: image, summary: 'Router settings screenshot' });
    const scene = store.get(json.sceneId)!;
    expect(scene.body).toMatch(/^assets\/[a-f0-9]{32}\.png$/);
    const asset = await app().request(`/${scene.body}`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toBe('image/png');
  });

  it('imports only media files under the allowed roots, resolving symlinks first', async () => {
    const allowed = path.join(dir, 'allowed');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(allowed);
    fs.mkdirSync(outside);
    store = new SceneStore(path.join(dir, 'data2'), () => clock, [allowed]);
    hub = new Hub(store, async () => 'agent', () => {}, () => clock);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    fs.writeFileSync(path.join(allowed, 'ok.png'), png);
    fs.writeFileSync(path.join(outside, 'elsewhere.png'), png);
    fs.writeFileSync(path.join(allowed, 'notes.txt'), 'secret');
    fs.writeFileSync(path.join(outside, '.env'), 'TOKEN=1');
    // A media-named link inside the root that points at a secret outside it.
    fs.symlinkSync(path.join(outside, '.env'), path.join(allowed, 'innocent.png'));
    fs.symlinkSync(path.join(outside, 'elsewhere.png'), path.join(allowed, 'linked.png'));

    const ok = await stage({ agentId: 'watson', kind: 'image', body: path.join(allowed, 'ok.png'), summary: 's' });
    expect(ok.status).toBe(200);

    const outsideRoot = await stage({ agentId: 'watson', kind: 'image', body: path.join(outside, 'elsewhere.png'), summary: 's', slot: 'b' });
    expect(outsideRoot.status).toBe(400);
    expect(outsideRoot.json.error).toMatch(/outside the folders screens may import from.*SCREEN_ASSET_ROOTS/);

    const text = await stage({ agentId: 'watson', kind: 'image', body: path.join(allowed, 'notes.txt'), summary: 's', slot: 'c' });
    expect(text.status).toBe(400);
    expect(text.json.error).toMatch(/not an image or video/);

    for (const link of ['innocent.png', 'linked.png']) {
      const linked = await stage({ agentId: 'watson', kind: 'image', body: path.join(allowed, link), summary: 's', slot: link });
      expect(linked.status).toBe(400);
    }
    expect(fs.readdirSync(store.assetsDir)).toHaveLength(1);
  });

  it('adds SCREEN_ASSET_ROOTS to the default roots', () => {
    const roots = defaultAssetRoots('/profile/data', { SCREEN_ASSET_ROOTS: '/srv/media: relative :/mnt/shots' });
    expect(roots).toEqual(['/profile/data', path.join(os.homedir(), '.agentic-workflow', 'artifacts'), os.tmpdir(), '/srv/media', '/mnt/shots']);
  });

  it('turns plain-label choices into lettered ids', async () => {
    const { json } = await stage({ agentId: 'sierra', kind: 'html', body: '<p>x</p>', summary: 'Pick one', choices: ['Sony', 'Pioneer'] });
    expect(store.get(json.sceneId)!.choices).toEqual([{ id: 'a', label: 'Sony' }, { id: 'b', label: 'Pioneer' }]);
  });
});

describe('what shows', () => {
  it('holds scenes until the director shows them', async () => {
    const screen = new RecordingSink();
    hub.addScreen('kitchen', screen);
    hub.addDirector(new RecordingSink());
    const { json } = await stage({ agentId: 'malibu', slot: 'macros', kind: 'html', body: '<p>macros</p>', summary: 'Macros so far today' });
    expect(json.showing).toBe(false);
    expect(hub.showingScene()).toBeNull();
    const shown = await post('/api/show', { agentId: 'malibu' });
    expect(shown.showing.id).toBe(json.sceneId);
    expect(screen.last('show').scene.id).toBe(json.sceneId);
  });

  it('shows urgent scenes on its own when nobody is directing', async () => {
    hub.addScreen('', new RecordingSink());
    const { json } = await stage({ agentId: 'victor', kind: 'html', body: '<p>!</p>', summary: 'Deploy failed', urgent: true });
    expect(json.showing).toBe(true);
  });

  it('refreshes a showing scene in place when it is re-staged', async () => {
    const screen = new RecordingSink();
    hub.addScreen('', screen);
    const first = await stage({ agentId: 'sierra', slot: 'board', kind: 'html', body: '<p>1</p>', summary: 'v1' });
    hub.show(first.json.sceneId, 'director');
    const second = await stage({ agentId: 'sierra', slot: 'board', kind: 'html', body: '<p>2</p>', summary: 'v2' });
    expect(second.json.showing).toBe(true);
    expect(screen.last('show')).toMatchObject({ updated: true, scene: { version: 2 } });
  });

  it('pushes live state to the showing scene only', async () => {
    const screen = new RecordingSink();
    hub.addScreen('', screen);
    const { json } = await stage({ agentId: 'malibu', slot: 'macros', kind: 'html', body: '<p></p>', summary: 'Macros', state: { protein: 40 } });
    hub.show(json.sceneId, 'director');
    const response = await app().request(`/api/scenes/${json.sceneId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: { protein: 95 } }),
    });
    expect(response.status).toBe(200);
    expect(screen.last('state')).toEqual({ sceneId: json.sceneId, state: { protein: 95 } });
  });

  it('goes back to the previous live scene, then the dashboard', async () => {
    const a = await stage({ agentId: 'sierra', kind: 'html', body: '<p>a</p>', summary: 'a' });
    const b = await stage({ agentId: 'malibu', kind: 'html', body: '<p>b</p>', summary: 'b' });
    hub.show(a.json.sceneId, 'director');
    hub.show(b.json.sceneId, 'director');
    expect((await post('/api/back')).showing.id).toBe(a.json.sceneId);
    expect((await post('/api/back')).showing).toBeNull();
  });

  it('falls back to the dashboard when the showing scene is cleared or expires', async () => {
    const { json } = await stage({ agentId: 'sierra', kind: 'html', body: '<p>a</p>', summary: 'a', ttlMinutes: 1 });
    hub.show(json.sceneId, 'director');
    clock += 2 * 60_000;
    hub.removed(store.sweep());
    expect(hub.showingScene()).toBeNull();
  });
});

describe('commands', () => {
  it('sends commands to the showing scene, and scrolls to the inbox when nothing is showing', async () => {
    const screen = new RecordingSink();
    hub.addScreen('', screen);
    expect(await post('/api/command', { name: 'play' })).toMatchObject({ sent: false });
    expect(await post('/api/command', { name: 'scroll_down' })).toMatchObject({ sent: true });
    expect(screen.last('command')).toEqual({ sceneId: null, name: 'scroll_down' });
    const { json } = await stage({ agentId: 'sierra', kind: 'html', body: '<p>long</p>', summary: 'Mockups' });
    hub.show(json.sceneId, 'director');
    expect(await post('/api/command', { name: 'scroll_up' })).toMatchObject({ sent: true });
    expect(screen.last('command')).toEqual({ sceneId: json.sceneId, name: 'scroll_up' });
  });

  it('going home closes an open inbox item on every screen', async () => {
    const screen = new RecordingSink();
    hub.addScreen('', screen);
    hub.openInboxItem('topic:1');
    expect(await post('/api/show', { dashboard: true })).toEqual({ showing: null });
    expect(screen.last('inbox-home')).toEqual({});
    expect(hub.status().inboxFocus).toBeNull();
  });

  it("can't scroll a url scene (another site in a nested frame), so it says so", async () => {
    const screen = new RecordingSink();
    hub.addScreen('', screen);
    const { json } = await stage({ agentId: 'sierra', kind: 'url', body: 'https://example.com', summary: 'A site' });
    hub.show(json.sceneId, 'director');
    expect(await post('/api/command', { name: 'scroll_down' })).toMatchObject({ sent: false });
  });

  it('has nothing to scroll without a connected screen', async () => {
    expect(await post('/api/command', { name: 'scroll_down' })).toMatchObject({ sent: false });
  });
});

describe('input', () => {
  it('goes to the operator while one is directing', async () => {
    const director = new RecordingSink();
    hub.addDirector(director);
    const { json } = await stage({ agentId: 'sierra', kind: 'html', body: '<p>x</p>', summary: 'Pick', choices: ['Sony', 'Pioneer'], channelId: 'c1' });
    const result = await post('/api/input', { sceneId: json.sceneId, type: 'choice', data: { choiceId: 'b' } });
    expect(result.routed).toBe('operator');
    expect(director.last('input')).toMatchObject({ type: 'choice', data: { choiceId: 'b' }, scene: { agentId: 'sierra' } });
    expect(fallbackCalls).toHaveLength(0);
  });

  it('goes to the agent conversation when no operator is live', async () => {
    const screen = new RecordingSink();
    hub.addScreen('', screen);
    const { json } = await stage({ agentId: 'sierra', kind: 'html', body: '<p>x</p>', summary: 'Pick', choices: ['Sony', 'Pioneer'], channelId: 'c1' });
    const result = await post('/api/input', { sceneId: json.sceneId, type: 'choice', data: { choiceId: 'a' } });
    expect(result.routed).toBe('agent');
    expect(fallbackCalls).toEqual([{ sceneId: json.sceneId, type: 'choice' }]);
    expect(screen.last('ack')).toMatchObject({ label: 'Sony', agentName: 'Sierra' });
  });
});

describe('dashboard', () => {
  it('lists working agents first, with their staged scenes', async () => {
    await stage({ agentId: 'malibu', kind: 'html', body: '<p>x</p>', summary: 'Macros' });
    hub.setTasks([{ agentId: 'sierra', agentName: 'Sierra', request: 'find speakers', status: 'running' }]);
    const { agents } = hub.dashboard();
    expect(agents.map((agent) => agent.id)).toEqual(['sierra', 'malibu']);
    expect(agents[1]!.scenes[0]!.summary).toBe('Macros');
  });
});

describe('frames', () => {
  const scene = (overrides: Record<string, unknown>) => ({
    id: 'abc', agentId: 'sierra', agentName: 'Sierra', slot: 'main', kind: 'html', title: '', body: '', summary: 's',
    choices: [], state: { n: 1 }, urgent: false, origin: {}, version: 1, status: 'live', createdAt: 0, updatedAt: 0, expiresAt: 0,
    ...overrides,
  }) as any;

  it('injects the bridge ahead of a full document so its own styles win', () => {
    const html = renderFrame(scene({ body: '<!doctype html><html><head><style>body{color:red}</style></head><body>hi</body></html>' }));
    expect(html.indexOf('window.tango')).toBeLessThan(html.indexOf('body{color:red}'));
  });

  it('scrolls every scene on the built-in scroll commands', () => {
    const html = renderFrame(scene({ body: '<p>hi</p>' }));
    expect(html).toContain('scrollScene(message.name)');
    expect(html).toContain("name === 'scroll_top'");
    // App-style pages scroll the body itself.
    expect(html).toContain('[document.body].concat(');
  });

  it('wraps fragments and escapes embedded state', () => {
    const html = renderFrame(scene({ body: '<p>hi</p>', state: { x: '</script><script>alert(1)</script>' } }));
    expect(html).toContain('<p>hi</p>');
    expect(html).not.toContain('</script><script>alert(1)');
  });

  it('serves frames with a sandbox CSP', async () => {
    const { json } = await stage({ agentId: 'sierra', kind: 'html', body: '<p>x</p>', summary: 's' });
    const response = await app().request(`/frame/${json.sceneId}`);
    expect(response.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts/);
    expect(response.headers.get('content-security-policy')).not.toContain('allow-same-origin');
    // A link the scene opens in a new tab gets a normal origin (signed-in sites work there).
    expect(response.headers.get('content-security-policy')).toContain('allow-popups-to-escape-sandbox');
  });

  it('shows a signed-in Google file as a card when the server has no Google reader', () => {
    const doc = 'https://docs.google.com/document/d/1AbCdEfGhIjK/edit?usp=sharing';
    const html = renderFrame(scene({ kind: 'url', body: doc, title: 'Q4 plan', summary: 'Draft for review' }));
    expect(html).not.toContain('<iframe');
    expect(html).toContain('Open in Google Docs');
    expect(html).toContain(`href="${doc.replace(/&/g, '&amp;')}" target="_blank"`);
    expect(html).toContain('Draft for review');
    expect(parseGoogleUrl('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjK/edit#gid=0')).toEqual({ id: '1AbCdEfGhIjK', app: 'Google Sheets', gid: 0 });
    expect(parseGoogleUrl('https://docs.google.com/presentation/d/1AbCdEfGhIjK/edit')?.app).toBe('Google Slides');
    expect(parseGoogleUrl('https://drive.google.com/file/d/1AbCdEfGhIjK/view')).toEqual({ id: '1AbCdEfGhIjK', app: 'Google Drive' });
    expect(parseGoogleUrl('https://drive.google.com/open?id=1AbCdEfGhIjK')?.id).toBe('1AbCdEfGhIjK');
  });

  it('still embeds published Google files and every other site', () => {
    expect(parseGoogleUrl('https://docs.google.com/document/d/e/2PACX-1vAbCdEfGhIjK/pub')).toBeUndefined();
    expect(parseGoogleUrl('https://docs.google.com/presentation/d/1AbCdEfGhIjK/embed')).toBeUndefined();
    expect(parseGoogleUrl('https://example.com/document/d/1AbCdEfGhIjK/edit')).toBeUndefined();
    expect(renderFrame(scene({ kind: 'url', body: 'https://example.com' }))).toContain('<iframe class="tango-full" src="https://example.com"');
  });
});

describe('choices from html', () => {
  it('reads data-choice elements when the agent passes no choices', async () => {
    const { json } = await stage({
      agentId: 'sierra',
      kind: 'html',
      summary: 'Picks',
      body: '<div class="card" data-choice="sony"><h2>Sony XAV</h2><p>$550</p></div><button data-choice="k" data-label="Brand K">x</button><div data-choice="p">  Pioneer <b>DMH</b> </div>',
    });
    expect(store.get(json.sceneId)!.choices).toEqual([
      { id: 'sony', label: 'Sony XAV' },
      { id: 'k', label: 'Brand K' },
      { id: 'p', label: 'DMH' },
    ]);
  });
});

describe('after the operator session', () => {
  it('once the grace period passes, marks the presentation idle (Screen windows go to their feed) and keeps it', async () => {
    vi.useFakeTimers();
    try {
      const graced = new Hub(store, async () => 'agent', () => {}, () => clock, 5000);
      const director = graced.addDirector(new RecordingSink());
      const { scene } = store.stage({ agentId: 'sierra', kind: 'html', body: '<p>x</p>', summary: 's' });
      graced.show(scene.id, 'director');
      graced.removeDirector(director);
      vi.advanceTimersByTime(4000);
      expect(graced.showingScene()?.id).toBe(scene.id);
      expect(graced.publicPresentation().stageIdle).toBeUndefined();
      vi.advanceTimersByTime(2000);
      // Full and control windows stay on it; only Screen windows let it go (hub.ts idleScreens).
      expect(graced.showingScene()?.id).toBe(scene.id);
      expect(graced.publicPresentation()).toMatchObject({ view: 'screen', sceneId: scene.id, stageIdle: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('scene identity: (conversation, agent, slot)', () => {
  it('keeps two conversations of one agent apart in the same slot', async () => {
    const a = await stage({ agentId: 'sierra', slot: 'board', kind: 'html', body: '<p>a</p>', summary: 'Loop A', threadId: 't-100', channelId: 'c-home' });
    const b = await stage({ agentId: 'sierra', slot: 'board', kind: 'html', body: '<p>b</p>', summary: 'Loop B', threadId: 't-200', channelId: 'c-home' });
    expect(b.json.sceneId).not.toBe(a.json.sceneId);
    expect(b.json.replaced).toBe(false);
    expect(a.json.conversationKey).toBe('thread:t-100');
    expect(b.json.conversationKey).toBe('thread:t-200');
    const again = await stage({ agentId: 'sierra', slot: 'board', kind: 'html', body: '<p>a2</p>', summary: 'Loop A v2', threadId: 't-100', channelId: 'c-home' });
    expect(again.json).toMatchObject({ sceneId: a.json.sceneId, version: 2, replaced: true });
    expect(store.get(b.json.sceneId)).toMatchObject({ summary: 'Loop B', version: 1, status: 'live' });
    expect(store.live('sierra')).toHaveLength(2);
  });

  it('keys scenes by explicit key, then thread, then channel, then the agent alone', async () => {
    const keyed = await stage({ agentId: 'watson', slot: 's1', kind: 'html', body: '<p>x</p>', summary: 's', conversationKey: 'loom:abc', threadId: 'ignored' });
    const channel = await stage({ agentId: 'watson', slot: 's2', kind: 'html', body: '<p>x</p>', summary: 's', channelId: 'c-9' });
    const bare = await stage({ agentId: 'watson', slot: 's3', kind: 'html', body: '<p>x</p>', summary: 's' });
    expect([keyed.json.conversationKey, channel.json.conversationKey, bare.json.conversationKey]).toEqual(['loom:abc', 'channel:c-9', 'agent:watson']);
    const scene = (await (await app().request(`/api/scenes/${keyed.json.sceneId}`)).json()) as any;
    expect(scene.conversationKey).toBe('loom:abc');
  });

  it('finds an agent slot within one conversation', async () => {
    const a = await stage({ agentId: 'sierra', slot: 'board', kind: 'html', body: '<p>a</p>', summary: 'A', threadId: 't-1' });
    await stage({ agentId: 'sierra', slot: 'board', kind: 'html', body: '<p>b</p>', summary: 'B', threadId: 't-2' });
    const all = (await (await app().request('/api/stages/sierra?slot=board')).json()) as any;
    expect(all.scenes).toHaveLength(2);
    const one = (await (await app().request('/api/stages/sierra?slot=board&threadId=t-1')).json()) as any;
    expect(one.scenes.map((scene: any) => scene.id)).toEqual([a.json.sceneId]);
    const byKey = (await (await app().request('/api/stages/sierra?slot=board&conversationKey=thread:t-1')).json()) as any;
    expect(byKey.scenes.map((scene: any) => scene.id)).toEqual([a.json.sceneId]);
  });

  it('migrates an old (agent, slot) database in place', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const oldDir = path.join(dir, 'old');
    fs.mkdirSync(oldDir, { recursive: true });
    const db = new DatabaseSync(path.join(oldDir, 'screen.db'));
    db.exec(`
      CREATE TABLE scenes (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, agent_name TEXT NOT NULL, slot TEXT NOT NULL, kind TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, summary TEXT NOT NULL, choices TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL DEFAULT '{}',
        urgent INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'live',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX scenes_live_slot ON scenes(agent_id, slot) WHERE status = 'live';
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, scene_id TEXT NOT NULL, agent_id TEXT NOT NULL, type TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}', routed TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
    `);
    const insert = db.prepare(`INSERT INTO scenes (id, agent_id, agent_name, slot, kind, body, summary, origin, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, 'main', 'html', '<p></p>', 's', ?, 1, 1, 9999999999999)`);
    insert.run('s-key', 'juliet', 'Juliet', JSON.stringify({ conversationKey: 'thread:k1', threadId: 'other' }));
    insert.run('s-thread', 'sierra', 'Sierra', JSON.stringify({ threadId: 't9', channelId: 'c9' }));
    insert.run('s-channel', 'malibu', 'Malibu', JSON.stringify({ channelId: 'c5' }));
    insert.run('s-none', 'victor', 'Victor', '{}');
    db.prepare("INSERT INTO events (scene_id, agent_id, type, created_at) VALUES ('s-none', 'victor', 'choice', 1)").run();
    db.close();

    const migrated = new SceneStore(oldDir, () => clock);
    expect(['s-key', 's-thread', 's-channel', 's-none'].map((id) => migrated.get(id)!.conversationKey)).toEqual([
      'thread:k1',
      'thread:t9',
      'channel:c5',
      'agent:victor',
    ]);
    const indexes = (migrated.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'scenes'").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    expect(indexes).toContain('scenes_live_conversation_slot');
    expect(indexes).not.toContain('scenes_live_slot');
    // Same agent + slot in a second conversation is now allowed; re-staging the first updates in place.
    expect(migrated.stage({ agentId: 'sierra', kind: 'html', body: '<p>2</p>', summary: 's', origin: { threadId: 't10' } }).replaced).toBe(false);
    expect(migrated.stage({ agentId: 'sierra', kind: 'html', body: '<p>3</p>', summary: 's', origin: { threadId: 't9' } }).scene).toMatchObject({ id: 's-thread', version: 2 });
    // Old event rows read as delivered; reopening the migrated database is a no-op.
    expect(new SceneStore(oldDir, () => clock).get('s-none')!.conversationKey).toBe('agent:victor');
  });
});

describe('honest commands', () => {
  it('reports a command to a showing scene as undelivered when no screen is connected', async () => {
    const { json } = await stage({ agentId: 'sierra', kind: 'video', body: 'https://example.com/v.mp4', summary: 'Clip' });
    hub.show(json.sceneId, 'director');
    expect(await post('/api/command', { name: 'play' })).toEqual({ sent: false, delivered: false, screens: 0 });
    hub.addScreen('', new RecordingSink());
    expect(await post('/api/command', { name: 'play' })).toEqual({ sent: true, delivered: true, screens: 1 });
  });
});

describe('reconnect', () => {
  it('a reconnecting screen gets the presentation and the live state of what is showing', async () => {
    const { json } = await stage({ agentId: 'malibu', kind: 'html', body: '<p></p>', summary: 'Macros', state: { protein: 40 } });
    hub.show(json.sceneId, 'director');
    await app().request(`/api/scenes/${json.sceneId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: { protein: 95 } }),
    });
    const screen = new RecordingSink();
    hub.addScreen('kitchen', screen);
    const hello = screen.last('hello');
    expect(hello.presentation).toMatchObject({ view: 'screen', sceneId: json.sceneId, screenAvailable: true });
    expect(hello.showing).toMatchObject({ id: json.sceneId, state: { protein: 95 } });
    expect(screen.last('state')).toEqual({ sceneId: json.sceneId, state: { protein: 95 } });
  });
});
