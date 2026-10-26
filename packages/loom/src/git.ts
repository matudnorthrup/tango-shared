import { mkdir, readdir, readFile } from "node:fs/promises";
import { inReclaimScope, reclaimCall, reclaimMutation, reclaimTransaction, reclaimRecovery, reclaimRemove } from "./reclaim-io.js";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { killGroup } from "./proc.js";
import { stall } from "./stall.js";

/**
 * A thin git wrapper. Three rules from running T3 Code's worktrees for months:
 *
 * - Resolve when git exits, then give its pipes a moment to drain. Waiting
 *   for the pipes to close instead hangs whenever a hook leaves a background
 *   process holding stdout, until a timeout fires.
 * - Every operation has its own timeout; a fetch over SSH gets minutes, not 30 s.
 * - Errors carry git's own words. Credentials in URLs are redacted; nothing
 *   else is rewritten into a canned sentence.
 */

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
    readonly code: number | null,
  ) {
    super(message);
  }
}

const DRAIN_MS = 1000;

/** Strip credentials from anything git might echo: https://user:token@host and auth headers. */
export function redact(text: string): string {
  return text
    .replace(/(https?:\/\/)[^\s/@]+@/g, "$1***@")
    .replace(/(extraheader\s*=?\s*)(.+)/gi, "$1***")
    .replace(/(authorization:\s*)(\S+\s*\S*)/gi, "$1***");
}

export async function git(
  args: string[],
  options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = { cwd: process.cwd() },
): Promise<{ stdout: string; stderr: string }> {
  // Reclaim is maintenance: repository hooks may install, build or modify tracked files.
  if (inReclaimScope()) args = ["-c", "core.hooksPath=/dev/null", ...args];
  const timeoutMs = options.timeoutMs ?? 30_000;
  // Timed from before spawn(): creating the process is part of what a slow start costs (Codex review on #1135).
  const spawnedAt = performance.now();
  const child = spawn("git", args, {
    cwd: options.cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...options.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
      GCM_INTERACTIVE: "never",
    },
  });
  child.once("spawn", () => stall.noteSpawn(`git ${args[0] ?? ""}`, performance.now() - spawnedAt));
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (d) => (stdout += d));
  child.stderr!.on("data", (d) => (stderr += d));
  // Listen from the start: a pipe that closes before git's exit is seen must not cost the drain wait.
  const pipesClosed = Promise.all([new Promise((r) => child.stdout!.once("close", r)), new Promise((r) => child.stderr!.once("close", r))]);

  const exit = await new Promise<{ code: number | null; timedOut: boolean; error?: Error }>((resolve) => {
    const timer = setTimeout(() => {
      if (child.pid) killGroup(child.pid);
      resolve({ code: null, timedOut: true });
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, timedOut: false, error });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut: false });
    });
  });
  // git is done; a hook's leftover process may still hold the pipes. Drain briefly, then let go.
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([pipesClosed, new Promise((r) => (drainTimer = setTimeout(r, DRAIN_MS)))]);
  clearTimeout(drainTimer);
  child.stdout!.destroy();
  child.stderr!.destroy();

  const command = `git ${args[0] ?? ""}`;
  if (exit.error) throw new GitError(`${command} could not start: ${exit.error.message}`, args, "", null);
  if (exit.timedOut) {
    throw new GitError(`${command} timed out after ${Math.round(timeoutMs / 1000)} s${stderr.trim() ? `: ${redact(stderr.trim())}` : ""}`, args, redact(stderr), null);
  }
  if (exit.code !== 0) {
    const said = redact(stderr.trim() || stdout.trim());
    throw new GitError(`${command} failed (exit ${exit.code})${said ? `: ${said}` : ""}`, args, redact(stderr), exit.code);
  }
  return { stdout, stderr };
}

