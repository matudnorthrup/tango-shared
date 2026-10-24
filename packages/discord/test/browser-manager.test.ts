import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserManager,
  buildBrowserLaunchArgs,
  buildBrowserLaunchCommand,
  createBackgroundPage,
  shouldCloseSessionTab,
  guardSharedBrowserDialogs,
  parseCdpListenerPids,
  parseUserDataDirFromCommand,
  parseExpenseDeskHistoryRecordFromRow,
  expenseDateTextMatchesInput,
  expenseMerchantTextMatchesInput,
  resolveBrowserProfileDir,
} from "../src/browser-manager.js";

describe("browser-manager launch config", () => {
  const originalProfileDir = process.env.TANGO_BROWSER_PROFILE_DIR;
  const originalDataDir = process.env.TANGO_DATA_DIR;
  const originalHome = process.env.TANGO_HOME;
  const originalProfile = process.env.TANGO_PROFILE;
  const originalCwd = process.cwd();
  const tempDirs: string[] = [];

  afterEach(() => {
    process.chdir(originalCwd);
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    if (originalProfileDir === undefined) {
      delete process.env.TANGO_BROWSER_PROFILE_DIR;
    } else {
      process.env.TANGO_BROWSER_PROFILE_DIR = originalProfileDir;
    }
    if (originalDataDir === undefined) {
      delete process.env.TANGO_DATA_DIR;
    } else {
      process.env.TANGO_DATA_DIR = originalDataDir;
    }
    if (originalHome === undefined) {
      delete process.env.TANGO_HOME;
    } else {
      process.env.TANGO_HOME = originalHome;
    }
    if (originalProfile === undefined) {
      delete process.env.TANGO_PROFILE;
    } else {
      process.env.TANGO_PROFILE = originalProfile;
    }
  });

  it("keeps the browser profile under the Tango home, outside the repo", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-browser-home-"));
    tempDirs.push(homeDir);
    delete process.env.TANGO_BROWSER_PROFILE_DIR;
    process.env.TANGO_HOME = homeDir;

    expect(resolveBrowserProfileDir()).toBe(path.join(homeDir, "browser-profile"));
  });

  it("honors TANGO_BROWSER_PROFILE_DIR override", () => {
    process.env.TANGO_BROWSER_PROFILE_DIR = "/tmp/tango-browser-profile";
    expect(resolveBrowserProfileDir()).toBe("/tmp/tango-browser-profile");
  });

  it("resolves the same cookie jar regardless of data dir, profile, or cwd", () => {
    // There is one browser on one CDP port. When this answer varied by
    // TANGO_DATA_DIR/TANGO_PROFILE/cwd, a worktree or profile-scoped run
    // attached to a second jar and every saved login appeared to be gone.
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-browser-home-"));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-browser-cwd-"));
    fs.mkdirSync(path.join(workDir, "data"), { recursive: true });
    tempDirs.push(homeDir, workDir);
    delete process.env.TANGO_BROWSER_PROFILE_DIR;
    process.env.TANGO_HOME = homeDir;

    const canonical = path.join(homeDir, "browser-profile");

    process.env.TANGO_PROFILE = "wt-1";
    process.env.TANGO_DATA_DIR = path.join(homeDir, "profiles", "wt-1", "data");
    expect(resolveBrowserProfileDir()).toBe(canonical);

    delete process.env.TANGO_DATA_DIR;
    delete process.env.TANGO_PROFILE;
    process.chdir(workDir);
    expect(resolveBrowserProfileDir()).toBe(canonical);
  });

  it("builds launch args with remote debugging and dedicated profile", () => {
    const args = buildBrowserLaunchArgs(9223, "/tmp/tango-browser-profile");
    expect(args).toEqual([
      "--remote-debugging-port=9223",
      "--remote-debugging-address=127.0.0.1",
      "--user-data-dir=/tmp/tango-browser-profile",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ]);
  });

  it("parses CDP listener pids from lsof output", () => {
    expect(parseCdpListenerPids("123\n456\n123\n", 456)).toEqual([123]);
    expect(parseCdpListenerPids("noise\n789\n", 0)).toEqual([789]);
    expect(parseCdpListenerPids("", 0)).toEqual([]);
  });

  it("parses current ExpenseDesk reimbursement rows including drafts", () => {
    const draft = parseExpenseDeskHistoryRecordFromRow({
      reviewUrl: "https://expenses.example.com/details/reimbursements/4324/draft",
      cells: [
        "",
        "",
        "WalmartDraft",
        "$15.00 USD",
        "May 2, 2026",
        "—",
        "None",
        "",
        "—",
        "—",
        "",
        "—",
        "Submit",
        "",
      ],
    });

    expect(draft).toMatchObject({
      reviewUrl: "https://expenses.example.com/details/reimbursements/4324/draft",
      expenseReportId: "4324",
      status: "Draft",
      merchant: "Walmart",
      amount: 15.00,
      transactionDate: "2026-05-02",
    });

    const paid = parseExpenseDeskHistoryRecordFromRow({
      reviewUrl: "https://expenses.example.com/details/reimbursements/c179",
      cells: [
        "",
        "",
        "WalmartPaid · Example User's account x-0000",
        "$25.00 USD",
        "Apr 10, 2026",
        "Apr 16, 2026",
        "None",
        "",
        "Reimbursable expense",
        "—",
        "",
        "—",
        "—",
        "",
      ],
    });

    expect(paid).toMatchObject({
      status: "Paid",
      merchant: "Walmart",
      entity: "Example User's account x-0000",
      amount: 25.00,
      transactionDate: "2026-04-10",
      submittedDate: "2026-04-16",
      memo: "Reimbursable expense",
    });

    const pending = parseExpenseDeskHistoryRecordFromRow({
      reviewUrl: "https://expenses.example.com/details/reimbursements/00000000-0000-4000-8000-000000000003",
      cells: [
        "",
        "",
        "Home Service CoAwaiting reviewer",
        "$100.00 USD",
        "May 1, 2026",
        "May 25, 2026",
        "None",
        "",
        "Reimbursable expense",
        "—",
        "",
        "—",
        "—",
        "",
      ],
    });

    expect(pending).toMatchObject({
      expenseReportId: "00000000-0000-4000-8000-000000000003",
      status: "Awaiting reviewer",
      merchant: "Home Service Co",
      amount: 100,
      transactionDate: "2026-05-01",
      submittedDate: "2026-05-25",
      memo: "Reimbursable expense",
    });
  });

  it("recognizes when ExpenseDesk already OCR-filled the requested merchant", () => {
    expect(expenseMerchantTextMatchesInput("Walmart", "walmart")).toBe(true);
    expect(expenseMerchantTextMatchesInput("Walmart", "Walmart - delivery tip")).toBe(true);
    expect(expenseMerchantTextMatchesInput("Venmo", "Venmo reimbursement")).toBe(true);
    expect(expenseMerchantTextMatchesInput("Home Service Co", "Walmart")).toBe(false);
    expect(expenseMerchantTextMatchesInput(undefined, "Walmart")).toBe(false);
  });

  it("accepts ExpenseDesk date display formats during draft verification", () => {
    expect(expenseDateTextMatchesInput("May 2, 2026", "2026-05-02")).toBe(true);
    expect(expenseDateTextMatchesInput("05/02/2026", "2026-05-02")).toBe(true);
    expect(expenseDateTextMatchesInput("May 3, 2026", "2026-05-02")).toBe(false);
  });
});

