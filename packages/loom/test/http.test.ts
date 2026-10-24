import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { AccountPool } from "../src/pool.js";
import { LoomHost } from "../src/host.js";
import { createLoomServer } from "../src/http.js";
import { LoomStore } from "../src/store.js";
import { FakeRuntime } from "./fake-runtime.js";

const TOKEN = "test-token";
let server: Server | undefined;

async function start(opts: { maxReplay?: number; pool?: AccountPool } = {}) {
  const store = new LoomStore(":memory:");
  const runtime = new FakeRuntime(store);
  const host = new LoomHost(store, { fake: runtime }, { pool: opts.pool });
  server = createLoomServer(host, { token: TOKEN, heartbeatMs: 60_000, ...opts });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...init.headers } });
  return { store, runtime, host, base, call };
}

/** Read SSE frames until `count` frames arrive, then abort. */
async function readFrames(res: Response, count: number, abort: AbortController) {
  const frames: { event: string; id?: string; data: any }[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (raw.startsWith(":")) continue;
      const f: any = {};
      for (const line of raw.split("\n")) {
        const [k, ...rest] = line.split(": ");
        f[k!] = rest.join(": ");
      }
      frames.push({ event: f.event, id: f.id, data: JSON.parse(f.data) });
    }
  }
  abort.abort();
  return frames;
}

afterEach(async () => {
  await new Promise((r) => (server ? server.close(() => r(null)) : r(null)));
  server = undefined;
});

