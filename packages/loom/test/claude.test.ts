import { describe, expect, it, vi } from "vitest";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, symlinkSync, writeFileSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountEnv, carryHooks, ClaudeRuntime, compactEnv, DEFAULT_COMPACT_WINDOW, WAKE_TEXT } from "../src/claude/claude-runtime.js";
import { COMPACT_GUIDANCE } from "../src/carry.js";
import { classifyResult } from "../src/claude/failures.js";
import { DEFAULT_ROLE_GUIDANCE } from "../src/claude/loom-tools.js";
import { linkProject, projectSlug } from "../src/claude/project-store.js";
import { LoomHost } from "../src/host.js";
import { LoomStore } from "../src/store.js";
import type { RuntimeEvent } from "../src/runtime.js";

const flush = () => new Promise((r) => setTimeout(r, 5));

describe("Claude project store", () => {
  it("matches Claude Code's folder naming", () => {
    expect(projectSlug("/work/me/scratch/loom/spike-cwd")).toBe("-work-me-scratch-loom-spike-cwd");
    expect(projectSlug("/work/me/.t3/worktrees/tango")).toBe("-work-me--t3-worktrees-tango");
  });

  it("links, adopts and merges without losing history", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-ps-"));
    const shared = join(root, "shared");
    const a = join(root, "acct-a");
    const b = join(root, "acct-b");
    const cwd = "/work/repo";
    const slug = projectSlug(cwd);

    // Account A already has history for this folder: it's adopted into the shared store.
    mkdirSync(join(a, "projects", slug), { recursive: true });
    writeFileSync(join(a, "projects", slug, "s1.jsonl"), "a");
    expect(linkProject(a, shared, cwd)).toBe("adopted");
    expect(lstatSync(join(a, "projects", slug)).isDirectory()).toBe(true);
    expect(readdirSync(join(shared, slug))).toEqual(["s1.jsonl"]);
    expect(linkProject(a, shared, cwd)).toBe("merged");

    // Account B has its own history too: merged in, original kept as a backup.
    mkdirSync(join(b, "projects", slug), { recursive: true });
    writeFileSync(join(b, "projects", slug, "s2.jsonl"), "b");
    writeFileSync(join(b, "projects", slug, "s1.jsonl"), "conflict");
    expect(linkProject(b, shared, cwd, 42)).toBe("merged");
    expect(readdirSync(join(shared, slug))).toContain("s2.jsonl");
    expect([...readdirSync(join(shared, slug)), ...readdirSync(join(b, "projects", slug))]).toContain("s1.jsonl.loom-backup-42");
    expect(lstatSync(join(b, "projects", slug)).isSymbolicLink()).toBe(false);

    // A fresh account just gets the link.
    expect(linkProject(join(root, "acct-c"), shared, cwd)).toBe("linked");
  });
});

describe("Claude project store, existing links and long paths", () => {
  it("adopts history behind an existing link to another folder", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-ps2-"));
    const shared = join(root, "shared");
    const elsewhere = join(root, "elsewhere");
    const acct = join(root, "acct");
    const cwd = "/work/repo2";
    const slug = projectSlug(cwd);
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "old.jsonl"), "history");
    mkdirSync(join(acct, "projects"), { recursive: true });
    symlinkSync(elsewhere, join(acct, "projects", slug));
    expect(linkProject(acct, shared, cwd, 7)).toBe("merged");
    expect(readdirSync(join(shared, slug))).toEqual(["old.jsonl"]);
    expect(readlinkSync(join(acct, "projects", `${slug}.loom-backup-7`))).toBe(elsewhere);
    expect(existsSync(join(elsewhere, "old.jsonl"))).toBe(true);
  });

  it("refuses to open a session whose project path is too long to share", async () => {
    const root = mkdtempSync(join(tmpdir(), "loom-long-"));
    const runtime = new ClaudeRuntime({ accounts: [{ name: "a", configDir: join(root, "a") }], defaultAccount: "a", sharedProjectsDir: join(root, "s"), query: fakeQuery().make });
    await expect(runtime.open({ threadId: "t", cwd: "/" + "x".repeat(250), account: null, nativeSessionId: null }, () => {})).rejects.toThrow(/too long/);
  });
});

describe("account environment", () => {
  it("strips other credentials and parent-session variables, sets the config dir, keeps HOME", () => {
    const env = accountEnv(
      { name: "work", configDir: "/h/.claude-work" },
      { HOME: "/h", PATH: "/bin", ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "x", CLAUDE_CONFIG_DIR: "/other" },
    );
    expect(env).toEqual({ HOME: "/h", PATH: "/bin", CLAUDE_CONFIG_DIR: "/h/.claude-work" });
    expect(accountEnv({ name: "main" }, { HOME: "/h", CLAUDE_CONFIG_DIR: "/x" })).toEqual({ HOME: "/h" });
    // Another model provider can't be selected; the cloud credentials agents' tools use stay.
    expect(
      accountEnv(
        { name: "main" },
        { HOME: "/h", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_BASE_URL: "https://proxy", ANTHROPIC_VERTEX_PROJECT_ID: "p", AWS_BEARER_TOKEN_BEDROCK: "b", AWS_PROFILE: "dev", GOOGLE_APPLICATION_CREDENTIALS: "/g.json" },
      ),
    ).toEqual({ HOME: "/h", AWS_PROFILE: "dev", GOOGLE_APPLICATION_CREDENTIALS: "/g.json" });
  });
});

