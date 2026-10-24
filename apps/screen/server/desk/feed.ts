import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { deskStatus, stuckWaits } from './status.js';
import type { DeskItem } from './types.js';

// The desk's news feed: what changed across the desk, as posts a Screen window scrolls through
// (public/desk/feed.js). Not the List again: a post is something that happened (a thread's update in
// its own plain words, a project's status, a PR approved, a screen put up, work done), written when it
// happens, because the summaries and statuses it quotes are overwritten afterwards.
//
// Posts are kept as written; the owner's feed settings (chatter, needs-you posts) apply when they are
// read, so changing one changes the feed already posted too.

export type FeedKind = 'update' | 'started' | 'needs' | 'failed' | 'stuck' | 'decided' | 'shipped' | 'done' | 'project' | 'pr' | 'screen' | 'prototype' | 'mail' | 'system';
export const FEED_KINDS: readonly FeedKind[] = ['update', 'started', 'needs', 'failed', 'stuck', 'decided', 'shipped', 'done', 'project', 'pr', 'screen', 'prototype', 'mail', 'system'];

export interface FeedPost {
  seq: number;
  /** When it last changed (a coalesced post moves up). */
  at: number;
  firstAt: number;
  kind: FeedKind;
  itemId: string | null;
  projectId: string | null;
  agentName: string;
  title: string;
  text: string;
  /** How many happenings this post stands for (updates on one thread close together, mail in a day). */
  count: number;
  data: Record<string, unknown>;
}

export interface NewFeedPost {
  kind: FeedKind;
  itemId?: string | null;
  projectId?: string | null;
  agentName?: string;
  title: string;
  text?: string;
  data?: Record<string, unknown>;
  /** One thread's (or one pair's, one project's) posts share a key. */
  key?: string;
  /**
   * A state change (new thread, needs you, failed, done) and an update for the same key this close together
   * are one post: the update's words under the state's pill. Updates never merge into each other.
   */
  mergeMs?: number;
  /**
   * Posts with this key at most this often: one sooner is held, newest words kept, and posted when the time
   * comes. A change of state (a kind other than update, unlike the last post's) is never held.
   */
  throttleMs?: number;
  /** How many happenings this stands for (agent mail held in a throttle adds up). */
  count?: number;
  /** When it happened, if not now (the seed). */
  at?: number;
}

/**
 * The owner's choices (desk setting `feed`, every screen):
 *   chatter  agents mailing each other: `hidden`, or `shown` (one line per pair of threads, at most every few minutes)
 *   needsYou "Show answered asks": Needs you, Failed and Stuck posts always go out while open; off, one whose
 *            record has closed folds away (into its words as an update, when it carries some). Read in feed.js,
 *            which knows each row's status now.
 *   summaries "Summaries from threads that post updates": off, a thread that wrote its own update (desk_update)
 *            in the last day posts no Summary; its updates say what happened (feed-status.md "Leads").
 *   usage    "Account usage": the accounts' usage rings above the posts (feed-usage.js). On unless turned off.
 */
export interface FeedSettings {
  chatter: 'hidden' | 'shown';
  needsYou: boolean;
  summaries: boolean;
  usage?: boolean;
}
export const DEFAULT_FEED_SETTINGS: FeedSettings = { chatter: 'hidden', needsYou: false, summaries: false, usage: true };

export function readFeedSettings(raw: string | null | undefined): FeedSettings {
  try {
    const parsed = raw ? (JSON.parse(raw) as Partial<FeedSettings>) : {};
    // `daily` was the first name for showing it.
    const chatter = (parsed.chatter as string) === 'shown' || (parsed.chatter as string) === 'daily' ? 'shown' : 'hidden';
    return { chatter, needsYou: parsed.needsYou === true, summaries: parsed.summaries === true, usage: parsed.usage !== false };
  } catch {
    return { ...DEFAULT_FEED_SETTINGS };
  }
}

export function parseFeedSettings(value: unknown, current: FeedSettings): { settings: FeedSettings } | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'feed must be an object' };
  const v = value as Record<string, unknown>;
  if (v.chatter !== undefined && v.chatter !== 'hidden' && v.chatter !== 'shown') return { error: 'feed.chatter must be hidden or shown' };
  if (v.needsYou !== undefined && typeof v.needsYou !== 'boolean') return { error: 'feed.needsYou must be true or false' };
  if (v.summaries !== undefined && typeof v.summaries !== 'boolean') return { error: 'feed.summaries must be true or false' };
  if (v.usage !== undefined && typeof v.usage !== 'boolean') return { error: 'feed.usage must be true or false' };
  return { settings: { chatter: (v.chatter as FeedSettings['chatter']) ?? current.chatter, needsYou: (v.needsYou as boolean) ?? current.needsYou, summaries: (v.summaries as boolean) ?? current.summaries, usage: (v.usage as boolean) ?? current.usage !== false } };
}

