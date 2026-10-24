import { describe, expect, it } from "vitest";
import { createScreenTools } from "../src/screen-tools.js";

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

function fakeService(responses: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const key = `${method} ${new URL(url).pathname}`;
    const payload = responses[key] ?? { error: `unexpected ${key}` };
    return new Response(JSON.stringify(payload), { status: key in responses ? 200 : 404 });
  }) as unknown as typeof fetch;
  const [tool] = createScreenTools({ screenUrl: "http://screen.test", fetchImpl });
  return { tool: tool!, calls };
}

describe("screen tool", () => {
  it("stages as the calling agent, with the conversation it came from", async () => {
    const { tool, calls } = fakeService({
      "POST /api/scenes": { sceneId: "s1", version: 1, screens: 1, showing: false, operatorLive: true },
    });
    const result = await tool.handler({
      action: "stage",
      body: "<h1>hi</h1>",
      summary: "A greeting",
      slot: "hello",
      _requester_agent_id: "sierra",
      _channel_id: "c1",
      _thread_id: "t1",
      _conversation_key: "thread:t1",
    });
    expect(calls[0]!.body).toMatchObject({
      agentId: "sierra", kind: "html", slot: "hello", channelId: "c1", threadId: "t1", conversationKey: "thread:t1",
    });
    expect(result).toMatchObject({ sceneId: "s1" });
    expect(String((result as { note: string }).note)).toMatch(/operator will put it up/);
  });

  it("watch_pr hands a PR review wait to the desk for this conversation", async () => {
    const { tool, calls } = fakeService({
      "POST /api/desk/pr-watch": { itemId: "discord:thread:t1", watching: true, url: "https://github.com/acme/api/pull/31", number: 31, onApprove: "continue" },
    });
    const result = await tool.handler({
      action: "watch_pr",
      url: "https://github.com/acme/api/pull/31",
      _requester_agent_id: "victor",
      _channel_id: "c1",
      _thread_id: "t1",
    });
    expect(calls[0]!.body).toEqual({ conversationKey: "thread:t1", url: "https://github.com/acme/api/pull/31", onApprove: "continue", off: false });
    expect(result).toMatchObject({ watching: true, number: 31 });
    await tool.handler({ action: "watch_pr", url: "https://github.com/acme/api/pull/31", on_approve: "notify", _requester_agent_id: "victor", _channel_id: "c9" });
    expect(calls[1]!.body).toMatchObject({ conversationKey: "channel:c9", onApprove: "notify" });
    await expect(tool.handler({ action: "watch_pr", _requester_agent_id: "victor", _channel_id: "c9" })).rejects.toThrow(/needs url/);
  });

  it("refuses without a trusted agent identity", async () => {
    const { tool } = fakeService({});
    await expect(tool.handler({ action: "list" })).rejects.toThrow(/agent identity/);
  });

  it("updates a scene by slot", async () => {
    const { tool, calls } = fakeService({
      "GET /api/stages/malibu": { scenes: [{ id: "m1", slot: "macros" }] },
      "PATCH /api/scenes/m1": { sceneId: "m1", showing: true },
    });
    await tool.handler({ action: "update", slot: "macros", state: { protein: 120 }, _requester_agent_id: "malibu" });
    expect(calls[0]!.url).toBe("http://screen.test/api/stages/malibu?slot=macros");
    expect(calls[1]).toMatchObject({ method: "PATCH", body: { state: { protein: 120 } } });
  });

  it("finds update/clear scenes in this turn's conversation, not another one's", async () => {
    const { tool, calls } = fakeService({
      "GET /api/stages/sierra": { scenes: [{ id: "s-thread-2", slot: "main" }] },
      "PATCH /api/scenes/s-thread-2": { sceneId: "s-thread-2" },
      "DELETE /api/scenes/s-thread-2": { cleared: ["s-thread-2"] },
    });
    const context = {
      _requester_agent_id: "sierra",
      _conversation_key: "thread:thread-2",
      _thread_id: "thread-2",
      _channel_id: "home-1",
    };

    await tool.handler({ action: "update", state: { n: 1 }, ...context });
    await tool.handler({ action: "clear", ...context });

    for (const call of [calls[0]!, calls[2]!]) {
      const url = new URL(call.url);
      expect(url.pathname).toBe("/api/stages/sierra");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        slot: "main",
        conversationKey: "thread:thread-2",
        threadId: "thread-2",
        channelId: "home-1",
      });
    }
    expect(calls[1]).toMatchObject({ method: "PATCH", url: "http://screen.test/api/scenes/s-thread-2" });
    expect(calls[3]).toMatchObject({ method: "DELETE", url: "http://screen.test/api/scenes/s-thread-2" });
  });

  it("explains a missing slot on update", async () => {
    const { tool } = fakeService({ "GET /api/stages/malibu": { scenes: [] } });
    await expect(tool.handler({ action: "update", slot: "nope", state: {}, _requester_agent_id: "malibu" })).rejects.toThrow(/stage it first/);
  });

  it("surfaces service validation errors", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: "summary is required" }), { status: 400 })) as unknown as typeof fetch;
    const [tool] = createScreenTools({ screenUrl: "http://screen.test", fetchImpl });
    await expect(tool!.handler({ action: "stage", body: "x", _requester_agent_id: "sierra" })).rejects.toThrow("summary is required");
  });
});
