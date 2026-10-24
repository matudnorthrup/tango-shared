#!/usr/bin/env node
// Grant background_job to the agents whose YAML mounts the background-job MCP
// server. Existing profile DBs never re-run the governance seed, and live
// agent principals (worker:<agent-id>, from WORKER_ID) are not seeded at all,
// so this is the reproducible way to apply the grant.
//
// Idempotent. Ensures the governance_tools row exists, then grants
// background_job (write) to each principal below that is registered.
//
// Usage: node scripts/grant-background-job.mjs
//   TANGO_DB_PATH overrides the DB (default ~/.tango/profiles/default/data/tango.sqlite).

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

const DB = process.env.TANGO_DB_PATH || resolve(homedir(), ".tango/profiles/default/data/tango.sqlite");

const PRINCIPALS = [
  "worker:sierra",
];

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
     ('background_job', 'tango', 'Background Job', 'write');`,
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
     VALUES (${sqlStr(principal)}, 'background_job', 'write', 'grant-background-job.mjs', 'long batch work outside the turn time limit')
     ON CONFLICT(principal_id, tool_id) WHERE principal_id IS NOT NULL
     DO UPDATE SET access_level = excluded.access_level, updated_at = datetime('now');`,
  );
  granted += 1;
  console.log(`granted background_job (write) -> ${principal}`);
}

if (skippedMissing.length > 0) {
  console.warn(
    `\nSkipped (principal not registered in this DB yet): ${skippedMissing.join(", ")}.\n` +
    "Run this after the agent has connected at least once so the runtime has registered its principal, then re-run.",
  );
}

console.log(`\nDone: ${granted}/${PRINCIPALS.length} grants applied against ${DB}`);
