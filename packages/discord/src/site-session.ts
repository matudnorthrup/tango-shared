/**
 * Site Session — keep a logged-in browser session alive for an authenticated site.
 *
 * Which sites exist, their URLs, sign-in selectors, probes, and credential
 * references are NOT in this repo: they describe one operator's accounts. They
 * come from descriptors in the profile layer
 * (`<profile>/config/browser-sites/*.yaml`); this module is the machinery that
 * reads them. See docs/guides/browser-sessions.md.
 *
 * The shape it handles: a site where one identity provider holds the real
 * session and each app mints its own short-lived token from it. That yields
 * three failure modes, and one escalation ladder that covers all of them:
 *
 *   1. probe    cheap, unambiguous auth check per scope
 *   2. silent   re-mint an expired app token from a live SSO session, no password
 *   3. login    deterministic sign-in from the configured 1Password item
 *   4. persist  rewrite session-scoped auth cookies with a real expiry, so the
 *               login survives a browser restart (they stay in the browser's own
 *               encrypted cookie store; nothing is written to disk here)
 *
 * Callers use ensureSiteSession() before authenticated work and siteFetch() for
 * the call itself, which keeps traffic on a tab pinned to the site's origin
 * rather than whatever page another workflow left the shared tab on.
 */

import type { BrowserContext, Page } from "playwright-core";
import {
  loadBrowserSiteConfigs,
  type BrowserSiteConfig,
  type BrowserSiteScopeConfig,
} from "@tango/core";
import { getBrowserManager, describeBrowserProfile } from "./browser-manager.js";
import { getOneTimePassword, getSecret, isOpAvailable } from "./op-secret.js";

const debug = (...args: unknown[]) => {
  console.error("[site-session]", ...args);
};

export type SiteAuthProbe = {
  site: string;
  scope: string;
  authenticated: boolean;
  needsLogin: boolean;
  inconclusive: boolean;
  detail: string;
  status?: number | null;
  url?: string | null;
};

export type SitePersistResult = {
  converted: string[];
  alreadyPersistent: number;
  expiresAt: string | null;
  error?: string;
};

export type SiteSessionResult = {
  site: string;
  scope: string;
  authenticated: boolean;
  needsLogin: boolean;
  needsSecondFactor?: boolean;
  path: "already-authenticated" | "silent-sso" | "credential-login" | "failed";
  steps: Array<Record<string, unknown>>;
  probe: SiteAuthProbe;
  persisted?: SitePersistResult | null;
  profile?: ReturnType<typeof describeBrowserProfile>;
  message: string;
};

export type SiteFetchResult = {
  ok: boolean;
  status: number | null;
  statusText: string | null;
  url: string | null;
  body: unknown;
  error?: string;
};

/* -------------------------------------------------------------------------- */
/* Descriptors                                                                 */
/* -------------------------------------------------------------------------- */

let cachedSites: BrowserSiteConfig[] | null = null;

export function loadSiteDescriptors(): BrowserSiteConfig[] {
  if (!cachedSites) {
    cachedSites = loadBrowserSiteConfigs();
  }
  return cachedSites;
}

/** Test seam: drop the descriptor cache. */
export function resetSiteDescriptorCache(): void {
  cachedSites = null;
}

export function getSiteDescriptor(siteId: string): BrowserSiteConfig {
  const site = loadSiteDescriptors().find((entry) => entry.id === siteId);
  if (!site) {
    throw new Error(
      `No browser-site descriptor '${siteId}' is configured. Add <profile>/config/browser-sites/${siteId}.yaml.`,
    );
  }
  return site;
}

function getScope(site: BrowserSiteConfig, scopeId?: string): BrowserSiteScopeConfig {
  const scope = scopeId
    ? site.scopes.find((entry) => entry.id === scopeId)
    : site.scopes[0];
  if (!scope) {
    throw new Error(`Site '${site.id}' has no scope '${scopeId ?? "(default)"}'.`);
  }
  return scope;
}

/** Find the configured site+scope that owns a URL, if any. */
export function siteScopeForUrl(url: string): { site: BrowserSiteConfig; scope: BrowserSiteScopeConfig } | null {
  let origin: string;
  let host: string;
  try {
    const parsed = new URL(url);
    origin = parsed.origin;
    host = parsed.hostname.toLowerCase();
  } catch {
    return null;
  }

  for (const site of loadSiteDescriptors()) {
    const exact = site.scopes.find((scope) => scope.origin === origin);
    if (exact) {
      return { site, scope: exact };
    }
  }

  // A sibling host of a configured scope (an identity origin, an API subdomain)
  // belongs to that site's default scope: the session is shared across them.
  for (const site of loadSiteDescriptors()) {
    const hosts = [
      ...site.scopes.map((scope) => new URL(scope.origin).hostname.toLowerCase()),
      ...(site.signIn ? [new URL(site.signIn.identityOrigin).hostname.toLowerCase()] : []),
    ];
    if (hosts.some((candidate) => host === candidate || sharesRegistrableDomain(host, candidate))) {
      return { site, scope: getScope(site) };
    }
  }
  return null;
}

