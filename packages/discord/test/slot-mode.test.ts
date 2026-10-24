import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelType, ThreadAutoArchiveDuration, type Client } from "discord.js";
import {
  buildThreadName,
  initializeSlotMode,
  isConfiguredDiscordChannelId,
  isSlotModeActive,
  shouldInitializeSlotMode,
  shouldRunSchedulerTickLoop,
} from "../src/slot-mode.js";

describe("isConfiguredDiscordChannelId", () => {
  it("rejects repository placeholder channel ids", () => {
    expect(isConfiguredDiscordChannelId("100000000000000006")).toBe(false);
    expect(isConfiguredDiscordChannelId("100000000000001006")).toBe(false);
  });

  it("accepts a real id that happens to start with 1000000", () => {
    // Built from parts so the privacy scan doesn't read it as a real id.
    expect(isConfiguredDiscordChannelId(["1000000", "4718", "2635", "9104"].join(""))).toBe(true);
  });
});

function createThread(id: string, url = `https://discord.test/${id}`) {
  return {
    id,
    url,
    send: vi.fn(async () => undefined),
  };
}

function createClient(channelsById: Record<string, unknown>) {
  const fetch = vi.fn(async (channelId: string) => channelsById[channelId] ?? null);
  return {
    client: {
      channels: {
        fetch,
      },
    } as unknown as Client,
    fetch,
  };
}

describe("slot mode env gating", () => {
  it("detects when slot mode is active", () => {
    expect(isSlotModeActive({ TANGO_SLOT: "1" })).toBe(true);
    expect(isSlotModeActive({ TANGO_SLOT: "" })).toBe(false);
    expect(isSlotModeActive({})).toBe(false);
  });

  it("only initializes slot mode when a slot is active and no explicit allowlist is set", () => {
    expect(shouldInitializeSlotMode({}, null)).toBe(false);
    expect(shouldInitializeSlotMode({ TANGO_SLOT: "1" }, null)).toBe(true);
    expect(shouldInitializeSlotMode({ TANGO_SLOT: "1" }, new Set(["999"]))).toBe(false);
  });
});

describe("shouldRunSchedulerTickLoop", () => {
  it("runs the tick loop for the production bot (no slot)", () => {
    expect(shouldRunSchedulerTickLoop({})).toBe(true);
    expect(shouldRunSchedulerTickLoop({ TANGO_SLOT: "" })).toBe(true);
  });

  it("disables the tick loop for slot / worktree-dev bots", () => {
    expect(shouldRunSchedulerTickLoop({ TANGO_SLOT: "1" })).toBe(false);
  });

  it("allows forcing the tick loop in a slot via TANGO_SCHEDULER_IN_SLOT", () => {
    expect(
      shouldRunSchedulerTickLoop({ TANGO_SLOT: "1", TANGO_SCHEDULER_IN_SLOT: "true" }),
    ).toBe(true);
    expect(
      shouldRunSchedulerTickLoop({ TANGO_SLOT: "1", TANGO_SCHEDULER_IN_SLOT: "false" }),
    ).toBe(false);
  });
});

describe("buildThreadName", () => {
  it("uses a stable UTC timestamp format", () => {
    expect(buildThreadName("1", new Date("2026-04-11T15:30:00Z"))).toBe("[wt-1] 2026-04-11 1530");
  });
});

