import type { DatabaseSync } from 'node:sqlite';
import type { Author, Log } from './types.js';

// Search mirrors desk items and messages into full-text and semantic indexes.
// Previously indexed history remains searchable without contacting retired sources.

export interface SearchEmbedder {
  readonly model: string;
  embed(texts: string[], inputType?: 'query' | 'document'): Promise<number[][]>;
}

export interface SearchOptions {
  db: DatabaseSync;
  embedder?: SearchEmbedder | null;
  log?: Log;
  now?: () => number;
  /** The cosine below which a semantic match is dropped (default SEMANTIC_FLOOR; tests use their own). */
  semanticFloor?: number;
}

/** One message (or the conversation's title) that matched. */
export interface SearchMatch {
  messageId: string | null;
  author: Author | null;
  at: number | null;
  /** The matched words wrapped in \u0002 … \u0003 (keyword hits); a plain excerpt for a semantic one. */
  snippet: string;
  how: 'title' | 'keyword' | 'semantic';
}

export interface SearchHit {
  itemId: string;
  score: number;
  /** How many messages matched by keyword (the snippets are the best few). */
  matchCount: number;
  matches: SearchMatch[];
}

/** A conversation as search keeps it: enough to show and filter it once the desk has let it go. */
export interface SearchDoc {
  itemId: string;
  source: string;
  kind: string;
  agentId: string;
  agentName: string;
  place: string | null;
  area: string | null;
  title: string;
  facts: Record<string, unknown>;
  summary: Record<string, unknown> | null;
  createdAt: number;
  lastActivityAt: number;
}

export interface TranscriptMessage {
  messageId: string;
  author: Author;
  at: number;
  text: string;
}

const MARK_OPEN = '\u0002';
const MARK_CLOSE = '\u0003';
/** Messages shorter than this aren't worth a vector ("On it.", "Done."): keyword search still finds them. */
const MIN_EMBED_CHARS = 24;
const PIECE_CHARS = 1800;
const MAX_PIECES = 3;
const EMBED_BATCH = 96;
const RRF_K = 60;
const SNIPPETS_PER_HIT = 3;
/**
 * Semantic matches below this cosine are noise (voyage-4-lite, 512 dimensions, on the owner's own
 * desk: gibberish peaks near 0.40, real topics 0.45–0.65). The fake test embedder sits far from it.
 */
const SEMANTIC_FLOOR = Number(process.env.SCREEN_SEARCH_FLOOR) || 0.43;
/** Meaning alone brings at most this many conversations: past them it is guessing. Counted after the filters. */
const SEMANTIC_MAX = 25;
/** The any-word fallback's conversations: a few likely ones, not every message with a common word. Counted after the filters. */
const ANY_MAX = 30;
/** Bounded candidate pools; reaching a cap makes totals lower bounds. Narrowed searches reach the larger one. */
export const SEARCH_POOL_CAP = 10_000;
const PLAIN_POOL = 2000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS search_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  place TEXT,
  area TEXT,
  title TEXT NOT NULL DEFAULT '',
  about TEXT NOT NULL DEFAULT '',
  facts TEXT NOT NULL DEFAULT '{}',
  summary TEXT,
  created_at INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER NOT NULL DEFAULT 0,
  embedded_text TEXT
);
CREATE TABLE IF NOT EXISTS search_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  item_id TEXT NOT NULL,
  author TEXT NOT NULL,
  at INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS search_messages_item ON search_messages (item_id, at);
CREATE INDEX IF NOT EXISTS search_messages_pending ON search_messages (embedded) WHERE embedded = 0;
CREATE TABLE IF NOT EXISTS search_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  message_id TEXT,
  model TEXT NOT NULL,
  vec BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS search_chunks_message ON search_chunks (message_id);
