import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { loadAnnotations } from "./annotations.js";
import { defaultContext, type SystemContext } from "./context.js";
import { closeJobIncidents } from "./incidents.js";
import { getJob, splitJobId, setJobState } from "./jobs.js";
import { nowIso } from "./ledger.js";
import { loadStartupInfo, tmuxTarget } from "./discovery/tmux.js";
import { parsePs } from "./unmanaged.js";
import type { JobRow, Ledger } from "./types.js";

export type JobActionName = "run" | "pause" | "resume" | "restart" | "retire" | "restore";
type Result = { ok: boolean; message: string };

/** What retire did, so restore can undo exactly that. */
type RetireStep =
  | { type: "moved"; from: string; to: string }
  | { type: "created"; file: string }
  | { type: "edited"; file: string; backup: string; key: "schedule" | "startup"; id: string; prevEnabled: boolean | null; addedEntry: boolean }
  | { type: "paused" }
  | { type: "docker-restart-policy"; name: string; prev: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function archiveDir(ctx: SystemContext): string {
  return path.join(ctx.profileDir, "archive", "retired", localDate(ctx.now()));
}

/** Moves a file or folder, across devices if needed; never overwrites (adds a numeric suffix). */
export function moveInto(src: string, destDir: string): string {
  fs.mkdirSync(destDir, { recursive: true });
  const base = path.basename(src);
  let dest = path.join(destDir, base);
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(destDir, `${base}.${n}`);
  movePath(src, dest);
  return dest;
}

function movePath(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

function yamlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => path.join(dir, f));
}

function filesWithId(dir: string, id: string): string[] {
  return yamlFiles(dir).filter((f) => {
    try {
      const doc = yaml.load(fs.readFileSync(f, "utf8"));
      return isObj(doc) && doc.id === id;
    } catch {
      return false;
    }
  });
}

function writeYaml(file: string, doc: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, yaml.dump(doc, { lineWidth: 120, noRefs: true }));
  fs.renameSync(tmp, file);
}

async function bot(ctx: SystemContext, scheduleId: string, verb: "run" | "pause" | "resume"): Promise<Result> {
  const res = await ctx.fetch(`${ctx.annotations.bot.url}/schedules/${encodeURIComponent(scheduleId)}/${verb}`, { method: "POST", timeoutMs: 5000 });
  if ("error" in res) return { ok: false, message: `bot not reachable: ${res.error}` };
  if (res.status >= 200 && res.status < 300) return { ok: true, message: `${verb} sent to the scheduler` };
  let detail = res.text;
  try {
    detail = (JSON.parse(res.text) as { error?: string }).error ?? res.text;
  } catch {
    // plain text
  }
  return { ok: false, message: `scheduler said ${res.status}: ${detail}` };
}

async function run(ctx: SystemContext, cmd: string, args: string[], timeoutMs = 10_000): Promise<Result> {
  const r = await ctx.exec(cmd, args, { timeoutMs });
  if (r.code === 0) return { ok: true, message: `${cmd} ${args.join(" ")}` };
  return { ok: false, message: `${cmd} ${args[0] ?? ""} failed: ${(r.stderr || r.stdout || r.error || `exit ${r.code}`).trim().split("\n")[0]}` };
}

// ---------------------------------------------------------------- schedules

