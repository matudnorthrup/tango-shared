import { VoiceButton, cancelVoiceEdit } from './voice.js';
// Start work: a new thread from the desk (TGO-934, TGO-954). One quiet sheet: where it goes on top
// ("New thread in [Tango › Desk]", "New thread with [Sierra]": one chip that mirrors the sidebar, a project
// under its parent, an agent, or a repo on its own; a project's thread runs on the project's repo), the task,
// then a footer with one status line, Options and Start. A ✕ in the corner, or Esc, closes it. A thread
// with an agent opens in its home channel, where the agent answers; its Options are the kind and the title.
// Options folds away everything with a default: a project's repo, plan first, the checkout instead of a
// worktree, the kind (a thread talks with you; a worker or job reports to a conversation, the space's lead
// unless another is picked), a pin to one account (with Loom running every repo's threads, Loom picks
// otherwise and moves the thread when one runs low), and the title. New coding threads require Loom.
// ⌘↵ starts, ⌘⇧↵ starts and opens a fresh sheet for the next one. Pasted or attached images go with
// the first message.

import { html, useEffect, useState } from '../vendor/preact-htm.js';
import { ACCEPT, DropHint, useFileDrop } from './attachments.js';
import { isSendKey } from './util.js';
import { newProject } from './projects-editor.js';
import { awayWord, ownerLabel, parentCrumb, sidebarPlaces } from './next/model.js';
import { Tile } from './next/rows.js';

/** The repo a description names outright ("in acme-web …", "the tango desk"), longest name first; else null. */
export function repoNamedIn(text, repos) {
  const said = ` ${String(text || '').toLowerCase().replace(/[^a-z0-9-]+/g, ' ')} `;
  const named = [...(repos || [])].sort((a, b) => b.name.length - a.name.length).find((repo) => said.includes(` ${repo.name.toLowerCase()} `));
  return named ? named.id : null;
}

/** What still blocks Start, in the order the sheet asks for it. */
export function startMissing(form) {
  const missing = [];
  if (!form.repo) missing.push('Pick a repo');
  if (!String(form.prompt || '').trim()) missing.push('Say what it should work on');
  return missing;
}

/** The prompt's first sentence, clipped (the server titles it the same way; Loom refines it later). */
export function titleFrom(prompt) {
  const flat = String(prompt || '').replace(/\s+/g, ' ').trim();
  const sentence = flat.split(/(?<=[.?!])\s/)[0] ?? flat;
  return sentence.length > 60 ? `${sentence.slice(0, 59).replace(/\s+\S*$/, '')}…` : sentence;
}

/** "claude-opus-5-5" → "Opus 5.5", "gpt-6-astra" → "GPT-6 Astra". */
export function modelName(model) {
  const id = String(model || '');
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id);
  if (claude) return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`;
  const gpt = /^gpt-([\d.]+)(?:-(.+))?$/.exec(id);
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ` ${gpt[2].split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')}` : ''}`;
  return id;
}

/** When a window resets, said the way the picker says it: "in 5h", "tomorrow", "Fri". */
export function resetWhen(resetsAt, now) {
  const at = Date.parse(resetsAt || '');
  if (!Number.isFinite(at)) return null;
  const hours = (at - now) / 3_600_000;
  if (hours <= 0) return 'now';
  if (hours < 20) return `in ${Math.max(1, Math.round(hours))}h`;
  if (hours < 44) return 'tomorrow';
  return new Date(at).toLocaleDateString('en-US', { weekday: 'short' });
}

/** One line on why an account is where it is in the picker. */
export function accountLine(account, now) {
  const u = account.usage;
  if (!u) return 'No usage reading';
  if (u.status === 'down') return 'The usage monitor can’t read this account';
  const when = resetWhen(u.resetsAt, now);
  if (u.excluded) return `Kept for personal work${u.weekly != null ? ` · ${Math.round(u.weekly)}% week` : ''}${when ? ` · resets ${when}` : ''}`;
  if (u.useBeforeReset) return `Resets ${when} with ${Math.round(u.weekly)}% unused`;
  const parts = [];
  if (u.weekly != null) parts.push(`${Math.round(u.weekly)}% week`);
  if (u.session != null) parts.push(`${Math.round(u.session)}% 5-hour`);
  if (when) parts.push(`resets ${when}`);
  if (u.status === 'stale') parts.push('older reading');
  return parts.join(' · ') || 'No usage reading';
}

