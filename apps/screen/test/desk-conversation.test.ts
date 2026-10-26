import { mailTurn, replyTurn } from '../server/desk/mail.js';
import { lastReportTurn, turnsOf } from '../server/desk/backstage.js';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser module, no types
import { createStore } from '../public/desk/store.js';
// @ts-expect-error plain browser module, no types
import { ConversationStack, Needs } from '../public/desk/conversation.js';
import { DraftBoard, parseDraftCard } from '../server/desk/draft.js';
import { clipMessage, fallbackSummary, parseModelSummary, validQuestions } from '../server/desk/summarize.js';
import { headline, latestReply, sinceOwner, threadBeats } from '../server/desk/view.js';
// @ts-expect-error plain browser module, no types
import { draftForItem, draftView } from '../public/desk/draft-model.js';
// @ts-expect-error plain browser module, no types
import { answerOf, askParts, callsOf, canOpen, exchangeMessageIds, exchangesOf, replyMessages } from '../public/desk/conversation-model.js';

// The Conversation view's reader layout: beats with headlines, the latest reply in full, the
// goal / milestone / open questions from the summarizer, and a voice draft shown in its item's
// reply box with an undo window after "I'm done".

const msg = (id: string, author: 'owner' | 'agent' | 'other', text: string, at: number) => ({ messageId: id, itemId: 'i1', author, at, text });
const fakeCore = { store: { eventsFor: () => [], isUndone: () => false } } as never;
const item = { id: 'i1', createdAt: 0, facts: { failed: null } } as never;
const long = (lead: string) => `${lead} ${'More detail follows here. '.repeat(30)}`;

describe('headline', () => {
  it('the first sentence as plain text', () => {
    expect(headline('**ACM-320** now has four clean shortlists:\n- Adventure')).toBe('ACM-320 now has four clean shortlists');
    expect(headline('## Next idea\n\nbody')).toBe('Next idea');
    expect(headline('See [the issue](https://example.com/x). Then more.')).toBe('See the issue.');
  });

  it('clips long sentences', () => {
    expect(headline('word '.repeat(60)).length).toBeLessThanOrEqual(121);
  });
});

describe('threadBeats', () => {
  it('every owner message; per agent run its last message plus long ones; chatter skipped', () => {
    const beats = threadBeats(fakeCore, item, [
      msg('o1', 'owner', 'Can you size the traffic?', 1),
      msg('a1', 'agent', 'On it, starting the queries.', 2),
      msg('a2', 'agent', long('The sizing finished.'), 3),
      msg('a3', 'agent', 'Waiting on the last query.', 4),
      msg('a4', 'agent', 'Filed it. Anything else?', 5),
      msg('x1', 'other', 'someone else', 6),
      msg('o2', 'owner', 'Great, next idea.', 7),
    ]);
    expect(beats.map((b) => b.messageId)).toEqual(['o1', 'a2', 'a4', 'o2']);
    expect(beats[1]).toMatchObject({ kind: 'agent', headline: 'The sizing finished.' });
  });
});

