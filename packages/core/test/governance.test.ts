import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GovernanceChecker } from "../src/governance.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GovernanceChecker", () => {
  it("can check permission without writing an audit row", () => {
    const db = {
      prepare(sql: string) {
        if (sql.startsWith("SELECT access_level FROM permissions")) {
          return {
            get: () => ({ access_level: "read" }),
          };
        }

        if (sql.startsWith("SELECT p.access_level, p.group_id FROM permissions p")) {
          return {
            all: () => [],
          };
        }

        if (sql.startsWith("SELECT parent_id FROM principals")) {
          return {
            get: () => undefined,
          };
        }

        if (sql.startsWith("SELECT tool_id FROM permissions")) {
          return {
            all: () => [],
          };
        }

        if (sql.startsWith("SELECT DISTINCT p.tool_id FROM permissions p")) {
          return {
            all: () => [],
          };
        }

        if (sql.startsWith("INSERT INTO governance_log")) {
          return {
            run: vi.fn(),
          };
        }

        if (sql.startsWith("SELECT access_type FROM governance_tools")) {
          return {
            get: () => ({ access_type: "write" }),
          };
        }

        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as DatabaseSync;

    const checker = new GovernanceChecker(db);
    expect(checker.hasPermission("worker:recipe-librarian", "fatsecret_api", "read")).toBe(true);
    expect(checker.hasPermission("worker:recipe-librarian", "fatsecret_api", "write")).toBe(false);
  });

  it("treats audit-log failures as non-fatal for permission checks", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const db = {
      prepare(sql: string) {
        if (sql.startsWith("SELECT access_level FROM permissions")) {
          return {
            get: () => ({ access_level: "write" }),
          };
        }

        if (sql.startsWith("SELECT p.access_level, p.group_id FROM permissions p")) {
          return {
            all: () => [],
          };
        }

        if (sql.startsWith("SELECT parent_id FROM principals")) {
          return {
            get: () => undefined,
          };
        }

        if (sql.startsWith("SELECT tool_id FROM permissions")) {
          return {
            all: () => [],
          };
        }

        if (sql.startsWith("SELECT DISTINCT p.tool_id FROM permissions p")) {
          return {
            all: () => [],
          };
        }

        if (sql.startsWith("INSERT INTO governance_log")) {
          return {
            run: () => {
              throw new Error("database is locked");
            },
          };
        }

        if (sql.startsWith("SELECT access_type FROM governance_tools")) {
          return {
            get: () => ({ access_type: "write" }),
          };
        }

        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as DatabaseSync;

    const checker = new GovernanceChecker(db);
    expect(checker.checkPermission("worker:nutrition-logger", "fatsecret_api", "write")).toEqual({
      granted: true,
      resolvedVia: "explicit",
      accessLevel: "write",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[governance] audit log write failed for worker:nutrition-logger/fatsecret_api: database is locked",
    );
  });
});

describe("governance seed", () => {
  it("grants discord_send_image to send-image personas but not kilo", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { GOVERNANCE_DDL, GOVERNANCE_SEED, GOVERNANCE_EXAMPLE_SEED } = await import(
      "../src/governance-schema.js"
    );
    const db = new DatabaseSync(":memory:");
    db.exec(GOVERNANCE_DDL + GOVERNANCE_SEED + GOVERNANCE_EXAMPLE_SEED);

    const checker = new GovernanceChecker(db as unknown as DatabaseSync);
    expect(checker.getToolAccessType("discord_send_image")).toBe("write");
    // Seeded classic workers and seeded -ollama clones must hold the grant.
    for (const principal of [
      "worker:personal-assistant",
      "worker:research-assistant",
      "worker:study-assistant",
      "worker:dev-assistant",
      "worker:workout-recorder",
      "worker:foxtrot",
      "worker:foxtrot-ollama",
      "worker:sierra-ollama",
    ]) {
      expect(checker.hasPermission(principal, "discord_send_image", "write"), principal).toBe(true);
    }
    // kilo is excluded pending owner decision — deny-by-default must hold.
    expect(checker.hasPermission("worker:kilo", "discord_send_image", "write")).toBe(false);
  });

  it("seeds Walmart shopping for Foxtrot instead of Sierra", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { GOVERNANCE_DDL, GOVERNANCE_SEED, GOVERNANCE_EXAMPLE_SEED } = await import(
      "../src/governance-schema.js"
    );
    const db = new DatabaseSync(":memory:");
    db.exec(GOVERNANCE_DDL + GOVERNANCE_SEED + GOVERNANCE_EXAMPLE_SEED);

    const checker = new GovernanceChecker(db as unknown as DatabaseSync);
    expect(checker.getToolAccessType("walmart")).toBe("write");
    expect(checker.hasPermission("worker:foxtrot", "walmart", "write")).toBe(true);
    expect(checker.hasPermission("worker:foxtrot-ollama", "walmart", "write")).toBe(true);
    expect(checker.hasPermission("worker:research-assistant", "walmart", "write")).toBe(false);
    expect(checker.hasPermission("worker:sierra-ollama", "walmart", "write")).toBe(false);
  });

  it("seeds local business search for Sierra research workers", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { GOVERNANCE_DDL, GOVERNANCE_SEED, GOVERNANCE_EXAMPLE_SEED } = await import(
      "../src/governance-schema.js"
    );
    const db = new DatabaseSync(":memory:");
    db.exec(GOVERNANCE_DDL + GOVERNANCE_SEED + GOVERNANCE_EXAMPLE_SEED);

    const checker = new GovernanceChecker(db as unknown as DatabaseSync);
    expect(checker.getToolAccessType("local_business_search")).toBe("read");
    expect(checker.hasPermission("worker:research-assistant", "local_business_search", "read")).toBe(true);
    expect(checker.hasPermission("worker:sierra-ollama", "local_business_search", "read")).toBe(true);
    expect(checker.hasPermission("worker:sierra-ollama", "local_business_search", "write")).toBe(false);
  });
});

describe("born ungranted (T-I-071)", () => {
  it("a fresh database holds no roster principals and no non-owner grants", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { TangoStorage } = await import("../src/storage.js");
    const dir = mkdtempSync(path.join(tmpdir(), "t-i-071-"));
    const storage = new TangoStorage(path.join(dir, "fresh.sqlite"));
    const db = storage.getDatabase();
    const one = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
    expect(one("SELECT COUNT(*) c FROM principals WHERE type IN ('agent','worker')")).toBe(0);
    expect(one("SELECT COUNT(*) c FROM permissions WHERE principal_id != 'user:owner'")).toBe(0);
    expect(one("SELECT COUNT(*) c FROM principals")).toBe(1);
    expect(one("SELECT COUNT(*) c FROM governance_tools")).toBeGreaterThan(50);
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("opting into the example roster restores the historical seeded world", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { TangoStorage } = await import("../src/storage.js");
    const dir = mkdtempSync(path.join(tmpdir(), "t-i-071ex-"));
    const storage = new TangoStorage(path.join(dir, "fresh.sqlite"), { seedExampleRoster: true });
    const db = storage.getDatabase();
    const one = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
    expect(one("SELECT COUNT(*) c FROM principals WHERE type IN ('agent','worker')")).toBeGreaterThan(25);
    expect(one("SELECT COUNT(*) c FROM permissions")).toBeGreaterThan(150);
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
