import { describe, expect, it } from "vitest";
import { planSessionCompaction } from "../src/memory-compaction.js";
import type { StoredMessageRecord } from "../src/storage.js";

function message(input: {
  id: number;
  direction: "inbound" | "outbound";
  content: string;
  sessionId?: string;
  agentId?: string;
}): StoredMessageRecord {
  return {
    id: input.id,
    sessionId: input.sessionId ?? "tango-default",
    agentId: input.agentId ?? "watson",
    providerName: "codex",
    direction: input.direction,
    source: "discord",
    visibility: "public",
    discordMessageId: null,
    discordChannelId: null,
    discordUserId: null,
    discordUsername: null,
    content: input.content,
    metadata: null,
    createdAt: "2026-03-05 00:00:00"
  };
}

function buildTurns(count: number): StoredMessageRecord[] {
  const rows: StoredMessageRecord[] = [];
  for (let i = 1; i <= count; i += 1) {
    rows.push(
      message({
        id: i,
        direction: i % 2 === 0 ? "outbound" : "inbound",
        content: `turn ${i} content`
      })
    );
  }
  return rows;
}

describe("planSessionCompaction", () => {
  it("does not compact before trigger threshold", () => {
    const plan = planSessionCompaction({
      sessionId: "tango-default",
      agentId: "watson",
      messages: buildTurns(10),
      triggerTurns: 12
    });

    expect(plan.shouldCompact).toBe(false);
    expect(plan.compactedTurns).toBe(0);
    expect(plan.summaryText).toBeUndefined();
  });

  it("compacts older turns and emits summary text", () => {
    const plan = planSessionCompaction({
      sessionId: "tango-default",
      agentId: "watson",
      messages: buildTurns(20),
      triggerTurns: 12,
      retainRecentTurns: 6,
      maxSummaryTurns: 8
    });

    expect(plan.shouldCompact).toBe(true);
    expect(plan.compactedTurns).toBe(14);
    expect(plan.retainedRecentTurns).toBe(6);
    expect(plan.summaryText).toContain("Compacted history");
    expect(plan.summaryText).toContain("Key prior turns");
  });

  it("respects max summary char budget", () => {
    const noisyMessages = buildTurns(40).map((item) => ({
      ...item,
      content: `${item.content} `.repeat(40)
    }));
    const plan = planSessionCompaction({
      sessionId: "tango-default",
      agentId: "watson",
      messages: noisyMessages,
      triggerTurns: 12,
      retainRecentTurns: 6,
      maxSummaryChars: 420
    });

    expect(plan.shouldCompact).toBe(true);
    expect(plan.summaryText?.length ?? 0).toBeLessThanOrEqual(430);
  });
});
