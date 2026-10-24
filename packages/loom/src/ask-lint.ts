// The ask lint (TGO-1074, docs/specs/decisions-and-delegation.md "Fallback"): a turn that closes with a prose
// A tool hand-off naming the desk person opens the thread's ask (LoomHost.recordAsk), and Loom also reads what
// kind of ask it is. Pointers ("answer D-6 on your desk") and real to-dos for the owner's hands pass silently. A
// decision asked in prose or a request to verify the agent's own work gets one corrective
// wake in Loom's voice, citing the board. Every classification is kept (ask_lints) for the phase 4 metric
// "legacy asks that never became a brief".
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AskKind } from "./asks.js";
import type { Board } from "./decisions.js";

export type AskLintKind = "pointer" | "todo" | "decision" | "verification" | "repeat" | "unclear" | "pass";
export interface AskLint { kind: AskLintKind; reason: string }

export const ASK_LINT_SCHEMA = `
CREATE TABLE IF NOT EXISTS ask_lints (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  run_id TEXT, message_id TEXT, kind TEXT NOT NULL, reason TEXT NOT NULL, ask TEXT NOT NULL, norm TEXT NOT NULL,
  declared_kind TEXT, ask_id TEXT,
  woke INTEGER NOT NULL DEFAULT 0, wake_run_id TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ask_lints_thread ON ask_lints(thread_id, created_at);
`;

export interface AskLintRow {
  id: string; thread_id: string; run_id: string | null; message_id: string | null; kind: AskLintKind; reason: string;
  declared_kind?: AskKind | null; ask_id?: string | null;
  ask: string; norm: string; woke: number; wake_run_id: string | null; created_at: number;
}

/** The ask's words, normalized: what "the same ask" means (the desk's askKey reads them the same way). */
export function normalizeAsk(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[`*_>#[\]()]/g, " ")
    .replace(/[^a-z0-9$%@ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The same ask: the same words and the same links. A changed link is a new deliverable, never a repeat. */
export function sameAsk(a: string, b: string): boolean {
  const links = (text: string) => [...new Set(text.match(/https?:\/\/[^\s)>\]`]+/g) ?? [])].sort().join(" ");
  return normalizeAsk(a) === normalizeAsk(b) && links(a) === links(b);
}

