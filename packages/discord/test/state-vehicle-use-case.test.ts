import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  StateService,
  TangoStorage,
  type StateTypePackConfig,
  type StateViewConfig,
} from "@tango/core";
import { afterEach, describe, expect, it } from "vitest";
import { StateProjectionRunner } from "../src/state-projection.js";
import { installStateTypePacks } from "../src/state-type-packs.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createHarness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tango-vehicle-use-case-"));
  temporaryDirectories.push(directory);
  const storage = new TangoStorage(path.join(directory, "tango.sqlite"));
  const now = new Date("2026-07-18T12:00:00.000Z");
  return {
    directory,
    storage,
    service: new StateService(storage.getDatabase(), { now: () => now }),
  };
}

const vehicleLifecyclePack: StateTypePackConfig = {
  id: "synthetic-asset-lifecycle",
  enabled: true,
  types: [
    {
      // Profile packs can add optional domain fields to a seeded type without
      // putting any actual vehicle value in tracked configuration.
      id: "vehicle",
      displayName: "Vehicle",
      description: "One independently tracked vehicle per entity.",
      attributesSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          year: { type: "integer", minimum: 1886 },
          make: { type: "string" },
          model: { type: "string" },
          kind: { type: "string" },
          primary_use: { type: "string" },
          operational_status: { type: "string" },
          vin: { type: "string", pattern: "^[A-HJ-NPR-Z0-9]{17}$" },
        },
      },
      bodyFields: ["status", "year", "make", "model", "kind", "primary_use", "operational_status", "vin"],
    },
    {
      id: "maintenance-item",
      displayName: "Maintenance Item",
      description: "A recurring maintenance obligation for any related asset.",
      attributesSchema: {
        type: "object",
        additionalProperties: false,
        required: ["service_kind", "last_completed_at"],
        properties: {
          service_kind: {
            type: "string",
            enum: ["oil_change", "tire_rotation", "inspection", "repair", "other"],
          },
          last_completed_at: { type: "string", format: "date" },
          last_completed_odometer: { type: "integer", minimum: 0 },
          interval_miles: { type: "integer", minimum: 1 },
          next_due_odometer: { type: "integer", minimum: 0 },
          details: { type: "string" },
        },
      },
      statuses: {
        values: ["current", "due", "paused"],
        transitions: {
          current: ["due", "paused"],
          due: ["current", "paused"],
          paused: ["current", "due"],
        },
        initial: "current",
      },
      stalenessPolicy: { expected_update_days: 180, on_stale: "nudge" },
      digestTemplate: "{title} — {status}; last {last_completed_at}; next {next_due_odometer}",
      bodyFields: [
        "status",
        "service_kind",
        "last_completed_at",
        "last_completed_odometer",
        "interval_miles",
        "next_due_odometer",
        "details",
      ],
      visibility: "shared",
    },
    {
      id: "asset-modification",
      displayName: "Asset Modification",
      description: "An upgrade or modification installed on a related asset.",
      attributesSchema: {
        type: "object",
        additionalProperties: false,
        required: ["category", "installed_on"],
        properties: {
          category: {
            type: "string",
            enum: ["exterior", "interior", "performance", "utility", "safety", "other"],
          },
          manufacturer: { type: "string" },
          model: { type: "string" },
          installed_on: { type: "string", format: "date" },
          removed_on: { type: "string", format: "date" },
          details: { type: "string" },
        },
      },
      statuses: {
        values: ["planned", "installed", "removed"],
        transitions: {
          planned: ["installed", "removed"],
          installed: ["removed"],
          removed: ["installed"],
        },
        initial: "planned",
        terminal: ["removed"],
      },
      digestTemplate: "{title} — {status}; installed {installed_on}",
      bodyFields: ["status", "category", "manufacturer", "model", "installed_on", "removed_on", "details"],
      visibility: "shared",
    },
  ],
};

