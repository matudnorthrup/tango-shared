import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parsePrUrl } from './artifacts.js';
import { DELIVERY_UNKNOWN, type DeskCore } from './core.js';
import { aggregateReviews } from './next-step.js';
import type { DeskFacts, Log, PrChecksFact, PrReviewFact, PrWatch } from './types.js';

// PR review state through the `gh` CLI (its own auth; no token here), for a T3
// thread's branchPullRequest and linked PRs (not on ops / project coordinators,
// which link the PRs they oversee), and for every PR registered as watched on any item
// (T3 or Discord). Sign-in is retried each poll; failed watches record the error.
//
//   review requested, pending    → watching, waiting on the reviewer(s)
//   review required, none left   → watching too (a reviewer who commented drops
//                                  off reviewRequests, but the PR still waits)
//   approved or changes requested → wake the agent; never an owner move.
// Status remains governed by desk-status.md and the recorded waits/handoffs.
//
// The same read carries CI (the check rollup) → facts.prChecks: failing, running
// or passing on the item's worst open PR. Shown on the row; it never changes the step.
//
// These are source facts, so they beat the summarizer. The desk is the watcher:
// it outlives any agent session, so a review that takes two weeks still lands.
// A watched PR with onApprove "continue" wakes its agent once per approval (a
// desk message into the conversation); a merged or closed one drops off.

export type Exec = (command: string, args: string[]) => Promise<string>;

export const defaultExec: Exec = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 20_000, maxBuffer: 1_000_000 }, (err, stdout) => (err ? reject(Object.assign(err, { stdout })) : resolve(stdout)));
  });

export const GH_PR_FIELDS = 'reviewRequests,reviews,reviewDecision,state,isDraft,statusCheckRollup';

interface GhReview {
  state?: string;
  author?: { login?: string };
  authorAssociation?: string;
  submittedAt?: string;
}

/** One entry of gh's statusCheckRollup: a check run (status + conclusion) or a commit status (state). */
interface GhCheck {
  __typename?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
}

interface GhPr {
  state?: string;
  statusCheckRollup?: GhCheck[] | null;
  isDraft?: boolean;
  reviewDecision?: string | null;
  reviewRequests?: Array<{ login?: string; name?: string; slug?: string }>;
  reviews?: GhReview[];
}

const keyOf = (url: string) => (parsePrUrl(url)?.url ?? url).toLowerCase();

/** People, not review bots: a `[bot]` login, or an account with no tie to the repo (a GitHub App's user). */
function human(review: GhReview): string | null {
  const login = review.author?.login;
  if (!login || /\[bot\]$/i.test(login) || review.authorAssociation === 'NONE') return null;
  return login;
}

/** Each person's standing decision: their latest approve / request-changes (a comment doesn't change it; a dismissal clears it). */
function decisions(reviews: GhReview[]): { approving: string[]; blocking: string[]; reviewed: string[] } {
  const latest = new Map<string, string | null>();
  const reviewed: string[] = [];
  for (const review of reviews) {
    const login = human(review);
    if (!login) continue;
    if (!reviewed.includes(login)) reviewed.push(login);
    if (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED') latest.set(login, review.state);
    else if (review.state === 'DISMISSED') latest.set(login, null);
  }
  const who = (state: string) => [...latest].filter(([, value]) => value === state).map(([login]) => login);
  return { approving: who('APPROVED'), blocking: who('CHANGES_REQUESTED'), reviewed };
}

/**
 * gh's answer → the review fact (null: nothing to wait on or act on). `explicit`: a watched PR,
 * which waits on review even in a repo that doesn't require one, and even as a draft. Exposed for tests.
 */
export function reviewFact(pr: GhPr, number: number, previous: PrReviewFact | null | undefined, now: number, options: { explicit?: boolean } = {}): PrReviewFact | null {
  if (pr.state && pr.state !== 'OPEN') return null;
  const requested = (pr.reviewRequests ?? []).map((request) => request.login ?? request.name ?? request.slug ?? '').filter(Boolean);
  const { approving, blocking, reviewed } = decisions(pr.reviews ?? []);
  let state: PrReviewFact['state'] | null = null;
  let reviewers = requested;
  if (pr.reviewDecision === 'APPROVED') [state, reviewers] = ['approved', approving];
  else if (pr.reviewDecision === 'CHANGES_REQUESTED') [state, reviewers] = ['changes_requested', blocking];
  else if (requested.length) state = 'pending';
  // Still needs an approval though nobody is formally requested any more (they commented, or were never asked on GitHub).
  else if (pr.reviewDecision === 'REVIEW_REQUIRED' && (!pr.isDraft || options.explicit)) [state, reviewers] = ['pending', reviewed];
  else if (options.explicit) {
    // No review rule on the repo: the reviewers' own decisions say it.
    if (blocking.length) [state, reviewers] = ['changes_requested', blocking];
    else if (approving.length) [state, reviewers] = ['approved', approving];
    else [state, reviewers] = ['pending', reviewed];
  }
  if (!state) return null;
  // `since` holds while the state does: it is how long the wait has lasted.
  const since = previous && previous.state === state && previous.number === number ? previous.since : now;
  if (state === 'pending') return { state, reviewers, number, since };
  // When the deciding review landed: agent words after it outrank the decision (next-step).
  const deciding = state === 'approved' ? 'APPROVED' : 'CHANGES_REQUESTED';
  const times = (pr.reviews ?? []).filter((review) => review.state === deciding && human(review)).map((review) => Date.parse(review.submittedAt ?? '')).filter(Number.isFinite);
  return { state, reviewers, number, since, decidedAt: times.length ? Math.max(...times) : null };
}

export { aggregateReviews } from './next-step.js';

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
/** What GitHub accepts from a finished check run; anything else (STALE, an unknown one) needs a look (review on #516). */
const PASSED = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);

