import type { DeskQuery, QueryContext } from './query.js';
export type FeedScopeContext = QueryContext & { listViews?: object[] | null; flags?: { stageLabels?: boolean } };
export function feedScopeOf(value: unknown): string;
export function feedScopeQuery(scope: string, views?: object[] | null, flags?: { stageLabels?: boolean }): DeskQuery | null;
export function itemInFeedScope(item: object | undefined | null, scope: string, ctx?: FeedScopeContext): boolean;
export function postInFeedScope(post: { itemId?: string | null; projectId?: string | null } | null | undefined, item: object | undefined | null, scope: string, ctx?: FeedScopeContext): boolean;
export function scopedFeedPosts<T extends { itemId: string | null; projectId?: string | null }>(posts: T[], byId: Record<string, object>, scope: string, ctx?: FeedScopeContext): T[];
