import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { SystemContext } from "./context.js";
import { hasOpenIncidentOfKind, recordEvent } from "./incidents.js";
import { getJsonCursor, setJsonCursor } from "./ledger.js";
import type { Ledger } from "./types.js";

/**
 * Loom's recovery admission hold and the recovery mini's disk, as two incidents that reach Discord.
 *
 * On 10/23 Loom held every new turn for about four hours because the mini fell under its space floor, and
 * nobody heard: the hold showed only as per-row status text, and the backup monitor's alert merged into an
 * older open "Loom recovery health" incident on a normal-route job. Each of these has its own identity, opens
 * once (one post), and posts a "Resolved" when it lifts.
 */
export const RECOVERY_JOB = "loom:recovery";
const HOLD = { kind: "recovery.hold", identity: "loom-recovery-hold" } as const;
const SPACE = { kind: "recovery.space", identity: "loom-recovery-space" } as const;
const SAMPLES_CURSOR = "recovery.mini.samples";
const GIB = 1024 ** 3;
/** The backup supervisor writes health every 30 s; older than this is no reading (the backup's own alarm covers it). */
const FRESH_MS = 5 * 60_000;
const SAMPLE_EVERY_MS = 30 * 60_000;
const SAMPLE_KEEP_MS = 7 * 86_400_000;
const TREND_WINDOW_MS = 86_400_000;
/** The space warning clears this far above its floor, so it doesn't flap on the line. */
const CLEAR_MARGIN = GIB;

export interface RecoveryHealth {
  at: number;
  alerts: string[];
  free_bytes?: number;
  destination_host?: string;
  destination?: string;
  warn_free_bytes?: number;
  pause_free_bytes?: number;
}

export interface RecoveryReading {
  /** Conversations Loom holds for recovery health right now (null: Loom's database was unreadable). */
  held: number | null;
  health: RecoveryHealth | null;
  host: string | null;
  freeGb: number | null;
  /** Change in the mini's free space over the last day (negative: filling up). */
  trendGbPerDay: number | null;
  /** At that rate, days until the pause floor (null when not filling up). */
  daysToPause: number | null;
  line: string | null;
}

const gb = (bytes: number) => Math.round((bytes / GIB) * 10) / 10;

export function readRecoveryHealth(file: string | null | undefined, nowMs: number): RecoveryHealth | null {
  if (!file) return null;
  try {
    const h = JSON.parse(fs.readFileSync(file, "utf8")) as RecoveryHealth;
    if (typeof h.at !== "number" || !Array.isArray(h.alerts)) return null;
    const age = nowMs - h.at * 1000;
    return age <= FRESH_MS && age >= -60_000 ? h : null;
  } catch {
    return null;
  }
}

