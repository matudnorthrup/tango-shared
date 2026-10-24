import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Client,
  type Interaction,
  type Message,
  type ModalSubmitInteraction,
} from "discord.js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  resolveDatabasePath,
  TangoStorage,
  type AgentTool,
  type DeterministicHandler,
} from "@tango/core";
import {
  appendInterstitialLogEntry,
  appendLineToSection,
} from "./interstitial-log-capture.js";
import { createGogCommandEnv } from "./gog-keyring-password.js";

const DEFAULT_TIME_ZONE = "America/Los_Angeles";
const DEFAULT_VAULT_ROOT = path.join(os.homedir(), "Documents", "main");
const DEFAULT_USER_ID = "default";
const ORIENTATION_CUSTOM_ID_PREFIX = "orientation";

export interface OrientationNudgeConfig {
  userId: string;
  timeZone: string;
  vaultRoot: string;
  activeStartHour: number;
  activeEndHour: number;
  inactivityMinutes: number;
  minNudgeIntervalMinutes: number;
  ignoreAfterMinutes: number;
  defaultFocusMinutes: number;
  defaultVacationDays: number;
  cooldownAfterMisses: number;
  cooldownBaseMinutes: number;
  cooldownMaxMinutes: number;
}

export interface OrientationNudgeState {
  userId: string;
  focusModeActive: boolean;
  focusModeTask: string | null;
  focusModeExpiresAt: string | null;
  vacationModeActive: boolean;
  vacationModeExpiresAt: string | null;
  lastInterstitialLogAt: string | null;
  lastTaskRotationChangeAt: string | null;
  taskRotationSignature: string | null;
  taskRotationTask: string | null;
  lastNudgeAt: string | null;
  lastNudgeResponseAt: string | null;
  activeNudgeId: string | null;
  activeNudgeMessageId: string | null;
  activeNudgeChannelId: string | null;
  activeNudgeTask: string | null;
  activeNudgeSentAt: string | null;
  unansweredNudgeCount: number;
  cooldownUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRotationItem {
  checked: boolean;
  text: string;
}

export interface InterstitialLogEntry {
  at: Date;
  text: string;
}

export interface DailyNoteObservation {
  notePath: string;
  noteFound: boolean;
  date: string;
  currentTask: string | null;
  latestInterstitial: InterstitialLogEntry | null;
  rotationItems: TaskRotationItem[];
  rotationSignature: string | null;
}

export interface CalendarBlocker {
  title: string;
  startsAt: string;
  endsAt: string;
}

export type OrientationNudgeDecision =
  | { action: "send"; task: string | null }
  | { action: "skip"; reason: string };

export interface OrientationNudgeHandlerOptions {
  channelId?: string | null;
  timeZone?: string;
  vaultRoot?: string;
  now?: () => Date;
  fetchCalendarBlocker?: (now: Date, config: OrientationNudgeConfig) => Promise<CalendarBlocker | null>;
  recordNudgeMessage?: (input: {
    messageId: string;
    channelId: string;
    content: string;
    nudgeId: string;
    task: string | null;
  }) => void | Promise<void>;
}

export interface OrientationNudgeInteractionOptions {
  db: DatabaseSync;
  timeZone?: string;
  vaultRoot?: string;
  now?: () => Date;
}

export function resolveOrientationNudgeConfig(
  overrides: Partial<OrientationNudgeConfig> = {},
): OrientationNudgeConfig {
  const envTimeZone = process.env.ORIENTATION_NUDGE_TIME_ZONE?.trim() || undefined;
  const envVaultRoot = process.env.ORIENTATION_NUDGE_VAULT_ROOT?.trim() || undefined;

  return {
    userId: overrides.userId ?? DEFAULT_USER_ID,
    timeZone: overrides.timeZone ?? envTimeZone ?? DEFAULT_TIME_ZONE,
    vaultRoot: overrides.vaultRoot ?? envVaultRoot ?? DEFAULT_VAULT_ROOT,
    activeStartHour: overrides.activeStartHour ?? numberFromEnv("ORIENTATION_NUDGE_ACTIVE_START_HOUR", 5),
    activeEndHour: overrides.activeEndHour ?? numberFromEnv("ORIENTATION_NUDGE_ACTIVE_END_HOUR", 20),
    inactivityMinutes: overrides.inactivityMinutes ?? numberFromEnv("ORIENTATION_NUDGE_INACTIVITY_MINUTES", 60),
    minNudgeIntervalMinutes:
      overrides.minNudgeIntervalMinutes ?? numberFromEnv("ORIENTATION_NUDGE_MIN_INTERVAL_MINUTES", 30),
    ignoreAfterMinutes: overrides.ignoreAfterMinutes ?? numberFromEnv("ORIENTATION_NUDGE_IGNORE_AFTER_MINUTES", 30),
    defaultFocusMinutes: overrides.defaultFocusMinutes ?? numberFromEnv("ORIENTATION_NUDGE_DEFAULT_FOCUS_MINUTES", 120),
    defaultVacationDays: overrides.defaultVacationDays ?? numberFromEnv("ORIENTATION_NUDGE_DEFAULT_VACATION_DAYS", 7),
    cooldownAfterMisses: overrides.cooldownAfterMisses ?? numberFromEnv("ORIENTATION_NUDGE_COOLDOWN_AFTER_MISSES", 2),
    cooldownBaseMinutes: overrides.cooldownBaseMinutes ?? numberFromEnv("ORIENTATION_NUDGE_COOLDOWN_BASE_MINUTES", 30),
    cooldownMaxMinutes: overrides.cooldownMaxMinutes ?? numberFromEnv("ORIENTATION_NUDGE_COOLDOWN_MAX_MINUTES", 8 * 60),
  };
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export class OrientationNudgeStore {
  constructor(private readonly db: DatabaseSync) {}

  getState(userId = DEFAULT_USER_ID, now = new Date()): OrientationNudgeState {
    this.ensureState(userId, now);
    const row = this.db
      .prepare(
        `SELECT
           user_id AS userId,
           focus_mode_active AS focusModeActive,
           focus_mode_task AS focusModeTask,
           focus_mode_expires_at AS focusModeExpiresAt,
           vacation_mode_active AS vacationModeActive,
           vacation_mode_expires_at AS vacationModeExpiresAt,
           last_interstitial_log_at AS lastInterstitialLogAt,
           last_task_rotation_change_at AS lastTaskRotationChangeAt,
           task_rotation_signature AS taskRotationSignature,
           task_rotation_task AS taskRotationTask,
           last_nudge_at AS lastNudgeAt,
           last_nudge_response_at AS lastNudgeResponseAt,
           active_nudge_id AS activeNudgeId,
           active_nudge_message_id AS activeNudgeMessageId,
           active_nudge_channel_id AS activeNudgeChannelId,
           active_nudge_task AS activeNudgeTask,
           active_nudge_sent_at AS activeNudgeSentAt,
           unanswered_nudge_count AS unansweredNudgeCount,
           cooldown_until AS cooldownUntil,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM orientation_nudge_state
         WHERE user_id = ?`,
      )
      .get(userId) as Record<string, unknown> | undefined;

    if (!row) {
      throw new Error(`orientation_nudge_state row missing for ${userId}`);
    }
    return rowToState(row);
  }

  normalizeExpiredModes(userId: string, now: Date): void {
    const state = this.getState(userId, now);
    const nowIso = now.toISOString();
    if (
      state.focusModeActive &&
      state.focusModeExpiresAt &&
      state.focusModeExpiresAt <= nowIso
    ) {
      this.db
        .prepare(
          `UPDATE orientation_nudge_state
           SET focus_mode_active = 0,
               focus_mode_task = NULL,
               focus_mode_expires_at = NULL,
               updated_at = ?
           WHERE user_id = ?`,
        )
        .run(nowIso, userId);
      this.insertEvent(userId, "focus_expired", now, { task: state.focusModeTask });
    }
    if (
      state.vacationModeActive &&
      state.vacationModeExpiresAt &&
      state.vacationModeExpiresAt <= nowIso
    ) {
      this.db
        .prepare(
          `UPDATE orientation_nudge_state
           SET vacation_mode_active = 0,
               vacation_mode_expires_at = NULL,
               updated_at = ?
           WHERE user_id = ?`,
        )
        .run(nowIso, userId);
      this.insertEvent(userId, "vacation_expired", now, {});
    }
  }

  recordNoteObservation(
    userId: string,
    observation: DailyNoteObservation,
    now: Date,
  ): OrientationNudgeState {
    const state = this.getState(userId, now);
    const updates: string[] = [];
    const values: Array<string | number | null> = [];
    const nowIso = now.toISOString();

    const latestInterstitialIso = observation.latestInterstitial?.at.toISOString() ?? null;
    if (
      latestInterstitialIso &&
      (!state.lastInterstitialLogAt || latestInterstitialIso > state.lastInterstitialLogAt)
    ) {
      updates.push("last_interstitial_log_at = ?");
      values.push(latestInterstitialIso);
    }

    if (
      observation.rotationSignature &&
      observation.rotationSignature !== state.taskRotationSignature
    ) {
      updates.push("task_rotation_signature = ?");
      values.push(observation.rotationSignature);
      updates.push("task_rotation_task = ?");
      values.push(observation.currentTask);
      updates.push("last_task_rotation_change_at = ?");
      values.push(nowIso);
    } else if (observation.currentTask !== state.taskRotationTask) {
      updates.push("task_rotation_task = ?");
      values.push(observation.currentTask);
    }

    if (updates.length === 0) {
      return state;
    }

    updates.push("updated_at = ?");
    values.push(nowIso);
    values.push(userId);
    this.db
      .prepare(`UPDATE orientation_nudge_state SET ${updates.join(", ")} WHERE user_id = ?`)
      .run(...values);
    return this.getState(userId, now);
  }

  markActiveNudgeIgnoredIfDue(
    userId: string,
    now: Date,
    config: OrientationNudgeConfig,
  ): { ignored: boolean; state: OrientationNudgeState } {
    const state = this.getState(userId, now);
    if (!state.activeNudgeId || !state.activeNudgeSentAt) {
      return { ignored: false, state };
    }

    const sentAtMs = Date.parse(state.activeNudgeSentAt);
    if (!Number.isFinite(sentAtMs)) {
      return { ignored: false, state };
    }

    const ignoreAfterMs = config.ignoreAfterMinutes * 60_000;
    if (now.getTime() - sentAtMs < ignoreAfterMs) {
      return { ignored: false, state };
    }

    const unanswered = state.unansweredNudgeCount + 1;
    const cooldownUntil = computeCooldownUntil(unanswered, now, config);
    const nowIso = now.toISOString();
    this.db
      .prepare(
        `UPDATE orientation_nudge_state
         SET active_nudge_id = NULL,
             active_nudge_message_id = NULL,
             active_nudge_channel_id = NULL,
             active_nudge_task = NULL,
             active_nudge_sent_at = NULL,
             unanswered_nudge_count = ?,
             cooldown_until = ?,
             updated_at = ?
         WHERE user_id = ?`,
      )
      .run(unanswered, cooldownUntil?.toISOString() ?? null, nowIso, userId);
    this.insertEvent(userId, "nudge_ignored", now, {
      nudgeId: state.activeNudgeId,
      task: state.activeNudgeTask,
      unansweredNudgeCount: unanswered,
      cooldownUntil: cooldownUntil?.toISOString() ?? null,
    });
    return { ignored: true, state: this.getState(userId, now) };
  }

  recordNudgeSent(input: {
    userId: string;
    nudgeId: string;
    messageId: string;
    channelId: string;
    task: string | null;
    now: Date;
  }): void {
    const nowIso = input.now.toISOString();
    this.ensureState(input.userId, input.now);
    this.db
      .prepare(
        `UPDATE orientation_nudge_state
         SET last_nudge_at = ?,
             active_nudge_id = ?,
             active_nudge_message_id = ?,
             active_nudge_channel_id = ?,
             active_nudge_task = ?,
             active_nudge_sent_at = ?,
             updated_at = ?
         WHERE user_id = ?`,
      )
      .run(
        nowIso,
        input.nudgeId,
        input.messageId,
        input.channelId,
        input.task,
        nowIso,
        nowIso,
        input.userId,
      );
    this.insertEvent(input.userId, "nudge_sent", input.now, {
      nudgeId: input.nudgeId,
      discordMessageId: input.messageId,
      discordChannelId: input.channelId,
      task: input.task,
    });
  }

  recordNudgeResponse(input: {
    userId: string;
    nudgeId: string;
    response: "yes" | "no" | "focus" | "vacation";
    task?: string | null;
    now: Date;
  }): void {
    const nowIso = input.now.toISOString();
    this.db
      .prepare(
        `UPDATE orientation_nudge_state
         SET last_nudge_response_at = ?,
             active_nudge_id = NULL,
             active_nudge_message_id = NULL,
             active_nudge_channel_id = NULL,
             active_nudge_task = NULL,
             active_nudge_sent_at = NULL,
             unanswered_nudge_count = 0,
             cooldown_until = NULL,
             updated_at = ?
         WHERE user_id = ?`,
      )
      .run(nowIso, nowIso, input.userId);
    this.insertEvent(input.userId, `response_${input.response}`, input.now, {
      nudgeId: input.nudgeId,
      task: input.task ?? null,
    });
  }

  recordInterstitialActivity(userId: string, now: Date, task: string): void {
    const nowIso = now.toISOString();
    this.ensureState(userId, now);
    this.db
      .prepare(
        `UPDATE orientation_nudge_state
         SET last_interstitial_log_at = ?,
             updated_at = ?
         WHERE user_id = ?`,
      )
      .run(nowIso, nowIso, userId);
    this.insertEvent(userId, "interstitial_logged", now, { task });
  }

  setFocusMode(userId: string, task: string, expiresAt: Date, now: Date, actor: string): void {
    const nowIso = now.toISOString();
    this.ensureState(userId, now);
    this.db
      .prepare(
        `UPDATE orientation_nudge_state
         SET focus_mode_active = 1,
             focus_mode_task = ?,
             focus_mode_expires_at = ?,
             updated_at = ?
         WHERE user_id = ?`,
      )
      .run(task, expiresAt.toISOString(), nowIso, userId);
    this.insertEvent(userId, "focus_set", now, {
      actor,
      task,
      expiresAt: expiresAt.toISOString(),
    });
  }

  clearFocusMode(userId: string, now: Date, actor: string): void {
    const nowIso = now.toISOString();
    this.ensureState(userId, now);
    this.db
      .prepare(
        `UPDATE orientation_nudge_state
         SET focus_mode_active = 0,
             focus_mode_task = NULL,
             focus_mode_expires_at = NULL,
             updated_at = ?
         WHERE user_id = ?`,
      )
      .run(nowIso, userId);
    this.insertEvent(userId, "focus_cleared", now, { actor });
  }

  setVacationMode(userId: string, expiresAt: Date, now: Date, actor: string): void {
    const nowIso = now.toISOString();
    this.ensureState(userId, now);
    this.db
      .prepare(
        `UPDATE orientation_nudge_state
         SET vacation_mode_active = 1,
             vacation_mode_expires_at = ?,
             updated_at = ?
         WHERE user_id = ?`,
      )
      .run(expiresAt.toISOString(), nowIso, userId);
    this.insertEvent(userId, "vacation_set", now, {
      actor,
      expiresAt: expiresAt.toISOString(),
    });
  }

  clearVacationMode(userId: string, now: Date, actor: string): void {
    const nowIso = now.toISOString();
    this.ensureState(userId, now);
    this.db
      .prepare(
        `UPDATE orientation_nudge_state
         SET vacation_mode_active = 0,
             vacation_mode_expires_at = NULL,
             updated_at = ?
         WHERE user_id = ?`,
      )
      .run(nowIso, userId);
    this.insertEvent(userId, "vacation_cleared", now, { actor });
  }

  isActiveNudge(userId: string, nudgeId: string, now = new Date()): boolean {
    return this.getState(userId, now).activeNudgeId === nudgeId;
  }

  private ensureState(userId: string, now: Date): void {
    const nowIso = now.toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO orientation_nudge_state (user_id, created_at, updated_at)
         VALUES (?, ?, ?)`,
      )
      .run(userId, nowIso, nowIso);
  }

  private insertEvent(
    userId: string,
    eventType: string,
    now: Date,
    metadata: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        `INSERT INTO orientation_nudge_events (user_id, event_type, metadata_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(userId, eventType, JSON.stringify(metadata), now.toISOString());
  }
}

function rowToState(row: Record<string, unknown>): OrientationNudgeState {
  return {
    userId: stringField(row.userId),
    focusModeActive: booleanField(row.focusModeActive),
    focusModeTask: nullableStringField(row.focusModeTask),
    focusModeExpiresAt: nullableStringField(row.focusModeExpiresAt),
    vacationModeActive: booleanField(row.vacationModeActive),
    vacationModeExpiresAt: nullableStringField(row.vacationModeExpiresAt),
    lastInterstitialLogAt: nullableStringField(row.lastInterstitialLogAt),
    lastTaskRotationChangeAt: nullableStringField(row.lastTaskRotationChangeAt),
    taskRotationSignature: nullableStringField(row.taskRotationSignature),
    taskRotationTask: nullableStringField(row.taskRotationTask),
    lastNudgeAt: nullableStringField(row.lastNudgeAt),
    lastNudgeResponseAt: nullableStringField(row.lastNudgeResponseAt),
    activeNudgeId: nullableStringField(row.activeNudgeId),
    activeNudgeMessageId: nullableStringField(row.activeNudgeMessageId),
    activeNudgeChannelId: nullableStringField(row.activeNudgeChannelId),
    activeNudgeTask: nullableStringField(row.activeNudgeTask),
    activeNudgeSentAt: nullableStringField(row.activeNudgeSentAt),
    unansweredNudgeCount: numberField(row.unansweredNudgeCount),
    cooldownUntil: nullableStringField(row.cooldownUntil),
    createdAt: stringField(row.createdAt),
    updatedAt: stringField(row.updatedAt),
  };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableStringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function booleanField(value: unknown): boolean {
  return value === true || value === 1;
}

function computeCooldownUntil(
  unansweredCount: number,
  now: Date,
  config: OrientationNudgeConfig,
): Date | null {
  if (unansweredCount <= config.cooldownAfterMisses) {
    return null;
  }
  const exponent = unansweredCount - config.cooldownAfterMisses - 1;
  const minutes = Math.min(
    config.cooldownMaxMinutes,
    config.cooldownBaseMinutes * Math.pow(2, exponent),
  );
  return new Date(now.getTime() + minutes * 60_000);
}

/**
 * Blocked rotation items are marked with a leading 🚧 and carry a `— blocked:`
 * note. They stay in the rotation but are never offered as the current task —
 * nudging work that can't move is noise.
 */
export function isBlockedRotationItem(text: string): boolean {
  return text.trimStart().startsWith("🚧");
}

export function parseDailyNote(
  content: string,
  date: string,
): Pick<DailyNoteObservation, "currentTask" | "latestInterstitial" | "rotationItems" | "rotationSignature"> {
  const rotationBody = markdownSectionBody(content, "Current Task Rotation");
  const rotationItems = rotationBody ? parseTaskRotation(rotationBody) : [];
  const currentTask = rotationItems.find((item) => !item.checked && !isBlockedRotationItem(item.text))?.text ?? null;
  const interstitialBody = markdownSectionBody(content, "Interstitial Log");
  const latestInterstitial = interstitialBody ? parseLatestInterstitial(interstitialBody, date) : null;
  const rotationSignature = rotationItems.length > 0
    ? rotationItems.map((item) => `${item.checked ? "x" : " "}:${item.text}`).join("\n")
    : null;

  return {
    currentTask,
    latestInterstitial,
    rotationItems,
    rotationSignature,
  };
}

function markdownSectionBody(content: string, heading: string): string | null {
  const lines = content.split(/\r?\n/u);
  const headingPattern = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "u");
  const start = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+\S/u.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

function parseTaskRotation(body: string): TaskRotationItem[] {
  return body
    .split(/\r?\n/u)
    .map((line) => {
      const match = /^-\s+\[([ xX])\]\s+(.+?)\s*$/u.exec(line);
      if (!match?.[2]) return null;
      const text = match[2].trim();
      if (!text || text === "-") return null;
      return {
        checked: match[1]?.toLowerCase() === "x",
        text,
      };
    })
    .filter((item): item is TaskRotationItem => item !== null);
}

function parseLatestInterstitial(body: string, date: string): InterstitialLogEntry | null {
  let latest: InterstitialLogEntry | null = null;
  for (const line of body.split(/\r?\n/u)) {
    const parsed = parseInterstitialLine(line, date);
    if (!parsed) continue;
    if (!latest || parsed.at.getTime() > latest.at.getTime()) {
      latest = parsed;
    }
  }
  return latest;
}

function parseInterstitialLine(line: string, date: string): InterstitialLogEntry | null {
  const trimmed = line.trim();
  const match = /^(?:-\s*)?(?:\[(\d{1,2}):(\d{2})\]|(\d{1,2}):(\d{2}))\s*(?:[-:]\s*)?(.*)$/u.exec(trimmed);
  const hourRaw = match?.[1] ?? match?.[3];
  const minuteRaw = match?.[2] ?? match?.[4];
  if (!match || !hourRaw || !minuteRaw) return null;
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) {
    return null;
  }
  const text = (match[5] ?? "").trim();
  return {
    at: localDateTime(date, hour, minute),
    text,
  };
}

function localDateTime(date: string, hour: number, minute: number): Date {
  return new Date(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`);
}

export function readDailyNoteObservation(
  now: Date,
  config: OrientationNudgeConfig,
): DailyNoteObservation {
  const date = localDateString(now, config.timeZone);
  const notePath = path.join(config.vaultRoot, "Planning", "Daily", `${date}.md`);
  let content: string;
  try {
    content = fs.readFileSync(notePath, "utf8");
  } catch {
    return {
      notePath,
      noteFound: false,
      date,
      currentTask: null,
      latestInterstitial: null,
      rotationItems: [],
      rotationSignature: null,
    };
  }
  const parsed = parseDailyNote(content, date);
  return {
    notePath,
    noteFound: true,
    date,
    ...parsed,
  };
}

export function evaluateOrientationNudge(input: {
  state: OrientationNudgeState;
  observation: DailyNoteObservation;
  calendarBlocker: CalendarBlocker | null;
  now: Date;
  config: OrientationNudgeConfig;
}): OrientationNudgeDecision {
  const { state, observation, calendarBlocker, now, config } = input;
  if (!isWithinActiveHours(now, config)) {
    return { action: "skip", reason: "outside active hours" };
  }
  if (!observation.noteFound) {
    return { action: "skip", reason: "daily note not found" };
  }
  if (state.focusModeActive) {
    return { action: "skip", reason: "focus mode active" };
  }
  if (state.vacationModeActive) {
    return { action: "skip", reason: "vacation mode active" };
  }
  if (state.activeNudgeId) {
    return { action: "skip", reason: "awaiting nudge response" };
  }
  if (state.cooldownUntil && Date.parse(state.cooldownUntil) > now.getTime()) {
    return { action: "skip", reason: "cooldown active" };
  }
  if (state.lastNudgeAt && now.getTime() - Date.parse(state.lastNudgeAt) < config.minNudgeIntervalMinutes * 60_000) {
    return { action: "skip", reason: "minimum interval active" };
  }
  if (calendarBlocker) {
    return { action: "skip", reason: `calendar event: ${calendarBlocker.title}` };
  }

  const lastActivityAt = latestIso([state.lastInterstitialLogAt, state.lastTaskRotationChangeAt]);
  if (lastActivityAt && now.getTime() - Date.parse(lastActivityAt) < config.inactivityMinutes * 60_000) {
    return { action: "skip", reason: "recent daily note activity" };
  }

  // The interstitial log is the only source of truth for what he's doing now.
  // Rotation contents are deliberately ignored: "Task rotation" is itself a
  // mode that gets logged like any other, so the nudge asks about the mode and
  // never names an individual item inside the rotation. No log entry means we
  // don't know, and the nudge asks rather than guesses.
  const task = observation.latestInterstitial?.text ?? null;
  return { action: "send", task };
}

function latestIso(values: Array<string | null>): string | null {
  const sorted = values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left));
  return sorted[0] ?? null;
}

function isWithinActiveHours(now: Date, config: OrientationNudgeConfig): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  const localMinutes = hour * 60 + minute;
  return localMinutes >= config.activeStartHour * 60 && localMinutes < config.activeEndHour * 60;
}

function localDateString(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

export function findBlockingCalendarEvent(rawEvents: unknown[], now: Date): CalendarBlocker | null {
  for (const event of rawEvents) {
    const parsed = parseCalendarEvent(event);
    if (!parsed || parsed.allDay) continue;
    if (parsed.status === "cancelled") continue;
    if (isIgnoredCalendarBlocker(parsed.title)) continue;
    if (parsed.start.getTime() <= now.getTime() && now.getTime() < parsed.end.getTime()) {
      return {
        title: parsed.title,
        startsAt: parsed.start.toISOString(),
        endsAt: parsed.end.toISOString(),
      };
    }
  }
  return null;
}

function isIgnoredCalendarBlocker(title: string): boolean {
  return title.trim().toLowerCase().startsWith("block:");
}

function parseCalendarEvent(event: unknown): {
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  status: string | null;
} | null {
  const raw = event as Record<string, unknown>;
  const title = typeof raw.summary === "string" && raw.summary.trim()
    ? raw.summary.trim()
    : "(untitled event)";
  const status = typeof raw.status === "string" ? raw.status : null;
  const start = raw.start as Record<string, unknown> | undefined;
  const end = raw.end as Record<string, unknown> | undefined;
  const startDateTime = typeof start?.dateTime === "string" ? start.dateTime : null;
  const endDateTime = typeof end?.dateTime === "string" ? end.dateTime : null;
  if (startDateTime && endDateTime) {
    const startAt = new Date(startDateTime);
    const endAt = new Date(endDateTime);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      return null;
    }
    return { title, start: startAt, end: endAt, allDay: false, status };
  }
  const startDate = typeof start?.date === "string" ? start.date : null;
  const endDate = typeof end?.date === "string" ? end.date : null;
  if (startDate && endDate) {
    return {
      title,
      start: new Date(`${startDate}T00:00:00`),
      end: new Date(`${endDate}T00:00:00`),
      allDay: true,
      status,
    };
  }
  return null;
}

export async function defaultFetchCalendarBlocker(
  now: Date,
  config: OrientationNudgeConfig,
): Promise<CalendarBlocker | null> {
  const date = localDateString(now, config.timeZone);
  const accounts = (process.env.ORIENTATION_NUDGE_CALENDAR_ACCOUNTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const allEvents = accounts.length > 0
    ? accounts.flatMap((account) => fetchCalendarEvents(date, config.timeZone, account))
    : fetchCalendarEvents(date, config.timeZone, null);
  return findBlockingCalendarEvent(allEvents, now);
}

function fetchCalendarEvents(date: string, timeZone: string, account: string | null): unknown[] {
  const args = [
    "calendar",
    "events",
    "--from",
    date,
    "--days",
    "1",
    "--all",
    "--all-pages",
    "--json",
    "--no-input",
  ];
  if (account) {
    args.push("--account", account);
  }
  const output = execFileSync("gog", args, {
    encoding: "utf8",
    env: calendarCommandEnv(timeZone),
    stdio: ["ignore", "pipe", "pipe"],
    // A network stall must not freeze the process for its duration.
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  const parsed = JSON.parse(output) as unknown;
  if (Array.isArray(parsed)) return parsed;
  const events = (parsed as { events?: unknown }).events;
  return Array.isArray(events) ? events : [];
}

function calendarCommandEnv(timeZone: string): NodeJS.ProcessEnv {
  return createGogCommandEnv({ ...process.env, TZ: timeZone });
}

export function createOrientationNudgeHandler(
  client: Client,
  options: OrientationNudgeHandlerOptions = {},
): DeterministicHandler {
  return async (ctx) => {
    const now = options.now?.() ?? new Date();
    const config = resolveOrientationNudgeConfig({
      timeZone: options.timeZone,
      vaultRoot: options.vaultRoot,
    });
    const store = new OrientationNudgeStore(ctx.db);
    store.normalizeExpiredModes(config.userId, now);

    const observation = readDailyNoteObservation(now, config);
    let state = store.recordNoteObservation(config.userId, observation, now);
    const ignored = store.markActiveNudgeIgnoredIfDue(config.userId, now, config);
    state = ignored.state;

    let calendarBlocker: CalendarBlocker | null = null;
    try {
      calendarBlocker = await (options.fetchCalendarBlocker ?? defaultFetchCalendarBlocker)(now, config);
    } catch (error) {
      return {
        status: "skipped",
        summary: `Calendar read failed; skipped nudge: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const decision = evaluateOrientationNudge({
      state,
      observation,
      calendarBlocker,
      now,
      config,
    });

    if (decision.action === "skip") {
      return {
        status: "skipped",
        summary: `${decision.reason}${ignored.ignored ? " after logging ignored nudge" : ""}`,
        data: { reason: decision.reason, ignored: ignored.ignored },
      };
    }

    const channelId = options.channelId?.trim() || "";
    if (!channelId) {
      return {
        status: "error",
        summary: "Orientation nudge channel is not configured.",
      };
    }
    if (!client.isReady()) {
      return {
        status: "skipped",
        summary: "Discord client is not ready.",
      };
    }

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      return {
        status: "error",
        summary: `Orientation nudge channel ${channelId} is unavailable or not text-based.`,
      };
    }

    const nudgeId = randomUUID();
    const content = buildNudgeMessage(decision.task);
    const message = await channel.send({
      content,
      components: buildNudgeComponents(nudgeId),
    }) as Message;
    store.recordNudgeSent({
      userId: config.userId,
      nudgeId,
      messageId: message.id,
      channelId,
      task: decision.task,
      now,
    });
    await options.recordNudgeMessage?.({
      messageId: message.id,
      channelId,
      content,
      nudgeId,
      task: decision.task,
    });

    return {
      status: "ok",
      summary: `Sent orientation nudge for ${decision.task ?? "an unlogged task"}`,
      data: { nudgeId, channelId, task: decision.task },
    };
  };
}

function buildNudgeMessage(task: string | null): string {
  if (!task) {
    return "What are you working on right now?";
  }
  return `Are you still working on **${escapeDiscordMarkdown(task)}**?`;
}

function buildNudgeComponents(nudgeId: string): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${ORIENTATION_CUSTOM_ID_PREFIX}:yes:${nudgeId}`)
        .setStyle(ButtonStyle.Success)
        .setEmoji("✅")
        .setLabel("Yes"),
      new ButtonBuilder()
        .setCustomId(`${ORIENTATION_CUSTOM_ID_PREFIX}:no:${nudgeId}`)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("🔄")
        .setLabel("No"),
      new ButtonBuilder()
        .setCustomId(`${ORIENTATION_CUSTOM_ID_PREFIX}:focus:${nudgeId}`)
        .setStyle(ButtonStyle.Primary)
        .setEmoji("🎯")
        .setLabel("Focus Mode"),
      new ButtonBuilder()
        .setCustomId(`${ORIENTATION_CUSTOM_ID_PREFIX}:vacation:${nudgeId}`)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("🏖️")
        .setLabel("Vacation"),
    ),
  ];
}

export async function handleOrientationNudgeInteraction(
  interaction: Interaction,
  options: OrientationNudgeInteractionOptions,
): Promise<boolean> {
  if (interaction.isButton() && interaction.customId.startsWith(`${ORIENTATION_CUSTOM_ID_PREFIX}:`)) {
    await handleOrientationButton(interaction, options);
    return true;
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith(`${ORIENTATION_CUSTOM_ID_PREFIX}:modal:`)) {
    await handleOrientationModal(interaction, options);
    return true;
  }
  return false;
}

async function handleOrientationButton(
  interaction: ButtonInteraction,
  options: OrientationNudgeInteractionOptions,
): Promise<void> {
  const parsed = parseComponentId(interaction.customId);
  const now = options.now?.() ?? new Date();
  const config = resolveOrientationNudgeConfig({
    timeZone: options.timeZone,
    vaultRoot: options.vaultRoot,
  });
  const store = new OrientationNudgeStore(options.db);

  if (!parsed || !store.isActiveNudge(config.userId, parsed.nudgeId, now)) {
    await interaction.reply({
      content: "That orientation nudge has expired.",
      ephemeral: true,
    });
    return;
  }

  switch (parsed.action) {
    case "yes": {
      const state = store.getState(config.userId, now);
      store.recordNudgeResponse({
        userId: config.userId,
        nudgeId: parsed.nudgeId,
        response: "yes",
        task: state.activeNudgeTask,
        now,
      });
      await interaction.update({
        content: `Confirmed: still working on **${escapeDiscordMarkdown(state.activeNudgeTask ?? "the current task")}**.`,
        components: [],
      });
      return;
    }
    case "no":
      await interaction.showModal(buildTaskModal("no", parsed.nudgeId, "What are you working on now?", ""));
      return;
    case "focus": {
      const state = store.getState(config.userId, now);
      await interaction.showModal(buildTaskModal(
        "focus",
        parsed.nudgeId,
        "Focus mode task",
        state.activeNudgeTask?.replace(/^Task rotation:\s*/u, "") ?? "",
      ));
      return;
    }
    case "vacation":
      await interaction.showModal(buildVacationModal(parsed.nudgeId, now, config));
      return;
    default:
      await interaction.reply({
        content: "Unknown orientation action.",
        ephemeral: true,
      });
  }
}

async function handleOrientationModal(
  interaction: ModalSubmitInteraction,
  options: OrientationNudgeInteractionOptions,
): Promise<void> {
  const parsed = parseModalId(interaction.customId);
  const now = options.now?.() ?? new Date();
  const config = resolveOrientationNudgeConfig({
    timeZone: options.timeZone,
    vaultRoot: options.vaultRoot,
  });
  const store = new OrientationNudgeStore(options.db);

  if (!parsed || !store.isActiveNudge(config.userId, parsed.nudgeId, now)) {
    await interaction.reply({
      content: "That orientation nudge has expired.",
      ephemeral: true,
    });
    return;
  }

  if (parsed.action === "no") {
    const task = getModalValue(interaction, "task").trim();
    if (!task) {
      await interaction.reply({ content: "I need a task to log.", ephemeral: true });
      return;
    }
    appendInterstitialLogEntry(config.vaultRoot, now, config.timeZone, task);
    store.recordInterstitialActivity(config.userId, now, task);
    store.recordNudgeResponse({
      userId: config.userId,
      nudgeId: parsed.nudgeId,
      response: "no",
      task,
      now,
    });
    await interaction.reply({
      content: `Logged the new task: **${escapeDiscordMarkdown(task)}**.`,
      ephemeral: true,
    });
    await clearOriginalComponents(interaction);
    return;
  }

  if (parsed.action === "focus") {
    const task = getModalValue(interaction, "task").trim();
    if (!task) {
      await interaction.reply({ content: "I need a focus task.", ephemeral: true });
      return;
    }
    const expiresAt = new Date(now.getTime() + config.defaultFocusMinutes * 60_000);
    store.setFocusMode(config.userId, task, expiresAt, now, "discord");
    store.recordNudgeResponse({
      userId: config.userId,
      nudgeId: parsed.nudgeId,
      response: "focus",
      task,
      now,
    });
    await interaction.reply({
      content: `Focus mode is on for **${escapeDiscordMarkdown(task)}** until ${formatLocalDateTime(expiresAt, config.timeZone)}.`,
      ephemeral: true,
    });
    await clearOriginalComponents(interaction);
    return;
  }

  if (parsed.action === "vacation") {
    const rawUntil = getModalValue(interaction, "until").trim();
    let expiresAt: Date;
    try {
      expiresAt = parseUntil(rawUntil, now, config.defaultVacationDays * 24 * 60);
    } catch (error) {
      await interaction.reply({
        content: error instanceof Error ? error.message : String(error),
        ephemeral: true,
      });
      return;
    }
    store.setVacationMode(config.userId, expiresAt, now, "discord");
    store.recordNudgeResponse({
      userId: config.userId,
      nudgeId: parsed.nudgeId,
      response: "vacation",
      now,
    });
    await interaction.reply({
      content: `Vacation mode is on until ${formatLocalDateTime(expiresAt, config.timeZone)}.`,
      ephemeral: true,
    });
    await clearOriginalComponents(interaction);
    return;
  }
}

function parseComponentId(customId: string): { action: string; nudgeId: string } | null {
  const [prefix, action, nudgeId] = customId.split(":");
  if (prefix !== ORIENTATION_CUSTOM_ID_PREFIX || !action || !nudgeId) return null;
  return { action, nudgeId };
}

function parseModalId(customId: string): { action: string; nudgeId: string } | null {
  const [prefix, modal, action, nudgeId] = customId.split(":");
  if (prefix !== ORIENTATION_CUSTOM_ID_PREFIX || modal !== "modal" || !action || !nudgeId) {
    return null;
  }
  return { action, nudgeId };
}

function buildTaskModal(
  action: "no" | "focus",
  nudgeId: string,
  title: string,
  defaultTask: string,
): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${ORIENTATION_CUSTOM_ID_PREFIX}:modal:${action}:${nudgeId}`)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("task")
          .setLabel("Task")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(180)
          .setValue(defaultTask.slice(0, 180)),
      ),
    );
}

