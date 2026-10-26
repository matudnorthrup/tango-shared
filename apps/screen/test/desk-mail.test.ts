import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeskMail, DISCORD_TURN_MAX, HELD_NOTICE_MS, isDeskNotice, noticeTurn, DEPTH_NOTICE_HOPS, MAX_START_DEPTH, START_LIMIT, PAIR_LIMIT, mailAnswer, mailTurn, parseMailHeader, replyTurn, sentNote } from '../server/desk/mail.js';
import { DeskLoomSource } from '../server/desk/source-loom.js';
import { threadBeats } from '../server/desk/view.js';
import { AGENT, makeHarness, msg, NOW, type Harness } from './desk-harness.js';

const iso = (minute: number) => new Date(NOW + minute * 60_000).toISOString();

let h: Harness;
let details: Map<string, TestThread>;
let dispatched: Array<Record<string, unknown>>;
let source: DeskLoomSource;
let mail: DeskMail;

interface TestThread {
  id: string;
  title: string;
  status: 'idle' | 'running' | 'waiting';
  updatedAt: string;
  messages: Array<{ id: string; role: 'user' | 'assistant'; text: string; createdAt: string }>;
  questions?: Array<{ id: string; header: string; question: string; options: Array<{ label: string }> }>;
}
function thread(id: string, patch: Partial<TestThread> = {}): TestThread {
  return { id, title: `Thread ${id}`, status: 'idle', updatedAt: iso(-5), messages: [
    { id: `u:${id}:1`, role: 'user', text: 'Build the overview map', createdAt: iso(-30) },
    { id: `a:${id}:1`, role: 'assistant', text: 'The overview map is up.', createdAt: iso(-5) },
  ], ...patch };
}
const running = (id: string): TestThread => ({ ...details.get(id)!, status: 'running' });

// Exercise the actual Loom adapter with deterministic snapshot state and a command transport stub.
// No live Loom service or owner desk is contacted.
async function poll(): Promise<void> {
  for (const t of details.values()) {
    (source as unknown as { ingest(detail: unknown): void }).ingest({
      thread: { id: t.id, title: t.title, cwd: '/repos/tango', repo: '/repos/tango', status: t.status,
        created_at: Date.parse(iso(-60)), updated_at: Date.parse(t.updatedAt), settled_at: null },
      runs: [{ id: 'turn-1', status: t.status === 'running' ? 'running' : 'completed', failure: null,
        started_at: Date.parse(iso(-30)), ended_at: t.status === 'running' ? null : Date.parse(t.updatedAt) }],
      messages: t.messages.map(({ createdAt, ...message }) => ({ ...message, created_at: Date.parse(createdAt) })),
      requests: t.questions ? [{ id: 'r1', kind: 'question', status: 'open', payload: JSON.stringify({ questions: t.questions }), created_at: NOW }] : [],
    });
  }
}

/** What the fake Loom got as new turns in one thread. */
const turns = (threadId: string) => dispatched.filter((c) => c.threadId === threadId).map((c) => String(c.text));

/** A dispatched turn shows up in the thread, the way Loom would file it. */
function landTurns(threadId: string, minute: number): void {
  const t = details.get(threadId)!;
  const known = new Set(t.messages.map((m) => m.text));
  const added = turns(threadId).filter((text) => !known.has(text)).map((text, i) => ({ id: `u:${threadId}:mail${minute}:${i}`, role: 'user' as const, text, createdAt: iso(minute) }));
  details.set(threadId, { ...t, updatedAt: iso(minute), messages: [...t.messages, ...added] });
}

const api = {
  dispatch: async (command: Record<string, unknown>) => { dispatched.push(command); },
};

beforeEach(async () => {
  h = makeHarness();
  details = new Map([
    ['a', thread('a', { title: 'Overview map' })],
    ['b', thread('b', { title: 'Tile server' })],
  ]);
  dispatched = [];
  source = new DeskLoomSource({ core: h.core, url: 'http://loom.test', tokenFile: `${h.dir}/missing-token`, projectFor: () => ({ id: 'p-tango', name: 'tango' }) });
  vi.spyOn(source as never, 'call' as never).mockImplementation((async (_path: string, options: { body: Record<string, unknown> }) => {
    await api.dispatch(options.body);
    return { status: 200, body: { ok: true } };
  }) as never);
  (h.core as unknown as { options: { adapters: unknown[] } }).options.adapters.push(source);
  await poll();
  mail = new DeskMail({ core: h.core, db: h.core.store.db, blockedAgents: ['kilo'], now: () => h.clock.now });
});

// Deliveries a test's sends started in the background finish before the next test begins (they share the fake Loom).
afterEach(async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
});

describe('answers sent as new mail', () => {
  async function delivered(steered = false, kind = 'mail') {
    const result = mail.send({ from: 'loom:a', to: 'loom:b', text: 'Which port?' });
    if (!result.ok) throw new Error(result.error);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await mail.tick();
    h.core.store.db.prepare('UPDATE desk_mail SET steered = ?, kind = ? WHERE id = ?').run(steered ? 1 : 0, kind, result.mail.id);
    return mail.get(result.mail.id)!;
  }

  function back(at: number, state = 'done', text = '8080', id = 'm-back') {
    h.core.store.db.prepare(`INSERT INTO desk_mail
      (id, from_item, to_item, from_title, to_title, text, expect, state, chain, hops, urgent, created_at)
      VALUES (?, 'loom:b', 'loom:a', 'B', 'A', ?, 'none', ?, 'm-back', 0, 0, ?)`).run(id, text, state, at);
  }

  it.each([false, true])('collects back-mail and never sends a duplicate relay (steered: %s)', async (steered) => {
    const original = await delivered(steered);
    back(NOW + 1, 'done', 'x'.repeat(7000));
    h.clock.now += 2;
    await mail.tick();
    expect(mail.get(original.id)).toMatchObject({ state: 'answered', answeredAt: NOW + 1, relayedAt: NOW + 2, relayedVia: 'mail' });
    expect(mail.get(original.id)!.answer).toHaveLength(6000);
    await mail.tick();
    expect(turns('a')).toEqual([]);
  });

  it('collects start back-mail after an owner message breaks the transcript anchor', async () => {
    const original = await delivered(false, 'start');
    landTurns('b', 0);
    details.get('b')!.messages.push({ id: 'owner-followup', role: 'user', text: 'Also check the host', createdAt: iso(1) });
    details.get('b')!.messages.push({ id: 'worker-answer', role: 'assistant', text: 'Finished', createdAt: iso(2) });
    await poll();
    back(NOW + 3 * 60_000);
    h.clock.now += 4 * 60_000;
    await mail.tick();
    expect(mail.get(original.id)).toMatchObject({ state: 'answered', answer: '8080', relayedVia: 'mail' });
    expect(turns('a')).toEqual([]);
  });

  it('keeps a start pending through a mid-turn question and relays the final transcript report', async () => {
    const original = await delivered(false, 'start');
    landTurns('b', 0);
    details.set('b', running('b'));
    await poll();
    back(NOW + 1, 'sent', 'Which issue tracks this?');
    h.core.store.db.prepare("UPDATE desk_mail SET expect = 'reply' WHERE id = 'm-back'").run();
    h.clock.now += 2;
    await mail.tick();
    expect(mail.get(original.id)!.state).toBe('sent');
    details.get('b')!.messages.push({ id: 'final-report', role: 'assistant', text: 'Implemented and verified.', createdAt: iso(1) });
    details.get('b')!.status = 'idle';
    details.get('b')!.updatedAt = iso(1);
    h.clock.now += 60_000;
    await poll();
    await mail.tick();
    expect(mail.get(original.id)).toMatchObject({ state: 'answered', answer: 'Implemented and verified.', relayedVia: 'turn' });
    expect(turns('a').some((text) => text.includes('Implemented and verified.'))).toBe(true);
  });

  it.each([false, true])('waits for idle and uses the latest back-mail, excluding future mail (steered: %s)', async (steered) => {
    const original = await delivered(steered);
    details.set('b', running('b'));
    await poll();
    back(NOW + 1, 'done', 'Early question');
    back(NOW + 2, 'done', 'Final report', 'm-report');
    back(NOW + 100, 'done', 'Future mail', 'm-future');
    h.clock.now += 3;
    await mail.tick();
    expect(mail.get(original.id)!.state).toBe('sent');
    details.get('b')!.status = 'idle';
    await poll();
    await mail.tick();
    expect(mail.get(original.id)).toMatchObject({ state: 'answered', answer: 'Final report', answeredAt: NOW + 2, relayedVia: 'mail' });
    expect(turns('a')).toEqual([]);
  });

  it.each([false, true])('does not answer a worker question with its own report-up row (steered: %s)', async (steered) => {
    // a is the worker asking b (its lead); report-up stores the opposite direction.
    const original = await delivered(steered);
    back(NOW + 1, 'answered', 'Report: worker');
    h.core.store.db.prepare("UPDATE desk_mail SET kind = 'report', relayed_at = ? WHERE id = 'm-back'").run(NOW + 1);
    h.clock.now += 2;
    await mail.tick();
    expect(mail.get(original.id)).toMatchObject({ state: 'sent', answer: null, relayedVia: null });
  });

  it.each(['draft', 'dropped', 'failed'])('does not count %s back-mail', async (state) => {
    const original = await delivered(true);
    back(NOW + 1, state);
    h.clock.now += 2;
    await mail.tick();
    expect(mail.get(original.id)!.state).toBe('sent');
  });

  it.each([-1, 0])('does not count back-mail before or at delivery (%s)', async (offset) => {
    const original = await delivered(true);
    h.core.store.db.prepare('UPDATE desk_mail SET sent_at = ? WHERE id = ?').run(NOW + 100, original.id);
    back(NOW + 100 + offset);
    h.clock.now += 101;
    await mail.tick();
    expect(mail.get(original.id)!.state).toBe('sent');
  });
});

