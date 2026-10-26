import { doneLabel } from './query-identity.js';
// Optimistic commands: what a desk command does to its item, predicted on the tap so the screen moves
// on at once instead of waiting on the server (TGO-1030). The store keeps each prediction as an overlay
// over the lists and the open Conversation until a refresh that started after the command answered has
// landed (the server's copy then says the same); a failure drops it, so the item snaps back, and the
// toast offers Retry. Pure: no DOM, no store, so it is unit-tested directly.
//
// The desk's default: every tap or click is optimistic. A new command gets a case here (or returns
// undefined when nothing can be predicted, e.g. Undo, whose effect only the server knows). Only the
// voice operator holds a send for an undo window: spoken words can be misheard; a tap is deliberate.

/** The commands predict() can tell: they show their effect at the tap, so no "Sending…" line for them. */
export const PREDICTED = new Set(['run', 'pause', 'role', 'space', 'stop', 'done', 'snooze', 'park', 'reopen', 'pickup', 'seen', 'unseen', 'label', 'rename', 'pin', 'project', 'tag', 'watch', 'reply', 'answer', 'respond', 'approve', 'dismiss', 'retry', 'sweep']);

/**
 * Commands whose effect the server shows later than its answer: the prediction stays until the server's
 * copy says so (or the cap). Stop interrupts the turn; `running` clears when the turn's end comes in.
 */
export const SETTLES_WHEN = { stop: (item) => !item.facts?.running, run: (item) => item.nextStep === 'working' };
// Words to the agent: the server's copy says Sent only once it has filed them (desk/status.ts "sent"). A
// refresh that started before that would put the old Finished or Needs you back on the row the owner just left.
// `before`: the server's copy at the tap.
const filed = (item, before) => (item.lastOwnerMessageAt ?? 0) > (before?.lastOwnerMessageAt ?? 0) || item.status?.pill !== before?.status?.pill;
for (const type of ['reply', 'answer', 'respond', 'approve', 'dismiss', 'retry']) SETTLES_WHEN[type] = filed;

/** The lists an item belongs in, as the server sorts them (desk/view.ts inView). */
export function inList(item, view) {
  const d = item.disposition || 'active';
  if (view === 'active') return d === 'active' && !item.hidden;
  if (view === 'snoozed') return d === 'snoozed' || d === 'parked';
  if (view === 'history') return d === 'done';
  return true; // everything
}

const PASSIVE_SEEN = new Set(['viewed', 'heard', 'briefed', 'post']); // desk/attention.ts
const facts = (item, patch) => ({ ...item, facts: { ...(item.facts || {}), ...patch } });
const OLD_PREFIX = /^(epic|disc|bug|fix|feat|enh|chore|ops|skill|watch|hold):\s*/i;
/** A Loom thread's place is "<project> · <title>": the title part, without a label prefix. */
const titleOf = (place) => String(place || '').split(' · ').slice(1).join(' · ');
const whereOf = (place) => String(place || '').split(' · ')[0];
const isSource = (item) => item.source === 'loom';
// Back to Active and seen, as the server's activeSeen (desk/attention.ts) does for reopen, pickup and sweep.keep.
// Releases a project's hold too: the server sends no `heldBy` once the conversation is back (Codex review on #671).
const back = (item) => ({ ...item, disposition: 'active', seen: 'seen', snoozeUntil: null, snoozeTrigger: null, backFromSnooze: false, doneAt: null, heldBy: null });

/**
 * The status the server gives once it has filed the owner's words and before the turn starts (desk/status.ts
 * "sent"): Sent, not the owner's move, so the row they just left stops asking for them. A request still open
 * on it (another brief, a question a chip didn't answer) keeps the server's status, unless the owner typed words:
 * those reach the agent past every open request (status.ts wroteSince). `answered`: the request id it
 * answers; `pendingAnswered`: it answers the row's own question, whatever its id; `wrote`: typed words.
 */
