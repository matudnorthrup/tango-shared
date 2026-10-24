import { mailOf } from './backstage.js';
import type { DeskEvent, DeskMessage } from './types.js';

export interface OwnerReceipt {
  messageId: string;
  commandId?: string;
  at: number;
  text: string;
  status: 'delivered' | 'queued' | 'picked-up';
}

/** Source messages plus accepted desk commands during the source-echo gap. No status inferred from a busy row. */
export function ownerReceipts(messages: DeskMessage[], events: DeskEvent[], replyAt: number | null) {
  const owners = messages.filter(m => m.author === 'owner' && !mailOf(m));
  const accepted = events.filter(e => e.type === 'source.owner_posted' && e.commandId && typeof e.payload.text === 'string');
  const used = new Set<string>();
  const receipts: OwnerReceipt[] = [];
  for (const event of accepted) {
    const started = typeof event.payload.startedAt === 'number' ? event.payload.startedAt : event.at;
    // Loom echoes command identity. Legacy sources don't: pair exact echoes once, within this
    // command's acceptance interval, never collapse two equal messages into one.
    const echo = owners.find(m => !used.has(m.messageId) && m.meta?.commandId === event.commandId)
      ?? owners.find(m => !used.has(m.messageId) && !m.meta?.commandId && messageText(m) === event.payload.text && m.at >= started && m.at <= event.at);
    if (echo) used.add(echo.messageId);
    const at = echo?.at ?? event.at;
    if (echo ? !unanswered(echo, replyAt) : at < (replyAt ?? -1)) continue;
    receipts.push(echo ? fromMessage(echo, event.commandId!) : { messageId: `command:${event.commandId}`, commandId: event.commandId!, at, text: event.payload.text as string, status: 'delivered' });
  }
  for (const message of owners) if (!used.has(message.messageId) && unanswered(message, replyAt)) receipts.push(fromMessage(message));
  return { ownerReceipts: receipts.sort((a, b) => a.at - b.at), receiptCommandIds: accepted.map(e => e.commandId!) };
}
function unanswered(m: DeskMessage, replyAt: number | null): boolean {
  return replyAt == null || m.meta?.queued === true || m.at >= replyAt || (m.meta?.runStartedAt ?? -1) >= replyAt;
}
function fromMessage(m: DeskMessage, commandId = m.meta?.commandId): OwnerReceipt {
  return { messageId: m.messageId, ...(commandId ? { commandId } : {}), at: m.at, text: messageText(m),
    status: m.meta?.queued === true ? 'queued' : typeof m.meta?.runStartedAt === 'number' && m.meta.runStartedAt >= m.at ? 'picked-up' : 'delivered' };
}

function messageText(m: DeskMessage): string {
  return m.text || (m.attachments?.length ? `(${m.attachments.length} images)` : '');
}
