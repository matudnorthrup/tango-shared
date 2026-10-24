# daily_planning

Reusable workflow guidance for daily planning, evening check-ins, and weekly planning.

## Morning Planning

### Phase 0: Gather (silent)

Collect all inputs silently before presenting anything:

1. Today's date and day of week.
2. Today's calendar events from all configured accounts. Always use `--all` to include non-primary calendars (the profile-configured calendar set).
3. Today's daily note — pre-scheduled tasks, any "Notes from Last Night" context.
4. Yesterday's daily note — unchecked items are carryover candidates.
5. Current week plan — outstanding weekly tasks not yet scheduled.
6. Calculate available hours: allocatable window is the profile-configured waking window (default 5am–9pm) minus fixed calendar events. Ignore `Block:` prefix events.

7. Linear issues assigned to you — IC Work → schedule as tasks, Watching/Reviewer → awareness only.

**Not yet available as tools:** Slack saved items (→ add to the Work Backlog). Skip until tool is wired.

### Phase 1: Data Completion

If any tasks lack time estimates, ask before proceeding:

> "A few tasks need time estimates: [list]. Roughly how long for each?"

One question, not a list of five. Do not proceed to framing until estimates are captured.

### Phase 2: Framing

Present conversationally:

> Today is [Day], [Date]. You have about [X] hours available.
>
> Outstanding weekly tasks: [list with estimates]
> Already scheduled today: [list or "Nothing"]
> Carried over from yesterday: [list or "Nothing"]
>
> What else is on your mind for today?

Wait for response before continuing.

### Phase 3: Planning

After response, propose a time-blocked agenda filling gaps around existing events. Present as a **time-blocked table** showing existing events + proposed task blocks.

- **Weekdays:** Work gets the primary block of focused time. Remaining time is for personal, family, home, and project work. Small tasks (<1hr) go under `Other Work`, not `Today's Priorities`.
- **Weekends:** Family and personal priorities come first. Work only if urgent.

### Phase 4: Confirm & Create

