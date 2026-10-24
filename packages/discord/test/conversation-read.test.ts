import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { TangoStorage } from '@tango/core';
import { conversationRead, parseConversationKey } from '../src/conversation-read.js';
import { recordConversationPost, setConversationEvents, settleConversationAttachments } from '../src/conversation-posts.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const fn of cleanup.splice(0)) await fn(); });
async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-api-'));
  vi.stubEnv('TANGO_DB_PATH', path.join(dir, 'db.sqlite'));
  const storage = new TangoStorage(path.join(dir, 'db.sqlite'));
  storage.upsertSession({ id: 'fixture', agent: 'fixture', type: 'persistent', channels: [] });
  cleanup.push(async () => { storage.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const post = (extra = {}) => recordConversationPost(storage, dir, { sessionId: 'fixture', agentId: 'fixture', conversationKey: 'thread:123', authorKind: 'owner', direction: 'inbound', source: 'discord', content: 'hello', ...extra });
  const request = async (url: string, token = 'secret', method = 'GET') => {
    let status = 0; let bytes = Buffer.alloc(0);
    const res = { writeHead(code: number) { status = code; }, end(body: string | Buffer) { bytes = Buffer.from(body); } };
    const handled = await conversationRead({ url, method, headers: { 'x-tango-collaboration-token': token } } as IncomingMessage, res as unknown as ServerResponse, storage, dir, 'secret');
    return { handled, status, bytes, json: () => JSON.parse(bytes.toString()) };
  };
  return { dir, storage, post, request };
}
it('authenticates all reads, rejects writes and invalid keys/cursors', async () => {
  const { request } = await setup();
  expect((await request('/conversations', 'bad')).status).toBe(403);
  expect((await request('/conversations', 'secret', 'POST')).status).toBe(405);
  expect((await request('/conversations?updatedAfter=-1')).status).toBe(400);
  expect((await request('/conversations/conv%3Ax/messages')).status).toBe(400);
  expect(parseConversationKey('channel:456')).toEqual({ kind: 'channel', id: '456' });
});
it('local id pages exclude private posts, revisions recover old-row attachment changes', async () => {
  const { storage, post, request } = await setup();
  const first = post(); const second = post({ content: 'second' }); post({ visibility: 'internal' });
  const page = (await request(`/conversations/thread%3A123/messages?after=${first}&limit=1`)).json();
  expect(page.messages.map((m: { id: number }) => m.id)).toEqual([second]);
  expect((await request(`/conversations/thread%3A123/messages?after=${second}`)).json().messages).toEqual([]);
  const initial = (await request('/conversations')).json();
  expect(initial.conversations).toHaveLength(1);
  expect((await request(`/conversations?updatedAfter=${initial.cursor}`)).json().conversations).toEqual([]);
  storage.getDatabase().prepare('UPDATE messages SET attachments=? WHERE id=?').run('[{"name":"later"}]', first);
  const changed = (await request(`/conversations?updatedAfter=${initial.cursor}`)).json();
  expect(changed.cursor).toBeGreaterThan(initial.cursor);
  expect(JSON.parse(changed.conversations[0].changed_message_ids)).toEqual([first]);
  expect(storage.getDatabase().prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
});
it('serves local attachments with CDN absent and rejects traversal and symlinks out of data', async () => {
  const { dir, storage, post, request } = await setup();
  const file = path.join(dir, 'input.png'); await fs.writeFile(file, 'local bytes');
  const events = vi.fn(); setConversationEvents(storage, events);
  const id = post({ attachments: [{ name: 'photo.png', contentType: 'image/png', filePath: file }] });
  await settleConversationAttachments(storage);
  expect((await request(`/conversations/attachments/${id}/0`)).bytes.toString()).toBe('local bytes');
  expect(events.mock.calls.map(c => c[0].type)).toEqual(['message.created', 'conversation.updated', 'conversation.updated']);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-'));
  cleanup.push(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'private'), 'private');
  await fs.symlink(path.join(outside, 'private'), path.join(dir, 'link'));
  for (const localPath of ['link', path.join(outside, 'private'), path.relative(dir, path.join(outside, 'private'))]) {
    storage.getDatabase().prepare('UPDATE messages SET attachments=? WHERE id=?').run(JSON.stringify([{ name: 'x', localPath }]), id);
    expect((await request(`/conversations/attachments/${id}/0`)).status).toBe(403);
  }
});
it('notification failure cannot fail a post', async () => {
  const { storage, post } = await setup();
  setConversationEvents(storage, () => { throw new Error('unreachable'); });
  expect(post()).toBeGreaterThan(0);
});
