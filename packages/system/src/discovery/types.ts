import type { SystemContext } from "../context.js";
import type { JobUpsert } from "../jobs.js";
import type { JobRow, RecordEventInput, Runner, RunRow } from "../types.js";

export type DiscoveryEffect =
  | {
      type: "run";
      run: {
        jobId: string;
        startedAt: string;
        finishedAt?: string | null;
        status: RunRow["status"];
        exitCode?: number | null;
        summary?: string | null;
        sourceRef?: string | null;
      };
    }
  | { type: "event"; event: RecordEventInput };

export interface DiscoveryResult {
  runner: Runner;
  jobs: JobUpsert[];
  effects: DiscoveryEffect[];
  /** True when the runner answered: rows of ephemeral runners not seen this time can go. */
  complete: boolean;
  note?: string;
}

export interface DiscoveryInput {
  ctx: SystemContext;
  prev: (id: string) => JobRow | null;
  /** ps snapshot, shared with the unmanaged scan (pid → ppid, command). */
  processes?: ProcessInfo[];
  /** Parsed plists kept between ticks, keyed by path and checked by mtime (plutil per plist per tick is slow under load). */
  plistCache?: Map<string, { mtimeMs: number; doc: Record<string, unknown> }>;
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  uid: number;
  started: string;
  cpu: number;
  command: string;
}

export type Discoverer = (input: DiscoveryInput) => Promise<DiscoveryResult>;
