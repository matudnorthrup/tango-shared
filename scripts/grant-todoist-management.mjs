#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const args = process.argv.slice(2);
const file = args[args.indexOf('--db') + 1];
const workerArg = args[args.indexOf('--workers') + 1];
if (!args.includes('--db') || !args.includes('--workers') || !file || !workerArg) throw new Error('Usage: --db /path/to/tango.sqlite --workers worker:coordinator,worker:coordinator-secondary');
const workers = [...new Set(workerArg.split(','))];
if (!workers.every(id => /^worker:[a-z0-9][a-z0-9-]*$/.test(id))) throw new Error('Exact worker IDs required');
if (!existsSync(file)) throw new Error(`Database not found: ${file}`);
const db = new DatabaseSync(file);
try {
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const id of workers) if (!db.prepare("SELECT id FROM principals WHERE id=? AND type='worker'").get(id)) throw new Error(`Unknown worker: ${id}`);
    db.prepare("INSERT OR IGNORE INTO governance_tools (id,domain,display_name,access_type) VALUES ('todoist_manage','personal','Todoist workspace management','write')").run();
    for (const id of workers) db.prepare("INSERT OR IGNORE INTO permissions (principal_id,tool_id,access_level,reason) VALUES (?,'todoist_manage','write','explicit Todoist management grant')").run(id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  console.log(JSON.stringify(db.prepare("SELECT principal_id,access_level FROM permissions WHERE tool_id='todoist_manage'").all()));
} finally { db.close(); }
