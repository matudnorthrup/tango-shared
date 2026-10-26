import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import {
  getJob,
  incidentHasOwnerWait,
  linkIncidentOwnerWait,
  refreshIncidentOwnerWaits,
  incidentRoute,
  jobAction,
  setJobState,
  listEvents,
  listIncidents,
  listJobs,
  listRuns,
  openLedger,
  readHealth,
  setIncidentStatus,
  stopProcess,
  systemSummary,
  takeDeskNotifications,
  type EventRow,
  type HealthSnapshot,
  type IncidentRow,
  type NotifyRoute,
  type JobRow,
  type Ledger,
  type RunRow,
  type Severity,
  type SystemContext,
  currentMode,
  setAway,
  setWorking,
  type ModeState,
} from '@tango/system';
import type { CapacitySnapshot } from './capacity.js';
import type { DeskCore, DeskSourceAdapter } from './core.js';
import { redactPaths } from './start-work.js';
import { boundedFixPrompt, readFix, readFixContext, startFix, writeFix, type FixStarters, type IncidentFixView } from './system-fix.js';
import type { DeskItemRow, DeskSummary, Log } from './types.js';

// The desk's System page (docs/specs/system-visibility.md "Desk: the System page"): the ledger every job,
// run, event and incident lands in (@tango/system), read for the page, and the owner's commands on it.
// Critical open incidents also become desk items (`system:incident:<id>`), so they show in the Inbox as
// Needs you; the other incidents' transitions are posts on the news feed (kind `system`).

export const SYSTEM_ITEM_PREFIX = 'system:incident:';
const CACHE_MS = 10_000;
const RESOLVED_DAYS = 7;
const EVENTS = 100;
const STRIP = 8;
const LOG_TAIL_BYTES = 4096;
/** One feed post per incident at most this often; a change of transition kind waits too (the feed folds the key). */
const FEED_THROTTLE_MS = 10 * 60_000;

export type SystemSummary = ReturnType<typeof systemSummary>;

/** An incident as the page reads it: with who hears about it (critical: Discord and Needs you; normal: the feed; quiet: this page). */
export type SystemIncident = IncidentRow & { route: NotifyRoute; kind: string | null; fix: IncidentFixView | null; question?: { itemId: string; text: string; requestId: string | null } | null };

/** A job's last runs, newest last (the page draws them oldest → newest), and what the latest one said. */
export interface JobRuns {
  strip: Array<RunRow['status']>;
  summary: string | null;
  durationMs: number | null;
}

function readWorkMode(): ModeState | null {
  try {
    return currentMode();
  } catch {
    return null;
  }
}

export interface SystemSnapshot {
  updatedAt: number;
  /** Why there's no reading (the ledger couldn't be opened or read); null when there is one. */
  error: string | null;
  summary: SystemSummary | null;
  health: HealthSnapshot | null;
  /** Active incidents, and the ones resolved in the last week, each with its route. */
  incidents: SystemIncident[];
  /** Managed and unmanaged jobs; retired ones only when asked. */
  jobs: JobRow[];
  runs: Record<string, JobRuns>;
  recentEvents: EventRow[];
  /** The Capacity page's snapshot (its tab), null when the desk has no capacity (no T3) or it failed. */
  capacity: CapacitySnapshot | null;
  /** Working or away (the Mac's big-job switch, @tango/system mode.ts). */
  workMode: ModeState | null;
}

export interface SystemJobDetail {
  job: JobRow;
  runs: RunRow[];
  incidents: IncidentRow[];
  /** The last 4 KB of its first log, secrets and home paths redacted; null when it has no readable log. */
  logTail: string | null;
  logPath: string | null;
}

export const SYSTEM_COMMANDS = ['incident.ack', 'incident.mute', 'incident.snooze', 'incident.unack', 'incident.fix', 'job.run', 'job.pause', 'job.resume', 'job.restart', 'job.retire', 'job.restore', 'process.stop', 'mode.away', 'mode.working'] as const;
export type SystemCommand = (typeof SYSTEM_COMMANDS)[number];
export const isSystemCommand = (type: unknown): type is SystemCommand => typeof type === 'string' && (SYSTEM_COMMANDS as readonly string[]).includes(type);

/** A command's answer: why it didn't go through (the Retry toast), or what it did; `outcome` goes to the page as is. */
export type SystemCommandResult = { ok: true; message: string; outcome?: Record<string, unknown> } | { ok: false; error: string; needsForce?: boolean };

