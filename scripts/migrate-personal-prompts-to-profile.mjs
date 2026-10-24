#!/usr/bin/env node
/**
 * migrate-personal-prompts-to-profile.mjs
 *
 * Prompt half of the personal-data split. Snapshots an installation's current
 * persona / skill / tool prompt docs out of the repo working tree and into the
 * profile overlay, so personal content survives pulling a release that ships
 * GENERIC prompt defaults.
 *
 * How the overlay composes at runtime (see docs/guides/profile-model.md):
 *   - Personas: profile prompts/agents/<id>/*.md is APPENDED to the repo persona
 *     base when the agent's system prompt is assembled.
 *   - Skills/tools: reading agents/skills|tools/<x>.md via the agent_docs tool
 *     APPENDS profile prompts/{skills,tools}/<x>.md to the generic repo base.
 *
 * Run this BEFORE pulling the genericized release (while your working tree still
 * has your personal content). It is WRITE-ONLY to the profile and never modifies
 * repo files. It will not clobber an existing overlay file.
 *
 * Whole-file snapshot vs. hand-curated delta: this tool copies the whole current
 * doc into the overlay (robust + mechanical). After pulling the generic base,
 * base + overlay reproduces your content (with some duplication of the generic
 * parts). For a cleaner result you can trim each overlay to just your personal
 * additions afterward — that is what the Tango repo migration did by hand.
 *
 * Usage:
 *   node scripts/migrate-personal-prompts-to-profile.mjs [--dry-run] [--profile <name>] [--force]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
let dryRun = false;
let force = false;
let profileFlag;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--dry-run") dryRun = true;
  else if (a === "--force") force = true;
  else if (a === "--profile") profileFlag = args[++i];
  else if (a === "-h" || a === "--help") {
    console.log("Usage: node scripts/migrate-personal-prompts-to-profile.mjs [--dry-run] [--profile <name>] [--force]");
    process.exit(0);
  } else {
    console.error(`unknown argument: ${a}`);
    process.exit(2);
  }
}

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const tangoHome = process.env.TANGO_HOME?.trim()
  ? expandHome(process.env.TANGO_HOME.trim())
  : path.join(os.homedir(), ".tango");
const profileName = (profileFlag ?? process.env.TANGO_PROFILE ?? "default").trim();
const profilePromptsDir = path.join(tangoHome, "profiles", profileName, "prompts");

function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

console.log(`repo:     ${repoRoot}`);
console.log(`profile:  ${path.join(tangoHome, "profiles", profileName)}`);
console.log(`dry_run:  ${dryRun ? "yes" : "no"}\n`);

// Structural personal-content signals (shapes, not names). High-signal only, to
// avoid snapshotting already-generic docs.
const STRUCTURAL_SIGNALS = [
  /~\/(Documents|Desktop|Downloads|legacy-agent)\//,
  /\/Users\/[A-Za-z0-9._-]+/,
  /@(?!example\.(?:com|test|invalid)\b)[a-z0-9.-]+\.(io|com|net|org)\b/i, // real (non-example) email
  /\bcdn\.discordapp\.com\//,
];

// Personal TERMS come from the same profile-layer denylist privacy-scan.sh uses,
// so this tool carries no personal terms of its own and matches your installation.
// Lines are case-insensitive substrings; comments/blank lines ignored.
function loadDenylistTerms() {
  const file = process.env.TANGO_PRIVACY_DENYLIST_FILE?.trim()
    || path.join(tangoHome, "profiles", profileName, "config", "privacy", "denylist.txt");
  try {
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/u)
      .map((l) => l.replace(/#.*$/u, "").trim())
      .filter((l) => l.length > 0)
      .map((l) => l.toLowerCase());
  } catch {
    return [];
  }
}
const DENYLIST_TERMS = loadDenylistTerms();
if (DENYLIST_TERMS.length === 0) {
  console.log("note: no profile privacy denylist found — matching on structural signals only.");
  console.log("      (set up ~/.tango/profiles/<profile>/config/privacy/denylist.txt for name-level detection)\n");
}

function looksPersonal(content) {
  if (STRUCTURAL_SIGNALS.some((re) => re.test(content))) return true;
  const lower = content.toLowerCase();
  return DENYLIST_TERMS.some((term) => lower.includes(term));
}

let candidates = [];
collectDir(path.join(repoRoot, "agents", "assistants"), "agents", (id, file) => ["soul.md", "knowledge.md"].includes(file));
collectFiles(path.join(repoRoot, "agents", "skills"), "skills");
collectFiles(path.join(repoRoot, "agents", "tools"), "tools");

function collectFiles(dir, kind) {
  for (const file of safeReaddir(dir)) {
    if (!file.endsWith(".md")) continue;
    if (file === "README.md") continue;
    candidates.push({ src: path.join(dir, file), overlayRel: path.join(kind, file) });
  }
}
function collectDir(baseDir, _kind, accept) {
  for (const id of safeReaddir(baseDir)) {
    const agentDir = path.join(baseDir, id);
    if (!safeStat(agentDir)?.isDirectory()) continue;
    for (const file of safeReaddir(agentDir)) {
      if (file.endsWith(".md") && accept(id, file)) {
        candidates.push({ src: path.join(agentDir, file), overlayRel: path.join("agents", id, file) });
      }
    }
  }
}

let snapshotted = 0;
let skippedGeneric = 0;
let skippedExisting = 0;

for (const { src, overlayRel } of candidates.sort((a, b) => a.overlayRel.localeCompare(b.overlayRel))) {
  const content = fs.readFileSync(src, "utf8");
  if (!looksPersonal(content)) {
    skippedGeneric++;
    continue;
  }
  const dest = path.join(profilePromptsDir, overlayRel);
  if (!force && fs.existsSync(dest)) {
    console.log(`exists (kept):   prompts/${overlayRel}`);
    skippedExisting++;
    continue;
  }
  if (dryRun) {
    console.log(`would snapshot:  ${path.relative(repoRoot, src)} -> prompts/${overlayRel}`);
    snapshotted++;
    continue;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content, "utf8");
  fs.chmodSync(dest, 0o600);
  console.log(`snapshotted:     prompts/${overlayRel}`);
  snapshotted++;
}

console.log(`\npersonal-looking docs ${dryRun ? "to snapshot" : "snapshotted"}: ${snapshotted}`);
console.log(`already-generic (skipped): ${skippedGeneric}`);
console.log(`overlay already present (kept): ${skippedExisting}`);
console.log("\nNext: pull the genericized release, then restart Tango. Trim each overlay to just");
console.log("your personal additions if you want to keep receiving upstream prompt updates.");

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}
function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}
