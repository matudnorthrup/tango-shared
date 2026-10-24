# Conversation store shadow reads

The bot exposes read-only conversation endpoints on its existing bridge HTTP
server. They use the same `X-Tango-Collaboration-Token` authentication as
`/screen/input`. POST turn/start entry remains on the existing Discord bridge.

- `GET /conversations?updatedAfter=0` returns `conversations` and a numeric
  `cursor`. Advance to that cursor only after processing every conversation.
  Each conversation includes `revision` and JSON `changed_message_ids`.
- `GET /conversations/thread%3A123/messages?after=0&limit=100` returns public
  messages ordered by local integer id. Maximum page size is 500. Use the last
  id as `after`; an empty/short page ends the read. The ids are not snowflakes.
- `GET /conversations/attachments/<local-message-id>/<index>` serves a copied
  attachment. Missing copies return 404; real paths outside the data directory,
  including symlink targets, are rejected. The desk proxies these reads without
  exposing the bridge token to browsers.

Migration 86 adds a latest-revision index over public conversation posts. A
trigger advances its monotonic revision on each insert/update, including
background attachment-copy completion. It retains one row per message, not an
unbounded event log. Existing public conversation rows seed the initial index.
No existing message ids or foreign keys change. Restoring a database snapshot
also requires resetting the desk's `tango:changes` and per-conversation markers
and clearing its store-source cache; cursors belong to one database history.

The desk defaults to `TANGO_CONVERSATION_SOURCE=shadow`. Both sources read;
Discord continues to populate desk items. The store reader persists its global
revision, per-conversation local id, and shadow messages in the desk database.
A push reads the named conversation immediately; pushes during a read queue a
trailing read. The five-minute poll catches missed pushes. Changed ids at or
before the local cursor are fetched again, so older attachment updates survive
a restart or a lost notification.

`GET /api/desk/conversation-shadow` returns the latest comparison per observed
conversation, with its timestamp and differences:

- `missing-tango`: a mirrored post has no store counterpart;
- `missing-discord`: a store post has no mirrored counterpart;
- `text`: corresponding posts disagree;
- `order`: corresponding posts appear in a different order.

Discord chunks are compared as one logical store post, allowing only whitespace
removed at chunk boundaries. Changes to the comparison emit `tango.shadow.diff`
entries in the desk trace; agreement emits `tango.shadow.clean`. Reports contain
ids and categories, not message text. A push arriving before the next Discord
poll can produce a transient difference; investigate differences that remain
after both readers catch up. The report is a current snapshot; the ordinary
trace retention still applies, so capture reports during the observation week.

After a clean observation week, set `TANGO_CONVERSATION_SOURCE=tango` in the
screen service environment and restart that service. This is a deliberate
cutover, never an automatic one. Existing desk identities, attention state,
Discord replies, reactions, and archive writebacks remain in place. Old
multi-chunk history retains its layout. Only conversations previously observed
by Discord (or already on the desk) are replayed from the shadow cache, avoiding
resurrection of archived backfill threads; new posts can reopen a conversation.
Home history keeps the seven-day window and thread history the thirty-day
window. Discord continues to read intake channels in either mode. Setting the
switch back to `shadow` restores Discord-driven ingestion.

For isolated validation, `npm run desk:test -- --no-loom` provides synthetic
Discord and store API fixtures. Setting `TANGO_CONVERSATION_SOURCE=tango` on that
sandbox exercises the cutover source without accessing a real bot or profile.

### Reconciling a backfilled baseline

Compare explicit SQLite snapshots with `node --import tsx scripts/conversation-shadow-check.ts
--db <bot-copy.sqlite> --desk-db <screen-copy.sqlite>`. Both connections are read-only.
The output includes the desk's saved baseline, the current comparator's totals, and
per-conversation differences and exclusions. It compares the store directly against
the frozen Discord snapshot; deployment validation must also check the live reader's
report so a cache or access-filter defect cannot be hidden by the offline check.

Logical posts are ordered by their mirror snowflakes, not insertion IDs (backfill
inserts older posts later). Chunk IDs are chronological. Discord's generated reply
link is presentation metadata. Known Discord structural events and voice turns
without a Discord mirror are listed as explicit exclusions; unknown missing mirrors
and actual text changes still produce differences.

For historical data, `scripts/conversation-repair.ts --db <bot-copy.sqlite>` defaults
to a read-only dry run. It sorts chunk IDs and restores conversation ownership from
the configured home channels, without changing guest authors on individual messages.
An optional `--discord-snapshot <json>` supplies verified Discord messages containing
`id`, `channel_id`, and `type`; structural events get metadata rather than being deleted.
Only matching channel/message identities are used. Never guess event types from text.
Run with `--apply` on the copy, then repeat the dry run and comparator. Applying is
transactional and idempotent, and ownership changes publish a message revision so the
reader revisits previously filtered conversations. No command restarts services or
writes to Discord. Back up the real database before applying a reviewed repair there.

The source replays its read-only cache once when the comparison metadata format
changes. Existing desk message identities, attention state and writebacks remain intact.
