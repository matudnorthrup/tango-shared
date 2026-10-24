// The learning loop (docs/specs/decisions-and-delegation.md, phase 3): standing rules the owner's rulings create,
// the class levels their reversals lower, and the review that lists both. Loom keeps them in its store; the profile's
// rules file (<profile>/decisions/rules.md) is a mirror Loom writes on every change, for agents that aren't on Loom.
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { LoomStore } from "./store.js";
import { containsPhrase, negations, profileDir, sameNegation, sameScope, scopeCovers, scopeWords, type Board, type DecisionBrief, type DecisionRow } from "./decisions.js";

export { sameScope };

export type RuleState = "active" | "suspended" | "retired" | "superseded";
export interface RuleRow {
  id: string; class: string; scope: string; action: string; level: number; guard: string | null;
  /** The owner's reason, which is what agents generalize from. */
  reason: string | null;
  /** JSON: the decision ids that justified it. */
  source: string;
  /** Where it came from, in words (an imported rule's "From" line). */
  origin: string | null;
  state: RuleState; state_why: string | null; superseded_by: string | null;
  created_at: number; changed_at: number; review_at: number | null; last_used_at: number | null;
}
export interface ClassLevelRow { class: string; level: number; board_level: number; changed_at: number; why: string | null; consumed: string }
export type RuleEventKind = "rule-created" | "rule-suspended" | "rule-retired" | "rule-withdrawn" | "rule-superseded" | "rule-restored" | "rule-reaffirmed" | "rule-proposed" | "class-demoted" | "class-restored";
export interface RuleEventRow {
  id: number; at: number; kind: RuleEventKind; rule_id: string | null; class: string; decision_id: string | null;
  from_level: number | null; to_level: number | null; text: string;
}

export const RULES_SCHEMA = `
CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY, class TEXT NOT NULL, scope TEXT NOT NULL, action TEXT NOT NULL, level INTEGER NOT NULL, guard TEXT,
  reason TEXT, source TEXT NOT NULL DEFAULT '[]', origin TEXT,
  state TEXT NOT NULL, state_why TEXT, superseded_by TEXT,
  created_at INTEGER NOT NULL, changed_at INTEGER NOT NULL, review_at INTEGER, last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS rules_class ON rules(class, state);
-- Learned overrides of the board: a class its reversals dropped, and the board level it goes back to.
-- consumed: the reversals (decision ids) the last change already counted, so a tie on its millisecond isn't lost.
CREATE TABLE IF NOT EXISTS class_levels (class TEXT PRIMARY KEY, level INTEGER NOT NULL, board_level INTEGER NOT NULL, changed_at INTEGER NOT NULL, why TEXT, consumed TEXT NOT NULL DEFAULT '[]');
-- "Just this once": the class is not a promotion candidate for this scope.
CREATE TABLE IF NOT EXISTS rule_declines (class TEXT NOT NULL, scope TEXT NOT NULL, decision_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (class, scope));
-- What changed, for the owner's FYI in Decided for you and the weekly Delegation review.
CREATE TABLE IF NOT EXISTS rule_events (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, rule_id TEXT, class TEXT NOT NULL, decision_id TEXT,
  from_level INTEGER, to_level INTEGER, text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rule_events_at ON rule_events(at);
-- Words rule.update replaced: an older copy of the rules file still carrying them is the same rule, not a new one.
CREATE TABLE IF NOT EXISTS rule_wordings (rule_id TEXT NOT NULL, class TEXT NOT NULL, scope TEXT NOT NULL, action TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS rule_wordings_rule ON rule_wordings(rule_id);
-- Marks set once: "imported" after the first import of the rules file (later imports are news to the owner).
CREATE TABLE IF NOT EXISTS rule_marks (name TEXT PRIMARY KEY, at INTEGER NOT NULL);
`;

const DAY = 86_400_000;
const WINDOW_MS = 30 * DAY;
const UNUSED_MS = 90 * DAY;
/** Rules that say how the system itself works, not what to do in a class: never used by a log, so they never expire. */
const POLICY = "policy";

/** The profile's rules file: Loom's mirror of its rules table (main.ts passes it to the host; tests don't). */
export function rulesFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(profileDir(env), "decisions", "rules.md");
}

/** Whether any process holds `path` open, by lsof: true, false, or null when lsof can't say (then the file is kept). */
export function heldOpen(path: string): boolean | null {
  const run = spawnSync("lsof", ["-t", "--", path], { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "pipe"] });
  if (run.status === 0 && run.stdout.trim()) return true;
  if (run.status === 1 && !run.stdout.trim() && !run.stderr.trim()) return false;
  return null;
}

/**
 * Two proposed scopes describe the same kind of call (D-61's "second similar call"): one covers the other, or they
 * share most of the words that carry their meaning (Jaccard at least one half).
 */
export function similarScope(a: string, b: string): boolean {
  const x = a.trim().replace(/\s+/g, " ").replace(/’/g, "'").toLowerCase(), y = b.trim().replace(/\s+/g, " ").replace(/’/g, "'").toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  if (!sameNegation(x, y)) return false;
  if (containsPhrase(x, y) || containsPhrase(y, x)) return true;
  // Negated scopes are similar only phrase for phrase: shared words don't say what each negates.
  if (negations(x).size) return false;
  const wa = scopeWords(x), wb = scopeWords(y);
  const both = [...wa].filter((w) => wb.has(w)).length;
  const either = new Set([...wa, ...wb]).size;
  return either > 0 && both / either >= 0.5;
}

