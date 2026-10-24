import { describe, expect, it } from "vitest";
import {
  incidentRoute,
  listEvents,
  listIncidents,
  markNotified,
  pendingNotifications,
  recordEvent,
  scheduleReminders,
  setIncidentStatus,
  takeDeskNotifications,
} from "../src/incidents.js";
import { upsertJob } from "../src/jobs.js";
import { minutesAgo, tempLedger } from "./helpers.js";

const fail = (at?: string, title = "Backup failed (exit 1)", severity: "error" | "critical" | "warning" = "error") => ({
  source: "test",
  kind: "run.failed",
  severity,
  title,
  jobId: "launchd:com.example.backup",
  at,
});
const recover = (at?: string) => ({ source: "test", kind: "run.ok", severity: "recovery" as const, title: "Backup recovered", jobId: "launchd:com.example.backup", at });

function pending(l: ReturnType<typeof tempLedger>, id: number): string | null {
  return (l.db.prepare("SELECT notify_pending FROM incidents WHERE id = ?").get(id) as { notify_pending: string | null }).notify_pending;
}

describe("recordEvent folding", () => {
  it("folds repeats into one incident and counts them", () => {
    const l = tempLedger();
    const a = recordEvent(l, fail(undefined, "Backup failed (exit 1)"));
    const b = recordEvent(l, fail(undefined, "Backup failed (exit 2)"));
    expect(a.incidentId).not.toBeNull();
    expect(b.incidentId).toBe(a.incidentId);
    const [inc] = listIncidents(l);
    expect(inc!.count).toBe(2);
    expect(listEvents(l)).toHaveLength(2);
    expect(pending(l, inc!.id)).toBe("opened");
  });

  it("escalates severity and marks the transition", () => {
    const l = tempLedger();
    const a = recordEvent(l, fail());
    markNotified(l, a.incidentId!);
    recordEvent(l, fail(undefined, undefined, "critical"));
    const [inc] = listIncidents(l);
    expect(inc!.severity).toBe("critical");
    expect(pending(l, inc!.id)).toBe("escalated");
    // A lower severity later does not lower it.
    recordEvent(l, fail(undefined, undefined, "warning"));
    expect(listIncidents(l)[0]!.severity).toBe("critical");
  });

  it("keeps an unsent 'opened' instead of replacing it with 'escalated'", () => {
    const l = tempLedger();
    const a = recordEvent(l, fail());
    recordEvent(l, fail(undefined, undefined, "critical"));
    expect(pending(l, a.incidentId!)).toBe("opened");
  });

  it("a recovery resolves the job's open failure and is stored", () => {
    const l = tempLedger();
    const a = recordEvent(l, fail());
    const r = recordEvent(l, recover());
    expect(r.incidentId).toBe(a.incidentId);
    expect(listIncidents(l)).toHaveLength(0);
    expect(listIncidents(l, { status: "all" })[0]!.status).toBe("resolved");
    expect(listEvents(l)[0]!.severity).toBe("recovery");
  });

  it("a recovery with no open incident only stores the event", () => {
    const l = tempLedger();
    const r = recordEvent(l, recover());
    expect(r.incidentId).toBeNull();
    expect(listIncidents(l, { status: "all" })).toHaveLength(0);
    expect(listEvents(l)).toHaveLength(1);
  });

  it("service.up resolves service.down for the same job", () => {
    const l = tempLedger();
    recordEvent(l, { source: "tick", kind: "service.down", severity: "critical", title: "Bot is down", jobId: "service:bot" });
    recordEvent(l, { source: "tick", kind: "run.failed", severity: "error", title: "other", jobId: "service:bot" });
    recordEvent(l, { source: "tick", kind: "service.up", severity: "recovery", title: "Bot is back", jobId: "service:bot" });
    const open = listIncidents(l);
    expect(open).toHaveLength(1);
    expect(open[0]!.title).toBe("other");
  });

  it("marks a reopening within 7 days as regressed and counts reopenings", () => {
    const l = tempLedger();
    recordEvent(l, fail(minutesAgo(600)));
    recordEvent(l, recover(minutesAgo(590)));
    const again = recordEvent(l, fail(minutesAgo(10)));
    const inc = listIncidents(l)[0]!;
    expect(inc.id).toBe(again.incidentId);
    expect(inc.regressed).toBe(true);
    expect(inc.reopenCount).toBe(1);
    expect(pending(l, inc.id)).toBe("regressed");
  });

  it("does not mark a reopening after 7 days as regressed", () => {
    const l = tempLedger();
    recordEvent(l, fail(minutesAgo(8 * 1440 + 10)));
    recordEvent(l, recover(minutesAgo(8 * 1440)));
    recordEvent(l, fail());
    const inc = listIncidents(l)[0]!;
    expect(inc.regressed).toBe(false);
    expect(pending(l, inc.id)).toBe("opened");
  });

  it("flap guard: more than 3 reopenings in an hour sets flapping and holds auto-resolve for an hour", () => {
    const l = tempLedger();
    let t = 50;
    for (let i = 0; i < 5; i++) {
      recordEvent(l, fail(minutesAgo(t)));
      recordEvent(l, recover(minutesAgo(t - 1)));
      t -= 5;
    }
    const last = recordEvent(l, fail(minutesAgo(5)));
    const inc = listIncidents(l).find((x) => x.id === last.incidentId)!;
    expect(inc.flapping).toBe(true);
    // A success right away does not resolve it…
    recordEvent(l, recover(minutesAgo(4)));
    expect(listIncidents(l).map((x) => x.id)).toContain(inc.id);
    // …a success an hour after the last failure does.
    recordEvent(l, recover(new Date(Date.parse(inc.lastSeen) + 61 * 60_000).toISOString()));
    expect(listIncidents(l).map((x) => x.id)).not.toContain(inc.id);
  });
});

