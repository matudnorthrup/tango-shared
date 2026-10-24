#!/usr/bin/env node
// Review the voice operator's logs for speech that was never meant for it.
//
// Rebuilds every owner utterance from the discord-logs jsonl (heard deltas), notes how long the
// session had been quiet before it, what the operator said back and whether anything went to an
// agent. A blind judge (headless claude) then labels each utterance: addressed to the operator or
// not, what kind of speech it was, and whether the operator answered or sent something it shouldn't
// have. Labels are cached per chunk, so a rerun only judges what's new.
//
//   node scripts/voice-operator/review-addressee.mjs [--logs DIR] [--out DIR] [--concurrency 4]
//        [--model claude-opus-5-5] [--limit-files N] [--dry-run]
//
// Output: <out>/turns.jsonl, <out>/labels.jsonl, <out>/index.html.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const expand = (p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
const lab = path.join(os.homedir(), ".agentic-workflow/artifacts/live-operator-lab");
const logsDir = expand(flag("logs", path.join(lab, "discord-logs")));
const outDir = expand(flag("out", path.join(lab, "addressee-review")));
const concurrency = Number(flag("concurrency", "4"));
const judgeModel = flag("model", "claude-opus-5-5");
const limitFiles = Number(flag("limit-files", "0"));
const dryRun = args.includes("--dry-run");

const SPLIT_GAP_MS = 2000;
const CHUNK = 80;
const CONTEXT = 8;

// ── rebuild utterances ──

function readEvents(file) {
  const events = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return events.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
}

function buildTurns(file) {
  const session = path.basename(file, ".jsonl");
  const events = readEvents(file);
  const turns = [];
  let cur = null;
  let lastActivity = null; // end of the last heard or said
  let lastHeard = null;
  let paused = false;
  let woke = false;
  const close = () => {
    if (cur) {
      cur.text = cur.text.replace(/\s+/g, " ").trim();
      if (cur.text) turns.push(cur);
    }
    cur = null;
  };
  for (const e of events) {
    if (e.kind === "pause.start") paused = true;
    if (e.kind === "pause.resume" || e.kind === "pause.ended") paused = false;
    if (e.kind === "wake") woke = true;
    if (e.kind === "heard") {
      if (cur && (cur.reply || cur.delegated || e.t - lastHeard > SPLIT_GAP_MS)) close();
      if (!cur) {
        cur = {
          session,
          n: turns.length,
          t: e.t,
          quietMs: lastActivity === null ? null : e.t - lastActivity,
          ownerQuietMs: lastHeard === null ? null : e.t - lastHeard,
          afterWake: woke,
          paused,
          text: "",
          reply: "",
          delegated: false,
          actions: [],
        };
        woke = false;
      }
      cur.text += e.delta ?? "";
      lastHeard = e.t;
      lastActivity = e.t;
    } else if (e.kind === "said.muted") {
      // The filler gate muted it: never heard, so not a reply.
      const muted = e.delta ?? e.text ?? "";
      const last = cur ?? turns.at(-1);
      if (last && muted) {
        const at = last.reply.lastIndexOf(muted);
        if (at >= 0) last.reply = last.reply.slice(0, at) + last.reply.slice(at + muted.length);
      }
    } else if (e.kind === "said") {
      if (cur) {
        cur.reply += e.delta ?? "";
        if (cur.firstReplyMs === undefined) cur.firstReplyMs = e.t - lastHeard;
      }
      lastActivity = e.t;
    } else if (e.kind === "delegation" && cur) {
      cur.delegated = true;
    } else if (e.kind === "extracted" && cur) {
      for (const a of e.actions ?? []) cur.actions.push(`${a.type}${a.agentId ? `:${a.agentId}` : ""}${a.reason ? ` (${a.reason})` : ""}`);
    }
  }
  close();
  for (const turn of turns) turn.reply = turn.reply.replace(/\s+/g, " ").trim();
  return turns;
}

// ── judge ──

const fmtSecs = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
};
const fmtQuiet = (turn) => {
  if (turn.ownerQuietMs === null) return "first owner speech of the session";
  return `owner silent ${fmtSecs(turn.ownerQuietMs)} before, any speech ${fmtSecs(turn.quietMs)}`;
};

