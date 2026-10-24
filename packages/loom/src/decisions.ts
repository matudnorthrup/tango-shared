// Decision briefs (docs/specs/decisions-and-delegation.md): the delegation board, the brief lint, and the
// ledger rows Loom keeps for every decision a thread brings to its owner. Loom is the ledger's one writer;
// other runtimes reach it through Loom's commands.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

export type Door = "one-way" | "two-way";
export type Blast = "private" | "team" | "public";
export type RuleChoice = "always" | "next-time" | "once";
export interface BriefOption {
  key: string; label: string; consequence: string; recommended?: boolean; action?: string;
  /** A precedent-conflict brief: the standing rule this option keeps (the others it conflicts with are superseded). */
  rule?: string;
}
export interface BriefAsset { kind: string; title: string; url: string }
export interface DecisionBrief {
  about?: string;
  class: string;
  ask: string;
  door: Door;
  blast: Blast;
  standing: string;
  background: string;
  options: BriefOption[];
  assets?: BriefAsset[];
  deadline?: string;
  /** Level 3: the option that runs when the veto window passes (defaults to the recommended one). */
  default?: string;
  confidence?: "low" | "medium" | "high";
  changeMyMind?: string;
  precedents?: string[];
  proposedRule?: string;
  blocks?: string[];
  /** A board tripwire that applies: the decision is the owner's call whatever the class says. */
  tripwire?: string;
}
export interface BoardClass { level: number; note?: string; guard?: string; mode?: string; threshold?: string }
export interface Board { version: number; classes: Record<string, BoardClass>; tripwires: string[]; defaults: Record<string, unknown> }

export interface DecisionRow {
  discussing_since?: number | null; discussing_run?: string | null; kept_at?: number | null; discussed?: number; unaddressed_at?: number | null;
  veto_errors?: number; veto_last_error?: string | null;
  id: string; thread_id: string; run_id: string | null; class: string; level: number; candidate: number;
  status: "open" | "answered" | "withdrawn" | "moot" | "superseded" | "defaulted" | "acted"; ask: string; brief: string;
  decided_by: string | null; answer_option: string | null; answer_text: string | null; answer_reason: string | null;
  followed_recommendation: number | null; rule_choice: string | null; supersedes: string | null;
  created_at: number; resolved_at: number | null;
  /** Level 4 (decision.log): how to undo it, and a link to what was done. */
  undo: string | null; ref: string | null;
  /** The owner's reversal (decision.reverse): "undo" (do it over) or "disagree" ("I wouldn't have"), the input for demotion. */
  reversed_at: number | null; reversal: "undo" | "disagree" | "override" | null; reversal_note: string | null;
  /** Phase 3: the standing rule a log acted under (or an answer made), and the agent's dissent from it. */
  rule_id: string | null; dissent: string | null;
  /**
   * D-61: 1 when the owner's answer took a candidate's recommendation as it stood without making a rule: a precedent.
   * A second similar one proposes a rule (`proposal`, JSON RuleProposal); `precedent_of` names the precedent a new
   * brief matched when it was raised.
   */
  precedent: number; proposal: string | null; precedent_of: string | null;
  /** Revisions (decision.update, TGO-1079): 1 as raised; the log of changes (JSON BriefChange[]); and when the level 3 veto window last started (null: when it was raised). */
  revision: number; changes: string | null; window_from: number | null;
  /** The thread the owner answered it in, when that wasn't the one that raised it (decision.close, answered-in-chat; TGO-1110). */
  decided_in: string | null;
  /** The owner's "Fine by me" (decision.confirm, catch-up): the opposite of a reversal, for the learning loop's track record. */
  confirmed_at: number | null;
}
/** One revision of an open brief: what changed, why, and which thread changed it. */
export interface BriefChange { revision: number; at: number; by: string; by_title: string | null; fields: string[]; what: string; why: string; material: boolean; told?: string[] }

