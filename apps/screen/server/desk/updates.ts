import { askKey, namesDecision } from './asks.js';
import { deskStatus } from './status.js';
import { execFile } from 'node:child_process';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { parsePrUrl } from './artifacts.js';
import { fit, plainWords } from '../../public/desk/plain-words.js';
import { collapse, isRuleEvent, ownerTitle, readLayout, tidied, type ChapterLayout, type ChapterView } from './collapse.js';
import { crossFolds, tidiedIds, tidyChapter, type ChapterTidy } from './triage.js';
import { flipOf, prKey, revertedBy, sourcesOf, type SourceKey, type SourceState } from './recheck.js';
import { plainChapter, stillAsks, unbackedAsk } from './chapter-writer.js';
import type { Exec } from './source-github.js';
import { SYSTEM_ITEM_PREFIX } from './system.js';
import type { LeadCatchup } from './source-loom.js';
import type { DeskEvent, DeskItem } from './types.js';

// The update ledger (docs/specs/catch-up.md): short, typed lines about a space that every catch-up surface reads,
// with the owner's seen marks on each line. Filled automatically from what the desk already knows (an open brief,
// a decision made for the owner, a System incident, a merged PR, a thread marked Done) and, later, by leads.
//
// A line has a subject (`decision:D-12`, `incident:7`, `pr:owner/repo#3`, `done:<item>`): a newer line on the same
// subject replaces the older one, so a chapter shows the latest state of each thing, not its history.

export const UPDATE_KINDS = ['needs', 'failed', 'decided', 'shipped', 'fyi'] as const;
export type UpdateKind = (typeof UPDATE_KINDS)[number];
export type SeenVia = 'acted' | 'accepted' | 'deferred' | 'heard' | 'read';
export const SEEN_VIAS: readonly SeenVia[] = ['acted', 'accepted', 'deferred', 'heard', 'read'];
export type UpdateSource = 'auto:pr' | 'auto:decision' | 'auto:brief' | 'auto:incident' | 'auto:done' | 'auto:status' | 'auto:handoff' | 'lead';

/** Spaces that aren't a project or an agent: System incidents, and conversations filed nowhere. */
export const SYSTEM_SPACE = 'system';
export const UNFILED_SPACE = 'unfiled';

export interface DeskUpdate {
  /** Read-time row evaluation; never inferred from update prose. */
  status?: import('./status.js').DeskStatus;
  id: number;
  spaceId: string;
  itemId: string | null;
  kind: UpdateKind;
  moment: boolean;
  title: string;
  detail: string | null;
  refs: Array<{ label: string; url: string }>;
  shot: string | null;
  briefId: string | null;
  decisionId: string | null;
  /** The decision class, for decided and needs lines (what the moment rules and learning read). */
  class: string | null;
  /**
   * The thread messages this line stands for (their times, ms). Seeing the line covers only those; a line with no
   * span never changes the thread's read state.
   */
  coversFrom: number | null;
  coversTo: number | null;
  /** What a surface needs beyond the words: a delegation-rule event's rule, choice and levels. */
  data: Record<string, unknown>;
  source: UpdateSource;
  subject: string | null;
  /** The line this one replaced. */
  supersedes: number | null;
  /** Replaced by a newer line on the same subject: kept for history, never shown. */
  supersededBy: number | null;
  at: number;
  seenAt: number | null;
  seenVia: SeenVia | null;
  outcome: string | null;
  /** Deferred: seen, but back in the catch-up at this time. */
  backAt: number | null;
  /** A brief that is no longer open (answered or withdrawn). */
  resolvedAt: number | null;
}

export interface NewUpdate {
  spaceId: string;
  itemId?: string | null;
  kind: UpdateKind;
  /** The writer's proposal; the moment rules have the last word (momentFor). */
  moment?: boolean;
  title: string;
  detail?: string | null;
  refs?: Array<{ label: string; url: string }>;
  shot?: string | null;
  briefId?: string | null;
  decisionId?: string | null;
  class?: string | null;
  coversFrom?: number | null;
  coversTo?: number | null;
  data?: Record<string, unknown>;
  /** A new line even when the news reads the same (an incident open again after the owner held it). */
  renew?: boolean;
  /** Always its own card, whatever the class (a delegation-rule change). */
  alwaysMoment?: boolean;
  source: UpdateSource;
  subject?: string | null;
  at?: number;
  /** Already seen when written (the owner did it themselves). */
  seen?: { via: SeenVia; outcome?: string | null };
}

export type ChapterState = 'news' | 'caught_up' | 'deferred';

/** What the chapter writer reads: the space, its open lines, what was handled lately, and the prose it had. */
export interface ChapterWriteInput {
  spaceId: string;
  name: string;
  /** `brief`: the line stands for an open brief (the sort never hides one). */
  open: Array<Pick<DeskUpdate, 'id' | 'kind' | 'moment' | 'title' | 'detail' | 'at' | 'source'> & { brief?: boolean; conversation?: string; standing?: string; background?: string }>;
  /** By id, so the writer can name the line that answered an open ask. */
  handled: Array<Pick<DeskUpdate, 'kind' | 'title' | 'outcome' | 'at'> & Partial<Pick<DeskUpdate, 'id' | 'source'>>>;
  previous: { headline: string | null; status: string | null };
  /** The lead's milestone from its summary, for "Next:". */
  milestone: string | null;
  now: number;
}
/** The writer's chapter: its prose and, when it grouped the lines, the layout the card collapses them by. */
export type ChapterWriter = (input: ChapterWriteInput) => Promise<{ headline: string; status: string; layout?: ChapterLayout | null; /** The plain fallback, not the model. */ plain?: boolean } | null>;

export interface Chapter {
  spaceId: string;
  /** One or two sentences on what happened, from the owner's side (written in phase 2). */
  headline: string | null;
  /** Where the space stands now (written in phase 2). */
  status: string | null;
  state: ChapterState;
  /** Open moments, as the card collapses them (collapse.ts): the chapter's rule changes count once. */
  moments: number;
  /** Briefs waiting on the owner's answer, seen or not. */
  needs: number;
  /** Open smaller lines. */
  smaller: number;
  /**
   * The headline's first half, built from the open asks Needs you counts and never written by a model (R-21):
   * "Waiting on you: …". The headline starts with it; null when nothing waits.
   */
  waits: string | null;
  /** When the oldest open line arrived (the chapter's start); null when caught up. */
  since: number | null;
  /** When the oldest line still outstanding arrived: an open line, or a brief still waiting on the owner though read. Oldest first sorts by it. */
  oldestAt: number | null;
  /** The newest line in the space. */
  lastAt: number;
  /** A deferred chapter comes back at this time. */
  backAt: number | null;
}

/**
 * The moment rules (spec "What makes a moment"): the defaults, and guardrails over what a writer proposes. An open
 * brief always is one; a routine decision never is.
 */
export function momentFor(input: Pick<NewUpdate, 'kind' | 'moment' | 'class' | 'alwaysMoment' | 'title' | 'detail' | 'data'>, context: { routine: (cls: string) => boolean }): boolean {
  // A rule change, or a correction to a line the owner already saw (recheck.ts): its own card whatever the kind.
  if (input.alwaysMoment && (input.kind === 'decided' || input.kind === 'fyi')) return true;
  switch (input.kind) {
    case 'needs':
      return true;
    case 'fyi':
      return false;
    case 'failed':
      // Still broken: a moment unless the writer says it cost nothing and is already behind us (then it's an fyi).
      return input.moment ?? true;
    case 'decided':
      // An op that failed or kept something down is news whatever the class has learned or a rule allowed.
      if (input.class === OPS_CLASS && costly(`${input.title} ${input.detail ?? ''}`)) return true;
      // Made under a standing rule: the owner approved the class already, so it is routine (it folds into its PR's line).
      if (typeof input.data?.underRule === 'string') return false;
      if (input.class && context.routine(input.class)) return false;
      // Routine ops: a restart is news only when it failed or cost more than a minute.
      if (input.class === OPS_CLASS) return false;
      return input.moment ?? true;
    case 'shipped':
      // A milestone only when the writer marks it one; otherwise a line under Shipped.
      return input.moment ?? false;
  }
}

