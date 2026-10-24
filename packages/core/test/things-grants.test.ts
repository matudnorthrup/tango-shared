import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { GOVERNANCE_DDL, GOVERNANCE_SEED } from "../src/governance-schema.js";

it("previews without changing grants and applies only explicit existing principals", () => {
  const dir = mkdtempSync(join(tmpdir(), "things-grants-"));
  const filename = join(dir, "governance.sqlite");
  const db = new DatabaseSync(filename);
  try {
    db.exec(GOVERNANCE_DDL + GOVERNANCE_SEED);
    db.exec("INSERT INTO principals(id,type,parent_id,display_name) VALUES('worker:test','worker','user:owner','Test'),('worker:other','worker','user:owner','Other')");
    const script = fileURLToPath(new URL("../../../scripts/grant-things.mjs", import.meta.url));
    const args = [script, "--db", filename, "--principal", "worker:test"];
    execFileSync(process.execPath, args);
    expect(db.prepare("SELECT * FROM permissions WHERE tool_id LIKE 'things_%'").all()).toEqual([]);
    const denied = spawnSync(process.execPath, [...args, "--principal", "worker:missing", "--apply"]);
    expect(denied.status).not.toBe(0);
    expect(db.prepare("SELECT * FROM permissions WHERE tool_id LIKE 'things_%'").all()).toEqual([]);
    execFileSync(process.execPath, [...args, "--apply"]);
    execFileSync(process.execPath, [...args, "--apply"]);
    expect(db.prepare("SELECT principal_id,tool_id,access_level FROM permissions WHERE tool_id LIKE 'things_%' ORDER BY tool_id").all()).toEqual([
      { principal_id: "worker:test", tool_id: "things_read", access_level: "read" },
      { principal_id: "worker:test", tool_id: "things_write", access_level: "write" },
    ]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
