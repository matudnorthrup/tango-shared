import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MemoryRecord } from "@tango/atlas-memory";
import { StateService, TangoStorage } from "@tango/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runStateMemorySupersession } from "../src/state-memory-supersession.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function memory(id: string, content: string): MemoryRecord {
  return { id, content, source: "conversation", agentId: "watson", importance: 0.7, tags: [], embedding: null, embeddingModel: null, createdAt: "2026-07-01T00:00:00Z", lastAccessedAt: "2026-07-01T00:00:00Z", accessCount: 0, archivedAt: null, metadata: null };
}

describe("state memory supersession sweep", () => {
  it("archives only current-truth assertions, tags all verdicts, and records reversible links", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-state-supersession-"));
    dirs.push(dir);
    const storage = new TangoStorage(path.join(dir, "tango.sqlite"));
    const service = new StateService(storage.getDatabase());
    const created = service.mutate({ typeId: "project", title: "Supersession Fixture", status: "active", attributes: { progress_pct: 50 } }, { actor: "test", source: "test" });
    const memories = [memory("current", "Supersession Fixture is at an older current value."), memory("context", "We discussed why the fixture matters."), memory("unclear", "Fixture note.")];
    const memoryAdmin = vi.fn().mockResolvedValue({ updated: 1 });
    const atlas = { memorySearch: vi.fn(async (input: { tags?: string[] }) => input.tags ? [] : memories), memoryAdmin };
    const provider = { generate: vi.fn(async () => ({ text: JSON.stringify({ verdicts: [
      { memory_id: "current", verdict: "current_truth" },
      { memory_id: "context", verdict: "state_adjacent" },
      { memory_id: "unclear", verdict: "unsure" },
    ] }), durationMs: 1 })) };
    const report = await runStateMemorySupersession({ service, atlas, provider, model: "fixture" });
    expect(report).toEqual({ candidates: 3, archived: 1, tagged: 3, unsure: 1, rejected: 0 });
    expect(memoryAdmin).toHaveBeenCalledWith(expect.objectContaining({ operation: "archive", filter: expect.objectContaining({ ids: ["current"], metadata_patch: { superseded_by: created.event!.id, state_entity_id: created.entity.id } }) }));
    expect(service.getArchivedMemoryIdsForEvents([created.event!.id])).toEqual(["current"]);
    expect((await runStateMemorySupersession({ service, atlas, provider, model: "fixture" })).candidates).toBe(0);
    storage.close();
  });
});
