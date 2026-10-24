import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { renewClaudeProfiles } from '../server/renewal.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-renewal-test-'));
  dirs.push(root);
  const accountsPath = path.join(root, 'accounts.json');
  await fs.writeFile(accountsPath, JSON.stringify({ claude: { accounts: [{ name: 'example', usageName: 'Example', configDir: '/example/claude' }] } }));
  return { root, accountsPath };
}
const expired = { expiresAt: 1, refreshable: true, fingerprint: 'test-credential' };

it('persists failure cooldown across invocations, and retries after a changed login', async () => {
  const options = await fixture();
  const renew = vi.fn().mockResolvedValue({ renewed: false, loginRequired: false });
  let state = expired;
  const readCredential = async () => state;
  await renewClaudeProfiles({ ...options, renew, readCredential });
  await renewClaudeProfiles({ ...options, renew, readCredential });
  expect(renew).toHaveBeenCalledTimes(1);
  state = { ...expired, fingerprint: 'new-login' };
  await renewClaudeProfiles({ ...options, renew, readCredential });
  expect(renew).toHaveBeenCalledTimes(2);
});

it('serializes overlapping renewal passes and releases the lock', async () => {
  const options = await fixture();
  const renew = vi.fn().mockResolvedValue({ renewed: false, loginRequired: false });
  await Promise.all([1, 2].map(() => renewClaudeProfiles({ ...options, renew, readCredential: async () => expired })));
  expect(renew).toHaveBeenCalledTimes(1);
  expect((await fs.readdir(options.root)).filter(name => name.endsWith('.lock'))).toEqual([]);
});

it('requires sign-in only when the native result requests it; never launches without a refresh token', async () => {
  const options = await fixture();
  const renew = vi.fn().mockResolvedValue({ renewed: false, loginRequired: true });
  const result = await renewClaudeProfiles({ ...options, renew, readCredential: async () => expired });
  expect(result.Example).toContain('requested sign-in');
  renew.mockClear();
  await renewClaudeProfiles({ ...options, renew, readCredential: async () => ({ ...expired, refreshable: false }) });
  expect(renew).not.toHaveBeenCalled();
});

it('renews independent profiles concurrently instead of one after another', async () => {
  const options = await fixture();
  await fs.writeFile(options.accountsPath, JSON.stringify({ claude: { accounts: [
    { name: 'one', usageName: 'One', configDir: '/example/one' },
    { name: 'two', usageName: 'Two', configDir: '/example/two' },
  ] } }));
  let active = 0;
  let peak = 0;
  const renew = vi.fn(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return { renewed: false, loginRequired: false };
  });
  const result = await renewClaudeProfiles({ ...options, renew, readCredential: async () => expired });
  expect(renew).toHaveBeenCalledTimes(2);
  expect(peak).toBe(2);
  expect(Object.keys(result).sort()).toEqual(['One', 'Two']);
});

it('does not inspect Codex credentials, disabled accounts, or invalid Claude homes', async () => {
  const options = await fixture();
  await fs.writeFile(options.accountsPath, JSON.stringify({
    claude: { accounts: [
      { name: 'active', usageName: 'Active', configDir: '/example/active', aliases: ['elsewhere'] },
      { name: 'disabled', configDir: '/example/disabled', enabled: false },
      { name: 'invalid', configDir: '' },
      { name: 'relative', configDir: 'another-account' },
    ] },
    codex: { accounts: [{ name: 'codex', home: '/example/codex' }] },
  }));
  const readCredential = vi.fn().mockResolvedValue(null);
  await renewClaudeProfiles({ ...options, readCredential, renew: vi.fn() });
  expect(readCredential.mock.calls).toEqual([['/example/active']]);
});
