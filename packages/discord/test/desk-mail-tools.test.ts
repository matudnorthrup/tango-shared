import { describe, expect, it } from "vitest";
import { createDeskMailTools, deskConversationKey } from "../src/desk-mail-tools.js";

function harness(response: Record<string, unknown> = { ok: true }) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(response), { status: 200 });
  }) as unknown as typeof fetch;
  const [tool] = createDeskMailTools({ screenUrl: "http://desk", fetchImpl });
  return { tool: tool!, calls };
}

describe("desk_mail", () => {
  it("names the calling conversation from the runtime-injected keys only", () => {
    expect(deskConversationKey({ _thread_id: "123", _channel_id: "9" })).toBe("thread:123");
    expect(deskConversationKey({ _channel_id: "9" })).toBe("channel:9");
    expect(deskConversationKey({ conversation_key: "thread:spoof" })).toBeUndefined();
  });

  it("sends as this conversation, never as one the model names", async () => {
    const { tool, calls } = harness();
    await tool.handler({ action: "send", to: "loom:abc", text: "port?", fromConversationKey: "thread:spoof", _thread_id: "123" });
    expect(calls[0]).toMatchObject({ method: "POST", url: "http://desk/api/desk/mail", body: { fromConversationKey: "thread:123", to: "loom:abc", text: "port?", expect: "reply" } });
    await tool.handler({ action: "send", to: "loom:abc", text: "fyi", reply: false, _thread_id: "123" });
    expect(calls[1]!.body).toMatchObject({ expect: "none" });
  });

  it("starts a thread with its task, repo and the caller as the starter", async () => {
    const { tool, calls } = harness();
    await tool.handler({ action: "start", prompt: "Build the card back art pipeline", repo: "tango", _channel_id: "9" });
    expect(calls[0]).toMatchObject({ url: "http://desk/api/desk/mail/start", body: { fromConversationKey: "channel:9", prompt: "Build the card back art pipeline", repo: "tango", report: true } });
  });

  it("lists threads marking the caller, and refuses sends without a conversation", async () => {
    const { tool, calls } = harness({ threads: [] });
    await tool.handler({ action: "threads", status: "idle", _thread_id: "123" });
    expect(calls[0]!.url).toBe("http://desk/api/desk/mail/threads?status=idle&limit=30&conversationKey=thread%3A123");
    await expect(tool.handler({ action: "send", to: "loom:abc", text: "hi" })).rejects.toThrow(/conversation this turn runs in/);
  });
});
