import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveConfiguredPath,
  resolveTangoProfileConfigDir,
  resolveTangoProfileDataDir,
  resolveTangoProfileDir,
  resolveTangoProfileLogsDir,
} from "@tango/core";

/** packages/system/{src,dist}/paths.* → the repo checkout this package lives in. */
export function repoRoot(): string {
  const fromEnv = process.env.TANGO_REPO_DIR?.trim();
  if (fromEnv) return resolveConfiguredPath(fromEnv);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function profileDir(): string {
  return resolveTangoProfileDir();
}

export function profileDataDir(): string {
  return resolveTangoProfileDataDir();
}

export function profileConfigDir(): string {
  return resolveTangoProfileConfigDir();
}

export function profileLogsDir(): string {
  return resolveTangoProfileLogsDir();
}

/** `TANGO_SYSTEM_DB` wins; otherwise `<profile>/data/system.sqlite`. */
export function resolveSystemDbPath(explicit?: string): string {
  const configured = explicit?.trim() || process.env.TANGO_SYSTEM_DB?.trim();
  if (configured) return resolveConfiguredPath(configured);
  return path.join(profileDataDir(), "system.sqlite");
}

/** The bot's database (schedule_runs), read-only for the tick. */
export function resolveTangoDbPath(): string {
  const configured = process.env.TANGO_DB_PATH?.trim();
  if (configured) return resolveConfiguredPath(configured);
  return path.join(profileDataDir(), "tango.sqlite");
}

/** The env file the healthcheck reads (DISCORD_TOKEN, alert channel). */
export function resolveEnvFile(): string {
  const configured = process.env.TANGO_ENV_FILE?.trim();
  if (configured) return resolveConfiguredPath(configured);
  return path.join(repoRoot(), ".env");
}

export function readEnvFileValue(name: string, file = resolveEnvFile()): string | undefined {
  const fromEnv = process.env[name]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m && m[1] === name) return m[2]!.trim().replace(/^["']|["']$/g, "") || undefined;
    }
  } catch {
    // no env file
  }
  return undefined;
}
