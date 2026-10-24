import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoomStore } from "../src/store.js";
import { ResourceLeases } from "../src/leases.js";
import { createManagedMapping, mappingBackend, inspectMappingConfig, mappingRemoval, type MappingIdentity, type ServeConfig } from "../src/managed-mapping.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "mapping-test-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  let store = new LoomStore(join(root, "state.db")); cleanups.push(() => store.close());
  const thread = store.tx(() => store.createThread({ cwd: root, kind: "test", provider: "fake" }));
  const run = store.tx(() => { const r = store.createRun(thread.id, "user", "work"); store.updateRun(r.id, { status: "running" }); return r; });
  const identity: MappingIdentity = { sessionId: "issued-session", process: { pid: 123, started: "test", uid: 0, nonce: "00000000-0000-0000-0000-000000000001" }, httpsPort: 13100, config: { TCP: { "13100": { HTTPS: true } }, Web: { "test.invalid:13100": { Handlers: { "/": { Proxy: "http://127.0.0.1:3100" } } } } } };
  let status: ServeConfig = {};
  let process: "same" | "gone" | "different" | "unknown" = "same";
  const read = vi.fn(async () => status);
  const stop = vi.fn(async () => { process = "gone"; delete status.Foreground?.[identity.sessionId]; });
  const remove = vi.fn(async () => {
    const state = inspectMappingConfig(identity, status);
    if (state !== "same" && state !== "gone") throw Error("conditional update conflict");
    delete status.Foreground?.[identity.sessionId];
  });
  const backend = mappingBackend(read, { inspect: async () => process, reclaim: stop }, remove);
  const makeLeases = () => new ResourceLeases(store, { warm: () => false, backends: { mapping: backend } });
  let leases = makeLeases();
  const activate = vi.fn(async () => {
    expect(leases.list().filter(row => row.state !== "reclaimed")).toHaveLength(1);
    status.Foreground = { ...status.Foreground, [identity.sessionId]: structuredClone(identity.config) };
  });
  const abort = vi.fn(async () => { process = "gone"; });
  return {
    identity, read, stop, remove, activate, abort, backend,
    leases: () => leases,
    status: () => status,
    process: (value: typeof process) => { process = value; },
    create: () => createManagedMapping(leases, { threadId: thread.id, runId: run.id, reserve: async () => ({ identity, activate, abort }) }),
    end: () => store.tx(() => store.updateRun(run.id, { status: "completed" })),
    cool: () => store.tx(() => store.updateThread(thread.id, { cooled_at: store.now() })),
    restart: () => { store.close(); store = new LoomStore(join(root, "state.db")); leases = makeLeases(); },
  };
}

