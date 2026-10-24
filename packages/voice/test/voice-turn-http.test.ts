import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { HttpVoiceBridge } from "../src/index.js";

describe("HttpVoiceBridge voice turn delivery IDs", () => {
  it.each([
    { responseMessageIds: ["reply-1", "reply-2"], transcriptMessageId: "transcript-1", postedChannelId: "thread-1" },
    { responseMessageIds: [], transcriptMessageId: null, postedChannelId: "thread-1" },
    {},
  ])("passes delivery fields through /voice/turn and accepts legacy executors: %j", async (delivery) => {
    const result = { responseText: "hello", providerName: "test", ...delivery };
    const bridge = new HttpVoiceBridge({ executeTurn: async () => result }, {});
    const request = Object.assign(Readable.from([JSON.stringify({
      sessionId: "voice-session", agentId: "agent", transcript: "hi",
    })]), { method: "POST", url: "/voice/turn", headers: {} });
    const response = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
    // Exercise the real HTTP handler without opening a listening socket.
    await (bridge as unknown as {
      handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void>;
    }).handleRequest(request as IncomingMessage, response as unknown as ServerResponse);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.end.mock.calls[0]![0])).toMatchObject({ ok: true, ...result });
  });
});
