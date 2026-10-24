import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatProvider, V2AgentConfig } from "@tango/core";
import { StateService, TangoStorage } from "@tango/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildStateReconcilerPrompt, parseStateChangeset, resolveStateReconcilerSettings, runStateReconciler } from "../src/state-reconciler.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-reconciler-"));
  dirs.push(dir);
  const storage = new TangoStorage(path.join(dir, "tango.sqlite"));
  const service = new StateService(storage.getDatabase(), { now: () => new Date("2026-07-17T12:00:00Z") });
  const config = {
    id: "watson",
    displayName: "Watson",
    type: "personal",
    systemPromptFile: "fixture.md",
    mcpServers: [],
    runtime: { mode: "persistent", provider: "claude-code-v2", model: "fixture", reasoningEffort: "low", idleTimeoutHours: 24, contextResetThreshold: 0.8 },
    memory: { postTurnExtraction: "enabled", extractionModel: "fixture-extractor", importanceThreshold: 0.4, scheduledReflection: "enabled" },
    state: { reconciliation: "enabled", extractionProvider: "fixture", extractionModel: "fixture-state", alwaysOnTypes: ["project"], focusTtlDays: 7 },
    discord: { defaultChannelId: "fixture" },
  } satisfies V2AgentConfig;
  return { storage, service, config };
}

function provider(...responses: string[]): ChatProvider {
  const queue = [...responses];
  return {
    generate: vi.fn(async () => ({ text: queue.shift() ?? '{"changes":[],"engaged_entity_ids":[]}', durationMs: 1 })),
  };
}

function turn(index: number, userMessage: string, agentResponse = "Acknowledged.") {
  return {
    turnId: `turn-${index}`,
    conversationKey: "thread:fixture",
    sessionId: "session-fixture",
    agentId: "watson",
    userMessage,
    agentResponse,
    requestMessageId: `request-${index}`,
    responseMessageId: `response-${index}`,
    occurredAt: `2026-07-${String(10 + index).padStart(2, "0")}T12:00:00Z`,
  };
}

