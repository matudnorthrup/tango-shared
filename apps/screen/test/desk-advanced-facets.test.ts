import { describe, expect, it } from 'vitest';
import { facets, matches, facetCounts } from '../public/desk/query.js';
import { parseListViews } from '../server/desk/routes.js';
import { parseSpaceViews } from '../server/desk/space-views.js';

const row = (patch: any = {}) => ({ source: 'loom', kind: 'thread', disposition: 'active', facts: {}, ...patch, ...(patch.kind === 'job' ? { facts: { ...patch.facts, role: 'ops' } } : {}) });
const watching = (basis: string, patch: any = {}) => row({ watching: { basis, waitingOn: null }, ...patch });
describe('advanced shared facets', () => {
  it.each([
    [row(), null], [watching('job'), 'job'], [watching('background'), 'monitor'],
    [watching('summary'), 'check-back'], [watching('t3-snooze'), null],
    [watching('person', { watching: { basis: 'person', waitingOn: { kind: 'agent' } } }), 'agent'],
    [watching('person', { watching: { basis: 'person', waitingOn: {} } }), 'person'],
    [watching('person', { nextStep: 'watching', nextStepBasis: 'source:pr-review' }), 'review'],
  ])('reads wait facts %#', (item, value) => expect(facets.wait(item)).toBe(value));
  it('reads overdue presence, including unset', () => {
    expect(facets.overdue(row())).toBe('false');
    expect(facets.overdue(watching('summary', { watching: { overdue: { kind: 'check-back' } } }))).toBe('true');
  });
  it.each([
    [row(), null], [row({ kind: 'job' }), 'on-schedule'],
    [row({ kind: 'job', disposition: 'done' }), null],
    [row({ kind: 'job', facts: { schedule: { paused: true } } }), 'paused'],
    [row({ kind: 'job', status: { pill: 'working', busy: 'working' } }), 'running'],
    [row({ kind: 'job', status: { pill: 'failed' }, facts: { schedule: { paused: true } } }), 'failing'],
  ])('reads job health %#', (item, value) => expect(facets.health(item, { now: 1 })).toBe(value));
  it('reads source and known Loom account, without assigning accounts to other sources', () => {
    expect(facets.source(row())).toBe('loom');
    expect(facets.source(row({ source: undefined }))).toBeNull();
    expect(facets.account(row())).toBeNull();
    expect(facets.account(row({ facts: { account: 'seat-a' } }))).toBe('seat-a');
    expect(facets.account(row({ source: 't3', facts: { account: 'seat-a' } }))).toBeNull();
  });
  it('buckets last activity using the supplied clock, including missing activity', () => {
    const now = new Date(2026, 9, 19, 12).getTime();
    for (const [days, bucket] of [[0, 'today'], [1, 'week'], [7, 'month'], [30, 'older']] as const) {
      expect(facets.age(row({ lastActivityAt: now - days * 86400000 }), { now })).toBe(bucket);
    }
    expect(facets.age(row(), { now })).toBeNull();
    expect(facets.age(row({ lastActivityAt: NaN }), { now })).toBeNull();
  });
  it('keeps unknown and unset values narrow through the evaluator and counts', () => {
    const q = { scope: { kind: 'global' as const }, audience: 'all' as const, where: { wait: { in: ['future'] } } };
    expect(matches(row(), q)).toBe(false);
    expect(matches(row(), { ...q, where: { wait: { unset: true } } })).toBe(true);
    expect(facetCounts([row(), watching('job')], { ...q, where: {} }, 'wait')).toEqual(new Map([[null, 1], ['job', 1]]));
  });
  it.each(['wait', 'overdue', 'health', 'age', 'source', 'account'])('validates %s without widening unknown enum values', (facet) => {
    const value = { wait: 'agent', overdue: 'true', health: 'paused', age: 'week', source: 'loom', account: 'seat-a' }[facet]!;
    const view = { id: 'advanced', name: 'Advanced', group: 'none', where: { [facet]: { in: [value], unset: false } } };
    expect(parseListViews([view])).not.toHaveProperty('error');
    expect(parseSpaceViews([view])).not.toHaveProperty('error');
    if (!['source', 'account'].includes(facet)) {
      const bad = { ...view, where: { [facet]: { in: ['future'] } } };
      expect(parseListViews([bad])).toHaveProperty('error');
      expect(parseSpaceViews([bad])).toHaveProperty('error');
    }
  });
  it('accepts optional health grouping for space views', () => {
    expect(parseSpaceViews([{ id: 'jobs', name: 'Jobs', where: {}, group: 'health' }])).not.toHaveProperty('error');
  });
});
