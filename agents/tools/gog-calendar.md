# gog_calendar

Google Calendar operations through the `gog` CLI.

## Input

```json
{
  "command": "calendar events --today --all --json --account personal@example.com"
}
```

## Common commands

- `calendar events [--today] [--all] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--days N] [--max N] [--account <email>] [--json]`
- `calendar create primary --summary '<title>' --from '<ISO datetime>' --to '<ISO datetime>' [--description '<desc>'] [--account <email>]`
  - Positional arg is calendarId — use `primary` for the main calendar
  - Flags are `--summary` (not `--title`), `--from` (not `--start`), `--to` (not `--end`)

## Notes

- `--to` is exclusive.
- Use `--today` or make `--to` the following day when querying a single day.
- `--all` includes non-primary calendars.
- Accounts are installation-specific. Common patterns are `personal@example.com` and `work@example.com`.

## Output

Returns CLI output in `result`. With `--json`, event details are structured.

## Timezones

Supported and tested CLI: **gogcli v0.38.3**. Keep the shared binary pinned and
verify Calendar, Gmail, and Docs before changing versions.

- For timed creates, use `--timezone <IANA name>` (for example
  `America/Los_Angeles`), or separate `--start-timezone` / `--end-timezone`
  for travel between zones. An offset such as `-07:00` cannot identify a zone.
- Tango supplies the destination calendar's timezone when create flags omit it.
  Use an actual calendar ID or `primary`; if metadata is unavailable, supply
  explicit zones rather than guessing.
- Time updates preserve the existing endpoint zones unless explicitly overridden.
  Use `--start-timezone` with `--from`, and `--end-timezone` with `--to`.
  Recurrence-only edits retain existing zones; adding recurrence to an event
  without named zones requires both timestamps.
- Numeric offsets must match the named zone on the event date. UTC `Z`
  timestamps are also accepted as explicit instants. Check winter and summer;
  do not reuse today's offset for another season.
- Recurring events need the same named zone at both endpoints so local time
  follows daylight-saving changes. Read back occurrences across the transition.
- All-day events use date-only values and no timezone flags.
- Use `calendar create --event-type focus-time` or `--event-type out-of-office`
  for specialized timed blocks so they receive the same timezone handling.
- Dry runs may read calendar/event metadata to resolve zones, but never write.

An upgrade does not repair existing events. Audit recurring series before
one-offs, and review mismatches before changing them: another zone may be
intentional. Avoid a create-then-patch workaround, which can leave an incorrect
series if the second write fails.
