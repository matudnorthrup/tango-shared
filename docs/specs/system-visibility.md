# System visibility: jobs, events and incidents

Status: design locked 2026-10-18. Implementation spec for the `@tango/system`
package, the `tango-system` tick, and the desk System page.

## Why

Behind-the-scenes work runs through seven mechanisms: Tango schedules, launchd
agents, tmux service windows, Docker containers, Claude routines, background
jobs and Loom waits. Before this, the desk saw only the schedules. About half of
everything reported failures to no one, and about eight scripts each posted to
Discord with their own ad hoc dedup, so the alert channels were mostly noise.

The fix is one ledger that every source writes to, an incident layer that folds
repeats into one problem, and one page that reads it.

## Concepts

- **Job**: anything that runs without someone starting it. Every job has a
  runner, an id unique within that runner, a cadence, a criticality and an
  optional owner (agent or space).
- **Run**: one execution of a job: start, end, exit code, duration, summary and
  the tail of its output.
- **Event**: one thing that happened (a run failed, a service went down or came
  back, a delivery failed, a log grew past its limit). Events have a severity
  and a fingerprint.
- **Incident**: events with the same fingerprint, folded together. People are
  notified about incidents, never about events.

## Storage

One SQLite file, WAL mode, default `<profile>/data/system.sqlite`
(`TANGO_SYSTEM_DB` overrides). Every writer opens it directly, so the ledger
keeps working when the bot or the desk is down.

```sql
jobs(
  id TEXT PRIMARY KEY,            -- "<runner>:<runner id>", e.g. "schedule:daily-brief", "launchd:com.example.backup"
  runner TEXT NOT NULL,           -- schedule | launchd | tmux | docker | routine | background | loom-wait
  name TEXT NOT NULL,
  owner TEXT,                     -- agent id or space id
  grp TEXT,                       -- display group ("Tango core & desk", "Backups & media", ...)
  cadence TEXT,                   -- human: "Every 10 min", "Daily 03:30", "Always on", "At boot"
  cadence_seconds INTEGER,        -- expected max gap between runs; NULL for always-on/at-boot
  criticality TEXT NOT NULL DEFAULT 'normal', -- critical | normal | quiet
  source TEXT,                    -- path of the plist / YAML / config that defines it
  logs TEXT,                      -- JSON array of log paths
  probe TEXT,                     -- JSON {"url"} | {"port"} | {"tmux": "session:window"} | {"docker": "name"}
  state TEXT NOT NULL DEFAULT 'active', -- active | paused | retired
  retired_at TEXT, retire_reason TEXT, archive_path TEXT,
  managed INTEGER NOT NULL DEFAULT 1,   -- 0 = unmanaged process found by the scan
  last_run_at TEXT, last_status TEXT,   -- ok | quiet | failed | running | late
  last_exit INTEGER, next_run_at TEXT,
  last_used_at TEXT,              -- last evidence someone used the output (opened, replied, visited)
  facts TEXT,                     -- JSON runner-specific details (pid, port, cpu, restarts, cwd_deleted, ...)
  seen_at TEXT NOT NULL           -- last tick that discovered it; jobs not seen for 24h are dropped unless retired
);
runs(
  id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
  status TEXT NOT NULL,           -- running | ok | quiet | failed
  exit_code INTEGER, duration_ms INTEGER, summary TEXT, output_tail TEXT, source_ref TEXT  -- e.g. "schedule_runs:123"
);
events(
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, source TEXT NOT NULL,  -- scheduler | healthcheck | tick | tango-run | <script name>
  job_id TEXT, kind TEXT NOT NULL,  -- run.failed | delivery.failed | service.down | service.up | job.late | job.restarting | log.large | load.high | process.unmanaged | custom
  severity TEXT NOT NULL,         -- critical | error | warning | info | recovery
  title TEXT NOT NULL, detail TEXT, data TEXT,
  fingerprint TEXT NOT NULL, incident_id INTEGER
);
incidents(
  id INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL, job_id TEXT, title TEXT NOT NULL,
  severity TEXT NOT NULL,         -- highest seen while open
  status TEXT NOT NULL,           -- open | acked | muted | snoozed | resolved
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, count INTEGER NOT NULL,
  resolved_at TEXT, snoozed_until TEXT, regressed INTEGER NOT NULL DEFAULT 0, flapping INTEGER NOT NULL DEFAULT 0,
  reopen_count INTEGER NOT NULL DEFAULT 0,
  notified_at TEXT, notified_severity TEXT, notify_pending TEXT  -- opened | escalated | regressed | reminder | resolved
);
-- open incidents are unique per fingerprint
CREATE UNIQUE INDEX incidents_open_fp ON incidents(fingerprint) WHERE status != 'resolved';
cursors(name TEXT PRIMARY KEY, value TEXT);  -- ingestion cursors (e.g. schedule_runs last id) and the
                                              -- latest health snapshot under name 'health' (JSON)
```

