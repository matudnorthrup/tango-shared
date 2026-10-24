#!/usr/bin/env node
// Apply only explicitly named, existing principals. No installation-wide grants.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const filename = args.includes("--db") ? value("--db") : process.env.TANGO_DB_PATH;
const principals = args.flatMap((arg, i) => arg === "--principal" ? [args[i + 1]] : []);
const apply = args.includes("--apply");
if (!filename || !existsSync(filename) || !principals.length || principals.some((p) => !/^(worker|agent):[a-z0-9-]+$/.test(p ?? ""))) {
  throw new Error("Usage: node scripts/grant-things.mjs --db EXISTING_DB --principal worker:NAME [--principal worker:NAME] [--apply]");
}
const db = new DatabaseSync(filename, { readOnly: !apply });
try {
  db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  for (const principal of principals) {
    if (!db.prepare("SELECT id FROM principals WHERE id=?").get(principal)) throw new Error(`Unknown principal: ${principal}`);
  }
  const changes = principals.flatMap((principal) => ["read", "write"].map((access) => ({
    principal, tool: `things_${access}`, access,
    before: db.prepare("SELECT access_level FROM permissions WHERE principal_id=? AND tool_id=?").get(principal, `things_${access}`)?.access_level ?? null,
  })));
  if (apply) {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const access of ["read", "write"]) {
        db.prepare("INSERT OR IGNORE INTO governance_tools(id,domain,display_name,access_type) VALUES(?,'personal',?,?)")
          .run(`things_${access}`, `Things ${access}`, access);
        if (db.prepare("SELECT access_type FROM governance_tools WHERE id=?").get(`things_${access}`).access_type !== access) throw new Error("Conflicting Things tool catalog entry");
      }
      for (const { principal, tool, access } of changes) {
        db.prepare(`INSERT INTO permissions(principal_id,tool_id,access_level,granted_by,reason)
          VALUES(?,?,?,'grant-things.mjs','Things integration enabled by operator')
          ON CONFLICT(principal_id,tool_id) WHERE principal_id IS NOT NULL
          DO UPDATE SET access_level=excluded.access_level,updated_at=datetime('now')`).run(principal, tool, access);
      }
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  }
  console.log(JSON.stringify({ applied: apply, changes }, null, 2));
} finally { db.close(); }
