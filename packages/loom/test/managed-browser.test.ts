import { afterEach, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LoomStore } from "../src/store.js";
import { ResourceLeases } from "../src/leases.js";
import { createManagedBrowser, browserReady } from "../src/managed-browser.js";
import { createManagedProcess, inspectProcess, processBackend, type ProcessIdentity } from "../src/managed-process.js";
import { browserProfilePath } from "../src/browser-profile.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function setup() {
  const home = mkdtempSync(join(tmpdir(), "managed-browser-"));
  let store = new LoomStore(join(home, "state.db"));
  const thread = store.tx(() => store.createThread({ cwd: home, provider: "fake", kind: "test" }));
  const run = store.tx(() => { const row = store.createRun(thread.id, "user", "test"); store.updateRun(row.id, { status: "running" }); return row; });
  const makeLeases = () => new ResourceLeases(store, { warm: () => true, backends: { browser: processBackend(home) } });
  const leases = makeLeases();
  cleanups.push(async () => { const current = makeLeases(); for (const row of current.list()) await current.release(row.id, thread.id); store.close(); rmSync(home, { recursive: true, force: true }); });
  const input = { threadId: thread.id, runId: run.id, cwd: home };
  const launch = { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/managed-chrome.mjs", import.meta.url))] };
  return { home, get store() { return store; }, leases, makeLeases, input, launch, reopen: () => { store.close(); store = new LoomStore(join(home, "state.db")); } };
}
it("launches managed browsers with audio muted", async () => {
  const f = setup();
  const { browser } = await createManagedBrowser(f.leases, f.home, f.input, f.launch);
  const response = await fetch(`http://127.0.0.1:${browser.port}/json/version`);
  const { args } = await response.json() as { args: string[] };
  expect(args).toContain("--mute-audio");
});
it("leases profile and port, reuses only the same run, and cleans up after restart and run end", async () => {
  const f = setup();
  const first = await createManagedBrowser(f.leases, f.home, f.input, f.launch);
  const identity = JSON.parse(first.lease.identity) as ProcessIdentity;
  expect(first.lease.policy).toBe("run_end");
  expect(first.lease.resource_key).toBe(`browser-port:${first.browser.port}`);
  expect(await browserReady(f.home, identity)).toBe(true);
  expect((await createManagedBrowser(f.leases, f.home, f.input, f.launch)).lease.id).toBe(first.lease.id);
  f.reopen();
  const fresh = f.makeLeases();
  await fresh.reconcile(); expect(inspectProcess(identity)).toBe("same");
  f.store.tx(() => f.store.updateRun(f.input.runId, { status: "completed" }));
  await fresh.reconcile();
  expect(inspectProcess(identity)).toBe("gone");
  expect(existsSync(browserProfilePath(f.home, identity.profile!))).toBe(false);
  expect(fresh.list()[0]?.state).toBe("reclaimed");
});
it("never adopts a listener outside the nonce-owned process group", async () => {
  const f = setup();
  const first = await createManagedBrowser(f.leases, f.home, f.input, f.launch);
  const secondRun = f.store.tx(() => { const row = f.store.createRun(f.input.threadId, "user", "next"); f.store.updateRun(row.id, { status: "running" }); return row; });
  const second = await createManagedBrowser(f.leases, f.home, { ...f.input, runId: secondRun.id }, f.launch);
  expect(second.lease.id).not.toBe(first.lease.id);
  const identity = JSON.parse(first.lease.identity) as ProcessIdentity;
  identity.browser!.port = second.browser.port;
  expect(await browserReady(f.home, identity)).toBe(false);
});
it("reclaims a failed launch and permits a clean retry", async () => {
  const f = setup();
  await expect(createManagedBrowser(f.leases, f.home, f.input, { command: "/missing/managed-chrome", args: [] })).rejects.toThrow(/did not open/);
  expect(f.leases.list()[0]?.state).toBe("reclaimed");
  expect((await createManagedBrowser(f.leases, f.home, f.input, f.launch)).lease.state).toBe("active");
});
it("does not launch Chrome or retain a profile for a stale run", async () => {
  const f = setup();
  f.store.tx(() => f.store.updateRun(f.input.runId, { status: "completed" }));
  await expect(createManagedBrowser(f.leases, f.home, f.input, f.launch)).rejects.toThrow(/not active/);
  expect(f.leases.list()).toHaveLength(0);
});

it("records port/profile ownership before activation and reclaims a failed handoff", async () => {
  const f = setup();
  await expect(createManagedProcess(f.leases, f.home, { ...f.input, kind: "browser", profile: "exclusive", command: process.execPath, args: [], managedBrowser: {
    port: 12345, releasePort: async () => {
      const row = f.leases.list()[0]!;
      expect(row.resource_key).toBe("browser-port:12345");
      const identity = JSON.parse(row.identity) as ProcessIdentity;
      expect(existsSync(browserProfilePath(f.home, identity.profile!))).toBe(true);
      throw Error("port handoff failed");
    },
  } })).rejects.toThrow(/port handoff failed/);
  expect(f.leases.list()[0]?.state).toBe("reclaimed");
});
