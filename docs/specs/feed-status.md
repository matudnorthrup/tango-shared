# Feed Status: The Feed Reads the Same Records

Status: **draft** (October 20, 2026; revised October 21 against the merged
Desk Status code, #926, #928 and #932). A follow-up to
[Desk Status](desk-status.md) (merged in #919).
It applies that spec's rule to the Screen window's Feed, which its list of
surfaces left out. Desk Status Phase 2 (the one evaluator) and the wait-check
count it builds on have merged, so nothing here waits on other work. It
changes the Feed sections of [Agent Desk](agent-desk.md) and reuses the update
ledger from [Catch-up and seen](catch-up.md).

## Why

Desk Status says only a recorded fact may set a pill, color, count, sort
position or wake-up, and every surface reads one evaluator. The Feed
(`apps/screen/public/desk/feed.js`, `apps/screen/server/desk/feed.ts`) is the
one owner surface not on that list. Today it breaks the rule in three places:

- **Its state posts still ride on the summary.** Desk Status Phase 2 moved
  Needs you and Failed posts onto the evaluator, but a summary post takes the
  evaluator's pill as its kind and suppresses the `status.entered` post
  (`core.ts` `summarize`, `feedCovered`). In the 24 hours to October 21, 241 of
  254 Needs you posts went out this way, carrying model words under a status
  pill. Neither path checks the audience, so a worker's failure that went to
  its lead posts as Failed.
- **Its colors break the color rule.** Done is green (green now means moving),
  System posts are amber (amber is only the owner's move), and PR and agent mail
  posts are blue (blue now means waiting on something).
- **A model and word lists decide whether a post goes out.** An update posts
  when the summary's `whatsNew` says something happened. Word-overlap filters
  then drop posts that look like repeats: same thread 0.4 within 20 minutes,
  related thread 0.5 within 15 minutes, decisions 0.2 within 10 minutes, mail
  0.25 within 10 minutes. The audit lists these with the other heuristics.
  Every Feed fix since October 16 has tuned them: duplicates, restatements,
  leads retelling their workers.

The Feed answers "what happened", not "where things stand". That doesn't change.
What changes is where each post comes from and what its colors mean.

## The rule for the Feed

**A post goes out because something was recorded. Its words may come from a
model. Whether it posts, and its pill and color, may not.**

## What posts

| Post | Recorded by | Pill |
| --- | --- | --- |
| **Needs you** | the evaluator's `status.entered` event with `pill: 'needs'`: a row entered Needs you (a brief, question, plan approval or `Next — you` ask whose audience is the owner) | Needs you |
| **Failed** | `status.entered` with `pill: 'failed'`: a row entered Failed, and it counts for the owner (`countsForOwner`; the evaluator also shows Failed on a worker whose failure went to its lead) | Failed |
| **Stuck** | the row's wait facts (`facts.waits[]`, from Loom): a wait's `consecutiveErrors` reached 3 (`WAIT_UNKNOWN_ERRORS`), the count at which Loom wakes the thread with the error | Stuck |
| **Decided for you** | decision log (`acted`, `defaulted`, rule events) | Decided |
| **Shipped** | a merged PR, or the agent's `shipped` update | Shipped |
| **Update** | the agent's own `desk_update` of kind `fyi` | Update |
| **Summary** | the thread's summary, when its content key moved (new words), throttled per thread | Summary |
| **Done** | the owner marked the row done (desk event ledger) | Done |
| **New thread** | a source created a conversation that began recently | New thread |
| Screen, Prototype, Project status, System, Agents talking | unchanged | unchanged |

- **One post per entry into Needs you or Failed.** `status.entered`
  (`{itemId, pill, from, at}`, emitted by `DeskCore.flush`) always makes the
  post, when the row counts for the owner. A Summary post never takes the
  `needs` or `failed` kind, so it can't cover the entry in its place. (Desk
  Status Phase 2 shipped the reverse as a stopgap: the summary post takes the
  evaluator's pill and `status.entered` skips its post when that summary
  covered the turn. Phase 1 here flips it and deletes `feedCovered`.) A snoozed
  or parked row doesn't post, as now.
- **Stuck isn't an evaluator pill.** The evaluator shows that row as Unknown
  (with the wait's `errorSince` as its "since"), and only when nothing outranks
  it: a Working or Needs you row with a broken wait shows that pill. So Stuck
  reads the wait facts, never the row's pill. It opens when a wait's count
  reaches 3 and closes when a check succeeds (the count resets) or the wait
  leaves `facts.waits` (it fired, timed out, was cancelled or replaced). One
  or two failures stay Waiting and never post. Unknown from a stale heartbeat
  or an unreachable source doesn't post either: that's the desk's own health,
  not news about the thread.
- **Working and Waiting never post.** A thread starting, stopping or arming a
  wait is not news.
- **Leaving a pill doesn't post.** An answered Needs you shows on its original
  post (below), not as a new one.
- **Summary posts are the one place a model's words post on their own.** They
  are labeled as summaries, in the neutral color, and never carry a status pill.
  They are throttled per thread (the current merge and throttle windows). They
  are dropped when the same thread posted an Update or Shipped in that window.
  That's a check on the records, not on the words. `whatsNew` stays as a quality
  filter on Summary posts only. It never decides any other kind.
- **Leads.** Leads already write their news as `desk_update`, so from Phase 2
  Summary posts from a thread that wrote an update in the last day stop by
  default (Settings › Feed › "Summaries from threads that post updates"). A
  lead that hasn't written one keeps the #910 rule: its Summary is judged
  against what its workers posted.

## How a post looks

Two marks, kept apart:

1. **The event pill** says what happened. Neutral colors only: gray outline
   for Summary, Update, New thread, Done, Screen and Prototype; a plain dark
   chip for Decided and Shipped. The words match catch-up's line kinds.
2. **The row's live status dot** says where the thread stands now. It's read
   from the evaluator at render time, in Desk Status colors (amber, red, violet,
   blue, green, gray, outline), with the pill word as its label on hover and for
   voice. A post with no thread (System, Project status) has no dot.

Needs you, Failed and Stuck posts are the exception. Their event pill takes
the status color *while the row is still in that pill*. When the record
closes, the pill turns neutral and gains its outcome: "Needs you · answered",
"Failed · retried", "Stuck · checking again". History stays, and nothing amber
on the Feed is ever stale.

The unread dot: a post whose thread has words the owner hasn't seen carries the
row's unread dot. Opening the post clears it, the same as opening the row.

## The header

The count is the evaluator's Needs you count, with the window's Feed scope as
a filter on top ("3 need you" in Everything is exactly the Needs you tab's
count). Desk Status Phase 2 already did this: `needsYouCount` filters on
`wantsOwner`, which now reads the evaluator's `countsForOwner`. What's new is
the Stuck count beside it when any row in scope has an open Stuck record:
"3 need you · 1 stuck".

## Feed and catch-up

They show the same records over two time ranges. The Feed is everything as it
happens. Catch-up is the part since the owner last looked, collapsed into
moments. Every `desk_updates` ledger row is one Feed post, by its kind:

| Ledger kind | Feed post | Catch-up shows it as |
| --- | --- | --- |
| `needs` | Needs you | Needs you |
| `failed` | Failed | Failed |
| `decided` | Decided for you | Decided for you |
| `shipped` | Shipped | Shipped |
| `fyi` | Update | FYI |

The Feed reads only these ledger sources: `lead` (a lead's `desk_update`),
`auto:pr` (a merged PR) and `auto:decision` (decision log). The others are
skipped because another path already posts them:

- `auto:brief` (`needs`): the brief's row entering Needs you already posts
  through `status.entered`.
- `auto:status` (`needs`, `failed`; added by Desk Status Phase 2): the
  evaluator's own Needs you and Failed rows for catch-up, the same entries
  `status.entered` posts. It also renews a row whenever the pill's detail
  changes, which is not news.
- `auto:incident` (`failed`, then `fyi`): the System post covers the incident.
- `auto:done` (`shipped` or `fyi`): the Done post covers it.

Ledger rows about the same PR are one post, using the same fold rules as
catch-up (`collapse.ts`, catch-up's "Collapsing"), keyed by the PR reference,
not by words:

- A lead's update naming a PR and that PR's `auto:pr` Shipped row are one
  Shipped post. The lead's words stand, and whichever row comes second updates
  the post in place (`data.ref` lists both).
- A routine decision about a PR (merged once green, merged at the Codex cap
  under a rule) folds into that PR's Shipped post. If the PR hasn't merged yet,
  it posts as Decided, and the Shipped post later absorbs it.
- A brief or a failure never folds.

`fyi` is the only kind whose word differs: the Feed calls it Update, catch-up
keeps FYI. No new ledger kind is added. A lead's `desk_update` keeps the kind it
was written with, with one exception the ledger already makes: a `needs` or
`failed` line whose row the evaluator doesn't show in that pill for the owner
is stored and read as `fyi` (`updates.ts` `syncLead`, `withStatus`). So a lead
can't put a status pill on the Feed that the row doesn't have. When a ledger
`needs` or `failed` row and an evaluator transition describe the same thread
entering the same pill, they are one post: the second attaches to the first
(`data.ref`) instead of posting again. Neither surface has
its own rule for what counts. Summary posts appear in the Feed only;
catch-up keeps writing its own chapter prose.

The Feed keeps its own table (`desk_feed`) for ordering, merging and the
entrance animation. Each post records the ledger row or evaluator transition it
came from (`data.source`, `data.ref`), so the two can always be reconciled.

## What goes

Once posts come from records:

- The word-overlap duplicate filters in `feed.ts` (`collapseRepeats`, the stop
  words, decision vocabulary, mended/broken word lists and the four thresholds)
  for every post kind except Summary. Summary keeps only the same-thread repeat
  check until the missed-repeat log (below) stays quiet.
- The summary post's status kind and `feedCovered` (`core.ts` `summarize`,
  `statusEntered`). Desk Status Phase 2 already removed the `source.step`
  posting path and the header's own `wantsOwner` rule.
- The `needsYou` Feed setting changes meaning: Needs you, Failed and Stuck posts
  go out by default (amber only while open). The setting becomes "Show answered
  asks" (off: a closed Needs you post folds into its thread's next post).

## Checking it

- **Missed-repeat log.** For a week after it lands, log every Summary post that
  a pre-change word filter would have dropped, and every pair of posts on one
  thread within 20 minutes. Read the log before deleting the Summary repeat check.
- **Live accuracy.** Add the Feed to Desk Status's 30-row check. For each
  sampled row's last Feed post: its event pill matches the ledger row or
  evaluator transition it names (`data.source`, `data.ref`), since the pill is
  history and may differ from where the row stands now; its live dot matches
  the evaluator's current pill for the row; and a Needs you, Failed or Stuck
  pill is in the status color only if that record is still open.
- **Volume.** Posts per hour by kind, before and after, from `desk_feed`.

## Phases

Both gates in the first draft have passed: Desk Status Phase 2 and the
wait-check count merged on October 20 (#928, #932), and leads already write
`desk_update` (73 `lead` ledger rows in the 24 hours to October 21, against
793 summary update posts). So the work is three PRs, back to back:

1. **State posts:** Needs you and Failed from `status.entered` for the owner
   only, the summary's status kind and `feedCovered` removed, Stuck posts and
   the Stuck count from the wait facts, neutral event pills and the live dot,
   closed-state outcomes on Needs you, Failed and Stuck. One PR.
2. **Ledger posts:** Decided, Shipped and Update posts from the ledger, and
   Summary posts labeled and throttled. One PR.
3. **A week after 2:** delete the word filters per "What goes", after the
   missed-repeat log.

## Out of scope

- Screens, prototypes, system incidents and project status posts (unchanged).
- Feed scope, Screen window roles and the entrance animation.
- The catch-up chapter and its Accept and Defer flow.
- Summary prose quality.

## Open questions

- Should Summary posts stay on by default once most leads post `desk_update`,
  or become opt-in?
- Does Done stay a post, or fold into Shipped when the thread's last update was
  `shipped`?
