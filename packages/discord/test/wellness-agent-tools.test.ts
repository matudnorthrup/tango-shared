import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHealthTools, createNutritionTools, createWorkoutTools } from "../src/wellness-agent-tools.js";

import { ensureWellnessDb } from "../src/wellness-db-migrations.js";

const tempDirs: string[] = [];

function makeScript(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-wellness-tools-"));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, "fake-workout.sh");
  fs.writeFileSync(scriptPath, contents, "utf8");
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("createWorkoutTools", () => {
  it("returns stdout on success", async () => {
    const scriptPath = makeScript("#!/usr/bin/env bash\necho 'query ok'\n");
    const [tool] = createWorkoutTools({ workoutScript: scriptPath });

    const result = await tool!.handler({ sql: "SELECT 1;" });
    expect(result).toEqual({ result: "query ok" });
  });

  it("surfaces shell failures instead of pretending the result was empty", async () => {
    const scriptPath = makeScript("#!/usr/bin/env bash\necho 'container is not running' >&2\nexit 1\n");
    const [tool] = createWorkoutTools({ workoutScript: scriptPath });

    await expect(tool!.handler({ sql: "SELECT 1;" })).rejects.toThrow("container is not running");
  });

  it("log_workout writes finishers to workout_finishers, never to sets", async () => {
    // Echo the SQL back so the test can inspect what would run.
    const scriptPath = makeScript('#!/usr/bin/env bash\nprintf "%s" "$2"\n');
    const [tool] = createWorkoutTools({ workoutScript: scriptPath });

    const result = (await tool!.handler({
      action: "log_workout",
      routine: "Full-Body Moto B",
      exercises: [{ exercise: "Kettlebell Swing", sets: [{ weight: 53, reps: 15 }] }],
      finishers: [
        { name: "Kettlebell Swing", protocol: "EMOM 8 min · 15 swings", load: "53 lb KB" },
        { name: "Farmer's Carry", protocol: "3×40 m" },
      ],
    })) as { result: string };
    const sql = result.result;

    expect(sql).toContain("INSERT INTO workout_finishers (workout_id, name, protocol, load, notes)");
    expect(sql).toContain("('Kettlebell Swing', 'EMOM 8 min · 15 swings', '53 lb KB', NULL::text)");
    expect(sql).toContain("('Farmer''s Carry', '3×40 m', NULL::text, NULL::text)");
    expect(sql).toContain("(SELECT count(*) FROM fin) AS finishers_logged");
    // The finisher swing is a Moto B routine exercise too; only the prescribed set may reach sets.
    const setRows = sql.slice(sql.indexOf("sd ("), sql.indexOf("resolved AS"));
    expect(setRows.match(/'Kettlebell Swing'/g)).toHaveLength(1);
    expect(setRows).not.toContain("Farmer");
  });

  it("log_workout without finishers leaves workout_finishers untouched", async () => {
    const scriptPath = makeScript('#!/usr/bin/env bash\nprintf "%s" "$2"\n');
    const [tool] = createWorkoutTools({ workoutScript: scriptPath });

    const result = (await tool!.handler({
      action: "log_workout",
      exercises: [{ exercise: "Bench Press", sets: [{ weight: 135, reps: 12 }] }],
    })) as { result: string };

    expect(result.result).not.toContain("workout_finishers");
    expect(result.result).toContain("0 AS finishers_logged");
  });
});

describe("createHealthTools", () => {
  it("maps source_breakdown to the diagnostic CLI command", async () => {
    const scriptPath = makeScript([
      "#!/usr/bin/env node",
      "console.log(JSON.stringify({ args: process.argv.slice(2) }));",
      "",
    ].join("\n"));
    const [tool] = createHealthTools({ healthScript: scriptPath });

    const result = await tool!.handler({ command: "source_breakdown", date: "2026-06-02" });
    expect(result).toEqual({ args: ["--source-breakdown", "2026-06-02"] });
  });

  it("advertises compare and source_breakdown in the schema", () => {
    const [tool] = createHealthTools({ healthScript: "/tmp/fake-health-query.js" });
    const schema = tool!.inputSchema as {
      properties?: { command?: { enum?: string[] } };
    };
    const command = schema.properties?.command;

    expect(command).toMatchObject({
      enum: expect.arrayContaining(["compare", "source_breakdown"]),
    });
  });
});

describe("createNutritionTools", () => {
  it.each(["JULES_WELLNESS_DB_PATH", "WELLNESS_DB_PATH"])("logs against %s instead of the legacy path", async (env) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-nutrition-path-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "wellness.db");
    ensureWellnessDb(dbPath);
    vi.stubEnv("JULES_WELLNESS_DB_PATH", "");
    vi.stubEnv("WELLNESS_DB_PATH", "");
    vi.stubEnv(env, dbPath);
    const tool = createNutritionTools()
      .find((entry) => entry.name === "nutrition_log_items")!;
    expect(await tool.handler({ items: [{ name: "Unknown", quantity: "1" }], meal: "lunch" }))
      .toMatchObject({ status: "needs_clarification", logged: [] });
    expect(tool.description).toContain("Do NOT pre-expand recipes");
  });

  it("fails fast when a FatSecret method is called without required params", async () => {
    const scriptPath = makeScript("#!/usr/bin/env bash\necho 'should not run'\n");
    const fatsecretTool = createNutritionTools({ fatsecretApiScript: scriptPath })
      .find((tool) => tool.name === "fatsecret_api");

    await expect(
      fatsecretTool!.handler({
        method: "foods_search",
        params: {},
      }),
    ).rejects.toThrow("fatsecret_api.foods_search requires params: search_expression");
  });
});
