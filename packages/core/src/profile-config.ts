import fs from "node:fs";
import path from "node:path";
import { resolveRepoDefaultsConfigDir } from "./config-layering.js";
import { resolveConfiguredPath, resolveTangoProfileConfigDir } from "./runtime-paths.js";

export interface ProfileConfigTextOptions {
  relativePath: string;
  envPathVar?: string;
  envValueVar?: string;
}

export interface ProfileConfigStringListOptions extends ProfileConfigTextOptions {
  lowercase?: boolean;
}

function normalizeRelativePath(relativePath: string): string {
  const normalized = relativePath.trim();
  if (!normalized || path.isAbsolute(normalized) || normalized.split(/[\\/]+/u).includes("..")) {
    throw new Error(`Profile config relativePath must be a safe relative path: ${relativePath}`);
  }
  return normalized;
}

function resolveEnvConfiguredFile(envPathVar?: string): string | undefined {
  const envPath = envPathVar ? process.env[envPathVar]?.trim() : undefined;
  return envPath ? resolveConfiguredPath(envPath) : undefined;
}

function layeredProfileConfigFiles(relativePath: string): string[] {
  const candidates: string[] = [];
  const safeRelativePath = normalizeRelativePath(relativePath);
  const defaultsDir = resolveRepoDefaultsConfigDir();
  if (defaultsDir) {
    candidates.push(path.join(defaultsDir, safeRelativePath));
  }
  candidates.push(path.join(resolveTangoProfileConfigDir(), safeRelativePath));

  return candidates;
}

function readTextIfAvailable(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function parseListText(text: string, lowercase: boolean): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.replace(/#.*$/u, "").trim())
    .filter((line) => line.length > 0)
    .map((line) => lowercase ? line.toLowerCase() : line);
}

export function readProfileConfigString(options: ProfileConfigTextOptions): string | undefined {
  const directValue = options.envValueVar ? process.env[options.envValueVar]?.trim() : undefined;
  if (directValue) {
    return directValue;
  }

  // An explicit env-configured file is a deliberate override: when it yields a
  // value, it wins over both repo defaults and the profile layer.
  const envFile = resolveEnvConfiguredFile(options.envPathVar);
  if (envFile) {
    const envText = readTextIfAvailable(envFile);
    const envValue = envText === undefined ? undefined : parseListText(envText, false)[0];
    if (envValue) {
      return envValue;
    }
  }

  let value: string | undefined;
  for (const filePath of layeredProfileConfigFiles(options.relativePath)) {
    const text = readTextIfAvailable(filePath);
    if (text === undefined) {
      continue;
    }
    const firstValue = parseListText(text, false)[0];
    if (firstValue) {
      value = firstValue;
    }
  }
  return value;
}

export function readProfileConfigStringList(
  options: ProfileConfigStringListOptions,
): string[] {
  const values: string[] = [];

  const directValue = options.envValueVar ? process.env[options.envValueVar]?.trim() : undefined;
  if (directValue) {
    values.push(...parseListText(directValue.replace(/,/gu, "\n"), options.lowercase ?? false));
  }

  const envFile = resolveEnvConfiguredFile(options.envPathVar);
  const candidateFiles = [
    ...(envFile ? [envFile] : []),
    ...layeredProfileConfigFiles(options.relativePath),
  ];
  for (const filePath of candidateFiles) {
    const text = readTextIfAvailable(filePath);
    if (text !== undefined) {
      values.push(...parseListText(text, options.lowercase ?? false));
    }
  }

  return [...new Set(values)];
}
