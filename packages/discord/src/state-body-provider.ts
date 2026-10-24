import fs from "node:fs";
import path from "node:path";
import { resolveTangoProfileDir } from "@tango/core";

export type StateBodyProviderId = "obsidian" | "profile";

export interface StateBodyPointer {
  provider: StateBodyProviderId;
  path: string;
  uri: string;
  displayPath: string;
}

export interface StateBodyReadRoots {
  vaultRoot?: string;
  profileRoot?: string;
}

export const PROFILE_STATE_BODY_NAMESPACES = [
  "threads",
  "collab",
  "specs",
  "reference",
] as const;

const PROFILE_STATE_BODY_NAMESPACE_SET = new Set<string>(PROFILE_STATE_BODY_NAMESPACES);
const STATE_BODY_PROVIDERS = new Set<StateBodyProviderId>(["obsidian", "profile"]);

function isStateBodyProviderId(value: string): value is StateBodyProviderId {
  return STATE_BODY_PROVIDERS.has(value as StateBodyProviderId);
}

function parseExplicitProviderPointer(
  input: string,
): { provider: StateBodyProviderId; path: string } | undefined {
  const match = /^([a-z][a-z0-9+.-]*):(.*)$/iu.exec(input);
  if (!match) return undefined;

  const provider = match[1]!.toLowerCase();
  if (!isStateBodyProviderId(provider)) return undefined;

  return { provider, path: match[2] ?? "" };
}

function assertContainedPath(parent: string, child: string, message: string): void {
  const relative = path.relative(parent, child);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error(message);
}

function nearestExistingAncestor(targetPath: string, boundaryPath: string): string {
  let current = targetPath;
  const boundary = path.resolve(boundaryPath);

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return boundary;
    if (!assertPathWithinOrEqual(boundary, parent)) return boundary;
    current = parent;
  }

  return current;
}

function assertPathWithinOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeProfileStateBodyPath(input: string): string {
  const raw = input.trim();
  if (raw.length === 0) {
    throw new Error("Profile state body path is required");
  }
  if (raw.includes("\0")) {
    throw new Error("Profile state body path cannot contain NUL bytes");
  }
  if (raw.includes("\\")) {
    throw new Error("Profile state body path must use forward slashes");
  }
  if (path.isAbsolute(raw) || raw.startsWith("~/")) {
    throw new Error("Profile state body path must be relative to the active profile");
  }

  const parts = raw.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("Profile state body path cannot traverse directories");
  }

  const namespace = parts[0]!;
  if (!PROFILE_STATE_BODY_NAMESPACE_SET.has(namespace)) {
    throw new Error(
      `Profile state body path must start with one of: ${PROFILE_STATE_BODY_NAMESPACES.join(", ")}`,
    );
  }

  if (path.posix.extname(parts[parts.length - 1]!).toLowerCase() !== ".md") {
    throw new Error("Profile state body path must point to a markdown .md file");
  }

  return parts.join("/");
}

export function normalizeProfileStateBodyDirectoryPath(input: string): string {
  const raw = input.trim().replace(/\/+$/u, "");
  if (raw.length === 0) {
    return "";
  }
  if (raw.includes("\0")) {
    throw new Error("Profile state body directory cannot contain NUL bytes");
  }
  if (raw.includes("\\")) {
    throw new Error("Profile state body directory must use forward slashes");
  }
  if (path.isAbsolute(raw) || raw.startsWith("~/")) {
    throw new Error("Profile state body directory must be relative to the active profile");
  }

  const parts = raw.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("Profile state body directory cannot traverse directories");
  }

  const namespace = parts[0]!;
  if (!PROFILE_STATE_BODY_NAMESPACE_SET.has(namespace)) {
    throw new Error(
      `Profile state body directory must start with one of: ${PROFILE_STATE_BODY_NAMESPACES.join(", ")}`,
    );
  }

  if (path.posix.extname(parts[parts.length - 1]!).toLowerCase() === ".md") {
    throw new Error("Profile state body list path must be a directory, not a markdown file");
  }

  return parts.join("/");
}

