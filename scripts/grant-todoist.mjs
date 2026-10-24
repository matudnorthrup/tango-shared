#!/usr/bin/env node
// Apply Todoist grants only to existing task-management principals.
// An explicit DB is required so testing cannot accidentally modify the live DB.
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const at = process.argv.indexOf('--db');
const file = at >= 0 ? process.argv[at + 1] : undefined;
if (!file) throw new Error('Usage: node scripts/grant-todoist.mjs --db /path/to/tango.sqlite');
const workersAt = process.argv.indexOf('--workers');
const explicitWorkers = workersAt >= 0 ? process.argv[workersAt + 1]?.split(',') : undefined;
if (workersAt >= 0 && (!explicitWorkers?.length || !explicitWorkers.every(id => /^worker:[a-z0-9][a-z0-9-]*$/.test(id)))) throw new Error('--workers requires exact worker IDs; wildcards and agent/user grants are not allowed');
const withPlanning = process.argv.includes('--with-planning');
if (withPlanning && !explicitWorkers) throw new Error('--with-planning requires explicit --workers');
if (!existsSync(file)) throw new Error(`Database not found: ${file}`);
const db = new DatabaseSync(file);
try {
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (explicitWorkers) {
      for (const id of explicitWorkers) {
        if (!db.prepare("SELECT id FROM principals WHERE id = ? AND type = 'worker'").get(id)) throw new Error(`Unknown worker: ${id}`);
      }
    }
    if (withPlanning && !db.prepare("SELECT id FROM governance_tools WHERE id = 'collaborate_with_agent'").get()) throw new Error('Collaboration tool is not registered');
    db.prepare("INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES ('todoist', 'personal', 'Todoist task management', 'write')").run();
    // Worker-only grants avoid expanding access through parent inheritance.
    const principals = explicitWorkers ?? ['worker:personal-assistant', 'worker:watson-ollama'];
    for (const id of principals) {
      if (!db.prepare('SELECT id FROM principals WHERE id = ?').get(id)) continue;
      // Preserve explicit existing denies/read-only grants.
      if (withPlanning) db.prepare("INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES (?, 'collaborate_with_agent', 'write', 'configured task planning collaboration')").run(id);
      db.prepare("INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES (?, 'todoist', 'write', 'configured task management')").run(id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  console.log(JSON.stringify(db.prepare("SELECT principal_id, access_level FROM permissions WHERE tool_id = 'todoist'").all()));
} finally { db.close(); }