function buildVacationModal(
  nudgeId: string,
  now: Date,
  config: OrientationNudgeConfig,
): ModalBuilder {
  const defaultUntil = new Date(now.getTime() + config.defaultVacationDays * 24 * 60 * 60_000);
  return new ModalBuilder()
    .setCustomId(`${ORIENTATION_CUSTOM_ID_PREFIX}:modal:vacation:${nudgeId}`)
    .setTitle("Vacation mode")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("until")
          .setLabel("Until")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(32)
          .setValue(formatLocalDateTime(defaultUntil, config.timeZone)),
      ),
    );
}

function getModalValue(interaction: ModalSubmitInteraction, id: string): string {
  try {
    return interaction.fields.getTextInputValue(id);
  } catch {
    return "";
  }
}

async function clearOriginalComponents(interaction: ModalSubmitInteraction): Promise<void> {
  const maybeMessage = (interaction as { message?: Message | null }).message;
  await maybeMessage?.edit({ components: [] }).catch(() => undefined);
}

export { appendLineToSection };

function parseUntil(raw: string, now: Date, defaultDurationMinutes: number): Date {
  if (!raw) {
    return new Date(now.getTime() + defaultDurationMinutes * 60_000);
  }
  const localDateTimeMatch = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/u.exec(raw);
  const dateOnlyMatch = /^(\d{4}-\d{2}-\d{2})$/u.exec(raw);
  const parsed = localDateTimeMatch
    ? new Date(`${localDateTimeMatch[1]}T${String(localDateTimeMatch[2]).padStart(2, "0")}:${localDateTimeMatch[3]}:00`)
    : dateOnlyMatch
      ? new Date(`${dateOnlyMatch[1]}T23:59:00`)
      : new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Use an ISO timestamp, YYYY-MM-DD, or YYYY-MM-DD HH:mm for the end time.");
  }
  if (parsed.getTime() <= now.getTime()) {
    throw new Error("The end time must be in the future.");
  }
  return parsed;
}

