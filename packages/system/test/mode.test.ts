import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkGate } from "../src/gate.js";
import { clearManual, currentMode, openWindow, readWindows, setAway, setWorking } from "../src/mode.js";
import { runModeCli } from "../src/cli/tango-mode.js";
import { tempDir } from "./helpers.js";

function files() {
  const d = tempDir("mode-");
  return { modeFile: join(d, "work-mode.json"), windowsFile: join(d, "work-windows.yaml") };
}
// 2026-10-20 is a Tuesday. Local time throughout.
const at = (h: number, m = 0, day = 20) => new Date(2026, 9, day, h, m, 0, 0);

describe("work mode", () => {
  it("is working by default", () => {
    const f = files();
    expect(currentMode({ ...f, now: at(12) })).toMatchObject({ mode: "working", source: "default" });
  });

  it("away lasts until it is set back, or until its hours run out", () => {
    const f = files();
    setAway({ file: f.modeFile, now: at(9) });
    expect(currentMode({ ...f, now: at(23) })).toMatchObject({ mode: "away", source: "manual", minutesLeft: null });
    setAway({ file: f.modeFile, hours: 2, now: at(9) });
    expect(currentMode({ ...f, now: at(10) })).toMatchObject({ mode: "away", minutesLeft: 60 });
    expect(currentMode({ ...f, now: at(11, 1) }).mode).toBe("working");
    setWorking({ file: f.modeFile, now: at(9) });
    expect(currentMode({ ...f, now: at(9, 5) })).toMatchObject({ mode: "working", source: "manual" });
    clearManual(f.modeFile);
    expect(currentMode({ ...f, now: at(9, 5) }).source).toBe("default");
  });

  it("a weekly window past midnight is away on both sides of it, only on its days", () => {
    const f = files();
    writeFileSync(f.windowsFile, "away:\n  - days: [tue]\n    from: '21:00'\n    to: '03:00'\n  - from: 'nonsense'\n    to: '03:00'\n");
    expect(readWindows(f.windowsFile)).toHaveLength(1);
    expect(currentMode({ ...f, now: at(22) })).toMatchObject({ mode: "away", source: "schedule" });
    expect(currentMode({ ...f, now: at(2, 30, 21) })).toMatchObject({ mode: "away", minutesLeft: 30 });
    expect(currentMode({ ...f, now: at(4, 0, 21) }).mode).toBe("working");
    expect(currentMode({ ...f, now: at(22, 0, 21) }).mode).toBe("working"); // Wednesday night: not listed
    expect(openWindow([], at(1))).toBeNull();
  });

  it("a manual working overrides an open window", () => {
    const f = files();
    writeFileSync(f.windowsFile, "away:\n  - from: '21:00'\n    to: '23:00'\n");
    setWorking({ file: f.modeFile, now: at(21, 30) });
    expect(currentMode({ ...f, now: at(22) }).mode).toBe("working");
  });
});

describe("gate", () => {
  it("holds while working, and for forced runs lets go", () => {
    const f = files();
    expect(checkGate({}, { ...f, now: at(12) })).toMatchObject({ allowed: false });
    expect(checkGate({ force: true }, { ...f, now: at(12) }).allowed).toBe(true);
  });

  it("lets a job run when away and the work fits the window and the disk", () => {
    const f = files();
    setAway({ file: f.modeFile, hours: 2, now: at(9) });
    const now = at(10);
    expect(checkGate({ needMinutes: 30, needGb: 5 }, { ...f, now, free: () => 50 }).allowed).toBe(true);
    expect(checkGate({ needMinutes: 90 }, { ...f, now }).reason).toMatch(/closes in 60 min/);
    expect(checkGate({ needGb: 80 }, { ...f, now, free: () => 50 }).reason).toMatch(/50\.0 GB free/);
    expect(checkGate({ needGb: 80 }, { ...f, now, free: () => null }).allowed).toBe(false);
  });
});

describe("bad input fails closed", () => {
  it("drops a window whose days name no real day", () => {
    const f = files();
    writeFileSync(f.windowsFile, "away:\n  - { from: '22:00', to: '06:00', days: [funday] }\n  - { from: '22:00', to: '06:00', days: [mon] }\n");
    expect(readWindows(f.windowsFile)).toEqual([{ from: "22:00", to: "06:00", days: ["mon"] }]);
  });

  it("rejects a bad --hours without changing the mode", () => {
    const f = files();
    process.env.TANGO_WORK_MODE_FILE = f.modeFile;
    const errs: string[] = [];
    expect(runModeCli(["away", "--hours", "8h"], () => {}, (s) => errs.push(s))).toBe(64);
    expect(runModeCli(["away", "--hours"], () => {}, (s) => errs.push(s))).toBe(64);
    expect(errs).toHaveLength(2);
    delete process.env.TANGO_WORK_MODE_FILE;
  });
});
