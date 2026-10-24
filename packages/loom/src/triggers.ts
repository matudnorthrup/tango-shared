import { askRow, finishAsk } from "./asks.js";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { LoomStore } from "./store.js";

export type TriggerKind = "fan_out" | "time" | "pr" | "command" | "url" | "thread" | "file" | "worker";
export interface TriggerRow {
  ask_id?: string | null;
  id: string; thread_id: string; kind: TriggerKind; spec: string; note: string; dedup_key: string;
  created_at: number; expires_at: number; status: "waiting" | "fired" | "expired" | "cancelled";
  consecutive_errors: number; error_since: number | null;
  fired_at: number | null; detail: string | null; last_checked_at: number | null; last_error: string | null;
}
type Spec = Record<string, string | number | boolean>;
export function normalize(kind: string, input: unknown, cwd: string, now: number): Spec {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("spec must be an object");
  const s = input as Spec;
  const str = (k: string) => { if (typeof s[k] !== "string" || !(s[k] as string).trim()) throw new Error(`${k} is required`); return s[k] as string; };
  const num = (k: string, fallback: number, min: number) => { const n = s[k] ?? fallback; if (typeof n !== "number" || !Number.isFinite(n) || n < min) throw new Error(`Invalid ${k}`); return n; };
  const choice = (k: string, values: string[]) => { const v = str(k); if (!values.includes(v)) throw new Error(`Invalid ${k}`); return v; };
  switch (kind) {
    case "fan_out": return { fanOutId: str("fanOutId") };
    case "worker": {
      if (s.threadId !== undefined) return { threadId: str("threadId") };
      const project = str("project"), task = str("task");
      if (![project, task].every(v => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(v))) throw new Error("Invalid worker reference");
      return { project, task };
    }
    case "time": { if (s.at !== undefined && s.afterMinutes !== undefined) throw new Error("Choose at or afterMinutes"); const at = s.at !== undefined ? Date.parse(str("at")) : now + num("afterMinutes", NaN, 0) * 60_000; if (!Number.isFinite(at)) throw new Error("Invalid time"); return { at: new Date(at).toISOString() }; }
    case "pr": { const repo = str("repo").toLowerCase(); if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid repo"); const number = num("number", NaN, 1); if (!Number.isInteger(number)) throw new Error("Invalid number"); return { repo, number, until: choice("until", ["approved", "merged", "closed", "checks_done", "commented", "codex_reviewed"]) }; }
    case "command": return { command: str("command"), cwd: resolve(cwd, typeof s.cwd === "string" ? s.cwd : "."), intervalSeconds: num("intervalSeconds", 60, 30), timeoutSeconds: Math.min(300, num("timeoutSeconds", 30, 0.001)) };
    case "url": { const url = new URL(str("url")); if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid URL protocol"); const status = num("status", 200, 100); if (!Number.isInteger(status) || status > 599) throw new Error("Invalid status"); return { url: url.href, status }; }
    case "thread": return { threadId: str("threadId"), until: choice("until", ["idle", "run_completed"]) };
    case "file": if (typeof s.exists !== "boolean") throw new Error("exists must be boolean"); return { path: resolve(cwd, str("path")), exists: s.exists };
    default: throw new Error(`Unknown trigger kind ${kind}`);
  }
}
export function describeTrigger(t: Pick<TriggerRow, "kind" | "spec">): string {
  let s: Spec;
  try { s = JSON.parse(t.spec); if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error("Invalid spec"); }
  catch { return "wait target unknown: stored spec is unreadable"; }
  switch (t.kind) {
    case "fan_out": return `waiting for fan-out ${s.fanOutId}`;
    case "worker": return `waiting for worker ${s.threadId ?? `${s.project}/${s.task}`}`;
    case "time": return `waiting until ${s.at}`;
    case "pr": if (s.until === "codex_reviewed") return `waiting for Codex to review PR ${s.repo}#${s.number}'s head`; return `waiting for PR ${s.repo}#${s.number} to be ${s.until}`;
    case "command": return `waiting for command to succeed: ${s.command}`;
    case "url": return `waiting for ${s.url} to return ${s.status}`;
    case "file": return `waiting for ${s.path} to ${s.exists ? "exist" : "disappear"}`;
    case "thread": return `waiting for thread ${s.threadId}: ${s.until}`;
  }
}

/**
 * Codex review passes a thread may wait on for one PR, counted since the owner last spoke. The pass that
 * reaches it tells the thread to apply the merge board, and no further wait on that PR is taken.
 * Measured 2026-10-19: most PRs settle within 5 passes; the two that didn't ran to 31 and 35.
 */
export const CODEX_REVIEW_CAP = 5;
export const CODEX_STALL_MS = 12 * 60_000;

/**
 * The PR a wait is a Codex review of ("owner/repo#n", or "#n" when the wait doesn't name its repo), or null:
 * the wait names Codex and a GitHub PR.
 */
export function codexReviewOf(kind: string, spec: string, note: string): string | null {
  const text = `${spec} ${note}`;
  if (!/codex/i.test(text)) return null;
  if (kind === "pr") { const s = JSON.parse(spec) as Spec; return `${s.repo}#${s.number}`; }
  const path = text.match(/repos\/([\w.-]+\/[\w.-]+)\/(?:pulls|issues)\/(\d+)/i);
  if (path) return `${path[1]!.toLowerCase()}#${path[2]}`;
  const m = text.match(/(?:\/(?:pulls|issues)\/|\bpr (?:checks|view) |\bPR #)(\d+)/i);
  if (!m) return null;
  const repo = text.match(/--repo[ =]([\w.-]+\/[\w.-]+)/)?.[1]?.toLowerCase() ?? "";
  return `${repo}#${m[1]}`;
}

/** Whether two review keys are one PR: the same number, and the same repo unless one of them doesn't say. */
export function samePr(a: string, b: string): boolean {
  const [ra, na] = a.split("#"), [rb, nb] = b.split("#");
  return na === nb && (!ra || !rb || ra === rb);
}

export class CommandExit extends Error {
  constructor(readonly exitCode: number, stderr: string) { super(`Command exited ${exitCode}: ${stderr}`); }
}

/** Async subprocess check with a hard process-group deadline (including descendants). */
export function checkCommand(file: string, args: string[], cwd: string | undefined, timeout: number, signal?: AbortSignal): Promise<string> {
  return new Promise((yes, no) => {
    let timer: ReturnType<typeof setTimeout>;
    const child = spawn(file, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", size = 0, failure: Error | undefined, timedOut = false;
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } };
    const collect = (chunk: Buffer, output: boolean) => {
      size += chunk.length;
      if (size > 1024 * 1024) { failure = new Error("Command output exceeds 1 MiB"); kill(); return; }
      if (output) stdout += chunk.toString(); else stderr += chunk.toString();
    };
    child.stdout.on("data", chunk => collect(chunk, true));
    child.stderr.on("data", chunk => collect(chunk, false));
    child.on("error", error => { failure = error; });
    child.on("close", (code, killedBy) => {
      clearTimeout(timer); signal?.removeEventListener("abort", kill);
      // Killed by its own deadline: still an error (a check that always hangs must not stay silent until the wait's
      // timeout), but it says so, so the woken agent can shorten the command or raise timeoutSeconds.
      if (failure || code !== 0 || signal?.aborted) no(failure ?? (code !== null && !signal?.aborted ? new CommandExit(code, stderr) : new Error(timedOut && !signal?.aborted ? `Command timed out after ${timeout / 1000}s (${killedBy ?? code})${stderr ? `: ${stderr}` : ""}` : `Command failed (${killedBy ?? code}): ${stderr}`)));
      else yes(stdout);
    });
    timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
    signal?.addEventListener("abort", kill, { once: true });
    if (signal?.aborted) kill();
  });
}
export class TriggerService {
  private timer: ReturnType<typeof setInterval>;
  private stopped = false;
  private checking = new Set<string>();
  /** External checks in flight (time checks never count, so they can't starve one). */
  private external = 0;
  private inFlight = new Map<string, Set<AbortController>>();
  private noChecksSince = new Map<string, number>();
  constructor(readonly store: LoomStore, private readonly kick: (id: string) => void,
    private readonly io = { command: checkCommand, fetch: globalThis.fetch, stat }, private readonly codexCap = CODEX_REVIEW_CAP, private readonly codexStallMs = CODEX_STALL_MS) {
    store.db.prepare("UPDATE triggers SET last_checked_at = NULL WHERE status = 'waiting'").run();
    this.timer = setInterval(() => { void this.tick(); }, 1000); this.timer.unref();
    queueMicrotask(() => {
      if (this.stopped) return;
      for (const thread of store.threads()) this.threadChanged(thread.id, false);
      // A run that completed before a crash, after the wait began, still counts: completion is durable, the
      // in-memory notification wasn't.
      for (const t of this.list(undefined, "waiting")) {
        if (t.kind !== "thread") continue;
        const s = JSON.parse(t.spec) as Spec;
        if (s.until === "run_completed" && store.runs(String(s.threadId)).some((r) => (r.status === "completed" || r.status === "failed") && (r.ended_at ?? 0) > t.created_at)) {
          this.finish(t, { threadId: s.threadId, until: s.until });
        }
      }
    });
  }
  close(): void { this.stopped = true; clearInterval(this.timer); for (const controllers of this.inFlight.values()) for (const c of controllers) c.abort(); }
  list(threadId?: string, status?: string): TriggerRow[] {
    return this.store.db.prepare("SELECT * FROM triggers WHERE (? IS NULL OR thread_id = ?) AND (? IS NULL OR status = ?) ORDER BY created_at, rowid").all(threadId ?? null, threadId ?? null, status ?? null, status ?? null) as unknown as TriggerRow[];
  }
  create(threadId: string, kind: string, spec: unknown, note: string, timeoutMinutes = 1440): string {
    const thread = this.store.thread(threadId);
    if (!thread || thread.status === "stopped") throw new Error("Thread missing or stopped");
    if (typeof note !== "string" || !Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0 || timeoutMinutes > 10080) throw new Error("Invalid note or timeoutMinutes");
    const normalized = normalize(kind, spec, thread.cwd, this.store.now());
    const review = codexReviewOf(kind, JSON.stringify(normalized), note);
    if (review && this.codexPasses(threadId, review, true) >= this.codexCap) {
      throw new Error(`Codex review cap reached: ${this.codexCap} passes on PR ${review} since the owner last spoke. Don't wait for another; apply merge-when-green. From pass 3 on, only P1 findings block; move P2 and edge findings to a recorded follow-up, resolve their threads, merge when the recorded facts satisfy the guard, and decision_log. P1 findings remain blocked.`);
    }
    if ((kind === "thread" || kind === "worker" && normalized.threadId) && !this.store.thread(String(normalized.threadId))) throw new Error("Target thread missing");
    const id = randomUUID(), json = JSON.stringify(normalized), now = this.store.now();
    // In a transaction so the thread's change reaches subscribers (the desk) now, not at the next commit.
    this.store.tx(() => {
      this.store.db.prepare("INSERT INTO triggers (id,thread_id,kind,spec,note,dedup_key,created_at,expires_at,status) VALUES (?,?,?,?,?,?,?,?, 'waiting')").run(id, threadId, kind, json, note, `${kind}:${json}`, now, now + timeoutMinutes * 60_000);
      this.store.touchThread(threadId);
    });
    if (kind === "thread") queueMicrotask(() => this.threadChanged(String(normalized.threadId), false));
    return id;
  }
  cancel(id: string): void {
    const t = this.list().find(t => t.id === id); if (!t) throw new Error("Trigger missing");
    this.store.tx(() => {
      this.store.db.prepare("UPDATE triggers SET status = 'cancelled' WHERE id = ? AND status = 'waiting'").run(id);
      this.store.touchThread(t.thread_id);
    });
  }
  cancelThread(id: string): void { for (const c of this.inFlight.get(id) ?? []) c.abort(); for (const t of this.list(id, "waiting")) this.cancel(t.id); }
  /**
   * Codex review waits on this PR since the owner last spoke (their words or a prompt answer, not mail or a wake): fired ones, plus
   * waiting ones when admitting another, so several waits made before any fires can't pass the cap together.
   */
  private codexPasses(threadId: string, review: string, includeWaiting = false): number {
    // Their words are a message, or an answer to a prompt (which leaves no message).
    const spoke = this.store.db.prepare(`SELECT MAX(
      (SELECT COALESCE(MAX(created_at), 0) FROM messages WHERE thread_id = ? AND role = 'user' AND origin IS NULL AND text NOT LIKE '✉️%'),
      (SELECT COALESCE(MAX(resolved_at), 0) FROM requests WHERE thread_id = ? AND status = 'answered')) AS at`).get(threadId, threadId) as { at: number };
    const fired = this.store.db.prepare("SELECT kind, spec, note FROM triggers WHERE thread_id = ? AND ((status = 'fired' AND fired_at > ? AND json_extract(detail, '$.error') IS NULL) OR (? AND status = 'waiting'))").all(threadId, spoke.at, includeWaiting ? 1 : 0) as unknown as Pick<TriggerRow, "kind" | "spec" | "note">[];
    return fired.filter((t) => { const r = codexReviewOf(t.kind, t.spec, t.note); return r !== null && samePr(r, review); }).length;
  }
  private disabled(threadId: string): boolean {
    const profile = this.store.thread(threadId)?.session_profile;
    if (profile && JSON.parse(profile).loomTools === false) {
      this.cancelThread(threadId);
      return true;
    }
    return false;
  }
  finishFanOut(t: TriggerRow, message: string): void { this.finish(t, { message }); }
  private finish(t: TriggerRow, detail: unknown, expired = false): void {
    if (this.stopped || this.disabled(t.thread_id)) return;
    let queued = false;
    this.store.tx(() => {
      const owner = this.store.thread(t.thread_id);
      if (!owner || owner.status === "stopped") { this.cancelThread(t.thread_id); return; }
      const changed = this.store.db.prepare("UPDATE triggers SET status=?, fired_at=?, detail=? WHERE id=? AND status='waiting'").run(expired ? "expired" : "fired", expired ? null : this.store.now(), JSON.stringify(detail), t.id);
      if (!changed.changes) return;
      if (t.ask_id) {
        const ask = askRow(this.store, t.ask_id);
        if (!ask || ask.status !== "open") return;
        if (expired || (detail as { error?: string } | null)?.error) {
          // A failed check is not evidence that the named record resolved.
          this.store.createRun(t.thread_id, "wake", `Loom: resolution check for ask ${ask.id} failed: ${JSON.stringify(detail)}. The ask remains open.`);
        } else {
          finishAsk(this.store, ask.id, "resolved", `record:${t.id}`);
          this.store.createRun(t.thread_id, "wake", `Loom: Ask ${ask.id} resolved: ${ask.text}. Record ${t.id}: ${brief(t.kind, detail)}`);
        }
        this.store.updateThread(t.thread_id, { settled_at: null }); queued = true;
        return;
      }
      const review = expired || (detail as { error?: string } | null)?.error ? null : codexReviewOf(t.kind, t.spec, t.note);
      const pass = review ? this.codexPasses(t.thread_id, review) : 0;
      const cap = !review ? "" : pass >= this.codexCap
        ? ` Loom: this is Codex review pass ${pass} on PR ${review} since the owner last spoke, the cap. Don't ask Codex for another review. Apply merge-when-green: from pass 3 on, only P1 findings block; move P2 and edge findings to a recorded follow-up, resolve their threads, merge when the recorded facts satisfy the guard, and decision_log. P1 findings remain blocked; check their decision class before raising a brief.`
        : ` Loom: Codex review pass ${pass} of at most ${this.codexCap} on PR ${review} before you apply the merge-when-green guard.${pass >= 3 ? " From this pass, only P1 findings block; move P2 and edge findings to a recorded follow-up and resolve their threads." : ""}`;
      this.store.createRun(t.thread_id, "wake", (t.kind === "fan_out" ? (detail as { message: string }).message : `Loom: ${expired ? "the wait timed out" : "the trigger you set fired"}: ${describeTrigger(t)}. Your note: ${t.note}. Details: ${brief(t.kind, detail)}${cap}`));
      this.store.updateThread(t.thread_id, { settled_at: null }); queued = true;
    });
    if (queued) this.kick(t.thread_id);
  }
  threadChanged(id: string, runCompleted: boolean): void {
    if (this.stopped) return;
    this.disabled(id);
    for (const t of this.list(undefined, "waiting")) {
      if (t.kind !== "thread") continue;
      const s = JSON.parse(t.spec) as Spec;
      if (s.threadId === id && (s.until === "run_completed" ? runCompleted : this.idle(id))) this.finish(t, { threadId: id, until: s.until });
    }
  }
  /** Idle with nothing queued: a run Loom holds before it starts (mail's minute, waiting for room) is work to come (10/20). */
  private idle(id: string): boolean {
    return this.store.thread(id)?.status === "idle" && !this.store.runs(id).some((r) => r.status === "queued");
  }
  async tick(): Promise<void> {
    if (this.stopped) return;
    const groups = new Map<string, TriggerRow[]>(), now = this.store.now();
    for (const t of this.list(undefined, "waiting")) {
      if (this.disabled(t.thread_id) || t.kind === "fan_out") continue;
      if (t.kind === "thread") {
        if (t.expires_at <= now) {
          const s = JSON.parse(t.spec) as Spec;
          this.threadChanged(String(s.threadId), false);
          this.finish(t, { timeout: true }, true);
        }
        continue;
      }
      const key = t.kind === "command" ? `${t.thread_id}:${t.dedup_key}` : t.dedup_key;
      const group = groups.get(key) ?? []; group.push(t); groups.set(key, group);
    }
    const waitingIds = new Set(this.list(undefined, "waiting").map(row => row.id));
    for (const id of this.noChecksSince.keys()) if (!waitingIds.has(id)) this.noChecksSince.delete(id);
    await Promise.all([...groups.entries()].map(async ([key, rows]) => {
      const group = rows.filter(row => !this.disabled(row.thread_id));
      if (!group.length || this.checking.has(key)) return;
      const t = group[0]!, s = JSON.parse(t.spec) as Spec;
      const interval = t.kind === "time" ? 0 : t.kind === "file" ? 30_000 : t.kind === "command" ? Number(s.intervalSeconds) * 1000 : 60_000;
      const last = Math.max(...group.map(t => t.last_checked_at ?? -Infinity));
      if (now - last < interval && !group.some(row => row.expires_at <= now)) return;
      // Time waits never queue behind external checks (owner, 10/20).
      const external = t.kind !== "time";
      if (external && this.external >= 4) return;
      this.checking.add(key);
      if (external) this.external++;
      try {
        let result: unknown, error: string | null = null;
        try { result = await this.evaluate(t, s, group); } catch (e) { error = String(e); }
        if (this.stopped) return;
        const checkedAt = this.store.now();
        this.store.tx(() => {
          for (const row of group) {
            this.store.db.prepare("UPDATE triggers SET last_checked_at=?,last_error=?,consecutive_errors=?,error_since=? WHERE id=? AND status='waiting'").run(checkedAt, error, error ? row.consecutive_errors + 1 : 0, error ? row.error_since ?? checkedAt : null, row.id);
            // A check that starts or stops failing is news for the thread's readers (the Desk shows it), and so is each
            // further failure: the desk reads "failed n of 3" and turns Unknown at 3. At most three, then the wait ends.
            if ((row.last_error ?? null) !== error || error) this.store.touchThread(row.thread_id);
          }
        });
        for (const row of group) {
          const rowResult = result instanceof Map ? result.get(row.id) : result;
          if (error && row.consecutive_errors + 1 >= 3) this.finish(row, { error: `Your ${describeTrigger(row)} cannot be checked: ${error}` });
          else if (rowResult && (t.kind !== "pr" || s.until !== "commented" || (rowResult as { newest: number }).newest > row.created_at)) this.finish(row, rowResult);
          else if (row.expires_at <= this.store.now()) this.finish(row, { timeout: true, error }, true);
        }
      } finally { this.checking.delete(key); if (external) this.external--; }
    }));
  }
  private async evaluate(t: TriggerRow, s: Spec, group: TriggerRow[]): Promise<unknown> {
    switch (t.kind) {
      case "worker": {
        if (s.threadId) {
          const thread = this.store.thread(String(s.threadId));
          if (!thread) throw new Error("Worker thread missing");
          if (this.store.activeRun(thread.id) || this.store.nextQueuedRun(thread.id)) return null;
          // Between turns with its own wait armed (CI, a deploy), its task is still in progress (Codex review on #926).
          if (thread.parent_thread_id === `loom:${t.thread_id}` && thread.status !== "stopped" && thread.settled_at === null && this.store.hasPendingWait(thread.id)) return null;
          return { threadId: thread.id, status: thread.status };
        }
        const state = JSON.parse(await this.io.command("agentctl", ["status", String(s.project), String(s.task), "--json"], undefined, 30_000));
        const status = state.worker?.status;
        if (typeof status !== "string") throw new Error("Worker status missing");
        if (["running", "queued"].includes(status)) return null;
        if (!["succeeded", "failed", "stale", "cancelled", "canceled", "completed", "interrupted"].includes(status)) throw new Error(`Unknown worker status: ${status}`);
        return { project: s.project, task: s.task, status, error: state.worker?.error ?? state.worker?.failure ?? null };
      }
      case "time": return Date.parse(String(s.at)) <= this.store.now() ? { at: s.at } : null;
      case "command": {
        const controller = new AbortController();
        const controllers = this.inFlight.get(t.thread_id) ?? new Set<AbortController>();
        controllers.add(controller); this.inFlight.set(t.thread_id, controllers);
        try { await this.io.command("sh", ["-c", String(s.command)], String(s.cwd), Math.min(300, Number(s.timeoutSeconds)) * 1000, controller.signal); return controller.signal.aborted ? null : { exitCode: 0 }; }
        catch (e) { if (e instanceof CommandExit) return null; throw e; }
        finally { controllers.delete(controller); if (!controllers.size) this.inFlight.delete(t.thread_id); }
      }
      case "url": { const r = await this.io.fetch(String(s.url), { signal: AbortSignal.timeout(30_000) }); await r.body?.cancel(); if (r.status >= 500 && r.status !== s.status) throw new Error(`URL ${s.url} returned HTTP ${r.status}`); return r.status === s.status ? { status: r.status } : null; }
      case "file": { let exists = true; try { await this.io.stat(String(s.path)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; exists = false; } return exists === s.exists ? { path: s.path, exists } : null; }
      case "pr": {
        if (s.until === "codex_reviewed") return this.evaluateCodex(s, group);
        const p = JSON.parse(await this.io.command("gh", ["pr", "view", String(s.number), "--repo", String(s.repo), "--json", "state,reviewDecision,statusCheckRollup,comments,reviews,mergedAt,closedAt,mergeable"], undefined, 30_000));
        return new Map(group.map(row => [row.id, this.evaluatePr(row, s, p)]));
      }
    }
  }
  private async evaluateCodex(s: Spec, group: TriggerRow[]): Promise<Map<string, unknown>> {
    const { headRefOid: headSha } = JSON.parse(await this.io.command("gh", ["pr", "view", String(s.number), "--repo", String(s.repo), "--json", "headRefOid"], undefined, 30_000));
    if (typeof headSha !== "string" || !/^[a-f0-9]{40}$/i.test(headSha)) throw new Error("PR head SHA missing");
    // Slurp all pages: the summary may be older than the first hundred discussion comments.
    const pages = JSON.parse(await this.io.command("gh", ["api", `repos/${s.repo}/issues/${s.number}/comments`, "--paginate", "--slurp"], undefined, 30_000)) as { body?: string; updated_at?: string; user?: { login?: string } }[][];
    const summary = pages.flat().filter(c => c.user?.login === "chatgpt-codex-connector[bot]" && c.body?.includes("<!-- codex-pull-request-review-summary -->"))
      .sort((a, b) => Date.parse(b.updated_at ?? "") - Date.parse(a.updated_at ?? ""))[0];
    const match = summary?.body?.match(/<!-- codex-review-state:v1 (.*?) -->/);
    const state = match ? JSON.parse(match[1]!).code_review : null;
    const result = new Map<string, unknown>();
    if (state?.commit_sha === headSha && state.status === "completed") {
      for (const row of group) result.set(row.id, { codexSha: state.commit_sha, hasFindings: state.has_any_findings ?? null, hasUnresolvedFindings: state.has_unresolved_findings ?? null, headSha });
      return result;
    }
    const updatedAt = Date.parse(summary?.updated_at ?? "");
    const now = this.store.now();
    const due: TriggerRow[] = [];
    for (const row of group) {
      const progress = row.detail ? JSON.parse(row.detail) as { rerequestedAt?: number } : {};
      if (progress.rerequestedAt !== undefined) {
        if (now - progress.rerequestedAt >= this.codexStallMs) result.set(row.id, { stalled: true, rerequestedAt: progress.rerequestedAt, headSha });
      } else if (now - Math.max(row.created_at, Number.isFinite(updatedAt) ? updatedAt : 0) >= this.codexStallMs) due.push(row);
    }
    if (this.stopped || !due.length) return result;
    // Claim before the external side effect. A crash or ambiguous HTTP failure must not send twice.
    // Identical waits due together share one post, but keep their own durable countdowns.
    let claimed = false;
    this.store.tx(() => {
      for (const row of due) {
        if (this.disabled(row.thread_id)) continue;
        const changed = this.store.db.prepare("UPDATE triggers SET detail=? WHERE id=? AND status='waiting' AND json_extract(detail, '$.rerequestedAt') IS NULL")
          .run(JSON.stringify({ rerequestedAt: now }), row.id);
        if (changed.changes) { claimed = true; this.store.touchThread(row.thread_id); }
      }
    });
    if (claimed) await this.io.command("gh", ["pr", "comment", String(s.number), "--repo", String(s.repo), "--body", "@codex review"], undefined, 30_000);
    return result;
  }
  private evaluatePr(t: TriggerRow, s: Spec, p: {
    mergeable?: string; state?: string; reviewDecision?: string; mergedAt?: string; closedAt?: string;
    statusCheckRollup?: { status?: string; state?: string; conclusion?: string }[];
    comments?: { createdAt: string }[]; reviews?: { state?: string; submittedAt?: string; createdAt?: string }[];
  }): unknown {
    const checks = p.statusCheckRollup ?? [];
    // Per wait, not per dedup key: a later identical wait gets its own ten-minute window.
    const key = t.id;
    const uncertain = checks.length === 0 && ["CONFLICTING", "UNKNOWN"].includes(p.mergeable ?? "");
    if (!uncertain) this.noChecksSince.delete(key);
    else if (!this.noChecksSince.has(key)) this.noChecksSince.set(key, this.store.now());
    if (s.until === "checks_done" && (p.mergeable === "CONFLICTING" || (uncertain && this.store.now() - this.noChecksSince.get(key)! >= 600_000))) {
      return { ...p, conflict: true, note: `PR #${s.number} conflicts with its base, so its checks will never run; rebase it` };
    }
    const newest = Math.max(0, ...(p.reviews ?? []).map(r => Date.parse(r.submittedAt ?? r.createdAt ?? "")).filter(Number.isFinite), ...(p.comments ?? []).map((c: { createdAt: string }) => Date.parse(c.createdAt)));
    const done = checks.length > 0 && checks.every((c: { status?: string; state?: string }) => c.status === "COMPLETED" || ["SUCCESS", "FAILURE", "ERROR"].includes(c.state ?? ""));
    // An approval that can no longer come is news too: the PR merged or closed, or a reviewer asked for changes, since
    // the wait began. Earlier ones were known when it was armed, so they don't fire it again.
    const since = (at?: string) => !!at && Date.parse(at) > t.created_at;
    const ended = since(p.mergedAt) || since(p.closedAt);
    const changes = p.reviewDecision === "CHANGES_REQUESTED" && (p.reviews ?? []).some((r) => r.state === "CHANGES_REQUESTED" && since(r.submittedAt ?? r.createdAt));
    // A wait armed on a PR whose approval already can't come (merged, closed, or changes requested before the wait began)
    // would sit until timeout while its thread reads Waiting. It fires on its first check with the reason, once: a wait
    // this thread re-arms on the same PR after hearing (waiting for a re-review once the fixes are pushed) waits.
    const already = s.until === "approved" && p.reviewDecision !== "APPROVED" && !ended && !changes ? this.alreadySettled(t, p) : null;
    const fire = s.until === "approved" ? p.reviewDecision === "APPROVED" || ended || changes || !!already : s.until === "merged" ? Boolean(p.mergedAt) : s.until === "closed" ? p.state === "CLOSED" || p.state === "MERGED" : s.until === "checks_done" ? done : newest > 0;
    return fire ? { ...p, ...(already ? { note: already } : {}), newest, failedChecks: checks.filter((c: { conclusion?: string; state?: string }) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(c.conclusion ?? c.state ?? "")) } : null;
  }
  private alreadySettled(t: TriggerRow, p: { reviewDecision?: string; mergedAt?: string; closedAt?: string; reviews?: { state?: string; submittedAt?: string; createdAt?: string }[] }): string | null {
    const at = (v?: string) => { const n = Date.parse(v ?? ""); return Number.isFinite(n) ? n : 0; };
    const { number } = JSON.parse(t.spec) as { number: number };
    const asked = Math.max(0, ...(p.reviews ?? []).filter((r) => r.state === "CHANGES_REQUESTED").map((r) => at(r.submittedAt ?? r.createdAt)));
    const [since, note] = p.mergedAt ? [at(p.mergedAt), `PR #${number} was already merged when this wait began, so no approval will come`]
      : p.closedAt ? [at(p.closedAt), `PR #${number} was already closed when this wait began, so no approval will come`]
      : p.reviewDecision === "CHANGES_REQUESTED" ? [asked, `PR #${number} already had changes requested when this wait began; address them, then wait for the re-review`]
      : [0, null];
    if (!note) return null;
    // Heard already: an earlier wait of this thread's on the same PR reported the PR's state after that state began. One
    // that ended on check errors reported nothing.
    const heard = this.store.db.prepare("SELECT 1 FROM triggers WHERE thread_id=? AND dedup_key=? AND status='fired' AND id<>? AND fired_at>=? AND json_extract(detail, '$.error') IS NULL LIMIT 1").get(t.thread_id, t.dedup_key, t.id, since);
    return heard ? null : note;
  }
}

/** The fire details for the wake text: a PR's state without its comment bodies, and never more than 1500 characters. */
function brief(kind: TriggerKind, detail: unknown): string {
  let value = detail;
  if (kind === "pr" && detail && typeof detail === "object") {
    const codex = detail as { stalled?: boolean; codexSha?: string; hasFindings?: boolean | null; hasUnresolvedFindings?: boolean | null };
    if (codex.stalled) return "Codex didn't answer after a re-request; don't request again; apply merge-when-green on the recorded facts.";
    if (codex.codexSha) return `Codex review of ${codex.codexSha.slice(0, 7)} completed: ${codex.hasFindings === false && codex.hasUnresolvedFindings === false ? "clean" : "findings, read the review threads"}`;
    const p = detail as { conflict?: boolean; note?: string; state?: string; reviewDecision?: string; mergedAt?: string; comments?: unknown[]; failedChecks?: { name?: string; context?: string }[] };
    value = { error: (detail as { error?: string }).error, conflict: p.conflict, note: p.note, state: p.state, reviewDecision: p.reviewDecision, mergedAt: p.mergedAt ?? null, comments: p.comments?.length ?? 0,
      failedChecks: (p.failedChecks ?? []).map((c) => c.name ?? c.context ?? "check") };
  }
  const text = JSON.stringify(value);
  return text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
}
