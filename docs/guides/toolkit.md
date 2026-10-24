# Personal toolkit mounts

`npm run cli -- toolkit sync` reads the active Tango profile's
`config/toolkit.yaml` and mounts its MCP tools into explicitly listed Claude and
Codex configs. Keep the real manifest in the profile layer; it contains personal
client locations and worker selections. No credentials belong in the manifest.

```yaml
version: 1
id: personal-toolkit
port: 9100
tools:
  tango-example:
    toolId: example
    workerId: assistant
    readOnly: true
    workspaces: [example-workspace] # Documentation only; server allowlists apply.
clients:
  - kind: claude
    configPath: ~/.claude.json
  - kind: claude
    configPath: ~/.claude-example/.claude.json
    include: [tango-example]
  - kind: codex
    configPath: ~/.codex/config.toml
    exclude: []
```

Use `--manifest /absolute/path/toolkit.yaml` to select a different manifest.
`include` defaults to all tools; `exclude` is applied afterward. Workspace notes
never grant access: the running Tango server applies the selected worker's
allowlists. The proxy comes from the CLI's Tango installation, which must have
its core package built. `--install-dir /path/to/tango` explicitly selects another
built installation (useful when running a development CLI against a stable install).

Preview with `--dry-run`, then run without it. The preview shows changed server
entries only, avoiding unrelated client credentials. On first migration, use
`--adopt-existing` in both commands: it only adopts entries whose complete config
already matches the manifest. Other collisions fail without writing any client.

The `TANGO_TOOLKIT_OWNER` environment marker records the manifest id. Keep that
id stable. Sync updates or removes only servers with that marker; another
manifest's entries and unrelated servers remain untouched. Remove a tool (or
exclude it for a client) to unmount it. To retire a client, keep it listed with
`include: []`, sync, then remove the client from the manifest.

Each changed existing config gets a timestamped `.bak-toolkit-*` sibling before
an atomic replacement. Backups are private (mode 0600). Restore that backup to
undo a sync. New files have no predecessor and can be removed to undo creation.
Sync is atomic per file, not across clients: an I/O failure may leave earlier
clients updated; inspect the output and rerun. Concurrent config edits detected
before replacement stop the sync. Avoid running client config writers concurrently.

Codex sections outside changed server tables retain their original text and
comments. Unusual TOML layouts (such as inline server tables) fail closed rather
than rewriting the document. Claude JSON preserves all unrelated values but is
formatted with two-space indentation when changed. Repeat runs with no changes
leave bytes and timestamps untouched and create no backups.

Validation: `npm run test -w @tango/cli`, `npm run build -w @tango/cli`.
After syncing, run `claude mcp get <server>` for each `CLAUDE_CONFIG_DIR` and
parse the Codex config. Existing agent sessions may need restarting to load mounts.
