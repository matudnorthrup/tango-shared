import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { DeterministicHandler } from "@tango/core";

const DEFAULT_TIME_ZONE = "America/Los_Angeles";
const DEFAULT_VAULT_ROOT = path.join(os.homedir(), "Documents", "main");

const DAILY_NOTE_SECTIONS: Array<{ heading: string; body: string }> = [
  {
    heading: "Current Task Rotation",
    body: [
      "<!-- Multi-day work. All items carry forward. A checkmark means 'nudged this pass', not done - items only leave when I say so. Blocked items: prefix 🚧 and append ' - blocked: why', sorted to the bottom. -->",
      "- [ ]",
    ].join("\n"),
  },
  { heading: "Today's Priorities", body: "- [ ]" },
  {
    heading: "Other Work",
    body: [
      "<!-- Spare-capacity tasks, unscheduled work done today, and rotation items the user has explicitly said are finished. -->",
      "- [ ]",
    ].join("\n"),
  },
  { heading: "Notes", body: "-" },
  {
    heading: "Interstitial Log",
    body: [
      "<!-- Source of truth for the orientation nudge. One entry per real task transition. Working the rotation is one entry: 'Task rotation'; switching between rotation items is not a transition. Format: HH:MM - what I'm moving into -->",
      "-",
    ].join("\n"),
  },
];

const DEFAULT_CRITICAL_MORNING_SCHEDULES = [
  "nightly-transaction-categorizer",
  "receipt-cataloger",
  "daily-email-review",
  "nightly-email-unsubscribe-review",
  "slack-saved-review",
  "vault-daily-check",
  "daily-brief",
  "morning-planning",
] as const;

const DEFAULT_DAILY_TEMPLATE = [
  "---",
  "date: {{date:YYYY-MM-DD}}",
  "types:",
  "  - \"[[Daily Note]]\"",
  "areas:",
  "  - \"[[Personal]]\"",
  "week: \"[[{{date:YYYY [Week] w [Plan]}}]]\"",
  "quarterly: \"[[{{date:YYYY [Q]Q [Plan]}}]]\"",
  "brief: \"[[Records/Briefs/{{date:YYYY-MM-DD}}]]\"",
  "morning_review_completed: false",
  "evening_review_completed: false",
  "backlogs:",
  "  - \"[[Personal Backlog]]\"",
  "  - \"[[Acme Backlog]]\"",
  "  - \"[[Tango Backlog]]\"",
  "  - \"[[Family Backlog]]\"",
  "  - \"[[Sideproject Backlog]]\"",
  "  - \"[[Community Backlog]]\"",
  "---",
  "",
  "## Current Task Rotation",
  "<!-- Multi-day work. All items carry forward. A checkmark means 'nudged this pass', not done - items only leave when I say so. Blocked items: prefix 🚧 and append ' - blocked: why', sorted to the bottom. -->",
  "- [ ]",
  "",
  "## Today's Priorities",
  "- [ ]",
  "",
  "## Other Work",
  "<!-- Spare-capacity tasks, unscheduled work done today, and rotation items the user has explicitly said are finished. -->",
  "- [ ]",
  "",
  "## Notes",
  "-",
  "",
  "## Interstitial Log",
  "<!-- Source of truth for the orientation nudge. One entry per real task transition. Working the rotation is one entry: 'Task rotation'; switching between rotation items is not a transition. Format: HH:MM - what I'm moving into -->",
  "-",
  "",
].join("\n");

export interface MorningFlowDate {
  date: string;
  month: string;
  displayDate: string;
  weekPlan: string;
  quarterPlan: string;
}

export interface DailyNoteBootstrapResult {
  date: string;
  notePath: string;
  briefPath: string;
  createdNote: boolean;
  updatedNote: boolean;
  addedFrontmatterFields: string[];
  addedSections: string[];
  /** Rotation items carried forward from the prior daily note, checked or not. */
  carriedRotation: string[];
}

