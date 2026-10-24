import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { mailOf } from './backstage.js';
import type {
  Attention,
  Author,
  CommandResult,
  DeskEvent,
  DeskItem,
  DeskItemRow,
  DeskMessage,
  NewDeskEvent,
} from './types.js';

// Desk storage, in the service's screen.db next to the scene and inbox tables
// (which stay untouched until cutover). Same pattern as inbox-store.ts: CREATE
// IF NOT EXISTS, then add any column an older table is missing.

/** A sanity bound, not a display limit: the Conversation view shows a reply whole. */
const MAX_MESSAGE_CHARS = 200_000;

const ITEM_COLUMNS: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  source: 'TEXT NOT NULL',
  kind: 'TEXT NOT NULL',
  conversation_key: 'TEXT NOT NULL',
  agent_id: 'TEXT NOT NULL',
  agent_name: 'TEXT NOT NULL',
  place: 'TEXT',
  area: 'TEXT',
  channel_id: 'TEXT',
  thread_id: 'TEXT',
  facts: "TEXT NOT NULL DEFAULT '{}'",
  summary: 'TEXT',
  prs: "TEXT NOT NULL DEFAULT '[]'",
  artifacts: "TEXT NOT NULL DEFAULT '[]'",
  activity: 'TEXT',
  watching: 'TEXT',
  ask_record: 'TEXT',
  next_step: "TEXT NOT NULL DEFAULT 'fyi'",
  next_step_basis: "TEXT NOT NULL DEFAULT 'fallback'",
  ask: 'TEXT',
  options: "TEXT NOT NULL DEFAULT '[]'",
  created_at: 'INTEGER NOT NULL DEFAULT 0',
  last_activity_at: 'INTEGER NOT NULL DEFAULT 0',
  last_agent_message_id: 'TEXT',
  last_owner_message_at: 'INTEGER',
  message_count: 'INTEGER NOT NULL DEFAULT 0',
  labels: "TEXT NOT NULL DEFAULT '[]'",
  hidden: 'INTEGER NOT NULL DEFAULT 0',
  revision: 'INTEGER NOT NULL DEFAULT 0',
};

const ATTENTION_COLUMNS: Record<string, string> = {
  item_id: 'TEXT PRIMARY KEY',
  disposition: "TEXT NOT NULL DEFAULT 'active'",
  seen: "TEXT NOT NULL DEFAULT 'new'",
  snooze_until: 'INTEGER',
  snooze_trigger: 'TEXT',
  back_from_snooze: 'INTEGER NOT NULL DEFAULT 0',
  done_at: 'INTEGER',
  writeback: 'TEXT',
  updated_at: 'INTEGER NOT NULL DEFAULT 0',
  covered_until: 'INTEGER',
};

function createTable(db: DatabaseSync, table: string, columns: Record<string, string>): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${table} (${Object.entries(columns).map(([name, type]) => `${name} ${type}`).join(', ')})`);
  const existing = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
  for (const [name, type] of Object.entries(columns)) {
    // ALTER can't add a PRIMARY KEY; the table was created with it.
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type.replace('PRIMARY KEY', '')}`);
  }
}

function json<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

type Row = Record<string, string | number | null>;

function toItemRow(row: Row): DeskItemRow {
  return {
    id: row.id as string,
    source: row.source as DeskItemRow['source'],
    kind: row.kind as DeskItemRow['kind'],
    conversationKey: row.conversation_key as string,
    agentId: row.agent_id as string,
    agentName: row.agent_name as string,
    place: (row.place as string | null) ?? null,
    area: (row.area as string | null) ?? null,
    channelId: (row.channel_id as string | null) ?? null,
    threadId: (row.thread_id as string | null) ?? null,
    facts: json(row.facts as string, {}),
    summary: json(row.summary as string | null, null),
    artifacts: json(row.artifacts as string, []),
    prs: json(row.prs as string, []),
    activity: json(row.activity as string | null, null),
    watching: json(row.watching as string | null, null),
    askRecord: json(row.ask_record as string | null, null),
    nextStep: row.next_step as DeskItemRow['nextStep'],
    nextStepBasis: row.next_step_basis as string,
    ask: (row.ask as string | null) ?? null,
    options: json(row.options as string, []),
    createdAt: row.created_at as number,
    lastActivityAt: row.last_activity_at as number,
    lastAgentMessageId: (row.last_agent_message_id as string | null) ?? null,
    lastOwnerMessageAt: (row.last_owner_message_at as number | null) ?? null,
    messageCount: row.message_count as number,
    labels: json(row.labels as string, []),
    hidden: row.hidden === 1,
    revision: row.revision as number,
  };
}

