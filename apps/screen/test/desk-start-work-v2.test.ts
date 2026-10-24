import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usageByAccount, type PoolAccount, type UsageMonitor, type UsageRow, type UsageSnapshot } from '../server/desk/start-work-accounts.js';
import { attachmentProblems, publicOptions, publicResult, StartWork } from '../server/desk/start-work.js';
// @ts-expect-error plain browser module, no types
import { accountLine, modelName, pickerGroups, resetWhen, titleFrom, whyLine } from '../public/desk/start-work.js';
import { makeHarness, NOW as HNOW, type Harness } from './desk-harness.js';

// Start work v2 (TGO-954): the sheet's account picker reads each seat's headroom, overlapping
// starts take different seats, images go with the first message, and a new thread's
// worktree setup shows on its card stage by stage. Synthetic names and data only.

const NOW = Date.parse('2026-10-13T17:00:00Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

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
    ],
    ...rest,
  };
}
const snap = (accounts: UsageRow[], errors: UsageSnapshot['errors'] = []): UsageSnapshot => ({ accounts, errors });

describe('each account’s headroom for the picker', () => {
  const seats: PoolAccount[] = [
    { id: 'claude_team', name: 'Team Seat', driver: 'claudeAgent' },
    { id: 'claude_spare', name: 'Spare Seat', driver: 'claudeAgent' },
    { id: 'claude_home', name: 'Home Seat', driver: 'claudeAgent' },
    { id: 'claude_gone', name: 'Gone Seat', driver: 'claudeAgent' },
    { id: 'codex_work', name: 'Work ChatGPT', driver: 'codex' },
  ];

  it('reads weekly and 5-hour headroom, the dashboard’s rank, use-before-reset, exclusions and outages', () => {
    const usage = snap(
      [
        row('Team Seat', 94),
        row('Spare Seat', 91, { weeklyResetIn: 20 * HOUR }),
        row('Home Seat', 77, { recommendationExcluded: true }),
        { ...row('Work ChatGPT', 100), provider: 'Codex', windows: [{ kind: 'secondary', title: '7 day', usedPercent: 0, remainingPercent: 100, windowMinutes: 10_080, resetsAt: iso(NOW + 6 * 24 * HOUR) }] },
      ],
      [{ provider: 'Claude', account: 'Gone Seat', message: 'signed out' }],
    );
    const byId = usageByAccount(seats, usage, NOW);
    expect(byId.get('claude_spare')).toMatchObject({ weekly: 91, session: 90, useBeforeReset: true, rank: 0, status: 'fresh' });
    expect(byId.get('claude_team')).toMatchObject({ weekly: 94, useBeforeReset: false, rank: 1 });
    expect(byId.get('claude_home')).toMatchObject({ weekly: 77, excluded: true, rank: null });
    expect(byId.get('claude_gone')).toMatchObject({ status: 'down', weekly: null });
    expect(byId.get('codex_work')).toMatchObject({ weekly: 100, session: null, rank: 0 });
  });

  it('a seat with a reading and a collector error (rate-limited) is stale, not down', () => {
    const usage = snap([row('Team Seat', 80, { updatedAt: iso(NOW - 40 * 60_000) })], [{ provider: 'Claude', account: 'Team Seat', message: 'rate-limited; showing the last live reading' }]);
    expect(usageByAccount(seats, usage, NOW).get('claude_team')).toMatchObject({ status: 'stale', weekly: 80 });
  });

  it('a provider-wide error takes every seat of that provider down (review on #484)', () => {
    const byId = usageByAccount(seats, snap([], [{ provider: 'Claude', account: 'All accounts', message: 'collector failed' }]), NOW);
    expect(['claude_team', 'claude_spare', 'claude_home', 'claude_gone'].map((id) => byId.get(id)!.status)).toEqual(['down', 'down', 'down', 'down']);
    expect(byId.get('codex_work')!.status).toBe('none');
    // The monitor keeps the last rows through a provider-wide outage: those seats are still down.
    const kept = usageByAccount(seats, snap([row('Team Seat', 80)], [{ provider: 'Claude', account: 'All accounts', message: 'collector failed' }]), NOW);
    expect(kept.get('claude_team')).toMatchObject({ status: 'down', weekly: 80 });
  });

  it('an old reading is stale and never use-before-reset', () => {
    const byId = usageByAccount(seats, snap([row('Spare Seat', 91, { weeklyResetIn: 20 * HOUR, updatedAt: iso(NOW - 2 * HOUR) })]), NOW);
    expect(byId.get('claude_spare')).toMatchObject({ status: 'stale', useBeforeReset: false, rank: null });
  });
});

describe('the sheet’s own wording', () => {
  const now = NOW;
  it('names models the way the picker shows them', () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelName('claude-sonnet-5')).toBe('Sonnet 5');
    expect(modelName('gpt-6-astra')).toBe('GPT-6 Astra');
    expect(modelName('something-else')).toBe('something-else');
  });

  it('says when a window resets and why an account sits where it does', () => {
    expect(resetWhen(iso(now + 5 * HOUR), now)).toBe('in 5h');
    expect(resetWhen(iso(now + 30 * HOUR), now)).toBe('tomorrow');
    expect(accountLine({ usage: { weekly: 91, session: 100, resetsAt: iso(now + 26 * HOUR), useBeforeReset: true, excluded: false, status: 'fresh', rank: 0 } }, now)).toBe('Resets tomorrow with 91% unused');
    expect(accountLine({ usage: { weekly: 77, session: 98, resetsAt: iso(now + 40 * HOUR), useBeforeReset: false, excluded: true, status: 'fresh', rank: null } }, now)).toMatch(/^Kept for personal work · 77% week/);
    expect(accountLine({ usage: { status: 'down' } }, now)).toMatch(/can’t read/);
    expect(accountLine({}, now)).toBe('No usage reading');
  });

  it('lists ranked seats first and excluded seats last, Claude before ChatGPT', () => {
    const groups = pickerGroups([
      { id: 'a', driver: 'claudeAgent', usage: { rank: 1, weekly: 94 } },
      { id: 'b', driver: 'claudeAgent', usage: { excluded: true, weekly: 77 } },
      { id: 'c', driver: 'claudeAgent', usage: { rank: 0, weekly: 91 } },
      { id: 'd', driver: 'codex', usage: { rank: 0, weekly: 100 } },
    ]);
    expect(groups.map((g: { label: string; accounts: Array<{ id: string }> }) => [g.label, g.accounts.map((a) => a.id)])).toEqual([
      ['Claude', ['c', 'a', 'b']],
      ['ChatGPT', ['d']],
    ]);
  });

  it('explains the account in one line', () => {
    const repo = { name: 'work-repo', accountReason: 'use before reset: 91% weekly left', pool: ['x', 'y'] };
    expect(whyLine(repo, { name: 'Spare Seat' }, false)).toMatch(/resets soon with room left/);
    expect(whyLine({ name: 'tango', accountReason: 'the repo’s account' }, { name: 'Home Seat' }, false)).toBe('tango runs on Home Seat by default.');
    expect(whyLine(repo, { name: 'Team Seat' }, true)).toBe('You picked this account.');
    expect(titleFrom('Fix the import. Then add a test.')).toBe('Fix the import.');
  });
});
