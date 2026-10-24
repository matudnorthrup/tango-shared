import { vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests never see the machine's live Loom: a session host or the coordinator's launchd job passes
// these down, and the default releases root (~/.tango/releases/loom) exists wherever Loom is deployed.
for (const name of ["LOOM_RELEASE", "LOOM_HOME", "LOOM_HOST_CONFIG", "LOOM_PORT", "LOOM_ACCOUNTS", "LOOM_MAX_HOST_AGE_MS"]) delete process.env[name];
process.env.LOOM_RELEASES_DIR = join(mkdtempSync(join(tmpdir(), "loom-test-")), "no-releases");
// ...nor the owner's profile: a coordinator a test starts (main.ts) would otherwise import and rewrite the live
// standing-rules file (rules.ts rulesFilePath). Child processes inherit these.
const profile = mkdtempSync(join(tmpdir(), "loom-test-profile-"));
process.env.TANGO_PROFILE_DIR = profile;
process.env.LOOM_RULES_FILE = join(profile, "decisions", "rules.md");
// ...nor the owner's Atlas memory (memory.ts reads it into a thread's carried state).
process.env.ATLAS_MEMORY_DB = join(profile, "no-atlas.db");

// Capacity tests inject their own readings; other fake-runtime tests must not depend on
// the developer machine's pressure or subprocess latency.
vi.mock("../src/warmth.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/warmth.js")>(),
  readPressure: async () => ({ memory: { totalBytes: 64 * 1024 ** 3, freePct: 80 }, disk: { totalBytes: 1024 ** 4, freeBytes: 100 * 1024 ** 3 } }),
}));
