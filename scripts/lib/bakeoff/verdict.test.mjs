import { test } from "node:test";
import assert from "node:assert/strict";

import { summarizeCandidate, computeVerdict, isEligible } from "./verdict.mjs";

const fixture = (overrides = {}) => ({
  id: "test.fixture",
  passRateThreshold: 0.8,
  rubricThreshold: 0.7,
  rubricFloor: 0.6,
  incumbentModel: null,
  ...overrides,
});

function mkRun({ pass = true, infra = false, seconds = 10, outTok = 500, cost = null, rubric = null } = {}) {
  return {
    gates: { pass, infra, failures: pass ? [] : [{ gate: "tool:x", detail: "missed" }] },
    rubricScore: rubric,
    seconds,
    usage: { outputTokens: outTok },
    costUsd: cost,
  };
}

function candidate(model, runs, benchmarkOnly = false) {
  return summarizeCandidate(fixture(), { model, benchmarkOnly, runs });
}

test("infra runs are excluded from the pass-rate denominator", () => {
  const s = candidate("m", [mkRun(), mkRun(), mkRun({ infra: true, pass: false })]);
  assert.equal(s.validRuns, 2);
  assert.equal(s.infraRuns, 1);
  assert.equal(s.passRate, 1);
});

test("eligibility respects passRateThreshold and rubricThreshold", () => {
  const f = fixture();
  const flaky = candidate("flaky", [mkRun(), mkRun(), mkRun({ pass: false })]); // 2/3 = 0.667
  const solid = candidate("solid", [mkRun(), mkRun(), mkRun()]);
  const shallow = candidate("shallow", [mkRun({ rubric: 0.5 }), mkRun({ rubric: 0.6 }), mkRun({ rubric: 0.55 })]);
  assert.equal(isEligible(f, flaky), false);
  assert.equal(isEligible(f, solid), true);
  assert.equal(isEligible(f, shallow), false);
});

test("worst-run rubric floor gates eligibility even when the mean clears the bar", () => {
  const f = fixture();
  // mean 0.73 but one run at 0.58 — below the 0.6 floor (the glm-5 itinerary case)
  const swingy = candidate("swingy", [mkRun({ rubric: 0.58 }), mkRun({ rubric: 0.85 }), mkRun({ rubric: 0.76 })]);
  const steady = candidate("steady", [mkRun({ rubric: 0.8 }), mkRun({ rubric: 0.92 }), mkRun({ rubric: 0.88 })]);
  assert.equal(isEligible(f, swingy), false);
  assert.equal(isEligible(f, steady), true);
  const v = computeVerdict(f, [swingy, steady]);
  assert.equal(v.recommendation, "steady");
});

test("benchmark candidates are never eligible", () => {
  const s = candidate("claude:opus", [mkRun(), mkRun(), mkRun()], true);
  assert.equal(isEligible(fixture(), s), false);
});

test("ranking falls back to tokens-per-success when prices are unknown", () => {
  const cheapTok = candidate("small", [mkRun({ outTok: 200 }), mkRun({ outTok: 220 }), mkRun({ outTok: 210 })]);
  const bigTok = candidate("large", [mkRun({ outTok: 900 }), mkRun({ outTok: 950 }), mkRun({ outTok: 880 })]);
  const v = computeVerdict(fixture(), [bigTok, cheapTok]);
  assert.equal(v.recommendation, "small");
});

test("pass rate dominates ranking even above the eligibility gate", () => {
  // 100% reliable but pricier beats 80% reliable and cheap: failure costs trust,
  // not just retry tokens.
  const reliable = candidate("reliable", Array.from({ length: 5 }, () => mkRun({ cost: 0.02 })));
  const flakyCheap = candidate("flaky-cheap", [
    ...Array.from({ length: 4 }, () => mkRun({ cost: 0.001 })),
    mkRun({ cost: 0.001, pass: false }),
  ]);
  const v = computeVerdict(fixture(), [flakyCheap, reliable]);
  assert.equal(v.recommendation, "reliable");
});

test("at equal pass rate, cost-per-successful-run decides", () => {
  const pricey = candidate("pricey", Array.from({ length: 3 }, () => mkRun({ cost: 0.02 })));
  const cheap = candidate("cheap", Array.from({ length: 3 }, () => mkRun({ cost: 0.002 })));
  const v = computeVerdict(fixture(), [pricey, cheap]);
  assert.equal(v.recommendation, "cheap");
});

test("hysteresis: challenger that merely ties (not cheaper) does not displace incumbent", () => {
  const f = fixture({ incumbentModel: "incumbent" });
  const incumbent = candidate("incumbent", [mkRun({ outTok: 300 }), mkRun({ outTok: 300 }), mkRun({ outTok: 300 })]);
  const challenger = candidate("challenger", [mkRun({ outTok: 300 }), mkRun({ outTok: 300 }), mkRun({ outTok: 300 })]);
  const v = computeVerdict(f, [challenger, incumbent]);
  assert.equal(v.recommendation, "incumbent");
  assert.match(v.reason, /hysteresis/);
});

test("hysteresis: challenger tying at 100% while cheaper does displace incumbent", () => {
  const f = fixture({ incumbentModel: "incumbent" });
  const incumbent = candidate("incumbent", [mkRun({ outTok: 900 }), mkRun({ outTok: 900 }), mkRun({ outTok: 900 })]);
  const challenger = candidate("challenger", [mkRun({ outTok: 200 }), mkRun({ outTok: 200 }), mkRun({ outTok: 200 })]);
  const v = computeVerdict(f, [challenger, incumbent]);
  assert.equal(v.recommendation, "challenger");
});

test("hysteresis: challenger strictly beating incumbent pass rate displaces it", () => {
  const f = fixture({ incumbentModel: "incumbent", passRateThreshold: 0.6 });
  const incumbent = candidate("incumbent", [mkRun(), mkRun(), mkRun({ pass: false })]); // 0.667
  const challenger = candidate("challenger", [mkRun({ outTok: 2000 }), mkRun({ outTok: 2000 }), mkRun({ outTok: 2000 })]); // 1.0, more expensive
  const v = computeVerdict(f, [challenger, incumbent]);
  assert.equal(v.recommendation, "challenger");
});

test("no eligible model yields a null recommendation, infra-only yields infraIncomplete", () => {
  const f = fixture();
  const broken = candidate("broken", [mkRun({ pass: false }), mkRun({ pass: false }), mkRun({ pass: false })]);
  const v1 = computeVerdict(f, [broken]);
  assert.equal(v1.recommendation, null);
  assert.equal(v1.infraIncomplete, false);

  const infraOnly = candidate("unreachable", [mkRun({ infra: true, pass: false })]);
  const v2 = computeVerdict(f, [infraOnly]);
  assert.equal(v2.infraIncomplete, true);
});

test("benchmarks-only run is not infra-incomplete", () => {
  const bench = candidate("claude:sonnet", [mkRun()], true);
  const v = computeVerdict(fixture(), [bench]);
  assert.equal(v.infraIncomplete, false);
  assert.equal(v.recommendation, null);
});

test("hysteresis: marginal cost advantage (<10%) does not displace incumbent", () => {
  const f = fixture({ incumbentModel: "incumbent" });
  const incumbent = candidate("incumbent", Array.from({ length: 3 }, () => mkRun({ outTok: 1320 })));
  const challenger = candidate("challenger", Array.from({ length: 3 }, () => mkRun({ outTok: 1306 })));
  const v = computeVerdict(f, [challenger, incumbent]);
  assert.equal(v.recommendation, "incumbent");
});
