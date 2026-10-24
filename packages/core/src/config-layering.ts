import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import {
  resolveConfiguredConfigDir,
  resolveConfiguredPath,
  resolveTangoProfileConfigDir,
} from "./runtime-paths.js";

export type ConfigCategory =
  | "agents"
  | "attachment-retention-rules"
  | "browser-sites"
  | "intent-contracts"
  | "projects"
  | "schedules"
  | "sessions"
  | "state-type-packs"
  | "state-views"
  | "tool-contracts"
  | "workflows"
  | "workers";

export type ConfigLayerRole = "defaults" | "explicit" | "profile";

export interface ConfigLayer {
  label: string;
  role: ConfigLayerRole;
  dir: string;
}

export interface ConfigSourceRecord {
  layer: string;
  role: ConfigLayerRole;
  dir: string;
  filePath: string;
}

export interface ConfigTraceEntry {
  id: string;
  category: ConfigCategory;
  mergedRaw: Record<string, unknown>;
  sourceFiles: ConfigSourceRecord[];
  fieldSources: Record<string, string>;
}

const rawConfigEntrySchema = z.object({
  id: z.string().min(1),
}).passthrough();

function normalizeOptionalString(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function findExistingConfigDir(baseDir: string, configPathSegments: string[]): string | undefined {
  let current = path.resolve(baseDir);

  while (true) {
    const candidate = path.join(current, ...configPathSegments);
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function sameResolvedPath(left?: string, right?: string): boolean {
  if (!left || !right) {
    return false;
  }
  return path.resolve(left) === path.resolve(right);
}

export function resolveRepoDefaultsConfigDir(baseDir = process.cwd()): string | undefined {
  const defaultsDir = findExistingConfigDir(baseDir, ["config", "defaults"]);
  if (defaultsDir) {
    return defaultsDir;
  }

  const legacyDir = findExistingConfigDir(baseDir, ["config"]);
  if (legacyDir) {
    return legacyDir;
  }

  return undefined;
}

function buildDefaultConfigLayers(): ConfigLayer[] {
  const layers: ConfigLayer[] = [];
  const defaultsDir = resolveRepoDefaultsConfigDir();
  const profileDir = resolveTangoProfileConfigDir();

  if (defaultsDir) {
    layers.push({
      label: "defaults",
      role: "defaults",
      dir: defaultsDir,
    });
  }

  if (fs.existsSync(profileDir) && !sameResolvedPath(defaultsDir, profileDir)) {
    layers.push({
      label: "profile",
      role: "profile",
      dir: profileDir,
    });
  }

  if (layers.length > 0) {
    return layers;
  }

  return [
    {
      label: "profile",
      role: "profile",
      dir: profileDir,
    },
  ];
}

export function resolveConfigLayers(configDir?: string): ConfigLayer[] {
  const explicitEnvDir = normalizeOptionalString(process.env.TANGO_CONFIG_DIR);
  const requestedDir = normalizeOptionalString(configDir);

  if (requestedDir) {
    const resolvedRequestedDir = resolveConfiguredConfigDir(requestedDir);
    const defaultsDir = resolveRepoDefaultsConfigDir();
    const profileDir = resolveTangoProfileConfigDir();

    if (explicitEnvDir && sameResolvedPath(resolvedRequestedDir, resolveConfiguredConfigDir(explicitEnvDir))) {
      return [
        {
          label: "explicit",
          role: "explicit",
          dir: resolvedRequestedDir,
        },
      ];
    }

    if (defaultsDir && sameResolvedPath(resolvedRequestedDir, defaultsDir)) {
      return buildDefaultConfigLayers();
    }

    if (sameResolvedPath(resolvedRequestedDir, profileDir)) {
      return [
        {
          label: "profile",
          role: "profile",
          dir: resolvedRequestedDir,
        },
      ];
    }

    return [
      {
        label: "explicit",
        role: "explicit",
        dir: resolvedRequestedDir,
      },
    ];
  }

  if (explicitEnvDir) {
    return [
      {
        label: "explicit",
        role: "explicit",
        dir: resolveConfiguredConfigDir(explicitEnvDir),
      },
    ];
  }

  return buildDefaultConfigLayers();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as T;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneValue(item)]),
    ) as T;
  }
  return value;
}

function deepMergeValues(base: unknown, override: unknown): unknown {
  if (Array.isArray(override)) {
    return cloneValue(override);
  }

  if (isPlainObject(base) && isPlainObject(override)) {
    const merged: Record<string, unknown> = Object.fromEntries(
      Object.entries(base).map(([key, value]) => [key, cloneValue(value)]),
    );

    for (const [key, value] of Object.entries(override)) {
      merged[key] = key in merged ? deepMergeValues(merged[key], value) : cloneValue(value);
    }

    return merged;
  }

  return cloneValue(override);
}

