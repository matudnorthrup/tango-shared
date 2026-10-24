import { describe, expect, it } from 'vitest';
import { parseSpaces, readSpaces } from '../server/desk/spaces.js';
import { deskStatus } from '../server/desk/status.js';

describe('space records', () => {
  it('keeps what is valid, replaces a given space whole, and removes one set to null', () => {
    const first = parseSpaces({ 'project:card': { about: ' A deckbuilder. ', lifetime: 'open', rules: ['Open a PR for every change.'], tools: { repos: true }, permissions: { mergeAfterReview: true }, memory: 'space' } }, {});
    expect(first).toEqual({ spaces: { 'project:card': { about: 'A deckbuilder.', lifetime: 'open', rules: ['Open a PR for every change.'], tools: { repos: true }, permissions: { mergeAfterReview: true }, memory: 'space' } } });
    const spaces = 'spaces' in first ? first.spaces : {};
    const next = parseSpaces({ 'agent:watson': { about: 'Chief of staff.', persona: { voice: 'Brief.' } }, 'project:card': null }, spaces);
    expect(next).toEqual({ spaces: { 'agent:watson': { about: 'Chief of staff.', persona: { voice: 'Brief.' } } } });
    expect(readSpaces(JSON.stringify({ 'agent:watson': { about: 'x' }, nope: { about: 'y' } }))).toEqual({ 'agent:watson': { about: 'x' } });
  });

  it('refuses what it can’t store', () => {
    expect(parseSpaces({ 'team:x': {} }, {})).toMatchObject({ error: expect.stringContaining("isn't a space") });
    expect(parseSpaces({ 'project:x': { lifetime: 'forever' } }, {})).toMatchObject({ error: expect.stringContaining('lifetime') });
    expect(parseSpaces({ 'project:x': { tools: { repos: 'yes' } } }, {})).toMatchObject({ error: expect.stringContaining('tools') });
    expect(parseSpaces({ 'project:x': { rules: [''] } }, {})).toMatchObject({ error: expect.stringContaining('rules') });
  });
});

describe('a job’s status', () => {
  const base = { nextStepBasis: 'summarizer', seen: 'updated' as const };
  it('an unparented job asks the owner', () => {
    expect(deskStatus({ ...base, nextStep: 'fyi', facts: { role: 'ops', lastAuthor: 'agent' } } as never)).toMatchObject({ move: null, busy: null });
    expect(deskStatus({ ...base, nextStep: 'your_move', facts: { role: 'ops', openAsk: { text: 'Approve?', at: 100 } } } as never)).toMatchObject({ move: 'needs', busy: null });
    expect(deskStatus({ ...base, nextStep: 'failed', facts: { role: 'ops', failed: { at: 1, reason: 'x', message: 'x' } } } as never).move).toBe('failed');
    // An unread finished update of an ordinary thread is unread, not a move (owner, 10/18).
    expect(deskStatus({ ...base, nextStep: 'fyi', facts: { lastAuthor: 'agent' } } as never)).toMatchObject({ move: null, unread: true });
  });
});

