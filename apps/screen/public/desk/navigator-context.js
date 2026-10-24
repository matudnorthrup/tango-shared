import { threadPrs } from './next/pr-model.js';
import { nextListReport, agentsOf, threadTitle } from './next/model.js';
import { sameNavigatorAction, validNavigatorAction } from './navigator-actions.js';
export function navigatorContext(store) {
  const s = store.state, report = nextListReport(s), choices = [];
  const add = (op, target, label, confirmation, when) => choices.push({ action: { op, target, ...(when ? { when } : {}) }, label, confirmation });
  add('back', '', 'Go back', 'Back.');
  for (const [id, name] of [['inbox', 'Inbox'], ['catchup', 'Catch me up'], ['projects', 'Spaces'], ['agents', 'Agents']]) add('page', id, id === 'catchup' ? 'Catch me up (includes Decided for you)' : name, `Opened ${name}.`);
  const current = s.byId?.[s.presentation.itemId];
  if (current && threadPrs(current).length) add('page', 'prs', 'PRs / Pull requests for the current thread', 'Opened pull requests.');
  for (const tab of report.tabs) add('tab', tab.id, `${tab.name} tab`, `Opened ${tab.name}.`);
  if (!['system', 'spacesettings'].includes(report.place.page)) for (const view of report.views) add('view', view.id, `${view.name} view in ${report.place.name}`, `Opened ${view.name}.`);
  for (const [kind, spaces] of [['project', s.projects || []], ['agent', agentsOf(s.lists, s.now)]]) for (const space of spaces) add('space', `${kind}:${space.id}`, `${space.name} space`, `Opened ${space.name}.`);
  const visible = new Map(report.rows.filter(r => r.kind === 'item').map(r => [r.id, report.rows.indexOf(r) + 1]));
  const all = Object.values(s.byId || {});
  const items = [...all.filter(i => i.id === s.presentation.itemId || visible.has(i.id)), ...all.filter(i => i.id !== s.presentation.itemId && !visible.has(i.id))].slice(0, 120);
  for (const item of items) {
    const title = threadTitle(item), current = s.presentation.itemId === item.id;
    const label = `${title} · ${item.place || ''}${visible.has(item.id) ? ` · visible position ${visible.get(item.id)}` : ''}${current ? ' · current thread (this)' : ''}`.slice(0, 550);
    add('open', item.id, label, `Opened ${title}.`.slice(0, 300));
    for (const [op, line] of [['seen', 'Marked seen.'], ['unseen', 'Marked unseen.'], ['done', 'Marked done.'], ['pin', 'Pinned.'], ['unpin', 'Unpinned.']]) add(op, item.id, `${op}: ${label}`, line);
    for (const [when, name] of [['soon', 'later'], ['evening', 'this evening'], ['morning', 'tomorrow'], ['monday', 'next week'], ['agent_posts', 'until they post']]) add('snooze', item.id, `Snooze ${label} until ${name}`, `Snoozed until ${name}.`, when);
  }
  return { place: report.place.name, choices: choices.slice(0, 1500) };
}
export async function executeNavigator(store, resolution, context) {
  const a = resolution.action;
  if (!a) return true;
  if (!validNavigatorAction(a) || !context.choices.some(c => sameNavigatorAction(a, c.action))) return false;
  // Re-check the current catalog: deleted threads, tabs and spaces cannot become stale commands.
  if (!navigatorContext(store).choices.some(c => sameNavigatorAction(a, c.action))) return false;
  const navigate = fn => { fn(); return true; };
  if (a.op === 'open') return navigate(() => store.nextOpen(a.target));
  if (a.op === 'back') return navigate(() => store.nextBack());
  if (a.op === 'page' && a.target === 'prs') return navigate(() => {
    const id = store.state.presentation.itemId;
    store.set({ nextPrItem: id, nextPanel: { open: true, tab: 'prs' } });
    store.nextOpen(id);
  });
  if (a.op === 'page') return navigate(() => store.nextGo({ page: a.target }));
  if (a.op === 'tab') return navigate(() => store.nextGo({ page: 'inbox', view: a.target }));
  if (a.op === 'space') { const at = a.target.indexOf(':'); return navigate(() => store.nextGo({ page: a.target.slice(0, at), id: a.target.slice(at + 1) })); }
  if (a.op === 'view') return navigate(() => {
    const r = store.state.nextRoute;
    if (r.page === 'inbox') store.nextGo({ page: 'inbox', view: a.target });
    else store.setPageView(r.id ? `${r.page}:${r.id}` : r.page, a.target);
  });
  let result;
  if (a.op === 'done') result = await store.done(a.target);
  else if (a.op === 'pin' || a.op === 'unpin') result = await store.setPinned(a.target, a.op === 'pin');
  else if (a.op === 'snooze') {
    const choice = a.when === 'agent_posts' ? { args: { trigger: 'agent_posts' }, label: 'until they post' } : store.snoozeChoices(new Date()).find(c => c.key === a.when);
    if (!choice) return false;
    result = await store.quickSnooze(a.target, { args: choice.args, label: choice.label });
  } else result = await store.command(a.op, a.target, store.guardFor(a.target));
  return result?.status === 'sent' && result?.outcome?.writeback?.outcome !== 'failed';
}
