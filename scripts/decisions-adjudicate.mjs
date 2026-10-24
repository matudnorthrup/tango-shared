#!/usr/bin/env node
// Rules on decision-shadow rows: which answer was right, the deciding classifier's or Jev's?
// Agreement with the classifier is not accuracy (the classifiers have bugs too), so a judge
// (Claude, headless) decides each row itself:
//
//   * blind: the two answers are shown as A and B in random order, never as "current" and "Jev";
//   * with hindsight: what happened next is attached (the desk conversation after the card was
//     summarized, the operator's trace after a hold or a "main chat or thread?" answer);
//   * free to say neither: the judge picks the correct option from the full list.
//
// Every disagreement is judged, plus a sample of agreements (to catch both systems being wrong).
// Rulings append to adjudications.jsonl beside the shadow log; already-judged rows are skipped.
// `scripts/decisions-shadow-report.mjs` turns them into accuracy per system.
//
//   node scripts/decisions-adjudicate.mjs [--days 7] [--site desk.step] [--agree-sample 0.2]
//        [--limit 80] [--min-age-hours N] [--concurrency 3] [--model claude-opus-5-5] [--dry-run]
//
// A row is judged only once its hindsight window has closed: 48 h for desk.step, 10 min for the
// operator sites (--min-age-hours overrides every site).

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Env paths may be written "~/.tango" (the repo .env does): expand like runtime-paths.ts does.
const expandHome = (value) => (value ? value.replace(/^~(?=$|\/)/, os.homedir()) : value);

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const days = Number(flag("days", 7));
const onlySite = flag("site", null);
const agreeSample = Number(flag("agree-sample", 0.2));
const limit = Number(flag("limit", 80));
const minAgeOverride = flag("min-age-hours", null);
// Hindsight windows: a ruling made before its window closes could read "nothing happened" wrongly,
// and a judged row is never judged again.
const MIN_AGE_MS = { "desk.step": 48 * 3_600_000, "operator.unfinished": 10 * 60_000, "operator.destination": 10 * 60_000 };
const minAgeMs = (site) => (minAgeOverride !== null ? Number(minAgeOverride) * 3_600_000 : MIN_AGE_MS[site] ?? 0);
const concurrency = Number(flag("concurrency", 3));
const judgeModel = flag("model", "claude-opus-5-5");
const dryRun = args.includes("--dry-run");

const profileDir = path.join(expandHome(process.env.TANGO_HOME?.trim()) || path.join(os.homedir(), ".tango"), "profiles", process.env.TANGO_PROFILE?.trim() || "default");
const logDir = expandHome(process.env.TANGO_DECISION_LOG_DIR?.trim()) || path.join(profileDir, "data", "decisions");
// The screen service's database, resolved the way apps/screen/server/main.ts does (SCREEN_DATA_DIR).
const screenDbPath = expandHome(process.env.TANGO_SCREEN_DB?.trim()) || path.join(expandHome(process.env.SCREEN_DATA_DIR?.trim()) || path.join(profileDir, "data", "screen"), "screen.db");
const rulingsPath = path.join(logDir, "adjudications.jsonl");

// What each site decides, for the judge. Hindsight is evidence, not proof.
const SITES = {
  "desk.step": {
    compared: ["step"],
    about:
      "The status of one conversation card on the owner's desk board, set after the latest messages between the owner and an AI agent. " +
      "your_move = something is waiting on the owner (a decision or choice still open, new work for them to read or judge, or a task the agent says is theirs). " +
      "watching = nothing is needed from the owner yet (an update is coming, or another named person owes a reply). " +
      "fyi = nothing is expected of the owner (an errand reported done, the work closed, or already settled). " +
      "What happened next is evidence: the owner answering a pending question or reviewing delivered work supports your_move; the owner never engaging and the agent carrying on supports watching or fyi. It is evidence, not proof: owners also chat when nothing waits on them.",
  },
  "runtime.task_shape": {
    about:
      "The shape of a task an owner gave an AI agent, used to pick which model answers it: JUDGMENT (open-ended reasoning, planning, advice, composition), DATA (analyzing the owner's own structured records for patterns), OTHER (a single obvious action with one correct result).",
  },
  "operator.unfinished": {
    about:
      "Whether words the owner spoke to a voice operator, to be sent to an AI agent, were cut off mid-thought (true) or a complete request (false). When the operator judges them unfinished it holds them and asks \"Is that everything?\". " +
      "What happened next is evidence: the owner adding the rest supports true; the owner saying \"yes, that's it\" or being annoyed by the question supports false.",
  },
  "operator.destination": {
    about:
      "The owner's spoken reply to the voice operator's question \"<agent>'s main chat, or the … thread?\": main, one of the offered threads, cancel (drop the request), or unclear (not an answer: a new request or something else). " +
      "What happened next is evidence: a correction (\"no, the other thread\") shows the destination was wrong.",
  },
};

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

