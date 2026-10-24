import * as fs from "node:fs/promises";
import { Readable } from "node:stream";
import { createLoomServer } from "../src/http.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, statSync, symlinkSync, truncateSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoomStore } from "../src/store.js";
import { Worktrees, checkpoint, hasCwdProcess } from "../src/worktrees.js";
import { LoomHost } from "../src/host.js";
import { createWorktree, seedDependencies } from "../src/git.js";
import { reclaimCall } from "../src/reclaim-io.js";
import { FakeRuntime } from "./fake-runtime.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const roots: string[] = [];
const stores: LoomStore[] = [];
const hosts: LoomHost[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const h of hosts.splice(0)) await h.closeAll(); for (const s of stores.splice(0)) s.close(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function setup() {
  const root = mkdtempSync(join(tmpdir(), "loom-reclaim-test-")); roots.push(root);
  const home = join(root, "home"); const repo = join(root, "repo"); const origin = join(root, "origin.git");
  mkdirSync(home); git(root, "init", "-q", "--bare", "-b", "main", origin); git(root, "init", "-q", "-b", "main", repo);
  git(repo, "config", "user.name", "Test"); git(repo, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.next/\n.turbo/\n.expo/\ndist/\n");
  writeFileSync(join(repo, "tracked"), "safe"); git(repo, "add", "."); git(repo, "commit", "-qm", "initial");
  git(repo, "remote", "add", "origin", origin); git(repo, "push", "-q", "origin", "main"); git(repo, "remote", "set-head", "origin", "main");
  const id = "abcdef01-2345"; const path = join(home, "worktrees", "repo", "loom-abcdef01"); mkdirSync(join(home, "worktrees", "repo"), { recursive: true });
  git(repo, "worktree", "add", "-qb", "loom/abcdef01", path);
  const store = new LoomStore(":memory:"); stores.push(store);
  const thread = store.tx(() => store.createThread({ id, cwd: path, repo, kind: "test", provider: "fake" }));
  const service = (extra: Partial<ConstructorParameters<typeof Worktrees>[2]> = {}) => new Worktrees(store, home, { gh: async () => "[]", live: () => false, mailbox: async (_id, fn) => fn(), cwdProcess: async () => false, ...extra });
  return { root, home, repo, origin, path, store, thread, service };
}

// Real git repos and checkouts: slow under a loaded machine, so not the 5 s default.
describe("worktree lifecycle", { timeout: 30_000 }, () => {
  function age(f: ReturnType<typeof setup>, hours = 31) {
    const ended = f.store.now();
    f.store.tx(() => {
      const run = f.store.createRun(f.thread.id, "user", "work");
      f.store.updateRun(run.id, { status: "completed", ended_at: ended });
    });
    f.store.now = () => ended + hours * 3600_000;
    f.store.tx(() => f.store.touchThread(f.thread.id));
  }
  const mergedPr = (f: ReturnType<typeof setup>, head = git(f.path, "rev-parse", "HEAD")) => async () => JSON.stringify([{ number: 42, mergedAt: "2026-10-18T00:00:00Z", headRefOid: head }]);

  it("plans without measuring dependency contents, but list still reports allocated size", async () => {
    const f = setup(); age(f); outputs(f);
    const service = f.service();
    const detailed = (await service.list())[0]!;
    expect(detailed.size).toBeGreaterThan(0);
    const original = fs.readdir;
    const spy = vi.spyOn(fs, "readdir").mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]).includes("node_modules")) throw new Error("must not measure dependencies");
      return original(...args);
    });
    try {
      const result = await service.reclaim(true);
      expect(result.inspectTimeouts).toBe(0);
      expect(result.plans[0]).toMatchObject({ action: detailed.action, targets: detailed.targets, size: null });
      expect(spy.mock.calls.some(([path]) => String(path).includes("node_modules"))).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it("keeps held folders without traversing them", async () => {
    const f = setup(); age(f); outputs(f);
    const original = fs.readdir;
    const spy = vi.spyOn(fs, "readdir").mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]) === realpathSync(f.path)) throw new Error("must not traverse held checkout");
      return original(...args);
    });
    try {
      expect((await f.service({ leased: () => true }).reclaim(true)).plans[0]).toMatchObject({ action: "keep", reason: "resource lease", size: null });
      expect(spy.mock.calls.some(([path]) => String(path) === realpathSync(f.path))).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it("times out a stalled filesystem inspection and lets the next pass run", async () => {
    const f = setup(); age(f);
    const original = fs.readdir;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let blocked = false;
    const spy = vi.spyOn(fs, "readdir").mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]) === realpathSync(f.path) && !blocked) { blocked = true; await gate; }
      return original(...args);
    });
    const service = f.service({ ioTimeoutMs: 2000 });
    try {
      const pending = service.reclaimScheduled(true);
      const result = await Promise.race([pending, new Promise<null>(resolve => setTimeout(() => resolve(null), 10_000))]);
      expect(result?.plans[0]).toMatchObject({ action: "keep", reason: "inspect timed out" });
      expect(result?.inspectTimeouts).toBe(1);
      expect(blocked).toBe(true);
      // A late fs completion must not resume the abandoned traversal or delete anything.
      release(); await pending;
      // Recovery exercises real git commands, not the deliberately short timeout.
      service["options"].ioTimeoutMs = 30_000;
      expect((await service.reclaimScheduled(true))?.plans[0]?.action).toBe("remove");
      expect(existsSync(f.path)).toBe(true);
    } finally { release(); spy.mockRestore(); }
  });

  it("reads default disk pressure with one outstanding native request", async () => {
    const f = setup();
    const service = f.service();
    let release!: () => void;
    const pending = service["io"].call(() => new Promise<void>(resolve => { release = resolve; }));
    try {
      const result = await service.pressure(true, { floorBytes: 0, targetBytes: 0, idleMs: 0 });
      expect(result.beforeBytes).toBeGreaterThan(0);
    } finally { release(); await pending; }
  });

  it("accounts injected disk readers until their timed-out native work settles", async () => {
    const f = setup();
    const releases: (() => void)[] = [];
    const reader = vi.fn(() => new Promise<number>(resolve => { releases.push(() => resolve(1)); }));
    const service = f.service({ ioTimeoutMs: 30, diskFree: reader });
    const limits = { floorBytes: 0, targetBytes: 0, idleMs: 0 };
    try {
      await expect(service.pressure(true, limits)).rejects.toThrow("inspect timed out");
      service["options"].diskFree = undefined;
      expect((await service.pressure(true, limits)).beforeBytes).toBeGreaterThan(0);
      service["options"].diskFree = reader;
      await expect(service.pressure(true, limits)).rejects.toThrow("inspect timed out");
      await expect(service.pressure(true, limits)).rejects.toThrow("inspect timed out");
      expect(reader).toHaveBeenCalledTimes(2);
    } finally { for (const release of releases) release(); }
  });

  it.each(["missing", "mismatched"])("parks with a %s stamp and one outstanding native request", async stamp => {
    const f = setup(); age(f);
    writeFileSync(join(f.path, "package-lock.json"), "{}");
    git(f.path, "add", "package-lock.json"); git(f.path, "commit", "-qm", "lockfile");
    git(f.repo, "merge", "--ff-only", "loom/abcdef01"); git(f.repo, "push", "-q", "origin", "main");
    mkdirSync(join(f.path, "node_modules"));
    writeFileSync(join(f.path, "node_modules", "cache"), "regenerable");
    if (stamp === "mismatched") writeFileSync(join(f.path, "node_modules", ".loom-lock"), "stale");
    const service = f.service();
    let release!: () => void;
    const pending = service["io"].call(() => new Promise<void>(resolve => { release = resolve; }));
    try {
      expect((await service.reclaim(false)).plans[0]).toMatchObject({ action: "remove" });
      expect(existsSync(f.path)).toBe(false);
      expect(f.store.thread(f.thread.id)!.worktree_removed_at).not.toBeNull();
      expect((await service.reclaim(false)).plans.every(plan => plan.action === "unowned" || plan.action === "keep")).toBe(true);
    } finally { release(); await pending; }
  });

  it.each(["missing", "mismatched"])("recovers a partial park with %s stamp after cancellation, keeping the mailbox", async stamp => {
    const f = setup(); age(f);
    writeFileSync(join(f.path, "package-lock.json"), "{}");
    git(f.path, "add", "package-lock.json"); git(f.path, "commit", "-qm", "lockfile");
    git(f.repo, "merge", "--ff-only", "loom/abcdef01"); git(f.repo, "push", "-q", "origin", "main");
    mkdirSync(join(f.path, "node_modules"));
    writeFileSync(join(f.path, "node_modules", "cache"), "regenerable");
    if (stamp === "mismatched") writeFileSync(join(f.path, "node_modules", ".loom-lock"), "stale");
    const head = git(f.path, "rev-parse", "HEAD");
    const branch = git(f.path, "branch", "--show-current");
    const original = fs.readdir;
    let releaseRead!: () => void;
    const gate = new Promise<void>(resolve => { releaseRead = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let mailboxHeld = false;
    let mailboxDone!: () => void;
    const done = new Promise<void>(resolve => { mailboxDone = resolve; });
    const service = f.service({ passTimeoutMs: 2000, mailbox: async (_id, fn) => {
      mailboxHeld = true;
      try { return await fn(); } finally { mailboxHeld = false; mailboxDone(); }
    } });
    let releaseSlot!: () => void;
    const pending = service["io"].call(() => new Promise<void>(resolve => { releaseSlot = resolve; }));
    const spy = vi.spyOn(fs, "readdir").mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]).includes("/.pool/") && String(args[0]).endsWith("/node_modules")) { entered(); await gate; }
      return original(...args);
    });
    try {
      const pass = service.reclaim(false);
      const outcome = pass.catch(error => error);
      await started;
      expect(existsSync(f.path)).toBe(false); // Fault is after the real git move.
      await outcome;
      expect(mailboxHeld).toBe(true);
      releaseRead();
      await done;
      expect(mailboxHeld).toBe(false);
      expect(existsSync(f.path)).toBe(true);
      expect(git(f.path, "rev-parse", "HEAD")).toBe(head);
      expect(git(f.path, "branch", "--show-current")).toBe(branch);
      expect(readFileSync(join(f.path, "tracked"), "utf8")).toBe("safe");
      expect(f.store.thread(f.thread.id)!.worktree_removed_at).toBeNull();
      expect(f.store.thread(f.thread.id)!.worktree_shrunk_at).not.toBeNull();
      expect((await fs.readdir(join(f.home, "worktrees", "repo", ".pool")))).toEqual([]);
      spy.mockRestore();
      service["options"].passTimeoutMs = 30_000;
      expect((await service.reclaim(false)).plans[0]).toMatchObject({ action: "remove" });
      expect((await service.reclaim(false)).plans.every(plan => plan.action === "unowned" || plan.action === "keep")).toBe(true);
    } finally { releaseRead(); releaseSlot(); await pending; spy.mockRestore(); }
  });

  it("runs the default cwd check with one native I/O slot already occupied", async () => {
    const f = setup();
    const service = f.service({ cwdProcess: undefined });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    await service.withPass("test", true, async () => {
      const pending = reclaimCall(async () => { entered(); await gate; });
      try {
        await started;
        expect(await service["busy"](f.thread, realpathSync(f.path))).toBe(false);
      } finally { release(); await pending; }
    });
  });

  it.each(["lifecycle", "pressure"])("%s watchdog logs heartbeats, abandons the pass and accepts a new pass", async mode => {
    const f = setup(); age(f); outputs(f);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let stuck = true;
    const service = f.service({
      passTimeoutMs: 1000, ioTimeoutMs: 2000, heartbeatMs: 100, diskFree: async () => 10,
      mailbox: async (_id, work) => { if (stuck) await gate; return work(); },
    });
    const run = () => mode === "lifecycle" ? service.reclaimScheduled(true) : service.pressure(true, pressureLimits);
    try {
      await expect(run()).rejects.toThrow("inspect timed out");
      const entries = readFileSync(join(f.home, "reclaim.log"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(entries.some(entry => entry.heartbeat === "pass running")).toBe(true);
      expect(entries.some(entry => entry.skipped === "pass stalled")).toBe(true);
      if (mode === "lifecycle") {
        for (const entry of entries.filter(entry => entry.heartbeat || entry.skipped === "pass stalled")) {
          expect(entry.progress).toEqual({ phase: "mailbox", done: 0, total: 1, current: f.path });
        }
      }
      stuck = false; release();
      // Keep the watchdog assertion short without timing healthy recovery against it.
      service["options"].passTimeoutMs = 30_000;
      service["options"].ioTimeoutMs = 30_000;
      // Give the resumed mailbox a chance to hit its aborted context.
      await new Promise(resolve => setImmediate(resolve));
      expect(await run()).toBeDefined();
      expect(existsSync(f.path)).toBe(true);
    } finally { release(); }
  });

  it.each(["settled", "stopped", "deleted"])("keeps %s unmerged heads even after the idle delay", async state => {
    const f = setup(); git(f.path, "commit", "-qm", "unmerged", "--allow-empty"); age(f, 100);
    f.store.tx(() => {
      if (state === "deleted") f.store.deleteThread(f.thread.id, true);
      else f.store.updateThread(f.thread.id, state === "stopped" ? { status: "stopped" } : { settled_at: f.store.now() - 99 * 3600_000 });
    });
    for (const gh of [async () => "[]", async () => { throw new Error("offline"); }]) {
      for (const dryRun of [true, false]) expect((await f.service({ gh }).reclaim(dryRun)).plans[0]?.action).toBe("keep");
    }
    expect(existsSync(f.path)).toBe(true);
  });

  it("rechecks thread status changed during filesystem inspection", async () => {
    const f = setup(); age(f);
    let calls = 0;
    const service = f.service({ cwdProcess: async () => {
      if (++calls === 2) f.store.tx(() => f.store.updateThread(f.thread.id, { status: "running" }));
      return false;
    } });
    expect((await service.reclaim(false)).plans[0]).toMatchObject({ action: "keep", reason: "became busy" });
    expect(existsSync(f.path)).toBe(true);
    expect(f.store.thread(f.thread.id)!.worktree_removed_at).toBeNull();
  });

  it('starts a same-tree worker in its parent build checkout and prevents either owner reclaiming it', async () => {
    const f = setup();
    f.store.tx(() => f.store.updateThread(f.thread.id, { kind: 'coding', worktree_mode: 'worktree', worktree_branch: 'loom/abcdef01', settled_at: f.store.now() }));
    age(f);
    const runtime = new FakeRuntime();
    const host = new LoomHost(f.store, { fake: runtime }, { loomHome: f.home, createWorktree: async () => { throw new Error('must reuse'); } }); hosts.push(host);
    const result = await host.execute({ type: 'submit', commandId: 'same-tree', provider: 'fake', text: 'Build', role: 'worker', parentThreadId: `loom:${f.thread.id}`, sameTree: true });
    expect(f.store.thread(result.threadId!)!).toMatchObject({ cwd: f.path, repo: f.repo, worktree_mode: 'worktree', worktree_branch: 'loom/abcdef01' });
    expect(runtime.last.options.cwd).toBe(f.path);
    expect((await f.service().reclaim(false)).plans).toEqual(expect.arrayContaining([expect.objectContaining({ thread: f.thread.id, action: 'keep', reason: 'checkout has multiple owners' })]));
    expect(existsSync(f.path)).toBe(true);
  });

  it('rechecks sharing when a worker starts during cleanup inspection', async () => {
    const f = setup();
    f.store.tx(() => f.store.updateThread(f.thread.id, { settled_at: f.store.now() }));
    age(f);
    let shared = false;
    const service = f.service({ cwdProcess: async () => {
      if (!shared) {
        shared = true;
        f.store.tx(() => f.store.createThread({ kind: 'coding', provider: 'fake', cwd: f.path, repo: f.repo, role: 'worker', worktreeMode: 'worktree' }));
      }
      return false;
    } });
    expect((await service.reclaim(false)).plans[0]).toMatchObject({ action: 'keep', reason: 'became busy' });
    expect(existsSync(f.path)).toBe(true);
  });

  it.each(['missing', 'local', 'removed', 'non-worker', 'combined', 'existing'])('rejects an invalid same-tree start: %s', async variant => {
    const f = setup();
    f.store.tx(() => f.store.updateThread(f.thread.id, { kind: 'coding', worktree_mode: variant === 'local' ? 'local' : 'worktree', ...(variant === 'removed' ? { worktree_removed_at: f.store.now() } : {}) }));
    const host = new LoomHost(f.store, { fake: new FakeRuntime() }, { loomHome: f.home, createWorktree: async () => { throw new Error('must not create'); } }); hosts.push(host);
    await expect(host.execute({ type: 'submit', commandId: 'invalid-shared', provider: 'fake', text: 'Build', role: variant === 'non-worker' ? 'interactive' : 'worker', parentThreadId: variant === 'missing' ? 'loom:missing' : `loom:${f.thread.id}`, sameTree: true, ...(variant === 'combined' ? { worktree: true } : {}), ...(variant === 'existing' ? { threadId: f.thread.id } : {}) })).rejects.toThrow(/sameTree/);
  });

  const pressureLimits = { floorBytes: 20, targetBytes: 22, idleMs: 600_000 };
  function outputs(f: ReturnType<typeof setup>) {
    for (const name of [".turbo", "node_modules"]) {
      mkdirSync(join(f.path, name), { recursive: true });
      writeFileSync(join(f.path, name, "data"), "regenerable");
    }
  }
  it.each(["coding", "probe"])("pressure preserves a checkout borrowed by a %s thread", async kind => {
    const f = setup(); age(f, 2); outputs(f);
    f.store.tx(() => f.store.createThread({ kind, provider: "fake", cwd: f.path, repo: f.repo }));
    const cool = vi.fn(async () => true);
    await f.service({ diskFree: async () => 10, live: id => id === f.thread.id, cool }).pressure(false, pressureLimits);
    expect(cool).not.toHaveBeenCalled();
    expect(existsSync(join(f.path, "node_modules/data"))).toBe(true);
    expect(existsSync(join(f.path, ".turbo/data"))).toBe(true);
    expect(f.store.thread(f.thread.id)!.worktree_shrunk_at).toBeNull();
  });
  it("under pressure drops caches before dependencies and stops at the measured target", async () => {
    const f = setup(); age(f, 2); outputs(f);
    const free = async () => existsSync(join(f.path, ".turbo")) ? 10 : 23;
    const service = f.service({ diskFree: free });
    const result = await service.pressure(false, pressureLimits);
    expect(result.freedBytes).toBe(13);
    expect(existsSync(join(f.path, ".turbo"))).toBe(false);
    expect(existsSync(join(f.path, "node_modules"))).toBe(true);
    expect(readFileSync(join(f.path, "tracked"), "utf8")).toBe("safe");
    expect(f.store.thread(f.thread.id)!.worktree_removed_at).toBeNull();
  });
  it("shrinks a cooled unmerged thread waiting only on a durable trigger, preserving checkpoint/source", async () => {
    const f = setup(); git(f.path, "commit", "--allow-empty", "-qm", "unmerged"); age(f, 2); outputs(f);
    writeFileSync(join(f.path, "tracked"), "dirty source"); const saved = await checkpoint(f.thread);
    vi.spyOn(f.store, "hasPendingWait").mockReturnValue(true);
    const service = f.service({ diskFree: async () => 10 });
    const dry = await service.pressure(true, pressureLimits);
    expect(dry.plans.flatMap(p => p.targets)).toEqual([join(realpathSync(f.path), ".turbo"), join(realpathSync(f.path), "node_modules")]);
    expect(f.store.thread(f.thread.id)!.worktree_shrunk_at).toBeNull();
    expect(existsSync(join(f.path, "node_modules"))).toBe(true);
    await service.pressure(false, pressureLimits);
    expect(existsSync(join(f.path, "node_modules"))).toBe(false);
    expect(readFileSync(join(f.path, "tracked"), "utf8")).toBe("dirty source");
    expect(git(f.repo, "rev-parse", `refs/loom/checkpoints/${f.thread.id}`)).toBe(saved!.commit);
    expect(f.store.thread(f.thread.id)!.worktree_removed_at).toBeNull();
  });
  it("cools an idle host only when it pins reclaimable output, then rechecks cwd processes", async () => {
    const f = setup(); age(f, 2); outputs(f);
    let live = true;
    const cool = vi.fn(async () => { live = false; return true; });
    const service = f.service({ diskFree: async () => 10, live: () => live, cool, cwdProcess: async () => !live });
    await service.pressure(true, pressureLimits); expect(cool).not.toHaveBeenCalled();
    await service.pressure(false, pressureLimits); expect(cool).toHaveBeenCalledOnce();
    expect(existsSync(join(f.path, "node_modules"))).toBe(true);
    // Once the external process goes away, the same cold owner can be shrunk.
    await f.service({ diskFree: async () => 10 }).pressure(false, pressureLimits);
    expect(existsSync(join(f.path, "node_modules"))).toBe(false);
  });
  it("preserves leased, active, recent, unowned and force-added content under pressure", async () => {
    const f = setup(); outputs(f);
    const service = f.service({ diskFree: async () => 10 });
    await service.pressure(false, pressureLimits); // warm floor
    age(f, 2);
    await f.service({ diskFree: async () => 10, leased: () => true }).pressure(false, pressureLimits);
    const run = f.store.tx(() => f.store.createRun(f.thread.id, "user", "new turn"));
    await service.pressure(false, pressureLimits);
    expect(existsSync(join(f.path, ".turbo"))).toBe(true);
    f.store.tx(() => f.store.updateRun(run.id, { status: "completed", ended_at: f.store.now() - 3600_000 }));
    git(f.path, "add", "-f", ".turbo/data", "node_modules/data");
    await service.pressure(false, pressureLimits);
    expect(existsSync(join(f.path, "node_modules", "data"))).toBe(true);
    const unowned = join(f.home, "worktrees", "unknown", "node_modules"); mkdirSync(unowned, { recursive: true });
    await service.pressure(false, pressureLimits); expect(existsSync(unowned)).toBe(true);
  });
  it("a turn arriving during inspection wins, and disk read failures fail closed", async () => {
    const f = setup(); age(f, 2); outputs(f);
    let checks = 0;
    const service = f.service({ diskFree: async () => 10, cwdProcess: async () => {
      if (++checks === 2) f.store.tx(() => f.store.createRun(f.thread.id, "user", "arrived"));
      return false;
    } });
    await service.pressure(false, pressureLimits);
    expect(existsSync(join(f.path, ".turbo"))).toBe(true);
    await expect(f.service({ diskFree: async () => { throw new Error("unavailable"); } }).pressure(false, pressureLimits)).rejects.toThrow("unavailable");
    expect(existsSync(join(f.path, "node_modules"))).toBe(true);
  });
  it("bounds each pass and performs no work when disk is healthy", async () => {
    const f = setup(); age(f, 2); outputs(f);
    expect((await f.service({ diskFree: async () => 25 }).pressure(false, pressureLimits)).plans).toEqual([]);
    await f.service({ diskFree: async () => 10 }).pressure(false, { ...pressureLimits, maxTargets: 1 });
    expect(existsSync(join(f.path, ".turbo"))).toBe(false);
    expect(existsSync(join(f.path, "node_modules"))).toBe(true);
  });
  it("restores a partial nested shrink even while the root install survives", async () => {
    const f = setup(); age(f, 2);
    for (const path of [f.repo, f.path]) {
      writeFileSync(join(path, "package.json"), JSON.stringify({ workspaces: ["apps/*"] }));
      writeFileSync(join(path, "package-lock.json"), "{}");
      mkdirSync(join(path, "apps", "demo"), { recursive: true });
      writeFileSync(join(path, "apps", "demo", "package.json"), "{}");
      git(path, "add", "package.json", "package-lock.json", "apps/demo/package.json");
    }
    for (const dir of ["node_modules", "apps/demo/node_modules"]) {
      mkdirSync(join(f.repo, dir), { recursive: true });
      writeFileSync(join(f.repo, dir, "value"), "restored");
    }
    writeFileSync(join(f.repo, "node_modules/.package-lock.json"), "{}");
    expect(await seedDependencies(f.path, [f.repo])).toBe(true);
    expect(existsSync(join(f.path, "node_modules/.loom-lock"))).toBe(true);
    await f.service({ diskFree: async () => 10 }).pressure(false, { ...pressureLimits, maxTargets: 1 });
    expect(existsSync(join(f.path, "apps/demo/node_modules"))).toBe(false);
    expect(existsSync(join(f.path, "node_modules/value"))).toBe(true);
    expect(existsSync(join(f.path, "node_modules/.loom-lock"))).toBe(false);
    const install = vi.fn(async () => "unexpected install");
    expect(await f.service({ install }).restore(f.store.thread(f.thread.id)!)).toBeNull();
    expect(install).not.toHaveBeenCalled();
    expect(readFileSync(join(f.path, "apps/demo/node_modules/value"), "utf8")).toBe("restored");
    expect(f.store.thread(f.thread.id)!.worktree_shrunk_at).toBeNull();
  });
  it("does not seed a new worktree from its only, partly shrunk sibling", async () => {
    const f = setup(); age(f, 2);
    for (const path of [f.repo, f.path]) {
      writeFileSync(join(path, "package.json"), JSON.stringify({ workspaces: ["apps/*"] }));
      writeFileSync(join(path, "package-lock.json"), "{}");
      mkdirSync(join(path, "apps/demo"), { recursive: true });
      writeFileSync(join(path, "apps/demo/package.json"), "{}");
      git(path, "add", "package.json", "package-lock.json", "apps/demo/package.json");
      git(path, "commit", "-qm", "workspace manifests");
    }
    git(f.repo, "push", "-q", "origin", "main");
    for (const dir of ["node_modules", "apps/demo/node_modules"]) {
      mkdirSync(join(f.path, dir), { recursive: true });
      writeFileSync(join(f.path, dir, "value"), "installed");
    }
    const markers = [".package-lock.json", ".modules.yaml", ".yarn-state.yml", ".yarn-integrity"];
    for (const marker of markers) writeFileSync(join(f.path, "node_modules", marker), "{}");
    await f.service({ diskFree: async () => 10 }).pressure(false, { ...pressureLimits, maxTargets: 1 });
    expect(existsSync(join(f.path, "apps/demo/node_modules"))).toBe(false);
    expect(existsSync(join(f.path, "node_modules/value"))).toBe(true);
    for (const marker of markers) expect(existsSync(join(f.path, "node_modules", marker))).toBe(false);
    const fresh = await createWorktree(f.repo, { id: "bbbbbbbb-0000", worktreesDir: join(f.home, "worktrees") });
    expect(existsSync(join(fresh.path, "node_modules"))).toBe(false);
    // Direct seeding (including restore callers) must also reject the partial install.
    expect(await seedDependencies(fresh.path, [f.path])).toBe(false);
    expect(existsSync(join(fresh.path, "node_modules/.loom-lock"))).toBe(false);
  });
  it.each(["pressure", "reclaim"] as const)("%s leaves the row unchanged when stamp invalidation refuses a symlink", async (mode) => {
    const f = setup(); age(f, 100);
    git(f.path, "commit", "-qm", "unmerged", "--allow-empty");
    mkdirSync(join(f.repo, "node_modules"));
    writeFileSync(join(f.repo, "node_modules/.package-lock.json"), "keep");
    symlinkSync(join(f.repo, "node_modules"), join(f.path, "node_modules"));
    mkdirSync(join(f.path, "apps/demo/node_modules"), { recursive: true });
    writeFileSync(join(f.path, "apps/demo/node_modules/value"), "keep");
    const service = f.service({ diskFree: async () => 10 });
    const result = mode === "pressure" ? await service.pressure(false, pressureLimits) : await service.reclaim(false);
    expect(result.plans.some(p => p.reason.includes("symlinked dependency directory"))).toBe(true);
    expect(f.store.thread(f.thread.id)!.worktree_shrunk_at).toBeNull();
    expect(readFileSync(join(f.repo, "node_modules/.package-lock.json"), "utf8")).toBe("keep");
    expect(existsSync(join(f.path, "apps/demo/node_modules/value"))).toBe(true);
  });
  it("does not invalidate an install stamp through a dependency symlink", async () => {
    const f = setup();
    mkdirSync(join(f.repo, "node_modules"));
    writeFileSync(join(f.repo, "node_modules/.loom-lock"), "keep");
    symlinkSync(join(f.repo, "node_modules"), join(f.path, "node_modules"));
    f.store.tx(() => f.store.updateThread(f.thread.id, { worktree_shrunk_at: f.store.now() }));
    expect(await f.service().restore(f.store.thread(f.thread.id)!)).toContain("symlinked dependency directory");
    expect(readFileSync(join(f.repo, "node_modules/.loom-lock"), "utf8")).toBe("keep");
  });
  it("skips timer ticks while lifecycle work is queued or running and accepts the next tick", async () => {
    const f = setup();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let calls = 0;
    const service = f.service({ mailbox: async (_id, fn) => {
      if (++calls === 1) { entered(); await gate; }
      return fn();
    } });
    const first = service.reclaim(true);
    // The first pass has not started yet; a timer must not enqueue behind it.
    await service.reclaimScheduled(true);
    await started;
    const manual = service.reclaim(true);
    await service.reclaimScheduled(true);
    expect(calls).toBe(1);
    release();
    await Promise.all([first, manual]);
    await service.reclaimScheduled(true);
    expect(calls).toBe(3);
    const entries = readFileSync(join(f.home, "reclaim.log"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(entries.filter(e => e.skipped)).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({ reason: "lifecycle", dryRun: true, skipped: "lifecycle pass pending" })));
    expect(entries.filter(e => e.plans)).toHaveLength(3);
  });

  it("runs pressure between lifecycle rows without overlapping mailbox work", async () => {
    const f = setup(); age(f); outputs(f);
    const secondPath = join(f.home, "worktrees", "repo", "second");
    git(f.repo, "worktree", "add", "-qb", "second", secondPath);
    f.store.tx(() => f.store.createThread({ cwd: secondPath, repo: f.repo, kind: "test", provider: "fake" }));
    const lifecycleOrder = f.store.threads().map(t => t.id);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const order: string[] = [];
    let active = 0;
    let first = true;
    const service = f.service({ diskFree: async () => { order.push("pressure"); return 10; }, mailbox: async (id, fn) => {
      expect(active++).toBe(0);
      order.push(id);
      try {
        if (first) { first = false; entered(); await gate; }
        return await fn();
      } finally { active--; }
    } });
    const lifecycle = service.reclaim(true);
    await started;
    const pressure = service.pressure(true, { ...pressureLimits, maxTargets: 1 });
    expect(order).toEqual([lifecycleOrder[0]]);
    release();
    await Promise.all([lifecycle, pressure]);
    // The pressure pass starts after the first lifecycle row, before the second.
    expect(order.slice(0, 3)).toEqual([lifecycleOrder[0], "pressure", f.thread.id]);
    expect(order.lastIndexOf(lifecycleOrder[1]!)).toBeGreaterThan(order.lastIndexOf("pressure"));
    expect(existsSync(join(f.path, ".turbo"))).toBe(true);
  });

  it("runs an already queued pressure pass before lifecycle inspection", async () => {
    const f = setup();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const mailbox = vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn());
    const service = f.service({ mailbox, diskFree: async () => { entered(); await gate; return 25; } });
    const pressure = service.pressure(true, pressureLimits);
    const lifecycle = service.reclaimScheduled(true);
    await started;
    await service.reclaimScheduled(true);
    expect(mailbox).not.toHaveBeenCalled();
    release();
    await Promise.all([pressure, lifecycle]);
    expect(mailbox).toHaveBeenCalledOnce();
  });

  it("releases scheduling guards after lifecycle and pressure failures", async () => {
    const f = setup();
    let fail = true;
    const service = f.service({ diskFree: async () => { throw new Error("disk unavailable"); }, mailbox: async (_id, fn) => {
      if (fail) { fail = false; throw new Error("mailbox unavailable"); }
      return fn();
    } });
    await expect(service.reclaimScheduled(true)).rejects.toThrow("mailbox unavailable");
    await expect(service.pressure(true, pressureLimits)).rejects.toThrow("disk unavailable");
    expect((await service.reclaimScheduled(true))?.plans).toHaveLength(1);
  });

  it("records total lifecycle duration and only the five slowest rows, including mailbox time", async () => {
    const f = setup();
    for (let i = 0; i < 5; i++) {
      const cwd = join(f.home, "worktrees", "repo", `timing-${i}`); mkdirSync(cwd);
      f.store.tx(() => f.store.createThread({ cwd, repo: f.repo, kind: "test", provider: "fake" }));
    }
    let now = 0;
    let row = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const service = f.service({ mailbox: async (_id, fn) => { now += ++row * 100; return fn(); } });
      const result = await service.reclaim(true);
      expect(result.durationMs).toBe(2100);
      expect(result.queuedMs).toBe(0);
      expect(result.slowestRows.map(r => r.durationMs)).toEqual([600, 500, 400, 300, 200]);
      expect(new Set(result.slowestRows.map(r => r.thread)).size).toBe(5);
      expect(JSON.parse(readFileSync(join(f.home, "reclaim.log"), "utf8"))).toMatchObject({ durationMs: 2100, slowestRows: result.slowestRows });
    } finally { clock.mockRestore(); }
  });

  it("logs every lifecycle dry run with target paths and unmeasured size without mutation", async () => {
    const f = setup(); age(f); outputs(f);
    const service = f.service({ gh: mergedPr(f) });
    const before = f.store.thread(f.thread.id);
    const first = await service.reclaim(true);
    const second = await service.reclaim(true);
    const entries = readFileSync(join(f.home, "reclaim.log"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(entries).toHaveLength(2);
    for (const [index, result] of [first, second].entries()) {
      expect(entries[index]).toEqual({ at: expect.any(String), reason: "lifecycle", ...result });
      expect(Number.isFinite(Date.parse(entries[index].at))).toBe(true);
      expect(result.plans[0]).toMatchObject({ action: "remove", size: null, targets: expect.arrayContaining([join(realpathSync(f.path), "node_modules")]) });
      expect(result.freedBytes).toBe(0);
    }
    expect(f.store.thread(f.thread.id)).toEqual(before);
    expect(readFileSync(join(f.path, "node_modules/data"), "utf8")).toBe("regenerable");
    expect(statSync(join(f.home, "reclaim.log")).mode & 0o777).toBe(0o600);
  });
  it.each(["lifecycle", "pressure", "heartbeat"])("rotates %s evidence at 10 MiB, retaining only one private backup", async mode => {
    const f = setup();
    const path = join(f.home, "reclaim.log");
    const service = f.service({ diskFree: async () => 10 });
    const write = () => mode === "lifecycle" ? service.reclaim(true)
      : mode === "pressure" ? service.pressure(true, pressureLimits)
      : service.logPressureSkipped(20, 15, true);
    writeFileSync(path, "old record\n", { mode: 0o644 });
    truncateSync(path, 10 * 1024 * 1024);
    writeFileSync(`${path}.1`, "obsolete backup");
    await write();
    expect(statSync(`${path}.1`).size).toBe(10 * 1024 * 1024);
    expect(readFileSync(`${path}.1`, "utf8").startsWith("old record\n")).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ dryRun: true });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}.1`).mode & 0o777).toBe(0o600);
    expect(existsSync(`${path}.2`)).toBe(false);
  });
  it("logs even an empty lifecycle dry-run pass", async () => {
    const f = setup();
    f.store.tx(() => f.store.updateThread(f.thread.id, { cwd: f.repo }));
    rmSync(f.path, { recursive: true });
    const result = await f.service().reclaim(true);
    expect(JSON.parse(readFileSync(join(f.home, "reclaim.log"), "utf8"))).toMatchObject({ dryRun: true, plans: result.plans, freedBytes: 0 });
  });
  it.each([true, false])("rate limits healthy pressure evidence without scanning (dryRun=%s)", async dryRun => {
    const f = setup(); age(f, 2); outputs(f);
    const started = f.store.now();
    let now = started, free = 20;
    f.store.now = () => now;
    const mailbox = vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn());
    const service = f.service({ diskFree: async () => free, mailbox });
    await service.pressure(dryRun, pressureLimits);
    now += 299_999; free = 30;
    await service.pressure(dryRun, pressureLimits);
    let lines = readFileSync(join(f.home, "reclaim.log"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ at: new Date(started).toISOString(), reason: "disk pressure", dryRun, freeBytes: 20, floorBytes: 20, skipped: "above floor" });
    now++;
    await service.pressure(dryRun, pressureLimits);
    lines = readFileSync(join(f.home, "reclaim.log"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1])).toMatchObject({ freeBytes: 30, at: new Date(now).toISOString() });
    expect(mailbox).not.toHaveBeenCalled();
    expect(existsSync(join(f.path, "node_modules/data"))).toBe(true);
    // The heartbeat throttle must never suppress a low-disk plan.
    free = 10;
    await service.pressure(true, pressureLimits);
    lines = readFileSync(join(f.home, "reclaim.log"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]).plans.length).toBeGreaterThan(0);
  });
  it("retries a failed heartbeat write and coalesces concurrent ticks", async () => {
    const f = setup();
    const service = f.service();
    mkdirSync(join(f.home, "reclaim.log"));
    await expect(service.logPressureSkipped(30, 20, true)).rejects.toThrow();
    rmSync(join(f.home, "reclaim.log"), { recursive: true });
    await Promise.all(Array.from({ length: 10 }, () => service.logPressureSkipped(30, 20, true)));
    const entries = readFileSync(join(f.home, "reclaim.log"), "utf8").trim().split("\n");
    expect(entries).toHaveLength(1);
  });
  it("records healthy host ticks without calling the reclaim scanner", async () => {
    const f = setup();
    let now = f.store.now();
    f.store.now = () => now;
    const host = new LoomHost(f.store, { fake: new FakeRuntime(f.store) }, {
      loomHome: f.home,
      pressure: async () => ({ memory: { totalBytes: 64 * 1024 ** 3, freePct: 80 }, disk: { totalBytes: 1000 * 1024 ** 3, freeBytes: 100 * 1024 ** 3 } }),
    }); hosts.push(host);
    vi.stubEnv("LOOM_WORKTREE_RECLAIM", "off");
    const probe = vi.spyOn(host.worktrees!, "pressure");
    await host.checkDiskPressure();
    await host.checkDiskPressure();
    now += 300_000;
    await host.checkDiskPressure();
    const entries = readFileSync(join(f.home, "reclaim.log"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ at: new Date(now).toISOString(), dryRun: true, freeBytes: 100 * 1024 ** 3, floorBytes: (host.limits().minFreeDiskGB + 5) * 1024 ** 3, skipped: "above floor" });
    expect(probe).not.toHaveBeenCalled();
  });
  it("logs dry-run plans and preserves build outputs", async () => {
    const f = setup(); age(f, 2); outputs(f);
    mkdirSync(join(f.path, "dist")); writeFileSync(join(f.path, "dist/output"), "build");
    const service = f.service({ diskFree: async () => 10 });
    const dry = await service.pressure(true, pressureLimits);
    expect(JSON.parse(readFileSync(join(f.home, "reclaim.log"), "utf8"))).toMatchObject({ dryRun: true, plans: dry.plans });
    await service.pressure(false, pressureLimits);
    expect(readFileSync(join(f.path, "dist/output"), "utf8")).toBe("build");
  });
  it("retains deletion evidence when a later mailbox fails", async () => {
    const f = setup(); age(f, 2); outputs(f);
    let calls = 0;
    const result = await f.service({ diskFree: async () => 10, mailbox: async (_id, fn) => {
      if (++calls === 2) throw new Error("vanished cwd");
      return fn();
    } }).pressure(false, pressureLimits);
    expect(result.plans.some(p => p.targets.includes(join(realpathSync(f.path), ".turbo")))).toBe(true);
    expect(result.plans.some(p => p.reason.includes("vanished cwd"))).toBe(true);
    expect(JSON.parse(readFileSync(join(f.home, "reclaim.log"), "utf8"))).toMatchObject({ plans: result.plans });
  });
  it("restores cold dependencies with real copy-on-write clones and keeps writes isolated", async () => {
    const f = setup();
    for (const path of [f.repo, f.path]) {
      writeFileSync(join(path, "package.json"), "{}"); writeFileSync(join(path, "package-lock.json"), "{}");
    }
    mkdirSync(join(f.repo, "node_modules"));
    writeFileSync(join(f.repo, "node_modules", ".package-lock.json"), "{}");
    writeFileSync(join(f.repo, "node_modules", "value"), "donor");
    f.store.tx(() => f.store.updateThread(f.thread.id, { worktree_shrunk_at: f.store.now() }));
    const install = vi.fn(async () => null);
    const started = performance.now();
    await f.service({ install }).restore(f.store.thread(f.thread.id)!);
    expect(install).not.toHaveBeenCalled();
    expect(readFileSync(join(f.path, "node_modules", "value"), "utf8")).toBe("donor");
    writeFileSync(join(f.path, "node_modules", "value"), "changed");
    expect(readFileSync(join(f.repo, "node_modules", "value"), "utf8")).toBe("donor");
    expect(f.store.thread(f.thread.id)!.worktree_shrunk_at).toBeNull();
    console.log(`isolated clone restore: ${Math.round(performance.now() - started)}ms`);
  });
  it("falls back to install after mismatched locks or failed cloning and retries failed installs", async () => {
    const f = setup();
    writeFileSync(join(f.path, "package-lock.json"), "{}"); writeFileSync(join(f.repo, "package-lock.json"), '{"different":true}');
    f.store.tx(() => f.store.updateThread(f.thread.id, { worktree_shrunk_at: f.store.now() }));
    const install = vi.fn(async () => "install unavailable");
    expect(await f.service({ install }).restore(f.store.thread(f.thread.id)!)).toContain("install unavailable");
    expect(install).toHaveBeenCalledOnce();
    expect(f.store.thread(f.thread.id)!.worktree_shrunk_at).not.toBeNull();
    const fallback = vi.fn(async () => null);
    await f.service({ seed: async () => { throw new Error("clone failed"); }, install: fallback }).restore(f.store.thread(f.thread.id)!);
    expect(fallback).toHaveBeenCalledOnce();
    expect(f.store.thread(f.thread.id)!.worktree_shrunk_at).toBeNull();
  });

  it("measures real filesystem free-space deltas in an isolated reclaim", async () => {
    const f = setup(); age(f, 2); outputs(f);
    writeFileSync(join(f.path, ".turbo", "data"), Buffer.alloc(8 * 1024 * 1024, 97));
    const result = await f.service().pressure(false, { ...pressureLimits, floorBytes: Number.MAX_SAFE_INTEGER, targetBytes: Number.MAX_SAFE_INTEGER });
    expect(result.freedBytes).toBe(result.afterBytes - result.beforeBytes);
    expect(existsSync(join(f.path, ".turbo"))).toBe(false);
    console.log(`isolated pressure reclaim df delta: ${result.freedBytes} bytes (concurrent filesystem activity may affect it)`);
  });
  it("runs real npm ci when no matching clone donor exists", async () => {
    const f = setup();
    writeFileSync(join(f.path, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { install: "node -e \"require('fs').writeFileSync('ci-ran','yes')\"" } }));
    writeFileSync(join(f.path, "package-lock.json"), JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0", hasInstallScript: true } } }));
    f.store.tx(() => f.store.updateThread(f.thread.id, { worktree_shrunk_at: f.store.now() }));
    expect(await f.service().restore(f.store.thread(f.thread.id)!)).toBeNull();
    expect(readFileSync(join(f.path, "ci-ran"), "utf8")).toBe("yes");
  });

  it("selects the least recently used eligible checkout first", async () => {
    const f = setup(); age(f, 2); outputs(f);
    const newer = join(f.home, "worktrees", "repo", "loom-newer");
    git(f.repo, "worktree", "add", "-qb", "newer", newer);
    const now = f.store.now(); f.store.now = () => now - 3600_000;
    f.store.tx(() => f.store.createThread({ cwd: newer, repo: f.repo, provider: "fake", kind: "test" })); f.store.now = () => now;
    mkdirSync(join(newer, ".turbo")); writeFileSync(join(newer, ".turbo", "data"), "keep");
    await f.service({ diskFree: async () => existsSync(join(f.path, ".turbo")) ? 10 : 23 }).pressure(false, pressureLimits);
    expect(existsSync(join(f.path, ".turbo"))).toBe(false);
    expect(existsSync(join(newer, ".turbo", "data"))).toBe(true);
  });
  it("never replaces force-added dependency files during restore", async () => {
    const f = setup(); outputs(f); git(f.path, "add", "-f", "node_modules/data");
    f.store.tx(() => f.store.updateThread(f.thread.id, { worktree_shrunk_at: f.store.now() }));
    const seed = vi.fn(async () => true), install = vi.fn(async () => null);
    expect(await f.service({ seed, install }).restore(f.store.thread(f.thread.id)!)).toContain("tracked dependency files");
    expect(seed).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled();
    expect(readFileSync(join(f.path, "node_modules", "data"), "utf8")).toBe("regenerable");
  });

  it("the host pressure tick cools an eligible idle session and respects dry-run/backoff", async () => {
    const f = setup(); outputs(f);
    const runtime = new FakeRuntime(f.store);
    let now = f.store.now(), bytes = 100 * 1024 ** 3;
    f.store.now = () => now;
    const host = new LoomHost(f.store, { fake: runtime }, { loomHome: f.home, pressure: async () => ({ memory: { totalBytes: 64 * 1024 ** 3, freePct: 80 }, disk: { totalBytes: 1000 * 1024 ** 3, freeBytes: bytes } }) }); hosts.push(host);
    await host.execute({ type: "submit", commandId: "pressure-open", threadId: f.thread.id, text: "go" });
    runtime.last.complete(); await host.kick(f.thread.id);
    now += 700_000; bytes = 23 * 1024 ** 3;
    // The actual host/process safety check is exercised separately; the fake harness
    // has no OS process and unrelated test runners must not affect this fixture.
    const probe = vi.spyOn(host.worktrees!, "pressure");
    vi.stubEnv("LOOM_WORKTREE_RECLAIM", "off");
    await host.checkDiskPressure();
    expect(probe).toHaveBeenCalledOnce(); expect(probe.mock.calls[0][0]).toBe(true);
    expect(host.hasSession(f.thread.id)).toBe(true);
    expect(existsSync(join(f.path, "node_modules"))).toBe(true);
    await host.checkDiskPressure(); expect(probe).toHaveBeenCalledOnce();
    now += 300_001;
    vi.stubEnv("LOOM_WORKTREE_RECLAIM", "on");
    await host.checkDiskPressure();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(host.hasSession(f.thread.id)).toBe(false);
    expect(existsSync(join(f.path, "node_modules"))).toBe(false);
    expect(existsSync(join(f.path, "tracked"))).toBe(true);
    // No-progress pass backs off, and recovery above the buffer does no scanning.
    now += 300_001; bytes = 30 * 1024 ** 3;
    await host.checkDiskPressure(); expect(probe).toHaveBeenCalledTimes(2);
  });

  it("preserves a checkout with a resource lease even when cwd discovery finds no process", async () => {
    const f = setup(); age(f, 100);
    git(f.path, "commit", "-qm", "unmerged", "--allow-empty");
    const plans = await f.service({ leased: () => true }).list();
    expect(plans[0]).toMatchObject({ action: "keep" });
    expect(existsSync(f.path)).toBe(true);
  });

  it("removes a squash-merged unsettled branch after run idle, releases its warm session, and restores", async () => {
    const f = setup(); git(f.path, "commit", "-qm", "squashed elsewhere", "--allow-empty"); age(f);
    let live = true;
    const gh = vi.fn(mergedPr(f));
    const release = vi.fn(async () => { live = false; });
    const service = f.service({ gh, live: () => live, release, install: async () => null });
    expect((await service.reclaim(true)).plans[0]).toMatchObject({ action: "remove", reason: "merged PR #42, idle 31h" });
    expect(release).not.toHaveBeenCalled();
    expect((await service.reclaim(false)).plans[0]?.action).toBe("remove");
    expect(gh).toHaveBeenCalledTimes(2); // one lookup per pass, including reinspection
    expect(gh).toHaveBeenCalledWith(["pr", "list", "--state", "merged", "--head", "loom/abcdef01", "--json", "number,mergedAt,headRefOid", "--limit", "1"], f.repo);
    expect(release).toHaveBeenCalledOnce();
    expect(f.store.thread(f.thread.id)!.settled_at).toBeNull();
    expect(f.store.thread(f.thread.id)!.worktree_removed_at).not.toBeNull();
    expect(git(f.repo, "branch", "--list", "loom/abcdef01")).toContain("loom/abcdef01");
    await service.restore(f.store.thread(f.thread.id)!);
    expect(existsSync(f.path)).toBe(true);
    expect(git(f.path, "log", "-1", "--format=%s")).toBe("squashed elsewhere");
  });

  it("recreates a worktree removed outside Loom from its branch", async () => {
    const f = setup(); git(f.path, "commit", "-qm", "kept on the branch", "--allow-empty");
    git(f.repo, "worktree", "remove", "--force", f.path);
    expect(await f.service({ install: async () => null }).restore(f.store.thread(f.thread.id)!)).toBeNull();
    expect(git(f.path, "log", "-1", "--format=%s")).toBe("kept on the branch");
    expect(f.store.thread(f.thread.id)!.worktree_removed_at).toBeNull();
  });

  it("clears a half-written checkout when recreation fails, so the retry starts clean", async () => {
    const f = setup(); git(f.path, "commit", "-qm", "kept on the branch", "--allow-empty");
    git(f.repo, "worktree", "remove", "--force", f.path);
    // A failing post-checkout hook stands in for a killed checkout: the worktree exists but `worktree add` fails.
    const hooks = join(f.root, "hooks"); mkdirSync(hooks);
    writeFileSync(join(hooks, "post-checkout"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    git(f.repo, "config", "core.hooksPath", hooks);
    const service = f.service({ install: async () => null });
    await expect(service.restore(f.store.thread(f.thread.id)!)).rejects.toThrow("Loom worktree recreation failed");
    expect(existsSync(f.path)).toBe(false);
    expect(git(f.repo, "worktree", "list")).not.toContain("loom-abcdef01");
    git(f.repo, "config", "--unset", "core.hooksPath");
    expect(await service.restore(f.store.thread(f.thread.id)!)).toBeNull();
    expect(git(f.path, "log", "-1", "--format=%s")).toBe("kept on the branch");
  });

  it("comes back detached at its saved HEAD when another checkout holds its branch", async () => {
    const f = setup(); git(f.path, "commit", "-qm", "thread work", "--allow-empty");
    const head = git(f.path, "rev-parse", "HEAD");
    f.store.tx(() => f.store.updateThread(f.thread.id, { worktree_removed_at: f.store.now(), worktree_branch: "loom/abcdef01", worktree_head: head }));
    git(f.repo, "worktree", "remove", "--force", f.path);
    // The owner's own checkout takes the branch back while the thread's worktree is gone.
    git(f.repo, "checkout", "-q", "loom/abcdef01");
    expect(await f.service({ install: async () => null }).restore(f.store.thread(f.thread.id)!)).toBeNull();
    expect(git(f.path, "rev-parse", "HEAD")).toBe(head);
    expect(git(f.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(git(f.repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("loom/abcdef01");
    expect(f.store.thread(f.thread.id)!.worktree_removed_at).toBeNull();
  });

  it("does not replay a checkpoint older than the branch's newer commits", async () => {
    const f = setup(); const service = f.service({ install: async () => null });
    writeFileSync(join(f.path, "tracked"), "checkpointed"); await checkpoint(f.store.thread(f.thread.id)!);
    git(f.path, "checkout", "--", "tracked"); writeFileSync(join(f.path, "tracked"), "committed later"); git(f.path, "commit", "-qam", "later");
    git(f.repo, "worktree", "remove", "--force", f.path);
    await service.restore(f.store.thread(f.thread.id)!);
    expect(readFileSync(join(f.path, "tracked"), "utf8")).toBe("committed later");
  });

  it("keeps work committed on the branch after its PR merged", async () => {
    const f = setup(); git(f.path, "commit", "-qm", "merged", "--allow-empty");
    const merged = git(f.path, "rev-parse", "HEAD");
    git(f.path, "commit", "-qm", "follow-up", "--allow-empty"); age(f);
    expect((await f.service({ gh: mergedPr(f, merged) }).reclaim(false)).plans[0]).toMatchObject({ action: "keep", reason: "unmerged, idle 31h" });
  });

  it("keeps a squash-merged branch idle only two hours", async () => {
    const f = setup(); git(f.path, "commit", "-qm", "local", "--allow-empty"); age(f, 2);
    expect((await f.service({ gh: mergedPr(f) }).reclaim(false)).plans[0]).toMatchObject({ action: "keep", reason: "merged PR #42, idle 2h" });
  });

  it("honors the configured finished idle threshold and requires a clean merged checkout", async () => {
    const f = setup(); git(f.path, "commit", "-qm", "local", "--allow-empty"); age(f, 2);
    vi.stubEnv("LOOM_WORKTREE_FINISHED_IDLE_HOURS", "1");
    writeFileSync(join(f.path, "unsaved"), "keep");
    expect((await f.service({ gh: mergedPr(f) }).reclaim(true)).plans[0]?.action).toBe("keep");
    rmSync(join(f.path, "unsaved"));
    expect((await f.service({ gh: mergedPr(f) }).reclaim(false)).plans[0]?.action).toBe("remove");
  });

  it.each(["request", "brief", "wait"])("keeps merged work held by an open %s", async hold => {
    const f = setup(); age(f);
    f.store.tx(() => {
      if (hold === "request") f.store.openRequest(f.thread.id, null, "question", {});
      if (hold === "brief") f.store.db.prepare("INSERT INTO decisions (id,thread_id,class,level,candidate,status,ask,brief,created_at) VALUES ('D-test',?,'ops',2,0,'open','ask','{}',?)").run(f.thread.id, f.store.now());
      if (hold === "wait") f.store.db.prepare("INSERT INTO triggers (id,thread_id,kind,spec,note,dedup_key,created_at,expires_at,status) VALUES ('wait',?,'time','{}','','wait',?,?,'waiting')").run(f.thread.id, f.store.now(), f.store.now() + 1000);
    });
    expect((await f.service({ gh: mergedPr(f) }).reclaim(false)).plans[0]).toMatchObject({ action: "keep", reason: hold === "brief" ? "open brief" : hold === "wait" ? "pending wait" : "open request" });
  });

  it("removes a never-used tree using created time despite a recent thread update", async () => {
    const f = setup(); f.store.now = () => f.thread.created_at + 40 * 3600_000;
    f.store.tx(() => f.store.touchThread(f.thread.id));
    expect((await f.service({ gh: async () => "[]" }).reclaim(false)).plans[0]).toMatchObject({ action: "remove", reason: "never used, idle 40h" });
  });

  it("keeps dirty never-used trees, including untracked files", async () => {
    const f = setup(); age(f, 40); writeFileSync(join(f.path, "unsaved"), "keep");
    expect((await f.service({ gh: async () => "[]" }).reclaim(false)).plans[0]).toMatchObject({ action: "keep", reason: "dirty checkout, never used" });
  });

  it("keeps even an ancestor when the PR lookup is unavailable", async () => {
    const f = setup(); age(f);
    expect((await f.service({ gh: async () => { throw new Error("offline"); } }).reclaim(false)).plans[0]).toMatchObject({ action: "keep", merged: true, reason: "never used, idle 31h; pr lookup unavailable" });
  });

  it("keeps a recently settled merged tree even after long run idle", async () => {
    const f = setup(); age(f, 48);
    f.store.tx(() => f.store.updateThread(f.thread.id, { settled_at: f.store.now() }));
    expect((await f.service({ gh: mergedPr(f) }).reclaim(false)).plans[0]?.action).toBe("keep");
    const settled = f.store.now();
    f.store.now = () => settled + 24 * 3600_000;
    expect((await f.service().reclaim(false)).plans[0]?.action).toBe("keep");
    f.store.now = () => settled + 24 * 3600_000 + 1;
    expect((await f.service().reclaim(false)).plans[0]?.action).toBe("remove");
  });

  it("keeps a stopped tree until its last activity passes the delay", async () => {
    const f = setup(); age(f, 2);
    f.store.tx(() => f.store.updateThread(f.thread.id, { status: "stopped" }));
    expect((await f.service().reclaim(false)).plans[0]?.action).toBe("keep");
    const now = f.store.now(); f.store.now = () => now + 24 * 3600_000;
    expect((await f.service().reclaim(false)).plans[0]?.action).toBe("remove");
  });

  it("uses the configured delay and later activity for settled trees", async () => {
    const f = setup();
    f.store.tx(() => f.store.updateThread(f.thread.id, { settled_at: f.store.now() - 48 * 3600_000 }));
    age(f, 2);
    vi.stubEnv("LOOM_WORKTREE_FINISHED_IDLE_HOURS", "3");
    expect((await f.service().reclaim(false)).plans[0]?.action).toBe("keep");
    vi.stubEnv("LOOM_WORKTREE_FINISHED_IDLE_HOURS", "1");
    expect((await f.service().reclaim(false)).plans[0]?.action).toBe("remove");
  });

  it("keeps settled dirty worktrees without changing their index, branch, or files", async () => {
    const f = setup(); f.store.tx(() => f.store.updateThread(f.thread.id, { settled_at: Date.now() })); age(f);
    const head = git(f.path, "rev-parse", "HEAD");
    writeFileSync(join(f.path, "unsaved"), "checkpoint me");
    writeFileSync(join(f.path, "tracked"), "staged"); git(f.path, "add", "tracked");
    writeFileSync(join(f.path, "tracked"), "latest working copy");
    for (const dryRun of [true, false]) {
      expect((await f.service().reclaim(dryRun)).plans[0]).toMatchObject({ action: "keep", reason: "dirty checkout, never used" });
      expect(readFileSync(join(f.path, "unsaved"), "utf8")).toBe("checkpoint me");
      expect(readFileSync(join(f.path, "tracked"), "utf8")).toBe("latest working copy");
      expect(git(f.path, "show", ":tracked")).toBe("staged");
      expect(git(f.repo, "rev-parse", "loom/abcdef01")).toBe(head);
    }
  });

  it("archives ignored setup with private permissions and excludes regenerable files", async () => {
    const f = setup();
    writeFileSync(join(f.path, ".gitignore"), readFileSync(join(f.path, ".gitignore"), "utf8") + ".env\n");
    writeFileSync(join(f.path, ".env"), "SYNTHETIC_TEST_VALUE=example");
    mkdirSync(join(f.path, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(f.path, "node_modules/pkg/cache"), "regenerate");
    git(f.path, "add", "-A"); git(f.path, "commit", "-qm", "fixture");
    git(f.repo, "merge", "--ff-only", "loom/abcdef01");
    git(f.repo, "push", "origin", "main");
    f.store.tx(() => f.store.updateThread(f.thread.id, { settled_at: Date.now() }));
    age(f); // Settled trees now observe the same finished-idle delay.
    expect((await f.service().reclaim(false)).plans[0]?.action).toBe("remove");
    const archive = f.store.thread(f.thread.id)!.worktree_archive!;
    expect(archive).toBe(join(f.home, "checkpoints", f.thread.id + ".tar.gz"));
    expect(statSync(archive).mode & 0o777).toBe(0o600);
    expect(execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim()).toBe(".env");
  });

  it("keeps more than 100 MB of ignored non-cache data", async () => {
    const f = setup();
    writeFileSync(join(f.path, ".gitignore"), "local-data\n");
    writeFileSync(join(f.path, "local-data"), "");
    truncateSync(join(f.path, "local-data"), 100 * 1024 * 1024 + 1);
    git(f.path, "add", "-A"); git(f.path, "commit", "-qm", "fixture");
    git(f.repo, "merge", "--ff-only", "loom/abcdef01");
    git(f.repo, "push", "origin", "main");
    f.store.tx(() => f.store.updateThread(f.thread.id, { settled_at: Date.now() }));
    age(f); // Settled trees now observe the same finished-idle delay.
    expect((await f.service().reclaim(false)).plans[0]).toMatchObject({ action: "keep", reason: "large ignored files" });
    expect(existsSync(f.path)).toBe(true);
    expect(f.store.thread(f.thread.id)!.worktree_removed_at).toBeNull();
  });

  it("recreates a settled thread on submit before opening its session", async () => {
    vi.stubEnv("npm_config_offline", "true");
    const f = setup();
    git(f.path, "checkout", "-qb", "feature/resume");
    writeFileSync(join(f.path, ".gitignore"), ".env\nnode_modules/\n");
    writeFileSync(join(f.path, ".env"), "SYNTHETIC_TEST_VALUE=example");
    writeFileSync(join(f.path, "unsaved"), "committed fixture");
    rmSync(join(f.path, "tracked"));
    writeFileSync(join(f.path, "package.json"), JSON.stringify({ scripts: { install: "node -e \"require('fs').writeFileSync('installed','yes')\"" } }));
    git(f.path, "add", "-A"); git(f.path, "commit", "-qm", "fixture");
    git(f.repo, "merge", "--ff-only", "feature/resume");
    git(f.repo, "push", "origin", "main");
    f.store.tx(() => f.store.updateThread(f.thread.id, { settled_at: Date.now() }));
    age(f); // Settled trees now observe the same finished-idle delay.
    await f.service().reclaim(false);
    expect(existsSync(f.path)).toBe(false);
    expect(f.store.thread(f.thread.id)!.worktree_branch).toBe("feature/resume");
    const runtime = new FakeRuntime();
    const open = vi.spyOn(runtime, "open").mockImplementation(async (options, emit) => {
      expect(options.cwd).toBe(f.path);
      expect(readFileSync(join(f.path, "unsaved"), "utf8")).toBe("committed fixture");
      expect(readFileSync(join(f.path, ".env"), "utf8")).toBe("SYNTHETIC_TEST_VALUE=example");
      expect(existsSync(join(f.path, "installed"))).toBe(true);
      return original(options, emit);
    });
    const original = FakeRuntime.prototype.open.bind(runtime);
    const host = new LoomHost(f.store, { fake: runtime }, { loomHome: f.home }); hosts.push(host);
    await host.execute({ type: "submit", commandId: "resume", threadId: f.thread.id, text: "again" });
    expect(open).toHaveBeenCalledOnce();
    expect(runtime.last.turns[0]?.text).toBe("again");
    expect(git(f.path, "branch", "--show-current")).toBe("feature/resume");
    expect(existsSync(join(f.path, "tracked"))).toBe(false);
    expect(git(f.path, "diff", "--cached")).toBe("");
    expect(git(f.path, "status", "--porcelain")).not.toContain("unsaved");
    expect(f.store.thread(f.thread.id)!.worktree_removed_at).toBeNull();
  }, 30_000);

  it("restores detached HEAD; a failed install is a note for the turn, not a failure, and is retried next time", async () => {
    const f = setup(); git(f.path, "checkout", "--detach");
    const head = git(f.path, "rev-parse", "HEAD");
    f.store.tx(() => f.store.updateThread(f.thread.id, { settled_at: Date.now() }));
    age(f); // Settled trees now observe the same finished-idle delay.
    await f.service().reclaim(false);
    expect(f.store.thread(f.thread.id)).toMatchObject({ worktree_branch: null, worktree_head: head });
    const note = await f.service({ install: async () => "failed" }).restore(f.store.thread(f.thread.id)!);
    expect(note).toContain("dependency install failed");
    expect(git(f.path, "rev-parse", "HEAD")).toBe(head);
    expect(git(f.path, "branch", "--show-current")).toBe("");
    // The checkout is back; the install is retried before the next turn.
    expect(f.store.thread(f.thread.id)).toMatchObject({ worktree_removed_at: null });
    expect(f.store.thread(f.thread.id)!.worktree_shrunk_at).not.toBeNull();
    expect(await f.service({ install: async () => null }).restore(f.store.thread(f.thread.id)!)).toBeNull();
  });

  it("fails the run without opening a session when recreation fails", async () => {
    const f = setup();
    f.store.tx(() => f.store.updateThread(f.thread.id, { settled_at: Date.now() }));
    age(f); // Settled trees now observe the same finished-idle delay.
    await f.service().reclaim(false);
    git(f.repo, "branch", "-D", "loom/abcdef01");
    const runtime = new FakeRuntime();
    const host = new LoomHost(f.store, { fake: runtime }, { loomHome: f.home }); hosts.push(host);
    const result = await host.execute({ type: "submit", commandId: "broken", threadId: f.thread.id, text: "again" });
    expect(f.store.run(result.runId!)?.status).toBe("failed");
    expect(f.store.run(result.runId!)?.failure).toContain("Loom worktree recreation failed");
    expect(runtime.sessions).toHaveLength(0);
    expect(existsSync(f.path)).toBe(false);
  });

  it("keeps unmerged local commits even when origin's branch is merged", async () => {
    const f = setup(); git(f.path, "push", "-q", "origin", "HEAD");
    git(f.path, "commit", "-qm", "local only", "--allow-empty");
    f.store.tx(() => f.store.updateThread(f.thread.id, { settled_at: Date.now() }));
    expect((await f.service().reclaim(false)).plans[0]?.action).toBe("keep"); expect(existsSync(f.path)).toBe(true);
  });

  it("keeps live hosts, cwd processes, and queued runs", async () => {
    const f = setup(); f.store.tx(() => f.store.updateThread(f.thread.id, { settled_at: Date.now() }));
    age(f); // Settled trees now observe the same finished-idle delay.
    for (const options of [{ live: () => true }, { cwdProcess: async () => true }]) expect((await f.service(options).reclaim(false)).plans[0]?.action).toBe("keep");
    f.store.tx(() => f.store.createRun(f.thread.id, "user", "queued"));
    expect((await f.service().reclaim(false)).plans[0]?.action).toBe("keep");
  });

  it.each(["settled", "stopped"])("reclaims a parent's checkout once its borrowed probe is %s", async (state) => {
    const f = setup();
    const probe = f.store.tx(() => {
      f.store.updateThread(f.thread.id, { settled_at: f.store.now() });
      const probe = f.store.createThread({ kind: "probe", cwd: f.path, repo: f.repo, provider: "fake" });
      f.store.updateThread(probe.id, state === "settled" ? { settled_at: f.store.now() } : { status: "stopped" });
      return probe;
    });
    age(f);
    const service = f.service();
    expect(await service.list()).toMatchObject([{ thread: f.thread.id, action: "remove" }]);
    expect(await service.count()).toBe(1);
    expect((await service.reclaim(false)).plans.filter(plan => plan.thread !== null)).toMatchObject([{ thread: f.thread.id, action: "remove" }]);
    expect(existsSync(f.path)).toBe(false);
    expect(f.store.thread(probe.id)!.worktree_removed_at).toBeNull();
  });

  it.each(["unsettled", "queued", "running", "live"])("keeps a parent's checkout for a %s probe", async (state) => {
    const f = setup();
    const probe = f.store.tx(() => {
      f.store.updateThread(f.thread.id, { settled_at: f.store.now() });
      const probe = f.store.createThread({ kind: "probe", cwd: f.path, repo: f.repo, provider: "fake" });
      // Even a settled probe must hold the checkout if it still has work or a host.
      if (state !== "unsettled") f.store.updateThread(probe.id, { settled_at: f.store.now() });
      if (state === "queued" || state === "running") {
        const run = f.store.createRun(probe.id, "user", "probe");
        if (state === "running") f.store.updateRun(run.id, { status: "running", started_at: f.store.now() });
      }
      return probe;
    });
    const release = vi.fn(async () => {});
    const service = f.service({ release, live: id => state === "live" && id === probe.id });
    expect(await service.list()).toMatchObject([{ thread: f.thread.id, action: "keep" }]);
    expect((await service.reclaim(false)).plans).toMatchObject([{ thread: f.thread.id, action: "keep" }]);
    expect(release).not.toHaveBeenCalled();
    expect(existsSync(f.path)).toBe(true);
  });

  it("rechecks probe borrowers queued while inspecting the parent's checkout", async () => {
    const f = setup();
    f.store.tx(() => f.store.updateThread(f.thread.id, { settled_at: f.store.now() }));
    age(f); // Settled trees now observe the same finished-idle delay.
    const service = f.service({ gh: async () => {
      f.store.tx(() => {
        const probe = f.store.createThread({ kind: "probe", cwd: f.path, repo: f.repo, provider: "fake" });
        f.store.createRun(probe.id, "user", "probe");
      });
      return "[]";
    } });
    expect((await service.reclaim(false)).plans).toMatchObject([{ thread: f.thread.id, action: "keep", reason: "became busy" }]);
    expect(existsSync(f.path)).toBe(true);
  });

  it("keeps threads with an open question or running turn", async () => {
    const f = setup(); f.store.tx(() => f.store.updateThread(f.thread.id, { settled_at: Date.now() }));
    age(f); // Settled trees now observe the same finished-idle delay.
    const question = f.store.tx(() => f.store.openRequest(f.thread.id, null, "question", { text: "answer?" }));
    expect((await f.service().reclaim(false)).plans[0]?.action).toBe("keep");
    f.store.tx(() => {
      f.store.resolveRequest(question.id, "expired", undefined);
      const run = f.store.createRun(f.thread.id, "user", "running");
      f.store.updateRun(run.id, { status: "running", started_at: Date.now() });
    });
    expect((await f.service().reclaim(false)).plans[0]?.action).toBe("keep");
  });

  it("does not remove a registered row pointing at an unrelated checkout", async () => {
    // A checkout of another repository at the thread's path: not this thread's worktree, whatever its branch.
    const f = setup(); rmSync(f.path, { recursive: true, force: true }); git(f.repo, "worktree", "prune");
    git(f.root, "init", "-q", "-b", "main", f.path); git(f.path, "config", "user.name", "Test"); git(f.path, "config", "user.email", "test@example.invalid");
    writeFileSync(join(f.path, "other"), "other"); git(f.path, "add", "."); git(f.path, "commit", "-qm", "other");
    f.store.tx(() => f.store.updateThread(f.thread.id, { settled_at: Date.now() - 2 * 86400_000 }));
    age(f); // Settled trees now observe the same finished-idle delay.
    expect((await f.service().reclaim(false)).plans[0]?.action).toBe("keep"); expect(existsSync(f.path)).toBe(true);
  });

  it("keeps a finished dirty worktree on another branch", async () => {
    const f = setup(); git(f.path, "checkout", "-qb", "feature/pushed-elsewhere");
    writeFileSync(join(f.path, "uncommitted"), "keep me");
    f.store.tx(() => f.store.updateThread(f.thread.id, { settled_at: Date.now() - 2 * 86400_000 }));
    age(f); // Settled trees now observe the same finished-idle delay.
    const plan = (await f.service().reclaim(false)).plans[0];
    expect(plan?.action).toBe("keep"); expect(existsSync(f.path)).toBe(true);
    expect(git(f.repo, "branch", "--list", "feature/pushed-elsewhere")).toContain("feature/pushed-elsewhere");
    expect(readFileSync(join(f.path, "uncommitted"), "utf8")).toBe("keep me");
  });

  it("detects a real process whose cwd is inside the checkout", async () => {
    const f = setup(); const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: f.path, stdio: "ignore" });
    try { await new Promise<void>((r) => child.once("spawn", r)); expect(await hasCwdProcess(f.path)).toBe(true); }
    finally { child.kill(); await new Promise<void>((r) => child.once("exit", () => r())); }
  });

  it("shrinks idle dependencies and caches while preserving tracked files and clean status", async () => {
    const f = setup();
    git(f.path, "commit", "-qm", "unmerged", "--allow-empty");
    for (const dir of ["node_modules/pkg", "nested/node_modules/pkg", ".next/cache", ".turbo", ".expo", "dist"]) { mkdirSync(join(f.path, dir), { recursive: true }); writeFileSync(join(f.path, dir, "cache"), "cache"); }
    // Empty parent dirs are harmless and ignored by git.
    f.store.now = () => Date.now() + 4 * 86400_000;
    expect((await f.service().reclaim(false)).plans[0]?.action).toBe("shrink");
    expect(existsSync(join(f.path, "node_modules"))).toBe(false); expect(existsSync(join(f.path, "nested/node_modules"))).toBe(false);
    expect(readFileSync(join(f.path, "tracked"), "utf8")).toBe("safe"); expect(git(f.path, "status", "--porcelain")).toBe("");
    expect(f.store.thread(f.thread.id)?.worktree_shrunk_at).toBeTypeOf("number");
  });

  it("never deletes force-added files in cache directories", async () => {
    const f = setup(); mkdirSync(join(f.path, "node_modules")); writeFileSync(join(f.path, "node_modules", "tracked"), "keep"); git(f.path, "add", "-f", "node_modules/tracked"); git(f.path, "commit", "-qm", "tracked dependency");
    f.store.now = () => Date.now() + 4 * 86400_000;
    await f.service().reclaim(false); expect(existsSync(join(f.path, "node_modules/tracked"))).toBe(true);
  });

  it("restores dependencies before the next turn, and includes a failed install note", async () => {
    vi.stubEnv("npm_config_offline", "true");
    const f = setup(); f.store.tx(() => f.store.updateThread(f.thread.id, { worktree_shrunk_at: Date.now() }));
    // A local install script proves the real install finishes before runtime.open/startTurn.
    writeFileSync(join(f.path, "package.json"), JSON.stringify({ scripts: { install: "node -e \"require('fs').writeFileSync('installed','yes')\"" } }));
    const runtime = new FakeRuntime(); const host = new LoomHost(f.store, { fake: runtime }, { loomHome: f.home }); hosts.push(host);
    await host.execute({ type: "submit", commandId: "start", threadId: f.thread.id, text: "go" });
    expect(readFileSync(join(f.path, "installed"), "utf8")).toBe("yes"); expect(runtime.last.turns[0]?.text).toBe("go");
    expect(f.store.thread(f.thread.id)?.worktree_shrunk_at).toBe(null);
    await host.closeAll();
    f.store.tx(() => f.store.updateThread(f.thread.id, { worktree_shrunk_at: Date.now() }));
    const note = await f.service({ install: async () => "failed\ninstall" }).restore(f.store.thread(f.thread.id)!);
    expect(note).toBe("Loom dependency install failed: failed install\n");
  }, 30_000);

  it("serializes reclaim behind a turn's mailbox", async () => {
    const f = setup(); const runtime = new FakeRuntime();
    const host = new LoomHost(f.store, { fake: runtime }, { loomHome: f.home }); hosts.push(host);
    let release!: () => void; let entered!: () => void;
    const started = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const restore = vi.spyOn(host.worktrees!, "restore").mockImplementation(async () => { entered(); await gate; return null; });
    const submit = host.execute({ type: "submit", commandId: "mailbox-turn", threadId: f.thread.id, text: "go" });
    await started;
    let finished = false; const reclaim = host.worktrees!.reclaim(false).then((r) => { finished = true; return r; });
    await new Promise((r) => setTimeout(r, 20));
    expect(finished).toBe(false); expect(existsSync(f.path)).toBe(true);
    release(); await submit;
    expect((await reclaim).plans[0]?.action).toBe("keep"); restore.mockRestore();
  });

  it("serves the plan and validates reclaim requests without opening a socket", async () => {
    const f = setup(); f.store.tx(() => f.store.updateThread(f.thread.id, { settled_at: Date.now() }));
    age(f); // Settled trees now observe the same finished-idle delay.
    const host = new LoomHost(f.store, {}, { loomHome: f.home }); hosts.push(host);
    Object.assign(host, { worktrees: f.service() });
    const server = createLoomServer(host, { token: "test" });
    const call = (method: string, url: string, body = "", token = "test") => new Promise<{ status: number; body: any }>((done) => {
      const req = Object.assign(Readable.from([Buffer.from(body)]), { method, url, headers: { host: "localhost", authorization: `Bearer ${token}` } });
      let status = 0;
      const res = { writeHead(code: number) { status = code; }, end(data: string) { done({ status, body: JSON.parse(data) }); } };
      server.emit("request", req, res);
    });
    expect((await call("GET", "/worktrees", "", "wrong")).status).toBe(401);
    expect((await call("GET", "/worktrees")).body[0].action).toBe("remove");
    expect((await call("POST", "/worktrees/reclaim", "{}")).status).toBe(400);
    expect((await call("POST", "/worktrees/reclaim", "bad-json")).status).toBe(400);
    expect((await call("POST", "/worktrees/reclaim", '{"dryRun":true}')).body.plans[0].action).toBe("remove");
    expect(existsSync(f.path)).toBe(true);
    expect((await call("POST", "/worktrees/reclaim", '{"dryRun":false}')).status).toBe(200);
    expect(existsSync(f.path)).toBe(false);
  });

  it("delete retains ownership of an unmerged dirty checkout for recovery", async () => {
    const f = setup(); git(f.path, "commit", "-qm", "not merged", "--allow-empty"); writeFileSync(join(f.path, "unsaved"), "saved");
    const host = new LoomHost(f.store, {}, { loomHome: f.home }); hosts.push(host);
    await host.execute({ type: "delete", commandId: "delete", threadId: f.thread.id });
    expect(f.store.thread(f.thread.id)).toBeUndefined(); expect(existsSync(f.path)).toBe(true);
    expect(f.store.deletedWorktrees()).toHaveLength(1);
    expect(readFileSync(join(f.path, "unsaved"), "utf8")).toBe("saved");
  });

  it("retains deleted ownership for retry when a cwd process prevents cleanup", async () => {
    const f = setup(); f.store.tx(() => f.store.deleteThread(f.thread.id, true));
    await f.service({ cwdProcess: async () => true }).reclaim(false); expect(f.store.deletedWorktrees()).toHaveLength(1);
    await f.service().reclaim(false); expect(existsSync(f.path)).toBe(false); expect(f.store.deletedWorktrees()).toHaveLength(0);
  });

  it("dry run logs its plan but leaves files, refs, and database unchanged; unowned paths survive", async () => {
    const f = setup(); f.store.tx(() => f.store.updateThread(f.thread.id, { settled_at: Date.now() }));
    age(f); // Settled trees now observe the same finished-idle delay.
    const unowned = join(f.home, "worktrees", "unknown"); mkdirSync(unowned); writeFileSync(join(unowned, "keep"), "safe");
    writeFileSync(join(f.path, "unsaved"), "safe"); const before = git(f.repo, "show-ref"); const rows = f.store.threads();
    const service = f.service(); const plan = await service.reclaim(true);
    expect(plan.plans.some((p) => p.action === "remove")).toBe(false); expect(plan.plans.some((p) => p.action === "unowned")).toBe(true);
    expect(git(f.repo, "show-ref")).toBe(before); expect(f.store.threads()).toEqual(rows); expect(JSON.parse(readFileSync(join(f.home, "reclaim.log"), "utf8"))).toMatchObject(plan);
    expect(existsSync(join(f.path, "unsaved"))).toBe(true);
    await service.reclaim(false); expect(readFileSync(join(unowned, "keep"), "utf8")).toBe("safe");
  });

  it("keeps a worktree whose submodule has uncommitted work (Codex review on #661)", async () => {
    const f = setup();
    const sub = join(f.root, "sub"); git(f.root, "init", "-q", "-b", "main", sub);
    git(sub, "config", "user.name", "Test"); git(sub, "config", "user.email", "test@example.invalid");
    writeFileSync(join(sub, "file"), "x"); git(sub, "add", "."); git(sub, "commit", "-qm", "sub");
    git(f.path, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendor/sub");
    git(f.path, "commit", "-qm", "add submodule"); git(f.path, "push", "-q", "origin", "HEAD:main");
    writeFileSync(join(f.path, "vendor/sub/local-change"), "only here");
    f.store.tx(() => f.store.updateThread(f.thread.id, { settled_at: Date.now() - 2 * 86400_000 }));
    age(f); // Settled trees now observe the same finished-idle delay.
    const plan = (await f.service().reclaim(false)).plans[0];
    expect(plan).toMatchObject({ action: "keep", reason: "dirty checkout, never used" });
    expect(readFileSync(join(f.path, "vendor/sub/local-change"), "utf8")).toBe("only here");
  });
});

describe("hasCwdProcess without a machine-wide lsof", () => {
  it.skipIf(process.platform === "linux")("scopes lsof to this user's pids with -b -w and parses their cwd", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "loom-cwd-")));
    const uid = process.getuid!();
    const calls: string[][] = [];
    const run = async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      if (file === "ps") return `  111 ${uid}\n  222 ${uid + 1}\n  333 ${uid}\n`;
      return `p111\nn/elsewhere\np333\nn${dir}/sub\n`;
    };
    try {
      expect(await hasCwdProcess(dir, { run })).toBe(true);
      const lsof = calls.find((c) => c[0] === "lsof")!;
      expect(lsof).toEqual(expect.arrayContaining(["-b", "-w", "-d", "cwd", "-p", "111,333"]));
      expect(lsof).not.toContain("222");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === "linux")("fails closed on time when lsof hangs", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "loom-cwd-")));
    const run = (file: string) => file === "ps" ? Promise.resolve(`  111 ${process.getuid!()}\n`) : new Promise<string>(() => {});
    const started = Date.now();
    try {
      expect(await hasCwdProcess(dir, { run, timeoutMs: 200 })).toBe(true);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

