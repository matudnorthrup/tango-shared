# Unified Memory System — Spec

**Status:** Draft for review (2026-06-02)
**Owner:** Tango PM · design partner: Claude · implementation: Codex
**Tracking:** Linear project *Unified Memory System* (work breakdown + status live there; this doc is the durable spec)

---

## 1. Problem & goal

Tango agents lose coherence across large projects and across time. Within a live
session the model gets no fresh memory after the first turn; after a reset it is
reseeded from almost nothing; tool-heavy turns trigger silent, lossy rotations.
The atomic-fact memory we capture never reconstructs the *shape* of ongoing work
— what we were doing, what's decided, what's open.

**Goal:** agents that maintain understanding and coherence across large projects
and a long time horizon — operating like human partners with durable memory, not
agents with disappearing context.

This is less "build a memory system from scratch" and more "**wire Tango's
existing substrates into one system and fix the two points where memory fails to
reach the model**" (resumed turns; post-reset reseed). The value is in the
connectivity between layers, which is why we build in vertical slices.

---

## 2. What exists today (technical review, 2026-06-02)

Four substrates that don't yet form one system:

| Substrate | Role today | Feeds the model |
|---|---|---|
| Core store `tango.sqlite` (`packages/core/src/memory-system.ts`) | Rich: messages, ranked memories+embeddings, summaries, pinned facts, topics, `active_context_items` | per-turn warm-start `context` block |
| Atlas `~/.tango/atlas/memory.db` (`packages/atlas-memory`) | V2 surface; Voyage embeddings; post-turn Haiku extraction (~3,276 memories) | cold-start / rotation reseed |
| Obsidian vault (profile-configured) | Daily notes, job logs, nightly index -> memory DB; direct `fs` I/O | nothing directly |
| Identity files (`packages/core/src/system-prompt.ts:99`) | soul + RULES + USER + knowledge, assembled once per runtime | static system prompt |

**Findings that drive the design** (load-bearing ones verified in source):

1. **Per-turn memory is dropped on resume.** `omitContextForResumedRuntime`
   (`packages/core/src/session-lifecycle.ts:311`) strips the warm-start `context`
   once the Claude session is resumed in-process. **After turn 1, the model gets
   zero fresh memory injection.** All the ranking in `memory-system.ts` only ever
   reaches the model on a cold start. *Biggest lever.*
2. **Reseed is threadbare.** On rotation/cold-start the agent is rebuilt from
   Atlas with a hardcoded query — the literal string `"recent context"`,
   `limit 5`, scoped by `agent_id` only, **zero transcript replayed**
   (`packages/discord/src/v2-runtime.ts:96`). *This is the amnesia.*
3. **Rotation is brittle, silent, lossy.** Context % =
   `(input+output+cacheRead+cacheCreation)/window`, but `cacheReadInputTokens`
   is **session-cumulative**, not current-window-occupancy (a regression test
   shows 764K against a 200K window). The `num_turns > 1 → skip` guard makes
   rotation both false-fire and fail-to-fire. At 0.80 the runtime is torn down
   automatically with **no pre-save and no user notice**
   (`packages/core/src/session-lifecycle.ts:408`).
4. **The project-arc substrate was built and never wired.** `active_context_items`
   has a full schema + CRUD + a prompt renderer (`active_context:` zone) + tests
   and **zero production readers/writers**. The zone always renders `- none`.
5. **There is no `save`.** No `/tango save`, no instinct save, no pre-rotation
   snapshot. "Save" = async post-turn Haiku extraction of atomic facts only.
6. **Daily logs already exist and are solid.** `Planning/Daily/YYYY-MM-DD.md`
   is bootstrapped (`packages/discord/src/morning-flow.ts`), has an Interstitial
   Log, gets Discord threads appended, indexed nightly. ~70% of the time-horizon
   piece is built.
7. **Schema enforcement is after-the-fact only.** The obsidian write tool does no
   frontmatter validation; a 4:55am cron (`scripts/vault-audit.ts`) flags but
   cannot prevent infractions.
