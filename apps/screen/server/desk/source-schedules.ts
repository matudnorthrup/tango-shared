import { DatabaseSync } from 'node:sqlite';
import { Cron } from 'croner';
import { loadScheduleConfigs, loadWorkerConfigs, resolveConfigDir, type ScheduleConfig } from '@tango/core';
import type { DeskCore, DeskSourceAdapter } from './core.js';
import { jobHoldFor } from './job-holds.js';
import type { DeskItemRow, DeskSummary, Log } from './types.js';

// Tango's schedules as jobs (docs/specs/spaces.md): standing work that runs again and again and reports to its
// agent's space. Read from the schedule configs (the same layered set the bot loads) and the bot's run record
// (tango.sqlite schedule_state / schedule_runs), read-only. A job never talks with the owner itself: it has no
// composer and no Done; its failures show on its agent's page.

export const PREFIX = 'schedule:';
const RUNS = 5;

export interface ScheduleJob {
  id: string;
  title: string;
  agentId: string;
  every: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: string | null;
  failures: number;
  lastError: string | null;
  /** Paused from the desk (the bot's schedule_pauses): no timed runs until resumed. */
  paused: boolean;
  runs: Array<{ at: number; outcome: 'ok' | 'quiet' | 'failed'; note: string }>;
}

const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const clock = (h: number, m: number) => `${h}:${String(m).padStart(2, '0')}`;

/** A schedule in a few words: "Every 15 min", "Daily 7:00", "Mondays 7:00"; anything rarer is its cron. */
export function everyText(timing: ScheduleConfig['schedule']): string {
  if (timing.everySeconds) {
    const s = timing.everySeconds;
    if (s % 3600 === 0) return s === 3600 ? 'Every hour' : `Every ${s / 3600} hours`;
    if (s % 60 === 0) return `Every ${s / 60} min`;
    return `Every ${s} s`;
  }
  if (timing.at) return 'Once';
  const cron = timing.cron?.trim();
  if (!cron) return 'On request';
  const [min = '', hour = '', dom = '', mon = '', dow = ''] = cron.split(/\s+/);
  const m = Number(min);
  const h = Number(hour);
  if (/^\*\/\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${min.slice(2)} min`;
  if (Number.isInteger(m) && Number.isInteger(h) && dom === '*' && mon === '*') {
    if (dow === '*') return `Daily ${clock(h, m)}`;
    if (/^\d$/.test(dow)) return `${DAYS[Number(dow) % 7]} ${clock(h, m)}`;
    if (dow === '1-5') return `Weekdays ${clock(h, m)}`;
  }
  if (Number.isInteger(m) && hour === '*' && dom === '*' && mon === '*' && dow === '*') return 'Hourly';
  return cron;
}

export function nextRun(timing: ScheduleConfig['schedule'], lastRunAt: number | null, now: number): number | null {
  if (timing.cron) {
    try {
      return new Cron(timing.cron, { timezone: timing.timezone ?? 'America/Los_Angeles' }).nextRun(new Date(now))?.getTime() ?? null;
    } catch {
      return null;
    }
  }
  if (timing.everySeconds) return Math.max(now, (lastRunAt ?? now) + timing.everySeconds * 1000);
  if (timing.at) {
    const at = Date.parse(timing.at);
    return at > now ? at : null;
  }
  return null;
}

/** The agent a schedule works for: who it delivers as, else who runs it, else its worker's owner. */
function ownerOf(config: ScheduleConfig, workerOwners: Map<string, string>): string | null {
  return config.delivery?.agentId || config.execution.deterministicAgentId || (config.execution.workerId ? workerOwners.get(config.execution.workerId) : null) || null;
}

const iso = (value: unknown) => (typeof value === 'string' ? Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`) || null : null);

