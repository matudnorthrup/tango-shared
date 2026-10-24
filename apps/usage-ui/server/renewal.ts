import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
const expand = (value: string) => value === '~' ? os.homedir() : value.replace(/^~\//, `${os.homedir()}/`);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
// macOS `script` requires a terminal on its own stdin. A stdlib PTY bridge
// also works from the background HTTP service. It forwards no credentials.
const PTY_BRIDGE = `
import os, pty, select, signal, sys
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
def stop(*args):
    try: os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError: pass
    try: os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    try: os.waitpid(pid, 0)
    except ChildProcessError: pass
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    while True:
        ready, _, _ = select.select([fd, sys.stdin.fileno()], [], [], 1)
        if fd in ready:
            try: data = os.read(fd, 65536)
            except OSError: break
            if not data: break
            os.write(sys.stdout.fileno(), data)
        if sys.stdin.fileno() in ready:
            data = os.read(sys.stdin.fileno(), 4096)
            if not data: break
            os.write(fd, data)
finally:
    stop()
`;
export interface CredentialState { expiresAt: number; refreshable: boolean; fingerprint: string }
interface RetryState { fingerprint: string; failures: number; nextAttempt: number; loginRequired?: boolean }
export function shouldRenew(state: CredentialState, now: number): boolean {
  return state.refreshable && state.expiresAt <= now + 10 * 60_000;
}
export function retryDelay(failures: number): number {
  return Math.min(60, 5 * 2 ** Math.min(4, Math.max(0, failures - 1))) * 60_000;
}

// Read metadata only. Never return, log, persist, or pass credentials to a child.
async function credential(home: string): Promise<CredentialState | null> {
  const services = [`Claude Code-credentials-${hash(home).slice(0, 8)}`];
  if (home === path.join(os.homedir(), '.claude')) services.push('Claude Code-credentials');
  for (const service of services) {
    try {
      const { stdout } = await exec('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], { timeout: 5000 });
      const oauth = JSON.parse(stdout).claudeAiOauth;
      if (oauth?.accessToken && Number.isFinite(oauth.expiresAt)) {
        return { expiresAt: oauth.expiresAt, refreshable: !!oauth.refreshToken, fingerprint: hash(oauth.accessToken) };
      }
    } catch { /* A missing/unreadable entry must never trigger a new login flow. */ }
  }
  return null;
}

// Invoke only Claude's built-in /usage command in a PTY. Claude owns credential
// refresh, its native locking, and Keychain persistence. No inference request.
async function renewWithClaude(home: string, cwd: string, before: CredentialState): Promise<{ renewed: boolean; loginRequired: boolean }> {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: home, DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_CONNECT: '1', TERM: 'dumb' };
  for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE']) delete (env as NodeJS.ProcessEnv)[key];
  const binary = process.env.USAGE_UI_CLAUDE_BIN ?? path.join(os.homedir(), 'bin', 'claude');
  const child = spawn('/usr/bin/python3', ['-c', PTY_BRIDGE, binary, '--ax-screen-reader',
    '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'plan', '/usage'],
  { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let exited = false;
  let pending = '';
  let trusted = false;
  let loginRequired = false;
  child.on('error', () => { exited = true; });
  child.on('close', () => { exited = true; });
  child.stderr.resume();
  child.stdout.on('data', (chunk: Buffer) => {
    pending = (pending + chunk.toString()).slice(-6000);
    if (!trusted && pending.includes('Enter y/n:') && pending.includes('trust this folder')) {
      trusted = true;
      child.stdin.write('y\r');
      pending = '';
    }
    if (/Select login method|Please run \/login|Invalid refresh token|invalid_grant/i.test(pending)) loginRequired = true;
  });
  const deadline = Date.now() + 45_000;
  try {
    while (!exited && !loginRequired && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const current = await credential(home);
      if (current && current.expiresAt > Date.now() + 60_000
        && (current.fingerprint !== before.fingerprint || current.expiresAt > before.expiresAt)) return { renewed: true, loginRequired: false };
    }
    return { renewed: false, loginRequired };
  } finally {
    // Kill only the temporary session's process group, never user sessions.
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
      await new Promise((resolve) => setTimeout(resolve, 300));
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    }
  }
}

export interface RenewalOptions {
  accountsPath?: string;
  root?: string;
  readCredential?: typeof credential;
  renew?: typeof renewWithClaude;
}

export async function renewClaudeProfiles(options: RenewalOptions = {}): Promise<Record<string, string>> {
  const warnings: Record<string, string> = {};
  if (process.platform !== 'darwin' && !options.readCredential) return warnings;
  const readCredential = options.readCredential ?? credential;
  const renew = options.renew ?? renewWithClaude;
  const root = options.root ?? process.env.USAGE_UI_RENEWAL_DIR ?? path.join(os.homedir(), '.tango', 'profiles', process.env.TANGO_PROFILE ?? 'default', 'usage-monitor', 'renewal');
  try {
    const settings = JSON.parse(await fs.readFile(expand(options.accountsPath ?? process.env.LOOM_ACCOUNTS ?? '~/.tango/loom/accounts.json'), 'utf8'));
    const homes = new Set<string>();
    const names = new Map<string, string[]>();
    for (const profile of settings.claude?.accounts ?? []) {
      if (typeof profile.name !== 'string' || profile.enabled === false) continue;
      // Only the explicitly configured Claude home is inspected; Codex homes and aliases
      // never determine credential locations. Missing configDir is Claude's default login.
      if (profile.configDir !== undefined && (typeof profile.configDir !== 'string' || !profile.configDir.trim())) continue;
      const home = expand(profile.configDir ?? '~/.claude');
      // A relative home would resolve against this service's scratch cwd, not Loom's.
      if (!path.isAbsolute(home)) continue;
      homes.add(home);
      names.set(home, [...(names.get(home) ?? []), profile.usageName ?? profile.name]);
    }
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    // Profiles are independently locked; renew them concurrently so one stalled
    // session cannot stretch a refresh to 45 s per profile.
    await Promise.allSettled([...homes].map(async (home) => {
      const initial = await readCredential(home);
      if (!initial || !shouldRenew(initial, Date.now())) return;
      const id = hash(home).slice(0, 16);
      const retryFile = path.join(root, `${id}.json`);
      let retry: RetryState = { fingerprint: initial.fingerprint, failures: 0, nextAttempt: 0 };
      try { retry = JSON.parse(await fs.readFile(retryFile, 'utf8')); } catch { /* First attempt. */ }
      if (retry.fingerprint !== initial.fingerprint) retry = { fingerprint: initial.fingerprint, failures: 0, nextAttempt: 0 };
      const report = () => { for (const name of names.get(home) ?? []) warnings[name] = retry.loginRequired
        ? 'Claude could not renew this saved login and requested sign-in. Sign in to this profile to restore live monitoring.'
        : 'Automatic credential renewal is waiting to retry after a temporary failure.'; };
      if (Date.now() < retry.nextAttempt) { report(); return; }
      const lock = path.join(root, `${id}.lock`);
      try {
        // Our own cross-process lock supplements Claude's native refresh path.
        const stat = await fs.stat(lock).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > 120_000) await fs.rmdir(lock).catch(() => {});
        await fs.mkdir(lock);
      } catch { return; }
      try {
        const current = await readCredential(home);
        if (!current || !shouldRenew(current, Date.now())) return;
        // Another dashboard process may have just failed while we waited for
        // the lock. Recheck its persisted cooldown before trying again.
        const latest: RetryState | null = await fs.readFile(retryFile, 'utf8').then(JSON.parse).catch(() => null);
        if (latest?.fingerprint === current.fingerprint && latest.nextAttempt > Date.now()) {
          retry = latest;
          report();
          return;
        }
        // Persist backoff before launching, including across service crashes.
        retry.failures += 1;
        retry.nextAttempt = Date.now() + retryDelay(retry.failures);
        await fs.writeFile(retryFile, JSON.stringify(retry), { mode: 0o600 });
        const result = await renew(home, root, current);
        if (result.renewed) await fs.unlink(retryFile).catch(() => {});
        else {
          retry.loginRequired = result.loginRequired;
          await fs.writeFile(retryFile, JSON.stringify(retry), { mode: 0o600 });
          report();
        }
      } finally { await fs.rmdir(lock).catch(() => {}); }
    }));
  } catch { /* A renewal failure must not suppress healthy provider data. */ }
  return warnings;
}