const NEGATION = /\b(not|no|don'?t|never|none|stop|skip|hold|without|cancel|reject|decline)\b/;
/**
 * Two options taken are the same kind (D-61's "approves it the same way"): equal, or similar words with the same
 * polarity ("Do not deploy" and "Deploy" are opposites, not the same call).
 */
export function similarOption(a: string, b: string): boolean {
  const x = a.trim().replace(/\s+/g, " ").toLowerCase(), y = b.trim().replace(/\s+/g, " ").toLowerCase();
  if (!x || !y) return true;
  if (x === y) return true;
  // Curly apostrophes too ("Don’t deploy"), and every negator scopes know ("can't", "without", "non-x").
  const negated = (s: string) => NEGATION.test(s.replace(/’/g, "'")) || negations(s).size > 0;
  if (negated(x) !== negated(y)) return false;
  // One's words all in the other's ("Deploy" and "Deploy now"); different words ("Enable X" / "Disable X") aren't.
  const wx = scopeWords(x), wy = scopeWords(y);
  const within = (a: Set<string>, b: Set<string>) => a.size > 0 && [...a].every((w) => b.has(w));
  return within(wx, wy) || within(wy, wx);
}

/**
 * The rule two similar approvals add up to, written plainly: the shorter (more general) scope when one covers the
 * other, else the later one; what to do from the later brief. A model can write it better (host ruleWriter).
 */
export function generalizeRule(earlier: string, later: string): { scope: string; action: string; text: string } {
  const a = parseProposedRule(earlier), b = parseProposedRule(later);
  const la = a.scope.trim().replace(/\s+/g, " ").toLowerCase(), lb = b.scope.trim().replace(/\s+/g, " ").toLowerCase();
  // Whole words: "app release policy" is not inside "dapp release policy".
  const scope = containsPhrase(lb, la) ? a.scope : b.scope;
  const action = b.action || a.action;
  return { scope, action, text: `Next time, for ${scope}, ${action} without asking` };
}

/** One line, so no stored text can start a section (a "## R-" heading) or a field of its own in the mirror. */
export const oneLine = (text: string) => text.replace(/\s*[\r\n]+\s*/g, " ").trim();

/** "Next time, for <scope>, do <X> without asking" → its scope and what to do; anything else is all scope. */
export function parseProposedRule(raw: string): { scope: string; action: string } {
  // On one line first: every caller (the conflict checks and promotion) reads the same scope.
  const text = oneLine(raw);
  // The canonical delimiter is ", do": a scope may hold commas of its own. Without it, the first comma splits.
  const m = /^\s*next time,?\s+for\s+(.+?),\s+(do\s+.+?)(?:,?\s+without asking)?[.\s]*$/i.exec(text)
    ?? /^\s*next time,?\s+for\s+(.+?),\s+(.+?)(?:,?\s+without asking)?[.\s]*$/i.exec(text);
  if (!m) return { scope: text.trim(), action: text.trim() };
  return { scope: m[1]!.trim(), action: m[2]!.trim().replace(/^do\s+/i, "") };
}

interface ParsedRule { id: string; class: string; state: RuleState; scope: string; action: string; level: number; guard: string | null; reason: string | null; origin: string | null; /** The section carries a state line Loom wrote ("… by Loom)"): its state is Loom's own, not an edit. */ byLoom: boolean }

/** The rules file's "## R-n · class · state" sections, with their Scope / Do / Level / Why / From lines. */
export function parseRulesFile(text: string): ParsedRule[] {
  const out: ParsedRule[] = [];
  for (const section of text.split(/^(?=## R-)/m)) {
    const head = /^## (R-\d+) · ([^·\n]+?) · (\w+)/.exec(section);
    if (!head) continue;
    const field = (name: string) => new RegExp(`^- ${name}:\\s*(.+)$`, "mi").exec(section)?.[1]?.trim() ?? null;
    const state = (["active", "suspended", "retired", "superseded"] as const).find((s) => s === head[3]) ?? "active";
    const scope = field("Scope") ?? "";
    out.push({
      id: head[1]!, class: head[2]!.trim(), state, scope, action: field("Do") ?? scope,
      level: Number(field("Level")) || 4, guard: field("Guard"), reason: field("Why"), origin: field("From"),
      byLoom: /^- (Suspended|Retired|Superseded): .*by Loom\)\s*$/m.test(section),
    });
  }
  return out;
}

const MIRROR_NOTE = "<!-- Loom keeps this file: it mirrors Loom's rules table and is rewritten on every change. Off Loom, read it; a new rule appended with the next free id is picked up the next time Loom writes it. -->";
const PREAMBLE = `# Standing decision rules

Standing rules for the delegation board (docs/specs/decisions-and-delegation.md in the tango repo). Read this before
asking the owner anything. The scope is matched literally, so a near miss still asks. A reversal suspends a rule.
`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Rules, class levels and their events. Every write happens inside the caller's store transaction; the mirror file
 * is written after it commits (a rolled-back change leaves the file as the table is).
 */
export class Rules {
  private mirrorQueued = false;

  constructor(private readonly store: LoomStore, private readonly options: { file?: string | null; board: () => Board; /** Tests: runs between writing the new mirror and replacing the file. */ beforeReplace?: () => void; /** Tests: runs after the file is moved aside. */ afterMove?: () => void; /** Whether a process holds a path open: true, false, or null when it can't tell (default: lsof). */ heldOpen?: (path: string) => boolean | null }) {}

  private get db() { return this.store.db; }

  // ── reading ─────────────────────────────────────────────────────────

  rule(id: string): RuleRow | undefined {
    return this.db.prepare("SELECT * FROM rules WHERE id = ?").get(id) as RuleRow | undefined;
  }
  all(): RuleRow[] {
    return this.db.prepare("SELECT * FROM rules ORDER BY CAST(SUBSTR(id, 3) AS INTEGER)").all() as unknown as RuleRow[];
  }
  /** Active rules for a class, and the policy rules every class reads. */
  active(cls: string): RuleRow[] {
    return this.db.prepare("SELECT * FROM rules WHERE state = 'active' AND class IN (?, ?) ORDER BY CAST(SUBSTR(id, 3) AS INTEGER)").all(cls, POLICY) as unknown as RuleRow[];
  }
  /**
   * An active rule a new one for `scope` would conflict with: another scope that takes it in or that it takes in, saying
   * otherwise. (A rule for the same scope isn't one: the new rule supersedes it, the owner's latest word.) Reads the file first.
   */
  rival(cls: string, scope: string, action: string): RuleRow | undefined {
    this.importFile();
    const act = action.trim().toLowerCase();
    return this.active(cls).find((r) => r.class === cls && !sameScope(r.scope, scope) && (scopeCovers(r.scope, scope) || scopeCovers(scope, r.scope)) && r.action.trim().toLowerCase() !== act);
  }

  /** Two or more active rules for the same class and scope: a precedent-conflict tripwire. */
  conflicts(cls: string): RuleRow[][] {
    const groups: RuleRow[][] = [];
    for (const rule of this.active(cls).filter((r) => r.class === cls)) {
      const group = groups.find((g) => sameScope(g[0]!.scope, rule.scope));
      if (group) group.push(rule);
      else groups.push([rule]);
    }
    return groups.filter((g) => g.length > 1);
  }
  declined(cls: string, scope: string): boolean {
    return (this.db.prepare("SELECT scope FROM rule_declines WHERE class = ?").all(cls) as { scope: string }[]).some((r) => sameScope(r.scope, scope));
  }
  classLevels(): ClassLevelRow[] {
    return this.db.prepare("SELECT * FROM class_levels ORDER BY class").all() as unknown as ClassLevelRow[];
  }
  classLevel(cls: string): ClassLevelRow | undefined {
    return this.db.prepare("SELECT * FROM class_levels WHERE class = ?").get(cls) as ClassLevelRow | undefined;
  }

  /** The board with what reversals taught laid over it: a demoted class sits at its lower level. */
  effectiveBoard(board: Board): Board {
    const rows = this.db.prepare("SELECT * FROM class_levels").all() as unknown as ClassLevelRow[];
    if (!rows.length) return board;
    const classes = { ...board.classes };
    for (const row of rows) {
      const entry = classes[row.class];
      if (entry && row.level < entry.level) classes[row.class] = { ...entry, level: row.level };
    }
    return { ...board, classes };
  }

  events(since: number, until = Number.MAX_SAFE_INTEGER): RuleEventRow[] {
    return this.db.prepare("SELECT * FROM rule_events WHERE at BETWEEN ? AND ? ORDER BY at DESC, id DESC").all(since, until) as unknown as RuleEventRow[];
  }

  /** Reversals in a class that count against it now: the last 30 days, and only since its level last changed. */
  reversals(cls: string, now = this.store.now()): number {
    return this.reversalIds(cls, now).length;
  }

  /** The reversals that count: in the last 30 days, from the class's last change on, and not already counted by it. */
  private reversalIds(cls: string, now = this.store.now()): string[] {
    const level = this.classLevel(cls);
    const since = Math.max(now - WINDOW_MS, level?.changed_at ?? 0);
    const consumed = new Set(level ? (JSON.parse(level.consumed) as string[]) : []);
    return (this.db.prepare("SELECT id FROM decisions WHERE class = ? AND reversed_at >= ? ORDER BY reversed_at, id").all(cls, since) as { id: string }[]).map((r) => r.id).filter((id) => !consumed.has(id));
  }

  // ── writing ─────────────────────────────────────────────────────────

  private event(kind: RuleEventKind, cls: string, text: string, extra: { rule_id?: string | null; decision_id?: string | null; from_level?: number | null; to_level?: number | null } = {}): void {
    this.db.prepare("INSERT INTO rule_events (at, kind, rule_id, class, decision_id, from_level, to_level, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(this.store.now(), kind, extra.rule_id ?? null, cls, extra.decision_id ?? null, extra.from_level ?? null, extra.to_level ?? null, text);
  }

  private nextId(): string {
    const ids = this.all().map((r) => Number(r.id.slice(2)));
    const inFile = this.readFile().map((r) => Number(r.id.slice(2)));
    return `R-${Math.max(0, ...ids, ...inFile) + 1}`;
  }

  private reviewAt(from: number): number {
    const m = /^(\d+)\s*d\b/.exec(String(this.options.board().defaults.rule_review ?? ""));
    return from + (m ? Number(m[1]) * DAY : UNUSED_MS);
  }

  /** A new rule at level 4 for the scope the brief proposed (D-2), with the owner's reason. */
  create(input: { class: string; proposedRule: string; reason: string | null; decisionId: string; guard?: string | null }): RuleRow {
    const now = this.store.now();
    // A rule appended to the file off Loom since the brief opened counts too: take it in before looking.
    this.importFile();
    const { scope, action } = parseProposedRule(oneLine(input.proposedRule));
    input = { ...input, reason: input.reason ? oneLine(input.reason) : null };
    // Two briefs on one scope, answered in turn: the same ruling reuses the rule it already made, and a different one
    // (the owner's latest word) supersedes it, so a scope never holds two active rules by promotion.
    const same = this.active(input.class).filter((r) => r.class === input.class && sameScope(r.scope, scope));
    const twin = same.find((r) => sameScope(r.action, action));
    if (twin) {
      const source = JSON.parse(twin.source) as string[];
      if (!source.includes(input.decisionId)) {
        this.db.prepare("UPDATE rules SET source = ? WHERE id = ?").run(JSON.stringify([...source, input.decisionId]), twin.id);
        // Its own line in Decided for you, with the chips: each approval backing a rule can be changed from the desk.
        this.event("rule-reaffirmed", input.class, `${twin.id}: for ${twin.scope}, ${twin.action} (approved again)`, { rule_id: twin.id, decision_id: input.decisionId });
      }
      // The latest approval's reason is what agents learn from; its Always clears an earlier "just this once".
      if (input.reason) this.db.prepare("UPDATE rules SET reason = ? WHERE id = ?").run(input.reason, twin.id);
      // A fresh approval is use: its 90 unused days start again.
      this.db.prepare("UPDATE rules SET last_used_at = ? WHERE id = ?").run(this.store.now(), twin.id);
      this.undecline(input.class, input.proposedRule);
      // Any other rule on the scope (one that disagrees, arrived from the file) gives way to the owner's latest word.
      this.supersedeBy(same.filter((r) => r.id !== twin.id), twin.id, input.decisionId);
      this.changed();
      return this.rule(twin.id)!;
    }
    const id = this.nextId();
    this.db.prepare("INSERT INTO rules (id, class, scope, action, level, guard, reason, source, origin, state, created_at, changed_at, review_at) VALUES (?, ?, ?, ?, 4, ?, ?, ?, NULL, 'active', ?, ?, ?)")
      .run(id, input.class, scope, action, input.guard ?? null, input.reason, JSON.stringify([input.decisionId]), now, now, this.reviewAt(now));
    // A rule the owner asked for clears an earlier "just this once" for the same scope.
    this.undecline(input.class, input.proposedRule);
    this.event("rule-created", input.class, `${id}: for ${scope}, ${action}`, { rule_id: id, decision_id: input.decisionId, to_level: 4 });
    this.supersedeBy(same, id, input.decisionId);
    this.changed();
    return this.rule(id)!;
  }

  private supersedeBy(older: RuleRow[], by: string, decisionId: string): void {
    for (const rule of older) {
      this.setState(rule, "superseded", `the owner's later ruling on ${decisionId}`);
      this.db.prepare("UPDATE rules SET superseded_by = ? WHERE id = ?").run(by, rule.id);
      this.event("rule-superseded", rule.class, `${rule.id} superseded by ${by}: the owner's later ruling on ${decisionId}`, { rule_id: rule.id, decision_id: decisionId });
    }
  }

  /** Two similar approvals proposed a rule (D-61): recorded for the weekly review. */
  proposed(cls: string, decisionId: string, earlier: string, text: string): void {
    this.event("rule-proposed", cls, `Proposed from ${earlier} and ${decisionId}: ${text}`, { decision_id: decisionId });
  }

  /** Another decision behind a rule (D-61: the earlier of the two approvals a proposed rule came from). */
  addSource(id: string, decisionId: string): void {
    const rule = this.rule(id);
    if (!rule) return;
    const source = JSON.parse(rule.source) as string[];
    if (source.includes(decisionId)) return;
    this.db.prepare("UPDATE rules SET source = ? WHERE id = ?").run(JSON.stringify([decisionId, ...source]), id);
    this.changed();
  }

  /**
   * The owner's earlier approvals in a class that count as precedents (D-61): answered as recommended, no rule made,
   * newest first. With a scope, only those whose proposed scope is similar (`similarScope`).
   */
  precedents(cls: string, scope?: string, exclude: string | null = null): Array<DecisionRow & { scope: string }> {
    const rows = this.db.prepare("SELECT * FROM decisions WHERE class = ? AND precedent = 1 AND status = 'answered' ORDER BY COALESCE(resolved_at, created_at) DESC LIMIT 200").all(cls) as unknown as DecisionRow[];
    return rows
      .filter((r) => r.id !== exclude)
      .map((r) => ({ ...r, scope: parseProposedRule((JSON.parse(r.brief) as DecisionBrief).proposedRule ?? "").scope }))
      .filter((r) => r.scope && (scope === undefined || similarScope(r.scope, scope)));
  }

  /**
   * D-61: rules the owner names (made from a single first approval) go back to being precedents: retired with "D-61:
   * kept as a precedent", ids kept, and the decisions behind them count as precedents again ("Just this once"). An
   * explicit list, not a sweep: the ledger can't tell a first-approval rule from one the owner made with Always.
   */
  keepAsPrecedents(ids: string[]): string[] {
    const kept: string[] = [];
    for (const id of ids) {
      const rule = this.rule(id);
      if (!rule || rule.state !== "active") continue;
      this.setState(rule, "retired", "D-61: kept as a precedent");
      for (const d of JSON.parse(rule.source) as string[]) this.db.prepare("UPDATE decisions SET precedent = 1, rule_choice = 'once' WHERE id = ? AND status = 'answered'").run(d);
      this.event("rule-withdrawn", rule.class, `${rule.id} kept as a precedent (D-61): a rule now needs a second similar call`, { rule_id: rule.id, decision_id: (JSON.parse(rule.source) as string[])[0] ?? null });
      kept.push(rule.id);
    }
    if (kept.length) this.changed();
    return kept;
  }

  /** A rule's words, revised (rule.update): its scope, what to do, or its reason. The id and state stay. */
  update(id: string, fields: { scope?: string | null; action?: string | null; reason?: string | null }): RuleRow {
    const rule = this.rule(id);
    if (!rule) throw new Error(`No rule ${id}`);
    const next = { scope: fields.scope ? oneLine(fields.scope) : rule.scope, action: fields.action ? oneLine(fields.action) : rule.action, reason: fields.reason !== undefined && fields.reason !== null ? oneLine(fields.reason) : rule.reason };
    if (next.scope !== rule.scope || next.action !== rule.action) this.db.prepare("INSERT INTO rule_wordings (rule_id, class, scope, action, at) VALUES (?, ?, ?, ?, ?)").run(id, rule.class, rule.scope, rule.action, this.store.now());
    this.db.prepare("UPDATE rules SET scope = ?, action = ?, reason = ?, changed_at = ? WHERE id = ?").run(next.scope, next.action, next.reason, this.store.now(), id);
    this.touchSources(id);
    this.changed();
    return this.rule(id)!;
  }

  /** Whether `parsed` carries words rule.update replaced on rule `id`. */
  private formerWording(id: string, parsed: { class: string; scope: string; action: string }): boolean {
    const rows = this.db.prepare("SELECT class, scope, action FROM rule_wordings WHERE rule_id = ?").all(id) as { class: string; scope: string; action: string }[];
    return rows.some((w) => w.class === parsed.class && sameScope(w.scope, parsed.scope) && sameScope(w.action, parsed.action));
  }

  /** "Just this once": the class is not a candidate for this scope. */
  decline(cls: string, proposedRule: string, decisionId: string): void {
    const { scope } = parseProposedRule(proposedRule);
    this.db.prepare("INSERT OR REPLACE INTO rule_declines (class, scope, decision_id, created_at) VALUES (?, ?, ?, ?)").run(cls, scope, decisionId, this.store.now());
    // Briefs already open on that scope stop being candidates too: approving one makes no rule unless Always is chosen.
    const open = this.db.prepare("SELECT id, thread_id, brief FROM decisions WHERE class = ? AND status = 'open' AND candidate = 1").all(cls) as { id: string; thread_id: string; brief: string }[];
    for (const row of open) {
      const proposed = (JSON.parse(row.brief) as DecisionBrief).proposedRule;
      if (!proposed || !sameScope(parseProposedRule(proposed).scope, scope)) continue;
      this.db.prepare("UPDATE decisions SET candidate = 0 WHERE id = ?").run(row.id);
      this.store.noteThread(row.thread_id);
    }
  }

  /** "Ask me next time" after "Just this once": the scope can be a candidate again. */
  undecline(cls: string, proposedRule: string): void {
    const { scope } = parseProposedRule(proposedRule);
    for (const row of this.db.prepare("SELECT scope FROM rule_declines WHERE class = ?").all(cls) as { scope: string }[]) {
      if (sameScope(row.scope, scope)) this.db.prepare("DELETE FROM rule_declines WHERE class = ? AND scope = ?").run(cls, row.scope);
    }
  }

  /** Explicit policy retirement, preserving the rule and its audit trail. */
  retire(id: string, why: string): void {
    const rule = this.rule(id);
    if (!rule || rule.state === "retired") return;
    this.setState(rule, "retired", why);
    this.event("rule-retired", rule.class, `${id} retired: ${why}`, { rule_id: id });
    this.changed();
  }

  /** The owner took back a rule their answer made ("Ask me next time" after all). */
  withdraw(id: string, why: string, decisionId: string): void {
    const rule = this.rule(id);
    if (!rule || rule.state !== "active") return;
    // Only this decision's support goes: another approval still saying Always keeps the rule standing.
    const rest = (JSON.parse(rule.source) as string[]).filter((d) => d !== decisionId);
    this.db.prepare("UPDATE rules SET source = ? WHERE id = ?").run(JSON.stringify(rest), id);
    // An imported rule (it has an origin) stood on its own before any answer backed it: only the support goes.
    const backed = !!rule.origin || rest.some((d) => (this.db.prepare("SELECT rule_choice FROM decisions WHERE id = ?").get(d) as { rule_choice: string | null } | undefined)?.rule_choice === "always");
    if (backed) { this.changed(); return; }
    this.setState(rule, "retired", why);
    this.event("rule-withdrawn", rule.class, `${id} withdrawn: ${why}`, { rule_id: id, decision_id: decisionId });
  }

  /**
   * The owner said Always again on a decision whose rule no longer stands (taken back, suspended by a reversal,
   * superseded, retired unused): that same rule stands again, so one decision never yields two rules. Null when it
   * can't (gone, or an active rule already says the same: create reuses that one).
   */
  revive(id: string, decisionId: string): RuleRow | null {
    this.importFile();
    const rule = this.rule(id);
    if (!rule || rule.state === "active") return null;
    const others = this.active(rule.class).filter((r) => r.class === rule.class && r.id !== id && sameScope(r.scope, rule.scope));
    if (others.some((r) => sameScope(r.action, rule.action))) return null;
    const source = JSON.parse(rule.source) as string[];
    const now = this.store.now();
    this.db.prepare("UPDATE rules SET state = 'active', state_why = NULL, superseded_by = NULL, source = ?, last_used_at = ?, changed_at = ?, review_at = ? WHERE id = ?")
      .run(JSON.stringify(source.includes(decisionId) ? source : [...source, decisionId]), now, now, this.reviewAt(now), id);
    this.event("rule-restored", rule.class, `${id} restored: the owner said Always again on ${decisionId}`, { rule_id: id, decision_id: decisionId });
    this.touchSources(id);
    // As a new rule would: any other rule on the scope gives way to the owner's latest word.
    this.supersedeBy(others, id, decisionId);
    this.changed();
    return this.rule(id)!;
  }

  /**
   * The owner settled a precedent conflict: the rule they kept stands, and the others it conflicted with are superseded
   * by it. With none kept (another answer), every rule named is suspended, so the next case asks.
   */
  settleConflict(named: string[], kept: string | null, decisionId: string, caseScope: string | null = null): void {
    // A rule appended to the file off Loom since the brief opened is part of the conflict too: take it in first.
    this.importFile();
    // The owner's latest choice stands even if an earlier answer (another brief on the same conflict) set it aside.
    const chosen = kept ? this.rule(kept) : undefined;
    if (chosen && chosen.state !== "active") {
      this.setState(chosen, "active", `the owner kept it on ${decisionId}`);
      // The owner just chose it: its 90 unused days (and its review) start again from now.
      const now = this.store.now();
      this.db.prepare("UPDATE rules SET superseded_by = NULL, last_used_at = ?, review_at = ? WHERE id = ?").run(now, this.reviewAt(now), chosen.id);
      this.event("rule-restored", chosen.class, `${chosen.id} restored: the owner kept it on ${decisionId}`, { rule_id: chosen.id, decision_id: decisionId });
    }
    // Every rule active on that scope now, not only the ones the brief named: one may have come since it was opened.
    const base = named.map((id) => this.rule(id)).find((r): r is RuleRow => !!r);
    // And every rule that takes in the case itself and says otherwise than the one kept (a wider scope counts too).
    const keptAction = chosen?.action.trim().toLowerCase() ?? null;
    const current = base ? this.active(base.class).filter((r) => r.class === base.class && (sameScope(r.scope, base.scope)
      || (!!caseScope && scopeCovers(r.scope, caseScope) && r.action.trim().toLowerCase() !== keptAction))).map((r) => r.id) : [];
    for (const id of new Set([...named, ...current])) {
      const rule = this.rule(id);
      if (!rule || rule.state !== "active" || id === kept) continue;
      if (kept) {
        this.setState(rule, "superseded", `the owner kept ${kept} on ${decisionId}`);
        this.db.prepare("UPDATE rules SET superseded_by = ? WHERE id = ?").run(kept, id);
        this.event("rule-superseded", rule.class, `${id} superseded by ${kept}: the owner's ruling on ${decisionId}`, { rule_id: id, decision_id: decisionId });
      } else {
        this.setState(rule, "suspended", `the owner kept neither on ${decisionId}`);
        this.event("rule-suspended", rule.class, `${id} suspended: the owner kept neither on ${decisionId}`, { rule_id: id, decision_id: decisionId });
      }
    }
  }

  /** The owner read the review that showed these rules as due: each comes up again after another review period. */
  reviewed(ids: string[]): void {
    const now = this.store.now();
    for (const id of ids) this.db.prepare("UPDATE rules SET review_at = ? WHERE id = ? AND review_at IS NOT NULL AND review_at <= ?").run(this.reviewAt(now), id, now + 7 * DAY);
    this.changed();
  }

  /** The owner's reason for a rule, revised. */
  setReason(id: string, reason: string): void {
    this.db.prepare("UPDATE rules SET reason = ? WHERE id = ?").run(reason, id);
    this.changed();
  }

  /** An agent acted under this rule (decision_log with `rule`). */
  use(id: string): void {
    this.db.prepare("UPDATE rules SET last_used_at = ? WHERE id = ?").run(this.store.now(), id);
    this.changed();
  }

  private setState(rule: RuleRow, state: RuleState, why: string): void {
    this.db.prepare("UPDATE rules SET state = ?, state_why = ?, changed_at = ? WHERE id = ?").run(state, why, this.store.now(), rule.id);
    this.touchSources(rule.id);
    this.changed();
  }

  /** The threads whose answers made or back a rule hear that it changed: their answered brief shows its state. */
  private touchSources(id: string): void {
    const rule = this.rule(id);
    const ids = new Set(rule ? (JSON.parse(rule.source) as string[]) : []);
    const rows = this.db.prepare("SELECT id, thread_id FROM decisions WHERE rule_id = ?").all(id) as { id: string; thread_id: string }[];
    for (const d of ids) {
      const row = this.db.prepare("SELECT id, thread_id FROM decisions WHERE id = ?").get(d) as { id: string; thread_id: string } | undefined;
      if (row) rows.push(row);
    }
    for (const thread of new Set(rows.map((r) => r.thread_id))) this.store.noteThread(thread);
  }

  /**
   * The owner reversed something decided for them. A reversal of an action taken under a rule suspends the rule at
   * once; `demote_after` reversals in 30 days drop the whole class one level. Returns what changed.
   */
  reversed(decision: { id: string; class: string; rule_id: string | null }, why: string): { suspended: string | null; demoted: { from: number; to: number } | null } {
    let suspended: string | null = null;
    const rule = decision.rule_id ? this.rule(decision.rule_id) : undefined;
    if (rule?.state === "active") {
      this.setState(rule, "suspended", why);
      this.event("rule-suspended", rule.class, `${rule.id} suspended: ${why}`, { rule_id: rule.id, decision_id: decision.id });
      suspended = rule.id;
    }
    return { suspended, demoted: this.maybeDemote(decision.class, decision.id) };
  }

  private maybeDemote(cls: string, decisionId: string): { from: number; to: number } | null {
    const board = this.options.board();
    const boardLevel = board.classes[cls]?.level;
    if (boardLevel === undefined) return null;
    const after = Number(board.defaults.demote_after) || 2;
    const counted = this.reversalIds(cls);
    const count = counted.length;
    if (count < after) return null;
    const prior = this.classLevel(cls);
    const current = prior?.level ?? boardLevel;
    if (current <= 1) return null;
    const to = current - 1;
    const why = `${count} reversals in 30 days`;
    // The reversals this demotion used (with any an earlier change in the same millisecond used): later ones count.
    const consumed = JSON.stringify([...new Set([...(prior ? (JSON.parse(prior.consumed) as string[]) : []), ...counted])]);
    this.db.prepare("INSERT INTO class_levels (class, level, board_level, changed_at, why, consumed) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(class) DO UPDATE SET level = excluded.level, board_level = excluded.board_level, changed_at = excluded.changed_at, why = excluded.why, consumed = excluded.consumed")
      .run(cls, to, boardLevel, this.store.now(), why, consumed);
    this.event("class-demoted", cls, `${cls} dropped from level ${current} to ${to}: ${why}`, { decision_id: decisionId, from_level: current, to_level: to });
    // Briefs already open in the class drop with it: a level 3 brief now at 2 or 1 waits on the owner, with no default.
    const open = this.db.prepare("SELECT id, thread_id FROM decisions WHERE class = ? AND status = 'open' AND level > ?").all(cls, to) as { id: string; thread_id: string }[];
    for (const row of open) {
      // At level 1 a brief is the owner's call and no longer a promotion candidate: only an explicit Always makes a rule.
      this.db.prepare("UPDATE decisions SET level = ?, candidate = CASE WHEN ? < 2 THEN 0 ELSE candidate END WHERE id = ?").run(to, to, row.id);
      this.store.noteThread(row.thread_id);
    }
    return { from: current, to };
  }

  /**
   * The daily housekeeping: a demoted class with a clean 30 days goes back up a level, and a rule unused for 90 days
   * retires. Returns what it changed.
   */
  tick(now = this.store.now()): { restored: string[]; retired: string[] } {
    this.importFile();
    this.sweepMoved();
    const restored: string[] = [];
    const board = this.options.board();
    for (const row of this.db.prepare("SELECT * FROM class_levels").all() as unknown as ClassLevelRow[]) {
      const boardLevel = board.classes[row.class]?.level ?? row.board_level;
      if (row.changed_at > now - WINDOW_MS || this.reversals(row.class, now) > 0) continue;
      const to = Math.min(row.level + 1, boardLevel);
      if (to >= boardLevel) this.db.prepare("DELETE FROM class_levels WHERE class = ?").run(row.class);
      else this.db.prepare("UPDATE class_levels SET level = ?, changed_at = ?, why = ?, consumed = '[]' WHERE class = ?").run(to, now, "a clean 30 days", row.class);
      this.event("class-restored", row.class, `${row.class} back up to level ${to} after a clean 30 days`, { from_level: row.level, to_level: to });
      restored.push(row.class);
    }
    const retired: string[] = [];
    const stale = this.db.prepare("SELECT * FROM rules WHERE state = 'active' AND class != ? AND COALESCE(last_used_at, created_at) < ?").all(POLICY, now - UNUSED_MS) as unknown as RuleRow[];
    for (const rule of stale) {
      this.setState(rule, "retired", "unused for 90 days");
      this.event("rule-retired", rule.class, `${rule.id} retired: unused for 90 days`, { rule_id: rule.id });
      retired.push(rule.id);
    }
    return { restored, retired };
  }

  // ── the review ──────────────────────────────────────────────────────

  /** The weekly Delegation review: what the learning loop did since `since`, rules due for review, and recurring dissent. */
  review(since: number, now = this.store.now()) {
    // Up to the millisecond before now: an event landing in this same millisecond, after the read, has a time past
    // `until`, so a reader resuming from `until + 1` still gets it.
    const until = now - 1;
    const events = this.events(since, until).reverse();
    const pick = (...kinds: RuleEventKind[]) => events.filter((e) => kinds.includes(e.kind)).map((e) => ({ at: e.at, kind: e.kind, rule: e.rule_id, class: e.class, decision: e.decision_id, from_level: e.from_level, to_level: e.to_level, text: e.text }));
    const due = (this.db.prepare("SELECT * FROM rules WHERE state = 'active' AND class != ? AND review_at IS NOT NULL AND review_at <= ? ORDER BY review_at").all(POLICY, now + 7 * DAY) as unknown as RuleRow[]).map(publicRule);
    const dissent = this.db.prepare("SELECT id, class, rule_id, dissent, created_at FROM decisions WHERE dissent IS NOT NULL AND created_at BETWEEN ? AND ? ORDER BY created_at").all(since, until) as { id: string; class: string; rule_id: string | null; dissent: string; created_at: number }[];
    const byKey = new Map<string, { class: string; rule: string | null; count: number; notes: { decision: string; text: string; at: number }[] }>();
    for (const d of dissent) {
      const key = d.rule_id ?? d.class;
      const entry = byKey.get(key) ?? { class: d.class, rule: d.rule_id, count: 0, notes: [] };
      entry.count++;
      entry.notes.push({ decision: d.id, text: d.dissent, at: d.created_at });
      byKey.set(key, entry);
    }
    return {
      since, until,
      created: pick("rule-created", "rule-restored"),
      suspended: pick("rule-suspended", "rule-withdrawn", "rule-retired", "rule-superseded"),
      demoted: pick("class-demoted", "class-restored"),
      due,
      // Dissent that recurs: the same rule (or class) disagreed with more than once in the window.
      dissent: [...byKey.values()].filter((d) => d.count > 1),
      demotedNow: this.classLevels(),
    };
  }

  // ── the mirror ──────────────────────────────────────────────────────

  private readFile(text?: string | null): ParsedRule[] {
    if (text != null) return parseRulesFile(text);
    const file = this.options.file;
    if (!file || !existsSync(file)) return [];
    try { return parseRulesFile(readFileSync(file, "utf8")); } catch { return []; }
  }

  /**
   * Picks up the rules file: a rule Loom doesn't have yet comes in with its id (the one-off import of the rules
   * written before Loom kept them, and any an agent off Loom appended since); a rule the file marks suspended is
   * suspended here too. Loom never changes a rule back to active from the file. Returns the ids it took in.
   */
  /** `text`: rules-file content read elsewhere (the file moved aside while the mirror is replaced); else the file. */
  importFile(text?: string | null): string[] {
    const now = this.store.now();
    const taken: string[] = [];
    // The first import brings in the rules written before Loom kept them: nothing new to announce. A rule appended
    // later is new to the owner, so it gets a rule-created line like any other.
    const first = !this.db.prepare("SELECT 1 FROM rule_marks WHERE name = 'imported'").get();
    for (const parsed of this.readFile(text)) {
      let have = this.rule(parsed.id);
      // An agent off Loom took the same next free id as a rule Loom made meanwhile: different class, scope or action
      // mean a different rule, and it comes in under a fresh id (once). Words rule.update replaced are the same rule
      // (a copy of the file written before the update still has them): only their state, below, is read.
      if (have && (have.class !== parsed.class || !sameScope(have.scope, parsed.scope) || !sameScope(have.action, parsed.action)) && !this.formerWording(have.id, parsed)) {
        if (this.all().some((r) => r.class === parsed.class && sameScope(r.scope, parsed.scope) && sameScope(r.action, parsed.action))) continue;
        parsed.id = this.nextId();
        have = undefined;
      }
      if (!have) {
        this.db.prepare("INSERT INTO rules (id, class, scope, action, level, guard, reason, source, origin, state, state_why, created_at, changed_at, review_at) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)")
          .run(parsed.id, parsed.class, parsed.scope, parsed.action, parsed.level, parsed.guard, parsed.reason, parsed.origin ?? "the rules file", parsed.state, parsed.state === "active" ? null : "marked in the rules file", now, now, parsed.class === POLICY ? null : this.reviewAt(now));
        taken.push(parsed.id);
        if (!first && parsed.state === "active") this.event("rule-created", parsed.class, `${parsed.id}: for ${parsed.scope}, ${parsed.action} (added to the rules file)`, { rule_id: parsed.id, to_level: parsed.level });
      } else if (have.state === "active" && parsed.state === "suspended" && !parsed.byLoom) {
        // An edit off Loom (the heading of an active rule marked suspended). A section Loom wrote as suspended is its
        // own earlier state, perhaps since restored: never applied over the table.
        this.setState(have, "suspended", "marked suspended in the rules file");
        this.event("rule-suspended", have.class, `${have.id} suspended in the rules file`, { rule_id: have.id });
      }
    }
    if (first) this.db.prepare("INSERT OR IGNORE INTO rule_marks (name, at) VALUES ('imported', ?)").run(now);
    if (taken.length) this.changed();
    return taken;
  }

  /** Asks for the mirror to be written once the current transaction is done. */
  changed(): void {
    if (!this.options.file || this.mirrorQueued) return;
    this.mirrorQueued = true;
    queueMicrotask(() => {
      this.mirrorQueued = false;
      try { this.writeMirror(); } catch (e) { console.warn("Writing the rules mirror failed", e); }
    });
  }

  /** The rules file, as the table has it: the file's own preamble kept, then every rule. */
  /**
   * Copies of the rules file moved aside by earlier rewrites: each is read (anything appended to it since comes in),
   * and deleted only once it has gone a minute without changing, so a writer that held it open has finished.
   */
  sweepMoved(now = Date.now()): number {
    const file = this.options.file;
    if (!file) return 0;
    const dir = dirname(file), prefix = `${basename(file)}.prev-`;
    let names: string[];
    try { names = readdirSync(dir).filter((n) => n.startsWith(prefix)); } catch { return 0; }
    let taken = 0;
    for (const name of names) {
      const path = join(dir, name);
      try {
        const before = statSync(path).mtimeMs;
        taken += this.store.tx(() => this.importFile(readFileSync(path, "utf8"))).length;
        // Deleted only once quiet for a minute and no process holds it open (asked of the OS: a writer paused with a
        // handle from before the move doesn't touch the mtime). Writers open rules.md, never this path, so once no
        // one holds it nobody can; the last read after that check takes in anything written before they closed it.
        if (now - before < 60_000 || statSync(path).mtimeMs !== before) continue;
        const held = (this.options.heldOpen ?? heldOpen)(path);
        if (held === true) continue;
        // lsof couldn't say (it can hang under some sandboxes): keep it a day, then let it go with a warning.
        if (held === null) {
          if (now - before < DAY) continue;
          console.warn(`Removing ${name}: unchanged for a day; lsof couldn't confirm no writer holds it`);
        }
        taken += this.store.tx(() => this.importFile(readFileSync(path, "utf8"))).length;
        rmSync(path, { force: true });
      } catch (e) { console.warn("Reading a moved rules file failed", e); }
    }
    if (taken) this.changed();
    return taken;
  }

  /** The file's own preamble, kept from the last read that had one (a file an append recreated has none). */
  private preamble: string | null = null;

  writeMirror(): void {
    const file = this.options.file;
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    const read = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return null; } };
    const take = (text: string | null) => {
      if (text === null) return 0;
      const cut = text.search(/^## R-\d/m); // a rule heading; "## R-<n>" in a format template is preamble
      const head = (cut < 0 ? text : text.slice(0, cut)).replace(/\n*-{3,}\s*$/, "").trimEnd();
      if (head.replace(MIRROR_NOTE, "").trim()) this.preamble = head + "\n";
      return this.store.tx(() => this.importFile(text)).length;
    };
    const build = () => {
      let preamble = this.preamble ?? PREAMBLE;
      if (!preamble.includes(MIRROR_NOTE)) preamble = `${MIRROR_NOTE}\n${preamble}`;
      writeFileSync(tmp, `${preamble}\n---\n\n${this.all().map(mirrorSection).join("\n\n")}\n`);
    };
    // Agents off Loom append to this file. It is never overwritten in place: the current file is moved aside and what
    // was moved is imported, and the new mirror is published only where no file has appeared since (link fails if an
    // append recreated it; that file is then taken in and the swap tried again). Every appended byte lands in a file
    // Loom reads before it is gone, so a rule is never lost; at worst the rewrite waits for the next change.
    try {
      this.sweepMoved();
      for (let attempt = 0; attempt < 5; attempt++) {
        take(read(file));
        build();
        this.options.beforeReplace?.();
        // A fresh name on every attempt, kept until a later sweep: a writer that opened the file before the move may
        // still append to it, so no copy is ever replaced by another.
        const aside = `${file}.prev-${process.pid}-${Date.now()}-${randomUUID()}`;
        try { renameSync(file, aside); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        this.options.afterMove?.();
        const moved = read(aside);
        if (take(moved)) build();
        try {
          linkSync(tmp, file);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
          // An append recreated the file after the move: take both in and try again (the moved copy stays for the sweep).
          take(read(aside));
          continue;
        }
        // An append through a handle opened before the move landed in the moved copy: take it in, and write again.
        if (take(read(aside))) this.changed();
        return;
      }
      console.warn("The rules file kept changing while Loom rewrote it; the next change writes it again");
    } finally {
      rmSync(tmp, { force: true });
    }
  }
}


function mirrorSection(r: RuleRow): string {
  const lines = [`## ${r.id} · ${oneLine(r.class)} · ${r.state}`, `- Scope: ${oneLine(r.scope)}`, `- Do: ${oneLine(r.action)}`];
  if (r.class !== POLICY) lines.push(`- Level: ${r.level}`);
  if (r.guard) lines.push(`- Guard: ${oneLine(r.guard)}`);
  if (r.reason) lines.push(`- Why: ${oneLine(r.reason)}`);
  const source = (JSON.parse(r.source) as string[]).join(", ");
  lines.push(`- From: ${oneLine(r.origin ?? `${source ? `${source}, ` : ""}${day(r.created_at)}`)}`);
  if (r.state !== "active") lines.push(`- ${r.state[0]!.toUpperCase()}${r.state.slice(1)}: ${oneLine(r.state_why ?? "")} (${day(r.changed_at)}, by Loom)`);
  if (r.last_used_at) lines.push(`- Last used: ${day(r.last_used_at)}`);
  return lines.join("\n");
}

/** A rule as agents and the desk read it. */
export function publicRule(r: RuleRow) {
  return { id: r.id, class: r.class, scope: r.scope, do: r.action, level: r.level, guard: r.guard, reason: r.reason, state: r.state, why: r.state_why, source: JSON.parse(r.source) as string[], created_at: r.created_at, last_used_at: r.last_used_at, review_at: r.review_at };
}

/** Whether an answer can make the brief's rule: taken as it stands, with a rule to make and no tripwire. */
export function canPromote(brief: DecisionBrief, asItStands: boolean): boolean {
  return asItStands && !brief.tripwire && typeof brief.proposedRule === "string" && brief.proposedRule.trim().length > 0;
}

/**
 * The answer took the brief as it stands: its recommended option, or, on a brief that recommends none (level 1), an
 * option the owner picked; either way without words of their own that change it (`changed`).
 */
export function asItStands(brief: DecisionBrief, option: string | null, changed: boolean): boolean {
  if (option === null || changed) return false;
  const recommended = brief.options.find((o) => o.recommended)?.key;
  return recommended === undefined || recommended === option;
}
