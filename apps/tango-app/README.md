# Tango.app

A native macOS 15+ menu bar control panel for Tango Server. Swift 6 and SwiftUI,
with no third-party dependencies. The app is a client: **quitting Tango.app never
stops agents, services, or Tango Server**. Explicit Start, Stop, Restart, maintenance,
and rollback controls send authenticated requests to the server.

Build and test from this directory:

```sh
swift build
swift test
scripts/build-app.sh /absolute/path/to/tango-server-entry.js /absolute/path/to/node
codesign -dv --verbose=4 build/candidate.XXXXXX/Tango.app
```

The first argument is the built JavaScript entry point implementing
`tango-server run`; the second is a compatible Node executable (defaults to Node
on PATH). The server may be built independently. The build script does not run
the server or app, install anything, or register login items. Output is
a new `build/candidate.XXXXXX/Tango.app` on every build (the final output line).
Never rebuild or sign an installed bundle in place. Build products and binaries are ignored by Git.

The script embeds a private copy of Node at `Contents/MacOS/tango-server-node`,
and fills `Contents/Library/LaunchAgents/com.tango.server.plist` from its template.
`BundleProgram` points to that bundled executable; `ProgramArguments` specifies
the bundle-relative Node name, the supplied absolute server entry point, and `run`.
The switch resolves Node against the installed bundle when writing the external plist. Keep the server entry
point and its dependencies at that location. Rebuild if its location changes.
The script signs ad-hoc only. The copied Node must be compatible with this Mac.

For restricted build environments, redirect Swift's caches and disable its nested
manifest sandbox (this does not disable the enclosing workspace sandbox):

```sh
export CLANG_MODULE_CACHE_PATH="$PWD/.build/ModuleCache"
export SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/ModuleCache"
swift build --disable-sandbox
swift test --disable-sandbox
TANGO_SWIFT_DISABLE_SANDBOX=1 scripts/build-app.sh /absolute/path/to/server.js /absolute/path/to/node
```

## Connection and controls

Settings defaults to `http://127.0.0.1:9440` and `~/.tango/server/token`. Save and
reconnect after editing either value. The token is read at request time and sent
as a Bearer header; it is never stored in preferences. Only use trusted server
URLs; use HTTPS for connections beyond the local machine.

The dot is green when `/health` is OK and every service is running and healthy,
amber otherwise, and red when health/services cannot be fetched. The menu counts
services by state. Observed services cannot be controlled. Maintenance requires
confirmation when enabled, supports an optional reason, and displays finishing
and waiting turn counts. Unsupported Loom maintenance and observe conflicts show
readable errors. Rollback also requires confirmation.

Services are grouped by group; selecting a row shows the latest 200 log lines,
refreshed every three seconds with tail following. API snapshots refresh every
five seconds when the main window or menu is visible, and every thirty seconds
otherwise. Minimized and hidden windows count as invisible. Network errors retain
the last error and offer Retry and Settings. Resources shows memory free percent,
per-agent memory, disk space, and optional warm/cooled counts.

## Login and privacy grants

The login switch manages `~/Library/LaunchAgents/com.tango.tango-server.plist`.
Turning it on writes the external plist using the current app bundle's Node,
then runs `launchctl bootstrap`. An already loaded job with valid login
configuration is left untouched. Missing or mismatched login persistence produces
a warning and a Repair login configuration button; repair rewrites the plist
without restarting the loaded job.
Turning it off removes login persistence and uses `launchctl bootout` for orderly
shutdown. A bootout error is checked against actual loaded state: a job that
already unloaded stays disabled at login. Other failed operations restore the
previous plist when cleanup succeeds;
cleanup failures are displayed instead of claiming the switch changed.
The switch reflects whether launchd has the job loaded, with separate running
status, refreshed every five seconds while Settings is open. A loaded job waiting
to restart stays on. Missing or corrupt external plists can be recreated from the
bundled template, or removed by turning the switch off. `ExitTimeOut` is at least
30 seconds, matching the safe installer contract. The build records the server
repository as WorkingDirectory (or TANGO_REPO_DIR when supplied), so Off/On
preserves the working directory.

