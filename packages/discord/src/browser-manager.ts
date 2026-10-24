/**
 * Browser Manager — Native Playwright-based browser automation for Tango.
 *
 * Connects to existing Chrome/Brave/Edge via Chrome DevTools Protocol (CDP).
 * Provides accessibility snapshots with numbered refs for AI agent interaction.
 *
 * The browser must be pre-launched with --remote-debugging-port=NNNN.
 * For sites with bot detection (e.g. Walmart/Arkose Labs), connecting to a
 * real Chrome/Brave instance avoids automated-browser fingerprint detection.
 */

import { cdpBrowserPids } from "./port-listeners.js";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { readProfileConfigString, resolveTangoHome } from "@tango/core";
import {
  buildEmailEvidenceHtml,
  buildExpenseDeskReviewUrl,
  buildExpenseDeskReviewVisualState,
  countExpenseDeskReceiptSubmissionEvents,
  extractWalmartExplicitDates,
  extractWalmartOrderIdFromUrl,
  extractExpenseDeskReimbursementIdFromUrl,
  flattenWalmartOrderId,
  formatExpenseDeskTransactionDate,
  normalizeWalmartOrderId,
  parseGogEmailFullOutput,
  parseFlexibleDateToIso,
  expensePageLooksSignedOut,
  expenseReimbursementLooksSubmitted,
  expenseReviewVisualStateChanged,
  expenseReviewVisualStateLooksReceiptLike,
  expenseReviewBodyLooksAutoVerified,
  WALMART_PAYMENT_SUMMARY_SELECTORS,
} from "./reimbursement-automation.js";
import {
  archiveReimbursementEvidence,
  loadReimbursementEvidenceRecord,
} from "./reimbursement-evidence.js";
import type { ExpenseReimbursementHistoryRecord } from "./receipt-reimbursement-registry.js";

const debug = (...args: unknown[]) => {
  console.error("[browser-manager]", ...args);
};

/**
 * Marks a tab as Tango's own. Stored in per-tab sessionStorage so it survives
 * navigation inside the tab and disappears when the tab does, which lets a new
 * process re-adopt its own tabs without ever grabbing a person's.
 */
const TANGO_OWNED_TAB_KEY = "tango:owned-tab";

const CDP_CONNECT_TIMEOUT_MS = 15_000;
const PAGE_READY_TIMEOUT_MS = 10_000;
const STALE_CDP_SHUTDOWN_TIMEOUT_MS = 5_000;
const EXPENSE_DRAFT_FIELD_TIMEOUT_MS = 120_000;
const EXPENSE_DRAFT_FIELD_ACTION_TIMEOUT_MS = 60_000;
const EXPENSE_GOOGLE_LOGIN_TIMEOUT_MS = 60_000;
function resolveExpenseDeskGoogleAccountEmail(): string {
  const account = readProfileConfigString({
    relativePath: "browser/expense-google-account.txt",
    envPathVar: "TANGO_EXPENSE_GOOGLE_ACCOUNT_EMAIL_FILE",
    envValueVar: "TANGO_EXPENSE_GOOGLE_ACCOUNT_EMAIL",
  }) || process.env.TANGO_WORK_GOOGLE_ACCOUNT_EMAIL?.trim();
  if (!account) {
    throw new Error(
      "ExpenseDesk Google login account is not configured. Set TANGO_EXPENSE_GOOGLE_ACCOUNT_EMAIL or profile config browser/expense-google-account.txt.",
    );
  }
  return account;
}

export interface WalmartHistoryCandidate {
  orderId: string;
  orderUrl: string;
  date: string;
  dateText: string;
  driverTip: number;
  total?: number;
  cardCharge?: string;
  itemsLine?: string;
  deliverySummary: string;
  notes: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function buildExpenseDeskMerchantCandidates(merchant: string): string[] {
  const trimmed = merchant.trim();
  const candidates = new Set<string>();
  const push = (value: string) => {
    const normalized = value.trim();
    if (normalized.length > 0) {
      candidates.add(normalized);
    }
  };

  push(trimmed);
  push(trimmed.replace(/\([^)]*\)/gu, "").trim());

  const firstSegment = trimmed.split(/\s+-\s+|:\s+/u)[0] ?? trimmed;
  push(firstSegment);

  if (/^venmo\b/iu.test(trimmed)) {
    push("Venmo");
  }

  return [...candidates];
}

function normalizeExpenseDeskHistoryCell(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/gu, " ").trim();
  if (!trimmed || trimmed === "—") {
    return undefined;
  }
  return trimmed;
}

