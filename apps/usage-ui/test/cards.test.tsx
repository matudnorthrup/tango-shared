import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AccountCard, isMainWeekly, visibleWindows, recommendAccount } from '../src/App';
import { usageFixture } from './fixtures';

const weekly = { ...usageFixture.accounts[0].windows[0], kind: 'weekly_all', title: '7 day', windowMinutes: 10080 };
const account = { ...usageFixture.accounts[0], profileName: 'Example Personal', profileColor: '#ffcc00', windows: [...usageFixture.accounts[0].windows, weekly] };
const now = Date.parse('2026-09-04T17:00:00Z');

describe('account card hierarchy', () => {
  it('hides reserve allowance and shortens compact reset text without changing full view', () => {
    const reserve = { ...weekly, kind: 'gpt-reserve', title: 'gpt-reserve' };
    expect(visibleWindows({ ...account, provider: 'Codex', windows: [weekly, reserve] })).toEqual([weekly]);
    const compact = renderToStaticMarkup(<AccountCard account={account} now={now} compact />);
    expect(compact).not.toMatch(/>Resets at /);
    expect(compact).toContain('title="Resets at');
    expect(renderToStaticMarkup(<AccountCard account={account} now={now} />)).toMatch(/>Resets at /);
  });
  it('keeps allowance values and weekly reset accessible in compact view without healthy-status clutter', () => {
    const compact = renderToStaticMarkup(<AccountCard account={account} now={now} compact />);
    const full = renderToStaticMarkup(<AccountCard account={account} now={now} />);
    expect(compact.match(/role="progressbar"/g)).toHaveLength(3);
    expect(compact).toContain('aria-label="Weekly reset:');
    expect(compact).toContain('Resets at');
    expect(compact).not.toContain('Capacity available');
    expect(full).toContain('Capacity available');
    expect(compact).toContain('>Weekly<');
    expect(full).toContain('Weekly allowance');
    const stale = renderToStaticMarkup(<AccountCard account={{ ...account, live: false, staleReason: 'Saved snapshot' }} now={now} compact />);
    expect(stale).toContain('Saved snapshot');
    expect(stale).toContain('Last known usage');
  });
  it.each(['Claude', 'Codex'])('promotes use-before-reset candidates for %s with exact thresholds', (provider) => {
    const candidate = (left: number, hours: number, short = 90) => ({ ...account, provider,
      windows: [{ ...weekly, remainingPercent: left, resetsAt: new Date(now + hours * 3600000).toISOString() },
        { ...weekly, kind: 'session', title: '5 hour', windowMinutes: 300, remainingPercent: short,
          resetsAt: new Date(now + 3600000).toISOString() }] });
    const fullest = candidate(95, 100);
    const soon = candidate(50, 47, 20);
    expect(recommendAccount([fullest, soon], provider, now)?.account).toBe(soon);
    expect(recommendAccount([fullest, soon], provider, now)?.useBeforeReset).toBe(true);
    for (const ineligible of [candidate(49.9, 24), candidate(50, 48), candidate(80, 24, 19.9), candidate(80, 0)]) {
      expect(recommendAccount([fullest, ineligible], provider, now)?.account).toBe(fullest);
    }
    const sooner = candidate(55, 12);
    expect(recommendAccount([soon, sooner], provider, now)?.account).toBe(sooner);
    const unknown = { ...soon, windows: [{ ...soon.windows[0], resetsAt: null }] };
    expect(recommendAccount([fullest, unknown], provider, now)?.account).toBe(fullest);
    expect(recommendAccount([{ ...sooner, recommendationExcluded: true }, fullest], provider, now)?.account).toBe(fullest);
  });
  it('recommends eligible fresh accounts with weekly and short-term headroom', () => {
    const candidate = (name: string, left: number) => ({ ...account, account: name,
      windows: [{ ...weekly, remainingPercent: left }] });
    const excluded = { ...candidate('Reserved', 100), recommendationExcluded: true };
    const stale = { ...candidate('Old', 100), live: false };
    const exhausted = { ...candidate('Blocked', 100), windows: [weekly, { ...weekly, windowMinutes: 300, kind: 'session', remainingPercent: 0 }] };
    const best = candidate('Best', 80);
    expect(recommendAccount([excluded, stale, exhausted, candidate('Other', 40), best], 'Claude', now)?.account).toBe(best);
    expect(recommendAccount([best], 'Codex', now)).toBeNull();
    expect(recommendAccount([best], 'Claude', now + 16 * 60_000)).toBeNull();
    expect(recommendAccount([excluded, stale, exhausted], 'Claude', now)).toBeNull();
  });
  it('orders five-hour, Fable, then weekly while retaining the weekly header reset', () => {
    expect(isMainWeekly(weekly)).toBe(true);
    expect(isMainWeekly(account.windows[1])).toBe(false);
    const html = renderToStaticMarkup(<AccountCard account={account} now={now} />);
    expect(html.indexOf('5 hour')).toBeLessThan(html.indexOf('Fable only'));
    expect(html.indexOf('Fable only')).toBeLessThan(html.indexOf('Weekly allowance'));
    expect(html).toContain('Weekly reset');
    expect(html).toContain('Fable only');
    expect(html).toContain('Example Personal');
    expect(html).toContain('>EP<');
    expect(html).not.toMatch(/live source|max plan|health-dot|Separate allowance/);
  });
  it('distinguishes exhausted capacity from stale data', () => {
    const depleted = { ...account, windows: [{ ...weekly, remainingPercent: 0 }] };
    expect(renderToStaticMarkup(<AccountCard account={depleted} now={now} />)).toContain('Limit reached');
    const stale = { ...depleted, live: false, staleReason: 'Showing saved usage' };
    const html = renderToStaticMarkup(<AccountCard account={stale} now={now + 7 * 86400000} />);
    expect(html).toContain('Last known usage');
    expect(html).not.toContain('Limit reached');
    expect(html).toContain('Awaiting updated usage');
  });
  it('does not invent missing reset times', () => {
    const html = renderToStaticMarkup(<AccountCard account={{ ...account, windows: [{ ...weekly, resetsAt: null }] }} now={now} />);
    expect(html).toContain('Reset time unavailable');
  });
  it('puts the weekly reset only in the header and uses a short session reset', () => {
    const html = renderToStaticMarkup(<AccountCard account={account} now={now} />);
    expect(html.indexOf('Weekly reset')).toBeLessThan(html.indexOf('</header>'));
    expect(html.match(/>Weekly reset</g)).toHaveLength(1);
    expect(html).toMatch(/Resets at /);
    expect(html).not.toContain('reset-label');
  });
  it('omits matching Fable resets but retains differing or unknown resets', () => {
    const render = (resetsAt: string | null) => renderToStaticMarkup(<AccountCard account={{ ...account,
      windows: [weekly, { ...account.windows[1], resetsAt }] }} now={now} />);
    expect(render(weekly.resetsAt)).not.toContain('compact-reset');
    expect(render(new Date(Date.parse(weekly.resetsAt!) - 1000).toISOString())).not.toContain('compact-reset');
    expect(render('2026-09-09T20:00:00Z')).toContain('compact-reset');
    expect(render(null)).toContain('Reset time unavailable');
  });
  it('hides Codex Spark without affecting the account capacity status or other allowances', () => {
    const codex = { ...account, provider: 'Codex', windows: [weekly,
      { ...weekly, kind: 'spark', title: 'Codex Spark 5-hour', remainingPercent: 0 },
      { ...weekly, kind: 'spark_weekly', title: 'Codex Spark Weekly', remainingPercent: 0 }] };
    expect(visibleWindows(codex)).toEqual([weekly]);
    const html = renderToStaticMarkup(<AccountCard account={codex} now={now} />);
    expect(html).not.toContain('Spark');
    expect(html).toContain('Capacity available');
    expect(codex.windows).toHaveLength(3);
  });
});
