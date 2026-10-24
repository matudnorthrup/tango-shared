# notion

Read and write a Notion workspace through the official Notion API, using a
long-lived internal integration token.

Use this tool for anything in Notion — a `notion.so` / `notion.com` /
`app.notion.com` link, a page, or a database. Do **not** try to read Notion
through the `browser` tool: Notion's web UI requires an interactive login and
renders blank to automation, so the browser always fails. A blank Notion page in
a browser means "use the `notion` tool".

## Setup

Per installation, one time:

1. Create an internal integration at `notion.so/my-integrations` and copy its
   token.
2. Share each page or database the agent should reach with that integration
   (in Notion: **⋯ → Connections → add your integration**). Sharing a parent
   page also shares its children.
3. Provide the token to Tango with either:
   - `NOTION_API_KEY` — the token itself, or
   - `NOTION_1PASSWORD_VAULT` + `NOTION_1PASSWORD_ITEM` — a 1Password item read
     through the service account. The field defaults to `credential` and can be
     overridden with `NOTION_1PASSWORD_FIELD`.

`NOTION_API_KEY` wins when both are set. Which vault and item an installation
uses is profile-specific — see the profile overlay for this installation's
values, not this doc.

**The integration only sees what has been shared with it.** A `404` from this
tool almost always means "not shared yet", not "does not exist".

## Workspaces

A Notion integration token is scoped to exactly **one workspace** and cannot
reach across workspaces. An installation covering more than one — say a work
workspace and a personal one — configures a token per workspace and assigns each
agent the workspace(s) it belongs in.

This is a privacy boundary, not a convenience. An agent handling private
material must not be able to write it into a shared or employer-owned workspace,
so requesting a workspace outside your assignment is **refused**, not quietly
redirected to your default.

- Omit `workspace` to act in your default (the first one assigned to you).
- `{"operation": "list_workspaces"}` reports which workspaces you may use.
- If a page you expect is missing, check you are in the right workspace before
  concluding it does not exist — that is the usual cause of a surprising `404`.

Configuration (profile layer):

```text
NOTION_DEFAULT_WORKSPACE      name for the workspace the unsuffixed vars configure
NOTION_API_KEY_<WS>           token for named workspace <WS>
NOTION_1PASSWORD_VAULT_<WS>   1Password ref for named workspace <WS>
NOTION_1PASSWORD_ITEM_<WS>
NOTION_1PASSWORD_FIELD_<WS>
NOTION_WORKSPACES_<AGENT>     comma-separated allowlist; first entry is the default
```

`<WS>` and `<AGENT>` are upper-snake-cased (`personal` → `PERSONAL`,
`victor-ollama` → `VICTOR_OLLAMA`). An Ollama clone inherits its persona's
mapping unless it has one of its own, so `watson` and `watson-ollama` cannot
drift apart.

Mapping is only required once an installation has **more than one** workspace.
With several configured, an agent that has none is **refused** with an error
naming the variable to set, rather than being handed whichever workspace is
default. A single-workspace installation is unambiguous and needs none of these
variables.

The routing comes from the authenticated caller, never from a tool argument —
an agent cannot claim to be another one to reach its workspace.

## Input

```json
{ "operation": "search", "query": "onboarding" }
```

`page_id`, `database_id`, and `parent_id` accept either a raw id (dashed or
undashed) or a full Notion URL — the tool extracts the id.

## Operations

| Operation | Required | Optional | Returns |
| --- | --- | --- | --- |
| `search` | | `query`, `page_size`, `start_cursor` | `results[]` of `{id, object, title, url, last_edited}` |
| `get_page` | `page_id` | | `{id, title, url, last_edited, properties, content}` |
| `create_page` | `parent_id` | `title`, `markdown`, `properties`, `parent_type` | `{id, url, title, parent_kind, blocks_written}` |
| `update_page` | `page_id`, `properties` | | `{id, url, title, updated}` |
| `append` | `page_id`, `markdown` | | `{id, appended, batches}` |
| `query_database` | `database_id` | `filter`, `sorts`, `page_size`, `start_cursor` | `results[]` of `{id, title, url, last_edited, properties}` |
| `get_database` | `database_id` | | `{id, title, url, properties}` (property name → type) |
| `archive` | `page_id` | | `{id, archived: true}` |
| `restore` | `page_id` | | `{id, archived: false}` |
| `list_workspaces` | | | `{workspaces, default, configured}` |

Editing an existing page:

| Operation | Required | Optional | Returns |
| --- | --- | --- | --- |
| `get_blocks` | `page_id` | | `blocks[]` of `{id, type, text, has_children}` |
| `update_block` | `block_id` | `markdown`, `checked` | `{id, type, text}` |
| `delete_block` | `block_id` | | `{id, deleted: true}` |
| `insert_after` | `block_id`, `markdown` | | `{block_id, inserted, parent_id}` |
| `replace_text` | `page_id`, `find` | `replace`, `all` | `{page_id, replaced, blocks}` |

Every operation also accepts an optional `workspace` — see **Workspaces** above.

