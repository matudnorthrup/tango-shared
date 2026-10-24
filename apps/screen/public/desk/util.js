// Small shared helpers: time, labels, colors, grouping. No DOM, no state.

export const STEPS = ['your_move', 'failed', 'working', 'watching', 'fyi'];

const KNOWN_AGENTS = ['watson', 'malibu', 'foxtrot', 'victor', 'sierra', 'papa', 'juliet', 'charlie', 'loom'];
const PALETTE = ['#5b8def', '#2bb6a3', '#f08a4b', '#b07cf0', '#e5b93b', '#d36b8a', '#4fc3e8', '#8bc34a', '#ef6c57'];

/** `watson-ollama` and `watson` are one agent to the owner. */
export function agentKey(item) {
  if (!item) return '';
  if (item.source === 'loom') return 'loom';
  return String(item.agentId || '').toLowerCase().replace(/-(ollama|classic|test)$/, '');
}

export function agentColor(idOrItem) {
  const id = typeof idOrItem === 'string' ? idOrItem.toLowerCase().replace(/-(ollama|classic|test)$/, '') : agentKey(idOrItem);
  if (KNOWN_AGENTS.includes(id)) return `var(--a-${id})`;
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

/** Where a conversation is, by name: the owner's name for it on the desk (renamed, not Loom), else the source's. */
export function placeName(item) {
  return item?.facts?.name || item?.place || '';
}

export function agentName(item) {
  return item.agentName || (item.source === 'loom' ? 'Loom' : item.agentId || 'Agent');
}

export function initials(name) {
  const clean = String(name || '?').trim();
  return clean.length <= 2 ? clean : clean[0].toUpperCase();
}

/** "4m", "3h", "2d": the card age. */
export function age(ms, now = Date.now()) {
  if (!ms) return '';
  const minutes = Math.floor((now - ms) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function secondsAgo(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

export function clockTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(' ', ' ').toLowerCase();
}

export function shortTime(ms) {
  // "2:05p" for the history rail.
  const d = new Date(ms);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const suffix = h >= 12 ? 'p' : 'a';
  h = h % 12 || 12;
  return `${h}:${m}${suffix}`;
}

export function dayLabel(ms, now = Date.now()) {
  const d = new Date(ms);
  const today = new Date(now);
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

/** A snoozed or parked List row's short "when it's back", in place of its age: "back tomorrow 9:00 am", "when Sierra posts". */
export function wakeLabel(item, now = Date.now()) {
  if (item.disposition === 'parked') return 'parked';
  const at = toMs(item.snoozeUntil);
  // A time beside a trigger is the latest it wakes, and the order the Wakes soonest sort uses.
  if (Number.isFinite(at)) {
    const start = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
    const days = Math.round((start(at) - start(now)) / 86400000);
    const when = new Date(at);
    const day = days <= 0 ? '' : days === 1 ? 'tomorrow ' : days < 7 ? `${when.toLocaleDateString([], { weekday: 'short' }).toLowerCase()} ` : null;
    return day === null ? `back ${when.toLocaleDateString([], { month: 'short', day: 'numeric' }).toLowerCase()}` : `back ${day}${clockTime(at)}`;
  }
  if (item.snoozeTrigger === 'desk') return 'back at my desk';
  if (item.snoozeTrigger === 'agent_posts') return `when ${agentName(item)} posts`;
  return item.snoozeTrigger ? `when ${item.snoozeTrigger.replace(/_/g, ' ')}` : 'snoozed';
}

/** What a project that is away says about itself: "snoozed · back tomorrow 9:00", "parked". */
export function projectAwayLabel(project, now = Date.now()) {
  const away = project?.away;
  if (!away) return '';
  if (away.state === 'parked') return 'parked';
  if (away.until == null && away.trigger === 'agent_posts') return 'snoozed · each back when its agent posts';
  return `snoozed · ${wakeLabel({ disposition: 'snoozed', snoozeUntil: away.until ?? null, snoozeTrigger: away.trigger ?? null }, now)}`;
}

/** When an item counts as stuck: the live activity line hasn't moved for this long. */
export const STUCK_MS = 10 * 60_000;
/** The owner's message with no run started this long after is stalled: Failed on the List (list-model liveState). */
export const STALL_MS = 3 * 60_000;

/**
 * When the owner's message that nothing has taken up was sent, or null: an open item, the owner spoke
 * last, and nothing runs (no turn, no background agents, no job) or waits on them (a request).
 */
export function unansweredSince(item) {
  const f = item?.facts || {};
  if (!['active', 'snoozed', 'parked'].includes(item?.disposition ?? 'active')) return null;
  if (f.lastAuthor !== 'owner' || f.running || f.background || f.job || f.pending) return null;
  // Another agent's mail spoke last: nothing of the owner's waits (desk/status.ts; Codex review on #817).
  if (f.lastAuthorMail) return null;
  return item.lastOwnerMessageAt || null;
}

/** The latest sign of life while working: the activity line, or the running turn's own clock. */
export function lastLifeAt(item) {
  // A message nothing has taken up is the latest sign of life, whatever an older turn's activity line says.
  const sent = unansweredSince(item);
  if (sent) return sent;
  const running = item.facts?.running;
  return Math.max(item.activity?.at || 0, running?.lastAt || 0, running?.since || 0) || item.lastActivityAt || 0;
}

export function stuckMinutes(item, now = Date.now()) {
  if (item.nextStep !== 'working') return 0;
  // Loom is holding it for a known reason (a queued run, disk, limits): it says Waiting, so no "No activity" or Nudge.
  if (item.facts?.held) return 0;
  // A message nothing picked up (no run at all) is stuck sooner, timed from that message, when the List
  // calls it Failed; an older turn's activity line says nothing about it (Codex review on #507).
  const at = lastLifeAt(item);
  if (!at) return 0;
  const idle = now - at;
  return idle >= (unansweredSince(item) ? STALL_MS : STUCK_MS) ? Math.floor(idle / 60000) : 0;
}

export function isNew(item) {
  return item.seen === 'new';
}
export function isFresh(item) {
  return item.seen === 'new' || item.seen === 'updated';
}

/** A background job still running in this conversation (Done must ask about it). `facts.job` only exists while it runs. */
export function runningJob(item) {
  return item?.facts?.job || null;
}

/**
 * What is in flight behind the thread, in the agent's own words: Loom's background tasks and open waits
 * (facts.inFlight), then a running background job (facts.job). Each says what it is doing (`verb`), since
 * when, when a wait gives up (`until`) and a wait's latest failed check (`error`).
 */
export function inFlightOf(item) {
  const f = item?.facts || {};
  const out = (f.inFlight || []).map((e) => ({ ...e, verb: e.kind === 'wait' ? 'Waiting' : e.watcher || e.kind === 'monitor' ? 'Watching' : e.kind === 'agent' ? 'Subagent' : 'Running' }));
  if (f.job) out.push({ kind: 'job', verb: 'Running', text: f.job.label || f.job.id, since: f.job.startedAt ?? null, until: f.job.deadlineAt ?? null });
  return out;
}

/** The row's one fact for it: "waiting: CI on #741 +1". Null while a turn runs (the dot says so) or nothing is in flight. */
export function inFlightFact(item) {
  if (item?.facts?.running) return null;
  const all = inFlightOf(item).filter(entry => !entry.url);
  if (!all.length) return null;
  const first = all[0];
  const text = first.text.length > 40 ? `${first.text.slice(0, 39)}…` : first.text;
  return `${first.verb.toLowerCase()}: ${text}${all.length > 1 ? ` +${all.length - 1}` : ''}`;
}

/** The card's ask: the server's item.ask (a Loom question, the summary's ask, "Watching went quiet…"). */
/**
 * "You asked": the summary's words for it, unless the owner wrote after the summary. A summary is written
 * by a model seconds after new words, so until it lands it describes the request before: the owner's
 * own newest words then (clipped like the summary's).
 */
export function askedOf(item) {
  const s = item?.summary;
  const request = item?.facts?.lastOwnerRequest;
  const words = request?.words !== false ? request?.text?.replace(/\s+/g, ' ').trim() : '';
  // Compared by when the desk filed the request: a late poll files older words after a summary.
  if (words && !(s?.at >= (request.filedAt ?? request.at))) return words.length > 160 ? `${words.slice(0, 159).trimEnd()}…` : words;
  return s?.ownerAsk || null;
}

export function askOf(item) {
  return item?.ask ?? item?.summary?.ask ?? null;
}

/** Answer chips: only options the agent spelled out (item.options; the summary's as a fallback). */
export function optionsOf(item) {
  if (item?.options?.length) return item.options;
  return item?.summary?.options || [];
}

/** The failed turn's message, from facts.failed. */
export function failureText(item) {
  return item?.facts?.failed?.message || (item?.nextStep === 'failed' ? 'The turn failed' : '');
}

/** The live activity line ({ text, at }). */
export function activityText(item) {
  return item?.activity?.text || '';
}

/** A Done whose write-back to the source failed (writeback.outcome). */
export function writebackFailed(item) {
  return item?.writeback?.outcome === 'failed';
}

/** A reply the bot didn't confirm (it timed out): it may have gone out. */
export const DELIVERY_UNKNOWN = 'unknown — may have been delivered';
export function deliveryUnknown(result) {
  return result?.error === DELIVERY_UNKNOWN || result?.outcome?.delivery === 'unknown';
}

/** Snooze times arrive as epoch ms (older payloads: ISO strings). */
export function toMs(value) {
  if (value == null) return null;
  return typeof value === 'number' ? value : Date.parse(value);
}

/** "Waiting on a team member" (a reviewer, someone's feedback): a variant of Watching. */
export function waitingOn(item) {
  const w = item?.watching?.waitingOn;
  return w && w.who ? w : null;
}

/** "2 days", "5 hours": how long a wait has run. */
export function waitAge(since, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - since) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/** A link's kind in plain words, for the links menu and sheet ('' for a plain link). */
export const KIND_WORD = { pr: 'PR', ci: 'CI run', preview: 'preview', prototype: 'page', doc: 'page', file: 'file', link: '' };

export function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function storageGet(key, fallback) {
  try {
    const value = localStorage.getItem('desk.' + key);
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}
export function storageSet(key, value) {
  try {
    if (value == null || value === '') localStorage.removeItem('desk.' + key);
    else localStorage.setItem('desk.' + key, value);
  } catch {
    /* private mode */
  }
}

/** A Date as the value of an <input type="datetime-local"> (local time, minutes). */
export function localInputValue(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Which snooze choice an item is under now (the picker highlights it): a preset's key, 'park',
 * 'custom' for a time no preset matches, or null for an item that isn't snoozed.
 */
export function currentSnoozeKey(item, choices) {
  if (item?.disposition === 'parked') return 'park';
  if (item?.disposition !== 'snoozed') return null;
  if (item.snoozeTrigger) return choices.find((c) => c.args?.trigger === item.snoozeTrigger)?.key ?? null;
  const until = toMs(item.snoozeUntil);
  if (until == null) return null;
  return choices.find((c) => c.args?.until && Date.parse(c.args.until) === until)?.key ?? 'custom';
}

/** The snooze presets' times when the owner hasn't set them (Settings → Snooze times). */
export const DEFAULT_SNOOZE_TIMES = Object.freeze({ morning: '06:00', evening: '18:00' });

/** `{ morning, evening }` as "HH:MM", each falling back to its default when missing or malformed. */
export function snoozeTimesOf(raw) {
  const ok = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  return { morning: ok(raw?.morning) ? raw.morning : DEFAULT_SNOOZE_TIMES.morning, evening: ok(raw?.evening) ? raw.evening : DEFAULT_SNOOZE_TIMES.evening };
}

/** Snooze presets, computed in local time; morning (also Monday's) and evening are the owner's times. */
export function snoozeChoices(now = new Date(), times = DEFAULT_SNOOZE_TIMES) {
  const { morning: morningAt, evening: eveningAt } = snoozeTimesOf(times);
  const at = (date, hhmm) => {
    const d = new Date(date);
    const [h, m] = hhmm.split(':').map(Number);
    d.setHours(h, m, 0, 0);
    return d;
  };
  const soon = new Date(now.getTime() + 2 * 3600_000);
  const evening = at(now, eveningAt);
  if (evening <= now) evening.setDate(evening.getDate() + 1);
  const morning = at(now, morningAt);
  morning.setDate(morning.getDate() + 1);
  const monday = at(now, morningAt);
  monday.setDate(monday.getDate() + (((8 - monday.getDay()) % 7) || 7));
  const fmt = (d) => d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return [
    { key: 'soon', label: 'In 2 hours', hint: soon.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), args: { until: soon.toISOString() } },
    { key: 'evening', label: evening.getDate() === now.getDate() ? 'This evening' : 'Tomorrow evening', hint: fmt(evening), args: { until: evening.toISOString() } },
    { key: 'morning', label: 'Tomorrow morning', hint: fmt(morning), args: { until: morning.toISOString() } },
    { key: 'monday', label: 'Monday', hint: fmt(monday), args: { until: monday.toISOString() } },
    { key: 'desk', label: "I'm at my desk", hint: 'when the desk screen wakes up', args: { trigger: 'desk' } },
    { key: 'agent_posts', label: 'When they post again', hint: 'the next agent message', args: { trigger: 'agent_posts' } },
    { key: 'park', label: 'Park it', hint: 'no date · weekly sweep', type: 'park' },
  ];
}

// ⌘↵ sends from any composer, and so does the keypad's Enter on its own (fn+Return on a laptop
// usually sends it too) while typing in a text box, so on a button or select it keeps its own
// meaning (Codex review on #508). Return by itself stays a newline.
export const isSendKey = (e) =>
  e.key === 'Enter' && (e.metaKey || e.ctrlKey || (e.code === 'NumpadEnter' && e.target?.tagName === 'TEXTAREA'));

/**
 * A text box grows with what's typed, up to its CSS max-height, then scrolls. CSS field-sizing does it where the
 * browser has it; elsewhere (older Safari) this sets the height from the content.
 */
export function fitToContent(el) {
  if (!el || globalThis.CSS?.supports?.('field-sizing', 'content')) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
}

/**
 * The fallback refits when the text rewraps: the box's width changes (a resize or rotation) or its font size does
 * (Settings › Display › Text size sets --scale on the root; the wide-screen breakpoints set --bp). Returns the cleanup.
 */
export function refitOnResize(el) {
  if (!el || globalThis.CSS?.supports?.('field-sizing', 'content') || typeof ResizeObserver !== 'function') return () => {};
  const metrics = () => `${el.clientWidth}|${getComputedStyle(el).fontSize}`;
  let last = metrics();
  const check = () => {
    const now = metrics();
    if (now === last) return;
    last = now;
    fitToContent(el);
  };
  const sized = new ResizeObserver(check);
  sized.observe(el);
  const scaled = typeof MutationObserver === 'function' ? new MutationObserver(check) : null;
  scaled?.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
  // The wide-screen breakpoints in desk.css change --bp (so the font) without touching the root or the box's width.
  globalThis.addEventListener?.('resize', check);
  return () => (sized.disconnect(), scaled?.disconnect(), globalThis.removeEventListener?.('resize', check));
}
