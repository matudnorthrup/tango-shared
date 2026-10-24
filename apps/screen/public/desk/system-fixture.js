// The System page's fixture (?fixtures=1): GET /api/desk/system's shape with invented jobs, incidents and
// events (no real machine, labels or paths: this repo is public), and a small command applier, so the page
// renders and acts offline. `?system=clear` is a calm day: everything ran, nothing open.

const M = 60_000;
const H = 60 * M;
const D = 24 * H;

// [id, runner, name, group, owner, cadence, cadenceSeconds, criticality, lastMin, nextMin, status, strip (oldest → newest: o ok, q quiet, f failed, - none), summary, extra]
const JOBS = [
  ['tmux:bot', 'tmux', 'Discord bot + MCP', 'Tango core & Desk', null, 'Always on', null, 'critical', 0, null, 'ok', 'oooooooo', 'Up · restarted 5× this week by the healthcheck', { services: ['bot', 'mcp'], port: 9100, startedAt: -3.2 * H }],
  ['launchd:com.example.healthcheck', 'launchd', 'healthcheck', 'Tango core & Desk', null, 'Every 60s', 60, 'critical', 0, 1, 'ok', 'oooooooo', 'Checks bot, MCP, voice, desk, tailnet', { services: ['bot', 'mcp', 'voice', 'desk', 'tailnet'] }],
  ['launchd:com.example.startup', 'launchd', 'startup', 'Tango core & Desk', null, 'At boot', null, 'critical', 25 * 60, null, 'failed', '-------f', 'Exited 1 at the last boot: “bot failed to start”', { services: ['bot'] }],
  ['launchd:com.example.loom', 'launchd', 'Loom', 'Tango core & Desk', null, 'Always on', null, 'critical', 0, null, 'ok', 'oooooooo', 'Up · :9420', { services: ['loom'], port: 9420, startedAt: -25 * H }],
  ['launchd:com.example.desk', 'launchd', 'Agent Desk', 'Tango core & Desk', null, 'Always on', null, 'critical', 0, null, 'ok', 'oooooooo', 'Up · :9410', { services: ['desk'], port: 9410, startedAt: -9 * H }],
  ['launchd:com.example.voice', 'launchd', 'Voice operator', 'Tango core & Desk', null, 'Always on', null, 'normal', 0, null, 'ok', 'oooooooo', 'Up', { services: ['voice'], startedAt: -25 * H }],
  ['schedule:state-sweep', 'schedule', 'State Lifecycle Sweep', 'Tango core & Desk', null, 'Every 10 min', 600, 'quiet', 0, 10, 'ok', 'ooofoooo', 'Swept 1,410 entities', { services: ['bot'] }],
  ['schedule:attachment-retention', 'schedule', 'Attachment Retention Sweep', 'Tango core & Desk', null, 'Daily 04:25', 86400, 'quiet', 145, 1295, 'ok', 'oooooooo', 'Proposed 2 review decisions', { services: ['bot'], usedDays: 49, retire: 'Its review proposals haven’t been looked at in seven weeks.' }],
  ['schedule:browser-keepalive', 'schedule', 'Browser Session Keepalive', 'Tango core & Desk', null, 'Every 45 min', 2700, 'normal', 5, 40, 'failed', 'fofoffof', 'Failed with no error text', { services: ['bot'] }],
  ['tmux:remote-control', 'tmux', 'remote-control window', 'Tango core & Desk', null, 'Always on', null, 'normal', 0, null, 'failed', 'ffffffff', 'Restarting every 5s', { services: ['bot'], restarting: true, usedDays: 100, retire: 'Crash-looping for months; nobody has opened it since.' }],
  ['schedule:daily-brief', 'schedule', 'Daily Brief', 'Watson', 'watson', 'Daily 05:00', 86400, 'normal', 110, 1330, 'failed', 'ffffffff', 'Written, never posted: placeholder channel', { services: ['bot'] }],
  ['schedule:email-review', 'schedule', 'Daily Email Review', 'Watson', 'watson', 'Daily 04:30', 86400, 'normal', 140, 1300, 'ok', 'oooooooo', 'Triaged 41 emails, flagged 3', { usedDays: 0 }],
  ['schedule:morning-planning', 'schedule', 'Morning Planning Backstop', 'Watson', 'watson', 'Daily 05:15', 86400, 'normal', 95, 1345, 'ok', 'qqoqqqoq', 'Skipped: you planned already', { usedDays: 0 }],
  ['schedule:memory-eval', 'schedule', 'Memory Eval Report', 'Watson', 'watson', 'Daily 06:15', 86400, 'quiet', 35, 1405, 'ok', 'ffffffff', '47 of 48 cases passed', {}],
  ['schedule:model-scorecard', 'schedule', 'Model Scorecard', 'Watson', 'watson', 'Mondays 6:30', 604800, 'quiet', 8660, 1420, 'ok', 'oooooooo', 'Weekly report', { usedDays: 60, retire: 'A weekly report nobody has opened since the bake-off ended.' }],
  ['schedule:printer-monitor', 'schedule', '3D Printer Monitor', 'Sierra', 'sierra', 'Every 2 min', 120, 'quiet', 1, 1, 'failed', 'qfqqfqfq', 'Runs fine; posting to the forum channel fails', { services: ['bot'] }],
  ['schedule:ai-briefing', 'schedule', 'AI Intelligence Briefing', 'Sierra', 'sierra', 'Daily 15:05', 86400, 'normal', 945, 495, 'ok', 'ooofoooo', '1 timeout this month', { usedDays: 1 }],
  ['schedule:finance-review', 'schedule', 'Finance Review (Rolling)', 'Foxtrot', 'foxtrot', 'Sundays 7:00', 604800, 'normal', 10070, 10, 'ok', 'oooooooo', 'Next run in 10 minutes', { usedDays: 7 }],
  ['schedule:receipt-cataloger', 'schedule', 'Receipt Cataloger', 'Foxtrot', 'foxtrot', 'Daily 2:00', 86400, 'quiet', 290, 1150, 'ok', 'qqoqqoqq', 'Nothing missing', {}],
  ['schedule:daily-note', 'schedule', 'Daily Note Bootstrap', 'Memory & notes', null, 'Daily 4:55', 86400, 'normal', 115, 1325, 'ok', 'oooooooo', 'Created today’s note', {}],
  ['schedule:memory-archive', 'schedule', 'Memory Archival', 'Memory & notes', null, 'Daily 4:00', 86400, 'quiet', 170, 1270, 'ok', 'oooooooo', 'Archived 38 memories', {}],
  ['launchd:com.example.health-pull', 'launchd', 'health-pull', 'Health', null, 'Every 15 min', 900, 'critical', 5, 10, 'failed', 'offofoff', '“Health store locked”: 15 aborts today', { logs: ['logs/health-pull.log'] }],
  ['launchd:com.example.health-watchdog', 'launchd', 'health-watchdog', 'Health', null, 'Every 2h', 7200, 'normal', 50, 70, 'ok', 'ooooooof', 'Data 4h old at 05:16', {}],
  ['docker:health-server', 'docker', 'health-server', 'Health', null, 'Always on', null, 'critical', 0, null, 'ok', 'oooooooo', 'Up · :3001', { services: ['docker'], port: 3001, startedAt: -26 * H }],
  ['launchd:com.example.backup', 'launchd', 'Backup (restic → B2)', 'Backups & media', null, 'Daily 3:30', 86400, 'critical', 200, 1240, 'ok', 'oooooooo', 'Complete · 9m · 4.2 GB scanned', { services: ['docker'] }],
  ['launchd:com.example.projects-sync', 'launchd', 'projects-sync', 'Backups & media', null, 'Daily 2:30', 86400, 'normal', 260, 1180, 'failed', 'ooooffof', 'rsync exit 23 on video bundles, 3 nights', {}],
  ['launchd:com.example.media-inbox', 'launchd', 'media-inbox', 'Backups & media', null, 'Every 15 min', 900, 'normal', 10 * 24 * 60, 10, 'late', '--------', 'No heartbeat in 10 days', {}],
  ['launchd:com.example.cleanup-ui', 'launchd', 'Cleanup review UI', 'Backups & media', null, 'Always on', null, 'quiet', 0, null, 'ok', 'oooooooo', 'Up · :9400', { port: 9400, startedAt: -25 * H, usedDays: 41, retire: 'The cleanup review finished six weeks ago.' }],
  ['tmux:home', 'tmux', 'home site', 'Tailnet sites', null, 'Always on', null, 'normal', 0, null, 'ok', 'oooooooo', 'Up · :9310', { services: ['tailnet'], port: 9310, startedAt: -25 * H, usedDays: 0 }],
  ['tmux:food', 'tmux', 'Food tracker', 'Tailnet sites', null, 'Always on', null, 'normal', 0, null, 'ok', 'oooooooo', 'Up · :9370', { services: ['tailnet'], port: 9370, startedAt: -25 * H, usedDays: 0 }],
  ['tmux:itinerary', 'tmux', 'itinerary', 'Tailnet sites', null, 'Always on', null, 'quiet', 0, null, 'ok', 'oooooooo', 'Up · :9365', { services: ['tailnet'], port: 9365, startedAt: -25 * H, usedDays: 12, retire: 'The trip it was built for has ended.' }],
  ['launchd:com.example.router-restart', 'launchd', 'Access point restart', 'Home & infra', null, 'Daily 4:00', 86400, 'normal', 170, 1270, 'ok', 'oooooooo', 'Restarted 3 access points in turn', {}],
  ['launchd:com.example.tasks-export', 'launchd', 'Tasks export', 'Home & infra', 'papa', 'Every 10 min', 600, 'normal', null, null, 'failed', '--------', 'Plist won’t load: malformed XML', {}],
  ['routine:agent-updates', 'routine', 'agent-updates', 'Claude routines', null, 'Daily', 86400, 'normal', 2 * 24 * 60 + 60, null, 'late', 'oooooo--', 'Hasn’t run in two days', {}],
  ['background:photo-dedupe', 'background', 'Photo library dedupe', 'Background jobs & waits', 'watson', 'Until done', null, 'quiet', 3, null, 'running', '-----ooo', 'Running · 62%', {}],
  ['loom-wait:pr-review', 'loom-wait', 'Wait: PR review', 'Background jobs & waits', null, 'Until approved', null, 'quiet', 50, null, 'ok', '--------', 'Wakes its thread when approved', {}],
];

