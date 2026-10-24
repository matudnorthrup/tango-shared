import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { GOVERNANCE_DDL } from "../../core/src/governance-schema.js";
import { GovernanceChecker } from "../../core/src/governance.js";
const script = new URL("../../../scripts/grant-todoist-management.mjs", import.meta.url).pathname;
describe("explicit Todoist management grants", () => {
  it("grants only selected workers, preserves denies, and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "todoist-manage-grants-")); const file = join(dir, "db.sqlite"); const db = new DatabaseSync(file);
    try {
      db.exec(GOVERNANCE_DDL);
      for (const id of ["worker:coordinator", "worker:specialist", "worker:denied", "worker:readonly"]) db.prepare("INSERT INTO principals(id,type) VALUES (?,'worker')").run(id);
      db.prepare("INSERT INTO governance_tools(id,access_type) VALUES ('todoist_manage','write')").run();
      db.prepare("INSERT INTO permissions(principal_id,tool_id,access_level) VALUES ('worker:denied','todoist_manage','none'),('worker:readonly','todoist_manage','read')").run();
      const args = [script, "--db", file, "--workers", "worker:coordinator,worker:denied,worker:readonly"];
      expect(spawnSync(process.execPath, args).status).toBe(0);
      const before = db.prepare("SELECT * FROM permissions ORDER BY id").all();
      expect(spawnSync(process.execPath, args).status).toBe(0); expect(db.prepare("SELECT * FROM permissions ORDER BY id").all()).toEqual(before);
      const checker = new GovernanceChecker(db);
      expect(checker.hasPermission("worker:coordinator", "todoist_manage", "write")).toBe(true);
      expect(checker.hasPermission("worker:specialist", "todoist_manage", "read")).toBe(false);
      expect(checker.hasPermission("worker:denied", "todoist_manage", "read")).toBe(false);
      expect(checker.hasPermission("worker:readonly", "todoist_manage", "read")).toBe(true);
      expect(checker.hasPermission("worker:readonly", "todoist_manage", "write")).toBe(false);
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(["worker:valid,worker:missing", "agent:coordinator", "worker:*"])("fails atomically for invalid roster %s", workers => {
    const dir = mkdtempSync(join(tmpdir(), "todoist-manage-grants-")); const file = join(dir, "db.sqlite"); const db = new DatabaseSync(file);
    try {
      db.exec(GOVERNANCE_DDL); db.prepare("INSERT INTO principals(id,type) VALUES ('worker:valid','worker')").run();
      expect(spawnSync(process.execPath, [script, "--db", file, "--workers", workers]).status).not.toBe(0);
      expect(db.prepare("SELECT * FROM permissions").all()).toEqual([]);
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
