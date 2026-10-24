# Resilient runtime

Design for making Tango's backend safe to upgrade, restart and grow while agents
are working (October 2026). [Loom](../architecture/loom.md) is the starting
point: it already records runs and attempts, resumes a native session on another
account, and queues one "continue where you left off" run after a restart. This
spec extends those pieces to the whole system.

Active plans, status and validation evidence live in Linear (project
"Resilient runtime"). This file records the design.

## Problems

1. **Upgrades wait for agents.** Loom is the parent of every harness process. A
   restart kills every running turn, so a deploy waits until nothing is running.
   Loom also runs built output from a mutable checkout, so a rebuild changes code
   under a live process.
2. **A crash loses in-flight work silently.** Loom records turns, but background
   tasks, monitors and watch loops live only inside a harness process. Nothing
   records that they existed.
3. **Resources leak.** Worktrees, dependency installs, build caches, browser
   sessions and harness processes pile up until the disk or RAM runs out. Cleanup
   is a separate periodic routine that guesses ownership from timestamps and
   process lists.
4. **Services are scattered.** About thirty launchd jobs, a tmux-hosted bot and a
   healthcheck job, each started, permissioned and restarted differently.
5. **One machine.** All work runs on one Mac even when other machines are idle.

## Principles

1. **Everything resumable.** Any process can be killed at any moment and the
   work continues from durable state. Restart, upgrade, cooling an idle thread, cleanup and
   moving to another machine are all the same operation: stop here, resume there.
2. **Every resource has an owner.** Nothing is created without a record of which
   thread or service owns it and when it may be taken back.
3. **Releases are immutable.** A running process never has its code changed under
   it. A new version is a new directory. Rollback moves a pointer.
4. **One coordinator.** Exactly one process decides accounts, placement and which
   process drives which native session. Many processes may do the work.
5. **Structural fixes beat cleanup.** When something regrows, the system reports
   the configuration that causes it instead of only clearing it again.

## Phase 0: safe upgrades

### Split Loom into a coordinator and session hosts

- **Session host.** A small process per open session. It owns the Agent SDK
  `query()` (or the Codex app-server connection) and the harness process group.
  It talks to the coordinator over a Unix socket, numbers every event, and keeps
  events until the coordinator acknowledges them. It contains no scheduling,
  storage or HTTP code, so it rarely changes.
- **Coordinator.** Today's Loom minus the harness drivers: store, commands,
  change log, HTTP/SSE, account pool, worktrees. It may restart at any time. On
  start it finds the running session hosts (from the ledger), reconnects, and
  replays unacknowledged events from each host's last acknowledged sequence.
  Clients already resume SSE from a sequence number, so a coordinator restart is
  invisible to them.
- Session hosts are not children of the coordinator. They are started detached
  and supervised by the service manager, so a coordinator crash leaves them
  running.
- The single-owner lock stays. It guarantees one coordinator, not one process
  touching the files.

### Releases

- `npm run release` builds into `~/.tango/releases/<version>/` (git sha plus a
  build counter). That directory is never written again.
- `~/.tango/releases/current` points at the active release. A coordinator
  restart starts from `current`.
- Each session host records the release it started from. Each thread records the
  release of its current session host and of every run (shown in Details).
- **Session hosts upgrade at a safe point.** A host moves to `current` when its
  thread has no running turn, no running background task and no open question.
  The coordinator ends the old host and opens the native session on a new one,
  the same path an account move already uses. The move costs a few seconds (MCP
  servers restart) and happens only when a newer release exists.
- **Maximum age.** A timer checks hosts on a superseded release. A host older
  than the configured limit (default 6 hours) is moved as soon as no foreground
  turn is running, even with background tasks running and even if no further
  turn would end on its own. The thread gets a wake run that says which tasks
  were cut off. This stops one long watch loop from keeping an old release alive
  indefinitely.
- **Protocol versioning.** The socket protocol carries a version. A
  coordinator supports every protocol version that a live host still speaks.
  A release that would drop support for a version is refused while any host on
  that version is alive. In practice the protocol changes rarely, and the
  maximum-age rule drains old hosts within hours.

