# Runners on other machines

Implementation proposal extending [Resilient runtime](resilient-runtime.md#phase-5-more-than-one-machine).
This document defines the implementation contracts, not permission to deploy,
copy private data, provision credentials, or buy infrastructure. Approval and
execution tracking belong to Linear TGO-1016. Each stage below can ship separately;
remote execution stays disabled until its prerequisites pass.

## Existing boundaries

The Studio runs the coordinator, local session hosts and CI. The existing mini
[test pool](../../scripts/dev/test-pool.mjs) copies test inputs over SSH and uses
an isolated HOME without secrets. Both Macs are trusted, owner-controlled
machines on the local network. Recovery copies on the mini are approved; production remote execution still waits
for the technical prerequisites below. CI remains on the
Studio; this design does not change GitHub runner registration.

Relevant current implementation:

- [remote-runtime.ts](../../packages/loom/src/remote-runtime.ts) connects to local
  Unix sockets despite its name; it is not a network runner client.
- [host-protocol.ts](../../packages/loom/src/host-protocol.ts) provides versioned
  hello, numbered events, replay and acknowledgements. The
  [session host](../../packages/loom/src/session-host.ts) retains important events
  in memory and writes a pending file on a terminal-session timeout. This is not
  a durable network spool; process death can lose unacknowledged events.
- [store.ts](../../packages/loom/src/store.ts) uses synchronous SQLite WAL, with
  direct SQL consumers in the ledger and other modules. Postgres requires an
  asynchronous repository boundary, not a connection-string replacement.
- [worktrees.ts](../../packages/loom/src/worktrees.ts) checkpoints tracked and
  nonignored untracked changes using a temporary index and a private Git ref.
  It does not preserve the user's staged/unstaged distinction or ignored files.
- [Claude project store](../../packages/loom/src/claude/project-store.ts) shares
  transcripts through local hardlinks and cwd-derived slugs. The
  [Codex runtime](../../packages/loom/src/codex/codex-runtime.ts) can start a new
  native session with carried context when the original rollout is unavailable.
  Neither behavior establishes cross-machine native resume.

## Invariants

One coordinator schedules work; one assignment owns a thread at a time. Runners
never open the shared SQLite file and never write application tables directly.
An unreachable runner is not proof that its processes stopped. No new owner
starts until the old one is fenced or its termination is independently proved.
A capability claim is not a credential grant or permission to export data.
Unknown requirements fail closed and remain queued with a visible reason.

Availability is deliberately limited: the first remote-runner release tolerates
an executor failure, not loss of the Studio coordinator or the site's network.
Backup restoration is disaster recovery, not automatic failover. Remote critical
work during a site outage requires the later independent control plane.

## 1. SQLite replication and recovery, before remote threads

Approved destination: a dedicated replica directory on the mini, reached over
ordinary SSH with host-key checks. Keep actual hostnames, paths and account names
in the private deployment profile. No separate restricted backup identity is
required for these two trusted machines. Offsite backup is deferred.

Concrete steps:

1. Inventory the coordinator database and every recovery dependency: native
   transcripts and companion files, attachments, Git objects reachable from
   branches and checkpoints, repository descriptors, release/schema identifiers,
   and configuration references. Record coverage and exclusions in a manifest.
   Do not include browser profiles or raw credential files in the data archive.
2. Pin and verify a Litestream release supporting SFTP and host-key verification.
   Run it as a separately supervised service against the live SQLite WAL database,
   with a five-second sync interval and seven-day recovery history. It does not
   launch or restart the coordinator. Set a disk budget; alert and stop new
   admissions before replica lag or WAL growth can exhaust the source disk.
3. Measure last successfully replicated transaction time, not merely process
   health. Target at most 60 seconds database loss under healthy connectivity;
   alert after two minutes without progress while writes occur. Network loss
   suspends this objective and must be shown explicitly. Retention never deletes
   the last known restorable generation.
4. At completed turns and at least every five minutes while active, publish
   immutable, checksummed recovery bundles for the files above. Capture a stable
   transcript prefix and native metadata using provider-specific adapters.
   Publish the bundle before committing its manifest pointer. Preserve earlier
   complete bundles if an upload fails. Mark work with no complete bundle as
   not recoverable; database replication alone must not imply otherwise.
5. Restore into an isolated profile on the mini, with outgoing tools, schedules
   and triggers disabled. Use a fresh database path, run `integrity_check` and
   `foreign_key_check`, verify referenced blobs/Git objects, compare a synthetic
   committed marker against replica lag, and open a fake thread with pending
   input, trigger, attachment and checkpoint. Demonstrate resume from its complete
   bundle. This protects against Studio failure, not loss of both machines or
   their site.
6. Drill after initial setup, every restore-format upgrade and monthly. Target
   a database restore within 15 minutes and a ready sandbox thread within 30
   minutes at the measured dataset size; these are acceptance targets, not an
   uptime promise. Record actual loss and duration. A failed drill blocks claims
   of recoverability and retention tightening, but does not stop live threads.

Litestream uses one replica on the mini. No offsite snapshot workflow or Age
encryption step is part of this stage. See
[replica configuration](https://litestream.io/reference/config/) and
[restore behavior](https://litestream.io/reference/restore/).

A database recovery selects the latest complete bundle per thread at or before
the restored database position. Later messages are preserved, but an interrupted
run resumes through recovery with its loss window disclosed. Outward actions
with intent and no confirmed result remain unknown until reconciled; a restore
must not resend them blindly. Credentials are reprovisioned from the secret
store. Required SSH access must be recoverable without the failed Studio.

## 2. Registration, transport and capability model

Introduce a small supervised runner daemon on each enrolled machine. It owns
local process groups, sessions, file transfer staging and budgets; the coordinator
owns policy, assignments and the shared timeline. Local Unix sockets remain the
session-host interface. A versioned channel over the private
network carries runner RPCs using the existing SSH trust between the two Macs.
Registration binds a stable runner ID and boot ID to the connection so recovery
and duplicate-run fencing identify the correct process owner. A separate trust
class or certificate enrollment ceremony is not required.

Registration includes runner ID, boot ID, protocol range, release hashes, OS and
architecture, repo IDs/revisions, available runtime versions, measured resource
budget, supported tools and timestamped health probes. Capabilities include
`headless`, `macos`, a named local model, a named repo, and local integrations
such as `browser:personal`, `messaging:local`, or `health:local`. Store these as
structured keys reflecting where tools actually work, not privacy trust classes.
Secrets and transcript contents are never registration fields.

Heartbeats every ten seconds include active assignments, free resources and
capability probe expiry. After three missed heartbeats stop placement, show the
runner unavailable and reconcile; do not immediately duplicate its work. Reserve
capacity atomically with assignment creation, and release it only after terminal
state or fencing. Both runner and coordinator enforce limits so a stale heartbeat
cannot overcommit. Account concurrency remains global across runners; an account
available on one machine is not assumed available on another.

Commands carry command ID, runner boot ID, thread ID, assignment epoch and
coordinator epoch. The runner persists command outcomes before replying, so
retries do not create another host. Persist host events before forwarding, and
acknowledge only after the coordinator's state and replay cursor commit together.
Deduplicate by `(runner, boot, host instance, sequence)`. Keep terminal outcomes
until acknowledged; ephemeral token deltas may be dropped when a completed
message supersedes them. Bound spool size and pause admission on pressure.

Keep runner protocol negotiation separate from the existing host protocol.
Every runner installs immutable platform-specific release artifacts verified
against a manifest; no mutable executable sync. Canary each platform, advertise
supported protocols, and preserve old releases until no host uses them. Existing
safe-point upgrades and maximum-age reporting remain; a maximum-age upgrade does
not override placement restrictions or authorize moving a thread across machines.

## 3. Placement and privacy

Both Macs are trusted owner-controlled machines. There is no per-session privacy
approval or data-classification gate between them. Placement requirements are
technical: repo ID, tools, OS, resource estimate, provider/account constraints
and optional criticality. Check the entire session/tool configuration and its
files for portability, not only the latest prompt.

| Work | Allowed placement after technical prerequisites pass |
| --- | --- |
| Tools tied to Studio browser sessions, macOS grants, local bridges or voice hardware | Studio until the tool is explicitly supported on the mini |
| Existing test pool jobs | Existing pool behavior unchanged |
| Headless coding and other portable sessions | Studio or mini; no per-session privacy approval |
| Cloud execution | Disabled; no cloud purchase approved |
| Custom command triggers | Machine where their paths and tools exist; existing commands default to Studio |

Filter by policy and capabilities first, then budget and account availability.
Prefer the existing healthy placement (avoids transfer), then Studio within its
budget, then mini. If none qualify, queue with the specific missing requirement.
Do not spill solely because a role is worker or a thread is marked critical.
Revalidate before every run and transfer. A newly required local tool blocks or
schedules a safe return; it cannot silently gain remote access to the Studio.
Browser sessions remain run-scoped resources on their allowed machine and are
never transferred with the thread. File-trigger paths likewise belong to a named
runner; disappearance of a runner is not a successful file condition.

Use ordinary filesystem permissions and SSH access on both Macs. Copy the
repository objects, transcripts, attachments and prompts needed for recovery;
there is no separate export-approval process between them. Credentials are
provisioned through existing account setup, not swept into recovery archives.
Browser state and machine-specific grants are not portable recovery files.

## 4. Moving work and native transcripts

Only move at a safe point: no foreground turn, live background task or open
question. Forced loss recovery is a separate operation recorded in the timeline.

1. Atomically mark the assignment draining; block new turns, steers and wakes
   from executing there while preserving them in the command log. Confirm the
   host's safe point and stop it. If termination is uncertain, do not proceed.
2. Produce a transfer manifest: source assignment epoch, repo/base/branch SHAs,
   checkpoint SHA, index snapshot (staged state), allowed untracked paths,
   native session ID/provider/version, transcript hashes, attachment hashes,
   session profile hash, source cwd mapping and last durable event cursor.
3. Export only necessary Git objects to a private runner transfer store, never
   push checkpoint refs to the team's origin. A git bundle or restricted bare
   repository holds branch and checkpoint refs. Preserve deletions, executable
   bits and symlinks without dereferencing paths outside the worktree. Detect
   dirty submodules, missing LFS objects, external symlinks and nonportable files;
   block the move unless a dedicated tested exporter supports them. Never claim
   the existing checkpoint captures these cases.
4. Provision from the target repo descriptor in a new staging worktree; restore
   branch, checkpoint and staged index independently. Reinstall dependencies for
   the target platform from the lockfile. Rehydrate only approved secret-store
   references; never copy `.env`, account homes, browser cookies or node_modules.
5. Import one session's transcript and companions, not an entire account store.
   Claude needs an explicit source/target cwd-slug mapping and native resume
   validation. Codex needs a tested rollout export/import adapter for the pinned
   runtime. Until a provider adapter passes, that provider's native sessions are
   pinned. Explicit restart with carried context is a different, visibly recorded
   action, never reported as native resume or silently substituted during a move.
6. Verify hashes, dependency readiness and provider resume in the gated target
   host without starting a user turn. Commit the new assignment epoch and
   manifest pointer in one transaction, then permit the target's first turn.
   Preserve queued input IDs and side-effect IDs so replay is idempotent.
7. Retain the stopped source and bundle for seven days and until a target turn
   succeeds. Then reclaim through existing ownership rules. On pre-commit
   failure, restart the source only after proving target termination; on
   post-commit failure recover the target assignment. Never merge two divergent
   transcript files by mtime. Quarantine both and choose an authoritative epoch.

## 5. Postgres before a second machine runs threads

Backup and registry-only releases may use SQLite. Production remote thread
admission requires the Postgres cutover; the existing stateless test pool does
not. Initially Postgres may run on the Studio, with independent backups. This
adds remote execution but deliberately does not solve Studio availability.

Move all store consumers behind asynchronous repository operations preserving
current transaction boundaries: commands, messages, runs, changes/SSE cursors,
triggers, ledger, decisions, leases and host event acknowledgements. Preserve IDs,
ordering and idempotency keys. Runners use the coordinator API only. Blob payloads
live in the approved versioned transfer store; Postgres holds hashes, ownership
and complete-manifest pointers. No network-mounted SQLite or native transcript
filesystem is the shared database.

Use one active coordinator with a dedicated Postgres advisory-lock connection,
plus a monotonically increasing coordinator epoch in durable state. Loss of that
connection stops admission and renewal immediately. Advisory locks alone do not
fence a stale executor: assignment epochs and runner fencing remain mandatory.
See [Postgres locking](https://www.postgresql.org/docs/current/explicit-locking.html).

Cutover procedure: test a full migration on a copy; enter maintenance admission;
drain active turns and hosts to a safe point; pause trigger evaluation; take and
verify a final SQLite backup; import all tables and sequence watermarks; compare
counts, checksums and referential integrity; start one Postgres coordinator with
outward tools disabled; verify replay and pending commands; then enable work.
Record maintenance duration. After Postgres accepts writes, SQLite is a frozen
backup, not an automatic rollback target. Reverse migration requires draining,
exporting the new writes and validating them; prefer forward repair. There is
no dual-write phase. Keep SQLite support for isolated local/test profiles.

## 6. Independent cloud fallback

Default: no new cloud purchase and no cloud execution. First prove mini placement,
restore and fencing. A later purchase proposal must name provider/region, monthly
cap, network and storage cost, backup retention, allowed data and credentials;
it must not treat a generic approval of this design as spending authority.

To survive loss of the Studio or its internet, put authoritative Postgres,
transfer storage, one active coordinator (with a standby) and required ingress
outside that failure domain. The mini at the same site alone is insufficient.
Use an approved private-network endpoint for clients; no public unauthenticated
control API. Critical threads require fresh offsite checkpoints, validated
provider resume and no Studio-only tool requirements. Proposed objectives after
an independent outage drill: resume eligible critical work within five minutes,
with at most 60 seconds of persisted state loss; report actual file-bundle lag
separately and never promise exactly-once external effects.

Automatic failover initially applies only to idle or confirmed-stopped hosts.
For active hosts, a lease timeout alone is unsafe: a paused process may wake
and use a credential. Require independent termination proof, or a validated
sandbox/egress fence that prevents the old epoch from invoking any side-effecting
tool, including arbitrary shell network access. Without that proof, leave the
thread blocked for reconciliation. Restricted cloud runners never receive broad
long-lived credentials that bypass fencing. Recovery reports uncertain external
actions and verifies them before retrying.

When the Studio returns it registers a new boot identity and reconciles epochs;
it must not replay old assignments or overwrite newer work. Move back only at
a safe point through the same transfer procedure. Postgres state stays canonical;
there is no bidirectional merge of databases or live worktrees.

## Failure matrix and required drills

| Fault | Expected behavior and verification |
| --- | --- |
| Coordinator restart | Hosts survive; replay resumes at committed cursor; duplicate event/command changes nothing |
| Runner crash or power loss | Mark unavailable; restore latest complete bundle after fencing; disclose missing work |
| Network partition or paused old runner | No double ownership; old epoch rejected after reconnection; active takeover blocked without fence |
| Postgres outage | Stop assignment/admission and effect authorization; retain bounded local spool; no SQLite fallback |
| Transfer interruption or bad hash | Target cannot run; source retained; resume transfer by manifest ID |
| Lost acknowledgement after target activation | Retry sees committed assignment and existing host, never starts another |
| Stale capabilities or account exhaustion | Revalidate and queue, without relaxing portability or account limits |
| Missing/corrupt transcript | Preserve evidence; pin/recover explicitly; no silent context-only substitution |
| Disk full or backup destination unavailable | Alert lag/space; throttle admissions; retain last good generation |
| Old release or incompatible native schema | Reject placement; preserve source and install compatible canaried release |
| Duplicate trigger or unknown external action | Unique wake/action identity; reconcile unknown effect before retry |
| Site outage | Only approved independent control plane can recover eligible work; local integrations remain unavailable |

## Shippable stages and acceptance boundaries

The numbered stages are dependency boundaries; live issue state and ownership
stay in Linear. Each implementation issue must include its own rollout, undo and
sandbox evidence. Production activation follows the parent's approved plan.

1. **SQLite replication and restore:** implement section 1 independently; require
   coverage inventory, replica-lag and space alerts, and an isolated mini
   restore drill. Offsite backup is deferred. No remote thread execution.
2. **Durable runner protocol and enrollment:** persistent event/command spool,
   version negotiation, machine registration and resource probes. Ship disabled
   registration/health first; fake-runner tests cover replay, revocation and
   budget races. No production remote thread execution.
3. **Postgres repository and cutover:** parity suite on SQLite/Postgres, concurrent
   command/trigger tests, migration/reverse-migration rehearsal and backup restore.
   Cut over only in an approved maintenance window; keep placement local.
4. **Portable checkpoint and transcript adapters:** fixture round trips covering
   staged/unstaged edits, deletions, attachments, changed cwd and provider resume;
   explicit rejection tests for unsupported exports. Each provider is enabled
   separately only after a real sandbox native-resume drill.
5. **Mini placement and safe moves:** requires stages 2–4;
   sandbox tests for policy denial, pressure, move interruption and epoch races,
   followed by one approved headless thread moved out and back. Validate global
   account limits and local-only tools staying local.
6. **Cloud recovery and failback:** separately approved provider/spend and data
   policy; independent control plane, fencing and site-outage drill. Record actual
   recovery time, data loss and uncertain external actions before enabling any
   critical thread. Deferring this stage does not block the preceding stages.

Owner decisions (2026-10-21): recovery copies go to the mini only; both Macs
are trusted owner-owned machines on the local network, with no per-session
privacy approval or extra trust ceremony; cloud purchases are deferred. The
design is approved, with only stage 1 scheduled for implementation now.
Stages 2–6 remain unscheduled. Live service activation still requires the
project lead's go-ahead after implementation review and merge.
