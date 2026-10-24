#!/usr/bin/env node
/**
 * migrate-personal-config-to-profile.mjs
 *
 * Snapshot installation-specific config VALUES out of the repo working tree and
 * into the active Tango profile overlay, so a user keeps working after they pull
 * a release that ships genericized (placeholder) config defaults.
 *
 * This is the config half of the personal-data split. It is WRITE-ONLY to the
 * profile (`~/.tango/profiles/<profile>/config/...`); it never rewrites repo
 * files. The repo genericization (real value -> placeholder) ships upstream.
 *
 * What counts as "personal" is detected by SHAPE, so the tool carries no
 * personal data of its own and works for any operator:
 *   - real Discord snowflake ids (17-19 digits, no long zero run) in
 *     default_channel_id / smoke_test_channel_id / access.allowlist_channel_ids
 *     and session `channels` (discord:<id>)
 *   - real avatar URLs (cdn.discordapp.com/...) in `avatar_url`
 *   - real remote MCP endpoints (mcp-remote args that are not example/placeholder hosts)
 *
 * Because the config layer deep-merges profile over repo and REPLACES arrays
 * wholesale, array-valued personal fields (allowlist_channel_ids, mcp_servers,
 * session channels) are captured in full.
 *
 * Usage:
 *   node scripts/migrate-personal-config-to-profile.mjs [--dry-run] [--profile <name>]
 *
 * Env: TANGO_HOME (default ~/.tango), TANGO_PROFILE (default "default").
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import yaml from "js-yaml";

const args = process.argv.slice(2);
let dryRun = false;
let profileFlag;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--dry-run") dryRun = true;
  else if (a === "--profile") profileFlag = args[++i];
  else if (a === "-h" || a === "--help") {
    console.log(
      "Usage: node scripts/migrate-personal-config-to-profile.mjs [--dry-run] [--profile <name>]",
    );
    process.exit(0);
  } else {
    console.error(`unknown argument: ${a}`);
    process.exit(2);
  }
}

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const tangoHome = process.env.TANGO_HOME?.trim()
  ? expandHome(process.env.TANGO_HOME.trim())
  : path.join(os.homedir(), ".tango");
const profileName = (profileFlag ?? process.env.TANGO_PROFILE ?? "default").trim();
const profileConfigDir = path.join(tangoHome, "profiles", profileName, "config");

console.log(`repo:     ${repoRoot}`);
console.log(`profile:  ${path.join(tangoHome, "profiles", profileName)}`);
console.log(`dry_run:  ${dryRun ? "yes" : "no"}`);
console.log("");

function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** A 17-19 digit token with no run of 10+ zeros is a real snowflake, not a placeholder. */
function isRealSnowflake(value) {
  const s = String(value);
  return /^\d{17,19}$/u.test(s) && !/0{10,}/u.test(s);
}
function isRealAvatarUrl(value) {
  return typeof value === "string" && /cdn\.discordapp\.com\//u.test(value);
}
function isRealEndpoint(value) {
  return (
    typeof value === "string" &&
    /^https?:\/\//u.test(value) &&
    !/example\.(com|invalid|test)/u.test(value)
  );
}
function realChannelFromBinding(binding) {
  const m = /^discord:(\d{17,19})$/u.exec(String(binding).trim());
  return m && isRealSnowflake(m[1]) ? m[1] : null;
}

/** Deep-merge `override` into `base` (objects merge; arrays/scalars replace). */
function deepMerge(base, override) {
  if (Array.isArray(override)) return override.slice();
  if (isPlainObject(base) && isPlainObject(override)) {
    const out = { ...base };
    for (const [k, v] of Object.entries(override)) {
      out[k] = k in out ? deepMerge(out[k], v) : v;
    }
    return out;
  }
  return override;
}
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

let overlaysWritten = 0;
let findings = 0;

