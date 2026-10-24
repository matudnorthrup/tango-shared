import type { DeskCore } from '../../server/desk/core.js';
import { askOf, loomMessageMeta, ownWakes } from '../../server/desk/source-loom.js';

export const REPORT_ITEM = 'loom:ask-report-fixture';
export const REPORT_ASK = 'Watch the finished cut and reply approved or name edits';
export const REPORT_TEXT = 'The review cut is ready.\n\nThe opening now reaches the demonstration sooner, and the closing keeps the full explanation. I checked the export from beginning to end: audio stays synchronized and the titles remain readable.\n\nWatch the finished cut and reply approved or name edits.';
export function seedAskReport(core: DeskCore, now: number, source: 'loom' | 't3' = 'loom') {
  const run = (id: string, source: string, text: string, wake_cause?: 'trigger' | 'corrective') => ({ id, source, text, wake_cause, status: 'completed' as const, failure: null, started_at: now, ended_at: now });
  const runs = [run('report', 'user', 'Peer report'), run('trigger', 'wake', 'Loom: the trigger you set fired: worker idle'), run('correction1', 'wake', 'Correction', 'corrective'), run('correction2', 'wake', 'Correction', 'corrective'), run('mail', 'user', 'Peer follow-up')];
  const messages = [
    { id: 'open', run_id: 'report', role: 'user', text: 'Peer report', origin: JSON.stringify({ kind: 'peer', name: 'Export worker', from: 'loom:export-worker' }), created_at: now },
    { id: 'report-message', run_id: 'report', role: 'assistant', text: REPORT_TEXT, created_at: now + 1 },
    { id: 'trigger-message', run_id: 'trigger', role: 'assistant', text: 'The export worker finished. The review request is unchanged.', created_at: now + 2 },
    { id: 'correction-message1', run_id: 'correction1', role: 'assistant', text: 'Still open.', created_at: now + 3 },
    { id: 'correction-message2', run_id: 'correction2', role: 'assistant', text: 'Still open.', created_at: now + 4 },
    { id: 'mail-open', run_id: 'mail', role: 'user', text: 'Peer follow-up', origin: JSON.stringify({ kind: 'peer', name: 'Export worker', from: 'loom:export-worker' }), created_at: now + 5 },
    { id: 'mail-reply', run_id: 'mail', role: 'assistant', text: 'The archive copy is ready too.', created_at: now + 6 },
  ];
  core.store.createItem({ id: REPORT_ITEM, source, kind: 'thread', conversationKey: REPORT_ITEM, agentId: 'helper', agentName: 'Helper', place: 'Review cut' });
  const wakes = ownWakes({ runs, messages });
  for (const m of messages) core.recordMessage(REPORT_ITEM, { messageId: 'loom:' + m.id, author: m.role === 'assistant' ? 'agent' : 'owner', text: m.text, at: m.created_at, meta: loomMessageMeta(m, new Set(), wakes) });
  core.setFacts(REPORT_ITEM, { openAsk: askOf(JSON.stringify({ text: REPORT_ASK, at: now + 1, messageId: 'report-message', runId: 'report' })) });
}

/** Reproduce the missing answer without a model: the original ask pins a Next-only reply. */
export function seedMissingAnswerReport(core: DeskCore, now: number, source: 'loom' | 't3' = 'loom') {
  const id = 'loom:missing-answer-fixture';
  core.store.createItem({ id, source, kind: 'thread', conversationKey: id, agentId: 'helper', agentName: 'Helper', place: 'Missing answer recovery' });
  core.recordMessage(id, { messageId: 'question', author: 'owner', at: now, text: 'Is this the new bridge?', meta: { runId: 'question-run' } });
  core.recordMessage(id, { messageId: 'stub', author: 'agent', at: now + 1, text: '**Next — you:** run the phone test and report back.', meta: { runId: 'question-run' } });
  core.setFacts(id, { openAsk: { text: 'Run the phone test and report back', at: now + 1, messageId: 'stub', runId: 'question-run' } });
  const wakes = ownWakes({ messages: [], runs: [{ id: 'answer-run', source: 'wake', text: 'Missing answer correction', wake_cause: 'corrective', answers_run_id: 'question-run', status: 'completed', failure: null, started_at: now + 2, ended_at: now + 2 }] });
  core.recordMessage(id, { messageId: 'answer', author: 'agent', at: now + 2, text: 'It is the same bridge. The two endpoints use the same turn rules.', meta: loomMessageMeta({ role: 'assistant', text: 'Answer', run_id: 'answer-run' }, new Set(), wakes) });
  core.recordMessage(id, { messageId: 'routine-correction', author: 'agent', at: now + 3, text: 'Recorded the handoff.', meta: { wake: { run: 'routine', cause: 'corrective' } } });
}