describe('exchanges: what the owner said, paired with what the agent said back', () => {
  const beat = (kind: string, headline: string, at: number, messageId: string | null = `${kind}${at}`) => ({ kind, headline, at, messageId });

  it('each owner beat opens an exchange; agent beats and desk events join the one before them', () => {
    const xs = exchangesOf([
      beat('agent', 'Started the thread.', 1),
      beat('owner', 'Can you size the traffic?', 2),
      beat('agent', 'The sizing finished.', 3),
      beat('agent', 'Filed it. Anything else?', 4),
      beat('ok', 'Done', 5, null),
      beat('owner', 'You answered: Yes', 6, null),
    ]);
    expect(xs.map((x: { ask: { headline: string } | null }) => x.ask?.headline ?? null)).toEqual([null, 'Can you size the traffic?', 'You answered: Yes']);
    expect(answerOf(xs[1]).headline).toBe('Filed it. Anything else?');
    expect(xs[1].replies).toHaveLength(2);
    expect(xs[1].events.map((e: { headline: string }) => e.headline)).toEqual(['Done']);
    expect(xs[1].at).toBe(5);
    expect(answerOf(xs[2])).toBeNull();
  });

  it('a wait Loom woke the agent for opens its own exchange', () => {
    const xs = exchangesOf([beat('owner', 'Go', 1), beat('agent', 'Waiting on CI.', 2), beat('wake', 'A wait came due: CI finished', 3, null), beat('agent', 'Merged.', 4)]);
    expect(xs).toHaveLength(2);
    expect(answerOf(xs[1]).headline).toBe('Merged.');
    expect(askParts(xs[1].ask)).toEqual({ who: '⏰ Loom', text: 'A wait came due: CI finished' });
  });

  it('opens on the messages behind it; a desk answer with no message has nothing to open', () => {
    const [x, answered] = exchangesOf([beat('owner', 'Go', 1), beat('agent', 'Done.', 2), beat('owner', 'You answered: Ship it', 3, null)]);
    expect(exchangeMessageIds(x)).toEqual(['owner1', 'agent2']);
    expect(canOpen(x)).toBe(true);
    expect(canOpen(answered)).toBe(false);
  });

  it('the owner side reads "You" or "You answered"; a real message keeps a "You:" its owner wrote', () => {
    expect(askParts({ headline: 'You answered: Ship it', messageId: null })).toEqual({ who: 'You answered', text: 'Ship it' });
    expect(askParts({ headline: 'Can you size it?', messageId: 'o1' })).toEqual({ who: 'You', text: 'Can you size it?' });
    expect(askParts({ headline: 'You: are the one to pick', messageId: 'o2' })).toEqual({ who: 'You', text: 'You: are the one to pick' });
    expect(askParts(null)).toBeNull();
    expect(exchangesOf([])).toEqual([]);
  });
});

describe('an exchange in full: the whole run of replies', () => {
  it('includes the short messages the beats skip; null when the run is not all loaded', () => {
    const messages = [
      msg('o1', 'owner', 'Size it?', 1),
      msg('a1', 'agent', 'On it.', 2),
      msg('a2', 'agent', 'Done: 4k/day.', 3),
      msg('o2', 'owner', 'Thanks', 4),
      msg('a3', 'agent', 'Anytime.', 5),
    ];
    const xs = exchangesOf(threadBeats(fakeCore, item, messages));
    expect(xs[0].replies.map((b: { messageId: string }) => b.messageId)).toEqual(['a2']);
    expect(replyMessages(xs, 0, messages).map((m: { messageId: string }) => m.messageId)).toEqual(['a1', 'a2']);
    expect(replyMessages(xs, 1, messages).map((m: { messageId: string }) => m.messageId)).toEqual(['a3']);
    expect(replyMessages(xs, 0, messages.slice(1))).toBeNull();
    expect(replyMessages(xs, 0, [])).toBeNull();
  });
});

describe('latestReply', () => {
  it('the whole last run, without short progress notes in the middle', () => {
    const reply = latestReply([
      msg('o1', 'owner', 'Go', 1),
      msg('a1', 'agent', "I'll check the logs.", 2),
      msg('a2', 'agent', long('Part one.'), 3),
      msg('a3', 'agent', long('Part two.'), 4),
      msg('a4', 'agent', 'Links: x', 5),
    ]);
    expect(reply!.messageIds).toEqual(['a2', 'a3', 'a4']);
    expect(reply!.text.startsWith('Part one.')).toBe(true);
    expect(reply!.text.endsWith('Links: x')).toBe(true);
  });

  it('a reply made only of short messages is kept whole', () => {
    const reply = latestReply([msg('o1', 'owner', 'Which one?', 1), msg('a1', 'agent', 'The Alpine.', 2), msg('a2', 'agent', 'It saves $649.', 3), msg('a3', 'agent', 'Want me to order it?', 4)]);
    expect(reply!.messageIds).toEqual(['a1', 'a2', 'a3']);
  });

  it('stops at the owner; null with no agent message', () => {
    expect(latestReply([msg('a0', 'agent', long('Old.'), 1), msg('o1', 'owner', 'ok', 2), msg('a1', 'agent', 'New.', 3)])!.messageIds).toEqual(['a1']);
    expect(latestReply([msg('o1', 'owner', 'hi', 1)])).toBeNull();
  });
});

