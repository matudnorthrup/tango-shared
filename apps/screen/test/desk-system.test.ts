import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultContext, linkIncidentOwnerWait, listIncidents, loadAnnotations, openLedger, recordEvent, recordRun, setCursor, setJobState, upsertJob, type Ledger, type SystemContext } from '@tango/system';
import { DeskFeed } from '../server/desk/feed.js';
import { registerDeskRoutes } from '../server/desk/routes.js';
import { deskStatus } from '../server/desk/status.js';
import { DeskSystem, redactLog, SYSTEM_ITEM_PREFIX, tailFile } from '../server/desk/system.js';
import { makeHarness, type Harness } from './desk-harness.js';
// @ts-expect-error plain browser module, no types
import { predictSystem } from '../public/desk/optimistic.js';
// @ts-expect-error plain browser module, no types
import { foldEvents, jobHealth, lede, stripCells, systemChip } from '../public/desk/next/system-model.js';
// @ts-expect-error plain browser module, no types
import { createSystemFixture } from '../public/desk/system-fixture.js';

// The System page (docs/specs/system-visibility.md): the desk's side of the system ledger. The ledger itself
// (@tango/system) is real SQLite in a temp dir; what its job actions touch (launchctl, the bot, signals) is a fake.

let dir: string;
let ledger: Ledger;
let h: Harness;
let feed: DeskFeed;
let calls: string[];
let context: SystemContext;

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const PULL = 'launchd:com.example.health-pull';
const STALE = 'launchd:com.example.stale';

function seed() {
  upsertJob(ledger, { id: PULL, runner: 'launchd', name: 'health-pull', group: 'Health', cadence: 'Every 15 min', cadenceSeconds: 900, criticality: 'critical', lastRunAt: iso(5 * 60_000), lastStatus: 'failed', logs: [path.join(dir, 'pull.log')] });
  upsertJob(ledger, { id: 'schedule:brief', runner: 'schedule', name: 'Daily Brief', owner: 'watson', group: 'Watson', cadence: 'Daily 05:00', cadenceSeconds: 86400, lastRunAt: iso(3_600_000), lastStatus: 'ok' });
  upsertJob(ledger, { id: STALE, runner: 'launchd', name: 'stale build', managed: false, facts: { cpu: 31, pid: 4242, startedAt: 'Sat Oct 17 06:00:00 2026' } });
  for (const [k, status] of (['ok', 'quiet', 'ok'] as const).entries()) recordRun(ledger, { jobId: PULL, startedAt: iso(60_000 * (40 - k * 10)), status, durationMs: 1200, summary: status === 'ok' ? 'Pulled 214 samples' : 'Nothing new' });
  recordEvent(ledger, { source: 'tango-run', jobId: PULL, kind: 'run.failed', severity: 'error', title: 'Exited 1: Health store locked' });
  recordEvent(ledger, { source: 'tango-run', jobId: PULL, kind: 'run.failed', severity: 'error', title: 'Exited 1: Health store locked' });
  recordEvent(ledger, { source: 'scheduler', jobId: 'schedule:brief', kind: 'delivery.failed', severity: 'error', title: 'Delivery failed: channel not found' });
  setCursor(ledger, 'health', JSON.stringify({ checkedAt: new Date().toISOString(), services: [{ id: 'bot', name: 'Bot', ok: true, detail: 'up', since: iso(3 * 3_600_000) }, { id: 'loom', name: 'Loom', ok: false, detail: 'not answering', since: null }], machine: { load1: 40, load5: 47, cores: 24, memUsedGb: 41, memTotalGb: 64, diskUsedPct: 83, diskFreeGb: 154 } }));
}

