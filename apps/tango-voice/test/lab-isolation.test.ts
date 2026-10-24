import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SimulatedAgentBackend } from '../src/live/agent-backend.js';
import { HttpDeskClient, type DeskClient } from '../src/live/desk-client.js';
import type { LiveSessionClient } from '../src/live/gpt-live-client.js';
import { LivePlaybackClock, SpeechActivity } from '../src/live/live-audio.js';
import { LiveOperator } from '../src/live/live-operator.js';
import type { ListPage, ScreenDirector } from '../src/live/screen-director.js';
import { LabDesk, LabScreen, labFenceVerdict, type LabListState } from '../src/testing/lab-isolation.js';
import { deskItem, FakeClient } from './desk-fakes.js';

const SCRATCH = new Set(['loom:scratch', 'project:kumquat']);

describe('labFenceVerdict', () => {
  const verdict = (method: string, path: string, body?: unknown) => labFenceVerdict({ method, path, body }, SCRATCH);

  it('never lets the lab hold the director link or the operator desk stream', () => {
    expect(verdict('GET', '/director/stream?ack=1')).toMatch(/director link/);
    expect(verdict('GET', '/api/desk/stream?client=operator')).toMatch(/owner’s taps/);
    expect(verdict('GET', '/api/desk/stream?client=lab')).toBeNull();
    expect(verdict('GET', '/api/desk/items/loom:real')).toBeNull();
  });

  it('allows writes on scratch items only', () => {
    expect(verdict('POST', '/api/desk/commands', { type: 'pin', itemId: 'loom:scratch' })).toBeNull();
    expect(verdict('POST', '/api/desk/commands', { type: 'pin', itemId: 'loom:real' })).toMatch(/loom:real/);
    expect(verdict('POST', '/api/desk/commands', { type: 'sweep' })).toMatch(/no item/);
    expect(verdict('POST', '/api/desk/capacity/move', { itemId: 'loom:real' })).toMatch(/move/);
    expect(verdict('POST', '/api/desk/projects/kumquat/action', { action: 'park' })).toBeNull();
    expect(verdict('POST', '/api/desk/projects/real/action', { action: 'park' })).toMatch(/project action/);
    expect(verdict('POST', '/api/desk/trace', [])).toBeNull();
    expect(verdict('POST', '/api/desk/lab-fence', {})).toBeNull();
  });

  it('refuses starts, mail, and anything that writes to the owner’s screens', () => {
    for (const path of ['/api/desk/start-work', '/api/desk/agent-threads', '/api/desk/mail/start', '/api/desk/mail']) expect(verdict('POST', path, {})).toMatch(/new thread/);
    for (const path of ['/api/desk/presentation', '/api/show', '/api/back', '/api/command', '/api/director/tasks', '/api/input/abc/ack', '/api/desk/operator', '/api/desk/draft', '/api/desk/draft/command', '/api/desk/pause']) {
      expect(verdict('POST', path, {})).toMatch(/owner’s screens/);
    }
    expect(verdict('POST', '/api/desk/settings', {})).toMatch(/not a lab write/);
  });
});

// ── a desk that does what the owner's desk does while they use it ──────────────────────────────────

interface Hit {
  method: string;
  url: string;
  body: string;
}

let server: Server | null = null;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

/** Every stream that opens hears the owner at work: their item changing, Draft and pause taps, a card tapped. */
async function ownerDesk(): Promise<{ base: string; hits: Hit[] }> {
  const hits: Hit[] = [];
  const items = [deskItem('loom:scratch', 'loom', { place: 'tango · scratch' }), deskItem('loom:owner', 'loom', { place: 'tango · the owner’s real thread' })];
  const json = (res: ServerResponse, body: unknown) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = req.url ?? '';
      hits.push({ method: req.method ?? 'GET', url, body });
      if (url.startsWith('/api/desk/stream')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        send('hello', { at: Date.now() });
        setTimeout(() => {
          send('item', { id: 'loom:owner', revision: 2 });
          send('item', { id: 'loom:scratch', revision: 2 });
          send('draftCommand', { action: 'cancel', draftId: 'd-owner' });
          send('pauseCommand', { action: 'resume', pauseId: 'p-owner' });
          send('presentation', { view: 'conversation', itemId: 'loom:owner', conversationKey: 'loom:owner', sceneId: null, by: 'screen', manual: true, since: Date.now() });
        }, 50);
        return;
      }
      if (url.startsWith('/director/stream')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`event: hello\ndata: ${JSON.stringify({ screens: [], operatorLive: true, showing: null, stages: [] })}\n\n`);
        return;
      }
      if (url.startsWith('/api/desk/items/')) {
        const id = decodeURIComponent(url.slice('/api/desk/items/'.length));
        return json(res, { item: items.find((item) => item.id === id) ?? null, messages: [] });
      }
      if (url.startsWith('/api/desk/items')) return json(res, { items });
      if (url.startsWith('/api/desk/settings')) return json(res, { projects: [] });
      if (url.startsWith('/api/status')) return json(res, { screens: [], operatorLive: false, showing: null, stages: [] });
      json(res, {});
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, hits };
}

const report = (state: LabListState): ListPage => ({ place: { page: state.nextRoute.page as 'inbox', name: state.nextRoute.page }, tab: { id: state.listTab, name: state.listTab }, tabs: [], project: null, projects: [], rows: [] });

