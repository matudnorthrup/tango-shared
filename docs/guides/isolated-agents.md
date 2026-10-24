# Isolated Agents

Isolated agents serve someone other than the owner, such as a child in the
family. They run inside the owner's Tango installation but must never see or act
on the owner's data. Set `isolated: true` in the agent's v2 YAML.

The repo ships four isolated agents, all disabled until a profile overlay
enables them:

| Agent | Role | Tools |
| --- | --- | --- |
| `kilo` | Kid spending buckets | `kilo_ledger` |
| `echo` | Quick answers | `exa_search`, `exa_answer`, `safety_alert` |
| `delta` | Research | `exa_*`, `youtube_*`, `safety_alert`, own memory |
| `oscar` | Someone to talk to | `safety_alert`, own memory |

## What `isolated: true` changes

Owner agents share a lot by design: one Atlas memory database, a shared pool of
`agent_id IS NULL` rows (the Obsidian mirror), global pinned facts, typed state,
and a Claude Code runtime with every built-in tool and the owner's
`~/.claude` context. Isolation closes each of those paths.

| Path | Owner agent | Isolated agent |
| --- | --- | --- |
| Claude built-in tools (Bash, Read, WebFetch, …) | all | none (`--tools ""`) |
| `~/.claude` CLAUDE.md, auto-memory, user/project settings, user MCP servers | loaded | skipped (`--setting-sources ""`, `--strict-mcp-config`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`) |
| Working directory | repo checkout (holds `.env`) | empty per-agent sandbox under the OS temp dir |
| Atlas `memory_search` with another agent's id | allowed | ignored, pinned to own scope |
| Atlas `memory_admin`, `pinned_fact_*` | available | hidden and rejected |
| Shared memories and global pinned facts in warm/cold start | included | excluded |
| Typed state (server, digest, post-turn reconciler) | on | off |
| MCP tools | any | only `ISOLATED_AGENT_SAFE_TOOL_IDS`, enforced at config load |
| Degraded fallback | Codex, then Ollama | Ollama only (Codex is rejected at load) |
| Deterministic routing, orchestration, memory aliases | allowed | rejected at load |

Profile overlays are deep-merged before validation, so an overlay cannot widen
an isolated agent's tools without failing to load.

## Governance

Live `agent:<id>` principals normally inherit from `user:owner`. Run
`node scripts/grant-isolated-agents.mjs` after adding an isolated agent. It
re-parents the agent under a grant-free `user:family-member` principal, removes
inherited grants and group memberships, and grants only the agent's tools.

## Safety alerts

`safety_alert` posts to `TANGO_SAFETY_ALERT_CHANNEL_ID` (falling back to
`TANGO_SCHEDULER_ALERTS_CHANNEL_ID`) and mentions
`TANGO_SAFETY_ALERT_MENTION_USER_ID` so the owner gets a push notification. The
model supplies only severity and summary. The source channel comes from turn
provenance.

The shared youth rules (`agents/assistants/<id>/RULES.md`) tell the agent not to
use `safety_alert` when the person hurting the child is a parent or someone at
home, and to give external hotlines instead.

## Profile setup

The repo holds placeholders only. The profile overlay supplies:

- `config/v2/agents/<id>.yaml`: `enabled: true`, real channel ids, and an
  `access` block with `mode: allowlist`, the channel ids, and
  `allowlist_user_ids` (the family member and the owner)
- `config/sessions/<id>.yaml` with the real `discord:<channel>` binding
- `prompts/agents/<id>/*.md` for private details (name, age, family context)
- `agents/assistants/<id>/USER.md` in the running checkout (gitignored; without
  it the shared operator `USER.md` loads). Example text: "You talk with a
  family member using the account, not with the owner."
- `.env`: `TANGO_SAFETY_ALERT_CHANNEL_ID`, `TANGO_SAFETY_ALERT_MENTION_USER_ID`

On Discord, remove View Channel from `@everyone`, deny View Channel on owner
channels for the family member's account, and allow it only on their category.
