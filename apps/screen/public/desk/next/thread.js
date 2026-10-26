import { BriefReceipts } from '../brief.js';
import { OwnerReceipts } from '../owner-receipts.js';
import { doneLabel } from '../query-identity.js';
// The next layout's thread page (spec: "Page header", "Thread"): the title, [status] and the
// quiet metadata, the ⋯ menu and the panel toggle; then the call, the latest reply, and the composer.
// The right panel (History · Reporting here · Links · Screens · Mail · Details) sits under the breadcrumb
// bar beside the column, sliding over the page when the margin can't hold it. On a phone its tabs sit
// under the header instead.

import { PrChip, PrList } from './prs.js';
import { threadPrs, otherLinks, prCount } from './pr-model.js';
import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { CommandLine, WritebackLine } from '../cards.js';
import { LinkList } from '../coordinator.js';
import { Backstage, Composer, ContextBody, MailDrafts, MailPane, Needs, RuleProposals, Latest, answersLatest, inFlight, Queued, Reply, Sheets, currentItem, replyOf, useDropToAttach, voiceDraft } from '../conversation.js';
import { DropHint, Lightbox } from '../attachments.js';
import { moveTargets, runOnTargets, useCapacity } from './capacity.js';
import { prsOf } from '../list.js';
import { MENU_TYPES, canActOnRow, projectOf, typeName, typeOf } from '../list-model.js';
import { age, askedOf, isFresh, storageGet, storageSet } from '../util.js';
import { KINDS, agentOf, agentNameOf, agentsOf, findItem, headerMeta, homeOf, kindOf, nestedProjectList, ownerChoices, ownerPlaces, ownerLabel, ownerName, spaceOf, scheduleLine, statusOf, threadTitle, tokensLabel, budgetToday, BUDGET_WARN } from './model.js';
import { KindGlyph, ThreadRow, Tile } from './rows.js';
import { linked } from '../decision-links.js';
import { Menu, contextMenuProps } from './menu.js';
import { MENU_ICONS as MI } from './icons.js';
import { newProject } from '../projects-editor.js';

const I = {
  more: html`<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12.5" cy="8" r="1.1"/></svg>`,
  panel: html`<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M10 2.5v11"/></svg>`,
  x: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>`,
  chev: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5"/></svg>`,
};

// The panel fits beside the column when the margin holds it (760 column + two 356 margins: 340 panel, 16 gap).
export const PANEL_FITS = '(min-width: 1472px)';