/** Added with phase 2b (level 4 logs and reversals) phase 3 (rules) and revisions (TGO-1079); a store from before gets them on open. */
export const DECISION_COLUMNS: [string, string][] = [["kept_at", "INTEGER"], ["discussing_since", "INTEGER"], ["discussing_run", "TEXT"], ["discussed", "INTEGER NOT NULL DEFAULT 0"], ["unaddressed_at", "INTEGER"], ["undo", "TEXT"], ["ref", "TEXT"], ["reversed_at", "INTEGER"], ["reversal", "TEXT"], ["reversal_note", "TEXT"], ["rule_id", "TEXT"], ["dissent", "TEXT"], ["revision", "INTEGER NOT NULL DEFAULT 1"], ["changes", "TEXT"], ["window_from", "INTEGER"], ["precedent", "INTEGER NOT NULL DEFAULT 0"], ["proposal", "TEXT"], ["precedent_of", "TEXT"], ["decided_in", "TEXT"], ["confirmed_at", "INTEGER"], ["veto_errors", "INTEGER NOT NULL DEFAULT 0"], ["veto_last_error", "TEXT"]];
/** What "Decided for you" lists: level 4 actions the agent logged, and level 3 defaults the owner let pass. */
export const DECIDED_STATUSES = ["acted", "defaulted"] as const;

export const DECISIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, run_id TEXT,
  class TEXT NOT NULL, level INTEGER NOT NULL, candidate INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, ask TEXT NOT NULL, brief TEXT NOT NULL,
  decided_by TEXT, answer_option TEXT, answer_text TEXT, answer_reason TEXT,
  followed_recommendation INTEGER, rule_choice TEXT, supersedes TEXT,
  created_at INTEGER NOT NULL, resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS decisions_thread ON decisions(thread_id, status);