describe('a worker’s status', () => {
  const base = { nextStepBasis: 'summarizer', seen: 'updated' as const };
  it('reports to its owner: no move unless it failed or its owner is gone', () => {
    expect(deskStatus({ ...base, nextStep: 'your_move', facts: { role: 'worker', parentItemId: 'loom:lead' } } as never).move).toBe(null);
    expect(deskStatus({ ...base, nextStep: 'fyi', facts: { role: 'worker', parentItemId: 'loom:lead', lastAuthor: 'agent' } } as never).move).toBe(null);
    expect(deskStatus({ ...base, nextStep: 'failed', facts: { role: 'worker', failed: { at: 1, reason: 'x', message: 'x' } } } as never).move).toBe('failed');
    expect(deskStatus({ ...base, nextStep: 'your_move', facts: { role: 'worker', ownerGone: true, openAsk: { text: 'Approve?', at: 100 } } } as never).move).toBe('needs');
    // The owner's own words to it (or a tap on its screen) don't make it theirs: its answer goes up too.
    expect(deskStatus({ ...base, nextStep: 'your_move', lastOwnerMessageAt: 20, facts: { role: 'worker', lastMailInAt: 10 } } as never).move).toBe(null);
    expect(deskStatus({ ...base, nextStep: 'your_move', lastOwnerMessageAt: 5, facts: { role: 'worker', lastMailInAt: 10 } } as never).move).toBe(null);
  });

  it('re-sends the former lead when a source moves a worker to another lead (Codex review on #758)', async () => {
    const { makeHarness } = await import('./desk-harness.js');
    const h = makeHarness();
    const make = (id: string) => h.core.ensureItem({ id, source: 'loom', kind: 'thread', conversationKey: id, agentId: 'loom', agentName: 'Loom', place: 'x', createdAt: 1 }, 'agent');
    for (const id of ['loom:a', 'loom:b', 'loom:w']) make(id);
    h.core.roles.set('loom:w', { role: 'worker', parentItemId: 'loom:a' }, 'source', 2);
    h.core.touch('loom:w');
    h.core.flush();
    const sent: string[] = [];
    h.core.subscribe((event) => { if (event.type === 'item') sent.push(event.id); });
    // A source reparents the worker and touches only the worker.
    h.core.roles.set('loom:w', { role: 'worker', parentItemId: 'loom:b' }, 'source', 3);
    h.core.touch('loom:w');
    h.core.flush();
    expect(sent).toEqual(expect.arrayContaining(['loom:w', 'loom:a', 'loom:b']));
  });

  it('marks a worker whose owner is done or missing', async () => {
    const { makeHarness } = await import('./desk-harness.js');
    const h = makeHarness();
    const lead = h.core.ensureItem({ id: 'loom:lead', source: 'loom', kind: 'thread', conversationKey: 'loom:lead', agentId: 'loom', agentName: 'Loom', place: 'x', createdAt: 1 }, 'agent');
    const worker = h.core.ensureItem({ id: 'loom:worker', source: 'loom', kind: 'thread', conversationKey: 'loom:worker', agentId: 'loom', agentName: 'Loom', place: 'x', createdAt: 1 }, 'agent');
    h.core.roles.set(worker.id, { role: 'worker', parentItemId: lead.id }, 'owner', 2);
    expect(h.core.item(worker.id)!.facts.ownerGone).toBeUndefined();
    expect(h.core.items().find((i) => i.id === worker.id)!.facts.ownerGone).toBeUndefined();
    h.core.roles.set(worker.id, { role: 'worker', parentItemId: 'loom:nobody' }, 'owner', 3);
    expect(h.core.item(worker.id)!.facts.ownerGone).toBe(true);
    expect(h.core.items().find((i) => i.id === worker.id)!.facts.ownerGone).toBe(true);
  });
});

describe('Next up is the Inbox’s Needs you (owner’s decision, 10/17)', () => {
  it('holds recorded owner moves and failures, read or unread, and excludes workers with live leads', async () => {
    const { makeHarness } = await import('./desk-harness.js');
    const { nextUpQueue, briefing } = await import('../server/desk/view.js');
    const h = makeHarness();
    const make = (id: string) => h.core.ensureItem({ id, source: 'loom', kind: 'thread', conversationKey: id, agentId: 'loom', agentName: 'Loom', place: `x · ${id}`, createdAt: 1 }, 'agent');
    for (const id of ['loom:asks', 'loom:read', 'loom:done', 'loom:job', 'loom:failed']) make(id);
    h.core.recordMessage('loom:asks', { messageId: 'a1', author: 'agent', at: 2, text: 'Warm or cool?' });
    h.core.setFacts('loom:asks', { openAsk: { text: 'Warm or cool?', at: 2 } });
    h.core.refresh('loom:asks');
    h.core.recordMessage('loom:read', { messageId: 'r1', author: 'agent', at: 2, text: 'Warm or cool?' });
    h.core.setFacts('loom:read', { openAsk: { text: 'Warm or cool?', at: 2 } });
    h.core.refresh('loom:read');
    await h.core.command({ commandId: 'seen-read', type: 'seen', itemId: 'loom:read' });
    // The agent finished and spoke last, asking nothing: an unread update, not the owner's move (owner, 10/18).
    h.core.recordMessage('loom:done', { messageId: 'd1', author: 'agent', at: 2, text: 'Shipped.' });
    h.core.store.patchItem('loom:done', { nextStep: 'fyi' } as never);
    h.core.recordMessage('loom:job', { messageId: 'j1', author: 'agent', at: 2, text: 'Run the script?' });
    h.core.setFacts('loom:job', { openAsk: { text: 'Run the script?', at: 2 } });
    h.core.refresh('loom:job');
    h.core.roles.set('loom:job', { role: 'ops' }, 'owner', 3);
    h.core.setFacts('loom:failed', { failed: { at: 3, reason: 'crash', message: 'boom' } });
    h.core.store.patchItem('loom:failed', { nextStep: 'failed' } as never);
    const queued = () => nextUpQueue(h.core).map((entry) => entry.id).sort();
    expect(queued()).toEqual(['loom:asks', 'loom:failed', 'loom:job', 'loom:read']);
    expect(nextUpQueue(h.core).find((entry) => entry.id === 'loom:failed')?.step).toBe('failed');
    expect(briefing(h.core).yourMove.map((entry) => entry.id).sort()).toEqual(['loom:asks', 'loom:failed', 'loom:job', 'loom:read']);
    // The unread update is in the briefing's FYI batch instead.
    expect(briefing(h.core).fyi.flatMap((entry) => entry.itemIds)).toEqual(['loom:done']);
    await h.core.command({ commandId: 'seen-failed', type: 'seen', itemId: 'loom:failed' });
    expect(queued()).toEqual(['loom:asks', 'loom:failed', 'loom:job', 'loom:read']);
  });
});