/** Refs that differ only by case collide on a case-insensitive disk, and every retry fails the same way. */
export function caseFoldCollisions(refs: string[]): string[][] {
  const groups = new Map<string, Set<string>>();
  for (const ref of refs) {
    const key = ref.toLowerCase();
    groups.set(key, (groups.get(key) ?? new Set()).add(ref));
  }
  return [...groups.values()].filter((g) => g.size > 1).map((g) => [...g].sort());
}

const REF_LOCK = /cannot lock ref|incorrect old value|unable to resolve reference|unable to update local ref|is at .* but expected/i;

async function withCaseFoldHint(error: unknown, repo: string): Promise<never> {
  if (error instanceof GitError && REF_LOCK.test(error.message)) {
    try {
      const { stdout } = await git(["for-each-ref", "--format=%(refname)"], { cwd: repo, timeoutMs: 15_000 });
      const collisions = caseFoldCollisions(stdout.split("\n").filter(Boolean));
      if (collisions.length) {
        error.message += `\nThese refs differ only by letter case, which this disk treats as the same file: ${collisions
          .map((g) => g.join(" vs "))
          .join("; ")}. Retrying won't help; delete or rename one of each pair.`;
      }
    } catch {
      // The hint is a bonus; the original error stands.
    }
  }
  throw error;
}

/**
 * Origin's default branch, asked of origin itself (a local origin/HEAD can be
 * missing or stale), then the local record, then "main".
 */
export async function defaultBranch(root: string): Promise<string> {
  try {
    const { stdout } = await git(["ls-remote", "--symref", "origin", "HEAD"], { cwd: root, timeoutMs: 60_000 });
    const match = stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
    if (match?.[1]) return match[1];
  } catch {
    // Unreachable origin: the fetch below reports that in git's words.
  }
  try {
    const local = (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: root })).stdout.trim().replace(/^origin\//, "");
    if (local) return local;
  } catch {
    // No origin/HEAD recorded locally either.
  }
  return "main";
}

export interface Worktree {
  path: string;
  /** The checkout it was made from (its top level). */
  repo: string;
  branch: string;
  /** The branch it started from, e.g. "main". */
  base: string;
  /** The commit it started at (origin's, just fetched). */
  sha: string;
}

/**
 * A fresh worktree for a new thread, on branch `loom/<id8>`, starting at the
 * commit just fetched from origin's default branch, or the checkout HEAD for promotion.
 */
export async function createWorktree(repoPath: string, options: { id: string; worktreesDir: string; fromHead?: boolean }): Promise<Worktree> {
  const root = (await git(["rev-parse", "--show-toplevel"], { cwd: repoPath })).stdout.trim();
  const base = options.fromHead ? (await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root })).stdout.trim() : await defaultBranch(root);
  try {
    if (!options.fromHead) await git(["fetch", "--no-auto-gc", "origin", base], { cwd: root, timeoutMs: 120_000 });
  } catch (error) {
    await withCaseFoldHint(error, root);
  }
  const sha = (await git(["rev-parse", options.fromHead ? "HEAD^{commit}" : `refs/remotes/origin/${base}^{commit}`], { cwd: root })).stdout.trim();
  const id8 = options.id.replace(/-/g, "").slice(0, 8);
  const branch = `loom/${id8}`;
  const dir = join(options.worktreesDir, basename(root));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `loom-${id8}`);
  // Recover allocation after a coordinator crash before the thread row was moved. Only reuse
  // this exact registered worktree/branch; never reset a path that merely happens to exist.
  if (options.fromHead && existsSync(path)) {
    const registered = (await git(["worktree", "list", "--porcelain"], { cwd: root })).stdout;
    const entry = registered.split("\n\n").find(block => block.split("\n").includes(`worktree ${realpathSync(path)}`));
    if (!entry?.split("\n").includes(`branch refs/heads/${branch}`)) throw new Error("Promotion destination already exists and is not this thread's worktree");
    const existingSha = (await git(["rev-parse", "HEAD"], { cwd: path })).stdout.trim();
    return { path, repo: root, branch, base, sha: existingSha };
  }
  // A warm pooled worktree (a finished thread's, kept by reclaim) is reused when one is free; it keeps its node_modules.
  const pooled = await takePooled(root, dir, path, branch, sha);
  if (!pooled) {
    try {
      await git(["worktree", "add", "-b", branch, path, sha], { cwd: root, timeoutMs: 300_000, env: { GIT_PROGRESS_DELAY: "0" } });
    } catch (error) {
      await withCaseFoldHint(error, root);
    }
  }
  // A partially reclaimed sibling has no valid install record; exclude it before seeding.
  const siblings = siblingWorktrees(dir, path).filter((donor) => {
    const lock = lockfileHash(donor);
    return lock !== null && donorInstalled(donor, lock);
  });
  await seedDependencies(path, [root, ...siblings]);
  // `worktree add` leaves submodules empty. Best effort: a failure here shouldn't sink the thread.
  if (existsSync(join(path, ".gitmodules"))) {
    await git(["submodule", "update", "--init", "--recursive"], { cwd: path, timeoutMs: 300_000 }).catch(() => undefined);
  }
  // Lets `gh pr create` find the base later.
  await git(["config", `branch.${branch}.gh-merge-base`, base], { cwd: root }).catch(() => undefined);
  return { path, repo: root, branch, base, sha };
}

