import { describe, expect, it } from 'vitest';
// @ts-expect-error browser module
import { FILTER_FACETS, NONE, facetLabel, filterOptions, spaceGroups, SPACE_VIEWS } from '../public/desk/next/model.js';

describe('advanced facet controls', () => {
  it('puts only Source and Account under Advanced, with the clock facets in the main list', () => {
    expect(FILTER_FACETS.filter(([, , where]: string[]) => where === 'advanced').map(([key]: string[]) => key)).toEqual(['source', 'account']);
    // Health is a jobs facet: the Inbox lists no jobs, so it is only offered in the space views' editor.
    expect(FILTER_FACETS.find(([facet]: string[]) => facet === 'health')?.[2]).toBe('spaces');
    for (const key of ['wait', 'overdue', 'age']) expect(FILTER_FACETS.find(([facet]: string[]) => facet === key)?.[2]).toBeUndefined();
    const options = filterOptions([], [], {});
    expect(options.wait.map((o: any) => o.value)).toContain(NONE);
    expect(options.age.map((o: any) => o.value)).toContain(NONE);
    expect(options.overdue.map((o: any) => o.value).sort()).toEqual(['false', 'true']);
    expect(facetLabel('wait', 'review')).toBe('PR review');
    expect(facetLabel('health', NONE)).toBe('No health');
  });

  it('retains saved inventory picks with zero matches so they can be removed', () => {
    const options = filterOptions([], [], { source: ['retired-runtime'], account: ['former-account'] });
    expect(options.source).toContainEqual({ value: 'retired-runtime', label: 'retired-runtime', n: 0 });
    expect(options.account).toContainEqual({ value: 'former-account', label: 'former-account', n: 0 });
  });

  it('groups a custom Jobs view by shared health without changing built-in views', () => {
    expect(SPACE_VIEWS.find((v: any) => v.id === 'jobs').group).toBeUndefined();
    const job = (id: string, patch = {}) => ({ id, facts: { role: 'ops' }, status: { pill: 'idle', busy: null, audience: 'none' }, ...patch });
    const items = [job('idle'), job('paused', { facts: { role: 'ops', schedule: { paused: true } } }), job('failed', { status: { pill: 'failed', busy: null, audience: 'none' } })];
    const groups = spaceGroups({ group: 'health' }, items, 1000);
    expect(groups.map((g: any) => [g.key, g.items.map((i: any) => i.id)])).toEqual([['failing', ['failed']], ['paused', ['paused']], ['on-schedule', ['idle']]]);
  });
});
