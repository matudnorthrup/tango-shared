import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, existsSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { LoomHost } from "../src/host.js";
import { LoomStore } from "../src/store.js";
import { createLoomServer } from "../src/http.js";
import { FakeRuntime } from "./fake-runtime.js";
import { inspectProcess } from "../src/managed-process.js";
import { killGroup } from "../src/proc.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
it("serves authenticated managed creation, run cleanup and thread cleanup with real subprocesses", async () => {
  const home = mkdtempSync(join(tmpdir(), "loom-managed-api-"));
  const cwd = join(home, "worktrees", "owned");
  mkdirSync(cwd, { recursive: true });
  const store = new LoomStore(join(home, "store.db"));
  const runtime = new FakeRuntime();
  const host = new LoomHost(store, { fake: runtime }, { loomHome: home });
  const server = createLoomServer(host, { token: "test-token" });
  const identities: { pid: number }[] = [];
  cleanups.push(async () => {
    for (const identity of identities) killGroup(identity.pid);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await host.closeAll(); store.close(); rmSync(home, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, body?: unknown) => fetch(base + path, { method: body ? "POST" : "GET", headers: { authorization: "Bearer test-token", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  expect((await fetch(base + "/resources")).status).toBe(401);
  const response = await call("/commands", { type: "submit", commandId: "start", cwd, provider: "fake", text: "test" });
  const { result: { threadId } } = await response.json() as { result: { threadId: string } };
  expect((await call(`/threads/${threadId}/resources`, { kind: "mapping", command: "ignored", args: [] })).status).toBe(400);
  const runId = store.activeRun(threadId)!.id;
  expect((await fetch(base + `/threads/${threadId}/resources`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId, kind: "browser", command: process.execPath, args: [] }) })).status).toBe(401);
  expect(host.leases.list()).toHaveLength(0);
  const payload = { runId, kind: "browser", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] };
  expect((await fetch(base + '/threads/' + threadId + '/resources', { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: '{broken' })).status).toBe(400);
  expect((await call('/threads/missing/resources', payload)).status).toBe(409);
  expect((await call('/threads/' + threadId + '/resources', { ...payload, cwd: home })).status).toBe(400);
  const stale = await call(`/threads/${threadId}/resources`, { ...payload, runId: "stale" });
  expect(stale.status).toBe(409);
  expect((await stale.json() as { message: string }).message).toMatch(/retry from the current Loom turn/);
  expect((await call(`/threads/${threadId}/resources`, { ...payload, runId: undefined })).status).toBe(400);
  expect((await call(`/threads/${threadId}/resources`, { ...payload, profile: "/existing/profile" })).status).toBe(400);
  store.tx(() => store.updateThread(threadId, { cwd: home }));
  expect((await call('/threads/' + threadId + '/resources', payload)).status).toBe(400);
  const alias = join(home, 'worktrees', 'alias'); symlinkSync(home, alias);
  store.tx(() => store.updateThread(threadId, { cwd: alias }));
  expect((await call('/threads/' + threadId + '/resources', payload)).status).toBe(400);
  store.tx(() => store.updateThread(threadId, { cwd }));
  const other = store.tx(() => store.createThread({ cwd, provider: "fake", kind: "test" }));
  expect((await call('/threads/' + threadId + '/resources', payload)).status).toBe(400);
  store.tx(() => store.updateThread(other.id, { cwd: home }));
  store.tx(() => store.updateThread(threadId, { session_profile: JSON.stringify({ loomTools: false }) }));
  expect((await call('/threads/' + threadId + '/resources', payload)).status).toBe(400);
  store.tx(() => store.updateThread(threadId, { session_profile: null }));
  for (const kind of ["browser", "dev_server"] as const) {
    const response = await call(`/threads/${threadId}/resources`, { runId, kind, ...(kind === "dev_server" ? { cwd } : {}), command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] });
    expect(response.status).toBe(200);
    const { lease } = await response.json() as { lease: { identity: string } };
    const identity = JSON.parse(lease.identity); identities.push(identity);
    expect(inspectProcess(identity)).toBe("same");
  }
  expect(host.leases.holds(threadId)).toBe(true);
  runtime.last.complete();
  await host.kick(threadId);
  await host.leases.reconcile();
  expect(inspectProcess(identities[0])).toBe("gone");
  expect(inspectProcess(identities[1])).toBe("same");
  await host.execute({ type: "stop", threadId, commandId: "stop" });
  await host.leases.reconcile();
  expect(inspectProcess(identities[1])).toBe("gone");
  expect(host.leases.holds(threadId)).toBe(false);
  for (const identity of identities) expect(existsSync(join(home, "resources", (identity as { nonce?: string }).nonce!))).toBe(false);
  const inventory = await (await call("/resources")).json() as { leases: { state: string }[]; coverage: string };
  expect(inventory.leases.map(row => row.state)).toEqual(["reclaimed", "reclaimed"]);
  expect(inventory.coverage).toContain("report-only");
}, 15_000);