CREATE INDEX IF NOT EXISTS search_chunks_item ON search_chunks (item_id);
CREATE TABLE IF NOT EXISTS search_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE VIRTUAL TABLE IF NOT EXISTS search_messages_fts USING fts5(text, content='search_messages', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE IF NOT EXISTS search_docs_fts USING fts5(title, about, content='search_docs', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2');

CREATE TRIGGER IF NOT EXISTS search_messages_ai AFTER INSERT ON search_messages BEGIN
  INSERT INTO search_messages_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS search_messages_ad AFTER DELETE ON search_messages BEGIN
  INSERT INTO search_messages_fts (search_messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS search_messages_au AFTER UPDATE OF text ON search_messages BEGIN
  INSERT INTO search_messages_fts (search_messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO search_messages_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS search_docs_ai AFTER INSERT ON search_docs BEGIN
  INSERT INTO search_docs_fts (rowid, title, about) VALUES (new.id, new.title, new.about);
END;
CREATE TRIGGER IF NOT EXISTS search_docs_au AFTER UPDATE OF title, about ON search_docs BEGIN
  INSERT INTO search_docs_fts (search_docs_fts, rowid, title, about) VALUES ('delete', old.id, old.title, old.about);
  INSERT INTO search_docs_fts (rowid, title, about) VALUES (new.id, new.title, new.about);
END;
`;

// What a desk item reads as in the index: the owner's name for it, its place and summary title, and what it is about.
const DOC_TITLE = (row: string) => `trim(COALESCE(json_extract(${row}.facts, '$.name'), '') || ' ' || COALESCE(${row}.place, '') || ' ' || COALESCE(json_extract(${row}.summary, '$.title'), ''))`;
const DOC_ABOUT = (row: string) =>
  `trim(COALESCE(json_extract(${row}.summary, '$.about'), '') || ' ' || COALESCE(json_extract(${row}.summary, '$.gist'), '') || ' ' || COALESCE(json_extract(${row}.summary, '$.paragraph'), '') || ' ' || ${row}.agent_name)`;
const DOC_COLUMNS = 'item_id, source, kind, agent_id, agent_name, place, area, title, about, facts, summary, created_at, last_activity_at';
const DOC_VALUES = (row: string) =>
  `${row}.id, ${row}.source, ${row}.kind, ${row}.agent_id, ${row}.agent_name, ${row}.place, ${row}.area, ${DOC_TITLE(row)}, ${DOC_ABOUT(row)}, ${row}.facts, ${row}.summary, ${row}.created_at, ${row}.last_activity_at`;
const DOC_CONFLICT = `ON CONFLICT(item_id) DO UPDATE SET source = excluded.source, kind = excluded.kind, agent_id = excluded.agent_id, agent_name = excluded.agent_name,
    place = excluded.place, area = excluded.area, title = excluded.title, about = excluded.about, facts = excluded.facts, summary = excluded.summary,
    created_at = excluded.created_at, last_activity_at = excluded.last_activity_at`;
const DOC_UPSERT = (row: string) => `INSERT INTO search_docs (${DOC_COLUMNS}) VALUES (${DOC_VALUES(row)}) ${DOC_CONFLICT}`;
const MESSAGE_COLUMNS = 'message_id, item_id, author, at, text';
const MESSAGE_CONFLICT = 'ON CONFLICT(message_id) DO UPDATE SET text = excluded.text, embedded = 0 WHERE search_messages.text <> excluded.text';
const MESSAGE_UPSERT = (row: string) => `INSERT INTO search_messages (${MESSAGE_COLUMNS}) VALUES (${row}.message_id, ${row}.item_id, ${row}.author, ${row}.at, ${row}.text) ${MESSAGE_CONFLICT}`;

// The desk's own tables feed the index as they change. Deletes are left alone: search keeps what the desk prunes.
// The item triggers are rebuilt at every start, so a change to what a document reads as reaches a database
// that already has them (CREATE … IF NOT EXISTS keeps the old body; Codex review on #550).
const MIRROR = `
DROP TRIGGER IF EXISTS desk_items_search_ai;
DROP TRIGGER IF EXISTS desk_items_search_au;
CREATE TRIGGER IF NOT EXISTS desk_items_search_ai AFTER INSERT ON desk_items BEGIN ${DOC_UPSERT('new')}; END;
CREATE TRIGGER IF NOT EXISTS desk_items_search_au AFTER UPDATE ON desk_items BEGIN ${DOC_UPSERT('new')}; END;
CREATE TRIGGER IF NOT EXISTS desk_messages_search_ai AFTER INSERT ON desk_messages BEGIN ${MESSAGE_UPSERT('new')}; END;
CREATE TRIGGER IF NOT EXISTS desk_messages_search_au AFTER UPDATE OF text ON desk_messages BEGIN ${MESSAGE_UPSERT('new')}; END;
`;

type Row = Record<string, string | number | null | Uint8Array>;

function json<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || !text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

// ── the query ────────────────────────────────────────────────────────────

export interface ParsedQuery {
  /** The FTS5 expression, or null when nothing positive is left to match by keyword. */
  match: string | null;
  /** What -words leave out, as an FTS5 expression: any conversation that has one anywhere. */
  exclude: string | null;
  /** Any of the words (two or more): the fallback when needing all of them finds little. */
  any: string | null;
  /** The words as typed, without the operators: what semantic search embeds. */
  text: string;
  /** Words and phrases to find (for highlighting a semantic excerpt). */
  terms: string[];
}

const quote = (term: string) => `"${term.replace(/"/g, '""')}"`;

/** Words too common to find anything on their own: left out of the any-word fallback (all-words still needs them). */
const STOPWORDS = new Set(
  'a an and are as at be but by can could did do does doing done for from had has have how i if in into is it its just me my not of on or our out so than that the their them then there these they thing this to up was we were what when where which who why will with would you your about after again all also any been before being both each few get got here him his her more most much now off once only other over same she should some still such through too under until very while yes no ok okay'.split(' '),
);

/**
 * The owner's words as a safe FTS5 query. Words must all appear (any form: "routing" finds "routed",
 * and a word still being typed matches as a prefix); "quoted words" are a phrase; -word leaves out
 * any conversation that has it anywhere. Nothing typed is ever FTS5 syntax, so no query can be malformed.
 */
export function parseSearchQuery(raw: string): ParsedQuery {
  const positive: string[] = [];
  const negative: string[] = [];
  const terms: string[] = [];
  const words: string[] = [];
  for (const m of String(raw ?? '').matchAll(/(-?)"([^"]*)"?|(-?)(\S+)/g)) {
    const phrase = m[2] !== undefined;
    const exclude = (phrase ? m[1] : m[3]) === '-';
    const value = ((phrase ? m[2] : m[4]) ?? '').trim();
    // Only letters and digits count (the tokenizer drops the rest): "c++" is "c", "--" is nothing.
    if (!/[\p{L}\p{N}]/u.test(value)) continue;
    if (exclude) {
      negative.push(quote(value));
      continue;
    }
    terms.push(value);
    words.push(value);
    positive.push(phrase || value.length < 2 ? quote(value) : `(${quote(value)} OR ${quote(value)}*)`);
  }
  return {
    match: positive.length ? positive.join(' AND ') : null,
    exclude: positive.length && negative.length ? negative.join(' OR ') : null,
    any: (() => {
      const rare = terms.filter((term) => term.includes(' ') || (term.length > 2 && !STOPWORDS.has(term.toLowerCase())));
      return positive.length > 1 && rare.length ? rare.map((term) => (term.includes(' ') ? quote(term) : `(${quote(term)} OR ${quote(term)}*)`)).join(' OR ') : null;
    })(),
    text: words.join(' '),
    terms,
  };
}

// ── vectors ──────────────────────────────────────────────────────────────

function normalize(vector: number[]): Float32Array {
  const out = Float32Array.from(vector);
  let norm = 0;
  for (const v of out) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i += 1) out[i]! /= norm;
  return out;
}

