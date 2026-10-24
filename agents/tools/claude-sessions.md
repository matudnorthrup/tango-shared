# Claude Session Tools

Shared doc for `spawn_claude_session` and `list_claude_sessions`. Workflow
rules (confirmation, prompt fidelity, voice safety) live in
`agents/skills/remote-claude-sessions.md` — read that before first use.

## `spawn_claude_session`

Spawns a remote-controllable Claude Code session on the host machine: a
detached tmux session named `CC-<title>` in the requested repo, running
`claude --dangerously-skip-permissions` seeded with the user's prompt. The
machine's global Remote Control setting registers interactive sessions, so
the user can pick the session up in the Claude mobile app seconds later.

Input:

```json
{
  "repo": "tango",
  "prompt": "Investigate the flaky startup-runner tests and propose a fix. Work on a new branch.",
  "title": "startup test flake"
}
```

- `repo` (required) — folder name under the allowed projects root
  (`~/GitHub` by default, override with `TANGO_CLAUDE_SESSION_ROOT`), or an
  absolute path inside that root. Anything outside the root is rejected.
- `prompt` (required) — the seed prompt, passed verbatim. Travels via a
  `0600` temp file under `~/.tango/claude-sessions/`, so multi-line prompts
  and quotes are safe. Max 16,000 chars.
- `title` (optional) — short human title; becomes the tmux name
  (`CC-<slug>`, collision-safe with `-2`, `-3`, …) and the display name
  shown on the phone (`claude -n`).

Output fields:

- `status` — `ready` (first response seen, ~6s typical) or `started`
  (CLI is up, still working on a long first response)
- `session` — tmux session name (e.g. `CC-startup-test-flake`)
- `working_dir`, `display_name`, `remote_control`
- `response_preview` — first response line (when `ready`)
- `pickup` — phone-pickup instructions to relay to the user
- `warning` — present only if the Remote Control marker was not visible

Failure modes surfaced as errors (with a pane-tail excerpt): claude CLI not
on PATH, CLI auth failure, tmux failures, Claude UI never appearing. On any
failure the tool kills only the session it just created.

Notes:

- The tool never kills or types into tmux sessions it did not create in the
  same call.
- Spawned sessions run with permissions bypassed in a shared working tree —
  for code tasks, include branch/worktree instructions in the prompt.

## `list_claude_sessions`

Lists tmux `CC-*` sessions previously spawned on this machine.

Input: `{}`

Output:

```json
{
  "sessions": [
    {
      "session": "CC-startup-test-flake",
      "attached": false,
      "created_at": "2026-06-10T19:42:11.000Z",
      "activity": "working",
      "remote_control": true,
      "last_line": "Running vitest on packages/voice..."
    }
  ]
}
```

`activity` is `working` (esc-to-interrupt visible), `idle` (input prompt
waiting), or `unknown` (pane is not a Claude UI).
