import type { UsagePayload } from './types.js';

export function retainUnavailable(next: UsagePayload, previous: UsagePayload | null): UsagePayload {
  const accounts = next.accounts.map((account) => ({ ...account,
    staleReason: account.live ? undefined : 'Live check failed — showing last known usage.',
  }));
  for (const error of next.errors) {
    const matches = previous?.accounts.filter((account) => account.provider === error.provider
      && (account.account === error.account || error.account === 'All accounts')) ?? [];
    for (const old of matches) {
      const index = accounts.findIndex((account) => account.provider === old.provider && account.account === old.account);
      // Prefer the newest snapshot, but do not lose known weekly/model windows
      // when the provider's local cache is older or incomplete.
      const current = accounts[index];
      if (current?.live) continue;
      if (current && current.windows.length >= old.windows.length
        && Date.parse(current.updatedAt ?? '') > Date.parse(old.updatedAt ?? '')) continue;
      const stale = { ...old, live: false, staleReason: 'Live check failed — showing last known usage.' };
      if (index === -1) accounts.push(stale); else accounts[index] = stale;
    }
    if (!matches.length && error.account !== 'All accounts'
      && !accounts.some((account) => account.provider === error.provider && account.account === error.account)) {
      accounts.push({ provider: error.provider, account: error.account, source: 'unavailable',
        live: false, updatedAt: null, windows: [], staleReason: 'Waiting for a successful usage check.' });
    }
  }
  return { ...next, accounts };
}
