# browser

Universal browser automation through the Playwright-backed browser manager.

## Input

```json
{
  "action": "launch"
}
```

## Actions

Connection:
- `launch` with optional `port` (default 9223) — starts Brave with remote debugging and connects. If already running, connects to it.
- `connect` with `cdp_url` — connect to an already-running browser (rarely needed — prefer `launch`)
- `status`
- `close`

Navigation and reading:
- `open` with `url`
- `snapshot` with optional `interactive`
- `screenshot` with optional `full_page`

Interaction:
- `click` with `ref`
- `fill` with `ref`, `value`
- `type` with `ref`, `value`
- `press` with `key`
- `select` with `ref`, `values`
- `scroll` with `direction`, optional `pixels`
- `wait` with `text`, `selector`, optional `timeout`
- `eval` with `script`

## Notes

- Use `launch` instead of `connect` — it handles starting Brave automatically.
- All runs share one cookie jar, `~/.tango/browser-profile` (override with
  `TANGO_BROWSER_PROFILE_DIR`). One browser on one port means one set of saved
  logins; worktrees and profiles do not get their own.
- `snapshot` returns page text plus numbered refs for elements.
- Refs are not stable after navigation or page changes.
- `open` on a URL belonging to a configured browser-site descriptor restores
  that site's session first and reports the outcome under `site_session`. Never
  type those passwords through `fill`/`type`; see
  [`docs/guides/browser-sessions.md`](../../docs/guides/browser-sessions.md).

## Example

```json
{
  "action": "click",
  "ref": 14
}
```
