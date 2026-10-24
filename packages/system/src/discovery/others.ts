import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { toIso } from "../context.js";
import type { JobUpsert } from "../jobs.js";
import type { DiscoveryEffect, DiscoveryInput, DiscoveryResult } from "./types.js";

// ---------------------------------------------------------------- docker

export interface DockerRow {
  Names?: string;
  State?: string;
  Status?: string;
  Image?: string;
  ID?: string;
  CreatedAt?: string;
}

export function parseDockerPs(text: string): DockerRow[] {
  const out: DockerRow[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as DockerRow);
    } catch {
      // skip a malformed line
    }
  }
  return out;
}

export async function discoverDocker(input: DiscoveryInput): Promise<DiscoveryResult> {
  const { ctx, prev } = input;
  const r = await ctx.exec("docker", ["ps", "-a", "--format", "{{json .}}"], { timeoutMs: 5000 });
  if (r.code !== 0) {
    // Docker missing or its daemon down: nothing to discover (the docker service probe reports the daemon).
    return { runner: "docker", jobs: [], effects: [], complete: false, note: r.error ?? (r.stderr.trim() || "docker unavailable") };
  }
  const nowIso = ctx.now().toISOString();
  const effects: DiscoveryEffect[] = [];
  const jobs = parseDockerPs(r.stdout).map((c): JobUpsert => {
    const name = (c.Names ?? c.ID ?? "container").split(",")[0]!;
    const id = `docker:${name}`;
    const before = prev(id);
    const running = c.State === "running";
    const exitMatch = c.Status?.match(/Exited \((-?\d+)\)/);
    const exit = exitMatch ? Number(exitMatch[1]) : null;
    const pausedByUs = before?.state === "paused";
    if (!pausedByUs && before && before.facts.running === true && !running) {
      effects.push({ type: "event", event: { source: "tick", kind: "service.down", severity: "error", title: `${name} container stopped`, jobId: id, detail: c.Status, at: nowIso } });
    } else if (running && before?.facts.running === false) {
      effects.push({ type: "event", event: { source: "tick", kind: "service.up", severity: "recovery", title: `${name} container is running`, jobId: id, at: nowIso } });
    }
    return {
      id,
      runner: "docker",
      name,
      cadence: "Always on",
      cadenceSeconds: null,
      probe: { docker: name },
      lastStatus: running ? "running" : exit !== null && exit !== 0 ? "failed" : "stopped",
      lastExit: exit,
      facts: { running, dockerState: c.State ?? null, status: c.Status ?? null, image: c.Image ?? null, containerId: c.ID ?? null },
    };
  });
  return { runner: "docker", jobs, effects, complete: true };
}

// ---------------------------------------------------------------- Claude routines

export function parseFrontmatter(text: string): Record<string, unknown> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  try {
    const doc = yaml.load(m[1]!);
    return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Claude routines: one folder with a SKILL.md per scheduled task (best effort; the schedule itself lives in the app). */
export async function discoverRoutines(input: DiscoveryInput): Promise<DiscoveryResult> {
  const dir = input.ctx.routinesDir;
  if (!fs.existsSync(dir)) return { runner: "routine", jobs: [], effects: [], complete: true };
  const jobs: JobUpsert[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skill = path.join(dir, entry.name, "SKILL.md");
    if (!fs.existsSync(skill)) continue;
    const fm = parseFrontmatter(fs.readFileSync(skill, "utf8"));
    const stat = fs.statSync(skill);
    jobs.push({
      id: `routine:${entry.name}`,
      runner: "routine",
      name: typeof fm.name === "string" ? fm.name : entry.name,
      source: skill,
      facts: { description: typeof fm.description === "string" ? fm.description : null, folder: path.join(dir, entry.name), modifiedAt: stat.mtime.toISOString() },
    });
  }
  return { runner: "routine", jobs, effects: [], complete: true };
}

// ---------------------------------------------------------------- background jobs

interface BackgroundJobFile {
  id?: string;
  agentId?: string;
  label?: string;
  status?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  cancelled?: boolean;
  timeoutSeconds?: number;
}

const BACKGROUND_KEEP_MS = 14 * 86_400_000;

/** `<profile>/data/background-jobs/<id>/job.json`: one-off jobs the bot started; each finished one is a run. */
export async function discoverBackground(input: DiscoveryInput): Promise<DiscoveryResult> {
  const { ctx } = input;
  const dir = path.join(ctx.dataDir, "background-jobs");
  if (!fs.existsSync(dir)) return { runner: "background", jobs: [], effects: [], complete: true };
  const jobs: JobUpsert[] = [];
  const effects: DiscoveryEffect[] = [];
  const now = ctx.now().getTime();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, "job.json");
    let j: BackgroundJobFile;
    try {
      j = JSON.parse(fs.readFileSync(file, "utf8")) as BackgroundJobFile;
    } catch {
      continue;
    }
    const startedAt = toIso(j.startedAt);
    const finishedAt = toIso(j.finishedAt);
    if (startedAt && now - Date.parse(finishedAt ?? startedAt) > BACKGROUND_KEEP_MS) continue;
    const id = `background:${j.id ?? entry.name}`;
    const done = Boolean(finishedAt) || (j.exitCode !== undefined && j.exitCode !== null);
    const failed = j.timedOut === true || (typeof j.exitCode === "number" && j.exitCode !== 0);
    const status = !done ? "running" : j.cancelled ? "quiet" : failed ? "failed" : "ok";
    if (done && startedAt) {
      effects.push({
        type: "run",
        run: { jobId: id, startedAt, finishedAt: finishedAt ?? startedAt, status, exitCode: j.exitCode ?? null, summary: j.timedOut ? "timed out" : j.cancelled ? "cancelled" : null, sourceRef: `background:${j.id ?? entry.name}` },
      });
    }
    jobs.push({
      id,
      runner: "background",
      name: j.label ?? entry.name,
      owner: j.agentId ?? null,
      cadence: "Once",
      cadenceSeconds: null,
      source: file,
      logs: fs.existsSync(path.join(dir, entry.name, "output.log")) ? [path.join(dir, entry.name, "output.log")] : [],
      lastRunAt: startedAt ?? undefined,
      lastStatus: status,
      lastExit: typeof j.exitCode === "number" ? j.exitCode : null,
      facts: { status: j.status ?? null, timedOut: j.timedOut ?? false, cancelled: j.cancelled ?? false, timeoutSeconds: j.timeoutSeconds ?? null },
    });
  }
  return { runner: "background", jobs, effects, complete: true };
}

