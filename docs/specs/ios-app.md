# iPhone desk app

The iPhone app loads the existing web desk in a full-screen `WKWebView`. Swift does not recreate
the desk UI. The shell provides first-run URL setup, Settings, safe areas, pull-to-refresh,
external links in Safari, unreachable/retry UI, and `tango://decision/D-n` links.

`apps/tango-ios/TangoDeskKit` is a local Swift 6 package supporting iOS 26 and macOS 15.
It owns URL validation, native JSON transport, notification payload decoding, command creation,
and the durable answer queue. The SwiftUI app owns WebKit, notification permission/registration,
notification categories, local failure alerts, and background-refresh scheduling.

## Setup and identity

Copy `Config/Local.example.xcconfig` to ignored `Config/Local.xcconfig`. Set `DESK_URL`,
`DEVELOPMENT_TEAM`, `PRODUCT_BUNDLE_IDENTIFIER`, and `TANGO_APS_ENTITLEMENT` there. The default URL
is embedded in the app Info.plist; the owner's saved URL in UserDefaults overrides it.
The base may include the desk's deployment path. HTTPS is required except loopback HTTP for
Simulator tests. Keep the hostname, real bundle identifier, team id, paths, and signing
materials out of tracked files. Use the existing Apple Developer Program membership.

Enable Push Notifications for the app identifier, provision the app, and allow notifications
on the phone. `TANGO_APS_ENTITLEMENT` must match its provisioning: `development` for development signing and
`production` for distribution. Registration maps the development entitlement to the server
environment `sandbox`; production stays `production`. The phone runs Tailscale. Native URLSession POSTs use JSON and
omit Origin and Sec-Fetch headers. Redirects are refused to keep answer bodies on the configured desk. The tailnet proxy adds identity; existing desk access control
and login allowlisting apply unchanged. The app never supplies an actor or identity header.

On the desk process configure all four environment variables (profile-managed service environment
is also suitable):

- `TANGO_APNS_KEY_PATH`: path to the Apple-issued ES256 private key, read only at server runtime.
- `TANGO_APNS_KEY_ID`: its key identifier.
- `TANGO_APNS_TEAM_ID`: the existing developer team identifier.
- `TANGO_APNS_BUNDLE_ID`: the app's provisioning topic.

Missing configuration disables push with one startup log line. An unreadable/invalid key also
disables it without logging key material. The sender uses only Node HTTP/2 and crypto, with a
cached ES256 JWT renewed after 50 minutes, per-device sandbox/production hosts, a 15-second
transport timeout, one-hour notification expiry, and a stable decision collapse id. It never
logs tokens, JWTs, keys, or notification text. The sandbox test desk explicitly disables APNs,
even when its parent environment has production configuration.

## Device and delivery persistence

`POST /api/desk/devices` accepts `{token, platform: "ios", bundleId, environment}`. Registration
returns a persisted installation `deskId` and is idempotent; tokens are hex, environment is `sandbox` or `production`. The app persists the
latest APNs token and re-registers on token changes and launch. Failed registration retries
on a later launch/settings save. Devices live in `desk_devices` in the existing `screen.db`. Registration records a timestamp
that repeat registration preserves. Briefs opened before that timestamp do not push; migrating
older device records uses migration time as the cutoff.
There is no public token listing endpoint. APNs 410 and `BadDeviceToken` remove the device.
Only devices whose bundle id matches the configured topic are sent notifications.

The desk observes item changes and retries every 30 seconds. It reads the core's existing
carried-brief projection: only the row counting a brief sends it. Non-counting mirrors,
`carriedBy` source duplicates, hidden/done/snoozed rows, and resolved requests do not send.
The phone gets one push per device, decision id, and revision. Successful delivery receipts
persist in `desk_push_receipts`, including across restarts; a revision update reuses the
same APNs collapse id. Before sending to each device the service rechecks that the brief is
still pending at that revision. Older briefs with no revision are not actionable pushes.

Transport failures remain eligible for retry; disabled push does not mark anything delivered.
There is an unavoidable crash window between Apple's acceptance and committing the receipt.
A retry in that window has the same collapse id, so pending delivery can coalesce. This is
at-least-once transport, not a claim of exactly-once delivery by Apple. Device re-registration
can receive any still-open brief; answered briefs are absent from the pending projection.

