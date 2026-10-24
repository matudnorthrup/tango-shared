#!/usr/bin/env node
// HTML report for review-addressee.mjs: false triggers by how long the owner had been silent, and
// what a quiet-leaning gate after a long silence would cost (real requests that name nobody).
//
//   node scripts/voice-operator/review-addressee-report.mjs [--out DIR] [--names "watson,sierra,…"]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const expand = (p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
const outDir = expand(flag("out", path.join(os.homedir(), ".agentic-workflow/artifacts/live-operator-lab/addressee-review")));
const names = flag("names", "yankee,tango,watson,sierra,juliet,malibu,victor,foxtrot,papa,charlie,t3,t three,operator")
  .split(",")
  .map((n) => n.trim())
  .filter(Boolean);
const nameRe = new RegExp(`\\b(${names.map((n) => n.replace(/\s+/g, "\\s+")).join("|")})\\b`, "i");

const readJsonl = (file) =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
const turns = readJsonl(path.join(outDir, "turns.jsonl"));
const labels = new Map(readJsonl(path.join(outDir, "labels.jsonl")).map((l) => [`${l.session}#${l.n}`, l]));
const rows = turns.map((t) => ({ ...t, label: labels.get(`${t.session}#${t.n}`) })).filter((r) => r.label);

const BUCKETS = [
  { key: "warm", title: "Mid-session (spoke < 45 s ago)", test: (ms) => ms !== null && ms < 45_000 },
  { key: "45s", title: "45 s – 2 min", test: (ms) => ms !== null && ms >= 45_000 && ms < 120_000 },
  { key: "2m", title: "2 – 10 min", test: (ms) => ms !== null && ms >= 120_000 && ms < 600_000 },
  { key: "10m", title: "10 min +", test: (ms) => ms !== null && ms >= 600_000 },
  { key: "first", title: "First speech of a session", test: (ms) => ms === null },
];
const bucketOf = (r) => BUCKETS.find((b) => b.test(r.ownerQuietMs)).key;
const isFalse = (r) => r.label.addressed !== "yes" && r.label.harm && r.label.harm !== "none";
const isReal = (r) => r.label.addressed === "yes";
const named = (r) => nameRe.test(r.text);
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "–");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const secs = (ms) => (ms === null ? "first" : ms < 90_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`);

const falses = rows.filter(isFalse);
const notAddressed = rows.filter((r) => r.label.addressed === "no");
const unclear = rows.filter((r) => r.label.addressed === "unclear");

const bucketRows = BUCKETS.map((b) => {
  const inB = rows.filter((r) => bucketOf(r) === b.key);
  const f = inB.filter(isFalse);
  const real = inB.filter(isReal);
  const realUnnamed = real.filter((r) => !named(r));
  return { ...b, n: inB.length, no: inB.filter((r) => r.label.addressed === "no").length, f: f.length, spoke: f.filter((r) => r.label.harm === "spoke").length, sent: f.filter((r) => r.label.harm === "sent").length, real: real.length, realUnnamed: realUnnamed.length };
});

const kinds = {};
for (const r of [...notAddressed, ...unclear]) kinds[r.label.kind] = (kinds[r.label.kind] ?? 0) + 1;
const falseKinds = {};
for (const r of falses) falseKinds[r.label.kind] = (falseKinds[r.label.kind] ?? 0) + 1;

const cold = (r) => bucketOf(r) !== "warm";
const coldFalse = falses.filter(cold);
const coldRealUnnamed = rows.filter((r) => cold(r) && isReal(r) && !named(r) && r.label.kind !== "backchannel");

const example = (r) => `<div class="ex">
  <div class="meta">${esc(r.session.slice(0, 16).replace("T", " "))} · owner silent ${secs(r.ownerQuietMs)} · ${esc(r.label.kind)} · ${esc(r.label.addressed)}${r.label.harm && r.label.harm !== "none" ? ` · <b>${esc(r.label.harm)}</b>` : ""}</div>
  <div class="heard">“${esc(r.text)}”</div>
  ${r.reply ? `<div class="said">→ ${esc(r.reply.slice(0, 280))}${r.reply.length > 280 ? "…" : ""}</div>` : ""}
  ${r.actions.length ? `<div class="said">router: ${esc(r.actions.join("; "))}</div>` : ""}
  <div class="note">${esc(r.label.note)}</div>
</div>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Operator: speech not meant for it</title>
<style>
body{font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:980px;margin:24px auto;padding:0 16px;color:#1d1d1f;background:#fafafa}
h1{font-size:24px;margin-bottom:4px}h2{margin-top:36px;font-size:19px}
.sub{color:#666}
.tiles{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}
.tile{background:#fff;border:1px solid #e3e3e3;border-radius:10px;padding:12px 16px;min-width:150px}
.tile b{display:block;font-size:26px}
table{border-collapse:collapse;width:100%;background:#fff}
th,td{border-bottom:1px solid #eee;padding:7px 10px;text-align:right}th:first-child,td:first-child{text-align:left}
th{font-size:13px;color:#555;font-weight:600}
.ex{background:#fff;border:1px solid #e6e6e6;border-radius:8px;padding:10px 14px;margin:10px 0}
.meta{font-size:12px;color:#777}.heard{margin:4px 0}.said{color:#555;font-size:14px}.note{font-size:13px;color:#8a5a00;margin-top:4px}
details{margin:8px 0}summary{cursor:pointer;font-weight:600}
</style></head><body>
<h1>Speech the operator wasn't meant to hear</h1>
<div class="sub">${rows.length} owner utterances from ${new Set(rows.map((r) => r.session)).size} operator sessions, labeled after the fact by a blind judge (claude-opus-5-5) using the whole transcript as hindsight. Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC.</div>

<div class="tiles">
<div class="tile"><b>${falses.length}</b>false triggers (it spoke or sent)</div>
<div class="tile"><b>${falses.filter((r) => r.label.harm === "spoke").length}</b>it answered out loud</div>
<div class="tile"><b>${falses.filter((r) => r.label.harm === "sent").length}</b>something went to an agent</div>
<div class="tile"><b>${notAddressed.length + unclear.length}</b>not for it / unclear (${pct(notAddressed.length + unclear.length, rows.length)})</div>
</div>

<h2>By how long you'd been silent</h2>
<table><tr><th>Silence before</th><th>Utterances</th><th>Not for it</th><th>False triggers</th><th>spoke / sent</th><th>Real requests</th><th>…naming nobody</th></tr>
${bucketRows.map((b) => `<tr><td>${b.title}</td><td>${b.n}</td><td>${b.no} (${pct(b.no, b.n)})</td><td>${b.f} (${pct(b.f, b.n)})</td><td>${b.spoke} / ${b.sent}</td><td>${b.real}</td><td>${b.realUnnamed}</td></tr>`).join("\n")}
</table>
<p class="sub">"Naming nobody": real requests with no wake word or agent name (${esc(names.join(", "))}). After a long silence, a quiet-leaning gate would have to judge these from the words alone. They're what leaning quiet could cost.</p>

<h2>What the stray speech was</h2>
<table><tr><th>Kind</th><th>Not for it / unclear</th><th>…of which triggered a reply or send</th></tr>
${Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<tr><td>${esc(k)}</td><td>${n}</td><td>${falseKinds[k] ?? 0}</td></tr>`).join("\n")}
</table>

<h2>False triggers after a silence (${coldFalse.length})</h2>
<p class="sub">These are the ones a gate after a long quiet would catch.</p>
${coldFalse.map(example).join("\n") || "<p>None.</p>"}

<details><summary>False triggers mid-session (${falses.length - coldFalse.length})</summary>
${falses.filter((r) => !cold(r)).map(example).join("\n")}
</details>

<h2>Real requests after a silence that name nobody (${coldRealUnnamed.length})</h2>
<p class="sub">If the gate leans quiet, these are the ones at risk. Could the words alone tell they were meant for the operator?</p>
<details><summary>Show all</summary>
${coldRealUnnamed.map(example).join("\n")}
</details>

<details><summary>Everything judged not for it or unclear (${notAddressed.length + unclear.length})</summary>
${[...notAddressed, ...unclear].map(example).join("\n")}
</details>
</body></html>`;

fs.writeFileSync(path.join(outDir, "index.html"), html);
const summary = { utterances: rows.length, falseTriggers: falses.length, spoke: falses.filter((r) => r.label.harm === "spoke").length, sent: falses.filter((r) => r.label.harm === "sent").length, notForIt: notAddressed.length, unclear: unclear.length, coldFalse: coldFalse.length, coldRealUnnamed: coldRealUnnamed.length, buckets: bucketRows.map(({ test, ...b }) => b), kinds, falseKinds };
fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