/** True when two hosts sit under the same two-label domain (a.example.org / b.example.org). */
function sharesRegistrableDomain(a: string, b: string): boolean {
  const tail = (host: string) => host.split(".").slice(-2).join(".");
  const shared = tail(a);
  return shared.includes(".") && shared === tail(b);
}

/* -------------------------------------------------------------------------- */
/* Pure helpers (unit tested)                                                  */
/* -------------------------------------------------------------------------- */

export type PersistableCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
};

/**
 * Whether a cookie carries the session and is worth making survive a restart.
 * An allowlist on purpose: analytics cookies are session-scoped too, and a loose
 * pattern would quietly turn telemetry into stored state.
 */
export function shouldPersistCookie(
  name: string,
  rules: { exact: string[]; patterns: string[] },
): boolean {
  if (rules.exact.includes(name)) {
    return true;
  }
  return rules.patterns.some((pattern) => {
    try {
      return new RegExp(pattern).test(name);
    } catch {
      return false;
    }
  });
}

/** Hosts whose cookies this site owns, used to scope the cookie jar sweep. */
export function siteCookieHosts(site: BrowserSiteConfig): string[] {
  const hosts = site.scopes.map((scope) => new URL(scope.origin).hostname.toLowerCase());
  if (site.signIn) {
    hosts.push(new URL(site.signIn.identityOrigin).hostname.toLowerCase());
  }
  return [...new Set(hosts)];
}

export function cookieBelongsToSite(domain: string, hosts: string[]): boolean {
  const normalized = domain.replace(/^\./u, "").toLowerCase();
  return hosts.some(
    (host) =>
      normalized === host ||
      normalized.endsWith(`.${host}`) ||
      sharesRegistrableDomain(normalized, host),
  );
}

/**
 * Pick the session-scoped auth cookies to rewrite with a real expiry.
 * `expires === -1` is Playwright's marker for "dies with the browser".
 */
export function planCookiePersistence(
  cookies: PersistableCookie[],
  hosts: string[],
  rules: { exact: string[]; patterns: string[] },
  expiresAtSeconds: number,
): PersistableCookie[] {
  return cookies
    .filter(
      (cookie) =>
        cookieBelongsToSite(cookie.domain, hosts) &&
        cookie.expires === -1 &&
        shouldPersistCookie(cookie.name, rules),
    )
    .map((cookie) => ({ ...cookie, expires: expiresAtSeconds }));
}

/**
 * Whether a URL is the site's sign-in page. Usually that is anything on the
 * identity origin; a site that signs in on its own origin configures
 * `identity_url_pattern` instead, since its signed-in pages share that origin.
 */
export function isSignInUrl(
  identityOrigin: string | undefined,
  url: string,
  identityUrlPattern?: string,
): boolean {
  if (identityUrlPattern) {
    try {
      return new RegExp(identityUrlPattern, "u").test(url);
    } catch {
      return false;
    }
  }
  return Boolean(identityOrigin && url.startsWith(identityOrigin));
}

/** Interpret an api-mode probe response. */
export function classifyApiProbe(
  siteId: string,
  scope: BrowserSiteScopeConfig,
  identityOrigin: string | undefined,
  status: number,
  finalUrl: string,
  identityUrlPattern?: string,
): SiteAuthProbe {
  const base = { site: siteId, scope: scope.id };
  const authenticatedStatus = scope.probe.authenticated_status ?? [200];
  const signedOutStatus = scope.probe.signed_out_status ?? [401, 403];
  const bouncedToSignIn = isSignInUrl(identityOrigin, finalUrl, identityUrlPattern);

  if (authenticatedStatus.includes(status) && !bouncedToSignIn) {
    return { ...base, authenticated: true, needsLogin: false, inconclusive: false, detail: `probe returned ${status}`, status, url: finalUrl };
  }
  if (signedOutStatus.includes(status) || bouncedToSignIn) {
    return {
      ...base,
      authenticated: false,
      needsLogin: true,
      inconclusive: false,
      detail: bouncedToSignIn ? "probe redirected to the sign-in page" : `probe returned ${status}`,
      status,
      url: finalUrl,
    };
  }
  return {
    ...base,
    authenticated: false,
    needsLogin: false,
    inconclusive: true,
    detail: `probe returned an unexpected status ${status}`,
    status,
    url: finalUrl,
  };
}

