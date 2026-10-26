import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRuntime, STARTUP_LIMITS, RESUME_RETRIES, codexAccountEnv, codexFailure } from "../src/codex/codex-runtime.js";
import type { SessionProfile } from "../src/session-profile.js";
import type { OpenSessionOptions, RuntimeEvent, RuntimeSession } from "../src/runtime.js";

const fixture = fileURLToPath(new URL("./fixtures/codex-app-server.mjs", import.meta.url));
const sessions: RuntimeSession[] = [], dirs: string[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map(s => s.close())); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const wait = async (events: RuntimeEvent[], type: RuntimeEvent["type"], count = 1) => vi.waitFor(() => expect(events.filter(e => e.type === type)).toHaveLength(count));
async function setup(nativeSessionId: string | null = null, model = "gpt-test", profile: SessionProfile = {}, mode?: OpenSessionOptions["worktreeMode"]) {
  const dir = mkdtempSync(join(tmpdir(), "loom-codex-")); dirs.push(dir);
  const record = join(dir, "record");
  const events: RuntimeEvent[] = [];
  const ledger = { recordSpawn: vi.fn(), forgetSpawn: vi.fn() }, carry = vi.fn(async () => "carried state");
  const runtime = new CodexRuntime({ accounts: [{ name: "main", home: dir }], defaultAccount: "main", command: process.execPath, args: [fixture], ledger, carry });
  const session = await runtime.open({ threadId: "thread", cwd: dir, kind: "coding", worktreeMode: mode, account: "main", nativeSessionId, role: "worker", session: { model, system: "profile instructions", ...profile, env: { FAKE_RECORD: record, OPENAI_API_KEY: "wrong-key", CODEX_API_KEY: "wrong-key", CODEX_HOME: "/wrong-home", HOME: "/wrong-home" } } }, e => events.push(e)); sessions.push(session);
  const messages = () => readFileSync(record, "utf8").trim().split("\n").map(l => JSON.parse(l));
  return { session, events, ledger, carry, messages, dir };
}

