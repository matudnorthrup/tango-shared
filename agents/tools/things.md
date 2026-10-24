# Things

`things_read` and `things_write` manage the current macOS user's Things library.
Reads open its SQLite database read-only. Writes run native AppleScript through
Things; the application owns persistence and Things Cloud sync. Never write SQL
to Things' database. Built-in list membership/order comes from the app itself.

## Setup and scope

- Requires macOS, Things 3.24's database schema, and Node 24. No new dependencies.
- Run `things_read` with `{"operation":"doctor"}` from the actual Tango process
  context. That host needs macOS Automation permission to control Things and
  permission to read its container. An interactive terminal's grant may differ.
- Database discovery ignores backups and fails on ambiguous active databases.
  Set `THINGS_DATABASE_PATH` in the local profile if discovery is ambiguous.
- Watson and its alternate configuration declare the `things` MCP server.
  Installations must grant `things_read: read` and `things_write: write` to the
  intended local agent/worker principals using their normal governance process.
  The generic catalog intentionally grants no access to any installation's users.
  Profile overlays that replace MCP lists must include the Things entry too.
  Use `node scripts/grant-things.mjs --db EXISTING_DB --principal worker:NAME`
  to preview grants; add `--apply` to enable read/write for those explicit
  existing principals. Repeat `--principal` for each authorized worker.
- Rebuild the core and Discord packages and restart the tool server when
  deploying. Existing agent sessions may need a fresh session to see new tools.
- This is one Mac user's library, not a multi-account service. Only grant it to
  agents authorized to access that entire library. Personal task data and local
  paths belong in the profile layer, never tracked files.

## Read examples

```json
{"operation":"list","list":"Today","limit":50}
{"operation":"projects"}
{"operation":"list","project_id":"PROJECT_ID"}
{"operation":"list","area_id":"AREA_ID"}
{"operation":"search","query":"packing"}
{"operation":"get","id":"ITEM_ID"}
```

Also supports `areas`, `tags`, and built-in lists Inbox, Anytime, Upcoming,
Someday, Logbook, Trash. Built-in names currently require Things in English.
Results contain `total` and `next_offset`; pass the latter as `offset` to page.
Search includes completed items but excludes trashed items and repeat templates.
Project/area content lists include open items; project listings include open
projects. Individual item reads include checklist rows and their completion
state. Scheduled items may have `start: someday`; consult `start_date` too.

## Write examples

```json
{"operation":"create","kind":"project","title":"Trip planning"}
{"operation":"create","kind":"todo","title":"Pack bags","project_id":"PROJECT_ID"}
{"operation":"update","kind":"todo","id":"TASK_ID","when":"today"}
{"operation":"update","kind":"todo","id":"TASK_ID","deadline":"2026-12-20"}
{"operation":"update","kind":"todo","id":"TASK_ID","deadline":null}
{"operation":"update","kind":"todo","id":"TASK_ID","status":"completed"}
{"operation":"trash","kind":"project","id":"PROJECT_ID"}
```

`kind` is `todo`, `project`, `area`, or `tag`. Areas support title/tags; tags
support title. To-dos/projects also support notes, existing tags, area placement,
start scheduling and deadlines. Only to-dos can have `project_id`. `when` accepts
`YYYY-MM-DD`, `today`, `anytime`, `someday`, or `inbox`. Date-only inputs use the
Mac's local calendar. Status is `open`, `completed`, or `canceled`.

Updates are partial: omitted fields are preserved. An empty notes string or tag
array clears that field. An optional `expected_modified` taken from an item read
rejects an edit if its modification value has already changed. This is a
preflight check, not an atomic lock against simultaneous manual edits.

Trash applies only to tasks/projects; trashing a project also trashes its
children. Permanent deletion, area/tag deletion, recurrence editing, reordering,
reminder times, heading writes, and checklist writes are not exposed in this
version. Use Things for those operations. New tags must be created explicitly.

## Outcomes and retries

- `verified`: requested fields were observed in the local database after the
  app command. Includes ID and before/after snapshots.
- `unknown`: the app timed out or returned an error. A partial write is possible.
- `unverified`: the app returned an ID but readback could not confirm every field.

Never automatically retry an unknown/unverified create: inspect the returned ID
or search for the intended title first. A timeout can occur after the app accepts
an Apple event. Multi-field writes are not transactional. Operations are queued
within one tool-server process, not across independent Tango processes.

Local verification does not establish Things Cloud delivery or another device's
state. Confirm cross-device sync on a second device when validating deployment.

## Validation

`npm run test -w @tango/discord -- test/things-agent-tools.test.ts`

`node --import tsx scripts/test-things-live.ts` creates disposable projects/tasks,
exercises the lifecycle through the actual MCP server, verifies readback, and
moves its test projects to Trash in a finally block. It never empties Trash.
Pass `--report /absolute/path/report.json` to save redacted evidence. Run only
when authorized to create test data in the current user's Things library.

`node --import tsx scripts/test-things-harness.ts --agent AGENT_ID --report REPORT`
uses Tango's Discord test harness in a fresh smoke thread. It asks the actual
agent to create, edit, schedule, complete and trash disposable Things items,
and verifies each change independently in the database. Requires the usual
harness credentials and a deployed Things tool server. The report contains test
thread IDs and replies; keep it in private artifact storage.
