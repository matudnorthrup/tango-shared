import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { failThreshold, lateFactor, loadAnnotations, mergeAnnotationLayers, normalizeAnnotations } from "../src/annotations.js";
import { parseLaunchctlList, parseLaunchctlPrint, plistCadence } from "../src/discovery/launchd.js";
import { parseDockerPs, parseFrontmatter } from "../src/discovery/others.js";
import { parsePanes } from "../src/discovery/tmux.js";
import { parseVmStat } from "../src/probes.js";
import { missingPaths, parseNetstatListen, parsePs, scanUnmanaged } from "../src/unmanaged.js";
import { tempDir } from "./helpers.js";

const PS = `  PID  PPID   UID STARTED                       %CPU COMMAND
    1     0     0 Sat Oct 17 05:15:25 2026       0.4 /sbin/launchd
  700     1   501 Sat Oct 17 05:16:01 2026       1.0 /Applications/Some App.app/Contents/MacOS/Some App
28029     1   501 Sun Oct 18 07:01:02 2026      12.5 node /gone/worktree/tailnet.mjs --port 5522
36493     1   501 Sun Oct 18 06:00:00 2026       3.0 node /srv/desk/server.js
40000  3999   501 Sun Oct 18 06:00:00 2026       0.0 node /srv/child.js
41000     1     0 Sun Oct 18 06:00:00 2026       0.0 /usr/local/bin/rootd
`;

const NETSTAT = `Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)          rxbytes      txbytes  rhiwat  shiwat          process:pid    state  options           gencnt    flags   flags1 usecnt rtncnt fltrs
tcp4       0      0  127.0.0.1.9410         *.*                    LISTEN                 0            0  131072  131072             node:36493  00100 00000106 0000000001780d87 00000001 00000800      1      0 000000
tcp4       0      0  127.0.0.1.5522         *.*                    LISTEN                 0            0  131072  131072             node:28029  00100 00000106 000000000172b05d 00000001 00000800      1      0 000000
tcp6       0      0  *.5522                 *.*                    LISTEN                 0            0  131072  131072             node:28029  00100 00000106 000000000172b05e 00000001 00000800      1      0 000000
tcp4       0      0  *.7000                 *.*                    LISTEN                 0            0  131072  131072      Some App H:700  00100 00000106 000000000172b05f 00000001 00000800      1      0 000000
tcp4       0      0  *.3000                 *.*                    LISTEN                 0            0  131072  131072         node:40000  00100 00000106 000000000172b060 00000001 00000800      1      0 000000
tcp4       0      0  *.22                   *.*                    LISTEN                 0            0  131072  131072         rootd:41000  00100 00000106 000000000172b061 00000001 00000800      1      0 000000
tcp4       0    431  192.168.1.2.49340      172.65.251.78.443      ESTABLISHED          458          948  131712  131860    Client:736    00102 00000100 000000000179b032 00000081 04000900      2      0 000000
`;

describe("unmanaged scan", () => {
  it("parses ps and netstat fixtures", () => {
    const ps = parsePs(PS);
    expect(ps).toHaveLength(6);
    expect(ps[2]).toMatchObject({ pid: 28029, ppid: 1, uid: 501, started: "Sun Oct 18 07:01:02 2026", cpu: 12.5, command: "node /gone/worktree/tailnet.mjs --port 5522" });
    const ls = parseNetstatListen(NETSTAT);
    expect(ls.map((x) => [x.process, x.pid, x.port])).toEqual([
      ["node", 36493, 9410],
      ["node", 28029, 5522],
      ["node", 28029, 5522],
      ["Some App H", 700, 7000],
      ["node", 40000, 3000],
      ["rootd", 41000, 22],
    ]);
  });

  it("keeps this user's ppid-1 listeners that no job, launchd label or ignored prefix owns", () => {
    const rows = scanUnmanaged({
      processes: parsePs(PS),
      listens: parseNetstatListen(NETSTAT),
      knownPids: new Set([36493]),
      uid: 501,
      ignorePrefixes: ["/Applications/"],
      exists: (p) => !p.startsWith("/gone"),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "launchd:unmanaged-28029", managed: false, name: "node tailnet.mjs (:5522)" });
    expect(rows[0]!.facts).toMatchObject({ pid: 28029, ports: [5522], cwdDeleted: true, startedAt: "Sun Oct 18 07:01:02 2026" });
  });

  it("missingPaths flags absolute paths that do not exist", () => {
    expect(missingPaths("node /a/b.js --x /c", (p) => p === "/c")).toEqual(["/a/b.js"]);
  });
});

describe("launchd parsing", () => {
  it("parses launchctl list", () => {
    expect(parseLaunchctlList("PID\tStatus\tLabel\n93982\t0\tcom.example.loom\n-\t1\tcom.example.job\n-\t-9\tcom.example.killed\n")).toEqual([
      { label: "com.example.loom", pid: 93982, status: 0 },
      { label: "com.example.job", pid: null, status: 1 },
      { label: "com.example.killed", pid: null, status: -9 },
    ]);
  });

  it("parses launchctl print top-level keys only", () => {
    const p = parseLaunchctlPrint(`gui/501/com.example.backup = {
\tactive count = 0
\tpath = /home/x/Library/LaunchAgents/com.example.backup.plist
\tstate = not running
\tstdout path = /tmp/out.log
\tstderr path = /tmp/err.log
\tenvironment = {
\t\tPATH => /usr/bin
\t}
\truns = 4
\tlast exit code = 2
}`);
    expect(p).toEqual({ path: "/home/x/Library/LaunchAgents/com.example.backup.plist", state: "not running", pid: null, runs: 4, lastExit: 2, stdoutPath: "/tmp/out.log", stderrPath: "/tmp/err.log" });
    expect(parseLaunchctlPrint("\tlast exit code = (never exited)\n").lastExit).toBeNull();
  });

  it("derives cadence from the plist", () => {
    expect(plistCadence({ StartInterval: 600 })).toMatchObject({ cadence: "Every 10 min", seconds: 600 });
    expect(plistCadence({ StartCalendarInterval: { Hour: 3, Minute: 30 } })).toMatchObject({ cadence: "Daily 03:30", seconds: 86400 });
    expect(plistCadence({ StartCalendarInterval: [{ Minute: 0 }, { Minute: 30 }] })).toMatchObject({ seconds: 3600 });
    expect(plistCadence({ StartCalendarInterval: { Weekday: 5, Hour: 9, Minute: 7 } }).seconds).toBe(7 * 86400);
    expect(plistCadence({ KeepAlive: true })).toMatchObject({ cadence: "Always on", seconds: null, keepAlive: true });
    expect(plistCadence({ RunAtLoad: true })).toMatchObject({ cadence: "At boot", seconds: null });
  });
});

