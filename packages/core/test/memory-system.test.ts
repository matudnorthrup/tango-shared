import { describe, expect, it } from "vitest";
import {
  assembleSessionMemoryPrompt,
  buildDeterministicConversationMemory,
  extractRecentMessagesContext,
  resolveSessionMemoryConfig,
  searchMemories,
  selectMemoriesToArchive,
} from "../src/memory-system.js";
import type {
  ActiveContextItemRecord,
  PinnedFactRecord,
  SessionSummaryRecord,
  StoredMemoryRecord,
  StoredMessageRecord,
} from "../src/storage.js";

function message(
  input: Partial<StoredMessageRecord> & Pick<StoredMessageRecord, "id" | "direction" | "content">
): StoredMessageRecord {
  return {
    id: input.id,
    sessionId: input.sessionId ?? "tango-default",
    agentId: input.agentId ?? "watson",
    providerName: input.providerName ?? null,
    direction: input.direction,
    source: input.source ?? "discord",
    visibility: input.visibility ?? "public",
    discordMessageId: input.discordMessageId ?? null,
    discordChannelId: input.discordChannelId ?? null,
    discordUserId: input.discordUserId ?? null,
    discordUsername: input.discordUsername ?? null,
    content: input.content,
    metadata: input.metadata ?? null,
    createdAt: input.createdAt ?? "2026-03-10T10:00:00.000Z",
  };
}

function memory(input: Partial<StoredMemoryRecord> & Pick<StoredMemoryRecord, "id" | "source" | "content">): StoredMemoryRecord {
  return {
    id: input.id,
    sessionId: input.sessionId ?? "tango-default",
    agentId: input.agentId ?? "watson",
    source: input.source,
    content: input.content,
    importance: input.importance ?? 0.5,
    sourceRef: input.sourceRef ?? null,
    embeddingJson: input.embeddingJson ?? null,
    embeddingModel: input.embeddingModel ?? null,
    createdAt: input.createdAt ?? "2026-03-10T10:00:00.000Z",
    lastAccessedAt: input.lastAccessedAt ?? "2026-03-10T10:00:00.000Z",
    accessCount: input.accessCount ?? 0,
    archivedAt: input.archivedAt ?? null,
    metadata: input.metadata ?? null,
  };
}

function activeContextItem(
  input: Partial<ActiveContextItemRecord> & Pick<ActiveContextItemRecord, "id" | "key" | "kind" | "summary">
): ActiveContextItemRecord {
  return {
    id: input.id,
    key: input.key,
    userId: input.userId ?? "user:owner",
    agentId: input.agentId ?? "watson",
    channelId: input.channelId ?? "discord:default",
    topicId: input.topicId ?? null,
    projectId: input.projectId ?? null,
    kind: input.kind,
    title: input.title ?? null,
    summary: input.summary,
    keyFacts: input.keyFacts ?? [],
    sourceRefs: input.sourceRefs ?? [],
    createdAt: input.createdAt ?? "2026-03-10T09:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-03-10T09:00:00.000Z",
    lastAccessedAt: input.lastAccessedAt ?? "2026-03-10T09:00:00.000Z",
    accessCount: input.accessCount ?? 0,
    expiresAt: input.expiresAt ?? null,
    archivedAt: input.archivedAt ?? null,
    metadata: input.metadata ?? null,
  };
}