/** The thread's ⋯ menu: the Desk's real actions, in sections; project and type drill in. */
export function threadMenu(item, store, { onReply = null, newHere = null } = {}) {
  const canAct = canActOnRow(item);
  const away = item.disposition === 'snoozed' || item.disposition === 'parked';
  const project = projectOf(item, store.state.projects);
  const type = typeOf(item);
  const agents = agentsOf(store.state.lists, store.state.now);
  const projects = nestedProjectList(store.state.projects, agents);
  // A worker or job: who it reports to now, and who it could (its space's lead first).
  const reports = ['worker', 'job'].includes(kindOf(item));
  const owner = findItem(store.state.lists, item.facts?.parentItemId);
  const owners = ownerChoices(store.state.lists, spaceOf(item, store.state.projects), store.state.projects, { self: item.id });
  // Becoming a job or worker: the owner it has while that's still open, else the lead. With neither (a thread in your
  // own space has no lead), Kind can't say who, so the handoff menus pick one in the same step (Codex review on #854).
  const keeps = owner && owner.disposition !== 'done' ? owner : null;
  const reportTo = keeps ? undefined : owners.lead?.id;
  const noOwner = !keeps && !owners.lead;
  const currentSpace = spaceOf(item, store.state.projects);
  const agentId = agentOf(item);
  const agentName = agentId ? agentNameOf(item) || agentId : null;
  const sameSpace = (space) => space?.kind === currentSpace?.kind && space?.id === currentSpace?.id;
  const ownerRows = (group, select, current = null) => group.choices.map((o) => ({
    label: ownerLabel(o, group.lead), on: o.id === current, onSelect: () => select(o.id),
  }));
  const tile = (p) => html`<${Tile} tile=${{ kind: 'project', id: p.id, project: p }} store=${store} size=${16} />`;
  const places = ownerPlaces(store.state, { self: item.id }).filter((p) =>
    item.source !== 'discord' || (p.space && (p.space.kind !== 'agent' || p.space.id === agentId)));
  const moveToPlace = async (place, ownerId) => {
    // No project means personal space, including when the conversation has an explicit agent assignment.
    if (!place.space && item.facts?.agentSpace) {
      const cleared = await store.setAgentSpace(item.id, null);
      if (cleared?.status !== 'sent') return cleared;
    }
    return store.setProject(item.id, place.project?.id || null, ...(ownerId === undefined ? [] : [ownerId]));
  };
  const placeRows = (role = null) => {
    let section;
    return places.flatMap((p) => {
      if (role && !p.owners.choices.length) return [];
      const foreignAgent = p.space?.kind === 'agent' && p.space.id !== agentId;
      if (!role && foreignAgent && !p.owners.choices.length) return [];
      const select = (id) => role || foreignAgent
        ? store.handOff(item.id, role || (kindOf(item) === 'job' ? 'ops' : 'worker'), id)
        : moveToPlace(p, id);
      const heading = section !== p.section && (p.section || section !== undefined) ? [p.section ? { heading: p.section } : 'sep'] : [];
      section = p.section;
      return [...heading, { key: p.space ? `${p.space.kind}:${p.space.id}` : 'personal', label: p.label,
        icon: p.project ? tile(p.project) : p.agent ? html`<${Tile} tile=${{ kind: 'agent', id: p.agent.id, name: p.agent.name }} store=${store} size=${16} />` : null,
        sub: p.owners.choices.length ? ownerRows(p.owners, select, sameSpace(p.space) ? owner?.id : null)
          : [{ label: sameSpace(p.space) ? 'No thread in this space to report to' : 'Move here · nothing to report to yet', disabled: sameSpace(p.space), onSelect: () => moveToPlace(p) }],
      }];
    });
  };
  const prs = prsOf(item);
  const items = [
    item.replyable !== false ? { icon: MI.reply, label: 'Reply', hint: 'r', onSelect: () => (onReply ? onReply() : store.openReply(item.id)) } : null,
    'sep',
    canAct ? { icon: MI.snooze, label: item.disposition === 'snoozed' ? 'Change snooze…' : 'Snooze…', hint: 's', onSelect: () => store.openSnooze(item.id) } : null,
    item.disposition === 'active' || item.disposition === 'snoozed' ? { icon: MI.park, label: 'Park', onSelect: () => store.park(item.id) } : null,
    canAct ? { icon: MI.done, label: doneLabel(item), hint: 'd', onSelect: () => store.done(item.id) } : null,
    away ? { icon: MI.back, label: 'Back to Active', onSelect: () => store.pickup(item.id) } : null,
    item.disposition === 'done' ? { icon: MI.back, label: 'Reopen', onSelect: () => store.reopen(item.id) } : null,
    'sep',
    reports ? {
      icon: MI.back, label: 'Reports to',
      hint: `${project?.name || agentName || 'No project'} › ${owner ? ownerName(owner) : 'No one'}`,
      sub: [
        ...placeRows(),
        'sep',
        { icon: MI.plus, label: 'New project…', onSelect: () => newProject(store, { forItem: item.id }) },
      ],
    } : {
      icon: MI.folder,
      label: 'Move to project',
      hint: project?.name || 'None',
      sub: [
        ...projects.map(({ project: p, label }) => ({ label, icon: tile(p), on: project?.id === p.id, onSelect: () => store.setProject(item.id, p.id) })),
        { label: 'No project', on: !project, onSelect: () => store.setProject(item.id, null) },
        'sep',
        { icon: MI.plus, label: 'New project…', onSelect: () => newProject(store, { forItem: item.id }) },
      ],
    },

    {
      // Who it works for (docs/specs/spaces.md). "Kind", because "Type" is already the work's tag (Feature, Bug…).
      icon: MI.sections,
      label: 'Kind',
      hint: KINDS[kindOf(item)],
      sub: [
        { label: 'Thread · talks with you, finishes', on: kindOf(item) === 'thread', onSelect: () => store.setRole(item.id, 'interactive', null) },
        // A job or worker keeps who it reports to, else reports to its space's lead: never to no one. Reports to picks another.
        { label: noOwner && kindOf(item) !== 'job' ? 'Job · use Hand off as a job' : 'Job · runs on a schedule', on: kindOf(item) === 'job', disabled: noOwner && kindOf(item) !== 'job', onSelect: () => store.setRole(item.id, 'ops', reportTo) },
        { label: noOwner && kindOf(item) !== 'worker' ? 'Worker · use Hand off as a worker' : 'Worker · reports to another thread', on: kindOf(item) === 'worker', disabled: noOwner && kindOf(item) !== 'worker', onSelect: () => store.setRole(item.id, 'worker', reportTo) },
        { label: 'Default · its space’s standing chat', on: kindOf(item) === 'default', onSelect: () => store.setRole(item.id, 'default', null) },
      ],
    },
    ...(!reports && places.some((p) => p.owners.choices.length) && ['thread', 'default'].includes(kindOf(item))
      ? [['ops', 'job'], ['worker', 'worker']].map(([role, label]) => ({ icon: MI.back, label: `Hand off as a ${label}`, sub: placeRows(role) })) : []),
    newHere ? 'sep' : null,
    newHere ? { icon: MI.plus, label: newHere.label, onSelect: newHere.run } : null,
    'sep',
    { icon: MI.eye, label: isFresh(item) ? 'Mark read' : 'Mark unread', onSelect: () => store.markRead(item.id, isFresh(item)) },
    { icon: MI.pin, label: item.facts?.pinned ? 'Unpin' : 'Pin', onSelect: () => store.setPinned(item.id, !item.facts?.pinned) },
    { icon: MI.edit, label: 'Rename…', onSelect: () => store.set({ confirm: { kind: 'rename', itemId: item.id } }) },
    // Loom's session (docs/specs/loom-context-management.md): kept as it is, or started over from its handoff.
    item.source === 'loom' && !item.facts?.stoppedAtSource ? { icon: MI.pin, label: 'Keep this session', on: !!item.facts?.keepSession, onSelect: () => store.keepSession(item.id, !item.facts?.keepSession) } : null,
    item.source === 'loom' && !item.facts?.stoppedAtSource ? { icon: MI.back, label: 'Fresh start', hint: 'next turn', onSelect: () => store.freshStart(item.id) } : null,
    // One row however many PRs the thread has: each PR's watch is a check in its flyout.
    prs.length ? {
      icon: MI.eye,
      label: 'Watch reviews',
      hint: prs.some((pr) => pr.watched) ? `${prs.filter((pr) => pr.watched).length} of ${prs.length}` : String(prs.length),
      sub: prs.map((pr) => ({ label: pr.title ? `#${pr.number} ${pr.title}` : pr.label, on: !!pr.watched, onSelect: () => store.watchPr(item.id, pr.url, !pr.watched) })),
    } : null,
  ].filter(Boolean);
  // No separator first, last or twice.
  return items.filter((it, i, all) => it !== 'sep' || (i > 0 && i < all.length - 1 && all[i - 1] !== 'sep'));
}