### Canary and rollback

- A new release is first marked `candidate`. It gets one canary thread that runs
  the live smoke checks (the existing `live-claude.ts` checks plus a resume and
  an interrupt). Only a passing candidate becomes `current`.
- `tango release rollback` points `current` at the previous release. Hosts on the
  bad release move back at their next safe point, or at once with `--now`.
- A thread can be pinned to a release, for debugging or for testing a candidate
  on one thread.

### Bootstrapping

Phase 0 ships through one maintenance window with nothing running, because the
current Loom cannot yet upgrade itself without killing turns. Every later phase
is built by parallel threads and deployed without interrupting anything,
including the threads doing the building.

## Phase 1: recovery

- **In-flight ledger.** Every long-lived unit gets a row: turns, background tasks,
  monitors, scheduled wakeups, subagents, watched PRs, dev servers. Each row
  names its owner thread, its host, when it started, and how to resume it. The
  session host reports background task start and finish events from the
  harness.
- **Recovery pass.** After any crash, the coordinator walks the ledger. For each
  unfinished row it either resumes it (a turn: continue where you left off; a
  watcher: re-arm) or marks it lost and tells the owner thread exactly what was
  lost.
- **Side-effect log.** Outward-facing actions (push, PR comment, Slack or
  Discord post, email, deploy) are logged with an intent row before the call and
  a result row after it. A logged call is not proof the effect happened, so
  recovery does not simply tell the resumed turn "this already happened":
  - **Result recorded:** the turn is told the action completed, with its result.
  - **Intent without result:** the action may or may not have happened. Where
    the action can be checked (a pushed ref, a PR comment, a posted message
    found by an idempotency key in its text or metadata), recovery checks before
    the turn resumes and reports what it found. Where it cannot be checked, the
    turn is told the outcome is unknown and must verify before retrying.
  - Tools Tango owns attach an idempotency key to each call, so a retry with the
    same key is a no-op on the receiving side wherever the service supports it.
- **Worktree checkpoints.** At each turn end, the host records the worktree's
  uncommitted state as a commit on a private ref
  (`refs/loom/checkpoints/<thread>`) without touching the index or the branch. A
  crash, cooling or move to another machine never loses files.
- **Timeline.** One history per thread across hosts, releases, accounts and
  machines: what started, finished, failed or was cut off, and where. Built from
  the change log and the ledger.
- **Recovery drills.** A test profile runs threads through `kill -9` of the
  coordinator, a session host and a harness at random points, and checks that
  each one recovers. Runs on every release candidate.

### Waits and triggers

Triggers ship in phase 1, beside the ledger: a trigger is a ledger row that
knows how to wake its owner. Waiting threads then hold no process even before
the phase 2 eviction rules exist.

Waiting is a record, not a process. An agent that would hold its turn open or
run a watch loop instead registers a trigger, ends its turn, and cools. The
trigger service runs in the coordinator, evaluates triggers without any agent
running, and starts a wake run when one fires.

- **Kinds.**
  - **Time:** at a moment, or on a schedule.
  - **Condition:** a check that runs cheaply on an interval. Built-in checks
    cover the common cases (PR review state, CI result, merge, a URL answering, a
    Linear issue's state, a file appearing). A custom check is a command with a
    time limit whose exit status says whether the trigger fires. No model runs
    for a condition unless the check is explicitly marked as needing one.
  - **Event:** a webhook, mail from another thread, a process exiting, a
    background job finishing, another thread's run ending.
  - **Owner:** a reply or a tap. This already exists.
- **The agent's tool.** `wait_for(trigger, timeout, note)` registers a trigger
  owned by the thread. The note is the agent's own instruction for its future
  turn ("when CI is green, merge and deploy"). It comes back in the wake run with
  the firing details. Ending a turn with an active trigger is the expected way to
  wait. The harness's in-process waits (sleep loops, monitors, self-scheduled
  wakeups) are steered to `wait_for` when the thread runs on Loom.
