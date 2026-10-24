// The parts of catchup-model.js the server reads (server/desk/catchup-walk.ts): loosely typed, the browser's own shapes.
type Space = { spaceId: string; name: string; route: { page: string; id?: string; view?: string }; needs: number; moments: number; smaller: number; state: string; headline: string | null; lastAt: number; since: number | null };
type Line = { id: number; kind: string; moment: boolean; title: string; raw?: string; detail?: string | null; briefId?: string | null; itemId?: string | null; decisionId?: string | null; at: number; waiting?: boolean; note?: string };
type Entry = { data?: { lines: unknown[]; waiting?: unknown[]; view?: { titles?: Record<string, string>; tidy?: unknown }; tidied?: unknown[] } } | undefined;
type Tidy = { elsewhere: Array<Line & { where: string | null }> };
export function catchupSpaces(state: { catchup: { data: unknown[] }; nextOrder?: 'newest' | 'oldest' }, places: { projects: Array<{ id: string; name: string }>; agents: Array<{ id: string; name: string }> }): Space[];
export function catchupMap(spaces: Space[], done?: Record<string, { at: number }>): { needs: Space[]; look: Space[]; smaller: Space[] };
export function openLines(entry: Entry, lineLocal?: Record<number, boolean>, now?: number): Line[] | null;
export function rowSummary(chapter: Space, lines?: Line[] | null, tidy?: Tidy | null): string;
export function tidyLines(entry: Entry, lineLocal?: Record<number, boolean>): Tidy | null;
export function focusOf(spaces: Space[], chapters: Record<string, Entry>, options?: { lineLocal?: Record<number, boolean>; skipped?: number[]; focusId?: number | null; done?: Record<string, { at: number }> }): { space: Space; line: Line } | null;

export function catchupNeedsOwner(item: { status?: { countsForOwner?: boolean } }): boolean;
