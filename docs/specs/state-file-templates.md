# State-File Templates

Copyable templates for project-arc **state files** (Unified Memory System,
Slices 1–2). Copy one into the vault (e.g. `_Schema/Templates/`) and fill it in,
then link the conversation with `scripts/link-project-state.ts`.

**Contract the system consumes** (see `unified-memory-system.md` §5):
- Frontmatter: `date`, `types`, `areas` are required on governed notes;
  `status:` drives reseed status; `state_managed: true` marks it contract-governed.
- `## Quick Read` — the current-state summary read on reseed.
- `## Open Items` — `- ` bullets become the open-items list on reseed.
- Everything else is free narrative.

Governance:
- The state file itself is `source_kind: canonical` — the agent **may** edit it.
- True source material (filings, signed docs, originals) gets `source_kind: source`
  (or `reference`) → the agent **cannot** modify it without `--force`.
- Working drafts that need history get `versioned: true` → prior versions are
  snapshotted before each edit (`obsidian versions '<note>' [--restore <stamp>]`).

---

## Template — Trip / Project Plan

```markdown
---
date: 2026-06-02
types:
  - "[[Project Plan]]"
areas:
  - "[[Personal]]"
status: planning
state_managed: true
source_kind: canonical
---

# <Trip name>

## Quick Read
One short paragraph: where this stands right now, the single most important
open decision, and the next action. Keep it current — this is what the agent
re-reads after a rotation.

## Open Items
- <decision or task that is still open>
- <booking / logistic still to confirm>

## Plan
<itinerary / details — evolves freely>

## Decisions Log
- 2026-06-02 — <decision made and why>
```

---

## Template — Legal Matter (generic; no case content)

```markdown
---
date: 2026-06-02
types:
  - "[[Project Plan]]"
areas:
  - "[[Personal]]"
status: active
state_managed: true
source_kind: canonical
---

# <Matter name>

## Quick Read
Current posture in one short paragraph: phase, the next deadline, and the single
most important open question. This is the reseed summary.

## Key Dates
- <YYYY-MM-DD> — <hearing / filing deadline / response due>

## Parties
- <role> — <name/firm>

## Document Index
Source filings are read-only (`source_kind: source`); working drafts are
editable and versioned (`versioned: true`).
- [source]  <filed/official document> — `source_kind: source`
- [working] <draft being prepared>     — `versioned: true`

## Open Items
- <question to raise with advisor>
- <draft to revise / document to gather>

## Decisions Log
- <YYYY-MM-DD> — <decision and rationale>
```

> When working a legal matter: mark the actual filed/source documents
> `source_kind: source` so they cannot be altered, and mark drafts
> `versioned: true` so every revision is recoverable.