/** Kept this long: the feed is what's new, not an archive (the threads keep their own history). */
const KEEP_MS = 14 * 24 * 3600_000;
const MAX_TEXT = 600;
/** A thread's state, as a post's kind: a change to one is news at once. */
const THREAD_STATES: ReadonlySet<FeedKind> = new Set(['needs', 'failed', 'stuck', 'done']);
/** Rows read per page when the feed is read back. */
const PAGE = 200;
/** Ledger posts about one PR fold together this long (a lead's update, the merge, the routine decisions). */
const LEDGER_FOLD_MS = 24 * 3600_000;
/** Two posts on one thread this close together: the missed-repeat log's pair (feed-status.md "Checking it"). */
const REPEAT_LOG_MS = 20 * 60_000;

/**
 * A post from a catch-up ledger row (desk/updates.ts; feed-status.md "Feed and catch-up"). `ref` names the row
 * (`ledger:<id>`), so it posts once. `rank` says whose words stand when rows fold: a lead's (3) over a merged PR's
 * (2) over a decision's (1). `pr`: the post's key is a PR's (`pr:owner/repo#N`), and its rows fold by the PR.
 */
export interface LedgerPostInput {
  post: NewFeedPost & { key: string };
  ref: string;
  rank: number;
  pr: boolean;
  /** The ref of the line this one replaces (`ledger:<id>`), whose post it takes over even under another key. */
  replaces?: string | null;
}

interface Row {
  seq: number;
  at: number;
  first_at: number;
  kind: string;
  item_id: string | null;
  project_id: string | null;
  agent_name: string;
  title: string;
  text: string;
  count: number;
  key: string | null;
  data: string;
}

const clip = (text: string) => {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
};

/** When a post went out, or its words last changed in place. */
const EFFECTIVE_AT = "MAX(at, COALESCE(json_extract(data, '$.changedAt'), 0))";
/** When it was last written, in write order (see DeskFeed.nextRev). */
const REV = "COALESCE(json_extract(data, '$.rev'), seq)";

