import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { DiscordLoomLinks, parseConversationKey } from '../server/desk/discord-loom-links.js';

describe('Discord conversations behind Loom threads', () => {
  it("reads the bot's conversation key", () => {
    expect(parseConversationKey('["sierra","thread:111"]')).toEqual({ agentId: 'sierra', conversation: 'thread:111' });
    expect(parseConversationKey('["sierra","channel:5000"]')).toEqual({ agentId: 'sierra', conversation: 'channel:5000' });
    for (const raw of ['sierra', '["sierra"]', '["sierra","dm:1"]', '{"a":1}']) expect(parseConversationKey(raw)).toBeNull();
  });

  it("finds a Loom thread's conversation in the bot's database, read-only, and survives one not made yet", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-links-'));
    const dbPath = path.join(dir, 'tango.sqlite');
    try {
      const links = new DiscordLoomLinks({ dbPath });
      // No database yet: a failed lookup (undefined), tried again later, not "maps nowhere" (null).
      expect(links.linkOf('loom-1')).toBeUndefined();
      const db = new DatabaseSync(dbPath);
      db.exec('CREATE TABLE provider_sessions (conversation_key TEXT, session_id TEXT, agent_id TEXT, provider_name TEXT, provider_session_id TEXT, updated_at TEXT)');
      db.prepare('INSERT INTO provider_sessions VALUES (?,?,?,?,?,?)').run('["sierra","thread:111"]', 's', 'sierra', 'loom', 'loom-1', '2026-10-20 10:00:00');
      db.prepare('INSERT INTO provider_sessions VALUES (?,?,?,?,?,?)').run('["sierra","thread:222"]', 's', 'sierra', 'claude', 'loom-2', '2026-10-20 10:00:00');
      db.close();
      expect(links.linkOf('loom-1')).toEqual({ agentId: 'sierra', conversation: 'thread:111' });
      expect(links.linkOf('loom-2')).toBeNull();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
