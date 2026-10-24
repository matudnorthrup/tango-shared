import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The live profile a sandbox must never write to (the same resolution as packages/loom/src/decisions.ts profileDir). */
export function liveProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.TANGO_PROFILE_DIR ?? path.join(env.TANGO_HOME ?? path.join(os.homedir(), '.tango'), 'profiles', env.TANGO_PROFILE?.trim() || 'default');
}

/**
 * A sandbox's own profile, inside its home, seeded with a copy of the live profile's decisions/ files so it looks
 * real but never writes back. Returns the env a sandbox Loom (and desk) must run with: Loom imports and rewrites
 * decisions/rules.md under the profile, so a sandbox left on the live one clobbers the owner's rules.
 */
export function sandboxProfileEnv(home: string, live: string = liveProfileDir()): { TANGO_PROFILE_DIR: string; LOOM_RULES_FILE: string } {
  const profile = path.join(home, 'profile');
  const decisions = path.join(profile, 'decisions');
  fs.mkdirSync(decisions, { recursive: true });
  for (const name of ['board.yaml', 'rules.md']) {
    try {
      fs.copyFileSync(path.join(live, 'decisions', name), path.join(decisions, name));
    } catch {
      /* no live copy: the sandbox starts without one */
    }
  }
  return { TANGO_PROFILE_DIR: profile, LOOM_RULES_FILE: path.join(decisions, 'rules.md') };
}
