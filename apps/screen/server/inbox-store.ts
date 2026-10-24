import type { DatabaseSync } from 'node:sqlite';

// The agent inbox: one item per open thing an agent has said to the owner.
// States follow the voice operator's attention ledger, so voice and screens
// share one list:
//
//   queued    new, not yet seen or heard
//   heard     the operator spoke it and the delivery check confirmed it
//   read      the owner acted on it: replied, reacted, or marked it
//   later     the owner parked it on purpose
//   dismissed the owner skipped it
//
// Status is a separate axis, describing the conversation rather than the
// owner's attention:
//
//   needs_you    the agent asked something and is waiting
//   in_progress  the owner spoke last; the agent is working
//   done         the agent reported back; nothing asked

export type InboxState = 'queued' | 'heard' | 'read' | 'later' | 'dismissed';
export type InboxStatus = 'needs_you' | 'in_progress' | 'done';
/** exchange and group are pre-topic kinds; a rebuild replaces them. */
export type InboxKind = 'thread' | 'topic' | 'task' | 'exchange' | 'group';
export const OPEN_STATES: readonly InboxState[] = ['queued', 'heard', 'later'];

export interface InboxItem {
  id: string;
  kind: InboxKind;
  agentId: string;
  agentName: string;
  /** Channel or thread holding the conversation. */
  channelId: string | null;
  /** Thread title, when it lives in a thread. */
  place: string | null;
  taskId: string | null;
  summary: string;
  /** request: the owner's ask, shown while the agent works on it. */
  summarySource: 'model' | 'text' | 'operator' | 'request';
  /** The latest agent text (for detail and summaries). */
  lastText: string;
  status: InboxStatus;
  state: InboxState;
  stateAt: number;
  note: string | null;
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
  lastAgentMessageId: string | null;
  /**
   * 👍: the owner has seen it and will come back to it ("I'll call you"). It stays
   * open but quiet: not waiting-on-you, never expires, until new agent activity.
   */
  acked: boolean;
}

export interface InboxMessageRow {
  messageId: string;
  itemId: string;
  channelId: string;
  author: 'agent' | 'owner' | 'other';
  at: number;
  text: string;
}

interface ItemRow {
  id: string;
  kind: string;
  agent_id: string;
  agent_name: string;
  channel_id: string | null;
  place: string | null;
  task_id: string | null;
  summary: string;
  summary_source: string;
  last_text: string;
  status: string;
  state: string;
  state_at: number;
  note: string | null;
  created_at: number;
  last_activity_at: number;
  message_count: number;
  last_agent_message_id: string | null;
  acked: number;
}

function toItem(row: ItemRow): InboxItem {
  return {
    id: row.id,
    kind: row.kind as InboxKind,
    agentId: row.agent_id,
    agentName: row.agent_name,
    channelId: row.channel_id,
    place: row.place,
    taskId: row.task_id,
    summary: row.summary,
    summarySource: row.summary_source as InboxItem['summarySource'],
    lastText: row.last_text,
    status: row.status as InboxStatus,
    state: row.state as InboxState,
    stateAt: row.state_at,
    note: row.note,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    messageCount: row.message_count,
    lastAgentMessageId: row.last_agent_message_id,
    acked: row.acked === 1,
  };
}

const KEEP_MS = 7 * 86_400_000;

