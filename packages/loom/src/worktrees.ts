import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import { ReclaimIO, ReclaimTimeout, checkReclaim, deadline, reclaimBound, reclaimCall, reclaimScope, reclaimWait, reclaimRemove, reclaimMutation, reclaimRecovery } from "./reclaim-io.js";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { defaultBranch as rawDefaultBranch, git as rawGit, parkWorktree, seedDependencies, pooledWorktrees } from "./git.js";
import { isLiveHost, readHostLedgers } from "./host-ledger.js";
import { killGroup } from "./proc.js";
import type { LoomStore, ThreadRow } from "./store.js";

const chmod = reclaimBound(fs.chmod), rename = reclaimBound(fs.rename);
const mkdir = reclaimBound(fs.mkdir), writeFile = reclaimBound(fs.writeFile), lstat = reclaimBound((...args: Parameters<typeof fs.lstat>) => fs.lstat(...args)) as typeof fs.lstat;
const mkdtemp = reclaimBound(fs.mkdtemp), readdir = reclaimBound(((...args: Parameters<typeof fs.readdir>) => fs.readdir(...args)) as typeof fs.readdir);
const readlink = reclaimBound(fs.readlink), realpath = reclaimBound(fs.realpath), rm = reclaimRemove, statfs = reclaimBound(fs.statfs);
const exec = reclaimBound(promisify(execFile));
const git = reclaimBound(rawGit);
const defaultBranch = reclaimBound(rawDefaultBranch);
const inside = (root: string, path: string) => { const r = relative(root, path); return !!r && r !== ".." && !r.startsWith(`..${sep}`) && !r.startsWith(sep); };

type Run = (file: string, args: string[], timeoutMs: number) => Promise<string>;
const run: Run = async (file, args, timeoutMs) => (await exec(file, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 })).stdout;

/**
 * Whether any process of this user works inside `path`. Fails closed (true) when discovery is unavailable.
 * Never follows directory symlinks.
 *
 * macOS: never a machine-wide lsof. That stats every open file on the machine and hangs for a minute or more
 * on a stalled network mount (SMB, Time Machine). Instead ps lists this user's pids, and lsof reads only
 * their cwd, with -b (no blocking kernel calls) and -w, under a short timeout.
 */
