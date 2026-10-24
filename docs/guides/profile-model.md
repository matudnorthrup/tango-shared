# Profile And Update Model

## Layers

Tango loads configuration in this order:

1. Repo defaults from `config/defaults`
2. Profile overrides from `~/.tango/profiles/<profile>/config`
3. Environment variables and CLI flags

For prompts, Tango loads the repo-owned base prompt first and then appends any
profile-owned overlay files from `~/.tango/profiles/<profile>/prompts`.

Profile shared prompt files (`RULES.md`, `USER.md`) override the repo defaults
when present at either:

- `~/.tango/profiles/<profile>/prompts/shared/` (preferred)
- `~/.tango/profiles/<profile>/agents/shared/` (legacy)

Per-agent persona files may also live under legacy
`~/.tango/profiles/<profile>/agents/assistants/<id>/` when
`system_prompt_file` points there. Preferred overlay path:
`prompts/agents/<agent-id>/`.

The `agent_docs` tool uses profile-first resolution for `shared/` and
`assistants|workers|system/` paths when configured. Repo copies are templates
only.

That overlay surface can include:

- `prompts/shared/` for operator-specific shared rules and user context
- `prompts/agents/<agent-id>/` for agent persona and knowledge — every `.md`
  here is **appended** to the repo persona base (`soul.md` + `knowledge.md`) when
  the agent's system prompt is assembled.
- `prompts/tools/<doc-name>.md` for installation-specific tool instructions
- `prompts/skills/<doc-name>.md` for installation-specific skill guidance

For skills and tools the overlay is applied at **read time**: when an agent reads
`agents/skills/<x>.md` or `agents/tools/<x>.md` via the `agent_docs` tool, the
generic repo base is returned with the profile overlay appended (and `list`
surfaces overlay-only docs). So the repo doc stays generic and an installation's
real accounts/preferences/private knowledge live only in the profile overlay. Put
personal additions in the overlay, never in the repo doc.

## What Belongs In The Repo

- Product code
- Tests (with **synthetic** fixtures — no real names, account ids, or biometrics)
- Generic prompt base files (genericized personas/skills/tools)
- Config schemas and reusable defaults with **placeholder** ids
  (Discord channel ids = `1` followed by zeros, e.g. `100000000000000003`;
  avatars = `https://example.com/...`; emails = `@example.com`/`@example.test`)
- Examples and contributor docs

## What Belongs In A Profile

- Agent display names and call signs
- Real Discord channel/guild ids, avatar URLs (they embed real user ids), and
  remote-MCP endpoints that name an employer's internal services
- Schedule overrides; the real Obsidian vault root, work email, Slack channel names
- Private knowledge (personal context, health baselines)
- Real account mappings and vendor lists (e.g. reimbursement vendors/amounts)
- Machine-local home and absolute filesystem paths — prefer vault-relative paths
  in prompts; the obsidian tool resolves them against the configured vault root
- Any machine- or person-specific prompt overlays for agents, tools, or skills

Rule of thumb for new code/config/prompts: if a value is true for exactly one
person or one machine, it goes in the profile and the repo ships a placeholder or
a config-driven default. `scripts/privacy-scan.sh` is the CI gate that enforces
this for the structural shapes (real snowflakes, machine paths, credentials) plus
the operator's profile denylist terms — keep it green.

Legacy per-agent `agents/assistants/<id>/USER.md` files and symlinks also
belong in a profile. They may be ignored by git, but if they remain under the
repo checkout, prompt assembly still treats them as repo-path per-agent user
overrides. Move that content to:

```text
~/.tango/profiles/<profile>/prompts/agents/<id>/user.md
```

## What Belongs In Runtime Data

- SQLite databases
- Browser profiles
- Reports
- Caches
- Logs
- Transcripts and generated artifacts

## Update Behavior

The goal is that `git pull` updates the repo defaults without overwriting the
user's actual setup. Users should not need to edit tracked repo files just to
configure Tango for themselves.

## Migrating An Existing Install

When upstream genericizes data that used to live in the repo (real ids, vendors,
persona/skill specifics), an existing operator must first snapshot their personal
values into the profile, **then** pull the genericized release. Run this against
your current working tree (which still holds your real values) before pulling:

```bash
# Dry-run the whole path first — shows what would move, writes nothing.
bash scripts/migrate-personal-context-to-profile.sh --dry-run

# Then apply (write-only to the profile; never rewrites repo files):
bash scripts/migrate-personal-context-to-profile.sh
```

That single entry point runs, in order:

1. **USER.md** — moves legacy `agents/assistants/<id>/USER.md` to the profile.
2. **Config** (`scripts/migrate-personal-config-to-profile.mjs`) — snapshots real
   Discord channel/avatar/endpoint values from `config/v2/agents` + sessions into
   `~/.tango/profiles/<profile>/config/...`. The config layer deep-merges profile
   over repo, so the merged runtime config is unchanged.
3. **Prompts** (`scripts/migrate-personal-prompts-to-profile.mjs`) — snapshots
   persona/skill/tool docs that contain personal data (structural signals + your
   profile denylist) into the profile overlay.
4. **Audit** (`scripts/privacy-scan.sh`) — confirms the working tree is clean.

After it reports clean, `git pull` the genericized release and restart Tango;
the genericized repo base composes with your profile overlays to reproduce your
original behavior. Optionally trim each prompt overlay down to just your personal
additions so you keep receiving upstream prompt updates for the generic parts.

The CLI also exposes layering inspectors that write nothing:

```bash
npm run cli -- doctor
npm run cli -- prompt audit
npm run cli -- config migrate --dry-run
```
