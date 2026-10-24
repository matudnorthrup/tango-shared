import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser module, no types
import { afterNewProject, newProject } from '../public/desk/projects-editor.js';
// @ts-expect-error plain browser module, no types
import { switcherEntries } from '../public/desk/next/switcher.js';
// @ts-expect-error plain browser module, no types
import { createStore } from '../public/desk/store.js';

// Making a project from wherever projects are listed: the dialog opens on a new project, and once it's
// saved the place it came from carries on with it (Start work picks it, a list opens it).

const options = { repos: [{ id: 'p-tango', name: 'tango', account: 'claude-a', mode: 'worktree' }], accounts: [{ id: 'claude-a', name: 'A' }] };

describe('New project', () => {
  it('opens the dialog on a new project, remembering what comes after', () => {
    const store = createStore({ mode: 'fixtures' });
    newProject(store, { then: 'startWork' });
    expect(store.state.projectEditor).toEqual({ editing: 'new', forItem: null, then: 'startWork' });
    newProject(store, { forItem: 'item-1' });
    expect(store.state.projectEditor).toEqual({ editing: 'new', forItem: 'item-1', then: null });
  });

  it('made from Start work, the new thread starts in it', async () => {
    const store = createStore({ mode: 'fixtures', startWorkOptions: async () => options });
    await store.openStartWork();
    store.set({ projects: [{ id: 'fresh-1', name: 'Fresh', createdAt: 1 }] });
    await afterNewProject(store, 'startWork', 'fresh-1');
    expect(store.state.startWork.projectId).toBe('fresh-1');
  });

  it('made inside an agent’s space from Start work, the new thread is with that agent, as picking it would be', async () => {
    const store = createStore({ mode: 'fixtures', startWorkOptions: async () => ({ ...options, agents: [{ id: 'sierra', name: 'Sierra' }] }) });
    await store.openStartWork();
    store.set({ projects: [{ id: 'fresh-2', name: 'Fresh', createdAt: 1, parent: 'agent:sierra' }] });
    await afterNewProject(store, 'startWork', 'fresh-2');
    expect(store.state.startWork).toMatchObject({ projectId: 'fresh-2', form: { agent: 'sierra', placeOpen: false } });
  });

  it('made from a list of projects, it opens', () => {
    const store = createStore({ mode: 'fixtures' });
    afterNewProject(store, 'list', 'fresh-1');
    expect(store.state.listProject).toBe('fresh-1');
    const went: unknown[] = [];
    store.nextGo = (route: unknown) => went.push(route); // the next layout's nav (next/nav.js), only there
    afterNewProject(store, 'next', 'fresh-1');
    expect(went).toEqual([{ page: 'project', id: 'fresh-1' }]);
  });

  it('is one of the quick switcher’s actions', () => {
    const store = createStore({ mode: 'fixtures' });
    const entry = switcherEntries(store, 'new proj').find((e: { key: string }) => e.key === 'x:project');
    expect(entry).toBeTruthy();
    entry.run();
    expect(store.state.projectEditor).toMatchObject({ editing: 'new', then: 'next' });
  });
});
