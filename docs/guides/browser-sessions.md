# Authenticated Browser Sessions

How Tango stays signed in to a site that needs a real logged-in browser.

- Engine: `packages/discord/src/site-session.ts`
- CLI: `npx tsx scripts/browser-session.ts status|ensure|persist [site]`
- Site descriptors: `<profile>/config/browser-sites/*.yaml` — **profile layer, not this repo**

## Repo layer vs profile layer

Which sites exist, their URLs, sign-in selectors, probes, and credential
references describe one operator's accounts, so they live in the profile layer.
This repo ships the machinery that reads them. A checkout with no descriptors is
inert: the keepalive job no-ops and the study-library tool reports that it is
unconfigured.

## The problem this solves

The common shape is a site where one identity provider holds the real session and
each app mints its own short-lived token from it. That produces three failures
that all look like "the login broke":

1. **Every cookie that authenticates is browser-session scoped.** The single
   sign-on cookie, an app's refresh token, and per-app session cookies all die
   when the browser restarts — so a perfectly good login is discarded and the
   next task starts with a password prompt. The cookies that *do* survive usually
   only remember the device for MFA.
2. **App tokens are short-lived** (an hour is typical). A long task, or one
   started later than that, hits a 401 mid-run.
3. **The identity session idles out server-side**, independent of any cookie.

## The escalation ladder

`ensureSiteSession({ site, scope })` runs before authenticated work and escalates
only as far as it must:

1. **Probe.** `api` mode calls a URL whose status distinguishes signed in from
   signed out; `page` mode navigates the anchor and checks whether the signed-in
   shell rendered or the identity provider intercepted.
2. **Silent single sign-on.** Navigate the scope's refresh URL, which completes
   the OIDC round trip with no interaction when the identity session is alive.
   This is the fix for an expired app token and needs no password.
3. **Credential sign-in.** Identifier step, then password step, using the
   descriptor's selectors and the site's 1Password item. Credentials never reach
   the model.
4. **Second factor.** Submitted from the item's one-time password if it has one;
   otherwise the call fails loudly saying exactly that.
5. **Persist.** Session-scoped auth cookies are rewritten with a 30-day expiry so
   the login survives a browser restart. They stay in the browser's own encrypted
   cookie store — Tango never writes session material to disk. This does not
   extend the server-side session; it stops us from discarding a valid one.

   Persisting runs several passes: a page still settling can re-issue its session
   cookie a second or two later, which silently undoes a single-pass hardening.

The `browser-session-keepalive` schedule (every 45 minutes) keeps identity
sessions from idling out and re-persists rotated cookies.

## Two other failure modes this closed

- **Origin drift.** All browser tools share one page, so a site's API calls used
  to run in whatever origin the last workflow left it on — cross-origin, no
  cookies, CORS errors that read exactly like auth failures — and navigation
  would steal another workflow's tab. Site traffic now runs on a tab pinned to
  the site's origin, and the browser manager marks its own tabs so it never
  navigates one a person is reading.
- **Profile drift.** See below.

## Browser profile: one jar

There is one automation browser on one CDP port, so there is exactly one cookie
jar: **`~/.tango/browser-profile`**. `TANGO_BROWSER_PROFILE_DIR` overrides it and
nothing else does — not `TANGO_DATA_DIR`, not `TANGO_PROFILE`, not cwd.

It used to vary, which produced three profile directories on one machine
(consolidated 2026-07-26, reclaiming 1.4 GB): the repo's `data/browser-profile`,
a per-profile `<profile>/data/browser-profile`, and an older pre-profile path.
Whichever browser claimed the port first won, so logins saved by one run were
missing in another.

Living under the Tango home rather than the repo also means `git clean -xdf`, a
worktree checkout, or moving the repo cannot delete every saved login. Worktrees
deliberately share this jar — they already shared the browser.

```bash
npx tsx scripts/consolidate-browser-profiles.ts           # plan only
npx tsx scripts/consolidate-browser-profiles.ts --apply   # quits + relaunches the browser
```

`--apply` merges cookies that exist only in an older jar, captures open tabs,
quits gracefully so the cookie store flushes, moves the profile, and reopens
whatever the browser did not restore itself. Any restart drops browser-session
cookies for *other* sites too, so expect to sign back in to some of them.

## Writing a descriptor

```yaml
id: example
display_name: Example Site
enabled: true
keepalive: true

credential:                       # 1Password item, by env var name
  vault_env: EXAMPLE_1PASSWORD_VAULT
  item_env: EXAMPLE_1PASSWORD_ITEM

sign_in:
  identity_origin: https://id.example.test
  username_selector: "#username, input[autocomplete='username']"
  password_selector: "#password, input[type='password']"
  submit_selector: "#submit, button[type='submit']"
  otp_selector: "input[autocomplete='one-time-code']"

persist_cookies:                  # allowlist: analytics cookies are session-scoped too
  exact: [session_id, refresh_token]
  patterns: ["^appSession(\\.\\d+)?$"]

scopes:
  - id: main
    origin: https://app.example.test
    anchor_url: https://app.example.test/home
    default_redirect_path: /home
    probe:
      mode: api
      url: https://app.example.test/api/me
      authenticated_status: [200]
      signed_out_status: [401, 403]
    silent_refresh_url_template: https://app.example.test/login?redirect_uri={redirect}

  - id: records
    origin: https://records.example.test
    anchor_url: https://records.example.test/list
    probe:                        # server-rendered: check the shell, not a status
      mode: page
      signed_in_pattern: "directory|reports"
      error_pattern: "^\\s*(not found|error)\\s*$"
```

Selector discipline matters: prefer stable ids over button text. A sign-in page
that renders a long language picker will happily match a text search for "next".

A `library` section may be added for the study-library annotations tool; see
`agents/tools/study-library.md`.

## Debugging

```bash
npx tsx scripts/browser-session.ts status   # report only — never signs in
npx tsx scripts/browser-session.ts ensure   # sign in if needed
npx tsx scripts/browser-session.ts persist  # harden cookies against a restart
```

`status` answers, in order, the questions that actually matter:

- Is the running browser on the profile we think it is?
- Is 1Password reachable from this process?
- Would the session survive a browser restart?
- Is each scope authenticated right now, and by what evidence?

Escalate to a human only when `status` reports a second-factor prompt, a captcha,
or missing 1Password access. Everything else is self-healing.