describe('conversation stack first answer', () => {
  const first = { at: 1, messageIds: ['a1'], text: '**Opening answer.**\n\nAll the details.', headline: 'Opening answer.', attachments: [{ url: '/example.png' }] };
  const latest = { at: 2, messageIds: ['a2'], text: 'Newer report.' };
  function stack(report: typeof latest | null) {
    return ConversationStack({
      window: { owner: { messageId: 'o1', at: 0, text: 'Explain it.' }, first, latest: report, updates: [], acks: [] },
      item: { id: 'i1' }, d: {}, store: { state: { now: 1000, ownerReceipts: [] } },
    }).props.children.flat().filter(Boolean);
  }

  it('folds the first answer with its headline, full markdown and thumbnails when a newer report exists', () => {
    const rows = stack(latest);
    const answer = rows[1];
    expect(answer.type).toBe('details');
    expect(answer.props.open).toBeUndefined();
    expect(answer.props.class).toContain('rd-report-update');
    expect(JSON.stringify(answer.props.children[0])).toContain('First answer');
    expect(JSON.stringify(answer.props.children[0])).toContain(first.headline);
    expect(JSON.stringify(answer)).toContain(first.text.replaceAll('\n', '\\n'));
    expect(JSON.stringify(answer)).toContain('/example.png');
    expect(rows[2].type).toBe('article');
    expect(rows[2].props.class).toContain('rd-report-latest');
  });

  it('keeps the only answer full and marked as latest', () => {
    const answer = stack(null)[1];
    expect(answer.type).toBe('article');
    expect(answer.props.class).toContain('rd-report rd-report-latest');
    expect(JSON.stringify(answer)).toContain('rd-report-agent');
    expect(JSON.stringify(answer)).not.toContain('First answer');
  });
});

