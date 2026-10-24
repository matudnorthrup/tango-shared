import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { LoomStore } from "./store.js";
import { isLiveHost, readHostLedgers } from "./host-ledger.js";

export interface SpawnLedger {
  recordSpawn(pid: number, threadId: string | null, command: string, started: string): void;
  forgetSpawn(pid: number): void;
}

/** The start time `ps` reports for a pid, used to tell a live process from a reused pid. */
export function processStart(pid: number): string | null {
  try {
    const out = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Kill a whole process group. Refuses pid <= 1 so it can never signal Loom's own group or every process. */
export function killGroup(pid: number, signal: NodeJS.Signals = "SIGKILL"): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn a harness process as a process-group leader and record it in the
 * orphan ledger. When it exits, the rest of its group (MCP servers, shells)
 * is killed too, and the ledger entry is removed.
 */
export function spawnGroup(
  store: SpawnLedger,
  threadId: string | null,
  command: string,
  args: string[],
  options: SpawnOptions = {},
): ChildProcess {
  const child = spawn(command, args, { ...options, detached: true });
  const pid = child.pid;
  if (pid) {
    store.recordSpawn(pid, threadId, [command, ...args].join(" ").slice(0, 500), processStart(pid) ?? "");
    child.once("exit", () => {
      killGroup(pid);
      store.forgetSpawn(pid);
    });
  }
  return child;
}

/**
 * Kill process groups left behind by a Loom that crashed. A ledger entry is
 * only acted on if the pid still has the start time it was recorded with.
 */
export function reapOrphans(store: LoomStore, hostsDir?: string): number {
  let reaped = 0;
  const handled = new Set<number>();
  const hosts = hostsDir ? readHostLedgers(hostsDir) : [];
  const protectedGroups = new Set(hosts.filter(isLiveHost).flatMap((host) => host.groups.map((group) => group.pid)));
  for (const entry of store.spawns()) {
    if (protectedGroups.has(entry.pid)) continue;
    handled.add(entry.pid);
    const started = processStart(entry.pid);
    if (started && entry.started && started === entry.started && killGroup(entry.pid)) reaped++;
    store.forgetSpawn(entry.pid);
  }
  for (const host of hosts) {
    if (isLiveHost(host)) continue;
    for (const entry of host.groups) {
      if (handled.has(entry.pid)) continue;
      handled.add(entry.pid);
      const started = processStart(entry.pid);
      if (started && entry.started && started === entry.started && killGroup(entry.pid)) reaped++;
    }
  }
  return reaped;
}