function scheduleRetire(ctx: SystemContext, scheduleId: string): RetireStep[] {
  const steps: RetireStep[] = [];
  const profileDir = path.join(ctx.profileDir, "config", "schedules");
  const defaultsDir = path.join(ctx.repoDir, "config", "defaults", "schedules");
  const profileFiles = filesWithId(profileDir, scheduleId);
  const inDefaults = filesWithId(defaultsDir, scheduleId).length > 0;
  const dest = archiveDir(ctx);
  if (!inDefaults && profileFiles.length > 0) {
    // A profile-only schedule: its YAML moves to the archive.
    for (const f of profileFiles) steps.push({ type: "moved", from: f, to: moveInto(f, dest) });
    return steps;
  }
  if (profileFiles.length > 0) {
    const file = profileFiles[0]!;
    const backup = path.join(dest, `${path.basename(file)}.before-retire`);
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(file, backup);
    const doc = yaml.load(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const prevEnabled = typeof doc.enabled === "boolean" ? doc.enabled : null;
    doc.enabled = false;
    writeYaml(file, doc);
    steps.push({ type: "edited", file, backup, key: "schedule", id: scheduleId, prevEnabled, addedEntry: false });
    return steps;
  }
  const file = path.join(profileDir, `${scheduleId}.yaml`);
  writeYaml(file, { id: scheduleId, enabled: false });
  steps.push({ type: "created", file });
  return steps;
}

// ---------------------------------------------------------------- startup services

async function startupConfigPath(ctx: SystemContext): Promise<string> {
  try {
    const info = await loadStartupInfo(ctx);
    if (info) return info.profileConfigPath;
  } catch {
    // fall through
  }
  return path.join(ctx.profileDir, "config", "startup.yaml");
}

async function startupRetire(ctx: SystemContext, serviceId: string): Promise<RetireStep[]> {
  const file = await startupConfigPath(ctx);
  const dest = archiveDir(ctx);
  let doc: Record<string, unknown> = {};
  let backup = "";
  if (fs.existsSync(file)) {
    backup = path.join(dest, `${path.basename(file)}.before-retire`);
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(file, backup);
    const loaded = yaml.load(fs.readFileSync(file, "utf8"));
    if (isObj(loaded)) doc = loaded;
  }
  const services = Array.isArray(doc.services) ? (doc.services as Array<Record<string, unknown>>) : [];
  let entry = services.find((s) => isObj(s) && s.id === serviceId);
  const addedEntry = !entry;
  if (!entry) {
    entry = { id: serviceId };
    services.push(entry);
  }
  const prevEnabled = typeof entry.enabled === "boolean" ? entry.enabled : null;
  entry.enabled = false;
  doc.services = services;
  writeYaml(file, doc);
  return [{ type: "edited", file, backup, key: "startup", id: serviceId, prevEnabled, addedEntry }];
}

function undoEdit(step: Extract<RetireStep, { type: "edited" }>): void {
  if (!fs.existsSync(step.file)) return;
  const doc = yaml.load(fs.readFileSync(step.file, "utf8"));
  if (!isObj(doc)) return;
  if (step.key === "schedule") {
    if (step.prevEnabled === null) delete doc.enabled;
    else doc.enabled = step.prevEnabled;
  } else {
    const services = Array.isArray(doc.services) ? (doc.services as Array<Record<string, unknown>>) : [];
    const i = services.findIndex((s) => isObj(s) && s.id === step.id);
    if (i >= 0) {
      const entry = services[i]!;
      if (step.addedEntry && Object.keys(entry).every((k) => k === "id" || k === "enabled")) services.splice(i, 1);
      else if (step.prevEnabled === null) delete entry.enabled;
      else entry.enabled = step.prevEnabled;
    }
    doc.services = services;
  }
  writeYaml(step.file, doc);
}

function undoSteps(steps: RetireStep[]): string[] {
  const notes: string[] = [];
  for (const step of [...steps].reverse()) {
    if (step.type === "moved") {
      if (fs.existsSync(step.from)) notes.push(`${step.from} exists again; left the archived copy at ${step.to}`);
      else if (fs.existsSync(step.to)) movePath(step.to, step.from);
    } else if (step.type === "created") {
      fs.rmSync(step.file, { force: true });
    } else if (step.type === "edited") {
      undoEdit(step);
    }
  }
  return notes;
}

// ---------------------------------------------------------------- the action

async function pauseOrResume(ctx: SystemContext, job: JobRow, runnerId: string, resume: boolean): Promise<Result> {
  switch (job.runner) {
    case "schedule":
      return bot(ctx, runnerId, resume ? "resume" : "pause");
    case "launchd": {
      // bootout alone lasts until the next login (the plist loads again); disable is what keeps it paused.
      if (resume) {
        const plist = job.source;
        if (!plist || !fs.existsSync(plist)) return { ok: false, message: `plist not found: ${plist ?? "(none)"}` };
        await run(ctx, "launchctl", ["enable", `gui/${ctx.uid}/${runnerId}`]);
        return run(ctx, "launchctl", ["bootstrap", `gui/${ctx.uid}`, plist]);
      }
      const out = await run(ctx, "launchctl", ["bootout", `gui/${ctx.uid}/${runnerId}`]);
      if (!out.ok) return out;
      const off = await run(ctx, "launchctl", ["disable", `gui/${ctx.uid}/${runnerId}`]);
      return off.ok ? out : { ok: true, message: `${out.message}; not disabled, so it loads again at login (${off.message})` };
    }
    case "tmux": {
      if (resume) return run(ctx, path.join(ctx.repoDir, "scripts", "startup.sh"), ["--only", runnerId], 30_000);
      const startup = await loadStartupInfo(ctx).catch(() => null);
      const target = tmuxTarget(ctx, startup);
      const window = typeof job.facts.window === "string" ? job.facts.window : runnerId;
      return run(ctx, "tmux", [...target.args, "kill-window", "-t", `${target.session}:${window}`]);
    }
    case "docker":
      return run(ctx, "docker", [resume ? "start" : "stop", runnerId], 30_000);
    default:
      return { ok: false, message: `${job.runner} jobs cannot be ${resume ? "resumed" : "paused"}` };
  }
}

export async function jobAction(
  l: Ledger,
  jobId: string,
  action: JobActionName,
  opts: { reason?: string; force?: boolean } = {},
  deps?: SystemContext,
): Promise<{ ok: boolean; message: string }> {
  try {
    const ctx = deps ?? defaultContext(loadAnnotations());
    const job = getJob(l, jobId);
    if (!job) return { ok: false, message: `no job ${jobId}` };
    const parts = splitJobId(jobId);
    if (!parts) return { ok: false, message: `not a job id: ${jobId}` };
    if (!job.managed) return { ok: false, message: "an unmanaged process has no job actions; use stop" };
    if (job.criticality === "critical" && !opts.force) {
      return { ok: false, message: `${job.name} is critical; pass force to ${action} it` };
    }
    const id = parts.runnerId;

    if (action === "run" || action === "restart") {
      switch (job.runner) {
        case "schedule":
          return bot(ctx, id, "run");
        case "launchd":
          return run(ctx, "launchctl", ["kickstart", ...(action === "restart" ? ["-k"] : []), `gui/${ctx.uid}/${id}`]);
        case "tmux": {
          const startup = await loadStartupInfo(ctx).catch(() => null);
          const target = tmuxTarget(ctx, startup);
          const window = typeof job.facts.window === "string" ? job.facts.window : id;
          if (job.facts.alive === true) return run(ctx, "tmux", [...target.args, "respawn-window", "-k", "-t", `${target.session}:${window}`]);
          return run(ctx, path.join(ctx.repoDir, "scripts", "startup.sh"), ["--only", id], 30_000);
        }
        case "docker":
          return run(ctx, "docker", [action === "restart" ? "restart" : "start", id], 30_000);
        default:
          return { ok: false, message: `${job.runner} jobs cannot be run from here` };
      }
    }

    if (action === "pause" || action === "resume") {
      if (job.state === "retired") return { ok: false, message: "retired; restore it first" };
      const r = await pauseOrResume(ctx, job, id, action === "resume");
      if (r.ok) setJobState(l, jobId, action === "pause" ? "paused" : "active");
      if (r.ok && action === "pause") closeJobIncidents(l, jobId);
      return r;
    }

    if (action === "retire") {
      if (job.state === "retired") return { ok: true, message: "already retired" };
      const steps: RetireStep[] = [];
      const notes: string[] = [];
      let archivePath: string | null = null;
      switch (job.runner) {
        case "schedule": {
          const p = await bot(ctx, id, "pause");
          if (p.ok) steps.push({ type: "paused" });
          else notes.push(`could not pause in the running bot (${p.message}); it stops at the next bot restart`);
          steps.push(...scheduleRetire(ctx, id));
          break;
        }
        case "launchd": {
          if (job.facts.loaded !== false) {
            const p = await pauseOrResume(ctx, job, id, false);
            if (!p.ok) return { ok: false, message: p.message };
            steps.push({ type: "paused" });
          }
          if (job.source && fs.existsSync(job.source)) steps.push({ type: "moved", from: job.source, to: moveInto(job.source, archiveDir(ctx)) });
          break;
        }
        case "tmux": {
          if (job.facts.alive === true) {
            const p = await pauseOrResume(ctx, job, id, false);
            if (!p.ok) return { ok: false, message: p.message };
            steps.push({ type: "paused" });
          }
          if (job.facts.configured !== false) steps.push(...(await startupRetire(ctx, id)));
          break;
        }
        case "docker": {
          const p = await pauseOrResume(ctx, job, id, false);
          if (!p.ok) return { ok: false, message: p.message };
          steps.push({ type: "paused" });
          const insp = await ctx.exec("docker", ["inspect", "--format", "{{.HostConfig.RestartPolicy.Name}}", id], { timeoutMs: 5000 });
          const prev = insp.code === 0 ? insp.stdout.trim() : "";
          if (prev && prev !== "no") {
            const u = await run(ctx, "docker", ["update", "--restart=no", id]);
            if (u.ok) steps.push({ type: "docker-restart-policy", name: id, prev });
          }
          break;
        }
        case "routine": {
          const folder = typeof job.facts.folder === "string" ? job.facts.folder : job.source ? path.dirname(job.source) : null;
          if (folder && fs.existsSync(folder)) steps.push({ type: "moved", from: folder, to: moveInto(folder, archiveDir(ctx)) });
          break;
        }
        default:
          return { ok: false, message: `${job.runner} jobs cannot be retired` };
      }
      const moved = steps.find((s): s is Extract<RetireStep, { type: "moved" }> => s.type === "moved");
      archivePath = moved?.to ?? (fs.existsSync(archiveDir(ctx)) ? archiveDir(ctx) : null);
      setJobState(l, jobId, "retired", { retireReason: opts.reason ?? null, archivePath, facts: { retire: { at: nowIso(), steps } } });
      closeJobIncidents(l, jobId);
      return { ok: true, message: ["retired", ...notes].join("; ") };
    }

    if (action === "restore") {
      if (job.state !== "retired") return { ok: false, message: "not retired" };
      const retire = job.facts.retire as { steps?: RetireStep[] } | undefined;
      const steps = retire?.steps ?? [];
      const notes = undoSteps(steps);
      for (const s of steps) {
        if (s.type === "docker-restart-policy") await run(ctx, "docker", ["update", `--restart=${s.prev}`, s.name]);
      }
      // Bring it back the way it ran before (a schedule overlay change needs the bot to reload; resume works now).
      let r: Result = { ok: true, message: "restored" };
      if (steps.some((s) => s.type === "paused") || job.runner === "launchd") {
        r = await pauseOrResume(ctx, { ...job, source: (steps.find((s) => s.type === "moved") as { from?: string } | undefined)?.from ?? job.source }, id, true);
      }
      setJobState(l, jobId, "active", { facts: { retire: null } });
      return { ok: true, message: ["restored", r.ok ? null : `restart it by hand: ${r.message}`, ...notes].filter(Boolean).join("; ") };
    }

    return { ok: false, message: `unknown action ${String(action)}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Stops an unmanaged process: confirms it is still the same process (ppid 1,
 * same start time) right before SIGTERM, then SIGKILL after 10 s.
 */
export async function stopProcess(l: Ledger, jobId: string, deps?: SystemContext): Promise<{ ok: boolean; message: string }> {
  try {
    const ctx = deps ?? defaultContext(loadAnnotations());
    const job = getJob(l, jobId);
    if (!job) return { ok: false, message: `no job ${jobId}` };
    if (job.managed) return { ok: false, message: "only unmanaged processes can be stopped here" };
    const pid = Number(job.facts.pid);
    const startedAt = String(job.facts.startedAt ?? "");
    if (!Number.isInteger(pid) || pid <= 1) return { ok: false, message: "no pid recorded" };
    const verify = async (): Promise<"same" | "gone" | "different"> => {
      const r = await ctx.exec("ps", ["-o", "pid,ppid,uid,lstart,pcpu,command", "-p", String(pid)], { timeoutMs: 3000 });
      const p = parsePs(r.stdout).find((x) => x.pid === pid);
      if (!p) return "gone";
      return p.ppid === 1 && p.started === startedAt ? "same" : "different";
    };
    const first = await verify();
    if (first === "gone") {
      closeJobIncidents(l, jobId);
      l.db.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
      return { ok: true, message: "already gone" };
    }
    if (first === "different") return { ok: false, message: `pid ${pid} is no longer the same process; not touching it` };
    ctx.kill(pid, "SIGTERM");
    for (let waited = 0; waited < 10_000; waited += 500) {
      await ctx.sleep(500);
      if ((await verify()) !== "same") {
        closeJobIncidents(l, jobId);
        l.db.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
        return { ok: true, message: `stopped pid ${pid}` };
      }
    }
    if ((await verify()) === "same") ctx.kill(pid, "SIGKILL");
    closeJobIncidents(l, jobId);
    l.db.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
    return { ok: true, message: `killed pid ${pid} (SIGKILL after 10 s)` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
