import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { freemem, totalmem } from "node:os";
import { statfs } from "node:fs/promises";
import { join } from "node:path";
import { isLiveHost, readHostLedgers } from "./host-ledger.js";

const exec = promisify(execFile);
const GB = 1024 ** 3;
export interface Pressure { memory: { totalBytes: number; freePct: number }; disk: { totalBytes: number; freeBytes: number } }
export interface WarmthLimits { maxWarmHosts: number; minFreeMemoryPct: number; minFreeDiskGB: number; warmFloorMs: number }
const envNumber = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};
export function warmthLimits(): WarmthLimits {
  return { maxWarmHosts: envNumber("LOOM_MAX_WARM_HOSTS", 12), minFreeMemoryPct: envNumber("LOOM_MIN_FREE_MEMORY_PCT", 15), minFreeDiskGB: envNumber("LOOM_MIN_FREE_DISK_GB", 20), warmFloorMs: envNumber("LOOM_WARM_FLOOR_MS", 600_000) };
}
/** Hosts and memory: what cooling an idle host actually frees. Disk is not, so it never drives cooling. */
export function overBudget(p: Pressure, hosts: number, limits: WarmthLimits): boolean {
  return hosts > limits.maxWarmHosts || p.memory.freePct < limits.minFreeMemoryPct;
}
/** No new host at all on a nearly full disk (the owner's own thread included): it would fail anyway. */
export function ownerFits(p: Pressure): boolean { return p.disk.freeBytes >= 5 * GB; }
/** New work other than the owner's waits while the disk is below its floor. */
export function diskFits(p: Pressure, limits: WarmthLimits): boolean { return p.disk.freeBytes >= limits.minFreeDiskGB * GB; }

/** macOS reports system-wide available memory; vm_stat is the fallback on older systems. */
export async function readPressure(home: string): Promise<Pressure> {
  const totalBytes = totalmem();
  let freePct = freemem() / totalBytes * 100;
  try {
    const { stdout } = await exec("memory_pressure", ["-Q"], { timeout: 5000 });
    const match = stdout.match(/free percentage:\s*([\d.]+)%/i);
    if (!match) throw new Error("Missing memory pressure percentage");
    freePct = Number(match[1]);
  } catch {
    try {
      const { stdout } = await exec("vm_stat", [], { timeout: 5000 });
      const pageSize = Number(stdout.match(/page size of (\d+) bytes/)?.[1] ?? 4096);
      const pages = ["free", "inactive", "speculative"].reduce((n, kind) => n + Number(stdout.match(new RegExp(`Pages ${kind}:\\s*(\\d+)`))?.[1] ?? 0), 0);
      if (pages) freePct = pages * pageSize / totalBytes * 100;
    } catch { /* Portable OS free-memory reading remains available. */ }
  }
  const disk = await statfs(home);
  return { memory: { totalBytes, freePct }, disk: { totalBytes: disk.blocks * disk.bsize, freeBytes: disk.bavail * disk.bsize } };
}

export async function hostMemory(home: string): Promise<{ threadId: string; pid: number; rssBytes: number; processes: number }[]> {
  const hosts = readHostLedgers(join(home, "hosts")).filter(isLiveHost);
  const agents: { threadId: string; pid: number; rssBytes: number; processes: number }[] = [];
  for (const host of hosts) {
    const pids = [...new Set([host.pid, ...host.groups.map(g => g.pid)])];
    try {
      const { stdout } = await exec("ps", ["-o", "rss=", "-p", pids.join(",")], { timeout: 5000 });
      const rows = stdout.trim().split(/\s+/).filter(Boolean);
      agents.push({ threadId: host.threadId, pid: host.pid, processes: rows.length, rssBytes: rows.reduce((n, value) => n + Number(value) * 1024, 0) });
    } catch { /* A host can exit between the ledger read and ps. */ }
  }
  return agents;
}
