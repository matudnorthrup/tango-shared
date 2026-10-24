import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDesk } from '../server/desk/setup.js';
import { SceneStore } from '../server/store.js';
import { Hub } from '../server/hub.js';
import { createApp } from '../server/app.js';
import { AGENT, FakeConversationApi, makeHarness, NOW } from './desk-harness.js';
const cleanups: Array<() => void> = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); vi.unstubAllGlobals(); });
it('production event route pushes to the store reader, exposes a diff report and proxies local files', async () => {
  const h = makeHarness(); const api = new FakeConversationApi();
  api.conversations = [{ conversation_key: 'thread:6000', agent_id: AGENT.id, kind: 'thread', title: 'Fixture', discord_channel_id: AGENT.homeChannelId, discord_thread_id: '6000', revision: 1, changed_message_ids: '[1]' }];
  api.posts = [{ id: 1, conversation_key: 'thread:6000', author_kind: 'agent', content: 'stored answer', created_at: new Date().toISOString(), discord_message_ids: '["100"]', attachments: '[]', reply_to_message_id: null }];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    expect((init?.headers as Record<string, string>)['X-Tango-Collaboration-Token']).toBe('fixture-token');
    if (String(input).includes('/attachments/')) return new Response('local image bytes', { headers: { 'Content-Type': 'image/png' } });
    return api.fetch(input, init);
  });
  vi.stubGlobal('fetch', fetcher);
  const scenes = new SceneStore(path.join(h.dir, 'scenes')); const hub = new Hub(scenes, async () => 'agent');
  const desk = createDesk({ db: scenes.db, hub, discord: null, agents: [AGENT], ownerIds: [], rules: null,
    summarize: async () => { throw new Error('No model calls'); }, postToBot: async () => 'agent', jobsDir: path.join(h.dir, 'jobs'),
    jobBridgeUrl: 'http://fake', collaborationToken: 'fixture-token', log: () => {}, githubReviews: false, systemDb: false,
    conversationMode: 'tango', conversationUrl: 'http://fake' });
  const app = createApp({ store: scenes, hub, publicDir: h.dir, desk: { routes: { ...desk.routes, scenes: () => hub.liveScenes() }, compat: desk.compat } });
  cleanups.push(() => { desk.close(); hub.close(); scenes.db.close(); h.close(); });
  const event = { type: 'message.created', agentId: AGENT.id, conversationKey: 'thread:6000', messageId: 1 };
  const send = (body: unknown, token = 'fixture-token') => app.request('/api/desk/agent-events', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tango-Collaboration-Token': token }, body: JSON.stringify(body) });
  expect((await send(event, 'bad')).status).toBe(403);
  expect((await send({ ...event, messageId: -1 })).status).toBe(400);
  const started = performance.now();
  expect((await send(event)).status).toBe(200);
  await desk.tango.push('thread:6000', 1);
  expect(desk.core.store.messages('discord:thread:6000')[0]?.text).toBe('stored answer');
  console.info(`Store push to desk message: ${Math.round(performance.now() - started)} ms (fake bot, production routes)`);
  expect(await (await app.request('/api/desk/conversation-shadow')).json()).toEqual([]);
  const attachment = await app.request('/api/desk/tango-attachments/1/0');
  expect(await attachment.text()).toBe('local image bytes');
  expect(attachment.headers.get('content-type')).toBe('image/png');
});
it('wires start and reply to the fake bot with no Discord, while keeping blocked agents out', async () => {
  const h = makeHarness(); const api = new FakeConversationApi();
  const scenes = new SceneStore(path.join(h.dir, 'scenes')); const hub = new Hub(scenes, async () => 'agent');
  const legacy = vi.fn(async () => 'agent');
  const desk = createDesk({ db: scenes.db, hub, discord: null, agents: [AGENT, { ...AGENT, id: 'private-agent' }],
    mailBlockedAgents: ['private-agent'], ownerIds: [], rules: null, summarize: async () => { throw Error('No models'); },
    postToBot: legacy, jobsDir: path.join(h.dir, 'jobs'), jobBridgeUrl: 'http://fake', log: () => {}, githubReviews: false, systemDb: false,
    conversationMode: 'tango', conversationUrl: 'http://fake', conversationFetch: api.fetch });
  cleanups.push(() => { desk.close(); hub.close(); scenes.db.close(); h.close(); });
  const service = desk.routes.agentStart!.service;
  expect((await service.start({ agentId: 'private-agent', prompt: 'hidden' })).ok).toBe(false);
  const started = await service.start({ agentId: AGENT.id, prompt: 'first', commandId: 'start-1' });
  expect(started.ok).toBe(true); if (!started.ok) return;
  await desk.tango.poll();
  expect(desk.core.store.messages(started.itemId)[0]?.text).toBe('first');
  await desk.core.command({ commandId: 'reply-1', type: 'reply', itemId: started.itemId, args: { text: 'second' } });
  await desk.tango.poll();
  expect(api.posted.map(p => (p.data as { text: string }).text)).toEqual(['first', 'second']);
  expect(desk.core.store.messages(started.itemId).map(p => p.text)).toEqual(['first', 'second']);
  expect(legacy).not.toHaveBeenCalled();
});