it("registers before activation, survives run end and restart, then reclaims on cooling", async () => {
  const f = setup(); await f.create(); f.end(); f.restart();
  await f.leases().reconcile(); expect(f.stop).not.toHaveBeenCalled();
  f.cool(); await f.leases().reconcile();
  expect(f.stop).toHaveBeenCalledTimes(1); expect(f.leases().list()[0]?.state).toBe("reclaimed");
});
it("refuses stale runs before activation and aborts only the gated child", async () => {
  const f = setup(); f.end(); await expect(f.create()).rejects.toThrow(/not active/);
  expect(f.activate).not.toHaveBeenCalled(); expect(f.abort).toHaveBeenCalledTimes(1);
});
it("releases a failed activation immediately and allows retry on the same port while warm", async () => {
  const f = setup(); f.activate.mockRejectedValueOnce(Error("connection lost"));
  await expect(f.create()).rejects.toThrow(/connection lost/);
  expect(f.leases().list()[0]?.state).toBe("reclaimed");
  expect(f.abort).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
  expect(f.stop).toHaveBeenCalledTimes(1);
  f.process("same"); await f.create();
  expect(f.leases().list().filter(row => row.state === "active")).toHaveLength(1);
});
it("removes an activated session even if its POST response was lost", async () => {
  const f = setup(); f.activate.mockImplementationOnce(async () => {
    f.status().Foreground = { [f.identity.sessionId]: f.identity.config };
    throw Error("response lost");
  });
  await expect(f.create()).rejects.toThrow(/response lost/);
  expect(f.remove).toHaveBeenCalledTimes(1);
  expect(f.leases().list()[0]?.state).toBe("reclaimed");
});
it("retains failed activation ownership when cleanup discovery fails", async () => {
  const f = setup(); f.activate.mockRejectedValueOnce(Error("connection lost"));
  f.read.mockRejectedValue(Error("status unavailable"));
  await expect(f.create()).rejects.toThrow(/connection lost/);
  expect(f.leases().list()[0]?.state).toBe("blocked");
  expect(f.stop).not.toHaveBeenCalled(); expect(f.abort).not.toHaveBeenCalled();
});
it("never releases another thread's lease", async () => {
  const f = setup(); const { lease } = await f.create();
  await f.leases().release(lease.id, "other-thread");
  expect(f.stop).not.toHaveBeenCalled(); expect(f.leases().list()[0]?.state).toBe("active");
});
it.each(["changed", "shared", "funnel"])("preserves %s mapping state", async change => {
  const f = setup(); await f.create(); f.end(); f.cool();
  if (change === "changed") f.status().Foreground![f.identity.sessionId] = { TCP: { "13100": { TCPForward: "other" } } };
  if (change === "shared") f.status().TCP = { "13100": { HTTPS: true } };
  if (change === "funnel") f.status().Foreground![f.identity.sessionId]!.AllowFunnel = { "test.invalid:13100": true };
  await f.leases().reconcile(); expect(f.stop).not.toHaveBeenCalled(); expect(f.leases().list()[0]?.state).toBe("blocked");
});
it("preserves a replacement with an identical target but a different session", async () => {
  const f = setup(); await f.create(); f.end(); f.cool();
  delete f.status().Foreground![f.identity.sessionId];
  f.status().Foreground!.replacement = structuredClone(f.identity.config);
  await f.leases().reconcile();
  expect(f.status().Foreground!.replacement).toEqual(f.identity.config);
  expect(f.leases().list()[0]?.state).toBe("reclaimed");
});
it.each(["different", "unknown"] as const)("preserves a %s process identity", async state => {
  const f = setup(); await f.create(); f.end(); f.cool(); f.process(state);
  await f.leases().reconcile(); expect(f.stop).not.toHaveBeenCalled();
});
it("rechecks status at reclaim time and never acts after discovery failure", async () => {
  const f = setup(); await f.create();
  expect(await f.backend.inspect(f.identity)).toBe("same");
  f.status().TCP = { "13100": { HTTPS: true } };
  await expect(f.backend.reclaim(f.identity)).rejects.toThrow(/ownership changed/);
  f.read.mockRejectedValue(Error("status unavailable"));
  await expect(f.backend.reclaim(f.identity)).rejects.toThrow(/status unavailable/);
  expect(f.stop).not.toHaveBeenCalled();
});

it("does not stop a watcher if the conditional removal conflicts", async () => {
  const f = setup(); await f.create(); f.end(); f.cool();
  f.remove.mockRejectedValue(Error("conditional update conflict"));
  await f.leases().reconcile(); expect(f.stop).not.toHaveBeenCalled();
  expect(f.leases().list()[0]?.state).toBe("blocked");
});

it("conditional removal preserves unrelated background, foreground and Funnel configuration", async () => {
  const f = setup(); await f.create();
  const status = f.status();
  status.TCP = { "443": { HTTPS: true } };
  status.AllowFunnel = { "test.invalid:443": true };
  status.Foreground!.other = { TCP: { "8443": { HTTPS: true } } };
  const next = mappingRemoval(f.identity, status);
  expect(next.Foreground?.[f.identity.sessionId]).toBeUndefined();
  expect(next.TCP).toEqual(status.TCP); expect(next.AllowFunnel).toEqual(status.AllowFunnel);
  expect(next.Foreground?.other).toEqual(status.Foreground?.other);
  expect(status.Foreground?.[f.identity.sessionId]).toBeDefined();
});

it("stops an owned watcher whose mapping is already gone without a conditional removal", async () => {
  const f = setup(); await f.create(); f.end(); f.cool();
  delete f.status().Foreground![f.identity.sessionId];
  f.remove.mockRejectedValue(Error("missing session conflict"));
  await f.leases().reconcile();
  expect(f.remove).not.toHaveBeenCalled();
  expect(f.stop).toHaveBeenCalledTimes(1);
  expect(f.leases().list()[0]?.state).toBe("reclaimed");
});

it("accepts a watcher that exits when Tailscale removes its session", async () => {
  const f = setup(); await f.create(); f.end(); f.cool();
  f.remove.mockImplementation(async () => { delete f.status().Foreground![f.identity.sessionId]; f.process("gone"); });
  await f.leases().reconcile();
  expect(f.remove).toHaveBeenCalledTimes(1);
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.leases().list()[0]?.state).toBe("reclaimed");
});

it("preserves a reused watcher PID after session removal and keeps the lease blocked", async () => {
  const f = setup(); await f.create(); f.end(); f.cool();
  f.remove.mockImplementation(async () => { delete f.status().Foreground![f.identity.sessionId]; f.process("different"); });
  await f.leases().reconcile();
  expect(f.remove).toHaveBeenCalledTimes(1);
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.leases().list()[0]?.state).toBe("blocked");
});
