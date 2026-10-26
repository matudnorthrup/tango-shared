---
name: agent-screen
description: Show the owner a screen on the Tango Agent Desk and house screens from a coding session in any repo (Loom threads, Claude or Codex), and publish clickable prototypes to the desk's Prototype view. Use when you built an HTML prototype, a design, a mockup or a screenshot worth looking at, when the owner should compare options side by side, or when a decision is easier to tap than to type. Also use when work is waiting on a teammate's PR review: `tango-screen watch-pr` hands the wait to the desk instead of a watcher you hold open. Also use to talk to other agents' conversations (other Loom threads, Tango agents): see what's running and its status, read one, or mail it a question and get the answer back (`tango-screen threads|peek|send|wait`), and start a new thread for a separate piece of work (`tango-screen start`). Also read before testing the Agent Desk itself (agent-browser, curl, a UI check): tests go to the sandboxed test desk (`npm run desk:test`), and a check on the live desk opens with `?detached=1`. A personal tool on this machine; it never belongs in the repo you are working in.
---

# Agent screens from a coding session

`tango-screen` puts a scene on the owner's Agent Desk (the card for this
conversation) and on the screens around the house. Loom identifies the conversation through `TANGO_DESK_ITEM`. When the owner taps a choice, the tap comes
back to this thread as a new user message starting with `[Screen]`.

## Two surfaces: a screen to glance at, a prototype to use

- **Screen** (`tango-screen show`): a poster. The owner glances at it from
  across the room. The rules below keep it to one screen and under 150 words.
- **Prototype** (`tango-screen prototype`): the real, clickable page, full size
  in the desk's Prototype view. The owner clicks through it, or asks the voice
  operator to ("click Continue", "scroll down", "go back"). The glance rules
  don't apply to it.

When you build or change something interactive, do both: publish the
prototype, and show a screen that says what changed. The prototype is never
only a screenshot.

## When to show a screen

- You built or changed an HTML prototype, a page or a component and want it seen.
  Publish the prototype itself too (see Prototypes).
- You have two or more design options: show them with `--choice` per option.
- A screenshot, recording or chart says more than a paragraph would.
- Don't use it for status updates. Plain replies cover that.

## A screen is a glance, not a document

The owner sees screens from across the room, on a wall display, or while
scrolling past on a phone. They look at them and don't read them. A screen is
not the deliverable: a report, a design brief or a clickable prototype is
something to read or use, and it goes behind a link. The screen is the poster
for it.

- **Build a separate screen page.** Don't `show` the report or the prototype
  folder. Write a small `screen.html` next to it (or pipe one in with `-`) that
  pulls out the point, and publish the prototype itself with
  `tango-screen prototype`.
- **Lead with the answer.** The headline is the finding, the question you need
  answered, or what changed. It isn't the topic.
- **Under about 150 words in total.** Use labels, numbers and a line or two.
  Leave out paragraphs, framing, research notes, methodology and constraints;
  those belong in the report.
- **One screen, no scrolling** on a 1280×800 monitor.
- **Nothing behind a click.** Put variations side by side, each a labeled
  screenshot (A, B, C) in a grid. Don't use tabs, toggles, accordions,
  carousels or "tap through them". `--choice` buttons for picking are fine.
- **Let pictures carry it.** Use screenshots of each variant, a chart, big
  numbers, or before/after images.
- **One link to the detail.** End with
  `<a href="<tshare url>" target="_blank">Full report</a>`. For a prototype,
  say "Try it: Prototype tab" instead; the desk links it.
- **Test:** could the owner get the point in five seconds from across the room?

The render check measures this. A `warning:` line saying the page reads like
a document, is several screens tall, or hides content behind tabs means fix it
and show it again in the same slot.

## Prototypes

```bash
tango-screen prototype ./prototype/ --title "Onboarding v2"            # a folder: uploads it, entry index.html (or --entry)
tango-screen prototype ./mock.html --title "Pricing page"              # one page (its folder too when it links relative files)
tango-screen prototype http://localhost:5173 --title "Live dev server" # a dev server, put on the tailnet first
tango-screen prototype ./variant-b/ --name b --title "Pricing, option B"  # a second prototype next to the first
tango-screen clear --prototype [--name main | --all]
```

