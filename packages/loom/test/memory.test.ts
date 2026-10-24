import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { atlasPath, atlasReader } from "../src/memory.js";
import { homedir } from "node:os";
import { LoomHost } from "../src/host.js";
import { LoomStore } from "../src/store.js";
import { FakeRuntime } from "./fake-runtime.js";

describe("Tango memory in a thread's carried state", () => {
  it("reads the loom agent's memories for the thread and its lead, by importance, without handoffs or archived ones", () => {
    const path = join(mkdtempSync(join(tmpdir(), "loom-atlas-")), "memory.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE memories (id TEXT, content TEXT, source TEXT, agent_id TEXT, importance REAL, tags TEXT, created_at TEXT, archived_at TEXT, metadata TEXT)");
    const add = db.prepare("INSERT INTO memories VALUES (?, ?, 'conversation', ?, ?, ?, ?, ?, ?)");
    add.run("1", "low", "loom", 0.5, "[]", "2026-10-01", null, JSON.stringify({ thread_id: "t" }));
    add.run("2", "high", "loom", 0.9, "[]", "2026-10-02", null, JSON.stringify({ thread_id: "t" }));
    add.run("3", "lead fact", "loom", 0.7, "[]", "2026-10-03", null, JSON.stringify({ thread_id: "lead" }));
    add.run("4", "archived", "loom", 1, "[]", "2026-10-04", "2026-10-05", JSON.stringify({ thread_id: "t" }));
    add.run("5", "a handoff", "loom", 1, '["loom","handoff"]', "2026-10-04", null, JSON.stringify({ thread_id: "t" }));
    add.run("6", "watson's", "watson", 1, "[]", "2026-10-04", null, JSON.stringify({ thread_id: "t" }));
    add.run("7", "other thread", "loom", 1, "[]", "2026-10-04", null, JSON.stringify({ thread_id: "x" }));
    db.close();
    expect(atlasReader(path)(["t", "lead"], 10)).toEqual(["high", "lead fact", "low"]);
    expect(atlasReader(path)(["t"], 1)).toEqual(["high"]);
    expect(atlasReader(join(tmpdir(), "missing-atlas.db"))(["t"], 5)).toEqual([]);
  });

  it("resolves the Atlas path as Atlas does", () => {
    expect(atlasPath({ ATLAS_MEMORY_DB: "  ~/.tango/atlas/memory.db " })).toBe(join(homedir(), ".tango/atlas/memory.db"));
    expect(atlasPath({ ATLAS_MEMORY_DB: "/abs/memory.db" })).toBe("/abs/memory.db");
    expect(atlasPath({})).toBe(join(homedir(), ".tango", "atlas", "memory.db"));
  });

  it("gives a worker its lead's latest handoff and the memories, inside the block", async () => {
    const store = new LoomStore(":memory:");
    const runtime = new FakeRuntime();
    const seen: string[][] = [];
    const host = new LoomHost(store, { fake: runtime }, { memories: (ids) => { seen.push(ids); return ["The staging build listens on port 4100"]; } });
    const lead = await host.execute({ type: "submit", commandId: "l", text: "lead", cwd: "/repo", provider: "fake" });
    runtime.last.complete();
    host.saveHandoff(lead.threadId!, { summary: "Phases 1-3 built; memory next" });
    const worker = await host.execute({ type: "submit", commandId: "w", text: "work", cwd: "/repo", provider: "fake", role: "worker", parentThreadId: `loom:${lead.threadId}` } as never);
    const text = host.carry(worker.threadId!)!;
    expect(seen.at(-1)).toEqual([worker.threadId, lead.threadId]);
    expect(text).toContain("Your lead's latest handoff");
    expect(text).toContain("Phases 1-3 built; memory next");
    expect(text).toContain("The staging build listens on port 4100");
  });
});