describe("failure classification", () => {
  it("sorts failures, including errors reported as success", () => {
    expect(classifyResult({ subtype: "success", is_error: false, result: "hi" })).toBeNull();
    expect(classifyResult({ subtype: "success", is_error: true, result: "Not logged in · Please run /login" })!.kind).toBe("auth");
    expect(classifyResult({ subtype: "error", is_error: true, result: "Claude Code process exited with code 1\n[ACTION REQUIRED] An update to our Consumer Terms and Privacy Policy has taken effect on October 8, 2025. You must run `claude` to review the updated terms." })!.kind).toBe("auth");
    const limit = classifyResult({ subtype: "success", is_error: true, result: "x", terminal_reason: "blocking_limit" }, { status: "rejected", resetsAt: 1_800_000_000 });
    expect(limit).toMatchObject({ kind: "usage_limit", resetAt: 1_800_000_000_000 });
    expect(classifyResult({ subtype: "success", is_error: true, api_error_status: 529, result: "" })!.kind).toBe("overloaded");
    expect(classifyResult({ subtype: "error_during_execution", errors: ["boom"] })!.kind).toBe("other");
  });
});

/** A stand-in for the SDK's Query: the test pushes SDK messages; canUseTool is captured. */
function fakeQuery() {
  const out: any[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const state: { prompts: any[]; options: any; interrupted: number; closed: boolean } = { prompts: [], options: null, interrupted: 0, closed: false };
  const make = (params: { prompt: AsyncIterable<any>; options?: any }) => {
    state.options = params.options;
    void (async () => {
      for await (const p of params.prompt) state.prompts.push(p);
    })();
    const iter = {
      async next() {
        for (;;) {
          if (out.length) return { value: out.shift(), done: false };
          if (ended) return { value: undefined, done: true };
          await new Promise<void>((r) => (wake = r));
        }
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      async interrupt() {
        state.interrupted++;
      },
      close() {
        state.closed = true;
        ended = true;
        wake?.();
      },
    };
    return iter as any;
  };
  const send = (m: any) => {
    out.push(m);
    wake?.();
  };
  const end = () => {
    ended = true;
    wake?.();
  };
  return { make, send, end, state };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "loom-claude-"));
  const fake = fakeQuery();
  const runtime = new ClaudeRuntime({
    accounts: [{ name: "a", configDir: join(root, "a") }, { name: "b", configDir: join(root, "b") }],
    defaultAccount: "a",
    sharedProjectsDir: join(root, "shared"),
    query: fake.make,
  });
  const store = new LoomStore(":memory:");
  const host = new LoomHost(store, { claude: runtime });
  return { fake, host, store, root };
}