function toAttention(row: Row): Attention {
  return {
    itemId: row.item_id as string,
    disposition: row.disposition as Attention['disposition'],
    seen: row.seen as Attention['seen'],
    snoozeUntil: (row.snooze_until as number | null) ?? null,
    snoozeTrigger: (row.snooze_trigger as Attention['snoozeTrigger']) ?? null,
    backFromSnooze: row.back_from_snooze === 1,
    doneAt: (row.done_at as number | null) ?? null,
    writeback: json(row.writeback as string | null, null),
    updatedAt: row.updated_at as number,
    coveredUntil: (row.covered_until as number | null) ?? null,
  };
}

function toEvent(row: Row): DeskEvent {
  return {
    seq: row.seq as number,
    at: row.at as number,
    itemId: row.item_id as string,
    type: row.type as DeskEvent['type'],
    actor: row.actor as DeskEvent['actor'],
    payload: json(row.payload as string, {}),
    commandId: (row.command_id as string | null) ?? null,
    undoesSeq: (row.undoes_seq as number | null) ?? null,
  };
}

/** camelCase field → column, for the fields callers may patch. JSON fields are serialized. */
const PATCHABLE: Record<string, { column: string; json?: boolean; bool?: boolean }> = {
  agentName: { column: 'agent_name' },
  place: { column: 'place' },
  area: { column: 'area' },
  channelId: { column: 'channel_id' },
  threadId: { column: 'thread_id' },
  facts: { column: 'facts', json: true },
  summary: { column: 'summary', json: true },
  artifacts: { column: 'artifacts', json: true },
  prs: { column: 'prs', json: true },
  activity: { column: 'activity', json: true },
  watching: { column: 'watching', json: true },
  askRecord: { column: 'ask_record', json: true },
  nextStep: { column: 'next_step' },
  nextStepBasis: { column: 'next_step_basis' },
  ask: { column: 'ask' },
  options: { column: 'options', json: true },
  lastActivityAt: { column: 'last_activity_at' },
  lastAgentMessageId: { column: 'last_agent_message_id' },
  lastOwnerMessageAt: { column: 'last_owner_message_at' },
  messageCount: { column: 'message_count' },
  labels: { column: 'labels', json: true },
  hidden: { column: 'hidden', bool: true },
};

export type ItemPatch = Partial<Omit<DeskItemRow, 'id' | 'source' | 'kind' | 'conversationKey' | 'agentId' | 'createdAt' | 'revision'>>;

