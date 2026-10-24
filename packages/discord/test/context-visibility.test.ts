import { describe, expect, it } from "vitest";

import {
  buildContextPressureInThreadAlert,
  buildContextRotationInThreadAlert,
  buildContextSlashReply,
} from "../src/context-visibility.js";

describe("context-visibility", () => {
  it("builds an in-thread pressure alert with save guidance", () => {
    const message = buildContextPressureInThreadAlert("wellness", {
      fraction: 0.73,
      totalTokens: 146_000,
      contextWindow: 200_000,
    });

    expect(message).toContain("Context 73% — wellness");
    expect(message).toContain("/tango save");
    expect(message).toContain("rotates at 80%");
    expect(message).toContain("/tango new");
  });

  it("builds an in-thread rotation alert at 80%", () => {
    const message = buildContextRotationInThreadAlert("wellness");

    expect(message).toContain("Session rotated at 80%");
    expect(message).toContain("rotation, not a save pass");
    expect(message).toContain("/tango save");
  });

  it("builds an ephemeral slash reply with idle-timeout notes", () => {
    const message = buildContextSlashReply({
      agentId: "wellness",
      conversationKey: "thread:123",
      usage: {
        fraction: 0.42,
        totalTokens: 84_000,
        contextWindow: 200_000,
        recordedAt: new Date("2026-06-01T05:00:00.000Z"),
      },
      contextPressureAlertSent: false,
      idleTimeoutHours: 4,
      lifecycleIdleTimeoutHours: 24,
    });

    expect(message).toContain("Context: 42%");
    expect(message).toContain("agent config 4h");
    expect(message).toContain("lifecycle currently closes idle runtimes after 24h");
  });

  // T-I-035: one Discord post can carry TWO live sessions (typed + voice).
  // The reply shows one line per session type with source and age, falls back
  // to persisted snapshots when RAM is empty, and is honest about rotation,
  // staleness, and a broken snapshot store.
  describe("persisted-aware slash reply (T-I-035)", () => {
    const NOW = new Date("2026-07-12T12:00:00.000Z");
    const base = {
      agentId: "alpha",
      conversationKey: "thread:123",
      idleTimeoutHours: 4,
      lifecycleIdleTimeoutHours: 24,
      now: NOW,
    };

    function reading(overrides: {
      fraction: number;
      recordedAt: string;
      source?: "typed" | "voice";
      conversationKey?: string;
    }) {
      return {
        conversationKey: overrides.conversationKey ?? "thread:123",
        fraction: overrides.fraction,
        usedTokens: Math.round(overrides.fraction * 200_000),
        contextWindow: 200_000,
        recordedAt: new Date(overrides.recordedAt),
        source: overrides.source ?? ("typed" as const),
      };
    }

    it("renders both session types with ages (V5 two-line honesty)", () => {
      const message = buildContextSlashReply({
        ...base,
        persistedTyped: reading({ fraction: 0.31, recordedAt: "2026-07-12T11:56:00.000Z" }),
        persistedVoice: reading({
          fraction: 0.62,
          recordedAt: "2026-07-12T11:58:00.000Z",
          source: "voice",
          conversationKey: "agent:alpha:discord:channel:123:alpha",
        }),
      });

      expect(message).toContain("typed: 31%");
      expect(message).toContain("4m ago");
      expect(message).toContain("voice: 62%");
      expect(message).toContain("2m ago");
      // fresh readings carry no stale flag
      expect(message).not.toContain("(old reading)");
    });

    it("prefers the RAM reading for the typed line when present (V4 freshest wins)", () => {
      const message = buildContextSlashReply({
        ...base,
        usage: {
          fraction: 0.33,
          totalTokens: 66_000,
          contextWindow: 200_000,
          recordedAt: new Date("2026-07-12T11:59:00.000Z"),
        },
        persistedTyped: reading({ fraction: 0.31, recordedAt: "2026-07-12T11:56:00.000Z" }),
        sessionCreatedAt: new Date("2026-07-12T09:00:00.000Z"),
      });

      expect(message).toContain("typed: 33%");
      expect(message).not.toContain("typed: 31%");
    });

    it("says 'session rotated — context reset' when the session was recreated after the reading (V6)", () => {
      const message = buildContextSlashReply({
        ...base,
        // no RAM usage: rotation wiped it
        persistedTyped: reading({ fraction: 0.81, recordedAt: "2026-07-12T11:40:00.000Z" }),
        sessionCreatedAt: new Date("2026-07-12T11:45:00.000Z"),
      });

      expect(message).toContain("typed: session rotated 15m ago — context reset");
      expect(message).toContain("last reading before rotation: 81% — 20m ago");
      // the stale number is never presented as the current context
      expect(message).not.toContain("typed: 81%");
      expect(message).not.toContain("Context: unknown");
    });

    it("flags readings older than 30 minutes as old, never as fresh truth (V9)", () => {
      const message = buildContextSlashReply({
        ...base,
        persistedTyped: reading({ fraction: 0.31, recordedAt: "2026-07-12T11:15:00.000Z" }),
      });

      expect(message).toContain("typed: 31%");
      expect(message).toContain("45m ago (old reading)");
      expect(message).not.toContain("Context: unknown");
    });

    it("degrades honestly when the snapshot store is unavailable (V8)", () => {
      const message = buildContextSlashReply({
        ...base,
        persistedUnavailable: true,
      });

      expect(message).toContain("typed: no reading (persisted snapshot store unavailable)");
      expect(message).toContain("voice: no reading (persisted snapshot store unavailable)");
    });

    it("keeps the legacy single-summary reply when no persisted inputs are given", () => {
      const message = buildContextSlashReply({
        agentId: "alpha",
        conversationKey: "thread:123",
        idleTimeoutHours: 4,
        lifecycleIdleTimeoutHours: 24,
      });

      expect(message).toContain("Context: unknown (CLI did not report usage on the last turn)");
    });
  });
});