describe('a worker in the owner’s queues', () => {
  it('stays out of Next up, the Your move count and the briefing while it reports up', async () => {
    const { makeHarness } = await import('./desk-harness.js');
    const { nextUpQueue, briefing, listItems } = await import('../server/desk/view.js');
    const h = makeHarness();
    const lead = h.core.ensureItem({ id: 'loom:lead', source: 'loom', kind: 'thread', conversationKey: 'loom:lead', agentId: 'loom', agentName: 'Loom', place: 'x', createdAt: 1 }, 'agent');
    const worker = h.core.ensureItem({ id: 'loom:worker', source: 'loom', kind: 'thread', conversationKey: 'loom:worker', agentId: 'loom', agentName: 'Loom', place: 'x', createdAt: 1 }, 'agent');
    h.core.recordMessage(worker.id, { messageId: 'w1', author: 'agent', at: 2, text: 'Which palette, warm or cool?' });
    h.core.setFacts(worker.id, { pending: { kind: 'question', questions: [] } as never });
    h.core.store.patchItem(worker.id, { nextStep: 'your_move' } as never);
    const queued = () => nextUpQueue(h.core).some((i) => i.id === worker.id);
    expect(queued()).toBe(true);
    expect(briefing(h.core).yourMove.some((i) => i.id === worker.id)).toBe(true);
    h.core.roles.set(worker.id, { role: 'worker', parentItemId: lead.id }, 'owner', 3);
    expect(queued()).toBe(false);
    expect(briefing(h.core).yourMove.some((i) => i.id === worker.id)).toBe(false);
    expect((listItems(h.core) as { counts: { yourMove: number } }).counts.yourMove).toBe(0);
    expect(nextUpQueue(h.core).some((i) => i.id === lead.id)).toBe(false);
  });

  it('files when mail last came in for workers on an older desk, once', async () => {
    const { makeHarness } = await import('./desk-harness.js');
    const h = makeHarness();
    const lead = h.core.ensureItem({ id: 'loom:lead', source: 'loom', kind: 'thread', conversationKey: 'loom:lead', agentId: 'loom', agentName: 'Loom', place: 'x', createdAt: 1 }, 'agent');
    const worker = h.core.ensureItem({ id: 'loom:worker', source: 'loom', kind: 'thread', conversationKey: 'loom:worker', agentId: 'loom', agentName: 'Loom', place: 'x', createdAt: 1 }, 'agent');
    h.core.roles.set(worker.id, { role: 'worker', parentItemId: lead.id }, 'owner', 1);
    h.core.recordMessage(worker.id, { messageId: 'o1', author: 'owner', at: 5, text: 'Looks good' });
    h.core.recordMessage(worker.id, { messageId: 'm1', author: 'owner', at: 9, text: '✉️ Mail from “x · Lead” [loom:lead] · m-1\n\nShip it.' });
    h.core.setFacts(worker.id, { lastMailInAt: undefined }, { lastOwnerMessageAt: 9 });
    h.core.store.deleteSetting('worker_mail_in_v1');
    h.core.start();
    expect(h.core.item(worker.id)!.facts.lastMailInAt).toBe(9);
    expect(h.core.item(worker.id)!.lastOwnerMessageAt).toBe(5);
    expect(h.core.store.setting('worker_mail_in_v1')).not.toBeNull();
  });
});

