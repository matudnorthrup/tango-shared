import { parsePrUrl } from './artifacts.js';
import type { DeskCore } from './core.js';
import { checksFact, reviewFact, defaultExec, type Exec } from './source-github.js';
import type { DeskItem, ThreadPr } from './types.js';

const NOT_FOUND_RETRY_MS = 6 * 60 * 60_000;
const FIVE_MINUTES = 5 * 60_000;
const relationRank = { opened: 0, worker: 1, watched: 2, mentioned: 3 };
const stateRank = { open: 0, draft: 1, merged: 2, closed: 3 };
const key = (url: string) => url.toLowerCase();
export const sortThreadPrs = (prs: ThreadPr[]): ThreadPr[] => [...prs].sort((a, b) => relationRank[a.relation] - relationRank[b.relation] || stateRank[a.state] - stateRank[b.state] || b.firstSeenAt - a.firstSeenAt || a.url.localeCompare(b.url));
export const prUrls = (text: string): string[] => (text.match(/https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/gi) ?? []).flatMap(url => parsePrUrl(url)?.url ?? []);

/** Membership only grows, and discovering a weaker relation never overwrites ownership. */
export function addThreadPr(prs: ThreadPr[], url: string, relation: ThreadPr['relation'], now: number, via?: ThreadPr['via']): void {
  const parsed = parsePrUrl(url);
  if (!parsed) return;
  const existing = prs.find(pr => key(pr.url) === key(parsed.url));
  if (existing) {
    if (relationRank[relation] < relationRank[existing.relation]) {
      existing.relation = relation;
      delete existing.via;
      if (relation === 'worker' && via) existing.via = via;
    }
    return;
  }
  prs.push({ ...parsed, repo: new URL(parsed.url).pathname.split('/').slice(1, 3).join('/'), title: null, state: 'open', review: null, checks: null, relation, ...(via ? { via } : {}), watched: false, firstSeenAt: now, checkedAt: null });
}

/** Roll up only PRs actually opened by a descendant, retaining the original opener. */
export function rollupThreadPrs(items: DeskItem[], lists: Map<string, ThreadPr[]>, title: (item: DeskItem) => string): void {
  const byId = new Map(items.map(item => [item.id, item]));
  for (const item of items) {
    const opened = (lists.get(item.id) ?? []).filter(pr => pr.relation === 'opened');
    const seen = new Set([item.id]);
    let parent = item.facts.parentItemId;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const lead = byId.get(parent);
      if (!lead) break;
      for (const pr of opened) addThreadPr(lists.get(parent)!, pr.url, 'worker', pr.firstSeenAt, { itemId: item.id, title: title(item) });
      parent = lead.facts.parentItemId;
    }
  }
}

/** Require complete creation-time evidence before deciding uniqueness; keep promoted candidates in later passes. */
export function backfillOpenedPrs(prs: ThreadPr[], effects: Array<{ at: number }>, createdAt: (url: string) => number | null): void {
  const candidates = prs.filter(pr => pr.relation === 'mentioned' || pr.relation === 'opened');
  if (candidates.some(pr => createdAt(pr.url) === null)) return;
  for (const effect of effects) {
    const matches = candidates.filter(pr => Math.abs(createdAt(pr.url)! - effect.at) <= 3 * 60_000);
    if (matches.length === 1) { matches[0]!.relation = 'opened'; delete matches[0]!.via; }
  }
}

const fields = `state isDraft title createdAt reviewDecision mergedAt closedAt commits(last:1) { nodes { commit { statusCheckRollup { state } } } }`;
type GhNode = { state: string; isDraft?: boolean; title: string; createdAt?: string; reviewDecision?: string; mergedAt?: string; closedAt?: string; commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: { state?: string } | null } }> } };


