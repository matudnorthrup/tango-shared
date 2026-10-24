// The project dialog: make one of the owner's projects (from a row's ⋯ menu, which moves that
// conversation into it; from Start work, which starts the thread in it; from anywhere projects are
// listed, which opens it) or change one (its name, icon, color, a line on what it's for, a Linear link).
// Saved for every screen (the `projects` desk setting).

import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { ICON_COLORS, projectTile, rowTitle } from './list-model.js';
import { IconPicker } from './icon-picker.js';
import { agentsOf, parentChoices } from './next/model.js';

/**
 * A fresh id for a new project: its name and when it was made. A deleted project's conversations keep
 * its id, so a new project of the same name must never get it back (Codex review on #522).
 */
export function newProjectId(projects, name = 'project', now = Date.now()) {
  const base = `${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'project'}-${now.toString(36)}`;
  let id = base;
  for (let n = 2; projects.some((p) => p.id === id); n += 1) id = `${base}-${n}`;
  return id;
}

/**
 * The projects with one deleted. The projects inside it move up to the top in the same save (docs/specs/spaces.md,
 * Nesting: before a space ends, what is open in it moves up), so no child is left pointing at a parent that's gone.
 */
export function withoutProject(projects, id) {
  return projects
    .filter((p) => p.id !== id)
    .map((p) => {
      if (p.parent !== `project:${id}`) return p;
      const { parent: _parent, ...rest } = p;
      return rest;
    });
}

export function ProjectTile({ project, big = false }) {
  const t = projectTile(project);
  return html`<span class=${`lt${big ? ' big' : ''}`} style=${`--c:${t.color}`} title=${t.title} aria-hidden="true">
    ${t.icon ? html`<i style=${`-webkit-mask-image:url(api/desk/icon/${t.icon}.svg);mask-image:url(api/desk/icon/${t.icon}.svg)`}></i>` : html`<b>${t.letter}</b>`}
  </span>`;
}

/**
 * A project's fields and its Save / Delete, for the project dialog and Settings → Projects. `editing` is
 * a project id or 'new'; `forItem` a conversation that moves into it once saved. `onDone` after Save,
 * Delete or Cancel; `onCreated(id)` once a new one is saved, before `onDone`.
 */