1. Present the COMPLETE time-blocked agenda for confirmation.
2. Check for conflicts using the Calendar Classification and Conflict Check rules below.
3. Create calendar blocks for ALL agreed tasks (personal tasks → personal account, work tasks → work account). **Time blocks live on the calendar, not the daily note.**
4. Update the daily note using targeted `section` writes only: `Today's Priorities` (replace) and `Other Work` (`--append` only — it is human-owned) — task names with estimates and area tags, no time-of-day information. Do NOT use `create --overwrite`, and do NOT add a time block table or schedule grid to the daily note.
5. Handle deferrals — if tasks are pushed to a specific future day, create or update that day's daily note with the task under `Today's Priorities`.

## Evening Check-in

1. **Status check** — "What got done today? Anything to check off?" Update daily note completions.
2. **Unscheduled work** — "What did you work on that wasn't on the plan?" Append under "Other Work" with rough time if known. Reveals where time actually goes vs. plan.
3. **Energy reflection** — "How did today feel — overloaded, sustainable, or light?" Log under "Energy Reflection" for capacity calibration over time.
4. **Carryover review** — List incomplete tasks. "These didn't get done. Move to tomorrow, defer to later this week, or drop?" Don't lock in — morning may shift priorities. Just capture intent.
5. **Tomorrow preview** — Fetch tomorrow's calendar. "Tomorrow you have [meetings]. [X hours] available." Ask: "Anything you already know needs to happen tomorrow?"
6. **Note to tomorrow self** — "Anything you want tomorrow-you to know? Context that might get lost overnight?" Save to tomorrow's daily note under "Notes from Last Night."

## Weekly Planning

1. **Review previous week** — what got done vs planned? Fill in the Retro section of last week's plan.
2. **Count focus hours** — scan next week's calendar (both accounts, `--all`) for fixed events. Calculate available deep work hours per day.
3. **Drive time planning** — scan for events with locations. Add drive time blocks using known/estimated drive times for those locations.
4. **Groom backlogs** — review each area backlog per the `backlog_management` skill. Remove items older than 30 days, add missing time estimates where easy.
5. **Select tasks** — pull from area backlogs (`[Notes Root]/[Area] Backlog.md`), match to available time.
6. **Draft week plan** — tasks with time estimates mapped to specific days.
7. **"Don't do" list** — explicitly name what's deferred this week.

Day mapping: early week front-load team-dependent work, midweek opens space for personal and project tasks, Friday is for wrap-up and stretch goals, and weekends prioritize family and personal work unless something urgent lands.

## Calendar Classification

Map each configured calendar to one of these classes. The specific calendar
names and which class each belongs to are profile-configured.

| Type | Treatment |
|------|-----------|
| **Fixed** | Immovable — subtract from available time |
| **Informational** | Reference only — don't subtract |
| **Flexible** | Prefer to keep, can move if necessary |

Special rules:
- **`Block:` prefix** — protective holds to prevent meetings, NOT commitments. Ignore when counting available time.
- **Arrival windows** (e.g. "<Name> 2-4pm") — workable time until they arrive; don't block the full window.
- **Protected recurring blocks** (e.g. a fixed-time workout) — never schedule over them. The profile configures which blocks and their times.
- **Lunch** — schedulable; the user may eat while working. The profile configures the typical time.

## Conflict Check Process

Before creating time blocks:
1. List ALL existing events including exercise/walk events, meals, and family/school events.
2. Flag conflicts between existing events (e.g. a sports game overlapping an evening walk).
3. Ask about alternatives for conflicted recurring events (move earlier? skip today?).
4. Never schedule task blocks over protected exercise or walk events.
5. Lunch is schedulable — the user may eat while working.

## Task Format

`- [ ] Task name (Xhr) [[Area]]`

Time estimate in parentheses, area link at end. Consistent across daily notes, weekly plans, and task lists.

## Daily Note Structure

File: `Planning/Daily/YYYY-MM-DD.md`

Sections in order: Current Task Rotation, Today's Priorities, Other Work, Notes, Interstitial Log. Ends with `![[Daily.base]]` when the template includes it.

`Interstitial Log` — not the rotation — is the orientation nudge's source of truth for
what the user is doing right now. The nudge asks about the latest log entry and never
names an item inside the rotation. See "Rotation Is a Mode, Not a Task" below.

`Current Task Rotation` uses top-level task checkboxes only; nested checkboxes are ignored
by the parser.

The rotation is **multi-day work that carries across days**, not a daily list. When a
new daily note is created, all rotation items carry forward from the most recent
prior note automatically, checkbox state preserved. Never reset it, and never re-derive it from scratch.

**A checked box in the rotation does NOT mean the item is done.** The user may use the checkbox
as a "I've nudged this one this pass" marker. They can work down the list checking things off,
then uncheck the whole list and start another pass. So:

- **Never move a rotation item into `Other Work`, mark it complete, or drop it from the
  rotation on the strength of a checkmark.** Only do it when the user says explicitly that
  the item is finished.
- **But when they do say it's done, move it — immediately, without asking.** "X is done",
  "X is finished", "you can close X" all mean: strip it out of the rotation and append it
  to `Other Work` as a checked `- [x]` line. No sub-headings — the checkmark *is* the
  record. Do not leave it in the
  rotation and offer to move it; the say-so *is* the instruction. This applies whether the
  box was checked or not, and whether or not it was marked blocked.
- Checked rotation items carry forward like any other rotation item. Don't "clean them up."
- Don't uncheck the list for the user either — the reset is their move, not yours.

### Blocked Rotation Items

Blocked work stays in the rotation — it is not a separate section. Mark it inline:

```
- [ ] 🚧 Refine discovery controls — blocked: waiting on a collaborator to answer open questions
```

Rules:

- **Format:** leading `🚧 `, then the normal item text, then ` — blocked: <why>`. The
  reason must say what would unstick it ("waiting for a collaborator to reply",
  "needs the integration fixed first"), not just "blocked".
- **Sort blocked items to the bottom** of the rotation, relative order preserved. Carry-forward
  does this automatically; do the same when editing by hand.
- **Blocked items sink to the bottom and are skipped when picking what to work next.** The
  nudge never names rotation items at all (see below), so blocking one has no effect on it.
- **Unblocking is the user's call**, same as completion. When they say it's unstuck, strip the
  🚧 and the blocked note and move the line back up with the live work. Don't infer that a
  blocker cleared.
- Blocked items still carry forward and still keep checkbox state. Never drop one.
- If nothing is blocked, nothing changes — no marker, no empty subsection.

### Rotation Is a Mode, Not a Task

The user works the rotation by cycling through every item in one pass — each one is a
short hand-off to an AI agent, so no single item is "what he's working on." **Moving
between rotation items is not a task transition and must not produce log entries.**

- Starting a pass logs **one** entry: `Task rotation`. That is what the nudge asks about
  for as long as the pass runs.
- The orientation nudge reads only the latest `Interstitial Log` entry. It must never
  name a rotation item, and it does not care what the rotation currently contains.
- Flipping into focused work on one thing **is** a transition: log that work by name. From
  then on assume the rotation is over until a new `Task rotation` entry appears.
- When the user indicates a rotation pass is underway and there's no current `Task
  rotation` entry, append one (`HH:MM — Task rotation`).

## What Belongs in Today's Priorities

`Today's Priorities` is for things that need a decision or a nudge *today* and would
otherwise be missed. Keep it to 3-5 items. Do NOT pad it.

