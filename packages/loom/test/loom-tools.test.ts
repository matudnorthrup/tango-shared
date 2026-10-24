import { expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, handler }),
  createSdkMcpServer: (options: unknown) => options,
}));
import { createLoomTools } from "../src/claude/loom-tools.js";
it("wait_for sends authenticated HTTP with the host's thread id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-tools-")); writeFileSync(join(dir, "token"), "test-token\n");
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { triggerId: "trigger" } })));
  vi.stubGlobal("fetch", fetcher);
  try {
    const server = createLoomTools("thread", { LOOM_HOME: dir, LOOM_PORT: "12345" }) as unknown as { tools: { name: string; handler: (input: unknown) => Promise<unknown> }[] };
    const result = await server.tools.find(t => t.name === "wait_for")!.handler({ kind: "time", spec: { afterMinutes: 1 }, note: "resume" });
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://127.0.0.1:12345/commands");
    const options = (fetcher.mock.calls as unknown as [string, RequestInit][])[0]![1];
    expect(options.headers).toMatchObject({ Authorization: "Bearer test-token" });
    expect(JSON.parse(String(options.body))).toMatchObject({ type: "trigger.create", threadId: "thread", note: "resume" });
    expect(JSON.stringify(result)).toContain("Registered. End your turn now");
  } finally { vi.unstubAllGlobals(); rmSync(dir, { recursive: true }); }
});
it("decision_request sends the brief as this thread's command; decision_check reads this thread's board view", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-tools-")); writeFileSync(join(dir, "token"), "test-token\n");
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ decisionId: "D-1" })));
  vi.stubGlobal("fetch", fetcher);
  try {
    const server = createLoomTools("thread", { LOOM_HOME: dir, LOOM_PORT: "12345" }) as unknown as { tools: { name: string; handler: (input: unknown) => Promise<unknown> }[] };
    const result = await server.tools.find(t => t.name === "decision_request")!.handler({ class: "plan-approval", ask: "Ship it? Recommend: yes." });
    const body = JSON.parse(String((fetcher.mock.calls as unknown as [string, RequestInit][])[0]![1].body));
    expect(body).toMatchObject({ type: "decision.request", threadId: "thread", brief: { class: "plan-approval" } });
    expect(JSON.stringify(result)).toContain("don't ask it again");
    await server.tools.find(t => t.name === "decision_check")!.handler({ class: "merge-when-green" });
    expect((fetcher.mock.calls as unknown as [string][])[1]![0]).toBe("http://127.0.0.1:12345/threads/thread/decisions?class=merge-when-green");
  } finally { vi.unstubAllGlobals(); rmSync(dir, { recursive: true }); }
});
it("decision_log sends a level 4 log as this thread's command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-tools-")); writeFileSync(join(dir, "token"), "test-token\n");
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { decisionId: "D-9" } })));
  vi.stubGlobal("fetch", fetcher);
  try {
    const server = createLoomTools("thread", { LOOM_HOME: dir, LOOM_PORT: "12345" }) as unknown as { tools: { name: string; handler: (input: unknown) => Promise<unknown> }[] };
    const result = await server.tools.find(t => t.name === "decision_log")!.handler({ class: "merge-when-green", summary: "Merged #12", undo: "revert it" });
    const body = JSON.parse(String((fetcher.mock.calls as unknown as [string, RequestInit][])[0]![1].body));
    expect(body).toMatchObject({ type: "decision.log", threadId: "thread", class: "merge-when-green", summary: "Merged #12", undo: "revert it" });
    expect(JSON.stringify(result)).toContain("Decided for you");
  } finally { vi.unstubAllGlobals(); rmSync(dir, { recursive: true }); }
});
it("decision_update sends the changes and why as this thread's command; decision_close takes moot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-tools-")); writeFileSync(join(dir, "token"), "test-token\n");
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { decisionId: "D-4", revision: 2 } })));
  vi.stubGlobal("fetch", fetcher);
  try {
    const server = createLoomTools("thread", { LOOM_HOME: dir, LOOM_PORT: "12345" }) as unknown as { tools: { name: string; handler: (input: unknown) => Promise<unknown> }[] };
    const result = await server.tools.find(t => t.name === "decision_update")!.handler({ decisionId: "D-4", changes: { standing: "CI is green now." }, why: "CI finished" });
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(JSON.parse(String(calls[0]![1].body))).toMatchObject({ type: "decision.update", threadId: "thread", decisionId: "D-4", changes: { standing: "CI is green now." }, why: "CI finished" });
    expect(JSON.stringify(result)).toContain("Updated in place");
    await server.tools.find(t => t.name === "decision_close")!.handler({ decisionId: "D-4", outcome: "moot", note: "The vendor fixed it upstream" });
    expect(JSON.parse(String(calls[1]![1].body))).toMatchObject({ type: "decision.close", threadId: "thread", decisionId: "D-4", outcome: "moot", note: "The vendor fixed it upstream" });
    await server.tools.find(t => t.name === "decision_keep")!.handler({ decisionId: "D-4", why: "A different topic" });
    expect(JSON.parse(String(calls[2]![1].body))).toMatchObject({ type: "decision.keep", threadId: "thread", decisionId: "D-4", why: "A different topic" });
  } finally { vi.unstubAllGlobals(); rmSync(dir, { recursive: true }); }
});
it("handoff forwards the declared ask through the shared tool used by Codex", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-tools-")); writeFileSync(join(dir, "token"), "test-token\n");
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { threadId: "thread" } })));
  vi.stubGlobal("fetch", fetcher);
  try {
    const server = createLoomTools("thread", { LOOM_HOME: dir, LOOM_PORT: "12345" }) as unknown as { tools: { name: string; handler: (input: unknown) => Promise<unknown> }[] };
    const ask = { kind: "do", steps: ["Connect", "Power on"], due: "2099-01-01T00:00:00Z", class: "identity", resolves: { kind: "pr", ref: "example/repo#12" } };
    await server.tools.find(t => t.name === "handoff")!.handler({ kind: "human", who: "fixture-owner", text: "Connect the test cable", ask });
    const body = JSON.parse(String((fetcher.mock.calls as unknown as [string, RequestInit][])[0]![1].body));
    expect(body).toMatchObject({ type: "handoff.record", threadId: "thread", ask });
  } finally { vi.unstubAllGlobals(); rmSync(dir, { recursive: true }); }
});
