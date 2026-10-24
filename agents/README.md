# Agents

Tango's agent system is a first-class part of the product. The `agents/` directory contains agent identities, shared prompt material, tool docs, and related evaluation assets.

Authoritative guide:
- [`docs/guides/agents-structure.md`](../docs/guides/agents-structure.md) — source of truth for directory layout, file roles, and add/change checklists

Current convention:

- `agents/shared/*.md`: shared prompt material
- `agents/assistants/<agent-id>/soul.md`: required identity prompt for user-facing named agents
- `agents/assistants/<agent-id>/knowledge.md`: optional assistant-specific context
- `agents/system/<agent-id>/soul.md`: internal/meta agents
- `agents/tools/*.md`: standalone callable-capability docs
- `agents/skills/*.md`: reusable workflow guidance for agent prompts
- `agents/evals/`: prompt and routing eval inputs

Runtime wiring:

- `config/v2/agents/<agent-id>.yaml` declares `system_prompt_file`, MCP servers, model/runtime settings, memory, and Discord/voice routing.
- Tango V2 assembles prompts from `soul.md`, `agents/shared/RULES.md`, `agents/shared/USER.md`, and optional `knowledge.md`. Legacy worker-dispatch prompt files have been retired and should not be created for new agents.
