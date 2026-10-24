import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateService, TangoStorage } from "@tango/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateLifecycleRunner } from "../src/state-lifecycle.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("StateLifecycleRunner", () => {
  it("orders deterministic maintenance and records successful scheduled check-ins", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-state-lifecycle-"));
    dirs.push(dir);
    const storage = new TangoStorage(path.join(dir, "tango.sqlite"));
    const service = new StateService(storage.getDatabase(), { now: () => new Date("2026-07-17T12:00:00Z") });
    service.defineType({
      id: "check-in-fixture",
      displayName: "Check-in Fixture",
      attributesSchema: { type: "object", additionalProperties: false, properties: {} },
      stalenessPolicy: { check_in_days: 1, check_in_agent: "watson", check_in_prompt: "Ask the fixture question." },
      origin: "seed",
      confirm: true,
    }, { includePrivate: true });
    const created = service.mutate({ typeId: "check-in-fixture", title: "Scheduled Fixture", attributes: {} }, {
      actor: "test",
      source: "test",
      occurredAt: "2026-07-01T00:00:00Z",
      includePrivate: true,
    });
    const promptCheckIn = vi.fn().mockResolvedValue(undefined);
    const projectionReport = { views: 1, roots: 1, written: 1, unchanged: 0, removed: 0, errors: [], files: [] };
    const projections = { run: vi.fn().mockReturnValue(projectionReport) };
    const runner = new StateLifecycleRunner({
      service,
      obsidian: { scan: vi.fn().mockResolvedValue({ linked: 0, mirrored: 0, ingested: 0, unchanged: 0, invalid: 0, unavailable: 0 }) },
      health: { sync: vi.fn().mockResolvedValue({ status: "ok", scanned: 0, applied: 0, skipped: 0, cursor: null }) },
      runSupersession: vi.fn().mockResolvedValue({ candidates: 0, archived: 0, tagged: 0, unsure: 0, rejected: 0 }),
      projections,
      promptCheckIn,
    });
    const report = await runner.run();
    expect(report.checkIns).toEqual({ due: 1, prompted: 1, failed: 0 });
    expect(promptCheckIn).toHaveBeenCalledWith(expect.objectContaining({ entityId: created.entity.id, agentId: "watson", prompt: "Ask the fixture question." }));
    expect(projections.run).toHaveBeenCalledOnce();
    expect(report.projections).toEqual(projectionReport);
    expect(service.listEvents(created.entity.id)[0]).toMatchObject({ kind: "check_in", actor: "schedule:state-sweep" });
    storage.close();
  });
});
