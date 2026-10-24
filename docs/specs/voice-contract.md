# Voice: Catch Up With the Desk, and Stay Caught Up

Status: **approved** in owner decision D-458. Scope chosen by owner decision D-398 (October 21, 2026):
fix the places where voice says something the desk no longer means, and add a
test that fails when a new desk state has no voice handling. Builds on
[Desk Status](desk-status.md), [Catch-up](catch-up.md) and
[Decisions and Delegation](decisions-and-delegation.md); changes nothing in
them.

## Why

Each time the desk gains a state, voice falls behind. Voice copies the desk's
data types by hand and writes its own sentences. A JSON cast accepts a new
value without complaint, so the label voice reads out may happen to be right
while the branch it takes is wrong. Where voice asks the server for a finished
answer (who needs the owner, which catch-up line is next, brief revisions), it
stayed current. Where voice puts things into words itself, it drifted.

This spec fixes the drift found in the October 21 voice design review and adds
a contract so the next desk change can't leave voice behind without anyone
noticing. The larger work (one shared spoken projection, briefings from counts,
spoken Decided for you review, PRs in voice, owner notifications) comes later
and is out of scope here.

## Part 1: the drift fixes

Each fix lists what the owner hears today, what they should hear, and where
the code is (as of `eb096b6f`).

### 1. Voice knows all eight pills

Voice's copy of the status type lists six pills; the desk has eight
(`needs`, `failed`, `working`, `waiting`, `stuck`, `finished`, `idle`,
`unknown`, from `apps/screen/server/desk/status.ts`). Voice's `status` type in
`apps/tango-voice/src/live/desk-client.ts` gains `stuck` and `finished` and
`basis`, and the `live` union gains `held`. Part 2's test keeps the copy in step
with the server from now on.

### 2. "Where does it stand?" reads the desk's own status

`speakStands` (`live-operator.ts`, near line 3670) builds its step sentence
from the old `move` and `live` fields and looks for the `watching` label.

- **Waiting:** say the desk's own `status.detail`, the reason shown next to
  the pill (for example "Waiting on the reviewer"). Today a waiting thread gets
  no reason, because voice reads only the old `card.watching` record and never
  `status.detail`.
- **Stuck:** "It said it would keep going, but nothing is running." Never
  "its last turn failed."
- **Finished:** "It's finished" plus `status.detail` (the hand-off text) when
  there is one.
- **Failed, working, needs, idle:** unchanged in meaning; branch on
  `status.pill` first, and fall back to the old fields only when `pill` is
  missing (an older desk).
- **The open ask:** read `card.ask` as "its question for you" only when
  `status.audience` is `owner`. When it is `lead`, say who has it: "Its question
  is with its lead; nothing for you." Never present a lead's question as the
  owner's.

`stepLabel` (near line 5600) returns `stuck` and `finished` as themselves.

### 3. Next up doesn't call Stuck "failed"

`GET /api/desk/next` (`apps/screen/server/desk/view.ts`, near line 126) sets
`step` to `failed` for anything whose compatibility `live` is `failed`, which
includes Stuck. Add the pill to each Next up item (`pill: Pill`) and keep `step`
for older readers. Voice's Next up wording (`apps/tango-voice/src/live/next-up.ts`)
says "stuck" for a stuck item, with the same sentence as part 2.

### 4. Catch-up says "finished", not "shipped"

The update ledger still calls the kind `shipped` internally; the desk shows
"Finished" (`public/desk/feed.js`). Voice's `KIND` table in
`apps/tango-voice/src/live/catchup-walk.ts` says "finished". The internal kind
name doesn't change.

### 5. A knock is rechecked when it plays

Knocks queue by item id (`addKnock`) and play at the next real break
(`maybeKnock`), with no recheck in between. If the lead takes the question
over, a later hand-off retires the ask, or the owner answers on the screen,
the knock still plays.

At delivery, `maybeKnock` re-reads each knocked item (from the current desk
snapshot it already holds; one fetch per batch at most) and drops any whose
`status.countsForOwner` is now false or whose `seen` is now `seen`. If none
are left, nothing plays. This keeps the current rule for what knocks: briefs,
questions and failures with no live lead still knock; this change only drops
knocks that are no longer true.

### 6. Accept says what the desk did, for the plan the owner heard

Two problems, both in the catch-up walk's Accept:

