// Gate scoring: machine-checked, binary, per-run. A run passes only if every
// gate passes. Pure logic — unit tested in gates.test.mjs.
//
// toolContract entries:
//   { name, minCalls?, argChecks?, anyOf? }  or  { oneOfTools: [{ name, minCalls?, argChecks? }, ...] }
//   - minCalls (default 1): at least this many calls to the tool
//   - argChecks: [{ path, exists? | equals? | matches?, flags? }] — each check must
//     be satisfied by AT LEAST ONE call to the tool (different checks may be
//     satisfied by different calls). path "." targets the whole argument object
//     (matched against its JSON); "a.b.0.c" walks into it.
//   - anyOf: [subContract, ...] — passes if ANY branch (same shape, minus name)
//     passes. Lets a fixture express "compared ≥2 routes" as either two calls OR
//     one call with a routes[] array.
//
// outputAssertions: [{ type: includes|notIncludes|matches|notMatches, value, flags? }]
// forbiddenTools: [name, ...]

export function getPath(obj, path) {
  const p = String(path ?? "");
  if (p === "" || p === ".") return obj;
  return p.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function checkArg(args, check) {
  const value = getPath(args, check.path);
  if (check.exists !== undefined) {
    const present = value !== undefined && value !== null && value !== "";
    return present === Boolean(check.exists);
  }
  if (check.equals !== undefined) return value === check.equals;
  if (check.matches !== undefined) {
    const re = new RegExp(check.matches, check.flags ?? "i");
    const target = typeof value === "string" ? value : JSON.stringify(value ?? "");
    return re.test(target);
  }
  return value !== undefined; // bare { path } means "exists"
}

function evaluateContractBranch(branch, matchingCalls) {
  const failures = [];
  const minCalls = Number.isInteger(branch.minCalls) ? branch.minCalls : 1;
  if (matchingCalls.length < minCalls) {
    failures.push(`called ${matchingCalls.length}x, need >=${minCalls}`);
  }
  for (const check of branch.argChecks ?? []) {
    if (!matchingCalls.some((call) => checkArg(call.input ?? {}, check))) {
      failures.push(`no call satisfied argCheck ${JSON.stringify(check)}`);
    }
  }
  return failures;
}

export function evaluateGates(fixture, run) {
  if (run.infraError) {
    return { pass: false, infra: true, failures: [{ gate: "infra", detail: String(run.infraError) }] };
  }

  const failures = [];
  if (run.error) {
    failures.push({ gate: "completion", detail: String(run.error) });
  }
  // Tool-loop cap: the model burned its iteration budget without finishing. At a
  // fixed cap, needing fewer steps is a real model quality — but report it under
  // its own gate so cap-bound tasks are visible as such (vs. wrong answers).
  // An empty reply is a failed turn: the user gets nothing (seen 2026-09-24 when a
  // model emitted tool_calls on a tools:false fixture and ended with no text).
  if (!run.error && !String(run.text ?? "").trim()) {
    failures.push({ gate: "empty", detail: `no user-visible reply (stop=${run.stopReason})` });
  }
  if (run.stopReason === "max_tool_iters") {
    failures.push({ gate: "cap", detail: "hit the tool-iteration cap without a final answer" });
  }

  const calls = run.toolCalls ?? [];
  for (const contract of fixture.toolContract ?? []) {
    // Cross-tool alternative: { oneOfTools: [{ name, minCalls?, argChecks? }, ...] }
    // passes when ANY listed tool contract is satisfied (e.g. today's protein may
    // come from the food diary OR the wellness DB day summary).
    if (Array.isArray(contract.oneOfTools)) {
      const results = contract.oneOfTools.map((alt) =>
        evaluateContractBranch(alt, calls.filter((c) => c.name === alt.name)));
      if (!results.some((f) => f.length === 0)) {
        failures.push({
          gate: `tool:oneOf(${contract.oneOfTools.map((alt) => alt.name).join("|")})`,
          detail: results.map((f, i) => `${contract.oneOfTools[i].name}: ${f.join("; ")}`).join(" | "),
        });
      }
      continue;
    }
    const matching = calls.filter((c) => c.name === contract.name);
    for (const detail of evaluateContractBranch(contract, matching)) {
      failures.push({ gate: `tool:${contract.name}`, detail });
    }
    if (Array.isArray(contract.anyOf) && contract.anyOf.length > 0) {
      const branchResults = contract.anyOf.map((branch) => evaluateContractBranch(branch, matching));
      if (!branchResults.some((f) => f.length === 0)) {
        failures.push({
          gate: `tool:${contract.name}.anyOf`,
          detail: `no branch satisfied: ${branchResults.map((f) => f.join("; ")).join(" | ")}`,
        });
      }
    }
  }

  for (const name of fixture.forbiddenTools ?? []) {
    if (calls.some((c) => c.name === name)) {
      failures.push({ gate: `forbidden:${name}`, detail: "forbidden tool was called" });
    }
  }

  // forbiddenCalls: arg-level negatives — a tool that is allowed in general but
  // must not be called with specific arguments (e.g. expense_reimbursement with
  // action=submit_reviewed*, walmart with action=queue_add on an advise-only task).
  for (const forbidden of fixture.forbiddenCalls ?? []) {
    const hit = calls.find(
      (c) => c.name === forbidden.name && (forbidden.argChecks ?? []).every((check) => checkArg(c.input ?? {}, check)),
    );
    if (hit) {
      failures.push({
        gate: `forbiddenCall:${forbidden.name}`,
        detail: `forbidden call matched ${JSON.stringify(forbidden.argChecks ?? [])}`,
      });
    }
  }

  const text = run.text ?? "";
  for (const assertion of fixture.outputAssertions ?? []) {
    const { type, value, flags } = assertion;
    let ok = true;
    if (type === "includes") ok = text.toLowerCase().includes(String(value).toLowerCase());
    else if (type === "notIncludes") ok = !text.toLowerCase().includes(String(value).toLowerCase());
    else if (type === "matches") ok = new RegExp(value, flags ?? "i").test(text);
    else if (type === "notMatches") ok = !new RegExp(value, flags ?? "i").test(text);
    else {
      failures.push({ gate: "outputAssertion", detail: `unknown assertion type ${type}` });
      continue;
    }
    if (!ok) failures.push({ gate: `output:${type}`, detail: String(value) });
  }

  return { pass: failures.length === 0, infra: false, failures };
}
