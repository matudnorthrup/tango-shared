// Shared shapes for the Agent Desk (docs/specs/agent-desk.md). Three
// authorities, each with one owner:
//
//   source facts     adapters (Discord, Loom, background jobs, bot agent events)
//   owner attention  the reducer over desk_events (attention.ts)
//   presentation     the hub (not here; P3)

import type { MessageAttachment } from './attachments.js';

/** `t3` is retained only to read historical desk records; no adapter is registered. */
export type DeskSource = 'discord' | 't3' | 'loom' | 'schedule' | 'system';

/**
 * Who a conversation works for (docs/specs/resilient-runtime.md "Thread roles"): the owner (interactive,
 * the default), its parent thread (worker), the owner only when it asks (ops: standing, schedule-driven),
 * or the owner while it manages workers (coordinator).
 */
export const THREAD_ROLES = ['interactive', 'worker', 'ops', 'default'] as const;
export type ThreadRole = (typeof THREAD_ROLES)[number];

/** A Codex worker an agentctl task runs for a conversation (source-agentctl.ts), until Codex runs on Loom. */
export interface CodexWorker {
  /** `agentctl:<project>/<task>` */
  id: string;
  project: string;
  task: string;
  /** agentctl's own status (worker_running, review, worker_failed, …). */
  status: string;
  state: 'working' | 'failed' | 'finished' | 'idle';
  branch: string | null;
  account: string | null;
  startedAt: number;
  updatedAt: number;
  /** The start of the worker's last message, when it left one. */
  lastMessage: string | null;
}

/** A coding thread (Loom): it lives in a repo's workspace and gets a type guessed for it. */
export const isCodingThread = (item: { source: DeskSource }): boolean => item.source === 'loom';
export type DeskKind = 'thread' | 'chapter';
/**
 * A Discord channel split by time into items (conversation `channel:<id>`): an agent's home chapters, and an
 * intake channel's requests (kind thread, one per request). They share one live turn, handed to the newest item.
 */
export const splitByTime = (item: { conversationKey: string }): boolean => item.conversationKey.startsWith('channel:');
export type NextStep = 'your_move' | 'failed' | 'working' | 'watching' | 'fyi';
export const NEXT_STEPS: readonly NextStep[] = ['your_move', 'failed', 'working', 'watching', 'fyi'];

/**
 * What kind of ask the agent handed the owner (owner, 10/18): a decision only they can give and the agent waits
 * on (the pill); a to-do, an action in the world the agent cannot do, with its own list; or soft, optional.
 */
export type AskKind = 'decision' | 'todo' | 'soft';
/** open; expired (past the date it named); superseded (an older chapter's, asked again in a newer one); duplicate (the same ask on another row, which carries it). */
export type AskState = 'open' | 'expired' | 'superseded' | 'duplicate';

/** The ask on an item, with its lifecycle (desk/asks.ts). Derived, like `watching`; never set by a source. */
export interface AskRecord {
  /** Where it was read from: a source request, Loom's record, the closing "Next — you" line, a PR decision, or the summary. */
  source: 'pending' | 'recorded' | 'next-line' | 'pr-review' | 'summary';
  text: string;
  kind: AskKind;
  /** Who decided the kind: the source (exact), the summary, or the words (desk/asks.ts guessAskKind). */
  /** Who said what kind it is; `blocking`: called a to-do, but the agent's work waits on it (asks.ts blocksAgent). */
  kindBy: 'source' | 'summary' | 'words' | 'blocking';
  /** When it was asked. */
  at: number;
  /** A deadline it names, else null. */
  dueAt: number | null;
  /** Rows that share this key carry the same ask (desk/asks.ts askKey). */
  key: string;
  state: AskState;
  /** The row that carries this ask when this one is superseded or a duplicate. */
  of: string | null;
}

export type Disposition = 'active' | 'snoozed' | 'parked' | 'done';
export type SeenState = 'new' | 'seen' | 'updated';
export type SnoozeTrigger = 'desk' | 'agent_posts';
export type Actor = 'owner' | 'agent' | 'system' | 'voice' | 'screen' | 'source';
export type Author = 'agent' | 'owner' | 'other';

/** What a source knows for sure. Inference never writes here. */
/** How the owner's answer to a brief counts as a rule (decisions phase 3), shown on that answered brief. */
export interface DeskRuleSaved {
  decisionId: string;
  ask: string;
  choice: 'always' | 'next-time' | 'once';
  /** The rule the answer made (still the decision's after "Ask me next time": it stands again on Always). */
  ruleId: string | null;
  ruleState: string | null;
  text: string;
  at: number;
  /** D-61: the answer is kept as a precedent; and the rule two similar approvals propose, for one tap. */
  precedent?: boolean;
  proposal?: { text: string; from: string[]; state: 'proposed' | 'made' | 'dismissed' } | null;
}

