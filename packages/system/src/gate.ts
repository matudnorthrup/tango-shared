import fs from "node:fs";
import { currentMode, type ModeState } from "./mode.js";

/**
 * The gate the few big jobs ask before they start (or between work items): "may I run now, and does my
 * work fit?" Allowed only while the Mac is away, there is room left in the away window for the work
 * (when the job says how long it needs), and enough free disk (when the job says how much).
 */
export interface GateRequest {
  /** Minutes the next piece of work needs; omit when it can stop anywhere. */
  needMinutes?: number;
  /** Free disk, in GB, the work needs on `path`'s volume. */
  needGb?: number;
  /** Where the disk check looks; default: the home volume. */
  path?: string;
  /** Run regardless of mode (the owner said so). */
  force?: boolean;
}

export interface GateResult {
  allowed: boolean;
  reason: string;
  mode: ModeState;
}

export function freeGb(at: string): number | null {
  try {
    const s = fs.statfsSync(at);
    return (Number(s.bavail) * Number(s.bsize)) / 1e9;
  } catch {
    return null;
  }
}

export function checkGate(req: GateRequest = {}, opts: { now?: Date; modeFile?: string; windowsFile?: string; free?: (p: string) => number | null } = {}): GateResult {
  const mode = currentMode(opts);
  if (req.force) return { allowed: true, reason: "forced", mode };
  if (mode.mode !== "away") return { allowed: false, reason: "you're working; big jobs wait until you're away", mode };
  if (req.needMinutes && mode.minutesLeft !== null && mode.minutesLeft < req.needMinutes) {
    return { allowed: false, reason: `the away window closes in ${mode.minutesLeft} min; this needs ${req.needMinutes}`, mode };
  }
  if (req.needGb) {
    const free = (opts.free ?? freeGb)(req.path ?? process.env.HOME ?? "/");
    if (free === null) return { allowed: false, reason: "couldn't read the free disk space, so the job waits", mode };
    if (free < req.needGb) return { allowed: false, reason: `${free.toFixed(1)} GB free; this needs ${req.needGb}`, mode };
  }
  return { allowed: true, reason: "away, and it fits", mode };
}
