# Mac voice diagnostics

The host and client-only Mac apps send one metadata report when a dictation attempt
ends. The desk stores it beside its existing voice logs, in
`<SCREEN_DATA_DIR>/voice/events.jsonl`. It keeps the current file and two rotated
files (`.1`, `.2`), each at most 1 MiB. Files are mode `0600`. This private runtime
data includes device names, authenticated logins and conversation IDs; do not
commit it or attach it to public issues.

Read the latest 100 events from a process on the desk host:

```sh
curl --fail --silent http://127.0.0.1:9410/api/desk/voice/events
```

`?limit=500` reads up to 500 records, newest first. The reader rejects browser and
forwarded requests, including an allowed owner's remote requests. As with the
other local desk APIs, the service must remain loopback-bound behind the trusted
Serve proxy. `POST /api/desk/voice/events` uses the normal desk access, owner
allowlist, JSON and origin checks. Requests are capped at 4 KiB. Unknown fields
and arbitrary error messages are rejected. Identity comes from the trusted
request headers, never the report body. Device name, app role and version are
client-reported diagnostics, not authorization evidence.

Reports include the receipt time, random exchange ID, app, host/client role,
version, device name when available, local/tailnet connection, authenticated
login (null for local), mode, target conversation ID when resolved, capture-end
reason and terminal outcome. A client-only app is the laptop distribution;
role describes the app configuration, not a hardware inference. Capture ends
include silence, second tap, key release, Esc, safety limit, provider event,
cancellation and error. Undo after capture preserves its original end reason
and records outcome `undone`. Error codes are a fixed stage enum. No transcript,
audio, arbitrary exception text or command arguments enter this log.

Durations use the client's monotonic clock:

- `captureMs`: ready-to-stop elapsed time (including capture setup immediately
  after readiness).
- `speechEndToStopMs`: detected trailing quiet audio in milliseconds for local
  silence endpointing, or elapsed time since a provider speech-end event when
  available. Omitted when neither measurement exists. This is a detector
  measurement, not a reference recording of the actual last spoken syllable.
- `stopToTranscriptMs`: last received transcript delta relative to capture stop;
  negative means the delta arrived before stop. It measures delivery, not a
  guarantee the provider has finalized the transcript.
- `transcriptToPostMs`: last delta to successful reply acknowledgement, including
  the remaining undo period and request time.

Unavailable measurements are omitted. Command mode/outcomes are reserved in the
schema for command routing; this first producer reports native dictation only.
Browser voice keeps its existing diagnostics.

Delivery is best effort with a five-second timeout. It runs independently of the
voice socket after the outcome, so it adds no wait to dictation or posting.
There is no persistent client queue: crashes, an invalid desk address or an
unreachable desk can leave no report. The last 1,000 retained exchange IDs per
login are deduplicated. Log failures cannot change the outcome of a reply.
