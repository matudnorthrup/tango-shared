#!/usr/bin/env node
// Per-clone tool smoke harness.
//
// For each distinct tool served to the -ollama clones at :9100, drive ONE real
// DeepSeek tool-loop turn with a strictly READ-ONLY prompt and assert the turn does
// NOT end in stopReason=max_tool_iters (the doc-drift / broken-tool signature that
// burns the iteration budget). Catches the calendar/docs failure class — and anything
// else where DeepSeek can't drive a tool correctly — across the whole tool surface,
// instead of finding it one user-turn at a time.
//
// SAFE BY DESIGN: tools that can cause side effects (writes, money, printing, secrets,
// shell, open-ended browser) are SKIPPED and reported as "needs targeted test". The
// rest get a read-only prompt; the model is told never to create/modify/send/delete.
//
// Usage: node scripts/smoke-test-clone-tools.mjs [toolName ...]
//   (needs the bot + :9100 running; resolves OLLAMA_API_KEY from env or .env)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { OllamaProvider } from "../packages/core/dist/provider.js";
import { McpHttpToolClient } from "../packages/core/dist/mcp-http-tool-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");

function resolveKey() {
  if (process.env.OLLAMA_API_KEY) return process.env.OLLAMA_API_KEY;
  for (const line of readFileSync(resolve(REPO, ".env"), "utf8").split("\n")) {
    if (line.startsWith("OLLAMA_API_KEY=")) return line.slice("OLLAMA_API_KEY=".length).trim();
  }
  throw new Error("OLLAMA_API_KEY not in env or .env");
}

const MCP_URL = "http://127.0.0.1:9100/mcp";
const CLONES = ["watson", "sierra", "charlie", "foxtrot", "juliet", "malibu", "papa", "victor"].map((p) => `${p}-ollama`);

// Tools NOT auto-smoked (side effects / sensitive / need targeted+cleanup tests).
const SKIP = new Set([
  "onepassword", "expense_reimbursement", "printer_command", "openscad_render", "prusa_slice", "paper_print",
  "browser", "tango_shell", "tango_file", "discord_manage", "imessage", "jules_files",
  "memory_add", "memory_reflect", "recipe_write", "gog_docs_update_tab", "kilo_ledger",
  "walmart", "lunch_money", "workout_sql", "atlas_sql", "nutrition_log_items",
  "attachment_reprocess", "acme_run",
]);

async function tools(worker) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Worker-ID": worker },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  return (await res.json())?.result?.tools?.map((t) => t.name) ?? [];
}

const READONLY_PROMPT = (tool) =>
  `Using ONLY the ${tool} tool, perform the single simplest READ-ONLY operation it supports ` +
  `(a list / search / status / read — NEVER create, modify, send, draft, delete, submit, purchase, or print anything). ` +
  `Pick sensible defaults; for account-scoped tools use the personal account. Report the result in one short line. ` +
  `If ${tool} genuinely has no safe read-only operation, reply exactly "NO-READ-OP" and do not call it.`;

async function main() {
  const key = resolveKey();
  const toolClient = new McpHttpToolClient({ port: 9100, timeoutMs: 60000 });
  const provider = new OllamaProvider({ baseUrl: "https://ollama.com/v1", defaultModel: "deepseek-v4-pro:cloud", apiKey: key, timeoutMs: 120000, toolClient });

  // distinct tool -> a clone that has it
  const toolOwner = new Map();
  for (const clone of CLONES) {
    for (const t of await tools(clone)) if (!toolOwner.has(t)) toolOwner.set(t, clone);
  }

  const only = process.argv.slice(2);
  const targets = [...toolOwner.keys()].filter((t) => (only.length ? only.includes(t) : !SKIP.has(t))).sort();

  console.log(`Smoke-testing ${targets.length} tools (skipping ${[...toolOwner.keys()].filter((t) => SKIP.has(t)).length} side-effecting). Each is one real DeepSeek turn.\n`);

  const results = [];
  for (const tool of targets) {
    const clone = toolOwner.get(tool);
    const t0 = Date.now();
    let row;
    try {
      const resp = await provider.generate({
        systemPrompt: `You are ${clone}, a careful assistant. Use the available tools. Never take destructive or write actions in this diagnostic.`,
        prompt: READONLY_PROMPT(tool),
        tools: { mode: "default" },
        workerId: clone,
        model: "deepseek-v4-pro:cloud",
      });
      const stop = resp.metadata?.stopReason;
      const used = (resp.toolCalls || []).map((c) => c.name);
      const capped = stop === "max_tool_iters";
      const calledIt = used.includes(tool);
      const declined = /NO-READ-OP/.test(resp.text || "");
      const pass = !capped && (calledIt || declined);
      row = { tool, clone, ms: Date.now() - t0, stop, used: used.join(",") || "-", pass, declined, reply: (resp.text || "").replace(/\s+/g, " ").slice(0, 80) };
    } catch (err) {
      row = { tool, clone, ms: Date.now() - t0, stop: "ERROR", used: "-", pass: false, reply: err.message.slice(0, 80) };
    }
    results.push(row);
    const tag = row.pass ? (row.declined ? "·NO-OP" : "✓PASS") : "✗FAIL";
    console.log(`${tag}  ${tool.padEnd(22)} ${row.clone.padEnd(14)} ${String(row.ms).padStart(6)}ms stop=${row.stop} used=${row.used}  ${row.reply}`);
  }

  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length} tested · ${results.filter((r) => r.pass && !r.declined).length} pass · ${results.filter((r) => r.declined).length} no-op · ${fails.length} FAIL`);
  if (fails.length) {
    console.log("\nFAILURES (investigate — likely doc-drift cap-loop or tool error):");
    for (const f of fails) console.log(`  - ${f.tool} (${f.clone}): stop=${f.stop} ${f.reply}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(2); });
