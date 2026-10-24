# Agent Desk

> Historical specification. T3 integration and its APIs were retired in October 2026.
> Use [the current desk specification](agent-desk-next.md), [Loom](../architecture/loom.md),
> and [the retirement notes](../architecture/t3-retirement.md) for supported behavior.
> T3 requests, sources, tokens, and commands below are retained as design history only.

Replaces the inbox half of
Agent Screens; the scene half (staging, sandboxed frames,
the bridge) stays and is extended.

The desk is the owner's single surface for everything their agents are doing: one
list of conversations with Discord agents and T3 threads, the conversation he
is talking about by voice, and whatever an agent wants to show him. It runs on
the existing screen service (`apps/screen`, :9410, tailnet `/tango-screen`).
The voice operator, the `agent_inbox` tool and the browsers are all clients of
one API.

Design prototypes (approved): linked from the Linear project "Agent Desk"
(`r2-model.html`, `r2-cards.html`, `r2-screens.html`). Read them before building UI.

## Product model

### Items

One item per conversation:

| Source | Item | Id | Conversation key |
| --- | --- | --- | --- |
| Discord thread under an agent's home channel | one per thread | `discord:thread:<threadId>` | `thread:<threadId>` |
| Discord agent home channel | one per **chapter**: a burst of messages, split at 30-minute gaps | `discord:chapter:<channelId>:<firstMessageId>` | `channel:<channelId>` |
| T3 thread (opted-in projects) | one per thread | `t3:<threadId>` | `t3:<threadId>` |
| Loom thread | one per thread | `loom:<threadId>` | `loom:<threadId>` |
| Scheduled job | one per job | `schedule:<jobId>` | `schedule:<jobId>` |

Only the owner's agents appear (the profile's owner agents). Sources are Discord,
T3, Loom and scheduled jobs.

### Axis 1: next step (from the conversation, never set by the owner)

| Value | Meaning | Basis |
| --- | --- | --- |
| `your_move` | Something waits on the owner: a decision (including one raised earlier that is still open), work the owner asked for or is shaping delivered for them to review (research, page, PR, plan, design), or an action the agent handed them. A your-move card always names the move. | T3 pending question/approval (exact); the T3 PR approved ("PR #N approved — merge?") or changes requested (GitHub, exact); or summarizer inference |
| `failed` | The agent's turn errored, crashed or timed out. | Source facts only, never inferred |
| `working` | The agent is actively on it. | T3 session/turn running; bot `turn.started` without `turn.finished`; owner spoke last and a turn is in flight |
| `watching` | Nobody is active but an update is expected, including **waiting on a team member** (a non-owner human: a PR reviewer, someone's feedback). | Running background job for the conversation; PR review pending on GitHub (a T3 thread's PR or a watched PR; waiting on the reviewer); T3 snooze; summarizer inference ("I'll check back at 6", "sent to the designer for review") |
| `fyi` | Nothing is expected of the owner: finished and closed, already acknowledged, or the agent says no action is needed. A status report, briefing or recap that asks nothing is FYI: an update is not a deliverable. The summarizer picks `your_move` only when it is genuinely unclear whether the owner must act. Stays FYI after it is seen, and is never the owner's move: unread, the row is bold, not yellow (owner, 10/18). | Summarizer inference |

**Precedence (deterministic, highest first):** `failed` (latest turn failed and
no owner message since) → T3 pending question/approval (T3 keeps the session
and turn running while it waits on the owner, so this must beat `working`) →
`working` → T3 PR
approved / changes requested (`your_move`) → running background job
(`watching`) → T3 PR review pending (`watching`, waiting on the reviewer) →
T3 snooze (`watching`) → summarizer (`your_move` / `watching` / `fyi`).
Source facts always beat inference. A summary that lands late can never
overwrite a source fact (it only writes the `summary` and `inferredStep`
fields; the step is recomputed).

**Overdue (owner, 10/18):** a wait past its time stays `watching`, with
`watching.overdue = { kind, since, text }` set; it is never an ask of the owner.
`check-back`: the agent's own promised update is late (`nextCheckAt + 15 min`
passed with no activity, a job past its deadline, or an undated "update coming"
a day without words); the desk wakes the agent with what it promised, once per
episode (`facts.overdueWoke`), so the owner never has to. `person`: a named
person past `desk_settings.waiting_nudge_hours` (default 48); `agent`: another
agent past a week. Those are theirs to nudge: the row says "overdue 2 days" in
the pill's colour and offers Nudge, which sends the agent the owner's request to
chase them. Entering and leaving overdue is traced (`wait.overdue`,
`wait.overdue.cleared`, `wait.woke`) and counted (`briefing.counts.overdue`), so
it can be followed over time.

