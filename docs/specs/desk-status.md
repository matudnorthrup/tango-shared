# Desk Status: Facts, Not Guesses

Status: **accepted**, revision 3 (October 20, 2026); revision 4 (October 21,
2026) adds Finished and Stuck, under "Finished and Stuck" below. Replaces the status sections of
[Agent Desk](agent-desk.md) (Axis 1 "next step", the ask lifecycle, the five
status markers) and stage guessing from
[Agent Desk Next](agent-desk-next.md) once each phase below lands.

## Why

The owner's rule (October 20): **deterministic signals beat AI guessing.** As
much as possible, status comes from what the system recorded, not from reading
the text.

An October 20 audit checked 30 live desk rows against their transcripts, Loom's
database and GitHub. Only 4 rows were fully right. By field: unread 100%,
summary 80%, status pill 60%, next step 57%, stage 33%. The causes:

- Loom records the facts that matter (running turns, waits and their targets,
  briefs, requests, holds, failures, who reports to whom). The desk drops detail
  from them. For example, a wait becomes "a monitor is running," and then
  "Working."
- When facts don't settle a row, the desk falls back to a model summary,
  keyword lists (decision, to-do and optional vocabularies, deadline regex,
  wording-based dedup) and timers (30-minute running expiry, 3-minute "Failed").
- Guesses and facts render in the same pills, colors and counts, so the owner
  can't tell which to trust.
- 119 `fix` commits on desk and inbox code since October 1. The same bug
  classes recur: unread taken for needs-you, an ask hidden by background work,
  an old ask outliving its answer, the wrong audience, a timer shown as a
  failure, and new phrasing slipping past a keyword list.
- The owner reads nine status vocabularies: lifecycle, move, busy, unread,
  stage/type, role, catch-up kind, decision level, System health. "Needs you,"
  "Ready," "Failed," "Sent" and green each mean two or three things depending
  on the surface.

## The rule

**Only a recorded fact may set a pill, color, count, sort position or wake-up.**
Model output and text heuristics may *explain*: they appear as plain text
labeled as a summary, and change nothing else. When the facts can't answer,
the desk says **Unknown** instead of guessing.

A recorded fact is one of:

| Fact | Recorded by |
| --- | --- |
| Turn running (heartbeat-checked, not timer-expired) | Loom run and host; T3 session state |
| Open request (question, plan approval) | Loom request row; T3 pending flags |
| Open decision brief, and its answer | Loom decision record |
| Open ask, and its close: recorded kind, steps and status | Loom ask record (`asks`, `A-n`), opened by `loom.handoff` naming its actor and kind (D-468) |
| Armed wait: kind and target | Loom trigger row (`time`, `pr`, `thread`, `command`, `url`, `file`) |
| Background work running (shell, subagent) | Loom/Claude background task state |
| Held: reason | Loom hold |
| Failed: the error | Loom run or T3 turn error |
| Reports to | Loom role and parent |
| PR review and CI state, with observation time | GitHub API |
| Owner opened, replied, marked done, snoozed | Desk event ledger |
| Update or decision posted | Catch-up ledger (`desk_update`, decisions) |

## What the owner reads

Two layers on every row, plus the unread dot and an optional stage tag set by
the owner.

### Layer 1: where it lives

**Needs you · Active · Later · Done.** Active, Later and Done are the owner's
own placement. Snoozed and Parked merge into **Later**, with an optional wake
(a time, or "when they post"). **Needs you** is a list, not a placement: every
active row whose pill is the owner's (below). It is the only count on the desk.
The Active tab is grouped under pill headings, in precedence order.

Workers and jobs nest under their lead. Role decides placement, never a word.
They start folded: the lead's status line carries an "N reporting" chip beside
its pill (and how many are working), tapped on its own to open them, and
opening it is remembered per device.

### Layer 2: one status pill per row

Six pills, eight with revision 4 ("Finished and Stuck" below). The color says
who acts: amber is the owner, red is broken, violet is moving, green is delivered, blue is waiting on something, gray is still. Amber is never reused
for anything else.