/** Names a brief or the desk card that carries it: the hand-off is a pointer, as the spec asks for. */
export const POINTER = /\b(?:D-\d+|decision card|(?:on|in) (?:your|the) desk|(?:in|under|from) needs you|the brief)\b/i;
/** "Try it and tell me", "look at 0:02 and tell me whether it matches": the agent's own check, handed over. */
const VERIFY = [
  /\b(?:tell me|let me know|confirm|say)\b[^;?]*?\b(?:whether|if|how)\b[^;?]*?\b(?:match(?:es)?|works?|working|looks?|is (?:right|correct|fixed|working|gone)|plays?|sounds?|lines? up|renders?|loads?|fixed|landed|reads? (?:right|well|ok))\b/i,
  /\b(?:does|did|do) (?:it|this|that|these|they|the \w+) (?:look|work|match|sound|play|render|load|read)\b/i,
  /\b(?:try|test|refresh|reload|open|play|watch|check) (?:it|this|that|the \w+)[^;?]*?\b(?:and|then) (?:tell me|let me know|confirm|report|see if)\b/i,
  /\b(?:confirm|verify|check) (?:that )?(?:it|this|the (?:fix|change|build|render|cut|page)) (?:works|is working|looks|is fixed|plays|renders)\b/i,
  /\blet me know if (?:it|this|that) works\b/i,
];
/** Choices laid out in prose: "A (… my pick) or B (…)", "my lean", "should X …, or …?". */
const LETTERED = /(?:^|[\s(:;,])(?:option\s+)?[A-D]\s*(?:\(|:|[—–]|-\s)/g;
const LEAN = /\b(?:my (?:pick|lean|recommendation|vote|preference)|i(?:'d| would) (?:lean|recommend|pick|go with|suggest)|\(recommended\)|recommended:)/i;
const CHOOSE = /\b(?:approve or (?:adjust|change|reject|edit|revise)|resolve (?:the |a |that |this )?(?:[\w-]+ ){0,4}(?:decision|call)|decide|decision on|choose|pick (?:one|between|a|an|the|which)|which (?:one|of|do you|should|would you)|do you want|would you (?:like|prefer)|(?:yes|go) or no|go\/no[- ]go|say (?:go|yes|no|which|whether)|ok(?:ay)? to|okay with|fine with|approve (?:the )?(?:plan|approach|design|direction|scope|spend|budget)|sign[- ]?off on)\b/i;
const SHOULD_Q = /\b(?:should|shall) (?:i|we|it|this|that|the|they|\w+)\b[^?]*\?/i;
const OR_Q = /\b\w+\b[^?]*\bor\b[^?]*\?/i;
/**
 * Alternatives laid out as an instruction, no question mark: "say keep X, reword it to Y, or drop it". The choosing verb
 * must lead the ask, so a to-do that merely mentions "say" or an incidental "or" ("email the vendor to say …") passes.
 */
const OR_LIST = /^\W*(?:say|choose|pick(?! up\b)|tell me (?:which|whether))\b[^.?]*,[^.?]*\bor\b/i;
/** An action in the world the agent can't do itself, at the front of the ask (the desk's TODO verbs, and more). */
const TODO = /^\W*(?:(?:please|then|now|today|tonight|tomorrow|this week|also|first|next|after [^,]{1,40},)\s+)*(?:go )?(?:buy|order|purchase|call|text|phone|email|mail|ship|install|mount|unmount|remove|plug|unplug|move|swap|put|take|measure|drive|ride|print|charge|clean|wash|pick up|drop off|bring|carry|run|export|import|upload|download|publish|post|send|record|film|shoot|render|sign (?:in|up|into|out)|log (?:in|into|out)|re-?auth(?:enticate|orize)?|authori[sz]e|grant|allow|enable|disable|turn (?:on|off)|reboot|power|connect|disconnect|pair|enter|paste|type|add|create|set up|book|schedule|pay|file|submit|fill (?:in|out)|open (?:the |your )?\w+ (?:app|settings)|go to|visit|reply to|forward)\b/i;
const SOFT_LEAD = /^\W*(?:whenever you(?:'re| are) ready|when you(?:'re| are) ready|when you get a chance|when you have a (?:minute|moment)|if you want(?: to)?|optionally|no rush)\s*[,:;—–-]?\s*/i;

function isDecision(item: string): string | null {
  if ((item.match(LETTERED) ?? []).length >= 2) return "lettered options";
  if (LEAN.test(item)) return "states a lean";
  if (CHOOSE.test(item)) return "asks for a choice";
  if (SHOULD_Q.test(item)) return "should-question";
  if (OR_Q.test(item)) return "either-or question";
  if (OR_LIST.test(item)) return "lists alternatives to choose from";
  return null;
}

/** Splits a hand-off into its asks: list items arrive joined by "; " (closingHandoff), and numbered lines inline. */
function items(text: string): string[] {
  return text
    .split(/;\s+|\s+(?=\(?\d+[.)]\s)/)
    .map((part) => part.replace(/^\s*\(?\d+[.)]\s+/, "").trim())
    .filter(Boolean);
}

function classifyItem(item: string): AskLint {
  if (POINTER.test(item)) return { kind: "pointer", reason: "names a brief" };
  const verify = VERIFY.find((re) => re.test(item));
  if (verify) return { kind: "verification", reason: "asks the owner to check the work" };
  const decision = isDecision(item);
  if (decision) return { kind: "decision", reason: decision };
  if (TODO.test(item.replace(SOFT_LEAD, ""))) return { kind: "todo", reason: "an action for the owner's hands" };
  return { kind: "unclear", reason: "no rule matched" };
}

/**
 * What kind of ask a "Next — you" hand-off makes, by rules alone. `previous` is the thread's still-open ask, if
 * any: the same words again are a repeat (a pointer may repeat; that is how a brief stays named). Across a list,
 * a decision anywhere makes the whole ask one; then a verification; to-dos and pointers pass. "unclear" is left
 * for an optional second stage and passes silently.
 */
export function classifyAsk(text: string, previous?: string | null): AskLint {
  const all = items(text.replace(/\s+/g, " ").trim());
  const each = all.map(classifyItem);
  const kinds = new Set(each.map((e) => e.kind));
  const allPointers = each.length > 0 && each.every((e) => e.kind === "pointer");
  if (!allPointers && previous && normalizeAsk(previous) && sameAsk(previous, text)) return { kind: "repeat", reason: "same ask as the open one" };
  // Options listed as separate items ("A — …; B — …") are one choice: count the letters across the whole ask.
  if (!allPointers && (all.join("; ").match(LETTERED) ?? []).length >= 2) return { kind: "decision", reason: "lettered options" };
  for (const kind of ["decision", "verification"] as const) {
    if (kinds.has(kind)) return each.find((e) => e.kind === kind)!;
  }
  if (kinds.has("todo")) return { kind: "todo", reason: "an action for the owner's hands" };
  if (allPointers) return { kind: "pointer", reason: "names a brief" };
  return { kind: "unclear", reason: "no rule matched" };
}

/** Declared pointers use points_to, never text inference. Legacy callers retain classifyAsk. */
export function classifyDeclaredAsk(text: string, kind: AskKind, repeat = false): AskLint {
  if (kind === "unclear") return { kind: "unclear", reason: "missing declared kind" };
  if (kind === "pointer") return { kind: "pass", reason: "declared pointer" };
  if (repeat) return { kind: "repeat", reason: "same ask as the open one" };
  const all = items(text.replace(/\s+/g, " ").trim());
  if (all.some(item => VERIFY.some(re => re.test(item)))) return { kind: "verification", reason: "asks the owner to check the work" };
  const decision = isDecision(all.join("; "));
  if (decision) return { kind: "decision", reason: decision };
  return { kind: "pass", reason: "declared ask" };
}

const quote = (ask: string) => (ask.length > 120 ? `${ask.slice(0, 119).trimEnd()}…` : ask);

/** The corrective wake, in Loom's voice; null for the kinds that pass. */
export function askLintWake(kind: AskLintKind, ask: string): string | null {
  const said = `Your closing "Next — you" ("${quote(ask)}")`;
  if (kind === "decision") return `Loom: ${said} is a decision. Decide it yourself if loom.decision_check says level 4 or 5 (say so under "Decided for you"); otherwise raise it with loom.decision_request and don't ask it in prose. (Delegation board: decisions go to the owner as one brief.)`;
  if (kind === "verification") return `Loom: ${said} asks the owner to check your work. Verify it yourself if you can (render a still, run it, read the file) and report what you saw; ask only for what needs the owner's eyes or hands, as a to-do. (Delegation board: verify-own-change is level 5.)`;
  return null;
}

/** The switch: `defaults.ask_lint: on|off` on the board (on by default); LOOM_ASK_LINT=off|on overrides it. */
export function askLintOn(board: Pick<Board, "defaults"> | null, env: NodeJS.ProcessEnv = process.env): boolean {
  const off = (v: unknown) => v === false || (typeof v === "string" && /^(off|false|no|0)$/i.test(v.trim()));
  if (env.LOOM_ASK_LINT !== undefined && env.LOOM_ASK_LINT !== "") return !off(env.LOOM_ASK_LINT);
  return !off(board?.defaults?.ask_lint);
}

export function askLints(db: DatabaseSync, threadId: string): AskLintRow[] {
  return db.prepare("SELECT * FROM ask_lints WHERE thread_id = ? ORDER BY created_at, rowid").all(threadId) as unknown as AskLintRow[];
}

/**
 * Whether a wake may go: at most once per normalized ask per thread, and never twice in a row (the turn that
 * answered a corrective, or the last classification having woken, holds the next one back).
 */
export function mayWake(db: DatabaseSync, threadId: string, runId: string, norm: string, askId?: string): boolean {
  const rows = askLints(db, threadId);
  if (rows.some((row) => row.woke && (row.norm === norm || !!askId && row.ask_id === askId))) return false;
  if (rows.some((row) => row.wake_run_id === runId)) return false;
  return !rows.at(-1)?.woke;
}

export function addAskLint(db: DatabaseSync, row: Omit<AskLintRow, "id">): AskLintRow {
  const id = randomUUID();
  db.prepare("INSERT INTO ask_lints (id, thread_id, run_id, message_id, kind, reason, ask, norm, woke, wake_run_id, created_at, declared_kind, ask_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, row.thread_id, row.run_id, row.message_id, row.kind, row.reason, row.ask, row.norm, row.woke, row.wake_run_id, row.created_at, row.declared_kind ?? null, row.ask_id ?? null);
  return { id, ...row };
}