function system(extra: Partial<ConstructorParameters<typeof DeskSystem>[0]> = {}) {
  return new DeskSystem({ ledger, core: h.core, context, capacity: { snapshot: async () => ({ updatedAt: 1, loom: true, moves: false, accounts: [], rules: { default: [], repos: [], error: null }, machine: null }) }, ...extra });
}
const critical = () => listIncidents(ledger).find((i) => i.jobId === PULL)!;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-system-'));
  ledger = openLedger({ path: path.join(dir, 'system.sqlite') });
  feed = new DeskFeed(new DatabaseSync(path.join(dir, 'feed.db')), () => Date.now());
  h = makeHarness({ feed, now: () => Date.now() });
  calls = [];
  context = defaultContext(loadAnnotations([]), {
    exec: async (cmd, args) => (calls.push([cmd, ...args].join(' ')), { code: 0, stdout: '', stderr: '', timedOut: false }),
    fetch: async (url) => (calls.push(`fetch ${url}`), { status: 200, text: '{}' }),
    kill: (pid, signal) => void calls.push(`kill ${pid} ${signal}`),
    sleep: async () => {},
    homeDir: dir,
    repoDir: dir,
    profileDir: dir,
    dataDir: dir,
  });
});
afterEach(() => {
  h.close();
  ledger.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the System snapshot', () => {
  it('exposes the original question even after its event leaves the recent-event window', async () => {
    recordEvent(ledger, { source: 'wait-keeper', kind: 'wait.question', severity: 'warning', title: 'Question waiting for you: Worker', identity: 'question:loom:worker:q1', data: { question: { itemId: 'loom:worker', text: 'Choose a direction', requestId: 'q1' } } });
    for (let i = 0; i < 110; i++) recordEvent(ledger, { source: 'test', kind: 'note', severity: 'info', title: `Unrelated event ${i}` });
    const snap = await system().snapshot();
    expect(snap.incidents.find((i) => i.kind === 'wait.question')?.question).toEqual({ itemId: 'loom:worker', text: 'Choose a direction', requestId: 'q1' });
  });
  it('puts the summary, health, incidents with their routes, jobs with their run strips, events and capacity together', async () => {
    seed();
    const snap = await system().snapshot();
    expect(snap.error).toBeNull();
    expect(snap.summary).toMatchObject({ critical: 1, open: 1, unmanaged: 1 });
    expect(snap.health?.services.map((s) => s.id)).toEqual(['bot', 'loom']);
    // A critical job's error is critical; the schedule's goes to the feed.
    expect(snap.incidents.map((i) => [i.jobId, i.route, i.count])).toEqual(expect.arrayContaining([[PULL, 'critical', 2], ['schedule:brief', 'normal', 1]]));
    expect(snap.jobs.map((j) => j.id).sort()).toEqual([PULL, STALE, 'schedule:brief']);
    // Oldest → newest, as the strip draws them; the latest run's words.
    expect(snap.runs[PULL]).toMatchObject({ strip: ['ok', 'quiet', 'ok'], summary: 'Pulled 214 samples' });
    expect(snap.recentEvents.length).toBeGreaterThanOrEqual(3);
    expect(snap.capacity).toMatchObject({ loom: true });
  });

  it('is cached for a few seconds, leaves retired jobs out unless asked, and never throws on a broken ledger', async () => {
    seed();
    const s = system();
    const first = await s.snapshot();
    upsertJob(ledger, { id: 'schedule:old', runner: 'schedule', name: 'Old report' });
    setJobState(ledger, 'schedule:old', 'retired');
    expect(await s.snapshot()).toBe(first);
    expect((await s.snapshot({ fresh: true })).jobs.some((j) => j.id === 'schedule:old')).toBe(false);
    expect((await s.snapshot({ fresh: true, retired: true })).jobs.some((j) => j.id === 'schedule:old')).toBe(true);
    const logs: string[] = [];
    ledger.db.exec('DROP TABLE runs');
    const bad = await new DeskSystem({ ledger, log: (e) => logs.push(e) }).snapshot();
    expect(bad.error).toBeTruthy();
    expect(bad.jobs.length).toBeGreaterThan(0);
    expect(logs).toContain('desk.system.error');
    fs.writeFileSync(path.join(dir, 'not-a-db'), 'nope');
    const broken = await new DeskSystem({ path: path.join(dir, 'not-a-db', 'x.sqlite'), log: (e) => logs.push(e) }).snapshot();
    expect(broken.error).toBeTruthy();
    expect(broken.incidents).toEqual([]);
  });

  it('reads a job’s page with its log tail, secrets and home paths redacted', () => {
    seed();
    fs.writeFileSync(path.join(dir, 'pull.log'), `${'x'.repeat(5000)}\nstart token=abcdef123456 in ${os.homedir()}/code\nERROR Bearer abcdefghijklmnopqrstuvwxyz\n`);
    const detail = system().jobDetail(PULL)!;
    expect(detail.runs).toHaveLength(3);
    expect(detail.incidents).toHaveLength(1);
    expect(detail.logTail).not.toContain('abcdef123456');
    expect(detail.logTail).not.toContain(os.homedir());
    expect(detail.logTail).toContain('‹redacted›');
    expect(detail.logTail).toContain('~/code');
    expect(detail.logTail!.length).toBeLessThanOrEqual(4096);
    expect(system().jobDetail('nope')).toBeNull();
    expect(tailFile(path.join(dir, 'missing.log'))).toBeNull();
    expect(redactLog('mail me at someone@example.com')).toBe('mail me at ‹redacted›');
  });

  it('redacts home paths and secrets in incidents, events and their data before serving them', async () => {
    seed();
    const home = os.homedir();
    recordEvent(ledger, {
      source: 'tick', jobId: PULL, kind: 'process.unmanaged', severity: 'info',
      title: `Unmanaged: node ${home}/scratch/serve.mjs`, detail: `node ${home}/scratch/serve.mjs --token=abcdef123456`,
      data: { command: `node ${home}/scratch/serve.mjs`, nested: { file: `${home}/logs/a.log` } },
    });
    const snap = await system().snapshot();
    const served = JSON.stringify({ incidents: snap.incidents, events: snap.recentEvents, page: system().jobDetail(PULL), stream: system().events({}) });
    expect(served).not.toContain(home);
    expect(served).not.toContain('abcdef123456');
    expect(served).toContain('~/scratch/serve.mjs');
  });
});

