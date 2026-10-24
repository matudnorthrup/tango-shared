import fs from "node:fs";
import path from "node:path";
import { lateFactor, loadAnnotations, type Annotations, type JobAnnotation } from "./annotations.js";
import { defaultContext, humanSeconds, withTimeout, type SystemContext } from "./context.js";
import { discoverLaunchd, launchdPids } from "./discovery/launchd.js";
import { discoverBackground, discoverDocker, discoverLoomWaits, discoverRoutines } from "./discovery/others.js";
import { discoverSchedules, type ScheduleSource } from "./discovery/schedule.js";
import { discoverServer } from "./discovery/server.js";
import { discoverTmux, type StartupInfo } from "./discovery/tmux.js";
import type { DiscoveryInput, DiscoveryResult, ProcessInfo } from "./discovery/types.js";
import { closeJobIncidents, hasOpenIncident, hasOpenIncidentOfKind, recordEvent, releaseHeldRecoveries, resolveJobIncidents } from "./incidents.js";
import { ingestScheduleRuns } from "./ingest.js";
import { getJob, listJobs, upsertJob, type JobUpsert } from "./jobs.js";
import { getJsonCursor, setJsonCursor, tx } from "./ledger.js";
import { expandLogPath, LOG_ROTATE_BYTES, LOG_WARN_BYTES, rotateLog } from "./logs.js";
import { notifyCritical } from "./notify.js";
import { machineHealth, probeService } from "./probes.js";
import { checkRecovery } from "./recovery.js";
import { recordRun } from "./runs.js";
import { HEALTH_CURSOR } from "./summary.js";

const PLIST_CURSOR = "launchd.plists";
import { parseNetstatListen, parsePs, PS_ARGS, scanUnmanaged, shortName } from "./unmanaged.js";
import type { HealthSnapshot, Ledger, Runner } from "./types.js";

export interface TickOptions {
  /** Never post to Discord (critical transitions stay pending). */
  noNotify?: boolean;
  /** Never change anything outside the ledger (no log rotation). */
  noActions?: boolean;
  ctx?: SystemContext;
  annotations?: Annotations;
  budgetMs?: number;
  /** Past this, a tick only notifies and tidies up (default 45 s). */
  hardBudgetMs?: number;
  /** Test seams. */
  scheduleSource?: () => ScheduleSource;
  startupInfo?: (ctx: SystemContext) => Promise<StartupInfo | null>;
  runners?: Runner[];
  skipSteps?: Array<"ingest" | "probe" | "late" | "unmanaged" | "disk" | "recovery" | "logs" | "notify" | "prune">;
}

export interface TickReport {
  skipped?: string;
  startedAt: string;
  durationMs: number;
  discovered: Partial<Record<Runner, number>>;
  notes: string[];
  ingested: number;
  services: { up: string[]; down: string[] };
  incidentsOpened: number;
  eventsRecorded: number;
  unmanaged: number;
  lateEvents: number;
  logs: { large: number; rotated: number };
  notify: { sent: number; pending: number };
  /** The recovery mini's disk and Loom's recovery hold, e.g. "mini 100.0.0.1: 35.6 GB free, -2.1 GB/day; 0 held". */
  recovery?: string;
  pruned: { events: number; incidents: number; runs: number; jobs: number };
  /** Milliseconds per step, to find what a slow tick spent its time on. */
  steps: Record<string, number>;
}

const LOCK = "tick.lock";
const LOCK_STALE_MS = 5 * 60_000;
const LOAD_SUSTAIN_MS = 10 * 60_000;
const DAY = 86_400_000;
// Runners whose answer is the whole list: a row not in it is gone (a Tango Server reload can drop a service).
const EPHEMERAL: Runner[] = ["loom-wait", "background", "server"];

function acquireLock(l: Ledger, now: Date): boolean {
  return tx(l, () => {
    const lock = getJsonCursor<{ pid: number; at: string }>(l, LOCK);
    if (lock && now.getTime() - Date.parse(lock.at) < LOCK_STALE_MS) {
      let alive = true;
      try {
        process.kill(lock.pid, 0);
      } catch {
        alive = false;
      }
      if (alive && lock.pid !== process.pid) return false;
    }
    setJsonCursor(l, LOCK, { pid: process.pid, at: now.toISOString() });
    return true;
  });
}

