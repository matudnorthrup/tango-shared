import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { DeskCore, RunningJob } from './core.js';
import type { Log } from './types.js';

// Background jobs as a fact source: the bot writes one directory per job
// (<profileDataDir>/background-jobs/<id>/job.json, see
// packages/discord/src/background-jobs.ts). A job with status "running" marks
// its conversation (threadId ?? channelId) Watching; read straight from disk,
// so the desk needs no bot endpoint for it. Read asynchronously: a slow disk
// mustn't hold every screen's requests (desk/stalls.ts).

interface JobFile {
  id?: string;
  agentId?: string;
  channelId?: string;
  threadId?: string | null;
  conversationKey?: string | null;
  label?: string;
  startedAt?: string;
  timeoutSeconds?: number;
  status?: string;
}

export async function readRunningJobs(dir: string, log: Log = () => {}): Promise<RunningJob[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return []; // no jobs yet (or not this machine)
  }
  const jobs: RunningJob[] = [];
  for (const entry of entries) {
    const file = path.join(dir, entry, 'job.json');
    let job: JobFile;
    try {
      job = JSON.parse(await fsp.readFile(file, 'utf8')) as JobFile;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && (err as NodeJS.ErrnoException).code !== 'ENOTDIR') log('desk.jobs.read.error', { file, message: (err as Error).message });
      continue;
    }
    if (job.status !== 'running' || !job.id || !job.agentId || !job.channelId) continue;
    const startedAt = Date.parse(job.startedAt ?? '') || 0;
    jobs.push({
      id: job.id,
      agentId: job.agentId,
      channelId: job.channelId,
      threadId: job.threadId ?? null,
      conversationKey: job.conversationKey ?? null,
      label: job.label || 'background job',
      startedAt,
      // When it would hit its hard limit: the latest an update can be expected.
      deadlineAt: startedAt && job.timeoutSeconds ? startedAt + job.timeoutSeconds * 1000 : null,
    });
  }
  return jobs;
}

export class DeskJobsSource {
  constructor(private readonly options: { core: DeskCore; dir: string; log?: Log }) {}

  private reading: Promise<number> | null = null;

  /** One read at a time: a poll while one is out joins it. */
  poll(): Promise<number> {
    this.reading ??= readRunningJobs(this.options.dir, this.options.log)
      .then((jobs) => {
        this.options.core.setJobs(jobs);
        return jobs.length;
      })
      .finally(() => (this.reading = null));
    return this.reading;
  }
}
