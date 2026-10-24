// Account usage above the feed (D-313): one double ring per Claude and Codex account, the week left
// outside in the account's color and the 5-hour window inside. Read from the Capacity snapshot
// (GET /api/desk/capacity, next/capacity.js), which carries the usage monitor's reading per Loom account.
// Settings › Feed › Account usage hides it.

import { html } from '../vendor/preact-htm.js';
import { useCapacity } from './next/capacity.js';

/** Account colors when Loom's accounts.json gives none: the agent palette, in the snapshot's order. */
const FALLBACK = ['var(--a-watson)', 'var(--a-malibu)', 'var(--a-foxtrot)', 'var(--a-victor)', 'var(--a-sierra)', 'var(--a-papa)', 'var(--a-juliet)', 'var(--a-charlie)'];

/** How the remaining share reads: red at a tenth or less, pink at a quarter or less. */
export function usageLevel(left) {
  if (!Number.isFinite(left)) return null;
  return left <= 10 ? 'crit' : left <= 25 ? 'low' : null;
}

/** "Acme (Personal)" → "Acme", unless another account of the same provider would read the same. */
export function ringNames(accounts) {
  const bare = (name) => String(name || '').replace(/\s*\([^)]*\)\s*$/, '').trim() || String(name || '');
  return accounts.map((a) => {
    const short = bare(a.name);
    return accounts.some((b) => b !== a && b.provider === a.provider && bare(b.name) === short) ? a.name : short;
  });
}

/** "12:59p" today, "Thu 2a" within the week, else "Oct 30". */
export function shortReset(iso, now = Date.now()) {
  const at = Date.parse(iso || '');
  if (!Number.isFinite(at)) return null;
  const d = new Date(at);
  const h = d.getHours() % 12 || 12;
  const m = d.getMinutes();
  const time = `${h}${m ? `:${String(m).padStart(2, '0')}` : ''}${d.getHours() < 12 ? 'a' : 'p'}`;
  if (at - now < 20 * 3_600_000 && d.toDateString() === new Date(now).toDateString()) return time;
  if (at - now < 6 * 24 * 3_600_000) return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * The rings by provider, Claude first: [{ provider, label, rings: [{ id, name, color, week, session, reset, read }] }].
 * None at all when no account has a reading (no usage monitor on this desk): a row of empty rings says nothing.
 */
export function usageGroups(data, now = Date.now()) {
  const accounts = data?.accounts || [];
  const names = ringNames(accounts);
  const rings = accounts.map((a, i) => ({
    id: a.id,
    provider: a.provider,
    name: names[i],
    full: a.name,
    color: a.color || FALLBACK[i % FALLBACK.length],
    week: Number.isFinite(a.weekly?.left) ? Math.round(a.weekly.left) : null,
    session: Number.isFinite(a.fiveHour?.left) ? Math.round(a.fiveHour.left) : null,
    reset: shortReset(a.weekly?.resetsAt, now),
    sessionReset: shortReset(a.fiveHour?.resetsAt, now),
    // fresh; stale is an older reading (drawn, dimmed); down or none has nothing to draw.
    read: a.status === 'fresh' ? 'fresh' : a.status === 'stale' ? 'stale' : 'none',
  }));
  if (!rings.some((r) => r.week !== null)) return [];
  return [['claude', 'Claude'], ['codex', 'Codex']]
    .map(([provider, label]) => ({ provider, label, rings: rings.filter((r) => r.provider === provider) }))
    .filter((g) => g.rings.length);
}

const LEVEL_COLOR = { crit: 'var(--danger)', low: '#d9a0a0' };

function Arc({ r, left, color }) {
  const c = 2 * Math.PI * r;
  const stroke = LEVEL_COLOR[usageLevel(left)] || color;
  return html`<circle cx="26" cy="26" r=${r} class="fu-track" />${left > 0 ? html`<circle cx="26" cy="26" r=${r} class="fu-arc" stroke=${stroke} stroke-dasharray=${`${(c * left) / 100} ${c}`} transform="rotate(-90 26 26)" />` : null}`;
}

function Ring({ ring }) {
  const none = ring.read === 'none' || ring.week === null;
  const title = none
    ? `${ring.full}: no reading`
    : `${ring.full}: ${ring.week}% of the week left${ring.reset ? `, resets ${ring.reset}` : ''}${ring.session !== null ? ` · 5-hour ${ring.session}% left${ring.sessionReset ? `, back ${ring.sessionReset}` : ''}` : ''}${ring.read === 'stale' ? ' (older reading)' : ''}`;
  return html`<div class=${`fu-ring${ring.read === 'fresh' ? '' : ' dim'}`} title=${title} aria-label=${title} role="img">
    <svg viewBox="0 0 52 52" aria-hidden="true">
      <${Arc} r=${22} left=${none ? 0 : ring.week} color=${ring.color} />
      ${ring.session !== null ? html`<${Arc} r=${14.5} left=${ring.session} color="var(--fg-2)" />` : null}
      <text x="26" y="30" text-anchor="middle" class="fu-num">${none ? '–' : ring.week}</text>
    </svg>
    <span class="fu-name">${ring.name}</span>
    <span class="fu-reset">${none ? 'no reading' : ring.reset ? `↻ ${ring.reset}` : ''}</span>
  </div>`;
}

/** The rings strip at the top of the feed; nothing until the first snapshot, or when Capacity is unavailable. */
export function FeedUsage({ store }) {
  const capacity = useCapacity(store, 2 * 60_000);
  const groups = usageGroups(capacity?.data, store.state.now);
  if (!groups.length) return null;
  return html`<section class="fusage" aria-label="Account usage">
    <div class="fu-groups">
      ${groups.map((g) => html`<div class="fu-grp" key=${g.provider}><h2 class="fu-prov">${g.label}</h2><div class="fu-row">${g.rings.map((ring) => html`<${Ring} key=${ring.id} ring=${ring} />`)}</div></div>`)}
    </div>
    <p class="fu-key">Outer ring: week left · inner: 5-hour · ↻ weekly reset</p>
  </section>`;
}
