/**
 * The wait-keeper (docs/specs/system-visibility.md, "Promises to come back"): every 30 minutes it looks for
 * promises to come back that nothing will keep, wakes each promiser once, and flags the rest on the System page.
 *
 * - A Loom wait past its time that never fired, or a run queued on a thread that isn't running: Loom's own
 *   machinery stalled. The first is woken once; both are warnings. A run Loom is holding on purpose (the
 *   thread's daily budget or its account's limit, until a set time) is info; one held by the machine's limits
 *   stays a warning, naming the limit.
 * - A desk conversation (Loom) watching for something with no wait behind it, a day old or past the
 *   desk's own overdue mark: woken once with its promise quoted. Still stuck a day after that: a warning.
 * - Waits on people (a teammate's review) and on Discord agents: flagged only (info), never woken.
 * - Desk mail queued for hours, or sent and unanswered for a day: flagged only (info).
 *
 * No model calls. It never wakes a running thread or one with a question pending, never answers a question,
 * and never wakes the same promise twice (state file + an idempotent desk command id). Findings that clear
 * resolve their incident on the next run.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Fetch } from "./exec.js";
import { tx } from "./ledger.js";
import { fingerprint } from "./fingerprint.js";
import { recordEvent } from "./incidents.js";
import type { Ledger } from "./types.js";

export const WAIT_KEEPER_JOB = "launchd:com.tango.wait-keeper";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A promise with nothing behind it is overdue after a day (sooner when the desk already says so). */
export const PROMISE_GRACE_MS = DAY;
/** A woken promise that still hasn't moved after this is "stuck": a warning, never a second wake. */
export const STUCK_AFTER_WAKE_MS = DAY;
/** Loom checks its waits every few seconds; this much past due means it missed one. */
export const LOOM_MISS_MS = 10 * MINUTE;
export const LOOM_QUEUE_MS = 10 * MINUTE;
export const QUESTION_ACTIVE_MS = 6 * HOUR;
export const MAIL_QUEUED_MS = 6 * HOUR;
export const MAIL_UNANSWERED_MS = DAY;
/** Mail the desk gave up on (unanswered) stays flagged this long after it was written. */
export const MAIL_UNANSWERED_KEEP_MS = 7 * DAY;
export const MAX_WAKES_PER_RUN = 5;
const STATE_KEEP_MS = 14 * DAY;

export type FindingKind = "wait.loom-error" | "wait.loom-missed" | "wait.loom-queued" | "wait.overdue" | "wait.stuck" | "wait.person" | "wait.mail" | "wait.question";

export interface Finding {
  kind: FindingKind;
  severity: "info" | "warning";
  /** Stable per promise: the incident's identity on the System page. */
  title: string;
  detail: string;
  /** The promise this is about (a wake's dedup key): kept in the state file as long as it is still found. */
  key?: string;
  question?: { itemId: string; text: string; requestId: string | null };
  /** A wake to send (once): the desk item and the turn's text. */
  wake?: { key: string; itemId: string; text: string };
}

export interface LoomWait {
  last_error?: string | null;
  error_since?: number | null;
  last_checked_at?: number | null;
  id: string;
  thread_id: string;
  kind: string;
  spec: string;
  note: string;
  created_at: number;
  expires_at: number;
}
export interface LoomThread {
  id: string;
  title: string | null;
  status: string;
  /** Questions or approvals it is stopped on (Loom's snapshot). */
  open_requests?: number;
  /** Why Loom is holding its queued runs: "budget" or "account_limit" until `admission_until`, or a machine limit. */
  admission?: string | null;
  admission_until?: number | null;
}
export interface QueuedRun {
  thread_id: string;
  created_at: number;
}
export interface PendingAsk { requestId: string | null; question: string; at: number }
export interface OpenBrief { id: string; thread_id: string; ask: string; created_at: number }
export interface ActiveInterval { start: number; last: number }

