import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { capText, LoomStore } from "../src/store.js";

describe("LoomStore", () => {
  it("backfills owned worktrees once, excluding probes and adjacent paths", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-mode-"));
    const db = join(root, "loom.sqlite");
    try {
      let store = new LoomStore(db);
      for (const [id, cwd, kind] of [
        ["owned", join(root, "worktrees", "repo", "loom-owned"), "coding"],
        ["local", join(root, "repo"), "coding"],
        ["adjacent", join(root, "worktrees-other", "repo"), "coding"],
        ["probe", join(root, "worktrees", "repo", "loom-owned"), "probe"],
      ]) store.tx(() => store.createThread({ id, cwd, kind, provider: "fake" }));
      store.close();
      const old = new DatabaseSync(db);
      old.exec("ALTER TABLE threads DROP COLUMN worktree_mode"); old.close();
      store = new LoomStore(db);
      expect(store.thread("owned")!.worktree_mode).toBe("worktree");
      for (const id of ["local", "adjacent", "probe"]) expect(store.thread(id)!.worktree_mode).toBe("local");
      store.tx(() => store.updateThread("owned", { worktree_mode: "auto" })); store.close();
      store = new LoomStore(db);
      expect(store.thread("owned")!.worktree_mode).toBe("auto"); store.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("caps tool output to a head and tail", () => {
    const big = "a".repeat(10_000) + "MIDDLE" + "z".repeat(10_000);
    const c = capText(big, 100, 50);
    expect(c.head).toBe("a".repeat(100));
    expect(c.tail).toBe("z".repeat(50));
    expect(c.bytes).toBe(20_006);
    expect(capText("small", 100, 50)).toEqual({ head: "small", tail: null, bytes: 5 });
  });

  it("stores capped items and updates them in place", () => {
    const s = new LoomStore(":memory:");
    s.tx(() => s.createThread({ id: "t1", kind: "coding", cwd: "/tmp", provider: "fake" }));
    s.tx(() => s.upsertItem({ id: "i1", threadId: "t1", runId: null, kind: "tool", name: "Bash", input: "rg x", status: "running" }));
    s.tx(() => s.upsertItem({ id: "i1", threadId: "t1", runId: null, kind: "tool", name: "Bash", output: "x".repeat(40_000), status: "completed" }));
    const [item] = s.items("t1");
    expect(item!.status).toBe("completed");
    expect(item!.input).toBe("rg x");
    expect(item!.output_bytes).toBe(40_000);
    expect(item!.output_head!.length + item!.output_tail!.length).toBe(16 * 1024);
  });

  it("publishes change rows only after commit, in order, and drops them on rollback", () => {
    const s = new LoomStore(":memory:");
    const seen: number[] = [];
    s.onCommit = (changes) => seen.push(...changes.map((c) => c.seq));
    s.tx(() => {
      s.createThread({ id: "t1", kind: "coding", cwd: "/tmp", provider: "fake" });
      s.createRun("t1", "user", "hi");
      expect(seen).toEqual([]);
    });
    expect(seen).toEqual([1, 2]);
    expect(() =>
      s.tx(() => {
        s.createRun("t1", "user", "boom");
        throw new Error("fail");
      }),
    ).toThrow("fail");
    expect(seen).toEqual([1, 2]);
    expect(s.runs("t1")).toHaveLength(1);
  });

  it("hard-deletes a thread with everything under it", () => {
    const s = new LoomStore(":memory:");
    s.tx(() => {
      s.createThread({ id: "t1", kind: "coding", cwd: "/tmp", provider: "fake" });
      const r = s.createRun("t1", "user", "hi");
      s.addMessage("t1", r.id, "user", "hi");
    });
    s.tx(() => s.deleteThread("t1"));
    expect(s.thread("t1")).toBeUndefined();
    expect(s.messages("t1")).toEqual([]);
    const last = s.changesAfter(0, 100).at(-1)!;
    expect(last).toMatchObject({ thread_id: "t1", entity: "thread", entity_id: "t1" });
    expect(s.entity("thread", "t1")).toBeNull();
  });

  it("ignores a harness exiting after the database closed", () => {
    const s = new LoomStore(":memory:");
    s.recordSpawn(4242, null, "claude", "start");
    s.close();
    expect(() => s.forgetSpawn(4242)).not.toThrow();
  });
});
