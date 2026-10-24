import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser module, no types
import { ThreadActs, threadMenu } from '../public/desk/next/thread.js';

// @ts-expect-error plain browser module, no types
import { ownerPlaces } from '../public/desk/next/model.js';

// The ⋯ menu's Kind and Reports to (docs/specs/spaces.md, Two relations): a job or worker never reports to no one.

type Entry = { key?: string; label: string; disabled?: boolean; on?: boolean; sub?: Entry[]; onSelect: () => void };
const thread = (id: string, facts: object = {}, extra: object = {}) => ({ id, source: 'loom', place: `tango · ${id}`, lastActivityAt: 1, disposition: 'active', facts, ...extra });

function menuFor(item: object, items: object[], spaceStatus = 'sent') {
  const calls: unknown[][] = [];
  const store = { state: { lists: { active: { items } }, projects: [{ id: 'p1', name: 'Desk', createdAt: 0 }], now: 0 }, setAgentSpace: (...a: unknown[]) => { calls.push(['space', ...a]); return { status: spaceStatus }; }, setProject: (...a: unknown[]) => calls.push(a), handOff: (...a: unknown[]) => calls.push(a), setRole: (...a: unknown[]) => calls.push(a) };
  const menu = threadMenu(item, store) as (Entry | string)[];
  const find = (label: string) => menu.find((e): e is Entry => typeof e === 'object' && e.label === label);
  return { calls, find };
}

describe('Kind on the ⋯ menu', () => {
  it('a thread in a project becomes a worker reporting to the lead', () => {
    const me = thread('me', { projectId: 'p1' });
    const lead = thread('lead', { projectId: 'p1', role: 'default' });
    const { calls, find } = menuFor(me, [me, lead]);
    find('Kind')!.sub!.find((e) => e.label.startsWith('Worker'))!.onSelect();
    expect(calls).toEqual([['me', 'worker', 'lead']]);
    expect(find('Hand off as a job')).toBeDefined();
  });

  it('a thread with no lead to default to is handed off in one step, never made a worker for no one', () => {
    const me = thread('me');
    const other = thread('other');
    const { calls, find } = menuFor(me, [me, other]);
    const worker = find('Kind')!.sub!.find((e) => e.label.startsWith('Worker'))!;
    expect(worker.disabled).toBe(true);
    find('Hand off as a worker')!.sub!.find((e) => e.label === 'No project')!.sub![0].onSelect();
    expect(calls).toEqual([['me', 'worker', 'other']]);
  });
});


describe('Reports to space and conversation picker', () => {
  it('replaces Move to project, with the lead first and the current owner checked', () => {
    const me = thread('me', { role: 'worker', projectId: 'p1', parentItemId: 'lead' });
    const lead = thread('lead', { role: 'default', projectId: 'p1' });
    const other = thread('other', { projectId: 'p1' });
    const { calls, find } = menuFor(me, [me, other, lead]);
    expect(find('Move to project')).toBeUndefined();
    const spaces = find('Reports to')!.sub!;
    expect(spaces[1]).toMatchObject({ key: 'project:p1', label: 'Desk' });
    const rows = spaces[1].sub!;
    expect(rows[0].label).toMatch(/ · lead$/);
    expect(rows[0].on).toBe(true);
    rows[1].onSelect();
    expect(calls).toEqual([['me', 'p1', 'other']]);
    const empty = spaces.find((s) => s.label === 'No project')!.sub!;
    expect(empty).toHaveLength(1);
    expect(empty[0].label).toBe('Move here · nothing to report to yet');
    empty[0].onSelect();
    expect(calls[1]).toEqual(['me', null]);
  });

  it.each(['p1', null])('offers the agent space and No project from %s', (projectId) => {
    const identity = { agentSpace: { id: 'helper', name: 'Helper' } };
    const me = thread('me', { ...identity, role: 'worker', projectId });
    const agentOwner = thread('agent-owner', identity);
    const personalOwner = thread('personal');
    const { calls, find } = menuFor(me, [me, agentOwner, personalOwner]);
    const spaces = find('Reports to')!.sub!;
    expect(spaces.some((s) => s.label === 'No project')).toBe(true);
    expect(spaces.find((s) => s.label === 'Helper')!.key).toBe('agent:helper');
    const rows = spaces.find((s) => s.label === 'Helper')!.sub!;
    expect(rows).toHaveLength(1);
    rows[0].onSelect();
    expect(calls).toEqual([['me', null, 'agent-owner']]);
  });

  it.each([true, false])('No project clears the agent assignment before moving (owner available: %s)', async (hasOwner) => {
    const me = thread('me', { role: 'worker', projectId: 'p1', agentSpace: { id: 'helper', name: 'Helper' } });
    const { calls, find } = menuFor(me, [me, ...(hasOwner ? [thread('personal')] : [])]);
    await find('Reports to')!.sub!.find((p) => p.key === 'personal')!.sub![0].onSelect();
    expect(calls).toEqual([['space', 'me', null], hasOwner ? ['me', null, 'personal'] : ['me', null]]);
  });

  it('does not move the project or owner if clearing the agent fails', async () => {
    const me = thread('me', { role: 'worker', projectId: 'p1', agentSpace: { id: 'helper', name: 'Helper' } });
    const { calls, find } = menuFor(me, [me, thread('personal')], 'failed');
    await find('Reports to')!.sub!.find((p) => p.key === 'personal')!.sub![0].onSelect();
    expect(calls).toEqual([['space', 'me', null]]);
  });

  it('keeps the thread’s Move to project and handoff menus', () => {
    const me = thread('me');
    const { find } = menuFor(me, [me, thread('other')]);
    expect(find('Move to project')!.sub![0].label).toBe('Desk');
    expect(find('Hand off as a worker')).toBeDefined();
    expect(find('Reports to')).toBeUndefined();
  });
});