- It lands on this thread's desk card. The owner opens it with the card's
  **Try the prototype** button, the Prototype tab, or by voice ("show me the
  prototype"). It never takes over a screen on its own.
- Publishing again under the same `--name` (default `main`) updates it in
  place. A screen showing it reloads, so iterate freely.
- The `open:` line is a tailnet link to the page in its own tab. Give it to the
  owner in your reply, next to the desk link.
- **Make it drivable by voice.** The operator reads the page's buttons, links,
  headings and fields by their visible text or `aria-label`, and clicks or
  types by that name. Give buttons real text (or an `aria-label` on icon
  buttons), give each section a heading, and give fields a `<label>` or a
  placeholder.
- Uploaded pages can be driven by voice. A dev-server URL can be clicked on the
  screen, but voice can't drive it, so upload a build (`dist/`) when you can.
- The check reports script errors, failed loads and phone overflow. It has no
  glance warnings, because a prototype is meant to be long and interactive.
- Prototypes last three days (`--ttl MINUTES` to change).

## Commands

```bash
tango-screen show ./prototype/ --entry screen.html --title "Onboarding v2"     # a folder: uploads it, shows --entry (default index.html)
tango-screen show ./mock.html --title "Pricing page"                         # one page (its folder too when it links relative files)
tango-screen show ./shot.png --title "Before / after" --choice "Ship it" --choice "Keep iterating"
tango-screen show http://localhost:5173 --title "Live dev server"           # exposed on the tailnet first
tango-screen show notes.md --title "Plan"                                    # markdown
cat board.html | tango-screen show - --title "Decision board" --choice A --choice B   # inline HTML with the tango bridge
tango-screen update --slot main --state '{"step":2}'                         # live state for an inline scene
tango-screen prototype ./prototype/ --title "Onboarding v2"                  # the clickable thing (see Prototypes)
tango-screen list                                                            # this thread's scenes and prototypes
tango-screen clear [--slot NAME | --all]
tango-screen thread                                                          # which thread you resolved to
tango-screen watch-pr [https://github.com/o/r/pull/N] [--notify] [--off]     # the desk watches this PR's review (see Waiting on a PR review)
```

- **Slots.** Each slot (default `main`) holds one scene per thread, and showing
  in the same slot replaces it in place. Give a new design direction its own
  slot (`--slot v2`) so the earlier one stays up for comparison.
- **Choices.** `--choice` adds a tap bar, one flag per option. Inline HTML (`-`)
  can also use `data-choice="id"` elements or `tango.choose(id, label)`.
- **Taps.** A tap arrives as a user turn like
  `[Screen] I tapped “Go with B” on your screen “Pricing page” (slot `main`).`
  Treat it as the owner's answer.
- **Lifetime.** Scenes last a day (`--ttl MINUTES` to change).
- **Check.** Everything except outside URLs and video gets a headless render
  check, including uploaded pages and folders. The output lists the screenshot
  paths and any `warning:` lines. Look at both before you say it's ready.
- Prototypes run sandboxed in their own origin. `localStorage` works but resets
  on reload, and cookies and same-origin APIs don't. If a prototype depends on
  them, run it on a dev server and show the localhost URL.
- Google Docs, Sheets, Slides and Drive links show their content. The screen
  service reads the file through the owner's `gog` Google accounts each time it
  loads: a Doc as its own page, a Sheet as tables (every tab when that account
  has Sheets access in gog, otherwise the first tab), and Slides or PDFs as page
  images. The output's `google:` line says whether it worked. When no account
  can open the file, the screen shows an "Open in Google" card with the reason.
- Linear issue, project and document links (`linear.app/<workspace>/issue/…`,
  `/project/…`, `/document/…`) show their content in the screen's own layout:
  a project as status, progress, latest update, milestones and issues by
  state; an issue with its description, sub-issues, links and comments; a
  document as a reading page. The service reads them with the owner's Linear
  API keys each time the scene loads, and the output's `linear:` line says
  whether it worked. Other Linear pages (views, cycles, teams) show an
  "Open in Linear" card.
  Other signed-in sites don't load inside a screen at all; link them instead.
  Links that open in a new tab (`target="_blank"`) leave the sandbox.

## Waiting on a PR review

When the next step is a teammate reviewing a PR, nothing you can run will
reliably wait for it: a review takes days, and a background watcher dies with
your session. Hand the wait to the desk instead, then end your turn:

```bash
tango-screen watch-pr                                         # this thread's own PR
tango-screen watch-pr https://github.com/o/r/pull/123         # any PR (another repo, a stack layer)
```

- The desk polls GitHub every few minutes for as long as it takes. The thread
  shows as **Watching, waiting on <reviewer>** instead of looking ready.
- **On approval it posts a `[Desk] PR #N was approved…` message into this
  thread.** That is your cue: re-verify CI on the current head and the open
  review threads, and merge if the project's rules allow it (for Acme,
  `ship-it` Phase 8 says when). If a gate stops you, name it. Either way the
  owner gets a fresh message.