export interface StoredCommand {
  commandId: string;
  type: string;
  itemId: string | null;
  args: Record<string, unknown>;
  status: CommandResult['status'];
  outcome: Record<string, unknown> | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export class DeskStore {
  constructor(readonly db: DatabaseSync, private readonly now: () => number = Date.now) {
    createTable(db, 'desk_items', ITEM_COLUMNS);
    createTable(db, 'desk_attention', ATTENTION_COLUMNS);
    db.exec(`
      CREATE INDEX IF NOT EXISTS desk_items_activity ON desk_items(last_activity_at);
      CREATE INDEX IF NOT EXISTS desk_items_conversation ON desk_items(conversation_key, last_activity_at);
      CREATE TABLE IF NOT EXISTS desk_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        item_id TEXT NOT NULL,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        command_id TEXT UNIQUE,
        undoes_seq INTEGER
      );
      CREATE INDEX IF NOT EXISTS desk_events_item ON desk_events(item_id, seq);
      -- isUndone runs once per event when a conversation opens: without this it scanned the whole table each time.
      CREATE INDEX IF NOT EXISTS desk_events_undoes ON desk_events(undoes_seq) WHERE undoes_seq IS NOT NULL;
      -- Bumped by any change to an item or its attention, from any connection: deskItems() reuses its last read until it moves.
      CREATE TABLE IF NOT EXISTS desk_items_generation (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL);
      INSERT OR IGNORE INTO desk_items_generation (id, n) VALUES (1, 0);
      CREATE TRIGGER IF NOT EXISTS desk_items_gen_ai AFTER INSERT ON desk_items BEGIN UPDATE desk_items_generation SET n = n + 1 WHERE id = 1; END;
      CREATE TRIGGER IF NOT EXISTS desk_items_gen_au AFTER UPDATE ON desk_items BEGIN UPDATE desk_items_generation SET n = n + 1 WHERE id = 1; END;
      CREATE TRIGGER IF NOT EXISTS desk_items_gen_ad AFTER DELETE ON desk_items BEGIN UPDATE desk_items_generation SET n = n + 1 WHERE id = 1; END;
      CREATE TRIGGER IF NOT EXISTS desk_attention_gen_ai AFTER INSERT ON desk_attention BEGIN UPDATE desk_items_generation SET n = n + 1 WHERE id = 1; END;
      CREATE TRIGGER IF NOT EXISTS desk_attention_gen_au AFTER UPDATE ON desk_attention BEGIN UPDATE desk_items_generation SET n = n + 1 WHERE id = 1; END;
      CREATE TRIGGER IF NOT EXISTS desk_attention_gen_ad AFTER DELETE ON desk_attention BEGIN UPDATE desk_items_generation SET n = n + 1 WHERE id = 1; END;
      CREATE TABLE IF NOT EXISTS desk_commands (
        command_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        item_id TEXT,
        args TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        outcome TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS desk_messages (
        message_id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        author TEXT NOT NULL,
        at INTEGER NOT NULL,
        text TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS desk_messages_item ON desk_messages(item_id, at);
      CREATE TABLE IF NOT EXISTS desk_markers (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desk_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- Bumped by any settings write (filters, projects, sweep, …): with desk_items_generation it says when a list may have changed.
      CREATE TABLE IF NOT EXISTS desk_settings_generation (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL);
      INSERT OR IGNORE INTO desk_settings_generation (id, n) VALUES (1, 0);
      CREATE TRIGGER IF NOT EXISTS desk_settings_gen_ai AFTER INSERT ON desk_settings BEGIN UPDATE desk_settings_generation SET n = n + 1 WHERE id = 1; END;
      CREATE TRIGGER IF NOT EXISTS desk_settings_gen_au AFTER UPDATE ON desk_settings BEGIN UPDATE desk_settings_generation SET n = n + 1 WHERE id = 1; END;
      CREATE TRIGGER IF NOT EXISTS desk_settings_gen_ad AFTER DELETE ON desk_settings BEGIN UPDATE desk_settings_generation SET n = n + 1 WHERE id = 1; END;
    `);
    // Images on a message (JSON MessageAttachment[]), added 10/14.
    const messageColumns = new Set((this.db.prepare('PRAGMA table_info(desk_messages)').all() as Array<{ name: string }>).map((column) => column.name));
    if (!messageColumns.has('attachments')) this.db.exec('ALTER TABLE desk_messages ADD COLUMN attachments TEXT');
    // What the source knows beyond the words (JSON MessageMeta: mail, queued), added 10/16.
    if (!messageColumns.has('meta')) this.db.exec('ALTER TABLE desk_messages ADD COLUMN meta TEXT');
    this.purgeT3Reasoning();
  }

  /**
   * T3's reasoning summaries (role "system") were once filed as the owner's words (10/07). Drops them
   * and puts back what they moved: the count, the owner's last word, who spoke last, the content key.
   */
  private purgeT3Reasoning(): void {
    const affected = this.db
      .prepare("SELECT item_id, COUNT(*) AS n FROM desk_messages WHERE message_id LIKE 't3:reasoning:%' GROUP BY item_id")
      .all() as Array<{ item_id: string; n: number }>;
    if (affected.length === 0) return;
    this.db.exec("DELETE FROM desk_messages WHERE message_id LIKE 't3:reasoning:%'");
    for (const { item_id: itemId, n } of affected) {
      const item = this.item(itemId);
      if (!item) continue;
      const latest = this.db.prepare('SELECT message_id, author FROM desk_messages WHERE item_id = ? ORDER BY at DESC, message_id DESC LIMIT 1').get(itemId) as { message_id: string; author: Author } | undefined;
      const owner = this.db.prepare("SELECT at, text FROM desk_messages WHERE item_id = ? AND author = 'owner' ORDER BY at DESC LIMIT 1").get(itemId) as { at: number; text: string } | undefined;
      const count = Math.max(0, item.messageCount - n);
      this.db.prepare('UPDATE desk_items SET message_count = ? WHERE id = ?').run(count, itemId);
      const facts = { ...item.facts, lastAuthor: latest?.author ?? null, lastOwnerRequest: owner ? { text: owner.text, at: owner.at } : null, contentKey: `${latest?.message_id ?? ''}:${count}` };
      this.patchItem(itemId, { facts, lastOwnerMessageAt: owner?.at ?? null }, { bump: false });
    }
  }

  // ── items ──────────────────────────────────────────────────────────────

  item(id: string): DeskItemRow | null {
    const row = this.db.prepare('SELECT * FROM desk_items WHERE id = ?').get(id) as Row | undefined;
    return row ? toItemRow(row) : null;
  }

  /** Newest activity first. */
  items(options: { sinceMs?: number; conversationKey?: string; kind?: string } = {}): DeskItemRow[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (options.sinceMs !== undefined) {
      where.push('last_activity_at >= ?');
      params.push(options.sinceMs);
    }
    if (options.conversationKey) {
      where.push('conversation_key = ?');
      params.push(options.conversationKey);
    }
    if (options.kind) {
      where.push('kind = ?');
      params.push(options.kind);
    }
    const sql = `SELECT * FROM desk_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY last_activity_at DESC, created_at DESC`;
    return (this.db.prepare(sql).all(...params) as Row[]).map(toItemRow);
  }

  createItem(item: Pick<DeskItemRow, 'id' | 'source' | 'kind' | 'conversationKey' | 'agentId' | 'agentName'> & ItemPatch & { createdAt?: number }): DeskItemRow {
    const at = item.createdAt ?? this.now();
    this.db
      .prepare(
        `INSERT INTO desk_items (id, source, kind, conversation_key, agent_id, agent_name, created_at, last_activity_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(item.id, item.source, item.kind, item.conversationKey, item.agentId, item.agentName, at, item.lastActivityAt ?? at);
    const { id, source: _source, kind: _kind, conversationKey: _key, agentId: _agent, createdAt: _created, ...patch } = item;
    this.patchItem(id, patch, { bump: false });
    return this.item(id)!;
  }

  /** Applies a patch; the revision bumps when anything actually changed. Returns whether it did. */
  patchItem(id: string, patch: ItemPatch, options: { bump?: boolean } = {}): boolean {
    const current = this.db.prepare('SELECT * FROM desk_items WHERE id = ?').get(id) as Row | undefined;
    if (!current) return false;
    const sets: string[] = [];
    const values: SQLInputValue[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const spec = PATCHABLE[key];
      if (!spec || value === undefined) continue;
      const stored: SQLInputValue = spec.json ? (value === null ? null : JSON.stringify(value)) : spec.bool ? (value ? 1 : 0) : (value as SQLInputValue);
      if (current[spec.column] === stored) continue;
      sets.push(`${spec.column} = ?`);
      values.push(stored);
    }
    if (sets.length === 0) return false;
    if (options.bump !== false) sets.push('revision = revision + 1');
    this.db.prepare(`UPDATE desk_items SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return true;
  }

  bumpRevision(id: string): void {
    this.db.prepare('UPDATE desk_items SET revision = revision + 1 WHERE id = ?').run(id);
  }

  deleteItem(id: string): void {
    this.deleteMarkersFor(id);
    this.db.prepare('DELETE FROM desk_messages WHERE item_id = ?').run(id);
    this.db.prepare('DELETE FROM desk_attention WHERE item_id = ?').run(id);
    this.db.prepare('DELETE FROM desk_events WHERE item_id = ?').run(id);
    this.db.prepare('DELETE FROM desk_items WHERE id = ?').run(id);
  }

  /**
   * Markers that only mean something while the item exists: reaction marks on its messages, the
   * snooze/settle/deferred bookkeeping, T3 revisions. A Discord thread's read cursor stays (dropping
   * it would read the thread back in from scratch and resurrect the item).
   */
  private deleteMarkersFor(id: string): void {
    const keys = [`srcsnooze:${id}`, `deferred:${id}`, `nosettle:${id}`];
    if (id.startsWith('t3:')) keys.push(`t3:${id.slice(3)}`, `t3shell:${id.slice(3)}`);
    const remove = this.db.prepare('DELETE FROM desk_markers WHERE key = ?');
    for (const key of keys) remove.run(key);
    const messages = this.db.prepare('SELECT message_id FROM desk_messages WHERE item_id = ?').all(id) as Array<{ message_id: string }>;
    const reactions = this.db.prepare("DELETE FROM desk_markers WHERE substr(key, 1, ?) = ?");
    for (const { message_id: messageId } of messages) reactions.run(`reaction:${messageId}:`.length, `reaction:${messageId}:`);
  }

  /** The newest item in a conversation (for a home channel: the latest chapter). */
  latestInConversation(conversationKey: string): DeskItemRow | null {
    const row = this.db.prepare('SELECT * FROM desk_items WHERE conversation_key = ? ORDER BY last_activity_at DESC, created_at DESC LIMIT 1').get(conversationKey) as Row | undefined;
    return row ? toItemRow(row) : null;
  }

  // ── attention ──────────────────────────────────────────────────────────

  attention(itemId: string): Attention | null {
    const row = this.db.prepare('SELECT * FROM desk_attention WHERE item_id = ?').get(itemId) as Row | undefined;
    return row ? toAttention(row) : null;
  }

  /** Items put away (done, parked, snoozed) that still read unread. */
  awayUnread(): string[] {
    return (this.db.prepare("SELECT item_id FROM desk_attention WHERE disposition != 'active' AND seen != 'seen'").all() as Array<{ item_id: string }>).map((row) => row.item_id);
  }

  saveAttention(state: Attention): void {
    this.db
      .prepare(
        `INSERT INTO desk_attention (item_id, disposition, seen, snooze_until, snooze_trigger, back_from_snooze, done_at, writeback, updated_at, covered_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET disposition = excluded.disposition, seen = excluded.seen, snooze_until = excluded.snooze_until,
           snooze_trigger = excluded.snooze_trigger, back_from_snooze = excluded.back_from_snooze, done_at = excluded.done_at,
           writeback = excluded.writeback, updated_at = excluded.updated_at, covered_until = excluded.covered_until`,
      )
      .run(
        state.itemId,
        state.disposition,
        state.seen,
        state.snoozeUntil,
        state.snoozeTrigger,
        state.backFromSnooze ? 1 : 0,
        state.doneAt,
        state.writeback ? JSON.stringify(state.writeback) : null,
        state.updatedAt,
        state.coveredUntil ?? null,
      );
  }

  // The last full deskItems() read, reused until an item or its attention changes (desk_items_generation) or a
  // source snooze it depends on runs out: every window refetches four lists on each item change, and each list
  // reads it more than once.
  private itemsCache: { generation: number; validUntil: number; items: DeskItem[] } | null = null;

  /**
   * Changes whenever anything a list is read from changes: items, their attention, or a setting. Equal stamps,
   * equal lists (up to the clock: holds and source snoozes that end on their own).
   */
  listStamp(): string {
    const settings = (this.db.prepare('SELECT n FROM desk_settings_generation WHERE id = 1').get() as { n: number } | undefined)?.n ?? -1;
    return `${this.itemsGeneration()}:${settings}`;
  }

  private itemsGeneration(): number {
    return (this.db.prepare('SELECT n FROM desk_items_generation WHERE id = 1').get() as { n: number } | undefined)?.n ?? -1;
  }

  /** Items joined with attention. */
  deskItems(options: { sinceMs?: number } = {}): DeskItem[] {
    if (options.sinceMs !== undefined) return this.readDeskItems(options);
    const generation = this.itemsGeneration();
    const cached = this.itemsCache;
    if (cached && cached.generation === generation && this.now() < cached.validUntil) return cached.items.slice();
    const now = this.now();
    const items = this.readDeskItems({}, now);
    // A source snooze ending moves its item without a write: the cache lasts until the first one does.
    const validUntil = items.reduce((until, item) => {
      const end = item.facts.sourceSnoozedUntil;
      return end && end > now && end < until ? end : until;
    }, Infinity);
    this.itemsCache = { generation, validUntil, items };
    return items.slice();
  }

  private readDeskItems(options: { sinceMs?: number }, now = this.now()): DeskItem[] {
    // One query (no per-item attention lookup): the board, the compat list and every tick read this.
    const attentionColumns = Object.keys(ATTENTION_COLUMNS).map((column) => `a.${column} AS a_${column}`).join(', ');
    const where = options.sinceMs !== undefined ? 'WHERE i.last_activity_at >= ?' : '';
    const rows = this.db
      .prepare(`SELECT i.*, ${attentionColumns} FROM desk_items i LEFT JOIN desk_attention a ON a.item_id = i.id ${where} ORDER BY i.last_activity_at DESC, i.created_at DESC`)
      .all(...(options.sinceMs !== undefined ? [options.sinceMs] : [])) as Row[];
    return rows.map((row) => {
      const attention = row.a_item_id ? toAttention(Object.fromEntries(Object.keys(ATTENTION_COLUMNS).map((column) => [column, row[`a_${column}`] ?? null])) as Row) : null;
      return this.join(toItemRow(row), now, attention);
    });
  }

  /** The newest agent message's text per item, in one query. */
  lastAgentTexts(): Map<string, string> {
    const rows = this.db
      .prepare(
        `SELECT item_id, text FROM (SELECT item_id, text, ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY at DESC, message_id DESC) AS rn FROM desk_messages WHERE author = 'agent') WHERE rn = 1`,
      )
      .all() as Array<{ item_id: string; text: string }>;
    return new Map(rows.map((row) => [row.item_id, row.text]));
  }

  deskItem(id: string): DeskItem | null {
    const row = this.item(id);
    return row ? this.join(row) : null;
  }

  join(row: DeskItemRow, now = this.now(), known?: Attention | null): DeskItem {
    const attention = known === undefined ? this.attention(row.id) : known;
    const snoozedAtSource = Boolean(row.facts.sourceSnoozedUntil && row.facts.sourceSnoozedUntil > now) && (attention?.disposition ?? 'active') === 'active';
    return {
      ...row,
      disposition: snoozedAtSource ? 'snoozed' : (attention?.disposition ?? 'active'),
      seen: attention?.seen ?? 'new',
      snoozeUntil: snoozedAtSource ? row.facts.sourceSnoozedUntil! : (attention?.snoozeUntil ?? null),
      snoozeTrigger: attention?.snoozeTrigger ?? null,
      backFromSnooze: attention?.backFromSnooze ?? false,
      doneAt: attention?.doneAt ?? null,
      writeback: attention?.writeback ?? null,
      attentionUpdatedAt: attention?.updatedAt ?? row.createdAt,
      snoozedAtSource,
    };
  }

  // ── events ─────────────────────────────────────────────────────────────

  appendEvent(event: NewDeskEvent): DeskEvent {
    const result = this.db
      .prepare('INSERT INTO desk_events (at, item_id, type, actor, payload, command_id, undoes_seq) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(event.at, event.itemId, event.type, event.actor, JSON.stringify(event.payload ?? {}), event.commandId ?? null, event.undoesSeq ?? null);
    return { ...event, seq: Number(result.lastInsertRowid), commandId: event.commandId ?? null, undoesSeq: event.undoesSeq ?? null, payload: event.payload ?? {} };
  }

  event(seq: number): DeskEvent | null {
    const row = this.db.prepare('SELECT * FROM desk_events WHERE seq = ?').get(seq) as Row | undefined;
    return row ? toEvent(row) : null;
  }

  eventsFor(itemId: string): DeskEvent[] {
    return (this.db.prepare('SELECT * FROM desk_events WHERE item_id = ? ORDER BY seq').all(itemId) as Row[]).map(toEvent);
  }

  /** Newest first. */
  recentEvents(limit = 50, types?: readonly string[]): DeskEvent[] {
    const filter = types?.length ? `WHERE type IN (${types.map(() => '?').join(',')})` : '';
    return (this.db.prepare(`SELECT * FROM desk_events ${filter} ORDER BY seq DESC LIMIT ?`).all(...(types ?? []), limit) as Row[]).map(toEvent);
  }

  isUndone(seq: number): boolean {
    return Boolean(this.db.prepare("SELECT 1 AS ok FROM desk_events WHERE type = 'undo' AND undoes_seq = ?").get(seq));
  }

  // ── commands ───────────────────────────────────────────────────────────

  command(commandId: string): StoredCommand | null {
    const row = this.db.prepare('SELECT * FROM desk_commands WHERE command_id = ?').get(commandId) as Row | undefined;
    if (!row) return null;
    return {
      commandId: row.command_id as string,
      type: row.type as string,
      itemId: (row.item_id as string | null) ?? null,
      args: json(row.args as string, {}),
      status: row.status as StoredCommand['status'],
      outcome: json(row.outcome as string | null, null),
      error: (row.error as string | null) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  /** Records a new command; false if the id was already taken (a replay). */
  insertCommand(command: { commandId: string; type: string; itemId?: string | null; args?: Record<string, unknown> }): boolean {
    const now = this.now();
    const result = this.db
      .prepare("INSERT OR IGNORE INTO desk_commands (command_id, type, item_id, args, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'accepted', ?, ?)")
      .run(command.commandId, command.type, command.itemId ?? null, JSON.stringify(command.args ?? {}), now, now);
    return result.changes > 0;
  }

  finishCommand(commandId: string, status: CommandResult['status'], outcome: Record<string, unknown> | null, error?: string): void {
    this.db
      .prepare('UPDATE desk_commands SET status = ?, outcome = ?, error = ?, updated_at = ? WHERE command_id = ?')
      .run(status, outcome ? JSON.stringify(outcome) : null, error ?? null, this.now(), commandId);
  }

  /** Marks `accepted` commands created before `before` as failed (a restart interrupted them). */
  failStaleCommands(before: number, error: string): number {
    const result = this.db
      .prepare("UPDATE desk_commands SET status = 'failed', outcome = ?, error = ?, updated_at = ? WHERE status = 'accepted' AND created_at < ?")
      .run(JSON.stringify({ error }), error, this.now(), before);
    return Number(result.changes);
  }

  // ── messages ───────────────────────────────────────────────────────────

  /** Stores a message whole; true if it is new. A known message cut short by an older cap is mended, but is not new. */
  addMessage(message: DeskMessage): boolean {
    const text = message.text.slice(0, MAX_MESSAGE_CHARS);
    const attachments = message.attachments?.length ? JSON.stringify(message.attachments) : null;
    const meta = message.meta && Object.keys(message.meta).length ? JSON.stringify(message.meta) : null;
    const result = this.db
      .prepare('INSERT OR IGNORE INTO desk_messages (message_id, item_id, author, at, text, attachments, meta) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(message.messageId, message.itemId, message.author, message.at, text, attachments, meta);
    if (result.changes === 0) {
      // A message filed before the desk kept images gets them the next time its source sends it.
      if (attachments) this.db.prepare('UPDATE desk_messages SET attachments = ? WHERE message_id = ? AND attachments IS NULL').run(attachments, message.messageId);
      const repaired = this.db
        .prepare("UPDATE desk_messages SET text = ? WHERE message_id = ? AND length(text) < ? AND substr(?, 1, length(text)) = text")
        .run(text, message.messageId, text.length, text);
      if (repaired.changes && message.author === 'agent') {
        const row = this.db.prepare('SELECT rowid FROM desk_messages WHERE message_id = ?').get(message.messageId) as { rowid: number };
        this.rewindPrMentions(row.rowid);
      }
      return false;
    }
    if (message.author === 'agent') this.rewindPrMentions(Number(result.lastInsertRowid));
    this.db.prepare('UPDATE desk_items SET message_count = message_count + 1 WHERE id = ?').run(message.itemId);
    return true;
  }

  /** A repaired message, or a rowid reused after pruning, must be scanned again for PR links. */
  private rewindPrMentions(rowid: number): void {
    const cursor = this.marker('thread-prs:messages');
    if (cursor !== null && rowid <= Number(cursor)) this.setMarker('thread-prs:messages', String(rowid - 1));
  }

  /** A known message's meta, replaced when the source says something new (a queued message started); true if it changed. */
  setMessageMeta(messageId: string, meta: DeskMessage['meta']): boolean {
    const next = meta && Object.keys(meta).length ? JSON.stringify(meta) : null;
    const result = this.db.prepare('UPDATE desk_messages SET meta = ? WHERE message_id = ? AND meta IS NOT ?').run(next, messageId, next);
    return result.changes > 0;
  }

  /** When the agent last wrote in the item (the message's own time); null with none. */
  latestAgentMessageAt(itemId: string): number | null {
    const row = this.db.prepare("SELECT MAX(at) AS at FROM desk_messages WHERE item_id = ? AND author = 'agent'").get(itemId) as { at: number | null } | undefined;
    return row?.at ?? null;
  }

  /** How many of the agent's messages in the item were written strictly between two times. */
  messagesBetween(itemId: string, after: number, before: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM desk_messages WHERE item_id = ? AND author = 'agent' AND at > ? AND at < ?").get(itemId, after, before) as { n: number }).n;
  }

  /** When the item's newest stored message at or before `at` was written; null with none. */
  latestMessageBefore(itemId: string, at: number): number | null {
    const row = this.db.prepare('SELECT MAX(at) AS at FROM desk_messages WHERE item_id = ? AND at <= ?').get(itemId, at) as { at: number | null } | undefined;
    return row?.at ?? null;
  }

  /** When the item's newest stored message was written; null with none. */
  latestMessageAt(itemId: string): number | null {
    const row = this.db.prepare('SELECT MAX(at) AS at FROM desk_messages WHERE item_id = ?').get(itemId) as { at: number | null } | undefined;
    return row?.at ?? null;
  }

  hasMessage(messageId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 AS ok FROM desk_messages WHERE message_id = ?').get(messageId));
  }

  itemForMessage(messageId: string): string | null {
    const row = this.db.prepare('SELECT item_id FROM desk_messages WHERE message_id = ?').get(messageId) as { item_id: string } | undefined;
    return row?.item_id ?? null;
  }

  /** Whether any of the item's last `count` messages filed (ingestion order, not timestamps) is the owner's. */
  ownerInLastFiled(itemId: string, count: number): boolean {
    if (count <= 0) return false;
    const rows = this.db.prepare('SELECT author, text, meta FROM desk_messages WHERE item_id = ? ORDER BY rowid DESC LIMIT ?').all(itemId, count) as Array<{ author: string; text: string; meta: string | null }>;
    // Another agent's mail is filed under the owner's side but is never the owner replying (Codex review on #575).
    return rows.some((row) => row.author === 'owner' && !mailOf({ author: 'owner', text: row.text, meta: json<DeskMessage['meta']>(row.meta, undefined) }));
  }

  /** Whether the item's newest message is the owner's own words (not another agent's mail): the agent hasn't answered yet. */
  ownerHasLastWord(itemId: string): boolean {
    const row = this.db.prepare('SELECT author, text, meta FROM desk_messages WHERE item_id = ? ORDER BY at DESC, rowid DESC LIMIT 1').get(itemId) as { author: string; text: string; meta: string | null } | undefined;
    return row?.author === 'owner' && !mailOf({ author: 'owner', text: row.text, meta: json<DeskMessage['meta']>(row.meta, undefined) });
  }

  /** When the agent first wrote after `since` (epoch ms), or null. */
  firstAgentMessageAfter(itemId: string, since: number): number | null {
    const row = this.db.prepare("SELECT at FROM desk_messages WHERE item_id = ? AND author = 'agent' AND at > ? ORDER BY at ASC, message_id ASC LIMIT 1").get(itemId, since) as { at: number } | undefined;
    return row?.at ?? null;
  }

  /** The owner's first words in the item (what a new thread was opened with), or null. */
  firstOwnerText(itemId: string): string | null {
    const row = this.db.prepare("SELECT text FROM desk_messages WHERE item_id = ? AND author = 'owner' AND text != '' ORDER BY at ASC, message_id ASC LIMIT 1").get(itemId) as { text: string } | undefined;
    return row?.text ?? null;
  }

  /** Oldest first: the last `limit`. */
  messages(itemId: string, limit = 30): DeskMessage[] {
    const rows = this.db.prepare('SELECT * FROM desk_messages WHERE item_id = ? ORDER BY at DESC, message_id DESC LIMIT ?').all(itemId, limit) as Row[];
    return rows.reverse().map((row) => {
      const attachments = json<DeskMessage['attachments']>(row.attachments as string | null, undefined);
      const meta = json<DeskMessage['meta']>(row.meta as string | null, undefined);
      return { messageId: row.message_id as string, itemId: row.item_id as string, author: row.author as DeskMessage['author'], at: row.at as number, text: row.text as string, ...(attachments?.length ? { attachments } : {}), ...(meta ? { meta } : {}) };
    });
  }

  // ── markers and settings ───────────────────────────────────────────────

  marker(key: string): string | null {
    return (this.db.prepare('SELECT value FROM desk_markers WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }

  setMarker(key: string, value: string): void {
    this.db.prepare('INSERT INTO desk_markers (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  deleteMarker(key: string): void {
    this.db.prepare('DELETE FROM desk_markers WHERE key = ?').run(key);
  }

  markerKeys(prefix: string): string[] {
    return (this.db.prepare("SELECT key FROM desk_markers WHERE substr(key, 1, ?) = ?").all(prefix.length, prefix) as Array<{ key: string }>).map((row) => row.key);
  }

  setting(key: string): string | null {
    return (this.db.prepare('SELECT value FROM desk_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM desk_settings WHERE key = ?').run(key);
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO desk_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /**
   * Retention: finished items quiet for `keepMs` go, with their messages and
   * events. Parked and snoozed items stay until the owner deals with them.
   */
  prune(keepMs: number): string[] {
    const cutoff = this.now() - keepMs;
    const stale = (
      this.db
        .prepare(
          `SELECT i.id FROM desk_items i LEFT JOIN desk_attention a ON a.item_id = i.id
           WHERE i.last_activity_at < ? AND COALESCE(a.updated_at, 0) < ? AND COALESCE(a.disposition, 'active') = 'done'`,
        )
        .all(cutoff, cutoff) as Array<{ id: string }>
    ).map((row) => row.id);
    for (const id of stale) this.deleteItem(id);
    this.db.prepare('DELETE FROM desk_commands WHERE updated_at < ?').run(cutoff);
    return stale;
  }
}
