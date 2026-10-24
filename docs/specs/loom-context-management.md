# Loom context management

Status: design approved 2026-10-19, with full unified memory (D-40 option B). Active plan
and status live in Linear (project "Loom context management").

Loom threads never reset their Claude session, so every model call re-sends
the whole conversation so far. This spec covers when a thread compacts or
starts fresh, what crosses the reset, how the Desk shows context size, and the
per-thread budget Loom enforces.

## Why

Measured from Loom's Claude transcripts (`~/.tango/loom/claude-projects`),
with sessions mapped to threads through `attempts.native_session_id`. Two
independent scripts agree on the totals (`scripts/loom-burn.mjs` from the
burn-rate work, plus a per-thread replay for this spec).

- **Volume.** Loom sent about 70M input tokens a day on Oct 10-14 and 0.8-2.1B
  a day from Oct 16: 5.5B in four days over about 22k model calls. Discord
  agent usage stayed flat, so the rise is all Loom.
- **Context per call.** Calls averaged ~160k tokens of context on Oct 13 and
  190-300k from Oct 16. The busiest threads ran at a median of 350-550k and
  peaked at 965k.
- **One session per thread, for life.** Every reopen resumes the same native
  session: after cooling, a move, a crash or a profile change
  (`claude-runtime.ts`, `resume: session.nativeSessionId`). Nothing ever clears
  `native_session_id`. Claude Code's own auto-compaction only fires near its
  1M window: 5 compactions in four days, each at about 967k.
- **Cache reads dominate.** 98% of input tokens are cache reads. At list-price
  ratios (read 0.1x, 1h cache write 2x, output 5x) that is still about two
  thirds of the cost. Cache writes are a quarter of it, and 63% of those are
  whole-context rewrites when a session resumes after its cache has gone cold.
- **What starts the calls** (burn-rate breakdown): owner turns 42%, incoming
  mail 22%, Codex-review wakes 13%, other trigger and background wakes 11%,
  replies 5%. Wakes and mail are cheap prompts that land on huge contexts. A
  Codex-review wake averaged 413k of context per call.
- **Where it hurts.** One subscription account's weekly quota went from
  about 90% left to 9% in three days. Below Loom's 10% start floor, threads
  allowed only that account silently waited for the weekly reset, and other
  agents sharing the account were at risk too.

Replaying the four days' calls under the policy below gives about **60% fewer
input tokens and about half the weighted cost**, roughly 0.5B a day instead of
1.3B. That is not back to 70M a day: call count rose too, which is the
burn-rate work's side (review caps, wake and mail batching). Both are needed.

| Replayed policy (Oct 16-19) | Input tokens | Weighted cost | Resets |
|---|---|---|---|
| Today | 5.2B | 100% | 5 |
| Compaction window 250k only | -54% | -44% | 90 |
| Compaction window 200k only | -58% | -46% | 152 |
| **Fresh session at 150k on a run boundary, after 1h idle past 80k, compaction at 250k** | **-60%** | **-50%** | ~230 |

The replay assumes a reset lands at 55-70k (the ~42k base prompt and tools,
plus the carry-forward). The base prompt itself is 42k, so trimming it is a
separate lever this spec leaves alone.

## Principles

- **The session is working memory; Loom is the record.** Anything a thread
  must not forget across a reset already lives in Loom's SQLite or in git, or
  gets written there. The transcript is a cache, not the source of truth.
- **Reset at seams, not mid-thought.** Prefer the end of a run, a finished
  task, or a cold cache. Compaction is the safety net mid-run.
- **The agent writes its own handoff.** Loom supplies the facts (waits,
  briefs, mail, worktree). The agent supplies the judgment: what it was doing,
  what it decided, what it would do next.
- **Visible and reversible.** Every reset shows on the thread's timeline with
  its reason. The old transcript stays on disk and its path goes in the
  carry-forward. The owner can opt a thread out of automatic resets (below).

## Memory, not just trimming

What fills a thread's context is mostly not conversation. In the 15
costliest threads, tool calls and their output are about 89% of the
transcript: shell output alone is 45%, and scripts written inline as shell
arguments another 34%. Owner messages and assistant prose together are about
11%. A reset mostly throws away stale command output. What has to survive is
small, and Tango already has places to keep it.

