# Loom Fan-out: Probes for Parallel Research

Status: **draft** (October 21, 2026). Owner chose this direction in D-344 over
a size rule alone. It builds on [Loom](../architecture/loom.md) (account pool,
role models, triggers, warmth) and leaves worker threads as they are.

## Why

A thread that wants to split read-only research (audit 200 commits, check ten
files, compare five options) has two ways to do it today, and both cost
something:

- **Harness subagents** (Claude's `Agent` tool, Codex's own subagents). They are
  cheap to start and return straight into the parent's turn. But they always
  bill to the parent's account and provider, so the owner can't move that
  usage to an account with spare room. The desk shows them only as background
  tasks on the parent's row. The "Desk UX Overwrites From Agent Merges" thread
  ran its four triage batches this way on its Claude account.
- **Loom worker threads** (`tango-screen start --role worker`). They go through
  the account pool and run on Codex by default. But each one creates a worktree
  and loads the whole instruction chain (global and repo `AGENTS.md`, the worker
  add-on, decision rules) before doing anything. Each gets a desk row, a title
  from the titler, summaries and catch-up entries. Results come back as mail,
  so the parent needs a wake for each one. Workers also have full tools and a
  role that tells them to finish and ship, so "read-only" is only a request.

A **probe** is a third kind: a Loom thread built for one bounded question. It
keeps what Loom is good at (account and provider placement, usage
accounting, durable waits, admission) and drops the parts that make sense only
for a conversation the owner supervises.

## What a probe is

A probe is a Loom thread with `kind: "probe"`, owned by the thread that
started it (`parent_thread_id`). Compared with a worker:

| | Worker thread | Probe |
|---|---|---|
| Checkout | Own worktree | Parent's cwd, read-only |
| Instructions | Global + repo `AGENTS.md`, role add-on, Loom guidance | A short probe prompt and the task. Nothing else |
| Loom tools | Yes (handoff, decisions, waits, mail) | None (`loomTools: false`) |
| Tools | Full | Read-only (see below) |
| Turns | Open-ended conversation | One task turn, plus at most one repair turn |
| Result | Prose mail to the lead | JSON that Loom validates against a schema |
| Parent wake | One per mail | One for the whole fan-out |
| Desk | Own row, title, summary, catch-up | No row. A count on the parent's row |
| Lifetime | Until settled and reclaimed | Host closes when the probe finishes. Deleted after 7 days |
| Account | Pool, role model | Pool, `probe` role model (Codex by default) |

A probe can't raise a brief, mail another thread, start threads or fan out
again. It has no Loom tools, so there is no way for it to do any of those.

## The interface

### Starting a fan-out

A new Loom tool, `fan_out`, on the same tool list that Claude and Codex
sessions already share (`claude/loom-tools.ts`, `codex/loom-mcp.ts`):

```ts
fan_out({
  items: [{ label: "batch 0", prompt: "…" }, …],  // 1–20 probes
  shared?: "…",            // context put in front of every item's prompt
  schema?: JSONSchema,     // the shape each probe's answer must have; default { answer: string }
  provider?: "codex" | "claude" | "auto",  // default: the probe role model
  tier?: string,           // a ROLE_MODELS tier, e.g. "qa"
  accounts?: string[],     // a literal allowed set, same rules as submit
  concurrency?: number,    // default 4, max 8
  deadlineMinutes?: number // default 30, max 120
}) → { fanOutId, probes: [{ label, threadId }] }
```

The parent ends its turn after calling it, the same way it does after
`wait_for`. The call registers a wait for that fan-out (new trigger kind
`fan_out`), so the parent wakes once, when every probe has finished or the
deadline passes.

`tango-screen fan-out [list]` lists the current thread’s batches, and
`tango-screen fan-out <fanOutId>` reads progress/results. `--thread` selects
another parent. Starting a batch uses the Loom tool.

### What the parent gets back

One wake run whose message lists each probe: label, status (`done`,
`invalid`, `failed`, `timed_out`), account, tokens, and its validated result.
Results are capped in the message at 4,000 characters per probe and 40,000 in
total. The full set is written to
`~/.tango/loom/fan-outs/<fanOutId>/results.json` and the message gives that
path. Since there's a single wake, the parent reads its own context once for
the whole fan-out instead of once per result. The existing settle and fold
rules still apply when other wakes are queued.

`fan_out_status({ fanOutId })` lists progress for a parent that is woken for
another reason in the meantime. `cancel_wait` on the fan-out's wait cancels
the probes that haven't finished.

## How a probe runs

### Placement and accounts

