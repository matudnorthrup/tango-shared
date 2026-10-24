import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { DeskCore } from './core.js';
import type { CodexWorker, Log } from './types.js';

// Codex workers dispatched through agentctl as a fact source: one directory per task
// (~/.local/state/agentic/<project>/<task>/status.json). agentctl records the conversation that
// started the task (`parentThread`: loom:<id>), and the desk lists the worker under it.
// Read straight from disk, like background jobs. Goes away when Codex runs on Loom (TGO-975).

interface StatusFile {
  project?: string;
  task?: string;
  status?: string;
  parentThread?: string;
  branch?: string;
  codexAccount?: string;
  createdAt?: string;
  updatedAt?: string;
  worktreeRemoved?: boolean;
  cleanedAt?: string;
  worker?: { status?: string; startedAt?: string; finishedAt?: string; lastMessagePath?: string };
}

/** How long a finished task stays under its parent. */
export const FINISHED_KEEP_MS = 3 * 86_400_000;

function stateOf(file: StatusFile): CodexWorker['state'] {
  const worker = file.worker?.status;
  if (worker === 'running' || worker === 'queued') return 'working';
  if (worker === 'failed' || worker === 'stale' || file.status === 'worker_failed' || file.status === 'verification_failed') return 'failed';
  if (worker === 'succeeded' || ['review', 'verified', 'completed'].includes(file.status ?? '')) return 'finished';
  return 'idle';
}

async function lastMessage(file: StatusFile): Promise<string | null> {
  const at = file.worker?.lastMessagePath;
  if (!at) return null;
  try {
    const text = (await fsp.readFile(at, 'utf8')).replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 280) : null;
  } catch {
    return null;
  }
}

/**
 * Workers by the conversation that started them, newest first. Discarded, cleaned-up and old finished tasks are left out.
 * Read asynchronously: a slow disk once held the server for 0.9 s here (desk/stalls.ts).
 */
export async function readCodexWorkers(dir: string, now: number, log: Log = () => {}): Promise<Map<string, CodexWorker[]>> {
  const byParent = new Map<string, CodexWorker[]>();
  let projects: string[];
  try {
    projects = await fsp.readdir(dir);
  } catch {
    return byParent; // agentctl never ran here
  }
  for (const project of projects) {
    let tasks: string[];
    try {
      tasks = await fsp.readdir(path.join(dir, project));
    } catch {
      continue;
    }
    for (const task of tasks) {
      const file = path.join(dir, project, task, 'status.json');
      let status: StatusFile;
      try {
        status = JSON.parse(await fsp.readFile(file, 'utf8')) as StatusFile;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') log('desk.agentctl.read.error', { file, message: (err as Error).message });
        continue;
      }
      const parent = status.parentThread;
      if (!parent || status.status === 'discarded' || status.status === 'worktree_removed' || status.cleanedAt || status.worktreeRemoved) continue;
      const state = stateOf(status);
      const updatedAt = Date.parse(status.updatedAt ?? '') || 0;
      if (state !== 'working' && now - updatedAt > FINISHED_KEEP_MS) continue;
      const worker: CodexWorker = {
        id: `agentctl:${status.project ?? project}/${status.task ?? task}`,
        project: status.project ?? project,
        task: status.task ?? task,
        status: status.status ?? 'unknown',
        state,
        branch: status.branch ?? null,
        account: status.codexAccount ?? null,
        startedAt: Date.parse(status.worker?.startedAt ?? status.createdAt ?? '') || updatedAt,
        updatedAt,
        lastMessage: state === 'working' ? null : await lastMessage(status),
      };
      const list = byParent.get(parent) ?? [];
      list.push(worker);
      byParent.set(parent, list);
    }
  }
  for (const list of byParent.values()) list.sort((a, b) => b.updatedAt - a.updatedAt);
  return byParent;
}

export class DeskAgentctlSource {
  constructor(private readonly options: { core: DeskCore; dir: string; log?: Log }) {}

  private reading: Promise<number> | null = null;

  /** One read at a time: a poll while one is out joins it. */
  poll(): Promise<number> {
    this.reading ??= readCodexWorkers(this.options.dir, Date.now(), this.options.log)
      .then((workers) => {
        this.options.core.setCodexWorkers(workers);
        let count = 0;
        for (const list of workers.values()) count += list.length;
        return count;
      })
      .finally(() => (this.reading = null));
    return this.reading;
  }
}