export async function hasCwdProcess(path: string, options: { run?: Run; timeoutMs?: number } = {}): Promise<boolean> {
  path = await realpath(path);
  if (process.platform === "linux") {
    for (const pid of await readdir("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try { const cwd = await readlink(`/proc/${pid}/cwd`); if (cwd === path || inside(path, cwd)) return true; }
      catch (e) { if (!["ENOENT", "ESRCH"].includes((e as NodeJS.ErrnoException).code ?? "")) return true; }
    }
    return false;
  }
  const exec = options.run ?? run;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(1, deadline - Date.now());
  // A hard deadline over the whole lookup: a runner that never returns still fails closed on time.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), timeoutMs); });
  try { return await Promise.race([lookup(), expired]); } finally { clearTimeout(timer); }
  async function lookup(): Promise<boolean> {
  try {
    const uid = process.getuid?.();
    const pids = (await exec("ps", ["-axo", "pid=,uid="], left())).split("\n").flatMap((line) => {
      const [pid, owner] = line.trim().split(/\s+/).map(Number);
      return pid && pid !== process.pid && (uid === undefined || owner === uid) ? [pid] : [];
    });
    for (let i = 0; i < pids.length; i += 400) {
      if (Date.now() >= deadline) return true;
      const out = await exec("lsof", ["-a", "-b", "-w", "-d", "cwd", "-Fn", "-p", pids.slice(i, i + 400).join(",")], left()).catch((e: { code?: number; stdout?: string }) => {
        // lsof exits 1 when some listed pids have gone away; its output for the rest still counts.
        if (e && e.code === 1 && typeof e.stdout === "string") return e.stdout;
        throw e;
      });
      if (out.split("\n").some((line) => line.startsWith("n") && (line.slice(1) === path || inside(path, line.slice(1))))) return true;
    }
    return false;
  } catch { return true; }
  }
}

export interface WorktreePlan {
  path: string; thread: string | null; status: string; merged: boolean | null; lastActive: number | null;
  /** Allocated bytes, deduplicated by inode within this checkout; not reclaimable bytes. */
  size: number | null; head?: string; action: "keep" | "remove" | "shrink" | "unowned"; reason: string; targets: string[];
}

export class Worktrees {
  private readonly io = new ReclaimIO();
  private readonly progress = new AsyncLocalStorage<{ phase: string; done: number; total: number; current: string | null }>();
  private phase(phase: string) { const progress = this.progress.getStore(); if (progress) progress.phase = phase; }
  private pass: Promise<unknown> = Promise.resolve();
  private lifecyclePending = 0;
  private reclaimTasks: { priority: boolean; run: () => Promise<void> }[] = [];
  private drainingReclaim = false;

  /** One destructive task at a time; pressure jumps ahead at lifecycle row boundaries.
   * Each task still acquires the thread mailbox before inspecting or touching files.
   */
  private scheduleReclaim<T>(priority: boolean, work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task = { priority, run: AsyncLocalStorage.bind(async () => { try { checkReclaim(); resolve(await reclaimWait(work, this.options.passTimeoutMs ?? 300_000)); } catch (error) { reject(error); } }) };
      this.reclaimTasks.push(task);
      if (!this.drainingReclaim) {
        this.drainingReclaim = true;
        queueMicrotask(async () => {
          try {
            while (this.reclaimTasks.length) {
              const urgent = this.reclaimTasks.findIndex(task => task.priority);
              await this.reclaimTasks.splice(urgent < 0 ? 0 : urgent, 1)[0]!.run();
            }
          } finally { this.drainingReclaim = false; }
        });
      }
    });
  }

  private logWrite: Promise<unknown> = Promise.resolve();
  private pressureHeartbeatAt: number | null = null;
  constructor(private store: LoomStore, private home: string, private options: {
    ioTimeoutMs?: number;
    passTimeoutMs?: number;
    heartbeatMs?: number;
    live: (id: string) => boolean;
    leased?: (id: string) => boolean;
    /** End a thread's idle session (live host included) before removing its worktree. */
    release?: (id: string) => Promise<void>;
    mailbox: <T>(id: string, work: () => Promise<T>) => Promise<T>;
    cwdProcess?: (path: string) => Promise<boolean>;
    active?: () => boolean;
    diskFree?: () => Promise<number>;
    cool?: (id: string) => Promise<boolean>;
    seed?: typeof seedDependencies;
    install?: (cwd: string) => Promise<string | null>;
    gh?: (args: string[], cwd: string) => Promise<string>;
  }) {}

  /** Watchdog owns the pass, not the underlying kernel call. Aborted contexts cannot
   * issue more IO; pending native calls retain their concurrency slots until they settle.
   * Evidence uses its own lane, never the scan queue.
   */
  async withPass<T>(reason: string, dryRun: boolean, work: () => Promise<T>): Promise<T> {
    const progress = { phase: "starting", done: 0, total: 0, current: null as string | null };
    const heartbeat = setInterval(() => {
      void this.appendReclaimLog({ at: new Date().toISOString(), reason, dryRun, heartbeat: "pass running", progress: { ...progress } }).catch(error => console.warn("Reclaim heartbeat failed", error));
    }, this.options.heartbeatMs ?? 60_000);
    heartbeat.unref?.();
    try { return await reclaimScope(this.io, this.options.ioTimeoutMs ?? 30_000, this.options.passTimeoutMs ?? 300_000, () => this.progress.run(progress, work)); }
    catch (error) {
      if (error instanceof ReclaimTimeout) {
        // A broken log filesystem must not hold the scheduler guard forever either.
        await deadline(() => this.appendReclaimLog({ at: new Date().toISOString(), reason, dryRun, skipped: "pass stalled", progress: { ...progress } }), 5_000)
          .catch(logError => console.warn("Reclaim pass stalled; evidence write failed", logError));
      }
      throw error;
    } finally { clearInterval(heartbeat); }
  }

  // Probes borrow a checkout; only ordinary threads own it and get reclamation plans.
  private rows() { return [...this.store.threads(), ...this.store.deletedWorktrees()].filter(t => t.kind !== "probe"); }
  owns(t: ThreadRow) { return inside(resolve(this.home, "worktrees"), resolve(t.cwd)); }
  /** Durable holds apply even when an idle session can be released. */
  private hold(t: ThreadRow, pressure = false): string | null {
    if (this.options.leased?.(t.id)) return "resource lease";
    if (this.store.activeRun(t.id)) return "active run";
    if (this.store.nextQueuedRun(t.id)) return "queued run";
    if (this.store.openRequests(t.id).length) return "open request";
    if (this.store.openDecisions(t.id).length) return "open brief";
    if (!pressure && this.store.hasPendingWait(t.id)) return "pending wait";
    if (this.store.thread(t.id) && t.background) return "background";
    if (this.store.thread(t.id) && t.status === "running") return "running thread";
    return null;
  }

  /** Session holds may be ignored while planning; only a remove plan authorizes release. */
  private releasable(t: ThreadRow): boolean {
    return !!this.options.release && !!this.store.thread(t.id) && !this.hold(t);
  }

  borrowed(t: ThreadRow): boolean {
    const hosts = readHostLedgers(join(this.home, "hosts"));
    return this.store.threads().some(probe => probe.kind === "probe" && resolve(probe.cwd) === resolve(t.cwd) && (
      (probe.settled_at === null && probe.status !== "stopped") || !!this.hold(probe) ||
      this.options.live(probe.id) || hosts.some(h => h.threadId === probe.id && isLiveHost(h))
    ));
  }

  private async busy(t: ThreadRow, path: string, ignoreSession = false, pressure = false) {
    // A parent's releasable session never makes its borrowers releasable. Recheck here
    // as well as during inspection so a probe queued during git/traversal holds cleanup.
    return this.rows().some(other => other.id !== t.id && resolve(other.cwd) === resolve(t.cwd)) || this.borrowed(t) || (!ignoreSession && (this.options.live(t.id) || readHostLedgers(join(this.home, "hosts")).some((h) => h.threadId === t.id && isLiveHost(h)))) ||
      !!this.hold(this.rows().find(row => row.id === t.id) ?? t, pressure) ||
      // The session's own harness works in this checkout. When that session is the one being ended, the cwd
      // check waits for the re-inspection after it exits (any other process still blocks removal then).
      (!ignoreSession && await (this.options.cwdProcess
        ? reclaimCall(() => this.options.cwdProcess!(path))
        // The composite default already accounts for each native operation.
        : reclaimWait(() => hasCwdProcess(path))));
  }

  private async inspect(t: ThreadRow, fetch: boolean, ignoreSession = false, prs = new Map<string, Promise<{ number?: number; unavailable?: boolean }>>(), pressure = false, measureSize = true): Promise<WorktreePlan> {
    try { return await reclaimScope(this.io, this.options.ioTimeoutMs ?? 30_000, this.options.passTimeoutMs ?? 300_000,
      () => this.inspectUnchecked(t, fetch, ignoreSession, prs, pressure, measureSize)); }
    catch (error) { if (!(error instanceof ReclaimTimeout)) throw error; return this.timedOut(t); }
  }

  private timedOut(t: ThreadRow): WorktreePlan {
    return { path: t.cwd, thread: t.id, status: t.status, merged: null, lastActive: null, size: null, action: "keep", reason: "inspect timed out", targets: [] };
  }

  private async inspectUnchecked(t: ThreadRow, fetch: boolean, ignoreSession = false, prs = new Map<string, Promise<{ number?: number; unavailable?: boolean }>>(), pressure = false, measureSize = true): Promise<WorktreePlan> {
    const p: WorktreePlan = { path: t.cwd, thread: t.id, status: this.store.thread(t.id) ? t.status : "deleted", merged: null, lastActive: this.store.lastRunEndedAt(t.id) ?? t.created_at, size: null, action: "keep", reason: "unsafe or unavailable checkout", targets: [] };
    this.phase("checkout identity");
    if (!this.owns(t)) return p;
    try {
      if ((await lstat(join(this.home, "worktrees"))).isSymbolicLink()) return p;
      const root = await realpath(join(this.home, "worktrees"));
      const path = await realpath(t.cwd);
      if (this.rows().some((other) => other.id !== t.id && resolve(other.cwd) === resolve(t.cwd))) { p.reason = "checkout has multiple owners"; return p; }
      if (!inside(root, path) || (await lstat(t.cwd)).isSymbolicLink()) return p;
      // A row alone cannot authorize removing an arbitrary directory or another checkout.
      const top = await realpath((await git(["rev-parse", "--show-toplevel"], { cwd: path })).stdout.trim());
      if (top !== path || !t.repo) return p;
      const common = await realpath(resolve(path, (await git(["rev-parse", "--git-common-dir"], { cwd: path })).stdout.trim()));
      const repoCommon = await realpath(resolve(t.repo, (await git(["rev-parse", "--git-common-dir"], { cwd: t.repo })).stdout.trim()));
      // Exactly this thread's checkout of this repo, on whatever branch the thread switched to.
      if (common !== repoCommon) return p;
      p.head = (await git(["rev-parse", "HEAD"], { cwd: path })).stdout.trim();
      this.phase("holds and processes");
      const busy = await this.busy(t, path, ignoreSession, pressure);
      if ((pressure || !measureSize) && busy) { p.reason = this.hold(t, pressure) ?? "live host or cwd process"; return p; }
      this.phase("merge proof");
      let pr: { number?: number; unavailable?: boolean } = {};
      let neverUsed = false;
      if (!pressure && !busy) {
        const branch = t.worktree_branch ?? await git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: path }).then(r => r.stdout.trim()).catch(() => null);
        if (branch) {
          const head = (await git(["rev-parse", "HEAD"], { cwd: path })).stdout.trim();
          const key = JSON.stringify([t.repo, branch, head]);
          if (!prs.has(key)) prs.set(key, (async () => {
            try {
              if (!this.options.gh) throw new Error("No PR runner");
              const rows = JSON.parse(await reclaimCall(() => this.options.gh!(["pr", "list", "--state", "merged", "--head", branch, "--json", "number,mergedAt,headRefOid", "--limit", "1"], t.repo!)));
              if (!Array.isArray(rows)) throw new Error("Invalid PR response");
              const row = rows[0];
              if (!row?.mergedAt || !Number.isInteger(row?.number) || typeof row.headRefOid !== "string") return {};
              // Work committed after the merge (a follow-up on the same branch) isn't covered by that PR.
              const covered = await git(["merge-base", "--is-ancestor", "HEAD", row.headRefOid], { cwd: path }).then(() => true, () => false);
              return covered ? { number: row.number as number } : {};
            } catch { return { unavailable: true }; }
          })());
          pr = await prs.get(key)!;
        }
        p.merged = !!pr.number;
        try {
          const base = fetch ? await defaultBranch(path) : await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: path }).then(r => r.stdout.trim().replace(/^origin\//, "")).catch(() => "main");
          if (fetch) await git(["fetch", "--no-auto-gc", "origin", base], { cwd: path, timeoutMs: 120_000 });
          await git(["merge-base", "--is-ancestor", "HEAD", `origin/${base}`], { cwd: path });
          p.merged = true;
          neverUsed = (await git(["rev-list", "--count", `origin/${base}..HEAD`], { cwd: path })).stdout.trim() === "0";
        } catch { /* A merged PR also covers squash merges and unavailable ancestry. */ }
      }
      this.phase("regenerable targets");
      // Lifecycle decisions do not use allocated size. Measuring dependency trees here
      // makes every pass proportional to every installed file, including held checkouts.
      const measureBytes = !pressure && measureSize;
      p.size = measureBytes ? 0 : null;
      const seen = new Set<string>();
      const measure = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (entry.name === ".git") continue;
          const file = join(dir, entry.name); const st = await lstat(file); const inode = `${st.dev}:${st.ino}`;
          if (measureBytes && !seen.has(inode)) { seen.add(inode); p.size = (p.size ?? 0) + st.blocks * 512; }
          if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== ".git") await measure(file);
        }
      };
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (entry.name === ".git") continue;
          const file = join(dir, entry.name); const st = await lstat(file);
          const inode = `${st.dev}:${st.ino}`;
          if (measureBytes && !seen.has(inode)) { seen.add(inode); p.size = (p.size ?? 0) + st.blocks * 512; }
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          // Submodules and nested repositories have their own tracked-file boundary.
          if (existsSync(join(file, ".git"))) { if (measureBytes) await measure(file); continue; }
          let target = ["node_modules", ".turbo", ".expo"].includes(entry.name) || (entry.name === "cache" && dir.endsWith(`${sep}.next`));
          if (entry.name === "dist") {
            if (pressure) continue;
            try { await git(["check-ignore", "-q", "--", relative(path, file)], { cwd: path }); target = true; } catch { /* tracked output stays */ }
          }
          if (target) {
            // Even ignored directories can contain force-added files. Never unlink tracked content.
            const tracked = (await git(["ls-files", "-z", "--", relative(path, file)], { cwd: path })).stdout;
            if (!tracked) { p.targets.push(file); if (measureBytes) await measure(file); continue; }
          }
          await walk(file);
        }
      };
      await walk(path);
      if (busy || this.hold(this.rows().find(row => row.id === t.id) ?? t, pressure)) { p.reason = this.hold(t, pressure) ?? "live host or cwd process"; return p; }
      this.phase("eligibility");
      const idle = this.store.now() - p.lastActive!;
      if (pressure) {
        p.action = p.targets.length ? "shrink" : "keep";
        p.reason = p.targets.length ? "disk pressure" : "no regenerable targets";
        return p;
      }
      const configuredHours = Number(process.env.LOOM_WORKTREE_FINISHED_IDLE_HOURS ?? 24);
      const hours = Number.isFinite(configuredHours) && configuredHours >= 0 ? configuredHours : 24;
      const settled = t.settled_at !== null || t.status === "stopped";
      const finishedFor = this.store.now() - Math.max(t.settled_at ?? 0, p.lastActive!);
      const rule = pr.number ? `merged PR #${pr.number}` : neverUsed ? "never used" : "merged by ancestry";
      if (p.merged && !pr.unavailable && (p.status === "deleted" || (settled && finishedFor > hours * 3600_000) || (!settled && idle > hours * 3600_000))) {
        if ((await git(["status", "--porcelain", "--untracked-files=all"], { cwd: path })).stdout.trim()) {
          p.reason = `dirty checkout, ${rule}`;
        } else {
          p.action = "remove";
          p.reason = p.status === "deleted" ? "deleted thread" : `${rule}, idle ${Math.floor(idle / 3600_000)}h`;
        }
      } else {
        const configured = Number(process.env.LOOM_WORKTREE_IDLE_DAYS ?? 3);
        const days = Number.isFinite(configured) && configured >= 0 ? configured : 3;
        if (idle > days * 86400_000 && p.targets.length) { p.action = "shrink"; p.reason = "idle"; }
        else p.reason = `${p.merged ? rule : "unmerged"}, idle ${Math.floor(idle / 3600_000)}h`;
      }
      if (pr.unavailable) p.reason += "; pr lookup unavailable";

    } catch (error) { if (error instanceof ReclaimTimeout) throw error; p.action = "keep"; p.reason = String(error); }
    return p;
  }

  /** Inventory only: machine telemetry must not scan dependency trees or run git checks. */
  async count(): Promise<number> {
    const rows = this.rows().filter(t => this.owns(t) && existsSync(t.cwd));
    return new Set([...rows.map(t => resolve(t.cwd)), ...(await this.unowned(rows)).map(p => resolve(p.path))]).size;
  }

  async list(fetch = false): Promise<WorktreePlan[]> {
    const rows = this.rows().filter((t) => this.owns(t) && existsSync(t.cwd));
    const plans: WorktreePlan[] = [];
    const prs = new Map<string, Promise<{ number?: number; unavailable?: boolean }>>();
    for (const t of rows) plans.push(await this.inspect(t, fetch, false, prs));
    return [...plans, ...await this.unowned(rows)];
  }

  private async unowned(rows = this.rows().filter((t) => this.owns(t) && existsSync(t.cwd))): Promise<WorktreePlan[]> {
    const plans: WorktreePlan[] = [];
    const known = new Set(rows.map((t) => resolve(t.cwd)));
    const scan = async (dir: string) => {
      for (const ent of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, ent.name);
        if (known.has(resolve(path)) || ent.name === ".pool") continue;
        if (ent.isDirectory() && !ent.isSymbolicLink() && [...known].some((owned) => inside(resolve(path), owned))) {
          await scan(path); continue;
        }
        plans.push({ path, thread: null, status: "unowned", merged: null, lastActive: null, size: null, action: "unowned", reason: "no owning thread", targets: [] });
      }
    };
    if (existsSync(join(this.home, "worktrees"))) await scan(join(this.home, "worktrees"));
    return plans;
  }

  /** Timer ticks never accumulate behind a running or queued lifecycle pass. */
  async reclaimScheduled(dryRun: boolean) {
    if (this.lifecyclePending) {
      await this.appendReclaimLog({ at: new Date().toISOString(), reason: "lifecycle", dryRun, skipped: "lifecycle pass pending" });
      return;
    }
    return this.reclaim(dryRun);
  }

  reclaim(dryRun: boolean, only?: string) {
    this.lifecyclePending++;
    const requestedAt = performance.now();
    const work = this.pass.then(() => this.withPass("lifecycle", dryRun, async () => {
      const startedAt = performance.now();
      const rowTimings: { thread: string; durationMs: number }[] = [];
      const before = await statfs(this.home, { bigint: true });
      const plans: WorktreePlan[] = [];
      const prs = new Map<string, Promise<{ number?: number; unavailable?: boolean }>>();
      const rows = this.rows().filter((t) => this.owns(t) && (!only || t.id === only) && existsSync(t.cwd));
      const progress = this.progress.getStore()!;
      progress.total = rows.length;
      for (const row of rows) {
        Object.assign(progress, { phase: "scheduler", current: row.cwd });
        plans.push(await this.scheduleReclaim(false, async () => {
          const rowStartedAt = performance.now();
          this.phase("mailbox");
          try { return await reclaimScope(this.io, this.options.ioTimeoutMs ?? 30_000, this.options.passTimeoutMs ?? 300_000, () => reclaimWait(() => this.options.mailbox(row.id, async () => {
            checkReclaim();
            const current = this.rows().find((t) => t.id === row.id);
            if (!current) return { path: row.cwd, thread: row.id, status: "missing", merged: null, lastActive: null, size: 0, action: "keep", reason: "ownership changed", targets: [] } as WorktreePlan;
            // A finished thread at a safe point (no run, question or background work) still holds its idle
            // session: end it, so the worktree can be judged (and removed) without it.
            const releasable = this.releasable(current);
            // A dry run reports what a real pass would do; only the real pass ends the session.
            let plan = await this.inspect(current, !dryRun, releasable, prs, false, false);
            if (!dryRun && plan.action === "remove" && releasable && this.options.live(current.id)) {
              await reclaimWait(() => this.options.release!(current.id));
              await this.waitForHostExit(current.id);
              plan = await this.inspect(this.rows().find((t) => t.id === current.id) ?? current, false, false, prs, false, false);
            }
            if (dryRun || plan.action === "keep") return plan;
            this.phase("mutation safety checks");
            // Recheck after git and traversal, immediately before touching the checkout.
            if (await this.busy(current, await realpath(current.cwd))) { plan.action = "keep"; plan.reason = "became busy"; return plan; }
            try {
              if (plan.action === "remove") {
                // Submodules keep their own uncommitted and ignored state, which the parent's checkpoint and
                // archive don't see: a dirty one keeps the whole worktree.
                if (await dirtySubmodule(current.cwd)) { plan.action = "keep"; plan.reason = "dirty submodule"; return plan; }
                if ((await git(["status", "--porcelain", "--untracked-files=all"], { cwd: current.cwd })).stdout.trim()) { plan.action = "keep"; plan.reason = "dirty checkout"; return plan; }
                this.phase("archive and checkpoint");
                const archive = await this.archive(current);
                if (archive === false) { plan.action = "keep"; plan.reason = "large ignored files"; return plan; }
                await checkpoint(current);
                const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: current.cwd }).then((r) => r.stdout.trim()).catch(() => null);
                const head = (await git(["rev-parse", "HEAD"], { cwd: current.cwd })).stdout.trim();
                if (head !== plan.head) { plan.action = "keep"; plan.reason = "head changed"; return plan; }
                if (await this.busy(current, await realpath(current.cwd))) { plan.action = "keep"; plan.reason = "became busy"; return plan; }
                const latest = this.rows().find(t => t.id === current.id);
                if (!latest || latest.cwd !== current.cwd || this.hold(latest) || this.store.lastRunEndedAt(current.id) !== plan.lastActive && this.store.lastRunEndedAt(current.id) !== null) {
                  plan.action = "keep"; plan.reason = "became busy"; return plan;
                }
                const base = await defaultBranch(current.repo!).catch(() => "main");
                if ((await git(["status", "--porcelain", "--untracked-files=all"], { cwd: current.cwd })).stdout.trim()) { plan.action = "keep"; plan.reason = "dirty checkout"; return plan; }
                const final = this.rows().find(t => t.id === current.id);
                checkReclaim();
                if (!final || final.cwd !== current.cwd || this.hold(final) || final.status !== current.status || final.settled_at !== current.settled_at || (this.store.lastRunEndedAt(current.id) ?? final.created_at) !== plan.lastActive) { plan.action = "keep"; plan.reason = "became busy"; return plan; }
                // Persist recovery information first: a crash after removal must remain recoverable.
                this.store.tx(() => this.store.updateThread(current.id, {
                  worktree_removed_at: this.store.now(), worktree_branch: branch, worktree_head: head, worktree_archive: archive,
                }));
                // Keep a few clean, warm worktrees (node_modules intact) for the next thread to reuse; remove the rest.
                const beforeRemove = () => {
                  checkReclaim();
                  const fresh = this.rows().find(t => t.id === current.id);
                  if (!fresh || fresh.cwd !== current.cwd || this.hold(fresh) || fresh.status !== current.status || fresh.settled_at !== current.settled_at || (this.store.lastRunEndedAt(current.id) ?? fresh.created_at) !== plan.lastActive) throw new Error("became busy");
                };
                this.phase("park or remove");
                let parked: boolean;
                try {
                  parked = await parkWorktree(current.repo!, current.cwd, dirname(current.cwd), `origin/${base}`, beforeRemove, path => rm(path, { recursive: true, force: true }));
                } catch (error) {
                  // Parking rolls back its move before rejecting. Restore archived ignored
                  // files and clear the removal marker while still owning the mailbox.
                  await reclaimRecovery(async () => {
                    if (!existsSync(current.cwd)) throw error;
                    if (archive) await reclaimMutation(() => promisify(execFile)("tar", ["-xzf", archive, "-C", current.cwd], { timeout: 600_000 }));
                    this.store.tx(() => this.store.updateThread(current.id, {
                      worktree_removed_at: null, worktree_shrunk_at: this.store.now(),
                    }));
                  });
                  throw error;
                }
                if (!parked) {
                  beforeRemove();
                  await reclaimMutation(() => rawGit(["worktree", "remove", "--force", current.cwd], { cwd: current.repo!, timeoutMs: 600_000 }));
                }
                await git(["worktree", "prune"], { cwd: current.repo! });
                this.store.forgetDeletedWorktree(current.id);
              } else if (plan.action === "shrink") {
                this.phase("shrink");
                // Sequential deletion bounds both worktree and node_modules unlink concurrency.
                await invalidateInstallStamp(current.cwd);
                this.store.tx(() => this.store.updateThread(current.id, { worktree_shrunk_at: this.store.now() }));
                for (const target of plan.targets) await rm(target, { recursive: true, force: true, maxRetries: 2 });
              }
            } catch (e) { if (e instanceof ReclaimTimeout) throw e; plan.action = "keep"; plan.reason = `failed: ${String(e)}`; }
            return plan;
          }))); } catch (error) { if (error instanceof ReclaimTimeout) return this.timedOut(row); throw error; } finally { rowTimings.push({ thread: row.id, durationMs: Math.round(performance.now() - rowStartedAt) }); }
        }));
        progress.done++;
      }
      Object.assign(progress, { phase: "unowned inventory", current: null });
      const unowned = await this.unowned();
      this.phase("disk accounting");
      const after = await statfs(this.home, { bigint: true });
      const result = {
        dryRun, plans: [...plans, ...unowned], freedBytes: dryRun ? 0 : Number((after.bfree - before.bfree) * after.bsize),
        durationMs: Math.round(performance.now() - startedAt), queuedMs: Math.round(startedAt - requestedAt),
        // Row timings include mailbox wait, inspection and mutation, but exclude pressure preemption.
        inspectTimeouts: plans.filter(plan => plan.reason === "inspect timed out").length,
        slowestRows: rowTimings.sort((a, b) => b.durationMs - a.durationMs).slice(0, 5),
      };
      this.phase("evidence");
      await this.appendReclaimLog({ at: new Date().toISOString(), reason: "lifecycle", ...result });
      return result;
    }));
    const settled = work.finally(() => { this.lifecyclePending--; });
    this.pass = settled.catch(() => {});
    return settled;
  }

  /** Serialize heartbeat and pass writes so rotation cannot race an append. */
  private appendReclaimLog(entry: object): Promise<void> {
    const work = this.logWrite.then(async () => {
      const path = join(this.home, "reclaim.log");
      const line = JSON.stringify(entry) + "\n";
      const current = await fs.lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      // Keep complete records; a single oversized record rotates on the next write.
      if (current?.isFile() && current.size + Buffer.byteLength(line) > 10 * 1024 * 1024) {
        await fs.chmod(path, 0o600);
        await fs.rename(path, `${path}.1`);
      }
      await fs.appendFile(path, line, { mode: 0o600 });
      await fs.chmod(path, 0o600);
    });
    this.logWrite = work.catch(() => {});
    return work;
  }

  /** Healthy pressure ticks still leave evidence, at most once per five minutes per coordinator. */
  async logPressureSkipped(freeBytes: number, floorBytes: number, dryRun: boolean): Promise<void> {
    const now = this.store.now();
    if (this.pressureHeartbeatAt !== null && now - this.pressureHeartbeatAt < 300_000) return;
    const previous = this.pressureHeartbeatAt;
    this.pressureHeartbeatAt = now;
    try {
      await this.appendReclaimLog({
        at: new Date(now).toISOString(), reason: "disk pressure", dryRun,
        freeBytes, floorBytes, skipped: "above floor",
      });
    } catch (error) { this.pressureHeartbeatAt = previous; throw error; }
  }

  /** Pressure only drops regenerable output, never source/checkpoints or whole worktrees.
   * Runs before the next lifecycle row, retaining each owner's mailbox safety.
   */
  pressure(dryRun: boolean, limits: { floorBytes: number; targetBytes: number; idleMs: number; maxTargets?: number }) {
    return this.withPass("disk pressure", dryRun, () => this.scheduleReclaim(true, async () => {
      const free = this.options.diskFree ? () => reclaimCall(this.options.diskFree!) : async () => { const d = await statfs(this.home); return d.bavail * d.bsize; };
      const read = async () => { const n = await reclaimWait(free); if (!Number.isFinite(n) || n < 0) throw new Error("Disk reading unavailable"); return n; };
      const before = await read();
      const plans: WorktreePlan[] = [];
      if (before >= limits.floorBytes) {
        await this.logPressureSkipped(before, limits.floorBytes, dryRun);
        return { dryRun, plans, freedBytes: 0, beforeBytes: before, afterBytes: before };
      }
      let remaining = limits.maxTargets ?? 8;
      // Cold caches first, then cold installs. Only then consider cooling a host
      // that pins useful targets; closing a host alone does not relieve disk pressure.
      for (const stage of ["cache", "dependencies", "cool"] as const) {
        const rows = this.rows().filter(t => this.owns(t) && existsSync(t.cwd))
          .sort((a, b) => (this.store.lastRunEndedAt(a.id) ?? a.created_at) - (this.store.lastRunEndedAt(b.id) ?? b.created_at));
        for (const row of rows) {
          if (this.options.active?.() === false || remaining <= 0 || (!dryRun && await read() >= limits.targetBytes)) break;
          try { await reclaimScope(this.io, this.options.ioTimeoutMs ?? 30_000, this.options.passTimeoutMs ?? 300_000, () => reclaimWait(() => this.options.mailbox(row.id, async () => {
            checkReclaim();
            const current = this.rows().find(t => t.id === row.id);
            if (!current || this.hold(current, true) || this.store.now() - (this.store.lastRunEndedAt(current.id) ?? current.created_at) < limits.idleMs) return;
            const cooling = stage === "cool";
            if (cooling && (!this.options.cool || !this.options.live(current.id))) return;
            let plan = await this.inspect(current, false, cooling, undefined, true);
            if (plan.action !== "shrink") { if (plan.reason === "inspect timed out") plans.push(plan); return; }
            const select = (p: WorktreePlan) => p.targets.filter(target => cooling || (stage === "dependencies") === (target.split(sep).at(-1) === "node_modules"));
            plan.targets = select(plan).sort((a, b) => Number(a.endsWith(sep + "node_modules")) - Number(b.endsWith(sep + "node_modules"))).slice(0, remaining);
            if (!plan.targets.length) return;
            if (cooling && !dryRun) {
              if (!await reclaimWait(() => this.options.cool!(current.id))) return;
              await this.waitForHostExit(current.id);
              plan = await this.inspect(this.rows().find(t => t.id === current.id) ?? current, false, false, undefined, true);
              plan.targets = select(plan).sort((a, b) => Number(a.endsWith(sep + "node_modules")) - Number(b.endsWith(sep + "node_modules"))).slice(0, remaining);
              if (plan.action !== "shrink" || !plan.targets.length) return;
            }
            plans.push(plan);
            if (dryRun) { remaining -= plan.targets.length; return; }
            // New work or an external process discovered during inspection wins.
            if (await this.busy(current, await realpath(current.cwd), false, true)) { plan.action = "keep"; plan.reason = "became busy"; return; }
            const removed: string[] = [];
            try {
              for (const target of plan.targets) {
                if (this.options.active?.() === false || await read() >= limits.targetBytes || remaining <= 0) break;
                if (await this.busy(current, await realpath(current.cwd), false, true)) break;
                // Revalidate the exact path and tracked boundary after awaited discovery.
                if (await realpath(target) !== target || (await git(["ls-files", "-z", "--", relative(await realpath(current.cwd), target)], { cwd: current.cwd })).stdout) continue;
                const latest = this.rows().find(t => t.id === current.id);
                if (!latest || latest.cwd !== current.cwd || this.hold(latest, true) || this.options.active?.() === false) break;
                // Persist before unlink so an interrupted pass still restores dependencies.
                if (target.endsWith(sep + "node_modules")) {
                  await invalidateInstallStamp(current.cwd);
                  this.store.tx(() => this.store.updateThread(current.id, { worktree_shrunk_at: this.store.now() }));
                }
                await rm(target, { recursive: true, force: true, maxRetries: 2 });
                removed.push(target); remaining--;
              }
            } catch (error) { if (error instanceof ReclaimTimeout) throw error; plan.reason = `failed: ${String(error)}`; }
            finally { plan.targets = removed; }
          }))); } catch (error) {
            plans.push({ path: row.cwd, thread: row.id, status: row.status, merged: null, lastActive: null, size: null, action: "keep", reason: error instanceof ReclaimTimeout ? "inspect timed out" : `failed: ${String(error)}`, targets: [] });
          }
        }
      }
      const after = await read();
      const result = { dryRun, plans, freedBytes: dryRun ? 0 : after - before, beforeBytes: before, afterBytes: after };
      await this.appendReclaimLog({ at: new Date().toISOString(), reason: "disk pressure", ...result });
      return result;
    }));
  }

  private async restoreDependencies(thread: ThreadRow): Promise<string | null> {
    // Neither seeding nor a clean install may remove dependency files committed by the user.
    if ((await git(["ls-files", "-z", "--", "node_modules", "**/node_modules/**"], { cwd: thread.cwd })).stdout) return "tracked dependency files; automatic dependency restore refused";
    const donors = [...new Set([thread.repo, ...this.rows().filter(t => t.repo === thread.repo && t.cwd !== thread.cwd && t.worktree_shrunk_at === null).map(t => t.cwd), ...pooledWorktrees(dirname(thread.cwd))].filter((p): p is string => !!p))];
    // A partial shrink may leave a matching root stamp and missing workspace installs.
    if (thread.worktree_shrunk_at !== null) await invalidateInstallStamp(thread.cwd);
    // Reuse the same lockfile/freshness-checked CoW path used for new worktrees.
    if (await (this.options.seed ?? seedDependencies)(thread.cwd, donors).catch(() => false)) return null;
    return (this.options.install ?? install)(thread.cwd);
  }

  private async archive(thread: ThreadRow): Promise<string | null | false> {
    const files = (await git(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], { cwd: thread.cwd })).stdout
      .split("\0").filter(Boolean).filter((file) => !regenerable(file));
    if (!files.length) return null;
    const limit = 100 * 1024 * 1024;
    let bytes = 0;
    for (const file of files) {
      bytes += (await lstat(join(thread.cwd, file))).size;
      if (bytes > limit) return false;
    }
    const directory = join(this.home, "checkpoints");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(directory, ".archive-"));
    try {
      const list = join(staging, "files");
      const archive = join(staging, "archive.tar.gz");
      await writeFile(list, files.map((f) => f + "\0").join(""), { mode: 0o600 });
      await writeFile(archive, "", { mode: 0o600 });
      await exec("tar", ["-czf", archive, "--null", "-T", list], { cwd: thread.cwd, timeout: 600_000 });
      await chmod(archive, 0o600);
      if ((await lstat(archive)).size > limit) return false;
      const destination = join(directory, thread.id + ".tar.gz");
      await rename(archive, destination);
      return destination;
    } finally { await rm(staging, { recursive: true, force: true }); }
  }

  /** A closed host removes its ledger as it exits; wait briefly so the busy check sees it gone. */
  private async waitForHostExit(id: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (!readHostLedgers(join(this.home, "hosts")).some((h) => h.threadId === id && isLiveHost(h))) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async restore(thread: ThreadRow): Promise<string | null> {
    if (!this.owns(thread)) return null;
    if (thread.worktree_removed_at == null && thread.repo && !existsSync(thread.cwd)) {
      // Removed outside Loom (a manual `git worktree remove`): the thread's branch is enough to bring it back.
      const branch = `loom/${thread.id.replace(/-/g, "").slice(0, 8)}`;
      if (await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: thread.repo }).then(() => true, () => false)) {
        await git(["worktree", "prune"], { cwd: thread.repo });
        thread = { ...thread, worktree_removed_at: this.store.now(), worktree_branch: branch, worktree_head: null, worktree_archive: null };
      }
    }
    if (thread.worktree_removed_at != null) {
      try {
        if (!thread.repo) throw new Error("thread has no repository");
        if (!existsSync(thread.cwd)) {
          if (!thread.worktree_branch && !thread.worktree_head) throw new Error("thread has no saved branch or HEAD");
          // A stale registration of this path would block the add as surely as a live one.
          await git(["worktree", "prune"], { cwd: thread.repo }).catch(() => undefined);
          // git refuses a branch another checkout holds (a thread that adopted the repo's own branch, which the
          // owner's checkout took back): come back detached at the saved HEAD rather than never come back.
          const busy = thread.worktree_branch ? await branchCheckedOut(thread.repo, thread.worktree_branch) : false;
          const target = thread.worktree_branch && !busy ? [thread.worktree_branch] : ["--detach", thread.worktree_head ?? thread.worktree_branch!];
          // Restores pile up after a restart, so a checkout gets the same time a new thread's does, not git's default.
          try {
            await git(["worktree", "add", "-q", thread.cwd, ...target], { cwd: thread.repo, timeoutMs: 300_000 });
          } catch (error) {
            // A killed checkout leaves a locked, half-written worktree; the next turn would take it for the restored one.
            await git(["worktree", "remove", "--force", "--force", thread.cwd], { cwd: thread.repo }).catch(() => undefined);
            await rm(thread.cwd, { recursive: true, force: true });
            await git(["worktree", "prune"], { cwd: thread.repo }).catch(() => undefined);
            throw error;
          }
        }
        const ref = `refs/loom/checkpoints/${thread.id}`;
        const saved = await git(["show-ref", "--verify", "--quiet", ref], { cwd: thread.repo }).then(() => true).catch((e) => {
          if (e.code === 1) return false;
          throw e;
        });
        // A checkpoint taken on an older HEAD would undo the commits made since; only replay one built on this HEAD.
        const current = saved && (await git(["rev-parse", `${ref}^`], { cwd: thread.cwd })).stdout.trim() === (await git(["rev-parse", "HEAD"], { cwd: thread.cwd })).stdout.trim();
        if (current) {
          // checkout does not delete paths absent from the checkpoint.
          const deleted = (await git(["diff", "--name-only", "--diff-filter=D", "-z", "HEAD", ref, "--"], { cwd: thread.cwd })).stdout.split("\0").filter(Boolean);
          await git(["checkout", ref, "--", "."], { cwd: thread.cwd });
          for (const file of deleted) await rm(join(thread.cwd, file), { force: true });
          await git(["reset", "-q"], { cwd: thread.cwd });
        }
        if (thread.worktree_archive) await exec("tar", ["-xzf", thread.worktree_archive, "-C", thread.cwd], { timeout: 600_000 });
        // The checkout is back; a failed install is reported to the turn, never a reason to block it.
        const error = await this.restoreDependencies(thread).catch((e) => String(e));
        this.store.tx(() => this.store.updateThread(thread.id, { worktree_removed_at: null, worktree_shrunk_at: error ? this.store.now() : null }));
        return error ? `Loom dependency install failed: ${error.replace(/[\r\n]+/g, " ").slice(0, 500)}\n` : null;
      } catch (error) { throw new Error(`Loom worktree recreation failed for ${thread.id}: ${String(error)}`); }
    }
    if (!existsSync(thread.cwd)) throw new Error(`Loom worktree cwd is missing: ${thread.cwd}`);
    if (thread.worktree_shrunk_at === null) return null;
    const error = await this.restoreDependencies(thread).catch((e) => String(e));
    if (!error) this.store.tx(() => this.store.updateThread(thread.id, { worktree_shrunk_at: null }));
    return error ? `Loom dependency install failed: ${error.replace(/[\r\n]+/g, " ").slice(0, 500)}\n` : null;
  }
}