describe("notification transitions", () => {
  it("routes by job criticality and severity", () => {
    const l = tempLedger();
    upsertJob(l, { id: "launchd:com.example.crit", runner: "launchd", name: "Crit", criticality: "critical" });
    upsertJob(l, { id: "launchd:com.example.quiet", runner: "launchd", name: "Quiet", criticality: "quiet" });
    upsertJob(l, { id: "launchd:com.example.norm", runner: "launchd", name: "Norm" });
    const mk = (jobId: string, severity: "error" | "critical" | "info" = "error") => {
      const { incidentId } = recordEvent(l, { source: "t", kind: "run.failed", severity, title: `${jobId} failed`, jobId });
      return listIncidents(l, { status: "all" }).find((i) => i.id === incidentId)!;
    };
    expect(incidentRoute(l, mk("launchd:com.example.crit"))).toBe("critical");
    expect(incidentRoute(l, mk("launchd:com.example.quiet", "critical"))).toBe("quiet");
    expect(incidentRoute(l, mk("launchd:com.example.norm"))).toBe("normal");
    expect(incidentRoute(l, mk("service:bot", "critical"))).toBe("critical");
    expect(incidentRoute(l, mk("service:x", "info"))).toBe("quiet");
  });

  it("critical reminders every 4 h, none while acked or muted", () => {
    const l = tempLedger();
    const { incidentId } = recordEvent(l, { source: "t", kind: "service.down", severity: "critical", title: "Bot is down", jobId: "service:bot" });
    const id = incidentId!;
    expect(pendingNotifications(l, "critical").map((p) => p.transition)).toEqual(["opened"]);
    markNotified(l, id, minutesAgo(5 * 60));
    scheduleReminders(l);
    expect(pendingNotifications(l, "critical").map((p) => p.transition)).toEqual(["reminder"]);
    markNotified(l, id, minutesAgo(60));
    scheduleReminders(l);
    expect(pendingNotifications(l, "critical")).toHaveLength(0);

    markNotified(l, id, minutesAgo(5 * 60));
    setIncidentStatus(l, id, "acked");
    scheduleReminders(l);
    expect(pendingNotifications(l, "critical")).toHaveLength(0);

    setIncidentStatus(l, id, "muted");
    recordEvent(l, { source: "t", kind: "service.down", severity: "critical", title: "Bot is down", jobId: "service:bot" });
    recordEvent(l, { source: "t", kind: "service.up", severity: "recovery", title: "Bot is back", jobId: "service:bot" });
    // Muted incidents send nothing, not even resolved.
    expect(pendingNotifications(l, "critical")).toHaveLength(0);
  });

  it("an acked incident still reports escalation and resolution", () => {
    const l = tempLedger();
    const { incidentId } = recordEvent(l, { source: "t", kind: "service.down", severity: "error", title: "Bot is down", jobId: "service:bot" });
    markNotified(l, incidentId!);
    setIncidentStatus(l, incidentId!, "acked");
    recordEvent(l, { source: "t", kind: "service.down", severity: "critical", title: "Bot is down", jobId: "service:bot" });
    expect(pendingNotifications(l, "critical").map((p) => p.transition)).toEqual(["escalated"]);
    markNotified(l, incidentId!);
    recordEvent(l, { source: "t", kind: "service.up", severity: "recovery", title: "Bot is back", jobId: "service:bot" });
    expect(pendingNotifications(l, "critical").map((p) => p.transition)).toEqual(["resolved"]);
  });

  it("snooze holds transitions until it runs out, then reminds", () => {
    const l = tempLedger();
    const { incidentId } = recordEvent(l, { source: "t", kind: "service.down", severity: "critical", title: "Bot is down", jobId: "service:bot" });
    markNotified(l, incidentId!, minutesAgo(10));
    setIncidentStatus(l, incidentId!, "snoozed", { until: new Date(Date.now() + 3_600_000).toISOString() });
    recordEvent(l, { source: "t", kind: "service.down", severity: "critical", title: "Bot is down", jobId: "service:bot" });
    scheduleReminders(l);
    expect(pendingNotifications(l, "critical")).toHaveLength(0);
    // Snooze runs out.
    l.db.prepare("UPDATE incidents SET snoozed_until = ? WHERE id = ?").run(minutesAgo(1), incidentId!);
    scheduleReminders(l);
    const p = pendingNotifications(l, "critical");
    expect(p.map((x) => x.transition)).toEqual(["reminder"]);
    expect(p[0]!.incident.status).toBe("open");
  });

  it("resolving an incident nobody was told about sends nothing", () => {
    const l = tempLedger();
    recordEvent(l, { source: "t", kind: "service.down", severity: "critical", title: "Bot is down", jobId: "service:bot" });
    recordEvent(l, { source: "t", kind: "service.up", severity: "recovery", title: "Bot is back", jobId: "service:bot" });
    expect(pendingNotifications(l, "critical")).toHaveLength(0);
  });

  it("takeDeskNotifications returns normal transitions once, with 24 h reminders", () => {
    const l = tempLedger();
    upsertJob(l, { id: "launchd:com.example.norm", runner: "launchd", name: "Norm" });
    const { incidentId } = recordEvent(l, { source: "t", kind: "run.failed", severity: "error", title: "Norm failed", jobId: "launchd:com.example.norm" });
    recordEvent(l, { source: "t", kind: "service.down", severity: "critical", title: "Bot is down", jobId: "service:bot" });
    const first = takeDeskNotifications(l);
    expect(first.map((p) => [p.incident.id, p.transition])).toEqual([[incidentId, "opened"]]);
    expect(takeDeskNotifications(l)).toHaveLength(0);
    l.db.prepare("UPDATE incidents SET notified_at = ? WHERE id = ?").run(minutesAgo(25 * 60), incidentId!);
    expect(takeDeskNotifications(l).map((p) => p.transition)).toEqual(["reminder"]);
    // The critical one is still waiting for the tick's Discord sender.
    expect(pendingNotifications(l, "critical")).toHaveLength(1);
  });

  it("quiet incidents never notify", () => {
    const l = tempLedger();
    upsertJob(l, { id: "launchd:com.example.quiet", runner: "launchd", name: "Q", criticality: "quiet" });
    recordEvent(l, { source: "t", kind: "job.late", severity: "warning", title: "Q is late", jobId: "launchd:com.example.quiet" });
    expect(takeDeskNotifications(l)).toHaveLength(0);
    expect(pendingNotifications(l, "critical")).toHaveLength(0);
    expect((l.db.prepare("SELECT COUNT(*) AS n FROM incidents WHERE notify_pending IS NOT NULL").get() as { n: number }).n).toBe(0);
  });
});
