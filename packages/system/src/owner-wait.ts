import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { SystemContext } from "./context.js";
import { hasOpenIncidentOfKind, recordEvent } from "./incidents.js";
import type { Ledger } from "./types.js";

/**
 * The owner's own messages that Loom hasn't started, as one incident that reaches Discord.
 *
 * An owner's message should start at once (only another turn of the same conversation goes first). On 10/24 drains
 * for a worktree-reclaim switch-over held them for up to 12 minutes in eight conversations, and the owner only
 * saw slow threads. Loom now lets the owner's message past maintenance after two minutes; anything that still holds
 * one past this is worth a post, with what holds it.
 */
export const TURNS_JOB = "loom:turns";
const WAIT = { kind: "loom.owner_wait", identity: "loom-owner-wait" } as const;
/** Past maintenance's two-minute grace for the owner (MAINTENANCE_OWNER_GRACE_MS), with a tick's slack. */
export const OWNER_WAIT_MS = 150_000;

export interface WaitingTurn { threadId: string; title: string | null; waitedMs: number; admission: string | null }
export interface OwnerWaitReading {
  waiting: WaitingTurn[];
  maintenance: { on: boolean; reason: string | null; since: number | null } | null;
}

/**
 * Queued owner messages older than OWNER_WAIT_MS with no turn of their own conversation running ahead of them.
 * A scheduled job's opening message and threads the recovery hold already reports are left out. Null: unreadable.
 */
export function readOwnerWaits(loomDbPath: string, nowMs: number): OwnerWaitReading | null {
  if (!fs.existsSync(loomDbPath)) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(loomDbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 2000");
    const rows = db.prepare(`
      SELECT r.thread_id AS threadId, t.title, t.admission, MIN(r.created_at) AS createdAt
      FROM runs r JOIN threads t ON t.id = r.thread_id
      WHERE r.status = 'queued' AND r.source = 'user' AND r.created_at <= ?
        AND t.status != 'stopped' AND t.kind != 'probe' AND COALESCE(t.admission, '') != 'recovery_unhealthy'
        AND EXISTS (SELECT 1 FROM messages m WHERE m.run_id = r.id AND m.role = 'user' AND m.origin IS NULL)
        AND NOT EXISTS (SELECT 1 FROM runs a WHERE a.thread_id = r.thread_id AND a.status = 'running')
        AND NOT (t.kind = 'tango-job' AND r.id = (SELECT f.id FROM runs f WHERE f.thread_id = t.id ORDER BY f.created_at, f.rowid LIMIT 1))
      GROUP BY r.thread_id ORDER BY createdAt`).all(nowMs - OWNER_WAIT_MS) as Array<{ threadId: string; title: string | null; admission: string | null; createdAt: number }>;
    const state = db.prepare("SELECT value FROM coordinator_state WHERE key = 'maintenance'").get() as { value: string } | undefined;
    return {
      waiting: rows.map((r) => ({ threadId: r.threadId, title: r.title, admission: r.admission, waitedMs: nowMs - r.createdAt })),
      maintenance: state ? JSON.parse(state.value) : { on: false, reason: null, since: null },
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;

/** What holds them, in the owner's words. */
function cause(r: OwnerWaitReading): string {
  if (r.maintenance?.on) return `Loom maintenance is on${r.maintenance.reason ? ` (${r.maintenance.reason})` : ""}`;
  const holds = [...new Set(r.waiting.map((w) => w.admission).filter(Boolean))];
  return holds.length ? `held by ${holds.join(", ")}` : "nothing Loom reports is holding them";
}

/**
 * One tick's look: opens the incident when owner messages have waited too long, and resolves it once none do.
 * Never resolves on an unreadable database.
 */
export function checkOwnerWaits(l: Ledger, ctx: Pick<SystemContext, "now" | "loomDbPath">): OwnerWaitReading | null {
  const now = ctx.now();
  const reading = readOwnerWaits(ctx.loomDbPath, now.getTime());
  if (!reading) return null;
  const at = now.toISOString();
  const open = hasOpenIncidentOfKind(l, TURNS_JOB, [WAIT.kind]);
  if (reading.waiting.length && !open) {
    const names = reading.waiting.slice(0, 5).map((w) => `${w.title?.trim() || w.threadId.slice(0, 8)} (${minutes(w.waitedMs)})`);
    const m = reading.maintenance;
    recordEvent(l, {
      source: "tick",
      kind: WAIT.kind,
      identity: WAIT.identity,
      severity: "critical",
      title: `Your messages aren't starting: ${cause(reading)}`,
      jobId: TURNS_JOB,
      detail: [
        `${reading.waiting.length} ${reading.waiting.length === 1 ? "conversation has" : "conversations have"} your message waiting with nothing running ahead of it: ${names.join(", ")}${reading.waiting.length > names.length ? ", …" : ""}.`,
        ...(m?.on ? [`Maintenance on since ${m.since ? new Date(m.since).toISOString() : "an unknown time"}; lift it with \`POST /maintenance {"on": false}\` (Loom or tango-server).`] : []),
        "Loom's own stall line (`[loom] stall …` in loom.log) says whether its event loop or subprocess starts are slow.",
      ].join("\n"),
      data: { notifyDetail: true, waiting: reading.waiting, maintenance: m },
      at,
    });
  } else if (!reading.waiting.length && open) {
    recordEvent(l, { source: "tick", kind: "loom.owner_wait_ok", severity: "recovery", title: "Your messages are starting again", jobId: TURNS_JOB, data: { notifyDetail: true }, at, resolves: { kind: WAIT.kind, title: "", identity: WAIT.identity } });
  }
  return reading;
}