Run the bundled app for this feature; `swift run` has no server template.
On app launch, the obsolete `com.tango.server` SMAppService registration is
unregistered if present; subsequent launches do nothing once it is retired.
The app never registers that legacy service. `--retire-login-item` retains the
headless retirement check used by the installer. Legacy retirement failures block On but never block Off. Registration is not
performed during build or tests.

The production permission model is a consistently signed app bundle that holds
macOS privacy grants for its launched server process chain: Full Disk Access,
Documents access, and Automation as needed. The owner grants these in System
Settings and responds to macOS prompts. Ad-hoc builds are for development and do
not establish a durable signing identity. macOS attribution varies by protected
resource and process chain; validate the signed bundle and embedded Node/server
on the target Mac before relying on inherited grants. Signing alone grants no
access and cannot bypass consent.

A later, owner-run signing step (never run by this build script) is:

```sh
codesign --force --options runtime --timestamp --entitlements Resources/Tango.entitlements --sign 'Developer ID Application: YOUR ORGANIZATION (TEAMID)' build/candidate.XXXXXX/Tango.app
codesign --verify --deep --strict --verbose=2 build/candidate.XXXXXX/Tango.app
```

Leave out `--deep`: it would re-sign the bundled Node under a new identity, and macOS
ties the server's Local Network permission to Node's own signature. Use the actual organization identity. Distribution may additionally require
notarization; this is a separate owner-run step. The supplied entitlement allows
microphone capture under Hardened Runtime; macOS still requires user consent.
Neither quitting the app nor closing its window unregisters the server or sends
shutdown requests.

Tests use synthetic JSON, an isolated temporary token, and a fake URLSession
transport. They never access the real token, server, launchd, or login items.

The embedded LaunchAgent gets `PATH` from the shell that runs `build-app.sh` (override with `TANGO_SERVER_PATH`), because launchd starts agents with a bare PATH. Its stdout and stderr go to `~/.tango/server/launchd.{out,err}.log`.

## Installing or rolling back the app

The **only supported app replacement procedure** is `scripts/install-app.py`.
Do not remove, copy over, re-sign, or rebuild an installed/running bundle, or use
`kickstart -k` after copying it: macOS can kill its running Node for a signature
or launch-constraint violation before the intended restart. Build a fresh
candidate above, finish any signing on that candidate, then use:

```sh
python3 scripts/install-app.py /absolute/path/to/candidate/Tango.app \
  --target /absolute/path/to/installed/Tango.app \
  --plist "$HOME/Library/LaunchAgents/com.tango.tango-server.plist" \
  --interrupt-services discord,loom,screen
```

Replace the example service list with **every managed service ID** from
`tango-server status -v`. The installer fails closed and reports the required
IDs if the list does not match. This acknowledgement means those services and
any non-Loom work they own may be interrupted. Loom turns drain to zero; queued
turns wait. Maintenance is not a universal drain for arbitrary services. Stop
external producers or arrange their interruption before running this command.
The service outage starts after drain and ends when server/service health passes;
a failed candidate adds a rollback/start interval. Before engaging maintenance,
the installer waits for zero running turns. If a turn races with engagement,
`--drain-timeout` (default 60 seconds) bounds that drain: the installer restores
its previous maintenance state and waits for idle again. `--idle-timeout`
(default 7200 seconds / two hours) bounds the overall idle/drain admission phase.
Expiry records `idle-deadline-expired` and exits 2 after recovery, without replacing
the app. Recovery failure exits 1. `--timeout` (default 120 seconds per wait)
bounds health checks and recovery separately; an in-flight request and safe
recovery can finish after the admission deadline. No turn is forcibly interrupted.
Observed external maintenance changes are journaled and left untouched. The
API has no compare-and-set: a change in the millisecond-scale gap between the
final ownership GET and release POST can still be overwritten. Server-side
compare-and-set is a follow-up.