/** Accounts for the picker: by provider, the monitor's order first, then the rest, excluded seats last. */
export function pickerGroups(accounts) {
  const order = (a) => (a.usage?.excluded ? 2 : a.usage?.rank != null ? 0 : 1);
  const sort = (list) => [...list].sort((a, b) => order(a) - order(b) || (a.usage?.rank ?? 99) - (b.usage?.rank ?? 99) || (b.usage?.weekly ?? -1) - (a.usage?.weekly ?? -1));
  return [
    { label: 'Claude', accounts: sort(accounts.filter((a) => a.driver !== 'codex')) },
    { label: 'ChatGPT', accounts: sort(accounts.filter((a) => a.driver === 'codex')) },
  ].filter((group) => group.accounts.length);
}

/** Why the sheet runs where it does, in one line under the strip. */
export function whyLine(repo, account, picked) {
  if (!repo || !account) return '';
  if (picked) return 'You picked this account.';
  const reason = repo.accountReason || '';
  if (/^use before reset/.test(reason)) return `${account.name} resets soon with room left: use it before it’s lost.`;
  if (/^taking turns/.test(reason)) return `${account.name}: comparable headroom across the ${repo.name} pool, so the seats take turns.`;
  if (/^most headroom/.test(reason)) return `${account.name} has the most headroom in the ${repo.name} pool.`;
  if (/^quota unknown|unavailable/.test(reason)) return `The usage monitor has no fresh reading, so the ${repo.name} pool takes turns.`;
  return `${repo.name} runs on ${account.name} by default.`;
}

/** What Options holds, in one line: where, how, and a pin. */
export function loomSummary(form, pinned) {
  return [form.mode === 'auto' ? 'Auto' : form.mode === 'local' ? 'Current checkout' : 'New worktree', form.plan ? 'Plan first' : 'Build', pinned ? `Pinned to ${pinned.name}` : null].filter(Boolean).join(' · ');
}

/**
 * Only what Options changed from its defaults (the footer's quiet line): "" when nothing did. A thread with an
 * agent (`onAgent`) has no plan, checkout or account to speak of.
 */
export function optionsChanged(form, { pinned = null, picked = null, owners = null, onAgent = false } = {}) {
  return [
    !onAgent && form.plan ? 'Plan first' : null,
    !onAgent && form.mode === 'auto' ? 'Auto' : !onAgent && form.mode === 'local' ? 'Current checkout' : !onAgent && form.modeChosen ? 'Worktree' : null,
    kindLine(form, owners),
    !onAgent && pinned ? `Pinned to ${pinned.name}` : !onAgent && picked ? `On ${picked.name}` : null,
    form.title.trim() ? `“${form.title.trim()}”` : null,
  ].filter(Boolean).join(' · ');
}

/** The kinds Options offers (docs/specs/spaces.md, Conversations): a thread by default. */
export const KINDS = [
  ['interactive', 'Thread', 'Talks with you'],
  ['worker', 'Worker', 'Does one job and reports back to a conversation'],
  ['ops', 'Job', 'Runs again and again, reporting to a conversation'],
];
const kindName = (role) => KINDS.find(([r]) => r === role)?.[1] || 'Thread';

/** The kind as the footer says it: nothing for a thread, else "Worker · reports to <owner>" once it has one. */
export function kindLine(form, owners) {
  if (form.role === 'interactive' || !owners?.owner) return null;
  return `${kindName(form.role)} · reports to ${ownerLabel(owners.owner, owners.lead)}`;
}

/** The accounts a Loom thread in this repo may be pinned to: the repo's routing, else every Claude account. */
export function pinSeats(repo, accounts) {
  const claude = accounts.filter((a) => a.driver === 'claudeAgent');
  return repo?.loomSeats ? repo.loomSeats.map((id) => claude.find((a) => a.id === id)).filter(Boolean) : claude;
}

/**
 * The place picker's rows, mirroring the sidebar (next/model.js sidebarPlaces): Projects, each active top-level one
 * with its projects indented under it (a snoozed or parked child dimmed, with its state) and a row to make one; Agents,
 * the ones a thread can start with (the bot's), each with its projects (one it can't start with heads its projects
 * only); then each repo on its own. A query keeps a parent whose child matches, and a child whose parent does.
 */