describe('agent spaces for any conversation', () => {
  it('places a coding thread in an agent’s space, and takes it out again', async () => {
    const { makeHarness } = await import('./desk-harness.js');
    const h = makeHarness();
    const item = h.core.ensureItem({ id: 'loom:compass', source: 'loom', kind: 'thread', conversationKey: 'loom:compass', agentId: 'loom', agentName: 'Loom', place: 'acme · Compass', createdAt: 1 }, 'agent');
    expect(await h.core.command({ commandId: 's1', type: 'space', itemId: item.id, args: { agent: { id: 'Compass', name: 'Compass' } } })).toMatchObject({ status: 'applied', outcome: { agentSpace: { id: 'compass', name: 'Compass' } } });
    expect(h.core.item(item.id)!.facts.agentSpace).toEqual({ id: 'compass', name: 'Compass' });
    expect(await h.core.command({ commandId: 's2', type: 'space', itemId: item.id, args: { agent: { id: '', name: 'x' } } })).toMatchObject({ status: 'failed' });
    await h.core.command({ commandId: 's3', type: 'space', itemId: item.id, args: { agent: null } });
    expect(h.core.item(item.id)!.facts.agentSpace).toBeNull();
    h.close();
  });
});

describe('what a worker staged shows where its owner talks with you', () => {
  it('puts its screens and prototypes on the owner conversation, marked with where they came from', async () => {
    const { makeHarness } = await import('./desk-harness.js');
    const { itemDetail } = await import('../server/desk/view.js');
    const h = makeHarness();
    const lead = h.core.ensureItem({ id: 'loom:lead', source: 'loom', kind: 'thread', conversationKey: 'loom:lead', agentId: 'loom', agentName: 'Loom', place: 'Studio lead', createdAt: 1 }, 'agent');
    const worker = h.core.ensureItem({ id: 'loom:w', source: 'loom', kind: 'thread', conversationKey: 'loom:w', agentId: 'loom', agentName: 'Loom', place: 'Thumbnail style', createdAt: 1 }, 'agent');
    h.core.roles.set(worker.id, { role: 'worker', parentItemId: lead.id }, 'agent', 2);
    const scene = { id: 's1', agentId: 'loom', conversationKey: 'loom:w', agentName: 'Loom', slot: 'main', kind: 'url', title: 'Thumbnail style', body: '', summary: '', choices: [{ id: 'a', label: 'A' }], state: {}, urgent: false, origin: { conversationKey: 'loom:w' }, version: 1, status: 'live', createdAt: 3, updatedAt: 3, expiresAt: 9e15 } as never;
    const prototype = { id: 'p1', agentId: 'loom', agentName: 'Loom', conversationKey: 'loom:w', name: 'thumbs', title: 'Thumbs', url: '/p/thumbs', drivable: false, version: 1, updatedAt: 3 } as never;
    const detail = itemDetail(h.core, lead.id, [scene], [prototype])!;
    expect(detail.scenes).toEqual([expect.objectContaining({ id: 's1', itemId: worker.id, from: { itemId: worker.id, title: expect.any(String), conversationKey: 'loom:w' } })]);
    expect(detail.prototypes).toEqual([expect.objectContaining({ id: 'p1', from: expect.objectContaining({ itemId: worker.id }) })]);
    expect(itemDetail(h.core, worker.id, [scene], [prototype])!.scenes[0]!.from).toBeUndefined();
  });
});

