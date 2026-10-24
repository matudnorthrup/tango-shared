import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { snowflakeAt } from '../server/discord.js';
import { holderOf, parseProjects, readProjects } from '../server/desk/projects.js';
import { Hub } from '../server/hub.js';
import { SceneStore } from '../server/store.js';
// @ts-expect-error plain browser module, no types
import { withoutProject } from '../public/desk/projects-editor.js';
// @ts-expect-error plain browser module, no types
import { awayWord, childProjects, crumbsOf, indexProjects, foldedChildren, nestedProjectList, ownMatch, parentChoices, parentCrumb, placeTally, projectViews, sidebarPlaces } from '../public/desk/next/model.js';
import { AGENT, cid, makeHarness, msg, NOW, type Harness } from './desk-harness.js';

// Nested spaces (docs/specs/spaces.md, Nesting): a project inside a project or an agent, two levels. Invented names only.

const TOP = { id: 'tango', name: 'Tango', icon: null, color: 'teal', createdAt: 1 };
const DESK = { id: 'desk', name: 'Desk', icon: null, color: 'violet', createdAt: 2, parent: 'project:tango' };
const VOICE = { id: 'voice', name: 'Voice', icon: null, color: 'lime', createdAt: 3, parent: 'project:tango' };
const ROADSTER = { id: 'bike', name: 'Bike', icon: null, color: 'amber', createdAt: 4, parent: 'agent:sierra' };
const SOLO = { id: 'solo', name: 'Solo', icon: null, color: null, createdAt: 5 };

describe('a parent on a project', () => {
  it('is a project or an agent, two levels deep, never itself or missing', () => {
    expect(parseProjects([TOP, DESK, ROADSTER])).toEqual({ projects: [expect.objectContaining({ id: 'tango' }), expect.objectContaining({ parent: 'project:tango' }), expect.objectContaining({ parent: 'agent:sierra' })] });
    expect(parseProjects([{ ...TOP, parent: 'space:x' }])).toMatchObject({ error: expect.stringContaining('parent must be') });
    expect(parseProjects([DESK])).toMatchObject({ error: expect.stringContaining('no parent project tango') });
    expect(parseProjects([{ ...TOP, parent: 'project:tango' }])).toMatchObject({ error: expect.stringContaining('inside itself') });
    // Three levels: Desk's own child would be one too many.
    expect(parseProjects([TOP, DESK, { ...SOLO, parent: 'project:desk' }])).toMatchObject({ error: expect.stringContaining('two levels') });
    // A project under an agent nests nothing.
    expect(parseProjects([ROADSTER, { ...SOLO, parent: 'project:bike' }])).toMatchObject({ error: expect.stringContaining('two levels') });
    // A finished child keeps where it was while its parent moves into another space.
    expect(parseProjects([{ ...TOP, parent: 'agent:sierra' }, { ...DESK, finishedAt: 9 }])).not.toHaveProperty('error');
  });

  it('a stored nesting that no longer holds costs no projects: they read at the top', () => {
    expect(readProjects(JSON.stringify([DESK, SOLO])).map((p) => [p.id, p.parent ?? null])).toEqual([['desk', null], ['solo', null]]);
  });

  it('a parent away holds its children; a child away on its own holds itself', () => {
    const away = { state: 'parked' as const, at: 1 };
    const list = parseProjects([{ ...TOP, away }, DESK, { ...VOICE, away: { state: 'snoozed' as const, at: 2, until: 99 } }]) as { projects: Parameters<typeof holderOf>[1] };
    const [tango, desk, voice] = list.projects;
    expect(holderOf(desk, list.projects)?.id).toBe('tango');
    expect(holderOf(voice, list.projects)?.id).toBe('voice');
    expect(holderOf(tango, list.projects)?.id).toBe('tango');
    expect(holderOf({ ...desk, finishedAt: 5 }, list.projects)).toBeNull();
  });
});