**What Loom threads use today.**

- **Claude Code auto memory.** Each repo has a `MEMORY.md` index that every
  session loads, under Loom's project store. Every Loom thread in a repo
  shares it. It holds durable lessons and preferences, and about 30 files were
  written since Oct 16. That makes it the right home for "next time, do X" and
  the wrong home for one thread's state.
- **Atlas and Obsidian, by hand.** Sessions load the user's MCP servers, so
  the Atlas `memory` and `obsidian` tools are there. They are called ad hoc
  (about 40 Atlas calls in two days' sample) and nothing writes or reads them
  automatically.
- **Nothing else.** No extraction after a turn, no reseed, no project state
  file. The transcript is each thread's only memory, which is why it is
  never let go.

**What Tango's agents already have** ([unified-memory-system.md](unified-memory-system.md)):
fact extraction after each turn into Atlas, a project state head (status, open
items) with an Obsidian body, a save before rotation, and a reseed from state
head + scoped memories + recent messages. Discord agents use these. Loom
threads don't.

**What the harness gives us** (Claude Code, which Loom drives through the
Agent SDK):

| Feature | Use here |
|---|---|
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | the hard ceiling |
| `PreCompact` hook | Loom passes compaction instructions: keep owner asks, decisions, open items; drop command output. The bundled SDK appends a callback's `systemMessage` to the instructions, automatic compaction included (checked live) |
| `SessionStart` hook (`startup`, `resume`, `compact`) | Loom injects the state block after every compaction and every fresh session, so a compaction loses no Loom state either |
| Auto memory (`MEMORY.md`) | the agent's durable lessons, unchanged |
| Subagents | keep heavy reading out of the main context (memory spec slice 5) |

The binary also carries idle and sleep compaction flags and a "slim tool
results" flag. None is documented, so this design doesn't depend on them. The
Claude API's context editing (clearing old tool results) and memory tool would
fit well, but Loom runs Claude Code, not the raw API, and does not control
them.

**So the reset is layered, not blunt:**

1. **Thread state** from Loom's SQLite (waits, briefs, mail, worktree). It is
   authoritative and is rebuilt every time.
2. **The thread's handoff** (below). It is also written to Atlas, scoped to
   the thread and its Desk project, so it can be searched later instead of
   carried.
3. **Project state.** A Desk project's lead keeps the rolling summary as the
   project's state head in the memory system's format. Workers read it on a
   fresh start and the lead updates it, so the project arc lives in one place
   instead of in the lead's transcript.
4. **Recall on demand.** The packet ends with how to search: Atlas
   `memory_search` scoped to the project, then the old transcript path. Detail
   is found when it's needed instead of re-sent on every call.

**Full unified memory (owner's ruling, D-40 option B, 2026-10-19).** Loom
threads join the memory system now, not after measurement:

- **Extraction after every run, in the desk.** The Discord agents' post-turn
  extraction (`extractAndStoreMemories`, now in `@tango/atlas-memory/capture`)
  runs on each completed Loom run. The desk server already reads every Loom
  conversation and already calls Ollama Cloud for its summaries, so it runs
  the pass there (`apps/screen/server/desk/loom-memory.ts`). It uses the
  `memory-extraction` model role, so it spends no Claude quota. Memories are
  filed under agent id `loom` with the Loom thread id, kept apart from the
  Discord agents'. Each new handoff is filed as a memory too. A thread's first
  sighting starts from that moment: a deploy never backfills old history.
- **Reseed in the carried state.** Loom reads Atlas read-only through
  `node:sqlite` (`packages/loom/src/memory.ts`), so Loom itself still takes no
  Tango package and no native module. The state block lists the thread's and
  its lead's most important memories, so they arrive with every fresh session
  and after every compaction.
- **The lead's handoff is the project's summary.** A worker's state block
  includes its lead's latest handoff. The lead's handoff folds in the previous
  one, so it stays a bounded rolling summary. This uses Loom's parent links,
  which Loom knows, rather than a Desk project id, which it doesn't.
- **Save before a reset:** the handoff doubles as the memory spec's
  pre-rotation save (section 8). Only a lead's handoff becomes the summary its
  workers start from; a worker's handoff stays scoped to its own thread.

## When a thread compacts or starts fresh

Two mechanisms, with different jobs.

1. **Compaction (inside the session).** Claude Code summarizes in place.
   Loom sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in the session environment so
   this fires at the *hard ceiling* instead of near 1M. A `PreCompact` hook
   tells it what to keep, and a `SessionStart` hook re-injects Loom's state
   block afterward. It is still lossier than a handoff, so it only protects a
   long run that never reaches a seam.
2. **Fresh session (Loom-managed).** At a seam, Loom asks the session for a
   handoff, closes it, clears `native_session_id`, and opens the next run in a
   new session that starts from the carry-forward packet (below).

Loom checks after every run, using the context size of the run's last call:

| Trigger | Condition | Action |
|---|---|---|
| Soft threshold | context > **150k** at the end of a run | fresh session before the next run |
| Cold cache | next run starts > **1h** after the last call and context > **80k** | fresh session (the resume would rewrite the whole cache anyway) |
| Task done | a worker's task ends (see below), or the agent calls `loom.save_handoff` | fresh session |
| Owner | "Fresh start" on the Desk thread page, or `/fresh` in a turn | fresh session |
| Hard ceiling | context > **250k** mid-run | Claude Code compacts in place |
| Budget | thread over its daily budget (see below) | fresh session, and non-owner runs are held |

- **The fresh session opens lazily.** Loom records the reset as pending and
  opens the new session when the next run arrives. A thread that never runs
  again costs nothing.
- **A reset never interrupts a running turn,** and never fires while the
  thread has an open AskUserQuestion or plan request (`requests`) or any
  background work still running in the session (shells, subagents, workflows,
  watchers). Closing the session would cut those off, so a pending reset waits
  until they end, and it is checked again when it's applied.
- **Thresholds are per-role settings** on the session profile, so the bake-off
  can tune them. The defaults above apply to every role. `default` (lead)
  threads may run a higher soft threshold (200k) if their summaries prove too
  thin.
- **Per-thread opt-out.** A thread with `threads.fresh_opt_out` set is never
  reset automatically: every trigger (soft threshold, cold cache, task done,
  budget) checks it, and a pending mark is dropped when it's set. Compaction
  at the hard ceiling still applies. The Desk thread's ⋯ menu has "Keep this
  session" to set it and "Fresh start" for a one-off reset (Loom:
  `POST /threads/:id/keep-session {keep}` and `POST /threads/:id/fresh-start`).
  Fresh start skips the handoff turn: the new session gets the handoff the old
  one saved, if it saved one, and otherwise its last replies and the transcript
  path. It applies even to a kept session and in shadow mode, because the owner
  asked for it. It is refused while a turn is running or the session has background work or an open
  question, which closing it would cut off. It must ship before fresh sessions leave shadow mode.
  Both wait their turn in the thread's mailbox behind a dispatch already under
  way. The Desk gives up after two minutes, and a request it gave up on is
  dropped when its turn comes, so the failure it reports is true. Either one
  cancels a queued handoff turn; if that empties the queue, a hold waiting for
  room clears with it.
- **Repeated resets.** If a fresh session crosses the soft threshold within
  its first run, the work is genuinely large. Loom lets it run to the hard
  ceiling and does not reset again until the next seam.

## What crosses the reset: the carry-forward packet

The new session's first message is the packet, then the run's own text. It
has two parts.

**1. The handoff (written by the agent).** At the soft threshold, while the
old session's cache is still warm, Loom sends it one short turn: "Your session
is being reset. Call `loom.save_handoff` with your handoff." A cold-cache reset
never wakes the old session for this, since that would pay the full cache
rewrite the reset exists to avoid. It uses the latest stored handoff plus the
replies after it. Mail that arrives during the handoff turn is queued for the
fresh session, not steered into it. The tool takes:

- `summary`: what this thread is for and where it stands (at most ~800 words);
- `decisions`: choices made and why, so they aren't re-litigated;
- `next`: the next concrete step;
- `files`: the paths, PRs and docs that matter.

Loom stores it in a `handoffs` table (thread, session, created_at, body,
reason) and writes it to Atlas, scoped to the thread and its Desk project. This turn costs one call at the old context size, about the price of
the next run it saves. Whenever there is no handoff from the session being
left (the handoff turn failed or timed out, or a cold reset found none
stored), Loom falls back to the run history: the owner's two latest messages
(up to 2,000 characters each) and the three latest assistant replies (up to
4,000 each), oldest first. Each is cut at its end if longer, never dropped, so
the newest reply, usually the decision or next step, always arrives. The
fallback is bounded at about 16,000 characters on top of the state block.

**2. The state (written by Loom from SQLite).** It is authoritative, so the
agent never has to remember it:

| Item | Source |
|---|---|
| Thread title, role, parent and children with their status | `threads` |
| Worktree path, branch, head, open PR | `threads.cwd`, `worktree_*`, `gh` |
| Open waits with their notes and expiry | `triggers` where waiting |
| Open decision briefs (ids, asks, defaults, deadlines) | `decisions` |
| The thread's open ask | `threads.ask` |
| Background tasks and in-flight side effects | `threads.background`, ledger `inflight` |
| Mail awaiting a reply | not carried yet: messages record direction but no reply state, so "unanswered" isn't knowable. It needs a reply link first. |
| The last two owner messages, verbatim | `messages` |
| The previous transcript's path | the closed session id |

The packet ends with: "This is a fresh session. The full earlier transcript is
at <path>; read it only for a detail the handoff doesn't have." The packet is
capped at 36,000 characters (about 9k tokens), with a budget per section so no
section crowds out another. The handoff or the fallback adds at most about 4k
tokens, so a fresh session starts around 55k with the base prompt.

**Leads carry a rolling summary, not the transcript.** A `default` thread's
handoff is written over the previous one: the new handoff gets the old
handoff in its prompt and is told to fold it in and drop what's finished. The
summary stays bounded no matter how long the lead lives. It is kept as the
Desk project's state head (memory spec section 5), so the project's workers
start from the same summary. Older handoffs stay in the table and in Atlas.

**Waits, briefs and triggers need no migration.** They are keyed by thread,
not by session, and a wake creates a run on the thread, so it lands in
whichever session is current. The only change is that the wake's run text
must stand alone, since the session may not remember setting the wait.
`triggers.note` already carries the agent's own note; Loom adds the wait's
spec and when it was set.

## Worker sessions end with their task

A worker's session ends when its task does. Today nothing special happens: a
finished worker stays resumable at full size, and a follow-up mail from its
parent wakes the whole transcript.

- **The task is done** when the worker reports to its parent and settles, its
  PR merges, or its parent marks it done. Loom records a pending reset with
  reason `task-done`. The first and last arrive as Loom's `settle` command
  (the worker settling itself, or the Desk's Done). PR merges are seen by the
  Desk, which knows each thread's PRs, and are a follow-up: until then a
  merged worker resets at its next settle or seam.
- **A follow-up starts fresh.** If the parent mails the worker again, the
  worker opens a fresh session with the packet. Its handoff says what was
  built and where.
- **Workers cool right after their turn,** as the roles spec says
  (`resilient-runtime.md`). The minute warmth sweep cools a worker once it has
  been idle for two minutes (`LOOM_WORKER_WARM_FLOOR_MS`) instead of the
  ten-minute floor, so a quick reply from its parent still finds it up. The
  usual guards still apply: no cooling with a turn, a question or background
  work in flight. Cooling and the
  session ending are separate: cooling frees the process, the reset discards
  the context.
- **Codex-review loops** are the largest single wake cost. A worker that waits
  on a review across many cycles resets at the 150k threshold like any thread.
  Fewer review cycles is the burn-rate work's side.

## Showing context size on the Desk

Loom starts recording usage. Today the `result` handler ignores it.

- **Recording.** `claude-runtime.ts` reads `usage` from each assistant message
  (input, cache read, cache write, output, model) and emits a
  `usage.observed`-style event per call. The host writes one row per call into
  a `usage` table (thread, run, attempt, session, at, context, cache_read,
  cache_write, output). It also keeps `threads.context_tokens` (the last call's
  context) and a per-day rollup.
- **Thread page** (`Details`, next to the account usage `ThreadAccount`
  already shows): "Context 312k · today 140M tokens (~2.5% of a weekly
  quota) · budget 100M", then the session's age and its last reset with the
  reason.
- **Row fact**, quiet unless it matters: "context 480k" once a thread passes
  the soft threshold without a pending reset, or "budget 85%". No badge on
  healthy threads.
- **Project view:** the top five threads by tokens today, so a runaway thread
  is visible before it costs a day's quota.
- **Timeline:** each reset is an event: "Fresh session (context 212k → 48k,
  reason: soft threshold)".

