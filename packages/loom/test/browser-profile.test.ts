import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { browserProfilePath, createBrowserProfile, inspectBrowserProfile, removeBrowserProfile } from "../src/browser-profile.js";
import { createManagedProcess, inspectProcess, processBackend } from "../src/managed-process.js";
import { LoomStore } from "../src/store.js";
import { ResourceLeases } from "../src/leases.js";
import { killGroup } from "../src/proc.js";
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function home() { const root = mkdtempSync(join(tmpdir(), "browser-profile-")); cleanups.push(() => rmSync(root, { recursive: true, force: true })); return root; }
it("only removes a fresh profile with matching directory and marker identities", () => {
  const root = home(); const id = createBrowserProfile(root, randomUUID());
  expect(inspectBrowserProfile(root, id)).toBe("same");
  writeFileSync(join(browserProfilePath(root, id), "cookies"), "test");
  removeBrowserProfile(root, id); removeBrowserProfile(root, id);
  expect(inspectBrowserProfile(root, id)).toBe("gone");
});
it.each(["marker", "symlink", "directory"])("preserves a replaced %s", change => {
  const root = home(); const id = createBrowserProfile(root, randomUUID()); const path = browserProfilePath(root, id);
  if (change === "marker") rmSync(join(path, ".loom-owner"));
  else {
    renameSync(path, path + "-original");
    if (change === "symlink") symlinkSync(path + "-original", path);
    else createBrowserProfile(root, id.nonce);
  }
  expect(inspectBrowserProfile(root, id)).toBe("different");
  expect(() => removeBrowserProfile(root, id)).toThrow(/ownership changed/);
  expect(existsSync(path)).toBe(true);
});
it("cleans a real browser process and its exclusive profile at run end after store reopen", async () => {
  const root = home(); let store = new LoomStore(join(root, "state.db")); cleanups.push(() => store.close());
  const thread = store.tx(() => store.createThread({ cwd: root, provider: "fake", kind: "test" }));
  const run = store.tx(() => { const r = store.createRun(thread.id, "user", "test"); store.updateRun(r.id, { status: "running" }); return r; });
  let leases = new ResourceLeases(store, { warm: () => true, backends: { browser: processBackend(root) } });
  const result = await createManagedProcess(leases, root, { threadId: thread.id, runId: run.id, cwd: root, kind: "browser", profile: "exclusive", command: process.execPath, args: ["-e", "require('node:fs').writeFileSync(process.env.LOOM_BROWSER_PROFILE+'/ready',process.env.LOOM_RUN_ID);setInterval(()=>{},1000)"] });
  const identity = JSON.parse(result.lease.identity); cleanups.push(() => killGroup(identity.pid));
  const profile = browserProfilePath(root, identity.profile);
  await vi.waitFor(() => expect(existsSync(join(profile, "ready"))).toBe(true));
  store.close(); store = new LoomStore(join(root, "state.db"));
  leases = new ResourceLeases(store, { warm: () => true, backends: { browser: processBackend(root) } });
  store.tx(() => store.updateRun(run.id, { status: "completed" }));
  await leases.reconcile(); expect(inspectProcess(identity)).toBe("gone"); expect(existsSync(profile)).toBe(false);
}, 10_000);

it("preserves a profile with the wrong marker nonce", () => {
  const root = home(); const id = createBrowserProfile(root, randomUUID());
  writeFileSync(join(browserProfilePath(root, id), ".loom-owner"), randomUUID());
  expect(() => removeBrowserProfile(root, id)).toThrow(/ownership changed/);
  expect(existsSync(browserProfilePath(root, id))).toBe(true);
});
it("rejects a symlink profile root", () => {
  const root = home(); const destination = home();
  symlinkSync(destination, join(root, "browser-profiles"));
  expect(() => createBrowserProfile(root, randomUUID())).toThrow(/redirected/);
});
it("removes a newly created profile when lease registration fails", async () => {
  const root = home(); const store = new LoomStore(join(root, "state.db")); cleanups.push(() => store.close());
  const leases = new ResourceLeases(store, { warm: () => false });
  await expect(createManagedProcess(leases, root, { threadId: "missing", runId: "stale", cwd: root, kind: "browser", profile: "exclusive", command: process.execPath, args: [] })).rejects.toThrow();
  const { readdirSync } = await import("node:fs");
  expect(readdirSync(join(root, "browser-profiles"))).toEqual([]);
  expect(readdirSync(join(root, "resources"))).toEqual([]);
});