export class InboxStore {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number = Date.now) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS inbox_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        channel_id TEXT,
        place TEXT,
        task_id TEXT,
        summary TEXT NOT NULL DEFAULT '',
        summary_source TEXT NOT NULL DEFAULT 'text',
        last_text TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'done',
        state TEXT NOT NULL DEFAULT 'queued',
        state_at INTEGER NOT NULL,
        note TEXT,
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        last_agent_message_id TEXT
      );
      CREATE INDEX IF NOT EXISTS inbox_items_activity ON inbox_items(last_activity_at);
      CREATE TABLE IF NOT EXISTS inbox_messages (
        message_id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        author TEXT NOT NULL,
        at INTEGER NOT NULL,
        text TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS inbox_messages_item ON inbox_messages(item_id, at);
      CREATE TABLE IF NOT EXISTS inbox_markers (
        channel_id TEXT PRIMARY KEY,
        last_message_id TEXT NOT NULL
      );
    `);
    const columns = (db.prepare('PRAGMA table_info(inbox_items)').all() as Array<{ name: string }>).map((column) => column.name);
    if (!columns.includes('acked')) db.exec('ALTER TABLE inbox_items ADD COLUMN acked INTEGER NOT NULL DEFAULT 0');
    // T3's reasoning summaries (role "system") were once filed as the owner's words (10/07).
    const reasoning = db.prepare("SELECT item_id, COUNT(*) AS n FROM inbox_messages WHERE message_id LIKE 't3:reasoning:%' GROUP BY item_id").all() as Array<{ item_id: string; n: number }>;
    if (reasoning.length) {
      db.exec("DELETE FROM inbox_messages WHERE message_id LIKE 't3:reasoning:%'");
      for (const { item_id: itemId, n } of reasoning) db.prepare('UPDATE inbox_items SET message_count = MAX(0, message_count - ?) WHERE id = ?').run(n, itemId);
    }
  }

  get(id: string): InboxItem | null {
    const row = this.db.prepare('SELECT * FROM inbox_items WHERE id = ?').get(id) as ItemRow | undefined;
    return row ? toItem(row) : null;
  }

  /** Newest activity first. */
  list(options: { states?: readonly InboxState[]; agentId?: string; sinceMs?: number } = {}): InboxItem[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.states?.length) {
      where.push(`state IN (${options.states.map(() => '?').join(',')})`);
      params.push(...options.states);
    }
    if (options.agentId) {
      where.push('agent_id = ?');
      params.push(options.agentId);
    }
    if (options.sinceMs !== undefined) {
      where.push('last_activity_at >= ?');
      params.push(options.sinceMs);
    }
    const sql = `SELECT * FROM inbox_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY last_activity_at DESC`;
    return (this.db.prepare(sql).all(...params) as unknown as ItemRow[]).map(toItem);
  }

  create(item: Pick<InboxItem, 'id' | 'kind' | 'agentId' | 'agentName'> & Partial<InboxItem>): InboxItem {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO inbox_items (id, kind, agent_id, agent_name, channel_id, place, task_id, summary, summary_source, last_text,
           status, state, state_at, note, created_at, last_activity_at, message_count, last_agent_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.kind,
        item.agentId,
        item.agentName,
        item.channelId ?? null,
        item.place ?? null,
        item.taskId ?? null,
        item.summary ?? '',
        item.summarySource ?? 'text',
        item.lastText ?? '',
        item.status ?? 'done',
        item.state ?? 'queued',
        item.stateAt ?? now,
        item.note ?? null,
        item.createdAt ?? now,
        item.lastActivityAt ?? now,
        item.messageCount ?? 0,
        item.lastAgentMessageId ?? null,
      );
    return this.get(item.id)!;
  }

  update(id: string, patch: Partial<Pick<InboxItem, 'summary' | 'summarySource' | 'lastText' | 'status' | 'place' | 'taskId' | 'channelId' | 'lastActivityAt' | 'lastAgentMessageId' | 'agentName'>>): InboxItem | null {
    const columns: Record<string, string> = {
      summary: 'summary',
      summarySource: 'summary_source',
      lastText: 'last_text',
      status: 'status',
      place: 'place',
      taskId: 'task_id',
      channelId: 'channel_id',
      lastActivityAt: 'last_activity_at',
      lastAgentMessageId: 'last_agent_message_id',
      agentName: 'agent_name',
    };
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || !columns[key]) continue;
      sets.push(`${columns[key]} = ?`);
      values.push(value as string | number | null);
    }
    if (sets.length) this.db.prepare(`UPDATE inbox_items SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return this.get(id);
  }

  /**
   * Moves an item's attention state. "read" and "dismissed" hold until new agent
   * activity reopens the item; "heard" never overrides "later" (parked on purpose).
   */
  mark(id: string, state: InboxState, note?: string): InboxItem | null {
    const item = this.get(id);
    if (!item) return null;
    if (state === 'heard' && (item.state === 'later' || item.state === 'read' || item.state === 'dismissed')) return item;
    this.db
      .prepare('UPDATE inbox_items SET state = ?, state_at = ?, note = ?, acked = CASE WHEN ? THEN acked ELSE 0 END WHERE id = ?')
      .run(state, this.now(), note ?? (state === 'later' ? item.note : null), state === 'heard' ? 1 : 0, id);
    return this.get(id);
  }

  /** 👍: seen, and the owner will pick it up. Open but quiet until the agent says something new. */
  ack(id: string): InboxItem | null {
    const item = this.get(id);
    if (!item) return null;
    this.db.prepare("UPDATE inbox_items SET acked = 1, state = 'heard', state_at = ?, note = 'seen' WHERE id = ?").run(this.now(), id);
    return this.get(id);
  }

  /** New agent activity: back into the open list. A parked item stays parked. */
  reopen(id: string): void {
    const item = this.get(id);
    if (!item) return;
    if (item.acked) this.db.prepare('UPDATE inbox_items SET acked = 0 WHERE id = ?').run(id);
    if (item.state === 'queued' || item.state === 'later') return;
    this.db.prepare("UPDATE inbox_items SET state = 'queued', state_at = ?, note = NULL WHERE id = ?").run(this.now(), id);
  }

  addMessage(message: InboxMessageRow): boolean {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO inbox_messages (message_id, item_id, channel_id, author, at, text) VALUES (?, ?, ?, ?, ?, ?)')
      .run(message.messageId, message.itemId, message.channelId, message.author, message.at, message.text.slice(0, 4000));
    if (result.changes === 0) return false;
    this.db.prepare('UPDATE inbox_items SET message_count = message_count + 1 WHERE id = ?').run(message.itemId);
    return true;
  }

  /** Fills in the text of a message first known only by id (the operator filed it before Discord's copy). */
  fillMessageText(messageId: string, text: string): void {
    this.db.prepare("UPDATE inbox_messages SET text = ? WHERE message_id = ? AND text = ''").run(text.slice(0, 4000), messageId);
  }

  /** Agent messages stored without their text (first known only by id), newest first. */
  emptyAgentMessages(limit = 200): InboxMessageRow[] {
    const rows = this.db
      .prepare("SELECT message_id, item_id, channel_id, author, at, text FROM inbox_messages WHERE author = 'agent' AND text = '' ORDER BY at DESC LIMIT ?")
      .all(limit) as Array<{ message_id: string; item_id: string; channel_id: string; author: string; at: number; text: string }>;
    return rows.map((row) => ({ messageId: row.message_id, itemId: row.item_id, channelId: row.channel_id, author: row.author as InboxMessageRow['author'], at: row.at, text: row.text }));
  }

  /** Forgets one message (it is about to be filed again, elsewhere). */
  removeMessage(messageId: string): void {
    const itemId = this.itemForMessage(messageId);
    if (!itemId) return;
    this.db.prepare('DELETE FROM inbox_messages WHERE message_id = ?').run(messageId);
    this.db.prepare('UPDATE inbox_items SET message_count = MAX(message_count - 1, 0) WHERE id = ?').run(itemId);
  }

  /** Whether this message was read from Discord already (operator-added ids have no text yet). */
  hasMessageText(messageId: string): boolean {
    const row = this.db.prepare("SELECT 1 AS ok FROM inbox_messages WHERE message_id = ? AND text != ''").get(messageId) as { ok: number } | undefined;
    return Boolean(row);
  }

  clear(): void {
    this.db.exec('DELETE FROM inbox_messages; DELETE FROM inbox_items; DELETE FROM inbox_markers;');
  }

  itemForMessage(messageId: string): string | null {
    const row = this.db.prepare('SELECT item_id FROM inbox_messages WHERE message_id = ?').get(messageId) as { item_id: string } | undefined;
    return row?.item_id ?? null;
  }

  /** Oldest first. */
  messages(itemId: string, limit = 20): InboxMessageRow[] {
    const rows = this.db
      .prepare('SELECT message_id, item_id, channel_id, author, at, text FROM inbox_messages WHERE item_id = ? ORDER BY at DESC LIMIT ?')
      .all(itemId, limit) as Array<{ message_id: string; item_id: string; channel_id: string; author: string; at: number; text: string }>;
    return rows
      .reverse()
      .map((row) => ({ messageId: row.message_id, itemId: row.item_id, channelId: row.channel_id, author: row.author as InboxMessageRow['author'], at: row.at, text: row.text }));
  }

  /** The most recent item in a channel, optionally of certain kinds. */
  latestInChannel(channelId: string, kinds?: readonly InboxKind[]): InboxItem | null {
    const kindFilter = kinds?.length ? ` AND kind IN (${kinds.map(() => '?').join(',')})` : '';
    const row = this.db
      .prepare(`SELECT * FROM inbox_items WHERE channel_id = ?${kindFilter} ORDER BY last_activity_at DESC, created_at DESC LIMIT 1`)
      .get(channelId, ...(kinds ?? [])) as ItemRow | undefined;
    return row ? toItem(row) : null;
  }

  /** Moves an item's messages from `sinceAt` on into another item (splitting a topic). */
  moveMessagesFrom(fromId: string, toId: string, sinceAt: number): void {
    this.db.prepare('UPDATE inbox_messages SET item_id = ? WHERE item_id = ? AND at >= ?').run(toId, fromId, sinceAt);
    for (const id of [fromId, toId]) {
      const count = (this.db.prepare('SELECT COUNT(*) AS n FROM inbox_messages WHERE item_id = ?').get(id) as { n: number }).n;
      this.db.prepare('UPDATE inbox_items SET message_count = ? WHERE id = ?').run(count, id);
    }
  }

  /** Folds one item into another: its messages move over and it disappears. */
  mergeInto(fromId: string, toId: string): void {
    const from = this.get(fromId);
    const to = this.get(toId);
    if (!from || !to || fromId === toId) return;
    this.db.prepare('UPDATE inbox_messages SET item_id = ? WHERE item_id = ?').run(toId, fromId);
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM inbox_messages WHERE item_id = ?').get(toId) as { n: number }).n;
    this.db
      .prepare('UPDATE inbox_items SET message_count = ?, last_text = ?, last_agent_message_id = COALESCE(?, last_agent_message_id), last_activity_at = ?, status = ? WHERE id = ?')
      .run(count, from.lastText || to.lastText, from.lastAgentMessageId, Math.max(from.lastActivityAt, to.lastActivityAt), from.status, toId);
    this.db.prepare('DELETE FROM inbox_items WHERE id = ?').run(fromId);
    this.reopen(toId);
  }

  marker(channelId: string): string | null {
    const row = this.db.prepare('SELECT last_message_id FROM inbox_markers WHERE channel_id = ?').get(channelId) as { last_message_id: string } | undefined;
    return row?.last_message_id ?? null;
  }

  setMarker(channelId: string, messageId: string): void {
    this.db
      .prepare('INSERT INTO inbox_markers (channel_id, last_message_id) VALUES (?, ?) ON CONFLICT(channel_id) DO UPDATE SET last_message_id = excluded.last_message_id')
      .run(channelId, messageId);
  }

  /** A week is the horizon, except for things parked on purpose. */
  prune(): number {
    const cutoff = this.now() - KEEP_MS;
    // Parked (later) and seen-and-kept (👍) items stay until the owner deals with them.
    const stale = (this.db.prepare("SELECT id FROM inbox_items WHERE last_activity_at < ? AND state_at < ? AND state != 'later' AND acked = 0").all(cutoff, cutoff) as Array<{ id: string }>).map((row) => row.id);
    for (const id of stale) {
      this.db.prepare('DELETE FROM inbox_messages WHERE item_id = ?').run(id);
      this.db.prepare('DELETE FROM inbox_items WHERE id = ?').run(id);
    }
    return stale.length;
  }
}