## Per-thread budget

A daily budget per thread, counted in input tokens sent (cache reads
included), because that is what grows with context and what the transcripts
measure. As a rough conversion from Oct 16-19, about 55M input tokens cost 1%
of a weekly Max quota; the Desk shows the conversion next to the number and
recalibrates it from weekly-window readings only. `usage.observed` carries no
window today, so recalibration waits until the event names its window
(five-hour or weekly). A five-hour reading must never move the weekly
conversion.

| Role | Daily budget (default) | Worst thread-day, Oct 16-19 |
|---|---|---|
| `interactive` | 100M (~2% weekly) | ~300M |
| `worker` | 100M | ~400M |
| `default` (lead) | 150M | ~30M |
| `ops` | 30M | n/a |

- **At 80%:** a row fact ("budget 85%"), and the thread's next seam forces a
  fresh session, once per budget day (`threads.budget_fresh_day`): the
  crossing triggers it, not the level, so later turns that day don't reset
  again. The mark is `fresh` with reason `budget`, set when the run that
  crosses ends. There is no extra handoff turn: the packet carries the latest
  saved handoff, the last replies and the transcript path. Shadow mode only
  logs it, and a kept session is never reset for its budget.
- **At 100%:** Loom holds the thread's non-owner runs (wakes, mail) with
  `admission = 'budget'` and `admission_until` the next local midnight, the
  same held state the account-floor fix introduces. The Desk shows "Held:
  daily budget, resumes at midnight" with a **Raise** button (+50% today). An
  owner turn always runs. The budget never blocks the owner.
