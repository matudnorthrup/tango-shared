# Tango

Tango is a personal AI runtime: named agents with their own prompts, tools and
schedules, reachable from Discord text, Discord voice, a web desk and a macOS
menu bar app, all driven from shared configuration and durable local state.

This repository is a shared copy of a private working repo. It is refreshed
from upstream from time to time, so fork it and keep your changes on your own
branch or fork rather than expecting pull requests to flow back.

## What is in here

| Path | What it is |
|---|---|
| `packages/core` | Config loading, storage (SQLite), scheduling, prompt assembly, model providers, governance |
| `packages/discord` | The Discord runtime: routing, tool surfaces and MCP servers for the agents |
| `packages/system` | Machine-level services: health checks, process supervision |
| `packages/server` | Tango Server, the local control plane the apps talk to |
| `packages/loom` | Loom, the runner for long-lived coding-agent threads (Claude Code and Codex) in their own git worktrees |
| `packages/voice`, `apps/tango-voice` | The voice operator: a realtime voice assistant in Discord voice channels that hands work to agents |
| `apps/screen` | The web desk: threads, decisions, screens and prototypes from agents, served on your tailnet |
| `apps/tango-app`, `apps/tango-ios` | Native macOS menu bar and iPhone clients (Swift) |
| `packages/atlas-memory` | Long-term memory store and search |
| `packages/cli` | Operator CLI: `tango paths`, `tango doctor`, `tango config trace` |
| `agents/` | Agent prompts (`assistants/*/soul.md`), shared rules, skills and tool docs |
| `config/defaults` | Default config; your own lives in a profile outside the repo (below) |
| `docs/` | Architecture, guides and specs |

## Repo vs profile

Nothing about you belongs in the repo. Tango loads repo defaults first, then
your profile on top:

- Profile config and prompts: `~/.tango/profiles/<profile>/config` and `prompts/`
- Runtime data, caches and logs: `~/.tango/profiles/<profile>/data`, `cache`, `logs`
- Secrets: `.env` (copied from `.env.example`, never committed)

See [`docs/guides/profile-model.md`](./docs/guides/profile-model.md).

## Quick start

Requires Node 24 (`.nvmrc`) and macOS; Loom's worktree management relies on APFS, so the test suite does not pass on Linux. The Swift apps need Xcode.

```bash
nvm use
npm install
cp .env.example .env          # fill in what you need; most keys are optional
npm run build
npm test
npm run cli -- init           # create your profile under ~/.tango/profiles/default
npm run cli -- doctor         # check paths and repo/profile separation
```

To run the Discord runtime you need a Discord bot token in `.env` and at least
one agent wired to a channel in your profile config:

```bash
npm run dev:discord
```

More:

- Setup: [`docs/guides/setup.md`](./docs/guides/setup.md)
- Voice operator: [`docs/guides/voice-operator.md`](./docs/guides/voice-operator.md)
- Loom (coding-agent threads): [`docs/architecture/loom.md`](./docs/architecture/loom.md)
- Adding tools: [`docs/guides/adding-tools.md`](./docs/guides/adding-tools.md)
- Docs index: [`docs/README.md`](./docs/README.md)

## Notes

- Several integrations (email, calendar, finance, nutrition, Slack, Notion,
  Todoist and others) need your own accounts and API keys. Agents whose tools
  you have not configured simply lack those tools.
- `AGENTS.md` is the instruction file the coding agents follow when working on
  this repo. It describes the upstream owner's workflow; adapt it to yours.
- Some apps from the upstream repo are not included, and the assistants'
  personas, skills and eval fixtures here are generic examples.

## License

Apache-2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