const exec = promisify(execFile);
export const POOL_DIR = ".pool";
export const POOL_SIZE = 3;

/** The warm pool for one repo: detached, clean worktrees that reclaim parked instead of deleting. */
export function pooledWorktrees(reposDir: string): string[] {
  const pool = join(reposDir, POOL_DIR);
  try { return readdirSync(pool).sort().map((n) => join(pool, n)); } catch { return []; }
}

function siblingWorktrees(reposDir: string, except: string): string[] {
  try { return readdirSync(reposDir).filter((n) => n.startsWith("loom-")).map((n) => join(reposDir, n)).filter((p) => p !== except); } catch { return []; }
}

/** Hash of the dependency lockfile, or null when the tree has none (not a Node project, or nothing pinned). */
export function lockfileHash(cwd: string): string | null {
  // Same precedence as the installer (worktrees.ts install()): pnpm, then Yarn, then npm.
  for (const name of ["pnpm-lock.yaml", "yarn.lock", "package-lock.json"]) {
    try { return name + ":" + createHash("sha256").update(readFileSync(join(cwd, name))).digest("hex"); } catch { /* next */ }
  }
  return null;
}

async function dependencyDirs(cwd: string): Promise<string[]> {
  const manifests = (await git(["ls-files", "-z", "--", "package.json", "**/package.json"], { cwd }).catch(() => ({ stdout: "" }))).stdout.split("\0").filter(Boolean);
  return [...new Set(["node_modules", ...manifests.map((m) => join(dirname(m), "node_modules"))])];
}

/**
 * Parks a worktree in the pool for reuse: moved aside, detached at origin's tip, tracked and untracked
 * changes dropped. Ignored files (node_modules, build output) stay: that is the warm part.
 * Returns false when the pool is full; failures roll back the move and reject.
 */
