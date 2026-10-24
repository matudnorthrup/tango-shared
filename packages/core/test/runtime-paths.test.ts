import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRuntimePathEnv,
  resolveDatabasePath,
  resolveConfiguredConfigDir,
  resolveTangoHome,
  resolveTangoProfileCacheDir,
  resolveTangoProfileDataDir,
  resolveTangoProfileDir,
  resolveTangoProfileLogsDir,
} from "../src/runtime-paths.js";

const tempDirs: string[] = [];
const originalEnv = { ...process.env };
const originalCwd = process.cwd();

beforeEach(() => {
  // These path-resolution tests supply their own fixtures. Do not inherit the
  // temporary database override used to isolate the rest of the test suite.
  delete process.env.TANGO_DB_PATH;
});

afterEach(() => {
  process.chdir(originalCwd);

  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("runtime path helpers", () => {
  it("resolves Tango home and profile directories from env", () => {
    const homeDir = createTempDir("tango-home-");
    process.env.TANGO_HOME = homeDir;
    process.env.TANGO_PROFILE = "personal";

    expect(resolveTangoHome()).toBe(homeDir);
    expect(resolveTangoProfileDir()).toBe(path.join(homeDir, "profiles", "personal"));
    expect(resolveTangoProfileDataDir()).toBe(
      path.join(homeDir, "profiles", "personal", "data"),
    );
    expect(resolveTangoProfileCacheDir()).toBe(
      path.join(homeDir, "profiles", "personal", "cache"),
    );
    expect(resolveTangoProfileLogsDir()).toBe(
      path.join(homeDir, "profiles", "personal", "logs"),
    );
  });

  it("resolves an explicit database path with home directory expansion", () => {
    const explicit = resolveDatabasePath("~/tango-tests/profile.sqlite");
    expect(explicit).toBe(
      path.join(os.homedir(), "tango-tests", "profile.sqlite"),
    );
  });

  it("keeps using the legacy repo-local database when it already exists", () => {
    const repoDir = createTempDir("tango-legacy-db-");
    fs.mkdirSync(path.join(repoDir, "data"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "data", "tango.sqlite"), "");
    process.chdir(repoDir);

    expect(fs.realpathSync(resolveDatabasePath())).toBe(
      fs.realpathSync(path.join(repoDir, "data", "tango.sqlite")),
    );
  });

  it("prefers the profile data directory when profile mode is explicitly selected", () => {
    const repoDir = createTempDir("tango-explicit-profile-db-");
    const homeDir = createTempDir("tango-explicit-profile-home-");
    fs.mkdirSync(path.join(repoDir, "data"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "data", "tango.sqlite"), "");
    process.chdir(repoDir);
    process.env.TANGO_HOME = homeDir;
    process.env.TANGO_PROFILE = "default";

    expect(resolveTangoProfileDataDir()).toBe(
      path.join(homeDir, "profiles", "default", "data"),
    );
    expect(resolveDatabasePath()).toBe(
      path.join(homeDir, "profiles", "default", "data", "tango.sqlite"),
    );
  });

  it("falls back to the profile data directory for a clean install", () => {
    const repoDir = createTempDir("tango-clean-install-");
    const homeDir = createTempDir("tango-home-");
    process.chdir(repoDir);
    process.env.TANGO_HOME = homeDir;
    process.env.TANGO_PROFILE = "default";

    expect(resolveDatabasePath()).toBe(
      path.join(homeDir, "profiles", "default", "data", "tango.sqlite"),
    );
  });

  it("builds a consistent runtime env payload", () => {
    const repoDir = createTempDir("tango-env-repo-");
    const homeDir = createTempDir("tango-env-home-");
    process.chdir(repoDir);
    process.env.TANGO_HOME = homeDir;
    process.env.TANGO_PROFILE = "observed";

    const runtimeEnv = buildRuntimePathEnv({
      configDir: "~/tango-tests/config",
    });

    expect(runtimeEnv).toEqual({
      TANGO_DB_PATH: path.join(homeDir, "profiles", "observed", "data", "tango.sqlite"),
      TANGO_HOME: homeDir,
      TANGO_PROFILE: "observed",
      TANGO_CONFIG_DIR: path.join(os.homedir(), "tango-tests", "config"),
    });
  });

  it("normalizes a repo config root to config/defaults when inheriting runtime env", () => {
    const repoDir = createTempDir("tango-env-defaults-root-");
    const homeDir = createTempDir("tango-env-defaults-home-");
    fs.mkdirSync(path.join(repoDir, "config", "defaults", "sessions"), { recursive: true });
    process.chdir(repoDir);
    process.env.TANGO_HOME = homeDir;
    process.env.TANGO_PROFILE = "default";

    expect(fs.realpathSync(resolveConfiguredConfigDir("./config"))).toBe(
      fs.realpathSync(path.join(repoDir, "config", "defaults")),
    );

    const runtimeEnv = buildRuntimePathEnv({
      configDir: "./config",
    });

    expect(runtimeEnv).toEqual({
      TANGO_DB_PATH: path.join(homeDir, "profiles", "default", "data", "tango.sqlite"),
      TANGO_HOME: homeDir,
      TANGO_PROFILE: "default",
      TANGO_CONFIG_DIR: fs.realpathSync(path.join(repoDir, "config", "defaults")),
    });
  });
});
