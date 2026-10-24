// The System page's reading of the ledger (desk/system.ts → GET /api/desk/system), worked out once, here, so
// the page (next/system.js), the sidebar's System row and the tests read the same thing. Pure: no DOM, no store.

const M = 60_000;
const H = 60 * M;
const D = 24 * H;

export const RUNNERS = {
  schedule: { name: 'Schedule', plural: 'Schedules', hint: 'Tango scheduler, inside the bot' },
  launchd: { name: 'launchd', plural: 'launchd', hint: 'macOS LaunchAgents' },
  tmux: { name: 'tmux', plural: 'tmux windows', hint: 'service windows in the production tmux session' },
  docker: { name: 'Docker', plural: 'Docker', hint: 'containers' },
  routine: { name: 'Claude routine', plural: 'Claude routines', hint: 'scheduled Claude routines' },
  background: { name: 'Background job', plural: 'Background jobs', hint: 'the background_job tool' },
  'loom-wait': { name: 'Loom wait', plural: 'Loom waits', hint: 'loom.wait_for' },
  server: { name: 'Tango Server', plural: 'Tango Server', hint: 'services Tango Server supervises' },
};
export const runnerName = (r) => RUNNERS[r]?.name || r;

export const ms = (iso) => {
  if (iso == null) return null;
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

// ── time words ──
export function ago(at, now = Date.now()) {
  const t = ms(at);
  if (t == null) return 'never';
  const m = Math.round((now - t) / M);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
export function inWords(at, now = Date.now()) {
  const t = ms(at);
  if (t == null) return '—';
  const m = Math.round((t - now) / M);
  if (m <= 1) return 'in 1m';
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}
/** "06:35" today, "Sat 06:35" this week, else "Oct 3". */
export function clock(at, now = Date.now()) {
  const t = ms(at);
  if (t == null) return '—';
  const d = new Date(t);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  const days = Math.floor((end.getTime() - t) / D);
  if (days < 1 && t <= end.getTime()) return time;
  if (days < 6) return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
export function dayWord(at, now = Date.now()) {
  const t = ms(at);
  const d = new Date(t).toDateString();
  if (d === new Date(now).toDateString()) return 'Today';
  if (d === new Date(now - D).toDateString()) return 'Yesterday';
  return new Date(t).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}
export function duration(msTotal) {
  if (msTotal == null) return '—';
  const s = msTotal / 1000;
  if (s < 1) return `${Math.round(msTotal)}ms`;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
  return `${(s / 3600).toFixed(1)}h`;
}
/** "3h 12m" since a time. */
export function upFor(at, now = Date.now()) {
  const t = ms(at);
  if (t == null) return null;
  const m = Math.max(0, Math.round((now - t) / M));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ── incidents ──
export const isOpen = (i) => i.status === 'open';
export const isHeld = (i) => i.status === 'acked' || i.status === 'muted' || i.status === 'snoozed';
/** The page's three weights: critical, normal (error and warning), quiet (info). */
/**
 * Who hears about an incident, as the ledger routes it (@tango/system incidentRoute): critical (Discord and the
 * Inbox's Needs you), normal (the feed) or quiet (this page only). From its severity when a reading has no route.
 */
export const weight = (i) => i.route || (i.severity === 'critical' ? 'critical' : i.severity === 'info' || i.severity === 'recovery' ? 'quiet' : 'normal');
export const isCritical = (i) => weight(i) === 'critical';

export function criticalOpen(data) {
  return (data?.incidents || []).filter((i) => isOpen(i) && isCritical(i));
}

/** "15× · since 00:05" */
export function countLabel(i, now = Date.now()) {
  return `${i.count === 1 ? '1×' : `${i.count.toLocaleString('en-US')}×`} · since ${clock(i.firstSeen, now)}`;
}

export function nextWords(i) {
  if (isHeld(i)) return 'No reminders while it’s held';
  const w = weight(i);
  return w === 'critical' ? 'A reminder every 4 hours while it’s open' : w === 'normal' ? 'One reminder a day while it’s open' : 'Never notifies: shown here only';
}

// ── jobs ──
const ALWAYS = /always|keep ?alive/i;
export const isService = (j) => j.cadenceSeconds == null && ALWAYS.test(j.cadence || '');

/** The incident still open (or held) for a job, if any: the newest. */
export function jobIncident(job, incidents) {
  return (incidents || []).filter((i) => i.jobId === job.id && i.status !== 'resolved').sort((a, b) => (ms(b.lastSeen) ?? 0) - (ms(a.lastSeen) ?? 0))[0] || null;
}

/**
 * A job's health dot: ok, degraded (it runs, but something about it is open), failing, dead (a service that
 * won't stay up), late, unknown (no evidence either way), paused, retired.
 */
export function jobHealth(job, incidents = []) {
  if (job.state === 'retired') return 'retired';
  if (job.state === 'paused') return 'paused';
  const status = job.lastStatus;
  if (status === 'failed') return isService(job) || job.facts?.restarting ? 'dead' : 'failing';
  if (status === 'late') return 'late';
  if (!status && !job.lastRunAt) return isService(job) ? 'ok' : 'unknown';
  if (jobIncident(job, incidents)) return 'degraded';
  return 'ok';
}
export const HEALTH_WORDS = { ok: 'Healthy', degraded: 'Degraded', failing: 'Failing', dead: 'Down', late: 'Late', unknown: 'No evidence either way', paused: 'Paused', retired: 'Retired' };
export const isFailing = (h) => h === 'failing' || h === 'dead';

/** Last used: "opened 3d ago", warn past 30 days. Null when the ledger has no evidence. */
export function usedWords(job, now = Date.now()) {
  const t = ms(job.lastUsedAt);
  if (t == null) return null;
  const days = Math.floor((now - t) / D);
  return { text: days <= 0 ? 'used today' : `used ${days}d ago`, warn: days >= 30, days };
}

/** A job's line under its name: its open incident when it has a problem, else what its last run said. */
export function jobNote(job, runs, incidents) {
  const inc = jobIncident(job, incidents);
  if (inc) return inc.title;
  return runs?.summary || job.facts?.note || '';
}

/** Groups in the ledger's order, each with its jobs (managed, not retired). */
export function jobGroups(jobs) {
  const out = [];
  const by = new Map();
  for (const job of jobs) {
    const key = job.group || 'Other';
    if (!by.has(key)) {
      const g = { id: key, name: key, jobs: [] };
      by.set(key, g);
      out.push(g);
    }
    by.get(key).jobs.push(job);
  }
  return out;
}

// ── the health strip ──
export function stripCells(health, now = Date.now()) {
  if (!health) return null;
  const services = (health.services || []).map((s) => {
    const up = upFor(s.since, now);
    return { id: s.id, name: s.name, state: s.ok ? 'ok' : 'down', sub: s.ok ? (up ? `up ${up}` : 'up') : 'down', detail: s.detail || (s.ok ? 'up' : 'down') };
  });
  const m = health.machine || {};
  const cores = m.cores || 1;
  const load = m.load5 ?? m.load1 ?? 0;
  const memPct = m.memTotalGb ? (m.memUsedGb / m.memTotalGb) * 100 : 0;
  const disk = m.diskUsedPct ?? 0;
  const machine = [
    { id: 'load', name: 'Load', value: load >= 10 ? String(Math.round(load)) : load.toFixed(1), sub: `${cores} cores`, pct: Math.min(100, (load / cores) * 100), state: load > cores * 3 ? 'down' : load > cores * 1.5 ? 'warn' : 'ok', detail: `Load average ${load.toFixed(1)} on ${cores} cores` },
    { id: 'memory', name: 'Memory', value: `${Math.round(m.memUsedGb ?? 0)} GB`, sub: `of ${Math.round(m.memTotalGb ?? 0)}`, pct: memPct, state: memPct > 95 ? 'down' : memPct > 85 ? 'warn' : 'ok', detail: `${Math.round(m.memUsedGb ?? 0)} GB of ${Math.round(m.memTotalGb ?? 0)} GB used` },
    { id: 'disk', name: 'Disk', value: `${Math.round(disk)}%`, sub: `${Math.round(m.diskFreeGb ?? 0)} GB free`, pct: disk, state: disk > 95 ? 'down' : disk > 88 ? 'warn' : 'ok', detail: `${Math.round(m.diskFreeGb ?? 0)} GB free` },
  ];
  return { services, machine, checkedAt: health.checkedAt };
}

// ── the strip's filter: tap a cell, see only what's behind it ──
const MACHINE = new Set(['load', 'memory', 'disk']);
export function jobMatchesCell(job, cell) {
  if (!cell) return true;
  if (MACHINE.has(cell)) return cell === 'disk' ? /log|disk|backup/i.test(`${job.name} ${job.facts?.note || ''}`) : !job.managed;
  const services = job.facts?.services;
  if (Array.isArray(services) && services.includes(cell)) return true;
  if (cell === 'docker') return job.runner === 'docker';
  return job.owner === cell || new RegExp(`\\b${cell}\\b`, 'i').test(job.name);
}
export function incidentMatchesCell(incident, cell, jobs) {
  if (!cell) return true;
  const job = incident.jobId ? jobs.find((j) => j.id === incident.jobId) : null;
  if (job && jobMatchesCell(job, cell)) return true;
  if (MACHINE.has(cell)) return new RegExp(cell === 'memory' ? 'memory|ram' : cell === 'disk' ? 'disk|log' : 'load|cpu', 'i').test(incident.title);
  return new RegExp(`\\b${cell}\\b`, 'i').test(incident.title);
}

// ── the head line ──
export function lede(data) {
  const incidents = data?.incidents || [];
  // As the ledger's own line counts them: quiet incidents live on the page only.
  const crit = incidents.filter((i) => isOpen(i) && isCritical(i)).length;
  const open = incidents.filter((i) => isOpen(i) && weight(i) === 'normal').length;
  const held = incidents.filter(isHeld).length;
  const managed = (data?.jobs || []).filter((j) => j.managed && j.state !== 'retired');
  const bad = managed.filter((j) => ['failing', 'dead', 'late'].includes(jobHealth(j, incidents))).length;
  return { crit, open, held, fine: managed.length - bad, clear: !crit && !open };
}

// ── events: repeats of one incident fold into its newest ──
export function foldEvents(events, unfolded = {}) {
  const seen = new Map();
  const out = [];
  for (const e of events) {
    if (e.incidentId == null || unfolded[e.incidentId]) {
      out.push({ event: e, more: 0 });
      continue;
    }
    const first = seen.get(e.incidentId);
    if (first) first.more += 1;
    else {
      const row = { event: e, more: 0 };
      seen.set(e.incidentId, row);
      out.push(row);
    }
  }
  return out;
}
export const SEVERITY_CLASS = { critical: 'critical', error: 'error', warning: 'warn', info: 'info', recovery: 'info' };

// ── unmanaged processes ──
export function unmanagedOf(data) {
  return (data?.jobs || []).filter((j) => !j.managed);
}
export const procCount = (list) => list.reduce((n, u) => n + (Number(u.facts?.count) || 1), 0);

/** The sidebar's System row: the number of critical incidents open (no chip at zero). */
export function systemChip(data) {
  const n = criticalOpen(data).length;
  return n ? `${n} critical` : null;
}
