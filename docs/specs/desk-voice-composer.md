# Desk voice: the reply box mic

Status: approved for build (owner, 2026-10-22). First slice of native voice in the
Agent Desk. Discord stays the always-on and phone-locked voice channel.

## What the owner gets

A mic icon next to the paperclip in a thread's reply box. One tap starts a single
spoken exchange with that thread:

1. **Listening.** The owner talks. What they say streams into the reply box as text.
2. **Sent.** When they stop talking (GPT-Live's end of turn), or tap the mic again,
   the text is sent as a normal reply, through the same path as typing and Send.
   A short undo window (about 3 seconds, like voice draft mode's Undo) comes first.
   Tapping into the text during that window cancels the send and leaves the text
   there to edit.
3. **Waiting.** The mic input is closed. The icon shows that the thread is working.
   Nothing is spoken while it works.
4. **Spoken reply.** When the thread's turn ends, the reply is spoken as a short
   spoken version (2 or 3 sentences, about 20 seconds at most), in **that thread's
   own voice**. The full reply shows on screen as usual.
5. **Off.** When speech ends, the session closes and the icon goes back to idle.

At any point, tapping the icon stops the exchange. During speech that means "stop
talking", not "stop the thread". The thread's own Stop button is unchanged.

## Decisions already made

- **Pipeline: OpenAI GPT-Live, the one the browser playground uses**
  (`apps/tango-voice/src/testing/live-operator-playground.ts`,
  `apps/tango-voice/src/live/gpt-live-client.ts`, `codex-live-client.ts`,
  `create-live-client.ts`). The owner ruled out Deepgram, Cartesia and the
  retired local Kokoro pipeline for this slice. GPT-Live handles speech-to-text
  (its input transcript), turn detection, and the spoken output.
- **Auth route:** read `auth` from the operator profile (`voice-operator.yaml`;
  the owner's is `codex`, the ChatGPT subscription login). Use the same
  `resolveLiveRoute`. Never fall back to the per-minute `api` route on your own:
  that is spend the owner hasn't approved.
- **Placement:** the thread reply box only (`ComposerActions` in
  `apps/screen/public/desk/conversation.js`, beside `AttachButton`). It uses the
  same `ib` icon-button style, with a mic glyph (lucide-static is already a
  dependency). Hide it when a voice draft from the Discord operator is live for
  that item (`voiceDraft(...).live`), when the thread isn't replyable, or when
  the browser has no `getUserMedia`.
- **Summaries come from GPT-Live itself.** At turn end, append the thread's reply
  as context to the same session (see how `LiveOperator.append` / `condense` do
  it in `live-operator.ts`). The instructions must tell it to say a spoken version:
  no code, no paths, ids or URLs, and "the details are on screen" when there's
  more. Reuse the operator's `condense` summarizer for long replies if it helps;
  don't add a new model provider.
- **It must not answer for itself.** Session instructions: it is a voice for this
  thread only; after the owner speaks it says nothing (at most "Sent."); it only
  speaks the thread's reply when one is appended. Measure this on the real
  model: if it still volunteers answers, mute its output until the reply is
  appended, and say so in the PR.

## Voices per thread

- Keep a fixed palette of GPT-Live voices on the server, leaving out the
  operator's voice so threads never sound like the operator. Check which voice
  names the live route accepts (`marin`, `compass` and `cove` are known; find
  the rest from the API or by trying them) and list them in the PR.
- Named agents (watson, sierra, …) can set a voice in the profile:
  `voice.live_voice` in the agent's profile config, read through the existing
  config loader. It is optional, and no real agent values go in tracked files.
- Every other thread (Loom coding threads) gets a stable voice from the palette,
  hashed by thread id, so the same thread always sounds the same.
- Show the voice name in the mic button's tooltip ("Speaks as Cove").

## Server

- A WebSocket endpoint on the desk server (Hono, `apps/screen/server`) at
  `/api/desk/voice?item=<itemId>`, the same audio framing as the playground:
  binary 24 kHz PCM16 frames in and out, JSON frames for status and transcript.
  It is tailnet-only like the rest of the desk, with the same auth and origin
  checks the desk's other mutating routes use.
- Reuse the GPT-Live clients from `@tango/tango-voice` rather than copying them.
  If importing them into `@tango/screen` pulls in Discord or native deps, move
  only the client files and `live-audio.ts` into a small shared module, keeping
  the operator's imports working. Pick the smaller change and say which in the PR.
- Detect turn end from the desk's own state (the item leaves `working`, a new
  agent message appears), the way `desk-client.ts` watches Loom threads for the
  operator. Don't add a new Loom event.
- Session lifetime: at most one exchange per tab at a time. Keep the GPT-Live
  session open with input muted while the thread works, up to 10 minutes. If the
  turn runs longer, close it and open a fresh session (no mic) just to speak the
  reply when it lands, as long as the tab is still connected. If the tab is gone,
  speak nothing. Hard cap of 20 minutes, as in the playground.
- Log each exchange (start, sent, turn end, spoken, ended, errors, duration) to a
  JSONL file under the screen data dir, as the playground does.

## Browser

- Capture with `getUserMedia` (`echoCancellation: true`) and an AudioWorklet
  converting to 24 kHz PCM16 in 100 ms chunks, as the playground does.
- Create and unlock **one** `AudioContext` on the tap. Play all output through it,
  never new `<audio>` elements: iOS Safari and home-screen apps need this.
- Close the mic track as soon as the reply is sent, so AirPods leave the call
  profile before playback.
- If the page is hidden (phone locked or app backgrounded), end the exchange
  cleanly and leave the sent reply alone. Don't try to keep audio alive in the
  background.
- States on the icon: idle, connecting, listening (with a live level), sending
  (undo), waiting, speaking, error. Use the desk's existing tokens and motion.
  Add no new colours.

## Out of scope for this slice

Always-on listening, fire-and-forget voice notes, focus sessions, event sounds,
the start-work, coordinator and "Ask" boxes, house screens, any change to the
Discord operator or its voice, and the per-minute API route.

## Verification

- Unit tests: the exchange state machine (every transition, cancel in each
  state, the undo window, page hidden), the voice picker (stable per thread,
  never the operator's voice, profile override), and the server route with a
  fake `LiveSessionClient`. Include a long turn that crosses the 10-minute
  reopen.
- Desk check on the sandboxed test desk (`npm run desk:test`, never the live
  desk), using Chromium's fake mic (`--use-fake-ui-for-media-stream
  --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>`)
  with a short spoken WAV. Show the transcript landing in the box, the send, the
  waiting state, and the spoken-reply state. Before/after screenshots, desktop
  and phone widths.
- One real GPT-Live exchange on the subscription route, from the test desk
  against a scratch thread: record the latency from end of speech to send, and
  from turn end to first audio, and confirm it didn't answer for itself.
- `npm run typecheck` and the screen and tango-voice test suites pass.
