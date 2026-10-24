import { describe, expect, it } from "vitest";
import { openAtlasMemoryDatabase, runInTransaction } from "../src/index.js";

function countPinnedFacts(db: ReturnType<typeof openAtlasMemoryDatabase>["db"]): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM pinned_facts").get() as { n: number }).n;
}

function insertPinnedFact(db: ReturnType<typeof openAtlasMemoryDatabase>["db"], key: string): void {
  db.prepare(
    `INSERT INTO pinned_facts (id, scope, scope_id, key, value, created_at, updated_at)
     VALUES (?, 'global', NULL, ?, 'v', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z')`,
  ).run(key, key);
}

describe("runInTransaction", () => {
  it("commits and returns the callback's value", () => {
    const { db } = openAtlasMemoryDatabase({ dbPath: ":memory:" });
    expect(runInTransaction(db, () => { insertPinnedFact(db, "a"); return 7; })).toBe(7);
    expect(countPinnedFacts(db)).toBe(1);
    expect(db.isTransaction).toBe(false);
    db.close();
  });

  it("rolls back when the callback throws", () => {
    const { db } = openAtlasMemoryDatabase({ dbPath: ":memory:" });
    expect(() => runInTransaction(db, () => { insertPinnedFact(db, "a"); throw new Error("boom"); })).toThrow("boom");
    expect(countPinnedFacts(db)).toBe(0);
    expect(db.isTransaction).toBe(false);
    db.close();
  });

  it("rolls back only the inner work when a nested call throws", () => {
    const { db } = openAtlasMemoryDatabase({ dbPath: ":memory:" });
    runInTransaction(db, () => {
      insertPinnedFact(db, "outer");
      expect(() => runInTransaction(db, () => { insertPinnedFact(db, "inner"); throw new Error("inner"); })).toThrow("inner");
      expect(db.isTransaction).toBe(true);
    });
    expect(db.prepare("SELECT key FROM pinned_facts").all().map((row) => row.key)).toEqual(["outer"]);
    db.close();
  });
});
