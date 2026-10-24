// A space's settings (docs/specs/spaces.md): how an agent or a project behaves and what it inherits. A page of its
// own under the space, in Settings' own parts (groups of rows, switches, segmented controls, chips), with the
// space's record as JSON at the end. Every change saves as it's made (desk/spaces.ts); the default conversation
// is a role (roles.ts), so picking another one moves the role.

import { html, useState } from '../../vendor/preact-htm.js';
import { Seg } from '../views-editor.js';
import { agentChat, agentsOf, childProjects, kindOf, ownMatch, parentChoices, threadTitle, threadsIn } from './model.js';
import { Tile } from './rows.js';

/** The person's own space: what every top-level agent and project inherits until it is configurable itself. */
const PERSONAL = {
  rules: ['Plain words; lead with the answer.', 'Ask before anything outward-facing: posts, emails, deploys.', 'Never invent dates or facts; check with a tool.'],
  tools: { messaging: true, browser: true, repos: true, money: false },
  permissions: { postPublicly: false, mergeAfterReview: false, spendMoney: false, messageConversations: true },
};

const TOOL_NAMES = [['messaging', 'Messaging'], ['browser', 'Browser'], ['repos', 'Repos and PRs'], ['money', 'Money moves'], ['calendar', 'Calendar'], ['printer', '3D printer']];
const PERMISSIONS = [
  ['messageConversations', 'Message its conversations freely', 'Its default can mail its threads without asking you first. Off: it drafts, you approve (as the coordinator did).'],
  ['mergeAfterReview', 'Merge after review', 'Merge a PR once it is approved and CI is green.'],
  ['postPublicly', 'Post publicly', 'Slack, Discord or Reddit posts without asking first.'],
  ['spendMoney', 'Spend money', 'Purchases and transfers. Off in your space, so a space can’t turn it on.'],
];

function Inherit({ here }) {
  return here ? html`<span class="ss-src here">Set here</span>` : html`<span class="ss-src">From your space</span>`;
}

/**
 * Inside: the space a project is in, and inherits from (docs/specs/spaces.md, Nesting): your space, a top-level project
 * or an agent. A child narrows what it inherits, never widens it. Agents, and a project that holds projects, stay at the top.
 */
function InsideRow({ store, project, kind }) {
  const { state } = store;
  const choices = project ? parentChoices(project, state.projects || [], agentsOf(state.lists, state.now)) : [];
  const holds = project ? childProjects(`project:${project.id}`, state.projects || []).length : 0;
  const why = !project
    ? 'An agent sits in your space and inherits from it.'
    : holds
      ? `It holds ${holds} project${holds === 1 ? '' : 's'}, so it stays in your space: spaces nest two levels.`
      : 'What it inherits rules, tools, permissions, memory and persona from. It can narrow them, never widen them.';
  return html`<div class="stg-row"><span class="stg-k"><b>Inside</b><small>${why}</small></span>
    ${project && choices.length > 1
      ? html`<select class="stg-input ss-pick" aria-label="Inside" value=${project.parent || ''} onChange=${(e) => store.setProjectParent(project.id, e.target.value || null)}>
          ${choices.map((c) => html`<option value=${c.value || ''}>${c.kind === 'agent' ? `${c.label} (agent)` : c.label}</option>`)}
        </select>`
      : html`<span class="ss-src">Your space</span>`}
  </div>`;
}