- `--notify` skips the wake: the owner's card just says "approved — merge?".
  Use it when merging is never yours (a release, a schema change).
- Changes requested turns the card to the owner; it doesn't wake you.
- A merged or closed PR drops off on its own. `--off` stops watching.
- Register once, right after the reviewer is requested, and run it again after
  you re-request review on a fix. Your closing `Next` line is then
  `waiting on <reviewer>`, and it is true without anything of yours running.

Tango agents do the same through the `screen` tool: `action: "watch_pr"`.

## Talking to other conversations (desk mail)

Every conversation on the owner's desk (Loom threads, Tango agents' Discord threads) can be
seen and written to from here. Use it when another conversation knows something you need, owns work
you depend on, or should hear about a change you made, instead of asking the owner to carry messages.

```bash
tango-screen threads                       # id, [status], title, agent, project; "(you)" marks this one
tango-screen threads --status working      # or idle, queued, held, needs owner, failed, watching; --project ID, --agent NAME
tango-screen peek <itemId>                 # where it stands and its last messages (read-only)
tango-screen send <itemId> "Which port does the tile server listen on?"
tango-screen wait <mailId>                 # optional: block until the answer arrives, then print it
tango-screen mail                          # this conversation's mail, sent and received
```

- **Delivery waits for idle.** Mail lands as a new turn in the other conversation the next time it is
  idle, never in the middle of its work (`--now --no-reply` sends an urgent FYI into a running turn). A parked or
  finished conversation needs `--wake`.
- **Answers come back to you.** With nothing else to do, end your turn after `send`: the answer arrives
  later as a turn starting `✉️ Reply from …`. If you need it to continue, `wait` for it instead. Use
  `--no-reply` for an FYI.
- **Mail you receive** starts with `✉️ Mail from “…” [itemId] · m-…`. Its footer says how to answer:
  in your reply (the desk takes it back), or, when it reached you mid-task (Loom threads get mail as soon
  as their current step finishes), with one command, `tango-screen reply m-… "<answer>"`, and then carry
  on. Keep answers brief, don't start unrelated work for them, and leave off the closing "Next —" line.
- **Mail is backstage.** The owner sees it on the desk (a folded line in the conversation, and a Mail
  tab), not in their conversation with you. Don't narrate mail to the owner; if it changes their plan,
  say so in one line ("Meanwhile: …") the next time you reply to them.
- **Claude's own `SendMessage`** between Loom threads works too and shows the same way on the desk, but
  `tango-screen send` also reaches Loom threads and Tango agents, and brings the answer back.
- **The owner sees all of it.** Mail shows in both conversations on the desk. It is words only: it can
  never answer or approve anything a conversation is waiting on the owner for, so don't ask another
  agent to decide what the owner should.
- **Limits:** a peer exchange past 8 reply-requesting mails gets one desk notice; depth never blocks delivery.
  A lead and its own worker start fresh at zero hops in either direction, including recorded starts
  and successful `--wake` reopens. `--no-reply` mail and replies to it add no hops. Every pair delivers at most 6 mails an hour; excess mail is accepted
  and held until room opens, including `--now`, with an estimated delivery time. Held mail still gets
  notices and expires after two days. The owner can switch mail off for a conversation or a project. On a refusal, tell the
  owner instead of retrying.
