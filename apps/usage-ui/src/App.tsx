import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  formatAbsoluteTime,
  formatAge,
  formatHour,
  formatPercent,
  formatRelativeTime,
  isQuietTime,
  isSpecialWindow,
  percentLeft,
} from './format';
import { isMainWeekly, recommendAccount, visibleWindows } from './recommend';
import type { DashboardState, UsageAccount, UsageWindow } from './types';

export { isMainWeekly, recommendAccount, visibleWindows };

const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, '');

function apiPath(path: string): string {
  return `${BASE_PATH}/api/${path}`;
}

function providerClass(provider: string): string {
  return provider.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function riskClass(remaining: number | null): string {
  if (remaining === null) return 'unknown';
  if (remaining <= 10) return 'critical';
  if (remaining <= 25) return 'low';
  if (remaining <= 50) return 'watch';
  return 'healthy';
}

function resetText(window: UsageWindow, now: number): string {
  const date = new Date(window.resetsAt ?? '');
  if (!Number.isFinite(date.getTime())) return 'Reset time unavailable';
  if (date.getTime() <= now) return 'Awaiting updated usage';
  if (window.windowMinutes === 300) {
    const sameDay = date.toDateString() === new Date(now).toDateString();
    return `Resets ${sameDay ? 'at ' : ''}${new Intl.DateTimeFormat(undefined, {
      ...(sameDay ? {} : { weekday: 'short' as const }), hour: 'numeric', minute: '2-digit',
    }).format(date)}`;
  }
  return `Resets ${formatAbsoluteTime(window.resetsAt)} · ${formatRelativeTime(window.resetsAt, now).replace(/^resets /, '')}`;
}

function WindowBar({ window, now, hideReset, compact = false }: { window: UsageWindow; now: number; hideReset: boolean; compact?: boolean }) {
  const remaining = percentLeft(window);
  const special = isSpecialWindow(window);
  const weekly = isMainWeekly(window);
  const risk = riskClass(remaining);

  return (
    <div className={`window ${special ? 'special' : ''} ${weekly ? 'weekly-primary' : ''}`}>
      <div className="allowance-label">
        <h4>{weekly ? compact ? 'Weekly' : 'Weekly allowance' : window.title}</h4>
        {!hideReset && <span className="compact-reset" title={resetText(window, now)}>{compact
          ? resetText(window, now).replace(/^Resets (?:at )?/, '') : resetText(window, now)}</span>}
      </div>

      <div
        className={`meter ${risk}`}
        style={{ '--remaining': `${remaining ?? 0}%` } as CSSProperties}
        role="progressbar"
        aria-label={`${window.title}: ${formatPercent(remaining)} remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remaining ?? undefined}
      >
        <span style={{ width: `${remaining ?? 0}%` }} />
      </div>

      <div className="remaining-number"><strong>{formatPercent(remaining)}</strong><span>left</span></div>
    </div>
  );
}

export function AccountCard({ account, now, compact = false }: { account: UsageAccount; now: number; compact?: boolean }) {
  const order = (window: UsageWindow) => isMainWeekly(window) ? 3
    : window.windowMinutes === 300 ? 0 : /fable/i.test(`${window.kind} ${window.title}`) ? 1 : 2;
  const windows = visibleWindows(account).sort((a, b) => order(a) - order(b));
  const weekly = windows.find(isMainWeekly);
  const lowest = windows.reduce<number | null>((minimum, window) => {
    const remaining = percentLeft(window);
    if (remaining === null) return minimum;
    return minimum === null ? remaining : Math.min(minimum, remaining);
  }, null);
  const name = account.profileName || account.account;
  const initials = name.replace(/[()]/g, '').trim().split(/\s+/).slice(0, 2).map((word) => word[0]).join('').toUpperCase();
  const status = !account.live || account.staleReason ? 'Last known usage'
    : lowest === null ? 'Usage unavailable' : lowest === 0 ? 'Limit reached'
      : lowest <= 25 ? 'Low capacity' : lowest <= 50 ? 'Under half left' : 'Capacity available';

  return (
    <article className={`account-card ${providerClass(account.provider)} ${account.staleReason ? 'is-stale' : ''}`}>
      <header className="account-heading">
        <div className={`provider-mark ${account.profileColor ? 'account-profile-mark' : ''}`}
          style={account.profileColor ? { borderColor: account.profileColor, boxShadow: `inset 0 -5px ${account.profileColor}` } : undefined}
          title={account.profileName ? `Loom account: ${account.profileName}` : account.provider}
          aria-hidden="true">{initials}</div>
        <div className="account-name">
          <h3>{name}</h3>
          {name !== account.account && <p className="account-identity">{account.account}</p>}
          {(!compact || !account.live || account.staleReason || (lowest !== null && lowest <= 25)) &&
            <p className={`capacity-status ${account.live && !account.staleReason ? riskClass(lowest) : 'unknown'}`}>{status}</p>}
        </div>
        {weekly && <div className="header-reset" aria-label={`Weekly reset: ${formatAbsoluteTime(weekly.resetsAt)}`} title={`Weekly reset: ${formatAbsoluteTime(weekly.resetsAt)}`}>
          {!compact && <span>Weekly reset</span>}
          <strong>{compact && weekly.resetsAt && Number.isFinite(Date.parse(weekly.resetsAt))
            ? `↻ ${new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(weekly.resetsAt))}`
            : formatAbsoluteTime(weekly.resetsAt)}</strong>
          <small>{weekly.resetsAt && new Date(weekly.resetsAt).getTime() <= now
            ? 'Awaiting updated usage' : formatRelativeTime(weekly.resetsAt, now).replace(/^resets /, '')}</small>
        </div>}
      </header>

      <div className="windows">
        {account.staleReason && <p className="stale-notice" role="status">{account.staleReason}</p>}
        {windows.map((window, index) => (
          <WindowBar key={`${window.kind}-${window.title}-${index}`} window={window} now={now} compact={compact}
            hideReset={isMainWeekly(window) || (/fable/i.test(`${window.kind} ${window.title}`)
              && !!window.resetsAt && !!weekly?.resetsAt
              && Number.isFinite(Date.parse(window.resetsAt))
              // Provider timestamps can differ by a second for the same reset.
              && Math.abs(Date.parse(window.resetsAt) - Date.parse(weekly.resetsAt)) <= 2_000)} />
        ))}
      </div>

      <footer className="account-footer">
        <span>Updated {formatAge(account.updatedAt, now)}</span>
        {Number.isFinite(account.creditsRemaining) && (
          <span>{new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(account.creditsRemaining as number)} credits</span>
        )}
      </footer>
    </article>
  );
}

export function App() {
  const [compact, setCompact] = useState(() => {
    try { return localStorage.getItem('tango-usage-view') === 'compact'; } catch { return false; }
  });
  function changeView(value: boolean) {
    setCompact(value);
    try { localStorage.setItem('tango-usage-view', value ? 'compact' : 'full'); } catch { /* Works without storage. */ }
  }
  const [state, setState] = useState<DashboardState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    fetch(apiPath('usage'))
      .then(async (response) => {
        if (!response.ok) throw new Error(`Dashboard returned HTTP ${response.status}`);
        return response.json() as Promise<DashboardState>;
      })
      .then((next) => {
        if (active) setState(next);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : String(error));
      });

    const events = new EventSource(apiPath('events'));
    events.addEventListener('usage', (event) => {
      setState(JSON.parse((event as MessageEvent<string>).data) as DashboardState);
      setLoadError(null);
      setConnected(true);
    });
    events.onerror = () => setConnected(false);

    const clock = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      active = false;
      events.close();
      window.clearInterval(clock);
    };
  }, []);

  const providers = useMemo(() => {
    const grouped = new Map<string, UsageAccount[]>();
    for (const account of state?.usage?.accounts ?? []) {
      grouped.set(account.provider, [...(grouped.get(account.provider) ?? []), account]);
    }
    const preferredOrder = ['Claude', 'Codex'];
    return [...grouped.entries()].sort(([a], [b]) => {
      const aIndex = preferredOrder.indexOf(a);
      const bIndex = preferredOrder.indexOf(b);
      if (aIndex !== -1 || bIndex !== -1) return (aIndex === -1 ? 99 : aIndex) - (bIndex === -1 ? 99 : bIndex);
      return a.localeCompare(b);
    });
  }, [state]);

  async function refresh(): Promise<void> {
    setLoadError(null);
    try {
      const response = await fetch(apiPath('refresh'), { method: 'POST', headers: { 'x-tango-usage-refresh': '1' } });
      if (!response.ok) throw new Error(`Refresh returned HTTP ${response.status}`);
      setState(await response.json() as DashboardState);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }

  const schedule = state?.schedule;
  const quietHours = isQuietTime(schedule, now);

  return (
    <div className={`shell ${compact ? 'compact-view' : 'full-view'}`}>
      <header className="topbar">
        <a className="brand" href="/" aria-label="Back to Tango home">
          <span className="brand-glyph" aria-hidden="true">T</span>
          <span>Tango</span>
        </a>
        <div className="topbar-right">
          <span className={`connection ${connected ? 'online' : ''}`}>
            <i /> {connected ? 'Live updates' : 'Connecting'}
          </span>
          <span className="route">/tango-usage</span>
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="eyebrow">AI usage monitor</div>
          <div className="hero-grid">
            <div>
              <h1>Capacity at a glance.</h1>
              <p className="lede">
                Every coding account, every allowance, and the exact moment each window comes back.
              </p>
            </div>
            <div className="view-actions">
              <div className="view-toggle" role="group" aria-label="Dashboard view">
                <button aria-pressed={!compact} onClick={() => changeView(false)}>Full</button>
                <button aria-pressed={compact} onClick={() => changeView(true)}>Compact</button>
              </div>
            <button className="refresh-button" onClick={() => void refresh()} disabled={state?.refreshing}>
              <span className={state?.refreshing ? 'spinning' : ''} aria-hidden="true">↻</span>
              {state?.refreshing ? 'Checking…' : 'Check now'}
            </button>
            </div>
          </div>

          {compact && <p className="compact-key">Percent remaining · ↻ weekly reset</p>}
          <div className="summary-strip">
            {['Claude', 'Codex'].map((provider) => {
              const choice = recommendAccount(state?.usage?.accounts ?? [], provider, now);
              return <div className="summary-item recommendation" key={provider}>
                <span className="summary-label">New project · {provider}</span>
                <strong>{choice && <i style={{ background: choice.account.profileColor ?? 'var(--accent)' }} />}
                  {choice ? choice.account.profileName || choice.account.account : 'No recommendation'}</strong>
                {choice?.useBeforeReset && <span className="recommendation-reason">Use before reset</span>}
                <small>{choice ? `${formatPercent(choice.remaining)} weekly left · ${choice.useBeforeReset
                  ? formatRelativeTime(choice.resetsAt, now)
                  : choice.minimum < 20 ? 'Limited headroom' : 'Best available headroom'}` : 'Waiting for fresh, available usage'}</small>
              </div>;
            })}
            <div className="summary-item">
              <span className="summary-label">Last checked</span>
              <strong>{formatAge(state?.lastSuccessAt ?? null, now)}</strong>
              <small>{state?.usage ? formatAbsoluteTime(state.usage.generatedAt) : 'No snapshot yet'}</small>
            </div>
            <div className="summary-item">
              <span className="summary-label">Automatic checks</span>
              <strong>{quietHours ? 'Quiet hours' : `Every ${schedule?.intervalMinutes ?? 10}m`}</strong>
              <small>
                {state?.nextScheduledRefreshAt
                  ? `Next ${formatRelativeTime(state.nextScheduledRefreshAt, now).replace('resets', '')}`
                  : 'Schedule unavailable'}
              </small>
            </div>
          </div>
        </section>

        {(loadError || state?.lastError) && (
          <section className="notice error-notice" role="alert">
            <b>Latest check failed.</b>
            <span>{loadError ?? state?.lastError}</span>
            {state?.usage && <small>The last successful snapshot is still shown below.</small>}
          </section>
        )}

        {quietHours && schedule && (
          <section className="notice quiet-notice">
            <span className="moon" aria-hidden="true">☾</span>
            <div>
              <b>Quiet hours are active.</b>
              <span>
                Automatic checks pause from {formatHour(schedule.activeEndHour)} to {formatHour(schedule.activeStartHour)} {schedule.timeZone.replace('_', ' ')}.
                “Check now” still works.
              </span>
            </div>
          </section>
        )}

        {!state?.usage && !loadError && (
          <section className="loading" aria-live="polite">
            <span className="loading-ring" />
            <p>Checking every account…</p>
          </section>
        )}

        {providers.map(([provider, providerAccounts]) => (
          <section className="provider-section" key={provider}>
            <header className="section-heading">
              <div>
                <h2>{provider}</h2>
              </div>
              <span>{providerAccounts.length} {providerAccounts.length === 1 ? 'account' : 'accounts'}</span>
            </header>
            <div className={`account-grid columns-${Math.min(providerAccounts.length, 4)}`}>
              {providerAccounts.map((account, index) => (
                <AccountCard key={`${account.provider}-${account.account}-${index}`} account={account} now={now} compact={compact} />
              ))}
            </div>
          </section>
        ))}

        {(state?.usage?.errors.length ?? 0) > 0 && (
          <section className="provider-errors">
            <div className="section-heading"><div><h2>Unavailable sources</h2></div></div>
            {state?.usage?.errors.map((error, index) => (
              <div className="provider-error" key={`${error.provider}-${error.account}-${index}`}>
                <b>{error.provider} · {error.account}</b>
                <span>{error.message}</span>
              </div>
            ))}
          </section>
        )}
      </main>

      <footer className="page-footer">
        <span>Bars show capacity remaining. Account credentials never leave this machine.</span>
        <span>Auto-refresh {schedule ? `${formatHour(schedule.activeStartHour)}–${formatHour(schedule.activeEndHour)}` : 'during working hours'}.</span>
      </footer>
    </div>
  );
}
