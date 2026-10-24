# obsidian

Obsidian vault access through `obsidian-cli`.

## Input

```json
{
  "command": "print '2026 Week 10 Plan' --vault <vault-name>"
}
```

For writes, use the separate `content` parameter for note body text:

```json
{
  "command": "section 'Planning/Daily/2026-03-13' --vault <vault-name> --heading \"Today's Priorities\"",
  "content": "- [ ] Review budget (1hr) [[Personal]]"
}
```

## Common commands

- `print '<note name>' --vault <vault-name>`
- `search-content '<term>' --vault <vault-name>`
- `create '<note name>' --vault <vault-name> --overwrite` (with `content` parameter)
- `create '<note name>' --vault <vault-name> --append` (with `content` parameter)
- `section '<note name>' --vault <vault-name> --heading '<heading>'` (with `content` parameter)
- `section '<note name>' --vault <vault-name> --heading '<heading>' --append` (with `content` parameter)
- `move '<source>' '<dest>' --vault <vault-name>`

## Notes

- Use the installation's default vault unless the task explicitly says otherwise.
- **Read before writing.** Use `print` first so you have the current note content.
- For existing daily notes, **do not use `create --overwrite`**. Use `section` for generated sections and `frontmatter` for frontmatter fields.
- For non-daily notes, use `create --overwrite` only after reading the note and preserving all current content that should remain.
- Protected daily-note sections (`Notes`, `Interstitial Log`, `Other Work`, `Energy Reflection`, `Notes from Last Night`) are human-owned. Do not replace them; append only when explicitly asked to add a new entry.
- **Always pass note body via the `content` parameter**, not `--content` in the command string. This avoids quoting issues with apostrophes and special characters.
- If a note write includes raw `&` characters, verify the saved file immediately after writing. In this environment some Obsidian writes can truncate at `&`; prefer `and` when wording allows.
- Note-writing conventions live in `agents/skills/obsidian-note-conventions.md`.

## Output

Returns CLI output in `result`.