8. **Cheap-worker delegation is dormant.** `spawn_sub_agents` + a tested runner
   exist but **no v2 agent mounts the `subagents` server**. Tool-heavy turns run
   tools directly on the Opus window, so every tool result becomes cumulative
   cache-read — feeding straight back into finding 3.

**Multi-agent hazard:** text channels key the runtime by `channel/thread` (not
per-agent), so two agents in one channel force-reset each other; voice keys
per-agent and is fine (`packages/discord/src/tango-router.ts:118`).

---

## 3. Architecture — one system, five layers

```
L4  TRIGGERS & RECEIPTS   per-turn receipt (tools called, files written/loaded,
                          context%); configurable visibility; triggers:
                          threshold→save, delta→save, staleness→nudge
L3  CONTEXT CONSTRUCTION  per-turn WHISPER that survives resume (state pointer,
                          read/update/search, ctx%); rich reseed on
                          cold-start/rotation (state head + scoped memories +
                          recent transcript)
L2  CAPTURE               post-turn fact extraction (exists); STATE-FILE update
                          contract (read-before/update-after); SAVE protocol
                          (instinct + pre-rotation snapshot); write-time SCHEMA
                          validation
L1  SUBSTRATE             collaborative tier → Obsidian markdown (state files,
                          daily logs; human+AI, schema-enforced, versioned);
                          machine tier → SQLite/Atlas + embeddings (facts + the
                          INDEX mapping project→state file + summaries)
L0  GOVERNANCE            source-vs-working protection; versioning; append-only
                          guards
```

**Guiding principle:** collaborative content -> Obsidian markdown
(human+AI); AI-only content → machine-optimized (DB/embeddings). This becomes the
L1 split and gives each store a job: **markdown is canonical for narrative; the
DB is the index + fast-recall cache.**

---

## 4. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Arc scope | **Tango `project:{id}`** | A project spans threads/topics and outlives any one thread; matches existing project routing and the real master-plan→sub-project portfolio shape. Threads/topics attach to a project. |
| State-file substrate | **Hybrid: DB head + Obsidian body** | DB head is source of truth for *recall* (status, open items, pointer); Obsidian body is the human-collaborative narrative. Robust to concurrent agents and off-vault-machine operation. |
| Slice-1 proving ground | **A bounded planning project** | A low-stakes project with a real evolving arc and an existing markdown doc; a bad write costs little while the new plumbing is shaken out. |
| Governance anchor (Slice 2) | **A sensitive-operations project**, staged after the spine | Sensitive documents make source-protection + versioning non-negotiable, so they drive the governance design. No private content enters the repo spec, Linear, or agent context beyond what is operationally necessary. |

---

## 5. The state-file contract (hybrid)

A *state file* represents one project arc. It has two synchronized halves.

### 5.1 DB head — source of truth for recall (machine tier)
A small, queryable record per project. Proposed `project_state` table (new),
complemented by the existing **`active_context_items`** table (repurposed as the
granular working set: open items, decisions, entities — keyed by `project_id`).

`project_state` (proposed):
- `project_id` (PK), `title`, `status` (active|planning|waiting|deferred|evergreen|reference|closed)
- `quick_read` (short current-state summary)
- `obsidian_path` (legacy column name; stores the state body pointer), `template_id`
- `prev_session_id` (session chaining for deep recall), `lead_agent_id`
- `created_at`, `updated_at`, `last_saved_at`

### 5.2 Markdown body — canonical narrative (collaborative tier)
The human+AI markdown doc. **Extends the existing state-file frontmatter**
rather than inventing a new schema. Existing project docs already carry:
`date`, `types: [[Project Plan]]`, `areas`, `collections`, `source_kind`.

Add a minimal state-managed header:
- `project_id` (links to the DB head)
- `status` (mirrors the head)
- `state_managed: true` (marks the doc as contract-governed)
- `last_saved`

Required body anchor (minimal, not rigid): a `## Quick Read` / current-state
section and an `## Open Items` section. The rest of the body evolves freely —
honoring the workflow pattern of rough capture first, refinement later. The contract enforces the
*header + anchors*, not the whole document.

