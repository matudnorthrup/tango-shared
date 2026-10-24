import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SystemContext } from "../context.js";
import type { JobUpsert } from "../jobs.js";
import type { DiscoveryEffect, DiscoveryInput, DiscoveryResult, ProcessInfo } from "./types.js";

export interface StartupService {
  id: string;
  name?: string;
  enabled?: boolean;
  optional?: boolean;
  tmux?: { window?: string };
  health?: { checks?: Array<Record<string, unknown>> };
}

export interface StartupInfo {
  services: StartupService[];
  tmux: { session?: string; socketName?: string };
  defaultConfigPath: string;
  profileConfigPath: string;
}

/** Loads the startup config the same way scripts/startup.sh does (repo defaults + profile overlay). */
export async function loadStartupInfo(ctx: SystemContext): Promise<StartupInfo | null> {
  const runner = path.join(ctx.repoDir, "scripts", "startup-runner.mjs");
  if (!fs.existsSync(runner)) return null;
  const mod = (await import(pathToFileURL(runner).href)) as {
    resolveStartupContext: (o: { env: NodeJS.ProcessEnv }) => { defaultConfigPath: string; profileConfigPath: string };
    loadStartupConfig: (c: unknown) => { services?: StartupService[]; tmux?: { session?: string; socketName?: string } };
  };
  const context = mod.resolveStartupContext({ env: { ...process.env, TANGO_REPO_DIR: ctx.repoDir } });
  const config = mod.loadStartupConfig(context);
  return {
    services: Array.isArray(config.services) ? config.services : [],
    tmux: config.tmux ?? {},
    defaultConfigPath: context.defaultConfigPath,
    profileConfigPath: context.profileConfigPath,
  };
}

export interface TmuxTarget {
  args: string[];
  session: string;
}

/** The service tmux server: annotations, then TANGO_SERVICE_TMUX_SOCKET, then the startup config's socket name. */
export function tmuxTarget(ctx: SystemContext, startup: StartupInfo | null): TmuxTarget {
  const a = ctx.annotations.tmux;
  const socket = a.socket ?? process.env.TANGO_SERVICE_TMUX_SOCKET?.trim();
  const socketName = a.socketName ?? process.env.TANGO_SERVICE_TMUX_SOCKET_NAME?.trim() ?? startup?.tmux.socketName ?? "tango-service";
  const session = a.session ?? process.env.TANGO_TMUX_SESSION?.trim() ?? startup?.tmux.session ?? "tango";
  return { args: socket ? ["-S", socket] : ["-L", socketName], session };
}

export interface PaneInfo {
  window: string;
  panePid: number;
  dead: boolean;
  command: string;
}

export function parsePanes(text: string): PaneInfo[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      // tmux prints control characters (a tab) as "_", so fields are "|"-separated; the window name may itself hold "|".
      const parts = line.split("|");
      const command = parts.pop() ?? "";
      const dead = parts.pop() ?? "0";
      const pid = parts.pop() ?? "0";
      return { window: parts.join("|"), panePid: Number(pid), dead: dead === "1", command };
    });
}

const RESTART_WINDOW_MS = 10 * 60_000;
const RESTART_CHANGES = 3;

/** First child of the pane shell (the supervisor loop's current process), so restarts inside a loop count. */
function childOf(pid: number, processes: ProcessInfo[] | undefined): number | null {
  if (!processes) return null;
  const kids = processes.filter((p) => p.ppid === pid).sort((a, b) => a.pid - b.pid);
  return kids[0]?.pid ?? null;
}