describe('handoff across sidebar places', () => {
  it('orders open projects, nested projects, agents and their projects, then personal space', () => {
    const projects = [
      { id: 'child', name: 'Child', parent: 'project:top' },
      { id: 'agent-project', name: 'Plan', parent: 'agent:helper' },
      { id: 'top', name: 'Top' },
      { id: 'done', name: 'Done', finishedAt: 1 },
    ];
    const places = ownerPlaces({ projects, lists: { active: { items: [] } }, now: 2 });
    expect(places.map((p: { label: string }) => p.label)).toEqual(['Top', 'Top › Child', 'Helper', 'Helper › Plan', 'No project']);
  });
  it.each([['job', 'ops'], ['worker', 'worker']])('hands off as a %s to another agent or project', (label, role) => {
    const me = thread('me');
    const agent = thread('agent', { role: 'default', agentSpace: { id: 'helper', name: 'Helper' } });
    const project = thread('project', { role: 'default', projectId: 'p1' });
    const { calls, find } = menuFor(me, [me, agent, project]);
    const places = find(`Hand off as a ${label}`)!.sub!;
    places.find((p) => p.key === 'agent:helper')!.sub![0].onSelect();
    places.find((p) => p.key === 'project:p1')!.sub![0].onSelect();
    expect(calls).toEqual([['me', role, 'agent'], ['me', role, 'project']]);
    expect(places.some((p) => p.label === 'No project')).toBe(false);
  });
  it.each(['interactive', 'ops', 'worker'])('hides other agent destinations for Discord %s conversations', (role) => {
    const me = thread('me', { role }, { source: 'discord', agentId: 'home', agentName: 'Home' });
    const home = thread('home-chat', { role: 'default', agentSpace: { id: 'home', name: 'Home' } });
    const other = thread('other-chat', { role: 'default', agentSpace: { id: 'helper', name: 'Helper' } });
    const { find } = menuFor(me, [me, home, other]);
    const menus = role === 'interactive' ? ['Hand off as a job', 'Hand off as a worker'] : ['Reports to'];
    for (const label of menus) {
      const places = find(label)!.sub!;
      expect(places.some((p) => p.key === 'agent:helper')).toBe(false);
      expect(places.some((p) => p.key === 'personal')).toBe(false);
      expect(places.some((p) => p.key === 'agent:home')).toBe(true);
    }
  });
  it('omits handoff menus when only an unavailable foreign agent has choices', () => {
    const me = thread('me', {}, { source: 'discord', agentId: 'home', agentName: 'Home' });
    const other = thread('other-chat', { role: 'default', agentSpace: { id: 'helper', name: 'Helper' } });
    const { find } = menuFor(me, [me, other]);
    expect(find('Hand off as a job')).toBeUndefined();
    expect(find('Hand off as a worker')).toBeUndefined();
  });
  it('reports to another agent through handOff', () => {
    const me = thread('me', { role: 'ops' });
    const agent = thread('agent', { role: 'default', agentSpace: { id: 'helper', name: 'Helper' } });
    const { calls, find } = menuFor(me, [me, agent]);
    find('Reports to')!.sub!.find((p) => p.key === 'agent:helper')!.sub![0].onSelect();
    expect(calls).toEqual([['me', 'ops', 'agent']]);
  });
});