describe('unrelayed worker asks (TGO-1068)', () => {
  it("counts only worker asks the lead hasn't replied to since, and never a brief it carries", async () => {
    const { makeHarness } = await import('./desk-harness.js');
    const h = makeHarness();
    try {
      for (const id of ['loom:lead2', 'loom:w1', 'loom:w2', 'loom:w3']) h.core.ensureItem({ id, source: 'loom', kind: 'thread', conversationKey: id, agentId: 'loom', agentName: 'Loom', place: 'test', createdAt: 1 }, 'agent');
      for (const w of ['loom:w1', 'loom:w2', 'loom:w3']) h.core.roles.set(w, { role: 'worker', parentItemId: 'loom:lead2' }, 'owner', 2);
      const ask = (id: string, text: string, at: number) => { h.core.setFacts(id, { openAsk: { text, at } }); h.core.refresh(id); };
      ask('loom:w1', 'Merge the fix?', 100);
      ask('loom:w2', 'Approve the card?', 200);
      // A worker's decision brief is carried up whole, never counted as one to relay.
      ask('loom:w3', 'Pick A or B', 250);
      h.core.setFacts('loom:w3', { pending: { kind: 'question', requestId: 'decision:D-9', brief: { id: 'D-9' } } } as never);
      const lead = () => h.core.item('loom:lead2')!;
      expect(lead().facts.workerAsks?.count).toBe(2);
      expect([...lead().facts.workerAsks!.ids].sort()).toEqual(['loom:w1', 'loom:w2']);
      // The lead replies after both: handled, so no tally and no pill from them.
      h.core.recordMessage('loom:lead2', { messageId: 'r1', author: 'agent', at: 300, text: 'Both merged.' });
      h.core.refresh('loom:lead2');
      expect(lead().facts.workerAsks).toBeUndefined();
      // The lead is still the owner's move only for the brief it carries (D-9), as it should be, not for the tally.
      expect(lead().facts.pending?.requestId).toBe('decision:D-9');
      // With its own step quiet and the carried brief aside, the handled worker asks no longer make it Needs you.
      expect(deskStatus({ ...lead(), nextStep: 'fyi', facts: { ...lead().facts, pending: null } }).pill).toBe('needs'); // the carried brief is still open
      // A worker asks something new after the reply: that one counts.
      ask('loom:w1', 'Merge the follow-up?', 400);
      expect(lead().facts.workerAsks).toMatchObject({ count: 1, ids: ['loom:w1'] });
      // One recorded in the same millisecond as the lead's reply: the order isn't known, so it still counts.
      ask('loom:w2', 'Approve the second card?', 300);
      expect([...lead().facts.workerAsks!.ids].sort()).toEqual(['loom:w1', 'loom:w2']);
    } finally { h.close(); }
  });

  it('counts live decisions on the idle lead across every read path', async () => {
    const { makeHarness } = await import('./desk-harness.js');
    const h = makeHarness();
    try {
      for (const id of ['loom:lead', 'loom:worker']) h.core.ensureItem({ id, source: 'loom', kind: 'thread', conversationKey: id, agentId: 'loom', agentName: 'Loom', place: 'test', createdAt: 1 }, 'agent');
      h.core.roles.set('loom:worker', { role: 'worker', parentItemId: 'loom:lead' }, 'owner', 2);
      h.core.setFacts('loom:worker', { openAsk: { text: 'Choose a layout', at: 100 } });
      h.core.refresh('loom:worker');
      const lead = () => h.core.item('loom:lead')!;
      expect(lead().facts.workerAsks).toEqual({ count: 1, latestAt: 100, ids: ['loom:worker'] });
      expect(deskStatus(lead()).pill).toBe('idle');
      expect(h.core.itemsByIds(['loom:lead'])[0].facts.workerAsks).toEqual(lead().facts.workerAsks);
      expect(h.core.items().find((i) => i.id === 'loom:lead')!.facts.workerAsks).toEqual(lead().facts.workerAsks);
      expect(deskStatus({ ...lead(), seen: 'seen' }).pill).toBe('idle');
      expect(deskStatus({ ...lead(), facts: { ...lead().facts, background: 'working' } }).move).toBe(null);
      h.core.recordMessage('loom:lead', { messageId: 'relay', author: 'agent', at: 101, text: 'Relayed the worker question.' });
      h.core.refresh('loom:lead');
      expect(deskStatus(lead()).move).toBe(null);
      const notices: string[] = [];
      const unsubscribe = h.core.subscribe((event) => { if (event.type === 'item') notices.push(event.id); });
      h.core.touch('loom:worker');
      h.core.flush();
      expect(notices).toContain('loom:lead');
      unsubscribe();
      const worker = h.core.store.item('loom:worker')!;
      for (const patch of [{ kind: 'todo' }, { state: 'expired' }, { state: 'superseded' }, { state: 'duplicate' }]) {
        h.core.store.patchItem(worker.id, { askRecord: { ...worker.askRecord!, at: 200, ...patch } as never });
        expect(lead().facts.workerAsks).toMatchObject({ count: 1, ids: ['loom:worker'] });
      }
    } finally { h.close(); }
  });
});

