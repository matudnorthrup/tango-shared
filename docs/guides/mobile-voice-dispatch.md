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

1. Add `Dictate Text` with Stop Listening set to `After Pause`.
2. Add `Text`: `ios-` followed by the `Current Date` variable, formatted with
   the custom format `yyyyMMdd-HHmmss-SSS`. Each press needs its own id.
3. Add `Get Contents of URL`:
   - URL: `http://<tailnet-host>:8787/mobile/voice-dispatch`. The bridge
     serves plain HTTP; keep it reachable only over the tailnet.
   - Method: `POST`
   - Header: `Authorization`: `Bearer <mobile-token>`
   - Request Body `JSON`:
     - `transcript` (Text): `Dictated Text`
     - `utteranceId` (Text): the `Text` from step 2
4. Add `If`, with input `Contents of URL`, condition `contains`, and text
   `turnTaking`.
5. Inside the `If`, add `Get Dictionary Value` for key `turnTaking.say` in
   `Contents of URL`, then `Speak Text` with that value.
6. Under `Otherwise`, add `Get Dictionary Value` for key `responseText` in
   `Contents of URL`, then `Speak Text` with that value. End the `If`.

Steps 4 to 6 follow the turn-taking rules in
[voice-turn-taking.md](../specs/voice-turn-taking.md). A press that leaves the
turn open (it ends on "and", or starts a ramble) returns a `turnTaking` object
whose `say` line is the spoken cue, such as "Go on." A finished turn has no
`turnTaking` field and returns the agent's reply in `responseText`. Check for the
field before reading it: `Get Dictionary Value` on a missing key stops the
shortcut with "No value was found for the dictionary key". A cancelled draft
returns no `say` line, so the phone says nothing.

The request waits for the agent's full reply. If the reply is slow, iOS can time
the request out, but the turn still lands in Discord.

To test without touching a real conversation, add `agentId`, `channelId` (a
test channel) and `routeByWake: false` to the body, then remove them once it
works.

Then assign the shortcut:

1. Open iOS Settings.
2. Go to Action Button.
3. Choose Shortcut.
4. Select `Tango Dispatch`.

For phones without an Action Button, put the same shortcut in Control Center,
Home Screen, Back Tap, or Siri.

## Tango Note: send work and read the reply later

Use a separate `Tango Note` Shortcut for work that should continue after the
phone is free. It posts dictation to the screen server's
`POST /api/desk/voice-note`, which uses the operator's text routing compiler
without starting a live voice session. The desk accepts the work and replies
with a short receipt; the agent's eventual reply is read in the Tango app.
Keep `Tango Dispatch` for quick spoken questions through the voice bridge.

### Before setting up

- The phone is connected to the tailnet. Tailnet access is the sign-in: there
  is no bearer token or API key. Funnel access is refused.
- The URL is the screen server's private HTTPS address plus
  `/api/desk/voice-note`, for example
  `https://<desk-host>/tango-screen/api/desk/voice-note`. It is not the voice
  bridge's port 8787 or its `/mobile/voice-dispatch` path.
- The operator profile uses the ChatGPT subscription login and has its agents
  and Start work repositories configured.

### Shortcut recipe

In the Shortcuts app, create a shortcut named `Tango Note` and add these
actions in order:

1. **Dictate Text.** Set Stop Listening to `After Pause`.
2. **Set Variable.** Name it `Note Text`, set to `Dictated Text`.
3. **Text.** Type `ios-`, then insert the `Current Date` variable. Tap the
   variable and set Date Format → Custom → `yyyyMMdd-HHmmss-SSS`. Each press
   gets its own id.
4. **Set Variable.** Name it `Note ID`, set to `Text`.
5. **Get Contents of URL.**
   - URL: `https://<desk-host>/tango-screen/api/desk/voice-note`
   - Tap the arrow to show more, then set Method to `POST`.
   - Headers: `Content-Type` = `application/json`
   - Request Body `JSON`:
     - `text` (Text) = `Note Text`
     - `noteId` (Text) = `Note ID`
6. **If.** Input `Contents of URL`, condition `contains`, text `say`.
   - Inside it: **Get Dictionary Value** for key `say` in `Contents of URL`,
     then **Speak Text** with `Dictionary Value`.
   - Under `Otherwise`: **Speak Text** with `Tango didn't get that.`, then
     **Show Result** with `Contents of URL`, then **Stop This Shortcut**.
   - End the `If`. Check before reading: `Get Dictionary Value` on a missing
     key can stop the Shortcut before any later check runs.
