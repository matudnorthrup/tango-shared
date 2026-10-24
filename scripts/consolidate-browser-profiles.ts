/**
 * Consolidate the automation browser's cookie jars into one.
 *
 * Tango accumulated several Brave profile directories because the profile path
 * used to depend on TANGO_DATA_DIR/cwd, while every run connects to the same
 * browser on CDP 9223. Whichever browser claimed the port first won, so logins
 * saved by one run were missing in another. This moves the live profile to the
 * canonical location, merges cookies that exist only in an older jar, and
 * removes the leftovers.
 *
 *   npx tsx scripts/consolidate-browser-profiles.ts            # plan only
 *   npx tsx scripts/consolidate-browser-profiles.ts --apply    # do it
 *
 * --apply quits Brave (gracefully, so its cookie store is flushed), moves the
 * profile, relaunches, and reopens the tabs that were open. Browser-session
 * cookies do not survive any browser restart; run scripts/browser-session.ts
 * ensure afterwards to restore and harden each configured site's session.
 */

import "dotenv/config";
import { execFileSync, execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveBrowserProfileDir, buildBrowserLaunchArgs } from "../packages/discord/src/browser-manager.ts";
import { resolveTangoHome } from "../packages/core/src/runtime-paths.ts";

const CDP_PORT = 9223;
const APPLY = process.argv.includes("--apply");
const BRAVE = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";

/**
 * Every place a browser profile could have been created by an older path rule:
 * the repo's own data dir, each Tango profile's data dir, and the pre-profile
 * location. Derived rather than hardcoded so this works on any checkout.
 */
function candidateProfileDirs(): string[] {
  const tangoHome = resolveTangoHome();
  const candidates = [
    path.join(process.cwd(), "data", "browser-profile"),
    path.join(tangoHome, "browser", "user-data"),
    resolveBrowserProfileDir(),
  ];

  const profilesRoot = path.join(tangoHome, "profiles");
  if (fs.existsSync(profilesRoot)) {
    for (const entry of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidates.push(path.join(profilesRoot, entry.name, "data", "browser-profile"));
      }
    }
  }

  return [...new Set(candidates.map((dir) => path.resolve(dir)))];
}

type ProfileFacts = {
  dir: string;
  exists: boolean;
  sizeMb: number;
  cookieRows: number;
  cookieHosts: number;
  newestCookie: string | null;
};

function du(dir: string): number {
  try {
    const out = execSync(`du -sk ${JSON.stringify(dir)}`, { encoding: "utf8" });
    return Math.round(Number(out.split(/\s+/u)[0] ?? 0) / 1024);
  } catch {
    return 0;
  }
}

