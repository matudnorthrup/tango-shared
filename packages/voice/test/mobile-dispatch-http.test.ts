import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HttpVoiceBridge,
  VoiceTargetDirectory,
  type VoiceTurnInput,
} from "../src/index.js";

const runningBridges: HttpVoiceBridge[] = [];

afterEach(async () => {
  await Promise.all(runningBridges.splice(0).map((bridge) => bridge.stop()));
});

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a port.")));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

const fakeVoiceTargets = {
  resolveExplicitAddress(transcript: string) {
    if (!/^hey[, ]+sierra\b/iu.test(transcript)) return null;
    return {
      kind: "agent",
      agent: {
        id: "sierra",
        type: "travel",
        displayName: "Sierra",
        callSigns: ["Sierra"],
      },
      matchedName: "Sierra",
      transcript,
    };
  },
} as unknown as VoiceTargetDirectory;

describe("HttpVoiceBridge mobile dispatch endpoint", () => {
  it("routes dictated text through the voice turn executor", async () => {
    const port = await getFreePort();
    const executeTurn = vi.fn(async (input: VoiceTurnInput) => ({
      responseText: `reply to ${input.agentId}: ${input.transcript}`,
      providerName: "test-provider",
    }));
    const bridge = new HttpVoiceBridge(
      { executeTurn },
      {
        port,
        apiKey: "secret-token",
        defaultAgentId: "watson",
        voiceTargets: fakeVoiceTargets,
      },
    );
    runningBridges.push(bridge);
    await bridge.start();

    const response = await fetch(
      `http://127.0.0.1:${port}/mobile/voice-dispatch`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer secret-token",
        },
        body: JSON.stringify({
          transcript: "Hey Sierra, what temperature will it be in Costa Sur?",
          channelId: "12345",
          utteranceId: "android-1",
        }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(executeTurn).toHaveBeenCalledWith({
      sessionId: "agent:sierra:discord:channel:12345",
      agentId: "sierra",
      transcript: "what temperature will it be in Costa Sur?",
      utteranceId: "android-1",
      channelId: "12345",
    });
    expect(body).toMatchObject({
      ok: true,
      agentId: "sierra",
      sessionId: "agent:sierra:discord:channel:12345",
      responseText: "reply to sierra: what temperature will it be in Costa Sur?",
      providerName: "test-provider",
      mobileDispatch: {
        routedBy: "explicit-address",
        matchedCallSign: "Sierra",
        strippedWakePhrase: true,
      },
    });
  });

  it("requires the bridge API key when configured", async () => {
    const port = await getFreePort();
    const bridge = new HttpVoiceBridge(
      {
        executeTurn: async () => ({
          responseText: "not called",
          providerName: "test-provider",
        }),
      },
      {
        port,
        apiKey: "secret-token",
        defaultAgentId: "watson",
        voiceTargets: fakeVoiceTargets,
      },
    );
    runningBridges.push(bridge);
    await bridge.start();

    const response = await fetch(
      `http://127.0.0.1:${port}/mobile/voice-dispatch`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ transcript: "hello" }),
      },
    );

    expect(response.status).toBe(401);
  });
});