export async function parkWorktree(root: string, from: string, reposDir: string, ref: string, check: () => void = () => {}, remove: (path: string) => Promise<void> = path => reclaimRemove(path, { recursive: true, force: true })): Promise<boolean> {
  const maintenanceGit: typeof git = (args, options) => git(["-c", "core.hooksPath=/dev/null", ...args], options);
  return reclaimTransaction(async () => {
    check();
    const pool = join(reposDir, POOL_DIR);
    const entries = await reclaimCall(() => readdir(pool)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    if (entries.length >= POOL_SIZE) return false;
    await reclaimMutation(() => mkdir(pool, { recursive: true }));
    const slot = join(pool, `w-${Date.now().toString(36)}`);
    // Maintenance checkout and compensation must never run install/build hooks.
    const run: typeof git = (args, options) => reclaimMutation(() => maintenanceGit(args, options));
    const head = (await reclaimCall(() => maintenanceGit(["rev-parse", "HEAD"], { cwd: from }))).stdout.trim();
    const branch = (await reclaimCall(() => maintenanceGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: from })).catch(error => {
      if (error instanceof GitError && error.code === 1) return null;
      throw error;
    }))?.stdout.trim();
    let moved = false;
    let checkoutStarted = false;
    try {
      // Record completion inside the issued operation, before the cancellation
      // check: even an expired pass must know a late move needs compensation.
      await reclaimMutation(async () => {
        await maintenanceGit(["worktree", "move", from, slot], { cwd: root, timeoutMs: 120_000 });
        moved = true;
      });
      check();
      const read = (path: string) => reclaimCall(() => readFile(path, "utf8")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      const stamped = await read(join(slot, "node_modules", ".loom-lock"));
      let lock: string | null = null;
      for (const name of ["pnpm-lock.yaml", "yarn.lock", "package-lock.json"]) {
        const content = await read(join(slot, name));
        if (content !== null) { lock = name + ":" + createHash("sha256").update(content).digest("hex"); break; }
      }
      if (lock === null || stamped !== lock) {
        const manifests = (await reclaimCall(() => maintenanceGit(["ls-files", "-z", "--", "package.json", "**/package.json"], { cwd: slot }))).stdout.split("\0").filter(Boolean);
        for (const d of new Set(["node_modules", ...manifests.map(m => join(dirname(m), "node_modules"))])) { check(); await remove(join(slot, d)); }
      }
      check();
      if (await read(join(slot, ".gitmodules")) !== null) await run(["submodule", "foreach", "--recursive", "--quiet", "git clean -fdxq"], { cwd: slot, timeoutMs: 300_000 });
      check();
      checkoutStarted = true;
      await run(["checkout", "-f", "--detach", ref], { cwd: slot, timeoutMs: 300_000 });
      check();
      // Delete untracked payload incrementally; git clean alone hides all progress
      // behind one potentially multi-gigabyte operation. Git lists files without
      // following nested repositories (directory entries), which clean -f preserves.
      const untracked = (await reclaimCall(() => maintenanceGit(["ls-files", "--others", "-z", "--exclude=node_modules"], { cwd: slot }))).stdout;
      for (const file of untracked.split("\0").filter(Boolean)) {
        if (!file.endsWith("/")) { check(); await reclaimRemove(join(slot, file), { force: true }); }
      }
      await cleanForReuse(slot, run);
      return true;
    } catch (error) {
      if (moved) await reclaimRecovery(async () => {
        // Do not apply the aborted pass guard to compensation. Each command still
        // owns one native slot, and an unsuccessful rollback is never swallowed.
        if (checkoutStarted) await run(["checkout", "-f", ...(branch ? [branch] : ["--detach", head])], { cwd: slot, timeoutMs: 300_000 });
        await run(["worktree", "move", slot, from], { cwd: root, timeoutMs: 120_000 });
      });
      throw error;
    }
  });
}

/** Drops untracked and ignored files (.env, databases, browser profiles) so nothing leaks to the next thread; only node_modules is kept. */
async function cleanForReuse(cwd: string, run: typeof git = git): Promise<void> {
  await run(["clean", "-fdxq", "-e", "node_modules"], { cwd, timeoutMs: 300_000 });
}

/** Initialized submodules keep their own ignored files and may be removed or moved by the next checkout: clean them fully, before switching revisions. */
async function cleanSubmodules(cwd: string): Promise<void> {
  if (existsSync(join(cwd, ".gitmodules"))) {
    await git(["submodule", "foreach", "--recursive", "--quiet", "git clean -fdxq"], { cwd, timeoutMs: 300_000 }).catch(() => undefined);
  }
}

