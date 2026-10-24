#!/usr/bin/env node
// Claude Code PreToolUse hook (Bash): blocks a pkill/pgrep whose options come after the pattern.
//
// macOS (BSD) pkill stops reading options at the first pattern, so in
// `pkill -f "node host.mjs" -U $(id -u)` the `-U` and `501` are two more patterns. With -f,
// "501" matches every process whose command line contains it, including the production tmux
// server (`tmux -S /private/tmp/tmux-501/tango-live ...`). On 10/19 that one command killed the
// server and every Tango window in it, plus dozens of unrelated apps.
//
// Reads the hook event on stdin; exits 2 (blocking, reason on stderr) for a pkill/pgrep with an
// option after the pattern or more than one pattern. Anything else exits 0. Installed by
// install-pkill-guard.sh.

import * as fs from 'node:fs';

// Options that take a value (BSD pkill/pgrep).
const VALUE_OPTS = new Set(['d', 'F', 'G', 'g', 'J', 'M', 'N', 'P', 's', 't', 'U', 'u']);

/** Shell-ish words of one simple command: quotes kept together, $(...) and `...` as one word. */
function words(text) {
  const out = [];
  let cur = '', i = 0, has = false;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { if (has) out.push(cur); cur = ''; has = false; i++; continue; }
    has = true;
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      const stop = end < 0 ? text.length : end;
      cur += text.slice(i + 1, stop); i = stop + 1; continue;
    }
    if (c === '$' && text[i + 1] === '(') {
      let depth = 0, j = i + 1;
      for (; j < text.length; j++) { if (text[j] === '(') depth++; else if (text[j] === ')' && --depth === 0) break; }
      cur += '$(...)'; i = j + 1; continue;
    }
    if (c === '`') { const end = text.indexOf('`', i + 1); cur += '`...`'; i = end < 0 ? text.length : end + 1; continue; }
    cur += c; i++;
  }
  if (has) out.push(cur);
  return out;
}

/** Split on ; && || | & and newlines, outside quotes and $(...). */
function simpleCommands(command) {
  const parts = [];
  let cur = '', quote = null, depth = 0;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === '$' && command[i + 1] === '(') { depth++; cur += c; continue; }
    if (c === ')' && depth > 0) { depth--; cur += c; continue; }
    if (depth === 0 && (c === ';' || c === '|' || c === '&' || c === '\n')) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

export function verdict(command) {
  if (!/\bp(?:kill|grep)\b/.test(command)) return null;
  for (const part of simpleCommands(command)) {
    const w = words(part);
    let k = 0;
    while (k < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[k]) || ['sudo', 'command', 'exec', 'env', 'time', 'nohup'].includes(w[k]))) k++;
    const name = (w[k] ?? '').split('/').pop();
    if (name !== 'pkill' && name !== 'pgrep') continue;
    const patterns = [];
    for (let j = k + 1; j < w.length; j++) {
      const a = w[j];
      if (/^[0-9]?[<>]/.test(a)) { j++; continue; } // a redirection: 2>/dev/null, > file
      if (a === '--' && patterns.length === 0) { patterns.push(...w.slice(j + 1).filter((x) => !/^[0-9]?[<>]/.test(x))); break; }
      if (a.startsWith('-') && a.length > 1) {
        if (patterns.length > 0) {
          return `Blocked: \`${part}\` puts the option ${a} after the pattern. macOS ${name} stops reading options at the first pattern, so ${a} and anything after it become extra patterns; with -f a pattern like "501" matches any process whose command line contains it (on 10/19 this killed the production tmux server). Put every option before the pattern: \`${name} ${w.slice(k + 1).filter((x) => x.startsWith('-')).join(' ')} ...\`, then exactly one pattern.`;
        }
        const flag = a.slice(1);
        if (VALUE_OPTS.has(flag)) j++; // -U 501: the value is not a pattern
        continue;
      }
      patterns.push(a);
    }
    if (patterns.length > 1) {
      return `Blocked: \`${part}\` gives ${name} ${patterns.length} patterns (${patterns.map((p) => JSON.stringify(p)).join(', ')}). Every one of them matches on its own, so a stray word kills unrelated processes (on 10/19 a stray "501" killed the production tmux server). Combine them into one regex, or put options before the single pattern.`;
    }
  }
  return null;
}

const invokedDirectly = (() => {
  try {
    return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  let event = {};
  try {
    event = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }
  const reason = verdict(String(event?.tool_input?.command ?? ''));
  if (reason) {
    process.stderr.write(`${reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}