/**
 * A thread Loom holds on account limits: one tap runs it on an account with room (D-42). The tap also lets the
 * thread use that account from now on; nothing moves without it.
 */
function RunOn({ item, store }) {
  const capacity = useCapacity(store);
  // Only a Loom that takes move commands can run it elsewhere (Codex review on #813), as on the Capacity page.
  const targets = capacity?.data?.moves ? runOnTargets(item.id, capacity.data.accounts ?? []).slice(0, 3) : [];
  if (!targets.length) return null;
  return html`<div class="nx-runon" role="group" aria-label="Run it on another account">
    <span class="nx-runon-l">Run it now on</span>
    ${targets.map((a) => html`<button class="nx-runon-b" title=${`Also lets this thread use ${a.name} from now on`} onClick=${() => store.moveThread(item.id, a.id, undefined, { allow: true })}><span class="nx-dot" style=${`--c:${a.color || 'var(--muted)'}`}></span>${a.name}${a.weekly ? html`<span class="nx-runon-n">${Math.round(a.weekly.left)}% week</span>` : null}</button>`)}
  </div>`;
}


/** The panel's tabs for this thread; empty ones are left out. */
/** The conversations that report to this one (its workers, or a default's jobs). */
export function reportsTo(lists, item) {
  return ['active', 'snoozed'].flatMap((k) => lists?.[k]?.items || []).filter((i) => i.facts?.parentItemId === item.id && i.disposition !== 'done');
}

export function tabsFor(item, d, project, reports = []) {
  const links = otherLinks(item).length;
  const screens = (d?.scenes?.length || 0) + (d?.prototypes?.length || 0);
  return [
    { key: 'history', label: 'History' },
    reports.length ? { key: 'reports', label: 'Reporting here', n: reports.length } : null,
    threadPrs(item).length ? { key: 'prs', label: 'Pull requests', n: prCount(item) } : null,
    links ? { key: 'links', label: 'Links', n: links } : null,
    screens ? { key: 'screens', label: 'Screens', n: screens } : null,
    d?.mail?.length ? { key: 'mail', label: 'Mail', n: d.mail.length } : null,
    { key: 'details', label: 'Details' },
  ].filter(Boolean);
}

/** One screen or prototype; `from` names the worker or job that staged it (it reports here, and a tap answers it). */
function Shot({ kind, title, from, onOpen, store }) {
  return html`<button class="nx-shot" onClick=${onOpen}><b>${kind}</b><span>${title}</span>${from ? html`<small class="nx-shot-from">↳ from ${fromTitle(store, from)}</small>` : null}</button>`;
}

/** The worker's short name, as its row says it: its summary's title, else its own title without the repo in front. */
function fromTitle(store, from) {
  const item = store.state.byId?.[from.itemId] || findItem(store.state.lists, from.itemId);
  return item?.summary?.title || (item ? threadTitle(item) : String(from.title || '').replace(/^[^·]*·\s*/, ''));
}

