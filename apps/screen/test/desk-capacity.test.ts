import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Capacity, loomAccountIds, routingProblems, writeRouting } from '../server/desk/capacity.js';
import { readAccountPolicy } from '../server/desk/start-work-accounts.js';
import { StartWork } from '../server/desk/start-work.js';
import type { LoomThreadRow } from '../server/desk/source-loom.js';
// @ts-expect-error plain browser module, no types
import { forecastLine, forecastTags, capacityWarning, moveTargets, resetLabel, runOnTargets } from '../public/desk/next/capacity.js';
// @ts-expect-error plain browser module, no types
import { routingEffect } from '../public/desk/settings.js';
// @ts-expect-error plain browser module, no types
import { loomSummary, pinSeats } from '../public/desk/start-work.js';

// Capacity (accounts, their Loom threads, this Mac) and routing (the policy file Settings › Routing edits).
// T3's settings and Loom's threads are stubbed at their edges; the usage monitor is left out (no readings).

const NOW = Date.parse('2026-10-17T15:00:00Z');
let dir: string;
let policyFile: string;
let loomAccounts: string;

function row(id: string, account: string | null, extra: Partial<LoomThreadRow> = {}): LoomThreadRow {
  return { id, title: `Thread ${id}`, repo: '/repos/tango', cwd: '/wt', status: 'idle', account, accounts: null, updated_at: NOW - 60_000, settled_at: null, ...extra };
}

