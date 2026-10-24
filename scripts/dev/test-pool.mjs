// Sends a test run that would wait for a local load-cap slot to another machine on the tailnet instead (the test pool).
// The worktree is copied over SSH into one mirror per worktree on the pool machine (no .git, no node_modules, nothing
// Git ignores except build output), dependencies are reinstalled there only when the lockfile changes, and the run's
// output and exit code come back as if it ran here. Runs get an isolated HOME and no secrets: Tango's tests need none.
// Anything that goes wrong before the tests start (machine asleep, busy, unreachable) falls back to running locally.
//
// Machines are listed in ~/.tango/test-pool.json (or TANGO_TEST_POOL_CONFIG); no file means no pool:
//   { "hosts": [{ "name": "mini", "ssh": "me@100.x.y.z", "slots": 3 },
//               { "name": "laptop", "ssh": "me@100.a.b.c", "slots": 2, "whenIdle": true }] }
// "whenIdle" machines take runs only on AC power, idle 10+ minutes. A new machine is set up with test-pool-setup.sh.
// Off with TANGO_TEST_POOL=off, in CI, and for anything but `vitest`.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { release, tryAcquire } from "./slots.mjs";

/** Exit code a pool machine uses to say "not now"; the run then stays local. */
export const DECLINED = 75;
const DOWN_FOR_MS = 60_000;
const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=4", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];

export function readConfig(env = process.env) {
  const file = env.TANGO_TEST_POOL_CONFIG || path.join(os.homedir(), ".tango", "test-pool.json");
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { hosts: [] }; }
  const hosts = (Array.isArray(raw?.hosts) ? raw.hosts : [])
    .filter(h => h && typeof h.name === "string" && /^[\w.-]+$/.test(h.name) && typeof h.ssh === "string" && h.ssh)
    .map(h => ({ name: h.name, ssh: h.ssh, slots: Number.isInteger(h.slots) && h.slots > 0 ? h.slots : 2, whenIdle: !!h.whenIdle }));
  return { hosts };
}

export function poolDisabled(env = process.env) {
  return env.TANGO_TEST_POOL === "off" || !!env.CI;
}

export function eligible(args) {
  return path.basename(args[0] ?? "") === "vitest";
}

/** Single-quotes a word for a POSIX shell. */
export function sh(word) {
  return `'${String(word).replace(/'/g, `'\\''`)}'`;
}

/** The mirror a worktree gets on every pool machine: stable per worktree path, so repeat runs only copy what changed. */
export function mirrorId(root) {
  return `${path.basename(root).replace(/[^\w.-]/g, "_").slice(0, 40)}-${crypto.createHash("sha1").update(root).digest("hex").slice(0, 10)}`;
}

/** rsync filters (excluded paths are left alone on the pool machine, which keeps its own node_modules). */
export const SYNC_FILTERS = ["--exclude=/.git", "--exclude=node_modules/", "--exclude-from=-"];

const sent = p => /(^|\/)(node_modules|dist)\/?$/.test(p) || p.endsWith(".tsbuildinfo");

function hasDist(dir) {
  const r = spawnSync("find", [dir, "-name", "node_modules", "-prune", "-o", "-type", "d", "-name", "dist", "-print", "-quit"], { encoding: "utf8" });
  return !!r.stdout.trim();
}

/** Excludes for an ignored folder that holds build output: everything in it but the build output (node_modules is excluded anyway). */
function insideIgnored(root, rel) {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const p = `${rel}${e.name}${e.isDirectory() ? "/" : ""}`;
    if (sent(p)) continue;
    if (e.isDirectory() && hasDist(path.join(root, p))) out.push(...insideIgnored(root, p));
    else out.push(`/${p}`);
  }
  return out;
}

/**
 * What stays home, from Git's own ignore rules (every .gitignore, .git/info/exclude, core.excludesFile, `!` rules):
 * each ignored path, anchored, except build output, which packages import from each other. null if Git can't say.
 */
export function syncExcludes(root, list = () => spawnSync("git", ["ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory"], { cwd: root, encoding: "utf8" })) {
  const r = list();
  if (r.status !== 0) return null;
  const out = [];
  for (const p of r.stdout.split("\0").filter(Boolean)) {
    if (sent(p)) continue;
    // Git lists a folder holding nothing but ignored files as one entry; if build output is in there, look inside.
    if (p.endsWith("/") && hasDist(path.join(root, p))) out.push(...insideIgnored(root, p));
    else out.push(`/${p}`);
  }
  return [...new Set(out)];
}

/** The script a pool machine runs before tests: decline when it's busy or (for idle-only machines) in use. */
export function guardScript({ whenIdle, minAvailablePct = 15 }, mirror) {
  const lines = [
    `free=$(sysctl -n kern.memorystatus_level 2>/dev/null || echo 100)`,
    `[ "$free" -ge ${minAvailablePct} ] || { echo "memory $free%"; exit ${DECLINED}; }`,
    `[ -x "$HOME/tango-pool/node/bin/node" ] || { echo "not set up"; exit ${DECLINED}; }`,
  ];
  if (whenIdle) lines.push(
    `pmset -g batt | grep -q "AC Power" || { echo "on battery"; exit ${DECLINED}; }`,
    `idle=$(ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}')`,
    `[ "\${idle:-0}" -ge 600 ] || { echo "in use"; exit ${DECLINED}; }`,
  );
  // Accepted: mark the mirror used before the copy starts, so another run's cleanup can't take it mid-copy.
  if (mirror) lines.push(`mkdir -p "$HOME/tango-pool/mirrors/${mirror}/node_modules" && touch "$HOME/tango-pool/mirrors/${mirror}/node_modules/.pool-used"`);
  return lines.join("\n");
}

