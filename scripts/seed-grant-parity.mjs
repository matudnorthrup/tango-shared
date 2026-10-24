#!/usr/bin/env node
// Grant-parity migration for the claude-primary routing flip (TGO-809).
//
// Why this exists: since June the -ollama clones have been the primary
// channel/voice targets, so live-created governance grants accumulated on the
// clone principals (worker:<x>-ollama / agent:<x>-ollama). The originals get
// their tools from YAML mcp_servers on the claude-code path today, but
// governance-checked surfaces deny-by-default (see grant-send-image.mjs /
// check-governance-invariants.mjs), so flipping primary routing back to the
// originals needs the originals to hold at least the grants their clones
// earned. This script copies clone grants to the matching original principal
// where the original lacks them.
//
// Scope (mirrors the TGO-809 plan):
//   - Copy pairs: sierra, watson, malibu, papa, victor, juliet
//       worker:<x>-ollama -> worker:<x>   (principal created if missing)
//       agent:<x>-ollama  -> agent:<x>    (only where both make sense)
//   - Diff-only pairs: foxtrot, charlie — grants exist on BOTH sides, so this
//     script only prints a diff report for them and never writes.
//
// Behavior:
//   - Dry-run by DEFAULT: prints the planned principal/permission inserts.
//   - `--apply` executes them. Idempotent: inserts use ON CONFLICT DO NOTHING,
//     so existing original grants (including different access levels) are
//     never overwritten; level mismatches are reported instead.
//   - Never copies expiry (no live grants carry expires_at today).
//
// Usage:
//   node scripts/seed-grant-parity.mjs            # dry run (no writes)
//   node scripts/seed-grant-parity.mjs --apply    # write
//   TANGO_DB_PATH overrides the DB (default ~/.tango/profiles/default/data/tango.sqlite).

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

const DB = process.env.TANGO_DB_PATH || resolve(homedir(), ".tango/profiles/default/data/tango.sqlite");
const APPLY = process.argv.includes("--apply");

const COPY_PERSONAS = ["sierra", "watson", "malibu", "papa", "victor", "juliet"];
const DIFF_ONLY_PERSONAS = ["foxtrot", "charlie"];
const LEVELS = ["worker", "agent"];

function exec(sql) {
  execFileSync("sqlite3", [DB, sql], { encoding: "utf8" });
}

function query(sql) {
  const out = execFileSync("sqlite3", ["-json", "-readonly", DB, sql], { encoding: "utf8" }).trim();
  return out ? JSON.parse(out) : [];
}