/** Loom's declared ask, including terminal records retained for rechecking. */
export interface RecordedAsk {
  text: string; at: number; to?: string; messageId?: string; runId?: string;
  id?: string;
  kind?: 'do' | 'answer' | 'pointer' | 'unclear';
  status?: 'open' | 'done' | 'answered' | 'resolved' | 'superseded' | 'withdrawn' | 'closed-by-done' | 'expired';
  steps?: Array<{ text: string; done_at?: number; by?: string }> | null;
  due?: string | null; class?: string | null; points_to?: string | null;
  revision?: number; legacy?: number; resolved_at?: number | null;
}

export interface DeskFacts {
  /** Latest explicit owner answer, retained across source reads and reloads. */
  answeredBrief?: { id: string; choice: string; at: number } | null;
  discussing?: Array<{ id: string; ask: string; since: number; runId?: string | null }>;
  openedPrUrls?: string[];
  legacyPrCreates?: Array<{ id: string; at: number }>;
  prBranch?: { branch: string; cwd: string } | null;
  /** The thread's last turn end or successful `gh pr merge`: its open PRs are re-read once after this. */
  prRefreshAt?: number | null;
  /** The agent's closing handoff, recorded by Loom. */
  handoff?: {
    owner: 'you' | 'me' | 'waiting' | 'none';
    text: string;
    waitingOn?: string | null;
    messageId?: string | null;
    runId?: string | null;
    at: number;
    source: 'tool' | 'closing-line';
    /** A "me" hand-off with nothing behind it: when Loom woke the thread once to carry it on. */
    wokeAt?: number;
    /** That wake ended the same way: the row reads Stuck. */
    stuck?: boolean;
    missingTool?: boolean;
  } | null;
  /** One fact per armed Loom trigger. */
  waits?: Array<{
    id: string;
    kind: 'time' | 'pr' | 'thread' | 'command' | 'url' | 'file' | 'worker';
    target: string;
    note?: string | null;
    prUrl?: string;
    armedAt: number;
    dueAt?: number | null;
    timeoutAt?: number | null;
    lastCheckedAt?: number | null;
    checkError?: string | null;
    /** Failed checks in a row (Loom `consecutive_errors`); absent from an older Loom. Unknown only at three. */
    consecutiveErrors?: number | null;
    /** When the current run of failed checks began (Loom `error_since`): the Unknown pill's "since". */
    errorSince?: number | null;
  }> | null;
  heartbeatAt?: number | null;
  sourceHealth?: { ok: boolean; at: number; detail?: string | null } | null;
  /** Read-time count of running descendants, including external workers. */
  runningWorkers?: number;
  askClosedByDoneAt?: number;
  /** When the owner last answered through the desk (a chip, an approval): no typed words, so older words don't speak for it (status.ts wroteSince). */
  chipAt?: number;
  /** The standing conversation was caught up through this hand-off. */
  clearedAt?: number;
  /** Read-time authoritative standing identity (only the latest home chapter). */
  standing?: boolean;
  /** The source closed its ask after Done: undoing that Done leaves it closed. */
  askClosedBySource?: boolean;

