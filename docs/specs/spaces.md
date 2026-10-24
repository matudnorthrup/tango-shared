# Spaces and conversations

How Tango organizes everything an agent works on (October 2026). One model
covers Discord agents, coding threads on Loom, Tango schedules and
workers, and Codex runs. Active plans and status live in Linear (TGO-1031).
Runtime policy by conversation type is in
[resilient-runtime.md](resilient-runtime.md#thread-roles).

## Two objects

- A **space** holds shared context: rules, tools, permissions, memory and a
  persona. It contains conversations.
- A **conversation** is where work happens. Every conversation does work. It
  lives in exactly one space.

### Spaces

A space has a kind:

- **Agent.** Usually enduring, with a persona (name, voice, avatar). Examples:
  Watson, Sierra, Compass.
- **Project.** Usually time-bound, but not always: a studio can be an
  open-ended project. Examples: Board game, Resilient runtime.

- **Personal.** The person's own root space. There is exactly one per person.
  It holds the top-level agents and projects and every standalone thread. It
  has no default conversation, because the person is its center.

All three kinds are the same object with different settings.

- **Spaces nest.** An agent can own a project, and a project can have
  sub-projects. Rules, tools, permissions, memory and persona inherit down the
  nesting. A child adds to or narrows what it inherits, and never widens it.
- **Every agent or project space has exactly one default conversation.** Work
  you don't want in a space is a standalone thread instead. A thread can become
  the default of a new space.
- **The person's personal space is the root.** Top-level agents and projects
  nest in it, and standalone threads live in it.

### Conversations

A conversation's type is two properties:

| | Talks with the person | Reports to another conversation |
|---|---|---|
| **Standing** (never completes) | **Default**: the space's central chat | **Job**: runs again and again (PR operations, a feedback desk, a Tango schedule) |
| **Bounded** (completes) | **Thread**: the person drives it | **Worker**: does one job and reports back (a playtest, a Codex run) |

- **Coordinating is not a type.** Any conversation can direct others. The
  default is where a space's work is driven from unless something else is
  chosen.
- **A default's duties: it routes, it doesn't do.** The person fires requests
  at a space's default and expects each one routed without being asked. When a
  thread or worker already owns the work, the default tells it (desk mail).
  When nothing owns it, the default starts a worker for it. It never does the
  work itself and never asks the person whether to start a thread. What is left
  to it is routing, deciding what the delegation board lets it decide, and
  reporting what comes back. Every default gets this as standing instructions:
  Loom adds it to a `default` thread's system prompt (a thread that becomes a
  default reopens on its next turn to pick it up), the desk-mail skill says it
  for other coding threads, and the shared agent rules say it for an agent's
  home channel.
- **A conversation can change type.** This is an action, not a new object:
  - Thread → Job: gets a schedule or trigger, and a conversation it reports to.
  - Thread → Worker: hand it off to report to another conversation.
  - On the desk, both pick what it reports to: the space's default unless the
    owner picks another open thread in the space. Starting a worker or job
    from the desk picks the same way.
  - Worker → Thread: adopt it.
  - Thread → Default: of a new space made around it, or of its own space. In
    its own space this is an atomic swap: the old default becomes a thread
    (bounded, talks with the person) in the same transaction, so the space
    never has two defaults or none.

### A standing conversation is cleared, never done

On a thread, Done means two things at once: the person has dealt with the
latest, and the conversation is over. On a default only the first can be
true, so a default takes **Clear** where a thread takes Done.

A standing conversation here is a Loom thread with role `default`, or the
latest chapter of an agent's home channel (Foxtrot, Charlie). Both read as
Default on the desk (`kindOf`).

- **Clear means "I'm caught up".** It marks the row read, takes its catch-up
  lines as seen, and moves a Finished pill back to Idle until the agent hands
  off again. It closes a `Next — you` hand-off ask as Done does. An open
  brief, question or approval stays in Needs you until it is answered.
- **The row stays where it is.** It keeps its place and status group and
  never goes to Done or History. Clear never settles the Loom thread: no
  `settled_at`, so no worktree archive, and the default stays its space's
  lead. On Discord, Clear writes the same ✅ that Done writes on a chapter, and
  a ✅ left in Discord reads as Clear.