/** Runs on the pool machine after the copy: install when the lockfile changed, then the tests, killed if we go away. */
export function runScript({ mirror, rel, command, lockHash }) {
  return [
    `set -u`,
    // Our stdin closes when the ssh session ends (we were stopped, the network dropped): take the whole run down with it.
    // (A background job's stdin is /dev/null unless redirected, hence fd 3.)
    // Detached children a test started (session hosts) are orphans by then; they go too.
    `P="$HOME/tango-pool"; M="$P/mirrors/${mirror}"`,
    // The workspace's own bin comes before the root's, as npm resolves it (workspaces pin their own Vitest).
    // Each run gets its own HOME, removed afterwards; only npm's download cache is shared.
    `H=$(mkdir -p "$P/homes" && mktemp -d "$P/homes/run.XXXXXX") || exit ${DECLINED}`,
    `exec 3<&0; (trap "" TERM; cat <&3 >/dev/null 2>&1; kill -TERM 0; sleep 1; pkill -TERM -P 1 -f "$M/"; rm -rf "$H") >/dev/null 2>&1 & watcher=$!; disown $watcher`,
    `done_() { kill -KILL $watcher 2>/dev/null; rm -rf "$H"; exit $1; }`,
    `export HOME="$H" npm_config_cache="$P/npm-cache" PATH="$P/node/bin:$M/${rel || "."}/node_modules/.bin:$M/node_modules/.bin:/usr/bin:/bin:/usr/sbin:/sbin" TANGO_LOAD_CAP=off TANGO_TEST_POOL=off`,
    // The marker lives in node_modules, which the copy never touches.
    `if [ "$(cat "$M/node_modules/.pool-lock" 2>/dev/null)" != ${sh(lockHash)} ]; then`,
    `  echo "[test-pool] installing dependencies" >&2`,
    // A failed install is the machine's problem, not the tests': decline, and the run happens here instead.
    `  (cd "$M" && npm ci --prefer-offline --no-audit --no-fund --loglevel=error </dev/null >&2) || done_ ${DECLINED}`,
    `  echo ${sh(lockHash)} > "$M/node_modules/.pool-lock"`,
    `fi`,
    // Mirrors of worktrees that haven't sent a run in a week are removed (about 850 MB each).
    `touch "$M/node_modules/.pool-used"`,
    // A mirror whose first run never got going has no marker; its age is its last copy's (the copy changes its ctime).
    // Fully detached, so a big delete doesn't hold the session open after the tests finish.
    // A stale mirror is first renamed out of mirrors/ (atomic), then checked again: a run that claimed it in between
    // either touched its marker first (it goes back) or finds no mirror and copies a fresh one.
    `stale() { if [ -e "$1/node_modules/.pool-used" ]; then [ -n "$(find "$1/node_modules/.pool-used" -mtime +7)" ]; else [ -n "$(find "$1" -maxdepth 0 -ctime +7)" ]; fi; }`,
    `for d in "$P"/mirrors/*; do`,
    `  [ "$d" = "$M" ] && continue; stale "$d" || continue`,
    `  t="$P/reaping.\${d##*/}.$$"; mv "$d" "$t" 2>/dev/null || continue`,
    `  if stale "$t" || [ -e "$d" ]; then rm -rf "$t"; else mv "$t" "$d"; fi`,
    `done </dev/null >/dev/null 2>&1 &`,
    `cd "$M/${rel || "."}" || done_ ${DECLINED}`,
    `nice -n 5 ${command.map(sh).join(" ")} </dev/null; done_ $?`,
  ].join("\n");
}

