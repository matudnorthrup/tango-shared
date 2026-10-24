# Voice operator (Discord)

The voice operator is a full-duplex voice assistant that sits in a Discord voice
channel. You talk to it naturally, with no wake word or close word. It hands work
to your Tango agents, keeps talking with you while they work, and relays what
comes back one result at a time ("Okay, now Sierra says…"). With a screen service
configured it is a client of the [Agent Desk](../specs/agent-desk.md): the desk
tracks every conversation and what you've seen; the operator catches you up from
it ("catch me up"), marks items done, seen, snoozed or parked by voice, and moves
the screen to the conversation you're talking about.

It runs on OpenAI GPT-Live and calls your agents through the bot's normal
`/voice/turn` bridge. Agents work in their usual sessions, channels, and memory,
exactly as they do for text.

Each person gets their own operator: their own voice channel, their own agents,
their own accounts. Everything about a person lives
in the profile config. Nothing person-specific lives in code.

## Requirements

- **The Tango bot on a current `main`, with its voice bridge on** (`TANGO_VOICE_BRIDGE_ENABLED=true`
  in the bot's `.env`). The operator needs the `/voice/turn` bridge to return Discord
  message ids (added in 2384d218). Restart the bot after updating.
- **A voice channel** in a server the bot is in. The bot needs View Channel, Connect,
  and Speak there.
- **GPT-Live access**, either of:
  - A **ChatGPT subscription** (`auth: codex`). Sign in once with the Codex CLI
    (`codex login`), which writes `~/.codex/auth.json`. Voice time counts against that
    ChatGPT plan. Use `codex:/path/to/CODEX_HOME` for a login stored elsewhere.
  - An **OpenAI API key** with `gpt-live-1` access (`auth: api`). Set `OPENAI_API_KEY`;
    usage is billed per minute.
- **Node 22+** and `npm ci` in the checkout.

One bot can be in only one voice channel per server at a time. If two people on the
same install want to use the operator at once, give them separate servers or separate
bots. The operator waits while the bot is busy in another voice channel (for example,
another operator).

## Configure

Create `voice-operator.yaml` in your profile's config directory, for example
`~/.tango/profiles/default/config/voice-operator.yaml`, or point
`TANGO_VOICE_OPERATOR_CONFIG` at a file:

```yaml
operators:
  - id: alex                       # any short name; used with --operator
    voice_channel_id: "100000000000000101"
    # Your Discord account(s). Only these people are heard and can start the
    # operator, and only their replies and reactions mark things read.
    owner_user_ids: ["100000000000000201"]
    # Agent ids from config/v2/agents (as layered by your profile). Names, call
    # signs, and home channels come from the agent configs. A role is what the
    # operator says when it chooses who should take a request; it defaults to the
    # agent's first responsibility.
    agents:
      - id: piper
        role: "operations: calendar, follow-ups, priorities"
      - cod-e
    auth: codex                    # or codex:/path/to/CODEX_HOME, or api
    # voice: cove                  # optional GPT-Live voice
    # idle_minutes: 10             # hang up GPT-Live after this much silence; your next words wake it
    # screen_url: http://127.0.0.1:9410   # optional: the screen service and its Agent Desk
    # state_dir: ~/somewhere       # logs; default: <profile data>/voice-operator/<id>
    # People you talk about. Speech-to-text garbles names it doesn't know; the router
    # writes these as listed, and every heard_as spelling is replaced before an agent
    # sees the request. Add a spelling here when you notice a new one in a thread.
    # people:
    #   - name: Example Person
    #     note: who they are
    #     heard_as: [Exampel Person, Ex Ample]
```

To find Discord ids, turn on Developer Mode in Discord (Settings → Advanced), then
right-click the channel or your name and choose **Copy ID**.

Owners are required. Without them, anyone who could join the channel would be able
to drive your agents. Also restrict who can see the channel in Discord.

## Run

From the root of your Tango checkout:

```bash
node --env-file=.env --import tsx apps/tango-voice/src/testing/live-operator-discord.ts --operator alex
```

The env files need `DISCORD_TOKEN` (the bot) and the bridge settings the bot uses:
`TANGO_VOICE_BRIDGE_API_KEY`, plus `TANGO_VOICE_BRIDGE_PORT` and
`TANGO_VOICE_BRIDGE_PATH` if you changed them. Pass several `--env-file` flags if
they're split across files. If only one operator is configured, `--operator` needs
no id.

Join the voice channel. The bot joins, greets you, and you can start talking:

- "Ask Piper what's on my calendar tomorrow."
- "Start a thread with Cod-E about the onboarding doc."
- "What's still pending?" / "Read me that whole reply."
- "Mark that read." / "I'll come back to that later." / "Remind me what I need to do."

It leaves 15 seconds after you do.

### What voice says without being asked

A voice session starts clear when you join. From then on, voice speaks:

- answers to what you asked or directed in this session: requests you made by voice, and
  replies to messages you sent this session, whether typed on the desk or in Discord. A
  message typed while GPT-Live was asleep doesn't count: you were working in that thread and
  read its answer there. It speaks one answer per message you send. Later turns in that thread (progress, work woken
  by another agent's mail) wait for you;
- failures of your own requests;
- a **knock** (below) for a new needs-you item, for the urgent lane (empty unless you fill
  it), and for an answer you asked for that arrives while you're in the middle of something
  else. Progress, ships and FYIs wait for the catch-up.

Everything else waits until you ask: "what's waiting?", "catch me up", "what's next?". That
includes decisions agents need from you. A session lasts from when you join until you
leave, so an operator restart or a sleeping GPT-Live connection mid-call doesn't reset it.

These don't count as your words: mail between agents (including Loom's own "✉️ Mail
from" turn, and the opening task of a thread another agent started through the desk), a
request posted by an intake form.

**Knocks.** Voice never reads unprompted news aloud. It knocks: "Malibu has something for
you." (a space name for work: "Notifications has something for you."). Several waiting items
make one knock, and the content waits until you ask ("what does Malibu have?") or the
catch-up. A knock comes only at a real break: no request of yours is waiting on an answer,
you haven't just heard one, you aren't mid-conversation with a personal agent (food,
health, a workout: ten minutes from the last thing you sent), nothing is queued to be said,
and you've been quiet for 20 seconds. An answer you're waiting for always goes first.

Snoozed or parked spaces never knock or speak until they wake, and tapped decision answers
don't count as something you said to a thread. Anything voice does say about work leaves out
ticket ids, PR numbers, decision or rule ids and CI step names: one plain sentence about
what changed.

The urgent lane is set with `TANGO_OPERATOR_URGENT`, a comma-separated list:

- `deadline`: knock for a your-move item whose deadline is within 30 minutes (or up to six
  hours past);
- `scene`: speak another agent's screen when it marks it urgent.

Pause and draft mode hold the urgent lane too.

### The desk by voice

With the screen service connected (`screen_url`), voice acts on the Agent Desk through the
same commands its buttons send. A thread is the one you name, else the one open on screen,
else the one just discussed; a name that fits two threads gets a question, never a guess.

- **One thread:** "mark it done", "snooze the bug bounty thread until tomorrow", "park
  it", "pick that back up", "mark it unread", "reopen it", "pin this" / "unpin it",
  "rename this to Shed vents", "move this to the Bike project" (or "out of its
  project"), "stop that" (interrupts the turn running now; the thread stays open), "where does the headlight
  thread stand?" (reads its card; a project's name reads its lead's), and "move this to
  the acme account" (Loom threads only, and only to an account you name).
- **Undo:** "undo that" reverses the last change voice made on the desk, within ten
  minutes: the desk's own undo where it keeps one, else the opposite change (unpin, the
  old title, the old project).
- **Search:** "find the thread about the reconnect bug" reads the top three matches,
  done and archived ones too; "open the second one" (or "reopen the first one") right
  after acts on that match. An archived one can only be read.
- **Capacity:** "how's capacity?" says the tightest Claude account (its five-hour and
  weekly room), the week left on average, which accounts are resting after a limit,
  what's running, and a warning when the disk is low. "Show capacity" opens the page.
- **Projects:** "snooze the board game project until Monday", "park Bike", "wake up
  Bike", "finish the board game project". Finish asks first ("Finish Board game? That
  marks its 4 open threads done.") and goes only on a yes.
- **Catch me up:** "catch me up" opens Catch me up on the screens and reads one moment at
  a time: the space, what kind of moment it is, its title, and for a decision its options
  and the one voice would pick. Then: "next" (marks it heard; a decision still waiting
  stays in Needs you), "skip", "go with A" (or "go with your pick"), "that's fine" (Fine
  by me on something decided for you), "got it", "accept" or "accept Bike" (the
  chapter's Accept), "skip this project" (Defer), "what's left?" (each space, what needs
  you and what's open), "go to Bike", and "that's enough". The screens follow and
  never mark anything themselves. On a desk without the update ledger it reads the older
  briefing instead.
- **Places:** "go to the inbox", "show me Watching", "open the Tango Voice project",
  "show me the workers" (a page's own view), "open Watson's page", "go back".

Voice doesn't create projects, start workers, or act on many threads at once; Settings,
routing and filters stay on the screen.

### Draft mode: think out loud, send once

GPT-Live decides on its own when you've finished a turn, and on a long pause it hands
off whatever you've said so far. For a longer message, or when you're still working
something out, switch to draft mode: the operator collects the whole thought and
nothing goes to an agent until you've confirmed it.

- **Start it** by saying so in your own words: "draft mode", "let me think out loud",
  "let me talk this through", "I've got a long message for Sierra", "hang on, I'm
  working this out", "I want to dictate a note", "could you draft a longer message for
  …", "help me draft a reply to Victor", "draft something for Sierra". The router also
  recognizes other ways of saying it. Name who it's for if you know: an agent ("…for
  Sierra") or a conversation on the desk, Discord or Loom ("…for the shed vents thread",
  "…for the Lantern Row Loom thread"). Anything you say after that becomes the start
  of the draft.
- **Or just pick a conversation.** "Let's talk about news-letter promotion", "okay, hood
  vents", "pull up the speaker thread", "open X", "let's work on X", "let's do X" open that
  desk conversation (its latest screen when that is the newest thing in it, else the
  conversation) and start an empty draft for it. Tapping a card on the desk while the
  voice operator is live does the same, silently. Names match loosely: case, punctuation,
  hyphens and plurals don't matter, and the words can come from the title, the place or
  what the conversation is about ("news letter" finds "News-Letter Promotion Strategies").
  When two conversations match equally the operator asks once: "The Speaker install one or
  the Speaker wiring one?". Anything the quick match can't read goes to the router.
- **While drafting** every word you say is added to the draft, in order, however long
  you pause. The operator only backchannels ("mm-hm", "take your time") and asks
  nothing; each time GPT-Live hands off while you draft it is reminded that nothing has
  been sent. Agent updates that come in meanwhile are held, with no exceptions; once
  the draft is sent or cancelled the operator says "N updates came in while you were
  drafting" and goes through them. A few things still work as commands: "show the board", "it's for
  Victor", "keep holding", "cancel the draft". "Scratch that" in the middle is treated as
  you correcting yourself, and it's cleaned up when the draft is compiled. After about
  90 seconds of silence it asks once: "Want me to keep holding this, or send it?" (not
  for a draft for a conversation you picked). Anything you say to the operator by name
  ("Yankee, what did Sierra say?") is answered and never added to the draft.
- **Leave or switch.** "Back to the board" (or tapping the board) parks a draft for a
  conversation with that conversation and shows the board; reopening it by voice or tap
  picks the words back up. Picking another conversation mid-draft parks this one and
  starts that one. "Never mind" throws the draft away and shows the board. A draft armed
  by a tap holds no agent updates until you start talking.
- **Finish** with "okay, send it", "that's it", "go ahead", "done, send that to
  Sierra". One model call turns the fragments into one clean message (every point
  kept, fillers and restarts removed, nothing added) and decides exactly where it
  goes: the agent and the place (an existing thread or desk conversation, the agent's
  main channel, or a new thread with a proposed title). If that's unclear (who it's
  for, which of two threads, a contradiction, a missing detail) it asks first ("Sierra's
  shed vents thread, or a new one?").
- **No question when you said where.** When you named where it goes before finishing (a
  conversation you picked or tapped, or an agent) and the compile agrees and asks nothing,
  "I'm done" sends without asking: the card shows the compiled message as "Sending…" for
  five seconds (`undoUntil`), and "undo", "wait" or the card's Cancel stops it and puts
  you back to dictating with every word kept. Then the operator says only "Sent." and the
  board comes back.
- **Confirm** (where it goes was unclear, or the compile moved it). The Draft card on the desk shows the message and "To: Sierra · Shed vents
  thread"; the operator asks only "Send that to Sierra in the shed vents thread?" (with
  no screen connected it reads the message back first). "Yes" sends it through the
  normal path, so the board, tracing and answer relays work as usual. "No, to Victor",
  "put it in the speaker thread", "start a new thread", "also add the gate code" change
  it and ask again. "Wait, one more thing" goes back to collecting. "Scratch that",
  "never mind" or "cancel" throws it away. Only a plain yes sends: "yes to Victor" or "yes,
  after lunch" is treated as a change. The card's **Send** and **Cancel** buttons do the
  same as saying it. Once it is on its way the card says "Sending…" and can't be
  cancelled. If the send isn't accepted (the thread can't be found or started, a desk reply
  fails) the draft is kept, back at the confirm step with a "Not sent: …" note, so you
  can say yes again or send it somewhere else.