describe('mail text', () => {
  it('headers parse back, and the footer the desk adds is not part of what was said', () => {
    const record = { id: 'm-1a2b3c4d', fromItemId: 'loom:a', fromTitle: 'Overview map', toItemId: 'loom:b', toTitle: 'Tile server', text: 'Which port is the tile server on?', expect: 'reply' as const, answer: '8080' };
    expect(parseMailHeader(mailTurn(record))).toEqual({ kind: 'from', title: 'Overview map', itemId: 'loom:a', mailId: 'm-1a2b3c4d', body: 'Which port is the tile server on?' });
    expect(parseMailHeader(replyTurn(record))).toMatchObject({ kind: 'reply', title: 'Tile server', itemId: 'loom:b', body: '8080' });
    expect(parseMailHeader(sentNote(record))).toMatchObject({ kind: 'to', title: 'Tile server', body: 'Which port is the tile server on?' });
    expect(parseMailHeader('Just the owner talking')).toBeNull();
    // An older bot's wrapper line ahead of the header (Codex review on #569); deeper than that isn't a header.
    expect(parseMailHeader(`The owner replied from the screen (re: "x"):\n${mailTurn(record)}`)).toMatchObject({ kind: 'from', mailId: 'm-1a2b3c4d', body: 'Which port is the tile server on?' });
    expect(parseMailHeader(`one\ntwo\n${mailTurn(record)}`)).toBeNull();
  });

  it('the answer is the reply after the mail arrived, up to the next thing anyone else said', () => {
    const turn = mailTurn({ id: 'm-aa', fromItemId: 'loom:a', fromTitle: 'A', text: 'port?', expect: 'reply' });
    const messages = [
      { author: 'agent', at: NOW + 1_000, text: 'Still finishing the old turn.' },
      { author: 'owner', at: NOW + 2_000, text: turn },
      { author: 'agent', at: NOW + 3_000, text: 'Checking.' },
      { author: 'agent', at: NOW + 4_000, text: '8080.\n\n**Next — none:** done.' },
      { author: 'owner', at: NOW + 5_000, text: 'Now do something else' },
      { author: 'agent', at: NOW + 6_000, text: 'Doing it.' },
    ];
    expect(mailAnswer(messages, 'm-aa', NOW)).toEqual({ text: '8080.', at: NOW + 4_000 });
    expect(mailAnswer(messages, 'm-other', NOW)).toBeNull();
    // A long answer a Discord agent posted in pieces comes back whole; the progress note doesn't.
    const pieces = [{ author: 'owner', at: NOW + 2_000, text: turn }, { author: 'agent', at: NOW + 3_000, text: 'Checking.' }, { author: 'agent', at: NOW + 4_000, text: 'a'.repeat(1_900) }, { author: 'agent', at: NOW + 4_001, text: 'the end' }];
    expect(mailAnswer(pieces, 'm-aa', NOW)!.text).toBe(`${'a'.repeat(1_900)}\n\nthe end`);
  });

  it('mail delivered together shares the reply that follows; mail after a reply starts its own', () => {
    const first = mailTurn({ id: 'm-aa', fromItemId: 'loom:a', fromTitle: 'A', text: 'port?', expect: 'reply' });
    const second = mailTurn({ id: 'm-bb', fromItemId: 'loom:a', fromTitle: 'A', text: 'host?', expect: 'reply' });
    const third = mailTurn({ id: 'm-cc', fromItemId: 'loom:a', fromTitle: 'A', text: 'user?', expect: 'reply' });
    const messages = [
      { author: 'owner', at: NOW + 1_000, text: first },
      { author: 'owner', at: NOW + 1_000, text: second },
      { author: 'agent', at: NOW + 3_000, text: '8080 on tiles.local.' },
      { author: 'owner', at: NOW + 4_000, text: third },
      { author: 'agent', at: NOW + 5_000, text: 'tiles.' },
    ];
    expect(mailAnswer(messages, 'm-aa', NOW)).toEqual({ text: '8080 on tiles.local.', at: NOW + 3_000 });
    expect(mailAnswer(messages, 'm-bb', NOW)).toEqual({ text: '8080 on tiles.local.', at: NOW + 3_000 });
    expect(mailAnswer(messages, 'm-cc', NOW)).toEqual({ text: 'tiles.', at: NOW + 5_000 });
    // An owner's own words after the mail still end it.
    expect(mailAnswer([{ author: 'owner', at: NOW, text: first }, { author: 'owner', at: NOW + 1, text: 'never mind' }, { author: 'agent', at: NOW + 2, text: 'ok' }], 'm-aa', NOW)).toBeNull();
  });
});

