export type FacetFilter = { in?: string[]; not?: string[]; unset?: boolean };
export type DeskQuery = { scope: { kind: 'global' } | { kind: 'space'; id: string; descendants?: boolean }; audience: 'owner' | 'all'; where: Record<string, FacetFilter>; text?: string };
export type QueryContext = { projects?: Array<{ id: string; parent?: string | null }>; now?: number; filters?: object };
export function personaId(id: string): string;
export function agentId(item: object): string | null;
export function itemRepo(item: object): string | null;
export function kindOf(item: object): string;
export function reachesOwner(item: object): boolean;
export function dispositionOf(item: object): string;
export const OPEN_DISPOSITIONS: readonly string[];
export function openOnly(query: DeskQuery): DeskQuery | null;
export function spaceOf(item: object, ctx?: QueryContext): string | null;
export const facets: Record<string, (item: object, ctx?: QueryContext) => string | string[] | null>;
export function matches(item: object, query: DeskQuery, ctx?: QueryContext): boolean;
export function countFor(items: object[], query: DeskQuery, ctx?: QueryContext): number;
export function facetCounts(items: object[], query: DeskQuery, facet: string, ctx?: QueryContext): Map<string | null, number>;
export function viewToQuery(view: object, options?: { audience?: 'owner' | 'all'; ignoreProjects?: boolean }): DeskQuery;
export function picksToQuery(picks?: Record<string, string[]>, none?: string): DeskQuery;
export function hideMatches(item: object, filters: object): Array<{ facet: 'agent' | 'repo' | 'type'; value: string }>;

export function hideFacets(items: object[], filters?: object): { agents: Array<{ id: string; name: string; count: number }>; repos: Array<{ name: string; count: number }>; types: Array<{ name: string; count: number }> };

export function waitOf(item: object): string | null;
export function overdueOf(item: object): string;
export function jobHealthOf(item: object, ctx?: QueryContext): string | null;
export function sourceOf(item: object): string | null;
export function accountOf(item: object): string | null;
export function ageOf(item: object, ctx?: QueryContext): string | null;

export function viewForFlags<T extends object>(view: T, flags?: { stageLabels?: boolean }, statusGroup?: string): T;
