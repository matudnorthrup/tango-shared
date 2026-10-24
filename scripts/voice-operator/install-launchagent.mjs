#!/usr/bin/env node
// Installs (or reinstalls) a macOS LaunchAgent that keeps one person's Discord
// voice operator running. Run from the Tango checkout it should run from.
// See docs/guides/voice-operator.md.
//
//   node scripts/voice-operator/install-launchagent.mjs --operator <id> \
//     [--env-file <path>]... [--label <launchd label>] [--logs <dir>] [--dry-run]
//
// --env-file  repeatable; defaults to ./.env and ./apps/tango-voice/.env when present.
//             Needs DISCORD_TOKEN and the bot's TANGO_VOICE_BRIDGE_API_KEY.
// --label     defaults to com.tango.voice-operator.<id>
// --logs      session logs and service.log; defaults to the profile's state dir
//             (service.log then goes to ~/Library/Logs/tango-voice-operator-<id>.log)

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const envFiles = [];
const opts = {};
for (let i = 0; i < argv.length; i++) {
  const key = argv[i].replace(/^--/, '');
  if (key === 'dry-run') opts.dryRun = true;
  else if (key === 'env-file') envFiles.push(resolve(argv[++i]));
  else opts[key] = argv[++i];
}
if (!opts.operator) {
  console.error('usage: install-launchagent.mjs --operator <id> [--env-file <path>]... [--label <label>] [--logs <dir>] [--dry-run]');
  process.exit(2);
}
if (process.platform !== 'darwin') {
  console.error('LaunchAgents are macOS only. Elsewhere, run the command this script prints with --dry-run under your process manager.');
  process.exit(2);
}

const repo = process.cwd();
const entry = 'apps/tango-voice/src/testing/live-operator-discord.ts';
if (!existsSync(join(repo, entry))) {
  console.error(`Run this from the root of a Tango checkout (no ${entry} here).`);
  process.exit(2);
}
// Reinstallation must not create a launchd competitor after server cutover.
if (!opts.dryRun) {
  const cli = join(process.env.TANGO_REPO_DIR ?? repo, 'packages/server/dist/main.js');
  let managed = false;
  try {
    execFileSync(process.execPath, [cli, 'managed', `live-operator-${opts.operator}`], { stdio: 'ignore' });
    managed = true;
  } catch { /* Observe, unknown, or unavailable: retain the launchd path. */ }
  if (managed) {
    execFileSync(process.execPath, [cli, 'restart', `live-operator-${opts.operator}`], { stdio: 'inherit' });
    process.exit(0);
  }
}

if (envFiles.length === 0) {
  for (const candidate of ['.env', 'apps/tango-voice/.env']) if (existsSync(join(repo, candidate))) envFiles.push(join(repo, candidate));
}
for (const file of envFiles) if (!existsSync(file)) throw new Error(`env file not found: ${file}`);

const label = opts.label ?? `com.tango.voice-operator.${opts.operator}`;
const logs = opts.logs ? resolve(opts.logs) : null;
const serviceLog = logs ? join(logs, 'service.log') : join(homedir(), 'Library', 'Logs', `tango-voice-operator-${opts.operator}.log`);
const node = process.execPath;
const programArguments = [
  node,
  ...envFiles.map((file) => `--env-file=${file}`),
  '--import',
  'tsx',
  entry,
  '--operator',
  opts.operator,
  ...(logs ? ['--logs', logs] : []),
];

const escape = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((arg) => `    <string>${escape(arg)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${escape(repo)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${escape(homedir())}</string>
    <key>PATH</key><string>${escape(`${dirname(node)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escape(serviceLog)}</string>
  <key>StandardErrorPath</key><string>${escape(serviceLog)}</string>
</dict>
</plist>
`;

if (opts.dryRun) {
  console.log(plist);
  console.log(`# command: cd ${repo} && ${programArguments.join(' ')}`);
  process.exit(0);
}

const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
mkdirSync(dirname(serviceLog), { recursive: true });
writeFileSync(plistPath, plist);
const domain = `gui/${process.getuid()}`;
try {
  execFileSync('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
} catch {
  // Not loaded yet.
}
// launchd sometimes refuses a bootstrap right after a bootout ("Input/output error"); retry briefly.
for (let attempt = 1; ; attempt++) {
  try {
    execFileSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'pipe' });
    break;
  } catch (err) {
    if (attempt >= 5) throw err;
    execFileSync('sleep', ['2']);
  }
}
console.log(`Installed ${label}\n  plist: ${plistPath}\n  log:   ${serviceLog}`);
