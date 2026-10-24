import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/session-manager.js";

describe("SessionManager", () => {
  it("routes channel key to configured session", () => {
    const manager = new SessionManager([
      {
        id: "tango-default",
        type: "persistent",
        agent: "dispatch",
        channels: ["discord:default"]
      }
    ]);

    expect(manager.route("discord:default")).toEqual({
      sessionId: "tango-default",
      agentId: "dispatch"
    });
  });

  it("returns null when channel key is unknown", () => {
    const manager = new SessionManager([]);
    expect(manager.route("discord:missing")).toBeNull();
  });
});