  /** The owner's recent answers on this thread that proposed a rule (newest first), and how each counts. */
  rulesSaved?: DeskRuleSaved[] | null;
  /**
   * The source is holding new turns for a known reason (Loom: disk low, memory, too many sessions, account limits,
   * maintenance): a message waiting on it is held, not failed. `until`: when it should clear, when known.
   */
  held?: { reason: string; until?: number | null } | null;
  /** Read-time: the cached Loom account name; null before its first turn or when unknown. */
  account?: string | null;
  /** Read-time: live worker decisions reported here, and the lead’s latest words for relay freshness. */
  workerAsks?: { count: number; latestAt: number; ids: string[] };
  /** Read-time: other rows' open decision briefs this row carries (desk/asks.ts carryBriefs; TGO-1075). */
  carried?: CarriedBrief[];
  /** Read-time: the row that carries this row's open brief and counts it as the owner's one Needs you. */
  carriedBy?: { itemId: string; title: string } | null;
  /**
   * The conversation's open decision brief, as its question card takes it, kept apart from `pending`: a live question
   * takes the pending slot while the brief stays open (Loom). Null: none. Absent: a source without briefs.
   */
  openBrief?: PendingRequest | null;
  /**
   * The Loom thread whose records (brief, question, ask) this row shows: a Discord row's agent runs in one
   * (source-loom.ts linkDiscord). Answers to them go to Loom.
   */
  loomThreadId?: string | null;
  /** How many decision briefs the source holds open for this row (the row shows one, "+N more"). Absent: one at most. */
  openBriefCount?: number;
  /**
   * How much context the conversation's model calls carry (Loom): the last call's tokens and today's input total.
   * Null: no calls recorded yet. Absent: a source that doesn't measure it.
   */
  context?: { tokens: number; at: number; today: number; callsToday: number; day?: number } | null;
  /** The owner kept this session (Loom's "Keep this session"): no automatic fresh session. Absent: a source without them. */
  keepSession?: boolean;
  /**
   * Today's daily budget (Loom, loom-context-management "Per-thread budget"): input tokens sent today against the
   * limit, raises included; past 100% Loom holds its automatic turns until midnight. Limit 0: no budget. Absent: none.
   */
  budget?: { limit: number; base: number; today: number; raised: number; share: number; resetsAt: number } | null;
  /** The source stopped this conversation for good (Loom thread status stopped): it can't act or carry anything. */
  stoppedAtSource?: boolean;
  /** Read-time: a worker with an open brief whose lead is put away (parked, snoozed, hidden): it shows the brief itself. */
  leadAway?: { itemId: string; title: string } | null;
  lastAgentAt?: number | null;
  /**
   * The thread's open ask, as its source records it (Loom: the agent closed a turn with "Next — you" and the
   * owner hasn't written since). Null: none open. Absent: the source keeps no ask record; a recorded owner handoff can stand in.
   * `to`: the hand-off named another agent (its name), so it never counts for the owner.
   */
  openAsk?: RecordedAsk | null;
  /** Latest ledger row, retained after closure and for pointers; never itself opens an owner ask. */
  askLedger?: RecordedAsk | null;
  /** A turn is in flight (Loom turn running, or bot turn.started without finished). */
  running?: { since: number; turnId?: string; lastAt?: number } | null;
  /** The latest turn errored, crashed or timed out. Cleared by an owner message or a new turn. */
  failed?: { at: number; reason: string; message: string; turnId?: string } | null;
  /**
   * The source is blocked on a question or an approval: the full request it sent. `question` and
   * `options` are the compact form (the first question's text and labels, or the approval's
   * detail and labels) for older readers; the card and the voice operator use `questions`/`approval`.
   */
  pending?: PendingRequest | null;
  /** The source's own snooze; kept apart from the local snooze in desk_attention. */
  sourceSnoozedUntil?: number | null;
  /** Settled at the source (not reopened since). */
  settledAtSource?: boolean;
  /** A running background job in this conversation. */
  job?: { id: string; agentId: string; label: string; startedAt: number; deadlineAt: number | null } | null;
  /** The branch pull request. */
  pullRequest?: { url: string; number: number } | null;
  /** Linked PRs besides the branch PR, open at the source’s last check. */
  linkedPullRequests?: Array<{ url: string; number: number }> | null;
  /**
   * The review state from GitHub (`gh pr view`) across the branch PR and every watched PR, as one
   * fact: changes requested on any beats a pending one, which beats approved. `since` = first seen in this state.
   */
  prReview?: PrReviewFact | null;
  prChecks?: PrChecksFact | null;
  /** CI per open PR (so one failed read keeps only that PR's last state); prChecks is their worst. */
  prChecksAll?: Array<PrChecksFact & { url: string; misses?: number }> | null;
  /** The same, one per PR, keyed by URL: what the aggregate and the wake-on-approval read. */
  prReviews?: Array<PrReviewFact & { url: string }> | null;
  /** PRs registered for watching (tango-screen watch-pr, the screen tool's watch_pr, the card menu). */
  prWatches?: PrWatch[] | null;
  /** The owner's last words, for "You asked:" and retry. */
  /** `images`: how many went with it (a desk reply); `words`: false when it was only images; `filedAt`: when the desk filed it (else `at`). */
  lastOwnerRequest?: { text: string; at: number; images?: number; words?: boolean; filedAt?: number; answers?: string } | null;
  /**
   * The agent's newest words (clipped), for the List's preview until a summary covers them: a summary is
   * written by a model seconds later. `filedAt`: when the desk got them, what a summary's `at` is compared with.
   */
  lastAgentWords?: { text: string; at: number; filedAt: number } | null;
  /** The agent's latest internal work notes (retained reasoning summaries), newest last: progress the replies may not say yet. */
  workNotes?: Array<{ at: number; text: string }> | null;
  /** Who spoke last in the conversation. */
  lastAuthor?: Author | null;
  /** On a failed turn: the last step that went right (the activity line before the error). */
  lastGoodStep?: string | null;
  /** The owner's legacy List view label, retained for seeding stage and type. */
  listLabel?: ListLabel | null;
  /** The owner's stage for the work (desk-only). */
  stage?: Stage | null;
  /** The owner's type tag (desk-only). */
  type?: ItemType | null;
  /** Stage and type were seeded from the old prefix or label once; the desk owns them from then on. */
  tagsSeeded?: boolean;
  /**
   * The desk's guess at a new coding thread's type (desk/autotag.ts), made once. `applied`: confident enough
   * to set type and stage. `unconfirmed`: the owner hasn't opened or touched it since (the List's dot).
   */
  autoTag?: { at: number; type: ItemType; confidence: number; applied: boolean; unconfirmed: boolean } | null;
  /** The owner's project this conversation is in (desk/projects.ts), any source. Separate from `project`, the source workspace. */
  projectId?: string | null;
  /** The owner brought this conversation back on its own while its project was away (Back to Active on its row). */
  projectPickedUpAt?: number | null;
  /** The source workspace, with its icon and color. */
  project?: { name: string; icon: string | null; color: string | null } | null;
  /** Pinned on the source or desk. The List view shows pins first. */
  pinned?: boolean;
  /** The owner's desk name for a conversation, shown in place of its source name. */
  name?: string | null;
  /** Background liveness: work still running after the turn (`working`), or only a monitor left (`monitoring`). */
  background?: 'working' | 'monitoring' | null;
  /**
   * What is in flight behind the thread (Loom): each background task and each open wait, in the agent's own
   * words, with when it started, when a wait gives up, and a wait's latest failed check. Empty: nothing.
   */
  inFlight?: InFlight[] | null;
  /** A thread's worktree setup while it runs or after it failed (Start work): the card shows its stages. */
  setup?: { phase: 'running' | 'done' | 'failed' | 'cancelled'; stages: Array<{ id: string; status: string; percent: number | null }>; error: string | null; startedAt: number; endedAt?: number | null } | null;
  /** Legacy retained-record field; no active source writes this URL. */
  t3Url?: string | null;
  /** Changes whenever the words change; summaries made for an older key are dropped. */
  contentKey?: string;
  /** A job's timing (source-schedules.ts): in words, its last run, when it runs next, and whether it's paused. */
  schedule?: { every: string; lastRunAt: number | null; nextRunAt: number | null; paused?: boolean } | null;
  /** A critical incident from the system ledger (desk/system.ts): which one, its job, how often it happened. */
  system?: { incidentId: number; jobId: string | null; count: number; /** The cleanup worker under way (System page Fix). */ fix?: { itemId: string } | null } | null;
  /** A job's latest runs, newest first. */
  runs?: Array<{ at: number; outcome: 'ok' | 'quiet' | 'failed'; note: string }> | null;
  /** The owner placed it in an agent's space (desk-only): a coding thread an agent like Compass owns. */
  agentSpace?: { id: string; name: string } | null;
  /** Read-time (roles.ts): who it works for; absent = interactive. */
  role?: ThreadRole;
  /** Read-time (roles.ts): the conversation that started it. */
  parentItemId?: string | null;
  /** Read-time: a worker whose owner is gone (missing or done), so its asks come back to the owner. */
  ownerGone?: boolean;
  /** The worker's last turn passed up to what it reports to (desk/mail.ts reportUp): its message id. */
  reportedUpId?: string | null;
  /** When another agent's mail last came in (desk/backstage.ts): newer than the owner's own words, it's the agent's conversation. */
  /** The newest owner-side message is another agent's mail (a reply, a hand-off): not the owner's words waiting. */
  lastAuthorMail?: boolean;
  lastMailInAt?: number | null;
  /** Read-time (source-agentctl.ts): Codex workers this conversation dispatched through agentctl. */
  codexWorkers?: CodexWorker[];
  /** The desk woke the agent for the late check-back that began at `since` (one wake per episode; core.tick). */
  overdueWoke?: { since: number; at: number; status: string } | null;
}

