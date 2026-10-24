# Working and away (big-job gate)

The main Mac is the owner's workstation and also runs the night backup, media sync, disk scans and worktree
sweeps. One switch says which it is right now, and the few big jobs ask it before they start.

## The switch

- `packages/system/src/mode.ts`: **working** (default) or **away**.
- A manual choice wins until it expires (`away --hours N`) or is changed. It lives in
  `<profile>/data/work-mode.json`.
- Otherwise an optional weekly file, `<profile>/config/system/work-windows.yaml`, says when the Mac is away:

  ```yaml
  away:
    - days: [mon, tue, wed, thu, fri]   # the day the window starts on; omit for every day
      from: "21:00"
      to: "03:00"                        # at or before `from`: runs past midnight
  ```

- `tango-mode` shows or sets it (`away [--hours N]`, `working`, `auto`). The desk's System page has the same
  buttons ("I'm away", "Away 8 h", "I'm back") through the `mode.away` / `mode.working` commands.

## The gate

`tango-mode gate [--minutes N] [--gb N] [--path P] [--force]` exits 0 when a big job may run and 75 when it
should wait (the reason is on stderr). It allows a run only when the Mac is away, the away window has `N`
minutes left (when the job says), and the volume has `N` GB free (when the job says).

A job calls it before it starts and, if it works in pieces, before each piece. `--force` is for the owner
saying "run it now".

## Not built

Idle detection, per-job contracts for every schedule, calendar-driven windows. See the exploration that
led here (Tango thread "working windows and maintenance windows").
