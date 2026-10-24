import { deskStatus } from './status.js';
import type { DeskFacts, DeskSummary, DeskWatching, NextStep, Overdue, ThreadPr, PrReviewFact } from './types.js';

// Compatibility next-step projection. All decisions come from status.ts; summaries explain only.

/** A turn with no word for this long is treated as gone (a crashed bot never sends turn.finished). */
export const RUNNING_STALE_MS = 30 * 60_000;
/** Without bot turn events, the owner's last word means "working" for this long. */
export const OWNER_LAST_WORKING_MS = 20 * 60_000;
/** Watching goes quiet this long after the expected update. */
export const WATCH_GRACE_MS = 15 * 60_000;
/** Default nudge gap for a wait on a person (desk_settings waiting_nudge_hours). */
export const WAITING_NUDGE_MS = 48 * 3_600_000;
/** An inferred "an update is coming" with no time given goes quiet after this long without words. */
export const SUMMARY_WATCH_QUIET_MS = 24 * 3_600_000;
/** A wait on another agent (a "Desk" thread, Codex) isn't the owner's to nudge: it only comes back after this long. */
export const AGENT_WAIT_QUIET_MS = 7 * 24 * 3_600_000;

export interface StepInput {
  facts: DeskFacts;
  prs?: ThreadPr[];
  summary: DeskSummary | null;
  /** Fallback when there is no summary yet: the deterministic read of the last agent message. */
  fallbackStep: 'your_move' | 'fyi';
  lastActivityAt: number;
  lastOwnerMessageAt: number | null;
  /** The latest agent message: words after a PR review decision outrank it. */
  lastAgentAt?: number | null;
  now: number;
  /** Legacy replay input; closing prose does not determine status. */
  handoff?: Handoff | null;
  /** Legacy replay input; recorded asks and handoffs now live in facts. */
  standing?: { handoff: Handoff; at: number } | null;
  /** A wait on a person goes quiet after this long (default 48 h). */
  waitingNudgeMs?: number;
  /** Formats the expected-update time for an overdue check-back; injectable for tests. */
  formatTime?: (ms: number) => string;
}

export interface StepResult {
  step: NextStep;
  basis: string;
  ask: string | null;
  options: string[];
  watching: DeskWatching | null;
}

export interface Handoff {
  owner: 'you' | 'me' | 'waiting' | 'none';
  /** What follows the label, in plain text ('' when nothing does). */
  text: string;
}

const HANDOFF = /^\s*\*{0,2}\s*Next\s*[—–-]+\s*(you|me|none|waiting on\b[^:*]*)\s*:?\s*\*{0,2}\s*:?\s*(.*)$/i;

/**
 * The agent's closing hand-off ("**Next — you:** merge #12"): the line every agent ends a turn with
 * to say whose move it is. The last such line counts, and only when it closes the message (a few
 * list lines may follow an empty "Next — you:"); a line quoted mid-message is not a hand-off.
 */
export function closingHandoff(text: string): Handoff | null {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = HANDOFF.exec(lines[index]!);
    if (!match) continue;
    const after = lines.slice(index + 1).map((line) => line.trim()).filter(Boolean);
    if (after.length > 8) return null;
    const label = match[1]!.toLowerCase();
    const rest = [match[2]!, ...(match[2]!.trim() ? [] : after)]
      .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').replace(/[*_`]/g, '').trim())
      .filter(Boolean)
      .join('; ');
    // The owner's name is private profile configuration, never a repository default.
    const ownerName = process.env.TANGO_OWNER_NAME?.trim().toLowerCase();
    const waitingOn = label.startsWith('waiting on ') ? label.slice(11).trim() : null;
    const owner = waitingOn && (/^(you|the owner|owner|user|the user)$/i.test(waitingOn) || waitingOn === ownerName)
      ? 'you' : waitingOn !== null ? 'waiting' : (label as Handoff['owner']);
    return { owner, text: rest.length > 200 ? `${rest.slice(0, 199).trimEnd()}…` : rest };
  }
  return null;
}

export function localTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function watchUntilMs(summary: DeskSummary | null): number | null {
  if (!summary?.watchUntil) return null;
  const ms = Date.parse(summary.watchUntil);
  return Number.isFinite(ms) ? ms : null;
}

const RANK: Record<PrReviewFact['state'], number> = { changes_requested: 0, pending: 1, approved: 2 };

/** One fact for the card: changes requested on any PR first, then one still waiting, then approved. */
export function aggregateReviews(reviews: PrReviewFact[]): PrReviewFact | null {
  let best: PrReviewFact | null = null;
  for (const review of reviews) if (!best || RANK[review.state] < RANK[best.state]) best = review;
  if (!best) return null;
  return { state: best.state, reviewers: best.reviewers, number: best.number, since: best.since, ...(best.decidedAt !== undefined ? { decidedAt: best.decidedAt } : {}) };
}

/** A decision the agent already spoke after: its newer words say where that PR stands. */
function answered(review: PrReviewFact, lastAgentAt: number | null | undefined): boolean {
  return review.state !== 'pending' && !!review.decidedAt && !!lastAgentAt && lastAgentAt > review.decidedAt;
}

/** What a Waiting row waits on, as the Wait facet reads it: a PR review is not a background monitor (Codex review on #928). */
function watchBasis(basis: string): DeskWatching['basis'] {
  return basis === 'source:pr-review' ? 'person' : basis === 'source:job' ? 'job' : basis === 'source:background' ? 'background' : 'summary';
}

export function deriveNextStep(input: StepInput): StepResult {
  const facts = { ...input.facts };
  const status = deskStatus({ facts, prs: input.prs, seen: 'seen', lastOwnerMessageAt: input.lastOwnerMessageAt }, input.now);
  const step: NextStep = status.pill === 'needs' ? 'your_move' : status.pill === 'failed' || status.pill === 'stuck' ? 'failed' : status.pill === 'working' ? 'working' : status.pill === 'waiting' ? 'watching' : 'fyi';
  return { step, basis: status.basis, ask: step === 'your_move' ? facts.pending?.question || facts.openBrief?.question || facts.openAsk?.text || facts.handoff?.text || status.detail : step === 'failed' ? facts.failed?.message || status.detail : null,
    options: facts.pending?.options ?? [], watching: step === 'watching' ? { reason: status.detail, basis: watchBasis(status.basis), nextCheckAt: null, waitingOn: null } : null };

}

/** The desk's message to an agent whose own check-back is late (core.tick): what it promised, and what to say now. */
export function overdueWakeText(overdue: Overdue): string {
  return [
    `[Desk] Your check-back is late: ${overdue.text}, and nothing has arrived since.`,
    'Where does this stand? If it is done, say so and close with "Next — none". If it waits on someone, name them with "Next — waiting on <who>: …". If you are still on it, say when the next update lands.',
  ].join('\n');
}
