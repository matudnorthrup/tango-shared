#!/usr/bin/env node
// Governance invariant check for the Ollama clones.
//
// The -ollama clones get their tools from per-principal grants in the governance DB
// (the YAML mcp_servers list is ignored on the Ollama path). Because DeepSeek has none
// of Claude's soul-prompt guardrails, an over-broad grant (e.g. email WRITE where the
// persona is read-only) is a real risk. This script reconciles the grant graph and
// flags:
//   1. OVER-GRANT  — a clone holds higher access for a tool than its persona's original
//                    Claude worker(s) do (the papa gog_email write-vs-read bug class).
//   2. DANGLING    — a clone's parent agent principal is absent, so governance
//                    inheritance silently falls through to default-deny (charlie/juliet).
//   3. CLONE-ONLY  — a clone holds a tool NO original worker for its persona has (review:
//                    legit YAML-declared capability, or accidental grant).
//
// Read-only. Usage: node scripts/check-governance-invariants.mjs
//   TANGO_DB_PATH overrides the DB (default ~/.tango/profiles/default/data/tango.sqlite).

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

const DB = process.env.TANGO_DB_PATH || resolve(homedir(), ".tango/profiles/default/data/tango.sqlite");
const ACCESS_RANK = { read: 1, write: 2 };

function q(sql) {
  const out = execFileSync("sqlite3", ["-json", DB, sql], { encoding: "utf8" }).trim();
  return out ? JSON.parse(out) : [];
}

const principals = q("SELECT id, parent_id FROM principals;");
const perms = q("SELECT principal_id, tool_id, access_level FROM permissions;");

const parentOf = new Map(principals.map((p) => [p.id, p.parent_id || null]));
const principalIds = new Set(principals.map((p) => p.id));

// persona (e.g. "watson") -> its original (non-ollama) worker principals, via parent=agent:<persona>
const personaOrigWorkers = new Map();
for (const p of principals) {
  if (p.id.startsWith("worker:") && !p.id.endsWith("-ollama") && p.parent_id?.startsWith("agent:")) {
    const persona = p.parent_id.slice("agent:".length);
    if (!personaOrigWorkers.has(persona)) personaOrigWorkers.set(persona, []);
    personaOrigWorkers.get(persona).push(p.id);
  }
}

// tool -> principal -> access
const grant = new Map();
for (const r of perms) {
  if (!grant.has(r.tool_id)) grant.set(r.tool_id, new Map());
  grant.get(r.tool_id).set(r.principal_id, r.access_level);
}
function origMaxAccess(persona, tool) {
  const workers = personaOrigWorkers.get(persona) || [];
  let max = 0;
  for (const w of workers) {
    const a = grant.get(tool)?.get(w);
    if (a && ACCESS_RANK[a] > max) max = ACCESS_RANK[a];
  }
  return max; // 0 = none of the persona's original workers hold this tool
}

const clones = [...principalIds].filter((id) => id.startsWith("worker:") && id.endsWith("-ollama"));
const overGrants = [], dangling = [], cloneOnly = [];

for (const clone of clones) {
  const persona = clone.slice("worker:".length, -"-ollama".length);
  const parent = parentOf.get(clone); // expect agent:<persona>
  if (parent && !principalIds.has(parent)) {
    dangling.push(`${clone} -> parent ${parent} is ABSENT (inheritance falls through to default-deny)`);
  }
  for (const r of perms.filter((p) => p.principal_id === clone)) {
    const cloneRank = ACCESS_RANK[r.access_level] || 0;
    const origMax = origMaxAccess(persona, r.tool_id);
    if (origMax === 0) {
      cloneOnly.push(`${clone} has ${r.tool_id} (${r.access_level}) but no '${persona}' original worker holds it`);
    } else if (cloneRank > origMax) {
      const origName = Object.keys(ACCESS_RANK).find((k) => ACCESS_RANK[k] === origMax);
      overGrants.push(`${clone} ${r.tool_id}: clone=${r.access_level} but ${persona} original max=${origName} — OVER-GRANT`);
    }
  }
}

function section(title, rows) {
  console.log(`\n${title} (${rows.length}):`);
  for (const r of rows) console.log("  - " + r);
}
console.log(`Checked ${clones.length} clones against ${personaOrigWorkers.size} personas' original workers.`);
section("OVER-GRANTS (clone access > original)", overGrants);
section("DANGLING PARENTS", dangling);
section("CLONE-ONLY tools (review: YAML-declared or accidental)", cloneOnly);

if (overGrants.length > 0) {
  console.log("\n✗ Over-grants found — review/fix (these are the papa-style security risk).");
  process.exit(1);
}
console.log("\n✓ No over-grants. (Dangling/clone-only are informational.)");
