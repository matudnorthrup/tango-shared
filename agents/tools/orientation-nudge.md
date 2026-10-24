# orientation_nudge

Read or change the orientation nudge system state.

## Input

```json
{
  "operation": "set_vacation",
  "until": "2026-07-02 20:00"
}
```

## Operations

- `status` — show focus mode, vacation mode, cooldown, last nudge, and recent activity state.
- `set_focus` — silence orientation nudges for focused work. Pass `task` and either `until` or `duration_minutes`.
- `clear_focus` — turn off focus mode.
- `set_vacation` — silence orientation nudges until an explicit end. Pass `until`; when omitted, the runtime defaults to one week.
- `clear_vacation` — turn off vacation mode.

## Notes

- Use ISO timestamps, `YYYY-MM-DD`, or `YYYY-MM-DD HH:mm` for `until`.
- `status` is read-only. All other operations mutate `tango.sqlite`.
- Watson may set vacation/focus end times directly with this tool; do not rely on prompt memory alone.