/** Ops on the owner's own machines (restarts, deploys, backups): routine unless they cost something. */
const OPS_CLASS = 'ops-own-machine';
const COSTLY = /\b(fail(?:ed|s|ing|ure)|did(?: not|n['’]t) come back|rolled back|roll(?:ed)? back|data loss|lost (?:data|work|messages?))\b/i;
/** An outage over this long is news. */
const OUTAGE_MS = 60_000;

const DUR = String.raw`(\d+(?:\.\d+)?)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\b`;
// A duration is an outage only bound to outage words: "down for 4 min", "offline ~2 m", "restarted (3 min)",
// "restart took 90 s", "came back after 5 min", "4 minutes of downtime". How long a job ran is not one.
const OUTAGE_DURATIONS = [
  new RegExp(String.raw`\b(?:down|offline|out|unavailable|unreachable)\s+(?:for\s+)?(?:about\s+|~\s*)?${DUR}`, 'gi'),
  // "Restarted Loom (3 min)": the parenthesis right after what restarted, not after other work ("and ran checks (3 min)").
  new RegExp(String.raw`\brestart(?:s|ed|ing)?(?:\s+(?!(?:and|then|ran|plus|before|after|while)\b)[\w.-]+){0,6}\s*\(\s*(?:about\s+|~\s*)?${DUR}[^)]*\)`, 'gi'),
  new RegExp(String.raw`\brestart(?:s|ed|ing)?\s+(?:took|in)\s+(?:about\s+|~\s*)?${DUR}`, 'gi'),
  new RegExp(String.raw`\b(?:came back|back (?:up|online))\s+after\s+(?:about\s+|~\s*)?${DUR}`, 'gi'),
  new RegExp(String.raw`${DUR}\s+(?:of\s+)?(?:downtime|outage)`, 'gi'),
  new RegExp(String.raw`\b(?:downtime|outage)\s+(?:was|lasted|of|took|ran)\s+(?:about\s+|~\s*)?${DUR}`, 'gi'),
];

/** An op that cost something: it failed, didn't come back, lost data, or was down longer than a minute. */
export function costly(text: string): boolean {
  if (COSTLY.test(text)) return true;
  for (const re of OUTAGE_DURATIONS) {
    for (const m of text.matchAll(re)) {
      const unit = m[2]!.toLowerCase();
      const ms = Number(m[1]) * (unit.startsWith('h') ? 3_600_000 : unit.startsWith('m') ? 60_000 : 1000);
      if (ms > OUTAGE_MS) return true;
    }
  }
  return false;
}

/**
 * A line whose conversation is away: snoozed or parked on its own, or held by its snoozed or parked project (core.ts
 * withProjectHold writes the project's state onto the items every reader sees), or any line in a project that is
 * snoozed or parked itself (its finished conversations too, as its page hides the card). Catch me up leaves these out,
 * as the List and the sidebar counts do; the lines keep their seen state, so they come back unseen when it wakes.
 */
function heldAway(row: Row, items: Map<string, DeskItem>, awaySpaces: ReadonlySet<string>): boolean {
  if (typeof row.space_id === 'string' && awaySpaces.has(row.space_id)) return true;
  const disposition = typeof row.item_id === 'string' ? items.get(row.item_id)?.disposition : undefined;
  return disposition === 'snoozed' || disposition === 'parked';
}

/** Desk events that put a conversation away or bring it back (attention.ts), so heldAway reads differently after them. */
const AWAY_EVENTS: ReadonlySet<string> = new Set(['snooze', 'park', 'snooze.expired', 'reopen', 'pickup', 'undo']);

/** Incident statuses that mean the owner has it in hand. */
const HELD_INCIDENT: ReadonlySet<string> = new Set(['acked', 'snoozed', 'muted']);
const RULE_MOMENTS: ReadonlySet<string> = new Set(['rule-created', 'rule-reaffirmed', 'rule-suspended', 'class-demoted']);

/** Board classes that are routine from the start: the owner never needs to see them one by one. */
export const ROUTINE_CLASSES: ReadonlySet<string> = new Set(['continue-in-scope', 'verify-own-change', 'pr-housekeeping', 'merge-when-green', 'reviewer-choice']);
/** A class the owner has said Fine to this many times (and not reversed lately) is routine too. */
const ROUTINE_AFTER_FINES = 3;

const DAY = 86_400_000;
/** The chapter writer waits for a space to go this quiet, and writes a space at most this often (the coordinator's pattern). */
/** How long a lead's line waits for its thread to be filed before it goes to Unfiled. */
const LEAD_FILE_WAIT_MS = 10 * 60_000;
const WRITE_SETTLE_MS = 5 * 60_000;
const WRITE_GAP_MS = 30 * 60_000;
/** The headline the card shows: at most two sentences and about this many words, in plain words (no bare ids). */
const HEADLINE_WORDS = 35;
/** The status, where it stands and its Next together: about this many words. */
const STATUS_WORDS = 40;
const ownerHeadline = (text: string | null | undefined): string | null => (text ? fit(plainWords(text), 2, HEADLINE_WORDS) || null : null);
/** The headline's record-built half (Chapter.waits): the one ask by name, or how many there are. */
export function waitsLine(titles: string[]): string | null {
  if (!titles.length) return null;
  if (titles.length > 1) return `${titles.length} things are waiting on you.`;
  return `Waiting on you: ${fit(plainWords(ownerTitle(titles[0]!)), 1, 20).replace(/[.?!…]+$/, '')}.`;
}
/** The status, the same two sentences: where it stands, then its "Next: …" when it has one. */
export function ownerStatus(text: string | null | undefined): string | null {
  if (!text) return null;
  const plain = plainWords(text);
  const at = plain.search(/\bNext:/);
  if (at < 0) return fit(plain, 2, HEADLINE_WORDS) || null;
  const next = fit(plain.slice(at), 1, 15);
  const where = fit(plain.slice(0, at), 1, Math.max(10, STATUS_WORDS - next.split(/\s+/).length));
  return [where, next].filter(Boolean).join(' ') || null;
}

/** After the owner handles a line the headline is rewritten this soon, gap or not (it may name what they just handled). */
const HANDLED_SETTLE_MS = 60_000;
/**
 * The writer's rules (its prompt, the headline and status caps). Raise it when they change: every chapter written
 * under an older one is rewritten once on the next pass, so no headline stays in the old voice.
 */
export const WRITER_VERSION = 7;
/** Lines the seen block names, at most. */
const SEEN_LINES = 12;
/** Lines are kept this long: the ledger is what's new, not an archive. */
const KEEP_MS = 30 * DAY;
/** How far back the learning reads the owner's Fines (routine()). */
const LEARNING_MS = 60 * DAY;
/** On first read, sources reach back this far before the ledger began (a fresh ledger shouldn't fill with last week). */
const FIRST_LOOK_MS = DAY;
/** A PR mentioned by a conversation active this recently is checked for a merge. */
const PR_LOOKBACK_MS = 3 * DAY;
/** A thread done again this long after its last Done line is news again (two events for one completion are not). */
const DONE_AGAIN_MS = 10 * 60_000;
/** An open PR is asked about again after this long. */
const PR_RECHECK_MS = 10 * 60_000;
/** gh calls per pass, at most. */
const PR_CALLS_PER_PASS = 20;
/** Shipped lines this recent have their PRs watched for a revert or a close (recheck.ts). */
const RECHECK_WINDOW_MS = 7 * DAY;
/** A repo's merged reverts are read again after this long; a PR still open is asked about again after this long. */
const REVERT_SCAN_MS = 10 * 60_000;
/** gh calls per pass for rechecking, at most. */
const RECHECK_CALLS_PER_PASS = 6;
const MAX_TITLE = 200;
const defaultExec: Exec = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 20_000, maxBuffer: 1_000_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
const MAX_DETAIL = 600;

const COLUMNS: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  space_id: 'TEXT NOT NULL',
  item_id: 'TEXT',
  kind: 'TEXT NOT NULL',
  moment: 'INTEGER NOT NULL DEFAULT 0',
  title: "TEXT NOT NULL DEFAULT ''",
  detail: 'TEXT',
  refs: "TEXT NOT NULL DEFAULT '[]'",
  shot: 'TEXT',
  brief_id: 'TEXT',
  decision_id: 'TEXT',
  class: 'TEXT',
  covers_from: 'INTEGER',
  covers_to: 'INTEGER',
  data: "TEXT NOT NULL DEFAULT '{}'",
  source: 'TEXT NOT NULL',
  subject: 'TEXT',
  supersedes: 'INTEGER',
  superseded_by: 'INTEGER',
  at: 'INTEGER NOT NULL',
  seen_at: 'INTEGER',
  seen_via: 'TEXT',
  outcome: 'TEXT',
  back_at: 'INTEGER',
  resolved_at: 'INTEGER',
};

type Row = Record<string, string | number | null>;

const clip = (text: string | null | undefined, max: number): string | null => {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function parsed<T>(text: unknown, fallback: T): T {
  try {
    return typeof text === 'string' ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
}

function toUpdate(row: Row): DeskUpdate {
  const refs = parsed<DeskUpdate['refs']>(row.refs, []);
  return {
    id: row.id as number,
    spaceId: row.space_id as string,
    itemId: (row.item_id as string | null) ?? null,
    kind: row.kind as UpdateKind,
    moment: row.moment === 1,
    title: row.title as string,
    detail: (row.detail as string | null) ?? null,
    refs,
    shot: (row.shot as string | null) ?? null,
    briefId: (row.brief_id as string | null) ?? null,
    decisionId: (row.decision_id as string | null) ?? null,
    class: (row.class as string | null) ?? null,
    coversFrom: (row.covers_from as number | null) ?? null,
    coversTo: (row.covers_to as number | null) ?? null,
    data: parsed<Record<string, unknown>>(row.data, {}),
    source: row.source as UpdateSource,
    subject: (row.subject as string | null) ?? null,
    supersedes: (row.supersedes as number | null) ?? null,
    supersededBy: (row.superseded_by as number | null) ?? null,
    at: row.at as number,
    seenAt: (row.seen_at as number | null) ?? null,
    seenVia: (row.seen_via as SeenVia | null) ?? null,
    outcome: (row.outcome as string | null) ?? null,
    backAt: (row.back_at as number | null) ?? null,
    resolvedAt: (row.resolved_at as number | null) ?? null,
  };
}

/** When a deferred line comes back: the next time the clock reads the owner's morning ("HH:MM", local) after `now`. */
export function nextMorning(now: number, morning: string): number {
  const [h, m] = morning.split(':').map(Number);
  const at = new Date(now);
  at.setHours(h ?? 6, m ?? 0, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/** Still the owner's to look at: never seen, or deferred and back. */
export function isOpen(update: Pick<DeskUpdate, 'seenAt' | 'backAt' | 'supersededBy'>, now: number): boolean {
  if (update.supersededBy !== null) return false;
  return update.seenAt === null || (update.backAt !== null && update.backAt <= now);
}

/** A brief still waiting on the owner's pick: seen or not, until it is answered. */
export function isWaiting(update: Pick<DeskUpdate, 'kind' | 'resolvedAt' | 'supersededBy' | 'seenVia' | 'outcome'>): boolean {
  return update.kind === 'needs' && update.resolvedAt === null && update.supersededBy === null;
}

/** What the ledger needs from Loom: decisions made for the owner since a time. */
export interface UpdatesDecidedSource {
  decided(since: number): Promise<{ decisions: Array<{ id: string; thread_id: string; thread_title: string | null; class: string; level: number; status: 'acted' | 'defaulted'; summary: string; undo: string | null; ref: string | null; at: number; reversed_at: number | null; reversal: 'undo' | 'disagree' | null; rule?: string | null }>; more: boolean; rules?: UpdatesRuleEvent[] } | null>;
}

/** A change the delegation learning loop made (Loom GET /decisions `rules`). */
export interface UpdatesRuleEvent {
  id: string;
  kind: string;
  at: number;
  rule: string | null;
  class: string;
  decision: string | null;
  thread_id: string | null;
  from_level: number | null;
  to_level: number | null;
  text: string;
  rule_choice: 'always' | 'next-time' | 'once' | null;
  state: string | null;
}

/** A System incident, as the System page reads it. */
export interface UpdatesIncident {
  id: number;
  title: string;
  severity: string;
  status: string;
  firstSeen: string;
  lastSeen: string;
  resolvedAt: string | null;
}

export interface MergedPr {
  url: string;
  number: number;
  title: string;
}

export interface DeskUpdatesOptions {
  db: DatabaseSync;
  /** The desk's items, with roles (core.items()). */
  items: () => DeskItem[];
  /** The space a conversation belongs to (spaceOf over the desk's projects); null when it has none. */
  spaceOf: (item: DeskItem) => string | null;
  /** Moves a thread's coveredUntil (and its unread) up to `until`. */
  coverThread?: (itemId: string, until: number) => void;
  /** Where a thread is covered to now, and how many of its messages fall strictly between two times. */
  thread?: { coveredUntil(itemId: string): number | null; messagesBetween(itemId: string, after: number, before: number): number };
  decided?: UpdatesDecidedSource | null;
  /**
   * Where the retired Decided for you card was last marked seen (setting `decided_seen_at`); null when it never was.
   * Decisions and rule changes at or before it were acknowledged there, so their lines start seen.
   */
  decidedSeenAt?: () => number | null;
  /** `gh`, for merged PRs; null leaves PRs out. */
  exec?: Exec | null;
  /**
   * A PR merged that this conversation linked (a Loom worker among them has finished its task). Resolves true once
   * delivered, or when there is nothing to deliver; false is asked again next pass, for up to a day.
   */
  onMerged?: (item: DeskItem, pr: MergedPr) => Promise<boolean>;
  /** The System page's incidents. */
  incidents?: () => Promise<UpdatesIncident[]>;
  /** What leads wrote (Loom GET /catchup): desk_update lines and chapter notes. */
  lead?: { catchup(after: number): Promise<LeadCatchup | null> } | null;
  /** Writes a chapter's headline and status from its lines (one cheap model call); null leaves them as they are. */
  writeChapter?: ChapterWriter | null;
  /** A space's name as the owner knows it (a project's or agent's name). */
  spaceName?: (spaceId: string) => string;
  /** The project spaces that are snoozed or parked, on their own or through a parent (projects.ts holderOf). */
  awaySpaces?: () => ReadonlySet<string>;
  now?: () => number;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export class DeskUpdates {
  private readonly now: () => number;
  private readonly listeners = new Set<(ids: number[]) => void>();
  private ghAvailable: Promise<boolean> | null = null;
  private syncing: Promise<void> | null = null;
  /** The chapter writer's pass, when one is running. */
  writing: Promise<void> | null = null;

  constructor(private readonly options: DeskUpdatesOptions) {
    this.now = options.now ?? Date.now;
    const db = options.db;
    db.exec(`CREATE TABLE IF NOT EXISTS desk_updates (${Object.entries(COLUMNS).map(([name, type]) => `${name} ${type}`).join(', ')})`);
    const existing = new Set((db.prepare('PRAGMA table_info(desk_updates)').all() as Array<{ name: string }>).map((c) => c.name));
    for (const [name, type] of Object.entries(COLUMNS)) if (!existing.has(name)) db.exec(`ALTER TABLE desk_updates ADD COLUMN ${name} ${type.replace(/PRIMARY KEY AUTOINCREMENT/, '')}`);
    db.exec(`
      CREATE INDEX IF NOT EXISTS desk_updates_space ON desk_updates(space_id, at);
      CREATE INDEX IF NOT EXISTS desk_updates_item ON desk_updates(item_id, at);
      CREATE INDEX IF NOT EXISTS desk_updates_subject ON desk_updates(subject, id);
      CREATE TABLE IF NOT EXISTS desk_chapters (
        space_id TEXT PRIMARY KEY,
        headline TEXT,
        status TEXT,
        written_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS desk_update_cursors (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    // Who wrote the chapter's prose last: a lead (chapter_note) or the writer (phase 2).
    const chapterColumns = new Set((db.prepare('PRAGMA table_info(desk_chapters)').all() as Array<{ name: string }>).map((c) => c.name));
    if (!chapterColumns.has('written_by')) db.exec('ALTER TABLE desk_chapters ADD COLUMN written_by TEXT');
    // The writer's grouping of the chapter's lines (collapse.ts), kept with its prose.
    if (!chapterColumns.has('layout')) db.exec('ALTER TABLE desk_chapters ADD COLUMN layout TEXT');
    // The writer's rules the prose was written under (WRITER_VERSION): older prose is rewritten once.
    if (!chapterColumns.has('writer_version')) db.exec('ALTER TABLE desk_chapters ADD COLUMN writer_version INTEGER');
  }

  /** Nothing from before this is news: a day before the ledger first ran. */
  private horizon(): number {
    let started = Number(this.cursor('started'));
    if (!Number.isFinite(started) || started <= 0) {
      started = this.now();
      this.setCursor('started', String(started));
    }
    return started - FIRST_LOOK_MS;
  }

  private log(event: string, data: Record<string, unknown> = {}): void {
    this.options.log?.(event, data);
  }

  /** Told the ids of lines written or marked, so screens can re-read. */
  subscribe(listener: (ids: number[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Which lines Catch me up shows changed without a line changing: a conversation or a project went away or came
   * back (heldAway reads that at read time). Screens re-read their chapters; no line is re-posted.
   */
  awayChanged(): void {
    this.notify([]);
  }

  private emit(ids: number[]): void {
    if (ids.length) this.notify(ids);
  }

  private notify(ids: number[]): void {
    for (const listener of this.listeners) {
      try {
        listener(ids);
      } catch {
        // a screen's listener never breaks a write
      }
    }
  }

  private cursor(key: string): string | null {
    return (this.options.db.prepare('SELECT value FROM desk_update_cursors WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }

  private setCursor(key: string, value: string): void {
    this.options.db.prepare('INSERT INTO desk_update_cursors (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** The original behind a relayed ask: ids for briefs, an exact ask key plus reporting line for workers. */
  private copiedAsk(itemId: string, text: string, items: Map<string, DeskItem>): DeskItem | undefined {
    if (items.get(itemId)?.facts.openAsk?.id) return undefined;
    return [...items.values()].find((other) => {
      if (other.id === itemId || other.hidden) return false;
      const brief = other.facts.openBrief?.brief ?? other.facts.pending?.brief;
      if (brief && namesDecision(text, brief.id)) return true;
      const ask = other.facts.openAsk;
      return other.facts.role === 'worker' && other.facts.parentItemId === itemId &&
        other.disposition === 'active' && !!ask && !ask.id && !ask.to && ask.at > (other.lastOwnerMessageAt ?? 0) &&
        askKey(text, itemId) === askKey(ask.text, other.conversationKey);
    });
  }

  /** A worker ask explicitly passed to the owner keeps its original row and closes with that worker. */
  private statusFor(item: DeskItem) {
    const ask = item.facts.openAsk;
    const carried = ask && this.cursor(`carried-ask:${item.id}`) === String(ask.at);
    if (carried && !ask.to) return deskStatus({ ...item, facts: { ...item.facts, role: 'interactive', parentItemId: null } }, this.now());
    return deskStatus(item, this.now());
  }

  /** Settle once, including deferred lines; the timestamp also invalidates the chapter writer. */
  private settleAsk(id: number, foldedInto?: number): void {
    this.options.db.prepare("UPDATE desk_updates SET resolved_at = ?, seen_at = COALESCE(seen_at, ?), seen_via = COALESCE(seen_via, 'acted'), back_at = NULL, superseded_by = COALESCE(?, superseded_by) WHERE id = ? AND resolved_at IS NULL")
      .run(this.now(), this.now(), foldedInto ?? null, id);
    this.emit([id]);
  }

  /** A closing handoff settles only this thread's earlier lead asks. Matching asks keep the status line. */
  private settleOwnedAsks(items: Map<string, DeskItem>): void {
    const rows = this.options.db.prepare("SELECT * FROM desk_updates WHERE source = 'lead' AND kind = 'needs' AND resolved_at IS NULL AND superseded_by IS NULL").all() as Row[];
    for (const line of rows.map(toUpdate)) {
      const item = line.itemId ? items.get(line.itemId) : undefined;
      if (!item) continue;
      const copied = this.copiedAsk(item.id, line.title, items);
      const handoff = item.facts.handoff;
      if (!copied && (!handoff || handoff.at <= line.at)) continue;
      const status = this.latest(`status:${item.id}`);
      const folded = status?.kind === 'needs' && status.resolvedAt === null &&
        askKey(status.title, item.conversationKey) === askKey(line.title, item.conversationKey);
      this.settleAsk(line.id, folded ? status.id : undefined);
    }
  }

  // ── reading ────────────────────────────────────────────────────────────

  private withStatus(update: DeskUpdate, byId = new Map(this.options.items().map(item => [item.id, item]))): DeskUpdate {
    if (update.kind !== 'needs' && update.kind !== 'failed') return update;
    const source = update.itemId ? byId.get(update.itemId) : undefined;
    const item = source?.facts.carriedBy ? byId.get(source.facts.carriedBy.itemId) : source;
    const status = item ? this.statusFor(item) : undefined;
    // A Stuck row's line is a `failed` line (the ledger has no stuck kind): it counts the same way.
    if (status?.countsForOwner && (status.pill === 'stuck' ? 'failed' : status.pill) === update.kind) return { ...update, status };
    return { ...update, status, kind: 'fyi', moment: false };
  }

  get(id: number): DeskUpdate | null {
    const row = this.options.db.prepare('SELECT * FROM desk_updates WHERE id = ?').get(id) as Row | undefined;
    return row ? this.withStatus(toUpdate(row)) : null;
  }

  /** The current line on a subject (the newest, not replaced). */
  latest(subject: string): DeskUpdate | null {
    const row = this.options.db.prepare('SELECT * FROM desk_updates WHERE subject = ? AND superseded_by IS NULL ORDER BY id DESC LIMIT 1').get(subject) as Row | undefined;
    return row ? toUpdate(row) : null;
  }

  /**
   * Current lines, newest first: one space or all, since a time, only the open ones. `awake` leaves out the lines of a
   * conversation that is snoozed or parked, on its own or held by its project (heldAway).
   */
  list(options: { space?: string; since?: number; unseen?: boolean; itemId?: string; limit?: number; awake?: boolean } = {}): DeskUpdate[] {
    const where = ['superseded_by IS NULL'];
    const params: SQLInputValue[] = [];
    if (options.space) {
      where.push('space_id = ?');
      params.push(options.space);
    }
    if (options.itemId) {
      where.push('item_id = ?');
      params.push(options.itemId);
    }
    if (options.since !== undefined) {
      where.push('at >= ?');
      params.push(options.since);
    }
    if (options.unseen) {
      where.push('(seen_at IS NULL OR (back_at IS NOT NULL AND back_at <= ?))');
      params.push(this.now());
    }
    const rows = this.options.db.prepare(`SELECT * FROM desk_updates WHERE ${where.join(' AND ')} ORDER BY at DESC, id DESC LIMIT ?`).all(...params, options.limit ?? 500) as Row[];
    const byId = new Map(this.options.items().map(item => [item.id, item]));
    const away = options.awake ? this.options.awaySpaces?.() ?? new Set<string>() : null;
    return rows.filter(row => !away || !heldAway(row, byId, away)).map(toUpdate).map(update => this.withStatus(update, byId));
  }

  /** Per space: its counts and state, the spaces with news first, then by their newest line. */
  chapters(): Chapter[] {
    const now = this.now();
    const statusItems = new Map(this.options.items().map(item => [item.id, item]));
    // A snoozed or parked conversation's lines wait with it: they count again, still unseen, once it comes back.
    const away = this.options.awaySpaces?.() ?? new Set<string>();
    const rows = (this.options.db.prepare('SELECT * FROM desk_updates WHERE superseded_by IS NULL ORDER BY at').all() as Row[]).filter(row => !heldAway(row, statusItems, away));
    const prose = new Map((this.options.db.prepare('SELECT space_id, headline, status, written_at, layout FROM desk_chapters').all() as Array<{ space_id: string; headline: string | null; status: string | null; written_at: number | null; layout: string | null }>).map((r) => [r.space_id, r]));
    const bySpace = new Map<string, Chapter>();
    const waitsBySpace = new Map<string, DeskUpdate[]>();
    const openBySpace = new Map<string, DeskUpdate[]>();
    const current = rows.map(toUpdate).map(update => this.withStatus(update, statusItems));
    // Needs you cleaned up (triage.ts): per space, its open and waiting lines under the writer's sort and the fold
    // across spaces. Tidied lines count as smaller, not as needs or moments; asks filed as news count as needs.
    const waitingAll = current.filter(isWaiting);
    const cross = crossFolds(waitingAll, now);
    const tidyBySpace = new Map<string, ChapterTidy | null>();
    const tidyOf = (spaceId: string) => {
      if (!tidyBySpace.has(spaceId)) {
        const lines = current.filter((u) => u.spaceId === spaceId && (isOpen(u, now) || isWaiting(u)));
        tidyBySpace.set(spaceId, this.tidy(lines, readLayout(prose.get(spaceId)?.layout), { cross, all: waitingAll, items: statusItems }));
      }
      return tidyBySpace.get(spaceId) ?? null;
    };
    for (const update of current) {
      const chapter = bySpace.get(update.spaceId) ?? { spaceId: update.spaceId, headline: ownerHeadline(prose.get(update.spaceId)?.headline), status: ownerStatus(prose.get(update.spaceId)?.status), state: 'caught_up' as ChapterState, moments: 0, needs: 0, smaller: 0, waits: null, since: null, oldestAt: null, lastAt: 0, backAt: null };
      bySpace.set(update.spaceId, chapter);
      chapter.lastAt = Math.max(chapter.lastAt, update.at);
      if (isWaiting(update) && !tidiedIds(tidyOf(update.spaceId)).has(update.id)) {
        // A brief the owner deferred still waits (the headline says so) but leaves today's counts until it's back.
        if (!(update.backAt !== null && update.backAt > now)) chapter.needs += 1;
        (waitsBySpace.get(update.spaceId) ?? waitsBySpace.set(update.spaceId, []).get(update.spaceId)!).push(update);
        chapter.oldestAt = chapter.oldestAt === null ? update.at : Math.min(chapter.oldestAt, update.at);
      }
      if (isOpen(update, now)) {
        openBySpace.set(update.spaceId, [update, ...(openBySpace.get(update.spaceId) ?? [])]);
        chapter.since = chapter.since === null ? update.at : Math.min(chapter.since, update.at);
        chapter.oldestAt = chapter.oldestAt === null ? update.at : Math.min(chapter.oldestAt, update.at);
      } else if (update.backAt !== null && update.backAt > now) {
        chapter.backAt = chapter.backAt === null ? update.backAt : Math.min(chapter.backAt, update.backAt);
      }
    }
    // Moments as the card shows them: rule changes batched, routine decisions folded into their PR.
    // Smaller updates as the card lists them: a milestone's lines are its moment, a folded decision is part of its PR's line.
    for (const [spaceId, open] of openBySpace) {
      const tidy = tidyOf(spaceId);
      const view = collapse(open, readLayout(prose.get(spaceId)?.layout), tidy);
      const chapter = bySpace.get(spaceId)!;
      const out = tidiedIds(tidy);
      chapter.moments = view.moments.length;
      chapter.smaller = view.groups.reduce((n, g) => n + g.lines.length, 0) + open.filter((u) => out.has(u.id)).length;
    }
    // An answer the prose hasn't caught up with: until the writer rewrites it (within a minute, writeChapters), a
    // headline or status that still says the answered ask waits on the owner gives way to the plain version.
    for (const chapter of bySpace.values()) {
      const writtenAt = prose.get(chapter.spaceId)?.written_at ?? 0;
      const answered = rows.filter((r) => r.space_id === chapter.spaceId && r.kind === 'needs' && typeof r.resolved_at === 'number' && r.resolved_at > writtenAt).map((r) => ({ title: String(r.title) }));
      // And a wait no open ask backs (an ask carried from older prose, or a lead's note that outlived its ask).
      // Read as Needs you shows it: a repeat shown elsewhere doesn't back a wait.
      const tidy = tidyOf(chapter.spaceId);
      const waiting = tidied(rows.filter((r) => r.space_id === chapter.spaceId).map(toUpdate).filter(isWaiting), tidy);
      const outdated = (text: string | null) => !!text && (!!(answered.length && stillAsks(text, answered)) || !!unbackedAsk(text, waiting));
      if (!outdated(chapter.headline) && !outdated(chapter.status)) continue;
      const plain = plainChapter({ spaceId: chapter.spaceId, name: chapter.spaceId, open: tidied(openBySpace.get(chapter.spaceId) ?? [], tidy), handled: [], previous: { headline: null, status: null }, milestone: null, now });
      if (outdated(chapter.headline)) chapter.headline = ownerHeadline(plain.headline);
      if (outdated(chapter.status)) chapter.status = ownerStatus(plain.status);
    }
    // What waits on the owner leads the headline, from the asks Needs you counts (the writer leaves that half out).
    for (const chapter of bySpace.values()) {
      const asks = waitsBySpace.get(chapter.spaceId) ?? [];
      const titles = readLayout(prose.get(chapter.spaceId)?.layout)?.titles ?? {};
      chapter.waits = waitsLine(asks.map((u) => titles[String(u.id)] ?? u.title));
      if (chapter.waits) chapter.headline = [chapter.waits, chapter.headline].filter(Boolean).join(' ');
    }
    // A space with prose and no lines (a lead's note alone, or its lines pruned) is still a chapter, caught up.
    for (const [spaceId, p] of prose) if (!bySpace.has(spaceId)) bySpace.set(spaceId, { spaceId, headline: ownerHeadline(p.headline), status: ownerStatus(p.status), state: 'caught_up', moments: 0, needs: 0, smaller: 0, waits: null, since: null, oldestAt: null, lastAt: p.written_at ?? 0, backAt: null });
    // Deferred until it comes back or a new moment arrives: smaller updates meanwhile wait with it (spec, Defer).
    for (const chapter of bySpace.values()) chapter.state = chapter.moments > 0 ? 'news' : chapter.backAt !== null ? 'deferred' : chapter.smaller > 0 ? 'news' : 'caught_up';
    // What waits on the owner first, read or not (a deferred chapter waits with its briefs), then moments, then smaller.
    const rank = (c: Chapter) => (c.state === 'deferred' ? 3 : c.needs > 0 ? 0 : c.state === 'news' ? (c.moments > 0 ? 1 : 2) : 3);
    return [...bySpace.values()].sort((a, b) => rank(a) - rank(b) || b.lastAt - a.lastAt);
  }

  /** A chapter's headline and status, from a lead's chapter_note or the writer; every surface reads them here. */
  setProse(spaceId: string, prose: { headline?: string | null; status?: string | null; layout?: ChapterLayout | null }, by: 'lead' | 'model' = 'lead', at = this.now(), version = WRITER_VERSION): void {
    const current = this.options.db.prepare('SELECT headline, status, layout FROM desk_chapters WHERE space_id = ?').get(spaceId) as { headline: string | null; status: string | null; layout: string | null } | undefined;
    const headline = prose.headline !== undefined ? clip(prose.headline, MAX_DETAIL) : (current?.headline ?? null);
    const status = prose.status !== undefined ? clip(prose.status, MAX_DETAIL) : (current?.status ?? null);
    const layout = prose.layout !== undefined ? (prose.layout ? JSON.stringify(prose.layout) : null) : (current?.layout ?? null);
    this.options.db
      .prepare('INSERT INTO desk_chapters (space_id, headline, status, written_at, written_by, layout, writer_version) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(space_id) DO UPDATE SET headline = excluded.headline, status = excluded.status, written_at = excluded.written_at, written_by = excluded.written_by, layout = excluded.layout, writer_version = excluded.writer_version')
      .run(spaceId, headline, status, at, by, layout, version);
  }

  /**
   * How the card shows a chapter's lines (collapse.ts), with the writer's grouping and its sort of Needs you when it
   * has them. `waiting`: briefs and asks seen but still waiting, which the sort covers too.
   */
  view(spaceId: string, lines: DeskUpdate[], waiting: DeskUpdate[] = []): ChapterView {
    const layout = readLayout(this.prose(spaceId)?.layout);
    const ids = new Set(lines.map((u) => u.id));
    return collapse(lines, layout, this.tidy([...lines, ...waiting.filter((u) => !ids.has(u.id))], layout));
  }

  /** Every needs line still waiting, in every space (what the fold across spaces reads). */
  private waitingNeeds(items: Map<string, DeskItem>): DeskUpdate[] {
    const rows = this.options.db.prepare("SELECT * FROM desk_updates WHERE kind = 'needs' AND superseded_by IS NULL AND resolved_at IS NULL").all() as Row[];
    return rows.map(toUpdate).map((u) => this.withStatus(u, items)).filter(isWaiting);
  }

  /** A space's lines under the writer's sort and the fold across spaces (triage.ts); null when nothing is tidied. */
  private tidy(lines: DeskUpdate[], layout: ChapterLayout | null, context: { cross?: Map<number, DeskUpdate>; all?: DeskUpdate[]; items?: Map<string, DeskItem> } = {}): ChapterTidy | null {
    const items = context.items ?? new Map(this.options.items().map((i) => [i.id, i]));
    const all = context.all ?? this.waitingNeeds(items);
    const cross = context.cross ?? crossFolds(all);
    if (!layout?.triage && !lines.some((u) => cross.has(u.id) || [...cross.values()].some((k) => k.id === u.id))) return null;
    const lookup = this.options.db.prepare('SELECT id, title, at FROM desk_updates WHERE id = ?');
    const tidy = tidyChapter(lines, layout?.triage, {
      lookup: (id) => (lookup.get(id) as { id: number; title: string; at: number } | undefined) ?? null,
      cross,
      all,
      from: (u) => {
        const item = u.itemId ? items.get(u.itemId) : undefined;
        return item?.summary?.about || item?.summary?.title || item?.facts.name || null;
      },
      spaceName: (spaceId) => this.options.spaceName?.(spaceId) ?? null,
    });
    return tidy.elsewhere.length || Object.keys(tidy.also).length || Object.keys(tidy.notes).length ? tidy : null;
  }

  private prose(spaceId: string): { headline: string | null; status: string | null; written_at: number | null; written_by: string | null; layout: string | null; writer_version: number | null } | null {
    return (this.options.db.prepare('SELECT headline, status, written_at, written_by, layout, writer_version FROM desk_chapters WHERE space_id = ?').get(spaceId) as { headline: string | null; status: string | null; written_at: number | null; written_by: string | null; layout: string | null; writer_version: number | null } | undefined) ?? null;
  }

  /** Whether the owner has made a class routine: enough Fines lately, and no reversal in the last month. */
  routine(cls: string): boolean {
    if (ROUTINE_CLASSES.has(cls)) return true;
    const since = this.now() - LEARNING_MS;
    const counts = this.options.db
      // Fines over the last two months of decisions; a reversal counts from when the owner made it, not from the decision.
      .prepare("SELECT SUM(CASE WHEN outcome = 'fine' AND at >= ? THEN 1 ELSE 0 END) AS fine, SUM(CASE WHEN outcome IN ('undo', 'disagree') AND seen_at >= ? THEN 1 ELSE 0 END) AS reversed FROM desk_updates WHERE kind = 'decided' AND class = ?")
      .get(since, this.now() - 30 * DAY, cls) as { fine: number | null; reversed: number | null };
    return (counts.fine ?? 0) >= ROUTINE_AFTER_FINES && (counts.reversed ?? 0) === 0;
  }

  // ── writing ────────────────────────────────────────────────────────────

  /**
   * Writes a line, replacing the current one on its subject. The same news again (same kind and title) is not a new
   * line: it returns the current one untouched, so a source can say what it knows on every pass.
   */
  record(input: NewUpdate): DeskUpdate {
    const db = this.options.db;
    const title = clip(input.title, MAX_TITLE) ?? '(untitled)';
    const current = input.subject ? this.latest(input.subject) : null;
    if (current && !input.renew && current.kind === input.kind && current.title === title) return current;
    const at = input.at ?? this.now();
    const moment = momentFor(input, { routine: (cls) => this.routine(cls) });
    const result = db
      .prepare(
        `INSERT INTO desk_updates (space_id, item_id, kind, moment, title, detail, refs, shot, brief_id, decision_id, class, covers_from, covers_to, data, source, subject, supersedes, at, seen_at, seen_via, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.spaceId,
        input.itemId ?? null,
        input.kind,
        moment ? 1 : 0,
        title,
        clip(input.detail, MAX_DETAIL),
        JSON.stringify(input.refs ?? []),
        input.shot ?? null,
        input.briefId ?? null,
        input.decisionId ?? null,
        input.class ?? null,
        input.coversFrom ?? input.coversTo ?? null,
        input.coversTo ?? input.coversFrom ?? null,
        JSON.stringify(input.data ?? {}),
        input.source,
        input.subject ?? null,
        current?.id ?? null,
        at,
        input.seen ? this.now() : null,
        input.seen?.via ?? null,
        input.seen?.outcome ?? null,
      );
    const id = Number(result.lastInsertRowid);
    if (current) {
      db.prepare('UPDATE desk_updates SET superseded_by = ? WHERE id = ?').run(id, current.id);
      // Supersession closes an ask too. Keep the observation time without changing the original's lifecycle
      // timestamps (a retraction can restore it, and a decision keeps its actual answer time).
      if (current.kind === 'needs' && current.resolvedAt === null) this.setCursor(`needs-closed:${current.spaceId}`, String(this.now()));
    }
    this.emit(current ? [current.id, id] : [id]);
    return this.get(id)!;
  }

  /** Takes a line back (its cause was undone): the one it replaced, if any, is current again. */
  retract(subject: string): DeskUpdate | null {
    const current = this.latest(subject);
    if (!current) return null;
    const db = this.options.db;
    db.prepare('DELETE FROM desk_updates WHERE id = ?').run(current.id);
    if (current.supersedes !== null) db.prepare('UPDATE desk_updates SET superseded_by = NULL WHERE id = ?').run(current.supersedes);
    this.emit([current.id]);
    return current;
  }

  /**
   * The owner saw these lines: each is marked (the first mark stands, except a deferral coming back), and the threads
   * they stand for are covered as far as the seen spans reach without a gap (coverThreads). Returns the lines now.
   */
  seen(ids: number[], via: SeenVia, outcome: string | null = null, options: { backAt?: number | null } = {}): DeskUpdate[] {
    const db = this.options.db;
    const now = this.now();
    const marked: DeskUpdate[] = [];
    const cover = new Set<string>();
    for (const id of [...new Set(ids)]) {
      const update = this.get(id);
      if (!update) continue;
      // Already handled, and not a deferral that came back (or is being acted on now): it stays as it was marked.
      const redo = update.seenAt === null || update.backAt !== null || via !== 'read';
      if (redo) {
        const backAt = via === 'deferred' ? (options.backAt ?? null) : null;
        db.prepare('UPDATE desk_updates SET seen_at = ?, seen_via = ?, outcome = COALESCE(?, outcome), back_at = ? WHERE id = ?').run(now, via, outcome, backAt, id);
      }
      if (update.itemId && update.coversTo !== null) cover.add(update.itemId);
      marked.push(this.get(id)!);
    }
    for (const itemId of cover) this.coverThreadFrom(itemId);
    this.emit(marked.map((u) => u.id));
    return marked;
  }

  /** Undo a card snooze without erasing a newer mark, resolution or replacement. */
  restoreSnooze(ids: number[], backAt: number | null, seenAt: number | null): DeskUpdate[] {
    const restored: DeskUpdate[] = [];
    for (const id of [...new Set(ids)]) {
      const result = this.options.db.prepare(`UPDATE desk_updates SET seen_at = NULL, seen_via = NULL, outcome = NULL, back_at = NULL
        WHERE id = ? AND superseded_by IS NULL AND resolved_at IS NULL
        AND seen_via = ? AND outcome = ? AND back_at IS ? AND (? IS NULL OR seen_at = ?)`)
        .run(id, backAt === null ? 'read' : 'deferred', backAt === null ? 'got-it' : 'later', backAt, seenAt, seenAt);
      if (result.changes) restored.push(this.get(id)!);
    }
    this.emit(restored.map(u => u.id));
    return restored;
  }

  /**
   * The owner chose how a decision counts (Always / Ask me next time / Just this once) on its new-rule moment: the
   * rule-event lines for it carry the choice now, and are handled with it. Returns the lines marked.
   */
  ruleChosen(decisionId: string, choice: string): DeskUpdate[] {
    const rows = this.options.db
      .prepare("SELECT * FROM desk_updates WHERE decision_id = ? AND superseded_by IS NULL AND json_extract(data, '$.ruleEvent') IN ('rule-created', 'rule-reaffirmed')")
      .all(decisionId) as Row[];
    if (!rows.length) return [];
    const update = this.options.db.prepare("UPDATE desk_updates SET data = json_set(data, '$.ruleChoice', ?) WHERE id = ?");
    for (const row of rows) update.run(choice, row.id as number);
    return this.seen(rows.map((r) => r.id as number), 'acted', choice);
  }

  /**
   * Covers a thread through its seen spans, in order, from where it is covered now: each span that starts with no
   * message of the thread unseen before it extends the cover to its end. A gap stops it; a later span waits there.
   */
  private coverThreadFrom(itemId: string): void {
    const { coverThread, thread } = this.options;
    if (!coverThread || !thread) return;
    const spans = this.options.db
      .prepare('SELECT covers_from, covers_to FROM desk_updates WHERE item_id = ? AND seen_at IS NOT NULL AND covers_to IS NOT NULL ORDER BY covers_from, covers_to')
      .all(itemId) as Array<{ covers_from: number; covers_to: number }>;
    const start = thread.coveredUntil(itemId) ?? 0;
    let cursor = start;
    for (const span of spans) {
      if (span.covers_to <= cursor) continue;
      if (span.covers_from > cursor && thread.messagesBetween(itemId, cursor, span.covers_from) > 0) break;
      cursor = span.covers_to;
    }
    if (cursor > start) coverThread(itemId, cursor);
  }

  /**
   * The owner read a thread (the 3 s viewed timer): the lines it showed inline are seen `via: read`. Only those: a
   * line the thread never rendered wasn't read. The thread's own cover isn't moved again; reading it already did.
   */
  readThread(itemId: string, shown: number[]): number[] {
    if (!shown.length) return [];
    const rows = this.options.db
      .prepare(`SELECT id FROM desk_updates WHERE item_id = ? AND superseded_by IS NULL AND (seen_at IS NULL OR (back_at IS NOT NULL AND back_at <= ?)) AND id IN (${shown.map(() => '?').join(',')})`)
      .all(itemId, this.now(), ...shown) as Array<{ id: number }>;
    if (!rows.length) return [];
    const now = this.now();
    // Unseen, or a deferral that came back: read now, and no longer coming back.
    const mark = this.options.db.prepare("UPDATE desk_updates SET seen_at = ?, seen_via = 'read', back_at = NULL WHERE id = ?");
    for (const { id } of rows) mark.run(now, id);
    const ids = rows.map((r) => r.id);
    this.emit(ids);
    return ids;
  }

  /** Drops lines older than the ledger keeps; the owner's Fines and reversals stay as long as the learning reads them. */
  prune(): number {
    const result = this.options.db
      // A Fine counts by its decision's time (60 days); a reversal by when the owner made it (30 days).
      // A deferral stays until it comes back (and is handled then).
      .prepare("DELETE FROM desk_updates WHERE at < ? AND NOT (kind = 'decided' AND ((outcome = 'fine' AND at >= ?) OR (outcome IN ('undo', 'disagree') AND seen_at >= ?))) AND NOT (back_at IS NOT NULL AND back_at > ?) AND NOT (back_at IS NOT NULL AND back_at <= ? AND seen_via = 'deferred')")
      .run(this.now() - KEEP_MS, this.now() - LEARNING_MS, this.now() - 30 * DAY, this.now(), this.now());
    return Number(result.changes);
  }

  // ── automatic sources ──────────────────────────────────────────────────

  /**
   * Voice lab scratch threads (lab-fence.ts) are test fixtures, not news: they never reach a catch-up. Remembered in
   * the database, not with the fence, because the fence lapses and the threads are marked done afterwards.
   */
  markScratch(itemIds: string[]): void {
    for (const itemId of itemIds) {
      this.setCursor(`scratch:${itemId}`, '1');
      for (const line of this.list({ itemId, limit: 200 })) if (line.subject) this.retract(line.subject);
    }
  }

  private isScratch(itemId: string): boolean {
    return this.cursor(`scratch:${itemId}`) !== null;
  }

  /** The space a conversation's news belongs to: a worker's rolls up to the conversation it reports to. */
  spaceFor(item: DeskItem, byId?: Map<string, DeskItem>): string {
    const items = byId ?? new Map(this.options.items().map((i) => [i.id, i]));
    let at: DeskItem | undefined = item;
    const seen = new Set<string>();
    // Workers and ops roll up; a lead (or anything owner-facing) is where the space is read.
    while (at && (at.facts.role === 'worker' || at.facts.role === 'ops') && at.facts.parentItemId && !seen.has(at.id)) {
      seen.add(at.id);
      const parent = items.get(at.facts.parentItemId);
      if (!parent) break;
      // A worker filed in a project of its own keeps it.
      if (this.options.spaceOf(at)?.startsWith('project:')) break;
      at = parent;
    }
    if (item.source === 'system') return SYSTEM_SPACE;
    return (at && this.options.spaceOf(at)) ?? this.options.spaceOf(item) ?? UNFILED_SPACE;
  }

  /**
   * What a desk event means for the ledger: a thread done is a line (seen already when the owner did it), Done
   * undone takes it back, and reading a thread for 3 s marks its lines read.
   */
  onDeskEvent(event: Pick<DeskEvent, 'type' | 'itemId' | 'at' | 'actor' | 'payload' | 'seq'>): void {
    try {
      if (event.type === 'clear') {
        const key = `clear:${event.seq}`;
        if (this.cursor(key)) return;
        const rows = this.options.db.prepare('SELECT id, seen_at, seen_via, outcome, back_at, resolved_at FROM desk_updates WHERE item_id = ? AND superseded_by IS NULL AND (seen_at IS NULL OR back_at IS NOT NULL)').all(event.itemId);
        this.setCursor(key, JSON.stringify({ at: event.at, rows }));
        const mark = this.options.db.prepare("UPDATE desk_updates SET seen_at = ?, seen_via = 'acted', back_at = NULL WHERE id = ?");
        for (const row of rows) mark.run(event.at, Number(row.id));
        this.emit(rows.map((row) => Number(row.id)));
        return;
      }
      if (event.type === 'undo' && event.payload.type === 'clear') {
        const saved = this.cursor(`clear:${event.payload.seq}`);
        if (!saved) return;
        const snapshot = JSON.parse(saved) as { at: number; rows: Array<{ id: number; seen_at: number | null; seen_via: string | null; outcome: string | null; back_at: number | null; resolved_at: number | null }> };
        const restore = this.options.db.prepare("UPDATE desk_updates SET seen_at = ?, seen_via = ?, outcome = ?, back_at = ? WHERE id = ? AND seen_at = ? AND seen_via = 'acted' AND back_at IS NULL AND outcome IS ? AND resolved_at IS ? AND superseded_by IS NULL");
        const restored: number[] = [];
        for (const row of snapshot.rows) {
          if (restore.run(row.seen_at, row.seen_via, row.outcome, row.back_at, row.id, snapshot.at, row.outcome, row.resolved_at).changes) restored.push(row.id);
        }
        this.emit(restored);
        return;
      }
      // Snooze, Park and their ends change what Catch me up leaves out: screens re-read now, not on their next tick.
      if (AWAY_EVENTS.has(event.type)) this.awayChanged();
      if (event.type === 'seen' && event.payload.via === 'viewed') {
        const shown = Array.isArray(event.payload.updates) ? (event.payload.updates as unknown[]).filter((id): id is number => Number.isInteger(id)) : [];
        this.readThread(event.itemId, shown);
        return;
      }
      if (event.type === 'undo' && (event.payload.type === 'done' || event.payload.type === 'chapter.settled')) {
        const current = this.latest(`done:${event.itemId}`);
        if (current && current.source === 'auto:done') this.retract(`done:${event.itemId}`);
        return;
      }
      if (event.type === 'done' || event.type === 'source.done' || event.type === 'chapter.settled') this.recordDone(event.itemId, event.at, event.actor === 'owner' || event.actor === 'screen' || event.actor === 'voice');
    } catch (err) {
      this.log('desk.updates.error', { stage: 'event', message: (err as Error).message });
    }
  }

  private recordDone(itemId: string, at: number, byOwner: boolean): void {
    const items = this.options.items();
    const byId = new Map(items.map((i) => [i.id, i]));
    const item = byId.get(itemId);
    // A System incident's item settling is the incident resolving: syncIncidents says that.
    if (!item || item.hidden || item.source === 'system' || this.isScratch(itemId)) return;
    const headline = item.summary?.headline?.trim();
    // No summary yet (one is often written just after it settles): the next sync records it once there is.
    if (!headline) {
      this.setCursor(`done-pending:${itemId}`, JSON.stringify({ at, byOwner }));
      return;
    }
    this.options.db.prepare('DELETE FROM desk_update_cursors WHERE key = ?').run(`done-pending:${itemId}`);
    const merged = this.list({ itemId, limit: 50 }).some((u) => u.source === 'auto:pr' && u.kind === 'shipped');
    const shipped = merged || this.list({ itemId, limit: 50 }).some(u => u.source === 'lead' && u.kind === 'shipped');
    this.record({
      spaceId: this.spaceFor(item, byId),
      itemId,
      kind: shipped ? 'shipped' : 'fyi',
      title: headline,
      detail: item.summary?.gist ?? null,
      source: 'auto:done',
      subject: `done:${itemId}`,
      // Done again later (it was reopened): news again, even with the same headline.
      renew: (() => { const current = this.latest(`done:${itemId}`); return !!current && at - current.at > DONE_AGAIN_MS; })(),
      at,
      ...(byOwner ? { seen: { via: 'acted' as const, outcome: 'ok' } } : {}),
    });
  }

  /** One pass over every automatic source; one at a time. Never throws. */
  sync(): Promise<void> {
    this.syncing ??= this.syncOnce().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async syncOnce(): Promise<void> {
    const step = async (stage: string, work: () => unknown) => {
      try {
        await work();
      } catch (err) {
        this.log('desk.updates.error', { stage, message: (err as Error).message });
      }
    };
    await step('briefs', () => this.syncBriefs());
    await step('statuses', () => this.syncStatuses());
    await step('finished', () => this.syncFinished());
    await step('done', () => this.syncPendingDone());
    await step('lead', () => this.syncLead());
    await step('owned-asks', () => this.settleOwnedAsks(new Map(this.options.items().map(i => [i.id, i]))));
    await step('decided', () => this.syncDecided());
    await step('prs', () => this.syncPullRequests());
    await step('merged', () => this.syncPendingMerged());
    await step('pr-states', () => this.syncPrStates());
    await step('recheck', () => this.recheck());
    if (this.options.incidents) {
      const read = this.options.incidents;
      await step('incidents', async () => this.syncIncidents(await read()));
    }
    // The model calls run beside the sources, never in their way: a stalled model never holds up the next pass.
    this.writing ??= this.writeChapters()
      .catch((err) => this.log('desk.updates.error', { stage: 'chapters', message: (err as Error).message }))
      .finally(() => {
        this.writing = null;
      });
  }

  /**
   * What leads wrote: each desk_update a line in the space of its conversation (a worker's in its lead's), each
   * chapter_note that space's headline and status. A line that supersedes an earlier one takes its subject.
   */
  async syncLead(): Promise<void> {
    const source = this.options.lead;
    if (!source) return;
    const byId = new Map(this.options.items().map((i) => [i.id, i]));
    let after = Number(this.cursor('lead')) || 0;
    for (let page = 0; page < 20; page += 1) {
      const read = await source.catchup(after);
      if (!read) return;
      type Lead = { seq: number; update?: LeadCatchup['updates'][number]; note?: LeadCatchup['notes'][number] };
      const events: Lead[] = [...read.updates.map((u) => ({ seq: u.seq, update: u })), ...read.notes.map((n) => ({ seq: n.seq, note: n }))].sort((a, b) => a.seq - b.seq);
      for (const event of events) {
        const threadId = event.update?.thread_id ?? event.note!.thread_id;
        // A scratch thread's notes and updates are fixtures: neither writes a line nor a chapter's prose.
        if (this.isScratch(`loom:${threadId}`)) {
          after = event.seq;
          continue;
        }
        const threadItem = byId.get(`loom:${threadId}`);
        // A thread the desk hasn't filed yet (a new one, or a startup backlog): wait for it a while before Unfiled.
        if (!threadItem && this.now() - (event.update?.created_at ?? event.note!.created_at) < LEAD_FILE_WAIT_MS) {
          this.setCursor('lead', String(after));
          return;
        }
        const spaceId = threadItem ? this.spaceFor(threadItem, byId) : UNFILED_SPACE;
        if (event.note) {
          // Written when the lead wrote it, so a later line still gets the chapter rewritten.
          this.setProse(spaceId, { ...(event.note.headline ? { headline: event.note.headline } : {}), ...(event.note.status ? { status: event.note.status } : {}) }, 'lead', event.note.created_at);
          after = event.seq;
          continue;
        }
        const u = event.update!;
        const original = u.kind === 'needs' ? this.copiedAsk(`loom:${threadId}`, u.title, byId) : undefined;
        if (u.kind === 'needs' && (original || this.cursor(`relayed-update:${u.id}`))) {
          // A later coverage revision of the same post must not revive it after the original closes.
          if (original) {
            this.setCursor(`relayed-update:${u.id}`, original.id);
            if (original.facts.openAsk && !original.facts.openBrief && !original.facts.pending?.brief)
              this.setCursor(`carried-ask:${original.id}`, String(original.facts.openAsk.at));
          }
          const prior = u.supersedes ? this.byLoomId(u.supersedes) : null;
          if (prior?.kind === 'needs' && prior.spaceId === spaceId && prior.resolvedAt === null) this.settleAsk(prior.id);
          after = event.seq;
          continue;
        }
        const known = this.byLoomId(u.id);
        if (known) {
          // Read again: its run ended, so it covers the thread through the final reply.
          if (u.covers_to !== null && (known.coversTo ?? 0) < u.covers_to) {
            this.options.db.prepare("UPDATE desk_updates SET covers_to = ? WHERE json_extract(data, '$.loomId') = ?").run(u.covers_to, u.id);
            if (known.seenAt !== null && known.itemId) this.coverThreadFrom(known.itemId);
          }
          after = event.seq;
          continue;
        }
        // Only a line in the same space: another chapter's news is never replaced from here.
        const found = u.supersedes ? this.byLoomId(u.supersedes) : null;
        const replaced = found && found.spaceId === spaceId ? found : null;
        // A needs or failed post its conversation no longer backs shows as news, and says what it was filed as (so the
        // cleanup never promotes it back into Needs you).
        const demoted = (u.kind === 'needs' || u.kind === 'failed') && (!threadItem || !deskStatus(threadItem, this.now()).countsForOwner || deskStatus(threadItem, this.now()).pill !== u.kind);
        this.record({
          spaceId,
          itemId: `loom:${u.thread_id}`,
          kind: demoted ? 'fyi' : u.kind,
          ...(u.moment !== null ? { moment: u.moment === 1 } : {}),
          title: u.title,
          detail: u.detail,
          refs: u.refs,
          shot: u.shot,
          coversFrom: u.covers_from,
          coversTo: u.covers_to,
          data: { loomId: u.id, ...(demoted ? { filedAs: u.kind } : {}) },
          source: 'lead',
          subject: replaced?.subject ?? `lead:${u.id}`,
          renew: true,
          at: u.created_at,
        });
        after = event.seq;
      }
      after = read.last;
      this.setCursor('lead', String(after));
      if (!read.more) return;
    }
  }

  /** The line a lead's desk_update became (by its Loom id), current or replaced. */
  private byLoomId(loomId: string): DeskUpdate | null {
    const row = this.options.db.prepare("SELECT * FROM desk_updates WHERE json_extract(data, '$.loomId') = ? ORDER BY id DESC LIMIT 1").get(loomId) as Row | undefined;
    return row ? toUpdate(row) : null;
  }

  /**
   * The chapter writer: a space whose lines changed since its prose was written, once it has gone quiet, at most every
   * 30 minutes. A lead's own chapter_note since the newest line stands; the writer leaves it.
   */
  async writeChapters(): Promise<void> {
    const write = this.options.writeChapter;
    if (!write) return;
    const now = this.now();
    for (const chapter of this.chapters()) {
      const prose = this.prose(chapter.spaceId);
      // Handling counts as a change too: the status is written once the chapter is handled.
      const handledAt = (this.options.db.prepare('SELECT MAX(MAX(COALESCE(seen_at, 0), COALESCE(resolved_at, 0))) AS at FROM desk_updates WHERE space_id = ?').get(chapter.spaceId) as { at: number | null }).at ?? 0;
      const supersededAt = Number(this.cursor(`needs-closed:${chapter.spaceId}`)) || 0;
      const changed = Math.max(chapter.lastAt, handledAt, supersededAt);
      // The owner handled something since the prose was written, and nothing new came after: the headline may still
      // say it waits on them, so it is rewritten within a minute, not after the gap.
      // An answered ask counts whatever came after it: answering a brief usually makes its lead post straight away, and
      // that news mustn't leave the headline asking for the answer until the 30-minute gap.
      const answeredAt = Math.max(supersededAt, (this.options.db.prepare("SELECT MAX(resolved_at) AS at FROM desk_updates WHERE space_id = ? AND kind = 'needs'").get(chapter.spaceId) as { at: number | null }).at ?? 0);
      const handledSince = (handledAt > (prose?.written_at ?? 0) && handledAt >= chapter.lastAt) || answeredAt > (prose?.written_at ?? 0);
      // Prose written under the writer's older rules is rewritten once, now, whatever the gap.
      // A lead's own chapter_note stands: only the writer's prose is rewritten.
      const stale = !!prose && prose.written_by !== 'lead' && (prose.writer_version ?? 0) < WRITER_VERSION;
      if (!stale && now - (handledSince ? Math.max(handledAt, answeredAt) : changed) < (handledSince ? HANDLED_SETTLE_MS : WRITE_SETTLE_MS)) continue;
      if (!stale && prose?.written_at && (prose.written_at >= changed || (!handledSince && now - prose.written_at < WRITE_GAP_MS))) continue;
      // Every line still open, however old; handled ones only lately, for context.
      const lines = this.list({ space: chapter.spaceId, limit: 500 });
      const open = lines.filter((u) => isOpen(u, now) || isWaiting(u)).slice(0, 60);
      const handled = lines.filter((u) => !open.includes(u) && u.at >= now - 3 * DAY).slice(0, 10);
      const byId = new Map(this.options.items().map((i) => [i.id, i]));
      const lead = [...byId.values()].find((i) => i.facts.role === 'default' && this.spaceFor(i, byId) === chapter.spaceId);
      try {
        const written = await write({
          spaceId: chapter.spaceId,
          name: this.options.spaceName?.(chapter.spaceId) ?? chapter.spaceId,
          open: open.map((u) => {
            const item = u.itemId ? byId.get(u.itemId) : undefined;
            const brief = u.kind === 'needs' && u.briefId === item?.facts.openBrief?.brief?.id ? item?.facts.openBrief?.brief : undefined;
            return { id: u.id, kind: u.kind, moment: u.moment, title: u.title, detail: u.detail, at: u.at, source: u.source, ...(u.briefId ? { brief: true } : {}),
              conversation: item?.summary?.about || item?.summary?.title || item?.facts.name || undefined,
              standing: brief?.standing?.slice(0, 300), background: brief?.background?.split('\n')[0]?.slice(0, 300) };
          }),
          handled: handled.map((u) => ({ id: u.id, kind: u.kind, title: u.title, outcome: u.outcome, at: u.at, source: u.source })),
          previous: { headline: prose?.headline ?? null, status: prose?.status ?? null },
          milestone: lead?.summary?.milestone ?? null,
          now,
        });
        // A writer that didn't group (the plain fallback) leaves the layout it had; ids gone from the chapter just drop out.
        // The plain fallback for a chapter due a rewrite keeps its old version, so the model gets it on the next pass.
        const version = written?.plain && stale ? (prose?.writer_version ?? 0) : WRITER_VERSION;
        if (written) this.setProse(chapter.spaceId, { headline: written.headline, status: written.status, ...(written.layout ? { layout: written.layout } : {}) }, 'model', now, version);
      } catch (err) {
        this.log('desk.updates.error', { stage: 'chapter', space: chapter.spaceId, message: (err as Error).message });
      }
    }
  }

  /**
   * The turn preamble for a lead (spec "Leads stop retelling"): what the owner has seen in its space since `since`, and
   * anything they deferred there. Null when there's nothing to say.
   */
  seenBrief(itemId: string, since: number): string | null {
    const byId = new Map(this.options.items().map((i) => [i.id, i]));
    const item = byId.get(itemId);
    if (!item) return null;
    const spaceId = this.spaceFor(item, byId);
    const now = this.now();
    const seen = (this.options.db
      .prepare("SELECT * FROM desk_updates WHERE space_id = ? AND superseded_by IS NULL AND seen_at > ? AND (back_at IS NULL OR back_at <= ?) ORDER BY seen_at DESC LIMIT ?")
      .all(spaceId, since, now, SEEN_LINES) as Row[]).map(toUpdate);
    const deferred = (this.options.db
      .prepare('SELECT * FROM desk_updates WHERE space_id = ? AND superseded_by IS NULL AND back_at > ? ORDER BY at DESC LIMIT ?')
      .all(spaceId, now, SEEN_LINES) as Row[]).map(toUpdate);
    // The space's open asks a lead posted: a closing handoff settles its own earlier asks (done
    // outside Tango, answered in chat, overtaken by a decision), so each turn it is shown them to close what's stale.
    const asks = (this.options.db
      .prepare("SELECT * FROM desk_updates WHERE space_id = ? AND source = 'lead' AND kind IN ('needs', 'failed') AND superseded_by IS NULL AND resolved_at IS NULL ORDER BY at LIMIT ?")
      .all(spaceId, SEEN_LINES) as Row[]).map(toUpdate).filter((u) => !!u.data.loomId && (u.kind === 'needs' ? isWaiting(u) : isOpen(u, now)));
    if (!seen.length && !deferred.length && !asks.length) return null;
    const how = (u: DeskUpdate) => {
      const outcome = u.outcome === 'fine' ? 'fine by them' : u.outcome === 'undo' ? 'they asked to undo it' : u.outcome === 'disagree' ? "they wouldn't have" : u.outcome === 'later' ? 'later' : u.outcome && u.kind === 'needs' ? `answered ${u.outcome}` : null;
      return `- ${u.title}${outcome ? ` (${outcome})` : ''}`;
    };
    const parts: string[] = [];
    if (seen.length || deferred.length) parts.push('[Catch-up] Since your last turn the owner has seen these in this space\'s catch-up. Don\'t retell these. Point to them.', ...seen.map(how));
    if (deferred.length) {
      const back = new Date(Math.min(...deferred.map((u) => u.backAt!)));
      parts.push(`They deferred these (seen, not decided; back ${back.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}). Don't retell them meanwhile:`, ...deferred.map((u) => `- ${u.title}`));
    }
    if (asks.length) {
      const since = (u: DeskUpdate) => new Date(u.at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      parts.push(
        '[Catch-up] These still show on the owner\'s catch-up as open. If one is no longer true (it was done, answered in chat or elsewhere, or a decision overtook it), close it now: `loom.desk_update` with `supersedes` its id, saying what happened (kind fyi or decided). Leave the ones that still hold.',
        ...asks.map((u) => `- ${u.data.loomId ?? `line ${u.id}`} (${u.kind}, since ${since(u)}): ${u.title}`),
      );
    }
    return parts.join('\n');
  }

  /** Threads done before they had a summary: their line, once the summary is written (given up on after a day). */
  syncPendingDone(): void {
    const rows = this.options.db.prepare("SELECT key, value FROM desk_update_cursors WHERE key LIKE 'done-pending:%'").all() as Array<{ key: string; value: string }>;
    if (!rows.length) return;
    const byId = new Map(this.options.items().map((i) => [i.id, i]));
    for (const row of rows) {
      const itemId = row.key.slice('done-pending:'.length);
      const pending = parsed<{ at?: number; byOwner?: boolean }>(row.value, {});
      const item = byId.get(itemId);
      const stale = typeof pending.at !== 'number' || pending.at < this.now() - DAY;
      if (!item || item.disposition !== 'done' || stale) {
        this.options.db.prepare('DELETE FROM desk_update_cursors WHERE key = ?').run(row.key);
        continue;
      }
      if (item.summary?.headline?.trim()) this.recordDone(itemId, pending.at!, pending.byOwner === true);
    }
  }

  /** Merged PRs the onMerged hook hasn't yet taken: asked again each pass until it does (given up on after a day). */
  async syncPendingMerged(): Promise<void> {
    const rows = this.options.db.prepare("SELECT key, value FROM desk_update_cursors WHERE key LIKE 'merged-pending:%'").all() as Array<{ key: string; value: string }>;
    if (!rows.length) return;
    const byId = new Map(this.options.items().map((i) => [i.id, i]));
    const drop = (key: string) => this.options.db.prepare('DELETE FROM desk_update_cursors WHERE key = ?').run(key);
    for (const row of rows) {
      const itemId = row.key.slice('merged-pending:'.length, row.key.indexOf('|'));
      const pending = parsed<Partial<MergedPr> & { at?: number }>(row.value, {});
      const item = byId.get(itemId);
      const stale = typeof pending.at !== 'number' || pending.at < this.now() - DAY;
      if (!item || !this.options.onMerged || stale || !pending.url || typeof pending.number !== 'number') {
        drop(row.key);
        continue;
      }
      try {
        if (await this.options.onMerged(item, { url: pending.url, number: pending.number, title: pending.title ?? '' })) drop(row.key);
      } catch (err) {
        this.log('desk.updates.error', { stage: 'pr-merged', url: pending.url, itemId, message: (err as Error).message });
      }
    }
  }

  /** Requests, typed asks and failures enter catch-up with exactly the row's predicate. */
  syncStatuses(): void {
    const items = this.options.items();
    const byId = new Map(items.map(item => [item.id, item]));
    // Keep the reference, not a needs line. If the original closes before the lead speaks again, its old relay
    // must not come back as an independent ask. A fresh ask has a fresh recorded timestamp.
    for (const item of items) {
      const ask = item.facts.openAsk;
      if (!ask || ask.to || item.hidden || !deskStatus(item, this.now()).countsForOwner) continue;
      const original = this.copiedAsk(item.id, ask.text, byId);
      if (!original) continue;
      this.setCursor(`relayed-ask:${item.id}`, String(ask.at));
      if (original.facts.openAsk && !original.facts.openBrief && !original.facts.pending?.brief)
        this.setCursor(`carried-ask:${original.id}`, String(original.facts.openAsk.at));
    }
    for (const item of items) {
      const subject = `status:${item.id}`;
      const current = this.latest(subject);
      const status = this.statusFor(item);
      const brief = item.facts.openBrief || item.facts.pending?.brief || item.facts.carried?.some(c => c.counts);
      const relayed = item.facts.openAsk && !item.facts.openAsk.id && this.cursor(`relayed-ask:${item.id}`) === String(item.facts.openAsk.at);
      if (!status.countsForOwner || item.hidden || (status.pill === 'needs' && (brief || relayed || this.copiedAsk(item.id, status.detail, byId)))) {
        if (current && current.resolvedAt === null) {
          if (current.kind === 'needs') this.settleAsk(current.id);
          else this.options.db.prepare('UPDATE desk_updates SET resolved_at = ? WHERE id = ?').run(this.now(), current.id);
        }
        continue;
      }
      // Compared as stored (clipped), and without the running hint: a long ask, or a thread starting and stopping,
      // is the same news, not a new line on every sync (the Feed Screen thread's review of #928).
      const kind = status.pill === 'failed' || status.pill === 'stuck' ? 'failed' : 'needs';
      const title = status.pill === 'stuck' ? `Stuck: ${status.detail}` : status.detail.replace(/ · still working$/, '');
      const ask = kind === 'needs' ? item.facts.openAsk : null;
      const data = ask?.id ? { askId: ask.id, askKind: ask.kind, askRevision: ask.revision } : {};
      if (current && current.resolvedAt === null && current.kind === kind && current.title === clip(title, MAX_TITLE) && (!ask?.id || current.data.askId === ask.id)) {
        if (ask?.id && (current.data.askRevision !== ask.revision || current.data.askKind !== ask.kind)) {
          this.options.db.prepare('UPDATE desk_updates SET data = ? WHERE id = ?').run(JSON.stringify({ ...current.data, ...data }), current.id);
          this.emit([current.id]);
        }
        continue;
      }
      this.record({ spaceId: this.spaceFor(item, byId), itemId: item.id,
        kind, title, data,
        source: 'auto:status', subject, renew: true,
        at: item.facts.failed?.at ?? item.facts.pending?.at ?? item.facts.openAsk?.at ?? item.facts.handoff?.at ?? this.now() });
    }
    this.settleOwnedAsks(byId);
  }

  /**
   * A row that became Finished (its hand-off said nobody acts next) is a `shipped` line, one per finish. The lead's own
   * `shipped` update or the PR's merge line in the same stretch of work says it better, so it stands in instead and
   * takes back a Finished line already written (desk-status.md, "Finished and Stuck").
   */
  syncFinished(): void {
    const items = this.options.items();
    const byId = new Map(items.map(item => [item.id, item]));
    for (const item of items) {
      const handoff = item.facts.handoff;
      // A finish from before the ledger began looking is history, not news (as a merged PR's is).
      if (!handoff || handoff.at < Math.max(this.now() - PR_LOOKBACK_MS, this.horizon()) || item.hidden || item.disposition === 'done' || this.isScratch(item.id)) continue;
      const status = deskStatus(item, this.now());
      if (status.pill !== 'finished' || status.audience !== 'owner') continue;
      const subject = `handoff:${item.id}:${handoff.runId ?? handoff.at}`;
      const stretch = item.lastOwnerMessageAt ?? 0;
      const said = this.list({ itemId: item.id, limit: 50 }).some(u => u.kind === 'shipped' && (u.source === 'lead' || u.source === 'auto:pr') && u.at >= stretch);
      const current = this.latest(subject);
      if (said) {
        if (current?.source === 'auto:handoff') this.retract(subject);
        continue;
      }
      if (current) continue;
      this.record({ spaceId: this.spaceFor(item, byId), itemId: item.id, kind: 'shipped',
        title: handoff.text || item.summary?.headline || 'Finished', source: 'auto:handoff', subject, at: handoff.at });
    }
  }

  /** Open briefs are `needs` lines; a brief that closed without a default is resolved (the owner answered it). */
  syncBriefs(): void {
    const items = this.options.items();
    const byId = new Map(items.map((i) => [i.id, i]));
    const open = new Set<string>();
    for (const item of items) {
      const brief = item.facts.openBrief?.brief;
      if (!brief || item.hidden) continue;
      open.add(brief.id);
      const current = this.latest(`decision:${brief.id}`);
      const recommended = item.facts.openBrief?.questions?.[0]?.options.find((o) => /\(Recommended\)$/.test(o.label))?.label.replace(/\s*\(Recommended\)$/, '') ?? null;
      if (current?.kind === 'needs') {
        this.reviseBrief(current, { spaceId: this.spaceFor(item, byId), title: item.facts.openBrief!.question ?? brief.id, detail: recommended ? `Recommended: ${recommended}` : null, class: brief.class, revision: brief.revision ?? null });
        continue;
      }
      this.record({
        spaceId: this.spaceFor(item, byId),
        itemId: item.id,
        kind: 'needs',
        title: item.facts.openBrief!.question ?? brief.id,
        detail: recommended ? `Recommended: ${recommended}` : null,
        briefId: brief.id,
        decisionId: brief.id,
        class: brief.class,
        data: brief.revision !== undefined ? { revision: brief.revision } : {},
        source: 'auto:brief',
        subject: `decision:${brief.id}`,
        at: item.facts.openBrief!.at ?? this.now(),
        // It stands for the brief itself: seeing it reads the thread up to the ask when nothing else is unread before it.
        ...(item.facts.openBrief!.at ? { coversTo: item.facts.openBrief!.at } : {}),
      });
    }
    // A brief line whose brief no longer shows anywhere: answered (by the owner, or a default that `decided` brings).
    // Only once the brief's conversation has been read and says it has no brief: an item not yet read stays open.
    const waiting = this.options.db.prepare("SELECT * FROM desk_updates WHERE kind = 'needs' AND superseded_by IS NULL AND resolved_at IS NULL").all() as Row[];
    for (const update of waiting.map(toUpdate)) {
      if (!update.briefId || open.has(update.briefId)) continue;
      const item = update.itemId ? byId.get(update.itemId) : undefined;
      if (item && item.facts.openBrief === undefined) continue;
      const now = this.now();
      this.options.db.prepare("UPDATE desk_updates SET resolved_at = ?, seen_at = COALESCE(seen_at, ?), seen_via = COALESCE(seen_via, 'acted'), back_at = NULL WHERE id = ?").run(now, now, update.id);
      this.emit([update.id]);
    }
  }

  /**
   * A brief revised in place keeps its line (same decision), with the new words, filed where its conversation is now. A new revision is news again: a line
   * the owner already saw opens again, since what they saw is no longer what is asked.
   */
  private reviseBrief(current: DeskUpdate, next: { spaceId: string; title: string; detail: string | null; class: string | null; revision: number | null }): void {
    const title = clip(next.title, MAX_TITLE) ?? current.title;
    const detail = clip(next.detail, MAX_DETAIL);
    const revised = next.revision !== null && typeof current.data.revision === 'number' && next.revision > current.data.revision;
    if (next.spaceId === current.spaceId && title === current.title && detail === current.detail && next.class === current.class && !revised && (next.revision === null || current.data.revision === next.revision)) return;
    const data = JSON.stringify({ ...current.data, ...(next.revision !== null ? { revision: next.revision } : {}) });
    this.options.db
      .prepare(`UPDATE desk_updates SET space_id = ?, title = ?, detail = ?, class = ?, data = ?${revised ? ', seen_at = NULL, seen_via = NULL, outcome = NULL, back_at = NULL' : ''} WHERE id = ?`)
      .run(next.spaceId, title, detail, next.class, data, current.id);
    this.emit([current.id]);
  }

  /** Decisions Loom made or let run for the owner: `decided` lines, replacing the brief's `needs` line. */
  async syncDecided(): Promise<void> {
    const source = this.options.decided;
    if (!source) return;
    const items = this.options.items();
    const byId = new Map(items.map((i) => [i.id, i]));
    const stored = Number(this.cursor('decided'));
    let since = Number.isFinite(stored) && stored > 0 ? stored + 1 : this.horizon();
    this.migrateDecidedSeen();
    this.retireOwnerRules();
    await this.migrateCollapse(source);
    for (let page = 0; page < 10; page += 1) {
      const read = await source.decided(since);
      if (!read) break;
      this.recordRuleEvents(read.rules ?? [], byId);
      if (!read.decisions.length) break;
      // Loom reports the rule a decision was made under: lines read from here on are rated with it.
      if (!this.cursor('collapse_v1') && read.decisions.some((d) => 'rule' in d)) this.setCursor('collapse_v1', String(this.now()));
      let newest = since - 1;
      for (const d of read.decisions) {
        newest = Math.max(newest, d.at);
        const itemId = `loom:${d.thread_id}`;
        const item = byId.get(itemId);
        const current = this.latest(`decision:${d.id}`);
        if (current?.kind === 'decided') continue;
        const update = this.record({
          spaceId: item ? this.spaceFor(item, byId) : (current?.spaceId ?? UNFILED_SPACE),
          itemId,
          kind: 'decided',
          title: d.summary,
          detail: d.undo ? `Undo: ${d.undo}` : null,
          // The way back, for the catch-up card's Undo (which needn't have Decided for you's reading), and the standing
          // rule it was made under (routine then: momentFor).
          data: { ...(d.undo ? { undo: d.undo } : {}), ...(d.rule ? { underRule: d.rule } : {}) },
          refs: d.ref && /^https?:\/\//.test(d.ref) ? [{ label: d.ref.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60), url: d.ref }] : [],
          decisionId: d.id,
          class: d.class,
          source: 'auto:decision',
          subject: `decision:${d.id}`,
          at: d.at,
          ...(d.reversal ? { seen: { via: 'acted' as const, outcome: d.reversal } } : this.seenOnCard(d.at)),
        });
        // A default that ran: the brief it answered is settled too.
        if (update.supersedes !== null) this.options.db.prepare('UPDATE desk_updates SET resolved_at = COALESCE(resolved_at, ?) WHERE id = ?').run(d.at, update.supersedes);
      }
      since = newest + 1;
      this.setCursor('decided', String(newest));
      if (!read.more) break;
    }
  }

  /**
   * What the delegation learning loop changed that the owner should confirm: a rule created, reaffirmed or suspended,
   * a class demoted. Always a moment; the card keeps Always / Ask me next time / Just this once on it.
   */
  private recordRuleEvents(events: UpdatesRuleEvent[], byId: Map<string, DeskItem>): void {
    for (const e of events) {
      if (!RULE_MOMENTS.has(e.kind) || e.at < this.horizon()) continue;
      const subject = `rule:${e.id}`;
      if (this.latest(subject)) continue;
      const itemId = e.thread_id ? `loom:${e.thread_id}` : null;
      const item = itemId ? byId.get(itemId) : undefined;
      this.record({
        spaceId: item ? this.spaceFor(item, byId) : (e.decision ? this.latest(`decision:${e.decision}`)?.spaceId : null) ?? UNFILED_SPACE,
        itemId,
        kind: 'decided',
        alwaysMoment: true,
        title: e.text,
        decisionId: e.decision,
        class: e.class,
        data: { ruleEvent: e.kind, rule: e.rule, ruleChoice: e.rule_choice, fromLevel: e.from_level, toLevel: e.to_level, state: e.state },
        source: 'auto:decision',
        subject,
        at: e.at,
        ...this.seenOnCard(e.at),
      });
    }
  }

  /** Already acknowledged on the retired Decided for you card: the line starts seen, `via: read`. */
  private seenOnCard(at: number): { seen?: { via: 'read' } } {
    const seenAt = this.options.decidedSeenAt?.() ?? null;
    return seenAt !== null && at <= seenAt ? { seen: { via: 'read' } } : {};
  }

  /**
   * Once, on the first sync after the card retired: decided lines already written unseen (the ledger wrote them
   * alongside the card) and acknowledged there are marked seen, so the catch-up doesn't bring them back.
   */
  private migrateDecidedSeen(): void {
    if (!this.options.decidedSeenAt || this.cursor('decided_seen_migrated')) return;
    const seenAt = this.options.decidedSeenAt();
    if (seenAt !== null) {
      const ids = (this.options.db
        .prepare("SELECT id FROM desk_updates WHERE kind = 'decided' AND source = 'auto:decision' AND seen_at IS NULL AND at <= ?")
        .all(seenAt) as Array<{ id: number }>).map((r) => r.id);
      if (ids.length) this.seen(ids, 'read');
    }
    this.setCursor('decided_seen_migrated', String(this.now()));
  }

  /**
   * Once, when the collapse rules arrive (D-94): decided lines already in the ledger, still open, are rated again by
   * today's moment rules. They learn the standing rule each was made under (Loom reads it back), and a routine op or a
   * decision under a rule stops being a moment. It only ever lowers a moment. A Loom that doesn't say which rule
   * (older than the `rule` field) leaves it for a later pass.
   */
  /**
   * Once: a rule the owner made or reaffirmed from their own answer is theirs, not news (Loom stopped sending these in
   * #821), so the open lines recorded before that are marked handled, `via: acted`.
   */
  private retireOwnerRules(): void {
    if (this.cursor('owner_rules_v1')) return;
    const rows = this.options.db
      .prepare("SELECT id FROM desk_updates WHERE kind = 'decided' AND superseded_by IS NULL AND seen_at IS NULL AND json_extract(data, '$.ruleEvent') IN ('rule-created', 'rule-reaffirmed')")
      .all() as Array<{ id: number }>;
    const now = this.now();
    const mark = this.options.db.prepare("UPDATE desk_updates SET seen_at = ?, seen_via = 'acted', back_at = NULL WHERE id = ?");
    for (const r of rows) mark.run(now, r.id);
    this.setCursor('owner_rules_v1', String(now));
    if (rows.length) {
      this.log('desk.updates.owner-rules', { handled: rows.length });
      this.emit(rows.map((r) => r.id));
    }
  }

  private async migrateCollapse(source: UpdatesDecidedSource): Promise<void> {
    if (this.cursor('collapse_v1')) return;
    // The other way: an open own-machine op stored as routine (its class had turned routine) that failed or kept
    // something down is a moment now, whatever Loom reports.
    const raise = this.options.db.prepare('UPDATE desk_updates SET moment = 1 WHERE id = ?');
    const raised: number[] = [];
    for (const u of (this.options.db.prepare("SELECT * FROM desk_updates WHERE kind = 'decided' AND class = ? AND moment = 0 AND superseded_by IS NULL AND seen_at IS NULL").all(OPS_CLASS) as Row[]).map(toUpdate)) {
      if (!costly(`${u.title} ${u.detail ?? ''}`)) continue;
      raise.run(u.id);
      raised.push(u.id);
    }
    if (raised.length) {
      this.log('desk.updates.collapse', { raised: raised.length });
      this.emit(raised);
    }
    const rows = (this.options.db.prepare("SELECT * FROM desk_updates WHERE kind = 'decided' AND source = 'auto:decision' AND superseded_by IS NULL AND moment = 1").all() as Row[]).map(toUpdate).filter((u) => !isRuleEvent(u));
    const rules = new Map<string, string>();
    // Nothing to rate again yet: stay pending until Loom shows it reports `rule` (the sync below marks it done then), so
    // lines read meanwhile from an older Loom are rated again once it upgrades.
    if (!rows.length) return;
    {
      let since = Math.min(...rows.map((u) => u.at));
      let told = false;
      for (let page = 0; page < 20; page += 1) {
        const read = await source.decided(since);
        if (!read) return;
        let newest = since - 1;
        for (const d of read.decisions) {
          newest = Math.max(newest, d.at);
          if ('rule' in d) told = true;
          if (d.rule) rules.set(d.id, d.rule);
        }
        if (!read.more || !read.decisions.length) break;
        since = newest + 1;
      }
      if (!told) return;
    }
    const lower = this.options.db.prepare('UPDATE desk_updates SET moment = 0, data = ? WHERE id = ?');
    const changed: number[] = [];
    for (const u of rows) {
      const rule = u.decisionId ? rules.get(u.decisionId) : undefined;
      const data = rule ? { ...u.data, underRule: rule } : u.data;
      if (momentFor({ kind: u.kind, class: u.class, title: u.title, detail: u.detail, data }, { routine: (cls) => this.routine(cls) })) continue;
      lower.run(JSON.stringify(data), u.id);
      changed.push(u.id);
    }
    this.setCursor('collapse_v1', String(this.now()));
    this.log('desk.updates.collapse', { lowered: changed.length });
    this.emit(changed);
  }

  /** What a record a line rests on says now (recheck.ts): from the ledger's decision lines and the PR states kept. */
  private sourceState(key: SourceKey): SourceState | null {
    if (key.startsWith('ask:')) {
      const ask = this.options.items().map((item) => item.facts.askLedger).find((record) => record?.id === key.slice(4));
      return ask?.status && ask.status !== 'open' ? { key, state: 'settled', at: ask.resolved_at ?? ask.at, said: null } : null;
    }
    if (key.startsWith('decision:')) {
      const line = this.latest(key);
      if (line?.kind === 'decided') return { key, state: 'settled', at: line.at, said: line.title };
      if (line?.kind === 'needs' && line.resolvedAt !== null) return { key, state: 'settled', at: line.resolvedAt, said: null };
      return null;
    }
    const known = parsed<{ state?: string; at?: number; by?: { number: number; url: string } } | null>(this.cursor(`pr-state:${key}`), null);
    if (known?.state === 'reverted' && known.by && typeof known.at === 'number') return { key, state: 'reverted', at: known.at, by: known.by };
    if (known?.state === 'closed' && typeof known.at === 'number') return { key, state: 'closed', at: known.at };
    return null;
  }

  /**
   * The PRs recent shipped lines rest on (recheck.ts), as GitHub records them: one a lead said shipped is asked once
   * whether it merged or closed, and each repo's merged reverts ("Reverts owner/repo#12", what GitHub's Revert button
   * writes) are read at most every few minutes for the PRs they undid. Returns the gh calls made.
   */
  async syncPrStates(): Promise<number> {
    const exec = this.options.exec === undefined ? defaultExec : this.options.exec;
    if (!exec) return 0;
    this.ghAvailable ??= exec('gh', ['auth', 'status']).then(() => true, () => false);
    if (!(await this.ghAvailable)) return 0;
    const now = this.now();
    const lines = (this.options.db.prepare("SELECT * FROM desk_updates WHERE kind = 'shipped' AND superseded_by IS NULL AND at >= ?").all(now - RECHECK_WINDOW_MS) as Row[]).map(toUpdate);
    const tracked = new Map<string, { url: string; merged: boolean }>();
    for (const line of lines) {
      for (const key of sourcesOf(line)) {
        if (!key.startsWith('pr:')) continue;
        const url = line.refs.find((r) => prKey(r.url) === key)?.url ?? `https://github.com/${key.slice(3).replace('#', '/pull/')}`;
        tracked.set(key, { url, merged: line.source === 'auto:pr' || !!tracked.get(key)?.merged });
      }
    }
    const stateOf = (key: string) => parsed<{ state?: string; checkedAt?: number } | null>(this.cursor(`pr-state:${key}`), null);
    let calls = 0;
    for (const [key, pr] of tracked) {
      const known = stateOf(key);
      if (known?.state === 'merged') pr.merged = true;
      if (pr.merged || known?.state === 'closed' || known?.state === 'reverted') continue;
      if (known?.checkedAt && known.checkedAt > now - REVERT_SCAN_MS) continue;
      if (calls >= RECHECK_CALLS_PER_PASS) break;
      calls += 1;
      try {
        const read = JSON.parse(await exec('gh', ['pr', 'view', pr.url, '--json', 'state,closedAt'])) as { state?: string; closedAt?: string | null };
        if (read.state === 'MERGED') {
          pr.merged = true;
          this.setCursor(`pr-state:${key}`, JSON.stringify({ state: 'merged' }));
        } else if (read.state === 'CLOSED') this.setCursor(`pr-state:${key}`, JSON.stringify({ state: 'closed', at: (read.closedAt && Date.parse(read.closedAt)) || now }));
        else this.setCursor(`pr-state:${key}`, JSON.stringify({ state: 'open', checkedAt: now }));
      } catch (err) {
        this.setCursor(`pr-state:${key}`, JSON.stringify({ state: 'open', checkedAt: now }));
        this.log('desk.updates.error', { stage: 'pr-state', url: pr.url, message: (err as Error).message });
      }
    }
    const repos = new Set([...tracked].filter(([key, pr]) => pr.merged && stateOf(key)?.state !== 'reverted').map(([key]) => key.slice(3).split('#')[0]!));
    for (const repo of repos) {
      if (Number(this.cursor(`revert-scan:${repo}`)) > now - REVERT_SCAN_MS) continue;
      if (calls >= RECHECK_CALLS_PER_PASS) break;
      calls += 1;
      try {
        const read = JSON.parse(await exec('gh', ['pr', 'list', '--repo', repo, '--state', 'merged', '--search', 'Revert in:title', '--limit', '30', '--json', 'number,url,body,mergedAt'])) as Array<{ number: number; url: string; body?: string; mergedAt?: string | null }>;
        for (const revert of read) {
          for (const n of revertedBy(revert.body ?? '', repo)) {
            const key = `pr:${repo}#${n}`;
            // A revert comes after what it undoes.
            if (!tracked.has(key) || n >= revert.number || stateOf(key)?.state === 'reverted') continue;
            this.setCursor(`pr-state:${key}`, JSON.stringify({ state: 'reverted', at: (revert.mergedAt && Date.parse(revert.mergedAt)) || now, by: { number: revert.number, url: revert.url } }));
          }
        }
      } catch (err) {
        this.log('desk.updates.error', { stage: 'pr-reverts', repo, message: (err as Error).message });
      }
      this.setCursor(`revert-scan:${repo}`, String(now));
    }
    return calls;
  }

  /**
   * Every current ask and shipped line against what it rests on (recheck.ts). Where the meaning flipped, a line the
   * owner hadn't seen is quietly replaced with what is true now (an ask whose decision settled just leaves, as an
   * answered brief's does), and one they had seen gets a single "Changed since you saw it" moment on the same subject.
   * A change from before rechecking began is history: replaced quietly, never a correction.
   */
  recheck(): void {
    const db = this.options.db;
    const now = this.now();
    let since = Number(this.cursor('recheck_since'));
    if (!Number.isFinite(since) || since <= 0) {
      since = now;
      this.setCursor('recheck_since', String(now));
    }
    const lines = (db.prepare("SELECT * FROM desk_updates WHERE superseded_by IS NULL AND kind IN ('needs', 'shipped')").all() as Row[]).map(toUpdate);
    const states = new Map<SourceKey, SourceState | null>();
    const state = (key: SourceKey) => {
      if (!states.has(key)) states.set(key, this.sourceState(key));
      return states.get(key) ?? null;
    };
    for (const line of lines) {
      const flip = flipOf(line, state);
      if (!flip) continue;
      const correct = line.seenAt !== null && flip.source.at >= since;
      const recheck = { source: flip.source.key, state: flip.source.state, at: flip.source.at, was: line.title, wasKind: line.kind };
      if (line.kind === 'needs') db.prepare('UPDATE desk_updates SET resolved_at = COALESCE(resolved_at, ?), back_at = NULL WHERE id = ?').run(now, line.id);
      if (line.kind === 'needs' && !correct) {
        db.prepare("UPDATE desk_updates SET seen_at = COALESCE(seen_at, ?), seen_via = COALESCE(seen_via, 'acted'), outcome = COALESCE(outcome, 'settled'), data = json_set(data, '$.recheck', json(?)) WHERE id = ?").run(now, JSON.stringify(recheck), line.id);
        this.emit([line.id]);
        continue;
      }
      let subject = line.subject;
      if (!subject) {
        subject = `line:${line.id}`;
        db.prepare('UPDATE desk_updates SET subject = ? WHERE id = ?').run(subject, line.id);
      }
      this.record({
        spaceId: line.spaceId,
        itemId: line.itemId,
        kind: 'fyi',
        title: flip.title,
        detail: flip.detail,
        refs: flip.refs,
        // It stands for the same thread messages: seeing it reads them, as seeing the line it replaced would have.
        coversFrom: line.coversFrom,
        coversTo: line.coversTo,
        alwaysMoment: correct,
        // A lead's line keeps its Loom id, so the run's later reading (a longer span, a replacement) still finds it.
        data: { ...(typeof line.data.loomId === 'string' ? { loomId: line.data.loomId } : {}), recheck, ...(correct ? { changed: { was: line.title, wasKind: line.kind, seenAt: line.seenAt } } : {}) },
        source: line.source,
        subject,
        renew: true,
        at: Math.max(line.at, flip.source.at),
      });
    }
  }

  /** A PR a conversation linked that has since merged: a `shipped` line in that conversation's space. */
  async syncPullRequests(): Promise<number> {
    const exec = this.options.exec === undefined ? defaultExec : this.options.exec;
    if (!exec) return 0;
    this.ghAvailable ??= exec('gh', ['auth', 'status']).then(() => true, () => false);
    if (!(await this.ghAvailable)) return 0;
    const now = this.now();
    const items = this.options.items();
    const byId = new Map(items.map((i) => [i.id, i]));
    // Each PR once, under the conversation that first linked it (the one that made it, usually).
    const prs = new Map<string, { url: string; number: number; item: DeskItem; lastAt: number; linked: DeskItem[] }>();
    for (const item of [...items].sort((a, b) => a.createdAt - b.createdAt)) {
      if (item.hidden || now - item.lastActivityAt > KEEP_MS) continue;
      const quiet = now - item.lastActivityAt > PR_LOOKBACK_MS;
      for (const artifact of item.artifacts ?? []) {
        if (artifact.kind !== 'pr') continue;
        const pr = parsePrUrl(artifact.url);
        if (!pr) continue;
        // A quiet conversation's PR is still asked about while it was last seen open (it may merge days later).
        const cursor = this.cursor(`pr:${pr.url.toLowerCase()}`);
        if (quiet && (!cursor || cursor === 'closed')) continue;
        const known = prs.get(pr.url.toLowerCase());
        if (known) {
          known.lastAt = Math.max(known.lastAt, item.lastActivityAt);
          if (!known.linked.includes(item)) known.linked.push(item);
        } else prs.set(pr.url.toLowerCase(), { ...pr, item, lastAt: item.lastActivityAt, linked: [item] });
      }
    }
    // The ones talked about most recently are asked about first: that's where a fresh merge is.
    let calls = 0;
    for (const [key, pr] of [...prs].sort((a, b) => b[1].lastAt - a[1].lastAt)) {
      const subject = `pr:${key.replace(/^https:\/\/github\.com\//, '').replace('/pull/', '#')}`;
      if (this.latest(subject)) continue;
      const known = this.cursor(`pr:${key}`);
      if (known === 'closed') continue;
      if (known && Number(known) > now - PR_RECHECK_MS) continue;
      if (calls >= PR_CALLS_PER_PASS) break;
      calls += 1;
      try {
        const read = JSON.parse(await exec('gh', ['pr', 'view', pr.url, '--json', 'state,mergedAt,title'])) as { state?: string; mergedAt?: string | null; title?: string };
        if (read.state === 'MERGED') {
          const at = read.mergedAt ? Date.parse(read.mergedAt) || now : now;
          // Merged before the ledger began looking: history, not news.
          if (at < Math.max(now - PR_LOOKBACK_MS, this.horizon())) {
            this.setCursor(`pr:${key}`, 'closed');
            continue;
          }
          this.record({
            spaceId: this.spaceFor(pr.item, byId),
            itemId: pr.item.id,
            kind: 'shipped',
            title: `Merged PR #${pr.number}: ${read.title ?? ''}`.trim(),
            refs: [{ label: `PR #${pr.number}`, url: pr.url }],
            source: 'auto:pr',
            subject,
            at,
          });
          // Kept until delivered: a Loom that's down when the merge is seen still hears of it once it's back.
          if (this.options.onMerged) {
            const merged: MergedPr = { url: pr.url, number: pr.number, title: read.title ?? '' };
            for (const linked of pr.linked) this.setCursor(`merged-pending:${linked.id}|${key}`, JSON.stringify({ ...merged, at: now }));
          }
          this.setCursor(`pr:${key}`, 'closed');
        } else if (read.state === 'CLOSED') this.setCursor(`pr:${key}`, 'closed');
        else this.setCursor(`pr:${key}`, String(now));
      } catch (err) {
        this.setCursor(`pr:${key}`, String(now));
        this.log('desk.updates.error', { stage: 'pr', url: pr.url, message: (err as Error).message });
      }
    }
    return calls;
  }

  /**
   * System incidents (the System page's reading): an open critical or error incident is a `failed` line in the
   * System space; once it resolves, the line becomes an fyi that says so.
   */
  syncIncidents(incidents: UpdatesIncident[]): void {
    try {
      const now = this.now();
      for (const incident of incidents) {
        if (incident.severity !== 'critical' && incident.severity !== 'error') continue;
        const subject = `incident:${incident.id}`;
        const current = this.latest(subject);
        const firstSeen = Date.parse(incident.firstSeen) || now;
        if (incident.status === 'resolved') {
          // Only a failure the ledger told about gets its "fixed" line.
          if (!current || current.kind !== 'failed') continue;
          this.record({ spaceId: SYSTEM_SPACE, itemId: current.itemId, kind: 'fyi', title: `${incident.title}: resolved`, source: 'auto:incident', subject, at: incident.resolvedAt ? Date.parse(incident.resolvedAt) || now : now });
          continue;
        }
        // Held on the System page (acked, snoozed, muted): the owner dealt with it, so its line is handled.
        if (HELD_INCIDENT.has(incident.status)) {
          if (current?.kind === 'failed' && (current.seenAt === null || current.backAt !== null)) this.seen([current.id], 'acted', incident.status);
          continue;
        }
        if (!current && firstSeen < this.horizon()) continue;
        // Open again after it was held: news again, as a new line.
        const renew = current?.kind === 'failed' && current.outcome !== null && HELD_INCIDENT.has(current.outcome);
        this.record({
          renew,
          spaceId: SYSTEM_SPACE,
          itemId: incident.severity === 'critical' ? `${SYSTEM_ITEM_PREFIX}${incident.id}` : null,
          kind: 'failed',
          title: incident.title,
          source: 'auto:incident',
          subject,
          at: current?.kind === 'fyi' || renew ? Date.parse(incident.lastSeen) || now : firstSeen,
        });
      }
    } catch (err) {
      this.log('desk.updates.error', { stage: 'incidents', message: (err as Error).message });
    }
  }

  /**
   * The ledger, filled from what the desk already recorded (the test desk's frozen mirror runs no sources): Done
   * events since `since`, the open briefs, and merged PRs when gh is there.
   */
  async backfill(since: number, events: Array<Pick<DeskEvent, 'type' | 'itemId' | 'at' | 'actor' | 'payload' | 'seq'>>): Promise<void> {
    for (const event of [...events].sort((a, b) => a.seq - b.seq)) if (event.at >= since && (event.type === 'done' || event.type === 'source.done' || event.type === 'chapter.settled')) this.onDeskEvent(event);
    await this.sync();
    // Every linked PR read, not just one pass's worth.
    for (let pass = 0; pass < 20 && (await this.syncPullRequests()) >= PR_CALLS_PER_PASS; pass += 1);
  }
}
