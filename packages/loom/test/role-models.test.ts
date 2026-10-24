import { describe, it, expect } from "vitest";
import { LoomStore } from "../src/store.js";
import { LoomHost } from "../src/host.js";
import { FakeRuntime } from "./fake-runtime.js";

const roleModels = { worker: "sonnet", ops: "haiku" };
const setup = () => {
  const store = new LoomStore(":memory:"), runtime = new FakeRuntime(store);
  return { store, runtime, host: new LoomHost(store, { fake: runtime }, { roleModels }) };
};
const model = (store: LoomStore, id: string) => { const p = store.thread(id)!.session_profile; return p ? JSON.parse(p).model : undefined; };

describe("models by role", () => {
  it("starts a worker on its role's model and an interactive thread on the harness default", async () => {
    const { store, runtime, host } = setup();
    try {
      const w = await host.execute({ type: "submit", commandId: "w", cwd: "/tmp", provider: "fake", text: "build", role: "worker" });
      expect(model(store, w.threadId!)).toBe("sonnet");
      expect(runtime.last.options.session?.model).toBe("sonnet");
      const i = await host.execute({ type: "submit", commandId: "i", cwd: "/tmp", provider: "fake", text: "hi" });
      expect(model(store, i.threadId!)).toBeUndefined();
    } finally { await host.closeAll(); store.close(); }
  });

  it("keeps a thread's own model over its role's, and a later profile without a model keeps it", async () => {
    const { store, host } = setup();
    try {
      const w = await host.execute({ type: "submit", commandId: "w", cwd: "/tmp", provider: "fake", text: "hard one", role: "worker", session: { model: "opus" } });
      expect(model(store, w.threadId!)).toBe("opus");
      await host.execute({ type: "submit", commandId: "w2", threadId: w.threadId!, text: "more", session: { effort: "high" } });
      expect(model(store, w.threadId!)).toBe("opus");
    } finally { await host.closeAll(); store.close(); }
  });

  it("uses the role a thread has when its first turn starts, but never moves a thread that has run (Codex review on #814)", async () => {
    const { store, runtime, host } = setup();
    try {
      const fresh = store.tx(() => store.createThread({ kind: "coding", cwd: "/tmp", provider: "fake", role: "ops" }));
      store.tx(() => { store.createRun(fresh.id, "user", "queued while Loom was busy"); });
      await host.execute({ type: "role", commandId: "r1", threadId: fresh.id, role: "worker" });
      expect(model(store, fresh.id)).toBeUndefined();
      await host.kick(fresh.id);
      expect(model(store, fresh.id)).toBe("sonnet");
      const back = store.tx(() => store.createThread({ kind: "coding", cwd: "/tmp", provider: "fake", role: "worker" }));
      await host.execute({ type: "role", commandId: "r3", threadId: back.id, role: "interactive" });
      store.tx(() => { store.createRun(back.id, "user", "go"); }); await host.kick(back.id);
      expect(model(store, back.id)).toBeUndefined();
      const t = await host.execute({ type: "submit", commandId: "t", cwd: "/tmp", provider: "fake", text: "chat" });
      runtime.last.complete();
      await host.execute({ type: "role", commandId: "r2", threadId: t.threadId!, role: "worker" });
      expect(model(store, t.threadId!)).toBeUndefined();
    } finally { await host.closeAll(); store.close(); }
  });
});