**Waiting on a team member** is a flavor of `watching`, not a step of its own.
The item's `watching` JSON is `{ reason, basis, nextCheckAt, waitingOn }` with
`basis` one of `job | t3-snooze | summary | person` and
`waitingOn: { who, what, since } | null`. Sources: the summarizer's `waitingOn`,
and PR review state read with
`gh pr view <url> --json reviewRequests,reviews,reviewDecision,state,isDraft`
every 5 min (skipped silently when `gh auth status` fails at startup) for a T3
thread's `branchPullRequest` and its other linked PRs (`linkedPullRequests`, from
T3's `pullRequests`; not on threads typed `ops` or `project`, which link the PRs
they oversee), and for every **watched PR** on any item (T3 or Discord). A PR is pending while a reviewer is requested, or while
`reviewDecision` is `REVIEW_REQUIRED` and it isn't a draft (a reviewer who
commented drops off `reviewRequests`, but the PR still waits). Several PRs read
as one `prReview`: changes requested, then pending, then approved. An approval or a
changes request rules the card only until the agent speaks after it (`decidedAt`,
the deciding review's submit time): then the agent's newer words, through the
summary, say where it stands.

**Watched PRs** (`facts.prWatches`) are registered with the `watch` command,
`POST /api/desk/pr-watch { conversationKey | itemId, url, onApprove, off }`,
`tango-screen watch-pr`, the `screen` tool's `watch_pr`, or the card menu. The
desk is the watcher, so a review that takes weeks outlives any agent session.
With `onApprove: continue` (the default), an approval posts one
`[Desk] PR #N was approved…` message into the conversation (actor `system`), so
the agent picks it back up and merges if the project allows; `notify` only turns
the card to "approved — merge?". A merged or closed watched PR drops off.
Registering a watch moves a Discovery or Building item to the Feedback stage (the
old `watch:` label); a stage the owner set past that is left alone, and nothing
moves it back. A wait on another agent (`waitingOn.kind: 'agent'`, e.g. a "Desk" thread or Codex)
is not overdue at 48 h; after a week it is. A wait on a person is overdue after
`desk_settings.waiting_nudge_hours` (default 48) with no activity. Overdue never
changes the step or asks the owner anything (see Overdue above).

### The row's markers (status contract)

The step above is one input. What a row shows is five markers, worked out once on the server
(`desk/status.ts`) and sent as `status: { move, busy, unread, live, audience }`; every surface (List,
Inbox, Next up, briefing, voice, mail, the rules file) reads them rather than deriving its own. One
answer to "does this wait on the owner" (`needsOwner`: audience owner, and `live` needs or failed) feeds
the yellow count, Next up, the briefing and voice alike. The browser applies only two things it knows
first: read or unread the moment the owner opens a row, and the clock on a message nobody picked up:

| Marker | Question it answers | Values |
| --- | --- | --- |
| `move` | Whose move is it? The pill. **Yellow (`needs`) means the conversation is blocked on the owner, nothing else.** | `needs` (the owner's, unread, or an open request read or not) · `ready` (the owner's, read) · `watching` (someone else's: a reviewer, another agent, a promised update) · `failed` · null (the agent's own, or nothing asked) |
| `busy` | Is the agent doing anything? The dot. | `working` (a turn runs now) · `background` (only background work or a job left) · null |
| `unread` | Has the owner taken in the latest words? Bold on the row. | true (`seen` is `new` or `updated`) · false |
| `live` | The one state a row is grouped, filtered and counted by. | the `move` when there is one · `todo` (the owner's to-do or an expired ask) · `working` (busy) · `sent` / `failed` (a message of the owner's nobody picked up, Failed past 3 min) · `fyi` (a finished update) · null |
| `audience` | Who the move reaches. | `owner` · `lead` (a worker's, which speaks for it) · `none` (a job's) |

Decisions behind it: whose move and busy are independent (owner, 10/17: a thread can ask the owner
while it works on); a finished update the owner hasn't read is `unread`, not their move (owner, 10/18:
that morning 9 of the 40 Needs-you rows were finished reports, "shipped and live", "nothing waiting").
A job (`ops`) or a worker reports to the conversation it works for, so its `move` is null unless it
failed or its owner is gone (spaces.md). Waits the dot already shows (a monitor, a job, T3's snooze)
are not `watching`.

A current summary of the newest agent words asking the owner beats background work or a monitor;
the busy dot stays on. A running turn still reads Working. If Loom records no open ask but the
latest agent words after the owner's reply close with “Next — you:”, the desk uses that handoff
and traces the missing recorded ask. Every such ask still passes through the ask lifecycle.

An idle lead with live worker decisions newer than its own last message shows Needs you (unread)
or Ready (read), and “N asks from workers” on its row. Busy leads keep their own move; speaking
after the worker ask clears this backstop. To-dos, expired or repeated asks and jobs do not count.

The contract is pinned by the status oracle (`test/status-oracle.test.ts`): live rows judged by hand,
replayed through the derivation on every change. Cases the current rules can't satisfy yet are marked
pending and skipped, never deleted; the pending work is named on each (timer asks becoming an
overdue badge on Watching; an ask lifecycle with identity, expiry and cross-row dedup).

### Asks (the ask lifecycle)

For Loom items, `ask_record` supplies the declared kind, due time and status.
The desk derives `askRecord` from that record (`source: recorded`, `kindBy:
source`): `do` maps to `todo`, and `answer` or `unclear` maps to `decision`.
The record's `due` supplies `dueAt`; its status supplies the state. Words,
summary hints and dates in the text do not classify a recorded ask.

Every open owner ask counts in Needs you, including `do`; `pointer` and
`expired` never count. The recorded kind labels the ask card (To do, Answer,
Reply), not the pill. The List's To-dos view still reads `askRecord.kind`.

Sources without a Loom ask record retain their existing source-based
derivation from the step's winner: an owner request is a decision, with no
derived due date. Older chapters and duplicate asks retain their existing
superseded and duplicate states. These fallbacks do not override a Loom record.

### Axis 2: where it sits for the owner

| Disposition | Seen | Meaning |
| --- | --- | --- |
| `active` | `new` | Something arrived that the owner hasn't engaged with. Bold, top of its section. |
| `active` | `seen` | In his court; stays in the rotation. |
| `active` | `updated` | Seen, then a later FYI/progress arrived. Lighter marker than New. |
| `snoozed` | — | Out of the rotation until a time or a trigger. |
| `parked` | — | Indefinite snooze; picked up by hand or in the weekly sweep. |
| `done` | — | Finished or not doing. |

**Active = active disposition** (New + Seen + Updated). That is the owner's rotation.

### Attention rules (all automatic transitions are events, shown in the activity log with undo)

- **Seen is inferred** from engagement anywhere: the owner posts in the
  conversation (Discord, T3, screen reply, voice); any owner reaction; the item's
  detail or Conversation view is open ≥ 3 s; the voice operator finished speaking
  it **with playback completed and not interrupted**; it was briefed in a catch-up.
  Scrolling past does not count.
- **Explicit reactions** (Discord, synced both ways where the source supports it):
  👀 = seen (replaces 👍; 👍 is still accepted as seen), ✅ = done, 💤 = park.
- **New agent activity:**
  - on a `done` item: reopens as `active/new` if substantive (not an
    acknowledgment like "thanks!", "you're welcome", "👍"). Deterministic
    ack check first, summarizer flag second.
  - on `active/seen`: becomes `new` if the step is `your_move` or `failed`,
    otherwise `updated`.
  - on `snoozed` with trigger `agent_posts`: returns `active/new`, tagged back
    from snooze. Time snoozes stay snoozed.
- **Snooze expiry** (time or trigger) returns the item as `active/new` with
  `backFromSnooze: true`. Triggers in v1: a time, `desk` (the desk screen
  becomes active after being idle ≥ 10 min), `agent_posts`. Local snooze is
  stored separately from a source's own snooze (T3 `snoozedUntil`); both are
  checked on a timer that runs whether or not a source changed.
- **Snooze in the UI:** a plain tap on Snooze (or `s`) snoozes with
  `agent_posts`. This clears a feed-style thread, like a daily briefing,
  without settling it at the source the way Done does. The toast that follows
  offers Undo and quick re-times (this evening, tomorrow, next week). The
  arrow beside the button (or `S`) opens the full picker, which also takes a
  custom date and time. Morning presets (tomorrow, Monday) land at 6 am.
- **Chapter supersession:** the latest home-channel chapter never settles after
  an idle gap. A new chapter quietly files the previous one, without a ✅ or
  changing its unread state. The latest chapter is a standing conversation.
- **Weekly sweep:** a setting (`saturday` default, or `monday`), 07:00 local.
  Candidates: parked items plus active items untouched for 7 days. Shown as a
  card at the top of the board and offered in the catch-up. Keep → active;
  drop → done with a note to the agent ("parked, not pursuing"); standing
  conversations are never dropped by a sweep.
- **Done write-back:** Discord thread → ✅ on the last agent message + archive;
  latest chapter → Clear with ✅ only; Loom thread → settle. A Loom default
  instead takes Clear, with no settlement (see [standing conversations](spaces.md#a-standing-conversation-is-cleared-never-done)). The outcome (`ok` / `failed` / `n/a`)
  is recorded; a failed write-back shows on the item with a retry. Done on an
  item whose conversation has a running background job requires an explicit
  `stopJob: true|false` choice.
- **No rotation target.** Decision briefs can send push notifications to the owner’s
  phone through the [iPhone app](ios-app.md). The operator speaks only when
  the owner is online in voice.

### Rules file (kept, slimmed)

`config/screen/inbox-rules.yaml` keeps `label` and `hide`; `quiet_until` becomes
an automatic snooze until that weekday; `priority` is dropped (sections replace
the smart sort). `kind: report` marks a recurring report the owner skims (a
delivery briefing, a digest): the summarizer is told so, and a report is
`your_move` only with an explicit ask, otherwise `fyi` (enforced after the
model, not only asked of it). `kind` matches on agent and place only. Editing a
rule that changes an item's kind summarizes the item again. Ordering inside a section: New/Updated first, then most recent
activity.

### Filters (Mutes)

Mutes are global owner settings stored as `desk_settings.filters = { hideAgents,
hideRepos, hideTypes }`, shared by every screen. Agent values match personas
(including clones), repos match coding workspaces ignoring case, and types match
the owner's type tag.

Mutes exclude rows from Inbox tabs and their counts, Next up, needs-owner counts,
briefings, voice catch-up and the sweep. Active API lists retain muted rows with
`filteredBy` annotations so project and agent pages, index counts and Search
still include them. Space rows show a quiet “Muted” fact. Rules-file `hide`
remains separate and continues to remove items from Active.

The Inbox shows removable “Muted:” chips under its tabs. Settings › Mutes lists
Agents, Repos and Types with counts, including saved values with no remaining
rows. Changes appear immediately; failed saves roll back and offer Retry.

## Screen model: three views

All connected screens share one view (no per-device views in v1).

| View | Shows | Enters when |
| --- | --- | --- |
| `active` | The board: the active list as columns, grouped (default by next step) | Default home; ⎋ / "back to the board" / tap Active / 2 min idle after the call ends |
| `conversation` | One item, built automatically: ask + context, timeline from the owner's request to now, artifacts (prototype previews switchable), live activity, captions | The owner asks to open it ("open the Sierra thread", "read me…"), catch-up walks to it, or a card is tapped. Sending a message never opens it: the board stays up for the next thing. |
| `screen` | An agent-staged scene, full bleed, slim bar | A result's scene arrives from the agent the owner just sent to (or the current conversation's agent) |

- Only the agent in the current conversation can take the screen. Scenes from
  other agents join a **queue** ("Up next: Sierra has a screen") and show when
  the current conversation ends or the owner calls on them.
- A new item for another agent never pulls the screen out of what it shows; it
  shows as a count in the top bar.
- A manual selection (a tap on a screen, a voice "show X") is persisted in the
  hub and beats automatic focus until the conversation changes.
- Screen is disabled in the switcher when no scene is staged for the
  conversation.

## Architecture

```
 Discord REST ─┐                         ┌─▶ browsers (SSE /api/desk/stream)
 T3 HTTP API ──┼─▶ sources ─facts─┐      │
 bot agent    ─┘   (adapters)      ▼      │
 events ─────────────────────▶ desk core ─┼─▶ voice operator (HTTP + SSE)
 background-jobs/*/job.json ─▶  events   │
 summarizer ──inferred fields──▶ reducers ┴─▶ agent_inbox tool
                                  │
                              presentation hub (views, scenes, queue)
```

Three authorities, each with one owner:

1. **Source facts** — adapters own thread identity, messages, running/failed
   state, pending questions (with options), source snooze, PRs, background
   jobs. They write `items` (a cache of the source) and emit `source.*` events.
2. **Owner attention** — the desk core owns disposition/seen through an
   append-only `desk_events` log and a pure reducer. It records write-back
   outcomes separately from the local decision.
3. **Presentation** — the hub owns the current view, conversation, scene and
   the scene queue, plus manual selection.

LLMs interpret and summarize; deterministic code validates targets, applies
state changes and decides success.

### Storage (SQLite, same `screen.db`)

- `desk_items` — one row per item: identity (`id, source, kind,
  conversation_key, agent_id, agent_name, place, area, channel_id, thread_id`),
  source facts JSON (`facts`), summary JSON (`summary`), `artifacts` JSON,
  `activity` JSON, `watching` JSON, `next_step`, `next_step_basis`,
  `last_activity_at`, `last_agent_message_id`, `last_owner_message_at`,
  `message_count`, `labels`, `hidden`, `revision` (monotonic, bumps on any change).
- `desk_attention` — projection of the reducer: `item_id, disposition, seen,
  snooze_until, snooze_trigger, back_from_snooze, done_at, writeback JSON,
  updated_at`. Rebuildable by replaying `desk_events`.
- `desk_events` — append-only: `seq, at, item_id, type, actor
  (owner|agent|system|voice|screen|source), payload JSON, command_id NULL
  UNIQUE, undoes_seq NULL`.
- `desk_commands` — `command_id PK, type, item_id, args, status
  (accepted|applied|failed), outcome JSON, created_at, updated_at`. Makes every
  command idempotent: replaying a `command_id` returns the stored outcome.
- `desk_messages` — `message_id PK, item_id, author (agent|owner|other), at, text`.
- `desk_markers` — source cursors and revisions (Discord last message id per
  channel; T3 revision = hash of turn state + latest message ids + updatedAt).
- `desk_settings` — key/value (`sweep_day`, `filters`, etc.).

Old `inbox_*` tables stay untouched until cutover. A one-time migration maps
existing owner decisions onto the new items: `later` → `parked` (except T3
items that were `later` only because of a T3 snooze — those keep the source
snooze and are not parked), `read`/`dismissed` with done notes → `done`,
`acked`, `heard` and plain `read` → `seen`. The migration is marked complete
only after the first successful Discord and T3 poll.

### Summarizer contract

One call per changed item (debounced 8 s, ≤ 2 concurrent). Staleness is
judged by an **input key** (the content of the messages the summary was
built from), not by the item revision: writing a summary bumps the revision
but never schedules another summary, and a summary whose input key no longer
matches is dropped and rescheduled, Ollama `deepseek-v4.1-flash` with a deterministic fallback.
Input: last ~6 messages, place, agent, and the owner's local time with its
timezone (`SCREEN_TZ`, default `America/Los_Angeles`) so "I'll check back at 6"
resolves correctly. Output JSON:

```ts
{
  title: string;           // the card's big line and the Conversation heading: at most 6 words, the owner's move as a verb or the outcome
  about: string | null;    // what the conversation is for, at most 6 plain words; the card shows it in place of a raw thread name
  gist: string;            // one short sentence (under 110 characters), where things stand now
  headline: string | null; // at most 8 words, a news headline for the Screen window's feed; never an ask
  whatsNew: string | null; // v14: what the latest messages did that the owner hasn't heard, judged against the last
                           // feed post's words (given with the earlier state as "Owner last heard"); null when they
                           // only say where things stand again (a reply to another agent's mail, a wake that found
                           // nothing): the card updates, the feed does not post. A lead is also given what its
                           // workers (and theirs) posted since it last posted ("Already posted by its workers"):
                           // retelling that is not news; its own decisions, asks and unposted results are
  // Written for a glance: plain words, no ticket/PR/version numbers or code names; coding threads described by outcome.
  step: 'your_move' | 'watching' | 'fyi';
  ask: string | null;
  askKind: 'decision' | 'todo' | 'soft' | null;   // v13: what kind of ask (see Asks)
  askDueAt: string | null;                        // v13: a deadline the ask names, ISO 8601      // the concrete question, if the last agent message asks one
  options: string[];       // ONLY options the agent spelled out ("A or B?", a numbered list); else []
  context: string[];       // what the owner needs to know to answer (≤ 4 bullets)
  ownerAsk: string | null; // what the owner asked for (shown as "You asked:" while working)
  watchUntil: string | null; // ISO time when the agent said it would check back
  ackOnly: boolean;        // the last agent message is only an acknowledgment
  waitingOn: { who: string; what: string } | null;
                           // ONLY when the latest agent message says the work waits on a named
                           // person ("sent to the designer for review", "waiting on the reviewer's answer");
                           // the inferred step is then 'watching'
}
```

Never invents options. Artifacts are extracted deterministically (GitHub PR
URLs, preview domains, tailnet artifact links, T3 `branchPullRequest`); several
links of one kind group into a dropdown pill.

### Agent turn events (new bot plumbing)

The bot reports turn lifecycle to the desk so Working, Failed and the activity
ticker are exact for Tango agents:

`POST /api/desk/agent-events` (local only; `X-Tango-Collaboration-Token` when set)

```ts
{ type: 'turn.started' | 'turn.activity' | 'turn.finished' | 'turn.failed',
  agentId: string, conversationKey: string, channelId: string, threadId?: string,
  turnId: string, at: number,
  activity?: string,        // 'Editing media-session.ts', 'Running npm test'
  error?: { reason: 'timeout' | 'overloaded' | 'usage-limit' | 'auth' | 'error', message: string } }
```

`conversationKey` is the canonical `thread:<id>` / `channel:<id>` for both text
and voice turns. Activity comes from a per-line stream-json hook in the Claude
Code adapter (tool_use blocks → one short line) and from the Ollama tool loop.
At most one `turn.activity` per 2 s per turn.

**Orphaned turns.** A `turn.started` with no terminal event (bot crash, desk
unreachable) holds a lease: if no `turn.activity` arrives for 20 min and the
bot's `/status/work` shows nothing in flight for that conversation (or is
unreachable), the desk closes the turn as finished-unknown and the step is
recomputed. A new `turn.started` for the conversation replaces any open lease.

Background jobs are read directly from `<profileDataDir>/background-jobs/*/job.json`
(status `running`, matched by `threadId ?? channelId`).

### Commands

`POST /api/desk/commands` with a client-generated `commandId` (UUID). Response:
`{ commandId, status: 'accepted' | 'applied' | 'failed', error?, outcome? }`.
Replays return the stored result.

| Type | Args | Notes |
| --- | --- | --- |
| `seen` | | explicit 👀 |
| `viewed` | `ms` | detail/conversation open; ≥ 3000 → seen |
| `heard` | `playbackComplete: true` | operator; rejected without playback completion |
| `done` | `stopJob?` | write-back outcome in `outcome.writeback` |
| `reopen` | | |
| `snooze` | `until?` (ISO) or `trigger?` (`desk` \| `agent_posts`); `onlyIfActive?`, `onlyIfSnoozed?`, `snoozeSeq?` | A one-tap snooze sends `onlyIfActive` (fails with `{ active: false }` unless the item is active). A re-time: `onlyIfSnoozed` fails with `{ snoozed: false }` unless the item is still snoozed; `snoozeSeq` also fails with `{ snoozed: true, replaced: true }` unless that snooze is still the one in effect |
| `park` / `pickup` | | |
| `reply` | `text`, `attachments?` | Discord via bot `/screen/input` (needs channelId); T3 `thread.turn.start`. `applied` only after the source accepted it. `attachments`: up to 8 images `{ name, mimeType, dataUrl }` (PNG/JPEG/GIF/WebP, 10 MB each; about 9.5 MB together for Discord); with images, `text` may be empty. T3 gets them inline over its WebSocket RPC; the bot posts them as Discord files on its 🖥️ message. |
| `answer` | `option` | Posts the option text as a reply. On a T3 item blocked on a single question it answers that question (`respond`); on an approval whose label matches, it approves. A tap sends it at once (no hold; see Optimistic by default). |
| `respond` | `answers: { [questionId]: string \| string[] }`, `requestId?` | T3 items with a pending question: `thread.user-input.respond` with the stored request id. One answer per question (a label or free text; labels for a multi-select). `requestId` is the request the client saw: a different one (or one T3 no longer has open) fails with "the question changed" and nothing is sent. |
| `approve` | `decision`, `requestId?` | T3 items with a pending approval: `thread.approval.respond`; `decision` must be one the request offers (`accept`, `acceptForSession`, `acceptAlways`, `decline`, `cancel`). |
| `dismiss` | `requestId?` | T3 items with a pending question T3 marks dismissible (`responseMode: "message"`): `thread.user-input.dismiss`; any other request is refused. The UI shows Dismiss only then; voice never offers it. |
| `retry` | | failed items: re-sends the last owner request |
| `undo` | `seq` | attention events only |
| `sweep` | `decision: keep \| drop` | The card shows these as **Pick up** (`keep`: back to Active and seen; a holding project keeps holding it) and **Done** (`drop`). A plain `done` or `pickup` on a sweep candidate answers the sweep too. |

The UI shows pending → sent → failed for every command and preserves reply
drafts on failure.

#### Optimistic by default (TGO-1030)

Every tap or click on the desk shows its effect at once and sends the command behind it. The owner never
waits on a countdown or a spinner to move on. This is the default for every action, including new ones:

- **Commands** go through the store's `command()`, which asks `public/desk/optimistic.js` `predict(type, item, args)`
  for the item as it will be. The prediction is an overlay over the lists and the open Conversation: a Done
  leaves Active for History, a label or stage shows, an answered question goes away. It stays until a read
  started after the command answered has landed (the server's copy then agrees), and at most 20 s after the
  answer. A request that never answers comes down at its 60 s deadline.
- **A failure** drops the overlay, so the item snaps back, and a sticky toast (`failToast`) says why and offers
  **Retry** (the same command and args, guards included) and **Open**. There is no Retry when the item
  changed since the tap (`outcome.changed`: look first) or delivery is unknown (the words may already be out).
  Anything the owner typed or picked comes back: a reply's words return to the draft, and a start's form
  returns through **Edit**.
- **A lost answer** (no response, a proxy error, or no answer within 60 s) is ambiguous: the desk may have
  acted. The prediction comes down. Retry sends the **same command id**, so the desk replays its stored result
  instead of acting twice. A reply is never re-sent this way: its words are back in the draft, with a "check
  the thread first" note. A project action has no replay, so it gets no blind Retry.
- **Rollbacks go to confirmed state.** When actions overlap, a failure goes back to what the server last
  confirmed, with any action still on its way applied over it. It never goes back to an earlier action's
  unconfirmed prediction, and it never overwrites a newer change streamed from another screen.
- **Tap order holds.** One thread's commands, one project's actions, one draft's actions, and the project-list
  saves each reach the desk in the order tapped: each waits for the request before it to end, up to 5 min.
- **Guards stay real.** Every command's answer carries the item's attention time (`outcome.attentionAt`). A
  guarded follow-up on an item whose prediction is still showing (Pick up right after Snooze) sends that time as
  its `ifStateAt`, filled in as it goes, so the desk still refuses it if the agent posted in between.
- **Predictions mirror the server**, including the read rules (#678/#684) and project holds (`withProjectHold`):
  a move, reopen, pin or sweep Pick up lands under an away project's hold. The server stays the truth, and the
  next read replaces any prediction.
- **Navigation** happens at the tap: Send, Done and Snooze go back to the board before the server answers.
  The Start work sheet and the project editor close at the tap.
- **Settings and projects** are saved the same way: set locally, sent, and put back if the save is refused.
- **A new command** adds a `predict` case (and joins `PREDICTED`). It returns `undefined` only when the effect
  can't be known before the server answers (Undo), and the screen then waits for the server.
- **Only voice holds.** The voice operator keeps its undo window before a spoken send, because speech can be
  misheard and the owner may not be looking. A tap is deliberate, so it never gets a countdown.

Fixtures take `?fail=reply,approve,start,…` to fail those once each and show the toasts.

### Read API

- `GET /api/desk/items?view=active|snoozed|everything|history&group=step|seen|agent|area`
  → `{ view, group, items: DeskItem[], sections: [{ key, label, itemIds }], counts, sweep }`
  - `counts`: `{ active, filtered, new, updated, yourMove, snoozed, parked, done }` plus one
    count per step (`your_move`, `failed`, `working`, `watching`, `fyi`) over the
    active items. `yourMove` = `your_move` + `failed`. Active counts leave out
    filtered items; `filtered` = active items the owner's filters keep off the board.
  - Outside `view=active`, an item the filters match carries
    `filteredBy: [{ facet: 'agent' | 'repo' | 'type', value }]`.
  - `sweep`: `{ day: 'saturday' | 'monday', at, items: DeskItem[] }` while the
    weekly sweep has undecided candidates, else `null`.
  - `items` come in section order (New/Updated first, then most recent activity).
- `GET /api/desk/items/:id` → `{ item: DeskItem, messages, timeline, scenes }`
  - `messages`: the last 30, oldest first: `{ messageId, itemId, author: agent|owner|other, at, text }`.
  - `timeline`: "How we got here", from the owner's request to now:
    `[{ at, kind: 'owner' | 'agent' | 'ok' | 'fail' | 'now', text, seq? }]`.
    `owner` = the owner's words, `agent` = the agent's, `ok` = an attention
    event (done, snoozed, settled…), `fail` = a failed turn or write-back,
    `now` = where it stands (last, only for your move / working / watching).
  - `scenes`: the live scenes of the item's conversation, newest first: the
    public scene (`id, agentId, agentName, kind, title, summary, version,
    updatedAt, conversationKey, threadId, channelId, …`) plus `itemId`.
- `GET /api/desk/activity?limit=` → `{ events: [{ seq, at, itemId, type, actor,
  payload, commandId, undoesSeq, agentName, title, undoable, undone }] }`, newest first.
- `GET /api/desk/briefing` → catch-up payload: `your_move`/`failed` one by one, FYIs batched one sentence per agent (filtered items left out); a your-move entry carries `pending` (the T3 request with every question and its options) when there is one
- `GET /api/desk/settings` → `{ sweepDay: 'saturday' | 'monday', filters: { hideAgents, hideRepos, hideTypes } }`.
  `POST /api/desk/settings { sweepDay?, filters? }` validates (each filter an
  array of non-empty strings, at most 100; agents folded to their persona,
  types lowercased without the colon), replaces the filters whole, returns the
  settings, and sends every screen a `settings` event.
- `GET /api/desk/facets` → `{ agents: [{ id, name, count }], repos: [{ name, count }],
  types: [{ name, count }] }` over every item (the Everything view); hidden
  values stay listed (count 0 when nothing carries them) so they can be turned back on.
- `GET /api/desk/presentation` → `{ view, itemId, conversationKey, sceneId, queue,
  queueScenes, upNext, by, since, manual, reason, screenAvailable }`. `queue` is
  scene ids; `queueScenes` is the same queue as `{ sceneId, agentId, agentName,
  title, color, conversationKey }`; `upNext` = `queueScenes[0]` or `null`.
- `GET /api/desk/stream` (SSE) → `hello` (`{ at, operator, draft, pause, presentation }`),
  `item` (`{ id, revision }`), `activity` (an event), `presentation` (the
  presentation above, on every change), `settings` (the settings above, when
  the filters or the sweep day change), `operator` (see below), `draft` (the
  Draft card, below), `pause` (the pause pill, below), and, only on the operator's own stream (`?client=operator` from a direct local caller, with `X-Tango-Collaboration-Token` whenever `TANGO_COLLABORATION_BRIDGE_TOKEN` is set; anyone else gets a plain stream),
  `draftCommand` (`{ commandId, action: 'send' | 'cancel', at }`) and `pauseCommand` (`{ commandId, action: 'resume', pauseId, at }`).
- Presentation intents: `POST /api/desk/presentation { view, itemId?, conversationKey?, sceneId?, by: 'screen'|'director'|'agent', reason?, manual? }`.
  When a director ends the conversation (`view: 'active'` with reason `idle`
  or `end`) and the queue is not empty, `queue[0]` takes the Screen view and
  its conversation becomes current (people at a table take turns); with no
  director connected the board shows and offers `upNext`. A director show
  (`POST /api/show`, `by: 'director'`) is a manual selection only with a
  reason that says the owner asked (e.g. `user`); the operator's own focus
  sends `reason: 'focus'`.
- `POST /api/desk/presence {}` → `{ ok, fired }`: a screen saw the owner
  (page visible + interaction, at most once a minute). After ≥ 10 min without
  one, it fires "until I'm at my desk" snoozes.
- `GET /api/desk/operator`, `POST /api/desk/operator` (local callers only) →
  `{ live, status: idle|listening|thinking|speaking, agentName, transcript:
  { speaker: owner|agent|operator, name, text, final } | null, at }`. The voice
  operator publishes its status and captions here; screens get them as
  `operator` events.
- **Draft card** (the operator's draft mode, see the
  [voice operator guide](../guides/voice-operator.md#draft-mode-think-out-loud-send-once)):
  `GET /api/desk/draft`, `POST /api/desk/draft` (local callers only, like
  `/api/desk/operator`) →
  `{ id, active, target: { agentId, name, where, label } | null, fragments: string[],
  compiled: string | null, question: string | null, note: string | null,
  status: listening|compiling|confirm|sending|sent|cancelled, updatedAt }` (`sending`: confirmed and on its way, no longer cancellable; a send the operator could not deliver goes back to `confirm` with a `note`). `where` is the
  destination's place ("Shed vents", "main channel", "new thread …") and `label` the
  card line ("Sierra · Shed vents thread"). Screens get it as `draft` events and show it
  at the top of the board and the phone's Active list, and as a slim banner over the
  Conversation and Screen views. Sent / cancelled show briefly; a card with a `note`
  (an unsent draft left by an ended session) stays until dismissed. `id` names the draft; a post with `clears: <id>` (the operator's delayed clear) is ignored once another draft has replaced that one, so an ended session never wipes a newer session's draft.
  `POST /api/desk/draft/command { action: send | cancel | dismiss, draftId }` (browsers too; `draftId` is the id of the draft shown, required for send and cancel, and a tap for a draft that has since been replaced is refused with 409):
  send and cancel are relayed to the operator as `draftCommand` with that `draftId`, which the operator also checks against its current draft (202 `{ accepted,
  commandId }`); the operator owns the draft and sends through its normal dispatch path,
  so a tap and a spoken "yes" are the same code path. 409 when the draft isn't open, isn't
  ready to send (not `confirm`, no compiled text, or a question pending), is already `sending`, or no operator
  stream is listening. dismiss clears a card that is no longer open (409 while it is).
- **Pause pill** (the operator's pause mode, see the
  [voice operator guide](../guides/voice-operator.md#pause-mode-talking-to-someone-in-the-room)):
  `GET /api/desk/pause`, `POST /api/desk/pause` (local callers only, with the collaboration
  token when one is set) → `{ id, active, since, waiting, still, updatedAt }`. `waiting` is the
  number of voice updates the operator is holding; `still` is set after 30 minutes paused.
  Screens get it as `pause` events (and in `hello`) and show "Paused · N waiting" ("Still
  paused · N waiting") in place of the operator pill in the top bar, and in the phone header.
  `POST /api/desk/pause/command { action: 'resume', pauseId }` (browsers too; `pauseId` is the
  pause shown) is relayed as `pauseCommand` (`{ commandId, action, pauseId, at }`) only to the
  operator's own authenticated stream, the same rule as `draftCommand`; the operator checks the
  id and resumes exactly as for "Tango, I'm back". 202 `{ accepted, commandId }`; 400 for
  another action or no `pauseId`; 409 when not paused, for a pause that is no longer current,
  or with no operator stream listening.

`DeskItem` is the item row joined with attention, in camelCase:

```ts
interface DeskItem {
  id: string; source: 'discord' | 't3'; kind: 'thread' | 'chapter';
  conversationKey: string; agentId: string; agentName: string;
  place: string | null; area: string | null; channelId: string | null; threadId: string | null;
  nextStep: 'your_move' | 'failed' | 'working' | 'watching' | 'fyi'; nextStepBasis: string;
  status: { move: 'needs' | 'ready' | 'watching' | 'failed' | null; busy: 'working' | 'background' | null; unread: boolean;
            live: 'needs' | 'failed' | 'ready' | 'todo' | 'working' | 'watching' | 'fyi' | 'sent' | null; audience: 'owner' | 'lead' | 'none' }; // the row's markers (above)
  askRecord: { source: 'pending' | 'recorded' | 'next-line' | 'pr-review' | 'summary'; text: string; kind: 'decision' | 'todo' | 'soft'; kindBy: 'source' | 'summary' | 'words'; at: number; dueAt: number | null; key: string; state: 'open' | 'expired' | 'superseded' | 'duplicate'; of: string | null } | null; // the ask lifecycle (above)
  ask: string | null;          // the card's ask: T3 question, PR review, summary ask, "Watching went quiet…"
  options: string[];           // answer chips: only options the source or the agent spelled out
  facts: {
    running?: { since: number; turnId?: string; lastAt?: number } | null;
    failed?: { at: number; reason: string; message: string; turnId?: string } | null;
    lastGoodStep?: string | null;   // on failure: the activity line before the error
    pending?: { kind: 'question' | 'approval'; requestId: string | null;   // T3's request, as sent; null: answer in T3
                questions: Array<{ id: string; header: string; question: string; options: Array<{ label: string; description: string }>;
                                   multiSelect: boolean; allowCustomAnswer?: boolean }>;
                approval?: { options: Array<{ decision: string; label: string; warning?: string }>; detail?: string; requestKind?: string };
                dismissible?: boolean;
                question: string; options: string[];   // compact: the first question (+N more) and its labels, or the approval
                at: number } | null;
    job?: { id: string; agentId: string; label: string; startedAt: number; deadlineAt: number | null } | null; // only while running
    pullRequest?: { url: string; number: number } | null;
    prReview?: { state: 'pending' | 'approved' | 'changes_requested'; reviewers: string[]; number: number; since: number } | null; // all PRs, as one
    prReviews?: Array<PrReview & { url: string }> | null;   // per PR
    prWatches?: Array<{ url: string; number: number; onApprove: 'continue' | 'notify'; at: number; by: Actor; wokeFor?: number | null }> | null;
    sourceSnoozedUntil?: number | null; settledAtSource?: boolean;
    t3Url?: string | null;          // SCREEN_T3_THREAD_URL with {id}
    lastOwnerRequest?: { text: string; at: number } | null; lastAuthor?: 'agent' | 'owner' | 'other' | null;
    contentKey?: string;            // the summarizer's input key (the words only)
  };
  summary: { title: string; gist: string; step: 'your_move' | 'watching' | 'fyi'; ask: string | null; options: string[];
             context: string[]; ownerAsk: string | null; watchUntil: string | null; ackOnly: boolean;
             waitingOn: { who: string; what: string } | null; source: 'model' | 'text'; contentKey: string; at: number } | null;
  activity: { text: string; at: number } | null;           // the live activity line
  watching: { reason: string; basis: 'job' | 't3-snooze' | 'summary' | 'person';
              nextCheckAt: number | null; waitingOn: { who: string; what: string; since: number } | null } | null;
  artifacts: Array<{ kind: 'pr' | 'preview' | 'prototype' | 'ci' | 'doc' | 'link' | 'file' | 'scene'; label: string; url: string }>;
  disposition: 'active' | 'snoozed' | 'parked' | 'done'; seen: 'new' | 'seen' | 'updated';
  snoozeUntil: number | null; snoozeTrigger: 'desk' | 'agent_posts' | null; snoozedAtSource: boolean;
  backFromSnooze: boolean; doneAt: number | null;
  writeback: { action: 'done' | 'seen' | 'park'; outcome: 'ok' | 'failed' | 'n/a'; error?: string; steps?: string[]; at: number } | null;
  createdAt: number; lastActivityAt: number; attentionUpdatedAt: number;
  lastAgentMessageId: string | null; lastOwnerMessageAt: number | null; messageCount: number;
  labels: string[]; hidden: boolean; revision: number;
  color: string; line: string;  // presentation helpers: agent color, the card's one-liner
}
```

Artifacts are a flat list; the UI groups several of one kind into a dropdown
pill. `facts.approach` (a one-line plan for a working item) is reserved and not
produced yet.

Command results: attention commands return `outcome.seq` (for undo); `done`
returns `outcome.writeback`; a reply the bot didn't confirm in time fails with
`error: 'unknown — may have been delivered'` and `outcome.delivery: 'unknown'`,
and the UI says "may have sent" instead of offering a resend. The desk passes
the command id to the bot's `/screen/input` (`commandId`) and to T3.

The old `/api/inbox*` routes become a compatibility shim over the desk until
the operator and `agent_inbox` tool are migrated, then are deleted. Done there
never defaults `stopJob`: with a job running and no choice it answers 409
`{ stopJobRequired: true }`.

### Search (TGO-958, TGO-1068)

Search covers the titles and full text of every conversation the desk has followed, T3 threads
and agent chats alike. It ranks them by keyword and by meaning (`server/desk/search.ts`).

- **Index.** The index keeps its own tables in `screen.db`: `search_docs`, `search_messages`,
  `search_chunks` and two FTS5 tables. Triggers on `desk_items` and `desk_messages` keep it
  current. Deletes don't propagate, so a conversation the desk prunes after 30 days stays
  searchable.
- **T3 history.** The desk files only the last 20 messages of a thread. A backfill reads each
  followed thread whole from T3 (`GET /threads/:id`), including archived and old ones, and reads
  it again only when its `updatedAt` changes. It runs 20 s after start and then every 5 min.
- **Ranking.** Several lists are fused by reciprocal rank fusion:
  - **Keyword.** FTS5 with the papa stemmer, scored by bm25. Titles count 1.6×. Every word must
    appear; a word still being typed matches as a prefix; `"phrases"` stay together; `-word`
    drops any conversation that says it anywhere. When requiring every word finds fewer than 5
    conversations and no title matches, a stopword-free any-word list joins in at 0.6×.
  - **Semantic.** Voyage `voyage-4-lite` at 512 dimensions, on each message (pieces of a long one)
    and each conversation's title. A conversation scores by its best three pieces. Matches below
    a cosine of 0.43 (`SCREEN_SEARCH_FLOOR`) or more than 0.12 below the best eligible piece
    are dropped. Vectors live in memory as int8. A missing `VOYAGE_API_KEY`, or
    `SCREEN_SEARCH_SEMANTIC=off`, means keyword only. A failed query embedding falls back to
    keyword for that query.
- **Read API.**
  - `GET /api/desk/search?q=&limit=&where=&scope=&audience=&include=` accepts the shared query contract.
    `include=open` (the desk's search box and ⌘K send it) adds query.js's `openOnly()`: disposition
    active, snoozed or parked, so done and archived conversations are left out. It then runs the
    search again without that (the query's embedding is cached by then) and answers
    `wider: { total, more }`, which is how many more matches including them would add. A `where` that
    already sets `disposition` is left as it is, and `wider` is omitted. Absent or `include=all`
    searches everything, as before; voice asks this way.
    `where` is JSON mapping facets to `{ in?: string[], not?: string[], unset?: boolean }`:
    disposition, live, busy, unread, kind, stage, type, project, workspace, agent, pinned and
    space. `project` means a desk folder; `workspace` means the coding repo. `scope` is
    `global` or `space:project:<id>` / `space:agent:<id>`; `audience` is `owner` or `all`.
    Membership uses `public/desk/query.js`'s shared `matches()` evaluator against one
    in-memory live-item snapshot, before ranking and the final result limit. Keyword and
    semantic candidate pools overfetch up to 10,000; no per-candidate database lookups.
  - The response is `{ query, semantic, hits, total, more, tokens, wider? }`. `total` counts matches after
    facets and before the result limit. If a candidate pool reaches its cap, `more: true`
    marks the count as a lower bound. The UI shows “N results” or “N+ results” accordingly.
    Query text and facet values must never be recorded in request logs or traces.
  - Each hit carries its List row: the live item, or a done row with `archived: true`
    built from its retained snapshot. Archived snapshots can answer kind, stage, type,
    project, workspace, agent, pinned and space, plus dates from last activity. They cannot
    answer current disposition, live state, busy state or unread state: setting one of those
    facets excludes archived hits. With none set, archived hits remain eligible.
  - Recognized fields are parsed on the server and removed from the words searched:
    `is:needs|ready|todo|working|watching|failed|unread|pinned`,
    `kind:thread|default|job|worker`, `in:"<project or agent name>"` (a space),
    `agent:<name>`, `type:<type>`, `stage:<stage>`, `repo:<name>`, and
    `before:<Nd|YYYY-MM-DD>` / `after:<Nd|YYYY-MM-DD>` (last activity).
    Values may be quoted. Unknown `field:value` expressions remain ordinary search words.
  - `GET /api/desk/search/transcript/:id?around=|before=|after=&limit=` pages through the indexed
    messages.
- **UI.**
  - ⌘K (or `/` off the List) opens a palette.
  - The Search page sends saved-tab/view facets and picker choices to the server. Project
    selects a desk folder; Repo selects a workspace; Agent narrows by agent. Sorting affects
    presentation. Recognized grammar tokens appear as chips under the search box.
  - Search opened from a project or agent page defaults to “In this space”, with the space
    shown in the breadcrumb. Turning it off searches globally.
  - Voice search continues its existing global search: the current extractor supplies
    search words without a place. Intent extraction is unchanged.
  - A result's name opens the item. A matched message, or any result the desk let go, opens a
    read-only transcript at that message.

### Scenes (changes)

- Scene identity becomes `(conversation_key, agent_id, slot)`. Scenes staged
  without a conversation key use `agent:<id>`.
  Migration: add and backfill `scenes.conversation_key` (from origin
  `conversationKey`, else `thread:`/`channel:` from origin ids, else
  `agent:<id>`), create the unique partial index on
  `(conversation_key, agent_id, slot) WHERE status = 'live'`, then drop the old
  `(agent_id, slot)` index, in one transaction.
- The `screen` tool's proxy gets turn provenance (add `screen` to the
  allowlist in `discord-memory-provenance.ts`), so scenes always carry
  `channelId`, `threadId`, `conversationKey`.
- A tap routes to the scene's own conversation (never "the agent's latest task").
  Input gets a `commandId`, a durable pending row and a recipient acknowledgment.
- Image/video scenes import files only from allowed roots (profile data dir,
  the agent artifacts directory, the OS temp dir, `SCREEN_ASSET_ROOTS`) and
  only media extensions.

### Voice operator (client of the desk)

- Delete the operator's own attention ledger (`attention.json`), the Discord
  channel inbox poller and `touched-threads.json` discovery. It reads the desk
  and acts through commands with command ids.
- `heard` is sent only after the spoken segment finished without interruption.
- A voice session starts clear (TGO-1050): it speaks only what the owner asked or
  directed in this session (one answer per owner message, mail and intake requests
  excluded), their own requests' failures, and the urgent lane (empty by default;
  `deadline` and `scene` are opt-in). Everything else waits for the owner to ask.
  Catch-up goes your-move one by one, then one sentence per agent for FYIs.
- Routing: resolve the target deterministically when unambiguous (the item in
  the Conversation view, a named agent, the last discussed item); otherwise the
  extractor. GPT-Live says a neutral "on it" and the destination is confirmed
  after routing. Delegations are serialized; a second within a few seconds of
  the first waits and merges.
- One session owner disposes timers, handlers and outstanding work on every
  exit; a session generation stops callbacks from an old session acting.
- Every send carries an immutable request identity; a result only updates its
  own request.
- A failed thread lookup is a retryable failure, never a fallback to the main channel.
- Voice commands for the new model: done, park, snooze (time / "until I'm at my
  desk" / "until they post"), seen, answer an option, retry, show the board,
  show the screen, open a conversation.
- T3 questions and approvals: the operator reads a pending request question by
  question ("<thread> is asking: <question> — options: A, B, C"; the
  recommended label called out) in item reads, the catch-up and the relay
  after an answer. Spoken answers are matched to each question's labels
  (exact, ordinal, "the recommended one", a unique whole-word match), free
  text where T3 takes it, ambiguity asked about; answers given so far are kept
  until every question has one, then sent as one `respond`. Approvals go out
  as `approve` with an offered decision. "The first one" / "option two" / "the
  recommended one" answer a lone single-select question in focus without the
  model.

### Security

- Requests that arrive through `tailscale serve` carry `Tailscale-User-Login`;
  the service allows only logins in `SCREEN_ALLOWED_LOGINS` (every route,
  `/api/desk/*` included). Direct local callers (bot, operator) need no header.
  Browser POSTs must have a same-origin `Origin`.
- Desk POSTs must be `Content-Type: application/json` (a form post or a
  `text/plain` beacon never reaches a command).
- Only a direct local caller (no Tailscale or forwarding headers, no `Origin`,
  no `Sec-Fetch-Site`) may set a command's `actor`; a browser is always
  `screen`. `POST /api/desk/agent-events`, `POST /api/desk/operator` and `POST /api/desk/draft` accept
  only direct local callers, with `X-Tango-Collaboration-Token` whenever
  `TANGO_COLLABORATION_BRIDGE_TOKEN` is set.

## Acceptance scenarios (each a regression test; the starred ones also live)

1. Two tasks for one agent in two threads: replies, scenes and taps stay in their own conversation.
2. Reply before the first turn finishes: the earlier result never completes the newer request.
3. Voice disconnect during a tap: the old session takes no action after reconnect.
4. Agent stages a scene while another agent's conversation is on screen: it queues.
5. Stale poll after Done: the item stays done.
6. Source (T3) snooze expiry and local snooze expiry each return the item as New.
7. Speech interrupted halfway: the item is not marked heard and is re-queued.
8. ★ A Discord thread question appears as Your move with an ask, context and (if spelled out) answer chips; tapping a chip posts the option at once.
9. ★ A T3 thread that errors shows Failed with Retry; Retry restarts it.
10. ★ A home-channel chapter stays active after 30 quiet minutes; the next chapter quietly supersedes it.
11. ★ A background job in a thread shows Watching; Done asks whether to stop the job.
12. ★ Talking to an agent opens its Conversation view; its staged scene takes the Screen view; ⎋ returns to the board.
13. A reply that fails at the source shows failed and keeps the draft.
14. Done whose Discord archive fails is done locally and shows the write-back failure with retry.

## Screen windows and feed scope

A window's role is kept in its address (`role=screen` for a Screen window).
Settings › Windows lists this window and the other connected, named windows.
Each has a Feed scope picker: Everything (the default), a saved Inbox tab, or a
project/agent space. The choice stays with that window in `feedScope` in its
address, so reloads, bookmarks and reconnects preserve it; changing another
window's scope updates that window immediately.

The idle feed includes only posts whose conversation matches the selected tab's
shared query, or belongs to the selected space (including descendant projects).
The Needs-you badge uses the same query. Everything preserves the unscoped feed
and count. A deleted tab stays empty until another scope is chosen. Scope changes
read existing news again; they do not rewrite posts or change the shared
presentation and held scenes/prototypes.

Above the posts, the feed shows account usage: one double ring per Claude and
Codex account, the week left outside in the account's color and the 5-hour
window inside, with the weekly reset under each. It reads the Capacity snapshot
(`GET /api/desk/capacity`) every two minutes, turns a ring pink at a quarter
left and red at a tenth, dims an older reading, and shows nothing when no
account has a reading. Settings › Feed › Account usage hides it on every screen
(feed setting `usage`, on by default).
