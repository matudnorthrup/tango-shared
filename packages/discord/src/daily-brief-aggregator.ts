import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DeterministicHandler } from "@tango/core";
import { ensureDailyNote, getMorningFlowDate } from "./morning-flow.js";
import { createGogCommandEnv } from "./gog-keyring-password.js";

const DEFAULT_TIME_ZONE = "America/Los_Angeles";
const DEFAULT_VAULT_ROOT = path.join(os.homedir(), "Documents", "main");
const DEFAULT_LOOKBACK_HOURS = 24;
const AGGREGATOR_INTERNAL_SCHEDULES = new Set(["daily-brief", "morning-planning"]);

interface DailyBriefRegistry {
  lookbackHours?: unknown;
  inputs?: DailyBriefRegistryInput[];
}

interface DailyBriefRegistryInput {
  scheduleId?: unknown;
  displayName?: unknown;
  domain?: unknown;
  logPath?: unknown;
  critical?: unknown;
  sections?: unknown;
}

interface DailyBriefInput {
  scheduleId: string;
  displayName: string;
  domain: string;
  logPath: string;
  critical: boolean;
  sections: string[];
}

interface JobLogEntry {
  input: DailyBriefInput;
  title: string;
  localDate: string;
  localTime: string;
  startedAt: Date;
  body: string;
  status?: string;
  summary?: string;
}

export interface DailyBriefCalendarEvent {
  timeLabel: string;
  title: string;
  sortKey: string;
}

export interface DailyBriefAggregationResult {
  date: string;
  briefPath: string;
  wroteBrief: boolean;
  inputsChecked: number;
  entriesFound: number;
  flaggedCount: number;
  slackItemCount: number;
  overnightJobCount: number;
  calendarEventCount: number;
  missingLogPaths: string[];
  calendarWarnings: string[];
}

export interface DailyBriefAggregationOptions {
  now?: Date;
  timeZone?: string;
  vaultRoot?: string;
  inputRegistryPath?: string;
  fetchCalendarEvents?: (date: string, timeZone: string) => DailyBriefCalendarEvent[];
}

function defaultInputRegistryPath(): string {
  return path.resolve(process.cwd(), "config", "defaults", "daily-brief-inputs.json");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function readDailyBriefInputs(inputRegistryPath?: string): {
  lookbackHours: number;
  inputs: DailyBriefInput[];
} {
  const registryPath = inputRegistryPath ?? defaultInputRegistryPath();
  const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8")) as DailyBriefRegistry;
  const lookbackHours =
    typeof parsed.lookbackHours === "number" && parsed.lookbackHours > 0
      ? parsed.lookbackHours
      : DEFAULT_LOOKBACK_HOURS;
  const inputs = (parsed.inputs ?? [])
    .map((input): DailyBriefInput | null => {
      if (
        typeof input.scheduleId !== "string" ||
        typeof input.displayName !== "string" ||
        typeof input.domain !== "string" ||
        typeof input.logPath !== "string"
      ) {
        return null;
      }

      return {
        scheduleId: input.scheduleId,
        displayName: input.displayName,
        domain: input.domain,
        logPath: input.logPath,
        critical: input.critical !== false,
        sections: isStringArray(input.sections) ? input.sections : ["overnightJobs"],
      };
    })
    .filter((input): input is DailyBriefInput => input !== null);

  return { lookbackHours, inputs };
}

function localParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "0";

  return {
    year: Number.parseInt(value("year"), 10),
    month: Number.parseInt(value("month"), 10),
    day: Number.parseInt(value("day"), 10),
    hour: Number.parseInt(value("hour"), 10),
    minute: Number.parseInt(value("minute"), 10),
  };
}