**Machine-consumed contract (as built, Slice 1).** The reseed reads, from the
linked body, exactly:
- frontmatter `status:` scalar → reseed/head status (wikilink/quotes stripped);
- the `## Quick Read` section body → the current-state summary;
- `- ` / `* ` bullets under `## Open Items` → the open-items list.
Everything else in the body is free narrative. A body missing these anchors still
works — the reseed falls back to the head's stored `quick_read`.

**Body providers (as built, Slice 1b).** The pointer is provider-neutral even
while the DB column keeps its legacy name:
- plain `Projects/Foo.md` remains an Obsidian/vault-relative body pointer;
- `profile:threads/foo.md` points at the active Tango profile;
- profile bodies are limited to markdown files under `threads/`, `collab/`,
  `specs/`, or `reference/`, with traversal, absolute paths, and symlink escapes
  rejected.

### 5.3 Sync model (as built, Slice 1)
- **Head** (`project_state`) is keyed by the runtime `conversationKey`
  (`thread:{id}` / `channel:{id}`). Mapping a Tango `project:{id}` onto this key
  is a tracked refinement (§11).
- **Whisper** (every turn) reads the head and, when a provider root is available,
  a short live body snapshot (status + Quick Read) → a pointer plus current
  summary.
- **Reseed** (cold-start / rotation) reads the head *and* the linked body live,
  so a rotated session re-orients on the current narrative (body overrides the
  head's cached `quick_read`; missing file → head fallback).
- **Per-turn save bookkeeping** stamps the head's `prev_session_id` + `updated_at`
  (session chaining), no-op unless a head exists.
- **Linking** a conversation to a body: `scripts/link-project-state.ts`
  (`--key thread:ID --path note.md ...` for legacy Obsidian, or
  `--provider profile --path threads/foo.md`). Auto-link on first agent write
  and a `/tango project link` command are tracked refinements.
- The body's frontmatter and the head cross-reference (`project_id` ↔
  state body pointer).

### 5.4 Source-vs-working protection (L0)
Key off the existing `source_kind` frontmatter. Proposed policy:
`source_kind: canonical|source|reference` → **read-only to agents** unless an
explicit edit is requested and confirmed; `working|draft` → freely editable.
Enforced at write time (see §9). This satisfies "source data never gets touched."

### 5.5 Templates & repeatable processes
`template_id` selects the body skeleton and the head's expected fields. Templates
can be project-type-specific (trip plan, employee onboarding, legal matter) and
can carry an ordered checklist that the head tracks as progress. Templates evolve
over time and differ per user/agent/use-case.

---

## 6. The whisper (per-turn surviving injection) — L3

The single channel that already survives resume is `current_turn_metadata`
(date/time only; `SendOptions.currentTurnMetadataPrompt`, preserved by
`omitContextForResumedRuntime`). Generalize it into a **turn briefing**.

- Implementation: add `SendOptions.turnBriefingPrompt` (sibling field). Append it
  in `ClaudeCodeAdapter.buildPrompt`. It is preserved on resume because the strip
  logic only removes `context`.
- v1 contents: state-file pointer (body pointer + project + status);
  "read before responding, update after"; "search first"; context %; threshold
  and delta signals when boundaries are crossed.
