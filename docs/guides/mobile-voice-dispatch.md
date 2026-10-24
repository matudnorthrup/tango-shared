# Mobile Voice Dispatch

Mobile voice dispatch lets a phone use on-device dictation as a push-to-talk
front end for Tango. The phone sends text to Tango; Tango routes it as a normal
voice turn and syncs the transcript/response back through Discord.

## Endpoint

The endpoint is served by the existing Tango voice bridge:

```http
POST /mobile/voice-dispatch
Authorization: Bearer <TANGO_VOICE_BRIDGE_API_KEY>
Content-Type: application/json
```

Default local URL:

```text
http://127.0.0.1:8787/mobile/voice-dispatch
```

For phone access, expose the bridge only through a private path such as
Tailscale, and keep `TANGO_VOICE_BRIDGE_API_KEY` set. Do not expose this endpoint
publicly without an authenticated reverse proxy and rate limits.

## Payload

Minimal fire-and-forget payload:

```json
{
  "transcript": "Hey Sierra, what temperature will it be in Costa Sur?",
  "utteranceId": "ios-shortcut-2026-06-19T15:42:10Z"
}
```

Useful fields:

| Field | Required | Notes |
| --- | --- | --- |
| `transcript` | Yes | On-device dictation text. `text` and `dictation` are accepted aliases. |
| `agentId` | No | Fallback target if the transcript does not name an agent. |
| `channelId` | No | Discord text channel where transcript/response should sync. Also creates a stable channel-backed session when `sessionId` is omitted. |
| `sessionId` | No | Explicit Tango session. Usually omit this and use `channelId`. |
| `utteranceId` | No | Idempotency key. Set one per phone invocation. |
| `discordUserId` | No | Optional Discord user id for transcript attribution. |
| `routeByWake` | No | Defaults to `true`. Set `false` for a fixed-agent shortcut that should preserve literal wake words. |

Routing behavior:

- If the transcript starts with a known agent call sign, that agent wins.
- Wake phrases are stripped before dispatch, so `Hey Sierra, what temperature...`
  is sent to Sierra as `what temperature...`.
- Mobile dispatch is a full-utterance flow. A bare wake like `Hello Sierra`
  does not hold a microphone gate open; use the live Discord voice session for
  that flow, or build a native mobile loop later.
- If there is no wake phrase, Tango uses `agentId`, then
  `TANGO_VOICE_DEFAULT_AGENT_ID`.
- If no `channelId` is provided, Tango syncs the transcript/response to the
  target agent's configured default Discord channel. This is the preferred
  mobile setup for one universal button.
- If no `sessionId` is provided and `channelId` is present, Tango uses
  `agent:<agentId>:discord:channel:<channelId>` so repeated phone turns reuse the
  same explicit channel-backed context.

## iOS Shortcut

Apple supports assigning the Action Button to a Shortcut, and Shortcuts can send
POST requests with `Get Contents of URL`.

Create a shortcut named `Tango Dispatch`:

1. Add `Dictate Text`.
2. Add `Get Contents of URL`.
3. Set URL to `https://<tailnet-host>:8787/mobile/voice-dispatch`.
4. Set Method to `POST`.
5. Add headers:
   - `Authorization`: `Bearer <mobile-token>`
   - `Content-Type`: `application/json`
6. Set Request Body to JSON with:
   - `transcript`: dictated text
   - `utteranceId`: `ios-shortcut-` plus the current date/time
7. Optional: parse the JSON response and show `mobileDispatch.agentId`, or just
   speak `Sent to Tango`.

Then assign the shortcut:

1. Open iOS Settings.
2. Go to Action Button.
3. Choose Shortcut.
4. Select `Tango Dispatch`.

For phones without an Action Button, put the same shortcut in Control Center,
Home Screen, Back Tap, or Siri.

## Android Tasker

Tasker can capture speech into a variable and send an HTTP request.

Create a task named `Tango Dispatch`:

1. Add a voice input action and store the recognized text in a variable such as
   `%tango_text`.
2. Add `HTTP Request`.
3. Set Method to `POST`.
4. Set URL to `https://<tailnet-host>:8787/mobile/voice-dispatch`.
5. Add headers:
   - `Authorization: Bearer <mobile-token>`
   - `Content-Type: application/json`
6. Set Body to:

```json
{
  "transcript": "%tango_text",
  "utteranceId": "android-%TIMES"
}
```

7. Optional: add a `Flash` or `Say` action for a local acknowledgement.

Trigger options:

- Add a Tasker home-screen shortcut.
- Add a Tasker Quick Settings tile if available on the device.
- Use a hardware-button remapper or launcher gesture to run the task.
- A future native Tango Android app can expose a first-class Quick Settings tile
  via Android `TileService`.

## Common Patterns

General routed shortcut:

```json
{
  "transcript": "Hey Malibu, log a 45 minute zone two ride"
}
```

Fixed-agent shortcut:

```json
{
  "agentId": "sierra",
  "transcript": "What temperature will it be in Costa Sur?",
  "routeByWake": false
}
```

The routed shortcut is better for one universal phone button. Fixed-agent
shortcuts are useful for separate icons/tiles like `Ask Sierra` or `Ask Malibu`.
Add `channelId` only when you intentionally want the response to land somewhere
other than the target agent's configured default Discord channel.
