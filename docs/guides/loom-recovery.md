# Loom recovery on the mini

`scripts/recovery/loom_backup.py` is an opt-in, standalone backup supervisor.
It does not install a LaunchAgent, restart Loom, start a provider, or execute
triggers. Activate it against the live database only after the project lead's
post-merge go-ahead. Stage 1 uses the mini only; no offsite copy or cloud service.
Both Macs are trusted owner-controlled machines on the local network.

## Prepare

Use Python 3.9+, Git, rsync and ordinary SSH access on both Macs. Install
Litestream 0.5.17 on both with `python3 scripts/recovery/install-litestream.py
NEW_DIRECTORY`. The installer pins the Apple Silicon archive checksum; it never
overwrites an existing installation.

The mini uses one stable root (`remote_root`, for example `~/loom-recovery`):
`<remote_root>/bin` holds the tooling (`loom_backup.py`, `check-drill.py` and the
`litestream` binary) and `<remote_root>/destinations/<YYYYMMDDTHHMMSSZ>` holds the
dated replicas. With `remote_root` set, `remote_script` and `remote_litestream`
default to `bin/loom_backup.py` and `bin/litestream`, and the destination must be
a generated dated folder under `destinations`. Tooling never lives inside a
destination (the config is refused otherwise), so pruning replicas cannot delete
it. Copy `loom_backup.py` and the Litestream binary into `<remote_root>/bin`.
Keep all actual paths, hosts and public-key values in a private JSON config
outside Git:

```json
{
  "home": "/absolute/loom-home",
  "db": "/absolute/loom-home/loom.sqlite",
  "spool": "/absolute/backup-spool",
  "ssh": "operator@mini.example.invalid",
  "host": "mini.example.invalid:22",
  "user": "operator",
  "key_path": "/absolute/ssh-key",
  "host_key": "ecdsa-sha2-nistp256 REPLACE_WITH_VERIFIED_PUBLIC_KEY",
  "remote_root": "/absolute/loom-recovery",
  "destination": "/absolute/loom-recovery/destinations/20261023T213000Z",
  "litestream": "/absolute/local-litestream/litestream",
  "codex_session_roots": ["/absolute/account/sessions"],
  "release": "source-revision-or-release-id",
  "warn_free_bytes": 21474836480,
  "pause_free_bytes": 5368709120,
  "keep_previous_destinations": 1,
  "bundle_interval_seconds": 600,
  "probe_interval_seconds": 30,
  "restore_probe_interval_seconds": 120,
  "remote_keep_bundles": 3
}
```

The SFTP host key is pinned explicitly. Litestream's Go SSH implementation can
negotiate ECDSA even when OpenSSH previously used Ed25519. Retrieve the matching
public host key through the existing verified SSH connection; do not disable
host-key checks or trust an unauthenticated keyscan. Keep the JSON mode 0600. Use a fresh destination namespace when replacing the
source database; never point unrelated databases at an existing replica history.
Litestream replica files follow the mini SFTP writer’s umask and may otherwise be
0644: set its umask to 077 or restrict the replica directory to mode 0700.
Ordinary SSH must connect noninteractively. Use absolute destination paths.

## Inventory and bundle contract

`python3 scripts/recovery/loom_backup.py capture CONFIG` is read-only against
Loom and writes a local immutable bundle with a manifest. Review its completeness
and exclusions before activation. There is no account-home scan: Codex rollout
roots must be listed explicitly, with one matching rollout per native session. Current and prior native sessions
referenced by the thread and its attempts are inventoried; a missing referenced
transcript marks that thread as not recoverable. Other covered threads still publish.
Claude transcripts come from Loom's shared project store, including session
companions. JSONL captures only validated complete records of a stable prefix.
An active provider's missing or ambiguous transcript makes coverage incomplete;
this does not claim native provider resume support.

