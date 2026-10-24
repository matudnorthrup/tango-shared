import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain browser module, no types
import { inList, overlaidLists, predict } from '../public/desk/optimistic.js';
// @ts-expect-error plain browser module, no types
import { createStore } from '../public/desk/store.js';
// @ts-expect-error plain browser module, no types
import { bulkDone, bulkRead } from '../public/desk/next/select.js';

// The desk's default for a tap: the command's effect shows at once (optimistic.js), the request goes out
// behind it, and a failure takes it back with Retry. Synthetic content only.

type Item = Record<string, unknown> & { id: string };
const row = (id: string, extra: Record<string, unknown> = {}): Item => ({ id, source: 'discord', agentName: 'Sierra', place: `Place ${id}`, disposition: 'active', seen: 'seen', nextStep: 'your_move', facts: {}, ...extra });
const t3row = (id: string, place: string) => row(id, { source: 'loom', place });

describe('predict: what a command does to its item', () => {
  it.each(['active', 'snoozed', 'parked'])('Clear keeps a default in %s and reads it', (disposition) => {
    const item = row('lead', { source: 'loom', disposition, seen: 'new', facts: { role: 'default' }, status: { pill: 'finished', unread: true } });
    expect(predict('done', item)).toMatchObject({ disposition, seen: 'seen', status: { pill: 'idle', unread: false } });
  });
  it('files an old chapter when the server says it is no longer standing', () => {
    const item = row('old-chapter', { kind: 'chapter', facts: { standing: false } });
    expect(predict('done', item)).toMatchObject({ disposition: 'done' });
  });
  it('does not optimistically drop a default during a sweep', () => {
    const item = row('lead', { facts: { role: 'default' }, seen: 'new' });
    expect(predict('sweep', item, { decision: 'drop' })).toEqual(item);
  });
  it('Clear on a chapter preserves an open question and its Needs you status', () => {
    const pending = { kind: 'question', requestId: 'question-1' };
    const item = row('chapter', { kind: 'chapter', seen: 'new', facts: { pending }, status: { pill: 'needs', layer: 'needs', unread: true } });
    expect(predict('done', item)).toMatchObject({ disposition: 'active', seen: 'seen', facts: { pending }, status: { pill: 'needs', layer: 'needs', unread: false } });
    expect(inList(predict('done', item), 'history')).toBe(false);
  });

  it('answering a brief the row carries drops only that brief; the row’s own question stays', () => {
    const brief = { kind: 'question', requestId: 'decision:D-6', questions: [], question: 'Finish it?', options: [] };
    const own = { kind: 'question', requestId: 'own-q', questions: [], question: 'Which space?', options: [] };
    const carried = [{ from: { itemId: 'w', title: 'Worker' }, pending: brief, why: 'worker', counts: true }];
    const both = row('lead', { facts: { pending: own, carried } });
    expect(predict('respond', both, { requestId: 'decision:D-6' })).toMatchObject({ nextStep: 'your_move', facts: { pending: own, carried: [] } });
    // Carried as the row's question: it goes, and the lead isn't predicted to start work.
    const only = row('lead', { facts: { pending: brief, carried } });
    expect(predict('respond', only, { requestId: 'decision:D-6' })).toMatchObject({ nextStep: 'fyi', facts: { pending: null, carried: [] } });
  });

  it('shows Sent after words, unless another request still needs the owner', () => {
    const status = { pill: 'finished', countsForOwner: false };
    for (const type of ['reply', 'retry', 'approve', 'dismiss']) {
      expect(predict(type, row('a', { status }), { text: 'Continue' }).status).toMatchObject({ pill: 'working', detail: 'sent', countsForOwner: false });
    }
    const needs = { pill: 'needs', countsForOwner: true };
    const pending = { requestId: 'q1', kind: 'question' };
    const asked = row('a', { status: needs, facts: { pending } });
    // Typed words past an open question are the agent's to answer: the row leaves Needs you at the tap (owner, 10/22).
    const sent = predict('reply', asked, { text: 'Continue' });
    expect(sent.status).toMatchObject({ pill: 'working', detail: 'sent', countsForOwner: false, layer: 'active' });
    expect(sent.facts).toMatchObject({ lastAuthor: 'owner', lastOwnerRequest: { text: 'Continue' } });
    expect(predict('reply', row('a', { status: needs, facts: { openBrief: pending, openBriefCount: 2 } }), { attachments: [{}] }).status.detail).toBe('sent');
    expect(predict('reply', asked, { text: '  ' }).status).toEqual(needs);
    expect(predict('answer', asked, { option: 'Yes' }).status.pill).toBe('working');
    const brief = row('a', { status: needs, facts: { openBrief: pending } });
    expect(predict('respond', brief, { requestId: 'q1' }).status.pill).toBe('working');
    expect(predict('respond', brief, { requestId: 'q2' }).status).toEqual(needs);
    expect(predict('answer', row('a', { status: needs, facts: { pending, openBrief: { requestId: 'q2' } } }), { option: 'Yes' }).status).toEqual(needs);
    expect(predict('reply', row('a', { status: needs, facts: { carried: [{ counts: true, pending }] } }), { text: 'Continue' }).status.detail).toBe('sent');
    // The row shows one of two open briefs: answering it leaves the other, so still Needs you.
    const shown = { requestId: 'decision:D-1', kind: 'question', brief: { id: 'D-1' } };
    expect(predict('respond', row('a', { status: needs, facts: { pending: shown, openBrief: shown, openBriefCount: 2 } }), { requestId: 'decision:D-1' }).status).toEqual(needs);
    expect(predict('answer', row('a', { status: needs, facts: { pending: shown, openBriefCount: 2 } }), { option: 'Yes' }).status).toEqual(needs);
    expect(predict('respond', row('a', { status: needs, facts: { pending: shown, openBrief: shown, openBriefCount: 1 } }), { requestId: 'decision:D-1' }).status.pill).toBe('working');
    // A brief answered beside a live question of another id: the question stays, and so does Needs you.
    const both = predict('respond', row('a', { status: needs, facts: { pending, openBrief: shown, openBriefCount: 1 } }), { requestId: 'decision:D-1' });
    expect(both.facts.pending).toEqual(pending);
    expect(both.status).toEqual(needs);
    expect(predict('reply', row('a'), { text: 'Continue' })).not.toHaveProperty('status');
  });

  it('moves it between lists as the server would', () => {
    const item = row('a');
    expect(inList(predict('done', item), 'history')).toBe(true);
    expect(inList(predict('done', item), 'active')).toBe(false);
    expect(predict('snooze', item, { trigger: 'agent_posts' })).toMatchObject({ disposition: 'snoozed', snoozeTrigger: 'agent_posts' });
    expect(inList(predict('park', item), 'snoozed')).toBe(true);
    // Back to Active and seen, as the server's activeSeen does.
    expect(predict('pickup', { ...item, disposition: 'parked', seen: 'new' })).toMatchObject({ disposition: 'active', seen: 'seen' });
    expect(predict('sweep', { ...item, disposition: 'parked' }, { decision: 'keep' })).toMatchObject({ disposition: 'active', seen: 'seen' });
    expect(predict('reopen', { ...item, disposition: 'done' })).toMatchObject({ disposition: 'active', doneAt: null });
    expect(predict('sweep', item, { decision: 'drop' }).disposition).toBe('done');
    // Putting it away yourself reads it (#678); Mark read and unread leave it where it is (#684).
    expect(predict('snooze', { ...item, seen: 'new' }, { trigger: 'agent_posts' }).seen).toBe('seen');
    expect(predict('seen', { ...item, disposition: 'parked', seen: 'new' }, { via: 'read' })).toMatchObject({ disposition: 'parked', seen: 'seen' });
    expect(predict('seen', { ...item, disposition: 'parked', seen: 'new' }, { via: 'viewed' })).toMatchObject({ disposition: 'parked', seen: 'seen' });
    expect(predict('seen', { ...item, disposition: 'parked', seen: 'new' }, {})).toMatchObject({ disposition: 'active', seen: 'seen' });
    expect(predict('unseen', { ...item, disposition: 'done' })).toMatchObject({ disposition: 'done', seen: 'new' });
  });

  it('labels, renames, pins, moves and tags as the desk does', () => {
    expect(predict('label', row('a'), { label: 'bug' }).facts.listLabel).toBe('bug');
    expect(predict('label', t3row('t', 'tango · feat: Fix it'), { label: 'bug' }).place).toBe('tango · bug: Fix it');
    expect(predict('rename', row('a'), { title: '  New   name ' }).facts.name).toBe('New name');
    expect(predict('rename', t3row('t', 'tango · Old'), { title: 'New' }).place).toBe('tango · New');
    // A Loom thread needs a title: an empty one is refused, so nothing is predicted.
    expect(predict('rename', t3row('t', 'tango · Old'), { title: ' ' })).toBeUndefined();
    expect(predict('pin', { ...row('a'), disposition: 'done' }, { pinned: true })).toMatchObject({ disposition: 'active', facts: { pinned: true } });
    expect(predict('pin', { ...row('a'), disposition: 'parked', heldBy: { projectId: 'p1' } }, { pinned: true }).disposition).toBe('parked');
    expect(predict('project', row('a'), { projectId: 'p1' }).facts.projectId).toBe('p1');
    expect(predict('role', row('a'), { role: 'ops' }).facts.role).toBe('ops');
    expect(predict('keep', row('a'), { keep: true }).facts.keepSession).toBe(true);
    expect(predict('keep', row('a', { facts: { keepSession: true } }), { keep: false }).facts.keepSession).toBe(false);
    expect(predict('pause', row('j', { facts: { schedule: { every: '1d' } } }), { paused: true }).facts.schedule).toEqual({ every: '1d', paused: true });
    expect(predict('run', row('j')).nextStep).toBe('working');
    expect(predict('space', row('a'), { agent: { id: 'Compass', name: 'Compass' } }).facts.agentSpace).toEqual({ id: 'compass', name: 'Compass' });
    expect(predict('space', row('a', { facts: { agentSpace: { id: 'm', name: 'M' } } }), { agent: null }).facts.agentSpace).toBeNull();
    // Into a parked project: held by it. Out of it: back in Active.
    const projects = [{ id: 'p2', name: 'Away', away: { state: 'parked', at: 1 } }];
    expect(predict('project', row('a'), { projectId: 'p2' }, { projects })).toMatchObject({ disposition: 'parked', heldBy: 'p2' });
    // Reopen lands under an away project's hold; Pick up brings it back regardless.
    const finished = row('d', { disposition: 'done', facts: { projectId: 'p2' } });
    expect(predict('reopen', finished, {}, { projects })).toMatchObject({ disposition: 'parked', heldBy: 'p2' });
    expect(predict('pickup', { ...finished, disposition: 'parked', heldBy: 'p2' }, {}, { projects })).toMatchObject({ disposition: 'active', heldBy: null });
    // Put away on its own: picked up, it falls back under the away project's hold.
    expect(predict('pickup', finished, {}, { projects })).toMatchObject({ disposition: 'parked', heldBy: 'p2' });
    // A pin promotes it, under its away project's hold.
    expect(predict('pin', finished, { pinned: true }, { projects })).toMatchObject({ disposition: 'parked', heldBy: 'p2' });
    // Moving it into an away project: an old project's pickup doesn't exempt it.
    expect(predict('project', row('e', { facts: { projectId: 'p9', projectPickedUpAt: 5 } }), { projectId: 'p2' }, { projects })).toMatchObject({ disposition: 'parked', heldBy: 'p2' });
    // Picked up since the project went away: a later Reopen isn't held.
    expect(predict('reopen', { ...finished, facts: { projectId: 'p2', projectPickedUpAt: 2 } }, {}, { projects }).disposition).toBe('active');
    // Activity isn't an agent post (only the server knows those): still predicted held.
    expect(predict('project', row('a', { lastActivityAt: 5 }), { projectId: 'p2' }, { projects }).disposition).toBe('parked');
    expect(predict('project', row('a', { disposition: 'parked', heldBy: 'p2', facts: { projectId: 'p2' } }), { projectId: null }, { projects })).toMatchObject({ disposition: 'active', heldBy: null });
    expect(predict('tag', row('a'), { stage: 'feedback' })).toMatchObject({ disposition: 'parked', facts: { stage: 'feedback' } });
    expect(predict('tag', row('a'), { type: 'bug' })).toMatchObject({ disposition: 'active', facts: { type: 'bug' } });
    // To Feedback from a project's hold: the owner's own park now.
    expect(predict('tag', row('a', { disposition: 'parked', heldBy: 'p1', seen: 'new' }), { stage: 'feedback' })).toMatchObject({ disposition: 'parked', heldBy: null, seen: 'seen' });
    // Keep in the sweep: still held by its project.
    expect(predict('sweep', row('a', { disposition: 'parked', heldBy: 'p1' }), { decision: 'keep' })).toMatchObject({ disposition: 'parked', heldBy: 'p1' });
  });

  it('an answer puts the question away and the agent back to work; Undo waits for the server', () => {
    const asked = row('a', { facts: { pending: { kind: 'question' } }, ask: 'Which?' });
    expect(predict('respond', asked, {})).toMatchObject({ nextStep: 'working', ask: null, facts: { pending: null } });
    expect(predict('reply', row('a'), { text: 'hi' }).nextStep).toBe('working');
    // The row shows the words just sent at once (next/model.js previewOf).
    expect(predict('reply', row('a'), { text: ' hi ' }).facts).toMatchObject({ lastAuthor: 'owner', lastOwnerRequest: { text: 'hi' } });
    expect(predict('answer', row('a'), { option: 'Sony' }).facts.lastOwnerRequest).toMatchObject({ text: 'Sony' });
    expect(predict('reply', row('a'), { text: '', attachments: [{}, {}] }).facts.lastOwnerRequest).toMatchObject({ text: '(2 images)' });
    // Writing in a snoozed or finished conversation picks it back up.
    expect(predict('reply', row('a', { disposition: 'done' }), { text: 'one more thing' })).toMatchObject({ disposition: 'active', nextStep: 'working' });
    expect(predict('undo', row('a'), { seq: 3 })).toBeUndefined();
    expect(predict('stop', row('a', { source: 'loom', facts: { running: { turnId: 't1' } } })).facts.running).toBeNull();
  });

  it('overlaid lists drop a done item from Active and add it to History at once', () => {
    const raw = { active: [row('a'), row('b')], snoozed: [], history: [], everything: [row('a'), row('b')] };
    const lists = overlaidLists(raw, [{ itemId: 'a', apply: (it: Item) => predict('done', it) }]);
    expect(lists.active.map((i: Item) => i.id)).toEqual(['b']);
    expect(lists.history.map((i: Item) => i.id)).toEqual(['a']);
    expect(lists.everything.find((i: Item) => i.id === 'a').disposition).toBe('done');
  });

  it('checks the filters again on the predicted item: a type changed to a muted one stays annotated in Active', () => {
    const hideBugs = (item: Item) => ((item.facts as { type?: string })?.type === 'bug' ? [{ facet: 'type', value: 'bug' }] : []);
    const raw = { active: [row('a')], snoozed: [], history: [], everything: [row('a')] };
    const lists = overlaidLists(raw, [{ itemId: 'a', apply: (it: Item) => predict('tag', it, { type: 'bug' }) }], {}, hideBugs);
    expect(lists.active.map((i: Item) => i.id)).toEqual(['a']);
    expect(lists.everything[0].filteredBy).toEqual([{ facet: 'type', value: 'bug' }]);
    // And one changed away from a hidden type joins it.
    const hidden = row('b', { facts: { type: 'bug' }, filteredBy: [{ facet: 'type', value: 'bug' }] });
    const back = overlaidLists({ active: [], snoozed: [], history: [], everything: [hidden] }, [{ itemId: 'b', apply: (it: Item) => predict('tag', it, { type: 'feat' }) }], {}, hideBugs);
    expect(back.active.map((i: Item) => i.id)).toEqual(['b']);
    // Pick up releases a project's hold.
    expect(predict('pickup', row('c', { disposition: 'parked', heldBy: 'p1' })).heldBy).toBeNull();
  });

  it('keeps muted items in Active, and adds from the freshest copy', () => {
    const filtered = row('a', { disposition: 'snoozed', filteredBy: [{ kind: 'agent' }] });
    const back = overlaidLists({ active: [], snoozed: [filtered], history: [], everything: [filtered] }, [{ itemId: 'a', apply: (it: Item) => predict('pickup', it) }]);
    expect(back.active.map((i: Item) => i.id)).toEqual(['a']);
    // Everything was read later than Snoozed: its copy (newer activity) is the one added to Active.
    const older = row('b', { disposition: 'snoozed', lastActivityAt: 1 });
    const newer = row('b', { disposition: 'snoozed', lastActivityAt: 2 });
    const lists = overlaidLists({ active: [], snoozed: [older], history: [], everything: [newer] }, [{ itemId: 'b', apply: (it: Item) => predict('pickup', it) }], { snoozed: 10, everything: 20 });
    expect(lists.active[0].lastActivityAt).toBe(2);
    // Each list keeps its own copy.
    expect(lists.everything[0].lastActivityAt).toBe(2);
    // The open Conversation read after both: its copy is the one added.
    const fromDetail = overlaidLists({ active: [], snoozed: [older], history: [], everything: [newer] }, [{ itemId: 'b', apply: (it: Item) => predict('pickup', it) }], { snoozed: 10, everything: 20 }, undefined, { item: row('b', { disposition: 'snoozed', lastActivityAt: 3 }), from: 30 });
    expect(fromDetail.active[0].lastActivityAt).toBe(3);
    // A personal snooze ends a project's hold on it.
    expect(predict('snooze', row('c', { disposition: 'parked', heldBy: 'p1' }), { trigger: 'agent_posts' }).heldBy).toBeNull();
  });
});

