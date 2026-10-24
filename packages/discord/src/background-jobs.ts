import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Background jobs let an agent hand a long shell batch (a multi-city listing
 * sweep, a crawl) to the bot instead of running it inside its turn, where the
 * runtime wall clock would kill it and discard the work. The bot owns the job:
 * it runs detached in its own session (so a bot restart does not kill it),
 * records its exit code to a file, and when it ends posts a completion notice
 * into the originating Discord thread that re-enters the agent as a new turn.
 *
 * All state lives on disk under `<rootDir>/<job-id>/` so a restarted bot picks
 * up jobs that were running or finished while it was down.
 */

export type BackgroundJobStatus = "running" | "finished" | "notified";

export interface BackgroundJob {
  id: string;
  agentId: string;
  channelId: string;
  threadId: string | null;
  conversationKey: string | null;
  label: string;
  command: string;
  dir: string;
  pid: number | null;
  startedAt: string;
  timeoutSeconds: number;
  status: BackgroundJobStatus;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  finishedAt: string | null;
}

export interface StartBackgroundJobInput {
  agentId: string;
  channelId: string;
  threadId?: string | null;
  conversationKey?: string | null;
  label: string;
  command: string;
  timeoutSeconds?: number;
}

export interface BackgroundJobManagerOptions {
  rootDir: string;
  /** Deliver the completion. Resolve true once delivered; false retries on the next tick. */
  onFinished: (job: BackgroundJob) => Promise<boolean>;
  pollMs?: number;
  now?: () => number;
  spawnJob?: (job: BackgroundJob) => number | null;
  isAlive?: (pid: number) => boolean;
  killGroup?: (pid: number, signal: NodeJS.Signals) => void;
  log?: (message: string) => void;
}

export const DEFAULT_BACKGROUND_JOB_TIMEOUT_SECONDS = 3_600;
export const MAX_BACKGROUND_JOB_TIMEOUT_SECONDS = 4 * 3_600;
export const MAX_RUNNING_JOBS_PER_AGENT = 3;
const MAX_COMMAND_CHARS = 20_000;
const MAX_LABEL_CHARS = 80;
const DEFAULT_POLL_MS = 15_000;
const OUTPUT_TAIL_BYTES = 2_000;

const JOB_FILE = "job.json";
const SCRIPT_FILE = "job.sh";
const OUTPUT_FILE = "output.log";
const EXIT_CODE_FILE = "exit_code";

// Runs the job script ($2 = shell) with output captured, then records the exit
// status atomically. A job killed before it finishes leaves no exit_code file.
const WRAPPER_SCRIPT =
  `cd "$1" && "$2" ./${SCRIPT_FILE} > ${OUTPUT_FILE} 2>&1; `
  + `echo $? > ${EXIT_CODE_FILE}.tmp && mv ${EXIT_CODE_FILE}.tmp ${EXIT_CODE_FILE}`;

// Job scripts target zsh (the host's shell); fall back to sh where it is absent.
const JOB_SHELL = fs.existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh";

function defaultSpawnJob(job: BackgroundJob): number | null {
  const child = spawn("/bin/sh", ["-c", WRAPPER_SCRIPT, "tango-background-job", job.dir, JOB_SHELL], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  // A spawn failure is reported through the missing pid; without a listener
  // the 'error' event would crash the bot.
  child.on("error", () => {});
  child.unref();
  return child.pid ?? null;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function defaultKillGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 32) || "job";
}

export function formatJobDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function backgroundJobOutputPath(job: BackgroundJob): string {
  return path.join(job.dir, OUTPUT_FILE);
}