describe("other parsers", () => {
  it("tmux panes ('|'-separated, window names may contain '|')", () => {
    expect(parsePanes("discord|26651|0|zsh\na|b|99|1|node\n")).toEqual([
      { window: "discord", panePid: 26651, dead: false, command: "zsh" },
      { window: "a|b", panePid: 99, dead: true, command: "node" },
    ]);
  });

  it("docker ps json lines", () => {
    expect(parseDockerPs('{"Names":"db","State":"running"}\nnot json\n{"Names":"x","State":"exited","Status":"Exited (1) 2 hours ago"}\n')).toHaveLength(2);
  });

  it("SKILL.md frontmatter", () => {
    expect(parseFrontmatter("---\nname: cleanup\ndescription: tidy up\n---\nbody")).toEqual({ name: "cleanup", description: "tidy up" });
    expect(parseFrontmatter("no frontmatter")).toEqual({});
  });

  it("vm_stat used memory", () => {
    const text = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages active:   100.\nPages wired down:  50.\nPages occupied by compressor:  10.\n";
    expect(parseVmStat(text)).toBe(160 * 16384);
  });
});

describe("annotations", () => {
  it("merges defaults under the profile overlay", () => {
    const merged = normalizeAnnotations(
      mergeAnnotationLayers([
        {
          prefixes: { launchd: ["com.tango."] },
          services: [{ id: "bot", name: "Bot", url: "http://127.0.0.1:9200/status/work", critical: true }, { id: "voice", name: "Voice", port: 8787 }],
          jobs: { "tmux:discord": { name: "Bot", criticality: "critical" } },
          defaults: { group: { schedule: "Schedules", launchd: "launchd agents" }, criticality: "normal" },
        },
        {
          prefixes: { launchd: ["com.tango.", "com.example."] },
          tmux: { socket: "/tmp/sock", session: "main" },
          services: [{ id: "voice", port: 9999 }, { id: "tailnet", name: "Tailnet", cmd: "tailscale" }],
          jobs: { "tmux:discord": { group: "Core" }, "launchd:com.example.x": { name: "X", critical: true, logs: ["~/x.log"], cadenceSeconds: 60 } },
          defaults: { group: { launchd: "Agents" } },
        },
      ]),
    );
    expect(merged.prefixes.launchd).toEqual(["com.tango.", "com.example."]);
    expect(merged.tmux).toMatchObject({ socket: "/tmp/sock", session: "main" });
    expect(merged.services.map((s) => [s.id, s.port ?? s.url ?? s.cmd])).toEqual([
      ["bot", "http://127.0.0.1:9200/status/work"],
      ["voice", 9999],
      ["tailnet", "tailscale"],
    ]);
    expect(merged.services[1]!.name).toBe("Voice");
    expect(merged.jobs["tmux:discord"]).toEqual({ name: "Bot", criticality: "critical", group: "Core" });
    expect(merged.jobs["launchd:com.example.x"]).toMatchObject({ criticality: "critical", cadenceSeconds: 60 });
    expect(merged.defaults.group).toEqual({ schedule: "Schedules", launchd: "Agents" });
  });

  it("loads files, skipping a missing or broken layer", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "a"));
    writeFileSync(join(dir, "a", "jobs.yaml"), "prefixes:\n  launchd: [com.tango.]\n");
    writeFileSync(join(dir, "bad.yaml"), "prefixes: [unclosed\n");
    const warnings: string[] = [];
    const a = loadAnnotations([join(dir, "a", "jobs.yaml"), join(dir, "bad.yaml"), join(dir, "missing.yaml")], (m) => warnings.push(m));
    expect(a.prefixes.launchd).toEqual(["com.tango."]);
    expect(warnings).toHaveLength(1);
  });

  it("the repo defaults file loads and stays generic", () => {
    const a = loadAnnotations([new URL("../../../config/defaults/system/jobs.yaml", import.meta.url).pathname]);
    expect(a.prefixes.launchd).toEqual(["com.tango."]);
    expect(a.services.filter((s) => s.critical).map((s) => s.id)).toEqual(["bot", "loom", "desk"]);
    expect(a.jobs["tmux:discord"]?.criticality).toBe("critical");
  });

  it("thresholds per criticality", () => {
    expect([failThreshold("critical"), failThreshold("normal"), failThreshold("quiet")]).toEqual([1, 2, Infinity]);
    expect([lateFactor("critical"), lateFactor("normal"), lateFactor("quiet")]).toEqual([1.5, 2, 3]);
    expect(failThreshold("quiet", { failAfter: 1 })).toBe(1);
  });
});
