#!/usr/bin/env bash
# Installs the `tango-screen` CLI and the `agent-screen` skill for the owner's
# coding agents (Claude Code and Codex, every profile), from THIS checkout,
# plus a Claude Code PreToolUse hook (screen-leak-guard.mjs) in every Claude
# profile that keeps screen links out of other repos' commits and PRs.
# The CLI and skill are symlinks, so the checkout the screen service runs from
# keeps them current. Nothing is written into any other repo.
#
#   apps/screen/scripts/install-agent-screen.sh            install / refresh
#   apps/screen/scripts/install-agent-screen.sh --remove   uninstall
set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cli="$app_dir/bin/tango-screen.mjs"
skill="$app_dir/skill/agent-screen"
guard="$app_dir/scripts/screen-leak-guard.mjs"
bin_dir="${TANGO_SCREEN_BIN_DIR:-$HOME/bin}"
remove=false
[ "${1:-}" = "--remove" ] && remove=true

link() { # link <target> <path>
  if [ -e "$2" ] && [ ! -L "$2" ]; then echo "skip: $2 exists and is not a symlink" >&2; return; fi
  ln -sfn "$1" "$2"
  echo "linked $2 -> $1"
}

# Skill folders: every Claude/Codex profile's own skills dir (profiles that
# symlink theirs to another profile's are covered through that one).
skill_dirs=()
for dir in "$HOME"/.claude*/skills "$HOME"/.codex*/skills; do
  if [ -d "$dir" ] && [ ! -L "$dir" ]; then skill_dirs+=("$dir"); fi
done

# Adds (or with --remove, drops) the leak-guard hook in one Claude profile's settings.json.
hook() { # hook <settings.json> add|remove
  node - "$1" "$2" "$guard" <<'JS'
const fs = require('node:fs');
const [file, mode, guard] = process.argv.slice(2);
const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8') || '{}') : {};
const command = `node ${JSON.stringify(guard)}`;
const mine = (entry) => (entry.hooks ?? []).some((h) => String(h.command ?? '').includes('screen-leak-guard.mjs'));
const pre = (settings.hooks?.PreToolUse ?? []).filter((entry) => !mine(entry));
if (mode === 'add') pre.push({ matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 10 }] });
settings.hooks = { ...(settings.hooks ?? {}), PreToolUse: pre };
if (!settings.hooks.PreToolUse.length) delete settings.hooks.PreToolUse;
if (!Object.keys(settings.hooks).length) delete settings.hooks;
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
console.log(`${mode === 'add' ? 'hooked' : 'unhooked'} ${file}`);
JS
}

claude_settings=()
for dir in "$HOME"/.claude "$HOME"/.claude-*; do
  if [ -d "$dir" ] && [ ! -L "$dir/settings.json" ]; then claude_settings+=("$dir/settings.json"); fi
done

if $remove; then
  for file in "${claude_settings[@]}"; do if [ -f "$file" ]; then hook "$file" remove; fi; done
  if [ -L "$bin_dir/tango-screen" ]; then rm "$bin_dir/tango-screen"; echo "removed $bin_dir/tango-screen"; fi
  for dir in "${skill_dirs[@]}"; do if [ -L "$dir/agent-screen" ]; then rm "$dir/agent-screen"; echo "removed $dir/agent-screen"; fi; done
  exit 0
fi

chmod +x "$cli"
mkdir -p "$bin_dir"
link "$cli" "$bin_dir/tango-screen"
for dir in "${skill_dirs[@]}"; do link "$skill" "$dir/agent-screen"; done
for file in "${claude_settings[@]}"; do hook "$file" add; done
case ":$PATH:" in *":$bin_dir:"*) ;; *) echo "note: $bin_dir is not on PATH" >&2 ;; esac
