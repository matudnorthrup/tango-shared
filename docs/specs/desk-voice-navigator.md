# Desk voice: the top-right navigator button

Status: approved for build (owner, 2026-10-22, "go" on the plan). Second slice of
native voice in the Agent Desk, after the reply-box mic
(`docs/specs/desk-voice-composer.md`, PR #1033). Discord stays the always-on and
phone-locked voice channel.

## What the owner gets

The top bar's voice control (`apps/screen/public/desk/next/voice.js`, the pill the
Discord operator lights up) becomes tappable when the Discord operator is not
live. One tap starts a single spoken command for the desk:

1. **Listening.** The owner says one thing: "open the Voice Mode thread", "show me
   what needs me", "go to the Watching tab", "switch to the Acme space",
   "mark that seen", "snooze it till tomorrow", "done with this one".
2. **Doing.** When they stop talking (GPT-Live's end of turn), or tap again, the
   words are resolved to one desk action, and the browser that heard it runs it
   exactly as a tap there would (a detached window stays detached).
3. **Confirming.** A few spoken words in the operator's voice: "Opened Voice Mode."
   / "Snoozed until tomorrow." / "I couldn't tell which thread; the closest are on
   screen." The words also show briefly in the voice pill.
4. **Off.** The session closes and the button goes back to idle. Nothing listens in
   the background.

Tapping at any point stops it. Pressing Esc does too.

## Decisions already made

- **Pipeline:** GPT-Live through the profile's ChatGPT-subscription login
  (`auth: codex`), exactly the route the reply-box mic uses
  (`apps/screen/server/desk/voice.ts`, `voice-exchange.ts`). Never the per-minute
  `api` route.
- **End of turn:** GPT-Live's own end-of-turn signal, like the reply-box mic. The
  owner chose to keep that (not tap-to-send) on 2026-10-22. No undo window: a desk
  action here is reversible (navigation is free; seen/snooze/done have Undo in the
  desk already).
- **Voice:** the operator's voice (`voice-operator.yaml`), since this is the
  desk speaking, not a thread. Threads keep their own palette voices.
- **Scope of actions, first version:**
  - Navigation: open a thread by name, place or "the third one" on the list
    showing; switch list tabs/views (Needs you, Watching, …); switch spaces;
    open Catch me up / Decided for you / PRs pages that exist in the desk; back.
  - Bookkeeping on the thread open (or the one named): seen, unseen, snooze,
    done, pin/unpin.
  - **Not by voice:** approvals, answering decisions, replying or sending
    anything in the owner's name, stop, retry, rename, project moves, system
    controls. If asked, say "that one's a tap" and leave it on screen. (Voicing
    replies is the reply-box mic's job.)
- **Coexists with Discord:** when the Discord operator is live, the pill keeps
  its current behaviour and the tap does not start a browser session. One
  browser navigator session at a time per window; starting one stops a reply-box
  voice exchange in the same window, and vice versa.
- **Resolving the words:** GPT-Live transcribes and delegates (client
  delegation). The server resolves the transcript to one structured action with a
  small Responses call on the same codex auth (`createCodexResponsesCaller` in
  `apps/tango-voice/src/live/responses-caller.ts`), given the window's current
  view and the visible list (titles, places, positions, ids) and the spaces/tabs
  the desk has. Reuse the operator's existing handle resolution and desk-command
  vocabulary where it can be imported cleanly (`live-operator.ts`
  `resolveDeskHandle`, `voice-contract.ts` `VOICE_CLIENT_COMMANDS`); don't fork
  the 5800-line operator, and don't import Discord code into the screen server.
- **Executing:** the browser runs the action through the desk store's existing
  paths (the same navigation, presentation and command calls a tap makes), so
  the result is identical to tapping, including how other windows follow. The
  server resolves the words but never navigates on its own.
- **It must not answer for itself.** As with the reply mic, the model's own audio
  is muted except for the confirmation the server appends.

## Safety

- Same WebSocket origin check as the reply mic (`apps/screen/server/access.ts`).
- Mic permission is asked only on the tap.
- No action outside the list above can be produced: validate the resolved
  action against an allow-list on the server and again in the browser.
- Log each command (transcript length, resolved action, outcome) the way
  `voice-exchange.ts` logs, without storing audio.

## Done means

- A unit-tested resolver: a fixture list plus phrases → expected actions,
  including ambiguity ("which thread?" with the top candidates shown) and
  refusals for out-of-scope asks.
- A browser session state machine like `voice-session.js`, tested without a DOM.
- On the sandboxed test desk (`npm run desk:test`): tap → speak (or inject a
  transcript in the test harness) → the window navigates → confirmation.
- One real GPT-Live session on the live desk through the tailnet proxy, opened
  with `?detached=1`, that opens a named thread by voice. Report timing from end
  of speech to navigation, and to the confirmation audio.
- Screenshots of idle, listening and confirming states in the top bar, desktop
  and phone widths.

## Mac hotkey routing

The Mac dictation shortcut also recognizes possible commands after its transcript
has settled. Ordinary replies keep their frozen reply destination. Command-like
phrases starting with “go to”, “show me”, “switch to”, or “take me to”, and
standalone “back” or “go back”, go through the existing resolver (optionally
prefixed with “please”). Replies starting with “open”, “mark”, “done”, “pin”,
or “back when” remain dictation without a resolver call. Ambiguous or missing destinations and network
failures offer an explicit **Send as text** action, never an automatic reply.

Non-detached owner browser windows register their current catalog through
`/api/desk/navigator/bridge`. Screen-only windows are excluded; the most recently
active eligible owner window wins. The native strip identifies that window and
shows a separate three-second undo before committing a resolved command.

`POST /api/desk/navigator/resolve` is limited to twelve attempts per minute per
caller. Its opaque ticket binds the caller, exchange, original browser connection,
and catalog; it expires thirteen seconds after resolution. `POST /commit` consumes
it before dispatch, and the original browser revalidates the catalog and action
before acknowledging execution. Disconnects, expired tickets, changed catalogs,
and missing acknowledgements fail closed. These routes use the same origin and
owner access checks as the voice transport and reject detached callers. Catalogs,
transcripts and tickets remain in memory; diagnostics retain only metadata.