export function readBackgroundJobOutputTail(job: BackgroundJob, bytes = OUTPUT_TAIL_BYTES): string {
  const outputPath = backgroundJobOutputPath(job);
  try {
    const size = fs.statSync(outputPath).size;
    const start = Math.max(0, size - bytes);
    const fd = fs.openSync(outputPath, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** The completion notice. It is posted to the thread and becomes the agent's next prompt. */
export function formatBackgroundJobCompletion(job: BackgroundJob, nowMs: number): string {
  const finishedMs = job.finishedAt ? Date.parse(job.finishedAt) : nowMs;
  const duration = formatJobDuration(finishedMs - Date.parse(job.startedAt));
  const outcome = job.timedOut
    ? `was stopped at its ${formatJobDuration(job.timeoutSeconds * 1000)} limit`
    : job.exitCode === 0
      ? "finished"
      : job.exitCode === null
        ? "ended without an exit code (killed or crashed)"
        : `failed with exit code ${job.exitCode}`;
  return [
    `⚙️ Background job **${job.label}** ${outcome} after ${duration}.`,
    `Output: \`${backgroundJobOutputPath(job)}\` · job \`${job.id}\``,
    "Read the job output and any result files it wrote, then report the results here.",
  ].join("\n");
}

export class BackgroundJobManager {
  private readonly jobs = new Map<string, BackgroundJob>();
  private readonly options: Required<Omit<BackgroundJobManagerOptions, "log">> & Pick<BackgroundJobManagerOptions, "log">;
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(options: BackgroundJobManagerOptions) {
    this.options = {
      pollMs: DEFAULT_POLL_MS,
      now: Date.now,
      spawnJob: defaultSpawnJob,
      isAlive: defaultIsAlive,
      killGroup: defaultKillGroup,
      ...options,
    };
  }

  /** Load persisted jobs and start the poll loop. */
  start(): void {
    this.loadPersistedJobs();
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.pollMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  startJob(input: StartBackgroundJobInput): BackgroundJob {
    const command = input.command.trim();
    if (!command) throw new Error("command is required");
    if (command.length > MAX_COMMAND_CHARS) {
      throw new Error(`command is too long (${command.length} chars, max ${MAX_COMMAND_CHARS}); put it in a script file and run that`);
    }
    const label = (input.label.trim() || "background job").slice(0, MAX_LABEL_CHARS);
    const running = this.list(input.agentId).filter((job) => job.status === "running").length;
    if (running >= MAX_RUNNING_JOBS_PER_AGENT) {
      throw new Error(`already running ${running} background jobs (max ${MAX_RUNNING_JOBS_PER_AGENT}); wait for one to finish or cancel one`);
    }
    const requestedTimeout = Math.round(input.timeoutSeconds ?? DEFAULT_BACKGROUND_JOB_TIMEOUT_SECONDS);
    const timeoutSeconds = Math.min(
      MAX_BACKGROUND_JOB_TIMEOUT_SECONDS,
      Math.max(60, Number.isFinite(requestedTimeout) ? requestedTimeout : DEFAULT_BACKGROUND_JOB_TIMEOUT_SECONDS),
    );

    const id = `${slugify(label)}-${randomUUID().slice(0, 8)}`;
    const dir = path.join(this.options.rootDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, SCRIPT_FILE), `${command}\n`, { mode: 0o700 });

    const job: BackgroundJob = {
      id,
      agentId: input.agentId,
      channelId: input.channelId,
      threadId: input.threadId ?? null,
      conversationKey: input.conversationKey ?? null,
      label,
      command,
      dir,
      pid: null,
      startedAt: new Date(this.options.now()).toISOString(),
      timeoutSeconds,
      status: "running",
      exitCode: null,
      timedOut: false,
      cancelled: false,
      finishedAt: null,
    };
    job.pid = this.options.spawnJob(job);
    if (job.pid === null) {
      throw new Error("failed to start the background job process");
    }
    this.jobs.set(id, job);
    this.save(job);
    this.options.log?.(
      `[background-job] started id=${id} agent=${job.agentId} channel=${job.threadId ?? job.channelId} pid=${job.pid} timeout=${timeoutSeconds}s`,
    );
    return job;
  }

  /** Jobs for one agent, newest first. Agents only ever see their own jobs. */
  list(agentId: string): BackgroundJob[] {
    return [...this.jobs.values()]
      .filter((job) => job.agentId === agentId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(agentId: string, id: string): BackgroundJob | undefined {
    const job = this.jobs.get(id);
    return job && job.agentId === agentId ? job : undefined;
  }

  cancel(agentId: string, id: string): BackgroundJob {
    const job = this.get(agentId, id);
    if (!job) throw new Error(`no background job '${id}'`);
    if (job.status !== "running") return job;
    if (job.pid !== null) this.options.killGroup(job.pid, "SIGTERM");
    // Cancelled by the agent itself, so there is nothing to wake it up for.
    job.cancelled = true;
    job.status = "notified";
    job.finishedAt = new Date(this.options.now()).toISOString();
    this.save(job);
    this.options.log?.(`[background-job] cancelled id=${job.id} agent=${job.agentId}`);
    return job;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const job of [...this.jobs.values()]) {
        if (job.status === "running") this.checkRunning(job);
        if (job.status === "finished") await this.deliver(job);
      }
    } finally {
      this.ticking = false;
    }
  }

  private checkRunning(job: BackgroundJob): void {
    const exitCode = this.readExitCode(job);
    const alive = job.pid !== null && this.options.isAlive(job.pid);
    if (exitCode === undefined && alive) {
      const elapsedMs = this.options.now() - Date.parse(job.startedAt);
      if (elapsedMs >= job.timeoutSeconds * 1000 && job.pid !== null) {
        // SIGTERM first; if the group is still alive on a later tick, SIGKILL.
        this.options.killGroup(job.pid, job.timedOut ? "SIGKILL" : "SIGTERM");
        if (!job.timedOut) {
          job.timedOut = true;
          this.save(job);
          this.options.log?.(`[background-job] timeout id=${job.id} after ${job.timeoutSeconds}s`);
        }
      }
      return;
    }
    job.exitCode = exitCode ?? null;
    job.status = "finished";
    job.finishedAt = new Date(this.options.now()).toISOString();
    this.save(job);
    this.options.log?.(
      `[background-job] finished id=${job.id} agent=${job.agentId} exit=${job.exitCode ?? "none"} timedOut=${job.timedOut}`,
    );
  }

  private async deliver(job: BackgroundJob): Promise<void> {
    let delivered = false;
    try {
      delivered = await this.options.onFinished(job);
    } catch (error) {
      this.options.log?.(
        `[background-job] delivery failed id=${job.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!delivered) return;
    job.status = "notified";
    this.save(job);
  }

  private readExitCode(job: BackgroundJob): number | undefined {
    try {
      const raw = fs.readFileSync(path.join(job.dir, EXIT_CODE_FILE), "utf8").trim();
      const code = Number.parseInt(raw, 10);
      return Number.isFinite(code) ? code : undefined;
    } catch {
      return undefined;
    }
  }

  private save(job: BackgroundJob): void {
    const target = path.join(job.dir, JOB_FILE);
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(job, null, 2)}\n`);
    fs.renameSync(temp, target);
  }

  private loadPersistedJobs(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.options.rootDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      try {
        const job = JSON.parse(
          fs.readFileSync(path.join(this.options.rootDir, entry, JOB_FILE), "utf8"),
        ) as BackgroundJob;
        if (job?.id && !this.jobs.has(job.id)) this.jobs.set(job.id, job);
      } catch {
        // Not a job directory, or a torn write from a crash; skip it.
      }
    }
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function describeJob(job: BackgroundJob, nowMs: number, includeTail: boolean): Record<string, unknown> {
  const endMs = job.finishedAt ? Date.parse(job.finishedAt) : nowMs;
  return {
    id: job.id,
    label: job.label,
    status: job.cancelled ? "cancelled" : job.status === "running" ? "running" : "ended",
    exit_code: job.exitCode,
    timed_out: job.timedOut,
    started_at: job.startedAt,
    elapsed: formatJobDuration(endMs - Date.parse(job.startedAt)),
    timeout_seconds: job.timeoutSeconds,
    dir: job.dir,
    output_path: backgroundJobOutputPath(job),
    ...(includeTail ? { output_tail: readBackgroundJobOutputTail(job) } : {}),
  };
}

/**
 * Handles a request from the `background_job` MCP tool. Identity and the
 * Discord surface come from the server-injected runtime-context fields
 * (`_requester_agent_id`, `_channel_id`, `_thread_id`), never from model input.
 */
export function handleBackgroundJobRequest(
  manager: BackgroundJobManager,
  input: Record<string, unknown>,
  nowMs = Date.now(),
): Record<string, unknown> {
  const agentId = nonEmptyString(input._requester_agent_id);
  if (!agentId) throw new Error("background_job requires a calling agent identity");
  const action = nonEmptyString(input.action) ?? "list";

  switch (action) {
    case "start": {
      const channelId = nonEmptyString(input._channel_id);
      if (!channelId) {
        throw new Error("background_job start needs a Discord conversation to report back to");
      }
      const job = manager.startJob({
        agentId,
        channelId,
        threadId: nonEmptyString(input._thread_id),
        conversationKey: nonEmptyString(input._conversation_key),
        label: nonEmptyString(input.label) ?? "background job",
        command: typeof input.command === "string" ? input.command : "",
        ...(typeof input.timeout_seconds === "number" ? { timeoutSeconds: input.timeout_seconds } : {}),
      });
      return {
        ...describeJob(job, nowMs, false),
        note: "Running detached. When it exits you will get a new turn in this conversation with the result location. End this turn now; do not poll in a loop.",
      };
    }
    case "status": {
      const id = nonEmptyString(input.job_id);
      if (!id) throw new Error("job_id is required for status");
      const job = manager.get(agentId, id);
      if (!job) throw new Error(`no background job '${id}'`);
      return describeJob(job, nowMs, true);
    }
    case "cancel": {
      const id = nonEmptyString(input.job_id);
      if (!id) throw new Error("job_id is required for cancel");
      return describeJob(manager.cancel(agentId, id), nowMs, false);
    }
    case "list":
      return { jobs: manager.list(agentId).slice(0, 20).map((job) => describeJob(job, nowMs, false)) };
    default:
      throw new Error(`unknown action '${action}' (use start, status, list, or cancel)`);
  }
}
