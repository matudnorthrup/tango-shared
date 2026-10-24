import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadPreferences,
  recordPreference,
  resolveWalmartDataDir,
  summarizePreferences,
} from "../src/walmart-cart-processor.js";

describe("walmart cart processor data paths", () => {
  const originalDataDir = process.env.TANGO_DATA_DIR;
  const originalWalmartDataDir = process.env.TANGO_WALMART_DATA_DIR;
  const originalHome = process.env.TANGO_HOME;
  const originalProfile = process.env.TANGO_PROFILE;
  const originalCwd = process.cwd();
  const tempDirs: string[] = [];

  afterEach(() => {
    process.chdir(originalCwd);
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    if (originalDataDir === undefined) {
      delete process.env.TANGO_DATA_DIR;
    } else {
      process.env.TANGO_DATA_DIR = originalDataDir;
    }

    if (originalWalmartDataDir === undefined) {
      delete process.env.TANGO_WALMART_DATA_DIR;
    } else {
      process.env.TANGO_WALMART_DATA_DIR = originalWalmartDataDir;
    }

    if (originalHome === undefined) {
      delete process.env.TANGO_HOME;
    } else {
      process.env.TANGO_HOME = originalHome;
    }

    if (originalProfile === undefined) {
      delete process.env.TANGO_PROFILE;
    } else {
      process.env.TANGO_PROFILE = originalProfile;
    }
  });

  it("uses the legacy repo data directory when one is present", () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-walmart-legacy-repo-"));
    tempDirs.push(repoDir);
    fs.mkdirSync(path.join(repoDir, "data"), { recursive: true });
    process.chdir(repoDir);
    delete process.env.TANGO_DATA_DIR;
    delete process.env.TANGO_WALMART_DATA_DIR;
    expect(fs.realpathSync(resolveWalmartDataDir())).toBe(
      fs.realpathSync(path.join(repoDir, "data")),
    );
  });

  it("falls back to the profile data dir for a clean install", () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-walmart-repo-"));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-walmart-home-"));
    tempDirs.push(repoDir, homeDir);
    process.chdir(repoDir);
    delete process.env.TANGO_DATA_DIR;
    delete process.env.TANGO_WALMART_DATA_DIR;
    process.env.TANGO_HOME = homeDir;
    process.env.TANGO_PROFILE = "default";

    expect(resolveWalmartDataDir()).toBe(
      path.join(homeDir, "profiles", "default", "data"),
    );
  });

  it("reads and writes preferences under the configured data dir", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-walmart-data-"));
    process.env.TANGO_WALMART_DATA_DIR = tempDir;
    delete process.env.TANGO_DATA_DIR;

    expect(loadPreferences()).toEqual({ preferences: [] });

    recordPreference(
      "light greek vanilla yogurt",
      "Store Brand Light Greek Vanilla Yogurt",
      "12345",
    );

    expect(loadPreferences()).toEqual({
      preferences: [
        {
          query: "light greek vanilla yogurt",
          selectedItemName: "Store Brand Light Greek Vanilla Yogurt",
          selectedItemId: "12345",
          timesSelected: 1,
          lastSelected: expect.any(String),
        },
      ],
    });

    expect(summarizePreferences()).toEqual({
      total: 1,
      preferences: [
        {
          query: "light greek vanilla yogurt",
          selected_item: "Store Brand Light Greek Vanilla Yogurt",
          item_id: "12345",
          times_selected: 1,
          last_selected: expect.any(String),
          auto_add_eligible: false,
        },
      ],
    });

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
