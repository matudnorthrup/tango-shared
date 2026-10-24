// The owner's feature flags (desk setting `flags`, every screen): a way to live without a feature for a while
// and bring it back from Settings → Flags. A flag hides the feature, never its data, so turning it on again
// shows everything as it was.

/**
 *   stageLabels  Discovery / Building / Feedback on rows, the thread header, menus, filters and stage grouping.
 *                Off while the owner tries the desk without them (10/21); stages are still kept on each thread.
 */
export interface DeskFlags {
  stageLabels: boolean;
}
export const DEFAULT_FLAGS: DeskFlags = { stageLabels: false };

export function readFlags(raw: string | null | undefined): DeskFlags {
  try {
    const parsed = raw ? (JSON.parse(raw) as Partial<DeskFlags>) : {};
    return { stageLabels: typeof parsed.stageLabels === 'boolean' ? parsed.stageLabels : DEFAULT_FLAGS.stageLabels };
  } catch {
    return { ...DEFAULT_FLAGS };
  }
}

export function parseFlags(value: unknown, current: DeskFlags): { flags: DeskFlags } | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'flags must be an object' };
  const v = value as Record<string, unknown>;
  const unknown = Object.keys(v).find((key) => !(key in DEFAULT_FLAGS));
  if (unknown) return { error: `unknown flag ${unknown}` };
  if (v.stageLabels !== undefined && typeof v.stageLabels !== 'boolean') return { error: 'flags.stageLabels must be true or false' };
  return { flags: { stageLabels: typeof v.stageLabels === 'boolean' ? v.stageLabels : current.stageLabels } };
}
