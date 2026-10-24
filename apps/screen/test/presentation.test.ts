import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app.js';
import { Hub, itemConversationKey, type RoutedInput, type Sink } from '../server/hub.js';
import { SceneStore, type Scene } from '../server/store.js';

// Synthetic fixtures only: agent ids are the public persona names, every
// channel/thread id is made up.

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
let hub: Hub;
let clock: number;
let routes: Array<{ scene: Scene; input: RoutedInput }>;
let fallbackResult: string;

function makeHub(options: { graceMs?: number; ackMs?: number } = {}) {
  return new Hub(
    store,
    async (scene, input) => {
      routes.push({ scene, input });
      return fallbackResult;
    },
    () => {},
    () => clock,
    options.graceMs,
    { ackTimeoutMs: options.ackMs },
  );
}

function app() {
  return createApp({ store, hub, publicDir: path.join(dir, 'public') });
}

async function request(method: string, pathname: string, body?: Record<string, unknown>) {
  const response = await app().request(pathname, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: (await response.json()) as any };
}

const post = (pathname: string, body: Record<string, unknown> = {}) => request('POST', pathname, body);
const present = (body: Record<string, unknown>) => post('/api/desk/presentation', body);
const presentation = async () => (await request('GET', '/api/desk/presentation')).json;

async function stage(agentId: string, slot: string, thread: string | null, extra: Record<string, unknown> = {}) {
  const { json } = await post('/api/scenes', {
    agentId,
    slot,
    kind: 'html',
    body: `<p>${agentId} ${slot}</p>`,
    summary: `${agentId} ${slot}`,
    ...(thread ? { threadId: thread, channelId: `home-${agentId}` } : {}),
    ...extra,
  });
  return json;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-presentation-'));
  fs.mkdirSync(path.join(dir, 'public'));
  clock = 5_000_000;
  routes = [];
  fallbackResult = 'agent';
  store = new SceneStore(path.join(dir, 'data'), () => clock);
  hub = makeHub();
});

