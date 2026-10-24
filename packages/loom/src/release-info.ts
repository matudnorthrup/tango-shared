import { readFileSync } from "node:fs";

/**
 * A release's own release.json wins (walk at most three parents of this module, independent of cwd).
 * Outside a release, an explicit LOOM_RELEASE is kept, else "dev".
 */
export function releaseId(): string {
  for (let level = 1; level <= 3; level++) {
    try {
      const info = JSON.parse(readFileSync(new URL("../".repeat(level) + "release.json", import.meta.url), "utf8"));
      if (typeof info.id !== "string" || !info.id) throw new Error("Invalid release.json id");
      return info.id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return process.env.LOOM_RELEASE || "dev";
}