| Pill | Color | Set only by | Detail line |
| --- | --- | --- | --- |
| **Needs you** | amber | an open decision brief, question, plan approval or `Next — you` ask whose audience is the owner | the ask |
| **Failed** | red | a run or turn error that no later run has cleared | the error, and who it went to |
| **Working** | violet | a running turn (heartbeat fresh), background shell or subagent, a running worker anywhere under it, or the owner's message recorded and its run starting | "2 workers", "starting" |
| **Waiting** | blue | an armed wait (`pr`, `time`, `thread`, `command`, `url`, `file`) or a Loom hold (usage limit, capacity) | the target or hold reason, with when it was last checked |
| **Idle** | gray | none of the above, from a source that is responding | the summary, labeled as one |
| **Unknown** | gray outline | the source isn't responding, or its facts are older than their freshness limit | which source, since when |

**Precedence:** Failed › Needs you › Working › Waiting › Idle. Unknown replaces
everything except the desk's own records (an open ask is the desk's record).
When Needs you wins over Working, the detail line adds "still working", so an
ask never hides behind activity.

**Where the detail shows.** A row and a conversation show it the same way: for
Waiting, Failed, Stuck and Unknown, in gray beside the pill; for Needs you, as
the question on its own line (in a conversation only when no brief card shows
it). Working, Finished and Idle show none, since "Turn running", "1 worker" or a
closing "done." only repeat the pill.

**Audience.** For a Loom ask, the hand-off’s named actor decides who it is
for. An ask addressed to an agent is Waiting on that agent, even if its lead
is away or its starter is another conversation. Do not infer its addressee
from who started the thread. A brief, question or failure goes to whoever the thread
reports to: a worker's or job's live lead (which is woken), otherwise the
owner. A row counts toward the owner's Needs you only when its audience is the
owner: amber rows, and red rows with no live lead. The red pill still shows on
any failed row. Done never hides an owner request silently. Marking a row done
closes its `Next — you` ask on the record (status `closed-by-done`). It does
not close an open decision brief, question or plan approval:
those need an answer or a withdrawal, so the row stays in Needs you (amber,
"marked done, still open") until the record closes, then moves to Done.

**Rules that fall out of this:**

- One pill for every owner move. Briefs, questions and asks differ in what
  opens (a decision card, a reply, or Did it), not in the status word. An ask's
  kind (`do`, `answer`, `pointer`, or `unclear` when none was declared) is
  declared on the hand-off and recorded by Loom, never read from the words
  (D-468; decisions-and-delegation.md, "The hand-off ask"). The recorded kind labels the card and sets its actions, never the pill. Deadlines read from wording and wording-based
  duplicate checks are removed; a declared `due` is a record, and past it the
  ask is expired, not open.
- GitHub review state is never the owner's move. Pending review or CI reads
  Waiting. Requested changes wake the agent (Working). A product or design
  change comes as a brief. Merging is the agent's under the delegation board.
- A hold is Waiting with its reason. If a hold needs the owner (a sign-in),
  Loom records an ask.
- Running anywhere in a thread's tree beats waiting: a lead waiting on its own
  workers reads Working, with the worker count.
- The 3-minute "Failed" for an unanswered message goes away. A message with no
  run reads Working, starting; past the freshness limit it reads Unknown.

### Unread dot

The one field that was 100% right, and now the only thing opening a row
changes (owner, 10/20). Opening a Needs you row clears its unread dot; the row
stays Needs you, amber, until its record closes. There is no Ready state. The
list shows the dot on every row with words the owner hasn't seen.

### Every wait wakes

A Waiting pill is a promise that something will wake the thread. The owner
trusts it only if that is always true (owner, 10/20). So every wait has a
recorded trigger, a last-checked time on the row, and a timeout that wakes the
thread. A wait that can't be checked never stays silent: after three failed
checks in a row it wakes the thread with the error, and the row reads Unknown
("PR check failing since 2:10"). An audit (October 20) found these silent
gaps, all fixed in the wake track below:

- The desk's PR watch checks GitHub sign-in once and caches the answer, so one
  failure at startup stops every PR watch until a restart.
- A poll that keeps erroring stays silent until its timeout (up to 7 days). A
  URL 5xx records no error. A command's normal "not yet" exit shows as one.
- A merged, closed or changes-requested PR ends a watch without waking anyone.
  A `commented` wait may miss reviews.
- A worker that fails or crashes without posting is never reported up, and a
  `thread` wait on its run fires only when the run completes, not when it fails.
  Codex workers outside Loom wake no one when they finish.
