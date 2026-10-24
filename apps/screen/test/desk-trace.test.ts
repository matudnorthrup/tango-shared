import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { snowflakeAt } from '../server/discord.js';
import { DeskTrace, parseTraceTime, TRACE_KEEP_MS, type TraceInput } from '../server/desk/trace.js';
import { Hub } from '../server/hub.js';
import { SceneStore } from '../server/store.js';
import { AGENT, cid, makeHarness, msg, NOW, type Harness } from './desk-harness.js';

// The session trace: the store and its retention, what the hub and the desk core record
// (refusals included), and who may write through POST /api/desk/trace. Synthetic ids only.

const THREAD = '1500000000000000081';
const OTHER_THREAD = '1500000000000000082';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const BROWSER = { ...JSON_HEADERS, Origin: 'http://localhost', Host: 'localhost', 'Sec-Fetch-Site': 'same-origin' };

describe('trace store', () => {
  let dir: string;
  let db: DatabaseSync;
  let clock: number;
  let trace: DeskTrace;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'));
    db = new DatabaseSync(path.join(dir, 'screen.db'));
    clock = NOW;
    trace = new DeskTrace(db, () => clock);
  });
  afterEach(() => {
    trace.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('records, clips, and reads back oldest first within a window', () => {
    trace.record({ source: 'operator', kind: 'user.said', summary: 'open the speaker thread', data: { text: 'open the speaker thread' } });
    clock += 1000;
    trace.record({ source: 'hub', kind: 'presentation.changed', summary: 'board → conversation thread:1' });
    clock += 1000;
    const long = trace.record({ source: 'desk', kind: 'step.changed', summary: 'x'.repeat(1000) })!;
    expect(long.summary.length).toBeLessThanOrEqual(300);
    const all = trace.query();
    expect(all.map((entry) => entry.kind)).toEqual(['user.said', 'presentation.changed', 'step.changed']);
    expect(all[0]!.data).toEqual({ text: 'open the speaker thread' });
    expect(trace.query({ since: NOW + 500 }).map((entry) => entry.kind)).toEqual(['presentation.changed', 'step.changed']);
    expect(trace.query({ until: NOW + 500 }).map((entry) => entry.kind)).toEqual(['user.said']);
    // The newest N, still oldest first.
    expect(trace.query({ limit: 2 }).map((entry) => entry.kind)).toEqual(['presentation.changed', 'step.changed']);
    // A kind matches its family.
    expect(trace.query({ kinds: ['presentation'] }).map((entry) => entry.kind)).toEqual(['presentation.changed']);
    expect(trace.query({ sources: ['operator', 'desk'] }).map((entry) => entry.source)).toEqual(['operator', 'desk']);
  });

  it('rejects unknown sources without throwing, and survives unserializable data', () => {
    expect(trace.record({ source: 'bogus' as never, kind: 'x', summary: 'x' })).toBeNull();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(trace.record({ source: 'hub', kind: 'x', summary: 'x', data: circular })!.data).toEqual({ unserializable: true });
  });

  it('prunes entries older than three days', () => {
    trace.record({ source: 'hub', kind: 'old', summary: 'old', at: NOW - TRACE_KEEP_MS - 1 });
    trace.record({ source: 'hub', kind: 'recent', summary: 'recent', at: NOW - 60_000 });
    expect(trace.prune()).toBe(1);
    expect(trace.query().map((entry) => entry.kind)).toEqual(['recent']);
  });

  it('rate-limits by key', () => {
    const entry: TraceInput = { source: 'desk', kind: 'source.error', summary: 'poll failed' };
    expect(trace.recordLimited('poll', 60_000, entry)).not.toBeNull();
    clock += 30_000;
    expect(trace.recordLimited('poll', 60_000, entry)).toBeNull();
    clock += 31_000;
    expect(trace.recordLimited('poll', 60_000, entry)).not.toBeNull();
  });

  it('notifies subscribers, and a throwing one never breaks recording', () => {
    const seen: string[] = [];
    trace.subscribe(() => {
      throw new Error('boom');
    });
    trace.subscribe((entry) => seen.push(entry.kind));
    expect(trace.record({ source: 'owner', kind: 'mark', summary: 'this was wrong' })).not.toBeNull();
    expect(seen).toEqual(['mark']);
  });

  it('parses relative, epoch and ISO times', () => {
    expect(parseTraceTime('15m', NOW)).toBe(NOW - 15 * 60_000);
    expect(parseTraceTime('2h', NOW)).toBe(NOW - 2 * 3_600_000);
    expect(parseTraceTime(String(NOW), NOW)).toBe(NOW);
    expect(parseTraceTime(new Date(NOW).toISOString(), 0)).toBe(NOW);
    expect(parseTraceTime('soon', NOW)).toBeNull();
    const today = new Date(NOW);
    today.setHours(0, 0, 0, 0);
    const atClock = parseTraceTime('00:00', NOW)!;
    expect(atClock).toBe(today.getTime());
    // A clock time still ahead today means yesterday.
    expect(parseTraceTime('23:59:59', today.getTime() + 1000)).toBe(today.getTime() - 1000);
  });
});