Each bundle contains a SQLite online-backup snapshot, schema hash, release label,
referenced attachments, transcript prefixes, and self-contained Git bundles of
repository refs (including Loom checkpoint refs and HEAD). Git records source
locations for later mapping. Ignored-file archives, credentials, browser state,
account homes, dependencies, and edits newer than existing checkpoints are
excluded. Repositories with submodules remain actual recovery gaps. Threads with
both an archive path and a non-null worktree removal timestamp are policy
exclusions, not capture errors. A restored worktree retains its archive path but
clears that timestamp, so it is required and captured normally. `coverage.covered`, `coverage.not_recoverable` and
`coverage.excluded_by_policy` enumerate covered threads, actual gaps and policy
exclusions separately. Excluded threads retain `complete: false` and are never
claimed recoverable. The aggregate `complete` flag means every in-scope thread
is covered; it does not gate publication. An optional private `excluded_threads`
config map associates exact thread ids with audited reasons (for example a
completed disposable test whose scratch repo was removed). Never infer exclusions
from an idle status, a temporary path or a missing file. Keep actual ids and
investigation evidence outside the repository. Explicit exclusions emit per-thread
manifest warnings when the current directory has Git metadata or the thread was
updated within the last 24 hours; these warnings request a fresh audit without
silently overriding the configured policy.
Shallow repositories retain their captured boundary commits in the manifest.
Restore creates an isolated bare repository with those boundaries, imports the
bundled objects and refs, and runs Git integrity checks. It needs neither the
origin nor credentials and does not deepen or modify the source checkout. History
older than the captured boundary remains unavailable. Format 2 carries this
metadata; current tools also read format 1 bundles, while older tools reject
format 2. Upgrade both backup endpoints before capturing format 2.

Each thread's latest checkpoint commit (by timestamp) recorded in the snapshot
is checked against the exported object store; older history rows are not required.
Export pins those commits under `refs/loom-backup/<sha>` in a temporary bare
repository borrowing source objects through Git alternates. Source refs, index
and branches are never changed. The exported bundle is self-contained; the
captured shallow boundary also applies in the temporary repository. Checkpoint
ids participate in the reuse fingerprint, so a changed database checkpoint
invalidates a cached bundle even when source refs stay unchanged. A checkpoint
ref moving during capture no longer drops the snapshot's commit. An object
actually missing from the source still leaves its thread not recoverable.
Invalid local pending bundles are discarded and recaptured, while the last
published local copy remains protected.
There is no claim that raw worktrees or native provider resume are portable.

`publish CONFIG` verifies locally, copies to an unpublished directory on the
mini, verifies hashes there, atomically publishes the directory, then commits a
manifest hash/pointer to `loom_recovery_bundles` in the source database. A failed
verification or upload never advances that pointer. Partial thread coverage does
advance it, with the gaps retained in the manifest and restore report. Database replication must
carry this committed pointer before restore can select the bundle. Recovery
markers and bundle pointers are the only database tables this tool writes.
The coordinator never needs to open the replica.

## Run and monitor

After activation is authorized, run `service CONFIG` under the approved process
supervisor. Only one instance may hold the spool lock; Litestream inherits the lock so an
orphan child blocks a second supervisor. The process supervisor must stop the
whole backup process group after a crash. Litestream replicates every
five seconds, so healthy database RPO is approximately five seconds plus transfer
latency, not zero; disconnection or backlog can make it longer. Bundles are
scheduled ten minutes from the start of the previous successful attempt by default.
Completed turns do not trigger extra full snapshots. If capture/upload takes longer
than that interval, the next attempt starts on the next health cycle after completion;
attempts never overlap or queue catch-up work. Failures still back off from completion,
and the persisted deadline survives supervisor restarts. Bundle-age alerts retain
their existing freshness budget. A single background worker captures and publishes bundles while the supervisor
continues writing markers and probing the replica. No overlapping bundle attempts
are allowed. Health still becomes stale if the monitoring loop itself stalls;
a running bundle never substitutes for a successful replica probe. Graceful
shutdown retains replication and the spool lock until the bundle writer finishes;
the process supervisor must terminate the whole group if its stop deadline expires.

Every 30-second cycle writes a synthetic transaction marker. A full disposable
restore on the mini checks its marker, integrity and free space every two minutes
by default; intervening cycles reuse that observation and its original timestamp. Lag
is based on the restored marker, not a running process or a successful upload.
Use `status CONFIG` for monitoring: nonzero means an alert or a monitor older than
two minutes. JSON alerts also go to stderr and `spool/health.json`:

