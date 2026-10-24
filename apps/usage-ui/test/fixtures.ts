import type { UsagePayload } from '../server/types.js';

export const usageFixture: UsagePayload = {
  schemaVersion: 2,
  commandVersion: '2.0.0',
  generatedAt: '2026-09-04T17:00:00.000Z',
  accounts: [
    {
      provider: 'Claude',
      account: 'Personal',
      source: 'claude-oauth-live',
      live: true,
      subscriptionType: 'max',
      updatedAt: '2026-09-04T17:00:00.000Z',
      creditsRemaining: null,
      windows: [
        {
          kind: 'session',
          title: '5 hour',
          usedPercent: 44,
          remainingPercent: 56,
          windowMinutes: 300,
          resetsAt: '2026-09-04T20:00:00.000Z',
          severity: 'normal',
        },
        {
          kind: 'weekly_scoped',
          title: 'Fable only',
          usedPercent: 18,
          remainingPercent: 82,
          windowMinutes: 10_080,
          resetsAt: '2026-09-08T12:00:00.000Z',
          severity: 'normal',
        },
      ],
    },
  ],
  errors: [],
};