/** The fields of a desk List row (GET /api/desk/items) the keeper reads. */
export interface DeskRow {
  id: string;
  source: string;
  disposition?: string;
  place?: string | null;
  title?: string | null;
  status?: { busy?: unknown; move?: string | null; basis?: string } | null;
  facts?: { pending?: PendingAsk | null; openBrief?: PendingAsk | null; openAsk?: { text: string; at: number } | null; running?: unknown; lastAgentWords?: { at: number } | null } | null;
  watching?: {
    reason: string;
    basis: string;
    waitingOn?: { who: string; what: string; since: number; kind?: string } | null;
    overdue?: { kind: string; since: number; text: string } | null;
  } | null;
}
export interface MailRow {
  to_item: string;
  to_title: string;
  from_title: string;
  state: string;
  created_at: number;
  sent_at: number | null;
}

export interface KeeperState {
  /** Promise key → when it was woken (ms). */
  woke: Record<string, number>;
  /** Once-only owner escalations, retained across resolved incidents and ledger pruning. */
  raised?: Record<string, number>;
  /** Proven active time survives presence retention, including before escalation. */
  questionTime?: Record<string, { active: number; through: number }>;
}

export interface KeeperInput {
  now: number;
  /** Each null where that Loom source couldn't be read this run (its findings keep their last state); null: none was. */
  loom: { waits: LoomWait[] | null; threads: LoomThread[] | null; queued: QueuedRun[] | null } | null;
  /** null: the desk couldn't be read. */
  desk: { rows: DeskRow[]; pending: Set<string> } | null;
  mail: MailRow[] | null;
  /** Loom presence intervals; missing readings never imply elapsed wall time. */
  presence?: ActiveInterval[] | null;
  briefs?: OpenBrief[] | null;
  state: KeeperState;
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const day = (ms: number) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
function ago(ms: number): string {
  const h = Math.round(ms / HOUR);
  return h >= 48 ? `${Math.round(h / 24)} days` : h >= 1 ? `${h} h` : `${Math.max(1, Math.round(ms / MINUTE))} min`;
}
/** Loom holds that end at a set time (packages/loom/src/host.ts budgetGate, account limits). */
const HELD_UNTIL: Record<string, string> = { budget: "for its daily budget", account_limit: "for its account's limit" };
/** Loom holds for the machine's limits (host.ts admit), with no set end. */
const MACHINE_LIMIT: Record<string, string> = { recovery_unhealthy: "recovery storage is low or replication is behind", disk_low: "disk space is low", memory: "memory is low", host_cap: "too many hosts are warm" };
const rowTitle = (r: DeskRow) => r.place || r.title || r.id;

/** When a Loom wait is due: a time wait's moment, otherwise its expiry (Loom wakes the thread on timeout too). */
export function loomDueAt(w: LoomWait): number {
  if (w.kind === "time") {
    try {
      const at = Date.parse(String((JSON.parse(w.spec) as { at?: string }).at));
      if (Number.isFinite(at)) return Math.min(at, w.expires_at);
    } catch {
      /* fall through to the expiry */
    }
  }
  return w.expires_at;
}

export function wakeText(promise: string, since: number, now: number): string {
  return [
    `⏰ Wait-keeper: on ${day(since)} you said you'd come back to this: "${clip(promise, 400)}"`,
    `Nothing is registered to bring you back (no Loom wait, PR watch or job), and it's been ${ago(now - since)}.`,
    `Pick it up now: finish it, register a wait (loom.wait_for, or tango-screen watch-pr for a review), or say it's closed. This is the only reminder for this promise.`,
  ].join("\n\n");
}

/** Everything the keeper would flag and wake this run. Pure: the runner does the I/O. */
export function assess(input: KeeperInput): { findings: Finding[]; questionTime: NonNullable<KeeperState["questionTime"]> } {
  const { now, state } = input;
  const findings: Finding[] = [];
  const questionTime = { ...state.questionTime };
  const threads = new Map((input.loom?.threads ?? []).map((t) => [t.id, t]));
  // The runner reads only waiting triggers, across every Loom wait kind.
  const coveredItems = new Set((input.loom?.waits ?? []).map((w) => `loom:${w.thread_id}`));

  // Each Loom source on its own: one that failed doesn't hide the others' findings (Codex review on #770).
  if (input.loom?.waits) {
    for (const w of input.loom.waits) {
      if (w.last_error && now - (w.error_since ?? w.last_checked_at ?? now) > 30 * MINUTE) {
        findings.push({ kind: "wait.loom-error", severity: "warning", key: `loom-error:${w.id}`,
          title: `Loom wait check failing: ${clip(threads.get(w.thread_id)?.title || w.thread_id.slice(0, 8), 80)}`,
          detail: `Wait ${w.id} (${w.kind}): ${clip(w.last_error, 400)}` });
      }
      const due = loomDueAt(w);
      if (now - due < LOOM_MISS_MS) continue;
      const thread = threads.get(w.thread_id);
      const name = thread?.title || w.thread_id.slice(0, 8);
      const key = `loom-wait:${w.id}`;
      // Stopped on a question: a wake would queue a turn behind it (Codex review on #770).
      const asking = (thread?.open_requests ?? 0) > 0 || !!input.desk?.pending.has(`loom:${w.thread_id}`);
      findings.push({
        key,
        kind: "wait.loom-missed",
        severity: "warning",
        title: `Loom wait never fired: ${clip(name, 80)}`,
        detail: `Wait ${w.id} (${w.kind}) was due ${day(due)}, ${ago(now - due)} ago, and is still waiting: ${clip(w.note, 200)}`,
        ...(thread && thread.status !== "running" && !asking && !state.woke[key]
          ? { wake: { key, itemId: `loom:${w.thread_id}`, text: wakeText(w.note, w.created_at, now) } }
          : {}),
      });
    }
  }
  // A queued run is only stuck on a thread known not to be running: it needs the snapshot too.
  if (input.loom?.queued && input.loom.threads) {
    const oldest = new Map<string, number>();
    for (const r of input.loom.queued) oldest.set(r.thread_id, Math.min(oldest.get(r.thread_id) ?? Infinity, r.created_at));
    for (const [threadId, at] of oldest) {
      const thread = threads.get(threadId);
      if (now - at < LOOM_QUEUE_MS || thread?.status === "running") continue;
      const name = clip(thread?.title || threadId.slice(0, 8), 80);
      const queuedFor = `A run has been queued on ${threadId} since ${day(at)} (${ago(now - at)})`;
      const until = thread?.admission_until ?? 0;
      // 10/20: a thread over its daily budget read as "Loom isn't opening its host" for 4 h. That hold is on purpose.
      if (thread?.admission && HELD_UNTIL[thread.admission] && until > now) {
        findings.push({
          kind: "wait.loom-queued",
          severity: "info",
          title: `Loom run held: ${name}`,
          detail: `${queuedFor}. Loom is holding it ${HELD_UNTIL[thread.admission]} and runs it at ${day(until)}.`,
        });
        continue;
      }
      const limit = thread?.admission ? MACHINE_LIMIT[thread.admission] : undefined;
      findings.push({
        kind: "wait.loom-queued",
        severity: "warning",
        title: `Loom run stuck in queue: ${name}`,
        detail: `${queuedFor} and the thread isn't running. ${limit ? `Loom is holding it: ${limit}.` : "Loom isn't opening its host."}`,
      });
    }
  }

  if (input.desk) {
    const { rows, pending } = input.desk;
    for (const r of rows) {
      const w = r.watching;
      if (!w || (r.disposition && r.disposition !== "active")) continue;
      // The desk projects admission holds into summary watches. Their text comes
      // from Loom, not the agent; queue/hold health is assessed separately above.
      if (r.status?.basis === "source:held") continue;
      // Backed by something that will fire: a Loom wait or monitor, a scheduled job.
      if (w.basis !== "summary" && w.basis !== "person") continue;
      const on = w.waitingOn ?? null;
      const name = clip(rowTitle(r), 80);
      if (on && on.kind !== "agent") {
        // A person: the owner's to nudge, never the keeper's.
        if (w.overdue) findings.push({ kind: "wait.person", severity: "info", title: `Waiting on people: ${name}`, detail: `${clip(on.what, 160)} from ${on.who}, since ${day(on.since)}: ${w.overdue.text}` });
        continue;
      }
      // A summary can lag behind wait registration. Trust the active triggers directly;
      // missed or failing waits are diagnosed above, not as uncovered promises.
      if (r.source === "loom" && coveredItems.has(r.id)) continue;
      const since = on?.since ?? r.facts?.lastAgentWords?.at ?? null;
      if (since == null) continue;
      if (!w.overdue && now - since < PROMISE_GRACE_MS) continue;
      const promise = on ? `${w.reason} (waiting on ${on.who}: ${on.what})` : w.reason;
      const key = `promise:${r.id}@${since}`;
      const wokeAt = state.woke[key];
      if (wokeAt != null) {
        if (now - wokeAt >= STUCK_AFTER_WAKE_MS) {
          findings.push({ key, kind: "wait.stuck", severity: "warning", title: `Still waiting after a wake: ${name}`, detail: `Woken ${day(wokeAt)} about "${clip(promise, 200)}"; nothing has moved since.` });
        } else {
          findings.push({ key, kind: "wait.overdue", severity: "info", title: `Overdue promise: ${name}`, detail: `Woken ${day(wokeAt)}; waiting for it to pick up. "${clip(promise, 200)}"` });
        }
        continue;
      }
      // A late check-back the desk wakes itself (DeskCore.maybeWakeOverdue): flagged here, never woken twice (Codex review on #770).
      const deskWakes = w.overdue?.kind === "check-back";
      const wakeable = r.source === "loom" && !deskWakes && !r.status?.busy && !r.facts?.running && !pending.has(r.id);
      findings.push({
        key,
        kind: "wait.overdue",
        severity: "info",
        title: `Overdue promise: ${name}`,
        detail: `Since ${day(since)} (${ago(now - since)}), nothing registered: "${clip(promise, 200)}"${wakeable ? "" : r.source !== "loom" ? " · flagged only (not a Loom thread)" : deskWakes ? " · the desk wakes late check-backs itself" : " · not woken: busy or a question is pending"}`,
        ...(wakeable ? { wake: { key, itemId: r.id, text: wakeText(promise, since, now) } } : {}),
      });
    }
  }

  // Read only original asks, not the carried copies on leads. The brief's normal routing stays intact.
  if (input.desk && input.presence) {
    const seen = new Set<string>();
    for (const r of input.desk.rows) {
      if (r.disposition && r.disposition !== "active") continue;
      const facts = r.facts;
      const asks = [facts?.pending, facts?.openBrief].filter((q): q is PendingAsk => !!q);
      for (const b of input.briefs ?? []) {
        if (r.id === `loom:${b.thread_id}`) asks.push({ requestId: `decision:${b.id}`, question: b.ask, at: b.created_at });
      }
      // Prose mentioning a brief is its relay, not another question to escalate.
      if (!asks.length && r.status?.move === "needs" && facts?.openAsk && !/\bD-\d+\b/.test(facts.openAsk.text)) {
        asks.push({ requestId: null, question: facts.openAsk.text, at: facts.openAsk.at });
      }
      for (const q of asks) {
        if (!Number.isFinite(q.at)) continue;
        const key = q.requestId ? `question:${r.id}:${q.requestId}` : `question:${r.id}:${q.at}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const prior = questionTime[key] ?? { active: 0, through: q.at };
        // Checkpoint at proven presence, not wall time: a live interval can extend
        // on the next beat, and that extension must still count after a restart.
        const active = prior.active + input.presence.reduce((sum, p) => sum + Math.max(0, Math.min(now, p.last) - Math.max(q.at, prior.through, p.start)), 0);
        const through = input.presence.reduce((last, p) => Math.max(last, Math.min(now, p.last)), prior.through);
        questionTime[key] = { active, through };
        if (active <= QUESTION_ACTIVE_MS && !state.raised?.[key]) continue;
        const queued = input.mail?.filter((m) => m.to_item === r.id && m.state === "queued").length;
        findings.push({
          key, kind: "wait.question", severity: "warning",
          // Identity must survive title edits and brief revisions, and distinguish subsequent asks.
          title: `Question waiting for you: ${clip(rowTitle(r), 80)}`,
          question: { itemId: r.id, text: clip(q.question, 300), requestId: q.requestId },
          detail: `${rowTitle(r)}: ${clip(q.question, 400)} — unanswered after ${ago(active)} of your active time.${queued ? ` ${queued} queued mail message${queued === 1 ? "" : "s"} behind this thread.` : ""} Open ${q.requestId?.match(/^decision:D-\d+$/) ? `brief ${q.requestId.slice(9)}` : r.id} on the desk. Raised once; no reminder or automatic answer.`,
        });
      }
    }
  }

  if (input.mail) {
    const byTarget = new Map<string, { title: string; queued: MailRow[]; unanswered: MailRow[] }>();
    for (const m of input.mail) {
      const queued = m.state === "queued" && now - m.created_at >= MAIL_QUEUED_MS;
      // Still sent a day on, or given up on (unanswered) within the week: flagged until it ages out (Codex review on #770).
      const unanswered = (m.state === "sent" && now - (m.sent_at ?? m.created_at) >= MAIL_UNANSWERED_MS) || (m.state === "unanswered" && now - m.created_at < MAIL_UNANSWERED_KEEP_MS);
      if (!queued && !unanswered) continue;
      const g = byTarget.get(m.to_item) ?? { title: m.to_title, queued: [], unanswered: [] };
      (queued ? g.queued : g.unanswered).push(m);
      byTarget.set(m.to_item, g);
    }
    for (const [to, g] of byTarget) {
      const all = [...g.queued, ...g.unanswered];
      const oldest = Math.min(...all.map((m) => m.created_at));
      const senders = [...new Set(all.map((m) => m.from_title))].join(", ");
      const parts = [g.queued.length ? `${g.queued.length} queued (never delivered)` : "", g.unanswered.length ? `${g.unanswered.length} delivered with no answer` : ""].filter(Boolean).join(", ");
      findings.push({
        kind: "wait.mail",
        severity: "info",
        title: `Mail stuck for ${clip(g.title, 80)}`,
        detail: `${parts} from ${senders}, oldest ${day(oldest)}${input.desk?.pending.has(to) ? "; it has a question pending, so it never counts as idle" : ""}.`,
      });
    }
  }

  return { findings, questionTime };
}

// ── the runner ──────────────────────────────────────────────────────────────

export interface KeeperDeps {
  fetch: Fetch;
  loomUrl: string;
  loomToken: string | null;
  loomDbPath: string;
  deskUrl: string;
  screenDbPath: string;
  statePath: string;
  now?: () => number;
  log?: (line: string) => void;
}

export interface KeeperReport {
  findings: Finding[];
  woke: Array<{ itemId: string; title: string; ok: boolean; error?: string }>;
  resolved: number;
  notes: string[];
}

function readRows<T>(dbPath: string, sql: string): T[] | null {
  if (!fs.existsSync(dbPath)) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 2000");
    return db.prepare(sql).all() as T[];
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function loadState(file: string): KeeperState {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8")) as KeeperState;
    return { woke: s && typeof s.woke === "object" && s.woke ? s.woke : {}, raised: s && typeof s.raised === "object" && s.raised ? s.raised : {}, questionTime: s && typeof s.questionTime === "object" && s.questionTime ? s.questionTime : {} };
  } catch {
    return { woke: {} };
  }
}

/** A marker goes once its promise is no longer found (and is old), never while the promise still stands (Codex review on #770). */
function saveState(file: string, state: KeeperState, now: number, live: Set<string> | null): void {
  for (const [k, at] of Object.entries(state.woke)) if (live && !live.has(k) && now - at > STATE_KEEP_MS) delete state.woke[k];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

async function getJson<T>(fetch: Fetch, url: string, headers: Record<string, string> = {}): Promise<T | null> {
  const res = await fetch(url, { headers, timeoutMs: 8000 });
  if ("error" in res || res.status !== 200) return null;
  try {
    return JSON.parse(res.text) as T;
  } catch {
    return null;
  }
}

/** Gathers the inputs, wakes (unless dryRun), records findings and resolves the ones that cleared. */
export async function runWaitKeeper(l: Ledger | null, deps: KeeperDeps, opts: { dryRun?: boolean } = {}): Promise<KeeperReport> {
  const now = (deps.now ?? Date.now)();
  const notes: string[] = [];
  const state = loadState(deps.statePath);

  const auth: Record<string, string> = deps.loomToken ? { Authorization: `Bearer ${deps.loomToken}` } : {};
  const waits = deps.loomToken ? await getJson<LoomWait[]>(deps.fetch, `${deps.loomUrl}/triggers?status=waiting`, auth) : null;
  const snapshot = deps.loomToken ? await getJson<{ threads: LoomThread[] }>(deps.fetch, `${deps.loomUrl}/snapshot`, auth) : null;
  const queued = readRows<QueuedRun>(deps.loomDbPath, "SELECT thread_id, created_at FROM runs WHERE status = 'queued'");
  const loom = { waits, threads: snapshot ? snapshot.threads ?? [] : null, queued };
  const loomMissing = [!waits ? "waits" : "", !snapshot ? "snapshot" : "", !queued ? "runs" : ""].filter(Boolean);
  if (loomMissing.length) notes.push(`Loom not read: ${loomMissing.join(", ")}${!deps.loomToken ? " (no token)" : ""}`);

  const list = await getJson<{ items: DeskRow[] }>(deps.fetch, `${deps.deskUrl}/api/desk/items?view=active`);
  // A question pending on a row holds it busy for wakes and mail alike (the List row carries the facts).
  const desk: KeeperInput["desk"] = list ? { rows: list.items, pending: new Set(list.items.filter((r) => r.facts?.pending).map((r) => r.id)) } : null;
  if (!desk) notes.push("desk not read");

  const mail = readRows<MailRow>(deps.screenDbPath, `SELECT to_item, to_title, from_title, state, created_at, sent_at FROM desk_mail AS mail
    WHERE kind != 'report' AND (state = 'queued' OR (state IN ('sent', 'unanswered') AND expect = 'reply'
      AND NOT EXISTS (SELECT 1 FROM desk_mail AS back
        WHERE back.from_item = mail.to_item AND back.to_item = mail.from_item
          AND back.created_at > COALESCE(mail.sent_at, mail.created_at)
          AND back.state NOT IN ('draft', 'dropped', 'failed') AND back.kind != 'report')))`);
  if (!mail) notes.push("desk mail not read");

  const presence = readRows<ActiveInterval>(deps.loomDbPath, "SELECT start, last FROM presence");
  if (!presence) notes.push("owner presence not read");
  const briefs = readRows<OpenBrief>(deps.loomDbPath, "SELECT id, thread_id, ask, created_at FROM decisions WHERE status = 'open'");
  if (!briefs) notes.push("open briefs not read");
  const { findings, questionTime } = assess({ now, loom, desk, mail, presence, briefs, state });
  const woke: KeeperReport["woke"] = [];
  let resolved = 0;
  if (opts.dryRun) return { findings, woke, resolved, notes };
  state.questionTime = questionTime;

  for (const f of findings) {
    if (!f.wake) continue;
    if (woke.length >= MAX_WAKES_PER_RUN) {
      notes.push(`wake cap reached; "${f.title}" waits for the next run`);
      continue;
    }
    const commandId = `wait-keeper-${crypto.createHash("sha1").update(f.wake.key).digest("hex").slice(0, 16)}`;
    const res = await deps.fetch(`${deps.deskUrl}/api/desk/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId, type: "reply", itemId: f.wake.itemId, args: { text: f.wake.text }, actor: "agent" }),
      timeoutMs: 15_000,
    });
    let ok = false;
    let error: string | undefined;
    if ("error" in res) error = res.error;
    else {
      try {
        const body = JSON.parse(res.text) as { status?: string; error?: string; outcome?: { delivery?: string } };
        // Unknown delivery may have gone through: counted as sent, never sent twice.
        ok = body.status === "applied" || body.outcome?.delivery === "unknown";
        if (!ok) error = body.error ?? body.status ?? `HTTP ${res.status}`;
      } catch {
        error = `HTTP ${res.status}`;
      }
    }
    if (ok) state.woke[f.wake.key] = now;
    woke.push({ itemId: f.wake.itemId, title: f.title, ok, ...(error ? { error } : {}) });
    deps.log?.(`wake ${f.wake.itemId}: ${ok ? "sent" : `failed (${error})`}`);
  }
  // Persist successful wakes before ledger I/O (desk command ids also make retries safe).
  saveState(deps.statePath, state, now, null);

  if (l) tx(l, () => {
    const at = new Date(now).toISOString();
    for (const f of findings) {
      // The ledger is the durable once-only marker, even after dismissal, restart or a title change.
      const identity = f.question ? f.key : undefined;
      if (f.question && f.key) {
        state.raised ??= {};
        if (state.raised[f.key]) continue;
        if (l.db.prepare("SELECT 1 FROM events WHERE fingerprint = ? LIMIT 1").get(fingerprint(WAIT_KEEPER_JOB, f.kind, f.title, identity))) {
          state.raised[f.key] = now;
          continue;
        }
      }
      recordEvent(l, { source: "wait-keeper", kind: f.kind, severity: f.severity, title: f.title, identity, jobId: WAIT_KEEPER_JOB, detail: f.detail, ...(f.question ? { data: { question: f.question, identity } } : {}), at });
      if (f.question && f.key) state.raised![f.key] = now;
    }
    // Cleared since the last run: resolve. A source that couldn't be read keeps its incidents open.
    const unread = new Set<string>([
      ...(loom.waits ? [] : ["wait.loom-missed", "wait.loom-error"]),
      ...(loom.queued && loom.threads ? [] : ["wait.loom-queued"]),
      ...(desk ? [] : ["wait.overdue", "wait.stuck", "wait.person"]),
      ...(mail ? [] : ["wait.mail"]),
      ...(desk && presence && briefs ? [] : ["wait.question"]),
    ]);
    const current = new Set(findings.map((f) => fingerprint(WAIT_KEEPER_JOB, f.kind, f.title, f.question ? f.key : undefined)));
    const open = l.db
      .prepare(
        `SELECT i.fingerprint, i.title AS title, (SELECT e.data FROM events e WHERE e.incident_id = i.id AND e.severity != 'recovery' ORDER BY e.id DESC LIMIT 1) AS data, (SELECT e.kind FROM events e WHERE e.incident_id = i.id AND e.severity != 'recovery' ORDER BY e.id DESC LIMIT 1) AS kind
         FROM incidents i WHERE i.job_id = ? AND i.status != 'resolved'`,
      )
      .all(WAIT_KEEPER_JOB) as Array<{ title: string; kind: string | null; fingerprint: string; data: string | null }>;
    for (const o of open) {
      if (!o.kind || unread.has(o.kind) || current.has(o.fingerprint)) continue;
      const r = recordEvent(l, { source: "wait-keeper", kind: "wait.cleared", severity: "recovery", title: o.title, jobId: WAIT_KEEPER_JOB, resolves: { kind: o.kind, title: o.title, identity: o.data ? (JSON.parse(o.data) as { identity?: string }).identity : undefined }, at });
      if (r.incidentId != null) resolved += 1;
    }
  });
  // Only a full reading says a promise is gone.
  saveState(deps.statePath, state, now, loom.waits && desk ? new Set(findings.flatMap((f) => (f.key ? [f.key] : []))) : null);
  return { findings, woke, resolved, notes };
}

/** Where things live on this machine, from the environment. */
export function defaultKeeperPaths(dataDir: string): Pick<KeeperDeps, "loomDbPath" | "screenDbPath" | "statePath" | "deskUrl"> {
  const loomHome = process.env.LOOM_HOME || path.join(os.homedir(), ".tango", "loom");
  return {
    loomDbPath: path.join(loomHome, "loom.sqlite"),
    // Where the screen service keeps it: SCREEN_DATA_DIR as apps/screen/server/main.ts reads it (Codex review on #770).
    screenDbPath: process.env.TANGO_SCREEN_DB || path.join(process.env.SCREEN_DATA_DIR?.trim() ? path.resolve(process.env.SCREEN_DATA_DIR.trim().replace(/^~(?=\/|$)/, os.homedir())) : path.join(dataDir, "screen"), "screen.db"),
    statePath: path.join(dataDir, "wait-keeper", "state.json"),
    deskUrl: (process.env.TANGO_DESK_URL || "http://127.0.0.1:9410").replace(/\/$/, ""),
  };
}