it('a Done card renders the gist instead of the stale ask', async () => {
  const { presentItem } = await import('../server/desk/view.js');
  const card = presentItem({ agentId: 'loom', disposition: 'done', seen: 'seen', nextStep: 'your_move', nextStepBasis: 'source:ask', facts: {}, ask: 'Test this for me?', summary: { gist: 'The fix is verified.' } } as never);
  expect(card.line).toBe('Summary: The fix is verified.');
  expect(card.status.move).toBeNull();
});

it('a job reporting through another job relays its ask to the first lead above them', async () => {
  const { makeHarness } = await import('./desk-harness.js');
  const h = makeHarness();
  try {
    for (const id of ['loom:lead', 'loom:mid', 'loom:job']) h.core.ensureItem({ id, source: 'loom', kind: 'thread', conversationKey: id, agentId: 'loom', agentName: 'Loom', place: 'test', createdAt: 1 }, 'agent');
    h.core.roles.set('loom:mid', { role: 'ops', parentItemId: 'loom:lead' }, 'owner', 2);
    h.core.roles.set('loom:job', { role: 'ops', parentItemId: 'loom:mid' }, 'owner', 3);
    h.core.recordMessage('loom:job', { messageId: 'ask', author: 'agent', at: 100, text: 'Approve the change?' });
    h.core.setFacts('loom:job', { openAsk: { text: 'approve the change', at: 100 } });
    h.core.refresh('loom:job');
    // Loom's recorded ask reads as waiting on the lead, not as the owner's move.
    expect(deskStatus(h.core.item('loom:job')!)).toMatchObject({ audience: 'lead', move: 'watching', basis: 'source:lead-request' });
    expect(h.core.item('loom:lead')!.facts.workerAsks).toMatchObject({ count: 1, ids: ['loom:job'] });
    await h.core.command({ commandId: 'away', type: 'park', itemId: 'loom:lead' });
    expect(deskStatus(h.core.item('loom:job')!)).toMatchObject({ audience: 'owner', move: 'needs' });
  } finally { h.close(); }
});

it('an ops ask is relayed to its lead and returns to the owner when the lead is away', async () => {
  const { makeHarness } = await import('./desk-harness.js');
  const h = makeHarness();
  try {
    for (const id of ['loom:lead', 'loom:job']) h.core.ensureItem({ id, source: 'loom', kind: 'thread', conversationKey: id, agentId: 'loom', agentName: 'Loom', place: 'test', createdAt: 1 }, 'agent');
    h.core.roles.set('loom:job', { role: 'ops', parentItemId: 'loom:lead' }, 'owner', 2);
    h.core.recordMessage('loom:job', { messageId: 'ask', author: 'agent', at: 100, text: 'Approve the change?' });
    h.core.setFacts('loom:job', { openAsk: { text: 'approve the change', at: 100 } });
    h.core.refresh('loom:job');
    // Loom's recorded ask reads as waiting on the lead, not as the owner's move.
    expect(deskStatus(h.core.item('loom:job')!)).toMatchObject({ audience: 'lead', move: 'watching', basis: 'source:lead-request' });
    expect(h.core.item('loom:lead')!.facts.workerAsks).toMatchObject({ count: 1, ids: ['loom:job'] });
    await h.core.command({ commandId: 'away', type: 'park', itemId: 'loom:lead' });
    expect(deskStatus(h.core.item('loom:job')!)).toMatchObject({ audience: 'owner', move: 'needs' });
  } finally { h.close(); }
});