/** Every enabled schedule that belongs to an agent, with what the bot recorded about its runs. */
export function readScheduleJobs(options: { configs: ScheduleConfig[]; workerOwners: Map<string, string>; db: DatabaseSync | null; now: number }): ScheduleJob[] {
  const { configs, workerOwners, db, now } = options;
  const stateOf = db?.prepare('SELECT last_run_at, last_status, last_error, consecutive_failures, backoff_until FROM schedule_state WHERE schedule_id = ?');
  // The bot makes schedule_pauses when it starts; an older bot has none, and nothing is paused.
  let pausedOf: ReturnType<DatabaseSync['prepare']> | undefined;
  try {
    pausedOf = db?.prepare('SELECT 1 FROM schedule_pauses WHERE schedule_id = ?');
  } catch {
    pausedOf = undefined;
  }
  const runsOf = db?.prepare('SELECT started_at, status, summary, error FROM schedule_runs WHERE schedule_id = ? AND status != ? ORDER BY id DESC LIMIT ?');
  const jobs: ScheduleJob[] = [];
  for (const config of configs) {
    if (!config.enabled || config.id.startsWith('manual-test-')) continue;
    const agentId = ownerOf(config, workerOwners);
    if (!agentId) continue;
    const state = stateOf?.get(config.id) as { last_run_at: string | null; last_status: string | null; last_error: string | null; consecutive_failures: number; backoff_until: string | null } | undefined;
    const rows = (runsOf?.all(config.id, 'running', RUNS) ?? []) as Array<{ started_at: string; status: string; summary: string | null; error: string | null }>;
    const lastRunAt = iso(state?.last_run_at);
    // The scheduler waits out a failure's backoff before the next run (SchedulerEngine.computeNextRunAt).
    const next = nextRun(config.schedule, lastRunAt, now);
    const backoff = iso(state?.backoff_until);
    const runs: ScheduleJob['runs'] = rows.map((r) => ({
      at: iso(r.started_at) ?? 0,
      outcome: r.status === 'error' ? 'failed' : r.status === 'skipped' ? 'quiet' : 'ok',
      note: (r.status === 'error' ? r.error : r.summary)?.replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 140) || (r.status === 'skipped' ? 'Nothing to do' : r.status === 'error' ? 'Failed' : 'Ran'),
    }));
    // A run its pre-check skipped updates the state but writes no run row: say it, so Last run and the runs agree.
    if (lastRunAt && (!runs[0] || lastRunAt > runs[0].at + 1000)) {
      runs.unshift({ at: lastRunAt, outcome: state?.last_status === 'error' ? 'failed' : state?.last_status === 'ok' ? 'ok' : 'quiet', note: (state?.last_status === 'error' ? state?.last_error : null) || (state?.last_status === 'ok' ? 'Ran' : 'Nothing to do') });
      if (runs.length > RUNS) runs.pop();
    }
    const paused = !!pausedOf?.get(config.id);
    jobs.push({
      id: config.id,
      title: config.displayName || config.id,
      agentId,
      every: everyText(config.schedule),
      nextRunAt: paused ? null : next !== null && backoff && backoff > next ? backoff : next,
      lastRunAt,
      lastStatus: state?.last_status ?? null,
      failures: state?.consecutive_failures ?? 0,
      lastError: state?.last_error ?? null,
      paused,
      runs,
    });
  }
  return jobs;
}

function summaryOf(job: ScheduleJob, at: number): DeskSummary {
  const latest = job.runs[0];
  const gist = job.failures > 0 ? `Failed${job.failures > 1 ? ` ${job.failures} runs in a row` : ''}: ${job.lastError || latest?.note || 'see its runs'}` : latest?.note || 'No runs yet.';
  // A text summary keyed to the run: the summarizer never rewrites it (summary.source 'text').
  return { title: job.title, gist, headline: gist, step: 'fyi', ask: null, options: [], context: [], ownerAsk: null, watchUntil: null, ackOnly: false, waitingOn: null, source: 'text', contentKey: `run:${at}`, at };
}

export class DeskSchedulesSource implements DeskSourceAdapter {
  private db: DatabaseSync | null = null;

  constructor(
    private readonly options: {
      core: DeskCore;
      dbPath: string;
      configDir?: string;
      log?: Log;
      now?: () => number;
      /** The bot's scheduler endpoint (packages/discord main.ts), for Run now and Pause. */
      botUrl?: string;
      /** Tests: stands in for fetch. */
      fetch?: typeof fetch;
      /** Tests: the schedules and worker owners, instead of reading the config directory. */
      load?: () => { configs: ScheduleConfig[]; workerOwners: Map<string, string> };
    },
  ) {}

  owns(item: DeskItemRow): boolean {
    return item.source === 'schedule';
  }

  /** A job isn't finished by hand: it runs again on its schedule. */
  async done(): Promise<{ outcome: 'n/a' }> {
    return { outcome: 'n/a' };
  }

  async reply(): Promise<{ ok: false; error: string }> {
    return { ok: false, error: 'A job doesn’t take replies. Ask its agent in its chat.' };
  }

