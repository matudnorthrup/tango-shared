import { beforeEach, describe, expect, it, vi } from "vitest";

const manager = {
  launch: vi.fn(),
  status: vi.fn(),
  open: vi.fn(),
  evaluate: vi.fn(),
  wait: vi.fn(),
  ensureConnected: vi.fn(),
  pageForOrigin: vi.fn(),
  context: vi.fn(),
};

const siteSession = vi.hoisted(() => ({
  ensureSiteSession: vi.fn(),
  siteFetch: vi.fn(),
  siteSessionDiagnostics: vi.fn(),
  siteScopeForUrl: vi.fn(),
  loadSiteDescriptors: vi.fn(),
  getSiteDescriptor: vi.fn(),
}));

// A stand-in library descriptor: the real one lives in the profile layer.
const DESCRIPTOR = {
  id: "example-library",
  displayName: "Example Library",
  enabled: true,
  keepalive: true,
  persistCookies: { exact: [], patterns: [] },
  scopes: [
    {
      id: "study",
      origin: "https://library.example.test",
      anchor_url: "https://library.example.test/study",
      probe: { mode: "api" as const, url: "https://library.example.test/api/probe" },
    },
    {
      id: "records",
      origin: "https://records.example.test",
      anchor_url: "https://records.example.test/list",
      probe: { mode: "page" as const, signed_in_pattern: "records" },
    },
  ],
  library: {
    scope: "study",
    locale: "eng",
    annotations_path: "/notes/api/v3/annotations",
    content_path: "/study/api/v3/content",
    reference_root: "/works",
    books: [{ path: "one/first", name: "First Work", aliases: ["^first$"] }],
  },
};

vi.mock("../src/browser-manager.js", () => ({
  getBrowserManager: () => manager,
  describeBrowserProfile: () => ({ expected: "/tmp/profile", actual: "/tmp/profile", matches: true }),
}));

vi.mock("../src/site-session.js", async (importOriginal) => {
  // Keep the real pure helpers and stub the parts that need a live browser.
  const actual = await importOriginal<typeof import("../src/site-session.js")>();
  return {
    ...actual,
    ensureSiteSession: siteSession.ensureSiteSession,
    siteFetch: siteSession.siteFetch,
    siteSessionDiagnostics: siteSession.siteSessionDiagnostics,
    siteScopeForUrl: siteSession.siteScopeForUrl,
    loadSiteDescriptors: siteSession.loadSiteDescriptors,
    getSiteDescriptor: siteSession.getSiteDescriptor,
  };
});

import {
  createStudyLibraryTools,
  resetLibraryContextCache,
  studyLibraryActionLooksMutating,
  verseHighlightText,
} from "../src/study-library-agent-tools.js";

const authenticated = (scope: "study" | "records" = "study") => ({
  site: "example-library",
  scope,
  authenticated: true,
  needsLogin: false,
  path: "already-authenticated" as const,
  steps: [],
  probe: { site: "example-library", scope, authenticated: true, needsLogin: false, inconclusive: false, detail: "probe returned 200" },
  persisted: { converted: ["id.example.test/:session"], alreadyPersistent: 3, expiresAt: "2026-08-25T00:00:00.000Z" },
  profile: { expected: "/tmp/profile", actual: "/tmp/profile", matches: true },
  message: `The ${scope} session is authenticated.`,
});

const signedOut = (overrides: Record<string, unknown> = {}) => ({
  site: "example-library",
  scope: "study" as const,
  authenticated: false,
  needsLogin: true,
  path: "failed" as const,
  steps: [],
  probe: { site: "example-library", scope: "study", authenticated: false, needsLogin: true, inconclusive: false, detail: "probe returned 401" },
  profile: { expected: "/tmp/profile", actual: "/tmp/profile", matches: true },
  message: "Sign-in did not complete.",
  ...overrides,
});

const tool = () => {
  const found = createStudyLibraryTools()[0];
  if (!found) throw new Error("Missing study_library tool");
  return found;
};

