# Loom

Loom is Tango's session backend. It runs every long-lived agent session on this
machine: coding threads opened from the Agent Desk, and Tango's own agents. It
drives the official harnesses directly, the Claude Agent SDK and
`codex app-server`, and it keeps a pool of accounts so work continues when one
plan runs out.

The Desk is Loom's only interactive client. Loom has no UI of its own.

## Principles

1. **Full permissions.** Claude sessions run with `bypassPermissions`. Codex
   threads run with approval policy `never` and `danger-full-access`. Loom has
   no approval flow. Claude questions (`AskUserQuestion`) and plan exits come
   back to the Desk; unexpected Codex approval or user-input requests are declined.
   Stop interrupts either harness.
2. **One live session per thread.** A thread keeps one session host, which owns
   its harness process and survives coordinator restarts:
   - replies sent while the agent is busy queue in the thread's mailbox;
   - Stop interrupts the current turn;
   - background tasks keep running between turns and wake the thread when they
     finish.
3. **Accounts are a pool per provider.** Accounts with shared history can resume
   their provider's threads. When a turn hits a usage limit, the thread continues
   on an allowed account with room. New work never starts on a nearly empty account.
   Role routing selects the provider before a thread's first session; started threads
   keep that provider.
4. **One host.** Coding threads and Tango agents use the same API.
5. **Git errors are shown as they are.** Worktree operations surface git's own
   error text, with secrets redacted.
6. **Undocumented harness interfaces are guarded.** Loom pins harness versions,
   reads undocumented fields defensively, and runs a smoke check after each
   harness upgrade.

## Process model

Loom has a coordinator (`packages/loom`), separate from the Desk web server,
and one detached session-host process per open thread. The coordinator owns
SQLite, HTTP/SSE, the account pool and scheduling. Each host owns the harness
adapter and its process group; it never opens `loom.sqlite`. Deploying the Desk
or restarting the coordinator leaves running turns alive.

Only one coordinator may own a state directory. Ownership is an exclusive
SQLite transaction held for the life of the coordinator, so the OS releases it
even if that process is killed. Session hosts own only their sockets and ledger
files.

Hosts communicate over `hosts/<threadId>.sock` with versioned, newline-delimited
JSON. They number events and retain unacknowledged events for replay, except
live-only streaming deltas. The coordinator records the last applied sequence
per thread so reconnecting cannot store a completed message twice. A host also
reports its release (`LOOM_RELEASE`, or `dev`), exposed as `host_release` on the
thread. Release upgrades are a separate operation.

Harness processes are spawned as process-group leaders. Each host records its
own PID and start time, plus its harness groups, in `hosts/<threadId>.json`.
Recovery leaves groups belonging to a live host alone; only a dead host's groups
are reaped, checking PID start times to avoid killing reused PIDs. Explicit
session close ends the whole group so orphaned MCP servers die with it.
Coordinator SIGTERM/SIGINT only detaches sockets and releases ownership.

Session hosts start in their own session (`detached: true`), so launchd does
not kill them when it stops or restarts the coordinator's job. This was checked
with `launchctl kickstart -k` and `bootout`, with `AbandonProcessGroup` both on
and off. The live plist (kept outside this repository) sets it to `true` anyway,
as a guard.

A host exits after explicit close, or after its harness ends and the coordinator
acknowledges `session.ended`. If no coordinator acknowledges within 60 seconds,
the host saves unacknowledged events to `hosts/<threadId>.pending.jsonl` before
exiting; the next coordinator consumes that tail during recovery.

PATH is captured once at startup from the login shell (`$SHELL -ilc` with
marker lines, falling back to `launchctl getenv PATH`). This happens before any
harness probe, because launchd starts services with a bare PATH.

## Releases

`npm run release:build -w @tango/loom` builds a self-contained, read-only
candidate under `LOOM_RELEASES_DIR` (default `~/.tango/releases/loom`). Dirty
Loom sources require `-- --allow-dirty`. The installed production closure from `npm ls -w @tango/loom --omit=dev --all --parseable`
is copied with its root and Loom-local dependency directories intact, preserving
Node resolution without fetching dependencies. Compiled code and the package
manifest live under `<id>/packages/loom/`; `<id>/dist` does not exist.
`<id>/release.json` records dependency names and versions in `dependencies`,
with every installed version and location in `dependencyLocations` (including
multiple versions of the same name).

Use `release:list` to inspect releases, `release:promote -- <id>` to select a
candidate after canary checks, and `release:rollback` to swap current and previous.
These scripts run with `-w @tango/loom`. Restart the coordinator after either
pointer change; the launchd job should run `<root>/current/packages/loom/dist/main.js`.
`node <root>/current/packages/loom/dist/main.js --version` prints its release without taking
ownership. Startup also exports `LOOM_RELEASE` to child processes.