export interface MorningFlowSentinelResult {
  date: string;
  note: DailyNoteBootstrapResult;
  briefPath: string;
  createdFallbackBrief: boolean;
  updatedBrief: boolean;
  addedBriefFrontmatterFields: string[];
  updatedBriefWarnings: boolean;
  issues: string[];
}

interface ScheduleRunRow {
  schedule_id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  error: string | null;
  summary: string | null;
}

interface MorningFlowOptions {
  now?: Date;
  timeZone?: string;
  vaultRoot?: string;
  inputRegistryPath?: string;
}

interface MorningFlowHandlerOptions extends MorningFlowOptions {
  db?: DatabaseSync;
}

interface BriefRepairResult {
  updatedBrief: boolean;
  addedFrontmatterFields: string[];
  updatedWarnings: boolean;
}

interface DailyBriefInputRegistry {
  lookbackHours?: unknown;
  inputs?: Array<{
    scheduleId?: unknown;
    critical?: unknown;
  }>;
}

interface MorningInputConfig {
  scheduleIds: string[];
  lookbackHours: number;
}

function getLocalParts(now: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  weekday: string;
  monthName: string;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const month = Number.parseInt(value("month"), 10);
  const day = Number.parseInt(value("day"), 10);
  const year = Number.parseInt(value("year"), 10);
  const monthName = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
  }).format(now);

  return {
    year,
    month,
    day,
    weekday: value("weekday"),
    monthName,
  };
}

function isoWeek(year: number, month: number, day: number): number {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

export function getMorningFlowDate(
  now = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
): MorningFlowDate {
  const local = getLocalParts(now, timeZone);
  const yyyy = String(local.year);
  const mm = String(local.month).padStart(2, "0");
  const dd = String(local.day).padStart(2, "0");
  const quarter = Math.floor((local.month - 1) / 3) + 1;

  return {
    date: `${yyyy}-${mm}-${dd}`,
    month: `${yyyy}-${mm}`,
    displayDate: `${local.weekday} ${local.monthName} ${local.day}`,
    weekPlan: `${yyyy} Week ${isoWeek(local.year, local.month, local.day)} Plan`,
    quarterPlan: `${yyyy} Q${quarter} Plan`,
  };
}

function vaultPath(vaultRoot: string, ...segments: string[]): string {
  return path.join(vaultRoot, ...segments);
}

function dailyNotePath(vaultRoot: string, date: string): string {
  return vaultPath(vaultRoot, "Planning", "Daily", `${date}.md`);
}

function briefPath(vaultRoot: string, date: string): string {
  return vaultPath(vaultRoot, "Records", "Briefs", `${date}.md`);
}

function defaultInputRegistryPath(): string {
  return path.resolve(process.cwd(), "config", "defaults", "daily-brief-inputs.json");
}

function readMorningInputConfig(inputRegistryPath?: string): MorningInputConfig {
  const registryPath = inputRegistryPath ?? defaultInputRegistryPath();
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8")) as DailyBriefInputRegistry;
    const scheduleIds = (parsed.inputs ?? [])
      .filter((input) => input.critical !== false)
      .map((input) => input.scheduleId)
      .filter((scheduleId): scheduleId is string => typeof scheduleId === "string" && scheduleId.length > 0);
    const lookbackHours =
      typeof parsed.lookbackHours === "number" && parsed.lookbackHours > 0
        ? parsed.lookbackHours
        : 24;

    return {
      scheduleIds: scheduleIds.length > 0 ? scheduleIds : [...DEFAULT_CRITICAL_MORNING_SCHEDULES],
      lookbackHours,
    };
  } catch {
    return {
      scheduleIds: [...DEFAULT_CRITICAL_MORNING_SCHEDULES],
      lookbackHours: 24,
    };
  }
}

function renderTemplate(template: string, flowDate: MorningFlowDate): string {
  return template
    .replace(/\{\{date:YYYY-MM-DD\}\}/gu, flowDate.date)
    .replace(/\{\{date:YYYY \[Week\] w \[Plan\]\}\}/gu, flowDate.weekPlan)
    .replace(/\{\{date:YYYY \[Q\]Q \[Plan\]\}\}/gu, flowDate.quarterPlan);
}

