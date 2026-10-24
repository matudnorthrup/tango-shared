# Tango Server

`@tango/server` is a headless service supervisor and local control API. Tango.app
can quit without stopping the supervisor. The initial repository configuration
only **observes** Loom. It does not migrate any existing service or install a job.

Build from the repository root with `npm run build`. Run `tango-server run` (or
`node packages/server/dist/main.js run`) in the foreground. `tango-server status -v`
prints the services table. `tango-server plist` prints a LaunchAgent definition;
it never installs it. A LaunchAgent starts at login and is subject to macOS user
session lifetime; surviving logout requires a separate deployment arrangement.

## Configuration

`config/services.yaml` contains generic defaults. The active profile's
`config/services.yaml` overlays services by `id`; nested maps merge, arrays
replace. Unknown keys, duplicate IDs, missing dependencies, dependency cycles,
and invalid health checks fail validation before any services start.

Example **private profile** configuration (replace the example paths):

```yaml
services:
  - id: example-worker
    name: Example worker
    group: Workers
    mode: observe
    command: [node, /opt/example/worker.js]
    cwd: /opt/example
    env: { NODE_ENV: production }
    dependsOn: [loom]
    health:
      http: http://127.0.0.1:9500/health
      intervalSeconds: 10
      graceSeconds: 15
    restart:
      policy: on-failure
      backoffSeconds: 1
      maxRestarts: 5
      windowSeconds: 300
    budget: { memoryMB: 512, cpuPct: 100 }
    adopt: { launchd: com.example.worker }
```

Health selects exactly one of `http`, `port`, `tmux` (`session:window`), `launchd`
(label), or `process` (command-line regex), plus interval and grace seconds.
Adoption selects launchd or tmux and is allowed only in observe mode. It supplies
PID, resource usage, and logs independently of explicit health. With no explicit
health check, adoption determines health. A process check matches its regex;
a tmux check requires the window and a live pane process; a launchd check uses
the job state. Both tmux adoption and health accept an optional socket path:
`adopt: { tmux: "tango:worker", socket: /path/to/tmux.sock }` and
`health: { tmux: "tango:worker", socket: /path/to/tmux.sock }`. Explicit sockets
are passed as `tmux -S <socket>`; omission preserves system discovery defaults. HTTP/TCP
checks use the existing system probes, including the system HTTP convention
that responses below 500 indicate reachability. Discovery uses system launchd
and tmux discovery, including its service tmux socket environment conventions.
A process regex matches only the current user's processes. Missing discovery
commands produce unknown health rather than a false incident.

Observe services are never started, signalled, or restarted. Their discovered
PID, memory, CPU, health, and known log paths are reported. No system ledger is
opened or written for observe services; the system tick remains the incident
writer. Without adoption or a process match, PID and resource values may be null.

Managed services require a command and prohibit adoption. They start in dependency
order once every dependency is running and healthy, using its latest completed
reading. Due probes run concurrently with at most six in flight and one per
service. A slow probe does not block other probes, launches, or retries; results
from stopped or replaced managed children are discarded. Probe intervals run
from completion. Each starts in its own process group.
Failures use exponential restart backoff, bounded by `maxRestarts` in
`windowSeconds`; exhaustion latches `failing` until manual start. `never` disables
restarts; `on-failure` leaves a successful exit stopped; `always` also restarts
successful exits. Failed health after the startup grace period counts as failure.
Manual stop cancels pending retries. Shutdown stops managed services in reverse
dependency order for TERM delivery, with grace deadlines running in parallel.
KILL follows after `min(graceSeconds, 10)` seconds, including descendants whose
parent already exited. Shutdown does not wait for outstanding probes. Set the
LaunchAgent `ExitTimeOut` to 30 seconds; `tango-server plist` includes it.

Each managed child has a private `run/<id>.json` pidfile containing `pid`, `pgid`,
`startedAt`, and its command line. Before startup, matching live process groups
are reaped with TERM, then KILL after at most 15 seconds. A reused PID whose
command differs is never signalled. Confirmed exits remove the pidfile once the
process group is gone. Unknown listeners are never killed: a pre-existing TCP
listener latches the service `failing` with its PID and command. Managed health
requires both a live owned child and a successful probe.

`SIGHUP` or authenticated `POST /reload` re-reads both configuration layers.
Added services start, removed services stop, and changed services restart.
Unchanged services retain their children, health, and restart counts. Invalid
configuration leaves the current service set intact; reload requests serialize.

Combined stdout/stderr goes to `~/.tango/server/logs/<id>.log`, rotating at 10 MiB
with three archives. Managed health transitions and restarts use the system
ledger's `recordEvent` ingestion API, source `tango-server`. Budgets are reported,
not enforced. The server reuses compiled system discovery modules through a
single adapter; build `@tango/core` and `@tango/system` before building the server
alone in a clean checkout.

## API

Bind address: `127.0.0.1`, port `TANGO_SERVER_PORT` (default 9440). State and logs
live in `~/.tango/server` (`TANGO_SERVER_HOME` overrides). The server creates a
random bearer token at `token`, mode 0600. Every route except `GET /health`
requires `Authorization: Bearer <token>`. Clients should read this file rather
than embed tokens. The API has no remote listener.

