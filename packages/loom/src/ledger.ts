import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { git, redact } from "./git.js";
import { checkpoint } from "./worktrees.js";
import type { LoomStore, ThreadRow } from "./store.js";
import type { BackgroundTask, RuntimeEvent } from "./runtime.js";

const exec = promisify(execFile);
const safe = (s: string) => redact(s).replace(/\b(token|password|secret|api[_-]?key)=\S+/gi, "$1=***").slice(0, 1000);
export interface Inflight { id: string; thread_id: string; kind: string; ref: string; description: string; host_instance_id: string | null; started_at: number; ended_at: number | null; outcome: "done" | "lost" | "cancelled" | null }
interface Effect { id: string; thread_id: string; host_instance_id: string | null; call_id: string; phase: string; status: string; summary: string; check_kind: string | null; at: number }
export interface TimelineEntry { at: number; kind: string; summary: string; ref: string }

/** Classify only outward actions; never execute the supplied command. Payloads are not retained. */
export function classify(name: string, input?: string): { summary: string; check: string | null } | null {
  if (/bash|exec_command|shell|commandexecution/i.test(name)) {
    let command = input ?? "";
    try { const value = JSON.parse(command); command = value.command ?? value.cmd ?? command; } catch { /* plain command */ }
    if (typeof command !== "string") return null;
    const push = /\bgit\s+(?:-C\s+\S+\s+)?push\b/i.test(command);
    const pr = /\bgh\s+pr\s+create\b/i.test(command);
    const merge = /\bgh\s+pr\s+merge\b/i.test(command);
    if (!push && !pr && !merge && !/\bgh\s+(?:pr\s+(?:merge|comment|review|close)|release)\b/i.test(command) &&
      !(/\bgh\s+api\b/i.test(command) && (/(?:-X\s*|--method[=\s]+)["']?(?:POST|PATCH|PUT|DELETE)\b/i.test(command) ||
        // Fields switch gh api to POST unless the method is given as GET.
        (/(?:\s-[fF]\b|\s--(?:raw-)?field\b|\s--input\b)/.test(command) && !/(?:-X\s*|--method[=\s]+)["']?GET\b/i.test(command)))) &&
      !(/\b(?:curl|http)\b/i.test(command) && (/(?:-X\s*|--request[=\s]+|\bhttp\s+)["']?(?:POST|PATCH|PUT|DELETE|HEAD|OPTIONS)\b/i.test(command) || /(?:\s-d|--data|--json)\b/.test(command))) &&
      !/\blaunchctl\s+(?:kickstart|bootstrap|bootout)\b/i.test(command)) return null;
    // Do not persist request bodies, arbitrary shell expansions, or credentials in arguments.
    const action = command.match(/\b(?:git\s+(?:-C\s+\S+\s+)?push|gh\s+(?:pr\s+\w+|release(?:\s+\w+)?|api)|(?:curl|http)|launchctl\s+\w+)/i)?.[0] ?? name;
    const target = command.match(/https?:\/\/[^\s'";|&]+/)?.[0]?.replace(/[?#].*$/, "");
    const summary = safe(`${action}${target ? ` ${target}` : ""}`);
    return { summary, check: push ? "push" : pr ? "pr" : merge ? "merge" : null };
  }
  return /(send|post|create|comment|reply|merge|deploy|publish|delete)/i.test(name) ? { summary: safe(name), check: null } : null;
}

export function coolingNote(tasks: BackgroundTask[]): string | null {
  const watchers = tasks.filter(t => t.ambient);
  return watchers.length ? "Loom paused this idle session to free memory. These watchers were stopped: " + watchers.map(t => `${safe(t.description)} (${safe(t.id)})`).join(", ") + ". Re-create them if you still need them." : null;
}

export function upgradeNote(target: string | null, tasks: BackgroundTask[]): string | null {
  if (!tasks.length) return null;
  const named = (list: BackgroundTask[]) => list.map(t => `${safe(t.description)} (${t.id})`).join(", ");
  const work = tasks.filter(t => !t.ambient), watchers = tasks.filter(t => t.ambient);
  return [work.length ? `Loom moved this session to release ${target} after its maximum host age. Background tasks cut off: ${named(work)}. Resume that work.` : `Loom moved this session to release ${target}.`, watchers.length ? `These watchers were stopped: ${named(watchers)}. Re-create them if you still need them.` : null].filter(Boolean).join(" ");
}

/** Capture only the canonical PR URL, never arbitrary tool output. */
export function createdPrUrl(output: string): string | null {
  const match = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\b/i.exec(output);
  return match ? `https://github.com/${match[1]}/${match[2]}/pull/${Number(match[3])}` : null;
}

export class Ledger {
  private checkpoints = new Map<string, Promise<void>>();
  constructor(readonly store: LoomStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS inflight (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, ref TEXT NOT NULL, description TEXT NOT NULL, host_instance_id TEXT,
      started_at INTEGER NOT NULL, ended_at INTEGER, outcome TEXT);
      CREATE INDEX IF NOT EXISTS inflight_thread ON inflight(thread_id, ended_at);
      CREATE TABLE IF NOT EXISTS side_effects (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      host_instance_id TEXT, call_id TEXT NOT NULL, phase TEXT NOT NULL, status TEXT NOT NULL,
      summary TEXT NOT NULL, check_kind TEXT, at INTEGER NOT NULL,
      UNIQUE(thread_id, call_id, phase));
      CREATE TABLE IF NOT EXISTS timeline_events (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      at INTEGER NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, ref TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      at INTEGER NOT NULL, tree TEXT NOT NULL, ref TEXT NOT NULL);`);
    if (!(store.db.prepare("PRAGMA table_info(side_effects)").all() as unknown as { name: string }[]).some(c => c.name === "pr_url")) store.db.exec("ALTER TABLE side_effects ADD COLUMN pr_url TEXT");
  }
  legacyPrCreates(id: string): Array<{ id: string; at: number }> {
    return this.store.db.prepare("SELECT id, at FROM side_effects WHERE thread_id = ? AND phase = 'result' AND status = 'completed' AND check_kind = 'pr' AND pr_url IS NULL").all(id) as unknown as Array<{ id: string; at: number }>;
  }
  /** When this thread last ran `gh pr merge` successfully, so the desk can re-read its PRs at once. */
  lastPrMergeAt(id: string): number | null {
    return (this.store.db.prepare("SELECT MAX(at) AS at FROM side_effects WHERE thread_id = ? AND phase = 'result' AND status = 'completed' AND check_kind = 'merge'").get(id) as { at: number | null }).at;
  }
  openedPrUrls(id: string): string[] {
    return (this.store.db.prepare("SELECT DISTINCT pr_url FROM side_effects WHERE thread_id = ? AND pr_url IS NOT NULL").all(id) as unknown as { pr_url: string }[]).map(r => r.pr_url);
  }
  rows(id: string): Inflight[] { return this.store.db.prepare("SELECT * FROM inflight WHERE thread_id = ? ORDER BY started_at, rowid").all(id) as unknown as Inflight[]; }
  start(thread: ThreadRow, kind: string, ref: string, description: string) {
    if (this.rows(thread.id).some(r => r.ref === ref && r.kind === kind && r.ended_at === null)) return;
    this.store.db.prepare("INSERT INTO inflight VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)").run(randomUUID(), thread.id, kind, ref, safe(description), thread.host_instance_id, this.store.now());
  }
  end(id: string, ref: string, outcome: Inflight["outcome"]) { this.store.db.prepare("UPDATE inflight SET ended_at = ?, outcome = ? WHERE thread_id = ? AND ref = ? AND ended_at IS NULL").run(this.store.now(), outcome, id, ref); }
  background(thread: ThreadRow, tasks: BackgroundTask[]) {
    for (const row of this.rows(thread.id).filter(r => r.kind !== "turn" && r.ended_at === null)) if (!tasks.some(t => t.id === row.ref)) this.end(thread.id, row.ref, "done");
    for (const task of tasks) this.start(thread, task.ambient ? "watcher" : task.kind, task.id, task.description);
  }
  tool(thread: ThreadRow, event: Extract<RuntimeEvent, { type: "tool.updated" }>) {
    try {
      const previous = this.store.db.prepare("SELECT * FROM side_effects WHERE thread_id = ? AND call_id = ? AND phase = 'intent'").get(thread.id, event.itemId) as unknown as Effect | undefined;
      const action = previous ? { summary: previous.summary, check: previous.check_kind } : classify(event.name, event.input);
      if (!action) return;
      const phase = event.status === "running" ? "intent" : "result";
      this.store.db.prepare("INSERT OR IGNORE INTO side_effects (id, thread_id, host_instance_id, call_id, phase, status, summary, check_kind, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), thread.id, thread.host_instance_id, event.itemId, phase, event.status, action.summary, action.check, this.store.now());
      const url = phase === "result" && event.status === "completed" && action.check === "pr" ? createdPrUrl(event.output ?? "") : null;
      if (url) this.store.db.prepare("UPDATE side_effects SET pr_url = ? WHERE thread_id = ? AND call_id = ? AND phase = 'result'").run(url, thread.id, event.itemId);
    } catch (error) { console.warn("Side-effect classifier failed", safe(String(error))); }
  }
  event(id: string, kind: string, summary: string, ref: string) { this.store.db.prepare("INSERT INTO timeline_events VALUES (?, ?, ?, ?, ?)").run(id, this.store.now(), kind, safe(summary), ref); }
  async recover(thread: ThreadRow): Promise<string> {
    const lost = this.rows(thread.id).filter(r => r.ended_at === null);
    const notes = lost.filter(r => r.kind !== "turn").map(r => `Lost ${r.kind}: ${r.description} (${r.ref}).`);
    const effects = this.store.db.prepare(`SELECT * FROM side_effects i WHERE thread_id = ? AND phase = 'intent'
      AND NOT EXISTS (SELECT 1 FROM side_effects r WHERE r.thread_id = i.thread_id AND r.call_id = i.call_id AND r.phase = 'result')`).all(thread.id) as unknown as Effect[];
    for (const effect of effects) {
      let checked = "";
      try {
        const opts = { cwd: thread.cwd, timeoutMs: 10_000 };
        const branch = (await git(["symbolic-ref", "--short", "HEAD"], opts)).stdout.trim();
        if (effect.check_kind === "push") {
          const local = (await git(["rev-parse", "HEAD"], opts)).stdout.trim();
          const remote = (await git(["ls-remote", "origin", `refs/heads/${branch}`], opts)).stdout.trim().split(/\s+/)[0];
          checked = ` Checked origin/${branch}: ${remote === local ? "pushed (matches local HEAD)" : "not pushed (does not match local HEAD)"}.`;
        } else if (effect.check_kind === "pr") {
          const result = await exec("gh", ["pr", "list", "--head", branch, "--json", "number,url,state"], { cwd: thread.cwd, timeout: 10_000, maxBuffer: 64 * 1024 });
          checked = ` Checked PRs: ${safe(result.stdout)}.`;
        }
      } catch { checked = " Check unavailable."; }
      notes.push(`outcome unknown, check before redoing: ${effect.summary}.${checked}`);
      // Reported once: a later restart doesn't wake the thread about the same action again.
      this.store.db.prepare("INSERT OR IGNORE INTO side_effects (id, thread_id, host_instance_id, call_id, phase, status, summary, check_kind, at) VALUES (?, ?, ?, ?, 'result', 'unknown', ?, ?, ?)")
        .run(randomUUID(), thread.id, effect.host_instance_id, effect.call_id, effect.summary, effect.check_kind, this.store.now());
    }
    return notes.length ? "\n" + notes.join("\n") : "";
  }
  lose(threadId: string) {
    for (const row of this.rows(threadId)) if (row.ended_at === null) this.end(threadId, row.ref, "lost");
  }
  private again = new Set<string>();
  checkpoint(thread: ThreadRow): Promise<void> {
    // One already running may have scanned files before this turn changed them: run once more after it.
    if (this.checkpoints.has(thread.id)) { this.again.add(thread.id); return this.checkpoints.get(thread.id)!; }
    const work = (async () => {
      const last = this.store.db.prepare("SELECT * FROM checkpoints WHERE thread_id = ? ORDER BY at DESC LIMIT 1").get(thread.id) as { at: number; tree: string } | undefined;
      const saved = await checkpoint(thread, last && this.store.now() - last.at < 120_000 ? last.tree : undefined);
      if (saved && this.store.thread(thread.id)) this.store.db.prepare("INSERT INTO checkpoints VALUES (?, ?, ?, ?)").run(thread.id, this.store.now(), saved.tree, saved.commit);
    })().catch(error => { console.warn("Turn checkpoint failed", safe(String(error))); }).finally(() => {
      this.checkpoints.delete(thread.id);
      if (this.again.delete(thread.id)) { const current = this.store.thread(thread.id); if (current) void this.checkpoint(current); }
    });
    this.checkpoints.set(thread.id, work);
    return work;
  }
  async drain() { await Promise.all(this.checkpoints.values()); }
  timeline(id: string): TimelineEntry[] {
    const events: TimelineEntry[] = [];
    const add = (at: number, kind: string, summary: string, ref: string) => events.push({ at, kind, summary, ref });
    for (const r of this.store.runs(id)) { add(r.started_at ?? r.created_at, "run", `Run ${r.status}: started`, r.id); if (r.ended_at !== null) add(r.ended_at, "run", `Run ${r.status}: ended`, r.id); }
    for (const a of this.store.db.prepare("SELECT * FROM attempts WHERE thread_id = ?").all(id) as unknown as { id: string; started_at: number; ended_at: number | null; account: string; status: string }[]) { add(a.started_at, "attempt", `${a.account}: ${a.status}`, a.id); if (a.ended_at !== null) add(a.ended_at, "attempt", `Attempt ended: ${a.status}`, a.id); }
    for (const a of this.store.accountHistory(id)) add(a.at, "account", `${a.reason}: ${a.account}`, a.account);
    for (const r of this.rows(id)) { add(r.started_at, "ledger", `${r.kind}: ${r.description}`, r.id); if (r.ended_at !== null) add(r.ended_at, "ledger", `${r.outcome}: ${r.description}`, r.id); }
    for (const e of this.store.db.prepare("SELECT * FROM side_effects WHERE thread_id = ?").all(id) as unknown as Effect[]) add(e.at, "side_effect", `${e.status}: ${e.summary}`, e.id);
    for (const c of this.store.db.prepare("SELECT * FROM checkpoints WHERE thread_id = ?").all(id) as unknown as { at: number; ref: string }[]) add(c.at, "checkpoint", "Worktree checkpoint", c.ref);
    events.push(...this.store.db.prepare("SELECT at, kind, summary, ref FROM timeline_events WHERE thread_id = ?").all(id) as unknown as TimelineEntry[]);
    return events.sort((a, b) => a.at - b.at).slice(-500);
  }
}