function localDateTimeToInstant(localDate: string, localTime: string, timeZone: string): Date {
  const dateParts = localDate
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  const timeParts = localTime.split(":").map((part) => Number.parseInt(part, 10));
  const year = dateParts[0] ?? 0;
  const month = dateParts[1] ?? 1;
  const day = dateParts[2] ?? 1;
  const hour = timeParts[0] ?? 0;
  const minute = timeParts[1] ?? 0;
  const desiredUtcMs = Date.UTC(year, month - 1, day, hour, minute);
  const firstGuess = new Date(desiredUtcMs);
  const actual = localParts(firstGuess, timeZone);
  const actualUtcMs = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
  return new Date(firstGuess.getTime() + (desiredUtcMs - actualUtcMs));
}

function monthKey(date: Date, timeZone: string): string {
  const parts = localParts(date, timeZone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}`;
}

function logPathsForInput(
  input: DailyBriefInput,
  vaultRoot: string,
  now: Date,
  timeZone: string,
  lookbackHours: number,
): string[] {
  const months = new Set([
    monthKey(now, timeZone),
    monthKey(new Date(now.getTime() - lookbackHours * 60 * 60 * 1000), timeZone),
  ]);

  return [...months].map((month) => path.join(vaultRoot, input.logPath.replace("YYYY-MM", month)));
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

function containsTokensInOrder(haystack: string, needle: string): boolean {
  const haystackTokens = haystack.split(/\s+/u).filter(Boolean);
  const needleTokens = needle.split(/\s+/u).filter(Boolean);
  if (needleTokens.length === 0) {
    return false;
  }

  let cursor = 0;
  for (const token of haystackTokens) {
    if (token === needleTokens[cursor]) {
      cursor += 1;
      if (cursor === needleTokens.length) {
        return true;
      }
    }
  }
  return false;
}

function entryMatchesInput(title: string, input: DailyBriefInput): boolean {
  const titleKey = normalizeKey(title);
  const displayKey = normalizeKey(input.displayName);
  const scheduleKey = normalizeKey(input.scheduleId);
  return (
    titleKey === displayKey ||
    titleKey.includes(displayKey) ||
    displayKey.includes(titleKey) ||
    titleKey.includes(scheduleKey) ||
    containsTokensInOrder(titleKey, displayKey) ||
    containsTokensInOrder(titleKey, scheduleKey)
  );
}

function readJobLogEntries(input: DailyBriefInput, filePath: string, timeZone: string): JobLogEntry[] {
  const text = fs.readFileSync(filePath, "utf8");
  const headingPattern = /^##\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(?:\u2014|--)\s+(.+?)\s*$/gmu;
  const matches = [...text.matchAll(headingPattern)];
  const entries: JobLogEntry[] = [];

  for (const [index, match] of matches.entries()) {
    const next = matches[index + 1];
    const fullHeading = match[0] ?? "";
    const localDate = match[1] ?? "";
    const localTime = match[2] ?? "";
    const rawTitle = match[3] ?? "";
    if (!localDate || !localTime || !rawTitle) {
      continue;
    }
    const title = rawTitle.trim();
    if (!entryMatchesInput(title, input)) {
      continue;
    }

    const bodyStart = (match.index ?? 0) + fullHeading.length;
    const bodyEnd = next?.index ?? text.length;
    const body = text.slice(bodyStart, bodyEnd).trim();
    entries.push({
      input,
      title,
      localDate,
      localTime,
      startedAt: localDateTimeToInstant(localDate, localTime, timeZone),
      body,
      status: extractFieldLine(body, "Status"),
      summary: extractFieldLine(body, "Summary"),
    });
  }

  return entries;
}

function withinLookback(entry: JobLogEntry, now: Date, lookbackHours: number): boolean {
  const since = now.getTime() - lookbackHours * 60 * 60 * 1000;
  return entry.startedAt.getTime() >= since && entry.startedAt.getTime() <= now.getTime();
}

function extractFieldLine(body: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^\\*\\*${escaped}:\\*\\*\\s*(.+)$`, "imu").exec(body);
  if (!match) {
    return undefined;
  }
  return cleanOneLine(match[1] ?? "");
}

