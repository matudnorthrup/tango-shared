import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TangoProfilePathOptions {
  homeDir?: string;
  profile?: string;
}

function findExistingAncestorPath(baseDir: string, childName: string): string | undefined {
  let current = path.resolve(baseDir);
  let lastMatch: string | undefined;

  while (true) {
    const candidate = path.join(current, childName);
    if (fs.existsSync(candidate)) {
      lastMatch = candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return lastMatch;
    }
    current = parent;
  }
}

function normalizeOptionalString(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function hasExplicitProfileRuntimeSelection(): boolean {
  return Boolean(
    normalizeOptionalString(process.env.TANGO_HOME)
    || normalizeOptionalString(process.env.TANGO_PROFILE),
  );
}

export function expandHomePath(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function resolveConfiguredPath(input: string): string {
  return path.resolve(expandHomePath(input.trim()));
}

const CONFIG_CATEGORY_DIRS = [
  "agents",
  "intent-contracts",
  "projects",
  "schedules",
  "sessions",
  "state-type-packs",
  "state-views",
  "tool-contracts",
  "workflows",
  "workers",
];

function directoryContainsConfigCategories(dir: string): boolean {
  return CONFIG_CATEGORY_DIRS.some((name) => fs.existsSync(path.join(dir, name)));
}

export function resolveConfiguredConfigDir(input: string): string {
  const resolved = resolveConfiguredPath(input);
  const defaultsDir = path.join(resolved, "defaults");

  if (
    !directoryContainsConfigCategories(resolved)
    && directoryContainsConfigCategories(defaultsDir)
  ) {
    return defaultsDir;
  }

  return resolved;
}

export function resolveTangoHome(explicitHome?: string): string {
  const configuredHome =
    normalizeOptionalString(explicitHome) ?? normalizeOptionalString(process.env.TANGO_HOME);
  return configuredHome
    ? resolveConfiguredPath(configuredHome)
    : path.join(os.homedir(), ".tango");
}

export function resolveTangoProfileName(explicitProfile?: string): string {
  return (
    normalizeOptionalString(explicitProfile)
    ?? normalizeOptionalString(process.env.TANGO_PROFILE)
    ?? "default"
  );
}

export function resolveTangoProfilesDir(options: TangoProfilePathOptions = {}): string {
  return path.join(resolveTangoHome(options.homeDir), "profiles");
}

export function resolveTangoProfileDir(options: TangoProfilePathOptions = {}): string {
  return path.join(
    resolveTangoProfilesDir(options),
    resolveTangoProfileName(options.profile),
  );
}

export function resolveTangoProfileConfigDir(
  options: TangoProfilePathOptions = {},
): string {
  return path.join(resolveTangoProfileDir(options), "config");
}

export function resolveTangoProfileDataDir(
  options: TangoProfilePathOptions = {},
): string {
  return path.join(resolveTangoProfileDir(options), "data");
}

export function resolveTangoProfilePromptsDir(
  options: TangoProfilePathOptions = {},
): string {
  return path.join(resolveTangoProfileDir(options), "prompts");
}

export function resolveTangoProfileToolPromptsDir(
  options: TangoProfilePathOptions = {},
): string {
  return path.join(resolveTangoProfilePromptsDir(options), "tools");
}

export function resolveTangoProfileSkillPromptsDir(
  options: TangoProfilePathOptions = {},
): string {
  return path.join(resolveTangoProfilePromptsDir(options), "skills");
}

export function resolveTangoProfileSharedPromptDir(
  options: TangoProfilePathOptions = {},
): string {
  return path.join(resolveTangoProfilePromptsDir(options), "shared");
}

export function resolveTangoProfileSharedPromptLookupDirs(
  options: TangoProfilePathOptions = {},
): string[] {
  return [
    resolveTangoProfileSharedPromptDir(options),
    path.join(resolveTangoProfileDir(options), "agents", "shared"),
  ];
}

export function resolveTangoProfileAgentsDir(
  options: TangoProfilePathOptions = {},
): string {
  return path.join(resolveTangoProfileDir(options), "agents");
}

export function resolveTangoProfileAgentPromptDir(
  agentId: string,
  options: TangoProfilePathOptions = {},
): string {
  return path.join(resolveTangoProfilePromptsDir(options), "agents", agentId);
}

export function resolveTangoProfileAgentPromptDirs(
  agentId: string,
  options: TangoProfilePathOptions = {},
): string[] {
  const suffix = "-ollama";
  const ids = agentId.endsWith(suffix)
    ? [agentId.slice(0, -suffix.length), agentId]
    : [agentId];

  return [...new Set(ids.map((id) => resolveTangoProfileAgentPromptDir(id, options)))];
}

export function resolveTangoProfileWorkerPromptDir(
  workerId: string,
  options: TangoProfilePathOptions = {},
): string {
  return path.join(resolveTangoProfilePromptsDir(options), "workers", workerId);
}

export function resolveTangoProfileCacheDir(
  options: TangoProfilePathOptions = {},
): string {
  return path.join(resolveTangoProfileDir(options), "cache");
}

export function resolveTangoProfileLogsDir(
  options: TangoProfilePathOptions = {},
): string {
  return path.join(resolveTangoProfileDir(options), "logs");
}

export function resolveLegacyDatabasePath(baseDir = process.cwd()): string {
  return path.join(resolveLegacyDataDir(baseDir), "tango.sqlite");
}

export function resolveLegacyDataDir(baseDir = process.cwd()): string {
  return findExistingAncestorPath(baseDir, "data") ?? path.resolve(baseDir, "data");
}

export function resolveLegacyConfigPath(baseDir = process.cwd()): string {
  return findExistingAncestorPath(baseDir, "config") ?? path.resolve(baseDir, "config");
}

export function resolveTangoDataDir(explicitDir?: string): string {
  const configuredDir =
    normalizeOptionalString(explicitDir) ?? normalizeOptionalString(process.env.TANGO_DATA_DIR);
  if (configuredDir) {
    return resolveConfiguredPath(configuredDir);
  }

  if (hasExplicitProfileRuntimeSelection()) {
    return resolveTangoProfileDataDir();
  }

  const legacyDir = resolveLegacyDataDir();
  if (fs.existsSync(legacyDir)) {
    return legacyDir;
  }

  return resolveTangoProfileDataDir();
}

export function resolveTangoDataPath(...segments: string[]): string {
  return path.join(resolveTangoDataDir(), ...segments);
}

export function resolveDatabasePath(explicitPath?: string): string {
  const configuredPath =
    normalizeOptionalString(explicitPath) ?? normalizeOptionalString(process.env.TANGO_DB_PATH);
  if (configuredPath) {
    return resolveConfiguredPath(configuredPath);
  }

  if (normalizeOptionalString(process.env.TANGO_DATA_DIR)) {
    return path.join(resolveTangoDataDir(), "tango.sqlite");
  }

  if (hasExplicitProfileRuntimeSelection()) {
    return path.join(resolveTangoProfileDataDir(), "tango.sqlite");
  }

  const legacyPath = resolveLegacyDatabasePath();
  if (fs.existsSync(legacyPath)) {
    return legacyPath;
  }

  return path.join(resolveTangoProfileDataDir(), "tango.sqlite");
}

export function buildRuntimePathEnv(input: {
  dbPath?: string;
  homeDir?: string;
  profile?: string;
  configDir?: string;
} = {}): Record<string, string> {
  const env: Record<string, string> = {
    TANGO_DB_PATH: resolveDatabasePath(input.dbPath),
    TANGO_HOME: resolveTangoHome(input.homeDir),
    TANGO_PROFILE: resolveTangoProfileName(input.profile),
  };

  const configuredConfigDir =
    normalizeOptionalString(input.configDir) ?? normalizeOptionalString(process.env.TANGO_CONFIG_DIR);
  if (configuredConfigDir) {
    env.TANGO_CONFIG_DIR = resolveConfiguredConfigDir(configuredConfigDir);
  }

  return env;
}
