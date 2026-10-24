import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageMonitor } from '../server/monitor.js';
import type { RefreshSchedule } from '../server/types.js';
import { usageFixture } from './fixtures.js';

const tempDirs: string[] = [];
const schedule: RefreshSchedule = {
  intervalMinutes: 5,
  activeStartHour: 6,
  activeEndHour: 21,
  timeZone: 'America/Los_Angeles',
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function cachePath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tango-usage-monitor-'));
  tempDirs.push(directory);
  return path.join(directory, 'latest.json');
}

describe('UsageMonitor', () => {
  it('stores a successful snapshot outside the repo', async () => {
    const target = await cachePath();
    const monitor = new UsageMonitor({
      collect: vi.fn().mockResolvedValue(usageFixture),
      cachePath: target,
      schedule,
      now: () => new Date('2026-09-04T17:00:00.000Z'),
    });

    const state = await monitor.refresh({ force: true });

    expect(state.refreshing).toBe(false);
    expect(state.usage?.accounts[0]?.live).toBe(true);
    expect(state.lastError).toBeNull();
    expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual(usageFixture);
  });

  it('keeps last-known-good data when a later collection fails', async () => {
    const target = await cachePath();
    const collect = vi.fn()
      .mockResolvedValueOnce(usageFixture)
      .mockRejectedValueOnce(new Error('provider timeout'));
    const monitor = new UsageMonitor({
      collect,
      cachePath: target,
      schedule,
      now: () => new Date('2026-09-04T17:00:00.000Z'),
    });

    await monitor.refresh({ force: true });
    const state = await monitor.refresh({ force: true });

    expect(state.usage?.accounts[0]?.live).toBe(false);
    expect(state.usage?.accounts[0]?.staleReason).toContain('last known');
    expect(state.usage?.accounts[0]?.windows).toEqual(usageFixture.accounts[0]?.windows);
    expect(state.lastError).toBe('provider timeout');
  });

  it('does not call providers during quiet hours unless forced', async () => {
    const collect = vi.fn().mockResolvedValue(usageFixture);
    const monitor = new UsageMonitor({
      collect,
      cachePath: await cachePath(),
      schedule,
      now: () => new Date('2026-09-05T07:00:00.000Z'),
    });

    const quiet = await monitor.initialize();
    expect(quiet.quietHours).toBe(true);
    expect(quiet.nextScheduledRefreshAt).toBe('2026-09-05T13:00:00.000Z');
    expect(collect).not.toHaveBeenCalled();

    await monitor.refreshNow();
    expect(collect).toHaveBeenCalledOnce();
    monitor.stop();
  });

  it('reports the current quiet-hours state even between scheduled checks', async () => {
    let now = new Date('2026-09-05T03:50:00.000Z');
    const monitor = new UsageMonitor({
      collect: async () => usageFixture,
      cachePath: await cachePath(),
      schedule,
      now: () => now,
    });

    expect(monitor.snapshot().quietHours).toBe(false);
    now = new Date('2026-09-05T04:05:00.000Z');
    expect(monitor.snapshot().quietHours).toBe(true);
  });
});
