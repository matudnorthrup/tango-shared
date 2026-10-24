import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { killGroup, processStart, type SpawnLedger } from "./proc.js";

export interface HostLedger {
  threadId: string;
  pid: number;
  started: string;
  release: string;
  protocol: number;
  groups: { pid: number; threadId: string | null; command: string; started: string }[];
}

export function isLiveHost(host: HostLedger): boolean {
  return host.pid > 1 && !!host.started && processStart(host.pid) === host.started;
}

export function readHostLedgers(hostsDir: string): HostLedger[] {
  let names: string[];
  try { names = readdirSync(hostsDir); } catch { return []; }
  const hosts: HostLedger[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".pending.json")) continue;
    try {
      const host = JSON.parse(readFileSync(join(hostsDir, name), "utf8")) as HostLedger;
      if (typeof host.threadId === "string" && Number.isInteger(host.pid) && typeof host.started === "string" && Array.isArray(host.groups)) hosts.push(host);
    } catch { /* An incomplete or unrelated ledger cannot prove process ownership. */ }
  }
  return hosts;
}

/** A host owns this file exclusively; the coordinator only reads it. */
export class FileSpawnLedger implements SpawnLedger {
  private readonly path: string;
  private readonly host: HostLedger;

  constructor(hostsDir: string, threadId: string, release: string, protocol: number) {
    mkdirSync(hostsDir, { recursive: true });
    this.path = join(hostsDir, `${threadId}.json`);
    this.host = { threadId, pid: process.pid, started: processStart(process.pid) ?? "", release, protocol, groups: [] };
    this.save();
  }

  recordSpawn(pid: number, threadId: string | null, command: string, started: string): void {
    this.host.groups = this.host.groups.filter((group) => group.pid !== pid);
    this.host.groups.push({ pid, threadId, command, started });
    this.save();
  }

  forgetSpawn(pid: number): void {
    this.host.groups = this.host.groups.filter((group) => group.pid !== pid);
    this.save();
  }

  remove(): void {
    try { unlinkSync(this.path); } catch { /* Already removed. */ }
  }

  killGroups(): void {
    for (const group of this.host.groups) {
      if (group.started && processStart(group.pid) === group.started) killGroup(group.pid);
    }
  }

  private save(): void {
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.host), { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