function starting(item, { answered = null, pendingAnswered = false, wrote = false } = {}) {
  const f = item.facts || {};
  const open = (entry) => !wrote && !!entry && !(answered && entry.requestId === answered);
  const request = (!pendingAnswered && open(f.pending)) || open(f.openBrief) || f.carried?.some((c) => c.counts && open(c.pending));
  // The row shows one brief of several (source-loom.ts openBriefCount): answering it leaves the next one open (Codex review on #988).
  const briefAnswered = [f.pending, f.openBrief].some((entry) => entry?.brief && ((answered && entry.requestId === answered) || (pendingAnswered && entry === f.pending)));
  const moreBriefs = !wrote && briefAnswered && (f.openBriefCount ?? 0) > 1;
  if (!item.status || request || moreBriefs) return item;
  return { ...item, status: { ...item.status, pill: 'working', detail: 'sent', basis: 'owner:last-message', layer: 'active', countsForOwner: false, move: null, live: 'working', unread: false } };
}

/**
 * An active item under its project's hold when that project is away, as the server reads it (core.ts
 * withProjectHold): unless the snooze ran out, the owner wrote since, or it was picked up since.
 */
function projectHold(item, ctx) {
  const projectId = item.facts?.projectId;
  if (!projectId || (item.disposition ?? 'active') !== 'active') return item;
  const project = (ctx.projects || []).find((p) => p.id === projectId);
  const away = project && !project.finishedAt ? project.away : null;
  if (!away) return item;
  const expired = away.state === 'snoozed' && away.until != null && away.until <= Date.now();
  const wroteSince = (item.lastOwnerMessageAt ?? 0) > away.at;
  // Picked up on its own since the project went away: that still stands (Codex review on #671).
  const pickedUpSince = (item.facts?.projectPickedUpAt ?? -1) >= away.at;
  // An agent post since it went away also lets it through, but only the server knows those (any activity isn't one;
  // Codex review on #671): predicted held, a refresh brings it back if the agent did post.
  if (expired || wroteSince || pickedUpSince) return item;
  return { ...item, disposition: away.state, snoozeUntil: away.until ?? null, snoozeTrigger: away.trigger ?? null, heldBy: project.id };
}

/**
 * The item as it will be once `type` with `args` is applied, or undefined when it can't be told
 * (the screen then waits for the server, as before). Mirrors desk/core.ts; the server stays the truth.
 * `ctx.projects`: the owner's projects, for a move into or out of one that is away.
 */
