import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaudeOnce } from "./runners.mjs";

test("no-tools replay disables built-ins and inherited MCP, and forwards reasoning effort", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-contract-"));
  try {
    const command = join(dir, "fake-cli");
    writeFileSync(command, '#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"result",result:JSON.stringify(process.argv.slice(2)),usage:{}}));\n');
    chmodSync(command, 0o755);
    const run = await runClaudeOnce({ model: "claude:sonnet", claudeCommand: command, fixture: { prompt: "Synthetic review", tools: false, reasoningEffort: "high" }, timeoutMs: 5000 });
    const args = JSON.parse(run.text);
    assert.equal(args[args.indexOf("--effort") + 1], "high");
    assert.equal(args[args.indexOf("--tools") + 1], "");
    assert.ok(args.includes("--strict-mcp-config"));
    assert.deepEqual(JSON.parse(args[args.indexOf("--mcp-config") + 1]), { mcpServers: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