For a worker whose parent is managed by this server, use
`python3 scripts/install-job.py` with the same installer arguments. It bootstraps
an independent, unique launchd job with `RunAtLoad=true`, `KeepAlive=false`, and
no recurring trigger. **Never use `launchctl submit` for installation:** its
submitted job can be kept alive after either success or failure. The helper
prints the job ID and private evidence directory (stdout, stderr, result and
plist). **End the launching agent turn immediately after submission** and register
a durable completion trigger (such as `loom.wait_for` on `result.json`). Holding
that turn open prevents idle admission. A durable exclusive claim allows at most one installer invocation even
if someone kickstarts the job. A crash consumes that attempt; inspect the
journal before explicitly authorizing a new job. A missing result means unknown
or still running, not success. Once finished, unload only the printed job with
`launchctl bootout <job>`; preserve its evidence directory.

Run from an independent terminal/process outside the app and its managed
children. A worker managed by this server must hand installation to that
independent operator, otherwise it can terminate its own installer. Quit the
menu-bar client first (agents keep running). The script refuses to move a bundle
with any open files, and refuses unrelated bundle users before enabling
maintenance. It requires the existing external LaunchAgent to execute
that target's bundled Node and allow `ExitTimeOut >= 30`. First-time provisioning
and installations owned only by the app login item are intentionally unsupported.
The app switch manages this same external job; do not register the obsolete login item beside it. Preflight refuses a
loaded login-item job and uses the existing headless `--retire-login-item` command
to unregister a dormant duplicate; it does not register either owner. The login
switch uses this same external owner.

Before downtime, the installer copies the candidate and installed app into a
private sibling `.tango-install-*` directory and verifies both with
`codesign --verify --deep --strict`. It checks Node's upstream identity and hash;
it never signs Node. It locks concurrent installs, enables maintenance, drains
Loom, journals service/PID interruption accounting, stops managed services, then
boots out the external job and waits for the bundle to be unused. Only then does
it rename the old bundle and candidate. It bootstraps the same plist and requires
one external job, no login-item job, the expected bundled executable owning the
health port, and recovery of previously running managed services. Existing
maintenance remains on; maintenance enabled by this install is released last. Maintenance changes are
confirmed by reading the saved state. A transient proxy error after a POST is
ambiguous: Loom may have saved the change before queued work finished starting.
The installer does not repost it; it polls for confirmation within `--timeout`
before deciding recovery is needed.

Failure before candidate health is established stops the candidate before restoring
the verified backup and checking recovery. After candidate health succeeds, a failed
maintenance release exits nonzero but keeps the healthy new bundle running and
retains the backup and journal without marking the transaction complete. Inspect
`GET /maintenance` on the configured server URL using its bearer token; release
installation maintenance with authenticated `POST /maintenance` (`{"on":false}`),
then confirm using GET. If maintenance was already on before the install, restore
its previous reason instead (recorded in the journal). Do not rerun the installer
to repair a maintenance release. HTTP redirects are refused to protect the token;
transport failures during mutation or confirmation use bounded read-back polling. Failed or incomplete transactions remain for
diagnosis and manual recovery. After verified success, the unused `original.app`
is removed and only the two most recent completed transactions for this target
are retained (including their verified backups). Older transactions without a
completion marker are preserved. Cleanup skips bundles still in use; cleanup
errors are journaled without rolling back a healthy installation. SIGTERM and
SIGHUP both enter the normal recovery path. Journal writes precede terminal
output, and a closed terminal cannot block recovery. Further SIGTERM/SIGHUP
signals are ignored until recovery finishes. Interrupted pruning retains its
completion marker until the payload is removed, allowing a later retry. A failure exits nonzero
even after successful rollback. If rollback itself fails, maintenance remains on
and the journal identifies the backup: repair the reported blocker, then rerun
this same installer with that backup as the source once the external owner is
healthy. If no bundle/job remains, recover from the retained original only after
confirming both owner jobs and all bundle processes are stopped; never overwrite
a running executable. An uncatchable kill/power loss requires this manual
recovery; the journal is evidence, not an automatic crash-resume mechanism.

