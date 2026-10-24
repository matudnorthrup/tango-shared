import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { UsagePayload } from './types.js';

// Private, account-specific preferences live in the profile layer, never in the repo.
function profileFile(name: string): string {
  return path.join(os.homedir(), '.tango', 'profiles', process.env.TANGO_PROFILE ?? 'default', 'usage-monitor', name);
}

interface Profile { name: string; usageName?: string; aliases?: string[]; accentColor?: string; enabled?: boolean }

// Account aliases are private data. Only the resolved display name and color
// enter the dashboard; credentials and Loom's other configuration never do.
export async function applyProfileColors(payload: UsagePayload): Promise<UsagePayload> {
  // Keep account-specific project preferences outside tracked source.
  let excluded: string[] = [];
  try {
    excluded = JSON.parse(await readFile(process.env.USAGE_UI_RECOMMENDATION_EXCLUSIONS
      ?? profileFile('recommendation-exclusions.json'), 'utf8'));
    if (!Array.isArray(excluded) || excluded.some((value) => typeof value !== 'string')) throw new Error('Invalid exclusions');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { ...payload, accounts: payload.accounts.map((account) => ({ ...account, recommendationExcluded: true })) };
    }
  }
  payload = { ...payload, accounts: payload.accounts.map((account) => ({ ...account,
    recommendationExcluded: excluded.includes(`${account.provider}:${account.account}`),
  })) };
  try {
    const settingsPath = process.env.LOOM_ACCOUNTS
      ?? path.join(os.homedir(), '.tango', 'loom', 'accounts.json');
    const settings = JSON.parse(await readFile(settingsPath.replace(/^~\//, `${os.homedir()}/`), 'utf8'));
    const profiles = settings as Record<string, { accounts?: Profile[] }>;
    let aliases: Record<string, string> = {};
    try {
      aliases = JSON.parse(await readFile(process.env.USAGE_UI_PROFILE_ALIASES
        ?? profileFile('profile-aliases.json'), 'utf8'));
    } catch { /* Optional: Loom usageName and aliases can match collector names directly. */ }

    return { ...payload, accounts: payload.accounts.map((account) => {
      const provider = account.provider === 'Claude' ? 'claude' : account.provider === 'Codex' ? 'codex' : null;
      if (!provider) return account;
      const alias = aliases[`${account.provider}:${account.account}`];
      const matches = (profiles[provider]?.accounts ?? []).filter(profile => {
        const names = Array.isArray(profile.aliases) ? profile.aliases.filter(name => typeof name === 'string') : [];
        return profile.enabled !== false && (alias ? profile.name === alias || names.includes(alias)
          : [profile.name, profile.usageName, ...names].includes(account.account));
      });
      const match = matches[0];
      if (matches.length !== 1 || !match) return account;
      const profile = match;
      return { ...account, profileName: profile.usageName ?? profile.name,
        ...(/^#[0-9a-f]{6}$/i.test(profile.accentColor ?? '') ? { profileColor: profile.accentColor } : {}),
      };
    }) };
  } catch { return payload; }
}