function operatorOn(desk: DeskClient, screen: ScreenDirector) {
  const client = new FakeClient();
  const operator = new LiveOperator({
    client: client as unknown as LiveSessionClient,
    agents: [{ id: 'watson', name: 'Watson', role: 'assistant' }],
    backend: new SimulatedAgentBackend({}),
    extractor: async () => [{ type: 'none', reason: 'test' }],
    userActivity: new SpeechActivity(),
    playback: new LivePlaybackClock(),
    desk,
    screen,
  });
  return operator;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const traced = (hits: Hit[]) => hits.filter((hit) => hit.url === '/api/desk/trace').flatMap((hit) => JSON.parse(hit.body) as Array<{ kind: string }>).map((entry) => entry.kind);

describe('a lab session on the owner’s desk', () => {
  it('hears none of the owner’s input and writes nothing to their screens', async () => {
    const { base, hits } = await ownerDesk();
    const screen = new LabScreen({ state: { nextRoute: { page: 'inbox', view: 'ready' }, listTab: 'ready', nextPageViews: {} }, report, relay: { now: Date.now } });
    const desk = new LabDesk(base, { scratch: SCRATCH, screen }, { traceFlushMs: 10, collaborationToken: '' });
    const heard: string[] = [];
    const drafts: unknown[] = [];
    desk.onDraftCommand((command) => drafts.push(command));
    const operator = operatorOn(desk, screen as unknown as ScreenDirector);
    // What the operator's own handler sees: the lab's filter sits in front of it.
    const connect = desk.connect.bind(desk);
    desk.connect = (onItem) => connect((event) => (heard.push(event.id), onItem(event)));
    operator.start();
    await sleep(400);
    // The lab's own screen moves; the operator hears that as a director move, as the hub relays one.
    await screen.present({ view: 'conversation', itemId: 'loom:scratch', conversationKey: 'loom:scratch', reason: 'user' });
    await sleep(100);
    operator.stop();
    desk.disconnect(); // the test's wrapper above is what connected, not the operator's own handler
    await desk.flushTrace();

    const streams = hits.filter((hit) => hit.url.startsWith('/api/desk/stream'));
    expect(streams.map((hit) => hit.url)).toEqual(['/api/desk/stream?client=lab']);
    expect(hits.some((hit) => hit.url.startsWith('/director/stream'))).toBe(false);
    const writes = hits.filter((hit) => hit.method !== 'GET' && hit.url !== '/api/desk/trace').map((hit) => hit.url);
    expect(writes).toEqual([]);
    expect(heard).toEqual(['loom:scratch']);
    expect(desk.ignored.get('loom:owner')).toBe(1);
    expect(drafts).toEqual([]);
    // The owner's tap on their own thread armed nothing here.
    expect(traced(hits)).not.toContain('draft.arm');
    expect(desk.operatorUpdates).toBeGreaterThan(0);
    expect(screen.presentation()).toMatchObject({ view: 'conversation', itemId: 'loom:scratch', by: 'director' });
    // The owner's conversations are readable but never spoken unprompted.
    expect(desk.items().map((item) => [item.id, item.hidden === true])).toEqual([['loom:scratch', false], ['loom:owner', true]]);
    expect((await desk.refresh()).find((item) => item.id === 'loom:owner')?.hidden).toBe(true);
  });

  it('(control) the production wiring does hear the owner’s tap on the same desk', async () => {
    const { base, hits } = await ownerDesk();
    const desk = new HttpDeskClient(base, { traceFlushMs: 10, collaborationToken: '' });
    const screen = new LabScreen({ state: { nextRoute: { page: 'inbox', view: 'ready' }, listTab: 'ready', nextPageViews: {} }, report });
    const operator = operatorOn(desk, screen as unknown as ScreenDirector);
    operator.start();
    await sleep(400);
    operator.stop();
    await desk.flushTrace();
    expect(hits.some((hit) => hit.url === '/api/desk/stream?client=operator')).toBe(true);
    expect(hits.some((hit) => hit.method === 'POST' && hit.url === '/api/desk/operator')).toBe(true);
    expect(traced(hits)).toContain('draft.arm');
  });
});

describe('LabScreen', () => {
  it('drives its own List and tells its listeners about moves', async () => {
    const refreshed: string[] = [];
    const screen = new LabScreen({ state: { nextRoute: { page: 'inbox', view: 'ready' }, listTab: 'ready', nextPageViews: {} }, report, relay: { now: () => 42 }, refresh: async (state) => void refreshed.push(state.nextRoute.page) });
    const moves: unknown[] = [];
    const listener = (p: unknown) => moves.push(p);
    screen.onPresentation(listener);
    await screen.command('list_place', { page: 'capacity' });
    expect(screen.listPage().place).toMatchObject({ page: 'system' });
    expect(refreshed).toEqual(['inbox']);
    await screen.present({ view: 'active', reason: 'user' });
    screen.offPresentation(listener);
    await screen.present({ view: 'active', reason: 'focus' });
    expect(moves).toEqual([{ view: 'active', itemId: null, conversationKey: null, sceneId: null, reason: 'user', by: 'director', manual: true, since: 42 }]);
  });
});