const UNMANAGED = [
  ['proc:loom-stale-1', 'Loom (stale build)', { cmd: 'node dist/loom/main.js', port: 9461, pid: 48211, age: '2d 6h', cpu: 9, mem: '410 MB', cwd: '~/worktrees/loom-19ab3c2e', cwd_deleted: true, parent: 'launchd (re-parented)' }],
  ['proc:loom-stale-2', 'Loom (stale build)', { cmd: 'node dist/loom/main.js', port: 9462, pid: 48302, age: '2d 6h', cpu: 31, mem: '1.6 GB', cwd: '~/worktrees/loom-19ab3c2e', cwd_deleted: true, parent: 'launchd (re-parented)', child: 'claude · running 10h · 1.2 GB' }],
  ['proc:screenshots', 'screenshot servers', { count: 7, cmd: 'node scripts/deskshot.mjs', port: '9471–9477', pid: '51022…51388', age: '1–3d', cpu: 24, mem: '1.1 GB', cwd: '~/worktrees/loom-77c0d1e4', cwd_deleted: true, parent: 'launchd (re-parented)' }],
  ['proc:browser-script', 'scraper + headless browser', { cmd: 'node scrape.mjs · chromium', pid: 60117, age: '19h', cpu: 220, mem: '2.3 GB', cwd: '~/artifacts/scrape', parent: 'zsh (tmux pane gone)' }],
  ['proc:dev-servers', 'game dev servers', { count: 3, cmd: 'vite', port: '5173, 5174, 4173', pid: '7731…7790', age: '3d', cpu: 6, mem: '640 MB', cwd: '~/code/game', parent: 'launchd (re-parented)' }],
];