describe('since the owner last spoke', () => {
  it('keeps the conversation window through the real client store and clears it for older responses', async () => {
    const window = sinceOwner(turnsOf([msg('owner', 'owner', 'Which?', 0), msg('answer', 'agent', long('The answer.'), 1)]));
    let payload: Record<string, unknown> = { item: { id: 'i1' }, sinceOwner: window };
    const store = createStore({ mode: 'fixtures', item: async () => payload });
    await store.loadDetail('i1');
    expect(store.state.detail.sinceOwner).toEqual(window);
    payload = { item: { id: 'i1' } };
    await store.loadDetail('i1');
    expect(store.state.detail.sinceOwner).toBeNull();
  });

  it('retains every part of a short-only opening answer', () => {
    const window = sinceOwner(turnsOf([msg('owner', 'owner', 'Which?', 0),
      msg('choice', 'agent', 'The Alpine.', 1), msg('reason', 'agent', 'It saves $649.', 2),
      msg('question', 'agent', 'Want me to order it?', 3)]))!;
    expect(window.first?.messageIds).toEqual(['choice', 'reason', 'question']);
    expect(window.first?.headline).toBe('The Alpine.');
    expect(window.latest).toBeNull();
  });

  it('preserves a long opener beyond eight parts and retains the closing summary', () => {
    const reply = latestReply([msg('first', 'agent', long('Opening answer.'), 1),
      ...Array.from({ length: 12 }, (_, i) => msg(`status-${i}`, 'agent', long(`Update ${i}.`), i + 2)),
      msg('last', 'agent', long('Final report.'), 15)])!;
    expect(reply.messageIds).toHaveLength(8);
    expect(reply.messageIds[0]).toBe('first');
    expect(reply.messageIds.at(-1)).toBe('last');
  });

  it('uses the first substantive answer after a short progress note, once', () => {
    const window = sinceOwner(turnsOf([msg('owner', 'owner', 'Explain it.', 0),
      msg('progress', 'agent', "I'll check.", 1), msg('answer', 'agent', long('The explanation.'), 2)]))!;
    expect(window.first?.messageIds).toEqual(['answer']);
    expect(window.latest).toBeNull();
    expect(window.updates).toEqual([]);
  });

  it('keeps a 200-character opening answer even before a long final report', () => {
    const window = sinceOwner(turnsOf([msg('owner', 'owner', 'Explain it.', 0),
      msg('answer', 'agent', 'a'.repeat(200), 1), msg('report', 'agent', long('Finished.'), 2)]))!;
    expect(window.first?.messageIds).toEqual(['answer', 'report']);
    expect(window.first?.text).toContain('a'.repeat(200));
    expect(window.latest).toBeNull();
  });

  it('keeps all opening answer chunks visible when a later worker reports', () => {
    const window = sinceOwner(turnsOf([msg('owner', 'owner', 'Explain it.', 0),
      msg('chunk-1', 'agent', long('First instructions.'), 1),
      msg('chunk-2', 'agent', long('Required conclusion.'), 2),
      { ...msg('worker', 'agent', long('Worker finished.'), 3), meta: { wake: { run: 'worker-run' } } }]))!;
    expect(window.first?.messageIds).toEqual(['chunk-1', 'chunk-2']);
    expect(window.first?.text).toContain('Required conclusion.');
    expect(window.latest?.messageIds).toEqual(['worker']);
    expect(window.updates).toEqual([]);
  });

  it('keeps the owner answer and latest substantive report through many worker wakes and a trailing ack', () => {
    const messages = [msg('owner', 'owner', 'What remains?', 0), msg('first', 'agent', long('Here is the answer.'), 1),
      ...Array.from({ length: 12 }, (_, i) => ({ ...msg(`report-${i}`, 'agent', long(`Report ${i}.`), i + 2), meta: { wake: { run: `run-${i}` } } })),
      { ...msg('ack', 'agent', 'The closing report matches my last update.', 20), meta: { wake: { run: 'ack-run' } } }];
    const window = sinceOwner(turnsOf(messages))!;
    expect(window.owner.messageId).toBe('owner');
    expect(window.first?.messageIds).toEqual(['first']);
    expect(window.latest?.messageIds).toEqual(['report-11']);
    expect(window.updates).toHaveLength(11);
    expect(window.acks.map(ack => ack.messageIds)).toEqual([['ack']]);
    expect(window.updates[0]?.headline).toBe('Report 0.');
  });

  it('retains no-reply mail reports while excluding answers addressed to a peer', () => {
    const reportMail = (id: string, at: number) => msg(id, 'owner', replyTurn({
      id: `m-${id}`, toItemId: 'loom:worker', toTitle: 'Worker', text: 'Status?', answer: 'Done.',
    }, { reportsUp: true }), at);
    const notice = (id: string, at: number, expect: 'none' | 'reply' = 'none') => msg(id, 'owner', mailTurn({
      id: `m-${id}`, fromItemId: 'loom:worker', fromTitle: 'Worker', text: 'No reply needed. Status update.', expect,
    }), at);
    const messages = [msg('owner', 'owner', 'Finish the checks.', 0), msg('first', 'agent', long('The plan.'), 1),
      reportMail('reply', 2), msg('initial', 'agent', long('Checks started.'), 3),
      notice('notice-1', 4), msg('failed', 'agent', long('The live check failed.'), 5),
      notice('notice-2', 6), msg('fixed', 'agent', long('The fix is ready.'), 7),
      notice('notice-3', 8), msg('finished', 'agent', long('The work is finished.'), 9),
      notice('needs-reply', 10, 'reply'), msg('peer-answer', 'agent', long('Private answer to peer.'), 11)];
    // The same selection drives the fallback reply. A body mentioning no reply is insufficient.
    expect(lastReportTurn(turnsOf(messages))?.replies.map(m => m.messageId)).toEqual(['finished']);
    messages.push(reportMail('closing', 12), msg('ack', 'agent', 'The closing report matches.', 13));
    const window = sinceOwner(turnsOf(messages))!;
    expect(window.first?.messageIds).toEqual(['first']);
    expect(window.updates.map(update => update.messageIds)).toEqual([['initial'], ['failed'], ['fixed']]);
    expect(window.latest?.messageIds).toEqual(['finished']);
    expect(window.acks.map(ack => ack.messageIds)).toEqual([['ack']]);
  });

  it('does not borrow an earlier answer for a new owner message, and leaves never-owner conversations unchanged', () => {
    expect(sinceOwner(turnsOf([msg('agent', 'agent', 'Hello.', 1)]))).toBeNull();
    const window = sinceOwner(turnsOf([msg('owner', 'owner', 'Hello.', 1), msg('agent', 'agent', 'Hi.', 2), msg('new', 'owner', 'Next question.', 3)]))!;
    expect(window.owner.messageId).toBe('new');
    expect(window.first).toBeNull();
    expect(window.latest).toBeNull();
  });

  it('keeps a short final answer and folds no acks when no substantive report precedes them', () => {
    const window = sinceOwner(turnsOf([msg('owner', 'owner', 'Which?', 1), msg('first', 'agent', "I'll check.", 2), msg('answer', 'agent', 'The blue one.', 3)]))!;
    expect(window.first?.messageIds).toEqual(['first', 'answer']);
    expect(window.acks).toEqual([]);
  });
});