- **Every Done path clears a default instead.** These are the row's Done
  (menu, **d**, swipe), voice "mark it done", bulk Done, and catch-up Accept.
  The server makes the choice, so a client that still sends `done` can't file
  a default. A bulk toast counts both: "Done · 3 threads · 1 cleared". Undo
  puts back what Clear changed.
- **Nothing files a default on its own.** A sweep never drops a default. The
  latest home-channel chapter no longer settles itself after the idle gap. When a
  new chapter starts, the one before it is filed quietly as superseded: no
  ✅ and no unread change. Only the latest chapter is the agent's chat. Older
  chapters still active at upgrade remain eligible for idle settlement.
- **Snooze and Park still apply.** They put a default away for a while and
  bring it back. They don't end it.
- **A default ends in one of two ways.** The first is the swap above: make
  another conversation the default, and the old one becomes a thread that Done
  can file. The second is finishing its project, which takes the default with
  it. An agent space has no finish, so an agent's chat never ends.
- **Defaults already marked done.** On the first run, a `default` row that is
  done in a space that is still open comes back to Active as read. If its Loom
  thread is settled, it is unsettled.

## Two relations

- **Lives in** (a space) decides what a conversation inherits and where it is
  filed.
- **Reports to** (a conversation) decides where its questions and failures go.
  Only jobs and workers report. Threads and defaults talk with the person.

The two usually agree: a job or worker reports to its space's default. They may
differ. A playtest lives in the Board game project and reports to the thread that
started it. Rules:

- A conversation reports to one in its own space or an enclosing space.
- Handing off moves a conversation into its owner’s space when it can’t report there from where it lives.
- Nothing outlives the conversation it reports to or the space it lives in.
  - When the conversation it reports to ends, it reports to its space's default
    instead.
  - Before a space ends, every conversation still open in it moves to the
    enclosing space and reports to that space's default. At the top, that is
    the personal space, and the conversation talks with the person.
