import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { availablePct, capArgs, disabled, limits, release, tryAcquire } from "./load-cap.mjs";

test("limits scale with cores and take overrides", () => {
  assert.deepEqual(limits({}, 16), { runs: 8, workers: 5, minAvailablePct: 12, waitMs: 1_800_000 });
  assert.equal(limits({}, 2).runs, 2);
  assert.equal(limits({ TANGO_LOAD_CAP_RUNS: "5", TANGO_LOAD_CAP_WORKERS: "x" }, 16).runs, 5);
  assert.equal(limits({ TANGO_LOAD_CAP_WORKERS: "x" }, 16).workers, 5);
});

test("off in CI or by switch", () => {
  assert.equal(disabled({ CI: "true" }), true);
  assert.equal(disabled({ TANGO_LOAD_CAP: "off" }), true);
  assert.equal(disabled({}), false);
});

test("vitest gets a worker cap unless one is given", () => {
  assert.deepEqual(capArgs(["vitest", "run"], 3), ["vitest", "run", "--maxWorkers=3", "--minWorkers=1"]);
  assert.deepEqual(capArgs(["vitest", "run", "--maxWorkers=8"], 3), ["vitest", "run", "--maxWorkers=8"]);
  assert.deepEqual(capArgs(["tsc", "-b"], 3), ["tsc", "-b"]);
});

test("slots are limited, released, and taken over from dead owners", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "load-cap-test-"));
  const a = tryAcquire(root, 2), b = tryAcquire(root, 2);
  assert.ok(a && b && a !== b);
  assert.equal(tryAcquire(root, 2), null);
  release(a);
  assert.equal(tryAcquire(root, 2), a);
  fs.writeFileSync(path.join(b, "pid"), "2147483000");
  assert.equal(tryAcquire(root, 2), b);  // a is held by us, b's owner is dead: b is taken over
  // A slot whose owner hasn't written its pid yet is left alone; an old one is taken over.
  const c = path.join(root, "slot-2");
  fs.mkdirSync(c);
  assert.equal(tryAcquire(root, 3), null);
  fs.utimesSync(c, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  assert.equal(tryAcquire(root, 3), c);
  fs.rmSync(root, { recursive: true, force: true });
});

test("runs from a path with a space", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "load cap "));
  for (const f of ["load-cap.mjs", "slots.mjs"]) fs.copyFileSync(new URL(`./${f}`, import.meta.url), path.join(dir, f));
  const r = spawnSync("node", [path.join(dir, "load-cap.mjs"), "sh", "-c", "exit 7"], { env: { ...process.env, TANGO_LOAD_CAP: "off" } });
  assert.equal(r.status, 7);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("available memory is the kernel's percentage, or unknown", () => {
  assert.equal(availablePct(() => "37\n"), 37);
  assert.equal(availablePct(() => ""), null);
  assert.equal(availablePct(() => "nope"), null);
});

test("explicit worker and pool settings are preserved without a conflicting range", () => {
  for (const option of ["--maxWorkers=8", "--minWorkers=8", "--max-workers=8", "--min-workers=8",
    "--poolOptions.threads.minThreads=8", "--pool-options.threads.minThreads=8"]) {
    const args = ["vitest", "run", option];
    assert.deepEqual(capArgs(args, 5), args);
  }
  assert.deepEqual(capArgs(["vitest", "run", "--minWorkers", "8"], 5), ["vitest", "run", "--minWorkers", "8"]);
});

for (const workspace of ["../../package.json", "../../packages/atlas-memory/package.json", "../../apps/tango-voice/package.json"]) {
  test(`capped Vitest starts and executes a test with ${workspace}`, () => {
    const require = createRequire(new URL(workspace, import.meta.url));
    const cli = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "load-cap-vitest-"));
    try {
      fs.writeFileSync(path.join(dir, "vitest.config.mjs"), "export default {};\n");
      fs.writeFileSync(path.join(dir, "smoke.test.js"), 'test("executes", () => expect(1 + 1).toBe(2));\n');
      const args = capArgs(["vitest", "run", "--root", dir, "--config", path.join(dir, "vitest.config.mjs"), "--globals"], 1, path.dirname(fileURLToPath(new URL(workspace, import.meta.url))));
      const result = spawnSync(process.execPath, [cli, ...args.slice(1)], { encoding: "utf8", timeout: 30_000 });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /1 passed/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