function cleanOneLine(value: string): string {
  return value
    .replace(/\s+/gu, " ")
    .replace(/\s+\u2014\s+/gu, " -- ")
    .replace(/^[-*]\s+/u, "")
    .trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function isSectionHeading(line: string): boolean {
  return /^#{2,6}\s+\S/u.test(line) || /^\*\*[^*]+:\*\*\s*$/u.test(line);
}

function isFlaggedHeading(line: string): boolean {
  const trimmed = line.trim();
  const headingLike =
    /^#{2,6}\s+\S/u.test(trimmed) ||
    /^\*\*[^*]+:\*\*\s*$/u.test(trimmed) ||
    /^Flagged\b/iu.test(trimmed);
  if (!headingLike) {
    return false;
  }

  const normalized = line
    .replace(/^#{2,6}\s+/u, "")
    .replace(/^\*\*/u, "")
    .replace(/\*\*:?\s*$/u, "")
    .toLowerCase();
  return (
    (normalized.includes("flagged") && !normalized.includes("flagged for review")) ||
    normalized.includes("act on these")
  );
}

function extractActionLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || /^no flagged items\.?$/iu.test(trimmed)) {
    return undefined;
  }

  const checkbox = /^[-*]\s+\[[ x]\]\s+(.+)$/iu.exec(trimmed);
  const checkboxValue = checkbox?.[1];
  if (checkboxValue) {
    return cleanOneLine(checkboxValue);
  }

  const bullet = /^[-*]\s+(.+)$/u.exec(trimmed);
  const bulletValue = bullet?.[1];
  if (bulletValue) {
    return cleanOneLine(bulletValue);
  }

  const numbered = /^\d+\.\s+(.+)$/u.exec(trimmed);
  const numberedValue = numbered?.[1];
  if (numberedValue) {
    return cleanOneLine(numberedValue);
  }

  const boldNumbered = /^\*\*\d+\.\s+(.+?)\*\*/u.exec(trimmed);
  const boldNumberedValue = boldNumbered?.[1];
  if (boldNumberedValue) {
    return cleanOneLine(boldNumberedValue);
  }

  return undefined;
}

function extractFlaggedItems(entry: JobLogEntry): string[] {
  if (!entry.input.sections.includes("flagged")) {
    return [];
  }

  const lines = entry.body.split(/\r?\n/u);
  const items: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!isFlaggedHeading(lines[index] ?? "")) {
      continue;
    }

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? "";
      if (cursor > index + 1 && isSectionHeading(line)) {
        break;
      }
      const item = extractActionLine(line);
      if (item) {
        items.push(`**${entry.input.displayName}:** ${truncate(item, 220)}`);
      }
    }
  }

  const reviewNeededPrefix = `**${entry.input.displayName}:** Review needed:`;
  const hasSpecificItems = items.some((item) => !item.startsWith(reviewNeededPrefix));
  return hasSpecificItems
    ? items.filter((item) => !item.startsWith(reviewNeededPrefix))
    : items;
}

function isItemsHeading(line: string): boolean {
  return /^\*\*Items:\*\*/iu.test(line.trim()) || /^#{2,6}\s+Items\b/iu.test(line.trim());
}

function extractSlackItems(entry: JobLogEntry): string[] {
  if (!entry.input.sections.includes("items") || normalizeKey(entry.input.domain) !== "slack") {
    return [];
  }

  const lines = entry.body.split(/\r?\n/u);
  const items: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!isItemsHeading(lines[index] ?? "")) {
      continue;
    }

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = (lines[cursor] ?? "").trim();
      if (!line || /^no flagged items\.?$/iu.test(line)) {
        continue;
      }
      if (isSectionHeading(line) || /^---+$/u.test(line)) {
        break;
      }
      const bullet = /^[-*]\s+(?:\[[ x]\]\s+)?(.+)$/iu.exec(line);
      const bulletValue = bullet?.[1];
      if (bulletValue) {
        items.push(`- [ ] ${cleanOneLine(bulletValue)}`);
      }
    }
  }

  return items;
}

