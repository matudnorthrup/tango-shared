import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { StateService } from "../src/state-management.js";
import { TangoStorage } from "../src/storage.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function harness(now: Date | (() => Date) = new Date("2026-07-17T12:00:00.000Z")) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-state-"));
  tempDirs.push(dir);
  const storage = new TangoStorage(path.join(dir, "tango.sqlite"));
  const service = new StateService(storage.getDatabase(), { now: typeof now === "function" ? now : () => now });
  const context = {
    actor: "test",
    source: "test-harness",
    sessionId: "session-1",
    turnId: "turn-1",
    agentId: "watson",
    agentType: "personal",
  } as const;
  return { storage, service, context, db: storage.getDatabase() };
}

describe("state management schema and governance", () => {
  it("migrates the complete substrate, seeds only generic types, and grants state tools", () => {
    const { storage, service, db } = harness();
    expect(Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version)).toBeGreaterThanOrEqual(66);
    expect((db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5_000);
    for (const table of [
      "state_entity_types", "state_entities", "state_events", "state_focus",
      "state_reconciler_runs", "state_issues", "state_memory_links", "state_adapter_cursors",
      "state_entity_relations", "state_entity_references",
    ]) {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)).toBeTruthy();
    }
    expect(db.prepare("SELECT id FROM state_entity_types ORDER BY id").all().map((row) => (row as { id: string }).id)).toEqual([
      "automation-job", "body-composition", "finance-review", "project", "travel", "vehicle",
    ]);
    const stateTools = db.prepare("SELECT id FROM governance_tools WHERE id LIKE 'state_%' ORDER BY id").all().map((row) => (row as { id: string }).id);
    expect(stateTools).toEqual(["state_define_type", "state_query", "state_update"]);
    expect(Number((db.prepare("SELECT COUNT(*) AS count FROM permissions WHERE tool_id='state_query'").get() as { count: number }).count)).toBeGreaterThan(0);
    expect(Number((db.prepare("SELECT COUNT(*) AS count FROM state_entities").get() as { count: number }).count)).toBe(0);
    expect(service.getType("project")?.statuses?.terminal).toEqual(["done", "dropped"]);
    expect(service.getType("travel")?.statuses?.terminal).toEqual(["completed", "canceled"]);
    expect(service.getType("vehicle")?.statuses?.terminal).toEqual(["sold", "retired"]);
    expect(service.getType("finance-review", { includePrivate: true })?.statuses?.terminal).toEqual([
      "complete", "complete_with_actions",
    ]);
    storage.close();
  });

  it("preserves v64 heads and events while migrating through the generic v65 and v66 substrate", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-state-v64-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "tango.sqlite");
    let storage = new TangoStorage(dbPath);
    let service = new StateService(storage.getDatabase(), { now: () => new Date("2026-07-17T12:00:00Z") });
    const created = service.mutate({
      typeId: "project",
      title: "Migration Fixture",
      status: "active",
      attributes: { progress_pct: 25 },
    }, { actor: "migration-test", source: "test" });
    const eventId = created.event!.id;
    storage.close();

    const oldDb = new DatabaseSync(dbPath);
    oldDb.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE state_entity_relations;
      DROP TABLE state_entity_references;
      DROP INDEX idx_state_entities_project;
      DROP INDEX idx_state_entities_owner_user;
      DROP INDEX idx_state_entities_owner_agent;
      DROP INDEX idx_state_entities_due;
      DROP INDEX idx_state_entities_next_check;
      DROP INDEX idx_state_entities_expected_response;
      DROP INDEX idx_state_entities_progress;
      ALTER TABLE state_entities DROP COLUMN project_entity_id;
      ALTER TABLE state_entities DROP COLUMN visibility;
      ALTER TABLE state_entities DROP COLUMN due_at;
      ALTER TABLE state_entities DROP COLUMN next_check_at;
      ALTER TABLE state_entities DROP COLUMN expected_response_at;
      ALTER TABLE state_entities DROP COLUMN last_progress_at;
      ALTER TABLE state_entities DROP COLUMN closed_at;
      UPDATE state_entity_types
      SET statuses = json_remove(statuses, '$.terminal')
      WHERE statuses IS NOT NULL;
      PRAGMA user_version = 64;
    `);
    oldDb.close();

    storage = new TangoStorage(dbPath);
    service = new StateService(storage.getDatabase(), { now: () => new Date("2026-07-18T12:00:00Z") });
    // The point is that the v65/v66 substrate migrated, not that 66 is the head;
    // later migrations keep landing above it.
    expect((storage.getDatabase().prepare("PRAGMA user_version").get() as { user_version: number }).user_version)
      .toBeGreaterThanOrEqual(66);
    expect(service.getEntity(created.entity.id)).toMatchObject({
      title: "Migration Fixture",
      attributes: { progress_pct: 25 },
      lastProgressAt: "2026-07-17T12:00:00.000Z",
    });
    expect(service.listEvents(created.entity.id).some((event) => event.id === eventId)).toBe(true);
    expect(service.getType("project")?.statuses?.terminal).toEqual(["done", "dropped"]);
    expect(storage.getDatabase().prepare("SELECT name FROM sqlite_master WHERE name='state_entity_relations'").get()).toBeTruthy();
    storage.close();
  });

  it("preserves existing terminal additions and backfills closed heads from a v65 database", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-state-v65-terminal-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "tango.sqlite");
    let storage = new TangoStorage(dbPath);
    let service = new StateService(storage.getDatabase(), { now: () => new Date("2026-07-17T12:00:00Z") });
    const completed = service.mutate({
      typeId: "project",
      title: "Terminal Backfill Fixture",
      status: "done",
      dueAt: "2026-07-16T12:00:00Z",
      attributes: {},
    }, { actor: "migration-test", source: "test" });
    const expectedClosedAt = completed.entity.lastEventAt;
    storage.close();

    const oldDb = new DatabaseSync(dbPath);
    oldDb.exec(`
      UPDATE state_entity_types
      SET statuses = json_set(
        json_insert(statuses, '$.values[#]', 'parked'),
        '$.terminal',
        json('["parked"]')
      )
      WHERE id = 'project';
      UPDATE state_entities SET closed_at = NULL WHERE id = '${completed.entity.id}';
      PRAGMA user_version = 65;
    `);
    oldDb.close();

    storage = new TangoStorage(dbPath);
    service = new StateService(storage.getDatabase(), { now: () => new Date("2026-07-18T12:00:00Z") });
    expect(service.getType("project")?.statuses?.terminal).toEqual(["parked", "done", "dropped"]);
    expect(service.getEntity(completed.entity.id)).toMatchObject({ closedAt: expectedClosedAt, overdue: false });
    storage.close();
  });
});

describe("StateService", () => {
  it("validates, transitions, deduplicates, records provenance, and queries deterministically", () => {
    const { storage, service, context } = harness();
    const created = service.mutate({
      typeId: "project",
      title: "Synthetic Launch",
      status: "active",
      attributes: { next_action: "Run the fixture", progress_pct: 10 },
    }, context);
    expect(created.created).toBe(true);
    expect(created.event).toMatchObject({ kind: "create", actor: "test", sessionId: "session-1", turnId: "turn-1" });

    const duplicate = service.mutate({
      typeId: "project",
      title: "Synthetic Launch",
      attributes: { progress_pct: 10 },
    }, { ...context, turnId: "turn-2" });
    expect(duplicate.applied).toBe(false);
    expect(duplicate.reason).toBe("no_change");
    expect(service.query({ text: "synthetic", recentEvents: 5 }).entities).toHaveLength(1);

    expect(() => service.mutate({
      entityId: created.entity.id,
      attributes: { progress_pct: 101 },
    }, { ...context, turnId: "turn-invalid" })).toThrow(/must be <= 100/u);
    expect(() => service.mutate({
      entityId: created.entity.id,
      status: "idea",
    }, { ...context, turnId: "turn-invalid-status" })).toThrow(/Illegal Project transition/u);

    const changed = service.mutate({
      entityId: created.entity.id,
      attributes: { progress_pct: 40 },
      status: "blocked",
    }, { ...context, turnId: "turn-3", messageId: "message-3" });
    expect(changed.entity.attributes.progress_pct).toBe(40);
    expect(changed.entity.status).toBe("blocked");
    expect(changed.event?.messageId).toBe("message-3");
    expect(service.renderTurnReceipt("turn-3")).toContain("progress pct 10 → 40");
    storage.close();
  });

  it("keeps state receipts compact without echoing long narrative fields", () => {
    const { storage, service, context } = harness();
    const created = service.mutate({
      typeId: "project",
      title: "Receipt Fixture",
      status: "active",
      summary: "Earlier project summary",
      attributes: { progress_pct: 64 },
    }, context);
    const longSummary = `Updated project summary ${"x".repeat(2_000)}`;
    service.mutate({
      entityId: created.entity.id,
      summary: longSummary,
      attributes: { progress_pct: 91, next_action: `Complete ${"y".repeat(500)}` },
      markProgress: true,
    }, { ...context, turnId: "turn-compact-receipt", occurredAt: "2026-07-17T12:01:00.000Z" });

    const receipt = service.renderTurnReceipt("turn-compact-receipt");
    expect(receipt).toContain("summary updated");
    expect(receipt).toContain("next action updated");
    expect(receipt).toContain("progress pct 64 → 91");
    expect(receipt).toContain("progress recorded");
    expect(receipt).not.toContain("Earlier project summary");
    expect(receipt).not.toContain(longSummary);
    expect(receipt).not.toContain(`Complete ${"y".repeat(500)}`);
    expect(receipt!.length).toBeLessThanOrEqual(480);
    storage.close();
  });

  it("supports exact matching for distinct machine-owned projections", () => {
    const { storage, service, context } = harness();
    const production = service.mutate({
      typeId: "project",
      title: "Finance Review",
      aliases: ["weekly-finance-review"],
      matchStrategy: "exact",
      status: "active",
      attributes: {},
    }, context);
    const dryRun = service.mutate({
      typeId: "project",
      title: "Finance Review Dry Run",
      aliases: ["manual-test-weekly-finance-review"],
      matchStrategy: "exact",
      status: "active",
      attributes: {},
    }, context);

    expect(dryRun.entity.id).not.toBe(production.entity.id);
    expect(service.query({ type: "project" }).entities).toHaveLength(2);
    expect(service.mutate({
      typeId: "project",
      title: "Renamed Dry Run",
      aliases: ["manual-test-weekly-finance-review"],
      matchStrategy: "exact",
      attributes: { next_action: "Verify the projection" },
    }, context).entity.id).toBe(dryRun.entity.id);
    storage.close();
  });

  it("applies seeded terminal metadata to project deadlines and reopening", () => {
    let now = new Date("2026-07-17T12:00:00Z");
    const { storage, service, context } = harness(() => now);
    const project = service.mutate({
      typeId: "project",
      title: "Deadline Lifecycle Fixture",
      status: "active",
      dueAt: "2026-07-16T12:00:00Z",
      attributes: {},
    }, context);
    expect(project.entity).toMatchObject({ overdue: true, closedAt: null });

    now = new Date("2026-07-18T12:00:00Z");
    const completed = service.mutate({
      entityId: project.entity.id,
      status: "done",
    }, { ...context, turnId: "turn-project-done" });
    expect(completed.entity).toMatchObject({
      status: "done",
      closedAt: "2026-07-18T12:00:00.000Z",
      overdue: false,
    });
    expect(service.query({ entityId: project.entity.id, overdue: true }).entities).toEqual([]);

    const reopened = service.mutate({
      entityId: project.entity.id,
      status: "active",
    }, { ...context, turnId: "turn-project-reopened" });
    expect(reopened.entity).toMatchObject({ status: "active", closedAt: null, overdue: true });
    storage.close();
  });

  it("supports observations, trend aggregations, per-event revert, turn undo, and create undo by archive", () => {
    const { storage, service, context } = harness(new Date("2020-01-17T12:00:00Z"));
    const entity = service.mutate({
      typeId: "body-composition",
      title: "Fixture Metrics",
      attributes: { weight_lb: 180 },
      kind: "observation",
    }, { ...context, agentId: "malibu", agentType: "wellness", occurredAt: "2020-01-15T12:00:00Z" });
    const update = service.mutate({
      entityId: entity.entity.id,
      attributes: { weight_lb: 178, body_fat_pct: 20 },
      kind: "observation",
    }, { ...context, agentId: "malibu", agentType: "wellness", turnId: "turn-metrics", occurredAt: "2020-01-16T12:00:00Z" });
    expect(service.query({
      entityId: entity.entity.id,
      agentId: "malibu",
      agentType: "wellness",
      trend: { field: "weight_lb", windowDays: 30, aggregation: "change" },
    }).trend).toMatchObject({ value: -2 });

    const reverted = service.revertEvent(update.event!.id, {
      ...context,
      agentId: "malibu",
      agentType: "wellness",
      turnId: "turn-revert",
    });
    expect(reverted.entity.attributes).toEqual({ weight_lb: 180 });
    expect(reverted.event?.revertsEventId).toBe(update.event!.id);
    expect(service.revertEvent(update.event!.id, { ...context, agentId: "malibu", agentType: "wellness" }).reason).toBe("already_reverted");

    const project = service.mutate({ typeId: "project", title: "Undo Fixture", status: "active", attributes: {} }, { ...context, turnId: "turn-create" });
    const undo = service.revertTurn("turn-create", { ...context, turnId: "turn-undo" });
    expect(undo.applied).toBe(1);
    expect(service.getEntity(project.entity.id)).toBeNull();
    expect(service.getEntity(project.entity.id, {}, true)?.title).toBe("Undo Fixture");
    storage.close();
  });

  it("enforces private visibility while allowing the wellness scope", () => {
    const { storage, service, context } = harness();
    const created = service.mutate({ typeId: "body-composition", title: "Private Fixture", attributes: { weight_lb: 170 } }, {
      ...context,
      agentId: "malibu-ollama",
      agentType: "wellness",
    });
    expect(service.getEntity(created.entity.id, { agentId: "watson", agentType: "personal" })).toBeNull();
    expect(service.getEntity(created.entity.id, { agentId: "malibu", agentType: "wellness" })).not.toBeNull();
    expect(service.query({ agentId: "watson", agentType: "personal" }).entities).toHaveLength(0);
    storage.close();
  });

  it("builds focus-first bounded digests and expires stale focus", () => {
    let now = new Date("2026-07-17T12:00:00Z");
    const { storage, service, context } = harness(now);
    const first = service.mutate({
      typeId: "project",
      title: "Focused Fixture",
      status: "active",
      attributes: { next_action: `Verify digest ${"x".repeat(500)}` },
    }, context);
    for (let index = 0; index < 20; index += 1) {
      service.mutate({ typeId: "vehicle", title: `Fixture Vehicle ${index}`, attributes: { make: "Test", model: `V${index}` } }, { ...context, turnId: `vehicle-${index}` });
    }
    service.focusEntities("discord:fixture", [first.entity.id], 1);
    const digest = service.buildDigest({ conversationKey: "discord:fixture", alwaysOnTypes: ["vehicle"], tokenBudget: 80, now });
    expect(digest).toContain("state (canonical — overrides anything remembered)");
    expect(digest).toContain("Focused Fixture");
    expect(digest!.length).toBeLessThanOrEqual(80 * 4 + 32);
    now = new Date("2026-07-19T12:00:00Z");
    storage.getDatabase().prepare("UPDATE state_focus SET expires_at = '2026-07-16 00:00:00'").run();
    expect(service.sweep().evaluated).toBe(21);
    expect(Number((storage.getDatabase().prepare("SELECT COUNT(*) AS count FROM state_focus").get() as { count: number }).count)).toBe(0);
    storage.close();
  });

  it("allows confirmed additive type evolution and rejects destructive changes", () => {
    const { storage, service } = harness();
    expect(() => service.defineType({
      id: "fixture", displayName: "Fixture", attributesSchema: { type: "object", properties: {} }, origin: "conversation",
    })).toThrow(/confirm=true/u);
    service.defineType({
      id: "fixture",
      displayName: "Fixture",
      attributesSchema: { type: "object", additionalProperties: false, properties: { label: { type: "string" } } },
      origin: "conversation",
      confirm: true,
    });
    const evolved = service.defineType({
      id: "fixture",
      displayName: "Fixture",
      attributesSchema: { type: "object", additionalProperties: false, properties: { label: { type: "string" }, count: { type: "number" } } },
      origin: "conversation",
      confirm: true,
    });
    expect(evolved.type.attributesSchema).toHaveProperty("properties.count");
    expect(() => service.defineType({
      id: "fixture", displayName: "Fixture", attributesSchema: { type: "object", properties: { count: { type: "number" } } }, origin: "conversation", confirm: true,
    })).toThrow(/cannot be removed/u);
    const normalized = service.defineType({
      id: `${"-".repeat(20_000)}Fixture${"-".repeat(20_000)}Type${"-".repeat(20_000)}`,
      displayName: "Normalized Fixture",
      attributesSchema: { type: "object", properties: {} },
      origin: "conversation",
      confirm: true,
    });
    expect(normalized.type.id).toBe("fixture-type");
    storage.close();
  });

  it("supports generic project scope, inherited privacy, temporal queries, relations, and references", () => {
    let now = new Date("2026-07-17T12:00:00Z");
    const { storage, service, context } = harness(() => now);
    const scopedContext = { ...context, scopes: ["alpha"], turnId: "turn-project" };
    service.defineType({
      id: "fixture-item",
      displayName: "Fixture Item",
      attributesSchema: {
        type: "object",
        additionalProperties: false,
        properties: { detail: { type: "string" }, revision: { type: "integer" } },
      },
      statuses: {
        values: ["open", "done"],
        transitions: { open: ["done"], done: ["open"] },
        initial: "open",
        terminal: ["done"],
      },
      stalenessPolicy: { expected_update_days: 3, on_stale: "nudge" },
      origin: "conversation",
      confirm: true,
    }, scopedContext);
    const project = service.mutate({
      typeId: "project",
      title: "Private Project Fixture",
      status: "active",
      attributes: {},
      visibility: "private:alpha",
    }, scopedContext);
    const dependency = service.mutate({
      typeId: "fixture-item",
      title: "Dependency Fixture",
      projectEntityId: project.entity.id,
      ownerUserId: "fixture-owner",
      attributes: { detail: "prerequisite", revision: 1 },
    }, { ...scopedContext, turnId: "turn-dependency" });
    const tracked = service.mutate({
      typeId: "fixture-item",
      title: "Tracked Fixture",
      aliases: ["Tracked Alias"],
      projectEntityId: project.entity.id,
      ownerUserId: "fixture-owner",
      ownerAgentId: "fixture-agent",
      summary: "Synthetic quick read",
      bodyPointer: "profile:fixtures/tracked.md",
      dueAt: "2026-07-18T09:00:00Z",
      nextCheckAt: "2026-07-18T15:00:00Z",
      expectedResponseAt: "2026-07-18T18:00:00Z",
      attributes: { detail: "synthetic", revision: 1 },
      relations: [{ kind: "depends_on", targetEntityId: dependency.entity.id, metadata: { order: 1 } }],
      references: [{
        role: "evidence",
        ref: "obsidian:fixtures/evidence.md",
        label: "Synthetic evidence",
        supportsEventId: dependency.event!.id,
      }],
    }, { ...scopedContext, turnId: "turn-tracked" });
    expect(project.event?.patch).toMatchObject({
      visibility: { from: null, to: "private:alpha" },
      lastProgressAt: { from: null, to: "2026-07-17T12:00:00.000Z" },
    });
    expect(tracked.event?.patch).toMatchObject({
      aliases: { from: [], to: ["Tracked Alias"] },
      summary: { from: null, to: "Synthetic quick read" },
      bodyPointer: { from: null, to: "profile:fixtures/tracked.md" },
      ownerUserId: { from: null, to: "fixture-owner" },
      ownerAgentId: { from: null, to: "fixture-agent" },
      projectEntityId: { from: null, to: project.entity.id },
      dueAt: { from: null, to: "2026-07-18T09:00:00.000Z" },
      nextCheckAt: { from: null, to: "2026-07-18T15:00:00.000Z" },
      expectedResponseAt: { from: null, to: "2026-07-18T18:00:00.000Z" },
      lastProgressAt: { from: null, to: "2026-07-17T12:00:00.000Z" },
    });

    now = new Date("2026-07-19T12:00:00Z");
    const result = service.query({
      ...scopedContext,
      projectEntityId: project.entity.id,
      ownerUserId: "fixture-owner",
      ownerAgentId: "fixture-agent",
      source: "test-harness",
      overdue: true,
      nextCheckBefore: "2026-07-19T00:00:00Z",
      expectedResponseBefore: "2026-07-19T00:00:00Z",
      relationKind: "depends_on",
      relatedEntityId: dependency.entity.id,
      referenceRole: "evidence",
      includeRelations: true,
      includeReferences: true,
    }).entities;
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: tracked.entity.id,
      projectEntityId: project.entity.id,
      overdue: true,
      relations: [{ kind: "depends_on", targetEntityId: dependency.entity.id, metadata: { order: 1 } }],
      references: [{ role: "evidence", ref: "obsidian:fixtures/evidence.md", label: "Synthetic evidence" }],
    });

    expect(service.query({ projectEntityId: project.entity.id, includeRelations: true, includeReferences: true }).entities).toEqual([]);
    expect(service.getEntity(tracked.entity.id)).toBeNull();
    expect(service.listRelations(tracked.entity.id)).toEqual([]);
    expect(service.listReferences(tracked.entity.id)).toEqual([]);

    const nestedProject = service.mutate({
      typeId: "project",
      title: "Nested Project Fixture",
      status: "active",
      projectEntityId: project.entity.id,
      attributes: {},
    }, { ...scopedContext, turnId: "turn-nested-project" });
    const nestedItem = service.mutate({
      typeId: "fixture-item",
      title: "Nested Item Fixture",
      projectEntityId: nestedProject.entity.id,
      attributes: { revision: 1 },
    }, { ...scopedContext, turnId: "turn-nested-item" });
    expect(service.getEntity(nestedItem.entity.id)).toBeNull();
    expect(() => service.mutate({
      entityId: project.entity.id,
      projectEntityId: nestedProject.entity.id,
    }, { ...scopedContext, turnId: "turn-project-cycle" })).toThrow(/cannot form a cycle/u);

    const privateTarget = service.mutate({
      typeId: "fixture-item",
      title: "Private Relation Target Fixture",
      visibility: "private:alpha",
      attributes: { revision: 1 },
    }, { ...scopedContext, turnId: "turn-private-target" });
    const sharedSource = service.mutate({
      typeId: "fixture-item",
      title: "Shared Relation Source Fixture",
      attributes: { revision: 1 },
      relations: [{ kind: "related_to", targetEntityId: privateTarget.entity.id }],
    }, { ...scopedContext, turnId: "turn-shared-source" });
    expect(service.getEntity(sharedSource.entity.id)).not.toBeNull();
    expect(service.query({ relationKind: "related_to", relatedEntityId: privateTarget.entity.id }).entities).toEqual([]);
    expect(service.query({
      ...scopedContext,
      relationKind: "related_to",
      relatedEntityId: privateTarget.entity.id,
    }).entities.map((entity) => entity.id)).toEqual([sharedSource.entity.id]);
    storage.close();
  });

  it("distinguishes progress from touches and reverses terminal, relation, and reference changes", () => {
    let now = new Date("2026-07-17T12:00:00Z");
    const { storage, service, context } = harness(() => now);
    service.defineType({
      id: "lifecycle-fixture",
      displayName: "Lifecycle Fixture",
      attributesSchema: {
        type: "object",
        additionalProperties: false,
        properties: { revision: { type: "integer" } },
      },
      statuses: {
        values: ["open", "done"],
        transitions: { open: ["done"], done: ["open"] },
        initial: "open",
        terminal: ["done"],
      },
      stalenessPolicy: { expected_update_days: 2, on_stale: "nudge" },
      origin: "conversation",
      confirm: true,
    });
    const target = service.mutate({
      typeId: "lifecycle-fixture",
      title: "Relation Target Fixture",
      attributes: { revision: 1 },
    }, context);
    const tracked = service.mutate({
      typeId: "lifecycle-fixture",
      title: "Lifecycle Tracked Fixture",
      dueAt: "2026-07-18T00:00:00Z",
      attributes: { revision: 1 },
      relations: [{ kind: "blocks", targetEntityId: target.entity.id }],
      references: [{ role: "log", ref: "profile:fixtures/run.log" }],
    }, { ...context, turnId: "turn-create-lifecycle" });
    const initialProgress = tracked.entity.lastProgressAt;
    const initialStaleAfter = tracked.entity.staleAfter;

    now = new Date("2026-07-18T12:00:00Z");
    const note = service.mutate({
      entityId: tracked.entity.id,
      kind: "note",
      note: "Synthetic touch only",
    }, { ...context, turnId: "turn-touch" });
    expect(note.entity.lastProgressAt).toBe(initialProgress);
    expect(note.entity.staleAfter).toBe(initialStaleAfter);
    const explicitNoProgress = service.mutate({
      entityId: tracked.entity.id,
      attributes: { revision: 2 },
      markProgress: false,
    }, { ...context, turnId: "turn-no-progress" });
    expect(explicitNoProgress.entity.lastProgressAt).toBe(initialProgress);

    now = new Date("2026-07-19T12:00:00Z");
    const progress = service.mutate({
      entityId: tracked.entity.id,
      attributes: { revision: 3 },
    }, { ...context, turnId: "turn-progress" });
    expect(progress.entity.lastProgressAt).toBe("2026-07-19T12:00:00.000Z");
    expect(progress.entity.staleAfter).toBe("2026-07-21T12:00:00.000Z");
    expect(service.query({ entityId: tracked.entity.id, overdue: true }).entities).toHaveLength(1);
    expect(service.query({ type: "lifecycle-fixture", progressOlderThanDays: 1 }).entities.map((entity) => entity.id)).toEqual([
      target.entity.id,
    ]);
    expect(service.query({ type: "lifecycle-fixture", progressNewerThanDays: 1 }).entities.map((entity) => entity.id)).toEqual([
      tracked.entity.id,
    ]);
    expect(() => service.query({ progressOlderThanDays: -1 })).toThrow(/must be a finite number/u);

    const completed = service.mutate({
      entityId: tracked.entity.id,
      status: "done",
    }, { ...context, turnId: "turn-complete" });
    expect(completed.entity).toMatchObject({ status: "done", closedAt: "2026-07-19T12:00:00.000Z", overdue: false });
    expect(service.query({ entityId: tracked.entity.id, overdue: true }).entities).toHaveLength(0);
    const revertedCompletion = service.revertEvent(completed.event!.id, { ...context, turnId: "turn-revert-complete" });
    expect(revertedCompletion.entity).toMatchObject({ status: "open", closedAt: null, overdue: true });

    const removedLinks = service.mutate({
      entityId: tracked.entity.id,
      relations: [{ kind: "blocks", targetEntityId: target.entity.id, remove: true }],
      references: [{ role: "log", ref: "profile:fixtures/run.log", remove: true }],
    }, { ...context, turnId: "turn-remove-links" });
    expect(service.listRelations(tracked.entity.id)).toEqual([]);
    expect(service.listReferences(tracked.entity.id)).toEqual([]);
    service.revertEvent(removedLinks.event!.id, { ...context, turnId: "turn-restore-links" });
    expect(service.listRelations(tracked.entity.id)).toMatchObject([{ kind: "blocks", targetEntityId: target.entity.id }]);
    expect(service.listReferences(tracked.entity.id)).toMatchObject([{ role: "log", ref: "profile:fixtures/run.log" }]);
    expect(Number((storage.getDatabase().prepare("SELECT COUNT(*) AS count FROM state_entity_relations").get() as { count: number }).count)).toBe(2);
    expect(Number((storage.getDatabase().prepare("SELECT COUNT(*) AS count FROM state_entity_references").get() as { count: number }).count)).toBe(2);
    const initiallyClosed = service.mutate({
      typeId: "lifecycle-fixture",
      title: "Initially Closed Fixture",
      status: "done",
      attributes: { revision: 1 },
    }, { ...context, turnId: "turn-initially-closed" });
    expect(initiallyClosed.event?.patch).toMatchObject({
      status: { from: null, to: "done" },
      closedAt: { from: null, to: "2026-07-19T12:00:00.000Z" },
      lastProgressAt: { from: null, to: "2026-07-19T12:00:00.000Z" },
    });
    storage.close();
  });

  it("sweeps stale lifecycle policies, issues, cursors, and memory links", () => {
    const { storage, service, context, db } = harness();
    const stale = service.mutate({ typeId: "project", title: "Stale Fixture", status: "active", attributes: {} }, {
      ...context,
      occurredAt: "2026-06-01T00:00:00Z",
    });
    const trip = service.mutate({
      typeId: "travel",
      title: "Completed Trip Fixture",
      status: "completed",
      attributes: { start_date: "2026-07-10", end_date: "2026-07-15" },
    }, { ...context, turnId: "turn-trip", occurredAt: "2026-07-15T12:00:00Z" });
    service.defineType({
      id: "expiring-fixture",
      displayName: "Expiring Fixture",
      attributesSchema: { type: "object", additionalProperties: false, properties: {} },
      statuses: {
        values: ["active", "expired"],
        transitions: { active: ["expired"], expired: ["active"] },
        initial: "active",
      },
      stalenessPolicy: { expected_update_days: 1, on_stale: "expire" },
      origin: "seed",
      confirm: true,
    }, { includePrivate: true });
    const expiring = service.mutate({
      typeId: "expiring-fixture",
      title: "Expiring Entity Fixture",
      status: "active",
      attributes: {},
    }, { ...context, turnId: "turn-expiring", occurredAt: "2026-07-01T00:00:00Z" });
    const report = service.sweep();
    expect(report).toMatchObject({ stale: 3, expired: 1, archived: 1 });
    expect(service.listIssues("open").some((issue) => issue.entityId === stale.entity.id && issue.kind === "stale")).toBe(true);
    expect(service.listIssues("open").some((issue) => issue.kind === "reconciler_stalled")).toBe(true);
    expect(service.getEntity(expiring.entity.id, {}, true)?.status).toBe("expired");
    expect(service.listEvents(expiring.entity.id)[0]).toMatchObject({ kind: "status_change", actor: "sweep" });
    expect(service.getEntity(trip.entity.id, {}, true)?.archivedAt).toBeTruthy();
    expect(service.listEvents(trip.entity.id)[0]).toMatchObject({ kind: "archive", actor: "sweep" });
    service.setAdapterCursor("fixture-adapter", "cursor-1", { count: 1 });
    expect(service.getAdapterCursor("fixture-adapter")).toEqual({ cursor: "cursor-1", metadata: { count: 1 } });
    service.linkMemoryVerdict({ eventId: stale.event!.id, memoryId: "fixture-memory", entityId: stale.entity.id, verdict: "current_truth", archived: true });
    expect(service.getArchivedMemoryIdsForEvents([stale.event!.id])).toEqual(["fixture-memory"]);
    service.markMemoriesUnarchived(["fixture-memory"]);
    expect((db.prepare("SELECT unarchived_at AS value FROM state_memory_links WHERE memory_id='fixture-memory'").get() as { value: string }).value).toBeTruthy();
    storage.close();
  });
});