/** One thing in flight behind a thread (DeskFacts.inFlight). `watcher`: it watches and wakes the agent, it isn't work. */
export interface InFlight {
  url?: string;
  kind: 'shell' | 'agent' | 'monitor' | 'workflow' | 'wait' | 'task';
  text: string;
  since: number | null;
  watcher?: boolean;
  /** Loom's recorded trigger kind for a wait. */
  waitKind?: string;
  /** A wait: when Loom gives up on it and wakes the agent anyway. */
  until?: number | null;
  /** A wait: its latest check failed (the error, clipped). */
  error?: string | null;
}

/** CI on an item's open PRs, from GitHub's check rollup: the worst one (failing, then running, then passing). */
export interface PrChecksFact {
  state: 'failing' | 'running' | 'passing';
  number: number;
}

export interface PrReviewFact {
  state: 'pending' | 'approved' | 'changes_requested';
  reviewers: string[];
  number: number;
  since: number;
  /** When the deciding review was submitted (approved / changes requested): agent words after it outrank it. */
  decidedAt?: number | null;
}

/**
 * A PR the desk watches for its review, in any conversation (Loom or Discord), until it merges or
 * closes. On approval, `continue` posts a desk message into the conversation so the agent picks
 * it back up (merging if the project's rules allow, or saying what stops it); `notify` only
 * turns the card to "approved — merge?".
 */