function readDailyTemplate(vaultRoot: string): string {
  const templatePath = vaultPath(vaultRoot, "_Schema", "Templates", "Daily Notes Template.md");
  try {
    return fs.readFileSync(templatePath, "utf8");
  } catch {
    return DEFAULT_DAILY_TEMPLATE;
  }
}

function upsertFrontmatterField(
  text: string,
  key: string,
  value: string,
): { text: string; changed: boolean } {
  const fieldPattern = new RegExp(`^${key}:\\s*`, "mu");

  if (text.startsWith("---\n")) {
    const endIndex = text.indexOf("\n---", 4);
    if (endIndex !== -1) {
      const frontmatter = text.slice(4, endIndex);
      if (fieldPattern.test(frontmatter)) {
        return { text, changed: false };
      }

      const prefix = text.slice(0, endIndex);
      const separator = prefix.endsWith("\n") ? "" : "\n";
      return {
        text: `${prefix}${separator}${key}: ${value}\n${text.slice(endIndex)}`,
        changed: true,
      };
    }
  }

  if (fieldPattern.test(text)) {
    return { text, changed: false };
  }

  return {
    text: `---\n${key}: ${value}\n---\n\n${text}`,
    changed: true,
  };
}

function upsertFrontmatterBlock(
  text: string,
  key: string,
  block: string,
): { text: string; changed: boolean } {
  const fieldPattern = new RegExp(`^${key}:\\s*`, "mu");

  if (text.startsWith("---\n")) {
    const endIndex = text.indexOf("\n---", 4);
    if (endIndex !== -1) {
      const frontmatter = text.slice(4, endIndex);
      if (fieldPattern.test(frontmatter)) {
        return { text, changed: false };
      }

      const prefix = text.slice(0, endIndex);
      const separator = prefix.endsWith("\n") ? "" : "\n";
      return {
        text: `${prefix}${separator}${block}\n${text.slice(endIndex)}`,
        changed: true,
      };
    }
  }

  if (fieldPattern.test(text)) {
    return { text, changed: false };
  }

  return {
    text: `---\n${block}\n---\n\n${text}`,
    changed: true,
  };
}

function ensureSection(
  text: string,
  heading: string,
  body: string,
): { text: string; changed: boolean } {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const sectionPattern = new RegExp(`^## ${escapedHeading}\\s*$`, "mu");
  if (sectionPattern.test(text)) {
    return { text, changed: false };
  }

  const separator = text.endsWith("\n") ? "\n" : "\n\n";
  return {
    text: `${text}${separator}## ${heading}\n${body}\n`,
    changed: true,
  };
}

const ROTATION_HEADING = "Current Task Rotation";

/** Blocked rotation items are marked with a leading 🚧 and sort to the bottom. */
function isBlockedRotationItem(text: string): boolean {
  return text.trimStart().startsWith("🚧");
}