- `ROLE_MODELS` gets a `probe` entry, defaulting to `"codex"`, so probes
  follow D-51 (save Claude quota) unless a call asks for something else.
  `LOOM_ROLE_MODELS` overrides it like any other role.
- Each probe is placed through the normal pool: allowed set from the repo's
  routing policy (or the call's `accounts`), the 10% start floor, cooldowns
  and the balancing score. The scoring formula doesn't change. Probes count as
  recent placements, so a fan-out of eight spreads across accounts instead of
  piling onto the best one.
- If no account of the requested provider has room, the probe falls back the
  way workers do (Codex → Sonnet). With `provider` given explicitly, it waits
  for that provider instead of falling back.
- A probe that hits a usage limit moves like any run: same native session,
  next account. The move counts against its deadline.
- Usage is recorded per probe like any thread, and tagged with the fan-out id
  and parent thread, so the capacity view and `loom-burn` can say "fan-out
  F-12 from thread X used 310k tokens on codex-work".

### Instructions

The probe's system prompt is short and fixed:

> You are answering one bounded research question for another agent. Work
> read-only. Don't edit files, commit, push, open PRs, or contact anyone.
> Answer only with JSON matching the schema below. If you can't answer, say so
> in the JSON's fields rather than guessing.

That is followed by the schema, `shared`, and the item's prompt.

Getting rid of the instruction chain takes a setting on each harness:

- **Claude:** `settingSources: []`, so no user, project or local `CLAUDE.md`,
  and `loomTools: false`, so no Loom guidance or role add-on. This already
  works with today's `SessionProfile`.
- **Codex:** Codex reads `AGENTS.md` from the cwd and `CODEX_HOME` itself.
  The probe passes `project_doc_max_bytes = 0` on `thread/start` and resume.
  Verified on codex-cli 0.163.0: this suppresses repository `AGENTS.md`, but
  account-wide `AGENTS.md` still loads. `codex-home/src/instructions/mod.rs`
  loads it independently of the project-doc limit, even from a scratch cwd.
  The core accepts that account-wide guidance and leaves `CODEX_HOME` unchanged;
  credential and session isolation are outside this phase. Probe instructions
  go in `developerInstructions`, override reply-format instructions, and require
  JSON only, with no Next lines or handoffs. Result extraction tolerates trailing
  prose. Loom guidance and role add-ons are omitted. A live sandbox smoke test
  observed 22,750 first-turn input tokens; no matched worker baseline was measured.

### Read-only

- **Codex:** the thread starts with sandbox `read-only` instead of
  `danger-full-access`. The OS sandbox enforces it, so a probe can run `git log`
  but can't write. This is the strongest guarantee here, and one more reason
  Codex is the default.
- **Claude:** `disallowedTools` removes Edit, Write, NotebookEdit and
  MultiEdit, and the existing local-checkout edit guard stays on. Bash remains
  available because research needs it (git, grep, scripts). This is the same
  limit the edit guard documents: it doesn't inspect Bash and it isn't a
  sandbox. The probe prompt and the missing Loom tools are the rest of the
  guard. A Claude probe that must be strictly read-only should use the
  harness's own sandbox setting if Phase 1 finds it works under the Agent SDK.
- Loom's existing `side_effects` ledger records shell and MCP actions for
  probes as for any thread, so a probe that pushed or posted would show in its
  timeline.

Fan-out that edits files is out of scope. That work stays in worker threads,
which have their own worktrees and review flow.

### Results and validation

When the task turn ends, Loom reads the final assistant message, takes the
first JSON object or fenced JSON block, and validates it against `schema`.

- Valid: the probe is `done`.
- Invalid: Loom sends one repair turn ("Your answer didn't match the schema:
  <errors>. Reply with corrected JSON only."). If that also fails, the probe is
  `invalid`, and its raw text goes into the results (capped) so the parent can
  still use it.
- A harness failure that isn't a usage limit: `failed`, with the failure kind.
- Past the deadline: the turn is interrupted and the probe is `timed_out`,
  keeping any partial text.

### Lifecycle and the machine

- A probe settles when it reaches a final status, and its host closes
  straight away. The ten-minute warm floor doesn't apply, because nothing will
  resume it.
- Admission: probes count as hosts. A fan-out never opens more than its
  `concurrency` at once, and probes wait in the queue like any run when the
  machine is short of memory, disk or host slots. They never get the
  owner-message exemption.
- Stopping or deleting the parent cancels its unfinished probes.
- Retention: probe threads are deleted after `LOOM_JOB_RETENTION_DAYS` (7),
  through the same sweep that retires `tango-job` threads. `results.json`
  stays for the same period.
- No worktree is created, so there's nothing for the reclaim sweep to clean
  up.

## The desk

- Probe threads are left out of the desk's thread list the same way
  `tango-agent` and `tango-job` are (`source-loom.ts`, the thread-kind
  filter). The titler, summaries, catch-up updates and Feed posts all skip
  `probe`.
- The parent's row shows the fan-out as one background item, "4 probes ·
  2 done · codex-work, codex-personal", reusing the `background.changed`
  display that Codex and Claude subagents already use. Tapping it opens the
  results file through the artifact host.
- `GET /threads/:id` keeps working for a probe, so `tango-screen peek` can
  still open one when something looks wrong. Probes are hidden from the list,
  not made unreachable.

## When to use which

The rule lives in [AGENTS.md — Engineering Execution](../../AGENTS.md#engineering-execution):

- **Harness subagents:** small lookups feeding the current turn, or
  judgment-heavy review where a miss costs more than tokens. The review
  recommendation is provisional pending a stronger-tier probe comparison.
- **`loom.fan_out` probes:** parallel read-only research large enough to matter
  for the parent's Claude quota, or work that must not write. Set
  `provider: "codex"` for enforced read-only; Claude probes can write through
  Bash. Codex probes have no network. One wake delivers the whole set.
- **Worker threads:** anything that edits, ships, needs network or GitHub
  access, or runs longer than one bounded question.

A Codex worker can still use Codex's own subagents inside its turn. Those
already bill to the worker's Codex account, so they don't need probes.

## Phases

1. **Loom core.** `probe` kind and role model; the probe session profile
   (Claude: `settingSources: []`, `loomTools: false`, `disallowedTools`;
   Codex: read-only sandbox and project docs off, checked against the pinned
   codex-cli); `fan_out` and `fan_out_status` tools; the `fan_out` trigger;
   result validation with one repair turn; deadline, concurrency and
   cancellation; usage tagging. Tests use the fake runtime for both providers.
2. **Desk and lifecycle — implemented.** Probes hidden from the list; parent-row background
   item; titler, summary and catch-up skips; retention through the job sweep;
   `tango-screen fan-out`.
3. **Policy — implemented.** The `AGENTS.md` rule above uses the measurement
   below rather than fixed item-count or duration thresholds.

## How we'll know it works

Re-run the overwrites audit (four batches over the same commit range) both
ways and compare:

- **Startup tokens per agent.** Input tokens on each probe's first turn should
  come in well under a worker thread's. The real number is measured in Phase
  1, so this spec doesn't commit to a figure.
- **Parent turns.** One wake for the fan-out, compared with four mails for
  four workers.
- **Placement.** With two Codex accounts that have room, probes spread across
  both, and none of the usage lands on the parent's Claude account.
- **Read-only.** A Codex probe told to write a file is refused by its sandbox.
  A Claude probe can't call Edit or Write.
- **Desk.** No new rows. The parent row shows the count and links the
  results.

### Measured

The October 21, 2026 overwrites audit compared 198 commit pairs in four batches
(D-401). Codex default probes used three Codex accounts and none of the parent's
Claude account, delivered one parent wake, and created no desk rows. First-call
input was 23.4–24.4k tokens versus a 31k Codex worker median from usage history
(54 workers, not a matched re-run). Final context was 113–132k per probe versus
83–132k reported per Opus subagent; these are different harness metrics, not
summed input totals. Wall time was 143–171 seconds versus 83–168 seconds.

Opus subagents found the real regression in #951 (the missing Catch me up brief
project label, restored by #972); Codex probes flagged none. This was one run
per approach with different models and network access, so it does not isolate
the cause. A stronger-tier probe comparison is the next measurement.

Direct Codex read-only sandbox checks refused writes and allowed git reads;
network access was blocked, and probe GitHub calls failed. A Claude probe wrote
a file through Bash. Use an explicit Codex provider when read-only must hold.

## Open questions

1. Does `codex app-server` accept the project-doc override and the `read-only`
   sandbox per thread on the pinned codex-cli version? Phase 1 checks this
   first, because the fallback (scratch cwd) changes how probes see the repo.
2. Should a probe be allowed web search? Codex probes currently have no network.
   Web search is read-only and often useful.
   Proposed: yes on both harnesses, since neither counts it as a write.
3. Should probes share a prompt-cache prefix? Identical `shared` text across
   items should hit the provider's cache when the items run on the same
   account. The balancer spreading them out works against that. Proposed: let
   a fan-out prefer one account until its five-hour room drops below the
   guard, then spread.
