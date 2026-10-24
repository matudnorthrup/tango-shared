import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { TangoStorage } from "../src/storage.js";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-store-")); dirs.push(dir);
  const file = path.join(dir, "db.sqlite");
  const storage = new TangoStorage(file);
  storage.upsertSession({ id: "session", type: "persistent", agent: "test", channels: [] });
  return { storage, file };
}
it("fresh store accepts every author, source and post kind, keeps full text and all chunk ids", () => {
  const { storage } = setup();
  for (const [i, [kind, authorKind, direction]] of ([
    ["reply", "agent", "outbound"], ["check-in", "agent", "outbound"],
    ["context-pressure", "system", "system"], ["rotation", "system", "system"], ["error", "system", "error"],
    ["owner", "owner", "inbound"], ["requester", "requester", "inbound"],
  ] as const).entries()) {
    const text = `${kind} ${"complete text ".repeat(500)}`;
    const id = storage.recordConversationPost({ sessionId: "session", agentId: "test", conversationKey: "thread:123",
      direction, source: i % 2 ? "voice" : "desk", authorKind, content: text,
      discordMessageId: `${i}2`, discordMessageIds: [`${i}1`, `${i}2`] });
    expect(storage.getMessage(id)?.content).toBe(text);
    expect(storage.findConversationPostByDiscordId(`${i}1`)).toBe(id);
    expect(storage.recordConversationPost({ sessionId: "session", conversationKey: "thread:123", direction,
      source: "tango", authorKind, content: text, discordMessageIds: [`${i}2`] })).toBe(id);
  }
  expect(storage.getDatabase().prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 7 });
  expect(storage.getDatabase().prepare("SELECT kind FROM conversations").get()).toEqual({ kind: "thread" });
  storage.close();
});
it.each([false, true])("upgrades preserving ids and references, with pre-existing orphan=%s", (hasOrphan) => {
  const { storage, file } = setup();
  const id = storage.insertMessage({ sessionId: "session", direction: "inbound", source: "discord", content: "old", discordMessageId: "100" });
  storage.close();
  // Recreate the precise pre-85 messages table; other tables stay at their current schema.
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA foreign_keys=OFF; DROP TABLE conversation_discord_messages; DROP TABLE conversations;
    CREATE TABLE messages_old (id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,agent_id TEXT,provider_name TEXT,
    direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound','system','error')),
    source TEXT NOT NULL CHECK(source IN ('discord','tango')),discord_message_id TEXT,discord_channel_id TEXT,
    discord_user_id TEXT,discord_username TEXT,content TEXT NOT NULL,metadata_json TEXT,
    created_at TEXT NOT NULL DEFAULT(datetime('now')),visibility TEXT NOT NULL DEFAULT 'public',
    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE);
    INSERT INTO messages_old SELECT id,session_id,agent_id,provider_name,direction,source,discord_message_id,discord_channel_id,
    discord_user_id,discord_username,content,metadata_json,created_at,visibility FROM messages;
    DROP TABLE messages; ALTER TABLE messages_old RENAME TO messages;
    CREATE TABLE test_reference (message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE);
    INSERT INTO test_reference VALUES (${id}); PRAGMA user_version=84;`);
  db.exec("INSERT INTO messages (id,session_id,direction,source,content) VALUES (9000,'session','inbound','discord','deleted'); DELETE FROM messages WHERE id=9000;");
  if (hasOrphan) db.exec("INSERT INTO test_reference VALUES (8000)");
  db.close();
  const upgraded = new TangoStorage(file);
  expect(upgraded.getMessage(id)?.content).toBe("old");
  expect(upgraded.getDatabase().prepare("SELECT * FROM test_reference").get()).toEqual({ message_id: id });
  expect(upgraded.getDatabase().prepare("PRAGMA foreign_key_check").all()).toHaveLength(hasOrphan ? 1 : 0);
  expect(upgraded.getDatabase().prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(upgraded.recordConversationPost({ sessionId: "session", direction: "inbound", source: "voice", content: "next",
    conversationKey: "channel:123", authorKind: "owner", replyToMessageId: id })).toBeGreaterThan(9000);
  upgraded.close();
});

it("enriches a legacy last-chunk anchor in chronological order and preserves the home owner", () => {
  const { storage } = setup();
  const base = { sessionId: "session", direction: "outbound" as const, source: "tango" as const,
    authorKind: "agent" as const, conversationKey: "thread:123", content: "full reply" };
  const id = storage.insertMessage({ ...base, agentId: "guest", discordMessageId: "200" });
  storage.getDatabase().prepare("UPDATE messages SET discord_message_ids='[\"200\"]' WHERE id=?").run(id);
  storage.recordConversationPost({ ...base, localMessageId: id, agentId: "guest", conversationAgentId: "host", discordMessageIds: ["100", "200"] });
  storage.recordConversationPost({ ...base, agentId: "another-guest", discordMessageId: "300" });
  expect(storage.getDatabase().prepare("SELECT discord_message_ids FROM messages WHERE id=?").get(id)).toEqual({ discord_message_ids: '["100","200"]' });
  expect(storage.getDatabase().prepare("SELECT agent_id FROM conversations").get()).toEqual({ agent_id: "host" });
  storage.close();
});
