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
  generatedAt: string;
  accounts: UsageAccount[];
  errors: UsageError[];
}

export interface DashboardState {
  usage: UsagePayload | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextScheduledRefreshAt: string | null;
  refreshing: boolean;
  quietHours: boolean;
  lastError: string | null;
  schedule: {
    intervalMinutes: number;
    activeStartHour: number;
    activeEndHour: number;
    timeZone: string;
  };
}