const vehicleView: StateViewConfig = {
  id: "synthetic-vehicle-overview",
  enabled: true,
  forEach: { types: ["vehicle"], statuses: ["active"] },
  outputPath: "Vehicle Views/{root.slug}.md",
  titleTemplate: "{root.title} Overview",
  sections: [
    {
      heading: "Vehicle",
      source: "state",
      selector: { where: { id: "$root.id" } },
      itemTemplate: "{entity.attributes.year} {entity.attributes.make} {entity.attributes.model} · VIN {entity.attributes.vin} · {entity.status}",
    },
    {
      heading: "Maintenance",
      source: "state",
      selector: {
        types: ["maintenance-item"],
        relation: { kind: "for_asset", targetEntityId: "$root.id" },
      },
      sort: [{ field: "due_at", direction: "asc" }],
      itemTemplate: "- {entity.title}: {entity.status}; last {entity.attributes.last_completed_at}; due {entity.due_at}; overdue={entity.overdue}; evidence={entity.references}",
      emptyText: "_No maintenance items._",
    },
    {
      heading: "Upgrades",
      source: "state",
      selector: {
        types: ["asset-modification"],
        relation: { kind: "installed_on", targetEntityId: "$root.id" },
      },
      sort: [{ field: "attributes.installed_on", direction: "desc" }],
      itemTemplate: "- {entity.title}: {entity.status}; installed {entity.attributes.installed_on}; evidence={entity.references}",
      emptyText: "_No upgrades._",
    },
    {
      heading: "Narrative",
      source: "atlas",
      selector: { where: { "metadata.state_entity_id": "$root.id" } },
      sort: [{ field: "created_at", direction: "desc" }],
      itemTemplate: "- {memory.created_at} — {memory.content}",
      emptyText: "_No related narrative._",
    },
  ],
};

