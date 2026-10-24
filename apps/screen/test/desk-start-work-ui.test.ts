import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser module, no types
import { kindLine, optionsChanged, placeChoices, repoLine, repoNamedIn, repoWhy, startMissing, startPlace } from '../public/desk/start-work.js';
// @ts-expect-error plain browser module, no types
import { createStore } from '../public/desk/store.js';

// The Start work sheet's own logic: a repo named in the description fills the field, and
// Start stays disabled until both required fields are there.

const repos = [
  { id: 'p-tango', name: 'tango' },
  { id: 'p-acme', name: 'acme' },
  { id: 'p-web', name: 'acme-web' },
];

describe('Start work sheet', () => {
  it('fills the repo when the description names one, preferring the longest name', () => {
    expect(repoNamedIn('In tango, add a what-did-I-miss summary', repos)).toBe('p-tango');
    expect(repoNamedIn('fix the acme-web header', repos)).toBe('p-web');
    expect(repoNamedIn('fix acme export', repos)).toBe('p-acme');
    expect(repoNamedIn('fix the tangos', repos)).toBeNull();
    expect(repoNamedIn('', repos)).toBeNull();
  });

  it('names what still blocks Start', () => {
    expect(startMissing({ repo: '', prompt: ' ' })).toEqual(['Pick a repo', 'Say what it should work on']);
    expect(startMissing({ repo: 'p-tango', prompt: 'Fix it' })).toEqual([]);
  });
});

describe('Kind under Options', () => {
  const lead = { id: 'lead', place: 'Desk lead', facts: { role: 'default' } };
  const other = { id: 'other', place: 'Fix the footer' };
  const form = { role: 'interactive', plan: false, mode: 'worktree', title: '' };

  it('the footer names a worker or job and who it reports to; a thread, or one with no owner yet, says nothing', () => {
    expect(kindLine(form, { owner: null, lead: null })).toBeNull();
    expect(kindLine({ ...form, role: 'worker' }, { owner: null, lead: null })).toBeNull();
    expect(kindLine({ ...form, role: 'worker' }, { owner: lead, lead })).toBe('Worker · reports to Desk lead · lead');
    expect(kindLine({ ...form, role: 'ops' }, { owner: other, lead })).toBe('Job · reports to Fix the footer');
    expect(optionsChanged({ ...form, role: 'ops', plan: true }, { owners: { owner: other, lead } })).toBe('Plan first · Job · reports to Fix the footer');
    expect(optionsChanged(form, {})).toBe('');
  });

  it('a thread with an agent only says its kind and title: no plan, checkout or account', () => {
    expect(optionsChanged({ ...form, role: 'worker', mode: 'local', plan: true, title: 'Coast loop' }, { owners: { owner: lead, lead }, onAgent: true })).toBe('Worker · reports to Desk lead · lead · “Coast loop”');
  });
});

describe('Start work from a code block', () => {
  const options = { repos: repos.map((r) => ({ ...r, account: 'claude-a', mode: 'worktree' })), accounts: [{ id: 'claude-a', name: 'A' }] };

  it('opens the sheet with the prompt filled in, switching to a repo it names', async () => {
    const store = createStore({ mode: 'fixtures', startWorkOptions: async () => options });
    await store.openStartWork({ prompt: 'In acme, fix the export.' });
    expect(store.state.startWork.form).toMatchObject({ prompt: 'In acme, fix the export.', repo: 'p-acme', repoInferred: true });
  });

  it('replaces the prompt of a sheet already open', async () => {
    const store = createStore({ mode: 'fixtures', startWorkOptions: async () => options });
    await store.openStartWork();
    store.setStartField('prompt', 'half a thought');
    await store.openStartWork({ prompt: 'In tango, add a summary.' });
    expect(store.state.startWork.form).toMatchObject({ prompt: 'In tango, add a summary.', repo: 'p-tango' });
  });
});