function releaseLock(l: Ledger): void {
  try {
    const lock = getJsonCursor<{ pid: number }>(l, LOCK);
    if (lock?.pid === process.pid) l.db.prepare("DELETE FROM cursors WHERE name = ?").run(LOCK);
  } catch {
    // best effort
  }
}

/** Discovery facts under the annotation overlay. */
export function applyAnnotations(job: JobUpsert, a: Annotations): JobUpsert {
  const ann: JobAnnotation | undefined = a.jobs[job.id];
  const out: JobUpsert = { ...job };
  out.group = ann?.group ?? job.group ?? a.defaults.group[job.runner] ?? null;
  if (job.managed !== false) out.criticality = ann?.criticality ?? job.criticality ?? a.defaults.criticality;
  if (ann?.name) out.name = ann.name;
  if (ann?.owner) out.owner = ann.owner;
  if (ann?.cadence) out.cadence = ann.cadence;
  if (ann?.cadenceSeconds !== undefined) {
    out.cadenceSeconds = ann.cadenceSeconds;
    if (!ann.cadence && !job.cadence) out.cadence = humanSeconds(ann.cadenceSeconds);
  }
  if (ann?.logs) out.logs = [...new Set([...(job.logs ?? []), ...ann.logs.map(expandLogPath)])];
  if (ann?.probe) out.probe = ann.probe;
  out.retireCandidate = ann?.retireCandidate ?? null;
  const extra: Record<string, unknown> = {};
  extra.failAfter = ann?.failAfter ?? null;
  extra.lateFactor = ann?.lateFactor ?? null;
  out.facts = { ...(job.facts ?? {}), ...extra };
  return out;
}

