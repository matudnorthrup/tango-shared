import { readFileSync } from "node:fs";

/**
 * The mini below its hard floor (where replication would fail) or replication behind. The backup's
 * space warning (`destination_space_warn`, the mini getting low) alerts without holding work.
 */
const PAUSE = new Set(["destination_low_space", "replica_lag"]);
/** Only fresh, actionable recovery alarms hold work. The monitor owns all other alarms. */
export function recoveryPaused(file: string | undefined, now = Date.now()): boolean {
  if (!file) return false;
  // Read on every dispatch: the operator can clear a hold without restarting Loom.
  try { if (readFileSync(`${file}.override`, "utf8").trim() === "allow") return false; } catch { /* no override */ }
  try {
    const health = JSON.parse(readFileSync(file, "utf8"));
    if (typeof health.at !== "number" || !Number.isFinite(health.at) || health.at * 1000 > now + 30_000 || now - health.at * 1000 > 120_000 ||
        typeof health.ok !== "boolean" || !Array.isArray(health.alerts) || health.alerts.some((a: unknown) => typeof a !== "string")) return false;
    return health.alerts.some((a: string) => PAUSE.has(a));
  } catch { return false; }
}