describe('Start work on Loom', () => {
  const options = { repos: repos.map((r) => ({ ...r, account: 'loom', mode: 'worktree' })), accounts: [{ id: 'claude-a', name: 'A', driver: 'claudeAgent' }, { id: 'loom', name: 'Loom', driver: 'loom' }] };

  it('drops a pin when the repo changes but preserves it for plan first', async () => {
    const store = createStore({ mode: 'fixtures', startWorkOptions: async () => options });
    await store.openStartWork({ prompt: 'In tango, fix the export.' });
    store.setStartField('pin', 'claude-a');
    store.setStartField('prompt', 'In tango, fix the export test.');
    expect(store.state.startWork.form).toMatchObject({ repo: 'p-tango', pin: 'claude-a' });
    store.setStartField('prompt', 'In acme, fix the export.');
    expect(store.state.startWork.form).toMatchObject({ repo: 'p-acme', pin: '' });
    store.setStartField('pin', 'claude-a');
    store.setStartField('plan', true);
    expect(store.state.startWork.form).toMatchObject({ pin: 'claude-a', plan: true });
  });
});

describe('Start work from a project', () => {
  const options = { repos: repos.map((r) => ({ ...r, account: 'claude-a', mode: 'worktree' })), accounts: [{ id: 'claude-a', name: 'A' }] };
  const item = (id: string, area: string, lastActivityAt: number, projectId?: string) => ({ id, source: 'loom', area, lastActivityAt, disposition: 'active', facts: projectId ? { projectId } : {} });

  it('starts on the repo of the project’s latest Loom thread, not the one last used elsewhere', async () => {
    const store = createStore({ mode: 'fixtures', startWorkOptions: async () => options });
    const items = [item('a', 'tango', 300), item('b', 'acme', 100, 'proj-1'), item('c', 'acme-web', 200, 'proj-1')];
    store.set({ lists: { ...store.state.lists, active: { ...store.state.lists.active, items } }, focusId: 'a' });
    await store.openStartWork({ projectId: 'proj-1' });
    expect(store.state.startWork.form).toMatchObject({ repo: 'p-web', repoFrom: 'project' });
  });

  it('starts a worker reporting to the project’s lead unless another owner is picked', async () => {
    let sent: Record<string, unknown> | null = null;
    const lead = { ...item('lead', 'acme-web', 100, 'proj-1'), facts: { projectId: 'proj-1', role: 'default' } };
    const items = [lead, item('other', 'acme-web', 200, 'proj-1'), item('elsewhere', 'tango', 300)];
    const client = { mode: 'fixtures', startWorkOptions: async () => options, items: async ({ view }: { view: string }) => ({ items: view === 'active' ? items : [] }), startWork: async (body: Record<string, unknown>) => ((sent = body), { plan: { repo: { name: 'x' }, account: { name: 'A' }, title: 't' } }) };
    const store = createStore(client);
    store.set({ projects: [{ id: 'proj-1', name: 'Web', color: 'violet', icon: null, createdAt: 0 }], lists: { ...store.state.lists, active: { ...store.state.lists.active, items, loaded: true } } });
    await store.openStartWork({ projectId: 'proj-1', prompt: 'Fix it' });
    store.setStartField('role', 'worker');
    expect(store.startOwner().choices.map((c: { id: string }) => c.id)).toEqual(['lead', 'other']);
    expect(store.startOwner().owner.id).toBe('lead');
    store.setStartField('parent', 'other');
    await store.submitStartWork();
    expect(sent).toMatchObject({ role: 'worker', parentItemId: 'other', projectId: 'proj-1' });
  });

  it('clears an unrelated owner on project change and keeps enclosing and personal owners', async () => {
    const items = [item('other', 'tango', 100, 'p2'), item('enclosing', 'tango', 200, 'p1'), item('solo', 'tango', 300),
      { ...item('lead3', 'tango', 400, 'p3'), facts: { projectId: 'p3', role: 'default' } }];
    const store = createStore({ mode: 'fixtures', startWorkOptions: async () => options, items: async () => ({ items: [] }) });
    store.set({ projects: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }, { id: 'p3', name: 'Three', parent: 'project:p1' }],
      lists: { ...store.state.lists, active: { items, loaded: true } } });
    await store.openStartWork({ projectId: 'p2' });
    store.setStartField('role', 'worker');
    store.setStartField('parent', 'other');
    await store.setStartProject('p3');
    expect(store.state.startWork.form.parent).toBe('');
    expect(store.startOwner().owner.id).toBe('lead3');
    for (const parent of ['enclosing', 'solo']) {
      store.setStartField('parent', parent);
      await store.setStartProject('p3');
      expect(store.state.startWork.form.parent).toBe(parent);
      expect(store.startOwner().owner.id).toBe(parent);
    }
  });

  it('groups reporting choices by space and moves a start with an owner from another project', async () => {
    let sent: Record<string, unknown> | null = null;
    const items = [
      { ...item('lead1', 'tango', 100, 'p1'), facts: { projectId: 'p1', role: 'default' } },
      { ...item('lead2', 'tango', 200, 'p2'), facts: { projectId: 'p2', role: 'default' } },
      item('other', 'tango', 300, 'p2'),
      item('solo', 'tango', 400),
    ];
    const client = { mode: 'fixtures', startWorkOptions: async () => options, items: async ({ view }: { view: string }) => ({ items: view === 'active' ? items : [] }), startWork: async (body: Record<string, unknown>) => ((sent = body), { plan: { repo: { name: 'x' }, account: { name: 'A' }, title: 't' } }) };
    const store = createStore(client);
    store.set({ projects: [{ id: 'p1', name: 'One', createdAt: 1 }, { id: 'p2', name: 'Two', createdAt: 2 }, { id: 'p3', name: 'Empty', createdAt: 3 }], lists: { ...store.state.lists, active: { items, loaded: true } } });
    await store.openStartWork({ projectId: 'p1', prompt: 'Fix it' });
    store.setStartField('role', 'worker');
    expect(store.startOwner().groups.map((g: { label: string }) => g.label)).toEqual(['One', 'Two', 'No project']);
    expect(store.startOwner().groups[1].choices.map((o: { id: string }) => o.id)).toEqual(['lead2', 'other']);
    store.setStartField('parent', 'other');
    expect(store.state.startWork.projectId).toBe('p2');
    expect(store.startOwner().owner.id).toBe('other');
    store.setStartField('parent', 'solo');
    expect(store.state.startWork.projectId).toBeNull();
    expect(store.startOwner().owner.id).toBe('solo');
    store.setStartField('parent', 'other');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await store.submitStartWork();
    expect(sent).toMatchObject({ role: 'worker', projectId: 'p2', parentItemId: 'other' });
    await store.openStartWork({ projectId: 'p3' });
    expect(store.startOwner().groups[0]).toMatchObject({ label: 'Empty', choices: [] });
  });

  it('leaves a project for the named agent’s space and submits its owner there', async () => {
    let sent: Record<string, unknown> | null = null;
    const items = [
      { ...item('lead', 'tango', 100, 'p1'), facts: { projectId: 'p1', role: 'default' } },
      { ...item('agent-chat', 'tango', 200), source: 'discord', agentId: 'helper', facts: { role: 'default' } },
      item('personal', 'tango', 300),
    ];
    const store = createStore({ mode: 'fixtures',
      startWorkOptions: async () => ({ ...options, agents: [{ id: 'helper', name: 'Helper' }] }),
      items: async () => ({ items: [] }),
      startAgentThread: async (body: Record<string, unknown>) => ((sent = body), { agent: { name: 'Helper' }, title: 'Fix it', itemId: 'new' }),
    });
    store.set({ projects: [{ id: 'p1', name: 'One' }], lists: { ...store.state.lists, active: { items, loaded: true } } });
    await store.openStartWork({ projectId: 'p1', agentId: 'helper', prompt: 'Fix it' });
    store.setStartField('role', 'worker');
    expect(store.startOwner().groups.map((g: { label: string }) => g.label)).toEqual(['One', 'Helper']);
    expect(store.startOwner().groups[1]).toMatchObject({ space: { kind: 'agent', id: 'helper' }, projectId: null });
    expect(store.startOwner().groups[1].choices.map((o: { id: string }) => o.id)).toEqual(['agent-chat']);
    store.setStartField('parent', 'agent-chat');
    expect(store.state.startWork.projectId).toBeNull();
    expect(store.startOwner().owner.id).toBe('agent-chat');
    expect(store.startOwner().groups.map((g: { label: string }) => g.label)).not.toContain('No project');
    await store.submitStartWork();
    expect(sent).toMatchObject({ agentId: 'helper', role: 'worker', parentItemId: 'agent-chat' });
    expect(sent).not.toHaveProperty('projectId');
  });

  it('starts a thread with no role or owner', async () => {
    let sent: Record<string, unknown> | null = null;
    const client = { mode: 'fixtures', startWorkOptions: async () => options, items: async () => ({ items: [] }), startWork: async (body: Record<string, unknown>) => ((sent = body), { plan: { repo: { name: 'x' }, account: { name: 'A' }, title: 't' } }) };
    const store = createStore(client);
    await store.openStartWork({ prompt: 'Fix it' });
    store.setStartField('repo', 'p-tango');
    store.setStartField('role', 'ops');
    await store.submitStartWork();
    expect(sent).toBeNull(); // a job with no one to report to waits
    store.setStartField('role', 'interactive');
    await store.submitStartWork();
    expect(sent).not.toHaveProperty('role');
    expect(sent).not.toHaveProperty('parentItemId');
  });

  it('falls back to the usual default when the project has no Loom thread yet', async () => {
    const store = createStore({ mode: 'fixtures', startWorkOptions: async () => options });
    store.set({ lists: { ...store.state.lists, active: { ...store.state.lists.active, items: [item('a', 'tango', 300)] } } });
    await store.openStartWork({ projectId: 'proj-1' });
    expect(store.state.startWork.form).toMatchObject({ repo: 'p-tango', repoFrom: 'recent' });
  });

  it('moves to the project’s repo when a refresh brings its thread in, unless the owner picked one', async () => {
    const items = [item('a', 'tango', 300), item('c', 'acme-web', 200, 'proj-1')];
    const client = { mode: 'fixtures', startWorkOptions: async () => options, items: async ({ view }: { view: string }) => ({ items: view === 'active' ? items : [] }) };
    const store = createStore(client);
    store.set({ lists: Object.fromEntries(Object.entries(store.state.lists).map(([k, v]) => [k, { ...(v as object), loaded: true }])) }); // the page already loaded them
    await store.openStartWork({ projectId: 'proj-1' });
    expect(store.state.startWork.form.repo).toBe('');
    store.refreshLists(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.state.startWork.form).toMatchObject({ repo: 'p-web', repoFrom: 'project' });

    store.setStartField('repo', 'p-tango');
    store.refreshLists(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.state.startWork.form).toMatchObject({ repo: 'p-tango', repoFrom: 'picked' });
  });

  it('follows the newest project thread when refreshed lists land out of order', async () => {
    const lists: Record<string, unknown[]> = { history: [{ ...item('old', 'acme', 100, 'proj-1'), disposition: 'done' }], active: [item('new', 'acme-web', 200, 'proj-1')] };
    // The test lands each list when it says, so the order never depends on timers under load.
    const land: Record<string, () => void> = {};
    const client = {
      mode: 'fixtures',
      startWorkOptions: async () => options,
      items: ({ view }: { view: string }) => new Promise((resolve) => (lists[view] ? (land[view] = () => resolve({ items: lists[view] })) : resolve({ items: [] }))),
    };
    const store = createStore(client);
    store.set({ lists: Object.fromEntries(Object.entries(store.state.lists).map(([k, v]) => [k, { ...(v as object), loaded: true }])) }); // the page already loaded them
    await store.openStartWork({ projectId: 'proj-1' });
    store.refreshLists(0);
    for (let i = 0; i < 200 && !(land.history && land.active); i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    land.history();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.state.startWork.form.repo).toBe('p-acme');
    land.active();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.state.startWork.form).toMatchObject({ repo: 'p-web', repoFrom: 'project' });
  });

  it('on a fresh page, loads the project’s lists before the sheet is ready', async () => {
    const client = { mode: 'fixtures', startWorkOptions: async () => options, items: async ({ view }: { view: string }) => ({ items: view === 'active' ? [item('c', 'acme-web', 200, 'proj-1')] : [] }) };
    const store = createStore(client);
    await store.openStartWork({ projectId: 'proj-1' });
    expect(store.state.startWork).toMatchObject({ loading: false, form: { repo: 'p-web', repoFrom: 'project' } });
  });

  it('shares the startup list loads rather than racing them', async () => {
    let calls = 0;
    const client = { mode: 'fixtures', startWorkOptions: async () => options, items: ({ view }: { view: string }) => (calls++, new Promise((resolve) => setTimeout(() => resolve({ items: view === 'active' ? [item('c', 'acme-web', 200, 'proj-1')] : [] }), 5))) };
    const store = createStore(client);
    store.refreshLists(0);
    await new Promise((resolve) => setTimeout(resolve, 1));
    await store.openStartWork({ projectId: 'proj-1' });
    expect(calls).toBe(4);
    expect(store.state.startWork.form).toMatchObject({ repo: 'p-web', repoFrom: 'project' });
  });

  it('picking a project in the sheet joins it and follows its repo, unless the owner picked one', async () => {
    const items = [item('a', 'tango', 300), item('c', 'acme-web', 200, 'proj-1')];
    const client = { mode: 'fixtures', startWorkOptions: async () => options, startWork: async (body: unknown) => ((sent = body), { plan: { repo: { name: 'x' }, account: { name: 'A' }, title: 't' } }), items: async ({ view }: { view: string }) => ({ items: view === 'active' ? items : [] }) };
    let sent: unknown = null;
    const store = createStore(client);
    await store.openStartWork();
    expect(store.state.startWork.projectId).toBeNull();
    await store.setStartProject('proj-1');
    expect(store.state.startWork).toMatchObject({ projectId: 'proj-1', form: { repo: 'p-web', repoFrom: 'project' } });

    // None: the thread starts on its own, on the repo it had.
    await store.setStartProject('');
    expect(store.state.startWork).toMatchObject({ projectId: null, form: { repo: 'p-web', repoFrom: 'last' } });

    store.setStartField('repo', 'p-acme');
    await store.setStartProject('proj-1');
    expect(store.state.startWork.form).toMatchObject({ repo: 'p-acme', repoFrom: 'picked' });
    store.setStartField('prompt', 'Fix it');
    await store.submitStartWork();
    expect(sent).toMatchObject({ repo: 'p-acme', projectId: 'proj-1' });
  });

  it('says the repo is the project’s when picking a project whose repo is already selected', async () => {
    const items = [item('a', 'acme-web', 300), item('c', 'acme-web', 200, 'proj-1')];
    const store = createStore({ mode: 'fixtures', startWorkOptions: async () => options, items: async ({ view }: { view: string }) => ({ items: view === 'active' ? items : [] }) });
    store.set({ lists: { ...store.state.lists, active: { ...store.state.lists.active, items } } });
    await store.openStartWork();
    expect(store.state.startWork.form).toMatchObject({ repo: 'p-web', repoFrom: 'recent' });
    await store.setStartProject('proj-1');
    expect(store.state.startWork.form).toMatchObject({ repo: 'p-web', repoFrom: 'project' });
  });

  it('holds Start while a picked project’s repo is still loading', async () => {
    let land = (): void => {};
    let sent: unknown = null;
    const client = {
      mode: 'fixtures',
      startWorkOptions: async () => options,
      startWork: async (body: unknown) => ((sent = body), { plan: { repo: { name: 'x' }, account: { name: 'A' }, title: 't' } }),
      items: ({ view }: { view: string }) => new Promise((resolve) => (view === 'active' ? (land = () => resolve({ items: [item('c', 'acme-web', 200, 'proj-1')] })) : resolve({ items: [] }))),
    };
    const store = createStore(client);
    await store.openStartWork({ prompt: 'Fix it' });
    store.setStartField('repo', 'p-tango');
    store.set({ startWork: { ...store.state.startWork, form: { ...store.state.startWork.form, repoFrom: 'last' } } });
    const picking = store.setStartProject('proj-1');
    expect(store.state.startWork.projectLoading).toBe(true);
    await store.submitStartWork();
    expect(sent).toBeNull();
    land();
    await picking;
    expect(store.state.startWork).toMatchObject({ projectLoading: false, form: { repo: 'p-web' } });
    await store.submitStartWork();
    expect(sent).toMatchObject({ repo: 'p-web', projectId: 'proj-1' });
  });

  it('says to check the repo when the project’s threads couldn’t be read', async () => {
    const client = { mode: 'fixtures', startWorkOptions: async () => options, items: async () => Promise.reject(new Error('offline')) };
    const store = createStore(client);
    await store.openStartWork({ prompt: 'Fix it' });
    store.setStartField('repo', 'p-tango');
    store.set({ startWork: { ...store.state.startWork, form: { ...store.state.startWork.form, repoFrom: 'last' } } });
    await store.setStartProject('proj-1');
    expect(store.state.startWork).toMatchObject({ projectLoading: false, projectId: 'proj-1', form: { repo: 'p-tango', repoFrom: 'unread' } });
  });

  it('Start closes the sheet at the tap; a failure is a toast with Retry (same command id) and Edit', async () => {
    const options = { repos: repos.map((r) => ({ ...r, account: 'claude-a', mode: 'worktree' })), accounts: [{ id: 'claude-a', name: 'A' }] };
    const sent: Array<Record<string, unknown>> = [];
    let fail = true;
    const client = {
      mode: 'fixtures',
      startWorkOptions: async () => options,
      items: async () => ({ items: [] }),
      startWork: async (body: Record<string, unknown>) => {
        sent.push(body);
        if (fail) throw Object.assign(new Error('Loom is restarting'), { body: { error: 'Loom is restarting' } });
        return { plan: { repo: { name: 'tango' }, account: { name: 'A' }, title: 'Fix it' } };
      },
    };
    const store = createStore(client);
    await store.openStartWork();
    store.setStartField('prompt', 'Fix it');
    const starting = store.submitStartWork();
    expect(store.state.startWork).toBeNull();
    await starting;
    const toast = store.state.toasts.at(-1);
    expect(toast).toMatchObject({ sticky: true, text: expect.stringContaining('Loom is restarting') });
    expect(toast.actions.map((a: { label: string }) => a.label)).toEqual(['Retry', 'Edit']);

    // Edit: the sheet comes back with what was written and why it failed.
    toast.actions[1].fn();
    expect(store.state.startWork).toMatchObject({ form: { prompt: 'Fix it' }, error: 'Loom is restarting', commandId: sent[0].commandId });
    store.closeStartWork();

    // A sheet opened while a start is on its way is the owner's new one: a failure leaves its picks alone.
    fail = true;
    await store.openStartWork();
    store.setStartField('repo', 'p-acme');
    await toast.actions[0].fn();
    expect(store.state.startWork.form).toMatchObject({ repo: 'p-acme', prompt: '' });
    expect(store.state.toasts.at(-1).text).toContain('didn’t start');
    store.closeStartWork();

    fail = false;
    await toast.actions[0].fn();
    expect(sent[2].commandId).toBe(sent[0].commandId);
    expect(store.state.toasts.at(-1).text).toContain('Started in tango');
  });
});