function recordTopLevelFieldSources(
  rawEntry: Record<string, unknown>,
  filePath: string,
): Record<string, string> {
  return Object.fromEntries(Object.keys(rawEntry).map((key) => [key, filePath]));
}

function collectLayeredConfigEntries(input: {
  category: ConfigCategory;
  configDir?: string;
  required: boolean;
}): ConfigTraceEntry[] {
  const layers = resolveConfigLayers(input.configDir);
  const entries = new Map<string, ConfigTraceEntry>();
  let discoveredDirectory = false;

  for (const layer of layers) {
    const categoryDir = path.join(layer.dir, input.category);
    if (!fs.existsSync(categoryDir)) {
      continue;
    }
    discoveredDirectory = true;

    const files = fs
      .readdirSync(categoryDir)
      .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
      .sort();

    const seenIds = new Set<string>();
    for (const file of files) {
      const fullPath = path.join(categoryDir, file);
      const rawDocument = yaml.load(fs.readFileSync(fullPath, "utf8"));
      if (!isPlainObject(rawDocument)) {
        throw new Error(
          `Config file ${fullPath} in ${input.category} must contain a YAML object.`,
        );
      }

      const rawEntry = rawConfigEntrySchema.parse(rawDocument);
      if (seenIds.has(rawEntry.id)) {
        throw new Error(
          `Duplicate ${input.category} config id '${rawEntry.id}' within ${categoryDir}.`,
        );
      }
      seenIds.add(rawEntry.id);

      const existing = entries.get(rawEntry.id);
      entries.set(rawEntry.id, {
        id: rawEntry.id,
        category: input.category,
        mergedRaw: existing
          ? deepMergeValues(existing.mergedRaw, rawEntry) as Record<string, unknown>
          : cloneValue(rawEntry),
        sourceFiles: [
          ...(existing?.sourceFiles ?? []),
          {
            layer: layer.label,
            role: layer.role,
            dir: layer.dir,
            filePath: fullPath,
          },
        ],
        fieldSources: {
          ...(existing?.fieldSources ?? {}),
          ...recordTopLevelFieldSources(rawEntry, fullPath),
        },
      });
    }
  }

  if (entries.size === 0) {
    if (input.required) {
      const searched = layers
        .map((layer) => path.join(layer.dir, input.category))
        .join(", ");
      if (discoveredDirectory) {
        throw new Error(`No ${input.category} yaml files found in ${searched}`);
      }
      throw new Error(`Config directory not found for ${input.category}: ${searched}`);
    }
    return [];
  }

  return [...entries.values()];
}

export function loadLayeredConfigCategory<Parsed, Mapped>(input: {
  category: ConfigCategory;
  configDir?: string;
  required: boolean;
  schema: z.ZodType<Parsed>;
  map: (parsed: Parsed, trace: ConfigTraceEntry) => Mapped;
}): Mapped[] {
  return collectLayeredConfigEntries({
    category: input.category,
    configDir: input.configDir,
    required: input.required,
  }).map((trace) => input.map(input.schema.parse(trace.mergedRaw), trace));
}

export function traceConfigCategory(input: {
  category: ConfigCategory;
  configDir?: string;
  id?: string;
}): ConfigTraceEntry[] {
  const traces = collectLayeredConfigEntries({
    category: input.category,
    configDir: input.configDir,
    required: false,
  });

  if (!input.id) {
    return traces;
  }

  return traces.filter((trace) => trace.id === input.id);
}

/**
 * Load a single top-level YAML file (e.g. `system.yaml`) from every config
 * layer and deep-merge it, later layers winning. Returns undefined when no
 * layer has the file.
 */
export function loadLayeredConfigFile(
  fileName: string,
  configDir?: string,
): Record<string, unknown> | undefined {
  let merged: Record<string, unknown> | undefined;
  for (const layer of resolveConfigLayers(configDir)) {
    const filePath = path.join(layer.dir, fileName);
    if (!fs.existsSync(filePath)) continue;
    const rawDocument = yaml.load(fs.readFileSync(filePath, "utf8"));
    if (rawDocument == null) continue;
    if (!isPlainObject(rawDocument)) {
      throw new Error(`Config file ${filePath} must contain a YAML object.`);
    }
    merged = merged
      ? deepMergeValues(merged, rawDocument) as Record<string, unknown>
      : cloneValue(rawDocument);
  }
  return merged;
}