describe('store: every command is optimistic', () => {
  const setup = (items: Item[]) => {
    let listItems = items;
    const lands: Array<() => void> = [];
    let answer: Record<string, unknown> = { status: 'applied' };
    let readsFail = false;
    const client = {
      mode: 'fixtures',
      items: async ({ view }: { view: string }) => {
        if (readsFail) throw new Error('the desk is down');
        return { items: listItems.filter((i) => inList(i, view)), counts: {} };
      },
      item: async () => ({}),
      command: (cmd: Record<string, unknown>) => new Promise((resolve) => lands.push(() => resolve({ commandId: cmd.commandId, ...answer }))),
      present: async () => ({ view: 'active', itemId: null, queue: [] }),
    };
    const store = createStore(client);
    return {
      store,
      lands,
      setServer: (next: Item[]) => (listItems = next),
      breakReads: () => (readsFail = true),
      fail: (error: string, outcome?: Record<string, unknown>) => (answer = { status: 'failed', error, ...(outcome ? { outcome } : {}) }),
      load: () => Promise.all(['active', 'snoozed', 'everything', 'history'].map((view) => store.loadList(view))),
    };
  };
  const ids = (store: { state: { lists: Record<string, { items: Item[] }> } }, view: string) => store.state.lists[view].items.map((i) => i.id);

  it('Clear keeps the open default and its row visible while the server answers', async () => {
    const h = setup([row('lead', { facts: { role: 'default', job: { label: 'Background review' } }, seen: 'new' })]);
    await h.load();
    h.store.state.presentation = { view: 'conversation', itemId: 'lead', conversationKey: 'k', sceneId: null, queue: [], by: 'screen', since: 1 };
    const clearing = h.store.done('lead');
    expect(h.store.state.confirm).toBeNull();
    expect(h.store.state.presentation.itemId).toBe('lead');
    expect(ids(h.store, 'active')).toEqual(['lead']);
    expect(h.store.state.byId.lead.seen).toBe('seen');
    h.lands[0]();
    await clearing;
  });

  it('a Done leaves Active at the tap and stays gone until the server says the same', async () => {
    const h = setup([row('a'), row('b')]);
    await h.load();
    const doing = h.store.command('done', 'a');
    expect(ids(h.store, 'active')).toEqual(['b']);
    expect(h.store.state.byId.a.disposition).toBe('done');
    // A refresh that left before the answer still has it Active: the prediction holds.
    await h.load();
    expect(ids(h.store, 'active')).toEqual(['b']);
    h.setServer([row('a', { disposition: 'done' }), row('b')]);
    h.lands[0]();
    await doing;
    await h.load();
    expect(ids(h.store, 'active')).toEqual(['b']);
    expect(ids(h.store, 'history')).toEqual(['a']);
  });

  it('a failure puts it back and offers Retry, which sends the same command', async () => {
    const h = setup([row('a')]);
    await h.load();
    h.fail('the desk is restarting');
    const labelling = h.store.setLabel('a', 'bug');
    expect(h.store.state.byId.a.facts.listLabel).toBe('bug');
    h.lands[0]();
    await labelling;
    expect(h.store.state.byId.a.facts.listLabel).toBeUndefined();
    const toast = h.store.state.toasts.at(-1);
    expect(toast).toMatchObject({ sticky: true, text: expect.stringContaining('the desk is restarting') });
    expect(toast.actions.map((a: { label: string }) => a.label)).toEqual(['Retry', 'Open']);
    toast.actions[0].fn();
    expect(h.store.state.byId.a.facts.listLabel).toBe('bug');
    expect(h.lands).toHaveLength(2);
  });

  it('a failed reply restores its pill and offers Retry', async () => {
    const h = setup([row('a', { status: { pill: 'finished' } })]);
    await h.load();
    h.fail('send failed');
    const sending = h.store.command('reply', 'a', { text: 'Continue' });
    expect(h.store.state.byId.a.status.pill).toBe('working');
    h.lands[0]();
    await sending;
    expect(h.store.state.byId.a.status.pill).toBe('finished');
    expect(h.store.state.toasts.at(-1).actions.map((a: { label: string }) => a.label)).toContain('Retry');
  });

  it('a reply prediction expires after twenty seconds if filing never appears', async () => {
    vi.useFakeTimers();
    try {
      const h = setup([row('a', { status: { pill: 'finished' } })]);
      await h.load();
      const sending = h.store.command('reply', 'a', { text: 'Continue' });
      h.lands[0]();
      await sending;
      await h.load();
      expect(h.store.state.byId.a.status.pill).toBe('working');
      await vi.advanceTimersByTimeAsync(20_051);
      expect(h.store.state.byId.a.status.pill).toBe('finished');
    } finally {
      vi.useRealTimers();
    }
  });

  it('no Retry when the item changed since the tap', async () => {
    const h = setup([row('a', { disposition: 'snoozed' })]);
    await h.load();
    h.fail('it’s back in Active with something new', { changed: true });
    const parking = h.store.park('a');
    h.lands[0]();
    await parking;
    expect(h.store.state.toasts.at(-1).actions.map((a: { label: string }) => a.label)).toEqual(['Open']);
  });

  it('a quick snooze leaves the thread for the board at the tap', async () => {
    const h = setup([row('a')]);
    await h.load();
    h.store.state.presentation = { view: 'conversation', itemId: 'a', conversationKey: 'k', sceneId: null, queue: [], by: 'screen', since: 1 };
    const snoozing = h.store.quickSnooze('a');
    expect(h.store.state.presentation.view).toBe('active');
    expect(ids(h.store, 'active')).toEqual([]);
    h.lands[0]();
    await snoozing;
  });

  it('a prediction expires after 20 s even when the refreshes after it fail', async () => {
    vi.useFakeTimers();
    try {
      const h = setup([row('a')]);
      await h.load();
      const doing = h.store.command('done', 'a');
      // The server never answers a read again; the cap still lets the server's last copy show.
      h.breakReads();
      h.lands[0]();
      await doing;
      const store = h.store as unknown as { state: { byId: Record<string, Item> } };
      await vi.advanceTimersByTimeAsync(10_000);
      expect(store.state.byId.a.disposition).toBe('done');
      await vi.advanceTimersByTimeAsync(10_200);
      expect(store.state.byId.a.disposition).toBe('active');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('store: label order saves', () => {
  // Settings writes go in order: each is sent once the one before it has answered.
  const reorders = () => {
    const answers: Array<(ok: boolean) => void> = [];
    const sent: string[][] = [];
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [] }),
      saveSettings: (body: { labelOrder: string[] }) => (sent.push(body.labelOrder), new Promise((resolve, reject) => answers.push((ok) => (ok ? resolve({ labelOrder: body.labelOrder }) : reject(Object.assign(new Error('refused'), { body: { error: 'refused' } })))))),
    };
    return { store: createStore(client), answers, sent };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('two quick reorders go one at a time and settle on the newer', async () => {
    const { store, answers, sent } = reorders();
    const one = store.saveLabelOrder(['a']);
    const two = store.saveLabelOrder(['b']);
    expect(sent).toEqual([['a']]);
    answers[0](true);
    await one;
    await tick();
    expect(sent).toEqual([['a'], ['b']]);
    answers[1](true);
    await two;
    expect(store.state.labelOrder).toEqual(['b']);
  });

  it('the first refused, the second saved: the second order stands', async () => {
    const { store, answers } = reorders();
    const one = store.saveLabelOrder(['a']);
    const two = store.saveLabelOrder(['b']);
    answers[0](false);
    await one;
    await tick();
    answers[1](true);
    await two;
    expect(store.state.labelOrder).toEqual(['b']);
  });

  it('both refused: back to the order the server has', async () => {
    const { store, answers } = reorders();
    store.handlers.onSettings({ labelOrder: ['x'] });
    const one = store.saveLabelOrder(['a']);
    const two = store.saveLabelOrder(['b']);
    answers[0](false);
    await one;
    await tick();
    answers[1](false);
    await two;
    expect(store.state.labelOrder).toEqual(['x']);
  });

  it('a save that succeeds after another screen streamed a newer order leaves the newer one', async () => {
    let accept = (): void => {};
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [] }),
      saveSettings: (body: { labelOrder: string[] }) => new Promise((resolve) => (accept = () => resolve({ labelOrder: body.labelOrder }))),
    };
    const store = createStore(client);
    const saving = store.saveLabelOrder(['a', 'b']);
    store.handlers.onSettings({ labelOrder: ['c', 'a', 'b'] });
    accept();
    await saving;
    expect(store.state.labelOrder).toEqual(['c', 'a', 'b']);
  });

  it('a failed save leaves an order another screen streamed in meanwhile', async () => {
    let refuse = (): void => {};
    const client = { mode: 'fixtures', items: async () => ({ items: [] }), saveSettings: () => new Promise((_, reject) => (refuse = () => reject(new Error('refused')))) };
    const store = createStore(client);
    const saving = store.saveLabelOrder(['a', 'b']);
    store.handlers.onSettings({ labelOrder: ['c', 'a', 'b'] });
    refuse();
    await saving;
    expect(store.state.labelOrder).toEqual(['c', 'a', 'b']);
  });
});

