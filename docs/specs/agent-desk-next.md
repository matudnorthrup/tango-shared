# Agent Desk: the next layout

The Desk's navigation and page layout, redesigned after three rounds of clickable prototypes (October 2026). It replaced the classic layout (the List, the Conversation, Screen and Prototype views, the top nav) on October 17, 2026; `?ui=` and Settings → Layout are gone. This file records the decisions; [agent-desk.md](agent-desk.md) still describes the data, server and behaviour.

## Principles

1. **Calm.** Priority comes from good views and sorting, not from dashboards of cards.
2. **Breadcrumbs everywhere.** Every page shows where you are and how you got there.
3. **The list gets its own room.** One centered, readable column, never squeezed beside a thread.
4. **Projects and agents are places.** Inbox lists hold threads only. A project or an agent is a page you go to.
5. **Status owns color.** A row or header carries at most one colored fact: the status. A project, agent or repo shows who it is through its tile.
6. **One row everywhere.** A thread row has the same shape in every list and grouping.
7. **No runtime plumbing.** "Loom", "Tango" and session ids stay out of rows and headers. Runtime details live in a thread's Details.
8. **Time is always shown.**
9. **Taps never wait.** Every tap or click shows its effect at once. A failure is a toast with Retry, never a countdown or a spinner to sit through. Only voice gets an undo window. See "Optimistic by default" in [agent-desk.md](agent-desk.md).

## Layout

```
┌──────────┬────────────────────────────────────────────────┐
│ ⌕ Search │ Projects › Desk reliability › Operator recon…  │  breadcrumb bar
│ INBOX    ├────────────────────────────────────────────────┤
│  Needs 7 │        Operator reconnect double-send  ⋯  ▣   │  page header
│  Working │        [Your move] [Building ▾]               │
│ PROJECTS │        Desk reliability · Victor · 4m · Feat   │
│ AGENTS   │              the list / the thread             │  center column
│ ⚙ You    │                                          (+)   │  floating + (no text)
└──────────┴────────────────────────────────────────────────┘
```

- **Left sidebar (primary navigation)** runs the full height of the window:
  - a search field that opens the switcher
  - **INBOX:** the views with counts (Needs you, Ready, To-dos, Working, Watching, Snoozed, Parked, History). To-dos holds what the agents handed the owner to do in the world, and asks past their date; it is never in the yellow count.
  - **Counts** say one thing on every row (Inbox views, projects and agents): what needs the owner in bold yellow text: an ask of theirs they haven't read, an open request (read or not), or a failure they haven't seen; never a finished update, which is only bold while unread (owner, 10/18). Ready (their turn, already read) is left out of it, a thin bar, then the active threads in grey: "**2** | 4". All of it waiting is just the yellow number, none of it just the grey one, nothing active no number. No pills: the last number sits on the right edge, so the numbers line up down the sidebar. An Inbox view's grey number is every thread in it, so Snoozed and Parked say how many they hold. A view of only done threads (History) has no count. A project's and an agent's counts are from their own threads, not from an Inbox view.
  - Hovering a row (a long-press on a touch screen) shows its breakdown: needs you, failed, ready, working, watching, sent, then snoozed and parked, which aren't in the counts. An Inbox view of a single status (Working, Snoozed) lists where its threads are instead.
  - **PROJECTS:** active projects only; snoozed, parked and finished ones wait on the Projects page. The heading opens the Projects page. A parent project has a chevron on its left; open, its children indent once under it, a snoozed or parked child dimmed with its state, and whether it is open is kept per device. A closed parent's count rolls up its children; an open one's is its own. An agent that owns projects nests the same way under AGENTS ([spaces.md](spaces.md), Nesting).
  - **AGENTS:** named agents only. Coding threads are not an agent; they belong to a project or a repo.
  - Settings and the owner at the bottom.