export function SpaceSettingsPage({ store, id }) {
  const { state } = store;
  const [kind, key] = String(id || '').split(/:(.*)/s);
  const project = kind === 'project' ? (state.projects || []).find((p) => p.id === key) : null;
  const agent = kind === 'agent' ? agentsOf(state.lists, state.now).find((a) => a.id === key) || { id: key, name: key } : null;
  const name = project?.name || agent?.name || 'Space';
  const own = ownMatch(kind === 'project' ? 'project' : 'agent', key, state.projects || []);
  const { open } = threadsIn(state.lists, (i) => (project ? own(i) : own(i) && !i.facts?.projectId));
  const chat = agent ? agentChat(state.lists, key) : null;
  const candidates = [...(chat ? [chat] : []), ...open.filter((i) => ['thread', 'default'].includes(kindOf(i)) && i.id !== chat?.id)];
  const current = candidates.find((i) => kindOf(i) === 'default') || null;
  const record = state.spaces?.[id] || {};
  const [error, setError] = useState(null);
  const save = async (patch) => setError(await store.saveSpace(id, { ...record, ...patch }));
  const about = record.about ?? project?.about ?? '';
  const lifetime = record.lifetime || (project ? 'finishes' : 'open');
  const tools = record.tools || {};
  const permissions = record.permissions || {};
  const rules = record.rules || [];
  const memory = record.memory || 'space';
  const pickDefault = async (itemId) => {
    if (current && current.id !== itemId && current.kind !== 'chapter') await store.setRole(current.id, 'interactive');
    if (itemId) await store.setRole(itemId, 'default', null);
  };
  const json = JSON.stringify({ space: id, ...record }, null, 2);
  const [raw, setRaw] = useState(null);
  const [rawErr, setRawErr] = useState(null);
  const applyRaw = async () => {
    let next;
    try {
      next = JSON.parse(raw);
    } catch (err) {
      return setRawErr(`Not valid JSON: ${err.message}`);
    }
    const { space: _space, ...rest } = next || {};
    const err = await store.saveSpace(id, rest);
    if (err) return setRawErr(err);
    setRaw(null);
    setRawErr(null);
  };
  const [newRule, setNewRule] = useState('');
  const addRule = () => newRule.trim() && (save({ rules: [...rules, newRule.trim()] }), setNewRule(''));
  return html`<div class="nx-col">
    <header class="nx-phead">
      <div class="nx-ptop"><${Tile} tile=${project ? { kind: 'project', id: key, project } : { kind: 'agent', id: key, name }} store=${store} size=${36} /><h1 class="nx-h1">${name} settings</h1></div>
      <p class="nx-about">How this ${kind} behaves, and what it inherits from your space. Changes save as you go.</p>
    </header>
    <div class="stg-main nx-stg">
      ${error ? html`<p class="warn" role="alert">Didn’t save: ${error}</p>` : null}
      <div class="stg-gh"><h3>Space</h3></div>
      <div class="stg-group">
        <div class="stg-row"><span class="stg-k"><b>About</b><small>What this space is for, in a line. Shown under its name.</small></span></div>
        <div class="stg-row"><input class="stg-input ss-grow" value=${about} maxlength="300" placeholder="What this space is for…" onChange=${(e) => save({ about: e.target.value })} /></div>
        <div class="stg-row"><span class="stg-k"><b>Kind</b><small>An agent has a persona and usually lasts; a project usually finishes.</small></span><span class="ss-src">${kind === 'agent' ? 'Agent' : 'Project'}</span></div>
        <div class="stg-row"><span class="stg-k"><b>Lifetime</b><small>${lifetime === 'open' ? 'Open-ended: it never finishes on its own.' : 'Finishes when its work is done; what is still open moves up to your space.'}</small></span><${Seg} label="Lifetime" options=${[['finishes', 'Finishes'], ['open', 'Open-ended']]} value=${lifetime} onChange=${(v) => save({ lifetime: v })} /></div>
        <${InsideRow} store=${store} project=${project} kind=${kind} />
        <div class="stg-row"><span class="stg-k"><b>Default conversation</b><small>${chat ? 'An agent’s default is its home chat.' : 'Its lead: answers where things stand, decides or brings it to you, and starts workers instead of building.'}</small></span>
          ${chat
            ? html`<span class="ss-src">${threadTitle(chat)}</span>`
            : html`<select class="stg-input" value=${current?.id || ''} onChange=${(e) => pickDefault(e.target.value)}>${current ? null : html`<option value="">None yet</option>`}${candidates.map((c) => html`<option value=${c.id}>${threadTitle(c)}</option>`)}</select>`}</div>
      </div>

      ${agent
        ? html`<div class="stg-gh"><h3>Persona</h3></div>
          <div class="stg-group">
            <div class="stg-row"><span class="stg-k"><b>Name and picture</b><small>${agent.name} · from its Discord profile</small></span><button class="linkish" onClick=${() => store.openSettings('agents')}>Icon and color</button></div>
            <div class="stg-row"><input class="stg-input ss-grow" value=${record.persona?.voice || ''} maxlength="300" placeholder="How it talks: “Calm and brief. Plain words.”" onChange=${(e) => save({ persona: { voice: e.target.value } })} /></div>
            <div class="stg-row"><span class="stg-k"><b>Speaks as ${agent.name} everywhere in its space</b><small>Its projects and threads inherit the persona.</small></span><span class="ss-src here">Always</span></div>
          </div>`
        : null}

      <div class="stg-gh"><h3>Rules</h3></div>
      <div class="stg-group">
        ${PERSONAL.rules.map((r) => html`<div class="stg-row"><span class="stg-k"><b class="ss-rule">${r}</b></span><${Inherit} here=${false} /></div>`)}
        ${rules.map((r, i) => html`<div class="stg-row"><span class="stg-k"><b class="ss-rule">${r}</b></span><${Inherit} here=${true} /><button class="linkish danger" onClick=${() => save({ rules: rules.filter((_, j) => j !== i) })}>Remove</button></div>`)}
        <div class="stg-row"><input class="stg-input ss-grow" placeholder="Add a rule for this space…" value=${newRule} onInput=${(e) => setNewRule(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && addRule()} /><button class="btn sm" disabled=${!newRule.trim()} onClick=${addRule}>Add</button></div>
      </div>

      <div class="stg-gh"><h3>Tools</h3></div>
      <div class="stg-card">
        <p class="stg-hint">Tool groups this space's conversations can use. Dashed ones come from your space; a space can add or narrow them.</p>
        <div class="stg-chips">${TOOL_NAMES.map(([k, label]) => {
          const here = k in tools;
          const on = here ? tools[k] : !!PERSONAL.tools[k];
          return html`<button type="button" class=${`${on ? 'on' : ''}${here ? '' : ' inh'}`} aria-pressed=${on} title=${here ? 'Set here' : 'From your space'} onClick=${() => save({ tools: { ...tools, [k]: !on } })}>${label}</button>`;
        })}</div>
      </div>

      <div class="stg-gh"><h3>Permissions</h3></div>
      <div class="stg-group">
        ${PERMISSIONS.map(([k, label, desc]) => {
          const locked = k === 'spendMoney' && !PERSONAL.permissions.spendMoney;
          const here = k in permissions;
          const value = here ? permissions[k] : PERSONAL.permissions[k];
          return html`<label class="stg-row stg-toggle"><span class="stg-k"><b>${label}</b><small>${desc}</small></span><${Inherit} here=${here} /><input type="checkbox" role="switch" class="stg-switch" checked=${value} disabled=${locked} onChange=${(e) => save({ permissions: { ...permissions, [k]: e.target.checked } })} /></label>`;
        })}
      </div>

      <div class="stg-gh"><h3>Memory</h3></div>
      <div class="stg-group">
        <div class="stg-row"><span class="stg-k"><b>What its conversations remember</b><small>${memory === 'space' ? 'Shared across this space: a thread knows what the others learned.' : 'Each conversation keeps its own.'}</small></span><${Seg} label="Memory" options=${[['space', 'Shared'], ['conversation', 'Per conversation']]} value=${memory} onChange=${(v) => save({ memory: v })} /></div>
      </div>

      <div class="stg-gh"><h3>Configuration</h3><button class="linkish" onClick=${() => (raw === null ? setRaw(json) : (setRaw(null), setRawErr(null)))}>${raw === null ? 'Edit as JSON' : 'Cancel'}</button></div>
      <div class="stg-card">
        <p class="stg-hint">What this page sets, as the space's record stores it. What it inherits isn't repeated here.</p>
        ${raw === null
          ? html`<pre class="ss-json">${json}</pre>`
          : html`<textarea class="stg-input ss-json" rows=${Math.min(28, raw.split('\n').length + 1)} spellcheck="false" value=${raw} onInput=${(e) => setRaw(e.target.value)}></textarea>
            ${rawErr ? html`<p class="warn" role="alert">${rawErr}</p>` : null}
            <div class="stg-foot"><span class="spacer"></span><button class="btn sm pri" onClick=${applyRaw}>Save</button></div>`}
      </div>
    </div>
  </div>`;
}
