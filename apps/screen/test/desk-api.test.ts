import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeskMail } from '../server/desk/mail.js';
import { createApp } from '../server/app.js';
import { snowflakeAt } from '../server/discord.js';
import { Hub } from '../server/hub.js';
import { SceneStore } from '../server/store.js';
import { AGENT, cid, makeHarness, msg, NOW, type Harness } from './desk-harness.js';

// The desk's HTTP surface: who may do what (finding 6), the stream's presentation and operator
// events, presence, and the compat shim's Done (finding 9). Synthetic ids and logins only.

const THREAD = '1500000000000000071';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const BROWSER = { ...JSON_HEADERS, Origin: 'http://localhost', Host: 'localhost', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' };

let h: Harness;
let hub: Hub;
let scenes: SceneStore;
let app: ReturnType<typeof createApp>;
const savedLogins = process.env.SCREEN_ALLOWED_LOGINS;

function build(token?: string, mail?: DeskMail) {
  scenes = new SceneStore(path.join(h.dir, 'scenes'));
  hub = new Hub(scenes, async () => 'agent');
  app = createApp({
    store: scenes,
    hub,
    publicDir: h.dir,
    desk: {
      routes: {
        core: h.core,
        scenes: () => hub.liveScenes(),
        collaborationToken: token,
        mail,
        presentation: { current: () => hub.publicPresentation(), subscribe: (listener) => hub.subscribePresentation(listener) },
      },
      compat: { core: h.core, hub, rules: null, pollSources: () => h.source.poll() },
    },
  });
}

async function seed() {
  h.discord.threads = [{ id: THREAD, parent_id: AGENT.homeChannelId, name: 'Speaker', last_message_id: snowflakeAt(NOW + 365 * 86_400_000) } as never];
  h.discord.channels.set(THREAD, [msg(-5, 'agent', 'Pioneer or Sony?')]);
  await h.source.poll();
  return `discord:thread:${THREAD}`;
}

/** Reads SSE events from a streaming response until `want` returns a match (or times out). */
async function readEvents(response: Response, want: (events: Array<{ event: string; data: any }>) => boolean, ms = 2000) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: any }> = [];
  let buffer = '';
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !want(events)) {
    const chunk = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 100))]);
    if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event && data) events.push({ event, data: JSON.parse(data) });
    }
  }
  await reader.cancel().catch(() => undefined);
  return events;
}

beforeEach(() => {
  h = makeHarness();
  delete process.env.SCREEN_ALLOWED_LOGINS;
  build();
});
afterEach(() => {
  hub.close();
  h.close();
  if (savedLogins === undefined) delete process.env.SCREEN_ALLOWED_LOGINS;
  else process.env.SCREEN_ALLOWED_LOGINS = savedLogins;
});