function sectionBody(text: string, heading: string): string | null {
  const lines = text.split(/\r?\n/u);
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const headingPattern = new RegExp(`^##\\s+${escaped}\\s*$`, "u");
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

function replaceSectionBody(text: string, heading: string, body: string): string {
  const lines = text.split(/\r?\n/u);
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const headingPattern = new RegExp(`^##\\s+${escaped}\\s*$`, "u");
  const start = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (start < 0) return text;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+\S/u.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  const trailing = end < lines.length ? [""] : [];
  return [...lines.slice(0, start + 1), ...body.split("\n"), ...trailing, ...lines.slice(end)].join("\n");
}

/**
 * Top-level rotation items from the most recent prior daily note, checkbox
 * state preserved. The rotation is multi-day work, so it carries forward
 * instead of resetting each morning. Looks back up to `lookbackDays` to
 * survive skipped days.
 *
 * Checked items carry forward too: the checkbox means "nudged this pass", not
 * "finished". The user may check their way down the list, then uncheck the whole thing
 * and start another pass. Dropping checked items would eat live work.
 */
export function carriedRotationItems(
  vaultRoot: string,
  date: string,
  lookbackDays = 7,
): Array<{ text: string; checked: boolean }> {
  const base = new Date(`${date}T00:00:00Z`);
  for (let back = 1; back <= lookbackDays; back += 1) {
    const prior = new Date(base.getTime() - back * 86400000).toISOString().slice(0, 10);
    let content: string;
    try {
      content = fs.readFileSync(dailyNotePath(vaultRoot, prior), "utf8");
    } catch {
      continue;
    }
    const body = sectionBody(content, ROTATION_HEADING);
    if (body === null) continue;
    const items = body
      .split(/\r?\n/u)
      .map((line) => /^-\s+\[( |x|X)\]\s+(.+?)\s*$/u.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({
        text: (match[2] ?? "").trim(),
        checked: (match[1] ?? " ").toLowerCase() === "x",
      }))
      .filter((item) => item.text.length > 0 && item.text !== "-");
    // Blocked items (leading 🚧) sink to the bottom, relative order preserved,
    // so the live work stays at the top of the list.
    return [
      ...items.filter((item) => !isBlockedRotationItem(item.text)),
      ...items.filter((item) => isBlockedRotationItem(item.text)),
    ];
  }
  return [];
}

function hasFrontmatterField(text: string, key: string): boolean {
  if (!text.startsWith("---\n")) return false;
  const endIndex = text.indexOf("\n---", 4);
  if (endIndex === -1) return false;
  return new RegExp(`^${key}:\\s*`, "mu").test(text.slice(4, endIndex));
}

/**
 * Real rotation checkboxes in the note. The template's empty `- [ ]` placeholder
 * does not count, so a freshly repaired section still reads as empty.
 */
function rotationItemCount(text: string): number {
  const body = sectionBody(text, ROTATION_HEADING);
  if (body === null) return 0;
  return body.split(/\r?\n/u).filter((line) => /^-\s+\[( |x|X)\]\s+\S/u.test(line)).length;
}

function writeFileIfChanged(filePath: string, before: string, after: string): boolean {
  if (before === after) {
    return false;
  }
  fs.writeFileSync(filePath, after, "utf8");
  return true;
}

export function ensureDailyNote(options: MorningFlowOptions = {}): DailyNoteBootstrapResult {
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const vaultRoot = options.vaultRoot ?? DEFAULT_VAULT_ROOT;
  const flowDate = getMorningFlowDate(options.now ?? new Date(), timeZone);
  const notePath = dailyNotePath(vaultRoot, flowDate.date);
  const targetBriefPath = briefPath(vaultRoot, flowDate.date);
  const addedFrontmatterFields: string[] = [];
  const addedSections: string[] = [];
  let carriedRotation: string[] = [];

  fs.mkdirSync(path.dirname(notePath), { recursive: true });
  fs.mkdirSync(path.dirname(targetBriefPath), { recursive: true });

  let createdNote = false;
  let before = "";
  let text = "";

  if (fs.existsSync(notePath)) {
    before = fs.readFileSync(notePath, "utf8");
    text = before;
  } else {
    text = renderTemplate(readDailyTemplate(vaultRoot), flowDate);
    before = "";
    createdNote = true;
  }

  const frontmatterFields: Array<[string, string]> = [
    ["date", flowDate.date],
    ["brief", `"[[Records/Briefs/${flowDate.date}]]"`],
  ];
  for (const [key, value] of frontmatterFields) {
    const result = upsertFrontmatterField(text, key, value);
    if (result.changed) {
      addedFrontmatterFields.push(key);
      text = result.text;
    }
  }

  for (const section of DAILY_NOTE_SECTIONS) {
    const result = ensureSection(text, section.heading, section.body);
    if (result.changed) {
      addedSections.push(section.heading);
      text = result.text;
    }
  }

  // Carry the rotation forward on the note's first morning-flow pass, not on
  // note creation. Notes are often created days early (adding a future task),
  // and gating on creation silently skipped the carry-forward for those days.
  // The `rotation_carried` frontmatter stamp makes this once-per-note, so a
  // rotation the user deliberately empties later in the day stays empty.
  if (!hasFrontmatterField(text, "rotation_carried") && rotationItemCount(text) === 0) {
    const carried = carriedRotationItems(vaultRoot, flowDate.date);
    const stamp = upsertFrontmatterField(text, "rotation_carried", flowDate.date);
    if (stamp.changed) {
      addedFrontmatterFields.push("rotation_carried");
      text = stamp.text;
    }
    if (carried.length > 0) {
      text = replaceSectionBody(
        text,
        ROTATION_HEADING,
        [
          "<!-- Multi-day work. All items carry forward. A checkmark means 'nudged this pass', not done - items only leave when I say so. Blocked items: prefix 🚧 and append ' - blocked: why', sorted to the bottom. -->",
          ...carried.map((item) => `- [${item.checked ? "x" : " "}] ${item.text}`),
          "- [ ]",
        ].join("\n"),
      );
      carriedRotation = carried.map((item) => item.text);
    }
  }

  if (!text.endsWith("\n")) {
    text += "\n";
  }

  const updatedNote = createdNote
    ? (fs.writeFileSync(notePath, text, "utf8"), true)
    : writeFileIfChanged(notePath, before, text);

  return {
    date: flowDate.date,
    notePath,
    briefPath: targetBriefPath,
    createdNote,
    updatedNote,
    addedFrontmatterFields,
    addedSections,
    carriedRotation,
  };
}

function rowValue(row: unknown, key: keyof ScheduleRunRow): string | null {
  const value = (row as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function listRecentScheduleRuns(
  db: DatabaseSync | undefined,
  scheduleIds: string[],
  now: Date,
  lookbackHours: number,
): ScheduleRunRow[] {
  if (!db) {
    return [];
  }

  const since = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000).toISOString();
  const placeholders = scheduleIds.map(() => "?").join(",");
  try {
    const rows = db
      .prepare(
        [
          "SELECT schedule_id, started_at, finished_at, status, error, summary",
          "FROM schedule_runs",
          `WHERE started_at >= ? AND schedule_id IN (${placeholders})`,
          "ORDER BY started_at ASC",
        ].join(" "),
      )
      .all(since, ...scheduleIds);

    return rows.map((row) => ({
      schedule_id: rowValue(row, "schedule_id") ?? "",
      started_at: rowValue(row, "started_at") ?? "",
      finished_at: rowValue(row, "finished_at"),
      status: rowValue(row, "status") ?? "",
      error: rowValue(row, "error"),
      summary: rowValue(row, "summary"),
    }));
  } catch {
    return [];
  }
}

function latestRowsBySchedule(rows: ScheduleRunRow[]): Map<string, ScheduleRunRow> {
  const latest = new Map<string, ScheduleRunRow>();
  for (const row of rows) {
    if (row.schedule_id) {
      latest.set(row.schedule_id, row);
    }
  }
  return latest;
}

function collectScheduleIssues(rows: ScheduleRunRow[], scheduleIds: string[]): string[] {
  const latest = latestRowsBySchedule(rows);
  const issues: string[] = [];

  for (const scheduleId of scheduleIds) {
    const row = latest.get(scheduleId);
    if (!row) {
      issues.push(`${scheduleId} has no run in the last 24 hours.`);
      continue;
    }
    if (row.status === "error") {
      issues.push(`${scheduleId} failed at ${row.started_at}: ${row.error ?? "unknown error"}`);
    }
  }

  return issues;
}

function markdownSectionBody(
  text: string,
  headingMatches: (trimmedLine: string) => boolean,
): string | null {
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((line) => headingMatches(line.trim()));
  if (start === -1) {
    return null;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+\S/u.test(lines[i]?.trim() ?? "")) {
      end = i;
      break;
    }
  }

  return lines.slice(start + 1, end).join("\n");
}

function sectionHasFilledTask(body: string | null): boolean {
  if (!body) {
    return false;
  }

  return body.split(/\r?\n/u).some((line) => {
    const match = line.trim().match(/^-\s+\[[ xX]\]\s*(.+)$/u);
    return Boolean(match?.[1]?.trim());
  });
}

function generatedPlanningSectionsAreBlank(noteText: string): boolean {
  const priorities = markdownSectionBody(noteText, (line) => line === "## Today's Priorities");
  const otherWork = markdownSectionBody(noteText, (line) => line === "## Other Work");

  return !sectionHasFilledTask(priorities) && !sectionHasFilledTask(otherWork);
}

function briefHasFlaggedItems(briefText: string): boolean {
  const flaggedHeader = briefText.match(/^## Flagged(?:\s*\((\d+)\))?/mu);
  if (flaggedHeader?.[1]) {
    return Number.parseInt(flaggedHeader[1], 10) > 0;
  }

  const flaggedBody = markdownSectionBody(briefText, (line) => line.startsWith("## Flagged"));
  return Boolean(flaggedBody?.split(/\r?\n/u).some((line) => /^-\s+\S/u.test(line.trim())));
}

function collectMorningPlanningArtifactIssues(input: {
  rows: ScheduleRunRow[];
  flowDate: MorningFlowDate;
  notePath: string;
  briefPath: string;
}): string[] {
  const issues: string[] = [];
  const planningRun = latestRowsBySchedule(input.rows).get("morning-planning");
  const planningDateMatch = planningRun?.summary?.match(/Morning Planning Complete\s*[—-]\s*([^*\n]+)/u);
  const reportedDate = planningDateMatch?.[1]?.trim();

  if (planningRun?.status === "ok" && reportedDate && reportedDate !== input.flowDate.displayDate) {
    issues.push(
      `morning-planning reported ${reportedDate} instead of ${input.flowDate.displayDate}.`,
    );
  }

  if (!fs.existsSync(input.notePath) || !fs.existsSync(input.briefPath)) {
    return issues;
  }

  const noteText = fs.readFileSync(input.notePath, "utf8");
  const briefText = fs.readFileSync(input.briefPath, "utf8");
  if (briefHasFlaggedItems(briefText) && generatedPlanningSectionsAreBlank(noteText)) {
    issues.push(
      `morning-planning left generated daily-note planning sections blank for ${input.flowDate.date}.`,
    );
  }

  return issues;
}

function renderScheduleLines(rows: ScheduleRunRow[], scheduleIds: string[]): string[] {
  const latest = latestRowsBySchedule(rows);
  return scheduleIds.map((scheduleId) => {
    const row = latest.get(scheduleId);
    if (!row) {
      return `- ${scheduleId} -- no run found in the last 24 hours`;
    }
    const detail = row.error ?? row.summary ?? "";
    return `- ${scheduleId} -- ${row.status} at ${row.started_at}${detail ? ` -- ${detail}` : ""}`;
  });
}

function writeFallbackBrief(input: {
  briefPath: string;
  flowDate: MorningFlowDate;
  issues: string[];
  rows: ScheduleRunRow[];
  scheduleIds: string[];
}): void {
  fs.mkdirSync(path.dirname(input.briefPath), { recursive: true });
  const issueLines =
    input.issues.length > 0
      ? input.issues.map((issue) => `- ${issue}`)
      : ["- Morning flow sentinel created this fallback brief; no scheduler issues were available."];

  const text = [
    "---",
    `date: ${input.flowDate.date}`,
    "types:",
    "  - \"[[Brief]]\"",
    "areas:",
    "  - \"[[Personal]]\"",
    "type: morning-brief",
    "generated_by: morning-flow-sentinel",
    "---",
    "",
    `# Morning Brief -- ${input.flowDate.displayDate}`,
    "",
    "**Status:** Fallback brief generated because the normal morning brief artifact was missing.",
    "",
    `## Flagged (${issueLines.length})`,
    ...issueLines,
    "",
    "## Overnight Jobs",
    ...renderScheduleLines(input.rows, input.scheduleIds),
    "",
    "## Calendar",
    "- Calendar was not fetched by the deterministic fallback. Check the calendar tool or rerun daily-brief after the agent runtime is healthy.",
    "",
  ].join("\n");

  fs.writeFileSync(input.briefPath, text, "utf8");
}

function renderPipelineWarnings(issues: string[]): string {
  const lines =
    issues.length > 0
      ? issues.map((issue) => `- ${issue}`)
      : ["- No morning pipeline issues found."];

  return [
    "## Pipeline Warnings",
    "<!-- morning-flow-sentinel:start -->",
    "These warnings are maintained by the morning-flow sentinel.",
    ...lines,
    "<!-- morning-flow-sentinel:end -->",
    "",
  ].join("\n");
}

function upsertPipelineWarnings(
  text: string,
  issues: string[],
): { text: string; changed: boolean } {
  const block = renderPipelineWarnings(issues);
  const sectionPattern =
    /^## Pipeline Warnings\n<!-- morning-flow-sentinel:start -->[\s\S]*?<!-- morning-flow-sentinel:end -->\n*/mu;
  if (sectionPattern.test(text)) {
    const next = text.replace(sectionPattern, block);
    return { text: next, changed: next !== text };
  }

  const h1Match = /^# .+$/mu.exec(text);
  if (h1Match?.index !== undefined) {
    const insertAt = h1Match.index + h1Match[0].length;
    const before = text.slice(0, insertAt);
    const after = text.slice(insertAt).replace(/^\n*/u, "\n\n");
    return {
      text: `${before}\n\n${block}${after}`,
      changed: true,
    };
  }

  if (text.startsWith("---\n")) {
    const endIndex = text.indexOf("\n---", 4);
    if (endIndex !== -1) {
      const insertAt = endIndex + "\n---".length;
      const before = text.slice(0, insertAt);
      const after = text.slice(insertAt).replace(/^\n*/u, "\n\n");
      return {
        text: `${before}\n\n${block}${after}`,
        changed: true,
      };
    }
  }

  return {
    text: `${block}\n${text}`,
    changed: true,
  };
}

function ensureBriefSchemaAndWarnings(input: {
  briefPath: string;
  flowDate: MorningFlowDate;
  issues: string[];
}): BriefRepairResult {
  const before = fs.readFileSync(input.briefPath, "utf8");
  let text = before;
  const addedFrontmatterFields: string[] = [];

  const frontmatterBlocks: Array<[string, string]> = [
    ["date", `date: ${input.flowDate.date}`],
    ["types", "types:\n  - \"[[Brief]]\""],
    ["areas", "areas:\n  - \"[[Personal]]\""],
  ];

  for (const [key, block] of frontmatterBlocks) {
    const result = upsertFrontmatterBlock(text, key, block);
    if (result.changed) {
      addedFrontmatterFields.push(key);
      text = result.text;
    }
  }

  let updatedWarnings = false;
  if (input.issues.length > 0) {
    const result = upsertPipelineWarnings(text, input.issues);
    updatedWarnings = result.changed;
    text = result.text;
  }

  if (!text.endsWith("\n")) {
    text += "\n";
  }

  return {
    updatedBrief: writeFileIfChanged(input.briefPath, before, text),
    addedFrontmatterFields,
    updatedWarnings,
  };
}

export function runMorningFlowSentinel(
  options: MorningFlowHandlerOptions = {},
): MorningFlowSentinelResult {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const vaultRoot = options.vaultRoot ?? DEFAULT_VAULT_ROOT;
  const flowDate = getMorningFlowDate(now, timeZone);
  const note = ensureDailyNote({ now, timeZone, vaultRoot });
  const targetBriefPath = briefPath(vaultRoot, flowDate.date);
  const inputConfig = readMorningInputConfig(options.inputRegistryPath);
  const rows = listRecentScheduleRuns(
    options.db,
    inputConfig.scheduleIds,
    now,
    inputConfig.lookbackHours,
  );
  const scheduleIds = inputConfig.scheduleIds;
  const issues = collectScheduleIssues(rows, scheduleIds);
  let createdFallbackBrief = false;
  let updatedBrief = false;
  let addedBriefFrontmatterFields: string[] = [];
  let updatedBriefWarnings = false;

  if (!fs.existsSync(targetBriefPath)) {
    issues.unshift(`Morning brief file is missing: ${targetBriefPath}`);
  }

  if (note.createdNote) {
    issues.unshift(`Daily note was missing and has been created: ${note.notePath}`);
  } else if (note.updatedNote) {
    const repairs = [
      ...note.addedFrontmatterFields.map((field) => `frontmatter '${field}'`),
      ...note.addedSections.map((section) => `section '${section}'`),
    ].join(", ");
    issues.unshift(`Daily note was repaired${repairs ? ` (${repairs})` : ""}: ${note.notePath}`);
  }

  issues.push(
    ...collectMorningPlanningArtifactIssues({
      rows,
      flowDate,
      notePath: note.notePath,
      briefPath: targetBriefPath,
    }),
  );

  if (!fs.existsSync(targetBriefPath)) {
    writeFallbackBrief({
      briefPath: targetBriefPath,
      flowDate,
      issues,
      rows,
      scheduleIds,
    });
    createdFallbackBrief = true;
  } else {
    const repair = ensureBriefSchemaAndWarnings({
      briefPath: targetBriefPath,
      flowDate,
      issues,
    });
    updatedBrief = repair.updatedBrief;
    addedBriefFrontmatterFields = repair.addedFrontmatterFields;
    updatedBriefWarnings = repair.updatedWarnings;
  }

  return {
    date: flowDate.date,
    note,
    briefPath: targetBriefPath,
    createdFallbackBrief,
    updatedBrief,
    addedBriefFrontmatterFields,
    updatedBriefWarnings,
    issues,
  };
}

function summarizeBootstrap(result: DailyNoteBootstrapResult): string {
  const changes: string[] = [];
  if (result.createdNote) {
    changes.push("created daily note");
  }
  if (result.addedFrontmatterFields.length > 0) {
    changes.push(`added frontmatter: ${result.addedFrontmatterFields.join(", ")}`);
  }
  if (result.addedSections.length > 0) {
    changes.push(`added sections: ${result.addedSections.join(", ")}`);
  }

  return changes.length > 0
    ? `Daily note bootstrap repaired ${result.date}: ${changes.join("; ")}.`
    : `Daily note bootstrap verified ${result.date}.`;
}

export function createDailyNoteBootstrapHandler(
  options: MorningFlowOptions = {},
): DeterministicHandler {
  return async () => {
    const result = ensureDailyNote(options);
    return {
      status: "ok",
      summary: summarizeBootstrap(result),
      data: { ...result },
    };
  };
}

export function createMorningFlowSentinelHandler(
  options: MorningFlowOptions = {},
): DeterministicHandler {
  return async (ctx) => {
    const result = runMorningFlowSentinel({
      ...options,
      db: ctx.db,
    });

    if (result.issues.length === 0 && !result.updatedBrief) {
      return {
        status: "skipped",
        summary: `Morning flow healthy for ${result.date}`,
        data: { ...result },
      };
    }

    return {
      status: "ok",
      summary: [
        result.issues.length > 0
          ? `Morning flow sentinel found ${result.issues.length} issue(s) for ${result.date}.`
          : `Morning flow sentinel repaired brief metadata for ${result.date}.`,
        result.createdFallbackBrief ? `Fallback brief created at ${result.briefPath}.` : undefined,
        result.updatedBrief
          ? [
              `Morning brief repaired at ${result.briefPath}.`,
              result.addedBriefFrontmatterFields.length > 0
                ? `Added frontmatter: ${result.addedBriefFrontmatterFields.join(", ")}.`
                : undefined,
              result.updatedBriefWarnings ? "Updated pipeline warnings." : undefined,
            ].filter(Boolean).join(" ")
          : undefined,
        ...result.issues.slice(0, 6).map((issue) => `- ${issue}`),
      ].filter(Boolean).join("\n"),
      data: { ...result },
    };
  };
}
