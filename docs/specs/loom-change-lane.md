# Loom change lane

Status: proposed 2026-10-24. Design only; nothing here is implemented.

How changes to the live Tango system (Loom and desk deploys, restarts, drains,
worktree reclaim and rebuilds) are serialized and bounded, so the owner's
threads never stall behind them.

This builds on [Resilient runtime](resilient-runtime.md) phase 0 (session hosts
survive coordinator restarts and move to a new release at a safe point) and on
the rollout procedure the Loom project lead uses today (build, canary, promote,
restart, 120 s health grace, 60 s stability, pinned rollback). It does not
change those mechanics. It adds one queue in front of them and removes the
global drains they no longer need.

## The problem

Two incidents in two days froze every owner thread:

- **10/23:** a recovery admission hold when the backup volume ran low (fixed in #1115).
- **10/24:** three global maintenance drains run by an agent while turning on
  worktree reclaim. Each one held every queued turn until the longest running
  turn ended, up to 13 minutes. #1135 now lets the owner's own message through
  after 2 minutes and raises an incident when it waits.

#1135 bounds the damage. The causes are still in place:

1. **Maintenance is global and has no deadline.** One agent's drain stops every
   thread. A drain waits for the slowest turn in the system, which has nothing to
   do with the change being made.
2. **Nobody serializes changes.** Several agents operate the same live system
   at once: reclaim enable and revert drains, config restarts, releases, desk
   deploys. There is no lock or queue. On 10/22 another agent's release went
   live between two releases in the same rollout, so the rollback target
   silently changed.
3. **Restarts are frequent.** Every merged Loom change becomes its own release
   and restart.
4. **Restarts and builds cost the machine the agents run on.** The cost is disk
   writes, git contention and timeouts.

## Measurements (2026-10-24, main Mac)

| What | Measured | Source |
|---|---|---|
| Loom promotes | 132 from 10/17 to 10/24; 23, 23, 29 and 27 per day on 10/19–10/22 | `~/.tango/releases/loom/state.json` history |
| Commits per promote | 130 distinct commits across 132 promotes: about one release per merged Loom change | same |
| Gap between promotes | median 27.6 min; 32 of 131 gaps under 10 min | same |
| Build to promote | median 10 s (canary uses the process fake) | same |
| Coordinator restarts, 10/24 01:32–13:51 UTC | 14 restarts for 8 promotes. The other 6 were config restarts and drains for reclaim enable and revert, plus one reboot | `~/.tango/loom/loom.log` `listening` lines |
| Turns lost to restarts | 0 on every restart except one (`interrupted=4 continued=4`), which matches the reboot at about 12:07 UTC (macOS reports 366 s since boot at 12:13) | `loom.log`, DiagnosticReports |
| Full `npm run build`, one checkout | 18–19 s wall, 33 s CPU, 820 MB peak RSS, about 16 MB of output. Cold and warm cost the same | `/usr/bin/time -l` on an APFS clone of the operator checkout |
| `deploy-desk.mjs` builds | 2 checkouts, so about 40 s and 66 CPU-seconds per deploy | from the line above |
| Loom release build | copies about 303 MB in 8,437 files per release with `fs.cpSync`, with no clone. That is about 8 GB/day of writes at 27 releases/day | release directory sizes; `scripts/release.mjs:89,118` |
| Coordinator writes, steady | 1.20 GB in its first 23 min (about 0.85 MB/s, roughly 75 GB/day), while the store logged only 446 change rows and touched about 66 rows | `proc_pid_rusage` on the live PID; read-only copy of `loom.sqlite` |
| `loom.sqlite` | 427 MB with 4 KB pages; `items` (tool output head and tail) is 303 MB of it | `dbstat` on the copy |
| Write bursts flagged by macOS | 4 Loom-coalition `node` reports on 10/24 between 04:19 and 05:13 PDT, each about 2.1 GB in 170–220 s (one was 8.6 GB in 325 s). Samples are in SQLite transaction commits and WAL checkpoints. One sample is a full `VACUUM`, which Loom's code never runs | `/Library/Logs/DiagnosticReports/node_2026-10-24-*.diag` |
| Checkpoint `git add` timeouts | 18 `git add timed out after 30 s` and 4 reclaim `inspect timed out` in the current `loom.log` | `loom.log` |
| Checkpoint index cost, idle acme worktree (19,987 files) | Fresh temporary index refresh: 3.75 s. Warm index: 0.03 s. `git status`: 0.25 s | `GIT_INDEX_FILE` scratch index on `acme/loom-0277d8ae`, read-only |
| Loom worktrees | 173 (acme 43, side-studio 10, tango 120) | `~/.tango/loom/worktrees` |

What the numbers say:

- The build is not the expensive part of a deploy. The real costs are release
  copies, restarts and concurrent changes.
- The 10/24 write bursts all fell inside the reclaim-enable and revert window
  and the reboot. The 13:51 UTC start did not burst.
- The `VACUUM` sample shows that the `com.tango.loom` coalition includes session
  hosts and every process they start. A "Loom wrote 2 GB" report is therefore not
  proof that the coordinator wrote it.

## 1. One change lane

**Recommendation:** Tango Server owns a single lane. Every operation on the
live system goes through it, one at a time, across all agents.

- **Why Tango Server.** It already supervises Loom, proxies `/maintenance`,
  serves release rollback, and outlives a Loom restart. Loom cannot hold a lock
  across its own restart.
- **What counts as a change:**
  - Loom release promote or rollback
  - coordinator restart (including config or env restarts)
  - desk (`screen`) restart or deploy
  - `update-live-checkouts.sh`
  - a reclaim mode change
  - Tango app or Tango Server install
  - any drain
  - a reboot that agents trigger
- **Shape.** Each change is a lease, written as a row in Tango Server's state:
  `{ id, kind, holder thread, command, started, deadline, heartbeat }`.
  - `tango-server change run --kind <kind> --deadline 15m -- <command>` waits
    in a FIFO queue, runs the command while holding the lease, and releases it
    on exit.
  - The holder heartbeats. A lease whose holder process is gone is released
    automatically.
  - A holder past its deadline raises a critical incident and blocks the queue.
    The lease is not taken over, because an unfinished change may have left
    things half done.
- **Enforcement, not advice.** `deploy-desk.mjs`, `release.mjs promote|rollback`,
  `tango-server restart loom|screen`, `POST /maintenance` and the app installer
  refuse to run without a lease, or take one themselves. Direct
  `launchctl kickstart|bootout com.tango.loom` is blocked by a guard hook, like
  the `pkill` guard from #805, with a message that names the lane.
  - Emergency override: `--break-lane --reason` is logged and raises an incident.
- **Release train.** Merges to main mark Loom as "release pending". They do not
  each restart it.
  - The lane runs one train at most every 60 minutes, with whatever has merged.
    Today's gaps have a median of 27 minutes, so this roughly halves restarts.
  - Two exceptions board the train at once: a rollback, and a fix the
    owner or project lead marks `--urgent`, which stays logged.
  - Non-urgent coordinator restarts are capped at 12 per rolling day. Past the
    cap, the train waits for the next day's window unless it is urgent.
  - The rollback target is pinned when a train starts. Nobody else can promote
    in between, which removes the 10/22 race.
- **On the desk:**
  - The System page gets a "Change lane" card: the holder (linked to its
    thread), its kind and elapsed time against the deadline, the queue, and the
    next train time with what is aboard.
  - A thread waiting for the lane shows "waiting for the change lane (2nd)" as
    its busy reason. It is not shown as Needs you.
  - Each change posts one feed event when it starts and one when it finishes.
  - An overrun deadline is a critical System incident on the owner's row, like
    the #1135 owner-wait incident.

## 2. Scoped drains with a deadline, instead of global maintenance

Session hosts survive coordinator restarts: the 10/24 drained restarts kept all
485 native session IDs, and so did the controller's own running turn.

Most operations need no drain at all. A drain only protects the code a running
turn is using, and coordinator restarts do not touch that code.

| Operation | Drain needed? |
|---|---|
| Loom promote, rollback, coordinator restart | **None.** Hosts reattach. Hosts move to the new release at their own safe point (resilient runtime). |
| Config or env change (for example `LOOM_WORKTREE_RECLAIM`) | **None.** A plain restart. Better, make such flags settable at runtime so they need no restart. |
| Desk (`screen`) restart or deploy | **None.** Turns do not depend on it. |
| `update-live-checkouts.sh` | **None.** Loom runs from immutable release directories, not from the checkouts. |
| Reclaim, park or restore of a worktree | **Scoped to that thread or worktree.** The existing holds (running run, open request, live host, cwd process) already gate it. |
| Session host protocol break, or a host-side runtime upgrade | **Per host**, at its safe point. Never global. |
| Tango Server or app install | **None for Loom turns.** It is a supervisor restart. Services with their own idle gate (the Discord bot's `wait-bot-idle`) keep that gate. |
| Moving or restoring `loom.sqlite`, an incompatible state migration, a reboot | **Global.** This is the only class. It is rare and needs the owner. |

**Recommendation:**

- **Scoped drains.** `POST /drains { scope, reason, deadlineMs }`, where scope is
  one of `thread`, `worktree`, `repo` or `account`, holds dispatch only for
  matching threads.
  - Default deadline 10 minutes, maximum 30. On expiry it lifts itself and posts
    an incident.
  - It never holds the holder's own run. This fixes the 10/24 deadlock, where
    `running` counted the controller's own turn.
  - The owner's own message keeps the #1135 two-minute bound inside any scope.
- **Global maintenance stays for the last row only.** It needs a lane lease and
  a deadline (default 15 minutes, maximum 60). On expiry it lifts itself and
  posts an incident.
  - A global drain stops waiting for long turns. It waits only for turns that
    started before it, and a turn running past the deadline is reported, not
    waited on.
  - An agent cannot open a global drain without a recorded owner approval in
    the lease.
- **Routine procedures change.** The lead's reclaim and rollout procedures drop
  their "maintenance on, wait for zero running" step. The step is replaced by
  "take the lane, restart, check `interrupted=0`".
  - If a restart reports `interrupted>0` without a reboot, the lane pauses the
    train and raises an incident, because host survival broke.

## 3. Build cost

The measurements change the question. Two full builds take about 40 s and 66
CPU-seconds per deploy, which is small. The costly part is what surrounds them.

**Recommendation, in order of value:**

1. **Clone, don't copy, release files.** `release.mjs` copies the dependency
   closure with `fs.cpSync`, which writes about 303 MB per release.
   - Use APFS clones instead: `cp -c`, or `copyFileSync` with `COPYFILE_FICLONE`.
     Also hardlink files that are unchanged from the previous release.
   - This saves about 8 GB/day of writes at today's cadence, and the release
     train cuts the count as well.
2. **Run builds inside the lane at background priority** (`taskpolicy -b`), so a
   build never competes with an agent's git or I/O. One deploy builds at a time.
3. **Build only changed workspaces.** In `update-live-checkouts.sh`, use
   `git diff --name-only old..new` and the workspace dependency graph, falling
   back to a full build on a lockfile change. This is nice to have: it saves
   most of the 40 s.
4. **Not now: building on the Mac mini or a CI runner.** The minis are already
   CI runners, but a remote build needs the same Node ABI and a verified
   artifact transfer. That belongs with [remote runners](remote-runners.md),
   which gives little at 40 s per deploy. Revisit if builds grow.

## 4. Coordinator write bursts and git timeouts

**Git checkpoint timeouts: cause found; fix in a follow-up.**

- `checkpoint()` (`packages/loom/src/worktrees.ts:722`) builds a brand-new
  temporary index from `read-tree HEAD`. That index has no stat cache, so
  `git add -A` rehashes every tracked file on every turn end. On an idle
  20k-file acme worktree that costs 3.75 s, against 0.03 s with a warm index.
  Under deploy or reclaim I/O it crosses the 30 s timeout.
- **Fix:** seed the temporary index by copying the worktree's own index, so
  stat data is reused. Then `read-tree HEAD` is unnecessary and `add -A` only
  hashes what changed.
- This is a small Loom PR, independent of the lane.

**Reclaim inspect timeouts: they stay with the reclaim worker.** The resource
follow-ups thread (`loom:aa64d86b`, commit 47bc9630) is already fixing them: it
turns off repo hooks during park and rollback, and removes a hidden 30 s mailbox
timer.

**Coordinator write volume: partly measured; root cause not proven; follow-up.**

- **Steady state.** About 0.85 MB/s against a handful of logical changes points
  to SQLite write amplification. Each commit rewrites whole `items` rows, with
  their output overflow pages and index pages, into the WAL, and then the
  checkpoint writes them again.
- **Bursts.** The bursts coincide with drains, reclaim passes and a post-reboot
  recovery, not with ordinary promotes. At least one flagged process was not
  the coordinator.
- **Follow-up:**
  - Add per-transaction page counts and per-PID write bytes to `/machine.stall`,
    so the next burst names its writer.
  - Stop rewriting unchanged `items` output columns.
  - Measure WAL checkpoint frequency.
- The lane helps without that work: fewer restarts, fewer drains and one
  reclaim change at a time all remove burst triggers.

## Phased plan

| Phase | Ships | Done when |
|---|---|---|
| 0. Stop the bleeding (procedure only) | The project lead's rollout and reclaim procedures drop the global drain for restarts and check `interrupted=0` instead. One agent at a time runs live ops, by convention. | The next reclaim enable runs with no maintenance window. |
| 1. Lane | Lane leases and queue in Tango Server. `tango-server change run`. `deploy-desk.mjs`, `release.mjs` promote and rollback, restart paths and the installer take the lease. Guard hook on direct `launchctl`. Desk System card and busy reason. | Two agents' deploys started together run one after the other; the desk shows the queue. |
| 2. Scoped drains | `POST /drains` with scope and deadline; global maintenance needs a lease, approval and a deadline, and lifts itself on expiry; holder runs are excluded. | A drain on one worktree leaves other threads dispatching; an expired drain lifts itself and posts an incident. |
| 3. Train and cost | Hourly release train, the daily restart cap, pinned rollback per train, APFS-clone release copies, builds at background priority. | Restarts are 12 or fewer a day; release build writes are under 10 MB. |
| Follow-ups (separate PRs) | Warm-index checkpoints. Write attribution in `/machine`, then the `items` write-amplification fix. Runtime-settable Loom flags. Changed-workspace builds. | Zero checkpoint timeouts in a week. |

## Decision: routine restarts don't drain

Decided 2026-10-25 by the owner: option A
([TGO-1194](https://linear.app/example-hq/issue/TGO-1194)). Routine Loom
promotes, rollbacks and config restarts take the change lane and never drain. A
restart that reports `interrupted>0` outside a reboot pauses the release train
and raises an incident. A scoped drain with a deadline (option B) and global
drains with no deadline (option C) were both rejected. Section 2 records the
design.
