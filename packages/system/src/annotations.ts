import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { profileConfigDir, repoRoot } from "./paths.js";
import type { Criticality, Runner } from "./types.js";

export interface ServiceAnnotation {
  id: string;
  name: string;
  url?: string;
  port?: number;
  host?: string;
  /** "tailscale" | "docker": probe through that CLI. */
  cmd?: string;
  critical?: boolean;
}

export interface JobAnnotation {
  name?: string;
  group?: string;
  owner?: string;
  criticality?: Criticality;
  /** Shorthand for criticality: critical. */
  critical?: boolean;
  cadence?: string;
  cadenceSeconds?: number;
  logs?: string[];
  probe?: Record<string, unknown>;
  retireCandidate?: string;
  /** Overrides the criticality's failed-run threshold (failures in a row before an event). */
  failAfter?: number;
  /** Overrides the criticality's late multiplier. */
  lateFactor?: number;
}

export interface Annotations {
  prefixes: { launchd: string[] };
  tmux: { socket?: string; socketName?: string; session?: string };
  services: ServiceAnnotation[];
  jobs: Record<string, JobAnnotation>;
  defaults: { group: Partial<Record<Runner, string>>; criticality: Criticality };
  bot: { url: string };
  loom: { url: string; tokenFile?: string };
  unmanaged: { ignoreCommandPrefixes: string[] };
  sources: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function deepMerge(base: unknown, over: unknown): unknown {
  if (Array.isArray(over)) return [...over];
  if (isObj(base) && isObj(over)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = k in out ? deepMerge(out[k], v) : v;
    return out;
  }
  return over;
}

/**
 * Layers merge in order: maps deep-merge, `services` merge by id,
 * `prefixes.launchd` is the union, other lists are replaced.
 */
export function mergeAnnotationLayers(layers: Array<Record<string, unknown>>): Record<string, unknown> {
  let merged: Record<string, unknown> = {};
  const services: Record<string, unknown>[] = [];
  const prefixes: string[] = [];
  for (const layer of layers) {
    const { services: svc, prefixes: pre, ...rest } = layer;
    merged = deepMerge(merged, rest) as Record<string, unknown>;
    if (Array.isArray(svc)) {
      for (const s of svc) {
        if (!isObj(s) || typeof s.id !== "string") continue;
        const i = services.findIndex((x) => x.id === s.id);
        if (i >= 0) services[i] = deepMerge(services[i], s) as Record<string, unknown>;
        else services.push({ ...s });
      }
    }
    if (isObj(pre)) {
      const launchd = pre.launchd;
      if (Array.isArray(launchd)) for (const p of launchd) if (typeof p === "string" && !prefixes.includes(p)) prefixes.push(p);
      const others = Object.fromEntries(Object.entries(pre).filter(([k]) => k !== "launchd"));
      merged.prefixes = deepMerge(merged.prefixes ?? {}, others);
    }
  }
  merged.services = services;
  merged.prefixes = { ...(isObj(merged.prefixes) ? merged.prefixes : {}), launchd: prefixes };
  return merged;
}

const CRIT = new Set(["critical", "normal", "quiet"]);

export function normalizeAnnotations(raw: Record<string, unknown>, sources: string[] = []): Annotations {
  const prefixes = isObj(raw.prefixes) && Array.isArray(raw.prefixes.launchd) ? raw.prefixes.launchd.filter((p): p is string => typeof p === "string") : [];
  const tmuxRaw = isObj(raw.tmux) ? raw.tmux : {};
  const services: ServiceAnnotation[] = (Array.isArray(raw.services) ? raw.services : [])
    .filter(isObj)
    .filter((s) => typeof s.id === "string")
    .map((s) => ({
      id: String(s.id),
      name: typeof s.name === "string" ? s.name : String(s.id),
      url: typeof s.url === "string" ? s.url : undefined,
      port: typeof s.port === "number" ? s.port : undefined,
      host: typeof s.host === "string" ? s.host : undefined,
      cmd: typeof s.cmd === "string" ? s.cmd : undefined,
      critical: s.critical === true,
    }));
  const jobs: Record<string, JobAnnotation> = {};
  if (isObj(raw.jobs)) {
    for (const [id, v] of Object.entries(raw.jobs)) {
      if (!isObj(v)) continue;
      const a: JobAnnotation = {};
      if (typeof v.name === "string") a.name = v.name;
      if (typeof v.group === "string") a.group = v.group;
      if (typeof v.owner === "string") a.owner = v.owner;
      if (typeof v.criticality === "string" && CRIT.has(v.criticality)) a.criticality = v.criticality as Criticality;
      if (v.critical === true) a.criticality = "critical";
      if (typeof v.cadence === "string") a.cadence = v.cadence;
      if (typeof v.cadenceSeconds === "number") a.cadenceSeconds = v.cadenceSeconds;
      if (Array.isArray(v.logs)) a.logs = v.logs.filter((x): x is string => typeof x === "string");
      if (isObj(v.probe)) a.probe = v.probe;
      if (typeof v.retireCandidate === "string") a.retireCandidate = v.retireCandidate;
      if (typeof v.failAfter === "number") a.failAfter = v.failAfter;
      if (typeof v.lateFactor === "number") a.lateFactor = v.lateFactor;
      jobs[id] = a;
    }
  }
  const defaultsRaw = isObj(raw.defaults) ? raw.defaults : {};
  const group = isObj(defaultsRaw.group) ? (Object.fromEntries(Object.entries(defaultsRaw.group).filter(([, v]) => typeof v === "string")) as Partial<Record<Runner, string>>) : {};
  const crit = typeof defaultsRaw.criticality === "string" && CRIT.has(defaultsRaw.criticality) ? (defaultsRaw.criticality as Criticality) : "normal";
  const bot = isObj(raw.bot) && typeof raw.bot.url === "string" ? raw.bot.url : "http://127.0.0.1:9200";
  const loomRaw = isObj(raw.loom) ? raw.loom : {};
  const unmanagedRaw = isObj(raw.unmanaged) ? raw.unmanaged : {};
  return {
    prefixes: { launchd: prefixes },
    tmux: {
      socket: typeof tmuxRaw.socket === "string" ? tmuxRaw.socket : undefined,
      socketName: typeof tmuxRaw.socketName === "string" ? tmuxRaw.socketName : undefined,
      session: typeof tmuxRaw.session === "string" ? tmuxRaw.session : undefined,
    },
    services,
    jobs,
    defaults: { group, criticality: crit },
    bot: { url: bot.replace(/\/$/, "") },
    loom: {
      url: (typeof loomRaw.url === "string" ? loomRaw.url : process.env.LOOM_PORT ? `http://127.0.0.1:${process.env.LOOM_PORT}` : "http://127.0.0.1:9420").replace(/\/$/, ""),
      tokenFile: typeof loomRaw.tokenFile === "string" ? loomRaw.tokenFile : undefined,
    },
    unmanaged: {
      ignoreCommandPrefixes: Array.isArray(unmanagedRaw.ignoreCommandPrefixes)
        ? unmanagedRaw.ignoreCommandPrefixes.filter((x): x is string => typeof x === "string")
        : [],
    },
    sources,
  };
}

function readYaml(file: string): Record<string, unknown> | null {
  if (!fs.existsSync(file)) return null;
  const doc = yaml.load(fs.readFileSync(file, "utf8"));
  if (doc == null) return {};
  if (!isObj(doc)) throw new Error(`${file} must contain a YAML object`);
  return doc;
}

export function defaultAnnotationFiles(): string[] {
  return [
    path.join(repoRoot(), "config", "defaults", "system", "jobs.yaml"),
    path.join(profileConfigDir(), "system", "jobs.yaml"),
  ];
}

/**
 * The repo's generic defaults (`config/defaults/system/jobs.yaml`) under the
 * profile overlay (`<profile>/config/system/jobs.yaml`). A file that fails to
 * parse is skipped with a warning so one bad edit does not stop the tick.
 */
export function loadAnnotations(files: string[] = defaultAnnotationFiles(), warn: (m: string) => void = () => {}): Annotations {
  const layers: Array<Record<string, unknown>> = [];
  const sources: string[] = [];
  for (const file of files) {
    try {
      const doc = readYaml(file);
      if (doc) {
        layers.push(doc);
        sources.push(file);
      }
    } catch (err) {
      warn(`annotations: ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return normalizeAnnotations(mergeAnnotationLayers(layers), sources);
}

/** Failures in a row before a failed run becomes an event; Infinity = never. */
export function failThreshold(crit: Criticality, a?: JobAnnotation): number {
  if (a?.failAfter !== undefined) return a.failAfter <= 0 ? Infinity : a.failAfter;
  return crit === "critical" ? 1 : crit === "normal" ? 2 : Infinity;
}

export function lateFactor(crit: Criticality, a?: JobAnnotation): number {
  if (a?.lateFactor !== undefined) return a.lateFactor;
  return crit === "critical" ? 1.5 : crit === "normal" ? 2 : 3;
}