describe('hub and desk record into the trace', () => {
  let h: Harness;
  let trace: DeskTrace;
  let scenes: SceneStore;
  let hub: Hub;
  let app: ReturnType<typeof createApp>;

  function build(token?: string) {
    scenes = new SceneStore(path.join(h.dir, 'scenes'));
    hub = new Hub(scenes, async () => 'agent');
    hub.setTracer(trace.tracer);
    app = createApp({
      store: scenes,
      hub,
      publicDir: h.dir,
      desk: { routes: { core: h.core, trace, scenes: () => hub.liveScenes(), collaborationToken: token, presentation: { current: () => hub.publicPresentation(), subscribe: (listener) => hub.subscribePresentation(listener) } } },
    });
  }

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-h-'));
    const db = new DatabaseSync(path.join(dir, 'trace.db'));
    trace = new DeskTrace(db);
    h = makeHarness({ trace: trace.tracer });
    build();
  });
  afterEach(() => {
    hub.close();
    h.close();
  });

  const kinds = (prefix: string) => trace.query({ kinds: [prefix] });

  async function stage(agentId: string, thread: string, slot = 'main') {
    const response = await app.request('/api/scenes', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ agentId, slot, kind: 'html', body: `<p>${agentId}</p>`, summary: `${agentId} scene`, threadId: thread, channelId: `home-${agentId}`, check: false }),
    });
    return (await response.json()) as { sceneId: string };
  }

  it('records presentation transitions from → to, and refusals with the reason', async () => {
    hub.intent({ view: 'conversation', conversationKey: `thread:${THREAD}`, by: 'director', reason: 'focus' });
    const changed = kinds('presentation.changed').at(-1)!;
    expect(changed.summary).toContain(`board → conversation thread:${THREAD}`);
    expect(changed.data).toMatchObject({ from: { view: 'active' }, to: { view: 'conversation', conversationKey: `thread:${THREAD}` }, by: 'director', reason: 'focus' });

    // The owner picks the overview: a manual selection. Automatic focus is then refused, and the trace says why.
    hub.intent({ view: 'conversation', by: 'screen' });
    const refused = hub.intent({ view: 'conversation', conversationKey: `thread:${THREAD}`, by: 'director', reason: 'focus' });
    expect(refused.applied).toBe(false);
    const ignored = kinds('presentation.ignored').at(-1)!;
    expect(ignored.data).toMatchObject({ why: 'manual-selection', intent: { by: 'director', reason: 'focus' } });
    expect(ignored.summary).toContain('manual-selection');

    // Another conversation's scene from its agent queues; the trace says it queued and what stayed up.
    const { sceneId } = await stage('victor', OTHER_THREAD);
    const staged = trace.query({ kinds: ['scene.staged'] }).at(-1)!;
    expect(staged.data).toMatchObject({ sceneId, outcome: expect.stringContaining('queued') });
    hub.intent({ view: 'screen', sceneId, by: 'agent' });
    expect(kinds('presentation.queued').at(-1)!.data).toMatchObject({ why: 'not-current-conversation' });

    // Errors are refusals too.
    hub.intent({ view: 'screen', conversationKey: 'thread:none', by: 'screen' });
    expect(kinds('presentation.error').at(-1)!.data).toMatchObject({ why: 'no-scene' });
  });

  it('records a director show refused over a manual pick, scene expiry and taps', async () => {
    const { sceneId: first } = await stage('sierra', THREAD);
    expect(hub.show(first, 'screen')).toBe(true); // the owner's pick
    const { sceneId: second } = await stage('sierra', THREAD, 'second');
    expect(trace.query({ kinds: ['scene.staged'] }).at(-1)!.data.outcome).toContain('held');
    expect(hub.show(second, 'director', { reason: 'focus' })).toBe(false);
    expect(kinds('presentation.ignored').at(-1)!.data).toMatchObject({ sceneId: second, why: 'manual-selection' });

    await hub.input({ sceneId: first, type: 'choice', data: { choiceId: 'a', label: 'Pioneer' } });
    expect(kinds('input.tap').at(-1)!.summary).toContain('“Pioneer”');

    hub.removed([first], 'expired');
    expect(kinds('scene.expired').at(-1)!.data).toMatchObject({ sceneIds: [first], onScreen: true });
  });

  it('records attention events, next-step changes and command outcomes (failures too)', async () => {
    h.discord.threads = [{ id: THREAD, parent_id: AGENT.homeChannelId, name: 'Speaker', last_message_id: snowflakeAt(NOW + 365 * 86_400_000) } as never];
    h.discord.channels.set(THREAD, [msg(-5, 'agent', 'Pioneer or Sony?')]);
    await h.source.poll();
    const itemId = `discord:thread:${THREAD}`;
    h.core.setFacts(itemId, { openAsk: { text: 'Pioneer or Sony?', at: NOW - 1000 } });
    h.core.refresh(itemId, { emitStep: true });
    h.core.flush();
    expect(kinds('step.changed').some((entry) => entry.data.itemId === itemId && entry.data.to === 'your_move')).toBe(true);

    expect((await h.core.command({ commandId: cid(), type: 'seen', itemId, actor: 'voice' })).status).toBe('applied');
    const seen = kinds('attention.seen').at(-1)!;
    expect(seen.data).toMatchObject({ itemId, actor: 'voice', from: { seen: 'new' }, to: { seen: 'seen' } });
    expect(seen.summary).toContain('active/new → active/seen');
    expect(kinds('command.applied').at(-1)!.data).toMatchObject({ type: 'seen', itemId, actor: 'voice' });

    expect((await h.core.command({ commandId: cid(), type: 'retry', itemId, actor: 'voice' })).status).toBe('failed');
    expect(kinds('command.failed').at(-1)!.summary).toContain('nothing to retry');
  });

  describe('POST/GET /api/desk/trace', () => {
    const postTrace = (body: unknown, headers: Record<string, string> = JSON_HEADERS) => app.request('/api/desk/trace', { method: 'POST', headers, body: JSON.stringify(body) });

    it('a local process may post any source, in a batch', async () => {
      const response = await postTrace([
        { source: 'operator', kind: 'view.decision', summary: 'after send: conversation → board', data: { from: 'conversation' }, sessionId: 'voice-1' },
        { source: 'operator', kind: 'delegation.refire', summary: 'dropped re-fire' },
      ]);
      expect(await response.json()).toEqual({ recorded: 2 });
      const got = (await (await app.request('/api/desk/trace?since=1h&sources=operator')).json()) as { entries: Array<{ kind: string; sessionId: string | null }> };
      expect(got.entries.map((entry) => entry.kind)).toEqual(['view.decision', 'delegation.refire']);
      expect(got.entries[0]!.sessionId).toBe('voice-1');
    });

    it('a browser may only post screen and owner entries', async () => {
      expect((await postTrace({ source: 'operator', kind: 'view.decision', summary: 'forged' }, BROWSER)).status).toBe(403);
      expect((await postTrace({ source: 'hub', kind: 'presentation.changed', summary: 'forged' }, BROWSER)).status).toBe(403);
      expect((await postTrace({ entries: [{ source: 'screen', kind: 'render', summary: 'board', at: 1 }, { source: 'owner', kind: 'mark', summary: 'this was wrong' }] }, BROWSER)).status).toBe(200);
      const entries = trace.query({ sources: ['screen'] });
      // Browser clocks are not trusted: stamped on arrival, the client's time kept in data.
      expect(entries.at(-1)!.at).toBeGreaterThan(1);
      expect(entries.at(-1)!.data.clientAt).toBe(1);
      // Proxied through the tailnet counts as a browser too.
      expect((await postTrace({ source: 'operator', kind: 'x', summary: 'x' }, { ...JSON_HEADERS, 'Tailscale-User-Login': 'owner@example.com' })).status).toBe(403);
    });

    it('local posts need the collaboration token when one is set', async () => {
      hub.close();
      build('secret');
      expect((await postTrace({ source: 'operator', kind: 'x', summary: 'x' })).status).toBe(403);
      expect((await postTrace({ source: 'operator', kind: 'x', summary: 'x' }, { ...JSON_HEADERS, 'X-Tango-Collaboration-Token': 'secret' })).status).toBe(200);
      // The screen's own reports still work from a browser.
      expect((await postTrace({ source: 'screen', kind: 'render', summary: 'board' }, BROWSER)).status).toBe(200);
    });

    it('validates entries and batch size', async () => {
      expect((await postTrace([])).status).toBe(400);
      expect((await postTrace([{ source: 'operator' }])).status).toBe(400);
      expect((await postTrace(Array.from({ length: 101 }, () => ({ source: 'operator', kind: 'x' })))).status).toBe(400);
    });

    it('session=latest starts the window at the newest session start', async () => {
      trace.record({ source: 'operator', kind: 'user.said', summary: 'before', at: Date.now() - 5000 });
      trace.record({ source: 'operator', kind: 'session.start', summary: 'session started', at: Date.now() - 3000 });
      trace.record({ source: 'operator', kind: 'user.said', summary: 'after', at: Date.now() - 1000 });
      const got = (await (await app.request('/api/desk/trace?since=1h&session=latest&kinds=user.said')).json()) as { entries: Array<{ summary: string }>; sessionStart: number };
      expect(got.entries.map((entry) => entry.summary)).toEqual(['after']);
      expect(got.sessionStart).toBeGreaterThan(0);
    });
  });
});

