import fs from "node:fs";
import path from "node:path";

const DEFAULT_TIME_ZONE = "America/Los_Angeles";
const MAX_AUTO_CAPTURE_CHARS = 180;
const FUTURE_TOLERANCE_MS = 5 * 60_000;

const LEADING_TIME_PATTERN =
  /^(?:(?:at|around|about)\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:[-—:,]\s*|\s+)(.+)$/iu;
const DASH_TIME_PATTERN =
  /^(\d{1,2})(?::(\d{2}))\s*(a\.?m\.?|p\.?m\.?)?\s*[-—]\s*(.+)$/iu;
const TRAILING_TIME_PATTERN =
  /^(.+?)\s+(?:at|around|about)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/iu;

const REQUEST_OR_QUESTION_PATTERN =
  /(?:\?|^(?:can|could|would|will|should|do|does|did|what|why|how|when|where|who)\b|\b(?:please|remind me|can you|could you|would you|should i|do you)\b)/iu;
const META_STATUS_PATTERN =
  /^(?:just kidding\b|sorry\b|i(?:'m| am|m)\s+(?:sorry|not sure|wondering|thinking|trying to|going to|gonna|planning to|hoping to|looking for|asking|curious)\b|i(?:'ll| will| want| need| can| can't| cannot| don't| do not)\b)/iu;
const FIRST_PERSON_STATUS_PATTERN =
  /^(?:i(?:'m| am|m)\s+(.+)|i\s+just\s+(.+)|i\s+started\s+(.+)|i\s+finished\s+(.+)|i\s+switched\s+to\s+(.+)|i\s+moved\s+to\s+(.+))$/iu;
const ACTIVITY_STATUS_PATTERN =
  /^(?:(?:now|currently)\s+)?(?:heading\b.+|walking\b.*|eating\b.+|driving\b.*|working\s+on\b.+|starting\b.+|switching\s+to\b.+|moving\s+to\b.+|back\s+to\b.+|taking\s+(?:a\s+)?break\b.*|leaving\b.+|arriving\b.*|home\b.*|bedtime\b.*|going\s+to\s+bed\b.*)$/iu;

export interface InterstitialStatusCaptureInput {
  message: string;
  messageTimestamp: Date;
  timeZone?: string;
  hasAttachments?: boolean;
}

export interface InterstitialStatusCapture {
  task: string;
  timestamp: Date;
  timestampSource: "message-sent" | "explicit-user-time";
  localDate: string;
  localTime: string;
}

interface ExtractedExplicitTime {
  text: string;
  hour: number;
  minute: number;
  meridiem: "am" | "pm" | null;
}

function isValidDate(date: Date): boolean {
  return Number.isFinite(date.getTime());
}

function normalizeMessage(raw: string): string {
  return raw
    .replace(/[“”]/gu, "\"")
    .replace(/[‘’]/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

function upperFirst(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function cleanTask(value: string): string {
  return upperFirst(
    value
      .replace(/^\s*(?:now|currently)\s+/iu, "")
      .replace(/\s+/gu, " ")
      .trim(),
  );
}

function extractStatusTask(message: string): string | null {
  if (!message || message.length > MAX_AUTO_CAPTURE_CHARS) return null;
  if (message.includes("\n")) return null;
  if (REQUEST_OR_QUESTION_PATTERN.test(message)) return null;
  if (META_STATUS_PATTERN.test(message)) return null;
  if ((message.match(/[.!]/gu)?.length ?? 0) > 1) return null;

  const firstPerson = FIRST_PERSON_STATUS_PATTERN.exec(message);
  if (firstPerson) {
    const task = firstPerson.slice(1).find((candidate) => candidate?.trim());
    return task ? cleanTask(task) : null;
  }

  if (ACTIVITY_STATUS_PATTERN.test(message)) {
    return cleanTask(message);
  }

  return null;
}

function parseMeridiem(raw: string | undefined): "am" | "pm" | null {
  if (!raw) return null;
  return raw.toLowerCase().startsWith("a") ? "am" : "pm";
}

function parseTimeParts(
  hourRaw: string | undefined,
  minuteRaw: string | undefined,
  meridiemRaw: string | undefined,
): Pick<ExtractedExplicitTime, "hour" | "minute" | "meridiem"> | null {
  const hour = Number(hourRaw);
  const minute = minuteRaw == null || minuteRaw === "" ? 0 : Number(minuteRaw);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const meridiem = parseMeridiem(meridiemRaw);
  if (meridiem && (hour < 1 || hour > 12)) return null;
  return { hour, minute, meridiem };
}

function extractExplicitTime(message: string): ExtractedExplicitTime | null {
  const dashMatch = DASH_TIME_PATTERN.exec(message);
  if (dashMatch) {
    const parsed = parseTimeParts(dashMatch[1], dashMatch[2], dashMatch[3]);
    return parsed ? { text: dashMatch[4]!.trim(), ...parsed } : null;
  }

  const leadingMatch = LEADING_TIME_PATTERN.exec(message);
  if (leadingMatch) {
    const parsed = parseTimeParts(leadingMatch[1], leadingMatch[2], leadingMatch[3]);
    return parsed ? { text: leadingMatch[4]!.trim(), ...parsed } : null;
  }

  const trailingMatch = TRAILING_TIME_PATTERN.exec(message);
  if (trailingMatch) {
    const parsed = parseTimeParts(trailingMatch[2], trailingMatch[3], trailingMatch[4]);
    return parsed ? { text: trailingMatch[1]!.trim(), ...parsed } : null;
  }

  return null;
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second"),
  );
  return asUtc - date.getTime();
}

function zonedLocalToUtc(
  local: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): Date {
  const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0, 0);
  let result = new Date(localAsUtc - timeZoneOffsetMs(new Date(localAsUtc), timeZone));
  result = new Date(localAsUtc - timeZoneOffsetMs(result, timeZone));
  return result;
}

function localDateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: value("year"), month: value("month"), day: value("day") };
}

function addDays(local: { year: number; month: number; day: number }, days: number): {
  year: number;
  month: number;
  day: number;
} {
  const utc = new Date(Date.UTC(local.year, local.month - 1, local.day + days, 12, 0, 0));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  };
}