export function placeChoices(state, options, query = '', places = sidebarPlaces(state)) {
  const q = query.trim().toLowerCase();
  const hit = (name) => !q || String(name || '').toLowerCase().includes(q);
  const out = [];
  const nest = (section, row, children) => {
    const kids = children.filter((c) => hit(c.name) || hit(row.name));
    if (!hit(row.name) && !kids.length) return;
    out.push({ section, child: false, away: null, disabled: false, ...row, key: `${row.kind}:${row.id}` });
    for (const c of kids) out.push({ section, kind: 'project', id: c.id, key: `project:${c.id}`, name: c.name, tile: { kind: 'project', id: c.id, project: c }, child: true, away: awayWord(c, state.now), disabled: false });
  };
  for (const p of places.projects) nest('Projects', { kind: 'project', id: p.id, name: p.name, tile: { kind: 'project', id: p.id, project: p.project } }, p.children);
  if (hit('new project')) out.push({ section: 'Projects', kind: 'new', id: '', key: 'new', name: 'New project…', tile: null, child: false, away: null, disabled: false });
  const bots = options?.agents || [];
  const agents = [...places.agents];
  for (const a of bots) if (!agents.some((x) => x.id === a.id)) agents.push({ kind: 'agent', id: a.id, key: `agent:${a.id}`, name: a.name, children: [] });
  for (const a of agents.sort((x, y) => x.name.localeCompare(y.name))) {
    const bot = bots.find((b) => b.id === a.id);
    if (!bot && !a.children.length) continue;
    const name = bot?.name || a.name;
    nest('Agents', { kind: 'agent', id: a.id, name, tile: { kind: 'agent', id: a.id, name }, disabled: !bot }, a.children);
  }
  for (const r of options?.repos || []) if (hit(r.name)) out.push({ section: 'Repos', kind: 'repo', id: r.id, key: `repo:${r.id}`, name: r.name, tile: { kind: 'repo', id: r.name, name: r.name }, child: false, away: null, disabled: false });
  return out;
}

/** What the chip names: the project the thread joins (its parent as a crumb), else the agent it's with, else its repo; null with none yet. */
export function startPlace(sw, state, options, agents = sidebarPlaces(state).agents) {
  const projects = state.projects || [];
  if (sw.projectId) {
    const p = projects.find((x) => x.id === sw.projectId);
    if (!p) return { kind: 'project', id: sw.projectId, name: 'A deleted project', tile: null, crumb: null };
    return { kind: 'project', id: p.id, name: p.name, tile: { kind: 'project', id: p.id, project: p }, crumb: parentCrumb(p, projects, agents) };
  }
  const { form } = sw;
  if (form.agent) {
    const name = (options?.agents || []).find((a) => a.id === form.agent)?.name || agents.find((a) => a.id === form.agent)?.name || form.agent;
    return { kind: 'agent', id: form.agent, name, tile: { kind: 'agent', id: form.agent, name }, crumb: null };
  }
  const repo = options?.repos.find((r) => r.id === form.repo);
  return repo ? { kind: 'repo', id: repo.id, name: repo.name, tile: { kind: 'repo', id: repo.name, name: repo.name }, crumb: null } : null;
}

/** Why a project's thread goes to the repo it does, under Options → Repo (the chip names the project, not a repo). */
export function repoWhy(form) {
  if (form.repoInferred) return 'Named in what you wrote';
  if (form.repoFrom === 'project') return 'Where the project’s latest thread runs';
  if (form.repoFrom === 'picked') return 'You picked it';
  if (form.repoFrom === 'unread') return 'Check it: the project’s threads couldn’t be read';
  return form.repo ? 'The usual default: the project has no thread yet' : 'The project has no thread yet';
}

/** The footer's word on the repo: a switch the words made, or, for a project's thread, where it goes; "" otherwise. */
export function repoLine(form, repo, projectId) {
  if (!repo) return '';
  if (form.repoInferred) return `Switched to ${repo.name}: your description names it`;
  if (!projectId) return '';
  if (form.repoFrom === 'unread') return `In ${repo.name}? Its threads couldn’t be read: check the repo in Options`;
  return `In ${repo.name}`;
}

const CLIP = html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 11-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9" /></svg>`;