**Settings** has six pages, and each thing is set in one place: **This device** (text size, preview lines, the Newest / Oldest first sort, and what each window is for), **Inbox tabs** (the tabs and their editor, mutes at the foot), **Projects & agents** (projects, agent and repo icons, a project page's sections, space views), **Notifications** (the Screen feed, snooze times), **Accounts** (routing) and **Labs** (flags, and Stage order while stage labels are on). A link to one of the pages before (Display, Windows, Mutes, Agents, Repos, Space views, Feed, Snooze, Routing, Flags, Stage order) opens its new home scrolled to that section.
  - It hides with a control at its top or ⌘\. When hidden, a "show sidebar" button sits at the left end of the breadcrumb bar.
- **Breadcrumb bar (secondary)** spans the content area only and holds the breadcrumb on the left and the voice pill on the right: `Inbox › Ready › <thread>`, `Projects › <project> › <thread>`, `Agents › <agent> › <thread>`, `Agents › <agent> › Chat`. The middle crumb follows the path you took. A worker's or job's thread nests under the conversation it reports to ([spaces.md](spaces.md), Two relations): `Projects › Tango › Desk › Decision Delegation › Decisions phase 3`. That crumb opens the owner, and every Back from the worker (the phone's back crumb, the edge swipe, Esc, ⌘[, "go back") goes there. A space's default goes by its own name (`… › Tango Desk lead › <worker>`); an agent's chat is the agent's crumb already, so a job under it reads `Agents › Sierra › <job>`. An owner that is gone adds no crumb. A screen or prototype adds one crumb (see Stage).
  - **⌘[ and ⌘]** go back and forward, the macOS shortcuts, and work while a text box has focus (they type nothing). ⌘[ is the same Back as the crumb, Esc and "go back". ⌘] re-applies the last Back while the window is still where that Back left it; going anywhere else clears it, as in a browser. The history is each window's own, in memory: a detached window keeps its own, and a reload starts it empty. The desk takes both keys from Chrome, so Chrome's own back and forward never move the page. Under a menu or dialog they do nothing (Esc closes it first). The `?` sheet lists them.
- **Right panel (contextual)** sits under the breadcrumb bar. Its toggle is in the page header, always in the same spot.
  - A thread's panel tabs are History · Reporting here (when others report to it) · Links · Screens · Mail · Details.
  - A project's are Links · History. The project coordinator is folded into the space's default conversation ([spaces.md](spaces.md)): ask the default.
  - An agent's are Links · History.
  - Tabs use the text-and-underline style. The panel remembers whether it's open.
- **Neither sidebar pushes the content.** The center column is centered in the window and keeps one width on every page. Opening or closing the left sidebar or the right panel never moves it.
  - Each sidebar takes its side's margin when there's room.
  - When there isn't, it slides over the content with a shadow, starting below the page header's actions so ⋯ and the panel toggle stay reachable.
- **Floating + (Start work)** sits bottom-right on every page as an icon-only button, with an aria-label naming its context. It knows where you are:
  - On a project, it starts a thread in that project.
  - On an agent, a thread with that agent.
  - On a thread, a thread in the same place.
  - In the Inbox, a blank one.

  The sheet's first line names the context and can change it: one chip that mirrors the sidebar. Its picker lists the projects, each with its projects indented under it (a snoozed or parked one dimmed, with its state) and a row to make one; the agents a thread can start with, each with its projects; then each repo on its own. A project's thread runs on the project's repo, the one its latest thread runs in, so a repo is picked only for a thread outside any project; **Options → Repo** says why the repo is what it is and takes another, and a repo named in what you write still wins. A project an agent owns is a thread with that agent, in the project. The footer line names the repo a project's thread goes to ("In tango"). A ✕ in its corner, or Esc, closes it. A thread you start talks with you. **Options → Kind** makes it a Worker or a Job instead, and **Reports to** then names the conversation it reports to: the space's lead unless another open thread in the space is picked. Start waits until a worker or job has someone to report to, and the footer line says what Options changed ("Worker · reports to Desk lead"). On a phone it hides on pages with a composer.
  Start work defaults to **Auto**. Options offers **Auto**, **Worktree**, and
  **My checkout**. Role and prompt keywords provide a hint without changing the
  selection. Auto starts locally and moves the same thread to a worktree when
  edits are needed, carrying a handoff into a fresh session. Claude artifacts outside
  the checkout remain writable; Codex Auto starts with a read-only sandbox. See [Loom worktrees](../architecture/loom.md#worktrees).
- **The quick switcher** opens from ⌘K, "/", the sidebar search field, the tab bar's Search, and pulling down past the top of any list. It has a search field, then Inbox views, Projects, Agents, Actions, and matching threads as you type. Titles are just titles; tapping one does nothing.
- **Search** keeps the project or agent context when opened from that space: “In this space”
  starts on, and the breadcrumb names the space. Turning it off searches globally. The
  switcher passes that context when it opens the full Search page.
- Search covers **open conversations by default**: running, waiting, needs you, snoozed or parked,
  idle but not done. The result heading says “N open results”. Done and archived conversations join
  through **Also search done and archived (N)**, where N is how many more matches that adds (N+ for a
  lower bound); then **Only open conversations** narrows it again. The Search page and the switcher's
  footer both carry the link, and the switcher's “All results” keeps the choice. A saved view that
  picks its own statuses (History's done threads) keeps them, with no link. Clearing the words
  goes back to open only.
- Search's **Project** picker selects a desk folder; **Repo** selects a Loom workspace.
  Saved views, picker choices, scope and audience go to the server as the shared query;
  membership is evaluated before ranking and the final limit. The browser presents the
  returned hits without narrowing a previously capped result list.
- Search fields (`is:`, `kind:`, `in:`, `agent:`, `type:`, `stage:`, `repo:`, `before:`,
  `after:`) appear as chips below the box. Quoted values work; unknown fields remain search
  words. The result heading uses the server's filtered `total`: “N results”, or “N+ results”
  when `more` marks a lower bound. Full API and archived-hit rules are in
  [Agent Desk — Search](agent-desk.md#search-tgo-958-tgo-1068).

## Pages

- **Inbox:** titled "Inbox", with the views as pill tabs under the title, kept in sync with the sidebar. The list is grouped by status. The first view opens with **Decided for you** when there is something in it: what agents decided and did for the owner since they last looked, grouped by class, each with Undo (where there's a way back) and "I wouldn't have", then Seen all ([decisions-and-delegation.md](decisions-and-delegation.md), phase 2b). The weekly sweep follows it.
- **Projects:** every project, grouped Active, Snoozed, Parked and Done under headings that fold (kept per device). Top-level spaces only: children show on their parent's own page, not here ([spaces.md](spaces.md), Nesting). A parent's health meta adds "N projects" and its count pills are the roll-up. A snoozed, parked or done child lists in that group under its own name with its parent as a crumb.
- **Ask the space:** a project's and an agent's page, on every layout, has an "Ask <space>…" box under the header. It replies to the space's default and shares that default's reply draft. A project that has no default yet asks its old coordinator.
- **Project:** a header with tile, name, about and where it stands, then its threads grouped by status. The owner picks which status sections show: a default for every project in Settings → Projects & agents (Done hidden until changed), and ⋯ → Sections for one project. A quiet line under the list says what's hidden ("Done 4 hidden here. Show") and shows it for the visit. Its ⋯ menu:
  - Edit project…
  - Sections › (a check per section, then "Same as every project")
  - Wake (when snoozed or parked)
  - Snooze project ›
  - Park project
  - Finish project…
  - Keep watch
- **Agent:** its home chat plus its threads. Two treatments ship behind a setting until one wins:
  - **Tabs:** Chat and Threads inside the page.
  - **Pinned chat:** "Chat with Sierra" pinned above the thread groups.

  The agent's ⋯ menu: Pin, Mute notifications, Open in Discord.
- **Thread:** a header, then the needs-you call with its answer buttons, then the conversation, with the composer docked at the bottom.

## Thread row

```
Review and run the database script                                4m  [tile]   ← next action (else the title)
PR #372 is green and the reconnect test passed 50 runs. A restart drops any   ← preview, 2–3 lines
live voice call for about 20 seconds.
[Your move]  Operator reconnect double-send · Desk reliability · 1 screen     ← pill, then grey
```

- **The big line:**
  - When the thread waits on you, it's the next action: a short line of what it needs from you, generated from the agent's own ask. It's never an invented summary, and a newer ask from the source (a Loom question, a PR decision) wins over it.
  - Otherwise it's the thread's real title.
- **Preview:** 2–3 lines from the latest message.
- **Meta row:**
  - the status pill, which is the only color;
  - the thread's real title in grey, when the big line is the next action;
  - its home: the project, else the named agent, else the repo;
  - quiet facts: snooze, waits, screens;
  - what it's on behind the scenes, when no turn is running: the first thing in flight in the agent's own words ("waiting: CI on #741 +1"), and "wait check failing" when a wait's checks keep erroring.
- **In flight** (thread page, under Working on it / Watching / the ask): one line per background task, monitor, Loom wait or background job, with what it is, how long it has run, when a wait gives up, and a wait's latest failed check. It comes from Loom (`detail.tasks`, `detail.waits`) as `facts.inFlight`, so it's what is actually running, not a summary.
- **Tile**, beside the time:
  - the project's tile;
  - else the agent's real Discord avatar, as a rounded square;
  - else the repo's icon (its workspace icon, else the one the owner set in Settings › Projects & agents › Repos);
  - else a neutral repo glyph.

  On a project's own page the tile is still the project's: it says you're in the right place.
- **Compact rows** (big line, one preview line, meta) are for History, Parked and search results.

## Stage

A screen (a scene an agent staged) or a prototype (a page to click through) takes the whole page under the breadcrumb bar: `Inbox › Needs you › <thread> › <screen>`. The breadcrumb is its only chrome, so the frame gets the rest of the window.

- The sidebar stays when it fits beside the stage; otherwise it's hidden as on any page. The right panel, the floating + and the phone's tab bar step aside.
- **Back** is one crumb: the thread's crumb, Esc, ⌘[, or the phone's back crumb. ⌘] comes back to the stage. A screen with no thread goes back to its place. By voice, "go back" inside a prototype is its previous page; on a screen it goes back to the Inbox, as it always has.
- No links, earlier screens or "up next" on the stage: there's one screen at a time, shown mostly in voice mode, and the voice pill says what's next. Links stay in the thread's panel.
- Getting there doesn't change: the thread's Screens tab, a message's screen chip, or voice ("show me the screen", "show me the prototype").
- A control window (`?role=control`) stays on the thread; a Screen window (`?role=screen`) keeps its own full-window view.

## Page header

```
Operator reconnect double-send                               ⋯   ▣
[Your move] [Building ▾]   Desk reliability · Victor · 4m · Feature
```

- On a phone, the two pills sit on one line and the grey metadata wraps to its own line below them.
- **Status** is a pill, not a control, because it's derived.
- **Stage** (Discovery, Building, Feedback) is the one inline control: a small dropdown pill.
- **Project and type** are set up front and rarely change, so they appear as grey metadata and are changed from the ⋯ menu.
- **The thread ⋯ menu**, in sections, drills in with flyouts on desktop and as a sheet on a phone:
  - Reply
  - Snooze ›, Park, Done, Back to Active
  - Move to project ›, Type › (a worker or job: Reports to › in place of Move to project ›, two levels: the space, then the conversation)
  - Pin, Rename…, Watch PR review
- **Under the latest reply**, a row repeats the three put-away actions so finishing a long read doesn't mean scrolling back up to ⋯: **Done** (d), **Snooze…** (s, the same picker as the menu; Change snooze… when snoozed) and **Park** (not when already parked). It shows only when the thread takes them (not mid-turn, not in Done, not on a job), and on a phone the three buttons share the width.
- **Right-click** (a mouse or trackpad) opens the same menu at the pointer, flipped to stay in the window, wherever its subject shows: a thread row or a thread's title gets the thread ⋯ menu with Open first; a project (sidebar, Projects page) gets Open project and New thread in it, then the project's ⋯; an agent gets Open, then the agent's ⋯; an Inbox view (sidebar, pill tab) gets Open and its tab's settings. A right-click on a word opens the menu without selecting the word (as a Mac otherwise does). Shift+right-click, a right-click on text you selected first, and a touchscreen's long press keep the browser's own menu. The menu key opens it under the focused row.
- **Details** (repo, runtime, session, created) is a read-only tab in the right panel.

## Selecting

Any list of threads (an Inbox view, a project, an agent) and the Projects page can act on several rows at once. **Select** turns the list into a picker, the same way on a desk and a phone.

```
Cancel                 3 selected                 Select all    ← replaces the breadcrumb bar
YOUR MOVE 3                                         Select 3
(✓) Review and run the database script                  4m [tile]
(✓) Pick a retry ceiling                               22m [tile]
( ) Approve the healthcheck interval                    1h [tile]
──────────────────────────────────────────────────────────────
   ✓ Done     ☾ Snooze     ▣ Park     ▭ Move     ⋯ More          ← replaces the + and the tab bar
```

- **Ways in:**
  - A **Select** button beside Filter on the Inbox, and beside New project on the Projects page.
  - **⋯ → Select threads** on a project or an agent.
  - **Right-click a row → Select**.
  - A **long press** on a row on a touch screen.
  - **x** on the focused row.
- **While selecting:**
  - Each row shows a check circle, and a tap toggles it instead of opening it. Shift-click picks a run of rows.
  - Each group heading gets **Select N** (or **Deselect**). ⌘A selects every row on the page (again: none).
  - Rows don't swipe.
  - On the keyboard, **x** and **Enter** toggle the focused row, **u** marks the selection read and **U** unread, **e** marks the selection Done, and **s** snoozes it.
  - **Cancel**, Esc, or going to another place ends it.
- **The bar** along the bottom names the main actions: Mark read (it moves the lot from Needs you to Ready; an open request stays Needs you until answered, and the toast says how many still need an answer), Done, Snooze, Park (each also reads what it puts away, so none of them stays Needs you; Back to Active when everything picked is snoozed or parked) and Move. **More** has Mark unread, Back to Active, Stage, Type, Pin and Unpin. On a desk its menus open above the bar; on a phone they're sheets. For projects, the bar is Wake (when one is away), Snooze, Park and Finish. Mark read and Mark unread work wherever a thread is (Active, Snoozed, Parked, Done) and leave it there; a thread's own ⋯ menu has them too.
- **Right-click a selected row** for the same actions, plus Select all and Stop selecting.
- **Acting:**
  - Each thread goes through its own command, exactly as from its own menu.
  - Threads an action doesn't apply to are left alone (a working thread isn't marked Done; one already in the project isn't moved).
  - Done on a default clears it instead (it stays put, read and caught up; [spaces.md](spaces.md#a-standing-conversation-is-cleared-never-done)), and the toast counts it as cleared.
  - A background job is left running.
  - One toast names what changed, what was left and what failed: "Done · 4 threads · 1 left as it was". Its **Undo** takes the whole batch back.
  - Selecting ends once the action is sent.
- **Projects** act as a whole, as from a project's own ⋯. Finishing several asks once whether to mark their open threads done or keep them open on their own.

## Phone

- Inbox is the home.
- A bottom tab bar holds Inbox, Projects, Agents and Search, on a phone and an upright tablet (there is no setting and no drawer). It hides inside a thread, where the composer takes the bottom edge.
- The top bar shows a back crumb on pushed pages, plus the title.
- Drag in from the left edge to go back on a pushed page.
- Pull down past the top of a list to open the switcher.
- The right panel's tabs sit under the page header in the text-and-underline style.

## Voice

- Nothing shows while voice is idle. The top bar has no colored bottom edge.
- On desktop, a pill shows Paused and the waiting count, a draft ready to send, Drafting to its target, a fresh caption for six seconds, or Speaking, Thinking or Listening. Speaking uses the agent’s tile. Paused includes Resume.
- Tap for a dropdown: the Draft card with Send and Cancel, the last four captions, and things you can say on this page. While paused, a quiet note replaces captions. Escape or a tap outside closes it.
- On a phone, a round button takes the top bar’s right slot. Paused has an amber count badge; a ready draft has an amber ring. New captions peek below the bar for four seconds. Tap the button or peek for a bottom sheet with the same content and Resume when paused.
- A draft ready to send opens the dropdown or sheet once per draft. Closing it keeps it closed for that draft. The draft follows you to every page.

## Spaces

Projects and agents are both spaces ([spaces.md](spaces.md)). They share one page design and one row, and every list gets views.

- **Kinds on the row.** A conversation's kind shows as a small glyph before the big line and a grey word after the pill: Default, Job or Worker. A plain thread shows neither.
  - A worker's or job's meta ends with a trail: `↳ Desk reliability › Inbox empty state`, where it reports from. On the space's own page the trail drops the space. It is left out when the conversation reports to the space's own default.
  - A job adds "On schedule" (unless it failed or is running) and its schedule: "Every hour · last 40m ago · next in 20m". The server gives a job no move (desk/status.ts), so it never asks the owner itself.
- **The Inbox** lists only conversations that talk with the owner (threads and defaults). Jobs and workers reach the owner through what they report to.
- **Views on every list.** The Projects page (Active, Snoozed, Parked, Done), the Agents page (All, Needs you, Something failing) and a space's page use the Inbox's pill tabs. Space views are editable saved queries; Overview, Threads, Jobs, Workers and Done are the built-in set. They are one set for every project and agent page (the owner, 10/19: no per-space views), the desk setting `spaceViews` (null for the built-ins). Settings → Projects & agents → Edit space views…, a space's ⋯ → Edit views… and right-clicking a pill → Edit view all open the same editor. Add, rename, reorder, delete and restore save optimistically across screens, with Retry on failure. The selected view is remembered per space on this device across reloads.
  - Views filter Kind, Live state, Busy, Unread, Stage, Type, Agent (on project pages), Workspace / repo and Pinned through the shared query evaluator, with inclusion, exclusion and unset choices. They select open or done conversations, group by status, stage, type or none, and sort by recent activity or requests first. At least one view remains; empty views after the first hide. Only the first view applies the project's hidden Sections. Any view admitting the default conversation puts its matching default first, and on-schedule jobs stay last.
  - A space's Overview puts its default first as an ordinary row, then its conversations by status, then jobs on schedule. Workers stay off Overview (they reach the owner through their lead) and keep their own Workers tab.
  - Index rows add the space's health: jobs or workers failing, how many jobs, workers running.
- **A space's header:** tile, name and ⋯; the About line; then **Where it stands** as a small card with its time. The view pills replace the count chips.
- **Nested spaces** ([spaces.md](spaces.md), Nesting): two levels. A space's Overview opens with a Projects group of its children as place rows, then its default and threads, the same for an agent and a project. The breadcrumb reads `Projects › Tango › Desk › <thread>`. An agent's projects nest under the agent in the sidebar, not again under Projects.
- **The conversation page by kind.**
  - A job leads with when it runs, its last and next run, Run now and Pause, and its recent runs. Its latest run's output replaces the reply, with no separate failure callout. For a Tango schedule, Run now asks the bot to start a run without waiting for it (`POST :9200/schedules/<id>/run`). Pause holds its timed runs until Resume (`/pause`, `/resume`, kept in the bot's `schedule_pauses`); a manual run still runs. Both taps show at once, and a failure toasts with Retry.
  - A worker says "Working for X. You're visiting."
  - A conversation that others report to shows "N report here · Show", and the panel gets a **Reporting here** tab.
  - The header shows the kind next to the status, and Stage only for threads and workers.
  - ⋯ gains **Kind ›** (Thread, Job, Worker, Default). It is separate from Type ›, which is the work's tag.
  - Changing a thread to Job or Worker keeps the conversation it already reports to, else makes it report to its space's lead (the default; an agent's open chat in an agent's space). With neither, as for a thread in your own space, Job and Worker wait and **Hand off to ›** makes it a worker for the thread picked, in one step. The server refuses an owner outside the new conversation's space and the spaces around it. A job or worker's ⋯ has **Reports to ›** in place of Move to project ›: first the space (the projects as Move to project › lists them, No project, and the agent's space it is in when it is in one), then the conversation in it, the lead first, then the space's other open threads, never itself or one that reports to it. Picking one moves it there and re-points it in one step (the desk command `project` with `parentItemId`); a space with nothing to report to has one row that moves it there reporting to no one yet, the person's move until it is handed off. A move that picks no owner (a project finishing, voice, New project…) keeps the owner while it is still in reach, else re-points to the new space's lead ([spaces.md](spaces.md), Two relations); voice's undo of a move puts the former owner back. The menu's flyouts go two deep for this, on the desk and on the phone's sheet. Hand off to › uses the same conversation rows for the space the thread is in. Both write the parent in Loom the way `tango-screen start --role worker` does, so the crumb, its asks and its reports go there. The Start work sheet's reporting-to list is grouped by space the same way, the sheet's project first; picking from another group moves the start into that project.
  - Details lists Kind, Lives in, Reports to and Schedule.
- **Space settings** is a page under the space: ⋯ → Space settings, crumb `Projects › <project> › Settings`. It is built from Settings' own parts: About, lifetime, the default conversation, persona (agents), rules, tools, permissions and memory, each marked as set here or inherited from your space, with the record as JSON at the end ("Edit as JSON"). It saves as it changes, to the `spaces` setting (desk/spaces.ts). Picking another default conversation moves the role.

### Mutes

Inbox defaults are Needs you (`needs`, `failed`, requests first), Ready (`ready`),
To-dos, Working, Watching, Snoozed, Parked and History. Active can be recreated as
a saved tab. An unavailable saved device tab opens the first tab, Needs you by
default. A one-time migration splits untouched old Ready tabs and removes
untouched Active tabs; owner edits stay intact.

Global owner Mutes (`filters` in settings) apply to Inbox tabs and counts and
owner queues, including voice catch-up. Removable “Muted:” chips sit beneath
the Inbox tabs; Settings › Inbox tabs › Mutes lists agent, repo and type values with counts.
Changes are optimistic and failed saves offer Retry. Project and agent pages,
index counts and Search retain muted conversations; space rows say “Muted”.

### Inbox Filter and saved tabs

The Inbox Filter menu has Sort (Newest or Oldest first), then Where, then Show
only. Where is one picker in the sidebar's shape: Projects with their children
nested, Agents with their projects, then Not in a project with its repos. A
thread files under its project and that project's parents, else its named agent,
else Not in a project and its repo; Loom and T3 are tools, never agents. So a
parent's pick takes in its children. Show only holds one-tap toggles (Unread,
Pinned, Working now, Overdue) and two submenus, Waiting on and Last active. Stage
shows only behind its flag. Kind, Source and Account are not in the menu. Picks
on the retired Project, Agent, Repo, Space and Kind facets still narrow and show
as chips, so an older device pick can be removed. Saving a parent tab narrowed
to a child (or the reverse) keeps the narrower place. The Inbox tab editor offers
Where, each place named by its path ("Tango › Desk"). Picks are OR
within a facet and AND across facets, through the shared query evaluator.
Option counts apply every other pick; selected zero-count options stay removable.
A quiet “On this device” chip line under the tabs names each pick, with immediate
removal and Clear. Standing Mutes remain on their own distinct line.

“Save as tab…” asks only for a name, suggested from the picks, and saves the
intersection of the current tab definition and the device picks to shared
`listViews`. It switches to the new tab and clears the device picks after a
successful save. At 20 tabs it is disabled with the reason. The tab reproduces
the same membership, including conflicting and unset picks. An empty saved
filter stays empty rather than substituting today’s completed work. Voice reports the
saved tab by name. Unknown facet values narrow or are refused, never silently
widen a tab.

The Inbox tab editor uses the Filter menu's words: Status, Live state, Where
(each place named by its path), Show only (the same toggles), Waiting on, Last
active, and Stage behind its flag; Kind (Thread or Default), Source and Account
sit under a folded Advanced. Each facet is "any of these" with one Exclude
instead switch, and unset is one of its values ("No wait", "No stage"). A filter
saved with both picks and exclusions keeps the exclusions, named beside the
picks, until dropped. Filters only an older tab has (Project, Agent, Repo,
Space, Workspace, or a Show only facet holding another value) list under their
own heading, still applied, editable and removable in one tap. Group by offers
Live state, Project, Stage (behind its flag) and None; a tab grouped by
Workspace keeps that choice until changed. Sort offers Requests first, Newest
first, Oldest first and Wakes soonest; a tab's Oldest first holds whatever the
device picks.

### Filter facets and Advanced

Wait narrows Watching rows to Person, Agent, PR review, Job, Monitor or
Check-back; a row without a recognized wait has an unset value. Overdue reads
the wait's recorded overdue fact. Age buckets last activity into Today,
This week (under seven days), This month (under thirty days) and Older, using
the query clock. Wait (as Waiting on), Overdue and Age (as Last active) appear
in the main Inbox Filter menu and both saved-view editors.

Advanced holds Source (the runtime) and Account (the known Loom account),
folded by default in editors and not offered in Filter. Account is a
cached read-time fact; unknown accounts remain unset. Job Health is Failing,
Paused, Running or On schedule, with unset for non-jobs and completed idle jobs.
Space views may explicitly group jobs by Health. Built-in views are unchanged.
Every facet uses `query.js` for include, exclude, unset and counts. Unsupported
facets or values reject a save or match nothing; they never drop a constraint.