// ── the row under the latest reply (docs/specs/agent-desk-next.md, Page header) ──
type VNode = { type: unknown; props: { children?: unknown; onClick?: () => void } };
const text = (n: unknown): string => (n == null || typeof n === 'boolean' ? '' : Array.isArray(n) ? n.map(text).join('') : typeof n === 'object' ? text((n as VNode).props?.children) : String(n));

function actsFor(item: object) {
  const calls: unknown[][] = [];
  const store = { state: { now: 0 }, done: (id: string) => calls.push(['done', id]), openSnooze: (id: string) => calls.push(['snooze', id]), park: (id: string) => calls.push(['park', id]) };
  const row = ThreadActs({ item, store }) as VNode | null;
  const buttons = row ? ([row.props.children].flat(3).filter((c) => c && typeof c === 'object') as VNode[]) : [];
  return { calls, row, labels: buttons.map((b) => text(b).replace(/\s+/g, ' ').trim()), buttons };
}

describe('Done, Snooze and Park under the latest reply', () => {
  it('an open thread gets all three, and each runs the same action as the ⋯ menu', () => {
    const { calls, labels, buttons } = actsFor(thread('me'));
    expect(labels).toEqual(['Done d', 'Snooze… s', 'Park']);
    buttons.forEach((b) => b.props.onClick!());
    expect(calls).toEqual([['done', 'me'], ['snooze', 'me'], ['park', 'me']]);
  });

  it('a snoozed thread changes its snooze; a parked one has no Park', () => {
    expect(actsFor(thread('me', {}, { disposition: 'snoozed' })).labels).toEqual(['Done d', 'Change snooze… s', 'Park']);
    expect(actsFor(thread('me', {}, { disposition: 'parked' })).labels).toEqual(['Done d', 'Snooze… s']);
  });

  it('shows nothing mid-turn or once done', () => {
    expect(actsFor(thread('me', {}, { nextStep: 'working', status: { state: 'working' }, lastActivityAt: Date.now() })).row).toBeNull();
    expect(actsFor(thread('me', {}, { disposition: 'done' })).row).toBeNull();
  });
});

describe('standing conversation actions', () => {
  it.each([{ facts: { role: 'default' } }, { kind: 'chapter' }])('offers Clear for a default or home chapter', (extra) => {
    const item = thread('standing', {}, extra);
    const { find } = menuFor(item, [item]);
    expect(find('Clear')).toBeDefined();
    expect(find('Done')).toBeUndefined();
  });
  it('uses the server standing flag for historical chapters and finished project defaults', () => {
    for (const item of [thread('old-chapter', { standing: false }, { kind: 'chapter' }), thread('finished-lead', { role: 'default', standing: false })]) {
      expect(menuFor(item, [item]).find('Done')).toBeDefined();
      expect(menuFor(item, [item]).find('Clear')).toBeUndefined();
    }
  });
  it('still offers Done for ordinary threads', () => {
    const item = thread('ordinary');
    expect(menuFor(item, [item]).find('Done')).toBeDefined();
  });
});

it('hides Reply on retired rows in the shared thread, row and context menu', () => {
  const me = thread('retired', {}, { source: 't3', replyable: false });
  const { find } = menuFor(me, [me]);
  expect(find('Reply')).toBeUndefined();
  expect(find('Done')).toBeDefined();
  expect(menuFor(thread('live', {}, { replyable: true }), []).find('Reply')).toBeDefined();
});

describe('PR review watches on the ⋯ menu', () => {
  it('fold into one Watch reviews row, however many PRs the thread has', () => {
    const prs = [1, 2, 3].map((n) => ({ url: `https://github.com/o/r/pull/${n}`, number: n, title: `A very long pull request title number ${n}`, watched: n === 2 }));
    const me = thread('me', {}, { prs });
    const { find } = menuFor(me, [me]);
    const watch = find('Watch reviews')!;
    expect(watch.sub!.map((e) => [e.label, e.on])).toEqual([
      ['#1 A very long pull request title number 1', false],
      ['#2 A very long pull request title number 2', true],
      ['#3 A very long pull request title number 3', false],
    ]);
    expect((watch as Entry & { hint?: string }).hint).toBe('1 of 3');
  });

  it('has no row when the thread has no PRs', () => {
    const me = thread('me');
    expect(menuFor(me, [me]).find('Watch reviews')).toBeUndefined();
  });
});
