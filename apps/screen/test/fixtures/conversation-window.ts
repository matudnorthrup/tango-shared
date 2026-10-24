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