describe('store: rollbacks never overwrite newer state', () => {
  it('a swept row stays off the sweep card until the sweep is read again, and comes back on failure', async () => {
    const lands: Array<(r: Record<string, unknown>) => void> = [];
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [] }),
      item: async () => ({}),
      command: (cmd: Record<string, unknown>) => new Promise((resolve) => lands.push((r) => resolve({ commandId: cmd.commandId, ...r }))),
    };
    const store = createStore(client);
    const ok = store.sweep('a', 'keep');
    expect(store.state.swept.a).toBe(0);
    lands[0]({ status: 'applied' });
    await ok;
    expect(store.state.swept.a).toBeGreaterThan(0);
    const bad = store.sweep('b', 'drop');
    lands[1]({ status: 'failed', error: 'down' });
    await bad;
    expect(store.state.swept.b).toBeUndefined();
    // Its Retry goes through the sweep again: off the card while it's on its way.
    const retrying = store.state.toasts.at(-1).actions[0].fn();
    expect(store.state.swept.b).toBe(0);
    lands[2]({ status: 'applied' });
    await retrying;
  });

  it('a failed project snooze puts the project back, unless another screen changed it meanwhile', async () => {
    let fail = (): void => {};
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [] }),
      projectAction: () => new Promise((_, reject) => (fail = () => reject(new Error('down')))),
    };
    const store = createStore(client);
    store.set({ projects: [{ id: 'p1', name: 'Billing' }] });
    const parking = store.parkProject('p1');
    expect(store.state.projects[0].away).toMatchObject({ state: 'parked' });
    fail();
    await parking;
    expect(store.state.projects[0].away).toBeUndefined();

    const again = store.parkProject('p1');
    store.handlers.onSettings({ projects: [{ id: 'p1', name: 'Billing (renamed elsewhere)' }], projectsRev: 2 });
    fail();
    await again;
    expect(store.state.projects[0].name).toBe('Billing (renamed elsewhere)');
  });

  it('Park then Wake at once: the late re-read after Park never shows it parked again', async () => {
    const reads: Array<(json: unknown) => void> = [];
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [] }),
      projectAction: async () => ({ held: 0 }),
      settings: () => new Promise((resolve) => reads.push(resolve)),
    };
    const store = createStore(client);
    store.set({ projects: [{ id: 'p1', name: 'Billing' }] });
    // Park answers after Wake began: its re-read must not land over Wake's state.
    const parking = store.parkProject('p1');
    const waking = store.wakeProject('p1');
    await parking;
    await waking;
    expect(store.state.projects[0].away).toBeNull();
    reads[0]({ projects: [{ id: 'p1', name: 'Billing', away: { state: 'parked', at: 1 } }], projectsRev: 2 });
    await Promise.resolve();
    expect(store.state.projects[0].away).toBeNull();
  });

  it('parking a project takes its conversations off the board at the tap, and puts them back if it fails', async () => {
    let answer = (): void => {};
    let fails = false;
    const items = [row('a', { facts: { projectId: 'p1' } }), row('b', { facts: { projectId: 'p1' }, nextStep: 'working' }), row('c')];
    const client = {
      mode: 'fixtures',
      items: async ({ view }: { view: string }) => ({ items: items.filter((i) => inList(i, view)) }),
      projectAction: () => new Promise((resolve, reject) => (answer = () => (fails ? reject(new Error('down')) : resolve({ held: 1 })))),
    };
    const store = createStore(client);
    await Promise.all(['active', 'snoozed', 'everything', 'history'].map((view) => store.loadList(view)));
    store.set({ projects: [{ id: 'p1', name: 'Billing' }] });
    fails = true;
    const parking = store.parkProject('p1');
    // Every conversation in rotation is held, a running one too, as the desk does it.
    expect(store.state.lists.active.items.map((i: Item) => i.id)).toEqual(['c']);
    expect(store.state.byId.a).toMatchObject({ disposition: 'parked', heldBy: 'p1' });
    answer();
    await parking;
    expect(store.state.lists.active.items.map((i: Item) => i.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('a failed coordinator draft action puts the draft back', async () => {
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [] }),
      coordinatorDraft: async () => {
        throw new Error('down');
      },
      coordinator: async () => {
        throw new Error('down too');
      },
    };
    const store = createStore(client);
    const draft = { id: 'd1', state: 'draft', text: 'Is the migration done?' };
    store.set({ coordinator: { projectId: 'p1', view: { drafts: [draft] }, pending: [], loading: false, error: null } });
    await store.coordinatorDraft('p1', 'd1', 'drop');
    expect(store.state.coordinator.view.drafts[0]).toMatchObject({ id: 'd1', state: 'draft' });
  });

  it('keeps a failed approval edit across detail reloads and navigation, then clears it on success', async () => {
    const draft = { id: 'm1', state: 'draft', text: 'Agent words' };
    const sent: unknown[] = [];
    const client = {
      mode: 'fixtures',
      mailDraft: async (_id: string, body: unknown) => {
        sent.push(body);
        if (sent.length === 1) throw new Error('down');
      },
      item: async () => ({ mailDrafts: [{ ...draft }] }),
    };
    const store = createStore(client);
    await store.loadDetail('w');
    await store.mailDraft('m1', 'send', 'Edited words');
    await store.loadDetail('w');
    expect(store.state.detail.mailDrafts[0].text).toBe('Edited words');
    await store.loadDetail('other');
    expect(store.state.detail.mailDrafts[0].text).toBe('Agent words');
    await store.loadDetail('w');
    expect(store.state.detail.mailDrafts[0].text).toBe('Edited words');
    await store.mailDraft('m1', 'send');
    expect(sent).toEqual([{ action: 'send', text: 'Edited words' }, { action: 'send', text: 'Edited words' }]);
    expect(store.state.detail.mailDrafts[0].text).toBe('Agent words');
  });

  it.each(['drop', 'missing', 'sent'])('clears failed approval edits when the draft is %s', async (ending) => {
    const draft = { id: 'm1', state: 'draft', text: 'Agent words' };
    let drafts = [draft];
    const client = {
      mode: 'fixtures',
      mailDraft: async (_id: string, body: { action: string }) => {
        if (body.action === 'send') throw new Error('down');
      },
      item: async () => ({ mailDrafts: drafts }),
    };
    const store = createStore(client);
    await store.loadDetail('w');
    await store.mailDraft('m1', 'send', 'Edited words');
    if (ending === 'drop') await store.mailDraft('m1', 'drop');
    else {
      drafts = ending === 'missing' ? [] : [{ ...draft, state: 'sent' }];
      await store.loadDetail('w');
    }
    drafts = [draft];
    await store.loadDetail('w');
    expect(store.state.detail.mailDrafts[0].text).toBe('Agent words');
  });

  it('a failed mail approval puts the draft back with the owner’s edit', async () => {
    const requests: unknown[] = [];
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [] }),
      mailDraft: async (_id: string, body: unknown) => {
        requests.push(body);
        if (requests.length === 1) throw new Error('down');
      },
      item: async () => ({ mailDrafts: [] }),
    };
    const store = createStore(client);
    const draft = { id: 'm1', state: 'draft', text: 'Agent words' };
    store.set({ detail: { id: 'w', mailDrafts: [draft] } });
    await store.mailDraft('m1', 'send', 'Owner words');
    expect(store.state.detail.mailDrafts[0]).toMatchObject({ id: 'm1', state: 'draft', text: 'Owner words' });
    // DraftCard closes Edit after the first attempt, so a direct retry omits text.
    await store.mailDraft('m1', 'send');
    expect(requests).toEqual([
      { action: 'send', text: 'Owner words' },
      { action: 'send', text: 'Owner words' },
    ]);
  });

  it('a reply stays Working through stale refreshes, then settles when the words are filed', async () => {
    let server = row('r', { lastOwnerMessageAt: 10, status: { pill: 'finished' } });
    const client = {
      mode: 'fixtures',
      items: async ({ view }: { view: string }) => ({ items: [server].filter((i) => inList(i, view)) }),
      item: async () => ({}),
      command: async (cmd: Record<string, unknown>) => ({ commandId: cmd.commandId, status: 'applied' }),
    };
    const store = createStore(client);
    const load = () => Promise.all(['active', 'snoozed', 'everything', 'history'].map((view) => store.loadList(view)));
    await load();
    const sending = store.command('reply', 'r', { text: 'Continue' });
    expect(store.state.byId.r.status.pill).toBe('working');
    await sending;
    await load();
    expect(store.state.byId.r.status.pill).toBe('working');
    server = row('r', { lastOwnerMessageAt: 11, status: { pill: 'finished' } });
    await load();
    expect(store.state.byId.r.status).toEqual(server.status);
  });

  it('Stop stays predicted until the server copy shows the turn stopped', async () => {
    let running = true;
    const loomRow = () => row('s', { source: 'loom', nextStep: 'working', facts: { running: running ? { turnId: 't' } : null } });
    const client = {
      mode: 'fixtures',
      items: async ({ view }: { view: string }) => ({ items: [loomRow()].filter((i) => inList(i, view)) }),
      item: async () => ({}),
      command: async (cmd: Record<string, unknown>) => ({ commandId: cmd.commandId, status: 'applied', outcome: { stopped: true } }),
    };
    const store = createStore(client);
    const load = () => Promise.all(['active', 'snoozed', 'everything', 'history'].map((view) => store.loadList(view)));
    await load();
    await store.stop('s');
    await load();
    // The interrupt answered, the lists were read again, but the turn's end hasn't come in: still no Stop.
    expect(store.state.byId.s.facts.running).toBeNull();
    running = false;
    await load();
    expect(store.state.byId.s.facts.running).toBeNull();
  });

  it('Mark unread then Mark read: the second goes after the first, and read is what stays', async () => {
    const lands: Array<() => void> = [];
    const sent: string[] = [];
    const client = {
      mode: 'fixtures',
      items: async ({ view }: { view: string }) => ({ items: [row('m', { seen: 'seen' })].filter((i) => inList(i, view)) }),
      item: async () => ({}),
      command: (cmd: Record<string, unknown>) => (sent.push(String(cmd.type)), new Promise((resolve) => lands.push(() => resolve({ commandId: cmd.commandId, status: 'applied' })))),
    };
    const store = createStore(client);
    await Promise.all(['active', 'snoozed', 'everything', 'history'].map((view) => store.loadList(view)));
    const unread = store.command('unseen', 'm');
    const read = store.command('seen', 'm', { via: 'read' });
    expect(store.state.byId.m.seen).toBe('seen');
    expect(sent).toEqual(['unseen']);
    lands[0]();
    await unread;
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(['unseen', 'seen']);
    expect(store.state.byId.m.seen).toBe('seen');
    lands[1]();
    await read;
    expect(store.state.byId.m.seen).toBe('seen');
  });

  it('a reload after an older coordinator draft action keeps the newer action showing', async () => {
    let first = (): void => {};
    const reads: Array<(v: unknown) => void> = [];
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [] }),
      coordinatorDraft: (_p: string, _d: string, body: { action: string }) => new Promise<void>((resolve) => (body.action === 'send' ? (first = resolve) : undefined)),
      coordinator: () => new Promise((resolve) => reads.push(resolve)),
    };
    const store = createStore(client);
    store.set({ coordinator: { projectId: 'p1', view: { drafts: [{ id: 'd1', state: 'draft', text: 'Q' }] }, pending: [], loading: false, error: null } });
    void store.coordinatorDraft('p1', 'd1', 'send');
    void store.coordinatorDraft('p1', 'd1', 'drop');
    expect(store.state.coordinator.view.drafts[0].state).toBe('dropped');
    await new Promise((r) => setTimeout(r, 5)); // the send goes out a tick later (actions on a draft go in order)
    first();
    await new Promise((r) => setTimeout(r, 5));
    reads[0]({ drafts: [{ id: 'd1', state: 'queued', text: 'Q' }] });
    await new Promise((r) => setTimeout(r, 5));
    expect(store.state.coordinator.view.drafts[0].state).toBe('dropped');
  });

  it('when an earlier draft action fails, the next one still goes out after it', async () => {
    const order: string[] = [];
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [] }),
      coordinatorDraft: (_p: string, _d: string, body: { action: string }) => (order.push(body.action), body.action === 'send' ? Promise.reject(new Error('down')) : Promise.resolve()),
      coordinator: () => new Promise(() => {}),
    };
    const store = createStore(client);
    store.set({ coordinator: { projectId: 'p1', view: { drafts: [{ id: 'd1', state: 'draft', text: 'Q' }] }, pending: [], loading: false, error: null } });
    const send = store.coordinatorDraft('p1', 'd1', 'send');
    const drop = store.coordinatorDraft('p1', 'd1', 'drop');
    await Promise.all([send, drop]);
    expect(order).toEqual(['send', 'drop']);
    expect(store.state.coordinator.view.drafts[0].state).toBe('dropped');
  });

  it('a re-read for one project never drops the prediction for another still on its way', async () => {
    const reads: Array<(json: unknown) => void> = [];
    let finishA = (): void => {};
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [] }),
      projectAction: (id: string) => (id === 'a' ? new Promise((resolve) => (finishA = () => resolve({ held: 0 }))) : Promise.resolve({ held: 0 })),
      settings: () => new Promise((resolve) => reads.push(resolve)),
    };
    const store = createStore(client);
    store.set({ projects: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
    const parkingA = store.parkProject('a');
    await store.parkProject('b');
    reads[0]({ projects: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', away: { state: 'parked', at: 1 } }], projectsRev: 3 });
    await Promise.resolve();
    expect(store.state.projects.find((p: { id: string }) => p.id === 'a').away).toMatchObject({ state: 'parked' });
    finishA();
    await parkingA;
  });

  it('Pick up right after Snooze sends the attention time the Snooze got back, not the stale one', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const client = {
      mode: 'fixtures',
      items: async ({ view }: { view: string }) => ({ items: [row('g', { attentionUpdatedAt: 10 })].filter((i) => inList(i, view)) }),
      item: async () => ({}),
      command: async (cmd: Record<string, unknown>) => (sent.push(cmd), { commandId: cmd.commandId, status: 'applied', outcome: { attentionAt: 42 } }),
    };
    const store = createStore(client);
    await Promise.all(['active', 'snoozed', 'everything', 'history'].map((view) => store.loadList(view)));
    await store.command('snooze', 'g', { trigger: 'agent_posts' });
    await store.pickup('g');
    expect(sent[1]).toMatchObject({ type: 'pickup', args: { ifStateAt: 42 } });
  });

  it('a project re-read never lands over a newer streamed copy', async () => {
    const reads: Array<(json: unknown) => void> = [];
    const client = { mode: 'fixtures', items: async () => ({ items: [] }), projectAction: async () => ({ held: 0 }), settings: () => new Promise((resolve) => reads.push(resolve)) };
    const store = createStore(client);
    store.set({ projects: [{ id: 'p1', name: 'Billing' }] });
    await store.parkProject('p1');
    store.handlers.onSettings({ projects: [{ id: 'p1', name: 'Billing', away: null }], projectsRev: 5 });
    reads[0]({ projects: [{ id: 'p1', name: 'Billing', away: { state: 'parked', at: 1 } }], projectsRev: 4 });
    await Promise.resolve();
    expect(store.state.projects[0].away).toBeNull();
  });

  it('Clear write-back Retry keeps its original event and leaves newer asks visible', async () => {
    const sent: Array<Record<string, unknown>> = [];
    let finish!: () => void;
    const client = {
      mode: 'fixtures', items: async () => ({ items: [] }), item: async () => ({}),
      command: async (cmd: Record<string, unknown>) => {
        sent.push(cmd);
        if (sent.length === 1) return { commandId: cmd.commandId, status: 'applied', outcome: { seq: 17, cleared: true, writeback: { outcome: 'failed', error: 'offline' } } };
        await new Promise<void>(resolve => { finish = resolve; });
        return { commandId: cmd.commandId, status: 'applied', outcome: { seq: 17, cleared: true, writeback: { outcome: 'ok' } } };
      },
    };
    const store = createStore(client);
    store.state.byId.lead = row('lead', { facts: { role: 'default' } });
    await store.sendDone('lead');
    const latest = row('lead', { seen: 'new', facts: { role: 'default', openAsk: { text: 'New request', at: 2000 } }, status: { pill: 'needs', unread: true } });
    store.state.byId.lead = latest;
    const retry = store.state.toasts.at(-1).actions.find((a: { label: string }) => a.label === 'Retry').fn();
    expect(sent[1]).toMatchObject({ type: 'done', args: { retryClearSeq: 17 } });
    expect(store.state.byId.lead).toEqual(latest);
    finish();
    await retry;
  });

  it('a lost answer: a reply gets no blind Retry; Done retries with the same command id', async () => {
    const sent: Array<Record<string, unknown>> = [];
    let lose = true;
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [] }),
      item: async () => ({}),
      command: async (cmd: Record<string, unknown>) => {
        sent.push(cmd);
        if (lose) throw new TypeError('Failed to fetch');
        return { commandId: cmd.commandId, status: 'applied', outcome: {} };
      },
      present: async () => ({ view: 'active', itemId: null, queue: [] }),
    };
    const store = createStore(client);
    store.state.byId.r = row('r');
    store.setDraft('r', 'Ship it');
    await store.sendReply('r');
    const replyToast = store.state.toasts.at(-1);
    expect(replyToast.text).toContain('may not have gone through');
    expect(replyToast.actions.map((a: { label: string }) => a.label)).toEqual(['Open']);
    expect(store.draftFor('r')).toBe('Ship it');
    await store.sendDone('r');
    const doneToast = store.state.toasts.at(-1);
    lose = false;
    await doneToast.actions.find((a: { label: string }) => a.label === 'Retry').fn();
    const dones = sent.filter((c) => c.type === 'done');
    expect(dones[1].commandId).toBe(dones[0].commandId);
  });

  it('Park then Wake both failing: the project goes back to what the desk confirmed', async () => {
    const fails: Array<() => void> = [];
    const client = { mode: 'fixtures', items: async () => ({ items: [] }), projectAction: () => new Promise((_, reject) => fails.push(() => reject(new Error('down')))) };
    const store = createStore(client);
    store.handlers.onSettings({ projects: [{ id: 'p1', name: 'Billing', away: null }], projectsRev: 1 });
    const parking = store.parkProject('p1');
    const waking = store.wakeProject('p1');
    fails[0]();
    await parking;
    fails[1]();
    await waking;
    expect(store.state.projects[0].away).toBeNull();
  });

  it('a snoozed project parked: the conversations it holds show parked too', async () => {
    const held = row('h', { disposition: 'snoozed', heldBy: 'p1', facts: { projectId: 'p1' } });
    const client = { mode: 'fixtures', items: async ({ view }: { view: string }) => ({ items: [held].filter((i) => inList(i, view)) }), projectAction: () => new Promise(() => {}) };
    const store = createStore(client);
    await Promise.all(['active', 'snoozed', 'everything', 'history'].map((view) => store.loadList(view)));
    store.set({ projects: [{ id: 'p1', name: 'Billing', away: { state: 'snoozed', at: 1, until: 9e15 } }] });
    void store.parkProject('p1');
    expect(store.state.byId.h).toMatchObject({ disposition: 'parked', heldBy: 'p1' });
  });

  it('the inline Retry after a lost answer replays the same id; a reply opens the draft instead', async () => {
    const sent: Array<Record<string, unknown>> = [];
    let lose = true;
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [] }),
      item: async () => ({}),
      command: async (cmd: Record<string, unknown>) => {
        sent.push(cmd);
        if (lose) throw new TypeError('Failed to fetch');
        return { commandId: cmd.commandId, status: 'applied', outcome: {} };
      },
    };
    const store = createStore(client);
    store.state.byId.i = row('i');
    await store.command('park', 'i', {}, { quiet: true });
    const failed = store.lastCommand('i');
    expect(failed).toMatchObject({ status: 'failed', transport: true });
    lose = false;
    await store.retryCommand(failed);
    expect(sent[1].commandId).toBe(sent[0].commandId);
    store.retryCommand({ type: 'reply', itemId: 'i', args: { text: 'hi' }, transport: true, commandId: 'x' });
    expect(store.state.replyOpen).toBe('i');
    expect(sent).toHaveLength(2);
  });

  it('the echo of an earlier reorder never replaces a newer one still on its way', async () => {
    const answers: Array<() => void> = [];
    const client = { mode: 'fixtures', items: async () => ({ items: [] }), saveSettings: (body: { labelOrder: string[] }) => new Promise((resolve) => answers.push(() => resolve({ labelOrder: body.labelOrder }))) };
    const store = createStore(client);
    const one = store.saveLabelOrder(['a']);
    const two = store.saveLabelOrder(['b']);
    answers[0]();
    await one;
    store.handlers.onSettings({ labelOrder: ['a'] });
    expect(store.state.labelOrder).toEqual(['b']);
    answers[1]();
    await two;
    expect(store.state.labelOrder).toEqual(['b']);
  });

  it('a command that never answers comes down after the timeout, as a lost answer', async () => {
    vi.useFakeTimers();
    try {
      const client = { mode: 'fixtures', items: async ({ view }: { view: string }) => ({ items: [row('t')].filter((i) => inList(i, view)) }), item: async () => ({}), command: () => new Promise(() => {}) };
      const store = createStore(client);
      await Promise.all(['active', 'snoozed', 'everything', 'history'].map((view) => store.loadList(view)));
      const doing = store.command('done', 't');
      expect(store.state.byId.t.disposition).toBe('done');
      await vi.advanceTimersByTimeAsync(60_100);
      const result = await doing;
      expect(result).toMatchObject({ status: 'failed', transport: true });
      expect(store.state.byId.t.disposition).toBe('active');
    } finally {
      vi.useRealTimers();
    }
  });

  it('two project saves both failing go back to the list the desk confirmed', async () => {
    const fails: Array<() => void> = [];
    const client = { mode: 'fixtures', items: async () => ({ items: [] }), saveSettings: () => new Promise((_, reject) => fails.push(() => reject(new Error('down')))) };
    const store = createStore(client);
    store.handlers.onSettings({ projects: [{ id: 'p1', name: 'Billing' }], projectsRev: 1 });
    const one = store.saveProjects([{ id: 'p1', name: 'Billing' }, { id: 'p2', name: 'New one' }]);
    const two = store.saveProjects([{ id: 'p1', name: 'Billing renamed' }, { id: 'p2', name: 'New one' }]);
    await new Promise((r) => setTimeout(r, 0));
    fails[0]();
    await one;
    await new Promise((r) => setTimeout(r, 0)); // saves go one at a time: the second is sent now
    fails[1]();
    await two;
    expect(store.state.projects).toEqual([{ id: 'p1', name: 'Billing' }]);
  });

  it('a project action that never answers comes down after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const client = { mode: 'fixtures', items: async () => ({ items: [] }), projectAction: () => new Promise(() => {}) };
      const store = createStore(client);
      store.handlers.onSettings({ projects: [{ id: 'p1', name: 'Billing', away: null }], projectsRev: 1 });
      const parking = store.parkProject('p1');
      expect(store.state.projects[0].away).toMatchObject({ state: 'parked' });
      await vi.advanceTimersByTimeAsync(60_100);
      await parking;
      expect(store.state.projects[0].away).toBeNull();
      expect(store.state.toasts.at(-1).actions).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a Rename or a read on an away row keeps the guard for the next action', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const client = {
      mode: 'fixtures',
      items: async ({ view }: { view: string }) => ({ items: [row('k', { disposition: 'snoozed', attentionUpdatedAt: 7 })].filter((i) => inList(i, view)) }),
      item: async () => ({}),
      command: async (cmd: Record<string, unknown>) => (sent.push(cmd), { commandId: cmd.commandId, status: 'applied', outcome: {} }),
    };
    const store = createStore(client);
    await Promise.all(['active', 'snoozed', 'everything', 'history'].map((view) => store.loadList(view)));
    await store.rename('k', 'New name');
    await store.pickup('k');
    expect(sent[1]).toMatchObject({ type: 'pickup', args: { ifStateAt: 7 } });
  });

  it('a project save never sends another project action still on its way', async () => {
    let body: { projects: Array<{ id: string; finishedAt?: number }> } | null = null;
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [] }),
      projectAction: () => new Promise(() => {}),
      saveSettings: async (b: typeof body) => ((body = b), { projects: b!.projects, projectsRev: 2 }),
    };
    const store = createStore(client);
    store.handlers.onSettings({ projects: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], projectsRev: 1 });
    void store.finishProject('a', 'done');
    expect(store.state.projects.find((p: { id: string }) => p.id === 'a').finishedAt).toBeTruthy();
    await store.saveProjects((list: Array<{ id: string; name: string }>) => list.map((p) => (p.id === 'b' ? { ...p, name: 'B2' } : p)));
    expect(body!.projects.find((p) => p.id === 'a')!.finishedAt).toBeUndefined();
  });

  it('the actions on one draft go out in the order tapped', async () => {
    const order: string[] = [];
    let releaseSend = (): void => {};
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [] }),
      coordinatorDraft: (_p: string, _d: string, body: { action: string; text?: string }) => {
        order.push(`${body.action}:${body.text ?? ''}`);
        return body.action === 'send' ? new Promise<void>((resolve) => (releaseSend = resolve)) : Promise.resolve();
      },
      coordinator: async () => ({ drafts: [] }),
    };
    const store = createStore(client);
    store.set({ coordinator: { projectId: 'p1', view: { drafts: [{ id: 'd1', state: 'draft', text: 'old' }] }, pending: [], loading: false, error: null } });
    const send = store.coordinatorDraft('p1', 'd1', 'send', 'edited');
    const now = store.coordinatorDraft('p1', 'd1', 'now');
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['send:edited']);
    releaseSend();
    await Promise.all([send, now]);
    // The follow-up carries the edit still on its way, so the edited words are what go.
    expect(order).toEqual(['send:edited', 'now:edited']);
  });

  it('two project saves go out one at a time, the second on the revision the first left', async () => {
    const sent: Array<{ projectsRev: number; projects: Array<{ id: string }> }> = [];
    const answers: Array<() => void> = [];
    let rev = 1;
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [] }),
      saveSettings: (b: { projectsRev: number; projects: Array<{ id: string }> }) => (sent.push(b), new Promise((resolve) => answers.push(() => resolve({ projects: b.projects, projectsRev: ++rev })))),
    };
    const store = createStore(client);
    store.handlers.onSettings({ projects: [], projectsRev: 1 });
    const one = store.saveProjects((list: Array<{ id: string }>) => [...list, { id: 'a' }]);
    const two = store.saveProjects((list: Array<{ id: string }>) => [...list, { id: 'b' }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(1);
    answers[0]();
    await one;
    await new Promise((r) => setTimeout(r, 0));
    expect(sent[1]).toMatchObject({ projectsRev: 2 });
    expect(sent[1].projects.map((p) => p.id)).toEqual(['a', 'b']);
    answers[1]();
    expect(await two).toBeNull();
  });

  it('a bulk action right after Snooze sends the time the Snooze got back, not the stale one', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const client = {
      mode: 'fixtures',
      items: async ({ view }: { view: string }) => ({ items: [row('q', { attentionUpdatedAt: 3, seen: 'new' })].filter((i) => inList(i, view)) }),
      item: async () => ({}),
      command: async (cmd: Record<string, unknown>) => (sent.push(cmd), { commandId: cmd.commandId, status: 'applied', outcome: { attentionAt: 77 } }),
    };
    const store = createStore(client);
    await Promise.all(['active', 'snoozed', 'everything', 'history'].map((view) => store.loadList(view)));
    await store.command('snooze', 'q', { trigger: 'agent_posts' });
    // The next layout's select actions sit on the store in the app; here only its end matters.
    await bulkRead({ ...store, nextSelectEnd: () => {} }, [{ ...store.state.byId.q, seen: 'new' }]);
    const read = sent.find((c) => c.type === 'seen');
    // Not the stale token: the one the Snooze's answer carried, filled in as it goes.
    expect(read?.args).toMatchObject({ ifStateAt: 77 });
  });

  it('an Unpin queued behind a stalled Pin never goes after its deadline; its Retry goes once the Pin ends', async () => {
    vi.useFakeTimers();
    try {
      const sent: string[] = [];
      let endPin = (): void => {};
      const client = {
        mode: 'fixtures',
        items: async () => ({ items: [] }),
        item: async () => ({}),
        command: (cmd: { commandId: string; type: string; args: { pinned: boolean } }) => {
          sent.push(`${cmd.type}:${cmd.args.pinned}`);
          return cmd.args.pinned ? new Promise((resolve) => (endPin = () => resolve({ commandId: cmd.commandId, status: 'applied' }))) : Promise.resolve({ commandId: cmd.commandId, status: 'applied' });
        },
      };
      const store = createStore(client);
      store.state.byId.n = row('n');
      const pin = store.setPinned('n', true);
      const unpin = store.setPinned('n', false);
      await vi.advanceTimersByTimeAsync(61_000);
      await pin; // given up on here, as a lost answer
      const unpinned = await unpin;
      // The Unpin waited its turn past its deadline: it never went, and says so with a plain Retry.
      expect(unpinned).toMatchObject({ status: 'failed' });
      expect(unpinned.transport).toBeUndefined();
      expect(sent).toEqual(['pin:true']);
      endPin();
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toEqual(['pin:true']);
      const retry = store.state.toasts.find((t: { actions: Array<{ label: string }> }) => t.text.includes('wasn’t sent'))!.actions.find((a: { label: string }) => a.label === 'Retry');
      await retry!.fn();
      expect(sent).toEqual(['pin:true', 'pin:false']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('when the command before it fails, a follow-up still sends the token its tap saw', async () => {
    const sent: Array<Record<string, unknown>> = [];
    let refuse = (): void => {};
    const client = {
      mode: 'fixtures',
      items: async ({ view }: { view: string }) => ({ items: [row('f', { disposition: 'snoozed', attentionUpdatedAt: 10 })].filter((i) => inList(i, view)) }),
      item: async () => ({}),
      command: (cmd: Record<string, unknown>) => {
        sent.push(cmd);
        return cmd.type === 'pickup'
          ? new Promise((resolve) => (refuse = () => resolve({ commandId: cmd.commandId, status: 'failed', error: 'it’s back in Active with something new', outcome: { changed: true } })))
          : Promise.resolve({ commandId: cmd.commandId, status: 'applied', outcome: { attentionAt: 50 } });
      },
    };
    const store = createStore(client);
    await Promise.all(['active', 'snoozed', 'everything', 'history'].map((view) => store.loadList(view)));
    const picking = store.pickup('f');
    const doing = store.sendDone('f');
    refuse();
    await picking;
    await doing;
    expect(sent.find((c) => c.type === 'done')).toMatchObject({ args: { ifStateAt: 10 } });
  });

  it('Park a project, then Pick up one of its threads: the Pick up goes after the Park', async () => {
    const order: string[] = [];
    let endPark = (): void => {};
    const items = [row('m1', { facts: { projectId: 'p1' } })];
    const client = {
      mode: 'fixtures',
      items: async ({ view }: { view: string }) => ({ items: items.filter((i) => inList(i, view)) }),
      item: async () => ({}),
      projectAction: () => (order.push('park'), new Promise((resolve) => (endPark = () => resolve({ held: 1 })))),
      command: async (cmd: Record<string, unknown>) => (order.push(String(cmd.type)), { commandId: cmd.commandId, status: 'applied', outcome: {} }),
      settings: async () => ({ projects: [{ id: 'p1', name: 'Billing' }] }),
    };
    const store = createStore(client);
    await Promise.all(['active', 'snoozed', 'everything', 'history'].map((view) => store.loadList(view)));
    store.handlers.onSettings({ projects: [{ id: 'p1', name: 'Billing' }], projectsRev: 1 });
    const parking = store.parkProject('p1');
    const picking = store.pickup('m1');
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['park']);
    endPark();
    await parking;
    await picking;
    expect(order).toEqual(['park', 'pickup']);
  });

  it('a draft action that succeeds shows the draft it answered with, even if the read after fails', async () => {
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [] }),
      coordinatorDraft: async () => ({ ok: true, draft: { id: 'd1', state: 'sent', text: 'Q' } }),
      coordinator: async () => {
        throw new Error('down');
      },
    };
    const store = createStore(client);
    store.set({ coordinator: { projectId: 'p1', view: { drafts: [{ id: 'd1', state: 'draft', text: 'Q' }] }, pending: [], loading: false, error: null } });
    await store.coordinatorDraft('p1', 'd1', 'now');
    await new Promise((r) => setTimeout(r, 0));
    expect(store.state.coordinator.view.drafts[0].state).toBe('sent');
  });

  it('a Wake queued behind a Park that never answers is never sent after its deadline, and says so', async () => {
    vi.useFakeTimers();
    try {
      const sent: string[] = [];
      const client = { mode: 'fixtures', items: async () => ({ items: [] }), projectAction: (_id: string, body: { action: string }) => (sent.push(body.action), new Promise(() => {})) };
      const store = createStore(client);
      store.handlers.onSettings({ projects: [{ id: 'p1', name: 'Billing', away: null }], projectsRev: 1 });
      const parking = store.parkProject('p1');
      const waking = store.wakeProject('p1');
      await vi.advanceTimersByTimeAsync(61_000);
      await Promise.all([parking, waking]);
      expect(sent).toEqual(['park']);
      expect(store.state.projects[0].away).toBeNull();
      expect(store.state.toasts.some((t: { text: string }) => t.text.includes('wasn’t sent'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an unrelated settings event never wipes an Agent mail toggle on its way', async () => {
    let answer = (): void => {};
    const client = { mode: 'fixtures', items: async () => ({ items: [] }), mailOff: () => new Promise((resolve) => (answer = () => resolve({ off: ['t1'] }))) };
    const store = createStore(client);
    const toggling = store.setMailOff('t1', true);
    expect(store.state.mailOff).toEqual(['t1']);
    store.handlers.onSettings({ mailOff: [], labelOrder: ['x'] });
    expect(store.state.mailOff).toEqual(['t1']);
    answer();
    await toggling;
    expect(store.state.mailOff).toEqual(['t1']);
  });

  it('Reopen right after Done is guarded with the time the Done got back', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const client = {
      mode: 'fixtures',
      items: async ({ view }: { view: string }) => ({ items: [row('o', { attentionUpdatedAt: 5 })].filter((i) => inList(i, view)) }),
      item: async () => ({}),
      command: async (cmd: Record<string, unknown>) => (sent.push(cmd), { commandId: cmd.commandId, status: 'applied', outcome: { attentionAt: 60 } }),
    };
    const store = createStore(client);
    await Promise.all(['active', 'snoozed', 'everything', 'history'].map((view) => store.loadList(view)));
    await store.sendDone('o');
    await store.reopen('o');
    expect(sent.find((c) => c.type === 'reopen')).toMatchObject({ args: { ifStateAt: 60 } });
  });

  it('two quick Agent mail toggles go in order and the last one is what shows', async () => {
    const answers: Array<() => void> = [];
    const sent: boolean[] = [];
    let server: string[] = [];
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [] }),
      mailOff: (b: { itemId: string; off: boolean }) => (sent.push(b.off), new Promise((resolve) => answers.push(() => ((server = b.off ? ['t1'] : []), resolve({ off: server }))))),
    };
    const store = createStore(client);
    const one = store.setMailOff('t1', true);
    const two = store.setMailOff('t1', false);
    expect(sent).toEqual([true]);
    expect(store.state.mailOff).toEqual([]);
    answers[0]();
    await one;
    expect(store.state.mailOff).toEqual([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([true, false]);
    answers[1]();
    await two;
    expect(store.state.mailOff).toEqual([]);
  });

  it('two quick Keep watch changes go in order; the first answer never hides the second', async () => {
    const answers: Array<() => void> = [];
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [] }),
      coordinatorWatch: (_p: string, patch: { on: boolean }) => new Promise((resolve) => answers.push(() => resolve({ projectId: 'p1', exists: true, watch: { on: patch.on, stands: true, flags: true, digest: false }, reach: 'approve', status: null, flags: [], drafts: 0 }))),
    };
    const store = createStore(client);
    const one = store.setCoordinatorWatch('p1', { on: true });
    const two = store.setCoordinatorWatch('p1', { on: false });
    answers[0]();
    await one;
    expect(store.state.coordinators.p1.watch.on).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    answers[1]();
    await two;
    expect(store.state.coordinators.p1.watch.on).toBe(false);
  });

  it('a streamed echo of an earlier watch change never hides the newer one', async () => {
    const answers: Array<() => void> = [];
    const summary = (on: boolean) => ({ projectId: 'p1', exists: true, watch: { on, stands: true, flags: true, digest: false }, reach: 'approve', status: null, flags: [], drafts: 0 });
    const client = { mode: 'fixtures', items: async () => ({ items: [] }), coordinatorWatch: (_p: string, patch: { on: boolean }) => new Promise((resolve) => answers.push(() => resolve(summary(patch.on)))) };
    const store = createStore(client);
    const one = store.setCoordinatorWatch('p1', { on: true });
    const two = store.setCoordinatorWatch('p1', { on: false });
    store.handlers.onCoordinator(summary(true)); // the first change's echo
    expect(store.state.coordinators.p1.watch.on).toBe(false);
    answers[0]();
    await one;
    await new Promise((r) => setTimeout(r, 0));
    answers[1]();
    await two;
    expect(store.state.coordinators.p1.watch.on).toBe(false);
  });

  it('a move into a project still being created waits for the save', async () => {
    const order: string[] = [];
    let saved = (): void => {};
    const client = {
      mode: 'fixtures',
      items: async () => ({ items: [] }),
      item: async () => ({}),
      saveSettings: (b: { projects: unknown[] }) => (order.push('save'), new Promise((resolve) => (saved = () => resolve({ projects: b.projects, projectsRev: 2 })))),
      command: async (cmd: Record<string, unknown>) => (order.push(String(cmd.type)), { commandId: cmd.commandId, status: 'applied', outcome: {} }),
    };
    const store = createStore(client);
    store.state.byId.v = row('v');
    store.handlers.onSettings({ projects: [], projectsRev: 1 });
    const creating = store.saveProjects((list: Array<{ id: string }>) => [...list, { id: 'pn', name: 'New' }]);
    const moving = store.setProject('v', 'pn');
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['save']);
    saved();
    await creating;
    await moving;
    expect(order).toEqual(['save', 'project']);
  });

  it('an item in several lists is looked up by its freshest copy', async () => {
    let snoozed = false;
    const client = {
      mode: 'fixtures',
      items: async ({ view }: { view: string }) => ({ items: [row('w', { disposition: snoozed ? 'snoozed' : 'active' })].filter((i) => inList(i, view)) }),
    };
    const store = createStore(client);
    await store.loadList('everything');
    snoozed = true;
    await store.loadList('snoozed');
    expect(store.state.byId.w.disposition).toBe('snoozed');
  });

  it('a bulk Retry sends each command as first sent, guard and all, not from the row as it is now', async () => {
    const sent: Array<Record<string, unknown>> = [];
    let first = true;
    let server = row('b1', { disposition: 'snoozed', attentionUpdatedAt: 4 });
    const client = {
      mode: 'fixtures',
      items: async ({ view }: { view: string }) => ({ items: [server].filter((i) => inList(i, view)) }),
      item: async () => ({}),
      command: async (cmd: Record<string, unknown>) => {
        sent.push(cmd);
        if (first) return (first = false), { commandId: cmd.commandId, status: 'failed', error: 'the desk is restarting' };
        return { commandId: cmd.commandId, status: 'failed', error: 'it’s back in Active with something new', outcome: { changed: true } };
      },
    };
    const store = createStore(client);
    await Promise.all(['active', 'snoozed', 'everything', 'history'].map((view) => store.loadList(view)));
    const toasts: Array<{ text: string; o?: { actions?: Array<{ label: string; fn: () => Promise<unknown> }> } }> = [];
    const shim = { ...store, nextSelectEnd: () => {}, toast: (text: string, o?: (typeof toasts)[number]['o']) => toasts.push({ text, o }) };
    await bulkDone(shim, [store.state.byId.b1]);
    // The agent posts meanwhile: the row is back in Active, with a newer token.
    server = row('b1', { disposition: 'active', attentionUpdatedAt: 9, seen: 'new' });
    await Promise.all(['active', 'snoozed', 'everything', 'history'].map((view) => store.loadList(view)));
    const retry = toasts.find((t) => t.o?.actions?.[0]?.label === 'Retry')!.o!.actions![0];
    await retry.fn();
    expect(sent[1]).toMatchObject({ type: 'done', args: { ifStateAt: 4 } });
  });
});