// [id, jobId, title, severity, status, count, firstMin, lastMin, extra]
const INCIDENTS = [
  [1, 'launchd:com.example.health-pull', 'Health pull failing: “Health store locked”', 'critical', 'open', 203, 6 * 60 + 45, 15, { flapping: true, reopenCount: 5, notifiedMin: 6 * 60 + 45 }],
  [2, 'launchd:com.example.startup', 'Production startup failed on the last boot', 'critical', 'open', 1, 25 * 60, 25 * 60, {}],
  [3, 'schedule:printer-monitor', 'Delivery failed: printer monitor → forum channel', 'error', 'open', 23, 4 * 60 + 32, 6, { notifiedMin: 4 * 60 + 32 }],
  [4, 'launchd:com.example.projects-sync', 'Projects sync: rsync exit 23 on video bundles', 'error', 'open', 3, 28 * 60, 4 * 60 + 11, { regressed: true, notifiedMin: 4 * 60 + 11 }],
  [5, 'schedule:daily-brief', 'Daily Brief posts to a placeholder channel', 'error', 'open', 9, 8 * D / M, 110, { notifiedMin: 8 * D / M }],
  [6, null, 'Load average high: 44–53 on 24 cores', 'warning', 'open', 1, 6 * 60 + 10, 1, { notifiedMin: 6 * 60 + 10 }],
  [7, 'schedule:browser-keepalive', 'Browser Session Keepalive failing with no error text', 'error', 'open', 126, 30 * D / M, 5, {}],
  [8, 'tmux:remote-control', 'remote-control window restarting every 5s', 'warning', 'open', 110000, 100 * D / M, 1, {}],
  [9, 'launchd:com.example.tasks-export', 'Tasks export won’t load: malformed plist', 'error', 'open', 1, 50, 50, {}],
  [10, 'routine:agent-updates', 'agent-updates is late: hasn’t run in two days', 'warning', 'open', 1, 22 * 60, 5, {}],
  [11, null, '3 logs past 10 MB', 'info', 'open', 3, 25 * 60, 50, {}],
  [12, 'schedule:memory-eval', 'Memory Eval: 1 of 48 cases failing (same case)', 'info', 'acked', 69, 99 * D / M, 35, {}],
  [13, 'launchd:com.example.voice', 'Voice playground restarted 5× today', 'info', 'muted', 5, 5 * 60 + 38, 41, {}],
  [14, 'tmux:bot', 'Bot frozen → restarted by the healthcheck', 'critical', 'resolved', 5, 18 * 60 + 37, 18 * 60 + 33, { resolvedMin: 18 * 60 + 33 }],
  [15, 'docker:health-server', 'health-server and its database were down', 'error', 'resolved', 2, 27 * 60, 27 * 60 - 3, { resolvedMin: 23 * 60 + 48 }],
];

