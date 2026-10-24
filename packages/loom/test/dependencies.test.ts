import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A release ships only Loom's declared production dependencies (scripts/release.mjs), so an import that
// resolves in the monorepo through another package's hoisted copy still breaks the release.
describe("dependencies", () => {
  it("declares every package the source imports", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8")) as { dependencies?: Record<string, string> };
    const declared = new Set(Object.keys(pkg.dependencies ?? {}));
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
    const missing = new Set<string>();
    for (const file of files(join(__dirname, "../src"))) {
      const text = readFileSync(file, "utf8");
      // Every runtime form that survives into dist: import … from, bare import, export … from, dynamic import().
      const forms = [
        /^\s*import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm,
        /^\s*import\s+["']([^"']+)["']/gm,
        /^\s*export\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm,
        /\bimport\(\s*["']([^"']+)["']\s*\)/g,
      ];
      for (const [, spec] of forms.flatMap((form) => [...text.matchAll(form)])) {
        if (spec!.startsWith(".") || spec!.startsWith("node:")) continue;
        const name = spec!.startsWith("@") ? spec!.split("/").slice(0, 2).join("/") : spec!.split("/")[0]!;
        if (!declared.has(name)) missing.add(`${name} (${file.split("/src/")[1]})`);
      }
    }
    expect([...missing]).toEqual([]);
  });
});
