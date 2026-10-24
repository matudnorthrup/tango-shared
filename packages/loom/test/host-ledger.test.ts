import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FileSpawnLedger, readHostLedgers } from "../src/host-ledger.js";
import { killGroup, processStart, reapOrphans } from "../src/proc.js";
import { LoomStore } from "../src/store.js";

it.skipIf(processStart(process.pid) === null)("protects a live host's group and reaps it once the host identity is gone", async () => {
  const hostsDir = mkdtempSync(join(tmpdir(), "loom-host-ledger-"));
  const ledger = new FileSpawnLedger(hostsDir, "thread", "test", 1);
  const child = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const store = new LoomStore(":memory:");
  try {
    const pid = child.pid!;
    ledger.recordSpawn(pid, "thread", "sleep 30", processStart(pid)!);
    store.recordSpawn(pid, "thread", "sleep 30", processStart(pid)!);
    expect(reapOrphans(store, hostsDir)).toBe(0);
    expect(processStart(pid)).not.toBeNull();
    expect(store.spawns()).toHaveLength(1);
    expect(readHostLedgers(hostsDir)[0].release).toBe("test");
    // Real session hosts never write the database ledger: recovery must reap their file entries.
    store.forgetSpawn(pid);
    const path = join(hostsDir, "thread.json");
    const host = JSON.parse(readFileSync(path, "utf8"));
    host.started = "a different process";
    writeFileSync(path, JSON.stringify(host));
    expect(reapOrphans(store, hostsDir)).toBe(1);
    await exited;
    expect(processStart(pid)).toBeNull();
  } finally {
    killGroup(child.pid!);
    ledger.remove();
    store.close();
  }
});
