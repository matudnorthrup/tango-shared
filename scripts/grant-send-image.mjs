#!/usr/bin/env node
// Grant discord_send_image to every agent principal in the governance DB.
//
// Why this exists: the -ollama clones get their tools ONLY from per-principal
// governance grants — their YAML mcp_servers list is ignored on the Ollama
// runtime path (see check-governance-invariants.mjs). PR #107 shipped
// discord_send_image with no governance row, so deny-by-default made the tool
// invisible to all 8 clones. The classic agents only saw it because their
// send-image proxy runs without WORKER_ID (null principal bypasses governance).
// The seed in governance-schema.ts covers fresh DBs; this script is the
// reproducible way to apply the grants to an existing profile DB.
//
// Idempotent. Ensures the governance_tools row exists, then grants
// discord_send_image (write) to the classic workers of every persona whose
// YAML carries the send-image MCP entry, plus all live-managed -ollama clone
// principals. kilo is deliberately excluded (no send-image entry, pending
// owner decision).
//
// Usage: node scripts/grant-send-image.mjs
//   TANGO_DB_PATH overrides the DB (default ~/.tango/profiles/default/data/tango.sqlite).

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

const DB = process.env.TANGO_DB_PATH || resolve(homedir(), ".tango/profiles/default/data/tango.sqlite");

const PRINCIPALS = [
  // Classic Claude workers (persona in parens)
  "worker:personal-assistant",   // watson
  "worker:research-assistant",   // sierra
  "worker:research-coordinator", // sierra (live-created, not in seed)
  "worker:study-assistant",     // papa
  "worker:dev-assistant",        // victor
  "worker:operations-assistant", // victor
  "worker:foxtrot",              // foxtrot
  "worker:workout-recorder",     // malibu
  "worker:nutrition-logger",     // wellness
  "worker:recipe-librarian",     // wellness
  "worker:health-analyst",       // wellness
  "worker:activity-tracker",     // wellness
  "worker:note-librarian",       // wellness (shared)
  // Live-managed Ollama clone principals (tools come ONLY from these grants)
  "worker:charlie-ollama",
  "worker:foxtrot-ollama",
  "worker:juliet-ollama",
  "worker:malibu-ollama",
  "worker:papa-ollama",
  "worker:sierra-ollama",
  "worker:victor-ollama",
  "worker:watson-ollama",
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

// Ensure the governance_tools row exists (idempotent — also covered by the schema seed).
exec(
  `INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
     ('discord_send_image', 'tango', 'Discord Image Send', 'write');`,
);

const principalIds = new Set(query("SELECT id FROM principals;").map((p) => p.id));
let granted = 0;
const skippedMissing = [];

for (const principal of PRINCIPALS) {
  if (!principalIds.has(principal)) {
    // Don't fabricate a principal that the runtime hasn't registered — record and skip.
    skippedMissing.push(principal);
    continue;
  }
  exec(
    `INSERT INTO permissions (principal_id, tool_id, access_level, granted_by, reason)
     VALUES (${sqlStr(principal)}, 'discord_send_image', 'write', 'grant-send-image.mjs', 'outbound Discord image sending')
     ON CONFLICT(principal_id, tool_id) WHERE principal_id IS NOT NULL
     DO UPDATE SET access_level = excluded.access_level, updated_at = datetime('now');`,
  );
  granted += 1;
  console.log(`granted discord_send_image (write) -> ${principal}`);
}

if (skippedMissing.length > 0) {
  const unique = [...new Set(skippedMissing)];
  console.warn(
    `\nSkipped (principal not registered in this DB yet): ${unique.join(", ")}.\n` +
    "Run this after the agent has connected at least once so the runtime has registered its principal, then re-run.",
  );
}

console.log(`\nDone: ${granted}/${PRINCIPALS.length} grants applied against ${DB}`);