`release:pin -- <threadId> <id|none>` records a pin for future host routing.
`release:prune -- --keep 5` keeps five unprotected releases in addition to
current, previous, candidates, pins and any release a live session host or the
running coordinator still runs from (named in its host ledger or
`coordinator.json`). Every promote and rollback runs the same prune with the
default of five; if that prune fails, the move still stands and the error is
printed. State writes and pointer swaps are atomic; state
is authoritative if an interrupted pointer swap needs repair on the next CLI
invocation. Mutations hold `<root>/.lock`; after a killed CLI, confirm it is no
longer running before removing that lock directory and retrying.

## Identities

Loom keeps separate IDs for things that move independently:

| Identity | Meaning |
|---|---|
| thread | The conversation the Desk shows. Stable for its whole life. |
| run | One requested unit of work: a user message, or a wake turn. |
| attempt | One try at a run on one account. A run that hits a limit and moves gets a second attempt. |
| native session | The harness's own ID: a Claude session ID or a Codex thread ID. |
| account | The plan an attempt ran on. |

Because these are kept apart, a thread can move between accounts without losing
its identity.

## Commands, state and the change log

Clients send commands: `submit`, `answer`, `interrupt`, `stop`, `settle`. Every
command carries a client-chosen `commandId`. In a single SQLite transaction, Loom:

1. records the command receipt, including rejections, so a retry gets the same
   answer;
2. applies the state change;
3. queues any run that must reach a harness;
4. appends one row per changed entity to the change log.

Live subscribers are notified only after the commit, and always in sequence
order. Commands for one thread are applied one at a time. Server-generated
commands use deterministic IDs, so periodic sweeps can safely run again.

A turn that may already have reached a harness is never retried blindly. After a
restart, Loom first reattaches live session hosts and replays their events. Their
active runs stay running and open questions remain answerable. Only a turn whose
host is gone is marked interrupted, has its questions expired, and receives one
"continue where you left off" run that tells the model what was cut off. It
continues automatically at most three times in a row. Hosts for deleted or
stopped threads are explicitly closed.

A turn that fails on a usage limit or an auth error holds the thread's queue
rather than failing the next run the same way.

