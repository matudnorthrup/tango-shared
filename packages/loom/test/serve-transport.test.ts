import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoomStore } from "../src/store.js";
import { ResourceLeases } from "../src/leases.js";
import { afterEach, expect, it } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { reserveServeMapping, portOccupied, serveRequest, serveStatus } from "../src/serve-transport.js";
import { createManagedMapping, mappingBackend, mappingRemoval, type ServeConfig } from "../src/managed-mapping.js";
import { managedProcessBackend, inspectProcess } from "../src/managed-process.js";
import { killGroup } from "../src/proc.js";
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
async function fixture() {
  let config: ServeConfig = { TCP: { "443": { HTTPS: true } }, AllowFunnel: { "other.invalid:443": true } };
  let version = 1; let conflict = false; let watcher: ServerResponse | undefined;
  const server = createServer((req, res) => {
    if (req.url === "/localapi/v0/status") return void res.end(JSON.stringify({ Self: { DNSName: "test.invalid." } }));
    if (req.url === "/localapi/v0/watch-ipn-bus?mask=2") {
      watcher = res; res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"SessionID":"test-session"}\n'); return;
    }
    if (req.method === "GET") { res.setHeader("ETag", `"${version}"`); return void res.end(JSON.stringify(config)); }
    let body = ""; req.on("data", b => body += b); req.on("end", () => {
      if (conflict || req.headers["if-match"] !== `"${version}"`) { res.writeHead(412); res.end(); return; }
      const hadSession = !!config.Foreground?.["test-session"];
      config = JSON.parse(body); version++; res.end("null");
      if (hadSession && !config.Foreground?.["test-session"]) watcher?.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { watcher?.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const options = { hostname: "127.0.0.1", port: (server.address() as AddressInfo).port };
  return { options, config: () => config, conflict: (value = true) => { conflict = value; } };
}
it("reserves a real foreground watcher before publication and conditionally removes only its mapping", async () => {
  const f = await fixture();
  const reservation = await reserveServeMapping(3100, 13100, f.options);
  cleanup.push(() => { killGroup(reservation.identity.process.pid); });
  expect(inspectProcess(reservation.identity.process)).toBe("same");
  expect(f.config().Foreground).toBeUndefined();
  await reservation.activate();
  expect(f.config().Foreground?.[reservation.identity.sessionId]).toEqual(reservation.identity.config);
  const backend = mappingBackend(async () => f.config(), managedProcessBackend, async identity => {
    const snapshot = await serveRequest(f.options, "GET", "serve-config");
    await serveRequest(f.options, "POST", "serve-config", mappingRemoval(identity, snapshot.value), snapshot.etag);
  });
  await backend.reclaim(reservation.identity);
  expect(inspectProcess(reservation.identity.process)).toBe("gone");
  expect(f.config().AllowFunnel).toEqual({ "other.invalid:443": true });
  expect(f.config().TCP).toEqual({ "443": { HTTPS: true } });
}, 10_000);
it("rejects occupied ports and conditional update conflicts without overwriting config", async () => {
  const f = await fixture();
  for (const port of [443, 13100]) {
    const reservation = await reserveServeMapping(3100, port, f.options);
    cleanup.push(() => { killGroup(reservation.identity.process.pid); });
    if (port === 13100) f.conflict();
    await expect(reservation.activate()).rejects.toThrow(port === 443 ? /occupied/ : /412/);
    expect(f.config().Foreground).toBeUndefined();
  }
});
it("recognizes collisions in every Serve namespace", () => {
  for (const c of [{ TCP: { "13100": {} } }, { Web: { "test:13100": {} } }, { AllowFunnel: { "test:13100": true } }, { Foreground: { other: { TCP: { "13100": {} } } } }]) expect(portOccupied(c, 13100)).toBe(true);
});

it("reclaims a real watcher after a 412 and retries the same port without cooling", async () => {
  const f = await fixture();
  const dir = mkdtempSync(join(tmpdir(), "serve-retry-"));
  const store = new LoomStore(join(dir, "state.db"));
  cleanup.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const thread = store.tx(() => store.createThread({ cwd: dir, kind: "test", provider: "fake" }));
  const run = store.tx(() => { const r = store.createRun(thread.id, "user", "test"); store.updateRun(r.id, { status: "running" }); return r; });
  const backend = mappingBackend(() => serveStatus(f.options), managedProcessBackend, async identity => {
    const snapshot = await serveRequest(f.options, "GET", "serve-config");
    await serveRequest(f.options, "POST", "serve-config", mappingRemoval(identity, snapshot.value), snapshot.etag);
  });
  const leases = new ResourceLeases(store, { warm: () => true, backends: { mapping: backend } });
  const create = () => createManagedMapping(leases, { threadId: thread.id, runId: run.id, reserve: async () => {
    const reservation = await reserveServeMapping(3100, 13100, f.options);
    cleanup.push(() => reservation.abort());
    return reservation;
  } });
  f.conflict();
  await expect(create()).rejects.toThrow(/412/);
  const failed = leases.list()[0]!;
  expect(failed.state).toBe("reclaimed");
  expect(inspectProcess(JSON.parse(failed.identity).process)).toBe("gone");
  f.conflict(false);
  const { lease } = await create();
  expect(lease.state).toBe("active");
  expect(f.config().Foreground?.["test-session"]).toBeDefined();
  await leases.release(lease.id, thread.id);
  expect(leases.list().every(row => row.state === "reclaimed")).toBe(true);
  expect(f.config().TCP).toEqual({ "443": { HTTPS: true } });
  expect(f.config().AllowFunnel).toEqual({ "other.invalid:443": true });
}, 10_000);