/** Display-only: never sets status facts, posts feed entries, or wakes a thread. */
export class DeskThreadPrs {
  private running: Promise<void> | null = null;
  private again = false;
  private readonly exec: Exec;
  private readonly now: () => number;
  constructor(private readonly options: { core: DeskCore; exec?: Exec; now?: () => number }) {
    this.exec = options.exec ?? defaultExec;
    this.now = options.now ?? Date.now;
  }
  poll(): Promise<void> {
    this.again = true;
    this.running ??= Promise.resolve().then(async () => { while (this.again) { this.again = false; await this.once(); } }).finally(() => { this.running = null; });
    return this.running;
  }
  private async once(): Promise<void> {
    const { core } = this.options;
    const now = this.now();
    // Include archived/hidden rows and space coordinators, which core.items() omits.
    const roles = core.roles.all();
    const items = core.store.deskItems().map(item => ({ ...item, facts: { ...item.facts, ...roles.get(item.id) } }));
    const lists = new Map(items.map(item => [item.id, structuredClone(item.prs ?? [])]));
    // Row order catches historical backfills too. The store rewinds this cursor for repaired text.
    const cursor = Number(core.store.marker('thread-prs:messages') ?? 0);
    const end = (core.store.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM desk_messages').get() as { n: number }).n;
    const messages = core.store.db.prepare("SELECT item_id, text, at FROM desk_messages WHERE rowid > ? AND rowid <= ? AND author = 'agent' AND text LIKE '%github.com%/pull/%'").all(cursor, end) as unknown as Array<{ item_id: string; text: string; at: number }>;
    for (const message of messages) {
      const list = lists.get(message.item_id);
      if (list) for (const url of prUrls(message.text)) addThreadPr(list, url, 'mentioned', message.at);
    }
    // Save membership before advancing the cursor, and before any await can accept more messages.
    for (const [id, prs] of lists) core.setFacts(id, {}, { prs: sortThreadPrs(prs) });
    core.store.setMarker('thread-prs:messages', String(end));
    const watchedByItem = new Map<string, Set<string>>();
    for (const item of items) {
      const list = lists.get(item.id)!;
      for (const url of item.facts.openedPrUrls ?? []) addThreadPr(list, url, 'opened', now);
      const watched = new Set<string>();
      for (const watch of item.facts.prWatches ?? []) watched.add(key(watch.url));
      for (const wait of item.facts.waits ?? []) if (wait.kind === 'pr') for (const url of prUrls(wait.prUrl ?? wait.target)) watched.add(key(url));
      watchedByItem.set(item.id, watched);
      for (const url of watched) addThreadPr(list, url, 'watched', now);
      for (const pr of list) pr.watched = watched.has(key(pr.url));
      const branch = item.facts.prBranch;
      const marker = `thread-prs:branch:${item.id}`;
      if (branch && !list.some(pr => pr.relation === 'opened') && now - Number(core.store.marker(marker) ?? -Infinity) >= FIVE_MINUTES) {
        core.store.setMarker(marker, String(now));
        try {
          const remote = (await this.exec('git', ['-C', branch.cwd, 'remote', 'get-url', 'origin'])).trim();
          const repo = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote)?.[1];
          if (repo) {
            const found = JSON.parse(await this.exec('gh', ['pr', 'list', '--head', branch.branch, '--repo', repo, '--state', 'all', '--json', 'url'])) as Array<{ url: string }>;
            for (const pr of found) addThreadPr(list, pr.url, 'opened', now);
          }
        } catch { /* Retry discovery on the next scheduled pass; membership is retained. */ }
      }
    }
    rollupThreadPrs(items, lists, item => core.title(item));
    // A worker watching its PR also covers the copy shown on its lead.
    const watchedHere = (id: string, pr: ThreadPr) => !!watchedByItem.get(id)?.has(key(pr.url)) || (pr.relation === 'worker' && !!pr.via && !!watchedByItem.get(pr.via.itemId)?.has(key(pr.url)));
    for (const [id, prs] of lists) for (const pr of prs) pr.watched = watchedHere(id, pr);
    // Persist membership before I/O so a failed API read cannot lose it.
    const save = () => {
      for (const [id, prs] of lists) core.setFacts(id, {}, { prs: sortThreadPrs(prs) });
      core.flush();
    };
    save();
    const creationKey = (url: string) => `thread-prs:created:${key(url)}`;
    const creationTime = (url: string): number | null => {
      const value = core.store.marker(creationKey(url));
      return value !== null && Number.isFinite(Number(value)) ? Number(value) : null;
    };
    // Older cached terminal PRs need one metadata read only when legacy ownership needs it.
    const needsCreationTime = new Set(items.filter(item => item.facts.legacyPrCreates?.length).flatMap(item =>
      lists.get(item.id)!.filter(pr => (pr.relation === 'mentioned' || pr.relation === 'opened') && core.store.marker(creationKey(pr.url)) === null).map(pr => key(pr.url))));
    const targets = new Map<string, ThreadPr[]>();
    // The latest turn end or merge on any thread that owns or watches the PR, including a worker's on its lead's copy.
    const refreshAt = new Map<string, number>();
    for (const item of items) for (const pr of lists.get(item.id)!) {
      targets.set(key(pr.url), [...(targets.get(key(pr.url)) ?? []), pr]);
      // A mention is someone else's PR: this thread's turns say nothing about it.
      if (pr.relation !== 'mentioned') refreshAt.set(key(pr.url), Math.max(refreshAt.get(key(pr.url)) ?? 0, item.facts.prRefreshAt ?? 0));
    }
    const due: Array<{ copies: ThreadPr[]; pr: ThreadPr }> = [];
    for (const copies of targets.values()) {
      const pr = [...copies].sort((a, b) => Number(['merged', 'closed'].includes(b.state)) - Number(['merged', 'closed'].includes(a.state)) || (b.checkedAt ?? 0) - (a.checkedAt ?? 0))[0]!;
      // Share observations across threads without sharing their relation or watch membership.
      for (const copy of copies) this.observe(copy, pr);
      const metadataMissing = needsCreationTime.has(key(pr.url));
      if ((pr.state === 'merged' || pr.state === 'closed') && !metadataMissing) continue;
      if (now < Number(core.store.marker(`thread-prs:retry:${key(pr.url)}`) ?? 0)) continue;
      const interval = copies.every(p => p.relation === 'mentioned') ? 30 * 60_000 : FIVE_MINUTES;
      const attempt = Number(core.store.marker(`thread-prs:read:${key(pr.url)}`) ?? -Infinity);
      const last = Math.max(attempt, pr.checkedAt ?? -Infinity);
      // Once per turn end or merge: a read at or after it (even one that still saw it open, as with auto-merge) settles it.
      const prompted = !metadataMissing && Math.min(now, refreshAt.get(key(pr.url)) ?? 0) > last;
      if (prompted || (metadataMissing ? now - attempt >= interval : now - last >= interval)) due.push({ copies, pr });
    }
    for (let start = 0; start < due.length; start += 25) {
      const batch = due.slice(start, start + 25);
      const query = `{ ${batch.map(({ pr }, i) => { const [owner, name] = pr.repo.split('/'); return `p${i}: repository(owner:${JSON.stringify(owner)}, name:${JSON.stringify(name)}) { pullRequest(number:${pr.number}) { ${fields} } }`; }).join(' ')} }`;
      for (const { pr } of batch) core.store.setMarker(`thread-prs:read:${key(pr.url)}`, String(now));
      try {
        const response = await this.readGraphql(query) as { data?: Record<string, { pullRequest?: GhNode } | null>; errors?: Array<{ type?: string; message?: string; path?: string[] }> };
        for (const [i, { copies, pr }] of batch.entries()) {
          const node = response.data?.[`p${i}`]?.pullRequest;
          const errors = response.errors?.filter(e => !e.path || e.path[0] === `p${i}`);
          if (!node || errors?.length || !['OPEN', 'MERGED', 'CLOSED'].includes(node.state)) {
            if (errors?.some(e => e.type === 'NOT_FOUND')) core.store.setMarker(`thread-prs:retry:${key(pr.url)}`, String(now + NOT_FOUND_RETRY_MS));
            for (const copy of copies) copy.error = errors?.map(e => e.message || e.type).join('; ') || 'GitHub returned no pull request';
            continue;
          }
          core.store.deleteMarker(`thread-prs:retry:${key(pr.url)}`);
          const created = Date.parse(node.createdAt ?? '');
          core.store.setMarker(creationKey(pr.url), Number.isFinite(created) ? String(created) : 'unavailable');
          const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup;
          // The aggregate uses the same status states as a commit status; reuse the shared mapper.
          const fact = { ...node, statusCheckRollup: rollup?.state ? [{ __typename: 'StatusContext', state: rollup.state }] : [] };
          const observed: ThreadPr = { ...pr, title: node.title, state: node.state === 'MERGED' ? 'merged' : node.state === 'CLOSED' ? 'closed' : node.isDraft ? 'draft' : 'open', review: reviewFact(fact, pr.number, null, now)?.state ?? null, checks: checksFact(fact, pr.number)?.state ?? null, checkedAt: now };
          delete observed.error;
          if (node.mergedAt) observed.mergedAt = Date.parse(node.mergedAt);
          if (node.closedAt) observed.closedAt = Date.parse(node.closedAt);
          for (const copy of copies) this.observe(copy, observed);
        }
      } catch (error) { for (const { copies } of batch) for (const copy of copies) copy.error = String(error); }
    }
    for (const item of items) backfillOpenedPrs(lists.get(item.id)!, item.facts.legacyPrCreates ?? [], creationTime);
    rollupThreadPrs(items, lists, item => core.title(item));
    for (const [id, prs] of lists) for (const pr of prs) {
      const observed = targets.get(key(pr.url))?.[0];
      if (observed) this.observe(pr, observed);
      pr.watched = watchedHere(id, pr);
    }
    save();
  }
  private async readGraphql(query: string): Promise<unknown> {
    let stdout: string;
    try { stdout = await this.exec('gh', ['api', 'graphql', '-f', `query=${query}`]); }
    catch (error) {
      // gh exits 1 for alias-local GraphQL errors while stdout still contains successful aliases.
      const partial = error && typeof error === 'object' && 'stdout' in error ? error.stdout : undefined;
      if (typeof partial === 'string' || Buffer.isBuffer(partial)) {
        try { return JSON.parse(String(partial)); } catch { /* Preserve the original process error. */ }
      }
      throw error;
    }
    return JSON.parse(stdout);
  }
  private observe(target: ThreadPr, source: ThreadPr): void {
    const { title, state, review, checks, checkedAt, error, mergedAt, closedAt } = source;
    Object.assign(target, { title, state, review, checks, checkedAt });
    delete target.error; delete target.mergedAt; delete target.closedAt;
    if (error) target.error = error;
    if (mergedAt !== undefined) target.mergedAt = mergedAt;
    if (closedAt !== undefined) target.closedAt = closedAt;
  }
}
