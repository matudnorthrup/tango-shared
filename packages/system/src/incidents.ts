import { fingerprint } from "./fingerprint.js";
import { getJob } from "./jobs.js";
import { nowIso, parseJson, tx } from "./ledger.js";
import type {
  EventRow,
  IncidentRow,
  IncidentStatus,
  Ledger,
  NotifyTransition,
  RecordEventInput,
  Severity,
} from "./types.js";

type Raw = Record<string, unknown>;

const RANK: Record<Severity, number> = { recovery: 0, info: 1, warning: 2, error: 3, critical: 4 };
export const severityRank = (s: Severity): number => RANK[s] ?? 0;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const REGRESS_WINDOW_MS = 7 * DAY;
const FLAP_WINDOW_MS = HOUR;
const FLAP_REOPENS = 3;
export const REMINDER_MS = { critical: 4 * HOUR, normal: 24 * HOUR } as const;

export function mapIncident(r: Raw): IncidentRow {
  return {
    id: Number(r.id),
    fingerprint: String(r.fingerprint),
    jobId: r.job_id == null ? null : String(r.job_id),
    title: String(r.title),
    severity: String(r.severity) as Severity,
    status: String(r.status) as IncidentStatus,
    firstSeen: String(r.first_seen),
    lastSeen: String(r.last_seen),
    count: Number(r.count),
    resolvedAt: r.resolved_at == null ? null : String(r.resolved_at),
    snoozedUntil: r.snoozed_until == null ? null : String(r.snoozed_until),
    regressed: Number(r.regressed) === 1,
    flapping: Number(r.flapping) === 1,
    reopenCount: Number(r.reopen_count ?? 0),
    notifiedAt: r.notified_at == null ? null : String(r.notified_at),
  };
}

export function mapEvent(r: Raw): EventRow {
  return {
    id: Number(r.id),
    at: String(r.at),
    source: String(r.source),
    jobId: r.job_id == null ? null : String(r.job_id),
    kind: String(r.kind),
    severity: String(r.severity) as Severity,
    title: String(r.title),
    detail: r.detail == null ? null : String(r.detail),
    data: parseJson<Record<string, unknown> | null>(r.data, null),
    fingerprint: String(r.fingerprint),
    incidentId: r.incident_id == null ? null : Number(r.incident_id),
  };
}

/** The failure kinds a recovery of this kind resolves. */
export function kindsResolvedBy(kind: string): string[] | "family" {
  if (kind === "service.up") return ["service.down"];
  if (kind.startsWith("run.")) return ["run.failed", "job.late", "job.restarting"];
  if (kind === "load.normal") return ["load.high"];
  if (kind === "job.stable") return ["job.restarting"];
  if (kind === "log.rotated" || kind === "log.ok") return ["log.large"];
  return "family";
}

const family = (kind: string): string => kind.split(".")[0] ?? kind;

function getIncident(l: Ledger, id: number): IncidentRow | null {
  const row = l.db.prepare("SELECT * FROM incidents WHERE id = ?").get(id) as Raw | undefined;
  return row ? mapIncident(row) : null;
}

/** Open (not resolved) incidents for a job whose events have one of these kinds (or the kind family). */
function openIncidentsFor(l: Ledger, jobId: string, kinds: string[] | { family: string }): IncidentRow[] {
  const rows = l.db
    .prepare(
      `SELECT DISTINCT i.*, e.kind AS ev_kind FROM incidents i JOIN events e ON e.incident_id = i.id
       WHERE i.status != 'resolved' AND i.job_id = ? AND e.severity != 'recovery'`,
    )
    .all(jobId) as Raw[];
  const seen = new Set<number>();
  const out: IncidentRow[] = [];
  for (const r of rows) {
    const k = String(r.ev_kind);
    const match = Array.isArray(kinds) ? kinds.includes(k) : family(k) === kinds.family;
    if (!match) continue;
    const inc = mapIncident(r);
    if (seen.has(inc.id)) continue;
    seen.add(inc.id);
    out.push(inc);
  }
  return out;
}

