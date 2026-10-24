import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DECLINED, claim, eligible, guardScript, mirrorId, offload, poolDisabled, readConfig, runScript, sh, syncExcludes } from "./test-pool.mjs";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "test-pool-")); }

test("config: no file means no pool; bad hosts are dropped, defaults filled in", () => {
  const dir = tmp();
  assert.deepEqual(readConfig({ TANGO_TEST_POOL_CONFIG: path.join(dir, "missing.json") }), { hosts: [] });
  const file = path.join(dir, "pool.json");
  fs.writeFileSync(file, JSON.stringify({ hosts: [{ name: "mini", ssh: "me@10.0.0.1" }, { name: "bad name", ssh: "x" }, { name: "laptop", ssh: "me@10.0.0.2", slots: 1, whenIdle: true }, { ssh: "nameless" }] }));
  assert.deepEqual(readConfig({ TANGO_TEST_POOL_CONFIG: file }).hosts, [
    { name: "mini", ssh: "me@10.0.0.1", slots: 2, whenIdle: false },
    { name: "laptop", ssh: "me@10.0.0.2", slots: 1, whenIdle: true },
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("only vitest goes to the pool, and never in CI or when switched off", () => {
  assert.equal(eligible(["vitest", "run"]), true);
  assert.equal(eligible(["tsc", "-b"]), false);
  assert.equal(poolDisabled({ CI: "1" }), true);
  assert.equal(poolDisabled({ TANGO_TEST_POOL: "off" }), true);
  assert.equal(poolDisabled({}), false);
});

test("a worktree keeps one mirror, distinct from another worktree with the same name", () => {
  assert.equal(mirrorId("/a/tango"), mirrorId("/a/tango"));
  assert.notEqual(mirrorId("/a/tango"), mirrorId("/b/tango"));
  assert.match(mirrorId("/a/my worktree"), /^my_worktree-[0-9a-f]{10}$/);
});

test("what stays home is Git's whole ignore set, minus build output and node_modules", () => {
  const dir = tmp();
  const git = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  fs.writeFileSync(path.join(dir, ".gitignore"), "dist/\nnode_modules/\n*.tsbuildinfo\n.env\ndata/\n");
  fs.appendFileSync(path.join(dir, ".git", "info", "exclude"), "private-notes.md\n");
  // pkg/ holds only ignored files, so Git reports it as one folder; its build output still goes, its .env doesn't.
  for (const f of ["pkg/dist/index.js", "pkg/node_modules/x/i.js", "pkg/tsconfig.tsbuildinfo", "pkg/.env", "data/cache/x.json", ".env", "private-notes.md", "src/a.ts"]) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), "");
  }
  assert.deepEqual(syncExcludes(dir).sort(), ["/.env", "/data/", "/pkg/.env", "/private-notes.md"]);
  assert.equal(syncExcludes(dir, () => ({ status: 128, stdout: "" })), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("shell quoting survives quotes and spaces", () => {
  const r = spawnSync("/bin/bash", ["-c", `printf '%s|' ${["it's", "a b", "$HOME"].map(sh).join(" ")}`], { encoding: "utf8" });
  assert.equal(r.stdout, "it's|a b|$HOME|");
});

test("guard: idle-only machines also check power and idle time", () => {
  assert.doesNotMatch(guardScript({ whenIdle: false }), /pmset|HIDIdleTime/);
  assert.match(guardScript({ whenIdle: true }), /AC Power[\s\S]*HIDIdleTime/);
  assert.match(guardScript({ whenIdle: false }), new RegExp(`exit ${DECLINED}`));
  assert.match(guardScript({ whenIdle: false }, "wt"), /touch "\$HOME\/tango-pool\/mirrors\/wt\/node_modules\/\.pool-used"$/);
});

/** Runs a pool run script in its own process group (its stop path kills the group), stdin open like an ssh session's. */
function runRemote(script, env) {
  return new Promise(resolve => {
    const child = spawn("/bin/bash", ["-c", script], { env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", d => { stdout += d; });
    child.on("exit", status => { child.stdin.end(); resolve({ status, stdout }); });
  });
}

test("run script: installs only on a new lockfile, runs in the package dir, passes the exit code back", async () => {
  const home = tmp();
  const m = path.join(home, "tango-pool", "mirrors", "wt");
  fs.mkdirSync(path.join(m, "pkg", "a"), { recursive: true });
  fs.mkdirSync(path.join(home, "tango-pool", "node", "bin"), { recursive: true });
  // A fake npm records installs; the "tests" print where they ran and exit 3.
  fs.writeFileSync(path.join(home, "tango-pool", "node", "bin", "npm"), `#!/bin/sh\nmkdir -p node_modules; echo x >> "${home}/installs"\n`, { mode: 0o755 });
  // The "tests" print where they ran and their HOME, leave a file in it, and exit 3.
  const run = () => runRemote(runScript({ mirror: "wt", rel: "pkg/a", command: ["sh", "-c", "pwd; echo $HOME; touch $HOME/left; exit 3"], lockHash: "abc" }), { HOME: home });
  const first = await run();
  assert.equal(first.status, 3);
  const [where, runHome] = first.stdout.trim().split("\n");
  assert.equal(where, path.join(m, "pkg", "a"));
  assert.match(runHome, /tango-pool\/homes\/run\./);
  assert.deepEqual(fs.readdirSync(path.join(home, "tango-pool", "homes")), []);  // its own HOME, gone afterwards
  // A week-old mirror goes; one still being set up (no marker yet) stays.
  for (const d of ["old", "new"]) fs.mkdirSync(path.join(home, "tango-pool", "mirrors", d, "node_modules"), { recursive: true });
  const stale = path.join(home, "tango-pool", "mirrors", "old", "node_modules", ".pool-used");
  fs.writeFileSync(stale, "");
  fs.utimesSync(stale, new Date(Date.now() - 9 * 86_400_000), new Date(Date.now() - 9 * 86_400_000));
  await run();
  assert.equal(fs.readFileSync(path.join(home, "installs"), "utf8"), "x\n");
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(fs.readdirSync(path.join(home, "tango-pool", "mirrors")).sort(), ["new", "wt"]);
  fs.rmSync(home, { recursive: true, force: true });
});

test("run script: the run stops when the session's stdin closes", async () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, "tango-pool", "mirrors", "wt", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(home, "tango-pool", "mirrors", "wt", "node_modules", ".pool-lock"), "abc\n");
  const child = spawn("/bin/bash", ["-c", runScript({ mirror: "wt", rel: "", command: ["sleep", "30"], lockHash: "abc" })], { env: { HOME: home }, detached: true, stdio: ["pipe", "ignore", "ignore"] });
  const started = Date.now();
  setTimeout(() => child.stdin.end(), 300);
  const code = await new Promise(r => child.on("exit", (c, sig) => r(c ?? sig)));
  assert.ok(Date.now() - started < 5000, "stopped promptly");
  assert.notEqual(code, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test("run script: a failed install declines, so the run happens locally", async () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, "tango-pool", "mirrors", "wt"), { recursive: true });
  fs.mkdirSync(path.join(home, "tango-pool", "node", "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, "tango-pool", "node", "bin", "npm"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const r = await runRemote(runScript({ mirror: "wt", rel: "", command: ["sh", "-c", "echo ran"], lockHash: "abc" }), { HOME: home });
  assert.equal(r.status, DECLINED);
  assert.equal(r.stdout, "");
  fs.rmSync(home, { recursive: true, force: true });
});

test("a machine that declines is skipped for a while and its slot given back", () => {
  const root = tmp();
  const bin = tmp();
  // Stand-in ssh: the guard says "busy".
  fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh\ncat >/dev/null; echo "memory 5%"; exit ${DECLINED}\n`, { mode: 0o755 });
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}:${PATH}`;
  try {
    const logs = [];
    assert.equal(claim([{ name: "busy", ssh: "x", slots: 1 }], root, "wt", m => logs.push(m)), null);
    assert.deepEqual(logs, ["busy declined (memory 5%)"]);
    assert.deepEqual(fs.readdirSync(path.join(root, "busy")), ["mirrors"]);
    assert.deepEqual(fs.readdirSync(path.join(root, "busy", "mirrors", "wt")), []);
    assert.equal(claim([{ name: "busy", ssh: "x", slots: 1 }], root, "wt", m => logs.push(m)), null);
    assert.equal(logs.length, 1);  // not asked again within the minute
  } finally {
    process.env.PATH = PATH;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("a worktree's mirror takes one run at a time; another worktree's run still gets in", () => {
  const root = tmp();
  const bin = tmp();
  fs.writeFileSync(path.join(bin, "ssh"), "#!/bin/sh\ncat >/dev/null; exit 0\n", { mode: 0o755 });
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}:${PATH}`;
  try {
    const hosts = [{ name: "mini", ssh: "x", slots: 3 }];
    const first = claim(hosts, root, "wt");
    assert.ok(first);
    assert.equal(claim(hosts, root, "wt"), null);
    assert.ok(claim(hosts, root, "other"));
  } finally {
    process.env.PATH = PATH;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("offload does nothing without a pool", async () => {
  assert.equal(await offload(["vitest", "run"], { env: { TANGO_TEST_POOL_CONFIG: "/nonexistent" } }), null);
  assert.equal(await offload(["tsc"], { env: {} }), null);
});