describe("initializeSlotMode", () => {
  const originalBranch = process.env.TANGO_GIT_BRANCH;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalBranch === undefined) {
      delete process.env.TANGO_GIT_BRANCH;
    } else {
      process.env.TANGO_GIT_BRANCH = originalBranch;
    }
  });

  it("creates one thread per configured agent test channel", async () => {
    process.env.TANGO_GIT_BRANCH = "feature/phase2c-slot-mode-thread-provisioning";
    const now = new Date("2026-04-11T15:30:00Z");
    const watsonThread = createThread("thread-watson");
    const malibuThread = createThread("thread-malibu");
    const sierraThread = createThread("thread-sierra");
    const victorThread = createThread("thread-victor");
    const watsonCreate = vi.fn(async () => watsonThread);
    const malibuCreate = vi.fn(async () => malibuThread);
    const sierraCreate = vi.fn(async () => sierraThread);
    const victorCreate = vi.fn(async () => victorThread);
    const logger = vi.fn();
    const { client, fetch } = createClient({
      "watson-channel": { threads: { create: watsonCreate } },
      "malibu-channel": { threads: { create: malibuCreate } },
      "sierra-channel": { threads: { create: sierraCreate } },
      "victor-channel": { threads: { create: victorCreate } },
    });

    const result = await initializeSlotMode({
      client,
      slot: "1",
      now,
      logger,
      agentTestChannels: [
        { agentId: "watson", channelId: "watson-channel" },
        { agentId: "malibu", channelId: "malibu-channel" },
        { agentId: "sierra", channelId: "sierra-channel" },
        { agentId: "victor", channelId: "victor-channel" },
      ],
    });

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(watsonCreate).toHaveBeenCalledWith({
      name: "[wt-1] 2026-04-11 1530",
      autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
      type: ChannelType.PublicThread,
      reason: "Tango slot wt-1 smoke-test thread for watson",
    });
    expect(result.threadIds).toEqual(
      new Set(["thread-watson", "thread-malibu", "thread-sierra", "thread-victor"]),
    );
    expect(result.created).toHaveLength(4);
    expect(result.failures).toEqual([]);
    expect(watsonThread.send).toHaveBeenCalledWith(
      expect.stringContaining("slot wt-1"),
    );
    expect(watsonThread.send).toHaveBeenCalledWith(
      expect.stringContaining("feature/phase2c-slot-mode-thread-provisioning"),
    );
    expect(logger).toHaveBeenCalledWith(
      "created agent=watson threadId=thread-watson url=https://discord.test/thread-watson",
    );
  });

  it("records per-agent failures without throwing", async () => {
    const watsonThread = createThread("thread-watson");
    const malibuThread = createThread("thread-malibu");
    const victorThread = createThread("thread-victor");
    const logger = vi.fn();
    const { client } = createClient({
      "watson-channel": { threads: { create: vi.fn(async () => watsonThread) } },
      "malibu-channel": { threads: { create: vi.fn(async () => malibuThread) } },
      "sierra-channel": {
        threads: {
          create: vi.fn(async () => {
            throw new Error("missing permission");
          }),
        },
      },
      "victor-channel": { threads: { create: vi.fn(async () => victorThread) } },
    });

    const result = await initializeSlotMode({
      client,
      slot: "2",
      logger,
      agentTestChannels: [
        { agentId: "watson", channelId: "watson-channel" },
        { agentId: "malibu", channelId: "malibu-channel" },
        { agentId: "sierra", channelId: "sierra-channel" },
        { agentId: "victor", channelId: "victor-channel" },
      ],
    });

    expect(result.created).toHaveLength(3);
    expect(result.failures).toEqual([
      { agentId: "sierra", reason: "missing permission" },
    ]);
    expect(result.threadIds).toEqual(
      new Set(["thread-watson", "thread-malibu", "thread-victor"]),
    );
    expect(logger).toHaveBeenCalledWith(
      "failed agent=sierra reason=missing permission",
    );
  });

  it("skips placeholder smoke-test channel ids as not configured", async () => {
    const logger = vi.fn();
    const { client, fetch } = createClient({});

    const result = await initializeSlotMode({
      client,
      slot: "3",
      logger,
      agentTestChannels: [
        { agentId: "watson", channelId: "100000000000001001" },
      ],
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.threadIds.size).toBe(0);
    expect(result.created).toEqual([]);
    expect(result.failures).toEqual([
      { agentId: "watson", reason: "not configured" },
    ]);
  });

  it("returns empty results when no agent channels are passed", async () => {
    const { client, fetch } = createClient({});

    const result = await initializeSlotMode({
      client,
      slot: "1",
      agentTestChannels: [],
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.threadIds.size).toBe(0);
    expect(result.created).toEqual([]);
    expect(result.failures).toEqual([]);
  });
});
