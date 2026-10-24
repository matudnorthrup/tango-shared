import { describe, expect, it } from "vitest";
import { forecastSeat, QuotaHistory, QUOTA_RETENTION_MS, type QuotaSample } from "../src/forecast.js";
import { LoomStore } from "../src/store.js";
import { AccountPool } from "../src/pool.js";
import { capacitySnapshot } from "../src/capacity.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2030-01-02T00:00:00Z");
const RESET = NOW + 24 * HOUR;
const sample = (hours: number, left: number, reset = RESET): QuotaSample => ({ at: NOW - hours * HOUR, weekly_left: left, weekly_resets_at: reset, five_left: 90 });
const forecast = (left: number, samples: QuotaSample[]) => forecastSeat({ now: NOW, weekly: { left, resetsAt: RESET }, samples, floor: 10 });

describe("weekly forecast", () => {
  it("projects steady burn and reports pace-independent daily burn", () => {
    expect(forecast(62, [sample(24, 71)])).toEqual({ forecast: { burnPerDay: 9, hoursOfHistory: 24, projectedAtReset: 53, dryAt: NOW + (52 / (9 / 24)) * HOUR, flags: ["expires_unused"] }, forecastReason: null });
  });
  it("leaves flat and upward corrections at zero burn", () => {
    for (const left of [80, 85]) expect(forecast(left, [sample(4, 80)]).forecast).toMatchObject({ projectedAtReset: left, burnPerDay: 0, dryAt: null, flags: ["expires_unused"] });
  });
  it("estimates hitting the floor before reset and clamps projected room", () => {
    expect(forecast(20, [sample(4, 40)]).forecast).toMatchObject({ burnPerDay: 120, projectedAtReset: 0, dryAt: NOW + 2 * HOUR, flags: ["runs_dry"] });
    expect(forecast(34, [sample(4, 38)]).forecast?.flags).toEqual([]); // exactly at reset is not before reset
  });
  it("ignores prior resets, future samples, and samples older than a day", () => {
    expect(forecast(60, [sample(30, 100), sample(20, 100, RESET - 7 * 24 * HOUR), sample(-2, 10), sample(1, 61)])).toEqual({ forecast: null, forecastReason: "history" });
    expect(forecast(60, [sample(2, 62, RESET + 60_000)]).forecast?.burnPerDay).toBe(24);
    expect(forecast(60, [sample(2, 62, RESET + 60_001)]).forecastReason).toBe("history");
  });
  it("needs two hours of history", () => {
    expect(forecast(60, []).forecastReason).toBe("history");
    expect(forecast(60, [sample(1.99, 62)]).forecastReason).toBe("history");
    expect(forecast(60, [sample(2, 62)]).forecast).not.toBeNull();
  });
  it("flags already dry seats now", () => {
    for (const left of [10, 9]) expect(forecast(left, [sample(2, left)]).forecast).toMatchObject({ dryAt: NOW, flags: ["runs_dry"] });
  });
  it("does not forecast absent, unknown or expired reset readings", () => {
    for (const weekly of [null, { left: 60, resetsAt: null }, { left: 60, resetsAt: NOW }]) {
      expect(forecastSeat({ now: NOW, weekly, samples: [sample(4, 70)], floor: 10 })).toEqual({ forecast: null, forecastReason: "no_reading" });
    }
  });
});

describe("quota history", () => {
  it("dedupes, records changed weeks and heartbeat, isolates providers, and prunes", () => {
    const store = new LoomStore(":memory:");
    try {
      let now = NOW; store.now = () => now;
      const history = new QuotaHistory(store);
      const windows = { weekly: { left: 80, resetsAt: RESET }, fiveHour: { left: 90, resetsAt: null }, fresh: true };
      history.record("claude", "a", windows);
      now += 29 * 60_000; history.record("claude", "a", { ...windows, fiveHour: { left: 70, resetsAt: null } });
      expect(history.samples("claude", "a")).toHaveLength(1);
      now += 60_000; history.record("claude", "a", windows);
      history.record("claude", "a", { ...windows, weekly: { left: 79, resetsAt: RESET } });
      history.record("claude", "a", { ...windows, weekly: { left: 79, resetsAt: RESET + 7 * 24 * HOUR } });
      history.record("codex", "a", windows);
      expect(history.samples("claude", "a")).toHaveLength(4);
      expect(history.samples("codex", "a")).toHaveLength(1);
      history.record("claude", "b", { ...windows, fresh: false });
      history.record("claude", "b", { ...windows, weekly: null });
      expect(history.samples("claude", "b")).toEqual([]);
      now += QUOTA_RETENTION_MS + 1;
      new QuotaHistory(store);
      expect(store.db.prepare("SELECT COUNT(*) AS n FROM quota_samples").get()).toEqual({ n: 0 });
    } finally { store.close(); }
  });

  it("serves projections through capacity, with stale readings suppressed", () => {
    const store = new LoomStore(":memory:");
    try {
      let now = NOW - 4 * HOUR; store.now = () => now;
      const pool = new AccountPool([{ provider: "claude", name: "a", usageName: "A" }]); pool.now = () => now;
      const history = new QuotaHistory(store);
      pool.onReading = (provider, name) => history.record(provider, name, pool.capacityWindows(provider, name));
      const apply = (left: number) => pool.applyUsage([{ provider: "claude", account: "A", windows: [{ kind: "weekly", remainingPercent: left, resetsAt: new Date(RESET).toISOString() }] }]);
      apply(80);
      expect(capacitySnapshot(store, pool, undefined, history).accounts[0]?.forecastReason).toBe("history");
      now = NOW; apply(60);
      expect(capacitySnapshot(store, pool, undefined, history).accounts[0]?.forecast).toMatchObject({ burnPerDay: 120, dryAt: NOW + 10 * HOUR, flags: ["runs_dry"] });
      now += HOUR;
      expect(capacitySnapshot(store, pool, undefined, history).accounts[0]).toMatchObject({ forecast: null, forecastReason: "no_reading" });
    } finally { store.close(); }
  });
});
