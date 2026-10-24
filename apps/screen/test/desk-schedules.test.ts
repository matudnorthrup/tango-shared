import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { DeskSchedulesSource, everyText, nextRun, readScheduleJobs } from '../server/desk/source-schedules.js';
import { makeHarness } from './desk-harness.js';
import type { DeskSourceAdapter } from '../server/desk/core.js';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const config = (id: string, extra: Record<string, unknown> = {}) => ({ id, description: id, enabled: true, schedule: { cron: '0 7 * * *' }, execution: { mode: 'agent', workerId: 'research' }, ...extra }) as never;

describe('schedules as jobs', () => {
  it('says a schedule in a few words', () => {
    expect(everyText({ everySeconds: 900 })).toBe('Every 15 min');
    expect(everyText({ everySeconds: 3600 })).toBe('Every hour');
    expect(everyText({ cron: '*/30 * * * *' })).toBe('Every 30 min');
    expect(everyText({ cron: '5 15 * * *' })).toBe('Daily 15:05');
    expect(everyText({ cron: '0 7 * * 1' })).toBe('Mondays 7:00');
    expect(everyText({ cron: '0 9 * * 1-5' })).toBe('Weekdays 9:00');
    expect(everyText({ cron: '0 14 * * 0,3' })).toBe('0 14 * * 0,3');
    expect(everyText({})).toBe('On request');
  });

  it('works out the next run', () => {
    expect(nextRun({ everySeconds: 600 }, NOW - 60_000, NOW)).toBe(NOW + 540_000);
    expect(nextRun({ cron: '0 7 * * *', timezone: 'UTC' }, null, NOW)).toBe(Date.parse('2026-10-18T07:00:00Z'));
    expect(nextRun({ at: '2020-01-01T00:00:00Z' }, null, NOW)).toBeNull();
  });

  it('puts each enabled schedule under its agent, with its recorded runs; skips manual tests and agentless ones', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
    const db = new DatabaseSync(path.join(dir, 'tango.sqlite'));
    db.exec(`CREATE TABLE schedule_state (schedule_id TEXT PRIMARY KEY, last_run_at TEXT, last_status TEXT, last_error TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0, backoff_until TEXT);
      CREATE TABLE schedule_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id TEXT, started_at TEXT, status TEXT, summary TEXT, error TEXT);`);
    db.prepare("INSERT INTO schedule_state VALUES ('brief', '2026-10-17T11:00:00.000Z', 'error', 'timed out', 2, null)").run();
    db.prepare("INSERT INTO schedule_runs (schedule_id, started_at, status, summary, error) VALUES ('brief', '2026-10-16T11:00:00.000Z', 'ok', '**Brief** ready.', null), ('brief', '2026-10-17T11:00:00.000Z', 'error', null, 'timed out')").run();
    const jobs = readScheduleJobs({
      configs: [config('brief', { displayName: 'Morning brief', delivery: { agentId: 'watson' } }), config('scan'), config('manual-test-brief', { delivery: { agentId: 'watson' } }), config('orphan', { execution: { mode: 'deterministic' } }), config('off', { enabled: false })],
      workerOwners: new Map([['research', 'sierra']]),
      db,
      now: NOW,
    });
    expect(jobs.map((j) => [j.id, j.agentId])).toEqual([['brief', 'watson'], ['scan', 'sierra']]);
    expect(jobs[0]).toMatchObject({ title: 'Morning brief', every: 'Daily 7:00', lastStatus: 'error', failures: 2, lastRunAt: Date.parse('2026-10-17T11:00:00Z') });
    expect(jobs[0]!.runs).toEqual([
      { at: Date.parse('2026-10-17T11:00:00Z'), outcome: 'failed', note: 'timed out' },
      { at: Date.parse('2026-10-16T11:00:00Z'), outcome: 'ok', note: 'Brief ready.' },
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('the schedules source on the desk', () => {
  const table = (dir: string) => {
    const db = new DatabaseSync(path.join(dir, 'tango.sqlite'));
    db.exec(`CREATE TABLE schedule_state (schedule_id TEXT PRIMARY KEY, last_run_at TEXT, last_status TEXT, last_error TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0, backoff_until TEXT);
      CREATE TABLE schedule_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id TEXT, started_at TEXT, status TEXT, summary TEXT, error TEXT);`);
    return db;
  };

  it('waits out a backoff, and says a skipped run that wrote no run row', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
    const db = table(dir);
    db.prepare("INSERT INTO schedule_state VALUES ('scan', '2026-10-17T11:58:00.000Z', 'skipped', null, 0, '2026-10-17T13:00:00.000Z')").run();
    db.prepare("INSERT INTO schedule_runs (schedule_id, started_at, status, summary, error) VALUES ('scan', '2026-10-17T10:00:00.000Z', 'ok', 'Ran fine', null)").run();
    const [job] = readScheduleJobs({ configs: [config('scan', { schedule: { everySeconds: 300 } })], workerOwners: new Map([['research', 'sierra']]), db, now: NOW });
    expect(job!.nextRunAt).toBe(Date.parse('2026-10-17T13:00:00Z'));
    expect(job!.runs.map((r) => [r.outcome, r.note])).toEqual([['quiet', 'Nothing to do'], ['ok', 'Ran fine']]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('retires a removed schedule, moves one whose agent changed, and never throws on a database without the tables', () => {
    const h = makeHarness();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
    table(dir);
    let configs = [config('brief', { delivery: { agentId: 'watson' } }), config('scan')];
    const source = new DeskSchedulesSource({ core: h.core, dbPath: path.join(dir, 'tango.sqlite'), now: () => NOW, load: () => ({ configs, workerOwners: new Map([['research', 'sierra']]) }) });
    expect(source.poll()).toBe(2);
    expect(h.core.item('schedule:brief')).toMatchObject({ agentId: 'watson', facts: { role: 'ops' } });
    configs = [config('brief', { delivery: { agentId: 'foxtrot' } })];
    source.poll();
    expect(h.core.item('schedule:brief')!.agentId).toBe('foxtrot');
    expect(h.core.item('schedule:scan')!.disposition).toBe('done');
    const empty = new DeskSchedulesSource({ core: h.core, dbPath: path.join(dir, 'missing', 'tango.sqlite'), now: () => NOW, load: () => ({ configs, workerOwners: new Map() }) });
    expect(() => empty.poll()).not.toThrow();
    const noTables = new DeskSchedulesSource({ core: h.core, dbPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sched-')), 'empty.sqlite'), now: () => NOW, load: () => ({ configs, workerOwners: new Map() }) });
    new DatabaseSync(path.join(path.dirname((noTables as unknown as { options: { dbPath: string } }).options.dbPath), 'empty.sqlite')).close();
    expect(() => noTables.poll()).not.toThrow();
    h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads a pause the bot recorded: no next run, and the job says it is paused', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
    const db = table(dir);
    const before = readScheduleJobs({ configs: [config('scan')], workerOwners: new Map([['research', 'sierra']]), db, now: NOW });
    expect(before[0]).toMatchObject({ paused: false });
    db.exec("CREATE TABLE schedule_pauses (schedule_id TEXT PRIMARY KEY, paused_at TEXT); INSERT INTO schedule_pauses (schedule_id) VALUES ('scan')");
    const [job] = readScheduleJobs({ configs: [config('scan')], workerOwners: new Map([['research', 'sierra']]), db, now: NOW });
    expect(job).toMatchObject({ paused: true, nextRunAt: null });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('Run now and Pause go to the bot, and Pause shows at once', async () => {
    const adapters: DeskSourceAdapter[] = [];
    const h = makeHarness({ adapters });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
    table(dir);
    const calls: string[] = [];
    let answer: { status: number; body: Record<string, unknown> } = { status: 202, body: { ok: true } };
    const fake = (async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`);
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }) as unknown as typeof fetch;
    const source = new DeskSchedulesSource({ core: h.core, dbPath: path.join(dir, 'tango.sqlite'), botUrl: 'http://bot', fetch: fake, now: () => NOW, load: () => ({ configs: [config('scan')], workerOwners: new Map([['research', 'sierra']]) }) });
    adapters.push(source);
    source.poll();
    expect(await h.core.command({ commandId: 'c1', type: 'run', itemId: 'schedule:scan', actor: 'screen' })).toMatchObject({ status: 'applied', outcome: { started: true } });
    answer = { status: 200, body: { ok: true, paused: true } };
    expect(await h.core.command({ commandId: 'c2', type: 'pause', itemId: 'schedule:scan', args: { paused: true }, actor: 'screen' })).toMatchObject({ status: 'applied', outcome: { paused: true } });
    expect(h.core.item('schedule:scan')!.facts.schedule).toMatchObject({ paused: true });
    await h.core.command({ commandId: 'c3', type: 'pause', itemId: 'schedule:scan', args: { paused: false }, actor: 'screen' });
    expect(calls).toEqual(['POST http://bot/schedules/scan/run', 'POST http://bot/schedules/scan/pause', 'POST http://bot/schedules/scan/resume']);
    // A bot from before the buttons: say it needs a restart.
    answer = { status: 404, body: { error: 'Use GET /trigger/<schedule-id> or POST /collaboration/request' } };
    expect(await h.core.command({ commandId: 'c4', type: 'run', itemId: 'schedule:scan', actor: 'screen' })).toMatchObject({ status: 'failed', error: expect.stringContaining('restart') });
    h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