describe("Codex app-server 0.163.0", () => {
  it.each([['commentary', 'note'], ['partial_answer', 'answer'], ['final_answer', 'answer'], [null, undefined]])('maps phase %s to %s', async (phase, expected) => {
    const { session, events } = await setup();
    session.startTurn({ runId: 'phase', text: `phase:${JSON.stringify(phase)}` });
    await wait(events, 'turn.completed');
    const message = events.find(e => e.type === 'message.completed');
    expect(message && 'phase' in message ? message.phase : undefined).toBe(expected);
  });
  it("initializes a new session, streams a turn and tools, and prepends carry exactly once", async () => {
    const { session, events, messages, ledger, carry, dir } = await setup();
    expect(events).toContainEqual({ type: "session.native", nativeSessionId: "native-new" });
    expect(messages().find(m => m.method === "thread/start").params).toMatchObject({ cwd: dir, approvalPolicy: "never", sandbox: "danger-full-access", model: "gpt-test", developerInstructions: expect.stringContaining("profile instructions") });
    expect(messages().find(m => m.env).env).toEqual({ CODEX_HOME: dir, HOME: process.env.HOME });
    expect(ledger.recordSpawn).toHaveBeenCalledTimes(1); expect(carry).toHaveBeenCalledWith("thread");
    session.startTurn({ runId: "one", text: "hello", images: [{ mimeType: "image/png", data: "AQ==" }] });
    await wait(events, "turn.completed");
    expect(events.filter(e => e.type === "message.delta")).toEqual([{ type: "message.delta", runId: "one", text: "o" }, { type: "message.delta", runId: "one", text: "k" }]);
    expect(events).toContainEqual({ type: "message.completed", runId: "one", text: "ok" });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool.updated", name: "commandExecution", status: "running" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool.updated", name: "commandExecution", status: "completed", output: "scratch" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "context.observed", context: 40, cacheRead: 10 }));
    session.startTurn({ runId: "two", text: "again" }); await wait(events, "turn.completed", 2);
    const turns = messages().filter(m => m.method === "turn/start");
    expect(turns[0].params.input).toEqual([{ type: "text", text: "carried state\n\nhello", text_elements: [] }, { type: "image", url: "data:image/png;base64,AQ==" }]);
    expect(turns[1].params.input[0].text).toBe("again");
  });
  it.each(["/workspace/example/foo.ts is failing", "/tmp/x", "/ hi"])("keeps resource identity for ordinary text %s", async text => {
    const { session, events, messages } = await setup();
    const runId = "00000000-0000-0000-0000-000000000001";
    session.startTurn({ runId, text }); await wait(events, "turn.completed");
    const input = messages().find(m => m.method === "turn/start").params.input[0].text;
    expect(input).toContain(text); expect(input).toContain(`LOOM_RUN_ID=${runId}`);
  });
  it.each(["/compact", "/code-review", "/skill argument", "/anthropic-skills:docs x", "/code-review:code-review", "/Compact x", "/mcp__srv__p"])("preserves slash command %s and retains carry for the next ordinary turn", async text => {
    const { session, events, messages } = await setup();
    session.startTurn({ runId: "00000000-0000-0000-0000-000000000001", text });
    await wait(events, "turn.completed");
    session.startTurn({ runId: "00000000-0000-0000-0000-000000000002", text: "continue" });
    await wait(events, "turn.completed", 2);
    const turns = messages().filter(m => m.method === "turn/start");
    expect(turns[0].params.input[0].text).toBe(text);
    expect(turns[1].params.input[0].text).toContain("carried state");
    expect(turns[1].params.input[0].text).toContain("LOOM_RUN_ID=00000000-0000-0000-0000-000000000002");
  });
  it("supplies each exact run identity and omits it for tools-off sessions", async () => {
    for (const loomTools of [true, false]) {
      const { session, events, messages } = await setup(null, "gpt-test", { loomTools });
      const first = "00000000-0000-0000-0000-000000000001", second = "00000000-0000-0000-0000-000000000002";
      session.startTurn({ runId: first, text: "hello" }); await wait(events, "turn.completed");
      session.startTurn({ runId: second, text: "again" }); await wait(events, "turn.completed", 2);
      const turns = messages().filter(m => m.method === "turn/start");
      expect(turns[0].params.input[0].text.includes(`LOOM_RUN_ID=${first}`)).toBe(loomTools);
      expect(turns[1].params.input[0].text.includes(`LOOM_RUN_ID=${second}`)).toBe(loomTools);
      expect(turns[1].params.input[0].text).not.toContain(first);
    }
  });
  it("reports subagents and their own spawns as background tasks until they end, even after the turn, and clears them when Codex exits", async () => {
    const { session, events } = await setup();
    session.startTurn({ runId: "one", text: "spawn subagent" });
    await wait(events, "background.changed", 6);
    const tasks = events.flatMap(e => e.type === "background.changed" ? [e.tasks.map(t => t.description)] : []);
    expect(tasks).toEqual([["review"], ["review", "tests"], ["review", "tests", "deep"], ["tests", "deep"], ["tests"], []]);
    expect(events.find(e => e.type === "background.changed")).toEqual({ type: "background.changed", tasks: [{ id: "child-1", kind: "local_agent", description: "review" }] });
    expect(events.filter(e => e.type === "turn.completed")).toHaveLength(1);
    session.startTurn({ runId: "two", text: "subagent crash" });
    await wait(events, "session.ended");
    expect(events.filter(e => e.type === "background.changed").slice(-1)[0]).toEqual({ type: "background.changed", tasks: [] });
  });
  it("configures Loom and stdio profile servers, and omits Loom's tools, guidance and carry when disabled", async () => {
    const normal = await setup(null, "gpt-test", { mcpServers: { extra: { command: "example-mcp", args: ["--example"], env: { EXAMPLE_TOKEN: "s3cret" } } } });
    expect(normal.messages().find(m => m.method === "thread/start").params.developerInstructions).toContain("Implement and verify your own work");
    const config = normal.messages().find(m => m.env).argv.join(" ");
    expect(config).not.toContain("s3cret"); expect(config).not.toContain("env_vars"); expect(config).toMatch(/mcp-env\.ts","[^"]+\.json","example-mcp","--example"/);
    expect(normal.messages().find(m => m.env).token).toBeUndefined();
    expect(config).toContain('"LOOM_THREAD_ID"="thread"'); expect(config).toContain("example-mcp");
    const isolated = await setup(null, "gpt-test", { loomTools: false });
    expect(isolated.carry).not.toHaveBeenCalled();
    expect(isolated.messages().find(m => m.env).argv.join(" ")).toContain("mcp_servers={}");
    expect(isolated.messages().find(m => m.method === "thread/start").params.developerInstructions).toBe("profile instructions");
  });
  it("keeps configured developer instructions, forwards effort and refuses no-tools profiles", async () => {
    vi.stubEnv("FAKE_DEV_INSTRUCTIONS", "configured rules");
    const { messages } = await setup(null, "gpt-test", { effort: "max" });
    const start = messages().find(m => m.method === "thread/start").params;
    expect(start.developerInstructions).toMatch(/^configured rules\n\n[\s\S]*profile instructions$/);
    expect(start.config).toEqual({ model_reasoning_effort: "xhigh" });
    vi.unstubAllEnvs();
    const bare = await setup(null, "gpt-test", { loomTools: false, system: undefined });
    expect(bare.messages().find(m => m.method === "thread/start").params).not.toHaveProperty("developerInstructions");
    await expect(setup(null, "gpt-test", { tools: "none" })).rejects.toThrow(/tools/);
  });
  it("resumes the native thread and lets the account choose its default model for Claude aliases", async () => {
    const { events, messages } = await setup("existing", "sonnet");
    expect(events).toContainEqual({ type: "session.native", nativeSessionId: "existing" });
    expect(messages().find(m => m.method === "thread/resume").params.threadId).toBe("existing");
    expect(messages().find(m => m.method === "thread/resume").params.model).toBeUndefined();
  });
  it("starts a new Codex thread when the native one lives under another account's CODEX_HOME", async () => {
    const { events, messages } = await setup("other-account");
    expect(messages().map(m => m.method).filter(m => m?.startsWith("thread/"))).toEqual(["thread/resume", "thread/start"]);
    expect(events).toContainEqual({ type: "session.native", nativeSessionId: "native-new" });
  });
  it("retries a resume that fails for a passing reason and keeps the native thread", async () => {
    RESUME_RETRIES.splice(0, RESUME_RETRIES.length, 1, 1);
    const { events, messages } = await setup("flaky");
    expect(messages().filter(m => m.method === "thread/resume")).toHaveLength(2);
    expect(messages().some(m => m.method === "thread/start")).toBe(false);
    expect(events).toContainEqual({ type: "session.native", nativeSessionId: "flaky" });
    await expect(setup("broken")).rejects.toThrow(/state db busy/);
  });
  it("gives up a stalled resume inside the host's startup deadline", async () => {
    const budget = STARTUP_LIMITS.budgetMs; STARTUP_LIMITS.budgetMs = 300;
    const started = Date.now();
    try { await expect(setup("stalled")).rejects.toThrow(/thread\/resume timed out/); }
    finally { STARTUP_LIMITS.budgetMs = budget; }
    expect(Date.now() - started).toBeLessThan(5000);
  });
  it("drops a carry that would outlast the open instead of failing it", async () => {
    const budget = STARTUP_LIMITS.budgetMs; STARTUP_LIMITS.budgetMs = 500;
    try {
      const dir = mkdtempSync(join(tmpdir(), "loom-codex-")); dirs.push(dir);
      const runtime = new CodexRuntime({ accounts: [{ name: "main", home: dir }], defaultAccount: "main", command: process.execPath, args: [fixture], carry: () => new Promise(() => {}) });
      const session = await runtime.open({ threadId: "thread", cwd: dir, account: "main", nativeSessionId: null, role: "worker", session: {} }, () => {}); sessions.push(session);
    } finally { STARTUP_LIMITS.budgetMs = budget; }
  });
  it("rejects without a window reset when credits run out but no window is full", async () => {
    const { session, events } = await setup(); session.startTurn({ runId: "run", text: "credits" }); await wait(events, "turn.failed");
    expect(events.filter(e => e.type === "usage.observed")).toEqual([
      { type: "usage.observed", utilization: 0.2, resetsAt: 1800000000000, window: "five_hour" },
      { type: "usage.observed", utilization: 0.4, resetsAt: 1900000000000, window: "seven_day" },
      { type: "usage.observed", status: "rejected", resetsAt: undefined },
    ]);
    const failed = events.find(e => e.type === "turn.failed") as Extract<RuntimeEvent, { type: "turn.failed" }>;
    expect(failed.failure.kind).toBe("usage_limit"); expect(failed.failure.resetAt).toBeUndefined();
  });
  it("refuses a remote MCP server it can't hand to Codex", async () => {
    await expect(setup(null, "gpt-test", { mcpServers: { docs: { type: "http", url: "https://example.test/mcp" } } })).rejects.toThrow(/remote MCP server "docs"/);
  });
  it("hands an MCP server its env through a private file only it reads, removed when the session ends", async () => {
    const { session, messages } = await setup(null, "gpt-test", { mcpServers: { extra: { command: process.execPath, args: ["-e", "process.stdout.write(process.env.OPENAI_API_KEY)"], env: { OPENAI_API_KEY: "server-only" } } } });
    expect(messages().find(m => m.env).env.OPENAI_API_KEY).toBeUndefined();
    const servers = JSON.parse(messages().find(m => m.env).argv.find((a: string) => a.startsWith("mcp_servers=")).slice("mcp_servers=".length).replace(/"=/g, '":'));
    const args: string[] = servers.extra.args;
    const file = args.find(a => a.endsWith(".json"));
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
    expect(execFileSync(process.execPath, args, { encoding: "utf8" })).toBe("server-only");
    await session.close();
    expect(existsSync(file)).toBe(false);
  });
  it("cools down only the window that is full when the other still has room", async () => {
    const { session, events } = await setup(); session.startTurn({ runId: "run", text: "short-full" }); await wait(events, "turn.failed");
    expect(events.filter(e => e.type === "usage.observed")).toEqual([
      { type: "usage.observed", utilization: 1, resetsAt: 1800000000000, window: "five_hour", status: "rejected" },
      { type: "usage.observed", utilization: 0.4, resetsAt: 1900000000000, window: "seven_day" },
      { type: "usage.observed", status: "rejected", resetsAt: 1800000000000 },
    ]);
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.failed", failure: expect.objectContaining({ resetAt: 1800000000000 }) }));
  });
  it("reports rate-limit failures with the reset from rate-limit notifications", async () => {
    const { session, events } = await setup(); session.startTurn({ runId: "run", text: "limit" }); await wait(events, "turn.failed");
    expect(events).toContainEqual({ type: "turn.failed", runId: "run", failure: { kind: "usage_limit", message: "Usage limit exceeded", resetAt: 1900000000000 } });
    expect(events).toContainEqual({ type: "usage.observed", utilization: 1, resetsAt: 1900000000000, window: "five_hour", status: "rejected" });
  });
  it("steers and interrupts an active turn, even while turn/start is pending", async () => {
    const { session, events, messages } = await setup(); session.startTurn({ runId: "run", text: "wait-for-interrupt" });
    await session.inject!("steer"); await session.interrupt(); await wait(events, "turn.failed");
    expect(messages().find(m => m.method === "turn/steer").params.expectedTurnId).toBe("turn-1");
    expect(messages().find(m => m.method === "turn/interrupt").params.turnId).toBe("turn-1");
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.failed", failure: { kind: "interrupted", message: "Interrupted" } }));
  });
  it("ends the session and fails the active run when the child exits", async () => {
    const { session, events } = await setup(); session.startTurn({ runId: "run", text: "exit-child" }); await wait(events, "session.ended");
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.failed", failure: expect.objectContaining({ kind: "crashed" }) }));
  });
  it("keeps HOME, sets CODEX_HOME and strips credential overrides including profile env", () => {
    expect(codexAccountEnv({ name: "a", home: "/account" }, { HOME: "/home", CODEX_HOME: "/wrong", OPENAI_API_KEY: "bad", CODEX_API_KEY: "bad", OPENAI_BASE_URL: "bad", PATH: "/bin" })).toEqual({ HOME: "/home", CODEX_HOME: "/account", PATH: "/bin" });
    expect(codexFailure({ message: "usage limit", data: { resets_at: 1900000000 } }).resetAt).toBe(1900000000000);
    expect(codexFailure({ message: "unauthorized" }).kind).toBe("auth");
    expect(codexFailure({ message: "error", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } }).kind).toBe("overloaded");
  });
});