A turn the model turns away as overloaded (a 529, or Codex's "Selected model is
at capacity") is retried on the same session and account after a pause of 1, 3,
10 and then 20 minutes. Capacity belongs to the model, not the account, so moving
accounts would not help. While it waits, the thread holds as `provider_busy`
with the retry time, and the desk reads it as held, not failed. The retry resends
the message in full behind a short note, because the harness may not have kept
a turn it never ran. Only after the last retry does the run fail and get
reported to the worker's lead.

## Live updates

The Desk subscribes with server-sent events from a sequence number
(`?after=<seq>`). Loom subscribes the client before replaying the stored tail, so
nothing falls into the gap between them. If the client is too far behind, Loom
sends a fresh snapshot instead of the replay. A slow subscriber that overflows
its buffer is disconnected with a "resume from your last sequence" message.

## Storage rules

These rules come from measuring an older backend whose state grew to about 9 GB.
Nearly all of that was tool output stored twice, plus every streaming update
saved in full.

- Tool output is capped in the row: a head and a tail. The full output stays in
  the harness's own transcript.
- Streaming text is never persisted. Partial text lives in memory and goes out
  live. A message is written when it completes.
- Each entity is stored once. The change log holds pointers, not copies.
- Deleting a thread hard-deletes its rows. The database runs with
  `auto_vacuum = INCREMENTAL`, and space is reclaimed periodically.

## Accounts

Each Claude account has its own `CLAUDE_CONFIG_DIR`, and each Codex account its
own `CODEX_HOME`. Credentials always stay private to their account.

- **Claude.** Each account has real `projects/<cwd-slug>` and session directories,
  so Claude can safely write oversized tool results. Transcript files (`<id>.jsonl`)
  are hard links to the shared project store: appends reach the same inode, and
  account moves resume the same native session with full history. Loom registers
  newly reported session IDs and reconciles transcripts before opening a session.
  Companion directories (tool results and subagents) are copied between accounts
  without overwriting existing files. Startup and open migrate legacy directory
  symlinks, keeping backups and all shared data. If transcript inodes diverge,
  the newer mtime wins and the other file is preserved as `.loom-backup-<timestamp>`.
  Cross-volume hard-link failures fall back to copies with a one-time warning;
  the active account refreshes the shared transcript before Loom tails it.
  Paths whose slugs exceed 200 characters remain unsupported.
- **Codex.** The configured `home` supplies CODEX_HOME, including the account's
  own authentication and config. The operator must provision shared session history
  for cross-account native resume. Loom does not create or rewrite these homes.

HOME is never overridden per account, because macOS looks up Keychain
credentials relative to it.

Only one live process may drive a native session at a time. Before a thread moves
to another account, Loom ends the old process. Events that arrive late from a
replaced process are dropped.

Accounts are listed in a private file outside the repo, `~/.tango/loom/accounts.json`.

## The account pool

Loom reads each account's remaining room from Tango's usage monitor
(`apps/usage-ui`, `GET /api/usage`), which tracks live quota for every account.
It uses the tightest main window (5 hour or 7 day) and ignores model-only
windows. Rate-limit readings from running sessions correct it between polls.

- A new thread starts on the account with the most room, never on one under
  10%.
- Before a session opens, an account that has run low is swapped for the best
  one available.
- When a turn hits a usage limit, the account cools down until its reset time
  (an hour if the harness gave none). The run goes back to the front of the
  queue, and the thread continues on the account with the most room. The run
  resumes the same native session with a short note instead of resending the
  message, because the harness already has it. A run moves at most six times.
- When no account has room, the thread waits durably and tries again at the
  soonest reset.

Each account maps to its usage-monitor row by `usageName` in `accounts.json`.
`aliases` lists other names callers use for it, including legacy account ids.

A thread can carry a literal allowed set (`accounts` on submit). Unknown names
are refused, and a single-account pin waits for that account's reset. Desk pool
starts also send `accountsFrom: "policy"`: Loom resolves the current routing
policy for the repo on every placement, canonicalizes aliases, and refreshes the
stored `accounts` snapshot. The repo's pool overrides the default pool. Unknown
names and other providers are skipped; a missing, broken or provider-empty
policy falls back to the last stored set. Parsed policies are cached by file
revision. Explicit pins remain literal and ignore policy edits.

At host startup, open multi-account literal sets matching their current policy
pool are adopted as policy-following sets. Single-account pins, stopped and
settled threads, and non-matching sets stay unchanged. Switching providers clears
both the allowed set and its source.

## Worktrees

The new-thread sheet defaults to **Auto**, with **Worktree** and **My checkout**
under Options. Auto starts in the checkout; its first guarded edit is denied and
moves the same thread into a worktree. Loom interrupts the turn, requests a handoff,
then starts a fresh session carrying state, the handoff and the previous transcript
reference. Waits, briefs and the desk row stay on the same thread. A warm pooled
worktree is preferred; otherwise one is created at the checkout's current HEAD
without a fetch. Uncommitted changes stay in the original checkout and are listed
in the continuation. `LOOM_AUTO_PROMOTE=off` disables new promotions. After a move,
the mode becomes worktree, so further signals cannot promote it again.

Codex has no general pre-edit callback: Auto coding sessions use its read-only
sandbox and decline file-change or command escalation requests before signaling
the same move. A denied write without an escalation request does not trigger it;
command escalation for a non-write need can trigger it too. External MCP tools
are outside that filesystem sandbox. With promotion off, Auto stays read-only.
Claude retains the existing tool guard described below.

`tango-screen start --role worker --same-tree` reuses the parent thread's existing
build worktree. It requires a parent and cannot combine with an explicit mode;
normal worker starts are unchanged. Shared trees are conservatively retained
while multiple thread rows own them, even if those rows have settled.
`threads.worktree_mode` persists `auto`, `worktree`, or `local`. Existing threads
are backfilled as worktree when they own a Loom worktree, otherwise local.

The role/prompt heuristic is a hint on the sheet and never changes its selection.
Callers that omit mode retain the existing defaults: ops, coordinators and QA
start local, workers get a worktree, and interactive build verbs win over
read-only keywords. Ambiguous requests keep repo policy (else worktree).
`tango-screen start --mode auto|worktree|local` overrides that default.
Plan first alone does not change it.

Claude local coding threads (kind `coding`) inside a git checkout deny Edit, Write, NotebookEdit and
MultiEdit paths inside that checkout, including symlink aliases. Paths outside
it remain available for artifacts and memory. Open a worker with
`tango-screen start ... --role worker`, hand the build to Codex via agentctl, or
ask the owner for implementation. `LOOM_LOCAL_EDIT_GUARD=off` disables this
boundary. The guard runs in canUseTool and PreToolUse (including permission
bypass); it does not inspect Bash commands and is not a filesystem sandbox.
Loom-owned worktrees under `<loomHome>/worktrees` are exempt, and so are Tango
agent and job threads, which work in their own checkout on purpose. This guard applies
to Claude; it does not add a Codex runtime restriction.


A submit can carry `worktree: "auto"` or `false` with `cwd` to start locally.
`worktree: true` or `"worktree"` uses `repo` (falling back to `cwd`) as the source.
The existing `worktree: { repoPath }` form also remains supported. For a worktree, Loom:

1. fetches origin's default branch;
2. creates branch `loom/<id8>` at the commit it just fetched, in
   `~/.tango/loom/worktrees/<repo>/loom-<id8>`;
3. initializes submodules (best effort) and records the PR base;
4. starts the thread there.

The git wrapper (`git.ts`) follows three rules learned from running another
backend's worktrees:

- **Return when git exits.** It resolves when git exits and gives the pipes a
  second to drain. A hook that leaves a background process holding stdout can't
  hang the call.
- **Size each timeout to its operation:** a fetch gets 2 minutes and
  `worktree add` gets 5.
- **Show git's own words.** Errors carry git's own message, with credentials
  redacted. A ref-lock failure that comes from two refs differing only in
  letter case says so, because retrying never fixes it.

A failed worktree refuses the submit with `worktree_failed` and git's message.
A retry with the same command id gets that refusal back without running git
again.

Loom's sweep applies R-4 only to its owned worktrees. A merged GitHub PR for
`worktree_branch` (or the checkout's current branch) marks work finished, including
squash merges. Each pass caches `gh pr list --state merged --head <branch>` results;
if GitHub lookup fails, the reason reports `pr lookup unavailable` and the sweep
still checks HEAD ancestry against origin's default branch.

Merged, unsettled threads can be reclaimed after more than 24 idle hours
(`LOOM_WORKTREE_FINISHED_IDLE_HOURS` overrides this). Idle time starts at the latest
run's `ended_at`, or thread creation when there is no run, never `updated_at`.
Clean never-used branches with HEAD reachable from origin's default branch and
zero commits beyond it qualify too. Settled or stopped threads also wait this
threshold, measured from the later of settlement and last activity, even when
merged. Explicitly deleted threads still qualify immediately. Unsettled threads must have
clean git status, including no untracked files.

Active or queued runs, open requests, open decision briefs, pending waits,
background work, live hosts and cwd processes hold the checkout. An otherwise
eligible thread's idle warm session is released before a real pass rechecks its
host and cwd processes. Dry runs show the same eligibility without releasing
sessions or changing files. Removal preserves the branch, checkpoints changes as
before, and records `worktree_removed_at`; it never settles the thread. The next
message restores the checkout and dependencies before opening a session.

## Thread names and repos

Each thread records its repo, the checkout it works on, so clients can file it
under that repo and not under its worktree folder. When a new thread's title is
only a stand-in from the prompt (`autoTitle`), Loom asks a small model
(`claude-haiku-5-5`, with no tools and no saved transcript, on the thread's own
account) for a three-to-six-word name, as T3 does. A title someone gave, or a
`rename`, is never replaced.

## Models by role

`ROLE_MODELS` in host.ts defaults to `{ worker: "codex", ops: "haiku", qa: "codex:gpt-6.1-sol@medium" }`. A role value
`codex` selects the Codex account's configured model; `codex:<model>` selects an explicit
Codex model. Plain `sonnet` and `haiku` select Claude models. Interactive and default
threads keep their existing provider and harness default.

A start may name a task tier with `tango-screen start --tier qa "…"` without changing its role.
Tiers use the same map; unknown tiers fall back to the role. Values accept `@effort`
(`low`, `medium`, `high`, `xhigh`, `max`) for Codex or Claude models. The default `qa`
tier runs `gpt-6.1-sol` at medium effort on Codex, falling back to Claude Sonnet.

At first dispatch, before any native session or run has started, Loom applies the role
unless the session profile already specifies a model. Switching to Codex requires a
registered runtime and a usable Codex pool account. It resets the account restriction
list to any account of the new provider. If Codex is unavailable, workers stay on Claude
with Sonnet (`ROLE_FALLBACK_MODELS`), as do profiles Codex can't honour (`tools: "none"`,
a remote MCP server; `codexIncompatible`). Started threads never switch provider or model.
A later profile without a model keeps the thread's model.

`LOOM_ROLE_MODELS` replaces the map. `LOOM_ROLE_MODELS='{"worker":"sonnet"}'` restores
Claude workers; `{}` disables role tiering. Live account configuration remains private:
add an optional `codex` block to accounts.json with `default` and `accounts`, each with
`name`, `home` (CODEX_HOME), and optional `usageName` and `aliases`.

## Images

A user message can carry images (`attachments` on submit): PNG, JPEG, GIF or
WebP, 10 MB each, eight at most. The bytes are written to
`~/.tango/loom/attachments/<thread>/`, never into the database. A row links
each image to its message and run, and files written by a command whose
transaction rolls back are removed.

When a run's turn starts, its images go to Claude as image content blocks ahead
of the words, or to Codex as image data URLs. A message slipped into a running turn carries its images too. A
continue after a usage limit resends none, because the harness's transcript
already has them. Clients read an image back with `GET /attachments/:id`.
Deleting a thread deletes its images.

## The Claude runtime

Each thread has one Agent SDK `query()` fed by a prompt queue. It runs with
`bypassPermissions`. A `canUseTool` callback guards local checkout edits and
handles `AskUserQuestion` (the answers go back in `updatedInput`) and
`ExitPlanMode` (approve, or deny with feedback). Other tools are allowed subject
to the local checkout guard above. The SDK warns that `canUseTool` is shadowed under bypass mode, but it still routes these two tools to the callback.
The live check (`packages/loom/scripts/live-claude.ts`) confirms this on every
SDK upgrade.

Output that arrives while no turn is running, such as Claude reacting to a
finished background task, becomes a wake run. Failures are classified as usage
limit, auth, overloaded or interrupted, including the SDK's habit of reporting
some errors as a `success` result with `is_error` set. The harness process is
spawned as a process group and recorded in the orphan ledger.

## The Codex runtime

`codex/codex-runtime.ts` implements the same Runtime contract as Claude through the v2
stdio protocol of codex-cli 0.163.0. Each session host owns one `codex app-server`
process group recorded in its SpawnLedger. Host configuration selects the provider
and its adapter options; fake-runtime mode works for either provider.

The adapter initializes and starts or resumes a native thread in its cwd, with approval
policy `never` and sandbox `danger-full-access`, matching Claude's permission policy.
HOME stays unchanged, CODEX_HOME selects the account, and API-key/endpoint overrides
are removed. Non-Codex profile model aliases leave the account's configured default.
Loom guidance and profile instructions become developer instructions; carried state
is fetched on open/resume and prepended once to the first turn.

Loom's tools share one definition list between the Claude SDK server and a stdio MCP
server named `loom` for Codex. Stdio profile MCP servers pass through. `loomTools: false`
omits Loom tools, guidance and carry. Turns support images (data URLs), steering and
interrupts. Agent messages, command/file/MCP/search items, quota readings and terminal
turns map to Runtime events; unexpected approval requests are declined. Subagents the
thread spawns (`subAgentActivity` items) map to `background.changed` as `local_agent`
tasks, named by their agent path, from start until they complete or are interrupted
(a message to a finished one, `interacted`, doesn't revive it). A subagent's own spawns
report on its thread and count too,
even after the spawning turn ends, so the desk shows them on the row the way it shows
Claude's. They end with the app-server. Account-pool
usage readings from the monitor match Codex provider names case-insensitively.

`node scripts/loom-burn.mjs --codex` adds account/day token totals from Codex rollout
`token_count` events under each configured account's home/sessions, alongside the
unchanged Claude report. `--accounts <path>` selects a private accounts file.

## Reference implementation

Loom follows the design of [T3 Code](https://github.com/pingdotgg/t3code) (MIT),
which drives the same two harnesses. Loom keeps T3's rules and ports several of
its leaf modules. Each ported file names its upstream path and commit. Loom does
not use Effect. T3 has no shared Claude history across accounts and no
account-pool scheduler; those parts are Loom's own.

## Capacity and moves

`GET /capacity` serves the Desk's account, thread, usage-window and routing-rule
fields, with `loom: true`, `moves: true` and `machine: null`. Account ids use the
first configured alias, falling back to the Loom name; allowed accounts use the
same ids. Threads report `allowedFrom: "policy" | "pinned" | null`; literal
sets show a pinned tag on the desk. Usage percentages are clamped to 0–100 and reset times are epoch
milliseconds. Cooling accounts report `cooling`, other accounts `ok`. Stopped
and settled threads do not occupy capacity. Routing comes from
`TANGO_START_WORK_POLICY`, defaulting to the default profile's
`config/screen/start-work.yaml`; invalid policies return empty rules and an error.

`POST /threads/:id/move` accepts `{ commandId, account }`, or clients can send
`{ type: "move", commandId, threadId, account }` to `POST /commands`. Names and
aliases resolve through the pool; unknown or disallowed accounts are refused.
An explicit `allow: true` (Run on) freezes a policy thread to its currently
resolved set plus the selected account, making the allowed set literal.
The durable pending target is replaced by a later move and applies once no turn
or question is open. Idle sessions close immediately; the next turn resumes
the same native conversation on the target account. Normal pool capacity checks
still apply before a turn starts. `GET /threads/:id/accounts` returns account
history as `{ account, at, reason }`, combining attempts with recorded moves;
reasons are `start`, `limit`, `auth`, `move` and `low`.

### Quota forecast

Loom stores accepted usage-monitor readings per provider and account, recording
weekly changes and a heartbeat every 30 minutes, and retaining 14 days. The
Capacity page projects weekly room at reset from the oldest sample in the
trailing 24 hours with the same reset (within one minute). At least two hours
of history are required. Burn is the nonnegative percentage-point drop divided
by elapsed hours; projected room subtracts that hourly burn through reset and
is clamped at zero. Missing, stale or expired readings produce no forecast.

`expires unused` means at least 25% would remain at reset. `runs dry` means the
account reaches the start floor before reset, with the estimated time shown;
an account already at or below the floor is dry now. The page also shows burn
per day and Loom's pace score. These are linear estimates, not scheduling rules;
the 5-hour window is not forecast. `GET /capacity` includes `forecast` and
`forecastReason` (`history`, `no_reading`, or null) for each account.

## Triggers

Waiting is a durable record owned by a thread. Sessions receive the `loom` MCP
server in-process for Claude and over stdio for Codex, with `wait_for`, `list_waits`,
and `cancel_wait`.
After registering a wait, the agent ends its turn. The session host calls the
coordinator over authenticated loopback HTTP; no host-protocol extension is
needed.

The coordinator's trigger service supports a time (`at` or `afterMinutes`), PR
approval/merge/closure/completed checks/new comment, a successful shell command,
a URL status, another thread becoming idle or completing a run, and a file's
presence or absence. Commands run in the thread's directory unless overridden,
with a process-group timeout. At most four checks run concurrently. Identical
normalized conditions share a poll; PR and URL checks run every minute, files
every 30 seconds, and commands at their configured interval (minimum 30 seconds).
Thread conditions use coordinator state-change events.

Each trigger has the agent's note and an expiry (default one day, maximum seven
days). Firing or expiry atomically records its result and queues one wake run
with that note and details. The wake waits behind an active turn. Waiting rows
survive restarts, and overdue time waits fire once. Stop or deletion cancels
owned waits. Terminal trigger records remain available for inspection.

After requesting a Codex review, use `wait_for` kind `pr` with
`{repo, number, until: "codex_reviewed"}`. It reads the connector bot's summary
state and wakes only when `code_review` is completed for the PR's current head,
reporting whether it found issues. After 12 minutes from the later of wait
creation and the summary's last update, Loom posts one `@codex review`.
The attempt is recorded before posting so a restart or ambiguous API failure
cannot duplicate it. After another 12 minutes it wakes with a stalled result
and tells the agent not to request again, but to apply merge-when-green on the
recorded facts. The second window is fixed even if the summary keeps updating.

A wait that names Codex and a GitHub PR is a Codex review pass, including a
`codex_reviewed` wait that fires stalled. A thread gets at most
`CODEX_REVIEW_CAP` (5) fired passes per PR since the owner last spoke (their own
words, not mail or a wake). From pass 3 on, only P1 findings block; P2 and edge
findings move to a recorded follow-up and their threads are resolved. At the
cap, the wake says to apply merge-when-green without another pass, and
`trigger.create` refuses a further Codex wait until the owner speaks.

Automatic runs (wakes and other agents' mail) wait `AUTOMATIC_SETTLE_MS` (60 s,
`LOOM_AUTOMATIC_SETTLE_MS`) before they start, unless the owner's words are queued
too, and consecutive queued automatic runs fold into one turn: the later runs end
`canceled` with failure code `folded` and their messages move to the run that
carried them. Every turn rereads the thread's whole context, so a burst of wakes
and mail costs one read instead of several.

Clients create and cancel through `trigger.create` and `trigger.cancel` on
`POST /commands`, using ordinary command receipts for idempotency. Inspection
uses `GET /threads/:id/triggers` and `GET /triggers?status=waiting`.
Thread payloads expose active waits in `waiting_on` with id, kind, description,
and expiry. Triggers always wake their existing owner; creating fresh threads
from routines is outside this implementation.

## Ledger and recovery

The coordinator records turns and harness background tasks in `inflight`, including
ambient watchers. Rows retain their host identity, start/end times and outcome.
Reattached hosts keep their open rows. For a dead host, recovery marks unfinished
rows lost and lists them in the thread's continuation note, including idle threads
that lost background work.

`side_effects` records separate intent and result rows for outward shell and MCP
actions. Summaries are capped and redacted; MCP payloads and shell request bodies
are omitted. An intent without a result has an unknown outcome. Recovery compares
the current branch's local HEAD with `git ls-remote origin <branch>` for pushes,
and lists PRs for the current branch for PR creation. Each command has a ten second
timeout; unavailable checks leave the outcome unknown. These checks are evidence
about the current branch, not proof about arbitrary push refspecs or shell scripts.

Upgrade closes return the background tasks frozen at the host's safe point. The
wake note names those tasks rather than the coordinator's earlier cached list.
Turn completion in a Loom-owned worktree asynchronously saves tracked and
untracked nonignored files using a temporary Git index under
`refs/loom/checkpoints/<threadId>`. Checkpoints do not overlap for a thread; an
unchanged tree within two minutes skips the ref update. Failures are best effort
and never fail the turn.

`GET /threads/:id/timeline` returns the newest 500 events in chronological order,
merging runs, attempts, account history, host moves/releases, ledger activity,
side effects and checkpoints as `{ at, kind, summary, ref }` entries.

## Warmth and admission

Idle threads keep their hosts while the machine has room. Every minute, and
before opening a host, Loom checks available memory (`memory_pressure -Q`, with
`vm_stat` fallback), the Loom home volume (`statfs`), and the live host count.
It cools eligible hosts in order of last activity, measuring again after each
close. Defaults are 12 warm hosts, 15% available memory and 20 GiB free disk;
`LOOM_MAX_WARM_HOSTS`, `LOOM_MIN_FREE_MEMORY_PCT` and
`LOOM_MIN_FREE_DISK_GB` override them.

Cooling requires no running or queued run, open question, real background work,
pending account or release move, or recently finished background task. The warm
floor defaults to ten minutes (`LOOM_WARM_FLOOR_MS`). Trigger waits do not hold
a host. Ambient watchers may be stopped; their names are saved in a note for
the next turn, without queuing a wake. Cooling closes the host and its process
group while keeping the worktree, native conversation and transcript.
`cooled_at` records cooling and clears on reopening; payloads also expose
`warmth: "warm" | "cooled"`.

If eviction cannot make room, the run stays queued with
`admission: "waiting_for_room"` and the minute sweep retries it. A thread with
a user-source run less than two minutes old may exceed the host and memory
limits, but needs at least 5 GiB free disk. Opens and eviction are serialized
across threads so concurrent requests cannot claim the same slot.

`POST /threads/:id/warm` restores a host without starting a turn, respecting
admission and doing nothing when already warm. A deferred prewarm also retries
on the minute sweep. The next turn resumes the same native session and receives
any saved watcher note, even if prewarming opened the host first.

Each successful host open records its thread, reason (`new`, `resume`, `warm`,
`move`), timestamp and milliseconds to the host's hello in `host_opens`.
`GET /machine` includes `at`, `memory.totalBytes`, `memory.agents`,
`disk.totalBytes`, `disk.freeBytes`, and `worktrees.count` for the Desk's capacity
view, plus available memory percentage, ledger-PID RSS totals, warm/cooled
counts, `retiredJobs` (the last cleanup pass’s retired job count), limits, the last 50 opens and their median duration,
and `stall`: the last minute's event-loop delay (p50/p99/max), slowest subprocess
start (git, `memory_pressure`) and active resources by kind. A degraded minute
(loop p99 ≥ 250 ms, any stall ≥ 2 s, or a spawn ≥ 2 s) also logs one timestamped
`[loom] stall …` line. RSS includes each
live host and its recorded harness group leaders; it is a process reading,
not a sum of every descendant's memory.

## Maintenance mode

Authenticated `POST /maintenance` accepts `{ on: boolean, reason?: string }`.
`GET /maintenance` returns `{ on, reason, since, running, queued }`; `since` is
an epoch millisecond timestamp (null when off), and counts refer to run statuses.
The setting lives in coordinator SQLite state and survives restarts.

While enabled, running turns finish and open questions and steering still reach
the turn in progress. Submits remain accepted, and triggers keep evaluating and
queueing wakes, but dispatch starts no queued runs. Prewarming cannot open a new
host. Reattaching a surviving host or reopening for an active turn is allowed.
The owner's own message is held only for `MAINTENANCE_OWNER_GRACE_MS` (two
minutes); after that it starts ahead of the automatic runs maintenance still
holds. A drain waits for every running turn, and on 10/24 one held owner messages
for up to 12 minutes behind another thread's long turn; hosts outlive a
coordinator restart, so starting the owner's turn costs the drain nothing.
The system tick posts a critical `loom:turns` incident when an owner message has
waited 150 s with nothing of its own conversation running, naming what holds it.
Disabling maintenance kicks waiting threads through the usual admission path.
Snapshots and thread payloads expose `maintenance: true` while enabled; changes
also publish updated thread payloads to subscribers.

PR `checks_done` waits request `mergeable` in the existing `gh pr view` poll.
`CONFLICTING` fires immediately with `detail.conflict = true` and a rebase note.
An empty check rollup with `UNKNOWN` mergeability fires after ten minutes of
continuous observations without checks; a known mergeable state or reported
check resets that window. This observation window restarts with the coordinator.
The wake says: "PR #N conflicts with its base, so its checks will never run;
rebase it".

Command polls share evaluations only within their owning thread. Cancelling a
thread's waits (including switching its profile to `loomTools: false`) kills any
in-flight command's entire process group, including descendants. A cancelled
check cannot queue a wake. Shutting down the trigger service also kills its
in-flight commands.

### Scheduled-job retention

Alongside the 30-minute worktree reclaim sweep, Loom cascade-deletes `tango-job`
threads whose last run ended more than `LOOM_JOB_RETENTION_DAYS` days ago
(default 7). Queued or running runs, open requests, open decisions, and live or
opening hosts prevent retirement. Threads without a finished last run remain.
Each pass logs its retired count, also exposed as `retiredJobs` in `/machine`.
Owned worktrees retain a deletion record for the existing safe reclaim pass.

Grouped `checks_done` PR waits share a poll but each wait starts its own
ten-minute observation window for an unknown mergeability result with no checks.
Only waits whose windows have elapsed fire; an explicit `CONFLICTING` result
fires immediately. Maintenance is checked again after host activation, closing
an idle host if maintenance began while activation was pending.

### Balancing accounts

Allowed accounts are ranked by `pace * five / (1 + 0.3 * load)`.
Pace is weekly fraction remaining divided by fraction of the week until reset
(minimum 0.05), capped at 5; a missing reset uses a full week. Five is the
5-hour fraction remaining, penalized by 0.1 below the 25% guard. Guarded
accounts are a fallback after other usable known accounts. Recent placements
lose weight linearly over ten minutes to cover lagging usage readings.

A usable account changes only without a live session and more than one hour
after the last run ended, preserving warm prompt caches. The destination must
score at least twice as high, unless the current account is below the guard.
The existing 10% start floor, cooldowns and allowed accounts still apply.
`LOOM_BALANCE` accepts JSON overrides for `fiveHourGuard`, `loadWeight`,
`rebalanceRatio` and `cacheColdMs`; `LOOM_BALANCE='{"greedy":true}'` restores
pick-by-remaining and disables proactive balancing.


## Fan-out research probes

`fan_out` starts 1–20 bounded research threads (`kind: "probe"`) owned by the
calling thread. Both harnesses expose it through the shared Loom tool list;
`fan_out_status` returns the parent's progress and results. Optional inputs are
shared context, a JSON Schema (default `{answer: string}`), provider, role-model
tier, a literal allowed account set, concurrency (default 4, maximum 8), and a
deadline (default 30 minutes, maximum 120).

SQLite stores batches and probe state. Each probe uses the ordinary account
pool, repository routing policy, start floor, placement balancing, usage-limit
moves and host admission. A probe has no worktree and no owner-message admission
exemption. The `probe` role model defaults to Codex with Sonnet fallback; an
explicit provider or literal account set never silently switches providers.
Concurrency includes probes waiting for admission. Completed hosts close without
a warm floor. Stopping/deleting the parent or cancelling its wait stops unfinished
probes; deadlines produce `timed_out` results.

Claude probes disable setting sources and Loom tools, remove Edit, Write,
NotebookEdit and MultiEdit through `disallowedTools`, and deny them through both
permission callbacks. Bash remains available and is not OS-sandboxed on Claude.
Codex probes use the verified per-thread `read-only` sandbox and
`project_doc_max_bytes: 0` on start and resume. On pinned codex-cli 0.163.0,
account-wide `AGENTS.md` still loads independently through
`codex-home/src/instructions/mod.rs`; scratch cwd does not suppress it. The core
keeps the account home unchanged. It omits configured developer guidance, Loom
guidance and role add-ons, replacing them with the fixed probe developer prompt
and schema, including a JSON-only reply-format override. A live sandbox smoke
test on 0.163.0 observed 22,750 first-turn input tokens and refused the requested
file write (`operation not permitted`); no file was created. This is a single
probe measurement, not a matched worker comparison.

The first JSON object (including inside a fenced block) is validated with Ajv;
trailing prose is ignored. One repair turn is allowed, then the result becomes
`invalid`. Harness failures become `failed`. A `fan_out` trigger queues one wake
for the whole set, with results capped at 4,000 characters per probe and 40,000
total. Full results are atomically written beneath
`~/.tango/loom/fan-outs/<id>/results.json`. Usage rows carry `fan_out_id` and
`parent_thread_id`. Batch state survives coordinator restarts.

Probes stay out of the desk list, titling, summaries, memory capture and Feed/catch-up
production; direct thread reads and peek remain available. The parent detail's
background tasks include one item per retained fan-out, with progress, accounts
and a results link. Progress is atomically mirrored to the artifact host's root
(`LOOM_FAN_OUT_ARTIFACTS`, default `~/.agentic-workflow/artifacts`) under
`loom-fan-out-<id>/results.json`. `LOOM_FAN_OUT_ARTIFACTS_URL` overrides the
default same-origin `/artifacts` URL when the desk uses a separate port. It does not extend the parent's session liveness.
The CLI accepts `tango-screen fan-out [list]` and `tango-screen fan-out <id>` with
normal current-thread / `--thread` selection.

The job sweep also retires settled, inactive probes older than
`LOOM_JOB_RETENTION_DAYS` (default 7), only after their batch finishes. Once all
probe threads are gone, it deletes the batch, original results and artifact copy.
Active, queued or live borrowers still block managed resources and worktree
reclamation; settled borrowers no longer claim ownership. The agent policy is
separate follow-up work.