- **Where a new thread starts.** "Start a new thread to …" with no agent or repo named
  starts where the screen is, like the desk's + button: with a thread open, the same
  agent or repo and project as that thread; on a project page, that project and its
  repo (the repo of its latest coding thread); on an agent's page, a thread with that
  agent. The confirm says the place ("Send that to a new thread in tango, under
  Tango Voice?"). In the Inbox with nothing named it asks one short question with a
  guess ("In tango, or with Watson?"). Coding threads start through Start work with the
  project's `projectId`; agent threads through `POST /api/desk/agent-threads`, never
  straight in Discord.
- **Unclear means a question.** When it isn't clear who or which thread should take
  something, the operator asks instead of sending it to the chief of staff. A space's
  name alone ("tell Tango Voice to …") doesn't mean its lead: with several threads in
  that space it asks which one. Name the thread ("the Tango Voice lead", "the regression
  sweep") and it goes there.
- A draft survives the voice connection dropping and reconnecting. If the session ends
  with a draft unsent, the operator says so if it still can, and the card keeps the text
  (marked "Not sent") for ten minutes or until you dismiss it. The text is also in the
  session trace (`draft.unsent`).

**Safety net (outside draft mode).** When a normal request sounds unfinished (it ends on
"and", "um", a comma, or is a fragment like "so, for Sierra"), or the router thinks you
were cut off, the operator asks "Is that everything?" instead of sending. "Yes" sends it;
saying more adds to it and then sends the whole thing; "never mind" drops it. Complete
short requests ("tell Malibu I had eggs") always go straight through.

Every step is in the session trace: `draft.start`, `draft.pick`, `draft.pick.tie`,
`draft.arm`, `draft.append`, `draft.aside`, `draft.target`, `draft.check`, `draft.compile`,
`draft.clarify`, `draft.confirm` (with the resolved destination), `draft.ready` (sending
after the undo window), `draft.undo`, `draft.park`, `draft.edit`, `draft.redirect`,
`draft.send`, `draft.cancel`, `draft.resume`
(after a reconnect), `draft.unsent`, and `safety.hold` / `safety.release` /
`safety.extend` / `safety.dropped` / `safety.expired`.

### Pause mode: talking to someone in the room

When someone walks in and you start talking to them, pause the operator. It holds every
agent message and stays completely silent until you say you're back.

- **Pause** by saying the operator's name, "Yankee", first, then the command: "Yankee,
  pause", "Yankee, pause messages", "Yankee, hold my messages", "Yankee, hold on",
  "Yankee, give me a minute", "Yankee, one sec", "Yankee, go quiet", "Yankee, mute". A
  greeting before the wake word is fine ("Hey Yankee, pause", "Okay Yankee, hold my
  messages"). It works in any state, in the middle of a draft too.
- **Resume** the same way: "Yankee, resume", "Yankee, I'm back", "Yankee, unpause",
  "Yankee, what did I miss", "Yankee, play my messages", "Yankee, continue", "Yankee, you
  can talk again". Or tap the pill on the desk.

The wake word must lead the sentence, so conversation in the room doesn't trigger it:
"pause the movie", "I'm back from the store", "hold on a second", "I told Yankee to pause"
and "Yankee, pause the movie" all do nothing. Matching is deterministic on your own
transcript; the router model is never asked. "Yankee" and the spellings speech recognition
gives it ("Yankee's", "Yankees", "Yanky") count as the wake word, and so does the old name,
"Tango" (accents ignored, so "Tangó" works, and "Tango's"). Looser misspellings such as
"tangle" are deliberately not accepted: a missed resume costs you a repeat or a tap, but a
false pause in the middle of a conversation would hide your messages.

**While paused.** The operator says one word ("Paused.") and then nothing. Whatever it was
saying stops at once (the rest of that reply is dropped, never played), its audio is cut off
after the confirmation, every delegation is ignored, and nothing you or anyone in
the room says is sent to an agent, added to a draft, or shown as a caption (the trace keeps
only how many words were heard, never the words). Agent results, relays, notices, failures
and deadline reminders all wait in the queue; nothing breaks through. The desk and phone
show a **Paused · N waiting** pill (N = updates waiting to be said; after 30 minutes it
reads **Still paused**). Tapping it resumes. The board itself keeps working.

**On resume** the operator says "You've got 3 updates." (or "Nothing came in."), then plays
them one at a time, the ones waiting on you (questions, failures, deadlines) first. With more
than four it starts with a one-sentence catch-up: "You've got 6 updates. Sierra and Malibu
got back to you, and a coding thread has a question." A draft that was open when you paused is still
open, and collecting again. Pause and draft mode share one hold on agent updates: resuming
while a draft is still open says only "Back.", and the updates wait for the draft to close
("N updates came in while you were drafting").

**Lifetime.** A pause survives the voice connection dropping and reconnecting. The voice
model stays awake for up to an hour while paused, then may go to sleep, still paused: your
next words wake it, and only the resume command ends the pause. If the session ends while
paused, the held updates are not lost; they are on the desk, still marked New, and the trace
says so (`pause.ended`).

Trace: `pause.start`, `pause.ignored`, `pause.queued`, `pause.suppressed` (a note for the
voice model held back), `pause.carried` (after a reconnect), `pause.still`, `pause.resume`,
`pause.digest`, `pause.screen.stale` (a tap on an old pill), `pause.ended`.

### Speech that wasn't for the operator: "For me?"

You won't always remember to pause. Two guards catch speech that wasn't meant for the
operator, without a wake word:

- **"For me?"** The router judges whether each request was addressed to the operator: yes,
  no, or unsure. No does nothing and says nothing. Unsure holds the work and the operator
  asks only "For me?". A yes ("yes", "yeah", "mm-hmm", "go ahead") does it. A no, silence for
  20 seconds, or anything else drops it (anything else is then routed as new speech). Saying
  "Yankee" or an agent's name anywhere in the request is always a yes. The router also sees
  how long you had been quiet (across sleeps and reconnects): in the middle of an exchange
  it leans yes, and after two minutes or more of quiet it leans unsure unless the request is
  plain. Short commands that skip the router ("mark it done", an approval) ask "For me?"
  too after two minutes of quiet when they would change something; reading, opening and
  moving the screen never ask. A question still waiting when the voice connection drops
  carries over, except a reply or a read-back, which point at the old connection's tasks and
  updates and are dropped.
- **Filler.** An utterance that is only filler ("mm", "uh", a sniff, a cough, a click)
  never draws a reply. Its audio is dropped until you say real words or the backend gives
  the voice model something to say. A murmur while the operator is talking, or while an
  update is queued, never cuts that off.

Switch "For me?" off with `TANGO_OPERATOR_FOR_ME=off` in the operator's environment. Trace:
`forme.ask`, `forme.yes`, `forme.no`, `forme.other`, `forme.expired`, `forme.skip`, `forme.dropped`; the
session log has `filler.gate` lines.

To measure it, `scripts/voice-operator/review-addressee.mjs` rebuilds every utterance from
the session logs and has a blind judge label who each was meant for, and
`review-addressee-report.mjs` writes the report. `apps/tango-voice/src/testing/replay-addressee.ts`
replays the router's judgment on those labels.

### Keep it running (macOS)

```bash
node scripts/voice-operator/install-launchagent.mjs --operator alex
```

This installs a LaunchAgent (`com.tango.voice-operator.alex`) that starts at login
and restarts on failure. It defaults to `./.env` and `./apps/tango-voice/.env`;
pass `--env-file` (repeatable) to choose others. Add `--dry-run` to print the
plist and command without installing. On other systems, run the printed command
under your process manager.

Logs go to `~/Library/Logs/tango-voice-operator-<id>.log`, with a JSONL file per
session under `<state_dir>/logs`.

## Diagnosing a live session

With a `screen_url` and the Agent Desk on (`SCREEN_DESK=v2`), every part of a voice
session writes to one timeline, the session trace, kept for three days:

| Source | What it records |
| --- | --- |
| `operator` | what you said (final lines), each delegation and whether it was merged or dropped as a re-fire (with the reason), the routing result (actions, deterministic or model, how long), every view decision and why the view did or didn't change (pinned, no scene, already showing, already on the board), speech queued / released / delivered / requeued, `heard` sent, session start / end / reconnect |
| `hub` | every view change (from → to, who asked, why, manual or not) and every refusal (ignored, queued, error, with the reason), scenes staged / replaced / expired, screen taps and their acknowledgment or fallback |
| `desk` | attention changes (seen, done, snoozed… with before → after), next-step changes and their basis, command outcomes including failures, source poll errors (at most one a minute each) |
| `screen` | what each browser actually rendered and when (board, conversation, scene and version), the toasts it showed, reconnects |
| `owner` | your own marks |

**Watch it live.** Open `/trace` on the screen service (through the tailnet path if
you use one, e.g. `<screen url>/trace`). Newest entries are at the bottom and it
follows along as they arrive. Click a row for its full JSON. Filter with the source
and kind chips; pick the last 10 minutes, the last hour, or the current voice session.

**Mark the moment.** When something looks wrong mid-session ("the screen didn't go
back to the board"), type a few words in the box and press **Mark this moment**. The
mark lands in the timeline at that instant, so the entries around it are the ones to
read.

**Name your screens.** Open the desk as `<screen url>/?name=kitchen` (any name) so its
render entries say which screen showed what. Unnamed screens are labeled `desk` or
`phone` plus their connection id.

**From a terminal or an agent.** The CLI prints the same timeline, one line per entry,
ready to paste into a diagnosis:

```bash
npx tsx apps/screen/scripts/desk-trace.ts --since 15m
npx tsx apps/screen/scripts/desk-trace.ts --session --sources operator,hub,owner
npx tsx apps/screen/scripts/desk-trace.ts --since 14:00 --kinds view,presentation,render --data
```

Options: `--url` (default `$DESK_TRACE_URL`, else `http://127.0.0.1:9410`), `--since`
and `--until` (`15m`, `2h`, a clock time like `14:00`, epoch ms or an ISO time), `--session` (since the latest voice
session started), `--sources`, `--kinds` (a kind or its family: `presentation` matches
`presentation.changed`, `presentation.ignored`, …), `--limit`, `--data` (add each entry's
data), `--json`.

The HTTP API behind both: `GET /api/desk/trace?since=&until=&limit=&kinds=&sources=&session=latest`.
`POST /api/desk/trace` takes one entry or a batch; local processes (the operator) may
write any source, browsers only `screen` and `owner`.

## Troubleshooting

- **The bot doesn't join.** Check the service log for `ready … watching #<channel>`.
  Only owners trigger it. If the log says the bot is in another voice channel, it is
  waiting for the bot to leave it (another operator may be using it).
- **No reply after "sending that to…".** Check the bot is running and that
  `TANGO_VOICE_BRIDGE_API_KEY` matches the bot's. The service log shows `voice turn HTTP 401` on a mismatch.
- **"No voice operator config".** The file isn't in the profile the process resolved.
  Set `TANGO_PROFILE` or `TANGO_VOICE_OPERATOR_CONFIG`.
- **Subscription route fails to start.** Run `codex login` again; the token in
  `~/.codex/auth.json` may have expired.