- One slow command check holds up every other wait, time waits included. One
  bad row stops every veto default after it.
- A "Next — me" turn with no wait behind it is caught only through the summary,
  up to a day late.

### Stage

An optional tag the owner sets (Discovery, Building, Feedback), shown as a
neutral chip and filterable. Never guessed and never moved automatically.
Likely deprecated later. Type is removed from view; stored values are kept.

### Summary

A line of plain text, labeled as the agent's summary. It never sets a pill,
count, group or wake.

## Catch-up, decisions and delegation

- **Delegation board:** decides whether something becomes a brief at all.
  Upstream of status; never a label.
- **Decisions:** records. An open brief is one source of Needs you. A
  decision-log entry is a "Decided for you" with its Undo.
- **Status:** what each thread is doing now, from the tables above.
- **Catch-up:** what changed since the owner last looked. It computes no status
  of its own. Its lines are: **Needs you** and **Failed** (rows that entered
  that pill, with the same predicate as the row), **Decided for you** (decision
  log), **Shipped** (a merged PR or the agent's `shipped` update, never a
  headline keyword), and **Update** (`desk_update`). Model-written headline
  prose stays as prose.

Decision levels appear only inside a brief. System health reads OK, Problem,
Paused or Unknown; a job with no evidence either way is Unknown.

Every surface (row, thread header, conversation callout, Needs you count, saved
views, catch-up, voice, and the agent `threads` command) reads one evaluator
that implements these tables. No surface computes its own.

## T3 threads

T3 records less than Loom: no waits, briefs or reporting links. T3 rows show
Needs you (a pending question or approval, or a `Next — you` closing line, the
one parse kept since nothing else carries a T3 ask), Failed, Working, Idle or
Unknown (T3 not answering, or its cached rows past their freshness limit).

## Phases

Each phase is its own PR. After each, re-run the 30-row live accuracy check.
Target: 90% of rows fully right after Phase 2. Phases 1, 2 and the wake track
are built in parallel against one shared fact contract (the new `DeskFacts`
fields: `handoff`, `waits`, `heartbeatAt`, `sourceHealth`); Phase 2 reads them
when present and falls back to today's records, never to text.

0. **Contradiction fixes.** A wait reads Watching, never Working. An open ask
   beats busy on every surface. "Next — waiting on you" is the owner's move.
   Ops asks go to their lead or the owner. Done rows don't show an old ask as
   their line. Stages are no longer guessed.
1. **Loom records the full handoff.** Persist `{owner: you|me|waiting|none,
   text, waitingOn, messageId, runId, at}` instead of only `you`. Add a
   `loom.handoff` tool. Only the tool opens a Loom owner ask; prose never does.
   Decision briefs and pending questions keep their own request paths; Discord
   agents keep their existing path. Pass
   each wait's kind and target to the desk, and let a wait declare that its
   target is a worker (for workers outside Loom, such as Codex). Check the
   host heartbeat for Working instead of a 30-minute timer. Route a worker's
   failure to its lead.
2. **One evaluator, two layers, six pills.** Replace `deriveNextStep`'s summary
   tiers, the GitHub owner-move tiers and the ask keyword classifier with the
   tables above. Tabs become Needs you · Active · Later · Done, with Active
   grouped by pill. Collapse saved views, counts, catch-up, voice and `threads`
   onto the evaluator. Remove type; stage becomes an owner-only tag. Summary
   becomes a labeled line. Add a missed-ask check that logs any row where the
   summary says the owner is needed and no record does; fix each at the source.
W. **Every wait wakes.** Fix each gap under "Every wait wakes": re-check
   GitHub sign-in on every poll, wake after three failed checks, record URL
   errors, treat "not yet" as pending, wake on merged/closed/changes requested,
   read reviews in `commented` waits, run slow checks without blocking the
   tick, isolate veto rows, and have the wait-keeper read check errors. Worker
   failure and Codex worker wakes land in Phase 1.
