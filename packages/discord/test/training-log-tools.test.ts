import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrainingLogTools, trainingLogToolLooksReadOnly } from "../src/training-log-tools.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(now = "2026-10-10T18:00:00Z") {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "training-log-"));
  dirs.push(dataDir);
  const [tool] = createTrainingLogTools({ dataDir, now: () => new Date(now), timeZone: "America/Los_Angeles" });
  const call = (agent: string, args: Record<string, unknown>) =>
    tool!.handler({ ...args, _requester_agent_id: agent }) as Promise<Record<string, any>>;
  return { dataDir, call };
}

describe("training_log", () => {
  it("logs a session with shooting stats and summarizes it", async () => {
    const { call } = setup();
    const { logged } = await call("mike", {
      operation: "log_session",
      type: "skills",
      duration_min: 45,
      rpe: 7,
      exercises: [
        { name: "Form shooting", made: 40, attempted: 50 },
        { name: "Corner threes", made: 12, attempted: 30 },
        { name: "Pushups", sets: 3, reps: 15 },
      ],
    });
    expect(logged.date).toBe("2026-10-10");
    expect(logged.exercises).toHaveLength(3);

    const summary = await call("mike", { operation: "summary" });
    expect(summary).toMatchObject({
      sessions: 1,
      activeDays: 1,
      totalMinutes: 45,
      byType: { skills: 1 },
      averageRpe: 7,
      shooting: { made: 52, attempted: 80, percent: 65 },
    });
  });

  it("filters recent sessions by window and keeps goals", async () => {
    const { call } = setup();
    await call("mike", { operation: "log_session", type: "strength", date: "2026-09-01" });
    await call("mike", { operation: "log_session", type: "game", date: "2026-10-08" });
    const recent = await call("mike", { operation: "list_recent", days: 7 });
    expect(recent.sessions.map((s: { type: string }) => s.type)).toEqual(["game"]);

    const { goal } = await call("mike", { operation: "set_goal", text: "Hit 50% from three", target_date: "2026-12-01" });
    await call("mike", { operation: "complete_goal", id: goal.id });
    const { goals } = await call("mike", { operation: "list_goals" });
    expect(goals[0]).toMatchObject({ status: "done", targetDate: "2026-12-01" });
  });

  it("updates and deletes sessions", async () => {
    const { call } = setup();
    const { logged } = await call("mike", { operation: "log_session", type: "conditioning", duration_min: 20 });
    const { updated } = await call("mike", { operation: "update_session", id: logged.id, duration_min: 30, notes: "suicides" });
    expect(updated).toMatchObject({ durationMin: 30, notes: "suicides" });
    await call("mike", { operation: "delete_session", id: logged.id });
    expect((await call("mike", { operation: "list_recent" })).sessions).toEqual([]);
  });

  it("keeps each agent's log separate and requires an authenticated agent", async () => {
    const { call, dataDir } = setup();
    await call("mike", { operation: "log_session", type: "basketball" });
    expect((await call("other-agent", { operation: "list_recent" })).sessions).toEqual([]);
    expect(fs.existsSync(path.join(dataDir, "training", "mike.json"))).toBe(true);

    const [tool] = createTrainingLogTools({ dataDir });
    await expect(tool!.handler({ operation: "list_recent" })).rejects.toThrow(/authenticated agent/u);
    await expect(tool!.handler({ operation: "list_recent", _requester_agent_id: "../x" })).rejects.toThrow(/authenticated agent/u);
  });

  it("validates input", async () => {
    const { call } = setup();
    await expect(call("mike", { operation: "log_session", type: "yoga-ish" })).rejects.toThrow(/type must be/u);
    await expect(call("mike", { operation: "log_session", rpe: 11 })).rejects.toThrow(/rpe/u);
    await expect(call("mike", { operation: "log_session", date: "10/10" })).rejects.toThrow(/YYYY-MM-DD/u);
    await expect(call("mike", { operation: "log_session", exercises: [{ name: "x", made: 5, attempted: 3 }] }))
      .rejects.toThrow(/made cannot exceed/u);
    await expect(call("mike", { operation: "explode" })).rejects.toThrow(/Unknown operation/u);
    await expect(call("mike", { operation: "log_session", date: "2026-02-30" })).rejects.toThrow(/real calendar date/u);
    await expect(call("mike", { operation: "log_session", date: "2025-02-29" })).rejects.toThrow(/real calendar date/u);
    await expect(call("mike", { operation: "log_session", date: "2026-10-11" })).rejects.toThrow(/future/u);
    expect((await call("mike", { operation: "log_session", date: "2024-02-29" })).logged.date).toBe("2024-02-29");
  });

  it("dates sessions in the configured time zone", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "training-log-"));
    dirs.push(dataDir);
    // 2026-10-11 02:00 UTC is still Oct 10 in Los Angeles but Oct 11 in Tokyo.
    const at = () => new Date("2026-10-11T02:00:00Z");
    const [la] = createTrainingLogTools({ dataDir, now: at, timeZone: "America/Los_Angeles" });
    const [tokyo] = createTrainingLogTools({ dataDir, now: at, timeZone: "Asia/Tokyo" });
    const args = { operation: "log_session", _requester_agent_id: "mike" };
    expect(((await la!.handler(args)) as { logged: { date: string } }).logged.date).toBe("2026-10-10");
    expect(((await tokyo!.handler(args)) as { logged: { date: string } }).logged.date).toBe("2026-10-11");
  });

  it("classifies read operations", () => {
    expect(trainingLogToolLooksReadOnly("summary")).toBe(true);
    expect(trainingLogToolLooksReadOnly("list_recent")).toBe(true);
    expect(trainingLogToolLooksReadOnly("log_session")).toBe(false);
  });
});