/** Interpret where a page-mode probe navigation landed. */
export function classifyPageProbe(
  siteId: string,
  scope: BrowserSiteScopeConfig,
  identityOrigin: string | undefined,
  finalUrl: string,
  bodyText: string,
  identityUrlPattern?: string,
): SiteAuthProbe {
  const base = { site: siteId, scope: scope.id, url: finalUrl };
  const text = bodyText.replace(/\s+/gu, " ").trim();

  if (isSignInUrl(identityOrigin, finalUrl, identityUrlPattern)) {
    return { ...base, authenticated: false, needsLogin: true, inconclusive: false, detail: "redirected to the sign-in page" };
  }
  if (!finalUrl.startsWith(scope.origin)) {
    return { ...base, authenticated: false, needsLogin: false, inconclusive: true, detail: `navigation ended somewhere unexpected: ${finalUrl}` };
  }
  if (scope.probe.error_pattern && new RegExp(scope.probe.error_pattern, "iu").test(text)) {
    return { ...base, authenticated: false, needsLogin: false, inconclusive: true, detail: "the site returned an error page — the route may have moved" };
  }
  if (scope.probe.signed_in_pattern && new RegExp(scope.probe.signed_in_pattern, "iu").test(text)) {
    return { ...base, authenticated: true, needsLogin: false, inconclusive: false, detail: "rendered the signed-in shell" };
  }
  return { ...base, authenticated: false, needsLogin: false, inconclusive: true, detail: "page loaded but no signed-in markers were found" };
}

const DEFAULT_SECOND_FACTOR_PATTERN =
  "verification code|enter the code|one[-\\s]?time|security code|authenticator|passcode|approve this sign|push notification|verify your identity|send a code";

/** Recognize an MFA challenge from the sign-in page's own words. */
export function looksLikeSecondFactor(
  bodyText: string,
  hasNonCredentialInput: boolean,
  pattern = DEFAULT_SECOND_FACTOR_PATTERN,
): boolean {
  if (hasNonCredentialInput) {
    return true;
  }
  try {
    return new RegExp(pattern, "iu").test(bodyText.replace(/\s+/gu, " "));
  } catch {
    return false;
  }
}

/** Fill a `{redirect}` placeholder in a configured URL template. */
export function renderUrlTemplate(template: string, redirectPath: string): string {
  return template.replace("{redirect}", encodeURIComponent(redirectPath));
}

/* -------------------------------------------------------------------------- */
/* Credentials                                                                 */
/* -------------------------------------------------------------------------- */

