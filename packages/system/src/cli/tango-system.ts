#!/usr/bin/env node
/**
 * tango-system tick [--no-notify] [--no-actions] [--baseline] [--json]
 * tango-system status [--json]
 * tango-system jobs [--all] [--runner <runner>] [--json]
 * tango-system action <job-id> <run|pause|resume|restart|retire|restore> [--force] [--reason "<text>"]
 * tango-system stop <job-id>
 * tango-system wait-keeper [--dry-run] [--json]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `usage:
  tango-system tick [--no-notify] [--no-actions] [--baseline] [--json]
  tango-system status [--json]
  tango-system jobs [--all] [--runner <runner>] [--json]
  tango-system action <job-id> <run|pause|resume|restart|retire|restore> [--force] [--reason "<text>"]
  tango-system stop <job-id>
  tango-system wait-keeper [--dry-run] [--json]`;

function flag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function value(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const ago = (iso: string | null, now = Date.now()): string => {
  if (!iso) return "never";
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 0) return `in ${Math.round(-s / 60)} min`;
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

export async function runSystemCli(argv: string[], out: (s: string) => void = (s) => process.stdout.write(s)): Promise<number> {
  const cmd = argv[0];
  const json = flag(argv, "--json");
  if (!cmd || cmd === "-h" || cmd === "--help") {
    out(`${USAGE}\n`);
    return cmd ? 0 : 64;
  }
  const sys = await import("../index.js");

  if (cmd === "tick") {
    // Schedule configs layer repo defaults under the profile by cwd; run from the checkout this CLI ships in.
    if (!process.env.TANGO_CONFIG_DIR) {
      const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
      if (fs.existsSync(path.join(repo, "config", "defaults"))) process.chdir(repo);
    }
    let l;
    try {
      l = sys.openLedger();
    } catch (err) {
      process.stderr.write(`tango-system: cannot open the ledger: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    try {
      const baseline = flag(argv, "--baseline");
      const report = await sys.runTick(l, { noNotify: baseline || flag(argv, "--no-notify"), noActions: flag(argv, "--no-actions") });
      // A first tick on an existing machine takes in days of history; --baseline
      // records it without announcing incidents that were already old news.
      if (baseline) {
        const at = new Date().toISOString();
        const r = l.db
          .prepare("UPDATE incidents SET notified_at = ?, notified_severity = severity, notify_pending = NULL WHERE notify_pending IS NOT NULL")
          .run(at);
        report.notes.push(`baseline: ${r.changes} pending notification(s) marked as already sent`);
      }
      if (json) out(`${JSON.stringify(report, null, 2)}\n`);
      else if (report.skipped) out(`tick skipped: ${report.skipped}\n`);
      else {
        const disc = Object.entries(report.discovered).map(([k, v]) => `${k} ${v}`).join(", ");
        out(
          `tick ${report.durationMs} ms · discovered ${disc || "nothing"} · ingested ${report.ingested} runs · ` +
            `services up ${report.services.up.length}, down ${report.services.down.length}${report.services.down.length ? ` (${report.services.down.join(", ")})` : ""} · ` +
            `events ${report.eventsRecorded}, incidents opened ${report.incidentsOpened} · unmanaged ${report.unmanaged} · late ${report.lateEvents} · ` +
            `logs large ${report.logs.large}, rotated ${report.logs.rotated} · notify sent ${report.notify.sent}, pending ${report.notify.pending}\n`,
        );
        for (const n of report.notes) out(`  note: ${n}\n`);
      }
      return 0;
    } catch (err) {
      // A tick never throws to launchd; report and exit cleanly.
      process.stderr.write(`tango-system: tick failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      return 0;
    } finally {
      l.close();
    }
  }

  if (cmd === "status" || cmd === "jobs") {
    let l;
    try {
      l = sys.openLedger({ readonly: true });
    } catch (err) {
      process.stderr.write(`tango-system: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    try {
      if (cmd === "status") {
        const summary = sys.systemSummary(l);
        const health = sys.readHealth(l);
        const incidents = sys.listIncidents(l, { status: "active" });
        if (json) {
          out(`${JSON.stringify({ summary, health, incidents }, null, 2)}\n`);
          return 0;
        }
        out(`${summary.line}\n`);
        out(`jobs ${summary.jobs} · failing ${summary.failing} · late ${summary.late} · unmanaged ${summary.unmanaged} · retire candidates ${summary.retireCandidates} · critical ${summary.critical} · open ${summary.open}\n`);
        if (health) {
          out(`checked ${ago(health.checkedAt)}\n`);
          out(`services: ${health.services.map((s) => `${s.ok ? "up" : "DOWN"} ${s.name}${s.ok ? "" : ` (${s.detail})`}`).join(" · ")}\n`);
          const m = health.machine;
          out(`machine: load ${m.load1}/${m.load5} on ${m.cores} cores · memory ${m.memUsedGb}/${m.memTotalGb} GB · disk ${m.diskUsedPct}% used, ${m.diskFreeGb} GB free\n`);
        }
        if (incidents.length) out(`\nincidents:\n`);
        for (const i of incidents) {
          const route = sys.incidentRoute(l, i);
          out(`  #${i.id} [${i.severity}/${route}${i.status !== "open" ? `/${i.status}` : ""}] ${i.title} · ${i.count}× · first ${ago(i.firstSeen)} · last ${ago(i.lastSeen)}${i.regressed ? " · regressed" : ""}${i.flapping ? " · flapping" : ""}\n`);
        }
        return 0;
      }
      const runner = value(argv, "--runner");
      const jobs = sys.listJobs(l, { includeRetired: flag(argv, "--all") }).filter((j) => !runner || j.runner === runner);
      if (json) {
        out(`${JSON.stringify(jobs, null, 2)}\n`);
        return 0;
      }
      const counts: Record<string, number> = {};
      for (const j of jobs) counts[`${j.runner}${j.managed ? "" : " (unmanaged)"}`] = (counts[`${j.runner}${j.managed ? "" : " (unmanaged)"}`] ?? 0) + 1;
      let group = "";
      for (const j of [...jobs].sort((a, b) => (a.group ?? "").localeCompare(b.group ?? "") || a.runner.localeCompare(b.runner) || a.name.localeCompare(b.name))) {
        if ((j.group ?? "") !== group) {
          group = j.group ?? "";
          out(`\n${group || "(no group)"}\n`);
        }
        const flags = [j.state !== "active" ? j.state : null, j.criticality !== "normal" ? j.criticality : null, j.managed ? null : "unmanaged", j.retireCandidate ? "retire?" : null].filter(Boolean).join(", ");
        out(`  ${(j.lastStatus ?? "-").padEnd(8)} ${j.id.padEnd(48)} ${j.name}${j.cadence ? ` · ${j.cadence}` : ""} · last ${ago(j.lastRunAt)}${flags ? ` [${flags}]` : ""}\n`);
      }
      out(`\n${jobs.length} jobs: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}\n`);
      return 0;
    } finally {
      l.close();
    }
  }

  if (cmd === "action" || cmd === "stop") {
    const jobId = argv[1];
    if (!jobId) {
      out(`${USAGE}\n`);
      return 64;
    }
    const l = sys.openLedger();
    try {
      const r =
        cmd === "stop"
          ? await sys.stopProcess(l, jobId)
          : await sys.jobAction(l, jobId, argv[2] as "run", { force: flag(argv, "--force"), reason: value(argv, "--reason") });
      out(`${r.ok ? "ok" : "failed"}: ${r.message}\n`);
      return r.ok ? 0 : 1;
    } finally {
      l.close();
    }
  }

  if (cmd === "wait-keeper") {
    // Promises to come back that nothing will keep: wake each once, flag the rest (src/wait-keeper.ts).
    const dryRun = flag(argv, "--dry-run");
    const { runWaitKeeper, defaultKeeperPaths } = await import("../wait-keeper.js");
    const { loomToken } = await import("../discovery/others.js");
    const { realFetch } = await import("../exec.js");
    const { profileDataDir } = await import("../paths.js");
    let l = null;
    if (!dryRun) {
      try {
        l = sys.openLedger();
      } catch (err) {
        process.stderr.write(`tango-system: cannot open the ledger: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
    }
    try {
      const report = await runWaitKeeper(
        l,
        {
          fetch: realFetch,
          loomUrl: (process.env.LOOM_URL || `http://127.0.0.1:${process.env.LOOM_PORT || "9420"}`).replace(/\/$/, ""),
          loomToken: loomToken(),
          ...defaultKeeperPaths(profileDataDir()),
          log: (line) => process.stderr.write(`wait-keeper: ${line}\n`),
        },
        { dryRun },
      );
      if (json) {
        out(`${JSON.stringify(report, null, 2)}\n`);
        return 0;
      }
      out(`${new Date().toISOString()} wait-keeper${dryRun ? " (dry run)" : ""}: ${report.findings.length} findings · woke ${report.woke.filter((w) => w.ok).length}${report.woke.some((w) => !w.ok) ? ` (${report.woke.filter((w) => !w.ok).length} failed)` : ""} · resolved ${report.resolved}\n`);
      for (const f of report.findings) out(`  [${f.severity}] ${f.kind} · ${f.title}${f.wake ? (dryRun ? " · would wake" : "") : ""}\n    ${f.detail}\n`);
      for (const n of report.notes) out(`  note: ${n}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`tango-system: wait-keeper failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      return 1;
    } finally {
      l?.close();
    }
  }

  out(`${USAGE}\n`);
  return 64;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  runSystemCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`tango-system: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