// [minAgo, source, severity, jobId, title, incidentId]
const EVENTS = [
  [1, 'tmux', 'warning', 'tmux:remote-control', 'remote-control exited: “only available with a subscription”', 8],
  [1, 'tmux', 'warning', 'tmux:remote-control', 'remote-control exited: “only available with a subscription”', 8],
  [1, 'tick', 'warning', null, 'Load average 47.2 (24 cores)', 6],
  [5, 'scheduler', 'error', 'schedule:browser-keepalive', 'Run failed (no error text)', 7],
  [6, 'scheduler', 'error', 'schedule:printer-monitor', 'Delivery failed: the channel is a forum channel', 3],
  [15, 'tango-run', 'critical', 'launchd:com.example.health-pull', 'Exited 1: Health store locked (backfill 3 of 6 aborted)', 1],
  [15, 'tango-run', 'recovery', 'launchd:com.example.health-pull', 'Recovered: pull ok, 214 samples', 1],
  [30, 'tango-run', 'critical', 'launchd:com.example.health-pull', 'Exited 1: Health store locked', 1],
  [35, 'scheduler', 'warning', 'schedule:memory-eval', 'Eval: 47 of 48 passed', 12],
  [41, 'launchd', 'warning', 'launchd:com.example.voice', 'Playground restarted by launchd (exit 137)', 13],
  [45, 'tango-run', 'info', 'schedule:memory-archive', 'Finished in 4s: archived 38 memories', null],
  [50, 'launchd', 'error', 'launchd:com.example.tasks-export', 'Plist failed to load: malformed XML at line 31', 9],
  [50, 'tick', 'warning', null, 'Log past 10 MB: health-pull.log (45 MB)', 11],
  [110, 'scheduler', 'error', 'schedule:daily-brief', 'Delivery failed: channel not found', 5],
  [190, 'tango-run', 'info', 'launchd:com.example.backup', 'Backup complete in 9m: 4.2 GB scanned, 312 MB added', null],
  [251, 'tango-event', 'error', 'launchd:com.example.projects-sync', 'rsync exit 23: Resource deadlock avoided', 4],
  [272, 'scheduler', 'error', 'schedule:printer-monitor', 'Delivery failed: the channel is a forum channel', 3],
  [6 * 60 + 10, 'tick', 'warning', null, 'Load average 44.0 (24 cores)', 6],
  [6 * 60 + 45, 'tango-run', 'critical', 'launchd:com.example.health-pull', 'Exited 1: Health store locked', 1],
  [18 * 60 + 33, 'healthcheck', 'recovery', 'tmux:bot', 'Bot recovered after restart (4m outage)', 14],
  [18 * 60 + 37, 'healthcheck', 'critical', 'tmux:bot', 'Bot frozen: /status/work timed out 3×, restarting', 14],
  [25 * 60, 'launchd', 'critical', 'launchd:com.example.startup', 'Exited 1: bot failed to start', 2],
];

