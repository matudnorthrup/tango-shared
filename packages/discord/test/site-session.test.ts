import { beforeEach, describe, expect, it, vi } from "vitest";

const ctxStub = vi.hoisted(() => ({ cookies: vi.fn(), addCookies: vi.fn(), clearCookies: vi.fn() }));
const coreStub = vi.hoisted(() => ({ loadBrowserSiteConfigs: vi.fn(() => []) }));

vi.mock("@tango/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tango/core")>();
  return { ...actual, loadBrowserSiteConfigs: coreStub.loadBrowserSiteConfigs };
});

vi.mock("../src/browser-manager.js", () => ({
  getBrowserManager: () => ({
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    context: () => ctxStub,
  }),
  describeBrowserProfile: () => ({ expected: "/tmp/profile", actual: "/tmp/profile", matches: true }),
}));

import {
  classifyApiProbe,
  classifyPageProbe,
  cookieBelongsToSite,
  isSignInUrl,
  looksLikeSecondFactor,
  persistSiteSessionCookies,
  planCookiePersistence,
  resetSiteDescriptorCache,
  renderUrlTemplate,
  selectPrunableCookies,
  shouldPersistCookie,
  siteCookieHosts,
  type PersistableCookie,
} from "../src/site-session.js";

const scope = {
  id: "main",
  origin: "https://app.example.test",
  anchor_url: "https://app.example.test/home",
  probe: { mode: "api" as const, url: "https://app.example.test/api/me" },
};

const cookie = (overrides: Partial<PersistableCookie>): PersistableCookie => ({
  name: "session_id",
  value: "v",
  domain: "id.example.test",
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: "None",
  ...overrides,
});

describe("cookie ownership", () => {
  const hosts = siteCookieHosts({
    id: "example",
    enabled: true,
    keepalive: true,
    persistCookies: { exact: [], patterns: [] },
    pruneCookies: { patterns: [] },
    scopes: [scope],
    signIn: {
      identityOrigin: "https://id.example.test",
      usernameSelector: "#u",
      passwordSelector: "#p",
      submitSelector: "#s",
    },
  } as never);

  it("covers the site's scopes and its identity origin", () => {
    expect(hosts).toContain("app.example.test");
    expect(hosts).toContain("id.example.test");
  });

  it("matches subdomains and the shared registrable domain, not lookalikes", () => {
    expect(cookieBelongsToSite(".example.test", hosts)).toBe(true);
    expect(cookieBelongsToSite("api.example.test", hosts)).toBe(true);
    expect(cookieBelongsToSite("example.test.evil.test", hosts)).toBe(false);
    expect(cookieBelongsToSite("notexample.test", hosts)).toBe(false);
  });
});

describe("cookie persistence planning", () => {
  const rules = { exact: ["idx", "refresh_token"], patterns: ["^appSession(\\.\\d+)?$"] };

  it("persists the cookies that carry the session", () => {
    expect(shouldPersistCookie("idx", rules)).toBe(true);
    expect(shouldPersistCookie("appSession.0", rules)).toBe(true);
    expect(shouldPersistCookie("appSession", rules)).toBe(true);
  });

  it("leaves anything not on the allowlist alone", () => {
    // Analytics cookies are session-scoped too; a loose rule would quietly turn
    // telemetry into stored state.
    for (const name of ["dtCookie", "s_cc", "TAsessionID", "appSessionX"]) {
      expect(shouldPersistCookie(name, rules)).toBe(false);
    }
  });

  it("rewrites only session-scoped cookies that belong to the site", () => {
    const plan = planCookiePersistence(
      [
        cookie({ name: "idx" }),
        cookie({ name: "refresh_token", domain: ".example.test", path: "/app" }),
        cookie({ name: "dtCookie", domain: ".example.test" }),
        cookie({ name: "idx", expires: 1_795_000_000 }),
        cookie({ name: "idx", domain: "id.other.test" }),
      ],
      ["app.example.test", "id.example.test"],
      rules,
      1_800_000_000,
    );

    expect(plan.map((entry) => `${entry.domain}${entry.path}:${entry.name}`)).toEqual([
      "id.example.test/:idx",
      ".example.test/app:refresh_token",
    ]);
    expect(plan.every((entry) => entry.expires === 1_800_000_000)).toBe(true);
  });
});

describe("scratch cookie pruning", () => {
  it("selects only cookies matching the descriptor's patterns", () => {
    const doomed = selectPrunableCookies(
      [
        cookie({ name: "__txn_abc", domain: "app.example.test", path: "/mlt" }),
        cookie({ name: "__txn_def", domain: "app.example.test", path: "/mlt" }),
        cookie({ name: "idx" }),
        cookie({ name: "__txn_other", domain: "unrelated.test" }),
      ],
      ["app.example.test", "id.example.test"],
      ["^__txn_"],
    );

    expect(doomed.map((c) => c.name)).toEqual(["__txn_abc", "__txn_def"]);
  });

  it("does nothing when no patterns are configured", () => {
    expect(selectPrunableCookies([cookie({ name: "__txn_abc" })], ["id.example.test"], [])).toEqual([]);
  });
});

