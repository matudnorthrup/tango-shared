import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SYSTEM_IDENTITY, loadSystemIdentity } from "../src/system-identity.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const originalConfigDir = process.env.TANGO_CONFIG_DIR;

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.TANGO_CONFIG_DIR;
  else process.env.TANGO_CONFIG_DIR = originalConfigDir;
});

describe("loadSystemIdentity", () => {
  it("reads the repo defaults", () => {
    const defaultsDir = path.join(repoRoot, "config", "defaults");
    process.env.TANGO_CONFIG_DIR = defaultsDir;

    expect(loadSystemIdentity(defaultsDir)).toEqual({
      displayName: "Tango",
      callSigns: ["Tango"],
      defaultPromptAgent: "watson",
    });
  });

  it("falls back to built-in defaults when no system.yaml exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-system-identity-"));
    process.env.TANGO_CONFIG_DIR = dir;

    expect(loadSystemIdentity(dir)).toEqual(DEFAULT_SYSTEM_IDENTITY);
  });

  it("applies overrides from system.yaml", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-system-identity-"));
    fs.writeFileSync(
      path.join(dir, "system.yaml"),
      ["display_name: Hub", "voice:", "  call_signs: [Hub, ' Base ']", "  default_prompt_agent: sierra"].join("\n"),
    );
    process.env.TANGO_CONFIG_DIR = dir;

    expect(loadSystemIdentity(dir)).toEqual({
      displayName: "Hub",
      callSigns: ["Hub", "Base"],
      defaultPromptAgent: "sierra",
    });
  });
});