export class DeskFeed {
  private readonly listeners = new Set<(post: FeedPost) => void>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS desk_feed (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        first_at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        item_id TEXT,
        project_id TEXT,
        agent_name TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL DEFAULT '',
        count INTEGER NOT NULL DEFAULT 1,
        key TEXT,
        data TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS desk_feed_at ON desk_feed(at);
      CREATE INDEX IF NOT EXISTS desk_feed_key ON desk_feed(key, at);
    `);
  }

  /** Writes a post (or folds it into the last one with its key) and tells the screens. Never throws. */
  post(input: NewFeedPost): FeedPost | null {
    try {
      const at = input.at ?? this.now();
      if (input.key) {
        const last = this.db.prepare('SELECT * FROM desk_feed WHERE key = ? ORDER BY at DESC, seq DESC LIMIT 1').get(input.key) as Row | undefined;
        // A post carries a thread's words when it is an update or a state change that took one. A state change
        // takes one update: words arriving for a post that already carries some are news of their own. A bare
        // turn to the owner (or a failure) joins only a post without words, so it never relabels an earlier
        // update; Done, the owner's own act, may (Codex review on #631).
        const lastCarries = last ? last.kind === 'update' || !!toPost(last).data.update : false;
        const carries = input.kind === 'update' || !!input.data?.update;
        // A bare state change from the same summary as the last post (an update) is that post: a turn settling into
        // "needs you" relabels its own update. Never between two updates, and only that summary's update, by its
        // content key (Codex review on #648).
        const key = input.data?.contentKey;
        const same = !carries && last?.kind === 'update' && typeof key === 'string' && !!key && toPost(last).data.contentKey === key;
        const joins = same || (carries ? !lastCarries : input.kind === 'done' || !lastCarries);
        if (last && input.mergeMs && at - last.at <= input.mergeMs && joins) {
          this.dropHeld(input.key);
          return this.merge(last, input, at);
        }
        // A change of state (to needs you, failed, done) is news at once; more of the same state waits its turn
        // like any update (two "needs you" summaries a minute apart were two posts).
        const turned = THREAD_STATES.has(input.kind) && input.kind !== last?.kind;
        if (last && input.throttleMs && at - last.at < input.throttleMs && !turned) {
          // Still in the same state (needs you, needs you again): not news. Its words freshen in place, where it is.
          // Only a thread's state: mail and project status repeat their kind every time and wait their turn,
          // counted (Codex review on #640). What was held for it is older than this: it goes.
          if (THREAD_STATES.has(input.kind) && input.kind === last.kind) {
            this.dropHeld(input.key);
            return this.freshen(last, input);
          }
          this.hold(input, last.at + input.throttleMs);
          return null;
        }
        this.dropHeld(input.key);
      }
      const posted = this.insert(input, at);
      this.logRepeat(posted);
      return posted;
    } catch {
      return null;
    }
  }

  private insert(input: NewFeedPost, at: number): FeedPost | null {
    const result = this.db
      .prepare('INSERT INTO desk_feed (at, first_at, kind, item_id, project_id, agent_name, title, text, count, key, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(at, at, input.kind, input.itemId ?? null, input.projectId ?? null, input.agentName ?? '', input.title, clip(input.text ?? ''), input.count ?? 1, input.key ?? null, JSON.stringify({ ...(input.data ?? {}), rev: this.nextRev() }));
    return this.emit(this.get(Number(result.lastInsertRowid)));
  }

  /** A state change and an update as one post: the state's pill (an update never relabels one), the newest words and headline. */
  private merge(last: Row, input: NewFeedPost, at: number): FeedPost | null {
    const before = toPost(last);
    const kind = input.kind === 'update' ? before.kind : input.kind;
    // Words and title come from what carries the thread's words: a bare state change only relabels. Between
    // two, a headline wins over a thread's name.
    const inputCarries = input.kind === 'update' || !!input.data?.update;
    const beforeCarries = before.kind === 'update' || !!before.data.update;
    const title = inputCarries ? (input.data?.headline || !before.data.headline ? input.title : before.title) : beforeCarries ? before.title : input.title;
    const data = { ...before.data, ...(input.data ?? {}), rev: this.nextRev() };
    const text = clip(inputCarries || !beforeCarries ? input.text || before.text : before.text);
    this.db.prepare('UPDATE desk_feed SET at = ?, kind = ?, title = ?, text = ?, data = ? WHERE seq = ?').run(Math.max(at, last.at), kind, title, text, JSON.stringify(data), last.seq);
    return this.emit(this.get(last.seq));
  }

  /** New words for a post still saying the same thing: in place, its time and place unchanged. */
  private freshen(last: Row, input: NewFeedPost): FeedPost | null {
    const before = toPost(last);
    const title = input.data?.headline || !before.data.headline ? input.title : before.title;
    // Its time stays; when its words changed is kept apart, so what a lead's workers said since it posted includes them.
    this.db.prepare('UPDATE desk_feed SET title = ?, text = ?, data = ? WHERE seq = ?').run(title, clip(input.text || before.text), JSON.stringify({ ...before.data, ...(input.data ?? {}), changedAt: this.now(), rev: this.nextRev() }), last.seq);
    return this.emit(this.get(last.seq));
  }

  /**
   * The order posts were written or rewritten in, kept in their data: every write (a new post, a merge, a
   * freshen) stamps the next one. Same-millisecond posts are told apart by it, since a seq stays the row's first
   * write; a post from before it falls back to its seq, and the count starts above every seq (Codex review on #923).
   */
  private lastRev: number | null = null;

  private nextRev(): number {
    if (this.lastRev === null) {
      const row = this.db.prepare("SELECT MAX(COALESCE(MAX(seq), 0), COALESCE(MAX(json_extract(data, '$.rev')), 0), COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'desk_feed'), 0)) AS rev FROM desk_feed").get() as { rev: number };
      this.lastRev = row.rev;
    }
    this.lastRev += 1;
    return this.lastRev;
  }

  /** Posts held by a throttle, by key: the newest words wait for their time; a count of what they stand for. */
  private readonly held = new Map<string, { input: NewFeedPost; count: number; timer: NodeJS.Timeout }>();

  private hold(input: NewFeedPost, due: number): void {
    const key = input.key!;
    const was = this.held.get(key);
    const count = (was?.count ?? 0) + (input.count ?? 1);
    if (was) {
      was.input = input;
      was.count = count;
      return;
    }
    const timer = setTimeout(() => {
      const entry = this.held.get(key);
      if (!entry) return;
      this.held.delete(key);
      this.post({ ...entry.input, at: undefined, count: entry.count, throttleMs: undefined });
    }, Math.max(0, due - this.now()));
    timer.unref?.();
    this.held.set(key, { input, count, timer });
  }

  /** Drops what the throttle holds for this key when it is a Summary (a state change it holds stays). */
  private dropHeldSummary(key: string): void {
    if (this.held.get(key)?.input.data?.summary) this.dropHeld(key);
  }

  private dropHeld(key: string): void {
    const was = this.held.get(key);
    if (!was) return;
    clearTimeout(was.timer);
    this.held.delete(key);
  }

  /** Shutdown: what the throttle held posts now rather than being lost with the process (Codex review on #631). */
  close(): void {
    for (const [key, entry] of [...this.held.entries()]) {
      this.dropHeld(key);
      this.post({ ...entry.input, at: undefined, count: entry.count, throttleMs: undefined });
    }
  }

  /**
   * The newest posts as the owner's settings show them. `hidden`: whether a thread is left out now (a
   * coordinator, or one a rule hides since it posted).
   */
  recent({ limit = 60, settings = DEFAULT_FEED_SETTINGS, hidden = (_itemId: string): boolean => false, matches = (_post: FeedPost): boolean => true, projectOf = (_itemId: string): string | null => null } = {}): FeedPost[] {
    const want = Math.min(Math.max(limit, 1), 200);
    // Read back in pages until enough posts show: hidden chatter or a coordinator's posts can fill a page
    // on their own (Codex review on #595). Bounded: the table only keeps two weeks.
    const posts: FeedPost[] = [];
    // Mail a scope leaves out still shows which threads are one piece of work (Codex review on #873).
    const links: FeedPost[] = [];
    let cursor: { at: number; seq: number } | null = null;
    for (let page = 0; page < 50; page += 1) {
      const params: SQLInputValue[] = [];
      let where = '1 = 1';
      if (cursor) {
        where = '(at < ? OR (at = ? AND seq < ?))';
        params.push(cursor.at, cursor.at, cursor.seq);
      }
      const rows = this.db.prepare(`SELECT * FROM desk_feed WHERE ${where} ORDER BY at DESC, seq DESC LIMIT ?`).all(...params, PAGE) as unknown as Row[];
      // A mail post names two threads: either one hidden hides it (Codex review on #595).
      const shows = (post: FeedPost) => matches(post) && ![post.itemId, post.data.from, post.data.to].some((id) => typeof id === 'string' && hidden(id));
      for (const post of rows.map(toPost)) {
        if (shows(post)) posts.push(post);
        else if (post.kind === 'mail') links.push(post);
      }
      const shown = showAs(posts, settings, projectOf, links);
      if (rows.length < PAGE) return shown.slice(0, want);
      if (shown.length >= want) return shown.slice(0, want);
      const last = rows.at(-1)!;
      cursor = { at: last.at, seq: last.seq };
    }
    return showAs(posts, settings, projectOf, links).slice(0, want);
  }

  /**
   * Posts a ledger row once. Rows on one subject are one post, rewritten in place when the line is replaced. Rows
   * about one PR are one post, as catch-up folds them (collapse.ts): a lead's update and the merge are one Shipped
   * post in the lead's words; a routine decision about the PR folds into its Shipped post, or posts as Decided
   * until the PR merges and the Shipped post takes it in. Never throws.
   */
  postLedger({ post: input, ref, rank, pr, replaces }: LedgerPostInput): FeedPost | null {
    try {
      if (this.withRef(ref)) return null;
      const at = input.at ?? this.now();
      // A replaced line that gained or lost a PR link moves key: its old post, when it holds only this thread's own
      // lines, goes, and the new line posts under its key. One a merge or decision folded into stays (Codex review on #943).
      const old = replaces ? this.withRef(replaces) : null;
      if (old && old.key !== input.key && byList(old.data).every((b) => b.item === input.itemId && b.lead)) {
        this.db.prepare('DELETE FROM desk_feed WHERE seq = ?').run(old.seq);
        this.emit(old);
      }
      // Who wrote it and when, kept apart from the post's own thread and time, which a fold may change or keep
      // (ledgerPosted; Codex review on #943).
      const by: LedgerBy = { item: input.itemId ?? '', at, words: input.kind === 'update' || input.kind === 'shipped', lead: !!input.data?.lead };
      const input2 = { ...input, data: { ...(input.data ?? {}), ledger: true, rank, ref: [ref], by: [by] } };
      // A thread's own Update or Shipped: a Summary the throttle holds for it is older than this, and goes.
      if (by.words && by.item) this.dropHeldSummary(`thread:${by.item}`);
      const posts = (this.db.prepare('SELECT * FROM desk_feed WHERE key = ? AND at >= ? ORDER BY at DESC, seq DESC').all(input.key, at - LEDGER_FOLD_MS) as unknown as Row[]).map(toPost);
      // An explicit replacement finds its post however old: the fold window is for separate PR events (Codex review on #943).
      if (old && old.key === input.key && !posts.some((p) => p.seq === old.seq)) posts.unshift(old);
      // The same subject again: its line was replaced, so the post says the new line, still one happening.
      if (!pr) return posts[0] ? this.rewrite(posts[0], input2, rank, 0, false) : this.insert(input2, at);
      const host = posts.find((p) => Number(p.data.rank) >= 2);
      if (rank < 2) return host?.kind === 'shipped' ? this.rewrite(host, input2, rank) : this.insert(input2, at);
      const target = host ? this.rewrite(host, input2, rank) : this.insert(input2, at);
      if (target?.kind !== 'shipped') return target;
      // Shipped now: the PR's decisions posted on their own fold in.
      const absorbed = posts.filter((p) => p.seq !== target.seq && Number(p.data.rank) < 2);
      if (!absorbed.length) return target;
      const refs = [...new Set([...refList(target.data), ...absorbed.flatMap((p) => refList(p.data))])];
      const absorbedBy = [...byList(target.data), ...absorbed.flatMap((p) => byList(p.data))];
      this.db.prepare('UPDATE desk_feed SET count = ?, data = ? WHERE seq = ?').run(target.count + absorbed.reduce((n, p) => n + p.count, 0), JSON.stringify({ ...target.data, ref: refs, by: absorbedBy, rev: this.nextRev() }), target.seq);
      for (const p of absorbed) {
        this.db.prepare('DELETE FROM desk_feed WHERE seq = ?').run(p.seq);
        this.emit(p);
      }
      return this.emit(this.get(target.seq));
    } catch {
      return null;
    }
  }

  /**
   * A ledger row that was taken back (an automatic Finished line the lead's own line replaced, a scratch thread's
   * lines): a post that holds only that row goes; one other rows folded into keeps them and drops it. Never throws.
   */
  unpostLedger(ref: string): void {
    try {
      const post = this.withRef(ref);
      if (!post) return;
      const refs = refList(post.data).filter((r) => r !== ref);
      if (!refs.length) {
        this.db.prepare('DELETE FROM desk_feed WHERE seq = ?').run(post.seq);
        this.emit(post);
        return;
      }
      this.db.prepare('UPDATE desk_feed SET data = ? WHERE seq = ?').run(JSON.stringify({ ...post.data, ref: refs, rev: this.nextRev() }), post.seq);
      this.emit(this.get(post.seq));
    } catch {
      /* the feed never stops the desk */
    }
  }

  /** The post that holds this ledger ref, with its key. */
  private withRef(ref: string): (FeedPost & { key: string | null }) | null {
    const row = this.db.prepare("SELECT desk_feed.* FROM desk_feed, json_each(desk_feed.data, '$.ref') WHERE json_each.value = ? LIMIT 1").get(ref) as Row | undefined;
    return row ? { ...toPost(row), key: row.key } : null;
  }

  /**
   * A ledger row folded into its post, in place: on a PR Shipped wins the pill, the higher rank's words stand (a tie,
   * the newer), and the post is the thread's whose words it shows: a lead's update opens the lead, not the thread that
   * merged (Codex review on #943). A replaced line with no PR (`foldsPr` false) takes the new line's pill: a Shipped
   * line corrected to "still awaiting approval" isn't Shipped any more.
   */
  private rewrite(host: FeedPost, input: NewFeedPost, rank: number, adds = 1, foldsPr = true): FeedPost | null {
    const takes = rank >= Number(host.data.rank ?? 0);
    const kind = foldsPr && (host.kind === 'shipped' || input.kind === 'shipped') ? 'shipped' : takes ? input.kind : host.kind;
    const data = { ...host.data, ...(takes ? (input.data ?? {}) : {}), rank: Math.max(rank, Number(host.data.rank ?? 0)), ref: [...new Set([...refList(host.data), ...refList(input.data ?? {})])], by: [...byList(host.data), ...byList(input.data ?? {})], ...(input.data?.lead || host.data.lead ? { lead: true } : {}), changedAt: this.now(), rev: this.nextRev() };
    const owner = takes && input.itemId ? { itemId: input.itemId, projectId: input.projectId ?? null, agentName: input.agentName ?? '' } : { itemId: host.itemId, projectId: host.projectId, agentName: host.agentName };
    this.db.prepare('UPDATE desk_feed SET kind = ?, item_id = ?, project_id = ?, agent_name = ?, title = ?, text = ?, count = ?, data = ? WHERE seq = ?').run(kind, owner.itemId, owner.projectId, owner.agentName, takes ? input.title : host.title, takes ? clip(input.text ?? '') : host.text, host.count + adds, JSON.stringify(data), host.seq);
    return this.emit(this.get(host.seq));
  }

  /**
   * Whether this thread wrote its own words to the ledger since then, an Update or Shipped (`lead`: a lead's own
   * line), by when it wrote them: a line folded into another thread's post, or rewriting an older one, counts.
   */
  ledgerPosted(itemId: string, since: number, { lead = false } = {}): boolean {
    try {
      return !!this.db
        .prepare(`SELECT 1 FROM desk_feed, json_each(desk_feed.data, '$.by') AS b WHERE ${EFFECTIVE_AT} >= ? AND json_extract(desk_feed.data, '$.ledger') = 1 AND json_extract(b.value, '$.item') = ? AND json_extract(b.value, '$.at') >= ? AND json_extract(b.value, ${lead ? "'$.lead'" : "'$.words'"}) = 1 LIMIT 1`)
        .get(since, itemId, since);
    } catch {
      return false;
    }
  }

  /** Told of every Summary post that lands within REPEAT_LOG_MS of another post on its thread (the missed-repeat log). */
  onRepeat: ((pair: { post: FeedPost; before: FeedPost; overlap: number; wouldDrop: boolean }) => void) | null = null;

  private logRepeat(post: FeedPost | null): void {
    if (!post || !this.onRepeat || !post.data.summary || !post.itemId) return;
    const before = this.db.prepare('SELECT * FROM desk_feed WHERE item_id = ? AND seq <> ? AND at >= ? ORDER BY at DESC, seq DESC LIMIT 1').get(post.itemId, post.seq, post.at - REPEAT_LOG_MS) as Row | undefined;
    if (!before) return;
    const other = toPost(before);
    const wouldDrop = collapseRepeats([post, other]).length < 2;
    this.onRepeat({ post, before: other, overlap: overlap(words(post), words(other)), wouldDrop });
  }

  /**
   * Takes back the post with this key that came from this desk event (a Done that was undone), and tells the
   * screens. One that carries the thread's update goes back to being that update.
   */
  retract(key: string, eventSeq: number): void {
    try {
      const last = this.db.prepare("SELECT * FROM desk_feed WHERE key = ? AND json_extract(data, '$.eventSeq') = ? ORDER BY at DESC, seq DESC LIMIT 1").get(key, eventSeq) as Row | undefined;
      if (!last) return;
      const post = toPost(last);
      if (post.data.update) {
        const { eventSeq: _undone, ...data } = post.data;
        this.db.prepare("UPDATE desk_feed SET kind = 'update', data = ? WHERE seq = ?").run(JSON.stringify(data), last.seq);
        this.emit(this.get(last.seq));
        return;
      }
      this.db.prepare('DELETE FROM desk_feed WHERE seq = ?').run(last.seq);
      this.emit(post);
    } catch {
      /* the feed never stops the desk */
    }
  }

  /**
   * The words the thread's newest post carries (an update, or a state change that took one), a held one first:
   * what the owner last heard from it. Null when it never posted. For a summary from before v14, which kept no
   * record of what posted (Codex review on #905).
   */
  lastWords(key: string): string | null {
    const held = this.held.get(key)?.input;
    if (held && (held.kind === 'update' || held.data?.update) && held.text) return clip(held.text);
    try {
      const row = this.db.prepare("SELECT text FROM desk_feed WHERE key = ? AND (kind = 'update' OR json_extract(data, '$.update') = 1) AND text <> '' ORDER BY at DESC, seq DESC LIMIT 1").get(key) as { text: string } | undefined;
      return row?.text ?? null;
    } catch {
      return null;
    }
  }

  /** When the thread's newest post carrying its words went out (or its words last changed); null when it never posted. */
  lastPostAt(key: string): number | null {
    return this.lastPostMark(key)?.at ?? null;
  }

  /** lastPostAt with when it was written (its rev): posts in the same millisecond are told apart by it (Codex review on #910). */
  lastPostMark(key: string): { at: number; rev: number } | null {
    try {
      const row = this.db.prepare(`SELECT ${EFFECTIVE_AT} AS at, ${REV} AS rev FROM desk_feed WHERE key = ? AND (kind = 'update' OR json_extract(data, '$.update') = 1) ORDER BY 1 DESC, 2 DESC LIMIT 1`).get(key) as { at: number; rev: number } | undefined;
      return row ?? null;
    } catch {
      return null;
    }
  }

  /**
   * What these threads posted in their own words after `since`, newest first (at most `limit`): what the owner
   * already heard from them. Held posts haven't gone out, so they aren't in it; one freshened in place counts from
   * when its words changed (Codex review on #910). With `afterRev`, a post at exactly `since` counts when it was
   * written after that rev (a lead and its worker posting in the same millisecond).
   */
  postedSince(keys: string[], since: number, limit = 8, afterRev = Number.MAX_SAFE_INTEGER, items: string[] = []): Array<{ at: number; title: string; text: string }> {
    if (!keys.length && !items.length) return [];
    try {
      const marks = (list: string[]) => list.map(() => '?').join(', ') || 'NULL';
      // A thread's posts by its key, and the ledger Updates and Shipped posts it wrote words to, under whatever key
      // they folded into (Codex review on #943). A ledger post's title is its news even with no detail: a merge is
      // recorded with none.
      const ledger = `(json_extract(data, '$.ledger') = 1 AND kind IN ('update', 'shipped') AND EXISTS (SELECT 1 FROM json_each(desk_feed.data, '$.by') AS b WHERE json_extract(b.value, '$.item') IN (${marks(items)}) AND json_extract(b.value, '$.words') = 1))`;
      return this.db
        .prepare(`SELECT at, title, text FROM desk_feed WHERE ((key IN (${marks(keys)}) AND (kind = 'update' OR json_extract(data, '$.update') = 1)) OR ${ledger}) AND (${EFFECTIVE_AT} > ? OR (${EFFECTIVE_AT} = ? AND ${REV} > ?)) AND (text <> '' OR (json_extract(data, '$.ledger') = 1 AND title <> '')) ORDER BY ${EFFECTIVE_AT} DESC, ${REV} DESC LIMIT ?`)
        .all(...keys, ...items, since, since, afterRev, limit) as Array<{ at: number; title: string; text: string }>;
    } catch {
      return [];
    }
  }

  get(seq: number): FeedPost | null {
    const row = this.db.prepare('SELECT * FROM desk_feed WHERE seq = ?').get(seq) as Row | undefined;
    return row ? toPost(row) : null;
  }

  /**
   * Once: before #621 a thread's first summary was posted as `started` even on threads long under way. Those
   * are updates; `started` now means a new thread.
   */
  relabelOldStarts(): void {
    this.db.prepare("UPDATE desk_feed SET kind = 'update' WHERE kind = 'started'").run();
  }

  isEmpty(): boolean {
    return !this.db.prepare('SELECT 1 FROM desk_feed LIMIT 1').get();
  }

  /** Drops posts older than two weeks, by when their words last changed: a post rewritten in place keeps its first time. */
  prune(): void {
    this.db.prepare(`DELETE FROM desk_feed WHERE ${EFFECTIVE_AT} < ?`).run(this.now() - KEEP_MS);
  }

  subscribe(listener: (post: FeedPost) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(post: FeedPost | null): FeedPost | null {
    if (post) for (const listener of this.listeners) listener(post);
    return post;
  }
}

/** One ledger line's part in a post: its thread, when it was written, whether it was that thread's own words or a lead's. */
interface LedgerBy {
  item: string;
  at: number;
  words: boolean;
  lead: boolean;
}

const byList = (data: Record<string, unknown>): LedgerBy[] => (Array.isArray(data.by) ? (data.by as LedgerBy[]).filter((b) => b && typeof b.item === 'string') : []);

const refList = (data: Record<string, unknown>): string[] => (Array.isArray(data.ref) ? data.ref.filter((r): r is string => typeof r === 'string') : []);

function toPost(row: Row): FeedPost {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(row.data) as Record<string, unknown>;
  } catch {
    /* an unreadable payload is an empty one */
  }
  return { seq: row.seq, at: row.at, firstAt: row.first_at, kind: row.kind as FeedKind, itemId: row.item_id, projectId: row.project_id, agentName: row.agent_name, title: row.title, text: row.text, count: row.count, data };
}

/**
 * Applies the owner's settings to posts (newest first): agent mail hidden, or one line per project (or pair of
 * threads) per day, carrying the day's newest words. Needs you, Failed and Stuck posts all come back: whether one
 * is still open is the row's status now, which the screen applies (feed.js feedShown).
 */
export function showAs(posts: FeedPost[], settings: FeedSettings, projectOf?: (itemId: string) => string | null, links: FeedPost[] = []): FeedPost[] {
  const out: FeedPost[] = [];
  for (const post of posts) {
    if (post.kind === 'mail' && settings.chatter === 'hidden') continue;
    out.push(post);
  }
  return collapseRepeats(out, [...posts, ...links], projectOf);
}

const STOP = new Set('the and for with from that this was were are has have had will now then than into out one more still new after before just not its but you your nothing needs need'.split(' '));
const words = (post: FeedPost): Set<string> => new Set(`${post.title} ${post.text}`.toLowerCase().match(/[a-z0-9']+/g)?.filter((w) => w.length > 2 && !STOP.has(w)) ?? []);
/** What a retelling of a decision says about any decision ("the owner approved…"): not what it was about. */
const DECISION_VOCAB = new Set('owner approved approves approve picked picks chose selected okayed went recommended option version small choice decision decided agent thread worker lead says said'.split(' '));
const subjectWords = (bag: Set<string>): Set<string> => new Set([...bag].filter((w) => !DECISION_VOCAB.has(w)));
const overlap = (a: Set<string>, b: Set<string>): number => {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  // A few words say nothing about whether two posts tell one thing.
  return a.size >= 4 && b.size >= 4 ? shared / (a.size + b.size - shared) : 0;
};
/** A post that carries a thread's own words (an update, or a state change that took one). */
const carriesWords = (post: FeedPost): boolean => post.kind === 'update' || !!post.data.update;
/** Words that say the owner just answered something: the one decision, told by every thread it touched. */
const DECISION_WORDS = /\b(?:you|owner)\s+(?:picked|chose|selected|approved|okayed|went with)\b|\bowner approv|\byou(?:'ve)? approved\b|\bapproved the (?:small|recommended)|\bpicked the recommended/i;
/** A mail that only says the owner's own message was passed on: a receipt, not agents talking. */
const RECEIPT = /^the owner's words went straight to/i;

/** A report that something broke, and one that it works again: opposite events, never one restated. */
const BROKE = /\b(?:fail(?:s|ed|ing|ure|ures)?|errors?|broke|broken|crash(?:ed|es)?|down|blocked|stuck|red)\b/i;
const MENDED = /\b(?:pass(?:ed|es|ing)?|succeed(?:ed|s)?|recover(?:ed|s)?|resolved|fixed|green|restored|healthy|back up)\b/i;
const opposite = (a: FeedPost, b: FeedPost): boolean => {
  const [x, y] = [`${a.title} ${a.text}`, `${b.title} ${b.text}`];
  // One says it works again and the other does not, with a failure in either: a recovery that names the failure it ended still differs.
  return MENDED.test(x) !== MENDED.test(y) && (BROKE.test(x) || BROKE.test(y));
};
/** Choices that exclude each other: two decisions picking different ones are two decisions, however alike the rest reads. */
const EXCLUSIVE = [['dark', 'light'], ['red', 'blue', 'green', 'yellow', 'orange', 'purple', 'black', 'white', 'pink', 'gray', 'grey'], ['enable', 'disable', 'enabled', 'disabled'], ['allow', 'block', 'deny'], ['keep', 'drop', 'remove', 'delete'], ['first', 'second', 'third'], ['small', 'medium', 'large', 'big'], ['left', 'right'], ['top', 'bottom'], ['before', 'after'], ['yes', 'no']].map((g) => new Set(g));
const differentChoice = (a: Set<string>, b: Set<string>): boolean => {
  const [onlyA, onlyB] = [[...a].filter((w) => !b.has(w)), [...b].filter((w) => !a.has(w))];
  return EXCLUSIVE.some((g) => onlyA.some((w) => g.has(w)) && onlyB.some((w) => g.has(w)));
};

const MIN = 60_000;
/** Same thread saying it again (its summary rewritten as it progressed). */
const SAME_THREAD = { ms: 20 * MIN, near: 0.4 };
/** A lead repeating its worker's news: the first telling is the news, the later one the echo. */
const OTHER_THREAD = { ms: 15 * MIN, near: 0.5 };
/** One owner decision, narrated by each thread it touched. */
const DECISION = { ms: 10 * MIN, near: 0.2 };
/** Mail whose substance shows up as the recipient's (or sender's) own update. */
/** How close a mail between two threads is to their posts for the threads to be one piece of work. */
const RELATED_MS = 30 * MIN;
const MAIL_ECHO = { ms: 10 * MIN, near: 0.25 };

/**
 * A bare Needs you, Failed or Stuck post whose record has closed: with "Show answered asks" off the Feed folds it
 * away (public/desk/feed.js feedShown), so the read leaves it out before paging, or closed posts fill the page
 * (Codex review on #938). One that carries words stays: it shows as its update.
 */
export function closedBareState(post: FeedPost, item: DeskItem | undefined, now = Date.now()): boolean {
  if ((post.kind !== 'needs' && post.kind !== 'failed' && post.kind !== 'stuck') || post.data.update) return false;
  if (!item) return true;
  // A Stuck post without a wait is the row's own Stuck (a "me" hand-off with nothing behind it): closed when the row isn't.
  if (post.kind === 'stuck' && post.data.waitId) return !stuckWaits(item).some((w) => w.id === post.data.waitId);
  const status = deskStatus(item, now);
  return !(status.countsForOwner && status.pill === post.kind);
}

/**
 * Each event once. The feed keeps every post as written; on read, a post that retells one a moment ago is folded:
 *   - a mail receipt ("the owner's words went straight to…") goes, and a mail the thread then restates in its
 *     own update goes (the update is the agent's words);
 *   - a thread restating itself keeps the newer words (its count adds up);
 *   - a thread repeating another's news, or several narrating one decision the owner just made, keep the first telling.
 * Threads count as related (one retelling the other) only when they share a project or mailed each other close to the posts.
 * Newest first in, newest first out. `all` is every post read, mail included even when the owner's chatter setting hides it.
 */
export function collapseRepeats(posts: FeedPost[], all: FeedPost[] = posts, projectOf: (itemId: string) => string | null = () => null): FeedPost[] {
  const mailed = all.filter((post) => post.kind === 'mail' && typeof post.data.from === 'string' && typeof post.data.to === 'string');
  // A post's project: as stored, else the thread's own now (posts written before they carried one).
  const projectIn = (post: FeedPost): string | null => post.projectId ?? (post.itemId ? projectOf(post.itemId) : null);
  const related = (a: FeedPost, b: FeedPost): boolean =>
    (!!projectIn(a) && projectIn(a) === projectIn(b)) ||
    mailed.some((m) => ((m.data.from === a.itemId && m.data.to === b.itemId) || (m.data.from === b.itemId && m.data.to === a.itemId)) && Math.abs(m.at - Math.max(a.at, b.at)) <= RELATED_MS);
  const drop = new Set<number>();
  const count = new Map<number, number>();
  const wordsOf = new Map<number, Set<string>>();
  const bag = (post: FeedPost) => wordsOf.get(post.seq) ?? (wordsOf.set(post.seq, words(post)), wordsOf.get(post.seq)!);
  // A ledger post is a record (feed-status.md): never folded away by words, and never folding another.
  const told = posts.filter((post) => carriesWords(post) && !post.data.ledger);
  for (const post of posts) {
    // Only a mail on its own: a throttled one bundles the pair's other mail under one post (count > 1), which may be real talk.
    if (post.kind !== 'mail' || post.count > 1) continue;
    const ends = [post.data.from, post.data.to];
    if (RECEIPT.test(post.text) || told.some((other) => other.itemId && ends.includes(other.itemId) && other.at >= post.at && other.at - post.at <= MAIL_ECHO.ms && overlap(bag(post), bag(other)) >= MAIL_ECHO.near)) drop.add(post.seq);
  }
  // Oldest first: each post is compared with the ones kept before it.
  const kept: FeedPost[] = [];
  for (const post of [...told].reverse()) {
    let folded = false;
    for (const before of kept) {
      const gap = post.at - before.at;
      const near = overlap(bag(post), bag(before));
      // One decision only when both narrate an owner's answer and are about the same thing (words beyond "the owner approved").
      const [mine, theirs] = [subjectWords(bag(post)), subjectWords(bag(before))];
      const sharedSubject = [...mine].filter((w) => theirs.has(w)).length;
      const decision = DECISION_WORDS.test(`${post.title} ${post.text}`) && DECISION_WORDS.test(`${before.title} ${before.text}`) && sharedSubject >= 4 && !differentChoice(bag(post), bag(before)) && overlap(mine, theirs) >= DECISION.near;
      if (before.itemId === post.itemId && gap <= SAME_THREAD.ms && !opposite(post, before) && (near >= SAME_THREAD.near || (decision && gap <= DECISION.ms))) {
        // A state record (Needs you, Failed, Stuck) and a later summary both stand: the record is never folded away,
        // and the summary may be what came of it (approved, now building) (Codex review on #938).
        if (THREAD_STATES.has(before.kind) && before.kind !== 'done' && !THREAD_STATES.has(post.kind)) continue;
        // The same thread: the newer words stand in for the older post, which goes.
        drop.add(before.seq);
        count.set(post.seq, (count.get(post.seq) ?? post.count) + (count.get(before.seq) ?? before.count));
        kept.splice(kept.indexOf(before), 1);
        break;
      }
      if (before.itemId !== post.itemId && related(post, before) && !differentChoice(bag(post), bag(before)) && (decision ? gap <= DECISION.ms : gap <= OTHER_THREAD.ms && near >= OTHER_THREAD.near)) {
        folded = true;
        break;
      }
    }
    if (folded) drop.add(post.seq);
    else kept.push(post);
  }
  return posts.filter((post) => !drop.has(post.seq)).map((post) => (count.has(post.seq) ? { ...post, count: count.get(post.seq)! } : post));
}
