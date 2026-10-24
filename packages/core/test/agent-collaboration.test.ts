import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentCollaborationService,
  evaluateAgentCollaborationPolicy,
  listAgentCollaborationRoutes,
  normalizeCollaborationObjective,
  renderAgentCollaborationTargetPrompt,
  TangoStorage,
  type AgentCollaborationRequest,
  type V2AgentConfig,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-agent-collab-"));
  tempDirs.push(dir);
  return dir;
}

function createStorage(): TangoStorage {
  return new TangoStorage(path.join(createTempDir(), "tango.sqlite"), { seedExampleRoster: true });
}

function createAgentConfig(
  id: string,
  responsibilities: V2AgentConfig["responsibilities"],
): V2AgentConfig {
  return {
    id,
    enabled: true,
    displayName: id,
    type: "test",
    systemPromptFile: `agents/assistants/${id}/soul.md`,
    mcpServers: [
      {
        name: "memory",
        command: "node",
        args: ["packages/atlas-memory/dist/index.js"],
      },
    ],
    runtime: {
      mode: "persistent",
      provider: "claude-code-v2",
      model: "claude-sonnet-4-6",
      reasoningEffort: "medium",
      idleTimeoutHours: 24,
      contextResetThreshold: 0.8,
    },
    memory: {
      postTurnExtraction: "disabled",
      extractionModel: "claude-haiku-4-5",
      importanceThreshold: 0.4,
      scheduledReflection: "disabled",
    },
    discord: {
      defaultChannelId: "100000000000000000",
    },
    responsibilities,
  };
}

function createConfigMap(): Map<string, V2AgentConfig> {
  return new Map([
    [
      "ops",
      createAgentConfig("ops", [
        {
          id: "ops_coordination",
          description: "Coordinate bounded specialist help.",
          collaboration: {
            canRequest: [
              {
                agent: "research",
                purposes: ["source-check"],
              },
            ],
          },
        },
      ]),
    ],
    [
      "research",
      createAgentConfig("research", [
        {
          id: "research_support",
          description: "Fulfill bounded research checks.",
          collaboration: {
            canFulfill: [
              {
                purpose: "source-check",
                maxTurns: 1,
                maxDurationSeconds: 60,
                maxToolCalls: 4,
                visibilityModes: ["summary", "digest"],
              },
            ],
          },
        },
      ]),
    ],
  ]);
}

function createNestedConfigMap(): Map<string, V2AgentConfig> {
  const configs = createConfigMap();
  configs.set("research", createAgentConfig("research", [
    {
      id: "research_support",
      description: "Fulfill bounded research checks.",
      collaboration: {
        canRequest: [
          {
            agent: "finance",
            purposes: ["receipt-status-check"],
          },
        ],
        canFulfill: [
          {
            purpose: "source-check",
            maxTurns: 1,
            maxDurationSeconds: 60,
            maxToolCalls: 4,
            visibilityModes: ["summary", "digest"],
          },
        ],
      },
    },
  ]));
  configs.set("finance", createAgentConfig("finance", [
    {
      id: "finance_support",
      description: "Fulfill bounded finance checks.",
      collaboration: {
        canFulfill: [
          {
            purpose: "receipt-status-check",
            maxTurns: 1,
            maxDurationSeconds: 45,
            maxToolCalls: 3,
            visibilityModes: ["summary"],
          },
        ],
      },
    },
  ]));
  return configs;
}

const baseRequest: AgentCollaborationRequest = {
  requesterAgentId: "ops",
  targetAgentId: "research",
  purpose: "source-check",
  objective: "Verify whether the cited source supports the claim.",
  contextSummary: "A draft mentions a source-backed claim.",
  deliverable: {
    format: "concise_result",
    requiredFields: ["answer", "evidence"],
    maxWords: 120,
  },
  constraints: ["Do not write to external systems."],
  visibility: "summary",
  budget: {
    maxTurns: 1,
    maxDurationSeconds: 45,
    maxToolCalls: 3,
  },
};

