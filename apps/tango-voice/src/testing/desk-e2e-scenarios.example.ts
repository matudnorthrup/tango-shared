// Example scenarios for desk-e2e.ts: phrases that need no conversation names, resolved against whatever
// desk the snapshot holds. The owner's full set (with real names) lives outside the repo; copy this file
// there to start one:  npm run lab:desk-e2e -w @tango/tango-voice -- --scenarios src/testing/desk-e2e-scenarios.example.ts

import type { DeskE2eScenario, E2eContext } from './desk-e2e-types.js';

export function scenarios(ctx: E2eContext): DeskE2eScenario[] {
  const { h, listReport, settings } = ctx;
  const space = settings.projects?.find((project: { finishedAt?: unknown }) => !project.finishedAt);
  const tabRows = (view: string) => listReport({ page: 'inbox', view }).rows;
  const LIST = 'The List';
  const CATCHUP = 'Catch me up';
  const walkFollows = (r: Parameters<typeof h.screenCmds>[0]) => h.screenCmds(r).filter((c: { name: string; args?: { page?: string } }) => c.name === 'list_place' && c.args?.page === 'catchup');
  const out: DeskE2eScenario[] = [
    { id: 'tab', group: LIST, phrases: ['show me the watching tab'], expects: 'Inbox → Watching', check: (r) => h.verdict(r.list.place?.page === 'inbox' && r.list.tab.id === 'watching', h.placeOf(r)) },
    { id: 'row-3', group: LIST, route: { page: 'inbox', view: 'active' }, phrases: ['open the third one'], expects: 'opens row 3', check: (r) => h.verdict(h.opened(r)[0] === h.rowAt(r.startList, 3), `opened ${h.opened(r)[0]} want ${h.rowAt(r.startList, 3)}`) },
    { id: 'row-last', group: LIST, route: { page: 'inbox', view: 'watching' }, phrases: ['open the last one'], expects: 'opens the last row', check: (r) => h.verdict(h.opened(r)[0] === h.rowAt(r.startList, 'last'), `opened ${h.opened(r)[0]} want ${h.rowAt(r.startList, 'last')}`) },
    { id: 'tab-then-row', group: LIST, phrases: ['show me Watching and open the second one'], expects: 'Watching, then its row 2', check: (r) => h.verdict(r.list.tab.id === 'watching' && h.opened(r)[0] === tabRows('watching')[1]?.id, `${h.placeOf(r)} opened ${h.opened(r)[0]}`) },
    { id: 'agents', group: LIST, phrases: ['show me the agents'], expects: 'Agents index', check: (r) => h.verdict(r.list.place?.page === 'agents', h.placeOf(r)) },
    { id: 'scroll', group: LIST, phrases: ['scroll down'], expects: 'scroll_down', check: (r) => h.verdict(h.screenCmds(r).some((c) => c.name === 'scroll_down'), JSON.stringify(h.screenCmds(r))) },
    { id: 'pause', group: 'Turn-taking', phrases: ['Yankee, pause'], expects: 'pause pill published', check: (r) => h.verdict(r.rec.some((x) => x.kind === 'desk.pause'), JSON.stringify(r.rec.filter((x) => x.kind === 'desk.pause').slice(-1))) },
    { id: 'for-me', group: 'Turn-taking', quietMs: 5 * 60_000, phrases: ['mark it done'], expects: "nothing open, 5 min quiet: asks 'For me?' before changing anything", check: (r) => h.verdict(h.cmds(r).length === 0 && r.said.some((s) => /for me/i.test(s)), `cmds ${JSON.stringify(h.cmds(r))}`) },
    // Catch me up walks the desk one moment at a time; the windows follow (list_place catchup). On a desk without the
    // update ledger it reads the old briefing, and these fail: they're for a desk that has it.
    { id: 'catchup-walk', group: CATCHUP, phrases: ['catch me up'], expects: 'the walk opens on its focus card and reads it; nothing acted on', check: (r) => h.verdict(walkFollows(r).length === 1 && r.said.length > 0 && h.cmds(r).length === 0, JSON.stringify(walkFollows(r))) },
    { id: 'catchup-next', group: CATCHUP, phrases: ['catch me up', 'next'], expects: 'on to the next moment: the one heard marked seen (a waiting brief never is)', check: (r) => h.verdict(walkFollows(r).length === 2 && h.cmds(r, 'respond').length === 0, JSON.stringify(walkFollows(r))) },
    { id: 'catchup-left', group: CATCHUP, phrases: ['catch me up', "what's left?"], expects: "the map read per space; the walk stays where it was", check: (r) => h.verdict(walkFollows(r).length === 1 && r.said.some((s) => /what's left/i.test(s)), r.said.at(-1) ?? '') },
  ];
  if (space) {
    out.push(
      { id: 'space-up', group: LIST, route: { page: 'project', id: space.id }, phrases: ['go back'], expects: 'up out of the space', check: (r) => h.verdict(r.list.place?.page !== 'project', h.placeOf(r)) },
      { id: 'space-inbox', group: LIST, route: { page: 'project', id: space.id }, phrases: ['go to the inbox'], expects: 'the Inbox', check: (r) => h.verdict(r.list.place?.page === 'inbox', h.placeOf(r)) },
      { id: 'space-view', group: LIST, route: { page: 'project', id: space.id }, phrases: ['show me the done view'], expects: "the space's Done view (when it has one)", check: (r) => h.verdict(!r.startList.views?.some((v: { id: string }) => v.id === 'done') || r.list.view?.id === 'done', `view ${r.list.view?.id}`) },
    );
  }
  return out;
}