describe("study-library-agent-tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLibraryContextCache();
    siteSession.loadSiteDescriptors.mockReturnValue([DESCRIPTOR]);
    siteSession.getSiteDescriptor.mockReturnValue(DESCRIPTOR);
    siteSession.siteScopeForUrl.mockReturnValue(null);
    siteSession.ensureSiteSession.mockResolvedValue(authenticated());
    siteSession.siteSessionDiagnostics.mockResolvedValue({ sessionSurvivesRestart: true });
    siteSession.siteFetch.mockResolvedValue({ ok: true, status: 200, statusText: "OK", url: "https://library.example.test/notes/api/v3/annotations", body: [] });
  });

  it("reports session state on status without triggering a sign-in", async () => {
    await tool().handler({ action: "status" });

    expect(siteSession.ensureSiteSession).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "study", allowLogin: false }),
    );
  });

  it("includes restart-survival diagnostics in status so a failure can be explained", async () => {
    siteSession.ensureSiteSession.mockResolvedValue(signedOut());
    siteSession.siteSessionDiagnostics.mockResolvedValue({
      sessionSurvivesRestart: false,
      browserProfile: { expected: "/a", actual: "/b", matches: false },
    });

    const result = await tool().handler({ action: "status" });

    expect(result).toMatchObject({
      authenticated: false,
      diagnostics: { sessionSurvivesRestart: false },
    });
  });

  it("routes ensure_session to another scope of the same site", async () => {
    siteSession.ensureSiteSession.mockResolvedValue(authenticated("records"));

    const result = await tool().handler({ action: "ensure_session", scope: "records" });

    expect(siteSession.ensureSiteSession).toHaveBeenCalledWith(
      expect.objectContaining({ site: "example-library", scope: "records" }),
    );
    expect(result).toMatchObject({ authenticated: true, scope: "records" });
  });

  it("infers the scope from a url on that scope's origin", async () => {
    siteSession.ensureSiteSession.mockResolvedValue(authenticated("records"));
    siteSession.siteScopeForUrl.mockReturnValue({ site: DESCRIPTOR, scope: DESCRIPTOR.scopes[1] });

    await tool().handler({
      action: "ensure_session",
      url: "https://records.example.test/list",
    });

    expect(siteSession.ensureSiteSession).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "records" }),
    );
  });

  it("keeps login and prepare_login working as aliases of ensure_session", async () => {
    for (const action of ["login", "prepare_login"]) {
      siteSession.ensureSiteSession.mockClear();
      const result = await tool().handler({ action });
      expect(siteSession.ensureSiteSession).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ authenticated: true });
    }
  });

  it("heals the session before a read instead of returning a sign-in page as data", async () => {
    await tool().handler({ action: "list_annotations", query: { docId: "1" } });

    expect(siteSession.ensureSiteSession).toHaveBeenCalledWith({ site: "example-library", scope: "study" });
    expect(siteSession.siteFetch).toHaveBeenCalledWith(
      "example-library",
      "study",
      expect.objectContaining({ url: expect.stringContaining("/notes/api/v3/annotations?docId=1") }),
    );
  });

  it("refuses to write when the session could not be restored", async () => {
    siteSession.ensureSiteSession.mockResolvedValue(signedOut());

    const result = await tool().handler({
      action: "create_highlight",
      uri: "/readings/ot/isa/23",
      verse: 6,
      phrase: "day of the Lord",
    });

    expect(siteSession.siteFetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      error: expect.stringContaining("not authenticated"),
      needsLogin: true,
    });
  });

  it("surfaces a second-factor block without leaking the password", async () => {
    siteSession.ensureSiteSession.mockResolvedValue(
      signedOut({
        needsSecondFactor: true,
        message: "The Library sign-in asked for a second factor and the 1Password item has no one-time password field.",
      }),
    );

    const result = await tool().handler({ action: "login" });

    expect(result).toMatchObject({ authenticated: false, needsSecondFactor: true });
    expect(JSON.stringify(result)).not.toMatch(/password['"]?\s*:\s*['"][^'"]/i);
  });

  it("keeps only annotation create/delete actions classified as mutating", () => {
    expect(studyLibraryActionLooksMutating("status")).toBe(false);
    expect(studyLibraryActionLooksMutating("open")).toBe(false);
    expect(studyLibraryActionLooksMutating("ensure_session")).toBe(false);
    expect(studyLibraryActionLooksMutating("prepare_login")).toBe(false);
    expect(studyLibraryActionLooksMutating("login")).toBe(false);
    expect(studyLibraryActionLooksMutating("list_annotations")).toBe(false);
    expect(studyLibraryActionLooksMutating("create_reference_link")).toBe(true);
    expect(studyLibraryActionLooksMutating("delete_annotation")).toBe(true);
  });
});

describe("paragraph text used for highlight offsets", () => {
  it("drops the leading paragraph number and surrounding markup", () => {
    const text = verseHighlightText('<span class="verse-number">6 </span>And <em>behold</em>, the day');
    expect(text).toBe("And behold, the day");
  });

  it("decodes each entity exactly once", () => {
    // Decoding &amp; first would turn &amp;lt; into "<" — wrong text, and one
    // character shorter, which silently shifts every offset after it.
    expect(verseHighlightText("Alpha &amp;lt; Beta")).toBe("Alpha &lt; Beta");
    expect(verseHighlightText("a &amp;amp; b")).toBe("a &amp; b");
  });

  it("decodes the entities that appear in body text", () => {
    expect(verseHighlightText("&quot;peace&quot; &apos;n&apos; &lt;war&gt;&nbsp;now &#39;tis"))
      .toBe('"peace" \'n\' <war> now \'tis');
  });

  it("removes nested markup", () => {
    expect(verseHighlightText("<a><b>text</b></a>")).toBe("text");
  });

  it("reaches a fixed point, so no tag remains to shift an offset", () => {
    const messy = "<sp<span>an>text<em>more</em>";
    const once = verseHighlightText(messy);
    expect(once).not.toMatch(/<[^>]+>/);
    // Stripping again changes nothing: offsets computed from this are stable.
    expect(verseHighlightText(once)).toBe(once);
  });
});