export async function discoverTmux(input: DiscoveryInput, loadStartup: (ctx: SystemContext) => Promise<StartupInfo | null> = loadStartupInfo, socket?: string): Promise<DiscoveryResult> {
  const { ctx, prev } = input;
  let startup: StartupInfo | null = null;
  try {
    startup = await loadStartup(ctx);
  } catch (err) {
    ctx.warn(`tmux: startup config: ${err instanceof Error ? err.message : String(err)}`);
  }
  const target = tmuxTarget(ctx, startup);
  if (socket !== undefined) target.args = ["-S", socket];
  const r = await ctx.exec("tmux", [...target.args, "list-panes", "-s", "-t", target.session, "-F", "#{window_name}|#{pane_pid}|#{pane_dead}|#{pane_current_command}"], { timeoutMs: 3000 });
  // A -S socket that is not there means no tmux server is running (services moved to Tango Server, or it died):
  // that is a reading with no windows, not an unanswered tmux.
  const socketPath = target.args[0] === "-S" ? target.args[1] : undefined;
  const noServer = r.code !== 0 && /No such file or directory/.test(r.stderr) && !!socketPath && !fs.existsSync(socketPath);
  const reachable = r.code === 0 || noServer;
  const panes = r.code === 0 ? parsePanes(r.stdout) : [];
  const now = ctx.now();
  const nowIso = now.toISOString();
  const effects: DiscoveryEffect[] = [];
  const services = startup?.services ?? [];
  const known = new Set<string>();
  const jobs: JobUpsert[] = [];

  const build = (id: string, window: string, svc: StartupService | null): JobUpsert => {
    known.add(window);
    const jobId = `tmux:${id}`;
    const before = prev(jobId);
    const pane = panes.find((p) => p.window === window);
    const alive = Boolean(pane && !pane.dead);
    const child = pane ? childOf(pane.panePid, input.processes) : null;
    // No process list this tick (ps timed out under load) means no reading, not a restart: an empty child
    // would differ from the last marker and count as one.
    const marker = pane && input.processes?.length ? `${pane.panePid}/${child ?? ""}` : null;
    const history = (Array.isArray(before?.facts.pidHistory) ? (before!.facts.pidHistory as Array<{ marker: string; at: string }>) : []).filter(
      (h) => now.getTime() - Date.parse(h.at) <= RESTART_WINDOW_MS,
    );
    if (marker && history.at(-1)?.marker !== marker) history.push({ marker, at: nowIso });
    const changes = Math.max(0, history.length - 1);
    const enabled = svc ? svc.enabled !== false : true;
    const name = svc?.name ?? id;
    if (reachable && enabled && svc) {
      if (changes >= RESTART_CHANGES && before?.facts.restarting !== true) {
        effects.push({ type: "event", event: { source: "tick", kind: "job.restarting", severity: "warning", title: `${name} keeps restarting`, jobId, detail: `${changes} restarts in 10 min`, at: nowIso } });
      } else if (changes === 0 && before?.facts.restarting === true) {
        effects.push({ type: "event", event: { source: "tick", kind: "job.stable", severity: "recovery", title: `${name} is stable`, jobId, at: nowIso } });
      }
      if (!alive && !svc.optional && before?.facts.alive !== false) {
        effects.push({ type: "event", event: { source: "tick", kind: "service.down", severity: "error", title: `${name} window is not running`, jobId, detail: `tmux ${target.session}:${window}`, at: nowIso } });
      } else if (alive && before?.facts.alive === false) {
        effects.push({ type: "event", event: { source: "tick", kind: "service.up", severity: "recovery", title: `${name} window is back`, jobId, at: nowIso } });
      }
    }
    return {
      id: jobId,
      runner: "tmux",
      name,
      cadence: "Always on",
      cadenceSeconds: null,
      source: startup ? (fs.existsSync(startup.profileConfigPath) ? startup.profileConfigPath : startup.defaultConfigPath) : null,
      probe: { tmux: `${target.session}:${window}` },
      state: enabled ? "active" : "paused",
      lastStatus: !reachable ? undefined : alive ? "running" : enabled ? "failed" : null,
      facts: {
        window,
        session: target.session,
        socket: target.args.join(" "),
        panePid: pane?.panePid ?? null,
        pid: child ?? pane?.panePid ?? null,
        command: pane?.command ?? null,
        alive: reachable ? alive : (before?.facts.alive ?? null),
        enabled,
        optional: svc?.optional === true,
        configured: Boolean(svc),
        pidHistory: history,
        // An unanswered tmux is no reading: keep the last verdict so its recovery still fires later.
        restarting: reachable ? changes >= RESTART_CHANGES : before?.facts.restarting === true,
      },
    };
  };

  for (const svc of services) {
    if (!svc || typeof svc.id !== "string") continue;
    jobs.push(build(svc.id, svc.tmux?.window ?? svc.id, svc));
  }
  // Windows in the session that no startup service defines (started by hand or by a profile hook).
  for (const pane of panes) {
    if (known.has(pane.window)) continue;
    jobs.push(build(pane.window, pane.window, null));
  }
  return { runner: "tmux", jobs, effects, complete: reachable, note: reachable ? undefined : (r.error ?? r.stderr.trim()) || "tmux not reachable" };
}