CREATE TABLE IF NOT EXISTS decision_seq (id INTEGER PRIMARY KEY CHECK (id = 1), last INTEGER NOT NULL);
-- D-1 to D-3 are the owner's first rulings on this design (the spec's "Rulings"): ids start after them.
INSERT OR IGNORE INTO decision_seq (id, last) VALUES (1, 3);
`;

const ASK_MAX = 140;
const STANDING_LINES = 3;
const BACKGROUND_LINES = 6;
/** "Try it and tell me" is never a decision: the agent verifies its own change (board: verify-own-change). */
const VERIFY_ASK = /\b(try (it|this)|refresh (it|the|and)|test (it|this) (and|then)|let me know if (it|this) works|tell me if (it|this) works|can you (check|confirm|verify)|does (it|this) (work|look right))\b/i;
const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i;

function boardPaths(env: NodeJS.ProcessEnv): string[] {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return [
    env.TANGO_DECISION_BOARD,
    // A release ships the board beside dist (scripts/release.mjs); a checkout reads the repo's.
    join(here, "../board.yaml"),
    join(here, "../../../config/decisions/board.yaml"),
  ].filter((p): p is string => !!p);
}
export function profileDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.TANGO_PROFILE_DIR ?? join(env.TANGO_HOME ?? join(homedir(), ".tango"), "profiles", env.TANGO_PROFILE ?? "default");
}

/** The board: the repo's defaults, with the profile's classes (decisions/board.yaml) laid over them. */
export function loadBoard(env: NodeJS.ProcessEnv = process.env): Board {
  const path = boardPaths(env).find((p) => existsSync(p));
  if (!path) throw new Error("No delegation board found (config/decisions/board.yaml)");
  const base = yaml.load(readFileSync(path, "utf8")) as Board;
  const overlay = join(profileDir(env), "decisions", "board.yaml");
  if (existsSync(overlay)) {
    const extra = (yaml.load(readFileSync(overlay, "utf8")) ?? {}) as Partial<Board>;
    for (const [name, value] of Object.entries(extra.classes ?? {})) base.classes[name] = { ...base.classes[name], ...value };
    if (extra.defaults) base.defaults = { ...base.defaults, ...extra.defaults };
  }
  return base;
}

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "onto", "any", "all", "its", "their", "our", "your", "my", "own", "of", "to", "in", "on", "a", "an", "or", "by", "as", "at", "is", "are", "be"]);
/** The words that carry a scope's meaning: lower case, no stop words or punctuation. */
export const scopeWords = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length > 1 && !STOP.has(w)));

/**
 * A case falls inside a rule's scope (literal matching, D-2 / D-61): the same scope, or one that contains it or
 * narrows it ("changes to how X learns rules: carrying out D-61" is inside "changes to how X learns rules"): every
 * word that carries the rule's scope is in the case. A different subject is a near miss and still asks.
 */
export function scopeCovers(ruleScope: string, caseScope: string): boolean {
  if (sameScope(ruleScope, caseScope)) return true;
  // A qualifier that negates ("without owner approval", "non-production", "except", "unless") turns the case into
  // the opposite one: not covered, whatever words it shares.
  if (!sameNegation(ruleScope, caseScope)) return false;
  // One apostrophe: "don’t" and "don't" are the same word.
  const rule = ruleScope.trim().replace(/\s+/g, " ").replace(/’/g, "'").toLowerCase(), kase = caseScope.trim().replace(/\s+/g, " ").replace(/’/g, "'").toLowerCase();
  if (containsPhrase(kase, rule)) return true;
  // With a negation, which words it negates matters ("do not deploy changes" isn't in "deploy changes but do not
  // notify"): only the rule's whole phrase counts, not its words scattered through the case.
  if (negations(rule).size) return false;
  const need = scopeWords(rule), have = scopeWords(kase);
  return need.size > 0 && [...need].every((w) => have.has(w));
}

const NEGATORS = /(^|[^a-z0-9-])(not|no|never|without|except|excluding|unless|non-[a-z0-9]+|un[a-z]+ed|nor|cannot|(?:do|does|did|is|are|was|were|ca|wo|should|would|could|must|has|have|had|need|ai)n['’]?t)(?=$|[^a-z0-9-])/g;
/** The negating words a scope carries ("without", "not", "non-production"...), lower case; "don't", "can't" and the like read as "not". */
export function negations(text: string): Set<string> {
  return new Set([...text.toLowerCase().matchAll(NEGATORS)].map((m) => /n['’]?t$|^cannot$/.test(m[2]!) ? "not" : m[2]!));
}
/** Two scopes negate the same things (or nothing): otherwise one is the other's opposite. */
export function sameNegation(a: string, b: string): boolean {
  const x = negations(a), y = negations(b);
  return x.size === y.size && [...x].every((w) => y.has(w));
}

/** `phrase` appears in `text` as whole words ("ads" is not in "badges"). Both already lower case. */
export function containsPhrase(text: string, phrase: string): boolean {
  if (!phrase) return false;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A hyphen joins words: "production" isn't inside "non-production".
  return new RegExp(`(^|[^a-z0-9-])${escaped}($|[^a-z0-9-])`).test(text);
}

/** Rules match literally: the same words, whatever the case and spacing. */
export const sameScope = (a: string, b: string) => a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();

const lines = (text: string) => text.trim().split(/\n+/).filter(Boolean).length;
const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

export interface LintResult { errors: string[]; level: number; candidate: boolean; brief: DecisionBrief }

/**
 * Checks a brief before Loom records it, and works out its level (from the board, never from the agent) and
 * whether it is a promotion candidate (D-2: a two-way door, private or team, no tripwire, level 2 or 3).
 */
export function lintBrief(input: unknown, board: Board): LintResult {
  const errors: string[] = [];
  const b = (input && typeof input === "object" ? input : {}) as DecisionBrief;
  if (!str(b.about)) errors.push("about: name the project or feature in plain words the owner recognizes, at most 8 words");
  else if (b.about.trim().split(/\s+/).length > 8) errors.push("about: keep the project or feature name to at most 8 words");
  const jargon = /\bv\d+\b(?!\.\d)|\bversion (?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+)\b(?!\.\d)|\b(?:phase|round|step) \d+\b|\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi;
  for (const [field, value] of [["ask", b.ask], ["standing", b.standing], ...(Array.isArray(b.options) ? b.options.map((o) => ["option label", o?.label]) : [])]) {
    const found = typeof value === "string" ? value.match(jargon) : null;
    if (found) errors.push(`${field}: replace ${found.join(", ")} with the feature and problem in plain words; no internal version or phase labels or hashes`);
  }
  if (typeof b.ask === "string" && (/^\s*(?:it|this|that)\b/i.test(b.ask) || /^\s*\w+\s+(?:it\b|this\s*(?:[?.,!]|$))/i.test(b.ask))) errors.push("ask: name the thing being decided instead of it, this or that");
  const entry = str(b.class) ? board.classes[b.class] : undefined;
  if (!entry) errors.push(`class must be one of the board's classes: ${Object.keys(board.classes).join(", ")}`);
  const tripwire = str(b.tripwire) ? b.tripwire : undefined;
  if (tripwire && !board.tripwires.includes(tripwire)) errors.push(`tripwire must be one of: ${board.tripwires.join(", ")}`);
  const level = tripwire ? 1 : entry?.level ?? 0;
  if (entry && !tripwire && level >= 4) errors.push(`${b.class} is level ${level} on the board: decide it yourself${level === 4 ? " and say so in your report (log it with decision_log)" : ""}. No brief needed.`);
  if (!str(b.ask)) errors.push("ask: the decision and your recommendation in one line");
  else {
    if (b.ask.length > ASK_MAX) errors.push(`ask is ${b.ask.length} characters; keep it to ${ASK_MAX}`);
    if (VERIFY_ASK.test(b.ask)) errors.push('"Try it and tell me" is not a decision: verify it yourself and report what you saw');
  }
  if (b.door !== "one-way" && b.door !== "two-way") errors.push('door: "one-way" (hard to undo) or "two-way"');
  if (!["private", "team", "public"].includes(b.blast)) errors.push('blast: "private", "team" or "public"');
  if (!str(b.standing)) errors.push("standing: where things stand, up to 3 lines");
  else if (lines(b.standing) > STANDING_LINES) errors.push(`standing has ${lines(b.standing)} lines; keep it to ${STANDING_LINES}`);
  if (!str(b.background)) errors.push("background: what the owner needs if they never read this thread");
  else if (lines(b.background) > BACKGROUND_LINES) errors.push(`background has ${lines(b.background)} lines; keep it to ${BACKGROUND_LINES} and link the rest`);
  const options = Array.isArray(b.options) ? b.options : [];
  // A precedent conflict has one option per rule it settles, however many rules share the scope (Loom checks them
  // against the conflict group); any other brief has 2 or 3, plus do nothing.
  if (options.length < 2) errors.push("options: 2 or 3 real options, plus do nothing when that is real");
  else if (tripwire !== "precedent-conflict" && options.length > 4) errors.push("options: 2 or 3 real options, plus do nothing when that is real (4 at most)");
  const keys = new Set<string>();
  for (const [i, o] of options.entries()) {
    if (!o || !str(o.key) || !str(o.label) || !str(o.consequence)) { errors.push(`options[${i}] needs key, label and consequence`); continue; }
    if (keys.has(o.key)) errors.push(`options: key ${o.key} repeats`);
    keys.add(o.key);
  }
  const recommended = options.filter((o) => o?.recommended);
  if (recommended.length > 1) errors.push("options: recommend one option at most");
  if ((level === 2 || level === 3) && recommended.length !== 1) errors.push("options: mark your recommended option (recommended: true); never send \"what should I do?\"");
  if (level === 3) {
    const fallback = b.default ?? recommended[0]?.key;
    if (!fallback || !keys.has(fallback)) errors.push("default: the option that runs if the owner doesn't veto it");
    else b.default = fallback;
  }
  for (const a of b.assets ?? []) {
    if (!a || !str(a.url) || !/^https?:\/\//i.test(a.url)) errors.push(`assets: ${a?.title ?? "an asset"} needs an http(s) URL`);
    else if (LOCAL_URL.test(a.url)) errors.push(`assets: ${a.url} only opens on this machine; put it on the tailnet first (tshare)`);
  }
  const candidate = !tripwire && b.door === "two-way" && b.blast !== "public" && (level === 2 || level === 3);
  if (candidate && !str(b.proposedRule)) errors.push('proposedRule: this is a two-way door, so say the rule it could become: "Next time, for <scope>, do <X> without asking"');
  return { errors, level, candidate, brief: b };
}

