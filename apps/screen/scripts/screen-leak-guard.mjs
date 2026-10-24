#!/usr/bin/env node
// Claude Code PreToolUse hook (Bash): stops a commit, PR, or issue in any repo
// but this one from carrying agent-screen links or naming the private
// `tango-screen` tool. Screens are the owner's private surface. A team repo's
// history and PRs should never point at them.
//
// It reads the hook event on stdin and exits 2 (blocking, with the reason on
// stderr) when the command, or a message/body file it names, mentions a screen.
// Anything else exits 0. Installed by install-agent-screen.sh.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PUBLISHING = /\b(?:git\s+(?:-C\s+\S+\s+)?commit|gh\s+(?:pr|issue)\s+(?:create|edit|comment|review)|gh\s+api\b[^|;&]*\b(?:pulls|issues|comments)\b)/;
const SCREEN_REF = /\/tango-screen\b|\btango-screen\b|\bbundles\/[a-f0-9]{24}\b|\bagent-screen\b/i;
const FILE_FLAGS = /(?:^|\s)(?:-F|--file|--body-file)(?:\s+|=)("[^"]+"|'[^']+'|\S+)/g;

export function verdict(command, cwd, { readFile = (file) => fs.readFileSync(file, 'utf8'), isScreenRepo = screenRepo } = {}) {
  if (!PUBLISHING.test(command)) return null;
  if (isScreenRepo(cwd)) return null;
  const texts = [command];
  for (const match of command.matchAll(FILE_FLAGS)) {
    const file = match[1].replace(/^["']|["']$/g, '');
    if (file === '-') continue;
    try {
      texts.push(readFile(path.resolve(cwd, file)));
    } catch {
      // not readable here: the command text is all there is to check
    }
  }
  const hit = texts.map((text) => SCREEN_REF.exec(text)?.[0]).find(Boolean);
  return hit
    ? `Blocked: this commit/PR/issue mentions an agent screen (“${hit}”). Screens and tango-screen links are the owner's private tools: take them out, and re-host any visual evidence where the team can see it.`
    : null;
}

/** The repo that ships the screen (tango) may of course talk about it. */
function screenRepo(cwd) {
  try {
    const top = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
    return fs.existsSync(path.join(top, 'apps', 'screen', 'bin', 'tango-screen.mjs'));
  } catch {
    return false;
  }
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
  const command = typeof event.tool_input?.command === 'string' ? event.tool_input.command : '';
  const reason = command ? verdict(command, event.cwd || process.cwd()) : null;
  if (reason) {
    process.stderr.write(reason + '\n');
    process.exit(2);
  }
}
