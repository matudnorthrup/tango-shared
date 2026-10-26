import { afterEach, expect, it } from 'vitest';
import { DeskTangoSource, parseStoreKey, shadowDiff, compareConversationPosts, type StorePost } from '../server/desk/source-tango.js';
import { joinsChapter, storeTime } from '../server/desk/chapters.js';
import { AGENT, FakeConversationApi, makeHarness, msg, NOW, type Harness } from './desk-harness.js';
const harnesses: Harness[] = [];
afterEach(() => { for (const h of harnesses.splice(0)) h.close(); });
function setup(mode: 'shadow' | 'tango' = 'shadow') {
  const h = makeHarness(); harnesses.push(h);
  const api = new FakeConversationApi();
  api.conversations = [{ conversation_key: 'thread:6000', agent_id: AGENT.id, kind: 'thread', title: 'Fixture', discord_channel_id: AGENT.homeChannelId, discord_thread_id: '6000', revision: 1, changed_message_ids: '[1]' }];
  const options = { core: h.core, agents: [AGENT], url: 'http://fake', fetchImpl: api.fetch, mode, now: () => NOW };
  return { h, api, options, source: new DeskTangoSource(options) };
}
function post(id = 1, extra: Partial<StorePost> = {}): StorePost {
  return { id, conversation_key: 'thread:6000', author_kind: 'owner', content: 'question', created_at: new Date(NOW).toISOString(), discord_message_ids: `['${id}']`.replaceAll("'", '"'), attachments: '[]', reply_to_message_id: null, ...extra };
}
it('parses only existing conversation keys and timezone-less store timestamps as UTC', () => {
  expect(parseStoreKey('thread:123')).toEqual({ kind: 'thread', id: '123' });
  for (const key of ['conv:abc', 'channel:../x', 'channel:', 'thread:1/2']) expect(parseStoreKey(key)).toBeNull();
  expect(storeTime('2026-10-01 12:30:00')).toBe(Date.parse('2026-10-01T12:30:00Z'));
  expect(() => storeTime('bad')).toThrow();
});
it('classifies missing posts, text differences and order independently', () => {
  expect(shadowDiff([{ id: '1', text: 'a' }, { id: '2', text: 'b' }, { id: '3', text: 'c' }],
    [{ id: '2', text: 'different' }, { id: '1', text: 'a' }, { id: '4', text: 'd' }])).toEqual([
      { kind: 'text', id: '2' }, { kind: 'missing-discord', id: '3' }, { kind: 'missing-tango', id: '4' }, { kind: 'order', id: '1' }, { kind: 'order', id: '2' },
    ]);
});
it('shadow caches without touching the desk; a new source instance resumes local ids', async () => {
  const { h, api, options, source } = setup(); api.posts = [post()];
  await source.poll(); expect(h.core.items()).toHaveLength(0);
  api.posts.push(post(2, { content: 'answer', author_kind: 'agent' }));
  api.revision = 2; api.conversations[0]!.revision = 2; api.conversations[0]!.changed_message_ids = '[2]';
  api.requests = [];
  const restarted = new DeskTangoSource(options); await restarted.poll();
  expect(api.requests).toContain('/conversations?updatedAfter=1');
  expect(api.requests).toContain('/conversations/thread%3A6000/messages?after=1&limit=500');
  expect(h.core.store.marker('tango:messages:thread:6000')).toBe('2');
  source.observeDiscord('thread:6000', [], NOW - 1000);
  // Config-only cutover materializes cached posts even with no new global revision.
  await new DeskTangoSource({ ...options, mode: 'tango' }).poll();
  expect(h.core.store.messages('discord:thread:6000').map(p => p.text)).toEqual(['question', 'answer']);
});
it('push reads immediately, uses author_kind, and refreshes older attachment metadata', async () => {
  const { h, api, source } = setup('tango'); api.posts = [post(1, { content: '🖥️ an agent says this', author_kind: 'agent' })];
  await source.push('thread:6000', 1);
  expect(h.core.store.messages('discord:thread:6000')[0]?.author).toBe('agent');
  api.posts[0]!.attachments = JSON.stringify([{ name: 'x.png', contentType: 'image/png', localPath: 'attachments/x.png' }]);
  await source.push('thread:6000', 1);
  expect(h.core.store.messages('discord:thread:6000')[0]?.attachments?.[0]?.url).toBe('/api/desk/tango-attachments/1/0');
  expect(h.core.store.messages('discord:thread:6000')).toHaveLength(1);
});
it('failed reads do not advance global cursors; excluded agents never enter the cache', async () => {
  const { h, api, source } = setup(); api.fail = true;
  await expect(source.poll()).rejects.toThrow('503'); expect(h.core.store.marker('tango:changes')).toBeNull();
  api.fail = false; api.posts = [post()]; api.conversations[0]!.agent_id = 'isolated'; await source.poll();
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM desk_tango_posts').get()).toEqual({ n: 0 });
});
it('a push arriving during a fetch gets a trailing read, not the stale response', async () => {
  const { h, api, options, source } = setup('tango'); api.posts = [post()]; await source.poll();
  let release!: () => void; let started!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { started = resolve; });
  let once = true;
  const delayed = new DeskTangoSource({ ...options, fetchImpl: async (...args) => {
    const response = await api.fetch(...args);
    if (once) { once = false; started(); await blocked; }
    return response;
  } });
  const first = delayed.refresh('thread:6000'); await entered;
  api.posts.push(post(2, { author_kind: 'agent', content: 'later' }));
  const second = delayed.push('thread:6000', 2); release(); await Promise.all([first, second]);
  expect(h.core.store.messages('discord:thread:6000').map(p => p.text)).toContain('later');
});
it('shadow comparison joins chunks without hiding missing chunks and reports resolution', async () => {
  const { api, source } = setup(); const a = msg(0, 'agent', 'first'); const b = msg(1, 'agent', 'second');
  api.posts = [post(1, { content: 'first second', discord_message_ids: JSON.stringify([a.id, b.id]) })];
  source.observeDiscord('thread:6000', [a, b], NOW - 1000); await source.poll();
  expect(source.report()[0]?.differences).toEqual([]);
  source.observeDiscord('thread:6000', [{ ...b, content: 'changed' }], NOW - 1000);
  expect(source.report()[0]?.differences).toEqual([{ kind: 'text', id: a.id }]);
});
it('shared chapter rule splits at 30 minutes but preserves open exchanges and parked replies', () => {
  const { h } = setup(); h.source.ingest({ channelId: AGENT.homeChannelId, agent: AGENT, thread: null }, msg(-90, 'agent', 'answer'));
  const latest = h.core.store.latestInConversation(`channel:${AGENT.homeChannelId}`)!;
  const attention = h.core.attention(latest.id);
  expect(joinsChapter(latest, 'agent', latest.lastActivityAt + 29 * 60_000, attention)).toBe(true);
  expect(joinsChapter(latest, 'agent', latest.lastActivityAt + 30 * 60_000, attention)).toBe(false);
  expect(joinsChapter({ ...latest, nextStep: 'working' }, 'agent', NOW, attention)).toBe(true);
  expect(joinsChapter(latest, 'agent', NOW, { ...attention, disposition: 'parked' })).toBe(true);
  expect(joinsChapter(latest, 'agent', NOW, { ...attention, disposition: 'done' })).toBe(false);
});
it('store-driven Discord source only reads intake, retaining its writebacks and reactions', async () => {
  const { h } = setup();
  const { DeskDiscordSource } = await import('../server/desk/source-discord.js');
  const source = new DeskDiscordSource({ core: h.core, discord: h.discord, agents: [AGENT], ownerIds: [],
    now: () => NOW, intakeOnly: true, intake: [{ channelId: '7000', agentId: AGENT.id, label: 'Requests', webhookIds: ['form'] }], postToBot: async () => 'ok' });
  h.discord.push(AGENT.homeChannelId, msg(0, 'owner', 'home'));
  h.discord.push('7000', msg(0, 'owner', 'request'));
  expect(await source.poll()).toMatchObject({ conversations: 1, messages: 1 });
  expect(await source.catchUp(AGENT.homeChannelId)).toBe(0);
  expect(h.core.store.latestInConversation(`channel:${AGENT.homeChannelId}`)).toBeNull();
  expect(h.core.store.latestInConversation('channel:7000')).not.toBeNull();
});
it('reports an entire conversation missing from the store after the successful global read', async () => {
  const { api, source } = setup(); api.conversations = [];
  const message = msg(0, 'owner', 'not recorded');
  source.observeDiscord('thread:6000', [message], NOW - 1000);
  await source.poll();
  expect(source.report()[0]?.differences).toEqual([{ kind: 'missing-tango', id: message.id }]);
});
it('cutover does not resurrect an unobserved archived backfill conversation', async () => {
  const { h, api, source, options } = setup(); api.posts = [post()];
  await source.poll();
  const cutover = new DeskTangoSource({ ...options, mode: 'tango' }); await cutover.poll();
  expect(h.core.items()).toHaveLength(0);
  api.posts.push(post(2, { author_kind: 'agent', content: 'new activity' }));
  await cutover.push('thread:6000', 2);
  expect(h.core.store.messages('discord:thread:6000').map(p => p.text)).toEqual(['new activity']);
});
it('a later revision repairs text without adding another desk post', async () => {
  const { h, api, source } = setup('tango'); api.posts = [post()]; await source.poll();
  api.posts[0]!.content = 'enriched'; await source.push('thread:6000', 1);
  expect(h.core.store.messages('discord:thread:6000').map(p => p.text)).toEqual(['enriched']);
});
it('reads every local-id page and persists the final cursor', async () => {
  const { h, api, source } = setup();
  api.posts = Array.from({ length: 501 }, (_, i) => post(i + 1));
  await source.poll();
  expect(api.requests).toContain('/conversations/thread%3A6000/messages?after=500&limit=500');
  expect(h.core.store.marker('tango:messages:thread:6000')).toBe('501');
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM desk_tango_posts').get()).toEqual({ n: 501 });
});
it('bootstraps a shadow snapshot even when the pre-existing Discord cursor is already caught up', async () => {
  const { h, api, source } = setup();
  const message = msg(0, 'agent', 'already on desk');
  h.discord.threads.push({ id: '6000', parent_id: AGENT.homeChannelId, name: 'Fixture', last_message_id: message.id });
  h.discord.push('6000', message); await h.source.poll();
  expect(h.core.store.marker('discord:6000')).toBe(message.id);
  const { DeskDiscordSource } = await import('../server/desk/source-discord.js');
  const shadowDiscord = new DeskDiscordSource({ core: h.core, discord: h.discord, agents: [AGENT], ownerIds: [], now: () => NOW,
    postToBot: async () => 'ok', needsSnapshot: key => !source.hasDiscordSnapshot(key), onRead: (key, messages, since) => source.observeDiscord(key, messages, since) });
  api.posts = [post(1, { content: message.content, discord_message_ids: JSON.stringify([message.id]) })];
  await shadowDiscord.poll(); await source.poll();
  expect(source.report().find(r => r.key === 'thread:6000')?.differences).toEqual([]);
  expect(h.core.store.messages('discord:thread:6000')).toHaveLength(1);
});
it('leaves stored intake posts and threads outside the agent home channel to Discord', async () => {
  const { h, api, source } = setup('tango');
  api.conversations[0]!.conversation_key = 'channel:7000';
  api.conversations[0]!.discord_channel_id = '7000';
  api.posts = [post(1, { conversation_key: 'channel:7000' })];
  await source.poll(); expect(h.core.items()).toHaveLength(0);
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM desk_tango_posts').get()).toEqual({ n: 0 });
});
it('resumes after closing and reopening the desk SQLite file', async () => {
  const { h, api, source, options } = setup(); api.posts = [post()]; await source.poll();
  h.core.close(); h.db.close();
  const { DatabaseSync } = await import('node:sqlite'); const path = await import('node:path');
  const { DeskCore } = await import('../server/desk/core.js'); const { DeskStore } = await import('../server/desk/store.js');
  const db = new DatabaseSync(path.join(h.dir, 'screen.db'));
  const core = new DeskCore({ store: new DeskStore(db), summarize: h.summarizer.impl });
  try {
    api.posts.push(post(2)); api.conversations[0]!.revision = 2; api.conversations[0]!.changed_message_ids = '[2]'; api.revision = 2; api.requests = [];
    await new DeskTangoSource({ ...options, core }).poll();
    expect(api.requests).toContain('/conversations?updatedAfter=1');
    expect(api.requests).toContain('/conversations/thread%3A6000/messages?after=1&limit=500');
    expect(core.store.marker('tango:messages:thread:6000')).toBe('2');
  } finally { core.close(); db.close(); }
});

