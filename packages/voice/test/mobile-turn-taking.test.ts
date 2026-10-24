import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpVoiceBridge, MobileVoiceTurns, parseMobileVoiceDispatchInput, VoiceTargetDirectory, type VoiceTurnInput } from "../src/index.js";

const targets = { resolveExplicitAddress: () => null } as unknown as VoiceTargetDirectory;
const turns: MobileVoiceTurns[] = [];
const bridges: HttpVoiceBridge[] = [];
afterEach(async () => {
  turns.splice(0).forEach((turn) => turn.stop());
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
  vi.useRealTimers();
});
function setup() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const send = vi.fn(async (_input: VoiceTurnInput) => ({ responseText: "sent", providerName: "test" }));
  const mobile = new MobileVoiceTurns(send);
  turns.push(mobile);
  const press = (transcript: string, sessionId = "one", agentId = "test", utteranceId?: string) => mobile.press(parseMobileVoiceDispatchInput(
    { transcript, sessionId, agentId, ...(utteranceId ? { utteranceId } : {}) }, { voiceTargets: targets },
  ));
  return { send, mobile, press };
}
describe("mobile turn-taking", () => {
  it("sends an ordinary press immediately with unchanged text and metadata", async () => {
    const { press, send } = setup();
    const response = await press("Turn on the lights.");
    expect(response.result?.responseText).toBe("sent");
    expect(response.turnTaking).toBeUndefined();
    expect(send).toHaveBeenCalledExactlyOnceWith({ transcript: "Turn on the lights.", sessionId: "one", agentId: "test" });
  });
  it("joins an unfinished end to the next press and clears its deadline", async () => {
    const { press, send } = setup();
    expect((await press("Bring the drill and")).turnTaking).toEqual({ status: "held", say: "Go on." });
    expect(send).not.toHaveBeenCalled();
    await press("the screws.");
    expect(send.mock.calls[0]?.[0].transcript).toBe("Bring the drill and the screws.");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("finishes a quick hold after 20 seconds without another press", async () => {
    const { press, send } = setup();
    await press("Bring the drill and");
    await vi.advanceTimersByTimeAsync(19_999);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send.mock.calls[0]?.[0].transcript).toBe("Bring the drill and");
  });
  it("restarts the quick deadline when another unfinished piece arrives", async () => {
    const { press, send } = setup();
    await press("Bring the drill and");
    await vi.advanceTimersByTimeAsync(15_000);
    await press("the screws plus");
    await vi.advanceTimersByTimeAsync(19_999);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send.mock.calls[0]?.[0].transcript).toBe("Bring the drill and the screws plus");
  });
  it.each(["I'm gonna ramble", "I'm gonna talk for a while.", "Let me think out loud."])("holds %s until a closer, removing preamble and closer", async (preamble) => {
    const { press, send } = setup();
    expect((await press(preamble)).turnTaking).toEqual({ status: "held", say: "Holding. Say send it when you're done." });
    await press("Bring the drill.");
    await vi.advanceTimersByTimeAsync(20_000);
    await press("And the screws.");
    expect(send).not.toHaveBeenCalled();
    await press("okay send it");
    expect(send.mock.calls[0]?.[0].transcript).toBe("Bring the drill. And the screws.");
  });
  it.each(["cancel", "never mind", "forget it"])("drops a held turn on %s", async (cancel) => {
    const { press, send } = setup();
    await press("Bring the drill and");
    expect((await press(cancel)).turnTaking).toEqual({ status: "cancelled", say: "Cancelled." });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(send).not.toHaveBeenCalled();
    await press("New request.");
    expect(send.mock.calls[0]?.[0].transcript).toBe("New request.");
  });
  it("a hold phrase upgrades a quick hold to ramble instead of sending on its old deadline", async () => {
    const { press, send } = setup();
    await press("Bring the drill and");
    expect((await press("hold on")).turnTaking?.status).toBe("held");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(send).not.toHaveBeenCalled();
    await press("the screws.");
    await press("okay send it");
    expect(send).toHaveBeenCalledTimes(1);
    // The shared policy retains mid-turn hold wording; only preambles and closers are stripped.
    expect(send.mock.calls[0]?.[0].transcript).toBe("Bring the drill and hold on the screws.");
  });
  it("isolates sessions and agents", async () => {
    const { press, send } = setup();
    await press("Bring the drill and", "one");
    await press("Lights on.", "two");
    await press("Music on.", "one", "other");
    await press("the screws.", "one");
    expect(send.mock.calls.map(([input]) => input.transcript)).toEqual(["Lights on.", "Music on.", "Bring the drill and the screws."]);
  });
  it("expires ramble 12 hours from its start without dispatching it", async () => {
    const { press, send } = setup();
    await press("I'm gonna ramble.");
    await vi.advanceTimersByTimeAsync(11 * 60 * 60 * 1000);
    await press("Old content.");
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(send).not.toHaveBeenCalled();
    await press("New request.");
    expect(send.mock.calls[0]?.[0].transcript).toBe("New request.");
  });
  it("answers a retried finishing press with the joined result instead of sending again", async () => {
    const { press, send } = setup();
    await press("Bring the drill and", "one", "test", "a");
    const first = await press("the screws.", "one", "test", "b");
    const retry = await press("the screws.", "one", "test", "b");
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ transcript: "Bring the drill and the screws.", utteranceId: "a" }));
    expect(retry).toBe(first);
    expect(await press("Bring the drill and", "one", "test", "a")).toBe(first);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("does not add a retried held press's words twice", async () => {
    const { press, send } = setup();
    await press("Bring the drill and", "one", "test", "a");
    expect((await press("Bring the drill and", "one", "test", "a")).turnTaking).toEqual({ status: "held", say: "Go on." });
    await press("the screws.", "one", "test", "b");
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ transcript: "Bring the drill and the screws." }));
  });
  it("answers a retried held press with ramble guidance after upgrading the turn", async () => {
    const { press, send } = setup();
    await press("Bring the drill and", "one", "test", "a");
    await press("hold on", "one", "test", "b");
    expect((await press("Bring the drill and", "one", "test", "a")).turnTaking).toEqual({ status: "held", say: "Holding. Say send it when you're done." });
    expect(send).not.toHaveBeenCalled();
  });
  it("answers a retry of a press whose hold timed out with the deferred result", async () => {
    const { press, send } = setup();
    await press("Bring the drill and", "one", "test", "a");
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await press("Bring the drill and", "one", "test", "a")).result?.responseText).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("keeps a retried cancel from cancelling the next turn", async () => {
    const { press, send } = setup();
    await press("Bring the drill and", "one", "test", "a");
    await press("never mind", "one", "test", "b");
    await press("Lights", "one", "test", "c");
    expect((await press("never mind", "one", "test", "b")).turnTaking).toEqual({ status: "cancelled", say: "Cancelled." });
    expect(send.mock.calls.map(([input]) => input.transcript)).toEqual(["Lights"]);
  });
  it("clears pending sends when stopped", async () => {
    const { press, send, mobile } = setup();
    await press("Bring the drill and");
    mobile.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(send).not.toHaveBeenCalled();
  });
  it("catches deferred executor rejection", async () => {
    const { press, send } = setup();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      send.mockRejectedValueOnce(new Error("private transcript"));
      await press("Bring the drill and");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(error).toHaveBeenCalledExactlyOnceWith("Mobile voice deferred dispatch failed.");
    } finally { error.mockRestore(); }
  });
  it("returns holding metadata over HTTP and dispatches joined text on a later request", async () => {
    const executeTurn = vi.fn(async (_input: VoiceTurnInput) => ({ responseText: "sent", providerName: "test" }));
    const bridge = new HttpVoiceBridge({ executeTurn }, { port: 0, defaultAgentId: "test", voiceTargets: targets });
    bridges.push(bridge);
    await bridge.start();
    // The test uses the OS-assigned ephemeral port, never a live bridge.
    const server = (bridge as unknown as { server: import("node:http").Server }).server;
    const address = server.address() as import("node:net").AddressInfo;
    const press = async (transcript: string) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/mobile/voice-dispatch`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcript }),
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await press("Bring the drill and")).toMatchObject({ ok: true, turnTaking: { status: "held", say: "Go on." } });
    expect(await press("cancel")).toMatchObject({ ok: true, turnTaking: { status: "cancelled", say: "Cancelled." } });
    expect(executeTurn).not.toHaveBeenCalled();
    expect(await press("I'm gonna ramble.")).toMatchObject({ ok: true, turnTaking: { status: "held", say: "Holding. Say send it when you're done." } });
    await press("Bring the drill.");
    expect(executeTurn).not.toHaveBeenCalled();
    expect(await press("okay send it")).toMatchObject({ ok: true, responseText: "sent", mobileDispatch: { dispatchedTranscript: "Bring the drill." } });
    expect(executeTurn.mock.calls[0]?.[0].transcript).toBe("Bring the drill.");
  });
});
