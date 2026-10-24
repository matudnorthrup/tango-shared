import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createJulesFilesTools,
  isJulesWellnessPathAllowed,
  isJulesWellnessPathReadOnly,
} from "../src/wellness-agent-tools.js";

const tempDirs: string[] = [];

function makeWellnessRoot(layout?: {
  files?: Record<string, string>;
}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jules-wellness-root-"));
  tempDirs.push(root);

  fs.mkdirSync(path.join(root, "nutrition"), { recursive: true });
  fs.mkdirSync(path.join(root, "reading-library", "topic-a"), { recursive: true });
  fs.mkdirSync(path.join(root, "coaching", "source"), { recursive: true });

  for (const [relativePath, content] of Object.entries(layout?.files ?? {})) {
    const fullPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
  }

  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("jules_files path guards", () => {
  it("allows paths inside the wellness root and rejects escapes", () => {
    const root = makeWellnessRoot();
    expect(isJulesWellnessPathAllowed(path.join(root, "nutrition"), root)).toBe(true);
    expect(isJulesWellnessPathAllowed("/etc/passwd", root)).toBe(false);
    expect(isJulesWellnessPathAllowed(path.join(root, "..", "outside"), root)).toBe(false);
  });

  it("marks reading-library and source directories read-only", () => {
    const root = makeWellnessRoot();
    expect(isJulesWellnessPathReadOnly(path.join(root, "reading-library"), root)).toBe(true);
    expect(isJulesWellnessPathReadOnly(path.join(root, "reading-library", "topic-a", "scan.md"), root)).toBe(true);
    expect(isJulesWellnessPathReadOnly(path.join(root, "coaching", "source", "scan.md"), root)).toBe(true);
    expect(isJulesWellnessPathReadOnly(path.join(root, "nutrition", "note.md"), root)).toBe(false);
  });
});

describe("createJulesFilesTools", () => {
  it("lists wellness subdirectories", async () => {
    const root = makeWellnessRoot();
    const [tool] = createJulesFilesTools({ rootDir: root });

    const result = await tool!.handler({ action: "list", path: "." });

    expect(result).toMatchObject({
      path: ".",
      count: expect.any(Number),
    });
    expect((result as { items: Array<{ name: string }> }).items.map((item) => item.name)).toEqual(
      expect.arrayContaining(["nutrition", "reading-library", "coaching"]),
    );
  });

  it("reads and writes files inside the wellness root", async () => {
    const root = makeWellnessRoot({
      files: {
        "nutrition/food-profile.md": "baseline",
      },
    });
    const [tool] = createJulesFilesTools({ rootDir: root });

    await expect(tool!.handler({ action: "read", path: "nutrition/food-profile.md" })).resolves.toEqual({
      content: "baseline",
    });

    await expect(
      tool!.handler({
        action: "write",
        path: "nutrition/test-note.md",
        content: "logged",
      }),
    ).resolves.toMatchObject({
      success: true,
      action: "write",
      path: "nutrition/test-note.md",
    });

    expect(fs.readFileSync(path.join(root, "nutrition/test-note.md"), "utf8")).toBe("logged");
  });

  it("rejects writes inside reading-library", async () => {
    const root = makeWellnessRoot();
    const [tool] = createJulesFilesTools({ rootDir: root });

    await expect(
      tool!.handler({
        action: "write",
        path: "reading-library/test.md",
        content: "nope",
      }),
    ).resolves.toEqual({
      error: "Read-only area: reading-library/test.md. reading-library/ and /source/ paths cannot be modified.",
    });
  });

  it("allows reads inside reading-library", async () => {
    const root = makeWellnessRoot({
      files: {
        "reading-library/topic-a/somefile.md": "source scan",
      },
    });
    const [tool] = createJulesFilesTools({ rootDir: root });

    await expect(
      tool!.handler({ action: "read", path: "reading-library/topic-a/somefile.md" }),
    ).resolves.toEqual({
      content: "source scan",
    });
  });
});
