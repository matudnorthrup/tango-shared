import fs from "node:fs";
import path from "node:path";
import { humanSeconds, mapLimit } from "../context.js";
import type { JobUpsert } from "../jobs.js";
import type { DiscoveryEffect, DiscoveryInput, DiscoveryResult } from "./types.js";

export interface LaunchctlListEntry {
  label: string;
  pid: number | null;
  status: number | null;
}

export function parseLaunchctlList(text: string): LaunchctlListEntry[] {
  const out: LaunchctlListEntry[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(-|\d+)\s+(-|-?\d+)\s+(\S.*?)\s*$/);
    if (!m || m[3] === "Label") continue;
    out.push({ label: m[3]!, pid: m[1] === "-" ? null : Number(m[1]), status: m[2] === "-" ? null : Number(m[2]) });
  }
  return out;
}

export interface LaunchctlPrint {
  path: string | null;
  state: string | null;
  pid: number | null;
  runs: number | null;
  lastExit: number | null;
  stdoutPath: string | null;
  stderrPath: string | null;
}

export function parseLaunchctlPrint(text: string): LaunchctlPrint {
  // Only the service's own top-level keys (one tab deep).
  const top = (key: string): string | null => {
    const m = text.match(new RegExp(`^\\t${key.replace(/ /g, "\\s")} = (.*)$`, "m"));
    return m ? m[1]!.trim() : null;
  };
  const int = (v: string | null): number | null => (v != null && /^-?\d+$/.test(v) ? Number(v) : null);
  return {
    path: top("path"),
    state: top("state"),
    pid: int(top("pid")),
    runs: int(top("runs")),
    lastExit: int(top("last exit code")),
    stdoutPath: top("stdout path"),
    stderrPath: top("stderr path"),
  };
}

interface PlistInfo {
  cadence: string | null;
  seconds: number | null;
  keepAlive: boolean;
  disabled: boolean;
  program: string | null;
  stdoutPath: string | null;
  stderrPath: string | null;
}

function entryPeriod(e: Record<string, unknown>): number {
  if (e.Weekday !== undefined) return 7 * 86400;
  if (e.Day !== undefined || e.Month !== undefined) return 31 * 86400;
  if (e.Hour !== undefined) return 86400;
  if (e.Minute !== undefined) return 3600;
  return 60;
}

const pad = (n: unknown) => String(n).padStart(2, "0");

export function plistCadence(p: Record<string, unknown>): PlistInfo {
  const keepAlive = p.KeepAlive === true || (typeof p.KeepAlive === "object" && p.KeepAlive !== null);
  const args = Array.isArray(p.ProgramArguments) ? (p.ProgramArguments as unknown[]).map(String) : [];
  const info: PlistInfo = {
    cadence: null,
    seconds: null,
    keepAlive,
    disabled: p.Disabled === true,
    program: typeof p.Program === "string" ? p.Program : args.join(" ") || null,
    stdoutPath: typeof p.StandardOutPath === "string" ? p.StandardOutPath : null,
    stderrPath: typeof p.StandardErrorPath === "string" ? p.StandardErrorPath : null,
  };
  if (typeof p.StartInterval === "number") {
    info.seconds = p.StartInterval;
    info.cadence = humanSeconds(p.StartInterval);
  } else if (p.StartCalendarInterval) {
    const entries = (Array.isArray(p.StartCalendarInterval) ? p.StartCalendarInterval : [p.StartCalendarInterval]) as Array<Record<string, unknown>>;
    // The longest single-entry period is a safe upper bound on the gap between runs.
    info.seconds = Math.max(...entries.map(entryPeriod));
    const e = entries[0] ?? {};
    if (entries.length === 1 && e.Hour !== undefined && e.Minute !== undefined && e.Weekday === undefined && e.Day === undefined) {
      info.cadence = `Daily ${pad(e.Hour)}:${pad(e.Minute)}`;
    } else if (entries.length === 1 && e.Weekday !== undefined) {
      info.cadence = `Weekly (day ${e.Weekday})${e.Hour !== undefined ? ` ${pad(e.Hour)}:${pad(e.Minute ?? 0)}` : ""}`;
    } else if (entries.length === 1 && e.Hour === undefined && e.Minute !== undefined) {
      info.cadence = `Hourly at :${pad(e.Minute)}`;
    } else {
      info.cadence = entries.length > 1 ? `${entries.length} times per period` : "Calendar";
    }
  } else if (keepAlive) {
    info.cadence = "Always on";
  } else if (p.RunAtLoad === true) {
    info.cadence = "At boot";
  } else if (p.WatchPaths || p.QueueDirectories) {
    info.cadence = "On file change";
  }
  return info;
}