describe("connected browser profile detection", () => {
  it("reads the profile a running browser is actually using", () => {
    const command =
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser --remote-debugging-port=9223 " +
      "--remote-debugging-address=127.0.0.1 --user-data-dir=/opt/agent/tango-home/browser-profile " +
      "--no-first-run --no-default-browser-check about:blank";

    expect(parseUserDataDirFromCommand(command)).toBe("/opt/agent/tango-home/browser-profile");
  });

  it("handles a profile path given as a separate argument", () => {
    expect(
      parseUserDataDirFromCommand("brave --user-data-dir /tmp/profile --no-first-run"),
    ).toBe("/tmp/profile");
  });

  it("keeps spaces inside a profile path", () => {
    expect(
      parseUserDataDirFromCommand("brave --user-data-dir=/tmp/my profile --no-first-run"),
    ).toBe("/tmp/my profile");
  });

  it("returns null when the browser was launched without an explicit profile", () => {
    expect(parseUserDataDirFromCommand("brave --remote-debugging-port=9223")).toBeNull();
  });
});

describe("guardSharedBrowserDialogs", () => {
  it("dismisses dialogs on existing and new pages without surfacing a lost race", async () => {
    const existing = new EventEmitter();
    const context = Object.assign(new EventEmitter(), { pages: () => [existing] });
    guardSharedBrowserDialogs(context as never);

    const raced = { dismiss: vi.fn(() => Promise.reject(new Error("No dialog is showing"))) };
    existing.emit("dialog", raced);
    expect(raced.dismiss).toHaveBeenCalledTimes(1);

    const later = new EventEmitter();
    context.emit("page", later);
    const dialog = { dismiss: vi.fn(() => Promise.resolve()) };
    later.emit("dialog", dialog);
    expect(dialog.dismiss).toHaveBeenCalledTimes(1);

    // The rejected dismiss must be handled; an unhandled one would fail the run.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});


describe("background browser lifecycle", () => {
  it("launches macOS apps without activation and preserves profile arguments", () => {
    const result = buildBrowserLaunchCommand("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", 9223, "/tmp/profile with spaces", "darwin");
    expect(result.command).toBe("/usr/bin/open");
    expect(result.args).toEqual(["-g", "-n", "-a", "/Applications/Brave Browser.app", "--args", ...buildBrowserLaunchArgs(9223, "/tmp/profile with spaces")]);
  });

  it("keeps executable launches on other platforms", () => {
    expect(buildBrowserLaunchCommand("/usr/bin/brave", 9223, "/tmp/profile", "linux"))
      .toEqual({ command: "/usr/bin/brave", args: buildBrowserLaunchArgs(9223, "/tmp/profile") });
  });

  it.each([
    ["https://app.test/mlt/auth/callback?code=redacted", true, true],
    ["https://app.test/mlt/auth/callback", false, false],
    ["https://other.test/mlt/auth/callback", true, false],
    ["https://app.test/home", true, false],
    ["https://app.test/login", true, false],
    ["https://app.test/auth/callback-extra", true, false],
    ["about:blank", true, false],
  ])("limits cleanup for %s (owned %s)", (url, owned, expected) => {
    expect(shouldCloseSessionTab(url, "https://app.test", owned)).toBe(expected);
  });

  it("attaches the created target rather than a concurrent unrelated tab", async () => {
    const ours = { isClosed: () => false, addInitScript: vi.fn().mockResolvedValue(undefined) };
    const theirs = { isClosed: () => false, addInitScript: vi.fn() };
    const session = { send: vi.fn().mockResolvedValue({ targetId: "ours" }), detach: vi.fn() };
    const context = {
      browser: () => ({ newBrowserCDPSession: async () => session }),
      pages: () => [theirs, ours],
      newCDPSession: async (page: unknown) => ({
        send: async () => ({ targetInfo: { targetId: page === ours ? "ours" : "theirs" } }),
        detach: vi.fn().mockResolvedValue(undefined),
      }),
    };
    session.detach.mockResolvedValue(undefined);
    expect(await createBackgroundPage(context as never)).toBe(ours);
    expect(session.send).toHaveBeenCalledWith("Target.createTarget", { url: "about:blank", background: true, newWindow: false });
    expect(theirs.addInitScript).not.toHaveBeenCalled();
    expect(ours.addInitScript).toHaveBeenCalled();
    expect(session.detach).toHaveBeenCalled();
  });
});


describe("session tab cleanup", () => {
  it("closes marked callbacks only, retaining user tabs and reusable pages", async () => {
    const page = (url: string, marked: boolean) => ({
      url: () => url, isClosed: () => false,
      evaluate: vi.fn().mockResolvedValue(marked), close: vi.fn().mockResolvedValue(undefined),
    });
    const ownedCallback = page("https://app.test/mlt/auth/callback", true);
    const userCallback = page("https://app.test/mlt/auth/callback", false);
    const ownedHome = page("https://app.test/home", true);
    const otherScope = page("https://other.test/mlt/auth/callback", true);
    const unreadable = page("https://app.test/mlt/auth/callback", true);
    unreadable.evaluate.mockRejectedValue(new Error("navigating"));
    const manager = new BrowserManager();
    vi.spyOn(manager, "context").mockReturnValue({ pages: () => [ownedCallback, userCallback, ownedHome, otherScope, unreadable] } as never);
    await manager.cleanupSessionTabs("https://app.test");
    expect(ownedCallback.close).toHaveBeenCalledOnce();
    for (const retained of [userCallback, ownedHome, otherScope, unreadable]) expect(retained.close).not.toHaveBeenCalled();
  });
});
