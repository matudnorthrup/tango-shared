import { parsePrUrl } from './artifacts.js';
import type { DeskUpdate } from './updates.js';

// Rechecking (docs/specs/catch-up.md, "Kept current by what it rests on"): every catch-up line names the records it
// was built on, read from the fields already on it (its brief or decision, the PRs in its links), never from its words
// or a model's reading (R-21). When one of those records changes so that the line's meaning flips, the line is
// rechecked: an unseen line is quietly replaced with what is true now, and a seen one gets a single "Changed since you
// saw it" moment saying what the owner was told and what is true now. A reworded line never triggers it.

/** A record a line rests on: `decision:D-12` or `pr:owner/repo#3`. */
export type SourceKey = `decision:${string}` | `pr:${string}` | `ask:${string}`;

const DECISION_LINK = /\/decision\/(D-\d+)(?:[/?#]|$)/i;

/** The PR key for a PR link (`pr:owner/repo#3`), as the ledger's PR subjects spell it. */
export function prKey(url: string): `pr:${string}` | null {
  const pr = parsePrUrl(url);
  return pr ? `pr:${pr.url.replace(/^https:\/\/github\.com\//, '').replace('/pull/', '#').toLowerCase()}` : null;
}

/** What a line rests on, from its recorded fields: its brief or decision, decision links and PR links, its PR subject. */
export function sourcesOf(update: Pick<DeskUpdate, 'briefId' | 'decisionId' | 'refs' | 'subject'> & { data?: DeskUpdate['data'] }): SourceKey[] {
  const keys = new Set<SourceKey>();
  if (typeof update.data?.askId === 'string') keys.add(`ask:${update.data.askId}`);
  if (update.briefId) keys.add(`decision:${update.briefId}`);
  if (update.decisionId) keys.add(`decision:${update.decisionId}`);
  for (const ref of update.refs ?? []) {
    const decision = DECISION_LINK.exec(ref.url);
    if (decision) keys.add(`decision:${decision[1]!.toUpperCase()}`);
    const pr = prKey(ref.url);
    if (pr) keys.add(pr);
  }
  if (update.subject?.startsWith('pr:')) keys.add(update.subject.toLowerCase() as SourceKey);
  return [...keys];
}

/** What a record says now, as far as a line's meaning goes. */
export type SourceState =
  | { key: SourceKey; state: 'settled'; at: number; said: string | null }
  | { key: SourceKey; state: 'reverted'; at: number; by: { number: number; url: string } }
  | { key: SourceKey; state: 'closed'; at: number };

/** A flip in what a line means, and the line that says what is true now. */
export interface Flip {
  source: SourceState;
  /** What is true now, in the owner's words. */
  title: string;
  detail: string | null;
  refs: Array<{ label: string; url: string }>;
}

const bare = (title: string) => title.replace(/[.?!]+$/, '');

/**
 * Whether what a line rests on flipped its meaning, and what is true now. Only these flip: an ask whose decision is
 * settled (needs you → settled), and shipped work whose PR was reverted or closed without merging. A brief's own line
 * is settled where its brief is (syncBriefs), so only lines that name a decision they aren't are read here.
 */
export function flipOf(update: Pick<DeskUpdate, 'kind' | 'title' | 'source' | 'briefId' | 'decisionId' | 'refs' | 'subject' | 'resolvedAt'> & { data?: DeskUpdate['data'] }, state: (key: SourceKey) => SourceState | null): Flip | null {
  const sources = sourcesOf(update);
  if (update.kind === 'needs' && update.resolvedAt === null && update.source !== 'auto:brief') {
    for (const key of sources) {
      if (!key.startsWith('decision:') && !key.startsWith('ask:')) continue;
      const now = state(key);
      if (now?.state !== 'settled') continue;
      return { source: now, title: `No longer needs you: ${bare(update.title)}`, detail: now.said ? `Settled: ${bare(now.said)}.` : key.startsWith('ask:') ? 'Settled: the ask is no longer open.' : 'Settled: the decision it named was answered.', refs: update.refs };
    }
  }
  if (update.kind === 'shipped') {
    for (const key of sources) {
      if (!key.startsWith('pr:')) continue;
      const now = state(key);
      const number = key.split('#').pop();
      if (now?.state === 'reverted') {
        return { source: now, title: `Reverted: ${bare(update.title)}`, detail: `PR #${number} was undone by PR #${now.by.number}.`, refs: [...update.refs, { label: `PR #${now.by.number}`, url: now.by.url }] };
      }
      if (now?.state === 'closed') return { source: now, title: `Not shipped: ${bare(update.title)}`, detail: `PR #${number} was closed without merging.`, refs: update.refs };
    }
  }
  return null;
}

/** The body GitHub's Revert button writes ("Reverts owner/repo#12"), or the same repo's short form. */
export function revertedBy(body: string, repo: string): number[] {
  const out: number[] = [];
  const re = /\bReverts\s+([\w.-]+\/[\w.-]+)?#(\d+)\b/gi;
  for (let m = re.exec(body); m; m = re.exec(body)) if (!m[1] || m[1].toLowerCase() === repo.toLowerCase()) out.push(Number(m[2]));
  return out;
}