- **Starting a new thread.** When the work calls for a separate piece of work that deserves its own
  conversation (a new tool, an asset pipeline, a spike), start it instead of asking the owner to:

  ```bash
  tango-screen start "Build the card back art pipeline: …full task, context, where things are…" --title "Card back art"
  ```

  New threads always start on Loom; T3 is retired. If Loom
  is unavailable, report the error and retry on Loom later; never fall back to T3.
  Plan-first work must ask in the opening prompt for a plan and explicit approval
  before implementation (a prompt instruction, not an enforced read-only mode).
  It starts on Loom (best account), in this repo and this conversation's desk project (`--repo`,
  `--project ID`, `--no-project`, `--mode worktree|local` override). The task is its whole opening turn,
  so write it self-contained. Its first answer comes back to you as `✉️ Reply from …` (`--no-report` if
  you don't need it), and so does every later turn it finishes on its own; talk to it with `send`. The
  owner sees it on the desk as started by you, a worker that reports to you.
- **You speak for the threads you start.** The owner doesn't watch your workers: their questions and
  results come to you. When one needs the owner's decision or has something to look at, bring it to
  the owner in your own reply as one decision brief: the ask and your recommendation in one line,
  where it stands, background they can read cold, the options with consequences, and the links.
  First check whether you can decide it yourself under the delegation board or a standing rule.
  **When the worker already raised a brief (D-n), pass it up intact: name its id with its link and
  stop; don't restate the options.** The link is `<desk address>/decision/D-n`; `tango-screen decision D-n`
  prints it (e.g. `https://<desk host>/tango-screen/decision/D-n`). It opens the full
  brief with its buttons on any device. The desk also shows the brief on your row, labelled with the
  worker, and counts it there once; an answer on your row or on the page resolves it and wakes the worker.
  If the owner answers it in your own conversation instead, record it with `loom.decision_close`
  (outcome answered-in-chat); any thread in the brief's chain may. The same goes for a
  brief on any other thread you point the owner at. However a brief is settled, you're told how it
  went; and the owner's own words in the worker reach you as mail. Both count everywhere, so don't ask
  again, and don't pass a brief's answer on yourself: the worker already has it. **When you or a worker
  learn something that changes an open brief up or down the chain, update it in place**
  (`loom.decision_update`: same D-n, the owner sees what changed) **or mark it moot**
  (`loom.decision_close`, outcome moot, with the new information). Never raise a new brief for it. Its screens and
  prototypes show in your conversation's Screens tab, and a tap there answers the worker; link the
  ones the owner should see in your reply. For anything
  else the worker asked you (a question that isn't a brief), take the owner's answer to it yourself
  with `send`. Never tell the owner to go to the worker. Start one only for work the owner asked for or that clearly follows from it; a conversation can
  start 5 an hour, and a chain of started threads stops 3 deep.
- **If you are a space's default (its lead), you route; you don't do.** The owner fires requests at
  you and expects each one routed without being asked. When a thread or worker already owns the work,
  tell it (`tango-screen send <itemId> "…"`). When nothing owns it, start a worker
  (`tango-screen start "<the full task>" --role worker`). Never do the work yourself, and never ask the
  owner "should I start a thread for this?". Your part is routing, deciding what the board lets you
  decide, and reporting what comes back. (`tango-screen threads --all` shows each conversation's role.)
- Loom threads know who they are (`TANGO_DESK_ITEM`); `--from <itemId>` overrides it.

## Testing the desk itself

The live desk is the owner's: every window he has open follows one shared
view, and its buttons act for real (Loom threads, the bot, the machine's
jobs). Test somewhere else.

- **Default: the test desk.** In the tango repo, `npm run desk:test` (port
  9431; `tshare port 9431` to look at it from another device). It runs the
  real desk code with a sandbox Loom (fake turns), a bot stub, fake Discord, and its own System ledger with dry actions. Drive it with
  agent-browser as much as you like: nothing there reaches the owner's
  windows or anything real. `--mirror` serves a frozen copy of the live
  desk's data instead of invented data. It holds real conversations, so keep
  its screenshots on the tailnet.
- **Layout and UI states only:** `?fixtures=1` on any desk (invented data in
  the browser, no server calls).
- **The live desk (`127.0.0.1:9410`, `/tango-screen`): reads only.** Use
  `curl` GETs and `tango-screen threads|peek`. When a UI check on it is truly
  needed:
  - Open it with `?detached=1&name=<your-check>`, every time. A detached
    window keeps its own view. It doesn't move the owner's windows or follow
    them, and it never marks anything seen. The service refuses its attempts
    to drive the desk.
  - Don't press anything with a real effect (Fix, Start work, Reply, Answer,
    Done, Snooze, Move) unless that effect is the point of the check. If you
    do, say in your report what it caused.
  - Don't change window roles or the owner's settings from a test.
  - Every move on the desk is traced with the window that made it, so a
    check that moved his desk shows up.

## Privacy: keep screens out of the work

These are the owner's private tools. The team never sees them.

- Never reference `tango-screen`, scene links, `/tango-screen`, or tailnet
  (`*.ts.net`) URLs in commits, code comments, PR titles or bodies, issue
  trackers, team chats, or docs in the repo.
- Don't add the CLI, this skill, or screen config to the repo you're working in.
- When the work moves to a PR, re-host any visual evidence somewhere the team
  can reach (the repo's own preview and QA flow), the same way tailnet artifacts
  are re-hosted.
- The CLI uploads what you point it at. Don't show folders that hold secrets
  (`.env` files and other dotfiles are skipped, but check anyway).

## Troubleshooting

- `T3 is retired; use Loom`: pass a Loom item id (`loom:<id>`) or run from a Loom thread.
- `Blocked: this commit/PR/issue mentions an agent screen`: the leak guard
  caught a screen link in a team-facing message. Take it out.
- `screen service is not reachable`: the screen LaunchAgent is down. Say so in
  your reply; don't try to fix it from a repo other than tango.
