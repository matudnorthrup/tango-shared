import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireOwnership, LoomAlreadyRunningError } from "../src/ownership.js";
import { hydratePath, mergePaths, parseShellPath } from "../src/env.js";
import { killGroup, processStart, reapOrphans, spawnGroup } from "../src/proc.js";
import { LoomStore } from "../src/store.js";

describe("ownership", () => {
  it("lets exactly one owner hold the state directory", () => {
    const path = join(mkdtempSync(join(tmpdir(), "loom-")), "owner.sqlite");
    const first = acquireOwnership(path);
    expect(() => acquireOwnership(path)).toThrow(LoomAlreadyRunningError);
    first.release();
    const second = acquireOwnership(path);
    second.release();
  });
});

describe("PATH hydration", () => {
  it("reads PATH between markers and ignores rc-file noise", () => {
    expect(parseShellPath("motd\n__LOOM_PATH_START__/a:/b\n__LOOM_PATH_END__")).toBe("/a:/b");
    expect(parseShellPath("no markers")).toBeNull();
  });

  it("puts the login PATH first without duplicates", () => {
    expect(mergePaths("/nvm/bin:/usr/bin", "/usr/bin:/bin")).toBe("/nvm/bin:/usr/bin:/bin");
  });

  it("falls back to launchctl when the shell fails", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", SHELL: "/bin/zsh", HOME: "/h" };
    const exec = async (file: string) => {
      if (file === "/bin/zsh") throw new Error("timeout");
      return "/opt/homebrew/bin:/usr/bin\n";
    };
    expect(await hydratePath(env, exec)).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  });
});

describe("process groups", () => {
  it("refuses to signal pid <= 1", () => {
    expect(killGroup(0)).toBe(false);
    expect(killGroup(1)).toBe(false);
  });

  it("kills a harness's whole group when it exits, and clears the ledger", async () => {
    const store = new LoomStore(":memory:");
    // The leader starts a grandchild that would outlive it, then exits.
    const child = spawnGroup(store, "t1", "/bin/sh", ["-c", "sleep 30 & echo $!; sleep 0.2"], { stdio: ["ignore", "pipe", "ignore"] });
    let grandchild = 0;
    child.stdout!.on("data", (d) => (grandchild = Number(String(d).trim())));
    expect(store.spawns()).toHaveLength(1);
    await new Promise((r) => child.once("exit", r));
    await new Promise((r) => setTimeout(r, 100));
    expect(grandchild).toBeGreaterThan(1);
    expect(processStart(grandchild)).toBeNull();
    expect(store.spawns()).toHaveLength(0);
  });

  it("reaps a group left behind by a crash only if the pid still matches", async () => {
    const store = new LoomStore(":memory:");
    const { spawn } = await import("node:child_process");
    const orphan = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    store.recordSpawn(orphan.pid!, "t1", "sleep 30", processStart(orphan.pid!)!);
    store.recordSpawn(999_999, "t2", "gone", "Mon Jan  1 00:00:00 2024");
    expect(reapOrphans(store)).toBe(1);
    await new Promise((r) => orphan.once("exit", r));
    expect(store.spawns()).toHaveLength(0);
  });
});