describe("role providers", () => {
  async function scenario(options: { codex?: boolean; usable?: boolean; roleModels?: Record<string, string>; started?: boolean; ran?: boolean; explicit?: boolean; noTools?: boolean; remoteMcp?: boolean; placedOnClaude?: boolean; provider?: string } = {}) {
    const { AccountPool } = await import("../src/pool.js");
    const { ROLE_MODELS } = await import("../src/host.js");
    const store = new LoomStore(":memory:"), claude = new FakeRuntime(), codex = new FakeRuntime();
    const pool = new AccountPool([{ provider: "claude", name: "claude-account" }, { provider: "codex", name: "codex-account" }]);
    if (options.usable === false) pool.coolDown("codex", "codex-account");
    const host = new LoomHost(store, { claude, ...(options.codex === false ? {} : { codex }) }, { pool, roleModels: options.roleModels ?? ROLE_MODELS });
    const thread = store.tx(() => store.createThread({ kind: "coding", cwd: "/tmp", provider: options.provider ?? "claude", account: options.provider === "codex" ? "codex-account" : "claude-account", accounts: options.provider === "codex" ? ["codex-account"] : ["claude-account"], role: "worker" }));
    if (options.started) store.tx(() => store.updateThread(thread.id, { native_session_id: "existing" }));
    if (options.explicit) store.tx(() => store.updateThread(thread.id, { session_profile: JSON.stringify({ model: "opus" }) }));
    if (options.noTools) store.tx(() => store.updateThread(thread.id, { session_profile: JSON.stringify({ tools: "none" }) }));
    if (options.remoteMcp) store.tx(() => store.updateThread(thread.id, { session_profile: JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://example.test/mcp" } } }) }));
    if (options.placedOnClaude) pool.placed("claude", "claude-account");
    if (options.ran) store.tx(() => { const run = store.createRun(thread.id, "user", "earlier"); store.updateRun(run.id, { status: "completed" }); });
    store.tx(() => { store.createRun(thread.id, "user", "build"); });
    try { await host.kick(thread.id); return { thread: store.thread(thread.id)!, opened: codex.sessions.length ? codex.last.options : claude.last.options, pool }; }
    finally { await host.closeAll(); store.close(); }
  }
  it("switches workers to Codex at first dispatch and clears Claude account restrictions", async () => {
    const { thread, opened } = await scenario();
    expect(thread.provider).toBe("codex"); expect(thread.account).toBe("codex-account"); expect(thread.accounts).toBeNull();
    expect(opened.account).toBe("codex-account"); expect(opened.session?.model).toBeUndefined();
  });
  it.each([{ codex: false }, { usable: false }])("falls back to Claude sonnet when Codex is unavailable: %j", async options => {
    const { thread, opened } = await scenario(options);
    expect(thread.provider).toBe("claude"); expect(opened.session?.model).toBe("sonnet"); expect(thread.accounts).toBe('["claude-account"]');
  });
  it("keeps a no-tools worker off Codex, which can't switch its tools off", async () => {
    const { thread, opened } = await scenario({ noTools: true });
    expect(thread.provider).toBe("claude"); expect(opened.session).toMatchObject({ tools: "none", model: "sonnet" });
  });
  it("keeps a worker with a remote MCP server off Codex, which only takes stdio servers", async () => {
    const { thread, opened } = await scenario({ remoteMcp: true });
    expect(thread.provider).toBe("claude"); expect(opened.session).toMatchObject({ model: "sonnet" });
  });
  it("moves the submit's placement to the Codex account it was routed to", async () => {
    const { pool } = await scenario({ placedOnClaude: true });
    expect(pool.score("claude", "claude-account").load).toBe(0);
    expect(pool.score("codex", "codex-account").load).toBeGreaterThan(0.9);
  });
  it("does not switch a resumed thread", async () => {
    const { thread } = await scenario({ started: true }); expect(thread.provider).toBe("claude");
  });
  it("does not switch a thread that has run or has an explicit profile model", async () => {
    expect((await scenario({ ran: true })).thread.provider).toBe("claude");
    const explicit = await scenario({ explicit: true });
    expect(explicit.thread.provider).toBe("claude"); expect(explicit.opened.session?.model).toBe("opus");
  });
  it("can select Claude for an unstarted Codex thread when the role names a Claude model", async () => {
    const { thread, opened } = await scenario({ provider: "codex", roleModels: { worker: "sonnet" } });
    expect(thread.provider).toBe("claude"); expect(thread.accounts).toBeNull(); expect(opened.session?.model).toBe("sonnet");
  });
  it("honors LOOM_ROLE_MODELS' sonnet off switch and explicit Codex models", async () => {
    const { thread, opened } = await scenario({ roleModels: JSON.parse('{"worker":"sonnet"}') });
    expect(thread.provider).toBe("claude"); expect(opened.session?.model).toBe("sonnet");
    const target = await scenario({ roleModels: { worker: "codex:gpt-test" } });
    expect(target.thread.provider).toBe("codex"); expect(target.opened.session?.model).toBe("gpt-test");
  });
});

describe("task tiers", () => {
  it.each([
    { usable: true, expected: "codex", session: { model: "gpt-6.1-sol", effort: "medium" } },
    { usable: false, expected: "claude", session: { model: "sonnet" } },
    { usable: true, noRuntime: true, expected: "claude", session: { model: "sonnet" } },
    { usable: true, noTools: true, expected: "claude", session: { model: "sonnet", tools: "none" } },
    { usable: true, disabled: true, expected: "claude", session: {} },
    { usable: true, explicit: "opus", expected: "claude", session: { model: "opus" } },
    { usable: true, value: "sonnet@high", expected: "claude", session: { model: "sonnet", effort: "high" } },
    { usable: true, tier: "unknown", expected: "codex", session: {} },
    { usable: true, tier: "constructor", expected: "codex", session: {} },
  ])("routes a submitted tier: %j", async options => {
    const { AccountPool } = await import("../src/pool.js");
    const { ROLE_MODELS } = await import("../src/host.js");
    const store = new LoomStore(":memory:"), claude = new FakeRuntime(), codex = new FakeRuntime();
    const pool = new AccountPool([{ provider: "claude", name: "c" }, { provider: "codex", name: "x" }]);
    if (!options.usable) pool.coolDown("codex", "x");
    const host = new LoomHost(store, { claude, ...(options.noRuntime ? {} : { codex }) }, { pool, roleModels: options.disabled ? {} : { ...ROLE_MODELS, ...(options.value ? { qa: options.value } : {}) } });
    try {
      const result = await host.execute({ type: "submit", commandId: "qa", cwd: "/tmp", provider: "claude", role: "worker", tier: options.tier ?? "qa", text: "check", ...(options.explicit ? { session: { model: options.explicit } } : options.noTools ? { session: { tools: "none" } } : {}) });
      const thread = store.thread(result.threadId!)!;
      expect(thread.provider).toBe(options.expected);
      expect(thread.role).toBe("worker");
      expect(JSON.parse(thread.session_profile!)).toMatchObject({ tier: options.tier ?? "qa", ...options.session });
      expect((options.expected === "codex" ? codex : claude).last.options.session).toMatchObject(options.session);
    } finally { await host.closeAll(); store.close(); }
  });

  it.each(["", "QA", "bad_tier", "a".repeat(33), 7])("refuses invalid tier %j", async tier => {
    const { host, store } = setup();
    try {
      await expect(host.execute({ type: "submit", commandId: "bad", cwd: "/tmp", provider: "fake", text: "check", tier: tier as string })).rejects.toMatchObject({ code: "invalid" });
    } finally { await host.closeAll(); store.close(); }
  });
});