/** An open PR's CI from its check rollup; null when it has no checks (or isn't open). Exposed for tests. */
export function checksFact(pr: GhPr, number: number): PrChecksFact | null {
  if (pr.state && pr.state !== 'OPEN') return null;
  const checks = pr.statusCheckRollup ?? [];
  if (!checks.length) return null;
  const outcome = (check: GhCheck) => {
    if (check.__typename === 'StatusContext' || (check.state && !check.status)) {
      const state = (check.state ?? '').toUpperCase();
      return FAILED.has(state) ? 'failing' : state === 'SUCCESS' ? 'passing' : 'running';
    }
    if ((check.status ?? '').toUpperCase() !== 'COMPLETED') return 'running';
    return PASSED.has((check.conclusion ?? '').toUpperCase()) ? 'passing' : 'failing';
  };
  const states = checks.map(outcome);
  return { state: states.includes('failing') ? 'failing' : states.includes('running') ? 'running' : 'passing', number };
}

const CHECKS_RANK: Record<PrChecksFact['state'], number> = { failing: 0, running: 1, passing: 2 };
/** Failed reads in a row (polls are 5 min apart) before a PR's last known CI is dropped. */
const CHECKS_MAX_MISSES = 3;

/** The desk's message to the agent when a watched PR is approved. */
export function wakeText(review: PrReviewFact & { url: string }): string {
  const by = review.reviewers.length ? ` by ${review.reviewers.join(', ')}` : '';
  if (review.state === 'changes_requested') return `[Desk] Changes requested on PR #${review.number}${by}: ${review.url}\nPick this back up, address the review and run the required checks. Raise a decision brief if a product decision needs the owner.`;
  return [
    `[Desk] PR #${review.number} was approved${by}: ${review.url}`,
    "Pick this back up. Merge it if this project's rules allow (re-check CI on the current head, unresolved review threads, and any merge gates first), then report the merge. If something stops you, say which gate and what you need from me.",
  ].join('\n');
}

export class DeskGitHubReviews {
  private authError: string | null = null;
  private readonly exec: Exec;
  private readonly now: () => number;
  private running: Promise<number> | null = null;

  constructor(private readonly options: { core: DeskCore; exec?: Exec; now?: () => number; log?: Log }) {
    this.exec = options.exec ?? defaultExec;
    this.now = options.now ?? Date.now;
  }

  /** Re-check sign-in each poll so a startup failure can recover (owner, 10/20). */
  async isAvailable(): Promise<boolean> {
    try { await this.exec('gh', ['auth', 'status']); this.authError = null; return true; }
    catch (e) { this.authError = String(e); return false; }
  }