export interface PrWatch {
  last_checked_at?: number;
  last_error?: string | null;
  error_since?: number | null;
  consecutive_errors?: number;
  error_woken?: boolean;
  wokeState?: 'approved' | 'changes_requested';
  url: string;
  number: number;
  onApprove: 'continue' | 'notify';
  at: number;
  by: Actor;
  /** When the agent was last woken for an approval (the approval's `since`): one wake per approval. */
  wokeFor?: number | null;
}

export type ApprovalDecision = 'accept' | 'acceptForSession' | 'acceptAlways' | 'decline' | 'cancel';
export const APPROVAL_DECISIONS: readonly ApprovalDecision[] = ['accept', 'acceptForSession', 'acceptAlways', 'decline', 'cancel'];

/** One question of a source user-input request. */
export interface PendingQuestion {
  /** The source's question id: the key of the answer. */
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
  /** False when the source accepts only the offered labels (no free text). */
  allowCustomAnswer?: boolean;
}

/** A source request blocking the thread. */
export interface PendingRequest {
  runId?: string | null;
  kind: 'question' | 'approval';
  /** The source's request id; null when the pending request could not be read. */
  requestId: string | null;
  /** The questions of a user-input request, in order (empty for approvals). */
  questions: PendingQuestion[];
  /** An approval's offered decisions (source defaults when it offers none) and what it is for. */
  approval?: { options: Array<{ decision: ApprovalDecision; label: string; warning?: string }>; detail?: string; requestKind?: string };
  /** The source lets this request be dismissed without an answer. */
  dismissible?: boolean;
  /** The source took an answer, then reported it failed (not stale): the request is open again, and why. */
  failed?: { at: number; message: string };
  /** A decision brief (Loom decision_request) shown as this question: what the card shows beyond the options. */
  brief?: DeskBrief;
  /** Compact form: the first question's text (+N more), or the approval's detail. */
  question: string;
  /** Compact form: the first question's labels, or the approval's labels. */
  options: string[];
  at: number;
}

/**
 * Another row's open brief, carried here intact: this row names its id (D-n) in its open ask or newest words, or
 * this row is the lead the raising worker reports to. `counts`: this row is where the owner answers it (a lead or a
 * default); otherwise the raising row keeps the count and this one only shows it.
 */
export interface CarriedBrief {
  from: { itemId: string; title: string };
  pending: PendingRequest;
  /** named: this row names it; worker: a worker below it raised it; own: this row's own, beside a live question. */
  why: 'named' | 'worker' | 'own';
  counts: boolean;
}

/** A decision brief as the desk shows it (docs/specs/decisions-and-delegation.md "The decision brief"). */
export interface DeskBrief {
  discussingSince?: number | null;
  unaddressedAt?: number | null;
  about?: string;
  id: string;
  /** Carried from another row: the thread that raised it (desk/asks.ts carryBriefs). */
  from?: { itemId: string; title: string };
  class: string;
  level: number;
  /** It can become a standing rule: approving the recommendation as it stands makes it one (D-2). */
  candidate: boolean;
  /** A board tripwire applies: the owner's call, and never a rule. */
  tripwire?: string | null;
  door: 'one-way' | 'two-way';
  blast: 'private' | 'team' | 'public';
  standing: string;
  background: string;
  assets: Array<{ kind: string; title: string; url: string }>;
  deadline: string | null;
  /** Level 3: the option that runs if the owner doesn't veto it. */
  defaultOption: string | null;
  /** Level 3: how much of the veto window (the owner's active time) is left when Loom last said. */
  vetoLeftMs: number | null;
  /** Level 3: the whole veto window (the board's veto_window, in active time), for the countdown's ring. Absent: an older desk. */
  vetoWindowMs?: number | null;
  /** The options' keys, in order, so the card splits `${key} · ${label}` exactly whatever the key holds. Absent: an older desk. */
  optionKeys?: string[];
  proposedRule: string | null;
  /** D-61: the precedent (an earlier similar approval) this brief matched. */
  precedentOf?: string | null;
  confidence: string | null;
  changeMyMind: string | null;
  /** Revised in place (TGO-1079): the revision the card shows, sent back with the answer; and its latest change. Absent: an older Loom. */
  revision?: number;
  updated?: { at: number; what: string; why: string } | null;
}

/** An open question for the owner, as the Conversation view lists it. */
export interface DeskQuestion {
  q: string;
  lean: string | null;
}

