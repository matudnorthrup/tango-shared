import os from "node:os";
import path from "node:path";
import type { Annotations } from "./annotations.js";
import { realExec, realFetch, type Exec, type Fetch } from "./exec.js";
import { profileDataDir, profileDir, readEnvFileValue, repoRoot, resolveTangoDbPath } from "./paths.js";

/** Everything a tick step touches outside the ledger, injectable for tests. */
export interface SystemContext {
  exec: Exec;
  fetch: Fetch;
  annotations: Annotations;
  now: () => Date;
  warn: (message: string) => void;
  uid: number;
  homeDir: string;
  repoDir: string;
  profileDir: string;
  dataDir: string;
  tangoDbPath: string;
  /** Loom's database, read-only (recovery holds). */
  loomDbPath: string;
  /** The backup supervisor's health file (Loom's `LOOM_RECOVERY_HEALTH_FILE`); null when recovery admission is off. */
  recoveryHealthFile: string | null;
  /** Claude routines (scheduled-task folders). */
  routinesDir: string;
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep: (ms: number) => Promise<void>;
}

export function defaultContext(annotations: Annotations, overrides: Partial<SystemContext> = {}): SystemContext {
  const homeDir = overrides.homeDir ?? os.homedir();
  return {
    exec: realExec,
    fetch: realFetch,
    annotations,
    now: () => new Date(),
    warn: (m) => process.stderr.write(`[system] ${m}\n`),
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    homeDir,
    repoDir: repoRoot(),
    profileDir: profileDir(),
    dataDir: profileDataDir(),
    tangoDbPath: resolveTangoDbPath(),
    loomDbPath: path.join(process.env.LOOM_HOME?.trim() || path.join(homeDir, ".tango", "loom"), "loom.sqlite"),
    recoveryHealthFile: readEnvFileValue("LOOM_RECOVERY_HEALTH_FILE") ?? null,
    routinesDir: `${homeDir}/.claude/scheduled-tasks`,
    kill: (pid, signal) => process.kill(pid, signal),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    ...overrides,
  };
}

export function humanSeconds(seconds: number): string {
  if (seconds % 86400 === 0 && seconds >= 86400) return seconds === 86400 ? "Daily" : `Every ${seconds / 86400} days`;
  if (seconds % 3600 === 0 && seconds >= 3600) return seconds === 3600 ? "Hourly" : `Every ${seconds / 3600} h`;
  if (seconds % 60 === 0 && seconds >= 60) return `Every ${seconds / 60} min`;
  return `Every ${seconds} s`;
}

/** Runs async work over items with a concurrency limit. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
      timer.unref?.();
    }),
  ]);
}

/** "2026-10-18 15:08:48" (SQLite datetime('now')) → ISO with Z; ISO passes through. */
export function toIso(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") return new Date(value).toISOString();
  const s = String(value);
  const fixed = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? `${s.replace(" ", "T")}Z` : s;
  const t = Date.parse(fixed);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