describe("ClaudeRuntime through the host", () => {
  it.each(['mcp__loom__handoff', 'loom.wait_for', 'mcp__loom__decision_check'])("labels text promptly, preserving answers around %s", async bookkeeping => {
    const { fake, host, store } = setup();
    try {
      const result = await host.execute({ type: "submit", commandId: "phases", text: "Explain", cwd: "/work/repo", provider: "claude" });
      await flush();
      const text = (value: string, parent_tool_use_id: string | null = null) => fake.send({ type: "assistant", parent_tool_use_id, message: { content: [{ type: "text", text: value }] } });
      const tool = (name: string) => fake.send({ type: "assistant", message: { content: [{ type: "tool_use", id: name, name, input: {} }] } });
      text('Working'); await flush();
      expect(store.messages(result.threadId!).at(-1)).toMatchObject({ text: 'Working', phase: null });
      tool('Bash'); text('Subagent', 'child');
      fake.send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'lookup', name: 'Read', input: {} }, { type: 'text', text: 'Full answer' }] } });
      tool(bookkeeping); text('Closing answer');
      fake.send({ type: "result", subtype: "success", is_error: false, result: "Closing answer" }); await flush();
      expect(store.messages(result.threadId!).filter(m => m.role === 'assistant').map(m => [m.text, m.phase])).toEqual([
        ['Working', 'note'], ['Full answer', 'answer'], ['Closing answer', 'answer'],
      ]);
    } finally { await host.closeAll(); store.close(); }
  });

  it.each(["/workspace/example/foo.ts is failing", "/tmp/x", "/ hi"])("keeps resource identity for ordinary text %s", async text => {
    const { fake, host, store } = setup();
    try {
      const result = await host.execute({ type: "submit", commandId: "path", text, cwd: "/work/repo", provider: "claude" });
      await flush();
      expect(fake.state.prompts[0].message.content).toContain(text);
      expect(fake.state.prompts[0].message.content).toContain(`LOOM_RUN_ID=${store.activeRun(result.threadId!)!.id}`);
    } finally { await host.closeAll(); store.close(); }
  });
  it.each(["/compact", "/code-review", "/skill argument", "/anthropic-skills:docs x", "/code-review:code-review", "/Compact x", "/mcp__srv__p"])("preserves slash command %s without lease prose", async text => {
    const { fake, host, store } = setup();
    try {
      await host.execute({ type: "submit", commandId: "slash", text, cwd: "/work/repo", provider: "claude" });
      await flush();
      expect(fake.state.prompts[0].message.content).toBe(text);
    } finally { await host.closeAll(); store.close(); }
  });

  it("runs a turn: full permissions, deltas, tools capped, final message", async () => {
    const { fake, host, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "list files", cwd: "/work/repo", provider: "claude" });
    await flush();
    expect(fake.state.options).toMatchObject({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, cwd: "/work/repo" });
    expect(fake.state.options.resume).toBeUndefined();
    expect(fake.state.prompts[0]).toMatchObject({ type: "user", message: { content: expect.stringContaining("\n\nlist files") }, origin: { kind: "human" } });

    expect(fake.state.prompts[0].message.content).toContain(`LOOM_RUN_ID=${store.activeRun(r.threadId!)!.id}`);

    fake.send({ type: "system", subtype: "init", session_id: "native-1" });
    fake.send({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "Look" } } });
    fake.send({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] } });
    fake.send({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "x".repeat(50_000) }] } });
    fake.send({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Two files." }] } });
    await host.execute({ type: "handoff.record", commandId: "done", threadId: r.threadId!, kind: "nobody", text: "done" });
    fake.send({ type: "result", subtype: "success", is_error: false, result: "Two files." });
    await flush();

    expect(store.thread(r.threadId!)!.native_session_id).toBe("native-1");
    expect(store.messages(r.threadId!).map((m) => m.text)).toEqual(["list files", "Looking.", "Two files."]);
    const [item] = store.items(r.threadId!);
    expect(item).toMatchObject({ name: "Bash", status: "completed", output_bytes: 50_000 });
    expect(store.run(r.runId!)!.status).toBe("completed");
  });

  it("records each model call's context once, and a compaction on the timeline", async () => {
    const { fake, host, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/work/repo", provider: "claude" });
    await flush();
    const usage = { input_tokens: 2, cache_read_input_tokens: 180_000, cache_creation_input_tokens: 4_000, output_tokens: 300 };
    fake.send({ type: "system", subtype: "init", session_id: "native-u" });
    // One call, two content blocks: the SDK repeats the call's usage on each.
    fake.send({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_1", model: "claude-opus-5-5", usage, content: [{ type: "text", text: "a" }] } });
    fake.send({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_1", model: "claude-opus-5-5", usage, content: [{ type: "tool_use", id: "tu", name: "Bash", input: {} }] } });
    // A subagent's call is not this thread's context.
    fake.send({ type: "assistant", parent_tool_use_id: "tu", message: { id: "msg_sub", usage, content: [] } });
    fake.send({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 251_000, post_tokens: 31_000 } });
    fake.send({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_2", usage: { input_tokens: 5, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 1_000, output_tokens: 50 }, content: [{ type: "text", text: "b" }] } });
    fake.send({ type: "result", subtype: "success", is_error: false, result: "b" });
    await flush();
    const rows = store.db.prepare("SELECT run_id, context, cache_read, cache_write, output, model FROM usage WHERE thread_id = ? ORDER BY rowid").all(r.threadId!) as any[];
    expect(rows).toEqual([
      { run_id: r.runId, context: 184_002, cache_read: 180_000, cache_write: 4_000, output: 300, model: "claude-opus-5-5" },
      { run_id: r.runId, context: 31_005, cache_read: 30_000, cache_write: 1_000, output: 50, model: null },
    ]);
    expect(host.usage.summary(r.threadId!)).toMatchObject({ tokens: 31_005, today: 215_007, callsToday: 2 });
    expect(host.detail(r.threadId!)!.thread.context).toMatchObject({ tokens: 31_005 });
    expect(host.ledger.timeline(r.threadId!).some((e: any) => e.kind === "compacted" && e.summary.includes("251k → 31k"))).toBe(true);
  });

  it("routes AskUserQuestion to the Desk and returns the answers to Claude", async () => {
    const { fake, host, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "hi", cwd: "/work/repo", provider: "claude" });
    await flush();
    const decision = fake.state.options.canUseTool("AskUserQuestion", { questions: [{ question: "Which?" }] }, { signal: new AbortController().signal, toolUseID: "tq1" });
    await flush();
    expect(store.request("tq1")).toMatchObject({ kind: "question", status: "open" });
    expect(store.thread(r.threadId!)!.status).toBe("waiting");
    await host.execute({ type: "answer", commandId: "c2", requestId: "tq1", answer: { answers: { "Which?": "A" } } });
    expect(await decision).toEqual({ behavior: "allow", updatedInput: { questions: [{ question: "Which?" }], answers: { "Which?": "A" } } });
  });

  it("asks before leaving plan mode and passes feedback on a rejection", async () => {
    const { fake, host } = setup();
    await host.execute({ type: "submit", commandId: "c1", text: "plan it", cwd: "/work/repo", provider: "claude" });
    await flush();
    const decision = fake.state.options.canUseTool("ExitPlanMode", { plan: "do X" }, { signal: new AbortController().signal, toolUseID: "p1" });
    await flush();
    await host.execute({ type: "answer", commandId: "c2", requestId: "p1", answer: { approve: false, feedback: "Do Y first" } });
    expect(await decision).toEqual({ behavior: "deny", message: "Do Y first" });
  });

  it("allows every other tool without asking", async () => {
    const { fake, host } = setup();
    await host.execute({ type: "submit", commandId: "c1", text: "hi", cwd: "/work/repo", provider: "claude" });
    await flush();
    expect(await fake.state.options.canUseTool("Bash", { command: "rm -rf build" }, { signal: new AbortController().signal })).toEqual({
      behavior: "allow",
      updatedInput: { command: "rm -rf build" },
    });
  });

  it("records a wake turn when Claude starts working on its own", async () => {
    const { fake, host, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "start a monitor", cwd: "/work/repo", provider: "claude" });
    await flush();
    await host.execute({ type: "handoff.record", commandId: "started", threadId: r.threadId!, kind: "system", who: "monitor", text: "waiting" });
    fake.send({ type: "result", subtype: "success", is_error: false, result: "Started." });
    await flush();
    fake.send({ type: "system", subtype: "task_notification", task_id: "t1", status: "completed" });
    fake.send({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "The build finished." }] } });
    await flush();
    await host.execute({ type: "handoff.record", commandId: "done", threadId: r.threadId!, kind: "nobody", text: "done" });
    fake.send({ type: "result", subtype: "success", is_error: false, result: "The build finished." });
    await flush();
    const runs = store.runs(r.threadId!);
    expect(runs.map((x) => [x.source, x.status])).toEqual([["user", "completed"], ["wake", "completed"]]);
    expect(runs[1]!.text).toBe(WAKE_TEXT);
    expect(store.messages(r.threadId!).at(-1)!.text).toBe("The build finished.");
  });

  it("keeps the background work a finished turn left running on the thread, until it ends", async () => {
    const { fake, host, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "run the build in the background", cwd: "/work/repo", provider: "claude" });
    await flush();
    fake.send({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        { task_id: "t1", task_type: "local_bash", description: "npm run build" },
        { task_id: "w1", task_type: "monitor", description: "watch PR", ambient: true },
      ],
    });
    fake.send({ type: "result", subtype: "success", is_error: false, result: "Started." });
    await flush();
    const thread = store.thread(r.threadId!)!;
    expect(thread.status).toBe("idle");
    // The watcher is kept, marked ambient: the desk reads it as watching; upgrades don't wait on it.
    expect(JSON.parse(thread.background!)).toEqual([{ id: "t1", kind: "local_bash", description: "npm run build" }, { id: "w1", kind: "monitor", description: "watch PR", ambient: true }]);
    fake.send({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    await flush();
    expect(store.thread(r.threadId!)!.background).toBeNull();
  });

  it("forgets background work when the session ends", async () => {
    const { fake, host, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/work/repo", provider: "claude" });
    await flush();
    fake.send({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "t1", task_type: "local_agent", description: "review" }] });
    fake.send({ type: "result", subtype: "success", is_error: false, result: "ok" });
    await flush();
    expect(store.thread(r.threadId!)!.background).not.toBeNull();
    fake.end();
    await flush();
    expect(store.thread(r.threadId!)!.background).toBeNull();
  });

  it("resumes the native session on another account, with hard-linked history and real directories", async () => {
    const { fake, host, store, root } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "one", cwd: "/work/repo", provider: "claude", account: "a" });
    await flush();
    const project = join(root, "a", "projects", projectSlug("/work/repo"));
    writeFileSync(join(project, "native-1.jsonl"), "history\n");
    mkdirSync(join(project, "native-1", "tool-results"), { recursive: true });
    writeFileSync(join(project, "native-1", "tool-results", "large"), "large result");
    fake.send({ type: "system", subtype: "init", session_id: "native-1" });
    fake.send({ type: "result", subtype: "success", is_error: false, result: "ok" });
    fake.end();
    await flush();
    // Move the thread to account b (Loom 3's scheduler will do this on a limit).
    store.tx(() => store.updateThread(r.threadId!, { account: "b" }));
    await host.execute({ type: "submit", commandId: "c2", threadId: r.threadId, text: "two" });
    await flush();
    expect(fake.state.options.resume).toBe("native-1");
    expect(fake.state.options.env.CLAUDE_CONFIG_DIR).toBe(join(root, "b"));
    expect(lstatSync(join(root, "b", "projects", projectSlug("/work/repo"))).isSymbolicLink()).toBe(false);
    const destination = join(root, "b", "projects", projectSlug("/work/repo"));
    expect(readFileSync(join(destination, "native-1", "tool-results", "large"), "utf8")).toBe("large result");
    appendFileSync(join(project, "native-1.jsonl"), "appended\n");
    expect(readFileSync(join(destination, "native-1.jsonl"), "utf8")).toBe("history\nappended\n");
    for (const path of [join(root, "b"), join(root, "b", "projects"), destination, join(destination, "native-1"), join(destination, "native-1", "tool-results")]) {
      expect(lstatSync(path).isSymbolicLink()).toBe(false);
    }
  });

  it("fails the turn when the harness dies at startup, instead of leaving it running", async () => {
    const { fake, host, store } = setup();
    fake.end();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "hi", cwd: "/work/repo", provider: "claude" });
    await flush();
    expect(store.run(r.runId!)!.status).toBe("failed");
    expect(store.thread(r.threadId!)!.status).toBe("idle");
  });

  it("forgets an old rejected rate-limit reading at the next turn", async () => {
    const { fake, host, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "one", cwd: "/work/repo", provider: "claude" });
    await flush();
    fake.send({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1_800_000_000 } });
    await host.execute({ type: "handoff.record", commandId: "done", threadId: r.threadId!, kind: "nobody", text: "done" });
    fake.send({ type: "result", subtype: "success", is_error: false, result: "fine" });
    await flush();
    const two = await host.execute({ type: "submit", commandId: "c2", threadId: r.threadId, text: "two" });
    await flush();
    fake.send({ type: "result", subtype: "success", is_error: true, api_error_status: 529, result: "" });
    await flush();
    expect(JSON.parse(store.run(two.runId!)!.failure!).kind).toBe("overloaded");
  });

  it("forgets an old rejected reading when a wake turn starts", async () => {
    const { fake, host, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "one", cwd: "/work/repo", provider: "claude" });
    await flush();
    fake.send({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1_800_000_000 } });
    await host.execute({ type: "handoff.record", commandId: "done", threadId: r.threadId!, kind: "nobody", text: "done" });
    fake.send({ type: "result", subtype: "success", is_error: false, result: "fine" });
    await flush();
    fake.send({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Checking the task." }] } });
    fake.send({ type: "result", subtype: "success", is_error: true, api_error_status: 529, result: "" });
    await flush();
    const wake = store.runs(r.threadId!).find((x) => x.source === "wake")!;
    expect(JSON.parse(wake.failure!).kind).toBe("overloaded");
  });

  it("holds the queue on a usage limit and reports when it resets", async () => {
    const { fake, host, store } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "one", cwd: "/work/repo", provider: "claude" });
    await host.execute({ type: "submit", commandId: "c2", threadId: r.threadId, text: "two" });
    await flush();
    fake.send({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1_800_000_000 } });
    fake.send({ type: "result", subtype: "success", is_error: true, result: "Claude usage limit reached", terminal_reason: "blocking_limit" });
    await flush();
    const runs = store.runs(r.threadId!);
    expect(runs.map((x) => x.status)).toEqual(["failed", "queued"]);
    expect(JSON.parse(runs[0]!.failure!)).toMatchObject({ kind: "usage_limit", resetAt: 1_800_000_000_000 });
    expect(fake.state.prompts).toHaveLength(1);
  });
});

