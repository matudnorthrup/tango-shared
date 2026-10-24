// What agents decided for the owner (docs/specs/decisions-and-delegation.md): Loom keeps the ledger, and the desk
// passes the owner's answers back (Fine by me, Undo, "I wouldn't have", how a rule counts) and keeps when the weekly
// Delegation review was last read. The decisions themselves reach the owner as catch-up lines (updates.ts).
import { savedRules, loomBriefPending, type LoomDecision, type LoomDecided, LoomReview, LoomRuleEvent } from './source-loom.js';
import type { DeskRuleSaved, PendingRequest } from './types.js';

const DAY = 86_400_000;
/** When the owner last put the weekly Delegation review away. */
const REVIEW_SEEN_KEY = 'delegation_review_seen_at';
const WEEK = 7 * DAY;

export interface DecidedSource {
  decided(since: number): Promise<{ decisions: LoomDecided[]; more: boolean; rules?: LoomRuleEvent[] } | null>;
  reverseDecision(decisionId: string, undo: boolean, note: string | null, commandId: string): Promise<{ ok: true } | { ok: false; error: string; unknown?: boolean }>;
  /** Fine by me (catch-up): Loom's decision.confirm, the opposite of a reversal. */
  confirmDecision?(decisionId: string, commandId: string): Promise<{ ok: true } | { ok: false; error: string; unknown?: boolean }>;
  ruleDecision?(decisionId: string, rule: 'always' | 'next-time' | 'once', reason: string | null, commandId: string, proposal?: string | null): Promise<{ ok: true; rule?: string | null; ruleState?: string | null } | { ok: false; error: string; unknown?: boolean }>;
  review?(since: number): Promise<LoomReview | null>;
  decision?(id: string): Promise<LoomDecision | undefined | null>;
  decisionIds?(): Promise<number[] | null>;
  reviewedRules?(ruleIds: string[], commandId: string): Promise<{ ok: true } | { ok: false; error: string; unknown?: boolean }>;
}