describe('owner message receipts across acknowledgments and reloads', () => {
  it('keeps two rapid sends visible, persists before acknowledgment, and merges a source echo without duplication', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) });
    const requests: any[] = [], resolve: any[] = [];
    const client = { command: (c: any) => { requests.push(c); return new Promise(r => resolve.push(r)); }, items: async () => ({ items: [] }), item: async () => ({ item: row('i'), ownerReceipts: [], receiptCommandIds: [] }) };
    const store = createStore(client);
    store.state.byId.i = row('i');
    try {
      const first = store.sendReply('i', 'First', { stay: true });
      const second = store.sendReply('i', 'Second', { stay: true });
      expect(store.state.ownerReceipts.map((r: any) => r.text)).toEqual(['First', 'Second']);
      expect(createStore(client).state.ownerReceipts.map((r: any) => r.status)).toEqual(['uncertain', 'uncertain']);
      resolve[0]({ status: 'applied' }); await first;
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      resolve[1]({ status: 'applied' }); await second;
      expect(createStore(client).state.ownerReceipts.map((r: any) => r.status)).toEqual(['delivered', 'delivered']);
      client.item = async () => ({ item: row('i'), ownerReceipts: [{ messageId: 'm1', commandId: requests[0].commandId, at: Date.now(), text: 'First', status: 'queued' }] as any, receiptCommandIds: [requests[0].commandId] as any });
      await store.loadDetail('i');
      expect(store.state.ownerReceipts.map((r: any) => r.text)).toEqual(['Second']);
      expect(store.state.detail.ownerReceipts).toHaveLength(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it('restores the draft on uncertain delivery and retries the original command identity', async () => {
    const commands: any[] = [];
    const client = { command: async (c: any) => { commands.push(c); if (commands.length === 1) throw new Error('connection lost'); return { status: 'applied' }; }, items: async () => ({ items: [] }) };
    const store = createStore(client); store.state.byId.i = row('i');
    store.setDraft('i', 'Keep these exact words');
    await store.sendReply('i', undefined, { stay: true });
    expect(store.draftFor('i')).toBe('Keep these exact words');
    expect(store.state.ownerReceipts[0].status).toBe('uncertain');
    await store.retryReceipt(store.state.ownerReceipts[0]);
    expect(commands[1].commandId).toBe(commands[0].commandId);
    expect(store.state.ownerReceipts).toHaveLength(1);
    expect(store.state.ownerReceipts[0].status).toBe('delivered');
    expect(store.draftFor('i')).toBe('');
  });

  it('ignores an older same-thread detail response after a newer acknowledgment', async () => {
    const reads: any[] = [];
    const store = createStore({ item: () => new Promise(resolve => reads.push(resolve)) });
    const old = store.loadDetail('i'), fresh = store.loadDetail('i');
    reads[1]({ item: row('i'), ownerReceipts: [{ messageId: 'm1', text: 'Arrived', at: 10, status: 'delivered' }] }); await fresh;
    reads[0]({ item: row('i'), ownerReceipts: [] }); await old;
    expect(store.state.detail.ownerReceipts[0].text).toBe('Arrived');
  });
});


