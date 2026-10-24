import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateService, TangoStorage, type StateTypePackConfig } from "@tango/core";
import { afterEach, describe, expect, it } from "vitest";
import { installStateTypePacks } from "../src/state-type-packs.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-state-type-packs-"));
  dirs.push(dir);
  const storage = new TangoStorage(path.join(dir, "tango.sqlite"));
  return {
    storage,
    service: new StateService(storage.getDatabase()),
  };
}

function syntheticType(id: string) {
  return {
    id,
    displayName: `Synthetic ${id}`,
    description: "A sanitized schema-only fixture.",
    attributesSchema: {
      type: "object",
      additionalProperties: false,
      properties: { detail: { type: "string" } },
    },
    statuses: {
      values: ["open", "complete"],
      transitions: { open: ["complete"], complete: ["open"] },
      initial: "open",
      terminal: ["complete"],
    },
    stalenessPolicy: { expected_update_days: 7, on_stale: "nudge" },
    digestTemplate: "{title} — {status}",
    bodyFields: ["status", "detail"],
    visibility: "shared",
  } as const;
}

describe("installStateTypePacks", () => {
  it("installs enabled packs idempotently without creating entity values", () => {
    const { storage, service } = harness();
    const packs: StateTypePackConfig[] = [{
      id: "generic-pack",
      enabled: true,
      types: [syntheticType("synthetic-alpha"), syntheticType("synthetic-beta")],
    }];

    const first = installStateTypePacks({ service, db: storage.getDatabase(), packs });
    expect(first).toMatchObject({ installed: 1, failed: 0, typesCreated: 2, typesUpdated: 0 });
    expect(service.getType("synthetic-alpha", { includePrivate: true })).toMatchObject({
      origin: "type-pack:generic-pack",
      statuses: { terminal: ["complete"] },
    });
    expect(service.query({ type: "synthetic-alpha", includePrivate: true }).entities).toHaveLength(0);

    const second = installStateTypePacks({ service, db: storage.getDatabase(), packs });
    expect(second).toMatchObject({ installed: 1, failed: 0, typesCreated: 0, typesUpdated: 2 });
    expect(service.listTypes({ includePrivate: true }).filter((type) => type.id.startsWith("synthetic-"))).toHaveLength(2);
    storage.close();
  });

  it("rolls back an incompatible pack atomically and continues with another pack", () => {
    const { storage, service } = harness();
    service.defineType({
      id: "compat-fixture",
      displayName: "Compatibility Fixture",
      origin: "seed",
      attributesSchema: {
        type: "object",
        additionalProperties: false,
        properties: { value: { type: "string" } },
      },
    }, { includePrivate: true });

    const packs: StateTypePackConfig[] = [
      {
        id: "incompatible-pack",
        enabled: true,
        types: [
          syntheticType("must-roll-back"),
          {
            id: "compat-fixture",
            displayName: "Compatibility Fixture",
            attributesSchema: {
              type: "object",
              additionalProperties: false,
              properties: { value: { type: "number" } },
            },
          },
        ],
      },
      {
        id: "following-pack",
        enabled: true,
        types: [syntheticType("still-installs")],
      },
      {
        id: "disabled-pack",
        enabled: false,
        types: [syntheticType("never-installs")],
      },
    ];

    const report = installStateTypePacks({ service, db: storage.getDatabase(), packs });
    expect(report).toMatchObject({
      installed: 1,
      skipped: 1,
      failed: 1,
      typesCreated: 1,
      typesUpdated: 0,
    });
    expect(report.packs[0]).toMatchObject({ packId: "incompatible-pack", status: "failed", created: 0, updated: 0 });
    expect(report.packs[0]?.error).toMatch(/additive|type|schema/iu);
    expect(service.getType("must-roll-back", { includePrivate: true })).toBeNull();
    expect(service.getType("compat-fixture", { includePrivate: true })?.attributesSchema).toMatchObject({
      properties: { value: { type: "string" } },
    });
    expect(service.getType("still-installs", { includePrivate: true })).not.toBeNull();
    expect(service.getType("never-installs", { includePrivate: true })).toBeNull();
    storage.close();
  });
});
