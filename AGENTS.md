# Tango — Agent Instructions

This is the shared instruction source for Claude, Codex, and other coding
agents working on Tango. `CLAUDE.md` and the former operating guide are
compatibility pointers. Keep new shared policy here, not in vendor copies.
Global personal policy lives outside the repository; repository-specific
instructions and the explicit dispatch scope still apply.

The role add-ons below are selected by the thread's explicit role, never by
its vendor. Read only the add-on for your role. A space coordinator (`default`)
routes work; an interactive thread or worker can implement within its scope.
Loom loads the marked sections from its own release's copy of this file, so
threads in other repositories receive the same runtime and role instructions.
The rest of this file governs work on Tango only.

## Harness Notes

- Use the tools available in the current harness for Linear, GitHub, browser,
  shell, tmux, and automation/monitoring work. If an older instruction names
  an unavailable tool (such as `CronCreate`), use its available equivalent and
  record any remaining limitation in Linear before reporting.
- Codex uses `codex/` as the default prefix when creating branches.

## Code review — privacy backstop

When reviewing a pull request (human or automated reviewer, including Codex):
flag any **personal data** appearing in the diff — real names, personal email
addresses, home addresses, health or behavioral details, real Discord/account
IDs, or machine-local home-directory paths. Personal context belongs in the
profile layer (`~/.tango/profiles/...`), never in tracked files. This is a
second net behind the CI `privacy-gate`; treat a finding as blocking. For
changes touching personal-data handling (email tools, access control, memory
classification), also run Claude `/security-review` or `/code-review ultra`.

## Code review — earlier work

When reviewing a PR, read its "Changes earlier work" section. For each earlier
PR named, open that PR and check that the reason holds: the change belongs to
this PR's stated scope, and any owner decision cited says what it claims.
Flag as blocking an earlier behaviour dropped with no reason, a reason that
contradicts the earlier PR's owner decision, or a test assertion rewritten to
match new output without declaring the behaviour change.

## Source Order

When starting work, gather context in this order:

1. User request and current conversation.
2. This repository’s `AGENTS.md`.
3. Project memory, using the discovery order below.
4. Linear project or issue state.
5. Repo docs and code.

If sources conflict, prefer the newest explicit user direction, then Linear for
active project state, then repo docs for durable architecture and process.

## Operating Roles

The person requesting the work is the stakeholder and owner. The active PM/coding agent is responsible
for carrying approved work through planning, implementation, validation, and
reporting without asking permission for routine reversible steps.

Standard agent authority includes:

- creating and updating Linear projects/issues
- making tactical implementation decisions inside the requested scope
- using parallel dev slots and live-test workflows
- updating docs and prompts when that is the task
- reporting completed results, not every intermediate thought

