import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Cron } from "croner";
import { loadScheduleConfigs, resolveConfigDir, traceConfigCategory, type ScheduleConfig } from "@tango/core";
import { humanSeconds, toIso } from "../context.js";
import type { JobUpsert } from "../jobs.js";
import type { DiscoveryInput, DiscoveryResult } from "./types.js";

export interface ScheduleSource {
  configs: ScheduleConfig[];
  /** Schedule id → the YAML files that define it, with their layer role. */
  files: Map<string, Array<{ filePath: string; role: string }>>;
}

export function loadScheduleSource(): ScheduleSource {
  const configDir = resolveConfigDir();
  const configs = loadScheduleConfigs(configDir);
  const files = new Map<string, Array<{ filePath: string; role: string }>>();
  try {
    for (const t of traceConfigCategory({ category: "schedules", configDir })) {
      files.set(t.id, t.sourceFiles.map((s) => ({ filePath: s.filePath, role: s.role })));
    }
  } catch {
    // trace is best effort
  }
  return { configs, files };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Human cadence and the longest expected gap between runs. */
export function scheduleCadence(c: Pick<ScheduleConfig, "schedule">, now = new Date()): { cadence: string | null; seconds: number | null; next: string | null } {
  const s = c.schedule;
  if (s.everySeconds) return { cadence: humanSeconds(s.everySeconds), seconds: s.everySeconds, next: null };
  if (s.cron) {
    let seconds: number | null = null;
    let next: string | null = null;
    try {
      const cron = new Cron(s.cron, { timezone: s.timezone, paused: true });
      next = cron.nextRuns(1, now)[0]?.toISOString() ?? null;
      // Gaps over the last 8 days and on, so a weekly pattern's weekend gap is in the window.
      const runs = cron.nextRuns(500, new Date(now.getTime() - 8 * 86_400_000));
      for (let i = 1; i < runs.length; i++) {
        const gap = (runs[i]!.getTime() - runs[i - 1]!.getTime()) / 1000;
        if (seconds === null || gap > seconds) seconds = gap;
      }
      cron.stop();
    } catch {
      // invalid cron: no cadence
    }
    const parts = s.cron.trim().split(/\s+/);
    let cadence = `Cron ${s.cron}`;
    if (parts.length === 5) {
      const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
      if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && mon === "*") {
        const t = `${pad(Number(hour))}:${pad(Number(min))}`;
        cadence = dow === "*" ? `Daily ${t}` : dow === "1-5" ? `Weekdays ${t}` : `Weekly ${t} (${dow})`;
      } else if (/^\*\/\d+$/.test(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
        cadence = `Every ${min.slice(2)} min`;
      } else if (/^\d+$/.test(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
        cadence = "Hourly";
      }
    }
    return { cadence, seconds, next };
  }
  if (s.at) return { cadence: `Once at ${s.at}`, seconds: null, next: toIso(s.at) };
  return { cadence: null, seconds: null, next: null };
}

interface ScheduleStateRow {
  schedule_id: string;
  last_run_at: string | null;
  last_status: string | null;
  consecutive_failures: number;
}

function readScheduleDb(dbPath: string): { state: Map<string, ScheduleStateRow>; paused: Set<string> } {
  const state = new Map<string, ScheduleStateRow>();
  const paused = new Set<string>();
  if (!fs.existsSync(dbPath)) return { state, paused };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 3000;");
    try {
      for (const r of db.prepare("SELECT schedule_id, last_run_at, last_status, consecutive_failures FROM schedule_state").all() as unknown as ScheduleStateRow[]) {
        state.set(r.schedule_id, r);
      }
    } catch {
      // older database without schedule_state
    }
    try {
      for (const r of db.prepare("SELECT schedule_id FROM schedule_pauses").all() as Array<{ schedule_id: string }>) paused.add(r.schedule_id);
    } catch {
      // no pauses table yet
    }
  } finally {
    db.close();
  }
  return { state, paused };
}

const STATUS: Record<string, string> = { ok: "ok", skipped: "quiet", error: "failed" };

export async function discoverSchedules(input: DiscoveryInput, load: () => ScheduleSource = loadScheduleSource): Promise<DiscoveryResult> {
  const { ctx } = input;
  const src = load();
  const { state, paused } = readScheduleDb(ctx.tangoDbPath);
  const jobs: JobUpsert[] = src.configs.map((c) => {
    const cad = scheduleCadence(c, ctx.now());
    const st = state.get(c.id);
    const files = src.files.get(c.id) ?? [];
    const profileOnly = files.length > 0 && files.every((f) => f.role === "profile");
    return {
      id: `schedule:${c.id}`,
      runner: "schedule",
      name: c.displayName ?? c.id,
      owner: c.delivery?.agentId ?? c.execution.deterministicAgentId ?? c.execution.workerId ?? null,
      cadence: cad.cadence,
      cadenceSeconds: cad.seconds,
      source: files.at(-1)?.filePath ?? null,
      state: !c.enabled || paused.has(c.id) ? "paused" : "active",
      lastRunAt: toIso(st?.last_run_at) ?? undefined,
      lastStatus: st?.last_status ? (STATUS[st.last_status] ?? st.last_status) : undefined,
      nextRunAt: c.enabled && !paused.has(c.id) ? cad.next : null,
      facts: {
        enabled: c.enabled,
        pausedInBot: paused.has(c.id),
        // Nothing is posted (mode none, or no channel): a past delivery failure no longer applies.
        deliveryOff: c.delivery?.mode === "none" || !c.delivery?.channelId,
        mode: c.execution.mode,
        sources: files.map((f) => f.filePath),
        profileOnly,
        consecutiveFailures: st?.consecutive_failures ?? 0,
      },
    } satisfies JobUpsert;
  });
  return { runner: "schedule", jobs, effects: [], complete: true };
}
