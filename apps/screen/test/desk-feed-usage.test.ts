import { describe, expect, it } from 'vitest';
import { ringNames, shortReset, usageGroups, usageLevel } from '../public/desk/feed-usage.js';

// Account usage above the feed (feed-usage.js): the Capacity snapshot drawn as a ring per account.

const NOW = new Date(2026, 9, 21, 9, 41).getTime();
const at = (days: number, hours: number, minutes = 0) => new Date(2026, 9, 21 + days, hours, minutes).toISOString();

const account = (over: Record<string, unknown>) => ({ id: 'a', name: 'A', color: null, provider: 'claude', status: 'fresh', fiveHour: null, weekly: null, ...over });

describe('feed usage rings', () => {
  it('drops a trailing parenthetical unless it tells two accounts of a provider apart', () => {
    expect(ringNames([
      account({ name: 'Acme (Personal)' }),
      account({ name: 'Acme (Team)' }),
      account({ name: 'Sky (Personal)' }),
      account({ name: 'Acme', provider: 'codex' }),
      account({ name: 'Codex (Personal)', provider: 'codex' }),
    ])).toEqual(['Acme (Personal)', 'Acme (Team)', 'Sky', 'Acme', 'Codex']);
  });

  it('reads low and critical shares', () => {
    expect([usageLevel(8), usageLevel(10), usageLevel(22), usageLevel(25), usageLevel(52), usageLevel(null)]).toEqual(['crit', 'crit', 'low', 'low', null, null]);
  });

  it('says when a window resets in a few characters', () => {
    expect(shortReset(at(0, 12, 59), NOW)).toBe('12:59p');
    expect(shortReset(at(2, 2), NOW)).toBe('Fri 2a');
    expect(shortReset(at(9, 2), NOW)).toBe('Oct 30');
    expect(shortReset(null, NOW)).toBeNull();
  });

  it('groups the snapshot by provider, Claude first, with colors and readings', () => {
    const groups = usageGroups({
      accounts: [
        account({ id: 'x', name: 'Acme Games', provider: 'codex', weekly: { left: 88.6, resetsAt: at(6, 5) } }),
        account({ id: 'p', name: 'Personal', color: '#123456', fiveHour: { left: 6, resetsAt: at(0, 10, 19) }, weekly: { left: 52, resetsAt: at(1, 2) } }),
        account({ id: 's', name: 'Spare', status: 'down' }),
      ],
    }, NOW);
    expect(groups.map((g) => g.label)).toEqual(['Claude', 'Codex']);
    expect(groups[0]!.rings[0]).toMatchObject({ id: 'p', color: '#123456', week: 52, session: 6, reset: 'Thu 2a', sessionReset: '10:19a', read: 'fresh' });
    expect(groups[0]!.rings[1]).toMatchObject({ id: 's', week: null, read: 'none' });
    expect(groups[1]!.rings[0]).toMatchObject({ week: 89, session: null, color: 'var(--a-watson)' });
    expect(usageGroups(null, NOW)).toEqual([]);
    // No usage monitor: no account has a reading, and there is no strip.
    expect(usageGroups({ accounts: [account({ status: 'none' }), account({ id: 'b', status: 'down' })] }, NOW)).toEqual([]);
  });
});