  /** Run now: the bot starts the run and answers at once; the run lands on a later poll. */
  async runJob(item: DeskItemRow): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.ask(item, 'run');
  }

  async pauseJob(item: DeskItemRow, paused: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.ask(item, paused ? 'pause' : 'resume');
  }

  private async ask(item: DeskItemRow, verb: 'run' | 'pause' | 'resume'): Promise<{ ok: true } | { ok: false; error: string }> {
    const id = item.id.slice(PREFIX.length);
    const url = `${this.options.botUrl ?? 'http://127.0.0.1:9200'}/schedules/${encodeURIComponent(id)}/${verb}`;
    try {
      const res = await (this.options.fetch ?? fetch)(url, { method: 'POST', signal: AbortSignal.timeout(5000) });
      if (res.ok) return { ok: true };
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      // A bot from before these buttons answers every unknown path with its usage line.
      if (body?.error?.startsWith('Use GET')) return { ok: false, error: 'the bot needs a restart before it takes Run now and Pause' };
      return { ok: false, error: body?.error || `the bot answered ${res.status}` };
    } catch (err) {
      this.options.log?.('desk.schedules.bot.error', { verb, id, message: (err as Error).message });
      return { ok: false, error: 'couldn’t reach the bot' };
    }
  }

  private open(): DatabaseSync | null {
    if (this.db) return this.db;
    try {
      this.db = new DatabaseSync(this.options.dbPath, { readOnly: true });
    } catch (err) {
      this.options.log?.('desk.schedules.db.error', { message: (err as Error).message });
    }
    return this.db;
  }

  /** Never throws: a broken config or a database the bot hasn't set up yet is logged and tried again next time. */
  poll(): number {
    try {
      return this.pollOnce();
    } catch (err) {
      this.options.log?.('desk.schedules.poll.error', { message: (err as Error).message });
      return 0;
    }
  }

  private pollOnce(): number {
    const now = this.options.now?.() ?? Date.now();
    const { core } = this.options;
    let configs: ScheduleConfig[];
    let workerOwners: Map<string, string>;
    try {
      if (this.options.load) ({ configs, workerOwners } = this.options.load());
      else {
        const dir = this.options.configDir ?? resolveConfigDir();
        configs = loadScheduleConfigs(dir);
        workerOwners = new Map(loadWorkerConfigs(dir).filter((w) => w.ownerAgentId).map((w) => [w.id, w.ownerAgentId!]));
      }
    } catch (err) {
      this.options.log?.('desk.schedules.config.error', { message: (err as Error).message });
      return 0;
    }
    const jobs = readScheduleJobs({ configs, workerOwners, db: this.open(), now });
    const live = new Set(jobs.map((j) => `${PREFIX}${j.id}`));
    // A schedule that was removed, disabled or lost its agent: its job is finished, not left standing.
    for (const item of core.store.items()) {
      if (item.source !== 'schedule' || live.has(item.id) || core.store.attention(item.id)?.disposition === 'done') continue;
      core.settle(item.id, { done: true, summarize: false });
    }
    for (const job of jobs) {
      const itemId = `${PREFIX}${job.id}`;
      let before = core.store.item(itemId);
      // Its agent changed: an item's agent is fixed once made, so it is made again under the new one.
      if (before && before.agentId !== job.agentId) {
        core.store.deleteItem(itemId);
        before = null;
      }
      const agentName = job.agentId.charAt(0).toUpperCase() + job.agentId.slice(1);
      core.ensureItem({ id: itemId, source: 'schedule', kind: 'thread', conversationKey: itemId, agentId: job.agentId, agentName, place: job.title, area: 'Jobs', createdAt: before?.createdAt ?? job.lastRunAt ?? now }, 'agent');
      core.roles.follow(itemId, { role: 'ops', parentItemId: null });
      const failed = job.failures > 0 && job.lastStatus === 'error' ? { at: job.lastRunAt ?? now, reason: 'schedule', message: job.lastError || 'the last run failed' } : null;
      // Loom's hold on this job's newest run, kept by title (desk/job-holds.ts); none when another schedule shares it.
      const held = jobs.filter((other) => other.title === job.title).length === 1 ? jobHoldFor(core, job.title) : null;
      core.setFacts(itemId, { schedule: { every: job.every, lastRunAt: job.lastRunAt, nextRunAt: job.nextRunAt, paused: job.paused }, runs: job.runs, failed, held, lastAuthor: 'agent' }, {
        summary: summaryOf(job, job.lastRunAt ?? now),
        ...(job.lastRunAt ? { lastActivityAt: job.lastRunAt } : {}),
      });
      // A new run is news for its row (and a failure for its agent's page), never a summarizer call.
      if (!before || before.lastActivityAt !== (job.lastRunAt ?? before.lastActivityAt)) core.settle(itemId, { ...(job.lastRunAt ? { activity: { what: failed ? 'failed' : 'message', at: job.lastRunAt } } : {}), summarize: false });
    }
    core.flush();
    return jobs.length;
  }
}
