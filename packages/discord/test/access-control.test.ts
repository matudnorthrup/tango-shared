import type { AgentConfig, SessionConfig } from "@tango/core";
import { describe, expect, it } from "vitest";
import {
  buildDefaultAccessPolicy,
  evaluateAccess,
  extractConfiguredDiscordChannelIds,
  resolveAccessPolicy
} from "../src/access-control.js";

function createAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "watson",
    type: "personal",
    provider: { default: "claude-oauth" },
    ...overrides
  };
}

describe("access-control", () => {
  it("extracts configured Discord channel IDs from sessions", () => {
    const sessions: SessionConfig[] = [
      {
        id: "default",
        type: "persistent",
        agent: "dispatch",
        channels: ["discord:default", "discord:123", "discord:456"]
      },
      {
        id: "project",
        type: "project",
        agent: "watson",
        channels: ["discord:123", "discord:789", "slack:general"]
      }
    ];

    expect(extractConfiguredDiscordChannelIds(sessions).sort()).toEqual(["123", "456", "789"]);
  });

  it("resolves per-agent access policy with default fallback", () => {
    const defaults = buildDefaultAccessPolicy({
      mode: "allowlist",
      allowlistChannelIds: ["channel-a"],
      allowlistUserIds: ["user-a"]
    });

    const inherited = resolveAccessPolicy(createAgent(), defaults);
    expect(inherited.mode).toBe("allowlist");
    expect([...inherited.allowlistChannelIds]).toEqual(["channel-a"]);
    expect([...inherited.allowlistUserIds]).toEqual(["user-a"]);

    const overridden = resolveAccessPolicy(
      createAgent({
        access: {
          mode: "both",
          allowlistChannelIds: ["channel-b"],
          allowlistUserIds: ["user-b"]
        }
      }),
      defaults
    );
    expect(overridden.mode).toBe("both");
    expect([...overridden.allowlistChannelIds]).toEqual(["channel-b"]);
    expect([...overridden.allowlistUserIds]).toEqual(["user-b"]);
  });

  it("evaluates allowlist + mention requirements", () => {
    const bothPolicy = buildDefaultAccessPolicy({
      mode: "both",
      allowlistChannelIds: ["channel-1"],
      allowlistUserIds: ["user-1"]
    });

    const missingMention = evaluateAccess(
      {
        channelId: "channel-1",
        userId: "user-1",
        mentioned: false
      },
      bothPolicy
    );
    expect(missingMention.allowed).toBe(false);
    expect(missingMention.reason).toBe("missing-mention");

    const blockedUser = evaluateAccess(
      {
        channelId: "channel-1",
        userId: "user-2",
        mentioned: true
      },
      bothPolicy
    );
    expect(blockedUser.allowed).toBe(false);
    expect(blockedUser.reason).toBe("user-not-allowlisted");

    const allowed = evaluateAccess(
      {
        channelId: "channel-1",
        userId: "user-1",
        mentioned: true
      },
      bothPolicy
    );
    expect(allowed.allowed).toBe(true);
    expect(allowed.reason).toBe("ok");
  });

  it("allows forum thread ID when parent channel is routed for allowlist", () => {
    const policy = buildDefaultAccessPolicy({
      mode: "allowlist",
      allowlistChannelIds: ["100000000000000101"],
      allowlistUserIds: []
    });

    const allowed = evaluateAccess(
      {
        channelId: "100000000000000100",
        threadChannelId: "100000000000000101",
        userId: "any-user",
        mentioned: true
      },
      policy
    );
    expect(allowed.allowed).toBe(true);
    expect(allowed.channelAllowed).toBe(true);
  });
});
