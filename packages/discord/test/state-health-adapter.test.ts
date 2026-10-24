import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateService, TangoStorage } from "@tango/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeBodyFatPercent,
  normalizeWeightLb,
  StateHealthAutoExportAdapter,
  type HealthAutoExportDataSource,
} from "../src/state-health-adapter.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("StateHealthAutoExportAdapter", () => {
  it("imports ordered observations, converts units, advances a cursor, and is idempotent", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-state-health-"));
    dirs.push(dir);
    const storage = new TangoStorage(path.join(dir, "tango.sqlite"));
    const service = new StateService(storage.getDatabase());
    const listAfter = vi.fn(async (collection: string, cursor: string | null) => {
      if (cursor) return [];
      return collection === "weight_body_mass"
        ? [{ date: "2026-07-16T08:00:00Z", qty: 80, units: "kg" }]
        : [{ date: "2026-07-16T08:01:00Z", qty: 0.2, units: "fraction" }];
    });
    const source = { listAfter } as HealthAutoExportDataSource;
    const adapter = new StateHealthAutoExportAdapter(service, source);
    const first = await adapter.sync();
    expect(first).toMatchObject({ status: "ok", scanned: 2, applied: 2, cursor: "2026-07-16T08:01:00.000Z" });
    const entity = service.query({ type: "body-composition", includePrivate: true }).entities[0]!;
    expect(entity.attributes).toEqual({ weight_lb: normalizeWeightLb(80, "kg"), body_fat_pct: 20 });
    expect(service.listEvents(entity.id).map((event) => event.actor)).toEqual(["sync:health-auto-export", "sync:health-auto-export"]);
    expect((await adapter.sync()).scanned).toBe(0);
    expect(service.listEvents(entity.id)).toHaveLength(2);
    expect(listAfter).toHaveBeenLastCalledWith("body_fat_percentage", "2026-07-16T08:01:00.000Z");
    storage.close();
  });

  it("normalizes supported measurements and degrades without mutating on source failure", async () => {
    expect(normalizeWeightLb(1, "kg")).toBeCloseTo(2.205, 3);
    expect(normalizeBodyFatPercent(0.25, "fraction")).toBe(25);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-state-health-offline-"));
    dirs.push(dir);
    const storage = new TangoStorage(path.join(dir, "tango.sqlite"));
    const service = new StateService(storage.getDatabase());
    const adapter = new StateHealthAutoExportAdapter(service, {
      listAfter: async () => { throw new Error("fixture unavailable"); },
    });
    expect(await adapter.sync()).toMatchObject({ status: "unavailable", applied: 0, error: "fixture unavailable" });
    expect(service.query({ type: "body-composition", includePrivate: true }).entities).toHaveLength(0);
    storage.close();
  });
});
