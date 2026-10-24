import { describe, expect, it } from "vitest";
import { listIncidents, recordEvent, releaseHeldRecoveries } from "../src/incidents.js";
import { minutesAgo, tempLedger } from "./helpers.js";

const job = "launchd:com.example.sync";

describe("targeted recoveries", () => {
  it("resolves only the log incident it names, not the job's other logs", () => {
    const l = tempLedger();
    const big = (file: string) => ({ source: "tick", kind: "log.large", severity: "warning" as const, title: `Log is large: ${file}`, jobId: job });
    recordEvent(l, big("out.log"));
    recordEvent(l, big("err.log"));
    expect(listIncidents(l)).toHaveLength(2);

    recordEvent(l, { source: "tick", kind: "log.ok", severity: "recovery", title: "Log is back under the limit: out.log", jobId: job, resolves: { kind: "log.large", title: "Log is large: out.log" } });

    const open = listIncidents(l);
    expect(open).toHaveLength(1);
    expect(open[0]!.title).toBe("Log is large: err.log");
  });
});

describe("flap guard", () => {
  const down = (at: string) => ({ source: "tick", kind: "service.down", severity: "critical" as const, title: "Loom is down", jobId: "service:loom", at });
  const up = (at: string) => ({ source: "tick", kind: "service.up", severity: "recovery" as const, title: "Loom is up", jobId: "service:loom", at });

  function flapping() {
    const l = tempLedger();
    // Open and recover five times inside an hour: the last reopening flaps.
    for (let i = 0; i < 5; i += 1) {
      recordEvent(l, down(minutesAgo(50 - i * 10)));
      recordEvent(l, up(minutesAgo(48 - i * 10)));
    }
    return l;
  }

  it("holds a recovery inside the window and releases it once the window passes", () => {
    const l = flapping();
    const [inc] = listIncidents(l);
    expect(inc?.flapping).toBe(true);
    expect(releaseHeldRecoveries(l, new Date().toISOString())).toBe(0);

    const later = new Date(Date.now() + 61 * 60_000).toISOString();
    expect(releaseHeldRecoveries(l, later)).toBe(1);
    expect(listIncidents(l)).toHaveLength(0);
  });

  it("drops a held recovery when the failure comes back", () => {
    const l = flapping();
    recordEvent(l, down(new Date().toISOString()));
    const later = new Date(Date.now() + 61 * 60_000).toISOString();
    expect(releaseHeldRecoveries(l, later)).toBe(0);
    expect(listIncidents(l)).toHaveLength(1);
  });
});
