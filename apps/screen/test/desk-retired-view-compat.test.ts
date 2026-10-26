import { describe, expect, it } from 'vitest';
import { normalizeRetiredView, viewToQuery } from '../public/desk/query.js';
import { itemInFeedScope, scopedFeedPosts } from '../public/desk/feed-scope.js';
// @ts-expect-error browser module
import { describeView } from '../public/desk/list-views.js';
// @ts-expect-error browser module
import { inboxViews, nextListReport, shownSpaceViews, spaceViews } from '../public/desk/next/model.js';
// @ts-expect-error browser module
import { searchOptions, filterHits } from '../public/desk/search-model.js';
// @ts-expect-error browser module
import { needsYouCount } from '../public/desk/feed.js';

const row = (id: string, source: string, facts = {}) => ({
  id, source, agentId: source === 'loom' ? 'loom' : 'helper', agentName: 'Helper', place: id,
  disposition: 'active', seen: 'seen', facts,
  status: { pill: 'needs', countsForOwner: true, audience: 'owner', busy: null },
});
const rows = [row('discord:unstaged', 'discord'), row('loom:unstaged', 'loom'), row('loom:building', 'loom', { stage: 'building' })];
const ids = (items: any[]) => items.map((i) => i.id).sort();
const base = { id: 'top', name: 'Top', status: ['active'], group: 'stage', sort: 'recent', fold: false };

describe('retired saved view compatibility', () => {
  it.each([
    { stage: ['discovery', 'building'] },
    { where: { stage: { in: ['discovery', 'building'] } } },
    { stage: ['discovery'], where: { stage: { not: ['feedback'], unset: false } } },
  ])('covers list rows, counts, search, feed, spaces and descriptions: %j', (filter) => {
    const view = { ...base, ...filter };
    const original = JSON.stringify(view);
    {

      const expected = ids(rows);
      const state = {
        listViews: [view], spaceViews: [view], projects: [], now: Date.now(),
        lists: { active: { items: rows, loaded: true }, snoozed: { items: [], loaded: true }, history: { items: [], loaded: true } },
        nextRoute: { page: 'inbox', view: 'top' }, search: { tab: 'top' },
      };
      const shown = inboxViews(state).find((v: any) => v.view.id === 'top');
      expect(ids(shown.items)).toEqual(expected);
      expect(shown.view.group).toBe('live');
      const report = nextListReport(state);
      expect(ids(report.rows)).toEqual(expected);
      expect(report.tabs.find((t: any) => t.id === 'top').count).toBe(expected.length);
      expect(searchOptions(state).where.stage).toEqual(undefined);
      expect(ids(filterHits(rows.map((row) => ({ row })), { view }).map((h: any) => h.row))).toEqual(expected);
      const ctx = { listViews: [view] };
      expect(ids(rows.filter((r) => itemInFeedScope(r, 'tab:top', ctx)))).toEqual(expected);
      expect(scopedFeedPosts(rows.map((r) => ({ itemId: r.id })), Object.fromEntries(rows.map((r) => [r.id, r])), 'tab:top', ctx).map((p) => p.itemId).sort()).toEqual(expected);
      expect(needsYouCount(state.lists, state.now, 'tab:top', ctx)).toBe(expected.length);
      // Space views store filters in where, with the same effective stage predicate.
      const spaces = shownSpaceViews({ ...state, spaceViews: [{ ...view, where: viewToQuery(view).where }] });
      expect(ids(spaceViews(rows, [], spaces)[0].items)).toEqual(expected);
      expect(spaces[0].group).toBe('status');
      expect(describeView(view).toLowerCase().includes('stage')).toBe(false);
      expect(JSON.stringify(view)).toBe(original);
    }
  });

  it('preserves unrelated narrowing predicates', () => {
    const view = { ...base, stage: ['building'], where: { stage: { in: ['discovery'] }, source: { in: ['discord'] } } };
    expect(viewToQuery(normalizeRetiredView(view)).where).toEqual({ disposition: { in: ['active'] }, source: { in: ['discord'] } });
  });
});
