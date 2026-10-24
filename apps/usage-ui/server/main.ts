import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createUsageApp, withBasePath } from './app.js';
import { collectUsage } from './collector.js';
import { UsageMonitor } from './monitor.js';

const PORT = Number(process.env.USAGE_UI_PORT ?? 9380);
const HOST = process.env.USAGE_UI_HOST ?? '127.0.0.1';
// Keep in sync with the client build (vite.config.ts reads the same variable).
const BASE_PATH = (process.env.USAGE_UI_BASE_PATH ?? '/tango-usage').replace(/\/+$/, '');
const PROFILE = process.env.TANGO_PROFILE ?? 'default';
const CACHE_PATH = process.env.USAGE_UI_CACHE_PATH
  ?? path.join(os.homedir(), '.tango', 'profiles', PROFILE, 'usage-monitor', 'latest.json');

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(
  serverDir,
  serverDir.includes(`${path.sep}dist${path.sep}`) ? '../client' : '../dist/client',
);

const monitor = new UsageMonitor({
  collect: () => collectUsage(),
  cachePath: CACHE_PATH,
  schedule: {
    // Other Claude clients share the usage endpoint; more frequent collection
    // has drawn 429s with Retry-After of up to an hour.
    intervalMinutes: Number(process.env.USAGE_UI_REFRESH_MINUTES ?? 10),
    activeStartHour: Number(process.env.USAGE_UI_ACTIVE_START_HOUR ?? 6),
    activeEndHour: Number(process.env.USAGE_UI_ACTIVE_END_HOUR ?? 21),
    timeZone: process.env.USAGE_UI_TIME_ZONE ?? 'America/Los_Angeles',
  },
});

const app = createUsageApp(monitor, clientDir);
const server = serve({ fetch: withBasePath(app, BASE_PATH), port: PORT, hostname: HOST }, (info) => {
  console.log(`[usage-ui] serving on http://${HOST}:${info.port}${BASE_PATH}`);
  console.log(`[usage-ui] refresh: every ${monitor.snapshot().schedule.intervalMinutes}m during active hours; cache: ${CACHE_PATH}`);
});
// Serve cached/loading state while native credential renewal runs.
void monitor.initialize();

function shutdown(): void {
  monitor.stop();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
