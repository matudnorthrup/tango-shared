import { describe, expect, it, vi } from "vitest";
import type { ContextUsageSnapshotRecord } from "@tango/core";

import {
  buildContextSnapshotQueryPatterns,
  classifyContextSnapshotSource,
  parseSnapshotTimestamp,
  resolvePersistedContextReadings,
  selectFreshestContextReadings,
  toLastContextUsageSnapshot,
} from "../src/context-snapshots.js";

const POST = "1385000000000000000";

function row(overrides: Partial<ContextUsageSnapshotRecord>): ContextUsageSnapshotRecord {
  return {
    conversationKey: `thread:${POST}`,
    agentId: "alpha",
    fraction: 0.31,
    usedTokens: 62_000,
    contextWindow: 200_000,
    recordedAt: "2026-07-12T10:00:00.000Z",
    ...overrides,
  };
}

describe("context-snapshots (T-I-035)", () => {
  it("classifies typed and voice key shapes", () => {
    expect(classifyContextSnapshotSource(`thread:${POST}`)).toBe("typed");
    expect(classifyContextSnapshotSource(`channel:${POST}`)).toBe("typed");
    // voice conversation key: session key + agent suffix
    expect(classifyContextSnapshotSource(`agent:alpha:discord:channel:${POST}:alpha`)).toBe("voice");
    // voice-thread variant carries an extra thread-channel suffix
    expect(classifyContextSnapshotSource(`agent:alpha:discord:channel:${POST}:alpha:222`)).toBe("voice");
    // other families are neither
    expect(classifyContextSnapshotSource("schedule-v2:alpha-slack-sync")).toBeUndefined();
    expect(classifyContextSnapshotSource("agent:alpha:main:alpha")).toBeUndefined();
  });

  it("builds thread-scoped query patterns (exact thread key + both LIKE shapes)", () => {
    const patterns = buildContextSnapshotQueryPatterns({ routingChannelId: "111", threadId: "222" });
    expect(patterns.exactKeys).toEqual(["thread:222"]);
    expect(patterns.likePatterns).toEqual([
      "%discord:channel:222",
      "%discord:channel:222:%",
      "%discord:channel:111",
      "%discord:channel:111:%",
    ]);
  });

  it("builds channel-scoped query patterns when there is no thread", () => {
    const patterns = buildContextSnapshotQueryPatterns({ routingChannelId: "111" });
    expect(patterns.exactKeys).toEqual(["channel:111"]);
    expect(patterns.likePatterns).toEqual(["%discord:channel:111", "%discord:channel:111:%"]);
  });

  it("selects the freshest reading per session type across key shapes (V4)", () => {
    const readings = selectFreshestContextReadings([
      row({ recordedAt: "2026-07-12T10:00:00.000Z", fraction: 0.28 }),
      row({ recordedAt: "2026-07-12T10:06:00.000Z", fraction: 0.31 }),
      row({
        conversationKey: `agent:alpha:discord:channel:${POST}:alpha`,
        recordedAt: "2026-07-12T10:04:00.000Z",
        fraction: 0.62,
      }),
      row({
        conversationKey: `agent:alpha:discord:channel:${POST}:alpha:222`,
        recordedAt: "2026-07-12T09:00:00.000Z",
        fraction: 0.55,
      }),
      // unclassifiable keys are excluded, never miscounted
      row({ conversationKey: "schedule-v2:sync", fraction: 0.99 }),
    ]);

    expect(readings.typed?.fraction).toBeCloseTo(0.31, 4);
    expect(readings.typed?.recordedAt.toISOString()).toBe("2026-07-12T10:06:00.000Z");
    expect(readings.voice?.fraction).toBeCloseTo(0.62, 4);
    expect(readings.voice?.source).toBe("voice");
  });

  it("resolves readings through the query and reports the store healthy", () => {
    const query = vi.fn(() => [
      row({}),
      row({
        conversationKey: `agent:alpha:discord:channel:${POST}:alpha`,
        fraction: 0.62,
        recordedAt: "2026-07-12T10:04:00.000Z",
      }),
    ]);

    const result = resolvePersistedContextReadings({
      query,
      agentId: "alpha",
      routingChannelId: "111",
      threadId: POST,
    });

    expect(query).toHaveBeenCalledWith({
      agentId: "alpha",
      exactKeys: [`thread:${POST}`],
      likePatterns: [`%discord:channel:${POST}`, `%discord:channel:${POST}:%`, "%discord:channel:111", "%discord:channel:111:%"],
    });
    expect(result.unavailable).toBe(false);
    expect(result.typed?.fraction).toBeCloseTo(0.31, 4);
    expect(result.voice?.fraction).toBeCloseTo(0.62, 4);
  });

  it("degrades honestly when the snapshot store throws: no crash, no fake reading (V8)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = resolvePersistedContextReadings({
        query: () => {
          throw new Error("no such table: context_usage_snapshots");
        },
        agentId: "alpha",
        routingChannelId: "111",
      });

      expect(result.unavailable).toBe(true);
      expect(result.typed).toBeUndefined();
      expect(result.voice).toBeUndefined();
      expect(
        warnSpy.mock.calls.some((call) => String(call[0]).includes("persisted snapshot query failed")),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("parses both writer ISO strings and SQLite datetime('now') defaults as UTC", () => {
    expect(parseSnapshotTimestamp("2026-07-12T10:00:00.000Z").toISOString())
      .toBe("2026-07-12T10:00:00.000Z");
    expect(parseSnapshotTimestamp("2026-07-12 10:00:00").toISOString())
      .toBe("2026-07-12T10:00:00.000Z");
  });

  it("converts a persisted reading to the RAM snapshot shape (whisper fallback)", () => {
    const snapshot = toLastContextUsageSnapshot({
      fraction: 0.62,
      usedTokens: 124_000,
      contextWindow: 200_000,
      recordedAt: new Date("2026-07-12T10:04:00.000Z"),
    });

    expect(snapshot).toEqual({
      fraction: 0.62,
      totalTokens: 124_000,
      contextWindow: 200_000,
      recordedAt: new Date("2026-07-12T10:04:00.000Z"),
    });
  });
});