describe('receipt entry points', () => {
  it('a failed text reply toast retries its receipt without leaving the failed copy behind', async () => {
    const commands: any[] = [];
    const store = createStore({ command: async (c: any) => { commands.push(c); return { commandId: c.commandId, status: commands.length === 1 ? 'failed' : 'applied' }; }, items: async () => ({ items: [] }) });
    store.state.byId.i = row('i');
    store.setDraft('i', 'Try these words');
    await store.sendReply('i', undefined, { stay: true });
    await store.state.toasts.at(-1).actions.find((a: any) => a.label === 'Retry').fn();
    expect(commands[1].commandId).not.toBe(commands[0].commandId);
    expect(store.state.ownerReceipts).toHaveLength(1);
    expect(store.state.ownerReceipts[0]).toMatchObject({ text: 'Try these words', status: 'delivered' });
    expect(store.draftFor('i')).toBe('');
  });

  it('catch-up and voice replies use the same durable receipt path', async () => {
    const { sendVoiceReply } = await import('../public/desk/voice-session.js');
    const store = createStore({ command: async (c: any) => ({ commandId: c.commandId, status: 'applied' }), items: async () => ({ items: [] }) });
    store.state.byId.i = row('i');
    await store.replyAsk('i', 'From catch-up');
    store.setDraft('i', 'From dictation');
    await sendVoiceReply(store, 'i', true);
    expect(store.state.ownerReceipts.map((r: any) => r.text)).toEqual(['From catch-up', 'From dictation']);
    expect(store.state.ownerReceipts.every((r: any) => r.status === 'delivered')).toBe(true);
  });
});