Which decisions are the agent's and which go to the owner is set by the delegation
board. See [Decisions and Delegation](#decisions-and-delegation).

### Decisions and Delegation

The delegation board, [`config/decisions/board.yaml`](config/decisions/board.yaml),
sets a level for each class of decision. Full design:
[`docs/specs/decisions-and-delegation.md`](docs/specs/decisions-and-delegation.md).

| Level | The agent | Classes |
|---|---|---|
| 5 Act | decides; nothing to report | continue inside approved scope; verify your own change |
| 4 Act and tell | decides, then lists it under "Decided for you" in the report (on a Loom thread, also `loom.decision_log`) | ops on the owner's own machines; PR housekeeping; merge when head CI, GitHub-required approvals, resolved threads and recorded work approval are satisfied; reviewer choice from the owner's last pick |
| 3 Act unless vetoed | brief with a default; the default runs after 4 hours of the owner's active time | product choices inside an approved feature; deletes with a verified copy (batched) |
| 2 Recommend | brief; waits on that decision only and keeps working | design direction (a conversational thread); plan approval; shared production ops |
| 1 Owner's call | brief with options side by side | creative work for publishing; credentials and identity; acting toward other people in the owner's name; spend; deletes with no copy |

Tripwires always come to the owner whatever the class: the owner's identity, money,
acting toward others in the owner's name, security and privacy, a one-way door with no
copy, conflicting rules, or anything that would surprise the owner tomorrow.

When something does need the owner, bring a **decision brief**, not a question in
the middle of a thread. On a Loom thread, check the board with
`loom.decision_check` and raise the brief with `loom.decision_request`. Loom
checks it, shows it on the desk, and wakes the thread with the answer. After a
level 4 decision on a Loom thread, log it with `loom.decision_log` (one line, and
how to undo it): the owner sees it in the desk's Decided for you and can ask for
Undo, which arrives as a new turn. Elsewhere, write it in this form:

```
About: <project or feature> — <the problem>
**Decision needed — <the ask + your recommendation, one line>**
- Where it stands: <≤3 lines; first sentence names the problem or goal>
- Background: <what someone who never read this thread needs>
- Options: **A (recommended)** <consequence> · B <consequence> · C do nothing <consequence>
- Assets: <PR, preview, prototype, screenshots as links>
- If you don't answer: <what happens, and when in the owner's active time>
- Wording: no internal version or phase labels; define any term the owner didn't coin.
- Rule: "Next time, for <scope>, do <X> without asking" (a two-way door, private or team, no tripwire)
```

- To pass a brief up (a worker's, or one you point the owner at), name its id
  and its link and stop: `<desk address>/decision/D-n`, which `tango-screen
  decision D-n` prints (for example
  `https://<desk host>/tango-screen/decision/D-n`). The link
  opens the full brief with its buttons on any device. If the owner answers it in
  your conversation instead, record it with `loom.decision_close` (`outcome:
  "answered-in-chat"`); that works from any thread in the brief's chain, or one
  that named the id in its closing ask.
- Ask once. Re-record the same hand-off unchanged (it is a no-op); say
  nothing new about that unchanged ask. This only suppresses repeated nudges,
  never an answer to a new owner question: write the answer in the visible reply,
  even while the same ask remains open. Thinking, tools and a Next line are not an answer.
- When you learn something that changes an open brief (yours, a worker's, or
  your lead's), update it in place with `loom.decision_update` (same id; the
  owner sees what changed), or close it as moot with `loom.decision_close`
  (`outcome: "moot"`, with the new information). Don't raise a new brief for it.
- Never send "try it and tell me". Test it yourself and send an FYI.
- Never ask what you can find out yourself (the vault, the repo, the
  transcript, a lookup).
- Put each brief in the conversation the owner reads (the thread, or the owner a
  worker reports to), with one decision per brief.
- Before asking, check the standing rules. On a Loom thread, `loom.decision_check`
  lists them (Loom keeps them, and lowers a class's level when the owner keeps
  reversing it). Elsewhere, read `decisions/rules.md` in the operator profile,
  which is private and outside the repo; Loom rewrites it as a mirror of its
  rules on every change. If your case falls inside a rule's scope (the same
  scope, or a narrower case that contains its words), act on it and cite it: on
  Loom, `loom.decision_log` with `rule` and your case's `scope`. A different
  subject is a near miss and still asks.
  If you think the rule is wrong, follow it and say why (`dissent`); recurring
  dissent comes up in the owner's weekly Delegation review.
- When the owner approves a brief's recommendation unchanged, it is a
  precedent, not yet a rule (D-61). `loom.decision_check` lists the class's
  precedents: name a matching one in your brief's `precedents`. When the owner
  approves a second similar call the same way, Loom proposes one rule for both
  and the owner confirms it; "Always do this" makes a rule at once. Off Loom,
  append a rule to the rules file (next free id) only when the owner said
  Always or confirmed a second similar call; Loom picks it up. Don't ask that
  class again within a rule's scope. A reversal of an action taken under a rule
  suspends the rule: Loom does this itself; off Loom, mark the rule `suspended`.

### Engineering Execution

New coding threads must start on Loom, including threads created through the
Agent Desk or `tango-screen start`. T3 is retired. If Loom is
unavailable, report the failure rather than falling back to T3. Plan first on
Loom is a prompt instruction to propose a plan and wait for approval before
implementation; it is not an enforced read-only mode. T3 integration has been removed; this does not authorize deleting its retained data.

As of 2026-06-09 the mandatory PM/dev split is retired: the active agent
implements directly instead of delegating all coding to a separate dev agent.
Write the code, review it, validate it, and ship it in one continuous loop.
Delegate to subagents or parallel dev slots when the work genuinely benefits —
independent workstreams that can run concurrently, or builds large enough to
exhaust the primary context — not as a required handoff. Codex remains
available as an optional second opinion (deep diagnosis, design review,
adversarial pass).

When delegating, choose by the work:

- **Harness subagent:** a small lookup whose answer feeds the current turn, or
  judgment-heavy review where a miss costs more than tokens, such as the
  overwrites audit. The review recommendation is provisional: one measured
  run; a stronger-tier probe comparison is the next measurement.
- **Loom fan-out probe** (`loom.fan_out`, Codex by default): parallel read-only
  research large enough to matter for the parent's Claude quota, or work that
  must not write. Set `provider: "codex"` when read-only must be enforced;
  Claude probes are read-only by request and can still write through Bash.
  Codex probes have no network, so route GitHub and web lookups elsewhere.
  One wake delivers the whole set.
- **Loom worker:** anything that edits, ships, needs network or GitHub access,
  or runs longer than one bounded question.

On Loom, Claude quota is the constraint (owner decision D-51, 2026-10-19). A
lead or worker with implementation work that has a written spec hands it to
Codex through `agentctl` (the `agentic-delivery` skill) instead of building it
on Claude, then reviews, verifies and ships it. One `loom.wait_for` per Codex task;
no polling turns. Design, judgment calls and owner-facing work stay on Claude.
Worker threads run on Codex through Loom's own Codex runtime (Loom's `ROLE_MODELS`,
rule R-18; override with `LOOM_ROLE_MODELS`), and ops threads on Haiku (rule R-11).
Browser QA (agent-browser checks, desk checks, preview screenshots) starts with `--tier qa`, which runs on Sol 6.1 medium on Codex.
A worker falls back to Sonnet when no Codex account has room or its session profile
can't run under Codex (`tools: "none"`, a remote MCP server). A worker already on
Codex implements a written spec itself instead of handing it to `agentctl`. Set a
thread's session profile `model` (for example `opus`) to keep it on Claude.

