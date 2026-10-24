import type { DatabaseSync } from "node:sqlite";

export type Runner = "schedule" | "launchd" | "tmux" | "docker" | "routine" | "background" | "loom-wait" | "server";
export type Criticality = "critical" | "normal" | "quiet";
export type Severity = "critical" | "error" | "warning" | "info" | "recovery";
export type IncidentStatus = "open" | "acked" | "muted" | "snoozed" | "resolved";
export type NotifyTransition = "opened" | "escalated" | "regressed" | "reminder" | "resolved";

export const RUNNERS: readonly Runner[] = ["schedule", "launchd", "tmux", "docker", "routine", "background", "loom-wait", "server"];

export interface JobRow {
  id: string;
  runner: Runner;
  name: string;
  owner: string | null;
  group: string | null;
  cadence: string | null;
  cadenceSeconds: number | null;
  criticality: Criticality;
  source: string | null;
  logs: string[];
  probe: Record<string, unknown> | null;
  state: "active" | "paused" | "retired";
  retiredAt: string | null;
  retireReason: string | null;
  archivePath: string | null;
  managed: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastExit: number | null;
  nextRunAt: string | null;
  lastUsedAt: string | null;
  retireCandidate: string | null;
  facts: Record<string, unknown>;
  seenAt: string;
}

export interface RunRow {
  id: number;
  jobId: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "ok" | "quiet" | "failed";
  exitCode: number | null;
  durationMs: number | null;
  summary: string | null;
  outputTail: string | null;
  sourceRef: string | null;
}

export interface EventRow {
  id: number;
  at: string;
  source: string;
  jobId: string | null;
  kind: string;
  severity: Severity;
  title: string;
  detail: string | null;
  data: Record<string, unknown> | null;
  fingerprint: string;
  incidentId: number | null;
}

export interface IncidentRow {
  id: number;
  fingerprint: string;
  jobId: string | null;
  title: string;
  severity: Severity;
  status: IncidentStatus;
  firstSeen: string;
  lastSeen: string;
  count: number;
  resolvedAt: string | null;
  snoozedUntil: string | null;
  regressed: boolean;
  flapping: boolean;
  reopenCount: number;
  notifiedAt: string | null;
}

export interface HealthSnapshot {
  checkedAt: string;
  services: Array<{ id: string; name: string; ok: boolean; detail: string; since: string | null }>;
  machine: {
    load1: number;
    load5: number;
    cores: number;
    memUsedGb: number;
    memTotalGb: number;
    diskUsedPct: number;
    diskFreeGb: number;
  };
  /** The recovery mini (Loom's backup destination), when the backup's health file is configured and fresh. */
  recovery?: { host: string | null; freeGb: number | null; trendGbPerDay: number | null; daysToPause: number | null; held: number | null; at: string };
}

export interface Ledger {
  db: DatabaseSync;
  path: string;
  close(): void;
}

export interface RecordEventInput {
  source: string;
  kind: string;
  severity: Severity;
  title: string;
  /** Stable entity identity when title normalization would merge distinct incidents. */
  identity?: string;
  jobId?: string;
  detail?: string;
  data?: Record<string, unknown>;
  at?: string;
  /** A recovery that resolves only the incident with this kind and title, not the job's whole kind family. */
  resolves?: { kind: string; title: string; identity?: string };
}