Verification:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test
python3 -m unittest discover -s Tests -p 'test_*.py' -v
python3 Tests/launchd-fixture.py
python3 Tests/launchd-once-fixture.py
```

The Swift suite runs locally with Xcode: the self-hosted CI runner has only
Command Line Tools, which omit the Testing module. Run the command above before
submitting Swift changes. The Python suites mock system boundaries and run in CI. The opt-in macOS drill
creates only a unique `com.tango.install-fixture.*` launchd label, an ephemeral
loopback port and signed temporary bundles using upstream Node. It exercises a
successful replacement and unhealthy-candidate rollback, checks orderly exits,
no supervisor overlap, unchanged Node bytes, restored maintenance and empty
stderr. It retains its logs and bundles at the printed evidence directory.

The one-shot drill submits success and exit-7 payloads through the same job
helper, waits beyond launchd's throttle, and checks each ran exactly once. It
then explicitly kickstarts both and verifies the durable claim prevents either
payload from running again. Only its unique fixture jobs are unloaded.

## Push to talk

Tap **Control–Option–Space** (release before 300 ms) from any app to dictate to
the conversation open on the desk. Listening ends after about 1.5 seconds of quiet
after speech, a model-detected speech end, a second tap, or a 120-second safety cap. Alternatively hold the shortcut for
300 ms or longer and release to finish. Both modes send after a three-second
undo window; **Esc** or **Undo** cancels while recording or counting down.
**Control–Option–Esc** also cancels while the shortcut modifiers are held. The strip shows the destination and transcript; a successful reply
shows Sent. Failures remain visible and request a local notification. Voice sends
only ordinary replies, never decision answers or approvals.

Settings includes a separate **Desk URL** and shortcut key/modifiers. The local
`http://127.0.0.1:9410` is offered on first launch only if the desk answers.
Use HTTPS for a remote desk; deployment paths are supported. No open replyable
conversation means no microphone capture. The destination is frozen when the
session begins. Changing the open conversation during dictation does not redirect it.

The first eligible tap or hold asks for microphone access. If denied, the strip offers
Open Privacy Settings. Capture stops when input ends, on cancellation, sleep or failure.
Ad-hoc re-signing can invalidate microphone grants; the consistent Developer ID
signing step above gives the installed app a stable identity. The application
uses the local `../tango-ios/TangoDeskKit` Swift package for URL rules and native
JSON commands. Voice uses the subscription-backed desk socket, with an explicit
manual-finish flag: model delegation emits a speech-end status for latched sessions
without ending a held recording. A local PCM energy detector also ends latched
input without waiting for model delegation. It requires 120 ms above the greater of -40 dBFS or the tracked noise floor + 10 dB,
then a 1.5-second pause. The floor starts at the first audio window, tracks lower
energy immediately, and drifts upward slowly. Resumed speech requires 60 ms;
shorter impulses do not restart the pause. Initial steady noise is ignored.
Very quiet speech, speech starting without any quieter input, or changing noise
can defeat this energy-only detector;
a second tap still finishes. It keeps counters only and never records audio.

`swift test` includes a real loopback WebSocket fake (Node and the repository's
installed `ws` package required), PCM conversion, target checks, undo and failures.
For manual verification point Desk URL at a sandbox desk, hold/speak/release in
a scratch conversation, tap/speak/pause to finish automatically, then check second tap, Esc and the no-conversation case. Do not send
test replies through a production desk. Building a candidate does not install it.

### Live mic

**Live mic** in the menu-bar panel, or **Control–Option–Shift–Space**, arms
capture without sending audio. **Arm Live mic when Tango starts** is on by default.
With a valid Desk URL and an existing microphone grant, it arms automatically;
launch never prompts for microphone permission. The live-mic
shortcut is configurable separately in Settings. The icon is `mic.slash` while
armed and muted, `mic.fill` while listening, and the usual dot when off. Use the
same tap/hold dictation shortcut to speak; sending or cancelling returns to armed
and muted. The destination is resolved for each press; dictation replies still
require a replyable conversation, while approved navigation can work without one.
Armed capture starts before that lookup completes. If the lookup fails (network,
malformed response or mismatched target), or permission is denied, the queued
audio is discarded, the socket closes, and no model is activated. A successful
lookup that simply has no replyable conversation still permits navigation,
as before; it never posts dictation to an unknown destination.

