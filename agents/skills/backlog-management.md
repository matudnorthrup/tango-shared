# backlog_management

Conventions for area backlog files in the Obsidian vault.

## Purpose

Backlogs are a dumping ground for ideas and tasks that don't fit into the current weekly or daily plan. They are **not commitments** — they're a queue that gets groomed. Good ideas always come back, so removing items is healthy.

Files: `[Notes Root]/[Area] Backlog.md` for approved areas that actually need a backlog. Use the profile-configured approved area list (see `obsidian_note_conventions` and `_Schema/Areas/`); create a backlog only for areas that actually need one.

Do not create backlog files for deprecated/vague areas such as Projects, Travel, or Work. Use a specific approved area, or use a collection/hub note when the grouping is a finite trip, event, or initiative.

## Item format

```
- [ ] Task description (Xhr)—YYYY-MM-DD
```

- **Time estimate** in parentheses — include when known, omit if unknown. Use `Xhr`, `Xm`, or `X.Xhr` (e.g., `(2hr)`, `(30m)`, `(0.5hr)`).
- **Date added** after em-dash — always include. This is the date the item entered the backlog, not a due date.
- Both fields matter: estimates enable scheduling during weekly planning, dates enable grooming.

Examples:
```
- [ ] Implement feature X (4hr)—2026-03-13
- [ ] Research options for project Y—2026-03-13
- [ ] Build feature Z (8hr)—2026-02-15
```

## Ordering

- **Append new items to the bottom** of the Backlog section.
- Oldest items naturally rise to the top and become candidates for scheduling or removal.
- Do not reorder items unless the user asks.

## File structure

```markdown
---
types:
  - "[[Backlog]]"
---
## Backlog
- [ ] Oldest item (Xhr)—YYYY-MM-DD
- [ ] Newer item—YYYY-MM-DD
```

Keep it flat. One `## Backlog` section with a simple checkbox list. Completed items can be checked off but should be cleaned out during grooming. Sub-sections (like `## Phone Calls`, `## Research`) are fine if the user organizes that way — preserve what's there.

## Grooming (during weekly planning)

During the weekly planning workflow, review each area backlog:

1. **Remove items older than 30 days** that haven't been scheduled. If the idea matters, it'll come back.
2. **Promote items** to the weekly plan if they're ready to schedule this week.
3. **Add estimates** to items that are missing them, if the user can provide a quick estimate.
4. Don't ask about every item — flag the stale ones (30+ days) and the estimable ones in a batch.

## Adding items

When the user mentions a task that doesn't belong in today's or this week's plan, add it to the appropriate area backlog. Always include the date added. Ask for a time estimate if natural, but don't block on it.

## Priority reference

The vault contains a `Task Priority Reference Guide.md` with P1–P4 definitions. These are for the user's mental model when deciding what to schedule, not fields on backlog items. Don't add priority tags to backlog items unless the user asks.
