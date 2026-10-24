# Agent Structure

Source of truth for Tango's V2 agent-system layout, prompt file roles, and where new assistants, tools, and skills should live.

## Directory Layout

```text
agents/
  shared/
    AGENTS.md
    RULES.md
    USER.md
  assistants/
    <assistant-id>/
      soul.md
      knowledge.md   # optional
  system/
    <system-id>/
      soul.md
  tools/
    *.md
  skills/
    *.md
  evals/
```

Related runtime config lives in:

```text
config/
  defaults/
    agents/
      *.yaml
    schedules/
      *.yaml
    sessions/
      *.yaml
    projects/
      *.yaml
```

## Agent Types

- `assistants/`: user-facing named agents such as Watson, Sierra, Malibu, and Victor
- `system/`: internal or meta agents (none ship today; the system identity lives in `config/defaults/system.yaml` and is not an agent)
- `tools/`: callable-capability docs
- `skills/`: reusable workflow guidance that can be copied or referenced from agent prompts
- `shared/`: prompt material loaded for every assembled agent prompt
- `evals/`: prompt snapshots and evaluation fixtures

## File Roles

### `soul.md`

Use for identity, behavior, boundaries, and output expectations.

Put here:
- who the agent is
- how the agent should behave
- what the agent should return

Do not put here:
- detailed tool schemas
- reusable domain workflows that belong to `agents/skills/`
- assistant-specific facts that belong to `knowledge.md`

### `knowledge.md`

Assistant-specific context only. This file belongs under `agents/assistants/<id>/`.

Put here:
- account names
- local preferences
- domain ownership notes
- project facts that are specific to that assistant

Do not put here:
- generic tool usage docs
- reusable workflow patterns needed by multiple agents or tools

### Retired `workers.md`

`workers.md` was the old dispatch roster for the worker-agent architecture.
V2 system prompt assembly does not load it, and repo assistant `workers.md`
files have been removed. New work should give the assistant direct MCP access
and put any needed operating guidance in `soul.md`, `knowledge.md`, or a
focused skill doc.

### `agents/tools/*.md`

Callable surface area only.

Put here:
- what the tool does
- input fields and parameter rules
- output shape
- hard constraints and caveats required to call it correctly
- short examples

Do not put here:
- general workflow playbooks
- cross-tool heuristics
- long domain policies

### `agents/skills/*.md`

Reusable workflow guidance shared across tasks or agents.

Put here:
- formatting conventions
- interpretation guidance
- cross-tool heuristics
- decision rules for recurring task types

Do not put here:
- assistant-specific facts
- raw API/schema reference

## Placement Rules

Use these rules when deciding where something belongs:

- If it describes a callable interface, put it in `agents/tools/`
- If it describes how to do a recurring task well, put it in `agents/skills/`
- If it is specific to one assistant's world model, put it in that assistant's `knowledge.md`
- If it defines identity or response style, put it in `soul.md`
- If it teaches an assistant how to use its direct tools, put it in `knowledge.md` or a skill doc.

Examples:

- Recipe markdown conventions: `agents/skills/recipe-format.md`
- `recipe_write` input/output details: `agents/tools/recipe.md`
- Watson's email accounts: `agents/assistants/watson/knowledge.md`
- Watson's reimbursement workflow: `agents/skills/expense-reimbursements.md`

## Prompt Assembly

V2 system prompt assembly is convention-based and currently loads, in order:

1. `<agentDir>/soul.md`
2. `RULES.md` — profile shared (`prompts/shared/` or legacy `agents/shared/`), then repo `agents/shared/`, then optional per-agent additions under `<agentDir>/RULES.md`
3. `USER.md` — per-agent override, then profile shared, then repo `agents/shared/`
4. `<agentDir>/knowledge.md`
5. Profile prompt overlays from `~/.tango/profiles/<profile>/prompts/agents/<id>/`

Runtime implementation:
- `packages/core/src/system-prompt.ts`
- `packages/core/src/config.ts`

Do not keep user-specific per-agent `USER.md` files under `agents/assistants/`,
even as ignored symlinks. Use `npm run cli -- prompt audit` to find legacy
repo-path personal prompt files, then migrate them into
`~/.tango/profiles/<profile>/prompts/agents/<id>/`.

## Config Ownership

Prompt assets live with the agents. Runtime configuration stays centralized under `config/`.

### `config/v2/agents/*.yaml`

Use for assistant runtime wiring:
- `enabled: false` for committed templates or private agents that should parse but not load into runtime/routing by default
- runtime mode/model/fallback
- MCP servers and tool allowlists
- Discord/voice routing
- memory settings
- system prompt file
- legacy registry fields consumed by current routing/presentation code

V2 agent config is the source of truth for assistants. Current registry
consumers still receive an `AgentConfig` shape, but it is generated from v2 at
boot.

Disabled V2 agents are kept as templates only: they are excluded from the V2
runtime map, the legacy agent registry bridge, voice runtime loading, routing,
access reports, and capability reports. A profile can intentionally opt in by
adding a matching `~/.tango/profiles/<profile>/config/v2/agents/<id>.yaml`
override with `enabled: true`.

### `config/defaults/agents/dispatch.yaml`

Use only for legacy-only system agents that do not have a v2 runtime yet.
Today that means `dispatch`. Do not add new assistant configs here.

## Adding a New Assistant

1. Create `agents/assistants/<id>/soul.md`
2. Add `knowledge.md` if the assistant needs assistant-specific facts
3. Add `config/v2/agents/<id>.yaml` with `enabled: true` or omit `enabled`, plus `system_prompt_file`, MCP servers, voice/Discord routing, provider, tools, and response metadata
4. Add or update any session routing in `config/defaults/sessions/*.yaml`
5. Add governance principal and permissions for any tools it can call

## Adding a New System Agent

1. Create `agents/system/<id>/soul.md`
2. Add `config/defaults/agents/<id>.yaml` with `prompt_file` only if the agent is legacy-only and has no v2 runtime
3. Update the calling code or routing config that invokes it

System agents usually do not need `knowledge.md` unless the runtime grows to support those patterns intentionally.

## Adding a New Skill

1. Create `agents/skills/<doc-name>.md`
2. Keep it short, reusable, and focused on workflow or judgment
3. Reference or copy the relevant guidance from the assistant prompt that needs it
4. Update `agents/skills/README.md`

## Adding a New Tool

Use [adding-tools.md](./adding-tools.md).

When a new tool also needs reusable operating guidance:
- keep the callable schema in `agents/tools/*.md`
- put the workflow guidance in `agents/skills/*.md`

## Index Files To Keep Current

Update these when the structure changes:

- `agents/README.md`
- `agents/tools/README.md`
- `agents/skills/README.md`
- `README.md` if the repo layout or onboarding guidance changed
- `AGENTS.md` (the shared instruction source; keep vendor and legacy pointers thin) if
  implementation or agent-operating conventions changed

## Anti-Patterns

- Putting reusable workflow logic into tool docs
- Burying assistant-specific preferences inside shared skill docs
- Putting worker dispatch instructions into `knowledge.md`
- Creating new `workers.md` files for V2 agents
- Adding a new tool without adding it to the V2 agent's MCP allowlist
- Creating prompt assets outside `agents/` without a deliberate runtime reason
