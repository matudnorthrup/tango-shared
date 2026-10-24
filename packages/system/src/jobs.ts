import { nowIso, parseJson } from "./ledger.js";
import { RUNNERS, type Criticality, type JobRow, type Ledger, type Runner, type RunRow } from "./types.js";

type Raw = Record<string, unknown>;

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function mapJob(r: Raw): JobRow {
  return {
    id: String(r.id),
    runner: String(r.runner) as Runner,
    name: String(r.name),
    owner: str(r.owner),
    group: str(r.grp),
    cadence: str(r.cadence),
    cadenceSeconds: num(r.cadence_seconds),
    criticality: (String(r.criticality ?? "normal") as Criticality),
    source: str(r.source),
    logs: parseJson<string[]>(r.logs, []),
    probe: parseJson<Record<string, unknown> | null>(r.probe, null),
    state: String(r.state ?? "active") as JobRow["state"],
    retiredAt: str(r.retired_at),
    retireReason: str(r.retire_reason),
    archivePath: str(r.archive_path),
    managed: Number(r.managed ?? 1) === 1,
    lastRunAt: str(r.last_run_at),
    lastStatus: str(r.last_status),
    lastExit: num(r.last_exit),
    nextRunAt: str(r.next_run_at),
    lastUsedAt: str(r.last_used_at),
    retireCandidate: str(r.retire_candidate),
    facts: parseJson<Record<string, unknown>>(r.facts, {}),
    seenAt: String(r.seen_at),
  };
}

export function mapRun(r: Raw): RunRow {
  return {
    id: Number(r.id),
    jobId: String(r.job_id),
    startedAt: String(r.started_at),
    finishedAt: str(r.finished_at),
    status: String(r.status) as RunRow["status"],
    exitCode: num(r.exit_code),
    durationMs: num(r.duration_ms),
    summary: str(r.summary),
    outputTail: str(r.output_tail),
    sourceRef: str(r.source_ref),
  };
}

export function listJobs(l: Ledger, f: { includeRetired?: boolean; managed?: boolean } = {}): JobRow[] {
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (!f.includeRetired) where.push("state != 'retired'");
  if (f.managed !== undefined) {
    where.push("managed = ?");
    args.push(f.managed ? 1 : 0);
  }
  const sql = `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY runner, grp, name`;
  return (l.db.prepare(sql).all(...args) as Raw[]).map(mapJob);
}

export function getJob(l: Ledger, id: string): JobRow | null {
  const row = l.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Raw | undefined;
  return row ? mapJob(row) : null;
}

export function listRuns(l: Ledger, jobId: string, limit = 20): RunRow[] {
  return (l.db.prepare("SELECT * FROM runs WHERE job_id = ? ORDER BY started_at DESC, id DESC LIMIT ?").all(jobId, limit) as Raw[]).map(mapRun);
}

/** What discovery knows about a job. Fields left undefined keep their stored value. */
export interface JobUpsert {
  id: string;
  runner: Runner;
  name: string;
  owner?: string | null;
  group?: string | null;
  cadence?: string | null;
  cadenceSeconds?: number | null;
  criticality?: Criticality;
  source?: string | null;
  logs?: string[];
  probe?: Record<string, unknown> | null;
  /** Discovery's view: active or paused. A retired job stays retired. */
  state?: "active" | "paused";
  managed?: boolean;
  lastRunAt?: string | null;
  lastStatus?: string | null;
  lastExit?: number | null;
  nextRunAt?: string | null;
  lastUsedAt?: string | null;
  retireCandidate?: string | null;
  /** Merged into the stored facts. */
  facts?: Record<string, unknown>;
  seenAt?: string;
}

const COLUMN: Record<string, string> = {
  owner: "owner",
  group: "grp",
  cadence: "cadence",
  cadenceSeconds: "cadence_seconds",
  criticality: "criticality",
  source: "source",
  lastRunAt: "last_run_at",
  lastStatus: "last_status",
  lastExit: "last_exit",
  nextRunAt: "next_run_at",
  lastUsedAt: "last_used_at",
  retireCandidate: "retire_candidate",
};