Muted input is discarded on the audio callback before conversion or buffering;
there is no pre-roll, saved audio, or audio logging. Transcript recovery is stored locally as described below; diagnostics remain text-free. Arming
keeps the audio engine and an authenticated desk socket ready, but **does not
open a subscription model session**. The model leg opens on dictation, so the
armed strip shows Listening immediately and captures only audio after the press.
Those frames wait in memory until the model is ready, then flush in order.
The buffer is capped at 15 seconds of mono 24 kHz PCM (720 KB), with a
15-second connection timeout; failure or cancellation discards it.
A release or second tap before model readiness finishes capture and sends the
buffer before finishing the exchange. No idle model session is kept open. WebSocket pings every 25 seconds
check the desk leg. A stale socket gets one reconnect attempt; failure turns
Live mic off with a notification. Automatic arming retries after 2, 4, 8, 16,
32, then at most every 60 seconds; a ready connection resets that backoff. Each completed or cancelled exchange opens a fresh dormant socket.

Sleep, screen lock and input-device changes disarm Live mic. With automatic
arming enabled, wake, unlock and input changes schedule recovery after two
seconds without another change; recovery waits while locked or asleep.
There is no idle timeout in this mode. Turning Live mic off manually holds for
the session, including recovery events; only the next launch or a manual
toggle-on clears that choice. Turning off the startup setting restores manual
arming and the 30-minute idle timeout. One local notification explains an
automatic disarm (subject to macOS notification permission).

Other microphone apps such as Meet, Slack and Gather can continue using the mic.
Holding an input open keeps macOS's orange mic indicator on, and Bluetooth
headsets may switch to lower call quality. **Don't keep the mic armed on Bluetooth
headsets** is enabled by default: with Bluetooth input, only the socket stays
warm and microphone capture opens on unmute. Disable the setting only if that
tradeoff is acceptable. Unknown input transport types use the conservative
socket-only path. Saving settings disarms Live mic, then automatic arming
applies the new settings unless the session was manually turned off.

For local QA only, launch with `TANGO_VOICE_TIMINGS=1` to write startup elapsed
milliseconds to stderr (press to capture, socket ready, model ready and first
audio sent). These records contain only an exchange UUID and timings, never
text or audio; they do not change the persisted voice-event API.

## Client-only package

Build a universal (Apple Silicon and Intel, macOS 15+) GUI candidate with:

```sh
apps/tango-app/scripts/build-client.sh
```

The printed candidate path contains only the Swift executable and bundle metadata;
there is no Node executable, server LaunchAgent or server entry path. This build
uses the separate `com.tango.client` preference domain and ad-hoc signing. It is a
trial artifact, not a notarized distribution. Do not use the host installer for it.

On first launch, enter the full remote desk base URL with its path prefix.
Connection validation reads presentation and dictation metadata only; it never
starts an exchange. The microphone prompt occurs on the first dictation. Live
mic and its shortcut are unavailable in client mode until remote validation.
The menu shows the shared desk destination; dictation still freezes its target
at the start and retains the existing undo and silence-stop behavior.

`TangoClientOnly` in the bundle forces saved client mode before host construction.
Host-capable builds preserve host mode by default and expose no mode switch. Client mode offers no promotion to host. Connection errors
never change mode. App login uses `SMAppService.mainApp`, separately from the
server job. Client startup does not construct the host Store, read its token,
retire its old login item, or display server settings.

Tests: `swift test --package-path apps/tango-app` covers the startup factory gate
and stub-desk validation; Python `test_client_build.py` verifies bundle contents
and requested architectures. Remote audio, VPN recovery and live-mic validation
remain separate stages.

