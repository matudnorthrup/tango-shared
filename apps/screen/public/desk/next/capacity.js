// Capacity: what's running, on which account and on which machine. Each account opens to its open
// threads (each with Move once Loom takes the command); This Mac shows what agents hold in memory and
// how full the disk is; the routing rules are read here and edited in Settings › Routing.

import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { age } from '../util.js';
import { threadTitle } from './model.js';

const GB = 2 ** 30;
const gb = (bytes) => `${bytes >= 10 * GB ? Math.round(bytes / GB) : (bytes / GB).toFixed(1)} GB`;

/** "11:59 AM" today, "Thu 1:59 AM" within the week, else the date. */
export function resetLabel(iso, now = Date.now()) {
  const at = Date.parse(iso || '');
  if (!Number.isFinite(at)) return null;
  const d = new Date(at);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (at - now < 20 * 3_600_000 && d.getDate() === new Date(now).getDate()) return time;
  if (at - now < 6 * 24 * 3_600_000) return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** The weekly forecast uses Loom's history and pace, never browser-side extrapolation. */
export function forecastLine(account, now = Date.now()) {
  const f = account.forecast;
  if (!f) return account.forecastReason === 'history' ? 'forecast after 2 h of readings' : null;
  const reset = resetLabel(account.weekly?.resetsAt, now);
  return `~${Math.round(f.projectedAtReset)}% at reset${reset ? ` (${reset})` : ''} · ${Math.round(f.burnPerDay)}%/day${Number.isFinite(account.pace) ? ` · pace ${account.pace.toFixed(1)}` : ''}`;
}

export function forecastTags(account, now = Date.now()) {
  const f = account.forecast;
  if (!f) return [];
  return f.flags.map(flag => flag === 'expires_unused' ? 'expires unused'
    : `runs dry${f.dryAt == null ? '' : f.dryAt <= now ? ' now' : ` ~${resetLabel(new Date(f.dryAt).toISOString(), now)}`}`);
}

/** What the sidebar's Capacity row warns about: a full disk, or a Claude account nearly out for the week. */
export function capacityWarning(data, now = Date.now()) {
  if (!data) return null;
  const disk = data.machine?.disk;
  if (disk && disk.freeBytes / disk.totalBytes < 0.12) return `Disk ${Math.round(100 - (disk.freeBytes / disk.totalBytes) * 100)}%`;
  const dry = data.accounts.find(a => a.forecast?.flags.includes('runs_dry'));
  if (dry) return `${dry.name} ${forecastTags(dry, now).find(tag => tag.startsWith('runs dry'))}`;
  const low = data.accounts.filter((a) => a.provider === 'claude' && a.weekly && a.weekly.left < 15);
  return low.length ? `${low[0].name} ${Math.round(low[0].weekly.left)}%` : null;
}

/** The accounts a thread could move to: the ones it may use, other than its own. */
export function moveTargets(thread, account, accounts) {
  return accounts.filter((a) => a.provider === 'claude' && a.id !== account.id && (!thread.allowed || thread.allowed.includes(a.id)));
}

/**
 * Where a thread Loom holds on account limits could run now (D-42: the owner picks, nothing switches by itself):
 * Claude accounts with room, meaning not under Loom's floor and not resting after a limit, other than its own. Most
 * weekly room first.
 */
export function runOnTargets(itemId, accounts, now = Date.now()) {
  const own = accounts.find((a) => a.threads?.some((t) => t.itemId === itemId))?.id ?? null;
  const resting = (a) => a.coolingUntil && new Date(a.coolingUntil).getTime() > now;
  return accounts
    .filter((a) => a.provider === 'claude' && a.id !== own && a.warning !== 'below_floor' && !resting(a))
    .sort((a, b) => (b.weekly?.left ?? -1) - (a.weekly?.left ?? -1));
}

/** Loads the capacity snapshot while mounted, again every minute. */
export function useCapacity(store, everyMs = 60_000) {
  useEffect(() => {
    void store.loadCapacity();
    const t = setInterval(() => void store.loadCapacity(), everyMs);
    return () => clearInterval(t);
  }, []);
  return store.state.capacity;
}

function Meter({ value, color }) {
  return html`<span class="cap-meter" style=${`--c:${color || 'var(--ok)'}`} aria-hidden="true"><i style=${`width:${Math.max(0, Math.min(100, value))}%`}></i></span>`;
}

function Window({ w, now, forecast }) {
  if (!w) return html`<div class="cap-w none">—</div>`;
  const reset = resetLabel(w.resetsAt, now);
  return html`<div class="cap-w"><div class="top"><b>${Math.round(w.left)}%</b>${reset ? html`<span>↺ ${reset}</span>` : null}</div><${Meter} value=${w.left} color=${w.color} />${forecast ? html`<small>${forecast}</small>` : null}</div>`;
}

function ThreadLine({ store, thread, account, data, now }) {
  const [open, setOpen] = useState(false);
  const item = store.state.byId?.[thread.itemId];
  const targets = moveTargets(thread, account, data.accounts);
  return html`<div class="cap-tr">
    <span class=${`cap-sd${thread.running ? ' run' : ''}`} title=${thread.running ? 'Running' : 'Idle'}></span>
    <button class="cap-ti" onClick=${() => store.nextOpen(thread.itemId)}>${item ? threadTitle(item) : thread.title}</button>
    <span class="cap-rp">${thread.repo || ''}${thread.allowedFrom === 'pinned' ? html`<span class="cap-tag">pinned</span>` : null}</span>
    <span class="cap-ag">${thread.pending ? html`<span class="cap-tag" title="Loom moves it once the turn in progress ends">moving</span>` : age(thread.lastActiveAt, now)}</span>
    <span class="cap-mvw">
      <button class="cap-mv" aria-haspopup="menu" aria-expanded=${open} onClick=${() => setOpen(!open)}>Move ▾</button>
      ${open
        ? html`<div class="cap-pop" role="menu" onMouseLeave=${() => setOpen(false)}>
            ${targets.length
              ? html`<div class="h">Move to</div>
                  ${targets.map((a) => html`<button role="menuitem" class="cap-mi" disabled=${!data.moves} onClick=${() => (setOpen(false), store.moveThread(thread.itemId, a.id))}><span class="nx-dot" style=${`--c:${a.color || 'var(--muted)'}`}></span>${a.name}<span class="end">${a.weekly ? `${Math.round(a.weekly.left)}% week` : ''}</span></button>`)}
                  <p class="p">${data.moves ? `Same conversation${thread.running ? ', after the current turn' : ''}.` : 'Loom isn’t taking moves right now.'}</p>`
              : html`<div class="h">Can’t move</div><p class="p">${thread.repo || 'This thread'} may only use ${account.name}.</p>`}
            <button class="cap-mi link" onClick=${() => (setOpen(false), store.openSettings('routing'))}>Edit routing rules →</button>
          </div>`
        : null}
    </span>
  </div>`;
}

/** Loom rests an account after it hits a limit: "resting until 2:00 PM". */
function coolingTag(until, now) {
  const at = typeof until === 'number' ? until : Date.parse(until || '');
  if (!Number.isFinite(at) || at <= now) return null;
  return html`<span class="cap-tag warn" title="Loom won't start or move threads onto it until then">resting until ${resetLabel(new Date(at).toISOString(), now)}</span>`;
}

function AccountRow({ store, account, data, now, open, onToggle }) {
  const [all, setAll] = useState(false);
  const color = account.color || 'var(--muted)';
  const rules = data.rules.repos.filter((r) => r.accounts.includes(account.id)).map((r) => r.repo);
  if (data.rules.default.includes(account.id)) rules.push('everything else');
  const idle = account.threads.filter((t) => !t.running);
  const shown = all ? account.threads : [...account.threads.filter((t) => t.running), ...idle.slice(0, account.running ? 2 : 3)];
  const claude = account.provider === 'claude';
  const busiest = claude && account.running >= 4 && account.running === Math.max(...data.accounts.map((a) => a.running));
  return html`<div class=${`cap-acct${open ? ' open' : ''}${claude ? '' : ' static'}`}>
    <button class="cap-head" aria-expanded=${claude ? open : null} disabled=${!claude} onClick=${onToggle}>
      <span class="cap-chev" aria-hidden="true">${claude ? '›' : ''}</span>
      <span class="cap-nm"><b><span class="nx-dot" style=${`--c:${color}`}></span>${account.name}${forecastTags(account, now).map(tag => html`<span class="cap-tag warn">${tag}</span>`)}${busiest ? html`<span class="cap-tag warn">busiest</span>` : null}${coolingTag(account.coolingUntil, now)}${account.warning ? html`<span class="cap-tag warn" title=${`${account.pinned} thread${account.pinned === 1 ? '' : 's'} can run only on this account; Loom keeps ${account.floorPercent ?? 10}% back`}>${account.warning === 'below_floor' ? 'below floor' : 'near floor'}</span>` : null}${account.status === 'stale' ? html`<span class="cap-tag">older reading</span>` : account.status === 'down' || account.status === 'none' ? html`<span class="cap-tag">no reading</span>` : null}</b>
        <small>${claude ? (rules.length ? `Used for ${rules.join(', ')}` : 'No routing rule uses it') : 'Not on Loom yet: Claude threads hand work here'}</small></span>
      <${Window} w=${account.fiveHour && { ...account.fiveHour, color }} now=${now} />
      <${Window} w=${account.weekly && { ...account.weekly, color }} now=${now} forecast=${forecastLine(account, now)} />
      <span class="cap-th">${claude ? html`<b>${account.running}</b>running · ${account.idle} idle` : '—'}</span>
    </button>
    ${open && claude
      ? html`<div class="cap-drawer">
          ${shown.length ? shown.map((t) => html`<${ThreadLine} key=${t.itemId} store=${store} thread=${t} account=${account} data=${data} now=${now} />`) : html`<p class="nx-empty">No open threads.</p>`}
          ${account.threads.length > shown.length ? html`<button class="nx-link cap-more" onClick=${() => setAll(true)}>Show ${account.threads.length - shown.length} more idle</button>` : null}
        </div>`
      : null}
  </div>`;
}

function MachineRows({ machine, now }) {
  const [open, setOpen] = useState(false);
  if (!machine) return html`<p class="nx-empty">No reading of this Mac yet.</p>`;
  const agents = machine.memory.agents;
  const used = agents.reduce((n, a) => n + a.bytes, 0);
  const disk = machine.disk;
  const diskUsed = disk ? 100 - (disk.freeBytes / disk.totalBytes) * 100 : 0;
  return html`
    <div class=${`cap-acct${open ? ' open' : ''}`}>
      <button class="cap-head" aria-expanded=${open} onClick=${() => setOpen(!open)}>
        <span class="cap-chev" aria-hidden="true">›</span>
        <span class="cap-nm"><b>Memory</b><small>${agents.map((a) => `${a.name}: ${a.processes}`).join(' · ') || 'No agent processes'}</small></span>
        <span></span>
        <div class="cap-w"><div class="top"><b>${gb(used)}</b><span>of ${gb(machine.memory.totalBytes)}</span></div><${Meter} value=${(used / machine.memory.totalBytes) * 100} color="var(--fyi)" /></div>
        <span class="cap-th"><b>${agents.reduce((n, a) => n + a.processes, 0)}</b>processes</span>
      </button>
      ${open
        ? html`<div class="cap-drawer">
            ${agents.map((a) => html`<div class="cap-tr mem"><span></span><span class="cap-ti">${a.name}</span><span class="cap-rp">${a.processes}</span><span class="cap-ag">${gb(a.bytes)}</span></div>`)}
            <p class="note cap-later">Hibernating idle threads and cleaning up worktrees arrive with Loom’s resources view.</p>
          </div>`
        : null}
    </div>
    <div class="cap-acct static">
      <div class="cap-head">
        <span class="cap-chev"></span>
        <span class="cap-nm"><b>Disk${disk && diskUsed > 88 ? html`<span class="cap-tag warn">${gb(disk.freeBytes)} free</span>` : null}</b><small>${machine.worktrees ? `${machine.worktrees.count} Loom worktrees` : 'Worktrees not counted'}</small></span>
        <span></span>
        ${disk ? html`<div class="cap-w"><div class="top"><b>${gb(disk.totalBytes - disk.freeBytes)}</b><span>of ${gb(disk.totalBytes)}</span></div><${Meter} value=${diskUsed} color=${diskUsed > 88 ? 'var(--move)' : 'var(--fyi)'} /></div>` : html`<div class="cap-w none">—</div>`}
        <span class="cap-th">${disk ? html`<b>${Math.round(diskUsed)}%</b>used` : ''}</span>
      </div>
    </div>
    <p class="note cap-measured">Measured ${now - machine.at < 60_000 ? 'just now' : `${age(machine.at, now)} ago`}.</p>`;
}

/** `embedded`: inside the System page's Capacity tab (next/system.js), under its title. */
export function CapacityPage({ store, embedded = false }) {
  const cap = useCapacity(store);
  const [open, setOpen] = useState({});
  const data = cap?.data;
  const now = store.state.now || Date.now();
  if (!data) return html`<div class=${embedded ? 'cap sys-cap' : 'nx-col'}>${embedded ? null : html`<h1 class="nx-h1">Capacity</h1>`}<p class=${cap?.error ? 'warn' : 'nx-empty'}>${cap?.error ? `Can’t read capacity: ${cap.error}` : 'Loading…'}</p></div>`;
  const claude = data.accounts.filter((a) => a.provider === 'claude');
  const codex = data.accounts.filter((a) => a.provider === 'codex');
  const running = claude.reduce((n, a) => n + a.running, 0);
  const weekly = claude.filter((a) => a.weekly);
  const pooled = weekly.length ? Math.round(weekly.reduce((n, a) => n + a.weekly.left, 0) / weekly.length) : null;
  const memory = data.machine ? data.machine.memory.agents.reduce((n, a) => n + a.bytes, 0) : null;
  const disk = data.machine?.disk;
  const diskLow = disk && disk.freeBytes / disk.totalBytes < 0.12;
  // The busiest account starts open: it's the one worth looking into.
  const busiest = [...claude].sort((a, b) => b.running - a.running)[0];
  const isOpen = (id) => open[id] ?? (id === busiest?.id && busiest.running > 0);
  const toggle = (id) => setOpen({ ...open, [id]: !isOpen(id) });
  const name = (id) => data.accounts.find((a) => a.id === id)?.name || id;
  return html`<div class=${embedded ? 'cap sys-cap' : 'nx-col cap'}>
    ${embedded ? null : html`<h1 class="nx-h1">Capacity</h1>`}
    <p class="cap-lede">What's running, on which account and which machine.${data.loom ? '' : ' Loom isn’t answering, so thread counts are missing.'}</p>
    <div class="cap-sum">
      <div><b>${running}</b><span>threads running</span></div>
      <div><b>${pooled === null ? '—' : `${pooled}%`}</b><span>Claude weekly room left</span></div>
      <div><b>${memory === null ? '—' : gb(memory)}</b><span>memory used by agents</span></div>
      <div class=${diskLow ? 'warn' : ''}><b>${disk ? gb(disk.freeBytes) : '—'}</b><span>disk free${disk ? ` (${Math.round(100 - (disk.freeBytes / disk.totalBytes) * 100)}% used)` : ''}</span></div>
    </div>

    <div class="nx-gh cap-gh">Claude · Loom runs these<span class="sp"></span><span class="cap-hint">Open an account to see its threads</span></div>
    <div class="cap-cols" aria-hidden="true"><span></span><span>Account</span><span>5-hour</span><span>Week</span><span>Threads</span></div>
    ${claude.map((a) => html`<${AccountRow} key=${a.id} store=${store} account=${a} data=${data} now=${now} open=${isOpen(a.id)} onToggle=${() => toggle(a.id)} />`)}

    ${codex.length
      ? html`<div class="nx-gh cap-gh">ChatGPT · Codex</div>
          ${codex.map((a) => html`<${AccountRow} key=${a.id} store=${store} account=${a} data=${data} now=${now} open=${false} onToggle=${() => {}} />`)}`
      : null}

    <div class="nx-gh cap-gh">This Mac</div>
    <${MachineRows} machine=${data.machine} now=${now} />

    <div class="nx-gh cap-gh">Routing<span class="sp"></span><button class="nx-link" onClick=${() => store.openSettings('routing')}>Edit in Settings</button></div>
    ${data.rules.error
      ? html`<p class="warn">The routing file is broken: ${data.rules.error}</p>`
      : html`<div class="cap-rules">
          ${data.rules.repos.map((r) => html`<div class="cap-rule"><span>${r.repo}</span><span class="cap-chips">${r.accounts.map((id) => html`<span class="cap-chip">${name(id)}</span>`)}</span></div>`)}
          <div class="cap-rule"><span>Everything else</span><span class="cap-chips">${data.rules.default.length ? data.rules.default.map((id) => html`<span class="cap-chip">${name(id)}</span>`) : html`<span class="note">Any Claude account</span>`}</span></div>
        </div>`}
  </div>`;
}