describe('Start work mode defaults', () => {
  it('keeps Auto selected while intent and role update the hint', async () => {
    const options = { repos: [{id:'repo',name:'repo',mode:'worktree',account:'loom'}], accounts:[{id:'loom',driver:'loom'}] };
    const store = createStore({mode:'fixtures',startWorkOptions:async()=>options});
    await store.openStartWork({prompt:'Investigate the slow query'});
    expect(store.state.startWork.form.mode).toBe('auto');
    expect(store.state.startWork.form.modeHint).toBe('local');
    store.setStartField('prompt','Fix the slow query');
    expect(store.state.startWork.form.mode).toBe('auto');
    expect(store.state.startWork.form.modeHint).toBe('worktree');
    store.setStartField('role','ops');
    expect(store.state.startWork.form.mode).toBe('auto');
    expect(store.state.startWork.form.modeHint).toBe('local');
    store.setStartField('mode','worktree');
    store.setStartField('prompt','Review the query');
    expect(store.state.startWork.form.mode).toBe('worktree');
  });
});

describe('One place chip', () => {
  const options = { repos: repos.map((r) => ({ ...r, account: 'claude-a', mode: 'worktree' })), accounts: [{ id: 'claude-a', name: 'A' }], agents: [{ id: 'sierra', name: 'Sierra' }] };
  const projects = [
    { id: 'tango', name: 'Tango', color: 'violet', icon: null, createdAt: 0 },
    { id: 'desk', name: 'Desk', color: 'violet', icon: null, createdAt: 0, parent: 'project:tango' },
    { id: 'later', name: 'Later', color: 'violet', icon: null, createdAt: 0, parent: 'project:tango', away: { state: 'snoozed', until: Date.now() + 3_600_000 } },
    { id: 'bike', name: 'Bike', color: 'amber', icon: null, createdAt: 0, parent: 'agent:sierra' },
    { id: 'quote', name: 'Gutter quote', color: 'amber', icon: null, createdAt: 0, parent: 'agent:foxtrot' },
    { id: 'old', name: 'Old', color: 'slate', icon: null, createdAt: 0, finishedAt: 1 },
  ];
  const item = (id: string, area: string, lastActivityAt: number, projectId?: string) => ({ id, source: 'loom', area, lastActivityAt, disposition: 'active', facts: projectId ? { projectId } : {} });
  const withProjects = (client: Record<string, unknown> = {}) => {
    const store = createStore({ mode: 'fixtures', startWorkOptions: async () => options, items: async () => ({ items: [] }), ...client });
    store.set({ projects });
    return store;
  };
  const row = (e: { section: string; kind: string; id: string; child: boolean; disabled: boolean; away: string | null }) => `${e.section}:${e.kind}:${e.id}${e.child ? '^' : ''}${e.disabled ? '!' : ''}${e.away ? `(${e.away})` : ''}`;

  it('lists what the sidebar lists: projects with their children, startable agents with theirs, then repos', () => {
    expect(placeChoices(withProjects().state, options).map(row)).toEqual([
      'Projects:project:tango', 'Projects:project:desk^', 'Projects:project:later^(snoozed)', 'Projects:new:',
      'Agents:agent:foxtrot!', 'Agents:project:quote^', 'Agents:agent:sierra', 'Agents:project:bike^',
      'Repos:repo:p-tango', 'Repos:repo:p-acme', 'Repos:repo:p-web',
    ]);
    // An agent with nothing on the desk and no projects lists only when a thread can start with it.
    expect(placeChoices(withProjects().state, { ...options, agents: [{ id: 'watson', name: 'Watson' }] }).map(row)).toContain('Agents:agent:watson');
  });

  it('a query keeps a parent whose child matches, and a child whose parent does', () => {
    const state = withProjects().state;
    expect(placeChoices(state, options, 'desk').map(row)).toEqual(['Projects:project:tango', 'Projects:project:desk^']);
    expect(placeChoices(state, options, 'sierra').map(row)).toEqual(['Agents:agent:sierra', 'Agents:project:bike^']);
    expect(placeChoices(state, options, 'lat').map(row)).toEqual(['Projects:project:tango', 'Projects:project:later^(snoozed)']);
    expect(placeChoices(state, options, 'zzz')).toEqual([]);
  });

  it('the chip names the project with its parent as a crumb, else the agent, else the repo', async () => {
    const store = withProjects();
    await store.openStartWork({ projectId: 'desk' });
    const sw = store.state.startWork;
    expect(startPlace(sw, store.state, options)).toMatchObject({ kind: 'project', id: 'desk', name: 'Desk', crumb: 'Tango' });
    expect(startPlace({ ...sw, projectId: 'bike' }, store.state, options)).toMatchObject({ kind: 'project', name: 'Bike', crumb: 'Sierra' });
    expect(startPlace({ ...sw, projectId: 'tango' }, store.state, options)).toMatchObject({ kind: 'project', name: 'Tango', crumb: null });
    expect(startPlace({ ...sw, projectId: null, form: { ...sw.form, agent: 'sierra' } }, store.state, options)).toMatchObject({ kind: 'agent', name: 'Sierra' });
    expect(startPlace({ ...sw, projectId: null, form: { ...sw.form, agent: '', repo: 'p-tango' } }, store.state, options)).toMatchObject({ kind: 'repo', name: 'tango' });
    expect(startPlace({ ...sw, projectId: null, form: { ...sw.form, agent: '', repo: '' } }, store.state, options)).toBeNull();
  });

  it('picking a project takes its repo, even over a repo picked for an earlier place; Options → Repo still overrides', async () => {
    const items = [item('a', 'tango', 300), item('c', 'acme-web', 200, 'desk')];
    const store = withProjects({ items: async ({ view }: { view: string }) => ({ items: view === 'active' ? items : [] }) });
    await store.openStartWork();
    await store.pickStartPlace({ kind: 'repo', id: 'p-acme' });
    expect(store.state.startWork).toMatchObject({ projectId: null, form: { repo: 'p-acme', repoFrom: 'picked', agent: '', placeOpen: false } });
    await store.pickStartPlace({ kind: 'project', id: 'desk' });
    expect(store.state.startWork).toMatchObject({ projectId: 'desk', form: { repo: 'p-web', repoFrom: 'project', agent: '' } });
    store.setStartField('repo', 'p-tango');
    expect(store.state.startWork.form).toMatchObject({ repo: 'p-tango', repoFrom: 'picked' });
    // A project with no thread yet keeps the repo it had, as a plain default.
    await store.pickStartPlace({ kind: 'project', id: 'tango' });
    expect(store.state.startWork).toMatchObject({ projectId: 'tango', form: { repo: 'p-tango', repoFrom: 'last' } });
  });

  it('a project an agent owns is a thread with that agent, in the project; one whose agent can’t start is a coding thread there', async () => {
    const store = withProjects();
    await store.openStartWork({ prompt: 'Fix it' });
    await store.pickStartPlace({ kind: 'project', id: 'bike' });
    expect(store.state.startWork).toMatchObject({ projectId: 'bike', form: { agent: 'sierra', plan: false, account: '' } });
    await store.pickStartPlace({ kind: 'project', id: 'quote' });
    expect(store.state.startWork).toMatchObject({ projectId: 'quote', form: { agent: '' } });
    await store.pickStartPlace({ kind: 'agent', id: 'sierra' });
    expect(store.state.startWork).toMatchObject({ projectId: null, form: { agent: 'sierra', placeOpen: false, placeQuery: '' } });
  });

  it('opened from the project itself (its +, its menu, n), the same place starts the same thread', async () => {
    const store = withProjects();
    await store.openStartWork({ projectId: 'bike', prompt: 'In tango, fix it' });
    // With the agent picked, a repo the words name is just words.
    expect(store.state.startWork).toMatchObject({ projectId: 'bike', form: { agent: 'sierra', repoInferred: false } });
    store.closeStartWork();
    await store.openStartWork({ projectId: 'quote' });
    expect(store.state.startWork).toMatchObject({ projectId: 'quote', form: { agent: '' } });
    store.closeStartWork();
    await store.openStartWork({ projectId: 'desk' });
    expect(store.state.startWork).toMatchObject({ projectId: 'desk', form: { agent: '' } });
  });

  it('closing the picker drops its query; Options → Repo says why the repo is what it is; the footer names it for a project’s thread', async () => {
    const store = withProjects();
    await store.openStartWork();
    store.setStartField('placeOpen', true);
    store.setStartField('placeQuery', 'des');
    store.setStartField('placeOpen', false);
    expect(store.state.startWork.form).toMatchObject({ placeOpen: false, placeQuery: '' });

    expect(repoWhy({ repoFrom: 'project', repo: 'p-web' })).toBe('Where the project’s latest thread runs');
    expect(repoWhy({ repoFrom: 'picked', repo: 'p-web' })).toBe('You picked it');
    expect(repoWhy({ repoFrom: 'last', repo: 'p-web', repoInferred: true })).toBe('Named in what you wrote');
    expect(repoWhy({ repoFrom: 'unread', repo: 'p-web' })).toBe('Check it: the project’s threads couldn’t be read');
    expect(repoWhy({ repoFrom: 'last', repo: '' })).toBe('The project has no thread yet');
    const web = repos[2];
    expect(repoLine({ repoFrom: 'project' }, web, 'desk')).toBe('In acme-web');
    expect(repoLine({ repoFrom: 'unread' }, web, 'desk')).toBe('In acme-web? Its threads couldn’t be read: check the repo in Options');
    expect(repoLine({ repoFrom: 'last', repoInferred: true }, web, null)).toBe('Switched to acme-web: your description names it');
    expect(repoLine({ repoFrom: 'last' }, web, null)).toBe('');
    expect(repoLine({ repoFrom: 'last' }, null, 'desk')).toBe('');
  });
});