export interface DeskSystemDeps {
  /** An open ledger (tests); else `path` (SCREEN_SYSTEM_DB), else the package's default. */
  ledger?: Ledger;
  path?: string;
  capacity?: { snapshot(): Promise<CapacitySnapshot> } | null;
  /** The desk, for critical incidents as items and the feed. Absent: the page only. */
  core?: DeskCore;
  /** A schedule's Run now and Pause go through the scheduler's own path (source-schedules.ts). */
  schedules?: {
    run(itemId: string): Promise<{ ok: true } | { ok: false; error: string }>;
    pause(itemId: string, paused: boolean): Promise<{ ok: true } | { ok: false; error: string }>;
  } | null;
  /**
   * `dry`: job and process actions answer as if done and touch nothing (no launchctl, tmux, Docker, bot or
   * signals): for a desk run against a copy of the ledger (SCREEN_SYSTEM_ACTIONS=dry). Incident commands still apply.
   */
  actions?: 'live' | 'dry';
  /** Fix on an incident: how its cleanup worker starts (system-fix.ts). Absent: Fix is refused with a reason. */
  fix?: FixStarters | null;
  /** What job and process actions touch (launchctl, tmux, Docker, the bot, signals); the package's default when absent. Tests pass a fake. */
  context?: SystemContext;
  log?: Log;
  now?: () => number;
}

/** Long tokens, keys and credentials in log text: replaced, never shown. */
const SECRETS: RegExp[] = [
  /\b(?:sk|pk|rk|xox[abpr]|ghp|gho|ghs|github_pat|glpat)[-_][A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:token|secret|password|passwd|api[_-]?key|authorization)\s*[=:]\s*["']?[^\s"',;]{6,}/gi,
  /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g, // Discord / JWT-shaped
  /\b[A-Fa-f0-9]{40,}\b/g,
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
];
/** Secrets only: for what stays on this machine (a fix worker's task needs the real paths). */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRETS) out = out.replace(re, '‹redacted›');
  return out;
}
export function redactLog(text: string): string {
  return redactPaths(redactSecrets(text));
}

/** Text from the ledger as the browser may see it: secrets and home paths redacted. */
function redactText<T extends string | null>(text: T): T {
  return (text == null ? text : redactLog(text)) as T;
}