/** A row in Options: a switch, its name and what it does. */
function Toggle({ on, label, sub, onChange, disabled = false }) {
  return html`<label class=${`swc-opt${disabled ? ' off' : ''}`}>
    <input type="checkbox" role="switch" class="stg-switch" checked=${on} disabled=${disabled} onChange=${() => onChange(!on)} />
    <span class="swc-ol"><b>${label}</b><small>${sub}</small></span>
  </label>`;
}

/** A row to pick: an account (its dot, name, week and why), or a plain choice with a name and a line under it. */
function Choice({ account = null, on, label, sub, onPick, disabled = false, now }) {
  return html`<button role="radio" aria-checked=${on} disabled=${disabled} class=${`swc-acct${on ? ' on' : ''}`} onClick=${onPick}>
    ${account ? html`<span class="dot" style=${`background:${account.color || 'var(--muted)'}`}></span>` : html`<span class="dot none"></span>`}
    <span class="swc-ol"><b>${label}</b><small>${sub ?? (account ? accountLine(account, now) : '')}</small></span>
    <span class="pct">${on ? '✓' : account?.usage?.weekly != null ? `${Math.round(account.usage.weekly)}%` : ''}</span>
  </button>`;
}

/** Options: everything with a default. Opens under the footer. */
function OptionsPanel({ store, sw, repo, account, onLoom, onAgent, owners, now }) {
  const form = sw.form;
  const open = (key) => store.setStartField('openOpt', form.openOpt === key ? null : key);
  if (onAgent) return html`<div class="swc-opts" role="group" aria-label="Options">${kindOptions(store, form, owners, open)}${titleOption(store, form)}${alsoRow(store, sw)}</div>`;
  const options = sw.options;
  const accounts = options.accounts;
  const seats = onLoom ? pinSeats(repo, accounts) : [];
  const pinned = accounts.find((a) => a.id === form.pin) || null;
  return html`<div class="swc-opts" role="group" aria-label="Options">
    ${sw.projectId ? repoOption(store, form, options, repo, open) : null}
    <${Toggle} on=${form.plan} label="Plan first" sub="Asks Loom to write a plan and wait for your OK before making changes." onChange=${(v) => store.setStartField('plan', v)} />
    <div role="radiogroup" aria-label="Worktree mode">
      <${Choice} on=${form.mode === 'auto'} label="Auto" sub="Default · starts in your checkout; moves to a worktree when edits are needed" onPick=${() => store.setStartField('mode', 'auto')} />
      <${Choice} on=${form.mode === 'worktree'} label="Worktree" sub="Start in a separate worktree for changes" onPick=${() => store.setStartField('mode', 'worktree')} />
      <${Choice} on=${form.mode === 'local'} label="My checkout" sub="For questions and ops; checkout edits are guarded" onPick=${() => store.setStartField('mode', 'local')} />
      <small>${form.modeHint === 'local' ? 'This task looks suited to your checkout.' : 'This task looks suited to a worktree.'}</small>
    </div>
    ${kindOptions(store, form, owners, open)}
    ${repo
      ? html`<button class="swc-opt swc-more" aria-expanded=${form.openOpt === 'account'} onClick=${() => open('account')}>
          <span class="swc-ic" aria-hidden="true">⇢</span>
          <span class="swc-ol"><b>${onLoom || form.pin ? 'Pin to an account' : 'Account'}</b><small>${onLoom || form.pin ? 'Loom keeps it there, even when that account runs low' : 'The account this thread runs on'}</small></span>
          <span class="swc-val">${onLoom || form.pin ? (pinned ? pinned.name : 'Loom picks') : account ? `${account.name}${form.account ? '' : ' · auto'}` : 'Pick one'}</span>
        </button>`
      : null}
    ${form.openOpt === 'account' && repo
      ? html`<div class="swc-list" role="radiogroup" aria-label="Account">
          ${onLoom || form.pin
            ? html`<${Choice} on=${!form.pin} label="Loom picks" sub=${`The one with the most room${seats.length > 1 ? ` of ${seats.length}` : ''}, moving it when one runs low`} onPick=${() => store.setStartField('pin', '')} now=${now} />
                ${seats.map((a) => html`<${Choice} account=${a} on=${form.pin === a.id} label=${a.name} onPick=${() => store.setStartField('pin', a.id)} now=${now} />`)}
                <p class="note swc-listnote">${repo.name} may use ${seats.map((a) => a.name).join(', ') || 'any account'}: change that in Settings › Accounts.</p>`
            : html`<${Choice} on=${!form.account} label=${repo.pool ? 'Auto: pick by usage' : `Auto: the ${repo.name} default`} sub=${whyLine(repo, account, false)} onPick=${() => store.setStartField('account', '')} now=${now} />
                ${pickerGroups(accounts.filter((a) => a.driver !== 'loom')).flatMap((g) => g.accounts).map((a) => html`<${Choice} account=${a} on=${form.account === a.id} label=${`${a.name} · ${modelName(a.driver === 'claudeAgent' && options.policyModel ? options.policyModel : a.model)}`} onPick=${() => store.setStartField('account', a.id)} now=${now} />`)}`}
        </div>`
      : null}
    ${titleOption(store, form)}${alsoRow(store, sw)}
  </div>`;
}