it.each(["direct", "symlink", "case-variant"])("serves the caller subdirectory (%s) and releases only owned, verified leases through HTTP", async (mode, context) => {
  const home = mkdtempSync(join(tmpdir(), "loom-cwd-release-"));
  const cwd = join(home, "worktrees", "owned"), subdir = join(cwd, "app");
  mkdirSync(subdir, { recursive: true });
  const caseVariant = join(home, "worktrees", "OWNED", "APP");
  if (mode === "case-variant" && !existsSync(caseVariant)) {
    rmSync(home, { recursive: true, force: true });
    context.skip(); // Case-sensitive filesystems cannot resolve this spelling.
  }
  writeFileSync(join(cwd, "marker.txt"), "wrong-root");
  writeFileSync(join(subdir, "marker.txt"), "caller-subdir");
  const escape = join(cwd, "escape"), alias = join(cwd, "alias");
  symlinkSync(home, escape); symlinkSync(subdir, alias);
  writeFileSync(join(subdir, "server.cjs"), `
    const fs = require('node:fs');
    const server = require('node:http').createServer((req,res) => res.end(fs.readFileSync('marker.txt')));
    server.listen(0, '127.0.0.1', () => fs.writeFileSync('ready.json', JSON.stringify({port:server.address().port,cwd:process.cwd()})));
  `);
  const store = new LoomStore(join(home, "store.db"));
  const runtime = new FakeRuntime();
  const host = new LoomHost(store, { fake: runtime }, { loomHome: home });
  const server = createLoomServer(host, { token: "test-token" });
  const identities: { pid: number }[] = [];
  cleanups.push(async () => {
    for (const identity of identities) killGroup(identity.pid);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await host.closeAll(); store.close(); rmSync(home, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" }, body: JSON.stringify(body) });
  const response = await call("/commands", { type: "submit", commandId: "start", cwd, provider: "fake", text: "test" });
  const { result: { threadId } } = await response.json() as { result: { threadId: string } };
  let runId = store.activeRun(threadId)!.id;
  const path = `/threads/${threadId}/resources`;
  const payload = { runId, kind: "dev_server", command: process.execPath, args: ["server.cjs"], cwd: subdir };
  for (const invalid of [undefined, null, 1, "", "app", home, escape, join(cwd, "missing"), join(subdir, "marker.txt"), cwd + "-sibling"]) {
    const response = await call(path, { ...payload, cwd: invalid });
    expect(response.status).toBe(400);
    expect((await response.json()).message).toMatch(/cwd/);
  }
  expect(host.leases.list()).toHaveLength(0);
  // A symlink to a directory inside the worktree is valid and uses its real path.
  const launched = await call(path, { ...payload, cwd: mode === "symlink" ? alias : mode === "case-variant" ? caseVariant : subdir });
  expect(launched.status).toBe(200);
  const { lease } = await launched.json() as { lease: { id: string; identity: string } };
  const identity = JSON.parse(lease.identity); identities.push(identity);
  await expect.poll(() => existsSync(join(subdir, "ready.json"))).toBe(true);
  const ready = JSON.parse(readFileSync(join(subdir, "ready.json"), "utf8"));
  expect(ready.cwd).toBe(realpathSync(subdir));
  const url = `http://127.0.0.1:${ready.port}`;
  expect(await (await fetch(url)).text()).toBe("caller-subdir");
  const releasePath = `${path}/${lease.id}/release`;
  expect((await fetch(base + releasePath, { method: "POST", body: JSON.stringify({ runId }) })).status).toBe(401);
  for (const body of [{}, { runId: null }, { runId, force: true }]) expect((await call(releasePath, body)).status).toBe(400);
  expect((await fetch(base + releasePath, { method: "POST", headers: { authorization: "Bearer test-token" }, body: "{broken" })).status).toBe(400);
  expect((await call(releasePath, { runId: "stale" })).status).toBe(409);
  expect((await call(`${path}/missing/release`, { runId })).status).toBe(409);
  const other = await call("/commands", { type: "submit", commandId: "other", cwd: home, provider: "fake", text: "other" });
  const otherId = (await other.json()).result.threadId;
  expect((await call(`/threads/${otherId}/resources/${lease.id}/release`, { runId: store.activeRun(otherId)!.id })).status).toBe(409);
  store.tx(() => store.updateThread(threadId, { session_profile: JSON.stringify({ loomTools: false }) }));
  expect((await call(releasePath, { runId })).status).toBe(400);
  store.tx(() => store.updateThread(threadId, { session_profile: null }));
  // A changed nonce simulates PID reuse: the live process must survive the request.
  store.db.prepare("UPDATE resource_leases SET identity = ? WHERE id = ?").run(JSON.stringify({ ...identity, nonce: "00000000-0000-0000-0000-000000000000" }), lease.id);
  expect((await call(releasePath, { runId })).status).toBe(409);
  expect(inspectProcess(identity)).toBe("same");
  expect(await (await fetch(url)).text()).toBe("caller-subdir");
  store.db.prepare("UPDATE resource_leases SET identity = ? WHERE id = ?").run(lease.identity, lease.id);
  // Dev-server leases survive turns; the current run can release an earlier run's lease.
  runtime.sessions[0]!.complete();
  await host.kick(threadId);
  await call("/commands", { type: "submit", commandId: "again", threadId, text: "next" });
  const oldRunId = runId; runId = store.activeRun(threadId)!.id;
  expect(runId).not.toBe(oldRunId);
  expect((await call(releasePath, { runId: oldRunId })).status).toBe(409);
  const released = await call(releasePath, { runId });
  expect(released.status).toBe(200);
  expect((await released.json()).lease.state).toBe("reclaimed");
  expect(inspectProcess(identity)).toBe("gone");
  await expect(fetch(url)).rejects.toThrow();
  expect((await call(releasePath, { runId })).status).toBe(200);
}, 20_000);