describe('summary: goal, milestone, questions', () => {
  const input = { agentName: 'Loom', place: 'growth', messages: [{ author: 'agent' as const, text: 'How candid should we be? And is it OK to state the credit change plainly?' }], previous: { step: 'your_move' as const, gist: 'g', ask: null, goal: 'Move players to the new app', milestone: 'File concept 4' } };

  it('reads them from the model reply', () => {
    const out = parseModelSummary(
      JSON.stringify({ title: 'Settle two questions', gist: 'Two calls for you.', step: 'your_move', ask: 'How candid should we be?', goal: 'Move players to the new app', milestone: 'Settle two questions, then file it', questions: [{ q: 'How candid should we be?', lean: 'Only what is true now.' }, { q: 'State the credit change plainly?', lean: null }, { nope: 1 }] }),
      input,
    );
    expect(out.goal).toBe('Move players to the new app');
    expect(out.milestone).toBe('Settle two questions, then file it');
    expect(out.questions).toEqual([
      { q: 'How candid should we be?', lean: 'Only what is true now.' },
      { q: 'State the credit change plainly?', lean: null },
    ]);
  });

  it('waitingOn carries kind agent for a wait on another agent; anything else is a person', () => {
    expect(parseModelSummary(JSON.stringify({ gist: 'x', step: 'watching', waitingOn: { who: 'Desk', what: 'a trace', kind: 'agent' } }), input).waitingOn).toEqual({ who: 'Desk', what: 'a trace', kind: 'agent' });
    expect(parseModelSummary(JSON.stringify({ gist: 'x', step: 'watching', waitingOn: { who: 'Alex', what: 'proof', kind: 'robot' } }), input).waitingOn).toEqual({ who: 'Alex', what: 'proof' });
  });

  it('a missing goal keeps the previous one; the fallback keeps goal and milestone', () => {
    expect(parseModelSummary(JSON.stringify({ gist: 'x', step: 'fyi' }), input).goal).toBe('Move players to the new app');
    expect(fallbackSummary(input)).toMatchObject({ goal: 'Move players to the new app', milestone: 'File concept 4' });
  });

  it('a carried decision keeps every open question through a fallback', () => {
    const carried = { ...input, messages: [{ author: 'agent' as const, text: 'Also, the notes are saved.' }], previous: { ...input.previous, questions: [{ q: 'How candid?', lean: null }, { q: 'Credit change?', lean: 'Yes.' }] } };
    expect(fallbackSummary(carried).questions).toEqual([{ q: 'How candid?', lean: null }, { q: 'Credit change?', lean: 'Yes.' }]);
  });

  it('an earlier state the owner has replied to is not offered as still waiting on them', () => {
    const replied = { ...input, previous: { step: 'your_move' as const, gist: 'Asked about the pause fix.', ask: null, goal: 'g', milestone: null, questions: [], ownerReplied: true } };
    expect(fallbackSummary({ ...replied, messages: [{ author: 'agent' as const, text: 'The Foxtrot fix is in review.' }] }).step).toBe('fyi');
  });

  it('work notes go after the transcript with their age; the prompt keeps them from asking anything', async () => {
    const { notesBlock } = await import('../server/desk/summarize.js');
    const block = notesBlock({ agentName: 'Loom', place: null, messages: [], workNotes: [{ at: 0, text: 'Capture is running.' }] }, () => 5 * 60_000);
    expect(block).toContain('Work notes (Loom');
    expect(block).toContain('- (5 min ago) Capture is running.');
    expect(notesBlock({ agentName: 'Loom', place: null, messages: [] })).toBe('');
  });

  it("a lead's workers' posts go ahead of the transcript as what the owner already heard from them", async () => {
    const { workersBlock } = await import('../server/desk/summarize.js');
    const block = workersBlock({ agentName: 'Loom', place: null, messages: [], workersPosted: [{ title: 'Fix merged', text: 'The fix is merged\nand live.' }] });
    expect(block).toContain('Already posted by its workers (the conversations Loom manages');
    expect(block).toContain('- Fix merged: The fix is merged and live.');
    expect(workersBlock({ agentName: 'Loom', place: null, messages: [] })).toBe('');
  });

  it('a long message keeps its closing hand-off in the transcript (live 10/18: a head-only cut dropped the ask)', () => {
    const text = `${'Body line with a question in it?\n'.repeat(120)}\n**Next — you:** decide on the new layout so I can lift the hold.\n\nLinks: a, b`;
    const clipped = clipMessage(text, 1500);
    expect(clipped.length).toBeLessThanOrEqual(1510);
    expect(clipped).toContain('**Next — you:** decide on the new layout');
    expect(clipped.startsWith('Body line')).toBe(true);
    expect(clipMessage('short', 1500)).toBe('short');
    // The section a closing pointer refers to, just above the hand-off, survives the cut (Codex review on #729).
    const pointer = `${'Filler paragraph.\n'.repeat(150)}## Decisions\n1. Stall replaces the garage?\n2. Real-time restoration?\n\n**Next — you:** answer the two decisions above.`;
    const kept = clipMessage(pointer, 1500);
    expect(kept).toContain('1. Stall replaces the garage?');
    expect(kept).toContain('**Next — you:** answer the two decisions above.');
    expect(kept.length).toBeLessThanOrEqual(1510);
    // No hand-off: the head and the last stretch.
    expect(clipMessage(`${'a'.repeat(2000)}END`, 1000).endsWith('END')).toBe(true);
  });

  it('the calls under the heading follow the ask the step was decided on, unless a current summary agrees', () => {
    const facts = { contentKey: 'm2:4' };
    const summary = { contentKey: 'm2:4', step: 'your_move', ask: 'Does the game play right?', questions: [{ q: 'Does the game play right?', lean: null }] };
    // Current and agreeing: its questions (they split a multi-part ask).
    expect(callsOf({ facts, ask: 'decide the layout', summary })).toEqual(summary.questions);
    // Older words: the recorded ask, not the stale questions.
    expect(callsOf({ facts: { contentKey: 'm3:5' }, ask: 'decide the layout', summary })).toEqual([{ q: 'decide the layout', lean: null }]);
    // The summary says it isn't the owner's move (a "Next — you" line decided it): the ask.
    expect(callsOf({ facts, ask: 'merge it', summary: { ...summary, step: 'fyi' } })).toEqual([{ q: 'merge it', lean: null }]);
    expect(callsOf({ facts, ask: null, summary: { ...summary, step: 'fyi', questions: [] } })).toEqual([]);
  });

  it('validQuestions caps at five and drops junk', () => {
    expect(validQuestions('no')).toEqual([]);
    expect(validQuestions(Array.from({ length: 8 }, (_, i) => ({ q: `Q${i}?` }))).length).toBe(5);
  });
});

