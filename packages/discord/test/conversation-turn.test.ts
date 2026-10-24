import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { TangoStorage } from '@tango/core';
import { CONVERSATION_KEY, ConversationMirror, newConversationKey, runConversationTurn } from '../src/conversation-turn.js';
import { parseConversationKey } from '../src/conversation-read.js';
import { buildDiscordMemoryProvenanceEnv, augmentRuntimeConfigWithDiscordProvenance } from '../src/discord-memory-provenance.js';
import { setConversationEvents } from '../src/conversation-posts.js';
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); });
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-test-'));
  const storage = new TangoStorage(path.join(dir, 'test.sqlite'));
  storage.upsertSession({ id: 'session', agent: 'fixture', type: 'persistent', channels: [] });
  cleanups.push(() => { storage.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const input = { conversationKey: newConversationKey(), agentId: 'fixture', sessionId: 'session', author: { kind: 'owner' as const }, text: 'hello', origin: 'desk' as const };
  const result = { response: { text: 'answer', durationMs: 1 }, conversationKey: input.conversationKey, agentId: 'fixture', turnId: 'turn' };
  return { storage, dataDir: dir, input, result };
}
it('generates valid ULIDs; keeps legacy identities and rejects malformed/path keys', () => {
  const keys = new Set(Array.from({ length: 100 }, () => newConversationKey(12345)));
  expect(keys.size).toBe(100);
  for (const key of keys) { expect(CONVERSATION_KEY.test(key)).toBe(true); expect(parseConversationKey(key)?.kind).toBe('conv'); }
  for (const key of ['thread:123', 'channel:456']) expect(parseConversationKey(key)).not.toBeNull();
  for (const key of ['conv:abc', 'conv:8' + '0'.repeat(25), 'conv:' + 'I'.repeat(26), 'conv:../x']) expect(parseConversationKey(key)).toBeNull();
});
it('commits posts and local attachments before runtime/mirror, emits events, and tolerates Discord offline', async () => {
  const { storage, dataDir, input, result } = setup(); const events: unknown[] = [];
  setConversationEvents(storage, event => events.push(event));
  const attachment = path.join(dataDir, 'image.png'); fs.writeFileSync(attachment, 'image');
  const mirror = vi.fn(async ({ id }: { id: number }) => { expect(storage.getMessage(id)).not.toBeNull(); throw new Error('Discord offline'); });
  const mirrorError = vi.fn();
  const turn = await runConversationTurn({ ...input, attachments: [{ name: 'image.png', filePath: attachment }] }, { storage, dataDir, mirror, mirrorError,
    route: async id => {
      expect(storage.getMessage(id)?.content).toBe('hello');
      const row = storage.getDatabase().prepare('SELECT attachments FROM messages WHERE id=?').get(id) as { attachments: string };
      expect(fs.readFileSync(path.join(dataDir, JSON.parse(row.attachments)[0].localPath), 'utf8')).toBe('image');
      return result;
    } });
  await Promise.resolve();
  expect(turn?.messageId).toBe(1); expect(turn?.responseMessageId).toBe(2);
  expect(storage.getMessage(2)?.content).toBe('answer');
  expect(mirror).toHaveBeenCalledTimes(2); expect(mirrorError).toHaveBeenCalledTimes(2);
  expect(events).toContainEqual(expect.objectContaining({ type: 'message.created', messageId: 2 }));
});
it('deduplicates Discord ingress before awaiting runtime, including concurrent duplicates and restart', async () => {
  const { storage, dataDir, input, result } = setup();
  const route = vi.fn(async () => result);
  const discord = { ...input, origin: 'discord' as const, discordMessageId: '12345' };
  const turns = await Promise.all([runConversationTurn(discord, { storage, dataDir, route }), runConversationTurn(discord, { storage, dataDir, route })]);
  expect(turns.filter(Boolean)).toHaveLength(1); expect(route).toHaveBeenCalledTimes(1);
  expect(await runConversationTurn(discord, { storage, dataDir, route })).toBeNull();
});
it('serializes lazy mirror work and lets the next post retry after failure', async () => {
  const mirror = new ConversationMirror(); const seen: number[] = [];
  const first = mirror.enqueue('conv', async () => { await Promise.resolve(); seen.push(1); throw Error('offline'); });
  const second = mirror.enqueue('conv', async () => { expect(seen).toEqual([1]); seen.push(2); });
  await expect(first).rejects.toThrow('offline'); await second; await mirror.settled(); expect(seen).toEqual([1, 2]);
});
it('uses local provenance and omits Discord fields without a mirror', () => {
  expect(buildDiscordMemoryProvenanceEnv({ conversationKey: newConversationKey(), channelId: '', messageId: '42' })).toEqual(expect.objectContaining({ TANGO_MESSAGE_ID: '42' }));
  expect(buildDiscordMemoryProvenanceEnv({ conversationKey: newConversationKey(), channelId: '', messageId: '42' })).not.toHaveProperty('TANGO_DISCORD_CHANNEL_ID');
});
it('creates one lazy mirror thread, stores its ids and reuses them after a new mirror instance', async () => {
  const { storage, dataDir, input, result } = setup();
  await runConversationTurn(input, { storage, dataDir, route: async () => result });
  const { ensureConversationMirror } = await import('../src/conversation-turn.js');
  const create = vi.fn(async () => ({ channelId: '123', threadId: '456' }));
  const queue = new ConversationMirror();
  await Promise.all([1, 2].map(() => queue.enqueue(input.conversationKey, async () => { await ensureConversationMirror(storage, input.conversationKey, create); })));
  expect(create).toHaveBeenCalledTimes(1);
  expect(await ensureConversationMirror(storage, input.conversationKey, create)).toEqual({ channelId: '123', threadId: '456' });
  expect(create).toHaveBeenCalledTimes(1);
});
it('rejects isolated, disabled, missing and cross-agent write targets; defaults to mirroring', async () => {
  const { canAcceptConversationInput: allowed, mirrorsPosts } = await import('../src/conversation-turn.js');
  expect(allowed({}, true, 'fixture', 'fixture')).toBe(true);
  expect(allowed({}, true, 'fixture', null, true)).toBe(true);
  expect(allowed({ isolated: true }, true, 'fixture', 'fixture')).toBe(false);
  expect(allowed({}, false, 'fixture', 'fixture')).toBe(false);
  expect(allowed(undefined, true, 'fixture', 'fixture')).toBe(false);
  expect(allowed({}, true, 'fixture', 'other')).toBe(false);
  expect(mirrorsPosts(undefined)).toBe(true); expect(mirrorsPosts('both')).toBe(true);
  expect(mirrorsPosts('outbound')).toBe(true); expect(mirrorsPosts('off')).toBe(false);
});
it('maps Discord thread and home messages to local reply ids and attachment metadata without fetching Discord', async () => {
  const { storage, dataDir, input, result } = setup();
  await runConversationTurn({ ...input, discordMessageId: '100' }, { storage, dataDir, route: async () => result });
  const { discordMessageToTurn } = await import('../src/conversation-turn.js');
  const message = { id: '101', content: 'reply', channelId: '456', createdAt: new Date('2026-10-22T12:00:00Z'), author: { id: 'owner', username: 'Owner' },
    channel: { isThread: () => true, parentId: '123' }, reference: { messageId: '100' },
    attachments: new Map([['file', { name: 'photo.png', url: 'https://cdn.discordapp.com/attachments/photo.png', contentType: 'image/png', size: 12 }]]) };
  const context = { agentId: 'fixture', sessionId: 'session' };
  expect(discordMessageToTurn(message, storage, context)).toMatchObject({ conversationKey: 'thread:456', channelId: '123', threadId: '456', replyToMessageId: 1, discordMessageId: '101', attachments: [{ name: 'photo.png', size: 12 }] });
  expect(discordMessageToTurn({ ...message, channel: { isThread: () => false } }, storage, context).conversationKey).toBe('channel:456');
  expect(discordMessageToTurn(message, storage, { ...context, conversationKey: input.conversationKey }).conversationKey).toBe(input.conversationKey);
});
