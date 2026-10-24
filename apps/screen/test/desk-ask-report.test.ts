import { expect, it } from 'vitest';
import { ownWakes, loomMessageMeta } from '../server/desk/source-loom.js';
import { itemDetail } from '../server/desk/view.js';
import { lastReportTurn, turnsOf } from '../server/desk/backstage.js';
import { makeHarness, NOW } from './desk-harness.js';
import { seedAskReport, REPORT_ITEM, REPORT_ASK, REPORT_TEXT } from './fixtures/ask-report.js';

function setup() { const h = makeHarness(); seedAskReport(h.core, NOW); return h; }
it('replays mail report → repeated trigger → corrective stubs → mail without losing the report or ask', () => {
  const h = setup();
  const d = itemDetail(h.core, REPORT_ITEM, [])!;
  expect(d.reply!.text).toBe(REPORT_TEXT);
  expect(d.item.facts.openAsk!.text).toBe(REPORT_ASK);
  expect(d.item.status.detail).toBe(REPORT_ASK);
  expect(d.laterNotes).toMatchObject({ count: 4 });
  expect(d.laterNotes!.notes.map(n => n.text)).toContain('Still open.');
  expect(lastReportTurn(turnsOf(d.messages))!.wake!.run).toBe('trigger');
});
it('a trigger with a changed ask moves the pin; an owner message releases it', () => {
  const h = setup();
  h.core.setFacts(REPORT_ITEM, { openAsk: { text: 'Review the revised ending instead', at: NOW + 2, messageId: 'loom:trigger-message', runId: 'trigger' } });
  expect(itemDetail(h.core, REPORT_ITEM, [])!.reply!.messageIds).toEqual(['loom:trigger-message']);
  h.core.recordMessage(REPORT_ITEM, { messageId: 'owner-response', author: 'owner', at: NOW + 7, text: 'Keep the original ending.' });
  h.core.recordMessage(REPORT_ITEM, { messageId: 'new-report', author: 'agent', at: NOW + 8, text: 'The original ending is restored.' });
  expect(itemDetail(h.core, REPORT_ITEM, [])!.reply!.text).toBe('The original ending is restored.');
});
it('an open brief uses its raising run even without a handoff ask', () => {
  const h = setup();
  h.core.setFacts(REPORT_ITEM, { openAsk: null, openBrief: { kind: 'question', requestId: 'decision:D-1', questions: [], question: 'Choose the ending', options: [], at: NOW + 1, runId: 'report' } });
  expect(itemDetail(h.core, REPORT_ITEM, [])!.reply!.text).toBe(REPORT_TEXT);
});
it('widens the read to an anchor older than 120 messages', () => {
  const h = setup();
  for (let i = 0; i < 140; i++) h.core.recordMessage(REPORT_ITEM, { messageId: `later-${i}`, author: 'agent', at: NOW + 10 + i, text: 'Later note.', meta: { wake: { run: `later-${i}`, cause: 'corrective' } } });
  const d = itemDetail(h.core, REPORT_ITEM, [])!;
  expect(d.reply!.text).toBe(REPORT_TEXT);
  expect(d.laterNotes!.count).toBe(144);
});
it('corrective wakes without an open ask still cannot replace the report', () => {
  const h = setup();
  h.core.setFacts(REPORT_ITEM, { openAsk: null });
  expect(itemDetail(h.core, REPORT_ITEM, [])!.reply!.messageIds).toEqual(['loom:mail-reply']);
  h.core.recordMessage(REPORT_ITEM, { messageId: 'last-correction', author: 'agent', at: NOW + 9, text: 'Still open.', meta: { wake: { run: 'last-correction', cause: 'corrective' } } });
  expect(itemDetail(h.core, REPORT_ITEM, [])!.reply!.messageIds).toEqual(['loom:mail-reply']);
});

it('an anchor the conversation cannot match keeps the usual report (a linked Discord item)', () => {
  const h = setup();
  h.core.setFacts(REPORT_ITEM, { openAsk: { text: REPORT_ASK, at: NOW + 1, messageId: 'loom-only-message', runId: 'loom-only-run' } });
  expect(itemDetail(h.core, REPORT_ITEM, [])!.reply!.messageIds).toEqual(['loom:mail-reply']);
});
it('a brief raised during a corrective falls back to an owner report, never peer mail', () => {
  const h = setup();
  h.core.recordMessage(REPORT_ITEM, { messageId: 'owner-ask', author: 'owner', at: NOW - 2, text: 'Cut the review version.' });
  h.core.recordMessage(REPORT_ITEM, { messageId: 'late-correction', author: 'agent', at: NOW + 9, text: 'Raised the brief.', meta: { runId: 'late-correction', wake: { run: 'late-correction', cause: 'corrective' } } });
  h.core.setFacts(REPORT_ITEM, { openAsk: null, openBrief: { kind: 'question', requestId: 'decision:D-1', questions: [], question: 'Choose the ending', options: [], at: NOW + 9, runId: 'late-correction' } });
  expect(itemDetail(h.core, REPORT_ITEM, [])!.reply!.messageIds).toEqual(['loom:trigger-message']);
});