/** What a revision may change: anything but the class (a different class is a different decision). */
const REVISABLE = ["about", "ask", "door", "blast", "standing", "background", "options", "assets", "deadline", "default", "confidence", "changeMyMind", "precedents", "proposedRule", "blocks", "tripwire"] as const;
const FIELD_WORDS: Record<string, string> = { about: "the project or feature", ask: "the ask", standing: "where it stands", changeMyMind: "what would change it", proposedRule: "the proposed rule", tripwire: "the tripwire", door: "the door", blast: "who it affects" };
const recommendedKey = (b: DecisionBrief) => (Array.isArray(b.options) ? b.options.find((o) => o?.recommended)?.key : undefined) ?? null;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export interface Revision { errors: string[]; level: number; candidate: boolean; brief: DecisionBrief; fields: string[]; what: string; material: boolean }

/**
 * An open brief revised in place (decision.update, TGO-1079): the changes laid over it and linted as a whole, what
 * changed in words, and whether it is material. A material change (the options, the recommendation, the default, or
 * the level) restarts a level 3 veto window and tells the carriers; a copy edit does neither.
 */
export function reviseBrief(current: DecisionBrief, level: number, changes: unknown, board: Board): Revision {
  const patch = (changes && typeof changes === "object" && !Array.isArray(changes) ? changes : {}) as Record<string, unknown>;
  const errors: string[] = [];
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) errors.push("changes: an object of the brief's fields to change");
  for (const key of Object.keys(patch)) {
    if (key === "class") { if (patch.class !== current.class) errors.push("class can't change: a different class is a different decision, so mark this one moot (decision_close) and raise a new one"); }
    else if (!(REVISABLE as readonly string[]).includes(key)) errors.push(`changes: no field ${key} on a brief`);
  }
  const merged = { ...current, ...patch, class: current.class } as DecisionBrief & Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) if (value === null) delete merged[key];
  // A default that only followed the recommendation follows it to the new one.
  if (!("default" in patch) && current.default && current.default === recommendedKey(current)) delete merged.default;
  const linted = lintBrief(merged, board);
  errors.push(...linted.errors);
  const next = linted.brief;
  const before = recommendedKey(current), after = recommendedKey(next);
  const bare = (b: DecisionBrief) => (Array.isArray(b.options) ? b.options.map(({ recommended: _r, ...rest }) => rest) : b.options);
  const what: string[] = [];
  const fields: string[] = [];
  if (before !== after) { fields.push("recommendation"); what.push(`recommendation ${before ?? "none"} → ${after ?? "none"}`); }
  if (!same(bare(current), bare(next))) { fields.push("options"); what.push("options"); }
  if ((current.default ?? null) !== (next.default ?? null)) { fields.push("default"); what.push(`default ${current.default ?? "none"} → ${next.default ?? "none"}`); }
  if (linted.level !== level) { fields.push("level"); what.push(`level ${level} → ${linted.level}`); }
  for (const key of REVISABLE) {
    if (key === "options" || key === "default") continue;
    if (!same(current[key], next[key])) { fields.push(key); what.push(FIELD_WORDS[key] ?? key); }
  }
  if (!errors.length && !fields.length) errors.push("changes: nothing in them differs from the brief as it stands");
  const material = fields.some((f) => f === "recommendation" || f === "options" || f === "default" || f === "level");
  return { errors, level: linted.level, candidate: linted.candidate, brief: next, fields, what: what.join(" · "), material };
}

