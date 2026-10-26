# Tango Specs

Primary product/design specs live here so they are versioned with code.

- `tango-spec.md` is the implementation-facing working spec kept in this repo.
  boundaries, memory behavior, and privacy model.
- `agent-collaboration.md` is the design spec for bounded, observable
  agent-to-agent collaboration across named Tango agents.
- `ollama-provider-parallel-instance.md` is the design spec for a first-class
  `ollama` model provider and a parallel Ollama-backed Tango instance for live
  evaluation alongside production.
- `resilient-runtime.md` is the design for safe upgrades, recovery, resource
  leases and multi-machine runners in Loom and Tango Server.
- `decisions-and-delegation.md` is the design for which decisions agents make
  alone (the delegation board), the decision brief that reaches the person, and
  the ledger that turns rulings into standing rules.
- `loom-context-management.md` is the design for bounding Loom's per-call
  context: when a thread compacts or starts a fresh session, what carries
  across a reset, context size on the Desk, and a per-thread budget.
- `catch-up.md` is the design for catching the owner up across projects: the
  update ledger, chapters that replace Where it stands, Accept and Defer, and
  Catch me up on the desk and by voice.
- `desk-status.md` is the design for desk status built only from recorded
  facts: four owner vocabularies instead of nine, summaries that explain but
  never decide, and stages removed.
- `feed-status.md` is the follow-up to Desk Status for the Screen window's
  Feed: posts come from recorded events, an event pill beside the row's live
  status, and the header count from the one evaluator.
- `voice-turn-taking.md` is the design for one turn-taking policy on every voice
  surface (desk mics, Mac hotkey, voice operator, mobile dispatch): quick send
  that ends on a pause, and a ramble mode only a closer ends.
- `loom-fan-out.md` is the design for probes: lightweight, read-only Loom
  threads a thread fans out for parallel research, placed through the account
  pool and returned as one validated result set.
- `tango-conversations-off-discord.md` is the design for making the runtime's
  conversation store the record for Tango agents: the desk reads it, turns no
  longer need a Discord message, and Discord becomes an optional mirror.
- `loom-change-lane.md` is the design for serializing and bounding changes to
  the live system: one change lane for deploys, restarts and drains, scoped
  drains with deadlines, a release train, and cheaper builds.
- If a separate private notes system exists, treat this repo copy as the
  source of truth for code-facing work and keep it updated alongside changes.

Avoid linking this directory to machine-local note paths.

- [Desk pull requests](desk-pull-requests.md): durable PR lists and their presentation.
