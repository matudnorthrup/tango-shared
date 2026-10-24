#!/usr/bin/env node
// Fixture contract validator for model bake-off evals (schema v2).
// Run via `npm run eval:validate`. Fails loudly on the first broken fixture so
// CI can gate on it.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TASK_DIR = join(ROOT, "agents/evals/model-bakeoff/tasks");

const SAFETY_TIERS = new Set([
  "read_only_bounded",
  "read_only_judgment",
  "write_dry_run",
  "write_live",
]);

const REQUIRED_FIELDS = [
  "id",
  "title",
  "category",
  "worker",
  "taskShape",
  "safetyTier",
  "tools",
  "candidateModels",
  "system",
  "prompt",
  "successCriteria",
  "knownFailureModes",
  "rubric",
];

const OUTPUT_ASSERTION_TYPES = new Set(["includes", "notIncludes", "matches", "notMatches"]);

// Per-category contract rules, kept as data so domain rules don't sprawl into
// hardcoded if-blocks. `promptPattern` selects fixtures; `mustRequireTool` must
// then appear in toolContract (or legacy requiredTools).
const CATEGORY_RULES = [
  {
    category: "travel",
    promptPattern: /route|drive|detour|waypoint|stop/i,
    mustRequireOneOf: ["driving_route", "find_diesel"],
    why: "travel route fixtures must gate on a routing-grounded tool — driving_route or find_diesel (Sierra 2026-06-09 incident)",
  },
];

function fail(file, message) {
  throw new Error(`${file}: ${message}`);
}

function assertString(value, file, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(file, `${field} must be a non-empty string`);
  }
}

function assertStringArray(value, file, field, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    fail(file, `${field} must be a ${allowEmpty ? "" : "non-empty "}string array`);
  }
}

function assertFraction(value, file, field) {
  if (typeof value !== "number" || value < 0 || value > 1) {
    fail(file, `${field} must be a number in [0, 1]`);
  }
}

function assertRegexCompiles(pattern, flags, file, field) {
  try {
    void new RegExp(pattern, flags ?? "i");
  } catch (e) {
    fail(file, `${field} is not a valid regex: ${e.message}`);
  }
}

function validateArgChecks(argChecks, file, field) {
  if (!Array.isArray(argChecks)) fail(file, `${field} must be an array`);
  argChecks.forEach((check, i) => {
    if (!check || typeof check !== "object") fail(file, `${field}[${i}] must be an object`);
    if (typeof check.path !== "string") fail(file, `${field}[${i}].path must be a string ("." targets the whole args object)`);
    const modes = ["exists", "equals", "matches"].filter((k) => check[k] !== undefined);
    if (modes.length > 1) fail(file, `${field}[${i}] must use at most one of exists/equals/matches`);
    if (check.matches !== undefined) assertRegexCompiles(check.matches, check.flags, file, `${field}[${i}].matches`);
  });
}

function validateContractBranch(branch, file, field, { requireName }) {
  if (!branch || typeof branch !== "object") fail(file, `${field} must be an object`);
  if (requireName) assertString(branch.name, file, `${field}.name`);
  if (branch.minCalls !== undefined && (!Number.isInteger(branch.minCalls) || branch.minCalls < 1)) {
    fail(file, `${field}.minCalls must be a positive integer`);
  }
  if (branch.argChecks !== undefined) validateArgChecks(branch.argChecks, file, `${field}.argChecks`);
}

function requiredToolNames(task) {
  const names = new Set(task.requiredTools ?? []);
  for (const contract of task.toolContract ?? []) {
    if (contract?.name) names.add(contract.name);
    for (const alt of contract?.oneOfTools ?? []) if (alt?.name) names.add(alt.name);
  }
  return names;
}