## Fingerprints and folding

`fingerprint = sha1(source-independent job_id + kind + normalize(title))`.
`normalize` lowercases and replaces numbers, hex ids, UUIDs, ISO timestamps,
durations ("4012ms", "3.2s"), ports, absolute paths and quoted strings over 40
characters with placeholders. Two events that differ only in those fold.

`recordEvent(e)`:
1. Computes the fingerprint and writes the event.
2. `severity = recovery`: resolves the open incident for that job and kind
   family, if any, and sets `notify_pending='resolved'` when it was notified.
   A recovery with no open incident is stored and does nothing else.
3. Otherwise: if an open/acked/muted/snoozed incident has the fingerprint, it
   bumps `count` and `last_seen` and raises `severity` if the new one is higher
   (`notify_pending='escalated'` on a raise). If not, it opens one
   (`notify_pending='opened'`). It sets `regressed=1, notify_pending='regressed'`
   when the same fingerprint resolved within the last 7 days, and increments
   `reopen_count`.
4. Flap guard: more than 3 reopenings of a fingerprint within an hour sets
   `flapping=1`. A flapping incident does not auto-resolve until an hour has
   passed with no new failure.

Auto-resolve: a successful run of a job resolves its open `run.failed`,
`job.late` and `job.restarting` incidents. `service.up` resolves `service.down`.

## Thresholds

Per job, from criticality (overridable in annotations):

| | critical | normal | quiet |
|---|---|---|---|
| Event on a failed run | first failure | 2 in a row | never (history only) |
| Late (missed run) | 1.5× cadence | 2× cadence | 3× cadence |
| Notify | Discord + desk Needs you | desk feed | System page only |
| Reminder while open | every 4h | every 24h (feed) | never |

Skipped or "nothing to do" runs never create events. Ordinary reports are not
events.

## Notification

Only the tick sends notifications, so there is exactly one sender.

- **Critical** incidents: one Discord post per transition (opened, escalated,
  regressed, reminder, resolved) to the alerts channel
  (`TANGO_SCHEDULER_ALERTS_CHANNEL_ID`) via bot REST, prefixed `🛰️`, with a
  count and first/last seen. Acked or muted incidents send no reminders, and
  muted ones send nothing. Snoozed incidents send nothing until `snoozed_until`.
- **Normal** incidents post to the desk feed (kind `system`, key
  `incident:<id>`), using the feed's own folding.
- The desk shows **critical** open incidents as items (`system:incident:<id>`,
  `facts.failed`) so they surface as Needs you, and settles them when they
  resolve.
- `#system-log` is retired: the scheduler stops posting run lines.

## Writers

- `tango-event` CLI, for shell and Python scripts:
  `tango-event --source <name> --kind <kind> --severity <sev> --title "<text>" [--job <id>] [--detail "<text>"] [--data '<json>']`.
  It exits 0 even if the ledger is unavailable (it prints a warning), so it
  never breaks the caller.
- `tango-run <job-id> -- <command...>`: wraps a launchd job. It records a run
  (start, end, exit, duration, last 4 KB of combined output), passes stdout and
  stderr through to the original log, exits with the command's code, and records
  `run.failed` when the exit is non-zero (subject to thresholds) or a recovery
  on success after a failure.
- `@tango/system` library: `openLedger()`, `recordEvent()`, `recordRun()`,
  `finishRun()`, `listJobs()`, `listIncidents()`, `listEvents()`,
  `setIncidentStatus()`, `setJobState()`, used by the bot and the desk.