/** The summarizer's contract (spec "Summarizer contract"), plus bookkeeping. */
export interface DeskSummary {
  /** The Conversation view's heading: at most 8 words. */
  title: string;
  /** What the conversation is for, in a few plain words ("Spring garden planting plan"); the board shows it in place of a raw thread name. */
  about?: string | null;
  /** What the owner does next, in a few words starting with a verb ("Approve this week's tester payouts"); only while it's their move. */
  next?: string | null;
  gist: string;
  /** The List view's text under the conversation's name: 2–3 sentences on what happened and what it needs (summary v8+). */
  paragraph?: string | null;
  /** A news headline of where things stand, for the Screen window's feed (desk/feed.ts); never an ask. */
  headline?: string | null;
  /** What the latest messages did that the owner hasn't heard, against the earlier state (summary v14+): null when they only restate it, so the feed skips the post. */
  whatsNew?: string | null;
  /** The latest messages are only a recurring run (a check, sweep or wake) starting, coming back as before, or finding nothing to do: never a feed post. */
  routine?: boolean;
  step: 'your_move' | 'watching' | 'fyi';
  ask: string | null;
  options: string[];
  context: string[];
  ownerAsk: string | null;
  watchUntil: string | null;
  ackOnly: boolean;
  /** What kind of ask it is, when step is your_move (summary v13+): a decision, a to-do, or soft; null otherwise. */
  askKind?: AskKind | null;
  /** A deadline the ask names (ISO 8601, summary v13+), else null. */
  askDueAt?: string | null;
  /** Set only when the latest agent message says the work waits on a named person ("sent to Ana for review"). */
  /** kind 'agent': another agent, bot or automation (a "Desk" thread, Codex), which the owner can't nudge. */
  waitingOn: { who: string; what: string; kind?: 'person' | 'agent' } | null;
  /** The long-running purpose of the conversation, stable across turns (Conversation view sidebar). */
  goal?: string | null;
  /** The micro milestone being worked toward right now ("PR passes CI and review", "settle two questions, then file it"). */
  milestone?: string | null;
  /** Every open question the latest agent message puts to the owner, each with the agent's lean when it gave one. */
  questions?: DeskQuestion[];
  source: 'model' | 'text';
  /** The facts.contentKey this summary was made for. */
  contentKey: string;
  /** The rules-file kind it was summarized under; a rules edit that changes it summarizes again. */
  kind?: 'report' | null;
  /** The newest work note (its time) the summarizer saw: a newer note means this summary hasn't covered it. */
  notesAt?: number | null;
  /** The gist of the thread's last feed post (summary v14+): what the owner last heard, and the next summary's earlier state. Null when nothing has posted yet, so nothing counts as restated; absent (before v14), the feed's own last post for the thread stands in. */
  postedGist?: string | null;
  /** Prompt version that wrote it; active items with an older one are summarized again at start. */
  version?: number;
  at: number;
}

export type ArtifactKind = 'pr' | 'preview' | 'prototype' | 'ci' | 'doc' | 'link' | 'file' | 'scene';

/** One link the conversation produced. The UI groups several of one kind into a dropdown pill. */
export interface Artifact {
  kind: ArtifactKind;
  label: string;
  url: string;
}

/** "Waiting on a team member": a flavor of watching, not a step of its own. */
export interface WaitingOn {
  who: string;
  what: string;
  since: number;
  kind?: 'person' | 'agent';
}

/**
 * A wait that has run past its time (owner, 10/18): a fact on the Watching row, never an ask of the owner.
 * `check-back`: the agent's own promised update is late (a dated check-back 15 min past, a job past its
 * deadline, or an undated "update coming" a day quiet); the desk wakes the agent (core.tick). `person` /
 * `agent`: a named person (past the nudge gap) or another agent (a week) hasn't answered; the owner can tap
 * Nudge. `since`: when it became overdue. `text`: what is late, in words.
 */
export interface Overdue {
  kind: 'check-back' | 'person' | 'agent';
  since: number;
  text: string;
}

export interface DeskWatching {
  reason: string;
  /** person: waiting on a non-owner human (a PR reviewer, someone's feedback). */
  basis: 'job' | 'background' | 't3-snooze' | 'summary' | 'person';
  nextCheckAt: number | null;
  waitingOn: WaitingOn | null;
  /** Past its time (see Overdue); null while the wait is within its time. */
  overdue?: Overdue | null;
}

export interface DeskActivity {
  text: string;
  at: number;
}