function explicitHourCandidates(hour: number, meridiem: "am" | "pm" | null): number[] {
  if (meridiem === "am") return [hour === 12 ? 0 : hour];
  if (meridiem === "pm") return [hour === 12 ? 12 : hour + 12];
  if (hour === 0 || hour > 12) return [hour];
  return hour === 12 ? [12, 0] : [hour, hour + 12];
}

function resolveExplicitTimestamp(
  explicit: Pick<ExtractedExplicitTime, "hour" | "minute" | "meridiem">,
  messageTimestamp: Date,
  timeZone: string,
): Date | null {
  const baseLocal = localDateParts(messageTimestamp, timeZone);
  const candidates: Date[] = [];
  for (const dayOffset of [-1, 0, 1]) {
    const date = addDays(baseLocal, dayOffset);
    for (const hour of explicitHourCandidates(explicit.hour, explicit.meridiem)) {
      candidates.push(zonedLocalToUtc({ ...date, hour, minute: explicit.minute }, timeZone));
    }
  }

  const closest = candidates.sort(
    (left, right) =>
      Math.abs(left.getTime() - messageTimestamp.getTime())
      - Math.abs(right.getTime() - messageTimestamp.getTime()),
  )[0];
  if (explicit.meridiem) {
    if (!closest || closest.getTime() > messageTimestamp.getTime() + FUTURE_TOLERANCE_MS) {
      return null;
    }
    return closest;
  }

  const notFuture = candidates.filter(
    (candidate) => candidate.getTime() <= messageTimestamp.getTime() + FUTURE_TOLERANCE_MS,
  );
  const pool = notFuture.length > 0 ? notFuture : candidates;
  const closestNotFuture = pool.sort(
    (left, right) =>
      Math.abs(left.getTime() - messageTimestamp.getTime())
      - Math.abs(right.getTime() - messageTimestamp.getTime()),
  )[0];
  if (!closestNotFuture || closestNotFuture.getTime() > messageTimestamp.getTime() + FUTURE_TOLERANCE_MS) {
    return null;
  }
  return closestNotFuture;
}

export function localDateString(now: Date, timeZone = DEFAULT_TIME_ZONE): string {
  const parts = localDateParts(now, timeZone);
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

export function formatLocalTime(date: Date, timeZone = DEFAULT_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function parseInterstitialStatusCapture(
  input: InterstitialStatusCaptureInput,
): InterstitialStatusCapture | null {
  if (input.hasAttachments) return null;
  if (!isValidDate(input.messageTimestamp)) return null;

  const timeZone = input.timeZone?.trim() || DEFAULT_TIME_ZONE;
  const normalized = normalizeMessage(input.message);
  const explicit = extractExplicitTime(normalized);
  const statusText = explicit?.text ?? normalized;
  const task = extractStatusTask(statusText);
  if (!task) return null;

  const timestamp = explicit
    ? resolveExplicitTimestamp(explicit, input.messageTimestamp, timeZone)
    : input.messageTimestamp;
  if (!timestamp) return null;

  return {
    task,
    timestamp,
    timestampSource: explicit ? "explicit-user-time" : "message-sent",
    localDate: localDateString(timestamp, timeZone),
    localTime: formatLocalTime(timestamp, timeZone),
  };
}

export function appendLineToSection(content: string, heading: string, line: string): string {
  const lines = content.split(/\r?\n/u);
  const headingPattern = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "u");
  const start = lines.findIndex((candidate) => headingPattern.test(candidate.trim()));
  if (start < 0) {
    return `${content.replace(/\s*$/u, "")}\n\n## ${heading}\n${line}\n`;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+\S/u.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return [
    ...lines.slice(0, end),
    line,
    ...lines.slice(end),
  ].join("\n");
}

export function appendInterstitialLogEntry(
  vaultRoot: string,
  now: Date,
  timeZone: string,
  task: string,
): { notePath: string; line: string } {
  const date = localDateString(now, timeZone);
  const notePath = path.join(vaultRoot, "Planning", "Daily", `${date}.md`);
  const before = fs.readFileSync(notePath, "utf8");
  const line = `- ${formatLocalTime(now, timeZone)} - ${task}`;
  const after = appendLineToSection(before, "Interstitial Log", line);
  fs.writeFileSync(notePath, after, "utf8");
  return { notePath, line };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
