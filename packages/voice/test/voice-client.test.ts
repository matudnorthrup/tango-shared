import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { describe, expect, it, vi } from "vitest";
import { requestVoiceTurn } from "../src/index.js";

describe("requestVoiceTurn", () => {
  it("parses a successful voice bridge response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          turnId: "turn-1",
          deduplicated: true,
          responseText: "Hello from Tango.",
          providerName: "codex",
          providerSessionId: "provider-session-1",
          warmStartUsed: true,
          providerUsedFailover: false
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );

    const result = await requestVoiceTurn(
      {
        sessionId: "voice-main",
        agentId: "watson",
        transcript: "hello"
      },
      {
        endpoint: "http://127.0.0.1:8787/voice/turn",
        fetchImpl
      }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      turnId: "turn-1",
      deduplicated: true,
      responseText: "Hello from Tango.",
      providerName: "codex",
      providerSessionId: "provider-session-1",
      warmStartUsed: true,
      providerUsedFailover: false
    });
  });

  it("carries the failure flag and Discord delivery ids", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          responseText: "Sorry, I'm having trouble. Try again.",
          providerName: "claude-code-v2",
          failed: true,
          failureReason: "timeout",
          responseMessageIds: ["m-1", 7, "m-2"],
          postedChannelId: "thread-1",
          transcriptMessageId: null
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const result = await requestVoiceTurn(
      { sessionId: "voice-main", agentId: "watson", transcript: "hello" },
      { endpoint: "http://127.0.0.1:8787/voice/turn", fetchImpl }
    );

    expect(result).toMatchObject({
      responseText: "Sorry, I'm having trouble. Try again.",
      failed: true,
      failureReason: "timeout",
      responseMessageIds: ["m-1", "m-2"],
      postedChannelId: "thread-1",
      transcriptMessageId: null
    });
  });

  it("defaults the failure reason when an older server omits it", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, responseText: "x", providerName: "p", failed: true }), { status: 200 })
    );
    const result = await requestVoiceTurn(
      { sessionId: "s", agentId: "a", transcript: "t" },
      { endpoint: "http://127.0.0.1:8787/voice/turn", fetchImpl }
    );
    expect(result).toMatchObject({ failed: true, failureReason: "error" });
  });

  it("retries retryable bridge failures and surfaces retry callbacks", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("temporary failure", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            responseText: "Recovered.",
            providerName: "codex"
          }),
          { status: 200 }
        )
      );
    const onRetry = vi.fn();

    const result = await requestVoiceTurn(
      {
        sessionId: "voice-main",
        agentId: "watson",
        transcript: "hello again"
      },
      {
        endpoint: "http://127.0.0.1:8787/voice/turn",
        maxRetries: 1,
        retryBaseDelayMs: 0,
        fetchImpl,
        onRetry
      }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith({
      attempt: 1,
      maxRetries: 1,
      delayMs: 0,
      error: expect.any(Error)
    });
    expect(result.responseText).toBe("Recovered.");
  });

  it("does not retry non-retryable bridge failures", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("bad request", { status: 400 }));

    await expect(
      requestVoiceTurn(
        {
          sessionId: "voice-main",
          agentId: "watson",
          transcript: "bad request case"
        },
        {
          endpoint: "http://127.0.0.1:8787/voice/turn",
          maxRetries: 2,
          retryBaseDelayMs: 0,
          fetchImpl
        }
      )
    ).rejects.toThrow("Voice bridge HTTP 400");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // Node's fetch cuts a request off when response headers take longer than
  // ~5 minutes and the voice client then retries it, resending a turn that is
  // still running. A 25 ms header deadline stands in for that limit; undici's
  // coarse timers fire it within about a second, so the server answers after
  // 1.5 s.
  it("uses an unbounded dispatcher when timeoutMs is zero", async () => {
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          ok: true,
          responseText: "Long turn completed.",
          providerName: "claude-code-v2",
        }));
      }, 1_500);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const previousDispatcher = getGlobalDispatcher();
    const constrainedDispatcher = new Agent({ headersTimeout: 25 });
    setGlobalDispatcher(constrainedDispatcher);

    try {
      // Control: the constrained global dispatcher does cut off plain fetch.
      await expect(fetch(`http://127.0.0.1:${address.port}/control`)).rejects.toThrow("fetch failed");

      requestCount = 0;
      const result = await requestVoiceTurn(
        {
          sessionId: "voice-long-turn",
          agentId: "papa",
          transcript: "complete the long job",
        },
        {
          endpoint: `http://127.0.0.1:${address.port}/voice/turn`,
          timeoutMs: 0,
          maxRetries: 2,
          retryBaseDelayMs: 0,
        },
      );

      expect(result.responseText).toBe("Long turn completed.");
      expect(requestCount).toBe(1);
    } finally {
      setGlobalDispatcher(previousDispatcher);
      await constrainedDispatcher.close();
      await new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  }, 15_000);
});
