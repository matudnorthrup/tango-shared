import { deskStatus } from './status.js';
import type { DeskItemRow } from './types.js';
import type { DeskCore } from './core.js';

/** Shared by store and Discord reads: timestamps are epoch milliseconds, never ids. */
export function continuesExchange(latest: DeskItemRow, author: 'agent' | 'owner' | 'other', at: number,
  attention: ReturnType<DeskCore['attention']>): boolean {
    if (at - latest.lastActivityAt > 24 * 3_600_000) return false;
    const disposition = attention.disposition;
    if (disposition === 'done') return false;
    if (disposition === 'parked' && author === 'agent') return true;
    if (author === 'owner') {
      if (latest.nextStep === 'your_move' || latest.nextStep === 'failed') return true;
      // The reply that started the agent's turn, read after the turn did: the chapter shows Working
      // already, but it was waiting on the owner and this message is the answer (else the old chapter keeps
      // its stale ask and the exchange carries on in a new one).
      return deskStatus({ ...latest, seen: attention.seen, disposition }).pill === 'needs';
    }
    // The owner spoke last and the agent is answering, however long its turn took.
    if (author === 'agent') return latest.facts.lastAuthor === 'owner' || latest.nextStep === 'working';
    return false;
}

export function joinsChapter(latest: DeskItemRow, author: 'agent' | 'owner' | 'other', at: number,
  attention: ReturnType<DeskCore['attention']>, gapMs = 30 * 60_000): boolean {
  return at - latest.lastActivityAt < gapMs || continuesExchange(latest, author, at, attention);
}

export function storeTime(timestamp: string): number {
  const at = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(timestamp) ? timestamp : timestamp.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(at)) throw new Error('Invalid store timestamp');
  return at;
}