describe("synthetic vehicle lifecycle use case", () => {
  it("tracks identity, recurring maintenance, upgrades, evidence, projection, idempotence, and undo", () => {
    const { directory, storage, service } = createHarness();
    const packReport = installStateTypePacks({
      service,
      db: storage.getDatabase(),
      packs: [vehicleLifecyclePack],
    });
    expect(packReport).toMatchObject({ installed: 1, failed: 0, typesCreated: 2, typesUpdated: 1 });
    expect(service.getType("vehicle", { includePrivate: true })?.attributesSchema).toMatchObject({
      properties: { vin: { type: "string" } },
    });

    const context = {
      actor: "fixture",
      source: "tool",
      agentId: "fixture-agent",
      agentType: "personal",
      sessionId: "fixture-session",
    } as const;
    const vehicle = service.mutate({
      typeId: "vehicle",
      title: "Fixture Ridge Truck",
      status: "active",
      attributes: {
        year: 2022,
        make: "Example",
        model: "Ridge",
        kind: "truck",
        primary_use: "synthetic validation",
        operational_status: "operational",
        vin: "TESTV1N0000000000",
      },
      summary: "Synthetic truck used only for state-system validation.",
      bodyPointer: "obsidian:Fixtures/Vehicles/Fixture Ridge Truck.md",
      ownerUserId: "fixture-user",
      ownerAgentId: "fixture-agent",
    }, { ...context, turnId: "fixture-vehicle", occurredAt: "2026-07-18T09:00:00Z" });

    const oilChange = service.mutate({
      typeId: "maintenance-item",
      title: "Engine Oil Change",
      status: "current",
      attributes: {
        service_kind: "oil_change",
        last_completed_at: "2026-06-15",
        last_completed_odometer: 24_000,
        interval_miles: 5_000,
        next_due_odometer: 29_000,
        details: "Synthetic full-service oil change.",
      },
      dueAt: "2026-12-15T09:00:00Z",
      ownerUserId: "fixture-user",
      ownerAgentId: "fixture-agent",
      relations: [{ kind: "for_asset", targetEntityId: vehicle.entity.id }],
      references: [{
        role: "service_log",
        ref: "obsidian:Fixtures/Vehicles/Logs/2026-06-oil-change.md",
        label: "Synthetic service log",
      }],
    }, { ...context, turnId: "fixture-oil", occurredAt: "2026-06-15T09:00:00Z" });

    const tireRotationInput = {
      typeId: "maintenance-item",
      title: "Tire Rotation",
      status: "due",
      attributes: {
        service_kind: "tire_rotation",
        last_completed_at: "2025-12-01",
        last_completed_odometer: 18_000,
        interval_miles: 6_000,
        next_due_odometer: 24_000,
        details: "Synthetic recurring tire service.",
      },
      dueAt: "2026-07-01T09:00:00Z",
      ownerUserId: "fixture-user",
      ownerAgentId: "fixture-agent",
      relations: [{ kind: "for_asset", targetEntityId: vehicle.entity.id }],
      references: [{
        role: "service_log",
        ref: "obsidian:Fixtures/Vehicles/Logs/2025-12-tire-rotation.md",
        label: "Synthetic service log",
      }],
    } as const;
    const tireRotation = service.mutate(tireRotationInput, {
      ...context,
      turnId: "fixture-tires",
      occurredAt: "2025-12-01T09:00:00Z",
    });

    const upgrade = service.mutate({
      typeId: "asset-modification",
      title: "Fixture Tonneau Cover",
      status: "installed",
      attributes: {
        category: "utility",
        manufacturer: "Example Parts",
        model: "Cover X",
        installed_on: "2026-03-20",
        details: "Synthetic hard-folding bed cover.",
      },
      relations: [{ kind: "installed_on", targetEntityId: vehicle.entity.id }],
      references: [{
        role: "receipt",
        ref: "obsidian:Fixtures/Vehicles/Receipts/tonneau-cover.md",
        label: "Synthetic upgrade receipt",
      }],
    }, { ...context, turnId: "fixture-upgrade", occurredAt: "2026-03-20T09:00:00Z" });

    const due = service.query({
      type: "maintenance-item",
      projectEntityId: undefined,
      ownerUserId: "fixture-user",
      ownerAgentId: "fixture-agent",
      source: "tool",
      overdue: true,
      relationKind: "for_asset",
      relatedEntityId: vehicle.entity.id,
      referenceRole: "service_log",
      includeRelations: true,
      includeReferences: true,
    });
    expect(due.entities).toHaveLength(1);
    expect(due.entities[0]).toMatchObject({ id: tireRotation.entity.id, overdue: true, status: "due" });
    expect(due.entities[0]?.relations).toHaveLength(1);
    expect(due.entities[0]?.references).toHaveLength(1);

    const upgrades = service.query({
      type: "asset-modification",
      relationKind: "installed_on",
      relatedEntityId: vehicle.entity.id,
      referenceRole: "receipt",
      includeRelations: true,
      includeReferences: true,
    });
    expect(upgrades.entities).toHaveLength(1);
    expect(upgrades.entities[0]).toMatchObject({ id: upgrade.entity.id, status: "installed" });

    const eventsBeforeReplay = Number((storage.getDatabase().prepare(
      "SELECT COUNT(*) AS count FROM state_events",
    ).get() as { count: number }).count);
    const replay = service.mutate(tireRotationInput, {
      ...context,
      turnId: "fixture-tires-replay",
      occurredAt: "2025-12-01T09:00:00Z",
    });
    const eventsAfterReplay = Number((storage.getDatabase().prepare(
      "SELECT COUNT(*) AS count FROM state_events",
    ).get() as { count: number }).count);
    expect(replay).toMatchObject({ applied: false, reason: "no_change" });
    expect(eventsAfterReplay).toBe(eventsBeforeReplay);

    const oilUpdate = service.mutate({
      entityId: oilChange.entity.id,
      status: "current",
      attributes: {
        last_completed_at: "2026-07-18",
        last_completed_odometer: 28_500,
        next_due_odometer: 33_500,
      },
      dueAt: "2027-01-18T09:00:00Z",
      references: [{
        role: "service_log",
        ref: "obsidian:Fixtures/Vehicles/Logs/2026-07-oil-change.md",
        label: "Synthetic follow-up service log",
      }],
      markProgress: true,
    }, { ...context, turnId: "fixture-oil-update", occurredAt: "2026-07-18T10:00:00Z" });
    expect(oilUpdate.applied).toBe(true);
    expect(oilUpdate.entity.attributes).toMatchObject({
      last_completed_at: "2026-07-18",
      last_completed_odometer: 28_500,
      next_due_odometer: 33_500,
    });
    const oilHistory = service.query({ entityId: oilChange.entity.id, recentEvents: 10 }).entities[0]?.events ?? [];
    expect(oilHistory).toHaveLength(2);

    const reverted = service.revertEvent(oilUpdate.event!.id, {
      ...context,
      turnId: "fixture-oil-undo",
      occurredAt: "2026-07-18T10:05:00Z",
    });
    expect(reverted.applied).toBe(true);
    expect(reverted.event?.revertsEventId).toBe(oilUpdate.event!.id);
    expect(reverted.entity.attributes).toMatchObject({
      last_completed_at: "2026-06-15",
      last_completed_odometer: 24_000,
      next_due_odometer: 29_000,
    });
    const revertedOil = service.query({
      entityId: oilChange.entity.id,
      includeReferences: true,
      recentEvents: 10,
    }).entities[0]!;
    expect(revertedOil.references?.find((reference) => reference.ref.includes("2026-07"))).toBeUndefined();
    expect(revertedOil.events).toHaveLength(3);

    const outputRoot = path.join(directory, "notes");
    const projection = new StateProjectionRunner({
      service,
      views: [vehicleView],
      outputRoot,
      now: () => new Date("2026-07-18T12:00:00Z"),
      atlasRecords: () => [
        {
          id: "fixture-narrative",
          content: "Synthetic narrative: the fixture truck is being used to validate vehicle lifecycle tracking.",
          source: "manual",
          agentId: null,
          importance: 0.5,
          createdAt: "2026-07-18T11:00:00Z",
          metadata: { state_entity_id: vehicle.entity.id },
        },
        {
          id: "unrelated-narrative",
          content: "This unrelated narrative must not appear in the vehicle view.",
          source: "manual",
          agentId: null,
          importance: 0.5,
          createdAt: "2026-07-18T11:30:00Z",
          metadata: { state_entity_id: "vehicle:other-fixture" },
        },
      ],
    });
    const firstProjection = projection.run();
    expect(firstProjection).toMatchObject({ written: 1, unchanged: 0, removed: 0, errors: [] });
    const filePath = firstProjection.files[0]!.filePath;
    const firstMtime = fs.statSync(filePath).mtimeMs;
    const markdown = fs.readFileSync(filePath, "utf8");
    expect(markdown).toContain("read_only_projection: true");
    expect(markdown).toContain("2022 Example Ridge");
    expect(markdown).toContain("TESTV1N0000000000");
    expect(markdown).toContain("Engine Oil Change");
    expect(markdown).toContain("Tire Rotation");
    expect(markdown).toContain("overdue=true");
    expect(markdown).toContain("Fixture Tonneau Cover");
    expect(markdown).toContain("service_log");
    expect(markdown).toContain("receipt");
    expect(markdown).toContain("Synthetic narrative: the fixture truck");
    expect(markdown).not.toContain("This unrelated narrative");

    const secondProjection = projection.run();
    expect(secondProjection).toMatchObject({ written: 0, unchanged: 1, removed: 0, errors: [] });
    expect(fs.statSync(filePath).mtimeMs).toBe(firstMtime);

    service.mutate({ entityId: vehicle.entity.id, status: "sold" }, {
      ...context,
      turnId: "fixture-vehicle-sold",
      occurredAt: "2026-07-18T12:30:00Z",
    });
    const pruned = projection.run();
    expect(pruned).toMatchObject({ written: 0, unchanged: 0, removed: 1, errors: [] });
    expect(fs.existsSync(filePath)).toBe(false);
    expect(service.getEntity(vehicle.entity.id)?.closedAt).not.toBeNull();

    storage.close();
  });
});