/** Repo, for a project's thread: the project's own by default (its latest thread's), any other on request. */
function repoOption(store, form, options, repo, open) {
  return html`<button class="swc-opt swc-more" aria-expanded=${form.openOpt === 'repo'} onClick=${() => open('repo')}>
      <span class="swc-ic" aria-hidden="true">▣</span>
      <span class="swc-ol"><b>Repo</b><small>${repoWhy(form)}</small></span>
      <span class=${`swc-val${repo ? '' : ' empty'}`}>${repo ? repo.name : 'Pick one'}</span>
    </button>
    ${form.openOpt === 'repo'
      ? html`<div class="swc-list" role="radiogroup" aria-label="Repo">
          ${options.repos.map((r) => html`<${Choice} on=${form.repo === r.id} label=${r.name} sub="" onPick=${() => store.setStartField('repo', r.id)} />`)}
        </div>`
      : null}`;
}

/**
 * Kind (docs/specs/spaces.md, Conversations): a thread, which talks with you, unless Worker or Job is picked; then
 * Reports to, the space's lead unless another of its open threads is picked. Nothing on the face of the sheet.
 */
function kindOptions(store, form, owners, open) {
  const worker = form.role !== 'interactive';
  const { owner, lead, groups } = owners;
  const any = groups.some((g) => g.choices.length);
  return html`<button class="swc-opt swc-more" aria-expanded=${form.openOpt === 'kind'} onClick=${() => open('kind')}>
      <span class="swc-ic" aria-hidden="true">◉</span>
      <span class="swc-ol"><b>Kind</b><small>A thread talks with you; a worker or job reports to a conversation</small></span>
      <span class="swc-val">${kindName(form.role)}</span>
    </button>
    ${form.openOpt === 'kind'
      ? html`<div class="swc-list" role="radiogroup" aria-label="Kind">
          ${KINDS.map(([role, label, sub]) => html`<${Choice} on=${form.role === role} label=${label} sub=${sub} onPick=${() => store.setStartField('role', role)} />`)}
        </div>`
      : null}
    ${worker
      ? html`<button class="swc-opt swc-more" aria-expanded=${form.openOpt === 'owner'} onClick=${() => open('owner')}>
          <span class="swc-ic" aria-hidden="true">⇢</span>
          <span class="swc-ol"><b>Reports to</b><small>The space's lead, unless you pick another open thread in it</small></span>
          <span class=${`swc-val${owner ? '' : ' empty'}`}>${owner ? ownerLabel(owner, lead) : any ? 'Pick one' : 'No open thread here'}</span>
        </button>`
      : null}
    ${worker && form.openOpt === 'owner'
      ? html`<div class="swc-list" role="radiogroup" aria-label="Reports to">
          ${groups.map((g) => html`${groups.length > 1 ? html`<p class="swc-listhead">${g.label}</p>` : null}
            ${g.choices.map((o) => html`<${Choice} on=${owner?.id === o.id} label=${ownerLabel(o, g.lead)} sub="" onPick=${() => store.setStartField('parent', o.id)} />`)}`)}
          ${any ? null : html`<p class="note swc-listnote">Nothing open to report to: start a thread first.</p>`}
        </div>`
      : null}`;
}