describe('createDesk wiring', () => {
  it('logs source errors as before and traces them once a minute, without recursing', async () => {
    const { createDesk } = await import('../server/desk/setup.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-setup-'));
    const scenes = new SceneStore(path.join(dir, 'scenes'));
    const hub = new Hub(scenes, async () => 'agent');
    const logged: string[] = [];
    const down = async (): Promise<never> => {
      throw new Error('Loom is down');
    };
    const desk = createDesk({
      conversationFetch: async () => Response.json({ conversations: [], cursor: 0 }),
      db: scenes.db,
      hub,
      discord: { channel: async () => ({}), messagesSince: down } as any,
      agents: [{ id: 'test', name: 'Test', homeChannelId: 'c' }],
      ownerIds: [],
      rules: null,
      summarize: down,
      postToBot: async () => 'agent',
      jobsDir: path.join(dir, 'jobs'),
      jobBridgeUrl: 'http://127.0.0.1:9/background-jobs',
      collaborationToken: '',
      githubReviews: false,
      log: (event) => logged.push(event),
    });
    try {
      await desk.pollSources();
      await desk.pollSources();
      expect(logged.filter((event) => event === 'desk.discord.poll.error')).toHaveLength(2);
      const errors = desk.trace.query({ kinds: ['source.error'] });
      expect(errors).toHaveLength(1);
      expect(errors[0]!.summary).toContain('Loom is down');
      // The hub records into the same trace.
      hub.intent({ view: 'conversation', conversationKey: 'loom:x', by: 'screen' });
      expect(desk.trace.query({ kinds: ['presentation'] })).toHaveLength(1);
    } finally {
      desk.close();
      hub.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
