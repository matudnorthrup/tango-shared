import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JobUpsert } from "../jobs.js";
import type { DiscoveryEffect, DiscoveryInput, DiscoveryResult } from "./types.js";

// ---------------------------------------------------------------- Tango Server

/** The fields of Tango Server's GET /services rows this reads (packages/server ServiceView). */
interface ServiceRow {
  id: string;
  name?: string;
  group?: string;
  mode?: string;
  state?: string;
  pid?: number | null;
  since?: string;
  restarts?: number;
  health?: { ok?: boolean; checkedAt?: string | null; detail?: string };
  memoryBytes?: number | null;
  cpuPct?: number | null;
}

/** How long a running child must stay up before its "restarting" incident is over. */
const STABLE_MS = 10 * 60_000;

export function serverToken(home = process.env.TANGO_SERVER_HOME || path.join(os.homedir(), ".tango", "server")): string | null {
  try {
    return fs.readFileSync(path.join(home, "token"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Services Tango Server supervises, as `server:<id>` jobs (the ids its own events carry).
 * Tango Server records down, up and restarting itself; it has no "stable" event, so this adds job.stable
 * once a running child has stayed up for ten minutes, which closes the restarting incident.
 */
export async function discoverServer(input: DiscoveryInput, token: () => string | null = serverToken): Promise<DiscoveryResult> {
  const { ctx, prev } = input;
  const key = token();
  if (!key) return { runner: "server", jobs: [], effects: [], complete: false, note: "no Tango Server token" };
  const port = process.env.TANGO_SERVER_PORT?.trim() || "9440";
  const res = await ctx.fetch(`http://127.0.0.1:${port}/services`, { headers: { Authorization: `Bearer ${key}` }, timeoutMs: 3000 });
  if ("error" in res || res.status !== 200) {
    return { runner: "server", jobs: [], effects: [], complete: false, note: "error" in res ? res.error : `HTTP ${res.status}` };
  }
  let rows: ServiceRow[];
  try {
    const body = JSON.parse(res.text) as { services?: ServiceRow[] };
    rows = Array.isArray(body.services) ? body.services : [];
  } catch {
    return { runner: "server", jobs: [], effects: [], complete: false, note: "bad JSON from Tango Server" };
  }
  const now = ctx.now();
  const nowIso = now.toISOString();
  const effects: DiscoveryEffect[] = [];
  const jobs = rows
    .filter((s) => s && typeof s.id === "string")
    .map((s): JobUpsert => {
      const jobId = `server:${s.id}`;
      const before = prev(jobId);
      const name = s.name ?? s.id;
      const running = s.state === "running";
      const sinceMs = s.since ? Date.parse(s.since) : NaN;
      const stable = running && Number.isFinite(sinceMs) && now.getTime() - sinceMs >= STABLE_MS;
      if (stable && before?.facts.stable !== true) {
        effects.push({ type: "event", event: { source: "tick", kind: "job.stable", severity: "recovery", title: `${name} is stable`, jobId, detail: `up since ${s.since}`, at: nowIso } });
      }
      return {
        id: jobId,
        runner: "server",
        name,
        group: s.group,
        cadence: "Always on",
        cadenceSeconds: null,
        // Observed services are someone else's to start and stop; Tango Server only watches them.
        state: "active",
        lastStatus: running ? "running" : s.state === "starting" ? "running" : s.state === "stopped" ? null : "failed",
        facts: {
          mode: s.mode ?? null,
          serverState: s.state ?? null,
          pid: s.pid ?? null,
          since: s.since ?? null,
          restarts: s.restarts ?? 0,
          health: s.health?.detail ?? null,
          healthOk: s.health?.ok ?? null,
          memoryBytes: s.memoryBytes ?? null,
          cpuPct: s.cpuPct ?? null,
          stable,
        },
      };
    });
  return { runner: "server", jobs, effects, complete: true };
}