- **Thread-free routines.** A trigger can also start a fresh thread from a
  prompt, with no thread waiting: a daily product-feedback check, a sweep for PRs
  ready to merge. This absorbs Tango's schedules, Claude routines and cron-style
  launchd jobs into one place. A routine whose run finds nothing ends quietly
  and adds nothing to the Inbox.
- **Rules.**
  - Every trigger has an owner and an expiry. On expiry, the owner thread wakes
    and is told the wait timed out.
  - Triggers are durable. After a restart they are evaluated again. A time
    trigger missed while the system was down fires once, late, not once per
    missed interval.
  - Identical conditions are polled once, however many threads wait on them.
  - The Desk's Watching view lists a thread's live triggers in plain words
    ("waiting for review on PR #N"), so a waiting thread says what it waits for.
- **Instructions to update.** Agent guidance that says "never end a turn while
  work is in flight; hold the turn" becomes "register a trigger and end the
  turn" for threads on Loom. The `watch` skill and the Desk's `watch-pr` become
  front ends for the trigger service.

## Phase 2: resources

### Leases

Every resource is registered when it is created, with an owner and a reclaim
policy:

| Resource | Owner | Reclaimed when |
|---|---|---|
| Session host and harness process group | thread | thread cools, is archived or deleted |
| MCP server processes | session host | the host ends (process group) |
| Worktree | thread | thread done and branch merged or abandoned |
| Dependency install (`node_modules`) | worktree | worktree idle past the limit |
| Build caches (`.next/cache`, `.turbo`, `dist`, `.expo`, per-checkout package caches) | worktree | always safe when no build is running in that worktree |
| Browser automation session and its profile | run | the run ends |
| Dev server and its tailnet mapping | thread | thread cools or ends |

Resources the system did not create (worktrees made by hand or by other tools)
are adopted as **unowned** and only reported, never reclaimed automatically.

### Warmth tiers and eviction

A thread is idle when it has no running turn and nothing that needs its process:
no running background task and no open question. A thread waiting on a trigger
(see "Waits and triggers" in phase 1) is idle. How idle a thread may become is set by how
fast and how safely it comes back, not by a fixed timer.

| Tier | What is kept | Typical restore |
|---|---|---|
| **Warm** | session host, harness, MCP servers | instant |
| **Cool** | worktree, dependencies, checkpoint, transcript | seconds (new host, MCP servers start) |
| **Cold** | worktree source and checkpoint; dependencies and build output dropped | a hardlinked reinstall, then cool |
| **Archived** | branch, checkpoint ref, transcript; worktree removed | re-provision, then cold |

- **Eviction follows pressure, like a page cache.** Idle threads stay warm while
  the machine is within budget. When memory, disk or the host limit is crossed,
  the least recently used idle threads drop one tier. A short floor (default
  10 minutes) keeps a thread warm right after its turn, since the owner often
  replies quickly. Nothing is evicted without pressure.
- **Restore before the owner needs it.** Opening a thread in the Desk, starting
  to type in its composer, or a trigger about to fire starts restoring it to
  warm, so the reply usually lands on a ready host.
- **Restore time is measured.** Each restore records its tier and duration. The
  resources view shows them, and the eviction floor and tier limits are tuned
  from those numbers.
- **Idle threads upgrade for free.** A thread restored from cool or colder starts
  on `current`. The more aggressively threads cool, the less often the phase 0
  maximum-age rule is needed.

### Worktree lifecycle

- **Provisioning** creates the worktree, installs dependencies, and restores
  gitignored setup files (such as `.env`) from the secret store using a per-repo
  descriptor kept in the profile layer. Because setup is reproducible, removal
  is cheap.
- **Shrinking an idle worktree.** Past the idle limit, the system drops
  dependencies and build output. The next turn reinstalls before it starts. The
  check is "no live process for this thread", read from the lease table, not
  guessed from timestamps or `lsof`.
- **Removal.** Removal requires a clean checkout and proof that its current head is merged,
  including for settled, stopped, and deleted threads. An unavailable PR lookup
  fails closed even when local ancestry is available. The worktree is removed
  after a final checkpoint and fresh activity checks. Commits survive
  removal because linked worktrees share the main object database. Unowned
  worktrees are still a human decision.

