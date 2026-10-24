# Decisions and delegation

Status: design agreed 2026-10-18 (rulings D-1 to D-3 below); phases 0, 1a, 2a and 2b shipped; 3 built (the learning loop: rules, class levels, rule chips, the weekly review). A product pillar: which decisions agents make on
their own, how the ones that need the person reach them, and how each ruling
the person makes reduces how often they are asked again. Active plans and
status live in Linear.

## Why

Agents stop for the person far more often than they need to, and when they do
stop, the ask is hard to answer.

A review of real asks from coding and PM threads (AskUserQuestion calls,
turns ending in `Next — you:`, and the open asks Loom recorded) found a
pattern. The detailed, attributable inventory stays in the operator profile,
not in this repo.

- **Most asks didn't need the person.** The agent's recommendation was usually
  taken unchanged. That was almost always true for operations on the person's
  own machines, for "go ahead / continue?", and for product choices inside an
  approved feature. Outright rejections were rare.
- **Overrides cluster in a few places:** taste and creative calls on published
  content, design direction, "do more now" scope, and picking a reviewer.
- **Only a few asks were real gates:** credentials and sign-ins, acting toward
  other people on the person's behalf, and irreversible changes without a
  verified copy.
- **The way asks were posed was the larger problem:**
  - The same ask was repeated every turn.
  - Asks were made in threads the person doesn't read.
  - Several decisions were stacked in one closing line.
  - Questions came with no recommendation.
  - Some asks couldn't be answered without reading the thread.
  - Some asked for work the agent could do itself.
  - Many open asks were "try it and tell me", which the person doesn't answer.

Today's machinery is not built for decisions:

