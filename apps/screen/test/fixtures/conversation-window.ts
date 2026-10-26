import type { DeskCore } from '../../server/desk/core.js';
import { replyTurn } from '../../server/desk/mail.js';

export const CONVERSATION_ITEM = 'loom:conversation-window-fixture';
const detail = ' The shared endpoint now applies the same pause detection to every surface. A short pause keeps the microphone open, while a completed thought starts the reply. The sandbox checks cover a long explanation, a short question, and speech that resumes after a pause.';
export function seedConversationWindow(core: DeskCore, now: number) {
  const id = CONVERSATION_ITEM;
  core.store.createItem({ id, source: 'loom', kind: 'thread', conversationKey: id, agentId: 'helper', agentName: 'Helper', place: 'Voice conversation follow-through' });
  core.recordMessage(id, { messageId: 'window-owner', author: 'owner', at: now, text: 'I will handle the phone setup elsewhere. Anything else we need for voice mode?' });
  core.recordMessage(id, { messageId: 'window-first', author: 'agent', at: now + 1, text: 'Yes, every voice surface now uses one version. Here is what remains to verify.\n\n' + detail.repeat(3) });
  for (let i = 0; i < 12; i++) {
    const mail = replyTurn({ id: `window-mail-${i}`, toItemId: 'loom:voice-worker', toTitle: 'Voice worker', text: 'Check voice mode.', answer: 'Checks complete.' }, { reportsUp: true });
    core.recordMessage(id, { messageId: `window-mail-${i}`, author: 'owner', at: now + 2 + i * 2, text: mail, meta: { mail: { kind: 'reply', peer: 'Voice worker' } } });
    core.recordMessage(id, { messageId: `window-report-${i}`, author: 'agent', at: now + 3 + i * 2, text: i === 11 ? 'The voice work is finished. All sandbox checks passed.\n\n' + detail.repeat(3) : `Check ${i + 1} finished: the voice behavior matches the expected timing.\n\n` + detail.repeat(3) });
  }
  core.recordMessage(id, { messageId: 'window-ack', author: 'agent', at: now + 30, text: 'The worker’s closing report matches my last update. Nothing else is needed.', meta: { wake: { run: 'window-ack-run' } } });
}


/** A labelled run beside a legacy update, used by sandbox browser checks. */
export function seedLabelledConversation(core: DeskCore, now: number) {
  const id = 'loom:labelled-conversation-fixture';
  core.store.createItem({ id, source: 'loom', kind: 'thread', conversationKey: id, agentId: 'helper', agentName: 'Helper', place: 'Answer and working notes' });
  core.recordMessage(id, { messageId: 'label-owner', author: 'owner', at: now, text: 'Does the reply keep the answer separate from the working notes?' });
  core.recordMessage(id, { messageId: 'label-note', author: 'agent', at: now + 1, text: 'I will trace the message labels, then check both conversation layouts.', meta: { phase: 'note', runId: 'label-first' } });
  core.recordMessage(id, { messageId: 'label-note-2', author: 'agent', at: now + 2, text: 'The runtime now preserves the source label. I am checking older conversations next.', meta: { phase: 'note', runId: 'label-first' } });
  core.recordMessage(id, { messageId: 'label-answer', author: 'agent', at: now + 3, text: 'Yes. The reply shows the answer, with working notes available in a folded line below. Older conversations keep their existing selection rule.\n\nThe same layout is used in both views: your message sits in a light card and the answer has no colored side rule.', meta: { phase: 'answer', runId: 'label-first' } });
  core.recordMessage(id, { messageId: 'label-update', author: 'agent', at: now + 4, text: 'The sandbox checks passed.\n\n' + detail.repeat(3), meta: { phase: 'answer', wake: { run: 'label-update' } } });
  core.recordMessage(id, { messageId: 'label-ack', author: 'agent', at: now + 5, text: 'The final check is complete.', meta: { phase: 'answer', wake: { run: 'label-check' } } });
}
