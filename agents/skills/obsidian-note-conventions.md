# obsidian_note_conventions

Reusable conventions for reading and writing notes in the main Obsidian vault.

## Writing notes

- **Always read before writing.** Print the note first so you have the full current content.
- **Always use the `content` parameter** for note body text. Never put content inline in the command string via `--content '...'` — apostrophes and special characters break the shell quoting.
- Prefer updating an existing note before creating a new one.
- Do not create new folders unless the task explicitly requires it.
- Preserve the note's existing structure, sections, and frontmatter style when editing. Don't reorganize what you weren't asked to change.
- For existing daily notes, **do not use `create --overwrite`**. Use the `section` command for generated planning sections and the `frontmatter` command for metadata fields.
- For non-daily notes, use `create --overwrite` only after reading the note and preserving all current content that should remain.
- Treat daily-note sections `Notes`, `Interstitial Log`, `Other Work`, `Energy Reflection`, and `Notes from Last Night` as human-owned. Never replace them. Append only when explicitly asked to add a new entry.

## Frontmatter

- New structured notes should include frontmatter: `date`, `areas`, and `types` at minimum.
- `types`, `areas`, and `collections` must be YAML lists of wikilinks. Never write these as scalar strings.
- Use approved area schema values from `_Schema/Areas/`. The approved area list is profile-configured; read `_Schema/Areas/` (or the profile overlay) for the installation's allowed areas. Do not invent areas.
- Do not use `Travel`, `Projects`, or `Work` as areas. Use a specific approved area, and use `collections` for finite trips, events, initiatives, or bundles that cut across areas.
- Do not use `Planning` or `Project` as types. Use `Project Plan` for plan artifacts, or the specific daily/weekly/quarterly type for temporal planning notes.
- Do not add `tags` or `categories` to new notes unless the user explicitly asks for that workflow. Categories are deprecated; collections are the preferred cross-cutting grouping field.
- Do not add `source_kind: canonical` by default. Use `source_kind` only when provenance, source/derived review, log/record handling, or write-governance matters.
- Frontmatter goes between `---` delimiters at the top of `.md` files only. Never add `---` delimiters to `.base` files.

Current default pattern:

```yaml
---
date: YYYY-MM-DD
types:
  - "[[Project Plan]]"
areas:
  - "[[Personal]]"
collections:
  - "[[Hub Note]]"
---
```

For trip planning notes, use `types` with a `[[Project Plan]]` list item, choose the best approved area, and add the trip or planning hub under `collections`. For example, a recurring-trip series should use an approved `areas` value (such as `[[Personal]]`) plus a `collections` entry pointing at the trip's master/hub note, not `areas: Travel`. The profile overlay carries any installation-specific hub examples.

## Tasks

- Keep task lines terse and action-oriented.
- **Daily/weekly notes:** `- [ ] Task name (Xhr) [[Area]]` — estimate in parens, area link at end. See `daily_planning` skill.
- **Current Task Rotation:** use top-level daily-note task checkboxes only. The orientation nudge system treats the first unchecked item in `## Current Task Rotation` as the current task. All items carry forward into each new daily note automatically, checkbox state preserved — the rotation is multi-day work and must never be duplicated into `Today's Priorities`. A checked box means the user nudged that item on the current pass, **not** that it's finished; never move, complete, or remove a rotation item without their explicit direction.
- **Area backlogs:** `- [ ] Task description (Xhr)—YYYY-MM-DD` — estimate in parens, date added after em-dash. See `backlog_management` skill.

## Base files (`.base`)

Base files live in `_Schema/Types/` and define filtered views embedded in notes via `![[Name.base]]`. They are **not markdown** — they use a YAML-like DSL with expression-based filters.

### Critical rules

- **No `---` frontmatter delimiters.** Base files start directly with content. Adding `---` causes "multiple documents" parse errors.
- **Filters use expression strings**, not `property/operator/value` objects. Write `file.tags.contains("daily")`, not `{property: tags, operator: contains, value: daily}`.
- **Every base file needs a `views` section.** Without it the base won't render.

### Filter syntax

```yaml
filters:
  and:          # combine with and/or/not
    - expression == value
    - property.contains("string")
    - property.contains(link("Note Name"))
    - property == link(this.file.name)
```

Available expressions:
- `file.name`, `file.tags`, `file.links` — file metadata
- `this.file`, `this.file.name` — the note embedding the base (for contextual filtering)
- `.contains()`, `.toString()`, `==`, `!=` — operators
- `link("Note Name")`, `link(this.file.name)` — wiki-link references
- Negate with `!` prefix: `'!file.tags.contains("daily")'` (quote the whole expression)

### Examples from working base files

**Filter by type property:**
```yaml
filters:
  and:
    - type.contains(link("Health Daily"))
views:
  - type: table
    name: Table
```

**Contextual filter (show notes related to the embedding note):**
```yaml
filters:
  or:
    - file.name.contains(this.file.name)
    - created.toString().contains(this.file.name)
    - file.links.contains(this.file)
views:
  - type: table
    name: Table
```

**Filter by frontmatter link property:**
```yaml
filters:
  and:
    - week == link(this.file.name)
views:
  - type: table
    name: Table
```

**View with ordering and grouping:**
```yaml
filters:
  and:
    - type.contains(link("Recipes"))
views:
  - type: table
    name: Table
    groupBy:
      property: meal
      direction: ASC
    order:
      - file.name
      - meal
```

**View-level filters (filter within a view, separate from top-level filters):**
```yaml
views:
  - type: table
    name: Table
    filters:
      and:
        - reviewed == false
    order:
      - file.name
      - reviewed
```
