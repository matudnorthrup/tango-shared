import * as path from 'node:path';
import { deskStatus } from '../server/desk/status.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { snowflakeAt } from '../server/discord.js';
import { parseProjects, projectHolds, readHiddenSections, readProjects, viewsWithTodos, viewsWithWorkspaces } from '../server/desk/projects.js';
import { listItems } from '../server/desk/view.js';
import { parseListViews } from '../server/desk/routes.js';
import { Hub } from '../server/hub.js';
import { SceneStore } from '../server/store.js';
// @ts-expect-error plain browser module, no types
import { projectOf, projectState, sectionsOf } from '../public/desk/list-model.js';
// @ts-expect-error plain browser module, no types
import { DEFAULT_VIEWS, describeView, matchesView, normalizeView, viewItems } from '../public/desk/list-views.js';
// @ts-expect-error plain browser module, no types
import { newProjectId } from '../public/desk/projects-editor.js';
// @ts-expect-error plain browser module, no types
import { createStore } from '../public/desk/store.js';
import { AGENT, cid, makeHarness, msg, NOW, type Harness } from './desk-harness.js';

// Projects: the owner's folders of related conversations, any source (a Loom thread in any workspace,
// a Discord thread or chat). A conversation is in at most one. Synthetic names only.

const PROJECTS = [
  { id: 'desk', name: 'Desk', icon: 'layout-dashboard', color: 'violet', createdAt: NOW - 1000 },
  { id: 'alerts', name: 'Alerts', icon: null, color: 'amber', createdAt: NOW - 500 },
];

describe('the projects setting', () => {
  it('validates strictly: refuses, never trims', () => {
    expect(parseProjects([{ id: 'a', name: ' A ', icon: 'bell', color: 'amber', about: ' x ', createdAt: 5 }], 9)).toEqual({ projects: [{ id: 'a', name: 'A', icon: 'bell', color: 'amber', about: 'x', createdAt: 5 }] });
    expect(parseProjects([{ id: 'a', name: 'A' }], 9)).toEqual({ projects: [{ id: 'a', name: 'A', icon: null, color: null, createdAt: 9 }] });
    expect(parseProjects({})).toMatchObject({ error: expect.stringContaining('list') });
    expect(parseProjects([{ id: 'Bad Id', name: 'A' }])).toMatchObject({ error: expect.stringContaining('bad project id') });
    expect(parseProjects([{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }])).toMatchObject({ error: expect.stringContaining('share') });
    expect(parseProjects([{ id: 'a', name: '' }])).toMatchObject({ error: expect.stringContaining('name') });
    expect(parseProjects([{ id: 'a', name: 'A', color: 'plaid' }])).toMatchObject({ error: expect.stringContaining('color') });
    expect(parseProjects([{ id: 'a', name: 'A', icon: 'Bell!' }])).toMatchObject({ error: expect.stringContaining('icon') });
    expect(parseProjects([{ id: 'a', name: 'A', linearUrl: 'https://example.com' }])).toMatchObject({ error: expect.stringContaining('linear') });
    expect(readProjects('not json')).toEqual([]);
    // Hidden sections: known keys, kept in page order; anything else is refused.
    expect((parseProjects([{ id: 'a', name: 'A', hiddenSections: ['done', 'away', 'done'] }], 9) as { projects: unknown[] }).projects[0]).toMatchObject({ hiddenSections: ['away', 'done'] });
    expect(parseProjects([{ id: 'a', name: 'A', hiddenSections: ['nope'] }])).toMatchObject({ error: expect.stringContaining('hiddenSections') });
    expect(readHiddenSections(null)).toEqual(['done']);
    expect(readHiddenSections('[]')).toEqual([]);
    expect(readHiddenSections('{"x":1}')).toEqual(['done']);
    expect(readProjects(null)).toEqual([]);
  });

  it('views saved before projects: their `project` filter and grouping become `workspace`', () => {
    expect(viewsWithWorkspaces([{ id: 'a', group: 'project', project: ['acme'] }, { id: 'b', group: 'live' }])).toEqual([{ id: 'a', group: 'workspace', workspace: ['acme'] }, { id: 'b', group: 'live' }]);
    expect(viewsWithWorkspaces([{ id: 'b', group: 'live' }])).toBeNull();
    expect(viewsWithWorkspaces(null)).toBeNull();
    // Saved views predating the To-dos built-in get it once, right after the owner's-move view; never twice.
    const top = { id: 'ready', name: 'Top', status: ['active'], live: ['needs', 'ready'] };
    const working = { id: 'working', name: 'Working', status: ['active'], live: ['working'] };
    expect(viewsWithTodos([top, working])).toMatchObject([top, { id: 'todos', name: 'To-dos', live: ['todo'] }, working]);
    expect(viewsWithTodos([working])).toMatchObject([working, { id: 'todos' }]);
    expect(viewsWithTodos([top, { id: 'todos', live: ['todo'] }])).toBeNull();
    expect(viewsWithTodos([top, { id: 'mine', live: ['todo', 'ready'] }])).toBeNull();
    expect(viewsWithTodos([])).toBeNull();
    expect(viewsWithTodos(null)).toBeNull();
  });

  it('a view says whether projects fold and whether it holds conversations in one', () => {
    const [view] = (parseListViews([{ id: 'a', name: 'A', status: ['active'], group: 'project', inProject: 'some', projects: ['desk'], fold: true }]) as { views: Array<Record<string, unknown>> }).views;
    expect(view).toMatchObject({ group: 'project', inProject: 'some', projects: ['desk'], fold: true });
    // A screen loaded before projects still names workspaces `project`, and never sends `fold` (review on #522).
    expect((parseListViews([{ id: 'a', name: 'A', group: 'project' }]) as { views: Array<Record<string, unknown>> }).views[0].group).toBe('workspace');
    expect((parseListViews([{ id: 'a', name: 'A', group: 'workspace', project: ['acme'] }]) as { views: Array<Record<string, unknown>> }).views[0]).toMatchObject({ group: 'workspace', workspace: ['acme'] });
    // History (only done items) lists every conversation unless it says otherwise.
    expect((parseListViews([{ id: 'h', name: 'H', status: ['done'], group: 'none' }]) as { views: Array<Record<string, unknown>> }).views[0].fold).toBe(false);
    expect(parseListViews([{ id: 'a', name: 'A', group: 'none', inProject: 'maybe' }])).toMatchObject({ error: expect.stringContaining('inProject') });
    expect(parseListViews([{ id: 'a', name: 'A', group: 'none', fold: 'yes' }])).toMatchObject({ error: expect.stringContaining('fold') });
  });
});