describe('finding 6: desk security', () => {
  it('desk POSTs must be application/json', async () => {
    const itemId = await seed();
    const body = JSON.stringify({ commandId: cid(), type: 'seen', itemId });
    expect((await app.request('/api/desk/commands', { method: 'POST', body })).status).toBe(415);
    expect((await app.request('/api/desk/commands', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body })).status).toBe(415);
    expect((await app.request('/api/desk/presentation', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'view=active&by=screen' })).status).toBe(415);
    expect((await app.request('/api/desk/commands', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body })).status).toBe(200);
  });

  it('a browser is always the screen, whatever actor it claims; a local process may say voice', async () => {
    const itemId = await seed();
    await app.request('/api/desk/commands', { method: 'POST', headers: BROWSER, body: JSON.stringify({ commandId: 'b-1', type: 'seen', itemId, actor: 'voice' }) });
    await app.request('/api/desk/commands', { method: 'POST', headers: { ...JSON_HEADERS, 'Tailscale-User-Login': 'owner@example.com' }, body: JSON.stringify({ commandId: 'b-2', type: 'park', itemId, actor: 'system' }) });
    await app.request('/api/desk/commands', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ commandId: 'l-1', type: 'pickup', itemId, actor: 'voice' }) });
    const actors = Object.fromEntries(h.core.store.eventsFor(itemId).filter((event) => event.commandId).map((event) => [event.commandId, event.actor]));
    expect(actors).toEqual({ 'b-1': 'screen', 'b-2': 'screen', 'l-1': 'voice' });
  });

  it('agent events need the collaboration token when one is set, and are refused through the proxy or from a browser', async () => {
    build('secret-token');
    await seed();
    const event = JSON.stringify({ type: 'turn.started', agentId: AGENT.id, conversationKey: `thread:${THREAD}`, turnId: 't1', at: NOW });
    const post = (headers: Record<string, string>) => app.request('/api/desk/agent-events', { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: event });
    expect((await post({})).status).toBe(403);
    expect((await post({ 'X-Tango-Collaboration-Token': 'wrong' })).status).toBe(403);
    expect((await post({ 'X-Tango-Collaboration-Token': 'secret-token', 'X-Forwarded-For': '100.64.0.9' })).status).toBe(403);
    expect((await post({ 'X-Tango-Collaboration-Token': 'secret-token', 'Tailscale-Headers-Info': 'x' })).status).toBe(403);
    expect((await post({ 'X-Tango-Collaboration-Token': 'secret-token', Origin: 'http://localhost', Host: 'localhost' })).status).toBe(403);
    // Node's fetch (the bot) sends Sec-Fetch-Mode: cors; that alone doesn't make it a browser.
    expect(await (await post({ 'X-Tango-Collaboration-Token': 'secret-token', 'Sec-Fetch-Mode': 'cors' })).json()).toEqual({ itemId: `discord:thread:${THREAD}` });
  });

  it('the login allowlist covers every /api/desk route', async () => {
    process.env.SCREEN_ALLOWED_LOGINS = 'owner@example.com';
    build();
    const itemId = await seed();
    const outsider = { ...JSON_HEADERS, 'Tailscale-User-Login': 'someone@example.com' };
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/api/desk/items'],
      ['GET', `/api/desk/items/${encodeURIComponent(itemId)}`],
      ['GET', '/api/desk/activity'],
      ['GET', '/api/desk/briefing'],
      ['GET', '/api/desk/settings'],
      ['POST', '/api/desk/settings', { sweepDay: 'monday' }],
      ['POST', '/api/desk/settings', { filters: { hideTypes: ['bug'] } }],
      ['GET', '/api/desk/facets'],
      ['GET', '/api/desk/presentation'],
      ['POST', '/api/desk/presentation', { view: 'active', by: 'screen' }],
      ['POST', '/api/desk/commands', { commandId: cid(), type: 'seen', itemId }],
      ['POST', '/api/desk/presence', {}],
      ['GET', '/api/desk/operator'],
      ['POST', '/api/desk/operator', { live: true }],
      ['GET', '/api/desk/draft'],
      ['POST', '/api/desk/draft', { active: true }],
      ['POST', '/api/desk/draft/command', { action: 'dismiss' }],
      ['GET', '/api/desk/pause'],
      ['POST', '/api/desk/pause', { active: true }],
      ['POST', '/api/desk/pause/command', { action: 'resume', pauseId: 'x' }],
      ['POST', '/api/desk/agent-events', {}],
      ['GET', '/api/desk/stream'],
    ];
    for (const [method, url, body] of routes) {
      const response = await app.request(url, { method, headers: outsider, ...(body ? { body: JSON.stringify(body) } : {}) });
      expect([url, response.status]).toEqual([url, 403]);
    }
    const allowed = await app.request('/api/desk/items', { headers: { 'Tailscale-User-Login': 'owner@example.com' } });
    expect(allowed.status).toBe(200);
  });

  it('only a local process may publish operator status', async () => {
    expect((await app.request('/api/desk/operator', { method: 'POST', headers: BROWSER, body: JSON.stringify({ live: true }) })).status).toBe(403);
    const ok = await app.request('/api/desk/operator', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ live: true, status: 'speaking', agentName: 'Sierra', transcript: { speaker: 'agent', name: 'Sierra', text: 'Here is the loop.', final: true } }) });
    expect(await ok.json()).toMatchObject({ live: true, status: 'speaking', agentName: 'Sierra', transcript: { speaker: 'agent', text: 'Here is the loop.', final: true } });
  });

  it("the voice operator's `user` lines are the owner's, and a long line keeps its newest words", async () => {
    const said = 'word '.repeat(150) + 'and the newest words';
    const response = await app.request('/api/desk/operator', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ live: true, status: 'listening', transcript: { speaker: 'user', name: 'You', text: said, final: false } }) });
    const { transcript } = (await response.json()) as { transcript: { speaker: string; text: string } };
    expect(transcript.speaker).toBe('owner');
    expect(transcript.text.length).toBeLessThanOrEqual(500);
    expect(transcript.text.startsWith('…')).toBe(true);
    expect(transcript.text.endsWith('and the newest words')).toBe(true);
  });
});

