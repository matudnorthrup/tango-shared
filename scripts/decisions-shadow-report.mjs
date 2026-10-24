#!/usr/bin/env node
// Reads the decision-model shadow log (packages/core/src/decision-model.ts) and prints, per call
// site, agreement between Jev and the classifier that actually decided, latency, errors and spend
// and, from the judge's rulings (scripts/decisions-adjudicate.mjs), how often EACH system was
// right. Agreement is not accuracy: the current classifiers have bugs, so neither side is the
// reference. The question it answers: which system decides this better?
//
//   node scripts/decisions-shadow-report.mjs [--days 7] [--site desk.step] [--disagreements 10] [--json]
//
// Log dir: TANGO_DECISION_LOG_DIR, else ~/.tango/profiles/<TANGO_PROFILE|default>/data/decisions.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Env paths may be written "~/.tango" (the repo .env does): expand like runtime-paths.ts does.
const expandHome = (value) => (value ? value.replace(/^~(?=$|\/)/, os.homedir()) : value);

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const days = Number(flag("days", 7));
const onlySite = flag("site", null);
const showDisagreements = Number(flag("disagreements", 5));
const asJson = args.includes("--json");
// USD per 1M input tokens (output is free). A model not listed is reported in tokens only.
const PRICE_PER_M = { "typesafe/jev": 0.042 };
const priceFor = (model) => Object.entries(PRICE_PER_M).find(([prefix]) => model?.startsWith(prefix))?.[1];
const HIGH = 0.9;

const logDir =
  expandHome(process.env.TANGO_DECISION_LOG_DIR?.trim()) ||
  path.join(expandHome(process.env.TANGO_HOME?.trim()) || path.join(os.homedir(), ".tango"), "profiles", process.env.TANGO_PROFILE?.trim() || "default", "data", "decisions");

const since = Date.now() - days * 86_400_000;
const rows = [];
for (const file of fs.existsSync(logDir) ? fs.readdirSync(logDir).sort() : []) {
  const match = /^shadow-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file);
  if (!match || Date.parse(`${match[1]}T23:59:59Z`) < since) continue;
  for (const line of fs.readFileSync(path.join(logDir, file), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (Date.parse(row.at) >= since && (!onlySite || row.site === onlySite)) rows.push(row);
    } catch {
      // A torn line from a crash mid-write: skip it.
    }
  }
}

const quantile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
};
const pct = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : "—");
// The confidence of the decision that was compared (logged by the shadow); older rows fall
// back to the lowest across every question.
const minConfidence = (row) => row.comparedConfidence ?? Math.min(...Object.values(row.confidence ?? { x: 0 }));

const sites = new Map();
for (const row of rows) {
  const site = sites.get(row.site) ?? { site: row.site, calls: 0, errors: 0, compared: 0, agreed: 0, high: 0, highAgreed: 0, latency: [], tokens: 0, cost: 0, unpriced: 0, disagreements: [], errorSamples: new Map() };
  site.calls += 1;
  if (row.error) {
    site.errors += 1;
    const key = row.error.slice(0, 80);
    site.errorSamples.set(key, (site.errorSamples.get(key) ?? 0) + 1);
  } else {
    site.compared += 1;
    site.agreed += row.agree ? 1 : 0;
    if (minConfidence(row) >= HIGH) {
      site.high += 1;
      site.highAgreed += row.agree ? 1 : 0;
    }
    if (typeof row.latencyMs === "number") site.latency.push(row.latencyMs);
    site.tokens += row.inputTokens ?? 0;
    const price = priceFor(row.model);
    if (price === undefined) site.unpriced += row.inputTokens ?? 0;
    else site.cost += ((row.inputTokens ?? 0) * price) / 1e6;
    if (!row.agree) site.disagreements.push(row);
  }
  sites.set(row.site, site);
}