const matchesPrefix = (label: string, prefixes: string[]) => prefixes.some((p) => label.startsWith(p));

/**
 * launchd agents whose labels match the configured prefixes, loaded or not (a
 * booted-out plist still in LaunchAgents is a paused job). The `runs` counter
 * from `launchctl print` going up between ticks is evidence of a run; when the
 * job is not wrapped by tango-run, that becomes an inferred run with its exit.
 */
export async function discoverLaunchd(input: DiscoveryInput): Promise<DiscoveryResult> {
  const { ctx, prev } = input;
  const prefixes = ctx.annotations.prefixes.launchd;
  const list = await ctx.exec("launchctl", ["list"], { timeoutMs: 5000 });
  if (list.code !== 0) return { runner: "launchd", jobs: [], effects: [], complete: false, note: list.error ?? list.stderr.trim() };
  const entries = parseLaunchctlList(list.stdout);
  const loaded = new Map(entries.filter((e) => matchesPrefix(e.label, prefixes)).map((e) => [e.label, e]));

  // Plists on disk (user agents) that match, loaded or not.
  const agentsDir = path.join(ctx.homeDir, "Library", "LaunchAgents");
  const onDisk = new Map<string, string>();
  const plistJson = new Map<string, Record<string, unknown>>();
  const readPlist = async (file: string): Promise<Record<string, unknown> | null> => {
    if (plistJson.has(file)) return plistJson.get(file)!;
    let mtimeMs: number | null = null;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      // unreadable: plutil decides
    }
    const cached = input.plistCache?.get(file);
    if (cached && mtimeMs !== null && cached.mtimeMs === mtimeMs) {
      plistJson.set(file, cached.doc);
      return cached.doc;
    }
    const r = await ctx.exec("plutil", ["-convert", "json", "-o", "-", file], { timeoutMs: 2000 });
    if (r.code !== 0) return null;
    try {
      const doc = JSON.parse(r.stdout) as Record<string, unknown>;
      plistJson.set(file, doc);
      if (mtimeMs !== null) input.plistCache?.set(file, { mtimeMs, doc });
      return doc;
    } catch {
      return null;
    }
  };
  let files: string[] = [];
  try {
    files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".plist") && matchesPrefix(f, prefixes));
  } catch {
    // no LaunchAgents dir
  }
  await mapLimit(files, 8, async (f) => {
    const file = path.join(agentsDir, f);
    // The plist's Label is the job's identity; the file name usually matches it, but not always.
    const doc = await readPlist(file);
    const label = typeof doc?.Label === "string" ? doc.Label : f.slice(0, -".plist".length);
    if (matchesPrefix(label, prefixes)) onDisk.set(label, file);
  });

  const labels = [...new Set([...loaded.keys(), ...onDisk.keys()])].sort();
  const effects: DiscoveryEffect[] = [];
  const nowIso = ctx.now().toISOString();
  const jobs = await mapLimit(labels, 8, async (label): Promise<JobUpsert> => {
    const entry = loaded.get(label);
    let printed: LaunchctlPrint | null = null;
    if (entry) {
      const r = await ctx.exec("launchctl", ["print", `gui/${ctx.uid}/${label}`], { timeoutMs: 2500 });
      if (r.code === 0) printed = parseLaunchctlPrint(r.stdout);
    }
    const plistPath = printed?.path ?? onDisk.get(label) ?? null;
    let plist: PlistInfo | null = null;
    if (plistPath && fs.existsSync(plistPath)) {
      const doc = await readPlist(plistPath);
      if (doc) plist = plistCadence(doc);
    }
    const id = `launchd:${label}`;
    const before = prev(id);
    const lastExit = printed?.lastExit ?? entry?.status ?? null;
    const pid = printed?.pid ?? entry?.pid ?? null;
    const runs = printed?.runs ?? null;
    const prevRuns = typeof before?.facts.runs === "number" ? (before.facts.runs as number) : null;
    // Loaded, but `launchctl print` gave nothing this tick (it timed out over the tick budget): no reading, so
    // what the ledger remembers about its runs stands. Only a missing entry is an unload.
    const unread = Boolean(entry) && !printed;
    const wrapped = before?.facts.wrapped === true;
    let lastRunAt: string | undefined;
    let lastStatus: string | undefined;
    const logs = [plist?.stdoutPath ?? printed?.stdoutPath, plist?.stderrPath ?? printed?.stderrPath].filter((x): x is string => Boolean(x));
    // The newest write to its logs: once a run is recorded (either way), that write is spent (Codex review on #774).
    const written = Math.max(0, ...[...new Set(logs)].map((f) => logMtime(f)));
    let logSeenAt = typeof before?.facts.logSeenAt === "number" ? (before.facts.logSeenAt as number) : 0;
    if (runs !== null && prevRuns !== null && runs > prevRuns) {
      lastRunAt = nowIso;
      // A KeepAlive service's "run" is a restart, not a job run.
      if (!wrapped && !plist?.keepAlive && pid === null) {
        const status = lastExit === 0 || lastExit === null ? "ok" : "failed";
        lastStatus = status;
        effects.push({
          type: "run",
          run: { jobId: id, startedAt: nowIso, finishedAt: nowIso, status, exitCode: lastExit, summary: "inferred from launchctl runs counter", sourceRef: `launchd-tick:${label}:${runs}:${nowIso}` },
        });
      }
    }
    // Only a finished run spends the log write; a job still running may yet fail without writing again (Codex review on #774).
    if (lastStatus === "ok" || lastStatus === "failed") logSeenAt = Math.max(logSeenAt, written);
    // The (runs, exit) the ledger last recorded a run for: what an exit-code-only run is deduplicated against.
    const observed = runs !== null && lastExit !== null ? `${runs}:${lastExit}` : null;
    // Unloaded (gone from launchctl list) or reset (counter went down): launchd starts counting again, so an old
    // observation mustn't hide the first failure after it (Codex review on #774). A tick that couldn't read the
    // job is neither: treating it as one re-raised a 2-day-old boot failure after it was resolved (#178). Nor is
    // one `launchctl list` that left it out: a loaded job missed from a single listing on a machine under load
    // re-raised the same failure twice. Unloaded means missing from two listings in a row.
    const prevMissing = typeof before?.facts.missing === "number" ? (before.facts.missing as number) : before?.facts.loaded === false ? 1 : 0;
    // A job first seen unloaded has no earlier listing to have missed, and one paused on purpose (its bootout is
    // why the listing left it out) is meant to be unloaded: either way it's unloaded at once (Codex review on #895).
    const missing = entry ? 0 : before && before.state !== "paused" ? prevMissing + 1 : 2;
    const reset = missing >= 2 || (runs !== null && prevRuns !== null && runs < prevRuns);
    const seenBefore = typeof before?.facts.exitSeen === "string" ? (before.facts.exitSeen as string) : null;
    let exitSeen = reset ? EXIT_RESET : seenBefore;
    if (lastStatus) exitSeen = observed;
    // A calendar or one-shot job the tick never saw run (launchd reloaded, or it ran before the tick did): its
    // log's last write is when it last ran, and launchd's last exit code how it went. Never for a service.
    let lastRunFrom: "log" | undefined;
    const oneShot = !wrapped && !plist?.keepAlive && pid === null;
    if (!lastRunAt && oneShot) {
      const known = Math.max(before?.lastRunAt ? Date.parse(before.lastRunAt) : 0, logSeenAt);
      if (written > known) {
        logSeenAt = written;
        lastRunAt = new Date(written).toISOString();
        lastRunFrom = "log";
        // Its outcome too, so a clean run resolves an earlier failure (Codex review on #774).
        if (lastExit !== null) {
          lastStatus = lastExit === 0 ? "ok" : "failed";
          exitSeen = observed;
          effects.push({
            type: "run",
            run: { jobId: id, startedAt: lastRunAt, finishedAt: lastRunAt, status: lastStatus as "ok" | "failed", exitCode: lastExit, summary: "inferred from its log's last write and launchd's last exit", sourceRef: `launchd-log:${label}:${written}` },
          });
        }
      }
    }
    // A one-shot that failed before the tick could watch its runs counter (an "at load" job at boot, before the
    // tick started): its exit code is the only record. Once per (runs, exit) observation, so a repeat failure
    // after launchd reloads it is recorded too (Codex review on #774).
    // New only after a reset, when the (runs, exit) changed, or for a job the ledger never saw run: a stale exit
    // code with nothing newer behind it raises nothing.
    const newExit = exitSeen === EXIT_RESET || (exitSeen !== null ? observed !== exitSeen : !before?.lastRunAt);
    if (!lastStatus && !unread && oneShot && runs !== null && runs > 0 && lastExit !== null && lastExit !== 0 && newExit) {
      lastStatus = "failed";
      exitSeen = observed;
      effects.push({
        type: "run",
        run: { jobId: id, startedAt: nowIso, finishedAt: nowIso, status: "failed", exitCode: lastExit, summary: `last exit ${lastExit} (seen by the tick, not when it ran)`, sourceRef: `launchd-exit:${label}:${runs}:${lastExit}:${nowIso}` },
      });
    }
    if (pid !== null && !lastStatus) lastStatus = "running";
    return {
      id,
      runner: "launchd",
      name: label,
      cadence: plist?.cadence ?? null,
      cadenceSeconds: plist?.seconds ?? null,
      source: plistPath,
      logs: [...new Set(logs)],
      // A single missed listing isn't a pause either: a paused job's open incidents are settled (Codex review on #895).
      state: entry || missing === 1 ? "active" : "paused",
      lastRunAt,
      lastStatus,
      lastExit,
      facts: {
        loaded: Boolean(entry),
        pid,
        // Unread: the old counter stands, unless its log already gave the run this tick (the next reading's
        // higher counter must not count it again; Codex review on #833).
        runs: unread || missing === 1 ? (lastRunFrom === "log" ? null : prevRuns) : runs,
        lastExit,
        launchdState: printed?.state ?? null,
        keepAlive: plist?.keepAlive ?? false,
        program: plist?.program ?? null,
        plistDisabled: plist?.disabled ?? false,
        ...(lastRunFrom ? { lastRunFrom } : {}),
        exitSeen,
        missing,
        ...(logSeenAt ? { logSeenAt } : {}),
      },
    } satisfies JobUpsert;
  });
  return { runner: "launchd", jobs, effects, complete: true };
}

/** exitSeen after launchd unloaded or reset a job: the next exit it reports is a new run's. */
const EXIT_RESET = "reset";

function logMtime(file: string): number {
  try {
    const st = fs.statSync(file.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
    // An empty log (an .err nothing was ever written to) says nothing about a run.
    return st.size > 0 ? st.mtimeMs : 0;
  } catch {
    return 0;
  }
}

/** Every launchd-managed pid (any label), for the unmanaged scan. */
export function launchdPids(text: string): Set<number> {
  return new Set(parseLaunchctlList(text).map((e) => e.pid).filter((p): p is number => p !== null));
}
