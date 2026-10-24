import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { verdict } from "./pkill-guard.mjs";

test("blocks options after the pattern (the 10/19 command)", () => {
  assert.match(verdict(`kill $(cat host.pid) 2>/dev/null; pkill -f "node server/loop/host/tailnet.mjs" -U $(id -u) 2>/dev/null; sleep 1`), /option -U after the pattern/);
  assert.match(verdict(`pgrep -lf tailnet.mjs -U 501`), /after the pattern/);
});

test("blocks more than one pattern", () => {
  assert.match(verdict(`pkill -f node 501`), /2 patterns/);
});

test("allows options before a single pattern", () => {
  for (const ok of [
    `pkill -U $(id -u) -f "node server/loop/host/tailnet.mjs"`,
    `pkill -9 -f "packages/discord/dist/main.js" 2>/dev/null; echo done`,
    `pgrep -fl "redline-demo-reel|tailnet.mjs"`,
    `pkill -P $WATCHDOG 2>/dev/null; kill $WATCHDOG`,
    `P=$(pgrep -f "mcp-wellness-server.js --http --port=9100"); kill -TERM $P`,
    `pkill -f -- "-weird-pattern"`,
    `echo pkill is a word in a sentence`,
    `git commit -m "fix pkill -f usage"`,
  ]) assert.equal(verdict(ok), null, ok);
});

test("as a hook it exits 2 with the reason, 0 otherwise", () => {
  const hook = path.join(path.dirname(new URL(import.meta.url).pathname), "pkill-guard.mjs");
  const run = (command) => spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_input: { command } }), encoding: "utf8" });
  const bad = run(`pkill -f foo -U 501`);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Blocked/);
  assert.equal(run(`pkill -U 501 -f foo`).status, 0);
});
