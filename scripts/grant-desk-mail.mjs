#!/usr/bin/env node
// Grant desk_mail (agents' conversations mailing each other and starting threads; apps/screen
// server/desk/mail.ts) to every agent whose YAML mounts the desk-mail MCP server, and to those
// agents' -ollama clones (Ollama clones get tools only from these grants). Isolated agents never
// mount it (the config loader rejects it for them), so they are never granted.
//
// Idempotent. Ensures the governance_tools row exists, then grants desk_mail (write) to each
// principal that is registered.
//
// Usage: node scripts/grant-desk-mail.mjs
//   TANGO_DB_PATH overrides the DB (default ~/.tango/profiles/default/data/tango.sqlite).

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DB = process.env.TANGO_DB_PATH || resolve(homedir(), ".tango/profiles/default/data/tango.sqlite");
const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "v2", "agents");

const AGENTS = readdirSync(AGENTS_DIR)
  .filter((file) => file.endsWith(".yaml"))
  .filter((file) => {
    const yaml = readFileSync(join(AGENTS_DIR, file), "utf8");
    return /\n\s*- name: desk-mail\n/.test(yaml) && !/^isolated:\s*true\b/m.test(yaml);
  })
  .map((file) => file.replace(/\.yaml$/, ""));
const PRINCIPALS = AGENTS.map((agent) => `worker:${agent}`);

function exec(sql) {
  execFileSync("sqlite3", [DB, sql], { encoding: "utf8" });
}

function query(sql) {
  const out = execFileSync("sqlite3", ["-json", DB, sql], { encoding: "utf8" }).trim();
  return out ? JSON.parse(out) : [];
}

function sqlStr(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

exec(
  `INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
     ('desk_mail', 'tango', 'Desk Mail', 'write');`,
);

const principalIds = new Set(query("SELECT id FROM principals;").map((p) => p.id));
let granted = 0;
const skippedMissing = [];

for (const principal of PRINCIPALS) {
  if (!principalIds.has(principal)) {
    skippedMissing.push(principal);
    continue;
  }
  exec(
    `INSERT INTO permissions (principal_id, tool_id, access_level, granted_by, reason)
     VALUES (${sqlStr(principal)}, 'desk_mail', 'write', 'grant-desk-mail.mjs', 'mail other desk conversations and start threads')
     ON CONFLICT(principal_id, tool_id) WHERE principal_id IS NOT NULL
     DO UPDATE SET access_level = excluded.access_level, updated_at = datetime('now');`,
  );
  granted += 1;
  console.log(`granted desk_mail (write) -> ${principal}`);
}

if (skippedMissing.length > 0) {
  console.warn(
    `\nSkipped (principal not registered in this DB yet): ${skippedMissing.join(", ")}.\n` +
    "Run this after the agent has connected at least once so the runtime has registered its principal, then re-run.",
  );
}

console.log(`\nDone: ${granted}/${PRINCIPALS.length} grants applied against ${DB}`);
