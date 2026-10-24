import { BARE_TITLE, isRuleEvent, ownerTitle, PR_CLASSES, prOf, prRefs } from './collapse.js';
import type { DeskFeed, FeedKind, LedgerPostInput } from './feed.js';
import { plainWords } from '../../public/desk/plain-words.js';
import type { DeskItem } from './types.js';
import type { DeskUpdate, DeskUpdates, UpdateSource } from './updates.js';

// The Feed's posts from the catch-up ledger (docs/specs/feed-status.md "Feed and catch-up"): every ledger row the
// Feed reads is one post, by its kind. Decided for you, Shipped and a lead's own Update come only from here.

/**
 * The ledger sources the Feed reads. The rest already post another way: a brief's row entering Needs you and the
 * evaluator's own rows (auto:brief, auto:status) through status.entered, an incident as its System post, a row
 * marked done as its Done post.
 */
export const FEED_LEDGER_SOURCES: ReadonlySet<UpdateSource> = new Set(['lead', 'auto:pr', 'auto:decision', 'auto:handoff']);

/** A row this old when the Feed hears of it is history (a backfill, a desk back from a restart), not news. */
export const FEED_LEDGER_RECENT_MS = 2 * 3600_000;

const KIND: Partial<Record<DeskUpdate['kind'], FeedKind>> = { decided: 'decided', shipped: 'shipped', fyi: 'update' };
const RANK: Partial<Record<UpdateSource, number>> = { lead: 3, 'auto:pr': 2, 'auto:decision': 1, 'auto:handoff': 1 };

/** The PR a row is about, as catch-up folds it: the merge's own, a lead's one linked PR, a routine decision's. */
function prKey(line: DeskUpdate): string | null {
  if (line.source === 'auto:pr') return prOf(line)?.key ?? null;
  const { full, bare } = prRefs(line);
  if (full.length !== 1) return null;
  if (line.source === 'lead') return line.kind === 'decided' && !PR_CLASSES.has(line.class ?? '') && !bare.includes(Number(full[0]!.split('#')[1])) ? null : full[0]!;
  // A decision: a routine one about the PR itself (collapse.ts `about`). A moment or a rule change is its own news.
  if (line.moment || isRuleEvent(line)) return null;
  return PR_CLASSES.has(line.class ?? '') || bare.includes(Number(full[0]!.split('#')[1])) ? full[0]! : null;
}

/** A ledger row as a Feed post, or null when the Feed doesn't post it. */
export function ledgerPost(line: DeskUpdate, item: DeskItem | null, now: number): LedgerPostInput | null {
  const kind = KIND[line.kind];
  // Needs you and Failed post from status.entered: a lead's line in that pill is the same entry.
  if (!kind || !FEED_LEDGER_SOURCES.has(line.source) || line.supersededBy !== null) return null;
  // The owner's own act (an undo they made) isn't news to them; nor is an old line.
  if (line.seenVia === 'acted' || now - line.at > FEED_LEDGER_RECENT_MS) return null;
  const pr = prKey(line);
  const title = line.source === 'lead' ? plainWords(line.title) || BARE_TITLE : ownerTitle(line.title);
  return {
    post: {
      kind,
      itemId: line.itemId,
      projectId: item?.facts.projectId ?? null,
      agentName: item?.agentName ?? '',
      title,
      text: line.detail ?? '',
      at: line.at,
      key: pr ? `pr:${pr}` : `ledger:${line.subject ?? line.id}`,
      data: {
        source: 'ledger',
        ledgerSource: line.source,
        // The record's own title heads the post, as a summary's headline does (feed.js Post).
        headline: true,
        ...(line.source === 'lead' ? { lead: true } : {}),
        ...(line.refs.length ? { links: line.refs } : {}),
        ...(line.decisionId ? { decisionId: line.decisionId } : {}),
        ...(line.class ? { class: line.class } : {}),
        ...(pr ? { pr } : {}),
      },
    },
    ref: `ledger:${line.id}`,
    rank: RANK[line.source] ?? 0,
    pr: !!pr,
    replaces: line.supersedes !== null ? `ledger:${line.supersedes}` : null,
  };
}

/** Posts each ledger row the Feed reads as it is written, and takes back the post of one retracted. Returns the unsubscribe. */
export function followLedger(updates: DeskUpdates, feed: DeskFeed, item: (itemId: string) => DeskItem | null, now: () => number = Date.now): () => void {
  return updates.subscribe((ids) => {
    for (const id of ids) {
      const line = updates.get(id);
      // A row taken back (updates.retract) takes its post with it.
      if (!line) {
        feed.unpostLedger(`ledger:${id}`);
        continue;
      }
      const input = line ? ledgerPost(line, line.itemId ? item(line.itemId) : null, now()) : null;
      if (input) feed.postLedger(input);
    }
  });
}