// ---------------------------------------------------------------- Loom waits

interface TriggerRow {
  id: string;
  thread_id: string;
  kind: string;
  spec: string;
  note: string;
  created_at: number;
  expires_at: number;
  status: string;
  last_checked_at: number | null;
  last_error: string | null;
}

export function loomToken(tokenFile?: string): string | null {
  const file = tokenFile
    ? tokenFile.replace(/^~(?=\/|$)/, os.homedir())
    : path.join(process.env.LOOM_HOME || path.join(os.homedir(), ".tango", "loom"), "token");
  try {
    return fs.readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Waiting Loom triggers (GET /triggers?status=waiting with Loom's bearer token). Skipped when Loom is not reachable. */
/** When a Loom wait is due: a time wait's `at`, otherwise (or if `at` is unreadable) its expiry. */
export function loomWaitDueAt(t: Pick<TriggerRow, "kind" | "spec" | "expires_at">): number {
  if (t.kind === "time") {
    try {
      const at = Date.parse(String((JSON.parse(t.spec) as { at?: unknown }).at));
      if (Number.isFinite(at)) return Math.min(at, t.expires_at);
    } catch {
      // not JSON: the expiry stands
    }
  }
  return t.expires_at;
}

export async function discoverLoomWaits(input: DiscoveryInput): Promise<DiscoveryResult> {
  const { ctx } = input;
  const token = loomToken(ctx.annotations.loom.tokenFile);
  if (!token) return { runner: "loom-wait", jobs: [], effects: [], complete: false, note: "no Loom token" };
  const res = await ctx.fetch(`${ctx.annotations.loom.url}/triggers?status=waiting`, { headers: { Authorization: `Bearer ${token}` }, timeoutMs: 3000 });
  if ("error" in res || res.status !== 200) {
    return { runner: "loom-wait", jobs: [], effects: [], complete: false, note: "error" in res ? res.error : `HTTP ${res.status}` };
  }
  let rows: TriggerRow[];
  try {
    rows = JSON.parse(res.text) as TriggerRow[];
  } catch {
    return { runner: "loom-wait", jobs: [], effects: [], complete: false, note: "bad JSON from Loom" };
  }
  const jobs = (Array.isArray(rows) ? rows : []).map((t): JobUpsert => {
    const note = (t.note || t.kind).replace(/\s+/g, " ").trim();
    return {
      id: `loom-wait:${t.id}`,
      runner: "loom-wait",
      name: note.length > 80 ? `${note.slice(0, 79)}…` : note,
      owner: t.thread_id,
      cadence: `Waits for ${t.kind}`,
      cadenceSeconds: null,
      // When it is due: a time wait's moment, else its expiry (Loom wakes the thread on timeout too).
      nextRunAt: toIso(loomWaitDueAt(t)),
      lastRunAt: toIso(t.last_checked_at) ?? undefined,
      // A command wait's last_error is usually just "not yet" (a non-zero check); it is a fact, not a failure.
      lastStatus: "running",
      facts: { kind: t.kind, threadId: t.thread_id, createdAt: toIso(t.created_at), expiresAt: toIso(t.expires_at), lastError: t.last_error },
    };
  });
  return { runner: "loom-wait", jobs, effects: [], complete: true };
}