let checked = 0;
for (const file of readdirSync(TASK_DIR).filter((name) => name.endsWith(".json")).sort()) {
  const path = join(TASK_DIR, file);
  const task = JSON.parse(readFileSync(path, "utf8"));

  for (const field of REQUIRED_FIELDS) {
    if (!(field in task)) fail(file, `missing ${field}`);
  }

  for (const field of ["id", "title", "category", "worker", "taskShape", "safetyTier", "system", "prompt"]) {
    assertString(task[field], file, field);
  }

  if (!SAFETY_TIERS.has(task.safetyTier)) {
    fail(file, `unknown safetyTier ${task.safetyTier}`);
  }

  if (typeof task.tools !== "boolean") {
    fail(file, "tools must be a boolean");
  }

  assertStringArray(task.candidateModels, file, "candidateModels");
  assertStringArray(task.successCriteria, file, "successCriteria");
  assertStringArray(task.knownFailureModes, file, "knownFailureModes");

  // ---- v2 optional fields -----------------------------------------------------
  if (task.runs !== undefined && (!Number.isInteger(task.runs) || task.runs < 1 || task.runs > 10)) {
    fail(file, "runs must be an integer in [1, 10]");
  }
  if (task.passRateThreshold !== undefined) assertFraction(task.passRateThreshold, file, "passRateThreshold");
  if (task.rubricThreshold !== undefined) assertFraction(task.rubricThreshold, file, "rubricThreshold");
  if (task.rubricFloor !== undefined) assertFraction(task.rubricFloor, file, "rubricFloor");
  if (task.timeoutMs !== undefined && (!Number.isInteger(task.timeoutMs) || task.timeoutMs < 1000)) {
    fail(file, "timeoutMs must be an integer >= 1000");
  }
  if (task.maxTurns !== undefined && (!Number.isInteger(task.maxTurns) || task.maxTurns < 1 || task.maxTurns > 200)) {
    fail(file, "maxTurns must be an integer in [1, 200]");
  }
  if (task.incumbentModel !== undefined) assertString(task.incumbentModel, file, "incumbentModel");
  if (task.benchmarkModels !== undefined) assertStringArray(task.benchmarkModels, file, "benchmarkModels", { allowEmpty: true });
  if (task.forbiddenTools !== undefined) assertStringArray(task.forbiddenTools, file, "forbiddenTools", { allowEmpty: true });
  if (task.forbiddenCalls !== undefined) {
    if (!Array.isArray(task.forbiddenCalls)) fail(file, "forbiddenCalls must be an array");
    task.forbiddenCalls.forEach((forbidden, i) => {
      validateContractBranch(forbidden, file, `forbiddenCalls[${i}]`, { requireName: true });
      if (!Array.isArray(forbidden.argChecks) || forbidden.argChecks.length === 0) {
        fail(file, `forbiddenCalls[${i}].argChecks must be a non-empty array (use forbiddenTools for whole-tool bans)`);
      }
    });
  }
  if (task.images !== undefined) {
    assertStringArray(task.images, file, "images", { allowEmpty: true });
    for (const image of task.images) {
      if (!existsSync(join(ROOT, image))) fail(file, `images: ${image} does not exist (paths are repo-root relative)`);
    }
  }
  if (task.judge !== undefined) {
    if (!task.judge || typeof task.judge !== "object") fail(file, "judge must be an object");
    if (task.judge.model !== undefined) assertString(task.judge.model, file, "judge.model");
    if (task.judge.enabled !== undefined && typeof task.judge.enabled !== "boolean") fail(file, "judge.enabled must be a boolean");
  }

  if (task.requiredTools !== undefined) {
    assertStringArray(task.requiredTools, file, "requiredTools");
  }

  if (task.toolContract !== undefined) {
    if (!Array.isArray(task.toolContract)) fail(file, "toolContract must be an array");
    task.toolContract.forEach((contract, i) => {
      if (contract?.oneOfTools !== undefined) {
        if (!Array.isArray(contract.oneOfTools) || contract.oneOfTools.length < 2) {
          fail(file, `toolContract[${i}].oneOfTools must list at least two tool contracts`);
        }
        contract.oneOfTools.forEach((alt, j) =>
          validateContractBranch(alt, file, `toolContract[${i}].oneOfTools[${j}]`, { requireName: true }),
        );
        return;
      }
      validateContractBranch(contract, file, `toolContract[${i}]`, { requireName: true });
      if (contract.anyOf !== undefined) {
        if (!Array.isArray(contract.anyOf) || contract.anyOf.length === 0) {
          fail(file, `toolContract[${i}].anyOf must be a non-empty array`);
        }
        contract.anyOf.forEach((branch, j) =>
          validateContractBranch(branch, file, `toolContract[${i}].anyOf[${j}]`, { requireName: false }),
        );
      }
    });
  }

  if ((task.toolContract?.length || task.requiredTools?.length) && task.tools !== true) {
    fail(file, "toolContract/requiredTools requires tools=true");
  }

  if (task.outputAssertions !== undefined) {
    if (!Array.isArray(task.outputAssertions)) fail(file, "outputAssertions must be an array");
    task.outputAssertions.forEach((assertion, i) => {
      if (!assertion || typeof assertion !== "object") fail(file, `outputAssertions[${i}] must be an object`);
      if (!OUTPUT_ASSERTION_TYPES.has(assertion.type)) {
        fail(file, `outputAssertions[${i}].type must be one of ${[...OUTPUT_ASSERTION_TYPES].join("/")}`);
      }
      assertString(String(assertion.value ?? ""), file, `outputAssertions[${i}].value`);
      if (assertion.type === "matches" || assertion.type === "notMatches") {
        assertRegexCompiles(assertion.value, assertion.flags, file, `outputAssertions[${i}].value`);
      }
    });
  }

  // ---- Rubric -------------------------------------------------------------------
  if (!Array.isArray(task.rubric) || task.rubric.length === 0) {
    fail(file, "rubric must be a non-empty array");
  }
  const totalWeight = task.rubric.reduce((sum, item, index) => {
    if (!item || typeof item !== "object") fail(file, `rubric[${index}] must be an object`);
    assertString(item.name, file, `rubric[${index}].name`);
    assertString(item.description, file, `rubric[${index}].description`);
    if (typeof item.weight !== "number" || item.weight <= 0) {
      fail(file, `rubric[${index}].weight must be a positive number`);
    }
    return sum + item.weight;
  }, 0);
  if (Math.abs(totalWeight - 1) > 0.001) {
    fail(file, `rubric weights must sum to 1, got ${totalWeight}`);
  }

  // ---- Per-category contract rules ------------------------------------------------
  for (const rule of CATEGORY_RULES) {
    if (task.category === rule.category && rule.promptPattern.test(task.prompt)) {
      const names = requiredToolNames(task);
      if (!rule.mustRequireOneOf.some((tool) => names.has(tool))) {
        fail(file, `${rule.why}`);
      }
    }
  }

  checked += 1;
}

console.log(`Validated ${checked} model bake-off task fixture${checked === 1 ? "" : "s"}.`);
