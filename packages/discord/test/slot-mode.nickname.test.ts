import { describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import { applySlotNickname, resetBotNickname } from "../src/slot-mode.js";

function createClientWithGuilds(guildsById: Record<string, unknown>) {
  return {
    client: {
      guilds: {
        cache: new Map(Object.entries(guildsById)),
      },
    } as unknown as Client,
  };
}

describe("slot mode nickname handling", () => {
  it("applies the slot nickname to the first available guild member", async () => {
    const setNickname = vi.fn(async () => undefined);
    const logger = vi.fn();
    const { client } = createClientWithGuilds({
      "guild-1": {
        id: "guild-1",
        members: {
          me: { setNickname },
        },
      },
    });

    const result = await applySlotNickname({
      client,
      slot: "1",
      logger,
    });

    expect(setNickname).toHaveBeenCalledWith("Tango [wt-1]");
    expect(logger).toHaveBeenCalledWith("nickname set=Tango [wt-1]");
    expect(result).toEqual({
      ok: true,
      nickname: "Tango [wt-1]",
    });
  });

  it("uses the configured guild id when resetting the nickname", async () => {
    const primarySetNickname = vi.fn(async () => undefined);
    const secondarySetNickname = vi.fn(async () => undefined);
    const logger = vi.fn();
    const { client } = createClientWithGuilds({
      "guild-1": {
        id: "guild-1",
        members: {
          me: { setNickname: primarySetNickname },
        },
      },
      "guild-2": {
        id: "guild-2",
        members: {
          me: { setNickname: secondarySetNickname },
        },
      },
    });

    const result = await resetBotNickname({
      client,
      guildId: "guild-2",
      nickname: "Tango",
      logger,
    });

    expect(primarySetNickname).not.toHaveBeenCalled();
    expect(secondarySetNickname).toHaveBeenCalledWith("Tango");
    expect(logger).toHaveBeenCalledWith("nickname reset=Tango");
    expect(result).toEqual({
      ok: true,
      nickname: "Tango",
    });
  });

  it("clears the nickname when no explicit prod nickname is provided", async () => {
    const setNickname = vi.fn(async () => undefined);
    const logger = vi.fn();
    const { client } = createClientWithGuilds({
      "guild-1": {
        id: "guild-1",
        members: {
          me: { setNickname },
        },
      },
    });

    const result = await resetBotNickname({
      client,
      logger,
    });

    expect(setNickname).toHaveBeenCalledWith(null);
    expect(logger).toHaveBeenCalledWith("nickname reset");
    expect(result).toEqual({
      ok: true,
      nickname: null,
    });
  });

  it("returns a failure result instead of throwing when nickname changes fail", async () => {
    const logger = vi.fn();
    const { client } = createClientWithGuilds({
      "guild-1": {
        id: "guild-1",
        members: {
          me: {
            setNickname: vi.fn(async () => {
              throw new Error("missing permission");
            }),
          },
        },
      },
    });

    const result = await applySlotNickname({
      client,
      slot: "2",
      logger,
    });

    expect(result).toEqual({
      ok: false,
      nickname: "Tango [wt-2]",
      reason: "missing permission",
    });
    expect(logger).toHaveBeenCalledWith("nickname failed reason=missing permission");
  });
});
