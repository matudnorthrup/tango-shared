export const DEFAULT_CURRENT_TURN_TIME_ZONE = "America/Los_Angeles";
export const DEFAULT_CURRENT_TURN_LOCALE = "en-US";

const MAX_METADATA_VALUE_CHARS = 160;

export type CurrentTurnTimeFormat = "12h" | "24h";
export type CurrentTurnTimeZoneEnv = Partial<Record<"TANGO_TIME_ZONE" | "TZ", string | undefined>>;

export interface CurrentTurnMetadataConfig {
  timeZone?: string;
  locale?: string;
  timeFormat?: CurrentTurnTimeFormat;
}

export interface CurrentTurnDiscordContext {
  channelId?: string | null;
  threadId?: string | null;
}

export interface CurrentTurnContextUsage {
  fraction: number;
  totalTokens?: number;
  contextWindow?: number;
}

export interface CurrentTurnMetadataInput {
  timestamp?: string | number | Date | null;
  timestampSource?: string | null;
  config?: CurrentTurnMetadataConfig;
  now?: Date;
  env?: CurrentTurnTimeZoneEnv;
  discord?: CurrentTurnDiscordContext;
  /** Context window occupancy as of the previous completed turn in this conversation. */
  contextUsage?: CurrentTurnContextUsage;
}

function sanitizeMetadataValue(value: string): string {
  return value
    .replace(/[\r\n]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_METADATA_VALUE_CHARS);
}

function isValidDate(date: Date): boolean {
  return Number.isFinite(date.getTime());
}

function coerceDate(value: string | number | Date | null | undefined): Date | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return isValidDate(date) ? date : undefined;
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat(DEFAULT_CURRENT_TURN_LOCALE, { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function isValidLocale(locale: string): boolean {
  try {
    Intl.getCanonicalLocales(locale);
    return true;
  } catch {
    return false;
  }
}

export function resolveCurrentTurnTimeZone(
  preferredTimeZone?: string,
  env: CurrentTurnTimeZoneEnv = process.env,
): string {
  for (const candidate of [
    preferredTimeZone,
    env.TANGO_TIME_ZONE,
    env.TZ,
    DEFAULT_CURRENT_TURN_TIME_ZONE,
  ]) {
    const normalized = candidate?.trim();
    if (normalized && isValidTimeZone(normalized)) {
      return normalized;
    }
  }

  return DEFAULT_CURRENT_TURN_TIME_ZONE;
}

export function resolveCurrentTurnLocale(preferredLocale?: string): string {
  const normalized = preferredLocale?.trim();
  if (normalized && isValidLocale(normalized)) {
    return normalized;
  }

  return DEFAULT_CURRENT_TURN_LOCALE;
}

export function buildCurrentTurnMetadataPrompt(
  input: CurrentTurnMetadataInput = {},
): string {
  const timestampDate =
    coerceDate(input.timestamp)
    ?? coerceDate(input.now)
    ?? new Date();
  const timestampWasProvided = coerceDate(input.timestamp) !== undefined;
  const timestampSource = timestampWasProvided
    ? sanitizeMetadataValue(input.timestampSource?.trim() || "unknown")
    : "runtime-generated";
  const timeZone = resolveCurrentTurnTimeZone(input.config?.timeZone, input.env);
  const locale = resolveCurrentTurnLocale(input.config?.locale);
  const hour12 = input.config?.timeFormat === "24h" ? false : true;

  const calendarDay = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    timeZone,
  }).format(timestampDate);
  const localDate = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone,
  }).format(timestampDate);
  const localTime = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone,
    hour12,
  }).format(timestampDate);

  const lines = [
    "Current user message metadata:",
    `- calendar_day: ${sanitizeMetadataValue(calendarDay)}`,
    `- local_date: ${sanitizeMetadataValue(localDate)}`,
    `- local_time: ${sanitizeMetadataValue(localTime)}`,
    `- timezone: ${timeZone}`,
    `- timestamp_utc: ${timestampDate.toISOString()}`,
    `- timestamp_source: ${timestampSource}`,
  ];

  const channelId = input.discord?.channelId?.trim();
  if (channelId) {
    lines.push(`- discord_channel_id: ${sanitizeMetadataValue(channelId)}`);
  }
  const threadId = input.discord?.threadId?.trim();
  if (threadId) {
    lines.push(`- discord_thread_id: ${sanitizeMetadataValue(threadId)}`);
  }

  const contextFraction = input.contextUsage?.fraction;
  if (typeof contextFraction === "number" && Number.isFinite(contextFraction)) {
    const percent = Math.round(Math.max(0, Math.min(1, contextFraction)) * 100);
    lines.push(`- context_window_used_percent: ${percent}`);
    const totalTokens = input.contextUsage?.totalTokens;
    const contextWindow = input.contextUsage?.contextWindow;
    if (
      typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0
      && typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
    ) {
      lines.push(`- context_window_tokens: ${totalTokens} / ${contextWindow}`);
    }
  }

  return lines.join("\n");
}
