// Which account a new project should use: fresh, live, not excluded, with headroom.
// Pure (no React), so the desk's Start work can be checked against it.

import { isSpecialWindow, percentLeft } from './format';
import type { UsageAccount, UsageWindow } from './types';

export function isMainWeekly(window: UsageWindow): boolean {
  return !isSpecialWindow(window) && (window.windowMinutes === 10_080 || /weekly|seven_day/.test(window.kind));
}

export function visibleWindows(account: UsageAccount): UsageWindow[] {
  return account.windows.filter((window) => !(account.provider.toLowerCase() === 'codex' && /spark|gpt[-_ ]reserve/i.test(`${window.kind} ${window.title}`)));
}

/** Every usable account for `provider`, best first (see recommendAccount). */
export function rankAccounts(accounts: UsageAccount[], provider: string, now: number) {
  return accounts.filter((account) => account.provider === provider && account.live && !account.staleReason
    && !account.recommendationExcluded && account.updatedAt
    && now - Date.parse(account.updatedAt) < 15 * 60_000)
    .map((account) => {
      const windows = visibleWindows(account);
      const weekly = windows.find(isMainWeekly);
      const remaining = weekly ? percentLeft(weekly) : null;
      const minimum = Math.min(...windows.map((window) => percentLeft(window) ?? 0));
      const awaitingReset = windows.some((window) => window.resetsAt && Date.parse(window.resetsAt) <= now);
      const resetsAt = weekly?.resetsAt ?? null;
      const resetIn = resetsAt ? Date.parse(resetsAt) - now : NaN;
      const useBeforeReset = remaining !== null && remaining >= 50 && minimum >= 20
        && resetIn > 0 && resetIn < 48 * 60 * 60_000;
      return { account, remaining, minimum, awaitingReset, resetsAt, resetIn, useBeforeReset };
    })
    .filter((entry): entry is typeof entry & { remaining: number } => entry.remaining !== null
      && entry.minimum > 0 && !entry.awaitingReset)
    .sort((a, b) => Number(b.useBeforeReset) - Number(a.useBeforeReset)
      || (a.useBeforeReset && b.useBeforeReset ? a.resetIn - b.resetIn : 0)
      || Number(b.minimum >= 20) - Number(a.minimum >= 20)
      || b.remaining - a.remaining || b.minimum - a.minimum);
}

/** The dashboard's "New project" pick; Start work on the desk mirrors it (apps/screen/server/desk/start-work-accounts.ts, kept in step by a parity test). */
export function recommendAccount(accounts: UsageAccount[], provider: string, now: number) {
  return rankAccounts(accounts, provider, now)[0] ?? null;
}
