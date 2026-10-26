import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caseFoldCollisions, createWorktree, git, GitError, parkWorktree, pooledWorktrees, redact } from "../src/git.js";
import { LoomHost } from "../src/host.js";
import { LoomStore } from "../src/store.js";
import { FakeRuntime } from "./fake-runtime.js";

const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A bare "origin" with one commit on main, and a clone of it. */
function repos() {
  const root = mkdtempSync(join(tmpdir(), "loom-git-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  run(root, "init", "-q", "--bare", "-b", "main", origin);
  run(root, "init", "-q", "-b", "main", seed);
  run(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one");
  run(seed, "remote", "add", "origin", origin);
  run(seed, "push", "-q", "origin", "main");
  const clone = join(root, "repo");
  run(root, "clone", "-q", origin, clone);
  // origin moves on after the clone: the worktree must start at the fetched commit, not the stale one.
  run(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "two");
  run(seed, "push", "-q", "origin", "main");
  return { root, origin, seed, clone, latest: run(seed, "rev-parse", "HEAD") };
}

describe("git wrapper", { timeout: 30_000 }, () => {
  it("redacts credentials git might echo", () => {
    expect(redact("fatal: unable to access 'https://user:ghp_secret@github.com/x.git/'")).toBe("fatal: unable to access 'https://***@github.com/x.git/'");
    expect(redact("http.extraheader=AUTHORIZATION: basic abc")).toBe("http.extraheader=***");
  });

  it("finds refs that differ only by letter case", () => {
    expect(caseFoldCollisions(["refs/heads/Codex/x", "refs/heads/codex/x", "refs/heads/main"])).toEqual([["refs/heads/Codex/x", "refs/heads/codex/x"]]);
  });

  it("reports git's own words when a command fails", async () => {
    const { clone } = repos();
    await expect(git(["rev-parse", "no-such-ref"], { cwd: clone })).rejects.toThrow(/git rev-parse failed \(exit 128\): .*no-such-ref/s);
  });

  it("returns when git exits even if a hook's background process holds stdout", async () => {
    const { clone } = repos();
    const hook = join(clone, ".git", "hooks", "post-checkout");
    writeFileSync(hook, "#!/bin/sh\n(sleep 20; echo late) &\nexit 0\n");
    chmodSync(hook, 0o755);
    const started = Date.now();
    await git(["checkout", "-q", "-b", "other"], { cwd: clone, timeoutMs: 15_000 });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("times out with what git had said", { timeout: 15_000 }, async () => {
    const { clone } = repos();
    const hook = join(clone, ".git", "hooks", "post-checkout");
    writeFileSync(hook, "#!/bin/sh\necho 'hook running' >&2\nsleep 30\n");
    chmodSync(hook, 0o755);
    // Generous enough that a loaded CI runner has reached the hook before the timeout fires.
    const error = await git(["checkout", "-q", "-b", "slow"], { cwd: clone, timeoutMs: 4_000 }).catch((e) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error.message).toMatch(/timed out after 4 s: hook running/);
  });
});

// Real git fetches and worktrees: slow under a loaded machine.
describe("createWorktree", { timeout: 30_000 }, () => {
  it("makes loom/<id8> at the commit just fetched from origin's default branch", async () => {
    const { root, clone, latest } = repos();
    const wt = await createWorktree(clone, { id: "1234abcd-0000-0000-0000-000000000000", worktreesDir: join(root, "wts") });
    expect(wt).toMatchObject({ branch: "loom/1234abcd", base: "main", sha: latest });
    expect(wt.path).toBe(join(root, "wts", "repo", "loom-1234abcd"));
    expect(run(wt.path, "rev-parse", "HEAD")).toBe(latest);
    expect(run(clone, "config", "branch.loom/1234abcd.gh-merge-base")).toBe("main");
  });

  it("clones node_modules from the repo checkout when the lockfile matches, and not when it differs", async () => {
    const { root, clone } = repos();
    run(clone, "pull", "-q", "--rebase", "origin", "main");
    writeFileSync(join(clone, "package-lock.json"), "{}");
    writeFileSync(join(clone, "package.json"), "{}");
    run(clone, "add", "."); run(clone, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "lock"); run(clone, "push", "-q", "origin", "HEAD:main");
    mkdirSync(join(clone, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(clone, "node_modules", "dep", "index.js"), "x");
    writeFileSync(join(clone, "node_modules", ".package-lock.json"), "{}");
    const wt = await createWorktree(clone, { id: "c10e0000-0000", worktreesDir: join(root, "wts") });
    expect(readFileSync(join(wt.path, "node_modules", "dep", "index.js"), "utf8")).toBe("x");
    writeFileSync(join(clone, "package-lock.json"), '{"changed":1}');
    const other = await createWorktree(clone, { id: "c10e0001-0000", worktreesDir: join(root, "wts") });
    // The checkout's own (uncommitted) lockfile now differs from the new worktree's: nothing to clone from, except sibling c10e0000.
    expect(existsSync(join(other.path, "node_modules", "dep", "index.js"))).toBe(true);
  });

  it("clones Yarn's cache and install state beside node_modules", async () => {
    const { root, clone } = repos();
    run(clone, "pull", "-q", "--rebase", "origin", "main");
    writeFileSync(join(clone, "yarn.lock"), "# lock");
    writeFileSync(join(clone, "package.json"), "{}");
    run(clone, "add", "."); run(clone, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "lock"); run(clone, "push", "-q", "origin", "HEAD:main");
    mkdirSync(join(clone, "node_modules"), { recursive: true });
    writeFileSync(join(clone, "node_modules", ".yarn-state.yml"), "x");
    mkdirSync(join(clone, ".yarn", "cache"), { recursive: true });
    writeFileSync(join(clone, ".yarn", "cache", "pkg.zip"), "z");
    writeFileSync(join(clone, ".yarn", "install-state.gz"), "s");
    const wt = await createWorktree(clone, { id: "c10e0002-0000", worktreesDir: join(root, "wts") });
    expect(readFileSync(join(wt.path, ".yarn", "cache", "pkg.zip"), "utf8")).toBe("z");
    expect(readFileSync(join(wt.path, ".yarn", "install-state.gz"), "utf8")).toBe("s");
  });

  it.each([false, true])("suppresses checkout hooks during parking and rollback (rollback=%s)", async rollback => {
    const { root, clone } = repos();
    const first = await createWorktree(clone, { id: "abac0000-0000", worktreesDir: join(root, "wts") });
    const head = run(first.path, "rev-parse", "HEAD");
    const branch = run(first.path, "branch", "--show-current");
    const hooks = join(root, "hooks"); mkdirSync(hooks);
    const marker = join(root, "hook-fired");
    writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\necho fired >> "${marker}"\necho generated > next-env.d.ts\n`);
    chmodSync(join(hooks, "post-checkout"), 0o755);
    run(clone, "config", "core.hooksPath", hooks);
    // Fail immediately after the forward checkout, forcing a real rollback checkout.
    const check = () => {
      const slot = pooledWorktrees(join(root, "wts", "repo"))[0];
      if (rollback && slot && run(slot, "branch", "--show-current") === "") throw new Error("cancel after checkout");
    };
    const parked = parkWorktree(clone, first.path, join(root, "wts", "repo"), "origin/main", check);
    if (rollback) {
      await expect(parked).rejects.toThrow("cancel after checkout");
      expect(run(first.path, "rev-parse", "HEAD")).toBe(head);
      expect(run(first.path, "branch", "--show-current")).toBe(branch);
      expect(run(first.path, "status", "--porcelain")).toBe("");
    } else await expect(parked).resolves.toBe(true);
    expect(existsSync(marker)).toBe(false);
    // Normal checkouts outside reclaim retain their configured hooks.
    await git(["checkout", "--detach", "HEAD"], { cwd: rollback ? first.path : pooledWorktrees(join(root, "wts", "repo"))[0]! });
    expect(existsSync(marker)).toBe(true);
  });

  it("clears a parked worktree's node_modules when the project has no lockfile", async () => {
    const { root, clone } = repos();
    const dir = join(root, "wts", "repo");
    const first = await createWorktree(clone, { id: "10c10000-0000", worktreesDir: join(root, "wts") });
    mkdirSync(join(first.path, "node_modules"), { recursive: true });
    expect(await parkWorktree(clone, first.path, dir, "origin/main")).toBe(true);
    expect(existsSync(join(pooledWorktrees(dir)[0]!, "node_modules"))).toBe(false);
  });

  it("does not accept another package manager's install marker for the selected lockfile", async () => {
    const { root, clone } = repos();
    run(clone, "pull", "-q", "--rebase", "origin", "main");
    writeFileSync(join(clone, "pnpm-lock.yaml"), "x");
    writeFileSync(join(clone, "package.json"), "{}");
    run(clone, "add", "."); run(clone, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "lock"); run(clone, "push", "-q", "origin", "HEAD:main");
    mkdirSync(join(clone, "node_modules"), { recursive: true });
    writeFileSync(join(clone, "node_modules", ".package-lock.json"), "{}");
    const wt = await createWorktree(clone, { id: "9a9a0000-0000", worktreesDir: join(root, "wts") });
    expect(existsSync(join(wt.path, "node_modules"))).toBe(false);
  });

  it("does not clone from a checkout whose node_modules predates its lockfile", async () => {
    const { root, clone } = repos();
    run(clone, "pull", "-q", "--rebase", "origin", "main");
    writeFileSync(join(clone, "package-lock.json"), "{}");
    writeFileSync(join(clone, "package.json"), "{}");
    run(clone, "add", "."); run(clone, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "lock"); run(clone, "push", "-q", "origin", "HEAD:main");
    mkdirSync(join(clone, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(clone, "node_modules", ".package-lock.json"), "{}");
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(clone, "node_modules", ".package-lock.json"), old, old);
    const wt = await createWorktree(clone, { id: "5a1e0000-0000", worktreesDir: join(root, "wts") });
    expect(existsSync(join(wt.path, "node_modules"))).toBe(false);
  });

  it("reuses a parked worktree: new branch at origin's tip, stale files gone, node_modules kept", async () => {
    const { root, clone, latest } = repos();
    const dir = join(root, "wts", "repo");
    const first = await createWorktree(clone, { id: "aaaa0000-0000", worktreesDir: join(root, "wts") });
    mkdirSync(join(first.path, "node_modules"), { recursive: true });
    writeFileSync(join(first.path, "node_modules", "keep"), "k");
    writeFileSync(join(first.path, "scratch.txt"), "junk");
    writeFileSync(join(first.path, ".env"), "SECRET=1");
    expect(await parkWorktree(clone, first.path, dir, "origin/main")).toBe(true);
    expect(existsSync(first.path)).toBe(false);
    expect(pooledWorktrees(dir)).toHaveLength(1);
    const second = await createWorktree(clone, { id: "bbbb0000-0000", worktreesDir: join(root, "wts") });
    expect(pooledWorktrees(dir)).toHaveLength(0);
    expect(second.branch).toBe("loom/bbbb0000");
    expect(run(second.path, "rev-parse", "HEAD")).toBe(latest);
    expect(run(second.path, "branch", "--show-current")).toBe("loom/bbbb0000");
    expect(existsSync(join(second.path, "scratch.txt"))).toBe(false);
    expect(existsSync(join(second.path, ".env"))).toBe(false);
  });

  it("drops a parked worktree's node_modules when its lockfile no longer matches the stamp", async () => {
    const { root, clone } = repos();
    const dir = join(root, "wts", "repo");
    const first = await createWorktree(clone, { id: "dddd0000-0000", worktreesDir: join(root, "wts") });
    writeFileSync(join(first.path, "package.json"), "{}");
    writeFileSync(join(first.path, "package-lock.json"), '{"a":1}');
    mkdirSync(join(first.path, "node_modules"), { recursive: true });
    writeFileSync(join(first.path, "node_modules", ".loom-lock"), "package-lock.json:stale");
    expect(await parkWorktree(clone, first.path, dir, "origin/main")).toBe(true);
    expect(existsSync(join(pooledWorktrees(dir)[0]!, "node_modules"))).toBe(false);
  });

  it("asks origin for its default branch when no local origin/HEAD exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "loom-git-trunk-"));
    const origin = join(root, "origin.git");
    const seed = join(root, "seed");
    run(root, "init", "-q", "--bare", "-b", "trunk", origin);
    run(root, "init", "-q", "-b", "trunk", seed);
    run(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one");
    run(seed, "remote", "add", "origin", origin);
    run(seed, "push", "-q", "origin", "trunk");
    // A checkout made with init + remote add has no refs/remotes/origin/HEAD.
    const repo = join(root, "repo");
    run(root, "init", "-q", repo);
    run(repo, "remote", "add", "origin", origin);
    const wt = await createWorktree(repo, { id: "feedf00d-0000", worktreesDir: join(root, "wts") });
    expect(wt.base).toBe("trunk");
    expect(run(wt.path, "rev-parse", "HEAD")).toBe(run(seed, "rev-parse", "HEAD"));
  });

  it("fails with git's message when origin can't be reached", async () => {
    const { root, clone } = repos();
    run(clone, "remote", "set-url", "origin", join(root, "gone.git"));
    await expect(createWorktree(clone, { id: "deadbeef-0000", worktreesDir: join(root, "wts") })).rejects.toThrow(/git fetch failed .*gone\.git/s);
  });
});

describe("submit with a worktree", () => {
  const flush = () => new Promise((r) => setTimeout(r, 5));

  it.each(["auto", "local", false] as const)("starts %s in the checkout and persists its mode", async worktree => {
    const store = new LoomStore(":memory:");
    const runtime = new FakeRuntime();
    const host = new LoomHost(store, { fake: runtime }, { createWorktree: async () => { throw new Error("must not create a tree"); } });
    const r = await host.execute({ type: "submit", commandId: "mode", text: "go", provider: "fake", cwd: "/repo", worktree });
    expect(store.thread(r.threadId!)!).toMatchObject({ cwd: "/repo", worktree_mode: worktree === "auto" ? "auto" : "local" });
    expect(runtime.last.options.cwd).toBe("/repo");
    await host.closeAll(); store.close();
  });

  it.each([true, "worktree"] as const)("accepts %s with an explicit checkout", async worktree => {
    const store = new LoomStore(":memory:");
    const host = new LoomHost(store, { fake: new FakeRuntime() }, { createWorktree: async repo => ({ path: "/wts/thread", repo }) });
    const r = await host.execute({ type: "submit", commandId: "mode", text: "go", provider: "fake", cwd: "/repo", worktree });
    expect(store.thread(r.threadId!)!).toMatchObject({ cwd: "/wts/thread", repo: "/repo", worktree_mode: "worktree" });
    await host.closeAll(); store.close();
  });

  it("creates the worktree, then starts the thread there", async () => {
    const store = new LoomStore(":memory:");
    const runtime = new FakeRuntime();
    const calls: [string, string][] = [];
    const host = new LoomHost(store, { fake: runtime }, {
      createWorktree: async (repoPath, threadId) => {
        calls.push([repoPath, threadId]);
        return { path: `/wts/${threadId.slice(0, 8)}` };
      },
    });
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", provider: "fake", worktree: { repoPath: "/repo" } });
    expect(calls).toEqual([["/repo", r.threadId]]);
    expect(store.thread(r.threadId!)!.worktree_mode).toBe("worktree");
    expect(store.thread(r.threadId!)!.cwd).toBe(`/wts/${r.threadId!.slice(0, 8)}`);
    expect(runtime.last.options.cwd).toBe(`/wts/${r.threadId!.slice(0, 8)}`);
  });

  it("refuses with git's error, and a retry gets the same refusal without running git again", async () => {
    const store = new LoomStore(":memory:");
    let calls = 0;
    const host = new LoomHost(store, { fake: new FakeRuntime() }, {
      createWorktree: async () => {
        calls++;
        throw new Error("git fetch failed (exit 128): fatal: could not read from remote repository");
      },
    });
    const command = { type: "submit" as const, commandId: "c1", text: "go", provider: "fake", worktree: { repoPath: "/repo" } };
    await expect(host.execute(command)).rejects.toMatchObject({ code: "worktree_failed", message: expect.stringMatching(/could not read from remote/) });
    await expect(host.execute(command)).rejects.toMatchObject({ code: "worktree_failed" });
    expect(calls).toBe(1);
    expect(store.threads()).toEqual([]);
  });

  it("refuses a worktree without a repoPath instead of using Loom's own directory", async () => {
    const store = new LoomStore(":memory:");
    let calls = 0;
    const host = new LoomHost(store, { fake: new FakeRuntime() }, { createWorktree: async () => (calls++, { path: "/x" }) });
    for (const worktree of [{}, true, { repoPath: "" }]) {
      await expect(
        host.execute({ type: "submit", commandId: `c-${JSON.stringify(worktree)}`, text: "go", provider: "fake", worktree: worktree as never }),
      ).rejects.toMatchObject({ code: "invalid" });
    }
    expect(calls).toBe(0);
  });

  it("makes one worktree when the same command arrives twice at once", async () => {
    const store = new LoomStore(":memory:");
    let calls = 0;
    const host = new LoomHost(store, { fake: new FakeRuntime() }, {
      createWorktree: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return { path: "/wts/x" };
      },
    });
    const command = { type: "submit" as const, commandId: "c1", text: "go", provider: "fake", worktree: { repoPath: "/repo" } };
    const [a, b] = await Promise.all([host.execute(command), host.execute(command)]);
    await flush();
    expect(a).toEqual(b);
    expect(calls).toBe(1);
    expect(store.threads()).toHaveLength(1);
  });
});