/** What the owner's answer says, as the turn the thread wakes to. `made`: the rule the answer made, if it made one. */
export function answerText(row: DecisionRow, brief: DecisionBrief, answer: { option?: string | null; text?: string | null; reason?: string | null; rule?: RuleChoice | null; made?: { id: string; scope: string; action: string } | null; proposal?: { text: string; from: string[] } | null; precedent?: boolean }): string {
  const option = brief.options.find((o) => o.key === answer.option);
  const out = [`Decision ${row.id}: ${row.ask}`];
  out.push(option ? `I chose ${option.key}: ${option.label}.` : "None of the options:");
  if (answer.text) out.push(answer.text);
  if (answer.reason) out.push(`Why: ${answer.reason}`);
  if (answer.made) out.push(`That is now standing rule ${answer.made.id}: for ${answer.made.scope}, ${answer.made.action}. Next time, act on it without asking, and log it citing the rule (decision_log, rule: "${answer.made.id}").`);
  else if (answer.rule === "always" && brief.proposedRule) out.push(brief.tripwire ? "Not a standing rule: a tripwire always comes to me." : "Not a standing rule: that isn't the answer the rule proposed.");
  else if (answer.rule === "next-time") out.push("Ask me again next time.");
  else if (answer.proposal) out.push(`That is the second time I've made this call (${answer.proposal.from.join(", ")}), so Loom proposes a standing rule for me to confirm: ${answer.proposal.text}. Until I do, ask as before; cite ${answer.proposal.from.join(" and ")} as precedents.`);
  // Only an answer that counts is a precedent: a non-candidate, another option or the owner's own words is just this once.
  else if (answer.rule === "once") out.push(answer.precedent ? "Just this once: it's a precedent, not a rule (a second similar call proposes one)." : "Just this once: not a rule, and not a precedent to cite.");
  return out.join("\n");
}

/** The rule choice when the owner didn't pick one: a candidate approved as recommended is a precedent (D-61, superseding D-2). */
export function defaultRuleChoice(candidate: boolean, followed: boolean, rule?: RuleChoice | null): RuleChoice | null {
  if (rule) return rule;
  // D-61: a first approval is a precedent ("Just this once"), not a rule; Always is the owner's explicit choice.
  return candidate && followed ? "once" : null;
}