## Payload and actions

```json
{
  "aps": {
    "alert": {"title": "Layout choice", "body": "Choose a layout?\nA · Compact\nB · Roomy\nTap to open."},
    "category": "decision-2",
    "sound": "default",
    "thread-id": "D-100"
  },
  "deskId": "00000000-0000-0000-0000-000000000001",
  "itemId": "loom:example",
  "requestId": "decision:D-100",
  "decisionId": "D-100",
  "revision": 1,
  "options": [
    {"key": "A", "label": "Compact", "answer": "A · Compact (Recommended)"},
    {"key": "B", "label": "Roomy", "answer": "B · Roomy"}
  ]
}
```

`answer` preserves the exact web question-option label, including its recommendation suffix.
The client first checks `deskId` against the registration for the current base URL, refusing
notifications from an old desk after a Settings change. The client sends `{commandId: <fresh UUID>, type: "respond", itemId, args: {requestId,
revision, answers: {decision: <answer>}}}` to `POST /api/desk/commands`. It does not infer an
answer from a display label or change the existing rule-chip default. The existing core/source
path rejects stale ids and revisions.

Categories `decision-1` through `decision-3` have fixed A/B/C titles. Their full labels appear
in the body. This works without a notification extension and mirrors the same actions to
Apple Watch. The `-locked` variants require authentication for every answer; the server picks
these for level-1 or tripwire briefs. Other answers can run without opening the app.

**Platform limit:** iOS displays at most four custom actions. Three-option briefs therefore
show A, B, C, and Snooze; tapping the notification itself is Open. One/two-option briefs also
have an explicit Open action. Snooze sends the existing `snooze` command with a one-hour ISO
deadline fixed when tapped. Open loads `<base>/decision/D-n`. Apple's notification presentation
may show fewer actions in a compact banner; expand it to see the full category.

Payloads over Apple's 4096-byte limit, or briefs using keys other than positional A/B/C, use
`decision-open` and an Open/Snooze message. Local failure alerts use `decision-failure` with Open. Complete answer strings are never truncated into an
incorrect choice. Arbitrary labels/keys are still available on the full web card.

## Answer delivery and recovery

The phone saves the command before its first POST in Application Support, protected until first unlock so ordinary background lock-screen actions can read it. The saved record
includes the command UUID, target desk address, decision id, revision and answer. A retry keeps
the same command UUID for desk idempotence and cannot migrate to a different desk after a
Settings change. It retries on app launch/activation, the next notification action, and
opportunistic `BGAppRefreshTask` execution. iOS controls refresh scheduling; it is not a promise
of delivery every 15 minutes. Network/server availability failures retain the record.

HTTP refusals and HTTP-200 command results with `status: "failed"` become a local notification
with the reason and Open. Rejected records remain visible in Settings and are not automatically
retried against a newer question. A network-failed action also posts a local “saved, will retry”
notice. Unreadable queue files are not overwritten. Disk failures surface in the app; failure
notification errors also surface there. No answer is silently converted to success.

## Verification

The screen Vitest suite covers registration and access guards, payload/web-label fidelity,
lock categories, carried/counting deduplication, restart persistence, revision retries,
unconfigured startup, oversize payloads, and HTTP/2 ES256 delivery to a local fake returning 410.
The Swift tests cover URLs, exact commands, native headers, semantic refusal, persisted retry,
fixed destinations, successful deletion, and corrupt-file preservation.

The committed UI test uses the sandbox desk plus a loopback `simctl push` helper. It captures
the web view, expanded notification actions, and stale-answer failure notification. Simulator
injection verifies the app flow; real APNs delivery, signed-device lock authentication, Apple
Watch mirroring, and background scheduling still require a provisioned physical device.

## Not in this version

- Live Activity decision countdown and lock-screen widgets.
- Native realtime voice.
- A Mac push-to-talk hotkey adopting this package in the existing menu bar app.
- Siri and App Intents.
- An Apple TV screen app.

There is no separate native Mac desk UI; the web desk remains the Mac interface.