describe('System commands', () => {
  it('acks, mutes, snoozes and reopens incidents; refuses what it can’t do with a reason', async () => {
    seed();
    const s = system();
    const crit = critical();
    expect(await s.command('incident.ack', { incidentId: crit.id })).toMatchObject({ ok: true });
    expect(listIncidents(ledger).find((i) => i.id === crit.id)?.status).toBe('acked');
    expect(await s.command('incident.unack', { incidentId: crit.id })).toMatchObject({ ok: true });
    expect(await s.command('incident.snooze', { incidentId: crit.id, hours: 4 })).toMatchObject({ ok: true });
    expect(listIncidents(ledger).find((i) => i.id === crit.id)?.snoozedUntil).toBeTruthy();
    expect(await s.command('incident.snooze', { incidentId: crit.id, until: '2001-01-01T00:00:00Z' })).toMatchObject({ ok: false });
    expect(await s.command('incident.mute', { incidentId: 9999 })).toEqual({ ok: false, error: 'that incident is resolved or gone' });
    expect(await s.command('job.run', {})).toEqual({ ok: false, error: 'jobId is required' });
  });

  it('asks before acting on a critical job, then does it with force', async () => {
    seed();
    const s = system();
    expect(await s.command('job.restart', { jobId: PULL })).toEqual({ ok: false, error: 'health-pull is critical. Restart it anyway?', needsForce: true });
    expect(calls).toEqual([]);
    expect(await s.command('job.restart', { jobId: PULL, force: true })).toMatchObject({ ok: true });
    expect(calls.some((c) => c.startsWith('launchctl kickstart -k'))).toBe(true);
  });

  it('sends a schedule’s Run now and Pause to the scheduler; stops an unmanaged process; a dry desk touches nothing', async () => {
    seed();
    const asked: string[] = [];
    const s = system({ schedules: { run: async (id) => (asked.push(`run ${id}`), { ok: true }), pause: async (id, paused) => (asked.push(`${paused ? 'pause' : 'resume'} ${id}`), { ok: true }) } });
    await s.command('job.run', { jobId: 'schedule:brief' });
    await s.command('job.pause', { jobId: 'schedule:brief' });
    expect(asked).toEqual(['run schedule:brief', 'pause schedule:brief']);
    expect((await s.snapshot({ fresh: true })).jobs.find((j) => j.id === 'schedule:brief')?.state).toBe('paused');
    const refused = system({ schedules: { run: async () => ({ ok: false, error: 'couldn’t reach the bot' }), pause: async () => ({ ok: true }) } });
    expect(await refused.command('job.run', { jobId: 'schedule:brief' })).toEqual({ ok: false, error: 'couldn’t reach the bot' });
    // The fake ps says it's gone: nothing to signal, and the row goes.
    expect(await s.command('process.stop', { jobId: STALE })).toMatchObject({ ok: true });
    expect((await s.snapshot({ fresh: true })).jobs.some((j) => j.id === STALE)).toBe(false);
    expect(await s.command('process.stop', { jobId: 'schedule:brief' })).toMatchObject({ ok: false });
    calls = [];
    const dry = system({ actions: 'dry' });
    expect(await dry.command('job.retire', { jobId: 'schedule:brief', reason: 'Nobody reads it.' })).toMatchObject({ ok: true });
    expect((await dry.snapshot({ fresh: true, retired: true })).jobs.find((j) => j.id === 'schedule:brief')).toMatchObject({ state: 'retired', retireReason: 'Nobody reads it.' });
    expect(await dry.command('job.restore', { jobId: 'schedule:brief' })).toMatchObject({ ok: true });
    expect((await dry.snapshot({ fresh: true })).jobs.find((j) => j.id === 'schedule:brief')?.state).toBe('active');
    expect(calls).toEqual([]);
  });
});