it('retry removes just its restored words from a combined draft and preserves newer words', async () => {
  let fail = true;
  const store = createStore({ command: async (c: any) => ({ commandId: c.commandId, status: fail ? 'failed' : 'applied' }), items: async () => ({ items: [] }) });
  store.state.byId.i = row('i');
  store.setDraft('i', 'First');
  await store.sendReply('i', undefined, { stay: true });
  const first = store.state.ownerReceipts[0];
  store.setDraft('i', 'First\n\nSecond');
  fail = false;
  await store.retryReceipt(first);
  expect(store.draftFor('i')).toBe('Second');
});

it('retrying one of two restored failures leaves the other failed words in the draft', async () => {
  let fail = true;
  const store = createStore({ command: async (c: any) => ({ commandId: c.commandId, status: fail ? 'failed' : 'applied' }), items: async () => ({ items: [] }) });
  store.state.byId.i = row('i');
  store.setDraft('i', 'First');
  const firstSend = store.sendReply('i', undefined, { stay: true });
  store.setDraft('i', 'Second');
  const secondSend = store.sendReply('i', undefined, { stay: true });
  await Promise.all([firstSend, secondSend]);
  expect(store.draftFor('i')).toBe('First\n\nSecond');
  const [first, second] = store.state.ownerReceipts;
  fail = false;
  await store.retryReceipt(first);
  expect(store.draftFor('i')).toBe('Second');
  await store.retryReceipt(second);
  expect(store.draftFor('i')).toBe('');
});