export function predict(type, item, args = {}, ctx = {}) {
  if (!item) return undefined;
  switch (type) {
    case 'mutes':
      return { ...item, filters: args.filters };
    case 'pause':
      // A job's Pause and Resume: its timed runs stop until resumed.
      return item.facts?.schedule ? facts(item, { schedule: { ...item.facts.schedule, paused: args.paused !== false } }) : undefined;
    case 'run':
      // A job's Run now: it's working; the run itself lands from the source (see SETTLES_WHEN).
      return { ...item, nextStep: 'working', lastActivityAt: Date.now() };
    case 'role':
      // Who it works for (roles.ts): the desk shows it as facts.role (and its parent for a worker).
      return facts(item, { role: args.role, ...(args.parentItemId !== undefined ? { parentItemId: args.parentItemId } : {}) });
    case 'keep':
      // "Keep this session": the menu's check follows at once; Loom's thread row confirms it.
      return facts(item, { keepSession: args.keep !== false });
    case 'space':
      // Into an agent's space, or out of it (null).
      return facts(item, { agentSpace: args.agent ? { id: String(args.agent.id).trim().toLowerCase(), name: String(args.agent.name).trim() } : null });
    case 'stop':
      // The turn in progress is interrupted; the thread stays open (its Stop button goes). The server clears
      // `running` later, from the turn's end: see SETTLES_WHEN.
      return facts(item, { running: null });
    // Putting a thread away yourself reads it (desk/attention.ts readIfOwner, #678). Its own state is away now,
    // so a project no longer holds it (no `heldBy`; Codex review on #671).
    case 'done':
      if (doneLabel(item) === 'Clear') return { ...item, seen: 'seen', status: item.status ? { ...item.status, unread: false, ...(item.status.pill === 'finished' ? { pill: 'idle', detail: 'Idle' } : {}) } : item.status };
      return { ...item, disposition: 'done', doneAt: Date.now(), seen: 'seen', snoozeUntil: null, snoozeTrigger: null, backFromSnooze: false, heldBy: null };
    case 'snooze':
      return { ...item, disposition: 'snoozed', snoozeUntil: args.until ?? null, snoozeTrigger: args.trigger ?? null, seen: 'seen', backFromSnooze: false, heldBy: null };
    case 'park':
      return { ...item, disposition: 'parked', snoozeUntil: null, snoozeTrigger: null, seen: 'seen', backFromSnooze: false, heldBy: null };
    case 'pickup':
      // Pick up brings this one back even from an away project (the desk notes it: projectPickedUpAt).
      // Only when the project was what held it; one put away on its own falls back under an away project's hold (Codex review on #671).
      return item.heldBy ? facts(back(item), { projectPickedUpAt: Date.now() }) : projectHold(back(item), ctx);
    case 'reopen':
      // Reopen doesn't: back in rotation, under its project's hold if that project is away (Codex review on #671).
      return projectHold(back(item), ctx);
    case 'seen': {
      // Mark read reads it where it is; a look (viewed, heard…) leaves a put-away one alone; 👀 keeps it in rotation.
      const via = args.via ?? 'explicit';
      if (via === 'read') return { ...item, seen: 'seen', status: item.status ? { ...item.status, unread: false } : item.status, backFromSnooze: false };
      if (PASSIVE_SEEN.has(via)) return { ...item, seen: 'seen', status: item.status ? { ...item.status, unread: false } : item.status, backFromSnooze: false };
      return back(item);
    }
    case 'unseen':
      return { ...item, seen: 'new', status: item.status ? { ...item.status, unread: true } : item.status };
    case 'label': {
      const label = args.label || null;
      if (isSource(item)) return { ...item, place: `${whereOf(item.place)} · ${label ? `${label}: ` : ''}${titleOf(item.place).replace(OLD_PREFIX, '')}` };
      return facts(item, { listLabel: label });
    }
    case 'rename': {
      const title = String(args.title ?? '').replace(/\s+/g, ' ').trim();
      if (isSource(item)) return title ? { ...item, place: `${whereOf(item.place)} · ${title}` } : undefined;
      return facts(item, { name: title || null });
    }
    case 'pin': {
      const next = facts(item, { pinned: !!args.pinned });
      // A pin is a promotion: back to Active from History, Snoozed or Parked. Not when only its project holds it
      // away (`heldBy`): the server's own state is already active, so the project's hold stands (Codex review on #671).
      // Promoted, it may land under its away project's hold (the pin's pickup sets no exemption; Codex review on #671).
      return args.pinned && next.disposition && next.disposition !== 'active' && !item.heldBy ? projectHold(back(next), ctx) : next;
    }
    case 'project': {
      const projectId = args.projectId || null;
      // A new project clears the old one's pickup exemption, as the desk does (Codex review on #671).
      let next = facts(item, projectId !== (item.facts?.projectId ?? null) ? { projectId, projectPickedUpAt: null } : { projectId });
      // Out of the project that held it: its own state (active) shows again; into one that is away, held by it.
      if (item.heldBy) next = { ...next, disposition: 'active', snoozeUntil: null, snoozeTrigger: null, heldBy: null };
      return projectHold(next, ctx);
    }
    case 'tag': {
      const patch = {};
      if ('type' in args) patch.type = args.type || null;
      return facts(item, patch);
    }
    case 'watch': {
      const others = (item.facts?.prWatches || []).filter((w) => String(w.url).toLowerCase() !== String(args.url).toLowerCase());
      const prWatches = args.off ? others : [...others, { url: args.url, at: Date.now(), by: 'screen' }];
      return facts(item, { prWatches: prWatches.length ? prWatches : null });
    }
    case 'respond':
      // A brief the row carries from another thread (desk/asks.ts carryBriefs): answered there, so this row only
      // stops showing it; its own question, if any, stays.
      if (args.requestId && item.facts?.carried?.some((c) => c.pending?.requestId === args.requestId)) {
        const carried = item.facts.carried.filter((c) => c.pending?.requestId !== args.requestId);
        if (item.facts.pending?.requestId !== args.requestId) return facts(item, { carried });
        return { ...facts(item, { carried, pending: null }), nextStep: 'fyi', ask: null, options: [] };
      }
    // falls through
    case 'reply':
    case 'answer':
    case 'approve':
    case 'dismiss':
    case 'retry': {
      // The question is answered (or put away) and the agent is back at work. Acting in a snoozed, parked or
      // finished conversation picks it back up (source.owner_posted → activeSeen; Codex review on #671).
      const now = Date.now();
      let next = { ...back(item), nextStep: 'working', seen: 'seen', lastActivityAt: now };
      // The row shows the owner's words at once, as the server files them on delivery (core.ts reply).
      // An answer chip says its option; a pictures-only reply reads "(2 images)", as the server files it.
      const images = type === 'reply' ? args.attachments?.length || 0 : 0;
      const said = String((type === 'answer' ? args.option : type === 'reply' ? args.text : '') ?? '').trim();
      const text = said || (images ? `(${images} image${images === 1 ? '' : 's'})` : '');
      if (text) next = facts(next, { lastAuthor: 'owner', lastOwnerRequest: { text, at: now, filedAt: now } });
      // An answer chip answers the question it sits on (core.ts answerTarget); a reply leaves one open, but its words
      // are the agent's to answer next: Sent, not Needs you (owner, 10/22). Pictures alone are words too (core.ts reply).
      if (type === 'reply') return starting(next, { wrote: !!text });
      if (type === 'retry') return starting(next);
      if (type === 'answer') return starting(next, { answered: args.requestId ?? item.facts?.pending?.requestId ?? null, pendingAnswered: true });
      // A brief answered beside a live question of another id leaves that question on the row (core.ts resolvePending;
      // Codex review on #988).
      const pending = item.facts?.pending;
      const other = !!args.requestId && !!pending?.requestId && pending.requestId !== args.requestId;
      if (other) return starting(next, { answered: args.requestId });
      return starting({ ...facts(next, { pending: null }), ask: null, options: [] }, { answered: args.requestId ?? pending?.requestId ?? null });
    }
    case 'sweep':
      if (args.decision !== 'keep' && doneLabel(item) === 'Clear') return item;
      // Keep reads it and puts it back in rotation, but a project that holds it keeps holding it (Codex review on #671).
      if (args.decision === 'keep') return item.heldBy ? { ...item, seen: 'seen', backFromSnooze: false } : projectHold(back(item), ctx);
      return { ...item, disposition: 'done', doneAt: Date.now(), seen: 'seen', snoozeUntil: null, snoozeTrigger: null, backFromSnooze: false, heldBy: null };
    default:
      return undefined; // undo, viewed, and anything new: wait for the server
  }
}