- The scheduler writes its failure, threshold and delivery alerts as events
  (`source: scheduler`) instead of posting to Discord.
- The healthcheck writes `service.down` / `service.up` events. Its own Discord
  posts are kept only for "the bot is down and the tick can't run" cases, and
  are gated by the same fingerprint.

## The tick (`tango-system tick`, a LaunchAgent every 60 s)

Each tick, with a soft budget of 20 s and no `lsof` (it can hang on stalled
network mounts):

1. **Discover** jobs:
   - Schedules from the loaded schedule configs and `schedule_runs`.
   - launchd agents whose labels match the configured prefixes (`launchctl
     print` for state, last exit and runs).
   - Service windows from the startup config (`tmux list-panes` for pane pid;
     a pane pid that changes 3+ times in 10 min is `job.restarting`).
   - Docker containers (`docker ps -a --format json`).
   - Claude routines (scheduled-task folders).
   - Background jobs (`data/background-jobs/*/job.json`).
2. **Ingest** new `schedule_runs` rows into `runs`, using a cursor.
3. **Probe** services: bot, Loom, desk, MCP, voice, tailnet, Docker, plus load,
   memory and disk. The result is stored as the `health` cursor, and changes
   become `service.down` / `service.up` events.
4. **Late check**: an active job with `cadence_seconds` whose last run is older
   than its threshold produces `job.late`.
5. **Unmanaged scan**: listening user processes re-parented to launchd that
   match no job become `managed=0` rows. When the 5-minute load average stays
   above `cores × 1.5` for 10 minutes, one `load.high` incident names the top
   unmanaged processes.
6. **Logs**: a registered log over 50 MB produces `log.large`. Over 100 MB it
   is rotated (gzip copy, truncate in place, keep 3).
7. **Notify** pending transitions and reminders.
8. Prunes events older than 30 days and resolved incidents older than 90 days.

## Promises to come back (`tango-system wait-keeper`, a LaunchAgent every 30 min)

Threads, workers and jobs say they'll come back ("Next — me", "waiting on X", "I'll check after CI"). A promise backed by a Loom wait, a PR watch or a scheduled job is kept by that; the rest were only words. The wait-keeper (`packages/system/src/wait-keeper.ts`, installed by `scripts/system/install-wait-keeper.sh`) runs every 30 minutes with no model calls and reads:

- **Loom** (API, and `runs` read-only): a wait more than 10 min past its time that never fired, and a run queued more than 10 min on a thread that isn't running. Both are warnings; the missed wait's thread is woken once.
- **The desk List** (`/api/desk/items?view=active`): open Loom conversations that are watching with nothing behind them (`watching.basis` summary or an agent wait), a day old or past the desk's own overdue mark. Each is woken once with its promise quoted (an info incident); still unmoved a day after the wake, it becomes a warning. A wait on a person, or on a Discord agent, is flagged only.
- **Unanswered owner questions and briefs:** after **more than 6 hours of the owner's active time**, raise one warning on System and the desk feed. Reuse Loom's recorded presence intervals (no wall-clock fallback, no time after the last beat). Read the desk's original pending question, open brief, or legacy open ask; carried brief copies and prose references to a decision do not create another escalation. The warning opens the original question, without answering it, waking a blocked thread, or changing brief routing/defaults. It includes queued-mail counts when known. Stable request identity distinguishes successive asks and survives thread renames and brief revisions. The ledger and keeper state remember the escalation; no repeated events or scheduled reminders. Clearing the ask clears the warning, and an unreadable desk or presence source leaves it intact. Checks run with the existing 30-minute wait-keeper cadence.
- **Desk mail** (`desk_mail`, read-only): mail queued for 6 h, or delivered and unanswered for a day, grouped by recipient (info), noting a pending question when that is what holds the recipient busy.

A wake is a desk `reply` (actor `agent`) with an id derived from the promise, so it lands once even across restarts; the state file `<profile>/data/wait-keeper/state.json` remembers it. At most 5 wakes a run. It never wakes a running thread or one with a question pending, never answers a question, and never contacts a person. Findings are incidents on job `launchd:com.tango.wait-keeper`: info stays on the System page, warnings reach the desk feed. A finding that clears resolves its incident on the next run, unless its source couldn't be read. The wakes run under a standing rule in the owner's decisions ledger.