- **Overrides** are per thread (`threads.budget`, 0 for none), set over
  `POST /threads/:id/budget {limit}` (`null` goes back to the role default).
  The role defaults come from `LOOM_BUDGET_INTERACTIVE`, `_WORKER`, `_DEFAULT`
  and `_OPS`, not the session profile: a profile change replaces the session.
- **Raise** is `POST /threads/:id/budget {raise: true}`: half the thread's
  budget again for the rest of the day (`threads.budget_raise`), and a held
  thread is dispatched at once. The thread page's Details show "85M of 100M
  today (85%)" with Raise from 80%.
- **The hold** is checked at dispatch, after a cancelled handoff turn and
  before the settle window. An owner turn queued behind held runs moves to the
  front, as it does for the machine limits. A timer kicks the thread just after
  midnight, and the minute warmth sweep retries it too, so a restart doesn't
  strand it.
- **A pool-level guard as well:** when less than 25% of an account's weekly
  quota is left (utilization above 75%), Loom halves every thread's soft threshold on that account. Context
  shrinks first, before the start floor stops everything. It reads the pool's
  weekly window, and only a fresh reading (15 minutes) counts.

## Rollout

Each phase ships on its own and is measured before the next.

1. **Ceiling, with hooks.** Set `CLAUDE_CODE_AUTO_COMPACT_WINDOW=250000` in
   the Loom session environment, plus the `PreCompact` instructions and a
   `SessionStart` hook that re-injects Loom's state block. About 44% of the
   saving from the replay, reversible by flag, and no new tables.