function capacity(rows: LoomThreadRow[] | null, extra: Record<string, unknown> = {}) {
  const startWork = new StartWork({
    loom: { startThread: async () => ({ ok: true as const, threadId: 'x' }) },
    repos: [{ id: 'p-tango', name: 'tango', path: '/repos/tango' }],
    accountsFile: loomAccounts,
    policyFile,
    git: async () => 'origin/main',
    now: () => NOW,
  });
  return new Capacity({ startWork, policyFile, loom: { threads: async () => rows, ...extra }, loomAccountsFile: loomAccounts, machine: async () => null, now: () => NOW });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-capacity-'));
  policyFile = path.join(dir, 'start-work.yaml');
  loomAccounts = path.join(dir, 'accounts.json');
  fs.writeFileSync(loomAccounts, JSON.stringify({ claude: { accounts: [{ name: 'home', usageName: 'Claude (Home)', aliases: ['claude_home'], color: '#7c3aed' }, { name: 'team', usageName: 'Claude (Team)', aliases: ['claude_team'] }] }, codex: { accounts: [{ name: 'codex', usageName: 'ChatGPT (Home)' }] } }));
  fs.writeFileSync(policyFile, ['model: claude-opus-5-5', 'default: claude_home', 'repos:', '  acme: [claude_team]'].join('\n'));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('capacity', () => {
  it('maps Loom account names to T3 accounts through their aliases', () => {
    const ids = loomAccountIds(loomAccounts, ['claude_home', 'claude_team']);
    expect(ids.get('home')).toBe('claude_home');
    expect(ids.get('claude_team')).toBe('claude_team');
    expect(loomAccountIds(path.join(dir, 'missing.json'), ['claude_home']).size).toBe(0);
  });

  it('puts each open Loom thread under its account, running first, and leaves stopped and settled ones out', async () => {
    const snap = await capacity([
      row('a', 'home', { updated_at: NOW - 5_000 }),
      row('b', 'home', { status: 'running', accounts: JSON.stringify(['home']) }),
      row('c', 'team', { repo: '/repos/acme' }),
      row('d', 'home', { status: 'stopped' }),
      row('e', 'home', { settled_at: NOW - 1 }),
      row('f', null),
    ]).snapshot();
    const home = snap.accounts.find((a) => a.id === 'claude_home')!;
    expect(home).toMatchObject({ name: 'Claude (Home)', color: '#7c3aed', provider: 'claude', running: 1, idle: 1 });
    expect(home.threads.map((t) => t.itemId)).toEqual(['loom:b', 'loom:a']);
    expect(home.threads[0]).toMatchObject({ repo: 'tango', running: true, allowed: ['claude_home'] });
    expect(snap.accounts.find((a) => a.id === 'claude_team')!.threads[0]).toMatchObject({ itemId: 'loom:c', repo: 'acme', allowed: null });
    expect(snap.accounts.find((a) => a.id === 'codex')).toMatchObject({ provider: 'codex', threads: [] });
    expect(snap).toMatchObject({ loom: true, moves: false, rules: { default: ['claude_home'], repos: [{ repo: 'acme', accounts: ['claude_team'] }], error: null } });
  });

  it('says when Loom can’t be read, and still shows the accounts', async () => {
    const snap = await capacity(null).snapshot();
    expect(snap.loom).toBe(false);
    expect(snap.accounts.map((a) => a.id)).toEqual(['claude_home', 'claude_team', 'codex']);
  });
});

describe('capacity from Loom', () => {
  it('lays Loom’s threads, cooling and moves over the desk’s accounts, and skips the snapshot', async () => {
    let snapshotRead = false;
    const thread = { itemId: 'loom:x', title: 'X', repo: 'acme', running: true, lastActiveAt: NOW, allowed: ['claude_team'], allowedFrom: 'policy' };
    const snap = await capacity(null, {
      threads: async () => ((snapshotRead = true), []),
      capacity: async () => ({ moves: true, accounts: [{ id: 'claude_team', coolingUntil: NOW + 3_600_000, running: 1, idle: 0, threads: [thread] }] }),
    }).snapshot();
    expect(snapshotRead).toBe(false);
    expect(snap).toMatchObject({ loom: true, moves: true });
    // The owner's names and colors stay; Loom only brings the threads and the cooling.
    expect(snap.accounts.find((a) => a.id === 'claude_team')).toMatchObject({ name: 'Claude (Team)', running: 1, idle: 0, coolingUntil: NOW + 3_600_000, threads: [thread] });
    expect(snap.accounts.find((a) => a.id === 'claude_home')).toMatchObject({ name: 'Claude (Home)', color: '#7c3aed', threads: [] });
  });

  it('carries Loom’s floor reading for accounts with pinned threads (Codex review on #807)', async () => {
    const snap = await capacity(null, {
      threads: async () => [],
      capacity: async () => ({ moves: true, accounts: [{ id: 'claude_team', running: 0, idle: 0, threads: [], floorPercent: 10, pinned: 2, warning: 'near_floor' as const }] }),
    }).snapshot();
    expect(snap.accounts.find((a) => a.id === 'claude_team')).toMatchObject({ floorPercent: 10, pinned: 2, warning: 'near_floor' });
  });

  it('offers a held thread the Claude accounts with room, most weekly room first, never its own (D-42)', () => {
    const accounts = [
      { id: 'own', provider: 'claude', weekly: { left: 3 }, threads: [{ itemId: 'loom:t' }] },
      { id: 'floor', provider: 'claude', weekly: { left: 8 }, warning: 'below_floor', threads: [] },
      { id: 'resting', provider: 'claude', weekly: { left: 50 }, coolingUntil: NOW + 60_000, threads: [] },
      { id: 'codex', provider: 'codex', weekly: { left: 90 }, threads: [] },
      { id: 'work', provider: 'claude', weekly: { left: 40 }, threads: [] },
      { id: 'near', provider: 'claude', weekly: { left: 15 }, warning: 'near_floor', threads: [] },
      { id: 'wide', provider: 'claude', weekly: { left: 70 }, coolingUntil: NOW - 60_000, threads: [] },
    ];
    expect(runOnTargets('loom:t', accounts, NOW).map((a: { id: string }) => a.id)).toEqual(['wide', 'work', 'near']);
  });

  it('moves only Loom threads, and names the accounts in a thread’s history', async () => {
    const moved: unknown[] = [];
    const cap = capacity(null, {
      move: async (...args: unknown[]) => (moved.push(args), { ok: true }),
      accountHistory: async () => [{ account: 'team', at: 1, reason: 'start' }, { account: 'home', at: 2, reason: 'limit' }],
    });
    expect(await cap.move('t3:abc', 'claude_home')).toMatchObject({ ok: false });
    expect(await cap.move('loom:abc', 'claude_home', 'cmd-1')).toEqual({ ok: true });
    // The owner's one-tap "Run on" (D-42) also allows the account; a plain move doesn't.
    expect(await cap.move('loom:abc', 'claude_team', 'cmd-2', true)).toEqual({ ok: true });
    expect(moved).toEqual([['loom:abc', 'claude_home', 'cmd-1', false], ['loom:abc', 'claude_team', 'cmd-2', true]]);
    expect(await cap.history('loom:abc')).toEqual([
      { account: 'claude_team', name: 'Claude (Team)', at: 1, reason: 'start' },
      { account: 'claude_home', name: 'Claude (Home)', at: 2, reason: 'limit' },
    ]);
  });
});

describe('routing', () => {
  it('writes the rules back as a policy Start work reads, keeping the model', () => {
    writeRouting(policyFile, { default: ['claude_home', 'claude_team'], repos: { tango: ['claude_home'], acme: ['claude_team', 'claude_home'] } }, 'claude-opus-5-5');
    const read = readAccountPolicy(policyFile);
    expect(read).toMatchObject({ model: 'claude-opus-5-5', defaultPool: ['claude_home', 'claude_team'] });
    expect(read && !('error' in read) && Object.fromEntries(read.repos)).toEqual({ acme: ['claude_team', 'claude_home'], tango: ['claude_home'] });
  });

  it('refuses unknown accounts and a repo with none', () => {
    expect(routingProblems({ default: [], repos: { tango: ['claude_home'] } }, ['claude_home'])).toEqual([]);
    expect(routingProblems({ default: ['nope'], repos: { tango: [] } }, ['claude_home']).join(' ')).toMatch(/No account named nope.*tango needs at least one account/);
    expect(routingProblems({ default: [], repos: { 'bad repo': ['claude_home'] } }, ['claude_home']).join(' ')).toContain('isn\'t a repo name');
  });

  it('says what a rule means: spread, one account, or one account under load', () => {
    expect(routingEffect([], 0)).toBe('Loom picks from every Claude account.');
    expect(routingEffect(['a', 'b', 'c'], 0)).toContain('across 3 accounts');
    expect(routingEffect(['a'], 6)).toBe('6 running threads share one account: at its limit they have nowhere to move.');
    expect(routingEffect(['a'], 1)).toBe('Always this one account.');
  });
});

describe('the pages’ helpers', () => {
  const accounts = [
    { id: 'h', name: 'Home', provider: 'claude', weekly: { left: 77 } },
    { id: 't', name: 'Team', provider: 'claude', weekly: { left: 9 } },
    { id: 'x', name: 'ChatGPT', provider: 'codex', weekly: { left: 100 } },
  ];
  it('moves a thread only to the other accounts it may use', () => {
    expect(moveTargets({ allowed: null }, accounts[0], accounts).map((a: { id: string }) => a.id)).toEqual(['t']);
    expect(moveTargets({ allowed: ['h'] }, accounts[0], accounts)).toEqual([]);
  });

  it('warns about a full disk first, then a Claude account nearly out', () => {
    expect(capacityWarning({ accounts, machine: { disk: { totalBytes: 100, freeBytes: 9 } } })).toBe('Disk 91%');
    expect(capacityWarning({ accounts, machine: { disk: { totalBytes: 100, freeBytes: 50 } } })).toBe('Team 9%');
    expect(capacityWarning({ accounts: accounts.slice(0, 1), machine: null })).toBeNull();
  });

  it('says a reset as a time today, a weekday this week, else a date', () => {
    const now = Date.parse('2026-10-17T15:00:00');
    expect(resetLabel('2026-10-17T18:30:00', now)).toBe('6:30 PM');
    expect(resetLabel('2026-10-20T03:00:00', now)).toBe('Tue 3:00 AM');
    expect(resetLabel('2026-11-02T03:00:00', now)).toBe('Nov 2');
    expect(resetLabel(null, now)).toBeNull();
  });

  it('pins only to the accounts the repo’s routing allows, and sums Options up in a line', () => {
    const list = [{ id: 'h', name: 'Home', driver: 'claudeAgent' }, { id: 't', name: 'Team', driver: 'claudeAgent' }, { id: 'c', name: 'ChatGPT', driver: 'codex' }];
    expect(pinSeats({ loomSeats: ['t'] }, list).map((a: { id: string }) => a.id)).toEqual(['t']);
    expect(pinSeats({}, list).map((a: { id: string }) => a.id)).toEqual(['h', 't']);
    expect(loomSummary({ mode: 'worktree', plan: false }, null)).toBe('New worktree · Build');
    expect(loomSummary({ mode: 'local', plan: false }, { name: 'Team' })).toBe('Current checkout · Build · Pinned to Team');
  });
});

describe('a move Loom hasn’t made yet', () => {
  it('stays on its new account, marked pending, until Loom’s reading agrees', async () => {
    // @ts-expect-error plain browser module, no types
    const { createStore } = await import('../public/desk/store.js');
    const thread = { itemId: 'loom:x', title: 'X', repo: 'tango', running: true, lastActiveAt: 1, allowed: null };
    const reading = (on: string) => ({
      updatedAt: 1, loom: true, moves: true, rules: { default: [], repos: [], error: null }, machine: null,
      accounts: ['a', 'b'].map((id) => ({ id, name: id, provider: 'claude', running: id === on ? 1 : 0, idle: 0, threads: id === on ? [thread] : [] })),
    });
    let loomSays = 'a';
    const store = createStore({ mode: 'fixtures', capacity: async () => reading(loomSays), moveThread: async () => ({ ok: true }) });
    await store.loadCapacity();
    await store.moveThread('loom:x', 'b');
    await store.loadCapacity();
    const where = () => store.state.capacity.data.accounts.find((a: { threads: Array<{ itemId: string }> }) => a.threads.some((t) => t.itemId === 'loom:x'));
    expect(where()).toMatchObject({ id: 'b', running: 1 });
    expect(where().threads[0].pending).toBe(true);
    loomSays = 'b';
    await store.loadCapacity();
    expect(where().id).toBe('b');
    expect(where().threads[0].pending).toBeUndefined();
  });
});

it('keeps provider-local capacity identities separate across threads, limits and floors', async () => {
  fs.writeFileSync(loomAccounts, JSON.stringify({ claude: { accounts: [{ name: 'main' }] }, codex: { accounts: [{ name: 'main' }] } }));
  fs.writeFileSync(policyFile, 'default: main');
  const accounts = ['claude', 'codex'].map((provider, i) => ({
    id: 'main', provider, running: 1, idle: 0, coolingUntil: NOW + i * 1000,
    floorPercent: 10 + i, pinned: i, warning: i ? 'below_floor' : 'near_floor',
    threads: [{ itemId: `loom:${provider}`, title: provider, repo: 'demo', running: true, lastActiveAt: NOW, allowed: ['main'] }],
  }));
  const snap = await capacity(null, { capacity: async () => ({ moves: true, accounts }) }).snapshot();
  for (const [i, id] of ['main', 'codex:main'].entries()) {
    expect(snap.accounts.find(a => a.id === id)).toMatchObject({
      running: 1, coolingUntil: NOW + i * 1000, floorPercent: 10 + i, pinned: i,
      warning: i ? 'below_floor' : 'near_floor',
      threads: [{ itemId: `loom:${accounts[i].provider}`, allowed: [id] }],
    });
  }
});

it('reads a Codex thread’s account history as its own provider’s seat, not the Claude one with the same name', async () => {
  fs.writeFileSync(loomAccounts, JSON.stringify({ claude: { accounts: [{ name: 'main', usageName: 'Claude (Main)' }] }, codex: { accounts: [{ name: 'main', usageName: 'ChatGPT (Main)' }] } }));
  fs.writeFileSync(policyFile, 'default: main');
  const cap = capacity([row('cx', 'main', { provider: 'codex' }), row('cl', 'main', { provider: 'claude' })], {
    accountHistory: async () => [{ account: 'main', at: 1, reason: 'start' }],
  });
  expect((await cap.history('loom:cx'))?.[0]).toMatchObject({ account: 'codex:main', at: 1, reason: 'start' });
  expect((await cap.history('loom:cl'))?.[0]).toMatchObject({ account: 'main' });
});


describe('quota forecast', () => {
  const forecast = { burnPerDay: 9, hoursOfHistory: 24, projectedAtReset: 62, dryAt: NOW + 4 * 3_600_000, flags: ['runs_dry'] };
  it('passes forecasts and pace through from Loom', async () => {
    const snap = await capacity(null, { capacity: async () => ({ moves: true, accounts: [{ id: 'claude_home', provider: 'claude', threads: [], running: 0, idle: 0, forecast, forecastReason: null, pace: 1.3, score: 0.8 }] }) }).snapshot();
    expect(snap.accounts.find(a => a.id === 'claude_home')).toMatchObject({ forecast, forecastReason: null, pace: 1.3, score: 0.8 });
  });
  it('formats reset projection, daily burn, pace, and warming history', () => {
    const resetsAt = new Date(NOW + 24 * 3_600_000).toISOString();
    expect(forecastLine({ forecast, pace: 1.3, weekly: { resetsAt } }, NOW)).toBe(`~62% at reset (${resetLabel(resetsAt, NOW)}) · 9%/day · pace 1.3`);
    expect(forecastLine({ forecast: null, forecastReason: 'history' }, NOW)).toBe('forecast after 2 h of readings');
    expect(forecastLine({ forecast: null, forecastReason: 'no_reading' }, NOW)).toBeNull();
    expect(forecastTags({ forecast: { ...forecast, flags: ['expires_unused'] } }, NOW)).toEqual(['expires unused']);
    expect(forecastTags({ forecast }, NOW)).toEqual([`runs dry ~${resetLabel(new Date(forecast.dryAt).toISOString(), NOW)}`]);
    expect(forecastTags({ forecast: { ...forecast, dryAt: NOW } }, NOW)).toEqual(['runs dry now']);
  });
  it('warns on forecast dry seats of either provider after disk and before low weekly', () => {
    const accounts = [{ name: 'north', provider: 'claude', weekly: { left: 8 } }, { name: 'east', provider: 'codex', forecast }];
    expect(capacityWarning({ accounts }, NOW)).toBe(`east runs dry ~${resetLabel(new Date(forecast.dryAt).toISOString(), NOW)}`);
    expect(capacityWarning({ accounts, machine: { disk: { freeBytes: 5, totalBytes: 100 } } }, NOW)).toBe('Disk 95%');
  });
});