describe("Loom HTTP API", () => {
  it("authenticates maintenance, validates writes and returns run counts", async () => {
    const { host, store, call, base } = await start();
    try {
      expect((await fetch(base + "/maintenance")).status).toBe(401);
      expect((await call("/maintenance", { method: "POST", body: JSON.stringify({ on: "yes" }) })).status).toBe(400);
      const enabled = await call("/maintenance", { method: "POST", body: JSON.stringify({ on: true, reason: "upgrade" }) });
      expect(await enabled.json()).toMatchObject({ on: true, reason: "upgrade", running: 0, queued: 0 });
      await host.execute({ type: "submit", commandId: "queued", cwd: "/tmp", provider: "fake", text: "wait" });
      expect(await (await call("/maintenance")).json()).toMatchObject({ on: true, running: 0, queued: 1 });
      expect(await (await call("/maintenance", { method: "POST", body: JSON.stringify({ on: false }) })).json()).toMatchObject({ on: false, running: 1, queued: 0 });
    } finally { await host.closeAll(); store.close(); }
  });
  it("serves capacity and account history and accepts both move routes", async () => {
    const pool = new AccountPool(["a", "b"].map((name) => ({ provider: "fake", name })));
    const { call, runtime, host } = await start({ pool });
    const { result } = await (await call("/commands", { method: "POST", body: JSON.stringify({ type: "submit", commandId: "start", cwd: "/repo", provider: "fake", text: "hello", account: "a" }) })).json();
    runtime.last.complete();
    await host.kick(result.threadId);
    const move = await call(`/threads/${result.threadId}/move`, { method: "POST", body: JSON.stringify({ commandId: "move", account: "b" }) });
    expect(move.status).toBe(200);
    const history = await (await call(`/threads/${result.threadId}/accounts`)).json();
    expect(history.map((h: { account: string; reason: string }) => [h.account, h.reason])).toEqual([["a", "start"], ["b", "move"]]);
    expect(await (await call("/capacity")).json()).toMatchObject({ loom: true, moves: true, machine: null });
    expect((await call("/commands", { method: "POST", body: JSON.stringify({ type: "move", commandId: "back", threadId: result.threadId, account: "a" }) })).status).toBe(200);
    expect((await call(`/threads/missing/move`, { method: "POST", body: JSON.stringify({ commandId: "missing", account: "a" }) })).status).toBe(404);
    expect((await call(`/threads/${result.threadId}/move`, { method: "POST", body: JSON.stringify({ commandId: "bad", account: "unknown" }) })).status).toBe(409);
    expect((await call("/threads/missing/accounts")).status).toBe(404);
  });

  it("serves a thread's carried state to its session", async () => {
    const { call, runtime, host } = await start();
    const { result } = await (await call("/commands", { method: "POST", body: JSON.stringify({ type: "submit", commandId: "carry", cwd: "/repo", provider: "fake", text: "keep this" }) })).json();
    runtime.last.complete();
    await host.kick(result.threadId);
    const body = await (await call(`/threads/${result.threadId}/carry`)).json();
    expect(body.text).toContain("keep this");
    expect((await call("/threads/missing/carry")).status).toBe(404);
  });

  it("keeps a session and asks a fresh start (TGO-1108)", async () => {
    const { call, runtime, host } = await start();
    const { result } = await (await call("/commands", { method: "POST", body: JSON.stringify({ type: "submit", commandId: "keep", cwd: "/repo", provider: "fake", text: "hi" }) })).json();
    runtime.last.complete();
    await host.kick(result.threadId);
    expect((await call(`/threads/${result.threadId}/keep-session`, { method: "POST", body: JSON.stringify({ keep: "yes" }) })).status).toBe(400);
    expect(await (await call(`/threads/${result.threadId}/keep-session`, { method: "POST", body: JSON.stringify({ keep: true }) })).json()).toEqual({ ok: true, keep: true });
    expect(host.store.thread(result.threadId)!.fresh_opt_out).toBe(1);
    expect((await call(`/threads/missing/keep-session`, { method: "POST", body: JSON.stringify({ keep: true }) })).status).toBe(404);
    expect((await call(`/threads/${result.threadId}/fresh-start`, { method: "POST" })).status).toBe(200);
    expect((await call(`/threads/missing/fresh-start`, { method: "POST" })).status).toBe(404);
  });

  it("a Keep the client gave up on while it waited in the mailbox never applies (Codex review on #840)", async () => {
    const { call, runtime, host } = await start();
    // The thread's first turn is still opening its host, holding the mailbox.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const open = runtime.open.bind(runtime);
    runtime.open = async (options, emit) => { await held; return open(options, emit); };
    const submitted = host.execute({ type: "submit", commandId: "slow", cwd: "/repo", provider: "fake", text: "hi" });
    await new Promise((r) => setTimeout(r, 10));
    const threadId = host.store.threads()[0]!.id;
    await expect(call(`/threads/${threadId}/keep-session`, { method: "POST", body: JSON.stringify({ keep: true }), signal: AbortSignal.timeout(50) })).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    release();
    await submitted;
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
    expect(host.store.thread(threadId)!.fresh_opt_out ?? null).toBeNull();
    expect(host.ledger.timeline(threadId).some((e: any) => e.kind === "fresh-keep")).toBe(false);
  });

  it("requires the token on everything except /health", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/snapshot`)).status).toBe(401);
    expect((await fetch(`${base}/snapshot`, { headers: { authorization: "Bearer nope-token" } })).status).toBe(401);
  });

  it("refuses requests whose Host is not loopback", async () => {
    const { base } = await start();
    // fetch drops a custom Host header, so use node:http directly.
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/health`, { headers: { host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("applies commands and maps rejections to status codes", async () => {
    const { call } = await start();
    const ok = await call("/commands", { method: "POST", body: JSON.stringify({ type: "submit", commandId: "c1", text: "hi", cwd: "/r", provider: "fake" }) });
    const body = await ok.json();
    expect(body.ok).toBe(true);
    const detail = await (await call(`/threads/${body.result.threadId}`)).json();
    expect(detail.messages.map((m: any) => m.text)).toEqual(["hi"]);
    const missing = await call("/commands", { method: "POST", body: JSON.stringify({ type: "stop", commandId: "c2", threadId: "nope" }) });
    expect(missing.status).toBe(404);
  });

  it("answers a malformed body with 400, not 500", async () => {
    const { call } = await start();
    const res = await call("/commands", { method: "POST", body: "{not json" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid");
  });

  it("sends subscribers a tombstone when a thread is deleted", async () => {
    const { call } = await start();
    const created = await (await call("/commands", { method: "POST", body: JSON.stringify({ type: "submit", commandId: "c1", text: "hi", cwd: "/r", provider: "fake" }) })).json();
    const threadId = created.result.threadId;
    const abort = new AbortController();
    const res = await call("/events", { signal: abort.signal });
    const framesP = readFrames(res, 2, abort);
    await new Promise((r) => setTimeout(r, 20));
    await call("/commands", { method: "POST", body: JSON.stringify({ type: "delete", commandId: "c2", threadId }) });
    const frames = await framesP;
    expect(frames[1]).toMatchObject({ event: "change", data: { threadId, entity: "thread", data: null } });
  });

  it("sends a snapshot to a fresh subscriber, then live changes", async () => {
    const { call, runtime } = await start();
    await call("/commands", { method: "POST", body: JSON.stringify({ type: "submit", commandId: "c1", text: "hi", cwd: "/r", provider: "fake" }) });
    const abort = new AbortController();
    const res = await call("/events", { signal: abort.signal });
    const framesP = readFrames(res, 3, abort);
    await new Promise((r) => setTimeout(r, 20));
    runtime.last.complete("answer");
    const frames = await framesP;
    expect(frames[0]!.event).toBe("snapshot");
    expect(frames[0]!.data.threads).toHaveLength(1);
    expect(frames.slice(1).every((f) => f.event === "change")).toBe(true);
    expect(Number(frames[1]!.id)).toBeGreaterThan(frames[0]!.data.seq);
  });

  it("resumes from a sequence number without gaps or duplicates", async () => {
    const { call, store } = await start();
    await call("/commands", { method: "POST", body: JSON.stringify({ type: "submit", commandId: "c1", text: "hi", cwd: "/r", provider: "fake" }) });
    const after = 2;
    const expected = store.changesAfter(after, 100).map((c) => c.seq);
    const abort = new AbortController();
    const res = await call(`/events?after=${after}`, { signal: abort.signal });
    const frames = await readFrames(res, expected.length, abort);
    expect(frames.map((f) => Number(f.id))).toEqual(expected);
  });

  it("falls back to a snapshot when the replay would be too long", async () => {
    const { call } = await start({ maxReplay: 2 });
    await call("/commands", { method: "POST", body: JSON.stringify({ type: "submit", commandId: "c1", text: "hi", cwd: "/r", provider: "fake" }) });
    const abort = new AbortController();
    const res = await call(`/events?after=0`, { signal: abort.signal });
    const [first] = await readFrames(res, 1, abort);
    expect(first!.event).toBe("snapshot");
  });
});