function sqlStr(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function titleCase(persona) {
  return persona.charAt(0).toUpperCase() + persona.slice(1);
}

const principalRows = query("SELECT id, type, parent_id FROM principals;");
const principals = new Map(principalRows.map((row) => [row.id, row]));

function grantsFor(principalId) {
  const rows = query(
    `SELECT tool_id, access_level FROM permissions WHERE principal_id = ${sqlStr(principalId)} ORDER BY tool_id;`,
  );
  return new Map(rows.map((row) => [row.tool_id, row.access_level]));
}

const plannedStatements = [];
let plannedPrincipals = 0;
let plannedGrants = 0;

function planPrincipalInsert(principalId, level, persona) {
  const display = level === "worker" ? `${titleCase(persona)} Runtime` : titleCase(persona);
  // A worker hangs off its persona's agent principal when that exists
  // (matches the GOVERNANCE_SEED hierarchy); agents hang off user:owner.
  const parent =
    level === "worker"
      ? principals.has(`agent:${persona}`) ? `agent:${persona}` : null
      : principals.has("user:owner") ? "user:owner" : null;
  plannedStatements.push(
    `INSERT OR IGNORE INTO principals (id, type, parent_id, display_name) VALUES (` +
      `${sqlStr(principalId)}, ${sqlStr(level)}, ${parent ? sqlStr(parent) : "NULL"}, ${sqlStr(display)});`,
  );
  plannedPrincipals += 1;
  console.log(`  + principal ${principalId} (type=${level}, parent=${parent ?? "NULL"})`);
}

function planGrantCopy(principalId, toolId, accessLevel, cloneId) {
  plannedStatements.push(
    `INSERT INTO permissions (principal_id, tool_id, access_level, granted_by, reason) VALUES (` +
      `${sqlStr(principalId)}, ${sqlStr(toolId)}, ${sqlStr(accessLevel)}, 'seed-grant-parity.mjs', ` +
      `${sqlStr(`TGO-809 claude-primary flip: parity with ${cloneId}`)}) ` +
      `ON CONFLICT(principal_id, tool_id) WHERE principal_id IS NOT NULL DO NOTHING;`,
  );
  plannedGrants += 1;
  console.log(`  + grant ${toolId} (${accessLevel}) -> ${principalId}`);
}

console.log(`seed-grant-parity (TGO-809) against ${DB}`);
console.log(APPLY ? "MODE: APPLY — statements will be executed.\n" : "MODE: DRY RUN — no writes. Re-run with --apply to execute.\n");

for (const persona of COPY_PERSONAS) {
  for (const level of LEVELS) {
    const cloneId = `${level}:${persona}-ollama`;
    const originalId = `${level}:${persona}`;
    if (!principals.has(cloneId)) {
      console.log(`${cloneId}: clone principal not registered — nothing to copy at this level.`);
      continue;
    }
    const cloneGrants = grantsFor(cloneId);
    if (cloneGrants.size === 0) {
      console.log(`${cloneId}: clone has no grants — nothing to copy.`);
      continue;
    }
    const originalExists = principals.has(originalId);
    const originalGrants = originalExists ? grantsFor(originalId) : new Map();

    const missing = [...cloneGrants].filter(([toolId]) => !originalGrants.has(toolId));
    const mismatched = [...cloneGrants].filter(
      ([toolId, level_]) => originalGrants.has(toolId) && originalGrants.get(toolId) !== level_,
    );

    console.log(`${cloneId} -> ${originalId}: clone=${cloneGrants.size} original=${originalGrants.size} toCopy=${missing.length}`);
    if (!originalExists && missing.length > 0) {
      planPrincipalInsert(originalId, level, persona);
    }
    for (const [toolId, accessLevel] of missing) {
      planGrantCopy(originalId, toolId, accessLevel, cloneId);
    }
    for (const [toolId, cloneLevel] of mismatched) {
      console.log(
        `  ! level mismatch (left untouched): ${toolId} clone=${cloneLevel} original=${originalGrants.get(toolId)}`,
      );
    }
  }
}

console.log("\n--- Diff report (foxtrot/charlie: report only, NO writes) ---");
for (const persona of DIFF_ONLY_PERSONAS) {
  for (const level of LEVELS) {
    const cloneId = `${level}:${persona}-ollama`;
    const originalId = `${level}:${persona}`;
    const cloneGrants = principals.has(cloneId) ? grantsFor(cloneId) : null;
    const originalGrants = principals.has(originalId) ? grantsFor(originalId) : null;
    if (!cloneGrants && !originalGrants) continue;

    console.log(`${originalId} vs ${cloneId}:`);
    if (!cloneGrants) {
      console.log(`  (no ${cloneId} principal registered)`);
    }
    if (!originalGrants) {
      console.log(`  (no ${originalId} principal registered)`);
    }
    const cloneMap = cloneGrants ?? new Map();
    const originalMap = originalGrants ?? new Map();
    const cloneOnly = [...cloneMap].filter(([toolId]) => !originalMap.has(toolId));
    const originalOnly = [...originalMap].filter(([toolId]) => !cloneMap.has(toolId));
    const mismatched = [...cloneMap].filter(
      ([toolId, level_]) => originalMap.has(toolId) && originalMap.get(toolId) !== level_,
    );
    for (const [toolId, accessLevel] of cloneOnly) {
      console.log(`  clone-only: ${toolId} (${accessLevel})`);
    }
    for (const [toolId, accessLevel] of originalOnly) {
      console.log(`  original-only: ${toolId} (${accessLevel})`);
    }
    for (const [toolId, cloneLevel] of mismatched) {
      console.log(`  level mismatch: ${toolId} clone=${cloneLevel} original=${originalMap.get(toolId)}`);
    }
    if (cloneOnly.length === 0 && originalOnly.length === 0 && mismatched.length === 0) {
      console.log("  identical grants on both sides.");
    }
  }
}

console.log(`\nPlanned: ${plannedPrincipals} principal insert(s), ${plannedGrants} grant insert(s).`);
if (!APPLY) {
  console.log("Dry run complete — nothing written. Re-run with --apply to execute.");
  process.exit(0);
}

for (const statement of plannedStatements) {
  exec(statement);
}
console.log(`Applied ${plannedStatements.length} statement(s) against ${DB}.`);
