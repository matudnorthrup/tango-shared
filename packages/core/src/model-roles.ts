/**
 * Model roles — bake-off-backed, retirement-proof Ollama model assignment.
 *
 * Configs may name `role:<name>` instead of a concrete Ollama model id. A role
 * is an ORDERED list of models that each passed the role's bake-off fixtures
 * (config/model-roles.yaml). At request time the first entry still present in
 * the live Ollama Cloud catalog wins, so a retirement falls through to the next
 * tested model instead of failing every call — the failure mode behind four
 * silent outages in 2026 (ministral router, qwen3-vl vision, glm-5,
 * minimax-m2.5). Nothing untested is ever promoted: only listed models run, and
 * the weekly model scorecard flags any role serving a non-primary entry.
 *
 * Claude models don't need roles: the CLI's family aliases (opus/sonnet/haiku)
 * already float, and Anthropic retires ids on long notice.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";

export const MODEL_ROLE_PREFIX = "role:";

export interface ModelRoleDefinition {
  models: string[];
  description?: string;
}

/** Code defaults for roles the runtime itself depends on, so a checkout
 *  without config/model-roles.yaml (or a stale one) can't break routing or
 *  vision. The YAML file wins when it defines the role. */
const BUILTIN_ROLES: Record<string, ModelRoleDefinition> = {
  "task-router": { models: ["gemma4:31b", "mistral-large-3:675b"] },
  vision: { models: ["gemma4:31b", "mistral-large-3:675b"] },
  judgment: { models: ["glm-5.3", "deepseek-v4-pro"] },
};

let rolesCache: Map<string, ModelRoleDefinition> | undefined;
let rolesPathLoaded: string | undefined;
let catalog: Set<string> | undefined;
let catalogFetchedAtMs = 0;
let catalogRefresh: Promise<void> | undefined;
const warnedFallbacks = new Set<string>();

const CATALOG_TTL_MS = 60 * 60 * 1000;

export function isModelRole(model: string | null | undefined): boolean {
  return typeof model === "string" && model.trim().startsWith(MODEL_ROLE_PREFIX);
}

function defaultRolesPath(): string {
  const configured = process.env.TANGO_MODEL_ROLES_FILE?.trim();
  if (configured) return path.resolve(configured);
  const repo = process.env.TANGO_REPO_DIR?.trim() || process.cwd();
  return path.join(repo, "config", "model-roles.yaml");
}

/** Parse a roles document: `roles: { <name>: { models: [...], description? } }`. */
export function parseModelRoles(text: string): Map<string, ModelRoleDefinition> {
  const doc = (yaml.load(text) ?? {}) as { roles?: Record<string, unknown> };
  const roles = new Map<string, ModelRoleDefinition>();
  for (const [name, raw] of Object.entries(doc.roles ?? {})) {
    const def = raw as { models?: unknown; description?: unknown };
    const models = Array.isArray(def?.models)
      ? def.models.filter((m): m is string => typeof m === "string" && m.trim().length > 0).map((m) => m.trim())
      : [];
    if (models.length === 0) continue;
    roles.set(name, { models, ...(typeof def.description === "string" ? { description: def.description } : {}) });
  }
  return roles;
}

export function loadModelRoles(filePath = defaultRolesPath()): Map<string, ModelRoleDefinition> {
  if (rolesCache && rolesPathLoaded === filePath) return rolesCache;
  try {
    rolesCache = parseModelRoles(fs.readFileSync(filePath, "utf8"));
  } catch {
    rolesCache = new Map();
  }
  rolesPathLoaded = filePath;
  return rolesCache;
}

/** Test/ops hook: replace the roles table and/or the catalog snapshot. */
export function setModelRolesForTesting(roles: Map<string, ModelRoleDefinition> | undefined, catalogIds?: string[] | null): void {
  rolesCache = roles;
  rolesPathLoaded = roles ? defaultRolesPath() : undefined;
  if (catalogIds !== undefined) {
    catalog = catalogIds ? new Set(catalogIds) : undefined;
    catalogFetchedAtMs = catalogIds ? Date.now() : 0;
  }
  warnedFallbacks.clear();
}

