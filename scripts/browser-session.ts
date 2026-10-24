/**
 * Browser session CLI — check, repair, and explain an authenticated site's login.
 *
 *   npx tsx scripts/browser-session.ts status [site]    # report only, never signs in
 *   npx tsx scripts/browser-session.ts ensure [site]    # sign in if needed (all scopes)
 *   npx tsx scripts/browser-session.ts persist [site]   # harden cookies against a restart
 *
 * Sites come from profile-layer descriptors (<profile>/config/browser-sites/*.yaml);
 * with no argument every configured site is used. Needs the repo .env (each
 * site's 1Password item reference plus the 1Password service account) and the
 * managed browser on CDP 9223, which it launches if not already running.
 * See docs/guides/browser-sessions.md.
 */

import "dotenv/config";
import {
  ensureSiteSession,
  loadSiteDescriptors,
  persistSiteSessionCookies,
  siteSessionDiagnostics,
} from "../packages/discord/src/site-session.ts";

const command = (process.argv[2] ?? "status").toLowerCase();
const siteArg = process.argv[3];

function targetSites(): Array<{ id: string; scopes: string[] }> {
  const sites = loadSiteDescriptors()
    .filter((site) => !siteArg || site.id === siteArg)
    .map((site) => ({ id: site.id, scopes: site.scopes.map((scope) => scope.id) }));
  if (sites.length === 0) {
    console.error(
      siteArg
        ? `No browser-site descriptor '${siteArg}' is configured.`
        : "No browser-site descriptors are configured. Add <profile>/config/browser-sites/<id>.yaml.",
    );
  }
  return sites;
}

function reportDiagnostics(diagnostics: Record<string, unknown>): void {
  const profile = diagnostics.browserProfile as { expected: string; actual: string | null; matches: boolean | null };
  console.log("browser profile expected :", profile.expected);
  console.log("browser profile running  :", profile.actual ?? "(could not determine)");
  if (diagnostics.profileWarning) {
    console.log("WARNING:", diagnostics.profileWarning);
  }
  const credentials = diagnostics.credentials as { configured: boolean; opAvailable: boolean; missingConfig: string[] };
  console.log(
    "1Password              :",
    credentials.configured ? "configured" : `NOT configured (${credentials.missingConfig.join(", ")})`,
    credentials.opAvailable ? "| service account available" : "| service account TOKEN MISSING",
  );
  console.log("survives browser restart :", diagnostics.sessionSurvivesRestart ? "yes" : "NO");
  for (const entry of (diagnostics.sessionCookies as Array<Record<string, unknown>>) ?? []) {
    console.log(
      `  ${entry.survivesRestart ? "✓" : "✗"} ${entry.cookie} ${entry.expiresAt ? `(until ${entry.expiresAt})` : "(session only)"}`,
    );
  }
}

async function runEnsure(): Promise<number> {
  let failures = 0;
  for (const site of targetSites()) {
    for (const scope of site.scopes) {
      const result = await ensureSiteSession({ site: site.id, scope });
      console.log(`\n[${site.id}/${scope}] ${result.authenticated ? "OK" : "FAILED"} via ${result.path}`);
      console.log(`  ${result.message}`);
      if (!result.authenticated) {
        failures += 1;
        console.log("  steps:", JSON.stringify(result.steps, null, 2));
      }
    }
    // Harden last, once every scope has finished navigating and any cookie the
    // site rotated on the way has settled.
    await persistSiteSessionCookies(site.id);
  }
  return failures;
}

async function main(): Promise<number> {
  if (command === "status") {
    // Probe first: a page-mode probe re-mints that scope's session cookies, so
    // reporting cookie state before probing shows a stale picture.
    for (const site of targetSites()) {
      for (const scope of site.scopes) {
        const result = await ensureSiteSession({ site: site.id, scope, allowLogin: false });
        console.log(`[${site.id}/${scope}] authenticated: ${result.authenticated} — ${result.probe.detail}`);
      }
      console.log("");
      reportDiagnostics(await siteSessionDiagnostics(site.id));
    }
    return 0;
  }
  if (command === "ensure") {
    const failures = await runEnsure();
    for (const site of targetSites()) {
      console.log("");
      reportDiagnostics(await siteSessionDiagnostics(site.id));
    }
    return failures === 0 ? 0 : 1;
  }
  if (command === "persist") {
    let failed = false;
    for (const site of targetSites()) {
      const result = await persistSiteSessionCookies(site.id);
      console.log(site.id, JSON.stringify(result, null, 2));
      failed ||= Boolean(result.error);
    }
    return failed ? 1 : 0;
  }
  console.error(`Unknown command "${command}". Use status, ensure, or persist.`);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
