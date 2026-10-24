#!/usr/bin/env node
// Tool-doc-vs-`--help` linter.
//
// CLI-wrapper tools (the `gog` family) expose a free-text `command` to the model and
// describe the available subcommands/flags in their tool DESCRIPTION. If that
// description drifts from the real CLI (e.g. documents `--start` when the binary wants
// `--from`), the model follows the bad docs, the CLI errors, and the stateless Ollama
// tool loop burns its iteration budget looping — exactly the calendar/docs bugs.
//
// This linter parses every documented `gog <subcommand> … --flag …` line out of
// packages/discord/src/personal-agent-tools.ts, calls the REAL `<subcommand> --help`
// through the live :9100 MCP server, and fails on any documented flag/subcommand the
// CLI rejects. Run it in CI so descriptions can't silently drift from the pinned CLI.
//
// Usage: node scripts/lint-tool-docs.mjs   (requires the bot + :9100 running)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_FILE = resolve(__dirname, "../packages/discord/src/personal-agent-tools.ts");
const MCP_URL = process.env.TANGO_MCP_URL || "http://127.0.0.1:9100/mcp";
const WORKER = process.env.LINT_WORKER || "watson-ollama"; // any clone granted the gog tools

// First word of a documented `gog <X> …` command → the MCP tool that runs it.
const FIRST_WORD_TO_TOOL = {
  gmail: "gog_email",
  calendar: "gog_calendar",
  docs: "gog_docs",
};

async function mcpCall(toolName, command) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Worker-ID": WORKER },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: toolName, arguments: { command } },
    }),
  });
  const json = await res.json();
  const content = json?.result?.content?.[0]?.text ?? JSON.stringify(json?.result ?? json);
  // The wellness server wraps gog output as {"result":"..."}; unwrap if present.
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.result === "string") return parsed.result;
  } catch { /* not JSON-wrapped */ }
  return content;
}

// Pull documented "gog <subcommand> ... " lines + the flags they use out of the source.
function extractDocumentedCommands(src) {
  const cmds = [];
  const lineRe = /"(\s*)gog ([^"]+)"/g;
  let m;
  while ((m = lineRe.exec(src)) !== null) {
    const body = m[2].trim(); // e.g. "calendar create <calendarId> --summary '<title>' --from ..."
    const tokens = body.split(/\s+/);
    // Subcommand path = leading bare words (not a flag, positional, quote, or value).
    const path = [];
    for (const t of tokens) {
      if (t.startsWith("--") || t.startsWith("[") || t.startsWith("<") || t.startsWith("'") || t.startsWith('"') || t.includes("=")) break;
      path.push(t);
    }
    if (path.length === 0) continue;
    const firstWord = path[0];
    const tool = FIRST_WORD_TO_TOOL[firstWord];
    if (!tool) continue; // not a lintable gog command (e.g. a prose line)
    // Documented flags: any --xxx token, stripped of surrounding [] and any =VALUE.
    const flags = [...new Set(
      tokens
        .map((t) => t.replace(/^\[|\]$/g, ""))
        .filter((t) => t.startsWith("--"))
        .map((t) => t.split("=")[0])
    )];
    cmds.push({ tool, subcommand: path.join(" "), flags, raw: body });
  }
  return cmds;
}

function actualFlagsFromHelp(helpText) {
  return new Set((helpText.match(/--[a-z][a-z0-9-]*/g) || []));
}

function helpIndicatesMissingSubcommand(helpText) {
  return /unexpected argument|unknown command|did you mean/i.test(helpText);
}

async function main() {
  const src = readFileSync(TOOLS_FILE, "utf8");
  const cmds = extractDocumentedCommands(src);
  // Dedup by subcommand (multiple doc lines for the same subcommand are rare).
  const bySub = new Map();
  for (const c of cmds) if (!bySub.has(c.subcommand)) bySub.set(c.subcommand, c);

  const issues = [];
  let checked = 0;
  for (const c of bySub.values()) {
    let help;
    try {
      help = await mcpCall(c.tool, `${c.subcommand} --help`);
    } catch (err) {
      issues.push(`ERROR calling --help for "${c.subcommand}": ${err.message}`);
      continue;
    }
    checked++;
    if (helpIndicatesMissingSubcommand(help)) {
      issues.push(`SUBCOMMAND DOES NOT EXIST: "gog ${c.subcommand}" — ${help.split("\n")[0].slice(0, 120)}`);
      continue;
    }
    const actual = actualFlagsFromHelp(help);
    const bogus = c.flags.filter((f) => f !== "--help" && !actual.has(f));
    if (bogus.length > 0) {
      issues.push(`DRIFT in "gog ${c.subcommand}": documented flag(s) the CLI rejects: ${bogus.join(", ")}`);
    }
  }

  console.log(`Linted ${checked} documented gog subcommand(s).`);
  if (issues.length === 0) {
    console.log("✓ No tool-doc drift found.");
    process.exit(0);
  }
  console.log(`\n✗ ${issues.length} issue(s):`);
  for (const i of issues) console.log("  - " + i);
  process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(2); });