function parseExpenseDeskHistoryAmount(value: string | undefined): number | undefined {
  const normalized = normalizeExpenseDeskHistoryCell(value)?.replace(/[^0-9.-]/gu, "");
  if (!normalized) {
    return undefined;
  }
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function amountsMatch(left: number | undefined, right: number | undefined): boolean {
  return left != null && right != null && Math.abs(left - right) < 0.01;
}

function normalizeExpenseDeskMatchKey(value: string | undefined): string {
  return value?.trim().toLowerCase().replace(/[^a-z0-9]+/gu, " ").replace(/\s+/gu, " ").trim() ?? "";
}

export function expenseMerchantTextMatchesInput(currentValue: string | undefined, merchant: string): boolean {
  const currentMerchant = normalizeExpenseDeskMatchKey(currentValue);
  if (!currentMerchant) {
    return false;
  }

  const merchantCandidates = buildExpenseDeskMerchantCandidates(merchant).map(normalizeExpenseDeskMatchKey);
  return merchantCandidates.some((candidate) =>
    currentMerchant === candidate
    || currentMerchant.includes(candidate)
    || candidate.includes(currentMerchant)
  );
}

export function expenseDateTextMatchesInput(currentValue: string | undefined, expectedValue: string): boolean {
  const currentDate = parseFlexibleDateToIso(currentValue?.trim() ?? "");
  const expectedDate =
    parseFlexibleDateToIso(expectedValue)
    ?? parseFlexibleDateToIso(formatExpenseDeskTransactionDate(expectedValue));

  if (currentDate && expectedDate) {
    return currentDate === expectedDate;
  }

  return (currentValue ?? "").trim() === expectedValue.trim();
}

function parseExpenseDeskCurrentExpenseMerchantStatus(value: string | undefined): {
  merchant: string;
  status: string;
  statusDetail?: string;
} | null {
  const normalized = normalizeExpenseDeskHistoryCell(value);
  if (!normalized) {
    return null;
  }

  const match = /^(?<merchant>.+?)(?<status>Draft|Paid|Approved|Rejected|Pending|Submitted|Awaiting reviewer|Needs review|Missing items)(?:\s*·\s*(?<detail>.+))?$/iu.exec(normalized);
  const merchant = match?.groups?.merchant?.trim();
  const status = match?.groups?.status?.trim();
  if (!merchant || !status) {
    return null;
  }

  return {
    merchant,
    status,
    statusDetail: match?.groups?.detail?.trim(),
  };
}

export function parseExpenseDeskHistoryRecordFromRow(input: {
  reviewUrl: string;
  cells: string[];
}): ExpenseReimbursementHistoryRecord | null {
  const reviewUrl = input.reviewUrl.trim();
  if (!reviewUrl) {
    return null;
  }

  const cell = (index: number): string | undefined => normalizeExpenseDeskHistoryCell(input.cells[index]);
  const currentMerchantStatus = parseExpenseDeskCurrentExpenseMerchantStatus(cell(2));
  const currentAmount = parseExpenseDeskHistoryAmount(cell(3));
  const currentTransactionDateText = cell(4);
  if (currentMerchantStatus && currentAmount != null && currentTransactionDateText) {
    const submittedDateText = cell(5);
    return {
      reviewUrl,
      expenseReportId: extractExpenseDeskReimbursementIdFromUrl(reviewUrl) ?? undefined,
      status: currentMerchantStatus.status,
      merchant: currentMerchantStatus.merchant,
      amount: currentAmount,
      transactionDate: parseFlexibleDateToIso(currentTransactionDateText) ?? currentTransactionDateText,
      submittedDate: submittedDateText ? parseFlexibleDateToIso(submittedDateText) ?? submittedDateText : undefined,
      entity: currentMerchantStatus.statusDetail,
      receipt: cell(7),
      memo: cell(8),
      flags: cell(10),
    };
  }

  const submittedDateText = cell(5);
  const transactionDateText = cell(6);
  const reviewedDateText = cell(7);
  const expectedPaymentDateText = cell(25);
  const deliveredPaymentDateText = cell(26);

  return {
    reviewUrl,
    expenseReportId: extractExpenseDeskReimbursementIdFromUrl(reviewUrl) ?? undefined,
    user: cell(2),
    status: cell(3),
    receipt: cell(4),
    submittedDate: submittedDateText ? parseFlexibleDateToIso(submittedDateText) ?? submittedDateText : undefined,
    transactionDate: transactionDateText ? parseFlexibleDateToIso(transactionDateText) ?? transactionDateText : undefined,
    reviewedDate: reviewedDateText ? parseFlexibleDateToIso(reviewedDateText) ?? reviewedDateText : undefined,
    merchant: cell(8),
    amount: parseExpenseDeskHistoryAmount(cell(9)),
    statementAmount: parseExpenseDeskHistoryAmount(cell(10)),
    entity: cell(11),
    flags: cell(12),
    memo: cell(13),
    reviewer: cell(24),
    expectedPaymentDate: expectedPaymentDateText
      ? parseFlexibleDateToIso(expectedPaymentDateText) ?? expectedPaymentDateText
      : undefined,
    deliveredPaymentDate: deliveredPaymentDateText
      ? parseFlexibleDateToIso(deliveredPaymentDateText) ?? deliveredPaymentDateText
      : undefined,
  };
}

function evidencePathLooksImage(filePath: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/iu.test(filePath);
}

let manager: BrowserManager | null = null;

export function getBrowserManager(): BrowserManager {
  if (!manager) manager = new BrowserManager();
  return manager;
}

let cachedBrowserPath: string | null | undefined;
/** Resolve a Chromium-based browser executable. */
function findBrowserPath(): string | null {
  if (cachedBrowserPath !== undefined) return cachedBrowserPath;
  const macBrave = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
  return (cachedBrowserPath = fs.existsSync(macBrave) ? macBrave : (
    ["brave-browser", "brave", "chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]
      .flatMap((name) => (process.env.PATH?.split(path.delimiter) ?? []).map((dir) => path.join(dir, name)))
      .find((candidate) => fs.existsSync(candidate)) ?? null
  ));
}

/**
 * Where the automation browser keeps its cookies and logins.
 *
 * One machine-wide directory, deliberately: there is a single browser on a
 * single CDP port, so a per-profile or per-worktree path only ever produced a
 * second cookie jar that some runs used and others did not — logins saved in
 * one were simply missing in the other. It lives under the Tango home rather
 * than the repo so `git clean -xdf`, a worktree, or moving the checkout cannot
 * delete every saved session.
 *
 * `TANGO_BROWSER_PROFILE_DIR` overrides it; nothing else does.
 */
export function resolveBrowserProfileDir(): string {
  const configured = process.env.TANGO_BROWSER_PROFILE_DIR?.trim();
  if (configured && configured.length > 0) {
    return path.resolve(configured);
  }

  return path.join(resolveTangoHome(), "browser-profile");
}

export function buildBrowserLaunchArgs(port: number, profileDir: string): string[] {
  return [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
}

/** Ask LaunchServices to launch without activating the macOS browser. */
export function buildBrowserLaunchCommand(
  browserPath: string, port: number, profileDir: string, platform = process.platform,
): { command: string; args: string[] } {
  const args = buildBrowserLaunchArgs(port, profileDir);
  const appEnd = browserPath.indexOf(".app/");
  if (platform === "darwin" && appEnd !== -1) {
    return { command: "/usr/bin/open", args: ["-g", "-n", "-a", browserPath.slice(0, appEnd + 4), "--args", ...args] };
  }
  return { command: browserPath, args };
}

/** Only completed, owned callback tabs in this scope are disposable. */
export function shouldCloseSessionTab(url: string, origin: string, marked: boolean): boolean {
  if (!marked) return false;
  try {
    const parsed = new URL(url);
    return parsed.origin === origin && /\/auth\/callback\/?$/u.test(parsed.pathname);
  } catch {
    return false;
  }
}

/** Create and identify our exact target; never adopt a concurrent user's tab. */
export async function createBackgroundPage(context: BrowserContext): Promise<Page> {
  const browser = context.browser();
  if (!browser) throw new Error("Background tabs require a CDP browser");
  const session = await browser.newBrowserCDPSession();
  let targetId: string | undefined;
  try {
    ({ targetId } = await session.send("Target.createTarget", {
      url: "about:blank", background: true, newWindow: false,
    }));
    const deadline = Date.now() + PAGE_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      for (const candidate of context.pages()) {
        if (candidate.isClosed()) continue;
        let matches = false;
        try {
          const cdp = await context.newCDPSession(candidate);
          try {
            const { targetInfo } = await cdp.send("Target.getTargetInfo");
            matches = targetInfo.targetId === targetId;
          } finally {
            await cdp.detach().catch(() => undefined);
          }
        } catch (error) {
          if (!candidate.isClosed()) throw error;
        }
        if (!matches) continue;
        // Per-page init script reestablishes ownership across origin redirects.
        await candidate.addInitScript((key) => {
          try { window.sessionStorage.setItem(key, "1"); } catch { /* opaque origin */ }
        }, TANGO_OWNED_TAB_KEY);
        return candidate;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Background browser target did not attach within 10s");
  } catch (error) {
    if (targetId) await session.send("Target.closeTarget", { targetId }).catch(() => undefined);
    throw error;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/** Check if a browser is already listening on the given CDP port. */
async function isCdpPortOpen(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

export function parseCdpListenerPids(
  output: string,
  currentPid = process.pid,
): number[] {
  const seen = new Set<number>();
  for (const token of output.trim().split(/\s+/u)) {
    const pid = Number(token);
    if (Number.isInteger(pid) && pid > 0 && pid !== currentPid) {
      seen.add(pid);
    }
  }
  return [...seen];
}

/**
 * Pull `--user-data-dir` out of a browser process command line. Exported for tests.
 * Handles both `--user-data-dir=/path` and `--user-data-dir /path` forms.
 */
export function parseUserDataDirFromCommand(command: string): string | null {
  const inline = command.match(/--user-data-dir=(.+?)(?=\s+--|\s*$)/u);
  if (inline?.[1]) {
    return inline[1].trim();
  }
  const spaced = command.match(/--user-data-dir\s+(.+?)(?=\s+--|\s*$)/u);
  return spaced?.[1]?.trim() ?? null;
}

/**
 * Which profile is the browser on `port` actually running? A CDP client gets
 * whichever browser claimed the port first, which may not be the profile this
 * process would have launched — the difference is invisible except that every
 * saved login is missing. Returns null when the profile cannot be determined.
 */
export function readRunningBrowserProfileDir(port: number): string | null {
  for (const pid of findCdpListenerPids(port)) {
    try {
      const command = execSync(`ps -p ${pid} -o command=`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
        killSignal: "SIGKILL",
      });
      const dir = parseUserDataDirFromCommand(command);
      if (dir) {
        return dir;
      }
    } catch {
      /* ignore and try the next listener */
    }
  }
  return null;
}

/**
 * Compare the profile a connected browser is actually using against the one this
 * process resolves. A mismatch means cookies/logins live somewhere else.
 */
export function describeBrowserProfile(port = 9223): {
  expected: string;
  actual: string | null;
  matches: boolean | null;
} {
  const expected = resolveBrowserProfileDir();
  const actual = readRunningBrowserProfileDir(port);
  return {
    expected,
    actual,
    matches: actual === null ? null : path.resolve(actual) === path.resolve(expected),
  };
}

function findCdpListenerPids(port: number): number[] {
  if (!Number.isInteger(port) || port <= 0) {
    return [];
  }

  // By command line (lsof hangs on a stalled network mount; netstat lists nothing on macOS 27).
  return cdpBrowserPids(port);
}

async function waitForCdpPortClosed(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await isCdpPortOpen(port))) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  } while (Date.now() < deadline);
  return !(await isCdpPortOpen(port));
}

async function recycleStaleCdpBrowser(port: number): Promise<number[]> {
  const pids = findCdpListenerPids(port);
  if (pids.length === 0) {
    return [];
  }

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  }

  if (await waitForCdpPortClosed(port, STALE_CDP_SHUTDOWN_TIMEOUT_MS)) {
    return pids;
  }

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }

  await waitForCdpPortClosed(port, STALE_CDP_SHUTDOWN_TIMEOUT_MS);
  return pids;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * A CDP connection sees every tab in the shared browser, including tabs other
 * clients (agent scripts on the same Brave) are driving. With no 'dialog'
 * listener, Playwright auto-dismisses each dialog with an uncaught promise; if
 * the other client dismissed it first, that rejects with "No dialog is showing"
 * and the unhandledRejection handler exits the whole bot (2026-09-27 11:49 PDT).
 * Listening on every page keeps the same dismiss behavior, with the race caught.
 */
export function guardSharedBrowserDialogs(context: BrowserContext): void {
  const guard = (page: Page): void => {
    page.on("dialog", (dialog) => {
      dialog.dismiss().catch(() => undefined);
    });
  };
  for (const page of context.pages()) guard(page);
  context.on("page", guard);
}

export class BrowserManager {
  private browser: Browser | null = null;
  private page: Page | null = null;
  /** Tabs this manager owns per origin, so it never navigates a person's tab. */
  private originPages = new Map<string, Page>();

  /**
   * Launch Brave with remote debugging enabled.
   * If Brave is already listening on the port, connects to it instead.
   * Uses port 9223 by default to avoid conflicts with other browsers.
   */
  async launch(port = 9223): Promise<string> {
    // Already listening? Just connect.
    if (await isCdpPortOpen(port)) {
      debug(`CDP port ${port} already open, connecting`);
      try {
        return await this.connect(`http://127.0.0.1:${port}`);
      } catch (err) {
        debug(
          `CDP port ${port} was open but Playwright could not attach; recycling stale browser`,
          err,
        );
        const recycledPids = await recycleStaleCdpBrowser(port);
        if (recycledPids.length === 0 || await isCdpPortOpen(port)) {
          throw err;
        }
        debug(`Recycled stale browser pid(s): ${recycledPids.join(", ")}`);
      }
    }

    const browserPath = findBrowserPath();
    if (!browserPath) {
      throw new Error(
        "No Chromium-based browser found. Install in /Applications or ensure on PATH.",
      );
    }

    const profileDir = resolveBrowserProfileDir();
    fs.mkdirSync(profileDir, { recursive: true });

    debug(`Launching Brave with --remote-debugging-port=${port} profile=${profileDir}`);

    const launch = buildBrowserLaunchCommand(browserPath, port, profileDir);
    const child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    // Wait for CDP to become available (up to 10s)
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await isCdpPortOpen(port)) {
        debug(`Brave ready on port ${port}`);
        return this.connect(`http://127.0.0.1:${port}`);
      }
    }

    throw new Error(
      `Brave launched but CDP port ${port} did not become available within 10s.`,
    );
  }

  /** Connect (launching Brave if needed) without disturbing the active page. */
  async ensureConnected(port = 9223): Promise<void> {
    if (this.browser?.isConnected()) {
      return;
    }
    await this.launch(port);
  }

  /** The Playwright context backing the connected browser. */
  context(): BrowserContext {
    if (!this.browser) {
      throw new Error(
        "No browser connected. Use action 'launch' first, or 'connect' with a CDP URL.",
      );
    }
    const ctx = this.browser.contexts()[0];
    if (!ctx) {
      throw new Error("No browser context found");
    }
    return ctx;
  }

  /**
   * Get a tab dedicated to `origin`, isolated from the shared active page.
   *
   * The single shared `page` is whatever the last tool navigated it to, so
   * running an origin's API calls through it silently makes them cross-origin
   * (no cookies, CORS failures that read like auth failures) and steals that
   * workflow's tab.
   *
   * The tab returned here is Tango's own: one this process created, or one a
   * previous process created and marked (the marker is per-tab sessionStorage,
   * which survives navigation within the tab). A person's own tab on the same
   * site is never reused — that would navigate the page out from under them
   * mid-read, even when the URL happens to match.
   */
  async pageForOrigin(origin: string, startUrl: string): Promise<Page> {
    const ctx = this.context();

    const owned = this.originPages.get(origin);
    if (owned && !owned.isClosed()) {
      return owned;
    }

    for (const candidate of ctx.pages()) {
      if (candidate.isClosed()) continue;
      try {
        if (new URL(candidate.url()).origin !== origin) continue;
      } catch {
        continue;
      }
      const marked = await candidate
        .evaluate((key) => window.sessionStorage.getItem(key) === "1", TANGO_OWNED_TAB_KEY)
        .catch(() => false);
      if (marked) {
        this.trackOriginPage(origin, candidate);
        return candidate;
      }
    }

    const page = await createBackgroundPage(ctx);
    this.trackOriginPage(origin, page);
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch((err) => {
      debug(`pageForOrigin(${origin}) initial navigation failed`, err);
    });
    await page
      .evaluate((key) => window.sessionStorage.setItem(key, "1"), TANGO_OWNED_TAB_KEY)
      .catch(() => undefined);
    return page;
  }

  /** Called only after authentication succeeds, leaving incomplete sign-ins intact. */
  async cleanupSessionTabs(origin: string): Promise<void> {
    for (const candidate of this.context().pages()) {
      if (candidate.isClosed() || !shouldCloseSessionTab(candidate.url(), origin, true)) continue;
      const marked = await candidate.evaluate(
        (key) => window.sessionStorage.getItem(key) === "1", TANGO_OWNED_TAB_KEY,
      ).catch(() => false);
      if (shouldCloseSessionTab(candidate.url(), origin, marked)) {
        await candidate.close().catch(() => undefined);
      }
    }
  }

  private trackOriginPage(origin: string, page: Page): void {
    this.originPages.set(origin, page);
    page.once("close", () => {
      if (this.originPages.get(origin) === page) {
        this.originPages.delete(origin);
      }
    });
  }

  /** Connect to an existing browser via Chrome DevTools Protocol. */
  async connect(cdpUrl: string): Promise<string> {
    if (this.browser && this.page) {
      try {
        const title = await withTimeout(
          this.page.title(),
          PAGE_READY_TIMEOUT_MS,
          "Browser page title",
        );
        const url = this.page.url();
        debug(`Reusing existing browser connection for ${cdpUrl}, page: ${url}`);
        return `Connected. Active page: ${title} (${url})`;
      } catch {
        await this.close();
      }
    }

    try {
      this.browser = await withTimeout(
        chromium.connectOverCDP(cdpUrl),
        CDP_CONNECT_TIMEOUT_MS,
        `Browser CDP connect (${cdpUrl})`,
      );
    } catch (err) {
      throw new Error(
        `Cannot connect to browser at ${cdpUrl}. ` +
          `Use 'launch' action instead, or ensure Brave is running with --remote-debugging-port. ` +
          `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.browser.on("disconnected", () => {
      debug("Browser disconnected");
      this.browser = null;
      this.page = null;
      this.originPages.clear();
    });

    const contexts = this.browser.contexts();
    const ctx = contexts[0];
    if (!ctx) throw new Error("No browser context found");
    for (const context of contexts) guardSharedBrowserDialogs(context);
    const pages = ctx.pages();
    this.page =
      pages.find((p) => p.url() !== "about:blank") ??
      pages[0] ??
      (await withTimeout(
        createBackgroundPage(ctx),
        PAGE_READY_TIMEOUT_MS,
        "Browser newPage",
      ));

    const title = await withTimeout(
      this.page.title(),
      PAGE_READY_TIMEOUT_MS,
      "Browser page title",
    );
    const url = this.page.url();
    debug(`Connected to ${cdpUrl}, page: ${url}`);
    return `Connected. Active page: ${title} (${url})`;
  }

  /** Navigate to a URL. */
  async open(url: string): Promise<string> {
    const page = this.getPage();

    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes("Timeout")) {
        debug(`Navigation timeout for ${url}, page may still be loading`);
      } else {
        throw err;
      }
    }

    // Brief settle time for dynamic content
    await page.waitForTimeout(1500);
    const title = await page.title();
    return `Navigated to: ${title} (${page.url()})`;
  }

  /**
   * Get an accessibility snapshot of the page with numbered refs.
   *
   * Interactive elements are labelled [1], [2], etc. The agent uses these
   * ref numbers with click, fill, type, and select actions.
   *
   * Refs are NOT stable across navigations — always re-snapshot after open/click.
   */
  async snapshot(options?: { interactive?: boolean }): Promise<string> {
    const page = this.getPage();
    const interactiveOnly = options?.interactive ?? false;

    const result = await page.evaluate(
      (intOnly: boolean) => {
        // ---- runs in the browser context ----

        // Clean old refs
        document
          .querySelectorAll("[data-tango-ref]")
          .forEach((el) => el.removeAttribute("data-tango-ref"));

        const SKIP = new Set([
          "SCRIPT",
          "STYLE",
          "NOSCRIPT",
          "SVG",
          "PATH",
          "META",
          "LINK",
          "HEAD",
          "TEMPLATE",
        ]);
        const INTERACTIVE_SELECTOR = [
          "a[href]",
          "button",
          "input:not([type=hidden])",
          "select",
          "textarea",
          "summary",
          "[role=button]",
          "[role=link]",
          "[role=menuitem]",
          "[role=tab]",
          "[role=checkbox]",
          "[role=radio]",
          "[role=combobox]",
          "[role=textbox]",
          "[role=searchbox]",
          "[role=switch]",
        ].join(", ");
        const HEADING_RE = /^H[1-6]$/;
        const MAX_TEXT = 150;
        const MAX_ELEMENTS = 300;

        function isVisible(el: Element): boolean {
          try {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return false;
            const style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden")
              return false;
            if (parseFloat(style.opacity) === 0) return false;
            return true;
          } catch {
            return false;
          }
        }

        function getLabel(el: Element): string {
          const ariaLabel = el.getAttribute("aria-label");
          if (ariaLabel) return ariaLabel.trim().substring(0, MAX_TEXT);

          const ariaLabelledBy = el.getAttribute("aria-labelledby");
          if (ariaLabelledBy) {
            const labelEl = document.getElementById(ariaLabelledBy);
            if (labelEl)
              return labelEl.textContent?.trim().substring(0, MAX_TEXT) || "";
          }

          const inputEl = el as HTMLInputElement;
          if (inputEl.placeholder)
            return inputEl.placeholder.substring(0, MAX_TEXT);

          if (el.id) {
            try {
              const labelFor = document.querySelector(
                `label[for="${CSS.escape(el.id)}"]`,
              );
              if (labelFor)
                return (
                  labelFor.textContent?.trim().substring(0, MAX_TEXT) || ""
                );
            } catch {
              /* ignore CSS.escape issues */
            }
          }

          const title = el.getAttribute("title");
          if (title) return title.substring(0, MAX_TEXT);

          const text = el.textContent?.trim() || "";
          return text.substring(0, MAX_TEXT);
        }

        function getType(el: Element): string {
          const role = el.getAttribute("role");
          if (role) return role;

          switch (el.tagName) {
            case "A":
              return "link";
            case "BUTTON":
              return "button";
            case "INPUT": {
              const t = (el as HTMLInputElement).type;
              if (t === "submit" || t === "button" || t === "reset")
                return "button";
              if (t === "checkbox") return "checkbox";
              if (t === "radio") return "radio";
              if (t === "search") return "searchbox";
              return "textbox";
            }
            case "SELECT":
              return "select";
            case "TEXTAREA":
              return "textbox";
            case "SUMMARY":
              return "button";
            default:
              return el.tagName.toLowerCase();
          }
        }

        // Collect all elements of interest in DOM order
        type Entry =
          | { kind: "heading"; level: number; text: string }
          | { kind: "interactive"; el: Element }
          | { kind: "text"; text: string };

        const entries: Entry[] = [];

        function walk(node: Element, depth: number): void {
          if (entries.length >= MAX_ELEMENTS * 2) return;
          if (SKIP.has(node.tagName)) return;
          if (!isVisible(node)) return;

          // Heading
          if (HEADING_RE.test(node.tagName)) {
            const text = node.textContent?.trim();
            if (text) {
              entries.push({
                kind: "heading",
                level: parseInt(node.tagName[1]!),
                text: text.substring(0, MAX_TEXT),
              });
            }
            return; // Don't recurse into headings
          }

          // Interactive element
          if (node.matches(INTERACTIVE_SELECTOR)) {
            entries.push({ kind: "interactive", el: node });
            return; // Don't recurse — label captures the text
          }

          // Leaf text content (context for the agent)
          if (
            !intOnly &&
            node.childElementCount === 0 &&
            node.textContent?.trim()
          ) {
            const text = node.textContent.trim();
            if (text.length > 2 && text.length <= MAX_TEXT) {
              entries.push({ kind: "text", text });
            }
          }

          // Recurse into children
          for (const child of node.children) {
            walk(child, depth + 1);
          }
        }

        walk(document.body, 0);

        // Format output
        const lines: string[] = [];
        lines.push(`# ${document.title}`);
        lines.push(`URL: ${location.href}`);
        lines.push("");

        let ref = 1;
        let interactiveCount = 0;

        for (const entry of entries) {
          if (entry.kind === "heading") {
            lines.push("");
            lines.push(
              `${"#".repeat(Math.min(entry.level, 4))} ${entry.text}`,
            );
          } else if (entry.kind === "interactive") {
            if (interactiveCount >= MAX_ELEMENTS) continue;
            interactiveCount++;

            const el = entry.el;
            const r = ref++;
            el.setAttribute("data-tango-ref", String(r));

            const type = getType(el);
            const label = getLabel(el);
            const parts: string[] = [`[${r}]`, type];

            if (label) parts.push(`"${label}"`);

            const inputEl = el as HTMLInputElement;
            const inputMeta = [
              inputEl.type,
              inputEl.name,
              inputEl.id,
              inputEl.autocomplete,
              inputEl.getAttribute("aria-label") || "",
            ].join(" ");
            const sensitiveInput = /password|token|otp|mfa|one[-_\\s]?time|passcode|security\\s+code/i.test(inputMeta);
            if (
              inputEl.value &&
              !sensitiveInput &&
              !["BUTTON", "A", "SUMMARY"].includes(el.tagName)
            ) {
              parts.push(`value="${inputEl.value.substring(0, 80)}"`);
            }

            if (inputEl.checked) parts.push("[checked]");
            if (inputEl.disabled || el.hasAttribute("disabled"))
              parts.push("[disabled]");
            if (el.getAttribute("aria-expanded") === "true")
              parts.push("[expanded]");
            if (el.getAttribute("aria-selected") === "true")
              parts.push("[selected]");

            if (el.tagName === "SELECT") {
              const sel = el as HTMLSelectElement;
              const opts = Array.from(sel.options)
                .map((o) => o.text.trim())
                .filter(Boolean)
                .slice(0, 8);
              if (opts.length > 0) parts.push(`options=[${opts.join(", ")}]`);
            }

            lines.push(parts.join(" "));
          } else if (entry.kind === "text") {
            lines.push(`  ${entry.text}`);
          }
        }

        lines.push("");
        lines.push(`--- ${ref - 1} interactive elements ---`);
        return lines.join("\n");
      },
      interactiveOnly,
    );

    return result;
  }

  /** Take a screenshot and save to a temp file. Returns the file path. */
  async screenshot(options?: { fullPage?: boolean; ref?: number; selector?: string }): Promise<string> {
    const page = this.getPage();
    const ts = Date.now();
    const filePath = `/tmp/tango-screenshot-${ts}.png`;

    if (typeof options?.ref === "number") {
      const locator = page.locator(`[data-tango-ref="${options.ref}"]`);
      const count = await locator.count();
      if (count === 0) {
        throw new Error(`Ref ${options.ref} not found. Take a new snapshot before capturing.`);
      }
      await locator.first().screenshot({
        path: filePath,
        type: "png",
      });
      return filePath;
    }

    if (typeof options?.selector === "string" && options.selector.trim().length > 0) {
      const locator = page.locator(options.selector);
      const count = await locator.count();
      if (count === 0) {
        throw new Error(`Selector did not match any elements: ${options.selector}`);
      }
      await locator.first().screenshot({
        path: filePath,
        type: "png",
      });
      return filePath;
    }

    await page.screenshot({
      path: filePath,
      type: "png",
      fullPage: options?.fullPage ?? false,
    });
    return filePath;
  }

  /** Click an element by ref number from the last snapshot. */
  async click(ref: number): Promise<string> {
    const page = this.getPage();
    const locator = page.locator(`[data-tango-ref="${ref}"]`);
    const count = await locator.count();
    if (count === 0)
      throw new Error(
        `Ref ${ref} not found. Take a new snapshot — refs change after navigation.`,
      );

    const tag = await locator.evaluate((el: Element) => el.tagName);
    const label = await locator
      .evaluate(
        (el: Element) =>
          el.getAttribute("aria-label") ||
          el.textContent?.trim().substring(0, 80) ||
          "",
      )
      .catch(() => "");

    await locator.click({ timeout: 10_000 });
    await page.waitForTimeout(500);

    debug(`Clicked [${ref}] ${tag} "${label}"`);
    return `Clicked [${ref}] "${label}"`;
  }

  /** Fill an input by ref. Clears existing value first. */
  async fill(ref: number, value: string): Promise<string> {
    const page = this.getPage();
    const locator = page.locator(`[data-tango-ref="${ref}"]`);
    const count = await locator.count();
    if (count === 0) throw new Error(`Ref ${ref} not found. Re-snapshot.`);

    await locator.fill(value, { timeout: 10_000 });
    return `Filled [${ref}]`;
  }

  /** Upload one or more files into a file input by ref. */
  async upload(ref: number, filePaths: string[]): Promise<string> {
    const page = this.getPage();
    const locator = page.locator(`[data-tango-ref="${ref}"]`);
    const count = await locator.count();
    if (count === 0) {
      throw new Error(`Ref ${ref} not found. Re-snapshot.`);
    }
    if (filePaths.length === 0) {
      throw new Error("upload requires at least one file path");
    }

    await locator.setInputFiles(filePaths);
    return `Uploaded ${filePaths.length} file(s) into [${ref}]`;
  }

  private async collectVisibleViewportText(page: Page): Promise<string> {
    return page.locator("body").evaluate((body) => {
      const parts: string[] = [];
      const seen = new Set<string>();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      for (const element of [body, ...Array.from(body.querySelectorAll("*"))]) {
        const rect = element.getBoundingClientRect();
        if (
          rect.width < 12
          || rect.height < 12
          || rect.bottom <= 0
          || rect.right <= 0
          || rect.top >= viewportHeight
          || rect.left >= viewportWidth
        ) {
          continue;
        }

        const rawText = (element as HTMLElement).innerText ?? element.textContent ?? "";
        const text = rawText.replace(/\s+/gu, " ").trim();
        if (!text || seen.has(text)) {
          continue;
        }
        seen.add(text);
        parts.push(text);
      }

      return parts.join(" | ");
    });
  }

  private async captureWalmartOrderDateSummaryClip(
    page: Page,
    summaryLocator: ReturnType<Page["locator"]>,
    orderId: string | null | undefined,
    filePath: string,
  ): Promise<{
    captureMode: string;
    dateVisible: boolean;
    visibleDateText: string[];
    verificationWarnings: string[];
  } | null> {
    const pageText = await page.locator("body").innerText().catch(() => "");
    const candidateDates = extractWalmartExplicitDates(pageText)
      .filter((value) => parseFlexibleDateToIso(value) != null);
    if (candidateDates.length === 0) {
      return null;
    }

    const summaryBox = await summaryLocator.boundingBox().catch(() => null);
    if (!summaryBox) {
      return null;
    }

    const orderLocator = orderId
      ? page.getByText(new RegExp(`Order#\\s*${escapeRegex(orderId)}`, "iu")).first()
      : page.getByText(/Order#/iu).first();
    const orderBox = await orderLocator.boundingBox().catch(() => null);
    if (!orderBox) {
      return null;
    }

    for (const dateText of candidateDates) {
      const dateLocator = page.getByText(
        new RegExp(`${escapeRegex(dateText)}\\s+order`, "iu"),
      ).first();
      const count = await dateLocator.count().catch(() => 0);
      if (count === 0) {
        continue;
      }
      await dateLocator.waitFor({ state: "visible", timeout: 1_500 }).catch(() => undefined);
      const dateBox = await dateLocator.boundingBox().catch(() => null);
      if (!dateBox) {
        continue;
      }

      const x = Math.max(0, Math.min(dateBox.x, orderBox.x, summaryBox.x) - 24);
      const y = Math.max(0, Math.min(dateBox.y, orderBox.y, summaryBox.y) - 24);
      const right = Math.max(
        dateBox.x + dateBox.width,
        orderBox.x + orderBox.width,
        summaryBox.x + summaryBox.width,
      );
      const bottom = Math.max(
        dateBox.y + dateBox.height,
        orderBox.y + orderBox.height,
        summaryBox.y + summaryBox.height,
      );

      await page.screenshot({
        path: filePath,
        clip: {
          x,
          y,
          width: right - x + 24,
          height: bottom - y + 24,
        },
        type: "png",
      });
      return {
        captureMode: "order-date+payment-summary-clip",
        dateVisible: true,
        visibleDateText: [dateText],
        verificationWarnings: [],
      };
    }

    return null;
  }

  private async captureWalmartViewportEvidence(
    page: Page,
    summaryLocator: ReturnType<Page["locator"]>,
    orderId: string | null | undefined,
    filePath: string,
  ): Promise<{
    captureMode: string;
    dateVisible: boolean;
    visibleDateText: string[];
    verificationWarnings: string[];
  } | null> {
    const summaryBox = await summaryLocator.boundingBox().catch(() => null);
    if (summaryBox) {
      const currentScrollY = await page.evaluate(() => window.scrollY);
      const targetTop = 260;
      const targetScrollY = Math.max(0, currentScrollY + summaryBox.y - targetTop);
      await page.evaluate((scrollY) => {
        window.scrollTo({ top: scrollY, behavior: "auto" });
      }, targetScrollY).catch(() => undefined);
      await page.waitForTimeout(300);
    }

    const visibleText = await this.collectVisibleViewportText(page);
    if (!/driver tip/i.test(visibleText)) {
      return null;
    }
    if (orderId && !new RegExp(`order#?\\s*${escapeRegex(orderId)}`, "iu").test(visibleText)) {
      return null;
    }

    const visibleDateText = extractWalmartExplicitDates(visibleText);
    if (visibleDateText.length === 0) {
      return null;
    }

    await page.screenshot({
      path: filePath,
      type: "png",
    });
    return {
      captureMode: "viewport-with-date-context",
      dateVisible: true,
      visibleDateText,
      verificationWarnings: [],
    };
  }

  async captureWalmartTipEvidence(input: {
    orderUrl: string;
    outputPath?: string;
  }): Promise<{
    orderUrl: string;
    screenshotPath: string;
    sourceScreenshotPath: string;
    tipText: string;
    selectorUsed: string;
    captureMode: string;
    dateVisible: boolean;
    visibleDateText: string[];
    verificationWarnings: string[];
    evidenceSha256: string;
    imageWidth?: number;
    imageHeight?: number;
  }> {
    const page = this.getPage();
    const filePath =
      input.outputPath?.trim() || `/tmp/tango-walmart-tip-${Date.now()}.png`;
    const orderId = extractWalmartOrderIdFromUrl(input.orderUrl);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await page.goto(input.orderUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      }).catch(() => undefined);
      await page.waitForTimeout(attempt === 0 ? 3_000 : 5_000);
      const directCapture = await this.tryCaptureWalmartTipEvidenceFromCurrentPage(page, filePath, orderId);
      if (directCapture) {
        const archivedEvidence = archiveReimbursementEvidence({
          sourcePath: directCapture.sourceScreenshotPath,
          orderId: orderId ?? undefined,
          label: "walmart-tip-evidence",
          metadata: {
            kind: "walmart_tip_evidence",
            orderId: orderId ?? undefined,
            selectorUsed: directCapture.selectorUsed,
            captureMode: directCapture.captureMode,
            dateVisible: directCapture.dateVisible,
            visibleDateText: directCapture.visibleDateText,
            verificationWarnings: directCapture.verificationWarnings,
            capturedAt: new Date().toISOString(),
          },
        });
        return {
          ...directCapture,
          screenshotPath: archivedEvidence.archivedPath,
          evidenceSha256: archivedEvidence.sha256,
          imageWidth: archivedEvidence.imageWidth,
          imageHeight: archivedEvidence.imageHeight,
        };
      }

      const bodyText = (await page.locator("body").innerText().catch(() => "")).trim();
      if (attempt === 0 && /WCP_ORDER_FAIL|try again/iu.test(bodyText)) {
        debug("Walmart order page returned a transient error; retrying evidence capture once.");
      } else {
        break;
      }
    }

    if (orderId) {
      const historyUrl = await this.openWalmartOrderFromPurchaseHistory(page, orderId);
      const historyCapture = await this.tryCaptureWalmartTipEvidenceFromCurrentPage(page, filePath, orderId);
      if (historyCapture) {
        const archivedEvidence = archiveReimbursementEvidence({
          sourcePath: historyCapture.sourceScreenshotPath,
          orderId,
          label: "walmart-tip-evidence",
          metadata: {
            kind: "walmart_tip_evidence",
            orderId,
            selectorUsed: historyCapture.selectorUsed,
            captureMode: historyCapture.captureMode,
            dateVisible: historyCapture.dateVisible,
            visibleDateText: historyCapture.visibleDateText,
            verificationWarnings: historyCapture.verificationWarnings,
            capturedAt: new Date().toISOString(),
          },
        });
        return {
          ...historyCapture,
          orderUrl: historyUrl,
          screenshotPath: archivedEvidence.archivedPath,
          evidenceSha256: archivedEvidence.sha256,
          imageWidth: archivedEvidence.imageWidth,
          imageHeight: archivedEvidence.imageHeight,
        };
      }
    }

    throw new Error(
      "Could not capture a Walmart evidence screenshot that clearly shows Driver tip and an explicit visible date.",
    );
  }

  private async tryCaptureWalmartTipEvidenceFromCurrentPage(
    page: Page,
    filePath: string,
    orderId?: string | null,
  ): Promise<{
    orderUrl: string;
    screenshotPath: string;
    sourceScreenshotPath: string;
    tipText: string;
    selectorUsed: string;
    captureMode: string;
    dateVisible: boolean;
    visibleDateText: string[];
    verificationWarnings: string[];
  } | null> {
    const orderDateLocator = page.getByText(
      /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2},\s+\d{4}\s+order\b/iu,
    ).first();
    await orderDateLocator.waitFor({ state: "visible", timeout: 4_000 }).catch(() => undefined);

    for (const selector of WALMART_PAYMENT_SUMMARY_SELECTORS) {
      const locator = page.locator(selector).first();
      const count = await locator.count().catch(() => 0);
      if (count === 0) continue;
      const text = await locator.innerText().catch(() => "");
      if (!/driver tip/i.test(text)) continue;

      const exactDateCapture = await this.captureWalmartOrderDateSummaryClip(
        page,
        locator,
        orderId,
        filePath,
      );
      if (exactDateCapture) {
        return {
          orderUrl: page.url(),
          screenshotPath: filePath,
          sourceScreenshotPath: filePath,
          tipText: text.trim(),
          selectorUsed: `${selector} -> ${exactDateCapture.captureMode}`,
          captureMode: exactDateCapture.captureMode,
          dateVisible: exactDateCapture.dateVisible,
          visibleDateText: exactDateCapture.visibleDateText,
          verificationWarnings: exactDateCapture.verificationWarnings,
        };
      }

      let headerLocator = orderDateLocator;
      if ((await headerLocator.count().catch(() => 0)) === 0) {
        headerLocator = orderId
          ? page.getByText(new RegExp(`Order#\\s*${escapeRegex(orderId)}`, "iu")).first()
          : page.getByText(/Order#/iu).first();
      }

      const screenshotMode = await this.captureWalmartEvidenceRegion(
        page,
        locator,
        headerLocator,
        orderId,
        filePath,
      );
      if (!screenshotMode) {
        continue;
      }

      return {
        orderUrl: page.url(),
        screenshotPath: filePath,
        sourceScreenshotPath: filePath,
        tipText: text.trim(),
        selectorUsed: `${selector} -> ${screenshotMode.captureMode}`,
        captureMode: screenshotMode.captureMode,
        dateVisible: screenshotMode.dateVisible,
        visibleDateText: screenshotMode.visibleDateText,
        verificationWarnings: screenshotMode.verificationWarnings,
      };
    }

    return null;
  }

  private async captureWalmartEvidenceRegion(
    page: Page,
    summaryLocator: ReturnType<Page["locator"]>,
    headerLocator: ReturnType<Page["getByText"]>,
    orderId: string | null | undefined,
    filePath: string,
  ): Promise<{
    captureMode: string;
    dateVisible: boolean;
    visibleDateText: string[];
    verificationWarnings: string[];
  } | null> {
    const readPageRect = async (
      locator: ReturnType<Page["locator"]> | ReturnType<Page["getByText"]>,
      options: { preferDateContext?: boolean } = {},
    ): Promise<{
      x: number;
      y: number;
      width: number;
      height: number;
      text: string;
    } | null> =>
      locator
        .evaluate((element, preferDateContext) => {
          const normalize = (value: string | null | undefined) =>
            (value ?? "").replace(/\s+/gu, " ").trim();
          const hasExplicitDate = (value: string) =>
            /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:,\s*\d{4})?|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/iu.test(
              value,
            );
          let candidate: Element = element;
          if (preferDateContext) {
            let current = element.parentElement;
            while (current) {
              const text = normalize(current.textContent);
              const rect = current.getBoundingClientRect();
              if (
                rect.width > 0
                && rect.height > 0
                && /order#/iu.test(text)
                && hasExplicitDate(text)
              ) {
                candidate = current;
                break;
              }
              current = current.parentElement;
            }
          }
          const rect = candidate.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) {
            return null;
          }
          return {
            x: window.scrollX + rect.x,
            y: window.scrollY + rect.y,
            width: rect.width,
            height: rect.height,
            text: normalize(candidate.textContent),
          };
        }, options.preferDateContext === true)
        .catch(() => null);

    const summaryBox = await readPageRect(summaryLocator);
    const headerBox = await readPageRect(headerLocator, { preferDateContext: true });
    const orderIdBox = orderId
      ? await readPageRect(page.getByText(new RegExp(`Order#\\s*${escapeRegex(orderId)}`, "iu")).first())
      : null;
    if (summaryBox && headerBox) {
      const clipLeft = Math.max(
        0,
        Math.min(summaryBox.x, headerBox.x, orderIdBox?.x ?? Number.POSITIVE_INFINITY) - 24,
      );
      const clipTop = Math.max(
        0,
        Math.min(summaryBox.y, headerBox.y, orderIdBox?.y ?? Number.POSITIVE_INFINITY) - 24,
      );
      const clipRight = Math.max(
        summaryBox.x + summaryBox.width,
        headerBox.x + headerBox.width,
        orderIdBox ? orderIdBox.x + orderIdBox.width : 0,
      );
      const clipBottom = Math.max(
        summaryBox.y + summaryBox.height,
        headerBox.y + headerBox.height,
        orderIdBox ? orderIdBox.y + orderIdBox.height : 0,
      );
      await page.screenshot({
        path: filePath,
        clip: {
          x: clipLeft,
          y: clipTop,
          width: clipRight - clipLeft + 24,
          height: clipBottom - clipTop + 24,
        },
        type: "png",
      });
      const visibleDateText = extractWalmartExplicitDates(
        `${headerBox.text} ${orderIdBox?.text ?? ""} ${await summaryLocator.innerText().catch(() => "")}`,
      );
      if (visibleDateText.length > 0) {
        return {
          captureMode: orderIdBox ? "order-date+payment-summary-clip" : "order-header+payment-summary-clip",
          dateVisible: true,
          visibleDateText,
          verificationWarnings: [],
        };
      }
    }
    if (summaryBox && headerBox) {
      const headerText = headerBox.text.trim();
      const clip = {
        x: Math.max(0, Math.min(summaryBox.x, headerBox.x) - 24),
        y: Math.max(0, Math.min(summaryBox.y, headerBox.y) - 24),
        width: Math.max(summaryBox.x + summaryBox.width, headerBox.x + headerBox.width)
          - Math.max(0, Math.min(summaryBox.x, headerBox.x) - 24)
          + 24,
        height: Math.max(summaryBox.y + summaryBox.height, headerBox.y + headerBox.height)
          - Math.max(0, Math.min(summaryBox.y, headerBox.y) - 24)
          + 24,
      };
      await page.screenshot({
        path: filePath,
        clip,
        type: "png",
      });
      const visibleDateText = extractWalmartExplicitDates(`${headerText} ${await summaryLocator.innerText().catch(() => "")}`);
      if (visibleDateText.length > 0) {
        return {
          captureMode: "order-header+payment-summary-clip",
          dateVisible: true,
          visibleDateText,
          verificationWarnings: [],
        };
      }
    }

    const viewportCapture = await this.captureWalmartViewportEvidence(
      page,
      summaryLocator,
      orderId,
      filePath,
    );
    if (viewportCapture) {
      return viewportCapture;
    }

    const captureMeta = await summaryLocator.evaluate((el) => {
      const normalize = (value: string | null | undefined) =>
        (value ?? "").replace(/\s+/gu, " ").trim();
      let candidate: Element = el;
      let current = el.parentElement;
      while (current) {
        const text = normalize(current.textContent);
        const rect = current.getBoundingClientRect();
        if (
          /driver tip/i.test(text)
          && rect.width >= 240
          && rect.height >= 120
          && rect.height <= 2200
          && /(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/iu.test(text)
        ) {
          candidate = current;
          break;
        }
        current = current.parentElement;
      }

      candidate.setAttribute("data-tango-reimbursement-capture", "1");
      return {
        candidateText: normalize(candidate.textContent),
        usedAncestor: candidate !== el,
      };
    });

    const captureLocator = page.locator('[data-tango-reimbursement-capture="1"]').first();
    try {
      await captureLocator.screenshot({ path: filePath, type: "png" });
    } finally {
      await page.locator('[data-tango-reimbursement-capture="1"]').evaluateAll((elements) => {
        for (const element of elements) {
          element.removeAttribute("data-tango-reimbursement-capture");
        }
      }).catch(() => undefined);
    }

    const visibleDateText = extractWalmartExplicitDates(captureMeta.candidateText);
    if (visibleDateText.length > 0) {
      return {
        captureMode: "ancestor-with-date-context",
        dateVisible: true,
        visibleDateText,
        verificationWarnings: [],
      };
    }

    return null;
  }

  private async openWalmartOrderFromPurchaseHistory(page: Page, orderId: string): Promise<string> {
    const flatOrderId = flattenWalmartOrderId(orderId);
    await page.goto("https://www.walmart.com/orders", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    }).catch(() => undefined);
    await page.waitForTimeout(4_000);
    await page
      .waitForSelector('[data-automation-id^="view-order-details-link-"]', {
        timeout: 12_000,
      })
      .catch(() => undefined);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const exactSelector = `[data-automation-id="view-order-details-link-${flatOrderId}"]`;
      let button = page.locator(exactSelector).first();
      if ((await button.count().catch(() => 0)) === 0) {
        const matchedAutomationId = await page
          .locator('[data-automation-id^="view-order-details-link-"]')
          .evaluateAll((elements, targetOrderId) => {
            const target = String(targetOrderId ?? "");
            for (const element of elements) {
              const automationId = element.getAttribute("data-automation-id");
              if (automationId?.includes(target)) {
                return automationId;
              }
            }
            return null;
          }, flatOrderId)
          .catch(() => null);
        if (matchedAutomationId) {
          button = page.locator(`[data-automation-id="${matchedAutomationId}"]`).first();
        }
      }
      if ((await button.count().catch(() => 0)) > 0) {
        await button.scrollIntoViewIfNeeded().catch(() => undefined);
        await page.waitForTimeout(500);
        await button.click({ timeout: 10_000 }).catch(() => undefined);
        await page.waitForTimeout(6_000);
        return page.url();
      }
      await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(1_200);
    }

    throw new Error(`Could not find Walmart purchase-history card for order ${orderId}.`);
  }

  private parseCurrencyFromText(text: string, patterns: RegExp[]): number | undefined {
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (!match?.[1]) {
        continue;
      }
      const parsed = Number.parseFloat(match[1].replace(/[$,]/gu, ""));
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return undefined;
  }

  private async collectWalmartHistoryPageEntries(page: Page): Promise<Array<{
    orderId: string;
    orderUrl: string;
    cardText: string;
    automationId: string;
  }>> {
    const entries = await page
      .locator('[data-automation-id^="view-order-details-link-"]')
      .evaluateAll((elements) => {
        const results: Array<{
          orderId: string;
          orderUrl: string;
          cardText: string;
          automationId: string;
        }> = [];
        for (const element of elements) {
          const href = typeof (element as { href?: unknown }).href === "string"
            ? String((element as { href?: unknown }).href)
            : "";
          const automationId = element.getAttribute("data-automation-id") || "";
          const rawOrder =
            href.match(/\/orders\/([0-9-]{10,})/i)?.[1]
            || automationId.replace(/^view-order-details-link-/i, "");
          const flat = rawOrder.replace(/\D/g, "");
          if (flat.length < 15) {
            continue;
          }
          const orderId = `${flat.slice(0, 7)}-${flat.slice(7, 15)}`;
          let card: Element | null = element.parentElement;
          let bestText = "";
          while (card && card !== document.body) {
            const text = (card.textContent || "").replace(/\s+/gu, " ").trim();
            if (text.length > bestText.length) {
              bestText = text;
            }
            if (text.length >= 40 && /delivery|pickup|store purchase|shipping/i.test(text)) {
              bestText = text;
              break;
            }
            card = card.parentElement;
          }
          const cardText = bestText;
          results.push({
            orderId,
            orderUrl: href,
            cardText,
            automationId,
          });
        }
        return results;
      })
      .catch(() => []);

    const deduped = new Map<string, { orderId: string; orderUrl: string; cardText: string; automationId: string }>();
    for (const entry of entries) {
      if (!deduped.has(entry.orderId)) {
        deduped.set(entry.orderId, entry);
      }
    }
    return [...deduped.values()];
  }

  private async openNextWalmartHistoryPage(page: Page): Promise<boolean> {
    const nextButton = page.getByRole("button", { name: /next page/i }).first();
    if ((await nextButton.count().catch(() => 0)) === 0) {
      return false;
    }
    const disabled = await nextButton.isDisabled().catch(() => true);
    if (disabled) {
      return false;
    }
    await nextButton.click({ timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(3_500);
    return true;
  }

  private async inspectWalmartHistoryEntry(
    page: Page,
    entry: { orderId: string; orderUrl: string; cardText: string; automationId: string },
  ): Promise<WalmartHistoryCandidate | null> {
    const detailPage = await createBackgroundPage(page.context());
    try {
      const targetUrl = entry.orderUrl || `https://www.walmart.com/orders/${flattenWalmartOrderId(entry.orderId)}`;
      await detailPage.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      }).catch(() => undefined);
      await detailPage.waitForTimeout(4_000);

      if (!/\/orders\/[0-9]+/i.test(detailPage.url())) {
        return null;
      }

      const bodyText = await detailPage.locator("body").innerText().catch(() => "");
      if (!/delivery from store/i.test(bodyText)) {
        return null;
      }

      const orderDateLocator = detailPage.getByText(
        /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2},\s+\d{4}\s+order\b/iu,
      ).first();
      const orderDateText = (
        await orderDateLocator.innerText().catch(() => "")
      ).replace(/\s+order$/iu, "").trim();
      const fallbackDateText = extractWalmartExplicitDates(bodyText).find((value) => parseFlexibleDateToIso(value) != null) ?? "";
      const dateText = orderDateText || fallbackDateText;
      const date = parseFlexibleDateToIso(dateText);
      if (!date) {
        return null;
      }

      const summaryText = await detailPage
        .locator(WALMART_PAYMENT_SUMMARY_SELECTORS.join(", "))
        .first()
        .innerText()
        .catch(() => "");
      const combinedText = `${summaryText}\n${bodyText}`;
      const driverTip = this.parseCurrencyFromText(combinedText, [
        /driver tip\s*\$([0-9.,]+)/iu,
        /driver tip:\s*\$([0-9.,]+)/iu,
        /\|\s*Driver tip\s*\|\s*\$([0-9.,]+)\s*\|/iu,
      ]);
      if (driverTip == null || driverTip <= 0) {
        return null;
      }

      const total = this.parseCurrencyFromText(combinedText, [
        /\bTotal\s*\$([0-9.,]+)/iu,
      ]);
      const temporaryHold = this.parseCurrencyFromText(combinedText, [
        /temporary hold\s*\$([0-9.,]+)/iu,
        /temporary adjusted total\s*\$([0-9.,]+)/iu,
      ]);
      const bagFee = this.parseCurrencyFromText(combinedText, [/bag fee\s*\$([0-9.,]+)/iu]);
      const speedFee = this.parseCurrencyFromText(combinedText, [
        /3 hours or less fee\s*\$([0-9.,]+)/iu,
      ]);
      const subtotal = this.parseCurrencyFromText(combinedText, [
        /subtotal\s*\$([0-9.,]+)/iu,
        /items subtotal\s*\$([0-9.,]+)/iu,
      ]);
      const receivedMatch = /(\d+\s+received(?:\s+\([^)]+\))?)/iu.exec(combinedText);
      const itemsLine = receivedMatch?.[1]?.trim();

      const noteParts = [
        "Delivery from store.",
        `Delivered on ${dateText}.`,
        subtotal != null ? `Subtotal $${subtotal.toFixed(2)}.` : null,
        speedFee != null ? `3 hours or less fee $${speedFee.toFixed(2)}.` : null,
        bagFee != null ? `Bag fee $${bagFee.toFixed(2)}.` : null,
        `Driver tip $${driverTip.toFixed(2)} charged separately after delivery.`,
      ].filter((value): value is string => Boolean(value));

      return {
        orderId: normalizeWalmartOrderId(entry.orderId),
        orderUrl: detailPage.url(),
        date,
        dateText,
        driverTip,
        total,
        cardCharge: total != null
          ? `$${total.toFixed(2)}${temporaryHold != null ? ` (temporary hold $${temporaryHold.toFixed(2)} shown; updated charge may appear within 10 business days)` : ""}`
          : undefined,
        itemsLine,
        deliverySummary: "Delivery from store",
        notes: noteParts.join(" "),
      };
    } finally {
      await detailPage.close().catch(() => undefined);
    }
  }

  async discoverWalmartDeliveryCandidates(input?: {
    since?: string;
    until?: string;
    maxPages?: number;
  }): Promise<WalmartHistoryCandidate[]> {
    const page = this.getPage();
    const since = input?.since?.trim() || null;
    const until = input?.until?.trim() || null;
    const maxPages = Math.max(1, Math.min(input?.maxPages ?? 8, 20));
    const candidates = new Map<string, WalmartHistoryCandidate>();

    await page.goto("https://www.walmart.com/orders", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    }).catch(() => undefined);
    await page.waitForTimeout(4_000);

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const entries = await this.collectWalmartHistoryPageEntries(page);
      for (const entry of entries) {
        if (candidates.has(entry.orderId)) {
          continue;
        }
        const detail = await this.inspectWalmartHistoryEntry(page, entry);
        if (!detail) {
          continue;
        }
        if (since && detail.date < since) {
          continue;
        }
        if (until && detail.date > until) {
          continue;
        }
        candidates.set(detail.orderId, detail);
      }

      if (!(await this.openNextWalmartHistoryPage(page))) {
        break;
      }
    }

    return [...candidates.values()].sort((left, right) => left.date.localeCompare(right.date));
  }

  private buildExpenseDeskHistoryRecordFromRow(input: {
    reviewUrl: string;
    cells: string[];
  }): ExpenseReimbursementHistoryRecord | null {
    return parseExpenseDeskHistoryRecordFromRow(input);
  }

  private async readVisibleExpenseDeskHistoryRows(page: Page): Promise<Array<{
    reviewUrl: string;
    cells: string[];
  }>> {
    return page.evaluate(() =>
      [...document.querySelectorAll("tbody tr")]
        .map((row) => {
          const reviewAnchor =
            row.querySelector('a[href*="/details/list/reimbursement/"]')
            ?? row.querySelector('a[href*="/details/reimbursements/"]');
          const reviewUrl =
            reviewAnchor instanceof HTMLAnchorElement
              ? reviewAnchor.href
              : "";
          const cells = [...row.querySelectorAll("td")].map((cell) =>
            (cell.textContent ?? "").replace(/\s+/gu, " ").trim()
          );
          return { reviewUrl, cells };
        })
        .filter((row) => row.reviewUrl.length > 0 && row.cells.some((cell) => cell.length > 0)),
    ).catch(() => []);
  }

  private async collectExpenseDeskHistoryPageRecords(page: Page): Promise<ExpenseReimbursementHistoryRecord[]> {
    await page.waitForFunction(
      () =>
        document.querySelector('tbody tr a[href*="/details/list/reimbursement/"]')
        || document.querySelector('tbody tr a[href*="/details/reimbursements/"]'),
      { timeout: 20_000 },
    ).catch(() => undefined);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" })).catch(() => undefined);
    await page.waitForTimeout(300);

    const records = new Map<string, ExpenseReimbursementHistoryRecord>();
    let stagnantPasses = 0;
    let lastCount = 0;

    for (let pass = 0; pass < 24; pass += 1) {
      const rows = await this.readVisibleExpenseDeskHistoryRows(page);
      for (const row of rows) {
        const parsed = this.buildExpenseDeskHistoryRecordFromRow(row);
        if (!parsed) {
          continue;
        }
        records.set(parsed.reviewUrl, parsed);
      }

      if (records.size === lastCount) {
        stagnantPasses += 1;
      } else {
        stagnantPasses = 0;
        lastCount = records.size;
      }

      const canScrollFurther = await page.evaluate(() =>
        window.scrollY + window.innerHeight + 24 < document.documentElement.scrollHeight,
      ).catch(() => false);
      if (!canScrollFurther && stagnantPasses >= 1) {
        break;
      }

      await page.mouse.wheel(0, 720);
      await page.waitForTimeout(600);
    }

    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" })).catch(() => undefined);
    await page.waitForTimeout(250);
    return [...records.values()];
  }

  private async openNextExpenseDeskHistoryPage(page: Page): Promise<boolean> {
    const nextButton = page.getByRole("button", { name: /^Next \d+-\d+$/u }).first();
    if ((await nextButton.count().catch(() => 0)) === 0) {
      return false;
    }
    const disabled = await nextButton.isDisabled().catch(() => true);
    if (disabled) {
      return false;
    }

    const previousFirstHref = await page
      .locator('tbody tr a[href*="/details/list/reimbursement/"], tbody tr a[href*="/details/reimbursements/"]')
      .first()
      .getAttribute("href")
      .catch(() => null);

    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" })).catch(() => undefined);
    await page.waitForTimeout(250);
    await nextButton.click({ timeout: 10_000 }).catch(() => undefined);
    await page.waitForFunction(
      (previousHref) => {
        const currentHref =
          document.querySelector('tbody tr a[href*="/details/list/reimbursement/"]')?.getAttribute("href")
          ?? document.querySelector('tbody tr a[href*="/details/reimbursements/"]')?.getAttribute("href")
          ?? null;
        return currentHref != null && currentHref !== previousHref;
      },
      previousFirstHref,
      { timeout: 20_000 },
    ).catch(() => undefined);
    await page.waitForFunction(
      () =>
        document.querySelector('tbody tr a[href*="/details/list/reimbursement/"]')
        || document.querySelector('tbody tr a[href*="/details/reimbursements/"]'),
      { timeout: 20_000 },
    ).catch(() => undefined);
    await page.waitForTimeout(1_500);
    return true;
  }

  async listExpenseDeskReimbursementHistory(input?: {
    maxPages?: number;
  }): Promise<ExpenseReimbursementHistoryRecord[]> {
    const page = this.getPage();
    const maxPages = Math.max(1, Math.min(input?.maxPages ?? 3, 10));
    const records = new Map<string, ExpenseReimbursementHistoryRecord>();

    await page.goto("https://expenses.example.com/home/personal-expenses/reimbursements", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    }).catch(() => undefined);
    await page.waitForTimeout(3_000);
    await this.assertExpenseDeskPageAuthenticated(page, "inspect ExpenseDesk reimbursement history");
    await page.locator("table").first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);
    await page.waitForFunction(
      () =>
        document.querySelector('tbody tr a[href*="/details/list/reimbursement/"]')
        || document.querySelector('tbody tr a[href*="/details/reimbursements/"]'),
      { timeout: 20_000 },
    ).catch(() => undefined);
    await page.waitForTimeout(2_000);

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const pageRecords = await this.collectExpenseDeskHistoryPageRecords(page);
      for (const record of pageRecords) {
        records.set(record.reviewUrl, record);
      }

      if (!(await this.openNextExpenseDeskHistoryPage(page))) {
        break;
      }
    }

    return [...records.values()].sort((left, right) =>
      `${right.submittedDate ?? ""}::${right.transactionDate ?? ""}`.localeCompare(
        `${left.submittedDate ?? ""}::${left.transactionDate ?? ""}`,
      ),
    );
  }

  /**
   * Type text character-by-character into an element.
   * Useful for inputs with autocomplete/live search that need keystroke events.
   */
  async type(ref: number, text: string): Promise<string> {
    const page = this.getPage();
    const locator = page.locator(`[data-tango-ref="${ref}"]`);
    const count = await locator.count();
    if (count === 0) throw new Error(`Ref ${ref} not found. Re-snapshot.`);

    await locator.click({ timeout: 5_000 });
    await locator.pressSequentially(text, { delay: 50, timeout: 30_000 });
    return `Typed into [${ref}]`;
  }

  /** Press a keyboard key (Enter, Tab, Escape, ArrowDown, etc.) */
  async press(key: string): Promise<string> {
    const page = this.getPage();
    await page.keyboard.press(key);
    await page.waitForTimeout(300);
    return `Pressed ${key}`;
  }

  /** Select option(s) from a <select> by ref. */
  async select(ref: number, values: string[]): Promise<string> {
    const page = this.getPage();
    const locator = page.locator(`[data-tango-ref="${ref}"]`);
    const count = await locator.count();
    if (count === 0) throw new Error(`Ref ${ref} not found. Re-snapshot.`);

    await locator.selectOption(values, { timeout: 10_000 });
    return `Selected "${values.join(", ")}" in [${ref}]`;
  }

  /** Scroll the page up or down. */
  async scroll(direction: "up" | "down", pixels?: number): Promise<string> {
    const page = this.getPage();
    const amount = pixels ?? 600;
    const delta = direction === "down" ? amount : -amount;
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(500);
    return `Scrolled ${direction} ${amount}px`;
  }

  /** Wait for a condition: text on page, CSS selector, or plain timeout (ms). */
  async wait(options: {
    selector?: string;
    text?: string;
    timeout?: number;
  }): Promise<string> {
    const page = this.getPage();
    const timeoutMs = options.timeout ?? 10_000;

    if (options.selector) {
      await page.waitForSelector(options.selector, {
        timeout: timeoutMs,
      });
      return `Found selector: ${options.selector}`;
    }

    if (options.text) {
      await page.waitForFunction(
        (t: string) => document.body.textContent?.includes(t) ?? false,
        options.text,
        { timeout: timeoutMs },
      );
      return `Found text: "${options.text}"`;
    }

    await page.waitForTimeout(timeoutMs);
    return `Waited ${timeoutMs}ms`;
  }

  /** Evaluate JavaScript in the page context. Returns the result. */
  async evaluate(script: string): Promise<unknown> {
    const page = this.getPage();
    return page.evaluate(script);
  }

  private async selectExpenseDeskMerchant(page: Page, merchant: string): Promise<void> {
    const merchantButton = page.locator('div[name="merchant"] button').first();
    await merchantButton.click();
    await page.waitForTimeout(500);

    const searchInputs = [
      page.locator('div[name="merchant"] input').first(),
      page.getByRole("combobox").first(),
      page.locator('input[placeholder*="search" i]').first(),
    ];

    for (const candidate of buildExpenseDeskMerchantCandidates(merchant)) {
      for (const input of searchInputs) {
        if ((await input.count().catch(() => 0)) === 0) {
          continue;
        }
        await input.fill(candidate).catch(() => undefined);
        await page.waitForTimeout(350);
      }

      const option = page.getByRole("option", { name: new RegExp(escapeRegex(candidate), "i") }).first();
      if ((await option.count().catch(() => 0)) > 0) {
        await option.click();
        return;
      }
    }

    const visibleOptions = page.getByRole("option");
    if ((await visibleOptions.count().catch(() => 0)) === 1) {
      await visibleOptions.first().click();
      return;
    }

    throw new Error(`Could not select ExpenseDesk merchant for '${merchant}'.`);
  }

  private expenseDraftMatchesInput(record: ExpenseReimbursementHistoryRecord, input: {
    amount: number;
    transactionDate: string;
    merchant: string;
  }): boolean {
    const status = normalizeExpenseDeskMatchKey(record.status);
    if (status !== "draft" && !/\/draft(?:[/?#]|$)/iu.test(record.reviewUrl)) {
      return false;
    }

    const expectedDate = parseFlexibleDateToIso(input.transactionDate)
      ?? parseFlexibleDateToIso(formatExpenseDeskTransactionDate(input.transactionDate))
      ?? input.transactionDate;
    if (record.transactionDate !== expectedDate) {
      return false;
    }
    if (!amountsMatch(record.amount, input.amount)) {
      return false;
    }

    const recordMerchant = normalizeExpenseDeskMatchKey(record.merchant);
    const merchantCandidates = buildExpenseDeskMerchantCandidates(input.merchant).map(normalizeExpenseDeskMatchKey);
    return merchantCandidates.some((candidate) =>
      recordMerchant === candidate
      || recordMerchant.includes(candidate)
      || candidate.includes(recordMerchant)
    );
  }

  private async findMatchingExpenseDeskDraft(input: {
    amount: number;
    transactionDate: string;
    merchant: string;
  }): Promise<ExpenseReimbursementHistoryRecord | null> {
    const records = await this.listExpenseDeskReimbursementHistory({ maxPages: 1 });
    return records.find((record) => this.expenseDraftMatchesInput(record, input)) ?? null;
  }

  private async readExpenseDeskMerchantDisplayValue(page: Page): Promise<string | undefined> {
    const merchantButton = page.locator('div[name="merchant"] button, [name="merchant"] button').first();
    if ((await merchantButton.count().catch(() => 0)) === 0) {
      return undefined;
    }
    if (!(await merchantButton.isVisible().catch(() => false))) {
      return undefined;
    }
    const text = await merchantButton.innerText().catch(() => "");
    return text.replace(/\s+/gu, " ").trim() || undefined;
  }

  private async describeExpenseDeskDraftPage(page: Page): Promise<string> {
    const visibleFields = await page.evaluate(() =>
      [...document.querySelectorAll("input, textarea, [contenteditable='true'], [role='textbox']")]
        .filter((el) => !!(el instanceof HTMLElement && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)))
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute("type"),
          name: el.getAttribute("name"),
          aria: el.getAttribute("aria-label"),
          placeholder: el.getAttribute("placeholder"),
          text: (el.textContent ?? "").replace(/\s+/gu, " ").trim().slice(0, 80),
        }))
        .slice(0, 20),
    ).catch(() => []);
    const body = await page.locator("body").innerText({ timeout: 2_000 })
      .then((text) => text.replace(/\s+/gu, " ").trim().slice(0, 500))
      .catch(() => "");
    return `url=${page.url()}; visibleFields=${JSON.stringify(visibleFields)}; body='${body}'`;
  }

  private async waitForExpenseDeskDraftLocator(
    page: Page,
    locator: Locator,
    label: string,
    timeoutMs = EXPENSE_DRAFT_FIELD_TIMEOUT_MS,
  ): Promise<void> {
    try {
      await locator.waitFor({ state: "visible", timeout: timeoutMs });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `ExpenseDesk ${label} field did not become visible within ${timeoutMs}ms. ${await this.describeExpenseDeskDraftPage(page)}. Original error: ${message}`,
      );
    }
  }

  private async waitForExpenseDeskDraftFormFields(page: Page, timeoutMs = EXPENSE_DRAFT_FIELD_TIMEOUT_MS): Promise<{
    amountInput: Locator;
    dateInput: Locator;
    memoInput: Locator;
  }> {
    const startedAt = Date.now();
    const remaining = () => Math.max(5_000, timeoutMs - (Date.now() - startedAt));
    const amountInput = page.locator('input[name="amount"]').first();
    const dateInput = page.locator('input[name="transaction_date"]').first();

    await this.waitForExpenseDeskDraftLocator(page, amountInput, "amount", remaining());
    await this.waitForExpenseDeskDraftLocator(page, dateInput, "transaction date", remaining());
    const memoInput = await this.findExpenseDeskMemoField(page, remaining());
    return { amountInput, dateInput, memoInput };
  }

  private async findExpenseDeskMemoField(page: Page, timeoutMs = 30_000): Promise<Locator> {
    const candidates = [
      page.locator('input[name="Memo" i], textarea[name="Memo" i]').first(),
      page.locator('input[name*="memo" i], textarea[name*="memo" i]').first(),
      page.locator('div[name="Memo" i] input, div[name="Memo" i] textarea, div[name="Memo" i] [contenteditable="true"], div[name="Memo" i] [role="textbox"]').first(),
      page.locator('[aria-label*="memo" i]').first(),
      page.locator('[placeholder*="memo" i]').first(),
      page.getByLabel(/memo/iu).first(),
      page.getByRole("textbox", { name: /memo/iu }).first(),
      page.locator("label", { hasText: /memo/iu }).locator("xpath=..").locator('input, textarea, [contenteditable="true"], [role="textbox"]').first(),
    ];
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      for (const candidate of candidates) {
        if ((await candidate.count().catch(() => 0)) === 0) {
          continue;
        }
        if (await candidate.isVisible().catch(() => false)) {
          return candidate;
        }
      }
      await page.waitForTimeout(500);
    }

    throw new Error(`ExpenseDesk memo field was not found. ${await this.describeExpenseDeskDraftPage(page)}`);
  }

  private async fillExpenseDeskTextField(locator: Locator, value: string): Promise<void> {
    await locator.fill(value, { timeout: EXPENSE_DRAFT_FIELD_ACTION_TIMEOUT_MS });
    await locator.press("Tab").catch(() => undefined);
    await this.blurExpenseDeskField(locator);
  }

  private async blurExpenseDeskField(locator: Locator): Promise<void> {
    await locator.evaluate((el) => {
      if (!(el instanceof HTMLElement)) {
        return;
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.blur();
    }).catch(() => undefined);
  }

  private async readExpenseDeskTextField(locator: Locator): Promise<string> {
    return await locator.evaluate((el) => {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        return el.value;
      }
      return el.textContent ?? "";
    }).catch(() => "");
  }

  private async fillExpenseDeskMemoField(page: Page, memo: string): Promise<void> {
    const memoInput = await this.findExpenseDeskMemoField(page);
    await this.fillExpenseDeskTextField(memoInput, memo);
    await page.waitForTimeout(250);
    let currentValue = await this.readExpenseDeskTextField(memoInput);
    if (currentValue.trim() !== memo.trim()) {
      await this.fillExpenseDeskTextField(memoInput, memo);
      await this.blurExpenseDeskField(memoInput);
      await page.waitForTimeout(250);
      currentValue = await this.readExpenseDeskTextField(memoInput);
    }
    if (currentValue.trim() !== memo.trim()) {
      throw new Error(`ExpenseDesk memo field did not retain expected value. Expected '${memo}', saw '${currentValue}'.`);
    }
  }

  private async fillExpenseDeskDateField(page: Page, transactionDate: string): Promise<void> {
    const dateInput = page.locator('input[name="transaction_date"]').first();
    const expectedDate = formatExpenseDeskTransactionDate(transactionDate);
    await this.waitForExpenseDeskDraftLocator(page, dateInput, "transaction date");
    await dateInput.click({ timeout: EXPENSE_DRAFT_FIELD_ACTION_TIMEOUT_MS });
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(expectedDate);
    await page.keyboard.press("Tab").catch(() => undefined);
    await this.blurExpenseDeskField(dateInput);
    await page.waitForTimeout(500);
    const currentValue = await dateInput.inputValue().catch(() => "");
    if (!expenseDateTextMatchesInput(currentValue, transactionDate)) {
      await this.waitForExpenseDeskDraftLocator(page, dateInput, "transaction date", EXPENSE_DRAFT_FIELD_ACTION_TIMEOUT_MS);
      await dateInput.fill(expectedDate, { timeout: EXPENSE_DRAFT_FIELD_ACTION_TIMEOUT_MS });
      await dateInput.press("Tab").catch(() => undefined);
      await this.blurExpenseDeskField(dateInput);
      await page.waitForTimeout(500);
    }
  }

  private async assertExpenseDeskDraftFieldValues(page: Page, input: {
    amount: number;
    transactionDate: string;
    memo: string;
  }): Promise<void> {
    const amountInput = page.locator('input[name="amount"]').first();
    const dateInput = page.locator('input[name="transaction_date"]').first();
    await this.waitForExpenseDeskDraftLocator(page, amountInput, "amount", EXPENSE_DRAFT_FIELD_ACTION_TIMEOUT_MS);
    await this.waitForExpenseDeskDraftLocator(page, dateInput, "transaction date", EXPENSE_DRAFT_FIELD_ACTION_TIMEOUT_MS);
    const memoInput = await this.findExpenseDeskMemoField(page, EXPENSE_DRAFT_FIELD_ACTION_TIMEOUT_MS);
    const amountValue = await amountInput.inputValue();
    const dateValue = await dateInput.inputValue();
    const memoValue = await this.readExpenseDeskTextField(memoInput);
    const normalizedAmount = Number(amountValue.replace(/[$,\s]/gu, ""));
    const expectedDate = formatExpenseDeskTransactionDate(input.transactionDate);

    if (!Number.isFinite(normalizedAmount) || Math.abs(normalizedAmount - input.amount) >= 0.01) {
      throw new Error(`ExpenseDesk draft amount mismatch: expected ${input.amount.toFixed(2)}, saw '${amountValue}'.`);
    }
    if (!expenseDateTextMatchesInput(dateValue, input.transactionDate)) {
      throw new Error(`ExpenseDesk draft date mismatch: expected ${expectedDate}, saw '${dateValue}'.`);
    }
    if (memoValue.trim() !== input.memo.trim()) {
      throw new Error(`ExpenseDesk draft memo mismatch: expected '${input.memo}', saw '${memoValue}'.`);
    }
  }

  private async fillExpenseDeskReimbursementDraftFields(page: Page, input: {
    amount: number;
    transactionDate: string;
    memo: string;
    merchant?: string;
  }): Promise<void> {
    const fields = await this.waitForExpenseDeskDraftFormFields(page);
    // ExpenseDesk shows a processing overlay while analyzing the receipt; wait for inputs to become actionable.
    await fields.amountInput
      .click({ timeout: EXPENSE_DRAFT_FIELD_ACTION_TIMEOUT_MS, trial: true })
      .catch(() => undefined);
    await fields.dateInput
      .click({ timeout: EXPENSE_DRAFT_FIELD_ACTION_TIMEOUT_MS, trial: true })
      .catch(() => undefined);
    await fields.memoInput
      .click({ timeout: EXPENSE_DRAFT_FIELD_ACTION_TIMEOUT_MS, trial: true })
      .catch(() => undefined);
    await fields.amountInput.fill(input.amount.toFixed(2), { timeout: EXPENSE_DRAFT_FIELD_ACTION_TIMEOUT_MS });
    await this.fillExpenseDeskDateField(page, input.transactionDate);
    await this.fillExpenseDeskMemoField(page, input.memo);
    await page.waitForTimeout(1_000);
    await this.assertExpenseDeskDraftFieldValues(page, {
      amount: input.amount,
      transactionDate: input.transactionDate,
      memo: input.memo,
    });

    const merchant = input.merchant?.trim();
    if (!merchant) {
      return;
    }
    const visibleMerchant = await this.readExpenseDeskMerchantDisplayValue(page);
    if (expenseMerchantTextMatchesInput(visibleMerchant, merchant)) {
      debug(`ExpenseDesk draft merchant already set to '${visibleMerchant}', skipping merchant picker.`);
      return;
    }

    try {
      await this.selectExpenseDeskMerchant(page, merchant);
      await page.waitForTimeout(1_200);
      await this.fillExpenseDeskMemoField(page, input.memo);
      await this.assertExpenseDeskDraftFieldValues(page, {
        amount: input.amount,
        transactionDate: input.transactionDate,
        memo: input.memo,
      });
    } catch (error) {
      debug(
        `Continuing ExpenseDesk reimbursement without explicit merchant selection for '${merchant}': ${error instanceof Error ? error.message : String(error)}`,
      );
      await page.keyboard.press("Escape").catch(() => undefined);
      await this.assertExpenseDeskDraftFieldValues(page, {
        amount: input.amount,
        transactionDate: input.transactionDate,
        memo: input.memo,
      });
    }
  }

  async captureEmailReimbursementEvidence(input: {
    emailContent: string;
    label?: string;
    outputPath?: string;
  }): Promise<{
    screenshotPath: string;
    archivedPath: string;
    sha256: string;
    imageWidth?: number;
    imageHeight?: number;
    bodyFormat: "html" | "text";
    subject?: string;
    date?: string;
    from?: string;
  }> {
    const page = this.getPage();
    const parsed = parseGogEmailFullOutput(input.emailContent);
    const html = buildEmailEvidenceHtml(parsed);
    const tempHtmlPath = path.join("/tmp", `expense-email-evidence-${Date.now()}.html`);
    const tempPngPath = input.outputPath
      ? path.resolve(input.outputPath)
      : path.join("/tmp", `expense-email-evidence-${Date.now()}.png`);
    fs.writeFileSync(tempHtmlPath, html, "utf8");

    await page.goto(`file://${tempHtmlPath}`, {
      waitUntil: "load",
      timeout: 30_000,
    });
    await page.setViewportSize({ width: 1280, height: 1600 }).catch(() => undefined);
    await page.waitForTimeout(750);
    await page.screenshot({
      path: tempPngPath,
      type: "png",
      fullPage: true,
    });

    const archived = archiveReimbursementEvidence({
      sourcePath: tempPngPath,
      label: input.label ?? "email-receipt-evidence",
      metadata: {
        kind: "email_receipt_evidence",
        capturedAt: new Date().toISOString(),
      },
    });

    return {
      screenshotPath: tempPngPath,
      archivedPath: archived.archivedPath,
      sha256: archived.sha256,
      imageWidth: archived.imageWidth,
      imageHeight: archived.imageHeight,
      bodyFormat: parsed.bodyFormat,
      subject: parsed.headers["subject"],
      date: parsed.headers["date"],
      from: parsed.headers["from"],
    };
  }

  async captureEmailAsPdf(input: {
    emailContent: string;
    label?: string;
    outputPath?: string;
  }): Promise<{
    pdfPath: string;
    archivedPath: string;
    sha256: string;
    bodyFormat: "html" | "text";
    subject?: string;
    date?: string;
    from?: string;
  }> {
    const page = this.getPage();
    const parsed = parseGogEmailFullOutput(input.emailContent);

    // Use the original email HTML body directly when available;
    // fall back to the styled evidence template for plain-text emails.
    const html =
      parsed.bodyFormat === "html"
        ? `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{background:#fff;margin:0;}</style></head><body>${parsed.body}</body></html>`
        : buildEmailEvidenceHtml(parsed);

    const tempHtmlPath = path.join("/tmp", `expense-email-pdf-${Date.now()}.html`);
    const tempPdfPath = input.outputPath
      ? path.resolve(input.outputPath)
      : path.join("/tmp", `expense-email-pdf-${Date.now()}.pdf`);
    fs.writeFileSync(tempHtmlPath, html, "utf8");

    await page.goto(`file://${tempHtmlPath}`, {
      waitUntil: "load",
      timeout: 30_000,
    });
    await page.waitForTimeout(750);
    await page.pdf({
      path: tempPdfPath,
      format: "Letter",
      printBackground: true,
      margin: { top: "0.5in", bottom: "0.5in", left: "0.5in", right: "0.5in" },
    });

    const archived = archiveReimbursementEvidence({
      sourcePath: tempPdfPath,
      label: input.label ?? "email-receipt-pdf",
      metadata: {
        kind: "email_receipt_pdf",
        capturedAt: new Date().toISOString(),
      },
    });

    return {
      pdfPath: tempPdfPath,
      archivedPath: archived.archivedPath,
      sha256: archived.sha256,
      bodyFormat: parsed.bodyFormat,
      subject: parsed.headers["subject"],
      date: parsed.headers["date"],
      from: parsed.headers["from"],
    };
  }

  private async captureExpenseDeskConfirmationScreenshot(
    page: Page,
    evidencePath: string,
    label: string,
  ): Promise<{
    archivedPath: string;
    sha256: string;
    imageWidth?: number;
    imageHeight?: number;
  }> {
    const tempPath = `/tmp/${label}-${Date.now()}.png`;
    await page.screenshot({
      path: tempPath,
      type: "png",
    });
    const evidenceRecord = loadReimbursementEvidenceRecord(evidencePath);
    const confirmationRecord = archiveReimbursementEvidence({
      sourcePath: tempPath,
      orderId: evidenceRecord?.orderId,
      label,
      metadata: {
        kind: "ramp_confirmation",
        capturedAt: new Date().toISOString(),
      },
    });
    return {
      archivedPath: confirmationRecord.archivedPath,
      sha256: confirmationRecord.sha256,
      imageWidth: confirmationRecord.imageWidth,
      imageHeight: confirmationRecord.imageHeight,
    };
  }

  private async readExpenseDeskReviewVisualState(page: Page): Promise<ReturnType<typeof buildExpenseDeskReviewVisualState>> {
    const images = await page.evaluate(() =>
      [...document.querySelectorAll("img")].map((image) => ({
        src: (image as HTMLImageElement).currentSrc || image.getAttribute("src") || "",
        alt: image.getAttribute("alt") || "",
        width: image.clientWidth,
        height: image.clientHeight,
        naturalWidth: (image as HTMLImageElement).naturalWidth,
        naturalHeight: (image as HTMLImageElement).naturalHeight,
      })),
    ).catch(() => []);
    return buildExpenseDeskReviewVisualState(images);
  }

  private async assertExpenseDeskPageAuthenticated(page: Page, action: string): Promise<void> {
    if (!(await this.expensePageLooksSignedOut(page))) {
      return;
    }

    const authenticated = await this.tryExpenseDeskGoogleLogin(page, action);
    if (authenticated || !(await this.expensePageLooksSignedOut(page))) {
      return;
    }

    throw new Error(
      `ExpenseDesk authentication is required to ${action}. Automatic Google login did not complete; sign in to ExpenseDesk in the managed Brave profile and retry.`,
    );
  }

  private async expensePageLooksSignedOut(page: Page): Promise<boolean> {
    const [title, body] = await Promise.all([
      page.title().catch(() => ""),
      page.locator("body").innerText().catch(() => ""),
    ]);
    return expensePageLooksSignedOut({ url: page.url(), title, text: body });
  }

  private async waitForExpenseDeskPageAuthenticated(page: Page, timeoutMs = EXPENSE_GOOGLE_LOGIN_TIMEOUT_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.expensePageLooksSignedOut(page))) {
        return true;
      }
      await page.waitForTimeout(1_000);
    }
    return false;
  }

  private async openExpenseDeskGoogleLogin(page: Page): Promise<Page | null> {
    const candidates = [
      page.getByRole("button", { name: /(?:continue|sign in|log in|login) with google/iu }).first(),
      page.getByText(/(?:continue|sign in|log in|login) with google/iu).first(),
      page.locator("button, [role='button'], a").filter({ hasText: /google/iu }).first(),
    ];

    for (const candidate of candidates) {
      if ((await candidate.count().catch(() => 0)) === 0) {
        continue;
      }
      if (!(await candidate.isVisible().catch(() => false))) {
        continue;
      }
      const popupPromise = page.waitForEvent("popup", { timeout: 5_000 }).catch(() => null);
      await candidate.click({ timeout: 10_000 });
      return (await popupPromise) ?? page;
    }

    return null;
  }

  private async selectExpenseDeskGoogleAccount(loginPage: Page): Promise<boolean> {
    await loginPage.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
    const expenseGoogleAccountEmail = resolveExpenseDeskGoogleAccountEmail();
    const account = loginPage.getByText(new RegExp(escapeRegex(expenseGoogleAccountEmail), "iu")).first();
    try {
      await account.waitFor({ state: "visible", timeout: 20_000 });
      await account.click({ timeout: 10_000 });
      return true;
    } catch (error) {
      debug(
        `ExpenseDesk Google login account '${expenseGoogleAccountEmail}' was not selectable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private async tryExpenseDeskGoogleLogin(page: Page, action: string): Promise<boolean> {
    const loginPage = await this.openExpenseDeskGoogleLogin(page).catch((error) => {
      debug(`Could not open ExpenseDesk Google login while trying to ${action}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (!loginPage) {
      return false;
    }

    const accountSelected = await this.selectExpenseDeskGoogleAccount(loginPage);
    if (!accountSelected) {
      return false;
    }

    if (loginPage !== page) {
      await loginPage.waitForEvent("close", { timeout: EXPENSE_GOOGLE_LOGIN_TIMEOUT_MS }).catch(() => undefined);
    }
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
    return this.waitForExpenseDeskPageAuthenticated(page);
  }

  private async assertExpenseDeskReimbursementStillDraft(page: Page, action: string): Promise<void> {
    const [title, body] = await Promise.all([
      page.title().catch(() => ""),
      page.locator("body").innerText().catch(() => ""),
    ]);
    if (expenseReimbursementLooksSubmitted(`${title}\n${body}`)) {
      throw new Error(
        `${action} refused because ExpenseDesk shows this reimbursement is already submitted or pending review. Do not repair or update draft tracking; reconcile against ExpenseDesk history instead.`,
      );
    }
    const submitButtonCount = await page
      .getByRole("button", { name: /\bSubmit\b/iu })
      .count()
      .catch(() => 0);
    if (submitButtonCount === 0) {
      const draftUrl = /\/draft(?:[/?#]|$)/u.test(page.url());
      const editableFieldVisible = await page
        .locator('input[name="amount"], input[name="transaction_date"]')
        .first()
        .isVisible()
        .catch(() => false);
      if (!draftUrl && !editableFieldVisible) {
        throw new Error(
          `${action} refused because ExpenseDesk does not show a draft URL, editable fields, or Submit button; the page is not in reviewable draft state. ${await this.describeExpenseDeskDraftPage(page)}`,
        );
      }
    }
  }

  private async ensureExpenseDeskReceiptFileInput(page: Page): Promise<void> {
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: "attached", timeout: 15_000 }).catch(() => undefined);
    if ((await fileInput.count().catch(() => 0)) > 0) {
      return;
    }

    const triggerLocators = [
      page.getByRole("button", { name: /upload/i }).first(),
      page.getByRole("button", { name: /replace/i }).first(),
      page.getByRole("button", { name: /change/i }).first(),
      page.getByRole("button", { name: /edit/i }).first(),
      page.getByRole("button", { name: /add/i }).first(),
      page.locator('[data-testid*="upload" i]').first(),
      page.locator('[data-testid*="receipt" i]').first(),
      page.locator('[aria-label*="upload" i]').first(),
      page.locator('[aria-label*="receipt" i]').first(),
      page.locator('[title*="upload" i]').first(),
      page.locator('[title*="receipt" i]').first(),
    ];

    for (const locator of triggerLocators) {
      if ((await locator.count().catch(() => 0)) === 0) {
        continue;
      }
      await locator.click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(1_500);
      if ((await fileInput.count().catch(() => 0)) > 0) {
        return;
      }
    }

    throw new Error("ExpenseDesk receipt file input was not found after opening available upload controls.");
  }

  async prepareExpenseDeskReimbursementDraft(input: {
    amount: number;
    transactionDate: string;
    memo: string;
    evidencePath: string;
    merchant?: string;
  }): Promise<{
    reviewUrl: string;
    expenseReportId: string;
    amount: number;
    transactionDate: string;
    memo: string;
    evidencePath: string;
    evidenceSha256: string;
    evidenceImageWidth?: number;
    evidenceImageHeight?: number;
    expenseConfirmationPath?: string;
  }> {
    const MAX_ATTEMPTS = 2;
    let lastError: Error | undefined;
    let createdDraftUrl: string | undefined;
    let createdExpenseDeskReportId: string | undefined;
    let createdEvidenceRecord: ReturnType<typeof archiveReimbursementEvidence> | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const page = this.getPage();
        const merchant = (input.merchant ?? "Walmart").trim();
        const existingDraft = await this.findMatchingExpenseDeskDraft({
          amount: input.amount,
          transactionDate: input.transactionDate,
          merchant,
        }).catch((error) => {
          debug(`Could not check existing ExpenseDesk drafts before upload: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        });
        if (existingDraft) {
          throw new Error(
            `Matching ExpenseDesk draft already exists for ${merchant} ${input.amount.toFixed(2)} on ${input.transactionDate}: ${existingDraft.reviewUrl}`,
          );
        }

        const isWalmartEvidence = /\bwalmart\b/iu.test(merchant);
        createdEvidenceRecord = archiveReimbursementEvidence({
          sourcePath: input.evidencePath,
          label: isWalmartEvidence ? "walmart-tip-evidence" : "expense-reimbursement-evidence",
          metadata: {
            kind: isWalmartEvidence ? "walmart_tip_evidence" : "expense_reimbursement_evidence",
          },
        });
        await page.goto("https://expenses.example.com/details/reimbursements/new", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        }).catch(() => undefined);
        await page.waitForTimeout(1_000);
        await this.assertExpenseDeskPageAuthenticated(page, "prepare a ExpenseDesk reimbursement draft");
        await this.ensureExpenseDeskReceiptFileInput(page);
        await page.locator('input[type="file"]').first().setInputFiles([createdEvidenceRecord.archivedPath]);
        await page.waitForURL(/\/details\/reimbursements\/.+\/draft/, {
          timeout: 120_000,
        });
        await page.waitForTimeout(3_000);

        createdDraftUrl = page.url();
        createdExpenseDeskReportId = extractExpenseDeskReimbursementIdFromUrl(createdDraftUrl) ?? undefined;
        if (!createdExpenseDeskReportId) {
          throw new Error(`Could not extract ExpenseDesk reimbursement id from ${createdDraftUrl}`);
        }

        await this.fillExpenseDeskReimbursementDraftFields(page, {
          amount: input.amount,
          transactionDate: input.transactionDate,
          memo: input.memo,
          merchant,
        });
        await this.assertExpenseDeskReimbursementStillDraft(page, "prepare ExpenseDesk reimbursement draft");

        return {
          reviewUrl: createdDraftUrl,
          expenseReportId: createdExpenseDeskReportId,
          amount: input.amount,
          transactionDate: formatExpenseDeskTransactionDate(input.transactionDate),
          memo: input.memo,
          evidencePath: createdEvidenceRecord.archivedPath,
          evidenceSha256: createdEvidenceRecord.sha256,
          evidenceImageWidth: createdEvidenceRecord.imageWidth,
          evidenceImageHeight: createdEvidenceRecord.imageHeight,
          expenseConfirmationPath: "",
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (/^Matching ExpenseDesk draft already exists\b/u.test(lastError.message)) {
          throw lastError;
        }
        if (createdDraftUrl && createdExpenseDeskReportId && createdEvidenceRecord) {
          try {
            const page = this.getPage();
            await page.goto(createdDraftUrl, {
              waitUntil: "domcontentloaded",
              timeout: 30_000,
            }).catch(() => undefined);
            await page.waitForTimeout(2_000);
            await this.assertExpenseDeskPageAuthenticated(page, "repair the ExpenseDesk reimbursement draft");
            await this.assertExpenseDeskReimbursementStillDraft(page, "repair ExpenseDesk reimbursement draft");
            await this.fillExpenseDeskReimbursementDraftFields(page, {
              amount: input.amount,
              transactionDate: input.transactionDate,
              memo: input.memo,
              merchant: (input.merchant ?? "Walmart").trim(),
            });
            await this.assertExpenseDeskReimbursementStillDraft(page, "repair ExpenseDesk reimbursement draft");
            return {
              reviewUrl: createdDraftUrl,
              expenseReportId: createdExpenseDeskReportId,
              amount: input.amount,
              transactionDate: formatExpenseDeskTransactionDate(input.transactionDate),
              memo: input.memo,
              evidencePath: createdEvidenceRecord.archivedPath,
              evidenceSha256: createdEvidenceRecord.sha256,
              evidenceImageWidth: createdEvidenceRecord.imageWidth,
              evidenceImageHeight: createdEvidenceRecord.imageHeight,
              expenseConfirmationPath: "",
            };
          } catch (repairError) {
            const repairMessage = repairError instanceof Error ? repairError.message : String(repairError);
            throw new Error(
              `ExpenseDesk draft was created at ${createdDraftUrl}, but automation could not finish filling it: ${lastError.message}. Repair attempt also failed: ${repairMessage}`,
            );
          }
        }
        if (createdDraftUrl) {
          throw new Error(
            `ExpenseDesk draft was created at ${createdDraftUrl}, but automation could not finish filling it: ${lastError.message}. Not retrying because retrying would create another duplicate draft.`,
          );
        }
        if (attempt < MAX_ATTEMPTS) {
          debug(`ExpenseDesk submission attempt ${attempt} failed, retrying: ${lastError.message}`);
          continue;
        }
        debug(`ExpenseDesk submission attempt ${attempt} failed: ${lastError.message}`);
      }
    }

    throw new Error(
      `ExpenseDesk draft preparation failed after ${MAX_ATTEMPTS} attempts: ${lastError?.message ?? "unknown error"}`,
    );
  }

  async submitExpenseDeskReimbursement(input: {
    amount: number;
    transactionDate: string;
    memo: string;
    evidencePath: string;
    merchant?: string;
  }): Promise<{
    reviewUrl: string;
    expenseReportId: string;
    amount: number;
    transactionDate: string;
    memo: string;
    evidencePath: string;
    evidenceSha256: string;
    evidenceImageWidth?: number;
    evidenceImageHeight?: number;
    expenseConfirmationPath?: string;
  }> {
    return this.prepareExpenseDeskReimbursementDraft(input);
  }

  async repairExpenseDeskReimbursementDraft(input: {
    reviewUrl: string;
    amount: number;
    transactionDate: string;
    memo: string;
    merchant?: string;
    evidencePath?: string;
  }): Promise<{
    reviewUrl: string;
    expenseReportId: string;
    amount: number;
    transactionDate: string;
    memo: string;
    merchant?: string;
    evidencePath?: string;
    evidenceSha256?: string;
    evidenceImageWidth?: number;
    evidenceImageHeight?: number;
    expenseConfirmationPath?: string;
  }> {
    const page = this.getPage();
    const merchant = input.merchant?.trim();
    const evidenceRecord = input.evidencePath
      ? archiveReimbursementEvidence({
          sourcePath: input.evidencePath,
          label: /\bwalmart\b/iu.test(merchant ?? "") ? "walmart-tip-evidence" : "expense-reimbursement-evidence",
          metadata: {
            kind: /\bwalmart\b/iu.test(merchant ?? "") ? "walmart_tip_evidence" : "expense_reimbursement_evidence",
          },
        })
      : undefined;
    await page.goto(input.reviewUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    }).catch(() => undefined);
    await page.waitForTimeout(2_000);
    await this.assertExpenseDeskPageAuthenticated(page, "repair a ExpenseDesk reimbursement draft");
    await this.assertExpenseDeskReimbursementStillDraft(page, "repair ExpenseDesk reimbursement draft");
    if (evidenceRecord) {
      await this.ensureExpenseDeskReceiptFileInput(page);
      await page.locator('input[type="file"]').first().setInputFiles([evidenceRecord.archivedPath]);
      await page.waitForTimeout(2_000);
      await this.assertExpenseDeskReimbursementStillDraft(page, "repair ExpenseDesk reimbursement draft");
    }
    await this.fillExpenseDeskReimbursementDraftFields(page, {
      amount: input.amount,
      transactionDate: input.transactionDate,
      memo: input.memo,
      merchant,
    });
    await this.assertExpenseDeskReimbursementStillDraft(page, "repair ExpenseDesk reimbursement draft");

    const expenseReportId = extractExpenseDeskReimbursementIdFromUrl(page.url()) ?? extractExpenseDeskReimbursementIdFromUrl(input.reviewUrl);
    if (!expenseReportId) {
      throw new Error(`Could not extract ExpenseDesk reimbursement id from ${page.url() || input.reviewUrl}`);
    }
    return {
      reviewUrl: page.url(),
      expenseReportId,
      amount: input.amount,
      transactionDate: formatExpenseDeskTransactionDate(input.transactionDate),
      memo: input.memo,
      merchant,
      evidencePath: evidenceRecord?.archivedPath,
      evidenceSha256: evidenceRecord?.sha256,
      evidenceImageWidth: evidenceRecord?.imageWidth,
      evidenceImageHeight: evidenceRecord?.imageHeight,
      expenseConfirmationPath: "",
    };
  }

  async submitReviewedExpenseDeskReimbursement(input: {
    reviewUrl: string;
    amount: number;
    transactionDate: string;
    memo: string;
    merchant?: string;
    evidencePath?: string;
  }): Promise<{
    reviewUrl: string;
    expenseReportId?: string;
    amount: number;
    transactionDate: string;
    memo: string;
    merchant?: string;
    expenseConfirmationPath?: string;
  }> {
    const page = this.getPage();
    const expectedDate = formatExpenseDeskTransactionDate(input.transactionDate);
    await page.goto(input.reviewUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    }).catch(() => undefined);
    await page.waitForTimeout(2_000);
    await this.assertExpenseDeskPageAuthenticated(page, "submit a reviewed ExpenseDesk reimbursement draft");

    const bodyBefore = await page.locator("body").innerText().catch(() => "");
    if (expenseReimbursementLooksSubmitted(bodyBefore)) {
      return {
        reviewUrl: page.url(),
        expenseReportId: extractExpenseDeskReimbursementIdFromUrl(page.url()) ?? undefined,
        amount: input.amount,
        transactionDate: expectedDate,
        memo: input.memo,
        merchant: input.merchant,
      };
    }

    const amountInput = page.locator('input[name="amount"]').first();
    const dateInput = page.locator('input[name="transaction_date"]').first();

    await amountInput.waitFor({ state: "visible", timeout: 30_000 });
    await dateInput.waitFor({ state: "visible", timeout: 30_000 });
    const memoInput = await this.findExpenseDeskMemoField(page);

    const amountValue = await amountInput.inputValue();
    const dateValue = await dateInput.inputValue();
    const memoValue = await this.readExpenseDeskTextField(memoInput);
    const normalizedAmount = Number(amountValue.replace(/[$,\s]/gu, ""));
    if (!Number.isFinite(normalizedAmount) || Math.abs(normalizedAmount - input.amount) >= 0.01) {
      throw new Error(
        `ExpenseDesk draft amount mismatch: expected ${input.amount.toFixed(2)}, saw '${amountValue}'.`,
      );
    }
    if (!expenseDateTextMatchesInput(dateValue, input.transactionDate)) {
      throw new Error(`ExpenseDesk draft date mismatch: expected ${expectedDate}, saw '${dateValue}'.`);
    }
    if (memoValue.trim() !== input.memo.trim()) {
      throw new Error(`ExpenseDesk draft memo mismatch: expected '${input.memo}', saw '${memoValue}'.`);
    }

    if (input.merchant && input.merchant.trim().length > 0) {
      const visibleMerchant = await this.readExpenseDeskMerchantDisplayValue(page);
      const normalizedBody = bodyBefore.replace(/\s+/gu, " ");
      if (
        !expenseMerchantTextMatchesInput(visibleMerchant, input.merchant)
        && !expenseMerchantTextMatchesInput(normalizedBody, input.merchant)
      ) {
        throw new Error(`ExpenseDesk draft merchant check failed: expected page to include '${input.merchant}'.`);
      }
    }

    const submitButton = page
      .getByRole("button", { name: /\bSubmit\b/iu })
      .last();
    if ((await submitButton.count().catch(() => 0)) === 0) {
      throw new Error("ExpenseDesk draft submit button was not found.");
    }
    await submitButton.click({ timeout: 30_000 });
    await page.waitForTimeout(2_000);
    await page.waitForURL(/\/details\/(?:list\/reimbursement|reimbursements)\/.+\/review/, {
      timeout: 60_000,
    }).catch(() => undefined);

    const bodyAfter = await page.locator("body").innerText().catch(() => "");
    if (!expenseReimbursementLooksSubmitted(bodyAfter) && !/\/review(?:[/?#]|$)/iu.test(page.url())) {
      throw new Error("ExpenseDesk did not show submitted/review state after clicking Submit.");
    }

    let expenseConfirmationPath: string | undefined;
    if (input.evidencePath && input.evidencePath.trim().length > 0) {
      const confirmation = await this.captureExpenseDeskConfirmationScreenshot(
        page,
        input.evidencePath,
        `expensedesk-submit-confirmation-${extractExpenseDeskReimbursementIdFromUrl(page.url()) ?? "reviewed"}`,
      );
      expenseConfirmationPath = confirmation.archivedPath;
    }

    return {
      reviewUrl: page.url(),
      expenseReportId: extractExpenseDeskReimbursementIdFromUrl(page.url()) ?? undefined,
      amount: input.amount,
      transactionDate: expectedDate,
      memo: input.memo,
      merchant: input.merchant,
      expenseConfirmationPath,
    };
  }

  async replaceExpenseDeskReimbursementReceipt(input: {
    reviewUrl: string;
    evidencePath: string;
  }): Promise<{
    reviewUrl: string;
    evidencePath: string;
    evidenceSha256: string;
    evidenceImageWidth?: number;
    evidenceImageHeight?: number;
    expenseConfirmationPath: string;
  }> {
    const page = this.getPage();
    const evidenceRecord = archiveReimbursementEvidence({
      sourcePath: input.evidencePath,
      label: "walmart-tip-evidence",
      metadata: {
        kind: "walmart_tip_evidence",
      },
    });
    await page.goto(input.reviewUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    }).catch(() => undefined);
    await page.waitForTimeout(2_000);
    await this.assertExpenseDeskPageAuthenticated(page, "replace the ExpenseDesk reimbursement receipt");
    await this.ensureExpenseDeskReceiptFileInput(page);
    const beforeBody = await page.locator("body").innerText().catch(() => "");
    const beforeAutoVerified = expenseReviewBodyLooksAutoVerified(beforeBody);
    const beforeReceiptSubmissionCount = countExpenseDeskReceiptSubmissionEvents(beforeBody);
    const beforeVisualState = await this.readExpenseDeskReviewVisualState(page);
    await page.locator('input[type="file"]').first().setInputFiles([evidenceRecord.archivedPath]);
    await page.waitForFunction(
      ({ beforeAutoVerified, beforeReceiptSubmissionCount }) => {
        const text = document.body.innerText || "";
        const normalized = text.replace(/\s+/g, " ").trim();
        const afterAutoVerified = /\bauto-verified\b/i.test(normalized);
        const afterReceiptSubmissionCount =
          (normalized.match(/submitted a receipt via web/gi) || []).length;
        return afterReceiptSubmissionCount > beforeReceiptSubmissionCount
          || (!beforeAutoVerified && afterAutoVerified);
      },
      { beforeAutoVerified, beforeReceiptSubmissionCount },
      { timeout: 60_000 },
    ).catch(() => undefined);
    await page.waitForTimeout(2_000);
    const afterBody = await page.locator("body").innerText().catch(() => "");
    const afterAutoVerified = expenseReviewBodyLooksAutoVerified(afterBody);
    const afterReceiptSubmissionCount = countExpenseDeskReceiptSubmissionEvents(afterBody);
    const afterVisualState = await this.readExpenseDeskReviewVisualState(page);
    const receiptActivityChanged =
      afterReceiptSubmissionCount > beforeReceiptSubmissionCount
      || (afterAutoVerified && !beforeAutoVerified);
    const receiptPreviewChanged = expenseReviewVisualStateChanged(beforeVisualState, afterVisualState);
    const expectsImagePreview = evidencePathLooksImage(evidenceRecord.archivedPath);
    if (
      !receiptActivityChanged
      && !receiptPreviewChanged
    ) {
      throw new Error(
        "ExpenseDesk receipt replacement did not show a new receipt-upload activity entry, newly auto-verified state, or changed receipt preview.",
      );
    }
    if (expectsImagePreview && !expenseReviewVisualStateLooksReceiptLike(afterVisualState)) {
      throw new Error(
        `ExpenseDesk receipt replacement preview is too small to trust (largest receipt image ${afterVisualState.largestReceiptImageWidth}x${afterVisualState.largestReceiptImageHeight}).`,
      );
    }
    const expenseReportId = extractExpenseDeskReimbursementIdFromUrl(page.url()) ?? extractExpenseDeskReimbursementIdFromUrl(input.reviewUrl);
    const confirmationScreenshot = await this.captureExpenseDeskConfirmationScreenshot(
      page,
      evidenceRecord.archivedPath,
      `expensedesk-review-confirmation-${expenseReportId ?? "replacement"}`,
    );
    const updatedEvidenceRecord = archiveReimbursementEvidence({
      sourcePath: evidenceRecord.archivedPath,
      orderId: evidenceRecord.orderId,
      label: "walmart-tip-evidence",
      metadata: {
        uploadedAt: new Date().toISOString(),
        expenseReportId: expenseReportId ?? undefined,
        reviewUrl: page.url(),
        expenseConfirmationPath: confirmationScreenshot.archivedPath,
        expenseConfirmationSha256: confirmationScreenshot.sha256,
        expenseConfirmationImageWidth: confirmationScreenshot.imageWidth,
        expenseConfirmationImageHeight: confirmationScreenshot.imageHeight,
      },
    });
    return {
      reviewUrl: page.url(),
      evidencePath: updatedEvidenceRecord.archivedPath,
      evidenceSha256: updatedEvidenceRecord.sha256,
      evidenceImageWidth: updatedEvidenceRecord.imageWidth,
      evidenceImageHeight: updatedEvidenceRecord.imageHeight,
      expenseConfirmationPath: confirmationScreenshot.archivedPath,
    };
  }

  /** Disconnect from the browser (does NOT close Chrome). */
  async close(): Promise<string> {
    if (this.browser) {
      try {
        this.browser.removeAllListeners();
        // For CDP connections, close() disconnects without killing the browser
        await this.browser.close();
      } catch {
        /* ignore */
      }
      this.browser = null;
      this.page = null;
      this.originPages.clear();
    }
    return "Browser disconnected";
  }

  /** Get connection status and current page info. */
  async status(): Promise<{
    connected: boolean;
    url?: string;
    title?: string;
  }> {
    if (!this.page) return { connected: false };
    try {
      return {
        connected: true,
        url: this.page.url(),
        title: await this.page.title(),
      };
    } catch {
      this.page = null;
      return { connected: false };
    }
  }

  private getPage(): Page {
    if (!this.page) {
      throw new Error(
        "No browser connected. Use action 'launch' first, or 'connect' with a " +
          "CDP URL (e.g. http://127.0.0.1:9223).",
      );
    }
    return this.page;
  }
}
