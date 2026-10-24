// The per-thread daily budget (docs/specs/loom-context-management.md, "Per-thread budget"): input tokens sent per
// local day, cache reads included. At 80% the thread starts fresh at its next seam, once a day; at 100% Loom holds
// its automatic turns (wakes, mail) until midnight. The owner's own turns always run.
import type { ThreadRole, ThreadRow } from "./store.js";
import { dayStart } from "./usage.js";

const M = 1_000_000;
export const BUDGET_DEFAULTS: Record<ThreadRole, number> = { interactive: 100 * M, worker: 100 * M, default: 150 * M, ops: 30 * M };
/** The share of the budget whose crossing starts the thread fresh at its next seam. */
export const BUDGET_FRESH_AT = 0.8;
/** What one Raise adds for the rest of the day: half the thread's budget. */
export const BUDGET_RAISE = 0.5;

/** Role defaults, each overridable by env: LOOM_BUDGET_INTERACTIVE, _WORKER, _DEFAULT, _OPS (tokens; 0 turns it off). */
export function budgetDefaults(env: NodeJS.ProcessEnv = process.env): Record<ThreadRole, number> {
  const out = { ...BUDGET_DEFAULTS };
  for (const role of Object.keys(out) as ThreadRole[]) {
    const raw = env[`LOOM_BUDGET_${role.toUpperCase()}`];
    if (raw !== undefined && raw !== "" && Number.isFinite(Number(raw)) && Number(raw) >= 0) out[role] = Number(raw);
  }
  return out;
}

/** A Raise for one day: tokens added to the budget until that local midnight's day ends. */
export interface BudgetRaise { day: number; extra: number }

export interface BudgetState {
  /** Today's budget, raises included; 0: no budget for this thread. */
  limit: number;
  /** The thread's own budget before raises (its override, else its role's default). */
  base: number;
  /** Input tokens sent today. */
  today: number;
  /** Raised today by this much. */
  raised: number;
  /** today / limit, 0 with no budget. */
  share: number;
  /** When the budget day ends: the next local midnight. */
  resetsAt: number;
}

export function nextMidnight(now: number): number {
  const day = new Date(dayStart(now));
  day.setDate(day.getDate() + 1);
  return day.getTime();
}

export function budgetState(thread: Pick<ThreadRow, "role" | "budget" | "budget_raise">, today: number, now: number, defaults: Record<ThreadRole, number>): BudgetState {
  const base = thread.budget ?? defaults[thread.role] ?? defaults.interactive;
  const raise = thread.budget_raise ? (JSON.parse(thread.budget_raise) as BudgetRaise) : null;
  const raised = raise && raise.day === dayStart(now) ? raise.extra : 0;
  const limit = base > 0 ? base + raised : 0;
  return { limit, base, today, raised, share: limit > 0 ? today / limit : 0, resetsAt: nextMidnight(now) };
}

/** The raise after one more Raise today: half the base again (a raise from an earlier day is spent). */
export function raised(thread: Pick<ThreadRow, "budget_raise">, base: number, now: number): BudgetRaise {
  const day = dayStart(now);
  const prior = thread.budget_raise ? (JSON.parse(thread.budget_raise) as BudgetRaise) : null;
  return { day, extra: (prior && prior.day === day ? prior.extra : 0) + Math.round(base * BUDGET_RAISE) };
}