## Memory Discovery

**Operator profile:** Fleet save behavior can live in `~/.tango/profiles/<profile>/skills/session-save.md`. Atlas `memory_add` auto-stamps Discord conversation, turn/message, event-time, and human context provenance from the runtime environment (see `packages/discord/src/discord-memory-provenance.ts`).

Do not assume project memory is tied to the current agent brand. Check every
existing candidate and read the relevant `MEMORY.md` index before relying on a
memory file:

```bash
project_root="$(git rev-parse --path-format=absolute --git-common-dir)"
project_root="${project_root%/.git}"
project_slug="${project_root//\//-}"
printf '%s\n' \
  "$TANGO_AGENT_MEMORY_ROOT" \
  "$HOME/.claude/projects/$project_slug/memory" \
  "$HOME/.Codex/projects/$project_slug/memory" \
  "$HOME/.codex/projects/$project_slug/memory"
```

Use the first existing index that contains the needed project guidance. If more
than one exists, compare their `MEMORY.md` indexes and prefer the most current
relevant file rather than assuming the directory name is authoritative.

Important memory files normally include:

- `user_pm_role.md`
- `feedback_done_means_live_tested.md`
- `feedback_project_docs.md`
- `reference_linear_example_hq.md`

## Linear

Linear is the source of truth for active project work in the Example HQ
workspace, Tango team.

- Create or use a Linear project for each new initiative.
- Use the standard milestones: Discovery, Implementation, Deploy when needed,
  Validation, and Ship.
- Move issue status as work progresses: Todo, In Progress, In Review when
  useful, Done, or Canceled.
- Post Linear Project Updates at meaningful milestones: handoff, development
  completion, test summary, deploy/restart, validation, and final ship/cancel.
