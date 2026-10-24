import { describe, expect, it } from 'vitest';
import { lastOwnerTurn, lastReportTurn, mailLog, mailSince, queuedOf, turnsOf } from '../server/desk/backstage.js';
import { DeskMail, mailTurn, replyTurn, sentNote } from '../server/desk/mail.js';
import { loomMessageMeta, ownWakes, wakeNote } from '../server/desk/source-loom.js';
import { itemDetail } from '../server/desk/view.js';
import type { DeskMessage } from '../server/desk/types.js';
import { makeHarness, NOW } from './desk-harness.js';

const at = (minute: number) => NOW + minute * 60_000;
let n = 0;
const msg = (author: DeskMessage['author'], minute: number, text: string, meta?: DeskMessage['meta']): DeskMessage => ({ messageId: `m${(n += 1)}`, itemId: 'x', author, at: at(minute), text, ...(meta ? { meta } : {}) });
const mailIn = (minute: number, from: string, text: string) => msg('owner', minute, mailTurn({ id: `m-${minute}a`, fromItemId: 'loom:z', fromTitle: from, text, expect: 'reply' }));

describe('turns', () => {
  // The Game Design morning, shrunk: the owner asks, the agent answers with the link, then mail piles up.
  const messages = [
    msg('owner', 0, 'Can we talk about Photo Walk?'),
    msg('agent', 1, 'Here is the reasoning.'),
    msg('owner', 10, 'A few things: spotting should pay.'),
    msg('agent', 11, 'Spotting v2: https://example.test/spotting.html#v2'),
    msg('other', 11.5, sentNote({ id: 'm-out1', toItemId: 'loom:lead', toTitle: 'acme · Integration lead', text: 'Correction to the note.' })),
    mailIn(20, 'acme · Integration lead', 'Merged #8.'),
    msg('agent', 21, 'The integration lead merged #8.'),
    mailIn(30, 'acme · Playtest lead', 'Round 9 report.'),
    msg('agent', 31, 'Round 9 fixes go to the implementer.'),
  ];

  it('the latest reply to the owner is never a mail answer', () => {
    const turns = turnsOf(messages);
    expect(turns.map((t) => t.opener)).toEqual(['you', 'you', 'mail', 'mail']);
    expect(lastOwnerTurn(turns)!.replies.map((m) => m.text)).toEqual(['Spotting v2: https://example.test/spotting.html#v2']);
  });

  it('a worker’s answer coming back opens a turn whose words are the agent’s own report', () => {
    const turns = turnsOf([
      msg('owner', 0, 'Ship the voice work'),
      msg('agent', 1, 'Started a worker.'),
      msg('owner', 10, '✉️ Reply from “worker”\n\ndone\n\n— This answers your mail. It reports to you, and the owner doesn’t see it: you speak for it.', { mail: { kind: 'reply', peer: 'worker' } }),
      msg('agent', 11, 'The worker finished: all merged.'),
      mailIn(20, 'lead', 'Ping.'),
      msg('agent', 21, 'Answered the lead.'),
    ]);
    expect(lastReportTurn(turns)!.replies.map((m) => m.text)).toEqual(['The worker finished: all merged.']);
    // An ordinary peer's answer stays backstage.
    const peer = turnsOf([msg('owner', 0, 'hi'), msg('agent', 1, 'Hello.'), msg('owner', 2, '✉️ Reply from “peer”\n\nok\n\n— This answers your mail. Don’t tell the owner about this exchange separately.', { mail: { kind: 'reply', peer: 'peer' } }), msg('agent', 3, 'Noted.')]);
    expect(lastReportTurn(peer)!.replies.map((m) => m.text)).toEqual(['Hello.']);
  });

  it('mail since that reply folds into one line, the note sent mid-turn included', () => {
    const since = mailSince(turnsOf(messages))!;
    expect(since.line).toBe('✉️ 2 in, 1 out · Integration lead, Playtest lead');
    expect(since.lines.map((l) => [l.kind, l.text, l.answer])).toEqual([
      ['out', 'Correction to the note.', null],
      ['in', 'Merged #8.', 'The integration lead merged #8.'],
      ['in', 'Round 9 report.', 'Round 9 fixes go to the implementer.'],
    ]);
  });

  it('a native message read mid-turn is a marker inside the owner’s turn, not a turn of its own', () => {
    const turns = turnsOf([
      msg('owner', 0, 'Build it'),
      msg('owner', 1, 'Schema migration finished', { mail: { kind: 'in', peer: 'api-worker', inline: true } }),
      msg('agent', 2, 'Built, on the new schema.'),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.markers.map((m) => m.mail.peer)).toEqual(['api-worker']);
    expect(mailLog(turns)[0]).toMatchObject({ kind: 'in', inline: true });
  });

  it('queued: what the source says, else words sent during the running turn with no reply since', () => {
    const loomish = [msg('owner', 0, 'go'), msg('agent', 1, 'working'), msg('owner', 2, 'also this', { queued: true }), msg('owner', 3, 'and this', { queued: false })];
    expect(queuedOf(loomish, { since: at(0) }).map((q) => q.text)).toEqual(['also this']);
    const t3ish = [msg('owner', 0, 'go'), msg('agent', 1, 'working'), msg('owner', 2, 'also this'), msg('owner', 3, 'and this')];
    expect(queuedOf(t3ish, { since: at(0.5) }).map((q) => q.text)).toEqual(['also this', 'and this']);
    expect(queuedOf(t3ish, null)).toEqual([]);
    // Mail is never the owner's queued words.
    expect(queuedOf([mailIn(2, 'Lead', 'x')], { since: at(0) })).toEqual([]);
  });
});

describe('Loom messages', () => {
  it('maps origin and queued runs to what the desk shows', () => {
    const queuedRuns = new Set(['r2']);
    expect(loomMessageMeta({ role: 'user', text: 'go', run_id: 'r1' }, queuedRuns)).toEqual({ runId: 'r1', queued: false });
    expect(loomMessageMeta({ role: 'user', text: 'also', run_id: 'r2' }, queuedRuns)).toEqual({ runId: 'r2', queued: true });
    // A brief's answer Loom filed as the owner's turn (decisions.ts answerText) is marked, not typed words.
    expect(loomMessageMeta({ role: 'user', text: 'Decision D-12: Ship it?\nI chose A: Yes.', run_id: 'r1' }, queuedRuns)).toEqual({ runId: 'r1', queued: false, answers: 'D-12' });
    expect(loomMessageMeta({ role: 'user', text: 'Decision D-12 looks wrong to me', run_id: 'r1' }, queuedRuns)).toEqual({ runId: 'r1', queued: false });
    expect(loomMessageMeta({ role: 'assistant', text: 'hi', run_id: 'r1' }, queuedRuns)).toEqual({ runId: 'r1' });
    expect(loomMessageMeta({ role: 'user', text: 'Schema done', origin: JSON.stringify({ kind: 'peer', name: 'api-worker', from: 'uds:/tmp/a', mailId: 'n1', inline: true }) }, queuedRuns)).toEqual({ mail: { kind: 'in', peer: 'api-worker', peerId: 'uds:/tmp/a', mailId: 'n1', inline: true } });
    expect(loomMessageMeta({ role: 'user', text: 'thanks', origin: JSON.stringify({ kind: 'peer-out', name: 'api-worker', to: 'api-worker', mailId: 't1' }) }, queuedRuns)?.mail).toMatchObject({ kind: 'out', peer: 'api-worker' });
    // Desk mail steered in: its header names the sender and the mail.
    const steered = mailTurn({ id: 'm-abc', fromItemId: 'loom:a', fromTitle: 'tango · Overview', text: 'port?', expect: 'reply' });
    expect(loomMessageMeta({ role: 'user', text: steered, origin: JSON.stringify({ kind: 'peer', name: 'tango · Overview', from: 'loom:a', mailId: 'm-abc', inline: true }) }, queuedRuns)?.mail).toEqual({ kind: 'in', peer: 'tango · Overview', peerId: 'loom:a', mailId: 'm-abc', inline: true });
    expect(loomMessageMeta({ role: 'user', text: replyTurn({ id: 'm-abc', toItemId: 'loom:b', toTitle: 'Tile', text: 'q', answer: '8080' }) }, queuedRuns)?.mail).toMatchObject({ kind: 'reply', peer: 'Tile' });
  });

  it('the agent’s words in a run Loom woke it for carry the wake and the note it left', () => {
    const wakeRuns = new Map([['r9', { note: 'Live checkout now includes #959.', cause: 'trigger' as const }]]);
    expect(loomMessageMeta({ role: 'assistant', text: 'Verified.', run_id: 'r9' }, new Set(), wakeRuns)).toEqual({ runId: 'r9', wake: { run: 'r9', note: 'Live checkout now includes #959.', cause: 'trigger' } });
    expect(loomMessageMeta({ role: 'assistant', text: 'Hi.', run_id: 'r1' }, new Set(), wakeRuns)).toEqual({ runId: 'r1' });
    expect(wakeNote('Loom: the trigger you set fired: waiting for a command. Your note: Live checkout now includes #959. Confirm the server restarted, then check.')).toBe('Live checkout now includes #959.');
    expect(wakeNote('Loom: the time you set came.')).toBeNull();
  });

  it('a peer’s message waking the thread, or a run made for mail, is not Loom’s own wake; mail arriving during one is', () => {
    const run = (id: string, text: string) => ({ id, status: 'completed' as const, source: 'wake', text, failure: null, started_at: 1, ended_at: 2 });
    const wakes = ownWakes({
      runs: [
        run('w', 'Loom: the trigger you set fired: x. Your note: CI done.'),
        run('p', 'A message from another session.'),
        run('f', 'Loom: worker failed.'),
        run('i', 'Loom: the time you set came. Your note: Check the deploy.'),
        // Folded by Loom: a failure report first, then a peer's wake, and the other way round.
        run('ff', 'Loom: worker failed.\n\n---\n\nA message from another session.'),
        run('wf', 'Loom: the trigger you set fired: y. Your note: Merged.\n\n---\n\nLoom: worker failed.'),
        { ...run('u', 'go'), source: 'user' },
      ],
      messages: [
        { id: 'm1', run_id: 'f', role: 'user', text: 'Loom: worker failed.', created_at: 1 },
        // Mail that arrived inline during the wake (in, and a receipt out) didn't start it.
        { id: 'm2', run_id: 'i', role: 'user', text: 'Merged #8.', created_at: 2 },
        { id: 'm3', run_id: 'i', role: 'user', text: 'Thanks.', created_at: 3 },
        { id: 'm4', run_id: 'ff', role: 'user', text: 'Loom: worker failed.', created_at: 4 },
        { id: 'm5', run_id: 'ff', role: 'user', text: 'Merged #9.', created_at: 5 },
        { id: 'm6', run_id: 'wf', role: 'user', text: 'Loom: worker failed.', created_at: 6 },
      ],
    });
    expect([...wakes]).toEqual([['w', { note: 'CI done.', cause: 'trigger' }], ['i', { note: 'Check the deploy.', cause: 'trigger' }], ['wf', { note: 'Merged.', cause: 'trigger' }]]);
  });
});

describe('the Conversation view', () => {
  it('detail: the reply is the latest to the owner, backstage since then, every mail, what is queued', () => {
    const h = makeHarness();
    h.core.store.createItem({ id: 'loom:t', source: 'loom', kind: 'thread', conversationKey: 'loom:t', agentId: 'loom', agentName: 'Loom' });
    for (const m of [
      msg('owner', 0, 'Spotting rules?'),
      msg('agent', 1, 'Spotting v2: https://example.test/v2'),
      mailIn(5, 'acme · Integration lead', 'Merged #8.'),
      msg('agent', 6, 'The lead merged #8.'),
    ]) h.core.recordMessage('loom:t', m);
    const detail = itemDetail(h.core, 'loom:t', [])!;
    expect(detail.reply!.text).toBe('Spotting v2: https://example.test/v2');
    expect(detail.backstage).toMatchObject({ line: '✉️ 1 in · Integration lead' });
    expect(detail.mail.map((l) => l.text)).toEqual(['Merged #8.']);
    expect(detail.beats.map((b) => b.kind)).toEqual(['owner', 'agent', 'backstage']);
    expect(detail.queued).toEqual([]);
  });

  it('no reply to the owner yet: the main reply is empty, never a mail answer; a thread an agent started shows its own', () => {
    const h = makeHarness();
    for (const id of ['loom:t', 'loom:s']) h.core.store.createItem({ id, source: 'loom', kind: 'thread', conversationKey: id, agentId: 'loom', agentName: 'Loom' });
    for (const m of [msg('owner', 0, 'Spotting rules?'), mailIn(5, 'acme · Integration lead', 'Merged #8.'), msg('agent', 6, 'The lead merged #8.')]) h.core.recordMessage('loom:t', m);
    expect(itemDetail(h.core, 'loom:t', [])!.reply).toBeNull();
    for (const m of [mailIn(0, 'tango · Design', 'Build the art pipeline.'), msg('agent', 9, 'Pipeline is in tools/art.')]) h.core.recordMessage('loom:s', m);
    expect(itemDetail(h.core, 'loom:s', [])!.reply!.text).toBe('Pipeline is in tools/art.');
  });

  // Live 10/21 (Sidebar Links Investigation): a worker's answer came back, then the wait fired and the agent
  // verified and closed out; the view kept showing the reply before the mail ("waiting on the worker").
  it('a turn Loom woke it for is the latest reply, even right after a peer’s mail', () => {
    const h = makeHarness();
    h.core.store.createItem({ id: 'loom:w', source: 'loom', kind: 'thread', conversationKey: 'loom:w', agentId: 'loom', agentName: 'Loom' });
    const wake = { wake: { run: 'r6', note: 'Live checkout now includes #959.' } };
    for (const m of [
      msg('owner', 0, 'Remove the stack'),
      msg('agent', 1, 'Merged. Next — waiting on the worker: it deploys, then I check the live desk.'),
      mailIn(5, 'tango · D-296', 'CI passed; re-review pending.'),
      msg('agent', 6, 'Meanwhile: the worker is waiting on its re-review.'),
      msg('agent', 12, 'Checking the page itself.', wake),
      msg('agent', 14, 'The stack is gone from the live desk. Next — none: done.', wake),
    ]) h.core.recordMessage('loom:w', m);
    const detail = itemDetail(h.core, 'loom:w', [])!;
    expect(detail.reply!.text).toContain('The stack is gone from the live desk.');
    expect(detail.beats.map((b) => b.kind)).toEqual(['owner', 'agent', 'backstage', 'wake', 'agent']);
    expect(detail.beats.find((b) => b.kind === 'wake')!.headline).toBe('A wait came due: Live checkout now includes #959.');
    // Nothing backstage since the report.
    expect(detail.backstage).toBeNull();
    // Two wakes in a row are two turns.
    const turns = turnsOf([msg('agent', 20, 'First check.', { wake: { run: 'a' } }), msg('agent', 30, 'Second check.', { wake: { run: 'b' } })]);
    expect(turns.map((t) => [t.opener, t.replies.length])).toEqual([['wake', 1], ['wake', 1]]);
    // The owner steering a wake mid-run: what follows answers them, under no second wake.
    const steered = turnsOf([msg('agent', 40, 'Checking CI.', { wake: { run: 'c' } }), msg('owner', 45, 'Also check the deploy.'), msg('agent', 50, 'Both green.', { wake: { run: 'c' } })]);
    expect(steered.map((t) => [t.opener, t.replies.map((r) => r.text)])).toEqual([['wake', ['Checking CI.']], ['you', ['Both green.']]]);
  });

  it('an explicit answer to mail read mid-turn shows with that mail', () => {
    const turns = turnsOf([
      msg('owner', 0, 'Build it'),
      msg('owner', 1, 'port?', { mail: { kind: 'in', peer: 'Lead', mailId: 'm-1', inline: true } }),
      msg('other', 2, '8080', { mail: { kind: 'out', peer: 'Lead', mailId: 'm-1', inline: true, answers: true } }),
      msg('agent', 3, 'Built.'),
    ]);
    expect(mailLog(turns).map((l) => [l.kind, l.text, l.answer])).toEqual([['in', 'port?', '8080']]);
  });

  it('mail a desk command delivers never counts as the owner engaging', async () => {
    const h = makeHarness();
    h.core.store.createItem({ id: 'loom:t', source: 'loom', kind: 'thread', conversationKey: 'loom:t', agentId: 'loom', agentName: 'Loom' });
    (h.core as unknown as { options: { adapters: unknown[] } }).options.adapters.push({ owns: (item: { source: string }) => item.source === 'loom', reply: async () => ({ ok: true }) });
    const text = mailTurn({ id: 'm-1', fromItemId: 'loom:a', fromTitle: 'A', text: 'port?', expect: 'reply' });
    const result = await h.core.command({ commandId: 'mail-m-1', type: 'reply', itemId: 'loom:t', args: { text }, actor: 'agent' });
    expect(result.status).toBe('applied');
    expect(h.core.store.eventsFor('loom:t').map((e) => e.type)).not.toContain('source.owner_posted');
    expect(h.core.item('loom:t')!.lastOwnerMessageAt).toBeNull();
  });

  it('mail filed since a summary is never the owner replying', () => {
    const h = makeHarness();
    h.core.store.createItem({ id: 'loom:t', source: 'loom', kind: 'thread', conversationKey: 'loom:t', agentId: 'loom', agentName: 'Loom' });
    h.core.recordMessage('loom:t', mailIn(5, 'acme · Integration lead', 'Merged #8.'));
    expect(h.core.store.ownerInLastFiled('loom:t', 3)).toBe(false);
    h.core.recordMessage('loom:t', msg('owner', 6, 'ok, ship it'));
    expect(h.core.store.ownerInLastFiled('loom:t', 3)).toBe(true);
  });

  it('the history’s mail lines carry an explicit answer to mail read mid-turn', () => {
    const h = makeHarness();
    h.core.store.createItem({ id: 'loom:t', source: 'loom', kind: 'thread', conversationKey: 'loom:t', agentId: 'loom', agentName: 'Loom' });
    for (const m of [
      msg('owner', 0, 'Build it'),
      msg('owner', 1, 'port?', { mail: { kind: 'in', peer: 'Lead', mailId: 'm-9', inline: true } }),
      msg('other', 2, '8080', { mail: { kind: 'out', peer: 'Lead', mailId: 'm-9', inline: true, answers: true } }),
      msg('agent', 3, 'Built.'),
    ]) h.core.recordMessage('loom:t', m);
    const lines = itemDetail(h.core, 'loom:t', [])!.beats.filter((b) => b.kind === 'mail').flatMap((b) => b.lines ?? []);
    expect(lines.map((l) => [l.kind, l.answer])).toEqual([['in', '8080']]);
  });

  it('mail never becomes what the owner asked', () => {
    const h = makeHarness();
    h.core.store.createItem({ id: 'loom:t', source: 'loom', kind: 'thread', conversationKey: 'loom:t', agentId: 'loom', agentName: 'Loom' });
    h.core.recordMessage('loom:t', msg('owner', 0, 'Spotting rules?'));
    h.core.recordMessage('loom:t', mailIn(5, 'acme · Integration lead', 'Merged #8.'));
    expect(h.core.item('loom:t')!.facts.lastOwnerRequest?.text).toBe('Spotting rules?');
  });

  it('the source copy of a desk reply keeps the reply’s filing time, so a later poll can’t move it past a chip', () => {
    const h = makeHarness();
    h.core.store.createItem({ id: 'loom:t', source: 'loom', kind: 'thread', conversationKey: 'loom:t', agentId: 'loom', agentName: 'Loom' });
    h.core.recordMessage('loom:t', msg('owner', 0, 'Build it'));
    h.core.setFacts('loom:t', { lastOwnerRequest: { text: 'Go with B', at: 7_000 } });
    h.core.recordMessage('loom:t', msg('owner', 6, 'Go with B'));
    expect(h.core.item('loom:t')!.facts.lastOwnerRequest).toMatchObject({ text: 'Go with B', filedAt: 7_000 });
    // New words are filed when the desk gets them.
    h.core.recordMessage('loom:t', msg('owner', 8, 'And C'));
    expect(h.core.item('loom:t')!.facts.lastOwnerRequest!.filedAt).not.toBe(7_000);
  });
});

describe('mail into a busy Loom thread', () => {
  it('goes in mid-turn at once, asks for an explicit reply, and that reply goes back', async () => {
    const h = makeHarness();
    for (const id of ['loom:a', 'loom:b']) h.core.store.createItem({ id, source: 'loom', kind: 'thread', conversationKey: id, agentId: 'loom', agentName: 'Loom', place: `tango · ${id}` });
    h.core.setFacts('loom:b', { running: { since: NOW } });
    const steered: Array<{ text: string; origin: unknown }> = [];
    const mail = new DeskMail({ core: h.core, db: h.core.store.db, now: () => h.clock.now, steer: async (_item, text, origin) => (steered.push({ text, origin }), { ok: true, steered: true }) });
    const sent = mail.send({ from: 'loom:a', to: 'loom:b', text: 'Which port?' });
    const id = sent.ok ? sent.mail.id : '';
    await new Promise((resolve) => setTimeout(resolve, 0));
    await mail.tick();
    expect(steered).toHaveLength(1);
    expect(steered[0]!.text).toContain(`tango-screen reply ${id}`);
    expect(steered[0]!.origin).toEqual({ name: expect.stringContaining('loom:a'), from: 'loom:a', mailId: id });
    expect(mail.get(id)).toMatchObject({ state: 'sent', steered: true });
    // The end of the turn it landed in is not its answer.
    h.core.recordMessage('loom:b', msg('agent', 5, 'Finished the build.'));
    h.core.setFacts('loom:b', { running: null });
    await mail.tick();
    expect(mail.get(id)!.state).toBe('sent');
    expect(mail.answer(id, 'loom:a', '8080')).toMatchObject({ ok: false });
    expect(mail.answer(id, 'loom:b', '8080')).toMatchObject({ ok: true });
    expect(mail.get(id)).toMatchObject({ state: 'answered', answer: '8080' });
  });
});

describe('a reply before the delivery comes back', () => {
  it('is taken, and the delivery finishing doesn’t undo it', async () => {
    const h = makeHarness();
    for (const id of ['loom:a', 'loom:b']) h.core.store.createItem({ id, source: 'loom', kind: 'thread', conversationKey: id, agentId: 'loom', agentName: 'Loom' });
    let mail!: DeskMail;
    let id = '';
    // The recipient answers while Loom's response to the delivery is still on its way.
    mail = new DeskMail({ core: h.core, db: h.core.store.db, now: () => h.clock.now, steer: async () => { expect(mail.answer(id, 'loom:b', '8080')).toMatchObject({ ok: true }); return { ok: true, steered: true }; } });
    const sent = mail.send({ from: 'loom:a', to: 'loom:b', text: 'Which port?' });
    id = sent.ok ? sent.mail.id : '';
    await new Promise((resolve) => setTimeout(resolve, 0));
    await mail.tick();
    expect(mail.get(id)).toMatchObject({ state: 'answered', answer: '8080' });
  });
});