describe("agent collaboration policy", () => {
  it("grants only when requester and target responsibilities match", () => {
    const decision = evaluateAgentCollaborationPolicy(baseRequest, createConfigMap());

    expect(decision).toMatchObject({
      granted: true,
      reason: "granted",
      requesterResponsibilityId: "ops_coordination",
      targetResponsibilityId: "research_support",
      effectiveBudget: {
        maxTurns: 1,
        maxDurationSeconds: 45,
        maxToolCalls: 3,
      },
    });
  });

  it("grants Foxtrot bounded Kilo spending support", () => {
    const configs = createConfigMap();
    configs.set("foxtrot", createAgentConfig("foxtrot", [
      {
        id: "finance_support",
        description: "Coordinate bounded Kilo spending support.",
        collaboration: {
          canRequest: [
            { agent: "kilo", purposes: ["kilo-spending-support"] },
          ],
        },
      },
    ]));
    configs.set("kilo", createAgentConfig("kilo", [
      {
        id: "kid_spending_support",
        description: "Provide child-facing spending information.",
        collaboration: {
          canFulfill: [
            {
              purpose: "kilo-spending-support",
              maxTurns: 1,
              maxDurationSeconds: 180,
              maxToolCalls: 4,
              visibilityModes: ["summary", "thread"],
            },
          ],
        },
      },
    ]));

    const decision = evaluateAgentCollaborationPolicy({
      ...baseRequest,
      requesterAgentId: "foxtrot",
      targetAgentId: "kilo",
      purpose: "kilo-spending-support",
      objective: "Answer a child-facing question about Kilo spending.",
      budget: {
        maxTurns: 1,
        maxDurationSeconds: 180,
        maxToolCalls: 4,
      },
    }, configs);

    expect(decision).toMatchObject({
      granted: true,
      reason: "granted",
      requesterResponsibilityId: "finance_support",
      targetResponsibilityId: "kid_spending_support",
    });
  });

  it("lists concrete routes so callers do not need to invent purpose labels", () => {
    const configs = createConfigMap();
    configs.set("foxtrot", createAgentConfig("foxtrot", [
      {
        id: "finance_support",
        description: "Coordinate bounded Kilo spending support.",
        collaboration: {
          canRequest: [
            { agent: "kilo", purposes: ["kilo-spending-support"] },
          ],
        },
      },
    ]));

    expect(listAgentCollaborationRoutes("foxtrot", configs)).toEqual([
      { targetAgentId: "kilo", purposes: ["kilo-spending-support"] },
    ]);
  });

  it("fails closed for unconfigured purposes and self-collaboration", () => {
    expect(evaluateAgentCollaborationPolicy({
      ...baseRequest,
      purpose: "unconfigured",
    }, createConfigMap())).toMatchObject({
      granted: false,
      reason: "requester_not_allowed",
    });

    expect(evaluateAgentCollaborationPolicy({
      ...baseRequest,
      targetAgentId: "ops",
    }, createConfigMap())).toMatchObject({
      granted: false,
      reason: "self_collaboration_denied",
    });
  });

  it("rejects loop-prone depth and budget escalation", () => {
    expect(evaluateAgentCollaborationPolicy({
      ...baseRequest,
      parentDepth: 2,
    }, createConfigMap())).toMatchObject({
      granted: false,
      reason: "collaboration_depth_exceeded",
    });

    expect(evaluateAgentCollaborationPolicy({
      ...baseRequest,
      budget: {
        maxTurns: 2,
        maxDurationSeconds: 45,
        maxToolCalls: 3,
      },
    }, createConfigMap())).toMatchObject({
      granted: false,
      reason: "budget_exceeded:maxTurns",
    });
  });

  it("rejects targets that are not v2 runtime enabled", () => {
    const configs = createConfigMap();
    configs.set("research", {
      ...configs.get("research")!,
      runtime: {
        ...configs.get("research")!.runtime,
        provider: "legacy",
      },
    });

    expect(evaluateAgentCollaborationPolicy(baseRequest, configs)).toMatchObject({
      granted: false,
      reason: "target_runtime_not_enabled",
    });
  });
});