/**
 * Every chunk's vector in memory, quantized to int8 with a scale per vector (a quarter of the
 * float32 size; cosine ranking barely moves). Loaded on the first semantic query, kept up to date
 * as chunks are added, and reloaded after any were replaced.
 */
class VectorIndex {
  dim = 0;
  count = 0;
  private vecs = new Int8Array(0);
  private scales = new Float32Array(0);
  itemIds: string[] = [];
  messageIds: Array<string | null> = [];

  add(itemId: string, messageId: string | null, vector: Float32Array): void {
    if (!this.dim) this.dim = vector.length;
    if (vector.length !== this.dim) return; // a model with another size: ignored until a reload
    if (this.count === this.scales.length) this.grow(Math.max(1024, this.count * 2));
    let max = 0;
    for (const v of vector) max = Math.max(max, Math.abs(v));
    const scale = max / 127 || 1;
    const at = this.count * this.dim;
    for (let i = 0; i < this.dim; i += 1) this.vecs[at + i] = Math.round(vector[i]! / scale);
    this.scales[this.count] = scale;
    this.itemIds.push(itemId);
    this.messageIds.push(messageId);
    this.count += 1;
  }

  private grow(capacity: number): void {
    const vecs = new Int8Array(capacity * (this.dim || 1));
    vecs.set(this.vecs);
    const scales = new Float32Array(capacity);
    scales.set(this.scales);
    this.vecs = vecs;
    this.scales = scales;
  }

  /** The best `limit` chunks by cosine similarity (vectors are unit length). */
  top(query: Float32Array, limit: number): Array<{ index: number; score: number }> {
    if (!this.count || query.length !== this.dim) return [];
    const scores = new Float32Array(this.count);
    for (let n = 0; n < this.count; n += 1) {
      let dot = 0;
      const at = n * this.dim;
      for (let i = 0; i < this.dim; i += 1) dot += query[i]! * this.vecs[at + i]!;
      scores[n] = dot * this.scales[n]!;
    }
    const order = Array.from(scores.keys()).sort((a, b) => scores[b]! - scores[a]!).slice(0, limit);
    return order.map((index) => ({ index, score: scores[index]! }));
  }
}

