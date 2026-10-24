// The next layout's right-click menus: one at a time, drawn by the shell at the pointer. A thread gets its ⋯
// menu with Open first; a project or an agent gets its page's ⋯ with Open and New thread first; an Inbox
// view gets its tab's settings.

import { html } from '../../vendor/preact-htm.js';
import { currentItem } from '../conversation.js';
import { spaceViewDefs, agentsOf, inboxViews, threadTitle } from './model.js';
import { Menu } from './menu.js';
import { MENU_ICONS as MI } from './icons.js';
import { agentMenu, projectMenu } from './pages.js';
import { threadMenu } from './thread.js';
import { countOf, selectedOf, selectionMenu } from './select.js';

/** The items and title for a right-click's target, or null when it's gone. */
export function contextItems(target, store) {
  const { state } = store;
  // A selected row while its list is a picker: the actions for the whole selection.
  const sel = state.nextSelect;
  if (sel && sel.kind === target.kind && sel.ids.includes(target.id)) {
    const n = selectedOf(state).length;
    if (n) return { title: countOf(sel.kind, n), items: selectionMenu(store) };
  }
  // Select, on a list (not the open thread's own title, nor the sidebar's places).
  const onList = !store.threadOpen() && !target.fromSidebar;
  const select = (kind) => ({ icon: MI.select, label: 'Select', hint: 'x', onSelect: () => (sel?.kind === kind ? store.nextSelectToggle(target.id) : store.nextSelectStart(kind, target.id)) });
  if (target.kind === 'thread') {
    const cur = currentItem(state);
    const item = cur?.id === target.id ? cur : state.byId[target.id];
    if (!item) return null;
    const here = store.threadOpen() && state.presentation.itemId === item.id;
    const open = () => store.nextOpen(item.id);
    const items = threadMenu(item, store, { onReply: () => (here || open(), store.openReply(item.id)) });
    return { title: threadTitle(item), items: here ? items : [{ icon: MI.open, label: 'Open', onSelect: open }, ...(onList ? [select('thread')] : []), 'sep', ...items] };
  }
  if (target.kind === 'project') {
    const project = (state.projects || []).find((p) => p.id === target.id);
    if (!project) return null;
    const open = [
      { icon: MI.folder, label: 'Open project', onSelect: () => store.nextGo({ page: 'project', id: project.id }) },
      project.finishedAt ? null : { icon: MI.plus, label: `New thread in ${project.name}…`, onSelect: () => store.openStartWork({ projectId: project.id }) },
      onList && state.nextRoute?.page === 'projects' ? select('project') : null,
      'sep',
    ].filter(Boolean);
    return { title: project.name, items: [...open, ...projectMenu(project, store)] };
  }
  if (target.kind === 'agent') {
    const name = agentsOf(state.lists, state.now).find((a) => a.id === target.id)?.name || target.id;
    return { title: name, items: [{ icon: MI.open, label: `Open ${name}`, onSelect: () => store.nextGo({ page: 'agent', id: target.id }) }, { icon: MI.plus, label: `New thread with ${name}…`, onSelect: () => store.openStartWork({ agentId: target.id }) }, 'sep', ...agentMenu(target.id, name, store)] };
  }
  if (target.kind === 'spaceview') {
    const view = spaceViewDefs(state).find((v) => v.id === target.id);
    return view ? { title: view.name, items: [{ icon: MI.edit, label: 'Edit view', onSelect: () => store.openSettings('spaceviews', { tab: target.id }) }] } : null;
  }
  if (target.kind === 'view') {
    const view = inboxViews(state).find((v) => v.view.id === target.id)?.view;
    if (!view) return null;
    return {
      title: view.name,
      items: [
        { icon: MI.open, label: `Open ${view.name}`, onSelect: () => store.nextGo({ page: 'inbox', view: view.id }) },
        'sep',
        { icon: MI.edit, label: `Edit “${view.name}” tab…`, onSelect: () => store.openSettings('tabs', { tab: view.id }) },
        { icon: MI.sections, label: 'All tabs…', onSelect: () => store.openSettings('tabs') },
      ],
    };
  }
  return null;
}

/** The open right-click menu, if any. A newer right-click replaces it (and the older one's close is a no-op). */
export function ContextMenu({ store }) {
  const target = store.state.nextContext;
  if (!target) return null;
  const menu = contextItems(target, store);
  const close = () => store.state.nextContext?.n === target.n && store.set({ nextContext: null });
  if (!menu) return null;
  return html`<${Menu} key=${target.n} items=${menu.items} title=${menu.title} at=${{ x: target.x, y: target.y, key: target.key }} onClose=${close} />`;
}