describe("peer transcript entries", () => {
  it("reads a message from another session out of the transcript, and whether it started the turn", async () => {
    const { peerEntryOf } = await import("../src/claude/peer-transcript.js");
    const line = JSON.stringify({ type: "user", isMeta: true, turnOrigin: "peer", message: { role: "user", content: "Another Claude session sent a message:\n<cross-session-message from=\"uds:/tmp/a.sock\" from-name=\"api\">\nhello there\n</cross-session-message>" }, origin: { kind: "peer", from: "uds:/tmp/a.sock", name: "api", msg_id: "n-9", body: "hello there" } });
    expect(peerEntryOf(line)).toEqual({ text: "hello there", name: "api", address: "uds:/tmp/a.sock", messageId: "n-9", inline: false });
    expect(peerEntryOf(JSON.stringify({ type: "user", message: { role: "user", content: "owner words" }, origin: { kind: "human" } }))).toBeNull();
    // No decoded body: the text inside the envelope.
    const bare = JSON.stringify({ type: "user", uuid: "u-1", message: { role: "user", content: "x <cross-session-message from=\"a\">\nonly this\n</cross-session-message>" }, origin: { kind: "peer" } });
    expect(peerEntryOf(bare)).toMatchObject({ text: "only this", messageId: "u-1", inline: true });
  });

  it("tails a transcript: only what was appended, and a resumed one from its end", async () => {
    const { TranscriptTail } = await import("../src/claude/peer-transcript.js");
    const { appendFileSync, mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const file = join(mkdtempSync(join(tmpdir(), "loom-tail-")), "s.jsonl");
    writeFileSync(file, '{"a":1}\n');
    const fresh = new TranscriptTail(file, false);
    const resumed = new TranscriptTail(file, true);
    expect(fresh.lines()).toEqual(['{"a":1}']);
    expect(resumed.lines()).toEqual([]);
    appendFileSync(file, '{"b":2}\n{"c":');
    expect(fresh.lines()).toEqual(['{"b":2}']);
    appendFileSync(file, "3}\n");
    expect(fresh.lines()).toEqual(['{"c":3}']);
    expect(resumed.lines()).toEqual(['{"b":2}', '{"c":3}']);
    // A character split across two reads stays whole.
    const bytes = Buffer.from('{"t":"🚗"}\n', "utf8");
    appendFileSync(file, bytes.subarray(0, 8));
    expect(fresh.lines()).toEqual([]);
    appendFileSync(file, bytes.subarray(8));
    expect(fresh.lines()).toEqual(['{"t":"🚗"}']);
  });
});

describe("native sends", () => {
  it("count as sent only when the tool result says so", async () => {
    const { sendSucceeded } = await import("../src/claude/claude-runtime.js");
    expect(sendSucceeded([{ type: "text", text: JSON.stringify({ success: true, message: "→ api" }) }])).toBe(true);
    expect(sendSucceeded("Not sent: that session can't receive cross-session messages")).toBe(false);
    expect(sendSucceeded([{ type: "text", text: JSON.stringify({ success: false }) }])).toBe(false);
  });
});

describe("project slugs", () => {
  it("follow the real path, as Claude does", async () => {
    const { projectSlug } = await import("../src/claude/project-store.js");
    const { mkdtempSync, realpathSync, symlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const real = mkdtempSync(join(tmpdir(), "loom-slug-"));
    const link = `${real}-link`;
    symlinkSync(real, link);
    expect(projectSlug(link)).toBe(realpathSync(real).replace(/[^a-zA-Z0-9]/g, "-"));
    expect(projectSlug("/no/such/dir")).toBe("-no-such-dir");
  });
});

it("labels unbound wake output locally and ignores a binding received after the wake ended", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-wake-"));
  const fake = fakeQuery();
  const events: RuntimeEvent[] = [];
  const runtime = new ClaudeRuntime({ accounts: [{ name: "a", configDir: join(root, "a") }], defaultAccount: "a", sharedProjectsDir: join(root, "shared"), query: fake.make });
  const session = await runtime.open({ threadId: "thread", cwd: "/work/repo", account: "a", nativeSessionId: null }, (event) => events.push(event));
  try {
    session.startTurn({ runId: "initial", text: "Start background work" });
    fake.send({ type: "result", subtype: "success", is_error: false, result: "Started" });
    await flush();
    events.length = 0;
    fake.send({ type: "assistant", message: { content: [{ type: "text", text: "Background finished" }] } });
    fake.send({ type: "result", subtype: "success", is_error: false, result: "Background finished" });
    await flush();
    const wake = events.find((event) => event.type === "wake.started")!;
    if (wake.type !== "wake.started") throw new Error("Missing wake");
    expect(wake.wakeId).toBeTruthy();
    expect(events.find((event) => event.type === "message.completed")).toMatchObject({ runId: wake.wakeId });
    wake.bind("durable-run-after-reconnect");
    fake.send({ type: "assistant", message: { content: [{ type: "text", text: "Another wake" }] } });
    await flush();
    const wakes = events.filter((event) => event.type === "wake.started");
    expect(wakes).toHaveLength(2);
    expect(wakes[1]).not.toMatchObject({ wakeId: wake.wakeId });
  } finally { await session.close(); }
});

it("maps a full session profile to SDK options and redacts harness errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-profile-"));
  const fake = fakeQuery();
  const events: RuntimeEvent[] = [];
  const runtime = new ClaudeRuntime({ accounts: [{ name: "a", configDir: join(root, "account") }], defaultAccount: "a", sharedProjectsDir: join(root, "shared"), query: fake.make });
  const session = await runtime.open({ threadId: "profile", cwd: "/work/profile", account: null, nativeSessionId: null, session: {
    system: "persona", model: "chosen-model", effort: "max", settingSources: [], tools: "none",
    env: { PROFILE_SECRET: "sentinel-env", CLAUDE_CONFIG_DIR: "/wrong", ANTHROPIC_API_KEY: "wrong" },
    mcpServers: { external: { command: "mcp", args: ["serve"], env: { TOKEN: "sentinel-mcp" } }, remote: { type: "http", url: "https://example.test", headers: { Authorization: "sentinel-header" } }, loom: { command: "cannot-replace-loom" } },
  } }, event => events.push(event));
  const options = fake.state.options;
  expect(options).toMatchObject({ model: "chosen-model", effort: "max", settingSources: [], tools: [], env: { PROFILE_SECRET: "sentinel-env", CLAUDE_CONFIG_DIR: join(root, "account") } });
  expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(options.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code" });
  expect(options.systemPrompt.append).toMatch(/\n\npersona$/);
  expect(options.mcpServers.external).toEqual({ command: "mcp", args: ["serve"], env: { TOKEN: "sentinel-mcp" } });
  expect(options.mcpServers.remote.headers.Authorization).toBe("sentinel-header");
  expect(options.mcpServers.loom.type).toBe("sdk");
  session.startTurn({ runId: "r", text: "go" });
  options.stderr("sentinel-env sentinel-mcp sentinel-header");
  fake.send({ type: "result", subtype: "error_during_execution", errors: ["sentinel-env sentinel-mcp sentinel-header"] });
  await flush();
  expect(events.some(e => e.type === "turn.failed")).toBe(true);
  expect(JSON.stringify(events)).not.toMatch(/sentinel-(env|mcp|header)/);
  await session.close();
});

