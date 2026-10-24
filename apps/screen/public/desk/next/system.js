// The System page (docs/specs/system-visibility.md "Desk: the System page"): everything that runs without
// someone starting it, from the system ledger (desk/system.ts). A one-line state and a health strip that filters
// the page, then tabs: Overview (critical card, open incidents, held and resolved ones folded, jobs failing or
// late, prompts), Jobs (filter chips, folded groups, run strips; a job opens its own page, System › job),
// Events (the raw stream, repeats folded) and Capacity (the old Capacity page, as it was).
// Every command is optimistic (optimistic.js predictSystem) with a Retry on failure; Ack and Mute offer Undo.

import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { CapacityPage } from './capacity.js';
import { Tile } from './rows.js';
import { SYSTEM_TABS } from './model.js';
import {
  HEALTH_WORDS,
  RUNNERS,
  SEVERITY_CLASS,
  ago,
  clock,
  countLabel,
  dayWord,
  duration,
  foldEvents,
  inWords,
  incidentMatchesCell,
  isFailing,
  isCritical,
  isHeld,
  isOpen,
  isService,
  jobGroups,
  jobHealth,
  jobIncident,
  jobMatchesCell,
  jobNote,
  lede,
  ms,
  nextWords,
  procCount,
  runnerName,
  stripCells,
  unmanagedOf,
  upFor,
  usedWords,
  weight,
} from './system-model.js';

const OPEN_LIMIT = 5;

const svg = (d, vb = '0 0 16 16') => html`<svg viewBox=${vb} aria-hidden="true">${d}</svg>`;
export const SYSTEM_ICON = svg(html`<path d="M1.5 8.5h2.8l1.6-4 2.6 8 1.8-5 1 1H14.5"/>`);
const I = {
  check: svg(html`<path d="m3 8.5 3.2 3.2L13 4.8"/>`),
  eye: svg(html`<path d="M1.6 8s2.4-4.5 6.4-4.5S14.4 8 14.4 8 12 12.5 8 12.5 1.6 8 1.6 8z"/><circle cx="8" cy="8" r="2"/>`),
  filter: svg(html`<path d="M2.5 4h11M4.5 8h7M6.5 12h3"/>`),
  chev: html`<svg class="nx-chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>`,
};
const trim = (t, n = 46) => (t.length > n ? `${t.slice(0, n - 2)}…` : t);

/** Reads the ledger while mounted, again every 30 s (and on the stream's `system` events, store.js). */
export function useSystem(store, everyMs = 30_000) {
  useEffect(() => {
    void store.loadSystem();
    const t = setInterval(() => void store.loadSystem(), everyMs);
    return () => clearInterval(t);
  }, []);
  return store.state.system;
}

/** Closes a popover on any press outside `ref`. */
function useOutside(open, setOpen, ref) {
  useEffect(() => {
    if (!open) return undefined;
    const fn = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener('pointerdown', fn);
    return () => document.removeEventListener('pointerdown', fn);
  }, [open]);
}

// ── the commands, in the page's words ──────────────────────────────────
function actions(store) {
  const run = (type, args, label, done, undo = null) => store.systemCommand(type, args, { label, done, undo });
  return {
    ack: (i) => run('incident.ack', { incidentId: i.id }, 'Ack', `Acknowledged. “${trim(i.title)}” stays listed, with no more reminders.`, ['incident.unack', { incidentId: i.id }]),
    mute: (i) => run('incident.mute', { incidentId: i.id }, 'Mute', `Muted. “${trim(i.title)}” is still counted, never notified.`, ['incident.unack', { incidentId: i.id }]),
    snooze: (i, until, label) => run('incident.snooze', { incidentId: i.id, until }, 'Snooze', `Snoozed until ${label}. It comes back if it’s still open then.`, ['incident.unack', { incidentId: i.id }]),
    reopen: (i) => run('incident.unack', { incidentId: i.id }, 'Reopen', `Reopened “${trim(i.title)}”.`),
    // A cleanup worker in the Tango project (desk/system-fix.ts); the toast opens its thread.
    fix: (i) => store.systemCommand('incident.fix', { incidentId: i.id }, { label: 'Fix', action: (o) => (o.itemId ? { label: 'Open thread', fn: () => store.nextOpen(o.itemId) } : null) }),
    runNow: (j) => run('job.run', { jobId: j.id }, 'Run now', `Started ${j.name}.`),
    pause: (j) => run('job.pause', { jobId: j.id }, 'Pause', `Paused ${j.name}. It won’t run until you resume it, and a pause never alerts.`, ['job.resume', { jobId: j.id }]),
    resume: (j) => run('job.resume', { jobId: j.id }, 'Resume', `Resumed ${j.name}.`),
    restart: (j) => run('job.restart', { jobId: j.id }, 'Restart', `Restarting ${j.name}.`),
    retire: (j, reason) => run('job.retire', { jobId: j.id, reason }, 'Retire', `Retired ${j.name}. It’s stopped and archived; Restore brings it back.`, ['job.restore', { jobId: j.id }]),
    restore: (j) => run('job.restore', { jobId: j.id }, 'Restore', `Restored ${j.name}. It runs on its schedule again.`),
    away: (hours) => run('mode.away', hours ? { hours } : {}, 'Away', hours ? `Away for ${hours} h. Big jobs may run; they wait again after that.` : 'Away. Big jobs may run until you say you’re back.', ['mode.working', {}]),
    back: () => run('mode.working', {}, 'Back', 'Back. Big jobs wait until you’re away again.'),
    stop: (u) => run('process.stop', { jobId: u.id }, 'Stop', `Stopped ${u.name}. Load settles in a minute or two.`),
  };
}

// ── the head and the health strip ──────────────────────────────────────
/** The Mac's big-job switch: away lets the night backup, media sync and disk sweeps run; working holds them. */
function AwaySwitch({ store, data }) {
  const m = data.workMode;
  if (!m) return null;
  const act = actions(store);
  const away = m.mode === 'away';
  const left = !away || m.minutesLeft == null ? '' : m.minutesLeft >= 90 ? ` · ${Math.round(m.minutesLeft / 60)} h left` : ` · ${m.minutesLeft} min left`;
  return html`<div class="sys-away">
    <span class=${`sys-away-state${away ? ' on' : ''}`}>${away ? `Away${m.source === 'schedule' ? ' (scheduled)' : ''}${left}` : 'Working'}</span>
    ${away
      ? html`<button class="nx-link" onClick=${() => act.back()}>I’m back</button>`
      : html`<button class="nx-link" onClick=${() => act.away(null)}>I’m away</button><button class="nx-link" onClick=${() => act.away(8)}>Away 8 h</button>`}
  </div>`;
}

function Head({ data, now, store }) {
  const l = lede(data);
  const checked = data.health?.checkedAt ? ago(data.health.checkedAt, now).replace(' ago', '') : null;
  let line;
  if (data.error && !data.jobs.length) line = html`No reading from the system ledger: ${data.error}`;
  else if (l.clear) line = html`<span class="ok">${I.check}</span>All clear. ${l.fine} jobs ran as expected and nothing needs you.${l.held ? ` ${l.held} held incident${l.held === 1 ? '' : 's'} stay quiet.` : ''}`;
  else
    line = html`${l.crit ? html`<b class="crit">${l.crit} critical problem${l.crit === 1 ? '' : 's'} need${l.crit === 1 ? 's' : ''} you</b>${l.open ? `, and ${l.open} more ${l.open === 1 ? 'is' : 'are'} open.` : '.'}` : `${l.open} problem${l.open === 1 ? '' : 's'} open, none critical.`} The other ${l.fine} jobs ran as expected.`;
  return html`<div class="sys-head"><h1 class="nx-h1">System</h1>${checked ? html`<span class="sys-checked">Checked ${checked === 'now' ? 'just now' : `${checked} ago`}</span>` : null}</div>
    <${AwaySwitch} store=${store} data=${data} />
    <p class="sys-lede">${line}</p>`;
}

