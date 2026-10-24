import type { UsageWindow } from './types';
import type { DashboardState } from './types';

export function percentLeft(window: UsageWindow): number | null {
  if (Number.isFinite(window.remainingPercent)) return Math.max(0, Math.min(100, window.remainingPercent as number));
  if (Number.isFinite(window.usedPercent)) return Math.max(0, Math.min(100, 100 - (window.usedPercent as number)));
  return null;
}

export function isSpecialWindow(window: UsageWindow): boolean {
  const standardKinds = new Set(['session', 'weekly_all', 'five_hour', 'seven_day', 'primary', 'secondary']);
  return !standardKinds.has(window.kind)
    || /fable|spark|opus|sonnet|scoped|promotional/i.test(`${window.kind} ${window.title}`);
}

export function formatPercent(value: number | null): string {
  if (!Number.isFinite(value)) return '—';
  return `${Math.round((value as number) * 10) / 10}%`;
}

export function formatAbsoluteTime(value: string | null): string {
  if (!value) return 'Reset time unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Reset time unavailable';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export function formatRelativeTime(value: string | null, now: number): string {
  if (!value) return 'reset unknown';
  const target = new Date(value).getTime();
  if (!Number.isFinite(target)) return 'reset unknown';
  const diffMinutes = Math.ceil((target - now) / 60_000);
  if (diffMinutes <= 0) return 'resetting now';
  const days = Math.floor(diffMinutes / 1_440);
  const hours = Math.floor((diffMinutes % 1_440) / 60);
  const minutes = diffMinutes % 60;
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

export function formatAge(value: string | null, now: number): string {
  if (!value) return 'Never';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 'Unknown';
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatHour(hour: number): string {
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const normalized = hour % 12 || 12;
  return `${normalized} ${suffix}`;
}

export function isQuietTime(schedule: DashboardState['schedule'] | undefined, now: number): boolean {
  if (!schedule) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: schedule.timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? -1);
  return hour < schedule.activeStartHour || hour >= schedule.activeEndHour;
}
