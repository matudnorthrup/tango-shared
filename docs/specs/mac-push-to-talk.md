# Mac push-to-talk hotkey in Tango.app

Status: approved (2026-10-22, D-555; D-531 chose this stage). Follows the iPhone app
(`docs/specs/ios-app.md`, PR #1036), which listed it as deferred.

## What the owner gets

From any app on the Mac, the owner taps one global hotkey and speaks until a pause, or holds it and lets go. The words become
a reply to the thread the Agent Desk has open. The result is the same as dictating into that
thread's reply box and pressing Send.

1. **Hold the hotkey.** A small floating strip appears under the menu bar showing "Listening…" and
   the target thread's name. The menu bar icon shows a mic.
2. **Speak.** The live transcript fills the strip.
3. **Let go.** The input ends. The strip shows "Sending in 3s · Undo (Esc)" and then "Sent". The
   3-second undo matches desk dictation.
4. **Done.** The strip fades. Nothing is spoken back, and nothing keeps listening.

Pressing Esc while listening (held or latched) or during the undo window cancels the whole thing, and nothing is sent.

## Decisions in this spec (owner may veto)

- **Tap or hold.** Release before 300 ms to latch listening; model end-of-speech or a second
  shortcut press ends input. Holding for 300 ms or longer ends input on release, ignoring
  model pauses. Listening has a 120-second safety cap, followed by the same three-second undo.
  A tap during connection setup stays latched; a second tap during setup cancels.
  The strip distinguishes “tap shortcut or pause to finish” from “release to finish”.
- **Default key:** ⌃⌥Space, changeable in Settings. It is registered with Carbon
  `RegisterEventHotKey`, which delivers both press and release and needs no Accessibility or
  Input Monitoring grant. Holding a modifier alone (such as Right Option) would need Input
  Monitoring. That can come later.
- **Target:** the desk presentation's open conversation. `GET /api/desk/presentation` gives
  `view == "conversation"` and `itemId`. The item must be replyable, the same check
  `voiceSetup` already makes. If no thread is open, or it can't take a reply, the strip says
  "Open a thread on the desk first" and nothing records. Spoken desk commands (the navigator)
  and starting new threads by voice are left for a later slice.
- **Dictation only.** There is no read-back and no Focus back-and-forth in this version.
- **Never approvals.** Spoken words only ever become a reply. Decisions and approvals stay taps,
  per the standing voice rule.

## How it works

- **Voice path:** reuse the desk's existing voice socket. The app opens
  `wss://<desk>/api/desk/voice?mode=dictation&manualFinish=1` with an `Origin` header equal to the desk origin
  (the upgrade refuses requests with no Origin). The rest is the same protocol `voice.js` speaks:
  - It sends 24 kHz mono PCM16 as binary frames of at most 9600 bytes (200 ms).
  - It sends `{"type":"finish"}` on held release, latched speech end or second tap, or the safety cap.
  - It shows the `transcript` and `status` events it receives, and surfaces `error`.
  This keeps the desk on the ChatGPT-subscription route only, never the per-minute API route.
  The opt-in `manualFinish=1` flag emits `{"type":"status","state":"speech_end"}` on model
  delegation without ending input. Only a latched app acts on that signal; held capture
  continues until release. Browser sessions retain their existing default.
- **Sending:** after the undo window, the app posts the final transcript as a reply through
  `POST /api/desk/commands` as a `reply` command, the same one the reply box's Send makes. It uses
  TangoDeskKit's command creation and JSON transport and an idempotency key per utterance.
  Native posts omit `Origin`/`Sec-Fetch` and never set an identity header, as on iOS. A refused
  or failed send shows in the strip and posts a macOS notification with the reason. It is never
  shown as sent.
- **Capture:** `AVAudioEngine` input tap, converted with `AVAudioConverter` to 24 kHz mono
  Int16. The engine runs only during an explicit held or latched listening session.
- **Desk URL:** a new Settings field "Desk URL". It defaults to
  `http://127.0.0.1:9410` (the local desk) if that answers, otherwise empty. It is validated with
  TangoDeskKit's URL rules, and loopback HTTP is allowed.
- **Package:** Tango.app takes a local path dependency on `apps/tango-ios/TangoDeskKit` (it
  already supports macOS 15). It does not copy that code.
- **Permissions:** add `NSMicrophoneUsageDescription` to the generated Info.plist in
  `scripts/build-app.sh`. The first hold triggers the macOS mic prompt. If permission is denied,
  the strip says so and offers Open Privacy Settings. Ad-hoc builds lose the grant when they are
  re-signed, so the README notes that the owner's Developer ID signing step makes it stick.
- **Coexistence:** if a desk browser voice session or the Discord operator is already live, the
  hotkey still works, because it is a separate socket and the desk allows several exchanges.
  Only one hotkey session runs at a time; a second press while one is sending is ignored.

## Out of scope

The navigator by voice, Focus (spoken replies), starting threads, wake words, menu-bar-only
recording without the desk, iPhone voice, and any change to the Discord operator.

## Verification

- **Swift unit tests (TangoKit or a new TangoVoice target):**
  - the hotkey tap/hold threshold, speech end by mode, second tap, safety cap and Esc state machine;
  - PCM conversion and framing (sample rate, Int16, at most 9600 bytes);
  - target resolution from presentation JSON (conversation vs board vs non-replyable);
  - the undo timer cancelling the send;
  - the exact reply command body and headers;
  - failure surfaces.
- **A socket test against a local fake** speaking the desk voice protocol.
- **Live check on the owner's Mac**, using the sandboxed test desk (`npm run desk:test`), never
  the live desk:
  - hold, speak, release, and see the reply land in a scratch thread;
  - tap, speak, pause, and see the same undo and reply; a second tap also ends input;
  - Esc cancels while latched, held or counting down;
  - with no open thread, nothing records.
  Capture a screen recording of the strip into the artifacts folder.
- `swift build`, `swift test` and `scripts/build-app.sh` all succeed. The README is updated.

## Live mic arming

A separate menu-bar Live mic toggle and configurable Control–Option–Shift–Space
shortcut arm the microphone. Arming is never persisted; app launch starts off.
The existing tap/hold semantics, frozen reply target, undo window, and reply-only
command authority remain unchanged. After send/cancel, return to armed and muted.
A muted mic icon identifies armed state; a filled mic identifies listening.

Privacy boundary: the audio callback checks its mute gate under the same lock
used for conversion and drain. Muted frames are dropped before conversion,
copying or buffering. Unmute replaces the converter to avoid retaining audio
from a prior exchange. No pre-roll is sent. Audio leaves the app only after the
user starts dictation and the destination and model connection are ready. No
new audio or transcript logging is permitted.

The existing server exchange has a 20-minute absolute limit and eagerly opens
its subscription model. The new opt-in `mode=dictation&manualFinish=1&warm=1`
socket instead emits `armed` without constructing a model client. Binary input
in this state is discarded. An explicit `start` opens the model leg once and
starts the existing 20-minute limit. Dormant sockets have a 35-minute bound;
the app disarms after 30 minutes without dictation. Transport pings every 25
seconds exercise the desk connection without sending silence or consuming a
model session. On a stale socket, reconnect once transparently; Connecting stays
visible until ready. No claim of zero model-connection latency is made. Close
the model and open a fresh dormant socket after each exchange.

Auto-disarm triggers: 30 minutes idle, sleep, screen lock, default input-device
change, or unsuccessful socket reconnect. Stop capture, close the socket, discard
pending input and notify once. Dictation pauses the idle timer. No automatic
rearming after sleep/unlock or app relaunch. Bluetooth input defaults to socket
warming only; the Settings checkbox “Don't keep the mic armed on Bluetooth
headsets” can opt out. Unknown device transport queries fail conservatively to
socket-only mode. Concurrent meeting apps remain usable; held microphone access
lights the macOS privacy indicator and may put Bluetooth audio into call quality.

Verification includes injected lifecycle tests, muted capture/drop checks, real
loopback native WebSocket activation, and server upgrade tests that assert no
model creation or audio delivery while armed. Redo the security review from
#1059 for the expanded capture lifetime and dormant-socket protocol before
release. Physical microphone, Bluetooth switching, sleep/lock and meeting-app
coexistence require candidate validation on macOS; a candidate build does not
install or restart services.