const cellCls = (s) => (s === 'ok' ? '' : s === 'warn' ? 'warn' : s === 'down' ? 'bad' : 'unk');

function HealthStrip({ data, now, cell, onPick }) {
  const strip = stripCells(data.health, now);
  if (!strip) return html`<section class="sys-strip none" aria-label="Health"><p class="nx-empty">No health reading yet. The system tick writes one every minute.</p></section>`;
  return html`<section class="sys-strip" aria-label="Health">
    <div class="sys-svcs" style=${`--n:${Math.max(1, strip.services.length)}`}>
      ${strip.services.map(
        (s) => html`<button class="sys-svc" aria-pressed=${cell === s.id} title=${s.detail} aria-label=${`${s.name}: ${s.state === 'ok' ? 'up' : 'down'}, ${s.detail}. ${cell === s.id ? 'Showing only what’s behind it; tap to show everything.' : 'Show only its jobs and incidents.'}`} onClick=${() => onPick(s.id)}>
          <span class="n"><span class=${`sys-sd ${cellCls(s.state)}`}></span>${s.name}</span><span class="s">${s.sub}</span>
        </button>`,
      )}
    </div>
    <div class="sys-mach">
      ${strip.machine.map((m) => {
        const color = m.state === 'warn' ? 'var(--move)' : m.state === 'down' ? 'var(--danger)' : 'var(--fyi)';
        return html`<button class=${`sys-svc m ${cellCls(m.state)}`} aria-pressed=${cell === m.id} title=${m.detail} aria-label=${`${m.name}: ${m.value}, ${m.detail}. ${cell === m.id ? 'Tap to show everything.' : 'Show what’s behind it.'}`} onClick=${() => onPick(m.id)}>
          <span class="n"><span class="l"><span class=${`sys-sd ${cellCls(m.state)}`}></span>${m.name}</span><b>${m.value}</b></span>
          <span class="cap-meter" style=${`--c:${color}`} aria-hidden="true"><i style=${`width:${Math.max(0, Math.min(100, m.pct))}%`}></i></span>
          <span class="s">${m.sub}</span>
        </button>`;
      })}
    </div>
  </section>`;
}

function cellName(data, id) {
  return { load: 'Load', memory: 'Memory', disk: 'Disk' }[id] || data.health?.services?.find((s) => s.id === id)?.name || id;
}

function FilterBanner({ data, cell, onClear }) {
  const jobs = data.jobs.filter((j) => j.managed && j.state !== 'retired' && jobMatchesCell(j, cell)).length;
  const incs = data.incidents.filter((i) => i.status !== 'resolved' && incidentMatchesCell(i, cell, data.jobs)).length;
  const un = cell === 'load' || cell === 'memory' ? procCount(unmanagedOf(data)) : 0;
  return html`<div class="sys-filter" role="status">
    <span>Showing <b>${cellName(data, cell)}</b>: ${incs} open incident${incs === 1 ? '' : 's'}${jobs ? `, ${jobs} job${jobs === 1 ? '' : 's'}` : ''}${un ? `, ${un} unmanaged process${un === 1 ? '' : 'es'}` : ''}.</span>
    <button class="btn sm" onClick=${onClear}>Show everything</button>
  </div>`;
}

// ── incidents ──────────────────────────────────────────────────────────
function snoozeOptions(inc, job, now) {
  const morning = new Date(now + 24 * 3_600_000);
  morning.setHours(8, 0, 0, 0);
  const opts = [
    ['1 hour', new Date(now + 3_600_000)],
    ['4 hours', new Date(now + 4 * 3_600_000)],
    ['tomorrow morning', morning],
  ];
  const next = ms(job?.nextRunAt);
  if (next && next > now) opts.push(['its next run', new Date(next + 60_000)]);
  return opts;
}

function Snooze({ store, inc, job, now }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useOutside(open, setOpen, ref);
  const act = actions(store);
  return html`<span class="sys-anchor" ref=${ref}><button class="btn sm ghost" aria-haspopup="menu" aria-expanded=${open} aria-label=${`Snooze ${inc.title}`} onClick=${() => setOpen(!open)}>Snooze ▾</button>
    ${open
      ? html`<div class="nx-menu" role="menu">${snoozeOptions(inc, job, now).map(
          ([label, at]) => html`<button class="nx-mi" role="menuitem" onClick=${() => (setOpen(false), act.snooze(inc, at.toISOString(), clock(at, now)))}><span class="nx-mil">For ${label}</span><span class="nx-mih">${clock(at, now)}</span></button>`,
        )}</div>`
      : null}
  </span>`;
}

/** Fix: starts a cleanup worker; while one is under way it reads "Fixing · Open" and opens that thread instead. */
function FixButton({ store, inc }) {
  if (inc.question) {
    const brief = /^decision:(D-\d+)$/.exec(inc.question.requestId || '')?.[1];
    return html`<button class="btn sm" onClick=${() => brief ? store.openDecision(brief) : store.nextOpen(inc.question.itemId)}>${brief ? `Open ${brief}` : 'Open question'}</button>`;
  }
  const fix = inc.fix && !inc.fix.done ? inc.fix : null;
  if (fix && !fix.itemId) return html`<button class="btn sm sys-fix on" disabled aria-busy="true" aria-label=${`Fixing ${inc.title}`}>Fixing…</button>`;
  if (fix) return html`<button class="btn sm sys-fix on" aria-label=${`Open the fix for ${inc.title}`} title="A worker is fixing this. Open its thread." onClick=${() => store.nextOpen(fix.itemId)}>Fixing · Open</button>`;
  return html`<button class="btn sm sys-fix" aria-label=${`Fix ${inc.title}`} title="Start a worker in the Tango project to find the cause and clean it up" onClick=${() => actions(store).fix(inc)}>${inc.fix?.done ? 'Fix again' : 'Fix'}</button>`;
}

function statusPill(i, now) {
  if (i.status === 'resolved') return html`<span class="nx-pill working">Resolved</span>`;
  if (i.status === 'acked') return html`<span class="nx-pill">Acknowledged</span>`;
  if (i.status === 'muted') return html`<span class="nx-pill">Muted</span>`;
  if (i.status === 'snoozed') return html`<span class="nx-pill watching">Snoozed until ${clock(i.snoozedUntil, now)}</span>`;
  const w = weight(i);
  return html`<span class=${`nx-pill ${w === 'critical' ? 'failed' : w === 'quiet' ? '' : 'move'}`}>${w === 'critical' ? 'Critical' : w === 'quiet' ? 'Quiet' : 'Open'}</span>`;
}

