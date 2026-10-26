# Phone voice notes through the operator

Status: proposed (2026-10-25)

A phone button that takes one dictation, works out where it goes the way the
voice operator does, delivers it through the Agent Desk, and frees the phone in
a few seconds. The result is read later in the Tango app, not waited on.

It replaces the "long jobs" half of the iOS Shortcut in
[mobile-voice-dispatch.md](../guides/mobile-voice-dispatch.md). That Shortcut
stays as it is for quick spoken questions and gets no new features: it posts
to the voice bridge inside the Discord bot, which is the route
[tango-conversations-off-discord.md](tango-conversations-off-discord.md) is
leaving.

## What the owner gets

1. Press the Action Button and talk ("Sierra, start a thread on the shed vents
   quote, ask the shop for…", or "in tango, fix the desk menu overflow…").
2. Within about 5 seconds the phone says where it went: "Sent to Sierra, new
   thread: shed vents quote." or "Started a tango thread: desk menu overflow."
3. The phone is free. The work runs on the desk like any other conversation,
   and the reply shows up in the Tango app.

When the destination isn't clear, the phone asks one short question ("Who's it
for?") and listens once more. If that still doesn't settle it, the note is held
on the desk as a draft with no destination. It is never sent to a guess.

## Why not the existing routes

| Route | Reaches | Problem for this |
|---|---|---|
| iOS Shortcut → `/mobile/voice-dispatch` (Discord bot) | an agent's home channel, by wake word | No desk threads or Loom threads; waits for the whole reply, so iOS times out on long jobs; built on the Discord bot |
| Discord voice operator | everything | Needs a live GPT-Live session in a Discord voice channel; not a one-press phone action |
| Desk reply-box mic ([desk-voice-composer.md](desk-voice-composer.md)) | the thread already open | Can't pick or start a destination |

The operator already has the part this needs: draft mode's compiler
(`createDraftCompiler` in `apps/tango-voice/src/live/draft-mode.ts`) turns
dictated fragments into one clean message plus a destination: a desk item, an
agent's thread, a new agent thread, a new Loom thread in a repo, or an agent's
home channel. It is one text-model call with no live session.

## Design

### Endpoint: on the desk

`POST /api/desk/voice-note` on the screen server. Not on the Discord bot, and
not in the live operator process, which only runs while a voice session is up.

Request:

```json
{ "text": "<dictated text>", "noteId": "ios-20261025-101500-123", "answer": "<optional>" }
```

- `noteId` is the idempotency key. A retried press with the same id never
  delivers twice.
- `answer` is the reply to a question this note asked. It is sent with the
  same `noteId`.

Response, always quick (target under 5 s, hard cap 15 s):

```json
{ "status": "sent" | "ask" | "held", "say": "Sent to Sierra, new thread: shed vents quote.", "itemId": "…" }
```

`say` is always present and always safe to speak. The Shortcut reads only
`status` and `say`.

### Auth

The phone reaches the desk at its tailnet `tailscale serve` address. The
existing `accessControl` middleware (`apps/screen/server/access.ts`) already
admits the owner's tailnet login and refuses Funnel. No new token is added and
nothing is exposed beyond the tailnet. Shortcuts' `Get Contents of URL` has no
`Origin` header, so the browser-origin checks don't block it; it still has to
send `Content-Type: application/json` (`requireJsonPosts`).

### Routing

The handler builds a `DraftCompileInput` from the desk's own state: active items
(as the operator's `desk` context), the agents from the operator profile, and
the Start work repos. It sets `fragments: [text]` and an empty transcript, then
calls the same compiler with the operator profile's `auth` route (the owner's
ChatGPT login, per D-699; never an API key on its own).

Destination resolution follows draft mode, with two phone-specific rules:

- **No screen place.** The phone has no "place on screen", so `startPlace` is
  null. A new Loom thread needs a repo the owner said out loud.
- **Same ramble rule as the operator.** With no agent, item or repo named and
  more than one plausible fit, it asks rather than guessing.

To share this without importing operator internals, move `resolveDestination`'s
pure part out of the `DraftMode` class into a function both callers use. That
is the only refactor of operator code.

### Delivery

Through the desk's existing write paths, the same ones the operator calls:

| Destination | Path |
|---|---|
| desk item (existing conversation) | the reply command the operator's `replyToItem` uses |
| new agent thread | `POST /api/desk/agent-threads` |
| new Loom thread | `POST /api/desk/start-work` (commandId `phone-<noteId>`) |
| agent home channel or existing agent thread | the desk's reply path (`/screen/input` on the bot today, `/conversations/turn` once the off-Discord move lands) |

The handler returns as soon as the desk accepts the delivery. It never waits
for the agent's reply. "Sent" is said only after the delivery path reports
success (the false-"sent" rule from TGO-1171).

### Questions and held notes

- `status: ask`: the compiler asked a question. The note is kept server-side
  under `noteId` for 2 minutes. The Shortcut dictates once more and posts the
  answer.
- Still unsettled after the answer, or no answer within 2 minutes: the note is
  stored as a held draft on the desk (a "Phone note" item needing a
  destination), and `status: held` says "Saved it on the desk; pick where it
  goes there."

### The Shortcut

A second Shortcut, `Tango Note`, on the Action Button. `Tango Dispatch` stays
for quick asks and can move to Back Tap or Siri.

1. `Dictate Text` (Stop Listening: After Pause).
2. `Text`: `ios-` + Current Date as `yyyyMMdd-HHmmss-SSS`.
3. `Get Contents of URL`, POST, JSON body `text`, `noteId`.
4. `Speak Text` with `say`.
5. `If status is ask`: `Dictate Text`, post again with `noteId` and `answer`,
   then `Speak Text` with `say`.

The guide documents it under a new section of `mobile-voice-dispatch.md`.

## Out of scope

- Hearing the reply on the phone. The Tango app shows it; a push notification
  when a phone-started thread finishes is a possible follow-up.
- Any change to `Tango Dispatch` or `/mobile/voice-dispatch`.
- Live back-and-forth from the phone (that is the operator in Discord voice).
- Android. Tasker can call the same endpoint; no guide in this slice.

## Tests

- Unit: request validation, idempotency on `noteId`, ask → answer → sent,
  ask → timeout → held, never "sent" when delivery fails.
- Routing replays: reuse the operator's routing replay set
  (`apps/tango-voice/src/testing/replay-routing-place.ts`) with `startPlace`
  null, plus phone phrasings: a named agent, a named repo, a continuing
  conversation, and a ramble with no target.
- Live check on the sandbox desk (`npm run desk:test`) with curl posing as the
  Shortcut. On-device check on the owner's phone is the owner's step.

## Build order

1. Extract the pure destination resolver; operator tests stay green.
2. `/api/desk/voice-note` with sent and held (no questions).
3. Questions (`ask` and `answer`).
4. Guide section and the `Tango Note` Shortcut recipe.
