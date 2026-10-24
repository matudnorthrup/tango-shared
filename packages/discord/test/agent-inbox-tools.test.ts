import { describe, expect, it } from "vitest";
import { createAgentInboxTools } from "../src/agent-inbox-tools.js";

function fake(responses: Record<string, unknown>) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const parsed = new URL(url);
    calls.push({ method, url: parsed.pathname + parsed.search, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const key = `${method} ${parsed.pathname}`;
    return new Response(JSON.stringify(responses[key] ?? { error: "nope" }), { status: key in responses ? 200 : 404 });
  }) as unknown as typeof fetch;
  return { tool: createAgentInboxTools({ screenUrl: "http://inbox.test", fetchImpl })[0]!, calls };
}

describe("agent_inbox tool", () => {
  it("lists a view compactly", async () => {
    const { tool, calls } = fake({ "GET /api/inbox": { counts: { needs_you: 1 }, items: [{ id: "t1", agentName: "Foxtrot", summary: "Groceries?", status: "needs_you", state: "queued", messages: ["x"], color: "red" }] } });
    const result = (await tool.handler({ action: "list", agent: "foxtrot", filter: "needs_you" })) as { items: Array<Record<string, unknown>> };
    expect(calls[0]!.url).toBe("/api/inbox?filter=needs_you&sort=smart&agent=foxtrot");
    expect(result.items[0]).toEqual({ id: "t1", agentName: "Foxtrot", summary: "Groceries?", status: "needs_you", state: "queued" });
  });

  it("marks seen as a 👍 and later with a note", async () => {
    const { tool, calls } = fake({ "POST /api/inbox/t1/react": { id: "t1", acked: true }, "POST /api/inbox/t1/later": { id: "t1", state: "later" } });
    await tool.handler({ action: "mark", id: "t1", mark: "seen" });
    await tool.handler({ action: "mark", id: "t1", mark: "later", note: "after payday" });
    expect(calls.map((call) => [call.url, call.body])).toEqual([
      ["/api/inbox/t1/react", { emoji: "👍" }],
      ["/api/inbox/t1/later", { note: "after payday" }],
    ]);
  });

  it("refuses unknown marks", async () => {
    const { tool } = fake({});
    await expect(tool.handler({ action: "mark", id: "t1", mark: "delete" })).rejects.toThrow(/mark must be/);
  });
});