const since = Date.now() - days * 86_400_000;
const judged = new Set(readJsonl(rulingsPath).map((ruling) => ruling.id));
const rows = fs.existsSync(logDir)
  ? fs.readdirSync(logDir).filter((file) => /^shadow-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort().flatMap((file) => readJsonl(path.join(logDir, file)))
  : [];
const eligible = rows.filter((row) => {
  const at = Date.parse(row.at);
  return row.id && row.state !== undefined && row.questions && !row.error && SITES[row.site] && at >= since && Date.now() - at >= minAgeMs(row.site) && !judged.has(row.id) && (!onlySite || row.site === onlySite);
});
// Every disagreement; a deterministic sample of agreements (by id, so reruns pick the same rows).
const sampled = (id) => parseInt(id.replace(/-/g, "").slice(0, 8), 16) / 0xffffffff < agreeSample;
// A backlog bigger than --limit is judged as a random sample, so the estimates stay unbiased;
// taking the oldest rows first would only ever judge one stretch. Ordered by the id's tail: the
// agreement sample keys on its head, and ordering by the head too would crowd out disagreements.
const queue = eligible
  .filter((row) => !row.agree || sampled(row.id))
  .sort((a, b) => (a.id.slice(-12) < b.id.slice(-12) ? -1 : 1))
  .slice(0, limit);

let db = null;
try {
  if (fs.existsSync(screenDbPath)) db = new DatabaseSync(screenDbPath, { readOnly: true });
} catch {
  db = null;
}
// Desk and operator rulings rest on hindsight: without the screen database they wait for a run that has it.
const needsHindsight = (row) => row.site === "desk.step" || row.site.startsWith("operator.");
if (!db) {
  const skipped = queue.filter(needsHindsight).length;
  if (skipped) console.log(`Screen database not found at ${screenDbPath}: ${skipped} desk/operator row(s) left for a later run (set SCREEN_DATA_DIR or TANGO_SCREEN_DB).`);
  for (let index = queue.length - 1; index >= 0; index -= 1) if (needsHindsight(queue[index])) queue.splice(index, 1);
}

function hindsight(row) {
  if (!db) return "(not available)";
  const at = Date.parse(row.at);
  if (row.site === "desk.step" && row.meta?.itemId) {
    const messages = db
      .prepare("select author, at, text from desk_messages where item_id = ? and at > ? and at < ? order by at limit 8")
      .all(row.meta.itemId, at, at + 48 * 3_600_000);
    // Only the owner's own actions: system events (step changes, re-summaries) restate a classifier's answer.
    const events = db
      .prepare("select type, actor, at from desk_events where item_id = ? and actor = 'owner' and at > ? and at < ? order by at limit 12")
      .all(row.meta.itemId, at, at + 48 * 3_600_000);
    const lines = [
      ...messages.map((message) => `+${Math.round((message.at - at) / 60_000)} min, ${message.author}: ${String(message.text).replace(/\s+/g, " ").slice(0, 600)}`),
      ...events.map((event) => `+${Math.round((event.at - at) / 60_000)} min, desk event: ${event.type} by ${event.actor}`),
    ];
    return lines.length ? lines.join("\n") : "Nothing: no further messages or desk actions on this conversation in the next 48 hours.";
  }
  if (row.site.startsWith("operator.")) {
    // Only what the owner said afterwards. The operator's own events (safety.hold, destination.*) and
    // its spoken replies follow from the current classifier's answer, so they would leak it.
    // Scoped to the voice session the decision came from: a later session's speech is not evidence.
    const session = row.meta?.session ?? null;
    const trace = session
      ? db.prepare("select at, summary from desk_trace where at > ? and at < ? and kind like 'user.said%' and session_id = ? order by at limit 10").all(at, at + 5 * 60_000, session)
      : db.prepare("select at, summary from desk_trace where at > ? and at < ? and kind like 'user.said%' order by at limit 10").all(at, at + 5 * 60_000);
    return trace.length ? trace.map((entry) => `+${Math.round((entry.at - at) / 1000)} s, the owner said: ${String(entry.summary).replace(/\s+/g, " ").slice(0, 300)}`).join("\n") : "The owner said nothing more in the next 5 minutes.";
  }
  return "(none for this decision)";
}

function comparedKeys(row) {
  return SITES[row.site].compared ?? Object.keys(row.incumbent).filter((key) => key in row.questions);
}

function optionsOf(question) {
  if (question.type === "choice") return Object.entries(question.criteria).map(([option, description]) => `  - ${option}${description ? `: ${description}` : ""}`);
  if (question.type === "binary" || question.type === "noul") return ["  - true", "  - false"];
  return question.criteria.map((level, index) => `  - ${index}: ${level}`);
}

function pick(answers, keys) {
  return Object.fromEntries(keys.map((key) => [key, answers?.[key]]));
}

function buildPrompt(row, keys, flip) {
  const incumbent = pick(row.incumbent, keys);
  const jev = pick(row.decision, keys);
  const [a, b] = flip ? [jev, incumbent] : [incumbent, jev];
  const questions = keys.map((key) => `${key}: ${row.questions[key].instructions ?? ""}\n${optionsOf(row.questions[key]).join("\n")}`).join("\n\n");
  return [
    "You are auditing one decision made inside a personal AI-assistant system. Two automated systems, A and B, answered the same question. Neither is a reference: either, both or neither may be right. Decide the correct answer yourself from the context and from what actually happened afterwards.",
    "",
    `What is being decided: ${SITES[row.site].about}`,
    "",
    `Question(s) and allowed options:\n${questions}`,
    "",
    `Context the systems saw (JSON):\n${typeof row.state === "string" ? row.state : JSON.stringify(row.state, null, 1)}`,
    "",
    `What happened next:\n${hindsight(row)}`,
    "",
    `System A answered: ${JSON.stringify(a)}`,
    `System B answered: ${JSON.stringify(b)}`,
    "",
    `Reply with JSON only: {"correct": {${keys.map((key) => `"${key}": <one allowed option>`).join(", ")}}, "confidence": <0-1, how sure you are>, "reason": "<one sentence>"}`,
  ].join("\n");
}

function runJudge(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--model", judgeModel, "--output-format", "json", "--tools", "", "--setting-sources", ""], { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      // "judge unavailable" = the CLI itself failed (no login, no quota, crash): counts toward stopping.
      // "judge answered badly" = this row's answer couldn't be read: the row's problem only.
      let envelope;
      try {
        envelope = JSON.parse(out);
      } catch {
        return reject(new Error(`judge unavailable (exit ${code}): ${(err || out).slice(0, 200)}`));
      }
      const text = String(envelope.result ?? "");
      // The CLI reports its own failures (e.g. "Not logged in") as an error result.
      if (envelope.is_error || code !== 0) return reject(new Error(`judge unavailable: ${text.slice(0, 200)}`));
      try {
        resolve(JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)));
      } catch {
        reject(new Error(`judge answered badly: ${text.slice(0, 200)}`));
      }
    });
    child.stdin.end(prompt);
  });
}

