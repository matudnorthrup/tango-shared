import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { LoomHost } from "../src/host.js";
import { LoomStore } from "../src/store.js";
import { createLoomServer } from "../src/http.js";
import { FakeRuntime } from "./fake-runtime.js";
import * as processes from "../src/managed-process.js";
import { reserveServeMapping } from "../src/serve-transport.js";
vi.mock("../src/serve-transport.js", async original => ({
  ...await original<typeof import("../src/serve-transport.js")>(),
  reserveServeMapping: vi.fn(), serveStatus: vi.fn(async () => ({})),
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanups.splice(0)) await f(); vi.restoreAllMocks(); vi.clearAllMocks(); });
it("authorizes and validates mapping creation before reserving any watcher", async () => {
  const home = mkdtempSync(join(tmpdir(), "mapping-api-")), cwd = join(home, "worktrees", "owned"); mkdirSync(cwd, { recursive: true });
  const store = new LoomStore(join(home, "state.db"));
  const backend = processes.processBackend(home);
  vi.spyOn(processes, "processBackend").mockReturnValue(backend);
  const host = new LoomHost(store, { fake: new FakeRuntime() }, { loomHome: home });
  const server = createLoomServer(host, { token: "test-token" });
  cleanups.push(async () => { await new Promise<void>(r => server.close(() => r())); await host.closeAll(); store.close(); rmSync(home, { recursive: true, force: true }); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const submit = await host.execute({ type: "submit", commandId: "start", cwd, provider: "fake", text: "test" });
  const threadId = submit.threadId!, runId = store.activeRun(threadId)!.id;
  const call = (body: unknown, auth = true) => fetch(`${base}/threads/${threadId}/resources`, { method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: "Bearer test-token" } : {}) }, body: JSON.stringify(body) });
  const body = { runId, kind: "mapping", localPort: 3100, httpsPort: 13100 };
  expect((await call(body, false)).status).toBe(401);
  for (const change of [{ localPort: 0 }, { httpsPort: 65536 }, { httpsPort: "13100" }, { command: "ignored" }, { cwd }, { profile: "exclusive" }]) expect((await call({ ...body, ...change })).status).toBe(400);
  expect((await call({ ...body, runId: "stale" })).status).toBe(409);
  store.tx(() => store.updateThread(threadId, { session_profile: JSON.stringify({ loomTools: false }) }));
  expect((await call(body)).status).toBe(400);
  expect(reserveServeMapping).not.toHaveBeenCalled();
  store.tx(() => store.updateThread(threadId, { session_profile: null }));
  const list = vi.spyOn(host.leases, "list");
  for (const state of ["active", "blocked"] as const) {
    list.mockReturnValueOnce([{ resource_key: "browser-port:3100", thread_id: "another-thread", state } as ReturnType<typeof host.leases.list>[number]]);
    const response = await call(body);
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("another thread's browser lease");
    expect(reserveServeMapping).not.toHaveBeenCalled();
  }
  list.mockRestore();
  const activate = vi.fn(async () => { expect(host.leases.list()).toHaveLength(1); });
  vi.mocked(reserveServeMapping).mockResolvedValue({ identity: { sessionId: "test", httpsPort: 13100, process: { pid: process.pid, started: "test", uid: 0, nonce: "00000000-0000-0000-0000-000000000001" }, config: { TCP: { "13100": { HTTPS: true } }, Web: { "test.invalid:13100": { Handlers: { "/": { Proxy: "http://127.0.0.1:3100" } } } } } }, activate, abort: vi.fn() });
  expect((await call(body)).status).toBe(200);
  expect(reserveServeMapping).toHaveBeenCalledExactlyOnceWith(3100, 13100);
  expect(activate).toHaveBeenCalledTimes(1);
  expect((await call(body)).status).toBe(409); // changed watcher identity cannot be adopted
  let processState: "same" | "gone" = "same";
  vi.spyOn(backend, "inspect").mockImplementation(async () => processState);
  const stop = vi.spyOn(backend, "reclaim").mockImplementation(async () => { processState = "gone"; });
  vi.spyOn(backend, "cleanup").mockResolvedValue();
  activate.mockImplementation(async () => { processState = "same"; });
  // The first mapping disappeared while its owned watcher stayed alive.
  expect((await call(body)).status).toBe(200);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(host.leases.list().filter(row => row.state === "reclaimed")).toHaveLength(1);
  activate.mockImplementationOnce(async () => { processState = "same"; throw Error("activation failed"); });
  expect((await call(body)).status).toBe(500);
  expect(host.leases.list().every(row => row.state === "reclaimed")).toBe(true);
  expect((await call(body)).status).toBe(200);
});
