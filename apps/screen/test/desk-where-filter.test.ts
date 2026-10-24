import { describe, expect, it } from 'vitest';
import { parseListViews } from '../server/desk/routes.js';
// @ts-expect-error browser module
import { DEFAULT_VIEWS } from '../public/desk/list-views.js';
import { matches, whereOf } from '../public/desk/query.js';
// @ts-expect-error browser module
import { applyFilter, facetLabel, filteredView, whereChoices, filterOptions, filterName, whereTree } from '../public/desk/next/model.js';

const projects = [
  { id: 'tango', name: 'Tango' },
  { id: 'desk', name: 'Desk', parent: 'project:tango' },
  { id: 'bike', name: 'Bike', parent: 'agent:sierra' },
  { id: 'quiet', name: 'Quiet' },
];
const row = (id: string, extra: Record<string, unknown> = {}, facts: Record<string, unknown> = {}) => ({ id, source: 'loom', agentId: 'loom', agentName: 'Loom', place: `${id} · thread`, disposition: 'active', facts, status: { pill: 'idle', audience: 'owner' }, ...extra });
const rows = [
  row('tango-thread', {}, { projectId: 'tango' }),
  row('desk-thread', {}, { projectId: 'desk' }),
  row('bike-thread', {}, { projectId: 'bike' }),
  row('sierra-chat', { source: 'discord', agentId: 'sierra', agentName: 'Sierra' }),
  row('loose-tango', { area: 'Tango-Fork' }),
  row('loose-t3', { source: 't3', agentId: 't3', area: 'Acme' }),
  row('bare', { source: 'loom', place: '' }),
];
const ids = (items: any[]) => items.map((i) => i.id).sort();

describe('the Where facet', () => {
  it('files a thread as the sidebar does: project and its parents, else a named agent, else loose with its repo', () => {
    const where = (id: string) => whereOf(rows.find((r) => r.id === id), { projects });
    expect(where('desk-thread')).toEqual(['project:desk', 'project:tango']);
    expect(where('bike-thread')).toEqual(['project:bike', 'agent:sierra']);
    expect(where('sierra-chat')).toEqual(['agent:sierra']);
    // Loom and T3 are tools, not agents.
    expect(where('loose-tango')).toEqual(['loose', 'repo:tango-fork']);
    expect(where('loose-t3')).toEqual(['loose', 'repo:acme']);
    expect(where('bare')).toEqual(['loose']);
  });

  it('a parent pick takes in its children; an agent pick takes in its projects; Not in a project takes in its repos', () => {
    expect(ids(applyFilter(rows, { where: ['project:tango'] }, projects))).toEqual(['desk-thread', 'tango-thread']);
    expect(ids(applyFilter(rows, { where: ['agent:sierra'] }, projects))).toEqual(['bike-thread', 'sierra-chat']);
    expect(ids(applyFilter(rows, { where: ['loose'] }, projects))).toEqual(['bare', 'loose-t3', 'loose-tango']);
    // Repo picks match whatever case a saved pick used.
    expect(matches(rows[4], { scope: { kind: 'global' }, audience: 'all', where: { where: { in: ['repo:Tango-Fork'] } } }, { projects })).toBe(true);
  });

  it('lists in the sidebar shape with rolled-up counts, skipping empty places but keeping picked ones', () => {
    const options = filterOptions(rows, projects, {});
    const tree = whereTree(options.where, projects, [{ id: 'sierra', name: 'Sierra' }], []);
    expect(tree.map((r: any) => [r.label, r.depth, r.n])).toEqual([
      ['Tango', 0, 2], ['Desk', 1, 1],
      ['Sierra', 0, 2], ['Bike', 1, 1],
      ['Not in a project', 0, 3], ['Acme', 1, 1], ['Tango-Fork', 1, 1],
    ]);
    const picked = whereTree(filterOptions(rows, projects, { where: ['project:quiet'] }).where, projects, [], ['project:quiet']);
    expect(picked.some((r: any) => r.value === 'project:quiet' && r.n === 0)).toBe(true);
  });

  it('names picks for chips and saved tabs', () => {
    expect(facetLabel('where', 'project:desk', projects, rows)).toBe('Desk');
    expect(facetLabel('where', 'agent:sierra', projects, rows)).toBe('Sierra');
    expect(facetLabel('where', 'loose', projects, rows)).toBe('Not in a project');
    expect(filterName({ where: ['project:tango', 'repo:tango-fork'] }, projects, rows)).toBe('Tango · Tango-Fork');
  });

  it('saves a tab with a Where pick through the server validator (Codex review on #1035)', () => {
    const saved = filteredView(DEFAULT_VIEWS[1], { where: ['project:tango', 'repo:tango-fork'] }, DEFAULT_VIEWS, 'Tango');
    const parsed = parseListViews([...DEFAULT_VIEWS, saved]) as any;
    expect(parsed).not.toHaveProperty('error');
    expect(parsed.views.at(-1).where.where).toEqual({ in: ['project:tango', 'repo:tango-fork'] });
  });

  it('saving a parent tab narrowed to a child keeps the child, either way round (Codex review on #1035)', () => {
    const parentTab = { id: 'tango', name: 'Tango', status: ['active'], group: 'none', sort: 'recent', where: { where: { in: ['project:tango'] } } };
    const childTab = { ...parentTab, id: 'desk', where: { where: { in: ['project:desk'] } } };
    const kept = (view: any) => ids(rows.filter((r) => matches(r, { scope: { kind: 'global' }, audience: 'all', where: { where: view.where.where } }, { projects })));
    expect(kept(filteredView(parentTab, { where: ['project:desk'] }, [parentTab], 'Desk', projects))).toEqual(['desk-thread']);
    expect(kept(filteredView(childTab, { where: ['project:tango'] }, [childTab], 'Desk', projects))).toEqual(['desk-thread']);
    expect(kept(filteredView(parentTab, { where: ['agent:sierra'] }, [parentTab], 'None', projects))).toEqual([]);
    const notTango = { ...parentTab, where: { where: { not: ['project:tango'] } } };
    expect(kept(filteredView(notTango, { where: ['project:desk', 'agent:sierra'] }, [notTango], 'Sierra', projects))).toEqual(['bike-thread', 'sierra-chat']);
  });

  it('offers Where in the tab editor with each place named by its path', () => {
    const state = { projects, lists: { active: { items: rows } }, now: 1 };
    const choices = whereChoices(rows, state, ['project:quiet']);
    expect(choices).toEqual(expect.arrayContaining([['project:desk', 'Tango › Desk'], ['repo:acme', 'Not in a project › Acme'], ['project:quiet', 'Quiet']]));
  });

  it('keeps honoring picks from the retired facets', () => {
    expect(ids(applyFilter(rows, { space: ['project:desk'] }, projects))).toEqual(['desk-thread']);
    expect(ids(applyFilter(rows, { agent: ['sierra'] }, projects))).toEqual(['sierra-chat']);
  });
});
