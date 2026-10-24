# Tango Dev Tools

Shared doc for `tango_shell` and `tango_file`.

## `tango_shell`

Runs a shell command in the Tango repo root.

Input:

```json
{
  "command": "npm run build",
  "timeout_ms": 120000
}
```

Output fields may include:
- `code`
- `stdout`
- `stderr`

Notes:
- `CLAUDECODE` is cleared automatically in the shell environment.
- Default timeout is `120000`.

## `tango_file`

Reads, writes, patches, or lists files inside the Tango repo.

Input:

```json
{
  "operation": "read",
  "path": "packages/discord/src/main.ts"
}
```

Supported operations:
- `read`
- `write`
- `patch`
- `list`

Notes:
- Paths may be repo-relative or absolute within the repo.
- Paths cannot escape the repo root.
- Large reads may be truncated with `truncated: true`.