  /** Active items with a PR (T3's branch PR, or watched ones): read each PR's review state. One poll at a time. */
  poll(): Promise<number> {
    this.running ??= this.pollOnce().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async pollOnce(): Promise<number> {
    const { core } = this.options;
    await this.isAvailable();
    let checked = 0;
    for (const item of core.items()) {
      const facts = item.facts;
      const watches = facts.prWatches ?? [];
      // A done item is left alone, unless someone asked for a PR to be watched there: that wait outlives Done.
      if (item.disposition === 'done' && !watches.length) {
        // No longer read: its CI would go stale (History would show it for good), so it goes (review on #516).
        if (facts.prChecks || facts.prChecksAll) core.setFacts(item.id, { prChecks: null, prChecksAll: null });
        continue;
      }
      const targets = new Map<string, { url: string; number: number; explicit: boolean }>();
      for (const watch of watches) targets.set(keyOf(watch.url), { url: watch.url, number: watch.number, explicit: true });
      if (!targets.size) {
        if (facts.prReview || facts.prReviews || facts.prChecks || facts.prChecksAll) {
          core.setFacts(item.id, { prReview: null, prReviews: null, prChecks: null, prChecksAll: null });
          core.refresh(item.id, { emitStep: true });
        }
        continue;
      }

      const before = new Map((facts.prReviews ?? []).map((review) => [keyOf(review.url), review]));
      const reviews: Array<PrReviewFact & { url: string }> = [];
      const checksBefore = new Map((facts.prChecksAll ?? []).map((ci) => [keyOf(ci.url), ci]));
      const checksAll: Array<PrChecksFact & { url: string; misses?: number }> = [];
      const ended = new Set<string>();
      const observed = new Set<string>();
      for (const [key, target] of targets) {
        // Facts from before per-PR tracking: the old single fact still carries `since`.
        const previous = before.get(key) ?? (facts.prReview?.number === target.number ? facts.prReview : null);
        try {
          if (this.authError) throw new Error(`PR watch offline: ${this.authError}`);
          const pr = JSON.parse(await this.exec('gh', ['pr', 'view', target.url, '--json', GH_PR_FIELDS])) as GhPr;
          const watch = core.item(item.id)?.facts.prWatches?.find(w => keyOf(w.url) === key);
          if (watch) this.updateWatch(item.id, key, { last_checked_at: this.now(), last_error: null, error_since: null, consecutive_errors: 0, error_woken: false });
          if (pr.state && pr.state !== 'OPEN') {
            const delivered = !watch || watch.onApprove !== 'continue' || await this.send(item.id, watch, `[Desk] PR #${target.number} is ${pr.state.toLowerCase()}: ${target.url}. Pick this back up and report what remains.`);
            if (delivered) ended.add(key);
          }
          const fact = reviewFact(pr, target.number, previous, this.now(), { explicit: target.explicit });
          if (fact) reviews.push({ ...fact, url: target.url });
          const ci = checksFact(pr, target.number);
          if (ci) checksAll.push({ ...ci, url: target.url });
          checked += 1; observed.add(key);
          // News for the feed (desk/feed.ts): a review decided, or CI turning red. Only on a change, never on first sight.
          const post = { itemId: item.id, agentName: item.agentName, text: core.title(item), data: { url: target.url, number: target.number } };
          if (fact && previous && fact.state !== 'pending' && previous.state !== fact.state) {
            const who = fact.reviewers.length ? ` by ${fact.reviewers.join(', ')}` : '';
            core.postFeed({ ...post, kind: 'pr', title: fact.state === 'approved' ? `PR #${target.number} approved${who}` : `Changes requested on PR #${target.number}${who}` });
          }
          const ciBefore = checksBefore.get(key);
          if (ci?.state === 'failing' && ciBefore && ciBefore.state !== 'failing') core.postFeed({ ...post, kind: 'pr', title: `CI failing on PR #${target.number}` });
        } catch (err) {
          const watch = core.item(item.id)?.facts.prWatches?.find(w => keyOf(w.url) === key);
          if (watch) {
            const errors = (watch.consecutive_errors ?? 0) + 1;
            this.updateWatch(item.id, key, { last_checked_at: this.now(), last_error: String(err), error_since: watch.error_since ?? this.now(), consecutive_errors: errors });
            if (errors >= 3 && !watch.error_woken && await this.send(item.id, watch, `[Desk] Your wait on PR #${watch.number} can't be checked: ${String(err)}`)) this.updateWatch(item.id, key, { error_woken: true });
          }
          // Like the reviews: a failed read keeps this PR's last CI, and only this PR's, but not for good:
          // after a few misses in a row (gh signed out, the repo gone) it's dropped (review on #516).
          const keptChecks = checksBefore.get(key);
          const misses = (keptChecks?.misses ?? 0) + 1;
          if (keptChecks && misses < CHECKS_MAX_MISSES) checksAll.push({ ...keptChecks, misses });
          // A failed read keeps what was known: a gh hiccup is not a review.
          const kept = before.get(key);
          if (kept) reviews.push(kept);
          this.options.log?.('desk.github.error', { itemId: item.id, url: target.url, message: (err as Error).message });
        }
      }

      // Merged or closed: the watch is over.
      const kept = (core.item(item.id)?.facts.prWatches ?? []).filter((watch) => !ended.has(keyOf(watch.url)));
      const next: Partial<DeskFacts> = { prReviews: reviews.length ? reviews : null, prReview: aggregateReviews(reviews) };
      if (kept.length !== watches.length) next.prWatches = kept.length ? kept : null;
      // The row shows the worst PR's CI; CI alone never moves the step.
      const worst = checksAll.reduce<(PrChecksFact & { url: string; misses?: number }) | null>((best, ci) => (!best || CHECKS_RANK[ci.state] < CHECKS_RANK[best.state] ? ci : best), null);
      const nextChecks = worst ? { state: worst.state, number: worst.number } : null;
      const nextAll = checksAll.length ? checksAll : null;
      if (JSON.stringify(nextAll) !== JSON.stringify(facts.prChecksAll ?? null) || JSON.stringify(nextChecks) !== JSON.stringify(facts.prChecks ?? null)) core.setFacts(item.id, { prChecks: nextChecks, prChecksAll: nextAll });
      if (JSON.stringify(next.prReviews) !== JSON.stringify(facts.prReviews ?? null) || JSON.stringify(next.prReview) !== JSON.stringify(facts.prReview ?? null) || next.prWatches !== undefined) {
        core.setFacts(item.id, next);
        core.refresh(item.id, { emitStep: true });
        if (next.prWatches !== undefined) this.options.log?.('desk.github.watch.ended', { itemId: item.id, urls: watches.filter((watch) => ended.has(keyOf(watch.url))).map((watch) => watch.url) });
      }

      if (item.replyable === false) continue;
      for (const { url } of kept) {
        // Read the watch again: it may have been stopped or turned to notify while gh was answering.
        const watch = (core.item(item.id)?.facts.prWatches ?? []).find((candidate) => keyOf(candidate.url) === keyOf(url));
        const review = reviews.find((candidate) => keyOf(candidate.url) === keyOf(url));
        if (!observed.has(keyOf(url)) || !watch || !review || review.state === 'pending' || (review.state === 'approved' && watch.onApprove !== 'continue') || (watch.wokeFor === review.since && (watch.wokeState ?? 'approved') === review.state)) continue;
        await this.wake(item.id, watch, review);
      }
    }
    core.flush();
    return checked;
  }

  private updateWatch(itemId: string, key: string, patch: Partial<PrWatch>): void {
    const { core } = this.options;
    core.setFacts(itemId, { prWatches: (core.item(itemId)?.facts.prWatches ?? []).map(w => keyOf(w.url) === key ? { ...w, ...patch } : w) });
  }

  private async send(itemId: string, watch: PrWatch, text: string): Promise<boolean> {
    const result = await this.options.core.command({ commandId: randomUUID(), type: 'reply', itemId, actor: 'system', args: { text } });
    this.options.log?.('desk.github.wake', { itemId, url: watch.url, status: result.status });
    return result.status !== 'failed' || result.error === DELIVERY_UNKNOWN;
  }

  /** Posts the approval into the conversation as a desk message; marks the watch woken only once it was delivered. */
  private async wake(itemId: string, watch: PrWatch, review: PrReviewFact & { url: string }): Promise<void> {
    const { core } = this.options;
    const text = review.state === 'changes_requested'
      ? `[Desk] Changes requested on PR #${review.number}: ${review.url}. Pick this back up, address the review, and report the result.`
      : wakeText(review);
    if (!(await this.send(itemId, watch, text))) return;
    const watches = (core.item(itemId)?.facts.prWatches ?? []).map((candidate) => (keyOf(candidate.url) === keyOf(watch.url) ? { ...candidate, wokeFor: review.since, wokeState: review.state as 'approved' | 'changes_requested' } : candidate));
    core.setFacts(itemId, { prWatches: watches });
  }
}