/** Nested event data, redacted the same way (paths and command lines live in it). */
function redactData(data: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!data) return data;
  try {
    return JSON.parse(redactLog(JSON.stringify(data))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function publicEvent(e: EventRow): EventRow {
  return { ...e, title: redactText(e.title), detail: redactText(e.detail), data: redactData(e.data) };
}

export function publicIncident<T extends IncidentRow>(i: T): T {
  return { ...i, title: redactText(i.title) };
}

export function publicRun(r: RunRow): RunRow {
  return { ...r, summary: redactText(r.summary), outputTail: r.outputTail ? redactLog(r.outputTail) : null };
}

/** The end of a file: at most `bytes`, starting at a line boundary. */
export function tailFile(file: string, bytes = LOG_TAIL_BYTES): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

const isoMs = (iso: string | null | undefined) => (iso ? Date.parse(iso) || null : null);

/** A job as screens see it: no home directory in its paths (it names the machine's user). */
function publicJob(job: JobRow): JobRow {
  const facts = { ...job.facts };
  for (const key of ['cwd', 'command', 'cmd']) if (typeof facts[key] === 'string') facts[key] = redactPaths(facts[key] as string);
  return { ...job, source: job.source ? redactPaths(job.source) : null, logs: job.logs.map((p) => redactPaths(p)), archivePath: job.archivePath ? redactPaths(job.archivePath) : null, facts };
}

export class DeskSystem implements DeskSourceAdapter {
  private ledger: Ledger | null;
  private ledgerError: string | null = null;
  private cache: { at: number; retired: boolean; value: SystemSnapshot } | null = null;
  private inflight: Promise<SystemSnapshot> | null = null;
  private lastHash = '';
  private readonly listeners = new Set<(snapshot: SystemSnapshot) => void>();
  private readonly now: () => number;
  /** Fixes starting now, by incident: a double tap is one start. */
  private readonly fixing = new Map<number, Promise<SystemCommandResult>>();

  constructor(private readonly deps: DeskSystemDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.ledger = deps.ledger ?? null;
  }

  private log(event: string, data: Record<string, unknown>): void {
    this.deps.log?.(event, data);
  }

  /** The ledger, opened on first use; null (and why) when it can't be. */
  private open(): Ledger | null {
    if (this.ledger) return this.ledger;
    try {
      this.ledger = openLedger(this.deps.path ? { path: this.deps.path } : {});
      this.ledgerError = null;
    } catch (err) {
      this.ledgerError = redactPaths((err as Error).message);
      this.log('desk.system.error', { stage: 'open', message: this.ledgerError });
    }
    return this.ledger;
  }

  subscribe(listener: (snapshot: SystemSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The page's reading, at most ~10 s old (`fresh` reads now). Never throws: a broken ledger is an `error` and empty lists. */
  async snapshot({ fresh = false, retired = false }: { fresh?: boolean; retired?: boolean } = {}): Promise<SystemSnapshot> {
    const cached = this.cache;
    if (!fresh && cached && cached.retired === retired && this.now() - cached.at < CACHE_MS) return cached.value;
    if (!fresh && this.inflight) return this.inflight;
    const read = this.read(retired).finally(() => {
      if (this.inflight === read) this.inflight = null;
    });
    if (!fresh) this.inflight = read;
    const value = await read;
    this.cache = { at: this.now(), retired, value };
    return value;
  }

  private async read(retired: boolean): Promise<SystemSnapshot> {
    const capacity = this.deps.capacity
      ? this.deps.capacity.snapshot().catch((err) => {
          this.log('desk.system.error', { stage: 'capacity', message: redactPaths((err as Error).message) });
          return null;
        })
      : Promise.resolve(null);
    const base: SystemSnapshot = { updatedAt: this.now(), error: null, summary: null, health: null, incidents: [], jobs: [], runs: {}, recentEvents: [], capacity: null, workMode: readWorkMode() };
    const ledger = this.open();
    if (!ledger) return { ...base, error: this.ledgerError ?? 'the system ledger isn’t available', capacity: await capacity };
    const part = <T>(stage: string, fallback: T, fn: () => T): T => {
      try {
        return fn();
      } catch (err) {
        const message = redactPaths((err as Error).message);
        this.log('desk.system.error', { stage, message });
        base.error ??= message;
        return fallback;
      }
    };
    const summary = part('summary', null, () => systemSummary(ledger));
    const health = part('health', null, () => readHealth(ledger));
    // Each with its route, and the kind of its first event (the page keeps unmanaged processes in Jobs, not in the incident list).
    const incidents = part('incidents', [] as SystemIncident[], () => {
      const firstEvent = ledger.db.prepare('SELECT kind, data FROM events WHERE incident_id = ? ORDER BY id LIMIT 1');
      return listIncidents(ledger, { resolvedSinceDays: RESOLVED_DAYS }).map((i) => {
        const event = firstEvent.get(i.id) as { kind: string; data: string | null } | undefined;
        let question: SystemIncident['question'] = null;
        if (event?.kind === 'wait.question' && event.data) {
          try { question = JSON.parse(event.data).question ?? null; } catch { /* older event without metadata */ }
        }
        return { ...publicIncident(i), route: incidentRoute(ledger, i), kind: event?.kind ?? null, fix: this.fixView(ledger, i.id), ...(question ? { question } : {}) };
      });
    });
    const jobs = part('jobs', [] as JobRow[], () => listJobs(ledger, { includeRetired: retired }).map(publicJob));
    const runs: Record<string, JobRuns> = {};
    part('runs', null, () => {
      for (const job of jobs) {
        if (!job.managed) continue;
        const list = listRuns(ledger, job.id, STRIP);
        runs[job.id] = { strip: list.map((r) => r.status).reverse(), summary: redactText(list[0]?.summary ?? null), durationMs: list[0]?.durationMs ?? null };
      }
      return null;
    });
    const recentEvents = part('events', [] as EventRow[], () => listEvents(ledger, { limit: EVENTS }).map(publicEvent));
    return { ...base, summary, health, incidents, jobs, runs, recentEvents, capacity: await capacity };
  }

  /** One job's page: its runs, incidents, and the tail of its log. Null when there's no such job (or no ledger). */
  jobDetail(id: string): SystemJobDetail | null {
    const ledger = this.open();
    if (!ledger) return null;
    try {
      const job = getJob(ledger, id);
      if (!job) return null;
      const logPath = job.logs[0] ?? null;
      const tail = logPath ? tailFile(logPath) : null;
      return {
        job: publicJob(job),
        runs: listRuns(ledger, id, 50).map(publicRun),
        incidents: listIncidents(ledger, { status: 'all', jobId: id }).slice(0, 20).map(publicIncident),
        logTail: tail === null ? null : redactLog(tail),
        logPath: logPath ? redactPaths(logPath) : null,
      };
    } catch (err) {
      this.log('desk.system.error', { stage: 'job', message: redactPaths((err as Error).message) });
      return null;
    }
  }

  /** The raw stream, a page at a time (newest first). */
  events(filter: { beforeId?: number; severity?: Severity[]; source?: string; jobId?: string; limit?: number } = {}): EventRow[] {
    const ledger = this.open();
    if (!ledger) return [];
    try {
      return listEvents(ledger, { limit: filter.limit ?? EVENTS, ...filter }).map(publicEvent);
    } catch (err) {
      this.log('desk.system.error', { stage: 'events', message: redactPaths((err as Error).message) });
      return [];
    }
  }

  /** The owner's commands on the page. Resolves with why it didn't go through, for the Retry toast. */
  async command(type: SystemCommand, args: Record<string, unknown>): Promise<SystemCommandResult> {
    if (type === 'mode.away' || type === 'mode.working') return this.setMode(type, args);
    const ledger = this.open();
    if (!ledger) return { ok: false, error: this.ledgerError ?? 'the system ledger isn’t available' };
    try {
      const result = await this.apply(ledger, type, args);
      // Every screen reads again; the item and the feed follow now, not at the next tick.
      await this.tick();
      return result;
    } catch (err) {
      const error = redactPaths((err as Error).message);
      this.log('desk.system.error', { stage: 'command', type, message: error });
      return { ok: false, error };
    }
  }

  /** The "I'm away" button: no ledger needed. Every screen reads again so the pill follows at once. */
  private async setMode(type: 'mode.away' | 'mode.working', args: Record<string, unknown>): Promise<SystemCommandResult> {
    try {
      if (type === 'mode.working') setWorking();
      else {
        const hours = Number(args.hours);
        setAway({ hours: Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 7) : null });
      }
      this.cache = null;
      await this.tick();
      return { ok: true, message: type === 'mode.working' ? 'Working: big jobs wait.' : 'Away: big jobs may run.' };
    } catch (err) {
      return { ok: false, error: redactPaths((err as Error).message) };
    }
  }

  private async apply(ledger: Ledger, type: SystemCommand, args: Record<string, unknown>): Promise<SystemCommandResult> {
    if (type.startsWith('incident.')) {
      const id = Number(args.incidentId);
      if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'incidentId is required' };
      if (type === 'incident.fix') return this.fix(ledger, id);
      let until: string | undefined;
      if (type === 'incident.snooze') {
        const hours = Number(args.hours);
        const at = typeof args.until === 'string' ? Date.parse(args.until) : Number.isFinite(hours) && hours > 0 ? this.now() + hours * 3_600_000 : NaN;
        if (!Number.isFinite(at) || at <= this.now()) return { ok: false, error: 'snooze needs a time in the future (until or hours)' };
        until = new Date(at).toISOString();
      }
      const status = type === 'incident.ack' ? 'acked' : type === 'incident.mute' ? 'muted' : type === 'incident.snooze' ? 'snoozed' : 'open';
      const row = setIncidentStatus(ledger, id, status, until ? { until } : {});
      if (!row) return { ok: false, error: 'that incident is resolved or gone' };
      return { ok: true, message: `${row.title}: ${status === 'open' ? 'reopened' : status}` };
    }
    const jobId = typeof args.jobId === 'string' ? args.jobId : '';
    if (!jobId) return { ok: false, error: 'jobId is required' };
    const dry = this.deps.actions === 'dry';
    if (type === 'process.stop') {
      if (dry) return { ok: true, message: `(dry run) would stop ${getJob(ledger, jobId)?.name ?? jobId}` };
      const result = await stopProcess(ledger, jobId, this.deps.context);
      return result.ok ? { ok: true, message: result.message } : { ok: false, error: result.message };
    }
    const action = type.slice('job.'.length) as 'run' | 'pause' | 'resume' | 'restart' | 'retire' | 'restore';
    const job = getJob(ledger, jobId);
    if (!job) return { ok: false, error: `no job ${jobId}` };
    // A critical job is acted on only when the owner says so twice (the page's "Do it anyway").
    const force = args.force === true;
    if (job.criticality === 'critical' && !force && job.managed) return { ok: false, error: `${job.name} is critical. ${action[0]!.toUpperCase()}${action.slice(1)} it anyway?`, needsForce: true };
    if (dry) {
      // The ledger follows as the real action would leave it; nothing else is touched.
      if (action === 'pause' || action === 'resume') setJobState(ledger, jobId, action === 'pause' ? 'paused' : 'active');
      if (action === 'retire') setJobState(ledger, jobId, 'retired', { retireReason: typeof args.reason === 'string' ? args.reason.slice(0, 300) : null });
      if (action === 'restore') setJobState(ledger, jobId, 'active');
      return { ok: true, message: `(dry run) ${action} ${job.name}` };
    }
    // A schedule's Run now and Pause are the scheduler's own (the bot), as from its row on an agent's page.
    if (job.runner === 'schedule' && this.deps.schedules && (action === 'run' || action === 'pause' || action === 'resume')) {
      const itemId = job.id.startsWith('schedule:') ? job.id : `schedule:${job.id}`;
      const result = action === 'run' ? await this.deps.schedules.run(itemId) : await this.deps.schedules.pause(itemId, action === 'pause');
      if (!result.ok) return result;
      // The ledger follows (the tick sees the pause too, but the page shouldn't wait for it).
      if (action !== 'run') setJobState(ledger, jobId, action === 'pause' ? 'paused' : 'active');
      return { ok: true, message: action === 'run' ? `Started ${job.name}.` : `${action === 'pause' ? 'Paused' : 'Resumed'} ${job.name}.` };
    }
    const reason = typeof args.reason === 'string' ? args.reason.slice(0, 300) : undefined;
    const result = await jobAction(ledger, jobId, action, { ...(reason ? { reason } : {}), ...(force ? { force } : {}) }, this.deps.context);
    return result.ok ? { ok: true, message: result.message } : { ok: false, error: result.message };
  }

  /** The fix in progress on an incident, as a page reads it (its thread, and whether that thread is finished). */
  private fixView(ledger: Ledger, incidentId: number): IncidentFixView | null {
    const fix = readFix(ledger, incidentId);
    if (!fix) return null;
    return { itemId: fix.itemId, at: fix.at, via: fix.via, done: this.deps.core?.store.attention(fix.itemId)?.disposition === 'done' };
  }

  /**
   * Fix: a cleanup worker for the incident (system-fix.ts). One per incident while it runs: a second tap, or
   * a retry, gets the same thread; once that thread is finished and the incident is still open, a tap starts the next.
   */
  private async fix(ledger: Ledger, incidentId: number): Promise<SystemCommandResult> {
    const running = this.fixing.get(incidentId);
    if (running) return running;
    const attempt = this.startFixFor(ledger, incidentId).finally(() => this.fixing.delete(incidentId));
    this.fixing.set(incidentId, attempt);
    return attempt;
  }

  private async startFixFor(ledger: Ledger, incidentId: number): Promise<SystemCommandResult> {
    const incident = listIncidents(ledger, { status: 'all' }).find((i) => i.id === incidentId);
    if (!incident || incident.status === 'resolved') return { ok: false, error: 'that incident is resolved or gone' };
    const earlier = readFix(ledger, incidentId);
    const earlierDone = earlier ? this.deps.core?.store.attention(earlier.itemId)?.disposition === 'done' : false;
    if (earlier && !earlierDone) return { ok: true, message: 'A fix is already under way.', outcome: { itemId: earlier.itemId, via: earlier.via, already: true } };
    if (!this.deps.fix || !this.deps.core) return { ok: false, error: 'this desk can’t start a fix (no way to start threads here)' };
    const attempt = earlier ? earlier.attempt + 1 : 1;
    const kind = ((ledger.db.prepare('SELECT kind FROM events WHERE incident_id = ? ORDER BY id LIMIT 1').get(incidentId) as { kind?: string } | undefined)?.kind) ?? null;
    const prompt = boundedFixPrompt(readFixContext(ledger, incident, kind, (file, bytes) => tailFile(file, bytes)), redactSecrets);
    const title = `Fix: ${redactLog(incident.title)}`.replace(/\s+/g, ' ').slice(0, 80);
    const started = await startFix(this.deps.core, this.deps.fix, { prompt, title, commandId: `fix-incident-${incidentId}${attempt > 1 ? `-${attempt}` : ''}` });
    if (!started.ok) return { ok: false, error: redactPaths(started.error) };
    writeFix(ledger, incidentId, { itemId: started.itemId, at: new Date(this.now()).toISOString(), attempt, via: started.via });
    this.log('desk.system.fix', { incidentId, itemId: started.itemId, via: started.via, attempt });
    const message = started.via === 'worker' ? 'Started a worker on it. It reports to the Tango lead.' : `Started a thread on it: ${started.note}.`;
    return { ok: true, message, outcome: { itemId: started.itemId, via: started.via } };
  }

  /**
   * Every 30 s (setup.ts): a fresh reading; critical incidents as desk items; the others' transitions on the
   * feed; and a `system` event to the open pages when anything changed. Never throws.
   */
  async tick(): Promise<SystemSnapshot> {
    const ledger = this.open();
    const core = this.deps.core;
    try {
      if (ledger && core) {
        // A Fix worker's explicit owner ask replaces the incident's generic ask.
        for (const inc of listIncidents(ledger)) {
          const fix = readFix(ledger, inc.id);
          if (fix && this.ownerWaiting(fix.itemId) === true) linkIncidentOwnerWait(ledger, inc.id, fix.itemId, { automatic: true });
        }
        refreshIncidentOwnerWaits(ledger, (itemId) => this.ownerWaiting(itemId));
      }
    } catch (err) {
      this.log('desk.system.error', { stage: 'owner-wait', message: redactPaths((err as Error).message) });
    }
    const snapshot = await this.snapshot({ fresh: true });
    try {
      this.syncItems(snapshot);
      this.postFeed();
    } catch (err) {
      this.log('desk.system.error', { stage: 'tick', message: redactPaths((err as Error).message) });
    }
    const hash = createHash('sha1')
      .update(JSON.stringify([snapshot.error, snapshot.summary, snapshot.incidents, snapshot.jobs, snapshot.runs, snapshot.recentEvents[0]?.id ?? null, snapshot.workMode ? [snapshot.workMode.mode, snapshot.workMode.source, snapshot.workMode.until] : null, snapshot.health ? { ...snapshot.health, checkedAt: null } : null]))
      .digest('base64url');
    if (hash !== this.lastHash) {
      this.lastHash = hash;
      for (const listener of this.listeners) listener(snapshot);
    }
    return snapshot;
  }

  private ownerWaiting(itemId: string): boolean | null {
    const item = this.deps.core?.item(itemId);
    if (!item) return null; // A missing source is not an answered request.
    if (item.disposition === 'done') return false;
    const ownerAsk = item.facts.openAsk && !item.facts.openAsk.to;
    return !!(ownerAsk || item.facts.pending || item.facts.openBrief);
  }

  /** Critical open incidents are Needs you in the Inbox; one that's held or gone is settled. */
  private syncItems(snapshot: SystemSnapshot): void {
    const core = this.deps.core;
    if (!core || snapshot.error && !snapshot.incidents.length) return;
    const now = this.now();
    const live = new Map<string, SystemIncident>();
    for (const incident of snapshot.incidents) if (incident.route === 'critical' && incident.status === 'open' && !(this.ledger && incidentHasOwnerWait(this.ledger, incident))) live.set(`${SYSTEM_ITEM_PREFIX}${incident.id}`, incident);
    // Held (acked, muted, snoozed), resolved or gone: done. A snoozed one that comes back reopens below.
    for (const item of core.store.items()) {
      if (!this.owns(item) || live.has(item.id) || core.store.attention(item.id)?.disposition === 'done') continue;
      core.setFacts(item.id, { failed: null });
      core.settle(item.id, { done: true, summarize: false });
    }
    for (const [itemId, incident] of live) {
      const before = core.store.item(itemId);
      const lastSeen = isoMs(incident.lastSeen) ?? now;
      // Repeat evidence updates counts, not attention, unread state or voice knock identity.
      const rank = { recovery: 0, info: 1, warning: 2, error: 3, critical: 4 };
      const previousSeverity = before?.facts.system?.severity as Severity | undefined;
      const escalated = previousSeverity != null && rank[incident.severity] > rank[previousSeverity];
      const activityAt = escalated ? lastSeen : before?.lastActivityAt ?? isoMs(incident.firstSeen) ?? now;
      const job = incident.jobId ? snapshot.jobs.find((j) => j.id === incident.jobId) : null;
      core.ensureItem({ id: itemId, source: 'system', kind: 'thread', conversationKey: itemId, agentId: 'system', agentName: 'System', place: incident.title, area: 'System', createdAt: before?.createdAt ?? isoMs(incident.firstSeen) ?? now }, 'agent');
      core.roles.follow(itemId, { role: 'default', parentItemId: null });
      const message = `${incident.count}× since ${new Date(isoMs(incident.firstSeen) ?? now).toISOString().slice(0, 16).replace('T', ' ')}${job ? ` · ${job.name}` : ''}`;
      core.setFacts(itemId, { failed: { at: activityAt, reason: 'system', message: incident.title }, lastAuthor: 'agent', system: { incidentId: incident.id, jobId: incident.jobId, count: incident.count, severity: incident.severity, fix: incident.fix && !incident.fix.done ? { itemId: incident.fix.itemId } : null } }, { summary: incidentSummary(incident, message, activityAt), lastActivityAt: activityAt });
      const done = core.store.attention(itemId)?.disposition === 'done';
      // Only new or reopened asks renew attention; retries remain in the ledger.
      if (!before || done || escalated) core.settle(itemId, { activity: { what: 'failed', at: done ? Math.max(now, lastSeen) : lastSeen }, summarize: false });
    }
    core.flush();
  }

  private postFeed(): void {
    const core = this.deps.core;
    const ledger = this.ledger;
    if (!core || !ledger) return;
    for (const { incident, transition } of takeDeskNotifications(ledger)) {
      const word = { opened: 'New problem', escalated: 'Got worse', regressed: 'Came back', reminder: 'Still open', resolved: 'Resolved' }[transition];
      core.postFeed({
        kind: 'system',
        title: redactText(incident.title),
        text: `${word} · ${incident.count}× since ${incident.firstSeen.slice(0, 16).replace('T', ' ')}`,
        agentName: 'System',
        key: `incident:${incident.id}`,
        throttleMs: FEED_THROTTLE_MS,
        data: { incidentId: incident.id, jobId: incident.jobId, severity: incident.severity, transition },
      });
    }
  }

  // ── the items' adapter: a critical incident's row in the Inbox ──
  owns(item: DeskItemRow): boolean {
    return item.source === 'system' && !item.facts.phoneNote;
  }

  /** Done on its row acknowledges it: it stays listed on the System page, with no more reminders. */
  async done(item: DeskItemRow): Promise<{ outcome: 'n/a' }> {
    const ledger = this.open();
    const id = Number(item.id.slice(SYSTEM_ITEM_PREFIX.length));
    if (ledger && Number.isInteger(id)) {
      try {
        setIncidentStatus(ledger, id, 'acked');
      } catch (err) {
        this.log('desk.system.error', { stage: 'done', message: redactPaths((err as Error).message) });
      }
    }
    return { outcome: 'n/a' };
  }

  async reply(): Promise<{ ok: false; error: string }> {
    return { ok: false, error: 'An incident doesn’t take replies. Open the System page to acknowledge, mute or snooze it.' };
  }

  /** What the voice operator says to "what's broken?": the line, then the critical and open incidents' titles. */
  async brief(): Promise<{ line: string; critical: string[]; open: string[]; error: string | null }> {
    const snap = await this.snapshot();
    const active = snap.incidents.filter((i) => i.status === 'open');
    return {
      line: snap.summary?.line ?? (snap.error ? 'The system ledger isn’t answering.' : 'No reading yet.'),
      critical: active.filter((i) => i.route === 'critical').map((i) => i.title).slice(0, 5),
      open: active.filter((i) => i.route === 'normal').map((i) => i.title).slice(0, 8),
      error: snap.error,
    };
  }

  close(): void {
    if (!this.deps.ledger) this.ledger?.close();
    this.ledger = null;
  }
}

// A critical incident is the owner's move (docs/specs/system-visibility.md, Notification): it sits in the
// Inbox as Needs you until it is acked, muted, snoozed or resolves.
function incidentSummary(incident: IncidentRow, message: string, at: number): DeskSummary {
  return { title: incident.title, gist: message, headline: incident.title, step: 'your_move', ask: 'Fix, ack, mute or snooze it on the System page.', options: [], context: [], ownerAsk: null, watchUntil: null, ackOnly: false, waitingOn: null, source: 'text', contentKey: `incident:${incident.id}:${at}`, at };
}