describe('the project command and the setting over HTTP', () => {
  let h: Harness;
  let hub: Hub;
  let app: ReturnType<typeof createApp>;
  const THREAD = 'discord:thread:7001';
  beforeEach(async () => {
    h = makeHarness();
    const scenes = new SceneStore(path.join(h.dir, 'scenes'));
    hub = new Hub(scenes, async () => 'agent');
    app = createApp({ store: scenes, hub, publicDir: h.dir, desk: { routes: { core: h.core, scenes: () => hub.liveScenes(), keepAliveMs: 50 } } });
    h.discord.threads = [{ id: '7001', name: 'Speaker', parent_id: AGENT.homeChannelId, last_message_id: snowflakeAt(NOW + 365 * 86_400_000) }];
    h.discord.channels.set('7001', [msg(-10, 'owner', 'Find a speaker'), msg(-5, 'agent', 'Pioneer or Sony?')]);
    await h.source.poll();
  });
  afterEach(() => {
    hub.close();
    h.close();
  });
  const post = (body: unknown) => app.request('/api/desk/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('saves projects for every screen, and moves a conversation into one and out again', async () => {
    expect((await (await app.request('/api/desk/settings')).json()).projects).toEqual([]);
    expect((await post({ projects: [{ id: 'bad id', name: 'X' }] })).status).toBe(400);
    expect((await (await post({ projects: PROJECTS })).json()).projects.map((p: { id: string }) => p.id)).toEqual(['desk', 'alerts']);
    const move = (projectId: unknown) => h.core.command({ commandId: cid(), type: 'project', itemId: THREAD, args: { projectId } });
    expect(await move('desk')).toMatchObject({ status: 'applied', outcome: { projectId: 'desk' } });
    expect(h.core.item(THREAD)!.facts.projectId).toBe('desk');
    expect(await move('nope')).toMatchObject({ status: 'failed', error: expect.stringContaining('no project') });
    expect(await move(undefined)).toMatchObject({ status: 'failed' });
    expect(await move(null)).toMatchObject({ status: 'applied', outcome: { projectId: null } });
    expect(h.core.item(THREAD)!.facts.projectId).toBeNull();
    // A finished project takes nothing new.
    await post({ projects: [{ ...PROJECTS[0], finishedAt: NOW }] });
    expect(await move('desk')).toMatchObject({ status: 'failed', error: expect.stringContaining('finished') });
  });

  it('a thread started inside a project joins it when a source first reports it (Start work)', async () => {
    await post({ projects: PROJECTS });
    expect(h.core.assignProject('discord:thread:7002', 'alerts')).toBe(true);
    expect(h.core.assignProject('discord:thread:7003', 'nope')).toBe(false);
    expect(h.core.item('discord:thread:7002')).toBeFalsy();
    h.discord.threads = [...h.discord.threads, { id: '7002', name: 'Pager', parent_id: AGENT.homeChannelId, last_message_id: snowflakeAt(NOW + 365 * 86_400_000) }];
    h.discord.channels.set('7002', [msg(-3, 'owner', 'Quiet the pager'), msg(-1, 'agent', 'On it.')]);
    await h.source.poll();
    expect(h.core.item('discord:thread:7002')!.facts.projectId).toBe('alerts');
    expect(h.core.store.setting('project_pending')).toBeNull();
    // Finished while the thread was on its way: it lists on its own.
    h.core.assignProject('discord:thread:7004', 'alerts');
    await post({ projects: [PROJECTS[0], { ...PROJECTS[1], finishedAt: NOW }] });
    h.discord.threads = [...h.discord.threads, { id: '7004', name: 'Late', parent_id: AGENT.homeChannelId, last_message_id: snowflakeAt(NOW + 365 * 86_400_000) }];
    h.discord.channels.set('7004', [msg(-2, 'owner', 'One more'), msg(-1, 'agent', 'Sure.')]);
    await h.source.poll();
    expect(h.core.item('discord:thread:7004')!.facts.projectId ?? null).toBeNull();
    // A conversation the desk already has joins at once.
    h.core.assignProject(THREAD, 'desk');
    expect(h.core.item(THREAD)!.facts.projectId).toBe('desk');
  });

  it('Start work inside a project is refused before Loom makes the thread when the project is gone or finished', async () => {
    const started: unknown[] = [];
    const startWork = {
      service: {
        start: async (req: unknown) => (started.push(req), { ok: true, threadId: 'new', itemId: 'loom:new', plan: { repo: { id: 'r', name: 'acme', path: '/x' }, title: 'T', account: { id: 'a', name: 'A' } } }),
      },
    };
    const scenes = new SceneStore(path.join(h.dir, 'scenes2'));
    const withStart = createApp({ store: scenes, hub, publicDir: h.dir, desk: { routes: { core: h.core, scenes: () => hub.liveScenes(), keepAliveMs: 50, startWork: startWork as never } } });
    const start = (projectId: string) => withStart.request('/api/desk/start-work', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: 'r', prompt: 'x', projectId }) });
    await post({ projects: [PROJECTS[0], { ...PROJECTS[1], finishedAt: NOW }] });
    expect((await start('gone')).status).toBe(409);
    expect((await start('alerts')).status).toBe(409);
    expect(started).toEqual([]);
    expect((await start('desk')).status).toBe(200);
    expect(started).toHaveLength(1);
    expect(JSON.parse(h.core.store.setting('project_pending')!)['loom:new'].projectId).toBe('desk');
    // Finished while Loom was making the thread: it started, on its own, and the answer says so.
    startWork.service.start = async (req: unknown) => {
      started.push(req);
      await post({ projects: [{ ...PROJECTS[0], finishedAt: NOW }] });
      return { ok: true, threadId: 'late', itemId: 'loom:late', plan: { repo: { id: 'r', name: 'acme', path: '/x' }, title: 'T', account: { id: 'a', name: 'A' } } };
    };
    expect(await (await start('desk')).json()).toMatchObject({ ok: true, projectSkipped: true });
  });

  it('Start work as a worker or job sends who it reports to, keeps it on the desk, and never starts one reporting to no one', async () => {
    const started: any[] = [];
    const startWork = { service: { start: async (req: unknown) => (started.push(req), { ok: true, threadId: 'w', itemId: 'loom:w', plan: { repo: { id: 'r', name: 'acme', path: '/x' }, title: 'T', account: { id: 'a', name: 'A' } } }) } };
    const withStart = createApp({ store: new SceneStore(path.join(h.dir, 'scenes3')), hub, publicDir: h.dir, desk: { routes: { core: h.core, scenes: () => hub.liveScenes(), keepAliveMs: 50, startWork: startWork as never } } });
    const start = (extra: object) => withStart.request('/api/desk/start-work', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: 'r', prompt: 'x', ...extra }) });
    expect((await start({ role: 'worker' })).status).toBe(422);
    expect((await start({ role: 'ops', parentItemId: 'loom:nowhere' })).status).toBe(422);
    expect((await start({ role: 'default', parentItemId: THREAD })).status).toBe(422);
    // Only to a conversation in its own space or one around it (Codex review on #854): THREAD is in the agent's.
    await post({ projects: [...PROJECTS, { id: 'sub', name: 'Sub', icon: null, color: null, createdAt: NOW, parent: 'project:desk' }] });
    expect((await start({ role: 'worker', parentItemId: THREAD })).status).toBe(422);
    await h.core.command({ commandId: cid(), type: 'project', itemId: THREAD, args: { projectId: 'desk' } });
    expect((await start({ role: 'worker', parentItemId: THREAD, projectId: 'alerts' })).status).toBe(422);
    expect(started).toEqual([]);
    // Into the start (Loom keeps it as parent_thread_id, as `tango-screen start` sends it) and onto the desk's roles.
    // A project inside the owner's: its conversations can report out to it.
    expect((await start({ role: 'worker', parentItemId: THREAD, projectId: 'sub' })).status).toBe(200);
    expect(started[0]).toMatchObject({ role: 'worker', parentItemId: THREAD });
    expect(h.core.roles.get('loom:w')).toMatchObject({ role: 'worker', parentItemId: THREAD });
    // A thread is a thread: no role sent.
    expect((await start({ role: 'interactive' })).status).toBe(200);
    expect(started[1].role).toBeUndefined();
  });

  it('Reports to is checked when it lands, and a start whose owner finished meanwhile reports to no one stale (Codex review on #854)', async () => {
    await post({ projects: PROJECTS });
    h.discord.threads = [...h.discord.threads, { id: '7009', name: 'T7009', parent_id: AGENT.homeChannelId, last_message_id: snowflakeAt(NOW + 365 * 86_400_000) }];
    h.discord.channels.set('7009', [msg(-3, 'owner', 'Go'), msg(-1, 'agent', 'Done.')]);
    await h.source.poll();
    const other = 'discord:thread:7009';
    for (const [id, projectId] of [[THREAD, 'desk'], [other, 'alerts']]) await h.core.command({ commandId: cid(), type: 'project', itemId: id, args: { projectId } });
    const role = (parentItemId: string) => h.core.command({ commandId: cid(), type: 'role', itemId: other, args: { role: 'worker', parentItemId } });
    // A pick from another project, or one finished since the menu drew it, is refused.
    expect(await role(THREAD)).toMatchObject({ status: 'failed', error: expect.stringContaining('its own space') });
    await h.core.command({ commandId: cid(), type: 'project', itemId: other, args: { projectId: 'desk' } });
    expect(await role(THREAD)).toMatchObject({ status: 'applied' });
    await h.core.command({ commandId: cid(), type: 'done', itemId: THREAD });
    expect(await role(THREAD)).toMatchObject({ status: 'failed', error: expect.stringContaining('isn’t open') });

    // The owner finishes while the start runs: the new worker doesn't keep reporting to it.
    await h.core.command({ commandId: cid(), type: 'pickup', itemId: THREAD });
    const startWork = { service: { start: async () => (await h.core.command({ commandId: cid(), type: 'done', itemId: THREAD }), { ok: true, threadId: 'w', itemId: 'loom:w2', plan: { repo: { id: 'r', name: 'acme', path: '/x' }, title: 'T', account: { id: 'a', name: 'A' } } }) } };
    const withStart = createApp({ store: new SceneStore(path.join(h.dir, 'scenes4')), hub, publicDir: h.dir, desk: { routes: { core: h.core, scenes: () => hub.liveScenes(), keepAliveMs: 50, startWork: startWork as never } } });
    const res = await withStart.request('/api/desk/start-work', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: 'r', prompt: 'x', role: 'worker', parentItemId: THREAD, projectId: 'desk' }) });
    expect(res.status).toBe(200);
    expect(h.core.roles.get('loom:w2')).toMatchObject({ role: 'worker' });
    expect(h.core.roles.get('loom:w2').parentItemId ?? null).toBeNull();
  });

  it('a project is the outer layer: snoozing or parking it holds what is in rotation and never touches its conversations', async () => {
    await post({ projects: PROJECTS });
    const tids = ['7005', '7006', '7007', '7008'];
    h.discord.threads = [...h.discord.threads, ...tids.map((id) => ({ id, name: `T${id}`, parent_id: AGENT.homeChannelId, last_message_id: snowflakeAt(NOW + 365 * 86_400_000) }))];
    for (const id of tids) h.discord.channels.set(id, [msg(-3, 'owner', 'Go'), msg(-1, 'agent', 'Done.')]);
    await h.source.poll();
    const [a, b, busy, finished, napping] = [THREAD, ...tids.map((id) => `discord:thread:${id}`)];
    for (const id of [a, b, busy, finished, napping]) await h.core.command({ commandId: cid(), type: 'project', itemId: id, args: { projectId: 'desk' } });
    await h.core.command({ commandId: cid(), type: 'done', itemId: finished });
    const ownWake = NOW + 3 * 86_400_000;
    await h.core.command({ commandId: cid(), type: 'snooze', itemId: napping, args: { until: ownWake } });
    h.core.setFacts(busy, { running: { since: NOW } });
    h.core.refresh(busy);
    const act = (body: unknown) => app.request('/api/desk/projects/desk/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const own = (id: string) => h.core.store.attention(id)?.disposition;
    const shown = (id: string) => h.core.item(id)!;
    const ids = (view: 'active' | 'snoozed') => listItems(h.core, { view }).items.map((i) => i.id);

    // Snoozed until tomorrow: the three in rotation are held (a running turn too); their own state is untouched.
    const until = NOW + 86_400_000;
    expect(await (await act({ action: 'snooze', until }).then((r) => r.json()))).toEqual({ held: 3 });
    expect([a, b, busy, finished, napping].map(own)).toEqual(['active', 'active', 'active', 'done', 'snoozed']);
    expect(shown(a)).toMatchObject({ disposition: 'snoozed', snoozeUntil: until, heldBy: 'desk' });
    // Done stays done; a conversation's own snooze keeps its own time.
    expect(shown(finished).disposition).toBe('done');
    expect(shown(napping)).toMatchObject({ disposition: 'snoozed', snoozeUntil: ownWake });
    expect(shown(napping).heldBy).toBeUndefined();
    expect(ids('active')).not.toContain(a);
    expect(ids('snoozed')).toEqual(expect.arrayContaining([a, b, busy, napping]));
    expect(listItems(h.core).counts.active).toBe(0);

    // Back to Active on one row: that one comes back; the project stays snoozed. Undo puts it back under the project.
    const picked = await h.core.command({ commandId: cid(), type: 'pickup', itemId: b });
    expect(shown(b).heldBy).toBeUndefined();
    await h.core.command({ commandId: cid(), type: 'undo', args: { seq: (picked.outcome as { seq: number }).seq } });
    expect(shown(b).heldBy).toBe('desk');
    await h.core.command({ commandId: cid(), type: 'pickup', itemId: b });
    expect(shown(b).heldBy).toBeUndefined();
    expect(shown(a).heldBy).toBe('desk');
    // Words from the agent don't wake a time snooze (as a conversation's own); the owner writing does.
    h.clock.now = NOW + 5 * 60_000;
    h.discord.channels.set('7001', [...h.discord.channels.get('7001')!, msg(2, 'agent', 'More news.')]);
    await h.source.poll();
    expect(shown(a).heldBy).toBe('desk');
    h.discord.channels.set('7001', [...h.discord.channels.get('7001')!, msg(3, 'owner', 'Thanks, carry on')]);
    await h.source.poll();
    expect(shown(a).heldBy).toBeUndefined();

    // The snooze runs out: everything it held is back, as each one was.
    h.clock.now = until + 1;
    h.core.tick();
    const after = await (await app.request('/api/desk/settings')).json();
    expect(after.projects.find((p: { id: string }) => p.id === 'desk').away ?? null).toBeNull();
    expect(shown(busy).heldBy).toBeUndefined();
    expect(shown(finished).disposition).toBe('done');

    // Parked: held until woken, or until its agent posts (news brings a parked conversation back).
    expect(await (await act({ action: 'park' })).json()).toEqual({ held: 3 });
    h.discord.channels.set('7005', [...h.discord.channels.get('7005')!, msg(60 * 24 + 10, 'agent', 'Found it.')]);
    h.discord.threads = h.discord.threads.map((t) => ({ ...t, last_message_id: snowflakeAt(NOW + 365 * 86_400_000 + 1) }));
    await h.source.poll();
    expect(shown(b).heldBy).toBeUndefined();
    expect(shown(a)).toMatchObject({ disposition: 'parked', heldBy: 'desk' });
    expect(await (await act({ action: 'wake' })).json()).toEqual({ held: 0 });
    expect(shown(a).heldBy).toBeUndefined();
    expect((await act({ action: 'snooze' })).status).toBe(400);
    expect((await act({ action: 'bogus' })).status).toBe(400);

    // Finish is the one that acts on its conversations: open ones done, never a running turn.
    h.core.setFacts(busy, { running: { since: h.clock.now } });
    h.core.refresh(busy);
    const rev = (await (await app.request('/api/desk/settings')).json()).projectsRev;
    expect(await (await act({ action: 'finish', how: 'done' })).json()).toEqual({ acted: 3, stayed: 1 });
    expect([a, b, busy, finished, napping].map(own)).toEqual(['done', 'done', 'active', 'done', 'done']);
    const done = await (await app.request('/api/desk/settings')).json();
    expect(done.projects.find((p: { id: string }) => p.id === 'desk').finishedAt).toEqual(expect.any(Number));
    expect(done.projectsRev).toBe(rev + 1);
    expect((await act({ action: 'park' })).status).toBe(400); // already finished
    // A save from a screen holding the older list is refused, and gets the newest back.
    const stale = await post({ projects: PROJECTS, projectsRev: rev });
    expect(stale.status).toBe(409);
    expect((await stale.json()).projectsRev).toBe(rev + 1);
    // The desk's default hidden sections: saved for every screen, and refused when malformed.
    expect((await (await post({ projectSectionsHidden: ['done', 'away'] })).json()).projectSectionsHidden).toEqual(['away', 'done']);
    expect((await post({ projectSectionsHidden: ['bogus'] })).status).toBe(400);
    expect((await (await app.request('/api/desk/settings')).json()).projectSectionsHidden).toEqual(['away', 'done']);
    expect((await post({ projects: PROJECTS, projectsRev: rev + 1 })).status).toBe(200);
  });

  it('renames views saved before projects once, at start', () => {
    h.core.store.setSetting('list_views', JSON.stringify([{ id: 'a', name: 'A', group: 'project', project: ['acme'], status: ['active'] }]));
    h.core.start();
    // ...and views saved before the To-dos built-in get it once, after the owner's-move view (here: second).
    expect(JSON.parse(h.core.store.setting('list_views')!)).toMatchObject([{ id: 'a', name: 'A', group: 'workspace', workspace: ['acme'], status: ['active'] }, { id: 'todos', name: 'To-dos', live: ['todo'] }]);
    // Once: a view saved since that groups by project means the owner's projects, and To-dos isn't added again.
    h.core.store.setSetting('list_views', JSON.stringify([{ id: 'b', name: 'B', group: 'project', status: ['active'] }]));
    h.core.start();
    expect(JSON.parse(h.core.store.setting('list_views')!)).toMatchObject([{ id: 'b', group: 'project' }]);
    expect(JSON.parse(h.core.store.setting('list_views')!)).toHaveLength(1);
  });
});