/** A long message as pieces, each embedded on its own (the best piece stands for the message). */
export function pieces(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  const out: string[] = [];
  for (let at = 0; at < clean.length && out.length < MAX_PIECES; at += PIECE_CHARS) out.push(clean.slice(at, at + PIECE_CHARS));
  return out;
}

/** About `size` characters of a message around its first matching term (or its start). */
export function excerpt(text: string, terms: string[], size = 220): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= size) return clean;
  const lower = clean.toLowerCase();
  const hit = terms.map((term) => lower.indexOf(term.toLowerCase())).filter((at) => at >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, Math.min(hit - Math.floor(size / 3), clean.length - size));
  return `${start > 0 ? '…' : ''}${clean.slice(start, start + size).trim()}${start + size < clean.length ? '…' : ''}`;
}

// ── the index ────────────────────────────────────────────────────────────

export class DeskSearch {
  private readonly db: DatabaseSync;
  private readonly log: Log;
  private readonly now: () => number;
  private vectors: VectorIndex | null = null;
  private vectorsStale = false;
  private readonly queryCache = new Map<string, Float32Array>();
  private embedding: Promise<number> | null = null;

  constructor(private readonly options: SearchOptions) {
    this.db = options.db;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
    this.db.exec(SCHEMA);
    this.db.exec(MIRROR);
    this.seed();
    this.followModel();
  }