function transcriptLine(turn, labeled) {
  const tags = [fmtQuiet(turn), turn.afterWake ? "operator had been asleep" : null, turn.paused ? "PAUSE was on" : null].filter(Boolean).join(", ");
  const lines = [`${labeled ? `[#${turn.n}]` : "[context]"} OWNER (${tags}): "${turn.text}"`];
  if (turn.reply) lines.push(`   OPERATOR said: "${turn.reply.slice(0, 600)}"`);
  if (turn.actions.length) lines.push(`   router: ${turn.actions.join("; ")}`);
  else if (turn.delegated) lines.push("   (handed to the router)");
  return lines.join("\n");
}

function prompt(context, chunk) {
  return [
    "You are reviewing transcripts from a voice assistant called the operator (also named Yankee; older sessions say Tango). It sits in a voice channel and listens continuously to its owner, who talks to it to ask a team of AI agents (and T3 coding threads) for things, reply to them, or dictate messages. Because it is always listening, it also hears speech that is not for it: people nearby or on the phone, the owner thinking aloud or singing, videos, workouts.",
    "",
    "Speech-to-text is imperfect: words may be garbled. OPERATOR lines are everything the operator said after that utterance, which may include unrelated agent updates it was reading out. Use the whole transcript, including what came after, as hindsight: if the owner ignores a reply, keeps talking to someone else, or says it wasn't for the operator, that tells you something.",
    "",
    "For each numbered utterance [#N] (not [context] lines), decide:",
    '- addressed: "yes" (meant for the operator or an agent: a request, an answer to the operator\'s question, dictation, a command, an acknowledgement in an ongoing exchange), "no" (not meant for it), or "unclear".',
    '- kind: one of request, answer, dictation, backchannel (mm-hm, okay, in an active exchange), singing, room (talking to another person present or on the phone), self (thinking out loud / talking to himself not to the operator), media (TV, video, music, another device), noise (garbled fragment, cough, single stray word), other.',
    '- harm (only meaningful when addressed is no or unclear): "spoke" if the operator said something in response to it (not merely reading an unrelated update), "sent" if something was sent to an agent because of it, "none" otherwise. Use "none" when addressed is yes.',
    "- note: under 15 words, why.",
    "",
    "Transcript:",
    ...context.map((t) => transcriptLine(t, false)),
    ...chunk.map((t) => transcriptLine(t, true)),
    "",
    'Reply with JSON only, no prose: {"labels": [{"n": <number>, "addressed": "...", "kind": "...", "harm": "...", "note": "..."}, ...]} with one entry for every [#N].',
  ].join("\n");
}

function runJudge(text) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--model", judgeModel, "--output-format", "json", "--tools", "", "--setting-sources", ""], { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    const timer = setTimeout(() => child.kill("SIGTERM"), 300_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const env = JSON.parse(out);
        if (env.is_error) throw new Error(env.result ?? "claude error");
        const body = String(env.result).replace(/^[^{]*/, "").replace(/[^}]*$/, "");
        resolve(JSON.parse(body).labels);
      } catch (error) {
        reject(new Error(`judge failed (exit ${code}): ${error.message} ${err.slice(0, 300)} ${out.slice(0, 300)}`));
      }
    });
    child.stdin.end(text);
  });
}

// ── main ──

fs.mkdirSync(outDir, { recursive: true });
let files = fs.readdirSync(logsDir).filter((f) => f.endsWith(".jsonl")).sort().map((f) => path.join(logsDir, f));
if (limitFiles) files = files.slice(-limitFiles);

const allTurns = files.flatMap(buildTurns);
fs.writeFileSync(path.join(outDir, "turns.jsonl"), allTurns.map((t) => JSON.stringify(t)).join("\n") + "\n");
console.log(`${files.length} sessions, ${allTurns.length} utterances`);

const labelsFile = path.join(outDir, "labels.jsonl");
const cached = new Map();
if (fs.existsSync(labelsFile)) {
  for (const line of fs.readFileSync(labelsFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    cached.set(`${row.session}#${row.n}`, row);
  }
}

const jobs = [];
const bySession = new Map();
for (const t of allTurns) (bySession.get(t.session) ?? bySession.set(t.session, []).get(t.session)).push(t);
for (const turns of bySession.values()) {
  for (let i = 0; i < turns.length; i += CHUNK) {
    const chunk = turns.slice(i, i + CHUNK);
    if (chunk.every((t) => cached.has(`${t.session}#${t.n}`))) continue;
    jobs.push({ context: turns.slice(Math.max(0, i - CONTEXT), i), chunk });
  }
}
console.log(`${jobs.length} chunks to judge (${cached.size} labels cached)`);
if (dryRun) {
  if (jobs[0]) console.log(prompt(jobs[0].context, jobs[0].chunk.slice(0, 6)));
  process.exit(0);
}

let done = 0;
let failed = 0;
async function worker() {
  while (jobs.length) {
    const job = jobs.shift();
    let labels;
    for (let attempt = 0; attempt < 2 && !labels; attempt++) {
      try {
        labels = await runJudge(prompt(job.context, job.chunk));
      } catch (error) {
        console.error(error.message);
      }
    }
    if (!labels) {
      failed++;
      if (failed >= 3 && done === 0) {
        console.error("three chunks failed before any succeeded; stopping");
        process.exit(1);
      }
      continue;
    }
    const session = job.chunk[0].session;
    const rows = labels.filter((l) => job.chunk.some((t) => t.n === l.n)).map((l) => ({ session, ...l }));
    fs.appendFileSync(labelsFile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    done++;
    console.log(`chunk ${done} done (${session}, ${rows.length} labels)`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
console.log(`judged ${done} chunks, ${failed} failed`);
