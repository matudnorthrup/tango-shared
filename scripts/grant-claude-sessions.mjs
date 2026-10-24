#!/usr/bin/env node
// Grant the Claude Code session tools to the Watson agents in the governance DB.
//
// Why this exists: the -ollama clones (Bravo Watson = watson-ollama) get their
// tools ONLY from per-principal governance grants — their YAML mcp_servers list
// is ignored on the Ollama runtime path (see check-governance-invariants.mjs).
// The classic Watson grant is seeded in governance-schema.ts, but that seed is
// INSERT OR IGNORE and never runs against already-initialized DBs, and the
// watson-ollama principal is created live (not seeded), so a script is the
// reproducible way to apply these grants to an existing profile DB.
//
// Idempotent. Ensures the principals exist, then grants:
//   spawn_claude_session (write), list_claude_sessions (read)
// to both worker:personal-assistant (classic Watson) and worker:watson-ollama
// (Bravo Watson).
//
// Usage: node scripts/grant-claude-sessions.mjs
//   TANGO_DB_PATH overrides the DB (default ~/.tango/profiles/default/data/tango.sqlite).

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

const DB = process.env.TANGO_DB_PATH || resolve(homedir(), ".tango/profiles/default/data/tango.sqlite");

const GRANTS = [
  { principal: "worker:personal-assistant", tool: "spawn_claude_session", level: "write" },
  { principal: "worker:personal-assistant", tool: "list_claude_sessions", level: "read" },
  { principal: "worker:watson-ollama", tool: "spawn_claude_session", level: "write" },
  { principal: "worker:watson-ollama", tool: "list_claude_sessions", level: "read" },
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

// Ensure the governance_tools rows exist (idempotent — also covered by the schema seed).
exec(
  `INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
     ('spawn_claude_session', 'tango', 'Spawn Claude Code Session', 'write'),
     ('list_claude_sessions', 'tango', 'List Claude Code Sessions', 'read');`,
);

const principalIds = new Set(query("SELECT id FROM principals;").map((p) => p.id));
let granted = 0;
const skippedMissing = [];

for (const { principal, tool, level } of GRANTS) {
  if (!principalIds.has(principal)) {
    // Don't fabricate a principal that the runtime hasn't registered — record and skip.
    skippedMissing.push(principal);
    continue;
  }
  exec(
    `INSERT INTO permissions (principal_id, tool_id, access_level, granted_by, reason)
     VALUES (${sqlStr(principal)}, ${sqlStr(tool)}, ${sqlStr(level)}, 'grant-claude-sessions.mjs', 'remote-controllable Claude Code sessions')
     ON CONFLICT(principal_id, tool_id) WHERE principal_id IS NOT NULL
     DO UPDATE SET access_level = excluded.access_level, updated_at = datetime('now');`,
  );
  granted += 1;
  console.log(`granted ${tool} (${level}) -> ${principal}`);
}

if (skippedMissing.length > 0) {
  const unique = [...new Set(skippedMissing)];
  console.warn(
    `\nSkipped (principal not registered in this DB yet): ${unique.join(", ")}.\n` +
    "Run this after the agent has connected at least once so the runtime has registered its principal, then re-run.",
  );
}

console.log(`\nDone: ${granted}/${GRANTS.length} grants applied against ${DB}`);
