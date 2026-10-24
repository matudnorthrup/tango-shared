import { describe, expect, it } from 'vitest';
import { parseListViews } from '../server/desk/routes.js';
// @ts-expect-error browser module
import { viewSections } from '../public/desk/list-views.js';
// @ts-expect-error browser module
import { facetFilter, facetPicks } from '../public/desk/views-editor.js';

const NONE = '\u0000none';

describe('the tab editor\'s one facet control', () => {
  it('reads and writes "any of these" with Unset as a value', () => {
    expect(facetFilter(['person', NONE], false)).toEqual({ in: ['person'], unset: true });
    expect(facetPicks({ in: ['person'], unset: true })).toEqual({ exclude: false, picked: ['person', NONE], also: [] });
    expect(facetFilter([], false)).toBeUndefined();
  });
  it('turns the same picks into "none of these" with Exclude instead', () => {
    expect(facetFilter(['person', NONE], true)).toEqual({ not: ['person'], unset: false });
    expect(facetPicks({ not: ['person'], unset: false })).toEqual({ exclude: true, picked: ['person', NONE], also: [] });
    expect(facetPicks({ unset: false })).toEqual({ exclude: true, picked: [NONE], also: [] });
  });
  it('keeps a saved tab\'s exclusions beside its picks until they\'re dropped', () => {
    const picks = facetPicks({ in: ['project:tango'], not: ['project:desk'] });
    expect(picks).toEqual({ exclude: false, picked: ['project:tango'], also: ['project:desk'] });
    expect(facetFilter([...picks.picked, 'project:quiet'], false, picks.also)).toEqual({ in: ['project:tango', 'project:quiet'], not: ['project:desk'] });
    expect(facetFilter(picks.picked, false)).toEqual({ in: ['project:tango'] });
  });
});

describe('a tab\'s Oldest first sort', () => {
  const items = [1, 3, 2].map((n) => ({ id: `t${n}`, source: 'loom', disposition: 'active', lastOwnerMessageAt: n * 1000, facts: {}, status: { pill: 'idle' } }));
  const ids = (view: object, order = 'newest') => viewSections(items, { id: 'x', name: 'X', group: 'none', fold: false, ...view }, [], [], order).flatMap((s: { items: Array<{ id: string }> }) => s.items.map((i) => i.id));
  it('puts the thread left longest first, whatever this device picks', () => {
    expect(ids({ sort: 'recent' })).toEqual(['t3', 't2', 't1']);
    expect(ids({ sort: 'oldest' })).toEqual(['t1', 't2', 't3']);
    expect(ids({ sort: 'oldest' }, 'oldest')).toEqual(['t1', 't2', 't3']);
    expect(ids({ sort: 'recent' }, 'oldest')).toEqual(['t1', 't2', 't3']);
  });
  it('turns a done-only tab around too, keeping its by-when-done order', () => {
    const done = [1, 3, 2].map((n) => ({ id: `d${n}`, source: 'loom', disposition: 'done', doneAt: n * 1000, facts: {}, status: { pill: 'idle' } }));
    const ids = (sort: string, order = 'newest') => viewSections(done, { id: 'done', name: 'Done', status: ['done'], group: 'none', fold: false, sort }, [], [], order).flatMap((s: { items: Array<{ id: string }> }) => s.items.map((i) => i.id));
    expect(ids('recent')).toEqual(['d3', 'd2', 'd1']);
    expect(ids('oldest')).toEqual(['d1', 'd2', 'd3']);
    expect(ids('oldest', 'oldest')).toEqual(['d1', 'd2', 'd3']);
  });
  it('saves on the desk server', () => {
    expect(parseListViews([{ id: 'x', name: 'X', group: 'live', sort: 'oldest' }])).not.toHaveProperty('error');
  });
});