function ssh(host, script, opts = {}) {
  return spawnSync("ssh", [...SSH_OPTS, host.ssh, "/bin/bash", "-s"], { input: script, encoding: "utf8", timeout: 20_000, ...opts });
}

function repoRoot(cwd) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function lockfileHash(root) {
  try { return crypto.createHash("sha1").update(fs.readFileSync(path.join(root, "package-lock.json"))).digest("hex"); } catch { return "none"; }
}

const down = new Map();

/** A free pool slot on a machine that says yes, or null. Cheap when every machine is full or recently down. */
export function claim(hosts, root, mirror, log = () => {}) {
  for (const host of hosts) {
    if ((down.get(host.name) ?? 0) > Date.now()) continue;
    const slot = tryAcquire(path.join(root, host.name), host.slots);
    if (!slot) continue;
    // One run per mirror at a time: two would share one install and copy files under each other's tests.
    const mirrorLock = tryAcquire(path.join(root, host.name, "mirrors", mirror), 1);
    if (!mirrorLock) { release(slot); continue; }
    const g = ssh(host, guardScript(host, mirror), { timeout: 10_000 });
    if (g.status === 0) return { host, slot, mirrorLock };
    release(slot);
    release(mirrorLock);
    down.set(host.name, Date.now() + DOWN_FOR_MS);
    log(`${host.name} declined (${(g.stdout || g.stderr || g.error?.message || `exit ${g.status}`).trim().split("\n").pop()})`);
  }
  return null;
}

/**
 * Tries to run `args` (from `cwd`) on a pool machine. Resolves to the run's exit code, or null when it never started
 * remotely and should run here instead. Once the run starts, our SIGINT/SIGTERM/SIGHUP stop it on the pool machine.
 */
export async function offload(args, { cwd = process.cwd(), env = process.env, log = m => console.error(`[test-pool] ${m}`) } = {}) {
  if (poolDisabled(env) || !eligible(args)) return null;
  const { hosts } = readConfig(env);
  if (!hosts.length) return null;
  const root = repoRoot(cwd);
  if (!root) return null;
  const mirror = mirrorId(root);
  const claimed = claim(hosts, path.join(os.tmpdir(), `tango-test-pool-${os.userInfo().uid}`), mirror, log);
  if (!claimed) return null;
  const { host, slot, mirrorLock } = claimed;
  try {
    const rel = path.relative(root, fs.realpathSync(cwd)).split(path.sep).join("/");
    const started = Date.now();
    const excludes = syncExcludes(root);
    if (!excludes) { log("couldn't read the worktree's ignore rules; running here"); return null; }
    const sync = spawnSync("rsync", ["-a", "--delete", "-e", `ssh ${SSH_OPTS.join(" ")}`, ...SYNC_FILTERS, `${root}/`, `${host.ssh}:tango-pool/mirrors/${mirror}/`], { input: excludes.join("\n") + "\n", encoding: "utf8", timeout: 120_000 });
    if (sync.status !== 0) {
      log(`copy to ${host.name} failed; running here (${(sync.stderr || sync.error?.message || "").trim().split("\n").pop()})`);
      down.set(host.name, Date.now() + DOWN_FOR_MS);
      return null;
    }
    log(`running on ${host.name} (copied in ${((Date.now() - started) / 1000).toFixed(1)}s)`);
    const child = spawn("ssh", [...SSH_OPTS, host.ssh, "/bin/bash", "-c", sh(runScript({ mirror, rel, command: args, lockHash: lockfileHash(root) }))], { stdio: ["pipe", "inherit", "inherit"] });
    let stopped = null;
    const stop = sig => { stopped = sig; child.kill(sig); };
    const sigs = ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const sig of sigs) process.on(sig, stop);
    return await new Promise(resolve => {
      child.on("error", e => { log(e.message); resolve(null); });
      child.on("exit", (code, signal) => {
        for (const sig of sigs) process.off(sig, stop);
        if (stopped) return resolve(128 + os.constants.signals[stopped]);
        // 255 is ssh's own failure (the connection dropped): the honest answer is to run it here.
        if (code === 255) { log(`lost ${host.name}; running here`); down.set(host.name, Date.now() + DOWN_FOR_MS); return resolve(null); }
        if (code === DECLINED) { log(`${host.name} couldn't set up the run; running here`); down.set(host.name, Date.now() + DOWN_FOR_MS); return resolve(null); }
        resolve(code ?? (signal ? 1 : 0));
      });
    });
  } finally {
    release(slot);
    release(mirrorLock);
  }
}