**Never list as a priority:**
- **Current Task Rotation items.** The rotation already tracks them and the orientation
  nudge already surfaces them. Duplicating them into priorities is noise. If a rotation
  item genuinely must land today, say so on the rotation line, don't copy it up.
- **Recurring meetings** of any kind. They're on the calendar; the calendar already provides the reminder.
- **Work meetings**, recurring or not. Same reason.
- **Standing review habits** — "Review open Linear issues", "check Slack saved items",
  "groom the backlogs" and the like. They're ongoing hygiene, not a decision that has to
  happen today, and they carry forward forever without ever getting done. Never surface
  them as a priority, including as a carryover. A *specific* Linear issue with a real
  deadline is fine; "review the issues" is not.
- Anything already excluded by the email triage rules.

**Fine to list as a priority:**
- **Non-recurring personal or family calendar events** — a doctor's appointment, a school
  thing, a one-off appointment they could plausibly forget.
- Genuine one-off work that isn't already in the rotation, with a real deadline today.
- Flagged items from the brief that require the user personally to act.

When in doubt, leave it out — a short accurate priority list beats a padded one.

## What Belongs in Other Work

`Other Work` is the single catch-all shelf below the rotation. It replaced the old
`Stretch (if capacity)` and `Unscheduled Work I Did Today` sections. It holds three things:

- **Spare-capacity tasks** — small or optional work worth doing if the day opens up.
- **Unscheduled work actually done** — captured at the evening check-in, checked off.
- **Finished rotation items** — but *only* when the user explicitly says the item is done.
  A checkmark in the rotation is a nudge marker, not completion (see above). On their say-so,
  move the line down here immediately: remove it from the rotation and append it as a
  checked line, e.g. `- [x] Fix Chrome (Claude)`. **No sub-headings** — `Other Work` is one
  flat list. A checked box here means done; that's the whole record. (Unlike the rotation,
  where a checkmark only means "nudged this pass.")

**Never list here:**
- **Current Task Rotation items the user hasn't declared finished.** Same rule as priorities —
  the rotation tracks them and the nudge surfaces them; copying them down is duplication.
  This includes *checked* rotation items: checked ≠ done.
- Recurring or work meetings.

The section is human-owned: append to it, never replace it wholesale.

**Feedback loop:** when the user says a given item or category isn't helpful, don't just drop
it from today's note. Update this section (or the email triage rules, if it's email-sourced)
so the rule sticks, and tell the user what was changed.

Frontmatter must include `morning_review_completed` and `evening_review_completed` booleans. Set the appropriate one to `true` when starting the corresponding workflow.

The daily-note sections `Notes`, `Interstitial Log`, `Other Work`, `Energy Reflection`, and `Notes from Last Night` are human-owned. Never replace them with a full-note rewrite. Append only when explicitly asked to add an entry.

## Philosophy

- **Nudge, not taskmaster** — protect time for what matters.
- **Work with real capacity** — not idealized capacity.
- **Every yes is a no** — to something else.
- **Walks and thinking time ARE strategic work.**

## Behavior Rules

- Do work silently — gather all data before presenting.
- Be succinct — present conclusions, not methodology.
- One question at a time — wait for response before continuing.
- No bullet dumps — speak naturally, as if the user is listening while walking.