/** Whether any checkout of this repo has `branch` checked out. */
async function branchCheckedOut(repo: string, branch: string): Promise<boolean> {
  const { stdout } = await git(["worktree", "list", "--porcelain"], { cwd: repo });
  return stdout.split("\n").includes(`branch refs/heads/${branch}`);
}

/** Any initialized submodule (at any depth) with changes, untracked files, or ignored files that aren't regenerable. */
async function dirtySubmodule(cwd: string): Promise<boolean> {
  const { stdout } = await git(["submodule", "foreach", "--recursive", "--quiet",
    "git status --porcelain --untracked-files=all; git ls-files --others --ignored --exclude-standard"], { cwd, timeoutMs: 120_000 });
  return stdout.split("\n").some((line) => line.trim() && !regenerable(line.replace(/^.. /, "").trim()));
}

function regenerable(file: string): boolean {
  const parts = file.split("/");
  return parts.some((part) => ["node_modules", ".next", ".turbo", ".expo", "dist", "coverage", ".cache", "__pycache__", ".DS_Store"].includes(part) || part.endsWith(".log")) ||
    parts.some((part, i) => part === ".yarn" && ["cache", "install-state.gz"].includes(parts[i + 1] ?? ""));
}

export async function checkpoint(t: ThreadRow, previousTree?: string) {
  const dir = await mkdtemp(join(tmpdir(), "loom-checkpoint-"));
  const opts = { cwd: t.cwd, env: { GIT_INDEX_FILE: join(dir, "index"), GIT_AUTHOR_NAME: "Loom", GIT_AUTHOR_EMAIL: "loom@localhost", GIT_COMMITTER_NAME: "Loom", GIT_COMMITTER_EMAIL: "loom@localhost" } };
  try {
    await git(["read-tree", "HEAD"], opts);
    await git(["add", "-A"], opts);
    const tree = (await git(["write-tree"], opts)).stdout.trim();
    if (tree === previousTree) return null;
    const parent = (await git(["rev-parse", "HEAD"], opts)).stdout.trim();
    const commit = (await git(["commit-tree", tree, "-p", parent, "-m", `Loom checkpoint ${t.id}`], opts)).stdout.trim();
    await git(["update-ref", `refs/loom/checkpoints/${t.id}`, commit], opts);
    return { tree, commit };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function install(cwd: string): Promise<string | null> {
  // Nothing to install: not a Node project.
  if (!existsSync(join(cwd, "package.json"))) return null;
  const [command, args] = existsSync(join(cwd, "pnpm-lock.yaml")) ? ["pnpm", ["install"]] : existsSync(join(cwd, "yarn.lock")) ? ["yarn", ["install"]] : ["npm", [existsSync(join(cwd, "package-lock.json")) ? "ci" : "install"]];
  return new Promise((resolve) => {
    const child = spawn(command!, args, { cwd, detached: true, stdio: "ignore" });
    const timer = setTimeout(() => { if (child.pid) killGroup(child.pid); resolve("timed out after 10 minutes"); }, 600_000);
    child.once("error", (e) => { clearTimeout(timer); resolve(e.message); });
    child.once("exit", (code) => { clearTimeout(timer); resolve(code === 0 ? null : `exit ${code}`); });
  });
}

/** Never follow a dependency-directory symlink when invalidating an install. */
async function invalidateInstallStamp(cwd: string): Promise<void> {
  const modules = join(cwd, "node_modules");
  const info = await lstat(modules).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info?.isSymbolicLink()) throw new Error("symlinked dependency directory; stamp invalidation refused");
  // Remove fallback freshness records too: partial installs must never seed another tree.
  for (const marker of [".loom-lock", ".package-lock.json", ".modules.yaml", ".yarn-state.yml", ".yarn-integrity"]) {
    await rm(join(modules, marker), { force: true });
  }
}