function envValue(name: string): string | null {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function siteCredentialRef(site: BrowserSiteConfig): {
  vault: string | null;
  item: string | null;
  missing: string[];
} {
  if (!site.credential) {
    return { vault: null, item: null, missing: ["credential"] };
  }
  const vault = envValue(site.credential.vaultEnv);
  const item = envValue(site.credential.itemEnv);
  return {
    vault,
    item,
    missing: [
      ...(vault ? [] : [site.credential.vaultEnv]),
      ...(item ? [] : [site.credential.itemEnv]),
    ],
  };
}

type CredentialLoad =
  | { ok: true; username: string; password: string; vault: string; item: string }
  | { ok: false; error: string; missingConfig?: string[]; missingFields?: string[]; opAvailable: boolean };

async function loadSiteCredentials(site: BrowserSiteConfig): Promise<CredentialLoad> {
  const ref = siteCredentialRef(site);
  if (!ref.vault || !ref.item) {
    return {
      ok: false,
      error: `The 1Password login for site '${site.id}' is not configured (${ref.missing.join(", ")}).`,
      missingConfig: ref.missing,
      opAvailable: isOpAvailable(),
    };
  }
  if (!isOpAvailable()) {
    return {
      ok: false,
      error: "The 1Password service account is not available to this process, so the password cannot be read.",
      opAvailable: false,
    };
  }

  const [username, password] = await Promise.all([
    getSecret(ref.vault, ref.item, "username"),
    getSecret(ref.vault, ref.item, "password"),
  ]);
  if (!username || !password) {
    return {
      ok: false,
      error: `The 1Password item for site '${site.id}' is missing username or password.`,
      missingFields: [...(username ? [] : ["username"]), ...(password ? [] : ["password"])],
      opAvailable: true,
    };
  }
  return { ok: true, username, password, vault: ref.vault, item: ref.item };
}

/* -------------------------------------------------------------------------- */
/* Browser plumbing                                                            */
/* -------------------------------------------------------------------------- */

async function scopePage(scope: BrowserSiteScopeConfig): Promise<Page> {
  const manager = getBrowserManager();
  await manager.ensureConnected(9223);
  return manager.pageForOrigin(scope.origin, scope.anchor_url);
}

async function browserContext(): Promise<BrowserContext> {
  const manager = getBrowserManager();
  await manager.ensureConnected(9223);
  return manager.context();
}

/**
 * Run an authenticated call from a tab pinned to the scope's origin, so cookies
 * are actually sent and a sibling workflow cannot move the page out from under it.
 */
export async function siteFetch(
  siteId: string,
  scopeId: string,
  input: { url: string; method?: string; body?: unknown },
): Promise<SiteFetchResult> {
  const site = getSiteDescriptor(siteId);
  const scope = getScope(site, scopeId);
  const page = await scopePage(scope);

  let currentOrigin = "";
  try {
    currentOrigin = new URL(page.url()).origin;
  } catch {
    currentOrigin = "";
  }
  if (currentOrigin !== scope.origin) {
    await page
      .goto(scope.anchor_url, { waitUntil: "domcontentloaded", timeout: 45_000 })
      .catch((err) => debug("re-anchor navigation failed", err));
  }

  return page.evaluate(
    async ({ url, method, body }) => {
      try {
        const response = await fetch(url, {
          method: method ?? "GET",
          credentials: "include",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        let parsed: unknown = null;
        if (text.length > 0) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
        }
        return { ok: response.ok, status: response.status, statusText: response.statusText, url: response.url, body: parsed };
      } catch (err) {
        return {
          ok: false,
          status: null,
          statusText: null,
          url: null,
          body: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    { url: input.url, method: input.method ?? "GET", body: input.body },
  ) as Promise<SiteFetchResult>;
}

/* -------------------------------------------------------------------------- */
/* Probes                                                                      */
/* -------------------------------------------------------------------------- */

export async function probeSiteAuth(siteId: string, scopeId?: string): Promise<SiteAuthProbe> {
  const site = getSiteDescriptor(siteId);
  const scope = getScope(site, scopeId);
  const identityOrigin = site.signIn?.identityOrigin;
  const identityUrlPattern = site.signIn?.identityUrlPattern;

  if (scope.probe.mode === "api") {
    if (!scope.probe.url) {
      throw new Error(`Scope '${site.id}/${scope.id}' uses an api probe but has no probe.url.`);
    }
    const result = await siteFetch(site.id, scope.id, { url: scope.probe.url });
    if (result.status === null) {
      return {
        site: site.id,
        scope: scope.id,
        authenticated: false,
        needsLogin: false,
        inconclusive: true,
        detail: `probe could not run: ${result.error ?? "unknown error"}`,
        status: null,
        url: null,
      };
    }
    return classifyApiProbe(
      site.id,
      scope,
      identityOrigin,
      result.status,
      result.url ?? scope.probe.url,
      identityUrlPattern,
    );
  }

  const page = await scopePage(scope);
  await page
    .goto(scope.anchor_url, { waitUntil: "domcontentloaded", timeout: 60_000 })
    .catch((err) => debug("page probe navigation issue", err));
  await page.waitForTimeout(2_500);
  const bodyText = await page
    .evaluate(() => (document.body?.innerText ?? "").slice(0, 4000))
    .catch(() => "");
  return classifyPageProbe(site.id, scope, identityOrigin, page.url(), bodyText, identityUrlPattern);
}

/* -------------------------------------------------------------------------- */
/* Cookie persistence                                                          */
/* -------------------------------------------------------------------------- */

const PERSIST_TTL_DAYS = 30;

/**
 * Give the session-scoped auth cookies a real expiry so the login is not
 * discarded the next time the browser restarts. This does not extend the
 * server-side session — it stops us from throwing away one that is still valid.
 *
 * Runs more than one pass on purpose. A page that is still settling can re-issue
 * its session cookie a second or two after we harden it, which silently puts the
 * session back to "dies with the browser".
 */
export async function persistSiteSessionCookies(
  siteId: string,
  options: { ttlDays?: number; passes?: number; retryDelayMs?: number } = {},
): Promise<SitePersistResult> {
  const ttlDays = options.ttlDays ?? PERSIST_TTL_DAYS;
  const passes = options.passes ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 1_500;
  try {
    const site = getSiteDescriptor(siteId);
    const hosts = siteCookieHosts(site);
    const ctx = await browserContext();
    const converted = new Set<string>();
    let expiresAtSeconds = 0;
    let alreadyPersistent = 0;

    for (let pass = 0; pass < passes; pass += 1) {
      if (pass > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
      const cookies = (await ctx.cookies()) as PersistableCookie[];
      const siteCookies = cookies.filter((cookie) => cookieBelongsToSite(cookie.domain, hosts));
      alreadyPersistent = siteCookies.filter(
        (cookie) => cookie.expires !== -1 && shouldPersistCookie(cookie.name, site.persistCookies),
      ).length;

      expiresAtSeconds = Math.floor(Date.now() / 1000) + ttlDays * 24 * 3600;
      const plan = planCookiePersistence(siteCookies, hosts, site.persistCookies, expiresAtSeconds);
      if (plan.length === 0) {
        break;
      }

      await ctx.addCookies(
        plan.map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          expires: cookie.expires,
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
          sameSite: cookie.sameSite,
        })),
      );
      for (const cookie of plan) {
        converted.add(`${cookie.domain}${cookie.path}:${cookie.name}`);
      }
    }

    return {
      converted: [...converted],
      alreadyPersistent,
      expiresAt: converted.size > 0 ? new Date(expiresAtSeconds * 1000).toISOString() : null,
    };
  } catch (err) {
    return { converted: [], alreadyPersistent: 0, expiresAt: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Which of the site's cookies are scratch, per the descriptor's patterns. */
export function selectPrunableCookies(
  cookies: PersistableCookie[],
  hosts: string[],
  patterns: string[],
): PersistableCookie[] {
  if (patterns.length === 0) {
    return [];
  }
  return cookies.filter(
    (cookie) =>
      cookieBelongsToSite(cookie.domain, hosts) &&
      patterns.some((pattern) => {
        try {
          return new RegExp(pattern).test(cookie.name);
        } catch {
          return false;
        }
      }),
  );
}

/**
 * Drop the site's scratch cookies once a session is established.
 *
 * Some sign-in flows leave a per-transaction cookie behind whenever a round
 * trip is abandoned. They are individually small and permanently useless, but
 * they accumulate until the request header is large enough for the server to
 * reject it outright (HTTP 431), which presents as the site suddenly refusing
 * to load rather than as anything to do with auth.
 */
export async function pruneSiteScratchCookies(siteId: string): Promise<string[]> {
  const site = getSiteDescriptor(siteId);
  if (site.pruneCookies.patterns.length === 0) {
    return [];
  }
  try {
    const hosts = siteCookieHosts(site);
    const ctx = await browserContext();
    const cookies = (await ctx.cookies()) as PersistableCookie[];
    const doomed = selectPrunableCookies(cookies, hosts, site.pruneCookies.patterns);
    for (const cookie of doomed) {
      await ctx.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path }).catch(() => undefined);
    }
    return doomed.map((cookie) => cookie.name);
  } catch (err) {
    debug("cookie prune failed", err);
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Sign-in                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Re-mint an app token from a live SSO session. With a valid identity-provider
 * session this completes without interaction, which is the correct fix for the
 * common case of an expired short-lived app token.
 */
async function attemptSilentSso(
  scope: BrowserSiteScopeConfig,
  targetPath?: string,
): Promise<Record<string, unknown>> {
  const page = await scopePage(scope);
  const redirect = targetPath?.startsWith("/") ? targetPath : scope.default_redirect_path ?? "/";
  const url = scope.silent_refresh_url_template
    ? renderUrlTemplate(scope.silent_refresh_url_template, redirect)
    : scope.anchor_url;

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((err) => {
    debug("silent SSO navigation issue", err);
  });
  await page.waitForTimeout(2_500);
  return { step: "silent-sso", url, landedOn: page.url() };
}

/** Wait for whichever of two fields becomes visible first. */
async function waitForEitherField(
  first: ReturnType<Page["locator"]>,
  second: ReturnType<Page["locator"]>,
  timeoutMs: number,
): Promise<"username" | "password" | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await first.isVisible().catch(() => false)) return "username";
    if (await second.isVisible().catch(() => false)) return "password";
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return null;
}

type LoginOutcome = {
  ok: boolean;
  needsSecondFactor: boolean;
  steps: Array<Record<string, unknown>>;
  message: string;
};

/**
 * Deterministic sign-in using the descriptor's selectors. Identifier and
 * password are handled as separate steps because identity providers commonly
 * split them; a single-page form works too, since the password step simply
 * appears immediately.
 */
async function performCredentialLogin(
  site: BrowserSiteConfig,
  scope: BrowserSiteScopeConfig,
  credentials: { username: string; password: string; vault: string; item: string },
  targetPath?: string,
): Promise<LoginOutcome> {
  const steps: Array<Record<string, unknown>> = [];
  const signIn = site.signIn;
  if (!signIn) {
    return { ok: false, needsSecondFactor: false, steps, message: `Site '${site.id}' has no sign_in configuration.` };
  }

  const page = await scopePage(scope);
  const redirect = targetPath?.startsWith("/") ? targetPath : scope.default_redirect_path ?? "/";
  const startUrl = scope.silent_refresh_url_template
    ? renderUrlTemplate(scope.silent_refresh_url_template, redirect)
    : scope.anchor_url;

  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((err) => {
    debug("login navigation issue", err);
  });
  await page.waitForTimeout(1_500);
  steps.push({ step: "open-login", landedOn: page.url() });

  const onSignInPage = () => isSignInUrl(signIn.identityOrigin, page.url(), signIn.identityUrlPattern);

  if (!onSignInPage()) {
    steps.push({ step: "no-sign-in-required", landedOn: page.url() });
    return { ok: true, needsSecondFactor: false, steps, message: "Session restored without entering credentials." };
  }

  // Mark the tab on the identity origin too. Without this a later run cannot
  // recognise its own tab while it sits mid-sign-in and opens another, leaving
  // the first stranded partway through the flow.
  await page
    .evaluate(() => window.sessionStorage.setItem("tango:owned-tab", "1"))
    .catch(() => undefined);

  const usernameField = page.locator(signIn.usernameSelector).first();
  const passwordField = page.locator(signIn.passwordSelector).first();

  // The identifier step may be skipped entirely: an identity provider that
  // already knows the account resumes at the password step, and so does a flow
  // a previous attempt left partway through. Wait for whichever appears.
  const step = await waitForEitherField(usernameField, passwordField, 20_000);
  if (step === null) {
    steps.push({ step: "sign-in-form", found: false, landedOn: page.url() });
    await returnToAnchor(page, scope);
    return {
      ok: false,
      needsSecondFactor: false,
      steps,
      message: "The sign-in page presented neither a username nor a password field.",
    };
  }

  const submit = async (field: ReturnType<Page["locator"]>) => {
    const button = page.locator(signIn.submitSelector).first();
    if ((await button.count().catch(() => 0)) > 0) {
      await button.click({ timeout: 10_000 }).catch(() => field.press("Enter"));
    } else {
      await field.press("Enter");
    }
  };

  const singleStep = signIn.singleStepForm === true && step === "username";
  if (singleStep) {
    await usernameField.fill(credentials.username);
    steps.push({ step: "fill-username", ok: true, singleStepForm: true });
  } else if (step === "username") {
    await usernameField.fill(credentials.username);
    await submit(usernameField);
    steps.push({ step: "submit-username", ok: true });
  } else {
    steps.push({ step: "submit-username", skipped: "resumed at the password step" });
  }

  const passwordReady = step === "password"
    ? true
    : await passwordField
        .waitFor({ state: "visible", timeout: 25_000 })
        .then(() => true)
        .catch(() => false);
  if (!passwordReady) {
    const body = await page.evaluate(() => (document.body?.innerText ?? "").slice(0, 1500)).catch(() => "");
    steps.push({ step: "password-field", found: false, landedOn: page.url() });
    await returnToAnchor(page, scope);
    if (looksLikeSecondFactor(body, false, signIn.secondFactorPattern)) {
      return { ok: false, needsSecondFactor: true, steps, message: "The sign-in asked for a second factor before the password step." };
    }
    return { ok: false, needsSecondFactor: false, steps, message: "The sign-in page never presented a password field after the username step." };
  }

  await passwordField.fill(credentials.password);
  await submit(passwordField);
  steps.push({ step: "submit-password", ok: true });
  await page.waitForTimeout(4_000);

  if (onSignInPage()) {
    const state = await page
      .evaluate(() => {
        const body = (document.body?.innerText ?? "").slice(0, 1500);
        const extra = [...document.querySelectorAll("input")].some((input) => {
          const el = input as HTMLInputElement;
          const visible = !!(el.offsetWidth || el.offsetHeight);
          return visible && el.type !== "password" && el.type !== "hidden" && el.autocomplete !== "username";
        });
        return { body, extra };
      })
      .catch(() => ({ body: "", extra: false }));

    if (looksLikeSecondFactor(state.body, state.extra, signIn.secondFactorPattern)) {
      const otp = await getOneTimePassword(credentials.vault, credentials.item);
      if (!otp) {
        steps.push({ step: "second-factor", totpAvailable: false, prompt: state.body.slice(0, 200) });
        return {
          ok: false,
          needsSecondFactor: true,
          steps,
          message:
            "The sign-in asked for a second factor and the 1Password item has no one-time password field. " +
            "The account owner needs to complete it once in the automation browser; if an authenticator is " +
            "enrolled, adding its secret to that item makes this self-healing again.",
        };
      }
      const codeField = page.locator(signIn.otpSelector ?? "input[autocomplete='one-time-code']").first();
      if ((await codeField.count().catch(() => 0)) === 0) {
        steps.push({ step: "second-factor", totpAvailable: true, submitted: false });
        return { ok: false, needsSecondFactor: true, steps, message: "A second factor was requested but no code field was found." };
      }
      await codeField.fill(otp);
      await submit(codeField);
      steps.push({ step: "second-factor", totpAvailable: true, submitted: true });
      await page.waitForTimeout(4_000);
    }
  }

  await returnToAnchor(page, scope);
  return { ok: true, needsSecondFactor: false, steps, message: "Submitted credentials." };
}

/**
 * Leave the tab on the scope's anchor. A tab abandoned mid-sign-in keeps the
 * identity provider's flow open, and the next attempt then resumes into a form
 * it did not expect.
 */
async function returnToAnchor(page: Page, scope: BrowserSiteScopeConfig): Promise<void> {
  try {
    if (new URL(page.url()).origin === scope.origin) {
      return;
    }
  } catch {
    /* fall through and navigate */
  }
  await page
    .goto(scope.anchor_url, { waitUntil: "domcontentloaded", timeout: 45_000 })
    .catch((err) => debug("returnToAnchor navigation failed", err));
}

/** Poll the probe until the session comes up (sign-in redirects settle async). */
async function waitForAuthenticated(siteId: string, scopeId: string, timeoutMs = 20_000): Promise<SiteAuthProbe> {
  const deadline = Date.now() + timeoutMs;
  let probe = await probeSiteAuth(siteId, scopeId);
  while (!probe.authenticated && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    probe = await probeSiteAuth(siteId, scopeId);
  }
  return probe;
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                          */
/* -------------------------------------------------------------------------- */

/** Harden the session cookies and drop the scratch ones in one step. */
async function persistAndPrune(siteId: string): Promise<SitePersistResult> {
  const persisted = await persistSiteSessionCookies(siteId);
  await pruneSiteScratchCookies(siteId);
  return persisted;
}

// One sign-in at a time per site+scope. Two tools racing into the credential
// flow log each other out mid-redirect, which reads as a flaky password.
const inFlight = new Map<string, Promise<SiteSessionResult>>();

export async function ensureSiteSession(
  options: { site: string; scope?: string; url?: string; allowLogin?: boolean },
): Promise<SiteSessionResult> {
  const site = getSiteDescriptor(options.site);
  const scope = getScope(site, options.scope);
  const key = `${site.id}/${scope.id}`;
  const existing = inFlight.get(key);
  if (existing) {
    return existing;
  }
  const run = ensureSiteSessionInner(site, scope, options).then(async (result) => {
    if (result.authenticated) {
      await getBrowserManager().cleanupSessionTabs(scope.origin).catch(() => undefined);
    }
    return result;
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

async function ensureSiteSessionInner(
  site: BrowserSiteConfig,
  scope: BrowserSiteScopeConfig,
  options: { url?: string; allowLogin?: boolean },
): Promise<SiteSessionResult> {
  const steps: Array<Record<string, unknown>> = [];
  const profile = describeBrowserProfile(9223);
  if (profile.matches === false) {
    steps.push({
      step: "profile-mismatch",
      expected: profile.expected,
      actual: profile.actual,
      note: "The connected browser is running a different profile than this process resolves, so its saved logins are a different cookie jar.",
    });
  }

  let targetPath: string | undefined;
  if (options.url) {
    try {
      const parsed = new URL(options.url, scope.anchor_url);
      targetPath = `${parsed.pathname}${parsed.search}`;
    } catch {
      targetPath = undefined;
    }
  }

  const base = { site: site.id, scope: scope.id, profile };

  const first = await probeSiteAuth(site.id, scope.id);
  steps.push({ step: "probe", ...first });
  if (first.authenticated) {
    return {
      ...base,
      authenticated: true,
      needsLogin: false,
      path: "already-authenticated",
      steps,
      probe: first,
      persisted: await persistAndPrune(site.id),
      message: `${site.displayName ?? site.id} ${scope.id} session is authenticated.`,
    };
  }

  steps.push(await attemptSilentSso(scope, targetPath));
  const afterSilent = await probeSiteAuth(site.id, scope.id);
  steps.push({ step: "probe-after-silent-sso", ...afterSilent });
  if (afterSilent.authenticated) {
    return {
      ...base,
      authenticated: true,
      needsLogin: false,
      path: "silent-sso",
      steps,
      probe: afterSilent,
      persisted: await persistAndPrune(site.id),
      message: `${site.displayName ?? site.id} ${scope.id} session was restored from the existing single sign-on session (no password needed).`,
    };
  }

  if (options.allowLogin === false) {
    return {
      ...base,
      authenticated: false,
      needsLogin: true,
      path: "failed",
      steps,
      probe: afterSilent,
      message: `${site.displayName ?? site.id} ${scope.id} session is signed out and credential login was not permitted for this call.`,
    };
  }

  const credentials = await loadSiteCredentials(site);
  if (!credentials.ok) {
    steps.push({ step: "credentials", ok: false, error: credentials.error });
    return {
      ...base,
      authenticated: false,
      needsLogin: true,
      path: "failed",
      steps,
      probe: afterSilent,
      message: `${credentials.error} Do not ask for the password in chat — fix the 1Password item or service-account access.`,
    };
  }

  const login = await performCredentialLogin(site, scope, credentials, targetPath);
  steps.push(...login.steps);

  const finalProbe = login.ok
    ? await waitForAuthenticated(site.id, scope.id)
    : await probeSiteAuth(site.id, scope.id);
  steps.push({ step: "probe-after-login", ...finalProbe });

  if (finalProbe.authenticated) {
    return {
      ...base,
      authenticated: true,
      needsLogin: false,
      path: "credential-login",
      steps,
      probe: finalProbe,
      persisted: await persistAndPrune(site.id),
      message: `Signed in to the ${site.displayName ?? site.id} ${scope.id} session with the configured 1Password item.`,
    };
  }

  return {
    ...base,
    authenticated: false,
    needsLogin: true,
    needsSecondFactor: login.needsSecondFactor,
    path: "failed",
    steps,
    probe: finalProbe,
    message: login.needsSecondFactor
      ? login.message
      : `Sign-in did not complete: ${login.message} Inspect the browser for a captcha, an account notice, or an upstream error.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Diagnostics + keepalive                                                     */
/* -------------------------------------------------------------------------- */

export async function siteSessionDiagnostics(siteId: string): Promise<Record<string, unknown>> {
  const site = getSiteDescriptor(siteId);
  const profile = describeBrowserProfile(9223);
  const hosts = siteCookieHosts(site);
  let cookieReport: Array<Record<string, unknown>> = [];
  let cookieError: string | null = null;
  try {
    const ctx = await browserContext();
    const cookies = (await ctx.cookies()) as PersistableCookie[];
    cookieReport = cookies
      .filter(
        (cookie) =>
          cookieBelongsToSite(cookie.domain, hosts) &&
          shouldPersistCookie(cookie.name, site.persistCookies),
      )
      .map((cookie) => ({
        cookie: `${cookie.domain}${cookie.path}:${cookie.name}`,
        persistent: cookie.expires !== -1,
        expiresAt: cookie.expires === -1 ? null : new Date(cookie.expires * 1000).toISOString(),
        survivesRestart: cookie.expires !== -1,
      }));
  } catch (err) {
    cookieError = err instanceof Error ? err.message : String(err);
  }

  const credentialRef = siteCredentialRef(site);
  return {
    site: site.id,
    displayName: site.displayName ?? site.id,
    scopes: site.scopes.map((scope) => scope.id),
    browserProfile: profile,
    profileWarning:
      profile.matches === false
        ? "The running browser uses a different profile directory than this process resolves — saved logins live in the other cookie jar."
        : null,
    credentials: {
      configured: credentialRef.missing.length === 0,
      missingConfig: credentialRef.missing,
      opAvailable: isOpAvailable(),
    },
    sessionCookies: cookieReport,
    sessionCookieError: cookieError,
    sessionSurvivesRestart:
      cookieReport.length > 0 && cookieReport.every((entry) => entry.survivesRestart === true),
  };
}

/**
 * Keep every keepalive-enabled site warm. Identity-provider sessions idle out
 * server-side, so a periodic touch is what turns "persists across restarts" into
 * "always signed in"; it also re-persists cookies the site rotated since the
 * last run.
 */
export async function runSiteSessionKeepalive(): Promise<
  Array<{ site: string; results: SiteSessionResult[]; persisted: SitePersistResult }>
> {
  const report: Array<{ site: string; results: SiteSessionResult[]; persisted: SitePersistResult }> = [];
  for (const site of loadSiteDescriptors().filter((entry) => entry.keepalive)) {
    const results: SiteSessionResult[] = [];
    for (const scope of site.scopes) {
      results.push(await ensureSiteSession({ site: site.id, scope: scope.id }));
    }
    report.push({ site: site.id, results, persisted: await persistAndPrune(site.id) });
  }
  return report;
}