function titleOption(store, form) {
  return html`<button class="swc-opt swc-more" aria-expanded=${form.openOpt === 'title'} onClick=${() => store.setStartField('openOpt', form.openOpt === 'title' ? null : 'title')}>
      <span class="swc-ic" aria-hidden="true">✎</span>
      <span class="swc-ol"><b>Title</b><small>From the first sentence unless you name it</small></span>
      <span class="swc-val">${form.title.trim() || titleFrom(form.prompt) || '—'}</span>
    </button>
    ${form.openOpt === 'title'
      ? html`<input class="swc-title" type="text" aria-label="Title" value=${form.title} onInput=${(e) => store.setStartField('title', e.currentTarget.value)} placeholder=${titleFrom(form.prompt) || 'From the first sentence'} maxlength="80" ref=${(n) => n && !n.dataset.f && ((n.dataset.f = '1'), n.focus())} />`
      : null}`;
}

function alsoRow(store, sw) {
  return html`<div class="swc-also">
      <button class="linkish" disabled=${!sw.ready} onClick=${() => store.submitStartWork({ another: true })}>Start, then another</button><kbd>⌘⇧↵</kbd>
    </div>`;
}

/**
 * The place picker, inline under the first line (a popover would clip at the sheet's edge): a find field, then the
 * rows of placeChoices in their sections. ↑↓ move, ↵ picks, Esc (the sheet's) closes it.
 */