export interface DeskItemRow {
  id: string;
  source: DeskSource;
  kind: DeskKind;
  conversationKey: string;
  agentId: string;
  agentName: string;
  place: string | null;
  area: string | null;
  channelId: string | null;
  threadId: string | null;
  /** Read-time evaluation, shared by every reader. */
  status?: import('./status.js').DeskStatus;
  facts: DeskFacts;
  summary: DeskSummary | null;
  artifacts: Artifact[];
  prs?: ThreadPr[];
  activity: DeskActivity | null;
  watching: DeskWatching | null;
  /** The ask the step handed the owner, with its lifecycle (desk/asks.ts); null when the step is not their move. */
  askRecord: AskRecord | null;
  nextStep: NextStep;
  nextStepBasis: string;
  /** The ask shown on the card: the source question, a PR decision, or the summarizer's ask; never a clock's (an overdue wait is a fact on `watching`). */
  ask: string | null;
  options: string[];
  createdAt: number;
  lastActivityAt: number;
  lastAgentMessageId: string | null;
  lastOwnerMessageAt: number | null;
  messageCount: number;
  labels: string[];
  hidden: boolean;
  revision: number;
}

export interface WritebackRecord {
  action: 'done' | 'seen' | 'park';
  outcome: 'ok' | 'failed' | 'n/a';
  error?: string;
  at: number;
  /** What the source did: reacted, archived, settled. */
  steps?: string[];
}

export interface Attention {
  itemId: string;
  disposition: Disposition;
  seen: SeenState;
  snoozeUntil: number | null;
  snoozeTrigger: SnoozeTrigger | null;
  backFromSnooze: boolean;
  doneAt: number | null;
  writeback: WritebackRecord | null;
  updatedAt: number;
  /**
   * The owner took in the conversation up to this time with the content in front of them: the
   * operator spoke the agent's answer (heard), or they wrote in it. A message posted before this
   * that a poll files later is not news.
   */
  coveredUntil?: number | null;
}

/** DeskItem = the item row joined with attention (spec "Read API"). */
export interface DeskItem extends DeskItemRow {
  /** Derived from the currently registered source adapters; never persisted. */
  replyable?: boolean;
  continuation?: { id: string; place: string } | null;
  disposition: Disposition;
  seen: SeenState;
  snoozeUntil: number | null;
  snoozeTrigger: SnoozeTrigger | null;
  backFromSnooze: boolean;
  doneAt: number | null;
  writeback: WritebackRecord | null;
  attentionUpdatedAt: number;
  /** Snoozed at the source (the local disposition is untouched). */
  snoozedAtSource: boolean;
  /**
   * Held by its project, which is snoozed or parked: shown with the project's state (disposition,
   * snoozeUntil, snoozeTrigger) while its own attention stays active underneath (core.items).
   */
  heldBy?: string;
}

export interface DeskMessage {
  messageId: string;
  itemId: string;
  author: Author;
  at: number;
  text: string;
  /** Images that came with it, served by the desk (attachments.ts). */
  attachments?: MessageAttachment[];
  /** What the source knows about the message beyond its words. */
  meta?: MessageMeta;
}

/**
 * Another agent's conversation (desk mail, or a Claude session's native message): `in` it wrote to this
 * one, `reply` answers mail this one sent, `out` this one wrote to it, `started` this one started it.
 * `inline` was read mid-turn rather than starting a turn of its own.
 */
export interface MessageMail {
  kind: 'in' | 'reply' | 'out' | 'started';
  peer: string;
  peerId?: string;
  mailId?: string;
  inline?: boolean;
  /** An explicit answer (`tango-screen reply`) to the mail `mailId` this conversation got mid-turn. */
  answers?: boolean;
}

export interface MessageMeta {
  commandId?: string;
  /** Source-recorded start of the run receiving this owner message. */
  runStartedAt?: number;
  mail?: MessageMail;
  /** The owner's words are waiting for the agent: it hasn't started on them yet (the source says so). */
  queued?: boolean;
  /** Source run identity, also used to anchor the report that raised a brief. */
  runId?: string;
  /** A wake's provenance: routine corrections stay backstage; answersRun links a missing-answer correction. */
  wake?: { run: string; note?: string | null; cause?: 'trigger' | 'corrective'; answersRun?: string };
  /** The owner's turn is a decision brief's answer (D-n), filed by the source, not words they typed. */
  answers?: string;
}

// ── events ───────────────────────────────────────────────────────────────

/** Event types that move owner attention, and so can be undone. */
export const ATTENTION_EVENTS = [
  'seen',
  'unseen',
  'done',
  'clear',
  'reopen',
  'snooze',
  'park',
  'pickup',
  'snooze.expired',
  'chapter.settled',
  'sweep.keep',
  'sweep.drop',
] as const;

