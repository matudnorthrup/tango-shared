#!/usr/bin/env node
// Runs a heavy command (a test run, a build) under the machine's load cap, so agents' parallel runs can't starve the
// owner's apps: at most RUNS of them at once machine-wide, each with a worker cap, plain nice (no E-core pinning),
// and a memory-pressure valve (a new run waits while the kernel reports under 12% memory available). Development speed comes first.
//   node scripts/dev/load-cap.mjs vitest run ...
// Off in CI (TANGO_LOAD_CAP=off or CI set). A run that waits too long goes ahead anyway: the cap never blocks work.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { release, tryAcquire } from "./slots.mjs";

export { release, tryAcquire };

const DEFAULT_WAIT_MS = 30 * 60_000;

export function limits(env = process.env, cores = os.availableParallelism()) {
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 1 ? Math.floor(n) : d; };
  return {
    runs: num(env.TANGO_LOAD_CAP_RUNS, Math.max(2, Math.floor(cores / 2))),
    workers: num(env.TANGO_LOAD_CAP_WORKERS, Math.max(2, Math.floor(cores / 3))),
    minAvailablePct: num(env.TANGO_LOAD_CAP_MIN_AVAILABLE_PCT, 12),
    waitMs: num(env.TANGO_LOAD_CAP_WAIT_MS, DEFAULT_WAIT_MS),
  };
}

export function disabled(env = process.env) {
  return env.TANGO_LOAD_CAP === "off" || !!env.CI;
}

/** Vitest gets a compatible worker range unless the caller supplied worker/pool options. */
export function capArgs(args, workers, cwd = process.cwd()) {
  const isVitest = path.basename(args[0] ?? "") === "vitest";
  const explicitWorkers = args.some(a => /^--(?:maxWorkers|minWorkers|max-workers|min-workers|poolOptions|pool-options)(?:[.=]|$)/.test(a));
  if (!isVitest || explicitWorkers) return args;
  // Resolve from the workspace, not this shared wrapper: the repo uses Vitest 1, 3 and 4.
  const major = Number(createRequire(path.join(cwd, "package.json"))("vitest/package.json").version.split(".")[0]);
  // Vitest 1's default minimum can exceed the cap. Vitest 4 removed minWorkers.
  return [...args, `--maxWorkers=${workers}`, ...(major < 4 ? ["--minWorkers=1"] : [])];
}

/** macOS's own "memory available" percentage (the kernel's pressure signal, which counts what it can reclaim). null: unknown. */
export function availablePct(read = () => spawnSync("sysctl", ["-n", "kern.memorystatus_level"], { encoding: "utf8" }).stdout) {
  const n = Number(String(read()).trim());
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : null;
}

async function offloadToPool(args) {
  const { offload } = await import("./test-pool.mjs");
  return offload(args);
}

async function main(args) {
  if (!args.length) { console.error("usage: load-cap.mjs <command> [args...]"); process.exit(2); }
  const { runs, workers, waitMs, minAvailablePct } = limits();
  let slot = null;
  let command = args;
  if (!disabled()) {
    const root = path.join(os.tmpdir(), `tango-load-cap-${os.userInfo().uid}`);
    const deadline = Date.now() + waitMs;
    let told = false;
    for (;;) {
      const free = process.platform === "darwin" ? availablePct() : null;
      const squeezed = free !== null && free < minAvailablePct;
      if (!squeezed && (slot = tryAcquire(root, runs))) break;
      // No room here: another machine in the test pool may take it (see test-pool.mjs). null means it didn't.
      const remote = await offloadToPool(capArgs(args, workers));
      if (remote !== null) process.exit(remote);
      if (Date.now() >= deadline) break;
      if (!told) { console.error(squeezed ? `[load-cap] memory is tight (${free}% available); waiting` : `[load-cap] ${runs} heavy runs already going; waiting for a slot`); told = true; }
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!slot) console.error("[load-cap] waited too long; running without a slot");
    command = capArgs(args, workers);
    // Plain nice: the owner's foreground apps still win a contested core, but runs may use every core, performance ones included.
    if (process.platform !== "win32") command = ["nice", "-n", "5", ...command];
  }
  const child = spawn(command[0], command.slice(1), { stdio: "inherit" });
  const cleanup = () => { if (slot) release(slot); };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
  child.on("error", e => { cleanup(); console.error(`[load-cap] ${e.message}`); process.exit(127); });
  child.on("exit", (code, signal) => { cleanup(); process.exit(code ?? (signal ? 1 : 0)); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) await main(process.argv.slice(2));