- **The receipt.** `acceptSaid` (`live-operator.ts`, near line 704) builds the
  sentence itself and falls back to "all of it marked seen," but Accept also
  files Finished threads as Done. Voice's `ChapterActResult` drops
  `applied.filed`. Carry `filed` through, and include it in the receipt ("marked
  the finished thread done"). The server's `plan.line` already says what Accept
  will do; where it is present, the receipt builds from the server's result,
  not from voice's own list.
- **The plan.** `chapterAct` (`desk-client.ts`, near line 836) fetches a fresh
  chapter plan at the moment of Accept and submits its revision, so a line
  that arrived after the owner last heard the chapter goes through unheard. The
  walk response carries the chapter plan's `updateIds` and `revision` for the
  focused space (`apps/screen/server/desk/catchup-walk.ts`), voice keeps the
  plan it last spoke, and Accept submits that. When the server answers 409
  "the chapter changed," voice says only what changed and asks again; it never
  resubmits on its own.

Defer gets the same treatment (it uses the same plan fetch).

### 7. Briefs keep their consequences, level and default clock

The server's card brief (`cardBriefs`, `catchup-actions.ts`) has each option's
`consequence`, the brief's `level`, `tripwire` and `vetoLeftMs`. The walk
projection (`catchup-walk.ts`, near line 90) drops all of them. Carry them
through to voice's `CatchupWalkFocus` type. `speakFocus` reads the
recommended option with its consequence ("I'd go with A: it keeps the page
short"). Voice states the default clock only when `vetoLeftMs` is set, in the
owner's active time ("if you leave it, it goes with A after about two hours of
your active time"). It never turns that into a wall-clock time.

This item carries the fields and reads the recommended option's consequence.
A full spoken brief with every option's consequence is part of the later
projection work.

### 8. "Go to the inbox" finds Unfiled

The Inbox is now the Unfiled chapter. `spaceNamed` in voice's
`catchup-walk.ts` treats "inbox" as a name for Unfiled.

### Not in this spec (named so nobody adds them by accident)

- "Undo that one" reversing a decision in focus (today it reverses the last
  voice desk change). That needs the spoken Decided for you review.
- The capacity forecast in voice's capacity answer.
- Pull requests in voice.
- Anything that asks a model to write fewer sentences. Wording changes here
  are fixed templates.

## Part 2: the voice contract and its test

### The contract

A new module, `apps/screen/server/desk/voice-contract.ts`, declares how voice
treats every value of four desk lists:

| List | Source |
|---|---|
| Pills | `Pill` in `desk/status.ts` |
| Catch-up kinds | `UpdateKind` in `desk/updates.ts` |
| Desk commands | the server's command types (the list voice mirrors as `DESK_COMMANDS`) |
| Waiting reasons | the `HELD` reasons in `desk/status.ts` |

Each value gets one policy:

- **knock**: voice may bring it up unprompted, at a real break.
- **when asked**: voice answers about it when the owner asks, never
  unprompted.
- **silent**: voice says nothing about it on purpose, with a one-line reason
  (for example: a color has no spoken form).

Each desk command also names its spoken receipt source: `server` (the
command's result says what happened) or `fixed` (a fixed sentence in voice,
with the sentence named in the contract).

Written as a `Record<Pill, …>` (and so on) with `satisfies`, so a new value
breaks the type check where it is defined.

### The test

1. **Server side** (`apps/screen`): for each list, the test enumerates the
   values at runtime (export each list as a `const` array next to its type if
   it isn't one already) and fails when a value has no entry in the contract,
   or an entry names a value that no longer exists. The failure message says
   what to do: "New desk state `<value>`: add it to voice-contract.ts as knock,
   when asked, or silent."
2. **Voice side** (`apps/tango-voice`): a test checks that voice's copied
   unions (pill, live, catch-up kind, command list) match the contract's
   lists. Because the two apps share no package, the server writes the lists to
   a committed fixture (`apps/tango-voice/test/fixtures/desk-contract.json`)
   from a script, and the server test fails when the fixture is out of date.
   The voice test reads the fixture. Use a direct test-only import instead if
   the build allows it cleanly; the requirement is that a new server value
   fails a test in both apps until voice is updated.
3. **Behaviour checks:** for every pill marked `knock` or `when asked`, a voice
   test feeds a desk item with that pill to `speakStands` and asserts the
   sentence is the contract's (no "failed" for Stuck, a reason for Waiting, no
   "question for you" when audience is `lead`).

`AGENTS.md` gets one line under the desk section: "A new pill, catch-up kind,
desk command or waiting reason: classify it in `voice-contract.ts`." The test
is the enforcement; the line just tells people where to look.

## Tests for Part 1

Each fix gets a test in the existing suites
(`apps/tango-voice/test/catchup-walk.test.ts`, the live-operator tests,
`apps/screen` desk tests):

- Where does it stand: waiting with a reason, stuck, finished with hand-off
  text, an ask addressed to a lead.
- Next up: a stuck item carries `pill: 'stuck'`; voice doesn't say "failed".
- Catch-up: a `shipped` line is spoken as "finished".
- Knock: queued for an item, the item stops counting for the owner before the
  break, nothing plays; two queued, one retired, the knock names one.
- Accept: the receipt names filed threads; a plan that changed after it was
  spoken comes back 409 and voice reads the change instead of resubmitting.
- Brief: the recommended option's consequence is read; the default clock is
  spoken only when `vetoLeftMs` is set, and in active time.
- "Go to the inbox" reaches Unfiled.

Run: `npm test -w @tango/tango-voice`, the `apps/screen` desk tests, and both
apps' typecheck. Then one pass on the voice lab against the sandboxed test desk
(`npm run desk:test`, then `npm run lab:desk-e2e -w @tango/tango-voice`) with a
stuck, a waiting and a finished thread, and the transcript attached to the PR.

## Done when

- Every fix in Part 1 is in, with its test.
- The contract covers every value in the four lists, and adding a test value
  to any of them makes both apps' tests fail with the message above.
- One PR, with "Changes earlier work" naming the voice catch-up and desk status
  PRs whose wording it changes.
