// Shapes shared by desk-e2e.ts and its scenario files (the owner's own set lives outside the repo).

export type E2eRecord = { kind: string; data: any };

export interface E2eRun {
  rec: E2eRecord[];
  /** Every router answer, in order. */
  actions: any[][];
  /** What the voice model would have been told to say. */
  said: string[];
  screen: { state: any; presented: any };
  /** The List report after the last phrase, and before the first. */
  list: any;
  startList: any;
}

export interface DeskE2eScenario {
  id: string;
  group: string;
  phrases: string[];
  /** The List's route before the first phrase (default the Inbox's Top view). */
  route?: any;
  /** What the screen shows before the first phrase (default the List). */
  presentation?: any;
  /** How long the owner has been quiet before the first phrase (default 10 s). */
  quietMs?: number;
  /** Wait until the operator says this before the last phrase (a confirm). */
  waitSaid?: RegExp;
  /** Role-played agent answers, by agent id, one per turn: the simulated agent answers with these, and the silent
   *  voice model "speaks" each relay so it counts as heard (follow-up scenarios). Nothing reaches a real agent. */
  agentAnswers?: Record<string, string[]>;
  expects: string;
  check: (r: E2eRun) => { result: 'pass' | 'fail'; detail: string };
}

export interface E2eContext {
  /** The List report for a route, from the snapshot. */
  listReport: (route: any) => any;
  active: any[];
  settings: any;
  /** The check helpers below, so a scenario file outside the repo needs no import. */
  h: typeof helpers;
  /** The desk's own browser model (apps/screen/public/desk/next/model.js): an oracle for what the desk shows. */
  model: { tallyOf: (items: unknown[], now?: number) => { waiting: number } };
}

export interface E2eScenarioModule {
  scenarios: (ctx: E2eContext) => DeskE2eScenario[];
}

// ── helpers for checks ──
export const cmds = (r: E2eRun, type?: string) => r.rec.filter((x) => x.kind === 'desk.command' && (!type || x.data.type === type)).map((x) => x.data);
export const screenCmds = (r: E2eRun) => r.rec.filter((x) => x.kind === 'screen.command').map((x) => x.data);
export const presented = (r: E2eRun) => r.rec.filter((x) => x.kind === 'screen.present').map((x) => x.data);
export const opened = (r: E2eRun) => presented(r).filter((p) => p.view === 'conversation').map((p) => p.itemId as string);
export const actionsLine = (r: E2eRun) => JSON.stringify(r.actions.flat().map((a: any) => ({ type: a.type, op: a.op ?? a.deskOp ?? a.screenOp ?? a.draftOp, item: a.item, target: a.target ?? a.option, agent: a.agentId })));
export const placeOf = (r: E2eRun) => JSON.stringify({ page: r.list.place?.page, id: r.list.place?.id, view: r.list.place?.view ?? r.list.tab?.id });
export const rowAt = (page: any, n: number | 'last') => (n === 'last' ? page.rows.at(-1)?.id : page.rows[n - 1]?.id);
export const verdict = (ok: boolean, detail: string) => ({ result: ok ? ('pass' as const) : ('fail' as const), detail });

export const helpers = { cmds, screenCmds, presented, opened, actionsLine, placeOf, rowAt, verdict };
