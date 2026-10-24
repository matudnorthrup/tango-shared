import { expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
// @ts-expect-error Standalone ESM command intentionally has no declaration file.
import { canary } from "../scripts/canary.mjs";

it("canaries a candidate through submit, crash, interrupt and native resume before promotion", async () => {
  const root = mkdtempSync("/tmp/loom-canary-test-");
  try {
    const release = join(root, "candidate");
    const pkg = join(release, "packages/loom");
    mkdirSync(pkg, { recursive: true });
    cpSync(resolve("../../AGENTS.md"), join(release, "AGENTS.md"));
    cpSync(resolve("dist"), join(pkg, "dist"), { recursive: true });
    cpSync(resolve("package.json"), join(pkg, "package.json"));
    symlinkSync(resolve("../../node_modules"), join(release, "node_modules"));
    // Loom keeps some dependencies (the SDK, zod 4) in its own node_modules, as a real release does.
    symlinkSync(resolve("node_modules"), join(pkg, "node_modules"));
    writeFileSync(join(release, "release.json"), JSON.stringify({ id: "candidate", hostProtocol: [1] }));
    writeFileSync(join(root, "state.json"), JSON.stringify({ current: null, previous: null, candidates: ["candidate"], history: [], pins: {} }));
    const result = await canary("candidate", { root, loomHome: join(root, "unused-home"), account: "fake", fake: true, timeout: 15_000 });
    expect(result.checks).toEqual(["submit", "crash-reattach", "interrupt", "native-resume"]);
    expect(JSON.parse(readFileSync(join(root, "state.json"), "utf8")).current).toBe("candidate");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