afterEach(() => {
  hub.close();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('item conversation keys', () => {
  it('derives the conversation from a desk item id', () => {
    expect(itemConversationKey('discord:thread:111')).toBe('thread:111');
    expect(itemConversationKey('discord:chapter:222:333')).toBe('channel:222');
    expect(itemConversationKey('loom:abc-def')).toBe('loom:abc-def');
    expect(itemConversationKey('loom:604029fb-3579')).toBe('loom:604029fb-3579');
    expect(itemConversationKey('topic:9')).toBeNull();
  });
});

describe('presentation endpoints', () => {
  it('starts on the board', async () => {
    expect(await presentation()).toMatchObject({ view: 'active', itemId: null, conversationKey: null, sceneId: null, queue: [], manual: false, screenAvailable: false });
  });

  it('validates intents', async () => {
    expect((await present({ view: 'stage', by: 'screen' })).status).toBe(400);
    expect((await present({ view: 'active', by: 'someone' })).status).toBe(400);
    expect((await present({ view: 'conversation', by: 'screen' })).status).toBe(400);
    expect((await present({ view: 'conversation', by: 'screen', itemId: 'topic:legacy' })).status).toBe(400);
    expect((await present({ view: 'screen', by: 'screen', sceneId: 'nope' })).status).toBe(404);
  });

  it('broadcasts presentation on the screen and director streams, keeping show/showing working', async () => {
    const screen = new RecordingSink();
    const director = new RecordingSink();
    hub.addScreen('desk', screen);
    hub.addDirector(director);
    expect(screen.last('hello').presentation).toMatchObject({ view: 'active' });
    expect(director.last('hello')).toMatchObject({ presentation: { view: 'active' }, screens: [{ name: 'desk' }], stages: [] });
    await present({ view: 'conversation', by: 'director', conversationKey: 'thread:t-1' });
    expect(screen.last('presentation')).toMatchObject({ view: 'conversation', conversationKey: 'thread:t-1' });
    expect(director.last('presentation')).toMatchObject({ view: 'conversation', conversationKey: 'thread:t-1' });
    const scene = await stage('sierra', 'loop', 't-1');
    expect(scene.showing).toBe(true);
    expect(screen.last('show').scene.id).toBe(scene.sceneId);
    expect(director.last('showing')).toMatchObject({ scene: { id: scene.sceneId }, by: 'agent' });
    expect(director.last('staged')).toMatchObject({ scene: { conversationKey: 'thread:t-1' }, showing: true });
  });
});

describe('a window’s moves out of order', () => {
  it('a move landing after a newer one from the same window is refused; another window still moves', async () => {
    const opened = await present({ view: 'conversation', by: 'screen', itemId: 'loom:next', window: { id: 'w-a', seq: 2 } });
    expect(opened.json).toMatchObject({ applied: true });
    // Send's "back to the board", sent first, stuck, and landing late.
    const late = (await present({ view: 'active', by: 'screen', window: { id: 'w-a', seq: 1 } })).json;
    expect(late).toMatchObject({ applied: false, ignored: 'stale', presentation: { view: 'conversation', itemId: 'loom:next' } });
    expect(await presentation()).toMatchObject({ view: 'conversation', itemId: 'loom:next' });
    // The same window's next move, and any other window's, apply.
    expect((await present({ view: 'active', by: 'screen', window: { id: 'w-b', seq: 1 } })).json).toMatchObject({ applied: true });
    expect((await present({ view: 'conversation', by: 'screen', itemId: 'loom:next', window: { id: 'w-a', seq: 3 } })).json).toMatchObject({ applied: true });
    // A newer move that failed (its scene is gone) didn't happen: the older one landing after it still applies.
    expect((await present({ view: 'screen', by: 'screen', sceneId: 'gone', window: { id: 'w-c', seq: 2 } })).status).toBe(404);
    expect((await present({ view: 'active', by: 'screen', window: { id: 'w-c', seq: 1 } })).json).toMatchObject({ applied: true });
    // Without a window (an older page, the operator): as before.
    expect((await present({ view: 'active', by: 'screen' })).json).toMatchObject({ applied: true });
  });
});

describe('transitions', () => {
  it('tapping a card opens its conversation; that conversation\'s agent staging takes the screen', async () => {
    const tapped = await present({ view: 'conversation', by: 'screen', itemId: 'discord:thread:t-7' });
    expect(tapped.json).toMatchObject({ applied: true, presentation: { view: 'conversation', itemId: 'discord:thread:t-7', conversationKey: 'thread:t-7', screenAvailable: false } });
    // Starting a conversation is not a manual selection: the agent's scene still takes the screen.
    expect(tapped.json.presentation.manual).toBe(false);
    const scene = await stage('juliet', 'ferry', 't-7');
    expect(await presentation()).toMatchObject({ view: 'screen', sceneId: scene.sceneId, itemId: 'discord:thread:t-7', by: 'agent', screenAvailable: true });
  });

  it('the Screen view is unavailable with no scene for the conversation', async () => {
    await present({ view: 'conversation', by: 'director', conversationKey: 'thread:t-1' });
    await stage('sierra', 'loop', 't-other');
    const result = await present({ view: 'screen', by: 'screen' });
    expect(result.status).toBe(409);
    expect(result.json.presentation).toMatchObject({ view: 'conversation', screenAvailable: false });
  });

  it('"show the overview" is a manual selection that holds over the agent until the conversation changes', async () => {
    await present({ view: 'conversation', by: 'director', conversationKey: 'thread:t-1', reason: 'focus' });
    const first = await stage('sierra', 'loop', 't-1');
    expect((await presentation()).view).toBe('screen');
    const overview = await present({ view: 'conversation', by: 'screen' });
    expect(overview.json.presentation).toMatchObject({ view: 'conversation', manual: true, screenAvailable: true });
    // The agent restages and stages another slot: the owner's choice holds.
    await stage('sierra', 'loop', 't-1');
    const second = await stage('sierra', 'detail', 't-1');
    expect(second.showing).toBe(false);
    expect(await presentation()).toMatchObject({ view: 'conversation', manual: true, queue: [] });
    // Automatic director focus on the same conversation doesn't override it either.
    const auto = await present({ view: 'screen', by: 'director', reason: 'focus' });
    expect(auto.json).toMatchObject({ applied: false, ignored: 'manual-selection' });
    // The owner can still pick the scene (newest for the conversation when none is named).
    const picked = await present({ view: 'screen', by: 'screen' });
    expect(picked.json.presentation).toMatchObject({ view: 'screen', sceneId: second.sceneId, manual: true });
    // A different conversation resets it: the new agent's scene takes the screen.
    await present({ view: 'conversation', by: 'director', conversationKey: 'thread:t-2', reason: 'focus' });
    expect(await presentation()).toMatchObject({ view: 'conversation', manual: false, conversationKey: 'thread:t-2' });
    const other = await stage('watson', 'receipts', 't-2');
    expect(other.showing).toBe(true);
    expect(first.sceneId).toBeTruthy();
  });

  it('a manual scene pick in the current conversation holds over the agent staging something else', async () => {
    await present({ view: 'conversation', by: 'director', conversationKey: 'thread:t-1' });
    const a = await stage('sierra', 'a', 't-1');
    const b = await stage('sierra', 'b', 't-1');
    expect((await presentation()).sceneId).toBe(b.sceneId);
    await present({ view: 'screen', by: 'screen', sceneId: a.sceneId });
    const c = await stage('sierra', 'c', 't-1');
    expect(c.showing).toBe(false);
    expect(await presentation()).toMatchObject({ view: 'screen', sceneId: a.sceneId, manual: true });
  });

  it('other agents\' scenes queue and never take over; with no director the board offers queue[0] after the conversation ends', async () => {
    const screen = new RecordingSink();
    hub.addScreen('desk', screen);
    const director = hub.addDirector(new RecordingSink());
    await present({ view: 'conversation', by: 'director', conversationKey: 'thread:t-1' });
    const mine = await stage('sierra', 'loop', 't-1');
    const shows = screen.all('show').length;
    const queued = await stage('victor', 'deploy', 't-9');
    const urgent = await stage('juliet', 'ferry', 't-8', { urgent: true });
    expect(queued.showing).toBe(false);
    expect(urgent.showing).toBe(false);
    expect(screen.all('show')).toHaveLength(shows);
    expect(await presentation()).toMatchObject({ view: 'screen', sceneId: mine.sceneId, queue: [queued.sceneId, urgent.sceneId] });
    // Re-staging a queued scene keeps its place.
    await stage('victor', 'deploy', 't-9');
    expect((await presentation()).queue).toEqual([queued.sceneId, urgent.sceneId]);
    // The operator hangs up, then the conversation is left: back to the board, the queue is offered ("Up next"), not shown.
    hub.removeDirector(director);
    const idle = await present({ view: 'active', by: 'director', reason: 'idle' });
    expect(idle.json.presentation).toMatchObject({ view: 'active', conversationKey: null, sceneId: null, queue: [queued.sceneId, urgent.sceneId], reason: 'idle' });
    expect(idle.json.presentation.upNext).toMatchObject({ sceneId: queued.sceneId, agentId: 'victor', conversationKey: 'thread:t-9' });
    expect(screen.last('show')).toEqual({ scene: null });
    // The owner calls on the queued one: it shows and leaves the queue.
    await present({ view: 'screen', by: 'screen', sceneId: queued.sceneId });
    expect(await presentation()).toMatchObject({ view: 'screen', sceneId: queued.sceneId, conversationKey: 'thread:t-9', queue: [urgent.sceneId] });
    // A cleared queued scene leaves the queue.
    await request('DELETE', `/api/scenes/${urgent.sceneId}`);
    expect((await presentation()).queue).toEqual([]);
  });

  it('people at a table take turns: with a director connected, the end of a conversation shows queue[0] and makes its conversation current', async () => {
    hub.setItemResolver((key) => (key === 'thread:t-9' ? 'discord:thread:t-9' : null));
    hub.addDirector(new RecordingSink());
    await present({ view: 'conversation', by: 'director', conversationKey: 'thread:t-1' });
    const queued = await stage('victor', 'deploy', 't-9');
    const second = await stage('juliet', 'ferry', 't-8');
    const ended = await present({ view: 'active', by: 'director', reason: 'idle' });
    expect(ended.json.presentation).toMatchObject({ view: 'screen', sceneId: queued.sceneId, conversationKey: 'thread:t-9', itemId: 'discord:thread:t-9', queue: [second.sceneId], manual: false });
    // The owner pressing Esc is not "the conversation ended": it goes to the board.
    await present({ view: 'active', by: 'screen' });
    expect(await presentation()).toMatchObject({ view: 'active', queue: [second.sceneId] });
  });

  it('opening a conversation takes its own scenes out of the queue (they are in its Screen switcher)', async () => {
    hub.addDirector(new RecordingSink());
    const queued = await stage('victor', 'deploy', 't-9');
    expect((await presentation()).queue).toEqual([queued.sceneId]);
    await present({ view: 'conversation', by: 'director', conversationKey: 'thread:t-9' });
    expect(await presentation()).toMatchObject({ view: 'conversation', queue: [], screenAvailable: true });
  });

  it('starting a different conversation keeps the previous one in history for back', async () => {
    await present({ view: 'conversation', by: 'director', conversationKey: 'thread:t-1' });
    const loop = await stage('sierra', 'loop', 't-1');
    await present({ view: 'conversation', by: 'director', conversationKey: 'thread:t-2' });
    expect(await presentation()).toMatchObject({ view: 'conversation', conversationKey: 'thread:t-2' });
    const back = await post('/api/back');
    expect(back.json.showing.id).toBe(loop.sceneId);
    expect(await presentation()).toMatchObject({ view: 'screen', conversationKey: 'thread:t-1', sceneId: loop.sceneId });
    // Back again: the conversation's overview, then the board.
    await post('/api/back');
    expect(await presentation()).toMatchObject({ view: 'conversation', conversationKey: 'thread:t-1' });
    await post('/api/back');
    expect(await presentation()).toMatchObject({ view: 'active' });
  });

  it('maps the old show/dashboard endpoints onto the presentation', async () => {
    const scene = await stage('malibu', 'macros', 't-3');
    // The operator's own focus (no reason, or 'focus') is not the owner's pick...
    expect((await post('/api/show', { sceneId: scene.sceneId })).json.showing.id).toBe(scene.sceneId);
    expect(await presentation()).toMatchObject({ view: 'screen', sceneId: scene.sceneId, conversationKey: 'thread:t-3', by: 'director', manual: false });
    await post('/api/show', { sceneId: scene.sceneId, reason: 'focus' });
    expect((await presentation()).manual).toBe(false);
    // ...a show the owner asked for is.
    await post('/api/show', { sceneId: scene.sceneId, reason: 'user' });
    expect(await presentation()).toMatchObject({ manual: true, reason: 'user' });
    expect((await post('/api/show', { agentId: 'malibu', by: 'screen' })).json.showing.id).toBe(scene.sceneId);
    expect((await presentation()).by).toBe('screen');
    expect((await post('/api/show', { dashboard: true })).json).toEqual({ showing: null });
    expect(await presentation()).toMatchObject({ view: 'active', sceneId: null, manual: false });
  });

  it('a cleared scene drops back to its conversation when there is an item, else the board', async () => {
    await present({ view: 'conversation', by: 'screen', itemId: 'discord:thread:t-4' });
    const scene = await stage('foxtrot', 'x', 't-4');
    expect((await presentation()).view).toBe('screen');
    await request('DELETE', `/api/scenes/${scene.sceneId}`);
    expect(await presentation()).toMatchObject({ view: 'conversation', conversationKey: 'thread:t-4', screenAvailable: false });
  });

  it('agents can ask for the screen only in the current conversation', async () => {
    await present({ view: 'conversation', by: 'director', conversationKey: 'thread:t-1' });
    const other = store.stage({ agentId: 'victor', kind: 'html', body: '<p></p>', summary: 's', origin: { threadId: 't-9' } }).scene;
    const asked = await present({ view: 'screen', by: 'agent', sceneId: other.id });
    expect(asked.json).toMatchObject({ applied: false, queued: true, presentation: { view: 'conversation', queue: [other.id] } });
    expect((await present({ view: 'active', by: 'agent' })).json.applied).toBe(false);
    const mine = store.stage({ agentId: 'sierra', kind: 'html', body: '<p></p>', summary: 's', origin: { threadId: 't-1' } }).scene;
    expect((await present({ view: 'screen', by: 'agent', sceneId: mine.id })).json).toMatchObject({ applied: true, presentation: { view: 'screen', sceneId: mine.id } });
  });

  it('still puts an urgent scene up when nobody is directing and the board is showing', async () => {
    const urgent = await stage('victor', 'deploy', 't-9', { urgent: true });
    expect(urgent.showing).toBe(true);
    expect(await presentation()).toMatchObject({ view: 'screen', sceneId: urgent.sceneId, by: 'system', reason: 'urgent', manual: false });
  });
});

describe('restart', () => {
  it('restores view, conversation, scene, queue and manual selection', async () => {
    hub.addDirector(new RecordingSink());
    await present({ view: 'conversation', by: 'director', itemId: 'discord:thread:t-1' });
    const mine = await stage('sierra', 'loop', 't-1');
    const queued = await stage('victor', 'deploy', 't-9');
    await present({ view: 'screen', by: 'screen', sceneId: mine.sceneId });
    const before = await presentation();
    hub.close();
    hub = makeHub();
    const after = await presentation();
    expect(after).toEqual(before);
    expect(after).toMatchObject({ view: 'screen', sceneId: mine.sceneId, itemId: 'discord:thread:t-1', queue: [queued.sceneId], manual: true });
    expect(hub.showingScene()?.id).toBe(mine.sceneId);
  });

  it('an input stuck mid-route for over 5 minutes is failed on start, never replayed', async () => {
    const scene = await stage('sierra', 'loop', 't-1');
    store.claimInput({ sceneId: scene.sceneId, agentId: 'sierra', type: 'choice', data: {}, conversationKey: 'thread:t-1', commandId: 'stuck-1' });
    store.claimInput({ sceneId: scene.sceneId, agentId: 'sierra', type: 'choice', data: {}, conversationKey: 'thread:t-1', commandId: 'recent-1' });
    store.db.prepare("UPDATE events SET updated_at = ? WHERE command_id = 'stuck-1'").run(clock - 6 * 60_000);
    hub.close();
    vi.useFakeTimers();
    hub = makeHub({ ackMs: 1_000 });
    expect(store.inputByCommand('stuck-1')).toMatchObject({ status: 'failed', routed: 'failed:interrupted' });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(routes.map((route) => route.input.commandId)).toEqual(['recent-1']);
  });

  it('drops scenes that expired while it was down', async () => {
    await present({ view: 'conversation', by: 'director', conversationKey: 'thread:t-1' });
    const mine = await stage('sierra', 'loop', 't-1', { ttlMinutes: 1 });
    expect((await presentation()).sceneId).toBe(mine.sceneId);
    hub.close();
    clock += 2 * 60_000;
    store.sweep();
    hub = makeHub();
    expect(await presentation()).toMatchObject({ view: 'conversation', conversationKey: 'thread:t-1', sceneId: null });
  });
});

describe('server-side idle return', () => {
  it('with no director, marks the presentation idle after the grace period; it stays where it is', async () => {
    vi.useFakeTimers();
    hub.close();
    hub = makeHub({ graceMs: 10 * 60_000 });
    const laptop = new RecordingSink();
    const test = new RecordingSink();
    hub.addScreen('laptop', laptop);
    hub.addScreen('claude-check', test, 'screen', { detached: true });
    await present({ view: 'conversation', by: 'screen', itemId: 'discord:thread:t-1' });
    vi.advanceTimersByTime(9 * 60_000);
    // A tap is interaction: the clock starts over.
    hub.command('scroll_down');
    vi.advanceTimersByTime(9 * 60_000);
    expect((await presentation()).stageIdle).toBeUndefined();
    vi.advanceTimersByTime(2 * 60_000);
    // Every (owner) window hears it with the presentation; only Screen windows act on it (main.js).
    expect(await presentation()).toMatchObject({ view: 'conversation', conversationKey: 'thread:t-1', stageIdle: true });
    expect(laptop.last('presentation')).toMatchObject({ view: 'conversation', stageIdle: true });
    expect(test.all('presentation')).toEqual([]);
    // A Screen window that joins now gets it in its hello.
    const wall = new RecordingSink();
    hub.addScreen('wall', wall, 'screen');
    expect(wall.last('hello').presentation).toMatchObject({ stageIdle: true });

    // It survives a restart (Codex review on #778).
    hub.close();
    hub = makeHub({ graceMs: 10 * 60_000 });
    expect(await presentation()).toMatchObject({ view: 'conversation', stageIdle: true });

    // The next move ends it.
    await present({ view: 'active', by: 'screen' });
    expect((await presentation()).stageIdle).toBeUndefined();
  });

  it('leaves the idle return to a connected director', async () => {
    vi.useFakeTimers();
    hub.close();
    hub = makeHub({ graceMs: 10 * 60_000 });
    const director = hub.addDirector(new RecordingSink());
    await present({ view: 'conversation', by: 'director', conversationKey: 'thread:t-1' });
    vi.advanceTimersByTime(30 * 60_000);
    expect((await presentation()).stageIdle).toBeUndefined();
    hub.removeDirector(director);
    vi.advanceTimersByTime(10 * 60_000 + 1);
    expect(await presentation()).toMatchObject({ view: 'conversation', stageIdle: true });
  });
});

describe('input routing', () => {
  it('carries the scene\'s conversation to the director', async () => {
    const director = new RecordingSink();
    hub.addDirector(director);
    const scene = await stage('sierra', 'loop', 't-1', { choices: ['FR-14', 'Drop it'] });
    const result = await post('/api/input', { sceneId: scene.sceneId, type: 'choice', data: { choiceId: 'a' }, commandId: 'cmd-1' });
    expect(result.json).toEqual({ routed: 'operator', commandId: 'cmd-1', status: 'delivered' });
    expect(director.last('input')).toMatchObject({
      commandId: 'cmd-1',
      conversationKey: 'thread:t-1',
      threadId: 't-1',
      channelId: 'home-sierra',
      scene: { id: scene.sceneId, conversationKey: 'thread:t-1' },
    });
  });

  it('generates a command id when the client sends none, and records it', async () => {
    const scene = await stage('sierra', 'loop', 't-1');
    const result = await post('/api/input', { sceneId: scene.sceneId, type: 'emit', data: {} });
    expect(result.json.commandId).toMatch(/[0-9a-f-]{36}/);
    expect(store.inputByCommand(result.json.commandId)).toMatchObject({ sceneId: scene.sceneId, conversationKey: 'thread:t-1', status: 'delivered', routed: 'agent' });
  });

  it('repeats of one command id route once and return the first outcome', async () => {
    const scene = await stage('sierra', 'loop', 't-1', { choices: ['A', 'B'] });
    const body = { sceneId: scene.sceneId, type: 'choice', data: { choiceId: 'b' }, commandId: 'tap-42' };
    const first = await post('/api/input', body);
    const second = await post('/api/input', body);
    expect(first.json).toEqual({ routed: 'agent', commandId: 'tap-42', status: 'delivered' });
    expect(second.json).toEqual({ routed: 'agent', commandId: 'tap-42', status: 'delivered', duplicate: true });
    expect(routes).toHaveLength(1);
    const rows = store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE command_id = 'tap-42'").get() as { n: number };
    expect(rows.n).toBe(1);
    // The same id on another scene is a client bug, not a repeat.
    const other = await stage('victor', 'deploy', 't-9');
    expect((await post('/api/input', { ...body, sceneId: other.sceneId })).status).toBe(409);
  });

  it('records a failed bot delivery as failed', async () => {
    fallbackResult = 'failed:bot HTTP 422';
    const scene = await stage('sierra', 'loop', 't-1');
    const result = await post('/api/input', { sceneId: scene.sceneId, type: 'emit', data: {}, commandId: 'c-fail' });
    expect(result.json).toMatchObject({ routed: 'failed:bot HTTP 422', status: 'failed' });
  });

  it('rejects input on an unknown scene', async () => {
    expect((await post('/api/input', { sceneId: 'nope', type: 'emit' })).status).toBe(404);
  });

  describe('with an acknowledging director', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      hub.close();
      hub = makeHub({ ackMs: 10_000 });
    });

    it('is pending until the director acks, then acknowledged (no fallback)', async () => {
      const director = new RecordingSink();
      hub.addDirector(director, { acks: true });
      const scene = await stage('sierra', 'loop', 't-1');
      const result = await post('/api/input', { sceneId: scene.sceneId, type: 'choice', data: { choiceId: 'a' }, commandId: 'ack-1' });
      expect(result.json).toEqual({ routed: 'operator', commandId: 'ack-1', status: 'pending' });
      expect(director.last('input')).toMatchObject({ commandId: 'ack-1', ackWithinMs: 10_000 });
      const ack = await post('/api/input/ack-1/ack');
      expect(ack.json).toEqual({ commandId: 'ack-1', status: 'acknowledged', routed: 'operator' });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(routes).toHaveLength(0);
      expect(store.inputByCommand('ack-1')!.status).toBe('acknowledged');
      expect((await post('/api/input/unknown/ack')).status).toBe(404);
    });

    it('falls back to the bot with the scene\'s thread after 10 s without an ack', async () => {
      const director = new RecordingSink();
      const screen = new RecordingSink();
      hub.addDirector(director, { acks: true });
      hub.addScreen('desk', screen);
      const scene = await stage('sierra', 'loop', 't-1', { choices: ['FR-14'] });
      await post('/api/input', { sceneId: scene.sceneId, type: 'choice', data: { choiceId: 'a' }, commandId: 'lost-1' });
      await vi.advanceTimersByTimeAsync(9_000);
      expect(routes).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(routes).toHaveLength(1);
      expect(routes[0]!.scene.origin).toMatchObject({ threadId: 't-1', channelId: 'home-sierra' });
      expect(routes[0]!.input).toMatchObject({ commandId: 'lost-1', conversationKey: 'thread:t-1', type: 'choice', data: { choiceId: 'a' } });
      expect(store.inputByCommand('lost-1')).toMatchObject({ status: 'fallback', routed: 'agent' });
      expect(director.last('input-fallback')).toMatchObject({ commandId: 'lost-1', status: 'fallback' });
      expect(screen.last('ack')).toMatchObject({ commandId: 'lost-1', fallback: true, label: 'FR-14' });
      // A late ack doesn't count as a second delivery.
      expect((await post('/api/input/lost-1/ack')).json).toMatchObject({ status: 'fallback', late: true });
    });

    it('an operator that does not ack (legacy) is trusted as delivered', async () => {
      hub.addDirector(new RecordingSink());
      const scene = await stage('sierra', 'loop', 't-1');
      expect((await post('/api/input', { sceneId: scene.sceneId, type: 'emit', data: {}, commandId: 'legacy-1' })).json.status).toBe('delivered');
      await vi.advanceTimersByTimeAsync(20_000);
      expect(routes).toHaveLength(0);
    });

    it('a pending input survives a restart and still falls back', async () => {
      hub.addDirector(new RecordingSink(), { acks: true });
      const scene = await stage('sierra', 'loop', 't-1');
      await post('/api/input', { sceneId: scene.sceneId, type: 'emit', data: {}, commandId: 'restart-1' });
      hub.close();
      clock += 4_000;
      hub = makeHub({ ackMs: 10_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(routes).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(routes.map((route) => route.input.commandId)).toEqual(['restart-1']);
    });
  });
});

describe('acceptance scenarios (server parts)', () => {
  it('1. two tasks for one agent in two threads: scenes and taps stay in their own conversation', async () => {
    const a = await stage('watson', 'main', 't-a', { choices: ['Approve'] });
    const b = await stage('watson', 'main', 't-b', { choices: ['Approve'] });
    expect(a.sceneId).not.toBe(b.sceneId);
    await post('/api/input', { sceneId: b.sceneId, type: 'choice', data: { choiceId: 'a' }, commandId: 's1-b' });
    await post('/api/input', { sceneId: a.sceneId, type: 'choice', data: { choiceId: 'a' }, commandId: 's1-a' });
    expect(routes.map((route) => [route.input.commandId, route.scene.origin.threadId, route.input.conversationKey])).toEqual([
      ['s1-b', 't-b', 'thread:t-b'],
      ['s1-a', 't-a', 'thread:t-a'],
    ]);
    // Re-staging one conversation's slot leaves the other's alone.
    await stage('watson', 'main', 't-a', { summary: 'updated' });
    expect(store.get(b.sceneId)!.summary).toBe('watson main');
  });

  it("4. an agent stages a scene while another agent's conversation is on screen: it queues", async () => {
    hub.addDirector(new RecordingSink());
    await present({ view: 'conversation', by: 'director', conversationKey: 'thread:sierra-1' });
    const sierra = await stage('sierra', 'loop', 'sierra-1');
    const victor = await stage('victor', 'deploy', 'victor-1');
    expect(victor.showing).toBe(false);
    expect(await presentation()).toMatchObject({ view: 'screen', sceneId: sierra.sceneId, queue: [victor.sceneId] });
  });

  it('12. talking to an agent opens its Conversation view; its scene takes the Screen view; ⎋ returns to the board', async () => {
    const screen = new RecordingSink();
    hub.addScreen('desk', screen);
    hub.addDirector(new RecordingSink());
    await present({ view: 'conversation', by: 'director', itemId: 'discord:thread:t-12', reason: 'focus' });
    expect(screen.last('presentation')).toMatchObject({ view: 'conversation', itemId: 'discord:thread:t-12' });
    const scene = await stage('sierra', 'loop', 't-12');
    expect(screen.last('presentation')).toMatchObject({ view: 'screen', sceneId: scene.sceneId });
    expect(screen.last('show').scene.id).toBe(scene.sceneId);
    await present({ view: 'active', by: 'screen', reason: 'escape' });
    expect(screen.last('presentation')).toMatchObject({ view: 'active', conversationKey: null });
    expect(screen.last('show')).toEqual({ scene: null });
  });
});

describe('the List, for voice', () => {
  const page = (tab: string, rows: string[] = []) => ({
    tab: { id: tab, name: tab[0]!.toUpperCase() + tab.slice(1) },
    tabs: [{ id: 'active', name: 'Active', count: 2 }, { id: 'watching', name: 'Watching', count: 1 }],
    project: null,
    projects: [{ id: 'garden-k1', name: 'Garden shed' }],
    rows: rows.map((title, i) => ({ kind: 'item', id: `loom:${i}`, title, where: 'acme' })),
  });

  it('keeps the List of the screen touched last, tells the operator, and drops a screen that leaves', async () => {
    const wall = hub.addScreen('wall', new RecordingSink());
    const laptop = hub.addScreen('laptop', new RecordingSink());
    const director = new RecordingSink();
    hub.addDirector(director);
    expect((await post(`/api/screens/${wall}/list`, { page: page('active', ['One', 'Two']), touchedAt: 100 })).json).toEqual({ ok: true });
    await post(`/api/screens/${laptop}/list`, { page: page('watching', ['Three']), touchedAt: 900 });
    // The wall reports again later, but the laptop was touched more recently: its List is the one.
    await post(`/api/screens/${wall}/list`, { page: page('active', ['One', 'Two', 'Four']), touchedAt: 100 });
    expect(hub.listPage()?.tab.id).toBe('watching');
    expect(director.last('list-page')).toMatchObject({ page: { tab: { id: 'watching' }, rows: [{ title: 'Three' }] } });
    expect(hub.status().listPage?.tab.id).toBe('watching');
    hub.removeScreen(laptop);
    expect(hub.listPage()?.rows.map((row) => row.title)).toEqual(['One', 'Two', 'Four']);
  });

  it('refuses a malformed List and an unknown screen', async () => {
    const wall = hub.addScreen('wall', new RecordingSink());
    expect((await post(`/api/screens/${wall}/list`, { page: { rows: [] } })).status).toBe(400);
    expect((await post('/api/screens/s99/list', { page: page('active') })).status).toBe(404);
  });

  it('broadcasts additive place and back commands even with a conversation up', async () => {
    const screen = new RecordingSink();
    hub.addScreen('desk', screen);
    await present({ view: 'conversation', by: 'screen', conversationKey: 'loom:thread-a' });
    for (const args of [{ page: 'projects' }, { page: 'agents' }, { page: 'agent', id: 'sierra' }]) {
      expect(hub.command('list_place', args)).toBe(true);
      expect(screen.last('command')).toEqual({ sceneId: null, name: 'list_place', args });
    }
    expect(hub.command('list_back')).toBe(true);
    expect(screen.last('command')).toEqual({ sceneId: null, name: 'list_back', args: {} });
  });

  it('list_tab and list_project go to every screen, whatever view is up', async () => {
    const screen = new RecordingSink();
    hub.addScreen('desk', screen);
    await present({ view: 'conversation', by: 'screen', conversationKey: 'loom:thread-a' });
    expect((await post('/api/command', { name: 'list_tab', args: { tab: 'watching' } })).json).toMatchObject({ sent: true });
    expect(screen.last('command')).toEqual({ sceneId: null, name: 'list_tab', args: { tab: 'watching' } });
    await post('/api/command', { name: 'list_project', args: { project: null } });
    expect(screen.last('command')).toEqual({ sceneId: null, name: 'list_project', args: { project: null } });
  });
});

describe('the List when its screen leaves', () => {
  it('tells the operator the fallback List, or none', async () => {
    const page = { tab: { id: 'active', name: 'Active' }, tabs: [], project: null, projects: [], rows: [] };
    const wall = hub.addScreen('wall', new RecordingSink());
    const laptop = hub.addScreen('laptop', new RecordingSink());
    const director = new RecordingSink();
    hub.addDirector(director);
    await post(`/api/screens/${wall}/list`, { page, touchedAt: 1 });
    await post(`/api/screens/${laptop}/list`, { page: { ...page, tab: { id: 'watching', name: 'Watching' } }, touchedAt: 2 });
    hub.removeScreen(laptop);
    expect(director.last('list-page')).toMatchObject({ page: { tab: { id: 'active' } } });
    hub.removeScreen(wall);
    expect(director.last('list-page')).toEqual({ page: null });
  });
});

describe('window roles', () => {
  it('keeps each window’s role, lists them on the dashboard, and tells a window when another changes it', async () => {
    const laptop = new RecordingSink();
    const wall = new RecordingSink();
    const laptopId = hub.addScreen('laptop', laptop);
    const wallId = hub.addScreen('wall', wall, 'control');
    expect(laptop.last('hello')).toMatchObject({ screenId: laptopId, role: 'full' });
    expect(wall.last('hello')).toMatchObject({ screenId: wallId, role: 'control' });
    expect(laptop.last('dashboard').windows).toEqual([
      { id: laptopId, name: 'laptop', role: 'full', feedScope: 'everything' },
      { id: wallId, name: 'wall', role: 'control', feedScope: 'everything' },
    ]);

    // From the laptop's Settings: the wall becomes a Screen window.
    expect((await post(`/api/screens/${wallId}/role`, { role: 'screen' })).json).toEqual({ ok: true, role: 'screen' });
    expect(wall.last('role')).toEqual({ role: 'screen' });
    expect(laptop.all('role')).toEqual([]);
    expect(laptop.last('dashboard').windows[1]).toMatchObject({ id: wallId, role: 'screen' });
    expect(hub.status().screens.map((s) => s.role)).toEqual(['full', 'screen']);
  });

  it('refuses an unknown role or window', async () => {
    const id = hub.addScreen('desk', new RecordingSink());
    expect((await post(`/api/screens/${id}/role`, { role: 'kiosk' })).status).toBe(400);
    expect((await post('/api/screens/s99/role', { role: 'screen' })).status).toBe(404);
  });

  it('the stream connects a window with the role in its address', async () => {
    const controller = new AbortController();
    const response = await app().request('/stream?name=wall&role=screen', { signal: controller.signal });
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('"role":"screen"');
    expect(hub.screenList()).toMatchObject([{ name: 'wall', role: 'screen' }]);
    controller.abort();
    await reader.cancel().catch(() => {});
  });

  it('the dashboard carries the live scene ids, so a Screen window lets a cleared one go', async () => {
    const sink = new RecordingSink();
    hub.addScreen('wall', sink, 'screen');
    const scene = await stage('watson', 'plan', 'thread-a');
    expect(sink.last('dashboard').liveSceneIds).toContain(scene.sceneId);
    expect((await request('DELETE', `/api/scenes/${scene.sceneId}`)).status).toBe(200);
    expect(sink.last('dashboard').liveSceneIds).not.toContain(scene.sceneId);
  });
});

describe('window roles, what a Screen window holds', () => {
  it('drops a window’s List when it becomes a Screen window, and refuses its later reports', async () => {
    const page = { tab: { id: 'active', name: 'Active' }, tabs: [], project: null, projects: [], rows: [] };
    const wall = hub.addScreen('wall', new RecordingSink());
    const laptop = hub.addScreen('laptop', new RecordingSink());
    const director = new RecordingSink();
    hub.addDirector(director);
    await post(`/api/screens/${laptop}/list`, { page, touchedAt: 1 });
    await post(`/api/screens/${wall}/list`, { page: { ...page, tab: { id: 'watching', name: 'Watching' } }, touchedAt: 2 });
    await post(`/api/screens/${wall}/role`, { role: 'screen' });
    expect(hub.listPage()?.tab.id).toBe('active');
    expect(director.last('list-page')).toMatchObject({ page: { tab: { id: 'active' } } });
    expect((await post(`/api/screens/${wall}/list`, { page, touchedAt: 3 })).status).toBe(404);
  });

  it('keeps sending state and new versions of a scene the desk moved on from', async () => {
    const wall = new RecordingSink();
    hub.addScreen('wall', wall, 'screen');
    await present({ view: 'conversation', by: 'screen', conversationKey: 'thread:t-held' });
    const scene = await stage('sierra', 'loop', 't-held');
    await present({ view: 'conversation', by: 'screen', conversationKey: 'thread:t-other' });
    hub.stateChanged({ ...store.get(scene.sceneId)!, state: { step: 2 } });
    expect(wall.last('state')).toEqual({ sceneId: scene.sceneId, state: { step: 2 } });
    await stage('sierra', 'loop', 't-held');
    expect(wall.last('scene')).toMatchObject({ scene: { id: scene.sceneId, version: 2 }, updated: true });
  });
});

describe('window roles, voice commands', () => {
  it('a scene command is not delivered when only control windows are connected', async () => {
    hub.addScreen('desk-left', new RecordingSink(), 'control');
    await present({ view: 'conversation', by: 'screen', conversationKey: 'thread:t-cmd' });
    await stage('sierra', 'loop', 't-cmd');
    expect((await post('/api/command', { name: 'play' })).json).toMatchObject({ sent: false, delivered: false });
    // The List still moves on a control window.
    expect((await post('/api/command', { name: 'list_tab', args: { tab: 'watching' } })).json).toMatchObject({ sent: true });
    hub.addScreen('desk-right', new RecordingSink(), 'screen');
    expect((await post('/api/command', { name: 'play' })).json).toMatchObject({ sent: true });
  });
});

describe('detached windows (?detached=1: an agent testing on the real desk)', () => {
  const detachedPost = async (pathname: string, body: Record<string, unknown> = {}) => {
    const response = await app().request(pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Desk-Window': 'detached' },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as any };
  };

  it('neither follows the owner’s moves nor counts among his windows', async () => {
    const laptop = new RecordingSink();
    const test = new RecordingSink();
    const laptopId = hub.addScreen('laptop', laptop);
    hub.addScreen('claude-check', test, 'full', { detached: true });
    expect(test.last('hello')).toMatchObject({ detached: true });
    expect(test.last('hello').presentation).toBeUndefined();
    expect(laptop.last('dashboard')).toMatchObject({ screens: 1, windows: [{ id: laptopId, name: 'laptop', role: 'full' }] });
    expect(hub.status().screens.map((s) => s.name)).toEqual(['laptop']);

    await present({ view: 'conversation', by: 'screen', itemId: 'loom:next' });
    expect(laptop.last('presentation')).toMatchObject({ view: 'conversation', itemId: 'loom:next' });
    expect(test.all('presentation')).toEqual([]);

    // Voice's commands are for the owner's windows only.
    expect(hub.command('list_tab', { tab: 'watching' })).toBe(true);
    expect(laptop.last('command')).toMatchObject({ name: 'list_tab' });
    expect(test.all('command')).toEqual([]);
  });

  it('with only detached windows connected, voice has no window to command', () => {
    hub.addScreen('claude-check', new RecordingSink(), 'full', { detached: true });
    expect(hub.command('list_tab', { tab: 'watching' })).toBe(false);
  });

  it('can’t move the desk, re-role a window, report a List or presence, or mark an item viewed', async () => {
    const laptopId = hub.addScreen('laptop', new RecordingSink());
    const testId = hub.addScreen('claude-check', new RecordingSink(), 'full', { detached: true });
    expect((await detachedPost('/api/desk/presentation', { view: 'conversation', by: 'screen', itemId: 'loom:next' })).status).toBe(403);
    expect(await presentation()).toMatchObject({ view: 'active' });
    expect((await detachedPost(`/api/screens/${laptopId}/role`, { role: 'screen' })).status).toBe(403);
    expect(hub.status().screens[0]).toMatchObject({ id: laptopId, role: 'full' });
    expect((await detachedPost(`/api/screens/${testId}/list`, { page: { rows: [] }, touchedAt: 1 })).status).toBe(403);
    expect((await detachedPost('/api/desk/presence')).status).toBe(403);
    expect((await detachedPost('/api/desk/commands', { commandId: 'c-1', type: 'viewed', itemId: 'loom:next' })).status).toBe(403);
    // Another window can't re-role a detached one either.
    expect((await post(`/api/screens/${testId}/role`, { role: 'screen' })).status).toBe(404);
    // Reads still work.
    const read = await app().request('/api/desk/presentation', { headers: { 'X-Desk-Window': 'detached' } });
    expect(read.status).toBe(200);
  });

  it('the stream connects a detached window from its address', async () => {
    const controller = new AbortController();
    const response = await app().request('/stream?name=claude-check&detached=1', { signal: controller.signal });
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('"detached":true');
    expect(hub.status().screens).toEqual([]);
    controller.abort();
  });
});

describe('which window moved the desk', () => {
  it('logs and traces the window’s id, name and screen with each move', async () => {
    const logged: Array<{ event: string; data?: Record<string, unknown> }> = [];
    hub.close();
    hub = new Hub(store, async () => 'agent', (event, data) => logged.push({ event, data }), () => clock);
    await present({ view: 'conversation', by: 'screen', itemId: 'loom:next', window: { id: 'w-a', seq: 1, name: 'nav-check', screenId: 's4' } });
    expect(logged.find((entry) => entry.event === 'presentation')?.data).toMatchObject({ view: 'conversation', window: { id: 'w-a', name: 'nav-check', screenId: 's4' } });
    await present({ view: 'active', by: 'screen' });
    expect(logged.filter((entry) => entry.event === 'presentation').at(-1)?.data?.window).toBeUndefined();
  });
});