describe('nested projects on the desk', () => {
  let h: Harness;
  let hub: Hub;
  let app: ReturnType<typeof createApp>;
  const T = (n: number) => `discord:thread:${n}`;
  beforeEach(async () => {
    h = makeHarness();
    const scenes = new SceneStore(path.join(h.dir, 'scenes'));
    hub = new Hub(scenes, async () => 'agent');
    app = createApp({ store: scenes, hub, publicDir: h.dir, desk: { routes: { core: h.core, scenes: () => hub.liveScenes(), keepAliveMs: 50 } } });
    const ids = [8001, 8002, 8003, 8004];
    h.discord.threads = ids.map((id) => ({ id: String(id), name: `T${id}`, parent_id: AGENT.homeChannelId, last_message_id: snowflakeAt(NOW + 365 * 86_400_000) }));
    for (const id of ids) h.discord.channels.set(String(id), [msg(-3, 'owner', 'Go'), msg(-1, 'agent', 'Done.')]);
    await h.source.poll();
  });
  afterEach(() => {
    hub.close();
    h.close();
  });
  const post = (body: unknown) => app.request('/api/desk/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const act = (id: string, body: unknown) => app.request(`/api/desk/projects/${id}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const into = (itemId: string, projectId: string) => h.core.command({ commandId: cid(), type: 'project', itemId, args: { projectId } });
  const saved = () => readProjects(h.core.store.setting('projects'));

  it('refuses three levels over HTTP, and moving a project under a parent keeps its threads', async () => {
    expect((await post({ projects: [TOP, DESK, { ...SOLO, parent: 'project:desk' }] })).status).toBe(400);
    await post({ projects: [TOP, { ...DESK, parent: undefined }] });
    await into(T(8001), 'desk');
    const rev = Number(h.core.store.setting('projects_rev'));
    expect((await post({ projects: [TOP, DESK], projectsRev: rev })).status).toBe(200);
    expect(h.core.item(T(8001))!.facts.projectId).toBe('desk');
    expect(saved().find((p) => p.id === 'desk')!.parent).toBe('project:tango');
  });

  it('snoozing or parking a parent holds its children’s conversations; waking it brings them back', async () => {
    await post({ projects: [TOP, DESK, VOICE] });
    await into(T(8001), 'tango');
    await into(T(8002), 'desk');
    await into(T(8003), 'voice');
    expect(await act('tango', { action: 'park' })).toEqual({ held: 3 });
    expect([8001, 8002, 8003].map((n) => h.core.item(T(n))!)).toEqual([8001, 8002, 8003].map(() => expect.objectContaining({ disposition: 'parked', heldBy: 'tango' })));
    // Voice snoozed on its own keeps its own hold under a parked parent.
    expect(await act('tango', { action: 'wake' })).toEqual({ held: 0 });
    await act('voice', { action: 'snooze', until: NOW + 86_400_000 });
    await act('tango', { action: 'park' });
    expect(h.core.item(T(8003))).toMatchObject({ disposition: 'snoozed', heldBy: 'voice' });
    expect(h.core.item(T(8002))).toMatchObject({ disposition: 'parked', heldBy: 'tango' });
    await act('tango', { action: 'wake' });
    expect(h.core.item(T(8002))!.disposition).toBe('active');
    expect(h.core.item(T(8002))!.heldBy).toBeUndefined();
  });

  it('a child moved under a parked parent is held at once', async () => {
    await post({ projects: [{ ...TOP, away: { state: 'parked', at: NOW - 1 } }, { ...DESK, parent: undefined }] });
    await into(T(8002), 'desk');
    expect(h.core.item(T(8002))!.disposition).toBe('active');
    await post({ projects: [{ ...TOP, away: { state: 'parked', at: NOW - 1 } }, DESK] });
    expect(h.core.item(T(8002))).toMatchObject({ disposition: 'parked', heldBy: 'tango' });
  });

  it('finishing a parent: its children finish with it, or stay open and move up; open conversations move up too', async () => {
    await post({ projects: [TOP, DESK, VOICE] });
    await into(T(8001), 'tango');
    await into(T(8002), 'desk');
    await into(T(8003), 'voice');
    // Kept open: Desk and Voice move to the top with their threads; Tango's own open thread moves up (out).
    expect(await act('tango', { action: 'finish', how: 'out', children: 'keep' })).toMatchObject({ acted: 1, finished: 0, keptOpen: 2 });
    expect(saved().map((p) => [p.id, p.parent ?? null, !!p.finishedAt])).toEqual([['tango', null, true], ['desk', null, false], ['voice', null, false]]);
    expect(h.core.item(T(8001))!.facts.projectId ?? null).toBeNull();
    expect(h.core.item(T(8002))!.facts.projectId).toBe('desk');
  });

  it('finishing with the children finishes them all, and their open threads with them', async () => {
    await post({ projects: [TOP, DESK, VOICE] });
    await into(T(8001), 'tango');
    await into(T(8002), 'desk');
    expect(await act('tango', { action: 'finish', how: 'done', children: 'finish' })).toMatchObject({ acted: 2, finished: 2, keptOpen: 0 });
    expect(saved().every((p) => p.finishedAt)).toBe(true);
    expect(h.core.store.attention(T(8002))?.disposition).toBe('done');
  });

  it('deleting a parent moves its child projects to the top in the same save, which the desk accepts', async () => {
    await post({ projects: [TOP, DESK, VOICE, ROADSTER] });
    await into(T(8002), 'desk');
    const next = withoutProject(saved(), 'tango');
    expect(next.map((p: { id: string; parent?: string }) => [p.id, p.parent ?? null])).toEqual([['desk', null], ['voice', null], ['bike', 'agent:sierra']]);
    const rev = Number(h.core.store.setting('projects_rev'));
    expect((await post({ projects: next, projectsRev: rev })).status).toBe(200);
    expect(saved().map((p) => [p.id, p.parent ?? null])).toEqual([['desk', null], ['voice', null], ['bike', 'agent:sierra']]);
    // Its threads stay in their own project.
    expect(h.core.item(T(8002))!.facts.projectId).toBe('desk');
    // Deleting only the parent, children untouched, is still refused rather than silently flattened.
    expect((await post({ projects: [DESK, VOICE] })).status).toBe(400);
  });

  it('a child finished on its own moves its open conversations up into its parent', async () => {
    await post({ projects: [TOP, DESK] });
    await into(T(8002), 'desk');
    expect(await act('desk', { action: 'finish', how: 'out' })).toEqual({ acted: 1, stayed: 0 });
    expect(h.core.item(T(8002))!.facts.projectId).toBe('tango');
  });
});

// ── the next layout's model ──

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  source: 'discord',
  kind: 'thread',
  agentId: 'watson',
  agentName: 'Watson',
  place: id,
  facts: { lastAuthor: 'agent' },
  summary: {},
  artifacts: [],
  nextStep: 'fyi',
  seen: 'seen',
  disposition: 'active',
  lastActivityAt: 1,
  ...over,
});
// An unread ask of the owner's (an unread finished update is not waiting on them: owner, 10/18).
const waiting = (id: string, projectId: string | null, over: Record<string, unknown> = {}) => item(id, { seen: 'updated', nextStep: 'your_move', status: { pill: 'needs', countsForOwner: true, audience: 'owner' }, facts: { lastAuthor: 'agent', projectId }, ...over });
const quiet = (id: string, projectId: string | null, over: Record<string, unknown> = {}) => item(id, { facts: { lastAuthor: 'agent', projectId }, ...over });