const SERVICES = [['bot', 'Bot', 3.2 * H], ['loom', 'Loom', 25 * H], ['desk', 'Desk', 9 * H], ['mcp', 'MCP', 25 * H], ['voice', 'Voice', 25 * H], ['tailnet', 'Tailnet', 25 * H], ['docker', 'Docker', 26 * H]];

const LOG = `06:20 pull start host=‹redacted› port=9000
06:20 backfill 3/6 window=00:00..06:00
06:20 ERROR Health store locked (HKErrorDatabaseInaccessible)
06:20 abort backfill 3/6 after 27.4s · retries left 0
06:20 exit 1
06:35 pull start host=‹redacted› port=9000
06:35 pull ok samples=214 latest=06:31`;

export function systemFixture(now = Date.now(), { clear = false } = {}) {
  const iso = (msAgo) => (msAgo == null ? null : new Date(now - msAgo).toISOString());
  const STATUS = { o: 'ok', q: 'quiet', f: 'failed' };
  const jobs = [];
  const runs = {};
  const detail = {};
  for (const [id, runner, name, group, owner, cadence, cadenceSeconds, criticality, lastMin, nextMin, status, strip, summary, x] of JOBS) {
    if (clear && id === 'tmux:remote-control') continue;
    const bad = status === 'failed' || status === 'late';
    const lastStatus = clear && bad ? 'ok' : status;
    const cells = (clear && bad ? strip.replace(/f/g, 'o').replace(/^-+$/, 'oooooooo') : strip).split('').filter((c) => c !== '-').map((c) => STATUS[c]);
    if (status === 'running') cells.push('running');
    const lastAt = clear && bad && lastMin != null && lastMin > 60 ? 7 : lastMin;
    jobs.push({
      id, runner, name, owner, group, cadence, cadenceSeconds, criticality,
      source: runner === 'schedule' ? `config/schedules/${id.slice(9)}.yaml` : runner === 'launchd' ? `~/Library/LaunchAgents/${id.slice(8)}.plist` : runner === 'tmux' ? `config/startup.yaml › ${id.slice(5)}` : null,
      logs: x.logs || [], probe: x.port ? { port: x.port } : null,
      state: 'active', retiredAt: null, retireReason: null, archivePath: null, managed: true,
      lastRunAt: lastAt == null ? null : iso(lastAt * M), lastStatus, lastExit: lastStatus === 'failed' ? 1 : 0,
      nextRunAt: nextMin == null ? null : new Date(now + nextMin * M).toISOString(),
      lastUsedAt: x.usedDays == null ? null : iso(x.usedDays * D + 2 * H),
      retireCandidate: x.retire || null,
      facts: { services: x.services || [], ...(x.port ? { port: x.port } : {}), ...(x.startedAt ? { startedAt: new Date(now + x.startedAt).toISOString() } : {}), ...(x.restarting && !clear ? { restarting: true } : {}) },
      seenAt: iso(40_000),
    });
    runs[id] = { strip: cells.slice(-8), summary: clear && bad ? 'Ran fine' : summary, durationMs: 4000 };
    const runList = cells.slice().reverse().map((c, k) => ({ id: k + 1, jobId: id, startedAt: iso(((lastAt ?? 0) + k * Math.max(1, (cadenceSeconds || 3600) / 60)) * M), finishedAt: null, status: c, exitCode: c === 'failed' ? 1 : 0, durationMs: 2000 + ((k * 7919) % 30000), summary: c === 'failed' ? summary : c === 'quiet' ? 'Nothing to do' : 'Ran', outputTail: null, sourceRef: null }));
    detail[id] = { runs: runList, logTail: x.logs?.length ? LOG : null, logPath: x.logs?.[0] || null };
  }
  jobs.push({ ...jobs.find((j) => j.id === 'schedule:model-scorecard'), id: 'schedule:weekly-subscriptions', name: 'Weekly Email Subscriptions', state: 'retired', retiredAt: iso(2 * D), retireReason: 'Replaced by something else. The nightly review covers it.', archivePath: 'archive/retired/weekly-subscriptions.yaml', retireCandidate: null });
  if (!clear) for (const [id, name, facts] of UNMANAGED) jobs.push({ id, runner: 'launchd', name, owner: null, group: null, cadence: null, cadenceSeconds: null, criticality: 'quiet', source: null, logs: [], probe: null, state: 'active', retiredAt: null, retireReason: null, archivePath: null, managed: false, lastRunAt: null, lastStatus: null, lastExit: null, nextRunAt: null, lastUsedAt: null, retireCandidate: null, facts, seenAt: iso(40_000) });
  const incidents = INCIDENTS.filter(([, , , , status]) => !clear || status === 'resolved').map(([id, jobId, title, severity, status, count, firstMin, lastMin, x]) => ({
    id, fingerprint: `fp${String(id).padStart(3, '0')}c0ffee`, jobId, title, severity, status,
    // As the ledger routes it: a quiet job's or an info incident stays on the page; a critical job's error is critical.
    route: JOBS.find((j) => j[0] === jobId)?.[7] === 'quiet' || severity === 'info' ? 'quiet' : severity === 'critical' || (severity === 'error' && JOBS.find((j) => j[0] === jobId)?.[7] === 'critical') ? 'critical' : 'normal', firstSeen: iso(firstMin * M), lastSeen: iso(lastMin * M), count,
    resolvedAt: x.resolvedMin != null ? iso(x.resolvedMin * M) : null, snoozedUntil: null, regressed: !!x.regressed, flapping: !!x.flapping, reopenCount: x.reopenCount || 0, notifiedAt: x.notifiedMin != null ? iso(x.notifiedMin * M) : null,
  }));
  const keep = new Set(incidents.map((i) => i.id));
  const recentEvents = EVENTS.filter((e) => !clear || e[5] == null || keep.has(e[5])).map(([min, source, severity, jobId, title, incidentId], k) => ({ id: 1000 - k, at: iso(min * M), source, jobId, kind: severity === 'recovery' ? 'service.up' : 'run.failed', severity, title, detail: null, data: null, fingerprint: `fp${incidentId ?? k}`, incidentId }));
  const health = {
    checkedAt: iso(40_000),
    services: SERVICES.map(([id, name, up]) => ({ id, name, ok: true, detail: `${name} answering`, since: new Date(now - up).toISOString() })),
    machine: clear ? { load1: 6.4, load5: 6.1, cores: 24, memUsedGb: 24, memTotalGb: 64, diskUsedPct: 79, diskFreeGb: 205 } : { load1: 49.1, load5: 47.2, cores: 24, memUsedGb: 41, memTotalGb: 64, diskUsedPct: 83, diskFreeGb: 154 },
  };
  return { data: { updatedAt: now, error: null, summary: null, health, incidents, jobs, runs, recentEvents, capacity: null }, detail };
}