it('a brief from a steered run pins the report after the steer, not the progress before it', () => {
  const h = setup();
  h.core.recordMessage(REPORT_ITEM, { messageId: 'progress', author: 'agent', at: NOW + 10, text: 'Halfway through the export.', meta: { runId: 'steered' } });
  h.core.recordMessage(REPORT_ITEM, { messageId: 'steer', author: 'owner', at: NOW + 11, text: 'Keep the long ending.' });
  h.core.recordMessage(REPORT_ITEM, { messageId: 'final', author: 'agent', at: NOW + 12, text: 'Export finished with the long ending.', meta: { runId: 'steered' } });
  h.core.setFacts(REPORT_ITEM, { openAsk: null, openBrief: { kind: 'question', requestId: 'decision:D-2', questions: [], question: 'Publish it?', options: [], at: NOW + 12, runId: 'steered' } });
  expect(itemDetail(h.core, REPORT_ITEM, [])!.reply!.messageIds).toEqual(['final']);
});

it('the browser store retains later notes from the detail API', async () => {
  // @ts-expect-error Browser module has no declaration file.
  const { createStore } = await import('../public/desk/store.js');
  const h = setup();
  const detail = itemDetail(h.core, REPORT_ITEM, [])!;
  const store = createStore({ mode: 'live', item: async () => detail });
  await store.loadDetail(REPORT_ITEM);
  expect(store.state.detail.laterNotes).toEqual(detail.laterNotes);
});

it.each(['next-only', 'empty'])('shows the missing-answer correction for a %s owner reply, even with a pinned ask', (mode) => {
  const h = setup();
  h.core.recordMessage(REPORT_ITEM, { messageId: 'question', author: 'owner', at: NOW + 10, text: 'Is this the new bridge?', meta: loomMessageMeta({ role: 'user', text: 'Is this the new bridge?', run_id: 'question-run' }, new Set()) });
  if (mode === 'next-only') h.core.recordMessage(REPORT_ITEM, { messageId: 'stub', author: 'agent', at: NOW + 11, text: '**Next — you:** build the Shortcut and report back.', meta: { runId: 'question-run' } });
  h.core.setFacts(REPORT_ITEM, { openAsk: { text: REPORT_ASK, at: NOW + 11, runId: 'question-run', ...(mode === 'next-only' ? { messageId: 'stub' } : {}) } });
  h.core.recordMessage(REPORT_ITEM, { messageId: 'answer', author: 'agent', at: NOW + 12, text: 'It is the same bridge. The two endpoints use the same turn rules.', meta: loomMessageMeta({ role: 'assistant', text: 'Answer', run_id: 'answer-run' }, new Set(), ownWakes({ messages: [], runs: [{ id: 'answer-run', source: 'wake', text: 'Missing answer correction', wake_cause: 'corrective', answers_run_id: 'question-run', status: 'completed', failure: null, started_at: NOW + 12, ended_at: NOW + 12 }] })) });
  h.core.recordMessage(REPORT_ITEM, { messageId: 'routine-correction', author: 'agent', at: NOW + 13, text: 'Recorded the handoff.', meta: { wake: { run: 'routine', cause: 'corrective' } } });
  const detail = itemDetail(h.core, REPORT_ITEM, [])!;
  expect(detail.reply!.messageIds).toEqual(['answer']);
  expect(detail.laterNotes!.notes.map(note => note.text)).toEqual(['Recorded the handoff.']);
  expect(lastReportTurn(turnsOf(detail.messages))!.replies[0]!.messageId).toBe('answer');
});

it('a delayed missing-answer correction cannot displace a newer owner report', () => {
  const h = setup();
  h.core.setFacts(REPORT_ITEM, { openAsk: null });
  h.core.recordMessage(REPORT_ITEM, { messageId: 'new-question', author: 'owner', at: NOW + 10, text: 'What is next?', meta: { runId: 'new-run' } });
  h.core.recordMessage(REPORT_ITEM, { messageId: 'new-answer', author: 'agent', at: NOW + 11, text: 'Run the updated test.', meta: { runId: 'new-run' } });
  h.core.recordMessage(REPORT_ITEM, { messageId: 'stale-answer', author: 'agent', at: NOW + 12, text: 'An older answer.', meta: { wake: { run: 'stale', cause: 'corrective', answersRun: 'report' } } });
  expect(itemDetail(h.core, REPORT_ITEM, [])!.reply!.messageIds).toEqual(['new-answer']);
});
