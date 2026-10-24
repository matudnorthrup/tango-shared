import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { releaseId } from "../src/release-info.js";
// Plain ESM CLI is also importable so builds and crash boundaries can be stubbed.
// @ts-expect-error No declaration needed for the standalone Node script.
import { atomicJSON, run } from "../scripts/release.mjs";

const roots: string[] = [];
function writable(path: string) {
  const s = fs.lstatSync(path);
  if (s.isSymbolicLink()) return;
  fs.chmodSync(path, s.mode | 0o700);
  if (s.isDirectory()) for (const n of fs.readdirSync(path)) writable(join(path, n));
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) { writable(root); fs.rmSync(root, { recursive: true }); }
});
function fixture() {
  const temp = fs.mkdtempSync(join(tmpdir(), "loom-release-test-")); roots.push(temp);
  fs.copyFileSync(new URL("../../../AGENTS.md", import.meta.url), join(temp, "AGENTS.md"));
  const pkg = join(temp, "packages/loom"); fs.mkdirSync(join(pkg, "src"), { recursive: true });
  fs.writeFileSync(join(pkg, "package.json"), JSON.stringify({ type: "module" }));
  const sdk = join(pkg, "node_modules/@anthropic-ai/claude-agent-sdk");
  fs.mkdirSync(sdk, { recursive: true });
  fs.writeFileSync(join(sdk, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "1.0.0", main: "sdk.mjs" }));
  fs.writeFileSync(join(sdk, "sdk.mjs"), "export const sdk = true;");
  const extraPaths: string[] = [];
  for (const [location, version] of [["packages/loom/node_modules/zod", "4.6.7"], ["node_modules/zod", "3.25.76"], ["node_modules/zod/node_modules/nested", "1.0.0"]]) {
    const path = join(temp, location);
    fs.mkdirSync(path, { recursive: true });
    fs.writeFileSync(join(path, "package.json"), JSON.stringify({ name: location.endsWith("nested") ? "nested" : "zod", version }));
    extraPaths.push(path);
  }
  execFileSync("git", ["init", "-q", pkg]);
  fs.writeFileSync(join(pkg, "src/host-protocol.ts"), "export const HOST_PROTOCOL = 7;\n");
  fs.writeFileSync(join(pkg, ".gitignore"), "dist/\nnode_modules/\n");
  execFileSync("git", ["add", "."], { cwd: pkg });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: pkg });
  const root = join(temp, "releases");
  const build = vi.fn(() => {
    fs.mkdirSync(join(pkg, "dist"), { recursive: true });
    fs.writeFileSync(join(pkg, "dist/main.js"), "console.log('fixture');");
    fs.writeFileSync(join(pkg, "dist/host-protocol.js"), "export const HOST_PROTOCOL = 7;\nexport const SUPPORTED_HOST_PROTOCOLS = new Set([7, 8]);\n");
  });
  vi.stubEnv("LOOM_RELEASES_DIR", root);
  const cli = (...args: string[]) => run(args, { packageDir: pkg, loomHome: pkg, processStart: () => "fixture start", build, productionPaths: () => [temp, join(temp, "node_modules/@tango/loom"), sdk, ...extraPaths].join("\n") });
  const state = () => JSON.parse(fs.readFileSync(join(root, "state.json"), "utf8"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  return { root, pkg, cli, state, build };
}
// Real file trees and git: slow under a parallel suite, so not the 5 s default.
describe("immutable releases", { timeout: 30_000 }, () => {
  it("builds candidates, promotes, rolls back, and prunes only unprotected releases", () => {
    const { root, cli, state, build } = fixture();
    const first = cli("build"); const second = cli("build");
    expect(first).not.toBe(second); expect(build).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fs.readFileSync(join(root, first, "release.json"), "utf8")).hostProtocol).toEqual([7, 8]);
    expect(fs.existsSync(join(root, first, "dist"))).toBe(false);
    expect(releaseId()).toBe("dev");
    expect(fs.readFileSync(join(root, first, "AGENTS.md"), "utf8")).toContain("<!-- loom:worker:start -->");
    const loomRequire = createRequire(join(root, first, "packages/loom/package.json"));
    const rootRequire = createRequire(join(root, first, "package.json"));
    expect(loomRequire("zod/package.json").version).toBe("4.6.7");
    expect(rootRequire("zod/package.json").version).toBe("3.25.76");
    const info = JSON.parse(fs.readFileSync(join(root, first, "release.json"), "utf8"));
    expect(info.dependencies).toMatchObject({ "@anthropic-ai/claude-agent-sdk": "1.0.0", zod: "4.6.7", nested: "1.0.0" });
    for (const [location, version] of [["packages/loom/node_modules/zod", "4.6.7"], ["node_modules/zod", "3.25.76"]]) {
      expect(JSON.parse(fs.readFileSync(join(root, first, location, "package.json"), "utf8")).version).toBe(version);
      expect(info.dependencyLocations[location]).toEqual({ name: "zod", version });
    }
    expect(state().candidates).toEqual([first, second]); expect(state().current).toBeNull();
    for (const id of [first, second]) {
      for (const part of ["", "packages/loom/dist", "packages/loom/dist/main.js", "release.json", "packages/loom/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs", "node_modules/zod/node_modules/nested/package.json"]) {
        expect(fs.statSync(join(root, id, part)).mode & 0o222).toBe(0);
      }
    }
    cli("promote", first); cli("promote", second);
    expect(state().current).toBe(second); expect(fs.readlinkSync(join(root, "current"))).toBe(second);
    cli("rollback"); expect(state().current).toBe(first); expect(state().previous).toBe(second);
    expect(fs.readlinkSync(join(root, "current"))).toBe(first);
    const pinned = cli("build"); cli("promote", pinned); cli("pin", "thread", first);
    const current = cli("build"); cli("promote", current);
    const candidate = cli("build");
    cli("prune", "--keep", "0");
    expect(fs.existsSync(join(root, second))).toBe(false);
    for (const id of [first, pinned, current, candidate]) expect(fs.existsSync(join(root, id))).toBe(true);
    cli("pin", "thread", "none"); cli("prune", "--keep", "0");
    expect(fs.existsSync(join(root, first))).toBe(false);
    cli("list"); expect(console.log).toHaveBeenCalledWith(expect.stringContaining("candidate"));
  });
  it("refuses promote and rollback when a live host uses a dropped protocol, ignoring stale PIDs", () => {
    const { root, pkg, cli, state } = fixture();
    const first = cli("build");
    cli("promote", first);
    const second = cli("build");
    const hosts = join(pkg, "hosts"); fs.mkdirSync(hosts);
    const path = join(hosts, "thread.json");
    const host = { threadId: "thread", pid: process.pid, started: "fixture start", protocol: 1, groups: [] };
    fs.writeFileSync(path, JSON.stringify(host));
    expect(() => cli("promote", second)).toThrow(/drops live host protocol 1/);
    expect(state().current).toBe(first);
    expect(() => run(["promote", second], { root, loomHome: pkg, processStart: () => { throw new Error("probe unavailable"); } })).toThrow("probe unavailable");
    expect(state().current).toBe(first);
    fs.writeFileSync(path, JSON.stringify({ ...host, started: "stale process" }));
    cli("promote", second);
    fs.writeFileSync(path, JSON.stringify(host));
    expect(() => cli("rollback")).toThrow(/drops live host protocol 1/);
    expect(state().current).toBe(second);
    fs.writeFileSync(path, JSON.stringify({ ...host, protocol: 7 }));
    cli("rollback");
    expect(state().current).toBe(first);
  });
  it("prunes after every promote and never deletes a release a live host or the coordinator runs from", () => {
    const { root, pkg, cli } = fixture();
    const ids = Array.from({ length: 9 }, () => { const id = cli("build"); cli("promote", id); return id; });
    // current + previous + PRUNE_KEEP more survive the last promote.
    for (const id of ids.slice(0, 2)) expect(fs.existsSync(join(root, id))).toBe(false);
    for (const id of ids.slice(2)) expect(fs.existsSync(join(root, id))).toBe(true);
    const hosts = join(pkg, "hosts"); fs.mkdirSync(hosts);
    fs.writeFileSync(join(hosts, "thread.json"), JSON.stringify({ threadId: "thread", pid: process.pid, started: "fixture start", release: ids[2], protocol: 7, groups: [] }));
    fs.writeFileSync(join(pkg, "coordinator.json"), JSON.stringify({ pid: process.pid, started: "fixture start", release: ids[3] }));
    cli("prune", "--keep", "0");
    for (const id of [ids[2], ids[3], ids[7], ids[8]]) expect(fs.existsSync(join(root, id))).toBe(true);
    for (const id of ids.slice(4, 7)) expect(fs.existsSync(join(root, id))).toBe(false);
    fs.writeFileSync(join(pkg, "coordinator.json"), JSON.stringify({ pid: process.pid, started: "stale process", release: ids[3] }));
    cli("prune", "--keep", "0");
    expect(fs.existsSync(join(root, ids[3]))).toBe(false);
  });
  it("leaves no release or candidate when the build fails", () => {
    const { root, cli, build } = fixture();
    build.mockImplementation(() => { throw new Error("broken build"); });
    expect(() => cli("build")).toThrow("broken build");
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it("refuses dirty sources by default and records explicit dirty builds", () => {
    const { pkg, root, cli, build } = fixture();
    fs.writeFileSync(join(pkg, "src/new.ts"), "// dirty\n");
    expect(() => cli("build")).toThrow(/allow-dirty/); expect(build).not.toHaveBeenCalled();
    const id = cli("build", "--allow-dirty"); expect(id).toMatch(/-dirty$/);
    expect(JSON.parse(fs.readFileSync(join(root, id, "release.json"), "utf8")).dirty).toBe(true);
    expect(() => cli("promote", "../outside")).toThrow(/Unknown release/);
  });
  it("leaves old state readable if killed after writing the temporary file", () => {
    const { root, cli, state } = fixture(); cli("build"); const before = state();
    // A separate process exits at the real write/rename boundary, skipping finally.
    const script = resolve("scripts/release.mjs");
    const code = `import { atomicJSON } from ${JSON.stringify('file://' + script)}; atomicJSON(process.argv[1], {broken:true}, () => process.exit(23));`;
    expect(() => execFileSync(process.execPath, ["--input-type=module", "-e", code, join(root, "state.json")])).toThrow();
    expect(state()).toEqual(before);
    expect(fs.readdirSync(root).some(n => n.endsWith(".tmp"))).toBe(true);
  });
  it("repairs the pointer from committed state on the next invocation", () => {
    const { root, cli, state } = fixture(); const id = cli("build"); cli("promote", id);
    fs.unlinkSync(join(root, "current")); fs.symlinkSync("interrupted", join(root, "current"));
    cli("list"); expect(fs.readlinkSync(join(root, "current"))).toBe(state().current);
  });
});
