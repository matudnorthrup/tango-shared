# Voice Turn-Taking: One Way to Talk to Tango

Status: approved design. Delivery steps, status and open questions are tracked
in Linear ([TGO-1171](https://linear.app/example-hq/issue/TGO-1171)).
Scope: when Tango decides you've finished talking, on every voice surface. It
builds on [Desk voice composer](desk-voice-composer.md),
[Desk voice Focus](desk-voice-focus.md), [Mac push-to-talk](mac-push-to-talk.md)
and the voice operator's draft mode
([voice operator guide](../guides/voice-operator.md)). Those specs are
unchanged except where this one says so.

## The problem

There are now two families of voice surfaces, and they decide "you're done"
in different ways. Each family has a pattern the other lacks.

**The desk family** (newer, and working well). Every surface in it talks to the
desk server's voice exchange (`apps/screen/server/desk/voice-exchange.ts`):

| Surface | How a turn ends today |
|---|---|
| Reply-box mic (desk, and the iPhone app's desk) | 1.5 s of quiet after words (local endpointer, #1074) or GPT-Live's end of turn → 3 s undo → sent |
| Focus loop, Start work, Other-answer mic | Same rule |
| Mac hotkey, tapped | Its own copy of the endpointer (`SpeechPause.swift`, #1068) or a second press → 3 s undo → sent. 120 s cap |
| Mac hotkey, held | Release ends it. Pauses are ignored |
| Desk voice navigator | GPT-Live's end of turn, no undo (one short command) |

**The voice operator** (GPT-Live in the Discord voice channel, and its browser
playground). GPT-Live's own end of turn, plus draft mode (`draft-mode.ts`):

- an end judge (a model call after 1.2 s of quiet, a second look at 6 s);
- **ramble**: "this is a long one", "let me think out loud", "I'm not done";
  after that, only a closer such as "okay, send it" sends;
- an "Is that everything?" check for requests that end mid-sentence;
- a 5 s undo, and asides by name ("Yankee, …") that are never dictated.

**Outside both:** mobile voice dispatch (the Action Button Shortcut, where
Apple decides) and Wispr Flow (which decides itself and pastes text).

So:

- **Nothing in the desk family can ramble.** A 30-second think-out-loud on the
  reply-box mic or the Mac hotkey gets cut at the first 1.5 s pause and sent
  half-finished. Holding the Mac key is the only way to keep going, and it
  only works on the Mac.
- **Nothing in the desk family notices an unfinished end.** "…and the other
  thing is," followed by a breath is sent.
- **Ramble is unreliable even on the operator.** "Hey, I'm gonna ramble for a
  minute" said cold matches no deterministic start pattern. "I'm gonna talk for
  a while" matches nothing, so both depend on the router model.
- **The same words do different things.** "Send it" is a closer on the
  operator and plain dictation on the desk. The undo is 5 s on the operator
  and 3 s elsewhere.
- **The browser playground** gives the operator a bare draft session with no
  end judge (`live-operator.ts`, `options.draft ?? new DraftSession(...)`).
  Drafts there never end on their own, unlike the Discord wiring in
  `src/testing/live-operator-discord.ts`.

## The pattern (product)

One rule set, owned by one module, used by every surface.

### Quick send (the default)

Unchanged from what's working on the desk:

- **Talk, pause, it goes.** A pause of 1.5 s after words ends the turn. So
  does the model's end of turn, or a tap, a second press or a key release.
- **3 s undo** on every surface that sends text in your name, then sent. The
  voice operator moves from 5 s to 3 s. The navigator keeps no undo, because
  its actions have their own Undo.

One addition:

- **An unfinished end waits a little longer.** If the words so far end on a
  dangling word ("and", "because", "so", "um"), a trailing comma, or announce
  more ("a few things:", "first,", "here's what I noticed:"), the pause needed
  rises from 1.5 s to 4 s. Nothing is asked and nothing is shown, except that
  the strip keeps saying "Listening…". It's the desk's version of the
  operator's "Is that everything?", made silent because the desk never talks
  over you. The operator keeps its spoken check and its end judge, which serve
  the same purpose with a model already in the loop.

### Ramble (hold until I say so)

- **Starts** from a preamble at the start of a turn: "I'm gonna ramble for a
  minute", "I'm gonna talk for a while", "this is a long one", "bear with me",
  "let me think out loud", "let me get this all out". Or from a hold said
  mid-turn: "hold on", "I'm not done", "keep listening".
- **While rambling** no pause ends it, however long. The strip says
  "Holding · say 'send it' when you're done" (the voice operator stays
  silent, as now).
- **Ends** on a closer said after a pause: "okay, send it", "that's it",
  "that's all", "I'm done", "go ahead", "over to you". The closer is removed
  from the text. A closer in the middle of a sentence is dictation. A tap, a
  second press or a key release also ends it, so the physical control is
  always a closer.
- **Then the same 3 s undo** and the same send as quick send.
- **Long silence:** after 90 s of quiet the strip shows "Still holding · Send ·
  Keep" (the operator asks once by voice, as now). The cap per surface rises in
  ramble: the Mac's 120 s cap becomes 10 minutes.
- **The preamble itself** ("I'm gonna ramble for a minute") is removed from the
  sent text when it's the whole first sentence.

### Words that work everywhere

| Intent | Words | Where it applies |
|---|---|---|
| Ramble | the preambles and holds above | everywhere except the navigator (one command, never long) |
| Send | "send it", "that's it", "that's all", "I'm done", "go ahead", "over to you", "Yankee, over" | ramble everywhere; on the operator, also draft |
| Cancel | "never mind", "cancel", "forget it" as the whole last segment | everywhere |
| Undo | "undo", "wait", "don't send that", inside the undo window | wherever the mic is still open during undo (operator, Focus loop); elsewhere, the strip's Undo or Esc |

The operator's asides by name stay operator-only, since only the operator
answers questions.

### Per surface

- **Reply-box mic, Focus, Start work, Other-answer, iPhone app desk:** all
  of the above, from one change on the server.
- **Mac hotkey, tapped:** all of the above. The app asks the server whether to
  finish (below) instead of finishing on its own pause.
- **Mac hotkey, held:** unchanged. Holding is already ramble, and release is
  the closer.
- **Navigator:** quick send only, with the unfinished-end wait. No ramble.
- **Voice operator (Discord and playground):** ramble preambles become
  deterministic, the undo becomes 3 s, and the playground is wired like
  Discord. Draft mode is otherwise unchanged.
- **Mobile dispatch Shortcut:** see Mobile dispatch below. It's text pieces, not audio.
- **Wispr Flow, typing, iMessage:** unchanged. Enter is the closer.

## Technical design

### One policy module

`apps/tango-voice/src/turn/turn-policy.ts`, pure (no IO, no GPT-Live),
exported as `@tango/tango-voice/turn/turn-policy` and added to
`tsconfig.clients.json`, the same way `apps/screen` already imports
`live/gpt-live-client`.

```ts
export const TURN = { pauseMs: 1500, unfinishedPauseMs: 4000, undoMs: 3000,
                      rambleNudgeMs: 90_000, rambleCapMs: 600_000 } as const;

// Moved from draft-mode.ts unchanged, re-exported there for its callers.
export { normalizeSpeech, stripAsrNoise, opensLong, isDraftHold as isHold,
         matchDraftFinish as matchFinish, contentBeforeFinish, isDraftCancel,
         isUndo, looksUnfinished } from …;

export function opensRamble(firstSentence: string): boolean; // LONG_LEAD + new preambles
export function announcesMore(text: string): boolean;

export type TurnMode = 'quick' | 'ramble';
export class TurnPolicy {
  constructor(opts?: { ramble?: boolean /* false for the navigator */ });
  /** Transcript text as it arrives (deltas or whole segments). */
  words(text: string): void;
  /** A local pause of `quietMs` after speech, or the model's end of turn. */
  pause(quietMs: number, by: 'local' | 'model'):
    | { kind: 'finish'; text: string }        // send (after undo)
    | { kind: 'cancel' }
    | { kind: 'wait'; untilMs?: number; mode: TurnMode; nudge?: true };
  /** Tap, second press, release: always finishes (ramble included). */
  explicitFinish(): { kind: 'finish'; text: string };
  mode(): TurnMode;
}
```

How it decides on each pause, in order:

1. The last segment (text since the previous pause) is a cancel → `cancel`.
2. Ramble: the last segment ends with a closer → `finish` with the closer
   removed. Otherwise `wait` (with `nudge` once at 90 s).
3. Quick: the last segment is a hold, or the turn opened with a ramble
   preamble → switch to ramble, `wait`.
4. Quick: the text ends unfinished or announces more, and `quietMs` is under
   4 s → `wait { untilMs: 4000 }`.
5. Otherwise `finish`.

A model end of turn goes through the same steps, so in ramble GPT-Live's
end of turn is ignored, as it already is in the operator's draft mode.

### Desk voice exchange (`apps/screen/server/desk/voice-exchange.ts`)

- Each exchange owns a `TurnPolicy` (`ramble: false` for `NavigatorExchange`).
  Transcript deltas feed `words()`. The two places that call
  `finishInput('pause' | 'model')` call `policy.pause()` first and only finish
  on `finish`.
- `SpeechPause` gains `trailingQuietMs` (the Swift copy already has it) and
  keeps reporting while quiet, so the exchange can re-ask at 4 s and at 90 s.
- New status events to clients: `{type:'status', state:'holding'}`,
  `{state:'holding_nudge'}`, `{state:'waiting', untilMs}` during an unfinished-end
  wait in quick mode (the strip still reads "Listening…"), and
  `{state:'listening'}` when it returns to quick mode. `finish` carries the final text with closers and the preamble removed.
- `manualFinish` clients (the Mac app) get `speech_end` only when the policy
  says `finish`. That turns the Mac's local pause from a decision into a
  request: the app sends `{type:'pause', quietMs}` when its `SpeechPause` fires,
  and finishes on the server's `speech_end`. The server answers every `pause`:
  `speech_end` on `finish`, `{type:'status', state:'waiting', untilMs}` while the
  policy waits out an unfinished end, or `holding` in ramble. Any of these
  cancels the app's fallback. Only no answer at all within 300 ms (an older
  server) makes the app finish on its own, as today.
- `input_end` logs `by` plus `mode` and `rule` (closer, pause, unfinished-wait,
  explicit), so the trace shows why each turn ended.

### Browser (`apps/screen/public/desk/voice*.js`)

The strip learns the `holding` and `holding_nudge` states (the copy above),
plus a Send button in ramble, which is the same as a tap. No logic moves into
the browser.

### Mac app (`apps/tango-app`)

- `VoiceSession.swift`: on a local pause, send `pause` and wait for
  `speech_end` (300 ms fallback). Show "Holding" on `holding`.
- `PushToTalk.swift`: the 120 s cap becomes 10 minutes while holding.

### Voice operator (`apps/tango-voice/src/live`)

- `draft-mode.ts` imports its phrases from `turn-policy.ts`. `matchDraftStart`
  gains the cold ramble preambles, which set the existing long flag.
- The undo window (`sendDelayMs` and the minimum undo display) moves to
  `TURN.undoMs`.
- `src/testing/live-operator-playground.ts` builds its `DraftSession` with
  `createDraftCompiler` and `createDraftEndJudge`, as the Discord and TTS entry
  points do.

### Mobile dispatch (`packages/voice`)

Each Shortcut press is one finished segment. The bridge keeps one open turn
per session and runs the same `TurnPolicy` with `pause(TURN.pauseMs, 'local')`
per press: an ordinary press finishes, and an unfinished end returns `wait`
(the bridge keeps it as a quick hold) instead of falling through to `finish`. A press that holds returns at once with `turnTaking: { status:
'held', say: 'Holding. Say send it when you're done.' }`, and the Shortcut
speaks `say`. The next presses are added, and a closer sends the joined text
through today's `onTranscript`. Older Shortcuts ignore the new field. Quick
holds (an unfinished end) are finished with `explicitFinish()` after 20 s
without a press, and a ramble is kept for 12 hours. `packages/voice` takes a dependency on the
`turn-policy` subpath only.

### Testing

- `turn-policy` fixtures: about 150 utterances and segment sequences (from the
  operator's live-test history, the 2026-10-22 desk sessions in #1074, and the
  tables above), each with the expected decision. One file, run by the policy's
  own tests. The desk exchange and the mobile bridge run a subset through their
  paths.
- Draft mode's existing tests pass unchanged after the move, showing its
  behavior didn't change.
- Exchange tests: a 1.5 s pause finishes; "…and" waits until 4 s; a preamble
  then a 10 s pause doesn't finish; "okay send it" after a pause finishes
  without the closer; a tap finishes ramble; the navigator never rambles; a
  model end of turn in ramble is ignored.
- Mac: `SocketTests` with the fixture server covering `pause` → `speech_end`,
  `pause` → `holding`, and the 300 ms fallback.
- Live: the reply-box mic on the sandboxed test desk (`npm run desk:test`) with
  a real 60 s ramble, a quick send and a trailing "and". The Mac hotkey tapped
  with the same three. One operator sweep run with "Hey, I'm gonna ramble for
  a minute" said cold. Timings from end of speech to send are reported in the
  PR.

## Delivery

The step-by-step plan, its status and the open questions live in Linear:
[TGO-1171](https://linear.app/example-hq/issue/TGO-1171). In short: the policy
module and the operator first, then the desk exchange, the Mac hotkey, and
mobile dispatch, each shipping on its own.