// The judge's rulings for rows in this window.
const rulingsById = new Map();
const rulingsFile = path.join(logDir, "adjudications.jsonl");
if (fs.existsSync(rulingsFile)) {
  for (const line of fs.readFileSync(rulingsFile, "utf8").split("\n")) {
    try {
      const ruling = JSON.parse(line);
      rulingsById.set(ruling.id, ruling);
    } catch {
      // skip a torn line
    }
  }
}
function accuracy(site) {
  const judged = rows.filter((row) => row.site === site.site && !row.error && rulingsById.has(row.id));
  if (!judged.length) return null;
  const rulings = judged.map((row) => ({ row, ruling: rulingsById.get(row.id) }));
  const disagreed = rulings.filter(({ ruling }) => !ruling.agreed);
  const agreed = rulings.filter(({ ruling }) => ruling.agreed);
  const share = (list, test) => (list.length ? list.filter(test).length / list.length : null);
  // Estimated accuracy over all traffic: agreements are right when the sampled ones were, and
  // disagreements go to whichever side the judge sided with.
  const bothRight = share(agreed, ({ ruling }) => ruling.incumbentRight);
  // Weighted by stratum: every disagreement is judged but agreements only sampled, so a raw share
  // would over-weight disagreements. A stratum present in the traffic but never judged means no
  // estimate, not an assumption.
  const stratified = (agreeTraffic, disagreeTraffic, agreeList, disagreeList, test) => {
    const total = agreeTraffic + disagreeTraffic;
    if (!total) return null;
    const agreeRate = share(agreeList, test);
    const disagreeRate = share(disagreeList, test);
    if ((agreeTraffic && agreeRate === null) || (disagreeTraffic && disagreeRate === null)) return null;
    return (agreeTraffic * (agreeRate ?? 0) + disagreeTraffic * (disagreeRate ?? 0)) / total;
  };
  const traffic = rows.filter((row) => row.site === site.site && !row.error);
  const agreeTraffic = traffic.filter((row) => row.agree).length;
  const estimate = (key) => stratified(agreeTraffic, traffic.length - agreeTraffic, agreed, disagreed, ({ ruling }) => ruling[key]);
  const confidentTraffic = traffic.filter((row) => (row.comparedConfidence ?? 0) >= HIGH);
  const confidentAgree = confidentTraffic.filter((row) => row.agree).length;
  const isConfident = ({ row }) => (row.comparedConfidence ?? 0) >= HIGH;
  const confident = rulings.filter(isConfident);
  const jevRightWhenConfident = stratified(confidentAgree, confidentTraffic.length - confidentAgree, agreed.filter(isConfident), disagreed.filter(isConfident), ({ ruling }) => ruling.jevRight);
  return {
    judged: rulings.length,
    disagreementsJudged: disagreed.length,
    agreementsJudged: agreed.length,
    currentRightOnDisagreements: share(disagreed, ({ ruling }) => ruling.incumbentRight),
    jevRightOnDisagreements: share(disagreed, ({ ruling }) => ruling.jevRight),
    neitherRightOnDisagreements: share(disagreed, ({ ruling }) => !ruling.incumbentRight && !ruling.jevRight),
    bothRightOnAgreements: bothRight,
    estimatedCurrentAccuracy: estimate("incumbentRight"),
    estimatedJevAccuracy: estimate("jevRight"),
    jevConfidentJudged: confident.length,
    jevRightWhenConfident,
  };
}

const summary = [...sites.values()].map((site) => ({
  accuracy: accuracy(site),
  site: site.site,
  calls: site.calls,
  errors: site.errors,
  agreement: site.compared ? site.agreed / site.compared : null,
  highConfidenceShare: site.compared ? site.high / site.compared : null,
  highConfidenceAgreement: site.high ? site.highAgreed / site.high : null,
  p50Ms: quantile(site.latency, 0.5),
  p90Ms: quantile(site.latency, 0.9),
  inputTokens: site.tokens,
  costUsd: site.cost,
  unpricedTokens: site.unpriced,
  errorSamples: Object.fromEntries(site.errorSamples),
  disagreements: (showDisagreements > 0 ? site.disagreements.slice(-showDisagreements) : []).map((row) => ({ at: row.at, incumbent: row.incumbent, decision: row.decision, confidence: row.confidence, excerpt: row.excerpt })),
}));

if (asJson) {
  console.log(JSON.stringify({ logDir, days, rows: rows.length, sites: summary }, null, 2));
  process.exit(0);
}

console.log(`Decision shadow report: last ${days} day(s), ${rows.length} call(s), ${logDir}`);
if (!summary.length) console.log("No shadow calls logged yet (is OPENROUTER_API_KEY set for the process?).");
for (const site of summary) {
  console.log(`\n${site.site}`);
  console.log(`  calls ${site.calls}  errors ${site.errors}  agreement with the current system ${pct(site.agreement * (site.calls - site.errors), site.calls - site.errors)} (not accuracy)`);
  const acc = site.accuracy;
  const p = (value) => (value === null || value === undefined ? "—" : `${(100 * value).toFixed(0)}%`);
  if (acc) {
    console.log(`  judged ${acc.judged} (${acc.disagreementsJudged} disagreements, ${acc.agreementsJudged} sampled agreements)`);
    console.log(`    on disagreements: current right ${p(acc.currentRightOnDisagreements)}, Jev right ${p(acc.jevRightOnDisagreements)}, neither ${p(acc.neitherRightOnDisagreements)}`);
    console.log(`    on sampled agreements: both right ${p(acc.bothRightOnAgreements)}`);
    console.log(`    estimated accuracy: current ${p(acc.estimatedCurrentAccuracy)}, Jev ${p(acc.estimatedJevAccuracy)}; Jev when confident (≥${HIGH}): ${p(acc.jevRightWhenConfident)} of ${acc.jevConfidentJudged}`);
  } else {
    console.log("  not judged yet: run scripts/decisions-adjudicate.mjs");
  }
  console.log(`  confidence ≥${HIGH}: ${pct(site.highConfidenceShare * (site.calls - site.errors), site.calls - site.errors)} of calls, agreement there ${site.highConfidenceAgreement === null ? "—" : `${(100 * site.highConfidenceAgreement).toFixed(1)}%`}`);
  console.log(`  latency p50 ${site.p50Ms ?? "—"} ms  p90 ${site.p90Ms ?? "—"} ms  spend $${site.costUsd.toFixed(4)} (${site.inputTokens} input tokens${site.unpricedTokens ? `, ${site.unpricedTokens} on unpriced models` : ""})`);
  for (const [error, count] of Object.entries(site.errorSamples)) console.log(`  error ×${count}: ${error}`);
  for (const row of site.disagreements) {
    console.log(`  ✗ ${row.at.slice(5, 16)} classifier=${JSON.stringify(row.incumbent)} jev=${JSON.stringify(row.decision)} conf=${JSON.stringify(row.confidence)}`);
    if (row.excerpt) console.log(`      “${row.excerpt.replace(/\s+/g, " ").slice(0, 140)}”`);
  }
}
