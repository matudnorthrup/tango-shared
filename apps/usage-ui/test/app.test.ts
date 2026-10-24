import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createUsageApp, withBasePath } from '../server/app.js';
import { UsageMonitor } from '../server/monitor.js';
import { usageFixture } from './fixtures.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('usage dashboard app', () => {
  it('serves state, refresh, health, and the mounted page', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tango-usage-app-'));
    tempDirs.push(directory);
    await fs.writeFile(path.join(directory, 'index.html'), '<title>Tango Usage</title>');
    const monitor = new UsageMonitor({
      collect: async () => usageFixture,
      cachePath: path.join(directory, 'cache', 'latest.json'),
      schedule: { intervalMinutes: 5, activeStartHour: 6, activeEndHour: 21, timeZone: 'America/Los_Angeles' },
      now: () => new Date('2026-09-04T17:00:00.000Z'),
    });
    const app = createUsageApp(monitor, directory);
    const fetchMounted = withBasePath(app, '/tango-usage');

    const health = await app.request('/api/health');
    const usage = await app.request('/api/usage');
    expect(health.status).toBe(200);
    expect(health.headers.get('x-frame-options')).toBe('DENY');
    expect(usage.status).toBe(200);
    expect(usage.headers.get('cache-control')).toBe('no-store');
    const refreshHeader = { 'x-tango-usage-refresh': '1' };
    expect((await app.request('/api/refresh', { method: 'POST' })).status).toBe(403);
    expect((await app.request('http://usage.test/api/refresh', { method: 'POST',
      headers: { ...refreshHeader, origin: 'https://evil.test' } })).status).toBe(403);
    expect((await app.request('http://usage.test/api/refresh', { method: 'POST',
      headers: { ...refreshHeader, origin: 'http://usage.test' } })).status).toBe(200);
    expect((await app.request('http://127.0.0.1:9380/api/refresh', { method: 'POST',
      headers: { ...refreshHeader, origin: 'https://host.tailnet.ts.net', 'x-forwarded-host': 'host.tailnet.ts.net' } })).status).toBe(200);
    expect((await app.request('/api/refresh', { method: 'POST', headers: refreshHeader })).status).toBe(200);
    expect(await (await fetchMounted(new Request('http://example.test/tango-usage/'))).text())
      .toContain('<title>Tango Usage</title>');
  });
});