describe('Fix on an incident', () => {
  const TANGO = { id: 'tango', name: 'Tango', icon: null, color: null, createdAt: 1 };
  let starts: Array<Record<string, unknown>>;
  let direct: Array<Record<string, unknown>>;
  let refuse: string | null;

  /** A fake desk mail (mail.ts start): one thread per commandId, as the real one keeps them. */
  const mail = {
    start: async (request: Record<string, unknown>) => {
      if (refuse) return { ok: false as const, error: refuse };
      const earlier = starts.find((r) => r.commandId === request.commandId);
      if (!earlier) starts.push(request);
      return { ok: true as const, itemId: `loom:fix-${starts.findIndex((r) => r.commandId === request.commandId) + 1}` };
    },
  };
  const startWork = { start: async (request: Record<string, unknown>) => (direct.push(request), { ok: true as const, threadId: 'th', itemId: 'loom:thread-1', plan: {} as never }) };
  const fixer = (extra: Partial<ConstructorParameters<typeof DeskSystem>[0]> = {}) => system({ fix: { mail, startWork }, ...extra });

  function tangoDefault(id = 'loom:tango-lead') {
    h.core.store.setSetting('projects', JSON.stringify([TANGO]));
    h.core.ensureItem({ id, source: 'loom', kind: 'thread', conversationKey: id, agentId: 'claude', agentName: 'Claude', place: 'Tango lead', createdAt: Date.now() }, 'agent');
    h.core.roles.set(id, { role: 'default', parentItemId: null }, 'owner', Date.now());
    h.core.assignProject(id, 'tango');
    return id;
  }

  beforeEach(() => {
    starts = [];
    direct = [];
    refuse = null;
  });

  it('starts one worker under the Tango default with the incident’s whole story, real paths and no secrets; a second tap is the same thread', async () => {
    seed();
    const lead = tangoDefault();
    const home = os.homedir();
    upsertJob(ledger, { id: PULL, runner: 'launchd', name: 'health-pull', source: `${home}/Library/LaunchAgents/com.example.health-pull.plist`, logs: [path.join(dir, 'pull.log')] });
    fs.writeFileSync(path.join(dir, 'pull.log'), `${'x'.repeat(3000)}\nopening ${home}/data/health.db token=abcdef123456\nERROR database is locked\n`);
    const s = fixer();
    const crit = critical();
    const first = await s.command('incident.fix', { incidentId: crit.id });
    expect(first).toMatchObject({ ok: true, outcome: { itemId: 'loom:fix-1', via: 'worker' } });
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ from: lead, repo: 'tango', projectId: 'tango', role: 'worker', report: true, commandId: `fix-incident-${crit.id}`, title: 'Fix: Exited 1: Health store locked' });
    const prompt = String(starts[0]!.prompt);
    for (const part of [`#${crit.id}`, 'Exited 1: Health store locked', 'Severity: error', 'Seen 2×', PULL, 'Every 15 min', 'criticality: critical', `${home}/Library/LaunchAgents/com.example.health-pull.plist`, path.join(dir, 'pull.log'), 'Pulled 214 samples', 'ERROR database is locked', `${home}/data/health.db`, 'docs/specs/system-visibility.md', `--kind run.ok --severity recovery --job ${PULL}`]) expect(prompt).toContain(part);
    expect(prompt).not.toContain('abcdef123456');
    expect(prompt.length).toBeLessThanOrEqual(7800);
    // Evidence is fenced as untrusted, ahead of the task; the recovery closes only this incident.
    // The intro sentence names both markers; the block itself is their last occurrences.
    const open = prompt.lastIndexOf('<<<UNTRUSTED EVIDENCE');
    const close = prompt.lastIndexOf('UNTRUSTED EVIDENCE>>>');
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    expect(prompt.indexOf('ERROR database is locked')).toBeGreaterThan(open);
    expect(prompt.indexOf('ERROR database is locked')).toBeLessThan(close);
    expect(prompt.indexOf('## What to do')).toBeGreaterThan(close);
    expect(prompt).toContain('--resolves-kind run.failed --resolves-title ');
    // Tapped again (or retried): the same thread, nothing new started.
    expect(await s.command('incident.fix', { incidentId: crit.id })).toMatchObject({ ok: true, outcome: { itemId: 'loom:fix-1', already: true } });
    const [a, b] = await Promise.all([fixer().command('incident.fix', { incidentId: crit.id }), fixer().command('incident.fix', { incidentId: crit.id })]);
    expect([a, b]).toMatchObject([{ ok: true, outcome: { itemId: 'loom:fix-1' } }, { ok: true, outcome: { itemId: 'loom:fix-1' } }]);
    expect(starts).toHaveLength(1);
    // The page reads it as under way, with home paths still kept from the browser.
    const snap = await s.snapshot({ fresh: true });
    expect(snap.incidents.find((i) => i.id === crit.id)?.fix).toMatchObject({ itemId: 'loom:fix-1', via: 'worker', done: false });
    expect(snap.incidents.find((i) => i.jobId === 'schedule:brief')?.fix).toBeNull();
    expect(JSON.stringify(snap)).not.toContain(home);
    // The Inbox item of a critical incident knows the fix too.
    expect(h.core.item(`${SYSTEM_ITEM_PREFIX}${crit.id}`)?.facts.system).toMatchObject({ fix: { itemId: 'loom:fix-1' } });
  });

  it('starts the next fix once the last one finished and the incident is still open', async () => {
    seed();
    tangoDefault();
    const s = fixer();
    const crit = critical();
    await s.command('incident.fix', { incidentId: crit.id });
    h.core.ensureItem({ id: 'loom:fix-1', source: 'loom', kind: 'thread', conversationKey: 'loom:fix-1', agentId: 'claude', agentName: 'Claude', createdAt: Date.now() }, 'agent');
    h.core.settle('loom:fix-1', { done: true, summarize: false });
    expect((await s.snapshot({ fresh: true })).incidents.find((i) => i.id === crit.id)?.fix?.done).toBe(true);
    expect(await s.command('incident.fix', { incidentId: crit.id })).toMatchObject({ ok: true, outcome: { itemId: 'loom:fix-2' } });
    expect(starts.map((r) => r.commandId)).toEqual([`fix-incident-${crit.id}`, `fix-incident-${crit.id}-2`]);
  });

  it('with no Tango default, starts a thread of its own in the Tango project and says so', async () => {
    seed();
    h.core.store.setSetting('projects', JSON.stringify([TANGO]));
    const s = fixer();
    const result = await s.command('incident.fix', { incidentId: critical().id });
    expect(result).toMatchObject({ ok: true, outcome: { itemId: 'loom:thread-1', via: 'thread' } });
    expect(result.ok && result.message).toMatch(/Tango has no default conversation/);
    expect(starts).toHaveLength(0);
    expect(direct[0]).toMatchObject({ repo: 'tango', role: 'interactive', account: 'loom', commandId: `fix-incident-${critical().id}` });
    expect(String(direct[0]!.prompt)).toContain('Exited 1: Health store locked');
    expect((await s.snapshot({ fresh: true })).incidents.find((i) => i.jobId === PULL)?.fix).toMatchObject({ itemId: 'loom:thread-1', via: 'thread' });
    // The project's name or id comes from the setting (or SCREEN_SYSTEM_FIX_PROJECT) when it isn't called Tango.
    h.core.store.setSetting('projects', JSON.stringify([{ ...TANGO, id: 'p1', name: 'Home lab' }]));
    tangoDefault();
    h.core.store.setSetting('projects', JSON.stringify([{ ...TANGO, id: 'p1', name: 'Home lab' }, TANGO]));
    h.core.store.setSetting('system_fix_project', 'Home lab');
    const other = recordEvent(ledger, { source: 'scheduler', jobId: 'schedule:brief', kind: 'delivery.failed', severity: 'error', title: 'Another one' });
    expect(await s.command('incident.fix', { incidentId: other.incidentId })).toMatchObject({ outcome: { via: 'thread' } });
    expect(direct.at(-1)!.prompt).toContain('--kind delivery.ok');
  });

  it('fails with a reason the Retry toast shows: a refused start, a resolved incident, no way to start threads', async () => {
    seed();
    tangoDefault();
    refuse = 'the owner switched agent mail (and starting threads) off for this conversation';
    const a = new Hono();
    registerDeskRoutes(a, { core: h.core, scenes: () => [], system: fixer() });
    const post = (body: unknown) => a.request('/api/desk/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    expect(await post({ commandId: 'f1', type: 'incident.fix', args: { incidentId: critical().id } })).toMatchObject({ status: 'failed', error: refuse });
    expect(readFixCursor(critical().id)).toBeNull();
    refuse = null;
    expect(await post({ commandId: 'f2', type: 'incident.fix', args: { incidentId: critical().id } })).toMatchObject({ status: 'applied', outcome: { itemId: 'loom:fix-1', via: 'worker', message: expect.stringContaining('worker') } });
    expect(await post({ commandId: 'f3', type: 'incident.fix', args: { incidentId: 9999 } })).toMatchObject({ status: 'failed', error: 'that incident is resolved or gone' });
    expect(await system().command('incident.fix', { incidentId: listIncidents(ledger).find((i) => i.jobId === 'schedule:brief')!.id })).toMatchObject({ ok: false, error: expect.stringContaining('can’t start a fix') });
    h.core.store.setSetting('projects', '[]');
    expect(await system({ fix: { mail, startWork: null } }).command('incident.fix', { incidentId: listIncidents(ledger).find((i) => i.jobId === 'schedule:brief')!.id })).toEqual({ ok: false, error: 'there’s no Tango project on the desk, and this desk can’t start threads of its own (Start work isn’t set up)' });
  });

  const readFixCursor = (id: number) => ledger.db.prepare('SELECT value FROM cursors WHERE name = ?').get(`fix.${id}`) ?? null;
});