- `replica_unavailable` includes restore and connectivity failures.
- `replica_lag` means more than the restore probe interval plus two minutes behind the source marker or current time.
- `destination_space_warn` means the mini is under `warn_free_bytes` (20 GiB default). It alerts and never holds Loom; bundle captures continue (retention keeps the mini's bundle footprint flat).
- `destination_low_space` means the mini is under `pause_free_bytes` (5 GiB default), the hard floor where replication would actually fail. It stops new captures and is one of the two alarms that hold Loom admissions.
- `source_low_space` uses the warning floor on the source spool and stops new captures.
- `destination_prune_failed` means superseded destinations could not be pruned (see Reseed and rotation); it retries every ten minutes.
- The legacy `min_free_bytes` key is read as the warning floor; the pause floor then defaults to 5 GiB. `pause_free_bytes` may not exceed the warning floor.

Each health report also carries `free_bytes`, `destination_host`, `destination`,
`warn_free_bytes` and `pause_free_bytes`, so an alert can say which mini is
filling and how far it is from each floor.
- `recovery_bundle_stale` means no published bundle or older than the greater of thirty minutes or three capture intervals.
- `backup_supervisor_stopped` means replication supervision stopped.
- `marker_failed` reports SQLite marker errors without stopping supervision.
- `bundle_failed` persists until a capture and verified publication succeeds.
- `monitor_not_started` means no health file exists; status exits nonzero without a traceback.

The two stop-capture space alarms (`destination_low_space`, `source_low_space`) stop new bundle captures, preserving existing copies; replication
continues and the alarm requires operator attention. The destination warning does not stop captures. Activation must connect the
nonzero health result to the operator's monitor, verify the running coordinator's
local free-disk admission floor, and check source WAL/replica spool growth against
that headroom. Mini-space admission wiring is not an activation prerequisite:
a full mini stops new captures and raises an alarm, while the source floor guards
new host admissions. Running turns can still write; the floor is not a disk quota.

On a coordinator release with recovery admission support, set
`LOOM_RECOVERY_HEALTH_FILE` to the absolute `spool/health.json` path. This opts in
to pausing **all new turns**, including warm sessions and owner messages, only
on a fresh report of the mini under its hard floor (`destination_low_space`) or
replica lag over budget. The space warning never pauses. Running turns
finish normally. Existing provider retry holds retain their reason and deadline.
Queued work retries every 30 seconds and resumes after the alarm clears.
Missing, malformed, future-dated or older-than-two-minute health files, a stopped
supervisor, and other backup failures remain monitor alarms only; they never hold
admissions indefinitely. The source disk admission floor remains independent.
Health is written before and after bundle work so a slow capture does not itself
pause admissions. Leaving the variable unset retains standalone backup behavior.
To clear a pause at runtime, write `allow` to the sibling file
`<health-file>.override`; the next dispatch/retry reads it without a restart.
Remove that file to re-enable the gate. Verify with an isolated coordinator and
synthetic health readings before enabling it on a deployment.

### Alerts

The system tick (`packages/system`, every minute) turns recovery trouble into two
incidents on job `loom:recovery`, each posted once to the alerts channel through
the single Discord sender, with a "Resolved" post when it lifts (critical
reminders every four hours while open):

- **Loom paused new turns** opens as soon as any Loom thread has
  `admission = recovery_unhealthy`. The post names the waiting conversations, the
  mini's host and free space against both floors, the backup's alerts, and the
  override and re-enable commands. It clears from Loom's own state once no
  thread is held, even if the health file has gone stale.
- **Recovery mini is low on space** opens on `destination_space_warn` (or
  `destination_low_space`) while nothing is held yet, so there is time to act
  before the hard floor. It clears once the mini is back a gigabyte above the
  warning floor.

The tick reads Loom's database read-only from `LOOM_HOME` (default
`~/.tango/loom`) and the health file from `LOOM_RECOVERY_HEALTH_FILE` in its own
environment or the repository `.env`; set it to the same path Loom uses. Without
it, the hold alert still fires (without the space details) and the warning
cannot. A stale or missing health file never resolves or opens anything.
The tick also keeps a half-hourly free-space sample for a week and reports the
last day's trend, for example `mini 100.0.0.9: 28 GB free, -12 GB/day, about
1.9 days to the pause floor; 0 held`, in its report and the health snapshot.

Local retention keeps the last successfully published bundle plus one pending bundle.
The pending publication survives upload, SQLite and supervisor failures: retries
verify and reuse the same remote directory, then idempotently commit its pointer.
Abandoned local capture directories are removed on the next managed attempt.
Failure count, error and next-attempt time are persisted before I/O, so restarting
cannot reset the 60-second to one-hour retry backoff. Success resets the count
and persists the next scheduled capture. SQLite marker and backup errors become
health alerts instead of terminating the service.

An unchanged Git ref inventory reuses the prior verified bundle by hard link,
avoiding repeated Git packing and local writes; changed refs generate a fresh
self-contained bundle. Uploads use checksum comparison and `--link-dest` to the
last successful remote bundle, sharing unchanged files. SQLite snapshots still
write the database size each interval (about 29 GB/day for a 203 MB database at
the default ten minutes); this is not incremental SQLite bundle capture.

The dedicated destination namespace has one writer. Each attempt removes abandoned
`.partial-*` uploads other than its own resumable pending upload. After publishing,
a successful replica restore is required before retention runs. Retention keeps
the newest three verified bundles (`remote_keep_bundles`, minimum one), plus the
source's just-published bundle and the replica's current committed bundle even
when it is older. It never deletes the only verified copy or unrecognized,
symlinked, or corrupt directories. An unavailable replica leaves the publication
pending; retries do not accumulate new snapshots. Unknown/corrupt directories
require operator inspection. Litestream separately keeps seven days of snapshots
and associated LTX history. Recovery from an arbitrary historical date is not promised.

## Reseed and rotation

A reseed (a fresh replica history, for example after replacing the source
database) goes to a new dated destination. Stop the backup service, then run:

```sh
python3 scripts/recovery/loom_backup.py rotate PRIVATE_CONFIG
```

It refuses while the service holds the spool lock and requires `remote_root`.
It rewrites the config (mode 0600) to `<remote_root>/destinations/<now>` and
prints the previous and new destinations. Start the service; Litestream seeds
the new replica and the next bundle publishes into it.

Once the current destination verifies (a successful restore probe whose replica
carries a committed bundle), the service runs `prune-destinations` on the mini:
it re-verifies the current destination, keeps it and the newest
`keep_previous_destinations` (default one) older dated folders, and deletes the
rest. It runs once per new destination and then every six hours. Only
stamp-named, non-symlink directories under `<remote_root>/destinations` that
sort before the current one qualify: `bin`, unknown names, symlinks and anything
newer are never touched. A failure raises `destination_prune_failed` and retries
in ten minutes. Never hand-copy a destination to a new folder without rotating;
every superseded replica holds the full database history and fills the mini.

### Moving from a legacy layout

Older installs used dated top-level folders (for example a live replica and its
tooling each in their own `~/loom-recovery-live-*` folder), which looks like
disposable output and was deleted by mistake once. To move to the stable root:
create `<remote_root>/bin` and `<remote_root>/destinations`; copy the current
`loom_backup.py` and Litestream binary into `bin` (leave the old copies until the
service is confirmed on the new paths); stop the service; `mv` the current
destination folder to `<remote_root>/destinations/<its stamp>` on the same disk;
set `remote_root` and `destination` in the config and remove `remote_script` and
`remote_litestream` (they then default to `bin`); start the service and confirm
`status` is healthy. Remove the old tooling folders and any superseded legacy
replicas by hand after that; pruning only manages `destinations`.

## Restore and drill

Run on the mini, with a **new** output directory:

```sh
python3 /absolute/loom-recovery/bin/loom_backup.py restore \
  /absolute/loom-recovery/bin/litestream \
  /absolute/loom-recovery/destinations/20261023T213000Z/replica \
  /absolute/loom-recovery/destinations/20261023T213000Z/bundles \
  /absolute/new-isolated-restore
