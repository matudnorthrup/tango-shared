import { describe, expect, it } from "vitest";
import {
  buildCurrentTurnMetadataPrompt,
  resolveCurrentTurnTimeZone,
} from "../src/current-turn-metadata.js";

describe("buildCurrentTurnMetadataPrompt", () => {
  it("formats UTC timestamps in the configured local timezone", () => {
    const prompt = buildCurrentTurnMetadataPrompt({
      timestamp: "2026-05-31T04:08:18.000Z",
      timestampSource: "discord-sent",
      config: {
        timeZone: "America/Los_Angeles",
      },
    });

    expect(prompt).toContain("Current user message metadata:");
    expect(prompt).toContain("- calendar_day: Saturday");
    expect(prompt).toContain("- local_date: Saturday, May 30, 2026");
    expect(prompt).toContain("- local_time: 9:08 PM PDT");
    expect(prompt).toContain("- timezone: America/Los_Angeles");
    expect(prompt).toContain("- timestamp_utc: 2026-05-31T04:08:18.000Z");
    expect(prompt).toContain("- timestamp_source: discord-sent");
  });

  it("supports agent-level timezone and time format overrides", () => {
    const mountainPrompt = buildCurrentTurnMetadataPrompt({
      timestamp: "2026-05-31T04:08:18.000Z",
      timestampSource: "discord-sent",
      config: {
        timeZone: "America/Denver",
      },
    });
    const twentyFourHourPrompt = buildCurrentTurnMetadataPrompt({
      timestamp: "2026-05-31T04:08:18.000Z",
      timestampSource: "discord-sent",
      config: {
        timeZone: "America/Los_Angeles",
        timeFormat: "24h",
      },
    });

    expect(mountainPrompt).toContain("- local_time: 10:08 PM MDT");
    expect(mountainPrompt).toContain("- timezone: America/Denver");
    expect(twentyFourHourPrompt).toContain("- local_time: 21:08 PDT");
  });

  it("falls back through env timezones and then the system default", () => {
    expect(resolveCurrentTurnTimeZone(undefined, {
      TANGO_TIME_ZONE: "Invalid/Zone",
      TZ: "America/Denver",
    })).toBe("America/Denver");

    expect(resolveCurrentTurnTimeZone("Invalid/Zone", {
      TANGO_TIME_ZONE: "Still/Invalid",
      TZ: "Also/Invalid",
    })).toBe("America/Los_Angeles");
  });

  it("includes discord channel and thread ids when provided", () => {
    const channelOnly = buildCurrentTurnMetadataPrompt({
      timestamp: "2026-05-31T04:08:18.000Z",
      timestampSource: "discord-sent",
      config: { timeZone: "UTC" },
      discord: { channelId: "100000000000000003" },
    });
    const channelAndThread = buildCurrentTurnMetadataPrompt({
      timestamp: "2026-05-31T04:08:18.000Z",
      timestampSource: "discord-sent",
      config: { timeZone: "UTC" },
      discord: { channelId: "100000000000000003", threadId: "200000000000000007" },
    });
    const noDiscord = buildCurrentTurnMetadataPrompt({
      timestamp: "2026-05-31T04:08:18.000Z",
      timestampSource: "discord-sent",
      config: { timeZone: "UTC" },
    });

    expect(channelOnly).toContain("- discord_channel_id: 100000000000000003");
    expect(channelOnly).not.toContain("discord_thread_id");
    expect(channelAndThread).toContain("- discord_channel_id: 100000000000000003");
    expect(channelAndThread).toContain("- discord_thread_id: 200000000000000007");
    expect(noDiscord).not.toContain("discord_channel_id");
  });

  it("uses a bounded runtime timestamp when the inbound timestamp is missing or invalid", () => {
    const prompt = buildCurrentTurnMetadataPrompt({
      timestamp: "not-a-date",
      timestampSource: "discord-sent\nwith newline",
      now: new Date("2026-01-02T15:30:00.000Z"),
      config: {
        timeZone: "UTC",
      },
    });

    expect(prompt).toContain("- local_date: Friday, January 2, 2026");
    expect(prompt).toContain("- timestamp_utc: 2026-01-02T15:30:00.000Z");
    expect(prompt).toContain("- timestamp_source: runtime-generated");
    expect(prompt).not.toContain("with newline");
  });

  it("includes context window usage from the previous completed turn when provided", () => {
    const prompt = buildCurrentTurnMetadataPrompt({
      timestamp: "2026-05-31T04:08:18.000Z",
      timestampSource: "discord-sent",
      config: { timeZone: "UTC" },
      contextUsage: {
        fraction: 0.53,
        totalTokens: 106_000,
        contextWindow: 200_000,
      },
    });

    expect(prompt).toContain("- context_window_used_percent: 53");
    expect(prompt).toContain("- context_window_tokens: 106000 / 200000");
  });
});
