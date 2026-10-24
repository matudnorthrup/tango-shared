/**
 * Turn Briefing ("whisper") — per-turn behavioral guidance delivered to the
 * agent on EVERY turn, including resumed provider sessions.
 *
 * Unlike the warm-start `context` block (which is dropped once a Claude session
 * is resumed in-process, see omitContextForResumedRuntime), the briefing rides
 * the same channel as current-turn metadata and survives resume. It is the
 * place to carry:
 *   - a pointer to the active project state file (read-before / update-after)
 *   - a search-first reminder
 *   - context-window usage signals (and threshold/delta nudges)
 *
 * Keep it short: it is paid for on every turn. Empty input → undefined (no block).
 */

export interface TurnBriefingStateFile {
  /** Human + AI readable path to the state file (e.g. Obsidian note path). */
  path: string;
  /** Project title or id this state file represents. */
  project?: string;
  /** Current status (active|planning|waiting|deferred|...). */
  status?: string;
  /**
   * A short, LIVE snapshot of current state (e.g. the Quick Read), read from the
   * body every turn. Carrying it in the whisper means resumed turns reflect
   * mid-session updates without relying on the agent choosing to re-read.
   */
  snapshot?: string;
}

export interface TurnBriefingInput {
  /** Active project state file pointer, if this conversation maps to a project arc. */
  stateFile?: TurnBriefingStateFile;
  /** Fraction (0..1) of the context window used as of the previous turn. */
  contextUsageFraction?: number;
  /** Emit the "search first" reminder (default true). */
  searchFirst?: boolean;
  /** Threshold/delta/staleness nudges already formatted as short lines. */
  signals?: string[];
  /** Escape hatch for additional short lines. */
  extraLines?: string[];
  /** Compact canonical typed-state digest. Values here override memory. */
  stateDigest?: string;
}

function formatPercent(fraction: number): number {
  return Math.round(Math.max(0, Math.min(1, fraction)) * 100);
}

/**
 * Build the briefing prompt block, or undefined if there is nothing to say.
 */
export function buildTurnBriefingPrompt(input: TurnBriefingInput = {}): string | undefined {
  const lines: string[] = [];

  if (input.stateFile?.path?.trim()) {
    const meta = [
      input.stateFile.project ? `project: ${input.stateFile.project}` : null,
      input.stateFile.status ? `status: ${input.stateFile.status}` : null,
    ].filter(Boolean).join(", ");
    lines.push(
      `State file: ${input.stateFile.path.trim()}${meta ? ` (${meta})` : ""} `
      + `— update it after decisions or status changes.`,
    );
    if (input.stateFile.snapshot?.trim()) {
      lines.push(
        `Current state (live, trust this over earlier turns): ${input.stateFile.snapshot.trim()}`,
      );
    }
  }

  if (input.searchFirst !== false) {
    lines.push(
      "Search stored memory/state before answering anything that depends on prior "
      + "context; don't answer from stale assumptions.",
    );
  }

  if (typeof input.contextUsageFraction === "number" && Number.isFinite(input.contextUsageFraction)) {
    lines.push(`Context window: ~${formatPercent(input.contextUsageFraction)}% used.`);
  }

  if (input.signals?.length) {
    for (const s of input.signals) {
      if (s?.trim()) lines.push(s.trim());
    }
  }

  if (input.extraLines?.length) {
    for (const l of input.extraLines) {
      if (l?.trim()) lines.push(l.trim());
    }
  }

  const stateDigest = input.stateDigest?.trim();
  if (lines.length === 0 && !stateDigest) return undefined;

  return [
    "Session briefing (act on this every turn):",
    ...lines.map((l) => `- ${l}`),
    ...(stateDigest ? [stateDigest] : []),
  ].join("\n");
}