describe("State Reconciler fixture dataset", () => {
  it("routes a Claude extraction model independently of an Ollama serving runtime", () => {
    const ollamaServingConfig = {
      ...configForSettings(),
      legacyProvider: { default: "ollama", failover: [] },
      memory: { ...configForSettings().memory, extractionModel: "claude-haiku-4-5" },
    } satisfies V2AgentConfig;
    expect(resolveStateReconcilerSettings(ollamaServingConfig)).toMatchObject({
      providerName: "claude-oauth",
      model: "claude-haiku-4-5",
    });
  });

  it("rejects non-empty changes that do not match the constrained action schema", () => {
    expect(() => parseStateChangeset('{"changes":[{"operation":"add"}],"engaged_entity_ids":[]}'))
      .toThrow(/required action schema/u);
  });

  it("normalizes generic operational fields and forbids inferred completion in the prompt", () => {
    const { storage, service } = harness();
    const snapshot = service.buildReconcilerSnapshot({ conversationKey: "thread:fixture" });
    const prompt = buildStateReconcilerPrompt({ turn: turn(1, "Fixture narrative."), snapshot });
    expect(prompt).toContain("NEVER infer completion from narrative");
    expect(prompt).toContain("mark_progress=true only for meaningful forward movement");

    expect(parseStateChangeset(JSON.stringify({
      changes: [{
        action: "update",
        entity_id: "project:fixture",
        project_entity_id: "project:root",
        owner_user_id: "user:fixture",
        owner_agent_id: "watson",
        visibility: "shared",
        due_at: "2026-07-20T12:00:00Z",
        next_check_at: "2026-07-19T12:00:00Z",
        expected_response_at: "2026-07-21T12:00:00Z",
        last_progress_at: "2026-07-18T12:00:00Z",
        mark_progress: true,
        relations: [{ kind: "depends_on", target_entity_id: "project:root" }],
        references: [{ role: "evidence", ref: "profile:logs/synthetic.md" }],
        evidence: "Fixture narrative.",
      }],
      engaged_entity_ids: [],
    })).changes[0]).toMatchObject({
      projectEntityId: "project:root",
      ownerUserId: "user:fixture",
      ownerAgentId: "watson",
      visibility: "shared",
      dueAt: "2026-07-20T12:00:00Z",
      nextCheckAt: "2026-07-19T12:00:00Z",
      expectedResponseAt: "2026-07-21T12:00:00Z",
      lastProgressAt: "2026-07-18T12:00:00Z",
      markProgress: true,
      relations: [{ kind: "depends_on", targetEntityId: "project:root" }],
      references: [{ role: "evidence", ref: "profile:logs/synthetic.md" }],
    });
    storage.close();
  });

  it("creates, corrects, aliases, focuses, no-ops idempotently, and undoes the preceding state turn", async () => {
    const { storage, service, config } = harness();
    const outputs = provider(
      JSON.stringify({ changes: [{ action: "new_entity", type_id: "project", title: "Fixture Launch", status: "active", attributes: { progress_pct: 10 }, evidence: "Fixture Launch is active at 10 percent." }], engaged_entity_ids: [] }),
      JSON.stringify({ changes: [{ action: "update", entity_id: "project:fixture-launch", attributes: { progress_pct: 25 }, evidence: "Correction: Fixture Launch is at 25 percent." }], engaged_entity_ids: ["project:fixture-launch"] }),
      JSON.stringify({ changes: [{ action: "update", entity_id: "project:fixture-launch", aliases: ["Launch Fixture"], evidence: "Call Fixture Launch the Launch Fixture." }], engaged_entity_ids: [] }),
      JSON.stringify({ changes: [{ action: "update", entity_id: "project:fixture-launch", attributes: { progress_pct: 25 }, evidence: "It remains at 25 percent." }], engaged_entity_ids: [] }),
      JSON.stringify({ changes: [{ action: "revert", evidence: "Undo that." }], engaged_entity_ids: [] }),
    );
    const run = (index: number, message: string) => runStateReconciler({
      service,
      v2Config: config,
      resolveProvider: () => outputs,
      turn: turn(index, message),
    });

    expect((await run(1, "Fixture Launch is active at 10 percent.")).appliedEventIds).toHaveLength(1);
    expect(service.getEntity("project:fixture-launch")?.attributes.progress_pct).toBe(10);
    expect((await run(2, "Correction: Fixture Launch is at 25 percent.")).claimedFacts).toEqual(["Correction: Fixture Launch is at 25 percent."]);
    expect(service.getEntity("project:fixture-launch")?.attributes.progress_pct).toBe(25);
    await run(3, "Call Fixture Launch the Launch Fixture.");
    expect(service.getEntity("project:fixture-launch")?.aliases).toContain("Launch Fixture");
    const noOp = await run(4, "It remains at 25 percent.");
    expect(noOp.appliedEventIds).toEqual([]);
    expect(noOp.claimedFacts).toEqual([]);
    const undo = await run(5, "Undo that.");
    expect(undo.revertedEventIds).toHaveLength(1);
    expect(service.getEntity("project:fixture-launch")?.aliases).toEqual([]);
    expect(service.buildDigest({ conversationKey: "thread:fixture" })).toContain("Fixture Launch");
    expect(Number((storage.getDatabase().prepare("SELECT COUNT(*) AS count FROM state_reconciler_runs WHERE status='ok'").get() as { count: number }).count)).toBe(5);
    storage.close();
  });

  it("retries a missing-entity update as a grounded new entity before applying", async () => {
    const { storage, service, config } = harness();
    const outputs = provider(
      JSON.stringify({ changes: [{ action: "update", entity_id: "project:retry-fixture", attributes: { progress_pct: 10 }, evidence: "Track Retry Fixture as active at 10 percent." }], engaged_entity_ids: [] }),
      JSON.stringify({ changes: [{ action: "new_entity", entity_id: "project:predicted-retry-fixture", type_id: "project", title: "Retry Fixture", status: "active", attributes: { progress_pct: 10 }, evidence: "Track Retry Fixture as active at 10 percent." }], engaged_entity_ids: [] }),
    );
    const result = await runStateReconciler({
      service,
      v2Config: config,
      resolveProvider: () => outputs,
      turn: turn(1, "Track Retry Fixture as active at 10 percent."),
    });
    expect(outputs.generate).toHaveBeenCalledTimes(2);
    expect(result.appliedEventIds).toHaveLength(1);
    expect(service.getEntity("project:retry-fixture")?.attributes.progress_pct).toBe(10);
    storage.close();
  });

  it("applies project scope, temporal progress, relations, and evidence from a deterministic result", async () => {
    const { storage, service, config } = harness();
    service.defineType({
      id: "activity",
      displayName: "Activity",
      origin: "seed",
      attributesSchema: { type: "object", additionalProperties: false, properties: {} },
      statuses: {
        values: ["open", "done"],
        transitions: { open: ["done"], done: ["open"] },
        initial: "open",
        terminal: ["done"],
      },
    }, { includePrivate: true });
    const root = service.mutate({
      typeId: "project",
      title: "Synthetic Root",
      status: "active",
      attributes: {},
    }, { actor: "test", source: "test", includePrivate: true }).entity;
    const evidence = "verified_complete";
    const outputs = provider(JSON.stringify({
      changes: [{
        action: "new_entity",
        type_id: "activity",
        title: "Verified checkpoint",
        status: "done",
        project_entity_id: root.id,
        owner_agent_id: "watson",
        due_at: "2026-07-16T12:00:00Z",
        mark_progress: true,
        relations: [{ kind: "belongs_to", target_entity_id: root.id }],
        references: [{ role: "evidence", ref: "profile:logs/synthetic-check.md" }],
        evidence,
      }],
      engaged_entity_ids: [],
    }));
    const result = await runStateReconciler({
      service,
      v2Config: config,
      resolveProvider: () => outputs,
      turn: {
        ...turn(6, "Record the deterministic checkpoint result."),
        toolCalls: [{
          name: "fixture_check",
          input: { fixture: true },
          output: { status: evidence, log: "profile:logs/synthetic-check.md" },
        }],
      },
    });
    expect(result.rejected).toEqual([]);
    expect(result.appliedEventIds).toHaveLength(1);
    const [entity] = service.query({
      type: "activity",
      projectEntityId: root.id,
      includeRelations: true,
      includeReferences: true,
      includePrivate: true,
    }).entities;
    expect(entity).toMatchObject({
      status: "done",
      projectEntityId: root.id,
      ownerAgentId: "watson",
      dueAt: "2026-07-16T12:00:00.000Z",
      lastProgressAt: "2026-07-16T12:00:00.000Z",
      relations: [{ kind: "belongs_to", targetEntityId: root.id }],
      references: [{ role: "evidence", ref: "profile:logs/synthetic-check.md" }],
    });
    storage.close();
  });

  it("rejects invented evidence and persists a failed run after retry", async () => {
    const { storage, service, config } = harness();
    const phantomFocus = await runStateReconciler({
      service,
      v2Config: config,
      resolveProvider: () => provider(JSON.stringify({ changes: [], engaged_entity_ids: ["project:phantom"] })),
      turn: turn(1, "Nothing changed."),
    });
    expect(phantomFocus.status).toBe("ok");
    expect(phantomFocus.rejected).toEqual(["engaged entity 'project:phantom' does not exist or is not visible"]);

    const invented = await runStateReconciler({
      service,
      v2Config: config,
      resolveProvider: () => provider(JSON.stringify({ changes: [{ action: "new_entity", type_id: "project", title: "Invented", attributes: {}, evidence: "not in the turn" }] })),
      turn: turn(2, "Nothing changed."),
    });
    expect(invented.appliedEventIds).toEqual([]);
    expect(invented.rejected[0]).toMatch(/evidence quote/u);

    const onPersistentFailure = vi.fn();
    const failed = await runStateReconciler({
      service,
      v2Config: config,
      resolveProvider: () => ({ generate: vi.fn(async () => { throw new Error("fixture outage"); }) }),
      turn: turn(3, "Still nothing."),
      onPersistentFailure,
    });
    expect(failed.status).toBe("error");
    expect(onPersistentFailure).toHaveBeenCalledOnce();
    expect((storage.getDatabase().prepare("SELECT status, error FROM state_reconciler_runs WHERE turn_id='turn-3'").get() as { status: string; error: string })).toMatchObject({ status: "error", error: "fixture outage" });
    storage.close();
  }, 10_000);
});

function configForSettings(): V2AgentConfig {
  return {
    id: "ollama-test", displayName: "Ollama Test", type: "personal", systemPromptFile: "fixture.md", mcpServers: [],
    runtime: { mode: "persistent", provider: "ollama", model: "fixture", reasoningEffort: "low", idleTimeoutHours: 24, contextResetThreshold: 0.8 },
    memory: { postTurnExtraction: "enabled", extractionModel: "fixture", importanceThreshold: 0.4, scheduledReflection: "enabled" },
    state: { reconciliation: "enabled", alwaysOnTypes: ["project"], focusTtlDays: 7 },
    discord: { defaultChannelId: "fixture" },
  };
}