it.each([false, true])('composer resend retires failed receipts only on success (images: %s)', async (withImages) => {
  const commands: any[] = [];
  let fail = true;
  const store = createStore({ command: async (c: any) => { commands.push(c); return { commandId: c.commandId, status: fail ? 'failed' : 'applied' }; }, items: async () => ({ items: [] }) });
  store.state.byId.i = row('i');
  store.setDraft('i', withImages ? '' : 'First');
  if (withImages) store.state.replyImages.i = [{ id: 'image', name: 'image.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA==' }];
  await store.sendReply('i', undefined, { stay: true });
  const oldToast = store.state.toasts.at(-1);
  store.setDraft('i', 'First, edited');
  await store.sendReply('i', undefined, { stay: true });
  expect(store.state.ownerReceipts.filter((r: any) => r.status === 'failed')).toHaveLength(2);
  fail = false;
  await store.sendReply('i', undefined, { stay: true });
  expect(store.state.ownerReceipts).toHaveLength(1);
  expect(store.state.ownerReceipts[0]).toMatchObject({ text: 'First, edited', status: 'delivered', images: withImages ? 1 : 0 });
  expect(store.draftFor('i')).toBe('');
  if (!withImages) {
    await oldToast.actions.find((a: any) => a.label === 'Retry').fn();
    expect(commands).toHaveLength(3);
  }
});