describe('the desk stream', () => {
  it('relays presentation changes and operator status next to items', async () => {
    const response = await app.request('/api/desk/stream');
    const reading = readEvents(response, (events) => events.some((e) => e.event === 'presentation') && events.some((e) => e.event === 'operator'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await app.request('/api/desk/presentation', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ view: 'conversation', by: 'screen', conversationKey: `thread:${THREAD}` }) });
    await app.request('/api/desk/operator', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ live: true, status: 'listening' }) });
    const events = await reading;
    expect(events[0]).toMatchObject({ event: 'hello', data: { operator: { live: false }, presentation: { view: 'active' } } });
    expect(events.find((e) => e.event === 'presentation')!.data).toMatchObject({ view: 'conversation', conversationKey: `thread:${THREAD}`, queueScenes: [], upNext: null });
    expect(events.find((e) => e.event === 'operator')!.data).toMatchObject({ live: true, status: 'listening' });
  });
});

describe('presence', () => {
  it('a screen reporting activity after 10 idle minutes fires "until I\'m at my desk" snoozes', async () => {
    const itemId = await seed();
    await h.core.command({ commandId: cid(), type: 'snooze', itemId, args: { trigger: 'desk' } });
    const ping = async () => (await (await app.request('/api/desk/presence', { method: 'POST', headers: BROWSER, body: '{}' })).json()) as { fired: string[] };
    expect((await ping()).fired).toEqual([]); // the desk was just in use (the snooze came from it)
    h.clock.now += 11 * 60_000;
    expect((await ping()).fired).toEqual([itemId]);
    expect(h.core.item(itemId)).toMatchObject({ disposition: 'active', seen: 'new', backFromSnooze: true });
  });
});

describe('read API shapes', () => {
  it('list carries counts incl. yourMove; detail is { item, messages, timeline, scenes } with linked scenes', async () => {
    const itemId = await seed();
    h.core.setFacts(itemId, { openAsk: { text: 'Choose a speaker', at: NOW - 1000 } });
    h.core.refresh(itemId);
    const staged = await (await app.request('/api/scenes', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ agentId: AGENT.id, kind: 'html', body: '<p>map</p>', summary: 'The loop map', title: 'Loop map', threadId: THREAD, channelId: AGENT.homeChannelId, check: false }) })).json();
    const list = (await (await app.request('/api/desk/items?view=active')).json()) as { counts: Record<string, number> };
    expect(list.counts).toMatchObject({ active: 1, new: 1, updated: 0, yourMove: 1, snoozed: 0, parked: 0, done: 0 });
    const detail = (await (await app.request(`/api/desk/items/${encodeURIComponent(itemId)}`)).json()) as Record<string, any>;
    expect(Object.keys(detail).sort()).toEqual(['backstage', 'beats', 'item', 'laterNotes', 'mail', 'messages', 'ownerReceipts', 'prototypes', 'queued', 'receiptCommandIds', 'reply', 'scenes', 'sinceOwner', 'timeline']);
    expect(detail.item).toMatchObject({ id: itemId, nextStep: 'your_move', summary: null });
    expect(detail.timeline.at(-1)).toMatchObject({ kind: 'now', text: expect.stringContaining('Waiting on you') });
    expect(detail.scenes).toEqual([expect.objectContaining({ id: staged.sceneId, itemId, conversationKey: `thread:${THREAD}`, version: 1, title: 'Loop map' })]);
  });
});

