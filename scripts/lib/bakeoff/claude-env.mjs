// Isolated environment for every `claude` CLI spawn the harness makes
// (candidates and judges).
//
// Without isolation, headless `claude -p` loads the operator's global
// ~/.claude/CLAUDE.md (coding-session instructions like "end every turn with
// live links") into the context — found 2026-09-24 when a bare "Reply OK" probe
// answered "OK … No live surfaces". That contaminates Claude candidates (and
// the judge) with instructions Ollama candidates never see. An empty
// CLAUDE_CONFIG_DIR removes user memory/settings; auth rides
// CLAUDE_CODE_OAUTH_TOKEN, which the harness already exports.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let isolatedConfigDir;

export function isolatedClaudeEnv(extra = {}) {
  if (!isolatedConfigDir) isolatedConfigDir = mkdtempSync(join(tmpdir(), "bakeoff-claude-config-"));
  return { ...process.env, CLAUDE_CONFIG_DIR: isolatedConfigDir, ...extra };
}

/** Claude CLI aliases and runtime ids route to the Claude CLI; anything else is
 *  an Ollama Cloud model id. */
const CLAUDE_ALIASES = new Set(["sonnet", "opus", "haiku", "fable"]);
export function isClaudeJudgeModel(model) {
  const m = String(model ?? "");
  return CLAUDE_ALIASES.has(m) || m.startsWith("claude:") || m.startsWith("claude-");
}

/** `claude-opus-5-5@high` → { model: "claude-opus-5-5", effort: "high" }.
 *  The suffix lets one bake-off compare effort levels of the same model as
 *  distinct candidates. */
export function splitEffortSuffix(model) {
  const [base, effort] = String(model).split("@");
  return { model: base, effort: effort || null };
}
