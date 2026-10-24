import { incidentRoute, listIncidents } from "./incidents.js";
import { listJobs } from "./jobs.js";
import { getJsonCursor } from "./ledger.js";
import type { HealthSnapshot, Ledger } from "./types.js";

export const HEALTH_CURSOR = "health";

export function readHealth(l: Ledger): HealthSnapshot | null {
  return getJsonCursor<HealthSnapshot>(l, HEALTH_CURSOR);
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The System page header sentence, e.g. "2 critical problems need you, and 9 more are open. The other 81 jobs ran as expected." */
export function summaryLine(critical: number, open: number, okJobs: number): string {
  if (critical === 0 && open === 0) return "All clear.";
  const parts: string[] = [];
  if (critical > 0) {
    const head = `${critical} critical ${plural(critical, "problem needs", "problems need")} you`;
    parts.push(open > 0 ? `${head}, and ${open} more ${plural(open, "is", "are")} open.` : `${head}.`);
  } else {
    parts.push(`${open} ${plural(open, "problem is", "problems are")} open.`);
  }
  if (okJobs > 0) parts.push(`The other ${okJobs} ${plural(okJobs, "job", "jobs")} ran as expected.`);
  return parts.join(" ");
}

export function systemSummary(l: Ledger): {
  critical: number;
  open: number;
  jobs: number;
  failing: number;
  late: number;
  unmanaged: number;
  retireCandidates: number;
  line: string;
} {
  const incidents = listIncidents(l, { status: "active" });
  let critical = 0;
  let open = 0;
  const jobsWithProblems = new Set<string>();
  for (const inc of incidents) {
    const route = incidentRoute(l, inc);
    // Quiet incidents (quiet jobs, info such as unmanaged processes) live on the System page only.
    if (route === "quiet") continue;
    if (inc.jobId) jobsWithProblems.add(inc.jobId);
    if (inc.status === "open" && route === "critical") critical += 1;
    else open += 1;
  }
  const all = listJobs(l, { includeRetired: false });
  const managed = all.filter((j) => j.managed);
  const failing = managed.filter((j) => j.state === "active" && j.lastStatus === "failed").length;
  const lateIds = new Set(
    (l.db.prepare("SELECT DISTINCT e.job_id FROM events e JOIN incidents i ON i.id = e.incident_id WHERE i.status != 'resolved' AND e.kind = 'job.late'").all() as Array<{ job_id: string | null }>)
      .map((r) => r.job_id)
      .filter(Boolean) as string[],
  );
  const late = managed.filter((j) => lateIds.has(j.id)).length;
  const unmanaged = all.length - managed.length;
  const retireCandidates = managed.filter((j) => j.retireCandidate).length;
  const okJobs = managed.filter((j) => !jobsWithProblems.has(j.id) && j.lastStatus !== "failed").length;
  return { critical, open, jobs: managed.length, failing, late, unmanaged, retireCandidates, line: summaryLine(critical, open, okJobs) };
}
