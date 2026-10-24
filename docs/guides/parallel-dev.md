# Parallel Development Workflow

Run multiple Tango feature branches simultaneously using git worktrees with isolated profiles, shared Discord bot queueing, and per-agent test threads.

## Quick start

```bash
# Spawn a dev slot with Claude Code
scripts/dev/spawn.sh feature/my-thing --agent claude-code

# Spawn with Codex
scripts/dev/spawn.sh fix/bug-123 --agent codex

# See all active slots
scripts/dev/list.sh
```

## Concepts

### Slots

Three numbered slots (1, 2, 3) are available. Each slot provides:

- **Git worktree** at `~/GitHub/tango-worktrees/wt-{N}/<branch>`
- **Isolated profile** at `~/.tango/profiles/wt-{N}/` (own SQLite DB, cache, config, logs)
- **tmux session** `dev-wt-{N}` for the developer agent
- **`.env.slot` overlay** that sets `TANGO_PROFILE=wt-{N}` so all runtime paths resolve to the slot's profile

Profile isolation is handled by `packages/core/src/runtime-paths.ts` — setting `TANGO_PROFILE` routes all state resolution to the slot's profile directory. The main profile at `~/.tango/profiles/default/` is never touched.

### Bot claiming

Only one Discord bot process can run at a time (Discord gateway limitation). A shared lock at `~/.tango/slots/bot.lock.d/` manages access:

- **Claim**: stops main's `tango:discord`, starts the slot's bot in `tango-wt-{N}:discord`
- **Release**: stops the slot bot, restarts main
- **Queue**: if another slot holds the bot, `claim-bot.sh` waits (with timeout) until it's free
- **Auto-release**: a background watcher releases the bot after 5 minutes (configurable)

While claimed, the slot bot:
1. Creates a fresh public thread in each agent's smoke test channel
2. Sets `DISCORD_ALLOWED_CHANNELS` to only those thread IDs (silently drops all other traffic)
3. Sets the bot's guild nickname to `Tango [wt-{N}]`
4. Responds only in its own test threads via the normal Tango pipeline

Main Tango is offline during a claim (~30-60 seconds per cycle).

## Commands

### `scripts/dev/spawn.sh`

```
scripts/dev/spawn.sh <branch-name> [--slot N] [--agent codex|claude-code] [--from REF]
```

Creates a fully-configured dev slot:
1. Claims the lowest free slot (or `--slot N` to pick one)
2. Creates a git worktree from `--from` (default: current branch chain tip)
3. Seeds the slot profile config from `~/.tango/profiles/default/config/`
4. Symlinks `.env` and generates `.env.slot`
5. Runs `npm install` and `npm run build`
6. Creates a `dev-wt-{N}` tmux session
7. Optionally launches the agent CLI with full-access flags
8. Writes a `CLAUDE.md.slot` with slot-specific instructions

Agent launch flags:
- **Codex**: `codex --model gpt-5.4 --dangerously-bypass-approvals-and-sandbox`
- **Claude Code**: `claude --dangerously-skip-permissions --model claude-opus-4-8 --effort max`

### `scripts/dev/list.sh`

```
scripts/dev/list.sh
```

Shows all 3 slots:

```
SLOT STATUS   BRANCH              AGENT        WORKTREE                                    BOT
1    active   feature/my-thing    codex        ~/GitHub/tango-worktrees/wt-1/feature/...   not claimed
2    empty    -                   -            -                                           -
3    active   fix/bug-123         claude-code  ~/GitHub/tango-worktrees/wt-3/fix/...       claimed (5m)
```

### `scripts/dev/claim-bot.sh`

```
scripts/dev/claim-bot.sh <slot> [--live] [--no-timer] [--no-wait]
```

Claims the shared Discord bot for live testing. **Default is dry-run** — prints what would happen without executing. Pass `--live` to actually swap.

- `--no-timer`: disable the 5-minute auto-release (for long debug sessions)
- `--no-wait`: fail immediately if the bot is held by another slot (instead of waiting)
- `TANGO_SLOT_MAX_HOLD_SEC=N`: override auto-release duration (default 300)

Must be run from inside a worktree that has a `.env.slot` file.

### `scripts/dev/release-bot.sh`

