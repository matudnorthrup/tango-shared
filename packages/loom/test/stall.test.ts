import { it, expect } from "vitest";
import { StallMonitor } from "../src/stall.js";

it("logs a timestamped line only for a degraded minute, naming the slowest spawn", () => {
  const lines: string[] = [];
  const monitor = new StallMonitor((line) => lines.push(line), () => Date.parse("2026-10-24T13:03:00Z"));
  monitor.noteSpawn("git add", 40);
  expect(monitor.sample()).toMatchObject({ degraded: false, spawns: { count: 1, maxMs: 40, slowest: "git add" } });
  expect(lines).toEqual([]);

  monitor.noteSpawn("memory_pressure", 12_000);
  monitor.noteSpawn("git status", 30);
  expect(monitor.sample()).toMatchObject({ degraded: true, spawns: { count: 2, maxMs: 12_000, slowest: "memory_pressure" } });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^\[loom\] stall 2026-10-24T13:03:00\.000Z: event loop .*slowest of 2 spawns 12000 ms \(memory_pressure\); rss \d+ MB; active /);

  // Each minute stands alone.
  expect(monitor.sample()).toMatchObject({ degraded: false, spawns: { count: 0, maxMs: 0 } });
});

it("reads the event loop's delay once started", async () => {
  const lines: string[] = [];
  const monitor = new StallMonitor((line) => lines.push(line));
  monitor.start(3_600_000);
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const busyUntil = Date.now() + 2_100;
    while (Date.now() < busyUntil) { /* hold the loop */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const reading = monitor.sample();
    expect(reading.loop.maxMs).toBeGreaterThanOrEqual(2_000);
    expect(reading.degraded).toBe(true);
    expect(lines[0]).toContain("event loop");
  } finally { monitor.stop(); }
});
