import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import yaml from "js-yaml";
import { forecastSeat, type QuotaHistory } from "./forecast.js";
import { MIN_START_PERCENT, type AccountPool } from "./pool.js";
import type { LoomStore, ThreadRow } from "./store.js";

export interface CapacityRules {
  default: string[];
  repos: { repo: string; accounts: string[] }[];
  error: string | null;
}

/** Same policy schema Settings › Routing writes; a bad policy never widens a pool. */
export function capacityRules(file: string): CapacityRules {
  const empty = { default: [], repos: [], error: null };
  try {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
      throw error;
    }
    const mapping = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
    const raw = yaml.load(text);
    if (!mapping(raw) || Object.keys(raw).some((key) => !["model", "default", "repos"].includes(key))) throw new Error("Expected a mapping of model, default, repos");
    if (raw.model != null && (typeof raw.model !== "string" || !raw.model.trim())) throw new Error("model must be a name");
    const accounts = (value: unknown): string[] => {
      const values = Array.isArray(value) ? value : [value];
      if (!values.length || values.some((v) => typeof v !== "string" || !v.trim())) throw new Error("Expected an account or nonempty account list");
      return (values as string[]).map((v) => v.trim());
    };
    if (raw.repos != null && !mapping(raw.repos)) throw new Error("repos must be a mapping");
    return {
      default: raw.default == null ? [] : accounts(raw.default),
      repos: Object.entries(raw.repos ?? {}).map(([repo, value]) => ({ repo: repo.toLowerCase(), accounts: accounts(value) })),
      error: null,
    };
  } catch (error) {
    return { ...empty, error: (error as Error).message.split("\n")[0]! };
  }
}

/** Shared with placement: the same file the Desk edits. */
export function routingPolicyPath(): string {
  return process.env.TANGO_START_WORK_POLICY ?? process.env.SCREEN_START_WORK_POLICY ?? join(homedir(), ".tango/profiles/default/config/screen/start-work.yaml");
}

/** One cached parse per file revision; a missing or invalid policy resolves to no pool. */
export class PolicyAccounts {
  private cached: { file: string; revision: string; rules: CapacityRules } | null = null;

  resolve(thread: Pick<ThreadRow, "provider" | "repo">, pool?: AccountPool): string[] | null {
    const file = routingPolicyPath();
    let revision: string;
    try {
      const stat = statSync(file);
      revision = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
    } catch { this.cached = null; return null; }
    if (this.cached?.file !== file || this.cached.revision !== revision) this.cached = { file, revision, rules: capacityRules(file) };
    const rules = this.cached.rules;
    if (rules.error) return null;
    const names = rules.repos.find(r => r.repo === basename(thread.repo ?? "").toLowerCase())?.accounts ?? rules.default;
    const resolved = [...new Set(names.filter(name => name !== "loom").flatMap(name => pool?.resolve(thread.provider, name)?.name ?? []))];
    return resolved.length ? resolved : null;
  }
}

/** How far above the start floor an account warns, when threads are pinned to it alone. */
export const EARLY_WARNING_PERCENT = 10;

export function capacitySnapshot(store: LoomStore, pool?: AccountPool, allowedAccounts: (thread: ThreadRow) => string[] | null = t => t.accounts ? JSON.parse(t.accounts) : null, history?: QuotaHistory) {
  const id = (provider: string, name: string) => {
    const account = pool?.resolve(provider, name);
    return account?.aliases?.[0] ?? account?.name ?? name;
  };
  const open = store.threads().filter(t => t.status !== "stopped" && !t.settled_at);
  const allowed = new Map(open.map(t => [t.id, allowedAccounts(t)]));
  return {
    updatedAt: store.now(), loom: true, moves: true,
    accounts: (pool?.accounts ?? []).map((account) => {
      const threads = open.filter((t) => t.provider === account.provider && t.account === account.name).map((t) => ({
        itemId: `loom:${t.id}`, title: t.title || "Untitled thread", repo: t.repo ? basename(t.repo) : null,
        running: t.status === "running", lastActiveAt: t.updated_at,
        allowed: allowed.get(t.id) ? [...new Set(allowed.get(t.id)!.map(name => id(t.provider, name)))] : null,
        allowedFrom: t.accounts_source === "policy" ? "policy" as const : t.accounts ? "pinned" as const : null,
      })).sort((a, b) => Number(b.running) - Number(a.running) || b.lastActiveAt - a.lastActiveAt);
      const running = threads.filter((t) => t.running).length;
      // The Desk's CapacitySnapshot: resetsAt as an ISO string, status as the usage reading's freshness.
      const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);
      const shape = (w: { left: number; resetsAt: number | null } | null) => (w ? { left: w.left, resetsAt: iso(w.resetsAt) } : null);
      const { fiveHour, weekly, fresh } = pool!.capacityWindows(account.provider, account.name);
      // Threads that may only run here: when this account drops under the floor they wait for its reset (10/19).
      const pinned = open.filter(t => t.provider === account.provider && allowed.get(t.id)?.length
        && allowed.get(t.id)!.every(name => (pool!.resolve(t.provider, name)?.name ?? name) === account.name)).length;
      const lefts = [fiveHour?.left, weekly?.left].filter((n): n is number => typeof n === "number");
      const left = lefts.length ? Math.min(...lefts) : null;
      const floor = left === null ? null : left < MIN_START_PERCENT ? "below_floor" as const : left < MIN_START_PERCENT + EARLY_WARNING_PERCENT ? "near_floor" as const : null;
      const { score, pace, load } = pool!.score(account.provider, account.name);
      return {
        id: id(account.provider, account.name), name: account.name, color: null,
        provider: account.provider as "claude" | "codex",
        status: !(fiveHour || weekly) ? "none" : fresh ? "fresh" : "stale",
        coolingUntil: iso(pool!.room(account.provider, account.name).coolingUntil),
        fiveHour: shape(fiveHour), weekly: shape(weekly), running, idle: threads.length - running, threads,
        score, pace, load,
        ...forecastSeat({ now: store.now(), weekly: fresh ? weekly : null, samples: history?.samples(account.provider, account.name) ?? [], floor: MIN_START_PERCENT }),
        floorPercent: MIN_START_PERCENT, pinned, warning: pinned > 0 ? floor : null,
      };
    }),
    // The file the Desk writes (Settings › Routing): same env and default as apps/screen/server/main.ts.
    rules: capacityRules(routingPolicyPath()),
    machine: null,
  };
}
