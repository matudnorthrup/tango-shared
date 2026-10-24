# Catch-up and seen

How the Agent Desk catches the owner up on what happened across their projects
while they were away, and how it knows what they have already seen (October
2026). Designed over five prototype rounds with the owner. Active plans and
status live in Linear. Related: [agent-desk-next.md](agent-desk-next.md) (layout),
[spaces.md](spaces.md) (spaces, defaults and leads),
[decisions-and-delegation.md](decisions-and-delegation.md) (briefs, Decided for
you, the board).

## Why

A lead's chat reply runs long because it retells everything that happened, and
the owner misses most of it anyway.

On a busy 8-hour stretch away, the desk sees hundreds of feed events across
dozens of threads, a few hundred agent messages, and dozens of mails between
agents. Leads write long replies. Most of the active threads are never opened
afterward. Activity still spans only a handful of projects, so grouping by
project shrinks the list about tenfold. (The measurements behind this are kept
in the owner's private profile, not in this repo.)

What exists today, and why it isn't enough:

- **The feed** is a firehose of mid-work updates with no read state.
- **Seen** is tracked per thread (`attention.seen`, `coveredUntil`), never per
  update.
- **Decided for you** is the only "confirm you've seen it" surface. It has a
  single high-water mark (`decided_seen_at`).
- **Where it stands** on a project page is the summarizer's headline of the
  lead's latest turn. In all seven leads checked it read as last news, not
  status, and it lagged whatever the project was really about.
- **Voice "catch me up"** reads only asks and failures, never what shipped.

## Principles

1. **One project at a time.** The owner gets their head around one project
   before moving to the next.
2. **What matters gets its own moment.** A brief to answer, a weighty decision
   made for them, or a milestone shipped is a full card. Everything else folds
   into short lists. Updates are never treated as equals.
3. **Seen at the grain it was shown.** A moment is seen when the owner acts on
   it. The rest of a project is seen when they accept or defer the project.
4. **Seen once, seen everywhere.** The project page, Catch me up, voice, the
   sidebar and the lead all read the same marks.
5. **Leads stop retelling.** A lead is told what the owner has already seen and
   points to it instead of repeating it.
6. **Available where they already are.** The catch-up lives on each project
   page. Catch me up is a walk through the same content, not a separate store.
7. **Only what is true now.** Every ask the owner sees has an open line behind
   it, and every line has something that closes it. Nothing carries forward
   from older prose.

## The update ledger

Every catch-up surface reads one ledger of **updates**: short, typed lines
about a space.

```
desk_updates(
  id, space_id, item_id,          -- the space, and the conversation it came from
  kind,                           -- needs | failed | decided | shipped | fyi
  moment,                         -- 1 if it gets its own card, else 0
  title,                          -- at most ~14 words, a finished sentence
  detail, refs,                   -- one or two sentences; links (PR, brief, preview)
  shot,                           -- optional image (a screenshot of what shipped)
  brief_id, decision_id,          -- when it is a brief or a decided-for-you entry
  rule_event_id,                  -- when it is a delegation-rule event
  covers_from, covers_to,         -- the conversation messages it represents, if any
  source,                         -- auto:pr | auto:decision | auto:rule | auto:brief | auto:incident | auto:done | lead
  supersedes, at,
  seen_at, seen_via, outcome      -- see "Seen"
)
```

### Where updates come from

- **Automatic:**
  - A merged PR becomes `shipped`.
  - A Loom `acted` or `defaulted` decision becomes `decided`.
  - A delegation-rule event from the learning loop (rule created, reaffirmed,
    suspended, or a class demoted) becomes `decided`, always as a moment. A new
    or reaffirmed rule carries the same "how it counts" controls the Decided for
    you card has today (Always, Ask me next time, Just this once). A suspension
    or demotion carries Undo where Loom offers one. These events reach the owner
    in the chapter right away, so an automatically promoted rule is never live
    without notice and a way back.
  - An open brief becomes `needs`.
  - A System incident becomes `failed`, and later `fyi` when it resolves.
  - A thread marked Done becomes `shipped` or `fyi`, from the summarizer's
    `headline`.
- **Written by leads:** a `desk_update(kind, title, detail?, moment?, refs?,
  shot?, supersedes?)` tool covers anything the automatic sources miss. Workers'
  updates roll up to the space of the conversation they report to.
- **Superseding:** a newer line on the same subject replaces the older one. For
  example, "Backup failed" becomes "Backup failed, now fixed". The owner sees
  the latest state, not its history.

### What makes a moment

| Kind | It's a moment when | Otherwise |
|---|---|---|
| `needs` | Always (an open brief, or an open hand-off ask) | — |
| `failed` | It is still broken, or it cost something (data, downtime, a missed deadline) | `fyi` once resolved at no cost |
| `decided` | It is a rule event (always), or it caused an outage or spent money, it changes how the desk behaves for the owner, or it is a class the owner hasn't confirmed before | A routine decision ("merged once green") |
| `shipped` | The lead marks it a milestone: it closes an epic or phase, or the owner will notice it. It carries a picture and a link to try it | A line under Shipped |
| `fyi` | Never | A line under FYI |

The lead proposes `moment` when it writes an update. The rules above are the
defaults and the guardrails. An open brief or ask is always a moment, whatever
the lead says. A routine decided-for-you class is never one. Each **Fine by me** moves a
class toward routine (see "Learning"), so the number of moments falls over time.

### Collapsing

Adopted in D-94 (built in TGO-1112). The ledger keeps every line. The card collapses
them so that one fact is one line, and then groups the rest:

1. **One event, one line.** A routine decision about a PR (merged once green,
   merged at the Codex cap under a rule) folds into that PR's Shipped line as
   detail. A lead's update that names a PR is the same event as that PR's
   Shipped line: the lead's words stay and the PR line folds under them. A
   deploy restart names a release, not a PR, so it does not fold: rule 2 sends
   it to the Routine group instead.
2. **Routine ops are not moments.** An `ops-own-machine` decision (a restart, a
   deploy, a backup change) is a moment only if it failed, didn't come back,
   lost data, or was down for more than a minute. That holds even once the
   class has turned routine or a rule allowed it. A duration counts only when
   it is time down; how long a job ran does not. "Hit something the owner was
   using" is not a test of its own: a restart the owner felt either was down
   for over a minute or didn't come back.
3. **A decision under a standing rule is routine.** Loom's `GET /decisions`
   returns the `rule` a decision cited, and that line is never a moment.
4. **Rule changes batch.** A chapter's rule events show as one moment, "N rule
   changes", with each rule's controls inside it. Each new rule still reaches
   the owner right away.
5. **Shipped groups by theme.** The chapter writer clusters the smaller Shipped
   lines and titles each group. Without the writer, lines group by their PR's
   scope. The writer may promote one group to a milestone moment.
6. **At most three moments on the card**, in this order: needs, broken, rules,
   milestone, decided. Any overflow shows as "+N more moments" ahead of the
   smaller groups.
7. **Owner language, no bare ids.** The owner doesn't track reference numbers,
   so no D-n, R-n, E-n, #PR or TGO-n appears in a line's title, the headline,
   the status, the "Accept will…" line or the brief label; the thing is named in
   words ("the phase 3 plan", "the merge rule for capped PRs"). An id may appear
   only as a link label inside an opened line's detail. Commit prefixes, release
   hashes and PIDs come out too. The writer gives every highlight a short title
   (about 8 words, "Approve the phase 3 plan?") and the full text stays as its
   detail; without one the line's own title is stripped deterministically. The
   headline is at most two sentences and about 35 words, and says what is true
   now: nothing the owner has already handled is said to wait on them, and
   nothing an open needs line asks for is said to be done (a headline that
   does is sent back once, then replaced by the plain one). The
   status has the same limit: one sentence on where it stands, then its
   **Next:**. The writer is asked to write within the limits, and asked once
   more when it runs over; the card cuts at a word only as a last resort,
   after dropping to one whole sentence. A sentence ends only at a period
   before a space, so an address or a version stays whole, and a clause whose
   id was all it named ("Next: TGO-1068") is dropped. Titles describe the
   effect the owner notices, not the internal mechanism's name.
8. **The headline refreshes when a line is handled or an ask closes.** The
   writer runs again within a minute of the owner handling a line, or of any
   open needs line closing wherever it closed, without waiting out its
   30-minute gap. When the writer's rules change, every chapter written under
   the older rules is rewritten once on the next pass.

Needs-you briefs and failures are always individual moments; collapsing applies
only to things that need nothing from the owner. Chapter counts (the sidebar dot,
the Inbox summary, "N new") count moments after collapsing, including any behind
"+N more moments". The three-moment cap is never applied to them, so a waiting
brief can't drop out of the dot.

A rule the owner made or reaffirmed from their own answer is theirs, not news, and
Loom no longer sends it. Open lines for such rules that were recorded earlier are
marked handled once, `via: acted`.

## The chapter

A space's **chapter** is its updates since the owner last caught up on it,
plus two lines of prose:

- **Headline:** one or two sentences on what happened, written from the
  owner's side ("Decisions phase 2 shipped overnight. The phase 3 plan is the
  one thing waiting on you.").
- **Status:** written once the chapter is handled. It says where the project
  stands now, followed by **Next:** (from the summary's milestone).

Both are rewritten by one cheap model call over the chapter's updates, using the
same pattern as the coordinator's old status write. They run when a space's
updates change and then go quiet, at most every 30 minutes. A lead can set
either directly with a separate tool, `chapter_note(headline?, status?)`. It
writes the space's chapter metadata, never a ledger row, so it never shows up in
update queries or counts. This replaces
"Where it stands" as the summarizer's lead headline, and the coordinator's
leftover status.

### Staying current

An update is a fact when it is written. It stops being true when the owner acts
somewhere else, when a decision overtakes it, or when a lead moves on. Three
rules keep the catch-up current:

- **Every ask closes on something.** A brief closes on its decision, within a
  minute of the answer. An incident closes when System resolves or holds it. A
  thread's ask closes on that thread's next closing handoff (see "Owned asks").
  As a backstop, every lead turn's preamble still lists the space's open lead
  asks by id: "These still show on the owner's catch-up as open. If one is no
  longer true, close it now." It closes one with a `desk_update` that
  supersedes it and says what happened.
- **The prose is written from the lines alone.** The writer never sees its
  previous headline or status, so a claim can't outlive the line it came from.
- **A wait needs an open ask behind it.** A headline or status clause that says
  something waits on the owner must name an open needs line. If it names none
  (the writer carried it, or a lead's note outlived its ask), the writer is
  asked once more. If it still names none, the plain headline is served from
  the open lines, both when the prose is written and when the card is read.
- **What waits on the owner is built from records.** The headline starts
  with a half the desk writes itself from the open asks Needs you counts:
  "Waiting on you: <the ask>." for one, "N things are waiting on you." for
  more (`Chapter.waits`). The writer is told to leave that half out and writes
  only the rest, which may be empty. The card and Catch me up set the
  record-built half apart in amber.

### Owned asks

Adopted in D-413. Every ask on the catch-up belongs to one thread: the thread
whose state it describes. Higher levels show that thread's ask by reference.
They never write their own copy. A copy can only be closed by whoever wrote it,
on their next turn. A reference closes everywhere at the moment the original
does.

Why: in a two-week sample of the live ledger, almost every needs line already
came from the owning thread's own handoff, and those stayed current. The stale
ones were copies: a lead's line about an ask the owner had already answered in
that thread, still open a day later; a lead's update and its own handoff saying
the same thing as two lines; and handoffs whose whole ask was "answer the
question on the other thread's card" or "that brief is still open". Headlines
trailed their lines by at most about half an hour, so they were a minor cause.

1. **One owner per ask.** An ask's owner is the thread that raised it: through
   an open brief or request, its closing handoff (`auto:status`; an `A-n` ask
   record since D-468), or its own `desk_update` of kind `needs`. A line's `item_id` is its owner, and only the
   owner or a record (a decision, a PR, a resolved incident) changes it.
2. **A handoff is the thread's current word.** When a thread writes a new
   closing handoff, its earlier open needs lines (including `lead` lines it
   wrote itself) are settled unless the new handoff still asks for the same
   thing. A line it still asks for folds into the handoff's line, so one ask is
   one line. An owner's reply in the thread starts a turn that ends in a
   handoff, so an ask answered in chat leaves within that turn.
3. **No copies passed up.** A handoff or `desk_update` whose ask names another
   thread's open brief (a D-n, read with `namesDecision`) writes no line of
   its own. It is shown as carried with the original, as desk rows already
   carry briefs (`desk/asks.ts` `carryBriefs`), and it closes with it. The same
   holds for a worker's handoff ask: its lead carries it, as it carries its
   workers' briefs, and doesn't restate it.
4. **Rolling up is a query.** A lead's chapter, the project card, the Inbox
   summary and Catch me up read the owning threads' lines, grouped by who
   reports to whom. Nothing is written at a higher level to say what a lower
   thread already says.
5. **Leads still connect the dots.** A lead may write its own line about the
   whole ("Phase 2 is complete"), as `shipped` or `fyi`. It may not write a
   `needs` line for something a worker owns. The standing instructions say so:
   "Don't restate a worker's ask or another thread's brief. Your row carries
   it."

Owned asks rest on records, as rechecking does: the owner is a field, the
settling handoff is a Loom record, and a carried brief is matched by its id,
never by wording. A recorded hand-off ask (decisions-and-delegation.md, "The
hand-off ask") the same: across spaces a repeat folds only under the same ask
id (`triage.ts` `crossFolds`), so two threads that record the same words are
two asks, each with its own card, steps and Did it; only a words-only line
from an older source folds under one by its words.

### Rechecking

Every line rests on records, read from its fields, never its words
(`desk/recheck.ts`, R-21): its brief or decision (`briefId`, `decisionId`, a
`/decision/D-n` link in its refs), and its PRs (PR links in its refs, or an
automatic `pr:` subject). On every sync pass each open ask and shipped line is
checked against what those records say now. Only a change in meaning counts:

- **Needs you → settled:** a lead's ask that names a decision the ledger shows
  decided or answered. (A brief's own line already settles with its brief.)
- **Shipped → reverted:** a PR undone by a merged revert. GitHub's Revert
  button writes "Reverts owner/repo#N", and the ledger reads each repo's merged
  reverts at most every 10 minutes for shipped lines from the last week.
- **Shipped → not shipped:** a lead said it shipped, but the PR it links was
  closed without merging.

What happens depends on whether the owner saw the line:

- **Unseen:** it is replaced quietly. An ask just leaves, as an answered brief's
  does; the decision's own line is the news. A shipped line is replaced by an
  FYI that says what is true now.
- **Seen:** one **Changed since you saw it** moment on the same subject. It
  shows what they were told (struck through) and what is true now, and goes
  first among the chapter's moments. Got it marks it seen.
- A change from before rechecking first ran is history: replaced quietly
  even when seen, so the first pass doesn't flood the catch-up.

Later slices follow desk status v2 (asks that name what closes them, waits and
source health). A thread's handoff as its ask is covered by "Owned asks".

## Surfaces

### Project page: the card replaces Where it stands

The card sits where Where it stands sits today: under the About line, above Ask
and the view pills. Ask, the pills and the thread groups are unchanged. There is
no Catch up tab. The card has two states.

**Since you were here** (the chapter has news):

```
⌁ Since you were here  [3 new]                 Sun 9:00 pm → now · Desk lead
Decided for you shipped overnight, so decisions phase 2 is complete. The phase 3
plan is the one thing waiting on you.
● Approve the phase 3 plan?                                      Needs you
● Decided for you is live on your Inbox                          Shipped
● Leads now carry their workers' asks                            Decided for you
○ 4 smaller updates
Open ›
[Accept] [Snooze]
Accept will choose A on D-33 · fine on 1 decision · mark the rest seen.
```

- Each moment is one line with a dot in its kind's color: amber needs, red
  failed, blue decided, green shipped, blue FYI. A hollow dot means the
  smaller updates.
- **Open** expands the card in place:
  - **Briefs:** compact `BriefCard`, with full-width option rows, the recommendation
    starred, the tripwire pill and default clock, then Full brief and Snooze.
  - **Decided for you:** Fine by me, Undo (when there is a way back) and "I
    wouldn't have".
  - **Shipped:** the picture, Try it, and Got it.
  - The smaller updates follow, grouped as Shipped, Routine decisions and FYI.
  - Fold closes the card again.
- **Where it stands** (handled, or no news): shows the status line, "Next:",
  any brief still waiting on the owner's pick (amber lines), and "What changed
  since …", which reopens the last chapter.

### Accept and Snooze

- **Accept** handles a whole chapter at once:
  - It takes the recommended option on every open brief.
  - It says Fine by me to every decided-for-you moment (never to a rule event,
    which it just marks seen).
  - It marks the rest seen.
  - For each still-Finished row whose line it shows, it files a thread Done or
    clears a standing conversation in place ([standing conversations](spaces.md#a-standing-conversation-is-cleared-never-done)).
    The plan and result distinguish filed threads from cleared defaults.
  - The line under the button always says exactly what it will do.
- **Accept never decides what the board keeps for the owner.** It skips:
  - level 1 classes (creative work for publishing, acting in the owner's name,
    spend, deletes with no copy)
  - any brief with a tripwire
  - any brief with no recommendation
  - any hand-off ask (D-468): it needs the owner's hands or words, so there is
    nothing to accept or resolve; Accept does not mark its line seen

  Those stay on the card as "Left for you". Briefs count as seen; asks remain
  unseen until the owner acts or defers them. Answers go through Loom's normal brief answer path, with one
  difference: **a bulk Accept never creates a standing rule.** It answers a
  promotion candidate with "Ask me next time", and its preview line says so
  ("no new rules; D-33 could become one — answer it on its own to make it a
  rule"). Wakes and everything else behave as when the owner answers one by
  one.
- **Snooze** means seen, not decided:
  - The chapter leaves today's catch-up and its counts.
  - Nothing is answered. Briefs and asks stay in Needs you.
  - Per D-679 (option A), Snooze opens the existing picker: In 2 hours,
    This evening (Tomorrow evening after that time), Tomorrow morning, Monday,
    and Custom. The header says ‘Snooze <space name> · briefs stay in Needs you’.
    Esc and Cancel close without acting. The chapter returns at the chosen time,
    or sooner if a new moment arrives. Settings still supply the morning/evening times.
  - Leave out ‘I’m at my desk’ (no chapter presence trigger), ‘When they post again’
    (new moments already bring a chapter back), and ‘Park it’ (dismissal is not snooze).
  - A quiet saved-state footer on Catch me up says ‘2 snoozed · back <earliest time>’.
    It expands into a list with tile, name, return time and Open for each chapter,
    and persists across visits. It does not depend on Done here.
  - Storage keeps `deferred`, outcome `later`, and the `/defer` route: no migration.
  - The lead is told "seen, deferred". It doesn't retell the chapter in the
    meantime.
- Each brief or ask moment also has its own **Snooze**, with the same meaning
  for that one brief or ask.

### Sidebar

- **A dot.** A small teal dot right after a project's or agent's name marks a
  chapter with something that matters (at least one moment).
- **No dot for smaller updates.** A chapter with only smaller updates gets no
  dot.
- **Counts unchanged.** A parent shows the dot when any child has one. As with
  its counts, an open parent speaks for itself: its children show their own
  dots under it.
- **Catch me up row.** A sidebar row, "Catch me up", sits at the top of INBOX.
  Its counts follow the usual shape: the number of open moments, and Needs you.

### Inbox summary

A card at the top of the Inbox's first view replaces the Decided for you card:

```
Since 9:00 pm   480 events in 40 threads, across 9 projects
● 4 need you in Desk, Tango Server, Studio, …
● Worth a look in Redline, Notifications
● Smaller updates in 5 more
[Catch me up]
```

- **Decided for you folds into chapters.** Its entries become `decided` updates,
  and its Undo and "I wouldn't have" move onto the moment card. Its rule events
  and their controls move too (see "Where updates come from"). The card is
  retired only after the rule-event stream and controls are live in chapters.
- **The ledger stays the backing store.** `decided_seen_at` is retired;
  `seen_at` per update replaces it.
- **Built (TGO-1104).** A new rule's moment (or one approved again) carries
  Always / Ask me next time / Just this once; a choice there is recorded on the
  line and handles it. The card, `GET /api/desk/decided` and its seen cursor
  are gone; the weekly Delegation review stays on the Inbox. Catch me up's row
  and button open its page (TGO-1105).

### Catch me up

A desk page (`Inbox › Catch me up`), opened from the sidebar row, the Inbox
summary, or the voice command "catch me up". It's one column, with no third
sidebar.

1. **The focus card.** It's on top and full size: one moment, with the space's
   tile, name and headline above it. Acting on it (answer, Did it, Fine, Got
   it, Snooze) brings up the next. **Skip** moves on without marking it seen.
   - **The ask card (D-468).** A `needs` moment whose record is a hand-off ask,
     not a brief, gets its own card bound to the ask record
     (decisions-and-delegation.md, "The hand-off ask"): the thread, a label
     from the kind (To do, Answer, Reply), the ask, its steps as a checklist,
     and **Did it** (a `do` ask, or one step), a reply field (sent to the
     thread as the owner's message, which closes the ask as answered),
     **Snooze** and **Open thread**. Did it is `ask.resolve`; nothing on the
     card writes text to decide a state. Legacy and unclear asks offer reply
     only, without Did it. Each step tick resolves that step; the last closes
     the ask. A pending question shows its chips as on the row.
2. **Everything left: the map**, compact, one row per space, grouped **Needs
   you**, then **Worth a look** (moments, but none asking), then **Smaller**.
   - **A row** shows the tile, the name, one dot per moment (hollow once
     handled), "1 needs you · 2 to see · 4 small", and Accept or Snooze.
   - **Opening rows.** The focus card's space is open and lists its other
     moments. Any row opens on a tap. Tapping a line makes it the focus card.
   - **Smaller.** Every space with only smaller updates shares one row. It opens
     to a line or two per space, with one **Got it** for all of them.
   - **Done here.** This comes last: spaces accepted, deferred, or left with
     picks for the owner.
3. **Order:** spaces that need the owner come first, then by weight. Within a
   space, moments go in kind order: needs, failed, decided, shipped.
4. **Phone:** the same column. A row's summary text hides, and its buttons
   wrap.
- **Built (TGO-1105).** The page is `{ page: 'catchup' }`. The sidebar row and
  the Inbox summary's button open it while anything is waiting, and the row
  stays lit while you're on it. Skip and a tapped line are this visit only.
  Leaving the page forgets them. A space accepted, deferred or got-it moves to
  Done here and stays there unless a new moment arrives after. A deferred space
  shows when it's back. The page reads every listed space's chapter, and a
  dot stays (hollow) for each moment it showed that has since been handled.

### Voice

- "Catch me up" opens Catch me up and reads the focus card. It speaks the
  space, the kind, the title and the options, saying which one it would pick.
- The operator acts only on the focus card:
  - "next" and "skip"
  - "go with A", "that's fine", "got it"
  - "accept <space>" and "skip this project" (Snooze)
  - "what's left?" (reads the map: per space, what needs the owner and what's
    open)
  - "go to <space>"
- A line read aloud is marked seen `via: heard`. Answers go through the same
  paths as taps.
- House screens show Catch me up read-only, following the voice session. They
  never mark anything seen.

## Seen

- Each update has `seen_at`, `seen_via` (`acted | accepted | deferred | heard |
  read`) and `outcome` (the option chosen, `fine`, `undo`, `disagree`, `ok`,
  `later`).
- **A moment is seen** when the owner acts on it:
  - **Briefs:** a brief stays open in Needs you until it's answered, even after
    it's seen.
  - **Snoozing:** a deferred brief is `later`. It is seen, but still open.
- **The rest of a chapter is seen** when the owner Accepts or Snoozes it, or
  passes it in Catch me up.
- **Threads catch up too, only through what the update represents.** An
  update that summarizes conversation content records that span
  (`covers_from`..`covers_to`). Seeing the update covers those messages, and
  `coveredUntil` advances only while the covered messages are contiguous from
  the current mark. An unread message the update doesn't represent stops the
  advance, so the thread stays unread. An update with no span (a PR merge, an
  incident) never changes a thread's read state.
- **And the other way, only for what was shown.** The thread view renders its
  ledger entries inline, as folded update lines in the conversation. The viewed
  timer (3 seconds on screen) marks only the entries actually rendered and
  visible as seen `via: read`. An update a lead posted only to the ledger stays
  unseen until it is shown somewhere.
- **One source for every surface.** The project card, the map, the sidebar dot,
  the Inbox summary and voice all read these marks.

## Leads stop retelling

- **Turn preamble.** When a lead's turn starts, Loom adds one block: what the
  owner has seen in this space since the lead's last turn (update titles and
  outcomes), and any chapter they deferred. The block says "Don't retell these.
  Point to them."
- **Standing instructions.** These go in every space default's standing
  instructions:
  - News goes in `desk_update`, not chat. Anything that would have been a
    paragraph of "what happened" becomes updates.
  - A chat reply answers what the owner asked, then at most one line pointing to
    the chapter ("Two things are in the catch-up").
  - Never restate a brief's options in chat. The card shows them.
- **Target.** The median lead final reply falls under 60 words.

## Learning

- **Fine by me** on a decided-for-you moment is a recorded confirmation. It is
  `decision.confirm {decisionId}`, the opposite of a reversal. It goes only to
  a real decision Loom acted on or defaulted: a rule event (a new rule, a
  suspension, a demotion) is news about the loop, so its line gets Got it, and
  Loom refuses a confirm on an open, answered or reversed decision. The decisions
  learning loop ([decisions-and-delegation.md](decisions-and-delegation.md),
  phase 3) reads confirmations and reversals together. A class with steady
  confirmations becomes routine and stops being a moment.
- **Accept** records Fine on each decided moment it covers, and an unchanged
  approval on each brief it answers, for the learning loop's track record. It
  never promotes a rule; promotion under R-2 needs a one-by-one answer, where
  the brief card shows the rule it would create.

## API

- `GET /api/desk/updates?space=&since=&unseen=1`: the updates for a space, or
  for all spaces.
- `GET /api/desk/chapters`: per space, its headline and status, its counts of
  moments, needs and smaller updates, and its state (`news | caught_up |
  deferred`). This feeds the sidebar, the Inbox summary and the map.
- `POST /api/desk/updates/seen {ids, via, outcome?}`
- `POST /api/desk/chapters/:space/accept {updateIds, revision}` and
  `POST /api/desk/chapters/:space/defer {updateIds, revision, backAt?}`. Both act only on
  the updates the owner was shown. If the chapter changed since (a brief or
  moment arrived, an update was superseded), the server refuses with the new
  revision and plan, and the desk re-renders the card and its preview line
  instead of acting. Accept returns the plan it applied and what it left for
  the owner.
- Loom: the `desk_update` and `chapter_note` tools, `decision.confirm`, and the
  lead turn preamble.
- Optimistic on the desk like every other command: a refusal takes the change
  back with Retry.

## Metrics

- Median and 90th percentile of the words in a lead's final reply (target:
  median under 60).
- The share of moments handled within a day of arriving, and the share of
  chapters caught up rather than left.
- How Accept is used: briefs answered by Accept, and reversals within 7 days of
  an Accept versus a one-by-one answer.
- Moments per space per day. This should fall as classes become routine.
- Threads never opened after an away stretch.

`node scripts/catchup-metrics.mjs [--days 14] [--json]` prints these from the desk's ledger and Loom's store, read-only.
Both keep 30 days, so run it at least monthly. Away stretches are gaps of four hours or more in the owner's presence,
and a thread counts as opened when it is viewed, read or heard within three days of the stretch ending. The reply target
is for leads (Loom's default threads); interactive threads print on their own line. A chapter is one Accept (caught up)
or Snooze (left). Briefs answered count only the owner's answers, not a default that ran or a brief withdrawn, moot or
superseded. Per-day rates divide by the days the ledger covers, not the whole window.

## Phases

1. **Ledger.** The table, automatic sources, superseding, seen marks, and the
   read API.
2. **Leads.** The `desk_update` and `chapter_note` tools, moment rules, chapter headline and status
   writing, standing instructions, and the turn preamble.
3. **Project card.** It replaces Where it stands, in both states, with Accept and
   Snooze and `decision.confirm`.
4. **Sidebar and Inbox.** The dot, the Catch me up row, and the Inbox summary.
   Retire the Decided for you card.
5. **Catch me up.** The focus card, the map, smaller updates, Done here, and
   deferral resurfacing.
6. **Voice.** "Catch me up" opens and drives the page, and house screens follow
   it read-only.
7. **Measure.** Track the metrics above. Tune the moment rules after two weeks
   of use.

## Rulings

Owner decisions from the design rounds (D-35, D-43, D-60, D-64, D-413):

- Updates are not equals. Briefs and weighty decisions are highlight moments,
  not one line each.
- Catch up one project at a time.
- The catch-up replaces Where it stands. It isn't a tab, and it isn't added
  next to it.
- Accept and Snooze replace a bare "Caught up".
- Catch me up is one flow for the desk and voice. The map sits below the focus
  card; no third sidebar.
- The sidebar marks news with a dot after the name (chosen over a catch-up
  count).
- There is no dot on any tab.
- The Inbox summary stays.
- Each ask belongs to the thread that raised it; higher levels show it by
  reference and never write a copy (D-413).

## Open questions

- Whether the owner triages from Catch me up or from each project page. Both
  read the same data, so build both and watch which one gets used.
- When a deferred chapter comes back, should it show "deferred yesterday"?
