import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { profileConfigDir, profileDataDir } from "./paths.js";

/**
 * Working or away: the one switch that says whether the Mac is the owner's right now. Big background jobs
 * (the night backup, media sync, disk scans, worktree sweeps) run only when it is away (see gate.ts).
 *
 * A manual choice wins until it expires; otherwise an optional weekly schedule file
 * (`<profile>/config/system/work-windows.yaml`) says when the Mac is away; otherwise the owner is working.
 */
export type WorkMode = "working" | "away";

export interface ManualMode {
  mode: WorkMode;
  /** When the choice lapses back to the schedule; null: until changed. */
  until: string | null;
  setAt: string;
}

export interface AwayWindow {
  /** Lowercase three-letter day names the window STARTS on; omitted: every day. */
  days?: string[];
  /** Local 24-hour "HH:MM". A `to` at or before `from` runs past midnight into the next day. */
  from: string;
  to: string;
}

export interface ModeState {
  mode: WorkMode;
  source: "manual" | "schedule" | "default";
  /** When the current mode is expected to change (manual expiry or the window's edge); null: unknown. */
  until: string | null;
  /** Away only: minutes until the away window closes; null when open-ended or unknown. */
  minutesLeft: number | null;
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function resolveModePath(): string {
  return process.env.TANGO_WORK_MODE_FILE?.trim() || path.join(profileDataDir(), "work-mode.json");
}

export function resolveWindowsPath(): string {
  return process.env.TANGO_WORK_WINDOWS_FILE?.trim() || path.join(profileConfigDir(), "system", "work-windows.yaml");
}

function readManual(file = resolveModePath()): ManualMode | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ManualMode>;
    if (raw.mode !== "away" && raw.mode !== "working") return null;
    const until = typeof raw.until === "string" && Number.isFinite(Date.parse(raw.until)) ? raw.until : null;
    return { mode: raw.mode, until, setAt: typeof raw.setAt === "string" ? raw.setAt : new Date(0).toISOString() };
  } catch {
    return null;
  }
}

function writeManual(m: ManualMode, file = resolveModePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(m)}\n`);
  fs.renameSync(tmp, file);
}

/** Away for `hours` (default: until you say you're back). */
export function setAway(opts: { hours?: number | null; now?: Date; file?: string } = {}): ManualMode {
  const now = opts.now ?? new Date();
  const hours = opts.hours && opts.hours > 0 ? opts.hours : null;
  const m: ManualMode = { mode: "away", until: hours ? new Date(now.getTime() + hours * 3_600_000).toISOString() : null, setAt: now.toISOString() };
  writeManual(m, opts.file);
  return m;
}

/** Back at the Mac: working until you set away again. Overrides a schedule window that is open. */
export function setWorking(opts: { now?: Date; file?: string } = {}): ManualMode {
  const now = opts.now ?? new Date();
  const m: ManualMode = { mode: "working", until: null, setAt: now.toISOString() };
  writeManual(m, opts.file);
  return m;
}

/** Drops the manual choice so the schedule (or the default) decides. */
export function clearManual(file = resolveModePath()): void {
  fs.rmSync(file, { force: true });
}

const clock = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (s: string): number | null => {
  const m = clock.exec(String(s).trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

export function readWindows(file = resolveWindowsPath()): AwayWindow[] {
  try {
    const doc = yaml.load(fs.readFileSync(file, "utf8")) as { away?: unknown } | null;
    const list = Array.isArray(doc?.away) ? doc.away : [];
    const out: AwayWindow[] = [];
    for (const w of list as Array<Record<string, unknown>>) {
      if (!w || minutesOf(String(w.from)) === null || minutesOf(String(w.to)) === null) continue;
      const days = Array.isArray(w.days) ? w.days.map((d) => String(d).toLowerCase().slice(0, 3)).filter((d) => DAYS.includes(d)) : undefined;
      if (days && !days.length) continue; // a day list that names no real day restricts nothing sensible: drop the window
      out.push({ from: String(w.from).trim(), to: String(w.to).trim(), ...(days ? { days } : {}) });
    }
    return out;
  } catch {
    return [];
  }
}

/** The window open at `now` (local time) and when it closes, if any. */
export function openWindow(windows: AwayWindow[], now: Date): { closesAt: Date } | null {
  let best: Date | null = null;
  for (const w of windows) {
    const from = minutesOf(w.from)!;
    const to = minutesOf(w.to)!;
    // A window that started today, or (when it runs past midnight) yesterday.
    for (const back of [0, 1]) {
      const start = new Date(now);
      start.setDate(start.getDate() - back);
      start.setHours(Math.floor(from / 60), from % 60, 0, 0);
      if (w.days && !w.days.includes(DAYS[start.getDay()]!)) continue;
      const end = new Date(start);
      end.setHours(Math.floor(to / 60), to % 60, 0, 0);
      if (to <= from) end.setDate(end.getDate() + 1);
      if (now >= start && now < end && (!best || end > best)) best = end;
    }
  }
  return best ? { closesAt: best } : null;
}

export function currentMode(opts: { now?: Date; modeFile?: string; windowsFile?: string } = {}): ModeState {
  const now = opts.now ?? new Date();
  const manual = readManual(opts.modeFile);
  if (manual && (!manual.until || Date.parse(manual.until) > now.getTime())) {
    const minutesLeft = manual.mode === "away" && manual.until ? Math.max(0, Math.round((Date.parse(manual.until) - now.getTime()) / 60_000)) : null;
    return { mode: manual.mode, source: "manual", until: manual.until, minutesLeft };
  }
  const win = openWindow(readWindows(opts.windowsFile), now);
  if (win) return { mode: "away", source: "schedule", until: win.closesAt.toISOString(), minutesLeft: Math.max(0, Math.round((win.closesAt.getTime() - now.getTime()) / 60_000)) };
  return { mode: "working", source: "default", until: null, minutesLeft: null };
}