describe("persisting against cookie rotation", () => {
  const sessionIdx = cookie({ name: "idx" });
  const persistentIdx = { ...sessionIdx, expires: 1_800_000_000 };
  const site = {
    id: "example",
    enabled: true,
    keepalive: true,
    persistCookies: { exact: ["idx"], patterns: [] },
    pruneCookies: { patterns: [] },
    scopes: [scope],
    signIn: {
      identityOrigin: "https://id.example.test",
      usernameSelector: "#u",
      passwordSelector: "#p",
      submitSelector: "#s",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    ctxStub.addCookies.mockResolvedValue(undefined);
    coreStub.loadBrowserSiteConfigs.mockReturnValue([site]);
    resetSiteDescriptorCache();
  });

  it("re-hardens a cookie the site re-issues right after the first pass", async () => {
    // An identity provider rotates its session cookie while the page is still
    // settling, which put the session back to "dies with the browser" after a
    // single-pass persist.
    ctxStub.cookies
      .mockResolvedValueOnce([sessionIdx])
      .mockResolvedValueOnce([{ ...sessionIdx, value: "rotated" }])
      .mockResolvedValueOnce([persistentIdx]);

    const result = await persistSiteSessionCookies("example", { retryDelayMs: 0 });

    expect(ctxStub.addCookies).toHaveBeenCalledTimes(2);
    expect(result.converted).toEqual(["id.example.test/:idx"]);
  });

  it("reports the failure instead of throwing when the browser is unreachable", async () => {
    ctxStub.cookies.mockRejectedValue(new Error("browser gone"));
    const result = await persistSiteSessionCookies("example", { retryDelayMs: 0 });
    expect(result.error).toBeTruthy();
    expect(result.converted).toEqual([]);
  });
});

describe("api probe", () => {
  it("treats the configured authenticated status as signed in", () => {
    expect(classifyApiProbe("example", scope, "https://id.example.test", 200, scope.probe.url)).toMatchObject({
      authenticated: true,
      needsLogin: false,
    });
  });

  it("treats 401/403 as signed out rather than inconclusive", () => {
    for (const status of [401, 403]) {
      expect(classifyApiProbe("example", scope, "https://id.example.test", status, scope.probe.url)).toMatchObject({
        authenticated: false,
        needsLogin: true,
        inconclusive: false,
      });
    }
  });

  it("treats a bounce to the identity provider as signed out even on a 200", () => {
    expect(
      classifyApiProbe("example", scope, "https://id.example.test", 200, "https://id.example.test/authorize"),
    ).toMatchObject({ authenticated: false, needsLogin: true });
  });

  it("does not claim a sign-in is needed when the site is simply erroring", () => {
    expect(classifyApiProbe("example", scope, "https://id.example.test", 503, scope.probe.url)).toMatchObject({
      authenticated: false,
      needsLogin: false,
      inconclusive: true,
    });
  });
});

describe("page probe", () => {
  const pageScope = {
    ...scope,
    probe: { mode: "page" as const, signed_in_pattern: "directory|reports", error_pattern: "^\\s*not found\\s*$" },
  };

  it("detects the signed-in shell", () => {
    expect(
      classifyPageProbe("example", pageScope, "https://id.example.test", "https://app.example.test/home", "Directory Reports"),
    ).toMatchObject({ authenticated: true });
  });

  it("detects the sign-in bounce", () => {
    expect(
      classifyPageProbe("example", pageScope, "https://id.example.test", "https://id.example.test/authorize", "Sign In"),
    ).toMatchObject({ authenticated: false, needsLogin: true, inconclusive: false });
  });

  it("flags a moved route as inconclusive rather than a login failure", () => {
    expect(
      classifyPageProbe("example", pageScope, "https://id.example.test", "https://app.example.test/gone", "Not Found"),
    ).toMatchObject({ needsLogin: false, inconclusive: true });
  });

  it("flags a failed navigation as inconclusive", () => {
    // A browser error page is not evidence about authentication.
    expect(
      classifyPageProbe("example", pageScope, "https://id.example.test", "chrome-error://chromewebdata/", ""),
    ).toMatchObject({ needsLogin: false, inconclusive: true });
  });

  it("uses identity_url_pattern for a site that signs in on its own origin", () => {
    const sameOrigin = "^https://app\\.example\\.test/(\\?.*)?$";
    expect(
      classifyPageProbe("example", pageScope, "https://app.example.test", "https://app.example.test/home", "Directory", sameOrigin),
    ).toMatchObject({ authenticated: true });
    expect(
      classifyPageProbe("example", pageScope, "https://app.example.test", "https://app.example.test/?redirect=%2Fhome", "Log In", sameOrigin),
    ).toMatchObject({ authenticated: false, needsLogin: true });
  });
});

describe("sign-in page detection", () => {
  it("defaults to the identity origin and honors a configured pattern", () => {
    expect(isSignInUrl("https://id.example.test", "https://id.example.test/authorize")).toBe(true);
    expect(isSignInUrl("https://id.example.test", "https://app.example.test/home")).toBe(false);
    expect(isSignInUrl(undefined, "https://id.example.test/authorize")).toBe(false);
    expect(isSignInUrl("https://app.example.test", "https://app.example.test/home", "^https://app\\.example\\.test/$")).toBe(false);
    expect(isSignInUrl("https://app.example.test", "https://app.example.test/", "^https://app\\.example\\.test/$")).toBe(true);
  });
});

describe("second factor detection", () => {
  it("recognizes the common challenge prompts", () => {
    for (const prompt of [
      "Enter the verification code we sent",
      "Get a push notification — approve this sign in",
      "Enter your one-time passcode from the authenticator app",
    ]) {
      expect(looksLikeSecondFactor(prompt, false)).toBe(true);
    }
  });

  it("recognizes a code field even when the copy is unfamiliar", () => {
    expect(looksLikeSecondFactor("Something unfamiliar", true)).toBe(true);
  });

  it("does not fire on the ordinary password step", () => {
    expect(looksLikeSecondFactor("Sign In Password Verify Back", false)).toBe(false);
  });
});

describe("url templates", () => {
  it("encodes the redirect target", () => {
    expect(renderUrlTemplate("https://app.example.test/login?redirect_uri={redirect}", "/home?lang=eng")).toBe(
      "https://app.example.test/login?redirect_uri=%2Fhome%3Flang%3Deng",
    );
  });
});