function formatLocalDateTime(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}`;
}

function formatLocalTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function createOrientationNudgeTools(): AgentTool[] {
  return [
    {
      name: "orientation_nudge",
      description: [
        "Read or change the orientation nudge system state.",
        "",
        "Operations:",
        "  status - Show focus/vacation/cooldown state.",
        "  set_focus - Silence nudges for focused work. Fields: task, until or duration_minutes.",
        "  clear_focus - Turn off focus mode.",
        "  set_vacation - Silence nudges until an explicit end. Field: until, default one week.",
        "  clear_vacation - Turn off vacation mode.",
        "",
        "Use ISO timestamps or YYYY-MM-DD HH:mm for until.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["status", "set_focus", "clear_focus", "set_vacation", "clear_vacation"],
          },
          task: { type: "string" },
          until: { type: "string" },
          duration_minutes: { type: "number" },
        },
        required: ["operation"],
      },
      handler: async (input) => {
        const storage = new TangoStorage(resolveDatabasePath());
        try {
          const now = new Date();
          const config = resolveOrientationNudgeConfig();
          const store = new OrientationNudgeStore(storage.getDatabase());
          const operation = String(input.operation ?? "");
          store.normalizeExpiredModes(config.userId, now);

          switch (operation) {
            case "status":
              return { result: JSON.stringify(store.getState(config.userId, now), null, 2) };
            case "set_focus": {
              const task = String(input.task ?? "").trim();
              if (!task) return { error: "task is required for set_focus" };
              const durationRaw = Number(input.duration_minutes ?? config.defaultFocusMinutes);
              const until = typeof input.until === "string" && input.until.trim()
                ? parseUntil(input.until, now, config.defaultFocusMinutes)
                : new Date(now.getTime() + (Number.isFinite(durationRaw) ? durationRaw : config.defaultFocusMinutes) * 60_000);
              store.setFocusMode(config.userId, task, until, now, "watson");
              return { result: `Focus mode set for '${task}' until ${until.toISOString()}` };
            }
            case "clear_focus":
              store.clearFocusMode(config.userId, now, "watson");
              return { result: "Focus mode cleared." };
            case "set_vacation": {
              const until = parseUntil(
                typeof input.until === "string" ? input.until : "",
                now,
                config.defaultVacationDays * 24 * 60,
              );
              store.setVacationMode(config.userId, until, now, "watson");
              return { result: `Vacation mode set until ${until.toISOString()}` };
            }
            case "clear_vacation":
              store.clearVacationMode(config.userId, now, "watson");
              return { result: "Vacation mode cleared." };
            default:
              return { error: `Unknown operation: ${operation}` };
          }
        } finally {
          storage.close();
        }
      },
    },
  ];
}

export function orientationNudgeToolLooksReadOnly(operation: unknown): boolean {
  return typeof operation === "string" && operation.trim().toLowerCase() === "status";
}

function escapeDiscordMarkdown(value: string): string {
  return value.replace(/([*_`~|\\])/gu, "\\$1");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
