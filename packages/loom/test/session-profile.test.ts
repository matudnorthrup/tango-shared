import { describe, it, expect } from "vitest";
import { LoomStore } from "../src/store.js";
import { LoomHost } from "../src/host.js";
import { FakeRuntime } from "./fake-runtime.js";
import { profileHash, redactProfile, sessionHash, validSessionProfile } from "../src/session-profile.js";
const flush = () => new Promise(r => setTimeout(r, 15));

describe("session profiles", () => {
  it("persists kind/context and replaces sessions only for changed profiles at a safe point", async () => {
    const store = new LoomStore(":memory:");
    const runtime = new FakeRuntime(store);
    const host = new LoomHost(store, { fake: runtime });
    const session = { system: "persona", env: { A: "one", B: "two" } };
    const first = await host.execute({ type: "submit", commandId: "one", provider: "fake", cwd: "/repo", text: "hello", context: "private context", kind: "tango-agent", session });
    await flush();
    const old = runtime.last;
    expect(old.options.session).toEqual(session);
    expect(old.turns[0].text).toBe("private context\n\nhello");
    expect(store.messages(first.threadId!).find(m => m.role === "user")?.text).toBe("hello");
    expect(store.run(first.runId!)?.context).toBe("private context");
    expect(store.thread(first.threadId!)?.kind).toBe("tango-agent");
    old.emit({ type: "session.native", nativeSessionId: "native-one" });
    old.complete();
    await flush();
    await host.execute({ type: "submit", commandId: "two", threadId: first.threadId, text: "again", session: { env: { B: "two", A: "one" }, system: "persona" } });
    await flush();
    expect(runtime.sessions).toHaveLength(1);
    await host.execute({ type: "submit", commandId: "three", threadId: first.threadId, text: "new", session: { system: "changed" } });
    await flush();
    expect(old.closed).toBe(false);
    old.complete();
    await flush();
    expect(old.closed).toBe(true);
    expect(runtime.sessions).toHaveLength(2);
    expect(runtime.last.options).toMatchObject({ nativeSessionId: "native-one", session: { system: "changed" } });
    expect(runtime.last.turns[0].text).toBe("new");
    await host.closeAll();
    store.close();
  });
  it("reopens a thread that becomes its space's default, so it gets the default's instructions", async () => {
    const store = new LoomStore(":memory:");
    const runtime = new FakeRuntime(store);
    const host = new LoomHost(store, { fake: runtime });
    const first = await host.execute({ type: "submit", commandId: "one", provider: "fake", cwd: "/repo", text: "hello" });
    await flush();
    runtime.last.emit({ type: "session.native", nativeSessionId: "native-one" });
    runtime.last.complete();
    await flush();
    await host.execute({ type: "role", commandId: "role", threadId: first.threadId!, role: "default" });
    await host.execute({ type: "submit", commandId: "two", threadId: first.threadId, text: "route this" });
    await flush();
    expect(runtime.sessions).toHaveLength(2);
    expect(runtime.last.options).toMatchObject({ nativeSessionId: "native-one", role: "default" });
    expect(runtime.last.turns[0].text).toBe("route this");
    await host.closeAll();
    store.close();
  });
  it("does not resend context when retrying a run after an attempt", async () => {
    const store = new LoomStore(":memory:");
    const runtime = new FakeRuntime(store);
    const host = new LoomHost(store, { fake: runtime });
    const first = await host.execute({ type: "submit", commandId: "context", provider: "fake", cwd: "/repo", text: "hello", context: "once-only" });
    await flush();
    runtime.last.complete();
    await flush();
    store.tx(() => store.updateRun(first.runId!, { status: "queued" }));
    await host.execute({ type: "submit", commandId: "kick", threadId: first.threadId, text: "later" });
    await flush();
    expect(runtime.last.turns[1].text).not.toContain("once-only");
    expect(runtime.last.turns[1].text).not.toContain("hello");
    await host.closeAll();
    store.close();
  });
  it("refuses invalid profiles without echoing values", async () => {
    const store = new LoomStore(":memory:");
    const host = new LoomHost(store, { fake: new FakeRuntime(store) });
    const invalid = [{ loomTools: "false" },{ unknown: "sentinel-secret" }, { env: { A: 3 } }, { mcpServers: { a: {} } }, { mcpServers: { a: { type: "http" } } }, { tools: "all" }, { settingSources: ["other"] }, { mcpServers: { a: { command: "x", unknown: "sentinel-secret" } } }];
    for (const [i, session] of invalid.entries()) {
      expect(validSessionProfile(session)).toBe(false);
      await expect(host.execute({ type: "submit", commandId: String(i), cwd: "/repo", provider: "fake", text: "go", session: session as never })).rejects.toMatchObject({ code: "invalid", message: "Invalid session profile" });
    }
    expect(store.threads()).toHaveLength(0);
    expect(redactProfile("env-secret header-secret mcp-secret", { env: { API_KEY: "env-secret" }, mcpServers: { a: { command: "x", env: { SERVICE_TOKEN: "mcp-secret" } }, b: { type: "http", url: "https://example.test", headers: { Authorization: "header-secret" } } } })).toBe("[REDACTED] [REDACTED] [REDACTED]");
    // Ordinary agent env survives in replies (live 10/17: a tool name came out as [REDACTED]).
    expect(redactProfile("charlie used location_read", { env: { WORKER_ID: "charlie" }, mcpServers: { location: { command: "node", env: { TANGO_MCP_SERVER: "location", WORKER_ID: "charlie" } } } })).toBe("charlie used location_read");
    // A long token-shaped value is hidden whatever its key.
    expect(redactProfile("x sk_live_abcdefghijklmnopqrstuvwx y", { env: { CONFIG: "sk_live_abcdefghijklmnopqrstuvwx" } })).toBe("x [REDACTED] y");
    expect(profileHash({ loomTools: false })).not.toBe(profileHash());
    expect(profileHash({ loomTools: false })).not.toBe(profileHash({ loomTools: true }));
    expect(profileHash({ env: { A: "a", B: "b" } })).toBe(profileHash({ env: { B: "b", A: "a" } }));
    // Instruction-bearing roles each reopen the host so no previous role's guidance survives.
    expect(sessionHash({ model: "m" }, "interactive")).toBe(profileHash({ model: "m" }));
    expect(new Set(["default", "worker", "ops", "interactive"].map(role => sessionHash({ model: "m" }, role))).size).toBe(4);
    await host.closeAll();
    store.close();
  });
});