describe('next up', () => {
  it('/api/desk/next lists the owner\'s move oldest wait first; the board carries each card\'s place in line', async () => {
    const NEWER = '1500000000000000072';
    h.discord.threads = [
      { id: THREAD, parent_id: AGENT.homeChannelId, name: 'Speaker', last_message_id: snowflakeAt(NOW + 365 * 86_400_000) } as never,
      { id: NEWER, parent_id: AGENT.homeChannelId, name: 'Tent', last_message_id: snowflakeAt(NOW + 365 * 86_400_000) } as never,
    ];
    // The newer ask came in later, but the older one has waited longer even though it got a follow-up since.
    h.discord.channels.set(THREAD, [msg(-60, 'agent', 'Pioneer or Sony?'), msg(-2, 'agent', 'Also, the Sony is on sale. Want it?')]);
    h.discord.channels.set(NEWER, [msg(-15, 'agent', 'Small tent or big tent?')]);
    await h.source.poll();
    for (const [sourceId, minutes] of [[THREAD, 60], [NEWER, 15]] as const) {
      const id = `discord:thread:${sourceId}`;
      h.core.setFacts(id, { openAsk: { text: 'Choose?', at: NOW - minutes * 60_000 } });
      h.core.refresh(id);
    }
    const next = (await (await app.request('/api/desk/next')).json()) as { items: Array<{ id: string; waitingSince: number; step: string }> };
    expect(next.items.map((item) => item.id)).toEqual([`discord:thread:${THREAD}`, `discord:thread:${NEWER}`]);
    expect(next.items[0]!.waitingSince).toBeLessThan(next.items[1]!.waitingSince);
    const list = (await (await app.request('/api/desk/items?view=active')).json()) as { items: Array<{ id: string; queuePos?: number }> };
    expect(Object.fromEntries(list.items.map((item) => [item.id, item.queuePos]))).toEqual({ [`discord:thread:${THREAD}`]: 1, [`discord:thread:${NEWER}`]: 2 });
  });
});

describe('next up: long waits', () => {
  it('a wait that began more than 40 agent messages ago still counts from its first message (Codex review on #434)', async () => {
    h.discord.threads = [{ id: THREAD, parent_id: AGENT.homeChannelId, name: 'Speaker', last_message_id: snowflakeAt(NOW + 365 * 86_400_000) } as never];
    h.discord.channels.set(THREAD, [...Array.from({ length: 45 }, (_, i) => msg(-120 + i, 'agent', `update ${i}`)), msg(-1, 'agent', 'Pioneer or Sony?')]);
    await h.source.poll();
    h.core.setFacts(`discord:thread:${THREAD}`, { openAsk: { text: 'Choose?', at: NOW - 120 * 60_000 } });
    h.core.refresh(`discord:thread:${THREAD}`);
    const next = (await (await app.request('/api/desk/next')).json()) as { items: Array<{ waitingSince: number }> };
    expect(next.items[0]!.waitingSince).toBeLessThanOrEqual(NOW - 119 * 60_000);
  });
});

describe('finding 9: compat Done with a running job', () => {
  it('returns the stopJob-required failure instead of silently leaving the job running', async () => {
    const itemId = await seed();
    h.core.setJobs([{ id: 'job-1', agentId: AGENT.id, channelId: AGENT.homeChannelId, threadId: THREAD, conversationKey: null, label: 'scan', startedAt: NOW, deadlineAt: null }]);
    const response = await app.request(`/api/inbox/${encodeURIComponent(itemId)}/done`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ stopJobRequired: true, error: expect.stringContaining('stopJob is required') });
    expect(h.core.item(itemId)!.disposition).toBe('active');
    const read = await app.request(`/api/inbox/${encodeURIComponent(itemId)}/read`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
    expect(read.status).toBe(400);
    const chosen = await app.request(`/api/inbox/${encodeURIComponent(itemId)}/done`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ stopJob: false }) });
    expect(chosen.status).toBe(200);
    expect(h.core.item(itemId)!.disposition).toBe('done');
  });
});