function renderOvernightJob(entry: JobLogEntry): string {
  const status = entry.status ? cleanOneLine(entry.status) : "entry found";
  const summary = entry.summary && entry.summary !== "---" ? `: ${truncate(entry.summary, 180)}` : "";
  return `- ${entry.input.displayName} -- ${status}${summary}`;
}

function calendarCommandEnv(timeZone: string): NodeJS.ProcessEnv {
  return createGogCommandEnv({ ...process.env, TZ: timeZone });
}

function defaultFetchCalendarEvents(date: string, timeZone: string): DailyBriefCalendarEvent[] {
  const output = execFileSync(
    "gog",
    [
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
    ],
    {
      encoding: "utf8",
      env: calendarCommandEnv(timeZone),
      stdio: ["ignore", "pipe", "pipe"],
      // Runs in the bot process: a network stall must not freeze it for its duration.
      timeout: 30_000,
      killSignal: "SIGKILL",
    },
  );
  const parsed = JSON.parse(output) as unknown;
  const rawEvents = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { events?: unknown }).events)
      ? (parsed as { events: unknown[] }).events
      : [];

  return rawEvents
    .map((event) => formatCalendarEvent(event, timeZone))
    .filter((event): event is DailyBriefCalendarEvent => event !== null)
    .sort((left, right) => left.sortKey.localeCompare(right.sortKey));
}

function eventField(event: unknown, field: string): unknown {
  return (event as Record<string, unknown>)[field];
}

function nestedString(value: unknown, key: string): string | undefined {
  const nested = value as Record<string, unknown> | undefined;
  const result = nested?.[key];
  return typeof result === "string" ? result : undefined;
}

function formatCalendarEvent(event: unknown, timeZone: string): DailyBriefCalendarEvent | null {
  const title = eventField(event, "summary");
  if (typeof title !== "string" || title.trim().length === 0) {
    return null;
  }

  const start = eventField(event, "start");
  const dateTime = nestedString(start, "dateTime");
  const date = nestedString(start, "date");
  if (dateTime) {
    const instant = new Date(dateTime);
    const timeLabel = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
    })
      .format(instant)
      .replace(/\s+/gu, "")
      .toLowerCase();
    return {
      timeLabel,
      title: cleanOneLine(title),
      sortKey: instant.toISOString(),
    };
  }

  if (date) {
    return {
      timeLabel: "All day",
      title: cleanOneLine(title),
      sortKey: `${date}T00:00:00.000Z`,
    };
  }

  return null;
}

function renderBrief(input: {
  date: string;
  displayDate: string;
  calendarEvents: DailyBriefCalendarEvent[];
  flaggedItems: string[];
  slackItems: string[];
  overnightJobs: string[];
  calendarWarnings: string[];
}): string {
  const lines = [
    "---",
    `date: ${input.date}`,
    "types:",
    "  - \"[[Brief]]\"",
    "areas:",
    "  - \"[[Personal]]\"",
    "type: morning-brief",
    "generated_by: daily-brief-aggregate",
    "---",
    "",
    `# Morning Brief -- ${input.displayDate}`,
    "",
    `**Today:** ${input.calendarEvents.length} calendar events`,
    "",
    `## Flagged (${input.flaggedItems.length})`,
    ...(input.flaggedItems.length > 0 ? input.flaggedItems.map((item) => `- ${item}`) : ["- No flags -- clean night."]),
    "",
  ];

  if (input.slackItems.length > 0) {
    lines.push("## Slack Saved Items", ...input.slackItems, "");
  }

  lines.push(
    "## Overnight Jobs",
    ...(input.overnightJobs.length > 0 ? input.overnightJobs : ["- No recent domain job entries found."]),
    "",
    "## Calendar",
  );

  if (input.calendarWarnings.length > 0) {
    lines.push(...input.calendarWarnings.map((warning) => `- ${warning}`));
  } else if (input.calendarEvents.length > 0) {
    lines.push(...input.calendarEvents.map((event) => `- ${event.timeLabel} -- ${event.title}`));
  } else {
    lines.push("- No calendar events found.");
  }

  lines.push("");
  return lines.join("\n");
}