describe('the System routes', () => {
  const app = (s: DeskSystem) => {
    const a = new Hono();
    registerDeskRoutes(a, { core: h.core, scenes: () => [], system: s });
    return a;
  };

  it('serves the snapshot with an ETag (304 when unchanged), a job, events and the voice brief', async () => {
    seed();
    const a = app(system());
    const first = await a.request('/api/desk/system');
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag')!;
    expect(etag).toBeTruthy();
    expect((await first.json()).summary.critical).toBe(1);
    expect((await a.request('/api/desk/system', { headers: { 'If-None-Match': etag } })).status).toBe(304);
    expect((await a.request(`/api/desk/system/jobs/${encodeURIComponent(PULL)}`)).status).toBe(200);
    expect((await a.request('/api/desk/system/jobs/nope')).status).toBe(404);
    const events = await (await a.request('/api/desk/system/events?source=scheduler')).json();
    expect(events.events.map((e: { source: string }) => e.source)).toEqual(['scheduler']);
    const brief = await (await a.request('/api/desk/system/brief')).json();
    expect(brief).toMatchObject({ critical: ['Exited 1: Health store locked'], open: ['Delivery failed: channel not found'] });
    expect(brief.line).toMatch(/1 critical/);
  });

  it('the I’m-away switch sets the Mac’s mode and the snapshot reads it, with no job involved', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mode-')), 'work-mode.json');
    const before = [process.env.TANGO_WORK_MODE_FILE, process.env.TANGO_WORK_WINDOWS_FILE];
    process.env.TANGO_WORK_MODE_FILE = file;
    process.env.TANGO_WORK_WINDOWS_FILE = path.join(path.dirname(file), 'none.yaml');
    try {
      seed();
      const s = system();
      expect((await s.snapshot({ fresh: true })).workMode).toMatchObject({ mode: 'working' });
      expect(await s.command('mode.away', { hours: 2 })).toMatchObject({ ok: true });
      expect((await s.snapshot({ fresh: true })).workMode).toMatchObject({ mode: 'away', source: 'manual' });
      expect(await s.command('mode.working', {})).toMatchObject({ ok: true });
      expect((await s.snapshot({ fresh: true })).workMode).toMatchObject({ mode: 'working', source: 'manual' });
      expect(predictSystem('mode.away', { workMode: null }, { hours: 1 }, 0).workMode).toMatchObject({ mode: 'away', minutesLeft: 60 });
    } finally {
      for (const [i, k] of ['TANGO_WORK_MODE_FILE', 'TANGO_WORK_WINDOWS_FILE'].entries()) {
        if (before[i] === undefined) delete process.env[k];
        else process.env[k] = before[i];
      }
    }
  });

  it('takes the System commands through /api/desk/commands, failures as a status the Retry toast reads', async () => {
    seed();
    const a = app(system());
    const post = (body: unknown) => a.request('/api/desk/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    expect(await post({ commandId: 'c1', type: 'incident.ack', args: { incidentId: critical().id } })).toMatchObject({ commandId: 'c1', status: 'applied' });
    expect(await post({ commandId: 'c2', type: 'job.pause', args: { jobId: 'nope' } })).toMatchObject({ status: 'failed', error: 'no job nope' });
    expect(await post({ commandId: 'c4', type: 'job.pause', args: { jobId: PULL } })).toMatchObject({ status: 'failed', outcome: { needsForce: true } });
    const none = new Hono();
    registerDeskRoutes(none, { core: h.core, scenes: () => [] });
    expect(await (await none.request('/api/desk/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commandId: 'c3', type: 'incident.ack', args: { incidentId: 1 } }) })).json()).toMatchObject({ status: 'failed' });
    expect((await none.request('/api/desk/system')).status).toBe(404);
  });
});

describe('critical incidents on the desk, and the feed', () => {
  it('updates failure evidence without renewing attention on every retry', async () => {
    seed();
    const s = system();
    await s.tick();
    const id = `${SYSTEM_ITEM_PREFIX}${critical().id}`;
    const before = h.core.store.item(id)!;
    const attention = h.core.store.attention(id);
    recordEvent(ledger, { source: 'tango-run', jobId: PULL, kind: 'run.failed', severity: 'error', title: 'Exited 1: Health store locked', at: new Date(Date.now() + 60_000).toISOString() });
    await s.tick();
    expect(h.core.store.item(id)!.lastActivityAt).toBe(before.lastActivityAt);
    expect(h.core.store.item(id)!.facts.failed?.at).toBe(before.facts.failed?.at);
    expect(h.core.store.attention(id)).toEqual(attention);
    expect(h.core.store.item(id)!.facts.system?.count).toBe(3);
    const worseAt = new Date(Date.now() + 120_000).toISOString();
    recordEvent(ledger, { source: 'tango-run', jobId: PULL, kind: 'run.failed', severity: 'critical', title: 'Exited 1: Health store locked', at: worseAt });
    await s.tick();
    expect(h.core.store.item(id)!.facts.failed?.at).toBe(Date.parse(worseAt));
  });

  it('automatically links a Fix worker owner ask without acknowledging or recovering the check', async () => {
    seed();
    const s = system();
    h.core.ensureItem({ id: 'loom:fixer', source: 'loom', kind: 'thread', agentId: 'loom', agentName: 'Repair', conversationKey: 'fixer', place: 'Repair', createdAt: Date.now() }, 'agent');
    h.core.setFacts('loom:fixer', { openAsk: { text: 'Restart the source', at: Date.now() } } as never);
    setCursor(ledger, `fix.${critical().id}`, JSON.stringify({ itemId: 'loom:fixer', at: new Date().toISOString(), attempt: 1, via: 'worker' }));
    await s.tick();
    expect(h.core.store.items().filter((i) => i.source === 'system')).toHaveLength(0);
    expect(critical().status).toBe('open');
    expect(ledger.db.prepare('SELECT item_id, active FROM incident_owner_waits').get()).toMatchObject({ item_id: 'loom:fixer', active: 1 });
  });

  it('does not create or retain an owner wait for a request addressed to an agent', async () => {
    seed();
    const s = system();
    const id = critical().id;
    h.core.ensureItem({ id: 'loom:fixer', source: 'loom', kind: 'thread', agentId: 'loom', agentName: 'Repair', conversationKey: 'fixer', place: 'Repair', createdAt: Date.now() }, 'agent');
    setCursor(ledger, `fix.${id}`, JSON.stringify({ itemId: 'loom:fixer', at: new Date().toISOString(), attempt: 1, via: 'worker' }));
    const agentAsk = { text: 'Review the repair plan', at: Date.now(), to: 'loom:lead' };
    h.core.setFacts('loom:fixer', { openAsk: agentAsk });
    await s.tick();
    expect(ledger.db.prepare('SELECT * FROM incident_owner_waits').all()).toHaveLength(0);
    expect(h.core.item(`${SYSTEM_ITEM_PREFIX}${id}`)?.disposition).toBe('active');
    h.core.setFacts('loom:fixer', { openAsk: { text: 'Restart the source', at: Date.now() } });
    await s.tick();
    expect(h.core.item(`${SYSTEM_ITEM_PREFIX}${id}`)?.disposition).toBe('done');
    h.core.setFacts('loom:fixer', { openAsk: agentAsk });
    await s.tick();
    expect(ledger.db.prepare('SELECT active FROM incident_owner_waits').get()).toMatchObject({ active: 0 });
    expect(h.core.item(`${SYSTEM_ITEM_PREFIX}${id}`)?.disposition).toBe('active');
    expect(critical().status).toBe('open');
    expect(ledger.db.prepare('SELECT notify_pending FROM incidents WHERE id = ?').get(id)).toMatchObject({ notify_pending: 'opened' });
  });

  it('does not revive an answered Fix errand for a later unrelated ask, but permits explicit relinking', async () => {
    seed();
    const s = system();
    const id = critical().id;
    h.core.ensureItem({ id: 'loom:fixer', source: 'loom', kind: 'thread', agentId: 'loom', agentName: 'Repair', conversationKey: 'fixer', place: 'Repair', createdAt: Date.now() }, 'agent');
    setCursor(ledger, `fix.${id}`, JSON.stringify({ itemId: 'loom:fixer', at: new Date().toISOString(), attempt: 1, via: 'worker' }));
    h.core.setFacts('loom:fixer', { openAsk: { text: 'Restart the source', at: Date.now() } } as never);
    await s.tick();
    h.core.setFacts('loom:fixer', { openAsk: null });
    await s.tick();
    h.core.setFacts('loom:fixer', { openAsk: { text: 'Choose a report format', at: Date.now() } } as never);
    await s.tick();
    expect(ledger.db.prepare('SELECT active FROM incident_owner_waits').get()).toMatchObject({ active: 0 });
    expect(h.core.item(`${SYSTEM_ITEM_PREFIX}${id}`)?.disposition).toBe('active');
    expect(critical().status).toBe('open');
    expect(ledger.db.prepare('SELECT notify_pending FROM incidents WHERE id = ?').get(id)).toMatchObject({ notify_pending: 'opened' });
    linkIncidentOwnerWait(ledger, id, 'loom:fixer');
    await s.tick();
    expect(ledger.db.prepare('SELECT active FROM incident_owner_waits').get()).toMatchObject({ active: 1 });
    expect(h.core.item(`${SYSTEM_ITEM_PREFIX}${id}`)?.disposition).toBe('done');
  });

  it('lets one explicit owner errand carry the ask and restores an unresolved incident after it ends', async () => {
    seed();
    const s = system();
    h.core.ensureItem({ id: 'loom:repair', source: 'loom', kind: 'thread', agentId: 'loom', createdAt: Date.now(), conversationKey: 'repair', agentName: 'Repair', place: 'Repair' }, 'agent');
    h.core.setFacts('loom:repair', { openAsk: { text: 'Restart the upstream service', at: Date.now() } } as never);
    linkIncidentOwnerWait(ledger, critical().id, 'loom:repair');
    await s.tick();
    expect(h.core.store.items().filter((i) => i.source === 'system')).toHaveLength(0);
    expect(critical().status).toBe('open');
    h.core.setFacts('loom:repair', { openAsk: null });
    await s.tick();
    expect(h.core.item(`${SYSTEM_ITEM_PREFIX}${critical().id}`)?.disposition).toBe('active');
  });

  it('makes each critical open incident an Inbox item that needs the owner, and settles it when held or resolved', async () => {
    seed();
    const s = system();
    await s.tick();
    const crit = critical();
    const id = `${SYSTEM_ITEM_PREFIX}${crit.id}`;
    const item = h.core.item(id)!;
    expect(item).toMatchObject({ source: 'system', area: 'System', disposition: 'active', facts: { role: 'default', system: { incidentId: crit.id } } });
    expect(deskStatus(item).move).toBe('failed');
    // Only critical ones.
    expect(h.core.store.items().filter((i) => i.source === 'system')).toHaveLength(1);
    await s.command('incident.mute', { incidentId: crit.id });
    expect(h.core.item(id)?.disposition).toBe('done');
    // Back open: back in the Inbox.
    await s.command('incident.unack', { incidentId: crit.id });
    expect(h.core.item(id)?.disposition).toBe('active');
    recordEvent(ledger, { source: 'tango-run', jobId: PULL, kind: 'run.ok', severity: 'recovery', title: 'Recovered' });
    await s.tick();
    expect(h.core.item(id)?.disposition).toBe('done');
    // Done on the row acknowledges it.
    recordEvent(ledger, { source: 'tango-run', jobId: PULL, kind: 'run.failed', severity: 'error', title: 'Exited 2: something else' });
    const again = listIncidents(ledger).find((i) => i.jobId === PULL && i.status === 'open')!;
    await s.done({ id: `${SYSTEM_ITEM_PREFIX}${again.id}` } as never);
    expect(listIncidents(ledger).find((i) => i.id === again.id)?.status).toBe('acked');
  });

  it('posts the other incidents’ transitions to the feed once, under the incident’s key', async () => {
    seed();
    const s = system();
    await s.tick();
    let posts = feed.recent().filter((p) => p.kind === 'system');
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ title: 'Delivery failed: channel not found', data: { transition: 'opened', severity: 'error' } });
    // Nothing new: no new post; more of the same folds into the incident's key.
    await s.tick();
    recordEvent(ledger, { source: 'scheduler', jobId: 'schedule:brief', kind: 'delivery.failed', severity: 'critical', title: 'Delivery failed: channel not found' });
    await s.tick();
    posts = feed.recent().filter((p) => p.kind === 'system');
    expect(posts).toHaveLength(1);
  });

  it('tells open pages when the ledger changed, not on every tick', async () => {
    seed();
    const s = system();
    let events = 0;
    s.subscribe(() => (events += 1));
    // The first tick reads it; the second sees the feed's notice recorded on the incident; then it's still.
    await s.tick();
    await s.tick();
    const settled = events;
    await s.tick();
    await s.tick();
    expect(events).toBe(settled);
    recordEvent(ledger, { source: 'scheduler', jobId: 'schedule:brief', kind: 'delivery.failed', severity: 'error', title: 'Something else broke' });
    await s.tick();
    expect(events).toBe(settled + 1);
  });
});

describe('the System page’s place', () => {
  it('opens Capacity on the System page’s Capacity tab, and a job as System › job', async () => {
    // @ts-expect-error plain browser module, no types
    const { placeRoute } = await import('../public/desk/next/nav.js');
    // @ts-expect-error plain browser module, no types
    const { crumbsOf, placeName } = await import('../public/desk/next/model.js');
    expect(placeRoute({ page: 'capacity' })).toEqual({ page: 'system', view: 'capacity' });
    expect(placeRoute({ page: 'inbox', view: 'x' })).toEqual({ page: 'inbox', view: 'x' });
    expect(crumbsOf({ page: 'system', view: 'jobs' }).map((c: { label: string }) => c.label)).toEqual(['System']);
    expect(crumbsOf({ page: 'system', view: 'jobs', id: 'schedule:brief' }, { systemJob: 'Daily Brief' }).map((c: { label: string }) => c.label)).toEqual(['System', 'Daily Brief']);
    expect(placeName({ page: 'system' })).toBe('System');
  });
});

describe('the page’s model (browser)', () => {
  const NOW = Date.parse('2026-10-18T13:50:00Z');
  it('reads the fixture: the head line, the strip, the chip and job health', () => {
    const data = createSystemFixture(NOW).read();
    expect(systemChip(data)).toBe('2 critical');
    expect(lede(data)).toMatchObject({ crit: 2, clear: false });
    const strip = stripCells(data.health, NOW);
    expect(strip.machine.find((m: { id: string }) => m.id === 'load')).toMatchObject({ state: 'warn', value: '47' });
    const pull = data.jobs.find((j: { id: string }) => j.id === 'launchd:com.example.health-pull');
    expect(jobHealth(pull, data.incidents)).toBe('failing');
    expect(jobHealth({ ...pull, state: 'paused' }, data.incidents)).toBe('paused');
    const clear = createSystemFixture(NOW, { clear: true }).read();
    expect(systemChip(clear)).toBeNull();
    expect(lede(clear).clear).toBe(true);
  });

  it('folds an incident’s repeats into its newest event', () => {
    const events = [{ id: 3, incidentId: 1 }, { id: 2, incidentId: 1 }, { id: 1, incidentId: null }];
    expect(foldEvents(events).map((r: { event: { id: number }; more: number }) => [r.event.id, r.more])).toEqual([[3, 1], [1, 0]]);
    expect(foldEvents(events, { 1: true })).toHaveLength(3);
  });

  it('predicts every System command on the snapshot (optimistic), and nothing it can’t tell', () => {
    const data = createSystemFixture(NOW).read();
    const inc = data.incidents.find((i: { status: string }) => i.status === 'open');
    expect(predictSystem('incident.ack', data, { incidentId: inc.id }).incidents.find((i: { id: number }) => i.id === inc.id).status).toBe('acked');
    expect(predictSystem('incident.snooze', data, { incidentId: inc.id, hours: 1 }, NOW).incidents.find((i: { id: number }) => i.id === inc.id)).toMatchObject({ status: 'snoozed', snoozedUntil: new Date(NOW + 3_600_000).toISOString() });
    expect(predictSystem('job.retire', data, { jobId: 'schedule:daily-brief', reason: 'x' }).jobs.find((j: { id: string }) => j.id === 'schedule:daily-brief')).toMatchObject({ state: 'retired', retireReason: 'x' });
    expect(predictSystem('job.run', data, { jobId: 'schedule:daily-brief' }).runs['schedule:daily-brief'].strip.at(-1)).toBe('running');
    expect(predictSystem('process.stop', data, { jobId: 'proc:loom-stale-1' }).jobs.some((j: { id: string }) => j.id === 'proc:loom-stale-1')).toBe(false);
    expect(predictSystem('process.stop', data, { jobId: 'schedule:daily-brief' })).toBeUndefined();
    expect(predictSystem('incident.ack', data, { incidentId: 9999 })).toBeUndefined();
    // Fix: Fixing… at once (no thread yet); one already under way is left as it is.
    expect(predictSystem('incident.fix', data, { incidentId: inc.id }, NOW).incidents.find((i: { id: number }) => i.id === inc.id).fix).toEqual({ itemId: null, at: new Date(NOW).toISOString(), via: null, done: false });
    const fixing = { ...data, incidents: data.incidents.map((i: { id: number }) => (i.id === inc.id ? { ...i, fix: { itemId: 'loom:x', at: 'then', via: 'worker', done: false } } : i)) };
    expect(predictSystem('incident.fix', fixing, { incidentId: inc.id })).toBe(fixing);
    expect(predictSystem('incident.fix', data, { incidentId: 9999 })).toBeUndefined();
    expect(createSystemFixture(NOW).command('incident.fix', { incidentId: inc.id })).toMatchObject({ ok: true, outcome: { itemId: `fixture:fix-${inc.id}` } });
    expect(predictSystem('nope', data, {})).toBeUndefined();
  });
});

it('does not settle or take ownership of held phone notes while polling incidents', async () => {
  h.core.ensureItem({ id: 'phone:held', source: 'system', kind: 'thread', conversationKey: 'phone:held', agentId: 'phone-note', agentName: 'Phone note', createdAt: Date.now(), facts: { phoneNote: { noteId: 'held', text: 'Keep this', uncertain: false } } }, 'owner');
  const service = system();
  expect(service.owns(h.core.store.item('phone:held')!)).toBe(false);
  await service.snapshot();
  expect(h.core.item('phone:held')?.disposition).toBe('active');
});