## Dictation history and privacy

Mac dictation history is on by default. Final text is saved locally before a reply
or voice command is attempted; its outcome is then updated to Sent, Undone or
Failed. Cancelled recordings with received text are saved before that text is
cleared. An interrupted send can remain labelled Delivery unknown: it may have
reached its destination. No audio is saved. Audio that never produced a transcript
cannot be recovered.

The private file is `~/Library/Application Support/<app bundle ID>/DictationHistory/history.json`
(`com.tango.app` for the host app). The directory is mode 0700 and the file is
0600, with atomic replacement and macOS backup exclusion. This is local plaintext,
protected by the account's filesystem permissions, not application-level encryption.
Backup exclusion is a macOS hint; third-party backup tools may not honor it.
Entries retain their original UUID and capture time, full text, destination title,
outcome and command marker. Desk sync is a separate, default-on control described
below; voice event telemetry remains text-free. Existing dictation transport still sends text to the
chosen conversation or command service as before.

History retains the last seven days, capped at 200 entries, pruning at startup,
on writes and each minute while the app runs. Expired data is removed on the next
launch if the app was closed. The menu shows the five newest entries; click to
copy. Show all history opens full text and search by text or conversation. Copy
uses the system clipboard and therefore follows the device's clipboard-sync settings.

Turn off **Save dictation history** to stop new saves; existing entries still expire.
**Clear history** removes saved text after confirmation. Failure messages claim
text was saved only after a successful local write. The popup and notification
offer Copy; a notification stores only the entry ID, never transcript text. With
history off or a disk failure, notification Copy works only while that capture's
text remains in memory. Clearing history or expiry makes its notification Copy
unavailable. Disk errors are shown in History and the menu.


### Desk history sync

**Sync new dictations to the desk** is on by default, independently of local
saving. Configure an HTTPS desk base URL ending in `.ts.net` in History; a secure voice URL is used
by default and follows saved voice URL changes until a separate history URL is set. A loopback voice connection stays unchanged and cannot authenticate
history. History requests rely on Tailscale sign-in at the server, with no client
identity claims, cookies, redirects, or transcript diagnostics.

Enrollment starts after the first successful history connection. Existing local
entries are never imported. New captures enroll when delivery completes, fails, or
is undone, so trailing final words settle before remote content is frozen. Pending
snapshots remain in local recovery only; a crash before completion does not sync them.
Subsequent callbacks update only their delivery outcome. Capture text and destination
are immutable on the server. Offline uploads survive restart; the queue and cached
All devices results each retain at most 200 entries for seven days from capture.
Private sync state lives in `DictationSync.noindex/sync.json` beside local history,
with 0700/0600 permissions, atomic replacement, orphan cleanup and backup exclusion.

Every upload attempt first fetches deletion state. A changed server generation drops
old pending uploads; entry deletion suppresses retries. Neither deletes independent
local history. Turning sync off cancels pending uploads and erases downloaded
results and refresh metadata from this Mac; re-enabling starts a new
boundary without backfilling. A request already accepted by the server cannot be
recalled by the off switch. Changing the history endpoint discards pending uploads
and cached results so text cannot follow an endpoint change. Clear local history
also cancels this device's queue and erases its downloaded results and refresh metadata. Remote Delete and Clear all devices remove synced
text; local copies and clipboard copies remain subject to their own controls.

All devices shows cached text, source-device identifiers, capture time, destination,
delivery outcome, pending upload count and last refresh. It supports search, Copy,
Delete and Clear all devices. Connection failures show a separate status and do not
block voice delivery or local recovery. A 403 clears the remote cache. Background
refresh/retention runs each minute while the app is open and at startup.

Run `swift test --package-path apps/tango-app` for regression coverage. An opt-in
live integration test uses `TANGO_HISTORY_LIVE_URL` with an authenticated private
HTTPS endpoint: it uploads synthetic text, recovers it through a second client,
and deletes only the test UUID. It never clears the owner's history.