2. **Measure and show.** Usage recording, `threads.context_tokens`, the Desk
   readouts. No behavior change. This makes the next phases checkable.
3. **Fresh sessions, with unified memory** (D-40 B). `loom.save_handoff`, the
   `handoffs` table, the packet, and the soft, cold-cache, task-done and owner
   triggers, together with per-run Atlas extraction and the memory reseed, so
   no fresh session ships without them. Run it in shadow first (log the resets
   it would make, once per session), then on for workers, then for every role.
   `LOOM_FRESH_SESSIONS` is `shadow` (the default), `workers` (on for worker
   threads, shadow for the rest), `on` or `off`.
4. **Workers end with their task:** Loom detects a worker's task end (it
   reported to its parent and settled, its PR merged, or its parent marked it
   done) and marks it fresh with reason `task-done`, and workers cool right
   after their turn. Phase 3 already ships the `task-done` reason for an agent
   that saves a handoff itself at a task's end; phase 4 adds Loom's own
   detection.
5. **Budget.** Hold, raise and the pool-level guard.

Validation for each phase: context per call and daily input tokens from the
transcripts before and after, plus the account's weekly utilization curve.
For phase 3, also spot checks that a fresh session picks up its waits, briefs
and worktree without asking the owner anything the old session knew.

## Risks

