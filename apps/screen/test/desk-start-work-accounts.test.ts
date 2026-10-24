import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rankAccounts } from '../../usage-ui/src/recommend';
import type { UsageAccount } from '../../usage-ui/src/types';
import { parseAccountPolicy, pickFromPool, rankUsage, UsageMonitor, type PoolAccount, type UsageRow, type UsageSnapshot } from '../server/desk/start-work-accounts.js';
import { publicOptions, StartWork } from '../server/desk/start-work.js';
import type { LoomStart } from '../server/desk/source-loom.js';

// Start work's account choice: the owner's policy (one account per repo, or a pool), the
// usage monitor's ranking for a pool (the same as the dashboard's "New project" pick), and
// turns among accounts with comparable headroom. Synthetic account names only.

const NOW = Date.parse('2026-10-10T16:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;

function row(account: string, weekly: number, patch: Partial<UsageRow> & { session?: number; weeklyResetIn?: number } = {}): UsageRow {
  const { session = 90, weeklyResetIn = 5 * 24 * HOUR, ...rest } = patch;
  return {
    provider: 'Claude',
    account,
    live: true,
    updatedAt: iso(NOW - 60_000),
    windows: [
      { kind: 'session', title: '5 hour', usedPercent: 100 - session, remainingPercent: session, windowMinutes: 300, resetsAt: iso(NOW + 3 * HOUR) },
      { kind: 'weekly_all', title: '7 day', usedPercent: 100 - weekly, remainingPercent: weekly, windowMinutes: 10_080, resetsAt: iso(NOW + weeklyResetIn) },
      { kind: 'weekly_scoped', title: 'Fable only', usedPercent: 10, remainingPercent: 90, windowMinutes: 10_080, resetsAt: iso(NOW + weeklyResetIn) },
    ],
    ...rest,
  };
}

const POOL: PoolAccount[] = [
  { id: 'claude_team', name: 'Team Seat', driver: 'claudeAgent' },
  { id: 'claude_spare', name: 'Spare Seat', driver: 'claudeAgent' },
  { id: 'claude_extra', name: 'Extra Seat', driver: 'claudeAgent' },
];
const snap = (accounts: UsageRow[], errors: UsageSnapshot['errors'] = []): UsageSnapshot => ({ accounts, errors });

describe('the policy file', () => {
  it('reads a model, a default, and per-repo accounts or pools', () => {
    const policy = parseAccountPolicy(['model: claude-opus-5-5', 'default: claude_home', 'repos:', '  Tango: claude_home', '  work-repo: [claude_team, claude_spare]'].join('\n'));
    expect(policy.model).toBe('claude-opus-5-5');
    expect(policy.defaultAccount).toBe('claude_home');
    expect(policy.repos.get('tango')).toEqual(['claude_home']);
    expect(policy.repos.get('work-repo')).toEqual(['claude_team', 'claude_spare']);
    expect(parseAccountPolicy('model: claude-opus-5-5')).toEqual({ model: 'claude-opus-5-5', defaultAccount: null, defaultPool: [], repos: new Map() });
    // The default can be a pool too (Settings › Routing writes one); the first stands for it where one account is needed.
    expect(parseAccountPolicy('default: [claude_team, claude_spare]')).toMatchObject({ defaultAccount: 'claude_team', defaultPool: ['claude_team', 'claude_spare'] });
  });

  it('refuses a policy of the wrong shape instead of skipping parts of it (review)', () => {
    for (const bad of ['repos: work-repo', '- a\n- b', 'repos:\n  work-repo: []', 'repos:\n  work-repo: [claude_team, 3]', 'model: 5', 'modle: claude-opus-5-5', 'default: []', 'default: [a, 3]', '', '~', 'null', '2026-10-10', 'repos: 2026-10-10']) {
      expect(() => parseAccountPolicy(bad), bad).toThrow();
    }
  });
});

describe('ranking matches the usage dashboard', () => {
  it('orders accounts exactly as the dashboard’s rankAccounts does', () => {
    const cases: UsageRow[][] = [
      [row('A', 73), row('B', 98), row('C', 40)],
      [row('A', 60, { weeklyResetIn: 20 * HOUR }), row('B', 98)], // use before reset wins
      [row('A', 90, { session: 10 }), row('B', 50)], // tight 5 h window drops A below B
      [row('A', 80, { recommendationExcluded: true }), row('B', 30), row('C', 70, { live: false })],
      [row('A', 80, { updatedAt: iso(NOW - 20 * 60_000) }), row('B', 20)], // stale
      [row('A', 80, { session: 0 }), row('B', 20)], // exhausted
    ];
    for (const accounts of cases) {
      const ours = rankUsage(accounts, 'Claude', NOW).map((entry) => entry.account.account);
      const dashboard = rankAccounts(accounts as unknown as UsageAccount[], 'Claude', NOW).map((entry) => entry.account.account);
      expect(ours).toEqual(dashboard);
    }
  });
});

describe('choosing from a pool', () => {
  const never = new Map<string, number>();

  it('one account: always that one', () => {
    expect(pickFromPool([POOL[0]!], null, never, NOW)).toEqual({ id: 'claude_team', reason: 'the repo’s account' });
  });

  it('one account clearly ahead: the most headroom', () => {
    const pick = pickFromPool(POOL, snap([row('Team Seat', 40), row('Spare Seat', 95), row('Extra Seat', 60)]), never, NOW);
    expect(pick).toEqual({ id: 'claude_spare', reason: 'most headroom: 95% weekly left' });
  });

  it('an account that resets within two days with plenty left goes first', () => {
    const pick = pickFromPool(POOL, snap([row('Team Seat', 70, { weeklyResetIn: 30 * HOUR }), row('Spare Seat', 98)]), never, NOW);
    expect(pick).toEqual({ id: 'claude_team', reason: 'use before reset: 70% weekly left' });
  });

  it('comparable headroom: the account that started a thread longest ago takes its turn', () => {
    const usage = snap([row('Team Seat', 90), row('Spare Seat', 85)]);
    const recent = new Map([['claude_spare', NOW - 5 * HOUR], ['claude_team', NOW - 60_000]]);
    expect(pickFromPool(POOL, usage, recent, NOW)).toEqual({ id: 'claude_spare', reason: 'taking turns: 85% weekly left' });
    recent.set('claude_spare', NOW);
    expect(pickFromPool(POOL, usage, recent, NOW)?.id).toBe('claude_team');
  });

  it('skips accounts the monitor can’t read when none can be ranked', () => {
    const usage = snap([], [{ provider: 'Claude', account: 'Team Seat', message: 'not signed in' }]);
    const pick = pickFromPool(POOL, usage, new Map([['claude_spare', NOW], ['claude_extra', NOW - HOUR]]), NOW);
    expect(pick).toEqual({ id: 'claude_extra', reason: 'quota unknown: taking turns' });
  });

  it('two seats to use before reset: the sooner reset goes first, as on the dashboard (review)', () => {
    const usage = snap([row('Team Seat', 95, { weeklyResetIn: 47 * HOUR }), row('Spare Seat', 55, { weeklyResetIn: 12 * HOUR })]);
    expect(pickFromPool(POOL, usage, never, NOW)).toEqual({ id: 'claude_spare', reason: 'use before reset: 55% weekly left' });
  });

  it('excluded or used-up seats never take a turn; with nothing left there is no pick (review)', () => {
    const usage = snap([row('Team Seat', 80, { recommendationExcluded: true }), row('Spare Seat', 50, { session: 0 })], [{ provider: 'Claude', account: 'Extra Seat', message: 'not signed in' }]);
    expect(pickFromPool(POOL, usage, never, NOW)).toBeNull();
  });

  it('an aliased row without a display name still counts as its seat (review)', () => {
    const codexPool: PoolAccount[] = [
      { id: 'codex_home', name: 'Home ChatGPT', driver: 'codex' },
      { id: 'codex_work', name: 'Work ChatGPT', driver: 'codex' },
    ];
    const used = { ...row('home@example.com', 30, { session: 0 }), provider: 'Codex' };
    const usage: UsageSnapshot = { accounts: [used], errors: [], aliases: { 'Codex:home@example.com': 'codex_home' } };
    // The home seat's fresh row is used up: only the work seat (quota unknown) may take a turn.
    expect(pickFromPool(codexPool, usage, new Map([['codex_work', NOW]]), NOW)?.id).toBe('codex_work');
  });

  it('a stale row that showed a window used up keeps that seat out until it resets (review)', () => {
    const stale = iso(NOW - 3 * HOUR);
    const usage = snap([row('Team Seat', 0, { updatedAt: stale }), row('Spare Seat', 60, { updatedAt: stale })]);
    expect(pickFromPool(POOL.slice(0, 2), usage, never, NOW)?.id).toBe('claude_spare');
  });

  it('a provider-wide error takes every seat of that provider out (review)', () => {
    const stale = iso(NOW - 3 * HOUR);
    const usage = snap([row('Team Seat', 80, { updatedAt: stale })], [{ provider: 'Claude', account: 'All accounts', message: 'collector failed' }]);
    expect(pickFromPool(POOL, usage, never, NOW)).toBeNull();
  });

  it('stale rows (the monitor\'s quiet hours) are quota unknown: those seats take turns', () => {
    const stale = iso(NOW - 3 * HOUR);
    const usage = snap([row('Team Seat', 80, { updatedAt: stale }), row('Spare Seat', 50, { updatedAt: stale }), row('Extra Seat', 0)]);
    const pick = pickFromPool(POOL, usage, new Map([['claude_team', NOW - 60_000]]), NOW);
    expect(pick).toEqual({ id: 'claude_spare', reason: 'quota unknown: taking turns' });
  });

  it('without the monitor, the pool takes turns', () => {
    const pick = pickFromPool(POOL, null, new Map([['claude_team', NOW], ['claude_spare', NOW - HOUR]]), NOW);
    expect(pick).toEqual({ id: 'claude_extra', reason: 'usage monitor unavailable: taking turns' });
  });
});

describe('UsageMonitor', () => {
  it('reads /api/usage, caches it a minute, and gives null when the monitor is down', async () => {
    let calls = 0;
    let clock = NOW;
    let down = false;
    const fetcher = (async () => {
      calls += 1;
      if (down) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify({ usage: { accounts: [row('Team Seat', 50)], errors: [] } }));
    }) as unknown as typeof fetch;
    const monitor = new UsageMonitor('http://usage.test/api/usage', () => clock, fetcher);
    expect((await monitor.snapshot())?.accounts).toHaveLength(1);
    await monitor.snapshot();
    expect(calls).toBe(1);
    clock += 61_000;
    down = true;
    // The last good snapshot stands through an outage (review).
    expect((await monitor.snapshot())?.accounts).toHaveLength(1);
    expect(calls).toBe(2);
    const cold = new UsageMonitor('http://usage.test/api/usage', () => clock, fetcher);
    expect(await cold.snapshot()).toBeNull();
  });

  it('matches a signed-out collector identity to its T3 account through the aliases (review)', () => {
    const codexPool: PoolAccount[] = [
      { id: 'codex_home', name: 'Home ChatGPT', driver: 'codex' },
      { id: 'codex_work', name: 'Work ChatGPT', driver: 'codex' },
    ];
    const usage: UsageSnapshot = { accounts: [], errors: [{ provider: 'Codex', account: 'someone@example.com', message: 'signed out' }], aliases: { 'Codex:someone@example.com': 'codex_home' } };
    expect(pickFromPool(codexPool, usage, new Map([['codex_work', NOW]]), NOW)).toEqual({ id: 'codex_work', reason: 'quota unknown: taking turns' });
  });
});
