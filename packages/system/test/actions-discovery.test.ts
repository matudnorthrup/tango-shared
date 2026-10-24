import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { archiveDir, jobAction, stopProcess } from "../src/actions.js";
import { discoverLaunchd } from "../src/discovery/launchd.js";
import { discoverServer } from "../src/discovery/server.js";
import { discoverTmux } from "../src/discovery/tmux.js";
import { listEvents, listIncidents, recordEvent } from "../src/incidents.js";
import { getJob, listRuns, upsertJob } from "../src/jobs.js";
import { rotateLog } from "../src/logs.js";
import { notifyCritical } from "../src/notify.js";
import { readHealth, systemSummary } from "../src/summary.js";
import { runTick } from "../src/tick.js";
import { annotations, fakeCtx, fakeExec, fakeFetch, fail, ok, tempDir, tempLedger } from "./helpers.js";

describe("launchd discovery", () => {
  it("finds loaded and booted-out agents by prefix and infers runs from the runs counter", async () => {
    const l = tempLedger();
    const ctx = fakeCtx();
    const agents = join(ctx.homeDir, "Library", "LaunchAgents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "com.example.backup.plist"), "<plist/>");
    writeFileSync(join(agents, "com.example.off.plist"), "<plist/>");
    writeFileSync(join(agents, "org.other.thing.plist"), "<plist/>");
    let runs = 4;
    let lastExit = 0;
    ctx.exec = fakeExec({
      "launchctl list": ok("PID\tStatus\tLabel\n-\t0\tcom.example.backup\n-\t0\torg.other.thing\n"),
      "launchctl print gui/501/com.example.backup": () => ok(`gui/501/com.example.backup = {\n\tpath = ${join(agents, "com.example.backup.plist")}\n\tstate = not running\n\truns = ${runs}\n\tlast exit code = ${lastExit}\n}`),
      plutil: (args) =>
        ok(JSON.stringify(args.at(-1)!.includes("backup") ? { Label: "com.example.backup", StartInterval: 3600, StandardOutPath: "/tmp/backup.log" } : { Label: "com.example.off", RunAtLoad: true })),
    });
    const input = { ctx, prev: (id: string) => getJob(l, id) };
    const store = async () => {
      const r = await discoverLaunchd(input);
      for (const j of r.jobs) upsertJob(l, j);
      return r;
    };
    const first = await store();
    expect(first.jobs.map((j) => [j.id, j.state, j.cadence])).toEqual([
      ["launchd:com.example.backup", "active", "Hourly"],
      ["launchd:com.example.off", "paused", "At boot"],
    ]);
    expect(first.effects).toHaveLength(0);
    runs = 5;
    lastExit = 1;
    const second = await store();
    expect(second.effects).toHaveLength(1);
    expect(second.effects[0]).toMatchObject({ type: "run", run: { jobId: "launchd:com.example.backup", status: "failed", exitCode: 1 } });
    expect(getJob(l, "launchd:com.example.backup")!.logs).toEqual(["/tmp/backup.log"]);
  });
});

describe("launchd plist cache", () => {
  it("parses an unchanged plist once across ticks", async () => {
    const l = tempLedger();
    const ctx = fakeCtx();
    const agents = join(ctx.homeDir, "Library", "LaunchAgents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "com.example.backup.plist"), "<plist/>");
    ctx.exec = fakeExec({
      "launchctl list": ok("PID\tStatus\tLabel\n-\t0\tcom.example.backup\n"),
      "launchctl print": () => ok("state = not running\n\truns = 1\n"),
      plutil: () => ok(JSON.stringify({ Label: "com.example.backup", StartInterval: 3600 })),
    });
    const plistCache = new Map();
    const plutilCalls = () => (ctx.exec as unknown as { calls: string[][] }).calls.filter((c) => c[0] === "plutil").length;
    await discoverLaunchd({ ctx, prev: (id) => getJob(l, id), plistCache });
    const first = plutilCalls();
    await discoverLaunchd({ ctx, prev: (id) => getJob(l, id), plistCache });
    expect(first).toBeGreaterThan(0);
    expect(plutilCalls()).toBe(first);
  });
});

describe("tmux discovery", () => {
  it("reports a missing window and its return, and repeated restarts", async () => {
    const l = tempLedger();
    let panes = "web|100|0|node\n";
    let child = 200;
    const ctx = fakeCtx({ annotations: annotations({ tmux: { socket: "/tmp/s", session: "main" } }) });
    ctx.exec = fakeExec({ "tmux -S /tmp/s list-panes": () => ok(panes) });
    const startup = async () => ({ services: [{ id: "web", name: "Web" }, { id: "api", name: "API" }], tmux: {}, defaultConfigPath: "/d", profileConfigPath: "/p" });
    const step = async () => {
      const r = await discoverTmux({ ctx, prev: (id) => getJob(l, id), processes: [{ pid: child, ppid: 100, uid: 501, started: "x", cpu: 0, command: "node" }] }, startup);
      for (const j of r.jobs) upsertJob(l, j);
      return r.effects.map((e) => (e.type === "event" ? `${e.event.jobId} ${e.event.kind}` : "run"));
    };
    expect(await step()).toEqual(["tmux:api service.down"]);
    panes = "web|100|0|node\napi|101|0|node\n";
    expect(await step()).toEqual(["tmux:api service.up"]);
    const restarts: string[][] = [];
    for (let i = 0; i < 3; i++) {
      child += 1;
      restarts.push(await step());
    }
    expect(restarts.flat()).toEqual(["tmux:web job.restarting"]);
    expect(getJob(l, "tmux:web")!.facts.restarting).toBe(true);

    // tmux not answering is no reading: the verdict stays, so the later recovery still fires.
    ctx.exec = fakeExec({ "tmux -S /tmp/s list-panes": () => fail(1, "no server") });
    await step();
    expect(getJob(l, "tmux:web")!.facts.restarting).toBe(true);
  });

  it("reads a missing socket as no tmux server, so a moved service shows as paused, not unanswered", async () => {
    const l = tempLedger();
    const ctx = fakeCtx({ annotations: annotations({ tmux: { socket: "/tmp/sys-no-such-socket", session: "main" } }) });
    ctx.exec = fakeExec({ "tmux -S /tmp/sys-no-such-socket list-panes": () => fail(1, "error connecting to /tmp/sys-no-such-socket (No such file or directory)") });
    const startup = async () => ({ services: [{ id: "web", name: "Web", enabled: false }, { id: "api", name: "API" }], tmux: {}, defaultConfigPath: "/d", profileConfigPath: "/p" });
    const r = await discoverTmux({ ctx, prev: (id) => getJob(l, id), processes: [] }, startup);
    expect(r.complete).toBe(true);
    expect(r.note).toBeUndefined();
    // A service still configured for tmux is down when no tmux server is running.
    expect(r.effects.map((e) => (e.type === "event" ? `${e.event.jobId} ${e.event.kind}` : "run"))).toEqual(["tmux:api service.down"]);
    expect(r.jobs.find((j) => j.id === "tmux:web")!.state).toBe("paused");
  });

  it("does not count a tick with no process list (ps timed out) as a restart", async () => {
    const l = tempLedger();
    const ctx = fakeCtx({ annotations: annotations({ tmux: { socket: "/tmp/s", session: "main" } }) });
    ctx.exec = fakeExec({ "tmux -S /tmp/s list-panes": () => ok("web|100|0|node\n") });
    const startup = async () => ({ services: [{ id: "web", name: "Web" }], tmux: {}, defaultConfigPath: "/d", profileConfigPath: "/p" });
    const events: string[] = [];
    for (let i = 0; i < 6; i++) {
      // The tick passes [] when ps fails; undefined when it never ran.
      const processes = i % 2 === 0 ? [{ pid: 200, ppid: 100, uid: 501, started: "x", cpu: 0, command: "node" }] : i % 4 === 1 ? [] : undefined;
      const r = await discoverTmux({ ctx, prev: (id) => getJob(l, id), processes }, startup);
      for (const j of r.jobs) upsertJob(l, j);
      for (const e of r.effects) if (e.type === "event") events.push(e.event.kind);
    }
    expect(events).toEqual([]);
    expect(getJob(l, "tmux:web")!.facts.restarting).toBe(false);
  });
});

describe("Tango Server discovery", () => {
  const body = (services: unknown[]) => JSON.stringify({ services });
  it("lists services as server jobs and closes a restarting incident once the child stays up", async () => {
    const l = tempLedger();
    let since = "2026-10-20T12:00:00.000Z";
    let now = new Date("2026-10-20T12:05:00.000Z");
    const fetch = fakeFetch(() => ({ status: 200, text: body([{ id: "web", name: "Web", group: "Apps", mode: "managed", state: "running", pid: 42, since, restarts: 3, health: { ok: true, detail: "ok" } }, { id: "loom", name: "Loom", mode: "observe", state: "failing", pid: null, since }]) }));
    const ctx = fakeCtx({ fetch, now: () => now });
    const step = async () => {
      const r = await discoverServer({ ctx, prev: (id) => getJob(l, id) }, () => "tok");
      for (const j of r.jobs) upsertJob(l, j);
      return r;
    };
    const first = await step();
    expect(first.complete).toBe(true);
    expect(fetch.calls[0].url).toBe("http://127.0.0.1:9440/services");
    expect(first.jobs.map((j) => `${j.id} ${j.lastStatus}`)).toEqual(["server:web running", "server:loom failed"]);
    expect(first.effects).toEqual([]);
    now = new Date("2026-10-20T12:11:00.000Z");
    expect((await step()).effects.map((e) => (e.type === "event" ? `${e.event.jobId} ${e.event.kind}` : "run"))).toEqual(["server:web job.stable"]);
    // Once is enough while it stays up; a new child starts the clock again.
    expect((await step()).effects).toEqual([]);
    since = "2026-10-20T12:12:00.000Z";
    now = new Date("2026-10-20T12:13:00.000Z");
    expect((await step()).effects).toEqual([]);
    now = new Date("2026-10-20T12:23:00.000Z");
    expect((await step()).effects).toHaveLength(1);
  });

  it("drops a service Tango Server no longer lists, and closes its incidents", async () => {
    const l = tempLedger();
    const dir = tempDir();
    writeFileSync(join(dir, "token"), "tok");
    const prevHome = process.env.TANGO_SERVER_HOME;
    process.env.TANGO_SERVER_HOME = dir;
    try {
      let services: unknown[] = [{ id: "web", name: "Web", state: "failing" }];
      const ctx = fakeCtx({ fetch: fakeFetch(() => ({ status: 200, text: body(services) })) });
      await runTick(l, { ctx, runners: ["server"], noNotify: true, noActions: true });
      expect(getJob(l, "server:web")).not.toBeNull();
      recordEvent(l, { source: "tango-server", kind: "service.down", severity: "error", title: "Web is down", jobId: "server:web" });
      services = [];
      await runTick(l, { ctx, runners: ["server"], noNotify: true, noActions: true });
      expect(getJob(l, "server:web")).toBeNull();
      expect(listIncidents(l, { status: "active", jobId: "server:web" })).toEqual([]);
    } finally {
      if (prevHome === undefined) delete process.env.TANGO_SERVER_HOME;
      else process.env.TANGO_SERVER_HOME = prevHome;
    }
  });

  it("is no reading without a token or an answer", async () => {
    const ctx = fakeCtx();
    expect((await discoverServer({ ctx, prev: () => null }, () => null)).complete).toBe(false);
    const r = await discoverServer({ ctx, prev: () => null }, () => "tok");
    expect(r.complete).toBe(false);
    expect(r.note).toBe("offline");
  });
});

describe("tick", () => {
  it("past the hard budget stops reading but still notifies and times each step", async () => {
    const l = tempLedger();
    const report = await runTick(l, { ctx: fakeCtx(), runners: ["launchd"] as never[], noNotify: true, hardBudgetMs: -1 });
    expect(report.notes).toContain("discover: skipped (over the hard tick budget)");
    expect(report.discovered).toEqual({});
    expect(report.notes.some((n) => n.includes("over the hard tick budget"))).toBe(true);
    expect(report.steps).toHaveProperty("notify");
    expect(report.steps).not.toHaveProperty("probe");
  });

  it("probes services, records down after two failed probes and up on return, and never posts with noNotify", async () => {
    const l = tempLedger();
    let botUp = false;
    const fetch = fakeFetch((url) => (url.includes("9200") ? (botUp ? { status: 200, text: "{}" } : { error: "ECONNREFUSED" }) : { error: "unexpected" }));
    const ctx = fakeCtx({ annotations: annotations({ services: [{ id: "bot", name: "Bot", url: "http://127.0.0.1:9200/status/work", critical: true }] }), fetch });
    const opts = { ctx, runners: [] as never[], noNotify: true, skipSteps: ["ingest", "unmanaged", "disk", "logs", "prune"] as never[] };
    await runTick(l, opts);
    expect(listIncidents(l)).toHaveLength(0);
    // One miss shows as slow, not down, on the page's health strip.
    expect(readHealth(l)!.services[0]).toMatchObject({ ok: true, detail: expect.stringContaining("slow to answer") });
    await runTick(l, opts);
    expect(readHealth(l)!.services[0]!.ok).toBe(false);
    expect(listIncidents(l).map((i) => [i.title, i.severity])).toEqual([["Bot is down", "critical"]]);
    expect(systemSummary(l).line).toBe("1 critical problem needs you.");
    expect(fetch.calls.some((c) => c.url.includes("discord.com"))).toBe(false);
    botUp = true;
    await runTick(l, opts);
    expect(listIncidents(l)).toHaveLength(0);
    expect(systemSummary(l).line).toBe("All clear.");
  });

  it("posts critical transitions to Discord once each", async () => {
    const l = tempLedger();
    const fetch = fakeFetch((url) => (url.includes("discord.com") ? { status: 200, text: "{}" } : { error: "x" }));
    const ctx = fakeCtx({ fetch });
    const { recordEvent } = await import("../src/incidents.js");
    recordEvent(l, { source: "t", kind: "service.down", severity: "critical", title: "Bot is down", jobId: "service:bot" });
    expect(await notifyCritical(l, ctx, { target: { token: "t", channelId: "c" } })).toMatchObject({ sent: 1 });
    expect(await notifyCritical(l, ctx, { target: { token: "t", channelId: "c" } })).toMatchObject({ sent: 0 });
    const body = JSON.parse(String(fetch.calls[0]!.init!.body)) as { content: string };
    expect(body.content).toContain("🛰️");
    expect(body.content).toContain("Bot is down");
  });

  it("skips when another tick holds the lock", async () => {
    const l = tempLedger();
    l.db.prepare("INSERT INTO cursors(name, value) VALUES('tick.lock', ?)").run(JSON.stringify({ pid: process.ppid, at: new Date().toISOString() }));
    const r = await runTick(l, { ctx: fakeCtx(), runners: [] });
    expect(r.skipped).toMatch(/lock/);
  });

  it("flags large logs and rotates only when actions are allowed", async () => {
    const dir = tempDir();
    const log = join(dir, "big.log");
    writeFileSync(log, Buffer.alloc(101 * 1024 * 1024, 97));
    const l = tempLedger();
    upsertJob(l, { id: "launchd:com.example.job", runner: "launchd", name: "Job", logs: [log] });
    const skip = ["ingest", "probe", "unmanaged", "late", "notify", "prune"] as never[];
    await runTick(l, { ctx: fakeCtx(), runners: [], noActions: true, skipSteps: skip });
    expect(statSync(log).size).toBe(101 * 1024 * 1024);
    expect(listEvents(l).map((e) => e.kind)).toEqual(["log.large"]);
    await runTick(l, { ctx: fakeCtx(), runners: [], skipSteps: skip });
    expect(statSync(log).size).toBe(0);
    expect(existsSync(`${log}.1.gz`)).toBe(true);
    expect(listIncidents(l)).toHaveLength(0);
  }, 60_000);

  it("rotateLog keeps three generations", async () => {
    const dir = tempDir();
    const log = join(dir, "a.log");
    for (let i = 0; i < 5; i++) {
      writeFileSync(log, `gen ${i}`);
      await rotateLog(log);
    }
    expect([1, 2, 3, 4].map((n) => existsSync(`${log}.${n}.gz`))).toEqual([true, true, true, false]);
  });
});

describe("job actions", () => {
  it("refuses critical jobs without force", async () => {
    const l = tempLedger();
    upsertJob(l, { id: "launchd:com.example.core", runner: "launchd", name: "Core", criticality: "critical" });
    const ctx = fakeCtx({ exec: fakeExec({ launchctl: ok() }) });
    const r = await jobAction(l, "launchd:com.example.core", "pause", {}, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/critical/);
    expect((await jobAction(l, "launchd:com.example.core", "pause", { force: true }, ctx)).ok).toBe(true);
  });

  it("launchd retire boots out, moves the plist to the archive, and restore puts it back", async () => {
    const l = tempLedger();
    const ctx = fakeCtx();
    const exec = fakeExec({ "launchctl bootout": ok(), "launchctl bootstrap": ok(), "launchctl disable": ok(), "launchctl enable": ok() });
    ctx.exec = exec;
    const plist = join(ctx.homeDir, "Library", "LaunchAgents", "com.example.old.plist");
    mkdirSync(join(ctx.homeDir, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plist, "<plist/>");
    upsertJob(l, { id: "launchd:com.example.old", runner: "launchd", name: "Old", source: plist, facts: { loaded: true } });
    const r = await jobAction(l, "launchd:com.example.old", "retire", { reason: "unused" }, ctx);
    expect(r.ok).toBe(true);
    const job = getJob(l, "launchd:com.example.old")!;
    expect(job.state).toBe("retired");
    expect(job.retireReason).toBe("unused");
    expect(job.archivePath).toBe(join(archiveDir(ctx), "com.example.old.plist"));
    expect(existsSync(plist)).toBe(false);
    expect(existsSync(job.archivePath!)).toBe(true);
    // Disabled as well as booted out, so it stays off after the next login.
    expect(exec.calls.map((c) => c.slice(0, 2).join(" "))).toEqual(["launchctl bootout", "launchctl disable"]);
    const back = await jobAction(l, "launchd:com.example.old", "restore", {}, ctx);
    expect(back.ok).toBe(true);
    expect(existsSync(plist)).toBe(true);
    expect(getJob(l, "launchd:com.example.old")!.state).toBe("active");
    expect(exec.calls.slice(-2)).toEqual([["launchctl", "enable", "gui/501/com.example.old"], ["launchctl", "bootstrap", "gui/501", plist]]);
  });

  it("schedule retire writes a profile overlay with enabled: false, or moves a profile-only YAML", async () => {
    const l = tempLedger();
    const ctx = fakeCtx({ fetch: fakeFetch(() => ({ status: 200, text: '{"ok":true}' })) });
    mkdirSync(join(ctx.repoDir, "config", "defaults", "schedules"), { recursive: true });
    writeFileSync(join(ctx.repoDir, "config", "defaults", "schedules", "brief.yaml"), "id: brief\nenabled: true\n");
    const profileSchedules = join(ctx.profileDir, "config", "schedules");
    mkdirSync(profileSchedules, { recursive: true });
    writeFileSync(join(profileSchedules, "mine.yaml"), "id: mine\nenabled: true\ndescription: profile only\n");
    upsertJob(l, { id: "schedule:brief", runner: "schedule", name: "Brief" });
    upsertJob(l, { id: "schedule:mine", runner: "schedule", name: "Mine" });

    expect((await jobAction(l, "schedule:brief", "retire", {}, ctx)).ok).toBe(true);
    const overlay = join(profileSchedules, "brief.yaml");
    expect(yaml.load(readFileSync(overlay, "utf8"))).toEqual({ id: "brief", enabled: false });
    expect((await jobAction(l, "schedule:mine", "retire", {}, ctx)).ok).toBe(true);
    expect(existsSync(join(profileSchedules, "mine.yaml"))).toBe(false);
    expect(existsSync(join(archiveDir(ctx), "mine.yaml"))).toBe(true);

    expect((await jobAction(l, "schedule:brief", "restore", {}, ctx)).ok).toBe(true);
    expect(existsSync(overlay)).toBe(false);
    expect((await jobAction(l, "schedule:mine", "restore", {}, ctx)).ok).toBe(true);
    expect(existsSync(join(profileSchedules, "mine.yaml"))).toBe(true);
    const urls = (ctx.fetch as ReturnType<typeof fakeFetch>).calls.map((c) => c.url);
    expect(urls).toContain("http://127.0.0.1:9200/schedules/brief/pause");
    expect(urls).toContain("http://127.0.0.1:9200/schedules/brief/resume");
  });

  it("schedule retire edits an existing profile overlay and restore reverts it", async () => {
    const l = tempLedger();
    const ctx = fakeCtx({ fetch: fakeFetch(() => ({ error: "bot down" })) });
    mkdirSync(join(ctx.repoDir, "config", "defaults", "schedules"), { recursive: true });
    writeFileSync(join(ctx.repoDir, "config", "defaults", "schedules", "brief.yaml"), "id: brief\nenabled: true\n");
    const file = join(ctx.profileDir, "config", "schedules", "brief-overlay.yaml");
    mkdirSync(join(ctx.profileDir, "config", "schedules"), { recursive: true });
    writeFileSync(file, "id: brief\ndelivery:\n  channel_id: '1'\n");
    upsertJob(l, { id: "schedule:brief", runner: "schedule", name: "Brief" });
    const r = await jobAction(l, "schedule:brief", "retire", {}, ctx);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/could not pause/);
    expect(yaml.load(readFileSync(file, "utf8"))).toEqual({ id: "brief", delivery: { channel_id: "1" }, enabled: false });
    await jobAction(l, "schedule:brief", "restore", {}, ctx);
    expect(yaml.load(readFileSync(file, "utf8"))).toEqual({ id: "brief", delivery: { channel_id: "1" } });
  });

  it("tmux retire disables the service in the profile startup config", async () => {
    const l = tempLedger();
    const ctx = fakeCtx({ exec: fakeExec({ tmux: ok() }) });
    const startup = join(ctx.profileDir, "config", "startup.yaml");
    mkdirSync(join(ctx.profileDir, "config"), { recursive: true });
    writeFileSync(startup, "services:\n  - id: other\n    enabled: true\n");
    upsertJob(l, { id: "tmux:web", runner: "tmux", name: "Web", facts: { alive: true, window: "web", configured: true } });
    expect((await jobAction(l, "tmux:web", "retire", {}, ctx)).ok).toBe(true);
    expect((yaml.load(readFileSync(startup, "utf8")) as { services: unknown[] }).services).toEqual([{ id: "other", enabled: true }, { id: "web", enabled: false }]);
    expect(existsSync(join(archiveDir(ctx), "startup.yaml.before-retire"))).toBe(true);
    ctx.exec = fakeExec({ [join(ctx.repoDir, "scripts", "startup.sh")]: ok() });
    expect((await jobAction(l, "tmux:web", "restore", {}, ctx)).ok).toBe(true);
    expect((yaml.load(readFileSync(startup, "utf8")) as { services: unknown[] }).services).toEqual([{ id: "other", enabled: true }]);
  });

  it("routine retire moves the folder", async () => {
    const l = tempLedger();
    const ctx = fakeCtx();
    const folder = join(ctx.routinesDir, "cleanup");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "SKILL.md"), "---\nname: cleanup\n---\n");
    upsertJob(l, { id: "routine:cleanup", runner: "routine", name: "cleanup", source: join(folder, "SKILL.md"), facts: { folder } });
    expect((await jobAction(l, "routine:cleanup", "retire", {}, ctx)).ok).toBe(true);
    expect(existsSync(folder)).toBe(false);
    expect(existsSync(join(archiveDir(ctx), "cleanup", "SKILL.md"))).toBe(true);
  });

  it("stopProcess re-verifies ppid and start time before signalling", async () => {
    const l = tempLedger();
    upsertJob(l, { id: "launchd:unmanaged-4242", runner: "launchd", name: "node x", managed: false, facts: { pid: 4242, startedAt: "Sun Oct 18 07:01:02 2026" } });
    const signals: string[] = [];
    let alive = true;
    const psLine = (ppid: number, started: string) => ok(`  PID  PPID   UID STARTED                       %CPU COMMAND\n 4242 ${ppid} 501 ${started}  0.0 node x\n`);
    const ctx = fakeCtx({
      kill: (_pid, sig) => {
        signals.push(String(sig));
        if (sig === "SIGTERM") alive = false;
      },
    });
    // Different start time: refuse.
    ctx.exec = fakeExec({ ps: psLine(1, "Mon Oct 19 07:01:02 2026") });
    expect((await stopProcess(l, "launchd:unmanaged-4242", ctx)).ok).toBe(false);
    // Re-parented elsewhere: refuse.
    ctx.exec = fakeExec({ ps: psLine(77, "Sun Oct 18 07:01:02 2026") });
    expect((await stopProcess(l, "launchd:unmanaged-4242", ctx)).ok).toBe(false);
    expect(signals).toEqual([]);
    // Same process: SIGTERM, and it exits.
    ctx.exec = fakeExec({ ps: () => (alive ? psLine(1, "Sun Oct 18 07:01:02 2026") : ok("  PID  PPID\n")) });
    const r = await stopProcess(l, "launchd:unmanaged-4242", ctx);
    expect(r.ok).toBe(true);
    expect(signals).toEqual(["SIGTERM"]);
    expect(getJob(l, "launchd:unmanaged-4242")).toBeNull();
  });

  it("stopProcess sends SIGKILL after 10 s when SIGTERM is ignored", async () => {
    const l = tempLedger();
    upsertJob(l, { id: "launchd:unmanaged-5", runner: "launchd", name: "stubborn", managed: false, facts: { pid: 5, startedAt: "Sun Oct 18 07:01:02 2026" } });
    const signals: string[] = [];
    const ctx = fakeCtx({ kill: (_p, s) => void signals.push(String(s)), exec: fakeExec({ ps: ok(" 5 1 501 Sun Oct 18 07:01:02 2026 0.0 x\n") }) });
    expect((await stopProcess(l, "launchd:unmanaged-5", ctx)).ok).toBe(true);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("unsupported actions say so", async () => {
    const l = tempLedger();
    upsertJob(l, { id: "loom-wait:abc", runner: "loom-wait", name: "w" });
    const r = await jobAction(l, "loom-wait:abc", "pause", {}, fakeCtx({ exec: fakeExec({ x: fail() }) }));
    expect(r.ok).toBe(false);
    expect(listRuns(l, "loom-wait:abc")).toHaveLength(0);
  });
});
