import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { liveProfileDir, sandboxProfileEnv } from '../scripts/sandbox-profile.js';

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('the sandbox Loom profile', () => {
  it('lives inside the sandbox home, never at the live profile, and is seeded with a copy', () => {
    const live = tmp('live-profile-');
    fs.mkdirSync(path.join(live, 'decisions'));
    fs.writeFileSync(path.join(live, 'decisions', 'rules.md'), 'R-1 live rule\n');
    fs.writeFileSync(path.join(live, 'decisions', 'board.yaml'), 'board: live\n');
    const home = tmp('sandbox-home-');
    const env = sandboxProfileEnv(home, live);

    expect(env.TANGO_PROFILE_DIR).toBeTruthy();
    expect(env.TANGO_PROFILE_DIR.startsWith(home + path.sep)).toBe(true);
    expect(path.resolve(env.TANGO_PROFILE_DIR)).not.toBe(path.resolve(live));
    expect(env.LOOM_RULES_FILE.startsWith(env.TANGO_PROFILE_DIR + path.sep)).toBe(true);
    expect(fs.readFileSync(env.LOOM_RULES_FILE, 'utf8')).toBe('R-1 live rule\n');
    expect(fs.readFileSync(path.join(env.TANGO_PROFILE_DIR, 'decisions', 'board.yaml'), 'utf8')).toBe('board: live\n');

    // A write in the sandbox leaves the live file alone.
    fs.writeFileSync(env.LOOM_RULES_FILE, 'stale\n');
    expect(fs.readFileSync(path.join(live, 'decisions', 'rules.md'), 'utf8')).toBe('R-1 live rule\n');
  });

  it('starts empty when the live profile has no decisions files', () => {
    const env = sandboxProfileEnv(tmp('sandbox-home-'), tmp('empty-live-'));
    expect(fs.existsSync(env.LOOM_RULES_FILE)).toBe(false);
  });

  it('the launcher passes the isolated profile to the sandbox Loom, not the default', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'desk-dev.ts'), 'utf8');
    expect(source).toMatch(/\.\.\.sandboxProfileEnv\(loomHome\)/);
    expect(path.resolve(sandboxProfileEnv(tmp('sandbox-home-')).TANGO_PROFILE_DIR)).not.toBe(path.resolve(liveProfileDir()));
  });
});
