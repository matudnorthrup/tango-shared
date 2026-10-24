import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { TangoStorage } from '../src/storage.js';
it('upgrades a v85 store by seeding revisions and tracking attachment updates without changing ids', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-revision-'));
  const file = path.join(dir, 'db.sqlite');
  let storage = new TangoStorage(file);
  try {
    storage.upsertSession({ id: 'fixture', type: 'persistent', agent: 'fixture', channels: [] });
    const id = storage.recordConversationPost({ sessionId: 'fixture', conversationKey: 'channel:123', direction: 'inbound', source: 'discord', authorKind: 'owner', content: 'existing' });
    storage.getDatabase().exec('DROP TRIGGER conversation_message_insert; DROP TRIGGER conversation_message_update; DROP TABLE conversation_changes; PRAGMA user_version=85;');
    storage.close(); storage = new TangoStorage(file);
    expect(storage.getMessage(id)?.content).toBe('existing');
    const revision = (storage.getDatabase().prepare('SELECT revision FROM conversation_changes WHERE message_id=?').get(id) as { revision: number }).revision;
    storage.getDatabase().prepare('UPDATE messages SET attachments=? WHERE id=?').run('[{"name":"ready"}]', id);
    expect(storage.getDatabase().prepare('SELECT COUNT(*) AS n FROM conversation_changes').get()).toEqual({ n: 1 });
    expect((storage.getDatabase().prepare('SELECT revision FROM conversation_changes WHERE message_id=?').get(id) as { revision: number }).revision).toBeGreaterThan(revision);
    expect(storage.getDatabase().prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
    expect(storage.getDatabase().prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { storage.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