export class DeskDecided {
  constructor(
    private readonly options: {
      source: DecidedSource;
      settings: { setting(key: string): string | null; setSetting(key: string, value: string): void };
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** The numbers of the decisions Loom has; null when it can't be read. */
  async decisionIds(): Promise<number[] | null> {
    return this.options.source.decisionIds ? this.options.source.decisionIds() : null;
  }

  /** One decision for its page (TGO-1110); undefined: no such decision, null: Loom can't be read. */
  async decision(id: string): Promise<LoomDecision | undefined | null> {
    return this.options.source.decision ? this.options.source.decision(id) : null;
  }

  /** Changes how an answered brief counts: Always (makes its rule), Ask me next time, or Just this once. */
  async rule(decisionId: string, rule: 'always' | 'next-time' | 'once', reason: string | null, commandId: string, proposal: string | null = null) {
    if (!this.options.source.ruleDecision) return { ok: false as const, error: 'This Loom has no rules yet' };
    return this.options.source.ruleDecision(decisionId, rule, reason?.trim() || null, commandId, proposal);
  }

  reviewSeenAt(): number | null {
    const at = Number(this.options.settings.setting(REVIEW_SEEN_KEY));
    return Number.isFinite(at) && at > 0 ? at : null;
  }

  /**
   * The weekly Delegation review: the last week of what the learning loop did. `due` once a week has passed since the
   * owner last put it away (or they never have) and there is something in it; null when Loom can't be read.
   */
  async review(): Promise<{ due: boolean; seenAt: number | null; review: LoomReview } | null> {
    if (!this.options.source.review) return null;
    const now = this.now();
    const seenAt = this.reviewSeenAt();
    // From where the owner last read it, so nothing falls between two reviews; the first one covers the last week.
    // Never clamped once there is a cursor: a review left unread a long time still holds everything since the last one.
    const review = await this.options.source.review(seenAt !== null ? seenAt + 1 : now - WEEK);
    if (!review) return null;
    const something = review.created.length + review.suspended.length + review.demoted.length + review.due.length + review.dissent.length > 0;
    return { due: something && (seenAt === null || now - seenAt >= WEEK), seenAt, review };
  }

  /**
   * The owner read the review: it comes back in a week. `until` is the end of the review they saw, so a change that
   * landed after it was read is in the next one. Never moves back.
   */
  async reviewSeen(until?: number, ruleIds: string[] = [], commandId = `review-${until ?? this.now()}`): Promise<{ ok: true; seenAt: number } | { ok: false; error: string; unknown?: boolean }> {
    // The rules it showed as due move to their next review in Loom first; only then does the card go away.
    if (ruleIds.length && this.options.source.reviewedRules) {
      const sent = await this.options.source.reviewedRules(ruleIds, commandId);
      if (!sent.ok) return sent;
    }
    return { ok: true, seenAt: this.markReviewSeen(until) };
  }

  private markReviewSeen(until?: number): number {
    const now = this.now();
    const next = Math.min(typeof until === 'number' && Number.isFinite(until) ? Math.floor(until) : now, now);
    const was = this.reviewSeenAt();
    if (was === null || next > was) this.options.settings.setSetting(REVIEW_SEEN_KEY, String(next));
    return Math.max(next, was ?? 0);
  }

  reverse(decisionId: string, undo: boolean, note: string | null, commandId: string) {
    return this.options.source.reverseDecision(decisionId, undo, note?.trim() || null, commandId);
  }

  async confirm(decisionId: string, commandId: string): Promise<{ ok: true } | { ok: false; error: string; unknown?: boolean }> {
    if (!this.options.source.confirmDecision) return { ok: false, error: 'This Loom has no Fine by me yet' };
    return this.options.source.confirmDecision(decisionId, commandId);
  }
}

/** A row on the desk by its name: the thread a decision was raised, carried or answered on. */
export interface DecisionPlace {
  itemId: string;
  title: string;
}

/** How a closed brief ended: who decided, the option, their words and when. */
export interface DecisionOutcome {
  status: string;
  /** The owner on the desk or in a conversation, an agent (withdrawn, moot), a standing rule, or the veto window running out. */
  by: 'owner-desk' | 'owner-chat' | 'agent' | 'rule' | 'default' | 'other';
  option: { key: string; label: string } | null;
  text: string | null;
  reason: string | null;
  at: number | null;
  /** Answered in chat: the conversation the owner said it in, when that wasn't the thread that raised it. */
  in: DecisionPlace | null;
}

/** The brief page's payload (GET /api/desk/decisions/:id; TGO-1110). */
export interface DecisionPage {
  id: string;
  status: string;
  ask: string;
  class: string;
  level: number;
  revision: number;
  createdAt: number;
  raisedOn: DecisionPlace | null;
  carriedBy: DecisionPlace[];
  /** The open brief as the question card takes it, answered through the same path as on a row; null once closed. */
  pending: PendingRequest | null;
  /** The brief itself, for a closed one (the card is gone). */
  brief: LoomDecision['brief'];
  changes: NonNullable<LoomDecision['changes']>;
  outcome: DecisionOutcome | null;
  savedRule: DeskRuleSaved | null;
}

const OUTCOME_BY: Record<string, DecisionOutcome['by']> = { person: 'owner-desk', 'person-chat': 'owner-chat', agent: 'agent', stopped: 'agent', default: 'default' };

export function decisionPage(decision: LoomDecision, place: (id: string, fallback: string | null) => DecisionPlace | null, carriedBy: string[]): DecisionPage {
  const open = decision.status === 'open';
  const brief = decision.brief ?? ({} as LoomDecision['brief']);
  const raised = decision.thread_id ? place(`loom:${decision.thread_id}`, decision.raised_on?.title ?? null) : null;
  const chosen = brief.options?.find((o) => o.key === decision.answer_option);
  const by = decision.decided_by?.startsWith('rule:') ? 'rule' : OUTCOME_BY[decision.decided_by ?? ''] ?? 'other';
  const inChat = decision.decided_in && decision.decided_in !== decision.thread_id ? place(`loom:${decision.decided_in}`, decision.decided_on?.title ?? null) : null;
  return {
    id: decision.id,
    status: open && decision.discussing_since != null ? 'discussing' : decision.status,
    ask: decision.ask,
    class: decision.class,
    level: decision.level,
    revision: decision.revision ?? 1,
    createdAt: decision.created_at,
    raisedOn: raised,
    carriedBy: carriedBy.flatMap((id) => { const p = place(id, null); return p ? [p] : []; }),
    pending: open ? loomBriefPending(decision) : null,
    brief,
    savedRule: savedRules([decision])[0] ?? null,
    changes: decision.changes ?? [],
    outcome: open ? null : { status: decision.status, by, option: chosen ? { key: chosen.key, label: chosen.label } : null, text: decision.answer_text ?? null, reason: decision.answer_reason ?? null, at: decision.resolved_at ?? null, in: inChat },
  };
}