describe('sending', () => {
  it('waits for the target to be idle, delivers with the sender named, and takes the answer back', async () => {
    details.set('b', running('b'));
    await poll();
    const sent = mail.send({ from: 'loom:a', to: 'loom:b', text: 'Which port is the tile server on?' });
    expect(sent.ok).toBe(true);
    const id = sent.ok ? sent.mail.id : '';
    await mail.tick();
    expect(turns('b')).toHaveLength(0);
    expect(mail.get(id)!.state).toBe('queued');

    // The sender's own conversation keeps a note of what it sent.
    const note = h.core.store.messages('loom:a').find((m) => m.messageId === `mail:${id}:out`);
    expect(note?.author).toBe('other');
    expect(parseMailHeader(note!.text)).toMatchObject({ kind: 'to', itemId: 'loom:b', mailId: id });

    // Idle: delivered, headed with who sent it.
    details.set('b', thread('b', { title: 'Tile server' }));
    await poll();
    await mail.tick();
    expect(turns('b')).toHaveLength(1);
    expect(parseMailHeader(turns('b')[0]!)).toMatchObject({ kind: 'from', itemId: 'loom:a', title: 'tango · Overview map', mailId: id });
    expect(mail.get(id)!.state).toBe('sent');

    // It answers; once it's idle again the answer goes back to the sender as a turn.
    h.clock.now += 120_000;
    landTurns('b', 1);
    const b = details.get('b')!;
    details.set('b', { ...b, updatedAt: iso(2), messages: [...b.messages, { id: 'a:b:2', role: 'assistant', text: 'It listens on 8080.', createdAt: iso(2) }] });
    await poll();
    await mail.tick();
    expect(mail.get(id)).toMatchObject({ state: 'answered', answer: 'It listens on 8080.', relayedVia: 'turn' });
    expect(turns('a')).toHaveLength(1);
    expect(parseMailHeader(turns('a')[0]!)).toMatchObject({ kind: 'reply', itemId: 'loom:b', body: 'It listens on 8080.' });

    // Both conversation views keep it backstage: never the owner talking, never the owner's exchange.
    landTurns('a', 3);
    await poll();
    const aBeats = threadBeats(h.core, h.core.item('loom:a')!, h.core.store.messages('loom:a', 40));
    expect(aBeats.find((beat) => beat.mail?.kind === 'out')).toMatchObject({ kind: 'mail', headline: expect.stringContaining('Tile server') });
    expect(aBeats.find((beat) => beat.kind === 'backstage')).toMatchObject({ headline: expect.stringContaining('1 in'), lines: [expect.objectContaining({ kind: 'reply', headline: 'It listens on 8080.' })] });
    expect(aBeats.filter((beat) => beat.kind === 'owner').map((beat) => beat.headline)).toEqual(['Build the overview map']);
    const bBeats = threadBeats(h.core, h.core.item('loom:b')!, h.core.store.messages('loom:b', 40));
    expect(bBeats.find((beat) => beat.kind === 'backstage')?.lines?.[0]).toMatchObject({ kind: 'in', headline: 'Which port is the tile server on?', answer: 'It listens on 8080.' });
  });

  it('mail delivered together gets one answer back, not one per mail', async () => {
    // Three mails a queue flushed into one turn: mailAnswer gives each the same reply.
    const insert = h.core.store.db.prepare("INSERT INTO desk_mail (id, from_item, to_item, from_title, to_title, text, expect, state, chain, hops, urgent, created_at, sent_at, answer, answered_at) VALUES (?, 'loom:a', 'loom:b', 'A', 'Tile server', ?, 'reply', 'answered', ?, 1, 0, ?, ?, '8080 on tiles.local.', ?)");
    for (const id of ['m-aa000001', 'm-aa000002', 'm-aa000003']) insert.run(id, `question ${id}`, id, NOW, NOW, NOW + 60_000);
    insert.run('m-aa000004', 'a later question', 'm-aa000004', NOW, NOW, NOW + 120_000);
    await mail.tick();
    for (const id of ['m-aa000001', 'm-aa000002', 'm-aa000003']) expect(mail.get(id)).toMatchObject({ relayedVia: 'turn' });
    // One turn for the three; a later turn's answer still goes back on its own.
    expect(turns('a').filter((t) => t.includes('8080 on tiles.local.'))).toHaveLength(2);
    expect(turns('a').filter((t) => t.includes('a later question'))).toHaveLength(1);
  });

  it('an answer the sender read with wait is not also relayed as a turn', async () => {
    const sent = mail.send({ from: 'loom:a', to: 'loom:b', text: 'port?' });
    const id = sent.ok ? sent.mail.id : '';
    await mail.tick();
    h.clock.now += 120_000;
    landTurns('b', 1);
    details.set('a', running('a'));
    const b = details.get('b')!;
    details.set('b', { ...b, updatedAt: iso(2), messages: [...b.messages, { id: 'a:b:2', role: 'assistant', text: '8080', createdAt: iso(2) }] });
    await poll();
    await mail.tick();
    expect(mail.get(id)).toMatchObject({ state: 'answered', relayedAt: null });
    expect(mail.claim(id)).toMatchObject({ relayedVia: 'wait' });
    details.set('a', thread('a', { title: 'Overview map' }));
    await poll();
    await mail.tick();
    expect(turns('a')).toHaveLength(0);
  });

  it('a relay that failed is retried as a new command, then given up on', async () => {
    const sent = mail.send({ from: 'loom:a', to: 'loom:b', text: 'port?' });
    const id = sent.ok ? sent.mail.id : '';
    await mail.tick();
    h.clock.now += 120_000;
    landTurns('b', 1);
    const b = details.get('b')!;
    details.set('b', { ...b, updatedAt: iso(2), messages: [...b.messages, { id: 'a:b:2', role: 'assistant', text: '8080', createdAt: iso(2) }] });
    await poll();
    const real = api.dispatch;
    let failing = true;
    api.dispatch = async (command) => {
      if (failing && command.threadId === 'a') throw new Error('Loom dispatch: HTTP 500');
      return real(command);
    };
    try {
      await mail.tick();
      expect(mail.get(id)).toMatchObject({ state: 'answered', relayedAt: null });
      failing = false;
      await mail.tick();
      expect(mail.get(id)).toMatchObject({ relayedVia: 'turn' });
      expect(turns('a')).toHaveLength(1);
    } finally {
      api.dispatch = real;
    }
  });

  it('a relay a restart cut off counts as relayed, not replayed forever', async () => {
    const sent = mail.send({ from: 'loom:a', to: 'loom:b', text: 'port?' });
    const id = sent.ok ? sent.mail.id : '';
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.core.store.db.prepare("UPDATE desk_mail SET state = 'answered', answer = '8080', sent_at = ? WHERE id = ?").run(NOW, id);
    h.core.store.insertCommand({ commandId: `mail-reply-${id}-0`, type: 'reply', itemId: 'loom:a' });
    await mail.tick();
    expect(mail.get(id)).toMatchObject({ relayedVia: 'turn' });
    expect(turns('a')).toHaveLength(0);
  });

  it('a shared-answer relay a restart cut off marks its siblings relayed too', async () => {
    const insert = h.core.store.db.prepare("INSERT INTO desk_mail (id, from_item, to_item, from_title, to_title, text, expect, state, chain, hops, urgent, created_at, sent_at, answer, answered_at) VALUES (?, 'loom:a', 'loom:b', 'A', 'B', 'q', 'reply', 'answered', ?, 1, 0, ?, ?, '8080', ?)");
    for (const id of ['m-bb000001', 'm-bb000002']) insert.run(id, id, NOW, NOW, NOW + 60_000);
    h.core.store.insertCommand({ commandId: 'mail-reply-m-bb000001-0', type: 'reply', itemId: 'loom:a' });
    await mail.tick();
    expect(mail.get('m-bb000001')).toMatchObject({ relayedVia: 'turn' });
    expect(mail.get('m-bb000002')).toMatchObject({ relayedVia: 'turn' });
    expect(turns('a')).toHaveLength(0);
  });

  it('an answer read with wait marks the mail sharing it read too', async () => {
    const insert = h.core.store.db.prepare("INSERT INTO desk_mail (id, from_item, to_item, from_title, to_title, text, expect, state, chain, hops, urgent, created_at, sent_at, answer, answered_at) VALUES (?, 'loom:a', 'loom:b', 'A', 'B', 'q', 'reply', 'answered', ?, 1, 0, ?, ?, '8080', ?)");
    for (const id of ['m-cc000001', 'm-cc000002']) insert.run(id, id, NOW, NOW, NOW + 60_000);
    expect(mail.claim('m-cc000001')).toMatchObject({ relayedVia: 'wait' });
    expect(mail.get('m-cc000002')).toMatchObject({ relayedVia: 'wait' });
    await mail.tick();
    expect(turns('a')).toHaveLength(0);
  });

  it('--now is only for mail needing no reply', () => {
    expect(mail.send({ from: 'loom:a', to: 'loom:b', text: 'port?', now: true })).toMatchObject({ ok: false, error: expect.stringContaining('only for mail that needs no reply') });
  });

  it('a historical project coordinator stays out of reach by id', () => {
    // Old coordinator records contain an unprefixed T3 id. Retirement must not reassign it to Loom.
    h.core.store.createItem({ id: 't3:historic', source: 't3', kind: 'thread', conversationKey: 't3:historic', agentId: 't3', agentName: 'Retired coordinator' });
    h.core.store.setSetting('coordinators', JSON.stringify({ maps: { projectId: 'maps', threadId: 'historic', createdAt: NOW, watch: {}, reach: 'approve', drafts: [], status: null, digests: [] } }));
    expect(mail.peek('t3:historic')).toBeNull();
    expect(mail.send({ from: 'loom:a', to: 't3:historic', text: 'hi' })).toMatchObject({ ok: false });
    expect(mail.send({ from: 't3:historic', to: 'loom:a', text: 'hi' })).toMatchObject({ ok: false });
  });

  it('--now goes into a running turn; --no-reply is done once delivered', async () => {
    details.set('b', running('b'));
    await poll();
    const sent = mail.send({ from: 'loom:a', to: 'loom:b', text: 'FYI: the API moved to v2.', expect: 'none', now: true });
    await mail.tick();
    expect(turns('b')).toHaveLength(1);
    expect(turns('b')[0]).toContain('No reply needed.');
    expect(mail.get(sent.ok ? sent.mail.id : '')!.state).toBe('done');
  });
});

