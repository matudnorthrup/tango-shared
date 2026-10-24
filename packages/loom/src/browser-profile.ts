import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface BrowserProfileIdentity { nonce: string; dev: number; ino: number }
const validNonce = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);

/** No caller-supplied paths: only a newly created, private directory can become owned. */
export function createBrowserProfile(home: string, nonce: string): BrowserProfileIdentity {
  if (!validNonce(nonce)) throw new Error("Invalid browser profile identity; start a new managed browser");
  const root = join(home, "browser-profiles");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== join(realpathSync(home), "browser-profiles")) throw new Error("Browser profile root is redirected; restore the managed profile directory");
  const path = join(root, nonce);
  mkdirSync(path, { mode: 0o700 });
  const { dev, ino } = lstatSync(path);
  try {
    writeFileSync(join(path, ".loom-owner"), nonce, { flag: "wx", mode: 0o600 });
  } catch (error) {
    // Before publication this directory is ours, even if the marker write failed.
    const current = lstatSync(path);
    if (current.isDirectory() && !current.isSymbolicLink() && current.dev === dev && current.ino === ino) rmSync(path, { recursive: true });
    throw error;
  }
  return { nonce, dev, ino };
}

export function browserProfilePath(home: string, identity: BrowserProfileIdentity): string {
  if (!validNonce(identity?.nonce)) throw new Error("Invalid browser profile identity; inspect the lease before retrying");
  return join(home, "browser-profiles", identity.nonce);
}

export function inspectBrowserProfile(home: string, identity: BrowserProfileIdentity): "same" | "gone" | "different" | "unknown" {
  if (!validNonce(identity?.nonce) || !Number.isSafeInteger(identity.dev) || !Number.isSafeInteger(identity.ino)) return "unknown";
  try {
    const root = join(home, "browser-profiles");
    if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== join(realpathSync(home), "browser-profiles")) return "different";
    const path = browserProfilePath(home, identity);
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino) return "different";
    const marker = join(path, ".loom-owner");
    if (!lstatSync(marker).isFile() || lstatSync(marker).isSymbolicLink()) return "different";
    return readFileSync(marker, "utf8") === identity.nonce ? "same" : "different";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unknown";
    // A missing marker is not proof that the profile itself is absent.
    try { lstatSync(browserProfilePath(home, identity)); return "different"; }
    catch (missing) { return (missing as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : "unknown"; }
  }
}

/** Called only after the entire managed process group is confirmed absent. */
export function removeBrowserProfile(home: string, identity: BrowserProfileIdentity): void {
  const state = inspectBrowserProfile(home, identity);
  if (state === "gone") return;
  if (state !== "same") throw new Error("Browser profile ownership changed; preserve it and inspect the lease");
  rmSync(browserProfilePath(home, identity), { recursive: true });
}