  /** Another embedding model: its vectors don't compare with the old ones, so everything is embedded again (Codex review on #509). */
  private followModel(): void {
    const model = this.options.embedder?.model;
    if (!model || this.state('embed_model') === model) return;
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM search_chunks');
      this.db.exec('UPDATE search_messages SET embedded = 0 WHERE embedded <> 0');
      this.db.exec('UPDATE search_docs SET embedded_text = NULL');
      this.setState('embed_model', model);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  get semantic(): boolean {
    return !!this.options.embedder;
  }

  private state(key: string): string | null {
    return (this.db.prepare('SELECT value FROM search_state WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }

  private setState(key: string, value: string): void {
    this.db.prepare('INSERT INTO search_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Once: everything the desk holds from before the index existed (the triggers take it from there). */
  private seed(): void {
    if (this.state('seeded_v1')) return;
    this.db.exec('BEGIN');
    try {
      // "WHERE true": an INSERT … SELECT needs it before an upsert clause (SQLite's parsing ambiguity).
      this.db.exec(`INSERT INTO search_docs (${DOC_COLUMNS}) SELECT ${DOC_VALUES('i')} FROM desk_items i WHERE true ${DOC_CONFLICT}`);
      this.db.exec(`INSERT INTO search_messages (${MESSAGE_COLUMNS}) SELECT message_id, item_id, author, at, text FROM desk_messages WHERE true ${MESSAGE_CONFLICT}`);
      this.setState('seeded_v1', String(this.now()));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  stats(): { docs: number; messages: number; chunks: number; pending: number } {
    const count = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      docs: count('SELECT COUNT(*) AS n FROM search_docs'),
      messages: count('SELECT COUNT(*) AS n FROM search_messages'),
      chunks: count('SELECT COUNT(*) AS n FROM search_chunks'),
      pending: count('SELECT COUNT(*) AS n FROM search_messages WHERE embedded = 0'),
    };
  }

  /** Every conversation search keeps for one of the owner's projects (archived ones too), newest activity first. */
  docsInProject(projectId: string, limit = 100): SearchDoc[] {
    const rows = this.db.prepare("SELECT * FROM search_docs WHERE json_extract(facts, '$.projectId') = ? ORDER BY last_activity_at DESC LIMIT ?").all(projectId, limit) as Row[];
    return rows.map(toDoc);
  }

  /** One bulk snapshot read; search membership must never perform per-candidate queries. */
  docs(): SearchDoc[] {
    return (this.db.prepare('SELECT * FROM search_docs').all() as Row[]).map(toDoc);
  }

  doc(itemId: string): SearchDoc | null {
    const row = this.db.prepare('SELECT * FROM search_docs WHERE item_id = ?').get(itemId) as Row | undefined;
    return row ? toDoc(row) : null;
  }

  // ── embeddings ──

  /** Embeds what has no vector yet, newest first, a batch at a time. Returns how many messages it took. */
  embedPending(batches = 1): Promise<number> {
    if (!this.options.embedder) return Promise.resolve(0);
    if (!this.embedding) this.embedding = this.embedOnce(batches).finally(() => (this.embedding = null));
    return this.embedding;
  }

  private async embedOnce(batches: number): Promise<number> {
    const embedder = this.options.embedder!;
    let done = 0;
    for (let b = 0; b < batches; b += 1) {
      const docs = this.db
        .prepare("SELECT item_id, title, about FROM search_docs WHERE COALESCE(embedded_text, '') <> title || char(10) || about LIMIT ?")
        .all(EMBED_BATCH) as Array<{ item_id: string; title: string; about: string }>;
      const rows = this.db
        .prepare('SELECT m.id, m.message_id, m.item_id, m.text, d.title FROM search_messages m LEFT JOIN search_docs d ON d.item_id = m.item_id WHERE m.embedded = 0 ORDER BY m.at DESC LIMIT ?')
        .all(Math.max(0, EMBED_BATCH - docs.length)) as Array<{ id: number; message_id: string; item_id: string; text: string; title: string | null }>;
      if (!docs.length && !rows.length) break;
      const inputs: Array<{ itemId: string; messageId: string | null; text: string }> = [];
      const skipped: number[] = [];
      for (const doc of docs) inputs.push({ itemId: doc.item_id, messageId: null, text: `${doc.title}\n${doc.about}`.trim() || doc.item_id });
      for (const row of rows) {
        if (row.text.trim().length < MIN_EMBED_CHARS) {
          skipped.push(row.id);
          continue;
        }
        // The conversation's name gives a short reply its context ("yes, ship it" in which thread).
        for (const piece of pieces(row.text)) inputs.push({ itemId: row.item_id, messageId: row.message_id, text: row.title ? `${row.title}\n\n${piece}` : piece });
      }
      const vectors = inputs.length ? await embedder.embed(inputs.map((input) => input.text), 'document') : [];
      if (vectors.length !== inputs.length) throw new Error(`embedder returned ${vectors.length} vectors for ${inputs.length} texts`);
      this.db.exec('BEGIN');
      try {
        const insert = this.db.prepare('INSERT INTO search_chunks (item_id, message_id, model, vec) VALUES (?, ?, ?, ?)');
        const clearMessage = this.db.prepare('DELETE FROM search_chunks WHERE message_id = ?');
        const clearDoc = this.db.prepare('DELETE FROM search_chunks WHERE item_id = ? AND message_id IS NULL');
        let replaced = 0;
        for (const row of rows) replaced += Number(clearMessage.run(row.message_id).changes);
        for (const doc of docs) replaced += Number(clearDoc.run(doc.item_id).changes);
        const added: Array<{ itemId: string; messageId: string | null; vector: Float32Array }> = [];
        inputs.forEach((input, i) => {
          const vector = normalize(vectors[i]!);
          insert.run(input.itemId, input.messageId, embedder.model, new Uint8Array(vector.buffer));
          added.push({ itemId: input.itemId, messageId: input.messageId, vector });
        });
        // Only the words that were embedded count as done: a message that grew meanwhile goes round again.
        const markMessage = this.db.prepare('UPDATE search_messages SET embedded = ? WHERE id = ? AND text = ?');
        for (const row of rows) markMessage.run(skipped.includes(row.id) ? 2 : 1, row.id, row.text);
        const markDoc = this.db.prepare('UPDATE search_docs SET embedded_text = ? WHERE item_id = ? AND title = ? AND about = ?');
        for (const doc of docs) markDoc.run(`${doc.title}\n${doc.about}`, doc.item_id, doc.title, doc.about);
        this.db.exec('COMMIT');
        if (replaced) this.vectorsStale = true;
        else if (this.vectors) for (const a of added) this.vectors.add(a.itemId, a.messageId, a.vector);
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
      done += rows.length + docs.length;
    }
    return done;
  }

  private vectorIndex(): VectorIndex {
    if (this.vectors && !this.vectorsStale) return this.vectors;
    const index = new VectorIndex();
    const model = this.options.embedder?.model;
    for (const row of this.db.prepare('SELECT item_id, message_id, vec FROM search_chunks WHERE model = ? ORDER BY id').iterate(model ?? '') as Iterable<{ item_id: string; message_id: string | null; vec: Uint8Array }>) {
      index.add(row.item_id, row.message_id, new Float32Array(row.vec.buffer.slice(row.vec.byteOffset, row.vec.byteOffset + row.vec.byteLength)));
    }
    this.vectors = index;
    this.vectorsStale = false;
    return index;
  }

  private async queryVector(text: string): Promise<Float32Array | null> {
    const embedder = this.options.embedder;
    if (!embedder || !text.trim()) return null;
    const key = text.trim().toLowerCase();
    const cached = this.queryCache.get(key);
    if (cached) return cached;
    const [vector] = await embedder.embed([text], 'query');
    if (!vector?.length) return null;
    const normalized = normalize(vector);
    this.queryCache.set(key, normalized);
    if (this.queryCache.size > 300) this.queryCache.delete(this.queryCache.keys().next().value!);
    return normalized;
  }

  // ── search ──

  /**
   * The best conversations for the words: keyword hits on titles and messages and semantic hits,
   * each ranked on its own and fused (reciprocal rank fusion, titles counting most). Up to `limit`
   * conversations, with eligibility evaluated before fusion and the final limit.
   */
  async search(raw: string, options: { limit?: number; semantic?: boolean; semanticTimeoutMs?: number; eligible?: (itemId: string) => boolean; basis?: (itemId: string) => boolean; keep?: (itemId: string) => boolean; narrowed?: boolean } = {}): Promise<{ query: string; semantic: boolean; hits: SearchHit[]; total: number; more: boolean }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 300);
    const parsed = parseSearchQuery(raw);
    let more = false;
    // `basis` (a wider set `eligible` sits within) makes the candidate decisions (the any-word fallback, the
    // meaning floor, the list caps) as a search over it would: the results are then exactly its results that
    // `eligible` keeps, so a narrowed search is a subset of the wider one (Codex review on #865).
    const inBasis = (itemId: string) => (options.basis ?? options.eligible ?? (() => true))(itemId);
    // A plain search ranks within the old pools; only a narrowed one needs to reach further down for its matches.
    const cap = options.narrowed ? SEARCH_POOL_CAP : PLAIN_POOL;
    const titleCap = options.narrowed ? SEARCH_POOL_CAP : 300;
    // A pool that came back full may have more below it: the total is then a lower bound.
    const pool = <T>(rows: T[], limit = cap): T[] => { if (rows.length >= limit) more = true; return rows; };
    const lists: Array<{ weight: number; ranked: Array<{ itemId: string; match: SearchMatch }> }> = [];
    const keywordCount = new Map<string, number>();
    const extra = new Map<string, SearchMatch[]>();

    if (parsed.match) {
      // Titles first: a conversation named for the words is the likeliest one wanted.
      const docs = this.db
        .prepare(
          `SELECT d.item_id, highlight(search_docs_fts, 0, '${MARK_OPEN}', '${MARK_CLOSE}') AS title
           FROM search_docs_fts JOIN search_docs d ON d.id = search_docs_fts.rowid
           WHERE search_docs_fts MATCH ? ORDER BY bm25(search_docs_fts, 10.0, 2.0) LIMIT ${titleCap}`,
        )
        .all(parsed.match) as Array<{ item_id: string; title: string }>;
      pool(docs, titleCap);
      lists.push({ weight: 1.6, ranked: docs.map((d) => ({ itemId: d.item_id, match: { messageId: null, author: null, at: null, snippet: d.title, how: 'title' } })) });

      const messageHits = (match: string, limit: number) =>
        this.db
          .prepare(
            `SELECT m.item_id, m.message_id, m.author, m.at, snippet(search_messages_fts, 0, '${MARK_OPEN}', '${MARK_CLOSE}', '…', 24) AS snippet
             FROM search_messages_fts JOIN search_messages m ON m.id = search_messages_fts.rowid
             WHERE search_messages_fts MATCH ? ORDER BY bm25(search_messages_fts) LIMIT ?`,
          )
          .all(match, limit) as Array<{ item_id: string; message_id: string; author: Author; at: number; snippet: string }>;
      const best = (rows: ReturnType<typeof messageHits>, count: boolean) => {
        const out: Array<{ itemId: string; match: SearchMatch }> = [];
        const seen = new Map<string, number>();
        for (const m of rows) {
          const match: SearchMatch = { messageId: m.message_id, author: m.author, at: m.at, snippet: m.snippet, how: 'keyword' };
          const n = seen.get(m.item_id) ?? 0;
          seen.set(m.item_id, n + 1);
          if (count) keywordCount.set(m.item_id, n + 1);
          if (n === 0) out.push({ itemId: m.item_id, match });
          else if (count && n < SNIPPETS_PER_HIT) extra.set(m.item_id, [...(extra.get(m.item_id) ?? []), match]);
        }
        return out;
      };
      const all = best(pool(messageHits(parsed.match, cap)), true);
      lists.push({ weight: 1, ranked: all });
      // Every word in one message is strict: with few such messages, any of them counts too (ranked lower).
      // Not when a conversation is named with every word: one word alone, stacked with meaning, outranked
      // it ("kumquat ledgers" put the ledger chats above the "Kumquat ledger" threads, live test 10/18).
      // Counted within the filters: out-of-scope strict matches mustn't hold back an in-scope looser one (Codex review on #799).
      const strict = all.filter(({ itemId }) => inBasis(itemId)).length;
      const named = docs.filter((d) => inBasis(d.item_id)).length;
      if (parsed.any && strict < 5 && named === 0) lists.push({ weight: 0.6, ranked: best(pool(messageHits(parsed.any, options.narrowed ? SEARCH_POOL_CAP : 600), options.narrowed ? SEARCH_POOL_CAP : 600), false).filter(({ itemId }) => inBasis(itemId)).slice(0, ANY_MAX) });
    }

    let semantic = false;
    if (options.semantic !== false && this.options.embedder && parsed.text) {
      try {
        const vector = await withTimeout(this.queryVector(parsed.text), options.semanticTimeoutMs ?? 3000);
        if (vector) {
          semantic = true;
          const index = this.vectorIndex();
          const top = pool(index.top(vector, cap)).filter(({ index: n }) => inBasis(index.itemIds[n]!));
          // A conversation scores by its best few pieces (1, .35, .15): one that keeps coming back to
          // the subject outranks one lucky sentence. Only near the best score counts: below that, a
          // "match" is just the nearest noise.
          const floor = Math.max(this.options.semanticFloor ?? SEMANTIC_FLOOR, (top[0]?.score ?? 0) - 0.12);
          const byItem = new Map<string, { sims: number[]; messageId: string | null }>();
          for (const { index: n, score } of top) {
            if (score < floor) break;
            const entry = byItem.get(index.itemIds[n]!) ?? { sims: [], messageId: null };
            if (entry.sims.length < 3) entry.sims.push(score);
            // The best message stands for the conversation (a title piece has no message).
            entry.messageId ??= index.messageIds[n] ?? null;
            byItem.set(index.itemIds[n]!, entry);
          }
          const messageIds = [...byItem.values()].flatMap(({ messageId }) => messageId ? [messageId] : []);
          const text = new Map((messageIds.length ? this.db.prepare(`SELECT message_id, author, at, text FROM search_messages WHERE message_id IN (${messageIds.map(() => '?').join(',')})`).all(...messageIds) as Array<{ message_id: string; author: Author; at: number; text: string }> : []).map((row) => [row.message_id, row]));
          const ranked = [...byItem]
            .map(([itemId, { sims, messageId }]) => ({ itemId, messageId, score: (sims[0] ?? 0) + 0.35 * (sims[1] ?? 0) + 0.15 * (sims[2] ?? 0) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, SEMANTIC_MAX)
            .map(({ itemId, messageId }) => {
              const row = messageId ? (text.get(messageId)) : undefined;
              const match: SearchMatch = row ? { messageId, author: row.author, at: row.at, snippet: excerpt(row.text, parsed.terms), how: 'semantic' } : { messageId: null, author: null, at: null, snippet: '', how: 'semantic' };
              return { itemId, match };
            });
          // Meaning counts most when the words find little.
          const keywordHits = lists[1]?.ranked.length ?? 0;
          lists.push({ weight: keywordHits >= 5 ? 0.8 : 1.2, ranked });
        }
      } catch (err) {
        this.log('desk.search.semantic.error', { failed: true });
      }
    }

    if (!parsed.match && !parsed.text && options.eligible) {
      const docs = pool(this.db.prepare('SELECT item_id FROM search_docs ORDER BY last_activity_at DESC LIMIT ?').all(SEARCH_POOL_CAP) as Array<{ item_id: string }>, SEARCH_POOL_CAP);
      lists.push({ weight: 1, ranked: docs.map((d) => ({ itemId: d.item_id, match: { messageId: null, author: null, at: null, snippet: '', how: 'title' as const } })) });
    }

    // -words: a conversation that says them anywhere (a message or its title) is out, whichever list found it.
    const excluded = new Set<string>();
    if (parsed.exclude) {
      for (const row of this.db.prepare('SELECT m.item_id FROM search_messages_fts JOIN search_messages m ON m.id = search_messages_fts.rowid WHERE search_messages_fts MATCH ?').all(parsed.exclude) as Array<{ item_id: string }>) excluded.add(row.item_id);
      for (const row of this.db.prepare('SELECT d.item_id FROM search_docs_fts JOIN search_docs d ON d.id = search_docs_fts.rowid WHERE search_docs_fts MATCH ?').all(parsed.exclude) as Array<{ item_id: string }>) excluded.add(row.item_id);
    }

    // Reciprocal rank fusion: a conversation high on any list rises; one on several rises most.
    const fused = new Map<string, SearchHit>();
    for (const list of lists) {
      list.ranked.filter(({ itemId }) => !excluded.has(itemId) && (!options.eligible || options.eligible(itemId))).forEach(({ itemId, match }, rank) => {
        const hit = fused.get(itemId) ?? { itemId, score: 0, matchCount: keywordCount.get(itemId) ?? 0, matches: [] };
        hit.score += list.weight / (RRF_K + rank + 1);
        if (match.snippet && !hit.matches.some((m) => m.messageId && m.messageId === match.messageId)) hit.matches.push(match);
        fused.set(itemId, hit);
      });
    }
    // `keep`: conversations the page holds past the limit too (the open results a widened search was widened from).
    const hits = [...fused.values()].sort((a, b) => b.score - a.score).filter((hit, n) => n < limit || options.keep?.(hit.itemId));
    for (const hit of hits) {
      for (const match of extra.get(hit.itemId) ?? []) if (!hit.matches.some((m) => m.messageId === match.messageId)) hit.matches.push(match);
      // The title line first, then messages by how they matched (keyword before semantic), at most a few.
      const order = { title: 0, keyword: 1, semantic: 2 };
      hit.matches = hit.matches.sort((a, b) => order[a.how] - order[b.how]).slice(0, SNIPPETS_PER_HIT + 1);
      hit.score = Math.round(hit.score * 1e5) / 1e5;
    }
    return { query: raw, semantic, hits, total: fused.size, more };
  }

  /**
   * A conversation's messages as search keeps them, oldest first: the `limit` around `around` (a
   * matched message), before `before`, after `after`, or the latest.
   */
  transcript(itemId: string, options: { around?: string; before?: string; after?: string; limit?: number } = {}): { messages: TranscriptMessage[]; hasEarlier: boolean; hasLater: boolean } {
    const limit = Math.min(Math.max(options.limit ?? 80, 1), 400);
    const at = (messageId: string | undefined) =>
      messageId ? ((this.db.prepare('SELECT at, id FROM search_messages WHERE message_id = ? AND item_id = ?').get(messageId, itemId) as { at: number; id: number } | undefined) ?? null) : null;
    const older = this.db.prepare('SELECT message_id, author, at, text FROM search_messages WHERE item_id = ? AND (at < ? OR (at = ? AND id < ?)) ORDER BY at DESC, id DESC LIMIT ?');
    const newer = this.db.prepare('SELECT message_id, author, at, text FROM search_messages WHERE item_id = ? AND (at > ? OR (at = ? AND id > ?)) ORDER BY at ASC, id ASC LIMIT ?');
    const toMessage = (row: Row): TranscriptMessage => ({ messageId: row.message_id as string, author: row.author as Author, at: row.at as number, text: row.text as string });
    let rows: Row[];
    const around = at(options.around);
    const before = at(options.before);
    const after = at(options.after);
    if (around) {
      const self = this.db.prepare('SELECT message_id, author, at, text FROM search_messages WHERE id = ?').get(around.id) as Row;
      const half = Math.floor(limit / 2);
      rows = [...(older.all(itemId, around.at, around.at, around.id, half) as Row[]).reverse(), self, ...(newer.all(itemId, around.at, around.at, around.id, limit - half - 1) as Row[])];
    } else if (before) {
      rows = (older.all(itemId, before.at, before.at, before.id, limit) as Row[]).reverse();
    } else if (after) {
      rows = newer.all(itemId, after.at, after.at, after.id, limit) as Row[];
    } else {
      rows = (older.all(itemId, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0, limit) as Row[]).reverse();
    }
    const messages = rows.map(toMessage);
    const first = messages[0];
    const last = messages.at(-1);
    const exists = (sql: string, m: TranscriptMessage) => {
      const id = (this.db.prepare('SELECT id FROM search_messages WHERE message_id = ?').get(m.messageId) as { id: number }).id;
      return !!this.db.prepare(sql).get(itemId, m.at, m.at, id);
    };
    return {
      messages,
      hasEarlier: !!first && exists('SELECT 1 AS ok FROM search_messages WHERE item_id = ? AND (at < ? OR (at = ? AND id < ?)) LIMIT 1', first),
      hasLater: !!last && exists('SELECT 1 AS ok FROM search_messages WHERE item_id = ? AND (at > ? OR (at = ? AND id > ?)) LIMIT 1', last),
    };
  }
}

function toDoc(row: Row): SearchDoc {
  return {
    itemId: row.item_id as string,
    source: row.source as string,
    kind: row.kind as string,
    agentId: row.agent_id as string,
    agentName: row.agent_name as string,
    place: (row.place as string | null) ?? null,
    area: (row.area as string | null) ?? null,
    title: row.title as string,
    facts: json(row.facts, {}),
    summary: json(row.summary, null),
    createdAt: row.created_at as number,
    lastActivityAt: row.last_activity_at as number,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (err) => (clearTimeout(timer), reject(err)),
    );
  });
}