function Screens({ d, store }) {
  return html`<div class="nx-shots">
    ${(d?.prototypes || []).map((p) => html`<${Shot} store=${store} kind="Prototype" title=${p.title || p.name} from=${p.from} onOpen=${() => store.showPrototype(p.id, p.from || null)} />`)}
    ${(d?.scenes || []).map((s) => html`<${Shot} store=${store} kind="Screen" title=${s.title || s.summary || 'Screen'} from=${s.from} onOpen=${() => store.showScreen(s.id, s.from || null)} />`)}
  </div>`;
}

/** A Loom thread's account (from Capacity): which one it runs on, its room, where it has run, and a move. */
const MOVE_REASONS = { balance: 'Moved to balance accounts', start: 'Started', limit: 'Hit its limit; moved', auth: 'Signed out; moved', move: 'Moved by you', low: 'Running low; moved' };
function ThreadAccount({ item, store }) {
  const cap = store.state.capacity;
  const [history, setHistory] = useState(null);
  // Another thread's log never shows here while this one's loads.
  useEffect(() => setHistory(null), [item.id]);
  useEffect(() => {
    if (!cap || store.state.now - (cap.data?.updatedAt || 0) > 60_000) void store.loadCapacity();
    let live = true;
    void store.accountHistory(item.id).then((h) => live && setHistory(h));
    return () => (live = false);
  }, [item.id, cap?.data?.updatedAt]);
  const data = cap?.data;
  const account = data?.accounts.find((a) => a.threads.some((t) => t.itemId === item.id));
  if (!account) return data ? html`<p class="nx-empty nx-acct-none">No account yet: Loom picks one at its first turn.</p>` : null;
  const thread = account.threads.find((t) => t.itemId === item.id);
  const allowed = thread.allowed ? thread.allowed.map((id) => data.accounts.find((a) => a.id === id)?.name || id) : null;
  const targets = moveTargets(thread, account, data.accounts);
  const w = (x, label) => (x ? `${Math.round(x.left)}% ${label}` : null);
  const when = (at) => new Date(at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return html`<section class="nx-acct" aria-label="Account">
    <h4>Account</h4>
    <div class="nx-acct-now"><span class="nx-dot" style=${`--c:${account.color || 'var(--muted)'}`}></span><b>${account.name}</b><span>${[w(account.weekly, 'week'), w(account.fiveHour, '5-hour')].filter(Boolean).join(' · ')}</span></div>
    <p class="note">${allowed ? `May use ${allowed.join(', ')}` : 'May use any Claude account'} · <button class="nx-link" onClick=${() => store.openSettings('routing')}>Edit</button></p>
    ${history?.length
      ? html`<ol class="nx-acct-log">${history.map((h) => html`<li><span>${when(h.at)}</span><span>${MOVE_REASONS[h.reason] || h.reason} ${h.reason === 'start' ? 'on' : 'to'} <b>${h.name}</b></span></li>`)}</ol>`
      : null}
    ${targets.length && data.moves
      ? html`<div class="nx-acct-move"><span class="note">Move to</span>${targets.map((a) => html`<button class="btn sm ghost" onClick=${() => store.moveThread(item.id, a.id)}><span class="nx-dot" style=${`--c:${a.color || 'var(--muted)'}`}></span>${a.name}${a.weekly ? html` <span class="note">${Math.round(a.weekly.left)}%</span>` : null}</button>`)}</div>`
      : null}
  </section>`;
}

/** The runtime, kept out of rows and headers (spec principle 7). */
/** "312k now · 140M today over 300 calls": an idle thread's summary from an earlier day counts nothing today. */
function contextLine(context, now) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const current = !context.day || context.day === today.getTime();
  return `${tokensLabel(context.tokens)} now · ${current && context.callsToday ? `${tokensLabel(context.today)} today over ${context.callsToday} calls` : 'none today'}`;
}

/** "85M of 100M today (85%), raised 50M": past 80% it says what happens next, and offers Raise. */
function BudgetLine({ item, store }) {
  const budget = budgetToday(item, store.state.now);
  if (!budget) return null;
  const pct = Math.round(budget.share * 100);
  const held = item.facts?.held?.reason === 'budget';
  const note = held ? 'Held: automatic turns resume at midnight; yours still run' : budget.share >= BUDGET_WARN ? 'Starts fresh at its next turn; at 100% automatic turns wait for midnight' : null;
  return html`${tokensLabel(budget.today)} of ${tokensLabel(budget.limit)} today (${pct}%)${budget.raised ? ` · raised ${tokensLabel(budget.raised)}` : ''}${note ? html`<br /><span class="note">${note}</span>` : null}${held || budget.share >= BUDGET_WARN ? html` <button class="btn sm ghost" onClick=${() => store.raiseBudget(item.id)}>Raise</button>` : null}`;
}