/** The fixture's own ledger: the page's commands change it, as the desk's would. */
export function createSystemFixture(now = Date.now(), options = {}) {
  let { data, detail } = systemFixture(now, options);
  const find = (id) => data.jobs.find((j) => j.id === id);
  return {
    read: () => data,
    job(id) {
      const job = find(id);
      if (!job) return null;
      return { job, incidents: data.incidents.filter((i) => i.jobId === id), runs: detail[id]?.runs || [], logTail: detail[id]?.logTail ?? null, logPath: detail[id]?.logPath ?? null };
    },
    command(type, args) {
      const inc = data.incidents.find((i) => i.id === Number(args.incidentId));
      const job = args.jobId ? find(args.jobId) : null;
      const patchInc = (patch) => (data = { ...data, incidents: data.incidents.map((i) => (i.id === inc.id ? { ...i, ...patch } : i)) });
      const patchJob = (patch) => (data = { ...data, jobs: data.jobs.map((j) => (j.id === job.id ? { ...j, ...patch } : j)) });
      if (type.startsWith('incident.')) {
        if (!inc || inc.status === 'resolved') return { ok: false, error: 'that incident is resolved or gone' };
        if (type === 'incident.fix') {
          if (inc.fix && !inc.fix.done) return { ok: true, message: 'A fix is already under way.', outcome: { itemId: inc.fix.itemId, already: true } };
          const itemId = `fixture:fix-${inc.id}`;
          patchInc({ fix: { itemId, at: new Date().toISOString(), via: 'worker', done: false } });
          return { ok: true, message: 'Started a worker on it. It reports to the Tango lead.', outcome: { itemId, via: 'worker' } };
        }
        const status = { 'incident.ack': 'acked', 'incident.mute': 'muted', 'incident.snooze': 'snoozed', 'incident.unack': 'open' }[type];
        patchInc({ status, snoozedUntil: status === 'snoozed' ? args.until || new Date(Date.now() + (Number(args.hours) || 1) * H).toISOString() : null });
        return { ok: true, message: `${inc.title}: ${status}` };
      }
      if (!job) return { ok: false, error: `no job ${args.jobId}` };
      if (type === 'process.stop') {
        data = { ...data, jobs: data.jobs.filter((j) => j.id !== job.id) };
        return { ok: true, message: `Stopped ${job.name}.` };
      }
      if (type === 'job.pause') patchJob({ state: 'paused' });
      else if (type === 'job.resume' || type === 'job.restore') patchJob({ state: 'active', retiredAt: null, retireReason: null, archivePath: null });
      else if (type === 'job.retire') patchJob({ state: 'retired', retiredAt: new Date().toISOString(), retireReason: args.reason || null, archivePath: 'archive/retired/' });
      else if (type === 'job.run') data = { ...data, runs: { ...data.runs, [job.id]: { ...(data.runs[job.id] || { strip: [] }), strip: [...(data.runs[job.id]?.strip || []), 'ok'].slice(-8), summary: 'Run from the desk: ok' } } };
      return { ok: true, message: `${type.slice(4)} ${job.name}` };
    },
  };
}