export function upsertJob(l: Ledger, j: JobUpsert): void {
  const seen = j.seenAt ?? nowIso();
  const existing = getJob(l, j.id);
  if (!existing) {
    l.db
      .prepare(
        `INSERT INTO jobs(id, runner, name, owner, grp, cadence, cadence_seconds, criticality, source, logs, probe, state, managed,
          last_run_at, last_status, last_exit, next_run_at, last_used_at, retire_candidate, facts, seen_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        j.id,
        j.runner,
        j.name,
        j.owner ?? null,
        j.group ?? null,
        j.cadence ?? null,
        j.cadenceSeconds ?? null,
        j.criticality ?? "normal",
        j.source ?? null,
        JSON.stringify(j.logs ?? []),
        j.probe ? JSON.stringify(j.probe) : null,
        j.state ?? "active",
        j.managed === false ? 0 : 1,
        j.lastRunAt ?? null,
        j.lastStatus ?? null,
        j.lastExit ?? null,
        j.nextRunAt ?? null,
        j.lastUsedAt ?? null,
        j.retireCandidate ?? null,
        JSON.stringify({ firstSeenAt: seen, ...(j.facts ?? {}) }),
        seen,
      );
    return;
  }
  const sets: string[] = ["runner = ?", "name = ?", "seen_at = ?"];
  const args: Array<string | number | null> = [j.runner, j.name, seen];
  for (const [key, col] of Object.entries(COLUMN)) {
    const v = (j as unknown as Record<string, unknown>)[key];
    if (v !== undefined) {
      sets.push(`${col} = ?`);
      args.push(v as string | number | null);
    }
  }
  if (j.logs !== undefined) {
    sets.push("logs = ?");
    args.push(JSON.stringify(j.logs));
  }
  if (j.probe !== undefined) {
    sets.push("probe = ?");
    args.push(j.probe ? JSON.stringify(j.probe) : null);
  }
  if (j.managed !== undefined) {
    sets.push("managed = ?");
    args.push(j.managed ? 1 : 0);
  }
  if (j.state !== undefined && existing.state !== "retired") {
    sets.push("state = ?");
    args.push(j.state);
  }
  if (j.facts) {
    sets.push("facts = ?");
    args.push(JSON.stringify({ ...existing.facts, ...j.facts }));
  }
  args.push(j.id);
  l.db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...args);
}

export function setJobState(
  l: Ledger,
  id: string,
  state: JobRow["state"],
  extra: { retireReason?: string | null; archivePath?: string | null; facts?: Record<string, unknown> } = {},
): JobRow | null {
  const job = getJob(l, id);
  if (!job) return null;
  const facts = extra.facts ? JSON.stringify({ ...job.facts, ...extra.facts }) : JSON.stringify(job.facts);
  if (state === "retired") {
    l.db
      .prepare("UPDATE jobs SET state = 'retired', retired_at = ?, retire_reason = ?, archive_path = ?, facts = ? WHERE id = ?")
      .run(nowIso(), extra.retireReason ?? null, extra.archivePath ?? null, facts, id);
  } else {
    const clearRetire = job.state === "retired";
    l.db
      .prepare(
        `UPDATE jobs SET state = ?, facts = ?${clearRetire ? ", retired_at = NULL, retire_reason = NULL, archive_path = NULL" : ""} WHERE id = ?`,
      )
      .run(state, facts, id);
  }
  return getJob(l, id);
}

/** Splits "<runner>:<runner id>"; unknown runners return null. */
export function splitJobId(id: string): { runner: Runner; runnerId: string } | null {
  const i = id.indexOf(":");
  if (i <= 0) return null;
  const runner = id.slice(0, i) as Runner;
  if (!RUNNERS.includes(runner)) return null;
  return { runner, runnerId: id.slice(i + 1) };
}

/** A job that writes before discovery has seen it (tango-run on a new label) gets a minimal row. */
export function ensureJob(l: Ledger, id: string): JobRow | null {
  const existing = getJob(l, id);
  if (existing) return existing;
  const parts = splitJobId(id);
  if (!parts) return null;
  upsertJob(l, { id, runner: parts.runner, name: parts.runnerId });
  return getJob(l, id);
}