```
scripts/dev/release-bot.sh <slot> [--live]
```

Releases the bot back to main. Kills the auto-release watcher if one is running.

### `scripts/dev/release-worktree.sh`

```
scripts/dev/release-worktree.sh <slot> [--keep-branch] [--keep-profile]
```

Tears down a slot:
1. Releases the bot if this slot holds it
2. Kills tmux sessions (`dev-wt-{N}` and `tango-wt-{N}`)
3. Removes the git worktree
4. Deletes the local branch (unless `--keep-branch`)
5. Prompts to remove the profile (unless `--keep-profile`)

### `scripts/dev/bot-lock.sh`

```
scripts/dev/bot-lock.sh status              # who holds the bot?
scripts/dev/bot-lock.sh acquire <slot>      # claim the lock
scripts/dev/bot-lock.sh release <slot>      # release the lock
scripts/dev/bot-lock.sh force-break         # emergency release
scripts/dev/bot-lock.sh history [--tail N]  # claim/release history
scripts/dev/bot-lock.sh --self-test         # verify lock mechanics
```

### Other utilities

```
scripts/dev/slot-env.sh <slot>              # print .env.slot overlay to stdout
scripts/dev/verify-slot-isolation.sh <slot> # verify DB isolation for a slot
```

## Typical workflow

### 1. Start a feature

```bash
scripts/dev/spawn.sh feature/new-wellness-tool --agent claude-code
```

### 2. Work on the feature

Attach to the developer session:

```bash
tmux attach -t dev-wt-1
```

The agent has its own isolated database, config, and code checkout. Run unit tests, write code, iterate — all without affecting main.

### 3. Live Discord test

From inside the worktree:

```bash
scripts/dev/claim-bot.sh 1 --live
```

The bot creates test threads in each agent's smoke test channel and prints their URLs. Post messages in those threads to test your changes. The bot responds only there — all other Discord traffic is silently dropped.

Release when done:

```bash
scripts/dev/release-bot.sh 1 --live
```

### 4. Clean up

```bash
scripts/dev/release-worktree.sh 1
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `TANGO_SLOT_MAX_HOLD_SEC` | `300` | Auto-release timer duration in seconds |
| `TANGO_BOT_NICKNAME` | (none) | Bot nickname to reset to in prod mode |
| `DISCORD_ALLOWED_CHANNELS_OVERRIDE` | (none) | Debug: bypass slot-mode thread creation, use this channel ID directly |
| `TANGO_BOT_LOCK_PATH` | `~/.tango/slots/bot.lock.d` | Override lock directory (for testing) |
| `TANGO_BOT_HISTORY_PATH` | `~/.tango/slots/history.log` | Override history log path (for testing) |

## Caveats

- **Test harness concurrency**: `scripts/dev/test-message.sh` creates a new Discord client per invocation. Do not run multiple instances concurrently against the same bot token — Discord gateway rate-limits parallel logins, causing timeouts. Serialize test harness calls or use separate bot tokens.

## Architecture notes

- **Profile isolation**: `TANGO_PROFILE=wt-{N}` triggers `hasExplicitProfileRuntimeSelection()` in `packages/core/src/runtime-paths.ts`, routing all DB/cache/config/log resolution to `~/.tango/profiles/wt-{N}/`
- **Two-layer allowlist**: Phase 2a's `DISCORD_ALLOWED_CHANNELS` guards `messageCreate` at the event level (thread IDs). Tango's per-agent `access-control.ts` guards at the routing level using parent channel IDs via `resolveRoutingChannelId`, **plus** optional `threadChannelId` for forum-thread allowlists. See [`discord-access-control.md`](./discord-access-control.md). Slot mode injects parent channels into the default allowlist.
- **Thread auto-archive**: slot test threads use Discord's 60-minute auto-archive, so no explicit cleanup is needed
- **Singleton services**: the voice operator and OwnTracks stay on main. Dev slots don't run these. Operator-touching branches can use the offline lab and playground (`apps/tango-voice/src/testing/live-operator-{lab,playground}.ts`) before a main-checkout test.
- **macOS bash 3.2**: all shell scripts use `eval "$(cmd)"` instead of `source <(cmd)` for env propagation (process substitution doesn't export vars in bash 3.2)