export async function runTick(l: Ledger, opts: TickOptions = {}): Promise<TickReport> {
  const annotations = opts.annotations ?? opts.ctx?.annotations ?? loadAnnotations(undefined, (m) => process.stderr.write(`[system] ${m}\n`));
  const ctx = opts.ctx ?? defaultContext(annotations);
  const t0 = Date.now();
  const budget = opts.budgetMs ?? 20_000;
  const overBudget = () => Date.now() - t0 > budget;
  // Past the hard budget a tick stops reading and only notifies and tidies up, so a loaded machine still gets its
  // alerts out within a couple of minutes (the last readings stand).
  const hardBudget = opts.hardBudgetMs ?? 45_000;
  const overHardBudget = () => Date.now() - t0 > hardBudget;
  const ALWAYS = new Set(["notify", "held", "prune", "drop"]);
  const now = ctx.now();
  const nowIso = now.toISOString();
  const failedRunners = new Set<Runner>();
  const skip = new Set(opts.skipSteps ?? []);
  const report: TickReport = {
    startedAt: nowIso,
    durationMs: 0,
    discovered: {},
    notes: [],
    ingested: 0,
    services: { up: [], down: [] },
    incidentsOpened: 0,
    eventsRecorded: 0,
    unmanaged: 0,
    lateEvents: 0,
    logs: { large: 0, rotated: 0 },
    notify: { sent: 0, pending: 0 },
    pruned: { events: 0, incidents: 0, runs: 0, jobs: 0 },
    steps: {},
  };
  const note = (m: string) => {
    report.notes.push(m);
    ctx.warn(m);
  };
  const step = async (name: string, fn: () => Promise<void> | void) => {
    // What discovery already read is always stored; reading more is what the hard budget stops.
    if (overHardBudget() && !ALWAYS.has(name) && !name.startsWith("store ") && !name.startsWith("effect ")) {
      note(`${name}: skipped (over the hard tick budget)`);
      return;
    }
    const s0 = Date.now();
    try {
      await fn();
    } catch (err) {
      note(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const ms = Date.now() - s0;
    report.steps[name] = ms;
    if (ms > 5_000) note(`${name}: slow (${Math.round(ms / 1000)} s)`);
  };

  try {
    if (!acquireLock(l, now)) {
      report.skipped = "another tick holds the lock";
      return report;
    }
  } catch (err) {
    report.skipped = `lock: ${err instanceof Error ? err.message : String(err)}`;
    return report;
  }

  const maxIncident = () => (l.db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM incidents").get() as { n: number }).n;
  const maxEvent = () => (l.db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM events").get() as { n: number }).n;
  const incBefore = maxIncident();
  const evBefore = maxEvent();

  try {
    // Shared process snapshot (tmux child pids, unmanaged scan).
    let processes: ProcessInfo[] = [];
    await step("ps", async () => {
      const r = await ctx.exec("ps", PS_ARGS, { timeoutMs: 15000 });
      if (r.code === 0) processes = parsePs(r.stdout);
      else note(`ps: ${r.error ?? `exit ${r.code}`}`);
    });

    // 1. Discover.
    const cachedPlists = getJsonCursor<Record<string, { mtimeMs: number; doc: Record<string, unknown> }>>(l, PLIST_CURSOR) ?? {};
    const plistCache = new Map(Object.entries(cachedPlists));
    const input: DiscoveryInput = { ctx, prev: (id) => getJob(l, id), processes, plistCache };
    const discoverers: Record<Runner, () => Promise<DiscoveryResult>> = {
      schedule: () => discoverSchedules(input, opts.scheduleSource),
      launchd: () => discoverLaunchd(input),
      tmux: () => discoverTmux(input, opts.startupInfo),
      docker: () => discoverDocker(input),
      routine: () => discoverRoutines(input),
      background: () => discoverBackground(input),
      "loom-wait": () => discoverLoomWaits(input),
      server: () => discoverServer(input),
    };
    let runners = opts.runners ?? (Object.keys(discoverers) as Runner[]);
    // Discovery is the longest read; past the hard budget (ps alone can take that long under load) it waits a tick.
    if (overHardBudget() && runners.length) {
      note("discover: skipped (over the hard tick budget)");
      for (const r of runners) failedRunners.add(r);
      runners = [];
    }
    const results = await Promise.all(
      runners.map(async (runner) => {
        try {
          // launchd reads one plist and one `launchctl print` per agent; under heavy load that needs longer.
          return await withTimeout(discoverers[runner](), runner === "launchd" ? 25_000 : 10_000, `discover ${runner}`);
        } catch (err) {
          note(`discover ${runner}: ${err instanceof Error ? err.message : String(err)}`);
          failedRunners.add(runner);
          return null;
        }
      }),
    );
    const seenIds = new Set<string>();
    for (const res of results) {
      if (!res) continue;
      if (res.note) note(`discover ${res.runner}: ${res.note}`);
      // An incomplete reading (a command timed out without throwing) is no verdict for the late check either.
      if (!res.complete) failedRunners.add(res.runner);
      report.discovered[res.runner] = res.jobs.length;
      await step(`store ${res.runner}`, () =>
        tx(l, () => {
          for (const j of res.jobs) {
            upsertJob(l, { ...applyAnnotations(j, annotations), seenAt: nowIso });
            seenIds.add(j.id);
          }
          if (res.complete && EPHEMERAL.includes(res.runner)) {
            const gone = l.db.prepare("SELECT id FROM jobs WHERE runner = ? AND managed = 1 AND state != 'retired' AND seen_at < ?").all(res.runner, nowIso) as Array<{ id: string }>;
            for (const g of gone) {
              closeJobIncidents(l, g.id, nowIso);
              l.db.prepare("DELETE FROM jobs WHERE id = ?").run(g.id);
            }
          }
        }),
      );
      for (const eff of res.effects) {
        await step(`effect ${res.runner}`, () => {
          if (eff.type === "run") recordRun(l, eff.run, { source: "tick" });
          else recordEvent(l, eff.event);
        });
      }
    }
    await step("store plists", () => {
      const keep = Object.fromEntries([...plistCache].filter(([file]) => fs.existsSync(file)));
      setJsonCursor(l, PLIST_CURSOR, keep);
    });

    // 2. Ingest schedule_runs.
    if (!skip.has("ingest")) {
      await step("ingest", () => {
        const r = ingestScheduleRuns(l, ctx.tangoDbPath, { now });
        report.ingested = r.ingested;
      });
    }

    // Incidents about something that no longer applies (after ingest, so a run read this tick can't reopen them):
    // a schedule whose delivery was turned off, a job paused or retired outside the desk, and an unmanaged process
    // that is no longer tracked (stopped, or gone while a scan was skipped).
    await step("settle", () => {
      for (const j of listJobs(l, { managed: true, includeRetired: true })) {
        if (j.state !== "active") closeJobIncidents(l, j.id, nowIso);
        else if (j.runner === "schedule" && j.facts.deliveryOff === true) closeJobIncidents(l, j.id, nowIso, ["delivery.failed"]);
      }
      const orphans = l.db
        .prepare("SELECT DISTINCT job_id FROM incidents WHERE status != 'resolved' AND job_id LIKE 'launchd:unmanaged-%' AND job_id NOT IN (SELECT id FROM jobs)")
        .all() as Array<{ job_id: string }>;
      for (const o of orphans) closeJobIncidents(l, o.job_id, nowIso);
    });

    // 3. Probe services and the machine.
    let botUp = true;
    if (!skip.has("probe")) {
      await step("probe", async () => {
        const prevHealth = getJsonCursor<HealthSnapshot>(l, HEALTH_CURSOR);
        const streaks = getJsonCursor<Record<string, number>>(l, "health.fails") ?? {};
        const down = new Set(getJsonCursor<string[]>(l, "health.down") ?? []);
        const results = await Promise.all(annotations.services.map(async (s) => ({ s, r: await probeService(ctx, s).catch((e) => ({ ok: false, detail: String(e) })) })));
        const services: HealthSnapshot["services"] = [];
        for (const { s, r } of results) {
          const before = prevHealth?.services.find((x) => x.id === s.id);
          // One slow answer under load isn't "down" on the page either: it shows down from the second miss, like the incident.
          const failsInRow = r.ok ? 0 : (streaks[s.id] ?? 0) + 1;
          const shownOk = r.ok || ("unavailable" in r && r.unavailable ? false : failsInRow < 2);
          const since = before && before.ok === shownOk ? before.since : nowIso;
          services.push({ id: s.id, name: s.name, ok: shownOk, detail: r.ok || !shownOk ? r.detail : `slow to answer (${r.detail})`, since });
          (r.ok ? report.services.up : report.services.down).push(s.id);
          if (s.id === "bot") botUp = r.ok;
          const jobId = `service:${s.id}`;
          if (r.ok) {
            streaks[s.id] = 0;
            // The bot raises service.down itself (the MCP server it forks); when it restarts the server another way
            // (the bot restarting) nothing says it's back, and a critical stayed open 90 min with MCP answering (10/20).
            if (down.has(s.id) || hasOpenIncidentOfKind(l, jobId, ["service.down"])) {
              down.delete(s.id);
              recordEvent(l, { source: "tick", kind: "service.up", severity: "recovery", title: `${s.name} is back`, jobId, detail: r.detail, at: nowIso });
            }
          } else {
            streaks[s.id] = (streaks[s.id] ?? 0) + 1;
            // Two failed probes in a row (about two minutes) before it counts, so one slow answer is not an incident.
            if (!("unavailable" in r && r.unavailable) && streaks[s.id]! >= 2 && !down.has(s.id)) {
              down.add(s.id);
              recordEvent(l, { source: "tick", kind: "service.down", severity: s.critical ? "critical" : "error", title: `${s.name} is down`, jobId, detail: r.detail, at: nowIso });
            }
          }
        }
        const machine = await machineHealth(ctx);
        const snapshot: HealthSnapshot = { checkedAt: nowIso, services, machine };
        tx(l, () => {
          setJsonCursor(l, HEALTH_CURSOR, snapshot);
          setJsonCursor(l, "health.fails", streaks);
          setJsonCursor(l, "health.down", [...down]);
        });
      });
    }

    // 4. Late check.
    if (!skip.has("late")) {
      await step("late", () => {
        for (const job of listJobs(l, { managed: true })) {
          if (job.state !== "active" || !job.cadenceSeconds || job.cadenceSeconds <= 0) continue;
          if (job.runner === "schedule" && !botUp) continue; // the bot being down is the one problem, not every schedule
          if (job.runner === "loom-wait" || job.runner === "background") continue;
          // Its discoverer failed this tick (timed out under load): no fresh reading, so no verdict.
          if (failedRunners.has(job.runner)) continue;
          const factor = typeof job.facts.lateFactor === "number" ? (job.facts.lateFactor as number) : lateFactor(job.criticality);
          const last = job.lastRunAt ?? (typeof job.facts.firstSeenAt === "string" ? (job.facts.firstSeenAt as string) : null);
          if (!last) continue;
          const age = now.getTime() - Date.parse(last);
          if (age <= factor * job.cadenceSeconds * 1000) {
            // On time again. A run record usually resolves it, but some jobs show only their last start: the tick
            // sees its own job running every minute and records a finished run about twice a day, so its late
            // incident stayed open for hours after it caught up (10/20).
            if (job.lastStatus !== "failed" && hasOpenIncidentOfKind(l, job.id, ["job.late"])) resolveJobIncidents(l, job.id, ["job.late"], nowIso);
            continue;
          }
          const title = `${job.name} is late`;
          if (hasOpenIncident(l, job.id, "job.late", title)) continue;
          recordEvent(l, {
            source: "tick",
            kind: "job.late",
            severity: job.criticality === "critical" ? "error" : "warning",
            title,
            jobId: job.id,
            detail: `${job.lastRunAt ? `last run ${Math.round(age / 60_000)} min ago` : "no run seen yet"}; expected ${job.cadence ?? humanSeconds(job.cadenceSeconds)}`,
            at: nowIso,
          });
          report.lateEvents += 1;
        }
      });
    }

    // 5. Unmanaged processes and sustained load.
    if (!skip.has("unmanaged")) {
      if (overBudget()) note("unmanaged: skipped (over the tick budget)");
      else
        await step("unmanaged", async () => {
          const [net, list] = await Promise.all([
            ctx.exec("netstat", ["-anv", "-p", "tcp"], { timeoutMs: 10000 }),
            ctx.exec("launchctl", ["list"], { timeoutMs: 5000 }),
          ]);
          if (net.code !== 0) {
            note(`unmanaged: netstat ${net.error ?? `exit ${net.code}`}`);
            return;
          }
          const known = list.code === 0 ? launchdPids(list.stdout) : new Set<number>();
          for (const j of listJobs(l, { managed: true })) {
            for (const key of ["pid", "panePid"]) {
              const p = j.facts[key];
              if (typeof p === "number") known.add(p);
            }
          }
          const found = scanUnmanaged({
            processes,
            listens: parseNetstatListen(net.stdout),
            knownPids: known,
            uid: ctx.uid,
            ignorePrefixes: annotations.unmanaged.ignoreCommandPrefixes,
          });
          report.unmanaged = found.length;
          const ids = new Set(found.map((f) => f.id));
          tx(l, () => {
            for (const f of found) {
              const isNew = !getJob(l, f.id);
              upsertJob(l, { ...applyAnnotations(f, annotations), seenAt: nowIso });
              if (isNew) recordEvent(l, { source: "tick", kind: "process.unmanaged", severity: "info", title: `Unmanaged process ${f.name}`, jobId: f.id, detail: String(f.facts?.command ?? ""), at: nowIso });
            }
            const old = l.db.prepare("SELECT id FROM jobs WHERE managed = 0").all() as Array<{ id: string }>;
            for (const o of old) {
              if (ids.has(o.id)) continue;
              if (hasOpenIncidentOfKind(l, o.id, ["process.unmanaged"])) recordEvent(l, { source: "tick", kind: "process.gone", severity: "recovery", title: "Unmanaged process exited", jobId: o.id, at: nowIso });
              l.db.prepare("DELETE FROM jobs WHERE id = ?").run(o.id);
            }
          });
        });
      await step("load", () => {
        const health = getJsonCursor<HealthSnapshot>(l, HEALTH_CURSOR);
        const m = health?.machine;
        if (!m) return;
        const high = m.load5 > m.cores * 1.5;
        const since = getJsonCursor<string>(l, "load.highSince");
        const jobId = "machine:load";
        if (high) {
          if (!since) setJsonCursor(l, "load.highSince", nowIso);
          else if (now.getTime() - Date.parse(since) >= LOAD_SUSTAIN_MS && !hasOpenIncidentOfKind(l, jobId, ["load.high"])) {
            const top = [...processes].sort((a, b) => b.cpu - a.cpu).slice(0, 5);
            const unmanaged = new Set(listJobs(l, { managed: false }).map((j) => Number(j.facts.pid)));
            const lines = top.map((p) => `${unmanaged.has(p.pid) ? "[unmanaged] " : ""}${shortName(p.command)} pid ${p.pid} ${p.cpu}%`);
            recordEvent(l, { source: "tick", kind: "load.high", severity: "warning", title: "Load is high", jobId, detail: `load5 ${m.load5} on ${m.cores} cores since ${since}\n${lines.join("\n")}`, data: { load5: m.load5, cores: m.cores, top: top.map((p) => ({ pid: p.pid, cpu: p.cpu, command: p.command })) }, at: nowIso });
          }
        } else {
          if (since) setJsonCursor(l, "load.highSince", null);
          if (hasOpenIncidentOfKind(l, jobId, ["load.high"])) recordEvent(l, { source: "tick", kind: "load.normal", severity: "recovery", title: "Load is back to normal", jobId, at: nowIso });
        }
      });
    }

    // The data volume filling up: a warning from 90% used, critical from 95% or under 30 GB free (one incident that
    // escalates; 30 GB is ahead of Loom's 20 GB floor for new work), cleared below 88% with 40 GB free so it doesn't
    // flap on the line. A critical one steps back to a warning below 94% with 40 GB free: the desk lists critical
    // incidents as failed, and on 10/19 a recovered 62 GB still showed there.
    if (!skip.has("disk")) await step("disk", () => {
      const m = getJsonCursor<HealthSnapshot>(l, HEALTH_CURSOR)?.machine;
      // 0% used and 0 GB free is a failed reading (statfs couldn't read the volume), not a full disk.
      if (!m || !Number.isFinite(m.diskUsedPct) || (m.diskUsedPct === 0 && m.diskFreeGb === 0)) return;
      const jobId = "machine:disk";
      const critical = m.diskUsedPct >= 95 || m.diskFreeGb < 30;
      const warning = m.diskUsedPct >= 90;
      const open = l.db.prepare("SELECT severity FROM incidents WHERE job_id = ? AND status != 'resolved'").get(jobId) as { severity: string } | undefined;
      // Recorded when it opens or gets worse, not every minute it stays low.
      if ((critical || warning) && (!open || (critical && open.severity !== "critical"))) {
        recordEvent(l, {
          source: "tick", kind: "disk.low", severity: critical ? "critical" : "warning", title: "Disk is running out of space", jobId,
          detail: `${m.diskUsedPct}% used, ${m.diskFreeGb} GB free`, data: { usedPct: m.diskUsedPct, freeGb: m.diskFreeGb }, at: nowIso,
        });
      } else if (open?.severity === "critical" && m.diskUsedPct >= 88 && m.diskUsedPct < 94 && m.diskFreeGb >= 40) {
        l.db.prepare("UPDATE incidents SET severity = 'warning' WHERE job_id = ? AND status != 'resolved'").run(jobId);
      } else if (m.diskUsedPct < 88 && m.diskFreeGb >= 40 && hasOpenIncidentOfKind(l, jobId, ["disk.low"])) {
        recordEvent(l, { source: "tick", kind: "disk.ok", severity: "recovery", title: "Disk has room again", jobId, detail: `${m.diskUsedPct}% used, ${m.diskFreeGb} GB free`, at: nowIso });
      }
    });

    // Loom's recovery hold and the recovery mini's space: loud (Discord) and deduped, with a trend line.
    if (!skip.has("recovery")) await step("recovery", () => {
      const r = checkRecovery(l, ctx);
      if (r.freeGb == null && r.held == null) return;
      report.recovery = `mini ${r.host ?? "?"}: ${r.freeGb ?? "?"} GB free${r.line ? `, ${r.line}` : ""}; ${r.held ?? "?"} held`;
      const snapshot = getJsonCursor<HealthSnapshot>(l, HEALTH_CURSOR);
      if (snapshot) setJsonCursor(l, HEALTH_CURSOR, { ...snapshot, recovery: { host: r.host, freeGb: r.freeGb, trendGbPerDay: r.trendGbPerDay, daysToPause: r.daysToPause, held: r.held, at: nowIso } });
    });

    // 6. Logs.
    if (!skip.has("logs")) {
      await step("logs", async () => {
        const seen = new Set<string>();
        for (const job of listJobs(l, { managed: true })) {
          for (const raw of job.logs) {
            const file = expandLogPath(raw);
            if (seen.has(file)) continue;
            seen.add(file);
            let size: number;
            try {
              size = fs.statSync(file).size;
            } catch {
              continue;
            }
            // The file's own name keeps each log its own incident (absolute paths normalize to one token).
            const title = `Log is large: ${path.basename(file)}`;
            if (size > LOG_WARN_BYTES) {
              report.logs.large += 1;
              if (!hasOpenIncident(l, job.id, "log.large", title)) {
                recordEvent(l, { source: "tick", kind: "log.large", severity: "warning", title, jobId: job.id, detail: `${Math.round(size / 1024 / 1024)} MB`, data: { file, size }, at: nowIso });
              }
              if (size > LOG_ROTATE_BYTES && !opts.noActions) {
                if (overBudget()) {
                  note(`logs: rotation of ${file} deferred (over the tick budget)`);
                  continue;
                }
                await rotateLog(file);
                report.logs.rotated += 1;
                recordEvent(l, { source: "tick", kind: "log.rotated", severity: "recovery", title: `Log rotated: ${path.basename(file)}`, jobId: job.id, data: { file }, at: nowIso, resolves: { kind: "log.large", title } });
              }
            } else if (hasOpenIncident(l, job.id, "log.large", title)) {
              recordEvent(l, { source: "tick", kind: "log.ok", severity: "recovery", title: `Log is back under the limit: ${path.basename(file)}`, jobId: job.id, data: { file }, at: nowIso, resolves: { kind: "log.large", title } });
            }
          }
        }
      });
    }

    // Drop jobs no discovery has seen for a day (unless retired).
    await step("drop", () => {
      const cutoff = new Date(now.getTime() - DAY).toISOString();
      const r = l.db.prepare("DELETE FROM jobs WHERE state != 'retired' AND managed = 1 AND seen_at < ?").run(cutoff);
      report.pruned.jobs = Number(r.changes);
    });

    // Recoveries the flap guard held, now that their window has passed.
    await step("held", () => {
      releaseHeldRecoveries(l, nowIso);
    });

    // 7. Notify.
    if (!skip.has("notify")) {
      await step("notify", async () => {
        const r = await notifyCritical(l, ctx, { dryRun: opts.noNotify });
        report.notify = { sent: r.sent, pending: r.pending };
      });
    }

    // 8. Prune.
    if (!skip.has("prune")) {
      await step("prune", () =>
        tx(l, () => {
          // An unresolved incident keeps its events: recovery matching reads its kind from them.
          const ev = l.db
            .prepare("DELETE FROM events WHERE at < ? AND (incident_id IS NULL OR incident_id NOT IN (SELECT id FROM incidents WHERE status != 'resolved'))")
            .run(new Date(now.getTime() - 30 * DAY).toISOString());
          const inc = l.db.prepare("DELETE FROM incidents WHERE status = 'resolved' AND resolved_at < ?").run(new Date(now.getTime() - 90 * DAY).toISOString());
          const rq = l.db.prepare("DELETE FROM runs WHERE status = 'quiet' AND started_at < ?").run(new Date(now.getTime() - 7 * DAY).toISOString());
          const rr = l.db.prepare("DELETE FROM runs WHERE started_at < ?").run(new Date(now.getTime() - 90 * DAY).toISOString());
          report.pruned.events = Number(ev.changes);
          report.pruned.incidents = Number(inc.changes);
          report.pruned.runs = Number(rq.changes) + Number(rr.changes);
        }),
      );
    }
  } finally {
    report.incidentsOpened = maxIncident() - incBefore;
    report.eventsRecorded = maxEvent() - evBefore;
    report.durationMs = Date.now() - t0;
    try {
      setJsonCursor(l, "tick.last", { at: nowIso, durationMs: report.durationMs, notes: report.notes.slice(0, 20) });
    } catch {
      // best effort
    }
    releaseLock(l);
  }
  return report;
}
