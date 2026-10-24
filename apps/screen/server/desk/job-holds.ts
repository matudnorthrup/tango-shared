import type { DeskCore } from './core.js';
import type { DeskFacts } from './types.js';

// A scheduled job runs in Loom threads the desk doesn't list; its row is the schedule's. Loom's hold on the newest
// run (account limits, disk) is kept here by the job's title, so the schedule source applies it whenever it files
// the row, even when Loom's snapshot arrived first (Codex review on #832).

const key = (title: string) => `jobHold:${title}`;

/** Loom's word on a job's newest run: held for a reason, or null once it isn't. */
export function recordJobHold(core: DeskCore, title: string, held: DeskFacts['held']): void {
  if (held) core.store.setMarker(key(title), JSON.stringify(held));
  else core.store.deleteMarker(key(title));
  applyJobHold(core, title);
}

/** The hold Loom reported for a job by its title, if any. */
export function jobHoldFor(core: DeskCore, title: string): DeskFacts['held'] {
  const raw = core.store.marker(key(title));
  try {
    return raw ? (JSON.parse(raw) as DeskFacts['held']) : null;
  } catch {
    return null;
  }
}

/**
 * Puts the hold on the one schedule row with that title. Loom's job threads carry only the title, so two schedules
 * that share one get none rather than each other's (Codex review on #832).
 */
export function applyJobHold(core: DeskCore, title: string): void {
  const rows = core.store.items().filter((item) => item.source === 'schedule' && item.place === title);
  if (rows.length !== 1) return;
  const held = jobHoldFor(core, title);
  if (JSON.stringify(rows[0]!.facts.held ?? null) !== JSON.stringify(held)) core.setFacts(rows[0]!.id, { held });
}