function sqlite(dbPath: string, query: string): string | null {
  try {
    return execFileSync("sqlite3", [dbPath, query], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function inspect(dir: string): ProfileFacts {
  const cookies = path.join(dir, "Default", "Cookies");
  const exists = fs.existsSync(dir);
  if (!exists || !fs.existsSync(cookies)) {
    return { dir, exists, sizeMb: exists ? du(dir) : 0, cookieRows: 0, cookieHosts: 0, newestCookie: null };
  }
  const counts = sqlite(cookies, "select count(*) || '|' || count(distinct host_key) from cookies;") ?? "0|0";
  const [rows, hosts] = counts.split("|").map((value) => Number(value) || 0);
  return {
    dir,
    exists,
    sizeMb: du(dir),
    cookieRows: rows ?? 0,
    cookieHosts: hosts ?? 0,
    newestCookie: sqlite(
      cookies,
      "select datetime(max(creation_utc)/1000000-11644473600,'unixepoch','localtime') from cookies;",
    ) || null,
  };
}

/**
 * The browser serving CDP on CDP_PORT, found by its command line (`--remote-debugging-port=`), never by
 * lsof: a machine-wide lsof hangs on a stalled network mount (SMB, Time Machine).
 */
function cdpListenerPids(): string[] {
  try {
    const out = execSync("ps -axo pid=,command=", { encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").flatMap((line) => {
      const m = /^\s*(\d+)\s+(.*)$/u.exec(line);
      return m && m[2]!.includes(`--remote-debugging-port=${CDP_PORT}`) && !m[2]!.includes("--type=") ? [m[1]!] : [];
    });
  } catch {
    return [];
  }
}

function runningProfileDir(): string | null {
  try {
    const pids = cdpListenerPids();
    for (const pid of pids) {
      const cmd = execSync(`ps -p ${pid} -o command=`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const match = cmd.match(/--user-data-dir=(.+?)(?=\s+--|\s*$)/u);
      if (match?.[1]) return match[1].trim();
    }
  } catch {
    /* not running */
  }
  return null;
}

async function openTabUrls(): Promise<string[]> {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const targets = (await res.json()) as Array<{ type: string; url: string }>;
    return targets
      .filter((t) => t.type === "page" && /^https?:/u.test(t.url))
      .map((t) => t.url);
  } catch {
    return [];
  }
}

async function portOpen(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return predicate();
}

async function quitBrave(): Promise<void> {
  // Graceful quit, not a kill: Brave flushes its cookie store on the way out.
  try {
    execFileSync("osascript", ["-e", 'tell application "Brave Browser" to quit'], { stdio: "ignore" });
  } catch {
    /* fall through to signals */
  }
  if (await waitFor(async () => !(await portOpen()), 20_000)) return;

  try {
    const pids = cdpListenerPids();
    for (const pid of pids) process.kill(Number(pid), "SIGTERM");
  } catch {
    /* ignore */
  }
  await waitFor(async () => !(await portOpen()), 20_000);
}

/**
 * Carry cookies that live only in an older jar into the live one.
 *
 * Cookies are encrypted with a key only a browser can use, so the old profile
 * is briefly opened on its own port to read them. Hosts already present in the
 * live jar are skipped — that jar is newer, and overwriting fresh auth with a
 * stale copy is exactly the failure this whole cleanup is meant to end.
 */
async function mergeCookiesFrom(staleDir: string, mergePort: number): Promise<number> {
  const cookiesDb = path.join(staleDir, "Default", "Cookies");
  if (!fs.existsSync(cookiesDb)) return 0;
  const { chromium } = await import("playwright-core");

  const child = spawn(
    BRAVE,
    [...buildBrowserLaunchArgs(mergePort, staleDir).filter((arg) => arg !== "about:blank"), "--headless=new"],
    { detached: true, stdio: "ignore" },
  );
  child.unref();

  const up = await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${mergePort}/json/version`);
      return res.ok;
    } catch {
      return false;
    }
  }, 30_000);
  if (!up) {
    console.warn(`  could not open ${staleDir} to read its cookies; skipping merge`);
    return 0;
  }

  let merged = 0;
  try {
    const stale = await chromium.connectOverCDP(`http://127.0.0.1:${mergePort}`);
    const staleCookies = await stale.contexts()[0]!.cookies();
    await stale.close();

    const live = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const liveCtx = live.contexts()[0]!;
    const liveHosts = new Set((await liveCtx.cookies()).map((cookie) => cookie.domain.replace(/^\./u, "")));
    const nowSeconds = Math.floor(Date.now() / 1000);
    const carry = staleCookies.filter(
      (cookie) =>
        !liveHosts.has(cookie.domain.replace(/^\./u, "")) &&
        cookie.expires > nowSeconds,
    );
    if (carry.length > 0) {
      await liveCtx.addCookies(carry);
      merged = carry.length;
    }
    await live.close();
  } catch (err) {
    console.warn(`  cookie merge from ${staleDir} failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try {
      child.pid && process.kill(child.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  return merged;
}

async function main(): Promise<number> {
  const canonical = resolveBrowserProfileDir();
  const running = runningProfileDir();
  const facts = candidateProfileDirs().map(inspect).filter((profile) => profile.exists);

  console.log(`canonical profile : ${canonical}`);
  console.log(`browser running on: ${running ?? "(not running)"}\n`);
  for (const profile of facts) {
    const marks = [
      profile.dir === running ? "RUNNING" : null,
      path.resolve(profile.dir) === path.resolve(canonical) ? "CANONICAL" : null,
    ].filter(Boolean);
    console.log(
      `  ${profile.dir}\n    ${profile.sizeMb} MB · ${profile.cookieRows} cookies across ${profile.cookieHosts} hosts · newest ${profile.newestCookie ?? "none"}${marks.length ? ` · ${marks.join(" ")}` : ""}`,
    );
  }

  const source = running ?? facts.slice().sort((a, b) => b.cookieRows - a.cookieRows)[0]?.dir ?? null;
  if (!source) {
    console.error("\nNo profile with cookies found; nothing to consolidate.");
    return 1;
  }
  const stale = facts.map((p) => p.dir).filter((dir) => path.resolve(dir) !== path.resolve(source));
  const moveNeeded = path.resolve(source) !== path.resolve(canonical);

  console.log("\nPlan:");
  console.log(`  keep    ${source}${moveNeeded ? `\n  move to ${canonical}` : "  (already canonical)"}`);
  for (const dir of stale) console.log(`  remove  ${dir}`);
  console.log(
    `  reclaim ${facts.filter((p) => stale.includes(p.dir)).reduce((sum, p) => sum + p.sizeMb, 0)} MB`,
  );

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to perform it (this quits and relaunches Brave).");
    return 0;
  }

  if (fs.existsSync(canonical) && moveNeeded) {
    console.error(`\nRefusing to move: ${canonical} already exists. Remove or rename it first.`);
    return 1;
  }

  // Merge first, while the live browser is still up to receive the cookies.
  let mergePort = CDP_PORT + 10;
  for (const dir of stale) {
    const merged = await mergeCookiesFrom(dir, mergePort);
    mergePort += 1;
    if (merged > 0) console.log(`\nCarried ${merged} cookie(s) forward from ${dir}`);
  }

  const tabs = await openTabUrls();
  console.log(`\nCapturing ${tabs.length} open tab(s), then quitting Brave...`);
  fs.writeFileSync(
    path.join(os.tmpdir(), "tango-browser-tabs.json"),
    JSON.stringify(tabs, null, 2),
  );
  await quitBrave();
  if (await portOpen()) {
    console.error("Brave is still listening on the CDP port; aborting before touching any profile.");
    return 1;
  }

  if (moveNeeded) {
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    console.log(`Moving ${source}\n    -> ${canonical}`);
    try {
      fs.renameSync(source, canonical);
    } catch (err) {
      // Different volumes: copy across, and only unlink the source once the
      // copy is complete, so a failure never leaves us with no profile at all.
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      console.log("  (different filesystem — copying instead)");
      fs.cpSync(source, canonical, { recursive: true, preserveTimestamps: true });
      fs.rmSync(source, { recursive: true, force: true });
    }
  }
  for (const dir of stale) {
    console.log(`Removing ${dir}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("Relaunching Brave on the canonical profile...");
  const child = spawn(BRAVE, buildBrowserLaunchArgs(CDP_PORT, canonical), { detached: true, stdio: "ignore" });
  child.unref();
  if (!(await waitFor(portOpen, 30_000))) {
    console.error("Brave did not come back up on the CDP port. Relaunch it manually.");
    return 1;
  }

  // Brave usually restores the previous session by itself. Only reopen what it
  // did not bring back, otherwise every tab comes up twice.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const restored = new Set(await openTabUrls());
  const missing = tabs.filter((url) => !restored.has(url));
  for (const url of missing) {
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" }).catch(
      () => undefined,
    );
  }
  console.log(
    `Tabs: ${restored.size} restored by Brave, ${missing.length} reopened (${tabs.length} were open before).`,
  );
  console.log("\nDone. Now run: npx tsx scripts/browser-session.ts ensure");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