function heldThreads(loomDbPath: string): Array<{ id: string; title: string | null }> | null {
  if (!fs.existsSync(loomDbPath)) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(loomDbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 2000");
    return db.prepare("SELECT id, title FROM threads WHERE admission = 'recovery_unhealthy' ORDER BY updated_at DESC").all() as Array<{ id: string; title: string | null }>;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

interface Sample { at: number; free: number }

/** Keeps a free-space sample every half hour for a week and reads the last day's slope. */
function trend(l: Ledger, nowMs: number, free: number | undefined): { gbPerDay: number | null } {
  let samples = getJsonCursor<Sample[]>(l, SAMPLES_CURSOR) ?? [];
  if (typeof free === "number" && (!samples.length || nowMs - samples[samples.length - 1]!.at >= SAMPLE_EVERY_MS)) {
    samples = [...samples.filter((s) => nowMs - s.at <= SAMPLE_KEEP_MS), { at: nowMs, free }];
    setJsonCursor(l, SAMPLES_CURSOR, samples);
  }
  const last = samples[samples.length - 1];
  const base = samples.find((s) => last && last.at - s.at <= TREND_WINDOW_MS);
  if (!last || !base || last.at - base.at < 2 * SAMPLE_EVERY_MS) return { gbPerDay: null };
  return { gbPerDay: Math.round(((last.free - base.free) / GIB / ((last.at - base.at) / 86_400_000)) * 10) / 10 };
}

function overrideLines(file: string | null | undefined): string[] {
  if (!file) return ["Override: write `allow` to Loom's `LOOM_RECOVERY_HEALTH_FILE` + `.override`; remove that file to re-enable the gate."];
  return [`Resume now: \`echo allow > ${file}.override\``, `Re-enable the gate after fixing it: \`rm ${file}.override\``];
}

function spaceLine(r: RecoveryReading): string | null {
  if (r.freeGb == null) return null;
  const h = r.health!;
  const floors = [h.pause_free_bytes != null ? `pause under ${gb(h.pause_free_bytes)} GB` : null, h.warn_free_bytes != null ? `warning under ${gb(h.warn_free_bytes)} GB` : null].filter(Boolean).join(", ");
  return `Mini ${r.host ?? "(unknown host)"}: ${r.freeGb} GB free${floors ? ` (${floors})` : ""}${r.line ? `; ${r.line}` : ""}`;
}

/**
 * One tick's look at recovery: opens or clears the hold and space incidents, keeps the mini's disk trend.
 * Never resolves on a missing reading: an unreadable Loom database or a stale health file leaves things as they are.
 */
export function checkRecovery(l: Ledger, ctx: Pick<SystemContext, "now" | "loomDbPath" | "recoveryHealthFile">): RecoveryReading {
  const now = ctx.now();
  const nowMs = now.getTime();
  const at = now.toISOString();
  const health = readRecoveryHealth(ctx.recoveryHealthFile, nowMs);
  const threads = heldThreads(ctx.loomDbPath);
  const { gbPerDay } = trend(l, nowMs, health?.free_bytes);
  const freeGb = typeof health?.free_bytes === "number" ? gb(health.free_bytes) : null;
  const pause = health?.pause_free_bytes;
  const daysToPause = gbPerDay != null && gbPerDay < 0 && freeGb != null && pause != null ? Math.max(0, Math.round(((freeGb - gb(pause)) / -gbPerDay) * 10) / 10) : null;
  const line = gbPerDay == null ? null : `${gbPerDay > 0 ? "+" : ""}${gbPerDay} GB/day${daysToPause != null ? `, about ${daysToPause} days to the pause floor` : ""}`;
  const reading: RecoveryReading = { held: threads?.length ?? null, health, host: health?.destination_host ?? null, freeGb, trendGbPerDay: gbPerDay, daysToPause, line };
  const space = spaceLine(reading);

  // The hold: any conversation Loom is holding for recovery health.
  if (threads && threads.length > 0) {
    if (!hasOpenIncidentOfKind(l, RECOVERY_JOB, [HOLD.kind])) {
      const reasons = health?.alerts.includes("destination_low_space") ? "the recovery mini is out of space" : health?.alerts.includes("replica_lag") ? "replication to the recovery mini is behind" : "recovery is unhealthy";
      const names = threads.slice(0, 5).map((t) => t.title?.trim() || t.id.slice(0, 8));
      recordEvent(l, {
        source: "tick",
        kind: HOLD.kind,
        identity: HOLD.identity,
        severity: "critical",
        title: `Loom paused new turns: ${reasons}`,
        jobId: RECOVERY_JOB,
        detail: [
          `${threads.length} ${threads.length === 1 ? "conversation is" : "conversations are"} waiting: ${names.join(", ")}${threads.length > names.length ? ", …" : ""}. Running turns finish; new ones resume on their own when it clears.`,
          ...(space ? [space] : []),
          ...(health?.alerts.length ? [`Backup alerts: ${health.alerts.join(", ")}`] : []),
          ...overrideLines(ctx.recoveryHealthFile),
        ].join("\n"),
        data: { notifyDetail: true, held: threads.map((t) => t.id), health },
        at,
      });
    }
  } else if (threads && hasOpenIncidentOfKind(l, RECOVERY_JOB, [HOLD.kind])) {
    recordEvent(l, { source: "tick", kind: "recovery.resumed", severity: "recovery", title: "Loom is taking new turns again", jobId: RECOVERY_JOB, detail: space ?? undefined, data: { notifyDetail: true }, at, resolves: { kind: HOLD.kind, title: "", identity: HOLD.identity } });
  }

  // The space warning: the mini under its warning floor (or the hard floor), alerted before it can hold anything.
  if (health && typeof health.free_bytes === "number") {
    const low = health.alerts.includes("destination_space_warn") || health.alerts.includes("destination_low_space");
    const open = hasOpenIncidentOfKind(l, RECOVERY_JOB, [SPACE.kind]);
    if (low && !open) {
      const hard = health.alerts.includes("destination_low_space");
      recordEvent(l, {
        source: "tick",
        kind: SPACE.kind,
        identity: SPACE.identity,
        severity: "critical",
        title: hard ? "Recovery mini is below its pause floor" : "Recovery mini is low on space",
        jobId: RECOVERY_JOB,
        detail: [
          space ?? "",
          hard ? "Loom holds new turns until there's room again." : "Nothing is held yet; Loom holds new turns only below the pause floor.",
          `Free space on ${reading.host ?? "the mini"}: remove superseded replicas (\`ls -d ${health.destination ? `${health.destination.replace(/\/[^/]+$/, "")}/*` : "<remote_root>/destinations/*"}\`; keep the current and one previous) or raise the floors in the backup config.`,
          ...(hard ? overrideLines(ctx.recoveryHealthFile) : []),
        ].filter(Boolean).join("\n"),
        data: { notifyDetail: true, health },
        at,
      });
    } else if (!low && open && (health.warn_free_bytes == null || health.free_bytes >= health.warn_free_bytes + CLEAR_MARGIN)) {
      recordEvent(l, { source: "tick", kind: "recovery.space_ok", severity: "recovery", title: "Recovery mini has room again", jobId: RECOVERY_JOB, detail: space ?? undefined, data: { notifyDetail: true }, at, resolves: { kind: SPACE.kind, title: "", identity: SPACE.identity } });
    }
  }
  return reading;
}