describe('draft for an item, with an undo window', () => {
  const target = { agentId: 'sierra', name: 'Sierra', where: 'Speaker', label: 'Sierra · Speaker', itemId: 'discord:thread:1' };

  it('the card carries its item; the item’s Conversation view picks it up', () => {
    const card = parseDraftCard({ id: 'd1', active: true, status: 'listening', target, fragments: ['go with the Alpine'] }, 1000)!;
    expect(card.target!.itemId).toBe('discord:thread:1');
    expect(draftForItem(card, 'discord:thread:1')).toBe(card);
    expect(draftForItem(card, 'other')).toBeNull();
    expect(draftView(card, 1000).hint).toContain('I’m done');
  });

  it('sending with undoUntil: Undo until the window closes, then nothing', () => {
    const card = { ...parseDraftCard({ id: 'd1', active: true, status: 'sending', compiled: 'Go with the Alpine.', undoUntil: 6000, target }, 1000)! };
    expect(draftView(card, 2000)).toMatchObject({ canUndo: true, undoSeconds: 4, canCancel: false, title: 'Sending to Sierra' });
    expect(draftView(card, 7000)).toMatchObject({ canUndo: false, title: 'Sending to Sierra…' });

    const board = new DraftBoard();
    board.set(card);
    const heard: string[] = [];
    board.subscribeCommands((command) => heard.push(command.action));
    expect(board.command('cancel', 'd1', 2000).status).toBe(202);
    expect(board.command('cancel', 'd1', 7000).status).toBe(409);
    expect(heard).toEqual(['cancel']);
  });
});