it('starts and resumes probes read-only without project docs or configured developer guidance', async () => {
  const { probeProfile, DEFAULT_SCHEMA, PROBE_PROMPT } = await import('../src/fan-outs.js');
  vi.stubEnv('FAKE_DEV_INSTRUCTIONS', 'full worker guidance');
  for (const native of [null, 'existing']) {
    const s = await setup(native, 'gpt-test', probeProfile(DEFAULT_SCHEMA));
    const params = s.messages().find(m => m.method === (native ? 'thread/resume' : 'thread/start')).params;
    expect(params).toMatchObject({ sandbox: 'read-only', config: { project_doc_max_bytes: 0 }, developerInstructions: expect.stringContaining(PROBE_PROMPT) });
    expect(params.developerInstructions).not.toContain('full worker guidance');
    expect(s.messages().some(m => m.method === 'config/read')).toBe(false);
  }
});


describe("Codex Auto sandbox promotion", () => {
  it.each(["commandExecution", "fileChange"])("denies %s approvals before signaling once, with checkout read-only", async method => {
    const s = await setup(null, "gpt-test", {}, "auto");
    expect(s.messages().find(m => m.method === "thread/start").params).toMatchObject({ sandbox: "read-only", approvalPolicy: "on-request" });
    s.session.startTurn({ runId: "edit", text: `approval-${method}` });
    await wait(s.events, "worktree.promote");
    await vi.waitFor(() => expect(s.messages().filter(m => String(m.id).startsWith("approval-")).map(m => m.result)).toEqual([{ decision: "decline" }, { decision: "decline" }]));
    expect(s.events.filter(e => e.type === "worktree.promote")).toEqual([{ type: "worktree.promote", runId: "edit" }]);
    expect(s.events).toContainEqual({ type: "message.completed", runId: "edit", text: "Moving this thread into its own worktree; your next session continues there." });
  });
  it("accepts Loom's own MCP tool approvals without promoting, and declines other servers", async () => {
    const s = await setup(null, "gpt-test", {}, "auto");
    s.session.startTurn({ runId: "tools", text: "elicit-tools" });
    await vi.waitFor(() => expect(Object.fromEntries(s.messages().filter(m => String(m.id).startsWith("elicit-")).map(m => [m.id, m.result.action]))).toEqual({ "elicit-loom": "accept", "elicit-other": "decline" }));
    expect(s.events.some(e => e.type === "worktree.promote")).toBe(false);
  });
  it("keeps Auto read-only and denies requests when promotion is off", async () => {
    vi.stubEnv("LOOM_AUTO_PROMOTE", "off");
    const s = await setup(null, "gpt-test", {}, "auto");
    expect(s.messages().find(m => m.method === "thread/start").params).toMatchObject({ sandbox: "read-only", approvalPolicy: "never" });
    s.session.startTurn({ runId: "edit", text: "approval-fileChange" });
    await vi.waitFor(() => expect(s.messages().filter(m => String(m.id).startsWith("approval-"))).toHaveLength(2));
    expect(s.events.some(e => e.type === "worktree.promote")).toBe(false);
  });
  it("opens the promoted worktree with the normal sandbox and does not promote twice", async () => {
    const s = await setup(null, "gpt-test", {}, "worktree");
    expect(s.messages().find(m => m.method === "thread/start").params).toMatchObject({ sandbox: "danger-full-access", approvalPolicy: "never" });
    s.session.startTurn({ runId: "edit", text: "approval-commandExecution" });
    await vi.waitFor(() => expect(s.messages().filter(m => String(m.id).startsWith("approval-"))).toHaveLength(2));
    expect(s.events.some(e => e.type === "worktree.promote")).toBe(false);
  });
});
