import type { RefreshSchedule } from './types.js';

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function localTime(date: Date, timeZone: string): { hour: number; minute: number } {
  const parts = getFormatter(timeZone).formatToParts(date);
  return {
    hour: Number(parts.find((part) => part.type === 'hour')?.value ?? -1),
    minute: Number(parts.find((part) => part.type === 'minute')?.value ?? -1),
  };
}

export function isActiveHours(date: Date, schedule: RefreshSchedule): boolean {
  const { hour } = localTime(date, schedule.timeZone);
  return hour >= schedule.activeStartHour && hour < schedule.activeEndHour;
}

export function nextScheduledRefresh(date: Date, schedule: RefreshSchedule): Date {
  const intervalMs = schedule.intervalMinutes * 60_000;
  const intervalCandidate = new Date(date.getTime() + intervalMs);
  if (isActiveHours(date, schedule) && isActiveHours(intervalCandidate, schedule)) {
    return intervalCandidate;
  }

  let cursorMs = Math.ceil((date.getTime() + 1_000) / 60_000) * 60_000;
  const searchLimit = cursorMs + 48 * 60 * 60_000;
  while (cursorMs <= searchLimit) {
    const cursor = new Date(cursorMs);
    const { hour, minute } = localTime(cursor, schedule.timeZone);
    if (hour === schedule.activeStartHour && minute === 0) return cursor;
    cursorMs += 60_000;
  }
  throw new Error(`Unable to find the next ${schedule.activeStartHour}:00 in ${schedule.timeZone}`);
}
