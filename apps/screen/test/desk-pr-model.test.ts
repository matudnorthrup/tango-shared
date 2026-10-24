import { describe, expect, it } from 'vitest';
// @ts-expect-error browser module
import { prChip, prGroups, prColor, threadPrs, otherLinks, prCount } from '../public/desk/next/pr-model.js';
const pr = (state = 'open', over = {}) => ({ state, relation: 'opened', watched: true, ...over });
describe('PR display facts', () => {
  it('counts states in priority order, omits mentions, and only hints on Idle or Finished', () => {
    const item = { status: { pill: 'idle' }, prs: [pr('merged'), pr('open', { watched: false }), pr('merged'), pr('closed', { relation: 'mentioned' })] };
    expect(prChip(item)).toMatchObject({ state: 'open', words: '1 open · 2 merged · not watched' });
    for (const pill of ['working', 'needs', 'waiting', 'failed']) expect(prChip({ ...item, status: { pill } }).words).toBe('1 open · 2 merged');
    for (const state of ['open', 'draft', 'merged', 'closed']) expect(prChip({ prs: [pr(state)] }).words).toBe(state);
    expect(prChip({ prs: [pr('open', { relation: 'mentioned' })] })).toBeNull();
    expect(prChip({ status: { pill: 'finished' }, prs: [pr('draft', { watched: false })] }).words).toBe('draft · not watched');
    expect(prChip({ status: { pill: 'idle' }, prs: [pr('closed', { watched: false })] }).words).toBe('closed');
  });
  it('groups draft with open and keeps mentioned PRs folded and separate', () => {
    const item = { prs: [pr('closed'), pr('draft'), pr('merged'), pr('open'), pr('merged', { relation: 'mentioned' })] };
    expect(prGroups(item).map((g: any) => [g.label, g.prs.length, !!g.folded])).toEqual([['Open', 2, false], ['Merged', 1, false], ['Closed', 1, false], ['Mentioned', 1, true]]);
    expect(prCount(item)).toBe(4);
    expect(prCount({ prs: [pr('open', { relation: 'mentioned' })] })).toBe(1);
  });
  it('uses failure before progress, preserves terminal and draft colors', () => {
    expect(prColor(pr('open', { checks: 'failing', review: 'pending' }))).toBe('bad');
    expect(prColor(pr('open', { checks: 'running', review: 'changes_requested' }))).toBe('bad');
    expect(prColor(pr('open', { review: 'pending' }))).toBe('wait');
    expect(prColor(pr('open', { checks: 'running' }))).toBe('wait');
    expect(prColor(pr())).toBe('open');
    for (const state of ['draft', 'merged']) expect(prColor(pr(state, { checks: 'failing' }))).toBe(state);
    expect(prColor(pr('closed'))).toBe('bad');
  });
  it('preserves legacy watches by canonical PR URL', () => {
    const item = {
      artifacts: [
        { kind: 'pr', url: 'https://github.com/example/repo/pull/4/files' },
        { kind: 'pr', url: 'https://github.com/example/repo/pull/5' },
      ],
      facts: { prWatches: [{ url: 'https://github.com/EXAMPLE/REPO/pull/004?tab=checks#review' }] },
    };
    expect(threadPrs(item).map((p: any) => p.watched)).toEqual([true, false]);
    expect(threadPrs({ ...item, facts: { prWatches: null } }).map((p: any) => p.watched)).toEqual([false, false]);
    expect(threadPrs({ ...item, prs: [pr('open', { watched: false })] })[0].watched).toBe(false);
  });
  it('retains legacy PR links as mentions without duplicating Links', () => {
    const a = { kind: 'pr', url: 'https://github.com/example/repo/pull/4', label: 'Fix' };
    const item = { artifacts: [a, a, { kind: 'doc', url: 'https://example.com' }] };
    expect(threadPrs(item)).toHaveLength(1);
    expect(prChip(item)).toBeNull();
    expect(otherLinks(item)).toHaveLength(1);
    expect(threadPrs({ ...item, prs: [] })).toEqual([]);
  });
});