function IncidentRow({ store, ctx, inc, inline = false }) {
  const { data, now, go, setEv, setJobFilter } = ctx;
  const [open, setOpen] = useState(false);
  const job = inc.jobId ? data.jobs.find((j) => j.id === inc.jobId) : null;
  const held = isHeld(inc);
  const res = inc.status === 'resolved';
  const sev = res ? 'resolved' : held ? 'held' : weight(inc);
  const loadish = !job && /load|cpu/i.test(inc.title) && unmanagedOf(data).length;
  const evs = data.recentEvents.filter((e) => e.incidentId === inc.id).slice(0, 4);
  const act = actions(store);
  const id = `inc-${inc.id}`;
  return html`<div class=${`sys-inc${held ? ' held' : ''}${res ? ' resolved' : ''}`}>
    <button class="sys-inc-main" aria-expanded=${open} aria-controls=${id} onClick=${() => setOpen(!open)}>
      <span class=${`sys-sev ${sev}`} aria-hidden="true"></span>
      <span class="sys-inc-b">
        <span class="sys-inc-t">${inc.title}</span>
        ${inc.question ? html`<span class="sys-inc-m">${inc.question.text} · Over 6 hours of your active time. Raised once.</span>` : null}
        <span class="sys-inc-m">
          ${isOpen(inc) && !inline ? null : statusPill(inc, now)}
          ${inc.regressed && !res ? html`<span class="sys-tag back">came back</span>` : null}
          ${inc.flapping && !res ? html`<span class="sys-tag flap">flapping</span>` : null}
          <span class="f">${countLabel(inc, now)} · ${res ? `resolved ${clock(inc.resolvedAt, now)}` : `last ${ago(inc.lastSeen, now)}`}</span>
          ${inline ? null : job ? html`<span class="f job">${job.name}</span>` : loadish ? html`<span class="f job">${procCount(unmanagedOf(data))} unmanaged processes</span>` : null}
        </span>
      </span>
    </button>
    ${res
      ? html`<span></span>`
      : html`<span class="sys-acts">
          ${held
            ? html`<button class="btn sm" aria-label=${`Reopen ${inc.title}`} onClick=${() => act.reopen(inc)}>Reopen</button>
                <${FixButton} store=${store} inc=${inc} />`
            : html`<button class="btn sm" aria-label=${`Acknowledge ${inc.title}`} onClick=${() => act.ack(inc)}>Ack</button>
                <button class="btn sm ghost" aria-label=${`Mute ${inc.title}`} onClick=${() => act.mute(inc)}>Mute</button>
                <${Snooze} store=${store} inc=${inc} job=${job} now=${now} />
                <${FixButton} store=${store} inc=${inc} />`}
        </span>`}
    ${open
      ? html`<div class="sys-inc-d" id=${id}>
          ${inc.flapping && !res ? html`<p><span class="sys-tag flap">flapping</span> It opened and cleared ${inc.reopenCount} times recently, so it’s held as one incident until it stays clear for an hour.</p>` : null}
          ${inc.regressed && !res ? html`<p><span class="sys-tag back">came back</span> The same problem resolved within the last week, then failed again.</p>` : null}
          <dl class="nx-details">
            <dt>First seen</dt><dd>${clock(inc.firstSeen, now)}</dd>
            <dt>Last seen</dt><dd>${clock(inc.lastSeen, now)} (${ago(inc.lastSeen, now)})</dd>
            <dt>Count</dt><dd>${inc.count.toLocaleString('en-US')}×</dd>
            <dt>Job</dt><dd>${job
              ? html`<button class="sys-mlink" onClick=${() => go({ page: 'system', id: job.id })}>${job.name}</button> · ${runnerName(job.runner)}${job.owner ? ` · ${job.owner}` : ''}`
              : loadish
                ? html`<button class="sys-mlink" onClick=${() => (setJobFilter('unmanaged'), go({ page: 'system', view: 'jobs' }))}>Unmanaged processes</button>`
                : 'This machine'}</dd>
            <dt>Told you</dt><dd>${inc.notifiedAt ? clock(inc.notifiedAt, now) : weight(inc) === 'quiet' ? 'Quiet: only shown here' : 'Not yet'}</dd>
            ${res ? null : html`<dt>Next</dt><dd>${inc.question ? 'Waiting for your answer on the original question. No repeat reminder.' : nextWords(inc)}</dd>`}
            ${inc.fix ? html`<dt>Fix</dt><dd>${inc.fix.done ? 'Finished' : 'Under way'} since ${clock(inc.fix.at, now)}${inc.fix.itemId ? html` · <button class="sys-mlink" onClick=${() => store.nextOpen(inc.fix.itemId)}>Open thread</button>` : null}</dd>` : null}
            <dt>Fingerprint</dt><dd><code>${inc.fingerprint.slice(0, 12)}</code></dd>
          </dl>
          ${evs.length ? html`<ul class="sys-mini" aria-label="Latest events">${evs.map((e) => html`<li key=${e.id}><time>${clock(e.at, now).replace(/^\w{3} /, '')}</time><span>${e.title}</span></li>`)}</ul>` : null}
          <div class="links">
            ${job ? html`<button class="nx-link" onClick=${() => go({ page: 'system', id: job.id })}>Open ${job.name}</button>` : null}
            <button class="nx-link" onClick=${() => (setEv({ sev: 'all', src: 'all', job: inc.jobId || null }), go({ page: 'system', view: 'events' }))}>Its events</button>
          </div>
        </div>`
      : null}
  </div>`;
}

function Collapsible({ title, count, sum, sumCls, children }) {
  const [open, setOpen] = useState(false);
  return html`<section class=${`sys-grp${open ? '' : ' shut'}`}>
    <h3 class="nx-gh"><button aria-expanded=${open} onClick=${() => setOpen(!open)}>${I.chev}${title}<span class="n">${count}</span><span class="sp"></span>${sum ? html`<span class=${`sum ${sumCls || ''}`}>${sum}</span>` : null}</button></h3>
    ${open ? children : null}
  </section>`;
}