describe('folders in the List', () => {
  const row = (id: string, patch: Record<string, unknown> = {}, facts: Record<string, unknown> = {}) => {
    const item = {
    id,
    source: 'loom',
    agentId: 'loom',
    agentName: 'Loom',
    place: `acme · ${id}`,
    area: 'acme',
    disposition: 'active',
    nextStep: 'fyi',
    seen: 'seen',
    lastActivityAt: NOW,
    ...patch,
    facts: { project: { name: 'acme' }, lastAuthor: 'agent', ...facts },
    };
    return { ...item, status: deskStatus(item as never, NOW) };
  };
  const items = [
    row('a', { lastActivityAt: NOW - 50 }, { projectId: 'desk', running: { since: 1 } }),
    row('b', { lastActivityAt: NOW - 10 }, { projectId: 'desk' }),
    row('c', { lastActivityAt: NOW - 90, seen: 'new' }, { projectId: 'alerts', pending: { kind: 'question' } }),
    row('d', { lastActivityAt: NOW - 5 }, {}),
    row('e', { lastActivityAt: NOW - 1 }, { projectId: 'gone' }),
  ];
  const ids = (list: Array<{ id: string }>) => list.map((i) => i.id);

  it('a deleted project\'s id is no project', () => {
    expect(projectOf(items[4], PROJECTS)).toBeNull();
  });

  it('a pin heads every grouping in Pinned', () => {
    const pinned = [...items.slice(0, 4), row('p', { lastActivityAt: NOW - 70 }, { projectId: 'desk', pinned: true }), row('q', { lastActivityAt: NOW - 2 }, { pinned: true })];
    const heads = (group: string) => sectionsOf(pinned, group, 'recent', null, { projects: PROJECTS }).map((s: { label: string | null; items: Array<{ id: string }> }) => [s.label, ids(s.items)]);
    expect(heads('live')[0]).toEqual(['Needs you', ['c']]);
    for (const group of ['project', 'workspace', 'none']) expect(heads(group)[0]).toEqual(['Pinned', ['q', 'p']]);
    expect(heads('project')).toEqual([['Pinned', ['q', 'p']], ['Desk', ['b', 'a']], ['Alerts', ['c']], ['No project', ['d']]]);
    // Ungrouped, the rest gets a heading so it doesn't read as more pins; with no pins it has none.
    expect(heads('none')).toEqual([['Pinned', ['q', 'p']], ['Everything else', ['d', 'b', 'a', 'c']]]);
    expect(sectionsOf(items, 'none', 'recent').map((s: { label: string | null }) => s.label)).toEqual([null]);
    // Only the Pinned section says so: a workspace named "pinned" is an ordinary section (Codex review on #664).
    const odd = [row('w', {}, {}), row('x', {}, { pinned: true })].map((i, n) => (n ? i : { ...i, facts: { ...i.facts, project: { name: 'pinned' } } }));
    expect(sectionsOf(odd, 'workspace', 'recent').map((s: { label: string; pinned?: boolean }) => [s.label, !!s.pinned])).toEqual([['Pinned', true], ['pinned', false]]);
  });

  it('a project\'s state, and a view\'s always-shown project states', () => {
    const projects = [
      ...PROJECTS,
      { id: 'naps', name: 'Naps', createdAt: NOW - 300, away: { state: 'snoozed', at: NOW - 100, until: NOW + 1000 } },
      { id: 'woke', name: 'Woke', createdAt: NOW - 200, away: { state: 'snoozed', at: NOW - 100, until: NOW - 1 } },
      { id: 'shelf', name: 'Shelf', createdAt: NOW - 100, away: { state: 'parked', at: NOW - 100 } },
      { id: 'over', name: 'Over', createdAt: NOW - 50, finishedAt: NOW - 10 },
    ];
    expect(projects.map((p) => projectState(p, NOW))).toEqual(['active', 'active', 'snoozed', 'active', 'parked', 'active']);
    // Saved on the view only when it folds; the server refuses a state it doesn't know.
    expect(normalizeView({ id: 'x', name: 'X', showProjects: ['snoozed', 'bogus'] }).showProjects).toEqual(['snoozed']);
    expect(normalizeView({ id: 'x', name: 'X', fold: false, showProjects: ['active'] }).showProjects).toBeUndefined();
    expect((parseListViews([{ id: 'a', name: 'A', group: 'none', showProjects: ['active', 'snoozed'] }]) as { views: Array<Record<string, unknown>> }).views[0].showProjects).toEqual(['active', 'snoozed']);
    expect((parseListViews([{ id: 'a', name: 'A', group: 'none', fold: false, showProjects: ['active'] }]) as { views: Array<Record<string, unknown>> }).views[0].showProjects).toBeUndefined();
    expect(parseListViews([{ id: 'a', name: 'A', group: 'none', showProjects: ['done'] }])).toMatchObject({ error: expect.stringContaining('showProjects') });
    expect(describeView(normalizeView({ id: 'x', name: 'X', status: ['active'], showProjects: ['active', 'snoozed'] }), {})).toBe('Active · projects folded, active and snoozed always shown · by live state');
  });

  it('views filter on being in a project; inside a project its own filters are set aside', () => {
    const lists = { active: { items }, snoozed: { items: [row('z', { disposition: 'snoozed' }, { projectId: 'desk' })] }, history: { items: [] } };
    const view = (spec: Record<string, unknown>) => normalizeView({ id: 'x', name: 'X', status: ['active'], ...spec });
    expect(ids(viewItems(lists, view({ inProject: 'some' }), PROJECTS))).toEqual(['a', 'b', 'c']);
    expect(ids(viewItems(lists, view({ inProject: 'none' }), PROJECTS))).toEqual(['d', 'e']);
    expect(ids(viewItems(lists, view({ inProject: 'some', projects: ['alerts'] }), PROJECTS))).toEqual(['c']);
    expect(ids(viewItems(lists, view({ inProject: 'none' }), PROJECTS, 'desk'))).toEqual(['a', 'b']);
    expect(ids(viewItems(lists, view({ status: ['snoozed'] }), PROJECTS, 'desk'))).toEqual(['z']);
    expect(matchesView(items[0], view({ inProject: 'some' }))).toBe(false); // no projects known: in none
    expect(describeView(view({ inProject: 'some', projects: ['alerts'] }), { 'project:alerts': 'Alerts' })).toBe('Active · in Alerts · projects folded · by live state');
  });

  it('groups by project in the owner’s order, then No project; workspaces group as before', () => {
    expect(sectionsOf(items, 'project', 'recent', null, { projects: PROJECTS }).map((s: { label: string; items: Array<{ id: string }> }) => [s.label, ids(s.items)])).toEqual([
      ['Desk', ['b', 'a']],
      ['Alerts', ['c']],
      ['No project', ['e', 'd']],
    ]);
    expect(sectionsOf(items, 'workspace', 'recent').map((s: { label: string }) => s.label)).toEqual(['acme']);
  });

  it('the four built-in views show threads directly; a new project gets an id of its own', () => {
    expect(DEFAULT_VIEWS.map((v: { fold: boolean }) => v.fold)).toEqual([false, false, false, false]);
    // Active and Ready always show the projects in rotation; the others only what is in them.
    expect(DEFAULT_VIEWS.map((v: { showProjects?: string[] }) => v.showProjects ?? null)).toEqual([null, null, null, null]);
    expect(normalizeView({ id: 'x', name: 'X', status: ['done'] }).fold).toBe(false);
    expect(normalizeView({ id: 'x', name: 'X', fold: false }).fold).toBe(false);
    // Never a deleted project's id: its conversations keep it (review on #522).
    expect(newProjectId(PROJECTS, 'Desk!', 36)).toBe('desk-10');
    expect(newProjectId([{ id: 'desk-10' }], 'Desk', 36)).toBe('desk-10-2');
    expect(newProjectId([], 'New thing', 37)).toBe('new-thing-11');
  });
});