export function ProjectForm({ store, editing, forItem = null, onDone, onCreated = null, then = null, inSettings = false, parent = null }) {
  const { state } = store;
  const existing = editing !== 'new' ? state.projects.find((p) => p.id === editing) : null;
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const nameRef = useRef(null);
  // A new project starts at its name. After mount: a ref fires before the dialog is in the document.
  useEffect(() => {
    if (editing === 'new') requestAnimationFrame(() => nameRef.current?.focus());
  }, [editing]);
  const d = draft && draft.for === editing ? draft : { for: editing, name: existing?.name || '', icon: existing?.icon || 'folder', color: existing?.color || 'sky', about: existing?.about || '', linearUrl: existing?.linearUrl || '', parent: existing ? existing.parent || '' : parent || '' };
  const put = (patch) => setDraft({ ...d, ...patch });
  // The space it is inside (docs/specs/spaces.md, Nesting): your space, a top-level project, or an agent.
  const choices = parentChoices(existing, state.projects || [], agentsOf(state.lists, state.now));
  const done = () => {
    setDraft(null);
    setError(null);
    onDone();
  };
  const save = async () => {
    const name = d.name.trim();
    if (!name) return setError('Give it a name');
    const fields = { name, icon: d.icon.trim() || null, color: d.color, ...(d.about.trim() ? { about: d.about.trim() } : {}), ...(d.linearUrl.trim() ? { linearUrl: d.linearUrl.trim() } : {}), ...(d.parent ? { parent: d.parent } : {}) };
    const id = existing ? existing.id : newProjectId(state.projects, name);
    const createdAt = Date.now();
    // The Start sheet this was made from (if any): the new project is picked there only (Codex review on #671).
    const sheet = store.state.startWork?.commandId ?? null;
    // This one change, applied to the projects as they are now: a Retry after another screen's save keeps
    // that screen's edits instead of resending an old whole list (Codex review on #671).
    // An edit never brings back a project deleted elsewhere meanwhile; a new one is added once.
    const changed = (projects) =>
      projects.some((p) => p.id === id)
        ? projects.map((p) => (p.id === id ? { id, createdAt: p.createdAt, ...(p.finishedAt ? { finishedAt: p.finishedAt } : {}), ...(p.away ? { away: p.away } : {}), ...(p.hiddenSections ? { hiddenSections: p.hiddenSections } : {}), ...fields } : p))
        : existing
          ? projects
          : [...projects, { id, createdAt, ...fields }];
    // Optimistic, as every desk action: the dialog closes at the tap; a refused save is a toast with Retry.
    const commit = async () => {
      // An edit to a project another screen deleted meanwhile: say so, never bring it back (Codex review on #671).
      if (existing && !store.state.projects.some((p) => p.id === id)) return store.toast(`${name} was deleted on another screen, so this edit wasn’t saved.`, { sticky: true });
      const err = await store.saveProjects(changed);
      if (err) return store.toast(`${name} didn’t save: ${err}`, { sticky: true, actions: [{ label: 'Retry', fn: commit }] });
      // The move and the pick wait for the save: the desk refuses a project it doesn't know yet (Codex review on #671).
      if (forItem) store.setProject(forItem.id, id);
      // Only picking it in a Start sheet needs that sheet still open; opening the project goes ahead (Codex review on #671).
      if (!existing && (then !== 'startWork' || (store.state.startWork?.commandId ?? null) === sheet)) onCreated?.(id);
    };
    done();
    void commit();
  };
  const remove = async () => {
    // Its conversations keep the id, and with no project of that id they list on their own again.
    const name = existing.name;
    const commit = async () => {
      // From the projects as they are at each try: a Retry after another screen's save keeps its edits (Codex review on #671).
      const err = await store.saveProjects((list) => withoutProject(list, existing.id));
      if (err) store.toast(`${name} wasn’t deleted: ${err}`, { sticky: true, actions: [{ label: 'Retry', fn: commit }] });
    };
    if (state.listProject === existing.id) store.openProject(null);
    done();
    void commit();
  };
  if (editing !== 'new' && !existing) return html`<p class="note">This project is gone (deleted on another screen?).</p>`;
  return html`
    ${error ? html`<p class="warn" role="alert">${error}</p>` : null}
    <div class="ve-form">
      <label class="ve-field"><span class="ve-k">Name</span><input type="text" maxlength="60" placeholder="Project name" value=${d.name} onInput=${(e) => put({ name: e.currentTarget.value })}
        onKeyDown=${(e) => e.key === 'Enter' && !e.isComposing && d.name.trim() && (e.preventDefault(), save())}
        ref=${nameRef} /></label>
      <div class="ve-field"><span class="ve-k">Icon</span><${ProjectTile} project=${{ ...d, name: d.name || '?' }} big=${true} /></div>
      <div class="ve-field ve-icons"><span class="ve-k"></span><${IconPicker} store=${store} value=${d.icon} color=${ICON_COLORS[d.color]} onPick=${(icon) => put({ icon })} /></div>
      <div class="ve-field"><span class="ve-k">Color</span>
        <span class="pe-swatches" role="group" aria-label="Color">
          ${Object.entries(ICON_COLORS).map(([key, color]) => html`<button type="button" class=${d.color === key ? 'on' : ''} style=${`--c:${color}`} aria-label=${key} aria-pressed=${d.color === key} onClick=${() => put({ color: key })}></button>`)}
        </span>
      </div>
      <label class="ve-field"><span class="ve-k">About</span><input type="text" maxlength="300" placeholder="One line on what it’s for" value=${d.about} onInput=${(e) => put({ about: e.currentTarget.value })} /></label>
      ${choices.length > 1
        ? html`<label class="ve-field"><span class="ve-k">Inside</span><select aria-label="Inside" value=${d.parent} onChange=${(e) => put({ parent: e.currentTarget.value })}>
            ${choices.map((c) => html`<option value=${c.value || ''}>${c.kind === 'agent' ? `${c.label} (agent)` : c.label}</option>`)}
          </select></label>`
        : null}
      <label class="ve-field"><span class="ve-k">Linear</span><input type="text" placeholder="Optional: a linear.app project link" value=${d.linearUrl} onInput=${(e) => put({ linearUrl: e.currentTarget.value })} /></label>
      ${forItem ? html`<p class="note">“${rowTitle(forItem)}” moves into it.</p>` : null}
      ${!existing && then === 'startWork' ? html`<p class="note">The new thread starts in it.</p>` : null}
    </div>
    <div class=${inSettings ? 'stg-foot' : 'foot'}>
      ${existing
        ? deleting
          ? html`<span class="stg-confirm">Delete ${existing.name}? Its conversations list on their own. <button class="linkish danger" onClick=${remove}>Delete</button> <button class="linkish" onClick=${() => setDeleting(false)}>Keep</button></span>`
          : html`<button class="btn sm ghost danger" onClick=${() => setDeleting(true)}>Delete project</button>`
        : null}
      <span class="spacer"></span>
      <button class="btn sm ghost" onClick=${done}>Cancel</button>
      <button class="btn sm pri" disabled=${!d.name.trim()} onClick=${save}>${existing ? 'Save' : 'Create project'}</button>
    </div>`;
}

/**
 * Opens the project dialog on a new project. `then` is what happens once it's made: 'startWork' picks it on
 * the open Start work sheet, 'next' opens its page in the next layout, 'list' opens it on the List.
 */
export function newProject(store, { forItem = null, then = null, parent = null } = {}) {
  store.set({ projectEditor: { editing: 'new', forItem, then, ...(parent ? { parent } : {}) } });
}