7. **Get Dictionary Value.** Get Value for key `status` in `Contents of URL`.
8. **If.** Input `Dictionary Value`, condition `is`, text `ask`.
9. Inside the `If`:
   - **Dictate Text**, Stop Listening `After Pause`.
   - **Get Contents of URL**: the same URL, Method `POST`, the same header.
     Request Body `JSON` with `noteId` (Text) = `Note ID` and `answer` (Text)
     = this second `Dictated Text`. (Tap the variable to check that it is the
     second dictation.) Do not generate a new id: the server already has the
     original text.
   - **Get Dictionary Value** for key `say` in this second `Contents of URL`,
     then **Speak Text** with it.
10. Leave `Otherwise` empty and end the `If`. Do not loop for another answer or
    wait for the agent's work.

Every successful response carries `status` and `say`. `status` is `ask` only
when the destination is unclear; step 6 has then just spoken the question
("Who's it for?"). A refused request carries `error` instead and saves nothing.
Without the check in step 6 the Shortcut can end silently or stop on a
missing key. With it, the phone says so and shows the reply:

| Shown reply | Cause |
| --- | --- |
| `text and a valid noteId are required` | A field name or variable in step 5 is wrong, or the dictation was empty. |
| `Content-Type must be application/json` | The Request Body is Form or File instead of JSON, or the header is missing. |
| `{"ok": false, "error": "not-found"}` | The URL points at the voice bridge (port 8787), often from duplicating `Tango Dispatch`. Fix it in steps 5 and 9. |
| A web page or nothing | The URL has a typo, or the phone is off the tailnet. |

### Test it

These deliver real notes, so phrase them as tests:

- **Named:** "Watson, this is a test note from my phone, no action needed." →
  "Sent to Watson." within about five seconds.
- **One question:** "This is a test note, no action needed." → "Who's it for?"
  → answer "Watson" → "Sent to Watson."
- **Held:** as above, but cancel the second dictation. After two minutes the
  note appears under Needs you as a Phone note with a destination picker.

### Put it on a button

- Action Button: Settings → Action Button → Shortcut → `Tango Note`.
- `Tango Dispatch` can stay on Back Tap (Settings → Accessibility → Touch →
  Back Tap) or Siri.
- On phones without an Action Button, put `Tango Note` in Control Center or on
  the Home Screen.

### Receipts and recovery

| `status` | Meaning |
| --- | --- |
| `sent` | The delivery path accepted the message. The spoken `say` identifies the destination; the work's reply comes later in the app. |
| `ask` | One short clarification is needed. Answer within two minutes using the same `noteId`. |
| `held` | Follow the spoken `say`. A saved note appears under Needs you as a Phone note; choose its destination there. An unavailable-note receipt instead asks for a new dictation. |

Name the destination in the dictation: for example, “Sierra, start a thread
about the shed vents quote” or “in tango, fix the menu overflow.” The phone has
no current screen context, so name a repository when requesting new coding
work. If one clarification still leaves the destination unclear, the note is
held for selection. If no answer arrives within two minutes, it becomes a held
note automatically, including across a server restart.

The response targets about five seconds; server processing is capped below
15 seconds. Network failures can still stop the Shortcut before a receipt.
Do not treat that as proof nothing was sent. Check the app, or retry the exact
request with the saved `Note ID`; generating a new ID can send the work twice.
A note marked “delivery is unconfirmed” stays locked until delivery is checked,
so it cannot be resent through the picker by mistake.

Only successful endpoint responses carry `status` and `say`. An HTTP error or
missing dictionary key is a setup/request failure, not a sent receipt. Check
tailnet access, the screen-server URL and JSON fields. Initial `text` and a
clarification `answer` must be nonempty and at most 16,000 characters; `noteId`
must be 1–100 letters, digits, underscores or hyphens.

For isolated verification, use the sandbox desk
(`npm run desk:test -- --phone-note-fixtures`) with its fixture compiler and
stub deliveries. Exercise a named destination, one
clarification, an unresolved answer and a retry with the same ID. On-device
verification additionally requires a deployed screen server and the phone's
Shortcuts permissions for dictation, network access and speech. The protocol
and scope are described in [Phone voice notes](../specs/phone-voice-note.md).

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