/** The items with every overlay for them applied, in the order they were made. */
export function overlaid(items, overlays) {
  if (!overlays.length) return items;
  return items.map((item) => overlays.reduce((acc, o) => (o.itemId === acc.id ? o.apply(acc) || acc : acc), item));
}

/**
 * The lists with the overlays applied: each list's own copy of an overlaid item is kept or dropped
 * according to where it now belongs (a Done leaves Active for History at once), and an item that now
 * belongs in a list it isn't in is added from the freshest copy (`fetchedFrom`: view -> when that list was
 * read; Codex review on #671). The owner's filters are checked again on the predicted item (`matchesOf`:
 * item -> the filters it matches, as the server's filterMatches): a type changed to a muted one stays
 * in Active, with its annotation updated. `raw` is { [view]: items } from the server.
 */
export function overlaidLists(raw, overlays, fetchedFrom = {}, matchesOf = (item) => item.filteredBy || [], detail = null) {
  if (!overlays.length) return raw;
  const touched = new Set(overlays.map((o) => o.itemId));
  const freshest = {};
  // The open Conversation's copy (`detail`: { item, from }) counts too when it was read last (Codex review on #671).
  const sources = Object.keys(raw).map((view) => ({ items: raw[view], from: fetchedFrom[view] ?? 0 }));
  if (detail?.item) sources.push({ items: [detail.item], from: detail.from ?? 0 });
  sources.sort((a, b) => b.from - a.from);
  // Every list retains muted rows and annotates the matching values.
  const refilter = (item) => {
    const matches = matchesOf(item);
    return matches.length || item.filteredBy?.length ? { ...item, filteredBy: matches } : item;
  };
  const belongs = (item, view) => inList(item, view);
  for (const source of sources) for (const item of source.items) if (touched.has(item.id) && !freshest[item.id]) freshest[item.id] = refilter(overlaid([item], overlays)[0]);
  const out = {};
  for (const [view, items] of Object.entries(raw)) {
    const kept = items.map((item) => (touched.has(item.id) ? refilter(overlaid([item], overlays)[0]) : item)).filter((item) => !touched.has(item.id) || belongs(item, view));
    const have = new Set(items.map((item) => item.id));
    const added = Object.values(freshest).filter((item) => !have.has(item.id) && belongs(item, view));
    out[view] = added.length ? [...added, ...kept] : kept;
  }
  return out;
}

