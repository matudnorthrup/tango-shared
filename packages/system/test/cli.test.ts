import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runEventCli } from "../src/cli/tango-event.js";
import { runRunCli } from "../src/cli/tango-run.js";
import { listEvents, listIncidents } from "../src/incidents.js";
import { listRuns, upsertJob } from "../src/jobs.js";
import { openLedger } from "../src/ledger.js";
import { tempDir } from "./helpers.js";

const collect = () => {
  const s = new PassThrough();
  let text = "";
  s.on("data", (c: Buffer) => (text += c.toString()));
  return { stream: s, text: () => text };
};

const node = process.execPath;

describe("tango-run", () => {
  it("passes the exit code through and records the run with its output tail", async () => {
    const dbPath = join(tempDir(), "s.sqlite");
    const out = collect();
    const err = collect();
    const code = await runRunCli(["launchd:com.example.job", "--", node, "-e", "console.log('hello'); console.error('oops'); process.exit(3)"], { stdout: out.stream, stderr: err.stream, dbPath });
    expect(code).toBe(3);
    expect(out.text()).toContain("hello");
    expect(err.text()).toContain("oops");
    const l = openLedger({ path: dbPath });
    const [run] = listRuns(l, "launchd:com.example.job");
    expect(run).toMatchObject({ status: "failed", exitCode: 3 });
    expect(run!.outputTail).toContain("hello");
    expect(run!.outputTail).toContain("oops");
    l.close();
  });

  it("records run.failed per threshold and the recovery on success", async () => {
    const dbPath = join(tempDir(), "s.sqlite");
    const l = openLedger({ path: dbPath });
    upsertJob(l, { id: "launchd:com.example.crit", runner: "launchd", name: "Crit", criticality: "critical" });
    l.close();
    const io = { stdout: new PassThrough(), stderr: new PassThrough(), dbPath };
    expect(await runRunCli(["launchd:com.example.crit", "--", node, "-e", "process.exit(1)"], io)).toBe(1);
    let l2 = openLedger({ path: dbPath });
    expect(listIncidents(l2)).toHaveLength(1);
    l2.close();
    expect(await runRunCli(["launchd:com.example.crit", "--", node, "-e", "process.exit(0)"], io)).toBe(0);
    l2 = openLedger({ path: dbPath });
    expect(listIncidents(l2)).toHaveLength(0);
    expect(listEvents(l2).map((e) => e.kind)).toEqual(["run.ok", "run.failed"]);
    l2.close();
  });

  it("keeps only the last 4 KB of output", async () => {
    const dbPath = join(tempDir(), "s.sqlite");
    const code = await runRunCli(["launchd:com.example.big", "--", node, "-e", "process.stdout.write('a'.repeat(20000) + 'END')"], { stdout: new PassThrough(), stderr: new PassThrough(), dbPath });
    expect(code).toBe(0);
    const l = openLedger({ path: dbPath });
    const tail = listRuns(l, "launchd:com.example.big")[0]!.outputTail!;
    expect(Buffer.byteLength(tail)).toBe(4096);
    expect(tail.endsWith("END")).toBe(true);
    l.close();
  });

  it("still runs the command and keeps its exit when the ledger cannot open", async () => {
    const blocker = join(tempDir(), "file");
    writeFileSync(blocker, "x");
    const err = collect();
    const code = await runRunCli(["launchd:com.example.job", "--", node, "-e", "process.exit(5)"], { stdout: new PassThrough(), stderr: err.stream, dbPath: join(blocker, "sub", "s.sqlite") });
    expect(code).toBe(5);
    expect(err.text()).toContain("run not recorded");
  });

  it("returns 127 when the command cannot start, and 64 on bad usage", async () => {
    const dbPath = join(tempDir(), "s.sqlite");
    const io = { stdout: new PassThrough(), stderr: new PassThrough(), dbPath };
    expect(await runRunCli(["launchd:com.example.job", "--", "/nonexistent/binary"], io)).toBe(127);
    expect(await runRunCli(["launchd:com.example.job"], io)).toBe(64);
  });

  it("as a process: exits with the wrapped command's code", () => {
    const dbPath = join(tempDir(), "s.sqlite");
    const script = fileURLToPath(new URL("../src/cli/tango-run.ts", import.meta.url));
    const r = spawnSync(node, ["--import", "tsx", script, "launchd:com.example.job", "--", node, "-e", "console.log('out'); process.exit(7)"], {
      env: { ...process.env, TANGO_SYSTEM_DB: dbPath },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(r.status).toBe(7);
    expect(r.stdout).toContain("out");
  });
});

describe("tango-event", () => {
  it("records an event and prints its ids", async () => {
    const dbPath = join(tempDir(), "s.sqlite");
    let out = "";
    const code = await runEventCli(["--source", "backup", "--kind", "run.failed", "--severity", "error", "--title", "Backup failed", "--job", "service:backup", "--data", '{"x":1}'], { stdout: (s) => (out += s), stderr: () => {}, dbPath });
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ eventId: 1, incidentId: 1 });
    const l = openLedger({ path: dbPath });
    expect(listEvents(l)[0]).toMatchObject({ jobId: "service:backup", data: { x: 1 } });
    l.close();
  });

  it("scopes a recovery to one incident with --resolves-kind and --resolves-title", async () => {
    const dbPath = join(tempDir(), "s.sqlite");
    const io = { stdout: () => {}, stderr: () => {}, dbPath };
    const big = (file: string) => ["--source", "tick", "--kind", "log.large", "--severity", "warning", "--title", `Log is large: ${file}`, "--job", "launchd:x"];
    await runEventCli(big("out.log"), io);
    await runEventCli(big("err.log"), io);
    await runEventCli(["--source", "fix-worker", "--kind", "log.ok", "--severity", "recovery", "--title", "Rotated", "--job", "launchd:x", "--resolves-kind", "log.large", "--resolves-title", "Log is large: out.log"], io);
    const l = openLedger({ path: dbPath });
    expect(listIncidents(l).map((i) => i.title)).toEqual(["Log is large: err.log"]);
    l.close();
  });

  it("never fails the caller: exit 0 with a warning when the ledger is unavailable or flags are bad", async () => {
    const blocker = join(tempDir(), "file");
    writeFileSync(blocker, "x");
    let err = "";
    const io = { stdout: () => {}, stderr: (s: string) => (err += s), dbPath: join(blocker, "sub", "s.sqlite") };
    expect(await runEventCli(["--source", "a", "--kind", "custom", "--severity", "info", "--title", "t"], io)).toBe(0);
    expect(err).toContain("event not recorded");
    expect(await runEventCli(["--source", "a"], io)).toBe(0);
    expect(await runEventCli(["--source", "a", "--kind", "k", "--severity", "nope", "--title", "t"], io)).toBe(0);
  });

  it("--strict exits 2 when the event was not written", async () => {
    const blocker = join(tempDir(), "file");
    writeFileSync(blocker, "x");
    const io = { stdout: () => {}, stderr: () => {}, dbPath: join(blocker, "sub", "s.sqlite") };
    expect(await runEventCli(["--strict", "--source", "a", "--kind", "custom", "--severity", "info", "--title", "t"], io)).toBe(2);
    expect(await runEventCli(["--strict", "--source", "a"], io)).toBe(2);
  });

  it("as a process: exits 0 on a read-only ledger directory", () => {
    const dir = tempDir();
    const ro = join(dir, "ro");
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    const script = fileURLToPath(new URL("../src/cli/tango-event.ts", import.meta.url));
    const args = ["--import", "tsx", script, "--source", "a", "--kind", "custom", "--severity", "info", "--title", "t"];
    const env = { ...process.env, TANGO_SYSTEM_DB: join(ro, "s.sqlite") };
    const r = spawnSync(node, args, { env, encoding: "utf8", timeout: 30_000 });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("warning");
    const strict = spawnSync(node, [...args, "--strict"], { env, encoding: "utf8", timeout: 30_000 });
    expect(strict.status).toBe(2);
    chmodSync(ro, 0o700);
  });
});
