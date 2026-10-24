import { describe, expect, it } from "vitest";
import { parseSharedSystemRoutingCommand } from "../src/system-routing.js";

describe("parseSharedSystemRoutingCommand", () => {
  it("parses focus-agent phrases", () => {
    expect(parseSharedSystemRoutingCommand("talk to Watson")).toEqual({
      type: "focus-agent",
      agentQuery: "watson"
    });
    expect(parseSharedSystemRoutingCommand("switch agent to Malibu")).toEqual({
      type: "focus-agent",
      agentQuery: "malibu"
    });
  });

  it("parses clear-focus phrases", () => {
    expect(parseSharedSystemRoutingCommand("back to Tango")).toEqual({
      type: "clear-focus"
    });
    expect(parseSharedSystemRoutingCommand("leave focus mode")).toEqual({
      type: "clear-focus"
    });
  });

  it("parses current-agent phrases", () => {
    expect(parseSharedSystemRoutingCommand("who am I talking to?")).toEqual({
      type: "current-agent"
    });
    expect(parseSharedSystemRoutingCommand("current agent")).toEqual({
      type: "current-agent"
    });
  });

  it("returns null for non-routing text", () => {
    expect(parseSharedSystemRoutingCommand("status")).toBeNull();
    expect(parseSharedSystemRoutingCommand("what system are you connected to")).toBeNull();
  });
});
