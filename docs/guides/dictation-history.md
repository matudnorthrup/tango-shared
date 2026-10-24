# Private dictation history

The private owner view collects new dictations from enrolled native clients and
owner browser dictation sessions. No pre-feature history is imported. Local Mac
history remains independent.

## Access and surfaces

Open **Settings → This device → Dictation history** from an owner desk window.
History opens as a separate top-level page, outside the shared window
presentation. It supports search, copy, delete and clear-all. Text is rendered
as text nodes. The page does not use localStorage, IndexedDB, telemetry, the
scene hub, transcript indexing, or a shared presentation. Hiding or leaving the
page removes loaded text; an active page refreshes every minute.

Every request requires an explicit `SCREEN_ALLOWED_LOGINS` match and the
trusted Tailscale Serve identity and forwarding headers, including a single
source IP. The server derives an opaque device key from owner + source IP;
clients cannot supply a device or owner label. Revoking a device means removing
it from the tailnet; there is no separate desk device list. A device assigned a
new tailnet IP gets a new device key.

The backend must remain bound to loopback behind Serve, which strips
client-supplied identity headers. Requests from loopback receive no automatic
authentication exemption, but local processes able to connect directly can
forge Serve headers. The server therefore trusts the host, as do the rest of
the desk and its on-disk storage. Native clients must use the authenticated
tailnet URL, even on the server machine.

Scene frames, embedded pages, detached views and house-screen paths cannot
fetch history. The page refuses framing (`frame-ancestors 'none'` and `DENY`),
and the API checks browser Fetch Metadata, origin, and the dedicated page's
referrer. Native access has a separate explicit request header and rejects
browser-originated requests. No CORS access is granted. These checks separate
browser surfaces, not mutually hostile processes running as the same OS user.
An allowed owner deliberately opening the private top-level URL can read it.

## Private storage and retention

The production store is fixed at
`~/.tango/profiles/<profile>/private/dictation-history.noindex/<owner-hash>.json`.
It is independent of `SCREEN_DATA_DIR`, outside the repository, scene assets,
logs, Loom databases, memory and transcript indexes. It is plaintext protected
by directory mode 0700 and file mode 0600, with macOS backup exclusion and
Spotlight's `.noindex` directory suffix. Third-party backups must respect the
private directory's exclusion policy; this is not end-to-end encryption or a
claim of secure erasure of filesystem snapshots or SSD blocks.

Writes use a private exclusive temp file, fsync, atomic rename and directory
fsync. Startup and every-minute maintenance remove interrupted temp snapshots
and expire text seven days after its original capture time. Reads and writes
also prune. At most 200 entries remain per owner. Evicted and individually
deleted entries leave only IDs and expiry timestamps until their original
seven-day lifetime ends. Clear-all rewrites the snapshot without text or
entry tombstones and replaces the deletion generation. No old text is retained
under a tombstone flag. Per-device rate counters survive clear and restart.

## API contract

`GET /api/desk/dictation-history` returns `{generation, entries, deleted}`.
Search is local to those owner-only results, never a query string or global
search request. Responses, including errors, are `no-store, no-transform`.

`POST /api/desk/dictation-history` accepts JSON with:

- `{action: "put", generation, entry}` for an idempotent upload/outcome update.
- `{action: "delete", generation, id}` for one entry.
- `{action: "clear", generation}` for clear-all, returning the new generation.

Native requests set `X-History-Client: native`. The owner page sets
`X-History-Client: desk` and supplies browser-generated same-origin metadata.
The request body is capped at 24,000 bytes. Unknown fields are rejected.

An entry has a lowercase UUID `id`, millisecond epoch `capturedAt`, UTF-8 `text`
(up to 16,384 bytes), `destination` (at most 256 characters), `outcome`
(`sent`, `failed`, `undone`, `unknown`) and positive integer `revision`.
The response adds the server-derived device key. The timestamp must be inside
the last seven days, allowing at most one minute of future clock skew. The
capture ID, timestamp, text, destination and source device cannot change on an
update. Only a higher revision changes the outcome; stale retries are no-ops.

Each device can write at most 12 updates per minute and 120 per hour. An owner
can write at most 30 per minute and 300 per hour across devices, bounding
retained deletion metadata too. Idempotent retries consume no write allowance.
`429 rate_limited` supplies `Retry-After: 60`; clients use bounded backoff.
Errors contain fixed codes, never payloads or exception text.

## Browser and iPhone dictation capture

New owner desk dictation sessions save text on the server by default. Turn this
off at **Settings → This device → Save new desk dictations from this device**.
The preference is local to that browser's storage (including the iPhone app's
web view), applies to new sessions, and never enters shared desk settings.
Only the preference is stored in the browser, not history text. Clear existing
text in the private Dictation history page.

The authenticated WebSocket upgrade derives owner and device through the same
identity checks as the history API, and requires a matching Origin. Fetch Metadata and Referer are checked when
present; browser WebSocket handshakes can omit both.
Scene, detached and house-screen contexts suppress capture. Suppression flags
can only reduce recording; they cannot supply identity or authorize a caller.
Manual-finish native Mac sockets are excluded to avoid duplicate native uploads;
loopback sockets fail the owner check. Navigator commands are not recorded by
this path. Conversation voice replies use the same identity and suppression checks.

The server saves its transcript once when the dictation session ends, including
late words after finalization. It records a partial transcript after a failed
connection, but not a spoken cancel. Completed dictations have outcome `unknown`:
the server cannot establish whether the browser sent or used the resulting draft.
Conversation sessions save one entry per utterance, with the server's conversation
label as destination. A separate browser acknowledgement after the ordinary HTTP
reply result records `sent` or `failed`; the pre-send playback arm is not proof of
delivery. This acknowledgement supplies no transcript or identity. Disconnects
without an acknowledgement retain `unknown` for completed text. Focus mode starts
a new capture for each resumed turn; ending playback does not save a duplicate.
Text never enters voice diagnostics. The generation is fixed at the upgrade;
clear-all during capture prevents that capture from returning. Oversized text,
rate-limited writes and unavailable history storage fail without interrupting
voice and are not queued for retry.

## Native client enrollment and deletion protocol

Sync defaults on, independently on each device, with an off setting. A durable
first-launch enrollment boundary allows only new captures: no pre-feature
history is imported. Turning sync off cancels queued uploads; re-enabling
starts a fresh boundary and never imports captures made while off. Saving
locally precedes delivery; upload failures never delay either operation.

Before sending queued work after reconnection, fetch deletion state. If the
generation changed, discard **every** queued upload stamped with the old
generation, including a capture made offline after a remote clear. Do not
compare client capture clocks with server clear time, and never relabel old
queued uploads with a new generation. Those discarded offline captures stay
in the device's local history. Apply deletion IDs to previously synced copies,
then adopt the new generation for subsequent captures. A `409
generation_changed` requires the same reconciliation; `409 entry_deleted`
drops that upload. Offline synced copies disappear on reconciliation or local
expiry. Clipboard contents follow the operating system's clipboard policy.

## Rollout and rollback

The server stage requires one desk deployment. Allow up to two minutes of desk
unavailability during the supported combined desk/coordinator restart; builds
and checks run before that restart. Confirm the deployment window with the
release lead before running it. Then verify authenticated health and private
history access without moving shared windows or uploading real dictations.
Native-client stages require no desk restart. Browser capture changes require a
desk deployment with the same outage window and release-lead coordination.

Rollback restores the prior desk release; local device history remains usable.
Preserve the private store for its retention period. If the rollback removes
maintenance, arrange expiry cleanup rather than retaining old text indefinitely.
