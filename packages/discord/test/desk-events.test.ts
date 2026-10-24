import { ClaudeCodeTimeoutError } from "@tango/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyDeskTurnFailure,
  createDeskEventsClient,
  NOOP_DESK_TURN,
  resolveDeskEventsConfig,
  runtimeErrorResponseFailure,
  type DeskAgentEvent,
} from "../src/desk-events.js";

const identity = {
  agentId: "sierra",
  conversationKey: "thread:thread-1",
  channelId: "home-1",
  threadId: "thread-1",
};

function recorder(response: () => Promise<Response> = async () => new Response("{}", { status: 200 })) {
  const events: DeskAgentEvent[] = [];
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    events.push(JSON.parse(String(init.body)) as DeskAgentEvent);
    return response();
  }) as unknown as typeof fetch;
  return { events, requests, fetchImpl };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveDeskEventsConfig", () => {
  it("prefers TANGO_DESK_URL, then TANGO_SCREEN_URL, then the local screen service", () => {
    expect(resolveDeskEventsConfig({ TANGO_DESK_URL: "http://desk.test/", TANGO_SCREEN_URL: "http://screen.test" }).endpoint)
      .toBe("http://desk.test/api/desk/agent-events");
    expect(resolveDeskEventsConfig({ TANGO_SCREEN_URL: "http://screen.test" }).endpoint)
      .toBe("http://screen.test/api/desk/agent-events");
    expect(resolveDeskEventsConfig({})).toEqual({
      enabled: true,
      endpoint: "http://127.0.0.1:9410/api/desk/agent-events",
    });
  });

  it("turns off with TANGO_DESK_EVENTS=off and carries the bridge token", () => {
    expect(resolveDeskEventsConfig({ TANGO_DESK_EVENTS: "off" }).enabled).toBe(false);
    expect(resolveDeskEventsConfig({ TANGO_COLLABORATION_BRIDGE_TOKEN: " secret " }).token).toBe("secret");
  });
});

describe("desk turn tracker", () => {
  it("posts started and finished with the spec body and the token header", async () => {
    const { events, requests, fetchImpl } = recorder();
    const client = createDeskEventsClient({ endpoint: "http://desk.test/api/desk/agent-events", token: "tok", enabled: true, fetchImpl, now: () => 1000 });

    const turn = client.startTurn(identity, { turnId: "turn-1" });
    turn.finish();
    turn.finish();
    turn.fail(new Error("late"));

    expect(events).toEqual([
      { ...identity, turnId: "turn-1", type: "turn.started", at: 1000 },
      { ...identity, turnId: "turn-1", type: "turn.finished", at: 1000 },
    ]);
    expect(requests[0]!.url).toBe("http://desk.test/api/desk/agent-events");
    expect(requests[0]!.init.method).toBe("POST");
    expect(requests[0]!.init.headers).toMatchObject({ "X-Tango-Collaboration-Token": "tok", "Content-Type": "application/json" });
  });

  it("omits the token header when no token is configured", () => {
    const { requests, fetchImpl } = recorder();
    createDeskEventsClient({ endpoint: "http://desk.test/x", enabled: true, fetchImpl }).startTurn(identity);
    expect(requests[0]!.init.headers).not.toHaveProperty("X-Tango-Collaboration-Token");
  });

  it("reports a classified failure", () => {
    const { events, fetchImpl } = recorder();
    const turn = createDeskEventsClient({ endpoint: "http://desk.test/x", enabled: true, fetchImpl }).startTurn(identity);
    turn.fail(new ClaudeCodeTimeoutError(900_000, true));
    expect(events.at(-1)).toMatchObject({ type: "turn.failed", error: { reason: "timeout" } });
  });

  it("throttles activity to one per window, sends the latest line, and drops it after the turn ends", () => {
    vi.useFakeTimers();
    let clock = 0;
    const { events, fetchImpl } = recorder();
    const client = createDeskEventsClient({ endpoint: "http://desk.test/x", enabled: true, fetchImpl, now: () => clock });
    const turn = client.startTurn(identity, { turnId: "t" });
    const activity = () => events.filter((event) => event.type === "turn.activity").map((event) => event.activity);

    turn.onEvent({ type: "tool_use", name: "Read", activity: "Reading a.ts", at: 0 });
    turn.activity("Reading b.ts");
    turn.activity("Running npm test");
    expect(activity()).toEqual(["Reading a.ts"]);

    clock = 2_000;
    vi.advanceTimersByTime(2_000);
    expect(activity()).toEqual(["Reading a.ts", "Running npm test"]);

    clock = 2_500;
    turn.activity("Editing c.ts");
    turn.finish();
    clock = 5_000;
    vi.advanceTimersByTime(5_000);
    expect(activity()).toEqual(["Reading a.ts", "Running npm test"]);
    expect(events.at(-1)?.type).toBe("turn.finished");
  });

  it("is a silent no-op when disabled", () => {
    const { fetchImpl } = recorder();
    const turn = createDeskEventsClient({ endpoint: "http://desk.test/x", enabled: false, fetchImpl }).startTurn(identity);
    turn.activity("Reading a.ts");
    turn.finish();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never throws into the turn when the desk is down or fetch throws synchronously", async () => {
    const log = vi.fn();
    const rejecting = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const turn = createDeskEventsClient({ endpoint: "http://desk.test/x", enabled: true, fetchImpl: rejecting, log }).startTurn(identity);
    expect(() => turn.finish()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).toHaveBeenCalledTimes(1);

    const throwing = vi.fn(() => { throw new Error("sync"); }) as unknown as typeof fetch;
    expect(() => createDeskEventsClient({ endpoint: "http://desk.test/x", enabled: true, fetchImpl: throwing }).startTurn(identity).finish())
      .not.toThrow();
  });

  it("the no-op tracker reports nothing", () => {
    expect(() => {
      NOOP_DESK_TURN.activity("x");
      NOOP_DESK_TURN.onEvent({ type: "tool_use", name: "Read", activity: "x", at: 0 });
      NOOP_DESK_TURN.finish();
      NOOP_DESK_TURN.fail(new Error("x"));
    }).not.toThrow();
  });
});

describe("failure classification", () => {
  it.each([
    [new Error("Claude Code request timed out after 900000ms."), "timeout"],
    [Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }), "timeout"],
    [new Error("Claude Code exited with code 1. stderr=API Error: 529 overloaded_error"), "overloaded"],
    [new Error("Claude AI usage limit reached|1760000000"), "usage-limit"],
    [new Error("Failed to authenticate. API Error: 401"), "auth"],
    [new Error("something else"), "error"],
    ["plain string", "error"],
  ])("%s -> %s", (error, reason) => {
    expect(classifyDeskTurnFailure(error).reason).toBe(reason);
  });

  it("clips long messages", () => {
    expect(classifyDeskTurnFailure(new Error("x".repeat(1000))).message.length).toBeLessThanOrEqual(300);
  });

  it("treats a runtime error response as failed and a normal response as not", () => {
    expect(runtimeErrorResponseFailure({ text: "API Error: 529 overloaded", metadata: { error: true } }))
      .toMatchObject({ reason: "overloaded" });
    expect(runtimeErrorResponseFailure({ text: "", metadata: { error: true, stderr: "segfault" } }))
      .toMatchObject({ reason: "error", message: "segfault" });
    expect(runtimeErrorResponseFailure({ text: "Done.", metadata: {} })).toBeNull();
  });
});
