import { describe, expect, it } from "vitest";
import {
  buildProjectSessionId,
  buildProjectScopedSessionId,
  parseProjectSessionId,
  parseSharedProjectSystemCommand,
} from "../src/project-routing.js";

describe("project routing", () => {
  it("builds hidden project session ids", () => {
    expect(buildProjectSessionId("tango")).toBe("project:tango");
  });

  it("builds scoped project session ids for isolated test sessions", () => {
    expect(buildProjectScopedSessionId("wellness", "smoke-malibu")).toBe("project:wellness#smoke-malibu");
  });

  it("parses project session ids back to project ids", () => {
    expect(parseProjectSessionId("project:tango")).toBe("tango");
    expect(parseProjectSessionId(" project:wellness ")).toBe("wellness");
    expect(parseProjectSessionId("project:wellness#smoke-malibu")).toBe("wellness");
    expect(parseProjectSessionId("tango-default")).toBeNull();
    expect(parseProjectSessionId("project:")).toBeNull();
  });

  it("parses open/current/clear project commands", () => {
    expect(parseSharedProjectSystemCommand("open project tango")).toEqual({
      type: "open-project",
      projectName: "tango",
    });
    expect(parseSharedProjectSystemCommand("current project")).toEqual({
      type: "current-project",
    });
    expect(parseSharedProjectSystemCommand("clear project")).toEqual({
      type: "clear-project",
    });
  });
});
