import { describe, expect, it } from "vitest";
import { emptyToolTelemetry, extractToolTelemetry } from "../src/tool-telemetry.js";

describe("tool telemetry", () => {
  it("returns empty telemetry when provider raw payload is unavailable", () => {
    expect(extractToolTelemetry(null)).toEqual(emptyToolTelemetry());
  });

  it("captures weather/search usage from server tool counters", () => {
    const telemetry = extractToolTelemetry({
      usage: {
        server_tool_use: {
          web_search_requests: 1
        }
      },
      permission_denials: []
    });

    expect(telemetry.usedTools).toEqual(["WebSearch"]);
    expect(telemetry.deniedTools).toEqual([]);
    expect(telemetry.usageByTool).toEqual({ WebSearch: 1 });
    expect(telemetry.denialCount).toBe(0);
  });

  it("captures url-summary usage and denied tool attempts", () => {
    const telemetry = extractToolTelemetry({
      usage: {
        server_tool_use: {
          web_fetch_requests: 2
        }
      },
      permission_denials: [
        {
          tool_name: "WebFetch"
        }
      ]
    });

    expect(telemetry.usedTools).toEqual(["WebFetch"]);
    expect(telemetry.deniedTools).toEqual(["WebFetch"]);
    expect(telemetry.usageByTool).toEqual({ WebFetch: 2 });
    expect(telemetry.denialCount).toBe(1);
  });
});