/** The judge's answer for every compared key must be an allowed option, with a 0-1 confidence. */
function validRuling(ruling, row, keys) {
  if (!ruling || typeof ruling !== "object" || !ruling.correct || typeof ruling.correct !== "object") return false;
  if (typeof ruling.confidence !== "number" || ruling.confidence < 0 || ruling.confidence > 1) return false;
  return keys.every((key) => {
    const question = row.questions[key];
    const value = ruling.correct[key];
    if (question.type === "choice") return typeof value === "string" && Object.hasOwn(question.criteria, value);
    if (question.type === "binary" || question.type === "noul") return value === true || value === false || value === "true" || value === "false";
    return Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) < question.criteria.length;
  });
}

const normalize = (value) => (typeof value === "boolean" ? String(value) : String(value ?? ""));
const right = (answers, correct, keys) => keys.every((key) => normalize(answers?.[key]) === normalize(correct?.[key]));

console.log(`Adjudicating ${queue.length} of ${eligible.length} eligible row(s) (${eligible.filter((row) => !row.agree).length} disagreements, agreements sampled at ${agreeSample}) with ${judgeModel}${dryRun ? " [dry run]" : ""}`);
let next = 0;
let done = 0;
let failedInARow = 0;
let aborted = null;
async function worker() {
  while (next < queue.length && !aborted) {
    const row = queue[next++];
    const keys = comparedKeys(row);
    const flip = parseInt(row.id.slice(-2), 16) % 2 === 1;
    const prompt = buildPrompt(row, keys, flip);
    if (dryRun) {
      console.log(`\n──── ${row.site} ${row.id}\n${prompt}`);
      continue;
    }
    try {
      const ruling = await runJudge(prompt);
      // A malformed ruling is not evidence: skip it (the row stays unjudged for the next run).
      if (!validRuling(ruling, row, keys)) throw new Error(`judge answered outside the options: ${JSON.stringify(ruling).slice(0, 160)}`);
      const entry = {
        id: row.id,
        site: row.site,
        at: row.at,
        judgedAt: new Date().toISOString(),
        judge: judgeModel,
        agreed: Boolean(row.agree),
        correct: ruling.correct,
        confidence: ruling.confidence,
        reason: ruling.reason,
        incumbentRight: right(row.incumbent, ruling.correct, keys),
        jevRight: right(row.decision, ruling.correct, keys),
      };
      fs.appendFileSync(rulingsPath, `${JSON.stringify(entry)}\n`);
      done += 1;
      failedInARow = 0;
      console.log(`${row.site.padEnd(22)} ${entry.incumbentRight ? "✓" : "✗"} current  ${entry.jevRight ? "✓" : "✗"} jev  correct=${JSON.stringify(entry.correct)}  ${String(entry.reason).slice(0, 110)}`);
    } catch (error) {
      console.log(`${row.site.padEnd(22)} ! ${error.message}`);
      // The same judge failure on every row (no login, no quota) is not worth repeating 100 times.
      // A bad ruling on one row is that row's problem: it doesn't count toward stopping the run.
      if (String(error.message).startsWith("judge unavailable")) {
        failedInARow += 1;
        if (failedInARow >= 5) aborted = error.message;
      }
    }
  }
}
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
if (!dryRun) console.log(`\n${done} ruling(s) written to ${rulingsPath}`);
if (aborted) {
  console.error(`Stopped after 5 judge failures in a row: ${aborted}`);
  process.exitCode = 1;
}