describe('store: a project as a whole', () => {
  it('asks the desk in one call, then says what happened', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [], counts: {} }),
      item: async () => ({}),
      projectAction: async (id: string, body: Record<string, unknown>) => (calls.push([id, body]), body.action === 'finish' ? { acted: 2, stayed: 1 } : { held: 2 }),
    };
    const store = createStore(client);
    store.state.projects = PROJECTS;
    await store.parkProject('desk');
    await store.wakeProject('desk');
    await store.finishProject('desk', 'out');
    expect(calls).toEqual([['desk', { action: 'park' }], ['desk', { action: 'wake' }], ['desk', { action: 'finish', how: 'out' }]]);
    expect(store.state.toasts.map((t: { text: string }) => t.text)).toEqual(
      expect.arrayContaining(['Parked Desk · 2 held until you wake it; the rest keep their own state', 'Desk is back', 'Finished Desk · 2 listed on their own · 1 still working, left as it is']),
    );
  });
});

describe('what a project that is away holds', () => {
  const none = { ownerWroteSince: false, agentPostedSince: false, pickedUpSince: false };
  it('mirrors a conversation’s own snooze: a time holds until then, “until they post” and parked let news through, the owner always gets through', () => {
    const at = 100;
    expect(projectHolds(null, 200, none)).toBe(false);
    expect(projectHolds({ state: 'snoozed', at, until: 300 }, 200, none)).toBe(true);
    expect(projectHolds({ state: 'snoozed', at, until: 300 }, 300, none)).toBe(false);
    expect(projectHolds({ state: 'snoozed', at, until: 300 }, 200, { ...none, agentPostedSince: true })).toBe(true);
    expect(projectHolds({ state: 'snoozed', at, trigger: 'agent_posts' }, 200, { ...none, agentPostedSince: true })).toBe(false);
    expect(projectHolds({ state: 'snoozed', at, trigger: 'desk' }, 200, { ...none, agentPostedSince: true })).toBe(true);
    expect(projectHolds({ state: 'parked', at }, 200, { ...none, agentPostedSince: true })).toBe(false);
    expect(projectHolds({ state: 'parked', at }, 200, { ...none, ownerWroteSince: true })).toBe(false);
    expect(projectHolds({ state: 'parked', at }, 200, { ...none, pickedUpSince: true })).toBe(false);
    expect(parseProjects([{ id: 'a', name: 'A', away: { state: 'snoozed', at: 1 } }])).toMatchObject({ error: expect.stringContaining('away') });
    expect(parseProjects([{ id: 'a', name: 'A', away: { state: 'parked', at: 1 } }])).toMatchObject({ projects: [{ away: { state: 'parked', at: 1 } }] });
  });
});