function Details({ item, d, store }) {
  const source = { loom: 'Loom', loom: 'Loom', discord: 'Discord' }[item.source] || item.source;
  const started = d?.timeline?.[0]?.at ?? d?.messages?.[0]?.at ?? item.createdAt;
  const owner = findItem(store.state.lists, item.facts?.parentItemId);
  const home = homeOf(item, store.state.projects || []);
  const rows = [
    ['Kind', KINDS[kindOf(item)]],
    home ? ['Lives in', home.name] : null,
    owner ? ['Reports to', threadTitle(owner)] : null,
    item.facts?.schedule ? ['Schedule', scheduleLine(item, store.state.now)] : null,
    ['Runs in', source],
    item.area ? ['Repo', item.area] : null,
    ['Agent', item.agentName],
    ['Messages', String(item.messageCount || 0)],
    item.facts?.context ? ['Context', contextLine(item.facts.context, store.state.now)] : null,
    budgetToday(item, store.state.now) ? ['Budget', html`<${BudgetLine} item=${item} store=${store} />`] : null,
    started ? ['Started', `${age(started, store.state.now)} ago`] : null,
    ['Thread id', item.id],
  ].filter(Boolean);
  return html`${item.source === 'loom' ? html`<${ThreadAccount} item=${item} store=${store} />` : null}
    <dl class="nx-details">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
}

function PanelBody({ tab, item, d, store, project }) {
  if (tab === 'reports') return html`<${Reports} item=${item} store=${store} />`;
  if (tab === 'prs') return html`<${PrList} item=${item} now=${store.state.now} />`;
  if (tab === 'links') return html`<${LinkList} links=${otherLinks(item)} store=${store} projectId=${item.facts?.projectId || null} />`;
  if (tab === 'screens') return html`<${Screens} d=${d} store=${store} />`;
  if (tab === 'mail') return html`<${MailPane} d=${d} store=${store} />`;
  if (tab === 'details') return html`<${Details} item=${item} d=${d} store=${store} />`;
  return html`<${ContextBody} item=${item} d=${d} store=${store} />`;
}

/** Tabs, text with a line under the current one. With `onClose`, a × stays at the right end and the tabs scroll behind it. */
export function Tabs({ tabs, tab, onTab, onClose = null }) {
  return html`<div class=${`nx-tabsw${onClose ? ' closable' : ''}`}>
    <div class="nx-tabs" role="tablist">
      ${tabs.map((t) => html`<button role="tab" aria-selected=${t.key === tab} class=${t.key === tab ? 'on' : ''} onClick=${() => onTab(t.key)}>${t.label}${t.n ? html`<span class="n">${t.n}</span>` : null}</button>`)}
    </div>
    ${onClose ? html`<button class="nx-ib nx-tx" aria-label="Close the panel" title="Close the panel" onClick=${onClose}>${I.x}</button>` : null}
  </div>`;
}

/** The panel's state on this device: open or not, and its tab. */
export function usePanel(store, fits, key = 'nextPanel', defaultTab = 'history') {
  let saved = store.state[key];
  if (saved === undefined) {
    try {
      saved = JSON.parse(storageGet(key, 'null'));
    } catch {
      saved = null;
    }
  }
  const open = saved?.open ?? fits;
  const set = (patch) => {
    const next = { open, tab: saved?.tab || defaultTab, ...saved, ...patch };
    storageSet(key, JSON.stringify(next));
    store.set({ [key]: next });
  };
  return { open, tab: saved?.tab || defaultTab, set };
}

/** What reports to this conversation, as the same rows as everywhere else. */
function Reports({ item, store }) {
  const list = reportsTo(store.state.lists, item);
  return html`<div class="nx-reports">
    <p class="nx-hint">${kindOf(item) === 'default' ? 'Jobs and workers in this space report here. Their questions and failures come here first.' : 'Started from this thread. Their questions and failures come here first, not to your Inbox.'}</p>
    ${list.map((i) => html`<${ThreadRow} key=${i.id} item=${i} store=${store} context=${homeOf(item, store.state.projects || [])} compact=${true} />`)}
  </div>`;
}

/** A job leads with its schedule and its recent runs; its transcript follows. */
/** A critical incident's row from the System page (desk/system.ts): what it is, and where to act on it. */
function IncidentCard({ item, store }) {
  const s = item.facts?.system;
  if (!s) return null;
  const go = (route) => store.nextGo(route);
  return html`<section class="nx-job sys-thread">
    <p>${item.summary?.gist || 'A critical incident is open.'}</p>
    <span class="nx-job-acts">
      <button class="btn sm" onClick=${() => store.systemCommand('incident.ack', { incidentId: s.incidentId }, { label: 'Ack', done: 'Acknowledged. It stays on the System page, with no more reminders.', undo: ['incident.unack', { incidentId: s.incidentId }] })}>Ack</button>
      <button class="btn sm ghost" onClick=${() => store.systemCommand('incident.mute', { incidentId: s.incidentId }, { label: 'Mute', done: 'Muted. It’s still counted, never notified.', undo: ['incident.unack', { incidentId: s.incidentId }] })}>Mute</button>
      ${s.fix?.itemId
        ? html`<button class="btn sm ghost" aria-label="Open the fix for this incident" onClick=${() => store.nextOpen(s.fix.itemId)}>Fixing · Open</button>`
        : html`<button class="btn sm ghost" aria-label="Fix this incident" title="Start a worker in the Tango project to find the cause and clean it up" onClick=${() => store.systemCommand('incident.fix', { incidentId: s.incidentId }, { label: 'Fix', action: (o) => (o.itemId ? { label: 'Open thread', fn: () => store.nextOpen(o.itemId) } : null) })}>Fix</button>`}
      <button class="btn sm ghost" onClick=${() => go(s.jobId ? { page: 'system', id: s.jobId, view: 'overview' } : { page: 'system', view: 'overview' })}>Open in System</button>
    </span>
  </section>`;
}

function JobCard({ item, store }) {
  const s = item.facts?.schedule || {};
  const runs = item.facts?.runs || [];
  const now = store.state.now;
  const word = { ok: 'Ran', quiet: 'Nothing new', failed: 'Failed' };
  // Optimistic: each tap shows at once; a failure puts it back (the store toasts why, with Retry). Only a Tango
  // schedule has them: a conversation made a job by hand has no scheduler behind it (Codex review on #704).
  const [started, setStarted] = useState(false);
  const [pausedNow, setPausedNow] = useState(null);
  const paused = pausedNow ?? !!s.paused;
  useEffect(() => setPausedNow(null), [s.paused]);
  const run = () => {
    setStarted(true);
    store.runJob(item.id).then((r) => (r.status === 'failed' ? setStarted(false) : setTimeout(() => setStarted(false), 8000)));
  };
  const pause = () => {
    const next = !paused;
    setPausedNow(next);
    store.pauseJob(item.id, next).then((r) => r.status === 'failed' && setPausedNow(null));
  };
  return html`<section class="nx-job">
    <div class="nx-job-h">
      <dl>
        <div><dt>Runs</dt><dd>${s.every || 'On a trigger'}</dd></div>
        <div><dt>Last run</dt><dd>${s.lastRunAt ? `${age(s.lastRunAt, now)} ago` : 'Not yet'}</dd></div>
        <div><dt>Next run</dt><dd>${paused ? 'Paused' : s.nextRunAt ? new Date(s.nextRunAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '—'}</dd></div>
      </dl>
      ${item.source === 'schedule' ? html`<span class="nx-job-acts"><button class="btn sm" disabled=${started} onClick=${run}>${started ? 'Run started' : 'Run now'}</button><button class="btn sm ghost" aria-pressed=${paused} onClick=${pause}>${paused ? 'Resume' : 'Pause'}</button></span>` : null}
    </div>
    ${runs.length
      ? html`<ol class="nx-runs">${runs.map((r) => html`<li class=${r.outcome}><span class="dot" aria-hidden="true"></span><b>${word[r.outcome] || r.outcome}</b><span>${r.note}</span><small>${age(r.at, now)} ago</small></li>`)}</ol>`
      : null}
  </section>`;
}

/** A job's latest run in place of the reply: what it did, said once (its failure isn't repeated in a callout). */
function LatestRun({ item, d, store }) {
  const run = (item.facts?.runs || [])[0];
  const text = d?.reply?.text || item.summary?.gist || item.line || '';
  const word = { ok: 'Ran', quiet: 'Nothing new', failed: 'Failed' }[run?.outcome] || 'Latest run';
  return html`<section class="nx-lastrun">
    <p class="nx-lastrun-h"><b class=${run?.outcome || ''}>${word}</b>${run ? html` · ${age(run.at, store.state.now)} ago` : null} · latest run</p>
    <div class="md">${text || 'No output.'}</div>
  </section>`;
}

/** A worker: who it works for, said once at the top. You are visiting; its questions go there first. */
/** Done, Snooze… and Park under the latest reply, so putting a thread away doesn't mean scrolling back up to ⋯. */
export function ThreadActs({ item, store }) {
  if (!canActOnRow(item, store.state.now)) return null;
  return html`<div class="nx-tacts-row">
    <button class="btn pri" onClick=${() => store.done(item.id)}>${MI.done}${doneLabel(item)} <span class="kbd">d</span></button>
    <button class="btn" onClick=${() => store.openSnooze(item.id)}>${MI.snooze}${item.disposition === 'snoozed' ? 'Change snooze…' : 'Snooze…'} <span class="kbd">s</span></button>
    ${item.disposition === 'active' || item.disposition === 'snoozed' ? html`<button class="btn" onClick=${() => store.park(item.id)}>${MI.park}Park</button>` : null}
  </div>`;
}

function WorkerLine({ item, store }) {
  const owner = findItem(store.state.lists, item.facts?.parentItemId);
  if (!owner) return null;
  return html`<p class="nx-worker">${KIND_ARROW}<span>Working for <button class="nx-mlink" onClick=${() => store.nextOpen(owner.id)}>${threadTitle(owner)}</button>. Its questions and failures go there first; you're visiting.</span></p>`;
}
const KIND_ARROW = html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3v5a2 2 0 0 0 2 2h7M10 7.5 12.5 10 10 12.5"/></svg>`;

export function ThreadPage({ store, phone, fits }) {
  const { state } = store;
  const item = currentItem(state);
  const d = state.detail;
  const [menu, setMenu] = useState(false);
  const [phoneTab, setPhoneTab] = useState('thread');
  const panel = usePanel(store, fits);
  useEffect(() => {
    if (item && state.nextPrItem === item.id) { setPhoneTab('prs'); panel.set({ open: true, tab: 'prs' }); store.set({ nextPrItem: null }); }
  }, [item?.id, state.nextPrItem]);
  const drop = useDropToAttach(item, store, item ? voiceDraft(state, item).live : false);
  if (!item) return html`<div class="nx-col"><p class="nx-empty">${d?.loading ? 'Loading…' : d?.error ? `Couldn’t load that thread: ${d.error}` : 'Nothing open.'}</p></div>`;
  const project = projectOf(item, state.projects);
  const status = statusOf(item, state.now);
  const kind = kindOf(item);
  const reports = reportsTo(state.lists, item);
  const owner = findItem(state.lists, item.facts?.parentItemId);
  const tabs = tabsFor(item, d, project, reports);
  const tab = tabs.some((t) => t.key === panel.tab) ? panel.tab : 'history';
  const meta = headerMeta(item, state.projects || [], state.now);
  // The reply's "1 link · 1 screen" opens whichever of Links and Screens it has.
  const linksTab = (tabs.find((t) => t.key === 'links') || tabs.find((t) => t.key === 'prs' || t.key === 'screens'))?.key || 'history';
  // Reply from ⋯ on a phone comes back to the thread first, where the composer is.
  const reply = () => (setPhoneTab('thread'), store.openReply(item.id));
  // While the panel is open the floating + steps aside: starting a new thread here lives in ⋯ then.
  const newThread = project && !project.finishedAt
    ? { label: `New thread in ${project.name}`, run: () => store.openStartWork({ projectId: project.id }) }
    : { label: 'New thread', run: () => store.openStartWork({}) };
  const go = (m) => (m.kind === 'project' ? store.nextGo({ page: 'project', id: m.id }) : m.kind === 'agent' ? store.nextGo({ page: 'agent', id: m.id }) : null);
  const overlay = !phone && panel.open && !fits;
  // The floating + steps left of the panel while it's open.
  document.documentElement.classList.toggle('nx-panel-in', !phone && panel.open && !overlay);
  document.documentElement.classList.toggle('nx-panel-over', overlay);
  const header = html`<header class="nx-thead">
    <div class="nx-tt">
      <h1 class="nx-h1" ...${contextMenuProps(store, { kind: 'thread', id: item.id })}>${threadTitle(item)}</h1>
      <span class="nx-tacts">
        <span class="nx-anchor">
          <button class="nx-ib" data-menu-button aria-label="Actions" aria-haspopup="menu" aria-expanded=${menu} title="Actions" onClick=${(e) => (e.stopPropagation(), setMenu(!menu))}>${I.more}</button>
          ${menu ? html`<${Menu} items=${threadMenu(item, store, { onReply: reply, newHere: !phone && panel.open ? newThread : null })} onClose=${() => setMenu(false)} phone=${phone} title=${threadTitle(item)} />` : null}
        </span>
        ${phone ? null : html`<button class=${`nx-ib${panel.open ? ' on' : ''}`} aria-label=${panel.open ? 'Hide the panel' : 'Show the panel'} aria-pressed=${panel.open} title="History, links and more" onClick=${() => panel.set({ open: !panel.open })}>${I.panel}</button>`}
      </span>
    </div>
    <div class="nx-tmeta">
      <span class="nx-tpills">
        ${status ? html`<span class=${`nx-pill ${status.cls}`}>${status.label}</span>` : html`<span class="nx-pill">${item.disposition === 'done' ? 'Done' : 'Open'}</span>`}
        ${(item.facts?.discussing || []).map(brief => html`<button class="nx-mlink" onClick=${() => store.openDecision(brief.id)}>Open ${brief.id}</button>`)}
        ${kind !== 'thread' ? html`<span class="nx-kchip"><${KindGlyph} kind=${kind} />${KINDS[kind]}</span>` : null}
        <${PrChip} item=${item} store=${store} onAll=${() => phone ? setPhoneTab('prs') : panel.set({ open: true, tab: 'prs' })} />
      </span>
      <span class="nx-tgrey">
        ${meta.map((m) => (m.kind === 'project' || m.kind === 'agent' ? html`<button class="nx-mlink" onClick=${() => go(m)}>${m.text}</button>` : html`<span>${m.text}</span>`))}
        ${owner && kind !== 'worker' ? html`<span>↳ <button class="nx-mlink" onClick=${() => store.nextOpen(owner.id)}>${threadTitle(owner)}</button></span>` : null}
      </span>
    </div>
    ${item.facts?.held?.reason === 'account_limit' && item.source === 'loom' ? html`<${RunOn} item=${item} store=${store} />` : null}
  </header>`;
  const reportsLine = reports.length
    ? html`<p class="nx-reportsline"><button class="linkish" onClick=${() => (phone ? setPhoneTab('reports') : panel.set({ open: true, tab: 'reports' }))}>${reports.length} ${reports.every((r) => kindOf(r) === 'job') ? `job${reports.length === 1 ? '' : 's'}` : reports.every((r) => kindOf(r) === 'worker') ? `worker${reports.length === 1 ? '' : 's'}` : 'conversations'} report here${(() => { const f = reports.filter((r) => statusOf(r, state.now)?.key === 'failed').length; return f ? html` · <b class="bad">${f} failed</b>` : ''; })()} · Show</button></p>`
    : null;
  // While it works: once its reply answers your latest words, they sit above it (the classic layout's order).
  const answering = inFlight(item) && answersLatest(item, replyOf(d));
  const body = html`
    ${item.replyable === false && !item.facts?.phoneNote ? html`<p class="nx-retired">This conversation ran in ${item.source === 't3' ? 'T3' : item.source}, which is retired. It's read-only. ${item.continuation ? html`<button class="nx-mlink" onClick=${() => store.nextOpen(item.continuation.id)}>Continue in ${item.continuation.place.split(' · ').at(-1)}</button>` : null}</p>` : null}
    ${kind === 'worker' ? html`<${WorkerLine} item=${item} store=${store} />` : null}
    ${kind === 'job' ? html`<${JobCard} key=${item.id} item=${item} store=${store} />` : null}
    ${item.source === 'system' ? html`<${IncidentCard} key=${item.id} item=${item} store=${store} />` : null}
    ${reportsLine}
    ${kind === 'job' ? html`<${LatestRun} item=${item} d=${d} store=${store} /><${RuleProposals} item=${item} store=${store} /><${CommandLine} item=${item} store=${store} />` : null}
    <${MailDrafts} d=${d} store=${store} />
    ${kind !== 'job' && !inFlight(item) ? html`<${Needs} item=${item} store=${store} /><${RuleProposals} item=${item} store=${store} /><${CommandLine} item=${item} store=${store} /><${WritebackLine} item=${item} store=${store} />` : null}
    ${kind !== 'job' && !d?.sinceOwner && answering && askedOf(item) ? html`<p class="rd-asked rd-you"><b>You asked:</b> ${linked(askedOf(item))}</p>` : null}
    ${kind === 'job' ? null : html`<${Reply} item=${item} d=${d} store=${store} onLinks=${() => (phone ? setPhoneTab(linksTab) : panel.set({ open: true, tab: linksTab }))} />`}
    <${BriefReceipts} item=${item} store=${store} />
    ${kind === 'job' ? null : html`<${OwnerReceipts} item=${item} d=${d} store=${store} />`}
    ${kind === 'job' ? null : html`<${ThreadActs} item=${item} store=${store} />`}
    <${Backstage} d=${d} store=${store} phone=${phone} />
    ${kind !== 'job' && inFlight(item) ? html`<${Latest} item=${item} d=${d} store=${store} asked=${!answering} />` : html`<${Queued} d=${d} store=${store} />`}`;
  const onThread = !phone || phoneTab === 'thread';
  return html`<div class=${`nx-thread rd${phone ? ' rd-phone' : ''}`} ...${drop.handlers}>
    <div class="nx-col">
      ${header}
      ${phone ? html`<${Tabs} tabs=${[{ key: 'thread', label: 'Thread' }, ...tabs]} tab=${phoneTab} onTab=${setPhoneTab} />` : null}
      ${onThread ? html`<div class="nx-tbody">${body}</div>` : html`<div class="nx-tbody nx-inpanel"><${PanelBody} tab=${phoneTab} item=${item} d=${d} store=${store} project=${project} /></div>`}
    </div>
    ${!phone && panel.open
      ? html`<aside class=${`nx-panel${overlay ? ' overlay' : ''}`} aria-label="Thread panel">
          <${Tabs} tabs=${tabs} tab=${tab} onTab=${(t) => panel.set({ tab: t })} onClose=${() => panel.set({ open: false })} />
          <div class="nx-pbody"><${PanelBody} tab=${tab} item=${item} d=${d} store=${store} project=${project} /></div>
        </aside>`
      : null}
    ${onThread && item.replyable !== false && item.source !== 'schedule' && item.source !== 'system' ? html`<${Composer} item=${item} store=${store} key=${item.id} />` : null}
    <${Sheets} item=${item} d=${d} store=${store} />
    ${drop.over ? html`<${DropHint} text="Drop images to add them to your reply" />` : null}
    <${Lightbox} store=${store} />
  </div>`;
}