export function parseStateBodyPointer(
  input: string,
  options: { provider?: StateBodyProviderId } = {},
): StateBodyPointer {
  const raw = input.trim();
  if (raw.length === 0) {
    throw new Error("State body pointer is required");
  }
  if (options.provider && !isStateBodyProviderId(options.provider)) {
    throw new Error(`Unsupported state body provider: ${options.provider}`);
  }

  const explicit = parseExplicitProviderPointer(raw);
  if (explicit && options.provider && explicit.provider !== options.provider) {
    throw new Error(
      `State body pointer provider ${explicit.provider} does not match --provider ${options.provider}`,
    );
  }

  const provider = options.provider ?? explicit?.provider ?? "obsidian";
  const pointerPath = explicit ? explicit.path : raw;

  if (provider === "profile") {
    const normalized = normalizeProfileStateBodyPath(pointerPath);
    const uri = `profile:${normalized}`;
    return { provider, path: normalized, uri, displayPath: uri };
  }

  const obsidianPath = pointerPath.trim();
  if (obsidianPath.length === 0) {
    throw new Error("Obsidian state body path is required");
  }
  return {
    provider: "obsidian",
    path: obsidianPath,
    uri: obsidianPath,
    displayPath: obsidianPath,
  };
}

export function formatStateBodyPointer(pointer: StateBodyPointer): string {
  return pointer.uri;
}

function resolveProfileRoot(profileRootInput?: string): string {
  return path.resolve(profileRootInput ?? resolveTangoProfileDir());
}

function resolveAndGuardProfilePath(
  relativePath: string,
  options: { profileRoot?: string } = {},
): string {
  const [namespace] = relativePath.split("/");
  const profileRoot = resolveProfileRoot(options.profileRoot);
  const absolutePath = relativePath
    ? path.resolve(profileRoot, ...relativePath.split("/"))
    : profileRoot;

  assertContainedPath(
    profileRoot,
    absolutePath,
    "Profile state body path escapes the active profile",
  );

  if (!namespace) {
    return absolutePath;
  }

  const namespaceRoot = path.resolve(profileRoot, namespace);
  if (fs.existsSync(namespaceRoot)) {
    const profileRealPath = fs.realpathSync(profileRoot);
    const namespaceRealPath = fs.realpathSync(namespaceRoot);
    assertContainedPath(
      profileRealPath,
      namespaceRealPath,
      "Profile state body namespace escapes the active profile",
    );

    const existingAncestor = nearestExistingAncestor(absolutePath, namespaceRoot);
    const targetRealPath = fs.realpathSync(existingAncestor);
    assertContainedPath(
      namespaceRealPath,
      targetRealPath,
      "Profile state body path escapes its allowed namespace",
    );
  }

  return absolutePath;
}

export function resolveProfileStateBodyPath(
  profilePath: string,
  options: { profileRoot?: string } = {},
): string {
  return resolveAndGuardProfilePath(normalizeProfileStateBodyPath(profilePath), options);
}

export function resolveProfileStateBodyDirectoryPath(
  profilePath: string,
  options: { profileRoot?: string } = {},
): string {
  return resolveAndGuardProfilePath(normalizeProfileStateBodyDirectoryPath(profilePath), options);
}

export function readStateBody(
  pointerOrInput: StateBodyPointer | string,
  roots: StateBodyReadRoots = {},
): string | undefined {
  const pointer = typeof pointerOrInput === "string"
    ? parseStateBodyPointer(pointerOrInput)
    : pointerOrInput;

  try {
    if (pointer.provider === "profile") {
      const filePath = resolveProfileStateBodyPath(pointer.path, {
        profileRoot: roots.profileRoot,
      });
      return fs.readFileSync(filePath, "utf8");
    }

    if (!roots.vaultRoot) {
      return undefined;
    }
    return fs.readFileSync(path.join(roots.vaultRoot, pointer.path), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