/** The System page's commands predictSystem() can tell (all of them). */
export const SYSTEM_PREDICTED = new Set(['incident.ack', 'incident.mute', 'incident.snooze', 'incident.unack', 'incident.fix', 'job.run', 'job.pause', 'job.resume', 'job.restart', 'job.retire', 'job.restore', 'process.stop', 'mode.away', 'mode.working']);

/**
 * The System page's commands (desk/system.ts), predicted on its snapshot the same way: the page shows the
 * effect at the tap; a failure puts the snapshot back with a Retry. Undefined when it can't be told.
 * `data`: GET /api/desk/system's body. `now`: the tap's time (tests pass one).
 */
export function predictSystem(type, data, args = {}, now = Date.now()) {
  if (!data) return undefined;
  const iso = new Date(now).toISOString();
  const incident = (status, patch = {}) => {
    const id = Number(args.incidentId);
    if (!data.incidents?.some((i) => i.id === id && i.status !== 'resolved')) return undefined;
    return { ...data, incidents: data.incidents.map((i) => (i.id === id ? { ...i, status, snoozedUntil: null, ...patch } : i)) };
  };
  const job = (patch) => {
    if (!data.jobs?.some((j) => j.id === args.jobId)) return undefined;
    return { ...data, jobs: data.jobs.map((j) => (j.id === args.jobId ? { ...j, ...(typeof patch === 'function' ? patch(j) : patch) } : j)) };
  };
  switch (type) {
    case 'incident.ack':
      return incident('acked');
    case 'incident.mute':
      return incident('muted');
    case 'incident.unack':
      return incident('open');
    case 'incident.fix': {
      // Fixing… at the tap; the thread to open arrives with the answer. One under way stays as it is.
      const id = Number(args.incidentId);
      const inc = data.incidents?.find((i) => i.id === id && i.status !== 'resolved');
      if (!inc) return undefined;
      if (inc.fix && !inc.fix.done) return data;
      return { ...data, incidents: data.incidents.map((i) => (i.id === id ? { ...i, fix: { itemId: null, at: iso, via: null, done: false } } : i)) };
    }
    case 'incident.snooze': {
      const at = typeof args.until === 'string' ? Date.parse(args.until) : now + Number(args.hours || 0) * 3_600_000;
      return Number.isFinite(at) && at > now ? incident('snoozed', { snoozedUntil: new Date(at).toISOString() }) : undefined;
    }
    case 'job.pause':
      return job({ state: 'paused' });
    case 'job.resume':
    case 'job.restore':
      return job({ state: 'active', retiredAt: null, retireReason: null, archivePath: null });
    case 'job.retire':
      return job({ state: 'retired', retiredAt: iso, retireReason: typeof args.reason === 'string' ? args.reason : null });
    case 'job.run': {
      // It's running: the strip's newest cell, until a reading has the run.
      const next = job({ lastStatus: 'running' });
      if (!next) return undefined;
      const runs = data.runs?.[args.jobId] || { strip: [], summary: null, durationMs: null };
      return { ...next, runs: { ...(data.runs || {}), [args.jobId]: { ...runs, strip: [...runs.strip, 'running'].slice(-8) } } };
    }
    case 'job.restart':
      return job((j) => ({ facts: { ...(j.facts || {}), restartingAt: iso } }));
    case 'mode.working':
      return { ...data, workMode: { mode: 'working', source: 'manual', until: null, minutesLeft: null } };
    case 'mode.away': {
      const hours = Number(args.hours) > 0 ? Number(args.hours) : null;
      return { ...data, workMode: { mode: 'away', source: 'manual', until: hours ? new Date(now + hours * 3_600_000).toISOString() : null, minutesLeft: hours ? Math.round(hours * 60) : null } };
    }
    case 'process.stop':
      return data.jobs?.some((j) => j.id === args.jobId && !j.managed) ? { ...data, jobs: data.jobs.filter((j) => j.id !== args.jobId) } : undefined;
    default:
      return undefined;
  }
}