export function runDailyBriefAggregation(
  options: DailyBriefAggregationOptions = {},
): DailyBriefAggregationResult {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const vaultRoot = options.vaultRoot ?? DEFAULT_VAULT_ROOT;
  const flowDate = getMorningFlowDate(now, timeZone);
  const targetBriefPath = path.join(vaultRoot, "Records", "Briefs", `${flowDate.date}.md`);
  const { lookbackHours, inputs } = readDailyBriefInputs(options.inputRegistryPath);
  const sourceInputs = inputs.filter(
    (input) => !AGGREGATOR_INTERNAL_SCHEDULES.has(input.scheduleId) && input.critical,
  );
  const missingLogPaths: string[] = [];
  const entries: JobLogEntry[] = [];

  ensureDailyNote({ now, timeZone, vaultRoot });
  fs.mkdirSync(path.dirname(targetBriefPath), { recursive: true });

  for (const input of sourceInputs) {
    for (const logPath of logPathsForInput(input, vaultRoot, now, timeZone, lookbackHours)) {
      if (!fs.existsSync(logPath)) {
        missingLogPaths.push(logPath);
        continue;
      }
      entries.push(
        ...readJobLogEntries(input, logPath, timeZone).filter((entry) =>
          withinLookback(entry, now, lookbackHours),
        ),
      );
    }
  }

  entries.sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
  const flaggedItems = entries.flatMap((entry) => extractFlaggedItems(entry));
  const slackItems = entries.flatMap((entry) => extractSlackItems(entry));
  const overnightJobs = entries.map((entry) => renderOvernightJob(entry));
  const calendarWarnings: string[] = [];
  let calendarEvents: DailyBriefCalendarEvent[] = [];

  try {
    calendarEvents = (options.fetchCalendarEvents ?? defaultFetchCalendarEvents)(flowDate.date, timeZone);
  } catch (error) {
    calendarWarnings.push(
      `Calendar read failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const before = fs.existsSync(targetBriefPath) ? fs.readFileSync(targetBriefPath, "utf8") : "";
  const after = renderBrief({
    date: flowDate.date,
    displayDate: flowDate.displayDate,
    calendarEvents,
    flaggedItems,
    slackItems,
    overnightJobs,
    calendarWarnings,
  });
  const wroteBrief = before !== after;
  if (wroteBrief) {
    fs.writeFileSync(targetBriefPath, after, "utf8");
  }

  return {
    date: flowDate.date,
    briefPath: targetBriefPath,
    wroteBrief,
    inputsChecked: sourceInputs.length,
    entriesFound: entries.length,
    flaggedCount: flaggedItems.length,
    slackItemCount: slackItems.length,
    overnightJobCount: overnightJobs.length,
    calendarEventCount: calendarEvents.length,
    missingLogPaths,
    calendarWarnings,
  };
}

export function createDailyBriefAggregationHandler(
  options: DailyBriefAggregationOptions = {},
): DeterministicHandler {
  return async () => {
    const result = runDailyBriefAggregation(options);
    const warning = result.calendarWarnings.length > 0 ? " Calendar needs follow-up." : "";
    return {
      status: "ok",
      summary:
        result.flaggedCount > 0
          ? `Morning brief ready. ${result.flaggedCount} flagged item(s) need attention.${warning}`
          : `Morning brief ready. No flags -- clean night.${warning}`,
      data: { ...result },
    };
  };
}
