import type { AgentConfig } from "@tango/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentTypingPresenter,
  resolveAgentTypingToken,
  resolveTypingTokenFromEnv,
  triggerAgentTyping,
} from "../src/agent-typing-presenter.js";

function createAgent(
  overrides: Partial<AgentConfig> & Pick<AgentConfig, "id" | "type">
): AgentConfig {
  return {
    provider: { default: "codex" },
    ...overrides,
  };
}

describe("resolveTypingTokenFromEnv", () => {
  it("reads the configured env var name", () => {
    expect(
      resolveTypingTokenFromEnv("WELLNESS_DISCORD_TOKEN", {
        WELLNESS_DISCORD_TOKEN: "wellness-token",
      })
    ).toBe("wellness-token");
  });

  it("returns undefined when the env var is missing or empty", () => {
    expect(resolveTypingTokenFromEnv("WELLNESS_DISCORD_TOKEN", {})).toBeUndefined();
    expect(
      resolveTypingTokenFromEnv("WELLNESS_DISCORD_TOKEN", {
        WELLNESS_DISCORD_TOKEN: "   ",
      })
    ).toBeUndefined();
  });
});

describe("resolveAgentTypingToken", () => {
  it("uses the agent discord typing token env var", () => {
    expect(
      resolveAgentTypingToken(
        createAgent({
          id: "wellness",
          type: "wellness",
          discord: { typingTokenEnv: "WELLNESS_DISCORD_TOKEN" },
        }),
        { WELLNESS_DISCORD_TOKEN: "wellness-token" }
      )
    ).toBe("wellness-token");
  });
});

describe("triggerAgentTyping", () => {
  it("posts to the Discord typing endpoint with the bot token", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));

    await expect(
      triggerAgentTyping("100000000000000202", "wellness-token", { fetchImpl })
    ).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/100000000000000202/typing",
      {
        method: "POST",
        headers: {
          Authorization: "Bot wellness-token",
        },
      }
    );
  });
});

describe("createAgentTypingPresenter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("suppresses typing when the agent has no configured token", () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const presenter = createAgentTypingPresenter({
      resolveAgentTypingToken: () => undefined,
      fetchImpl,
    });

    const session = presenter.start("wellness", "channel-1");
    session.stop();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the default token when the agent has no configured token", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const presenter = createAgentTypingPresenter({
      resolveAgentTypingToken: () => undefined,
      defaultToken: "default-token",
      fetchImpl,
    });

    const session = presenter.start("wellness", "channel-1");
    await Promise.resolve();
    session.stop();

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/channel-1/typing",
      {
        method: "POST",
        headers: {
          Authorization: "Bot default-token",
        },
      }
    );
  });

  it("uses the per-agent token before the default token", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const presenter = createAgentTypingPresenter({
      resolveAgentTypingToken: () => "wellness-token",
      defaultToken: "default-token",
      fetchImpl,
    });

    const session = presenter.start("wellness", "channel-1");
    await Promise.resolve();
    session.stop();

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/channel-1/typing",
      {
        method: "POST",
        headers: {
          Authorization: "Bot wellness-token",
        },
      }
    );
  });

  it("does nothing when neither token is present", () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const presenter = createAgentTypingPresenter({
      resolveAgentTypingToken: () => undefined,
      fetchImpl,
    });

    const session = presenter.start("wellness", "channel-1");
    session.stop();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("pulses typing through the agent token and stops on cleanup", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const presenter = createAgentTypingPresenter({
      resolveAgentTypingToken: (agentId) =>
        agentId === "wellness" ? "wellness-token" : undefined,
      fetchImpl,
      refreshIntervalMs: 8_000,
    });

    const session = presenter.start("wellness", "channel-1");
    await Promise.resolve();

    expect(fetchImpl).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(8_000);
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    session.stop();
    vi.advanceTimersByTime(8_000);
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
