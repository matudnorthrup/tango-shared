import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveCurrentTurnTimeZone, resolveTangoProfileDataDir, type AgentTool } from "@tango/core";

/**
 * `training_log` is a small, self-contained workout log for an isolated
 * training agent (a family member's coach). Each agent gets its own file under
 * `<profile>/data/training/<agent>.json`; the agent id comes from the
 * authenticated worker (`_requester_agent_id`), never from model arguments, so
 * one agent cannot read or write another's log. It deliberately has no access
 * to the owner's health or workout databases.
 */

export const TRAINING_SESSION_TYPES = [
  "basketball",
  "skills",
  "strength",
  "conditioning",
  "mobility",
  "game",
  "other",
] as const;
export type TrainingSessionType = (typeof TRAINING_SESSION_TYPES)[number];

export interface TrainingExercise {
  name: string;
  sets?: number;
  reps?: number;
  weightLb?: number;
  durationSec?: number;
  distance?: string;
  made?: number;
  attempted?: number;
  notes?: string;
}

export interface TrainingSession {
  id: string;
  date: string;
  type: TrainingSessionType;
  title?: string;
  durationMin?: number;
  rpe?: number;
  exercises: TrainingExercise[];
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TrainingGoal {
  id: string;
  text: string;
  targetDate?: string;
  status: "active" | "done";
  createdAt: string;
  completedAt?: string;
}

export interface TrainingLog {
  version: 1;
  sessions: TrainingSession[];
  goals: TrainingGoal[];
}

export interface TrainingLogToolOptions {
  dataDir?: string;
  now?: () => Date;
  timeZone?: string;
}

const READ_OPERATIONS = new Set(["list_recent", "summary", "list_goals"]);

export function trainingLogToolLooksReadOnly(operation: unknown): boolean {
  return typeof operation === "string" && READ_OPERATIONS.has(operation.trim());
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${field} must be a number between ${min} and ${max}`);
  }
  return n;
}

function isoDate(value: unknown, fallback: string): string {
  const date = str(value) ?? fallback;
  // Round-trip check: Date normalizes impossible dates (2026-02-30 → March).
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || Number.isNaN(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error("date must be a real calendar date, YYYY-MM-DD");
  }
  return date;
}

/** A session date: valid and not after today (the log records what happened). */
function pastDate(value: unknown, today: string): string {
  const date = isoDate(value, today);
  if (date > today) throw new Error(`date ${date} is in the future; log sessions after they happen`);
  return date;
}

function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(now);
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseExercises(value: unknown): TrainingExercise[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("exercises must be an array");
  return value.map((raw, index) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const name = str(item.name);
    if (!name) throw new Error(`exercises[${index}].name is required`);
    const exercise: TrainingExercise = { name };
    const sets = num(item.sets, "sets", 0, 100);
    const reps = num(item.reps, "reps", 0, 1000);
    const weightLb = num(item.weight_lb, "weight_lb", 0, 1000);
    const durationSec = num(item.duration_sec, "duration_sec", 0, 86400);
    const made = num(item.made, "made", 0, 10000);
    const attempted = num(item.attempted, "attempted", 0, 10000);
    if (made !== undefined && attempted !== undefined && made > attempted) {
      throw new Error(`exercises[${index}]: made cannot exceed attempted`);
    }
    if (sets !== undefined) exercise.sets = sets;
    if (reps !== undefined) exercise.reps = reps;
    if (weightLb !== undefined) exercise.weightLb = weightLb;
    if (durationSec !== undefined) exercise.durationSec = durationSec;
    if (str(item.distance)) exercise.distance = str(item.distance);
    if (made !== undefined) exercise.made = made;
    if (attempted !== undefined) exercise.attempted = attempted;
    if (str(item.notes)) exercise.notes = str(item.notes);
    return exercise;
  });
}

function parseType(value: unknown): TrainingSessionType {
  const type = str(value) ?? "other";
  if (!(TRAINING_SESSION_TYPES as readonly string[]).includes(type)) {
    throw new Error(`type must be one of ${TRAINING_SESSION_TYPES.join(", ")}`);
  }
  return type as TrainingSessionType;
}

export class TrainingLogStore {
  constructor(readonly filePath: string) {}

  read(): TrainingLog {
    if (!fs.existsSync(this.filePath)) return { version: 1, sessions: [], goals: [] };
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<TrainingLog>;
    return { version: 1, sessions: parsed.sessions ?? [], goals: parsed.goals ?? [] };
  }

  write(log: TrainingLog): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(log, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, this.filePath);
  }
}

export function summarizeTrainingSessions(sessions: TrainingSession[]) {
  const byType: Record<string, number> = {};
  let minutes = 0;
  let made = 0;
  let attempted = 0;
  const rpes: number[] = [];
  for (const session of sessions) {
    byType[session.type] = (byType[session.type] ?? 0) + 1;
    minutes += session.durationMin ?? 0;
    if (session.rpe !== undefined) rpes.push(session.rpe);
    for (const exercise of session.exercises) {
      if (exercise.made !== undefined && exercise.attempted !== undefined) {
        made += exercise.made;
        attempted += exercise.attempted;
      }
    }
  }
  const activeDays = new Set(sessions.map((session) => session.date)).size;
  return {
    sessions: sessions.length,
    activeDays,
    totalMinutes: minutes,
    byType,
    averageRpe: rpes.length ? Math.round((rpes.reduce((a, b) => a + b, 0) / rpes.length) * 10) / 10 : null,
    shooting: attempted > 0 ? { made, attempted, percent: Math.round((made / attempted) * 1000) / 10 } : null,
  };
}

export function createTrainingLogTools(options: TrainingLogToolOptions = {}): AgentTool[] {
  const now = options.now ?? (() => new Date());
  // Same resolution as current-turn metadata (TANGO_TIME_ZONE, TZ, default),
  // with an optional log-specific override.
  const timeZone = resolveCurrentTurnTimeZone(options.timeZone ?? process.env.TANGO_TRAINING_LOG_TIMEZONE);

  const storeFor = (input: Record<string, unknown>): TrainingLogStore => {
    const agentId = str(input._requester_agent_id);
    if (!agentId || !/^[a-z0-9_-]+$/iu.test(agentId)) {
      throw new Error("training_log is only available to an authenticated agent.");
    }
    const dataDir = options.dataDir ?? resolveTangoProfileDataDir();
    return new TrainingLogStore(path.join(dataDir, "training", `${agentId}.json`));
  };

  return [
    {
      name: "training_log",
      description: [
        "The athlete's own workout and training log.",
        "Operations: log_session, update_session, delete_session, list_recent, summary, set_goal, complete_goal, list_goals.",
        "log_session takes date (YYYY-MM-DD, default today), type (basketball, skills, strength, conditioning, mobility, game, other),",
        "title, duration_min, rpe (1-10 effort), notes, and exercises [{name, sets, reps, weight_lb, duration_sec, distance, made, attempted, notes}].",
        "Use made/attempted for shooting drills and games. list_recent and summary take days (default 14 / 28).",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["log_session", "update_session", "delete_session", "list_recent", "summary", "set_goal", "complete_goal", "list_goals"],
          },
          id: { type: "string" },
          date: { type: "string" },
          type: { type: "string", enum: [...TRAINING_SESSION_TYPES] },
          title: { type: "string" },
          duration_min: { type: "number" },
          rpe: { type: "number" },
          notes: { type: "string" },
          exercises: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                sets: { type: "number" },
                reps: { type: "number" },
                weight_lb: { type: "number" },
                duration_sec: { type: "number" },
                distance: { type: "string" },
                made: { type: "number" },
                attempted: { type: "number" },
                notes: { type: "string" },
              },
              required: ["name"],
            },
          },
          days: { type: "number" },
          text: { type: "string" },
          target_date: { type: "string" },
        },
        required: ["operation"],
      },
      handler: async (input) => {
        const operation = str(input.operation);
        const store = storeFor(input);
        const log = store.read();
        const today = localDate(now(), timeZone);
        const stamp = now().toISOString();

        switch (operation) {
          case "log_session": {
            const session: TrainingSession = {
              id: randomUUID().slice(0, 8),
              date: pastDate(input.date, today),
              type: parseType(input.type),
              exercises: parseExercises(input.exercises),
              createdAt: stamp,
              updatedAt: stamp,
            };
            if (str(input.title)) session.title = str(input.title);
            const duration = num(input.duration_min, "duration_min", 0, 1440);
            if (duration !== undefined) session.durationMin = duration;
            const rpe = num(input.rpe, "rpe", 1, 10);
            if (rpe !== undefined) session.rpe = rpe;
            if (str(input.notes)) session.notes = str(input.notes);
            log.sessions.push(session);
            store.write(log);
            return { logged: session };
          }
          case "update_session": {
            const session = log.sessions.find((entry) => entry.id === str(input.id));
            if (!session) throw new Error("No session with that id.");
            if (input.date !== undefined) session.date = pastDate(input.date, today);
            if (input.type !== undefined) session.type = parseType(input.type);
            if (input.title !== undefined) session.title = str(input.title);
            if (input.duration_min !== undefined) session.durationMin = num(input.duration_min, "duration_min", 0, 1440);
            if (input.rpe !== undefined) session.rpe = num(input.rpe, "rpe", 1, 10);
            if (input.notes !== undefined) session.notes = str(input.notes);
            if (input.exercises !== undefined) session.exercises = parseExercises(input.exercises);
            session.updatedAt = stamp;
            store.write(log);
            return { updated: session };
          }
          case "delete_session": {
            const before = log.sessions.length;
            log.sessions = log.sessions.filter((entry) => entry.id !== str(input.id));
            if (log.sessions.length === before) throw new Error("No session with that id.");
            store.write(log);
            return { deleted: str(input.id) };
          }
          case "list_recent": {
            const days = num(input.days, "days", 1, 3650) ?? 14;
            const since = shiftDate(today, -(days - 1));
            const sessions = log.sessions
              .filter((entry) => entry.date >= since && entry.date <= today)
              .sort((a, b) => (a.date === b.date ? a.createdAt.localeCompare(b.createdAt) : a.date.localeCompare(b.date)));
            return { today, since, sessions };
          }
          case "summary": {
            const days = num(input.days, "days", 1, 3650) ?? 28;
            const since = shiftDate(today, -(days - 1));
            const window = log.sessions.filter((entry) => entry.date >= since && entry.date <= today);
            return {
              today,
              since,
              ...summarizeTrainingSessions(window),
              activeGoals: log.goals.filter((goal) => goal.status === "active"),
            };
          }
          case "set_goal": {
            const text = str(input.text);
            if (!text) throw new Error("text is required");
            const goal: TrainingGoal = { id: randomUUID().slice(0, 8), text, status: "active", createdAt: stamp };
            if (input.target_date !== undefined) goal.targetDate = isoDate(input.target_date, today);
            log.goals.push(goal);
            store.write(log);
            return { goal };
          }
          case "complete_goal": {
            const goal = log.goals.find((entry) => entry.id === str(input.id));
            if (!goal) throw new Error("No goal with that id.");
            goal.status = "done";
            goal.completedAt = stamp;
            store.write(log);
            return { goal };
          }
          case "list_goals":
            return { goals: log.goals };
          default:
            throw new Error(`Unknown operation: ${operation ?? "(none)"}`);
        }
      },
    },
  ];
}
