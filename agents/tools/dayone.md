# dayone_read / dayone_write

The owner's Day One journal. Agents can list journals, read and search
entries, create entries, and edit entries.

**The `dayone` MCP server provides these tools** through the wellness server.
Call them as `mcp__dayone__dayone_read` / `mcp__dayone__dayone_write`.

## How it works

Day One for Mac ships its own stdio MCP server (`dayone mcp`). Each call to
these tools starts that server and runs one tool call against the local app.
There is no network hop or token. Wrapping it as governed wellness-server tools
gives every runtime the same surface. The Ollama clones only see governed tools
and ignore command entries in `mcp_servers`.

The CLI defaults to the binary inside the app bundle,
`/Applications/Day One.app/Contents/MacOS/dayone`. Set `DAYONE_CLI_PATH` to
override it. Day One's own docs install a `/usr/local/bin/dayone` symlink
instead. That step needs sudo, and the bundle path survives app updates.

## Enabling it for an agent

1. Day One: Preferences → Labs → enable the MCP server, then open
   **MCP Access Control** and turn on each journal agents may use. Nothing is
   enabled by default. Requires a Silver or Gold subscription. The server
   refuses to start while Day One's passcode lock is on.
2. Governance: grant named principals with
   `node scripts/grant-dayone.mjs --db <tango.sqlite> --principal worker:<agent> [...] --apply`.
   Fresh databases are born ungranted.
3. Agent config: add the server to the agent's `mcp_servers` (a profile overlay
   must carry the agent's complete list, because overlay arrays replace):

   ```yaml
   - name: dayone
     command: node
     args: ["packages/core/dist/mcp-proxy.js", "dayone"]
     env:
       ALLOWED_TOOL_IDS: "dayone_read,dayone_write"
   ```

   Agents with `mcp.default_servers` keep it on demand. It mounts when a turn
   mentions a journal, diary, Day One, or "on this day".

If `list_journals` comes back empty, no journal is enabled yet. Say so rather
than reporting that the owner has no journals.

## Tools

| Tool | Operations |
|------|---------|
| `dayone_read` | `list_journals` returns the enabled journals with ids and names; call it first. `get_entries` reads or searches entries: `journal_ids` / `journal_names`, `query`, `start_date` / `end_date` (YYYY-MM-DD), `on_this_day`, `limit` (default 10, max 50), and `offset` for paging. |
| `dayone_write` | `create_entry`: `text` (markdown, required), `journal_id` or `journal_name`, `date` (ISO-8601), `tags`, `attachments` (local file paths), `starred`, `all_day`. `update_entry`: `entry_id` (required), `text` (replaces the body), `tags`, which **replace** every existing tag, so merge with the current tags first, `attachments` (added), `starred`, `all_day`. |

## Judgment

- Journals are private. Quote or summarize only what the owner asked for. Don't
  deliberately file entry contents into memory, Linear, Notion, or other
  channels unless asked. A turn that reads a journal goes through the same
  post-turn memory extraction as any other turn. This guidance governs what the
  agent chooses to do, and that pipeline is not bypassed.
- Write only when the owner asks for an entry. Draft long entries back to them
  first unless they said to just write it.
- Name the journal when you write. Without `journal_id` / `journal_name`, the
  entry goes to the default journal.
