import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveSystemDbPath } from "./paths.js";
import type { Ledger } from "./types.js";

/**
 * Schema per docs/specs/system-visibility.md. Each entry runs once, in order,
 * tracked by PRAGMA user_version. Never edit a shipped entry; append a new one.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS jobs(
    id TEXT PRIMARY KEY,
    runner TEXT NOT NULL,
    name TEXT NOT NULL,
    owner TEXT,
    grp TEXT,
    cadence TEXT,
    cadence_seconds INTEGER,
    criticality TEXT NOT NULL DEFAULT 'normal',
    source TEXT,
    logs TEXT,
    probe TEXT,
    state TEXT NOT NULL DEFAULT 'active',
    retired_at TEXT, retire_reason TEXT, archive_path TEXT,
    managed INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT, last_status TEXT,
    last_exit INTEGER, next_run_at TEXT,
    last_used_at TEXT,
    retire_candidate TEXT,
    facts TEXT,
    seen_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS runs(
    id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
    status TEXT NOT NULL,
    exit_code INTEGER, duration_ms INTEGER, summary TEXT, output_tail TEXT, source_ref TEXT
  );
  CREATE INDEX IF NOT EXISTS runs_job ON runs(job_id, id);
  CREATE UNIQUE INDEX IF NOT EXISTS runs_source_ref ON runs(source_ref) WHERE source_ref IS NOT NULL;
  CREATE TABLE IF NOT EXISTS events(
    id INTEGER PRIMARY KEY, at TEXT NOT NULL, source TEXT NOT NULL,
    job_id TEXT, kind TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL, detail TEXT, data TEXT,
    fingerprint TEXT NOT NULL, incident_id INTEGER
  );
  CREATE INDEX IF NOT EXISTS events_at ON events(at);
  CREATE INDEX IF NOT EXISTS events_job ON events(job_id, id);
  CREATE INDEX IF NOT EXISTS events_incident ON events(incident_id);
  CREATE TABLE IF NOT EXISTS incidents(
    id INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL, job_id TEXT, title TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT NOT NULL,
    first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, count INTEGER NOT NULL,
    resolved_at TEXT, snoozed_until TEXT, regressed INTEGER NOT NULL DEFAULT 0, flapping INTEGER NOT NULL DEFAULT 0,
    reopen_count INTEGER NOT NULL DEFAULT 0,
    notified_at TEXT, notified_severity TEXT, notify_pending TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS incidents_open_fp ON incidents(fingerprint) WHERE status != 'resolved';
  CREATE INDEX IF NOT EXISTS incidents_fp ON incidents(fingerprint, resolved_at);
  CREATE INDEX IF NOT EXISTS incidents_job ON incidents(job_id, status);
  CREATE TABLE IF NOT EXISTS cursors(name TEXT PRIMARY KEY, value TEXT);
  `,
  // A recovery the flap guard held back, retried by the tick once the window passes.
  `ALTER TABLE incidents ADD COLUMN held_recovery_at TEXT;`,
  // An explicit repair request can cover several checks, and survive a regression.
  `CREATE TABLE incident_owner_waits(
    fingerprint TEXT PRIMARY KEY, item_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
  );`,
];

function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  let version = row.user_version;
  while (version < MIGRATIONS.length) {
    db.exec("BEGIN IMMEDIATE");
    try {
      // Re-read inside the write lock: another writer may have migrated meanwhile.
      const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (current > version) {
        db.exec("COMMIT");
        version = current;
        continue;
      }
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
      version += 1;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export function openLedger(opts: { path?: string; readonly?: boolean } = {}): Ledger {
  const file = resolveSystemDbPath(opts.path);
  if (opts.readonly) {
    if (!fs.existsSync(file)) throw new Error(`system ledger not found: ${file}`);
    const db = new DatabaseSync(file, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    return { db, path: file, close: () => db.close() };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  migrate(db);
  return {
    db,
    path: file,
    close: () => {
      try {
        db.close();
      } catch {
        // already closed
      }
    },
  };
}

export function getCursor(l: Ledger, name: string): string | null {
  const row = l.db.prepare("SELECT value FROM cursors WHERE name = ?").get(name) as { value: string | null } | undefined;
  return row?.value ?? null;
}

export function setCursor(l: Ledger, name: string, value: string | null): void {
  if (value === null) {
    l.db.prepare("DELETE FROM cursors WHERE name = ?").run(name);
    return;
  }
  l.db.prepare("INSERT INTO cursors(name, value) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(name, value);
}

export function getJsonCursor<T>(l: Ledger, name: string): T | null {
  const raw = getCursor(l, name);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function setJsonCursor(l: Ledger, name: string, value: unknown): void {
  setCursor(l, name, JSON.stringify(value));
}

/** Run fn in one write transaction. */
export function tx<T>(l: Ledger, fn: () => T): T {
  if (l.db.isTransaction) return fn();
  l.db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    l.db.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      l.db.exec("ROLLBACK");
    } catch {
      // nothing to roll back
    }
    throw err;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
