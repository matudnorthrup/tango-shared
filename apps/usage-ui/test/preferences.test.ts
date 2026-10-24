import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { applyProfileColors } from '../server/profile-colors';
import { usageFixture } from './fixtures';

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
it('excludes reserved accounts even when Loom accounts are unavailable, and fails closed on invalid preferences', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-prefs-')); dirs.push(dir);
  const file = path.join(dir, 'exclusions.json');
  vi.stubEnv('USAGE_UI_RECOMMENDATION_EXCLUSIONS', file);
  vi.stubEnv('LOOM_ACCOUNTS', path.join(dir, 'missing.json'));
  await fs.writeFile(file, JSON.stringify(['Claude:Personal']));
  expect((await applyProfileColors(usageFixture)).accounts[0].recommendationExcluded).toBe(true);
  await fs.writeFile(file, '{}');
  expect((await applyProfileColors(usageFixture)).accounts[0].recommendationExcluded).toBe(true);
  await fs.writeFile(file, '[]');
  expect((await applyProfileColors(usageFixture)).accounts[0].recommendationExcluded).toBe(false);
});

it('matches native Loom names and aliases without confusing providers or ambiguous accounts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-prefs-')); dirs.push(dir);
  const file = path.join(dir, 'accounts.json');
  vi.stubEnv('LOOM_ACCOUNTS', file);
  vi.stubEnv('USAGE_UI_PROFILE_ALIASES', path.join(dir, 'missing-aliases.json'));
  vi.stubEnv('USAGE_UI_RECOMMENDATION_EXCLUSIONS', path.join(dir, 'missing-exclusions.json'));
  const profile = { name: 'primary', usageName: 'Display', aliases: ['Personal'], accentColor: '#123abc' };
  await fs.writeFile(file, JSON.stringify({ claude: { accounts: [profile] }, codex: { accounts: [{ ...profile, accentColor: '#ffffff' }] } }));
  expect((await applyProfileColors(usageFixture)).accounts[0]).toMatchObject({ profileName: 'Display', profileColor: '#123abc' });
  await fs.writeFile(file, JSON.stringify({ claude: { accounts: [profile, { ...profile, name: 'duplicate' }] } }));
  expect((await applyProfileColors(usageFixture)).accounts[0].profileColor).toBeUndefined();
  await fs.writeFile(file, JSON.stringify({ claude: { accounts: [{ ...profile, aliases: 'Personal' }] } }));
  expect((await applyProfileColors(usageFixture)).accounts[0].profileColor).toBeUndefined();
});

it.each([undefined, 'invalid'])('keeps usage identity without a valid optional color: %s', async (accentColor) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-prefs-')); dirs.push(dir);
  const file = path.join(dir, 'accounts.json');
  vi.stubEnv('LOOM_ACCOUNTS', file);
  vi.stubEnv('USAGE_UI_PROFILE_ALIASES', path.join(dir, 'missing-aliases.json'));
  vi.stubEnv('USAGE_UI_RECOMMENDATION_EXCLUSIONS', path.join(dir, 'missing-exclusions.json'));
  await fs.writeFile(file, JSON.stringify({ claude: { accounts: [{ name: 'primary', usageName: 'Display', aliases: ['Personal'], accentColor }] } }));
  const account = (await applyProfileColors(usageFixture)).accounts[0];
  expect(account.profileName).toBe('Display');
  expect(account.profileColor).toBeUndefined();
});