/** What the dialog does with a project it just made (see `newProject`). */
export function afterNewProject(store, then, id) {
  // The same place as the chip would pick: a project made inside an agent's space is a thread with that agent (Codex review on #948).
  if (then === 'startWork') store.pickStartPlace({ kind: 'project', id });
  else if (then === 'next') store.nextGo({ page: 'project', id });
  else if (then === 'list') store.openProject(id);
}

/** The project dialog, from a row's or a folder's ⋯ menu, Start work, or a list of projects. */
export function ProjectEditor({ store, phone }) {
  const { state } = store;
  const open = state.projectEditor;
  if (!open) return null;
  const close = () => store.set({ projectEditor: null });
  const forItem = open.forItem ? state.byId[open.forItem] : null;
  const isNew = open.editing === 'new';
  return html`<div class="scrim" onClick=${close}>
    <div class=${`picker ve-pop pe-pop${phone ? ' sheet' : ''}`} role="dialog" aria-modal="true" aria-label=${isNew ? 'New project' : 'Edit project'} onClick=${(e) => e.stopPropagation()}
      onKeyDown=${(e) => e.key === 'Escape' && (e.stopPropagation(), close())}>
      <header class="drawer-h"><h2>${isNew ? 'New project' : 'Edit project'}</h2><button class="btn sm ghost" onClick=${close}>Cancel</button></header>
      <${ProjectForm} key=${open.editing} store=${store} editing=${open.editing} forItem=${forItem} then=${open.then} parent=${open.parent || null} onDone=${close} onCreated=${(id) => afterNewProject(store, open.then, id)} />
    </div>
  </div>`;
}

/** Finishing a project with conversations still open asks what happens to them first. */
export function FinishProjectDialog({ store, phone }) {
  const c = store.state.confirm;
  if (!c || c.kind !== 'finishProject') return null;
  const project = store.state.projects.find((p) => p.id === c.projectId);
  if (!project) return null;
  // A parent asks once about its open child projects too (docs/specs/spaces.md, Nesting): finish with it, or stay open
  // and move up. The question about open threads then covers every project being finished.
  const kids = (store.state.projects || []).filter((p) => p.parent === `project:${project.id}` && !p.finishedAt);
  // The pick lives on the dialog's own state (store.state.confirm), so each Finish starts at "finish them too".
  const withKids = !c.keepKids;
  const setWithKids = (on) => store.set({ confirm: { ...c, keepKids: !on } });
  const ending = [project.id, ...(withKids ? kids.map((k) => k.id) : [])];
  const open = ending.reduce((n, id) => n + store.projectItems(id, ['active', 'snoozed', 'parked']).length, 0);
  const close = () => store.set({ confirm: null });
  const children = kids.length ? (withKids ? 'finish' : 'keep') : undefined;
  const where = ending.length > 1 ? 'them' : 'it';
  return html`<div class="scrim" onClick=${close}>
    <div class=${`picker${phone ? ' sheet' : ''}`} role="alertdialog" aria-modal="true" aria-label=${`Finish ${project.name}?`} onClick=${(e) => e.stopPropagation()}>
      <h2>Finish ${project.name}?</h2>
      ${kids.length
        ? html`<div class="pe-kids" role="radiogroup" aria-label="Its projects">
            <p class="note">${kids.length === 1 ? `${kids[0].name} is inside it.` : `${kids.length} projects are inside it: ${kids.map((k) => k.name).join(', ')}.`}</p>
            <label><input type="radio" name="pe-kids" checked=${withKids} onChange=${() => setWithKids(true)} /> Finish ${kids.length === 1 ? 'it' : 'them'} too</label>
            <label><input type="radio" name="pe-kids" checked=${!withKids} onChange=${() => setWithKids(false)} /> Keep ${kids.length === 1 ? 'it' : 'them'} open, in your space</label>
          </div>`
        : null}
      <p class="note">${open ? `${open} conversation${open === 1 ? ' is' : 's are'} still open in ${where}. A turn that’s still running is left as it is.` : `Nothing in ${where} is open.`} ${ending.length > 1 ? 'They move' : 'It moves'} to History; reopen from Settings.</p>
      <div class="foot">
        <button class="btn pri" ref=${(n) => n && !n.dataset.f && (n.focus(), (n.dataset.f = '1'))} onClick=${() => store.finishProject(project.id, 'done', children)}>${open ? 'Mark them done and finish' : 'Finish'}</button>
        ${open ? html`<button class="btn" onClick=${() => store.finishProject(project.id, 'out', children)}>${project.parent?.startsWith('project:') ? 'Keep them open, in the project it’s inside' : 'Keep them open, on their own'}</button>` : null}
        <span class="spacer"></span>
        <button class="btn ghost" onClick=${close}>Cancel</button>
      </div>
    </div>
  </div>`;
}
