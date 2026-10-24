# Orientation Nudge System

The orientation nudge system helps recover attention during reactive days by
checking whether the daily note has gone stale and sending a low-friction
Discord check-in.

## Trigger Rules

The deterministic schedule runs every 15 minutes and sends a nudge only when all
conditions are true:

- Local time is inside active hours, default 5:00am to 8:00pm.
- No recent daily-note activity, default 60 minutes.
- No current timed calendar event.
- Focus mode is not active.
- Vacation mode is not active.
- No unanswered active nudge is pending.
- Cooldown and minimum nudge interval have elapsed.

Calendar checks use `gog calendar events --all` by default. If
`ORIENTATION_NUDGE_CALENDAR_ACCOUNTS` is set, the runtime queries each listed
account explicitly. Timed events suppress nudges, including focus blocks,
tentative events, and travel. All-day events do not suppress nudges.
Timed events whose title starts with `Block:` are placeholders and do not
suppress nudges.

## Daily Note Contract

The `## Interstitial Log` is the only source of truth for what the user is
doing. The nudge task is the latest timestamped interstitial entry, full stop.

The `## Current Task Rotation` section is deliberately **not** used to name the
task. Rotating is itself a mode: when the user is working the rotation, the log
gets a single `Task rotation` entry and the nudge asks about that mode — never
about an individual item inside the rotation. Cycling between rotation items is
not a task transition. Flipping into focused work on one thing *is* a
transition, and gets its own log entry naming that work; from then on the
rotation is assumed to be over until a new `Task rotation` entry appears.

Rotation edits still count as daily-note activity for the staleness timer — they
just never supply the task name.

When there is no interstitial entry yet, the nudge does not guess. It asks
`What are you working on right now?`, and the answer becomes the first log
entry.

Scheduled/background reads and writes use direct filesystem I/O against the
vault, not Obsidian MCP.

## State

Runtime state lives in profile `tango.sqlite`:

- `orientation_nudge_state` stores focus/vacation modes, recent note activity,
  active nudge metadata, unanswered counts, and cooldowns.
- `orientation_nudge_events` stores state-transition events for review.

The `Yes` button logs only to SQLite. The `No` modal appends an explicit new
interstitial log entry because the user typed a new task.

## Discord Flow

The nudge message uses buttons:

```md
Are you still working on **[latest interstitial log entry]**?
```

With no interstitial entry for the day, the message is instead
`What are you working on right now?`.

- `Yes` confirms and snoozes.
- `No` opens a task modal and appends the new task to the interstitial log.
- `Focus Mode` opens a task modal and silences nudges for the default focus
  duration.
- `Vacation` opens an end-time modal and silences nudges until that time.

Only the latest active nudge can be answered. Stale clicks get an ephemeral
expired response.

## Cooldown

Ignored nudges are marked after the configured ignore window, default 30
minutes. The first two ignored nudges wait for the normal next eligible ping.
After that, cooldown doubles from the configured base interval up to the max.

## Watson Control

Watson can use `orientation_nudge` to read status, set/clear focus mode, and
set/clear vacation mode with an explicit end date/time. Do not rely on prompt
memory alone for these modes.
