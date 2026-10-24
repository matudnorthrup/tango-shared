import { ASKS_SCHEMA, migrateAsks } from "./asks.js";
import { dirname, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { wakeCause, type WakeCause } from "./handoff.js";
import { ASK_LINT_SCHEMA } from "./ask-lint.js";
import { DECIDED_STATUSES, DECISION_COLUMNS, DECISIONS_SCHEMA, type DecisionRow } from "./decisions.js";
import { LEASE_SCHEMA } from "./leases.js";
import { PRESENCE_SCHEMA } from "./presence.js";
import { RULES_SCHEMA } from "./rules.js";

export type WorktreeMode = "auto" | "worktree" | "local";
export type ThreadStatus = "idle" | "running" | "waiting" | "stopped";
/** Who a thread works for (docs/specs/resilient-runtime.md "Thread roles"). */
export const THREAD_ROLES = ["interactive", "worker", "ops", "default"] as const;
export type ThreadRole = (typeof THREAD_ROLES)[number];
export const isThreadRole = (value: unknown): value is ThreadRole => typeof value === "string" && (THREAD_ROLES as readonly string[]).includes(value);
export type RunStatus = "queued" | "running" | "completed" | "interrupted" | "failed" | "canceled";
/** reset: the handoff turn Loom sends before a fresh session (fresh.ts). */
export type RunSource = "user" | "wake" | "continue" | "reset";
export type RequestKind = "question" | "plan";
export type Entity = "thread" | "run" | "message" | "item" | "request";

export type Admission = "recovery_unhealthy" | "disk_low" | "memory" | "host_cap" | "account_limit" | "budget" | "provider_busy";
export interface ThreadRow {
  session_profile: string | null;
  id: string;
  kind: string;
  title: string | null;
  cwd: string;
  provider: string;
  account: string | null;
  /** JSON array of the accounts this thread may run on; null = any. */
  accounts: string | null;
  accounts_source: "policy" | null;
  /** The checkout this thread works on (its worktree's repo, or its own cwd). */
  repo: string | null;
  /** Where the title came from: draft (from the prompt, may be replaced), generated, given or owner (kept). */
  title_source: "draft" | "generated" | "given" | "owner" | null;
  native_session_id: string | null;
  host_release: string | null;
  host_instance_id: string | null;
  host_seq: number;
  cooled_at: number | null;
  cooling_note: string | null;
  /** Why new work is held, or null: the disk floor, the host or memory budget, no account with room, or the model at capacity. */
  admission: Admission | null;
  /** When the hold is expected to lift (ms), when known: the soonest account reset for `account_limit`, the next retry for `provider_busy`. */
  admission_until: number | null;
  /** JSON FreshReason (fresh.ts): the next session starts fresh instead of resuming. Null: resume as usual. */
  fresh?: string | null;
  /** 1: the owner kept this session ("Keep this session"): no automatic fresh session. Compaction still applies. */
  fresh_opt_out?: number | null;
  /** The thread's own daily budget in input tokens (budget.ts), overriding its role's default; 0: none. Null: the default. */
  budget?: number | null;
  /** JSON BudgetRaise: today's Raise, which lapses at midnight. */
  budget_raise?: string | null;
  /** The budget day (local midnight) whose 80% crossing already started the thread fresh: once a day. */
  budget_fresh_day?: number | null;
  role: ThreadRole;
  /** Its owner: a desk item id (`loom:<id>`, `agent:<id>`, …), since the owner need not be a Loom thread. */
  parent_thread_id: string | null;
  status: ThreadStatus;
  /** JSON array of the background tasks still running in the session (BackgroundTask); null: none. */
  background: string | null;
  /**
   * JSON OpenAsk: the agent closed its last finished turn with "Next — you" and the owner hasn't written since.
   * Cleared by the owner's own words (never another agent's mail) or a later turn that hands off otherwise. `to`
   * set: the ask answers another agent's mail and is that agent's, not the owner's (host.ts askAfter).
   */
  ask: string | null;
  created_at: number;
  updated_at: number;
  settled_at: number | null;
  worktree_mode: WorktreeMode;
  worktree_shrunk_at: number | null;
  worktree_archive: string | null;
  worktree_removed_at: number | null;
  worktree_branch: string | null;
  worktree_head: string | null;
}

export interface RunRow {
  wake_cause?: WakeCause | null;
  context: string | null;
  id: string;
  thread_id: string;
  position: number;
  source: RunSource;
  text: string;
  status: RunStatus;
  failure: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

export interface AttemptRow {
  id: string;
  run_id: string;
  thread_id: string;
  account: string | null;
  native_session_id: string | null;
  status: RunStatus;
  failure: string | null;
  started_at: number;
  ended_at: number | null;
}

export interface MessageRow {
  id: string;
  thread_id: string;
  run_id: string | null;
  role: "user" | "assistant";
  text: string;
  created_at: number;
  /** JSON MessageOrigin, or null for the owner's own words (and every assistant message). */
  origin?: string | null;
}

/**
 * Where a user-role message came from, when not the owner: another agent's conversation. `peer` is a
 * message in (desk mail, or a Claude session's native SendMessage, read from the session transcript);
 * `peer-out` is a native SendMessage this thread sent. `inline` marks one read mid-turn rather than
 * starting a turn of its own.
 */
export interface MessageOrigin {
  kind: "peer" | "peer-out";
  /** Who: the sender's (or recipient's) display name. */
  name?: string;
  /** The sender's address: a desk item id for desk mail, a session name for native messages. */
  from?: string;
  to?: string;
  /** Desk mail id, or the native message id: one message is filed once. */
  mailId?: string;
  inline?: boolean;
}

export interface AttachmentRow {
  id: string;
  thread_id: string;
  message_id: string;
  run_id: string | null;
  name: string;
  mime_type: string;
  size_bytes: number;
  path: string;
  created_at: number;
}

export interface ItemRow {
  id: string;
  thread_id: string;
  run_id: string | null;
  kind: string;
  name: string;
  input: string | null;
  output_head: string | null;
  output_tail: string | null;
  output_bytes: number;
  status: "running" | "completed" | "failed";
  created_at: number;
  updated_at: number;
}

export interface RequestRow {
  id: string;
  thread_id: string;
  run_id: string | null;
  kind: RequestKind;
  payload: string;
  status: "open" | "answered" | "expired";
  answer: string | null;
  created_at: number;
  resolved_at: number | null;
}

export interface ChangeRow {
  seq: number;
  thread_id: string;
  entity: Entity;
  entity_id: string;
  created_at: number;
}

export interface CommandReceipt {
  command_id: string;
  thread_id: string | null;
  type: string;
  accepted: number;
  result: string;
  created_at: number;
}

/** Bytes kept from the start and from the end of tool output and tool input. */
export const OUTPUT_HEAD_BYTES = 8 * 1024;
export const OUTPUT_TAIL_BYTES = 8 * 1024;
export const INPUT_CAP_BYTES = 16 * 1024;

export function capText(text: string, head = OUTPUT_HEAD_BYTES, tail = OUTPUT_TAIL_BYTES): {
  head: string;
  tail: string | null;
  bytes: number;
} {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= head + tail) return { head: text, tail: null, bytes: buf.length };
  return {
    head: buf.subarray(0, head).toString("utf8"),
    tail: buf.subarray(buf.length - tail).toString("utf8"),
    bytes: buf.length,
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS coordinator_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS triggers (
 id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, kind TEXT NOT NULL, spec TEXT NOT NULL, note TEXT NOT NULL, dedup_key TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL, fired_at INTEGER, detail TEXT, last_checked_at INTEGER, last_error TEXT
);
CREATE INDEX IF NOT EXISTS triggers_waiting ON triggers(status, dedup_key);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT,
  cwd TEXT NOT NULL,
  provider TEXT NOT NULL,
  account TEXT,
  native_session_id TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  source TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  failure TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS runs_thread ON runs(thread_id, position);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  account TEXT,
  native_session_id TEXT,
  status TEXT NOT NULL,
  failure TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS attempts_run ON attempts(run_id);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  run_id TEXT,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, created_at);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  run_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  input TEXT,
  output_head TEXT,
  output_tail TEXT,
  output_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS items_thread ON items(thread_id, created_at);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  run_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  answer TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  message_id TEXT,
  run_id TEXT,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_id);
CREATE INDEX IF NOT EXISTS attachments_run ON attachments(run_id);
CREATE TABLE IF NOT EXISTS commands (
  command_id TEXT PRIMARY KEY,
  thread_id TEXT,
  type TEXT NOT NULL,
  accepted INTEGER NOT NULL,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS changes_thread ON changes(thread_id, seq);
CREATE TABLE IF NOT EXISTS ledger (
  pid INTEGER PRIMARY KEY,
  thread_id TEXT,
  command TEXT NOT NULL,
  started TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

/**
 * Loom's SQLite store. Every write that clients can observe goes through
 * `tx()`, which appends change rows in the same transaction and hands them to
 * `onCommit` only after the commit succeeds, in sequence order.
 */
export class LoomStore {
  readonly db: DatabaseSync;
  private pending: ChangeRow[] = [];
  private depth = 0;
  onCommit: (changes: ChangeRow[]) => void = () => {};
  now: () => number = Date.now;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // auto_vacuum only takes effect before the first table exists.
    this.db.exec("PRAGMA auto_vacuum = INCREMENTAL;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.db.exec(LEASE_SCHEMA);
    this.db.exec(`CREATE TABLE IF NOT EXISTS tool_denials (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL, tool TEXT NOT NULL, source TEXT, at INTEGER NOT NULL,
      PRIMARY KEY (run_id,item_id)
    )`);
    const triggerColumns = this.db.prepare("PRAGMA table_info(triggers)").all() as { name: string }[];
    for (const [name, type] of [["ask_id", "TEXT"], ["consecutive_errors", "INTEGER NOT NULL DEFAULT 0"], ["error_since", "INTEGER"]]) {
      if (!triggerColumns.some(c => c.name === name)) this.db.exec(`ALTER TABLE triggers ADD COLUMN ${name} ${type}`);
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS turn_handoffs (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      record TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS turn_handoffs_thread ON turn_handoffs(thread_id);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS thread_clears (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      cleared_at INTEGER NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, cleared_at)
    )`);
    // Added after the first release: allowed accounts, the thread's repo, and where its title came from.
    const columns = this.db.prepare("PRAGMA table_info(threads)").all() as { name: string }[];
    // background: the session's running background tasks; ask: the thread's open ask (both added 10/17).
    for (const column of ["accounts", "accounts_source", "repo", "title_source", "background", "host_release", "host_instance_id", "ask"]) {
      if (!columns.some((c) => c.name === column)) this.db.exec(`ALTER TABLE threads ADD COLUMN ${column} TEXT`);
    }
    if (!columns.some(c => c.name === "session_profile")) this.db.exec("ALTER TABLE threads ADD COLUMN session_profile TEXT");
    if (!(this.db.prepare("PRAGMA table_info(runs)").all() as {name: string}[]).some(c => c.name === "wake_cause")) this.db.exec("ALTER TABLE runs ADD COLUMN wake_cause TEXT");
    if (!(this.db.prepare("PRAGMA table_info(runs)").all() as {name: string}[]).some(c => c.name === "context")) this.db.exec("ALTER TABLE runs ADD COLUMN context TEXT");
    // Decision briefs (added 10/19): the ledger of what threads brought to their owner (docs/specs/decisions-and-delegation.md).
    this.db.exec(DECISIONS_SCHEMA);
    // Only new decision answers enter this outbox; never replay historical agent replies.
    this.db.exec(`CREATE TABLE IF NOT EXISTS decision_deliveries (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      acknowledged_at INTEGER
    )`);
    this.db.exec(ASKS_SCHEMA);
    // Level 4 logs and reversals (phase 2b, added 10/19).
    const decisionColumns = this.db.prepare("PRAGMA table_info(decisions)").all() as { name: string }[];
    for (const [name, type] of DECISION_COLUMNS) {
      if (!decisionColumns.some((c) => c.name === name)) this.db.exec(`ALTER TABLE decisions ADD COLUMN ${name} ${type}`);
    }
    // The ask lint's classifications of prose "Next — you" asks (TGO-1074, added 10/19).
    this.db.exec(ASK_LINT_SCHEMA);
    const lintColumns = this.db.prepare("PRAGMA table_info(ask_lints)").all() as { name: string }[];
    for (const column of ["declared_kind", "ask_id"]) {
      if (!lintColumns.some(c => c.name === column)) this.db.exec(`ALTER TABLE ask_lints ADD COLUMN ${column} TEXT`);
    }
    this.db.exec(PRESENCE_SCHEMA);
    // The learning loop (phase 3, added 10/19): standing rules, learned class levels, and what changed them.
    this.db.exec(RULES_SCHEMA);
    this.db.exec("CREATE TABLE IF NOT EXISTS deleted_worktrees (id TEXT PRIMARY KEY, thread TEXT NOT NULL)");
    for (const column of ["worktree_archive", "worktree_branch", "worktree_head"]) {
      if (!columns.some((c) => c.name === column)) this.db.exec(`ALTER TABLE threads ADD COLUMN ${column} TEXT`);
    }
    if (!columns.some((c) => c.name === "worktree_removed_at")) this.db.exec("ALTER TABLE threads ADD COLUMN worktree_removed_at INTEGER");
    if (!columns.some(c => c.name === "worktree_mode")) {
      this.db.exec("ALTER TABLE threads ADD COLUMN worktree_mode TEXT NOT NULL DEFAULT 'local' CHECK (worktree_mode IN ('auto', 'worktree', 'local'))");
      const root = resolve(dirname(path), "worktrees");
      const update = this.db.prepare("UPDATE threads SET worktree_mode = 'worktree' WHERE id = ?");
      for (const row of this.db.prepare("SELECT id, cwd, kind FROM threads").all() as { id: string; cwd: string; kind: string }[]) {
        const rel = relative(root, resolve(row.cwd));
        if (row.kind !== "probe" && rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep)) update.run(row.id);
      }
    }
    if (!columns.some((c) => c.name === "worktree_shrunk_at")) this.db.exec("ALTER TABLE threads ADD COLUMN worktree_shrunk_at INTEGER");
    if (!columns.some((c) => c.name === "host_seq")) this.db.exec("ALTER TABLE threads ADD COLUMN host_seq INTEGER NOT NULL DEFAULT 0");
    for (const [name, type] of [["cooled_at", "INTEGER"], ["cooling_note", "TEXT"], ["admission", "TEXT"], ["admission_until", "INTEGER"], ["fresh", "TEXT"], ["fresh_opt_out", "INTEGER"], ["budget", "INTEGER"], ["budget_raise", "TEXT"], ["budget_fresh_day", "INTEGER"]]) {
      if (!columns.some(c => c.name === name)) this.db.exec(`ALTER TABLE threads ADD COLUMN ${name} ${type}`);
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS host_opens (
      id INTEGER PRIMARY KEY AUTOINCREMENT, threadId TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      reason TEXT NOT NULL, ms REAL NOT NULL, at INTEGER NOT NULL)`);
    // Thread roles (TGO-1031), added 10/17.
    if (!columns.some((c) => c.name === "role")) this.db.exec("ALTER TABLE threads ADD COLUMN role TEXT NOT NULL DEFAULT 'interactive'");
    if (!columns.some((c) => c.name === "parent_thread_id")) this.db.exec("ALTER TABLE threads ADD COLUMN parent_thread_id TEXT");
    // The space's standing chat was first called `coordinator` (docs/specs/spaces.md calls it `default`).
    this.db.exec("UPDATE threads SET role = 'default' WHERE role = 'coordinator'");
    this.db.exec(`CREATE TABLE IF NOT EXISTS host_wakes (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      instance_id TEXT NOT NULL, wake_id TEXT NOT NULL, run_id TEXT NOT NULL,
      PRIMARY KEY (thread_id, instance_id, wake_id)
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS host_moves (
      thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
      instance_id TEXT, note TEXT
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS account_moves (
      thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, account TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS account_history (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      account TEXT NOT NULL, at INTEGER NOT NULL, reason TEXT NOT NULL
    )`);
    // Where a user-role message came from (JSON MessageOrigin; null: the owner), added 10/16.
    const messageColumns = this.db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    if (!messageColumns.some((c) => c.name === "origin")) this.db.exec("ALTER TABLE messages ADD COLUMN origin TEXT");
    // A steer into a running turn: 'pending' until its host confirms it, then 'delivered' (added with session hosts).
    if (!messageColumns.some((c) => c.name === "delivery")) this.db.exec("ALTER TABLE messages ADD COLUMN delivery TEXT");
    if (!messageColumns.some((c) => c.name === "command_id")) this.db.exec("ALTER TABLE messages ADD COLUMN command_id TEXT");
    this.tx(() => migrateAsks(this));
  }

  pendingAccountMove(threadId: string): string | null {
    return (this.db.prepare("SELECT account FROM account_moves WHERE thread_id = ?").get(threadId) as { account: string } | undefined)?.account ?? null;
  }

  setAccountMove(threadId: string, account: string): void {
    this.db.prepare("INSERT INTO account_moves VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET account = excluded.account").run(threadId, account);
  }

  endAccountMove(threadId: string): void {
    this.db.prepare("DELETE FROM account_moves WHERE thread_id = ?").run(threadId);
  }

  recordAccount(threadId: string, account: string, reason: "balance" | "move" | "low" | "limit" | "auth"): void {
    this.db.prepare("INSERT INTO account_history VALUES (?, ?, ?, ?)").run(threadId, account, this.now(), reason);
  }

  accountHistory(threadId: string): { account: string; at: number; reason: "balance" | "start" | "limit" | "auth" | "move" | "low" }[] {
    const attempts = this.db.prepare("SELECT * FROM attempts WHERE thread_id = ? ORDER BY started_at, rowid").all(threadId) as unknown as AttemptRow[];
    const recorded = this.db.prepare("SELECT account, at, reason FROM account_history WHERE thread_id = ? ORDER BY at, rowid").all(threadId) as unknown as ReturnType<LoomStore["accountHistory"]>;
    const first = attempts.find((a) => a.account !== null);
    const events = [
      ...recorded.map((r) => ({ ...r, source: 0 })),
      ...attempts.filter((a) => a.account !== null && a !== first).map((a) => {
        const previous = attempts[attempts.indexOf(a) - 1];
        const kind = previous?.failure ? (JSON.parse(previous.failure) as { kind?: string }).kind : null;
        const reason = kind === "usage_limit" ? "limit" as const : kind === "auth" ? "auth" as const : "low" as const;
        return { account: a.account!, at: a.started_at, reason, source: 1 };
      }),
    ].sort((a, b) => a.at - b.at || a.source - b.source);
    // The first attempt sorts with everything else: a move can be recorded before any attempt ran.
    if (first) events.push({ account: first.account!, at: first.started_at, reason: "start", source: 1 });
    events.sort((a, b) => a.at - b.at || a.source - b.source);
    const result: ReturnType<LoomStore["accountHistory"]> = [];
    for (const { source, ...event } of events) {
      if (source === 0 || result.at(-1)?.account !== event.account) result.push(event);
    }
    return result;
  }

  hostMove(threadId: string): { instance_id: string | null; note: string | null } | undefined {
    return this.db.prepare("SELECT instance_id, note FROM host_moves WHERE thread_id = ?").get(threadId) as { instance_id: string | null; note: string | null } | undefined;
  }

  beginHostMove(threadId: string, instanceId: string | null, note: string | null): void {
    this.db.prepare("INSERT INTO host_moves(thread_id, instance_id, note) VALUES (?, ?, ?)").run(threadId, instanceId, note);
  }

  endHostMove(threadId: string): void { this.db.prepare("DELETE FROM host_moves WHERE thread_id = ?").run(threadId); }

  private closed = false;

  close(): void {
    this.closed = true;
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.depth = 1;
    this.db.exec("BEGIN IMMEDIATE");
    let result: T;
    try {
      result = fn();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.pending = [];
      this.depth = 0;
      throw error;
    }
    this.depth = 0;
    const committed = this.pending;
    this.pending = [];
    if (committed.length > 0) this.onCommit(committed);
    return result;
  }

  private change(threadId: string, entity: Entity, entityId: string): void {
    const at = this.now();
    const info = this.db
      .prepare("INSERT INTO changes (thread_id, entity, entity_id, created_at) VALUES (?, ?, ?, ?)")
      .run(threadId, entity, entityId, at);
    this.pending.push({ seq: Number(info.lastInsertRowid), thread_id: threadId, entity, entity_id: entityId, created_at: at });
  }

  // Command receipts

  receipt(commandId: string): CommandReceipt | undefined {
    return this.db.prepare("SELECT * FROM commands WHERE command_id = ?").get(commandId) as CommandReceipt | undefined;
  }

  writeReceipt(commandId: string, type: string, threadId: string | null, accepted: boolean, result: unknown): void {
    this.db
      .prepare("INSERT INTO commands (command_id, thread_id, type, accepted, result, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(commandId, threadId, type, accepted ? 1 : 0, JSON.stringify(result ?? null), this.now());
  }

  forgetReceipt(commandId: string): void {
    this.db.prepare("DELETE FROM commands WHERE command_id = ?").run(commandId);
  }

  /** Rewrite an accepted command's stored result (a steer that fell back to a queued run). */
  replaceReceipt(commandId: string, result: unknown): void {
    this.db.prepare("UPDATE commands SET result = ? WHERE command_id = ?").run(JSON.stringify(result ?? null), commandId);
  }

  // Threads

  createThread(input: {
    id?: string;
    kind: string;
    title?: string | null;
    cwd: string;
    provider: string;
    account?: string | null;
    accounts?: string[] | null;
    accountsSource?: "policy" | null;
    repo?: string | null;
    worktreeMode?: WorktreeMode;
    titleSource?: ThreadRow["title_source"];
    role?: ThreadRole;
    parentThreadId?: string | null;
  }): ThreadRow {
    const id = input.id ?? randomUUID();
    const at = this.now();
    this.db
      .prepare(
        "INSERT INTO threads (id, kind, title, cwd, provider, account, accounts, accounts_source, repo, title_source, role, parent_thread_id, worktree_mode, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)",
      )
      .run(
        id,
        input.kind,
        input.title ?? null,
        input.cwd,
        input.provider,
        input.account ?? null,
        input.accounts?.length ? JSON.stringify(input.accounts) : null,
        input.accountsSource ?? null,
        input.repo ?? null,
        input.titleSource ?? null,
        input.role ?? "interactive",
        input.parentThreadId ?? null,
        input.worktreeMode ?? "local",
        at,
        at,
      );
    this.change(id, "thread", id);
    return this.thread(id)!;
  }

  thread(id: string): ThreadRow | undefined {
    return this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | undefined;
  }

  /** Threads whose open ask mentions these words (a decision id): a coarse match the caller narrows. */
  threadsAskingAbout(words: string): ThreadRow[] {
    return this.db.prepare("SELECT * FROM threads WHERE ask IS NOT NULL AND instr(ask, ?) > 0").all(words) as unknown as ThreadRow[];
  }

  /**
   * Threads whose newest agent message mentions these words (a decision id), with that message: a coarse match the
   * caller narrows. Not stopped ones.
   */
  threadsLastSaying(words: string): Array<{ thread: ThreadRow; text: string }> {
    const rows = this.db.prepare(
      `SELECT m.thread_id AS thread_id, m.text AS text FROM messages m
       WHERE m.role = 'assistant' AND instr(m.text, ?) > 0
         AND m.created_at = (SELECT MAX(created_at) FROM messages WHERE thread_id = m.thread_id AND role = 'assistant')`,
    ).all(words) as Array<{ thread_id: string; text: string }>;
    return rows.flatMap((row) => {
      const thread = this.thread(row.thread_id);
      return thread && thread.status !== "stopped" ? [{ thread, text: row.text }] : [];
    });
  }

  threads(): ThreadRow[] {
    return this.db.prepare("SELECT * FROM threads ORDER BY updated_at DESC").all() as unknown as ThreadRow[];
  }

  hostWake(threadId: string, instanceId: string, wakeId: string): string | undefined {
    return (this.db.prepare("SELECT run_id FROM host_wakes WHERE thread_id = ? AND instance_id = ? AND wake_id = ?").get(threadId, instanceId, wakeId) as { run_id: string } | undefined)?.run_id;
  }

  bindHostWake(threadId: string, instanceId: string, wakeId: string, runId: string): void {
    this.db.prepare("INSERT INTO host_wakes (thread_id, instance_id, wake_id, run_id) VALUES (?, ?, ?, ?)").run(threadId, instanceId, wakeId, runId);
  }

  touchThread(id: string): void { this.change(id, "thread", id); }

  updateThread(id: string, patch: Partial<Pick<ThreadRow, "cwd" | "repo" | "provider" | "fresh" | "fresh_opt_out" | "budget" | "budget_raise" | "budget_fresh_day" | "session_profile" | "accounts" | "accounts_source" | "cooled_at" | "cooling_note" | "admission" | "admission_until" | "worktree_mode" | "worktree_archive" | "worktree_removed_at" | "worktree_branch" | "worktree_head" | "worktree_shrunk_at" | "status" | "account" | "native_session_id" | "title" | "title_source" | "settled_at" | "background" | "ask" | "host_release" | "host_instance_id" | "host_seq" | "role" | "parent_thread_id">>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    const values = keys.map((k) => (patch[k] ?? null) as string | number | null);
    this.db.prepare(`UPDATE threads SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, this.now(), id);
    this.change(id, "thread", id);
  }

  deletedWorktrees(): ThreadRow[] {
    return (this.db.prepare("SELECT thread FROM deleted_worktrees").all() as { thread: string }[]).map((r) => JSON.parse(r.thread) as ThreadRow);
  }

  forgetDeletedWorktree(id: string): void { this.db.prepare("DELETE FROM deleted_worktrees WHERE id = ?").run(id); }

  /**
   * Hard delete: the thread and everything under it. A final thread change
   * whose entity no longer exists is the tombstone: subscribers see `data: null`
   * and drop the thread. Older change rows stay until compaction, so resuming
   * from any earlier sequence still reaches the tombstone.
   */
  deleteThread(id: string, preserveWorktree = false): void {
    const thread = this.thread(id);
    if (thread && preserveWorktree) this.db.prepare("INSERT OR REPLACE INTO deleted_worktrees VALUES (?, ?)").run(id, JSON.stringify(thread));
    this.db.prepare("DELETE FROM threads WHERE id = ?").run(id);
    this.change(id, "thread", id);
  }

  // Runs and attempts

  createRun(threadId: string, source: RunSource, text: string): RunRow {
    const id = randomUUID();
    const row = this.db.prepare("SELECT COALESCE(MAX(position), 0) AS p FROM runs WHERE thread_id = ?").get(threadId) as { p: number };
    this.db
      .prepare("INSERT INTO runs (id, thread_id, position, source, text, status, created_at, wake_cause) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)")
      .run(id, threadId, row.p + 1, source, text, this.now(), source === "wake" ? wakeCause(text) : null);
    // A decision can finish in a later explicit wait (for example, a delegated order's receipt).
    // Preserve its delivery route without forwarding internal corrective or reset turns.
    if (source === "wake" && (text.startsWith("Loom: the trigger you set fired:") || text.startsWith("Loom: the wait timed out:")) && this.db.prepare(
      "SELECT 1 FROM decision_deliveries d JOIN runs r ON r.id=d.run_id WHERE r.thread_id=? LIMIT 1"
    ).get(threadId)) this.queueDecisionDelivery(id);
    this.change(threadId, "run", id);
    return this.run(id)!;
  }

  run(id: string): RunRow | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
  }

  lastRunEndedAt(threadId: string): number | null {
    const row = this.db.prepare("SELECT MAX(ended_at) AS ended_at FROM runs WHERE thread_id = ?").get(threadId) as { ended_at: number | null } | undefined;
    return row?.ended_at ?? null;
  }

  hasPendingWait(threadId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM triggers WHERE thread_id = ? AND status = 'waiting' AND ask_id IS NULL LIMIT 1").get(threadId);
  }

  runs(threadId: string): RunRow[] {
    return this.db.prepare("SELECT * FROM runs WHERE thread_id = ? ORDER BY position").all(threadId) as unknown as RunRow[];
  }

  nextQueuedRun(threadId: string): RunRow | undefined {
    return this.db
      .prepare("SELECT * FROM runs WHERE thread_id = ? AND status = 'queued' ORDER BY position LIMIT 1")
      .get(threadId) as RunRow | undefined;
  }

  queuedRuns(threadId: string): RunRow[] {
    return this.db.prepare("SELECT * FROM runs WHERE thread_id = ? AND status = 'queued' ORDER BY position").all(threadId) as unknown as RunRow[];
  }

  /** Folds queued runs into another: it takes the combined words and their messages, and they end canceled. */
  foldRuns(intoId: string, ids: string[], text: string): void {
    const into = this.run(intoId);
    if (!into) return;
    this.db.prepare("UPDATE runs SET text = ? WHERE id = ?").run(text, intoId);
    this.change(into.thread_id, "run", intoId);
    for (const id of ids) {
      this.db.prepare("UPDATE messages SET run_id = ? WHERE run_id = ?").run(intoId, id);
      this.updateRun(id, { status: "canceled", failure: JSON.stringify({ code: "folded", message: `Folded into run ${intoId}` }), ended_at: this.now() });
    }
  }

  activeRun(threadId: string): RunRow | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE thread_id = ? AND status = 'running' LIMIT 1").get(threadId) as RunRow | undefined;
  }

  updateRun(id: string, patch: Partial<Pick<RunRow, "context" | "status" | "failure" | "started_at" | "ended_at">>): void {
    const run = this.run(id);
    if (!run) return;
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    const values = keys.map((k) => (patch[k] ?? null) as string | number | null);
    this.db.prepare(`UPDATE runs SET ${sets} WHERE id = ?`).run(...values, id);
    this.change(run.thread_id, "run", id);
  }

  createAttempt(run: RunRow, account: string | null, nativeSessionId: string | null): AttemptRow {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO attempts (id, run_id, thread_id, account, native_session_id, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)",
      )
      .run(id, run.id, run.thread_id, account, nativeSessionId, this.now());
    return this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(id) as unknown as AttemptRow;
  }

  attempts(runId: string): AttemptRow[] {
    return this.db.prepare("SELECT * FROM attempts WHERE run_id = ? ORDER BY started_at").all(runId) as unknown as AttemptRow[];
  }

  endAttempts(runId: string, status: RunStatus, failure: string | null): void {
    this.db
      .prepare("UPDATE attempts SET status = ?, failure = ?, ended_at = ? WHERE run_id = ? AND status = 'running'")
      .run(status, failure, this.now(), runId);
  }

  setAttemptNativeSession(runId: string, nativeSessionId: string): void {
    this.db.prepare("UPDATE attempts SET native_session_id = ? WHERE run_id = ? AND status = 'running'").run(nativeSessionId, runId);
  }

  // Messages and items

  queueDecisionDelivery(runId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO decision_deliveries(run_id) VALUES (?)").run(runId);
  }

  pendingDecisionDeliveries(): Array<{ runId: string; loomThreadId: string; prompt: string; createdAt: number }> {
    return this.db.prepare(`SELECT r.id AS runId, r.thread_id AS loomThreadId, r.text AS prompt, r.created_at AS createdAt
      FROM decision_deliveries d JOIN runs r ON r.id=d.run_id
      WHERE d.acknowledged_at IS NULL ORDER BY r.created_at, r.id`).all() as Array<{ runId: string; loomThreadId: string; prompt: string; createdAt: number }>;
  }

  acknowledgeDecisionDelivery(runId: string): void {
    this.db.prepare("UPDATE decision_deliveries SET acknowledged_at=? WHERE run_id=? AND acknowledged_at IS NULL").run(this.now(), runId);
  }

  addMessage(threadId: string, runId: string | null, role: "user" | "assistant", text: string, origin: MessageOrigin | null = null, createdAt?: number): MessageRow {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO messages (id, thread_id, run_id, role, text, created_at, origin) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, threadId, runId, role, text, createdAt ?? this.now(), origin ? JSON.stringify(origin) : null);
    this.change(threadId, "message", id);
    return this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as unknown as MessageRow;
  }

  // Images on messages (bytes on disk, see attachments.ts)

  /** A steer's delivery state, and the command that sent it (its receipt is rewritten if it falls back). */
  setDelivery(messageId: string, delivery: "pending" | "delivered" | null, commandId?: string): void {
    if (commandId) this.db.prepare("UPDATE messages SET delivery = ?, command_id = ? WHERE id = ?").run(delivery, commandId, messageId);
    else this.db.prepare("UPDATE messages SET delivery = ? WHERE id = ?").run(delivery, messageId);
  }

  /** Steers recorded but not yet confirmed by a host. */
  pendingSteers(threadId: string): { id: string; run_id: string | null; text: string; command_id: string | null }[] {
    return this.db.prepare("SELECT id, run_id, text, command_id FROM messages WHERE thread_id = ? AND delivery = 'pending' ORDER BY created_at").all(threadId) as { id: string; run_id: string | null; text: string; command_id: string | null }[];
  }

  /** Move a message and its images to another run of the same thread. */
  moveMessageToRun(messageId: string, runId: string): void {
    this.db.prepare("UPDATE messages SET run_id = ? WHERE id = ?").run(runId, messageId);
    this.db.prepare("UPDATE attachments SET run_id = ? WHERE message_id = ?").run(runId, messageId);
  }

  addAttachment(input: { id: string; threadId: string; messageId: string; runId: string | null; name: string; mimeType: string; sizeBytes: number; path: string }): void {
    this.db
      .prepare(
        "INSERT INTO attachments (id, thread_id, message_id, run_id, name, mime_type, size_bytes, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(input.id, input.threadId, input.messageId, input.runId, input.name, input.mimeType, input.sizeBytes, input.path, this.now());
    this.change(input.threadId, "message", input.messageId);
  }

  attachment(id: string): AttachmentRow | undefined {
    return this.db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as AttachmentRow | undefined;
  }

  /** The images sent with a run's own message (what its first attempt hands the harness). */
  /** One message's images, oldest first. */
  attachmentsOfMessage(messageId: string): AttachmentRow[] {
    return this.db.prepare("SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at, rowid").all(messageId) as unknown as AttachmentRow[];
  }

  runAttachments(runId: string): AttachmentRow[] {
    return this.db.prepare("SELECT * FROM attachments WHERE run_id = ? ORDER BY created_at, rowid").all(runId) as unknown as AttachmentRow[];
  }

  /** A thread's images, by message, as clients list them (no paths). */
  messageAttachments(threadId: string): Map<string, { id: string; name: string; mime_type: string; size_bytes: number }[]> {
    const rows = this.db
      .prepare("SELECT id, message_id, name, mime_type, size_bytes FROM attachments WHERE thread_id = ? ORDER BY created_at, rowid")
      .all(threadId) as unknown as { id: string; message_id: string; name: string; mime_type: string; size_bytes: number }[];
    const byMessage = new Map<string, { id: string; name: string; mime_type: string; size_bytes: number }[]>();
    for (const { message_id, ...row } of rows) byMessage.set(message_id, [...(byMessage.get(message_id) ?? []), row]);
    return byMessage;
  }

  /** The name a native peer last wrote under from this socket address (to name replies sent there). */
  peerNameAt(address: string): string | null {
    const row = this.db.prepare("SELECT json_extract(origin, '$.name') AS name FROM messages WHERE origin IS NOT NULL AND json_extract(origin, '$.kind') = 'peer' AND json_extract(origin, '$.from') = ? ORDER BY created_at DESC LIMIT 1").get(address) as { name: string | null } | undefined;
    return row?.name ?? null;
  }

  /** Whether a message with this origin mail id is already filed in the thread (native messages are read more than once). */
  hasOriginMail(threadId: string, mailId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 AS ok FROM messages WHERE thread_id = ? AND origin IS NOT NULL AND json_extract(origin, '$.mailId') = ?").get(threadId, mailId));
  }

  messages(threadId: string): MessageRow[] {
    return this.db.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at, rowid").all(threadId) as unknown as MessageRow[];
  }

  /** Insert or update a tool item. Input and output are capped before they reach the row. */
  upsertItem(input: {
    id: string;
    threadId: string;
    runId: string | null;
    kind: string;
    name: string;
    input?: string | null;
    output?: string | null;
    status: ItemRow["status"];
  }): void {
    const at = this.now();
    const capped = input.output == null ? null : capText(input.output);
    const cappedInput = input.input == null ? null : capText(input.input, INPUT_CAP_BYTES, 0).head;
    const existing = this.db.prepare("SELECT id FROM items WHERE id = ?").get(input.id);
    if (existing) {
      this.db
        .prepare(
          `UPDATE items SET status = ?, updated_at = ?,
             input = COALESCE(?, input),
             output_head = COALESCE(?, output_head),
             output_tail = CASE WHEN ? THEN ? ELSE output_tail END,
             output_bytes = COALESCE(?, output_bytes)
           WHERE id = ?`,
        )
        .run(
          input.status,
          at,
          cappedInput,
          capped?.head ?? null,
          capped ? 1 : 0,
          capped?.tail ?? null,
          capped?.bytes ?? null,
          input.id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO items (id, thread_id, run_id, kind, name, input, output_head, output_tail, output_bytes, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.threadId,
          input.runId,
          input.kind,
          input.name,
          cappedInput,
          capped?.head ?? null,
          capped?.tail ?? null,
          capped?.bytes ?? 0,
          input.status,
          at,
          at,
        );
    }
    this.change(input.threadId, "item", input.id);
  }

  items(threadId: string): ItemRow[] {
    return this.db.prepare("SELECT * FROM items WHERE thread_id = ? ORDER BY created_at, rowid").all(threadId) as unknown as ItemRow[];
  }

  // Requests (questions and plan exits)

  /** The next decision id, D-<n>: short enough to name ("answer decision D-12"), and never reused. */
  nextDecisionId(): string {
    const row = this.db.prepare("UPDATE decision_seq SET last = last + 1 WHERE id = 1 RETURNING last").get() as { last: number };
    return `D-${row.last}`;
  }

  addDecision(row: Omit<DecisionRow, "decided_by" | "answer_option" | "answer_text" | "answer_reason" | "followed_recommendation" | "rule_choice" | "resolved_at" | "created_at" | "status" | "undo" | "ref" | "reversed_at" | "reversal" | "reversal_note" | "confirmed_at" | "rule_id" | "dissent" | "revision" | "changes" | "window_from" | "decided_in" | "precedent" | "proposal" | "precedent_of">): DecisionRow {
    this.db
      .prepare("INSERT INTO decisions (id, thread_id, run_id, class, level, candidate, status, ask, brief, supersedes, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)")
      .run(row.id, row.thread_id, row.run_id, row.class, row.level, row.candidate, row.ask, row.brief, row.supersedes, this.now());
    this.change(row.thread_id, "thread", row.thread_id);
    return this.decision(row.id)!;
  }

  /** An open brief revised in place (decision.update, TGO-1079): same id, the next revision, its change logged. */
  reviseDecision(id: string, fields: Pick<DecisionRow, "level" | "candidate" | "ask" | "brief" | "revision" | "changes" | "window_from">): void {
    const row = this.decision(id);
    if (!row) return;
    // A revision addresses the reply, but the owner still needs to read the completed turn.
    const discussing = row.discussing_since != null;
    this.db
      .prepare("UPDATE decisions SET kept_at=?, unaddressed_at=NULL, level=?, candidate=?, ask=?, brief=?, revision=?, changes=?, window_from=? WHERE id=?")
      .run(discussing ? this.now() : null, fields.level, fields.candidate, fields.ask, fields.brief, fields.revision, fields.changes, discussing ? row.window_from : fields.window_from, id);
    this.change(row.thread_id, "thread", row.thread_id);
  }

  /** A level 4 action the agent took and logged (decision.log): decided by the agent, nothing to answer. */
  logDecision(row: Pick<DecisionRow, "id" | "thread_id" | "run_id" | "class" | "level" | "ask" | "undo" | "ref"> & Partial<Pick<DecisionRow, "rule_id" | "dissent">>): DecisionRow {
    const now = this.now();
    // Under a standing rule, the rule decided it (decided_by rule:<id>): its reversal suspends the rule.
    const by = row.rule_id ? `rule:${row.rule_id}` : "agent";
    this.db
      .prepare("INSERT INTO decisions (id, thread_id, run_id, class, level, candidate, status, ask, brief, decided_by, undo, ref, rule_id, dissent, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, 0, 'acted', ?, 'null', ?, ?, ?, ?, ?, ?, ?)")
      .run(row.id, row.thread_id, row.run_id, row.class, row.level, row.ask, by, row.undo, row.ref, row.rule_id ?? null, row.dissent ?? null, now, now);
    this.change(row.thread_id, "thread", row.thread_id);
    return this.decision(row.id)!;
  }

  /**
   * Acted and defaulted decisions resolved at or after `since`, oldest first, with their thread's title: a reader that
   * marks what it showed as seen never skips past rows a limit left out (the next read starts with them).
   */
  decided(since: number, limit = 200, until = Number.MAX_SAFE_INTEGER): Array<DecisionRow & { thread_title: string | null }> {
    const marks = DECIDED_STATUSES.map(() => "?").join(", ");
    return this.db
      .prepare(`SELECT d.*, t.title AS thread_title FROM decisions d JOIN threads t ON t.id = d.thread_id WHERE d.status IN (${marks}) AND COALESCE(d.resolved_at, d.created_at) BETWEEN ? AND ? ORDER BY COALESCE(d.resolved_at, d.created_at), d.created_at, d.id LIMIT ?`)
      .all(...DECIDED_STATUSES, since, until, limit) as unknown as Array<DecisionRow & { thread_title: string | null }>;
  }

  /** The owner's "Fine by me" on something decided for them (decision.confirm). */
  confirmDecision(id: string): void {
    const row = this.decision(id);
    if (!row) return;
    this.db.prepare("UPDATE decisions SET confirmed_at=? WHERE id=?").run(this.now(), id);
    this.change(row.thread_id, "thread", row.thread_id);
  }

  /** The owner's reversal of something decided for them (decision.reverse). */
  reverseDecision(id: string, fields: Pick<DecisionRow, "reversal" | "reversal_note">): void {
    const row = this.decision(id);
    if (!row) return;
    this.db.prepare("UPDATE decisions SET reversed_at=?, reversal=?, reversal_note=? WHERE id=?").run(this.now(), fields.reversal, fields.reversal_note, id);
    this.change(row.thread_id, "thread", row.thread_id);
  }

  /** Links an answered brief to the rule it made, or records how the owner chose to treat it (decision.rule). */
  setDecisionRule(id: string, fields: Partial<Pick<DecisionRow, "rule_id" | "rule_choice" | "answer_reason">>): void {
    const row = this.decision(id);
    if (!row) return;
    const next = { ...row, ...fields };
    this.db.prepare("UPDATE decisions SET rule_id=?, rule_choice=?, answer_reason=? WHERE id=?").run(next.rule_id, next.rule_choice, next.answer_reason, id);
    this.change(row.thread_id, "thread", row.thread_id);
  }

  /** Tells clients the thread changed without changing a row (a level 3 brief's time left moved on). */
  noteThread(threadId: string): void {
    this.change(threadId, "thread", threadId);
  }

  decision(id: string): DecisionRow | undefined {
    return this.db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as DecisionRow | undefined;
  }

  openDecisions(threadId: string): DecisionRow[] {
    return this.db.prepare("SELECT * FROM decisions WHERE thread_id = ? AND status = 'open' ORDER BY created_at").all(threadId) as unknown as DecisionRow[];
  }

  decisions(threadId: string): DecisionRow[] {
    return this.db.prepare("SELECT * FROM decisions WHERE thread_id = ? ORDER BY created_at").all(threadId) as unknown as DecisionRow[];
  }

  resolveDecision(id: string, fields: Pick<DecisionRow, "status"> & Partial<Pick<DecisionRow, "decided_by" | "decided_in" | "answer_option" | "answer_text" | "answer_reason" | "followed_recommendation" | "rule_choice">>): void {
    const row = this.decision(id);
    if (!row) return;
    this.db
      .prepare("UPDATE decisions SET discussing_since=NULL, discussing_run=NULL, kept_at=NULL, unaddressed_at=NULL, status=?, decided_by=?, answer_option=?, answer_text=?, answer_reason=?, followed_recommendation=?, rule_choice=?, resolved_at=?, decided_in=? WHERE id=?")
      .run(fields.status, fields.decided_by ?? null, fields.answer_option ?? null, fields.answer_text ?? null, fields.answer_reason ?? null, fields.followed_recommendation ?? null, fields.rule_choice ?? null, this.now(), fields.decided_in ?? null, id);
    this.change(row.thread_id, "thread", row.thread_id);
  }

  openRequest(threadId: string, runId: string | null, kind: RequestKind, payload: unknown, id: string = randomUUID()): RequestRow {
    this.db
      .prepare("INSERT INTO requests (id, thread_id, run_id, kind, payload, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)")
      .run(id, threadId, runId, kind, JSON.stringify(payload), this.now());
    this.change(threadId, "request", id);
    return this.request(id)!;
  }

  request(id: string): RequestRow | undefined {
    return this.db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as RequestRow | undefined;
  }

  requests(threadId: string): RequestRow[] {
    return this.db.prepare("SELECT * FROM requests WHERE thread_id = ? ORDER BY created_at").all(threadId) as unknown as RequestRow[];
  }

  openRequests(threadId: string): RequestRow[] {
    return this.db
      .prepare("SELECT * FROM requests WHERE thread_id = ? AND status = 'open' ORDER BY created_at")
      .all(threadId) as unknown as RequestRow[];
  }

  resolveRequest(id: string, status: "answered" | "expired", answer: unknown): void {
    const req = this.request(id);
    if (!req) return;
    this.db
      .prepare("UPDATE requests SET status = ?, answer = ?, resolved_at = ? WHERE id = ?")
      .run(status, answer === undefined ? null : JSON.stringify(answer), this.now(), id);
    this.change(req.thread_id, "request", id);
  }

  // Change log

  highWater(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM changes").get() as { s: number };
    return row.s;
  }

  changesAfter(seq: number, limit: number): ChangeRow[] {
    return this.db.prepare("SELECT * FROM changes WHERE seq > ? ORDER BY seq LIMIT ?").all(seq, limit) as unknown as ChangeRow[];
  }

  /** Current state of the entity a change row points to, or null if it was deleted. */
  entity(entity: Entity, id: string): unknown {
    const table = { thread: "threads", run: "runs", message: "messages", item: "items", request: "requests" }[entity];
    return this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) ?? null;
  }

  // Orphan ledger

  recordSpawn(pid: number, threadId: string | null, command: string, started: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO ledger (pid, thread_id, command, started, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(pid, threadId, command, started, this.now());
  }

  forgetSpawn(pid: number): void {
    // A harness can exit after shutdown closed the database; its entry is reaped at the next start.
    if (this.closed) return;
    this.db.prepare("DELETE FROM ledger WHERE pid = ?").run(pid);
  }

  spawns(): { pid: number; thread_id: string | null; command: string; started: string }[] {
    return this.db.prepare("SELECT pid, thread_id, command, started FROM ledger").all() as unknown as {
      pid: number;
      thread_id: string | null;
      command: string;
      started: string;
    }[];
  }

  // Retention

  /** Drop old change rows (clients that far behind get a snapshot) and reclaim free pages. */
  compact(keepChanges = 50_000, vacuumPages = 2_000): void {
    const hw = this.highWater();
    this.db.prepare("DELETE FROM changes WHERE seq <= ?").run(hw - keepChanges);
    this.db.prepare("DELETE FROM commands WHERE created_at < ?").run(this.now() - 30 * 24 * 3600 * 1000);
    this.db.exec(`PRAGMA incremental_vacuum(${vacuumPages});`);
  }

  lowWater(): number {
    const row = this.db.prepare("SELECT COALESCE(MIN(seq), 0) AS s FROM changes").get() as { s: number };
    return row.s;
  }
}