- Every Project Update must include recently completed work, blockers/risks,
  and next steps with clear owner labels when ownership matters.
- Use issue comments for issue-specific evidence such as logs, validation proof,
  or cancellation rationale.
- Update Linear before reporting completion to the stakeholder.

### Connecting to Linear

Every agent — Claude Code, Codex, and the Tango runtime — authenticates the same
way: a Linear API key sent to the GraphQL endpoint. There is no OAuth step, so it
does not expire or need re-authorization. Do not rely on per-tool OAuth Linear
connectors (Codex's curated plugin, remote MCP) as the primary path; they lapse.

- Endpoint: `POST https://api.linear.app/graphql`
- Auth header: `Authorization: <key>` (the raw key, no `Bearer` prefix)
- Key resolution order (mirrors the runtime's `linear-agent-tools.ts`):
  1. `LINEAR_API_KEY` from the repo `.env` (gitignored; already populated).
  2. 1Password fallback — vault `Watson`, item `Linear Example-HQ Tango API Key`,
     field `credential`, read with the `OP_SERVICE_ACCOUNT_TOKEN` also in `.env`.

Resolve the key and query from a shell (identical for Claude Code and Codex):

```bash
LINEAR_API_KEY="$(grep -m1 '^LINEAR_API_KEY=' .env | cut -d= -f2- | tr -d '"')"
[ -n "$LINEAR_API_KEY" ] || LINEAR_API_KEY="$(
  OP_SERVICE_ACCOUNT_TOKEN="$(grep -m1 '^OP_SERVICE_ACCOUNT_TOKEN=' .env | cut -d= -f2- | tr -d '"')" \
  /opt/homebrew/bin/op item get 'Linear Example-HQ Tango API Key' \
    --vault Watson --fields credential --reveal)"

curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query":"{ viewer { id name } teams { nodes { key name } } }"}'
```

Workspace identity: the Tango team key is `TGO`; the `viewer` is the "Tango"
service user. See [`agents/tools/linear.md`](agents/tools/linear.md) for the
GraphQL schema, entities, filtering, pagination, and read-before-write rules.

## Done Means Live Tested

A fix or feature is not done until it is live tested end to end. Unit tests,
static checks, and local smoke tests are milestones, not the finish line.

Do not move a project to Ship or merge a PR until every Validation milestone
issue is Done with documented validation evidence in Linear.

For docs-only work, replace live product testing with the relevant validation:
link checks, inventory checks, privacy scans, and review of rendered or indexed
documentation.

Decision briefs always render through `BriefCard` (`apps/screen/public/desk/brief.js`): full on threads and decision pages, compact in catch-up, including read-only outcomes. Use `brief-fixture.html` to check all three surfaces together.

### Testing the Agent Desk

A new pill, catch-up kind, desk command or waiting reason: classify it in `voice-contract.ts`.

The live desk is the owner's working surface: every window he has open follows
one shared view, and its buttons act for real. Desk tests therefore go to the
sandboxed test desk, `npm run desk:test` (`apps/screen/scripts/desk-dev.ts`):
- It runs the real desk code with a sandbox Loom (fake turns), a bot stub, and
  its own System ledger with dry actions.
- `--mirror` serves a frozen copy of the live data.

On the live desk, agents only read. When a live UI check is truly needed, the
window opens with `?detached=1&name=<check>`, so it neither moves nor follows
the owner's windows. Nothing with a real effect is pressed unless that effect
is what's being tested. The agent-screen skill has the details.

## Match the Model to the Task

Tango runs on multiple backends (Claude + open-weight Ollama Cloud models). The
right model is **task-dependent** — do not standardize the whole fleet on one.
Bounded, tool-driven tasks should run on the **fastest** capable model (all
candidates complete identically, so speed is free); ambiguous, judgment-heavy
tasks should run on a **thinking** model that reasons deeper.

When building a new task or workflow, follow the **golden-path-first** practice:
a capable model (Claude, or by hand) establishes the correct process first, then
bake off cheaper candidates on that *same* process and assign the cheapest that
meets the quality bar — per persona, via `runtime.model`. Use
`scripts/model-bakeoff.mjs` to compare models on one task.

Full strategy: [Per-Task Model Selection](docs/guides/model-selection.md).

## Documentation

Repo docs are for durable knowledge, not active project tracking.

Keep in repo:

- architecture decisions and current architecture references
- retros/postmortems with lessons future agents need
- operator and contributor guides
- implementation-facing specs
- prompt/runtime asset docs that are safe as repo defaults

Move to Linear:

- active project plans
- mutable status updates
- validation evidence
- open questions and approval gates
- work breakdowns and project updates

Move to profile or private storage:

- raw/generated personal analysis
- private family, legal, health, financial, or relationship context
- user-specific prompt overlays
- real operational IDs when placeholders are enough
- machine-local paths unless an operator runbook explicitly needs them

Until the docs tree is reorganized, `docs/projects/` is a legacy location for
final project writeups and retros only. Do not add new mutable project-status
docs there when Linear can hold the source of truth.

## Parallel Development

Use isolated dev slots for implementation work that needs live Discord or bot
testing:

```bash
scripts/dev/spawn.sh feature/x --agent claude-code
scripts/dev/list.sh
scripts/dev/claim-bot.sh 1 --live
scripts/dev/run-slot-tests.sh 1
scripts/dev/release-bot.sh 1 --live
scripts/dev/release-worktree.sh 1
```

Profile isolation uses `TANGO_PROFILE=wt-{N}` so each slot gets its own
`~/.tango/profiles/wt-{N}/` state.

Singleton services such as the voice operator stay on main unless a project
explicitly designs otherwise.

## Updating live checkouts

Updating a live checkout is not complete until its workspace build succeeds.
A detached checkout of `origin/main` only updates sources: commands and tests
can still fail on missing or stale workspace `dist` files. Root `npm run build`
builds all workspaces that have a build script, in dependency order.

For the operator and live copies, use:

```bash
bash scripts/dev/update-live-checkouts.sh
# Or supply both checkout paths:
bash scripts/dev/update-live-checkouts.sh /path/to/operator /path/to/live
```

The helper preflights both copies for local edits and commits absent from main,
protects ignored files from overwrite, fetches main, pins the same
revision in both, and builds each. It never stashes or discards changes, installs
dependencies, or restarts services. Dependencies must already be installed; if
manifests changed, install the required dependencies before rebuilding. A failed
build stops the update and leaves its checkout at the reported revision for
repair; the two-copy update is not atomic. Do not restart after a failed build.

If a checkout has local edits, preserve and reconcile them explicitly before
updating. To repair missing builds without updating sources, run `npm run build`
in each existing checkout. After updating, run the root `npm test` in operator
and verify the affected commands. If a service needs to load the new compiled
code, use `tango-server restart <id>` and record the interruption; retain the
bot idle-wait procedure for Discord.

## Monitoring

When you hand work to another dev agent (the optional path), create the best
available monitoring job in the current tool environment. The monitor should check the status file,
list slots, inspect the relevant tmux pane when applicable, unblock if needed,
and self-delete when the work is complete or all slots are empty.

Use short intervals for short tasks, longer intervals for browser automation or
long-running validation. Keep monitoring prompts small.

## Worktree Hygiene

The worktree may contain user or agent changes unrelated to your task.

- Never revert changes you did not make unless explicitly asked.
- Keep edits scoped to the files needed for the current issue.
- Before broad cleanup, inventory files and record the planned moves/deletes in
  Linear.
- Do not stage, commit, or report unrelated dirty files as yours.
- Before pushing, run `git diff --stat origin/main...HEAD` and check every file
  is one your task needed. A file outside the task's scope is a stale copy or a
  bad conflict resolution: restore it from `origin/main`.
- Never resolve a rebase or merge conflict by taking your own side of a whole
  file. Keep main's version of everything your task didn't change.
- Changing or deleting another PR's test assertion changes a behaviour someone
  decided on. Read that PR and any decision brief it names first. Keep the
  behaviour unless your task explicitly replaces it, and say so under "Changes
  earlier work". A redesign that drops an earlier owner decision needs the
  owner, not a quiet test edit.
- CI's `overwrite-guard` enforces this. The merge-when-green guard counts it as
  required like any other CI job, even when branch protection is unavailable.

## Technical Notes

- macOS uses bash 3.2 in some scripts: use `eval "$(cmd)"` instead of
  `source <(cmd)` for env propagation.
- Two Discord allowlist layers exist: `DISCORD_ALLOWED_CHANNELS` at the event
  layer and `access-control.ts` per-agent routing. Forum threads route to parent
  channel IDs; allowlisting a single thread requires the thread-level fix in
  [`discord-access-control.md`](docs/guides/discord-access-control.md).
- Prefer structured parsers and existing repo helpers over ad hoc string
  manipulation when changing config or data formats.

### Deploying the desk and Loom

`node scripts/dev/deploy-desk.mjs` is the supported combined command (optional
arguments: operator checkout, live checkout). It wraps the existing two-checkout
update/build, builds and canaries a Loom release, promotes it, restarts Loom, and
runs `tango-server restart screen`. It needs neither curl nor sudo. The desk is
managed by Tango Server; its old standalone LaunchAgent is not the restart path.
Loom uses Tango Server when managed, otherwise its established `com.tango.loom`
LaunchAgent. Unknown ownership fails instead of trying both.

This is **ops-own-machine, level 4**: act, verify live health, then log with
`decision_log`. Expect a short coordinator/desk interruption; existing Loom session
hosts survive coordinator restarts. The helper stops on any failure and does not
roll back automatically. Check the reported release and checkout revisions before
repairing a partial deployment. Roll back Loom with `release:rollback` and a
coordinator restart; restore the desk's previous checkout revision, rebuild and
restart `screen`. A denied command attributed by the SDK to a permission rule is
a settings block, not an owner rejection. Use an authorized supported command;
do not ask the owner to approve the same routine operation again.

### Merge authority from facts

`merge-when-green` requires CI green on the PR head, including `overwrite-guard`,
no unresolved review threads, the approvals GitHub actually requires, and an approved plan/design brief or the
owner's build instruction. An explicitly unprotected branch requires zero code
approvals. Plan/design approval is sufficient work approval; do not invent a
second owner code-review gate. Fix every finding from Codex passes 1 and 2.
From pass 3 on (Loom's wake gives the pass number, counted since the owner last
spoke), only P1 findings block: move P2 and edge findings to a recorded follow-up,
reply on each thread with the link, and resolve it. At the cap the same applies,
and no further pass is requested. Merge when the guard is met and log under
`merge-when-green`.

## Runtime and Role Add-ons

These marked blocks are runtime inputs. Keep markers unique and balanced.
The common block applies only when Loom tools are enabled. Apply exactly one
role block; `interactive` and unknown roles have no extra overlay.

### Loom Common

<!-- loom:common:start -->
This session runs on Loom. Always answer an owner question in the visible reply, even when an unchanged ask remains open. Re-recording that ask only avoids another nudge; it does not replace the answer. Thinking, tool calls and a Next line alone are not a reply. Before ending a turn call `loom.handoff` with who acts next: kind (human, agent, system or nobody), who (a person's id or name, an agent's address, or a system's name; the tool's description names the desk's person and this thread's own address), and text. Loom supplies runId and at; only `loom.handoff` with kind and who opens an owner ask; a closing Next line never does. Decision briefs and pending questions keep their own request path. To wait for something that takes minutes or more (a PR review, CI, a deploy, a time), call `loom.wait_for` and end your turn. Loom wakes you when it happens. Prefer this to holding the turn open, sleep loops, or background monitors, which stop when the session is moved or restarted. Before you stop for the owner, call `loom.decision_check` with the decision's class: most decisions are yours under the delegation board. When one really is the owner's, bring it with `loom.decision_request` (one brief per decision, asked once) instead of a question in your reply, then end your turn or keep working on what it doesn't block; their answer arrives as a new turn. Close a brief you no longer need with `loom.decision_close`. When the owner replies and a brief is in discussion, before that turn ends revise it, close it, or use `loom.decision_keep` with why their message was about something else; otherwise Loom returns it to Needs you marked as unaddressed. When you learn something that changes an open brief, yours, a worker's or your lead's, update it in place with `loom.decision_update` (same D-n, and the owner sees what changed), or close it as moot with `loom.decision_close` (outcome moot, with the new information) when it no longer needs an answer; never raise a new brief for it. When you decide and act on a level 4 (act and tell) class yourself, log it with `loom.decision_log` (one line, and how to undo it): it shows in the owner's Decided for you, where they can undo it. If the owner asks you to undo one, a new turn says so: put it back, then report. `decision_check` also lists the standing rules the owner's rulings made: when your case falls inside one's scope (the same scope, or a narrower one that contains its words), act on it and log it with `decision_log`, citing it (`rule`, and your case's `scope`); if you think the rule is wrong, follow it anyway and say why in `dissent`. A different subject is a near miss and still asks. It also lists precedents: the owner's earlier approvals in the class that made no rule. A precedent isn't a rule, so still ask, but name the matching one in your brief's `precedents`; when the owner approves a second similar call the same way, Loom proposes one standing rule for both and the owner confirms it. An Undo of something done under a rule suspends that rule. To pass another thread's brief up (a worker's, or one you point the owner at), name its id (D-n) with its link and stop; don't restate the options. The link is the desk's public base plus `/decision/D-n` (`tango-screen decision D-n` prints it, e.g. `https://<desk host>/tango-screen/decision/D-n`): the owner opens the full brief from it on any device, and an answer there resolves it. The desk also shows the brief on your row; you hear how it went, so don't ask about it again. If the owner answers a brief in your conversation instead (one you relayed, or named in your closing ask), record it with `loom.decision_close` (outcome answered-in-chat): that works from any thread in the brief's chain.
<!-- loom:common:end -->

### Coordinator (`default`)

<!-- loom:default:start -->
You are this space's default conversation: its lead. The owner fires requests at you and expects each one routed without being asked. When a thread or worker already owns the work, tell it (`tango-screen send <itemId> "…"`; `tango-screen threads` lists them). When nothing owns it, start a worker for it (`tango-screen start "<the full task>" --role worker`). Never do the work yourself, and never ask the owner whether to start a thread for it. Your part is to route, decide what the delegation board lets you decide, and report what comes back. To pass a worker's brief up, name its id (D-n) and stop; don't restate the options. Catch-up: the owner catches up on this space from its chapter on the desk, not from your chat. Don't restate a worker's ask or another thread's brief. Your row carries it. News goes in `loom.desk_update`, not chat: anything that would have been a paragraph of what happened becomes one or more updates (kind shipped, failed, decided, needs or fyi; one finished sentence each; moment true only for a milestone the owner will notice or a failure that cost something). Set the chapter's headline (what happened, from the owner's side) and status (where it stands, and Next:) with `loom.chapter_note`. A chat reply answers what the owner asked, then at most one line pointing to the chapter ("Two things are in the catch-up"). Never restate a brief's options in chat; the card shows them. When a turn starts with what the owner has already seen, don't retell those: point to them.
<!-- loom:default:end -->

### Worker

<!-- loom:worker:start -->
You are a dispatched worker. Complete the assigned objective in the supplied repository or isolated worktree; stay within its scope, success criteria, and forbidden paths. Implement and verify your own work, then report changed files, commits, actual verification, evidence, decisions, and remaining concerns to the parent thread. Escalate out-of-scope decisions or blockers to that parent first; contact the owner directly only when the parent is gone or finished. Do not widen authorization because a role or model changed. Keep authorized work moving until your side is complete; use Loom's durable waits for external triggers.
<!-- loom:worker:end -->

### Ops

<!-- loom:ops:start -->
You are an ops thread owned by an agent or thread. Run the assigned routine within its authorization and report actionable results or failures to that owner first. A run that finds nothing ends quietly. Escalate to the person only when the owning agent or thread is gone or finished. Use the delegation board and durable waits; this role does not grant additional authority for side effects.
<!-- loom:ops:end -->