describe('guardrails', () => {
  it('refuses mail to itself, to nothing, and empty mail', () => {
    expect(mail.send({ from: 'loom:a', to: 'loom:a', text: 'hi' })).toMatchObject({ ok: false });
    expect(mail.send({ from: 'loom:a', to: 'loom:zzz', text: 'hi' })).toMatchObject({ ok: false, error: expect.stringContaining('no conversation') });
    expect(mail.send({ from: 'loom:a', to: 'loom:b', text: '  ' })).toMatchObject({ ok: false });
  });

  it('a finished conversation needs wake; the owner can switch mail off for a conversation or its project', async () => {
    await h.core.command({ commandId: 'done-b', type: 'done', itemId: 'loom:b', actor: 'owner', args: { stopJob: false } });
    expect(mail.send({ from: 'loom:a', to: 'loom:b', text: 'hi' })).toMatchObject({ ok: false, error: expect.stringContaining('wake') });
    await h.core.command({ commandId: 'reopen-b', type: 'reopen', itemId: 'loom:b', actor: 'owner' });

    mail.setOff('loom:b', true);
    expect(mail.send({ from: 'loom:a', to: 'loom:b', text: 'hi' })).toMatchObject({ ok: false, error: expect.stringContaining('switched mail off') });
    mail.setOff('loom:b', false);
    h.core.store.setSetting('projects', JSON.stringify([{ id: 'maps', name: 'Maps', icon: null, color: null, createdAt: NOW }]));
    h.core.assignProject('loom:a', 'maps');
    mail.setOff('project:maps', true);
    expect(mail.send({ from: 'loom:a', to: 'loom:b', text: 'hi' })).toMatchObject({ ok: false, error: expect.stringContaining('this conversation') });
    expect(mail.threads().find((t) => t.id === 'loom:a')!.mail).toBe('off');
  });

  it('mail to a Discord conversation has to fit in one post', () => {
    h.core.store.createItem({ id: 'discord:watson', source: 'discord', kind: 'thread', conversationKey: 'thread:w', agentId: 'watson', agentName: 'Watson' });
    expect(mail.send({ from: 'loom:a', to: 'discord:watson', text: 'x'.repeat(DISCORD_TURN_MAX) })).toMatchObject({ ok: false, error: expect.stringContaining('Discord conversation') });
    const fits = mail.send({ from: 'loom:a', to: 'discord:watson', text: 'x'.repeat(1000) });
    expect(fits.ok).toBe(true);
    expect(mailTurn(fits.ok ? fits.mail : ({} as never)).length).toBeLessThanOrEqual(DISCORD_TURN_MAX);
  });

  it('queued mail is dropped if the owner switches mail off before it goes', async () => {
    details.set('b', running('b'));
    await poll();
    const sent = mail.send({ from: 'loom:a', to: 'loom:b', text: 'port?' });
    mail.setOff('loom:b', true);
    details.set('b', thread('b', { title: 'Tile server' }));
    await poll();
    await mail.tick();
    expect(turns('b')).toHaveLength(0);
    expect(mail.get(sent.ok ? sent.mail.id : '')!.state).toBe('dropped');
  });

  it('the chain is found however much the conversation said since its mail arrived', async () => {
    const first = mail.send({ from: 'loom:a', to: 'loom:b', text: 'start' });
    await mail.tick();
    landTurns('b', 1);
    const b = details.get('b')!;
    const chatter = Array.from({ length: 15 }, (_, i) => ({ id: `a:b:c${i}`, role: 'assistant' as const, text: `step ${i}`, createdAt: iso(2 + i / 100) }));
    details.set('b', { ...b, updatedAt: iso(3), messages: [...b.messages, ...chatter] });
    await poll();
    const second = mail.send({ from: 'loom:b', to: 'loom:a', text: 'and you?' });
    expect(second.ok && second.mail).toMatchObject({ chain: first.ok ? first.mail.id : '', hops: 2 });
  });

  it('a long answer still finds the mail it answers', async () => {
    const sent = mail.send({ from: 'loom:a', to: 'loom:b', text: 'walk me through it' });
    await mail.tick();
    h.clock.now += 120_000;
    landTurns('b', 1);
    await poll();
    const b = details.get('b')!;
    const run = Array.from({ length: 60 }, (_, i) => ({ id: `a:b:r${i}`, role: 'assistant' as const, text: `part ${i}`, createdAt: iso(2 + i / 100) }));
    details.set('b', { ...b, updatedAt: iso(3), messages: [...b.messages, ...run] });
    await poll();
    await mail.tick();
    expect(mail.get(sent.ok ? sent.mail.id : '')).toMatchObject({ state: 'answered', answer: 'part 59' });
  });

  it('queued mail to a conversation parked before it was free is dropped, not stuck', async () => {
    details.set('b', running('b'));
    await poll();
    const sent = mail.send({ from: 'loom:a', to: 'loom:b', text: 'port?' });
    await h.core.command({ commandId: 'park-b', type: 'park', itemId: 'loom:b', actor: 'owner' });
    await mail.tick();
    expect(mail.get(sent.ok ? sent.mail.id : '')).toMatchObject({ state: 'dropped', error: expect.stringContaining('parked') });
  });

  it('a send cut off before it reached the command layer goes back in the queue', async () => {
    details.set('b', running('b'));
    await poll();
    const sent = mail.send({ from: 'loom:a', to: 'loom:b', text: 'port?' });
    const id = sent.ok ? sent.mail.id : '';
    h.core.store.db.prepare("UPDATE desk_mail SET state = 'sending' WHERE id = ?").run(id);
    await mail.tick();
    expect(mail.get(id)!.state).toBe('queued');
    // One the restart interrupted inside the command layer may have gone through: counted as sent.
    h.core.store.db.prepare("UPDATE desk_mail SET state = 'sending' WHERE id = ?").run(id);
    h.core.store.insertCommand({ commandId: `mail-${id}`, type: 'reply', itemId: 'loom:b' });
    h.core.store.finishCommand(`mail-${id}`, 'failed', { error: 'interrupted' }, 'interrupted');
    await new Promise((resolve) => setTimeout(resolve, 0)); // the tick send() started is done
    await mail.tick();
    expect(mail.get(id)!.state).toBe('sent');
  });

  it('isolated agents are invisible and unreachable', () => {
    h.core.store.createItem({ id: 'discord:kid', source: 'discord', kind: 'thread', conversationKey: 'thread:kid', agentId: 'kilo', agentName: 'Kilo' });
    expect(mail.threads().map((t) => t.id)).not.toContain('discord:kid');
    expect(mail.peek('discord:kid')).toBeNull();
    expect(mail.send({ from: 'loom:a', to: 'discord:kid', text: 'hi' })).toMatchObject({ ok: false });
    expect(mail.send({ from: 'discord:kid', to: 'loom:a', text: 'hi' })).toMatchObject({ ok: false });
  });

  it.each([false, true])('holds a burst beyond six deliveries and charges held mail on delivery (own worker: %s)', async (ownWorker) => {
    if (ownWorker) h.core.roles.set('loom:b', { role: 'worker', parentItemId: 'loom:a' }, 'agent', NOW);
    const ids: string[] = [];
    for (let i = 0; i < PAIR_LIMIT * 2 + 1; i += 1) {
      const result = mail.send({ from: 'loom:a', to: 'loom:b', text: `ping ${i}`, expect: 'none', now: true });
      expect(result.ok).toBe(true);
      if (result.ok) {
        ids.push(result.mail.id);
        if (i >= PAIR_LIMIT) expect(result.mail.heldUntil).toBeGreaterThan(h.clock.now);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    await mail.tick();
    expect(turns('b')).toHaveLength(PAIR_LIMIT);
    expect(mail.view(mail.get(ids[6]!)!)).toMatchObject({ state: 'queued', heldUntil: new Date(NOW + 3_600_000).toISOString() });
    // Reopening the queue after a service restart preserves both budget and order.
    mail = new DeskMail({ core: h.core, db: h.core.store.db, blockedAgents: ['kilo'], now: () => h.clock.now });
    h.clock.now += 3_599_999;
    await mail.tick();
    expect(turns('b')).toHaveLength(PAIR_LIMIT);
    h.clock.now += 1;
    await mail.tick();
    expect(turns('b')).toHaveLength(PAIR_LIMIT * 2);
    expect(mail.get(ids[6]!)!.sentAt).toBe(h.clock.now);
    expect(mail.get(ids[12]!)!.state).toBe('queued');
    h.clock.now += 3_600_000;
    await mail.tick();
    expect(turns('b')).toHaveLength(PAIR_LIMIT * 2 + 1);
  });

  it.each([['a', 'b'], ['b', 'a']])('exempts own-worker coordination %s → %s without spending later peer hops', async (from, to) => {
    h.core.roles.set('loom:b', { role: 'worker', parentItemId: 'loom:a' }, 'agent', NOW);
    const first = mail.send({ from: `loom:${to}`, to: `loom:${from}`, text: 'deep incoming' });
    if (!first.ok) throw new Error(first.error);
    h.core.store.db.prepare('UPDATE desk_mail SET hops = ? WHERE id = ?').run(DEPTH_NOTICE_HOPS, first.mail.id);
    h.core.recordMessage(`loom:${from}`, { messageId: 'deep-mail', author: 'owner', at: NOW + 1, text: mailTurn(first.mail) });
    const next = mail.send({ from: `loom:${from}`, to: `loom:${to}`, text: 'coordination' });
    expect(next.ok && next.mail).toMatchObject({ hops: 0 });
    if (!next.ok) throw new Error(next.error);
    expect(next.mail.chain).toBe(next.mail.id);
    h.core.recordMessage(`loom:${to}`, { messageId: 'coordination-mail', author: 'owner', at: NOW + 2, text: mailTurn(next.mail) });
    h.core.store.createItem({ id: 'loom:peer', source: 'loom', kind: 'thread', conversationKey: 'peer', agentId: 'peer', agentName: 'Peer' });
    const peer = mail.send({ from: `loom:${to}`, to: 'loom:peer', text: 'peer question' });
    expect(peer.ok && peer.mail.hops).toBe(1);
    h.core.store.db.prepare('UPDATE desk_mail SET hops = ? WHERE id = ?').run(DEPTH_NOTICE_HOPS, next.mail.id);
    expect(mail.send({ from: `loom:${to}`, to: 'loom:peer', text: 'deep peer question' })).toMatchObject({ ok: true, mail: { hops: DEPTH_NOTICE_HOPS + 1 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('delivers peers past eight hops and posts one durable notice per chain', async () => {
    const feed = vi.spyOn(h.core, 'postFeed');
    let previous = mail.send({ from: 'loom:a', to: 'loom:b', text: 'start' });
    if (!previous.ok) throw new Error(previous.error);
    const chain = previous.mail.chain;
    for (let hop = 2; hop <= 11; hop += 1) {
      const from = hop % 2 === 0 ? 'b' : 'a';
      const to = from === 'a' ? 'b' : 'a';
      h.clock.now += 3_600_001; // Leave delivery throughput limits unchanged.
      h.core.recordMessage(`loom:${from}`, { messageId: `round-${hop}`, author: 'owner', at: h.clock.now, text: mailTurn(previous.mail) });
      previous = mail.send({ from: `loom:${from}`, to: `loom:${to}`, text: `round ${hop}` });
      expect(previous).toMatchObject({ ok: true, mail: { chain, hops: hop } });
      if (!previous.ok) throw new Error(previous.error);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await mail.tick();
      expect(turns(to).join('')).toContain(`round ${hop}`);
      if (hop === 9) mail = new DeskMail({ core: h.core, db: h.core.store.db, now: () => h.clock.now });
    }
    expect(feed.mock.calls.filter(([post]) => post.title === 'Long mail exchange')).toHaveLength(1);
    h.core.recordMessage('loom:a', { messageId: 'owner-reset', author: 'owner', at: ++h.clock.now, text: 'Continue with the task' });
    const reset = mail.send({ from: 'loom:a', to: 'loom:b', text: 'new exchange' });
    expect(reset).toMatchObject({ ok: true, mail: { hops: 1 } });
    if (reset.ok) expect(reset.mail.chain).not.toBe(chain);
  });

  it('no-reply reports and direct replies preserve depth', () => {
    const first = mail.send({ from: 'loom:a', to: 'loom:b', text: 'question' });
    if (!first.ok) throw new Error(first.error);
    h.core.recordMessage('loom:b', { messageId: 'question', author: 'owner', at: NOW + 1, text: mailTurn(first.mail) });
    const report = mail.send({ from: 'loom:b', to: 'loom:a', text: 'progress', expect: 'none' });
    expect(report).toMatchObject({ ok: true, mail: { chain: first.mail.chain, hops: 1 } });
    if (!report.ok) throw new Error(report.error);
    h.core.recordMessage('loom:a', { messageId: 'progress', author: 'owner', at: NOW + 2, text: mailTurn(report.mail) });
    const reply = mail.send({ from: 'loom:a', to: 'loom:b', text: 'follow-up' });
    expect(reply).toMatchObject({ ok: true, mail: { chain: first.mail.chain, hops: 1 } });
    if (!reply.ok) throw new Error(reply.error);
    h.core.recordMessage('loom:b', { messageId: 'follow-up', author: 'owner', at: NOW + 3, text: mailTurn(reply.mail) });
    expect(mail.send({ from: 'loom:b', to: 'loom:a', text: 'next question' })).toMatchObject({ ok: true, mail: { hops: 2 } });
  });

  it('a successful wake exempts both directions across restart without role facts', async () => {
    await h.core.command({ commandId: 'park', type: 'park', itemId: 'loom:b', actor: 'owner' });
    expect(mail.send({ from: 'loom:a', to: 'loom:b', text: 'resume', wake: true })).toMatchObject({ ok: true, mail: { hops: 0 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    mail = new DeskMail({ core: h.core, db: h.core.store.db, now: () => h.clock.now });
    expect(mail.send({ from: 'loom:b', to: 'loom:a', text: 'report' })).toMatchObject({ ok: true, mail: { hops: 0 } });
    expect(mail.send({ from: 'loom:a', to: 'loom:b', text: 'next task' })).toMatchObject({ ok: true, mail: { hops: 0 } });
  });

  it('a wake flag on an active peer does not invent a relationship', () => {
    expect(mail.send({ from: 'loom:a', to: 'loom:b', text: 'hello', wake: true })).toMatchObject({ ok: true, mail: { hops: 1 } });
    expect(mail.send({ from: 'loom:b', to: 'loom:a', text: 'hello again' })).toMatchObject({ ok: true, mail: { hops: 1 } });
  });

});

describe('the sender hears about mail the desk holds or gives up on', () => {
  const asking = (id: string): TestThread => ({ ...details.get(id)!, status: 'waiting',
    questions: [{ id: 'q', header: 'Upload', question: 'Upload it as private?', options: [{ label: 'Yes' }, { label: 'No' }] }],
  });
  const notices = (id: string) => dispatched.filter((c) => c.threadId === id && c.text).map((c) => String(c.text)).filter((t) => t.includes('(The desk, not'));

  it('retains mail and superseding messages behind an owner question until answered', async () => {
    details.set('b', asking('b'));
    await poll();
    const ids = ['first', 'second', 'third'].map((text) => {
      const sent = mail.send({ from: 'loom:a', to: 'loom:b', text });
      return sent.ok ? sent.mail.id : '';
    });
    await mail.tick();
    expect(notices('a')).toHaveLength(0);

    h.clock.now += HELD_NOTICE_MS;
    await mail.tick();
    expect(notices('a')).toHaveLength(1);
    const held = notices('a')[0]!;
    expect(parseMailHeader(held)).toMatchObject({ kind: 'reply', itemId: 'loom:b' });
    expect(held).toContain('3 mails');
    expect(held).toContain('Upload it as private?');
    expect(held).toContain('keeps this mail until the owner answers');
    expect(held).not.toContain('drops queued mail');
    for (const id of ids) expect(mail.get(id)).toMatchObject({ state: 'queued', notice: null, noticed: ['held'] });

    // Told once, however long it stays held.
    landTurns('a', 1);
    await poll();
    h.clock.now += 3_600_000;
    await mail.tick();
    expect(notices('a')).toHaveLength(1);

    // The later correction is mail too: neither it nor the originals expire behind the question.
    const followup = mail.send({ from: 'loom:a', to: 'loom:b', text: 'Supersedes the earlier plan: upload is already done.' });
    ids.push(followup.ok ? followup.mail.id : '');
    h.clock.now += 3 * 86_400_000;
    await mail.tick();
    for (const id of ids) expect(mail.get(id)).toMatchObject({ state: 'queued' });
    expect(turns('b')).toHaveLength(0);
    expect(h.core.item('loom:b')!.facts.pending).toBeTruthy();

    // A restart retains the pause. The owner's answer resumes work before the next idle turn.
    mail = new DeskMail({ core: h.core, db: h.core.store.db, now: () => h.clock.now });
    details.set('b', thread('b', { status: 'running' }));
    await poll();
    await mail.tick();
    for (const id of ids) expect(mail.get(id)!.state).toBe('queued');
    h.clock.now += 60_000;
    details.set('b', thread('b'));
    await poll();
    await mail.tick();
    for (const id of ids) expect(mail.get(id)!.state).toBe('sent');
    expect(turns('b')).toHaveLength(4);
    expect(dispatched.every((c) => c.type === 'submit')).toBe(true);
  });

  it('pauses expiry beyond two days for an owner request, but still expires ordinary busy mail', async () => {
    details.set('b', asking('b'));
    await poll();
    const sent = mail.send({ from: 'loom:a', to: 'loom:b', text: 'Keep until answered' });
    await mail.tick();
    h.clock.now += 3 * 86_400_000;
    await mail.tick();
    expect(mail.get(sent.ok ? sent.mail.id : '')!.state).toBe('queued');
    details.set('b', thread('b', { status: 'running' }));
    await poll();
    await mail.tick();
    h.clock.now += 2 * 86_400_000 + 1;
    await mail.tick();
    expect(mail.get(sent.ok ? sent.mail.id : '')!.state).toBe('dropped');
  });

  it('urgent mail cannot answer a pending owner approval through the reply fallback', async () => {
    h.core.setFacts('loom:b', { pending: { kind: 'approval', requestId: 'approval-1', at: NOW, question: 'Proceed?' } });
    const sent = mail.send({ from: 'loom:a', to: 'loom:b', text: 'Approved elsewhere', now: true, expect: 'none' });
    await mail.tick();
    expect(turns('b')).toHaveLength(0);
    expect(mail.get(sent.ok ? sent.mail.id : '')!.state).toBe('queued');
    expect(h.core.item('loom:b')!.facts.pending?.requestId).toBe('approval-1');
  });

  it('aged mail reaches a Loom owner wait as peer words without answering its question', async () => {
    details.set('b', asking('b'));
    await poll();
    const sent = mail.send({ from: 'loom:a', to: 'loom:b', text: 'The earlier work is complete.' });
    await mail.tick();
    h.clock.now += 3 * 86_400_000;
    mail = new DeskMail({ core: h.core, db: h.core.store.db, now: () => h.clock.now,
      steer: (item, text, origin, commandId) => source.steer(item, text, origin, commandId) });
    const pending = h.core.item('loom:b')!.facts.pending;
    await mail.tick();
    expect(mail.get(sent.ok ? sent.mail.id : '')!.state).toBe('sent');
    expect(dispatched.filter((c) => c.threadId === 'b')).toEqual([expect.objectContaining({
      type: 'submit', steer: true, origin: expect.objectContaining({ kind: 'peer', from: 'loom:a' }),
    })]);
    expect(h.core.item('loom:b')!.facts.pending).toEqual(pending);
  });

  it('mail that goes out in the tick it would have been held says nothing about being held', async () => {
    details.set('b', running('b'));
    await poll();
    const sent = mail.send({ from: 'loom:a', to: 'loom:b', text: 'Which port?' });
    await mail.tick();
    details.set('b', thread('b', { title: 'Tile server' }));
    await poll();
    h.clock.now += HELD_NOTICE_MS;
    await mail.tick();
    expect(mail.get(sent.ok ? sent.mail.id : '')).toMatchObject({ state: 'sent', notice: null });
    expect(notices('a')).toHaveLength(0);
  });

  it('mail dropped because the recipient switched mail off tells the sender', async () => {
    details.set('b', running('b'));
    await poll();
    const sent = mail.send({ from: 'loom:a', to: 'loom:b', text: 'Which port?' });
    mail.setOff('loom:b', true);
    details.set('b', thread('b', { title: 'Tile server' }));
    await poll();
    await mail.tick();
    // The notice goes out from whichever tick gets there first (the send's own may still be confirming it).
    for (let i = 0; i < 10 && !notices('a').length; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(mail.get(sent.ok ? sent.mail.id : '')!.state).toBe('dropped');
    expect(notices('a')).toHaveLength(1);
    expect(notices('a')[0]).toContain('no longer allowed');
  });

  it('a desk notice is not an answer boundary, nor a link in the mail chain', () => {
    const incoming = mailTurn({ id: 'm-in000001', fromItemId: 'loom:c', fromTitle: 'C', text: 'status?', expect: 'reply' });
    const notice = noticeTurn([{ id: 'm-out00001', toItemId: 'loom:b', createdAt: NOW, text: 'port?' } as never], 'held', 'it is busy', 'B');
    expect(isDeskNotice(notice)).toBe(true);
    expect(isDeskNotice(incoming)).toBe(false);
    const messages = [
      { author: 'owner', at: NOW + 1_000, text: incoming },
      { author: 'owner', at: NOW + 1_001, text: notice },
      { author: 'agent', at: NOW + 3_000, text: 'All green.' },
    ];
    expect(mailAnswer(messages, 'm-in000001', NOW)).toEqual({ text: 'All green.', at: NOW + 3_000 });
  });

  it('mail given up on for different reasons says each one', () => {
    const rows = [
      { id: 'm-dd000001', toItemId: 'loom:b', createdAt: NOW, text: 'one', error: 'that conversation was never free for it' },
      { id: 'm-dd000002', toItemId: 'loom:b', createdAt: NOW, text: 'two', error: 'mail between these conversations is no longer allowed' },
    ] as never[];
    const turn = noticeTurn(rows, 'dropped', 'ignored', 'B');
    expect(turn).toContain('each for the reason given below');
    expect(turn).toContain('one” — that conversation was never free for it');
    expect(turn).toContain('two” — mail between these conversations is no longer allowed');
  });

  it('a notice recovered after a restart settles only the mail it covered', async () => {
    const insert = h.core.store.db.prepare("INSERT INTO desk_mail (id, from_item, to_item, from_title, to_title, text, expect, state, chain, hops, urgent, created_at, error, notice, notice_at) VALUES (?, 'loom:a', 'loom:b', 'A', 'B', 'q', 'reply', 'dropped', ?, 1, 0, ?, 'gone', 'dropped', ?)");
    insert.run('m-ee000001', 'm-ee000001', NOW, NOW);
    h.core.store.insertCommand({ commandId: 'mail-notice-m-ee000001-dropped-0', type: 'reply', itemId: 'loom:a' });
    // Owed after that command was sent: not covered by it.
    insert.run('m-ee000002', 'm-ee000002', NOW, h.clock.now + 60_000);
    await mail.tick();
    expect(mail.get('m-ee000001')).toMatchObject({ notice: null, noticed: ['dropped'] });
    expect(mail.get('m-ee000002')!.noticed).toEqual([]);
  });

  it('a notice to a Discord sender fits one post, counting what it leaves out', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `m-${String(i).padStart(8, '0')}`, toItemId: 'loom:b', createdAt: NOW, text: 'x'.repeat(200) }) as never);
    const turn = noticeTurn(many, 'held', 'it has a question waiting', 'Tile server', DISCORD_TURN_MAX);
    expect(turn.length).toBeLessThanOrEqual(DISCORD_TURN_MAX);
    expect(turn).toMatch(/- and \d+ more/);
    expect(noticeTurn(many, 'held', 'r', 'Tile server')).not.toContain('more');
  });

  it('delivered mail that never gets an answer: the sender hears the desk stopped waiting', async () => {
    const sent = mail.send({ from: 'loom:a', to: 'loom:b', text: 'Which port?' });
    const id = sent.ok ? sent.mail.id : '';
    await mail.tick();
    expect(mail.get(id)!.state).toBe('sent');
    h.clock.now += 2 * 86_400_000 + 60_000;
    await mail.tick();
    expect(mail.get(id)).toMatchObject({ state: 'unanswered', noticed: ['unanswered'] });
    expect(notices('a')).toHaveLength(1);
    expect(notices('a')[0]).toContain('got no answer');
  });

  it('a finished sender is not told; mail that ended before notices existed says nothing', async () => {
    h.core.store.db.prepare("INSERT INTO desk_mail (id, from_item, to_item, from_title, to_title, text, expect, state, chain, hops, urgent, created_at) VALUES ('m-old', 'loom:a', 'loom:b', 'A', 'B', 'old', 'reply', 'dropped', 'm-old', 1, 0, ?)").run(h.clock.now - 5 * 86_400_000);
    await mail.tick();
    expect(notices('a')).toHaveLength(0);

    details.set('b', asking('b'));
    await poll();
    const sent = mail.send({ from: 'loom:a', to: 'loom:b', text: 'still there?' });
    await h.core.command({ commandId: 'finish-a', type: 'done', itemId: 'loom:a', actor: 'owner' });
    h.clock.now += HELD_NOTICE_MS;
    await mail.tick();
    expect(notices('a')).toHaveLength(0);
    expect(mail.get(sent.ok ? sent.mail.id : '')).toMatchObject({ notice: null, noticed: ['held'] });
  });
});

describe('reading', () => {
  it('threads lists conversations with their status; peek reads one', async () => {
    details.set('b', running('b'));
    await poll();
    const threads = mail.threads();
    expect(threads.find((t) => t.id === 'loom:b')).toMatchObject({ status: 'working', idle: false, title: expect.any(String) });
    expect(mail.threads({ status: 'working' }).map((t) => t.id)).toEqual(['loom:b']);
    const peek = mail.peek('loom:a', 5)!;
    expect(peek.messages.map((m) => m.text)).toContain('The overview map is up.');
  });
});

describe('starting threads', () => {
  let starts: Array<Record<string, unknown>>;
  let n: number;
  beforeEach(() => {
    starts = [];
    n = 0;
    mail = new DeskMail({
      core: h.core,
      db: h.core.store.db,
      blockedAgents: ['kilo'],
      now: () => h.clock.now,
      startWork: {
        start: async (request) => {
          starts.push(request as Record<string, unknown>);
          n += 1;
          const id = `new${n}`;
          details.set(id, thread(id, { title: request.title ?? id, messages: [{ id: `u:${id}:1`, role: 'user', text: request.prompt!, createdAt: new Date(h.clock.now).toISOString() }], status: 'running' }));
          return { ok: true, threadId: id, itemId: `loom:${id}`, plan: {} as never };
        },
      },
    });
  });

  it('starts a thread in the starter’s repo on Loom, headed as mail from it, and brings its first answer back', async () => {
    const result = await mail.start({ from: 'loom:a', prompt: 'Build the card back art pipeline.\nUse the existing palette.' });
    expect(result.ok && result.itemId).toBe('loom:new1');
    expect(starts[0]).toMatchObject({ repo: 'tango', account: 'loom', title: 'Build the card back art pipeline.' });
    expect(parseMailHeader(String(starts[0]!.prompt))).toMatchObject({ kind: 'from', itemId: 'loom:a', body: 'Build the card back art pipeline.\nUse the existing palette.' });
    // The starter keeps a note of it.
    expect(parseMailHeader(h.core.store.messages('loom:a').at(-1)!.text)).toMatchObject({ kind: 'started', itemId: 'loom:new1' });

    // The new thread finishes its first turn: the answer goes back to the starter.
    await poll();
    h.clock.now += 120_000;
    const t = details.get('new1')!;
    details.set('new1', { ...t, status: 'idle', updatedAt: iso(2), messages: [...t.messages, { id: 'a:new1:1', role: 'assistant', text: 'Pipeline is in tools/art; 12 card backs rendered.', createdAt: iso(2) }] });
    await poll();
    await mail.tick();
    expect(turns('a')).toHaveLength(1);
    expect(parseMailHeader(turns('a')[0]!)).toMatchObject({ kind: 'reply', itemId: 'loom:new1', body: 'Pipeline is in tools/art; 12 card backs rendered.' });
  });

  it('a start retried after a timeout, filed minutes after its opening turn landed, still brings the answer back', async () => {
    const slow = new DeskMail({
      core: h.core,
      db: h.core.store.db,
      now: () => h.clock.now,
      startWork: {
        start: async (request) => {
          // A retry of a start that timed out: the thread and its opening turn were filed minutes before this call.
          details.set('slow', thread('slow', { title: 'Slow start', messages: [{ id: 'u:slow:1', role: 'user', text: request.prompt!, createdAt: new Date(h.clock.now - 150_000).toISOString() }], status: 'running' }));
          await poll();
          return { ok: true, threadId: 'slow', itemId: 'loom:slow', plan: {} as never };
        },
      },
    });
    const result = await slow.start({ from: 'loom:a', prompt: 'Live-test the voice commands.' });
    expect(result.ok).toBe(true);
    h.clock.now += 120_000;
    const t = details.get('slow')!;
    details.set('slow', { ...t, status: 'idle', updatedAt: new Date(h.clock.now).toISOString(), messages: [...t.messages, { id: 'a:slow:1', role: 'assistant', text: '16/16 pass.', createdAt: new Date(h.clock.now).toISOString() }] });
    await poll();
    await slow.tick();
    expect(parseMailHeader(turns('a').at(-1)!)).toMatchObject({ kind: 'reply', itemId: 'loom:slow', body: '16/16 pass.' });
  });

  it('a started thread is a worker under its starter, unless started as something else; the owner can change it', async () => {
    await mail.start({ from: 'loom:a', prompt: 'Run playtest round 7' });
    await mail.start({ from: 'loom:a', prompt: 'Watch Acme feedback daily', role: 'ops' });
    await poll();
    expect(h.core.item('loom:new1')!.facts).toMatchObject({ role: 'worker', parentItemId: 'loom:a' });
    expect(h.core.item('loom:new2')!.facts).toMatchObject({ role: 'ops', parentItemId: 'loom:a' });
    expect(h.core.item('loom:a')!.facts.role).toBeUndefined();

    const changed = await h.core.command({ commandId: 'r1', type: 'role', itemId: 'loom:new1', args: { role: 'interactive', parentItemId: null } });
    expect(changed).toMatchObject({ status: 'applied', outcome: { role: 'interactive', parentItemId: null } });
    expect(h.core.items().find((i) => i.id === 'loom:new1')!.facts).toMatchObject({ role: 'interactive', parentItemId: null });
    expect(await h.core.command({ commandId: 'r2', type: 'role', itemId: 'loom:new1', args: { role: 'boss' } })).toMatchObject({ status: 'failed' });
  });

  it('recorded starts exempt both directions even without worker role facts', async () => {
    await mail.start({ from: 'loom:a', prompt: 'Build the map', role: 'interactive' });
    await poll();
    h.core.roles.set('loom:new1', { role: 'interactive', parentItemId: null }, 'owner', NOW);
    mail = new DeskMail({ core: h.core, db: h.core.store.db, now: () => h.clock.now });
    expect(mail.send({ from: 'loom:a', to: 'loom:new1', text: 'next step' })).toMatchObject({ ok: true, mail: { hops: 0 } });
    expect(mail.send({ from: 'loom:new1', to: 'loom:a', text: 'complete' })).toMatchObject({ ok: true, mail: { hops: 0 } });
  });

  it('a retried start (same commandId) returns the same thread and record', async () => {
    const first = await mail.start({ from: 'loom:a', prompt: 'job', commandId: 'c-1' });
    const again = await mail.start({ from: 'loom:a', prompt: 'job', commandId: 'c-1' });
    expect(again.ok && again.mail.id).toBe(first.ok ? first.mail.id : 'x');
    expect(again.ok && again.itemId).toBe('loom:new1');
    expect(starts).toHaveLength(1);
    expect(h.core.store.db.prepare("SELECT COUNT(*) AS n FROM desk_mail WHERE kind = 'start'").get()).toEqual({ n: 1 });
  });

  it('parallel starts can’t slip past the hourly limit', async () => {
    const results = await Promise.all(Array.from({ length: START_LIMIT + 3 }, (_, i) => mail.start({ from: 'loom:a', prompt: `job ${i}` })));
    expect(results.filter((r) => r.ok)).toHaveLength(START_LIMIT);
    expect(starts).toHaveLength(START_LIMIT);
  });

  it('joins the starter’s desk project unless told otherwise', async () => {
    h.core.store.setSetting('projects', JSON.stringify([{ id: 'cards', name: 'Board game', icon: null, color: null, createdAt: NOW }]));
    h.core.assignProject('loom:a', 'cards');
    await mail.start({ from: 'loom:a', prompt: 'one' });
    await mail.start({ from: 'loom:a', prompt: 'two', projectId: null });
    await poll();
    expect(h.core.item('loom:new1')!.facts.projectId).toBe('cards');
    expect(h.core.item('loom:new2')!.facts.projectId ?? null).toBeNull();
  });

  it('limits how many threads a conversation starts, and how deep starts go', async () => {
    for (let i = 0; i < START_LIMIT; i += 1) expect((await mail.start({ from: 'loom:a', prompt: `job ${i}` })).ok).toBe(true);
    expect(await mail.start({ from: 'loom:a', prompt: 'one more' })).toMatchObject({ ok: false, error: expect.stringContaining('this hour') });
    // new1 started new6, which started new7…: a chain stops at MAX_START_DEPTH.
    await poll();
    let at = 'loom:new1';
    for (let depth = 1; depth < MAX_START_DEPTH; depth += 1) {
      const next = await mail.start({ from: at, prompt: `deeper ${depth}` });
      expect(next.ok).toBe(true);
      await poll();
      at = next.itemId!;
    }
    expect(await mail.start({ from: at, prompt: 'too deep' })).toMatchObject({ ok: false, error: expect.stringContaining('starts deep') });
  });

  it('isolated agents and switched-off conversations can’t start threads; a Discord agent must name the repo', async () => {
    h.core.store.createItem({ id: 'discord:kid', source: 'discord', kind: 'thread', conversationKey: 'thread:kid', agentId: 'kilo', agentName: 'Kilo' });
    expect(await mail.start({ from: 'discord:kid', prompt: 'x', repo: 'tango' })).toMatchObject({ ok: false });
    mail.setOff('loom:a', true);
    expect(await mail.start({ from: 'loom:a', prompt: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('switched') });
    h.core.store.createItem({ id: 'discord:w', source: 'discord', kind: 'thread', conversationKey: 'thread:w', agentId: 'watson', agentName: 'Watson' });
    expect(await mail.start({ from: 'discord:w', prompt: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('which repo') });
    expect((await mail.start({ from: 'discord:w', prompt: 'x', repo: 'tango' })).ok).toBe(true);
    expect(starts.at(-1)).toMatchObject({ repo: 'tango' });
  });
});

describe('a worker reports up', () => {
  /** b works for a: its latest turn is over and summarized. */
  function finished(step: 'your_move' | 'fyi' | 'watching' = 'your_move', waitingOn: Record<string, unknown> | null = null) {
    h.core.store.setSetting('report_up_since', '0');
    h.core.roles.set('loom:b', { role: 'worker', parentItemId: 'loom:a' }, 'agent', NOW);
    const b = h.core.item('loom:b')!;
    h.core.store.patchItem('loom:b', { nextStep: step, summary: { ...(b.summary ?? {}), gist: 'Map done', waitingOn, contentKey: b.facts.contentKey } } as never);
  }

  it('passes a turn nobody asked for by mail up to what it reports to, once, as its own to speak for', async () => {
    finished();
    await mail.tick();
    const report = mail.forItem('loom:b').find((m) => m.kind === 'report');
    expect(report).toMatchObject({ fromItemId: 'loom:a', toItemId: 'loom:b', answer: 'The overview map is up.' });
    expect(turns('a').at(-1)).toContain('The overview map is up.');
    expect(turns('a').at(-1)).toContain('you speak for it');
    expect(parseMailHeader(turns('a').at(-1)!)).toMatchObject({ kind: 'reply', itemId: 'loom:b' });
    await mail.tick();
    expect(mail.forItem('loom:b').filter((m) => m.kind === 'report')).toHaveLength(1);
  });

  it('reports a recorded ask up: it reads Waiting on its lead, which is what reporting up is for', async () => {
    finished();
    h.core.setFacts('loom:b', { openAsk: { text: 'Which map style?', at: NOW } });
    expect(h.core.item('loom:b')).toMatchObject({ status: { pill: 'waiting', basis: 'source:lead-request' } });
    await mail.tick();
    expect(mail.forItem('loom:b').some((m) => m.kind === 'report')).toBe(true);
  });

  it('waits while it works on its own, and sends nothing for a turn a mail answer already took back', async () => {
    finished('watching', { who: 'CI', what: 'checks', kind: 'agent' });
    h.core.setFacts('loom:b', { background: 'monitoring', waits: [{ id: 'w', kind: 'pr', target: 'CI checks', armedAt: NOW, lastCheckedAt: NOW }] });
    expect(h.core.item('loom:b')).toMatchObject({ status: { pill: 'waiting', countsForOwner: false } });
    await mail.tick();
    expect(mail.forItem('loom:b').some((m) => m.kind === 'report')).toBe(false);
    finished('fyi');
    h.core.setFacts('loom:b', { background: null, waits: null });
    h.core.store.db.prepare("INSERT INTO desk_mail (id, from_item, to_item, from_title, to_title, text, expect, state, chain, hops, urgent, created_at, answer, answered_at, relayed_at) VALUES ('m-old', 'loom:a', 'loom:b', 'A', 'B', 'q', 'reply', 'answered', 'm-old', 1, 0, ?, 'The overview map is up.', ?, ?)").run(NOW, NOW, NOW);
    await mail.tick();
    expect(mail.forItem('loom:b').some((m) => m.kind === 'report')).toBe(false);
    expect(h.core.item('loom:b')!.facts.reportedUpId).toBeTruthy();
  });

  it('reports a final turn even when the worker settled right after it, with every piece of a split answer', async () => {
    finished();
    const long = 'x'.repeat(1_600);
    h.core.recordMessage('loom:b', { messageId: 'b-part1', author: 'agent', at: NOW + 1_000, text: `Options: ${long}` });
    h.core.recordMessage('loom:b', { messageId: 'b-part2', author: 'agent', at: NOW + 2_000, text: 'Pick A, B or C.' });
    await h.core.command({ commandId: 'done-b', type: 'done', itemId: 'loom:b', actor: 'agent' });
    expect(h.core.item('loom:b')!.disposition).toBe('done');
    await mail.tick();
    const report = mail.forItem('loom:b').find((m) => m.kind === 'report');
    expect(report?.answer).toContain('Options: x');
    expect(report?.answer).toContain('Pick A, B or C.');
    expect(report?.answer).not.toContain('The overview map is up.');
  });

  it('a worker’s answer to its owner’s mail asks the owner conversation to speak for it too', () => {
    const record = { id: 'm-1', toItemId: 'loom:b', toTitle: 'B', text: 'q', answer: 'Three options are ready.' };
    expect(replyTurn(record)).toContain('Don’t tell the owner about this exchange separately');
    expect(replyTurn(record, { reportsUp: true })).toContain('never send the owner to it');
  });
});

describe('recorded worker failures', () => {
  /** A lead on Discord: Loom wakes a Loom lead itself, so the desk reports only up a chain that leaves Loom. */
  async function discordLead(): Promise<string> {
    h.discord.push(AGENT.homeChannelId, msg(-2, 'agent', 'Kicked off the map build on Loom.'));
    await h.source.poll();
    return h.core.items().find((item) => item.source === 'discord')!.id;
  }
  const toLead = (text: string) => h.posted.filter((body) => String((body.data as { text?: string } | undefined)?.text ?? '').includes(text));

  it('leaves an all-Loom chain to Loom, which wakes its lead itself', async () => {
    h.core.roles.set('loom:b', { role: 'worker', parentItemId: 'loom:a' }, 'agent', NOW);
    h.core.setFacts('loom:b', { failed: { at: NOW, reason: 'other', message: 'build crashed', turnId: 'failed-run' } });
    await mail.tick();
    expect(turns('a').some((text) => text.includes('build crashed'))).toBe(false);
    expect(mail.forItem('loom:a').some((m) => m.text.includes('build crashed'))).toBe(false);
  });
  it('wakes a live lead once without an assistant message or summary', async () => {
    const lead = await discordLead();
    h.core.roles.set('loom:b', { role: 'worker', parentItemId: lead }, 'agent', NOW);
    h.core.store.patchItem('loom:b', { lastAgentMessageId: null, summary: null });
    h.core.setFacts('loom:b', { failed: { at: NOW, reason: 'other', message: 'build crashed', turnId: 'failed-run' } });
    await mail.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(toLead('build crashed')).toHaveLength(1);
    await mail.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(toLead('build crashed')).toHaveLength(1);
    expect(h.core.item('loom:b')!.facts.failed?.message).toBe('build crashed');
  });
  it('sends a failure report again when its mail was not delivered', async () => {
    const lead = await discordLead();
    h.botResult.value = 'failed:bot HTTP 500';
    h.core.roles.set('loom:b', { role: 'worker', parentItemId: lead }, 'agent', NOW);
    h.core.setFacts('loom:b', { failed: { at: NOW, reason: 'other', message: 'build crashed', turnId: 'failed-run' } });
    await mail.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mail.forItem(lead).find((m) => m.text.includes('build crashed'))?.state).toBe('failed');
    h.botResult.value = 'agent';
    const before = toLead('build crashed').length;
    await mail.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(toLead('build crashed')).toHaveLength(before + 1);
    expect(mail.forItem(lead).filter((m) => m.text.includes('build crashed')).map((m) => m.state)).toContain('done');
  });
  it('goes past a worker in between to the lead that speaks to the owner', async () => {
    const lead = await discordLead();
    details.set('c', thread('c', { title: 'Tile tests' }));
    await poll();
    h.core.roles.set('loom:b', { role: 'worker', parentItemId: lead }, 'agent', NOW);
    h.core.roles.set('loom:c', { role: 'worker', parentItemId: 'loom:b' }, 'agent', NOW);
    h.core.setFacts('loom:c', { failed: { at: NOW, reason: 'other', message: 'tests crashed', turnId: 'failed-run' } });
    await mail.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(toLead('tests crashed')).toHaveLength(1);
    expect(turns('b').some(text => text.includes('tests crashed'))).toBe(false);
  });
  it('leaves a failure with the owner when the lead is gone', async () => {
    const lead = await discordLead();
    h.core.roles.set('loom:b', { role: 'worker', parentItemId: lead }, 'agent', NOW);
    h.core.setFacts(lead, { stoppedAtSource: true });
    h.core.setFacts('loom:b', { failed: { at: NOW, reason: 'other', message: 'build crashed', turnId: 'failed-run' } });
    await mail.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(toLead('build crashed')).toHaveLength(0);
    expect(h.core.item('loom:b')!.facts.failed?.message).toBe('build crashed');
  });
});



describe('space default mail approval', () => {
  function lead(free?: boolean) {
    h.core.store.setSetting('projects', JSON.stringify([{ id: 'p-tango', name: 'Tango', icon: null, color: null, createdAt: NOW }]));
    h.core.setFacts('loom:a', { projectId: 'p-tango' });
    h.core.setFacts('loom:b', { projectId: 'p-tango' });
    h.core.roles.set('loom:a', { role: 'default' }, 'owner', NOW);
    h.core.touch('loom:a');
    if (free !== undefined) h.core.store.setSetting('spaces', JSON.stringify({ 'project:p-tango': { permissions: { messageConversations: free } } }));
  }

  it('holds mail with permission off across restart, then edits, sends and returns its answer', async () => {
    lead(false);
    const result = mail.send({ from: 'loom:a', to: 'loom:b', text: 'Original question' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const id = result.mail.id;
    expect(result.mail.state).toBe('draft');
    mail = new DeskMail({ core: h.core, db: h.core.store.db, now: () => h.clock.now });
    await mail.tick();
    expect(turns('b')).toEqual([]);
    expect(mail.drafts('loom:a')).toHaveLength(1);
    expect(mail.draftAction(id, 'send', 'Edited question').ok).toBe(true);
    expect(mail.draftAction(id, 'send').ok).toBe(false);
    await mail.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(turns('b')).toHaveLength(1);
    expect(turns('b')[0]).toContain('Edited question');
    expect(turns('b')[0]).not.toContain('Original question');
    expect(mail.answer(id, 'loom:b', 'The answer').ok).toBe(true);
    await mail.tick();
    expect(turns('a').join('')).toContain('The answer');
  });

  it.each([true, undefined])('sends directly when permission is %s (on unless switched off)', async (free) => {
    lead(free);
    const result = mail.send({ from: 'loom:a', to: 'loom:b', text: 'Direct question' });
    expect(result.ok && result.mail.state).toBe('queued');
    await mail.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(turns('b')).toHaveLength(1);
    expect(mail.drafts('loom:a')).toEqual([]);
  });

  it('discards without delivery and does not release old drafts when permission turns on', async () => {
    lead(false);
    const result = mail.send({ from: 'loom:a', to: 'loom:b', text: 'Discard this' });
    if (!result.ok) throw new Error(result.error);
    lead(true);
    await mail.tick();
    expect(turns('b')).toEqual([]);
    expect(mail.draftAction(result.mail.id, 'drop').ok).toBe(true);
    await mail.tick();
    expect(turns('b')).toEqual([]);
    expect(mail.get(result.mail.id)?.state).toBe('dropped');
  });

  it('leaves worker-to-parent and cross-space mail unaffected', async () => {
    lead(false);
    h.core.roles.set('loom:b', { role: 'worker', parentItemId: 'loom:a' }, 'owner', NOW);
    expect(mail.send({ from: 'loom:b', to: 'loom:a', text: 'Report' })).toMatchObject({ ok: true, mail: { state: 'queued' } });
    h.core.setFacts('loom:b', { projectId: 'elsewhere' });
    expect(mail.send({ from: 'loom:a', to: 'loom:b', text: 'Other space' })).toMatchObject({ ok: true, mail: { state: 'queued' } });
  });

  it('holds urgent and wake mail without reopening the recipient', async () => {
    lead(false);
    await h.core.command({ commandId: 'park-b', type: 'park', itemId: 'loom:b', actor: 'owner' });
    const result = mail.send({ from: 'loom:a', to: 'loom:b', text: 'Wake later', now: true, expect: 'none', wake: true });
    expect(result).toMatchObject({ ok: true, mail: { state: 'draft' } });
    await mail.tick();
    expect(h.core.item('loom:b')?.disposition).toBe('parked');
    expect(turns('b')).toEqual([]);
  });
});