### Machine budget and admission

- Each machine declares limits: concurrent session hosts, memory pressure, swap,
  minimum free disk, load.
- New work that would cross a limit queues, or goes to another machine
  (phase 5). It does not start and slow everything down.
- When free disk crosses a threshold, reclaim runs early, cheapest first: build
  caches, then idle dependency installs, then cooling idle threads.

### Measuring

- Disk is measured with `df` deltas, not `du`, because `du` counts hardlinked
  installs once per invocation and over-reports shared dependency trees by about
  50 times.
- The resources view shows each machine's disk, memory, swap and load, each
  thread's leased resources and their cost, and the reclaim log (what was
  reclaimed, when, why, and how much it freed).

### Regrowth findings

Some growth comes from configuration, and clearing it only buys time. The
resources pass checks for known causes and reports them as findings instead of
clearing again and again:

- a dependency linker that copies a full tree into every checkout instead of
  hardlinking to a shared store;
- a missing home-level hardlink setting, or a repo setting that disables the
  global package cache;
- unbounded task caches with no size cap or remote cache;
- `patch-package`-style post-install writes that would corrupt a shared hardlink
  store (the fix is the package manager's native patch protocol).

Repo-specific checks live in a per-repo descriptor in the profile layer, so the
engine stays generic.

## Phase 3: Tango Server and Tango.app

- **Tango Server** is the supervisor. It reads a service list: each service's
  command, dependencies, health check, restart policy and resource budget. It
  replaces the scattered launchd jobs, the tmux-hosted bot and the separate
  healthcheck job. It runs headless, starts at login, and survives the app
  quitting and the owner logging out.
- **Tango.app** is a client and control panel: start and stop Tango, each
  service's health and logs, maintenance mode ("finish current turns, start
  nothing new"), releases with rollback, and the resources view. Quitting it
  never stops agents. It manages the external `com.tango.tango-server` user LaunchAgent with
  `launchctl bootstrap`/`bootout`; the obsolete `SMAppService` registration is retired.
- **Permissions.** A signed app bundle holds the macOS privacy grants (Full Disk
  Access, Documents, Automation) once, and the server it launches inherits them.
  Today processes inherit grants from whatever started them, which has caused
  repeated silent hangs when a process started from a context without the grant.
- The Desk stays a web client of the server, so phones, iPads and other machines
  keep working.

## Phase 4: Tango agents on Loom

The production bot's agent turns run through Loom like coding threads. A bot
restart or deploy no longer kills a turn, and Tango agents get warmth tiers, triggers,
recovery and the ledger. (Already tracked as TGO-976; this phase makes it depend
on phases 0 and 1.)

## Phase 5: more than one machine

Detailed implementation proposal: [Runners on other machines](remote-runners.md).

- **Runners.** Each machine (Macs, a VPS) runs a session-host agent and
  registers with the coordinator, declaring its capabilities: repos cloned,
  logged-in browser, macOS privacy grants, local models, hardware.
- **Placement.** A thread declares what it needs. The coordinator places it on a
  runner that has those capabilities and room in its budget. Work that needs
  this Mac (messaging, the logged-in browser, the health bridge) stays here.
  Headless coding and tests spill over.
- **Moving.** A worktree moves by pushing its checkpoint ref and branch and
  re-provisioning on the target. The native transcript moves with the shared
  project store.
- **Storage.** The coordinator moves to Postgres when a second machine runs
  threads, since several machines writing shared state is what Postgres is for.
  Until then SQLite stays, continuously replicated off the machine (for example
  with Litestream) so a dead disk is recoverable.
- **Cloud fallback.** When this Mac or its connection is down, threads marked
  critical continue on a remote runner and sync back.

## Thread roles

Every thread has a **role**: its conversation type in the spaces model
([spaces.md](spaces.md)). Runtime policy and the Desk both read it. Nothing
infers it from the thread's words.

| Role | What it is | Who hears from it | Runtime policy (later phases) |
|---|---|---|---|
| `interactive` (default) | A conversation with the owner. | The owner. | Normal warmth; owner-facing instruction overlay. |
| `worker` | Spawned to do one job (a playtest, a Codex implementation run). | Its parent thread. The owner only when the parent is gone or done. | Cools right after its turn (no warm floor); archived when its parent finishes or its branch merges; dispatched-worker instruction overlay. |
| `ops` | A standing job (feedback monitoring, PR operations), always owned by an agent or thread (Compass owns the acme desks). | Its owner. The owner's owner only through it. A run that finds nothing ends quietly. | Mostly trigger-driven routines; cool between runs. |
| `default` | A space's standing central chat (an agent's home chat, a project's lead thread). | The owner. | Kept warm while it has live workers; owner-facing instruction overlay. |

- **Every thread has an owner.** An interactive thread's owner is the person.
  A worker's or a desk's owner is the thread or agent that runs it. Agents and
  threads are the same kind of owner: once agents run on Loom, a repo thread
  and a Discord agent differ only in where they talk.
- **Fields.** A Loom thread has `role` (text, default `interactive`) and
  `parent_thread_id` (nullable): the owner's Desk id, qualified by where it
  lives (`loom:<id>`, `agent:<id>`, `agentctl:<project>/<task>`),
  because an owner need not be a Loom thread. Over the API: `role` and
  `parentThreadId` on the `submit` command that creates a thread, a `role`
  command that changes them, and both on the snapshot. A session opens with
  its thread's `role` (`OpenSessionOptions.role`).
- **Set at start, never guessed.** Start work and `tango-screen start --role`
  pass them; a thread started by another thread defaults to `worker` with that
  thread as its parent. The owner can change a thread's role later.
- **Workers outside Loom.** Codex workers dispatched through `agentctl` record
  `parentThread` in their task's `status.json`; the Desk reads those files and
  lists them as workers under that parent until Codex runs natively on Loom.
- **Routing.** A worker's or desk's question or failure goes to its owner
  first, and the owner decides what reaches the person. On the Desk they live
  in a Background view grouped by owner, out of Needs you. When the owner is
  finished or gone, they come to the person directly so nothing is stranded.
- Role picks the instruction overlay, the warmth policy and the reclaim rules
  above. A routine (phase 1 triggers) that starts a fresh thread per run starts
  it as `ops` (or `worker` with the routine's standing thread as parent).

## Open questions

- The warm floor and tier limits, once restore times are measured.
- Whether custom condition checks run on the coordinator's machine only or on
  any runner.
- Whether the session host should also own browser sessions, or the coordinator
  should lease them separately.
- Which side effects the harness reports reliably enough to log, and which need
  an explicit tool wrapper.
- How long checkpoint refs are kept after a thread finishes.

### Managed resource API

Loom records resource leases in its SQLite store. Records survive thread deletion
so orphan cleanup can retry after restart. `GET /resources` (authenticated) lists
leases and best-effort external process/mapping inventory. Name matches are
report-only and never establish ownership. Discovery failures are returned as
errors, not interpreted as an empty machine.

`POST /threads/:id/resources` accepts `{runId, kind, command, args}` during an active
run. The supplied run ID must match the active run; missing IDs return 400 and stale IDs
return 409 before any launch. Supported managed process kinds are `browser` (run end), `dev_server`
(thread cool, stop, deletion or finish), and `build` (retained until process exit).
This administrative endpoint uses the same bearer authentication as other Loom
commands; it is not exposed as a tool to isolated sessions. It rejects sessions
with `loomTools: false`. Commands must remain in the foreground and keep their
children in the supplied process group. Daemonizing or detaching children is
outside this API's ownership guarantee.

Creation starts a gated supervisor, persists its lease, then activates the
command. Losing the coordinator before activation exits the supervisor without
starting work; after activation the supervisor survives coordinator restarts.
Cleanup checks PID, start time, UID, process-group leadership and a random nonce
in the supervisor's argv. Unknown or changed identities are preserved. Command
output is private under the Loom home's `resources/<nonce>/output.log`; commands
inherit only PATH, HOME, TMPDIR, LANG and their thread identifier, not the
coordinator's credentials. Logs are bounded and retained until reclamation.

Unreclaimed process leases protect worktrees, including builds that outlive a
turn. Reconciliation runs at run end, cooling/stop, recovery and every minute.
A crash during cleanup is retried using the same identity. Browsers may request
`profile: "exclusive"` to create a fresh private profile;
its path is passed as `LOOM_BROWSER_PROFILE`. The profile identity records its
directory device/inode and an ownership marker. Cleanup follows confirmed
process-group absence and preserves changed directories or markers. Existing
profiles cannot be adopted. Managed children also receive their exact `LOOM_RUN_ID`.

The mapping backend supports only daemon-issued foreground Serve session identities.
It persists ownership before activation, verifies exact Serve status on cleanup,
and requires conditional session removal (ETag/If-Match) before closing the
nonce-verified watcher. Shared, changed, unknown and Funnel mappings are preserved.
The production adapter uses a dedicated foreground WatchIPNBus connection with
its daemon-issued session ID. It reserves the watcher before lease registration,
then publishes only after registration using a fresh Serve config and its ETag.
An occupied port is refused; unrelated Serve and Funnel fields are preserved.
Cleanup reads the current Serve configuration over LocalAPI, conditionally removes only the
owned session, and then stops the nonce-verified watcher. A missing session skips
the removal and still stops its owned watcher. Conflicts never trigger a retry
with stale configuration. LocalAPI credentials travel only in memory and IPC.

`POST /threads/:id/resources` also accepts `{runId, kind: "mapping", localPort,
httpsPort}`. It uses the same exact-run, isolation and worktree checks as process
creation. `loom resource dev-server -- <command> [args...]` and `loom resource
port <localport>` are the clients. Runtime turn context supplies an immutable
`LOOM_RUN_ID` to prefix on every invocation; no client resolves a newer run ID
from thread state. Missing/stale identities fail without an unleased fallback.
Dev-server requests must include the client's `process.cwd()` as `cwd`. The
coordinator resolves it with `realpath` and requires an existing directory equal
to or beneath the thread's owned worktree; outside paths, symlink escapes and
missing cwd fail without substituting the root. Other resource kinds retain
their existing cwd behavior.

`loom resource release <lease-id>` calls
`POST /threads/:id/resources/:leaseId/release` with `{runId}`. Only the current
active run of the owning thread may release a lease (including a prior turn's
lease). It uses the serial identity-checked cleanup backend; blocked or unknown
identity returns 409, while confirmed absence, including repeated release,
returns the reclaimed lease. Isolated sessions cannot release resources.

The port client assigns HTTPS port `10000 + localport`. Only an unchanged active
mapping already leased by this thread can be reused; external mappings are not
adopted. Reviewable private wrapper inputs are in `scripts/leases/`; deployment
and applying those inputs are separate operator actions. Isolated sessions and
shells outside Loom retain their existing commands.

`POST /threads/:id/resources` accepts `{runId, kind: "browser", managed: true}`
for the managed Chrome launcher. It reserves a loopback port, records that port,
its process identity, fresh profile and per-lease client session, then launches
Chrome in the leased group. Readiness verifies the listener's process group with
`lsof` and a loopback CDP version response; it never adopts another listener.
Failed launch/readiness releases the exact lease through the ownership backend.
The same active run can reuse its browser after fresh ownership checks. A new
run receives a separate browser/profile. Chrome and profile cleanup survive
coordinator restart through the durable run-end lease.

`loom resource browser -- <action> [args...]` and the optional `loom-browser`
wrapper invoke supported `agent-browser --cdp <port> --session <name>` commands.
They reject connection overrides and nested launch commands, ignore ambient
agent-browser configuration, and fail closed on missing/stale run identity.
Plain agent-browser launches are not managed. Its detached client daemon remains
report-only: Chrome lease cleanup does not claim or signal it. Supported exact
session `close` disconnects that client; no private daemon socket protocol is used.
See `scripts/leases/README.md` for the supported workflow and installation inputs.
Dependency and cache reclamation remains governed
by the worktree safety checks, now including process leases.

Managed creation trusts the loopback bearer token as host-level execution authority,
not a per-thread credential or a sandbox. Token holders can request commands for
eligible active threads; commands run with the coordinator user's OS privileges.
The API fixes cwd to the target thread's uniquely owned directory under the Loom
worktree root, rejecting external directories, shared cwd ownership and symlink
escapes. It rejects caller-supplied cwd and isolated sessions. This path restriction
is not filesystem confinement: trusted commands can access other paths themselves.
A missing supervisor only releases its lease once the entire process group is gone;
surviving members block cleanup because their leader identity cannot be re-proven.
Resource stdout/stderr retains at most the first 1 MiB combined, discarding further
output while draining pipes. Reconciliation deletes logs after confirmed reclamation,
including when a process exited independently. Blocked leases retain their bounded logs.

### Disk-pressure shrinking and cold restore

The minute warmth check starts an independent, serialized disk pass below
`LOOM_MIN_FREE_DISK_GB` plus 5 GiB (default trigger 25 GiB), before admission blocks. Pressure passes take priority before or between lifecycle rows; an in-flight row
finishes first. Reclaim tasks remain globally serialized and retain per-thread
mailboxes, without holding admission behind filesystem scans. A lifecycle timer
tick logs a skip if any lifecycle pass is already running or queued; explicit
reclaim requests still queue. Filesystem and command calls share a two-call limit;
requests that time out retain their slots until the underlying call settles, so
retries cannot grow an unbounded native request backlog. Checks and mailbox work
have a 30-second deadline. A timed-out row is kept with `inspect timed out`.
A five-minute pass watchdog logs `pass stalled`, abandons further work, and
releases scheduling guards for the next pass. Abandoned contexts cannot start
new IO; already-issued mutations retain their mailbox until they settle, even
though other rows can proceed. Recursive unlinking is sequential. A JavaScript
timeout cannot undo an already-issued filesystem operation.
Running passes write a heartbeat every minute on a separate logging lane, without
waiting for the scan queue. Completed lifecycle logs record `durationMs`,
`queuedMs`, and the five `slowestRows` (thread and duration). Row durations include
mailbox wait and filesystem work, excluding time yielded to pressure; total pass
duration includes those yields. The
existing `LOOM_WORKTREE_RECLAIM=on` switch enables mutation; otherwise the pass
records plans in `reclaim.log`. A pressure episode ends at the trigger plus 2 GiB. Successful passes
wait at least a minute; dry runs, failures and passes without measured progress
back off five minutes. Each pass removes at most eight target directories.

Candidates are ordered by last completed turn, with the existing warm floor
(default ten minutes). Cold build caches go first, then cold dependency installs.
Pressure removes only `.turbo`, `.next/cache`, `.expo`, and dependencies; it preserves `dist` outputs. Dependency shrink invalidates the root install stamp before unlinking, so partial or interrupted passes cannot masquerade as complete installs on restore.

Only if disk remains low may an eligible idle session with regenerable targets
cool; after it exits, process and ownership checks run again before shrinking.
Cooling a host with no reclaimable targets is not a disk remedy. Active or queued
turns, open questions/briefs, background work, resource leases, unknown process
ownership and external cwd processes prevent shrinking. A durable wait alone
permits this source-preserving shrink, but still blocks whole-worktree removal.

Pressure never removes source, checkpoint refs or whole checkouts, and leaves
unowned directories alone. It retains tracked output and nested repositories.
Disk availability is re-read between unlink batches; reported savings are the
filesystem available-byte delta, not the sum of directory sizes (APFS clones may
free little or nothing). A restore marker is persisted before unlinking dependencies, so an
interrupted pass remains recoverable. Whole-worktree archival rules are unchanged.

Both archived and shrunken worktrees try the existing lockfile/freshness-checked
copy-on-write dependency seed from their repository, sibling checkouts and warm
pool before installing. A matching usable seed skips installation; a missing or
failed clone falls back to the repository's package manager (`npm ci` with an npm
lockfile). Tracked dependency files prevent automatic restore. Failed installs leave the restore marker for retry and add a note to
the resumed turn. Clone writes remain isolated from the donor checkout.