it("gives a space's default conversation its routing guidance, and no other role", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-default-role-"));
  const fake = fakeQuery();
  const runtime = new ClaudeRuntime({ accounts: [{ name: "a", configDir: join(root, "account") }], defaultAccount: "a", sharedProjectsDir: join(root, "shared"), query: fake.make });
  const lead = await runtime.open({ threadId: "lead", cwd: "/work/lead", account: null, nativeSessionId: null, role: "default" }, () => {});
  expect(fake.state.options.systemPrompt.append).toContain(DEFAULT_ROLE_GUIDANCE);
  expect(DEFAULT_ROLE_GUIDANCE).toMatch(/tango-screen start .*--role worker/);
  await lead.close();
  const thread = await runtime.open({ threadId: "thread", cwd: "/work/thread", account: null, nativeSessionId: null, role: "interactive" }, () => {});
  expect(fake.state.options.systemPrompt.append).not.toContain(DEFAULT_ROLE_GUIDANCE);
  await thread.close();
  for (const role of ["worker", "ops"]) {
    const session = await runtime.open({ threadId: role, cwd: "/work/role", account: null, nativeSessionId: null, role }, () => {});
    expect(fake.state.options.systemPrompt.append).toContain(role === "worker" ? "Implement and verify your own work" : "A run that finds nothing ends quietly");
    expect(fake.state.options.systemPrompt.append).not.toContain(DEFAULT_ROLE_GUIDANCE);
    await session.close();
  }
  // An isolated profile has no way to route (no Loom tools, no shell): no guidance that tells it to.
  const isolated = await runtime.open({ threadId: "isolated-lead", cwd: "/work/isolated", account: null, nativeSessionId: null, role: "default", session: { loomTools: false, tools: "none" } }, () => {});
  expect(fake.state.options.systemPrompt.append).not.toContain(DEFAULT_ROLE_GUIDANCE);
  await isolated.close();
});

