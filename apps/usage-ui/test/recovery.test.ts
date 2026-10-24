import { describe, expect, it } from 'vitest';
import { shouldRenew, retryDelay } from '../server/renewal.js';
import { retainUnavailable } from '../server/stale.js';
import { usageFixture } from './fixtures.js';

describe('renewal policy', () => {
  it('renews near expiry and after overnight expiry, without touching non-refreshable tokens', () => {
    const now = Date.now();
    const credential = { expiresAt: now + 8 * 60_000, refreshable: true, fingerprint: 'fixture' };
    expect(shouldRenew(credential, now)).toBe(true);
    expect(shouldRenew(credential, now + 12 * 3600_000)).toBe(true);
    expect(shouldRenew({ ...credential, expiresAt: now + 3600_000 }, now)).toBe(false);
    expect(shouldRenew({ ...credential, refreshable: false }, now)).toBe(false);
  });
  it('backs off repeated failures and caps retries at one hour', () => {
    expect([1, 2, 3, 4, 5, 50].map(retryDelay)).toEqual([5, 10, 20, 40, 60, 60].map(n => n * 60_000));
  });
});

describe('unavailable accounts', () => {
  it('retains per-account usage and original timestamps during provider failure, then recovers', () => {
    const next = { ...usageFixture, accounts: [], errors: [{ provider: 'Claude', account: 'All accounts', message: 'timeout' }] };
    const stale = retainUnavailable(next, usageFixture);
    expect(stale.accounts).toHaveLength(1);
    expect(stale.accounts[0]?.live).toBe(false);
    expect(stale.accounts[0]?.updatedAt).toBe(usageFixture.accounts[0]?.updatedAt);
    expect(stale.accounts[0]?.windows).toEqual(usageFixture.accounts[0]?.windows);
    const recovered = retainUnavailable(usageFixture, stale);
    expect(recovered.accounts[0]?.live).toBe(true);
    expect(recovered.accounts[0]?.staleReason).toBeUndefined();
  });
  it('does not retain deliberately removed accounts without an error', () => {
    expect(retainUnavailable({ ...usageFixture, accounts: [] }, usageFixture).accounts).toEqual([]);
  });
  it('keeps the full snapshot when a fallback cache loses model-specific windows', () => {
    const next = structuredClone(usageFixture);
    next.accounts[0]!.live = false;
    next.accounts[0]!.updatedAt = '2026-09-04T18:00:00.000Z';
    next.accounts[0]!.windows = next.accounts[0]!.windows.slice(0, 1);
    next.errors = [{ provider: 'Claude', account: 'Personal', message: 'expired' }];
    expect(retainUnavailable(next, usageFixture).accounts[0]?.windows).toHaveLength(2);
  });
  it('shows an unavailable placeholder even without any prior data', () => {
    const next = { ...usageFixture, accounts: [], errors: [{ provider: 'Claude', account: 'Example', message: 'missing login' }] };
    const state = retainUnavailable(next, null);
    expect(state.accounts[0]).toMatchObject({ account: 'Example', live: false, windows: [], updatedAt: null });
  });
});
