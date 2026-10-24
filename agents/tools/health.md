# health_query

Universal Apple Health data tool. Queries sleep, recovery, activity, and trends from MongoDB.

## Input

```json
{
  "command": "recovery | date | morning | checkin | trend | sleep | compare | source_breakdown",
  "date": "YYYY-MM-DD | today | yesterday",
  "days": 7
}
```

## Commands

- **recovery** — Sleep + HRV + RHR + weight + 7-day trend comparison. Default for "how did I sleep?" questions.
- **date** — Full day activity: steps, exercise, workouts, active/basal cal, TDEE, RHR, weight, BP.
- **morning** — Combined briefing: last night's sleep + yesterday's activity + today's vitals.
- **checkin** — Today's activity snapshot (steps, exercise, calories, TDEE so far).
- **trend** — Multi-day trends with averages. Use `days` param (default 7). Any range is valid — use whatever the question requires.
- **sleep** — Detailed sleep stages + HRV + RHR for a specific night.
- **compare** — Side-by-side Apple Watch/Sleep Watch vs Zepp view for a night: sleep stages, HRV, RHR, overnight HR, deltas, and tracker freshness.
- **source_breakdown** — Diagnostic source totals/freshness for a date. Use when a tracker disagrees, source data looks stale, or canonical steps/calories need a gut check.

## Parameters

- `command` (required): Which query to run.
- `date` (optional): Used by date, sleep, compare, source_breakdown. Defaults vary by command.
- `days` (optional): Number of days for trend. Default 7.

## Source Rules

- Use `date`, `checkin`, `trend`, `sleep`, or `recovery` for the stable canonical answer.
- Use `compare` for Apple Watch vs Zepp sleep/recovery questions.
- Use `source_breakdown` only as a diagnostic view. Do not manually add source totals into steps, activity, basal, or TDEE unless the source breakdown makes the deduping assumption explicit.
- If Zepp comes back empty, check the `freshness` block before concluding it was not worn; the tracker may simply be stale in MongoDB.

## Output

Returns parsed JSON from the health query script. Shape varies by command.