async function takePooled(root: string, reposDir: string, path: string, branch: string, sha: string): Promise<boolean> {
  for (const slot of pooledWorktrees(reposDir)) {
    // Claim by renaming into place first: a concurrent create can't take the same slot.
    try { await git(["worktree", "move", slot, path], { cwd: root, timeoutMs: 120_000 }); } catch { continue; }
    try {
      await cleanSubmodules(path);
      await git(["checkout", "-f", "-B", branch, sha], { cwd: path, timeoutMs: 300_000 });
      await cleanForReuse(path);
      return true;
    } catch {
      await git(["worktree", "remove", "--force", path], { cwd: root, timeoutMs: 120_000 }).catch(() => undefined);
    }
  }
  return false;
}

/**
 * Gives a new worktree its dependencies without an install: when a donor checkout has the same lockfile,
 * its node_modules directories are copy-on-write cloned (APFS clonefile / reflink: shared blocks, nearly no
 * disk and seconds instead of a minute of npm ci). A pooled worktree whose lockfile no longer matches has its
 * node_modules removed. Best effort throughout: with no match or any failure the thread starts bare, as before.
 */
export async function seedDependencies(path: string, donors: string[]): Promise<boolean> {
  const want = lockfileHash(path);
  if (!want) return false;
  const dirs = await dependencyDirs(path);
  const own = dirs.filter((d) => existsSync(join(path, d)));
  if (own.length) {
    const stamp = join(path, "node_modules", ".loom-lock");
    let have: string | null = null;
    try { have = readFileSync(stamp, "utf8"); } catch { /* none */ }
    if (have === want) return true;
    for (const d of own) rmSync(join(path, d), { recursive: true, force: true });
  }
  for (const donor of donors) {
    if (lockfileHash(donor) !== want || !donorInstalled(donor, want)) continue;
    const copied: string[] = [];
    try {
      for (const d of [...dirs, ...yarnState(want)]) {
        // Yarn's cache and install state are ignored files; a repo that commits them already has them in the checkout.
        if (!existsSync(join(donor, d)) || (yarnState(want).includes(d) && existsSync(join(path, d)))) continue;
        mkdirSync(dirname(join(path, d)), { recursive: true });
        copied.push(d); // before the copy: a failure part-way leaves a partial tree that the catch must remove
        await exec("cp", process.platform === "darwin" ? ["-cR", join(donor, d), join(path, d)] : ["-R", "--reflink=always", join(donor, d), join(path, d)], { timeout: 300_000 });
      }
      writeStamp(path, want);
      return true;
    } catch {
      for (const d of copied) rmSync(join(path, d), { recursive: true, force: true });
    }
  }
  return false;
}

/** Yarn keeps its package cache and install state beside node_modules; with both cloned, the install after seeding has nothing to fetch or relink. */
function yarnState(hash: string): string[] {
  return hash.startsWith("yarn.lock:") ? [join(".yarn", "cache"), join(".yarn", "install-state.gz")] : [];
}

/**
 * Whether the donor's node_modules was installed for its current lockfile: stamped with this hash, or (for a
 * donor Loom never stamped, e.g. the main checkout) holding the package manager's install record written after
 * the lockfile last changed. A donor that pulled a new lockfile without reinstalling fails both.
 */
function donorInstalled(donor: string, want: string): boolean {
  const modules = join(donor, "node_modules");
  if (!existsSync(modules)) return false;
  try { return readFileSync(join(modules, ".loom-lock"), "utf8") === want; } catch { /* unstamped */ }
  const lock = want.slice(0, want.indexOf(":"));
  try {
    // Only the marker of the manager that owns the selected lockfile counts.
    const markers: Record<string, string[]> = { "package-lock.json": [".package-lock.json"], "pnpm-lock.yaml": [".modules.yaml"], "yarn.lock": [".yarn-state.yml", ".yarn-integrity"] };
    const record = (markers[lock] ?? []).map((n) => join(modules, n)).find(existsSync);
    return !!record && statSync(record).mtimeMs >= statSync(join(donor, lock)).mtimeMs;
  } catch { return false; }
}

function writeStamp(path: string, hash: string) {
  try { writeFileSync(join(path, "node_modules", ".loom-lock"), hash); } catch { /* best effort */ }
}