describe('nesting in the sidebar, the Projects page and the breadcrumb', () => {
  const projects = [TOP, DESK, VOICE, ROADSTER, SOLO];
  const items = [
    waiting('t1', 'tango'),
    quiet('t2', 'tango'),
    waiting('d1', 'desk'),
    quiet('d2', 'desk'),
    waiting('v1', 'voice'),
    // Sierra's own thread, and one in her project Bike.
    quiet('s1', null, { agentId: 'sierra', agentName: 'Sierra' }),
    waiting('m1', 'bike', { agentId: 'sierra', agentName: 'Sierra' }),
  ];
  const lists = { active: { items, loaded: true }, snoozed: { items: [], loaded: true }, history: { items: [], loaded: true } };
  const state = { projects, lists, now: 100 };

  it('a snoozed or parked child still lists under its parent, named with its state; a finished one drops out', () => {
    const away = { ...state, projects: [TOP, { ...DESK, away: { state: 'snoozed', at: 50, until: 500 } }, { ...VOICE, finishedAt: 60 }, { ...ROADSTER, away: { state: 'parked', at: 50 } }, SOLO] };
    const { projects: rows, agents } = sidebarPlaces(away);
    expect(rows.find((r: { id: string }) => r.id === 'tango').children.map((c: { id: string }) => c.id)).toEqual(['desk']);
    const sierra = agents.find((a: { id: string }) => a.id === 'sierra');
    expect(sierra.children.map((c: { id: string }) => c.id)).toEqual(['bike']);
    expect(awayWord(sierra.children[0], 100)).toBe('parked');
    expect(awayWord(rows.find((r: { id: string }) => r.id === 'tango').children[0], 100)).toBe('snoozed');
    expect(awayWord(TOP, 100)).toBeNull();
    // Closed, the parent's breakdown names the child's state.
    expect(placeTally(sierra, items, { projects: away.projects, isOpen: false, now: 100 }).nest).toMatchObject([{ here: true }, { label: 'Bike', away: 'parked' }]);
  });

  it('lists top-level projects with their children; an agent’s projects nest under it and not under Projects', () => {
    const { projects: rows, agents } = sidebarPlaces(state);
    expect(rows.map((r: { id: string; children: Array<{ id: string }> }) => [r.id, r.children.map((c) => c.id)])).toEqual([['tango', ['desk', 'voice']], ['solo', []]]);
    expect(agents.find((a: { id: string }) => a.id === 'sierra').children.map((c: { id: string }) => c.id)).toEqual(['bike']);
  });

  it('a closed parent counts the roll-up and breaks down "here" then each child; an open one counts its own', () => {
    const [tango] = sidebarPlaces(state).projects;
    const open = items;
    const closed = placeTally(tango, open, { projects, isOpen: false, now: 100 });
    expect([closed.tally.waiting, closed.tally.active]).toEqual([3, 5]);
    expect(closed.nest).toEqual([
      { label: 'here', waiting: 1, active: 2, here: true },
      { label: 'Desk', waiting: 1, active: 2 },
      { label: 'Voice', waiting: 1, active: 1 },
    ]);
    const opened = placeTally(tango, open, { projects, isOpen: true, now: 100 });
    expect([opened.tally.waiting, opened.tally.active, opened.nest]).toEqual([1, 2, null]);
    // Sierra: her own thread, not Bike's, when open; both when closed.
    const sierra = sidebarPlaces(state).agents.find((a: { id: string }) => a.id === 'sierra');
    expect(placeTally(sierra, open, { projects, isOpen: true, now: 100 }).tally).toMatchObject({ waiting: 0, active: 1 });
    expect(placeTally(sierra, open, { projects, isOpen: false, now: 100 }).tally).toMatchObject({ waiting: 1, active: 2 });
    expect(items.filter(ownMatch('agent', 'sierra', projects)).map((i) => i.id)).toEqual(['s1']);
  });

  it('the Projects page lists top-level spaces; an away child and an agent’s project list on their own with a crumb', () => {
    const away = [TOP, { ...DESK, away: { state: 'parked', at: 1 } }, VOICE, ROADSTER, SOLO];
    expect(indexProjects(projects, 100).map((p: { id: string }) => p.id)).toEqual(['tango', 'bike', 'solo']);
    const views = projectViews(away, 100);
    expect(views.map((v: { id: string; items: Array<{ id: string }> }) => [v.id, v.items.map((p) => p.id)])).toEqual([['active', ['tango', 'bike', 'solo']], ['parked', ['desk']]]);
    expect(parentCrumb(away[1], away)).toBe('Tango');
    expect(parentCrumb(ROADSTER, away, [{ id: 'sierra', name: 'Sierra' }])).toBe('Sierra');
    // Tango's pills roll up only the children the page doesn't list on their own.
    expect(foldedChildren(TOP, away, 100).map((p: { id: string }) => p.id)).toEqual(['voice']);
    expect(childProjects('project:tango', away).length).toBe(2);
  });

  it('the breadcrumb reads Projects › Tango › Desk › thread, and Agents › Sierra › Bike', () => {
    expect(crumbsOf({ page: 'project', id: 'desk' }, { projects, thread: 'Inbox empty state' }).map((c: { label: string }) => c.label)).toEqual(['Projects', 'Tango', 'Desk', 'Inbox empty state']);
    expect(crumbsOf({ page: 'project', id: 'bike' }, { projects, agents: [{ id: 'sierra', name: 'Sierra' }] }).map((c: { label: string }) => c.label)).toEqual(['Agents', 'Sierra', 'Bike']);
    expect(crumbsOf({ page: 'spacesettings', id: 'project:desk' }, { projects }).map((c: { label: string }) => c.label)).toEqual(['Projects', 'Tango', 'Desk', 'Settings']);
  });

  it('where a project can go: your space, a top-level project, an agent; a parent stays at the top', () => {
    const agents = [{ id: 'sierra', name: 'Sierra' }];
    expect(parentChoices(SOLO, projects, agents).map((c: { value: string | null }) => c.value)).toEqual([null, 'project:tango', 'agent:sierra']);
    expect(parentChoices(TOP, projects, agents).map((c: { value: string | null }) => c.value)).toEqual([null]);
    expect(parentChoices(DESK, projects, agents).map((c: { value: string | null }) => c.value)).toEqual([null, 'project:tango', 'project:solo', 'agent:sierra']);
    // Move to project: a parent, then its children by name; an agent's projects last.
    expect(nestedProjectList(projects, agents).map((r: { label: string }) => r.label)).toEqual(['Tango', 'Tango › Desk', 'Tango › Voice', 'Solo', 'Sierra › Bike']);
  });
});
