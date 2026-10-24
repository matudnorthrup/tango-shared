import fs from "node:fs";
import path from "node:path";
import type { ProcessInfo } from "./discovery/types.js";
import type { JobUpsert } from "./jobs.js";

/** `ps -axo pid,ppid,uid,lstart,pcpu,command` (lstart is five words: "Sat Oct 17 05:15:25 2026"). */
export const PS_ARGS = ["-axo", "pid,ppid,uid,lstart,pcpu,command"];

export function parsePs(text: string): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+([\d.]+)\s+(.*)$/);
    if (!m) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), started: m[4]!.replace(/\s+/g, " "), cpu: Number(m[5]), command: m[6]!.trim() });
  }
  return out;
}

export interface ListenSocket {
  pid: number;
  process: string;
  port: number;
  address: string;
}

/**
 * `netstat -anv -p tcp` LISTEN rows. The process column ("name:pid") sits
 * after the ten fixed columns and before eight trailing ones; a name may
 * contain spaces.
 */
export function parseNetstatListen(text: string): ListenSocket[] {
  const out: ListenSocket[] = [];
  for (const line of text.split("\n")) {
    if (!/\bLISTEN\b/.test(line)) continue;
    const t = line.trim().split(/\s+/);
    if (t.length < 19 || !t[0]!.startsWith("tcp")) continue;
    const local = t[3]!;
    const port = Number(local.slice(local.lastIndexOf(".") + 1));
    const proc = t.slice(10, t.length - 8).join(" ");
    const pm = proc.match(/^(.*):(\d+)$/);
    if (!pm || !Number.isFinite(port)) continue;
    out.push({ pid: Number(pm[2]), process: pm[1]!, port, address: local.slice(0, local.lastIndexOf(".")) });
  }
  return out;
}

/** Absolute paths in a command line that no longer exist (a server started from a deleted worktree). */
export function missingPaths(command: string, exists: (p: string) => boolean = fs.existsSync): string[] {
  const out: string[] = [];
  for (const tok of command.split(/\s+/)) {
    if (!tok.startsWith("/") || tok.length < 4) continue;
    const clean = tok.replace(/["',;]+$/, "");
    if (!exists(clean)) out.push(clean);
  }
  return out;
}

export function shortName(command: string): string {
  const parts = command.split(/\s+/).filter(Boolean);
  const exe = path.basename(parts[0] ?? "process");
  const script = parts.slice(1).find((p) => !p.startsWith("-"));
  return script ? `${exe} ${path.basename(script)}` : exe;
}

export interface UnmanagedScanInput {
  processes: ProcessInfo[];
  listens: ListenSocket[];
  /** pids launchd manages (any label) and pids already owned by a job. */
  knownPids: Set<number>;
  uid: number;
  ignorePrefixes: string[];
  exists?: (p: string) => boolean;
}

/**
 * Listening processes of this user re-parented to launchd (ppid 1) that no job
 * or launchd label owns: what is left behind when a tmux shell or a worktree
 * dies. Each becomes an unmanaged job row.
 */
export function scanUnmanaged(input: UnmanagedScanInput): JobUpsert[] {
  const byPid = new Map(input.processes.map((p) => [p.pid, p]));
  const ports = new Map<number, number[]>();
  for (const l of input.listens) {
    const list = ports.get(l.pid) ?? [];
    if (!list.includes(l.port)) list.push(l.port);
    ports.set(l.pid, list);
  }
  const out: JobUpsert[] = [];
  for (const [pid, portList] of ports) {
    const p = byPid.get(pid);
    if (!p || p.ppid !== 1 || p.uid !== input.uid) continue;
    if (input.knownPids.has(pid)) continue;
    if (input.ignorePrefixes.some((pre) => p.command.startsWith(pre))) continue;
    const missing = missingPaths(p.command, input.exists);
    portList.sort((a, b) => a - b);
    out.push({
      id: `launchd:unmanaged-${pid}`,
      runner: "launchd",
      name: `${shortName(p.command)} (:${portList.join(", :")})`,
      managed: false,
      cadence: "Always on",
      cadenceSeconds: null,
      criticality: "quiet",
      lastStatus: "running",
      facts: { pid, ppid: p.ppid, startedAt: p.started, cpu: p.cpu, command: p.command, ports: portList, cwdDeleted: missing.length > 0, missingPaths: missing },
    });
  }
  return out;
}