it("omits Loom tools and guidance when the profile disables them", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-no-tools-"));
  const fake = fakeQuery();
  const runtime = new ClaudeRuntime({ accounts: [{ name: "a", configDir: join(root, "account") }], defaultAccount: "a", sharedProjectsDir: join(root, "shared"), query: fake.make });
  const session = await runtime.open({ threadId: "isolated", cwd: "/work/isolated", account: null, nativeSessionId: null, session: {
    loomTools: false, system: "isolated persona", tools: "none", settingSources: [],
    mcpServers: { allowed: { command: "mcp" }, loom: { command: "cannot-replace-loom" } },
  } }, () => {});
  try {
    expect(fake.state.options.strictMcpConfig).toBe(true);
    expect(fake.state.options.tools).toEqual([]);
    expect(fake.state.options.settingSources).toEqual([]);
    expect(fake.state.options.mcpServers).toEqual({ allowed: { command: "mcp" } });
    expect(fake.state.options.systemPrompt.append).toBe("isolated persona");
  } finally { await session.close(); }
});

it("allowlists isolated harness env while preserving the account and configured env", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-env-"));
  const fake = fakeQuery();
  for (const key of ["LINEAR_API_KEY", "TANGO_PROFILE", "LOOM_TOKEN", "TANGO_DESK_ITEM", "OTHER_SECRET"]) vi.stubEnv(key, "daemon-sentinel");
  vi.stubEnv("LANG", "test-lang");
  const runtime = new ClaudeRuntime({ accounts: [{ name: "a", configDir: join(root, "account") }], defaultAccount: "a", sharedProjectsDir: join(root, "shared"), query: fake.make });
  try {
    for (const isolated of [true, false]) {
      const session = await runtime.open({ threadId: "env", cwd: "/work/env", account: null, nativeSessionId: null, session: { loomTools: !isolated, env: { CONFIGURED: "allowed" } } }, () => {});
      try {
        const env = fake.state.options.env;
        expect(env.CLAUDE_CONFIG_DIR).toBe(join(root, "account"));
        expect(env.CONFIGURED).toBe("allowed");
        expect(env.LANG).toBe("test-lang");
        for (const key of ["LINEAR_API_KEY", "TANGO_PROFILE", "LOOM_TOKEN", "TANGO_DESK_ITEM", "OTHER_SECRET"]) expect(env[key]).toBe(isolated ? undefined : key === "TANGO_DESK_ITEM" ? "loom:env" : "daemon-sentinel");
        if (isolated) expect(Object.keys(env).sort()).toEqual([...Object.keys(process.env).filter(key => ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM"].includes(key)), "CLAUDE_CONFIG_DIR", "CONFIGURED"].sort());
      } finally { await session.close(); }
    }
  } finally { vi.unstubAllEnvs(); }
});

describe("context management", () => {
  it("compacts coding threads at Loom's window unless the profile or Loom's env sets one", () => {
    expect(compactEnv({})).toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(DEFAULT_COMPACT_WINDOW) });
    expect(compactEnv({}, 180_000)).toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "180000" });
    expect(compactEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500000" })).toEqual({});
    expect(compactEnv({}, 0)).toEqual({});
  });

  it("passes the window and the hooks to a coding session, and neither to an isolated profile", async () => {
    const root = mkdtempSync(join(tmpdir(), "loom-compact-"));
    const fake = fakeQuery();
    const runtime = new ClaudeRuntime({ accounts: [{ name: "a", configDir: join(root, "account") }], defaultAccount: "a", sharedProjectsDir: join(root, "shared"), query: fake.make, carry: async () => "STATE" });
    for (const loomTools of [true, false]) {
      const session = await runtime.open({ threadId: "compact", cwd: "/work/compact", account: null, nativeSessionId: null, session: { loomTools } }, () => {});
      try {
        const { env, hooks } = fake.state.options;
        expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(loomTools ? String(DEFAULT_COMPACT_WINDOW) : undefined);
        expect(Boolean(hooks?.PreCompact)).toBe(loomTools);
      } finally { await session.close(); }
    }
  });

  it("asks compaction what to keep and gives Loom's state back right after it", async () => {
    const hooks = carryHooks("t1", async (id) => `state of ${id}`)!;
    const signal = new AbortController().signal;
    const pre = await hooks.PreCompact![0]!.hooks[0]!({ hook_event_name: "PreCompact", trigger: "auto", custom_instructions: null } as never, undefined, { signal });
    expect(pre).toEqual({ systemMessage: COMPACT_GUIDANCE });
    const start = hooks.SessionStart![0]!.hooks[0]!;
    expect(await start({ hook_event_name: "SessionStart", source: "compact" } as never, undefined, { signal })).toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "state of t1" } });
    // A resumed or new session already has its context (or gets it with its first turn): nothing added.
    expect(await start({ hook_event_name: "SessionStart", source: "resume" } as never, undefined, { signal })).toEqual({});
    // Loom unreachable: the session goes on without the block.
    const failing = carryHooks("t1", async () => { throw new Error("down"); })!;
    expect(await failing.SessionStart![0]!.hooks[0]!({ hook_event_name: "SessionStart", source: "compact" } as never, undefined, { signal })).toEqual({});
  });
});

