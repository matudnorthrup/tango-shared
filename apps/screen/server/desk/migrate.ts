import type { DeskCore } from './core.js';

// One-time import of the owner's decisions from the old inbox (inbox_items,
// left untouched) onto desk items:
//
//   later                            → parked (not a T3 item that was `later` only
//                                      because T3 snoozed it: it keeps the source snooze)
//   dismissed, read with a done note → done
//   acked (👍), heard, plain read    → seen (plain = no note, or 'replied')
//
// An old item maps to a desk item by id (thread:<id> → discord:thread:<id>;
// t3:<id> is the same) or, for chat topics, through its latest agent message.
// Run once the sources have read their conversations: the caller passes
// `ready` only after the first successful source poll. A marker in
// desk_settings makes it idempotent.

const MARKER = 'migrated_inbox_v1';

interface OldItem {
  id: string;
  state: string;
  note: string | null;
  acked: number;
  last_agent_message_id: string | null;
  state_at: number;
}

export function migrateInboxDecisions(
  core: DeskCore,
  options: { ready?: boolean } = {},
): { skipped: boolean; waiting?: boolean; parked: number; done: number; seen: number; unmatched: number } {
  const { store } = core;
  const counts = { skipped: false, parked: 0, done: 0, seen: 0, unmatched: 0 };
  if (store.setting(MARKER)) return { ...counts, skipped: true };
  // Not before every source has answered once: decisions only land on items that exist.
  if (options.ready === false) return { ...counts, waiting: true };
  const hasTable = store.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'inbox_items'").get();
  const columns = hasTable ? (store.db.prepare('PRAGMA table_info(inbox_items)').all() as Array<{ name: string }>).map((column) => column.name) : [];
  const rows = hasTable
    ? (store.db.prepare(`SELECT id, state, note, ${columns.includes('acked') ? 'acked' : '0 AS acked'}, last_agent_message_id, state_at FROM inbox_items`).all() as unknown as OldItem[])
    : [];
  // Nothing read from the sources yet: wait (the caller retries after the next poll) rather than mark it done.
  if (rows.length && store.items().length === 0) return counts;
  for (const row of rows) {
    const finished = row.state === 'dismissed' || (row.state === 'read' && row.note !== null && row.note !== 'replied');
    const plainRead = row.state === 'read' && !finished;
    // `later` only because T3 snoozed it: the desk reads T3's snooze itself and keeps it apart.
    const t3Snooze = row.state === 'later' && row.id.startsWith('t3:') && row.note === 'snoozed in T3';
    const decision = t3Snooze ? null : row.state === 'later' ? 'park' : finished ? 'done' : row.acked === 1 || row.state === 'heard' || plainRead ? 'seen' : null;
    if (!decision) continue;
    const direct = row.id.startsWith('thread:') ? `discord:${row.id}` : row.id.startsWith('t3:') ? row.id : null;
    const viaMessage = row.last_agent_message_id ? store.itemForMessage(row.last_agent_message_id) : null;
    const itemId = (direct && store.item(direct) ? direct : null) ?? viaMessage;
    const item = itemId ? store.item(itemId) : null;
    if (!item) {
      counts.unmatched += 1;
      continue;
    }
    // The agent said something after the decision: that newer activity stands.
    if (decision !== 'park' && item.lastActivityAt > row.state_at) continue;
    core.importDecision(item.id, decision, { migrated: true, from: row.state, note: row.note, ...(decision === 'seen' ? { via: 'explicit' } : {}) });
    counts[decision === 'park' ? 'parked' : decision] += 1;
  }
  store.setSetting(MARKER, JSON.stringify(counts));
  return counts;
}

/** Stored coordinator thread ids predate Loom; retain their identity for history and hiding retired rows. */
export const legacyCoordinatorItemId = (threadId: string): string => `t3:${threadId}`;