```

Restore checks SQLite integrity and foreign keys, selects the newest verified
bundle whose manifest hash was committed in the replicated database, verifies
file hashes, and clones/checks the bundled Git objects. A corrupt newer bundle
falls back to an older verified committed bundle and reports that choice.
`replicated.sqlite` preserves the newest database for reconciliation;
`sandbox.sqlite` is the coherent snapshot paired with the recovered files.
Never start a live coordinator on either file without an explicit reconciliation
and activation procedure. The backup tool itself starts no network service,
provider, schedule or trigger; process ownership data is not restored.

The report separates database marker age, file recovery point, and restore time.
These ages are not a measured loss claim without the source's final committed
marker. A drill observing zero marker loss does not establish zero RPO: its final
marker can already have synced before failure; writes in the final five seconds
are not covered by that observation. For a drill, compare that marker with the restored marker and record
both database loss and the older file snapshot point. Preserve uncertain outward
actions for reconciliation; do not replay them automatically.

Build Loom, then create invented data with:

```sh
npm run build -w @tango/loom
node scripts/recovery/drill-fixture.mjs /absolute/new-fixture
```

Point a separate private config at that fixture. Copy `check-drill.py` next to
`loom_backup.py` on the mini, then run:

```sh
python3 scripts/recovery/drill.py PRIVATE_CONFIG NEW_EVIDENCE_DIRECTORY
```

This verifies the source contains only the synthetic thread, runs the backup
supervisor for 45 seconds, abruptly kills its own isolated process group,
reads the final source marker for comparison, and restores and validates on
the mini. It does not stop or alter any live service.
Verify the fake queued input, waiting trigger, attachment and checkpoint object.
No provider credentials or live database are needed. Repeat after format changes
and monthly. Report dataset size, actual source-to-replica loss, bundle loss window
and wall-clock recovery duration; targets are <=60 seconds database loss,
<=15 minutes DB restore and <=30 minutes ready isolated data.

## Undo

Stop this backup supervisor (SIGTERM also stops its Litestream child). Leave
verified replicas and bundles intact. No coordinator restart or schema rollback
is needed; the additive recovery tables can remain unused. Restore directories
are inert evidence, not a second live Loom instance.

## External namespace identity guard

Install `namespace_guard.py` and `monitor.py` on the monitoring host, outside the
remote backup root. This guard detects disappearance or replacement; it neither
prevents deletion nor identifies the actor. It works even when the remote backup
script is gone: a bounded SSH call sends a read-only Python probe directly.

After verifying the active destination and its last published bundle, explicitly
enroll it once (keep actual paths in private configuration):

```sh
python3 namespace_guard.py enroll PRIVATE_CONFIG /absolute/monitor/namespace.json
```

Enrollment writes a random `.recovery-identity` with exclusive creation in the
existing active **destination**, and saves its expected hash, required tool hashes
and last-good manifest hash on the monitoring host. It refuses an existing state
or canary. No health check creates directories, replicas or canaries remotely.
The initial enrollment needs a successful publication (`spool/last-good.json`).

Wire every existing health tick to this entry point, using the same monitor-state
file as before to preserve generic health notification deduplication:

```sh
python3 monitor.py PRIVATE_CONFIG \
  --state /absolute/monitor/monitor-state.json \
  --guard-state /absolute/monitor/namespace.json \
  --backup-script /absolute/monitor/loom_backup.py \
  --event-command /absolute/bin/tango-event