/** Resolves an incident unless the flap guard holds it. Returns whether it resolved. */
function resolveIncident(l: Ledger, inc: IncidentRow, at: string): boolean {
  if (inc.flapping && Date.parse(at) - Date.parse(inc.lastSeen) < FLAP_WINDOW_MS) {
    // Held, not dropped: the tick resolves it once the window passes with no new failure.
    l.db.prepare("UPDATE incidents SET held_recovery_at = ? WHERE id = ?").run(at, inc.id);
    return false;
  }
  const row = l.db.prepare("SELECT notified_at, notify_pending FROM incidents WHERE id = ?").get(inc.id) as Raw;
  // Tell people it is over only if they were told it started; muted incidents say nothing.
  const pending = row.notified_at != null && inc.status !== "muted" ? "resolved" : null;
  l.db
    .prepare("UPDATE incidents SET status = 'resolved', resolved_at = ?, snoozed_until = NULL, held_recovery_at = NULL, notify_pending = ? WHERE id = ?")
    .run(at, pending, inc.id);
  return true;
}

export function recordEvent(l: Ledger, e: RecordEventInput): { eventId: number; incidentId: number | null } {
  const at = e.at ?? nowIso();
  const jobId = e.jobId?.trim() || null;
  const fp = fingerprint(jobId, e.kind, e.title, e.identity);
  return tx(l, () => {
    let incidentId: number | null = null;

    if (e.severity === "recovery") {
      if (e.resolves) {
        const target = l.db
          .prepare("SELECT * FROM incidents WHERE fingerprint = ? AND status != 'resolved'")
          .get(fingerprint(jobId, e.resolves.kind, e.resolves.title, e.resolves.identity)) as Raw | undefined;
        if (target && resolveIncident(l, mapIncident(target), at)) incidentId = Number(target.id);
      } else if (jobId) {
        const kinds = kindsResolvedBy(e.kind);
        const open = openIncidentsFor(l, jobId, kinds === "family" ? { family: family(e.kind) } : kinds);
        for (const inc of open) {
          if (resolveIncident(l, inc, at) && incidentId === null) incidentId = inc.id;
        }
      }
    } else {
      const open = l.db.prepare("SELECT * FROM incidents WHERE fingerprint = ? AND status != 'resolved'").get(fp) as Raw | undefined;
      if (open) {
        const inc = mapIncident(open);
        incidentId = inc.id;
        const raise = severityRank(e.severity) > severityRank(inc.severity);
        const pending = open.notify_pending as string | null;
        const nextPending = raise && (incidentHasOwnerWait(l, inc) || (pending !== "opened" && pending !== "regressed")) ? "escalated" : pending;
        l.db
          .prepare(
            "UPDATE incidents SET count = count + 1, last_seen = MAX(last_seen, ?), title = ?, severity = ?, notify_pending = ?, held_recovery_at = NULL WHERE id = ?",
          )
          .run(at, e.title, raise ? e.severity : inc.severity, nextPending, inc.id);
      } else {
        const prev = l.db
          .prepare("SELECT * FROM incidents WHERE fingerprint = ? AND status = 'resolved' ORDER BY resolved_at DESC LIMIT 1")
          .get(fp) as Raw | undefined;
        const regressed = prev != null && prev.resolved_at != null && Date.parse(at) - Date.parse(String(prev.resolved_at)) <= REGRESS_WINDOW_MS;
        const reopenCount = regressed ? Number(prev!.reopen_count ?? 0) + 1 : 0;
        let flapping = 0;
        if (regressed) {
          const since = new Date(Date.parse(at) - FLAP_WINDOW_MS).toISOString();
          const reopens = (l.db
            .prepare("SELECT COUNT(*) AS n FROM incidents WHERE fingerprint = ? AND regressed = 1 AND first_seen >= ?")
            .get(fp, since) as { n: number }).n;
          if (reopens + 1 > FLAP_REOPENS) flapping = 1;
        }
        const res = l.db
          .prepare(
            `INSERT INTO incidents(fingerprint, job_id, title, severity, status, first_seen, last_seen, count, regressed, flapping, reopen_count, notify_pending)
             VALUES(?, ?, ?, ?, 'open', ?, ?, 1, ?, ?, ?, ?)`,
          )
          .run(fp, jobId, e.title, e.severity, at, at, regressed ? 1 : 0, flapping, reopenCount, regressed ? "regressed" : "opened");
        incidentId = Number(res.lastInsertRowid);
      }
    }

    const ev = l.db
      .prepare(
        "INSERT INTO events(at, source, job_id, kind, severity, title, detail, data, fingerprint, incident_id) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(at, e.source, jobId, e.kind, e.severity, e.title, e.detail ?? null, e.data ? JSON.stringify(e.data) : null, fp, incidentId);
    return { eventId: Number(ev.lastInsertRowid), incidentId };
  });
}

/** A successful run resolves the job's open failure incidents. Returns the ids resolved. */
export function resolveJobIncidents(l: Ledger, jobId: string, kinds: string[], at = nowIso()): number[] {
  return tx(l, () => openIncidentsFor(l, jobId, kinds).filter((inc) => resolveIncident(l, inc, at)).map((inc) => inc.id));
}

export function hasOpenIncident(l: Ledger, jobId: string | null, kind: string, title: string): boolean {
  const fp = fingerprint(jobId, kind, title);
  return l.db.prepare("SELECT 1 FROM incidents WHERE fingerprint = ? AND status != 'resolved'").get(fp) !== undefined;
}

export function hasOpenIncidentOfKind(l: Ledger, jobId: string, kinds: string[]): boolean {
  return openIncidentsFor(l, jobId, kinds).length > 0;
}

export function listIncidents(
  l: Ledger,
  f: { status?: "active" | "all"; resolvedSinceDays?: number; jobId?: string } = {},
): IncidentRow[] {
  const where: string[] = [];
  const args: Array<string | number> = [];
  const status = f.status ?? "active";
  if (status === "active" && f.resolvedSinceDays === undefined) where.push("status != 'resolved'");
  if (f.resolvedSinceDays !== undefined) {
    // Active incidents plus the ones resolved in the window (the page's "resolved this week").
    where.push("(status != 'resolved' OR resolved_at >= ?)");
    args.push(new Date(Date.now() - f.resolvedSinceDays * DAY).toISOString());
  }
  if (f.jobId) {
    where.push("job_id = ?");
    args.push(f.jobId);
  }
  const sql = `SELECT * FROM incidents ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY CASE status WHEN 'resolved' THEN 1 ELSE 0 END,
      CASE severity WHEN 'critical' THEN 0 WHEN 'error' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END, last_seen DESC`;
  return (l.db.prepare(sql).all(...args) as Raw[]).map(mapIncident);
}

export function listEvents(
  l: Ledger,
  f: { limit?: number; beforeId?: number; severity?: Severity[]; source?: string; jobId?: string } = {},
): EventRow[] {
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (f.beforeId !== undefined) {
    where.push("id < ?");
    args.push(f.beforeId);
  }
  if (f.severity?.length) {
    where.push(`severity IN (${f.severity.map(() => "?").join(", ")})`);
    args.push(...f.severity);
  }
  if (f.source) {
    where.push("source = ?");
    args.push(f.source);
  }
  if (f.jobId) {
    where.push("job_id = ?");
    args.push(f.jobId);
  }
  args.push(Math.max(1, Math.min(f.limit ?? 100, 1000)));
  const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
  return (l.db.prepare(sql).all(...args) as Raw[]).map(mapEvent);
}

/** Link a diagnosed check to the one conversation carrying its owner errand.
 * Linking several checks to the same conversation does not merge their recovery evidence.
 */
export function linkIncidentOwnerWait(l: Ledger, id: number, itemId: string, opts: { automatic?: boolean } = {}): void {
  if (!itemId.startsWith("loom:") || !itemId.slice(5).trim()) throw new Error("owner wait requires a Loom item id");
  const inc = getIncident(l, id);
  if (!inc) throw new Error("incident not found");
  // Automatic discovery must not revive an answered errand or replace an explicit link.
  // A new repair request can still be linked explicitly through the CLI.
  const conflict = opts.automatic ? "DO NOTHING" : "DO UPDATE SET item_id = excluded.item_id, active = 1";
  l.db.prepare(`INSERT INTO incident_owner_waits(fingerprint, item_id, active) VALUES(?, ?, 1)
    ON CONFLICT(fingerprint) ${conflict}`).run(inc.fingerprint, itemId);
}

export function incidentHasOwnerWait(l: Ledger, inc: IncidentRow): boolean {
  return !!l.db.prepare("SELECT 1 FROM incident_owner_waits WHERE fingerprint = ? AND active = 1").get(inc.fingerprint);
}

/** The desk refreshes known conversations; missing readings retain the last known state. */
export function refreshIncidentOwnerWaits(l: Ledger, isWaiting: (itemId: string) => boolean | null): void {
  tx(l, () => {
    const rows = l.db.prepare("SELECT DISTINCT item_id FROM incident_owner_waits WHERE active = 1").all() as Array<{ item_id: string }>;
    for (const row of rows) {
      const active = isWaiting(row.item_id);
      if (active === null) continue;
      if (!active) {
        // An unanswered failure becomes actionable again when its repair request ends.
        l.db.prepare(`UPDATE incidents SET notify_pending = CASE WHEN notified_at IS NULL THEN 'opened' ELSE 'reminder' END
          WHERE status = 'open' AND notify_pending IS NULL AND fingerprint IN
            (SELECT fingerprint FROM incident_owner_waits WHERE item_id = ? AND active = 1)`).run(row.item_id);
      }
      l.db.prepare("UPDATE incident_owner_waits SET active = ? WHERE item_id = ? AND active = 1").run(active ? 1 : 0, row.item_id);
    }
  });
}

export function setIncidentStatus(
  l: Ledger,
  id: number,
  status: "open" | "acked" | "muted" | "snoozed",
  opts: { until?: string } = {},
): IncidentRow | null {
  const inc = getIncident(l, id);
  if (!inc) return null;
  if (inc.status === "resolved") return inc;
  let until: string | null = null;
  if (status === "snoozed") {
    const parsed = opts.until ? Date.parse(opts.until) : NaN;
    until = new Date(Number.isFinite(parsed) ? parsed : Date.now() + 4 * HOUR).toISOString();
  }
  // Muting drops anything not yet sent.
  const clearPending = status === "muted" ? ", notify_pending = NULL"
    : status === "acked" ? ", notify_pending = CASE WHEN notify_pending = 'reminder' THEN NULL ELSE notify_pending END" : "";
  l.db.prepare(`UPDATE incidents SET status = ?, snoozed_until = ?${clearPending} WHERE id = ?`).run(status, until, id);
  return getIncident(l, id);
}

export type NotifyRoute = "critical" | "normal" | "quiet";

/**
 * Who hears about an incident: a quiet job only shows on the System page; a
 * critical job's errors (or any critical-severity event) go to Discord and the
 * desk's Needs you; everything else goes to the desk feed. Info stays quiet.
 */
export function incidentRoute(l: Ledger, inc: IncidentRow): NotifyRoute {
  const job = inc.jobId ? getJob(l, inc.jobId) : null;
  if (job?.criticality === "quiet") return "quiet";
  if (inc.severity === "critical") return "critical";
  if (job?.criticality === "critical" && inc.severity === "error") return "critical";
  if (inc.severity === "info") return "quiet";
  return "normal";
}

export interface PendingNotification {
  incident: IncidentRow;
  transition: NotifyTransition;
  route: NotifyRoute;
}

/**
 * Brings snoozes that ran out back to open, and marks reminders due on open,
 * notified incidents (critical every 4 h, normal every 24 h). Acked, muted and
 * snoozed incidents get no reminders.
 */
export function scheduleReminders(l: Ledger, now = nowIso()): void {
  tx(l, () => {
    const expired = l.db
      .prepare("SELECT * FROM incidents WHERE status = 'snoozed' AND snoozed_until IS NOT NULL AND snoozed_until <= ?")
      .all(now) as Raw[];
    for (const r of expired) {
      const oneShot = l.db.prepare("SELECT 1 FROM events WHERE incident_id = ? AND kind = 'wait.question' LIMIT 1").get(Number(r.id));
      const pending = oneShot ? null : r.notify_pending ?? (r.notified_at != null ? "reminder" : null);
      l.db.prepare("UPDATE incidents SET status = 'open', snoozed_until = NULL, notify_pending = ? WHERE id = ?").run(pending as string | null, Number(r.id));
    }
    const open = l.db
      .prepare("SELECT * FROM incidents WHERE status = 'open' AND notify_pending IS NULL AND notified_at IS NOT NULL")
      .all() as Raw[];
    for (const r of open) {
      const inc = mapIncident(r);
      // A stale owner question is raised once, never a repeating reminder.
      if (l.db.prepare("SELECT 1 FROM events WHERE incident_id = ? AND kind = 'wait.question' LIMIT 1").get(inc.id)) continue;
      if (incidentHasOwnerWait(l, inc)) continue;
      const route = incidentRoute(l, inc);
      if (route === "quiet") continue;
      const every = REMINDER_MS[route];
      if (Date.parse(now) - Date.parse(inc.notifiedAt!) >= every) {
        l.db.prepare("UPDATE incidents SET notify_pending = 'reminder' WHERE id = ?").run(inc.id);
      }
    }
  });
}

/**
 * Transitions waiting to be sent for a route. Muted incidents and quiet routes
 * drop their pending transition; active snoozes hold it.
 */
export function pendingNotifications(l: Ledger, route: NotifyRoute, now = nowIso()): PendingNotification[] {
  const rows = l.db.prepare("SELECT * FROM incidents WHERE notify_pending IS NOT NULL ORDER BY id").all() as Raw[];
  const out: PendingNotification[] = [];
  for (const r of rows) {
    const inc = mapIncident(r);
    const transition = String(r.notify_pending) as NotifyTransition;
    const incRoute = incidentRoute(l, inc);
    if (inc.status === "muted" || incRoute === "quiet") {
      l.db.prepare("UPDATE incidents SET notify_pending = NULL WHERE id = ?").run(inc.id);
      continue;
    }
    // A repair request already carries the ask. Keep escalation and real recovery visible.
    // Drop repeats instead of queuing a burst when the request is answered.
    if ((inc.status === "acked" && transition === "reminder") ||
      (incidentHasOwnerWait(l, inc) && ["opened", "regressed", "reminder"].includes(transition))) {
      l.db.prepare("UPDATE incidents SET notify_pending = NULL WHERE id = ?").run(inc.id);
      continue;
    }
    if (inc.status === "snoozed" && inc.snoozedUntil && inc.snoozedUntil > now) continue;
    if (incRoute !== route) continue;
    out.push({ incident: inc, transition, route: incRoute });
  }
  return out;
}

export function markNotified(l: Ledger, id: number, at = nowIso()): void {
  l.db.prepare("UPDATE incidents SET notified_at = ?, notified_severity = severity, notify_pending = NULL WHERE id = ?").run(at, id);
}

/**
 * The desk feed's share: normal-route transitions (including reminders),
 * returned once and cleared. The desk posts them to its feed.
 */
export function takeDeskNotifications(l: Ledger): PendingNotification[] {
  scheduleReminders(l);
  return tx(l, () => {
    const pending = pendingNotifications(l, "normal");
    const at = nowIso();
    for (const p of pending) markNotified(l, p.incident.id, at);
    return pending;
  });
}

/**
 * Resolves flapping incidents whose recovery the flap guard held, once a full
 * window has passed since their last failure. Returns how many resolved.
 */
export function releaseHeldRecoveries(l: Ledger, now = nowIso()): number {
  const rows = l.db
    .prepare("SELECT * FROM incidents WHERE status != 'resolved' AND held_recovery_at IS NOT NULL")
    .all() as Raw[];
  let n = 0;
  for (const r of rows) {
    const inc = mapIncident(r);
    if (Date.parse(now) - Date.parse(inc.lastSeen) < FLAP_WINDOW_MS) continue;
    if (resolveIncident(l, inc, now)) n += 1;
  }
  return n;
}

/** What a job stops failing at once it is paused, retired or stopped on purpose (not, say, an oversized log). */
export const EXECUTION_KINDS = ["run.failed", "job.late", "job.restarting", "delivery.failed", "service.down", "process.unmanaged"];

/**
 * Closes a job's unresolved incidents whose events have one of these kinds (default: execution problems),
 * for a job paused, retired or stopped on purpose, or a delivery turned off. Bypasses the flap guard.
 * People are told only about incidents they were told about.
 */
export function closeJobIncidents(l: Ledger, jobId: string, at = nowIso(), kinds: string[] = EXECUTION_KINDS): number {
  return tx(l, () => {
    const marks = kinds.map(() => "?").join(", ");
    const rows = l.db
      .prepare(
        `SELECT DISTINCT i.* FROM incidents i JOIN events e ON e.incident_id = i.id
         WHERE i.job_id = ? AND i.status != 'resolved' AND e.kind IN (${marks})`,
      )
      .all(jobId, ...kinds) as Raw[];
    for (const r of rows) {
      const inc = mapIncident(r);
      const pending = r.notified_at != null && inc.status !== "muted" ? "resolved" : null;
      l.db
        .prepare("UPDATE incidents SET status = 'resolved', resolved_at = ?, snoozed_until = NULL, held_recovery_at = NULL, notify_pending = ? WHERE id = ?")
        .run(at, pending, inc.id);
    }
    return rows.length;
  });
}
