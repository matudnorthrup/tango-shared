import type { DeskItem, RecordedAsk } from './types.js';

/** PR observations only affect this row while it owns the work or has its own live watch. */
function prObligations(item: StatusInput) {
  const f = item.facts;
  const urls = new Set<string>([
    ...(item.prs ?? []).filter(pr => pr.relation === 'opened' || pr.relation === 'worker').map(pr => pr.url),
    ...(f.openedPrUrls ?? []),
    ...(f.pullRequest ? [f.pullRequest.url] : []),
    ...(f.prWatches ?? []).map(w => w.url),
    ...(f.waits ?? []).filter(w => w.kind === 'pr').flatMap(w => (w.prUrl ?? w.target).match(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/gi) ?? []),
  ].map(url => url.toLowerCase().replace(/\/$/, '')));
  const eligible = (url: string) => urls.has(url.toLowerCase().replace(/\/$/, ''));
  // Older single facts carry only a number. Accept them only with unambiguous membership evidence.
  const numbered = (number: number) => {
    const known = new Set([...(item.prs ?? []).map(p => p.url), ...urls].filter(url => url.replace(/\/$/, '').endsWith(`/pull/${number}`)).map(url => url.toLowerCase().replace(/\/$/, '')));
    return known.size === 1 && [...known].some(eligible);
  };
  const reviews = f.prReviews ? f.prReviews.filter(pr => eligible(pr.url)) : f.prReview && numbered(f.prReview.number) ? [f.prReview] : [];
  const checks = f.prChecksAll ? f.prChecksAll.filter(pr => eligible(pr.url)) : f.prChecks && numbered(f.prChecks.number) ? [f.prChecks] : [];
  return {
    review: reviews.find(pr => pr.state === 'changes_requested') ?? reviews.find(pr => pr.state === 'pending'),
    checks: checks.find(pr => pr.state === 'failing') ?? checks.find(pr => pr.state === 'running'),
  };
}

export const HEARTBEAT_FRESH_MS = 2 * 60_000;
export const SOURCE_FRESH_MS = 2 * 60_000;
export const WAIT_FRESH_MS = 15 * 60_000;
/** Failed checks in a row before a wait reads Unknown (spec "Every wait wakes": Loom wakes the thread at the same count). */
export const WAIT_UNKNOWN_ERRORS = 3;
export type Wait = NonNullable<DeskItem['facts']['waits']>[number];
/** A wait whose checks keep failing: three in a row, or a failing one from a Loom that doesn't count (can't say fewer). */
const waitBroken = (w: Wait) => !!w.checkError && (w.consecutiveErrors ?? WAIT_UNKNOWN_ERRORS) >= WAIT_UNKNOWN_ERRORS;
/** The row's waits whose checks keep failing (Loom has woken the thread with the error): the Feed's Stuck. */
export const stuckWaits = (item: Pick<DeskItem, 'facts'>): Wait[] => item.facts.waits?.filter(waitBroken) ?? [];
/** What a wait is on, in words. A command wait's target is the agent's shell check, so the row shows its note
 * instead (the sha=$(gh pr view …) | jq script read as the row's status line, 10/21). A time wait not due today names
 * its day: "9:00 AM" alone read as today for a wait due in two weeks. */