it("keeps the CLI's stderr from a process Loom spawns, so an account that must accept new terms says so (10/20)", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-stderr-"));
  const events: RuntimeEvent[] = [];
  const ledger = { recordSpawn: () => {}, forgetSpawn: () => {} };
  const query = ({ options }: any) => Object.assign((async function* () {
    // What the SDK does with a custom spawner: it reads stdout only, then reports the exit code.
    const child = options.spawnClaudeCodeProcess({ command: "/bin/sh", args: ["-c", "echo '[ACTION REQUIRED] An update to our Consumer Terms has taken effect.' >&2; exit 1"], cwd: root, env: process.env });
    child.stdout.resume();
    await new Promise((resolve) => child.once("close", resolve));
    throw new Error("Claude Code process exited with code 1");
  })(), { close: () => {} }) as any;
  const runtime = new ClaudeRuntime({ accounts: [{ name: "a", configDir: join(root, "account") }], defaultAccount: "a", sharedProjectsDir: join(root, "shared"), query, ledger });
  const session = await runtime.open({ threadId: "terms", cwd: root, account: null, nativeSessionId: null }, event => events.push(event));
  session.startTurn({ runId: "r", text: "go" });
  await vi.waitFor(() => expect(events.some(e => e.type === "session.ended")).toBe(true));
  const ended = events.find(e => e.type === "session.ended") as Extract<RuntimeEvent, { type: "session.ended" }>;
  expect(ended.failure).toMatchObject({ kind: "auth", message: expect.stringContaining("Consumer Terms") });
  await session.close();
});

describe('local checkout edit guard', () => {
  it('protects checkout paths, including relative paths and symlinks, but allows artifacts and worktrees', async () => {
    const { execFileSync } = await import('node:child_process');
    const { localEditGuard } = await import('../src/claude/claude-runtime.js');
    const root = mkdtempSync(join(tmpdir(), 'loom-guard-'));
    const repo = join(root, 'repo');
    const home = join(root, 'loom');
    mkdirSync(repo);
    execFileSync('git', ['init', repo]);
    const guard = localEditGuard(repo, home, 'on');
    for (const tool of ['Edit', 'Write', 'MultiEdit']) {
      expect(guard(tool, {file_path:'new/file.txt'})).toContain('no worktree');
      expect(guard(tool, {file_path:join(root,'artifact.txt')})).toBeNull();
    }
    expect(guard('NotebookEdit', {notebook_path:join(repo,'book.ipynb')})).toContain('no worktree');
    expect(guard('Bash', {command:'anything'})).toBeNull();
    symlinkSync(repo, join(root,'alias'));
    expect(guard('Write', {file_path:join(root,'alias/new.txt')})).toContain('no worktree');
    expect(localEditGuard(repo,home,'off')('Write',{file_path:'new.txt'})).toBeNull();
    const owned = join(home,'worktrees','repo');
    mkdirSync(owned,{recursive:true});
    execFileSync('git',['init',owned]);
    expect(localEditGuard(owned,home,'on')('Write',{file_path:'new.txt'})).toBeNull();
    expect(localEditGuard(root,home,'on')('Write',{file_path:'new.txt'})).toBeNull();
  });
});