it('the conversation callout shows an open request before Working', () => {
  const tree = Needs({ item: { id: 'x', nextStep: 'working', facts: { background: 'working', pending: { kind: 'question', question: 'Approve the change?', options: [] } }, status: { move: 'needs' }, summary: {} }, store: { state: { now: 100 } } });
  const text = JSON.stringify(tree);
  expect(text).not.toContain('Working on it');
  expect(text).toContain('Approve the change?');
});

it('renders durable formal-answer and discussion receipts from reloaded server facts', async () => {
  // @ts-expect-error plain browser module
  const { BriefReceipts, BriefCard } = await import('../public/desk/brief.js');
  const facts = JSON.parse(JSON.stringify({ answeredBrief: { id: 'D-8', choice: 'B · Spacious', at: 10 }, discussing: [{ id: 'D-9', since: 20 }] }));
  const tree = BriefReceipts({ item: { id: 'i', facts }, store: {} });
  const text = JSON.stringify(tree);
  expect(text).toContain('Answered: B · Spacious · agent notified');
  expect(text).toContain('In discussion: your reply delivered');
  const receipt = BriefCard({ pending: { brief: { id: 'D-8' } }, size: 'receipt', receipt: 'Answered: B · Spacious · agent notified', store: {} });
  expect(receipt.props['aria-label']).toBe('Decision D-8');
  expect(JSON.stringify(BriefReceipts({ item: { facts: {} }, store: {} }))).not.toContain('Answered:');
});

it('keeps owner words after the previous report until a newer report answers them', async () => {
  // @ts-expect-error plain browser module
  const { mergeOwnerReceipts, OwnerReceipts } = await import('../public/desk/owner-receipts.js');
  const local = [{ itemId: 'i', commandId: 'c1', text: 'First', at: 10, status: 'sending' }, { itemId: 'i', commandId: 'c2', text: 'Second', at: 20, status: 'sending' }];
  const d = { ownerReceipts: [{ messageId: 'm1', commandId: 'c1', text: 'First', at: 11, status: 'queued' }], receiptCommandIds: ['c1'] };
  expect(mergeOwnerReceipts('i', d, local).map((r: any) => [r.text, r.status])).toEqual([['First', 'queued'], ['Second', 'sending']]);
  expect(mergeOwnerReceipts('i', { ownerReceipts: [], receiptCommandIds: ['c1', 'c2'] }, local)).toEqual([]);
  const tree = OwnerReceipts({ item: { id: 'i' }, d, store: { state: { ownerReceipts: local } } });
  expect(JSON.stringify(tree)).toContain('First');
  expect(JSON.stringify(tree)).toContain('Second');
});

describe('conversation detail window', () => {
  it('loads the owner answer beyond the recent-message boundary and keeps the legacy reply', async () => {
    const { makeHarness } = await import('./desk-harness.js');
    const { seedConversationWindow, CONVERSATION_ITEM } = await import('./fixtures/conversation-window.js');
    const { itemDetail } = await import('../server/desk/view.js');
    const h = makeHarness();
    try {
      seedConversationWindow(h.core, 1_000);
      for (let i = 0; i < 130; i++) h.core.recordMessage(CONVERSATION_ITEM, {
        messageId: `late-${i}`, author: 'agent', at: 2_000 + i, text: 'Closing acknowledgement.', meta: { wake: { run: `late-run-${i}` } },
      });
      const d = itemDetail(h.core, CONVERSATION_ITEM, [])!;
      expect(d.sinceOwner?.owner.messageId).toBe('window-owner');
      expect(d.sinceOwner?.first?.messageIds).toEqual(['window-first']);
      expect(d.sinceOwner?.latest?.messageIds).toEqual(['window-report-11']);
      expect(d.sinceOwner?.acks).toHaveLength(131);
      expect(d.reply?.messageIds).toEqual(['late-129']);
    } finally { h.close(); }
  });
});


