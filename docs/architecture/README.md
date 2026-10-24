# Architecture

Current architecture references live here. These docs describe the system as it
is intended to operate now, not project status or implementation history.

- [`runtime-v2.md`](./runtime-v2.md) - current agent runtime, router, prompt,
  memory, and scheduler architecture
- [`loom.md`](./loom.md) - session backend: long-lived Claude and Codex
  sessions with an account pool, behind the Agent Desk
- [`deterministic-vs-ai-boundaries.md`](./deterministic-vs-ai-boundaries.md) -
  guidance for deciding what belongs in code versus model reasoning

Historical project plans, validation logs, and cleanup records belong in
[`../retros/`](../retros/) or Linear.