- **An ask is just text.** It is one regex-matched closing line (`closingHandoff`
  in `packages/loom/src/handoff.ts`), capped at 200 characters and stored as one
  overwritable blob per thread (`threads.ask`). It has no options, background,
  assets, deadline or identity. (D-468 gives it a declared kind, an id and a
  recorded state; see [The hand-off ask](#the-hand-off-ask).)
- **Nothing records a ruling as a decision.** Rebuilding one means joining an
  ask message to the next owner message.
- **Per-agent autonomy settings are not enforced.** `responsibilities.autonomy`
  in `config/v2/agents/*.yaml` is parsed and never read. The operating guide's
  escalation sentence is the only policy in force.

## Principles

Drawn from leadership practice. Sources are listed at the end.

1. **Classify before asking.** Each decision gets a class, a door type (one-way:
   hard to undo; two-way: undoable) and a blast radius (private, team or
   public). A two-way door below every threshold belongs to the agent. *(Bezos,
   Type 1 and Type 2 decisions; delegation-of-authority matrices.)*
2. **One board says who decides.** A versioned file maps each decision class to
   a level. Agents read it before stopping. They never assume authority it
   doesn't grant, and never ask for authority it already grants. *(Appelo,
   delegation levels.)*
3. **Intent travels with the work.** Each delegated task states its purpose,
   end state, constraints and the risk the person accepts. When the plan breaks,
   the agent re-plans toward the end state. It stops only when every route
   breaks a constraint. *(Commander's intent, ADP 6-0.)*
4. **Never "what should I do?"** An ask arrives as completed staff work: the
   recommendation is made, the action is prepared, and "approve" executes it.
   The next move stays with the agent. *(Completed staff work; Oncken, "Who's
   got the monkey?")*
5. **Check precedent first.** Before asking, the agent looks for a standing
   rule or a recent ruling that covers the case. A matching one is the
   authority: act, and cite it. *(Dalio, principles as codified precedent;
   architecture decision records.)*
6. **Every ruling is a candidate rule.** The person's answer is stored with its
   reason and scope, because the reason, not the verdict, is what generalizes.
7. **Delegation is earned by evidence and lost the same way.** A class the
   person keeps approving unchanged is proposed for promotion to a standing
   rule. Reversals spend a budget, and an overspent class drops a level
   automatically. *(ITIL standard changes; SRE error budgets; Grove,
   task-relevant maturity.)*
8. **A high approval rate means the prompt is noise.** Approving 90% of a class
   is rubber-stamping, not oversight. Move that class to "act and tell" and
   audit a sample instead. *(Anthropic, permission-prompt approval fatigue.)*
9. **Some things always come up**, whatever the board says: the person's
   identity or credentials, money, acting toward other people in the person's
   name, security and privacy, a one-way door without a verified copy,
   conflicting precedents, and anything that would surprise the person
   tomorrow. *(Netflix, the triggers for a manager to step in.)*
10. **Disagree and commit, in writing.** An agent that thinks a rule is wrong
    follows it, logs its dissent, and continues. Dissent that recurs comes up
    in the review.

## Delegation levels

| Level | Name | What the agent does | What the person sees |
|---|---|---|---|
| 5 | **Act** | Decides and acts | Nothing, beyond the ledger |
| 4 | **Act and tell** | Decides and acts | A line in *Decided for you*, with Undo where undo exists |
| 3 | **Act unless vetoed** | Prepares the action, posts a brief with a default, keeps working, and acts once the person has been active for the veto window without vetoing | The brief, with the default option and a countdown that runs only while the person is active |
| 2 | **Recommend** | Posts a brief, waits on that decision only, and keeps working on everything it doesn't block | The brief in *Needs you* |
| 1 | **Person's call** | Posts a brief with options side by side; the recommendation is optional | The brief in *Needs you* |

The levels are bounded by an operational domain. "Act" for restarts on the
person's own machines does not cover a production service other people use.
If a case is close to a class's scope but not inside it, the agent asks, and
proposes widening the scope in the same brief.

## The board

`config/decisions/board.yaml` holds the generic defaults. The profile layer
overrides it (`<profile>/decisions/board.yaml`) for private routing and real
thresholds. Each space can narrow the board for its own conversations, never
widen it, the same inheritance rule spaces already use. This replaces the
unenforced `responsibilities.autonomy` fields.

```yaml
classes:
  continue-in-scope:     { level: 5, note: "the next step inside approved work" }
  verify-own-change:     { level: 5, note: "test it yourself; 'try it and tell me' is an FYI, never an ask" }
  ops-own-machine:       { level: 4, note: "restart, release switch, cleanup on the person's own machines; say how long any outage will be" }
  pr-housekeeping:       { level: 4, note: "ready-for-review, labels, resolve addressed threads, close superseded drafts" }
  merge-when-green:      { level: 4, guard: "CI green on head, no unresolved review threads, GitHub-required approvals satisfied (no protection means zero), and recorded plan/design approval or owner build instruction" }
  reviewer-choice:       { level: 4, guard: "use the person's most recent choice for this repo; if there is none, ask" }
  product-choice-in-scope: { level: 3, guard: "inside an approved feature, with a clear recommendation; if the call is split, level 2" }
  delete-verified-copy:  { level: 3, guard: "a second verified copy exists; batch them into one brief" }
  design-direction:      { level: 2, mode: conversational }
  plan-approval:         { level: 2 }
  ops-shared-prod:       { level: 2 }
  creative-published:    { level: 1, note: "titles, thumbnails, cuts, names; show options side by side" }
  credentials-identity:  { level: 1, note: "sign-ins, 2FA, grants; batch them; first check the vault for the item" }
  act-on-behalf:         { level: 1, note: "messages to other people, actions on shared systems in the person's name" }
  spend:                 { level: 1, threshold: profile }
  delete-no-copy:        { level: 1 }
tripwires: [identity, money, external-in-name, security-privacy, one-way-no-copy, precedent-conflict, surprise]
defaults:
  veto_window: 4h active # level 3: the person's active time, not wall-clock time
  idle_after: 10m        # no activity signal for this long pauses every countdown
  promote_on: second-similar-approval  # D-61: a first approval is a precedent; the second similar one proposes a rule
  demote_after: 2        # reversals in 30 days before a class drops a level
  rule_review: 90d
```

The seed levels come from that review. Classes whose recommendations were
almost always accepted start at level 3 or higher.

## Active time

The level 3 countdown measures the person's **active time on Tango**, not
wall-clock time. Hours asleep, in meetings or away don't count, so a default
never runs without the person having had the window to see it.

- **Activity signals:** any desk interaction (an open, visible desk or screen
  page sending heartbeats, taps, commands, replies), an owner message in any
  conversation (Loom, Discord), and voice-operator requests.
- **Active** means a signal within the last `idle_after` (10 minutes). The
  presence ledger stores active intervals. A countdown is the sum of active
  time since the brief opened, and it pauses while the person is idle.
- **Shown as active time left** ("2h 10m of your active time left"), never as a
  clock time, because the clock time isn't known in advance.
- A brief with a hard deadline (`deadline`) still says what waiting costs. The
  deadline does not shorten the veto window. If the deadline would pass first,
  the brief goes to level 2 and asks.

How it is built (phase 2a):

- **Where the signals come from.** The desk forwards its presence pings (page
  visible, a tap or a key, and every minute while focused), its own commands
  and voice commands to Loom's `POST /presence`, at most once a minute. Loom
  counts the owner's own messages and answers itself.
- **How it is stored.** Loom's `presence` table holds intervals `(start, last)`.
  A beat within `idle_after` of the last one extends that interval; a later
  beat starts a new one. Time after the last beat isn't counted until the next
  beat proves the owner was still there.
- **The clock.** Every 30 seconds Loom's veto clock checks open level 3 briefs that are not in discussion.
  When the owner's active time since a brief opened reaches `veto_window`, the
  brief is `defaulted` (`decided_by: default`), and the thread wakes to carry
  out the default and report it under "Decided for you". Silence never creates
  a rule.
- **What the desk shows.** The brief's payload carries
  `veto {window_ms, active_ms, left_ms}`. Loom notifies clients every 15 minutes
  of active time, so the card's "time left" stays roughly current.

## Two modes of conversation

- **Delegated** is the default for workers, jobs, and threads that implement
  or run autonomously. The person isn't following the conversation, so
  anything they need arrives as a brief. A brief has to be answerable by
  someone who never read the conversation.
- **Conversational** covers design and architecture threads the person is
  actively in. Discussion is the medium, and questions in chat are fine. A
  brief is still needed for a gated decision (level 1 or 2) or when the person
  has been away longer than the veto window.

The mode is a property of the conversation. It is inferred from the type and
the board class (`design-direction` implies conversational), and the person or
agent can change it.

## The decision brief

A brief is a structured object, not a closing line. The UI calls it a
**decision**; this spec calls it a brief.

```ts
type DecisionBrief = {
  id: string;                     // stable; repeating an ask updates this brief
  thread: string; agent: string; space: string;
  class: string;                  // a board class
  level: 1 | 2 | 3;
  about: string;                  // project or feature in at most 8 plain words (required for new briefs)
  ask: string;                    // the decision and the recommendation in one line (BLUF), at most 140 characters
  door: "one-way" | "two-way";
  blast: "private" | "team" | "public";
  standing: string;               // where things stand, at most 3 lines
  background: string;             // what someone reading cold needs, at most 6 lines; links for the rest
  options: Array<{
    key: string; label: string;
    consequence: string;          // what happens, cost, how reversible
    recommended?: boolean;
    action?: string;              // what runs on approve: a command, a branch, a draft
  }>;                             // 2 or 3 options plus "do nothing" when that is real
  assets: Array<{ kind: "pr" | "preview" | "prototype" | "screenshot" | "doc" | "diff"; title: string; url: string }>;
  deadline?: string;              // when delay starts to cost something, and what it costs
  default?: { option: string; at: string };   // level 3 only
  confidence?: "low" | "medium" | "high";
  changeMyMind?: string;          // what would change the recommendation
  precedents: string[];           // rules and rulings checked, and why none applied
  proposedRule?: string;          // "Next time, for <scope>, do <X> without asking"
  blocks: string[];               // what is waiting on it; everything else continues
};
```

Before a brief is accepted, Loom lints it and refuses it with a reason when:

- `about` is missing (older stored briefs still load and render);
- the ask starts with "it", "this" or "that", or uses one instead of naming the thing being decided;
- ask, standing or option labels contain internal version, phase, round or step labels, or a commit hash; name the feature and problem instead;
- the ask is a verification request ("try it", "refresh and tell me");
- there is no recommendation at level 2 or 3;
- it has more than 3 options;
- `standing` or `background` is empty;
- the text links an asset that isn't attached;
- the thread already has an open brief for the same class with the same
  subject (the update goes to that brief instead);
- a matching standing rule already covers the case (the agent is told to act
  and cite the rule).

Use no internal version or phase labels; define any term the owner didn't coin.

A brief that passes the lint can still fail the cold-read test: if the
person's reply is a clarifying question, the brief is logged as not answerable
cold, and the agent revises it.

### How agents raise a brief

- **Loom threads.** The agent calls the `decision_check(class, situation)` tool,
  which returns the level, the matching rules and recent rulings, then
  `decision_request(brief)`. Both tools sit next to `wait_for`. A level 3
  brief registers an `active-time` trigger (the person's active time, see
  [Active time](#active-time)) at its default. When it fires, the thread wakes
  and carries out the default.
- **Other runtimes (Discord agents, Codex).** The same JSON goes in a fenced
  `decision` block. The desk parses it and files it with Loom
  (`decision.request` on a proxy thread), so every brief lands in one ledger.
  This is phase 1b.
- **The answer.** Briefs reach the desk as the thread's pending question
  (`requestId` `decision:<id>`, with the brief attached), so Needs you, the
  chips, voice and optimistic taps work unchanged. A chip sends
  `decision.answer`. Loom records it and starts a turn with the owner's words
  ("Decision D-4: … I chose A: …"). If they answer it in chat, the agent closes
  the brief with `decision_close` (`answered-in-chat`). That works from the raising thread and from any other thread in the brief's chain (its workers, its lead or carrier), or one that named the id in its closing ask, so a lead that relayed a brief can record an answer given in its own thread. Loom records `decided_by: person-chat` and the thread it was said in (`decided_in`), tells the raising thread, and settles it everywhere as usual.
- **In discussion.** Any ordinary owner message on the raising thread or a thread
  carrying the brief puts it in discussion, including a message steered into a
  running turn. Loom does not infer intent. Peer mail, wakes and decision answers
  do not count. The brief stays `open`, with `discussing_since` set, so its decision
  page can still accept an answer. It leaves Needs you, chips and Catch me up;
  the row says “In discussion · D-n”. Each owner reply increments `discussed`,
  counting cold-read misses. Level 3 defaults cannot fire during discussion.
  Loom tells the responsible turn to revise with `decision_update`, close with
  `decision_close`, or return it unchanged with `decision_keep {decisionId, why}`
  if the message was about something else. Keep has the same authority as update.
  Update clears discussion and restarts the full veto window. Keep records the
  reason and persists `kept_at`, but leaves the brief in discussion so the reply
  leads the row. After the responsible turn ends, opening the thread for three
  seconds (the desk's `viewed` marker), marking it seen, or taking a desk action
  returns the brief to
  Needs you and restarts the full veto window then, never at keep time. A new
  owner message starts a fresh discussion obligation; answering or closing the
  brief still resolves it immediately. This also applies on carrier threads;
  viewing the raising thread does not acknowledge an unseen carrier reply.
  If never seen, it returns after 30 minutes of owner active time following the responsible run’s end, restarting the veto window without marking it unaddressed.
  If the specific turn ends in any outcome without addressing the brief, Loom returns
  it to Needs you once, restarts the window, and sets `unaddressed_at`: the card
  says “You replied; the agent didn't address it”. Update, keep or close clears
  that marker. Stopping the raising thread withdraws its briefs as usual.
- **Fallback (D-353).** On Loom, prose never opens or replaces an owner ask.
  Only `loom.handoff` naming the desk's person opens that ask; decision briefs
  and pending questions keep their existing request paths. Closing lines for
  me, waiting or none may still retire an ask, preserving the mail-turn rule.
  The ask lint still classifies tool-recorded owner asks and may wake once
  (re-based on the declared kind under [The hand-off ask](#the-hand-off-ask)).
  Discord agents are not on Loom and keep their existing path.
- A turn without a tool hand-off gets one corrective wake when no queued run,
  armed wait, background task, open request or running worker will bring it
  back. The existing opt-in and stopped checks apply. If that wake also omits
  the tool, the row is Stuck, never an owner ask; there is no second wake.
- `loom asks rerecord --dry-run` lists non-stopped threads with a legacy owner
  ask (no `to`, latest hand-off lacking a tool-recorded `next`). Without
  `--dry-run`, it queues one plain Loom wake per thread, durably deduplicated.
  The wake's tool hand-off can replace or retire the legacy ask, including
  assigning it to an agent. It is not mail: the mail-turn preservation rule
  must not keep the old owner ask. Startup preserves existing legacy asks
  until re-recorded, but never invents new asks from historical prose.

The `Next — you:` line remains the human-readable pointer at the end of a turn
and names the brief. When a turn adds no new brief, a still-open one is not
re-asked: re-record the same hand-off unchanged (it is a no-op); say nothing
new to the owner when nothing changed. Human hand-offs must name the action in
at least four normalized words; a pointer to a brief is exempt. Repetition is
still recorded in `ask_lints`, but queues no corrective wake and preserves the
original ask text, timestamp, message and run. Corrective turns cannot replace
an open owner ask with a different owner ask, except the explicit legacy
re-record wake; they may still retire or retarget it.

### Where the person sees briefs

There is one place: the desk's **Decisions** view. Every conversation's
"Needs you" row leads into it.

- **Needs you.** Open level 1 and level 2 briefs, ordered by deadline, then age.
  A worker's brief goes up through its owner conversation, which can answer it
  under its own authority or pass it up unchanged.
- **Running by default.** Level 3 briefs, each with its default and the active
  time left. Tapping an option overrides the default.
- **Decided for you.** Level 4 actions since the last visit, grouped by class,
  with Undo or "I wouldn't have", which records a reversal.
- **Delegation review.** A weekly digest of rules created that week, rules
  suspended or demoted, rules due for review, and recurring dissent. It is a
  review, not a gate: rules are already live when it lists them.

The brief card follows the order of the type:

1. The ask line.
2. The options side by side, with the recommended one marked.
3. Where things stand.
4. A strip of assets: PR, preview, prototype, screenshots.
5. Background, collapsed.
6. What happens if no one answers.

When a brief is a promotion candidate (see the learning loop), the card says
what approving it does: it is kept as a precedent, or, when it matches an
earlier precedent, "approving this the same way proposes a standing rule for
both". With the options, the card offers three chips:

- **Just this once.** Approves this one and keeps it as a precedent. This is
  preselected on candidates (D-61).
- **Ask me next time.** Approves this one, keeps asking, and doesn't count it
  as a precedent.
- **Always do this.** Creates the rule the brief proposed at once.

There is also an optional one-line reason.

How *Decided for you* is built (phase 2b). There is no separate Decisions view
yet: Needs you and Running by default are the Inbox's own rows (the brief is the
thread's pending question), so *Decided for you* sits there too.

- **Logging.** After acting on a level 4 class, the agent calls the
  `decision_log(class, summary, undo?, ref?)` tool (`decision.log`). Loom refuses
  any class the board doesn't put at level 4: level 5 needs no log, and levels 1
  to 3 need a brief. The row is `status: acted`, `decided_by: agent`, with the
  summary in `ask`, `brief` null, the undo hint and a link. A level 3 brief that
  ran by default (`defaulted`) is decided for the owner too.
- **Reading.** `GET /decisions?since=<ms>` lists acted and defaulted rows across
  threads, with the thread's title. A default's summary names the option that
  ran. A backlog longer than 200 comes oldest batch first (`more: true`), so
  marking what was shown as seen never skips rows that weren't.
- **Where it shows.** A card at the top of the Inbox's first view, where the
  weekly sweep sits (`next/decided.js`). It lists what was decided since the
  owner last looked, grouped by class. Each line has the summary, the thread
  (tap to open), whether the agent decided it or a default ran, its age and its
  link. **Seen all** clears the card up to the newest line. The desk keeps that
  time (setting `decided_seen_at`); with none set, the card starts a week back.
  No status, so no color.
- **Reversing.** Each line has **I wouldn't have**, and **Undo** when the agent
  gave an undo hint. Both take an optional note and go to Loom as
  `decision.reverse {decisionId, undo, note}`, which records `reversed_at`,
  `reversal` (`undo` | `disagree`) and `reversal_note`. Undo also wakes the
  thread with the owner's words ("Undo D-12: <summary>. <note>", plus the undo
  hint). "I wouldn't have" changes nothing now. A line can be reversed once. Undo
  on a stopped thread is refused. Both are optimistic on the desk: a refusal
  takes the line back and offers Retry. Reversals are what phase 3's demotion
  reads; nothing demotes yet.

### Passing a brief up

A conversation can't hand on another thread's brief, only summarize it, so the
desk carries it (TGO-1075, `desk/asks.ts` `carryBriefs`):

- **Linking.** A Loom thread whose open ask or newest agent words name an open
  decision (`D-<n>`) carries that brief (only Loom threads: Loom clears their
  ask when it settles). A lead on any source carries its own workers' open
  briefs without naming them, following the chain past a worker that started
  a worker. The carried brief shows in full on the row and its
  conversation page, labelled "from <thread>".
- **Answering.** An answer on the carrying row is `decision.answer` on the
  original id: Loom wakes the thread that raised it.
- **Counting.** One decision is one Needs you, on the row the owner should
  look at: the raising worker's lead, else a default or lead that carries it,
  else the raising thread. The other rows say "carried by <row>" (the ask's
  `duplicate` state).
- **Settling.** When a decision resolves (answer, close, default, a stop or
  delete of its thread, or a replacement), Loom clears the open ask of any
  other thread that names its id and tells that thread, and any thread whose
  newest words name it, how it went, in a turn of its own. A carrier outside
  Loom is told by the desk. The raising worker's lead is always told
  this way, so it never depends on mail. The owner's other words in a worker
  reach its lead as desk mail at once.
- **Instructions.** To pass a brief up, an agent names its id with its link
  (`<desk address>/decision/D-n`; `tango-screen decision D-n` prints it) and
  stops; it doesn't restate the options.

### The brief page and D-n links

Every decision is one tap from its brief (TGO-1110):

- **The page.** `/tango-screen/decision/D-<n>` (desk route, plus
  `GET /api/desk/decisions/:id` proxying Loom's `GET /decisions/:id`). It
  shows the full brief card: the ask, where it stands, the assets, the answer
  chips, the rule chips, the revision line and its changes, "from <thread>" and
  "carried by <thread>". It answers through the same path as the card on a row
  (the `respond` command on the raising thread), so a brief the row hides
  (a thread with two open briefs shows its newest) still answers from its page.
  It is the desk itself with the brief up: a deep link works standalone on a
  phone, and a tap on a `D-n` opens it as an overlay. A closed brief shows its
  outcome: who decided, the option, their words, when, and the thread the
  owner said it in.
- **Links.** The desk turns a `D-<n>` into a link to the page wherever it
  renders text: messages, mail, the feed, Decided for you, the Delegation
  review, ask lines and row previews (`public/desk/decision-links.js`; the
  markdown renderer calls it). Only ids Loom has a decision for become links
  (`GET /api/desk/decisions` lists them); the rest stay text.

### Revising a brief

New information often lands after a brief is up, in the thread that raised it
or in a worker below it. The brief is revised in place, never re-raised
(TGO-1079):

- **Updating.** `decision.update {decisionId, changes, why}` (the
  `decision_update` tool) lays the changed fields over the brief and lints the
  result as a whole. The id stays the same, `revision` goes up by one, and the
  `changes` log gains an entry: the revision, when, which thread, the fields,
  what changed in words ("recommendation A → B · options") and why. The class
  can't change; a different class is a different decision.
- **Who.** The thread that raised it, its workers at any depth, its lead (any
  thread up its chain) or a thread that carries it. Anyone else is refused
  (`not_yours`).
- **Moot.** `decision_close` with `outcome: "moot"` and the new information in
  `note`, from anyone in that chain, closes it with nothing going ahead. The
  thread that raised it and its carriers hear why. `withdrawn` and
  `answered-in-chat` are open to the same chain (TGO-1110).
- **Stale answers.** The desk sends the revision the owner saw with the answer.
  If the brief has moved on, the desk (or Loom, code `stale`) refuses it as
  "updated since you looked", nothing reaches the thread, and the card shows
  the new revision.
- **Material changes.** A change to the options, the recommendation, the
  default or the level restarts a level 3 veto window (`window_from`). A copy
  edit doesn't. Each material revision is one FYI to the threads that carry
  the brief and to the thread that raised it, never to the thread that made
  the change. Loom tells Loom threads; the desk tells carriers outside Loom.
- **On the card.** "Updated · <when> · <what changed>" sits above the brief's
  facts, with the reason on hover.

## The hand-off ask

Adopted in D-468 (2026-10-22). A hand-off to the desk's person that is not a
brief is an **ask**: something only the owner's hands or words can supply.
Until now it was text with a timestamp (`threads.ask`); the desk had to guess
what it wanted, whether it was still open, and what a card could offer, and a
plain ask on Catch me up ended in Skip. An ask is now a record like a brief:
the agent declares its kind, Loom keeps its state, and every desk action on it
is a recorded transition. The desk-status rule holds throughout: only the
record sets the pill, the count, the card's label and its buttons; the ask's
words only explain.

### Declared on the hand-off

`loom.handoff` with `kind: "human"` takes an `ask` object. Its `kind` is
required:

```ts
type AskSpec = {
  kind: "do" | "answer" | "pointer";
  steps?: string[];               // 2 to 5 steps of one errand, each resolvable on its own
  resolves?: { kind: "pr" | "url" | "file" | "thread"; ref: string }; // a record whose close resolves it
  due?: string;                   // ISO time; past it the ask is expired, not open
  class?: string;                 // a board class, when the ask falls under a tripwire (credentials, identity)
};
```

- **`do`**: an action in the world the agent cannot take itself (buy, install,
  plug in, sign in, pay), with the agent's part done or waiting only on the
  outcome. The card offers **Did it**.
- **`answer`**: a fact or preference only the owner holds, asked in one line
  ("which drive is the backup on?"). The card offers a reply. A choice between
  options is never an `answer`: that is a brief (`decision_request`), and the
  lint says so.
- **`pointer`**: the hand-off names an open brief or request (a D-n, or a
  pending question) the owner answers on its own card. It is recorded with
  `points_to` set, never counts as an open owner ask (owned asks,
  catch-up.md, D-413), and closes when the brief or request it names does.

A human hand-off without a valid `kind` is still recorded, as kind
**`unclear`**: the row reads Needs you with a reply field and no Did it, and
Loom sends one corrective wake ("declare the ask's kind"), under the same
once-only rules as the missing-tool wake. Re-recording the same ask with a
kind is a revision of the same ask, never a different one, so the corrective
turn can fix it. The four-word minimum and the 200-character cap on `text`
stay. `who` still decides the audience: the desk's person opens an owner ask;
an agent address is Waiting on that agent, whatever the kind.

### The ask record

Loom is the only writer. Asks get ids `A-n` from `ask_seq`, beside the
decisions' `D-n`.

```sql
asks(
  id TEXT PRIMARY KEY,            -- A-n
  thread TEXT NOT NULL, agent TEXT, space TEXT,
  kind TEXT NOT NULL,             -- do | answer | pointer | unclear
  text TEXT NOT NULL, norm TEXT NOT NULL,
  who TEXT NOT NULL,              -- the person id or agent address the hand-off named
  audience TEXT NOT NULL,         -- owner | agent
  class TEXT, due TEXT,
  steps TEXT,                     -- JSON [{ text, done_at?, by? }]
  resolves TEXT,                  -- JSON { kind, ref, trigger_id? }
  points_to TEXT,                 -- pointer: the D-n or request id it names
  status TEXT NOT NULL,           -- open | done | answered | resolved | superseded | withdrawn | closed-by-done | expired
  resolved_by TEXT,               -- person | person-chat | agent | record:<id> | desk
  resolved_at INTEGER, resolution_note TEXT,
  message_id TEXT, run_id TEXT, revision INTEGER NOT NULL DEFAULT 1,
  legacy INTEGER NOT NULL DEFAULT 0, -- 1: migrated from threads.ask with no declared kind
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
```

One open ask per thread, as today. `threads.ask` stays as the thread's pointer
to its open ask and gains `id` and `kind`; the desk reads the row by `id`.

**Transitions.** Every status change names its cause:

| To | Cause | `resolved_by` |
| --- | --- | --- |
| `done` | Did it on the card, or the last step done (`ask.resolve`, outcome `done`) | `person`, or `desk` for the voice operator |
| `answered` | the owner's next message in the thread (the existing close) | `person-chat` |
| `resolved` | the `resolves` record closed (the PR merged or closed, the thread finished, the URL or file condition met), or the brief a pointer names was answered or closed | `record:<id>` |
| `superseded` | the thread's next human hand-off asks something else (a new A-n) | `agent` |
| `withdrawn` | the thread's next hand-off is to an agent, a system or nobody, or `ask.resolve` with outcome `withdrawn` | `agent` |
| `closed-by-done` | the owner marked the row done on the desk (today's "closed by done") | `desk` |
| `expired` | `due` passed with the ask still open (Loom's clock) | — |

Done on an ordinary thread (`settle`) records `closed-by-done` and clears its
open ask, as Clear does for a standing thread. Desk Undo sends `settle.undo`
for that Done's timestamp; it reopens the row only if that settlement is still
current. A new owner message does not reopen a closed ask.

Re-recording the same ask unchanged keeps the row and its `created_at`, as
today. A re-record with the same words but a different `kind`, `steps`, `due`
or `resolves` bumps `revision` and logs the change; different words make a new
ask and supersede the open one. Corrective turns keep their limits: they may
revise or retire an ask, never replace it with a different one.

**`ask.resolve`** is a Loom command (`POST /commands`, and `loom asks resolve`),
not an agent tool: `{ askId, revision?, outcome: "done" | "withdrawn", step?, note?, by }`.
With `step`, it marks that step done and the ask stays open until the last
step is done. On `done` and `resolved`, Loom starts a turn on the thread in its
own voice, as a decision answer does: "Ask A-12 done: <text>. Marked by
<person> on the desk at <time>. <note>". On `expired`, the thread wakes once
with the fact so the agent can re-raise or move on. `withdrawn`, `superseded`
and `closed-by-done` wake nothing.

**Stale completions.** Did it and each step tick carry the revision the card
showed, as a brief's answer does. A re-record since (other steps, another kind)
keeps the id, so a bare step number would mark a different step. The desk
refuses a completion for a revision its copy has moved past, and the Loom
source reads the ledger row before sending: a completion of a revision Loom has
moved past, or of an ask already closed, is refused as "updated since you
looked", nothing is marked, and the card is read again so it shows the record
as it is. Once an ask is revised, a completion has to say which revision it
saw. Loom enforces the revision and open status atomically in `ask.resolve`,
returning `stale` or `not_open`; replaying the same command id stays idempotent.

**`resolves`.** When an ask names a record, Loom arms a wait of that kind on
the ask's behalf (the trigger row carries the ask id) and resolves the ask when
it fires. A `pr` resolves on merged or closed; a `thread` when that thread
finishes; `url` and `file` on the trigger's condition. The thread's own waits
are untouched. This is the cross-thread resolution desk-status.md planned as
its phase 3.

### Routing, as for briefs

| Brief rule | Ask counterpart |
| --- | --- |
| Audience from the thread's role: a worker's brief goes to its live lead | Audience from `who`; a worker's owner ask is carried by its lead by reference (D-413) and counts once |
| Needs you counts open briefs whose audience is the owner | Needs you counts open asks (`status: open`, audience owner); `pointer` and `expired` never count |
| Accept takes the recommendation; level 1 and tripwires are Left for you | Accept never resolves an ask (it needs the owner's hands or words); every ask is Left for you |
| Defer: the line later, the brief stays open | The same, per ask |
| Done on the row doesn't close a brief | Done closes the ask as `closed-by-done` |
| Answered in chat: `decision_close` records it | The owner's message closes the ask as `answered` (unchanged, now a recorded status) |
| A tripwire class routes to the owner and never defaults | An ask with a tripwire `class` is marked on the card, never expires, and the lint refuses a `do` of that class written as a decision |
| The card: options, recommendation, chips | The card: a label from `kind` (To do, Answer, Reply), steps as a checklist, Did it (`do`), a reply field (`answer`, `unclear`, partial outcomes), Defer, Open thread |

Pending question chips (a Loom `request`) pass through to the card unchanged;
they were never asks.

### The lint, re-based

The ask lint keeps its once-per-ask corrective wake, but reads the declared
kind first:

- no kind: "declare the ask's kind" (the `unclear` wake above);
- `do` or `answer` whose text is a decision by the lint's rules: the existing
  decision wake;
- any kind whose text asks the owner to verify the agent's work: the existing
  verification wake;
- repeat: unchanged.

The text classifications `pointer`, `todo` and `unclear` are no longer
produced. Each `ask_lints` row records the declared kind beside the text kind,
which is what the "legacy asks that never became a brief" metric reads.

### Other runtimes

The fenced `handoff` block for sources off Loom was dropped per D-4. Those
sources move onto Loom and use `loom.handoff`, keeping one ledger and one set
of states.

### Migration

At upgrade, every open `threads.ask` becomes an `asks` row: kind `unclear`,
`legacy: 1`, `created_at` from the ask's `at`, its message and run ids kept. No
corrective wake is queued for migrated asks; `loom asks rerecord` already
covers them, and its wake now asks for the kind too. The desk shows them as
reply-only until re-recorded.

### Phases (D-468)

1. **Loom:** the `asks` table and `A-n` ids; the `ask` fields on
   `loom.handoff`, validated in `handoff.record`; `ask.resolve` and its wake;
   `resolves` through the trigger row; `threads.ask` carrying `id` and
   `kind`; the ask on `GET /threads/:id`, the snapshot and `GET /asks`; the
   migration; the unclear wake.
2. **Desk:** the ask card on Catch me up and in the conversation, bound to the
   record (label, steps, Did it, reply, Defer, Open thread); Needs you and
   `status.ts` reading `status` instead of comparing timestamps; Accept
   skipping asks; the related updates in desk-status.md, catch-up.md and
   agent-desk.md.
3. **Guards:** lint by declared kind; atomic revision and open-status checks
   on `ask.resolve`; Done closes the ask in Loom and desk Undo reopens it;
   re-recording a migrated ask with a declared kind clears its legacy flag.

## The decision ledger

Loom is the ledger's only writer. Decisions live in Loom's store (the
`decisions` table in `loom.sqlite`, `packages/loom/src/decisions.ts`), and
other runtimes reach it through Loom's commands (`decision.request`,
`decision.answer`, `decision.close`) over its HTTP API. One writer avoids a
second shared database and a workspace dependency in the Loom release. Phase 1
ships the `decisions` table. `rules` and `class_levels` follow in phase 3, in
the same store.

```sql
decisions(
  id TEXT PRIMARY KEY, thread TEXT, agent TEXT, space TEXT,
  class TEXT NOT NULL, level INTEGER NOT NULL,
  decided_by TEXT NOT NULL,      -- person | agent | default | rule:<id>
  status TEXT NOT NULL,          -- open | answered | defaulted | acted | withdrawn | moot | superseded | expired
  brief TEXT,                    -- JSON DecisionBrief (null for level 4/5 actions)
  summary TEXT NOT NULL,         -- one line for level 4/5 actions and digests
  answer_option TEXT, answer_text TEXT, answer_reason TEXT,
  followed_recommendation INTEGER, -- 1 | 0 | null
  discussed INTEGER NOT NULL DEFAULT 0, -- ordinary owner replies: cold-read misses
  discussing_since INTEGER, discussing_run TEXT, -- discussion start and responsible turn
  kept_at INTEGER,              -- keep recorded; await turn end and owner seeing reply
  unaddressed_at INTEGER,        -- turn ended without addressing the discussion
  rule_choice TEXT,              -- always | next-time | once
  undo TEXT, ref TEXT,           -- level 4 logs: how to undo it, and a link to what was done
  reversed_at TEXT, reversal TEXT, reversal_note TEXT, -- reversal: undo | disagree
  revision INTEGER, changes TEXT, window_from TEXT, -- revisions in place: the log (JSON) and when the veto window last started
  created_at TEXT NOT NULL, resolved_at TEXT
);
rules(
  id TEXT PRIMARY KEY, class TEXT NOT NULL,
  scope TEXT NOT NULL,           -- the situation it covers, stated literally
  level INTEGER NOT NULL, guard TEXT,
  reason TEXT,                   -- the person's reason, which is what agents generalize from
  source TEXT,                   -- JSON decision ids that justified it
  state TEXT NOT NULL,           -- active | retired | superseded
  superseded_by TEXT, created_at TEXT NOT NULL, review_at TEXT, last_used_at TEXT
);
class_levels(class TEXT PRIMARY KEY, level INTEGER, changed_at TEXT, why TEXT); -- learned overrides of the board
```

Level 4 and 5 actions are logged too: one row, a summary, and whether undo is
possible. That is what *Decided for you* and the reversal budget read.

As built (phase 3), in `packages/loom/src/rules.ts`. Times are ms, as in
`decisions`:

- `rules` adds `action` (what to do, the rule's "Do"), `origin` (an imported
  rule's "From" line), `state_why`, `changed_at`, and the state `suspended`.
- `class_levels` keeps `board_level` beside the learned `level`.
- `rule_declines (class, scope)` records "Just this once": that scope is no
  longer a promotion candidate for the class.
- `rule_events` records each change (`rule-created`, `rule-suspended`,
  `rule-retired`, `rule-withdrawn`, `class-demoted`, `class-restored`). The
  owner's FYI and the weekly review read it.
- `decisions` gains `rule_id` (the rule a log acted under, or the rule an
  answer made) and `dissent`. A log under a rule is `decided_by: rule:<id>`. An
  answer that overrides a level 3 default is stored as `reversal: override`.

**The rules file is a mirror.** On start, Loom imports any rule in
`<profile>/decisions/rules.md` it doesn't have, keeping its id; that is how
R-1 to R-3 came in. After that the table is the source of truth. Loom rewrites
the file on every change, keeping the file's own preamble. Agents off Loom
still read the file. A rule they append with the next free id is picked up the
next time Loom writes, and so is a rule they mark `suspended` (an active
rule's heading changed; a state line Loom wrote itself, tagged "by Loom", is
never read back over the table). Loom never
turns a rule back to active from the file. The file is never overwritten in place: Loom moves it
aside, imports what it moved, and publishes the new mirror only where no file
has appeared since (an append that recreated it is taken in and the swap
tried again). The moved copy is kept beside it (`rules.md.prev-*`) and read
again on every rewrite and hourly, and deleted only once it has gone a minute
without changing, so an append through a handle opened before the move still
comes in. An append is never lost. Every field is written on one line,
and a rule that took an id Loom used meanwhile comes in under a fresh one. `main.ts` passes the path
(`LOOM_RULES_FILE` overrides it); a host without one keeps rules in the table
only, which is how the tests run.

## The learning loop

- **Capture.** Every resolved brief records the option chosen, whether it
  matched the recommendation, the chip and the reason.
- **Promote on the second similar call (D-61).** A brief is a **promotion
  candidate** when its door is two-way, its blast radius is private or team,
  no tripwire applies, and its class is at level 2 or 3. A candidate brief must
  carry `proposedRule` with a literal scope. The **first time** the person
  approves its recommendation unchanged, the answer is kept as a
  **precedent** (the ledger row, with its `proposedRule` as the pattern), not a
  rule. When a later brief of the same class matches a precedent (similar
  scope, the same kind of option taken) and the person approves it the same
  way, Loom proposes **one** rule written for the pattern, generalized from
  both briefs, and the person confirms it with one tap on the answered brief
  ("Make it a rule"). "Always do this" on any brief still makes a rule at once.
  Non-candidates (level 1 classes, one-way doors, public blast radius,
  tripwires) never promote on their own. Only "Always do this" makes them a
  rule, and only within their own guard.

  As built: `decisions.precedent` marks a precedent and `precedent_of` the one
  a new brief matched (`decision.request` returns it; the card says so).
  Similarity is `similarScope` (one scope contains the other, or they share at
  least half the words that carry them) plus the option labels. The proposal
  (`decisions.proposal`: text, scope, do, the two decision ids, state
  proposed / made / dismissed) is written plainly first (`generalizeRule`) and
  then, when a model is configured (`ruleWriter`, a small model on the default
  account), rewritten for the pattern. `decision.rule always` on that decision
  makes it, with both decisions as its source; "Not now" (once) sets it aside
  and that pair isn't proposed again; "Ask me next time" stops the answer
  counting. `decision_check` returns the class's precedents with their ids, so
  a brief can cite them. `rules.keepAsPrecedents {ruleIds}` turns named rules
  made from a single first approval back into precedents: retired with "D-61:
  kept as a precedent", ids kept, their decisions counting as precedents again.
  It takes an explicit list, run once after deploy, because the ledger can't
  tell a first-approval rule from one the owner made with Always. Confirming a
  proposal sends the text the owner saw; a rewrite since is refused. The
  confirmed rule links back to both decisions, and neither counts as a free
  precedent after that.
  `rule.update` rewrites a rule's words (the owner's policy, such as R-2).
- **Demote just as fast.** Undo, "I wouldn't have", or an answer that
  overrides a level 3 default counts as a reversal. A reversal of an action
  taken under a rule **suspends that rule at once**: the next case asks again,
  and the brief says which rule was suspended and why. At `demote_after`
  reversals within 30 days, the whole class drops one level in
  `class_levels`, and the person gets an FYI. A clean 30 days restores the
  level automatically.
- **Expire.** Each rule comes up for review at `review_at`. Rules unused for
  90 days retire on their own. When two active rules conflict, that is a
  tripwire: the agent asks, and the brief names both rules.
- **Seed.** A one-off backfill turns the inventory of past asks into proposed
  rules for the first review, so the system starts from the person's track
  record rather than from zero.

How it is built (phase 3):

- **Checking.** `decision_check` reads the board with `class_levels` laid
  over it (a demoted class sits lower), and the active rules for the class plus
  the `policy` rules. Two active rules for the same class and the same scope
  text (case and spacing aside) return `tripwire: precedent-conflict` and the
  ids. A brief whose `proposedRule` scope is exactly an active rule's scope is
  refused, naming the rule to act on; with two or more such rules it must carry
  `tripwire: precedent-conflict`, whatever other tripwire applies. A conflict
  brief names every rule in the conflict, each kept by exactly one option
  (`option.rule`). The owner's
  answer settles it: the kept rule stands and the others are `superseded` by it;
  an answer that keeps none suspends them all. A brief for a declined scope is not a
  candidate.
- **Acting under a rule.** `decision_log` takes `rule` (the id), `scope` (the
  case's scope, which must be the rule's scope, case and spacing aside: a near
  miss is refused and asks) and, optionally, `dissent`. A cited active rule of
  the same class makes its scope level 4, so a level 2 or 3 class can be logged
  under it. A rule in a precedent conflict is no authority until the owner
  settles it. The log updates the
  rule's `last_used_at`. A suspended or retired rule is refused.
- **Promotion.** `decision.answer` on a candidate whose recommendation is taken
  as it stands defaults to `rule: always`, and Loom creates the rule from
  `proposedRule` ("Next time, for <scope>, <do> without asking") at level 4,
  with the class's guard, the owner's reason, `source: [decision id]`, and
  `review_at` after `rule_review`. A non-candidate becomes a rule only on an
  explicit Always, and a brief with a tripwire never does. The thread wakes to
  "That is now standing rule R-n". `decision.rule {decisionId, rule, reason?}`
  changes it afterwards: Ask me next time or Just this once withdraw the rule
  (before D-61, once also declined the scope; since D-61 it keeps the answer as
  a precedent, and declines recorded before then are still honoured); Always makes it, and on a decision whose rule
  the owner took back it brings that same rule back (`rule-restored`): one
  decision never yields two rules. A brief the owner answered
  in chat (`decision.close`, `answered-in-chat`) learns the same way: the
  recommended option promotes, unless the agent passes the owner's `rule`
  (`next-time` or `once`), and the owner's `reason` goes with it. A proposed
  rule splits at ", do" when it has one, so a scope may hold commas. Briefs
  on one scope answered in turn never leave two active rules: the same ruling
  reuses its rule (adding the decision to `source`), and a different one
  supersedes it. In a conflict, the rule the owner keeps last stands, restored
  if an earlier answer had set it aside.
- **Demotion.** `decision.reverse` on a log under a rule suspends the rule at
  once, and an Undo's wake says so. Every reversal (Undo, "I wouldn't have", or
  an override of a level 3 default: another option, or the owner's own words
  instead of it) counts against its class. At
  `demote_after` reversals in 30 days, counted since the class's level last
  changed, the class drops one level (not below 1), and its open briefs drop
  with it (a level 3 brief at 2 loses its default). An hourly check lifts a
  class one level after a clean 30 days, and retires non-policy rules unused
  for 90 days.
- **Where the person sees it.** The brief card puts the three chips under the
  options. Always is preselected on a candidate, so the recommended option stays
  one tap. There is also a one-line reason. The choice goes with the answer
  (`respond` args `rule` and `reason`). Once answered, the full decision page shows the
  answered brief's rule ("Saved as R-12 · Undo", or what the answer chose
  instead) under its outcome with the same chips to change it. Compact cards omit
  these controls. Conversations show only still-proposed rules, once per proposal,
  with Make it a rule / Not now; answered decisions do not accumulate there.
  The thread detail carries each
  decision's `rule`. `GET /decisions` returns `rules`, the changes the system
  made in the same span (suspensions, retirements, demotions), which *Decided
  for you* lists as FYIs in a Rules group. Rules the owner made, took back or
  settled from their own answers are not there: *Decided for you* is for what
  agents decided. `GET
  /decisions/review` is the weekly review: rules created, suspended or retired,
  classes demoted or restored, rules due for review in the next week, and
  dissent that recurs (the same rule or class more than once). The desk shows
  it as a Delegation review card under *Decided for you*. It reads from where the owner last put it away (the first one covers the
  last week), so nothing falls between two reviews. It appears once a
  week when there is something in it; "Got it" puts it away for a week (desk
  setting `delegation_review_seen_at`). `GET /rules` lists the rules and class
  levels.

What the loop guards against:

- **Scope creep.** Rules match literally, and a near miss asks.
- **Rubber-stamping.** Level 4 classes have a sampled audit instead of
  approvals.
- **Agents dodging escalation.** A one-way door classified as two-way charges
  the reversal budget double, and the review spot-checks door tags.

## Metrics

Shown on the Decisions view, and on the System page for trends:

- Asks per day reaching the person; the goal is a falling trend.
- Recommendation accepted unchanged, per class.
- Answerable-cold rate: the share of briefs not answered with a question.
- Time to answer, and the cost of waiting on deadlines that slipped.
- Reversal rate for level 3 and 4 decisions, per class.
- Repeated asks: the target is zero.
- Legacy `Next — you` lines that never became a brief.

## Phases

0. **Policy, with no code.**
   - Commit the board.
   - Add a "Decisions and delegation" section to the operating guide that
     replaces the one-sentence escalation rule.
   - Teach the brief format to agents' global instructions and to the
     agent-screen skill.
   - Stop re-asking ("say it once, then hold").

   This alone removes most asks.
1. **The brief and the ledger.**
   - **1a, Loom threads:**
     - the `decisions` table in Loom's store;
     - the Loom tools `decision_check`, `decision_request` and
       `decision_close`, with the lint;
     - the release ships the board beside `dist`;
     - the desk brief card, answered from Needs you, with the regex kept as a
       legacy fallback.
   - **1b, dropped (D-4).** Instead of building briefs for every runtime, the
     remaining sources move onto Loom. Until they do, non-Loom threads use the
     markdown brief from the agents' instructions.
2. **Defaults.**
   - **2a:**
     - the presence ledger (activity signals from the desk, owner messages
       and voice);
     - the level 3 veto clock in Loom;
     - "time left" on the card.
   - **2b, as built:**
    - `decision.log` and the `decision_log` tool, for level 4 classes only;
    - `decision.reverse` (Undo, which wakes the thread, or "I wouldn't
      have"), stored as `reversed_at`, `reversal` and `reversal_note`;
    - `GET /decisions?since`;
    - the desk's *Decided for you* card on the Inbox (see [Where the person
      sees briefs](#where-the-person-sees-briefs)).
3. **Learning, as built** (see [The learning loop](#the-learning-loop)):
   - the answer chips on the brief card, and on a new rule's line;
   - `rules` and `class_levels` in Loom's store, with the profile's rules file
     imported once and then kept as a mirror;
   - promotion on first approval, suspension on reversal, demotion at
     `demote_after` reversals and restoration after a clean 30 days;
   - expiry after 90 days unused, and the precedent-conflict check;
   - the weekly Delegation review card.

   Not yet: the backfill seed from the inventory, the double charge for a
   one-way door tagged two-way, and the sampled audit of level 4 classes.
4. **Measurement.** The metrics above, and a status-oracle-style fixture of
   judged briefs to test the lint and the cold-read check against.

## Rulings

The person decided these on 2026-10-18. They are the first entries in the
ledger.

- **D-1, the veto window:** 4 hours of the person's **active** time. The
  countdown pauses whenever they are idle. See [Active time](#active-time).
- **D-2, promotion:** promote early. The type of decision is judged a
  candidate when the brief is written, and the first unchanged approval makes
  it a rule. This replaces the earlier draft (3 approvals in 30 days, then a
  one-tap review). Demotion is just as fast: one reversal suspends the rule.
- **D-3, the board:** the starting board is adopted as written.
- **D-61, promotion revised (2026-10-19, supersedes D-2's promote-on-first-
  approval):** a rule only on the second similar call. The first unchanged
  approval is a precedent; the second similar one proposes a rule the person
  confirms. "Always do this" still makes a rule at once, but it is no longer
  preselected; "Just this once" is.
- **D-4, what comes after phase 1a:** phase 2 next. 1b is dropped in favor of
  moving the remaining sources onto Loom ("rather than building this for all
  the other sources and over-complicating things").
- **D-468, typed hand-off asks (2026-10-22):** a hand-off ask is a record with
  a declared kind (`do`, `answer`, `pointer`) and a recorded state, routed like
  a brief; Did it and Defer on the desk are transitions on that record, never
  text. Chosen just this once (a precedent, not a rule). See
  [The hand-off ask](#the-hand-off-ask).

## Open questions

- **Thresholds for spend and outages.** These are private values that belong in
  the profile layer.

## Sources

- Bezos, 2015 and 2016 shareholder letters (Type 1 and Type 2 decisions,
  decisions at 70% information, disagree and commit).
- Grove, *High Output Management* (task-relevant maturity); Hersey and
  Blanchard (situational leadership).
- Appelo, Management 3.0 (the seven levels of delegation and delegation poker).
- Oncken and Wass, "Management Time: Who's Got the Monkey?", HBR, 1974.
- US Army ADP 6-0 (mission command, commander's intent); "Completed Staff
  Work" memo, about 1942.
- Bain, RAPID ("Who has the D?"); Netflix culture memo (context, not control).
- Dalio, *Principles*; Nygard, "Documenting Architecture Decisions", 2011.
- ITIL change types (standard changes pre-approved by precedent); Google SRE
  Workbook, error budget policy.
- Minto, the pyramid principle (SCQA); BLUF.
- Anthropic, "Measuring AI agent autonomy in practice" (2026) and the Claude
  Code auto mode write-up (approval fatigue); Feng, McDonald and Zhang,
  "Levels of Autonomy for AI Agents" (Knight Institute, 2025).

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

An explicit policy retirement uses `rule.retire` with the rule id and a reason.
It preserves the rule, records a retirement event and rewrites the rules mirror;
it does not recast an approved policy change as a reversal or a precedent.
