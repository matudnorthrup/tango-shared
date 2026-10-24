import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeAnnotations, type Annotations } from "../src/annotations.js";
import type { SystemContext } from "../src/context.js";
import type { Exec, ExecResult, Fetch } from "../src/exec.js";
import { openLedger } from "../src/ledger.js";
import type { Ledger } from "../src/types.js";

export function tempDir(prefix = "sys-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function tempLedger(): Ledger {
  return openLedger({ path: join(tempDir("ledger-"), "system.sqlite") });
}

export const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });
export const fail = (code = 1, stderr = "failed"): ExecResult => ({ code, stdout: "", stderr, timedOut: false });
export const missing = (): ExecResult => ({ code: null, stdout: "", stderr: "", timedOut: false, error: "spawn ENOENT" });

/** An exec that answers by "cmd arg0 arg1" prefix and records every call. */
export function fakeExec(answers: Record<string, ExecResult | ((args: string[]) => ExecResult)>): Exec & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    const line = [cmd, ...args].join(" ");
    const key = Object.keys(answers)
      .filter((k) => line.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) return missing();
    const a = answers[key]!;
    return typeof a === "function" ? a(args) : a;
  }) as Exec & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

export function fakeFetch(answer: (url: string, init?: RequestInit) => { status: number; text: string } | { error: string }): Fetch & { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return answer(url, init);
  }) as Fetch & { calls: Array<{ url: string; init?: RequestInit }> };
  fn.calls = calls;
  return fn;
}

export function annotations(raw: Record<string, unknown> = {}): Annotations {
  return normalizeAnnotations({ services: [], prefixes: { launchd: ["com.example."] }, ...raw });
}

export function fakeCtx(overrides: Partial<SystemContext> = {}): SystemContext {
  const root = tempDir("ctx-");
  const profileDir = join(root, "profile");
  mkdirSync(join(profileDir, "data"), { recursive: true });
  return {
    exec: fakeExec({}),
    fetch: fakeFetch(() => ({ error: "offline" })),
    annotations: annotations(),
    now: () => new Date(),
    warn: () => {},
    uid: 501,
    homeDir: join(root, "home"),
    repoDir: join(root, "repo"),
    profileDir,
    dataDir: join(profileDir, "data"),
    tangoDbPath: join(root, "tango.sqlite"),
    loomDbPath: join(root, "loom.sqlite"),
    recoveryHealthFile: null,
    routinesDir: join(root, "home", ".claude", "scheduled-tasks"),
    kill: () => {},
    sleep: async () => {},
    ...overrides,
  };
}

export const minutesAgo = (m: number, from = Date.now()) => new Date(from - m * 60_000).toISOString();
