#!/usr/bin/env bash
# Installs pkill-guard.mjs (from THIS checkout) as a Claude Code PreToolUse hook
# in every Claude profile on this machine. It blocks a pkill/pgrep with options
# after the pattern, which on macOS turns them into extra patterns (10/19: a stray
# "501" killed the production tmux server). Install from the checkout that stays
# put (the live one), since the hook runs the file by path.
#
#   scripts/guards/install-pkill-guard.sh            install / refresh
#   scripts/guards/install-pkill-guard.sh --remove   uninstall
set -euo pipefail

guard="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pkill-guard.mjs"
mode=add
[ "${1:-}" = "--remove" ] && mode=remove

for dir in "$HOME"/.claude "$HOME"/.claude-*; do
  [ -d "$dir" ] && [ ! -L "$dir/settings.json" ] || continue
  node - "$dir/settings.json" "$mode" "$guard" <<'JS'
const fs = require('node:fs');
const [file, mode, guard] = process.argv.slice(2);
const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8') || '{}') : {};
const command = `node ${JSON.stringify(guard)}`;
const mine = (entry) => (entry.hooks ?? []).some((h) => String(h.command ?? '').includes('pkill-guard.mjs'));
const pre = (settings.hooks?.PreToolUse ?? []).filter((entry) => !mine(entry));
if (mode === 'add') pre.push({ matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 10 }] });
settings.hooks = { ...(settings.hooks ?? {}), PreToolUse: pre };
if (!settings.hooks.PreToolUse.length) delete settings.hooks.PreToolUse;
if (!Object.keys(settings.hooks).length) delete settings.hooks;
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
console.log(`${mode === 'add' ? 'hooked' : 'unhooked'} ${file}`);
JS
done
