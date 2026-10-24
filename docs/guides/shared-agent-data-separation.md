# Shared Agent Data Separation

This note is for operators who want to use Tango for both personal work and
shared team work without personal context leaking into team agents.

## Recommendation

Start with separate agents and separate operating surfaces. Do not start with
field-level visibility unless the same entity directory must intentionally serve
both personal and team agents.

The practical default is:

- one personal agent for private life and personal workflows
- one team agent for shared operations work
- separate Discord channels for each
- separate Obsidian folders or vaults for each
- separate tool credentials or tool grants where the team agent should not see
  personal accounts
- separate memory scope for each agent

This solves the main problem: the team agent should not normally retrieve or
write memories belonging to the personal agent.

## What Agent Memory Scope Means

Atlas memory records are scoped by `agent_id`. Tango also supports a canonical
memory scope with aliases, so a classic agent and an Ollama clone can share the
same memory intentionally. For example, `sierra` and `sierra-ollama` can both
read and write as the same user-facing Sierra memory scope.

For a personal/team split, the important rule is the opposite: do not alias the
personal agent and the team agent together. Give them separate canonical memory
scopes, such as:

- `operator-personal`
- `team-ops`

That keeps ordinary Atlas recall separate.

## What A Tango Profile Means

A Tango profile is an existing runtime namespace under:

```text
~/.tango/profiles/<profile>/
```

Profiles can have their own config, prompts, data, logs, cache, and runtime
database. Running Tango with a different profile looks like:

```bash
TANGO_PROFILE=team-ops
```

When `TANGO_PROFILE` is set, Tango's core runtime database resolves under that
profile, for example:

```text
~/.tango/profiles/team-ops/data/tango.sqlite
```

So yes: the stronger profile-based option means creating a different runtime
database for the team profile.

## Atlas Database Detail

One nuance matters: Atlas memory currently has its own database path. By
default, it resolves to:

```text
~/.tango/atlas/memory.db
```

That path is not automatically inside `~/.tango/profiles/<profile>/data/`.

For stronger separation, set a different `ATLAS_MEMORY_DB` for the team profile,
for example:

```bash
TANGO_PROFILE=team-ops \
ATLAS_MEMORY_DB=~/.tango/profiles/team-ops/data/atlas-memory.db
```

With that setup, the team profile has both:

- its own Tango runtime database: `tango.sqlite`
- its own Atlas memory database: `atlas-memory.db`

That is a stronger boundary than agent scoping alone.

## Separation Levels

### Level 1: Separate Agent

Use this when the goal is normal context hygiene.

The personal agent and team agent run in the same Tango installation, but they
use different agent IDs, different memory scopes, different Discord channels,
and different tool grants.

This is usually enough if the concern is accidental recall.

### Level 2: Separate Profile And Databases

Use this when team usage should be isolated from personal runtime state.

The team agent runs with its own `TANGO_PROFILE`, own `tango.sqlite`, own
`ATLAS_MEMORY_DB`, own Obsidian root or folder, own prompt overlays, own tool
credentials, and own Discord routing.

This is the better option when multiple team members will use the shared agent
and personal data should not be reachable through the team runtime.

### Level 3: Field-Level Entity Visibility

Use this only when personal and team agents intentionally share the same entity
directory or memory corpus, but different agents should see different parts of
the same record.

Example:

- the team agent may know a private healthcare-related task exists
- the team agent should route it to the health agent
- the team agent should not see the provider name, phone number, or details

This requires more than a simple tag. Retrieval, warm-start context, summaries,
embeddings, exports, and tool responses must all apply the same visibility
policy. Build this only when shared records are a real requirement.

## Suggested Architecture

For a user who has both personal Tango use and team operations use:

1. Create a team-facing agent, such as `team-ops`.
2. Give it its own canonical memory scope.
3. Do not alias it to the personal agent's memory scope.
4. Route it only in team Discord channels.
5. Point it at team Obsidian folders or a team vault.
6. Give it only team-safe tool credentials and permissions.
7. If stronger separation is desired, run it under a separate `TANGO_PROFILE`
   and set `ATLAS_MEMORY_DB` inside that profile's data directory.

Do not build field-level entity visibility first. Treat it as a later feature
for intentionally shared directories, not the primary privacy boundary.

## Bottom Line

Separate agents solve ordinary separation. Separate profiles plus separate
databases solve stronger runtime isolation. Field-level visibility is useful
only when the same underlying records must be shared with partial redaction.
