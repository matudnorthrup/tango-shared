import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SqliteDatabase } from "./types.js";

export const SCHEMA_VERSION = 1;
const DEFAULT_DB_DIR_SEGMENTS = [".tango", "atlas"];
const DEFAULT_DB_FILENAME = "memory.db";

export interface OpenAtlasMemoryDatabaseOptions {
  dbPath?: string;
}

function expandHomeDirectory(inputPath: string): string {
  if (inputPath === "~") {
    return os.homedir();
  }
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

export function resolveAtlasMemoryDatabasePath(
  env: NodeJS.ProcessEnv = process.env,
  overridePath?: string,
): string {
  const rawPath = overridePath?.trim() || env.ATLAS_MEMORY_DB?.trim();
  if (rawPath) {
    return expandHomeDirectory(rawPath);
  }

  return path.join(os.homedir(), ...DEFAULT_DB_DIR_SEGMENTS, DEFAULT_DB_FILENAME);
}

export function ensureAtlasMemoryDatabaseDirectory(databasePath: string): void {
  if (databasePath === ":memory:" || databasePath.length === 0) {
    return;
  }

  const directory = path.dirname(databasePath);
  fs.mkdirSync(directory, { recursive: true });
}

export function initializeAtlasMemorySchema(
  db: SqliteDatabase,
  now: Date = new Date(),
): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      agent_id TEXT,
      importance REAL DEFAULT 0.5,
      tags TEXT,
      embedding BLOB,
      embedding_model TEXT,
      created_at TEXT NOT NULL,
      last_accessed_at TEXT NOT NULL,
      access_count INTEGER DEFAULT 0,
      archived_at TEXT,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS pinned_facts (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      scope_id TEXT,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(scope, scope_id, key)
    );

    CREATE TABLE IF NOT EXISTS conversation_summaries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      covers_through TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(session_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memories_agent_source_created
      ON memories(agent_id, source, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_archived_created
      ON memories(archived_at, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pinned_facts_scope
      ON pinned_facts(scope, scope_id, key);
  `);

  const existingVersion = db
    .prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
    .get() as { version: number } | undefined;

  if (!existingVersion) {
    db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)")
      .run(SCHEMA_VERSION, now.toISOString());
  }
}

export function openAtlasMemoryDatabase(
  options?: OpenAtlasMemoryDatabaseOptions,
): { db: SqliteDatabase; path: string } {
  const databasePath = resolveAtlasMemoryDatabasePath(process.env, options?.dbPath);
  ensureAtlasMemoryDatabaseDirectory(databasePath);
  const db = new DatabaseSync(databasePath);
  initializeAtlasMemorySchema(db);
  return {
    db,
    path: databasePath,
  };
}

/**
 * Run `fn` inside one transaction, rolling back if it throws. Nested calls use
 * a savepoint, so a helper that opens its own transaction composes with a
 * caller that already has one open.
 */
export function runInTransaction<T>(db: SqliteDatabase, fn: () => T): T {
  const nested = db.isTransaction;
  const savepoint = "atlas_memory_tx";
  db.exec(nested ? `SAVEPOINT ${savepoint};` : "BEGIN;");
  try {
    const result = fn();
    db.exec(nested ? `RELEASE ${savepoint};` : "COMMIT;");
    return result;
  } catch (error) {
    if (nested) {
      db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint};`);
    } else if (db.isTransaction) {
      db.exec("ROLLBACK;");
    }
    throw error;
  }
}

export function getAtlasMemorySchemaVersion(db: SqliteDatabase): number | null {
  const row = db
    .prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
    .get() as { version: number } | undefined;

  return row?.version ?? null;
}