function PlacePanel({ store, sw, entries, current, onPick }) {
  const [cursor, setCursor] = useState(0);
  const query = sw.form.placeQuery || '';
  const pickable = entries.filter((e) => !e.disabled);
  // A query puts the cursor on the first row it names itself, past a parent kept only for its child ("mus": Bike, not Sierra).
  const q = query.trim().toLowerCase();
  const first = Math.max(0, pickable.findIndex((e) => !q || e.name.toLowerCase().includes(q)));
  useEffect(() => setCursor(first), [query]);
  const at = Math.min(cursor, Math.max(0, pickable.length - 1));
  const onKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor(Math.max(0, Math.min(pickable.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (e.key === 'Enter') {
      // Plain ↵ picks the row; the sheet's ⌘↵ never starts from here.
      e.preventDefault();
      e.stopPropagation();
      if (pickable[at]) onPick(pickable[at]);
    }
  };
  let section = null;
  let n = -1;
  return html`<div class="swc-places">
    <input class="swc-pfind" type="search" aria-label="Find a place" placeholder="Find a project, agent or repo" value=${query} onInput=${(e) => store.setStartField('placeQuery', e.currentTarget.value)} onKeyDown=${onKey}
      ref=${(node) => node && !node.dataset.f && ((node.dataset.f = '1'), node.focus())} />
    <div role="listbox" aria-label="Where">
      ${entries.map((e) => {
        const head = e.section !== section ? html`<div class="swc-psec">${e.section}</div>` : null;
        section = e.section;
        const i = e.disabled ? -1 : (n += 1);
        const on = !!current && current.kind === e.kind && current.id === e.id;
        return html`${head}<button role="option" aria-selected=${on} disabled=${e.disabled} title=${e.disabled ? 'No channel to start a thread with it in' : null}
            class=${`swc-pi${e.child ? ' child' : ''}${e.away ? ' away' : ''}${on ? ' on' : ''}${i >= 0 && i === at ? ' cur' : ''}`} onMouseMove=${() => i >= 0 && i !== at && setCursor(i)} onClick=${() => onPick(e)}>
          ${e.kind === 'new' ? html`<span class="swc-pplus" aria-hidden="true">+</span>` : html`<${Tile} tile=${e.tile} store=${store} size=${18} />`}
          <span class="swc-pt">${e.name}</span>${e.away ? html`<span class="swc-ph">${e.away}</span>` : null}
        </button>`;
      })}
      ${entries.length ? null : html`<p class="swc-pnone">Nothing matches.</p>`}
    </div>
  </div>`;
}

export function StartWorkSheet({ store, phone }) {
  const sw = store.state.startWork;
  // Before any return: a hook is called on every render (images dropped anywhere on the sheet attach).
  const drop = useFileDrop((files) => files.length && store.addStartAttachments(files));
  if (!sw) return null;
  const now = store.state.now || Date.now();
  const close = () => { cancelVoiceEdit('start-work'); store.closeStartWork(); };
  const options = sw.options;
  const form = sw.form;
  // Started from inside a project: the new thread joins it; the place chip changes or clears that.
  const joins = sw.projectId ? (store.state.projects || []).find((p) => p.id === sw.projectId) : null;
  // Deleted or finished on another screen while the sheet was open: say so, and keep the ✕ (Codex review on #522).
  const joinsGone = !!sw.projectId && (!joins || !!joins.finishedAt);
  // The chip mirrors the sidebar: a project (its parent as a crumb), an agent, or a repo on its own.
  const places = sidebarPlaces(store.state);
  const place = options ? startPlace(sw, store.state, options, places.agents) : null;
  const entries = form.placeOpen && options ? placeChoices(store.state, options, form.placeQuery, places) : [];
  const pickPlace = (entry) => {
    if (entry.kind === 'new') {
      store.setStartField('placeOpen', false);
      return newProject(store, { then: 'startWork' });
    }
    void store.pickStartPlace(entry);
    // Back to the words once the place is set.
    requestAnimationFrame(() => document.querySelector('.swc-prompt')?.focus());
  };
  const repo = options?.repos.find((r) => r.id === form.repo) || null;
  const account = options ? options.accounts.find((a) => a.id === (form.account || repo?.account)) || null : null;
  // A named agent instead of a repo: a thread with it, in its home channel.
  const agent = form.agent ? (options?.agents || []).find((a) => a.id === form.agent) || null : null;
  const onAgent = !!form.agent;
  // Loom runs this repo's threads: Options pins instead of picking an account.
  const onLoom = !onAgent && !!repo && !form.account && account?.driver === 'loom';
  const missing = startMissing(form);
  const said = !!form.prompt.trim() || form.attachments.length > 0;
  // No account resolved (a broken policy, a pool with no usable seat): the owner picks one first (Codex review on #484).
  // A project gone while the sheet was open blocks Start until the owner says to start on its own (Codex review on #660).
  // A worker or job (Kind): who it reports to, the space's lead unless another is picked (docs/specs/spaces.md).
  const owners = store.startOwner(sw);
  const needsOwner = form.role !== 'interactive' && !owners.owner;
  const ready = !!options && !form.reading && !sw.projectLoading && !sw.sending && !joinsGone && !needsOwner && (onAgent ? !!agent && said : !missing.length && !!account);
  const fileInput = { current: null };
  const onPaste = (e) => {
    const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
    if (files.length) {
      e.preventDefault();
      store.addStartAttachments(files);
    }
  };
  const pinned = options?.accounts.find((a) => a.id === form.pin) || null;
  // One quiet line: what's happening, what's missing, or what Options changed. Nothing when all is default.
  const status = sw.sending
    ? 'Starting…'
    : sw.loading
      ? 'Reading repos and accounts…'
      : form.reading
        ? 'Adding the image…'
        : sw.projectLoading
          ? 'Finding the project’s repo…'
          : onAgent
            ? agent ? (needsOwner ? 'Pick who it reports to in Options' : optionsChanged(form, { owners, onAgent })) : options ? 'That agent isn’t here any more: pick another' : ''
          : options?.repoError && !repo
            ? `${options.repoError}: agents only for now`
          : options && !repo
            ? sw.projectId ? 'Pick its repo in Options, or name one in what you write' : 'Pick where it goes'
            : repo && !account
              ? 'Pick an account in Options'
              : needsOwner
              ? 'Pick who it reports to in Options'
            : [repoLine(form, repo, sw.projectId), optionsChanged(form, { pinned, picked: form.account ? account : null, owners })].filter(Boolean).join(' · ');
  const warn = sw.loadError || options?.policyError || (sw.error ? `Didn’t start: ${sw.error}` : null) || (joinsGone ? `Its project was ${joins ? 'finished' : 'deleted'} while you wrote.` : null);
  return html`<div class="scrim" onClick=${close}>
    <div class=${`picker sw swc${phone ? ' sheet' : ''}`} role="dialog" aria-modal="true" aria-label="Start work" onClick=${(e) => e.stopPropagation()}
      ...${drop.handlers}
      onKeyDown=${(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          // The project dialog over the sheet goes first, even before it has taken focus.
          if (store.state.projectEditor) store.set({ projectEditor: null });
          else if (form.placeOpen) store.setStartField('placeOpen', false);
          else if (form.optsOpen) store.setStartField('optsOpen', false);
          else close();
        } else if (isSendKey(e) && ready && !store.state.projectEditor) {
          e.preventDefault();
          cancelVoiceEdit('start-work'); store.submitStartWork({ another: e.shiftKey });
        }
      }}>
      <button class="swc-x" onClick=${close} aria-label="Close" title="Close (Esc)">✕</button>
      <div class="swc-top">
        <span class="swc-in">New thread ${onAgent ? 'with' : 'in'}</span>
        ${options
          ? html`<button class=${`swc-chip${place ? '' : ' empty'}`} aria-label="Where it goes" aria-haspopup="listbox" aria-expanded=${!!form.placeOpen} disabled=${sw.sending} onClick=${() => store.setStartField('placeOpen', !form.placeOpen)}>
              ${place?.tile ? html`<${Tile} tile=${place.tile} store=${store} size=${18} />` : html`<span class="swc-glyph" aria-hidden="true">▣</span>`}
              ${place?.crumb ? html`<span class="swc-crumb">${place.crumb} ›</span>` : null}
              <span class="swc-pn">${place ? place.name : 'where…'}</span>
            </button>`
          : html`<span class="swc-chip">…</span>`}
      </div>
      ${form.placeOpen && options ? html`<${PlacePanel} store=${store} sw=${sw} entries=${entries} current=${place} onPick=${pickPlace} />` : null}
      <textarea class="swc-prompt" rows=${phone ? 5 : 6} aria-label="What should it work on?" placeholder=${agent ? `What should ${agent.name} work on?` : 'What should it work on?'}
        value=${form.prompt} onPointerDown=${() => cancelVoiceEdit('start-work')} onInput=${(e) => { cancelVoiceEdit('start-work'); store.setStartField('prompt', e.currentTarget.value); }} onPaste=${onPaste} disabled=${!options}
        ref=${(n) => n && options && n.dataset.f !== String(sw.commandId) && (n.focus(), (n.dataset.f = String(sw.commandId)))}></textarea>
      ${form.attachments.length
        ? html`<div class="swc-atts">${form.attachments.map((a, i) => html`<span class="swc-att"><img src=${a.dataUrl} alt=${a.name} /><button aria-label=${`Remove ${a.name}`} onClick=${() => store.removeStartAttachment(i)}>✕</button></span>`)}</div>`
        : null}
      ${warn ? html`<p class="warn swc-warn" role="alert">${warn}${joinsGone ? html` <button class="linkish" onClick=${() => store.setStartProject(null)}>Start it on its own</button>` : null}</p>` : null}
      <div class="swc-foot">
        <button class="swc-clip" aria-label="Attach an image" title="Attach an image (or paste one)" onClick=${() => fileInput.current?.click()}>${CLIP}</button>
        <input type="file" accept=${ACCEPT} multiple hidden ref=${(n) => (fileInput.current = n)} onChange=${(e) => (store.addStartAttachments([...e.currentTarget.files]), (e.currentTarget.value = ''))} />
        ${options && globalThis.navigator?.mediaDevices?.getUserMedia ? html`<${VoiceButton} store=${store} startWork=${true} ready=${ready} />` : null}
        <span class="swc-status">${status}${sw.background ? `${status ? ' · ' : ''}${sw.background} starting` : ''}</span>
        <button class="btn ghost swc-optbtn" aria-expanded=${!!form.optsOpen} disabled=${!options} onClick=${() => store.setStartField('optsOpen', !form.optsOpen)}>Options ${form.optsOpen ? '▴' : '▾'}</button>
        <button class="btn pri" disabled=${!ready} title="⌘↵ · ⌘⇧↵ starts and opens another" onClick=${() => { cancelVoiceEdit('start-work'); store.submitStartWork(); }}>${sw.sending ? 'Starting…' : sw.error ? 'Try again' : 'Start'} <kbd>⌘↵</kbd></button>
      </div>
      ${form.optsOpen && options ? html`<${OptionsPanel} store=${store} sw=${{ ...sw, ready }} repo=${repo} account=${account} onLoom=${onLoom} onAgent=${onAgent} owners=${owners} now=${now} />` : null}
      ${drop.over ? html`<${DropHint} inside text="Drop images to attach them" />` : null}
    </div>
  </div>`;
}
