import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThingsTools } from "../src/things-agent-tools.js";

let dir: string;
let db: DatabaseSync;
let filename: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tango-things-test-"));
  filename = join(dir, "main.sqlite");
  db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE TMTask(uuid TEXT PRIMARY KEY,type INTEGER DEFAULT 0,title TEXT,notes TEXT DEFAULT '',status INTEGER DEFAULT 0,
    trashed INTEGER DEFAULT 0,userModificationDate REAL DEFAULT 1,start INTEGER DEFAULT 1,startDate INTEGER,deadline INTEGER,
    rt1_recurrenceRule TEXT,repeater TEXT,project TEXT,area TEXT,heading TEXT,"index" INTEGER DEFAULT 0);
    CREATE TABLE TMArea(uuid TEXT PRIMARY KEY,title TEXT,"index" INTEGER DEFAULT 0);
    CREATE TABLE TMTag(uuid TEXT PRIMARY KEY,title TEXT,"index" INTEGER DEFAULT 0);
    CREATE TABLE TMTaskTag(tasks TEXT,tags TEXT); CREATE TABLE TMAreaTag(areas TEXT,tags TEXT);
    CREATE TABLE TMChecklistItem(uuid TEXT,title TEXT,status INTEGER,task TEXT,"index" INTEGER DEFAULT 0);
    INSERT INTO TMArea(uuid,title) VALUES('area','Test area');
    INSERT INTO TMTask(uuid,type,title,area) VALUES('project',1,'Test project','area');
    INSERT INTO TMTask(uuid,type,title,project) VALUES('heading',2,'Test heading','project');
    INSERT INTO TMTask(uuid,title,heading) VALUES('task','Pack supplies','heading');
    INSERT INTO TMTask(uuid,title) VALUES('other','Other task');
    INSERT INTO TMChecklistItem VALUES('check','First step',3,'task',0);`);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function tools(bridge = vi.fn(async (_input: Record<string, unknown>): Promise<Record<string, unknown>> => ({ id: "task" }))) {
  const [read, write] = createThingsTools({ databasePath: filename, bridge, verificationAttempts: 2, verificationDelayMs: 0 });
  return { read: read!.handler, write: write!.handler, bridge };
}

describe("Things tools", () => {
  it("reads checklist state and inherited project/area, with pagination", async () => {
    const { read, bridge } = tools();
    expect(await read({ operation: "get", id: "task" })).toMatchObject({
      project_id: "project", area_id: "area", checklist: [{ title: "First step", completed: true }],
    });
    expect(await read({ operation: "list", project_id: "project", limit: 1 })).toMatchObject({ total: 2, next_offset: 1 });
    expect(bridge).not.toHaveBeenCalled();
  });

  it("uses exact app membership and order for Today", async () => {
    const { read } = tools(vi.fn(async () => ({ ids: ["other", "task"] })));
    expect(await read({ operation: "list", list: "Today", limit: 1 })).toMatchObject({ items: [{ id: "other" }], total: 2, next_offset: 1 });
  });

  it("excludes children of trashed projects and prevents editing them", async () => {
    db.exec("UPDATE TMTask SET trashed=1 WHERE uuid='project'");
    const { read, write, bridge } = tools();
    expect(await read({ operation: "search", query: "Pack" })).toMatchObject({ items: [], total: 0 });
    await expect(write({ operation: "update", kind: "todo", id: "task", title: "Change" })).rejects.toThrow("Trash");
    expect(bridge).not.toHaveBeenCalled();
  });

  it("treats SQL metacharacters as search text", async () => {
    const { read } = tools();
    expect(await read({ operation: "search", query: "' OR 1=1 --" })).toMatchObject({ total: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM TMTask").get()!.n).toBe(4);
  });

  it("rejects invalid or unsupported mutations before touching the app", async () => {
    const { write, bridge } = tools();
    for (const input of [
      { operation: "update", kind: "todo", id: "task", when: "2026-02-30" },
      { operation: "create", kind: "todo", title: "Task", checklist: ["step"] },
      { operation: "trash", kind: "area", id: "area" },
      { operation: "update", kind: "project", id: "task", title: "wrong type" },
      { operation: "create", kind: "todo", title: "Task", project_id: "missing" },
      { operation: "update", kind: "todo", id: "task", tags: ["missing"] },
      { operation: "create", kind: "todo", title: "Task", project_id: "project", when: "inbox" },
    ]) await expect(write(input)).rejects.toThrow();
    expect(bridge).not.toHaveBeenCalled();
  });

  it("rejects stale and recurring task edits", async () => {
    const { write, bridge } = tools();
    await expect(write({ operation: "update", kind: "todo", id: "task", title: "new", expected_modified: 0 })).rejects.toThrow("changed");
    db.exec("UPDATE TMTask SET repeater='repeat' WHERE uuid='task'");
    await expect(write({ operation: "update", kind: "todo", id: "task", status: "completed" })).rejects.toThrow("Repeating");
    expect(bridge).not.toHaveBeenCalled();
  });

  it("does not claim success just because the app accepted a write", async () => {
    const { write, bridge } = tools();
    expect(await write({ operation: "update", kind: "todo", id: "task", title: "Changed" })).toMatchObject({ outcome: "unverified", id: "task", retry_safe: false });
    expect(bridge).toHaveBeenCalledTimes(1);
  });

  it("does not confuse inherited area with actually moving out of a project", async () => {
    const { write } = tools();
    expect(await write({ operation: "update", kind: "todo", id: "task", area_id: "area" })).toMatchObject({ outcome: "unverified", after: { project_id: "project" } });
  });

  it("preserves the known ID and does not retry a partial failure", async () => {
    const { write, bridge } = tools(vi.fn(async () => ({ id: "task", error: "partial write" })));
    expect(await write({ operation: "create", kind: "todo", title: "Changed" })).toMatchObject({ outcome: "unknown", id: "task", retry_safe: false });
    expect(bridge).toHaveBeenCalledTimes(1);
  });

  it("returns unknown after timeout without blindly retrying", async () => {
    const { write, bridge } = tools(vi.fn(async () => { throw Error("timeout"); }));
    expect(await write({ operation: "update", kind: "todo", id: "task", title: "Changed" })).toMatchObject({ outcome: "unknown", retry_safe: false });
    expect(bridge).toHaveBeenCalledTimes(1);
  });

  it("verifies persisted changes and preserves omitted notes", async () => {
    db.exec("UPDATE TMTask SET notes='Preserve me' WHERE uuid='task'");
    const { write } = tools(vi.fn(async (p) => {
      db.prepare("UPDATE TMTask SET title=? WHERE uuid=?").run(String(p.title), String(p.id));
      return { id: p.id };
    }));
    expect(await write({ operation: "update", kind: "todo", id: "task", title: "Changed" })).toMatchObject({
      outcome: "verified", before: { title: "Pack supplies" }, after: { title: "Changed", notes: "Preserve me" },
    });
  });

  it("serializes writes and rechecks stale versions after waiting", async () => {
    let release!: () => void;
    const wait = new Promise<void>((r) => { release = r; });
    const { write, bridge } = tools(vi.fn(async (p) => {
      await wait;
      db.prepare("UPDATE TMTask SET title=?,userModificationDate=2 WHERE uuid='task'").run(String(p.title));
      return { id: "task" };
    }));
    const first = write({ operation: "update", kind: "todo", id: "task", title: "First", expected_modified: 1 });
    const second = write({ operation: "update", kind: "todo", id: "task", title: "Second", expected_modified: 1 });
    const rejection = expect(second).rejects.toThrow("changed");
    release();
    expect(await first).toMatchObject({ outcome: "verified" });
    await rejection;
    expect(bridge).toHaveBeenCalledTimes(1);
  });
});