| Route | Response / behavior |
| --- | --- |
| `GET /health` | `{ ok: true, version, startedAt }` |
| `POST /reload` | Re-read configuration and reconcile changed services; `{ ok: true }` |
| `GET /services` | `{ services: [...] }` |
| `GET /services/:id/logs?lines=200` | `{ lines: string[] }`; 1–10000 lines, bounded file reads; adopted logs when known |
| `POST /services/:id/start` | `{ ok }`; accepts a start request, which still waits for dependencies |
| `POST /services/:id/stop` | `{ ok }` |
| `POST /services/:id/restart` | `{ ok }` |
| `GET /maintenance` | Loom `{ on, reason, since, running, queued }` passed through |
| `POST /maintenance` | `{ on, reason? }` sent to Loom; same response |
| `GET /releases` | `{ current, previous, releases: [{ id, status, bytes, buildTime }] }` |
| `POST /releases/rollback` | Runs the current release's `packages/loom/scripts/release.mjs rollback`, then kickstarts `com.tango.loom`; `{ ok: true }` |
| `GET /resources` | Loom `/machine` fields plus `{ disk: { totalBytes, freeBytes } }` for the home volume |

Service fields: `id`, `name`, `group`, `mode`, `state`, `pid`, `since`, `restarts`,
`health: { ok, checkedAt, detail }`, `memoryBytes`, `cpuPct`, `budget`. Timestamps
are ISO strings; `checkedAt` is null until first probe. PID and resources can be
null. States: running, starting, stopped, failing, down, unknown. `since` is the
last state transition; restarts counts scheduled automatic retries this server
session. A stopped dependency blocks new dependent starts; it does not stop
already running dependents.

Observe controls return **409** `{ ok: false, code: "observe" }`. An older Loom
returning 404 for maintenance maps to **501** `{ code: "loom_unsupported" }`.
Missing services return 404; invalid maintenance bodies/log limits return 400;
upstream/rollback failures return 502. No previous release or an active rollback
returns 409. Kickstart happens only after rollback succeeds.

Loom connection uses `LOOM_PORT` (9420) and the token in `LOOM_HOME` (default
`~/.tango/loom`). Release state comes from `~/.tango/releases/loom/state.json`
(`LOOM_RELEASES_DIR` overrides). Status is current, previous, candidate, or
available according to that state. Rollback requires the release to contain its
release script. The existing Loom release builder does not currently copy that
script into release directories; release packaging must supply it before live
rollback is available. The server never synthesizes or rewrites release metadata.

## Migration

1. Add each existing service to the private profile in observe mode, with its
   launchd/tmux adoption target and health check. Compare health and resource
   readings with the existing system view. Keep the existing healthcheck job.
2. Select one service. Verify its command, working directory, environment,
   dependencies, health check, and logs using an isolated managed test instance.
3. In a separately authorized maintenance window, stop that service's old
   launchd/tmux owner, remove `adopt`, and change only that service to managed.
   Reload the server with the revised configuration. Never leave both owners
   active. Verify health, restart policy, logs, and dependent startup behavior.
4. Repeat one service at a time. If migration fails, stop its managed instance
   before restoring the old owner and observe configuration.
5. Once all intended services are managed and recovery is verified, retire the
   separate healthcheck job. Keep the system tick for discovery and notifications;
   remove any duplicate probe ownership in a separately scoped integration change.

This implementation does not modify the live profile, install the LaunchAgent,
stop existing services, or run rollback during setup or tests. Tests use temporary
state, injected probes/clock/runners, and small detached Node children. Where
socket binding is restricted, HTTP tests drive the actual server request handler
without a network listener; an allowed local deployment still needs a loopback
API smoke test before migration.

## Restart paths

Before restarting after a source update, follow
[Updating live checkouts](agent-operating-model.md#updating-live-checkouts).
Use `bash scripts/dev/update-live-checkouts.sh` to update and build both copies;
a bare detached checkout does not rebuild workspace dependencies. A build-only
repair requires no restart unless a running service must load changed code.

Use `tango-server restart <id>`, `start <id>`, `stop <id>`, or `status <id>`.
Commands are quiet unless `-v` is supplied. They read the bearer token from
`~/.tango/server/token` (`TANGO_SERVER_HOME` overrides) and connect to localhost
on `TANGO_SERVER_PORT` (default 9440). `status -v` lists all services.
Exit codes: 0 success/running, 1 stopped or rejected action, 2 invalid usage,
3 server/token unavailable, 4 unknown service. `managed <id>` is a predicate:
0 means the responding server owns the service in managed mode; 1 means observe,
unknown, or unavailable. Ownership includes stopped and failing services so
recovery does not accidentally create a second process under tmux.

Shell scripts source `scripts/lib/tango-server.sh` and use `ts_managed <id>`
then `ts_restart`, `ts_start`, `ts_stop`, or `ts_status`. The helper resolves the
compiled CLI through `TANGO_REPO_DIR` (default: its checkout); build the server
before use. Managed services delegate to the API; other services retain their
existing tmux/launchd path. The healthcheck logs a skip for server-owned services.

Cut over artifacts first, then live-operator, then the Desk (`screen`). Move the
bot (`discord`) last, with owner sign-off. Keep the bot idle-wait procedure before
restarting; changing supervisors does not make interrupting active turns safe.

When the server can't be reached, `tango-server managed <id>` exits 3. The shell helper then fails closed for any service the service list declares `mode: managed`: the calling script exits 3 instead of falling back to a legacy start that could run a second copy. The healthcheck sets `TS_UNAVAILABLE=skip` and skips such services instead.

## Replacing Tango.app

Use only the [coordinated app installer](../../apps/tango-app/README.md#installing-or-rolling-back-the-app).
Build/sign into a fresh candidate directory, then run `apps/tango-app/scripts/install-app.py`
from outside the managed server tree. It stages and verifies a backup and candidate,
holds new Loom work and drains active turns, explicitly accounts for managed-service
interruptions, boots out the external owner before moving the bundle, and verifies
restart or restores the backup. Never copy/remove/re-sign a running app bundle and
then kickstart its server: that invalidates macOS executable signing constraints.
The external LaunchAgent and app login item must never be enabled together.