it('enforces checkout edits through both SDK callbacks with permission bypass enabled', async () => {
  const { execFileSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'loom-guard-sdk-'));
  const repo = join(root,'repo');
  mkdirSync(repo);
  execFileSync('git',['init','-b','main',repo]);
  const fake = fakeQuery();
  const runtime = new ClaudeRuntime({accounts:[{name:'a',configDir:join(root,'account')}],defaultAccount:'a',sharedProjectsDir:join(root,'shared'),query:fake.make});
  const session = await runtime.open({threadId:'guard',cwd:repo,account:null,nativeSessionId:null,kind:'coding'},()=>{});
  try {
    const options = fake.state.options;
    expect(options.permissionMode).toBe('bypassPermissions');
    expect(await options.canUseTool('Write',{file_path:'new.txt'},{signal:new AbortController().signal})).toMatchObject({behavior:'deny'});
    const hook = options.hooks.PreToolUse[0].hooks[0];
    expect(await hook({hook_event_name:'PreToolUse',tool_name:'Edit',tool_input:{file_path:join(repo,'new.txt')}})).toMatchObject({hookSpecificOutput:{permissionDecision:'deny'}});
    expect(await hook({hook_event_name:'PreToolUse',tool_name:'Write',tool_input:{file_path:join(root,'artifact.txt')}})).toEqual({});
  } finally { await session.close(); }
});

it('leaves Tango agent and job threads free to edit their own checkout', async () => {
  const { execFileSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'loom-guard-agent-'));
  const repo = join(root,'repo');
  mkdirSync(repo);
  execFileSync('git',['init','-b','main',repo]);
  const fake = fakeQuery();
  const runtime = new ClaudeRuntime({accounts:[{name:'a',configDir:join(root,'account')}],defaultAccount:'a',sharedProjectsDir:join(root,'shared'),query:fake.make});
  const session = await runtime.open({threadId:'agent',cwd:repo,account:null,nativeSessionId:null,kind:'tango-agent'},()=>{});
  try {
    expect(await fake.state.options.canUseTool('Write',{file_path:'new.txt'},{signal:new AbortController().signal})).toMatchObject({behavior:'allow'});
  } finally { await session.close(); }
});

it("records SDK rule denials once and carries their attribution, without guessing from text", async () => {
  const { fake, host, store } = setup();
  const r = await host.execute({ type: "submit", commandId: "denial-start", text: "Run a check", cwd: "/work/repo", provider: "claude" });
  await flush();
  const denied = { type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "blocked", decision_reason_type: "rule", message: "Denied" };
  fake.send(denied); fake.send(denied);
  fake.send({ ...denied, tool_use_id: "classifier", decision_reason_type: "classifier", message: "blocked by a settings rule" });
  fake.send({ type: "result", subtype: "success", is_error: false, result: "done", permission_denials: [{ tool_name: "Read", tool_use_id: "unknown", tool_input: {} }] });
  await flush();
  expect(store.db.prepare("SELECT tool, run_id FROM tool_denials").all()).toEqual([{ tool: "Bash", run_id: r.runId }]);
  expect(host.carry(r.threadId!)).toContain("Bash: blocked by a settings rule (SDK did not supply the rule/source), not by the owner");
  await host.closeAll();
});

it('refuses probe Edit and Write through SDK tool removal and both permission guards', async () => {
  const { probeProfile, DEFAULT_SCHEMA } = await import('../src/fan-outs.js');
  const root = mkdtempSync(join(tmpdir(), 'loom-probe-sdk-')), fake = fakeQuery();
  const runtime = new ClaudeRuntime({ accounts: [{ name: 'a', configDir: join(root, 'account') }], defaultAccount: 'a', sharedProjectsDir: join(root, 'shared'), query: fake.make });
  const session = await runtime.open({ threadId: 'probe', cwd: root, account: null, nativeSessionId: null, kind: 'probe', session: probeProfile(DEFAULT_SCHEMA) }, () => {});
  try {
    const options = fake.state.options;
    expect(options.settingSources).toEqual([]); expect(options.mcpServers).toEqual({});
    for (const name of ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']) {
      expect(options.disallowedTools).toContain(name);
      expect(await options.canUseTool(name, { file_path: join(root, 'file') }, { signal: new AbortController().signal })).toMatchObject({ behavior: 'deny' });
      expect(await options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: {} })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    }
  } finally { await session.close(); }
});


it.each([false, true])('Auto pre-edit denies before signaling once (disabled=%s)', async disabled => {
  const { execFileSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'loom-auto-sdk-'));
  execFileSync('git', ['init', '-b', 'main', root]);
  const fake = fakeQuery(); const events: RuntimeEvent[] = [];
  if (disabled) vi.stubEnv('LOOM_AUTO_PROMOTE', 'off');
  const runtime = new ClaudeRuntime({ accounts: [{ name: 'a', configDir: join(root, 'account') }], defaultAccount: 'a', sharedProjectsDir: join(root, 'shared'), query: fake.make });
  const session = await runtime.open({ threadId: 'auto', cwd: root, account: null, nativeSessionId: null, kind: 'coding', worktreeMode: 'auto' }, e => events.push(e));
  try {
    session.startTurn({ runId: 'edit', text: 'edit a file' });
    const hook = fake.state.options.hooks.PreToolUse[0].hooks[0];
    for (let i = 0; i < 2; i++) expect(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'new.txt' } })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining(disabled ? 'no worktree' : 'Moving this thread') } });
    expect(events.filter(e => e.type === 'worktree.promote')).toHaveLength(disabled ? 0 : 1);
    expect(existsSync(join(root, 'new.txt'))).toBe(false);
  } finally { await session.close(); vi.unstubAllEnvs(); }
});
