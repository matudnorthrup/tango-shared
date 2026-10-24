import { describe, expect, it } from 'vitest';
import { parseListViews } from '../server/desk/routes.js';
import { parseHiddenSections } from '../server/desk/projects.js';
import { parseSearchFields } from '../server/desk/search-query.js';
// @ts-expect-error plain browser module, no types
import { onSchedule } from '../public/desk/next/model.js';
// @ts-expect-error plain browser module, no types
import { DEFAULT_VIEWS, viewItems, viewsOf } from '../public/desk/list-views.js';
// @ts-expect-error plain browser module, no types
import { hitStatus } from '../public/desk/search-model.js';

// Every saved setting and search speaks the six pills (Codex review on #928).
describe('the six-pill vocabulary everywhere', () => {
  const view = (live: string[], where?: unknown) => parseListViews([{ id: 'v', name: 'V', group: 'live', status: ['active'], live, ...(where ? { where } : {}) }]);
  it('saves views filtered to the new states, and reads retired ones in the new words', () => {
    expect(view(['waiting', 'idle', 'unknown'])).toMatchObject({ views: [{ live: ['waiting', 'idle', 'unknown'] }] });
    expect(view(['watching', 'held', 'ready'])).toMatchObject({ views: [{ live: ['waiting', 'idle'] }] });
    expect(view([], { live: { in: ['waiting'], not: ['todo'] } })).toMatchObject({ views: [{ where: { live: { in: ['waiting'], not: ['idle'] } } }] });
    expect(view(['bogus'])).toHaveProperty('error');
  });
  it('saves project sections by the new states; retired keys migrate', () => {
    expect(parseHiddenSections(['waiting', 'idle', 'unknown', 'done'])).toEqual(['waiting', 'idle', 'unknown', 'done']);
    expect(parseHiddenSections(['watching', 'ready', 'other'])).toEqual(['waiting', 'idle']);
    expect(parseHiddenSections(['bogus'])).toBeNull();
  });
  it('search finds is:waiting, and is:watching still finds Waiting rows', () => {
    expect(parseSearchFields('is:waiting').queries[0]?.where).toEqual({ live: { in: ['waiting'] } });
    expect(parseSearchFields('is:watching').queries[0]?.where).toEqual({ live: { in: ['waiting'] } });
    expect(parseSearchFields('is:unknown').queries[0]?.where).toEqual({ live: { in: ['unknown'] } });
    expect(hitStatus({ disposition: 'active', status: { pill: 'waiting' }, facts: {} })).toBe('waiting');
    expect(hitStatus({ disposition: 'active', status: { pill: 'waiting' }, facts: { held: { reason: 'capacity' } } })).toBe('held by Loom');
    expect(hitStatus({ disposition: 'active', status: { pill: 'idle' }, facts: {} })).toBe('idle');
  });
  it('a job Loom holds is not on schedule', () => {
    const job = (facts: Record<string, unknown>) => ({ id: 'loom:j', source: 'loom', kind: 'thread', disposition: 'active', facts: { role: 'ops', ...facts }, status: { pill: 'waiting' } });
    const scheduled = { id: 'loom:j', source: 'loom', kind: 'thread', disposition: 'active', facts: { role: 'ops' }, status: { pill: 'idle' } };
    expect(onSchedule(scheduled)).toBe(true);
    expect(onSchedule({ ...scheduled, status: { pill: 'waiting' }, facts: { role: 'ops', held: { reason: 'capacity' } } })).toBe(false);
    expect(onSchedule(job({ held: { reason: 'capacity' } }))).toBe(false);
  });
  it('edits to the built-in tabs persist; a list from before the four tabs keeps only its own views', () => {
    const edited = [{ ...DEFAULT_VIEWS[1], name: 'Going' }, DEFAULT_VIEWS[0], DEFAULT_VIEWS[3]];
    const parsed = parseListViews(edited);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(viewsOf(parsed.views).map((v: { id: string; name: string }) => `${v.id}:${v.name}`)).toEqual(['active:Going', 'needs:Needs you', 'done:Done']);
    expect(viewsOf([{ id: 'ready', name: 'Ready', group: 'stage' }, { id: 'mine', name: 'Mine', group: 'none' }]).map((v: { id: string }) => v.id)).toEqual(['needs', 'active', 'later', 'done', 'mine']);
  });
  it('a row marked done with its brief still open stays in Needs you', () => {
    const row = { id: 'x', source: 'loom', kind: 'thread', disposition: 'done', status: { layer: 'needs', pill: 'needs', countsForOwner: true }, nextStep: 'your_move', facts: {} };
    expect(viewItems({ active: { items: [row] } }, DEFAULT_VIEWS[0]).map((i: { id: string }) => i.id)).toEqual(['x']);
  });
});