it('compares backfilled posts in mirror chronology, sorts legacy chunk ids and strips reply wrappers', () => {
  const a = msg(-3, 'agent', 'first'); const b = msg(-2, 'agent', 'second');
  const c = msg(-1, 'owner', 'question'); const wrapped = { ...c, content: '[↪ Reply](https://discord.com/channels/1/2/3)\nquestion' };
  const result = compareConversationPosts([
    post(1, { content: 'question', discord_message_ids: JSON.stringify([c.id]) }),
    post(2, { content: 'first second', discord_message_ids: JSON.stringify([b.id, a.id]) }),
  ], [a, b, wrapped]);
  expect(result).toEqual({ differences: [], exclusions: [] });
  expect(compareConversationPosts([post(2, { content: 'first second', discord_message_ids: JSON.stringify([b.id, a.id]) })], [a]).differences)
    .toContainEqual({ kind: 'missing-discord', id: b.id });
});
it('explains known system events and unmirrored voice without hiding unknown missing posts', () => {
  const result = compareConversationPosts([
    post(1, { discord_message_type: 18 }),
    post(2, { input_source: 'voice-bridge', discord_message_ids: '[]' }),
    post(3, { discord_message_ids: '[]' }),
  ], []);
  expect(result.exclusions).toEqual([{ id: '1', reason: 'discord-system-event' }, { id: 'local:2', reason: 'unmirrored-voice' }]);
  expect(result.differences).toEqual([{ kind: 'missing-discord', id: 'local:3' }]);
});
it('replays an older cache once to populate new comparison metadata', async () => {
  const { h, api, source, options } = setup(); api.posts = [post()]; await source.poll();
  h.db.prepare("DELETE FROM desk_markers WHERE key='tango:cache-format'").run();
  api.posts[0]!.input_source = 'voice-bridge'; api.requests = [];
  await new DeskTangoSource(options).poll();
  expect(api.requests).toContain('/conversations?updatedAfter=0');
  expect(api.requests).toContain('/conversations/thread%3A6000/messages?after=0&limit=500');
  api.requests = []; await new DeskTangoSource(options).poll();
  expect(api.requests).not.toContain('/conversations?updatedAfter=0');
});
it('starts and replies without a Discord adapter; mirror metadata never changes native message identity', async () => {
  const { h, api, options } = setup('tango');
  const key = 'conv:00000000000000000000000001';
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const source = new DeskTangoSource({ ...options, token: 'fixture', fetchImpl: async (url, init) => {
    if (init?.method === 'POST') {
      expect((init.headers as Record<string, string>)['X-Tango-Collaboration-Token']).toBe('fixture');
      sent.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init.body)) });
      return Response.json({ delivered: true, conversationKey: key });
    }
    return api.fetch(url, init);
  } });
  expect(await source.start({ agentId: AGENT.id, data: { text: 'hello' } })).toEqual({ ok: true, threadId: key, conversationKey: key });
  api.conversations = [{ conversation_key: key, agent_id: AGENT.id, kind: 'thread', title: 'Native', discord_channel_id: null, discord_thread_id: null, revision: 1, changed_message_ids: '[1,2]' }];
  api.posts = [post(1, { conversation_key: key, discord_message_ids: '[]' }), post(2, { conversation_key: key, author_kind: 'agent', discord_message_ids: '[]', content: 'answer' })];
  await source.push(key, 2);
  const item = h.core.itemForConversation(key)!; expect(item.id).toBe(`tango:${key}`); expect(source.owns(item)).toBe(true);
  expect(await source.reply(item, 'next', { commandId: 'retry-id' })).toEqual({ ok: true });
  expect(sent.map(r => r.path)).toEqual(['/conversations/start', '/conversations/turn']);
  expect(sent[1]!.body).toMatchObject({ conversationKey: key, replyToMessageId: 'tango:2', commandId: 'retry-id', data: { text: 'next' } });
  api.posts[1]!.discord_message_ids = '["123456"]'; await source.push(key, 2);
  expect(h.core.store.messages(item.id).map(p => p.messageId)).toEqual(['tango:1', 'tango:2']);
});
it("a Loom brief on a Tango-mode row is answered through Loom, not the conversation source that owns the row", async () => {
  const { h, api, source } = setup('tango'); api.posts = [post()]; await source.poll();
  const { DeskCore } = await import('../server/desk/core.js');
  const sent: string[] = [];
  const loom = { owns: (item: { source: string }) => item.source === 'loom', resolvePending: async (item: { id: string }) => { sent.push(item.id); return { ok: true as const }; } };
  const core = new DeskCore({ store: h.core.store, adapters: [source, loom] as never });
  try {
    const pending = { kind: 'question', requestId: 'decision:D-1', at: NOW, questions: [{ id: 'decision', header: 'Your options', question: 'Buy?', options: [{ label: 'A · Buy' }], multiSelect: false }] };
    core.setFacts('discord:thread:6000', { pending, openBrief: pending, loomThreadId: 'thread-1' } as never);
    expect(await core.command({ commandId: 'c1', type: 'respond', itemId: 'discord:thread:6000', args: { requestId: 'decision:D-1', answers: { decision: 'A · Buy' } } })).toMatchObject({ status: 'applied' });
    expect(sent).toEqual(['loom:thread-1']);
  } finally { core.close(); }
});