export function waitTarget(w: Wait, now: number): string {
  if (w.kind === 'command') return w.note?.trim() || 'a command check';
  if (w.kind !== 'time' || w.dueAt == null || new Date(w.dueAt).toDateString() === new Date(now).toDateString()) return w.target;
  return new Date(w.dueAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
/** Why Loom holds the next turn, in words: the row showed its code ("queued", "account_limit") as-is (owner, 10/21). */
export const HELD = {
  queued: 'Starts shortly: a message is waiting to run',
  disk_low: 'Held: the disk is nearly full',
  recovery_unhealthy: 'Held: recovery storage is low or replication is behind',
  memory: 'Held: memory is low',
  host_cap: 'Held: too many turns running on this machine',
  account_limit: 'Held: the account hit its usage limit',
  provider_busy: 'Held: the model is at capacity; Loom retries it',
  budget: 'Held: the usage budget is spent',
  maintenance: 'Held: Loom is in maintenance',
  waiting_for_room: 'Held: waiting for room to run',
} as const;
export type WaitingReason = keyof typeof HELD;
export const WAITING_REASONS = Object.keys(HELD) as WaitingReason[];
export function heldText(held: { reason: string; until?: number | null }, now: number): string {
  const text = HELD[held.reason as WaitingReason] ?? held.reason;
  if (held.until == null || held.until <= now) return text;
  const at = new Date(held.until);
  return `${text}, until ${at.toLocaleString('en-US', at.toDateString() === new Date(now).toDateString() ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}
/** Compatibility export for legacy readers; no status uses a stall timer. */
export const STALL_MS = 3 * 60_000;
export const PILLS = ['needs', 'failed', 'working', 'waiting', 'stuck', 'finished', 'idle', 'unknown'] as const;
export type Pill = (typeof PILLS)[number];
export type Move = 'needs' | 'ready' | 'watching' | 'failed' | null;
export type Busy = 'working' | 'background' | null;
export const LIVE_STATES = ['needs', 'failed', 'ready', 'todo', 'working', 'watching', 'fyi', 'sent', 'held', null] as const;
export type Live = (typeof LIVE_STATES)[number];
export type Audience = 'owner' | 'lead';
export interface DeskStatus {
  layer: 'needs' | 'active' | 'later' | 'done';
  pill: Pill;
  detail: string;
  stillWorking: boolean;
  unread: boolean;
  audience: Audience;
  countsForOwner: boolean;
  basis: string;
  // Compatibility fields for readers scheduled for removal in Phase 4.
  move: Move;
  busy: Busy;
  live: Live;
}
export type StatusInput = Pick<DeskItem, 'facts' | 'seen'> & Partial<Pick<DeskItem, 'nextStep' | 'nextStepBasis' | 'askRecord' | 'lastOwnerMessageAt' | 'disposition' | 'source' | 'replyable' | 'prs'>>;

/**
 * Whether the owner wrote to the agent after `request` was raised: their own words, typed (an answer chip files none,
 * and a brief's answer Loom files as their turn is marked `answers`), that the agent hasn't answered yet. It's the agent's move then, not the owner's, however the
 * request reads: a reply left the row in Needs you until the agent closed its brief (owner, 10/22). The words must be
 * the owner's latest act: a chip answered since (`chipAt`) files no words, so older words don't speak for it (Codex review on #1032).
 */
export function wroteSince(item: StatusInput, request: { at: number } | null | undefined): boolean {
  const f = item.facts;
  const words = f.lastOwnerRequest;
  const at = !words || words.answers || (words.filedAt ?? words.at) < (f.chipAt ?? 0) ? null : words.at;
  return !!request && item.disposition !== 'done' && f.lastAuthor === 'owner' && !f.lastAuthorMail && at != null && at > request.at;
}

export function unansweredSince(item: StatusInput): number | null {
  const f = item.facts;
  return item.disposition !== 'done' && f.lastAuthor === 'owner' && !f.lastAuthorMail && !f.running && !f.background && !f.job && (!f.pending || wroteSince(item, f.pending))
    ? item.lastOwnerMessageAt || f.lastOwnerRequest?.at || null : null;
}

/** The sole status evaluator: prose never participates in a status decision (owner, 10/20). */
export function deskStatus(item: StatusInput, now = Date.now()): DeskStatus {
  const f = item.facts;
  const audience: Audience = !!f.parentItemId && ['worker', 'ops'].includes(f.role ?? '') && !f.ownerGone && !f.leadAway ? 'lead' : 'owner';
  const running = !!f.running && (!f.failed || f.running.since > f.failed.at) && (f.heartbeatAt == null || now - f.heartbeatAt <= HEARTBEAT_FRESH_MS);
  const workers = f.runningWorkers ?? f.codexWorkers?.filter(w => w.state === 'working').length ?? 0;
  const starting = unansweredSince(item);
  // sourceHealth is written only when reachability flips, so `at` reads "since", not "last checked".
  const sourceFresh = f.sourceHealth?.ok !== false;
  const working = sourceFresh && (running || f.background === 'working' || !!f.job || workers > 0);
  // A request the owner has written past is with the agent: Sent until it answers (wroteSince). One raised since still asks.
  const request = [f.pending, f.openBrief, ...(f.carried ?? []).filter(c => c.counts).map(c => c.pending)].find(r => r && !wroteSince(item, r)) ?? undefined;
  const closedAt = Math.max(item.lastOwnerMessageAt ?? 0, f.askClosedByDoneAt ?? 0);
  // The source's own ask record wins (Loom keeps an ask open across an unrelated mail turn); a recorded handoff
  // stands in only where the source keeps none.
  const recorded: RecordedAsk | null = f.openAsk !== undefined ? f.openAsk
    : item.source !== 'loom' && f.handoff?.owner === 'you' ? { text: f.handoff.text, at: f.handoff.at } : null;
  const hasRecord = recorded && 'id' in recorded && recorded.id;
  // A recorded ask is open by its status alone, except for what the desk already knows will close it: its own Done
  // before Loom's clear lands (askClosedByDoneAt), and the owner's typed words past it, which Loom records as
  // `answered` on arrival: Sent until the re-read brings the record, as a request written past (wroteSince).
  const ask = recorded && (hasRecord
    ? recorded.status === 'open' && recorded.kind !== 'pointer' && recorded.at > (f.askClosedByDoneAt ?? 0) && !wroteSince(item, recorded)
    : recorded.at > closedAt) ? recorded : null;
  // An ask Loom recorded as another agent's (its hand-off named that agent) is never the owner's: the row waits
  // on that agent instead.
  const askTo = ask && 'to' in ask ? ask.to : undefined;
  const ownAsk = item.disposition !== 'done' && !!ask && !askTo;
  const agentAsk = item.disposition !== 'done' && !!askTo;
  const checked = (at: number | null | undefined) => at == null ? 'check time unknown' : `checked ${Math.max(0, Math.floor((now - at) / 60_000))}m ago`;
  let pill: Pill = 'idle', detail = '', basis = 'source:responding';
  const unknown = (source: string, at: number, reason = '') => {
    pill = 'unknown'; basis = source;
    detail = `${item.source ?? 'Source'}: ${reason || source}, since ${new Date(at).toISOString()}`;
  };
  // A hand-off says Finished or Stuck only until the owner writes again (desk-status.md, "Finished and Stuck").
  const handoff = f.handoff && f.handoff.at > Math.max(item.lastOwnerMessageAt ?? 0, f.clearedAt ?? 0) ? f.handoff : null;
  const holdExplains = !!f.held && f.failed?.reason === 'schedule' && /timed out/i.test(f.failed.message ?? '');
  // A failing check on any armed wait shows, not only the oldest one's (Codex review on #928).
  const wait = f.waits?.find(waitBroken) ?? f.waits?.find(w => w.checkError) ?? f.waits?.[0];
  const stale = f.sourceHealth?.ok === false;
  const pr = prObligations(item);
  if (stale && !ownAsk) unknown('source:health', f.sourceHealth!.at, f.sourceHealth!.detail ?? 'source unavailable');
  // A known hold outranks only the failure it explains: a scheduled job's "timed out" while Loom held its run (the
  // scheduler's recorded message, not prose). Any other failure stays a failure, held or not (Codex review on #832).
  else if (!stale && f.failed && !holdExplains && (!f.running || f.running.since <= f.failed.at)) {
    pill = 'failed'; basis = 'source:failed'; detail = `${f.failed.message || f.failed.reason} · sent to ${audience}`;
  } else if (audience === 'owner' && ((request && !(f.carriedBy && request.brief)) || ownAsk)) {
    pill = 'needs'; basis = request ? `source:${request.kind}` : 'source:ask';
    detail = request?.question || ask?.text || 'Open request';
    // Every open brief is on the record; the row shows one and says how many more (296a752a hid D-204 behind D-205).
    const more = (f.openBriefCount ?? 0) - (request?.brief ? 1 : 0);
    if (request && more > 0) detail += ` (+${more} more open brief${more === 1 ? '' : 's'})`;
    if (item.disposition === 'done') detail = `marked done, still open · ${detail}`;
    if (working) detail += ' · still working';
  } else if (f.discussing?.length) {
    pill = 'working'; basis = 'source:discussion'; detail = `In discussion · ${f.discussing.map(brief => brief.id).join(', ')}`;
  } else if (f.running && f.heartbeatAt != null && !running) unknown('source:heartbeat', f.heartbeatAt);
  else if (working) {
    pill = 'working'; basis = workers ? 'source:workers' : running ? 'source:running' : f.job ? 'source:job' : 'source:background';
    detail = workers ? `${workers} worker${workers === 1 ? '' : 's'}` : running ? 'Turn running' : f.job?.label || 'Background work';
  } else if (audience === 'lead' && (request || ownAsk)) {
    // An ask the hand-off named another agent for waits on that agent, a worker's included (Codex review on #931).
    pill = 'waiting'; basis = 'source:lead-request'; detail = `Waiting on lead: ${request?.question || ask?.text || 'open request'}`;
  } else if (agentAsk) {
    pill = 'waiting'; basis = 'source:agent-request'; detail = `Waiting on ${askTo}: ${ask!.text || 'open request'}`;
  } else if (f.held) { pill = 'waiting'; basis = 'source:held'; detail = heldText(f.held, now); }
  else if (wait) {
    // Unknown only once the checks keep failing; one failed check is still a wait, and says so.
    if (waitBroken(wait)) unknown('source:wait', wait.errorSince ?? wait.lastCheckedAt ?? wait.armedAt, `${waitTarget(wait, now)} check failing: ${wait.checkError}`);
    else {
      // A clock wait checks nothing worth an age: "2:30 PM · checked 14m ago" read as a stale poll (owner, 10/21).
      pill = 'waiting'; basis = 'source:wait'; detail = wait.kind === 'time' ? `until ${waitTarget(wait, now)}` : `${waitTarget(wait, now)} · ${checked(wait.lastCheckedAt)}`;
      if (wait.checkError) detail += ` · check failed ${wait.consecutiveErrors} of ${WAIT_UNKNOWN_ERRORS}`;
    }
  } else if (pr.review || pr.checks) {
    pill = 'waiting'; basis = 'source:pr-review';
    detail = pr.review?.state === 'changes_requested' ? (item.replyable === false ? 'changes requested · read-only conversation' : 'changes requested, agent woken') : `PR #${pr.review?.number ?? pr.checks?.number} · ${checked(pr.review?.since)}`;
  } else if (f.background === 'monitoring' || f.inFlight?.some(x => x.kind === 'wait' || x.watcher)) {
    pill = 'waiting'; basis = 'source:background'; detail = f.inFlight?.find(x => x.kind === 'wait' || x.watcher)?.text || 'Monitor armed';
  } else if (starting) {
    if (now - starting > HEARTBEAT_FRESH_MS) unknown('source:starting', starting, 'run has not started');
    // Sent: the owner's words are with the agent, nothing has taken them up yet (rows say "Sent").
    else { pill = 'working'; basis = 'owner:last-message'; detail = 'sent'; }
  } else if (handoff?.stuck && (handoff.owner === 'me' || handoff.missingTool)) {
    // Loom woke the thread once for a "me" hand-off with nothing behind it, and the wake ended the same way.
    pill = 'stuck'; basis = 'source:handoff-stuck';
    detail = handoff.missingTool ? 'No tool hand-off recorded after Loom’s corrective wake' : `said it would go on, nothing running since ${new Date(handoff.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  } else if (handoff?.owner === 'none') { pill = 'finished'; basis = 'source:handoff'; detail = handoff.text || 'Finished'; }
  const placement = item.disposition ?? 'active';
  // Done never hides an open brief, question or approval: it stays in Needs you until the record closes.
  const stillOpen = placement === 'done' && pill === 'needs' && audience === 'owner' && !!request;
  const countsForOwner = (placement === 'active' || stillOpen) && audience === 'owner' && (pill === 'needs' || pill === 'failed' || pill === 'stuck');
  const layer = stillOpen ? 'needs' : placement === 'done' ? 'done' : placement === 'snoozed' || placement === 'parked' ? 'later' : countsForOwner ? 'needs' : 'active';
  return { layer, pill, detail, stillWorking: working, unread: item.seen !== 'seen', audience, countsForOwner, basis,
    move: pill === 'needs' ? 'needs' : pill === 'failed' || pill === 'stuck' ? 'failed' : pill === 'waiting' ? 'watching' : null,
    busy: working ? running ? 'working' : 'background' : null,
    live: ({ needs: 'needs', failed: 'failed', working: 'working', waiting: 'watching', stuck: 'failed', finished: 'fyi', idle: 'fyi', unknown: 'fyi' } as Record<Pill, Live>)[pill] };
}
export const needsOwner = (item: StatusInput, now = Date.now()): boolean => deskStatus(item, now).countsForOwner;
export const reportsUp = (item: StatusInput, now = Date.now()): boolean => deskStatus(item, now).audience === 'lead';