it('gives each phone-note action card its own component identity', () => {
  const card = (noteId: string) => Needs({ item: { facts: { phoneNote: { noteId } } }, store: {} });
  expect(card('first').key).toBe('first');
  expect(card('second').key).toBe('second');
});


describe('labelled replies', () => {
  const phased = (id: string, text: string, phase: 'note' | 'answer', runId = 'one') => ({ ...msg(id, 'agent', text, 2), meta: { phase, runId } });
  it('keeps short answers and unknown text while folding long notes in a labelled run', () => {
    const reply = latestReply([phased('n', long('Working.'), 'note'), msg('unknown', 'agent', 'Unknown', 2), phased('a', 'Done.', 'answer')])!;
    expect(reply.text).toBe('Unknown\n\nDone.'); expect(reply.messageIds).toEqual(['unknown', 'a']);
    expect(reply.notes?.map(n => n.messageIds)).toEqual([['n']]);
  });
  it('retains a synthetic plan message in a labelled run', () => {
    const plan = msg('plan:request-1', 'agent', '## Plan\n\nImplement and verify the change.', 3);
    const messages = [phased('n', 'Checking.', 'note'), phased('a', 'Plan ready.', 'answer'), plan];
    expect(latestReply(messages)).toMatchObject({
      text: 'Plan ready.\n\n' + plan.text, messageIds: ['a', plan.messageId], notes: [{ messageIds: ['n'] }],
    });
    expect(sinceOwner(turnsOf([msg('owner', 'owner', 'Make a plan.', 1), ...messages]))?.first?.text).toContain(plan.text);
  });
  it('uses the last note as the reply when only notes exist', () => {
    expect(latestReply([phased('n1', 'Checking.', 'note'), phased('n2', 'Still working.', 'note')])).toMatchObject({ text: 'Still working.', messageIds: ['n2'], notes: [{ messageIds: ['n1'] }] });
    expect(latestReply([phased('n', 'Working.', 'note')])).toMatchObject({ text: 'Working.', messageIds: ['n'], notes: [] });
  });
  it('shows a pending null message after a resolved note', () => {
    expect(latestReply([phased('n', 'Checking.', 'note'), { ...msg('pending', 'agent', 'Current answer.', 3), meta: { phase: null } }])).toMatchObject({ text: 'Current answer.', messageIds: ['pending'], notes: [{ messageIds: ['n'] }] });
  });
  it('keeps images in the answer even when their message is labelled a note', () => {
    const attachments = [{ url: '/chart.png', name: 'chart.png', mimeType: 'image/png' }];
    expect(latestReply([phased('n', 'Checking.', 'note'), { ...phased('image', 'Chart.', 'note'), attachments }, phased('a', 'Done.', 'answer')])).toMatchObject({ text: 'Chart.\n\nDone.', messageIds: ['image', 'a'], attachments, notes: [{ messageIds: ['n'] }] });
  });
  it('uses labels per turn and retains legacy reports and short check-ins', () => {
    const window = sinceOwner(turnsOf([msg('owner', 'owner', 'Explain', 1), phased('n', long('Working.'), 'note'), phased('a', long('Answer.'), 'answer'),
      { ...msg('legacy', 'agent', long('Legacy report.'), 3), meta: { wake: { run: 'two' } } },
      { ...phased('check-note', long('More work.'), 'note', 'three'), at: 4, meta: { phase: 'note' as const, wake: { run: 'three' } } },
      { ...phased('check', 'Checked.', 'answer', 'three'), at: 5, meta: { phase: 'answer' as const, wake: { run: 'three' } } },
    ]))!;
    expect(window.first?.messageIds).toEqual(['a']); expect(window.first?.notes).toHaveLength(1);
    expect(window.latest?.messageIds).toEqual(['legacy']); expect(window.acks[0]?.text).toBe('Checked.'); expect(window.acks[0]?.notes).toHaveLength(1);
  });
});
