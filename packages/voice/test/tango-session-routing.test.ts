import { describe, expect, it } from "vitest";
import { resolveVoiceTangoRoute } from "../src/index.js";

describe("tango session routing", () => {
  it("uses tango-config routes for explicit discord text channels", () => {
    const sessionManager = {
      route(channelKey: string) {
        if (channelKey === "discord:12345") {
          return {
            sessionId: "tango-default",
            agentId: "watson"
          };
        }
        return null;
      },
      listSessions() {
        return [];
      }
    };

    expect(
      resolveVoiceTangoRoute({
        sessionManager,
        channelId: "12345",
        fallbackSessionId: "agent:main:discord:channel:12345",
        fallbackAgentId: "watson"
      })
    ).toEqual({
      sessionId: "tango-default",
      agentId: "watson",
      source: "tango-config",
      channelKey: "discord:12345",
      matchedChannelKey: "discord:12345",
      routeAgentId: "watson"
    });
  });

  it("falls back to discord:default when an explicit channel has no route", () => {
    const sessionManager = {
      route(channelKey: string) {
        if (channelKey === "discord:default") {
          return {
            sessionId: "tango-default",
            agentId: "watson"
          };
        }
        return null;
      },
      listSessions() {
        return [];
      }
    };

    expect(
      resolveVoiceTangoRoute({
        sessionManager,
        channelId: "99999",
        fallbackSessionId: "agent:main:discord:channel:99999",
        fallbackAgentId: "watson"
      })
    ).toEqual({
      sessionId: "tango-default",
      agentId: "watson",
      source: "tango-config",
      channelKey: "discord:99999",
      matchedChannelKey: "discord:default",
      routeAgentId: "watson"
    });
  });

  it("uses discord:default tango route when no explicit channel is provided", () => {
    const sessionManager = {
      route(channelKey: string) {
        if (channelKey === "discord:default") {
          return {
            sessionId: "tango-default",
            agentId: "watson"
          };
        }
        return null;
      },
      listSessions() {
        return [];
      }
    };

    expect(
      resolveVoiceTangoRoute({
        sessionManager,
        fallbackSessionId: "agent:main:main",
        fallbackAgentId: "watson"
      })
    ).toEqual({
      sessionId: "tango-default",
      agentId: "watson",
      source: "tango-config",
      channelKey: "discord:default",
      matchedChannelKey: "discord:default",
      routeAgentId: "watson"
    });
  });

  it("falls back to the legacy voice session when tango has no route", () => {
    expect(
      resolveVoiceTangoRoute({
        sessionManager: {
          route() {
            return null;
          },
          listSessions() {
            return [];
          }
        },
        channelId: "99999",
        fallbackSessionId: "agent:main:discord:channel:99999",
        fallbackAgentId: "watson"
      })
    ).toEqual({
      sessionId: "agent:main:discord:channel:99999",
      agentId: "watson",
      source: "fallback",
      channelKey: "discord:99999"
    });
  });
});