3. **Cross-thread resolution and freshness.** An ask can name what resolves it
   (a brief, a thread, a PR). When that resolves, the ask closes on the record,
   so one thread's fix clears another's ask. Specified as `resolves` and
   `points_to` on the ask record (decisions-and-delegation.md, "The hand-off
   ask", D-468). Each fact carries its observation
   time and its source's health, and anything past its limit reads Unknown.
4. **Delete what nothing reads.** The legacy inbox path (the live desk runs
   `SCREEN_DESK=v2`), the inbox compatibility API, coordinator status, the
   autotag model call, the stage-prefix migration, the ask word lists, the
   deadline regex, catch-up's own needs and shipped rules, and the summary
   `step`/`waitingOn`/`watchUntil` fields: roughly 4,000 lines, once the
   missed-ask check stays quiet and after checking what still borrows them.

## Finished and Stuck (revision 4)

The owner, October 21: agents that finish with nothing left for the owner go
gray Idle with no notice, so finished work disappears. A live check found 18
of 100 Idle rows finished (the hand-off said nobody acts next) and one stalled
(the hand-off said the agent goes on, but nothing ran and no wait was armed).
That is the "Next — me with no wait behind it" gap listed under "Every wait
wakes". Approved as a design in chat (D-303).

### Two new pills

| Pill | Color | Set only by | Detail line |
| --- | --- | --- | --- |
| **Finished** | green, with a check, never animated | the latest hand-off says nobody acts next (`owner: none`), it is newer than the owner's last message, and nothing is running or armed | the hand-off text, e.g. "merged #953" |
| **Stuck** | red | the latest hand-off says the agent acts next (`owner: me`, or `next.kind: agent` naming this thread), it is newer than the owner's last message, nothing is running or armed, and Loom's one wake has already happened without either | "said it would go on, nothing running since 2:10" |

**Precedence:** Failed › Needs you › Working › Waiting › Stuck › Finished ›
Idle. Unknown still replaces everything except the desk's own records. Idle
keeps what remains: a quiet thread with no hand-off claim either way.

- **Stuck wakes the agent first.** The promise is the agent's, so when a
  `me` hand-off has nothing behind it, Loom wakes the thread once with the
  reason. If that doesn't lead to a run or an armed wait, the row reads Stuck.
  Stuck counts for the owner, like Failed, and posts to the Feed as the Stuck
  post that already exists for broken waits. One word covers both.
- **Missing tool hand-off (D-353).** With no tool hand-off for the completed
  run and nothing queued or armed, Loom gives one corrective wake. If that
  turn also omits the tool, the row is Stuck (`missingTool`, `stuck`), even
  when the prose says you or none. The prose never becomes an owner ask.
- **Waiting on another thread arms its own wait.** A hand-off naming another
  Loom thread (`next.kind: agent` with its `loom:` address, or a closing
  "waiting on … (loom:<id>)") makes Loom arm a wait that wakes this thread
  when that one settles: no turn running or queued, no wait of its own. If
  that thread isn't working on anything, Loom wakes this one once with the
  reason instead, as for `me`. If that thread already waits on this one,
  nothing is armed: it wakes when this thread settles. A closing line that
  names a thread only in words ("waiting on the lead") wakes once to ask for
  its address.
- **A PR approval wait also wakes on news that rules the approval out:** the
  PR merged or closed, or a reviewer asked for changes, after the wait began.
  A wait set up when that had already happened wakes on its first check with
  the reason. It wakes once: a wait the thread sets up again on the same PR
  after hearing (to wait for the re-review once the fixes are pushed) waits
  for news that comes later.
- **Finished is not Done.** Finished is the agent's record that the work
  reached an end. Done is the owner's own filing. Adding work turns a Finished
  row into Working through the normal facts. Marking it done moves it to Done,
  and so does accepting a catch-up chapter that shows its Finished line: that
  Accept is the owner's review, so it files the row. A standing conversation
  instead takes Clear, stays in place, and reads Idle until a newer hand-off
  ([standing conversations](spaces.md#a-standing-conversation-is-cleared-never-done)). An open brief, question or approval still reads Needs you. Deferring the chapter
  keeps the row Finished. Opening a row only clears the unread dot, as with
  Needs you. Finished rows never age out.
- **Finished doesn't count.** It isn't in the Needs you count and never uses
  amber. It's worth a look, not a blocker.

### Where it shows

- **Lists:** Active is grouped as Failed, Stuck, Needs you, **Finished**,
  Working, Waiting, Idle, Unknown. Finished sits just below Needs you.
- **Catch-up:** a row entering Finished writes a ledger line (`auto:handoff`,
  kind `shipped`, title from the hand-off text). A lead's own `shipped` update
  or the PR's merge line supersedes it, so one finish is one line.

### One word for finishing

"Shipped", "Merged" and the new pill all mean that the agent's work reached an
end, so they share one word: **Finished**.

| Today | Becomes |
| --- | --- |
| Catch-up's **Shipped** section and line kind label | **Finished** |
| Feed's **Shipped** post (a merged PR, or the agent's `shipped` update) | **Finished**, with "merged #N" as its detail |
| The row pill | **Finished** |
| **Done** (tab, and the Feed post when the owner marks a row done) | unchanged: the owner's filing, not the agent's claim |

The ledger kind stays `shipped` in storage, so there is no migration. Only the
words change. A milestone (`moment`) stays a moment.

### Build

One PR, re-checked against the 30-row live accuracy check afterwards.

1. **Evaluator** (`status.ts`): add `finished` and `stuck` from `facts.handoff`
   with the freshness rule above. Add tests for each precedence edge: a
   newer owner message, a running worker, an armed wait, `none` with an open
   brief.
2. **Loom:** wake a thread once when its `me` hand-off has no run or wait
   behind it, then record that the wake has happened (the Stuck fact).
3. **Desk UI:** add the Finished and Stuck groups and pills, with tally and
   filter entries.
4. **Catch-up and Feed:** add the `auto:handoff` ledger line and change the
   Shipped labels to Finished. Accepting a chapter clears standing conversations
   and marks done other rows whose
   Finished line it showed.

## Out of scope

- Catch-up's ledger and Accept/Defer flow (kept; only its "Needs you"
  predicate and Shipped detection change).
- Projects, spaces and the delegation board.
- The prose quality of summaries.

### Recorded merge and denial facts

A `decision_request`, or `handoff` of kind `human`, can name a PR with an asset
of kind `pr`; an armed `pr` wait also supplies its repository and number. Loom
only applies this refusal when `requestedAction: "merge"` explicitly identifies
the requested owner action (or the brief class is `merge-when-green`). A PR
reference alone never blocks an unrelated decision. Loom checks fresh GitHub
facts and the thread's or any ancestor lead's approved
plan/design decision, following structured parent links only. An
explicit `buildInstruction` message id can identify the owner's build instruction;
Loom verifies owner provenance and never reads that message for intent. A rejected
recommendation, reversed decision, mail, or missing approval does not qualify.
When all merge guards are met, Loom refuses the owner handoff/brief with
“PR #N meets merge-when-green on recorded facts: merge it and log with decision_log”.
Tripwires and a narrowed merge delegation level retain their existing paths.
Missing/unreachable facts pass through; ask text is never inspected by this check.
PRs with more review threads than the fetched page also pass through as unknown.
The agent still rechecks the head immediately before merging.

From Codex review pass 3 (and at the cap), only P1 findings block: P2 or edge
findings can be moved to a recorded follow-up and their threads resolved. They then satisfy the resolved-thread guard;
Loom never guesses severity from review text. Blocking findings remain blocked.

The Claude SDK's `system.permission_denied` event with
`decision_reason_type: rule` records the thread, run, tool call and time. Carried
context says “blocked by a settings rule (rule/source), not by the owner”. The
current SDK event omits rule/source, and context says so. The SDK does not emit
this event for every denial path; the denial hook supplies only a reason string
and result `permission_denials` supplies no attribution, so those are not guessed
or parsed. Denial records explain the block; they do not set a new status pill.

### Reports, corrective wakes, and open asks

Loom stores each wake run's cause as `trigger` or `corrective`. Legacy runs
use the same exact Loom constants and known ask-lint prefixes to derive their
cause. Corrective turns are backstage notes, never the latest report.

An unanswered owner ask pins the conversation reply to its anchor message's
report turn. An open brief uses its raising run. The desk widens its message
read when the anchor is outside the usual window. Later agent turns remain
available under one expandable “N later notes” line. An owner message releases
the pin; a different ask moves it. The desk uses source metadata, never reply
length or wording, to make this choice. Re-recording an unchanged hand-off is
a no-op and never moves the card's ask or the report anchor.
