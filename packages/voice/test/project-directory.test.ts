import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectDirectory } from "../src/project-directory.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-project-config-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "projects"), { recursive: true });
  return dir;
}

describe("ProjectDirectory", () => {
  it("resolves projects by id, display name, and alias", () => {
    const dir = createTempConfigDir();
    fs.writeFileSync(
      path.join(dir, "projects", "tango.yaml"),
      [
        "id: tango",
        "display_name: Tango MVP",
        "aliases:",
        "  - tango app",
        "default_agent: watson",
        "provider:",
        "  default: claude-harness",
      ].join("\n"),
    );

    const directory = new ProjectDirectory(dir);
    expect(directory.resolveProjectQuery("tango")?.id).toBe("tango");
    expect(directory.resolveProjectQuery("Tango MVP")?.id).toBe("tango");
    expect(directory.resolveProjectQuery("tango app")?.id).toBe("tango");
  });
});