- Visibility: **silent to the user by default** (like Sage's whisper). A subset is
  surfaceable via a `/tango context`-style command and an opt-in verbose mode.
  Configurable per the receipt design (§8).

---

## 7. Rich reseed (cold-start / rotation) — L3

Replace the `"recent context"` stub (`packages/discord/src/v2-runtime.ts:96`).
On cold-start and after rotation, build context from:
1. the **project state head** (status, quick_read, open items),
2. **project/thread-scoped** memories (not just `agent_id`-scoped) — query with
   the actual recent message text, not a literal string,
3. the **last N transcript messages** for the thread (currently hardcoded empty).

**Done = after a rotation, the agent knows where the project stands.**

---

## 8. Save protocol — L2

- **Instinct/explicit save:** write narrative to the body + refresh the DB head.
  No slash command required (word-trigger recognized), silent confirmation.
- **Pre-rotation snapshot:** couple save to `recreateRuntime`
  (`packages/core/src/session-lifecycle.ts:547`) — flush a state update *before*
  teardown so an 80% rotation is never amnesia.
- **Session chaining:** write the current session id to `prev_session_id` on save
  (enables deep recall of the prior raw transcript, analogous to Sage's
  `prevSessionId`).

---

## 9. Triggers, receipt, schema enforcement — L4 / L0

- **Reliable meter first (prerequisite).** Derive a true current-window-occupancy
  metric (investigate provider raw via `TANGO_CAPTURE_PROVIDER_RAW`); stop
  dividing a session-cumulative counter by the window. Without this, every
  trigger built on context % is unreliable.
- **Receipt:** per-turn metadata — tools called, files written (with paths),
  files/skills loaded into context, context %. Configurable visibility
  (precedent: `voice-turn-receipts`). Provides trust and transparency.
- **Triggers:** context threshold → save; large delta → save; staleness → nudge.
- **Write-time schema validation:** the obsidian write tool validates frontmatter
  against the `_Schema/` catalog *before* writing and returns actionable errors so
  the agent self-corrects (replaces reliance on the 4:55am `vault-audit.ts` cron).
- **Versioning:** version history for working docs in sensitive drafting use cases
  — keep prior versions retrievable; never silently overwrite a working draft.

---

## 10. Vertical slices

Each slice is a thin end-to-end increment that touches multiple layers, then
widens. "Done" requires live testing end-to-end (not unit tests alone).

### Slice 0 — De-risk the plumbing  *(prerequisite)*
- **Scope:** (a) reliable window-occupancy meter; (b) open the surviving whisper
  channel (`turnBriefingPrompt`).
- **Acceptance:** context % reflects true window occupancy within tolerance on a
  scripted multi-turn + tool-heavy session; no surprise rotations; a test string
  injected via the whisper reaches the model on turn N>1 (proven by a probe).

### Slice 1 — The spine (one project arc, end-to-end)
- **Scope:** `project_state` head + body contract (extend frontmatter) ↔
  `active_context_items` working set ↔ whisper pointer ↔ rich reseed reads it ↔
  save updates it. Anchor: a bounded trip-planning doc.
- **Acceptance (live, the user's vault):** start a trip-planning thread → make
  decisions → force a rotation → the agent resumes knowing the trip's current
  state, open decisions, and where the doc lives, and updates the doc on save.

### Slice 2 — Governance, anchored on a sensitive ops project
- **Scope:** source-vs-working protection (`source_kind`); versioning of working
  docs; write-time schema validation; a sensitive-matter template + state file.
  Repeatable-process templates (e.g. onboarding) generalize from here.
- **Privacy:** validated on the user's private vault; the spec and Linear reference
  the matter abstractly; no sensitive content enters repo/Linear or agent context
  beyond what is operationally necessary.
- **Acceptance (live, the user's vault):** a write to a `source_kind: canonical`
  filing is refused with a clear reason; a working draft is revised with
  retrievable version history; a schema-violating write is rejected with a fix
  hint; Victor answers "what's outstanding / latest draft" after a rotation.
  (Detailed issues 2.1–2.5 below.)

### Slice 3 — Time horizon
- **Scope:** harden daily-log reliability; make "what day did I…" searchable over
  daily logs + state files.
- **Acceptance:** a date-scoped recall question returns the correct day's work.

### Slice 4 — Transparency & triggers
- **Scope:** visible receipt (opt-in) + threshold→auto-save-before-rotation.
- **Acceptance:** crossing the threshold writes a save and notifies per config;
  receipt shows tools/files/context for a turn.

### Slice 5 — Context cost
- **Scope:** route tool-heavy structured tasks through the (dormant) sub-agent
  runner so I/O stays off the main window; return compact summaries.
- **Acceptance:** a tool-heavy turn no longer inflates main-window occupancy
  beyond the summary.

**Widening:** after Slice 1, widen to more agents (Watson/PM), more templates,
more triggers — rather than building layer-by-layer.

---

## 11. Open questions & risks

- **DB head shape:** dedicated `project_state` table vs a distinguished
  `active_context_items` row (`kind: state`). Lean toward a dedicated table for
  clarity; confirm in Discovery.
- **Two stores → one:** which of core-store vs Atlas owns the machine tier
  long-term, and the migration/retirement path. Today the per-turn `context`
  reads core-store; the reseed reads Atlas. The redesign must reconcile.
- **`source_kind` values in the vault:** inventory actual values before wiring
  source-protection policy.
- **Multi-agent text-channel reset hazard:** decide whether to make text runtime
  keys per-agent (like voice) as part of this work or track separately.
- **Off-vault operation:** if the bot runs on a different machine than the vault,
  the body sync needs a transport; the DB head keeps recall working regardless.
- **Meter ground truth:** requires a live provider-raw capture to characterize
  what the Claude CLI emits across turn types.

---

## 12. Linear mapping (seed for the project)

- **Project:** Unified Memory System (Example HQ → Tango team).
- **Milestones = slices:** Slice 0 … Slice 5 (each is a ship-able increment with
  its own validation). A Discovery issue captures this review + the §11 questions.
- **Per-slice issues:** carry the §10 acceptance criteria as the validation gate;
  live-test evidence attached before Done.

---

## 13. Operator profile decisions (2026-06-27)

These live in **`~/.tango/profiles/<profile>/`** (not repo). Profile-local
handoffs and installation-specific notes stay outside tracked files.

| Topic | Location |
| --- | --- |
| Fleet save (Atlas + thread + daily log) | Repo template `agents/skills/session-save.md`; operator overlay in profile |
| Fast breakage checks | Profile-local handoff notes |
| Cod-E canary thread shape | Profile-local handoff notes |

**Updates to findings above:**

- **`/tango save`** exists on Discord v2 (`session-ops.ts`); fleet policy in profile skill.
- **Fleet daily log (new):** `profile/memory/YYYY-MM-DD.md` — complements Obsidian `Planning/Daily/` and Atlas; channel-stamped append, all agents.
- **`memory_add` provenance:** TangoRouter injects conversation/channel/thread,
  turn/message, event-time, and human context fields into the atlas-memory MCP
  environment (`discord-memory-provenance.ts`).
- **Profile thread write guard (Phase 1b, 2026-06-27):** `profile-state-write-guard.ts` blocks full-file `write` on existing `profile/threads/**/*.md` (create-on-missing allowed), rejects empty content and missing frozen anchors on governed files; Claude Code `Write|Edit` guarded via PreToolUse hook (`scripts/claude/profile-state-pretooluse-hook.mjs`) wired in `ClaudeCodeAdapter`.
- **Validation:** deterministic health script (30–60m) for breakages; Marion weekly for learnings only.

## 14. Model-visible origin context (2026-07-20)

Relevance retrieval deliberately brings prior experience into current work, but
retrieved memory must never look like evidence found in the current source.
Every automatic retrieval surface therefore presents a compact boundary and
safe origin label:

```text
retrieved_memories:
note=Prior memories are context, not evidence from the current source. Attribute or verify them before presenting them as current-source findings.
- [Prior memory · 2026-07-12 · shared-knowledge review · conversation] ...
```

Atlas stores origin context additively in JSON metadata, so no table migration
is required:

```yaml
origin:
  version: 1
  kind: conversation # conversation|document|reflection|manual|observation|import
  occurred_at: 2026-07-12T09:00:00.000Z
  captured_at: 2026-07-12T09:00:03.000Z
  context_label: shared-knowledge review
  context_ref: topic:shared-knowledge # internal; never rendered
  source_ref: obsidian:<path>#<chunk> # internal; never rendered
```

The display resolver prefers the versioned envelope, then legacy topic/project
or document-title metadata, then a generic source label. It never renders local
paths, conversation/session keys, Discord IDs, turn/message IDs, UUIDs, or raw
source references. Old rows degrade to date plus source; new Discord writes
automatically capture the human context label, turn/message provenance, and
event time. `created_at` retains its existing mixed semantics, so the display
uses `origin.occurred_at` when available rather than calling every timestamp the
time a fact occurred.