it('receipt retry after a failed composer resend retires all superseded failures', async () => {
  let fail = true;
  const store = createStore({ command: async (c: any) => ({ commandId: c.commandId, status: fail ? 'failed' : 'applied' }), items: async () => ({ items: [] }) });
  store.state.byId.i = row('i');
  store.setDraft('i', 'First');
  await store.sendReply('i', undefined, { stay: true });
  await store.sendReply('i', undefined, { stay: true });
  fail = false;
  await store.retryReceipt(store.state.ownerReceipts.at(-1));
  expect(store.state.ownerReceipts).toHaveLength(1);
  expect(store.state.ownerReceipts[0].status).toBe('delivered');
  expect(store.draftFor('i')).toBe('');
});

it('composer resend retires both combined failures without removing another conversation receipt', async () => {
  let fail = true;
  const store = createStore({ command: async (c: any) => ({ commandId: c.commandId, status: fail ? 'failed' : 'applied' }), items: async () => ({ items: [] }) });
  store.state.byId.i = row('i'); store.state.byId.other = row('other');
  store.setDraft('other', 'Other');
  await store.sendReply('other', undefined, { stay: true });
  store.setDraft('i', 'First');
  const first = store.sendReply('i', undefined, { stay: true });
  store.setDraft('i', 'Second');
  const second = store.sendReply('i', undefined, { stay: true });
  await Promise.all([first, second]);
  fail = false;
  await store.sendReply('i', undefined, { stay: true });
  expect(store.state.ownerReceipts.map((r: any) => [r.itemId, r.text, r.status])).toEqual([
    ['other', 'Other', 'failed'], ['i', 'First\n\nSecond', 'delivered'],
  ]);
});