describe("AgentCollaborationService", () => {
  it("stores a request/result exchange and invokes the target with a collaboration-scoped conversation key", async () => {
    const storage = createStorage();
    const invokeTarget = vi.fn(async (input) => ({
      text: JSON.stringify({
        status: "completed",
        answer: "The source supports the claim.",
        evidence: [{ kind: "tool_result", summary: "Source text matched." }],
        actions_taken: ["read source"],
        actions_not_taken: ["no writes"],
        needs_user: false,
      }),
      durationMs: 25,
      model: "test-model",
      toolsUsed: ["source_read"],
      metadata: { ok: true },
    }));
    const service = new AgentCollaborationService({
      storage,
      v2Configs: createConfigMap(),
      invokeTarget,
      now: () => new Date("2026-06-26T12:00:00.000Z"),
    });

    try {
      const result = await service.collaborate(baseRequest);

      expect(result).toMatchObject({
        status: "completed",
        answer: "The source supports the claim.",
        actionsTaken: ["read source"],
        actionsNotTaken: ["no writes"],
        needsUser: false,
      });
      expect(invokeTarget).toHaveBeenCalledTimes(1);
      expect(invokeTarget.mock.calls[0]?.[0]).toMatchObject({
        requesterAgentId: "ops",
        targetAgentId: "research",
        purpose: "source-check",
        timeoutMs: 45_000,
      });
      expect(invokeTarget.mock.calls[0]?.[0].conversationKey).toMatch(
        new RegExp(`^collab:${result.collaborationId}:research$`),
      );

      const session = storage.getAgentCollaborationSession(result.collaborationId);
      expect(session).toMatchObject({
        requesterAgentId: "ops",
        targetAgentId: "research",
        status: "completed",
        normalizedObjective: normalizeCollaborationObjective(baseRequest.objective),
        resultSummary: "The source supports the claim.",
      });
      expect(storage.listAgentCollaborationTurns(result.collaborationId).map((turn) => turn.turnType)).toEqual([
        "request",
        "result",
      ]);
    } finally {
      storage.close();
    }
  });

  it("emits best-effort presentation lifecycle events without changing the exchange", async () => {
    const storage = createStorage();
    const presentationObserver = vi.fn(async () => undefined);
    const service = new AgentCollaborationService({
      storage,
      v2Configs: createConfigMap(),
      presentationObserver,
      invokeTarget: async () => ({
        text: JSON.stringify({
          status: "completed",
          answer: "The source supports the claim.",
          evidence: [],
          actions_taken: [],
          actions_not_taken: [],
          needs_user: false,
        }),
        durationMs: 10,
      }),
    });

    try {
      const result = await service.collaborate({
        ...baseRequest,
        userSurface: { kind: "discord", channel_id: "channel-1" },
      });

      expect(result.status).toBe("completed");
      expect(presentationObserver).toHaveBeenCalledTimes(2);
      expect(presentationObserver.mock.calls.map(([event]) => event.kind)).toEqual([
        "started",
        "completed",
      ]);
      expect(presentationObserver.mock.calls[0]?.[0].session.userSurface).toEqual({
        kind: "discord",
        channel_id: "channel-1",
      });
      expect(presentationObserver.mock.calls[1]?.[0]).toMatchObject({
        answer: "The source supports the claim.",
      });
    } finally {
      storage.close();
    }
  });

  it("keeps a collaboration successful when its presentation observer fails", async () => {
    const storage = createStorage();
    const service = new AgentCollaborationService({
      storage,
      v2Configs: createConfigMap(),
      presentationObserver: async () => {
        throw new Error("Discord unavailable");
      },
      invokeTarget: async () => ({
        text: JSON.stringify({
          status: "completed",
          answer: "The source supports the claim.",
          evidence: [],
          actions_taken: [],
          actions_not_taken: [],
          needs_user: false,
        }),
        durationMs: 10,
      }),
    });

    try {
      await expect(service.collaborate(baseRequest)).resolves.toMatchObject({
        status: "completed",
        answer: "The source supports the claim.",
      });
    } finally {
      storage.close();
    }
  });

  it("does not invoke the target for denied collaborations", async () => {
    const storage = createStorage();
    const invokeTarget = vi.fn();
    const service = new AgentCollaborationService({
      storage,
      v2Configs: createConfigMap(),
      invokeTarget,
    });

    try {
      const result = await service.collaborate({
        ...baseRequest,
        purpose: "unconfigured",
      });

      expect(result).toMatchObject({
        status: "denied",
        error: "requester_not_allowed",
        availableRoutes: [
          { targetAgentId: "research", purposes: ["source-check"] },
        ],
      });
      expect(invokeTarget).not.toHaveBeenCalled();
      expect(storage.getAgentCollaborationSession(result.collaborationId)?.status).toBe("denied");
    } finally {
      storage.close();
    }
  });

  it("suppresses duplicate objectives inside the duplicate window", async () => {
    const storage = createStorage();
    const invokeTarget = vi.fn(async () => ({
      text: JSON.stringify({
        status: "completed",
        answer: "Already checked.",
        evidence: [],
        actions_taken: [],
        actions_not_taken: [],
        needs_user: false,
      }),
      durationMs: 10,
    }));
    const service = new AgentCollaborationService({
      storage,
      v2Configs: createConfigMap(),
      invokeTarget,
      now: () => new Date("2026-06-26T12:00:00.000Z"),
    });

    try {
      const first = await service.collaborate(baseRequest);
      const second = await service.collaborate({
        ...baseRequest,
        objective: "  Verify whether the cited source supports the claim.  ",
      });

      expect(first.status).toBe("completed");
      expect(second).toMatchObject({
        status: "completed",
        duplicateOf: first.collaborationId,
        answer: "Already checked.",
      });
      expect(invokeTarget).toHaveBeenCalledTimes(1);
    } finally {
      storage.close();
    }
  });

  it("does not reuse duplicate sessions after collaboration permission is revoked", async () => {
    const storage = createStorage();
    const invokeTarget = vi.fn(async () => ({
      text: JSON.stringify({
        status: "completed",
        answer: "Previously checked.",
        evidence: [],
        actions_taken: [],
        actions_not_taken: [],
        needs_user: false,
      }),
      durationMs: 10,
    }));
    const grantedService = new AgentCollaborationService({
      storage,
      v2Configs: createConfigMap(),
      invokeTarget,
      now: () => new Date("2026-06-26T12:00:00.000Z"),
    });
    const revokedConfigs = createConfigMap();
    revokedConfigs.set("ops", {
      ...revokedConfigs.get("ops")!,
      responsibilities: [],
    });
    const revokedService = new AgentCollaborationService({
      storage,
      v2Configs: revokedConfigs,
      invokeTarget,
      now: () => new Date("2026-06-26T12:00:30.000Z"),
    });

    try {
      const first = await grantedService.collaborate(baseRequest);
      const second = await revokedService.collaborate(baseRequest);

      expect(first.status).toBe("completed");
      expect(second).toMatchObject({
        status: "denied",
        error: "requester_not_allowed",
      });
      expect(second.collaborationId).not.toBe(first.collaborationId);
      expect(second.duplicateOf).toBeUndefined();
      expect(invokeTarget).toHaveBeenCalledTimes(1);
    } finally {
      storage.close();
    }
  });

  it("denies nested collaborations that omit active parent context", async () => {
    const storage = createStorage();
    let nestedResult: Awaited<ReturnType<AgentCollaborationService["collaborate"]>> | null = null;
    let service: AgentCollaborationService;
    const invokeTarget = vi.fn(async () => {
      nestedResult = await service.collaborate({
        requesterAgentId: "research",
        targetAgentId: "finance",
        purpose: "receipt-status-check",
        objective: "Check whether the receipt has been reviewed.",
        visibility: "summary",
        budget: {
          maxTurns: 1,
          maxDurationSeconds: 30,
          maxToolCalls: 2,
        },
      });
      return {
        text: JSON.stringify({
          status: "completed",
          answer: "Research response complete.",
          evidence: [],
          actions_taken: [],
          actions_not_taken: [],
          needs_user: false,
        }),
        durationMs: 10,
      };
    });
    service = new AgentCollaborationService({
      storage,
      v2Configs: createNestedConfigMap(),
      invokeTarget,
      now: () => new Date("2026-06-26T12:00:00.000Z"),
    });

    try {
      const outer = await service.collaborate(baseRequest);

      expect(outer.status).toBe("completed");
      expect(nestedResult).toMatchObject({
        status: "denied",
        error: "nested_collaboration_context_missing",
      });
      expect(invokeTarget).toHaveBeenCalledTimes(1);
    } finally {
      storage.close();
    }
  });

  it("allows one explicit parented collaboration and derives parent depth", async () => {
    const storage = createStorage();
    const invokeTarget = vi.fn(async () => ({
      text: JSON.stringify({
        status: "completed",
        answer: "Receipt status checked.",
        evidence: [],
        actions_taken: [],
        actions_not_taken: [],
        needs_user: false,
      }),
      durationMs: 10,
    }));
    const service = new AgentCollaborationService({
      storage,
      v2Configs: createNestedConfigMap(),
      invokeTarget,
      now: () => new Date("2026-06-26T12:00:00.000Z"),
    });

    try {
      const parentId = storage.insertAgentCollaborationSession({
        requesterAgentId: "ops",
        targetAgentId: "research",
        initiatorKind: "agent",
        purpose: "source-check",
        objective: "Verify whether the cited source supports the claim.",
        normalizedObjective: normalizeCollaborationObjective(baseRequest.objective),
        status: "running",
        visibilityMode: "summary",
        budget: { maxTurns: 1, maxDurationSeconds: 60, maxToolCalls: 4 },
        policyDecision: { granted: true, reason: "granted" },
        expiresAt: "2026-06-26T12:01:00.000Z",
      });
      const result = await service.collaborate({
        requesterAgentId: "research",
        targetAgentId: "finance",
        purpose: "receipt-status-check",
        objective: "Check whether the receipt has been reviewed.",
        visibility: "summary",
        parentCollaborationId: parentId,
        budget: {
          maxTurns: 1,
          maxDurationSeconds: 30,
          maxToolCalls: 2,
        },
      });

      expect(result).toMatchObject({
        status: "completed",
        answer: "Receipt status checked.",
      });
      expect(storage.getAgentCollaborationSession(result.collaborationId)).toMatchObject({
        parentCollaborationId: parentId,
        status: "completed",
      });
      expect(invokeTarget).toHaveBeenCalledTimes(1);
    } finally {
      storage.close();
    }
  });

  it("records a failed session when no target invoker is configured", async () => {
    const storage = createStorage();
    const service = new AgentCollaborationService({
      storage,
      v2Configs: createConfigMap(),
    });

    try {
      const result = await service.collaborate(baseRequest);

      expect(result).toMatchObject({
        status: "failed",
        error: "collaboration_target_invoker_unavailable",
      });
      const turns = storage.listAgentCollaborationTurns(result.collaborationId);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.content).toContain("Collaboration request from agent:ops.");
    } finally {
      storage.close();
    }
  });

  it("stores immutable presentation delivery records separately from the collaboration", () => {
    const storage = createStorage();
    try {
      const collaborationId = storage.insertAgentCollaborationSession({
        requesterAgentId: "ops",
        targetAgentId: "research",
        initiatorKind: "agent",
        purpose: "source-check",
        objective: "Verify whether the cited source supports the claim.",
        normalizedObjective: normalizeCollaborationObjective(baseRequest.objective),
        status: "completed",
        visibilityMode: "summary",
      });
      storage.insertAgentCollaborationDelivery({
        collaborationId,
        eventKind: "completed",
        destinationChannelId: "channel-1",
        discordMessageId: "message-1",
        status: "delivered",
      });
      storage.insertAgentCollaborationDelivery({
        collaborationId,
        eventKind: "digest",
        destinationChannelId: "channel-1",
        status: "failed",
        error: "delivery unavailable",
      });

      const deliveries = storage.listAgentCollaborationDeliveries(collaborationId);
      expect(deliveries).toHaveLength(2);
      expect(deliveries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          eventKind: "completed",
          destinationChannelId: "channel-1",
          discordMessageId: "message-1",
          status: "delivered",
        }),
        expect.objectContaining({
          eventKind: "digest",
          status: "failed",
          error: "delivery unavailable",
        }),
      ]));
    } finally {
      storage.close();
    }
  });

  it("renders target prompts with objective, context, constraints, and bounded-output rails", () => {
    const prompt = renderAgentCollaborationTargetPrompt(baseRequest);

    expect(prompt).toContain("Objective: Verify whether the cited source supports the claim.");
    expect(prompt).toContain("Context summary: A draft mentions a source-backed claim.");
    expect(prompt).toContain("- Do not write to external systems.");
    expect(prompt).toContain("Return one compact JSON object");
    expect(prompt).toContain("Do not continue the conversation");
  });
});
