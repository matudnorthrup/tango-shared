import { describe, expect, it } from 'vitest';
import { isActiveHours, nextScheduledRefresh } from '../server/schedule.js';
import type { RefreshSchedule } from '../server/types.js';

const schedule: RefreshSchedule = {
  intervalMinutes: 5,
  activeStartHour: 6,
  activeEndHour: 21,
  timeZone: 'America/Los_Angeles',
};

describe('usage refresh schedule', () => {
  it('treats 6 AM through 8:59 PM Pacific as active', () => {
    expect(isActiveHours(new Date('2026-09-04T13:00:00.000Z'), schedule)).toBe(true);
    expect(isActiveHours(new Date('2026-09-05T03:59:00.000Z'), schedule)).toBe(true);
    expect(isActiveHours(new Date('2026-09-05T04:00:00.000Z'), schedule)).toBe(false);
  });

  it('keeps five-minute cadence inside active hours', () => {
    expect(nextScheduledRefresh(new Date('2026-09-04T17:20:00.000Z'), schedule).toISOString())
      .toBe('2026-09-04T17:25:00.000Z');
  });

  it('skips overnight checks and resumes at 6 AM Pacific', () => {
    expect(nextScheduledRefresh(new Date('2026-09-05T03:58:00.000Z'), schedule).toISOString())
      .toBe('2026-09-05T13:00:00.000Z');
    expect(nextScheduledRefresh(new Date('2026-09-05T07:00:00.000Z'), schedule).toISOString())
      .toBe('2026-09-05T13:00:00.000Z');
  });
});