/** Merge `personal` (keyed object) into the profile overlay file at relPath. */
function writeOverlay(relPath, id, personal, headerComment) {
  if (Object.keys(personal).length === 0) return;
  findings += countLeaves(personal);
  const dest = path.join(profileConfigDir, relPath);
  let existing = {};
  if (fs.existsSync(dest)) {
    try {
      existing = yaml.load(fs.readFileSync(dest, "utf8")) ?? {};
    } catch {
      existing = {};
    }
  }
  // Existing overlay wins over repo-derived values: it is the current EFFECTIVE
  // value (e.g. a real smoke-test id already migrated, where the repo now holds
  // only a placeholder). This guarantees the post-migration merged config equals
  // the pre-migration merged config for every field.
  const merged = deepMerge({ id, ...personal }, existing);
  const body =
    `# ${headerComment}\n` +
    `# Auto-generated/updated by scripts/migrate-personal-config-to-profile.mjs.\n` +
    `# Deep-merged by id over repo defaults; arrays replace wholesale.\n` +
    yaml.dump(merged, { lineWidth: 120, quotingType: '"', forceQuotes: false });

  if (dryRun) {
    console.log(`would write: ${path.relative(tangoHome, dest)}  (id=${id})`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, body, "utf8");
  fs.chmodSync(dest, 0o600);
  console.log(`wrote: ${path.relative(tangoHome, dest)}  (id=${id})`);
  overlaysWritten++;
}

function countLeaves(obj) {
  let n = 0;
  for (const v of Object.values(obj)) {
    if (isPlainObject(v)) n += countLeaves(v);
    else n += 1;
  }
  return n;
}

// ── v2 agent configs ────────────────────────────────────────────────────────
const v2Dir = path.join(repoRoot, "config", "v2", "agents");
for (const file of safeReaddir(v2Dir).filter((f) => f.endsWith(".yaml"))) {
  const doc = yaml.load(fs.readFileSync(path.join(v2Dir, file), "utf8"));
  if (!isPlainObject(doc) || typeof doc.id !== "string") continue;
  const personal = {};

  // top-level avatar_url
  if (isRealAvatarUrl(doc.avatar_url)) personal.avatar_url = doc.avatar_url;

  // discord + voice channel ids
  for (const section of ["discord", "voice"]) {
    const src = doc[section];
    if (!isPlainObject(src)) continue;
    const out = {};
    for (const key of ["default_channel_id", "smoke_test_channel_id"]) {
      if (isRealSnowflake(src[key])) out[key] = String(src[key]);
    }
    if (Object.keys(out).length) personal[section] = out;
  }

  // access.allowlist_channel_ids (capture full array if any element is real)
  const allow = doc?.access?.allowlist_channel_ids;
  if (Array.isArray(allow) && allow.some((c) => isRealSnowflake(c))) {
    personal.access = { allowlist_channel_ids: allow.map(String) };
  }

  // mcp_servers with a real remote endpoint (capture full array — arrays replace)
  if (Array.isArray(doc.mcp_servers)) {
    const hasRealEndpoint = doc.mcp_servers.some(
      (s) => Array.isArray(s?.args) && s.args.some((a) => isRealEndpoint(a)),
    );
    if (hasRealEndpoint) personal.mcp_servers = doc.mcp_servers;
  }

  writeOverlay(
    path.join("v2", "agents", file),
    doc.id,
    personal,
    `Profile overlay for ${doc.id}: real channel/avatar/endpoint values (repo ships placeholders).`,
  );
}

// ── session bindings ──────────────────────────────────────────────────────────
const sessionsDir = path.join(repoRoot, "config", "defaults", "sessions");
for (const file of safeReaddir(sessionsDir).filter((f) => f.endsWith(".yaml"))) {
  const doc = yaml.load(fs.readFileSync(path.join(sessionsDir, file), "utf8"));
  if (!isPlainObject(doc) || typeof doc.id !== "string") continue;
  if (!Array.isArray(doc.channels)) continue;
  const hasReal = doc.channels.some((c) => realChannelFromBinding(c));
  if (!hasReal) continue;
  writeOverlay(
    path.join("sessions", file),
    doc.id,
    { channels: doc.channels.map(String) },
    `Profile overlay for session ${doc.id}: real Discord channel binding (repo ships placeholder).`,
  );
}

console.log("");
console.log(`personal config values captured: ${findings}`);
console.log(`profile overlay files ${dryRun ? "to write" : "written"}: ${overlaysWritten || (dryRun ? "(see above)" : 0)}`);
console.log("done.");

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