export type DeskEventType =
  | (typeof ATTENTION_EVENTS)[number]
  /** The item first appeared. payload: { by: Author } */
  | 'source.created'
  /** New agent activity: a message, a failed turn, a pending question. payload: { step, ackOnly, what } */
  | 'source.activity'
  /** The owner wrote in the conversation (anywhere). */
  | 'source.owner_posted'
  /** The next step changed without a new message (a late summary). payload: { from, to } */
  | 'source.step'
  /** Settled at the source. */
  | 'source.done'
  | 'chapter.superseded'
  /** Outcome of writing a decision back to the source. payload: WritebackRecord */
  | 'writeback'
  /** payload: { seq } */
  | 'undo';

export interface DeskEvent {
  seq: number;
  at: number;
  itemId: string;
  type: DeskEventType;
  actor: Actor;
  payload: Record<string, unknown>;
  commandId: string | null;
  undoesSeq: number | null;
}

export type NewDeskEvent = Omit<DeskEvent, 'seq' | 'commandId' | 'undoesSeq'> & { commandId?: string | null; undoesSeq?: number | null };

export function isAttentionEvent(type: string): boolean {
  return (ATTENTION_EVENTS as readonly string[]).includes(type);
}

// ── commands ─────────────────────────────────────────────────────────────

export const COMMAND_TYPES = ['ask.resolve', 'seen', 'unseen', 'viewed', 'heard', 'done', 'reopen', 'snooze', 'park', 'pickup', 'reply', 'answer', 'respond', 'approve', 'dismiss', 'retry', 'undo', 'sweep', 'briefed', 'label', 'pin', 'rename', 'tag', 'watch', 'project', 'stop', 'role', 'space', 'run', 'pause', 'keep', 'fresh', 'raise'] as const;

/**
 * The owner's workflow, kept on the desk (not in source titles), two separate things:
 * - stage: where the work is (Discovery → Building → Feedback; pausing it is Parked, a disposition);
 * - type: what kind of work it is (an optional tag).
 * The live state (Needs you, Working, Watching, Ready) is derived from the sources, never set.
 */
export const STAGES = ['discovery', 'building', 'feedback'] as const;
export type Stage = (typeof STAGES)[number];
export const ITEM_TYPES = ['project', 'feat', 'bug', 'enh', 'chore', 'ops', 'skill'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/**
 * The old T3 title prefixes (and the desk's old Discord labels), read once to seed stage and type:
 * after that the desk owns them. `hold` was the owner's way of parking a thread.
 */
export const LEGACY_LABELS: Record<string, { stage?: Stage; type?: ItemType; park?: true }> = {
  disc: { stage: 'discovery' },
  epic: { stage: 'building', type: 'project' },
  watch: { stage: 'feedback' },
  hold: { park: true },
  bug: { type: 'bug' },
  fix: { type: 'bug' },
  feat: { type: 'feat' },
  enh: { type: 'enh' },
  chore: { type: 'chore' },
  ops: { type: 'ops' },
  skill: { type: 'skill' },
};

/**
 * Legacy labels for the List view's sections, read from old title prefixes
 * ("epic: Notification System") or facts.listLabel when seeding stage and type.
 */
export const LIST_LABELS = ['epic', 'disc', 'bug', 'feat', 'enh', 'chore', 'ops', 'skill', 'watch', 'hold'] as const;
export type ListLabel = (typeof LIST_LABELS)[number];
/** The List view's stage sections the owner can put in order: each stage, then Chats and No stage (Pinned stays on top). */
export const LIST_SECTIONS = [...STAGES, 'chat', 'none'] as const;
export type ListSection = (typeof LIST_SECTIONS)[number];
export type CommandType = (typeof COMMAND_TYPES)[number];

export interface DeskCommand {
  commandId: string;
  type: CommandType;
  itemId?: string;
  args?: Record<string, unknown>;
  actor?: Actor;
}

export interface CommandResult {
  commandId: string;
  status: 'accepted' | 'applied' | 'failed';
  error?: string;
  outcome?: Record<string, unknown>;
}

export type Log = (event: string, data?: Record<string, unknown>) => void;

export type ThreadPr = {
  url: string;              // canonical https://github.com/owner/repo/pull/N, the key
  repo: string;             // owner/repo
  number: number;
  title: string | null;
  state: 'open' | 'draft' | 'merged' | 'closed';
  review: 'pending' | 'approved' | 'changes_requested' | null;  // null = none required / unknown
  checks: 'passing' | 'failing' | 'running' | null;             // null = no checks / unknown
  relation: 'opened' | 'worker' | 'watched' | 'mentioned';
  via?: { itemId: string; title: string };  // relation 'worker': the worker that opened it
  watched: boolean;         // a desk prWatch or an armed Loom pr wait covers it right now
  mergedAt?: number; closedAt?: number;
  firstSeenAt: number;
  checkedAt: number | null; // last successful GitHub read
  error?: string;           // last read failed (kept with the last known state)
};