describe('draft card (voice draft mode)', () => {
  const card = { id: 'draft-1', active: true, target: { agentId: 'sierra', name: 'Sierra', where: 'Shed vents', label: 'Sierra · Shed vents thread' }, fragments: ['the left vent rattles'], compiled: null, question: null, note: null, status: 'listening' };
  const post = (body: unknown, headers: Record<string, string> = JSON_HEADERS) => app.request('/api/desk/draft', { method: 'POST', headers, body: JSON.stringify(body) });
  // A tap names the draft the screen shows (the current one unless a test says otherwise).
  const tap = async (action: string, draftId?: string) => app.request('/api/desk/draft/command', { method: 'POST', headers: BROWSER, body: JSON.stringify({ action, draftId: draftId ?? ((await (await app.request('/api/desk/draft')).json()) as { id: string | null }).id ?? undefined }) });

  it('only a local process may publish it; anyone allowed can read it', async () => {
    expect((await post(card, BROWSER)).status).toBe(403);
    expect((await post('nope')).status).toBe(400);
    const ok = await post({ ...card, status: 'bogus', fragments: ['a', '', 7, 'b'] });
    expect(await ok.json()).toMatchObject({ active: true, status: 'listening', fragments: ['a', 'b'], target: { label: 'Sierra · Shed vents thread' } });
    expect(await (await app.request('/api/desk/draft')).json()).toMatchObject({ active: true, fragments: ['a', 'b'] });
  });

  it('is relayed on the stream (and in hello); taps reach only the operator, and only when they make sense', async () => {
    await post(card);
    const screen = await app.request('/api/desk/stream');
    const screenReading = readEvents(screen, (events) => events.some((e) => e.event === 'draft' && e.data.status === 'confirm'));
    const operator = await app.request('/api/desk/stream?client=operator');
    const operatorReading = readEvents(operator, (events) => events.some((e) => e.event === 'draftCommand'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Not ready to send yet: still listening.
    expect((await tap('send')).status).toBe(409);
    await post({ ...card, status: 'confirm', compiled: 'The left vent rattles at highway speed.' });
    const sent = await tap('send');
    expect(sent.status).toBe(202);
    expect(await sent.json()).toMatchObject({ accepted: true, commandId: expect.any(String) });
    expect((await tap('bogus')).status).toBe(400);

    const screenEvents = await screenReading;
    expect(screenEvents[0]).toMatchObject({ event: 'hello', data: { draft: { active: true } } });
    expect(screenEvents.find((e) => e.event === 'draft')!.data).toMatchObject({ status: 'confirm' });
    expect(screenEvents.some((e) => e.event === 'draftCommand')).toBe(false);
    const operatorEvents = await operatorReading;
    expect(operatorEvents.find((e) => e.event === 'draftCommand')!.data).toMatchObject({ action: 'send' });
  });

  it('taps must name the draft shown; one for a replaced draft is refused (PR review 4)', async () => {
    await post({ ...card, status: 'confirm', compiled: 'x' });
    const send = (body: Record<string, unknown>) => app.request('/api/desk/draft/command', { method: 'POST', headers: BROWSER, body: JSON.stringify(body) });
    expect((await send({ action: 'send' })).status).toBe(400);
    expect(await (await send({ action: 'cancel', draftId: 'draft-old' })).json()).toMatchObject({ error: 'that draft is no longer the current one' });
    await post({ ...card, active: false, status: 'cancelled', note: 'Not sent' });
    expect((await send({ action: 'dismiss', draftId: 'draft-old' })).status).toBe(409);
    expect((await send({ action: 'dismiss', draftId: 'draft-1' })).status).toBe(200);
  });

  it("a clear meant for an older draft doesn't wipe a newer one (PR review 3)", async () => {
    await post({ ...card, id: 'draft-a', active: false, status: 'cancelled', note: 'Not sent: the voice session ended' });
    await post({ ...card, id: 'draft-b' });
    const blank = { id: null, active: false, target: null, fragments: [], compiled: null, question: null, note: null, status: 'listening' };
    expect(await (await post({ ...blank, clears: 'draft-a' })).json()).toMatchObject({ id: 'draft-b', active: true });
    expect(await (await post({ ...blank, clears: 'draft-b' })).json()).toMatchObject({ id: null, active: false });
  });

  it('taps reach only an authenticated local operator stream (PR review 2)', async () => {
    hub.close();
    build('desk-token');
    const withToken = { ...JSON_HEADERS, 'X-Tango-Collaboration-Token': 'desk-token' };
    await post({ ...card, status: 'confirm', compiled: 'x' }, withToken);
    // A browser, and a local caller without the token, asking for ?client=operator get a plain stream.
    const browser = await app.request('/api/desk/stream?client=operator', { headers: BROWSER });
    const noToken = await app.request('/api/desk/stream?client=operator');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await (await tap('send')).json()).toMatchObject({ error: expect.stringContaining('not connected') });
    await browser.body?.cancel();
    await noToken.body?.cancel();
    const operator = await app.request('/api/desk/stream?client=operator', { headers: { 'X-Tango-Collaboration-Token': 'desk-token' } });
    const reading = readEvents(operator, (events) => events.some((e) => e.event === 'draftCommand'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await tap('send')).status).toBe(202);
    expect((await reading).find((e) => e.event === 'draftCommand')!.data).toMatchObject({ action: 'send' });
  });

  it('send and cancel need an operator listening; dismiss clears a closed card', async () => {
    await post({ ...card, status: 'confirm', compiled: 'x' });
    expect(await (await tap('cancel')).json()).toMatchObject({ error: expect.stringContaining('not connected') });
    expect((await tap('dismiss')).status).toBe(409); // still open
    // On its way: neither cancellable nor sendable again.
    expect(await (await post({ ...card, status: 'sending', compiled: 'x' })).json()).toMatchObject({ status: 'sending' });
    expect(await (await tap('cancel')).json()).toMatchObject({ error: 'the draft is already on its way' });
    expect((await tap('send')).status).toBe(409);
    await post({ ...card, active: false, status: 'cancelled', note: 'Not sent: the voice session ended' });
    expect((await tap('cancel')).status).toBe(409);
    expect((await tap('dismiss')).status).toBe(200);
    expect(await (await app.request('/api/desk/draft')).json()).toMatchObject({ active: false, fragments: [], status: 'listening' });
  });
});

describe('pause pill (voice pause mode)', () => {
  const card = { id: 'pause-1', active: true, since: NOW, waiting: 3, still: false };
  const post = (body: unknown, headers: Record<string, string> = JSON_HEADERS) => app.request('/api/desk/pause', { method: 'POST', headers, body: JSON.stringify(body) });
  const tap = (body: Record<string, unknown>) => app.request('/api/desk/pause/command', { method: 'POST', headers: BROWSER, body: JSON.stringify(body) });

  it('only a local process may publish it; it is bounded; anyone allowed can read it', async () => {
    expect(await (await app.request('/api/desk/pause')).json()).toMatchObject({ id: null, active: false, waiting: 0 });
    expect((await post(card, BROWSER)).status).toBe(403);
    expect((await post('nope')).status).toBe(400);
    expect(await (await post({ ...card, waiting: -4 })).json()).toMatchObject({ active: true, waiting: 0 });
    expect(await (await post({ ...card, waiting: 2.7, still: true })).json()).toMatchObject({ active: true, waiting: 2, still: true });
    // An inactive pill carries no count.
    expect(await (await post({ ...card, active: false })).json()).toMatchObject({ active: false, waiting: 0, still: false, since: null });
  });

  it('needs the collaboration token when one is set', async () => {
    hub.close();
    build('desk-token');
    expect((await post(card)).status).toBe(403);
    expect((await post(card, { ...JSON_HEADERS, 'X-Tango-Collaboration-Token': 'desk-token' })).status).toBe(200);
  });

  it('is relayed on the stream (and in hello); a resume tap reaches only an authenticated operator stream', async () => {
    hub.close();
    build('desk-token');
    const withToken = { ...JSON_HEADERS, 'X-Tango-Collaboration-Token': 'desk-token' };
    await post(card, withToken);
    const screen = await app.request('/api/desk/stream');
    const screenReading = readEvents(screen, (events) => events.some((e) => e.event === 'hello'));
    const browser = await app.request('/api/desk/stream?client=operator', { headers: BROWSER });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // No authenticated operator listening yet.
    expect(await (await tap({ action: 'resume', pauseId: 'pause-1' })).json()).toMatchObject({ error: expect.stringContaining('not connected') });
    await browser.body?.cancel();
    const operator = await app.request('/api/desk/stream?client=operator', { headers: { 'X-Tango-Collaboration-Token': 'desk-token' } });
    const operatorReading = readEvents(operator, (events) => events.some((e) => e.event === 'pauseCommand'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await post({ ...card, waiting: 4 }, withToken);
    expect((await tap({ action: 'resume' })).status).toBe(400);
    expect((await tap({ action: 'pause', pauseId: 'pause-1' })).status).toBe(400);
    expect(await (await tap({ action: 'resume', pauseId: 'pause-0' })).json()).toMatchObject({ error: 'that pause is no longer the current one' });
    const accepted = await tap({ action: 'resume', pauseId: 'pause-1' });
    expect(accepted.status).toBe(202);
    const screenEvents = await screenReading;
    expect(screenEvents[0]).toMatchObject({ event: 'hello', data: { pause: { active: true, waiting: 3 } } });
    expect(screenEvents.some((e) => e.event === 'pauseCommand')).toBe(false);
    const opEvents = await operatorReading;
    expect(opEvents.find((e) => e.event === 'pause')!.data).toMatchObject({ active: true, waiting: 4 });
    expect(opEvents.find((e) => e.event === 'pauseCommand')!.data).toMatchObject({ action: 'resume', pauseId: 'pause-1' });
    // Once the operator says it resumed, a tap has nothing to resume.
    await post({ ...card, active: false }, withToken);
    expect(await (await tap({ action: 'resume', pauseId: 'pause-1' })).json()).toMatchObject({ error: 'the operator is not paused' });
  });
});

describe('list caching', () => {
  const list = (view = 'active', headers: Record<string, string> = {}) => app.request(`/api/desk/items?view=${view}`, { headers });

  it('a window that has the list gets a 304; a change, or a setting, gives a new list', async () => {
    const itemId = await seed();
    const first = await list();
    const etag = first.headers.get('ETag')!;
    expect(first.status).toBe(200);
    expect(etag).toMatch(/^".+"$/);
    expect((await list('active', { 'If-None-Match': etag })).status).toBe(304);
    // A list the window doesn't have: the whole list.
    expect((await list('active', { 'If-None-Match': '"other"' })).status).toBe(200);

    h.core.store.patchItem(itemId, { ask: 'Pioneer, Sony, or neither?' });
    const changed = await list('active', { 'If-None-Match': etag });
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as { items: Array<{ ask: string }> }).items[0]!.ask).toBe('Pioneer, Sony, or neither?');

    const before = (await list()).headers.get('ETag')!;
    h.core.store.setSetting('filters', JSON.stringify({ hideAgents: [AGENT.id] }));
    const filtered = await list('active', { 'If-None-Match': before });
    expect(filtered.status).toBe(200);
    expect(((await filtered.json()) as { items: Array<{ filteredBy: unknown[] }> }).items[0]!.filteredBy).toEqual([{ facet: 'agent', value: AGENT.id }]);
  });

  it('a rebuild with the same content keeps its ETag (a restart, a write that changed nothing shown)', async () => {
    const itemId = await seed();
    const etag = (await list('history')).headers.get('ETag')!;
    h.core.store.patchItem(itemId, { ask: 'Something new' });
    expect((await list('history', { 'If-None-Match': etag })).status).toBe(304);
  });
});


describe('space mail draft HTTP flow', () => {
  it('exposes pending drafts and lets the owner edit/approve or discard, without duplicate delivery', async () => {
    const recipient = await seed();
    h.discord.channels.set(AGENT.homeChannelId, [msg(-6, 'agent', 'Ready')]);
    await h.source.poll();
    const from = h.core.items().find((i) => i.conversationKey === `channel:${AGENT.homeChannelId}`)!.id;
    h.core.roles.set(from, { role: 'default' }, 'owner', NOW);
    h.core.touch(from);
    // Drafts only when the space switches free messaging off; unset reads as on.
    const space = h.core.spaceOfItem(h.core.store.item(from)!)!;
    h.core.store.setSetting('spaces', JSON.stringify({ [space]: { permissions: { messageConversations: false } } }));
    const mail = new DeskMail({ core: h.core, db: h.core.store.db, now: () => h.clock.now });
    hub.close();
    process.env.SCREEN_ALLOWED_LOGINS = 'owner@example.com';
    build(undefined, mail);
    const owner = { ...BROWSER, 'Tailscale-User-Login': 'owner@example.com', 'Tailscale-Headers-Info': 'proxied' };
    const post = (url: string, body: unknown, headers = JSON_HEADERS) => app.request(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const response = await post('/api/desk/mail', { from, to: recipient, text: 'First question', approved: true });
    const sent = await response.json();
    expect(sent).toMatchObject({ ok: true, mail: { state: 'draft' } });
    const detail = await (await app.request(`/api/desk/items/${encodeURIComponent(from)}`)).json();
    expect(detail.mailDrafts).toHaveLength(1);
    const url = `/api/desk/mail/${sent.mail.id}/draft`;
    for (const headers of [JSON_HEADERS, BROWSER, { ...owner, 'x-desk-window': 'detached' }, { ...owner, 'Tailscale-User-Login': 'outsider@example.com' }, { ...BROWSER, 'Tailscale-Headers-Info': 'proxied' }]) {
      expect((await post(url, { action: 'send' }, headers)).status).toBe(403);
      expect(mail.get(sent.mail.id)?.state).toBe('draft');
    }
    delete process.env.SCREEN_ALLOWED_LOGINS;
    hub.close();
    build(undefined, mail);
    for (const headers of [JSON_HEADERS, BROWSER, { ...owner, 'Tailscale-User-Login': '' }, { ...owner, 'Tailscale-User-Login': '   ' }, { ...owner, 'Tailscale-Headers-Info': '' }, { ...owner, 'x-desk-window': 'detached' }]) {
      expect((await post(url, { action: 'send' }, headers)).status).toBe(403);
      expect(mail.get(sent.mail.id)?.state).toBe('draft');
    }
    expect((await post(url, { action: 'send', text: '' }, owner)).status).toBe(400);
    expect((await post(url, { action: 'send', text: 'Edited question' }, owner)).status).toBe(200);
    expect((await post(url, { action: 'send' }, owner)).status).toBe(400);
    await mail.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(mail.get(sent.mail.id)?.text).toBe('Edited question');
    expect(mail.get(sent.mail.id)?.state).toBe('sent');
    process.env.SCREEN_ALLOWED_LOGINS = 'owner@example.com';
    const next = await (await post('/api/desk/mail', { from, to: recipient, text: 'Discard me' })).json();
    expect((await post(`/api/desk/mail/${next.mail.id}/draft`, { action: 'drop' }, owner)).status).toBe(200);
    expect(mail.get(next.mail.id)?.state).toBe('dropped');
    expect(mail.drafts(from)).toEqual([]);
  });
});