it("thread payloads never carry the session profile, only its hash (Codex review on #711)", async () => {
  const store = new LoomStore(":memory:");
  const host = new LoomHost(store, { fake: new FakeRuntime(store) });
  const r = await host.execute({ type: "submit", commandId: "s", text: "hi", cwd: "/repo", provider: "fake", session: { env: { API_TOKEN: "sentinel-payload-secret" } } } as never);
  const payload = JSON.stringify([host.snapshot(), host.entity("thread", r.threadId!)]);
  expect(payload).not.toContain("sentinel-payload-secret");
  expect(payload).toContain("session_profile_hash");
  await host.closeAll(); store.close();
});

it('refuses trigger registration for a thread without Loom tools', async () => {
  const store = new LoomStore(":memory:");
  const host = new LoomHost(store, { fake: new FakeRuntime(store) });
  try {
    const result = await host.execute({ type: "submit", commandId: "isolated", cwd: "/sandbox", provider: "fake", text: "go", session: { loomTools: false } });
    for (const kind of ["time", "command"]) {
      await expect(host.execute({ type: "trigger.create", commandId: kind, threadId: result.threadId!, kind, spec: { afterMinutes: 1, command: "echo unsafe" }, note: "wake" })).rejects.toMatchObject({ code: "invalid", message: "Loom triggers are disabled for this thread" });
    }
  } finally { await host.closeAll(); store.close(); }
});