- **Lost nuance.** A handoff drops something the transcript had. Mitigations:
  the agent writes its own handoff; Loom's state is authoritative; the old
  transcript path is in the packet; the owner can opt a thread out.
- **Handoff turn cost.** One call at the old context per reset, about 230 a
  day at current volume. The replay includes it.
- **Owner-visible discontinuity.** An interactive thread that forgets the
  conversation's tone. The last two owner messages travel verbatim, and resets
  prefer cold-cache seams, when the owner has been away an hour or more.
- **Compaction surprises.** A 250k ceiling compacts long runs that used to fit.
  The replay shows that is uncommon (90 compactions in four days across ~140
  threads), and it is the same mechanism threads already hit at 967k.

## Prior work

- Tango's Discord runtime solved the same shape for agents ("Context
  Lifecycle And Warm-Start Policy" and "v2 Runtime Warm-Start Context" in
  Linear): sessions are disposable working memory, durable memory
  reconstructs them. Loom's packet is the same idea built from Loom's own
  tables.
- [`resilient-runtime.md`](resilient-runtime.md): see the next section.
- [`decisions-and-delegation.md`](decisions-and-delegation.md): briefs are
  keyed by thread, so they survive a reset unchanged.

## Relation to the resilient runtime

The resilient runtime makes every *process* disposable: kill it anywhere,
resume from durable state. This spec makes the *session* disposable on the
same terms. The runtime's "resume" still means resuming the same native
transcript. Here, a thread can also resume from its state alone.

| Runtime piece | How this spec uses it |
|---|---|
| Session host (phase 0) | Hooks, the compaction env and usage events live in the host's `ClaudeRuntime`. Usage rides the host's numbered event stream. |
| In-flight ledger, side-effect log, checkpoints, timeline (phase 1) | The packet reads them: background tasks, outward actions already taken, uncommitted work. Resets are timeline events. |
| Waits and triggers (phase 1) | Keyed by thread, so they cross a reset untouched. Wake text must stand alone. |
| Recovery "continue" runs | After a crash on a thread past the soft threshold, recovery continues in a fresh session instead of resuming the whole transcript. |
| Warmth tiers and cooling (phase 2) | Separate axes: cooling frees the process, a reset drops the context. The cold-cache trigger fires when a cooled thread comes back after more than an hour. |
| Workers cool right after their turn (roles) | Built here, in phase 4, along with workers ending their session. |
| Admission (machine budget, account floor) | The thread budget adds `admission = 'budget'` with the same held-state display. |
| Tango agents on Loom (phase 4, TGO-976) | The Discord runtime's rotation and reseed (`session-lifecycle.ts`, Atlas warm start) should become this mechanism, not run next to it. The memory layers above are written so that agents inherit them. |
| More than one machine (phase 5, TGO-1016) | The native transcript moving with the shared project store is today's 2 GB of transcripts. Smaller sessions make moves cheap. A thread that resets on move needs only its SQLite (later Postgres) state and its branch. |
| Codex in Loom | Hooks and the compaction env are Claude-specific. A Codex runtime needs its own equivalent, and the packet and budget are runtime-neutral. |
| Unified agent instructions (TGO-1024) | The ~42k base prompt is a floor on every call. Trimming role overlays there lowers every reset's starting size. |

## Open questions

- Whether a 150k soft threshold is too aggressive for design-heavy
  interactive threads. Shadow mode answers it: compare handoffs with what the
  next runs needed.
- Whether to trim the 42k base prompt (tool definitions, guidance). It is a
  floor on every call and every reset.
- The token-to-quota conversion, until it is recalibrated from observed
  utilization.
