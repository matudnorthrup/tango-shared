# Backfilling conversation history

Phase 1 adds conversation metadata to the existing SQLite message store. Discord
continues to deliver messages. The backfill only reads Discord; it never sends a
message or starts an agent turn.

Build the workspaces first (`npm run build`). Supply a bot token through the
existing environment, and supply owner Discord IDs through `DISCORD_OWNER_IDS`
(comma separated). Owner IDs distinguish ordinary owner messages from requesters;
existing author metadata is retained. Do not put credentials or account IDs in
scripts or tracked configuration.

Start with a consistent SQLite backup and a separate attachment directory. Use
SQLite's backup command/API, rather than copying an open WAL database file:

```sh
node --import tsx scripts/conversation-backfill.ts \
  --db /path/to/snapshot.sqlite \
  --data-dir /path/to/snapshot-data \
  --config-dir /path/to/config \
  --dry-run
```

Dry-run is the default. It opens SQLite read-only, does not migrate it, and does
not download attachments or create directories. It reads the last 30 days in
configured agent home channels, active threads, and recently archived public and
private threads. Each active conversation prints counts of fetched messages,
missing posts, enriched rows, unchanged rows, attachments to copy, and ambiguous
legacy chunk matches. Discord permission and fetch failures stop the run; do not
interpret an incomplete run as a clean inventory. When an agent's home channel
is one this bot can't read, rerun with `--skip-agent <id>` (repeatable); the
run prints each skipped agent so the inventory states what it left out.

Legacy replies contain only the last chunk's ID. The planner joins preceding
chunks only when the contiguous text, author, and webhook match exactly. An
ambiguous match is reported and retained as separate visible posts; review it
before relying on the store as the conversation source. History older than the
30-day window is not fetched by this command.

After reviewing counts, run the same command against the **snapshot** with
`--apply`. It runs the schema migration, records missing posts, fills conversation
keys and chunk IDs, resolves reply links, and copies attachments into
`<data-dir>/attachments/<conversation-key>/<local-message-id>/`. Run again to
verify idempotency. Download errors remain in attachment metadata and make an
apply run exit nonzero. Re-running retries those copies; expired CDN URLs may
require recovering the file separately.

For production, review the snapshot results, keep a consistent backup of the
original database, then use the explicitly selected live database and profile
data directory during an approved maintenance window. Never default to a live
profile. This implementation does not automatically run a backfill or restart
services. Local files are retained independently of temporary processing files.

The schema migration preserves message IDs and dependent references. A code
rollback can continue reading the widened schema; restoring the pre-migration
backup also discards any messages recorded since that backup.
