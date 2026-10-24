export interface UsageWindow {
  kind: string;
  title: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  windowMinutes: number | null;
  resetsAt: string | null;
  severity: string | null;
}

export interface UsageAccount {
  recommendationExcluded?: boolean;
  staleReason?: string;
  profileColor?: string;
  profileName?: string;
  provider: string;
  account: string;
  profiles?: string[];
  source: string;
  live: boolean;
  subscriptionType?: string | null;
  updatedAt: string | null;
  creditsRemaining?: number | null;
  windows: UsageWindow[];
}

export interface UsageError {
  provider: string;
  account: string;
  message: string;
}

export interface UsagePayload {
  schemaVersion: number;
  commandVersion?: string;
  generatedAt: string;
  accounts: UsageAccount[];
  errors: UsageError[];
}

export interface RefreshSchedule {
  intervalMinutes: number;
  activeStartHour: number;
  activeEndHour: number;
  timeZone: string;
}

export interface DashboardState {
  usage: UsagePayload | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextScheduledRefreshAt: string | null;
  refreshing: boolean;
  quietHours: boolean;
  lastError: string | null;
  schedule: RefreshSchedule;
}

function isFinitePercent(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100);
}

function isUsageWindow(value: unknown): value is UsageWindow {
  if (!value || typeof value !== 'object') return false;
  const window = value as Record<string, unknown>;
  return typeof window.kind === 'string'
    && typeof window.title === 'string'
    && isFinitePercent(window.usedPercent)
    && isFinitePercent(window.remainingPercent)
    && (window.windowMinutes === null || (typeof window.windowMinutes === 'number' && Number.isFinite(window.windowMinutes)))
    && (window.resetsAt === null || typeof window.resetsAt === 'string')
    && (window.severity === null || typeof window.severity === 'string');
}

function isUsageAccount(value: unknown): value is UsageAccount {
  if (!value || typeof value !== 'object') return false;
  const account = value as Record<string, unknown>;
  return typeof account.provider === 'string'
    && typeof account.account === 'string'
    && typeof account.source === 'string'
    && typeof account.live === 'boolean'
    && (account.updatedAt === null || typeof account.updatedAt === 'string')
    && Array.isArray(account.windows)
    && account.windows.every(isUsageWindow);
}

function isUsageError(value: unknown): value is UsageError {
  if (!value || typeof value !== 'object') return false;
  const error = value as Record<string, unknown>;
  return typeof error.provider === 'string'
    && typeof error.account === 'string'
    && typeof error.message === 'string';
}

export function parseUsagePayload(value: unknown): UsagePayload {
  if (!value || typeof value !== 'object') throw new Error('Usage collector returned a non-object payload');
  const payload = value as Record<string, unknown>;
  if (typeof payload.schemaVersion !== 'number') throw new Error('Usage payload has no schema version');
  if (typeof payload.generatedAt !== 'string' || Number.isNaN(Date.parse(payload.generatedAt))) {
    throw new Error('Usage payload has an invalid generatedAt timestamp');
  }
  if (!Array.isArray(payload.accounts) || !payload.accounts.every(isUsageAccount)) {
    throw new Error('Usage payload has invalid accounts');
  }
  if (!Array.isArray(payload.errors) || !payload.errors.every(isUsageError)) {
    throw new Error('Usage payload has invalid errors');
  }
  if (payload.accounts.length === 0 && payload.errors.length === 0) throw new Error('Usage collector returned no accounts');
  return value as UsagePayload;
}