/** Ollama ids resolve with or without a tag; ":cloud" is the legacy suffix. */
function inCatalog(model: string, ids: Set<string>): boolean {
  if (ids.has(model)) return true;
  const bare = model.replace(/:cloud$/u, "");
  if (ids.has(bare)) return true;
  // A bare name is served when any tagged build of it is listed (e.g.
  // deepseek-v4-pro ← deepseek-v4-pro:0813).
  for (const id of ids) if (id.startsWith(`${bare}:`)) return true;
  return false;
}

export interface ResolvedModelRole {
  role: string;
  model: string;
  /** Index into the role's list; > 0 means the primary was unavailable. */
  rank: number;
  catalogKnown: boolean;
}

/**
 * Resolve `role:<name>` to a concrete model using the cached catalog. Unknown
 * catalog → the primary entry (never block a turn on the catalog fetch).
 * Non-role strings pass through unchanged.
 */
export function resolveModelRole(model: string): ResolvedModelRole | null {
  if (!isModelRole(model)) return null;
  const role = model.trim().slice(MODEL_ROLE_PREFIX.length);
  const def = loadModelRoles().get(role) ?? BUILTIN_ROLES[role];
  if (!def) throw new Error(`Unknown model role '${role}' (config/model-roles.yaml)`);
  if (!catalog) return { role, model: def.models[0]!, rank: 0, catalogKnown: false };
  const rank = def.models.findIndex((m) => inCatalog(m, catalog!));
  if (rank < 0) {
    // Every tested model is gone: keep the primary so the error names it.
    return { role, model: def.models[0]!, rank: 0, catalogKnown: true };
  }
  if (rank > 0 && !warnedFallbacks.has(role)) {
    warnedFallbacks.add(role);
    console.warn(
      `[model-roles] role '${role}' primary ${def.models[0]} is not in the Ollama catalog; serving ${def.models[rank]} (rank ${rank}). Re-run the role's bake-off.`,
    );
  }
  return { role, model: def.models[rank]!, rank, catalogKnown: true };
}

/** Concrete model id for any configured model string (role or plain). */
export function resolveOllamaModelName(model: string): string {
  return resolveModelRole(model)?.model ?? model;
}

/** Like resolveOllamaModelName but never throws (unknown role → input unchanged). */
export function tryResolveOllamaModelName(model: string): string {
  try {
    return resolveOllamaModelName(model);
  } catch {
    return model;
  }
}

export async function fetchOllamaCatalog(apiKey: string, baseUrl = "https://ollama.com/v1"): Promise<string[]> {
  const res = await fetch(`${baseUrl.replace(/\/$/u, "")}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Ollama catalog ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
  return (body.data ?? []).map((m) => (typeof m.id === "string" ? m.id : "")).filter(Boolean);
}

/** Refresh the catalog snapshot at most once per TTL; never throws. */
export function refreshOllamaCatalogInBackground(apiKey: string | undefined, baseUrl?: string): void {
  if (!apiKey || catalogRefresh || Date.now() - catalogFetchedAtMs < CATALOG_TTL_MS) return;
  catalogRefresh = fetchOllamaCatalog(apiKey, baseUrl)
    .then((ids) => {
      if (ids.length > 0) {
        catalog = new Set(ids);
        catalogFetchedAtMs = Date.now();
      }
    })
    .catch(() => undefined)
    .finally(() => {
      catalogRefresh = undefined;
    });
}

/** For the model scorecard: every role's current resolution. */
export function describeModelRoles(catalogIds: string[]): Array<{ role: string; primary: string; serving: string | null; rank: number }> {
  const ids = new Set(catalogIds);
  return [...loadModelRoles().entries()].map(([role, def]) => {
    const rank = def.models.findIndex((m) => inCatalog(m, ids));
    return { role, primary: def.models[0]!, serving: rank >= 0 ? def.models[rank]! : null, rank };
  });
}

export function isModelInOllamaCatalog(model: string, catalogIds: string[]): boolean {
  return inCatalog(model, new Set(catalogIds));
}