/** A rule Loom proposes from two similar approvals (D-61), for the owner to confirm with one tap. */
export interface RuleProposal { text: string; scope: string; action: string; from: string[]; state: "proposed" | "made" | "dismissed"; written: "model" | "plain" }

const SUMMARY_MAX = 200;
export interface LogInput { class?: unknown; summary?: unknown; undo?: unknown; ref?: unknown; rule?: unknown; scope?: unknown; dissent?: unknown }
/** The standing rule a log cites, as lintLog needs it. */
export interface CitedRule { id: string; class: string; scope: string; level: number; state: string; state_why: string | null }

/**
 * Checks a level 4 log (decision_log): only a class the board puts at level 4 is logged, or one a standing rule the
 * log cites makes level 4 for its scope. Level 5 needs no log; levels 1 to 3 need a brief. Returns the errors, or
 * the clean fields.
 */
export function lintLog(input: LogInput, board: Board, findRule: (id: string) => CitedRule | undefined = () => undefined): { errors: string[]; level: number; log: { class: string; summary: string; undo: string | null; ref: string | null; rule: string | null; dissent: string | null } } {
  const errors: string[] = [];
  const cls = str(input.class) ? input.class.trim() : "";
  const entry = cls ? board.classes[cls] : undefined;
  const ruleId = str(input.rule) ? input.rule.trim() : null;
  const rule = ruleId ? findRule(ruleId) : undefined;
  let level = entry?.level ?? 0;
  if (!entry) errors.push(`class must be one of the board's classes: ${Object.keys(board.classes).join(", ")}`);
  else if (ruleId) {
    if (!rule) errors.push(`rule: there is no standing rule ${ruleId} (decision_check lists them)`);
    else if (rule.class !== cls) errors.push(`rule: ${rule.id} is for ${rule.class}, not ${cls}`);
    else if (rule.state !== "active") errors.push(`rule: ${rule.id} is ${rule.state}${rule.state_why ? ` (${rule.state_why})` : ""}, so it no longer covers this: bring a brief (decision_request)`);
    // Rules match literally: the case's scope, stated, is the rule's scope, or the rule doesn't cover it.
    else if (!str(input.scope)) errors.push(`scope: with rule, state your case's scope; ${rule.id} covers "${rule.scope}"`);
    else if (!scopeCovers(rule.scope, input.scope)) errors.push(`scope: ${rule.id} covers "${rule.scope}", not "${input.scope.trim()}". A near miss asks: bring a brief, and propose widening the scope in it`);
    else level = Math.max(level, rule.level);
  }
  if (entry && !errors.length) {
    if (level === 5 && !rule) errors.push(`${cls} is level 5 on the board: just do it; there is nothing to log`);
    else if (level < 4) errors.push(`${cls} is level ${level} on the board: that is the owner's to see first, so bring a brief (decision_request), or cite the standing rule that covers it`);
  }
  const summary = str(input.summary) ? input.summary.trim().replace(/\s+/g, " ") : "";
  if (!summary) errors.push("summary: what you decided and did, in one line");
  else if (summary.length > SUMMARY_MAX) errors.push(`summary is ${summary.length} characters; keep it to ${SUMMARY_MAX}`);
  const undo = str(input.undo) ? input.undo.trim() : null;
  const ref = str(input.ref) ? input.ref.trim() : null;
  if (ref && !/^https?:\/\//i.test(ref)) errors.push("ref: an http(s) link to what you did (a PR, a page)");
  else if (ref && LOCAL_URL.test(ref)) errors.push(`ref: ${ref} only opens on this machine; put it on the tailnet first (tshare)`);
  const dissent = str(input.dissent) ? input.dissent.trim().replace(/\s+/g, " ").slice(0, SUMMARY_MAX) : null;
  if (dissent && !rule) errors.push("dissent: only with the rule you followed and disagree with (rule)");
  return { errors, level, log: { class: cls, summary, undo, ref, rule: rule?.id ?? null, dissent } };
}

/** What the thread wakes to when the owner asks to undo something it decided for them. */
export function undoText(row: Pick<DecisionRow, "id" | "ask" | "undo">, note: string | null, suspended: string | null = null): string {
  const out = [`Undo ${row.id}: ${row.ask}.${note ? ` ${note}` : ""}`];
  if (row.undo) out.push(`How you said to undo it: ${row.undo}`);
  if (suspended) out.push(`Standing rule ${suspended} is suspended: the next case like this asks again.`);
  return out.join("\n");
}