## Annotations

Discovery fills in what it can. `config/defaults/system/jobs.yaml` holds
generic defaults (runner prefixes, criticality of core services). A profile
overlay (`<profile>/config/system/jobs.yaml`) adds machine-specific details:
names, groups, owners, criticality, cadence, logs and probes per job id. Labels
and paths specific to one machine belong in the overlay only.

## Retire, pause and restore

- **Pause**: a schedule uses the existing pause; a launchd agent is booted out
  (plist kept); a tmux window is stopped; a Docker container is stopped.
- **Retire** (archives at once): pause, then move the definition to
  `<profile>/archive/retired/<date>/`. A launchd plist is moved. A schedule gets
  a profile overlay `enabled: false`, and a profile-only YAML is moved. A
  startup service gets `enabled: false` in the profile startup config. Then
  `state=retired`.
- **Restore** reverses whichever of these applied.
- **Stop** (unmanaged process): SIGTERM, then SIGKILL after 10 s, after
  confirming that ppid is still 1 and the start time still matches.

## Desk: the System page

Replaces the Capacity page. Routes `x:system` and `x:capacity` both open it,
with `capacity` landing on its Capacity tab. Layout A (tabs), as in the
prototype:

- Header: title, a one-line status ("2 critical problems need you, and 9 more
  are open. The other 81 jobs ran as expected." or "All clear."), and "checked
  Ns ago".
- Health strip: services on row 1; Load, Memory and Disk with meters on row 2.
  Tapping a cell filters the page.
- Tabs **Overview · Jobs · Events · Capacity**:
  - **Overview**: a critical card, then open incidents (with Ack / Mute /
    Snooze), collapsed groups for acked/muted/snoozed and for resolved this
    week, jobs failing or late, prompts (unmanaged processes, retire
    candidates), and the capacity tiles.
  - **Jobs**: filter chips All · Failing · Late · Unmanaged · Retire? · Runner.
    Groups fold when everything in them is fine. A row shows a health dot,
    name, runner and cadence, a problem line, last run, next run, and a strip
    of the last 8 runs. Opening a job shows a page with runs, log tail, source,
    incident, criticality, Run now / Pause / Restart / Open log / Mute and
    Retire.
  - **Events**: the raw stream, filterable by severity, source and job, with
    repeats folded.
  - **Capacity**: the previous Capacity page content, unchanged.
- Sidebar footer row **System** replaces Capacity. It shows a red chip with the
  number of critical open incidents and no chip otherwise. On phone, System is
  reached through Search and the switcher; critical incidents also appear in
  Inbox as Needs you.
- Commands, all optimistic with a `predict()` case and a Retry toast:
  `incident.ack|mute|snooze|unack|fix`, `job.run|pause|resume|restart|retire|restore`,
  `process.stop`.
- **Fix** (beside Ack / Mute / Snooze on every unresolved incident, and on a
  critical incident's Inbox card) starts a cleanup worker. It runs in the Tango
  desk project and reports to that project's default conversation, so the Tango
  lead hears its report. The project is the `system_fix_project` desk setting,
  else `SCREEN_SYSTEM_FIX_PROJECT`, else the project named or with the id
  `tango`. The repo is `SCREEN_SYSTEM_FIX_REPO`, default `tango`. The worker's
  task is built from the ledger: the incident, its job, its last 10 events, the
  job's last 5 runs and the last 2 KB of its first log. Secrets are redacted,
  but real paths stay, because the worker runs on this machine. The task tells
  it to diagnose, fix safely (code goes through a PR), verify, and then close
  the incident with a recovery event. With no default conversation, it starts
  as a thread of its own in the project. The started thread is kept in the
  ledger's cursors as `fix.<incidentId>`, and the snapshot shows it as
  `incident.fix = { itemId, at, via, done }`. While that thread is open, the
  button reads "Fixing · Open" and opens it. A retry or second tap returns the
  same thread (commandId `fix-incident-<id>`). Once the thread is finished, a
  tap on an incident that is still open starts the next one.
- Voice: `list_place` accepts `system` (and `capacity`), and the operator can
  answer "what's broken?" from `/api/desk/system`.
