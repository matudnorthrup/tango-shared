# Background Job

`background_job` runs a long shell batch outside the agent's turn. Turns have a
hard wall clock; anything killed by it loses its work. A background job keeps
running after the turn ends (and across bot restarts), and when it exits the
bot posts a completion notice in the conversation that started it. That notice
arrives as a new turn for the same agent.

## Input

```json
{
  "action": "start",
  "label": "Bike GT sweep",
  "command": "node /path/to/sweep.mjs --out /path/to/results.json",
  "timeout_seconds": 3600
}
```

- `action` (required) — `start`, `status`, `list`, or `cancel`.
- `label` (start) — short human name shown in the completion notice.
- `command` (start) — script run with zsh (sh where zsh is absent) from the job's own directory.
  stdout and stderr go to `output.log` there. Use absolute paths. For anything
  more than a few lines, write a script file first and run it here.
- `timeout_seconds` (start) — default 3600, clamped to 60–14400. The job's
  process group gets SIGTERM at the limit, then SIGKILL.
- `job_id` (status, cancel).

At most 3 jobs per agent run at once. Agents only see their own jobs.

## Output

`start`, `status`, and `cancel` return `id`, `label`, `status`
(`running` / `ended` / `cancelled`), `exit_code`, `timed_out`, `elapsed`,
`dir`, and `output_path`. `status` adds `output_tail` (last ~2 KB of
output.log). `list` returns `{ "jobs": [...] }`, newest first.

## Completion notice

```
⚙️ Background job **Bike GT sweep** finished after 12m 30s.
Output: `<profile data>/background-jobs/bike-gt-sweep-1a2b3c4d/output.log` · job `bike-gt-sweep-1a2b3c4d`
Read the job output and any result files it wrote, then report the results here.
```

Other outcomes: `failed with exit code N`, `was stopped at its 1h limit`,
`ended without an exit code (killed or crashed)`.

## Usage rules

- Start the job, tell the user what is running and roughly how long, then end
  the turn. Do not poll `status` in a loop — that burns the turn clock the job
  exists to avoid.
- Make the script write results to files incrementally so a timeout or crash
  still leaves partial results.
- Cancelled jobs do not send a completion notice.
