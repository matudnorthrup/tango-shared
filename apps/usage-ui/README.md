# Tango Usage (`@tango/usage-ui`)

Tailnet-only monitoring page for coding-agent subscription quotas. It consumes
the normalized output of the local `ai-usage` command and displays every
account and every returned allowance, including regular 5-hour and 7-day
windows plus scoped limits such as Fable or Codex Spark.

## Data flow and privacy

The server runs a local collector, `"$AI_USAGE_BIN" --json --quiet` (default
`~/bin/ai-usage`). The collector is not part of this repository: it is a
per-machine script that reads provider credentials from their existing local
stores and prints quota metadata only. The browser never receives credentials.
Account labels and snapshots stay in the profile layer at
`~/.tango/profiles/<profile>/usage-monitor/` and are never checked into the
public repository.

### Collector contract

The collector prints one JSON object to stdout (it may exit non-zero when it
still has partial data):

```json
{
  "schemaVersion": 2,
  "generatedAt": "2026-01-01T17:00:00.000Z",
  "accounts": [
    {
      "provider": "Claude",
      "account": "Personal",
      "source": "claude-oauth-live",
      "live": true,
      "updatedAt": "2026-01-01T17:00:00.000Z",
      "windows": [
        { "kind": "session", "title": "5 hour", "usedPercent": 44,
          "remainingPercent": 56, "windowMinutes": 300,
          "resetsAt": "2026-01-01T20:00:00.000Z", "severity": "normal" }
      ]
    }
  ],
  "errors": [{ "provider": "Codex", "account": "Work", "message": "timeout" }]
}
```

See `server/types.ts` for the validated shape.

### Private profile files

All optional, all under `~/.tango/profiles/<profile>/usage-monitor/`
(`<profile>` is `TANGO_PROFILE`, default `default`):

| File | Purpose | Override |
|---|---|---|
| `latest.json` | Last successful snapshot (written `0600`) | `USAGE_UI_CACHE_PATH` |
| `profile-aliases.json` | `{"Provider:Account": "<Loom account name or alias>"}` to match collector accounts to Loom accounts for accent colors | `USAGE_UI_PROFILE_ALIASES` |
| `recommendation-exclusions.json` | `["Provider:Account", ...]` accounts never suggested for new projects | `USAGE_UI_RECOMMENDATION_EXCLUSIONS` |
| `renewal/` | Claude renewal backoff state and locks | `USAGE_UI_RENEWAL_DIR` |

Account names and aliases come from Loom’s native accounts file
(`~/.tango/loom/accounts.json`, override `LOOM_ACCOUNTS`). An optional
`accentColor` on an account supplies its dashboard color; only `usageName`
(or `name`) and that color reach the dashboard.

The last successful snapshot is persisted with owner-only permissions. If a
provider check fails, the page keeps that snapshot visible and clearly labels
the failure instead of replacing useful data with an empty dashboard.

## Refresh policy

- Automatic collection every 10 minutes from 06:00 through 20:59 in
  `America/Los_Angeles`. The provider usage endpoint is shared with coding sessions
  and the Claude apps, which poll it per profile on their own; more frequent
  checks drew rate limits (HTTP 429, Retry-After up to an hour). The collector
  should honor a 429 by backing that account off rather than retrying on the
  next tick.
- No provider calls from 21:00 through 05:59.
- **Check now** always forces a refresh, including during quiet hours.
- Server-sent events update open dashboards immediately after each check.

All values are configurable with `USAGE_UI_REFRESH_MINUTES`,
`USAGE_UI_ACTIVE_START_HOUR`, `USAGE_UI_ACTIVE_END_HOUR`, and
`USAGE_UI_TIME_ZONE`.

### Claude credential renewal