Aliases: `read`/`fetch` → `get_page`, `trash`/`delete` → `archive`,
`unarchive` → `restore`, `database_schema` → `get_database`.

`search` with no `query` lists everything shared with the integration — a good
first call when you do not yet know what is reachable.

`get_page` returns the page's full text, not just its properties. That is the
read path for a document.

## Markdown

`markdown` (on `create_page` and `append`) supports the subset that round-trips
with `get_page`.

Block level:

```text
# H1   ## H2   ### H3
- bullet
1. numbered
- [ ] unchecked to-do      - [x] checked to-do
> quote
---                        (divider)
```lang … ```            (code block)
```

Inline, inside any of the above:

```text
**bold**   __bold__
*italic*   _italic_
`code`
~~strikethrough~~
[label](https://example.com)
```

Notion does not parse markdown itself — inline styling is converted into
annotated rich-text runs, and `get_page` converts it back. Notes:

- Emphasis nests: `**bold with *both* inside**`.
- A code span is literal: `` `**not bold**` `` keeps its asterisks.
- Underscores inside a word never trigger emphasis, so `snake_case_name`
  survives intact.
- Backslash escapes a delimiter: `\*not italic\*`.
- Code-block bodies are literal and are never re-parsed.

Anything else becomes a paragraph. Headings deeper than `###` clamp to `###`
because Notion has only three heading levels. Long lines are split across
2000-character runs and large bodies are written in 100-block batches, both
Notion API limits.

## Editing an existing page

You do **not** need to rebuild a page to change it. Notion's unit of edit is a
block, so the flow is:

1. `get_blocks` — returns every block with its `id`, `type`, and `text`
   (as markdown, so existing bold/links are visible and matchable).
2. `update_block` / `delete_block` / `insert_after` on the ids you care about.

`replace_text` collapses the common case — "swap this wording for that" — into
one call. It rewrites whichever block holds the text, keeping that block's
inline styling. If several blocks match it **refuses and lists the candidates**
rather than guessing; pass `all: true` to change every one.

Rules worth knowing:

- A block keeps its type. Rewriting a bullet leaves it a bullet — Notion cannot
  change a block's type. To change type, `delete_block` then `insert_after`.
- Because the type is preserved, `markdown` for `update_block` may repeat the
  marker or not: `"- new text"` and `"new text"` both yield `- new text` on a
  bulleted block.
- `checked` ticks or unticks a `to_do` without touching its text.
- Blocks with no editable text (dividers, child pages) are refused by
  `update_block` — delete and re-insert instead.

Rebuilding a page as a "new version" costs the URL and any edits made by a human
in the meantime. Prefer editing in place; create a fresh page only when the user
asks for one.

## Pages vs database rows

`create_page` writes to whichever parent it is given:

- **Parent is a page** → a normal sub-page. Body comes from `markdown`.
- **Parent is a database** → a new row. `title` fills the database's title
  property (whatever it is named), and `properties` supplies the other columns
  in Notion property JSON.

The parent type is auto-detected. Pass `parent_type: "page"` or `"database"` to
skip the probe.

Call `get_database` first when writing rows — you need the real property names
and types before you can build `properties`.

## Examples

Find what the integration can reach:

```json
{ "operation": "search", "query": "release notes" }
```

Read a document from a link:

```json
{ "operation": "get_page", "page_id": "https://www.notion.so/Example-Page-00000000000000000000000000000000" }
```

Create a sub-page with structure:

```json
{
  "operation": "create_page",
  "parent_id": "00000000000000000000000000000000",
  "title": "Weekly Summary",
  "markdown": "## Highlights\n- Shipped the importer\n- [ ] Follow up on metrics\n\n> Blocked on review"
}
```

Add a database row:

```json
{
  "operation": "create_page",
  "parent_id": "00000000000000000000000000000000",
  "title": "New request",
  "properties": { "Status": { "select": { "name": "In progress" } } }
}
```

Query a database:

```json
{
  "operation": "query_database",
  "database_id": "00000000000000000000000000000000",
  "filter": { "property": "Status", "select": { "equals": "In progress" } },
  "sorts": [{ "timestamp": "last_edited_time", "direction": "descending" }]
}
```

Append to an existing page:

```json
{ "operation": "append", "page_id": "00000000000000000000000000000000", "markdown": "## Update\nDeployed at 14:00." }
```

## Governance

`search`, `get_page`, `get_blocks`, `query_database`, `get_database`, and
`list_workspaces` are classified **read**. Everything else — including
`archive`, `restore`, and the block-editing operations — is **write**, and an
unrecognized operation is treated as a write so a mutation can never be waved
through as a read.

## Notes

- `archive` moves a page to Notion's trash; it is reversible with `restore`.
  There is no hard-delete through this tool.
- Nested blocks (toggles, list children, columns) are followed three levels deep
  on read and indented in the returned text.
- A workspace may hold confidential material. Treat page contents as sensitive:
  do not copy them into repo files, commit messages, or issue trackers.
