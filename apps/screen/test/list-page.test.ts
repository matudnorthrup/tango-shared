import { describe, expect, it } from 'vitest';
import { parseListPage } from '../server/app.js';

// What a screen reports of its List reaches voice through this parser: the next layout's place must survive it.

describe('parseListPage', () => {
  const base = { tab: { id: 'ready', name: 'Needs you' }, tabs: [], project: null, projects: [] };

  it('keeps the next layout’s place, its agents and agent rows', () => {
    const page = parseListPage({
      ...base,
      place: { page: 'agent', id: 'sierra', name: 'Sierra' },
      agents: [{ id: 'sierra', name: 'Sierra' }, { id: '', name: 'nobody' }],
      rows: [{ kind: 'agent', id: 'sierra', title: 'Sierra', where: 'agent' }, { kind: 'item', id: 'x', title: 'Ferry', where: '' }],
    });
    expect(page?.place).toEqual({ page: 'agent', id: 'sierra', name: 'Sierra' });
    expect(page?.agents).toEqual([{ id: 'sierra', name: 'Sierra' }]);
    expect(page?.rows.map((r) => r.kind)).toEqual(['agent', 'item']);
  });

  it('keeps the System page (where Capacity lands) and the page’s views', () => {
    const page = parseListPage({
      ...base,
      rows: [],
      place: { page: 'system', view: 'capacity', name: 'System' },
      views: [{ id: 'overview', name: 'Overview', count: 0 }, { id: 'capacity', name: 'Capacity', count: 0 }, { id: '', name: 'nameless' }],
      view: { id: 'capacity', name: 'Capacity' },
    });
    expect(page?.place).toEqual({ page: 'system', view: 'capacity', name: 'System' });
    expect(page?.views).toEqual([{ id: 'overview', name: 'Overview', count: 0 }, { id: 'capacity', name: 'Capacity', count: 0 }]);
    expect(page?.view).toEqual({ id: 'capacity', name: 'Capacity' });
  });

  it('the classic List has no place; an unknown page is dropped', () => {
    expect(parseListPage({ ...base, rows: [] })).not.toHaveProperty('place');
    expect(parseListPage({ ...base, rows: [], place: { page: 'elsewhere', name: 'x' } })).not.toHaveProperty('place');
    expect(parseListPage({ ...base, rows: [], place: { page: 'inbox', view: 'ready', name: 'Needs you' } })?.place).toEqual({ page: 'inbox', view: 'ready', name: 'Needs you' });
  });
});