Before collection, the macOS server checks enabled Claude accounts from Loom's
accounts file (`configDir` selects each Claude home). Refreshable credentials within ten minutes of expiry (or already
expired after quiet hours) are passed through Claude Code's native refresh
path: a temporary PTY runs the built-in `/usage` command, with hooks and MCP
servers disabled, and exits as soon as a renewed Keychain credential is observed.
This makes no model inference request. The server does not exchange refresh
tokens itself, copy them to files, or replace long-lived coding tokens.

Claude handles credential rotation and its own locking. An additional
per-profile lock prevents overlapping dashboard renewal sessions. Failed
attempts back off for 5, 10, 20, 40, then 60 minutes; retry state survives service
restarts and is reset when a different credential is observed. An unreadable,
missing, or non-refreshable credential never starts an interactive login.
Temporary sessions have a 45-second deadline and are terminated on completion.

Requires `/usr/bin/python3` for its standard-library PTY bridge. Set
`USAGE_UI_CLAUDE_BIN` to the actual Claude executable, not a wrapper that injects
a long-lived token. Loom accounts can be overridden with `LOOM_ACCOUNTS`;
private renewal state defaults to the profile's `usage-monitor/renewal` directory
and can be overridden with `USAGE_UI_RENEWAL_DIR`.

Expired access tokens no longer imply that browser login is necessary. Revoked
refresh tokens or removed credentials may still require signing in. During
source failures the dashboard preserves account snapshots and timestamps, marks
them stale, and restores live status after a successful check. Native CLI
authentication/terminal behavior can change across Claude releases; failed
renewal is bounded and retries automatically rather than claiming success.

## Running

```bash
npm run build -w @tango/usage-ui
npm run usage-ui:start
npm run usage-ui:status
npm run usage-ui:restart
```

The service is **disabled by default** in `config/defaults/startup.yaml`
because it needs a collector. Enable it in the profile overlay
(`~/.tango/profiles/<profile>/config/startup.yaml`):

```yaml
services:
  - id: usage-ui
    enabled: true
```

Defaults: port `9380`, loopback host `127.0.0.1`, and base path
`/tango-usage`. `USAGE_UI_BASE_PATH` is read by both the server and the Vite
build, so set it when building as well as when running.

**Check now** (`POST /api/refresh`) requires the `x-tango-usage-refresh: 1`
header and a same-host `Origin`, so other web pages cannot force collection or
credential renewal. Override the collector with `AI_USAGE_BIN` and the snapshot
location with `USAGE_UI_CACHE_PATH`.

The loopback bind is intentional. Tailnet membership is the authentication
boundary, matching Tango Food and Tango Lift.

## Tailscale

```bash
tailscale serve --bg --set-path /tango-usage http://127.0.0.1:9380
```

The page is then available at
`https://<host>.<tailnet>.ts.net/tango-usage/`.

## Verification

```bash
npm run typecheck -w @tango/usage-ui
npm test -w @tango/usage-ui
npm run build -w @tango/usage-ui
```

## New-project suggestions

The dashboard recommends one account per provider from fresh live snapshots (under
15 minutes old). It excludes exhausted, unknown, stale, or reset-pending limits,
ignores hidden Spark allowances, and prioritizes accounts with at least 20% in
every visible limit before ranking by weekly capacity remaining. These are usage
heuristics, not guarantees about how much a project will consume. An account with
at least 50% weekly capacity, at least 20% in every visible limit, and a weekly
reset strictly less than 48 hours away is promoted with a “Use before reset”
label. Among qualifying accounts, the soonest reset wins; ties favor greater
weekly headroom. Missing/invalid reset dates never qualify for this promotion.

Optional private exclusions are a JSON array of `Provider:Account` keys at
`~/.tango/profiles/<profile>/usage-monitor/recommendation-exclusions.json`, overridable
with `USAGE_UI_RECOMMENDATION_EXCLUSIONS`. Invalid or unreadable preferences disable
recommendations; a missing file means no exclusions. Keep real account names out
of tracked source. Exclusions do not hide account cards or stop collection.
