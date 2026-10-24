#!/usr/bin/env node
// Owner-machine ops: update/build both checkouts, canary/promote Loom, restart the desk.
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function deploy({ operator = join(homedir(), 'GitHub/tango-worktrees/operator'), live = join(homedir(), 'GitHub/tango-worktrees/live') } = {}, dependencies = {}) {
  const run = dependencies.run ?? ((file, args) => execFileSync(file, args, { stdio: 'inherit' }));
  // The existing helper refuses dirty/divergent copies and stops on a build failure.
  run('bash', [join(operator, 'scripts/dev/update-live-checkouts.sh'), operator, live]);
  const release = dependencies.release ?? (await import(pathToFileURL(join(operator, 'packages/loom/scripts/release.mjs')).href)).run;
  const canary = dependencies.canary ?? (await import(pathToFileURL(join(operator, 'packages/loom/scripts/canary.mjs')).href)).canary;
  const id = release(['build']);
  // The process fake exercises coordinator/host restart and replay without spending model quota.
  await canary(id, { fake: true, account: 'deploy-canary' });
  // canary promotes the candidate after its checks pass.
  let managed = true;
  try { run('tango-server', ['managed', 'loom']); } catch (error) {
    // Only a known unmanaged Loom uses its established LaunchAgent. Unknown ownership never falls back.
    if (error.status !== 1) throw error;
    managed = false;
  }
  if (managed) run('tango-server', ['restart', 'loom', '-v']);
  else run('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/com.tango.loom`]);
  run('tango-server', ['restart', 'screen', '-v']);
  console.log(`Promoted Loom ${id}; desk restart requested. Verify live health and log ops-own-machine. Rollback: release:rollback then restart Loom; restore the desk checkout to its previous revision and restart screen.`);
  return id;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && args.length !== 2) { console.error('Usage: node scripts/dev/deploy-desk.mjs [operator-checkout live-checkout]'); process.exitCode = 2; }
  else await deploy(args.length ? { operator: resolve(args[0]), live: resolve(args[1]) } : {}).catch(error => { console.error(error.message); process.exitCode = 1; });
}