- The person sees asks from defaults and threads. Jobs and workers reach the
  person only through what they report to.
  - On the desk, a job or worker never shows "Needs you" unless it failed
    (desk/status.ts). A worker is the person's move again only when the
    conversation it reports to is gone (missing or done), until the desk moves it
    to the default. Even its answer to the person's own words, or to a tap on its
    screen, goes up to that conversation.
  - What a worker says goes to what it reports to. That includes its answer to
    its owner's mail and every later turn it finishes on its own (desk/mail.ts
    `reportUp`). The owner conversation speaks for it: it brings the worker's
    questions, links and screens to the person in its own reply. The worker's
    screens and prototypes also show in the owner conversation's Screens tab
    (not inline under it), and a tap there answers the worker. The person never has to go to the worker.
    When they do, their words there count everywhere: the desk mails them to
    the owner conversation at once (backstage, with the decision id when they
    answer one), so it hears them within one turn and must not ask again. A
    worker's open brief is carried intact on the owner conversation's row
    (counted once, there), and a decision answered anywhere clears any open ask
    that points at it ([decisions-and-delegation.md](decisions-and-delegation.md#passing-a-brief-up)).
- **Moving a conversation to another space keeps what it reports to** when that
  conversation is still in the new space or one around it. Otherwise it reports
  to the new space's default, or to no one when the space has none, and it is
  the person's move until it is handed off. A thread or default has no owner,
  so its move changes nothing else.
  - On the desk, a worker or job is moved and re-pointed in one step:
    **Reports to ›** picks the space, then the conversation in it (the lead
    first), and the move carries the owner with it (the desk command `project`
    takes `parentItemId`, checked against the new space). A move that picks no
    owner (a project finishing, voice, New project…) applies the rule above.
  - Only a space's own open conversations are offered; reporting to an
    enclosing space happens on its own when a project finishes, and the server
    keeps allowing it. "Up" entries in the picker wait for a real case.

## Data

| Concept | Field | Notes |
|---|---|---|
| Conversation type | `role`: `interactive` (thread), `worker`, `ops` (job), `default` | On Loom threads since #650. `default` replaced `coordinator`; a migration renames any old rows. |
| Reports to | `parent_thread_id` / `parentThreadId` | A qualified Desk id: `loom:<id>`, `agentctl:<project>/<task>`. |
| Lives in | `space_id` | New. |
| Space | space record: `id`, `kind` (`agent`, `project` or `personal`), `parent_space_id`, `persona`, `rules`, `tools`, `permissions`, `memory`, `default_conversation_id` | New. The Desk's projects and Tango's agent configs become space records. |

What already exists maps onto this:

- **Desk projects** are spaces of kind project. Each project's coordinator
  thread is its default.
- **Discord agents** are spaces of kind agent. An agent's home channel is its
  default, and its Discord threads are threads in its space.
- **Tango schedules** are jobs in the space their `agent_id` names.
- **Tango workers** (`owner_agent`) and **background jobs** are workers.
- **agentctl tasks** are workers. They report to the conversation that
  dispatched them (`parentThread` in `status.json`).

## Pages

- **Space page:** one design for both kinds. It shows:
  - the persona or the project tile;
  - the default conversation;
  - threads;
  - jobs (schedule, last run, next run, health);
  - a timeline of what happened;
  - workers.
- **Conversation page:** one design with four flavors. A thread or a default is
  a chat. A job adds its schedule and runs. A worker shows what it reports to.
  Its breadcrumb nests it under the conversation it reports to, after the place
  you came from: `Projects › Tango › Desk › Decision Delegation › Decisions
  phase 3`. That crumb opens the owner. When the owner is the space's default,
  the crumb is the default's name; when it is an agent's chat, the agent's own
  crumb stands for it ([agent-desk-next.md](agent-desk-next.md), Breadcrumb bar).
- **Sidebar:** Agents and Projects stay separate headings; both list spaces.

## Nesting

How nested spaces show, agreed 2026-10-18 (TGO-1042). Two levels for now: a
parent and its children. Deeper nesting waits for a real case.

- **Sidebar.** Top-level spaces only, each parent with a chevron on its left.
  Opening a parent indents its children once under it. A parent lists every
  child it still has: a snoozed or parked child shows dimmed with its state
  ("Bike parked"), so the nesting stays visible while the child is away;
  only a finished child drops out. Rows without children keep the same left
  edge, so tiles line up and counts stay on the right edge. Whether a parent is
  open is kept per device, like the Projects page's group headings. An agent
  that owns projects nests the same way under AGENTS: the chevron, the indent
  and the count rule are the same, and its projects are not repeated under
  PROJECTS.
- **Counts follow what you can see.** A closed parent's count is the roll-up of
  its own conversations and every descendant's. An open parent's count is its
  own, and each child shows its own. The numbers on screen always add up, and
  folding never hides work. The hover breakdown of a closed parent lists "here"
  first, then each child with its numbers.
- **The Inbox does not change.** It lists by status, not by space, so Needs you
  is the same number whatever is folded.
- **A space's page lists its projects first** (the folder shape, picked
  2026-10-18 over an accordion on the Projects page). Its Overview opens with a
  Projects group of its children as place rows (tile, name, where it stands,
  counts, health), then its default and its own threads by status, then jobs.
  The same for an agent and a project: Sierra's page lists Bike the way
  Tango's lists Desk. Landing on a space from the sidebar shows what is inside
  it without another tap.
- **The Projects page lists top-level spaces only.** Nothing unfolds there. A
  parent's health meta adds "N projects", and its pills are the roll-up, since
  its children are not on screen. A child that is snoozed, parked or done lists
  in that group under its own name with its parent as a crumb ("Acme ›",
  "Sierra ›"), so no parent row hides it. A chevron peek on the index can be
  added later if the index ever feels blind; it is not part of this.
- **A parent's default and Where it stands** are its own; a child's asks reach
  it only through a report-to it was given.
- **Breadcrumb:** `Projects › Tango › Desk › <thread>`.
- **A parent holds threads directly.** General Tango work lives in Tango
  itself; there is no catch-all child.
- **An agent's projects** show under the agent in AGENTS, not again under
  PROJECTS. The Projects page still lists them, with the owning agent as their
  crumb, so they stay findable there.
- **Snoozing or parking a parent** holds its children and their conversations
  the way a project already holds its threads; waking it brings them back.
- **Finishing a parent asks once**, as finishing several projects does: whether
  its open child projects finish with it or stay open on their own. The
  question the finish flow already asks about open threads applies to every
  project being finished. Kept-open children move up to the enclosing space (at
  the top, the personal space) and their crumb drops the finished parent. The
  parent's own open conversations move up, as above.
- **Moving a project under a parent** keeps its threads and their breadcrumbs,
  as moving a thread between projects does.