function Incidents({ store, ctx }) {
  const { data, cell, now } = ctx;
  const [more, setMore] = useState(false);
  // One incident per unmanaged process would bury the rest: they're the Jobs tab's Unmanaged filter (and the prompt below).
  const all = data.incidents.filter((i) => i.kind !== 'process.unmanaged' && incidentMatchesCell(i, cell, data.jobs));
  const crit = all.filter((i) => isOpen(i) && isCritical(i));
  const rank = { normal: 0, quiet: 1 };
  const open = all.filter((i) => isOpen(i) && !isCritical(i)).sort((a, b) => rank[weight(a)] - rank[weight(b)] || (ms(b.lastSeen) ?? 0) - (ms(a.lastSeen) ?? 0));
  const held = all.filter(isHeld);
  const res = all.filter((i) => i.status === 'resolved').sort((a, b) => (ms(b.resolvedAt) ?? 0) - (ms(a.resolvedAt) ?? 0));
  // At most five open ones after the critical card; the rest open in place (owner, 10/18).
  const shown = more ? open : open.slice(0, OPEN_LIMIT);
  return html`<div class="sys-incidents">
    ${crit.length
      ? html`<section class="rd-needs failed sys-crit" aria-label="Critical incidents"><div class="h4">Critical · ${crit.length} open</div>${crit.map((i) => html`<${IncidentRow} key=${i.id} store=${store} ctx=${ctx} inc=${i} />`)}</section>`
      : null}
    ${open.length
      ? html`<h3 class="nx-gh"><span class="nx-gdot needs"></span>Open<span class="n">${open.length}</span></h3>
          <div class="sys-incs">${shown.map((i) => html`<${IncidentRow} key=${i.id} store=${store} ctx=${ctx} inc=${i} />`)}</div>
          ${open.length > shown.length ? html`<button class="nx-link sys-more" onClick=${() => setMore(true)}>Show ${open.length - shown.length} more open</button>` : null}`
      : null}
    ${!crit.length && !open.length
      ? html`<div class="sys-none">${I.check}<div><b>No open incidents${cell ? ` for ${cellName(data, cell)}` : ''}.</b>${res[0] ? `The last one, “${res[0].title}”, resolved ${clock(res[0].resolvedAt, now)}.` : 'Nothing has gone wrong this week.'}</div></div>`
      : null}
    ${held.length ? html`<${Collapsible} title="Acknowledged, muted or snoozed" count=${held.length} sum="no reminders"><div class="sys-incs">${held.map((i) => html`<${IncidentRow} key=${i.id} store=${store} ctx=${ctx} inc=${i} />`)}</div><//>` : null}
    ${res.length ? html`<${Collapsible} title="Resolved this week" count=${res.length} sum=${`last ${clock(res[0].resolvedAt, now)}`} sumCls="ok"><div class="sys-incs">${res.map((i) => html`<${IncidentRow} key=${i.id} store=${store} ctx=${ctx} inc=${i} />`)}</div><//>` : null}
  </div>`;
}

// ── jobs ───────────────────────────────────────────────────────────────
function RunStrip({ strip = [] }) {
  const cells = [...Array(Math.max(0, 8 - strip.length)).fill('-'), ...strip.slice(-8)];
  const ok = cells.filter((x) => x === 'ok').length;
  const q = cells.filter((x) => x === 'quiet').length;
  const f = cells.filter((x) => x === 'failed').length;
  const label = cells.every((x) => x === '-') ? 'No runs recorded' : `Last ${cells.filter((x) => x !== '-').length} runs: ${ok} ok, ${q} quiet, ${f} failed`;
  return html`<span class="sys-runs" role="img" aria-label=${label} title=${label}>${cells.map((x, k) => html`<i key=${k} class=${{ ok: '', quiet: 'q', failed: 'f', running: 'r', '-': 'n' }[x] ?? ''}></i>`)}</span>`;
}

function OwnerTile({ store, owner, size = 16 }) {
  if (!owner) return null;
  const agent = (store.state.agents || []).find((a) => a.id === owner);
  return agent ? html`<${Tile} tile=${{ kind: 'agent', id: owner, name: agent.name || owner }} store=${store} size=${size} />` : null;
}

function JobRow({ store, ctx, job, showOwner = true }) {
  const { data, now, go } = ctx;
  const health = jobHealth(job, data.incidents);
  const runs = data.runs[job.id];
  const running = runs?.strip?.at(-1) === 'running' || job.lastStatus === 'running';
  const svc = isService(job);
  const bad = isFailing(health);
  const late = health === 'late';
  const problem = bad || late || health === 'degraded';
  const note = jobNote(job, runs, data.incidents);
  const used = usedWords(job, now);
  const up = upFor(job.facts?.startedAt ?? job.facts?.since, now);
  const lastWords = svc ? (health === 'dead' ? 'restarting' : up ? `up ${up}` : 'up') : job.lastRunAt ? ago(job.lastRunAt, now) : 'never';
  const nextWordsJ = job.state === 'paused' ? 'paused' : svc ? '—' : job.nextRunAt ? inWords(job.nextRunAt, now) : health === 'dead' ? 'won’t run' : '—';
  return html`<button class="sys-job" onClick=${() => go({ page: 'system', id: job.id, view: ctx.tab })} aria-label=${`${job.name}, ${HEALTH_WORDS[health]}. ${runnerName(job.runner)}${job.cadence ? `, ${job.cadence}` : ''}. Open the job.`}>
    <span class=${`sys-hd ${health}`} title=${HEALTH_WORDS[health]} aria-hidden="true"></span>
    <span class="sys-job-b">
      <span class="sys-job-t">${showOwner ? html`<${OwnerTile} store=${store} owner=${job.owner} />` : null}<span class="nm">${job.name}</span>
        ${job.criticality === 'critical' ? html`<span class="sys-tag">critical</span>` : null}
        ${job.state === 'paused' ? html`<span class="sys-tag warn">paused</span>` : null}
        ${running ? html`<span class="sys-tag run">running</span>` : null}
      </span>
      <span class="sys-job-m">
        <span>${runnerName(job.runner)}</span>${job.cadence ? html`<span>${job.cadence}</span>` : null}
        ${problem || !note ? null : html`<span class="grow">${note}</span>`}
        <span class="sys-ph">${svc ? lastWords : `last ${lastWords}`}${!svc && nextWordsJ !== '—' ? ` · next ${nextWordsJ}` : ''}</span>
        ${used ? html`<span class=${`use${used.warn ? ' warn' : ''}`}>${I.eye}${used.text}</span>` : null}
      </span>
      ${problem && note ? html`<span class=${`sys-job-n ${bad ? 'bad' : 'warn'}`}>${note}</span>` : null}
    </span>
    <span class=${`sys-when${late ? ' warn' : svc && health === 'dead' ? ' bad' : ''}`}><small>${svc ? 'status' : 'last run'}</small>${lastWords}</span>
    <span class="sys-when"><small>next</small>${nextWordsJ}</span>
    <${RunStrip} strip=${runs?.strip} />
  </button>`;
}

const JOB_COLS = html`<div class="sys-jcols" aria-hidden="true"><span></span><span>Job</span><span>Last run</span><span>Next</span><span>Last 8</span></div>`;

function JobGroup({ store, ctx, group, list, startOpen }) {
  const [open, setOpen] = useState(startOpen);
  const [more, setMore] = useState(false);
  useEffect(() => setOpen(startOpen), [startOpen]);
  const healthOf = (j) => jobHealth(j, ctx.data.incidents);
  const bad = list.filter((j) => isFailing(healthOf(j))).length;
  const late = list.filter((j) => healthOf(j) === 'late').length;
  const deg = list.filter((j) => healthOf(j) === 'degraded').length;
  const sum = bad ? `${bad} failing${late ? ` · ${late} late` : ''}` : late ? `${late} late` : deg ? `${deg} degraded` : 'all ok';
  const cls = bad ? 'bad' : late || deg ? 'warn' : 'ok';
  const trouble = list.filter((j) => ['failing', 'dead', 'late', 'degraded'].includes(healthOf(j)));
  const shown = more || !trouble.length ? list : trouble;
  // An agent's own group (its name, its jobs) shows its picture.
  const owners = [...new Set(list.map((j) => j.owner))];
  const agentOwner = owners.length === 1 && owners[0] && owners[0].toLowerCase() === group.name.toLowerCase() ? owners[0] : null;
  return html`<section class=${`sys-jgrp${open ? '' : ' shut'}`}>
    <h3 class="nx-gh"><button aria-expanded=${open} onClick=${() => setOpen(!open)}>${I.chev}${agentOwner ? html`<${OwnerTile} store=${store} owner=${agentOwner} />` : null}${group.name}<span class="n">${list.length}</span><span class=${`sum ${cls}`}>${sum}</span></button></h3>
    ${open
      ? html`<div class="sys-jlist">${shown.map((j) => html`<${JobRow} key=${j.id} store=${store} ctx=${ctx} job=${j} showOwner=${!agentOwner} />`)}</div>
          ${shown.length < list.length ? html`<button class="nx-link sys-more" onClick=${() => setMore(true)}>Show ${list.length - shown.length} more in ${group.name}, all fine</button>` : null}`
      : null}
  </section>`;
}

function Menu({ label, value, options, onPick, wide = false }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useOutside(open, setOpen, ref);
  const cur = options.find((o) => o[0] === value);
  const on = value !== 'all' && value != null;
  return html`<div class="nx-filter sys-menu" ref=${ref}>
    <button class=${`nx-fbtn${on ? ' on' : ''}`} aria-haspopup="menu" aria-expanded=${open} aria-label=${`${label}: ${cur ? cur[1] : 'any'}`} onClick=${() => setOpen(!open)}>${I.filter}${on && cur ? (wide ? html`${label}: <b>${cur[1]}</b>` : cur[1]) : label}</button>
    ${open
      ? html`<div class="nx-menu" role="menu">${options.map(
          ([v, l, n]) => html`<button class="nx-mi" role="menuitemradio" aria-checked=${v === value} onClick=${() => (setOpen(false), onPick(v))}><span class="nx-mic">${v === value ? I.check : ''}</span><span class="nx-mil">${l}</span>${n != null ? html`<span class="nx-mih">${n}</span>` : null}</button>`,
        )}</div>`
      : null}
  </div>`;
}

const REASONS = ['Nobody reads it', 'Replaced by something else', 'Finished its purpose', 'Other'];
function RetireConfirm({ store, job, onCancel }) {
  const [why, setWhy] = useState(REASONS[/replac|supersed/i.test(job.retireCandidate || '') ? 1 : /one-off|finished|ended/i.test(job.retireCandidate || '') ? 2 : 0]);
  const what = job.runner === 'schedule' ? 'schedule' : job.runner === 'launchd' ? 'plist' : 'config';
  return html`<div class="sys-confirm" role="group" aria-label=${`Retire ${job.name}`}>
    <p><b>Retire ${job.name}?</b> It stops now and its ${what} moves to the archive. Nothing is deleted: Restore puts it back.</p>
    <div class="sys-reason" role="radiogroup" aria-label="Why">${REASONS.map((r) => html`<button role="radio" aria-checked=${why === r} class=${why === r ? 'on' : ''} onClick=${() => setWhy(r)}>${r}</button>`)}</div>
    <div class="row"><button class="btn sm sys-danger" onClick=${() => (onCancel(), actions(store).retire(job, `${why}.${job.retireCandidate ? ` ${job.retireCandidate}` : ''}`))}>Retire it</button><button class="btn sm ghost" onClick=${onCancel}>Cancel</button></div>
  </div>`;
}

function RetireItem({ store, ctx, job }) {
  const [confirm, setConfirm] = useState(false);
  return html`<div class="sys-ret">
    <${JobRow} store=${store} ctx=${ctx} job=${job} />
    <div class="sys-ret-why">
      <p>${job.retireCandidate}</p>
      <span class="sys-acts"><button class="btn sm sys-danger-ghost" aria-label=${`Retire ${job.name}`} onClick=${() => setConfirm(true)}>Retire…</button></span>
      ${confirm ? html`<${RetireConfirm} store=${store} job=${job} onCancel=${() => setConfirm(false)} />` : null}
    </div>
  </div>`;
}

function UnRow({ store, u }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(false), 3500);
    return () => clearTimeout(t);
  }, [armed]);
  const f = u.facts || {};
  const cpu = Number(f.cpu) || 0;
  const hot = cpu >= 100;
  const count = Number(f.count) || 0;
  const meta = [f.cmd, f.pid != null ? `pid ${f.pid}` : null, f.age ? `up ${f.age}` : null, f.mem, f.parent].filter(Boolean);
  const stop = () => (armed ? (setArmed(false), actions(store).stop(u)) : setArmed(true));
  return html`<div class="sys-un">
    <div>
      <div class="sys-un-t"><span class="nm">${u.name}</span>${count > 1 ? html`<span class="sys-tag">×${count}</span>` : null}${f.port ? html`<span class="port">:${f.port}</span>` : null}${f.cwd_deleted || f.cwdDeleted ? html`<span class="sys-tag crit">folder deleted</span>` : null}</div>
      ${meta.length ? html`<div class="sys-un-m">${meta.map((m) => html`<span>${m}</span>`)}</div>` : null}
      ${f.child ? html`<div class="sys-un-m warn"><span>Child process: ${f.child}</span></div>` : null}
      ${f.cwd ? html`<div class=${`sys-cwd${f.cwd_deleted || f.cwdDeleted ? ' gone' : ''}`}>${f.cwd}</div>` : null}
    </div>
    <div class=${`sys-cpu${hot ? ' hot' : ''}`} aria-label=${`CPU ${cpu} percent`}><span class="cap-meter" style=${`--c:${hot ? 'var(--danger)' : cpu > 20 ? 'var(--move)' : 'var(--fyi)'}`} aria-hidden="true"><i style=${`width:${Math.min(100, cpu / 2.4)}%`}></i></span><b>${Math.round(cpu)}%</b> CPU</div>
    <span class="sys-acts sys-un-acts">
      <button class=${`btn sm${armed ? ' sys-danger' : ''}`} aria-label=${armed ? `Confirm: stop ${u.name}` : `Stop ${u.name}`} onClick=${stop}>${armed ? `Stop ${count > 1 ? `all ${count}` : 'it'}?` : 'Stop'}</button>
    </span>
  </div>`;
}

function Unmanaged({ store, ctx }) {
  const list = unmanagedOf(ctx.data);
  if (!list.length) return html`<div class="sys-none">${I.check}<div><b>Nothing unmanaged is running.</b>Every process listening on a port belongs to a job.</div></div>`;
  const cpu = Math.round(list.reduce((n, u) => n + (Number(u.facts?.cpu) || 0), 0));
  return html`<p class="sys-hint">Processes listening on a port, or re-parented to launchd, that no job owns. Right now: <b>${procCount(list)} processes</b> using about <b>${cpu}% CPU</b>. Stop the ones nobody needs.</p>
    ${list.map((u) => html`<${UnRow} key=${u.id} store=${store} u=${u} />`)}`;
}

function Jobs({ store, ctx }) {
  const { data, cell, jobFilter, setJobFilter, runner, setRunner } = ctx;
  const healthOf = (j) => jobHealth(j, data.incidents);
  const all = data.jobs.filter((j) => j.managed && j.state !== 'retired');
  const scoped = all.filter((j) => jobMatchesCell(j, cell) && (runner === 'all' || j.runner === runner));
  const failing = scoped.filter((j) => isFailing(healthOf(j)));
  const late = scoped.filter((j) => healthOf(j) === 'late');
  const retire = scoped.filter((j) => j.retireCandidate);
  const un = procCount(unmanagedOf(data));
  const pills = [
    ['all', 'All', scoped.length, ''],
    ['failing', 'Failing', failing.length, failing.length ? 'bad' : ''],
    ['late', 'Late', late.length, late.length ? 'hot' : ''],
    ['unmanaged', 'Unmanaged', un, un ? 'hot' : ''],
    ['retire', 'Retire?', retire.length, ''],
  ];
  const retired = data.jobs.filter((j) => j.state === 'retired');
  let body;
  if (jobFilter === 'unmanaged') body = html`<${Unmanaged} store=${store} ctx=${ctx} />`;
  else if (jobFilter === 'retire')
    body = html`<p class="sys-hint">Jobs whose output nobody has used in a month, ones that were replaced, and one-offs that finished. Retire stops it and archives it at once; Restore brings it back.</p>
      ${retire.length ? html`<div class="sys-retlist">${retire.map((j) => html`<${RetireItem} key=${j.id} store=${store} ctx=${ctx} job=${j} />`)}</div>` : html`<div class="sys-none">${I.check}<div><b>Nothing to review.</b>Every job has been used recently.</div></div>`}`;
  else {
    const list = jobFilter === 'failing' ? failing : jobFilter === 'late' ? late : scoped;
    const flat = jobFilter !== 'all' || !!cell || runner !== 'all';
    body = !list.length
      ? html`<div class="sys-none">${I.check}<div><b>${jobFilter === 'failing' ? 'Nothing failing' : jobFilter === 'late' ? 'Nothing late' : 'No jobs here'}${cell ? ` for ${cellName(data, cell)}` : ''}.</b>${jobFilter === 'all' ? (data.error ? data.error : '') : 'Every job ran when it should have.'}</div></div>`
      : html`${JOB_COLS}
          ${flat
            ? html`<div class="sys-jlist">${list.map((j) => html`<${JobRow} key=${j.id} store=${store} ctx=${ctx} job=${j} />`)}</div>`
            : jobGroups(list).map((g) => html`<${JobGroup} key=${g.id} store=${store} ctx=${ctx} group=${g} list=${g.jobs} startOpen=${g.jobs.some((j) => ['failing', 'dead', 'late'].includes(healthOf(j)))} />`)}
          ${flat ? null : html`<p class="sys-hint sys-foldhint">Groups where everything is fine stay folded. Open one to see its jobs.</p>`}`;
  }
  const runners = Object.entries(RUNNERS).map(([id, r]) => [id, r.plural, all.filter((j) => j.runner === id).length]).filter(([, , n]) => n);
  return html`<div class="sys-jobs">
    <div class="sys-jtools">
      <div class="nx-pills" role="tablist" aria-label="Show jobs">
        ${pills.map(([id, label, n, hot]) => html`<button class=${`nx-ptab${jobFilter === id ? ' on' : ''}`} role="tab" aria-selected=${jobFilter === id} onClick=${() => setJobFilter(id)}>${label}<span class=${`n ${hot}`}>${n}</span></button>`)}
      </div>
      ${jobFilter === 'unmanaged' ? null : html`<${Menu} label="Runner" value=${runner} options=${[['all', 'Every runner', all.length], ...runners]} onPick=${(v) => (setRunner(v), jobFilter === 'unmanaged' && setJobFilter('all'))} />`}
    </div>
    ${runner !== 'all' && jobFilter !== 'unmanaged' ? html`<p class="sys-hint">${RUNNERS[runner]?.plural}: ${RUNNERS[runner]?.hint}. <button class="nx-link" onClick=${() => setRunner('all')}>Every runner</button></p>` : null}
    ${body}
    ${retired.length && jobFilter !== 'unmanaged'
      ? html`<${Collapsible} title="Retired" count=${retired.length} sum="archived; Restore brings one back"><div class="sys-jlist">${retired.map(
          (j) => html`<div class="sys-ret" key=${j.id}><${JobRow} store=${store} ctx=${ctx} job=${j} /><div class="sys-ret-why"><p>${j.retireReason || 'Retired from the desk.'}${j.retiredAt ? ` · ${clock(j.retiredAt, ctx.now)}` : ''}</p><span class="sys-acts"><button class="btn sm" onClick=${() => actions(store).restore(j)}>Restore</button></span></div></div>`,
        )}</div><//>`
      : null}
  </div>`;
}

// ── events ─────────────────────────────────────────────────────────────
function Events({ ctx }) {
  const { data, now, ev, setEv, cell, go } = ctx;
  const [unfold, setUnfold] = useState({});
  const evs = data.recentEvents;
  const sevOf = (e) => (e.severity === 'recovery' ? 'info' : e.severity);
  const matchCell = (e) => {
    if (!cell) return true;
    if (e.jobId) {
      const j = data.jobs.find((x) => x.id === e.jobId);
      return j ? jobMatchesCell(j, cell) : false;
    }
    const inc = data.incidents.find((i) => i.id === e.incidentId);
    return inc ? incidentMatchesCell(inc, cell, data.jobs) : false;
  };
  const list = evs.filter((e) => (ev.sev === 'all' || sevOf(e) === ev.sev) && (ev.src === 'all' || e.source === ev.src) && (!ev.job || e.jobId === ev.job) && matchCell(e));
  const rows = foldEvents(list, unfold);
  const sources = [...new Set(evs.map((e) => e.source))];
  const jobsWith = [...new Set(evs.map((e) => e.jobId).filter(Boolean))];
  const nameOf = (id) => data.jobs.find((j) => j.id === id)?.name || id;
  const sevs = [['all', 'All'], ['critical', 'Critical'], ['error', 'Error'], ['warning', 'Warning'], ['info', 'Info']];
  let day = null;
  return html`<div class="sys-events">
    <div class="sys-etools">
      <div class="nx-pills" role="tablist" aria-label="Severity">${sevs.map(([v, l]) => html`<button class=${`nx-ptab${ev.sev === v ? ' on' : ''}`} role="tab" aria-selected=${ev.sev === v} onClick=${() => setEv({ ...ev, sev: v })}>${l}${v === 'all' ? null : html`<span class="n">${evs.filter((e) => sevOf(e) === v).length}</span>`}</button>`)}</div>
      <${Menu} label="Source" wide=${true} value=${ev.src} options=${[['all', 'Every source', evs.length], ...sources.map((s) => [s, s, evs.filter((e) => e.source === s).length])]} onPick=${(v) => setEv({ ...ev, src: v })} />
      <${Menu} label="Job" wide=${true} value=${ev.job || 'all'} options=${[['all', 'Every job', null], ...jobsWith.map((id) => [id, nameOf(id), evs.filter((e) => e.jobId === id).length])]} onPick=${(v) => setEv({ ...ev, job: v === 'all' ? null : v })} />
    </div>
    ${!rows.length ? html`<div class="sys-none">${I.check}<div><b>No events match.</b>${evs.length ? 'Try another filter.' : 'Nothing has happened that needed recording.'}</div></div>` : null}
    ${rows.map(({ event: e, more }) => {
      const d = dayWord(e.at, now);
      const head = d !== day ? ((day = d), html`<div class="sys-day">${d}</div>`) : null;
      // Its job's name in front, unless the title already says it.
      const job = e.jobId ? data.jobs.find((j) => j.id === e.jobId && !e.title.includes(j.name)) : null;
      return html`${head}<div class="sys-ev" key=${e.id}>
        <time>${clock(e.at, now).replace(/^\w{3} /, '')}</time><span class=${`sv ${SEVERITY_CLASS[e.severity] || ''}`} title=${e.severity} aria-label=${e.severity}></span>
        <span class="msg">${job ? html`<button class="job sys-mlink" onClick=${() => go({ page: 'system', id: job.id, view: 'events' })}>${job.name}</button>` : null}${e.title}</span>
        <span class="src">${e.source}</span>
        ${more ? html`<span class="fold"><button onClick=${() => setUnfold({ ...unfold, [e.incidentId]: true })}>+${more} more like this</button>, folded into one incident</span>` : null}
      </div>`;
    })}
    <p class="sys-enote">Skips and ordinary reports aren’t events: they’re in each job’s run history. The newest ${evs.length} events are shown.</p>
  </div>`;
}

// ── a job's page (System › job) ────────────────────────────────────────
function JobPage({ store, ctx, id }) {
  const { data, now } = ctx;
  const entry = store.state.systemJobs[id];
  useEffect(() => {
    void store.loadSystemJob(id);
  }, [id]);
  const [retiring, setRetiring] = useState(false);
  const [allRuns, setAllRuns] = useState(false);
  const logRef = useRef(null);
  // The page's own reading of the job (its state moves with the commands), else the detail's.
  const job = data.jobs.find((j) => j.id === id) || entry?.data?.job;
  if (!job) {
    return html`<div class="nx-col sys-jp"><p class="nx-empty">${entry?.loading || !entry ? 'Loading…' : entry.error === 'gone' ? 'That job isn’t in the ledger any more.' : `Can’t read that job: ${entry.error}`} <button class="nx-link" onClick=${() => store.nextBack()}>Back to System</button></p></div>`;
  }
  const act = actions(store);
  const detail = entry?.data;
  const everyRun = detail?.runs || [];
  // The latest dozen; a job that runs every two minutes has hundreds.
  const runs = allRuns ? everyRun : everyRun.slice(0, 12);
  const health = jobHealth(job, data.incidents);
  const pillCls = { ok: 'working', degraded: 'move', failing: 'failed', dead: 'failed', late: 'move', unknown: '', paused: '', retired: '' }[health];
  const inc = jobIncident(job, data.incidents);
  const svc = isService(job);
  const canRestart = ['launchd', 'tmux', 'docker'].includes(job.runner);
  const used = usedWords(job, now);
  const durations = runs.filter((r) => r.durationMs != null).map((r) => r.durationMs);
  const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
  const maxDur = Math.max(1, ...durations);
  const running = job.lastStatus === 'running' || data.runs[job.id]?.strip?.at(-1) === 'running';
  const restarting = !!job.facts?.restartingAt && now - (ms(job.facts.restartingAt) ?? 0) < 60_000;
  const retired = job.state === 'retired';
  const paused = job.state === 'paused';
  const openLog = () => {
    const el = logRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  };
  const word = (r) => ({ ok: 'Ran', quiet: 'Nothing new', failed: 'Failed', running: 'Running' })[r.status] || r.status;
  return html`<div class="nx-col sys-jp">
    <div class="nx-thead">
      <div class="nx-tt"><h1 class="nx-h1">${job.name}</h1></div>
      <div class="sys-jp-pills">
        <span class=${`nx-pill ${pillCls}`}>${HEALTH_WORDS[health]}</span>
        <span class="nx-tgrey">
          <span>${runnerName(job.runner)}</span>
          ${job.owner ? html`<span><${OwnerTile} store=${store} owner=${job.owner} />${(store.state.agents || []).find((a) => a.id === job.owner)?.name || job.owner}</span>` : job.group ? html`<span>${job.group}</span>` : null}
          <span>${job.criticality === 'critical' ? 'Critical' : job.criticality === 'normal' ? 'Normal' : 'Quiet'}</span>
          ${job.facts?.port ? html`<span>:${job.facts.port}</span>` : null}
        </span>
      </div>
      ${job.facts?.description ? html`<p class="nx-about">${job.facts.description}</p>` : null}
    </div>

    ${paused ? html`<div class="sys-paused" role="status"><p>Paused. It won’t run, and a pause never alerts.</p><button class="btn sm" onClick=${() => act.resume(job)}>Resume</button></div>` : null}
    ${retired ? html`<div class="sys-paused" role="status"><p>Retired${job.retiredAt ? ` ${clock(job.retiredAt, now)}` : ''}: stopped, and its definition archived${job.archivePath ? ` (${job.archivePath})` : ''}.${job.retireReason ? ` ${job.retireReason}` : ''}</p><button class="btn sm" onClick=${() => act.restore(job)}>Restore</button></div>` : null}

    ${inc
      ? html`<section class=${`rd-needs ${isCritical(inc) && isOpen(inc) ? 'failed' : 'your_move'}`} aria-label="Open incident"><div class="h4">${isHeld(inc) ? 'Incident, held' : isCritical(inc) ? 'Critical incident' : 'Open incident'}</div><${IncidentRow} store=${store} ctx=${ctx} inc=${inc} inline=${true} /></section>`
      : null}

    <section class="nx-job">
      <div class="nx-job-h">
        <dl>
          <div><dt>Runs</dt><dd>${job.cadence || '—'}</dd></div>
          <div><dt>${svc ? 'Status' : 'Last run'}</dt><dd>${svc ? (restarting ? 'Restarting…' : health === 'dead' ? 'Down' : `Up${upFor(job.facts?.startedAt ?? job.facts?.since, now) ? ` ${upFor(job.facts?.startedAt ?? job.facts?.since, now)}` : ''}`) : running ? 'Running now' : job.lastRunAt ? ago(job.lastRunAt, now) : 'Not yet'}</dd></div>
          <div><dt>Next run</dt><dd>${paused ? 'Paused' : svc ? '—' : job.nextRunAt ? `${clock(job.nextRunAt, now)} (${inWords(job.nextRunAt, now)})` : '—'}</dd></div>
          ${svc || avg == null ? null : html`<div><dt>Takes</dt><dd>${duration(avg)}</dd></div>`}
          ${used ? html`<div><dt>Last used</dt><dd class=${used.warn ? 'warn' : ''}>${used.text.replace(/^used /, '')}</dd></div>` : null}
        </dl>
      </div>
      <div class="nx-job-acts sys-jacts">
        ${svc ? null : html`<button class="btn sm" disabled=${running || retired} onClick=${() => act.runNow(job)}>${running ? 'Running…' : 'Run now'}</button>`}
        ${canRestart ? html`<button class="btn sm" disabled=${restarting || retired} onClick=${() => act.restart(job)}>${restarting ? 'Restarting…' : 'Restart'}</button>` : null}
        <button class="btn sm ghost" aria-pressed=${paused} disabled=${retired} onClick=${() => (paused ? act.resume(job) : act.pause(job))}>${paused ? 'Resume' : 'Pause'}</button>
        <button class="btn sm ghost" disabled=${!detail?.logTail} onClick=${openLog}>Open log</button>
        <button class="btn sm ghost" disabled=${!inc || inc.status === 'muted'} title=${inc ? '' : 'Nothing open to mute'} onClick=${() => inc && act.mute(inc)}>${inc?.status === 'muted' ? 'Muted' : 'Mute'}</button>
      </div>
      ${runs.length
        ? html`<ol class="nx-runs" aria-label="Run history">${runs.map(
            (r) => html`<li class=${r.status === 'ok' ? 'ok' : r.status} key=${r.id}>
              <span class="dot" aria-hidden="true"></span><b>${word(r)}</b><span class="nt">${r.summary || (r.status === 'quiet' ? 'Nothing to do' : '')}</span>
              <span class="dur"><i style=${`width:${Math.max(3, ((r.durationMs || 0) / maxDur) * 46)}px`}></i><small>${r.status === 'running' ? '…' : duration(r.durationMs)}</small></span>
              <span class="ex">${r.status === 'running' ? 'now' : clock(r.startedAt, now)}${r.exitCode ? ` · exit ${r.exitCode}` : ''}</span>
            </li>`,
          )}</ol>
          ${everyRun.length > runs.length ? html`<button class="nx-link sys-more" onClick=${() => setAllRuns(true)}>Show all ${everyRun.length} runs</button>` : null}`
        : html`<p class="note sys-noruns">${entry?.loading && !detail ? 'Loading its runs…' : 'No runs recorded yet.'}${job.runner === 'launchd' && !entry?.loading ? ' Wrapping it in tango-run gives each run a duration, exit code and output tail.' : ''}</p>`}
    </section>

    <div class="sys-loghead"><h2 class="h4">Log tail</h2>${detail?.logPath ? html`<span class="note">${detail.logPath}</span>` : null}</div>
    ${detail?.logTail
      ? html`<pre class="sys-log" ref=${logRef} tabindex="-1" aria-label="Log tail, secrets redacted">${detail.logTail.split('\n').map((line) => html`<span class=${`ln${/\b(error|fatal|failed|exit [1-9])/i.test(line) ? ' e' : /\bwarn/i.test(line) ? ' w' : ''}`}>${line.split(/(‹redacted›)/).map((x) => (x === '‹redacted›' ? html`<span class="r" title="Redacted">‹redacted›</span>` : x))}</span>`)}</pre>`
      : html`<p class="note">${detail ? (job.logs?.length ? 'Its log can’t be read from here.' : 'No log registered for this job.') : 'Loading…'}</p>`}

    <h2 class="h4">Alerting</h2>
    <div class="sys-alert">
      <span class="sys-seg" role="group" aria-label="Criticality">${['critical', 'normal', 'quiet'].map((c) => html`<span aria-pressed=${job.criticality === c} class=${job.criticality === c ? 'on' : ''}>${c[0].toUpperCase() + c.slice(1)}</span>`)}</span>
      <p>${job.criticality === 'critical' ? 'Alerts your phone on the first failure, then every 4 hours while it stays open.' : job.criticality === 'normal' ? 'One notice after 2 failed runs in a row or when it’s late by 2× its cadence, then one reminder a day.' : 'Shown on this page only. Never notifies.'} Set in the jobs annotations.</p>
    </div>

    <h2 class="h4">Source</h2>
    <div class="sys-src">${job.source ? html`<code>${job.source}</code>` : html`<p class="note">Found by the scan; no definition file.</p>`}</div>

    ${retired
      ? null
      : html`<div class="sys-retire">
          <p>${job.retireCandidate ? html`<b>Suggested for retirement.</b> ${job.retireCandidate}` : used ? `Not used any more? Its output was ${used.text}.` : 'Not used any more?'}</p>
          <button class="btn sm sys-danger-ghost" onClick=${() => setRetiring(true)}>Retire this job…</button>
          ${retiring ? html`<${RetireConfirm} store=${store} job=${job} onCancel=${() => setRetiring(false)} />` : null}
        </div>`}
  </div>`;
}

// ── the overview's pieces ──────────────────────────────────────────────
function Attention({ store, ctx }) {
  const { data, cell } = ctx;
  const list = data.jobs.filter((j) => j.managed && j.state === 'active' && ['failing', 'dead', 'late'].includes(jobHealth(j, data.incidents)) && jobMatchesCell(j, cell));
  if (!list.length) {
    const n = data.jobs.filter((j) => j.managed && j.state !== 'retired').length;
    const runners = new Set(data.jobs.map((j) => j.runner)).size;
    return html`<div class="sys-none">${I.check}<div><b>${cell ? `No failing or late jobs for ${cellName(data, cell)}.` : 'Every job ran when it should have.'}</b>${cell ? '' : `${n} jobs across ${runners} runner${runners === 1 ? '' : 's'}.`}</div></div>`;
  }
  return html`${JOB_COLS}<div class="sys-jlist">${list.map((j) => html`<${JobRow} key=${j.id} store=${store} ctx=${ctx} job=${j} />`)}</div>`;
}

function Nudges({ ctx }) {
  const { data, go, setJobFilter } = ctx;
  const un = unmanagedOf(data);
  const ret = data.jobs.filter((j) => j.managed && j.state !== 'retired' && j.retireCandidate);
  if (!un.length && !ret.length) return null;
  const cpu = Math.round(un.reduce((n, u) => n + (Number(u.facts?.cpu) || 0), 0));
  const gone = un.filter((u) => u.facts?.cwd_deleted || u.facts?.cwdDeleted).length;
  return html`<div class="sys-rows2">
    ${un.length ? html`<div class="sys-unsum"><p><b>${procCount(un)} unmanaged process${procCount(un) === 1 ? '' : 'es'}</b> ${procCount(un) === 1 ? 'is' : 'are'} using about ${cpu}% CPU.${gone ? ` ${gone} run${gone === 1 ? 's' : ''} from a deleted folder.` : ''}</p><button class="btn sm" onClick=${() => (setJobFilter('unmanaged'), go({ page: 'system', view: 'jobs' }))}>Review</button></div>` : null}
    ${ret.length ? html`<div class="sys-unsum"><p><b>${ret.length} job${ret.length === 1 ? '' : 's'}</b> look${ret.length === 1 ? 's' : ''} unused: nobody has used the output in a month, or ${ret.length === 1 ? 'it was' : 'they were'} replaced.</p><button class="btn sm" onClick=${() => (setJobFilter('retire'), go({ page: 'system', view: 'jobs' }))}>Review</button></div>` : null}
  </div>`;
}

function Tabs({ ctx }) {
  const { data, tab, go } = ctx;
  const crit = data.incidents.filter((i) => isOpen(i) && isCritical(i)).length;
  const open = data.incidents.filter((i) => isOpen(i) && i.kind !== 'process.unmanaged').length;
  const today = new Date(ctx.now).toDateString();
  const counts = {
    overview: open || null,
    jobs: data.jobs.filter((j) => j.managed && j.state !== 'retired').length,
    events: data.recentEvents.filter((e) => new Date(ms(e.at)).toDateString() === today).length,
    capacity: data.capacity ? data.capacity.accounts.reduce((n, a) => n + (a.provider === 'claude' ? a.running : 0), 0) : null,
  };
  return html`<div class="nx-pills sys-tabs" role="tablist" aria-label="System sections">
    ${SYSTEM_TABS.map(([id, label]) => {
      const n = counts[id];
      const hot = id === 'overview' ? (crit ? 'crit' : open ? 'hot' : '') : '';
      return html`<button class=${`nx-ptab${tab === id ? ' on' : ''}`} role="tab" aria-selected=${tab === id} aria-label=${`${label}${n != null ? `, ${n}` : ''}${hot === 'crit' ? `, ${crit} critical` : ''}`} onClick=${() => go({ page: 'system', view: id })}>${hot === 'crit' ? html`<span class="sys-sd bad sm" aria-hidden="true"></span>` : null}${label}${n != null ? html`<span class=${`n ${hot === 'crit' ? '' : hot}`}>${n}</span>` : null}</button>`;
    })}
  </div>`;
}

const EMPTY = { updatedAt: 0, error: null, summary: null, health: null, incidents: [], jobs: [], runs: {}, recentEvents: [], capacity: null };

export function SystemPage({ store }) {
  const sys = useSystem(store);
  const route = store.state.nextRoute;
  const now = store.state.now || Date.now();
  const tabs = SYSTEM_TABS.map(([id]) => id);
  const tab = tabs.includes(route.view) ? route.view : 'overview';
  const [cell, setCell] = useState(null);
  const [jobFilter, setJobFilter] = useState('all');
  const [runner, setRunner] = useState('all');
  const [ev, setEv] = useState({ sev: 'all', src: 'all', job: null });
  const go = (r) => store.nextGo(r);
  // Esc on a job's page goes back up to the tab it came from.
  useEffect(() => {
    if (!route.id) return undefined;
    const key = (e) => e.key === 'Escape' && !e.defaultPrevented && document.activeElement?.tagName !== 'INPUT' && store.nextBack();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [route.id]);
  const data = sys?.data || (sys?.error ? { ...EMPTY, error: sys.error } : null);
  if (!data) return html`<div class="nx-col"><h1 class="nx-h1">System</h1><p class="nx-empty">Loading…</p></div>`;
  const ctx = { data, now, tab, cell, go, jobFilter, setJobFilter, runner, setRunner, ev, setEv };
  if (route.id) return html`<${JobPage} store=${store} ctx=${ctx} id=${route.id} />`;
  const pick = (id) => {
    const next = cell === id ? null : id;
    setCell(next);
    if (next && tab === 'capacity') go({ page: 'system', view: next === 'load' || next === 'memory' ? 'jobs' : 'overview' });
    if (next && (next === 'load' || next === 'memory') && unmanagedOf(data).length) setJobFilter('unmanaged');
  };
  const failing = data.jobs.some((j) => j.managed && isFailing(jobHealth(j, data.incidents)));
  return html`<div class="nx-col sys">
    <${Head} data=${data} now=${now} store=${store} />
    <${HealthStrip} data=${data} now=${now} cell=${cell} onPick=${pick} />
    ${cell ? html`<${FilterBanner} data=${data} cell=${cell} onClear=${() => (setCell(null), jobFilter === 'unmanaged' && setJobFilter('all'))} />` : null}
    <${Tabs} ctx=${ctx} />
    ${tab === 'overview'
      ? html`<${Incidents} store=${store} ctx=${ctx} />
          <div class="sys-ov-h"><h2 class="h4">Jobs needing attention</h2><span class="sp"></span><button class="nx-link" onClick=${() => (setJobFilter(failing ? 'failing' : 'all'), go({ page: 'system', view: 'jobs' }))}>All jobs</button></div>
          <${Attention} store=${store} ctx=${ctx} />
          <${Nudges} ctx=${ctx} />`
      : tab === 'jobs'
        ? html`<${Jobs} store=${store} ctx=${ctx} />`
        : tab === 'events'
          ? html`<${Events} ctx=${ctx} />`
          : html`<${CapacityPage} store=${store} embedded=${true} />`}
  </div>`;
}