describe("memory-system", () => {
  it("normalizes memory zone ratios", () => {
    const config = resolveSessionMemoryConfig({
      zones: {
        pinned: 1,
        summary: 1,
        memories: 2,
        recent: 6,
      },
    });

    expect(config.zones.pinned).toBeCloseTo(0.1);
    expect(config.zones.summary).toBeCloseTo(0.1);
    expect(config.zones.memories).toBeCloseTo(0.2);
    expect(config.zones.recent).toBeCloseTo(0.6);
  });

  it("uses full recent history when it fits inside budget", () => {
    const result = assembleSessionMemoryPrompt({
      sessionId: "tango-default",
      agentId: "watson",
      currentUserPrompt: "Can you recap what we decided?",
      memoryConfig: {
        maxContextTokens: 4000,
      },
      messages: [
        message({ id: 1, direction: "inbound", content: "Let's keep daily updates short." }),
        message({ id: 2, direction: "outbound", content: "Understood. I'll keep them concise." }),
      ],
      summaries: [],
      memories: [],
      pinnedFacts: [],
    });

    expect(result.usedFullHistory).toBe(true);
    expect(result.prompt).toContain("active_context:\n- none");
    expect(result.prompt).toContain("recent_messages:");
    expect(result.prompt).toContain("[user at 2026-03-10T10:00:00.000Z]");
    expect(result.prompt).toContain("Summary and retrieval zones were skipped");
    expect(result.trace.note).toContain("Summary and retrieval zones were skipped");
    expect(result.trace.pinnedFacts).toHaveLength(0);
    expect(result.trace.summaries).toHaveLength(0);
    expect(result.trace.memories).toHaveLength(0);
    expect(result.trace.recentMessages).toHaveLength(2);
  });

  it("preserves detailed content from the latest turns during full-history warm start", () => {
    const longAgenda = [
      "Review record created. Here is the close agenda.",
      "Older setup details ".repeat(25),
      "| Whirlpool door bin $47.88 | Receipts note suggests Home Improvement (OEM fridge part). Move from the owner's Spending? |",
      "More finance agenda details ".repeat(25),
    ].join(" ");

    const result = assembleSessionMemoryPrompt({
      sessionId: "foxtrot",
      agentId: "foxtrot",
      currentUserPrompt: "The door bin is Home Improvement.",
      memoryConfig: {
        maxContextTokens: 4000,
      },
      messages: [
        message({
          id: 1,
          sessionId: "foxtrot",
          agentId: "foxtrot",
          direction: "inbound",
          content: "Please walk us through the close.",
        }),
        message({
          id: 2,
          sessionId: "foxtrot",
          agentId: "foxtrot",
          direction: "outbound",
          content: longAgenda,
        }),
        message({
          id: 3,
          sessionId: "foxtrot",
          agentId: "foxtrot",
          direction: "inbound",
          content: "The door bin is Home Improvement.",
        }),
      ],
      summaries: [],
      memories: [],
      pinnedFacts: [],
    });

    expect(result.usedFullHistory).toBe(true);
    expect(result.prompt).toContain("Whirlpool door bin $47.88");
    expect(result.prompt).toContain("The door bin is Home Improvement.");
  });

  it("includes active context when full-history bypass skips retrieval", () => {
    const result = assembleSessionMemoryPrompt({
      sessionId: "tango-default",
      agentId: "watson",
      currentUserPrompt: "What should we keep in mind?",
      memoryConfig: {
        maxContextTokens: 4000,
      },
      messages: [
        message({ id: 1, direction: "inbound", content: "Quick check-in." }),
      ],
      summaries: [],
      memories: [
        memory({
          id: 10,
          source: "manual",
          content: "This retrieved memory should not be needed in full-history mode.",
        }),
      ],
      pinnedFacts: [],
      activeContextItems: [
        activeContextItem({
          id: 99,
          key: "current-work",
          kind: "plan",
          title: "Current working context",
          summary: "Continue the generic active-context storage and warm-start implementation.",
          keyFacts: ["Do not make the implementation travel-specific."],
          sourceRefs: ["linear:TANGO-123"],
        }),
      ],
    });

    expect(result.usedFullHistory).toBe(true);
    expect(result.prompt).toContain("active_context:");
    expect(result.prompt).toContain("[plan] Current working context");
    expect(result.prompt).toContain("Do not make the implementation travel-specific.");
    expect(result.prompt).toContain("Summary and retrieval zones were skipped");
    expect(result.prompt).not.toContain("retrieved_memories:");
    expect(result.trace.activeContextItems).toMatchObject([
      {
        id: 99,
        key: "current-work",
        kind: "plan",
      },
    ]);
  });

  it("extracts a bounded recent conversation block from a rendered warm-start prompt", () => {
    const prompt = [
      "Session memory context:",
      "session=project:wellness agent=malibu",
      "rolling_summary:",
      "- user has been logging dinner",
      "recent_messages:",
      "inbound: You asked how much pulled pork was in each taco.",
      "outbound: I need the pork amount per taco to log dinner accurately.",
      "inbound: It was 60g per taco.",
      "outbound: Got it. Anything else in the taco?",
      "End session memory context.",
    ].join("\n");

    expect(
      extractRecentMessagesContext(prompt, {
        maxLines: 3,
        maxChars: 240,
      }),
    ).toBe([
      "outbound: I need the pork amount per taco to log dinner accurately.",
      "inbound: It was 60g per taco.",
      "outbound: Got it. Anything else in the taco?",
    ].join("\n"));
  });

  it("preserves a recent reference line when long later messages would otherwise crowd it out", () => {
    const prompt = [
      "Session memory context:",
      "session=topic:docs agent=watson",
      "recent_messages:",
      "[user] Here's the doc: https://docs.google.com/document/d/abc123/edit",
      `[assistant] ${"Long assistant note about the edit plan. ".repeat(10).trim()}`,
      `[user] ${"Long feedback about tone and structure. ".repeat(8).trim()}`,
      "[assistant] I updated the draft, but it may need a quick scan.",
      "[user] Please add the markdown sections back in so it's easier to scan.",
      "End session memory context.",
    ].join("\n");

    const result = extractRecentMessagesContext(prompt, {
      maxLines: 5,
      maxChars: 260,
    });

    expect(result).toContain("https://docs.google.com/document/d/abc123/edit");
    expect(result).toContain("Please add the markdown sections back in");
  });

  it("keeps the four-zone prompt shape when full-history bypass is disabled", () => {
    const result = assembleSessionMemoryPrompt({
      sessionId: "tango-default",
      agentId: "watson",
      currentUserPrompt: "Can you recap what we decided?",
      allowFullHistoryBypass: false,
      now: new Date("2026-03-10T12:00:00.000Z"),
      memoryConfig: {
        maxContextTokens: 4000,
      },
      messages: [
        message({ id: 1, direction: "inbound", content: "Let's keep daily updates short." }),
        message({ id: 2, direction: "outbound", content: "Understood. I'll keep them concise." }),
      ],
      summaries: [
        {
          id: 1,
          sessionId: "tango-default",
          agentId: "watson",
          summaryText: "We agreed to keep daily updates short and concise.",
          tokenCount: 12,
          coversThroughMessageId: 2,
          createdAt: "2026-03-10T10:00:00.000Z",
          updatedAt: "2026-03-10T10:00:00.000Z",
        },
      ],
      memories: [
        memory({
          id: 10,
          source: "conversation",
          content: "The user prefers short daily updates.",
          importance: 0.8,
        }),
      ],
      pinnedFacts: [],
    });

    expect(result.usedFullHistory).toBe(false);
    expect(result.prompt).toContain("rolling_summary:");
    expect(result.prompt).toContain("retrieved_memories:");
    expect(result.prompt).toContain("not evidence from the current source");
    expect(result.prompt).toContain("[Prior memory · 2026-03-10 · prior conversation · conversation]");
    expect(result.prompt).toContain("recent_messages:");
    expect(result.trace.summaries).toHaveLength(1);
    expect(result.trace.memories).toHaveLength(1);
    expect(result.trace.recentMessages).toHaveLength(2);
  });

  it("keeps a prior same-topic memory visibly separate from a current document review", () => {
    const result = assembleSessionMemoryPrompt({
      sessionId: "review-session",
      agentId: "reviewer",
      currentUserPrompt: "Review the current governance and tools document for source-attribution findings.",
      allowFullHistoryBypass: false,
      memoryConfig: {
        maxContextTokens: 400,
        memoryLimit: 5,
        zones: { pinned: 0, summary: 0, memories: 0.8, recent: 0.2 },
      },
      messages: [],
      summaries: [],
      pinnedFacts: [],
      memories: [
        memory({
          id: 77,
          sessionId: "review-session",
          agentId: "reviewer",
          source: "conversation",
          content: "Governance reviews should distinguish user-visible messages from hidden tool activity.",
          importance: 0.9,
          createdAt: "2026-07-12T09:00:00.000Z",
          metadata: {
            origin: {
              version: 1,
              kind: "conversation",
              occurred_at: "2026-07-12T09:00:00.000Z",
              context_label: "shared-knowledge review",
              context_ref: "thread:100000000000000003",
            },
          },
        }),
      ],
      now: new Date("2026-07-19T20:00:00.000Z"),
    });

    expect(result.prompt).toContain(
      "note=Prior memories are context, not evidence from the current source.",
    );
    expect(result.prompt).toContain(
      "[Prior memory · 2026-07-12 · shared-knowledge review · conversation]",
    );
    expect(result.prompt).not.toContain("100000000000000003");
    expect(result.trace.memories[0]?.provenance.context).toBe("shared-knowledge review");
  });

  it("omits retrieval when its provenance guidance and memory line do not fit the memory zone", () => {
    const result = assembleSessionMemoryPrompt({
      sessionId: "small-memory-zone",
      agentId: "reviewer",
      currentUserPrompt: "Review the current source.",
      allowFullHistoryBypass: false,
      memoryConfig: {
        maxContextTokens: 20,
        memoryLimit: 5,
        zones: { pinned: 0, summary: 0, memories: 1, recent: 0 },
      },
      messages: [],
      summaries: [],
      pinnedFacts: [],
      memories: [
        memory({
          id: 78,
          sessionId: "small-memory-zone",
          agentId: "reviewer",
          source: "conversation",
          content: "This memory should not appear without its origin boundary.",
          importance: 0.9,
        }),
      ],
      now: new Date("2026-07-20T20:00:00.000Z"),
    });

    expect(result.trace.memories).toHaveLength(0);
    expect(result.prompt).not.toContain("retrieved_memories:");
    expect(result.accessedMemoryIds).toEqual([]);
  });

  it("assembles summary, retrieved memories, and recent messages under constrained budget", () => {
    const summaries: SessionSummaryRecord[] = [
      {
        id: 1,
        sessionId: "tango-default",
        agentId: "watson",
        summaryText: "Conversation summary: user asked for a weekly review and a simpler morning format.",
        tokenCount: 18,
        coversThroughMessageId: 6,
        createdAt: "2026-03-09T08:00:00.000Z",
        updatedAt: "2026-03-09T08:00:00.000Z",
      },
    ];
    const pinnedFacts: PinnedFactRecord[] = [
      {
        id: 1,
        scope: "global",
        scopeId: null,
        key: "timezone",
        value: "America/Los_Angeles",
        createdAt: "2026-03-10T08:00:00.000Z",
        updatedAt: "2026-03-10T08:00:00.000Z",
      },
    ];

    const result = assembleSessionMemoryPrompt({
      sessionId: "tango-default",
      agentId: "watson",
      currentUserPrompt: "remind me about the cadence we picked",
      queryEmbedding: [1, 0],
      memoryConfig: {
        maxContextTokens: 512,
        memoryLimit: 10,
        zones: {
          pinned: 0.1,
          summary: 0.25,
          memories: 0.25,
          recent: 0.4,
        },
      },
      messages: [
        ...Array.from({ length: 12 }, (_, index) =>
          message({
            id: index + 7,
            direction: index % 2 === 0 ? "inbound" : "outbound",
            content:
              index % 2 === 0
                ? `User turn ${index + 1}: Can we keep the weekly review concise, action-focused, and free of long digressions while still covering decisions and follow-ups?`
                : `Assistant turn ${index + 1}: Yes, the weekly review will stay concise, focus on decisions and follow-ups, and avoid long digressions unless you explicitly ask for more depth.`,
          })
        ),
      ],
      summaries,
      memories: [
        memory({
          id: 10,
          source: "conversation",
          content: "We switched the cadence to Mondays with short recap format.",
          importance: 0.9,
          embeddingJson: JSON.stringify([1, 0]),
        }),
        memory({
          id: 11,
          source: "manual",
          content: "Lunch notes should stay lightweight.",
          importance: 0.4,
          embeddingJson: JSON.stringify([0, 1]),
        }),
      ],
      pinnedFacts,
    });

    expect(result.usedFullHistory).toBe(false);
    expect(result.prompt).toContain("pinned_state:");
    expect(result.prompt).toContain("rolling_summary:");
    expect(result.prompt).toContain("retrieved_memories:");
    expect(result.prompt).toContain("cadence to Mondays");
    expect(result.accessedMemoryIds).toContain(10);
    expect(result.trace.pinnedFacts).toHaveLength(1);
    expect(result.trace.summaries[0]).toMatchObject({ id: 1, coversThroughMessageId: 6 });
    expect(result.trace.memories.map((entry) => entry.id)).toContain(10);
    expect(result.trace.memories.find((entry) => entry.id === 10)?.semanticScore).toBeGreaterThan(0);
    expect(result.trace.recentMessages.length).toBeGreaterThan(0);
  });

  it("archives the lowest-retention memories once the limit is exceeded", () => {
    const archiveIds = selectMemoriesToArchive(
      [
        memory({
          id: 1,
          source: "conversation",
          content: "High-value preference",
          importance: 0.9,
          accessCount: 5,
          lastAccessedAt: "2026-03-10T09:00:00.000Z",
        }),
        memory({
          id: 2,
          source: "conversation",
          content: "Recent but lower-importance detail",
          importance: 0.4,
          accessCount: 1,
          lastAccessedAt: "2026-03-10T09:30:00.000Z",
        }),
        memory({
          id: 3,
          source: "conversation",
          content: "Old low-value detail",
          importance: 0.1,
          accessCount: 0,
          lastAccessedAt: "2026-01-10T09:30:00.000Z",
        }),
      ],
      2,
      new Date("2026-03-10T10:00:00.000Z")
    );

    expect(archiveIds).toEqual([3]);
  });

  it("skips memory retrieval for low-entropy acknowledgment turns", () => {
    const result = assembleSessionMemoryPrompt({
      sessionId: "project:wellness",
      agentId: "malibu",
      currentUserPrompt: "yeah, circuits",
      allowFullHistoryBypass: false,
      memoryConfig: {
        maxContextTokens: 512,
        memoryLimit: 8,
        zones: {
          pinned: 0.1,
          summary: 0.2,
          memories: 0.2,
          recent: 0.5,
        },
      },
      messages: [
        message({ id: 1, sessionId: "project:wellness", agentId: "malibu", direction: "inbound", content: "Goblets, 55 lb, 15 reps" }),
        message({ id: 2, sessionId: "project:wellness", agentId: "malibu", direction: "outbound", content: "Set 1 logged — Goblet Squat, 55 lbs × 15. Are you doing circuits today?" }),
      ],
      summaries: [],
      memories: [
        memory({
          id: 10,
          sessionId: null,
          agentId: null,
          source: "reflection",
          content: "Recent theme: thread, acme, and project management recurred across 14 memories.",
          importance: 0.9,
          embeddingJson: JSON.stringify([1, 0]),
        }),
      ],
      pinnedFacts: [],
    });

    expect(result.trace.memories).toHaveLength(0);
    expect(result.prompt).not.toContain("retrieved_memories:");
  });

  it("down-ranks low-signal operational obsidian notes for wellness queries", async () => {
    const results = await searchMemories({
      query: "Can you analyze my sleep recovery trends?",
      sessionId: "project:wellness",
      agentId: "malibu",
      limit: 1,
      memories: [
        memory({
          id: 1,
          sessionId: null,
          agentId: null,
          source: "obsidian",
          content: "In Progress / In Progress: - [ ] 🤖 Nutrition — last active 8:11 PM - [ ] 🤖 #acme › Messaging Principles — last active 7:58 PM",
          importance: 0.95,
          metadata: {
            filePath: "/Users/tester/Documents/main/Planning/Daily/2026-03-05.md",
            title: "In Progress",
            heading: "In Progress",
            keywords: ["nutrition", "acme", "planning"],
          },
          embeddingJson: JSON.stringify([1, 0]),
        }),
        memory({
          id: 2,
          sessionId: "project:wellness",
          agentId: "malibu",
          source: "conversation",
          content: "Sleep analysis should focus on deep sleep, HRV, and recovery trends.",
          importance: 0.7,
          embeddingJson: JSON.stringify([1, 0]),
        }),
      ],
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(2);
  });

  it("normalizes query tokens so planning lookups beat unrelated wellness notes", async () => {
    const results = await searchMemories({
      query: "What did we decide about weekly reviews and productivity cadence?",
      agentId: "watson",
      limit: 1,
      memories: [
        memory({
          id: 1,
          sessionId: null,
          agentId: null,
          source: "backfill",
          content: "Yogurt Recipe Evolution & Troubleshooting / Conversation: since you added it late, the batch stayed runny.",
          importance: 0.9,
          metadata: {
            tags: ["cooking", "yogurt", "recipe"],
            keywords: ["cooking", "yogurt", "recipe", "troubleshooting"],
          },
        }),
        memory({
          id: 2,
          sessionId: "tango-default",
          agentId: "watson",
          source: "manual",
          content: "Decision: weekly review cadence stays concise, productivity-focused, and action-oriented.",
          importance: 0.7,
          metadata: {
            tags: ["weekly-review", "productivity"],
            keywords: ["weekly", "review", "productivity", "cadence"],
          },
        }),
      ],
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(2);
  });

  it("penalizes mixed-domain product memories for focused wellness queries", async () => {
    const results = await searchMemories({
      query: "What recurring health and fitness themes have come up recently?",
      sessionId: "project:wellness",
      agentId: "malibu",
      limit: 1,
      memories: [
        memory({
          id: 1,
          sessionId: null,
          agentId: null,
          source: "obsidian",
          content: "OpenClaw to Tango Migration Audit / Malibu Domain (Wellness): health recovery, activity, trends, and nutrition logging tool parity.",
          importance: 0.9,
          metadata: {
            title: "OpenClaw to Tango Migration Audit",
            heading: "Malibu Domain (Wellness)",
            keywords: ["health", "recovery", "migration", "openclaw", "atlas"],
          },
        }),
        memory({
          id: 2,
          sessionId: "project:wellness",
          agentId: "malibu",
          source: "reflection",
          content: "Recurring theme: health, exercise, and fitness. Example: Sleep analysis should focus on deep sleep, HRV, and recovery trends.",
          importance: 0.8,
          metadata: {
            keywords: ["health", "exercise", "fitness", "recovery"],
          },
        }),
      ],
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(2);
  });

  it("applies quality penalty to 'Recurring theme:' reflections (Fix 1)", async () => {
    const now = new Date("2026-03-10T12:00:00.000Z");
    const results = await searchMemories({
      query: "voice pipeline architecture and transition plan",
      agentId: "watson",
      limit: 2,
      now,
      memories: [
        memory({
          id: 1,
          sessionId: null,
          agentId: null,
          source: "reflection",
          content: "Recurring theme: voice, pipeline, and architecture across 14 memories.",
          importance: 0.9,
        }),
        memory({
          id: 2,
          sessionId: "tango-default",
          agentId: "watson",
          source: "conversation",
          content: "We discussed the new voice pipeline architecture and transition plan.",
          importance: 0.7,
        }),
      ],
    });

    // The conversation memory should rank higher because the generic
    // reflection now gets its quality penalty applied (regex was wrong before)
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.id).toBe(2);
  });

  it("caps per-source-type to 40% of retrieval limit (Fix 2)", async () => {
    const results = await searchMemories({
      query: "health fitness wellness exercise",
      agentId: "malibu",
      limit: 5,
      memories: [
        // 4 reflections — should be capped at 2 (40% of 5)
        ...Array.from({ length: 4 }, (_, i) =>
          memory({
            id: i + 1,
            sessionId: null,
            agentId: null,
            source: "reflection",
            content: `Reflection insight ${i}: health and fitness trends observed.`,
            importance: 0.85,
          })
        ),
        // 3 conversation memories
        ...Array.from({ length: 3 }, (_, i) =>
          memory({
            id: i + 10,
            sessionId: "project:wellness",
            agentId: "malibu",
            source: "conversation",
            content: `Discussion ${i} about health goals and exercise routine.`,
            importance: 0.75,
          })
        ),
      ],
    });

    const reflectionCount = results.filter((r) => r.source === "reflection").length;
    expect(reflectionCount).toBeLessThanOrEqual(2);
  });

  it("still respects the overall retrieval limit after per-source capping", async () => {
    const results = await searchMemories({
      query: "health fitness wellness exercise",
      sessionId: "project:wellness",
      agentId: "malibu",
      limit: 4,
      memories: [
        ...Array.from({ length: 2 }, (_, i) =>
          memory({
            id: i + 1,
            sessionId: "project:wellness",
            agentId: "malibu",
            source: "reflection",
            content: `Reflection ${i}: health and fitness trends observed.`,
            importance: 0.85,
          })
        ),
        ...Array.from({ length: 2 }, (_, i) =>
          memory({
            id: i + 10,
            sessionId: "project:wellness",
            agentId: "malibu",
            source: "conversation",
            content: `Conversation ${i}: health goals and exercise routine.`,
            importance: 0.8,
          })
        ),
        ...Array.from({ length: 2 }, (_, i) =>
          memory({
            id: i + 20,
            sessionId: "project:wellness",
            agentId: "malibu",
            source: "backfill",
            content: `Backfill ${i}: sleep recovery and training load.`,
            importance: 0.75,
          })
        ),
      ],
    });

    expect(results).toHaveLength(4);
  });

  it("boosts exact session and agent memories over global semantically-similar notes", async () => {
    const embeddingProvider = {
      model: "test",
      async embed() {
        return [[1, 0]];
      },
    };

    const results = await searchMemories({
      query: "What do you remember about home sleep testing options for insomnia?",
      sessionId: "project:wellness",
      agentId: "malibu",
      limit: 2,
      embeddingProvider,
      memories: [
        memory({
          id: 1,
          sessionId: null,
          agentId: null,
          source: "obsidian",
          content: "Remote options comparison: direct to consumer vendors, easiest path, at-home device, frontrunners.",
          importance: 0.95,
          metadata: {
            title: "Notes from Last Night",
          },
          embeddingJson: JSON.stringify([1, 0]),
        }),
        memory({
          id: 2,
          sessionId: "project:wellness",
          agentId: "malibu",
          source: "backfill",
          content: "Telehealth can order a home sleep test, and Sleepwell is probably the most streamlined option.",
          importance: 0.7,
          metadata: {
            keywords: ["telehealth", "home sleep test", "sleepwell", "insomnia"],
          },
          embeddingJson: JSON.stringify([1, 0]),
        }),
      ],
    });

    expect(results[0]?.id).toBe(2);
    expect(results.some((result) => result.id === 1)).toBe(false);
  });

  it("uses summary metadata when truncated backfill content drops the key terms", async () => {
    const results = await searchMemories({
      query: "What do you remember about home sleep testing options for insomnia?",
      sessionId: "project:wellness",
      agentId: "malibu",
      limit: 2,
      memories: [
        memory({
          id: 1,
          sessionId: "project:wellness",
          agentId: "malibu",
          source: "backfill",
          content: "Telehealth can absolutely do this.",
          importance: 0.7,
          metadata: {
            summaryText:
              "Conversation summary:\n- assistant: A telehealth doc can order a home sleep test (HST). Sleepwell is probably the most streamlined option.",
            keywords: ["assistant", "conversation"],
          },
        }),
        memory({
          id: 2,
          sessionId: "project:wellness",
          agentId: "malibu",
          source: "backfill",
          content: "Deep sleep suppression has been chronic for years.",
          importance: 0.8,
        }),
      ],
    });

    expect(results[0]?.id).toBe(1);
    expect(results[0]?.keywordScore).toBeGreaterThan(0);
  });

  it("builds multi-message conversation memory for 3+ messages (Fix 5)", () => {
    const result = buildDeterministicConversationMemory([
      message({ id: 1, direction: "inbound", content: "How did my sleep look last night?" }),
      message({ id: 2, direction: "outbound", content: "Your deep sleep was 1h42m, which is above your baseline." }),
      message({ id: 3, direction: "inbound", content: "What about HRV?" }),
      message({ id: 4, direction: "outbound", content: "HRV averaged 48ms, slightly below your 7-day mean of 52ms." }),
    ]);

    // Should include all 4 messages with Speaker: format separated by |
    expect(result).toContain("User:");
    expect(result).toContain("Assistant:");
    expect(result).toContain("|");
    expect(result).toContain("sleep");
    expect(result).toContain("HRV");
  });

  it("keeps original two-message format for short conversations (Fix 5)", () => {
    const result = buildDeterministicConversationMemory([
      message({ id: 1, direction: "inbound", content: "Log 200 calories of almonds" }),
      message({ id: 2, direction: "outbound", content: "Logged 200 cal of almonds to your food diary." }),
    ]);

    // Should use original format, not the pipe-separated multi-message format
    expect(result).toContain("User discussed");
    expect(result).toContain("Assistant responded with");
    expect(result).not.toContain("|");
  });
});

describe("pre-decoded embedding support (atlas adapter records)", () => {
  it("ranks semantically from the embedding field when embeddingJson is absent", async () => {
    const aligned = {
      ...memory({
        id: 1,
        source: "conversation",
        content: "Offshore fishing charter pricing for the Playa Azul trip.",
      }),
      embedding: [1, 0, 0],
    };
    const orthogonal = {
      ...memory({
        id: 2,
        source: "conversation",
        content: "Completely unrelated gardening note about tomato seedlings.",
      }),
      embedding: [0, 1, 0],
    };

    const results = await searchMemories({
      query: "fishing charter prices",
      memories: [aligned, orthogonal],
      embeddingProvider: {
        model: "test-embed",
        async embed(): Promise<number[][]> {
          return [[1, 0, 0]];
        },
      },
      sessionId: "tango-default",
      agentId: "watson",
      limit: 2,
    });

    expect(results[0]?.id).toBe(1);
    expect(results[0]?.semanticScore ?? 0).toBeGreaterThan(0.9);
  });
});


describe("scheduled conversation alias ranking", () => {
  it("retains approved clone history while excluding unrelated agent messages", () => {
    const input = {
      sessionId: "review", agentId: "foxtrot", allowFullHistoryBypass: false,
      messages: [
        message({ id: 1, agentId: "foxtrot-ollama", direction: "inbound", content: "Confirmed refund category is Motorcycle Gear." }),
        message({ id: 2, agentId: "victor", direction: "inbound", content: "Unrelated confidential note." }),
      ],
      summaries: [], memories: [], pinnedFacts: [],
    };
    expect(assembleSessionMemoryPrompt(input).prompt).not.toContain("Confirmed refund");
    const prompt = assembleSessionMemoryPrompt({ ...input, messageAgentIds: ["foxtrot", "foxtrot-ollama"] }).prompt;
    expect(prompt).toContain("Confirmed refund category is Motorcycle Gear");
    expect(prompt).not.toContain("Unrelated confidential");
  });
});