```

The guard runs independently before the backup status command, including when
its health file is cached or the backup executable is missing. It checks the
root, canary identity, both required tool hashes and the last published bundle's
manifest. A mismatch latches first-failed time, last-seen time, last-good marker
and observed hashes durably before delivering a separate critical
`recovery.namespace_identity` event on `loom:recovery`. Failed event delivery
retries; accepted delivery is recorded and subsequent ticks do not emit another
event. Normal ledger reminder policy still applies. Generic health recoveries
cannot resolve this incident. An SSH timeout is an unavailable reading, not proof
of deletion, and goes through the existing generic health alarm.

A manifest mismatch is confirmed under the publisher's `bundle.lock`, because
remote retention can precede the local last-good pointer update. While a publisher
holds that lock, manifest confirmation waits for a later tick; canary and tool
checks continue, and the last-good observation is not advanced.

A restored file or supervisor restart never clears the latch. A deliberate
rotation or tooling upgrade also requires explicit guard maintenance: stop the
health tick, preserve its state as evidence, verify the new target and tooling,
and enroll using new state. If retaining the same destination, preserve and move
its old canary aside explicitly before enrollment; never automate this step.
Resolve the original incident only after inspection. A crash during enrollment
may leave a canary without state: inspect and preserve it rather than retrying
with an overwrite. The guard does not monitor its own host's failure; the
existing process/health monitoring remains necessary.

For scratch verification, `namespace_guard.py check CONFIG STATE` without
`--event-command` returns the latched result without sending notifications.
Use an isolated event sink to verify delivery retries and single-event behavior;
never remove or replace the live canary for a test.
